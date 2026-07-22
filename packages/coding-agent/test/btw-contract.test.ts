import { describe, expect, it } from "bun:test";
import {
	BTW_MAX_ANSWER_UTF8_BYTES,
	BTW_MAX_CONTEXT_TURNS,
	BTW_MAX_CONTEXT_UTF8_BYTES,
	BTW_MAX_ERROR_UTF8_BYTES,
	boundBtwExchanges,
	exchangeUtf8Bytes,
	sanitizeBtwError,
	truncateUtf8,
	utf8ByteLength,
} from "@gajae-code/coding-agent/session/btw-contract";

describe("/btw bounded text contract", () => {
	it("keeps exact-boundary Unicode and truncates one byte over without splitting a scalar", () => {
		const exact = "a".repeat(BTW_MAX_ANSWER_UTF8_BYTES);
		expect(truncateUtf8(exact, BTW_MAX_ANSWER_UTF8_BYTES)).toBe(exact);
		const over = `${"a".repeat(BTW_MAX_ANSWER_UTF8_BYTES - 1)}한`;
		const bounded = truncateUtf8(over, BTW_MAX_ANSWER_UTF8_BYTES);
		expect(utf8ByteLength(bounded)).toBe(BTW_MAX_ANSWER_UTF8_BYTES - 1);
		expect(bounded.endsWith("�")).toBe(false);
	});

	it("evicts oldest exchanges deterministically by turn and aggregate byte limits", () => {
		const exchanges = Array.from({ length: BTW_MAX_CONTEXT_TURNS + 2 }, (_, index) => ({
			question: `q${index}`,
			answer: "a",
		}));
		const bounded = boundBtwExchanges(exchanges);
		expect(bounded).toHaveLength(BTW_MAX_CONTEXT_TURNS);
		expect(bounded[0]?.question).toBe("q2");
		expect(bounded.reduce((total, exchange) => total + exchangeUtf8Bytes(exchange), 0)).toBeLessThanOrEqual(
			BTW_MAX_CONTEXT_UTF8_BYTES,
		);
	});
	it("sanitizes controls and bounds provider errors by UTF-8 bytes", () => {
		const bounded = sanitizeBtwError(`provider\u0000\u202E${"한".repeat(BTW_MAX_ERROR_UTF8_BYTES)}`);
		expect(bounded).not.toContain("\u0000");
		expect(bounded).not.toContain("\u202E");
		expect(bounded.endsWith("�")).toBe(false);
		expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(BTW_MAX_ERROR_UTF8_BYTES);
	});
});
