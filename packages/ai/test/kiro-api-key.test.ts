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
});
