import { describe, expect, test } from "bun:test";
import {
	type AvailableModelLite,
	buildMenuModelOptions,
	DEFAULT_MENU_MODELS,
} from "../src/extensibility/extensions/menu-model-options";

const ALL_DEFAULTS: AvailableModelLite[] = DEFAULT_MENU_MODELS.map(m => ({ ref: m.ref, label: m.ref }));

describe("buildMenuModelOptions defaults", () => {
	test("offers the four curated default models with friendly labels", () => {
		const options = buildMenuModelOptions({ available: ALL_DEFAULTS });
		expect(options.map(o => o.ref)).toEqual([
			"anthropic/claude-opus-4-8",
			"openai-codex/gpt-5.5",
			"opencode-go/glm-5.2",
			"cursor/composer-2.5",
		]);
		expect(options.map(o => o.label)).toEqual(["claude-opus-4-8", "gpt-5.5", "glm-5.2", "composer-2.5"]);
		expect(options.some(o => o.current)).toBe(false);
	});

	test("pins the current model first and marks it, without duplicating it among defaults", () => {
		const options = buildMenuModelOptions({ available: ALL_DEFAULTS, currentRef: "openai-codex/gpt-5.5" });
		expect(options[0]).toEqual({ ref: "openai-codex/gpt-5.5", label: "gpt-5.5", current: true });
		expect(options.filter(o => o.ref === "openai-codex/gpt-5.5")).toHaveLength(1);
		// all four defaults still present
		expect(new Set(options.map(o => o.ref)).size).toBe(4);
	});

	test("only shows defaults that are actually available", () => {
		const available: AvailableModelLite[] = [
			{ ref: "anthropic/claude-opus-4-8", label: "anthropic/claude-opus-4-8" },
			{ ref: "cursor/composer-2.5", label: "cursor/composer-2.5" },
		];
		const options = buildMenuModelOptions({ available });
		expect(options.map(o => o.ref)).toEqual(["anthropic/claude-opus-4-8", "cursor/composer-2.5"]);
	});

	test("appends recent-usage models after the defaults, deduped", () => {
		const available: AvailableModelLite[] = [...ALL_DEFAULTS, { ref: "other/model-x", label: "model-x" }];
		const options = buildMenuModelOptions({
			available,
			mruRefs: ["other/model-x", "openai-codex/gpt-5.5"],
		});
		expect(options.map(o => o.ref)).toContain("other/model-x");
		// gpt-5.5 already present as a default, not duplicated by MRU
		expect(options.filter(o => o.ref === "openai-codex/gpt-5.5")).toHaveLength(1);
		// defaults come before the extra MRU-only model
		expect(options.findIndex(o => o.ref === "cursor/composer-2.5")).toBeLessThan(
			options.findIndex(o => o.ref === "other/model-x"),
		);
	});

	test("caps the number of options", () => {
		const many: AvailableModelLite[] = Array.from({ length: 20 }, (_, i) => ({
			ref: `p/m${i}`,
			label: `m${i}`,
		}));
		const options = buildMenuModelOptions({
			available: [...ALL_DEFAULTS, ...many],
			mruRefs: many.map(m => m.ref),
			max: 6,
		});
		expect(options).toHaveLength(6);
	});

	test("ignores an unavailable current ref", () => {
		const options = buildMenuModelOptions({ available: ALL_DEFAULTS, currentRef: "nope/missing" });
		expect(options.some(o => o.current)).toBe(false);
		expect(options).toHaveLength(4);
	});
});
