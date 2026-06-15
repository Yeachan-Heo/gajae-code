import { afterEach, describe, expect, it } from "bun:test";
import { normalizeResponsesToolCallId, resolveCacheRetention } from "../src/utils";

const originalGjcCacheRetention = Bun.env.GJC_CACHE_RETENTION;
const originalPiCacheRetention = Bun.env.PI_CACHE_RETENTION;

afterEach(() => {
	if (originalGjcCacheRetention === undefined) {
		delete Bun.env.GJC_CACHE_RETENTION;
	} else {
		Bun.env.GJC_CACHE_RETENTION = originalGjcCacheRetention;
	}
	if (originalPiCacheRetention === undefined) {
		delete Bun.env.PI_CACHE_RETENTION;
	} else {
		Bun.env.PI_CACHE_RETENTION = originalPiCacheRetention;
	}
});

describe("normalizeResponsesToolCallId", () => {
	it("preserves existing item prefix when truncating oversized ids", () => {
		const callId = `call_${"a".repeat(80)}`;
		const itemId = `fcr_${"b".repeat(120)}`;

		const normalized = normalizeResponsesToolCallId(`${callId}|${itemId}`);

		expect(normalized.callId.startsWith("call_")).toBe(true);
		expect(normalized.callId.length).toBeLessThanOrEqual(64);
		expect(normalized.itemId.startsWith("fcr_")).toBe(true);
		expect(normalized.itemId.length).toBeLessThanOrEqual(64);
	});

	it("keeps valid responses item ids unchanged", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|fcr_12345");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId).toBe("fcr_12345");
	});

	it("uses fc-prefixed item id for single-part tool call ids", () => {
		const normalized = normalizeResponsesToolCallId("call_gemini_123");

		expect(normalized.callId.startsWith("call_")).toBe(true);
		expect(normalized.itemId.startsWith("fc_")).toBe(true);
		expect(normalized.itemId).not.toStartWith("item_");
	});

	it("rehashes non-fc item ids to fc-prefixed ids", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|item_legacy");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("fc_")).toBe(true);
		expect(normalized.itemId).not.toBe("item_legacy");
	});

	it("rehashes item ids without explicit prefixes to fc-prefixed ids by default", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|legacy");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("fc_")).toBe(true);
		expect(normalized.itemId).not.toBe("legacy");
	});

	it("preserves ctc-prefixed item ids for custom tool calls", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|ctc_12345", "ctc");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId).toBe("ctc_12345");
	});

	it("rehashes non-ctc item ids to ctc-prefixed ids for custom tool calls", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|fc_legacy", "ctc");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("ctc_")).toBe(true);
		expect(normalized.itemId).not.toBe("fc_legacy");
	});

	it("rehashes custom item ids without explicit ctc prefixes to ctc-prefixed ids", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|legacy", "ctc");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("ctc_")).toBe(true);
		expect(normalized.itemId).not.toBe("legacy");
	});
});

describe("resolveCacheRetention", () => {
	it("uses documented GJC_CACHE_RETENTION for long retention", () => {
		Bun.env.GJC_CACHE_RETENTION = "long";
		delete Bun.env.PI_CACHE_RETENTION;

		expect(resolveCacheRetention()).toBe("long");
	});

	it("prefers explicit cache retention over environment defaults", () => {
		Bun.env.GJC_CACHE_RETENTION = "long";
		Bun.env.PI_CACHE_RETENTION = "long";

		expect(resolveCacheRetention("none")).toBe("none");
	});

	it("falls back to legacy PI_CACHE_RETENTION when documented env is unset", () => {
		delete Bun.env.GJC_CACHE_RETENTION;
		Bun.env.PI_CACHE_RETENTION = "long";

		expect(resolveCacheRetention()).toBe("long");
	});

	it("prefers GJC_CACHE_RETENTION over legacy PI_CACHE_RETENTION", () => {
		Bun.env.GJC_CACHE_RETENTION = "short";
		Bun.env.PI_CACHE_RETENTION = "long";

		expect(resolveCacheRetention()).toBe("short");
	});

	it("returns the provided fallback when no request value or env override is set", () => {
		delete Bun.env.GJC_CACHE_RETENTION;
		delete Bun.env.PI_CACHE_RETENTION;

		expect(resolveCacheRetention()).toBe("short");
		expect(resolveCacheRetention(undefined, "long")).toBe("long");
	});

	it("lets an explicit request value win over the fallback", () => {
		delete Bun.env.GJC_CACHE_RETENTION;
		delete Bun.env.PI_CACHE_RETENTION;

		expect(resolveCacheRetention("short", "long")).toBe("short");
		expect(resolveCacheRetention("none", "long")).toBe("none");
	});

	it("lets env overrides win over the fallback", () => {
		Bun.env.GJC_CACHE_RETENTION = "short";
		delete Bun.env.PI_CACHE_RETENTION;
		expect(resolveCacheRetention(undefined, "long")).toBe("short");

		delete Bun.env.GJC_CACHE_RETENTION;
		Bun.env.PI_CACHE_RETENTION = "short";
		expect(resolveCacheRetention(undefined, "long")).toBe("short");
	});
});
