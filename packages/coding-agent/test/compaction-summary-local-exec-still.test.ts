import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { generateSummary } from "@gajae-code/agent-core/compaction/compaction";
import type { AssistantMessage, Context, Model, Usage } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { convertToLlm } from "../src/session/messages";

const MODEL: Model = {
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

afterEach(() => {
	vi.restoreAllMocks();
});

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function promptText(ctx: Context): string {
	return ctx.messages
		.map(message => {
			const content = message.content;
			if (typeof content === "string") return content;
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("");
		})
		.join("");
}

describe("summary prompt still carries ordinary local command output", () => {
	it("keeps ordinary bash and python output in the summary prompt", async () => {
		const captured: Context[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, ctx) => {
			captured.push(ctx as Context);
			return assistant("summary text");
		});
		const messages: AgentMessage[] = [
			{ role: "user", content: "summarize the command", timestamp: 1 },
			{
				role: "bashExecution",
				command: "echo hello",
				output: "hello world",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{
				role: "pythonExecution",
				code: "print('ok')",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
		];
		const summary = await generateSummary(messages, MODEL, 2_000, "test-key", undefined, undefined, undefined, {
			convertToLlm,
		});
		expect(summary).toBe("summary text");
		expect(captured).toHaveLength(1);
		const prompt = promptText(captured[0] as Context);
		expect(prompt).toContain("hello world");
		expect(prompt).toContain("Ran `echo hello`");
		expect(prompt).toContain("print('ok')");
		expect(prompt).toContain("\nok\n");
	});
});
