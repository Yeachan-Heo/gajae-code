import { describe, expect, test } from "bun:test";
import { getBundledModel } from "../src/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "../src/provider-models/descriptors";

const minimaxProviders = ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"] as const;
const anthropicMinimaxProviders = ["minimax", "minimax-cn"] as const;

describe("MiniMax M3 support (issue #385)", () => {
	test("bundles canonical MiniMax-M3 across first-class MiniMax providers", () => {
		for (const provider of minimaxProviders) {
			const model = getBundledModel(provider, "MiniMax-M3");

			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M3");
			expect(model.provider).toBe(provider);
			expect(model.name).toBe("MiniMax-M3");
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
			expect(model.input).toContain("text");
			expect(model.input).toContain("image");
		}
	});

	test("does not bundle stale lowercase minimax-m3 aliases next to MiniMax-M3 (issue #3896)", () => {
		for (const provider of minimaxProviders) {
			expect(getBundledModel(provider, "minimax-m3")).toBeUndefined();
		}
	});

	test("uses canonical MiniMax-M3 as the default first-class MiniMax model (issue #3896)", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER.minimax).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code"]).toBe("MiniMax-M3");
		expect(DEFAULT_MODEL_PER_PROVIDER["minimax-code-cn"]).toBe("MiniMax-M3");
	});

	test("bundles the Anthropic Token Plan MiniMax-M3[1m] id on Anthropic routes with 1M context (issue #3896)", () => {
		for (const provider of anthropicMinimaxProviders) {
			const model = getBundledModel(provider, "MiniMax-M3[1m]");

			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M3[1m]");
			expect(model.provider).toBe(provider);
			expect(model.api).toBe("anthropic-messages");
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
		}
	});

	test("does not widen unrelated MiniMax catalog aliases (issue #3896)", () => {
		// minimax-v3 was a stale/non-official first-class id and must stay gone.
		expect(getBundledModel("minimax-code", "minimax-v3")).toBeUndefined();
		// Unrelated catalog providers keep their own lowercase minimax-m3 contract.
		expect(getBundledModel("opencode-zen", "minimax-m3")?.contextWindow).toBe(512_000);
	});
});
