import { describe, expect, test } from "bun:test";
import { receiptStateForTerminal, reportableReceipt } from "../src/sdk/receipt-state";

describe("SDK receipt state", () => {
	for (const [name, value] of [
		["null", { text: null, artifactPath: null }],
		["empty", { text: "", artifactPath: "" }],
		["whitespace", { text: " \n\t", artifactPath: "  " }],
	] as const) {
		test(`${name} output is missing`, () => {
			expect(reportableReceipt(value)).toBe(false);
			expect(receiptStateForTerminal(value)).toBe("missing");
		});
	}

	test("non-empty text is present", () => {
		const value = { text: "done", artifactPath: null };
		expect(reportableReceipt(value)).toBe(true);
		expect(receiptStateForTerminal(value)).toBe("present");
	});

	test("non-empty artifact path is present", () => {
		const value = { text: null, artifactPath: " /tmp/receipt.txt " };
		expect(reportableReceipt(value)).toBe(true);
		expect(receiptStateForTerminal(value)).toBe("present");
	});

	test("partial failed output remains a present receipt", () => {
		expect(receiptStateForTerminal({ text: "partial output", artifactPath: null })).toBe("present");
	});
});
