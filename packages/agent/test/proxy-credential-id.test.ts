import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, Model } from "@gajae-code/ai";
import { streamProxy } from "../src/proxy";

const model: Model = {
	id: "test",
	name: "test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("streamProxy credential row ids", () => {
	test("never sends a local stored-credential row id to the proxy server", async () => {
		const bodies: string[] = [];
		(
			globalThis as {
				fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
			}
		).fetch = async (_input, init) => {
			bodies.push(init?.body as string);
			return new Response(
				[{ type: "start" }, { type: "done", reason: "stop", usage }]
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		};
		const priorTurn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "earlier answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: 0,
			credentialId: 5,
		};
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }, priorTurn],
		};

		await streamProxy(model, context, {
			authToken: "test",
			proxyUrl: "https://proxy.example.test",
			credentialId: 7,
		}).result();

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain("credentialId");
		const body = JSON.parse(bodies[0]) as { context: Context };
		expect(body.context.messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "earlier answer" }],
		});
		// The caller's history is not mutated.
		expect(priorTurn.credentialId).toBe(5);
		expect(context.messages[1]).toBe(priorTurn);
	});
});
