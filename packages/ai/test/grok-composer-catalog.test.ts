import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { isComposerHarnessModel } from "../src/providers/composer-discipline";

describe("grok composer bundled catalog", () => {
	it("bundles fast and max composer variants for xAI", () => {
		const fast = getBundledModel("xai", "grok-composer-2.5-fast");
		const max = getBundledModel("xai", "grok-composer-2.5-max");

		expect(fast?.provider).toBe("xai");
		expect(max?.provider).toBe("xai");
		expect(max?.wireModelId).toBe("grok-composer-2.5-fast");
		expect(max?.thinking).toEqual({
			mode: "effort",
			minLevel: "max",
			maxLevel: "max",
			defaultLevel: "max",
			levels: ["max"],
		});
	});

	it("treats both composer variants as harness models", () => {
		expect(isComposerHarnessModel("grok-composer-2.5-fast")).toBe(true);
		expect(isComposerHarnessModel("grok-composer-2.5-max")).toBe(true);
	});
});
