import { afterEach, describe, expect, test } from "bun:test";
import { getBundledModels } from "../src/models";
import {
	fetchKiroApiModels,
	isKiroApiKey,
	kiroApiStaticModels,
	parseKiroApiEvents,
	toKiroModelId,
} from "../src/providers/kiro-api-key";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("isKiroApiKey", () => {
	test("accepts ksk_ keys", () => {
		expect(isKiroApiKey("ksk_abc")).toBe(true);
		expect(isKiroApiKey("  ksk_abc")).toBe(true);
	});
	test("rejects oauth bearers and empty values", () => {
		expect(isKiroApiKey(undefined)).toBe(false);
		expect(isKiroApiKey("")).toBe(false);
		expect(isKiroApiKey("eyJhbGciOi")).toBe(false);
		expect(isKiroApiKey("AWS_BEARER")).toBe(false);
		expect(isKiroApiKey("ksk_valid\nforged-header")).toBe(false);
	});
});

test("discovers models with the API-key endpoint contract", async () => {
	let request: { url: string; headers: Headers; body: string } | undefined;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		request = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: String(init?.body),
		};
		return new Response(JSON.stringify({ models: [{ modelId: "claude-opus-4.8", modelName: "Opus" }] }), {
			status: 200,
		});
	}) as unknown as typeof fetch;

	const models = await fetchKiroApiModels("ksk_test-secret", "eu-west-1");
	expect(request?.url).toBe("https://q.eu-west-1.amazonaws.com/");
	expect(request?.headers.get("authorization")).toBe("Bearer ksk_test-secret");
	expect(request?.headers.get("tokentype")).toBe("API_KEY");
	expect(request?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
	expect(JSON.parse(request?.body ?? "{}")).toEqual({ origin: "AI_EDITOR" });
	expect(models.map(model => model.id)).toEqual(["claude-opus-4.8", "claude-opus-4-8"]);
});

test("does not advertise image input for static or bundled Kiro Opus 5.5 models", () => {
	const opus55Ids = ["claude-opus-5-5", "claude-opus-5.5"];
	for (const catalog of [kiroApiStaticModels(), getBundledModels("kiro")]) {
		const opus55Models = catalog.filter(model => opus55Ids.includes(model.id));
		expect(opus55Models.map(model => model.id).sort()).toEqual(opus55Ids);
		for (const model of opus55Models) expect(model.input).toEqual(["text"]);
	}
});

test("redacts the API key from discovery errors", async () => {
	globalThis.fetch = (async () =>
		new Response("authorization=ksk_test-secret", { status: 401 })) as unknown as typeof fetch;
	await expect(fetchKiroApiModels("ksk_test-secret")).rejects.toThrow("authorization=[redacted]");
});

describe("toKiroModelId", () => {
	test("converts dash versions to Kiro dot form", () => {
		expect(toKiroModelId("claude-opus-4-8")).toBe("claude-opus-4.8");
		expect(toKiroModelId("claude-opus-4.8")).toBe("claude-opus-4.8");
		expect(toKiroModelId("auto")).toBe("auto");
	});
});

describe("parseKiroApiEvents", () => {
	test("parses content frames and leaves incomplete JSON", () => {
		const { events, remaining } = parseKiroApiEvents('{"content":"hi"}{"content":');
		expect(events).toEqual([{ type: "content", data: "hi" }]);
		expect(remaining).toBe('{"content":');
	});
	test("parses toolUse frames", () => {
		const { events } = parseKiroApiEvents('{"name":"read","toolUseId":"t1","input":"{}","stop":true}');
		expect(events[0]).toEqual({
			type: "toolUse",
			data: { name: "read", toolUseId: "t1", input: "{}", stop: true },
		});
	});
	test("parses refusal events with category and explanation", () => {
		const { events } = parseKiroApiEvents(
			'{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"CYBER","explanation":"Violates policy"}}}',
		);
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.type).toBe("refusal");
		if (event?.type === "refusal") {
			expect(event.data.stopReason).toBe("CONTENT_FILTERED");
			expect(event.data.stopDetails?.refusal?.category).toBe("CYBER");
			expect(event.data.stopDetails?.refusal?.explanation).toBe("Violates policy");
		}
	});
	test("parses refusal events split across chunks", () => {
		const part1 = '{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category"';
		const part2 = ':"VIOLENCE","explanation":"Cannot assist"}}}';
		const { events: events1, remaining: remaining1 } = parseKiroApiEvents(part1);
		expect(events1).toHaveLength(0);
		const { events: events2 } = parseKiroApiEvents(remaining1 + part2);
		expect(events2).toHaveLength(1);
		const event = events2[0];
		expect(event?.type).toBe("refusal");
		if (event?.type === "refusal") {
			expect(event.data.stopDetails?.refusal?.category).toBe("VIOLENCE");
		}
	});
	test("parses combined usage and refusal in the same metadata object", () => {
		// Metadata object containing both usage and refusal (P1 fix: ensure refusal is not masked)
		const { events } = parseKiroApiEvents(
			'{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"ILLEGAL","explanation":"Violates policy"}},"usage":{"inputTokens":15,"outputTokens":2}}',
		);
		// Should emit both refusal and usage events
		expect(events).toHaveLength(2);
		// First event should be refusal
		const refusalEvent = events.find(e => e.type === "refusal");
		expect(refusalEvent?.type).toBe("refusal");
		if (refusalEvent?.type === "refusal") {
			expect(refusalEvent.data.stopReason).toBe("CONTENT_FILTERED");
			expect(refusalEvent.data.stopDetails?.refusal?.category).toBe("ILLEGAL");
			expect(refusalEvent.data.stopDetails?.refusal?.explanation).toBe("Violates policy");
		}
		// Second event should be usage
		const usageEvent = events.find(e => e.type === "usage");
		expect(usageEvent?.type).toBe("usage");
		if (usageEvent?.type === "usage") {
			expect(usageEvent.data.inputTokens).toBe(15);
			expect(usageEvent.data.outputTokens).toBe(2);
		}
	});
	test("parses combined usage and stopReason:COMPLETED in the same metadata object", () => {
		// Metadata object with usage and normal completion (no refusal)
		const { events } = parseKiroApiEvents('{"stopReason":"COMPLETED","usage":{"inputTokens":20,"outputTokens":5}}');
		// Should only emit usage event (normal completion without refusal is ignored)
		const usageEvents = events.filter(e => e.type === "usage");
		expect(usageEvents).toHaveLength(1);
		if (usageEvents[0]?.type === "usage") {
			expect(usageEvents[0].data.inputTokens).toBe(20);
			expect(usageEvents[0].data.outputTokens).toBe(5);
		}
		// Should not emit any refusal events for COMPLETED
		const refusalEvents = events.filter(e => e.type === "refusal");
		expect(refusalEvents).toHaveLength(0);
	});
	test("detects refusal even when stopReason/stopDetails is not the first property (order-independent parsing)", () => {
		// P1 fix (#6150): refusal must be detected regardless of property order
		// Previously, pattern-based matching would miss this because stopReason is not first
		const { events } = parseKiroApiEvents(
			'{"conversationId":"xyz123","stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"VIOLENCE","explanation":"Harmful content"}}}',
		);
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.type).toBe("refusal");
		if (event?.type === "refusal") {
			expect(event.data.stopReason).toBe("CONTENT_FILTERED");
			expect(event.data.stopDetails?.refusal?.category).toBe("VIOLENCE");
			expect(event.data.stopDetails?.refusal?.explanation).toBe("Harmful content");
		}
	});
	test("does not treat COMPLETED with leading field as a refusal (order-independent, no false positive)", () => {
		// P1 fix (#6150): ensure normal completion is not mistaken for refusal when property order changes
		const { events } = parseKiroApiEvents(
			'{"conversationId":"xyz123","stopReason":"COMPLETED","usage":{"inputTokens":10,"outputTokens":3}}',
		);
		// Should emit only usage event, not refusal
		const usageEvents = events.filter(e => e.type === "usage");
		expect(usageEvents).toHaveLength(1);
		const refusalEvents = events.filter(e => e.type === "refusal");
		expect(refusalEvents).toHaveLength(0);
	});
	test("records usage and detects refusal together, with leading unknown field", () => {
		// P1 fix (#6150): both usage and refusal should be recorded even with reordered properties
		const { events } = parseKiroApiEvents(
			'{"conversationId":"xyz123","stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"ILLEGAL","explanation":"Cannot assist"}},"usage":{"inputTokens":25,"outputTokens":1}}',
		);
		expect(events).toHaveLength(2);
		const refusalEvent = events.find(e => e.type === "refusal");
		const usageEvent = events.find(e => e.type === "usage");
		expect(refusalEvent?.type).toBe("refusal");
		if (refusalEvent?.type === "refusal") {
			expect(refusalEvent.data.stopReason).toBe("CONTENT_FILTERED");
			expect(refusalEvent.data.stopDetails?.refusal?.category).toBe("ILLEGAL");
		}
		expect(usageEvent?.type).toBe("usage");
		if (usageEvent?.type === "usage") {
			expect(usageEvent.data.inputTokens).toBe(25);
			expect(usageEvent.data.outputTokens).toBe(1);
		}
	});
	test("resyncs on stray opening brace before valid content event", () => {
		// Regression test for P2 id 4197329342: order-independent scanner must resync
		// when a stray '{' (from framing bytes) doesn't close, but a later '{' does.
		// Stray brace that never closes, followed by valid content event
		const input = '{framing-garbage-without-close{"content":"hello"}';
		const { events, remaining } = parseKiroApiEvents(input);

		// Should successfully parse the valid content event, skipping the stray brace
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.type).toBe("content");
		if (event?.type === "content") {
			expect(event.data).toBe("hello");
		}
		// remaining should be empty (we consumed everything)
		expect(remaining).toBe("");
	});
	test("resyncs on stray opening brace before refusal metadata event", () => {
		// Regression test for P2 id 4197329342: order-independent scanner must resync
		// when encountering stray braces from framing errors.
		// Stray brace before refusal metadata event
		const input =
			'{broken-frame{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"VIOLENCE","explanation":"Cannot assist"}}}';
		const { events, remaining } = parseKiroApiEvents(input);

		// Should successfully parse the refusal event after resyncing
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.type).toBe("refusal");
		if (event?.type === "refusal") {
			expect(event.data.stopReason).toBe("CONTENT_FILTERED");
			expect(event.data.stopDetails?.refusal?.category).toBe("VIOLENCE");
			expect(event.data.stopDetails?.refusal?.explanation).toBe("Cannot assist");
		}
		expect(remaining).toBe("");
	});
	test("bounded retention: stray brace followed by garbage beyond MAX_RESCAN_DISTANCE", () => {
		// Regression test for P2 id 4197329342 and #4199034444: bounded retention prevents infinite buffering.
		// Create a large buffer with a stray brace followed by garbage beyond the rescan limit.
		const largeGarbage = "x".repeat(70 * 1024); // 70KB > 64KB MAX_RESCAN_DISTANCE
		const input = `{broken${largeGarbage}`;
		const { events, remaining } = parseKiroApiEvents(input);

		// No valid JSON found after the stray brace (within the rescan distance),
		// so we should return only the data up to MAX_RESCAN_DISTANCE to prevent unbounded buffering.
		const MAX_RESCAN_DISTANCE = 64 * 1024; // 64KB
		expect(events).toHaveLength(0);
		expect(remaining.length).toBeLessThanOrEqual(MAX_RESCAN_DISTANCE);
		expect(remaining.length).toBeGreaterThan(0); // Still preserve some data
		// The remaining buffer will be re-parsed in the next call when new data arrives
	});
});
