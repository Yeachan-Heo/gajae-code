import * as fs from "node:fs/promises";
import { isEnoent } from "@gajae-code/utils/fs-error";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

interface LockInfo {
	pid: number;
	timestamp: number;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function writeLockInfo(lockPath: string): Promise<void> {
	const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
	await Bun.write(`${lockPath}/info`, JSON.stringify(info));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const content = await fs.readFile(`${lockPath}/info`, "utf-8");
		return JSON.parse(content) as LockInfo;
	} catch {
		return null;
	}
}

/** @internal */
export async function readFileLockInfoForGc(lockDir: string): Promise<{ pid: number; timestamp: number } | null> {
	const info = await readLockInfo(lockDir);
	if (!info) return null;
	if (!Number.isFinite(info.pid) || info.pid <= 0) return null;
	if (!Number.isFinite(info.timestamp)) return null;
	return info;
}

/** Owner identity stamped into a `<file>.lock/info` record. */
export interface FileLockOwnerToken {
	pid: number;
	timestamp: number;
}

/** Outcome of a guarded GC removal attempt (`removeFileLockDirForGc`). */
export type FileLockGcRemoval = "removed" | "owner_changed" | "missing";

/**
 * @internal
 * Fail-closed removal of a dead lock dir for GC. Re-reads the on-disk owner
 * token as close to the unlink as possible and only deletes the dir when it
 * STILL holds the exact `{pid, timestamp}` identity the caller observed dead.
 *
 * Closes the prune-time TOCTOU window (#606): between GC's dead re-read/probe
 * and the unlink, a live process can reclaim a stale lock at the same path
 * (`acquireLock` rms the stale dir, then re-`mkdir`s and rewrites `info` with a
 * fresh pid+timestamp). Deleting by path alone would reap that LIVE lock. Any
 * mismatch (`owner_changed`) or absent/unreadable info (`missing` — e.g. a
 * fresh acquirer between `mkdir` and `writeLockInfo`) refuses the delete and
 * leaves the dir intact. POSIX has no atomic compare-and-delete for a
 * directory, so the residual read->unlink window cannot be fully eliminated,
 * but the reclaim-after-stale scenario the issue describes is now guarded.
 */
export async function removeFileLockDirForGc(
	lockDir: string,
	expected: FileLockOwnerToken,
): Promise<FileLockGcRemoval> {
	const current = await readLockInfo(lockDir);
	if (!current) return "missing";
	if (current.pid !== expected.pid || current.timestamp !== expected.timestamp) {
		return "owner_changed";
	}
	await fs.rm(lockDir, { recursive: true, force: true });
	return "removed";
}

type OwnerLiveness = "alive" | "dead" | "unknown";

function ownerLiveness(pid: number): OwnerLiveness {
	if (!Number.isFinite(pid) || pid <= 0) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		// EPERM means the process exists but we may not signal it; treat as alive.
		// Anything else is indeterminate.
		return code === "EPERM" ? "alive" : "unknown";
	}
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
	const info = await readLockInfo(lockPath);
	if (!info) {
		try {
			const stats = await fs.stat(lockPath);
			return Date.now() - stats.mtimeMs > staleMs;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	// Never reap a live owner by elapsed time: a long legitimate critical section must
	// not have its lock stolen (#652). Reclaim a dead owner immediately. Only when owner
	// liveness is indeterminate do we fall back to the staleMs elapsed-time heuristic.
	const liveness = ownerLiveness(info.pid);
	if (liveness === "dead") return true;
	if (liveness === "alive") return false;
	return Date.now() - info.timestamp > staleMs;
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
	try {
		await fs.mkdir(lockPath);
		await writeLockInfo(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

async function releaseLock(lockPath: string): Promise<void> {
	try {
		await fs.rm(lockPath, { recursive: true });
	} catch {
		// Ignore errors on release
	}
}

async function lockExists(lockPath: string): Promise<boolean> {
	try {
		await fs.stat(lockPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		if (await tryAcquireLock(lockPath)) {
			return () => releaseLock(lockPath);
		}

		if ((await lockExists(lockPath)) && (await isLockStale(lockPath, opts.staleMs))) {
			await releaseLock(lockPath);
			continue;
		}

		await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		await release();
	}
}
