/**
 * The per-manager claim set (design §2.5): the session claims one SessionManager holds, keyed by
 * session id, with every release point of the design's table.
 *
 * Bookkeeping only. It never claims; factories and transitions claim, then hand the claim in. It
 * releases a claim only when its id is no longer the manager's current id and no transition is open,
 * so a predecessor stays claimed until its rotation commits, and a rollback that restores the
 * predecessor releases the target instead. With no claim in the set, every operation is a no-op,
 * which is what `off` gives: nothing ever adds a claim.
 */
import { countSessionOwnershipEvent, type SessionOwnerClaim } from "../session-ownership";

/** How long a deferred owner shutdown may keep its predecessor's claim (design §2.5). */
export const DEFERRED_RELEASE_CAP_MS = 60_000;

interface DeferredHold {
	readonly sessionId: string;
	/** The set that holds the claim now; a manager swap moves holds with their claims. */
	set: SessionClaimSet;
	timer: NodeJS.Timeout | undefined;
}

export class SessionClaimSet {
	readonly #claims = new Map<string, SessionOwnerClaim>();
	readonly #holds = new Map<string, DeferredHold>();
	#current: string | undefined;
	#transitions = 0;
	#closed = false;

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

	/** The identity helper's record of the manager's id. It never claims and never releases. */
	bind(sessionId: string): void {
		this.#current = sessionId;
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
		const hold: DeferredHold = { sessionId, set: this, timer: undefined };
		this.#holds.set(sessionId, hold);
		const end = (timedOut: boolean) => {
			if (hold.set.#holds.get(sessionId) !== hold) return;
			if (hold.timer) clearTimeout(hold.timer);
			hold.set.#holds.delete(sessionId);
			if (timedOut) countSessionOwnershipEvent("release_after_deferred_timeout");
			if (hold.set.#closed) hold.set.#releaseOne(sessionId);
			// Only the held id: any other non-current claim (a target staged before its rotation)
			// waits for the transition that commits or abandons it.
			else if (hold.set.#transitions === 0 && hold.set.#current !== sessionId) hold.set.#releaseOne(sessionId);
		};
		hold.timer = setTimeout(() => end(true), capMs);
		hold.timer.unref();
		finalization.then(
			() => end(false),
			() => end(false),
		);
	}

	/**
	 * Cold-sidecar manager swap: every claim and hold moves to `target`, and this set is emptied
	 * without unlocking anything. The target then settles: a claim for its current id and any held
	 * claim survive, everything else is released (a fork's predecessor, once the swap commits).
	 * Open transitions are not carried across: a caller that swaps inside a transition must call
	 * this after that transition ends, or open one on the target.
	 */
	moveTo(target: SessionClaimSet): void {
		if (target === this) return;
		for (const claim of this.#claims.values()) target.add(claim);
		this.#claims.clear();
		for (const [sessionId, hold] of this.#holds) {
			if (target.#holds.has(sessionId)) {
				if (hold.timer) clearTimeout(hold.timer);
				continue;
			}
			hold.set = target;
			target.#holds.set(sessionId, hold);
		}
		this.#holds.clear();
		target.settle();
	}

	/**
	 * `close()`: release every claim. A claim under a deferred hold is released when its hold ends,
	 * at most the cap later; nothing can be added afterwards.
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
export function sessionClaimSetOf(manager: object): SessionClaimSet {
	return (manager as ClaimSetOwner)[sessionClaimSetCapability]();
}
