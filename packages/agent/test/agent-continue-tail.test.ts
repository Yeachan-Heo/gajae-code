import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, canContinuePersistedHistory } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createAssistantMessage } from "./helpers";

function userMessage() {
	return { role: "user" as const, content: "resume", timestamp: 1 };
}

function toolResultMessage() {
	return {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "tool",
		content: [{ type: "text" as const, text: "result" }],
		isError: false,
		timestamp: 1,
	};
}

function assistantMessage() {
	return createAssistantMessage([]);
}

describe("persisted continuation tail", () => {
	it("accepts user and tool-result tails but rejects empty and assistant tails", () => {
		expect(canContinuePersistedHistory([])).toBe(false);
		expect(canContinuePersistedHistory([userMessage()])).toBe(true);
		expect(canContinuePersistedHistory([toolResultMessage()])).toBe(true);
		expect(canContinuePersistedHistory([assistantMessage()])).toBe(false);
	});

	it("keeps assistant-tail queue handling separate from persisted-tail eligibility", async () => {
		const withoutQueue = new Agent();
		withoutQueue.replaceMessages([assistantMessage()]);
		await expect(withoutQueue.continue()).rejects.toThrow("Cannot continue from message role: assistant");

		const steeringMock = createMockModel({ responses: [{ content: ["steered"] }] });
		const withSteering = new Agent({ streamFn: steeringMock.stream });
		withSteering.replaceMessages([assistantMessage()]);
		withSteering.restoreSteering([userMessage()]);
		await expect(withSteering.continue()).resolves.toBeUndefined();
		expect(withSteering.hasQueuedSteering()).toBe(false);

		const followUpMock = createMockModel({ responses: [{ content: ["followed up"] }] });
		const withFollowUp = new Agent({ streamFn: followUpMock.stream });
		withFollowUp.replaceMessages([assistantMessage()]);
		withFollowUp.followUp(userMessage());
		await expect(withFollowUp.continue()).resolves.toBeUndefined();
		expect(withFollowUp.hasQueuedMessages()).toBe(false);
	});

	it("routes the direct-dequeue follow-up batch through onFollowUpConsumed before the loop", async () => {
		const consumed: AgentMessage[][] = [];
		const seen: string[] = [];
		const mock = createMockModel({
			handler: context => {
				for (const message of context.messages) {
					if (typeof message.content === "string") seen.push(message.content);
				}
				return { content: ["resumed"] };
			},
		});
		const agent = new Agent({
			streamFn: mock.stream,
			onFollowUpConsumed: messages => consumed.push([...messages]),
		});
		agent.replaceMessages([assistantMessage()]);
		const queued = userMessage();
		agent.followUp(queued);
		await agent.continue();
		// The direct-dequeue path (agent.ts continue) must invoke the same
		// consumption hook the in-loop getFollowUpMessages path uses, so
		// owned-completion settlement and denial filtering apply there too
		// (review threads P1/P2).
		expect(consumed).toHaveLength(1);
		expect(consumed[0]).toContainEqual(queued);
		expect(seen).toContain("resume");
	});

	it("filters messages removed by onFollowUpConsumed before the loop sees them", async () => {
		const seen: string[] = [];
		const mock = createMockModel({
			handler: context => {
				for (const message of context.messages) {
					if (typeof message.content === "string") seen.push(message.content);
				}
				return { content: ["resumed"] };
			},
		});
		const agent = new Agent({
			streamFn: mock.stream,
			onFollowUpConsumed: messages => {
				// Mirror the owned-completion drop filter: denied envelopes are
				// spliced out of the batch in place.
				for (let i = messages.length - 1; i >= 0; i--) {
					const message = messages[i];
					if (message.role === "user" && typeof message.content === "string" && message.content === "denied") {
						messages.splice(i, 1);
					}
				}
			},
		});
		agent.replaceMessages([assistantMessage()]);
		agent.followUp({ role: "user", content: "allowed", timestamp: 1 });
		agent.followUp({ role: "user", content: "denied", timestamp: 2 });
		await agent.continue();
		expect(seen).toContain("allowed");
		expect(seen).not.toContain("denied");
	});

	it("skips the loop entirely when onFollowUpConsumed empties the batch", async () => {
		// The hook can filter EVERY queued entry (all denied by a scope:"owned"
		// abort): continue() must not start an empty provider run against
		// existing history — the zero-final-call guarantee (review thread P1).
		const mock = createMockModel({
			handler: () => {
				throw new Error("loop must not run with an emptied batch");
			},
		});
		const agent = new Agent({
			streamFn: mock.stream,
			onFollowUpConsumed: messages => {
				messages.splice(0, messages.length);
			},
		});
		agent.replaceMessages([assistantMessage()]);
		agent.followUp(userMessage());
		await expect(agent.continue()).resolves.toBeUndefined();
		expect(mock.calls).toHaveLength(0);
	});

	it("routes the queued-tail follow-up batch through onFollowUpConsumed before the loop", async () => {
		// continueQueuedMessages() is selected when queued messages sit behind a
		// non-assistant (tool/result) tail — exactly the terminal-abort rearm
		// shape. It must invoke the same consumption hook as the assistant-tail
		// continue() path so owned-completion settlement and denial filtering
		// apply there too (review thread P2).
		const consumed: AgentMessage[][] = [];
		const seen: string[] = [];
		const mock = createMockModel({
			handler: context => {
				for (const message of context.messages) {
					if (typeof message.content === "string") seen.push(message.content);
				}
				return { content: ["resumed"] };
			},
		});
		const agent = new Agent({
			streamFn: mock.stream,
			onFollowUpConsumed: messages => consumed.push([...messages]),
		});
		agent.replaceMessages([toolResultMessage()]);
		const queued = userMessage();
		agent.followUp(queued);
		await agent.continueQueuedMessages();
		expect(consumed).toHaveLength(1);
		expect(consumed[0]).toContainEqual(queued);
		expect(seen).toContain("resume");
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("filters messages removed by onFollowUpConsumed in the queued-tail path before the loop sees them", async () => {
		const seen: string[] = [];
		const mock = createMockModel({
			handler: context => {
				for (const message of context.messages) {
					if (typeof message.content === "string") seen.push(message.content);
				}
				return { content: ["resumed"] };
			},
		});
		const agent = new Agent({
			streamFn: mock.stream,
			onFollowUpConsumed: messages => {
				for (let i = messages.length - 1; i >= 0; i--) {
					const message = messages[i];
					if (message.role === "user" && typeof message.content === "string" && message.content === "denied") {
						messages.splice(i, 1);
					}
				}
			},
		});
		agent.replaceMessages([toolResultMessage()]);
		agent.followUp({ role: "user", content: "allowed", timestamp: 1 });
		agent.followUp({ role: "user", content: "denied", timestamp: 2 });
		await agent.continueQueuedMessages();
		expect(seen).toContain("allowed");
		expect(seen).not.toContain("denied");
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("skips the queued-tail loop entirely when onFollowUpConsumed empties the batch", async () => {
		const mock = createMockModel({
			handler: () => {
				throw new Error("loop must not run with an emptied batch");
			},
		});
		const agent = new Agent({
			streamFn: mock.stream,
			onFollowUpConsumed: messages => {
				messages.splice(0, messages.length);
			},
		});
		agent.replaceMessages([toolResultMessage()]);
		agent.followUp(userMessage());
		await expect(agent.continueQueuedMessages()).resolves.toBeUndefined();
		expect(mock.calls).toHaveLength(0);
		expect(agent.hasQueuedMessages()).toBe(false);
	});
});
