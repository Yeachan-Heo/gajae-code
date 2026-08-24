import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@gajae-code/coding-agent/async/job-manager";
import {
	describeFoldReceipt,
	type FoldAdapter,
	FoldCoordinator,
	type FoldReceipt,
	type ForegroundSettleOutcome,
	type ForegroundTerminalPayload,
} from "@gajae-code/coding-agent/session/fold-coordinator";

function job(id: string, generation: string, status: AsyncJob["status"] = "running"): AsyncJob {
	return {
		id,
		generation,
		type: "bash",
		status,
		startTime: 0,
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

interface AdapterProbe {
	adapter: FoldAdapter;
	detached: FoldReceipt[];
	handedBack: ForegroundTerminalPayload[];
	settleOutcome: ForegroundSettleOutcome;
}

function adapterFor(target: AsyncJob, settleOutcome: ForegroundSettleOutcome = "resolved"): AdapterProbe {
	const detached: FoldReceipt[] = [];
	const handedBack: ForegroundTerminalPayload[] = [];
	const probe: AdapterProbe = {
		detached,
		handedBack,
		settleOutcome,
		adapter: {
			kind: "bash-managed",
			jobId: target.id,
			jobGeneration: target.generation,
			label: target.label,
			cwdSensitive: true,
			outputRef: {
				jobId: target.id,
				generation: target.generation,
				instruction: `use the job tool tail operation for ${target.id}`,
			},
			// Registration-bound: closes over THIS job object, never an ambient manager.
			getJob: () => target,
			detachObserver: receipt => {
				detached.push(receipt);
				return probe.settleOutcome;
			},
			resolveForegroundObserver: payload => {
				handedBack.push(payload);
				return probe.settleOutcome;
			},
		},
	};
	return probe;
}

interface Harness {
	coordinator: FoldCoordinator;
	fenceArmed: number;
	fenceReleased: number;
	stops: number;
}

function harness(captureRemainingIntent: () => Promise<string | undefined> | string | undefined): Harness {
	const state: Harness = {
		fenceArmed: 0,
		fenceReleased: 0,
		stops: 0,
		coordinator: undefined as unknown as FoldCoordinator,
	};
	state.coordinator = new FoldCoordinator({
		armSteeringFence: () => {
			state.fenceArmed += 1;
			return () => {
				state.fenceReleased += 1;
			};
		},
		requestStop: () => {
			state.stops += 1;
		},
		captureRemainingIntent,
	});
	return state;
}

describe("FoldCoordinator", () => {
	test("folds a registered wait, arming the fence before capture and stopping after it", async () => {
		let capturedWhileFenced = -1;
		const h = harness(() => {
			capturedWhileFenced = h.fenceArmed;
			return "finish the original task";
		});
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);

		expect(h.coordinator.hasFoldableParticipant()).toBe(true);
		const result = await h.coordinator.requestFold();

		expect(result.status).toBe("folded");
		// The fence was armed synchronously, before the capture await ran.
		expect(capturedWhileFenced).toBe(1);
		expect(h.stops).toBe(1);
		expect(h.fenceReleased).toBe(0);
		expect(probe.detached).toHaveLength(1);
		expect(probe.detached[0]?.remainingIntent).toBe("finish the original task");
		expect(h.coordinator.slotStateFor(target)).toBe("present");
	});

	// T-R1. Two managers can mint identical ids and generations. Slots keyed by
	// the AsyncJob instance make that collision structurally impossible.
	test("keys slots by job instance so identical ids from two managers never collide", async () => {
		const h = harness(() => "intent");
		const first = job("bg_1", "job:1");
		const second = job("bg_1", "job:1");
		const firstProbe = adapterFor(first);
		const secondProbe = adapterFor(second);

		h.coordinator.registerParticipant(firstProbe.adapter);
		expect((await h.coordinator.requestFold(firstProbe.adapter)).status).toBe("folded");
		h.coordinator.registerParticipant(secondProbe.adapter);
		expect((await h.coordinator.requestFold(secondProbe.adapter)).status).toBe("folded");

		expect(h.coordinator.slotStateFor(first)).toBe("present");
		expect(h.coordinator.slotStateFor(second)).toBe("present");

		const firstDelivery = h.coordinator.onDelivery(first, "first-output");
		const secondDelivery = h.coordinator.onDelivery(second, "second-output");
		expect(firstDelivery.kind).toBe("receipt");
		expect(secondDelivery.kind).toBe("receipt");
		// Each delivery took ITS OWN receipt; neither overwrote the other.
		expect(firstDelivery.kind === "receipt" && firstDelivery.receipt).toBe(firstProbe.detached[0]);
		expect(secondDelivery.kind === "receipt" && secondDelivery.receipt).toBe(secondProbe.detached[0]);
	});

	// The manager re-pushes the same delivery object on retry, so a second T2 for
	// the same job must still carry the receipt rather than degrade to ordinary.
	test("a retried delivery still carries the receipt after the slot is released", async () => {
		const h = harness(() => "intent");
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);
		await h.coordinator.requestFold();

		const first = h.coordinator.onDelivery(target, "payload");
		expect(first.kind).toBe("receipt");
		expect(h.coordinator.slotStateFor(target)).toBe("carried");

		const retried = h.coordinator.onDelivery(target, "payload");
		expect(retried.kind).toBe("receipt");
		if (first.kind !== "receipt" || retried.kind !== "receipt") throw new Error("expected receipt dispositions");
		expect(retried.receipt).toBe(first.receipt);
	});

	test("a completion arriving during capture parks and is flushed exactly once", async () => {
		const release = Promise.withResolvers<string | undefined>();
		const h = harness(() => release.promise);
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);

		const folding = h.coordinator.requestFold();
		await Bun.sleep(0);

		const parked = h.coordinator.onDelivery(target, "raced-output");
		expect(parked.kind).toBe("parked");
		expect(h.coordinator.slotStateFor(target)).toBe("reserved-parked");

		release.resolve("intent");
		expect((await folding).status).toBe("folded");
		// A6 replayed the parked payload through T2, which took the receipt.
		expect(h.coordinator.slotStateFor(target)).toBe("carried");
	});

	test("an unfolded job's completion stays an ordinary receipt-less delivery", () => {
		const h = harness(() => "intent");
		const target = job("bg_9", "job:9");
		expect(h.coordinator.onDelivery(target, "plain").kind).toBe("ordinary");
		expect(h.coordinator.slotStateFor(target)).toBe("none");
	});

	// T-R3a. Cancellation during capture must not recreate the slot, and must not
	// leave the participant advertised as folding.
	test("a cancellation during capture does not recreate the slot", async () => {
		const release = Promise.withResolvers<string | undefined>();
		const h = harness(() => release.promise);
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);

		const folding = h.coordinator.requestFold();
		await Bun.sleep(0);
		target.status = "cancelled";
		expect(h.coordinator.retire(target, "cancel")).toBe(true);

		release.resolve("intent");
		const result = await folding;
		expect(result.status).toBe("already-terminal");
		expect(h.coordinator.slotStateFor(target)).toBe("none");
		expect(h.fenceReleased).toBe(1);
		// Never armed the stop for a wait that did not fold.
		expect(h.stops).toBe(0);
		expect(probe.detached).toHaveLength(0);
	});

	test("capture failure rolls back, releases the fence, and hands a parked payload to the observer", async () => {
		const h = harness(() => {
			throw new Error("capture exploded");
		});
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);

		const result = await h.coordinator.requestFold();
		expect(result.status).toBe("capture-failed");
		expect(h.fenceReleased).toBe(1);
		expect(h.stops).toBe(0);
		expect(h.coordinator.slotStateFor(target)).toBe("none");
		// The still-attached observer owns the result; the coordinator settles nothing.
		expect(probe.detached).toHaveLength(0);
	});

	// T-R2. Retirement must never drop a slot that still holds or can still
	// receive a payload.
	test("onEvict keeps a slot that can still deliver and retires one that cannot", async () => {
		const h = harness(() => "intent");
		const completed = job("bg_1", "job:1", "running");
		const completedProbe = adapterFor(completed);
		h.coordinator.registerParticipant(completedProbe.adapter);
		await h.coordinator.requestFold(completedProbe.adapter);

		// An evicted record still delivers with its retained job object, so a
		// completed job keeps its present slot.
		completed.status = "completed";
		expect(h.coordinator.retire(completed, "evict")).toBe(false);
		expect(h.coordinator.slotStateFor(completed)).toBe("present");

		// A cancelled job enqueues no delivery at all, so its slot is retired.
		const cancelled = job("bg_2", "job:2", "running");
		const cancelledProbe = adapterFor(cancelled);
		h.coordinator.registerParticipant(cancelledProbe.adapter);
		await h.coordinator.requestFold(cancelledProbe.adapter);
		cancelled.status = "cancelled";
		expect(h.coordinator.retire(cancelled, "evict")).toBe(true);
		expect(h.coordinator.slotStateFor(cancelled)).toBe("none");
	});

	test("onEvict never drops a reserved slot holding a parked payload", async () => {
		const release = Promise.withResolvers<string | undefined>();
		const h = harness(() => release.promise);
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);

		const folding = h.coordinator.requestFold();
		await Bun.sleep(0);
		h.coordinator.onDelivery(target, "raced-output");
		target.status = "cancelled";

		expect(h.coordinator.retire(target, "evict")).toBe(false);
		expect(h.coordinator.slotStateFor(target)).toBe("reserved-parked");

		release.resolve("intent");
		await folding;
	});

	test("refuses to fold an already-terminal wait or one whose id was reused", async () => {
		const h = harness(() => "intent");
		const evicted = job("bg_1", "job:1");
		const evictedProbe = adapterFor(evicted);
		const gone: FoldAdapter = { ...evictedProbe.adapter, getJob: () => undefined };
		expect((await h.coordinator.requestFold(gone)).status).toBe("already-terminal");

		const reused: FoldAdapter = { ...evictedProbe.adapter, jobGeneration: "job:stale" };
		expect((await h.coordinator.requestFold(reused)).status).toBe("already-terminal");

		expect((await h.coordinator.requestFold()).status).toBe("unavailable");
	});

	// AC11: the fold result must carry the job id, a real retrieval handle, and a
	// retrieval hint, with the cwd caveat only where a wait can change directory.
	test("renders a receipt carrying the job id, retrieval handle, and remaining intent", async () => {
		const h = harness(() => "finish the migration");
		const target = job("bg_7", "job:7");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);
		const result = await h.coordinator.requestFold();
		if (result.status !== "folded") throw new Error("expected a folded result");

		const rendered = describeFoldReceipt(result.receipt);
		expect(rendered).toContain("bg_7");
		expect(rendered).toContain("job tool");
		expect(rendered).toContain("finish the migration");
		expect(rendered).toContain("Session cwd is unchanged");
	});

	test("omits the cwd caveat for a wait kind that cannot change directory", async () => {
		const h = harness(() => undefined);
		const target = job("bg_8", "job:8");
		const probe = adapterFor(target);
		const adapter = { ...probe.adapter, cwdSensitive: false };
		h.coordinator.registerParticipant(adapter);
		const result = await h.coordinator.requestFold();
		if (result.status !== "folded") throw new Error("expected a folded result");

		const rendered = describeFoldReceipt(result.receipt);
		expect(rendered).toContain("bg_8");
		expect(rendered).not.toContain("Session cwd");
		// No captured intent means no fabricated instruction to complete one.
		expect(rendered).not.toContain("Complete the original request");
	});

	// AC6: exactly ONE transcript notice per completion. A delivery can be retried
	// with the same job object, so an unguarded notice would repeat for a single
	// completion.
	test("claims a completion notice exactly once per job", async () => {
		const h = harness(() => "intent");
		const first = job("bg_1", "job:1");
		const second = job("bg_2", "job:2");

		expect(h.coordinator.claimCompletionNotice(first)).toBe(true);
		expect(h.coordinator.claimCompletionNotice(first)).toBe(false);
		expect(h.coordinator.claimCompletionNotice(first)).toBe(false);

		// Independent jobs each get their own single notice.
		expect(h.coordinator.claimCompletionNotice(second)).toBe(true);
		expect(h.coordinator.claimCompletionNotice(second)).toBe(false);
	});

	// The delivery seam only notices a receipt-bearing completion, and a retried
	// delivery of that same completion must not notice again.
	test("a retried receipt delivery does not claim a second notice", async () => {
		const h = harness(() => "intent");
		const target = job("bg_1", "job:1");
		const probe = adapterFor(target);
		h.coordinator.registerParticipant(probe.adapter);
		await h.coordinator.requestFold();

		const first = h.coordinator.onDelivery(target, "payload");
		expect(first.kind).toBe("receipt");
		expect(h.coordinator.claimCompletionNotice(target)).toBe(true);

		const retried = h.coordinator.onDelivery(target, "payload");
		expect(retried.kind).toBe("receipt");
		expect(h.coordinator.claimCompletionNotice(target)).toBe(false);
	});
});
