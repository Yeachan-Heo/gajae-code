import { describe, expect, it } from "bun:test";
import {
	boundedAwaitTurnTimeoutMs,
	boundedEventWatchTimeoutMs,
	boundedPollIntervalMs,
	boundedRuntimePromptAckTimeoutMs,
} from "../src/coordinator-mcp/server";

const MALFORMED = ["1e4", "5s", "1.5", "+3", "0x10", "", "abc", [50], { ms: 50 }, true, null, undefined];

describe("coordinator MCP integer arguments", () => {
	it("uses the defaults for values that are not numbers or plain digit strings", () => {
		for (const value of MALFORMED) {
			expect({
				value,
				ack: boundedRuntimePromptAckTimeoutMs(value),
				awaitTurn: boundedAwaitTurnTimeoutMs(value),
				poll: boundedPollIntervalMs(value),
				watch: boundedEventWatchTimeoutMs(value),
			}).toEqual({ value, ack: 10_000, awaitTurn: 1000, poll: 100, watch: 1000 });
		}
	});

	it("still accepts numbers and trimmed digit strings", () => {
		expect(boundedRuntimePromptAckTimeoutMs(" 2500 ")).toBe(2500);
		expect(boundedRuntimePromptAckTimeoutMs(2500)).toBe(2500);
		expect(boundedAwaitTurnTimeoutMs("4000")).toBe(4000);
		expect(boundedPollIntervalMs("50")).toBe(50);
		expect(boundedEventWatchTimeoutMs("0")).toBe(0);
		expect(boundedEventWatchTimeoutMs(0)).toBe(0);
		expect(boundedEventWatchTimeoutMs("20000")).toBe(20_000);
	});
});
