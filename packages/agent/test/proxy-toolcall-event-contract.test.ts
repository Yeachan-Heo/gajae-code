import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Model } from "@gajae-code/ai";
import { streamProxy } from "../src/proxy";

type EventType = AssistantMessageEvent["type"];

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

function installProxyEvents(events: Array<Record<string, unknown>>): void {
	(
		globalThis as {
			fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
		}
	).fetch = async () =>
		new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "Content-Type": "text/event-stream" },
		});
}

async function collectEvents(): Promise<AssistantMessageEvent[]> {
	return Array.fromAsync(
		streamProxy(model, { messages: [] }, { authToken: "test", proxyUrl: "https://proxy.example.test" }),
	);
}

describe("streamProxy tool-call event contract", () => {
	test.each([
		[
			"missing content",
			[{ type: "start" }, { type: "toolcall_end", contentIndex: 0 }, { type: "done", reason: "stop", usage }],
			["start", "error"],
		],
		[
			"non-toolCall content",
			[
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "toolcall_end", contentIndex: 0 },
				{ type: "done", reason: "stop", usage },
			],
			["start", "text_start", "error"],
		],
	] satisfies Array<
		[string, Array<Record<string, unknown>>, EventType[]]
	>)("fails closed when toolcall_end references %s", async (_label, proxyEvents, expectedTypes) => {
		installProxyEvents(proxyEvents);

		const events = await collectEvents();

		expect(events.map(event => event.type)).toEqual(expectedTypes);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("expected an error terminal");
		expect(terminal.error.errorMessage).toBe("Received toolcall_end for non-toolCall content");
	});

	test("preserves a valid tool-call sequence", async () => {
		installProxyEvents([
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"query":"status"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		]);

		const events = await collectEvents();

		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const ended = events.find(event => event.type === "toolcall_end");
		expect(ended?.type).toBe("toolcall_end");
		if (ended?.type !== "toolcall_end") throw new Error("expected a toolcall_end event");
		expect(ended.toolCall).toMatchObject({
			id: "call-1",
			name: "lookup",
			arguments: { query: "status" },
		});
		expect("partialJson" in ended.toolCall).toBe(false);
	});
});
