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
	type SessionOwnerClaim,
	type SessionOwnerSurface,
	sessionOwnerHolderPhrase,
	sessionOwnerSurface,
} from "../session-ownership";
import {
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
 * The outcome of one claim attempt. `none`: nothing was attempted (off, exempt) or the platform
 * failed open; `failed`: a failure enforce will refuse (counted `claim_failed`); `held`: another
 * process holds the session (counted `claim_conflict`).
 */
export type SessionClaimAttempt =
	| { readonly status: "claimed"; readonly claim: SessionOwnerClaim }
	| { readonly status: "held" | "failed" | "none" };
export type SessionClaimStatus = SessionClaimAttempt["status"];

/**
 * One claim attempt under `ownership`, never throwing (design §13 M2). Nothing refuses yet: a held
 * session (counted `claim_conflict`) and an owners-directory failure (counted `claim_failed`, which
 * enforce will refuse) are logged, and the caller goes on without a claim.
 */
export async function attemptSessionClaim(
	ownership: ResolvedSessionOwnership,
	sessionId: string,
): Promise<SessionClaimAttempt> {
	if (ownership === "exempt" || ownership.mode === "off") return { status: "none" };
	try {
		const result = await claimSessionOwner(sessionId, { surface: ownership.surface });
		if (result.status === "claimed") return result;
		if (result.status === "held") {
			logger.warn("Session is open for writing in another process; continuing without a claim", {
				mode: ownership.mode,
				holder: sessionOwnerHolderPhrase(result.holder),
			});
			return { status: "held" };
		}
	} catch (error) {
		countSessionOwnershipEvent("claim_failed");
		logger.warn("Session claim failed; continuing without a claim", { mode: ownership.mode, error: String(error) });
		return { status: "failed" };
	}
	return { status: "none" };
}

/** How long a deferred owner shutdown may keep its predecessor's claim (design §2.5). */
export const DEFERRED_RELEASE_CAP_MS = 60_000;

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
	/** The last claim outcome per id, read by the gates that will refuse in enforce (5a). */
	readonly #outcomes = new Map<string, SessionClaimStatus>();
	#current: string | undefined;
	#transitions = 0;
	#closed = false;
	/** The factory's decision, with the mode it read once; a settings reload never changes it under a manager. */
	readonly #ownership: ResolvedSessionOwnership;
	/** Detector reports already logged, as `<id> <site>`: log once, count every time. */
	readonly #reported = new Set<string>();

	constructor(ownership: ResolvedSessionOwnership = resolveSessionOwnership()) {
		this.#ownership = ownership;
		abandonedSets.register(this, this.#claims);
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
	 * transition's target before its rotation. Never throws and never refuses (see
	 * {@link attemptSessionClaim}); a no-op in `off`, for an exempt manager, and for
	 * an id already held.
	 */
	async claim(sessionId: string): Promise<SessionClaimStatus> {
		if (this.#mode === "off" || this.#closed) return "none";
		if (this.#claims.has(sessionId)) return "claimed";
		const inFlight = this.#pending.get(sessionId);
		if (inFlight) {
			await inFlight;
			return this.#outcomes.get(sessionId) ?? "none";
		}
		const attempt = attemptSessionClaim(this.#ownership, sessionId);
		this.#pending.set(sessionId, attempt);
		let status: SessionClaimStatus = "none";
		try {
			const result = await attempt;
			status = result.status;
			this.#outcomes.set(sessionId, status);
			if (result.status === "claimed") this.add(result.claim);
			return status;
		} finally {
			this.#pending.delete(sessionId);
			const coveredSite = this.#coveredByPending.get(sessionId);
			this.#coveredByPending.delete(sessionId);
			if (coveredSite !== undefined && status !== "claimed")
				this.#reportWithoutClaim(`claim in flight: ${coveredSite}`, sessionId);
		}
	}

	/**
	 * A sync factory's claim (`create`): started now, settled later. A write made while it is in flight
	 * is covered, because the id is fresh and no other process can hold it.
	 */
	claimInBackground(sessionId: string): void {
		void this.claim(sessionId).then(() => {
			// Landed after a rotation already settled away from it: release it now, not at the next settle.
			if (this.#current !== sessionId && this.#transitions === 0) this.settle();
		});
	}

	/** Record the outcome of a claim taken before this set existed (a strict open's, handed over). */
	noteOutcome(sessionId: string, status: SessionClaimStatus): void {
		this.#outcomes.set(sessionId, status);
	}

	/**
	 * Wait for the claims in flight, then the outcome for the current id: the gate where enforce will
	 * refuse a `held` or `failed` session (5a). `undefined` when nothing was attempted.
	 */
	async settled(): Promise<SessionClaimStatus | undefined> {
		await Promise.all(this.#pending.values());
		return this.#current === undefined ? undefined : this.#outcomes.get(this.#current);
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
