import { describe, expect, it } from "bun:test";
import { agentLoopContinue } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

// Bounded termination for argument-validation loops.
//
// The one-shot tools-free recovery turn fires first. If the model keeps
// emitting only malformed tool calls after it, the run must reach a
// deterministic terminal state instead of looping against the provider
// forever. The bound counts CONSECUTIVE all-malformed turns rather than
// repeated argument signatures, so a model rotating invalid shapes -- which
// never trips signature-based "repeated" detection -- is bounded too.

const toolSchema = z.object({ value: z.string() });
const RECOVERY_MARKER = "Do not call any tools";
/** Well above the production bound; only guards the test runner. */
const RUNAWAY_CAP = 60;

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

/** Every toolCall id must have a matching toolResult (provider API requirement). */
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

describe("malformed tool-call circuit breaker", () => {
	it("terminates a never-ending identical malformed loop", async () => {
		let executions = 0;
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool(() => (executions += 1))],
		};
		let calls = 0;
		// Always the SAME invalid arguments -> trips signature "repeated" every turn.
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				if (calls > RUNAWAY_CAP) return { content: ["runaway guard"] };
				return { content: [{ type: "toolCall" as const, id: `tool-${calls}`, name: "echo", arguments: {} }] };
			},
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		await stream.result();

		// The loop stopped on its own, well before the runaway guard.
		expect(calls).toBeLessThan(RUNAWAY_CAP);
		// It ended terminally rather than silently going quiet.
		const agentEnd = events.findLast(event => event.type === "agent_end");
		expect(agentEnd).toBeDefined();
		// The recovery turn still got its one chance before the breaker fired.
		expect(executions).toBe(0);
		assertToolPairing(context.messages);
		// The request-only synthetic never leaked into durable history.
		expect(countRecoveryPrompts(context.messages)).toBe(0);
	}, 30_000);

	it("terminates a rotating-signature malformed loop that never trips repeat detection", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		let calls = 0;
		// Every turn uses DIFFERENT invalid arguments, so the signature-overlap
		// heuristic never reports "repeated". Only a consecutive-turn bound stops this.
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				if (calls > RUNAWAY_CAP) return { content: ["runaway guard"] };
				return {
					content: [
						{ type: "toolCall" as const, id: `tool-${calls}`, name: "echo", arguments: { rotating: calls } },
					],
				};
			},
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		expect(calls).toBeLessThan(RUNAWAY_CAP);
		assertToolPairing(context.messages);
	}, 30_000);

	it("reports a terminal error explaining why the run stopped", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				if (calls > RUNAWAY_CAP) return { content: ["runaway guard"] };
				return { content: [{ type: "toolCall" as const, id: `tool-${calls}`, name: "echo", arguments: {} }] };
			},
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = (await stream.result()) as AgentMessage[];

		// The terminating assistant message carries a diagnosable reason.
		const last = produced.findLast(m => m.role === "assistant");
		expect(last).toBeDefined();
		if (last?.role !== "assistant") throw new Error("expected an assistant message");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("consecutive turns of malformed tool calls");
	}, 30_000);

	it("does not fire when the model recovers into a real answer", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: {} }] },
				{ content: [{ type: "toolCall", id: "tool-2", name: "echo", arguments: {} }] },
				// The recovery turn answers, as intended.
				{ content: ["recovered with a real answer"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = (await stream.result()) as AgentMessage[];

		// Normal completion: the breaker did not hijack a healthy recovery.
		const last = produced.findLast(m => m.role === "assistant");
		if (last?.role !== "assistant") throw new Error("expected an assistant message");
		expect(last.stopReason).not.toBe("error");
		expect(last.content.some(block => block.type === "text" && block.text === "recovered with a real answer")).toBe(
			true,
		);
		expect(mock.calls.length).toBe(3);
	});

	it("does not count healthy tool turns toward the bound", async () => {
		let executions = 0;
		const okTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "ok" }], details: { value: "ok" } };
			},
		};
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [okTool],
		};
		// Far more successful tool turns than the bound, then a normal answer.
		const responses = Array.from({ length: 12 }, (_v, i) => ({
			content: [{ type: "toolCall" as const, id: `tool-${i}`, name: "echo", arguments: { value: `v${i}` } }],
		}));
		const mock = createMockModel({ responses: [...responses, { content: ["all good"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = (await stream.result()) as AgentMessage[];

		// Every healthy tool call ran and the run completed normally.
		expect(executions).toBe(12);
		const last = produced.findLast(m => m.role === "assistant");
		if (last?.role !== "assistant") throw new Error("expected an assistant message");
		expect(last.stopReason).not.toBe("error");
	}, 30_000);
	it("resets malformed state after a healthy tool-free turn", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		let followUpDelivered = false;
		const malformedResponses = Array.from({ length: 8 }, (_value, index) => ({
			content: [
				{
					type: "toolCall" as const,
					id: `tool-${index}`,
					name: "echo",
					arguments: { rotating: index },
				},
			],
		}));
		const mock = createMockModel({
			responses: [
				...malformedResponses.slice(0, 4),
				{ content: ["healthy answer"] },
				...malformedResponses.slice(4),
				{ content: ["healthy follow-up answer"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getFollowUpMessages: async () => {
				if (followUpDelivered) return [];
				followUpDelivered = true;
				return [createUserMessage("continue")];
			},
		};

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = (await stream.result()) as AgentMessage[];

		expect(mock.calls.length).toBe(10);
		const last = produced.findLast(message => message.role === "assistant");
		if (last?.role !== "assistant") throw new Error("expected an assistant message");
		expect(last.stopReason).not.toBe("error");
		expect(last.content.some(block => block.type === "text" && block.text === "healthy follow-up answer")).toBe(true);
	});

	it("reports the malformed-loop breaker as terminal under managed fallback", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		const outcomes: string[] = [];
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				return {
					content: [
						{
							type: "toolCall" as const,
							id: `tool-${calls}`,
							name: "echo",
							arguments: { rotating: calls },
						},
					],
				};
			},
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome.type);
				return { type: "retry", continuation: () => {} };
			},
		};

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		expect(calls).toBeLessThan(RUNAWAY_CAP);
		expect(outcomes).toEqual(["run_terminal"]);
	});
	it("stops a single-model session without replaying the breaker", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [createUserMessage("echo something")],
			tools: [throwingTool()],
		};
		let calls = 0;
		const mock = createMockModel({
			handler: () => {
				calls += 1;
				return {
					content: [
						{
							type: "toolCall" as const,
							id: `tool-${calls}`,
							name: "echo",
							arguments: { rotating: calls },
						},
					],
				};
			},
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoopContinue(context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const produced = (await stream.result()) as AgentMessage[];

		// The one-entry/single-model path has no managed callback to classify the
		// synthetic breaker as terminal, so its message carries a non-retryable
		// invalid-request marker instead of being replayed as an unknown error.
		expect(calls).toBe(5);
		const last = produced.findLast(message => message.role === "assistant");
		if (last?.role !== "assistant") throw new Error("expected an assistant message");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("Invalid request:");
	}, 30_000);
});
