import { describe, expect, it } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** A run parked inside a tool call, so steer() has a live run to admit into. */
function liveRunHarness() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Parks until released",
		parameters: z.object({}),
		execute: async () => {
			entered.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "done" }] };
		},
	};
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", name: "wait", arguments: {} }] }],
		handler: { content: ["reply"] },
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [waitTool], messages: [] },
		streamFn: mock.stream,
	});
	return { agent, mock, entered: entered.promise, release: () => release.resolve() };
}

describe("Agent steering admission", () => {
	it("rejects a steer when no run is live and queues nothing", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		expect(agent.steer(userMessage("before any run"))).toEqual({ admitted: false, reason: "idle" });
		expect(agent.hasQueuedSteering()).toBe(false);

		await agent.prompt("first");
		// Turn is over: a late steer must not park in a queue nobody owns.
		expect(agent.steer(userMessage("late"))).toEqual({ admitted: false, reason: "idle" });
		expect(agent.hasQueuedSteering()).toBe(false);
		await agent.prompt("second");
		expect(mock.calls[1]!.context.messages.filter(m => m.role === "user")).toHaveLength(2);
	});

	it("admits a steer into a live run and reports its run id", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		await h.entered;
		const admission = h.agent.steer(userMessage("mid-run"));
		expect(admission.admitted).toBe(true);
		if (admission.admitted) expect(admission.runId).toBe(h.agent.activeRunId ?? -1);
		expect(h.agent.hasQueuedSteering()).toBe(true);
		h.release();
		await run;
		expect(h.agent.hasQueuedSteering()).toBe(false);
	});

	it("commits a steering cohort in one step under the default one-at-a-time mode", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		await h.entered;

		const head = userMessage("cohort head");
		const tail = userMessage("cohort tail");
		expect(h.agent.steerCohort([head, tail]).admitted).toBe(true);
		expect(h.agent.snapshotSteering()).toEqual([head, tail]);

		h.release();
		await run;

		// The cohort is committed as one unit: both messages reach the same request
		// even though the default mode takes one steering record per step.
		const index = h.agent.state.messages.indexOf(head);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(h.agent.state.messages[index + 1]).toBe(tail);
		expect(
			h.mock.calls.some(call => call.context.messages.includes(head) && call.context.messages.includes(tail)),
		).toBe(true);
	});

	it("reports a steering cohort only while its members stay contiguous", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		await h.entered;
		const head = userMessage("reported head");
		const tail = userMessage("reported tail");
		expect(h.agent.steerCohort([head, tail]).admitted).toBe(true);

		const queued = h.agent.snapshotSteering();
		expect([...h.agent.steeringCohorts(queued).keys()]).toEqual([head, tail]);
		// A partial or reordered list is no longer the cohort, so a caller that
		// re-routes one cannot claim an atomic unit it does not have.
		expect(h.agent.steeringCohorts([tail, head]).size).toBe(0);
		expect(h.agent.steeringCohorts([head]).size).toBe(0);
		expect(h.agent.steeringCohorts([tail]).size).toBe(0);
		expect(h.agent.steeringCohorts([head, userMessage("unrelated")]).size).toBe(0);

		h.release();
		await run;
	});

	it("rejects a steer once the live run's signal is aborted", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		await h.entered;
		h.agent.abort();
		expect(h.agent.steer(userMessage("too late"))).toEqual({ admitted: false, reason: "aborting" });
		expect(h.agent.hasQueuedSteering()).toBe(false);
		h.release();
		await run;
	});

	it("disowns unconsumed steering on agent_end and clears the queue", async () => {
		const h = liveRunHarness();
		const ends: Array<{ disowned: string[] }> = [];
		h.agent.subscribe(event => {
			if (event.type === "agent_end")
				ends.push({
					disowned: (event.disownedSteering ?? []).map(m => (m.role === "user" ? String(m.content) : m.role)),
				});
		});
		const run = h.agent.prompt("go");
		await h.entered;
		expect(h.agent.steer(userMessage("admitted then abandoned")).admitted).toBe(true);
		// Abort while the tool is parked: the loop exits without polling again.
		h.agent.abort();
		h.release();
		await run;
		expect(ends).toEqual([{ disowned: ["admitted then abandoned"] }]);
		expect(h.agent.hasQueuedSteering()).toBe(false);
		// No later run can pick it up.
		await h.agent.prompt("next");
		const lastCall = h.mock.calls.at(-1)!;
		expect(lastCall.context.messages.some(m => JSON.stringify(m.content).includes("abandoned"))).toBe(false);
	});

	it("disowns fenced steering too: the Agent never keeps an ended run's queue", async () => {
		const h = liveRunHarness();
		h.agent.setSteeringAdmissionFence(() => true);
		const disowned: string[] = [];
		h.agent.subscribe(event => {
			if (event.type === "agent_end")
				for (const message of event.disownedSteering ?? [])
					disowned.push(message.role === "user" ? String(message.content) : message.role);
		});
		const run = h.agent.prompt("go");
		await h.entered;
		expect(h.agent.steer(userMessage("held for the wake turn")).admitted).toBe(true);
		h.release();
		await run;
		expect(disowned).toEqual(["held for the wake turn"]);
		expect(h.agent.hasQueuedSteering()).toBe(false);
	});

	it("reports queued steering distinctly from follow-ups", () => {
		const agent = new Agent();
		expect(agent.hasQueuedSteering()).toBe(false);
		agent.followUp(userMessage("follow-up"));
		expect(agent.hasQueuedSteering()).toBe(false);
		expect(agent.hasQueuedMessages()).toBe(true);
		agent.restoreSteering([userMessage("steer")]);
		expect(agent.hasQueuedSteering()).toBe(true);
	});

	it("snapshots steering without mutating the queue", () => {
		const agent = new Agent();
		agent.restoreSteering([userMessage("a"), userMessage("b")]);
		const snap = agent.snapshotSteering();
		expect(snap).toHaveLength(2);
		expect(agent.hasQueuedSteering()).toBe(true);
		expect(agent.snapshotSteering()).toHaveLength(2);
	});

	it("restores snapshotted steering ahead of newly queued messages", () => {
		const agent = new Agent();
		agent.restoreSteering([userMessage("a")]);
		const snap = agent.snapshotSteering();
		agent.clearSteeringQueue();
		expect(agent.hasQueuedSteering()).toBe(false);
		agent.restoreSteering([userMessage("b")]);
		agent.restoreSteering(snap);
		const after = agent.snapshotSteering();
		expect(after).toHaveLength(2);
		expect(after[0]).toMatchObject({ content: "a" });
		expect(after[1]).toMatchObject({ content: "b" });
	});

	it("waitForSteeringArrival resolves only on a NEW arrival or abort, never on a pre-queued steer", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const arrival = new AbortController();
		const stale = new AbortController();
		const controller = new AbortController();
		try {
			await h.entered;
			const pending = h.agent.waitForSteeringArrival(arrival.signal);
			expect(h.agent.steer(userMessage("arrived")).admitted).toBe(true);
			await pending;
			expect(h.agent.hasQueuedSteering()).toBe(true);

			// Already queued: a fresh wait must NOT resolve (a stale message must not
			// interrupt the next observation window); only abort settles it.
			let staleResolved = false;
			const staleWait = h.agent.waitForSteeringArrival(stale.signal).then(() => {
				staleResolved = true;
			});
			// Let an incorrectly settled wait's callbacks run without a timed delay.
			await scheduler.yield();
			expect(staleResolved).toBe(false);
			stale.abort();
			await staleWait;

			h.agent.clearSteeringQueue();
			const abortable = h.agent.waitForSteeringArrival(controller.signal);
			controller.abort();
			await abortable;
			expect(h.agent.hasQueuedSteering()).toBe(false);
		} finally {
			arrival.abort();
			stale.abort();
			controller.abort();
			h.release();
			await run;
		}
	});

	it("steeringMode all batches adjacent steers and isolates a sequential-marked one", async () => {
		const h = liveRunHarness();
		h.agent.setSteeringMode("all");
		const run = h.agent.prompt("go");
		await h.entered;
		// Two adjacent unmarked steers on EITHER side of one marked steer: a
		// regression to one-at-a-time would split the pairs, so the per-call
		// batches below distinguish batching from sequential draining.
		for (const text of ["a", "b"]) expect(h.agent.steer(userMessage(text)).admitted).toBe(true);
		expect(h.agent.steer(userMessage("solo"), { forceOneAtATime: true }).admitted).toBe(true);
		for (const text of ["c", "d"]) expect(h.agent.steer(userMessage(text)).admitted).toBe(true);
		h.release();
		await run;
		// New user messages contributed by each model call, in order.
		const perCall: string[][] = [];
		let seen = 0;
		for (const call of h.mock.calls) {
			const users = call.context.messages.filter(m => m.role === "user").map(m => String(m.content));
			perCall.push(users.slice(seen));
			seen = users.length;
		}
		// call 1: the prompt; call 2 (after the tool): [a, b]; call 3: [solo]; call 4: [c, d].
		expect(perCall.slice(1)).toEqual([["a", "b"], ["solo"], ["c", "d"]]);
	});

	it("restoreSteering is a no-op for an empty snapshot", () => {
		const agent = new Agent();
		agent.restoreSteering([userMessage("b")]);
		agent.restoreSteering([]);
		expect(agent.snapshotSteering()).toHaveLength(1);
	});

	it("snapshots follow-ups without mutating the queue", () => {
		const agent = new Agent();
		agent.followUp(userMessage("a"));
		agent.followUp(userMessage("b"));
		expect(agent.snapshotFollowUp()).toHaveLength(2);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.snapshotFollowUp()).toHaveLength(2);
	});

	it("restores snapshotted follow-ups ahead of newly queued messages", () => {
		const agent = new Agent();
		agent.followUp(userMessage("a"));
		const snap = agent.snapshotFollowUp();
		agent.clearFollowUpQueue();
		expect(agent.hasQueuedMessages()).toBe(false);
		agent.followUp(userMessage("b"));
		agent.restoreFollowUp(snap);
		const after = agent.snapshotFollowUp();
		expect(after).toHaveLength(2);
		expect(after[0]).toMatchObject({ content: "a" });
		expect(after[1]).toMatchObject({ content: "b" });
	});

	it("delivers a marked follow-up cohort atomically under one-at-a-time mode", async () => {
		const mock = createMockModel({ responses: [{ content: ["seeded"] }, { content: ["batched"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		await agent.prompt("seed");
		const cohort = [userMessage("a"), userMessage("b")];
		agent.markFollowUpBatch(cohort);
		agent.restoreFollowUp(cohort);
		await agent.continueQueuedMessages();

		const users = mock.calls[1]!.context.messages.filter(message => message.role === "user");
		expect(users.slice(-2).map(message => message.content)).toEqual(["a", "b"]);
		expect(mock.calls).toHaveLength(2);
	});

	it("removal of a queued steer does NOT resolve waitForSteeringArrival", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const arrival = new AbortController();
		const controller = new AbortController();
		try {
			await h.entered;
			// Enqueue a steer
			const msg = userMessage("steer");
			expect(h.agent.steer(msg).admitted).toBe(true);
			expect(h.agent.snapshotSteering()).toHaveLength(1);

			// Start waiting AFTER the steer is queued
			let waitResolved = false;
			const waitPromise = h.agent.waitForSteeringArrival(controller.signal).then(() => {
				waitResolved = true;
			});

			// Remove the steer
			h.agent.removeSteerAt(0);
			expect(h.agent.snapshotSteering()).toHaveLength(0);

			// Wait should NOT resolve
			await scheduler.yield();
			expect(waitResolved).toBe(false);

			// Abort to clean up
			controller.abort();
			await waitPromise;
		} finally {
			arrival.abort();
			controller.abort();
			h.release();
			await run;
		}
	});

	it("moving a queued steer at the same index does NOT resolve waitForSteeringArrival or queue-change waiter", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		const queueChangeController = new AbortController();
		try {
			await h.entered;
			// Enqueue a steer
			const msg = userMessage("steer");
			expect(h.agent.steer(msg).admitted).toBe(true);

			// Start waiting AFTER the steer is queued
			let arrivalResolved = false;
			const arrivalPromise = h.agent.waitForSteeringArrival(controller.signal).then(() => {
				arrivalResolved = true;
			});

			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(queueChangeController.signal).then(() => {
				queueChangeResolved = true;
			});

			// Move to same index (no-op move)
			const success = h.agent.moveSteer(0, 0);
			expect(success).toBe(true);

			// Neither waiter should resolve
			await scheduler.yield();
			expect(arrivalResolved).toBe(false);
			expect(queueChangeResolved).toBe(false);

			// Abort to clean up
			controller.abort();
			queueChangeController.abort();
			await arrivalPromise;
			await queueChangePromise;
		} finally {
			controller.abort();
			queueChangeController.abort();
			h.release();
			await run;
		}
	});

	it("moving a queued steer to a different index resolves queue-change waiter but NOT waitForSteeringArrival", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		const queueChangeController = new AbortController();
		try {
			await h.entered;
			// Enqueue two steers
			const msg1 = userMessage("steer1");
			const msg2 = userMessage("steer2");
			expect(h.agent.steer(msg1).admitted).toBe(true);
			expect(h.agent.steer(msg2).admitted).toBe(true);

			// Start waiting AFTER the steers are queued
			let arrivalResolved = false;
			const arrivalPromise = h.agent.waitForSteeringArrival(controller.signal).then(() => {
				arrivalResolved = true;
			});

			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(queueChangeController.signal).then(() => {
				queueChangeResolved = true;
			});

			// Move first steer to end
			const success = h.agent.moveSteer(0, 1);
			expect(success).toBe(true);

			// Queue-change waiter should resolve, but not arrival waiter
			await scheduler.yield();
			expect(arrivalResolved).toBe(false);
			expect(queueChangeResolved).toBe(true);

			// Arrival waiter still doesn't resolve
			controller.abort();
			await arrivalPromise;
			await queueChangePromise;

			// Verify the queue order changed
			const queued = h.agent.snapshotSteering();
			expect(queued[0]).toBe(msg2);
			expect(queued[1]).toBe(msg1);
		} finally {
			controller.abort();
			queueChangeController.abort();
			h.release();
			await run;
		}
	});

	it("a new enqueue still resolves waitForSteeringArrival", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Start waiting with no queued messages
			let waitResolved = false;
			const waitPromise = h.agent.waitForSteeringArrival(controller.signal).then(() => {
				waitResolved = true;
			});

			// Wait a bit to ensure nothing happens on its own
			await scheduler.yield();
			expect(waitResolved).toBe(false);

			// Now enqueue a new steer
			const msg = userMessage("arrived");
			expect(h.agent.steer(msg).admitted).toBe(true);

			// Wait should resolve
			await waitPromise;
			expect(waitResolved).toBe(true);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter resolves when a message is removed", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Enqueue a steer
			const msg = userMessage("steer");
			expect(h.agent.steer(msg).admitted).toBe(true);

			// Start waiting AFTER the steer is queued
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			// Wait a bit to ensure nothing happens on its own
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Remove the steer
			h.agent.removeSteerAt(0);

			// Wait should resolve
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter resolves when clearSteeringQueue() removes messages", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Enqueue a steer
			const msg = userMessage("steer");
			expect(h.agent.steer(msg).admitted).toBe(true);

			// Start waiting AFTER the steer is queued
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			// Wait a bit to ensure nothing happens on its own
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Clear the steering queue
			h.agent.clearSteeringQueue();

			// Wait should resolve
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter resolves when clearFollowUpQueue() removes messages", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Enqueue a follow-up
			const msg = userMessage("follow-up");
			h.agent.followUp(msg);

			// Start waiting AFTER the follow-up is queued
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			// Wait a bit to ensure nothing happens on its own
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Clear the follow-up queue
			h.agent.clearFollowUpQueue();

			// Wait should resolve
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter resolves when clearAllQueues() removes messages", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Enqueue both a steer and a follow-up
			const steerMsg = userMessage("steer");
			const followUpMsg = userMessage("follow-up");
			expect(h.agent.steer(steerMsg).admitted).toBe(true);
			h.agent.followUp(followUpMsg);

			// Start waiting AFTER messages are queued
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			// Wait a bit to ensure nothing happens on its own
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Clear all queues
			h.agent.clearAllQueues();

			// Wait should resolve
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter does NOT resolve when clearSteeringQueue() finds it already empty", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;

			// Start waiting when queue is already empty
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			// Wait a bit
			await scheduler.yield();

			// Clear the already-empty queue
			h.agent.clearSteeringQueue();

			// Wait a bit more - nothing should resolve
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Abort to clean up the pending promise
			controller.abort();
			await queueChangePromise;
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter resolves when finalizeRun disowns admitted steering", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Admit a steer into the live run but don't consume it
			const msg = userMessage("steer admitted but not consumed");
			expect(h.agent.steer(msg).admitted).toBe(true);

			// Start waiting AFTER the steer is admitted
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			// Wait a bit to ensure nothing happens on its own
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Release the run so it terminates, triggering finalizeRun to disown steering
			h.release();
			await run;

			// Wait should resolve due to finalizeRun clearing the queue
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);
		} finally {
			controller.abort();
		}
	});

	it("queue-change waiter resolves when restoreQueues replaces steering", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Admit some steers
			const steer1 = userMessage("steer 1");
			const steer2 = userMessage("steer 2");
			const steer3 = userMessage("steer 3");
			expect(h.agent.steer(steer1).admitted).toBe(true);
			expect(h.agent.steer(steer2).admitted).toBe(true);
			expect(h.agent.steer(steer3).admitted).toBe(true);

			// Snapshot the queues
			const snapshot = h.agent.snapshotQueues();
			expect(snapshot.steering).toHaveLength(3);

			// Start waiting
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Restore with a filtered snapshot (only steer1 and steer3)
			h.agent.restoreQueues({ steering: [steer1, steer3], followUp: [] });

			// Wait should resolve due to queue membership changing
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);

			// Verify the queue was actually replaced
			expect(h.agent.snapshotSteering()).toEqual([steer1, steer3]);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("queue-change waiter does NOT resolve when restoreQueues uses identical snapshot", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;
			// Admit some steers
			const steer1 = userMessage("steer 1");
			const steer2 = userMessage("steer 2");
			expect(h.agent.steer(steer1).admitted).toBe(true);
			expect(h.agent.steer(steer2).admitted).toBe(true);

			// Snapshot the queues
			const snapshot = h.agent.snapshotQueues();
			expect(snapshot.steering).toHaveLength(2);

			// Start waiting
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Restore with the identical snapshot
			h.agent.restoreQueues(snapshot);

			// Wait a bit - nothing should resolve since queues didn't change
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Abort to clean up
			controller.abort();
			await queueChangePromise;
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("restoreSteering with messages resolves queue-change waiter", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;

			// Snapshot some steering messages before queueing
			const steer1 = userMessage("steer 1");
			const steer2 = userMessage("steer 2");
			h.agent.steer(steer1);
			h.agent.steer(steer2);

			const snapshot = h.agent.snapshotSteering();
			expect(snapshot).toHaveLength(2);

			// Clear the queue
			h.agent.clearSteeringQueue();
			expect(h.agent.snapshotSteering()).toHaveLength(0);

			// Start waiting for queue changes
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Restore the steering messages
			h.agent.restoreSteering(snapshot);

			// Queue-change waiter should resolve
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);

			// Verify the queue was restored
			expect(h.agent.snapshotSteering()).toEqual(snapshot);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("restoreFollowUp with messages resolves queue-change waiter", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;

			// Queue some follow-up messages
			const followUp1 = userMessage("follow-up 1");
			const followUp2 = userMessage("follow-up 2");
			h.agent.followUp(followUp1);
			h.agent.followUp(followUp2);

			const snapshot = h.agent.snapshotFollowUp();
			expect(snapshot).toHaveLength(2);

			// Clear the queue
			h.agent.clearFollowUpQueue();
			expect(h.agent.snapshotFollowUp()).toHaveLength(0);

			// Start waiting for queue changes
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Restore the follow-up messages
			h.agent.restoreFollowUp(snapshot);

			// Queue-change waiter should resolve
			await queueChangePromise;
			expect(queueChangeResolved).toBe(true);

			// Verify the queue was restored
			expect(h.agent.snapshotFollowUp()).toEqual(snapshot);
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("restoreSteering with empty snapshot does not resolve queue-change waiter", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;

			// Start waiting for queue changes
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Restore empty steering messages (should be no-op)
			h.agent.restoreSteering([]);

			// Wait a bit - nothing should resolve since queue didn't change
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Abort to clean up
			controller.abort();
			await queueChangePromise;
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});

	it("restoreFollowUp with empty snapshot does not resolve queue-change waiter", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		const controller = new AbortController();
		try {
			await h.entered;

			// Start waiting for queue changes
			let queueChangeResolved = false;
			const queueChangePromise = h.agent.waitForQueueChange(controller.signal).then(() => {
				queueChangeResolved = true;
			});

			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Restore empty follow-up messages (should be no-op)
			h.agent.restoreFollowUp([]);

			// Wait a bit - nothing should resolve since queue didn't change
			await scheduler.yield();
			expect(queueChangeResolved).toBe(false);

			// Abort to clean up
			controller.abort();
			await queueChangePromise;
		} finally {
			controller.abort();
			h.release();
			await run;
		}
	});
});
