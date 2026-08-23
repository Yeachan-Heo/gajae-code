import { describe, expect, test } from "bun:test";
import { PromptDeadlineManager } from "../src/sdk/prompt-deadline-manager";

/**
 * Issue #4668 exact-head review (P1): when expiry reconciliation fails, the
 * deadline manager must not drop the deadline lease and pending ownership.
 * Pending ownership is retired only after durable terminal confirmation;
 * otherwise the lease is retained and reconciliation is retried boundedly.
 */

interface FakeReconciliation {
	status: string;
	finalizeFailures: number;
	finalizeCalls: number;
	claimStarted?: () => void;
	claimRelease?: Promise<void>;
	finalizeStarted?: () => void;
	finalizeRelease?: Promise<void>;
	noteTransitionCalls: number;
	noteTransitionFailures: number;
	uncertainCalls: number;
	noteTransitionFrames: string[];
	finalizeCodes: string[];
	uncertainFailures: number;
	uncertainStarted?: () => void;
	uncertainRelease?: Promise<void>;

	/** When set, a failing finalize still leaves the durable record terminal (lost race). */
	terminalOnFailure?: boolean;
}

function fakeReconciliation(): {
	reconciliation: {
		lookup: () => { status: string };
		claimPendingOutcome: () => Promise<void>;
		noteTransition: (_kind: string, _correlation: unknown, frame?: { type?: string }) => Promise<void>;
		markUncertain: (_kind: string, _correlation: unknown, isCurrent?: () => boolean) => Promise<void>;
		finalizeOutcome: (
			_kind: string,
			_correlation: unknown,
			_outcome: unknown,
			isCurrent?: () => boolean,
		) => Promise<void>;
	};
	state: FakeReconciliation;
} {
	const state: FakeReconciliation = {
		status: "running",
		finalizeFailures: 0,
		finalizeCalls: 0,
		noteTransitionCalls: 0,
		noteTransitionFailures: 0,
		uncertainCalls: 0,
		noteTransitionFrames: [],
		finalizeCodes: [],
		uncertainFailures: 0,
	};
	return {
		state,
		reconciliation: {
			lookup: () => ({ status: state.status }),
			noteTransition: async (_kind: string, _correlation: unknown, frame?: { type?: string }) => {
				state.noteTransitionCalls += 1;
				state.noteTransitionFrames.push(frame?.type ?? "unknown");
				if (state.noteTransitionCalls <= state.noteTransitionFailures) throw new Error("terminal replay failed");
				state.status = "terminal_ok";
			},
			markUncertain: async (_kind: string, _correlation: unknown, isCurrent?: () => boolean) => {
				state.uncertainCalls += 1;
				state.uncertainStarted?.();
				if (state.uncertainRelease) await state.uncertainRelease;
				if (state.uncertainCalls <= state.uncertainFailures) throw new Error("uncertainty persistence failed");
				if (isCurrent !== undefined && !isCurrent()) return;
				state.status = "uncertain";
			},
			claimPendingOutcome: async () => {
				state.claimStarted?.();
				if (state.claimRelease) await state.claimRelease;
			},
			finalizeOutcome: async (_kind, _correlation, outcome, isCurrent?: () => boolean) => {
				state.finalizeCalls += 1;
				state.finalizeCodes.push((outcome as { code?: string } | undefined)?.code ?? "none");
				state.finalizeStarted?.();
				const previousStatus = state.status;
				state.status = "failed";
				if (state.finalizeRelease) await state.finalizeRelease;
				if (state.finalizeCalls <= state.finalizeFailures) {
					// Production stages the terminal mutation before persistence and
					// restores the prior record when the durable write fails.
					state.status = previousStatus;
					// Race simulation: a normal terminal transition won while the
					// expiry finalize was in flight — the record IS terminal, the
					// finalize call itself throws.
					if (state.terminalOnFailure) state.status = "terminal_ok";
					throw new Error("durable write failed");
				}
				if (isCurrent !== undefined && !isCurrent()) {
					state.status = previousStatus;
					return;
				}
				state.status = "failed";
			},
		},
	};
}

describe("PromptDeadlineManager expiry reconciliation (#4668)", () => {
	test("retains lease and pending ownership when finalize fails, retires after durable confirmation", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = 1; // first expiry pass fails, the retry succeeds
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-1", turnId: "turn-1" };
		manager.onAccepted(correlation);
		// First deadline pass: finalize throws and the record is NOT terminal, so
		// neither onExpired nor lease cleanup may run.
		await Bun.sleep(120);
		expect(expired).toBe(0);
		expect(manager.has(correlation)).toBe(true);
		// The bounded retry lands the durable terminal outcome: only then is
		// pending ownership retired and the lease cleared.
		await Bun.sleep(2_300);
		expect(state.finalizeCalls).toBeGreaterThanOrEqual(2);
		expect(expired).toBe(1);
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});

	test("a failed finalize never infers durable terminality from an in-memory lookup", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER; // finalize always throws...
		state.terminalOnFailure = true; // the in-memory map reports a terminal race
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-2", turnId: "turn-2" };
		manager.onAccepted(correlation);
		await Bun.sleep(120);
		// A failed persistence call is not durable confirmation, even if a
		// concurrent in-memory transition appears terminal.
		expect(expired).toBe(0);
		expect(manager.has(correlation)).toBe(true);
		manager.clearAll();
	});

	test("fences late adoption while expiry persistence is suspended", async () => {
		const gate = Promise.withResolvers<void>();
		const { reconciliation, state } = fakeReconciliation();
		state.claimRelease = gate.promise;
		const started = Promise.withResolvers<void>();
		state.claimStarted = () => started.resolve();
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-fence", turnId: "turn-fence" };
		manager.onAccepted(correlation);
		await started.promise;
		expect(manager.isExpiring(correlation)).toBe(true);
		gate.resolve();
		await Bun.sleep(30);
		manager.clearAll();
	});

	test("the retry budget is bounded: exhaustion records durable uncertainty instead of false deadline failure", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-3", turnId: "turn-3" };
		manager.onAccepted(correlation);
		// Initial pass + bounded retries (5 x 1s). Ownership is never retired
		// without durable terminal confirmation.
		await Bun.sleep(6_800);
		expect(expired).toBe(0);
		// <=7 within the FIRST budget; the re-armed lease may open a fresh one.
		expect(state.finalizeCalls).toBeLessThanOrEqual(8);
		// Exhaustion persists a non-definite recovery marker and then RE-ARMS a
		// bounded lease (#4668 review P2): clearing after a successful
		// uncertainty write would leave the durable deadlineRecoveryPending
		// record with no in-process bound and strand it accepted forever.
		expect(state.uncertainCalls).toBe(1);
		expect(state.status).toBe("uncertain");
		expect(manager.has(correlation)).toBe(true);
		// The re-armed lease keeps terminalizing boundedly: finalize retries
		// resume on its deadline instead of parking permanently. (isExpiring is
		// ephemeral here: the 20ms re-armed lease is already mid-expiry again.)
		const callsAfterPark = state.finalizeCalls;
		await Bun.sleep(1_300);
		expect(state.finalizeCalls).toBeGreaterThan(callsAfterPark);
		manager.clearAll();
	}, 15_000);

	test("a real agent_end that fails beyond budget never remains a definite deadline failure", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.noteTransitionFailures = Number.MAX_SAFE_INTEGER;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-real-exhausted", turnId: "turn-real-exhausted" };
		manager.onAccepted(correlation);
		manager.noteTerminalTransition(correlation);
		await Bun.sleep(6_800);
		expect(state.uncertainCalls).toBe(1);
		expect(state.status).toBe("uncertain");
		// Re-armed bounded lease instead of an unbounded clear (#4668 review P2).
		expect(manager.has(correlation)).toBe(true);
		manager.clearAll();
	}, 15_000);

	test("retries uncertainty persistence after the first recovery write fails", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		state.uncertainFailures = 1;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-uncertain-retry", turnId: "turn-uncertain-retry" };
		manager.onAccepted(correlation);
		await Bun.sleep(6_800);
		await Bun.sleep(1_200);
		expect(state.uncertainCalls).toBe(2);
		expect(state.status).toBe("uncertain");
		// Second (successful) uncertainty write re-arms a bounded lease (#4668
		// review P2) instead of clearing to an unbounded accepted state.
		expect(manager.has(correlation)).toBe(true);
	}, 15_000);

	test("stale uncertainty completion cannot clear a replacement lease", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		const recoveryStarted = Promise.withResolvers<void>();
		const recoveryRelease = Promise.withResolvers<void>();
		state.uncertainStarted = () => recoveryStarted.resolve();
		state.uncertainRelease = recoveryRelease.promise;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-reaccept", turnId: "turn-reaccept" };
		manager.onAccepted(correlation);
		await Bun.sleep(6_800);
		await recoveryStarted.promise;
		manager.clear(correlation);
		manager.onAccepted(correlation);
		recoveryRelease.resolve();
		await Bun.sleep(30);
		expect(manager.has(correlation)).toBe(true);
		manager.clearAll();
	}, 15_000);

	test("stale uncertainty rejection does not retry against a replacement lease", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		state.uncertainFailures = 1;
		const recoveryStarted = Promise.withResolvers<void>();
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		state.uncertainStarted = () => {
			recoveryStarted.resolve();
			manager.clear({ commandId: "cmd-reject", turnId: "turn-reject" });
			manager.onAccepted({ commandId: "cmd-reject", turnId: "turn-reject" });
		};
		const correlation = { commandId: "cmd-reject", turnId: "turn-reject" };
		manager.onAccepted(correlation);
		await Bun.sleep(6_800);
		await recoveryStarted.promise;
		const finalizeBeforeReplacement = state.finalizeCalls;
		await Bun.sleep(1_200);
		expect(state.uncertainCalls).toBe(1);
		expect(manager.has(correlation)).toBe(true);
		expect(state.finalizeCalls).toBeGreaterThan(finalizeBeforeReplacement);
		manager.clearAll();
	}, 15_000);

	test("stale uncertainty rejection does not retry after progress renews the lease", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		state.uncertainFailures = 1;
		const recoveryStarted = Promise.withResolvers<void>();
		const recoveryRelease = Promise.withResolvers<void>();
		state.uncertainStarted = () => recoveryStarted.resolve();
		state.uncertainRelease = recoveryRelease.promise;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-progress-reject", turnId: "turn-progress-reject" };
		manager.onAccepted(correlation);
		await Bun.sleep(6_800);
		await recoveryStarted.promise;
		manager.onProgress(correlation);
		const finalizeBeforeRenewedLease = state.finalizeCalls;
		recoveryRelease.resolve();
		await Bun.sleep(1_200);
		expect(state.uncertainCalls).toBe(1);
		expect(manager.has(correlation)).toBe(true);
		expect(state.finalizeCalls).toBeGreaterThan(finalizeBeforeRenewedLease);
		manager.clearAll();
	}, 15_000);

	test("all bounded uncertainty writes fail with explicit recovery ownership retained", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		state.uncertainFailures = Number.MAX_SAFE_INTEGER;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-recovery-pending", turnId: "turn-recovery-pending" };
		manager.onAccepted(correlation);
		await Bun.sleep(9_200);
		// Exhaustion no longer parks inert (exact-head review P1): the recovery
		// timer keeps retrying the durable uncertainty write, so calls exceed the
		// bounded budget instead of stranding the accepted row, and the explicit
		// recovery-pending state stays visible the whole time.
		expect(state.uncertainCalls).toBeGreaterThanOrEqual(3);
		expect(manager.has(correlation)).toBe(true);
		expect(manager.hasRecoveryPending(correlation)).toBe(true);
		manager.clearAll();
	}, 15_000);

	test("fresh progress during a suspended claim cancels this expiry instead of firing exceeded", async () => {
		// Exact-head review P2: expiry finalization must be generation-aware after
		// every awaited operation. Deliver attributable progress while the claim
		// await is suspended; the expiry must back off rather than surface
		// prompt_deadline_exceeded for a prompt that is demonstrably alive.
		let now = 0;
		const claimStarted = Promise.withResolvers<void>();
		const claimGate = Promise.withResolvers<void>();
		const { reconciliation, state } = fakeReconciliation();
		state.claimStarted = () => claimStarted.resolve();
		state.claimRelease = claimGate.promise;
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			now: () => now,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-claim-progress", turnId: "turn-claim-progress" };
		now = 0;
		manager.onAccepted(correlation);
		// Advance the fake clock past the deadline so the pending timer drives expiry.
		now = 1_000;
		await claimStarted.promise; // expiry is suspended inside claimPendingOutcome
		expect(manager.isExpiring(correlation)).toBe(true);
		// Fresh attributable progress renews the lease while the claim is in flight.
		now = 2_000;
		manager.onAttributableEvent(correlation, "tool_execution_start", now);
		claimGate.resolve();
		await Bun.sleep(30);
		// The renewed lease supersedes the in-flight expiry: no exceeded outcome,
		// the lease survives, and the fence is released.
		expect(expired).toBe(0);
		expect(manager.isExpiring(correlation)).toBe(false);
		expect(manager.has(correlation)).toBe(true);
		expect(manager.deadlineAt(correlation)).toBe(2_020);
		manager.clearAll();
	});

	test("stale progress during a suspended claim preserves the expiry fence and timer", async () => {
		let now = 0;
		let claimCalls = 0;
		const claimStarted = Promise.withResolvers<void>();
		const claimGate = Promise.withResolvers<void>();
		const { reconciliation, state } = fakeReconciliation();
		state.claimStarted = () => {
			claimCalls += 1;
			claimStarted.resolve();
		};
		state.claimRelease = claimGate.promise;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			now: () => now,
		});
		const correlation = { commandId: "cmd-stale-progress", turnId: "turn-stale-progress" };
		manager.onAccepted(correlation);
		now = 1_000;
		await claimStarted.promise;
		expect(manager.isExpiring(correlation)).toBe(true);

		// Equal progress is not a new lease generation. It must not release the
		// expiry fence or schedule a second expiry while the first one is pending.
		manager.onProgress(correlation, 0);
		await Bun.sleep(30);
		expect(manager.isExpiring(correlation)).toBe(true);
		expect(claimCalls).toBe(1);

		claimGate.resolve();
		await Bun.sleep(30);
		manager.clearAll();
	});

	test("fresh progress during a suspended finalize cancels this expiry instead of firing exceeded", async () => {
		// Same generation-aware guarantee but on the finalize await, which previously
		// retired ownership and cleared the lease unconditionally after a durable
		// write. Progress during finalize must keep the invoked prompt alive.
		let now = 0;
		const finalizeStarted = Promise.withResolvers<void>();
		const finalizeGate = Promise.withResolvers<void>();
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeStarted = () => finalizeStarted.resolve();
		state.finalizeRelease = finalizeGate.promise;
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			now: () => now,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-finalize-progress", turnId: "turn-finalize-progress" };
		now = 0;
		manager.onAccepted(correlation);
		now = 1_000;
		await finalizeStarted.promise; // expiry is suspended inside finalizeOutcome
		expect(manager.isExpiring(correlation)).toBe(true);
		// Fresh attributable progress renews the lease while the finalize is in flight.
		now = 2_000;
		manager.onAttributableEvent(correlation, "tool_execution_start", now);
		finalizeGate.resolve();
		await Bun.sleep(30);
		expect(expired).toBe(0);
		expect(state.status).not.toBe("failed");
		expect(manager.isExpiring(correlation)).toBe(false);
		expect(manager.has(correlation)).toBe(true);
		expect(manager.deadlineAt(correlation)).toBe(2_020);
		manager.clearAll();
	});

	test("retries a real agent_end instead of reasserting deadline failure", async () => {
		const { reconciliation, state } = fakeReconciliation();
		const finalizeStarted = Promise.withResolvers<void>();
		const finalizeRelease = Promise.withResolvers<void>();
		state.finalizeStarted = () => finalizeStarted.resolve();
		state.finalizeRelease = finalizeRelease.promise;
		state.finalizeFailures = 1;
		state.noteTransitionFailures = 1;
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-real-end-retry", turnId: "turn-real-end-retry" };
		manager.onAccepted(correlation);
		await finalizeStarted.promise;
		// The real terminal arrives while the synthetic deadline write is held.
		manager.noteTerminalTransition(correlation);
		finalizeRelease.resolve();
		await Bun.sleep(2_300);
		expect(state.noteTransitionCalls).toBeGreaterThanOrEqual(2);
		expect(state.noteTransitionFrames).toContain("agent_end");
		expect(state.finalizeCodes).toEqual(["prompt_deadline_exceeded"]);
		expect(state.status).toBe("terminal_ok");
		expect(expired).toBe(1);
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	}, 5_000);

	test("re-arms a persisted uncertainty recovery without resetting its acceptance cap", async () => {
		const { reconciliation, state } = fakeReconciliation();
		const correlation = { commandId: "cmd-restart-recovery", turnId: "turn-restart-recovery" };
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 50,
			now: () => 100,
		});

		manager.recoverPending(correlation, 0);
		await Bun.sleep(20);

		expect(state.finalizeCodes).toEqual(["prompt_deadline_exceeded"]);
		expect(state.status).toBe("failed");
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});
});
