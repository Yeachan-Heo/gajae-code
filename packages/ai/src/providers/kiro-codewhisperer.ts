/**
 * Kiro / Amazon Q Developer / CodeWhisperer streaming transport.
 *
 * Talks directly to the CodeWhisperer streaming service over HTTPS using
 * a bearer token from AWS SSO OIDC. The response is an
 * `application/vnd.amazon.eventstream`, decoded by the shared
 * `decodeEventStream` primitive from `aws-eventstream.ts`.
 *
 * Clean-room: derived from published Amazon service model shapes
 * (aws-toolkit-vscode CodeWhisperer streaming + codewhispererruntime-2022-11-11),
 * not from any AGPL reference implementation.
 */
import { $credentialEnv, $env, extractHttpStatusFromError } from "@gajae-code/utils";
import { assertAwsRegionLabel } from "../adapter-internals/aws-region";
import {
	isProviderSafetyStopAdapterInvocation,
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
} from "../adapter-internals/provider-safety-stop";
import type { Effort } from "../model-thinking";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { PROVIDER_PROTOCOL_MISMATCH_ERROR_CODE, transportFailureFacts } from "../utils/fallback-transport";
import { withHttpStatus } from "../utils/http-inspector";
import { captureUnicodeEscapeEvidence } from "../utils/json-parse";
import { decodeEventStream } from "./aws-eventstream";
import { isKiroApiKey, sanitizeKiroError, streamKiroApiKey, toKiroModelId } from "./kiro-api-key";

/**
 * Trust assumption: globalThis.fetch is treated as a trusted source for authenticated
 * provider safety stops. The Kiro streaming transport does not support caller-provided
 * fetch overrides (test injection via options.fetch is not supported). Tests that need
 * to mock Kiro responses should use the provider test harness or mock at a higher level.
 *
 * This trust assumption is safe in runtime contexts where globalThis.fetch is the
 * system-provided implementation and cannot be replaced after module load.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Provider options
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroCodeWhispererOptions extends StreamOptions {
	/** Effort level for Kiro API-key reasoning. */
	reasoning?: Effort | boolean;
	/** AWS region for the CodeWhisperer streaming endpoint. */
	region?: string;
	/** Profile ARN for enterprise IAM Identity Center accounts. */
	profileArn?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeWhisperer streaming wire types
// ─────────────────────────────────────────────────────────────────────────────

interface WireToolSpec {
	toolSpecification: {
		name: string;
		description?: string;
		inputSchema: { json: unknown };
	};
}

interface WireToolResult {
	toolUseId: string;
	status: "success" | "error";
	content: Array<{ text: string }>;
}

interface WireToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
}

interface WireUserMessage {
	userInputMessage: {
		content: string;
		modelId?: string;
		userInputMessageContext?: {
			tools?: WireToolSpec[];
			toolResults?: WireToolResult[];
			editorStateContext?: Record<string, unknown>;
		};
		origin: typeof KIRO_ORIGIN;
	};
}

interface WireAssistantMessage {
	assistantResponseMessage: {
		content: string;
		toolUses?: WireToolUse[];
	};
}

type WireHistoryMessage = WireUserMessage | WireAssistantMessage;

interface ConversationState {
	chatTriggerType: "MANUAL";
	currentMessage: WireUserMessage;
	history?: WireHistoryMessage[];
	profileArn?: string;
	customizationArn?: string;
}

interface GenerateAssistantResponseRequest {
	conversationState: ConversationState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response eventstream types (ChatResponseStream union members)
// ─────────────────────────────────────────────────────────────────────────────

interface AssistantResponseEvent {
	content?: string;
}

interface ToolUseEventPayload {
	toolUseId?: string;
	name?: string;
	input?: string;
	stop?: boolean;
}

interface MetadataEvent {
	stopReason?: string;
	stopDetails?: {
		refusal?: {
			category?: string;
			explanation?: string;
		};
	};
}

interface MessageMetadataEvent {
	conversationId?: string;
	utteranceId?: string;
	stopReason?: string;
	stopDetails?: {
		refusal?: {
			category?: string;
			explanation?: string;
		};
	};
}

interface ErrorPayload {
	error?: {
		message?: string;
		code?: string;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_REGION = "us-east-1";

/**
 * Without `origin` the service ignores `modelId` and routes every request to
 * `auto`; with it, response frames report the requested model.
 */
const KIRO_ORIGIN = "AI_EDITOR";

type Block = (TextContent | ToolCall) & { index?: number; partialJson?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Refusal handling (shared between bearer token and API-key paths)
// ─────────────────────────────────────────────────────────────────────────────

/** Immutable snapshot of model identity fields to prevent TOCTOU vulnerabilities. */
type ModelIdentitySnapshot = Readonly<{
	provider: string;
	id: string;
	api: Api;
	baseUrl: string | undefined;
}>;

function handleKiroRefusal(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	_modelSnapshot: ModelIdentitySnapshot,
	refusal: { category?: string; explanation?: string } | undefined,
	options?: KiroCodeWhispererOptions,
): boolean {
	const category = refusal?.category;
	const explanation = refusal?.explanation?.trim();
	const label = category ? `Kiro refused the request (${category})` : "Kiro refused the request";

	output.stopReason = "error";
	output.errorMessage = explanation ? `${label}: ${explanation}` : label;
	output.content = [];

	// Attempt to mint provider safety stop for structured refusal
	// Do not pass options.fetch as callerTransport: the refusal came from the
	// provider's response, not from a caller-controlled fabrication.
	const adapterInvocation = isProviderSafetyStopAdapterInvocation(options);
	// Always use the generic 'refusal' signal for authentication, not the raw category
	// (which may not be in the STRUCTURED_REFUSAL_SIGNALS allowlist). The category
	// information is preserved in the errorMessage as diagnostic context.
	const authenticated = mintProviderSafetyStop(
		output,
		"refusal",
		PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
		undefined,
		adapterInvocation,
	);

	if (!authenticated) {
		// If the refusal signal is not recognized, fall back to error transport failure
		output.transportFailure = {
			kind: "transport",
			status: 500,
			providerCode: "untrusted_safety_stop",
		};
	}

	stream.push({ type: "error", reason: "error", error: output });
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream function
// ─────────────────────────────────────────────────────────────────────────────

export const streamKiroCodeWhisperer: StreamFunction<"kiro-codewhisperer-stream"> = (
	model: Model<"kiro-codewhisperer-stream">,
	context: Context,
	options: KiroCodeWhispererOptions,
): AssistantMessageEventStream => {
	const token = resolveBearerToken(options.apiKey);
	if (isKiroApiKey(token)) {
		return streamKiroApiKey(model, context, { ...options, apiKey: token });
	}

	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		// Accumulator for streaming tool input fragments, keyed by toolUseId
		const toolInputAccumulator = new Map<string, { name: string; input: string }>();
		// Pending tool calls to be emitted at stream end (after refusal is ruled out)
		const pendingToolCalls: Array<{ id: string; toolCall: ToolCall; index: number }> = [];

		const region = options.region ?? $env.KIRO_REGION ?? $env.AWS_REGION ?? $env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
		let started = false; // Track whether start event has been emitted

		// Initialize output with default values; will be updated inside try block with snapshotted model identity
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "kiro-codewhisperer-stream" as Api,
			provider: "",
			model: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const blocks = output.content as Block[];

		try {
			// Snapshot model identity fields at stream start to prevent TOCTOU attacks where
			// a Proxy/getter model could return different values on successive reads.
			const modelSnapshot: ModelIdentitySnapshot = Object.freeze({
				provider: model.provider,
				id: model.id,
				api: "kiro-codewhisperer-stream" as Api,
				baseUrl: model.baseUrl,
			});

			// Update output with snapshotted model identity
			output.api = modelSnapshot.api;
			output.provider = modelSnapshot.provider;
			output.model = modelSnapshot.id;
			assertAwsRegionLabel(region);
			// Resolve bearer token
			const bearerToken = resolveBearerToken(options.apiKey);
			if (!bearerToken) {
				throw new Error(
					"No Kiro credentials found. Set KIRO_API_KEY (ksk_ from https://app.kiro.dev/settings/api-keys) or run 'gjc auth-broker login kiro'.",
				);
			}

			// Build request
			const conversationState = buildConversationState(context, model, options);
			let requestBody: GenerateAssistantResponseRequest = {
				conversationState,
			};

			const replacementPayload = await options?.onPayload?.(
				requestBody,
				model,
				options?.attemptScope,
				options?.signal,
			);
			if (replacementPayload !== undefined) {
				requestBody = replacementPayload as typeof requestBody;
			}

			const url = `https://codewhisperer.${region}.amazonaws.com/`;

			const bodyText = JSON.stringify(requestBody);
			const body = new TextEncoder().encode(bodyText);
			const requestHeaders: Record<string, string> = {
				"Content-Type": "application/x-amz-json-1.0",
				Accept: "application/vnd.amazon.eventstream",
				Authorization: `Bearer ${bearerToken}`,
				"X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
			};

			// Merge user-provided headers (case-insensitively)
			const headersList = new Headers(requestHeaders);
			if (options.headers) {
				const userHeaders = new Headers(options.headers);
				userHeaders.forEach((value, key) => {
					headersList.set(key, value);
				});
			}

			const response = await (options.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				headers: headersList,
				body,
				redirect: "error",
				signal: options.signal,
			});

			if (!response.ok) {
				const errBody = await readBodyPrefix(response);
				throw withHttpStatus(
					new Error(sanitizeKiroError(`Kiro CodeWhisperer HTTP ${response.status}: ${errBody}`, bearerToken)),
					response.status,
				);
			}

			// Verify content-type is eventstream; if not, read and report the actual error
			const contentType = response.headers.get("content-type") ?? "";
			const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
			if (!response.body || mediaType !== "application/vnd.amazon.eventstream") {
				const errBody = await readBodyPrefix(response);
				// Deliberately no HTTP status metadata and no "HTTP <code>" wording: a 2xx
				// protocol mismatch is deterministic, and a status would materialize
				// transport-failure facts that session fallback retries.
				// Sanitize each untrusted part on its own so the fixed prefix does not eat
				// into the body's 1000-character diagnostic budget.
				const safeContentType = contentType ? sanitizeKiroError(contentType, bearerToken) : "";
				const safeBody = errBody ? sanitizeKiroError(errBody, bearerToken) : "";
				throw new KiroNonEventStreamError(
					`Kiro CodeWhisperer returned a non-eventstream ${response.status} response (${safeContentType}): ${safeBody}`,
				);
			}

			// Text and tool events stream as frames arrive. A refusal arrives as a
			// terminal metadata frame after reasoning-only frames (#6150), so reasoning
			// is never surfaced as the answer and nothing is buffered.
			for await (const message of decodeEventStream(response.body)) {
				if (options.signal?.aborted) break;

				const messageType = message.headers[":message-type"];
				const eventType = message.headers[":event-type"];

				if (messageType === "exception") {
					const exceptionType = message.headers[":exception-type"] || "Exception";
					const payload = safeParsePayload(message.payload) as { message?: string } | undefined;
					const errorMessage = payload?.message || new TextDecoder().decode(message.payload);
					const status = exceptionType === "ValidationException" ? 400 : 0;
					const err = new Error(`${exceptionType}: ${errorMessage}`);
					throw status ? withHttpStatus(err, status) : err;
				}

				if (messageType === "error") {
					const code = message.headers[":error-code"] || "UnknownError";
					const errorMessage = message.headers[":error-message"] || new TextDecoder().decode(message.payload);
					throw new Error(`${code}: ${errorMessage}`);
				}

				if (messageType !== "event") continue;

				const payload = safeParsePayload(message.payload);
				if (!payload) continue;

				// Check for refusal in metadata events
				if (eventType === "metadataEvent") {
					const ev = payload as MetadataEvent;
					if (ev.stopDetails?.refusal) {
						output.duration = Date.now() - startTime;
						if (firstTokenTime) output.ttft = firstTokenTime - startTime;
						// Clear pending tool calls without emitting events (on refusal, drop any pending tool)
						pendingToolCalls.length = 0;
						handleKiroRefusal(output, stream, modelSnapshot, ev.stopDetails.refusal, options);
						stream.end();
						return;
					}
				}
				if (eventType === "messageMetadataEvent") {
					const ev = payload as MessageMetadataEvent;
					if (ev.stopDetails?.refusal) {
						output.duration = Date.now() - startTime;
						if (firstTokenTime) output.ttft = firstTokenTime - startTime;
						// Clear pending tool calls without emitting events (on refusal, drop any pending tool)
						pendingToolCalls.length = 0;
						handleKiroRefusal(output, stream, modelSnapshot, ev.stopDetails.refusal, options);
						stream.end();
						return;
					}
				}

				// Process content events as they arrive
				switch (eventType) {
					case "assistantResponseEvent": {
						const ev = payload as AssistantResponseEvent;
						const content = ev.content;
						if (content) {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (!started) {
								stream.push({ type: "start", partial: output });
								started = true;
							}
							handleTextDelta(content, blocks, output, stream);
						}
						break;
					}
					case "toolUseEvent": {
						const ev = payload as ToolUseEventPayload;
						if (!firstTokenTime) firstTokenTime = Date.now();
						if (!started) {
							stream.push({ type: "start", partial: output });
							started = true;
						}
						handleToolUseEvent(ev, blocks, output, stream, toolInputAccumulator, pendingToolCalls);
						// Clear accumulator for completed tool
						if (ev.stop) {
							toolInputAccumulator.delete(ev.toolUseId ?? "");
						}
						break;
					}
					case "messageMetadataEvent": {
						const ev = payload as MessageMetadataEvent;
						if (ev.conversationId) {
							output.responseId = ev.conversationId;
						}
						break;
					}
					case "metadataEvent":
						// Already handled above for refusals; skip
						break;
					case "codeReferenceEvent":
					case "supplementaryWebLinksEvent":
					case "followupPromptEvent":
					case "dryRunSucceedEvent":
					case "citationEvent":
					case "intentsEvent":
					case "interactionComponentsEvent":
					case "invalidStateEvent":
						// Known but unhandled events — ignore gracefully
						break;
				}

				const errorPayload = payload as ErrorPayload;
				if (errorPayload.error?.message) {
					throw new Error(`Kiro CodeWhisperer stream error: ${errorPayload.error.message}`);
				}
			}

			if (options.signal?.aborted) throw new Error("Request was aborted");

			// Reject EOF while tool input is still being accumulated
			if (toolInputAccumulator.size > 0) {
				const unfinishedIds = Array.from(toolInputAccumulator.keys()).join(", ");
				throw new Error(`Kiro CodeWhisperer stream ended with incomplete tool calls: ${unfinishedIds}`);
			}

			// Emit all pending tool call events (safe since no refusal occurred)
			for (const { toolCall, index } of pendingToolCalls) {
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
			}
			pendingToolCalls.length = 0;

			// Finalize blocks
			for (const block of blocks) {
				delete block.index;
				delete block.partialJson;
			}

			// Determine stop reason
			const hasToolCall = blocks.some(b => b.type === "toolCall");
			output.stopReason = hasToolCall ? "toolUse" : "stop";

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				delete (block as Block).partialJson;
			}
			// On ordinary errors, emit pending tool call events before the error terminal
			// This preserves content consistency: completed tools should emit their events
			for (const { toolCall, index } of pendingToolCalls) {
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
			}
			pendingToolCalls.length = 0;

			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			// The non-eventstream diagnostic embeds untrusted body text; never parse a status out of it.
			output.errorStatus = error instanceof KiroNonEventStreamError ? undefined : extractHttpStatusFromError(error);
			output.transportFailure = transportFailureFacts(error);
			if (error instanceof KiroNonEventStreamError) output.errorCode = PROVIDER_PROTOCOL_MISMATCH_ERROR_CODE;
			const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
			output.errorMessage = baseMessage;
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

// ─────────────────────────────────────────────────────────────────────────────
// Request building
// ─────────────────────────────────────────────────────────────────────────────

function buildConversationState(
	context: Context,
	model: Model<"kiro-codewhisperer-stream">,
	options: KiroCodeWhispererOptions,
): ConversationState {
	const messages = context.messages;
	if (messages.length === 0) {
		throw new Error("Kiro CodeWhisperer requires at least one message");
	}

	// Normalize the local dashed selector/wire id (e.g. "claude-haiku-4-5") to
	// the canonical dotted upstream Kiro model id (e.g. "claude-haiku-4.5"),
	// matching the sibling ksk_ API-key transport (kiro-api-key.ts) so both
	// auth methods send the same wire form for the same catalog entry.
	const modelId = toKiroModelId(model.wireModelId || model.id);

	// Build history from all messages except the last
	const history: WireHistoryMessage[] = [];
	const systemPrompt = context.systemPrompt?.join("\n") ?? "";

	// Parallel tool calls end the conversation with several consecutive toolResult
	// messages. They all answer the last assistant turn, so they must travel
	// together in currentMessage; leaving the earlier ones as a separate history
	// entry is rejected upstream with TOOL_USE_RESULT_MISMATCH.
	let currentStart = messages.length - 1;
	while (
		currentStart > 0 &&
		messages[currentStart].role === "toolResult" &&
		messages[currentStart - 1].role === "toolResult"
	) {
		currentStart--;
	}

	for (let i = 0; i < currentStart; i++) {
		const msg = messages[i];
		const previous = history[history.length - 1];
		// Parallel tool calls produce consecutive toolResult messages; they answer one
		// assistant turn, so their results share a single user entry.
		if (
			msg.role === "toolResult" &&
			messages[i - 1]?.role === "toolResult" &&
			previous &&
			"userInputMessage" in previous
		) {
			previous.userInputMessage.userInputMessageContext ??= {};
			const context = previous.userInputMessage.userInputMessageContext;
			context.toolResults ??= [];
			context.toolResults.push(convertToolResult(msg as ToolResultMessage));
			continue;
		}
		history.push(convertToWireMessage(msg, modelId, i === 0 ? systemPrompt : undefined));
	}

	// Convert the last message as currentMessage, carrying every trailing parallel result.
	const lastMsg = messages[messages.length - 1];
	const currentMessage = convertToWireUserMessage(lastMsg, modelId, systemPrompt);
	if (currentStart < messages.length - 1) {
		currentMessage.userInputMessage.userInputMessageContext = {
			toolResults: messages.slice(currentStart).map(msg => convertToolResult(msg as ToolResultMessage)),
		};
	}

	// Add tools to the current message context
	if (context.tools && context.tools.length > 0) {
		if (!currentMessage.userInputMessage.userInputMessageContext) {
			currentMessage.userInputMessage.userInputMessageContext = {};
		}
		currentMessage.userInputMessage.userInputMessageContext.tools = convertTools(context.tools);
	}

	return {
		chatTriggerType: "MANUAL",
		currentMessage,
		history: history.length > 0 ? history : undefined,
		profileArn: options.profileArn,
	};
}

function convertToWireMessage(
	msg: Context["messages"][number],
	modelId: string,
	systemPrompt?: string,
): WireHistoryMessage {
	if (msg.role === "user") {
		return convertToWireUserMessage(msg, modelId, systemPrompt);
	}
	if (msg.role === "toolResult") {
		return convertToWireUserMessage(msg, modelId, systemPrompt);
	}
	// assistant → assistant response; tool calls stay structured so later tool
	// results can reference the toolUseId they answer.
	const textParts: string[] = [];
	const toolUses: WireToolUse[] = [];
	for (const block of msg.content) {
		if (typeof block === "string") {
			textParts.push(block);
		} else if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "toolCall") {
			toolUses.push({
				toolUseId: block.id,
				name: block.name,
				input: (block.arguments ?? {}) as Record<string, unknown>,
			});
		}
	}
	return {
		assistantResponseMessage: {
			content: textParts.join("\n"),
			...(toolUses.length > 0 ? { toolUses } : {}),
		},
	};
}

function convertToWireUserMessage(
	msg: Context["messages"][number],
	modelId: string,
	systemPrompt?: string,
): WireUserMessage {
	// A tool result travels in userInputMessageContext.toolResults; repeating it as
	// message text would show the model each result twice.
	let content = msg.role === "toolResult" ? "Tool results provided." : extractTextContent(msg);
	if (systemPrompt) {
		content = `${systemPrompt}\n\n${content}`;
	}

	const userMsg: WireUserMessage = {
		userInputMessage: {
			content,
			modelId,
			origin: KIRO_ORIGIN,
		},
	};

	if (msg.role === "toolResult") {
		userMsg.userInputMessage.userInputMessageContext = {
			toolResults: [convertToolResult(msg as ToolResultMessage)],
		};
	}

	return userMsg;
}

/** One CodeWhisperer tool result per tool call, keyed by the toolUseId it answers. */
function convertToolResult(msg: ToolResultMessage): WireToolResult {
	const text = (msg.content ?? [])
		.map(block => (block.type === "text" ? block.text : block.type === "image" ? "[image omitted]" : ""))
		.filter(part => part.length > 0)
		.join("\n");
	return {
		toolUseId: msg.toolCallId,
		status: msg.isError ? "error" : "success",
		content: [{ text }],
	};
}

function extractTextContent(msg: Context["messages"][number]): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.map(block => {
				if (typeof block === "string") return block;
				if (block.type === "text") return block.text;
				if (block.type === "image") return ""; // Images not supported in text field
				return "";
			})
			.join("");
	}
	return "";
}

function convertTools(tools: Tool[]): WireToolSpec[] {
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: {
				json: tool.parameters ?? {},
			},
		},
	}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handling
// ─────────────────────────────────────────────────────────────────────────────

function handleTextDelta(
	delta: string,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	// Find or create the last text block
	let lastBlock = blocks[blocks.length - 1];
	if (lastBlock?.type !== "text") {
		const newBlock: Block = { type: "text", text: "", index: blocks.length };
		blocks.push(newBlock);
		lastBlock = newBlock;
		stream.push({ type: "text_start", contentIndex: newBlock.index!, partial: output });
	}
	lastBlock.text += delta;
	stream.push({ type: "text_delta", contentIndex: lastBlock.index!, delta, partial: output });
}

function handleToolUseEvent(
	ev: ToolUseEventPayload,
	blocks: Block[],
	_output: AssistantMessage,
	_stream: AssistantMessageEventStream,
	accumulator: Map<string, { name: string; input: string }>,
	pendingToolCalls: Array<{ id: string; toolCall: ToolCall; index: number }>,
): void {
	const name = ev.name ?? "";
	const input = ev.input ?? "";

	// Determine the tool ID: use provided ID, or find the currently active tool call
	let toolUseId = ev.toolUseId;
	if (!toolUseId) {
		// ID-less fragment: associate with the currently active tool call
		// Find the last tool call being accumulated (the most recently started tool)
		const keys = Array.from(accumulator.keys());
		if (keys.length > 0) {
			toolUseId = keys[keys.length - 1];
		} else {
			// No active tool calls; create a placeholder entry (should rarely happen)
			toolUseId = "";
		}
	}

	// Accumulate input fragments per toolUseId
	let accumulated = accumulator.get(toolUseId);
	if (!accumulated) {
		accumulated = { name, input: "" };
		accumulator.set(toolUseId, accumulated);
	}
	accumulated.input += input;

	// Update name if provided and not yet set
	if (name && !accumulated.name) {
		accumulated.name = name;
	}

	// Defer toolcall_end emission until stream end (after refusal is ruled out)
	if (ev.stop) {
		const inputStr = accumulated.input;
		const toolCall: ToolCall = {
			type: "toolCall",
			id: toolUseId,
			name: accumulated.name,
			arguments: safeParseJson(inputStr) as Record<string, any>,
		};
		captureUnicodeEscapeEvidence(toolCall, inputStr);

		const newBlock: Block = { ...toolCall, index: blocks.length };
		captureUnicodeEscapeEvidence(newBlock, inputStr);
		blocks.push(newBlock);
		// Track pending tool call to emit at stream end
		pendingToolCalls.push({ id: toolUseId, toolCall, index: newBlock.index! });
		accumulator.delete(toolUseId);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A 2xx response that is not an AWS event stream: a deterministic protocol error, never a transport failure. */
class KiroNonEventStreamError extends Error {
	override name = "KiroNonEventStreamError";
}

/** Byte cap for diagnostic error bodies; the rest of the stream is cancelled unread. */
const ERROR_BODY_PREFIX_BYTES = 4096;

/** Read at most {@link ERROR_BODY_PREFIX_BYTES} of a response body for diagnostics, then cancel the remainder. */
async function readBodyPrefix(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < ERROR_BODY_PREFIX_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = value.subarray(0, ERROR_BODY_PREFIX_BYTES - total);
			chunks.push(take);
			total += take.length;
		}
	} catch {
		// Diagnostic read only; report whatever prefix arrived.
	} finally {
		reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(bytes);
}

function resolveBearerToken(apiKey: string | undefined): string | undefined {
	if (!apiKey) {
		return $credentialEnv("KIRO_API_KEY") ?? $credentialEnv("AWS_BEARER_TOKEN_KIRO") ?? undefined;
	}

	// Structured API key (from getOAuthApiKey) contains the access token as JSON
	try {
		const parsed = JSON.parse(apiKey) as { token?: string };
		if (parsed.token) return parsed.token;
	} catch {
		// Plain bearer token
	}

	return apiKey;
}

function safeParsePayload(payload: Uint8Array): unknown {
	if (payload.length === 0) return {};
	try {
		const text = new TextDecoder().decode(payload);
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function safeParseJson(str: string): unknown {
	if (!str) return {};
	try {
		return JSON.parse(str);
	} catch {
		return str;
	}
}
