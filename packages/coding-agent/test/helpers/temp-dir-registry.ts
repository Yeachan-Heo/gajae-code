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
 * Age past which a leftover temp root is treated as abandoned rather than
 * owned by a live run. Several shards of the same suite run concurrently on
 * one host, so this must stay far longer than a whole suite (~75s) — a
 * shorter window would let one shard delete another's working directory.
 * Prefix alone is never sufficient grounds for removal.
 */
export const STALE_TEMP_DIR_REAP_AGE_MS = 2 * 60 * 60 * 1000;

function removeQuietly(dir: string): void {
	try {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Cleanup must never fail the suite it is cleaning up after.
	}
}

export interface TempDirRegistry {
	/** Marks `dir` as owned by the running case. Call right after `mkdirSync`. */
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
	/** Minimum age before an entry is removed. Defaults to {@link STALE_TEMP_DIR_REAP_AGE_MS}. */
	maxAgeMs?: number;
	/** Reference time, injectable so the age boundary is testable. */
	now?: number;
}

/**
 * Removes directories under `root` whose name starts with `prefix` and whose
 * mtime is older than `maxAgeMs`. Best-effort: every failure is swallowed so a
 * start-of-suite reap can never fail the suite.
 */
export function reapStaleTempDirs(prefix: string, options: ReapStaleTempDirsOptions = {}): void {
	// An empty prefix would match every entry in the temp root. Refuse rather
	// than scan: the caller passing "" is a bug, not a request to reap all.
	if (!prefix) return;
	const root = options.root ?? os.tmpdir();
	const maxAgeMs = options.maxAgeMs ?? STALE_TEMP_DIR_REAP_AGE_MS;
	const now = options.now ?? Date.now();
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
			if (now - stats.mtimeMs < maxAgeMs) continue;
			fs.rmSync(full, { recursive: true, force: true });
		} catch {
			// A concurrent shard may remove the entry between stat and rm.
		}
	}
}
