import { describe, expect, it } from "bun:test";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { DEFAULT_MODEL_PER_PROVIDER } from "@gajae-code/ai/provider-models";

describe("OpenAI Codex defaults", () => {
	it("pins provider default to GPT-5.5", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER["openai-codex"]).toBe("gpt-5.5");
	});

	it("represents GPT-5.5 as the xhigh default effort", () => {
		const model = getBundledModel("openai-codex", "gpt-5.5");

		expect(model.thinking).toMatchObject({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
			defaultLevel: Effort.XHigh,
		});
		// GPT-5.5/Codex 5.5 is a 1M-context model; keep the bundled metadata aligned
		// with the active runtime policy so status/compaction surfaces do not show 272K.
		expect(model.contextWindow).toBe(1_000_000);
	});
});
