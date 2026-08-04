import * as crypto from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent } from "@gajae-code/utils/fs-error";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
	/** Stable host identity required to safely reclaim locks on a shared volume. */
	ownerHostId?: string;
}

const DEFAULT_OPTIONS: Required<Omit<FileLockOptions, "ownerHostId">> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

type LockInfo = FileLockOwnerToken;

export const FileLockTestHooks: {
	afterParentMkdir?: (lockPath: string) => void | Promise<void>;
} = {};

/**
 * Returns the OS-provided process start timestamp for PID-reuse detection.
 * `ps` is available on the supported Unix hosts (macOS and Linux), unlike
 * Linux's `/proc/<pid>/stat` pseudo-file.
 */
export function processStartTime(pid: number): string | null {
	try {
		const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return null;
		const startTime = new TextDecoder().decode(result.stdout).trim();
		return startTime || null;
	} catch {
		return null;
	}
}

let ownProcessStartTime: string | undefined;

function currentProcessStartTime(): string {
	if (ownProcessStartTime === undefined) ownProcessStartTime = processStartTime(process.pid) ?? "unknown";
	return ownProcessStartTime;
}

function cachedProcessStartTime(owner: FileLockOwnerToken, cache?: Map<string, string | null>): string | null {
	if (!cache) return processStartTime(owner.pid);
	const key = `${owner.pid}:${owner.start_time ?? ""}`;
	const cached = cache.get(key);
	if (cached !== undefined || cache.has(key)) return cached ?? null;
	const startTime = processStartTime(owner.pid);
	cache.set(key, startTime);
	return startTime;
}

function ownerIsAlive(owner: FileLockOwnerToken, startTimeCache?: Map<string, string | null>): boolean {
	if (ownerLiveness(owner.pid) !== "alive") return false;
	if (!owner.start_time) return true;
	const currentStartTime = cachedProcessStartTime(owner, startTimeCache);
	return currentStartTime === null || currentStartTime === owner.start_time;
}

function lockInfo(ownerHostId?: string): LockInfo {
	return {
		pid: process.pid,
		start_time: currentProcessStartTime(),
		timestamp: Date.now(),
		...(ownerHostId === undefined ? {} : { owner_host_id: ownerHostId }),
	};
}

function writeLockInfo(lockPath: string, info: LockInfo): Promise<LockInfo> {
	return Bun.write(`${lockPath}/info`, JSON.stringify(info)).then(() => info);
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(`${lockPath}/info`, "utf-8"));
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) return null;
		throw error;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { pid, start_time, timestamp, owner_host_id } = parsed as Partial<LockInfo>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time)) ||
		(owner_host_id !== undefined && (typeof owner_host_id !== "string" || !owner_host_id))
	)
		return null;
	return { pid, start_time, timestamp, owner_host_id };
}

/** @internal */
export async function readFileLockInfoForGc(lockDir: string): Promise<FileLockOwnerToken | null> {
	return await readLockInfo(lockDir);
}

/** Owner identity stamped into a `<file>.lock/info` record. */
export interface FileLockOwnerToken {
	pid: number;
	start_time?: string;
	owner_host_id?: string;
	timestamp: number;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

/** Outcome of a guarded lock-dir removal attempt (`removeFileLockDirForGc`). */
export type FileLockGcRemoval = "removed" | "owner_changed" | "missing";

interface LockDirStatToken {
	dev: number;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
}

type LockStaleSnapshot =
	| { stale: false }
	| { stale: true; owner: FileLockOwnerToken }
	| { stale: true; owner: null; stat: LockDirStatToken };

/**
 * @internal
 * Fail-closed removal of a lock dir whose owner is expected to be dead or
 * finished. Re-reads the on-disk owner token as close to the unlink as possible
 * and only deletes the dir when it STILL holds the exact `{pid, timestamp}`
 * identity the caller observed.
 *
 * Closes stale-cleanup TOCTOU windows (#606): between a dead/stale re-read and
 * the unlink, a live process can reclaim a stale lock at the same path
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
	if (
		current.pid !== expected.pid ||
		(expected.start_time !== undefined && current.start_time !== expected.start_time) ||
		current.owner_host_id !== expected.owner_host_id ||
		current.timestamp !== expected.timestamp
	) {
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

function statToken(stats: Stats): LockDirStatToken {
	return {
		dev: stats.dev,
		ino: stats.ino,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
	};
}

function sameStatToken(a: LockDirStatToken, b: LockDirStatToken): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function staleLockSnapshot(
	lockPath: string,
	staleMs: number,
	ownerHostId?: string,
	startTimeCache?: Map<string, string | null>,
): Promise<LockStaleSnapshot> {
	let info: LockInfo | null;
	try {
		info = await readLockInfo(lockPath);
	} catch (error) {
		// Windows can transiently deny reads of a just-created lock metadata file
		// while another contender is publishing it. Treat that as active
		// contention and retry rather than failing the caller or reaping by path.
		if (hasFsCode(error, "EPERM")) return { stale: false };
		throw error;
	}
	if (!info && ownerHostId !== undefined) return { stale: false };
	if (!info) {
		try {
			const stats = await fs.stat(lockPath);
			if (Date.now() - stats.mtimeMs <= staleMs) return { stale: false };
			return { stale: true, owner: null, stat: statToken(stats) };
		} catch (err) {
			if (isEnoent(err)) return { stale: false };
			throw err;
		}
	}

	// A host-qualified lock may only be reclaimed after proving that its owner is
	// local. Foreign and malformed host-qualified records fail closed: PID values
	// and clocks are not meaningful across hosts.
	if (ownerHostId !== undefined && info.owner_host_id !== ownerHostId) return { stale: false };
	// Never reap a live owner by elapsed time: a long legitimate critical section must
	// not have its lock stolen (#652). Reclaim a dead owner immediately. Only when owner
	// liveness is indeterminate do we fall back to the staleMs elapsed-time heuristic.
	if (ownerIsAlive(info, startTimeCache)) return { stale: false };
	if (ownerLiveness(info.pid) === "dead" || Date.now() - info.timestamp > staleMs) {
		return { stale: true, owner: info };
	}
	return { stale: false };
}

async function removeStaleLockForAcquire(lockPath: string, snapshot: LockStaleSnapshot): Promise<boolean> {
	if (!snapshot.stale) return false;
	if (snapshot.owner) {
		return (await removeFileLockDirForGc(lockPath, snapshot.owner)) === "removed";
	}

	const currentInfo = await readLockInfo(lockPath);
	if (currentInfo) return false;
	try {
		const currentStats = await fs.stat(lockPath);
		if (!sameStatToken(statToken(currentStats), snapshot.stat)) return false;
		await fs.rm(lockPath, { recursive: true, force: true });
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function tryAcquireLock(lockPath: string, ownerHostId?: string): Promise<LockInfo | null> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const afterParentMkdir = FileLockTestHooks.afterParentMkdir;
	if (afterParentMkdir) await afterParentMkdir(lockPath);
	if (ownerHostId === undefined) {
		try {
			await fs.mkdir(lockPath);
			return await writeLockInfo(lockPath, lockInfo());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
			throw error;
		}
	}

	const pendingPath = `${lockPath}.pending.${process.pid}.${crypto.randomUUID()}`;
	const owner = lockInfo(ownerHostId);
	try {
		await fs.mkdir(pendingPath);
		await writeLockInfo(pendingPath, owner);
		try {
			await fs.rename(pendingPath, lockPath);
			return owner;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "ENOTEMPTY") return null;
			if (code === "EPERM") {
				try {
					await fs.stat(lockPath);
					return null;
				} catch (statError) {
					if (!isEnoent(statError)) throw statError;
				}
			}
			throw error;
		}
	} finally {
		await fs.rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function releaseLock(lockPath: string, owner: FileLockOwnerToken): Promise<void> {
	const outcome = await removeFileLockDirForGc(lockPath, owner);
	if (outcome !== "removed") throw new Error(`Failed to release file lock: ${outcome}.`);
}
async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	if (options.ownerHostId !== undefined && !options.ownerHostId) throw new Error("ownerHostId must be non-empty");
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);
	const contentionStartTimes = new Map<string, string | null>();
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const owner = await tryAcquireLock(lockPath, opts.ownerHostId);
		if (owner) return () => releaseLock(lockPath, owner);

		const stale = await staleLockSnapshot(lockPath, opts.staleMs, opts.ownerHostId, contentionStartTimes);
		if (await removeStaleLockForAcquire(lockPath, stale)) continue;
		await Bun.sleep(opts.retryDelayMs);
	}
	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/**
 * Serializes all contenders, including callers in the same process. Because this
 * API exposes no ownership token, recursive acquisition is indistinguishable
 * from independent async contention; code that already holds the lock must pass
 * that fact through its own `lockHeld` path instead of acquiring it again.
 */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	let result: T;
	try {
		result = await fn();
	} catch (operationError) {
		try {
			await release();
		} catch (releaseError) {
			throw new AggregateError([operationError, releaseError], "File lock operation and release both failed.");
		}
		throw operationError;
	}
	await release();
	return result;
}
