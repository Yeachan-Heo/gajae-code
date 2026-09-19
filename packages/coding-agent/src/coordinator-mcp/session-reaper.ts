import { logger } from "@gajae-code/utils";

/**
 * Idle reaper for coordinator-managed GJC worker sessions.
 *
 * New coordinator-owned sessions created by `gjc_coordinator_start_session` or by a
 * `gjc_delegate_*` call that omits `session_id` are ephemeral. Nothing in the
 * coordinator ever tore those down, so completed/crashed sessions accumulated
 * (RAM + worktrees) until something killed them by hand.
 *
 * This is the automatic backstop (defense-in-depth): a periodic sweep force-closes
 * sessions that are (a) ephemeral — coordinator-created, never a user's
 * registered resident session, (b) not mid-turn, and (c) idle past a TTL.
 *
 * The controller is pure + fully injectable (clock / list / reap side-effects) so
 * it is unit-testable without tmux, the filesystem, or wall-clock waits. The
 * scheduling mirrors the proven resource-gc controller: a recursive setTimeout
 * with a generation guard so a stop()+start() can never leak a duplicate timer.
 */

export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000; // 30 min idle → reap
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 5 * 60_000; // sweep every 5 min
export const MIN_SESSION_IDLE_TTL_MS = 60_000; // never reap a <1min-idle session
export const MIN_SESSION_SWEEP_INTERVAL_MS = 30_000;
/** After this many consecutive reap failures the session is force-evicted from the index. */
export const MAX_REAP_FAILURES = 3;

/** Minimal projection of a coordinator session the reaper needs to decide. */
export interface ReapableSession {
	sessionId: string;
	/** True for newly coordinator-created sessions. User-registered resident sessions are false and never reaped. */
	ephemeral: boolean;
	/** Epoch ms of last observed activity (turn update / session-state write / session creation). */
	lastActivityMs: number;
	/** True while a turn is active — never reap mid-turn. */
	hasActiveTurn: boolean;
}

export interface SessionReaperPolicy {
	idleTtlMs: number;
	sweepIntervalMs: number;
}

/**
 * Pure selection: which sessions are safe to reap at `now`.
 * A session is reapable iff ephemeral AND not mid-turn AND idle ≥ (clamped) TTL.
 */
export function selectReapableSessions(
	sessions: readonly ReapableSession[],
	now: number,
	idleTtlMs: number,
): ReapableSession[] {
	const ttl = Math.max(MIN_SESSION_IDLE_TTL_MS, idleTtlMs);
	return sessions.filter(s => s.ephemeral && !s.hasActiveTurn && now - s.lastActivityMs >= ttl);
}

/**
 * Only a stale/absent endpoint makes a session permanently unreapable, so it is
 * the sole failure that advances the force-eviction counter. Every other reap
 * failure (close_failed, broker unavailability, filesystem errors) is transient
 * and must keep retrying without ever escalating to force eviction. The server
 * wires `reapSession` to throw `new Error(reason)`, so the reason code is the
 * error message here.
 */
function isEndpointStaleReapError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)) === "endpoint_stale";
}

/** Injectable side-effects so the controller runs in tests without tmux/fs/real time. */
export interface SessionReaperDeps {
	listSessions: () => Promise<ReapableSession[]>;
	reapSession: (sessionId: string) => Promise<void>;
	/**
	 * Force-evict a session from the coordinator index when it has exceeded the
	 * consecutive-failure limit and cannot be reaped normally (e.g. endpoint_stale).
	 * Called exactly once per session-id at the eviction boundary; the session must
	 * not appear in future listSessions() results after this resolves.
	 */
	markSessionDead: (sessionId: string) => Promise<void>;
	now: () => number;
}

export interface SessionReaper {
	/** Run one sweep; returns the number of sessions successfully reaped. */
	sweepOnce: () => Promise<number>;
	start: () => void;
	stop: () => void;
	readonly running: boolean;
}

export function createSessionReaper(deps: SessionReaperDeps, policy: SessionReaperPolicy): SessionReaper {
	const idleTtlMs = Math.max(MIN_SESSION_IDLE_TTL_MS, policy.idleTtlMs);
	const sweepIntervalMs = Math.max(MIN_SESSION_SWEEP_INTERVAL_MS, policy.sweepIntervalMs);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let generation = 0;
	let inProgress = false;
	/** Consecutive reap-failure count per session-id. Cleared on success or eviction. */
	const failureCounts = new Map<string, number>();

	async function sweepOnce(): Promise<number> {
		if (inProgress) return 0; // never overlap sweeps
		inProgress = true;
		try {
			const sessions = await deps.listSessions();
			const targets = selectReapableSessions(sessions, deps.now(), idleTtlMs);
			let reaped = 0;
			for (const session of targets) {
				try {
					await deps.reapSession(session.sessionId);
					// Success — clear any accumulated failure count.
					failureCounts.delete(session.sessionId);
					reaped += 1;
				} catch (err) {
					// One wedged session must not abort the rest of the sweep.
					const msg = err instanceof Error ? err.message : String(err);
					if (!isEndpointStaleReapError(err)) {
						// Transient failure (close_failed, broker/filesystem error): a non-stale
						// outcome breaks the consecutive-stale streak, so clear the counter and
						// retry on the next sweep. Only genuinely consecutive endpoint_stale
						// failures may accumulate toward force eviction.
						logger.warn(`session-reaper: failed to reap ${session.sessionId}: ${msg}`);
						failureCounts.delete(session.sessionId);
						continue;
					}
					const prev = failureCounts.get(session.sessionId) ?? 0;
					const count = prev + 1;
					if (count < MAX_REAP_FAILURES) {
						// First failure(s): log at warn and keep retrying next sweep.
						logger.warn(`session-reaper: failed to reap ${session.sessionId}: ${msg}`);
						failureCounts.set(session.sessionId, count);
					} else {
						// Hit the limit — evict unconditionally and silence future attempts.
						logger.warn(
							`session-reaper: session ${session.sessionId} evicted after ${count} consecutive failures (${msg})`,
						);
						failureCounts.delete(session.sessionId);
						try {
							await deps.markSessionDead(session.sessionId);
						} catch (evictErr) {
							// Eviction failure is non-fatal; the session will be retried next
							// sweep and the counter has been cleared, so it will get MAX_REAP_FAILURES
							// fresh chances before the next eviction attempt.
							logger.warn(
								`session-reaper: markSessionDead failed for ${session.sessionId}: ${evictErr instanceof Error ? evictErr.message : String(evictErr)}`,
							);
						}
					}
				}
			}
			return reaped;
		} finally {
			inProgress = false;
		}
	}

	function schedule(gen: number): void {
		timer = setTimeout(() => {
			if (gen !== generation) return; // stale timer from a prior start()
			void sweepOnce()
				.catch(error => {
					// A refused sweep (e.g. a fail-closed capped projection scan) must not
					// become an unhandled rejection; log and keep the schedule alive.
					logger.warn(`session-reaper: sweep refused: ${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					if (gen === generation) schedule(gen);
				});
		}, sweepIntervalMs);
		// The reaper must never keep the coordinator process alive by itself.
		(timer as { unref?: () => void }).unref?.();
	}

	return {
		sweepOnce,
		start(): void {
			if (timer) return; // already running
			generation += 1;
			schedule(generation);
		},
		stop(): void {
			generation += 1; // invalidate any in-flight scheduled tick
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
		get running(): boolean {
			return timer !== null;
		},
	};
}
