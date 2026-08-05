import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { convertMessages, detectCompat, streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@gajae-code/ai/providers/openai-responses";
import { getEnvApiKey } from "@gajae-code/ai/stream";
import type { AssistantMessage, Context, Model, Tool, ToolChoice } from "@gajae-code/ai/types";
import * as z from "zod/v4";

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
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
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

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: z.object({ text: z.string() }),
};

function captureCompletionsToolPayload(
	model: Model<"openai-completions">,
	toolChoice: ToolChoice,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "call echo", timestamp: 0 }], tools: [echoTool] },
		{
			apiKey: "test-key",
			signal: abortedSignal(),
			reasoning: "high",
			toolChoice,
			onPayload: payload => resolve(payload as Record<string, unknown>),
		},
	);
	return promise;
}

function assistantTurn(model: Model<"openai-completions">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

const qwenPreview = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview") as Model<"openai-responses">;
const qwenGa = getBundledModel("alibaba-token-plan", "qwen3.8-max") as Model<"openai-completions">;
const glm = getBundledModel("alibaba-token-plan", "glm-5.2") as Model<"openai-completions">;
const deepseek = getBundledModel("alibaba-token-plan", "deepseek-v4-flash-0731") as Model<"openai-completions">;

describe("Alibaba Token Plan reasoning request parameters", () => {
	it("resolves only the documented Alibaba Token Plan credential environment variable", () => {
		Bun.env.ALIBABA_TOKEN_PLAN_API_KEY = "alibaba-token-plan-test-key";
		expect(getEnvApiKey("alibaba-token-plan")).toBe("alibaba-token-plan-test-key");
	});
	it("sends locked Qwen efforts verbatim as Responses reasoning.effort", async () => {
		for (const effort of ["medium", "low", "xhigh"] as const) {
			const payload = await captureResponsesPayload(qwenPreview, effort);

			expect(payload.reasoning).toEqual({ effort, summary: "auto" });
			expect(payload.include).toEqual(["reasoning.encrypted_content"]);
			expect(payload.reasoning_effort).toBeUndefined();
		}
	});

	it("sends Qwen3.8 Max GA enable_thinking with its mapped Chat reasoning effort", async () => {
		for (const [effort, expected] of [
			["minimal", "low"],
			["medium", "medium"],
			["high", "xhigh"],
			["xhigh", "xhigh"],
			["max", "xhigh"],
		] as const) {
			const payload = await captureCompletionsPayload(qwenGa, effort);

			expect(payload.enable_thinking).toBe(true);
			expect(payload.reasoning_effort).toBe(expected);
			expect(payload.thinking).toBeUndefined();
		}
	});

	it("sends reasoning_effort high for GLM-5.2 Completions", async () => {
		const payload = await captureCompletionsPayload(glm, "high");

		expect(payload.reasoning_effort).toBe("high");
		expect(payload.enable_thinking).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("sends max for DeepSeek V4 Flash 0731 Completions", async () => {
		const payload = await captureCompletionsPayload(deepseek, "max");

		expect(payload.reasoning_effort).toBe("max");
		expect(payload.thinking).toBeUndefined();
	});

	it("keeps Qwen3.8 Max GA thinking on for open tool choice", async () => {
		const payload = await captureCompletionsToolPayload(qwenGa, "auto");

		expect(payload.tool_choice).toBe("auto");
		expect(payload.enable_thinking).toBe(true);
		expect(payload.reasoning_effort).toBe("xhigh");
	});

	it("suppresses Qwen3.8 Max GA thinking when a specific tool is forced", async () => {
		const payload = await captureCompletionsToolPayload(qwenGa, { type: "tool", name: "echo" });

		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "echo" } });
		expect(payload.enable_thinking).toBe(false);
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("suppresses Qwen3.8 Max GA thinking when any tool call is required", async () => {
		const payload = await captureCompletionsToolPayload(qwenGa, "any");

		expect(payload.tool_choice).toBe("required");
		expect(payload.enable_thinking).toBe(false);
		expect(payload.reasoning_effort).toBeUndefined();
	});
});

describe("Alibaba Token Plan Qwen3.8 Max GA thinking history", () => {
	it("requires exact reasoning_content replay and rejects synthetic placeholders", () => {
		const compat = detectCompat(qwenGa);

		expect(compat.thinkingFormat).toBe("qwen");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(compat.disableReasoningOnForcedToolChoice).toBe(true);
	});

	it("replays prior reasoning_content on a tool-call continuation turn", () => {
		const compat = detectCompat(qwenGa);
		const messages = convertMessages(
			qwenGa,
			{
				messages: [
					{ role: "user", content: "list files", timestamp: 0 },
					assistantTurn(qwenGa, [
						{ type: "thinking", thinking: "I should list files.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "Calling a tool." },
						{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "." } },
					]),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "echo",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 0,
					},
				],
			},
			compat,
		);

		const assistant = messages.find(m => m.role === "assistant") as object;
		expect(Reflect.get(assistant, "reasoning_content")).toBe("I should list files.");
	});

	it("replays reasoning_content on plain assistant turns, not just tool-call turns", () => {
		const compat = detectCompat(qwenGa);
		const messages = convertMessages(
			qwenGa,
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 0 },
					assistantTurn(qwenGa, [
						{ type: "thinking", thinking: "Greeting.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "hello" },
					]),
					{ role: "user", content: "again", timestamp: 0 },
				],
			},
			compat,
		);

		const assistant = messages.find(m => m.role === "assistant") as object;
		expect(Reflect.get(assistant, "reasoning_content")).toBe("Greeting.");
	});

	it("emits an empty reasoning_content rather than a '.' placeholder when no thinking was captured", () => {
		const compat = detectCompat(qwenGa);
		const messages = convertMessages(
			qwenGa,
			{
				messages: [
					assistantTurn(qwenGa, [{ type: "toolCall", id: "call_2", name: "echo", arguments: { text: "." } }]),
				],
			},
			compat,
		);

		const assistant = messages.find(m => m.role === "assistant") as object;
		expect(Reflect.get(assistant, "reasoning_content")).toBe("");
	});
});

describe("Alibaba Token Plan Qwen3.8 Max Preview capabilities", () => {
	it("keeps the documented visual-understanding input modality", () => {
		expect(qwenPreview.input).toEqual(["text", "image"]);
	});
});
