/**
 * Pi-native wire format for the auth-gateway.
 *
 * Where the OpenAI / Anthropic / Responses route modules translate foreign
 * wire shapes through pi-ai's canonical {@link Context}, this module accepts
 * the canonical shape *directly* — for clients that already speak pi-ai
 * (containerized GJC deployments and sidecar auth gateways).
 * Skipping the wire-format → Context → wire-format round-trip cuts
 * per-request CPU but, more importantly, avoids the quantization that those
 * translations impose on first-class pi-ai fields (service tier, cache
 * markers, thinking budgets, tool-choice variants, …).
 *
 * The streaming wire is {@link AssistantMessageEvent} serialized as SSE. Public
 * projections omit private raw reasoning and serialized Responses reasoning
 * signatures while preserving provider-displayable summaries and genuine opaque
 * signatures. Including `partial: AssistantMessage` on every delta is O(N²) in
 * turn length on the wire — acceptable for the loopback / sidecar topology this
 * transport is designed for; provider latency dominates the actual cost.
 *
 * Endpoint contract:
 *   POST /v1/pi/stream
 *   body:    { modelId, context, options?, stream? }   // `stream` defaults to true
 *   200 SSE: stream of `AssistantMessageEvent` (terminated by `data: [DONE]`)
 *   200 JSON (stream=false): { message: AssistantMessage }
 *   4xx/5xx: { error: { type, message } }
 */
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	SimpleStreamOptions,
	ThinkingContent,
} from "../types";

export interface PiNativeParsedRequest {
	modelId: string;
	context: Context;
	options: SimpleStreamOptions;
	stream: boolean;
}
/**
 * Subset of {@link SimpleStreamOptions} accepted from the wire. Function-valued
 * fields (`fetch`, `onPayload`, `onResponse`, `onSseEvent`, exec handlers, the
 * provider-session map) and gateway-owned controls (`apiKey`, `signal`) are
 * intentionally absent — those are server-side concerns. Anything outside this
 * allow-list is dropped silently rather than 400ing, so clients can forward
 * `SimpleStreamOptions` from older / newer gjc builds without per-version
 * conditionals.
 */
const ALLOWED_OPTION_KEYS: ReadonlySet<keyof SimpleStreamOptions> = new Set([
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"frequencyPenalty",
	"repetitionPenalty",
	"stopSequences",
	"maxTokens",
	"cacheRetention",
	"headers",
	"initiatorOverride",
	"maxRetryDelayMs",
	"fallbackManaged",
	"metadata",
	"sessionId",
	"streamFirstEventTimeoutMs",
	"streamIdleTimeoutMs",
	"reasoning",
	"disableReasoning",
	"hideThinkingSummary",
	"thinkingBudgets",
	"toolChoice",
	"serviceTier",
	"kimiApiFormat",
	"syntheticApiFormat",
	"preferWebsockets",
] as const satisfies readonly (keyof SimpleStreamOptions)[]);

// ---------------------------------------------------------------------------
// parseRequest
// ---------------------------------------------------------------------------

/**
 * Parse a pi-native request body. Validation is intentionally minimal — only
 * the shape the gateway itself reads is checked (`modelId`, `context.messages`
 * array, options is an object). Everything downstream is the canonical pi-ai
 * type surface; mis-shaped values surface as a `502 upstream_error` from
 * `streamSimple` rather than being re-validated here.
 *
 * Accepts both `{ modelId: string }` and `{ model: { id: string } }` so the
 * existing `streamProxy` client (which sends the full Model object) can target
 * the gateway with only a URL swap.
 */
export function parseRequest(body: unknown, _headers?: Headers): PiNativeParsedRequest {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Error("Request body must be a JSON object");
	}
	const obj = body as Record<string, unknown>;

	let modelId: string | undefined;
	if (typeof obj.modelId === "string" && obj.modelId.length > 0) {
		modelId = obj.modelId;
	} else if (typeof obj.model === "string" && obj.model.length > 0) {
		modelId = obj.model;
	} else if (typeof obj.model === "object" && obj.model !== null) {
		const m = obj.model as Record<string, unknown>;
		if (typeof m.id === "string" && m.id.length > 0) modelId = m.id;
	}
	if (!modelId) throw new Error("Missing `modelId` (or `model.id`) field");

	const context = obj.context;
	if (typeof context !== "object" || context === null || Array.isArray(context)) {
		throw new Error("Missing `context` object");
	}
	const ctxObj = context as Record<string, unknown>;
	if (!Array.isArray(ctxObj.messages)) {
		throw new Error("`context.messages` must be an array");
	}
	if (ctxObj.systemPrompt !== undefined && !Array.isArray(ctxObj.systemPrompt)) {
		throw new Error("`context.systemPrompt` must be an array of strings when present");
	}
	if (ctxObj.tools !== undefined && !Array.isArray(ctxObj.tools)) {
		throw new Error("`context.tools` must be an array when present");
	}

	const options: SimpleStreamOptions = {};
	const rawOpts = obj.options;
	if (typeof rawOpts === "object" && rawOpts !== null && !Array.isArray(rawOpts)) {
		const optsBag = options as Record<string, unknown>;
		for (const [k, v] of Object.entries(rawOpts)) {
			if (v === undefined || v === null) continue;
			if (!ALLOWED_OPTION_KEYS.has(k as keyof SimpleStreamOptions)) continue;
			optsBag[k] = v;
		}
	}

	// `stream` defaults to true — pi-native clients overwhelmingly stream, and
	// matching `streamProxy`'s implicit-stream behavior avoids a one-flag papercut.
	const stream = typeof obj.stream === "boolean" ? obj.stream : true;

	return {
		modelId,
		context: context as Context,
		options,
		stream,
	};
}
// ---------------------------------------------------------------------------
// encodeStream (SSE)
// ---------------------------------------------------------------------------

const SSE_ENCODER = new TextEncoder();
const SSE_DONE = SSE_ENCODER.encode("data: [DONE]\n\n");

function isSerializedResponsesReasoningItem(signature: string): boolean {
	try {
		const parsed: unknown = JSON.parse(signature);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			(parsed as { type?: unknown }).type === "reasoning"
		);
	} catch {
		return false;
	}
}

/**
 * Clone a thinking block for public transport. Raw reasoning is private: omit
 * raw-only blocks, retain only the displayable summary for mixed blocks, and
 * never forward a serialized Responses reasoning item as a signature.
 */
function isResponsesFamilyApi(api: AssistantMessage["api"]): boolean {
	return api === "openai-responses" || api === "openai-codex-responses";
}

function sanitizeThinking(content: ThinkingContent, api: AssistantMessage["api"]): ThinkingContent | undefined {
	if (isResponsesFamilyApi(api) && content.provenance === undefined) return undefined;
	if (content.provenance === "raw") return undefined;

	let thinking: string;
	if (content.provenance === "mixed") {
		if (content.summaryText === undefined) return undefined;
		thinking = content.summaryText;
	} else {
		thinking = content.provenance === "summary" ? (content.summaryText ?? content.thinking) : content.thinking;
	}
	const signature =
		content.thinkingSignature && isSerializedResponsesReasoningItem(content.thinkingSignature)
			? undefined
			: content.thinkingSignature;
	const { rawText: _rawText, thinkingSignature: _thinkingSignature, ...rest } = content;
	return signature === undefined ? { ...rest, thinking } : { ...rest, thinking, thinkingSignature: signature };
}

function sanitizeMessage(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content: AssistantMessage["content"] = [];
	for (const part of message.content) {
		if (part.type !== "thinking") {
			content.push(part);
			continue;
		}
		const needsSanitizing =
			(isResponsesFamilyApi(message.api) && part.provenance === undefined) ||
			part.provenance !== undefined ||
			part.rawText !== undefined ||
			(part.thinkingSignature !== undefined && isSerializedResponsesReasoningItem(part.thinkingSignature));
		if (!needsSanitizing) {
			content.push(part);
			continue;
		}
		const sanitized = sanitizeThinking(part, message.api);
		changed = true;
		if (sanitized !== undefined) content.push(sanitized);
	}
	return changed ? { ...message, content } : message;
}

function hasRawOrMixedThinking(partial: AssistantMessage, contentIndex: number): boolean {
	const content = partial.content[contentIndex];
	return content?.type === "thinking" && (content.provenance === "raw" || content.provenance === "mixed");
}

type ThinkingEvent = Extract<AssistantMessageEvent, { type: "thinking_start" | "thinking_delta" | "thinking_end" }>;

interface BufferedThinkingEvent {
	event: ThinkingEvent;
	sequence: number;
}

function isFinalSafeThinking(partial: AssistantMessage, contentIndex: number): boolean {
	const content = partial.content[contentIndex];
	return (
		content?.type === "thinking" &&
		(!isResponsesFamilyApi(partial.api) || content.provenance !== undefined) &&
		!hasRawOrMixedThinking(partial, contentIndex)
	);
}

function maskBufferedThinking(message: AssistantMessage, contentIndexes: ReadonlySet<number>): AssistantMessage {
	let changed = false;
	const content = message.content.map((part, contentIndex) => {
		if (!contentIndexes.has(contentIndex) || part.type !== "thinking") return part;
		changed = true;
		return { type: "thinking" as const, thinking: "", ...(part.itemId ? { itemId: part.itemId } : {}) };
	});
	return changed ? { ...message, content } : message;
}

function maskBufferedThinkingInEvent(
	event: AssistantMessageEvent,
	contentIndexes: ReadonlySet<number>,
): AssistantMessageEvent {
	if (contentIndexes.size === 0) return event;
	switch (event.type) {
		case "done":
		case "error":
		case "toolChoiceIncapability":
			return event;
		case "start":
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "reasoning_summary_start":
		case "reasoning_summary_delta":
		case "reasoning_summary_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return { ...event, partial: maskBufferedThinking(event.partial, contentIndexes) };
	}
}

function withSummaryPartial<
	T extends Extract<
		AssistantMessageEvent,
		{ type: "reasoning_summary_start" | "reasoning_summary_delta" | "reasoning_summary_end" }
	>,
>(event: T, contentIndexes: ReadonlySet<number>, summaryText: string): T {
	const partial = maskBufferedThinking(event.partial, contentIndexes);
	const content = [...partial.content];
	const original = event.partial.content[event.contentIndex];
	content[event.contentIndex] = {
		type: "thinking",
		thinking: summaryText,
		provenance: "summary",
		summaryText,
		...(original?.type === "thinking" && original.itemId ? { itemId: original.itemId } : {}),
	};
	return { ...event, partial: { ...partial, content } };
}

function sanitizeEvent(event: AssistantMessageEvent): AssistantMessageEvent | undefined {
	switch (event.type) {
		case "done":
			return { ...event, message: sanitizeMessage(event.message) };
		case "error":
			return { ...event, error: sanitizeMessage(event.error) };
		case "toolChoiceIncapability":
			return event;
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
			return hasRawOrMixedThinking(event.partial, event.contentIndex)
				? undefined
				: { ...event, partial: sanitizeMessage(event.partial) };
		case "start":
		case "text_start":
		case "text_delta":
		case "text_end":
		case "reasoning_summary_start":
		case "reasoning_summary_delta":
		case "reasoning_summary_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return { ...event, partial: sanitizeMessage(event.partial) };
	}
}

/**
 * Ship only public-safe {@link AssistantMessageEvent} projections. Unknown
 * thinking blocks remain buffered until their terminal partial establishes that
 * the provider-native block is safe; raw and mixed blocks never reach SSE.
 */
export function encodeStream(events: AssistantMessageEventStream): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const bufferedThinking = new Map<number, BufferedThinkingEvent[]>();
			const summaryTextByIndex = new Map<number, string>();
			let sequence = 0;
			const write = (event: AssistantMessageEvent): void => {
				const sanitized = sanitizeEvent(event);
				if (sanitized !== undefined) {
					controller.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(sanitized)}\n\n`));
				}
			};
			const emit = (event: AssistantMessageEvent): void => {
				write(maskBufferedThinkingInEvent(event, new Set(bufferedThinking.keys())));
			};
			const flush = (buffered: BufferedThinkingEvent[]): void => {
				for (const { event } of buffered.sort((a, b) => a.sequence - b.sequence)) emit(event);
			};
			const resolveBufferedThinking = (final: AssistantMessage): void => {
				const ready: BufferedThinkingEvent[] = [];
				for (const [contentIndex, buffered] of bufferedThinking) {
					if (isFinalSafeThinking(final, contentIndex)) ready.push(...buffered);
				}
				bufferedThinking.clear();
				flush(ready);
			};
			try {
				for await (const event of events) {
					switch (event.type) {
						case "thinking_start":
						case "thinking_delta": {
							if (hasRawOrMixedThinking(event.partial, event.contentIndex)) {
								bufferedThinking.delete(event.contentIndex);
								break;
							}
							const buffered = bufferedThinking.get(event.contentIndex) ?? [];
							buffered.push({ event, sequence: sequence++ });
							bufferedThinking.set(event.contentIndex, buffered);
							break;
						}
						case "thinking_end": {
							const buffered = bufferedThinking.get(event.contentIndex) ?? [];
							bufferedThinking.delete(event.contentIndex);
							if (!isFinalSafeThinking(event.partial, event.contentIndex)) break;
							buffered.push({ event, sequence: sequence++ });
							flush(buffered);
							break;
						}
						case "done":
							resolveBufferedThinking(event.message);
							summaryTextByIndex.clear();
							emit(event);
							controller.enqueue(SSE_DONE);
							controller.close();
							return;
						case "error":
							resolveBufferedThinking(event.error);
							summaryTextByIndex.clear();
							emit(event);
							controller.enqueue(SSE_DONE);
							controller.close();
							return;
						case "reasoning_summary_start": {
							summaryTextByIndex.set(event.contentIndex, "");
							write(withSummaryPartial(event, new Set(bufferedThinking.keys()), ""));
							break;
						}
						case "reasoning_summary_delta": {
							const summaryText = `${summaryTextByIndex.get(event.contentIndex) ?? ""}${event.delta}`;
							summaryTextByIndex.set(event.contentIndex, summaryText);
							write(withSummaryPartial(event, new Set(bufferedThinking.keys()), summaryText));
							break;
						}
						case "reasoning_summary_end": {
							const summaryText = event.content || summaryTextByIndex.get(event.contentIndex) || "";
							summaryTextByIndex.delete(event.contentIndex);
							write(withSummaryPartial(event, new Set(bufferedThinking.keys()), summaryText));
							break;
						}
						case "start":
						case "text_start":
						case "text_delta":
						case "text_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
						case "toolChoiceIncapability":
							emit(event);
							break;
					}
				}
				controller.enqueue(SSE_DONE);
				controller.close();
			} catch (err) {
				// Best-effort error envelope so the client iterator resolves
				// instead of hanging on the dropped connection. Shape matches the
				// canonical `error` event minus the unrecoverable `error:
				// AssistantMessage` payload (we don't have a usable one here).
				const message = err instanceof Error ? err.message : String(err);
				controller.enqueue(
					SSE_ENCODER.encode(
						`data: ${JSON.stringify({ type: "error", reason: "error", errorMessage: message })}\n\n`,
					),
				);
				controller.enqueue(SSE_DONE);
				controller.close();
			}
		},
	});
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

/**
 * Pi-native error envelope:
 *   `{ error: { type, message } }`
 *
 * Mirrors OpenAI's outer shape (which clients/SDKs already parse) without the
 * provider-specific status taxonomy — pi-native callers consume `type`
 * directly.
 */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
