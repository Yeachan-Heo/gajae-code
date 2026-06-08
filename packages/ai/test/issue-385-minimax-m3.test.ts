import { describe, expect, test } from "bun:test";
import { getBundledModel } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";

const minimaxProviders = ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"] as const;

describe("MiniMax M3 support (issue #385)", () => {
	test("bundles minimax-m3 across first-class MiniMax providers", () => {
		for (const provider of minimaxProviders) {
			const model = getBundledModel(provider, "minimax-m3");

			expect(model.id).toBe("minimax-m3");
			expect(model.provider).toBe(provider);
			expect(model.contextWindow).toBe(512_000);
			expect(model.maxTokens).toBe(128_000);
			expect(model.input).toContain("text");
			expect(model.input).toContain("image");
		}
	});

	test("uses minimax-m3 as the default first-class MiniMax model", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.minimax).toBe("minimax-m3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code"]).toBe("minimax-m3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code-cn"]).toBe("minimax-m3");
	});

	test("surfaces minimax-m3 with MiniMax-M3 display casing (issue #404)", () => {
		for (const provider of minimaxProviders) {
			const model = getBundledModel(provider, "minimax-m3");
			expect(model.name).toBe("MiniMax-M3");
		}
	});
});
