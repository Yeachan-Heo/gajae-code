import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { type Api, Effort, type Model } from "@gajae-code/ai";
import { projectQ10Models } from "../src/sdk/models.js";

const thinking = {
	mode: "effort",
	minLevel: Effort.Low,
	maxLevel: Effort.High,
	levels: [Effort.Low, Effort.Medium, Effort.High],
	defaultLevel: Effort.Medium,
};

function model(overrides: Record<string, unknown> = {}): Model<Api> {
	return {
		provider: "test",
		id: "reasoning",
		name: "Reasoning model",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinking,
		input: ["text"],
		output: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>;
}

function invalid(reason: string, descriptor: Record<string, unknown> | undefined = thinking): Model<Api> {
	return model({ thinking: reason === "missing_thinking" ? undefined : descriptor });
}

describe("Q10 model projection", () => {
	it("projects the exact public rows without leaking model internals", () => {
		const source = model({
			thinking: { ...thinking, levels: [Effort.Low, Effort.Medium, Effort.High] },
			apiKey: "secret",
			baseUrl: "https://private.invalid",
		});
		const plain = model({
			id: "plain",
			name: "Plain model",
			reasoning: false,
			thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
		});

		const rows = projectQ10Models({
			models: [source, plain],
			currentModel: { provider: "test", id: "reasoning" } as Model<Api>,
			currentThinkingLevel: ThinkingLevel.Inherit,
		});

		expect(rows).toEqual([
			{
				provider: "test",
				id: "reasoning",
				name: "Reasoning model",
				contextWindow: 128_000,
				maxTokens: 8_192,
				reasoning: true,
				thinking: {
					validLevels: [ThinkingLevel.Off, Effort.Low, Effort.Medium, Effort.High],
					minLevel: Effort.Low,
					maxLevel: Effort.High,
					mode: "effort",
					levels: [Effort.Low, Effort.Medium, Effort.High],
					defaultLevel: Effort.Medium,
				},
				current: true,
				currentThinkingLevel: ThinkingLevel.Inherit,
			},
			{
				provider: "test",
				id: "plain",
				name: "Plain model",
				contextWindow: 128_000,
				maxTokens: 8_192,
				reasoning: false,
				thinking: { validLevels: [ThinkingLevel.Off] },
				current: false,
			},
		]);
		expect(rows[0]?.thinking.levels).not.toBe(source.thinking?.levels);
		expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
			"contextWindow",
			"current",
			"currentThinkingLevel",
			"id",
			"maxTokens",
			"name",
			"provider",
			"reasoning",
			"thinking",
		]);
	});

	it("does not annotate a non-current row or an undefined current thinking level", () => {
		const source = model();
		expect(
			projectQ10Models({
				models: [source],
				currentModel: { provider: "other", id: "reasoning" } as Model<Api>,
				currentThinkingLevel: ThinkingLevel.High,
			})[0],
		).toEqual(expect.objectContaining({ current: false }));
		expect(projectQ10Models({ models: [source], currentModel: source })[0]).not.toHaveProperty(
			"currentThinkingLevel",
		);
	});

	it.each([
		["missing_thinking", undefined],
		["unknown_min_level", { ...thinking, minLevel: "invalid" }],
		["unknown_max_level", { ...thinking, maxLevel: "invalid" }],
		["inverted_range", { ...thinking, minLevel: Effort.High, maxLevel: Effort.Low }],
		["unknown_mode", { ...thinking, mode: "invalid" }],
		["empty_levels", { ...thinking, levels: [] }],
		["unknown_level", { ...thinking, levels: [Effort.Low, "invalid", Effort.High] }],
		["level_out_of_range", { ...thinking, levels: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] }],
		["lower_bound_mismatch", { ...thinking, levels: [Effort.Medium, Effort.High] }],
		["upper_bound_mismatch", { ...thinking, levels: [Effort.Low, Effort.Medium] }],
		["unknown_default_level", { ...thinking, defaultLevel: "invalid" }],
		["default_not_supported", { ...thinking, defaultLevel: Effort.Minimal }],
	] as const)("returns a safe internal error for %s", (reason, descriptor) => {
		expect(() => projectQ10Models({ models: [invalid(reason, descriptor)] })).toThrow(
			`Invalid thinking metadata for test/reasoning: ${reason}`,
		);
		try {
			projectQ10Models({ models: [invalid(reason, descriptor)] });
		} catch (error) {
			expect(error).toMatchObject({ code: "internal" });
		}
	});

	it.each([
		["empty_supported_levels", []],
		["supported_membership_mismatch", [Effort.Low, Effort.Medium]],
	] as const)("returns a safe internal error for defensive %s invariants", (reason, supported) => {
		expect(() =>
			projectQ10Models({
				models: [model()],
				resolveSupportedEfforts: () => supported,
			}),
		).toThrow(`Invalid thinking metadata for test/reasoning: ${reason}`);
	});
});
