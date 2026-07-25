import { describe, expect, it } from "bun:test";
import { claudeOpusGeneration, VISION_CORRECTED_CLAUDE_OPUS_GENERATIONS } from "../scripts/generate-models";
import { getBundledModels, getBundledProviders } from "../src/models";

/**
 * Every reviewed Claude Opus generation is vision-capable. Some upstream
 * catalogs omit image input (e.g. kilo/venice "-fast" entries);
 * generate-models.ts corrects these via applyClaudeOpusVisionCorrections so
 * capability advertising stays consistent across providers.
 */
function bundledOpusModels(): { qualifiedId: string; generation: number; hasImage: boolean }[] {
	const models: { qualifiedId: string; generation: number; hasImage: boolean }[] = [];
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const generation = claudeOpusGeneration(model.id);
			if (generation === undefined) continue;
			models.push({
				qualifiedId: `${provider}/${model.id}`,
				generation,
				hasImage: model.input.includes("image"),
			});
		}
	}
	return models;
}

describe("Claude Opus vision capability", () => {
	it("parses the generation out of provider-prefixed, aliased, and date-suffixed ids", () => {
		expect(claudeOpusGeneration("claude-opus-4-8")).toBe(4.8);
		expect(claudeOpusGeneration("anthropic.claude-opus-4-8")).toBe(4.8);
		expect(claudeOpusGeneration("us.anthropic.claude-opus-5")).toBe(5);
		expect(claudeOpusGeneration("claude-opus-5-fast")).toBe(5);
		expect(claudeOpusGeneration("claude-opus-45")).toBe(4.5);
		expect(claudeOpusGeneration("claude-opus-4-20250514")).toBe(4);
		// A future generation must resolve even when suffixed or date-qualified,
		// otherwise the tripwire below would silently skip it.
		expect(claudeOpusGeneration("claude-opus-6")).toBe(6);
		expect(claudeOpusGeneration("claude-opus-6-fast")).toBe(6);
		expect(claudeOpusGeneration("anthropic/claude-opus-6-1-fast")).toBe(6.1);
		expect(claudeOpusGeneration("claude-opus-6-20270101")).toBe(6);
		// A two-digit major must not be read as a compact major/minor alias.
		expect(claudeOpusGeneration("claude-opus-10")).toBe(10);
		expect(claudeOpusGeneration("claude-opus-10-fast")).toBe(10);
		expect(claudeOpusGeneration("claude-sonnet-5")).toBeUndefined();
	});

	for (const generation of VISION_CORRECTED_CLAUDE_OPUS_GENERATIONS) {
		it(`advertises image input for every bundled claude-opus-${generation} variant`, () => {
			const offenders = bundledOpusModels()
				.filter(model => model.generation === generation && !model.hasImage)
				.map(model => model.qualifiedId);
			expect(offenders).toEqual([]);
		});
	}

	// Tripwire: the allowlist is deliberately explicit rather than a
	// `claude-opus-*` prefix match, so a newer bundled generation would silently
	// bypass both the generator correction and the coverage above. Fail instead,
	// forcing the new generation to be reviewed and declared.
	it("declares the newest bundled Claude Opus generation in the correction allowlist", () => {
		const models = bundledOpusModels();
		// Guards against the check going vacuous if id parsing ever drifts.
		expect(models.length).toBeGreaterThan(0);
		const newestDeclared = Math.max(...VISION_CORRECTED_CLAUDE_OPUS_GENERATIONS);
		const undeclared = models.filter(model => model.generation > newestDeclared).map(model => model.qualifiedId);
		expect(undeclared).toEqual([]);
	});
});
