import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@gajae-code/ai/providers/openai-responses";
import { getEnvApiKey } from "@gajae-code/ai/stream";
import type { Context, Model } from "@gajae-code/ai/types";

const originalAlibabaTokenPlanApiKey = Bun.env.ALIBABA_TOKEN_PLAN_API_KEY;

afterEach(() => {
	if (originalAlibabaTokenPlanApiKey === undefined) {
		delete Bun.env.ALIBABA_TOKEN_PLAN_API_KEY;
	} else {
		Bun.env.ALIBABA_TOKEN_PLAN_API_KEY = originalAlibabaTokenPlanApiKey;
	}
});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	reasoning: "medium" | "low" | "xhigh",
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(model, testContext, {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning,
		reasoningSummary: "auto",
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function captureCompletionsPayload(
	model: Model<"openai-completions">,
	reasoning: "high" | "xhigh",
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAICompletions(model, testContext, {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning,
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

const qwen = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview") as Model<"openai-responses">;
const glm = getBundledModel("alibaba-token-plan", "glm-5.2") as Model<"openai-completions">;
const deepseek = getBundledModel("alibaba-token-plan", "deepseek-v4-pro") as Model<"openai-completions">;

describe("Alibaba Token Plan reasoning request parameters", () => {
	it("resolves only the documented Alibaba Token Plan credential environment variable", () => {
		Bun.env.ALIBABA_TOKEN_PLAN_API_KEY = "alibaba-token-plan-test-key";
		expect(getEnvApiKey("alibaba-token-plan")).toBe("alibaba-token-plan-test-key");
	});
	it("sends locked Qwen efforts verbatim as Responses reasoning.effort", async () => {
		for (const effort of ["medium", "low", "xhigh"] as const) {
			const payload = await captureResponsesPayload(qwen, effort);

			expect(payload.reasoning).toEqual({ effort, summary: "auto" });
			expect(payload.include).toEqual(["reasoning.encrypted_content"]);
			expect(payload.reasoning_effort).toBeUndefined();
		}
	});

	it("sends reasoning_effort high for GLM-5.2 Completions", async () => {
		const payload = await captureCompletionsPayload(glm, "high");

		expect(payload.reasoning_effort).toBe("high");
		expect(payload.enable_thinking).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("maps xhigh to max for DeepSeek V4 Pro Completions via the DeepSeek-family effort map", async () => {
		const payload = await captureCompletionsPayload(deepseek, "xhigh");

		expect(payload.reasoning_effort).toBe("max");
		expect(payload.thinking).toBeUndefined();
	});
});
