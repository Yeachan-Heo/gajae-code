import { afterEach, describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentToolContext } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { readDeepInterviewStateCompact } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { deepInterviewStatePath } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { readWorkflowStateJson } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";
import { TempDir } from "@gajae-code/utils";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function createSession(cwd: string, sessionId: string): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => sessionId,
		getDeepInterviewAskStage: () => "post-topology",
		settings: Settings.isolated(),
	};
}

function literalDeepInterviewArguments() {
	return {
		questions: [
			{
				id: "q-durable",
				question: "Should sessions persist?",
				options: [{ label: "Persist state" }, { label: "Display only" }],
				deepInterview: {
					round: 2,
					component: "session-state",
					dimension: "durability",
					ambiguity: 0.25,
				},
			},
		],
	};
}

function answerFirstOptionContext(): AgentToolContext {
	return {
		hasUI: true,
		ui: {
			select: async (_prompt: string, options: string[]) => options[0],
			editor: async () => undefined,
		},
		abort: () => {},
	} as unknown as AgentToolContext;
}

function escapedDeepInterviewTurn(id: string, surface: "question" | "option") {
	return {
		content: [
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: {
					questions: [
						{
							id: "q-durable",
							question: surface === "question" ? "Should sessions — persist?" : "Should sessions persist?",
							options: [
								{ label: surface === "option" ? "Persist — state" : "Persist state" },
								{ label: "Display only" },
							],
							deepInterview: {
								round: 2,
								component: "session-state",
								dimension: "durability",
								ambiguity: 0.25,
							},
						},
					],
				},
				escapedNonAsciiArguments: true,
			},
		],
	};
}

describe("AskTool escaped deep-interview durability (#4926)", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		tempDir?.removeSync();
	});

	it("resamples terminally and leaves persistence, reload, and spec input clean", async () => {
		tempDir = TempDir.createSync("@gjc-ask-escaped-durability-4926-");
		for (const surface of ["question", "option"] as const) {
			const cwd = `${tempDir.path()}/${surface}`;
			const sessionId = `ask-escaped-${surface}`;
			const tool = new AskTool(createSession(cwd, sessionId));
			const literalResult = await tool.execute(
				"literal-control",
				literalDeepInterviewArguments(),
				undefined,
				undefined,
				answerFirstOptionContext(),
			);
			expect(literalResult.details?.selectedOptions).toEqual(["Persist state"]);

			const statePath = deepInterviewStatePath(cwd, sessionId);
			expect(await Bun.file(statePath).exists()).toBe(true);
			const persistedControl = await readWorkflowStateJson(cwd, "deep-interview", sessionId);
			const persistedControlText = JSON.stringify(persistedControl);
			expect(persistedControlText).toContain("Should sessions persist?");
			expect(persistedControlText).toContain("Persist state");

			const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
			const mock = createMockModel({
				responses: [
					escapedDeepInterviewTurn("tc-1", surface),
					escapedDeepInterviewTurn("tc-2", surface),
					escapedDeepInterviewTurn("tc-3", surface),
					{ content: ["done"] },
				],
			});
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
			const toolResults: Array<{ isError?: boolean; text: string }> = [];
			const userMessage = { role: "user" as const, content: "Ask the durability question", timestamp: 1 };

			const stream = agentLoop([userMessage], context, config, undefined, mock.stream);
			for await (const event of stream) {
				if (event.type === "tool_execution_end") {
					const first = event.result.content?.[0];
					toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
				}
			}

			expect(mock.calls).toHaveLength(4);
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0].isError).toBe(true);
			expect(toolResults[0].text).toContain("\\uXXXX");

			const compact = await readDeepInterviewStateCompact(statePath);
			expect(compact.pending_shells).toHaveLength(1);
			expect(compact.recent_scored_rounds).toEqual([]);
			expect(compact.pending_shells[0]?.question_text).toBe("Should sessions persist?");
			expect(compact.pending_shells[0]?.selected_options).toEqual(["Persist state"]);

			const specInput = await readWorkflowStateJson(cwd, "deep-interview", sessionId);
			expect(specInput).toEqual(persistedControl);
			expect(JSON.stringify(specInput)).not.toContain("Should sessions — persist?");
			expect(JSON.stringify(specInput)).not.toContain("Persist — state");
		}
	});
});

describe("AskTool display-safe escaped argument fields (#4983)", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		tempDir?.removeSync();
	});

	it("declares question text and option labels as its only display-safe fields", () => {
		tempDir = TempDir.createSync("@gjc-ask-display-safe-4983-");
		const tool = new AskTool(createSession(tempDir.path(), "ask-display-safe"));
		// Only pure display text opts in: ids, workflow gates, and deep-interview
		// metadata stay load-bearing and keep the fail-closed rejection.
		expect(tool.displaySafeEscapedArgFields).toEqual(["questions.question", "questions.options.label"]);
	});
});
