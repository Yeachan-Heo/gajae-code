/**
 * Shared, hold-only cross-process startup/maintenance exclusion for the D8/D9
 * doctor daemon-service flows.
 *
 * This guard NEVER publishes ownership or service state and NEVER starts,
 * signals, or claims a daemon owner. It is purely a mutual-exclusion fence,
 * built on the same authoritative file-lock machinery every other durable
 * daemon lock in this codebase uses ({@link withFileLock}): bounded retry with
 * backoff, honoring an optional `AbortSignal`, and exact-lease release on the
 * way out (never a blind recursive `rm`, and never a PID kill).
 *
 * Why a separate guard file: `withFileLock` serializes on `<path>.lock`, a
 * name distinct from every existing canonical artifact for a service
 * (`telegram-daemon.lock`/`.state.json`/`.steal`, or `owner.lock`/`state.json`
 * for Discord/Slack). Acquiring this guard therefore can never collide with,
 * be satisfied by, or be mistaken for an ordinary ownership/publication lock,
 * and ordinary publication code paths are free to acquire their own locks
 * independently — this primitive only fences bulk-maintenance and startup
 * repair work (e.g. detaching a stale Telegram `.steal` transition marker)
 * against a concurrent ordinary `ensure`, and vice versa.
 *
 * If a caller already holds this guard, it must route any further
 * `withDaemonStartupExclusion` acquisition for the SAME `(agentDir, owner)`
 * pair through nested async work that never itself re-enters this function —
 * `withFileLock`'s underlying acquisition has no reentrant/owner-token
 * concept visible to callers, so a second acquisition attempt from the same
 * async context is indistinguishable from unrelated contention and will
 * deadlock against itself. Nothing in this module grants, threads, or
 * consults any bypass flag or ambient/AsyncLocalStorage authority to avoid
 * that; the caller is responsible for not awaiting a child operation that
 * itself needs this same guard while still holding it.
 */
import * as path from "node:path";
import { acquireFileLock, type FileLockOptions, withFileLock } from "../../config/file-lock";
import { CHAT_DAEMON_DIRECTORY } from "../service-artifact-paths";
import { daemonPaths } from "./daemon-paths";

export type DaemonStartupExclusionOwner = "telegram" | "discord" | "slack";

export interface DaemonStartupExclusionOptions {
	/** Abort acquisition early; never releases a lease this call did not itself acquire. */
	signal?: AbortSignal;
	/** Upper bound on total wait while contended. Defaults to {@link DAEMON_STARTUP_EXCLUSION_DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Matches the production wall-time bound already established for other durable daemon locks. */
export const DAEMON_STARTUP_EXCLUSION_DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 100;

/**
 * The canonical per-service guard path. Lives inside the SAME per-service
 * directory as the service's ordinary owner/state artifacts (so it inherits
 * that directory's existing parent-permission posture) but under a filename
 * reserved exclusively for this guard — never a name any ownership,
 * publication, or transition-marker code path reads or writes.
 *
 * This function only computes a path; it performs no filesystem I/O and
 * creates nothing. (`withFileLock` itself creates the missing parent
 * directory chain, mode 0o700, purely as lock-acquisition scaffolding — an
 * empty directory carries no service state.)
 */
export function daemonStartupExclusionPath(agentDir: string, owner: DaemonStartupExclusionOwner): string {
	const root = path.resolve(agentDir);
	const dir = owner === "telegram" ? daemonPaths(root).dir : path.join(root, CHAT_DAEMON_DIRECTORY, owner);
	return path.join(dir, ".startup-exclusion");
}

/**
 * Run `operation` while holding the cross-process startup/maintenance
 * exclusion for `(agentDir, owner)`. Bounded: acquisition retries back off
 * for at most `timeoutMs` (default {@link DAEMON_STARTUP_EXCLUSION_DEFAULT_TIMEOUT_MS})
 * and additionally honors `signal` if supplied — whichever bound is hit first
 * rejects the acquisition. A rejected/timed-out/aborted acquisition never held
 * a lease and therefore never releases one; it cannot touch a foreign owner's
 * lock. On success, the lease this call acquired is released exactly once,
 * through the same identity-bound release primitive `withFileLock` uses for
 * every other durable lock in this codebase — never a recursive directory
 * removal, and never a process signal.
 *
 * This primitive itself never reads, writes, or removes any owner/state/lock
 * file belonging to the service; it only fences concurrent callers of this
 * same function (and, by construction, is never consulted by ordinary
 * ownership-acquisition or publication code, which uses its own distinct
 * lock file).
 */
export async function withDaemonStartupExclusion<T>(
	agentDir: string,
	owner: DaemonStartupExclusionOwner,
	operation: () => Promise<T>,
	options: DaemonStartupExclusionOptions = {},
): Promise<T> {
	return await withFileLock(daemonStartupExclusionPath(agentDir, owner), operation, exclusionOptions(options));
}

function exclusionOptions(options: DaemonStartupExclusionOptions): FileLockOptions {
	const requested = options.timeoutMs ?? DAEMON_STARTUP_EXCLUSION_DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(requested) || requested <= 0 || requested > 120_000)
		throw new RangeError("invalid startup exclusion timeout");
	const timeoutMs = Math.ceil(requested);
	const retries = Math.max(Math.ceil(timeoutMs / RETRY_DELAY_MS), 1);
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const lockOptions: FileLockOptions = {
		signal,
		retries,
		retryDelayMs: RETRY_DELAY_MS,
	};
	return lockOptions;
}

/** Retain the same exclusion across an existing acquire/release lifecycle. */
export async function acquireDaemonStartupExclusion(
	agentDir: string,
	owner: DaemonStartupExclusionOwner,
	options: DaemonStartupExclusionOptions = {},
): Promise<() => Promise<void>> {
	return await acquireFileLock(daemonStartupExclusionPath(agentDir, owner), exclusionOptions(options));
}
