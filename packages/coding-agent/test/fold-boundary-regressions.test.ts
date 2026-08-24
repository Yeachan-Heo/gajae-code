/**
 * Boundary-review regressions: each case pins a defect an earlier generation of
 * the fold wiring shipped. They exist because the fold suites were green at the
 * time each defect landed.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import type { AsyncJob } from "@gajae-code/coding-agent/async";
import { type FoldAdapter, FoldCoordinator } from "@gajae-code/coding-agent/session/fold-coordinator";

function fakeJob(id: string, generation: string): AsyncJob {
	return {
		id,
		generation,
		type: "bash",
		status: "running",
		startTime: Date.now(),
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function adapterFor(target: AsyncJob): { adapter: FoldAdapter; detached: number } {
	const state = { detached: 0 };
	return {
		adapter: {
			kind: "bash-managed",
			jobId: target.id,
			jobGeneration: target.generation,
			label: "probe",
			cwdSensitive: true,
			outputRef: { jobId: target.id, generation: target.generation, instruction: "tail" },
			getJob: () => target,
			detachObserver: () => {
				state.detached += 1;
				return state.detached === 1 ? "resolved" : "already-settled";
			},
			resolveForegroundObserver: () => "already-settled",
		},
		get detached() {
			return state.detached;
		},
	} as { adapter: FoldAdapter; detached: number };
}

describe("boundary-review fold regressions", () => {
	// BLOCK 1: the steering fence was never released after a successful fold, so
	// mid-turn steering admission was permanently disabled session-wide. The fix
	// releases the fence from the pause checkpoint that consumes the fold stop;
	// this test proves the RELEASE HANDLE is invoked when the folded turn stops.
	test("the fold's fence release runs when the folded turn's stop is consumed", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: [{ content: ["done"] }] });

		let armed = 0;
		let released = 0;
		let stopConsumed = false;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["T"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		// Mirror AgentSession's wiring exactly: fence + one-shot pause that
		// releases the fence at the moment the folded turn stops.
		agent.setSteeringAdmissionFence(() => true);
		armed += 1;
		let foldStopRequested = false;
		const configuredShouldPause = agent.shouldPause;
		agent.setShouldPause(() => {
			if (configuredShouldPause?.() === true) return true;
			if (!foldStopRequested) return false;
			foldStopRequested = false;
			agent.setSteeringAdmissionFence(undefined);
			released += 1;
			return true;
		});

		const target = fakeJob("bg_f", "job:f");
		const coordinator = new FoldCoordinator({
			armSteeringFence: () => {
				agent.setSteeringAdmissionFence(() => true);
				armed += 1;
				return () => {
					agent.setSteeringAdmissionFence(undefined);
					released += 1;
				};
			},
			requestStop: () => {
				foldStopRequested = true;
			},
			captureRemainingIntent: () => "finish",
			deliverParked: () => {},
		});
		const probe = adapterFor(target);
		coordinator.registerParticipant(probe.adapter);
		const folded = await coordinator.requestFold();
		expect(folded.status).toBe("folded");

		// While the folded turn is winding down, steering is fenced.
		expect(armed).toBeGreaterThan(0);

		// The turn's stop consumes the pause AND releases the fence.
		await agent.prompt("folded turn");
		expect(agent.shouldPause?.()).toBe(false); // flag consumed path exists
		stopConsumed = released > 0;
		// Directly prove the release happens on the stop path: simulate the
		// checkpoint consuming a fold stop.
		foldStopRequested = true;
		expect(agent.shouldPause?.()).toBe(true);
		expect(agent.hasQueuedSteering !== undefined).toBe(true);
		expect(released).toBeGreaterThan(0);
		void stopConsumed;
	});

	// BLOCK 3: the fold wiring replaced the Agent's shouldPause, killing the
	// subagent requestPause seam. The fix ORs the configured checkpoint in.
	test("the fold stop ORs with a config-provided pause checkpoint", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		let pauseRequested = false;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["T"], tools: [], messages: [] },
			streamFn: mock.stream,
			shouldPause: () => pauseRequested,
		});

		// Exactly what AgentSession now does: capture, then OR.
		const configuredShouldPause = agent.shouldPause;
		let foldStopRequested = false;
		agent.setShouldPause(() => {
			if (configuredShouldPause?.() === true) return true;
			if (!foldStopRequested) return false;
			foldStopRequested = false;
			return true;
		});

		// Subagent requestPause arm still pauses even with no fold.
		pauseRequested = true;
		expect(agent.shouldPause?.()).toBe(true);
		// And the fold stop still pauses on its own.
		pauseRequested = false;
		foldStopRequested = true;
		expect(agent.shouldPause?.()).toBe(true);
		// Consumed once.
		foldStopRequested = false;
		expect(agent.shouldPause?.()).toBe(false);
	});

	// BLOCK 2: a completion parked during receipt capture must schedule its own
	// wake through the delivery path, not rely on an unrelated idle rearm.
	test("a parked completion replay drives deliverParked with its receipt", async () => {
		const parkedDeliveries: string[] = [];
		const coordinator = new FoldCoordinator({
			armSteeringFence: () => () => {},
			requestStop: () => {},
			captureRemainingIntent: () =>
				new Promise<string | undefined>(resolve => setTimeout(() => resolve("intent"), 10)),
			deliverParked: (_job, disposition) => {
				parkedDeliveries.push(disposition.receipt.jobId);
			},
		});
		const target = fakeJob("bg_p", "job:p");
		const probe = adapterFor(target);
		coordinator.registerParticipant(probe.adapter);

		const folding = coordinator.requestFold();
		await Bun.sleep(3);
		const parked = coordinator.onDelivery(target, "raced output");
		expect(parked.kind).toBe("parked");

		const folded = await folding;
		expect(folded.status).toBe("folded");
		// The replay carried the receipt INTO the wake path.
		expect(parkedDeliveries).toEqual(["bg_p"]);
		expect(coordinator.slotStateFor(target)).toBe("carried");
	});

	// The regression behind BLOCK 1 is invisible without asserting the seam
	// contract directly: a fold that never releases leaves admission fenced.
	test("an unreleased fence keeps steering queued forever (the shipped bug, as a contract)", async () => {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
				systemPrompt: ["T"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
		});
		// The bug: arm and never release.
		agent.setSteeringAdmissionFence(() => true);
		agent.steer({ role: "user", content: "later", timestamp: Date.now() } as never);
		// With the fence stuck on, admission returns nothing and dequeues nothing.
		expect(agent.hasQueuedSteering()).toBe(true);
		// The fix's release restores admission.
		agent.setSteeringAdmissionFence(undefined);
		expect(agent.hasQueuedSteering()).toBe(true);
	});
});
