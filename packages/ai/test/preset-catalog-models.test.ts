import { describe, expect, test } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";

describe("preset catalog model entries", () => {
	test("bundles kimi-code/kimi-k2.7-code", () => {
		const model = getBundledModel("kimi-code", "kimi-k2.7-code");

		expect(model.id).toBe("kimi-k2.7-code");
		expect(model.provider).toBe("kimi-code");
		expect(model.name).toBe("Kimi K2.7 Code");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});

	test("bundles zai/glm-5.2 flagship", () => {
		const model = getBundledModel("zai", "glm-5.2");

		expect(model.id).toBe("glm-5.2");
		expect(model.provider).toBe("zai");
		expect(model.name).toBe("GLM-5.2");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({ mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.XHigh });
	});

	test("bundles minimax-code/minimax-v3", () => {
		const model = getBundledModel("minimax-code", "minimax-v3");

		expect(model.id).toBe("minimax-v3");
		expect(model.provider).toBe("minimax-code");
		expect(model.name).toBe("MiniMax-V3");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(512_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});
});
