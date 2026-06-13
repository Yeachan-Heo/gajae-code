import { beforeEach, describe, expect, it } from "bun:test";
import type { Api, Model } from "@gajae-code/ai";
import { clearToolChoiceIncapabilityRegistryForTests, markToolChoiceIncapability } from "@gajae-code/ai";
import { buildNamedToolChoiceResult } from "@gajae-code/coding-agent/utils/tool-choice";

function model<TApi extends Api>(api: TApi, compat?: Model<TApi>["compat"]): Model<TApi> {
	return {
		id: `${api}-test-model`,
		name: `${api} test model`,
		api,
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	};
}

describe("buildNamedToolChoiceResult", () => {
	beforeEach(() => {
		clearToolChoiceIncapabilityRegistryForTests();
	});

	it("returns exact named choice for anthropic named support", () => {
		const result = buildNamedToolChoiceResult("yield", model("anthropic-messages", { toolChoiceSupport: "named" }));

		expect(result.exactNamed).toBe(true);
		expect(result.choice).toEqual({ type: "tool", name: "yield" });
		expect(result.resolved?.resolvedLevel).toBe("named");
	});

	it("returns no choice when compat disables forced tool choice", () => {
		const result = buildNamedToolChoiceResult(
			"yield",
			model("anthropic-messages", { supportsToolChoice: true, supportsForcedToolChoice: false }),
		);

		expect(result.exactNamed).toBe(false);
		expect(result.choice).toBeUndefined();
		expect(result.resolved?.resolvedLevel).toBe("auto");
	});

	it("never treats google required forcing as exact named", () => {
		const result = buildNamedToolChoiceResult(
			"yield",
			model("google-generative-ai", { toolChoiceSupport: "required" }),
		);

		expect(result.exactNamed).toBe(false);
		expect(result.choice).toBeUndefined();
		expect(result.resolved?.resolvedChoice).toBe("required");
		expect(result.resolved?.resolvedLevel).toBe("required");
	});

	it("returns no exact named choice for runtime-marked incapable model", () => {
		const runtimeModel = model("anthropic-messages", { toolChoiceSupport: "named" });
		markToolChoiceIncapability(runtimeModel, "auto", "runtime rejection");

		const result = buildNamedToolChoiceResult("yield", runtimeModel);

		expect(result.exactNamed).toBe(false);
		expect(result.choice).toBeUndefined();
		expect(result.resolved?.supportSource).toBe("runtime");
		expect(result.resolved?.resolvedLevel).toBe("auto");
	});
});
