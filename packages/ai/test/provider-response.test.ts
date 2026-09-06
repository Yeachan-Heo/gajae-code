import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamSimple } from "../src/stream";
import type { Context, Model, ProviderResponseMetadata } from "../src/types";
import { normalizeProviderResponse, notifyProviderResponse } from "../src/utils/provider-response";

describe("provider response metadata", () => {
	it("normalizes response status, headers, and request id", () => {
		const response = new Response(null, {
			status: 202,
			headers: {
				"X-Request-ID": "req_123",
				"X-RateLimit-Remaining": "42",
			},
		});

		expect(normalizeProviderResponse(response, "req_123")).toEqual({
			status: 202,
			headers: {
				"x-request-id": "req_123",
				"x-ratelimit-remaining": "42",
			},
			requestId: "req_123",
		});
	});

	it("invokes the response callback with normalized metadata", async () => {
		const seen: Array<{ response: ProviderResponseMetadata; model: Model | undefined }> = [];
		const model = { provider: "openai", api: "openai-responses", id: "gpt-test" } as Model;

		await notifyProviderResponse(
			{
				onResponse: (response, responseModel) => {
					seen.push({ response, model: responseModel });
				},
			},
			new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }),
			model,
			null,
			{ attempt: 1 },
		);

		expect(seen).toEqual([
			{
				response: {
					status: 204,
					headers: { "cache-control": "no-store" },
					requestId: null,
					metadata: { attempt: 1 },
				},
				model,
			},
		]);
	});

	it("passes the request cancellation signal to the response callback", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		await notifyProviderResponse(
			{
				signal: controller.signal,
				onResponse: (_response, _model, _scope, signal) => {
					seenSignal = signal;
				},
			},
			new Response(null, { status: 200 }),
		);
		expect(seenSignal).toBe(controller.signal);
	});
});

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

function createSseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

describe("streamSimple onResponse propagation", () => {
	it("invokes onResponse for the default openai-completions path through streamSimple", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};

		global.fetch = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				createSseResponse(
					[
						{
							id: "chatcmpl-onresponse",
							object: "chat.completion.chunk",
							created: 0,
							model: model.id,
							choices: [{ index: 0, delta: { content: "ok" } }],
						},
						{
							id: "chatcmpl-onresponse",
							object: "chat.completion.chunk",
							created: 0,
							model: model.id,
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						},
						"[DONE]",
					],
					{ "x-request-id": "req_stream_simple" },
				),
			{ preconnect: originalFetch.preconnect },
		);

		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const seen: ProviderResponseMetadata[] = [];
		const result = await streamSimple(model, context, {
			apiKey: "test-key",
			onResponse: response => {
				seen.push(response);
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.status).toBe(200);
		expect(seen[0]?.headers["x-request-id"]).toBe("req_stream_simple");
	});
});
