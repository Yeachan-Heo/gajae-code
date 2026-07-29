import { describe, expect, it } from "bun:test";
import { classifyProviderRetry } from "../../src/task/provider-retry-status";

describe("classifyProviderRetry", () => {
	it("classifies the canonical first-event timeout provider code before message wording", () => {
		expect(classifyProviderRetry("provider wording changed", "stream_first_event_timeout")).toBe(
			"first_event_timeout",
		);
	});

	it("retains message matching for legacy retry events without provider facts", () => {
		expect(classifyProviderRetry("Provider stream timed out while waiting for the first event")).toBe(
			"first_event_timeout",
		);
	});
});
