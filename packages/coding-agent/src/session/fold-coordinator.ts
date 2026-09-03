/**
 * Session-owned fold/wake coordinator.
 *
 * Folding a running foreground wait is a lifecycle handoff across three
 * independently scheduled domains — the tool observer, the job owner, and
 * agent-turn admission — so it needs ONE linearization point. That is this
 * coordinator: a synchronous prologue claims the fold and arms the steering
 * fence with no `await` in between, and only then does an async tail capture and
 * persist the receipt.
 *
 * Two invariants are load-bearing and easy to get wrong:
 *
 * 1. **Identity is the `AsyncJob` instance, acquired once.** Job ids and
 *    generations are manager-local, so two managers can mint the same
 *    `bg_1`/`job:1` pair. Slots are therefore keyed by the object itself,
 *    obtained exactly once through the registration-bound
 *    {@link FoldAdapter.getJob} and retained for the rest of the transaction.
 *    Nothing in the fold path may consult an ambient, singleton, or
 *    endpoint-resolved manager.
 * 2. **A delivery callback can run more than once.** The async job manager
 *    re-pushes the SAME delivery object on retry, so the receipt is attached to
 *    a carrier keyed by that object BEFORE the slot is released. A retried
 *    delivery therefore still carries its receipt and can never silently
 *    degrade into an ordinary receipt-less completion.
 */
import type { AsyncJob, FoldReason } from "../async/job-manager";
import foldReceiptPrompt from "../prompts/tools/fold-receipt.md" with { type: "text" };

/**
 * Idle-flush merge window.
 *
 * Completions that land within this window coalesce into ONE wake turn. The
 * previous 1ms debounce meant staggered completions each bought their own full
 * LLM turn. Deliberately a fixed internal constant, not a setting: the contract
 * is one merge window, and a per-user knob would let wake behavior differ
 * between sessions.
 */
export const FOLD_WAKE_MERGE_WINDOW_MS = 800;

/** The wait kinds that can be folded. `task`/`subagent` awaits are a non-goal. */
export type FoldWaitKind = "bash-managed" | "client-terminal" | "bash-pty";

/** Outcome of settling the foreground caller. Exactly one party may settle it. */
export type ForegroundSettleOutcome = "resolved" | "already-settled";

/**
 * How a folded job's output is retrieved later. Deliberately a structured
 * handle over already-implemented paths rather than an invented URI scheme:
 * there is no `job://` resolver, and inventing one would make the reference
 * unresolvable in exactly the degraded case it exists for.
 */
export interface JobOutputRetrieval {
	jobId: string;
	generation: string;
	/** Human/model-facing retrieval instruction naming a real mechanism. */
	instruction: string;
}

/** Durable record captured at fold time and replayed into the wake turn. */
export interface FoldReceipt {
	jobId: string;
	jobGeneration: string;
	kind: FoldWaitKind;
	label: string;
	outputRef: JobOutputRetrieval;
	/** What the interrupted turn still intended to do, so the wake can finish it. */
	remainingIntent: string | undefined;
	foldedAt: number;
	/** Only command kinds can change directory; task-style waits never do. */
	cwdSensitive: boolean;
	/** What triggered the fold; recorded on the job as `metadata.foldReason`. */
	reason: FoldReason;
}

/** A terminal completion observed for a folded job. */
export interface ForegroundTerminalPayload {
	jobId: string;
	generation: string;
	text: string;
}

/**
 * Per-wait fold capability. `getJob` is bound at registration over the manager
 * that registered THIS job, which is what makes cross-manager identity safe.
 */
export interface FoldAdapter {
	readonly kind: FoldWaitKind;
	readonly jobId: string;
	readonly jobGeneration: string;
	readonly label: string;
	readonly cwdSensitive: boolean;
	/** Signal for the foreground wait; aborting capture must roll back the fold. */
	readonly signal?: AbortSignal;
	/** True only when the adapter was created by a model-owned Agent turn. */
	readonly originatingTurn?: boolean;
	readonly outputRef: JobOutputRetrieval;
	/** Registration-bound resolver: the job for this adapter, or undefined once evicted or reused. */
	readonly getJob: () => AsyncJob | undefined;
	/** Settle the foreground caller with the fold result. Idempotent. */
	readonly detachObserver: (receipt: FoldReceipt) => ForegroundSettleOutcome;
	/** Hand a parked completion back to a still-attached observer. Idempotent. */
	readonly resolveForegroundObserver: (payload: ForegroundTerminalPayload) => ForegroundSettleOutcome;
}

export type FoldRequestResult =
	| { status: "folded"; receipt: FoldReceipt }
	| { status: "unavailable"; reason: string }
	| { status: "already-terminal"; reason: string }
	| { status: "capture-failed"; reason: string };

/**
 * Session-level answer to "fold the foreground bash now". Consumed by the SDK
 * `bash.background` control, whose declared error codes are exactly these
 * non-folded statuses.
 */
export type ForegroundFoldOutcome =
	| { status: "folded"; jobId: string }
	| { status: "already_backgrounded" }
	| { status: "no_active_bash" }
	| { status: "not_foldable"; reason: string };

/** Map a non-folded outcome onto the C52 `bash.background` error contract (`not_foldable` | `already_backgrounded` | `no_active_bash`). */
export function bashBackgroundControlError(outcome: Exclude<ForegroundFoldOutcome, { status: "folded" }>): Error {
	switch (outcome.status) {
		case "already_backgrounded":
			return Object.assign(new Error("The active bash command has already been moved to a background job."), {
				code: "already_backgrounded",
			});
		case "no_active_bash":
			return Object.assign(new Error("No foreground bash command is running."), { code: "no_active_bash" });
		case "not_foldable":
			return Object.assign(
				new Error(`The active bash command cannot be moved to a managed background job: ${outcome.reason}`),
				{ code: "not_foldable" },
			);
	}
}

/** What a delivery should carry, decided by the durable slot state (T2). */
export type FoldDeliveryDisposition =
	| { kind: "ordinary" }
	| { kind: "parked" }
	| { kind: "receipt"; receipt: FoldReceipt; text: string };

interface ReservedSlot {
	state: "reserved";
	adapter: FoldAdapter;
	parked: ForegroundTerminalPayload | undefined;
	parkedAt: number | undefined;
}

interface PresentSlot {
	state: "present";
	adapter: FoldAdapter;
	receipt: FoldReceipt;
}

type FoldSlot = ReservedSlot | PresentSlot;

export interface FoldCoordinatorDeps {
	/**
	 * Fence old-turn steering admission and return the release handle. Armed
	 * synchronously inside the prologue because the agent loop polls steering
	 * upstream of its pause checkpoint; fencing there keeps queued steering
	 * intact instead of draining it.
	 */
	armSteeringFence: () => () => void;
	/** Whether this fold belongs to a currently running Agent turn. */
	hasActiveTurn?: () => boolean;
	/** Arm the cooperative stop so the turn ends after the fold result, never via abort. */
	requestStop: () => void;
	/** Capture what the interrupted turn still intended to accomplish. */
	captureRemainingIntent: () => Promise<string | undefined> | string | undefined;
	/**
	 * Push a parked completion into the wake path. The delivery seam parks a
	 * completion that arrives before the receipt exists; when the fold later
	 * replays it (A6), THIS is what makes the wake happen rather than relying on
	 * an unrelated idle rearm to rescue it.
	 */
	deliverParked: (job: AsyncJob, disposition: { kind: "receipt"; receipt: FoldReceipt; text: string }) => void;
}

/** Why a slot is being retired, which decides whether retiring is safe. */
export type FoldRetireReason = "cancel" | "evict";

/**
 * Render a fold receipt for the wake turn.
 *
 * Carries the job id, a real retrieval handle, and the captured remaining
 * intent, so the wake turn can finish the ORIGINAL task instead of only
 * reporting that a command ended. The cwd caveat is included only for wait
 * kinds that can actually change directory.
 */
export function describeFoldReceipt(receipt: FoldReceipt): string {
	const cwdNotice = receipt.cwdSensitive
		? "Session cwd is unchanged; any directory change made by the folded command does not apply to later commands.\n"
		: "";
	const intentNotice = receipt.remainingIntent
		? `Complete the original request, which was: ${receipt.remainingIntent}`
		: "";
	return foldReceiptPrompt
		.replace("{{kind}}", () => receipt.kind)
		.replace("{{jobId}}", () => receipt.jobId)
		.replace("{{outputInstruction}}", () => receipt.outputRef.instruction)
		.replace("{{cwdNotice}}", () => cwdNotice)
		.replace("{{intentNotice}}", () => intentNotice)
		.trim();
}

export class FoldCoordinator {
	/**
	 * Slots and receipt carriers are keyed by the `AsyncJob` INSTANCE, so two
	 * managers minting identical ids/generations can never collide, and an entry
	 * cannot outlive the object it belongs to.
	 */
	readonly #slots = new WeakMap<AsyncJob, FoldSlot>();
	readonly #carriers = new WeakMap<AsyncJob, FoldReceipt>();
	readonly #participants = new Map<number, FoldAdapter>();
	#nextParticipantId = 0;
	readonly #folding = new WeakSet<AsyncJob>();
	/** Jobs whose completion notice has already been emitted. */
	readonly #noticed = new WeakSet<AsyncJob>();
	/** Jobs whose receipt-bearing completion has already been queued. */
	readonly #delivered = new WeakSet<AsyncJob>();
	readonly #deps: FoldCoordinatorDeps;

	constructor(deps: FoldCoordinatorDeps) {
		this.#deps = deps;
	}

	/** Register a foldable wait. The most recently registered wait is the default target. */
	registerParticipant(adapter: FoldAdapter): () => void {
		const key = ++this.#nextParticipantId;
		this.#participants.set(key, adapter);
		return () => {
			if (this.#participants.get(key) === adapter) this.#participants.delete(key);
		};
	}

	/** Whether any wait is currently foldable, for the key-availability gate. */
	hasFoldableParticipant(): boolean {
		return this.#participants.size > 0;
	}

	/** Deterministic target: newest registration wins, so the chord folds what the user is watching. */
	resolveTarget(): FoldAdapter | undefined {
		let target: FoldAdapter | undefined;
		for (const adapter of this.#participants.values()) target = adapter;
		return target;
	}

	/**
	 * T1. Synchronous prologue then async durability tail.
	 *
	 * Nothing awaits before the slot is reserved and the fence is armed, so a
	 * completion or a steering submission that races the capture cannot slip
	 * past into the old turn.
	 *
	 * A `steer` fold is the one trigger that does NOT end the turn: the steer
	 * that caused it must be consumed by the same run at the tool boundary
	 * right after the fold result (subagent-await parity), so no fence is
	 * armed, no stop is requested, and no remaining intent is captured.
	 */
	async requestFold(explicit?: FoldAdapter, reason: FoldReason = "chord"): Promise<FoldRequestResult> {
		// S1 resolve target.
		const adapter = explicit ?? this.resolveTarget();
		if (!adapter) return { status: "unavailable", reason: "no foldable wait is registered" };

		// S2 acquire identity ONCE through the registration-bound resolver.
		const job = adapter.getJob();
		if (!job) return { status: "already-terminal", reason: "the wait already settled or was evicted" };
		if (job.generation !== adapter.jobGeneration) {
			return { status: "already-terminal", reason: "the job id was reused under a new generation" };
		}
		if (this.#folding.has(job) || this.#slots.has(job)) {
			return { status: "unavailable", reason: "a fold is already in progress for this wait" };
		}

		// S3 claim + reserve, S4 hand-off is the reservation itself, S5 arm the fence.
		this.#folding.add(job);
		this.#slots.set(job, { state: "reserved", adapter, parked: undefined, parkedAt: undefined });
		const fencesOriginatingTurn =
			reason !== "steer" && (adapter.originatingTurn ?? this.#deps.hasActiveTurn?.() ?? true);
		const releaseFence = fencesOriginatingTurn ? this.#deps.armSteeringFence() : () => {};

		let remainingIntent: string | undefined;
		try {
			// A1 capture.
			const signal = adapter.signal;
			if (signal?.aborted) throw new Error("fold capture aborted");
			const capture = Promise.resolve(this.#deps.captureRemainingIntent());
			if (!fencesOriginatingTurn) {
				remainingIntent = undefined;
			} else if (!signal) {
				remainingIntent = await capture;
			} else {
				const aborted = Promise.withResolvers<never>();
				const onAbort = () => aborted.reject(new Error("fold capture aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					remainingIntent = await Promise.race([capture, aborted.promise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			}
		} catch (error) {
			return this.#rollback(job, adapter, releaseFence, error instanceof Error ? error.message : String(error));
		}

		// T-R3a: revalidate the reservation after the await. A cancellation during
		// capture already retired the slot; it must NOT be recreated here, and the
		// participant must not be left advertised as folding.
		const current = this.#slots.get(job);
		if (!current || current.adapter !== adapter) {
			this.#folding.delete(job);
			releaseFence();
			return { status: "already-terminal", reason: "the wait settled while its receipt was being captured" };
		}
		if (adapter.signal?.aborted || job.status !== "running") {
			return this.#rollback(job, adapter, releaseFence, "the wait settled while its receipt was being captured");
		}

		const receipt: FoldReceipt = {
			jobId: adapter.jobId,
			jobGeneration: adapter.jobGeneration,
			kind: adapter.kind,
			label: adapter.label,
			outputRef: adapter.outputRef,
			remainingIntent,
			foldedAt: Date.now(),
			cwdSensitive: adapter.cwdSensitive,
			reason,
		};

		// A2 promote to present, preserving any payload parked during capture.
		const parked = current.state === "reserved" ? current.parked : undefined;
		this.#slots.set(job, { state: "present", adapter, receipt });

		// A3 detach the observer, A4 arm the cooperative stop, A5 leave folding.
		const detached = adapter.detachObserver(receipt);
		if (detached === "already-settled") {
			this.#slots.delete(job);
			this.#folding.delete(job);
			releaseFence();
			return { status: "already-terminal", reason: "the foreground observer already settled" };
		}
		if (fencesOriginatingTurn) this.#deps.requestStop();
		this.#folding.delete(job);

		// A6 flush: replay a parked completion through the same T2 branch so it
		// takes the receipt exactly once instead of being handled specially — and
		// push it into the wake path, because the delivery seam already returned
		// early on it and will not retry.
		if (parked) {
			const replayed = this.onDelivery(job, parked.text);
			if (replayed.kind === "receipt") this.#deps.deliverParked(job, replayed);
		}

		// A7 the fence stays armed until the turn actually stops; releasing here
		// would readmit old-turn steering into the run being wound down.
		return { status: "folded", receipt };
	}

	/**
	 * T2. Decide what a delivery carries, branching on the DURABLE slot state
	 * rather than on transient hand-off state.
	 *
	 * `present` attaches the receipt to the retry-stable carrier BEFORE clearing
	 * the slot, so a retried invocation still finds it.
	 */
	onDelivery(job: AsyncJob, text: string): FoldDeliveryDisposition {
		const carried = this.#carriers.get(job);
		if (carried) return { kind: "receipt", receipt: carried, text };

		const slot = this.#slots.get(job);
		if (!slot) return { kind: "ordinary" };

		if (slot.state === "reserved") {
			// Park: the receipt does not exist yet, so enqueue nothing. A6 replays it.
			slot.parked = { jobId: slot.adapter.jobId, generation: slot.adapter.jobGeneration, text };
			slot.parkedAt = Date.now();
			const timer = setTimeout(() => this.retire(job, "evict"), FOLD_WAKE_MERGE_WINDOW_MS * 4);
			timer.unref();
			return { kind: "parked" };
		}

		// Attach first, then release the slot: order matters for retries.
		this.#carriers.set(job, slot.receipt);
		this.#slots.delete(job);
		return { kind: "receipt", receipt: slot.receipt, text };
	}

	/**
	 * Retirement. T-R2: never drop a slot that holds an undelivered payload or
	 * that a still-possible delivery could consume.
	 *
	 * - `cancel` retires freely, because a cancelled job enqueues no delivery at
	 *   all, so no later consumer can arrive.
	 * - `evict` only retires when the job can no longer deliver. An evicted
	 *   record still delivers with its retained job object, so a completed or
	 *   failed job keeps its slot.
	 */
	retire(job: AsyncJob, reason: FoldRetireReason): boolean {
		const slot = this.#slots.get(job);
		if (!slot) return false;

		if (reason === "cancel") {
			this.#slots.delete(job);
			this.#folding.delete(job);
			return true;
		}

		if (slot.state === "reserved" && slot.parked !== undefined) {
			const parkedAt = slot.parkedAt ?? Date.now();
			if (Date.now() - parkedAt < FOLD_WAKE_MERGE_WINDOW_MS * 4) return false;
			const parked = slot.parked;
			this.#slots.delete(job);
			this.#folding.delete(job);
			slot.adapter.resolveForegroundObserver(parked);
			return true;
		}
		if (job.status === "cancelled" || job.status === "paused") {
			this.#slots.delete(job);
			this.#folding.delete(job);
			return true;
		}
		return false;
	}

	/**
	 * Claim the single completion notice for a job.
	 *
	 * Returns true exactly once per job. A delivery can be retried with the same
	 * object, so an unguarded notice would repeat for one completion.
	 */
	claimCompletionNotice(job: AsyncJob): boolean {
		if (this.#noticed.has(job)) return false;
		this.#noticed.add(job);
		return true;
	}

	/** Claim the receipt-bearing queue entry once across manager delivery retries. */
	claimCompletionDelivery(job: AsyncJob): boolean {
		if (this.#delivered.has(job)) return false;
		this.#delivered.add(job);
		return true;
	}

	/** Test/diagnostic view of the durable slot state for a job. */
	slotStateFor(job: AsyncJob): "none" | "reserved-empty" | "reserved-parked" | "present" | "carried" {
		const slot = this.#slots.get(job);
		if (slot?.state === "present") return "present";
		if (slot?.state === "reserved") return slot.parked === undefined ? "reserved-empty" : "reserved-parked";
		return this.#carriers.has(job) ? "carried" : "none";
	}

	#rollback(job: AsyncJob, adapter: FoldAdapter, releaseFence: () => void, reason: string): FoldRequestResult {
		const slot = this.#slots.get(job);
		// R1/R2 return the claim and drop the reservation, R3 release the fence so
		// the preserved steering becomes admissible again, R5 never arm the stop.
		this.#slots.delete(job);
		this.#folding.delete(job);
		releaseFence();
		// R4 hand a parked completion back to the STILL-ATTACHED observer, which
		// owns its own acknowledgement path. The coordinator enqueues nothing, so
		// it cannot race that observer.
		if (slot?.state === "reserved" && slot.parked) adapter.resolveForegroundObserver(slot.parked);
		return { status: "capture-failed", reason };
	}
}
