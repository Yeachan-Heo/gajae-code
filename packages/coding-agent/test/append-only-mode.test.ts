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

describe("intent tracing sub-session gating", () => {
	function withoutFlag<T>(run: () => T): T {
		const previousFlag = Bun.env.PI_INTENT_TRACING;
		delete Bun.env.PI_INTENT_TRACING;
		try {
			return run();
		} finally {
			if (previousFlag === undefined) delete Bun.env.PI_INTENT_TRACING;
			else Bun.env.PI_INTENT_TRACING = previousFlag;
		}
	}

	it("keeps intent tracing on for every top-level surface, not just the TUI", () => {
		withoutFlag(() => {
			expect(resolveIntentTracingEnabled(true, { subSession: false })).toBe(true);
			expect(resolveIntentTracingEnabled(false, { subSession: false })).toBe(false);
			expect(resolveIntentTracingEnabled(undefined, { subSession: false })).toBe(false);
		});
	});

	it("force-omits intent tracing for canonical sub-sessions", () => {
		withoutFlag(() => {
			expect(resolveIntentTracingEnabled(true, { subSession: true })).toBe(false);
			expect(resolveIntentTracingEnabled(false, { subSession: true })).toBe(false);
		});
	});

	it("lets PI_INTENT_TRACING override an off setting without defeating the sub-session omission", () => {
		const previousFlag = Bun.env.PI_INTENT_TRACING;
		Bun.env.PI_INTENT_TRACING = "1";
		try {
			expect(resolveIntentTracingEnabled(false, { subSession: false })).toBe(true);
			expect(resolveIntentTracingEnabled(false, { subSession: true })).toBe(false);
		} finally {
			if (previousFlag === undefined) delete Bun.env.PI_INTENT_TRACING;
			else Bun.env.PI_INTENT_TRACING = previousFlag;
		}
	});
});
