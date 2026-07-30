import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { applyOpenAIRequestTransformBody } from "../src/providers/openai-request-transform";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function completionsSseResponse(): Response {
	const payload = [
		{ choices: [{ delta: { content: "ok" }, index: 0 }] },
		{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
		"[DONE]",
	]
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n");
	return new Response(`${payload}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responsesSseResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const payload = events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n");
	return new Response(`${payload}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function headersFromRequest(input: string | URL | Request, init?: RequestInit): Headers {
	if (input instanceof Request) return new Headers(input.headers);
	return new Headers(init?.headers);
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("OpenAI-compatible request transforms", () => {
	it("strips SDK telemetry headers, applies configured headers/body, and uses wire ids for chat completions", async () => {
		const base = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...base,
			api: "openai-completions",
			provider: "proxy",
			baseUrl: "https://proxy.example/v1",
			id: "local-selector",
			wireModelId: "upstream-wire-id",
			headers: { "x-stainless-lang": "js", "OpenAI-Beta": "responses=v1", "x-keep": "yes" },
			requestTransform: {
				profile: "openai-proxy",
				setHeaders: { "x-custom": "configured", "x-remove": null },
				extraBody: { gateway: "layofflabs", metadata: { route: "smoke" } },
			},
		};
		let capturedHeaders = new Headers();
		let capturedBody: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = headersFromRequest(input, init);
			capturedBody = JSON.parse(
				String(init?.body ?? (input instanceof Request ? await input.clone().text() : "{}")),
			) as Record<string, unknown>;
			return completionsSseResponse();
		});
		global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key" });
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedHeaders.get("x-stainless-lang")).toBeNull();
		expect(capturedHeaders.get("openai-beta")).toBeNull();
		expect(capturedHeaders.get("x-keep")).toBe("yes");
		expect(capturedHeaders.get("x-custom")).toBe("configured");
		expect(capturedHeaders.get("x-remove")).toBeNull();
		expect(capturedHeaders.get("user-agent")).toStartWith("Gajae-Code/");
		expect(capturedBody.model).toBe("upstream-wire-id");
		expect(capturedBody.gateway).toBe("layofflabs");
		expect(capturedBody.metadata).toEqual({ route: "smoke" });
	});

	it("applies wire ids and extra body fields for responses requests", async () => {
		const base = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const model: Model<"openai-responses"> = {
			...base,
			api: "openai-responses",
			provider: "proxy",
			baseUrl: "https://proxy.example/v1",
			id: "local-responses-selector",
			wireModelId: "responses-wire-id",
			requestTransform: { extraBody: { gateway: "responses", model: "blocked-model-override", stream: false } },
		};
		let capturedBody: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(
				String(init?.body ?? (input instanceof Request ? await input.clone().text() : "{}")),
			) as Record<string, unknown>;
			return responsesSseResponse();
		});
		global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

		const stream = streamOpenAIResponses(model, context, { apiKey: "test-key" });
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedBody.model).toBe("responses-wire-id");
		expect(capturedBody.stream).toBe(true);
		expect(capturedBody.gateway).toBe("responses");
	});

	it("does not let extra body override first-class request fields", () => {
		const body: Record<string, unknown> = {
			model: "wire-id",
			stream: true,
			store: false,
			max_output_tokens: 1000,
			reasoning: { effort: "high" },
			prompt_cache_key: "session-key",
			service_tier: "auto",
		};

		applyOpenAIRequestTransformBody(body, {
			extraBody: {
				model: "bad",
				stream: false,
				store: true,
				max_output_tokens: 1,
				reasoning: { effort: "minimal" },
				reasoning_effort: "minimal",
				prompt_cache_key: "bad-key",
				service_tier: "priority",
				gateway: "allowed",
			},
		});

		expect(body).toEqual({
			model: "wire-id",
			stream: true,
			store: false,
			max_output_tokens: 1000,
			reasoning: { effort: "high" },
			prompt_cache_key: "session-key",
			service_tier: "auto",
			gateway: "allowed",
		});
		expect("reasoning_effort" in body).toBe(false);
	});
	it("preserves endpoint query parameters for responses and chat completions", async () => {
		const capturedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			capturedUrls.push(String(input));
			return capturedUrls.length === 1 ? responsesSseResponse() : completionsSseResponse();
		});
		global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

		const responsesModel: Model<"openai-responses"> = {
			...(getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">),
			provider: "proxy",
			baseUrl: "https://gateway.example/v1?scope=read&scope=write",
		};
		for await (const event of streamOpenAIResponses(responsesModel, context, { apiKey: "test-key" })) {
			if (event.type === "done" || event.type === "error") break;
		}

		const completionsModel: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			provider: "proxy",
			baseUrl: "https://gateway.example/v1?scope=read&scope=write",
		};
		for await (const event of streamOpenAICompletions(completionsModel, context, { apiKey: "test-key" })) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedUrls).toEqual([
			"https://gateway.example/v1/responses?scope=read&scope=write",
			"https://gateway.example/v1/chat/completions?scope=read&scope=write",
		]);
	});
	it("uses a configured Azure api-version without synthesizing a duplicate", async () => {
		const base = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const capturedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			capturedUrls.push(input instanceof Request ? input.url : String(input));
			return completionsSseResponse();
		});
		global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

		const configuredModel: Model<"openai-completions"> = {
			...base,
			provider: "proxy",
			baseUrl: "https://resource.openai.azure.com/openai/v1?api-version=2025-01-01&trace=enabled",
		};
		for await (const event of streamOpenAICompletions(configuredModel, context, { apiKey: "test-key" })) {
			if (event.type === "done" || event.type === "error") break;
		}

		const defaultModel: Model<"openai-completions"> = {
			...base,
			provider: "proxy",
			baseUrl: "https://resource.openai.azure.com/openai/v1?trace=enabled",
		};
		for await (const event of streamOpenAICompletions(defaultModel, context, { apiKey: "test-key" })) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedUrls).toEqual([
			"https://resource.openai.azure.com/openai/v1/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01&trace=enabled",
			"https://resource.openai.azure.com/openai/v1/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21&trace=enabled",
		]);
		expect(new URL(capturedUrls[0]).searchParams.getAll("api-version")).toEqual(["2025-01-01"]);
		expect(new URL(capturedUrls[1]).searchParams.getAll("api-version")).toEqual(["2024-10-21"]);
	});
});
