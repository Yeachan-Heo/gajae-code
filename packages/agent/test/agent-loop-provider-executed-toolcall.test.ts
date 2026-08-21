import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

type EmptySchema = z.ZodObject<Record<string, never>>;
type TestTool = AgentTool<EmptySchema, Record<string, never>>;

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function countingTool(name: string, counter: { n: number }): TestTool {
	return {
		name,
		label: name,
		description: `The ${name} tool`,
		parameters: z.object({}),
		lenientArgValidation: true,
		async execute() {
			counter.n += 1;
			return { content: [{ type: "text", text: "executed locally" }], details: {} };
		},
	} as unknown as TestTool;
}

async function runOnce(
	tools: TestTool[],
	call: {
		name: string;
		arguments: Record<string, unknown>;
		providerExecuted?: "cursor-exec";
		trustedProvider?: boolean;
		providerExecutionResult?: { status: "success" | "error"; output: string };
	},
): Promise<Array<{ isError?: boolean; text: string }>> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools };
	const mock = createMockModel({
		provider: call.providerExecuted && call.trustedProvider !== false ? "cursor" : undefined,
		responses: [
			{
				content: [
					{
						type: "toolCall",
						id: "tc-1",
						name: call.name,
						arguments: call.arguments,
						...(call.providerExecuted ? { providerExecuted: call.providerExecuted } : {}),
						...(call.providerExecutionResult
							? { providerExecutionResult: call.providerExecutionResult }
							: call.providerExecuted
								? {
										providerExecutionResult: {
											status: "success" as const,
											output: "executed by the provider during streaming",
										},
									}
								: {}),
					},
				],
			},
			{ content: ["done"] },
		],
	});
	const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
	const results: Array<{ isError?: boolean; text: string }> = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
	for await (const event of stream) {
		if (event.type === "tool_execution_end") {
			const first = event.result.content?.[0];
			results.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
		}
	}
	return results;
}

// Cursor's model calls its own native tools instead of the advertised MCP tools,
// and those are executed during streaming over the exec channel: `shellArgs`
// reaches CursorExecHandlers.shell, which runs the command through the local
// `bash` tool. The provider still renders the call into assistant content for
// visibility, and that block used to be indistinguishable from a model-issued
// call, so the loop dispatched it a second time.
describe("agentLoop: provider-executed tool calls are not dispatched locally", () => {
	it("does not re-run a call the provider already executed", async () => {
		const counter = { n: 0 };
		const results = await runOnce([countingTool("bash", counter)], {
			name: "bash",
			arguments: { command: "rm -rf build" },
			providerExecuted: "cursor-exec",
		});

		// The whole point: the side effect must not happen twice.
		expect(counter.n).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBeFalsy();
		expect(results[0].text).toContain("executed by the provider during streaming");
		expect(results[0].text).not.toContain("executed locally");
	});

	it("keeps a result paired with the call so history stays consistent", async () => {
		const counter = { n: 0 };
		const results = await runOnce([countingTool("bash", counter)], {
			name: "bash",
			arguments: { command: "echo hi" },
			providerExecuted: "cursor-exec",
		});

		// One call in, exactly one result out - an unpaired tool call would
		// corrupt the next request's message sequence.
		expect(results).toHaveLength(1);
		expect(results[0].text).toContain("provider");
	});

	it("does not fail with tool-not-found when the display label is not a registered tool", async () => {
		// Cursor native kinds render under display labels that gajae-code has no
		// tool for (glob, grep, ls, read_lints, ...). Dispatching those aborted the
		// turn with `Tool <name> not found`; they must be accepted as already-run.
		const counter = { n: 0 };
		const results = await runOnce([countingTool("bash", counter)], {
			name: "glob",
			arguments: { globPattern: "**/*.ts" },
			providerExecuted: "cursor-exec",
		});

		expect(counter.n).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBeFalsy();
		expect(results[0].text).not.toContain("not found");
	});

	it("still dispatches an ordinary model-issued call", async () => {
		// Guard against the flag leaking into the normal path: unflagged calls,
		// including Cursor's MCP and todo_write calls, must execute as before.
		const counter = { n: 0 };
		const results = await runOnce([countingTool("bash", counter)], {
			name: "bash",
			arguments: { command: "echo hi" },
		});

		expect(counter.n).toBe(1);
		expect(results).toHaveLength(1);
		expect(results[0].text).toContain("executed locally");
	});

	it("still reports tool-not-found for an unflagged unknown tool", async () => {
		const counter = { n: 0 };
		const results = await runOnce([countingTool("bash", counter)], {
			name: "glob",
			arguments: {},
		});

		expect(counter.n).toBe(0);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("Tool glob not found");
	});

	it("does not trust a marker from a non-Cursor provider", async () => {
		const counter = { n: 0 };
		const results = await runOnce([countingTool("bash", counter)], {
			name: "bash",
			arguments: {},
			providerExecuted: "cursor-exec",
			trustedProvider: false,
		});

		expect(counter.n).toBe(1);
		expect(results[0]?.isError).toBeFalsy();
		expect(results[0]?.text).toContain("executed locally");
	});

	it("refuses local execution and reports an error without provider outcome", async () => {
		const counter = { n: 0 };
		const mock = createMockModel({
			provider: "cursor",
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-1",
							name: "bash",
							arguments: {},
							providerExecuted: "cursor-exec",
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const stream = agentLoop(
			[createUserMessage("go")],
			{ systemPrompt: [""], messages: [], tools: [countingTool("bash", counter)] },
			{ model: mock.model, convertToLlm: identityConverter },
			undefined,
			mock.stream,
		);
		const results: Array<{ isError?: boolean; text: string }> = [];
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				results.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(counter.n).toBe(0);
		expect(results).toEqual([
			{
				isError: true,
				text: 'Tool call "bash" was marked as provider-executed without an execution result; local execution was refused.',
			},
		]);
	});

	it("preserves provider provenance through managed attempt sanitization", async () => {
		const counter = { n: 0 };
		const mock = createMockModel({
			provider: "cursor",
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-1",
							name: "bash",
							arguments: { command: "echo provider" },
							providerExecuted: "cursor-exec",
							providerExecutionResult: { status: "success", output: "provider output" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const stream = agentLoop(
			[createUserMessage("go")],
			{ systemPrompt: [""], messages: [], tools: [countingTool("bash", counter)] },
			{ model: mock.model, convertToLlm: identityConverter, fallbackManaged: true },
			undefined,
			mock.stream,
		);
		const results: Array<{ isError?: boolean; text: string }> = [];
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				results.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(counter.n).toBe(0);
		expect(results).toEqual([{ isError: false, text: "provider output" }]);
	});

	it("uses the provider outcome without running local hooks", async () => {
		const counter = { n: 0 };
		let beforeCalls = 0;
		let afterCalls = 0;
		const mock = createMockModel({
			provider: "cursor",
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-1",
							name: "bash",
							arguments: {},
							providerExecuted: "cursor-exec",
							providerExecutionResult: { status: "error", output: "provider rejected" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const model = mock.model;
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [countingTool("bash", counter)] };
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{
				model,
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					beforeCalls += 1;
				},
				afterToolCall: async () => {
					afterCalls += 1;
				},
			},
			undefined,
			mock.stream,
		);
		const results: Array<{ isError?: boolean; text: string }> = [];
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				results.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		expect(counter.n).toBe(0);
		expect(beforeCalls).toBe(0);
		expect(afterCalls).toBe(0);
		expect(results).toEqual([{ isError: true, text: "provider rejected" }]);
	});
});
