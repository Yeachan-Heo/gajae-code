import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getOpenAIStreamIdleTimeoutMs,
	getProviderFirstEventTimeoutFallbackMs,
	getProviderStreamIdleTimeoutFallbackMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	resolveAnthropicSdkRequestTimeoutMs,
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

describe("getProviderStreamIdleTimeoutFallbackMs(provider)", () => {
	it("gives Anthropic a 300-second idle window for long reasoning gaps", () => {
		expect(getProviderStreamIdleTimeoutFallbackMs("anthropic")).toBe(300_000);
	});

	it("gives xAI Grok and Grok Build the same 300-second idle window as Anthropic", () => {
		expect(getProviderStreamIdleTimeoutFallbackMs("xai")).toBe(300_000);
		expect(getProviderStreamIdleTimeoutFallbackMs("grok-build")).toBe(300_000);
	});

	it("does not widen unrelated providers", () => {
		expect(getProviderStreamIdleTimeoutFallbackMs("kimi-code")).toBeUndefined();
		expect(getProviderStreamIdleTimeoutFallbackMs("openai")).toBeUndefined();
	});
});
describe("getProviderFirstEventTimeoutFallbackMs(provider)", () => {
	it("gives Alibaba Token Plan one continuous 600-second first-event window", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("alibaba-token-plan")).toBe(600_000);
	});

	it("gives Kimi Code one continuous 300-second first-event window", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("kimi-code")).toBe(300_000);
	});

	it("gives Ollama Cloud a 300-second first-event window for hosted cold starts", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("ollama-cloud")).toBe(300_000);
	});

	it("gives LM Studio a 300-second first-event window for local model startup", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("lm-studio")).toBe(300_000);
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
	it("widens the default idle window for xAI and Grok Build without an env override", () => {
		expect(getOpenAIStreamIdleTimeoutMs("xai")).toBe(300_000);
		expect(getOpenAIStreamIdleTimeoutMs("grok-build")).toBe(300_000);
		expect(getOpenAIStreamIdleTimeoutMs("openai")).toBe(120_000);
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(120_000);
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

	it("uses the LM Studio 300s fallback for slow local request setup", () => {
		expect(resolveOpenAISdkRequestTimeoutMs("lm-studio")).toBe(300_000);
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

describe("resolveAnthropicSdkRequestTimeoutMs(provider, override, idleOverride)", () => {
	it("bounds the Anthropic connect/headers phase at the 300s idle-floored first-event window", () => {
		// The Anthropic first-event watchdog arms only after headers arrive, so
		// without an SDK timeout a connection that dies before headers hangs for
		// the SDK's 10-minute default per attempt times its internal retries —
		// the "stuck after a completed tool call" spinner.
		expect(resolveAnthropicSdkRequestTimeoutMs("anthropic")).toBe(300_000);
	});

	it("floors an explicit short first-event override at the env/default window", () => {
		expect(resolveAnthropicSdkRequestTimeoutMs("anthropic", 5_000)).toBe(300_000);
	});

	it("lets a longer explicit first-event override widen the setup bound", () => {
		expect(resolveAnthropicSdkRequestTimeoutMs("anthropic", 900_000)).toBe(900_000);
	});

	it("tracks a caller idle-timeout override through the first-event floor", () => {
		expect(resolveAnthropicSdkRequestTimeoutMs("anthropic", undefined, 500_000)).toBe(500_000);
	});

	it("disables the SDK request timeout when the first-event watchdog is explicitly off", () => {
		expect(resolveAnthropicSdkRequestTimeoutMs("anthropic", 0)).toBeUndefined();
	});

	it("lets PI_STREAM_FIRST_EVENT_TIMEOUT_MS pin the setup bound", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "5000";
		expect(resolveAnthropicSdkRequestTimeoutMs("anthropic")).toBe(5_000);
	});

	it("uses the 120s idle-floored default for non-Anthropic providers on this API", () => {
		expect(resolveAnthropicSdkRequestTimeoutMs("zai")).toBe(120_000);
	});
});
