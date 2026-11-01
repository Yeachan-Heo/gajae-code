import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { streamOpenAIResponses } from "@gajae-code/ai/providers/openai-responses";
import { stream } from "@gajae-code/ai/stream";
import type { Context, Model, OpenAICompat } from "@gajae-code/ai/types";
import { e2eApiKey } from "./oauth";

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Think step by step.`,
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("xhigh reasoning", () => {
	describe("codex-max (supports xhigh)", () => {
		// Note: OpenAI code backend models only support the responses API, not chat completions
		it("should work with openai-responses", async () => {
			const model = getBundledModel("openai", "gpt-5.1-codex-max");
			const s = stream(model, makeContext(), { reasoning: "xhigh" });
			let hasThinking = false;

			for await (const event of s) {
				if (event.type === "thinking_start" || event.type === "thinking_delta") {
					hasThinking = true;
				}
			}

			const response = await s.result();
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			expect(response.content.some(b => b.type === "text")).toBe(true);
			expect(hasThinking || response.content.some(b => b.type === "thinking")).toBe(true);
		});
	});

	describe("gpt-5-mini (does not support xhigh)", () => {
		it("should error with openai-responses when using xhigh", async () => {
			const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
			const s = stream(model, makeContext(), { reasoning: "xhigh" });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});

		it("should error with openai-completions when using xhigh", async () => {
			const model: Model<"openai-completions"> = {
				...(getBundledModel("openai", "gpt-5-mini") as Model<"openai-completions">),
				api: "openai-completions",
			};
			const s = stream(model, makeContext(), { reasoning: "xhigh" });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});
	});
});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh",
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(model, testContext, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		reasoning,
		reasoningSummary: "auto",
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function customResponsesModel(compat: OpenAICompat): Model<"openai-responses"> {
	return {
		id: "deepseek-v4-flash:cloud",
		name: "deepseek-v4-flash:cloud",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		compat,
	} as Model<"openai-responses">;
}

// #931: Custom Responses models map configured effort before payload submission.
describe("OpenAI Responses reasoning effort compatibility", () => {
	it("maps configured xhigh reasoning effort before sending Responses reasoning payload", async () => {
		const payload = await captureResponsesPayload(
			customResponsesModel({
				supportsReasoningEffort: true,
				reasoningEffortMap: {
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "max",
				},
			}),
			"xhigh",
		);

		expect(payload.reasoning).toEqual({ effort: "max", summary: "auto" });
	});
});
