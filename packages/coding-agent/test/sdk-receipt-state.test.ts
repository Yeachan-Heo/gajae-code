import { describe, expect, it } from "bun:test";
import { reduceTerminalReceiptState } from "../src/sdk/receipt-state";

describe("terminal receipt state", () => {
	it("classifies completed execution with reportable output as present", () => {
		expect(reduceTerminalReceiptState({ execution: "completed", reportable: true })).toEqual({
			execution: "terminal_ok",
			receipt: "present",
		});
	});

	it("fails closed for completed execution with empty output", () => {
		expect(reduceTerminalReceiptState({ execution: "completed", reportable: false })).toEqual({
			execution: "terminal_ok",
			receipt: "missing",
		});
	});

	it("preserves failure and cancellation execution meaning", () => {
		expect(reduceTerminalReceiptState({ execution: "failed", reportable: false })).toEqual({
			execution: "failed",
			receipt: "absent",
		});
		expect(reduceTerminalReceiptState({ execution: "cancelled", reportable: false })).toEqual({
			execution: "cancelled",
			receipt: "absent",
		});
	});

	it("keeps unknown state conservative", () => {
		expect(reduceTerminalReceiptState({ execution: "unknown", reportable: true })).toEqual({
			execution: "unknown",
			receipt: "unknown",
		});
	});
});
