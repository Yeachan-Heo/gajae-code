/**
 * The per-manager claim set (design §2.5): the session claims one SessionManager holds, keyed by
 * session id, with every release point of the design's table.
 *
 * Factories and transitions claim through {@link SessionClaimSet.claim}, the one place a manager
 * takes a claim; the detector never claims. It releases a claim only when its id is no longer the
 * manager's current id and no transition is open, so a predecessor stays claimed until its rotation
 * commits, and a rollback that restores the predecessor releases the target instead. In `off`, and
 * for an exempt manager, nothing is ever claimed and every operation is a no-op.
 */
import { logger } from "@gajae-code/utils";
import type { SessionManager } from "../session-manager";
import {
	claimSessionOwner,
	countSessionOwnershipEvent,
	probeSessionOwners,
	SessionHeldError,
	type SessionOwnerClaim,
	type SessionOwnerHolder,
	type SessionOwnerProbe,
	type SessionOwnerSurface,
	SessionOwnershipError,
	sessionOwnerHolderPhrase,
	sessionOwnerSurface,
} from "../session-ownership";
import {
	liveSessionOwnershipModeFor,
	type SessionOwnershipMode,
	sessionOwnershipMode,
	sessionOwnershipTestHookSlot,
} from "../session-ownership-mode";

/**
 * A factory's ownership decision (design §2.4): claim under `surface`, or never claim (`exempt`).
 * `mode` is the mode as the factory read it; a factory reads it once and hands it on.
 */
export type SessionOwnershipDecision =
	| "exempt"
	| { readonly surface: SessionOwnerSurface; readonly mode?: SessionOwnershipMode };

/**
 * The decision a persisting manager is constructed with. Required by the constructor, so a factory
 * cannot build a manager without deciding.
 */
export type ResolvedSessionOwnership =
	| "exempt"
	| { readonly surface: SessionOwnerSurface; readonly mode: SessionOwnershipMode };

/** Read the mode once, for one factory; without a decision, claim as this process's surface. */
export function resolveSessionOwnership(
	decision: SessionOwnershipDecision = { surface: sessionOwnerSurface() },
): ResolvedSessionOwnership {
	if (decision === "exempt") return "exempt";
	return { surface: decision.surface, mode: decision.mode ?? sessionOwnershipMode() };
}

/**
 * Whether `ownership` takes claims at all. Callers check this before awaiting a claim, so `off` and
 * exempt managers add no await and keep their ordering exactly as before ownership existed.
 */
export function claimsUnder(ownership: ResolvedSessionOwnership): boolean {
	return ownership !== "exempt" && ownership.mode !== "off";
}

/**
 * The outcome of one claim attempt. `none`: nothing was attempted (off, exempt) or the claim failed
 * open, with `skipped` naming why (`unavailable` is permanent, `timed_out` is that one call);
 * `failed`: a failure enforce refuses (counted `claim_failed`), with that failure; `held`: another
 * process holds the session (counted `claim_conflict`), with its holder if known.
 */
type SessionClaimRefusable =
	| { readonly status: "held"; readonly holder?: SessionOwnerHolder }
	| { readonly status: "failed"; readonly error: SessionOwnershipError };
type SessionClaimNone = { readonly status: "none"; readonly skipped?: "unavailable" | "timed_out" };
export type SessionClaimOutcome = { readonly status: "claimed" } | SessionClaimNone | SessionClaimRefusable;
export type SessionClaimAttempt =
	| { readonly status: "claimed"; readonly claim: SessionOwnerClaim }
	| SessionClaimNone
	| SessionClaimRefusable;
export type SessionClaimStatus = SessionClaimOutcome["status"];

/** An attempt as the claim set records it: without the claim handle. */
function outcomeOf(attempt: SessionClaimAttempt): SessionClaimOutcome {
	return attempt.status === "claimed" ? { status: "claimed" } : attempt;
}

/**
 * One claim attempt under `ownership`, never throwing (design §13 M2). A held session (counted
 * `claim_conflict`) and an owners-directory failure (counted `claim_failed`) are logged and returned;
 * {@link claimRefusal} decides whether enforce refuses them. `previous`, the outcome a re-attempt
 * repeats, keeps the same outcome again from being counted or logged again.
 */
export async function attemptSessionClaim(
	ownership: ResolvedSessionOwnership,
	sessionId: string,
	previous?: SessionClaimOutcome,
): Promise<SessionClaimAttempt> {
	if (ownership === "exempt" || ownership.mode === "off") return { status: "none" };
	const repeat =
		previous?.status === "held"
			? "held"
			: previous?.status === "none" && previous.skipped === "timed_out"
				? "timed_out"
				: undefined;
	try {
		const result = await claimSessionOwner(sessionId, { surface: ownership.surface, repeat });
		if (result.status === "claimed") return result;
		if (result.status === "held") {
			if (repeat !== "held")
				logger.warn("Session is open for writing in another process", {
					mode: ownership.mode,
					holder: sessionOwnerHolderPhrase(result.holder),
				});
			return { status: "held", holder: result.holder };
		}
		return { status: "none", skipped: result.reason };
	} catch (error) {
		if (previous?.status !== "failed") {
			countSessionOwnershipEvent("claim_failed");
			logger.warn("Session claim failed", { mode: ownership.mode, error: String(error) });
		}
		return {
			status: "failed",
			error:
				error instanceof SessionOwnershipError
					? error
					: new SessionOwnershipError("claim_failed", { cause: error }),
		};
	}
}

/**
 * The one refusal decision (design §3.3, 5a): the error enforce raises for a claim outcome, or
 * `undefined` to go on without a claim. Only `held` (a {@link SessionHeldError} naming the holder)
 * and `failed` (the owners-directory failure, fail-closed like the append lock) refuse, and only when
 * both the mode the factory read and the live mode are `enforce`: the live read only ever lowers it.
 */
export function claimRefusal(
	ownership: ResolvedSessionOwnership,
	sessionId: string,
	outcome: SessionClaimOutcome | SessionClaimAttempt | undefined,
): SessionHeldError | SessionOwnershipError | undefined {
	if (ownership === "exempt" || ownership.mode !== "enforce") return undefined;
	if (outcome?.status !== "held" && outcome?.status !== "failed") return undefined;
	if (liveSessionOwnershipModeFor(ownership.mode) !== "enforce") return undefined;
	return outcome.status === "held" ? new SessionHeldError(sessionId, outcome.holder) : outcome.error;
}

/**
 * Run `write`, a short write to a session that is not the caller's own (a picker star or delete,
 * design §1 row 17), under a scoped claim: claim, write, release. Enforce refuses a session another
 * process holds, and a claim that failed, with `Can't <action> this session: …` (the refusal is the
 * `cause`), so the holder keeps its transcript; observe logs and counts the conflict and writes as
 * before; off and exempt make no lock call. A session this process holds shares its claim (D10).
 */
export async function withScopedSessionClaim<T>(
	ownership: ResolvedSessionOwnership,
	sessionId: string,
	action: string,
	write: () => Promise<T>,
): Promise<T> {
	if (!claimsUnder(ownership)) return await write();
	const attempt = await attemptSessionClaim(ownership, sessionId);
	try {
		const refusal = claimRefusal(ownership, sessionId, attempt);
		if (refusal) {
			const reason =
				refusal instanceof SessionHeldError
					? `it is open in ${sessionOwnerHolderPhrase(refusal.holder)}`
					: "gjc could not check whether another process has it open";
			throw new Error(`Can't ${action} this session: ${reason}.`, { cause: refusal });
		}
		return await write();
	} finally {
		if (attempt.status === "claimed") attempt.claim.release();
	}
}

/**
 * The sessions enforce would refuse because another process holds them, each with the refusal that
 * names its holder: what the held-session warning and the session list's markers show (design §1
 * rows 1-3). A probe, never a claim: the claim stays the authority, and a race falls back to its
 * refusal. `undefined`, with nothing awaited, outside enforce; a probe that fails reads as free.
 */
export function probeHeldSessions(
	ownership: ResolvedSessionOwnership,
	sessionIds: readonly string[],
): Promise<Map<string, SessionHeldError>> | undefined {
	if (ownership === "exempt" || ownership.mode !== "enforce") return undefined;
	return heldSessionRefusals(ownership, sessionIds);
}

async function heldSessionRefusals(
	ownership: ResolvedSessionOwnership,
	sessionIds: readonly string[],
): Promise<Map<string, SessionHeldError>> {
	const held = new Map<string, SessionHeldError>();
	let probes: Map<string, SessionOwnerProbe>;
	try {
		probes = await probeSessionOwners(sessionIds.filter(id => id.length > 0));
	} catch (error) {
		logger.debug("Session owner probe failed; sessions read as free", { error: String(error) });
		return held;
	}
	for (const [sessionId, probe] of probes) {
		if (probe.state !== "held" || probe.self) continue;
		const refusal = claimRefusal(ownership, sessionId, { status: "held", holder: probe.holder });
		if (refusal instanceof SessionHeldError) held.set(sessionId, refusal);
	}
	return held;
}

/** How long a deferred owner shutdown may keep its predecessor's claim (design §2.5). */
export const DEFERRED_RELEASE_CAP_MS = 60_000;

/**
 * Turn start's re-attempt backoff (design §13.1, timeout-latch policy). A held session costs one
 * non-blocking lock call, so it is retried after a short floor; a timed-out or failed claim can cost
 * the full native budget, so it backs off exponentially up to the cap.
 */
export const RECLAIM_HELD_FLOOR_MS = 5_000;
export const RECLAIM_BACKOFF_BASE_MS = 10_000;
export const RECLAIM_BACKOFF_CAP_MS = 300_000;

/** What turn start's re-attempt found ({@link SessionClaimSet.reclaimCurrent}). */
export interface SessionReclaim {
	/** The current session's outcome now; `timed_out` is a `none` that a lock stall caused. */
	readonly status: SessionClaimStatus | "timed_out";
	/** Enforce's refusal of the turn ({@link claimRefusal}): the holder keeps the session. */
	readonly refusal?: SessionHeldError | SessionOwnershipError;
}

/** Thrown only under the strict test seam, for a write the detector flags. */
export class SessionWriteWithoutClaimError extends Error {
	readonly code = "session_write_without_claim";
	readonly site: string;

	constructor(site: string) {
		super(`session_write_without_claim: ${site}`);
		this.name = "SessionWriteWithoutClaimError";
		this.site = site;
	}
}

interface DeferredHold {
	readonly sessionId: string;
	timer: NodeJS.Timeout | undefined;
}

/**
 * A manager dropped with claims still in its set never released them; the locks stay until the
 * process exits. Count and log it, so the observe phase shows the missed release. The held value is
 * the claims map, which does not reference its set.
 */
const abandonedSets = new FinalizationRegistry<Map<string, SessionOwnerClaim>>(claims => {
	const left = [...claims.values()].filter(claim => !claim.released).length;
	if (left === 0) return;
	for (let index = 0; index < left; index++) countSessionOwnershipEvent("claims_abandoned");
	logger.warn("Session claims left on an abandoned session manager", { claims: left });
});

export class SessionClaimSet {
	readonly #claims = new Map<string, SessionOwnerClaim>();
	readonly #holds = new Map<string, DeferredHold>();
	/** Claims in flight, by id. The detector counts them as covered: a factory started them before any write. */
	readonly #pending = new Map<string, Promise<unknown>>();
	/** Ids whose write a pending claim covered: if that claim does not land, the write is counted then. */
	readonly #coveredByPending = new Map<string, string>();
	/** The last claim outcome per id, read by the refusal gates (5a). */
	readonly #outcomes = new Map<string, SessionClaimOutcome>();
	#current: string | undefined;
	#transitions = 0;
	#closed = false;
	/** The factory's decision, with the mode it read once; a settings reload never changes it under a manager. */
	readonly #ownership: ResolvedSessionOwnership;
	/** Detector reports already logged, as `<id> <site>`: log once, count every time. */
	readonly #reported = new Set<string>();
	/** Turn start's re-attempts per id since its last claim: how many, and when the next may run. */
	readonly #reclaims = new Map<string, { readonly attempts: number; readonly notBefore: number }>();
	/** Ids a refused write queued a background re-attempt for. */
	readonly #reclaimQueued = new Set<string>();

	constructor(ownership: ResolvedSessionOwnership = resolveSessionOwnership()) {
		this.#ownership = ownership;
		abandonedSets.register(this, this.#claims);
	}

	/** False in `off` and for an exempt manager: check it before awaiting {@link claim} or {@link settled}. */
	get claiming(): boolean {
		return this.#mode !== "off";
	}

	/** The decision this set claims under, for a scoped claim made on the manager's behalf. */
	get ownership(): ResolvedSessionOwnership {
		return this.#ownership;
	}

	get #mode(): SessionOwnershipMode {
		return this.#ownership === "exempt" ? "off" : this.#ownership.mode;
	}

	/** The session id the manager's identity helper last bound. */
	get currentSessionId(): string | undefined {
		return this.#current;
	}

	get sessionIds(): readonly string[] {
		return [...this.#claims.keys()];
	}

	has(sessionId: string): boolean {
		return this.#claims.has(sessionId);
	}

	/**
	 * The identity helper's record of the manager's id. It never claims. A change of id outside any
	 * transition is counted (when ownership is on): nothing settles after it. The first bind settles,
	 * so a claim a factory took for an id it did not adopt (a fork attempt that fell back) goes.
	 */
	bind(sessionId: string): void {
		const previous = this.#current;
		this.#current = sessionId;
		if (previous === undefined) this.settle();
		if (this.#mode === "off" || previous === undefined || previous === sessionId || this.#transitions > 0) return;
		countSessionOwnershipEvent("bind_outside_transition");
		logger.debug("Session id changed outside a claim-set transition", { mode: this.#mode });
	}

	/**
	 * Claim `sessionId` into this set (design §2.4): a factory's id before its first write, or a
	 * transition's target before its rotation. Catches lock errors, but rejects if `add` throws
	 * `session_claim_released`; a no-op in `off`, for an exempt manager, and for an id already held.
	 *
	 * Outside any transition the claim is a factory's, made before the factory's first write and
	 * before it hands the manager out: there enforce refuses a held or failed outcome by throwing
	 * {@link claimRefusal}'s error. A transition's claim never refuses: a switch is refused before its
	 * transition begins, by the manager's switch-target admission.
	 */
	async claim(sessionId: string): Promise<SessionClaimStatus> {
		return this.#claim(sessionId, false);
	}

	/** {@link claim}; a turn-start `reattempt` repeats the id's last outcome without counting it again. */
	async #claim(sessionId: string, reattempt: boolean): Promise<SessionClaimStatus> {
		if (this.#mode === "off" || this.#closed) return "none";
		if (this.#claims.has(sessionId)) return "claimed";
		const inFlight = this.#pending.get(sessionId);
		if (inFlight) {
			await inFlight;
			return this.#admit(sessionId);
		}
		const previous = reattempt ? this.#outcomes.get(sessionId) : undefined;
		const attempt = attemptSessionClaim(this.#ownership, sessionId, previous);
		this.#pending.set(sessionId, attempt);
		let status: SessionClaimStatus = "none";
		try {
			const result = await attempt;
			status = result.status;
			this.#record(sessionId, outcomeOf(result));
			if (result.status === "claimed") {
				// A re-attempt whose session the manager left while it was in flight is no staged target:
				// released, so no `claimed` outcome stays recorded for it.
				if (reattempt && sessionId !== this.#current && this.#transitions === 0) {
					result.claim.release();
					this.#outcomes.delete(sessionId);
				} else this.add(result.claim);
			}
		} finally {
			this.#pending.delete(sessionId);
			const coveredSite = this.#coveredByPending.get(sessionId);
			this.#coveredByPending.delete(sessionId);
			// Only a session another process holds is a write without a claim; a fail-open or failed
			// claim (no lock on this platform, a stall, an owners-directory failure) is not.
			if (coveredSite !== undefined && status === "held")
				this.#reportWithoutClaim(`claim in flight: ${coveredSite}`, sessionId);
		}
		return this.#admit(sessionId);
	}

	/** A factory's claim outcome, or its refusal; a transition's outcome is never refused. */
	#admit(sessionId: string): SessionClaimStatus {
		const outcome = this.#outcomes.get(sessionId);
		if (this.#transitions === 0) {
			const refusal = claimRefusal(this.#ownership, sessionId, outcome);
			if (refusal) throw refusal;
		}
		return outcome?.status ?? "none";
	}

	/**
	 * A sync factory's claim (`create`): started now, settled later. A write made while it is in flight
	 * is covered, because the id is fresh and no other process can hold it.
	 */
	claimInBackground(sessionId: string): void {
		if (!this.claiming) return;
		void this.claim(sessionId)
			.then(() => {
				// Landed after a rotation already settled away from it: release it now, not at the next settle.
				if (this.#current !== sessionId && this.#transitions === 0) this.settle();
			})
			// `claim` catches lock errors but rejects with enforce's refusal (the gate in `refusal()` reports
			// it again) or if `add` throws `session_claim_released`; the settle can throw too. A background
			// claim must not become an unhandled rejection in any process.
			.catch(error => {
				logger.warn("Background session claim failed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** Record the outcome of a claim taken before this set existed (a strict open's, handed over). */
	noteOutcome(sessionId: string, outcome: SessionClaimOutcome): void {
		this.#record(sessionId, outcome);
	}

	/**
	 * Record an id's claim outcome and when turn start may re-attempt it. An open's own outcome seeds
	 * the backoff, so the first turn after a stalled open does not stall again at once. A held session
	 * waits the short floor and restarts the exponential count; a timeout or failure doubles it.
	 */
	#record(sessionId: string, outcome: SessionClaimOutcome): void {
		this.#outcomes.set(sessionId, outcome);
		const retried =
			outcome.status === "held" ||
			outcome.status === "failed" ||
			(outcome.status === "none" && outcome.skipped === "timed_out");
		if (!retried) {
			this.#reclaims.delete(sessionId);
			return;
		}
		if (outcome.status === "held") {
			this.#reclaims.set(sessionId, { attempts: 0, notBefore: Date.now() + RECLAIM_HELD_FLOOR_MS });
			return;
		}
		const attempts = this.#reclaims.get(sessionId)?.attempts ?? 0;
		const delay = Math.min(RECLAIM_BACKOFF_BASE_MS * 2 ** attempts, RECLAIM_BACKOFF_CAP_MS);
		this.#reclaims.set(sessionId, { attempts: attempts + 1, notBefore: Date.now() + delay });
	}

	/**
	 * Wait for the claims in flight, then the outcome for the current id. `undefined` when nothing
	 * was attempted.
	 */
	async settled(): Promise<SessionClaimStatus | undefined> {
		await Promise.all(this.#pending.values());
		return this.#current === undefined ? undefined : this.#outcomes.get(this.#current)?.status;
	}

	/**
	 * The gate for a manager about to be used for writing (`createAgentSession`, session import):
	 * waits for the claims in flight and returns enforce's refusal for the current id, if any. It
	 * catches what no factory refused, such as the background claim of `create`.
	 */
	async refusal(): Promise<SessionHeldError | SessionOwnershipError | undefined> {
		await Promise.all(this.#pending.values());
		const current = this.#current;
		return current === undefined ? undefined : claimRefusal(this.#ownership, current, this.#outcomes.get(current));
	}

	/**
	 * Turn start's re-attempt of the current id's claim (design §2.7, §13.1): a claim another process
	 * held, or one that timed out or failed, is tried again, so a writer whose open did not claim
	 * becomes visible once it can. `undefined`, with nothing awaited, when there is nothing to
	 * re-attempt (off, exempt, closed, inside a transition, already claimed, a permanent fail-open, a
	 * live mode lowered to off, inside the backoff) and whenever the turn does not depend on it: in
	 * observe, or with the live mode lowered from enforce, the re-attempt runs in the background, and
	 * the writes it overlaps are covered as a pending claim's are. Only under enforce does the turn wait,
	 * joining a claim already in flight; there a held or failed claim is re-attempted at every turn, so
	 * no turn passes it unchecked. Never rejects: enforce's refusal comes back as a value, and the
	 * session is never taken from its holder.
	 */
	reclaimCurrent(): Promise<SessionReclaim> | undefined {
		const sessionId = this.#current;
		if (sessionId === undefined || this.#mode === "off" || this.#closed || this.#transitions > 0) return undefined;
		if (this.#claims.has(sessionId)) return undefined;
		const inFlight = this.#pending.get(sessionId);
		const outcome = this.#outcomes.get(sessionId);
		if (!inFlight) {
			if (outcome === undefined || outcome.status === "claimed") return undefined;
			if (outcome.status === "none" && outcome.skipped !== "timed_out") return undefined;
		}
		const live = liveSessionOwnershipModeFor(this.#mode);
		if (live === "off") return undefined;
		const enforced = this.#mode === "enforce" && live === "enforce";
		// A claim in flight already covers the writes; only enforce's turn waits for its outcome.
		if (inFlight) return enforced ? this.#joinReclaim(sessionId, inFlight) : undefined;
		if (outcome === undefined) return undefined;
		// What enforce refuses (another holder, a failed claim) is checked at every turn: a backoff
		// would let the turns inside it through, writing.
		const checksEveryTurn = enforced && (outcome.status === "held" || outcome.status === "failed");
		const backoff = this.#reclaims.get(sessionId);
		if (!checksEveryTurn && backoff !== undefined && Date.now() < backoff.notBefore) return undefined;
		const reclaim = this.#reclaim(sessionId);
		if (enforced) return reclaim;
		void reclaim;
		return undefined;
	}

	async #reclaim(sessionId: string): Promise<SessionReclaim> {
		try {
			await this.#claim(sessionId, true);
		} catch (error) {
			// `#claim` rejects with enforce's refusal, recorded as the outcome and returned below.
			if (!(error instanceof SessionHeldError || error instanceof SessionOwnershipError))
				logger.warn("Session claim re-attempt failed", { error: String(error) });
		}
		return this.#reclaimResult(sessionId);
	}

	async #joinReclaim(sessionId: string, inFlight: Promise<unknown>): Promise<SessionReclaim> {
		await inFlight.catch(() => undefined);
		return this.#reclaimResult(sessionId);
	}

	/** The re-attempt's result for the turn: nothing to refuse once the manager rotated away. */
	#reclaimResult(sessionId: string): SessionReclaim {
		if (this.#current !== sessionId) return { status: "none" };
		const outcome = this.#outcomes.get(sessionId);
		const status =
			outcome?.status === "none" && outcome.skipped === "timed_out" ? "timed_out" : (outcome?.status ?? "none");
		return { status, refusal: claimRefusal(this.#ownership, sessionId, outcome) };
	}

	/**
	 * Enforce's write gate (design §2.5, §13.1): a write to an id whose recorded outcome enforce
	 * refuses (`held`: a turn-start re-attempt found another holder, or a transition landed held;
	 * `failed`: the claim failed, fail-closed) is refused with {@link claimRefusal}'s error, so no
	 * writer outside a turn (a title, a rename, a compaction, an extension's entry, an SDK append)
	 * writes over a holder. It reads only the recorded outcome and makes no lock call; the turn gate is
	 * what finds the holder. A refusal starts a background re-attempt (within the backoff), so the gate
	 * lifts on its own soon after the holder exits. Inside a transition nothing is refused.
	 */
	refuseWriteIfRefused(sessionId: string | undefined = this.#current): void {
		if (sessionId === undefined || this.#mode !== "enforce" || this.#transitions > 0) return;
		if (this.#claims.has(sessionId)) return;
		const outcome = this.#outcomes.get(sessionId);
		if (outcome?.status !== "held" && outcome?.status !== "failed") return;
		const refusal = claimRefusal(this.#ownership, sessionId, outcome);
		if (!refusal) return;
		this.#reclaimSoon(sessionId);
		throw refusal;
	}

	/** A background re-attempt of `sessionId` after this write returns, unless one is in flight or backing off. */
	#reclaimSoon(sessionId: string): void {
		if (this.#reclaimQueued.has(sessionId)) return;
		this.#reclaimQueued.add(sessionId);
		queueMicrotask(() => {
			this.#reclaimQueued.delete(sessionId);
			const backoff = this.#reclaims.get(sessionId);
			if (this.#closed || this.#transitions > 0 || this.#pending.has(sessionId) || this.#claims.has(sessionId))
				return;
			if (backoff !== undefined && Date.now() < backoff.notBefore) return;
			void this.#reclaim(sessionId);
		});
	}

	/**
	 * The write-path detector (design §2.5), called before a transcript write. When ownership is on
	 * and this set holds no claim for `sessionId` (the current id unless a successor is named), it
	 * logs `session_write_without_claim` with the call site and counts it. It never claims, and it
	 * throws only under the strict test seam. In `off` it returns at once.
	 *
	 * A write made before the manager's first bind (a factory publishing a new transcript before it
	 * adopts it) must name its id: with nothing bound there is no current id.
	 */
	checkWrite(site: string, sessionId: string | undefined = this.#current): void {
		if (sessionId === undefined) return;
		if (this.#mode === "off" || this.#claims.has(sessionId)) return;
		this.refuseWriteIfRefused(sessionId);
		// The claim for this id failed open (`none` while claiming) or failed: nothing to detect, and
		// counting it would make every Windows or stalled-filesystem process report writes.
		const outcome = this.#outcomes.get(sessionId)?.status;
		if (outcome === "none" || outcome === "failed") return;
		if (this.#pending.has(sessionId)) {
			if (!this.#coveredByPending.has(sessionId)) this.#coveredByPending.set(sessionId, site);
			return;
		}
		this.#reportWithoutClaim(site, sessionId);
		if (sessionOwnershipTestHookSlot().strictWriteDetection) throw new SessionWriteWithoutClaimError(site);
	}

	#reportWithoutClaim(site: string, sessionId: string): void {
		countSessionOwnershipEvent("session_write_without_claim");
		const report = `${sessionId} ${site}`;
		if (this.#reported.has(report)) return;
		this.#reported.add(report);
		logger.warn("session_write_without_claim", { site, sessionId, mode: this.#mode });
	}

	/**
	 * Take ownership of a claim: a factory's, or a transition's target claimed before the rotation.
	 * The key is the id, so a second claim of an id already here is released at once (one claim per id).
	 */
	add(claim: SessionOwnerClaim): void {
		if (claim.released) throw new Error("session_claim_released");
		if (this.#claims.has(claim.sessionId) || this.#closed) {
			claim.release();
			return;
		}
		this.#claims.set(claim.sessionId, claim);
		// A target staged outside the transition that rotates to it is exposed to any unrelated
		// transition's settle. Visible in observe; off stays inert.
		if (
			this.#mode !== "off" &&
			this.#current !== undefined &&
			claim.sessionId !== this.#current &&
			this.#transitions === 0
		)
			countSessionOwnershipEvent("target_staged_outside_transition");
	}

	/**
	 * Open a transition: no claim is released until the outermost transition ends. Disposing settles,
	 * so the claims kept are exactly those for the id current at the end (rotation committed: the
	 * predecessor goes; rolled back or cancelled: the target goes).
	 */
	transition(): Disposable {
		this.#transitions += 1;
		let open = true;
		return {
			[Symbol.dispose]: () => {
				if (!open) return;
				open = false;
				this.#transitions -= 1;
				this.settle();
			},
		};
	}

	/**
	 * Release every claim whose id is not current and not held for a deferred shutdown. Runs when the
	 * outermost transition ends, so a target added outside any transition stays until the next one
	 * settles; stage targets inside the transition that rotates to them.
	 */
	settle(): void {
		if (this.#transitions > 0 || this.#current === undefined) return;
		for (const [sessionId, claim] of [...this.#claims]) {
			if (sessionId === this.#current || this.#holds.has(sessionId)) continue;
			this.#claims.delete(sessionId);
			claim.release();
		}
	}

	/**
	 * Deferred owner shutdown: keep `sessionId` while `finalization` runs, at most `capMs`. A hold that
	 * reaches the cap releases anyway and counts `release_after_deferred_timeout`.
	 */
	holdUntil(sessionId: string, finalization: Promise<unknown>, capMs = DEFERRED_RELEASE_CAP_MS): void {
		if (!this.#claims.has(sessionId) || this.#holds.has(sessionId)) return;
		const hold: DeferredHold = { sessionId, timer: undefined };
		this.#holds.set(sessionId, hold);
		const end = (timedOut: boolean) => {
			if (this.#holds.get(sessionId) !== hold) return;
			if (hold.timer) clearTimeout(hold.timer);
			this.#holds.delete(sessionId);
			if (timedOut) countSessionOwnershipEvent("release_after_deferred_timeout");
			if (this.#closed) this.#releaseOne(sessionId);
			// Only the held id: any other non-current claim (a target staged before its rotation)
			// waits for the transition that commits or abandons it.
			else if (this.#transitions === 0 && this.#current !== sessionId) this.#releaseOne(sessionId);
		};
		hold.timer = setTimeout(() => end(true), capMs);
		hold.timer.unref();
		finalization.then(
			() => end(false),
			() => end(false),
		);
	}

	/**
	 * `close()`: release every claim. A claim under a deferred hold is released when its hold ends,
	 * at most the cap later; nothing can be added afterwards, and a claim still in flight is released
	 * when it lands.
	 */
	releaseAll(): void {
		this.#closed = true;
		for (const sessionId of [...this.#claims.keys()]) if (!this.#holds.has(sessionId)) this.#releaseOne(sessionId);
	}

	#releaseOne(sessionId: string): void {
		const claim = this.#claims.get(sessionId);
		if (!claim) return;
		this.#claims.delete(sessionId);
		claim.release();
	}
}

/** Opaque capability for a manager's claim set. Excluded from package exports with `internal/`. */
export const sessionClaimSetCapability: unique symbol = Symbol("SessionManager claim set capability");

interface ClaimSetOwner {
	[sessionClaimSetCapability](): SessionClaimSet;
}

/** The claim set of a SessionManager, for factories, transitions and tests in this package. */
export function sessionClaimSetOf(manager: SessionManager): SessionClaimSet {
	return (manager as unknown as ClaimSetOwner)[sessionClaimSetCapability]();
}

/**
 * Turn start's re-attempt for `manager`'s current session ({@link SessionClaimSet.reclaimCurrent});
 * `undefined` for a stand-in manager that has no claim set, as a test's double has none.
 */
export function reclaimCurrentSession(manager: SessionManager): Promise<SessionReclaim> | undefined {
	const owner = manager as unknown as Partial<ClaimSetOwner>;
	if (typeof owner[sessionClaimSetCapability] !== "function") return undefined;
	return sessionClaimSetOf(manager).reclaimCurrent();
}
