import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "../src/providers/openai-responses";
import type { AssistantMessage, Context, Model, ProviderSessionState } from "../src/types";
import { createOpenAIResponsesHistoryPayload } from "../src/utils";

const originalFetch = global.fetch;
const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureOpenAIResponseHeaders(
	options: OpenAIResponsesOptions,
	modelOverride: Model<"openai-responses"> = model,
	contextOverride?: Context,
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	openCodeSessionId: string | null;
	url: string | null;
	body: Record<string, unknown> | null;
	message: AssistantMessage | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		openCodeSessionId: null as string | null,
		url: null as string | null,
		body: null as Record<string, unknown> | null,
		message: null as AssistantMessage | null,
	};
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, key) => {
			headers.set(key, value);
		});
		captured.sessionId = headers.get("session_id");
		captured.clientRequestId = headers.get("x-client-request-id");
		captured.openCodeSessionId = headers.get("x-opencode-session");
		captured.url = input instanceof Request ? input.url : String(input);
		captured.body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		return createSseResponse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

	const context: Context = contextOverride ?? {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamOpenAIResponses(modelOverride, context, {
		apiKey: "test-key",
		...(modelOverride.baseUrl === model.baseUrl ? { authCredentialType: "oauth" as const } : {}),
		...options,
	});

	for await (const event of stream) {
		if (event.type === "done") {
			captured.message = event.message;
			break;
		}
		if (event.type === "error") break;
	}

	return captured;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("openai-responses cache affinity", () => {
	it("sends the opaque provider identity for bundled OpenCode Go Responses models", async () => {
		const openCodeModel = getBundledModel("opencode-go", "grok-4.6") as Model<"openai-responses">;
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "generic-cache-key", providerSessionId: "opaque-provider-session" },
			openCodeModel,
		);

		expect(captured.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(captured.openCodeSessionId).toBe("opaque-provider-session");
		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("strips injected OpenCode headers from unauthorized Responses endpoints", async () => {
		const openCodeModel = getBundledModel("opencode-go", "grok-4.6") as Model<"openai-responses">;
		const captured = await captureOpenAIResponseHeaders(
			{
				providerSessionId: "opaque-provider-session",
				headers: { "X-OpenCode-Session": "options-injection" },
			},
			{
				...openCodeModel,
				baseUrl: "https://relay.example.com/v1",
				headers: { "X-OpenCode-Session": "model-injection" },
				requestTransform: { setHeaders: { "x-opencode-session": "transform-injection" } },
			},
		);

		expect(captured.openCodeSessionId).toBeNull();
	});

	it("preserves query routing without authorizing the OpenCode provider header", async () => {
		const openCodeModel = getBundledModel("opencode-go", "grok-4.6") as Model<"openai-responses">;
		const captured = await captureOpenAIResponseHeaders(
			{
				providerSessionId: "opaque-provider-session",
				headers: { "X-OpenCode-Session": "options-injection" },
			},
			{
				...openCodeModel,
				baseUrl: "https://opencode.ai/zen/go/v1?route=relay",
				headers: { "X-OpenCode-Session": "model-injection" },
				requestTransform: { setHeaders: { "x-opencode-session": "transform-injection" } },
			},
		);

		expect(captured.url).toBe("https://opencode.ai/zen/go/v1/responses?route=relay");
		expect(captured.openCodeSessionId).toBeNull();
	});

	it("sets session routing headers for the canonical official OpenAI Responses origin", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
	});

	it.each([
		"https://api.openai.com",
		"https://api.openai.com/",
	])("sets affinity headers for the canonical official OpenAI Responses root origin %s", async baseUrl => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, { ...model, baseUrl });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("sets affinity headers for an explicitly opted-in openai-relay provider", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				provider: "openai-relay",
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
	});

	it.each([
		"https://api.openai.com",
		"https://api.openai.com/v1",
		"https://api.openai.com/",
	])("does not set affinity headers for an unknown provider on a canonical OpenAI origin %s", async baseUrl => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				provider: "openai-relay",
				baseUrl,
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});
	it("does not set affinity headers for an unknown provider without an explicit base URL", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				provider: "openai-relay",
				baseUrl: "",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("allows an explicit opt-in on the known openai provider when it uses a custom relay", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("keeps an arbitrary relay default-off", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{ ...model, provider: "openai-relay", baseUrl: "https://relay.example.com/v1" },
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("excludes known non-target providers even when affinity is explicitly enabled", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				provider: "github-copilot",
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it.each([
		"http://api.openai.com/v1",
		"https://api.openai.com:8443/v1",
		"https://api.openai.com/v2",
		"https://user:password@api.openai.com/v1",
		"https://api.openai.com/v1?tenant=relay",
	])("does not set automatic affinity headers for non-canonical origin %s", async baseUrl => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, { ...model, baseUrl });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("preserves model and request header precedence over affinity defaults", async () => {
		const modelHeaders = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				headers: {
					session_id: "model-session",
					"x-client-request-id": "model-request",
				},
			},
		);
		expect(modelHeaders.sessionId).toBe("model-session");
		expect(modelHeaders.clientRequestId).toBe("model-request");

		const requestHeaders = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				headers: {
					session_id: "request-session",
					"x-client-request-id": "request-request",
				},
			},
			{
				...model,
				headers: {
					session_id: "model-session",
					"x-client-request-id": "model-request",
				},
			},
		);
		expect(requestHeaders.sessionId).toBe("request-session");
		expect(requestHeaders.clientRequestId).toBe("request-request");
		expect(requestHeaders.body?.prompt_cache_key).toBe("session-123");
	});

	it("preserves requestTransform strip, set, and null semantics", async () => {
		const stripped = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
				requestTransform: {
					stripHeaders: ["session_id", "x-client-request-id"],
				},
			},
		);
		expect(stripped.sessionId).toBeNull();
		expect(stripped.clientRequestId).toBeNull();

		const set = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
				requestTransform: {
					setHeaders: {
						session_id: "transform-session",
						"x-client-request-id": "transform-request",
					},
				},
			},
		);
		expect(set.sessionId).toBe("transform-session");
		expect(set.clientRequestId).toBe("transform-request");

		const nulled = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
				requestTransform: {
					setHeaders: {
						session_id: null,
						"x-client-request-id": null,
					},
				},
			},
		);
		expect(nulled.sessionId).toBeNull();
		expect(nulled.clientRequestId).toBeNull();
	});

	it("keeps official affinity headers when retention is none but omits body retention", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
	});

	it("gates opted-in relay affinity headers on effective retention", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ cacheRetention: "none", sessionId: "session-123" },
			{
				...model,
				provider: "openai-relay",
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
	});

	it.each(["short", "long"] as const)("uses the effective %s retention for relay affinity", async cacheRetention => {
		const captured = await captureOpenAIResponseHeaders(
			{ cacheRetention, sessionId: "session-123" },
			{
				...model,
				provider: "openai-relay",
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, supportsResponsesSessionAffinity: true },
			},
		);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
	});

	it("preserves protected body fields while allowing safe transform extras", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				requestTransform: {
					extraBody: {
						prompt_cache_key: "wrong-key",
						prompt_cache_retention: "wrong-retention",
						store: true,
						relay_marker: "present",
					},
				},
			},
		);

		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
		expect(captured.body?.store).toBe(false);
		expect(captured.body?.relay_marker).toBe("present");
	});

	it("keeps the same session identity when replaying provider-session-state history", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options: OpenAIResponsesOptions = {
			sessionId: "session-continuity",
			providerSessionState,
		};
		const firstContext: Context = {
			messages: [{ role: "user", content: "first turn", timestamp: Date.now() }],
		};
		const first = await captureOpenAIResponseHeaders(options, model, firstContext);
		expect(first.message).not.toBeNull();
		(first.message as AssistantMessage).providerPayload = createOpenAIResponsesHistoryPayload("openai", [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "native replay marker" }],
				status: "completed",
			},
		]);
		const replayed = await captureOpenAIResponseHeaders(options, model, {
			messages: [
				...firstContext.messages,
				first.message as AssistantMessage,
				{ role: "user", content: "follow-up turn", timestamp: Date.now() },
			],
		});

		expect([first.sessionId, replayed.sessionId]).toEqual(["session-continuity", "session-continuity"]);
		expect([first.clientRequestId, replayed.clientRequestId]).toEqual(["session-continuity", "session-continuity"]);
		expect([first.body?.prompt_cache_key, replayed.body?.prompt_cache_key]).toEqual([
			"session-continuity",
			"session-continuity",
		]);
		const replayedInput = replayed.body?.input as Array<Record<string, unknown>>;
		expect(replayedInput).toContainEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "native replay marker" }],
			status: "completed",
		});
		expect(providerSessionState.size).toBe(1);
	});

	it("uses model retention when the request omits it and request retention takes precedence", async () => {
		const modelRetention = await captureOpenAIResponseHeaders(
			{ authCredentialType: "oauth", sessionId: "session-123" },
			{ ...model, baseUrl: "https://api.openai.com/v1", cacheRetention: "long" },
		);
		expect(modelRetention.body?.prompt_cache_key).toBe("session-123");
		expect(modelRetention.body?.prompt_cache_retention).toBe("24h");

		const requestRetention = await captureOpenAIResponseHeaders(
			{ authCredentialType: "oauth", cacheRetention: "none", sessionId: "session-123" },
			{ ...model, cacheRetention: "long" },
		);
		expect(requestRetention.body?.prompt_cache_key).toBe("session-123");
		expect(requestRetention.body?.prompt_cache_retention).toBeUndefined();
	});

	it("isolates environment retention overrides", async () => {
		const previousGjc = Bun.env.GJC_CACHE_RETENTION;
		const previousPi = Bun.env.PI_CACHE_RETENTION;
		Bun.env.GJC_CACHE_RETENTION = "long";
		delete Bun.env.PI_CACHE_RETENTION;
		try {
			const captured = await captureOpenAIResponseHeaders(
				{ authCredentialType: "oauth", sessionId: "session-123" },
				{ ...model, baseUrl: "https://api.openai.com/v1" },
			);
			expect(captured.body?.prompt_cache_retention).toBe("24h");
		} finally {
			if (previousGjc === undefined) delete Bun.env.GJC_CACHE_RETENTION;
			else Bun.env.GJC_CACHE_RETENTION = previousGjc;
			if (previousPi === undefined) delete Bun.env.PI_CACHE_RETENTION;
			else Bun.env.PI_CACHE_RETENTION = previousPi;
		}
	});

	it("respects custom and HTTP OPENAI_BASE_URL without treating them as canonical affinity origins", async () => {
		const previous = Bun.env.OPENAI_BASE_URL;
		try {
			Bun.env.OPENAI_BASE_URL = "https://relay.example.com/v1";
			const custom = await captureOpenAIResponseHeaders({
				sessionId: "session-123",
				authCredentialType: "api_key",
			});
			expect(custom.sessionId).toBeNull();
			expect(custom.clientRequestId).toBeNull();

			Bun.env.OPENAI_BASE_URL = "http://api.openai.com/v1";
			const http = await captureOpenAIResponseHeaders({
				sessionId: "session-123",
				authCredentialType: "api_key",
			});
			expect(http.sessionId).toBeNull();
			expect(http.clientRequestId).toBeNull();
		} finally {
			if (previous === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previous;
		}
	});
});
