import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Suite-scoped temp-dir ownership so a skipped or undone teardown cannot leak.
 *
 * A per-case `afterEach` that removes its temp dir in a `finally` covers the
 * throwing case but not the two that actually leak:
 *
 *  1. The hook exceeds its own budget. Bun abandons it mid-await, so the
 *     `finally` never runs and the dir is never removed.
 *  2. The `finally` does run, but a lazy writer that outlived teardown (model
 *     registry db, preset store, session file) recreates the directory just
 *     after it was removed.
 *
 * `afterAll` still runs in both cases, so the sweep is the backstop. It
 * revisits every dir the suite ever created — not just the unreleased ones —
 * because case 2 leaks a dir that was already released.
 *
 * The `finally` stays the primary reclaim path: a normal run releases eagerly
 * and keeps at most one dir alive at a time. The sweep only collects the
 * remainder.
 */

/**
 * Minimum age before a root whose owner is *already proven dead* may be
 * reaped. Age is a secondary brake, never the proof: a root that is merely
 * old is not abandoned, because a paused debugger, a slow shard, or a
 * concurrent CI run can sit idle far longer than this while still holding it.
 * Ownership is established by {@link TEMP_DIR_OWNER_MARKER} instead.
 */
export const STALE_TEMP_DIR_REAP_AGE_MS = 2 * 60 * 60 * 1000;

/** Per-run ownership marker written into each root. Shared by the reaper and its tests. */
export const TEMP_DIR_OWNER_MARKER = ".gjc-temp-dir-owner.json";

interface TempDirOwner {
	pid: number;
	host: string;
	startedAt: number;
}

/** Liveness of a marker's owner. Only `"dead"` is a proof; the rest are refusals. */
export type TempDirPidStatus = "alive" | "dead" | "unknown";

/**
 * Real owner probe, classified exactly as `probeOwnerProcess` in
 * `src/gjc-runtime/session-state-lock.ts` and `gcPidProbe` in
 * `src/gjc-runtime/gc-runtime.ts` do: only `ESRCH` proves the process is gone.
 * `EPERM` means a process exists that we may not signal, and any other error
 * is an answer the OS refused to give — neither is evidence of death.
 */
export function probeTempDirOwner(pid: number): TempDirPidStatus {
	if (!Number.isInteger(pid) || pid <= 0) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		return code === "EPERM" ? "alive" : "unknown";
	}
}

/** Writes the ownership marker. Best-effort: a failed write is simply no claim. */
function writeOwnerMarker(dir: string): void {
	try {
		const owner: TempDirOwner = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
		fs.writeFileSync(path.join(dir, TEMP_DIR_OWNER_MARKER), JSON.stringify(owner));
	} catch {
		// A root without a readable marker is never reaped, so failing to write
		// one is safe in exactly the fail-closed direction: it forfeits the
		// claim rather than fabricating one.
	}
}

/** Reads a well-formed marker, or `undefined` when ownership cannot be proven. */
function readOwnerMarker(dir: string): TempDirOwner | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(dir, TEMP_DIR_OWNER_MARKER), "utf8"));
	} catch {
		// Missing, unreadable, or unparseable: not provably ours.
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const owner = parsed as Partial<TempDirOwner>;
	if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return undefined;
	if (typeof owner.host !== "string" || owner.host.length === 0) return undefined;
	const startedAt =
		typeof owner.startedAt === "number" && Number.isFinite(owner.startedAt) ? owner.startedAt : Number.NaN;
	return { pid: owner.pid, host: owner.host, startedAt };
}

function removeQuietly(dir: string): void {
	try {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Cleanup must never fail the suite it is cleaning up after.
	}
}

export interface TempDirRegistry {
	/**
	 * Marks `dir` as owned by the running case and stamps its ownership marker.
	 * Call right after `mkdirSync`.
	 */
	register(dir: string): void;
	/** Removes `dir` and ends the case's claim on it. The clean path's only removal site. */
	release(dir: string): void;
	/** Removes every dir the suite created that still exists. Idempotent. */
	sweep(): void;
	/** Dirs registered and not yet released, for assertions. */
	owned(): string[];
	/** Every dir ever registered, released or not, for assertions. */
	tracked(): string[];
}

/**
 * Creates an independent registry. Deliberately not a module singleton: Bun
 * can run several test files in one process, and a shared set would let one
 * file's sweep delete another file's in-flight directory.
 */
export function createTempDirRegistry(): TempDirRegistry {
	const owned = new Set<string>();
	// Retained past release so the sweep can also catch a dir that a lazy
	// writer recreated after teardown removed it.
	const tracked = new Set<string>();
	return {
		register(dir) {
			owned.add(dir);
			tracked.add(dir);
			// The marker is what lets a LATER run prove this root was abandoned.
			// `release`/`sweep` remove the tree recursively, so it needs no
			// separate cleanup path.
			writeOwnerMarker(dir);
		},
		release(dir) {
			owned.delete(dir);
			removeQuietly(dir);
		},
		sweep() {
			for (const dir of tracked) removeQuietly(dir);
			owned.clear();
			// `tracked` is deliberately retained: a writer can recreate a root
			// after the sweep, and a second sweep must still know about it.
		},
		owned: () => [...owned],
		tracked: () => [...tracked],
	};
}

/**
 * Window allowed for a writer that outlived teardown to finish recreating a
 * root, so the follow-up sweep observes it. Measured against this suite: a
 * single sweep left one empty root per run, created after `afterAll` began.
 */
export const TEMP_DIR_SWEEP_SETTLE_MS = 250;

/** Sweeps, waits out late writers, then sweeps again. Use from `afterAll`. */
export async function sweepAfterSettle(
	registry: TempDirRegistry,
	settleMs: number = TEMP_DIR_SWEEP_SETTLE_MS,
): Promise<void> {
	registry.sweep();
	await Bun.sleep(settleMs);
	registry.sweep();
}

export interface ReapStaleTempDirsOptions {
	/** Directory to scan. Defaults to `os.tmpdir()`. */
	root?: string;
	/** Minimum age before a dead-owner entry is removed. Defaults to {@link STALE_TEMP_DIR_REAP_AGE_MS}. */
	maxAgeMs?: number;
	/** Reference time, injectable so the age boundary is testable. */
	now?: number;
	/** Owner liveness probe, injectable so abandonment is testable. Defaults to {@link probeTempDirOwner}. */
	pidProbe?: (pid: number) => TempDirPidStatus;
}

/**
 * Removes roots under `root` that are PROVABLY abandoned.
 *
 * A name prefix and an old mtime are a naming convention, not ownership: a
 * paused debugger, a slow run, or a concurrent CI shard can leave its root
 * untouched for hours while still using it. Deleting on that basis destroys a
 * live run's session and model state. So every one of these must hold, and a
 * root is KEPT the moment any of them cannot be established:
 *
 *  1. the name matches `prefix` and the entry is a directory;
 *  2. {@link TEMP_DIR_OWNER_MARKER} exists, parses, and carries an integer
 *     `pid > 0` and a non-empty `host`;
 *  3. `host` is this host — a foreign pid is not ours to probe, because pid
 *     numbers are only meaningful locally;
 *  4. the pid is not this process — never reap the live run's own root;
 *  5. the owner probes as `"dead"` (`ESRCH`). `"alive"` and `"unknown"`
 *     (`EPERM`, or any answer the OS refused to give) both KEEP, so the check
 *     fails closed: only a positive proof of death authorizes removal;
 *  6. the age gate still passes, measured from the marker's `startedAt` when
 *     finite and from the root's mtime otherwise.
 *
 * Conditions 2–5 are purely additional, so the set of directories removed here
 * is a strict SUBSET of what a prefix+mtime reaper would remove — that
 * narrowing is the point of this function. One consequence is intended: roots
 * written by runs that predate the marker carry no proof of ownership and are
 * therefore never reaped. Keeping current runs from leaking is the job of the
 * suite's own `afterAll` sweep, not of this reaper.
 *
 * Best-effort throughout: every failure is swallowed so a start-of-suite reap
 * can never fail the suite.
 */
export function reapStaleTempDirs(prefix: string, options: ReapStaleTempDirsOptions = {}): void {
	// An empty prefix would match every entry in the temp root. Refuse rather
	// than scan: the caller passing "" is a bug, not a request to reap all.
	if (!prefix) return;
	const root = options.root ?? os.tmpdir();
	const maxAgeMs = options.maxAgeMs ?? STALE_TEMP_DIR_REAP_AGE_MS;
	const now = options.now ?? Date.now();
	const pidProbe = options.pidProbe ?? probeTempDirOwner;
	const host = os.hostname();
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const full = path.join(root, entry);
		try {
			const stats = fs.statSync(full);
			if (!stats.isDirectory()) continue;
			const owner = readOwnerMarker(full);
			// No provable owner: this root may belong to anyone, including a run
			// older than the marker. Not ours to delete.
			if (!owner) continue;
			if (owner.host !== host) continue;
			if (owner.pid === process.pid) continue;
			if (pidProbe(owner.pid) !== "dead") continue;
			const agedFrom = Number.isFinite(owner.startedAt) ? owner.startedAt : stats.mtimeMs;
			if (now - agedFrom < maxAgeMs) continue;
			fs.rmSync(full, { recursive: true, force: true });
		} catch {
			// A concurrent shard may remove the entry between stat and rm.
		}
	}
}
