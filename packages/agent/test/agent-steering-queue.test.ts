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
});
