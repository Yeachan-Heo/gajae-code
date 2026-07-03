import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../src/utils/idle-iterator";

/**
 * Per-provider fallback overrides on the stream-watchdog helpers.
 *
 * These are the gear that lets `google-gemini-cli` widen its first-event floor
 * beyond the 100s global default without forcing every other provider to wait
 * just as long. Tests pin the precedence contract callers depend on:
 * caller option > env var > per-provider fallback > base default.
 */

const ENV_KEYS = [
	"GJC_STREAM_IDLE_TIMEOUT_MS",
	"GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"GJC_STREAM_FIRST_EVENT_TIMEOUT_MS",
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"PI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		originalEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = originalEnv[key];
		if (prior === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = prior;
		}
	}
});

describe("getStreamIdleTimeoutMs(fallbackMs)", () => {
	it("returns the per-provider fallback when env vars are unset", () => {
		expect(getStreamIdleTimeoutMs(300_000)).toBe(300_000);
	});

	it("lets PI_STREAM_IDLE_TIMEOUT_MS override the per-provider fallback", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(42);
	});

	it("treats PI_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});

	it("lets the documented GJC_STREAM_IDLE_TIMEOUT_MS name override the per-provider fallback", () => {
		Bun.env.GJC_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(42);
	});

	it("prefers GJC_STREAM_IDLE_TIMEOUT_MS over the legacy PI_ name when both are set", () => {
		Bun.env.GJC_STREAM_IDLE_TIMEOUT_MS = "42";
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "99";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(42);
	});
});

describe("getStreamFirstEventTimeoutMs(idleTimeoutMs, fallbackMs)", () => {
	it("returns the per-provider fallback when env unset and idle timeout is undefined", () => {
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(300_000);
	});

	it("floors the first-event timeout at the per-provider fallback even when idle is shorter", () => {
		expect(getStreamFirstEventTimeoutMs(50_000, 300_000)).toBe(300_000);
	});

	it("never undershoots the steady-state idle timeout", () => {
		expect(getStreamFirstEventTimeoutMs(500_000, 300_000)).toBe(500_000);
	});

	it("lets PI_STREAM_FIRST_EVENT_TIMEOUT_MS override the per-provider fallback", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(42);
	});

	it("treats PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBeUndefined();
	});

	it("lets the documented GJC_STREAM_FIRST_EVENT_TIMEOUT_MS name override the per-provider fallback", () => {
		Bun.env.GJC_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(42);
	});

	it("falls back to the 100s global default when no fallback or env is provided", () => {
		expect(getStreamFirstEventTimeoutMs()).toBe(100_000);
	});
});
