import { describe, expect, it } from "bun:test";
import { buildAbortDisplayMessage } from "@gajae-code/coding-agent/modes/utils/abort-message";

describe("buildAbortDisplayMessage", () => {
	it("keeps the legacy generic abort labels when there is no useful cause", () => {
		expect(buildAbortDisplayMessage({ errorMessage: undefined, retryAttempt: 0 })).toBe("Operation aborted");
		expect(buildAbortDisplayMessage({ errorMessage: "Request was aborted", retryAttempt: 1 })).toBe(
			"Aborted after 1 retry attempt",
		);
		expect(buildAbortDisplayMessage({ errorMessage: "Request was aborted.", retryAttempt: 2 })).toBe(
			"Aborted after 2 retry attempts",
		);
	});

	it("preserves the provider root cause after retries", () => {
		expect(buildAbortDisplayMessage({ errorMessage: "fetch failed", retryAttempt: 1 })).toBe(
			"Aborted after 1 retry attempt: fetch failed",
		);
	});

	it("adds a remediation hint for provider stream idle watchdog aborts", () => {
		expect(
			buildAbortDisplayMessage({
				errorMessage: "Anthropic stream stalled while waiting for the next event",
				retryAttempt: 1,
			}),
		).toBe(
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set GJC_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or GJC_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.",
		);
	});

	it("is idempotent for replayed abort display labels without retry context", () => {
		const formatted =
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set GJC_STREAM_IDLE_TIMEOUT_MS=300000 for slow reasoning/proxy streams, or GJC_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.";
		expect(buildAbortDisplayMessage({ errorMessage: formatted, retryAttempt: 0 })).toBe(formatted);
		expect(buildAbortDisplayMessage({ errorMessage: "Operation aborted: fetch failed", retryAttempt: 0 })).toBe(
			"Operation aborted: fetch failed",
		);
	});
});
