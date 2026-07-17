import { describe, expect, it } from "bun:test";
import {
	providerSupportsAppendOnlyAuto,
	resolveAppendOnlyMode,
	resolveIntentTracingEnabled,
} from "@gajae-code/coding-agent/sdk";

describe("append-only auto allowlist", () => {
	it("auto-enables for DeepSeek and direct Anthropic only", () => {
		expect(providerSupportsAppendOnlyAuto("deepseek")).toBe(true);
		expect(providerSupportsAppendOnlyAuto("anthropic")).toBe(true);
		for (const provider of ["openai", "openrouter", "gemini", "google", "xai", "groq", "bedrock", ""]) {
			expect(providerSupportsAppendOnlyAuto(provider)).toBe(false);
		}
	});

	it("does not auto-enable for case or whitespace variants", () => {
		for (const provider of ["Anthropic", "DEEPSEEK", " anthropic", "anthropic "]) {
			expect(providerSupportsAppendOnlyAuto(provider)).toBe(false);
			expect(resolveAppendOnlyMode("auto", provider)).toBe(false);
			expect(resolveAppendOnlyMode(undefined, provider)).toBe(false);
		}
	});

	it("resolveAppendOnlyMode auto matches the allowlist", () => {
		expect(resolveAppendOnlyMode("auto", "deepseek")).toBe(true);
		expect(resolveAppendOnlyMode("auto", "anthropic")).toBe(true);
		expect(resolveAppendOnlyMode("auto", "openai")).toBe(false);
		expect(resolveAppendOnlyMode("auto", "openrouter")).toBe(false);
		expect(resolveAppendOnlyMode("auto", "gemini")).toBe(false);
		// default (undefined) behaves as auto
		expect(resolveAppendOnlyMode(undefined, "anthropic")).toBe(true);
		expect(resolveAppendOnlyMode(undefined, "openai")).toBe(false);
	});

	it("explicit on/off override the auto allowlist", () => {
		expect(resolveAppendOnlyMode("on", "openrouter")).toBe(true);
		expect(resolveAppendOnlyMode("off", "deepseek")).toBe(false);
	});

	it("on enables and off disables for every provider", () => {
		for (const provider of ["deepseek", "anthropic", "openai", "openrouter", "gemini"]) {
			expect(resolveAppendOnlyMode("on", provider)).toBe(true);
			expect(resolveAppendOnlyMode("off", provider)).toBe(false);
		}
	});
});

describe("intent tracing UI gating", () => {
	it("force-omits intent tracing without UI and keeps it enabled with UI", () => {
		const previousFlag = Bun.env.PI_INTENT_TRACING;
		try {
			delete Bun.env.PI_INTENT_TRACING;
			expect(resolveIntentTracingEnabled(true, false)).toBe(false);
			expect(resolveIntentTracingEnabled(true, true)).toBe(true);
			expect(resolveIntentTracingEnabled(false, true)).toBe(false);
			expect(resolveIntentTracingEnabled(undefined, true)).toBe(false);

			Bun.env.PI_INTENT_TRACING = "1";
			expect(resolveIntentTracingEnabled(false, false)).toBe(false);
			expect(resolveIntentTracingEnabled(false, true)).toBe(true);
		} finally {
			if (previousFlag === undefined) {
				delete Bun.env.PI_INTENT_TRACING;
			} else {
				Bun.env.PI_INTENT_TRACING = previousFlag;
			}
		}
	});
});
