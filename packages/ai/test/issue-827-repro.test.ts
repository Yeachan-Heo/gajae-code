/**
 * Repro lineage for #827 — OpenCode Go Kimi models reject forced `tool_choice`
 * while thinking is enabled. Later Go captures also showed generic upstream
 * 400s for forced `tool_choice` even when reasoning was omitted, so the
 * OpenCode Go Kimi path now degrades forced choices to auto/no explicit
 * `tool_choice` instead of forwarding the forced directive.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import type { Context, Model, Tool } from "@gajae-code/ai/types";
import * as z from "zod/v4";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: z.object({ text: z.string() }),
};

const ctx: Context = {
	messages: [{ role: "user", content: "do it", timestamp: Date.now() }],
	tools: [echoTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function kimiOpencodeGoModel(id = "kimi-k2.6"): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/v1",
		id,
		name: id === "kimi-k2.7-code" ? "Kimi K2.7 Code" : id === "kimi-k2.5" ? "Kimi K2.5" : "Kimi K2.6",
		reasoning: true,
	};
}

function kimiOpenRouterModel(): Model<"openai-completions"> {
	return {
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		id: "moonshotai/kimi-k2",
		name: "Kimi K2 (OpenRouter)",
		reasoning: true,
	};
}

function captureBody(
	model: Model<"openai-completions">,
	opts: Parameters<typeof streamOpenAICompletions>[2],
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, ctx, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

interface CompletionsBody {
	tool_choice?: unknown;
	tools?: unknown[];
	reasoning_effort?: unknown;
	reasoning?: unknown;
	thinking?: unknown;
}

describe("issue #827 lineage — kimi reasoning models avoid incompatible forced tool_choice", () => {
	it("omits forced tool_choice on every OpenCode Go Kimi variant and keeps supported reasoning", async () => {
		for (const modelId of ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"]) {
			const body = (await captureBody(kimiOpencodeGoModel(modelId), {
				reasoning: "high",
				toolChoice: "any",
			})) as CompletionsBody;

			expect(body.tool_choice).toBeUndefined();
			expect(body.reasoning_effort).toBe("high");
		}
	});

	it("preserves reasoning_effort when toolChoice is auto", async () => {
		const body = (await captureBody(kimiOpencodeGoModel(), {
			reasoning: "high",
			toolChoice: "auto",
		})) as CompletionsBody;

		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning_effort).toBe("high");
	});

	it("strips OpenRouter-shaped reasoning object on forced toolChoice for Kimi via OpenRouter", async () => {
		const body = (await captureBody(kimiOpenRouterModel(), {
			reasoning: "high",
			toolChoice: { type: "tool", name: "echo" },
		})) as CompletionsBody;

		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "echo" } });
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});
	it("sends explicit thinking disabled for Moonshot Kimi K2.6 when a named tool is forced", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			reasoning: false,
		};
		const body = (await captureBody(model, {
			toolChoice: { type: "tool", name: "echo" },
		})) as CompletionsBody;

		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "echo" } });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("strips reasoning_effort for Anthropic Claude models served via openai-completions (e.g. LiteLLM/OpenRouter proxies)", async () => {
		// LiteLLM / Vertex proxies often expose Anthropic model through chat-completions; Anthropic
		// itself rejects reasoning + forced tool_choice (see anthropic.ts:disableThinkingIfToolChoiceForced),
		// so the same constraint must follow the model when it's reached through the OpenAI shape.
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (LiteLLM)",
			reasoning: true,
		};

		const body = (await captureBody(model, {
			reasoning: "high",
			toolChoice: "any",
		})) as CompletionsBody;

		expect(body.tool_choice).toBe("required");
		expect(body.reasoning_effort).toBeUndefined();
	});
	it("does not strip reasoning on non-Kimi models even with forced tool_choice", async () => {
		// Non-kimi reasoning model — OpenAI itself accepts forced tool_choice with reasoning.
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			id: "gpt-5-mini",
			reasoning: true,
		};

		const body = (await captureBody(model, {
			reasoning: "high",
			toolChoice: "any",
		})) as CompletionsBody;

		expect(body.tool_choice).toBe("required");
		expect(body.reasoning_effort).toBe("high");
	});
});
