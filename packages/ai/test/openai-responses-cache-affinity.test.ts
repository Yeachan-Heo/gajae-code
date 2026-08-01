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

function getHeader(headers: RequestInit["headers"], name: string): string | null {
	return new Headers(headers).get(name);
}

async function captureOpenAIResponseHeaders(
	options: OpenAIResponsesOptions,
	modelOverride: Model<"openai-responses"> = model,
	contextOverride?: Context,
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	body: Record<string, unknown> | null;
	message: AssistantMessage | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		body: null as Record<string, unknown> | null,
		message: null as AssistantMessage | null,
	};
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
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
	const stream = streamOpenAIResponses(modelOverride, context, { apiKey: "test-key", ...options });

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
	it("sets session routing headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("sets session routing headers for opted-in OpenAI custom relays", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, sendSessionHeaders: true },
			},
		);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("does not set session routing headers for arbitrary OpenAI custom relays by default", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{ ...model, baseUrl: "https://relay.example.com/v1" },
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("never sets session routing headers for GitHub Copilot, even when compatibility metadata opts in", async () => {
		const copilotModel = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{ ...copilotModel, compat: { ...copilotModel.compat, sendSessionHeaders: true } },
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("never sets session routing headers for other providers, even when compatibility metadata opts in", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "session-123" },
			{
				...model,
				provider: "custom-openai-compatible",
				baseUrl: "https://other-provider.example.com/v1",
				compat: { ...model.compat, sendSessionHeaders: true },
			},
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it("lets explicit headers override session routing headers for an opted-in OpenAI custom relay", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				headers: {
					session_id: "override-session",
					"x-client-request-id": "override-request",
				},
			},
			{
				...model,
				baseUrl: "https://relay.example.com/v1",
				compat: { ...model.compat, sendSessionHeaders: true },
			},
		);

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("keeps prompt_cache_key when cache retention is disabled", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
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

	it("uses model cacheRetention for OpenAI Responses retention when request omits cacheRetention", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ authCredentialType: "oauth", sessionId: "session-123" },
			{ ...model, baseUrl: "https://api.openai.com/v1", cacheRetention: "long" },
		);

		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBe("24h");
	});

	it("lets explicit request cacheRetention win over model cacheRetention", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ cacheRetention: "none", sessionId: "session-123" },
			{ ...model, cacheRetention: "long" },
		);

		expect(captured.body?.prompt_cache_key).toBe("session-123");
		expect(captured.body?.prompt_cache_retention).toBeUndefined();
	});

	it("uses GJC_CACHE_RETENTION when request and model omit cacheRetention", async () => {
		const previous = Bun.env.GJC_CACHE_RETENTION;
		Bun.env.GJC_CACHE_RETENTION = "long";
		try {
			const captured = await captureOpenAIResponseHeaders(
				{ authCredentialType: "oauth", sessionId: "session-123" },
				{ ...model, baseUrl: "https://api.openai.com/v1" },
			);

			expect(captured.body?.prompt_cache_key).toBe("session-123");
			expect(captured.body?.prompt_cache_retention).toBe("24h");
		} finally {
			if (previous === undefined) {
				delete Bun.env.GJC_CACHE_RETENTION;
			} else {
				Bun.env.GJC_CACHE_RETENTION = previous;
			}
		}
	});
});
