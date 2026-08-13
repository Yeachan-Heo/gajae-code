import { describe, expect, it } from "bun:test";
import {
	resolveModels,
	supportsReasoningEffort,
} from "../src/defaults/gjc/extensions/grok-cli-vendor/src/models/catalog";
import { sanitizePayload } from "../src/defaults/gjc/extensions/grok-cli-vendor/src/payload/sanitize";

describe("Grok CLI payload sanitize", () => {
	it("strips replayed reasoning and unsupported Composer effort", () => {
		const payload = sanitizePayload(
			{
				input: [
					{ role: "system", content: "be terse" },
					{ type: "reasoning", content: "cached" },
					{ role: "user", content: "hello" },
				],
				include: ["reasoning.encrypted_content"],
				reasoning: { effort: "high" },
			},
			"grok-composer-2.5-fast",
			"session-1",
			process.cwd(),
		);
		expect(payload.input).toEqual([{ role: "user", content: "hello" }]);
		expect(payload.instructions).toBe("be terse");
		expect(payload.include).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
		expect(payload.prompt_cache_key).toBe("session-1");
	});

	it("caps Grok 4.5 and its official aliases at the documented high effort", () => {
		for (const modelId of ["grok-4.5", "grok-4.5-latest", "grok-build-latest"]) {
			const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"].map(requested => {
				const payload = sanitizePayload({ reasoning: { effort: requested } }, modelId, undefined, process.cwd());
				return (payload.reasoning as { effort: string }).effort;
			});

			expect(efforts).toEqual(["low", "low", "medium", "high", "high", "high"]);
		}
	});

	it("keeps xhigh for Grok 4.6 and its aliases", () => {
		for (const modelId of ["grok-4.6", "grok-4.6-latest"]) {
			const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"].map(requested => {
				const payload = sanitizePayload({ reasoning: { effort: requested } }, modelId, undefined, process.cwd());
				return (payload.reasoning as { effort: string }).effort;
			});

			expect(efforts).toEqual(["low", "low", "medium", "high", "xhigh", "xhigh"]);
		}
	});

	it("accepts valid hyphenated variants and rejects collisions or malformed suffixes", () => {
		for (const modelId of ["grok-4.5-preview", "grok-4.6-preview"]) {
			expect(supportsReasoningEffort(modelId)).toBe(true);
			expect(
				sanitizePayload({ reasoning: { effort: "high" } }, modelId, undefined, process.cwd()).reasoning,
			).toEqual({
				effort: "high",
			});
		}

		for (const modelId of [
			"grok-4.60",
			"grok-4.5-",
			"grok-4.6-",
			"grok-4.6--preview",
			"grok-4.6-preview--fast",
			"grok-4.6- preview",
			"grok-4.6-preview_fast",
			"grok-4.6-preview.fast",
			"ungrok-4.6",
		]) {
			expect(supportsReasoningEffort(modelId)).toBe(false);
			expect(
				sanitizePayload({ reasoning: { effort: "high" } }, modelId, undefined, process.cwd()).reasoning,
			).toBeUndefined();
		}
	});
});

describe("Grok CLI model catalog", () => {
	it("lists grok-4.6 with the documented context window and pricing", () => {
		const model = resolveModels().find(entry => entry.id === "grok-4.6");

		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.contextWindow).toBe(500_000);
		expect(model?.cost).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
	});

	it("keeps grok-4.5 listed alongside grok-4.6", () => {
		const ids = resolveModels().map(entry => entry.id);

		expect(ids).toContain("grok-4.5");
		expect(ids).toContain("grok-4.6");
	});
});
