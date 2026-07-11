import { logger } from "@gajae-code/utils";

/**
 * Idle reaper for coordinator-managed GJC worker sessions.
 *
 * Every `gjc_delegate_*` call that omits `session_id` starts a fresh tmux worker
 * session. Nothing in the coordinator ever tore those down, so completed/crashed
 * sessions accumulated (RAM + worktrees) until something killed them by hand.
 *
 * This is the automatic backstop (defense-in-depth): a periodic sweep force-closes
 * sessions that are (a) ephemeral — coordinator delegate-created, never a user's
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

/** Minimal projection of a coordinator session the reaper needs to decide. */
export interface ReapableSession {
	sessionId: string;
	/** True only for coordinator delegate-created sessions. User-registered resident sessions are false and never reaped. */
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

/** Injectable side-effects so the controller runs in tests without tmux/fs/real time. */
export interface SessionReaperDeps {
	listSessions: () => Promise<ReapableSession[]>;
	reapSession: (sessionId: string) => Promise<void>;
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
					reaped += 1;
				} catch (err) {
					// One wedged session must not abort the rest of the sweep.
					logger.warn(
						`session-reaper: failed to reap ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
					);
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
			void sweepOnce().finally(() => {
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
