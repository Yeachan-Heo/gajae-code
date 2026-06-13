/**
 * Composer-harness models (xai grok-composer-*, cursor composer-*) get the
 * anchor/edit discipline prompt pinned ahead of the host system prompt, on
 * both the openai-completions path and the cursor RPC path. Non-composer
 * models must stay byte-identical to previous behavior.
 */
import { describe, expect, it } from "bun:test";
import { COMPOSER_EDIT_DISCIPLINE_PROMPT, isComposerHarnessModel } from "@gajae-code/ai/providers/composer-discipline";
import { buildCursorSystemPromptJsons } from "@gajae-code/ai/providers/cursor";
import { convertMessages } from "@gajae-code/ai/providers/openai-completions";
import type { Context, Model, OpenAICompat } from "@gajae-code/ai/types";

const compat: Required<OpenAICompat> = {
	supportsStore: true,
	supportsDeveloperRole: false,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: false,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	toolChoiceSupport: "named",
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
};

function createXaiModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as unknown as Model<"openai-completions">;
}

function createContext(systemPrompt?: string[]): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
	} as unknown as Context;
}

describe("isComposerHarnessModel", () => {
	it("matches composer ids on any provider, rejects others", () => {
		expect(isComposerHarnessModel("grok-composer-2.5-fast")).toBe(true);
		expect(isComposerHarnessModel("composer-1")).toBe(true);
		expect(isComposerHarnessModel("Grok-Composer-Next")).toBe(true);
		expect(isComposerHarnessModel("grok-4.3")).toBe(false);
		expect(isComposerHarnessModel("gpt-5")).toBe(false);
	});
});

describe("openai-completions composer discipline injection", () => {
	it("prepends the discipline prompt for composer models", () => {
		const params = convertMessages(
			createXaiModel("grok-composer-2.5-fast"),
			createContext(["Host system prompt."]),
			compat,
		);
		expect(params[0]).toEqual({ role: "system", content: COMPOSER_EDIT_DISCIPLINE_PROMPT });
		expect(params[1]).toEqual({ role: "system", content: "Host system prompt." });
	});

	it("does not inject for non-composer models", () => {
		const params = convertMessages(createXaiModel("grok-4.3"), createContext(["Host system prompt."]), compat);
		expect(params[0]).toEqual({ role: "system", content: "Host system prompt." });
		expect(JSON.stringify(params)).not.toContain("File-editing discipline");
	});

	it("does not inject when there is no host system prompt", () => {
		const params = convertMessages(createXaiModel("grok-composer-2.5-fast"), createContext(undefined), compat);
		expect(JSON.stringify(params)).not.toContain("File-editing discipline");
	});

	it("joins the discipline prompt first when multiple system messages are unsupported", () => {
		const singleMessageCompat = { ...compat, supportsMultipleSystemMessages: false };
		const params = convertMessages(
			createXaiModel("grok-composer-2.5-fast"),
			createContext(["Host system prompt."]),
			singleMessageCompat,
		);
		expect(params[0].role).toBe("system");
		expect(params[0].content).toBe(`${COMPOSER_EDIT_DISCIPLINE_PROMPT}\n\nHost system prompt.`);
	});
});

describe("cursor composer discipline injection", () => {
	it("pins the discipline block ahead of the host prompt for composer model ids", () => {
		const jsons = buildCursorSystemPromptJsons(["Host system prompt."], "composer-1");
		const contents = jsons.map(json => (JSON.parse(json) as { content: string }).content);
		expect(contents[0]).toBe(COMPOSER_EDIT_DISCIPLINE_PROMPT);
		expect(contents[1]).toBe("Host system prompt.");
	});

	it("keeps non-composer cursor models unchanged", () => {
		const jsons = buildCursorSystemPromptJsons(["Host system prompt."], "gpt-5");
		const contents = jsons.map(json => (JSON.parse(json) as { content: string }).content);
		expect(contents).toEqual(["Host system prompt."]);
	});

	it("keeps the legacy single-argument call shape unchanged", () => {
		const jsons = buildCursorSystemPromptJsons(["Host system prompt."]);
		const contents = jsons.map(json => (JSON.parse(json) as { content: string }).content);
		expect(contents).toEqual(["Host system prompt."]);
	});

	it("does not inject discipline without a host system prompt", () => {
		const jsons = buildCursorSystemPromptJsons(undefined, "composer-1");
		const contents = jsons.map(json => (JSON.parse(json) as { content: string }).content);
		expect(contents).toEqual(["You are a helpful assistant."]);
	});
});
