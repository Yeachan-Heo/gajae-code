import { describe, expect, it } from "bun:test";
import { agentLoopContinue } from "@gajae-code/agent-core/agent-loop";
import { AppendOnlyContextManager } from "@gajae-code/agent-core/append-only-context";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { Context, Message, ToolChoice } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

// Adversarial / red-team coverage for the repeated-malformed-tool-call recovery
// turn (PR #3169). These tests try to BREAK the three contracted behaviors:
//
//   1. the recovery synthetic is request-only and never reaches durable state
//   2. append-only prefix identity and log stay intact across recovery
//   3. recovery forces `toolChoice: "none"`, never consumes the queue-backed
//      `getToolChoice`, and never executes a tool
//
// Every assertion uses a public surface. Durable-history assertions go through
// `agentLoopContinue`, which shares the caller's `messages` array; `agentLoop`
// copies it (`agent-loop.ts:291`) and would make such assertions vacuous.

const RECOVERY_MARKER = "Do not call any tools";
const toolSchema = z.object({ value: z.string() });

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function throwingTool(onExecute?: () => void): AgentTool<typeof toolSchema, Record<string, never>> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: toolSchema,
		async execute() {
			onExecute?.();
			throw new Error("invalid calls must not execute");
		},
	};
}

function countRecoveryPrompts(messages: readonly (AgentMessage | Message)[]): number {
	return messages.filter(m => "content" in m && typeof m.content === "string" && m.content.includes(RECOVERY_MARKER))
		.length;
}

/** Every toolCall id in an assistant message must have a matching toolResult. */
function assertToolPairing(messages: readonly AgentMessage[]): void {
	const calledIds: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") calledIds.push(block.id);
		}
	}
	const resultIds = new Set(
		messages.filter(m => m.role === "toolResult").map(m => (m as { toolCallId: string }).toolCallId),
	);
	for (const id of calledIds) {
		expect(resultIds.has(id)).toBe(true);
	}
}

async function drain(stream: AsyncIterable<unknown> & { result(): Promise<unknown> }): Promise<void> {
	for await (const _event of stream) {
		// consume
	}
	await stream.result();
}

const malformedCall = (id: string) => ({ type: "toolCall" as const, id, name: "echo", arguments: {} });

describe("redteam: synthetic leakage under stress", () => {
	it("keeps the synthetic out of durable state across chained continuations", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const appendOnlyContext = new AppendOnlyContextManager();
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				{ content: ["recovered"] },
				{ content: ["second run answer"] },
				{ content: ["third run answer"] },
			],
		});
		const requests: Context[] = [];
		const config: AgentLoopConfig = { model: mock, appendOnlyContext, convertToLlm: identityConverter };
		const capture = (...args: Parameters<typeof mock.stream>) => {
			requests.push(args[1]);
			return mock.stream(...args);
		};

		await drain(agentLoopContinue(context, config, undefined, capture));
		// The recovery turn genuinely happened.
		expect(requests.some(request => countRecoveryPrompts(request.messages) === 1)).toBe(true);

		// Two further continuations reusing the SAME append-only manager.
		context.messages.push(createUserMessage("again"));
		await drain(agentLoopContinue(context, config, undefined, capture));
		context.messages.push(createUserMessage("and again"));
		await drain(agentLoopContinue(context, config, undefined, capture));

		// The synthetic never reached durable history or the durable log.
		expect(countRecoveryPrompts(context.messages)).toBe(0);
		expect(countRecoveryPrompts(appendOnlyContext.log.entries())).toBe(0);
		// And no later request replays it.
		for (const request of requests.slice(3)) {
			expect(countRecoveryPrompts(request.messages)).toBe(0);
		}
		assertToolPairing(context.messages);
	});

	it("keeps the synthetic out of durable state when steering arrives after recovery", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				{ content: ["recovered"] },
				{ content: ["post-steering answer"] },
			],
		});
		const requests: Context[] = [];
		let steered = false;
		const config: AgentLoopConfig = {
			model: mock,
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				if (steered) return [];
				steered = true;
				return [createUserMessage("steering after recovery")];
			},
		};

		await drain(
			agentLoopContinue(context, config, undefined, (...args: Parameters<typeof mock.stream>) => {
				requests.push(args[1]);
				return mock.stream(...args);
			}),
		);

		expect(steered).toBe(true);
		expect(requests.some(request => countRecoveryPrompts(request.messages) === 1)).toBe(true);
		expect(countRecoveryPrompts(context.messages)).toBe(0);
		assertToolPairing(context.messages);
	});
});

describe("redteam: one-shot recovery bound", () => {
	it("does not fire a second tools-free turn for a later malformed batch in the same run", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const mock = createMockModel({
			responses: [
				// First repeated-malformed batch -> arms recovery.
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				// Recovery turn (tools hidden). Model answers.
				{ content: ["recovered once"] },
				// A second repeated-malformed batch after recovery.
				{ content: [malformedCall("tool-3")] },
				{ content: [malformedCall("tool-4")] },
				{ content: ["final answer"] },
			],
		});
		const requests: Context[] = [];
		const config: AgentLoopConfig = { model: mock, convertToLlm: identityConverter };

		await drain(
			agentLoopContinue(context, config, undefined, (...args: Parameters<typeof mock.stream>) => {
				requests.push(args[1]);
				return mock.stream(...args);
			}),
		);

		// Recovery is one-shot: exactly ONE request ever carried the synthetic,
		// and exactly one request had tools suppressed.
		const recoveryRequests = requests.filter(request => countRecoveryPrompts(request.messages) > 0);
		expect(recoveryRequests.length).toBe(1);
		expect(requests.filter(request => request.tools?.length === 0).length).toBe(1);

		// The run terminated rather than wedging, and pairing survived.
		expect(countRecoveryPrompts(context.messages)).toBe(0);
		assertToolPairing(context.messages);
	});
});

describe("redteam: tool-choice integrity", () => {
	it("consumes no queue entry for recovery and hands it to the next ordinary request", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		// A genuinely queue-CONSUMING getter: each call removes an entry.
		const queue: ToolChoice[] = ["required", "auto"];
		const getterCalls: number[] = [];
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				{ content: ["recovered"] },
				{ content: ["next ordinary answer"] },
			],
		});
		const requests: Context[] = [];
		const toolChoices: unknown[] = [];
		const config: AgentLoopConfig = {
			model: mock,
			convertToLlm: identityConverter,
			getToolChoice: () => {
				getterCalls.push(queue.length);
				return queue.shift();
			},
		};
		const capture = (...args: Parameters<typeof mock.stream>) => {
			requests.push(args[1]);
			toolChoices.push(args[2]?.toolChoice);
			return mock.stream(...args);
		};

		await drain(agentLoopContinue(context, config, undefined, capture));

		const recoveryIndex = requests.findIndex(request => countRecoveryPrompts(request.messages) > 0);
		expect(recoveryIndex).toBeGreaterThanOrEqual(0);
		// The recovery request forced "none" and its tools were suppressed.
		expect(toolChoices[recoveryIndex]).toBe("none");
		expect(requests[recoveryIndex]?.tools).toEqual([]);

		// The getter fired once per NON-recovery request only.
		expect(getterCalls.length).toBe(requests.length - 1);
		// Two entries were queued and only the two ordinary requests took them,
		// in order: nothing was silently swallowed by recovery.
		expect(toolChoices.filter(choice => choice !== "none")).toEqual(["required", "auto"]);
	});

	it("overrides a static required tool choice on the recovery request only", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				{ content: ["recovered"] },
			],
		});
		const requests: Context[] = [];
		const toolChoices: unknown[] = [];
		const config: AgentLoopConfig = {
			model: mock,
			convertToLlm: identityConverter,
			toolChoice: "required",
		};

		await drain(
			agentLoopContinue(context, config, undefined, (...args: Parameters<typeof mock.stream>) => {
				requests.push(args[1]);
				toolChoices.push(args[2]?.toolChoice);
				return mock.stream(...args);
			}),
		);

		const recoveryIndex = requests.findIndex(request => countRecoveryPrompts(request.messages) > 0);
		expect(toolChoices[recoveryIndex]).toBe("none");
		// Ordinary requests keep the static forced choice.
		for (let i = 0; i < toolChoices.length; i++) {
			if (i !== recoveryIndex) expect(toolChoices[i]).toBe("required");
		}
	});
});

describe("redteam: tool execution containment", () => {
	it("executes nothing and pairs every call when recovery emits multiple tool calls", async () => {
		let executions = 0;
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool(() => (executions += 1))],
		};
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				// Recovery response illegally emits SEVERAL calls, including one
				// naming a tool that does not exist.
				{
					content: [
						{ type: "toolCall", id: "tool-3", name: "echo", arguments: { value: "a" } },
						{ type: "toolCall", id: "tool-4", name: "echo", arguments: { value: "b" } },
						{ type: "toolCall", id: "tool-5", name: "ghost", arguments: { value: "c" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock, convertToLlm: identityConverter };

		await drain(agentLoopContinue(context, config, undefined, mock.stream));

		// No tool ran during the recovery turn.
		expect(executions).toBe(0);
		// Every emitted call got a paired result, including the unknown tool.
		for (const id of ["tool-3", "tool-4", "tool-5"]) {
			expect(context.messages.some(m => m.role === "toolResult" && m.toolCallId === id)).toBe(true);
		}
		assertToolPairing(context.messages);
		expect(countRecoveryPrompts(context.messages)).toBe(0);
	});
});

describe("redteam: append-only prefix integrity", () => {
	it("holds prefix identity across recovery and keeps the log usable next turn", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const appendOnlyContext = new AppendOnlyContextManager();
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				{ content: ["recovered"] },
				{ content: ["ordinary answer"] },
			],
		});
		const requests: Context[] = [];
		const config: AgentLoopConfig = { model: mock, appendOnlyContext, convertToLlm: identityConverter };
		const capture = (...args: Parameters<typeof mock.stream>) => {
			requests.push(args[1]);
			return mock.stream(...args);
		};

		await drain(agentLoopContinue(context, config, undefined, capture));

		const recoveryIndex = requests.findIndex(request => countRecoveryPrompts(request.messages) > 0);
		expect(recoveryIndex).toBeGreaterThanOrEqual(0);
		expect(requests[recoveryIndex]?.tools).toEqual([]);

		const fingerprintAfterRecovery = appendOnlyContext.prefix.fingerprint;
		const versionAfterRecovery = appendOnlyContext.prefix.version;

		// An ordinary turn on the same manager, with tools restored.
		context.messages.push(createUserMessage("follow-up"));
		await drain(agentLoopContinue(context, config, undefined, capture));

		// Recovery did not bust the frozen tool prefix: the ordinary turn after
		// recovery reuses the very same prefix identity.
		expect(appendOnlyContext.prefix.fingerprint).toBe(fingerprintAfterRecovery);
		expect(appendOnlyContext.prefix.version).toBe(versionAfterRecovery);
		// The ordinary request got real tools back.
		expect(requests.at(-1)?.tools?.length).toBe(1);
		// The log matches what the last ordinary request actually sent.
		expect(countRecoveryPrompts(appendOnlyContext.log.entries())).toBe(0);
		expect(appendOnlyContext.log.entries()).toEqual(requests.at(-1)?.messages ?? []);
	});
});

describe("redteam: managed fallback interaction", () => {
	it("commits the recovery assistant exactly once under managed fallback", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const mock = createMockModel({
			responses: [
				{ content: [malformedCall("tool-1")] },
				{ content: [malformedCall("tool-2")] },
				{ content: ["managed recovery answer"] },
			],
		});
		const requests: Context[] = [];
		const config: AgentLoopConfig = {
			model: mock,
			convertToLlm: identityConverter,
			fallbackManaged: true,
		};

		const stream = agentLoopContinue(context, config, undefined, (...args: Parameters<typeof mock.stream>) => {
			requests.push(args[1]);
			return mock.stream(...args);
		});
		await Array.fromAsync(stream);
		const produced = (await stream.result()) as AgentMessage[];

		// The recovery turn happened, and the answer is present exactly once.
		expect(requests.some(request => countRecoveryPrompts(request.messages) === 1)).toBe(true);
		const answers = produced.filter(
			m => m.role === "assistant" && m.content.some(b => b.type === "text" && b.text === "managed recovery answer"),
		);
		expect(answers.length).toBe(1);
		// No orphaned results, no synthetic in durable state.
		assertToolPairing(context.messages);
		expect(countRecoveryPrompts(context.messages)).toBe(0);
	});
});
