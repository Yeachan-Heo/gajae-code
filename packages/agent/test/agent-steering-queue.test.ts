import { describe, expect, it } from "bun:test";
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
		responses: [
			{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
			{ content: ["after"] },
			{ content: ["x"] },
		],
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
		if (admission.admitted) expect(admission.runId).toBe(h.agent.activeRunId);
		expect(h.agent.hasQueuedSteering()).toBe(true);
		h.release();
		await run;
		expect(h.agent.hasQueuedSteering()).toBe(false);
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

	it("waitForSteeringArrival resolves on arrival, on a pre-queued steer, and on abort without consuming", async () => {
		const h = liveRunHarness();
		const run = h.agent.prompt("go");
		await h.entered;

		const pending = h.agent.waitForSteeringArrival(new AbortController().signal);
		expect(h.agent.steer(userMessage("arrived")).admitted).toBe(true);
		await pending;
		expect(h.agent.hasQueuedSteering()).toBe(true);

		await h.agent.waitForSteeringArrival(new AbortController().signal);

		h.agent.clearSteeringQueue();
		const controller = new AbortController();
		const abortable = h.agent.waitForSteeringArrival(controller.signal);
		controller.abort();
		await abortable;
		expect(h.agent.hasQueuedSteering()).toBe(false);
		h.release();
		await run;
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
});
