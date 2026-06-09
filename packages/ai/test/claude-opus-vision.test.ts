import { describe, expect, it } from "bun:test";
import { getBundledModels, getBundledProviders } from "../src/models";

/**
 * Every Claude Opus 4.8 variant is vision-capable. Some upstream catalogs omit
 * image input (e.g. kilo/venice "-fast" entries); generate-models.ts corrects
 * these via applyClaudeOpusVisionCorrections so capability advertising stays
 * consistent across providers.
 */
describe("Claude Opus 4.8 vision capability", () => {
	it("advertises image input for every bundled claude-opus-4.8 variant", () => {
		const offenders: string[] = [];
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider)) {
				const normalizedId = model.id.toLowerCase().replace(/\./g, "-");
				if (!normalizedId.includes("claude-opus-4-8")) continue;
				if (!model.input.includes("image")) {
					offenders.push(`${provider}/${model.id}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
