import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getOpenAIStreamIdleTimeoutMs,
	getProviderFirstEventTimeoutFallbackMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	resolveOpenAISdkRequestTimeoutMs,
} from "../src/utils/idle-iterator";

/**
 * Per-provider fallback overrides on the stream-watchdog helpers.
 *
 * These helpers let selected slow-first-token providers widen their first-event
 * floor beyond the 100s global default without forcing every provider to wait
 * just as long. Tests pin the precedence contract callers depend on:
 * caller option > env var > per-provider fallback > base default.
 */

const ENV_KEYS = [
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
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

describe("getProviderFirstEventTimeoutFallbackMs(provider)", () => {
	it("gives Alibaba Token Plan one continuous 600-second first-event window", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("alibaba-token-plan")).toBe(600_000);
	});

	it("gives Kimi Code one continuous 300-second first-event window", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("kimi-code")).toBe(300_000);
	});

	it("does not widen unrelated providers", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("anthropic")).toBeUndefined();
	});
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

	it("honors the documented GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS override", () => {
		Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "77";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(77);
	});

	it("resolves GJC-first: GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS wins over legacy PI_STREAM_IDLE_TIMEOUT_MS", () => {
		Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "77";
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(77);
	});

	it("treats GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});
});

describe("getOpenAIStreamIdleTimeoutMs()", () => {
	it("honors the documented GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS first", () => {
		Bun.env.GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "88";
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(88);
	});

	it("falls back to the legacy PI_OPENAI_STREAM_IDLE_TIMEOUT_MS alias", () => {
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(42);
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

	it("falls back to the 100s global default when no fallback or env is provided", () => {
		expect(getStreamFirstEventTimeoutMs()).toBe(100_000);
	});
});

describe("resolveOpenAISdkRequestTimeoutMs(provider, override)", () => {
	it("uses the Alibaba 600s fallback when neither env nor caller pins a value", () => {
		expect(resolveOpenAISdkRequestTimeoutMs("alibaba-token-plan")).toBe(600_000);
	});

	it("honors an explicit shorter Alibaba override for pre-headers setup", () => {
		expect(resolveOpenAISdkRequestTimeoutMs("alibaba-token-plan", 5_000)).toBe(5_000);
	});

	it("floors non-fallback providers at the shared first-event window", () => {
		expect(resolveOpenAISdkRequestTimeoutMs("openai", 5_000)).toBe(120_000);
	});

	it("disables the SDK request timeout when the first-event watchdog is explicitly off", () => {
		expect(resolveOpenAISdkRequestTimeoutMs("openai", 0)).toBeUndefined();
		expect(resolveOpenAISdkRequestTimeoutMs("alibaba-token-plan", 0)).toBeUndefined();
	});

	it("lets PI_STREAM_FIRST_EVENT_TIMEOUT_MS pin Azure setup bounds", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "5000";
		expect(resolveOpenAISdkRequestTimeoutMs("azure")).toBe(5_000);
	});
});
