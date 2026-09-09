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
	for (const tail of ["assistant", "toolResult"] as const) {
		for (const mode of ["steering", "followUp"] as const) {
			for (const rejection of ["no model", "maintenance owner"] as const) {
				it(`restores ${mode} identities after ${rejection} rejection with a ${tail} tail`, async () => {
					const mock = createMockModel({ handler: () => ({ content: ["resumed"] }) });
					const agent = new Agent({ streamFn: mock.stream });
					const model = agent.state.model;
					agent.replaceMessages([tail === "assistant" ? assistantMessage() : toolResultMessage()]);
					agent.setSteeringMode("one-at-a-time");
					agent.setFollowUpMode("one-at-a-time");
					const first = userMessage();
					const duplicate = userMessage();
					const unrelated = { ...userMessage(), content: "unrelated" };
					if (mode === "steering") {
						agent.restoreSteering([first, duplicate]);
						agent.followUp(unrelated);
					} else {
						agent.followUp(first);
						agent.followUp(duplicate);
						agent.followUp(unrelated);
					}
					const before = agent.snapshotQueues();
					const accepted: AgentMessage[][] = [];
					const committed: AgentMessage[][] = [];
					agent.onFollowUpConsumed = (messages, promotion) => {
						const commit = () => committed.push([...messages]);
						if (promotion?.deferUntilAccepted) promotion.deferUntilAccepted(commit);
						else commit();
					};
					const resume =
						tail === "assistant" ? agent.continue.bind(agent) : agent.continueQueuedMessages.bind(agent);
					if (rejection === "no model") agent.setModel(undefined);
					await expect(
						resume({
							maintenanceContinuation: rejection === "maintenance owner",
							onRunAccepted: (_handle, acceptance) => accepted.push([...acceptance.consumedQueuedMessages]),
						}),
					).rejects.toThrow(
						rejection === "no model"
							? "No model configured"
							: "Maintenance continuation ownership is unavailable",
					);
					expect(accepted).toEqual([]);
					expect(committed).toEqual([]);
					expect(mock.calls).toHaveLength(0);
					for (const queue of ["steering", "followUp"] as const) {
						const restored = agent.snapshotQueues()[queue];
						expect(restored).toHaveLength(before[queue].length);
						for (const [index, message] of before[queue].entries()) expect(restored[index]).toBe(message);
					}
					agent.setModel(model);
					await resume({
						onRunAccepted: (_handle, acceptance) => {
							accepted.push([...acceptance.consumedQueuedMessages]);
							if (mode === "followUp") {
								expect(committed).toHaveLength(1);
								expect(committed[0]?.[0]).toBe(first);
							}
						},
					});
					expect(accepted).toHaveLength(1);
					expect(accepted[0]).toHaveLength(1);
					expect(accepted[0]?.[0]).toBe(first);
					expect(agent.hasQueuedMessages()).toBe(false);
					expect(committed.flat()).toEqual(mode === "followUp" ? [first, duplicate, unrelated] : [unrelated]);
					expect(
						agent.state.messages.filter(message => message.role === "user").map(message => message.content),
					).toEqual(["resume", "resume", "unrelated"]);
				});
			}
		}
	}

	for (const tail of ["assistant", "toolResult"] as const) {
		it(`admits the ${tail} follow-up synchronously before a filtering microtask removes the model`, async () => {
			const mock = createMockModel({ handler: () => ({ content: ["resumed"] }) });
			const agent = new Agent({ streamFn: mock.stream });
			agent.replaceMessages([tail === "assistant" ? assistantMessage() : toolResultMessage()]);
			const queued = userMessage();
			agent.followUp(queued);
			const events: string[] = [];
			agent.onFollowUpConsumed = (_messages, promotion) => {
				events.push("filtered");
				queueMicrotask(() => {
					events.push("model removed");
					agent.setModel(undefined);
				});
				promotion?.deferUntilAccepted?.(() => events.push("committed"));
			};
			const resume = tail === "assistant" ? agent.continue.bind(agent) : agent.continueQueuedMessages.bind(agent);
			const completion = resume({
				onRunAccepted: (_handle, acceptance) => {
					events.push("accepted");
					expect(acceptance.consumedQueuedMessages).toEqual([queued]);
				},
			});
			// No await here: both the commit and acceptance must precede the first
			// microtask, not merely happen eventually after provider work begins.
			expect(events).toEqual(["filtered", "committed", "accepted"]);
			await completion;
			expect(events).toEqual(["filtered", "committed", "accepted", "model removed"]);
			expect(mock.calls).toHaveLength(1);
			expect(agent.state.messages.filter(message => message === queued)).toHaveLength(1);
			expect(agent.hasQueuedMessages()).toBe(false);
		});
	}
	it("restores only surviving follow-ups ahead of new admissions after a filtering hook rejects", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["resumed"] }) });
		const agent = new Agent({ streamFn: mock.stream });
		agent.replaceMessages([toolResultMessage()]);
		agent.setFollowUpMode("one-at-a-time");
		const first = userMessage();
		const denied = { ...userMessage(), content: "denied" };
		const second = { ...userMessage(), content: "second" };
		const later = { ...userMessage(), content: "later" };
		agent.restoreFollowUp([first, denied, second]);
		agent.markFollowUpBatch([first, denied, second]);
		agent.onFollowUpConsumed = messages => {
			messages.splice(1, 1);
			agent.followUp(later);
			throw new Error("pre-admission hook rejected");
		};
		await expect(agent.continueQueuedMessages()).rejects.toThrow("pre-admission hook rejected");
		const restored = agent.snapshotFollowUp();
		expect(restored).toHaveLength(3);
		expect(restored[0]).toBe(first);
		expect(restored[1]).toBe(second);
		expect(restored[2]).toBe(later);
		expect(mock.calls).toHaveLength(0);
		agent.onFollowUpConsumed = undefined;
		const accepted: AgentMessage[][] = [];
		await agent.continueQueuedMessages({
			onRunAccepted: (_handle, acceptance) => accepted.push([...acceptance.consumedQueuedMessages]),
		});
		expect(accepted).toHaveLength(1);
		expect(accepted[0]).toHaveLength(2);
		expect(accepted[0]?.[0]).toBe(first);
		expect(accepted[0]?.[1]).toBe(second);
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages.filter(message => message.role === "user").map(message => message.content)).toEqual([
			"resume",
			"second",
			"later",
		]);
	});

	it("does not restore a claimed batch when its acceptance observer throws", async () => {
		const mock = createMockModel({ handler: () => ({ content: ["must not run"] }) });
		const agent = new Agent({ streamFn: mock.stream });
		agent.replaceMessages([toolResultMessage()]);
		agent.setFollowUpMode("one-at-a-time");
		const selected = userMessage();
		const unrelated = { ...userMessage(), content: "unrelated" };
		agent.followUp(selected);
		agent.followUp(unrelated);
		try {
			await expect(
				agent.continueQueuedMessages({
					onRunAccepted: (_handle, acceptance) => {
						expect(acceptance.consumedQueuedMessages).toHaveLength(1);
						expect(acceptance.consumedQueuedMessages[0]).toBe(selected);
						throw new Error("acceptance observer rejected");
					},
				}),
			).rejects.toThrow("acceptance observer rejected");
			expect(agent.snapshotFollowUp()).toHaveLength(1);
			expect(agent.snapshotFollowUp()[0]).toBe(unrelated);
			expect(mock.calls).toHaveLength(0);
		} finally {
			agent.forceAbort("release claimed test run");
			await agent.waitForIdle();
		}
	});

	for (const tail of ["assistant", "toolResult"] as const) {
		it(`preserves an explicit initial steering skip for follow-up continuation after ${tail}`, async () => {
			const mock = createMockModel({ handler: () => ({ content: ["response"] }) });
			const agent = new Agent({ streamFn: mock.stream });
			agent.replaceMessages([tail === "assistant" ? assistantMessage() : toolResultMessage()]);
			agent.followUp({ ...userMessage(), content: "selected follow-up" });
			const resume = tail === "assistant" ? agent.continue.bind(agent) : agent.continueQueuedMessages.bind(agent);
			await resume({
				skipInitialSteeringPoll: true,
				onRunAccepted: () => agent.steer({ ...userMessage(), content: "new steering" }),
			});
			expect(mock.calls).toHaveLength(2);
			expect(
				mock.calls[0]?.context.messages.filter(message => message.role === "user").map(message => message.content),
			).toEqual(["selected follow-up"]);
			expect(
				mock.calls[1]?.context.messages.filter(message => message.role === "user").map(message => message.content),
			).toEqual(["selected follow-up", "new steering"]);
		});
	}

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
