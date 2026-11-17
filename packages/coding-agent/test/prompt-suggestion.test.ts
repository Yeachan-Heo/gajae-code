import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { createMockModel, type MockResponse, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	generatePromptSuggestion,
	PROMPT_SUGGESTION_REQUEST,
	parsePromptSuggestion,
} from "../src/utils/prompt-suggestion";

registerMockApi();

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function createSession(response: MockResponse) {
	const model = createMockModel({ handler: () => response });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["system prompt"],
			messages: [user("Fix the timeout"), assistant("Fixed the timeout.")],
			tools: [],
		},
		streamFn: model.stream,
		convertToLlm: async messages => convertToLlm(messages),
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {
			getApiKey: async () => "test-key",
			getAvailable: () => [model],
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		agentId: "0-Main",
		agentRegistry: new AgentRegistry(),
		convertToLlm: async messages => convertToLlm(messages),
	});
	sessions.push(session);
	return { session, model };
}

function messageText(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return (content as Array<{ type: string; text?: string }>)
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

describe("PROMPT_SUGGESTION_REQUEST", () => {
	it("wraps the Codex prompt and schema as an app-generated fragment", () => {
		expect(PROMPT_SUGGESTION_REQUEST.startsWith("<external_prompt_suggestion>This is an app-generated request")).toBe(
			true,
		);
		expect(PROMPT_SUGGESTION_REQUEST).toContain("at most 240 characters");
		expect(
			PROMPT_SUGGESTION_REQUEST.endsWith(
				'Return only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}.</external_prompt_suggestion>',
			),
		).toBe(true);
	});
});

describe("parsePromptSuggestion", () => {
	it("rejects anything but a bounded single-line suggestion object", () => {
		for (const response of [
			"null",
			"{}",
			"[]",
			"not json",
			'{"suggestion":null}',
			'{"suggestion":3}',
			'{"suggestion":""}',
			'{"suggestion":"   "}',
			'{"suggestion":"a\\nb"}',
			'{"suggestion":"a\\tb"}',
			'{"suggestion":"a\\u2028b"}',
			'{"suggestion":"ok","extra":true}',
			'{"suggestion":"first","suggestion":"second"}',
			'{"suggestion":"first","sugg\\u0065stion":"second"}',
			'{"suggestion":"\\ud800"}',
			'{"suggestion":"a\\udc00"}',
			'{"suggestion":"a\\u0085b"}',
			'```json\n{"suggestion":"ok"}\n```',
		]) {
			expect(parsePromptSuggestion(response)).toBeNull();
		}
	});

	it("counts characters, not UTF-16 units or bytes, against the 240 limit", () => {
		for (const [char, length] of [
			["é", 240],
			["가", 240],
			["😀", 240],
		] as const) {
			const text = char.repeat(length);
			expect(parsePromptSuggestion(JSON.stringify({ suggestion: text }))).toBe(text);
			expect(parsePromptSuggestion(JSON.stringify({ suggestion: text + char }))).toBeNull();
		}
	});

	it("trims the accepted suggestion", () => {
		expect(parsePromptSuggestion('{"suggestion":"  Add a regression test  "}')).toBe("Add a regression test");
		expect(parsePromptSuggestion('  {"suggestion":"표로 정리해줘"}\n')).toBe("표로 정리해줘");
	});

	it("matches serde and Rust str semantics at the edges", () => {
		// Escaped key names decode like serde, valid surrogate pairs are one char, commas inside strings are not members.
		expect(parsePromptSuggestion('{"sugg\\u0065stion":"ok"}')).toBe("ok");
		expect(parsePromptSuggestion('{"suggestion":"\\ud83d\\ude00"}')).toBe("😀");
		expect(parsePromptSuggestion('{"suggestion":"a, \\"b\\", {c}"}')).toBe('a, "b", {c}');
		// Rust trim strips U+0085 at the edges but keeps U+FEFF (not White_Space).
		expect(parsePromptSuggestion('{"suggestion":"\\u0085ok\\u0085"}')).toBe("ok");
		expect(parsePromptSuggestion('{"suggestion":"\\ufeffok"}')).toBe("\ufeffok");
	});
});

describe("generatePromptSuggestion", () => {
	it("asks the session model with its system prompt and full history, without mutating history", async () => {
		const { session, model } = createSession({ content: ['{"suggestion":"Add a regression test for the timeout"}'] });
		const before = structuredClone(session.messages);

		const suggestion = await generatePromptSuggestion(session, new AbortController().signal);

		expect(suggestion).toBe("Add a regression test for the timeout");
		expect(model.calls).toHaveLength(1);
		const { context, options } = model.calls[0]!;
		expect(context.systemPrompt).toEqual(["system prompt"]);
		expect(context.messages.map(message => [message.role, messageText(message)])).toEqual([
			["user", "Fix the timeout"],
			["assistant", "Fixed the timeout."],
			["user", PROMPT_SUGGESTION_REQUEST],
		]);
		expect(context.tools).toEqual([]);
		expect(options?.maintenanceCall).toBe(true);
		expect(session.messages).toEqual(before);
	});

	it("returns null when the model declines with a null suggestion", async () => {
		const { session } = createSession({ content: ['{"suggestion":null}'] });
		expect(await generatePromptSuggestion(session, new AbortController().signal)).toBeNull();
	});

	it("returns null when the model answers with prose instead of JSON", async () => {
		const { session } = createSession({ content: ["Run the tests next."] });
		expect(await generatePromptSuggestion(session, new AbortController().signal)).toBeNull();
	});

	it("rejects when the request is aborted before the provider starts", async () => {
		const { session, model } = createSession({ content: ['{"suggestion":"late"}'] });
		const controller = new AbortController();
		const pending = generatePromptSuggestion(session, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(model.calls).toHaveLength(0);
	});

	it("rejects when the request is aborted while the provider is streaming", async () => {
		const { session, model } = createSession({ content: ['{"suggestion":"late"}'], delayMs: 5_000 });
		const controller = new AbortController();
		const pending = generatePromptSuggestion(session, controller.signal);
		for (let i = 0; i < 100 && model.calls.length === 0; i++) await Bun.sleep(1);
		expect(model.calls).toHaveLength(1);
		const started = Date.now();
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
