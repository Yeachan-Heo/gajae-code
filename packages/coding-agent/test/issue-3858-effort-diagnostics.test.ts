import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, enrichModelThinking } from "@gajae-code/ai/model-thinking";
import type { Model } from "@gajae-code/ai/types";
import {
	formatClampedModelSelector,
	formatSelectorWithEffortDiagnostics,
	resolveThinkingEffortResolution,
} from "../src/thinking";

function customDeepSeekProxy(): Model<"openai-completions"> {
	return enrichModelThinking({
		id: "cline-pass/deepseek-v4-flash",
		name: "DeepSeek V4 Flash via ClinePass",
		api: "openai-completions",
		provider: "clinepass",
		baseUrl: "https://api.cline.bot/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 16_384,
	});
}

describe("#3858 effort diagnostics for custom DeepSeek proxies", () => {
	it("preserves :max in clamped selectors instead of rewriting to :xhigh", () => {
		const model = customDeepSeekProxy();
		expect(formatClampedModelSelector("clinepass/cline-pass/deepseek-v4-flash:max", model)).toBe(
			"clinepass/cline-pass/deepseek-v4-flash:max",
		);
	});

	it("resolves requested max to effective max and wire max", () => {
		const model = customDeepSeekProxy();
		const resolution = resolveThinkingEffortResolution(model, ThinkingLevel.Max);
		expect(resolution).toMatchObject({
			requested: ThinkingLevel.Max,
			effective: ThinkingLevel.Max,
			clamped: false,
			wire: "max",
			wireRemapped: false,
			wireUnmapped: false,
		});
	});

	it("exposes wire=max when GJC xhigh is remapped for DeepSeek", () => {
		const model = customDeepSeekProxy();
		const resolution = resolveThinkingEffortResolution(model, ThinkingLevel.XHigh);
		expect(resolution).toMatchObject({
			requested: ThinkingLevel.XHigh,
			effective: ThinkingLevel.XHigh,
			clamped: false,
			wire: "max",
			wireRemapped: true,
			wireUnmapped: false,
		});
		expect(formatSelectorWithEffortDiagnostics("clinepass/cline-pass/deepseek-v4-flash:xhigh", model)).toBe(
			"clinepass/cline-pass/deepseek-v4-flash:xhigh (wire=max)",
		);
	});

	it("flags unmapped wire passthrough after clamp for generic openai-completions models", () => {
		const model = enrichModelThinking({
			id: "generic-reasoner",
			name: "Generic Reasoner",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		expect(model.thinking?.maxLevel).toBe(Effort.XHigh);

		const resolution = resolveThinkingEffortResolution(model, ThinkingLevel.Max);
		expect(resolution.clamped).toBe(true);
		expect(resolution.effective).toBe(ThinkingLevel.XHigh);
		expect(resolution.wire).toBe("xhigh");
		expect(resolution.wireUnmapped).toBe(true);
		expect(formatSelectorWithEffortDiagnostics("custom/generic-reasoner:max", model)).toContain("clamped max→xhigh");
		expect(formatSelectorWithEffortDiagnostics("custom/generic-reasoner:max", model)).toContain(
			"wire=xhigh (unmapped; not backend-confirmed)",
		);
	});
});
