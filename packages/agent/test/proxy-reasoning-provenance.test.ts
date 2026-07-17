import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Model, ThinkingContent } from "@gajae-code/ai";
import { streamProxy } from "../src/proxy";

const RAW_SENTINEL = "RAW_SENTINEL_DO_NOT_SURFACE";
const SUMMARY_SENTINEL = "SUMMARY_SENTINEL_SAFE_TO_SURFACE";

const model: Model = {
	id: "test",
	name: "test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
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

describe("streamProxy reasoning provenance", () => {
	test("materializes summary provenance before reasoning_summary_end", async () => {
		const events = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "reasoning_summary_start", contentIndex: 0 },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "safe summary" },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "end content is ignored" },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		];
		(
			globalThis as {
				fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
			}
		).fetch = async () =>
			new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "Content-Type": "text/event-stream" },
			});

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.test",
			},
		);
		const received: AssistantMessageEvent[] = [];
		for await (const event of stream) received.push(event);

		const summaryEnd = received.find(
			(event): event is Extract<AssistantMessageEvent, { type: "reasoning_summary_end" }> =>
				event.type === "reasoning_summary_end",
		);
		expect(summaryEnd).toBeDefined();
		const block = summaryEnd?.partial.content[0] as ThinkingContent;
		expect(block).toMatchObject({ provenance: "summary", summaryText: "safe summary" });
		expect(block.rawText).toBeUndefined();
		expect(summaryEnd?.content).toBe("safe summary");
	});
	test("preserves final-only summary content from reasoning_summary_end", async () => {
		const events = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "reasoning_summary_start", contentIndex: 0 },
			{ type: "reasoning_summary_end", contentIndex: 0, content: "FINAL SUMMARY" },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		];
		(
			globalThis as {
				fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
			}
		).fetch = async () =>
			new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "Content-Type": "text/event-stream" },
			});

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.test",
			},
		);
		const received: AssistantMessageEvent[] = [];
		for await (const event of stream) received.push(event);

		const summaryEnd = received.find(
			(event): event is Extract<AssistantMessageEvent, { type: "reasoning_summary_end" }> =>
				event.type === "reasoning_summary_end",
		);
		expect(summaryEnd).toBeDefined();
		const block = summaryEnd?.partial.content[0] as ThinkingContent;
		expect(block).toMatchObject({ provenance: "summary", summaryText: "FINAL SUMMARY" });
		expect(block.rawText).toBeUndefined();
		expect(summaryEnd?.content).toBe("FINAL SUMMARY");
	});
	test("finalizes mixed reasoning to summary-only thinking", async () => {
		const events = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "RAW_DO_NOT_SURFACE" },
			{ type: "reasoning_summary_start", contentIndex: 0 },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "SUMMARY_SAFE" },
			{ type: "reasoning_summary_end", contentIndex: 0 },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		];
		(
			globalThis as {
				fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
			}
		).fetch = async () =>
			new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "Content-Type": "text/event-stream" },
			});

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.test",
			},
		);
		const received: AssistantMessageEvent[] = [];
		for await (const event of stream) received.push(event);

		const done = received.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
		);
		expect(done).toBeDefined();
		const block = done?.message.content[0] as ThinkingContent;
		expect(block).toMatchObject({
			provenance: "mixed",
			rawText: "RAW_DO_NOT_SURFACE",
			summaryText: "SUMMARY_SAFE",
		});
		expect(block.thinking).toBe("SUMMARY_SAFE");
		expect(block.thinking).not.toContain("RAW_DO_NOT_SURFACE");
	});

	test("preserves raw thinking for raw-only provenance", async () => {
		const events = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "RAW_ONLY" },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		];
		(
			globalThis as {
				fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
			}
		).fetch = async () =>
			new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "Content-Type": "text/event-stream" },
			});

		const stream = streamProxy(
			model,
			{ messages: [] },
			{
				authToken: "test",
				proxyUrl: "https://proxy.example.test",
			},
		);
		const received: AssistantMessageEvent[] = [];
		for await (const event of stream) received.push(event);

		const done = received.find(
			(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
		);
		expect(done).toBeDefined();
		const block = done?.message.content[0] as ThinkingContent;
		expect(block).toMatchObject({ provenance: "raw", rawText: "RAW_ONLY" });
		expect(block.thinking).toContain("RAW_ONLY");
	});
	test("keeps finalized thinking monotonic across proxy reasoning finalization permutations", async () => {
		const run = async (events: Array<Record<string, unknown>>) => {
			(
				globalThis as {
					fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
				}
			).fetch = async () =>
				new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "Content-Type": "text/event-stream" },
				});
			const received: AssistantMessageEvent[] = [];
			for await (const event of streamProxy(
				model,
				{ messages: [] },
				{ authToken: "test", proxyUrl: "https://proxy.example.test" },
			)) {
				received.push(event);
			}
			const done = received.find(
				(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
			);
			expect(done).toBeDefined();
			return done!.message.content[0] as ThinkingContent;
		};
		const start = [{ type: "start" }, { type: "thinking_start", contentIndex: 0 }];
		const finish = [
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage },
		];
		const summary = [
			{ type: "reasoning_summary_start", contentIndex: 0 },
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: SUMMARY_SENTINEL },
			{ type: "reasoning_summary_end", contentIndex: 0 },
		];
		const raw = { type: "thinking_delta", contentIndex: 0, delta: RAW_SENTINEL };
		const cases = [
			{
				name: "summary-first then raw after finalized summary",
				events: [...start, ...summary, raw, ...finish],
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
				rawText: undefined,
			},
			{
				name: "raw-first then summary",
				events: [...start, raw, ...summary, ...finish],
				provenance: "mixed",
				summaryText: SUMMARY_SENTINEL,
				rawText: RAW_SENTINEL,
			},
			{
				name: "duplicate reasoning_summary_end finalization",
				events: [...start, ...summary, { type: "reasoning_summary_end", contentIndex: 0 }, ...finish],
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
				rawText: undefined,
			},
			{
				name: "final-only summary",
				events: [
					...start,
					{ type: "reasoning_summary_start", contentIndex: 0 },
					{ type: "reasoning_summary_end", contentIndex: 0, content: SUMMARY_SENTINEL },
					...finish,
				],
				provenance: "summary",
				summaryText: SUMMARY_SENTINEL,
				rawText: undefined,
			},
			{
				name: "raw-only control",
				events: [...start, raw, ...finish],
				provenance: "raw",
				summaryText: undefined,
				rawText: RAW_SENTINEL,
			},
		] as const;

		for (const scenario of cases) {
			const block = await run([...scenario.events]);
			expect(block, scenario.name).toMatchObject({ provenance: scenario.provenance });
			expect(block.summaryText, scenario.name).toBe(scenario.summaryText);
			expect(block.rawText, scenario.name).toBe(scenario.rawText);
			if (scenario.provenance === "raw") {
				expect(block.thinking, scenario.name).toBe(RAW_SENTINEL);
			} else {
				expect(block.thinking, scenario.name).toBe(SUMMARY_SENTINEL);
				expect(block.thinking, scenario.name).not.toContain(RAW_SENTINEL);
			}
		}
	});
});
