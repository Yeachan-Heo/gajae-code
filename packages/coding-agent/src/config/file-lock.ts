import * as crypto from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativeDirectoryTreeResult, NativeExactUnlinkResult } from "@gajae-code/natives";
import { hasFsCode, isEnoent } from "@gajae-code/utils/fs-error";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
	signal?: AbortSignal;
	onAcquired?: () => void;
	/** Stable host identity required to safely reclaim locks on a shared volume. */
	ownerHostId?: string;
	/** Previous local host identities accepted only when deciding stale-owner reclamation. */
	previousOwnerHostIds?: readonly string[];
}

const DEFAULT_OPTIONS: Required<
	Omit<FileLockOptions, "ownerHostId" | "previousOwnerHostIds" | "signal" | "onAcquired">
> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

/** Release retries cover transient Windows/Dropbox handle denial without extending the lock indefinitely. */
export const FILE_LOCK_RELEASE_RETRY_ATTEMPTS = 5;
export const FILE_LOCK_RELEASE_RETRY_DELAY_MS = 10;

type LocalLockState = {
	owner: FileLockOwnerToken;
	status: "held" | "release_pending" | "releasing";
	releasePromise?: Promise<void>;
};

/**
 * Process-local ownership is deliberately separate from PID liveness. A PID only says
 * that a process exists; this table says which exact acquisition generation this process
 * created, so a nested contender cannot steal a lock from a still-running holder.
 */
const localLockStates = new Map<string, LocalLockState>();

type LockInfo = FileLockOwnerToken;

export const FileLockTestHooks: {
	afterParentMkdir?: (lockPath: string) => void | Promise<void>;
	nativeQuarantineBindings?: () => NativeFileLockBindings;
} = {};

/**
 * Returns the OS-provided process start timestamp for PID-reuse detection.
 * `ps` is available on the supported Unix hosts (macOS and Linux), unlike
 * Linux's `/proc/<pid>/stat` pseudo-file. Windows has no `ps`; there the
 * kernel-derived process creation time exposed by the natives addon
 * (`Process.incarnation`, the same identity evidence the SDK broker prefers)
 * is used instead. Either way the value is only ever compared for equality
 * against a value this same function produced on the same platform, and `null`
 * stays fail-closed: an owner whose incarnation cannot be proved is never
 * treated as reused.
 */
export function processStartTime(pid: number): string | null {
	if (process.platform === "win32") {
		try {
			return nativeProcessBindings().Process.fromPid(pid)?.incarnation ?? null;
		} catch {
			return null;
		}
	}
	try {
		if (process.platform === "win32") {
			const result = Bun.spawnSync(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
				],
				{ stdout: "pipe", stderr: "ignore" },
			);
			if (result.exitCode !== 0) return null;
			const startTime = new TextDecoder().decode(result.stdout).trim();
			return startTime || null;
		}
		const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
		});
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
	if (!owner.start_time || owner.start_time === "unknown") return true;
	const currentStartTime = cachedProcessStartTime(owner, startTimeCache);
	return currentStartTime === null || currentStartTime === owner.start_time;
}

function lockInfo(ownerHostId: string | undefined, ownerToken: string): LockInfo {
	return {
		pid: process.pid,
		start_time: currentProcessStartTime(),
		timestamp: Date.now(),
		owner_token: ownerToken,
		...(ownerHostId === undefined ? {} : { owner_host_id: ownerHostId }),
	};
}

function writeLockInfo(lockPath: string, info: LockInfo): Promise<LockInfo> {
	return Bun.write(`${lockPath}/info`, JSON.stringify(info)).then(() => info);
}

type LockInfoFileState = {
	dev: bigint;
	ino: bigint;
	mode: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	nlink: bigint;
};

type LockInfoPathState = {
	root: {
		dev: bigint;
		ino: bigint;
		mode: bigint;
	};
	file: LockInfoFileState;
};

function lockInfoFileState(stats: BigIntStats): LockInfoFileState | null {
	if (stats.isSymbolicLink() || !stats.isFile()) return null;
	return {
		dev: stats.dev,
		ino: stats.ino,
		mode: stats.mode,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
		nlink: stats.nlink,
	};
}

function sameLockInfoFileState(left: LockInfoFileState, right: LockInfoFileState): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.nlink === right.nlink
	);
}

async function lockInfoPathState(lockPath: string): Promise<LockInfoPathState | null> {
	let root: BigIntStats;
	try {
		root = await fs.lstat(lockPath, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	if (root.isSymbolicLink() || !root.isDirectory()) return null;

	let info: BigIntStats;
	try {
		info = await fs.lstat(path.join(lockPath, "info"), { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const file = lockInfoFileState(info);
	if (!file) return null;
	return {
		root: { dev: root.dev, ino: root.ino, mode: root.mode },
		file,
	};
}

function sameLockInfoPathState(left: LockInfoPathState, right: LockInfoPathState): boolean {
	return (
		left.root.dev === right.root.dev &&
		left.root.ino === right.root.ino &&
		left.root.mode === right.root.mode &&
		sameLockInfoFileState(left.file, right.file)
	);
}

function normalizeLockKey(lockPath: string): string {
	const normalized = path.normalize(lockPath);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const LOCK_INFO_OPEN_FLAGS =
	fs.constants.O_RDONLY |
	(process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));

/**
 * Read metadata from the exact regular file that was validated, never through a
 * pathname after the descriptor is opened. The no-follow flag prevents final
 * component symlinks on POSIX; lstat/fstat/path revalidation supplies the same
 * rejection on Windows, where O_NOFOLLOW is unavailable.
 */
async function readLockInfoBytes(lockPath: string): Promise<string | null> {
	const infoPath = path.join(lockPath, "info");
	const initial = await lockInfoPathState(lockPath);
	if (!initial) return null;

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(infoPath, LOCK_INFO_OPEN_FLAGS);
		const opened = lockInfoFileState(await handle.stat({ bigint: true }));
		const beforeRead = await lockInfoPathState(lockPath);
		if (
			!opened ||
			!beforeRead ||
			!sameLockInfoFileState(initial.file, opened) ||
			!sameLockInfoPathState(initial, beforeRead)
		)
			return null;

		const bytes = await handle.readFile();
		const afterRead = lockInfoFileState(await handle.stat({ bigint: true }));
		const afterPath = await lockInfoPathState(lockPath);
		if (
			!afterRead ||
			!afterPath ||
			!sameLockInfoFileState(initial.file, afterRead) ||
			!sameLockInfoPathState(initial, afterPath)
		)
			return null;
		return bytes.toString("utf8");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	let parsed: unknown;
	try {
		const bytes = await readLockInfoBytes(lockPath);
		if (bytes === null) return null;
		parsed = JSON.parse(bytes);
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) return null;
		throw error;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { pid, start_time, timestamp, owner_host_id, owner_token } = parsed as Partial<LockInfo>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time)) ||
		(owner_host_id !== undefined && (typeof owner_host_id !== "string" || !owner_host_id)) ||
		(owner_token !== undefined && (typeof owner_token !== "string" || !owner_token))
	)
		return null;
	return { pid, start_time, timestamp, owner_host_id, owner_token };
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
	/** Unique acquisition generation, present on locks created by this runtime. */
	owner_token?: string;
	timestamp: number;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function localLockKey(lockPath: string): Promise<string> {
	try {
		return normalizeLockKey(await fs.realpath(lockPath));
	} catch (error) {
		if (!isEnoent(error) && !isTransientReleaseError(error)) throw error;
	}
	const parent = path.dirname(lockPath);
	let canonicalParent: string;
	try {
		canonicalParent = await fs.realpath(parent);
	} catch (error) {
		if (!isEnoent(error) && !isTransientReleaseError(error)) throw error;
		canonicalParent = path.resolve(parent);
	}
	const key = path.join(canonicalParent, path.basename(lockPath));
	return normalizeLockKey(key);
}

function ownerIncarnationChanged(owner: FileLockOwnerToken, startTimeCache?: Map<string, string | null>): boolean {
	if (!owner.start_time || owner.start_time === "unknown") return false;
	if (ownerLiveness(owner.pid) !== "alive") return false;
	const currentStartTime = cachedProcessStartTime(owner, startTimeCache);
	return currentStartTime !== null && currentStartTime !== owner.start_time;
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
		(expected.owner_token !== undefined && current.owner_token !== expected.owner_token) ||
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
	previousOwnerHostIds: readonly string[] = [],
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
		// A present but malformed owner record is not equivalent to a lock directory
		// caught between mkdir and metadata publication. Refuse stale fallback when the
		// metadata path exists: an unreadable live holder must never be reclaimed by
		// elapsed mtime alone.
		try {
			await fs.lstat(path.join(lockPath, "info"));
			return { stale: false };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
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
	if (
		ownerHostId !== undefined &&
		info.owner_host_id !== ownerHostId &&
		!previousOwnerHostIds.includes(info.owner_host_id ?? "")
	)
		return { stale: false };
	if (ownerHostId === undefined && info.owner_host_id !== undefined) return { stale: false };
	if (ownerIncarnationChanged(info, startTimeCache)) return { stale: true, owner: info };
	// Never reap a live owner by elapsed time: a long legitimate critical section must
	// not have its lock stolen (#652). Reclaim only when the OS proves the owner is dead;
	// indeterminate liveness remains protected regardless of elapsed time.
	if (ownerIsAlive(info, startTimeCache)) return { stale: false };
	const liveness = ownerLiveness(info.pid);
	if (liveness === "dead") {
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

/**
 * @internal
 * READ-ONLY verdict on an EXISTING generic `<file>.lock/` directory that another lock
 * protocol has collided with: is its owner gone, by this protocol's own rules?
 *
 * Exposed so a foreign holder of the same path never has to reimplement this protocol's
 * owner parsing or liveness rules. Reusing them is what makes the two implementations
 * agree: `processStartTime` here is the portable `ps` value that `info.start_time` was
 * written from, so a live owner is proved live rather than compared against a value from a
 * different clock source and then reaped. A live owner is never reported stale by elapsed
 * time alone.
 *
 * Deletion is deliberately NOT offered. This protocol can only re-read an owner token and
 * then unlink a pathname, which a successor can take over in between; a caller that must
 * remove the directory has to do it under an identity-bound primitive that refuses when
 * the object is no longer the one that was judged.
 */
export async function genericFileLockDirIsStale(
	lockDir: string,
	staleMs: number,
	ownerHostId?: string,
): Promise<boolean> {
	return (await staleLockSnapshot(lockDir, staleMs, ownerHostId)).stale;
}

async function tryAcquireLock(
	lockPath: string,
	ownerHostId?: string,
	ownerToken = crypto.randomUUID(),
	onAcquired?: () => void,
): Promise<LockInfo | null> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const afterParentMkdir = FileLockTestHooks.afterParentMkdir;
	if (afterParentMkdir) await afterParentMkdir(lockPath);
	if (ownerHostId === undefined) {
		try {
			await fs.mkdir(lockPath);
			onAcquired?.();
			return await writeLockInfo(lockPath, lockInfo(undefined, ownerToken));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
			throw error;
		}
	}

	const pendingPath = `${lockPath}.pending.${process.pid}.${crypto.randomUUID()}`;
	const owner = lockInfo(ownerHostId, ownerToken);
	try {
		await fs.mkdir(pendingPath);
		await writeLockInfo(pendingPath, owner);
		try {
			await fs.rename(pendingPath, lockPath);
			onAcquired?.();
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

function isTransientReleaseError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

type NativeFileLockBindings = {
	snapshotDirectoryTree(lockPath: string): NativeDirectoryTreeResult;
	exactRemoveDirectoryTree(
		lockPath: string,
		snapshot: NonNullable<NativeDirectoryTreeResult["snapshot"]>,
	): NativeExactUnlinkResult;
};

let nativeFileLockBindingCache: NativeFileLockBindings | undefined;

function nativeFileLockBindings(): NativeFileLockBindings {
	if (FileLockTestHooks.nativeQuarantineBindings) return FileLockTestHooks.nativeQuarantineBindings();
	if (nativeFileLockBindingCache) return nativeFileLockBindingCache;
	try {
		nativeFileLockBindingCache = require("@gajae-code/natives") as NativeFileLockBindings;
		return nativeFileLockBindingCache;
	} catch (error) {
		throw Object.assign(new Error("Native identity-bound lock quarantine is unavailable."), { cause: error });
	}
}

async function quarantineReleasedLock(lockPath: string, owner: FileLockOwnerToken): Promise<boolean> {
	let captured: NativeDirectoryTreeResult;
	try {
		captured = nativeFileLockBindings().snapshotDirectoryTree(lockPath);
	} catch (error) {
		if (isTransientReleaseError(error)) return false;
		throw error;
	}
	if (!captured.ok || !captured.snapshot) return false;
	const infoEntry = captured.snapshot.entries.find(entry => entry.relativePath === "info");
	if (!infoEntry?.sha256) return false;
	// Bind the owner generation to the snapshot before exact removal. A successor
	// installed after this snapshot is rejected by the native identity check instead of
	// being moved into quarantine by a pathname-only rename.
	const expectedDigest = crypto.createHash("sha256").update(JSON.stringify(owner)).digest("hex");
	if (infoEntry.sha256 !== expectedDigest) return false;
	let removed: NativeExactUnlinkResult;
	try {
		removed = nativeFileLockBindings().exactRemoveDirectoryTree(lockPath, captured.snapshot);
	} catch (error) {
		if (isTransientReleaseError(error)) return false;
		throw error;
	}
	if (removed.ok || removed.code === "not_found") return true;
	if (
		removed.detachedPath !== undefined &&
		path.resolve(removed.detachedPath) !== path.resolve(lockPath) &&
		removed.retainedSuccessorPath === undefined &&
		removed.retainedPlaceholderPath === undefined &&
		removed.retainedUnknownPath === undefined
	) {
		try {
			await fs.lstat(lockPath);
			return false;
		} catch (error) {
			if (isEnoent(error)) {
				await fs.rm(removed.detachedPath, { recursive: true, force: true }).catch(cleanupError => {
					if (!isTransientReleaseError(cleanupError)) throw cleanupError;
				});
				return true;
			}
			throw error;
		}
	}
	return false;
}

async function releaseOwnedLock(lockPath: string, owner: FileLockOwnerToken): Promise<void> {
	let lastTransientError: unknown;
	for (let attempt = 0; attempt < FILE_LOCK_RELEASE_RETRY_ATTEMPTS; attempt++) {
		try {
			const outcome = await removeFileLockDirForGc(lockPath, owner);
			if (outcome === "removed" || outcome === "missing") {
				if (outcome === "missing") throw new Error("Failed to release file lock: missing.");
				return;
			}
			throw new Error(`Failed to release file lock: ${outcome}.`);
		} catch (error) {
			if (!isTransientReleaseError(error)) throw error;
			lastTransientError = error;
			if (attempt + 1 < FILE_LOCK_RELEASE_RETRY_ATTEMPTS) await Bun.sleep(FILE_LOCK_RELEASE_RETRY_DELAY_MS);
		}
	}
	if (await quarantineReleasedLock(lockPath, owner)) return;
	throw lastTransientError ?? new Error("Failed to release file lock: transient removal failure.");
}

async function retryPendingLocalRelease(lockPath: string, knownKey?: string): Promise<void> {
	const key = knownKey ?? (await localLockKey(lockPath));
	const state = localLockStates.get(key);
	if (!state || state.status === "held") return;
	if (state.releasePromise) {
		await state.releasePromise.catch(() => undefined);
		return;
	}
	state.status = "releasing";
	const releasePromise = releaseOwnedLock(lockPath, state.owner);
	state.releasePromise = releasePromise;
	try {
		await releasePromise;
		if (localLockStates.get(key) === state) localLockStates.delete(key);
	} catch (error) {
		state.status = "release_pending";
		throw error;
	} finally {
		if (state.releasePromise === releasePromise) state.releasePromise = undefined;
	}
}

async function releaseLock(lockPath: string, owner: FileLockOwnerToken, knownKey?: string): Promise<void> {
	const key = knownKey ?? (await localLockKey(lockPath));
	const state = localLockStates.get(key);
	if (!state || state.owner.owner_token !== owner.owner_token) {
		throw new Error("Failed to release file lock: local owner generation is unknown.");
	}
	if (state.status === "release_pending") {
		await retryPendingLocalRelease(lockPath, key);
		return;
	}
	if (state.releasePromise) {
		await state.releasePromise;
		return;
	}
	state.status = "releasing";
	const releasePromise = releaseOwnedLock(lockPath, owner);
	state.releasePromise = releasePromise;
	try {
		await releasePromise;
		if (localLockStates.get(key) === state) localLockStates.delete(key);
	} catch (error) {
		state.status = "release_pending";
		throw error;
	} finally {
		if (state.releasePromise === releasePromise) state.releasePromise = undefined;
	}
}
/**
 * Bounded, actionable description of who holds `lockPath` at exhaustion time.
 * Never a stealing authority: purely diagnostic, read once after the last retry.
 */
async function lockHolderDescription(lockPath: string): Promise<string> {
	try {
		const info = await readLockInfo(lockPath);
		if (info) {
			// A lock record carrying a foreign owner_host_id belongs to another
			// machine (shared-volume topic registry): its pid is meaningful only
			// on that host, so probing the same numeric pid here could mislabel a
			// coincident local process as the holder. Report the owner host with
			// unknown liveness instead.
			if (info.owner_host_id !== undefined) {
				return (
					`held by pid ${info.pid} on host ${info.owner_host_id} (liveness unknown from this host)` +
					` since ${new Date(info.timestamp).toISOString()}`
				);
			}
			// Same-host holder: use the full liveness proof (pid alive AND, when the
			// record carries a start_time, the start-time identity match) so a dead
			// holder whose pid was already reused is not mislabeled "(live)".
			const alive = ownerIsAlive(info);
			return (
				`held by pid ${info.pid}` +
				(alive
					? " (live)"
					: ownerLiveness(info.pid) === "dead"
						? " (dead but not reaped)"
						: " (liveness unknown)") +
				` since ${new Date(info.timestamp).toISOString()}`
			);
		}
		try {
			await fs.stat(path.join(lockPath, "info"));
			return "held by an owner whose metadata is not yet readable";
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return "held by an unrecognized owner record";
	} catch (error) {
		return `held by an unreadable owner (${(error as Error).message})`;
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	if (options.ownerHostId !== undefined && !options.ownerHostId) throw new Error("ownerHostId must be non-empty");
	if (options.previousOwnerHostIds?.some(hostId => !hostId))
		throw new Error("previousOwnerHostIds must contain only non-empty identities");
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const ownerToken = crypto.randomUUID();
	const contentionStartTimes = new Map<string, string | null>();
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("File lock acquisition aborted");
		const localKey = await localLockKey(lockPath);
		const owner = await tryAcquireLock(lockPath, opts.ownerHostId, ownerToken, opts.onAcquired);
		if (owner) {
			localLockStates.set(localKey, { owner, status: "held" });
			return () => releaseLock(lockPath, owner, localKey);
		}
		const localState = localLockStates.get(localKey);
		if (localState?.status !== "held" && localState?.owner.owner_token !== undefined) {
			try {
				await retryPendingLocalRelease(lockPath, localKey);
				continue;
			} catch {
				// Keep contending below. A failed local retry is not authority to steal a
				// lock; the owner generation remains fenced until release succeeds.
			}
		}
		const stale = await staleLockSnapshot(
			lockPath,
			opts.staleMs,
			opts.ownerHostId,
			opts.previousOwnerHostIds,
			contentionStartTimes,
		);
		if (await removeStaleLockForAcquire(lockPath, stale)) continue;
		if (!opts.signal) {
			await Bun.sleep(opts.retryDelayMs);
			continue;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onAbort = (): void => reject(opts.signal?.reason ?? new Error("File lock acquisition aborted"));
		opts.signal.addEventListener("abort", onAbort, { once: true });
		void Bun.sleep(opts.retryDelayMs).then(resolve);
		try {
			await promise;
		} finally {
			opts.signal.removeEventListener("abort", onAbort);
		}
	}
	throw new Error(
		`Failed to acquire lock for ${filePath} after ${opts.retries} attempts: ${await lockHolderDescription(lockPath)} (${lockPath}); ` +
			`a live owner is never displaced — if this is an SDK broker (gjc sdk status), it must finish or be stopped before retrying`,
	);
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
