import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "../src/models";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

// Non-reasoning model on api.openai.com (canonical path)
const gpt4oMiniModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
// Reasoning model on api.openai.com (developer-role path)
const o4MiniModel = getBundledModel("openai", "o4-mini") as Model<"openai-responses">;

function createSseResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hi" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hi" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const payload = `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureRequestBody(
	model: Model<"openai-responses">,
	context: Context,
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> = {};
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createSseResponse();
	});
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

	const stream = streamOpenAIResponses(model, context, { apiKey: "test-key" });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("openai-responses system prompt routing", () => {
	describe("non-reasoning model (canonical instructions field)", () => {
		it("sends single system prompt as top-level instructions", async () => {
			const context: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBe("You are a helpful assistant.");
			const input = body.input as Array<{ role: string }>;
			expect(input.every(m => m.role !== "system")).toBe(true);
		});

		it("joins multiple system prompts into a single instructions string", async () => {
			const context: Context = {
				systemPrompt: ["Primary prompt.", "Secondary prompt."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBe("Primary prompt.\n\nSecondary prompt.");
			const input = body.input as Array<{ role: string; content: string }>;
			expect(input.every(m => m.role !== "system")).toBe(true);
		});

		it("omits instructions field when there is no system prompt", async () => {
			const context: Context = {
				systemPrompt: undefined,
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBeUndefined();
		});

		it("uses instructions for custom proxy base URL (third-party /v1/responses compatibility)", async () => {
			const proxyModel: Model<"openai-responses"> = {
				...gpt4oMiniModel,
				baseUrl: "https://proxy.example.com/v1",
			};
			const context: Context = {
				systemPrompt: ["You are a proxy assistant."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(proxyModel, context);

			expect(body.instructions).toBe("You are a proxy assistant.");
			const input = body.input as Array<{ role: string }>;
			expect(input.every(m => m.role !== "system")).toBe(true);
		});
	});

	describe("reasoning model on known OpenAI endpoints (developer role)", () => {
		it("sends all system prompts as input[role=developer] for api.openai.com", async () => {
			const context: Context = {
				systemPrompt: ["Developer prompt."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(o4MiniModel, context);

			expect(body.instructions).toBeUndefined();
			const input = body.input as Array<{ role: string; content: string }>;
			const devMessages = input.filter(m => m.role === "developer");
			expect(devMessages).toEqual([{ role: "developer", content: "Developer prompt." }]);
		});

		it("sends multiple system prompts as input[role=developer] for api.openai.com", async () => {
			const context: Context = {
				systemPrompt: ["First.", "Second."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(o4MiniModel, context);

			expect(body.instructions).toBeUndefined();
			const input = body.input as Array<{ role: string; content: string }>;
			const devMessages = input.filter(m => m.role === "developer");
			expect(devMessages).toEqual([
				{ role: "developer", content: "First." },
				{ role: "developer", content: "Second." },
			]);
		});
	});

	describe("reasoning model on custom proxy (instructions path)", () => {
		it("uses instructions for reasoning model on non-official endpoint", async () => {
			const proxyModel: Model<"openai-responses"> = {
				...o4MiniModel,
				baseUrl: "https://proxy.example.com/v1",
			};
			const context: Context = {
				systemPrompt: ["Proxy reasoning prompt."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(proxyModel, context);

			expect(body.instructions).toBe("Proxy reasoning prompt.");
			const input = body.input as Array<{ role: string }>;
			expect(input.every(m => m.role !== "developer" && m.role !== "system")).toBe(true);
		});
	});
});
describe("openai-responses endpoint query routing", () => {
	it("keeps duplicate endpoint query values on path-first client retries", async () => {
		const model: Model<"openai-responses"> = {
			...gpt4oMiniModel,
			provider: "custom" as Model["provider"],
			baseUrl: "https://proxy.example.com/v1?scope=read&scope=write&sig=a%2fb%20c",
		};
		const requests: string[] = [];
		let attempt = 0;
		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				requests.push(input instanceof Request ? input.url : String(input));
				attempt++;
				if (attempt === 1) {
					return new Response("retry", { status: 500, headers: { "retry-after-ms": "0" } });
				}
				return createSseResponse();
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAIResponses(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", fetch: fetchMock, requestMaxRetries: 1 },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			const url = new URL(request);
			expect(url.pathname).toBe("/v1/responses");
			expect(url.searchParams.getAll("scope")).toEqual(["read", "write"]);
			expect(request).toContain("sig=a%2fb%20c");
		}
	});
});
