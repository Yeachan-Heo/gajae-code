/**
 * gjc auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, OpenAI code backend
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → gjc Context → pi-ai stream() →
 * gjc events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 */
import { logger } from "@gajae-code/utils";
import type { AuthStorage } from "../auth-storage";
import { Effort } from "../model-thinking";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { streamSimple } from "../stream";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types";
import { parseBind } from "../utils/parse-bind";
import {
	captureRequestHeaders,
	corsHeaders,
	isAuthorized,
	isNoAuthBrowserOriginRequest,
	json,
	resolvePeer,
	withCors,
} from "./http";
import type {
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Anthropic-code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for OpenAI code provider-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). OpenAI code backend-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to OpenAI code backend's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (gjc re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	const hex = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
	// Format the leading 128 bits as a v4-shape UUID (8-4-4-4-12). OpenAI code backend's
	// `normalizeOpenAIResponsesPromptCacheKey` accepts ≤64 chars verbatim, so
	// the 36-char UUID flows through unchanged.
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// OpenAI code backend backend rejects `temperature` / `top_p` (per-model defaults only),
	// so we drop them silently for that one provider. Every other unsupported
	// option is just ignored by `streamSimple` if the underlying provider
	// doesn't honour it.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined) opts.topK = options.topK;
	if (options.minP !== undefined) opts.minP = options.minP;
	if (options.stopSequences !== undefined) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.headers !== undefined) opts.headers = { ...(opts.headers ?? {}), ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice === "object" ? { type: "tool", name: options.toolChoice.name } : options.toolChoice;
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// OpenAI code backend-class backends across turns of the same logical conversation.
	opts.sessionId = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	// Fields that don't yet have a matching pi-ai `SimpleStreamOptions` slot.
	// Surfaced once in debug logs so they show up when wiring a new provider,
	// but NEVER widened into `options.extra` — every consumer would have to
	// re-implement the typed parse to read them back out.
	// TODO(pi-ai): land first-class fields and replace these blocks.
	if (
		options.parallelToolCalls !== undefined ||
		options.previousResponseId !== undefined ||
		options.seed !== undefined ||
		options.logitBias !== undefined ||
		options.user !== undefined ||
		options.responseFormat !== undefined
	) {
		logger.debug("auth-gateway dropped unsupported typed options", {
			api,
			parallelToolCalls: options.parallelToolCalls,
			previousResponseId: options.previousResponseId,
			seed: options.seed,
			hasLogitBias: options.logitBias !== undefined,
			user: options.user,
			hasResponseFormat: options.responseFormat !== undefined,
		});
	}
	return opts;
}

/**
 * Classify an upstream / gateway-internal error into a status code and a
 * provider-style error type tag. Used by `handleFormatEndpoint` /
 * `handlePassthrough` to drive `route.module.formatError` so every wire
 * format emits its native envelope shape.
 */
function classifyGatewayError(err: unknown): { status: number; type: string; message: string } {
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();

	// Custom pi-ai errors may attach a numeric `status` property; honor it
	// when present and pick the matching tag.
	const statusProp =
		typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number"
			? (err as { status: number }).status | 0
			: undefined;
	if (statusProp !== undefined) {
		if (statusProp === 401 || statusProp === 403)
			return { status: statusProp, type: "authentication_error", message };
		if (statusProp === 429) return { status: 429, type: "rate_limit_error", message };
		if (statusProp >= 400 && statusProp < 500) return { status: statusProp, type: "invalid_request_error", message };
		if (statusProp >= 500) return { status: statusProp, type: "upstream_error", message };
	}

	if (err instanceof Error && err.name === "AbortError") return { status: 499, type: "request_aborted", message };
	if (lower.includes("aborted") || lower.includes("abortsignal")) {
		return { status: 499, type: "request_aborted", message };
	}
	if (
		lower.includes("401") ||
		lower.includes("403") ||
		lower.includes("unauthorized") ||
		lower.includes("forbidden")
	) {
		return { status: 401, type: "authentication_error", message };
	}
	if (lower.includes("429") || lower.includes("rate") || lower.includes("quota")) {
		return { status: 429, type: "rate_limit_error", message };
	}
	if (lower.includes("unsupported") || lower.includes("invalid")) {
		return { status: 400, type: "invalid_request_error", message };
	}
	return { status: 502, type: "upstream_error", message };
}

async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	provider: string,
	oldKey: string,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
): Promise<string | undefined> {
	await storage.invalidateCredentialMatching(provider, oldKey, signal);
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: error instanceof Error ? error.message : String(error),
	});
	return storage.getApiKey(provider, undefined, { modelId: model.id, signal });
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

// (handlePassthrough removed — see note above.)

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}

	const model = bootOpts.resolveModel(modelId);
	if (!model) {
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}

	// pi-ai's stream() does NOT consult AuthStorage — the caller (us) is
	// expected to resolve the credential and pass it as `options.apiKey`.
	// For OAuth providers this returns the access token (refreshed via the
	// broker override on AuthStorage when needed).
	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, undefined, {
			modelId: model.id,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);
	if (!apiKey) {
		return route.module.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	// Parse + validate against the strict format schema, rebuild as gjc's
	// canonical Context, dispatch through pi-ai's streamSimple, encode the
	// canonical event stream back to the inbound format. There is no
	// passthrough fast-path — every request flows through pi-ai so that
	// credential-specific request shaping (OAuth Anthropic-code prefix, beta
	// headers, OpenAI code backend websocket transport, …) always applies.
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	// Merge gateway-captured passthrough headers under the parser's own
	// captures. Parsers that set `options.headers` themselves win (they may
	// have stripped or normalized values); the gateway's allow-list fills in
	// anything they didn't touch.
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...(parsed.options.headers ?? {}) };
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
	streamOpts.apiKey = apiKey;
	streamOpts.onAuthError = (provider, oldKey, error) =>
		refreshGatewayApiKeyAfterAuthError(
			bootOpts.storage,
			model,
			provider,
			oldKey,
			error,
			controller.signal,
			route.label,
			peer,
		);

	logger.info("auth-gateway request", {
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return clientClosedResponse(route);
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: route.label, error: classified.message, peer });
		return route.module.formatError(classified.status, classified.type, classified.message);
	}

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const message = await events.result();
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: route.label,
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return route.module.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(new Error(errorMessage));
				return route.module.formatError(classified.status, classified.type, errorMessage);
			}
			return json(200, route.module.encodeResponse(message, parsed.modelId));
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: route.label,
				error: classified.message,
				peer,
			});
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options);
	return new Response(sseStream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// Disable proxy buffering (nginx and ingress controllers honor this).
			// Without it the SSE stream gets held until the buffer flushes, which
			// stalls the long-thinking-budget calls we exist to support.
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, OpenAI code backend temperature/topP strip, prefix-cache key derivation,
 * Anthropic-code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNative(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => piNative.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return piNative.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}

	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, undefined, {
			modelId: model.id,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return aborted();
	if (!apiKey) {
		return piNative.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	// Build the SimpleStreamOptions actually handed to `streamSimple`. We
	// trust the client's options (already allow-listed by `parseRequest`) and
	// only inject server-controlled fields. The OpenAI code backend temperature/topP strip
	// matches `buildStreamOptions` — OpenAI code backend rejects them with a 400.
	const streamOpts: SimpleStreamOptions = { ...parsed.options, apiKey, signal: controller.signal };
	streamOpts.onAuthError = (provider, oldKey, error) =>
		refreshGatewayApiKeyAfterAuthError(
			bootOpts.storage,
			model,
			provider,
			oldKey,
			error,
			controller.signal,
			"pi-native",
			peer,
		);
	if (model.api === "openai-codex-responses") {
		delete streamOpts.temperature;
		delete streamOpts.topP;
	}
	// Merge gateway-captured passthrough headers under the client's own
	// headers — the client's values win when they collide.
	const captured = captureRequestHeaders(req.headers);
	streamOpts.headers = { ...captured, ...(streamOpts.headers ?? {}) };
	// Cache identity: explicit `sessionId` wins, then derive a stable key
	// from model + system + tools + first message so OpenAI code backend prefix caching
	// engages on the same logical conversation across turns.
	streamOpts.sessionId ??= deriveSessionId(parsed.modelId, parsed.context);

	logger.info("auth-gateway request", {
		format: "pi-native",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return aborted();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: "pi-native", error: classified.message, peer });
		return piNative.formatError(classified.status, classified.type, classified.message);
	}

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return aborted();
			const message = await events.result();
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: "pi-native",
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return piNative.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(new Error(errorMessage));
				return piNative.formatError(classified.status, classified.type, errorMessage);
			}
			return json(200, { message });
		} catch (error) {
			if (controller.signal.aborted) return aborted();
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", { format: "pi-native", error: classified.message, peer });
			return piNative.formatError(classified.status, classified.type, classified.message);
		}
	}
	if (controller.signal.aborted) return aborted();

	const sseStream = piNative.encodeStream(events);
	return new Response(sseStream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const credentials = await storage.checkCredentials({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const list = opts.listModels ? Array.from(opts.listModels()) : [];
	const data = list.map(model => ({
		id: model.id,
		object: "model" as const,
		owned_by: model.provider,
		api: model.api,
	}));
	return json(200, { object: "list", data });
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			if (isNoAuthBrowserOriginRequest(req, tokens)) {
				logger.info("auth-gateway no-auth browser-origin request rejected", {
					method: req.method,
					path: pathname,
					peer,
					origin: req.headers.get("origin"),
				});
				return json(403, { error: "browser origin requires bearer token" });
			}
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
				// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					return withCors(await handleUsage(opts.storage, req.signal), req);
				}

				// Per-credential auth probe — diagnoses which row in a multi-account
				// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
				// credentials, so we need a separate endpoint that captures errors.
				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					return withCors(await handleCredentialsCheck(opts.storage, req.signal), req);
				}

				// Provider-format dispatch.
				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					return withCors(await handleFormatEndpoint(formatRoute, opts, req, peer), req);
				}

				// Pi-native fast path. Same auth + provider plumbing as the
				// foreign-wire routes, just without the wire-format translation.
				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(opts, req, peer), req);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					return withCors(handleModelsList(opts), req);
				}

				// Route-table miss: no format module to defer to, so we emit a
				// plain JSON 404 rather than guessing at a protocol-specific envelope.
				return withCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			server.stop(true);
		},
	};
}
