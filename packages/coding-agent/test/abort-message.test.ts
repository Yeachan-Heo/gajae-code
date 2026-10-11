import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildAbortDisplayMessage } from "@gajae-code/coding-agent/modes/utils/abort-message";

const IDLE_ENV_KEYS = [
	"GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of IDLE_ENV_KEYS) {
		originalEnv.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of IDLE_ENV_KEYS) {
		const prior = originalEnv.get(key);
		if (prior === undefined) delete Bun.env[key];
		else Bun.env[key] = prior;
	}
});

const ANTHROPIC_STALL = "Anthropic stream stalled while waiting for the next event";

function suggestedIdleTimeoutMs(message: string): number {
	const match = /Hint: set PI_STREAM_IDLE_TIMEOUT_MS=(\d+) /.exec(message);
	if (!match) throw new Error(`no idle-timeout hint in: ${message}`);
	return Number(match[1]);
}

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
		expect(buildAbortDisplayMessage({ errorMessage: ANTHROPIC_STALL, retryAttempt: 1 })).toBe(
			`Aborted after 1 retry attempt: ${ANTHROPIC_STALL}. Hint: set PI_STREAM_IDLE_TIMEOUT_MS=1200000 for slow reasoning/proxy streams, or PI_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.`,
		);
	});

	it("suggests a window longer than the 600s Anthropic default that just elapsed", () => {
		const message = buildAbortDisplayMessage({ errorMessage: ANTHROPIC_STALL, retryAttempt: 0 });
		expect(suggestedIdleTimeoutMs(message)).toBeGreaterThan(600_000);
	});

	it("suggests a window longer than an already-raised override", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "900000";
		const message = buildAbortDisplayMessage({ errorMessage: ANTHROPIC_STALL, retryAttempt: 0 });
		expect(suggestedIdleTimeoutMs(message)).toBe(1_800_000);
	});

	it("honors the GJC-prefixed override ahead of PI_STREAM_IDLE_TIMEOUT_MS", () => {
		Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "1200000";
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "900000";
		const message = buildAbortDisplayMessage({ errorMessage: ANTHROPIC_STALL, retryAttempt: 0 });
		expect(suggestedIdleTimeoutMs(message)).toBe(2_400_000);
	});

	it("never suggests less than the provider default when the override is lower", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "60000";
		const message = buildAbortDisplayMessage({
			errorMessage: "OpenAI responses stream stalled while waiting for the next event",
			retryAttempt: 0,
		});
		expect(suggestedIdleTimeoutMs(message)).toBe(1_200_000);
	});

	it("is idempotent for replayed abort display labels without retry context", () => {
		const formatted = `Aborted after 1 retry attempt: ${ANTHROPIC_STALL}. Hint: set PI_STREAM_IDLE_TIMEOUT_MS=1200000 for slow reasoning/proxy streams, or PI_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.`;
		expect(buildAbortDisplayMessage({ errorMessage: formatted, retryAttempt: 0 })).toBe(formatted);
		expect(buildAbortDisplayMessage({ errorMessage: "Operation aborted: fetch failed", retryAttempt: 0 })).toBe(
			"Operation aborted: fetch failed",
		);
	});
});
