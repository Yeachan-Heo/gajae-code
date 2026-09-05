import * as crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
	NativeNoReplaceResult,
	RecoveryFsPublishResult,
} from "@gajae-code/natives";
import {
	openRecoveryFsRoot,
	renameDirectoryNoReplacePathAsync,
	renameNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { isEnoent } from "@gajae-code/utils/fs-error";
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
const PROCESS_START_TIME_FORMAT = "utc-v1";

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
	nativePublicationBindings?: () => {
		renameNoReplacePathAsync: typeof renameNoReplacePathAsync;
		renameDirectoryNoReplacePathAsync: typeof renameDirectoryNoReplacePathAsync;
	};
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
	if (currentStartTime === null || currentStartTime === owner.start_time) return true;
	// A start-time mismatch proves PID reuse only for records that identify the
	// canonical UTC encoding. Legacy records did not identify their timestamp format,
	// so a locale/timezone change can make a live holder look different and must never
	// authorize its removal.
	return owner.start_time_format !== PROCESS_START_TIME_FORMAT;
}

function lockInfo(ownerHostId: string | undefined, ownerToken: string): LockInfo {
	return {
		pid: process.pid,
		start_time: currentProcessStartTime(),
		start_time_format: PROCESS_START_TIME_FORMAT,
		timestamp: Date.now(),
		owner_token: ownerToken,
		...(ownerHostId === undefined ? {} : { owner_host_id: ownerHostId }),
	};
}

function writeLockInfo(lockPath: string, info: LockInfo): Promise<LockInfo> {
	// Owner metadata must stay readable by its own process under a restrictive
	// umask: release re-reads this record to authorize removal, and an info file
	// born mode 000 under umask 0777 would wedge the lock at first release.
	return Bun.write(`${lockPath}/info`, JSON.stringify(info), { mode: 0o600 })
		.then(() => fs.chmod(`${lockPath}/info`, 0o600))
		.then(() => info);
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

function fileLockDirIdentityFromPathState(state: LockInfoPathState, bytes: string): GenericFileLockDirIdentity {
	return {
		rootDev: String(state.root.dev),
		rootIno: String(state.root.ino),
		infoDev: String(state.file.dev),
		infoIno: String(state.file.ino),
		infoNlink: String(state.file.nlink),
		infoSize: String(state.file.size),
		infoMtimeNs: String(state.file.mtimeNs),
		infoCtimeNs: String(state.file.ctimeNs),
		infoSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
	};
}

/** Capture the exact root/info identity that a later stale verdict may authorize. */
async function captureFileLockDirIdentity(lockDir: string): Promise<GenericFileLockDirIdentity | null> {
	const observation = await readLockInfoObservation(lockDir);
	return observation ? fileLockDirIdentityFromPathState(observation.state, observation.bytes) : null;
}

/** Resolve parent aliases without following the mutable lock-dir final component. */
async function canonicalLockPathPreservingFinal(lockPath: string): Promise<string> {
	const parent = path.dirname(lockPath);
	try {
		return path.join(await fs.realpath(parent), path.basename(lockPath));
	} catch (error) {
		if (!isEnoent(error) && !isTransientReleaseError(error)) throw error;
		return lockPath;
	}
}

function normalizeLockKey(lockPath: string): string {
	return path.normalize(lockPath);
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
type LockInfoObservation = { bytes: string; state: LockInfoPathState };

async function readLockInfoObservation(lockPath: string): Promise<LockInfoObservation | null> {
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
		return { bytes: bytes.toString("utf8"), state: afterPath };
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function readLockInfoBytes(lockPath: string): Promise<string | null> {
	return (await readLockInfoObservation(lockPath))?.bytes ?? null;
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
	const { pid, start_time, start_time_format, timestamp, owner_host_id, owner_token } = parsed as Partial<LockInfo>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time)) ||
		(start_time_format !== undefined && (typeof start_time_format !== "string" || !start_time_format)) ||
		(owner_host_id !== undefined && (typeof owner_host_id !== "string" || !owner_host_id)) ||
		(owner_token !== undefined && (typeof owner_token !== "string" || !owner_token))
	)
		return null;
	return { pid, start_time, start_time_format, timestamp, owner_host_id, owner_token };
}

function parseLockInfoBytes(bytes: string): LockInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { pid, start_time, start_time_format, timestamp, owner_host_id, owner_token } = parsed as Partial<LockInfo>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time)) ||
		(start_time_format !== undefined && (typeof start_time_format !== "string" || !start_time_format)) ||
		(owner_host_id !== undefined && (typeof owner_host_id !== "string" || !owner_host_id)) ||
		(owner_token !== undefined && (typeof owner_token !== "string" || !owner_token))
	)
		return null;
	return { pid, start_time, start_time_format, timestamp, owner_host_id, owner_token };
}

/** @internal */
export interface FileLockGcObservation {
	info: FileLockOwnerToken;
	bytes: string;
	identity: GenericFileLockDirIdentity;
}

/** Capture owner bytes and the identity proving those exact bytes came from this tree. */
export async function readFileLockObservationForGc(lockDir: string): Promise<FileLockGcObservation | null> {
	const observation = await readLockInfoObservation(lockDir);
	if (!observation) return null;
	const info = parseLockInfoBytes(observation.bytes);
	if (!info) return null;
	const identity = fileLockDirIdentityFromPathState(observation.state, observation.bytes);
	fileLockDirIdentities.set(info, identity);
	return { info, bytes: observation.bytes, identity };
}

/** @internal */
export async function readFileLockInfoForGc(lockDir: string): Promise<FileLockOwnerToken | null> {
	return (await readFileLockObservationForGc(lockDir))?.info ?? null;
}

/** Owner identity stamped into a `<file>.lock/info` record. */
export interface FileLockOwnerToken {
	pid: number;
	start_time?: string;
	/** Encoding marker for the canonical UTC process-start identity. */
	start_time_format?: string;
	owner_host_id?: string;
	/** Unique acquisition generation, present on locks created by this runtime. */
	owner_token?: string;
	timestamp: number;
}

/**
 * Identity captured before a stale/liveness verdict. Kept out of the owner JSON: it is
 * authorization evidence for the in-memory call that produced the verdict, not metadata
 * another process may copy into a new lock generation.
 */
const fileLockDirIdentities = new WeakMap<object, GenericFileLockDirIdentity>();
const pendingDetachedLockCleanups = new WeakMap<object, { path: string; rootDev: string; rootIno: string }>();

async function finishDetachedLockCleanup(owner: FileLockOwnerToken): Promise<boolean> {
	const pending = pendingDetachedLockCleanups.get(owner);
	if (!pending) return false;
	try {
		const current = await fs.lstat(pending.path, { bigint: true });
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev.toString() !== pending.rootDev ||
			current.ino.toString() !== pending.rootIno
		) {
			throw new Error("Detached file lock cleanup identity changed; refusing removal");
		}
		await fs.rm(pending.path, { recursive: true, force: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	pendingDetachedLockCleanups.delete(owner);
	return true;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function fileLockRemovalTransitionPath(lockPath: string): string {
	return `${lockPath}.removing`;
}

async function fileLockRemovalTransitionExists(lockPath: string): Promise<boolean> {
	try {
		await fs.lstat(fileLockRemovalTransitionPath(lockPath));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function sameFileLockTreeAfterPublication(
	staged: NativeDirectoryTreeSnapshot,
	published: NativeDirectoryTreeSnapshot,
): boolean {
	return (
		staged.rootDev === published.rootDev &&
		staged.rootIno === published.rootIno &&
		staged.entries.length === published.entries.length &&
		staged.entries.every((entry, index) => {
			const current = published.entries[index];
			return (
				current !== undefined &&
				entry.relativePath === current.relativePath &&
				entry.kind === current.kind &&
				entry.dev === current.dev &&
				entry.ino === current.ino &&
				entry.nlink === current.nlink &&
				entry.size === current.size &&
				entry.mtimeNs === current.mtimeNs &&
				(entry.relativePath === "" || entry.ctimeNs === current.ctimeNs) &&
				entry.sha256 === current.sha256
			);
		})
	);
}

function rollbackPublishedFileLock(
	canonicalParent: string,
	lockPath: string,
	pendingPath: string,
	stagedSnapshot: NativeDirectoryTreeSnapshot,
): void {
	const authority = openRecoveryFsRoot(canonicalParent);
	let rollback: RecoveryFsPublishResult | undefined;
	const errors: unknown[] = [];
	try {
		rollback = authority.renameManagedTreeNoReplace(
			path.basename(lockPath),
			path.basename(pendingPath),
			stagedSnapshot,
		);
	} catch (error) {
		errors.push(error);
	}
	if (rollback && !rollback.ok) {
		const failure = new Error(
			`Failed to roll back file lock published during removal transition: ${rollback.code ?? "unknown"}.`,
		) as NodeJS.ErrnoException;
		if (rollback.code) failure.code = rollback.code;
		errors.push(failure);
	}
	try {
		const closed = authority.close();
		if (!closed.ok && closed.code !== "closed") {
			const failure = new Error(
				`Failed to close file lock rollback authority: ${closed.code ?? "unknown"}.`,
			) as NodeJS.ErrnoException;
			if (closed.code) failure.code = closed.code;
			errors.push(failure);
		}
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, "File lock rollback authority failed");
	if (!rollback) throw new Error("File lock rollback returned no result");
}

async function ensureLockParent(directory: string): Promise<void> {
	const missing: string[] = [];
	let current = path.resolve(directory);
	for (;;) {
		try {
			await fs.lstat(current);
			break;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			missing.push(current);
			const parent = path.dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
	for (const created of missing.reverse()) {
		try {
			await fs.mkdir(created, { mode: 0o700 });
			await fs.chmod(created, 0o700);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function isValidNativeNoReplaceResult(value: unknown): value is NativeNoReplaceResult {
	if (!isPlainRecord(value)) return false;
	const expectedKeys = [
		"ok",
		"code",
		"mutationState",
		"durabilityState",
		"reason",
		"primitive",
		"phase",
		"diagnostic",
	];
	if (Object.keys(value).some(key => !expectedKeys.includes(key))) return false;
	if (
		typeof value.ok !== "boolean" ||
		(value.code !== undefined && (typeof value.code !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.code))) ||
		!(["not_committed", "committed", "unknown"] as const).includes(value.mutationState as never) ||
		!(["not_attempted", "proven", "not_provable"] as const).includes(value.durabilityState as never) ||
		!(
			[
				"none",
				"destination_exists",
				"atomic_unavailable",
				"cross_device",
				"permission_denied",
				"io_failure",
				"invalid_request",
				"interrupted",
				"identity_violation",
				"durability_not_provable",
				"unknown",
			] as const
		).includes(value.reason as never) ||
		!(
			[
				"renameat2_noreplace",
				"linkat_noreplace",
				"mkdirat_renameat_noreplace",
				"renameatx_np_excl",
				"windows_rename_noreplace",
				"unsupported",
				"unknown",
			] as const
		).includes(value.primitive as never) ||
		!(
			[
				"preflight",
				"file_sync",
				"rename",
				"source_unlink",
				"source_parent_sync",
				"destination_parent_sync",
				"terminal_identity",
				"complete",
				"unknown",
			] as const
		).includes(value.phase as never)
	)
		return false;
	if (!isPlainRecord(value.diagnostic)) return false;
	if (
		Object.keys(value.diagnostic).some(
			key => !["schemaVersion", "collectionState", "osCode", "syncFailures"].includes(key),
		) ||
		value.diagnostic.schemaVersion !== 1 ||
		!(["complete", "partial", "unavailable"] as const).includes(value.diagnostic.collectionState as never) ||
		(value.diagnostic.osCode !== undefined &&
			(typeof value.diagnostic.osCode !== "number" || !Number.isInteger(value.diagnostic.osCode))) ||
		(value.diagnostic.syncFailures !== undefined && !Array.isArray(value.diagnostic.syncFailures))
	)
		return false;
	if (value.ok)
		return (
			value.mutationState === "committed" &&
			value.reason === "none" &&
			value.phase === "complete" &&
			(value.durabilityState === "not_attempted" || value.durabilityState === "proven")
		);
	if (value.mutationState === "not_committed") return value.durabilityState === "not_attempted";
	return value.mutationState === "unknown" && value.durabilityState === "not_provable";
}

/**
 * Only a complete native envelope proving that no namespace mutation happened
 * may authorize the directory fallback. A legacy or malformed result is
 * treated as an unknown publication outcome and never followed by another
 * mutating primitive.
 */
function isPreMutationUnsupportedRenameResult(value: unknown): value is NativeNoReplaceResult {
	if (!isValidNativeNoReplaceResult(value)) return false;
	if (
		value.ok !== false ||
		(value.code !== "invalid_request" && value.code !== "atomic_unavailable") ||
		value.mutationState !== "not_committed" ||
		value.durabilityState !== "not_attempted" ||
		value.reason !== value.code ||
		(value.primitive !== "renameat2_noreplace" && value.primitive !== "renameatx_np_excl") ||
		(value.phase !== "preflight" && value.phase !== "rename")
	)
		return false;
	return true;
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
	if (owner.start_time_format !== PROCESS_START_TIME_FORMAT || !owner.start_time || owner.start_time === "unknown")
		return false;
	if (ownerLiveness(owner.pid) !== "alive") return false;
	const currentStartTime = cachedProcessStartTime(owner, startTimeCache);
	return currentStartTime !== null && currentStartTime !== owner.start_time;
}

/** Outcome of a guarded lock-dir removal attempt (`removeFileLockDirForGc`). */
export type FileLockGcRemoval = "removed" | "owner_changed" | "missing" | "cleanup_failed";

type LockStaleSnapshot =
	| { stale: false }
	| { stale: true; owner: FileLockOwnerToken; identity: GenericFileLockDirIdentity };

/** Identity evidence carried by the generic stale verdict into a later removal. */
export interface GenericFileLockDirIdentity {
	rootDev: string;
	rootIno: string;
	infoDev: string;
	infoIno: string;
	infoNlink: string;
	infoSize: string;
	infoMtimeNs: string;
	infoCtimeNs: string;
	infoSha256: string;
}

function sameGenericFileLockDirIdentity(left: GenericFileLockDirIdentity, right: GenericFileLockDirIdentity): boolean {
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		left.infoDev === right.infoDev &&
		left.infoIno === right.infoIno &&
		left.infoNlink === right.infoNlink &&
		left.infoSize === right.infoSize &&
		left.infoMtimeNs === right.infoMtimeNs &&
		left.infoCtimeNs === right.infoCtimeNs &&
		left.infoSha256 === right.infoSha256
	);
}

export type GenericFileLockDirStaleVerdict = { stale: false } | { stale: true; identity: GenericFileLockDirIdentity };

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
	preVerdictIdentity?: GenericFileLockDirIdentity,
): Promise<FileLockGcRemoval> {
	// A generic release/quarantine call is only authorized by evidence captured
	// before its stale verdict. Capturing the current pathname here would let a
	// fresh successor inherit an old owner's release authority.
	const expectedIdentity = preVerdictIdentity ?? fileLockDirIdentities.get(expected);
	let onDiskBytes: string | null;
	try {
		onDiskBytes = await readLockInfoBytes(lockDir);
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
	const current = onDiskBytes === null ? null : parseLockInfoBytes(onDiskBytes);
	if (!current || onDiskBytes === null) return "missing";
	if (!expectedIdentity) return "owner_changed";
	if (
		current.pid !== expected.pid ||
		(expected.start_time !== undefined && current.start_time !== expected.start_time) ||
		current.owner_host_id !== expected.owner_host_id ||
		(expected.owner_token !== undefined && current.owner_token !== expected.owner_token) ||
		current.timestamp !== expected.timestamp
	) {
		return "owner_changed";
	}
	// The token comparison above authorizes the content that was judged, not the
	// pathname. When the caller carried pre-verdict root/info identity, require
	// the post-verdict native snapshot to match that same object before removal;
	// a clone or successor can therefore never inherit the stale authorization.
	// The canonical native path may refuse a symlinked parent ("reparse_point");
	// canonicalize first so the identity-bound capture sees the real directory,
	// mirroring how localLockKey canonicalizes the lock pathname.
	let nativeCapturePath = lockDir;
	try {
		nativeCapturePath = await canonicalLockPathPreservingFinal(lockDir);
	} catch (error) {
		if (!isEnoent(error) && !isTransientReleaseError(error)) return "cleanup_failed";
	}
	const captured = nativeFileLockBindings().snapshotDirectoryTree(nativeCapturePath);
	if (captured.code === "sharing_violation") throwTransientNativeResult(captured.code);
	if (!captured.ok || !captured.snapshot) return "owner_changed";
	const infoEntry = captured.snapshot.entries.find(entry => entry.relativePath === "info");
	if (!infoEntry?.sha256) return "owner_changed";
	const judgedDigest = crypto.createHash("sha256").update(onDiskBytes).digest("hex");
	if (infoEntry.sha256 !== judgedDigest) return "owner_changed";
	if (
		!captured.snapshot.rootDev ||
		captured.snapshot.rootDev !== expectedIdentity.rootDev ||
		captured.snapshot.rootIno !== expectedIdentity.rootIno ||
		infoEntry.dev !== expectedIdentity.infoDev ||
		infoEntry.ino !== expectedIdentity.infoIno ||
		infoEntry.nlink !== expectedIdentity.infoNlink ||
		infoEntry.size !== expectedIdentity.infoSize ||
		infoEntry.mtimeNs !== expectedIdentity.infoMtimeNs ||
		infoEntry.ctimeNs !== expectedIdentity.infoCtimeNs ||
		infoEntry.sha256 !== expectedIdentity.infoSha256
	)
		return "owner_changed";
	let removed: NativeExactUnlinkResult;
	try {
		removed = nativeFileLockBindings().exactRemoveDirectoryTree(nativeCapturePath, captured.snapshot);
	} catch (error) {
		// Keep the #2478 transient retry contract: sharing denials surface with
		// their transient code so callers retry, everything else is a refusal.
		if (isTransientReleaseError(error)) throw error;
		return "cleanup_failed";
	}
	if (removed.ok) return "removed";
	// The canonical name may already be detached: the security-critical phase is
	// done once the verified tree is durably scrubbed and parked under the
	// no-replace quarantine name with no successor retained. Finish that replay
	// deterministically by deleting the retained quarantine — the same completion
	// contract gc-runtime applies to its own exact removals. Any other outcome —
	// including a retained successor or placeholder — leaves the judged object (or
	// its replacement) in place and reports the removal as refused.
	const detachedPath = removed.detachedPath;
	const verifiedDetach =
		detachedPath !== undefined &&
		path.resolve(detachedPath) !== path.resolve(lockDir) &&
		removed.retainedSuccessorPath === undefined &&
		removed.retainedPlaceholderPath === undefined &&
		removed.retainedUnknownPath === undefined;
	if (verifiedDetach && detachedPath !== undefined) {
		pendingDetachedLockCleanups.set(expected, {
			path: detachedPath,
			rootDev: captured.snapshot.rootDev,
			rootIno: captured.snapshot.rootIno,
		});
		await finishDetachedLockCleanup(expected);
		return "removed";
	}
	if (removed.code === "not_found") return "removed";
	if (removed.code === "identity_mismatch") return "owner_changed";
	const refusal: NodeJS.ErrnoException = new Error(
		`Failed to remove file lock tree: ${removed.code ?? "unknown"}.`,
	) as NodeJS.ErrnoException;
	refusal.code = "EACCES";
	throw refusal;
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

async function staleLockSnapshot(
	lockPath: string,
	_staleMs: number,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
	startTimeCache?: Map<string, string | null>,
): Promise<LockStaleSnapshot> {
	// Capture the root and info inode BEFORE asking whether the owner is stale. A later
	// snapshot alone would let a copied successor inherit the stale verdict's authority.
	let judgedIdentity: GenericFileLockDirIdentity | null = null;
	try {
		judgedIdentity = await captureFileLockDirIdentity(lockPath);
	} catch (error) {
		if (isTransientReleaseError(error)) return { stale: false };
		throw error;
	}
	let info: LockInfo | null;
	try {
		info = await readLockInfo(lockPath);
	} catch (error) {
		// Windows can transiently deny reads of a just-created lock metadata file
		// while another contender is publishing it. Treat that as active
		// contention and retry rather than failing the caller or reaping by path.
		if (isTransientReleaseError(error)) return { stale: false };
		throw error;
	}
	if (!info) {
		// A directory without a valid owner record is either a contender between
		// native mkdirat ownership and metadata publication, or malformed/foreign
		// state. Neither case carries enough identity evidence for stale removal;
		// elapsed mtime must never make this empty namespace reclaimable.
		return { stale: false };
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
	if (ownerIncarnationChanged(info, startTimeCache)) {
		if (!judgedIdentity) return { stale: false };
		let currentIdentity: GenericFileLockDirIdentity | null;
		try {
			currentIdentity = await captureFileLockDirIdentity(lockPath);
		} catch (error) {
			if (isTransientReleaseError(error)) return { stale: false };
			throw error;
		}
		if (!currentIdentity || !sameGenericFileLockDirIdentity(judgedIdentity, currentIdentity)) return { stale: false };
		fileLockDirIdentities.set(info, judgedIdentity);
		return { stale: true, owner: info, identity: judgedIdentity };
	}
	// Never reap a live owner by elapsed time: a long legitimate critical section must
	// not have its lock stolen (#652). Reclaim only when the OS proves the owner is dead;
	// indeterminate liveness remains protected regardless of elapsed time.
	if (ownerIsAlive(info, startTimeCache)) return { stale: false };
	const liveness = ownerLiveness(info.pid);
	if (liveness === "dead") {
		if (!judgedIdentity) return { stale: false };
		let currentIdentity: GenericFileLockDirIdentity | null;
		try {
			currentIdentity = await captureFileLockDirIdentity(lockPath);
		} catch (error) {
			if (isTransientReleaseError(error)) return { stale: false };
			throw error;
		}
		if (!currentIdentity || !sameGenericFileLockDirIdentity(judgedIdentity, currentIdentity)) return { stale: false };
		fileLockDirIdentities.set(info, judgedIdentity);
		return { stale: true, owner: info, identity: judgedIdentity };
	}
	return { stale: false };
}

async function removeStaleLockForAcquire(lockPath: string, snapshot: LockStaleSnapshot): Promise<boolean> {
	if (!snapshot.stale) return false;
	return (await removeFileLockDirForGc(lockPath, snapshot.owner, snapshot.identity)) === "removed";
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
	return (await genericFileLockDirStaleVerdict(lockDir, staleMs, ownerHostId)).stale;
}

/**
 * Render a generic stale verdict together with the root and owner-file identity that
 * verdict actually observed. A caller that removes the directory must require a later
 * native snapshot to carry this same identity; a snapshot taken only after a clone was
 * installed is not authority for the stale verdict.
 */
export async function genericFileLockDirStaleVerdict(
	lockDir: string,
	staleMs: number,
	ownerHostId?: string,
): Promise<GenericFileLockDirStaleVerdict> {
	const verdict = await staleLockSnapshot(lockDir, staleMs, ownerHostId);
	if (!verdict.stale) return { stale: false };
	return {
		stale: true,
		identity: verdict.identity,
	};
}

async function tryAcquireLock(
	lockPath: string,
	ownerHostId?: string,
	ownerToken = crypto.randomUUID(),
	onAcquired?: () => void,
): Promise<LockInfo | null> {
	await ensureLockParent(path.dirname(lockPath));
	const afterParentMkdir = FileLockTestHooks.afterParentMkdir;
	if (afterParentMkdir) await afterParentMkdir(lockPath);
	const pendingPath = `${lockPath}.pending.${process.pid}.${crypto.randomUUID()}`;
	const owner = lockInfo(ownerHostId, ownerToken);
	let removePending = false;
	try {
		await fs.mkdir(pendingPath, { mode: 0o700 });
		removePending = true;
		await fs.chmod(pendingPath, 0o700);
		await writeLockInfo(pendingPath, owner);
		// A plain POSIX rename replaces an existing empty directory. The legacy
		// directory lock is a real holder, so publication must use the native
		// no-replace primitive rather than treating an empty destination as free.
		// The native primitive also rejects symlinked/reparse parents. Resolve the
		// already-created staging entry and its parent before publication so aliases
		// retain the same lock identity as the ordinary path.
		const canonicalParent = await fs.realpath(path.dirname(lockPath));
		const destinationPath = path.join(canonicalParent, path.basename(lockPath));
		// Resolve only the stable parent: resolving the mutable staging final
		// component would follow an attacker-replaced symlink before native no-follow
		// validation gets a chance to reject it.
		const canonicalPendingPath = path.join(canonicalParent, path.basename(pendingPath));
		let stagedSnapshot: NativeDirectoryTreeSnapshot | undefined;
		if (process.platform === "linux") {
			// Linux exact tree removal owns this deterministic sibling from detach
			// until cleanup. The outer acquisition loop supplies the existing bounded
			// contention wait while the predecessor retains that namespace.
			if (await fileLockRemovalTransitionExists(destinationPath)) return null;
			const staged = snapshotDirectoryTree(canonicalPendingPath);
			if (!staged.ok || !staged.snapshot) {
				const failure = new Error(
					`Failed to snapshot staged file lock: ${staged.code ?? "unknown"}.`,
				) as NodeJS.ErrnoException;
				if (staged.code) failure.code = staged.code;
				throw failure;
			}
			stagedSnapshot = staged.snapshot;
		}
		const publication = FileLockTestHooks.nativePublicationBindings?.() ?? {
			renameNoReplacePathAsync,
			renameDirectoryNoReplacePathAsync,
		};
		const published = await publication.renameNoReplacePathAsync(canonicalPendingPath, destinationPath);
		let publishedSuccessfully = published.ok;
		if (!published.ok && isPreMutationUnsupportedRenameResult(published)) {
			const fallback = await publication.renameDirectoryNoReplacePathAsync(canonicalPendingPath, destinationPath);
			if (fallback.ok) {
				publishedSuccessfully = true;
			} else if (fallback.reason === "destination_exists") {
				return null;
			} else {
				const failure = new Error(
					`Failed to publish file lock: ${fallback.code ?? fallback.reason ?? "unknown"}.`,
				) as NodeJS.ErrnoException;
				if (fallback.code) failure.code = fallback.code;
				throw failure;
			}
		}
		if (!publishedSuccessfully) {
			if (published.reason === "destination_exists") return null;
			const failure = new Error(
				`Failed to publish file lock: ${published.code ?? published.reason ?? "unknown"}.`,
			) as NodeJS.ErrnoException;
			if (published.code) failure.code = published.code;
			throw failure;
		}
		removePending = false;
		// The transition can appear after the pre-publication check only when the
		// predecessor atomically detaches its lock before this no-replace publish.
		// Roll this exact staged tree back to its UUID path before reporting
		// contention; never delete or rename the predecessor's `.removing` tree.
		if (stagedSnapshot && (await fileLockRemovalTransitionExists(destinationPath))) {
			const publishedSnapshot = snapshotDirectoryTree(destinationPath);
			if (
				!publishedSnapshot.ok ||
				!publishedSnapshot.snapshot ||
				!sameFileLockTreeAfterPublication(stagedSnapshot, publishedSnapshot.snapshot)
			) {
				const failure = new Error(
					`Failed to verify published file lock before transition rollback: ${publishedSnapshot.code ?? "identity_mismatch"}.`,
				) as NodeJS.ErrnoException;
				if (publishedSnapshot.code) failure.code = publishedSnapshot.code;
				throw failure;
			}
			rollbackPublishedFileLock(canonicalParent, destinationPath, canonicalPendingPath, publishedSnapshot.snapshot);
			removePending = true;
			return null;
		}
		// Published and transition-free above, so an onAcquired failure must
		// propagate instead of retrying an acquisition that already owns the lock.
		onAcquired?.();
		return owner;
	} finally {
		if (removePending) await fs.rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
	}
}

function isTransientReleaseError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return (
		code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY" || code === "sharing_violation"
	);
}

function throwTransientNativeResult(code: string): never {
	throw Object.assign(new Error(`Native lock operation is transiently unavailable: ${code}.`), { code });
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

async function quarantineReleasedLock(
	lockPath: string,
	owner: FileLockOwnerToken,
	preVerdictIdentity?: GenericFileLockDirIdentity,
): Promise<boolean> {
	const expectedIdentity = preVerdictIdentity ?? fileLockDirIdentities.get(owner);
	// Quarantine is only a release fallback after earlier transient failures. It must not
	// make a fresh post-failure snapshot authoritative for an object this release never
	// judged; without pre-verdict evidence, refuse and let the caller surface the retry
	// failure instead of risking a successor lock.
	if (!expectedIdentity) return false;
	let captured: NativeDirectoryTreeResult;
	const nativeCapturePath = await canonicalLockPathPreservingFinal(lockPath);
	try {
		captured = nativeFileLockBindings().snapshotDirectoryTree(nativeCapturePath);
		if (captured.code === "sharing_violation") throwTransientNativeResult(captured.code);
	} catch (error) {
		if (isTransientReleaseError(error)) return false;
		throw error;
	}
	if (!captured.ok || !captured.snapshot) return false;
	const infoEntry = captured.snapshot.entries.find(entry => entry.relativePath === "info");
	if (!infoEntry?.sha256) return false;
	if (
		captured.snapshot.rootDev !== expectedIdentity.rootDev ||
		captured.snapshot.rootIno !== expectedIdentity.rootIno ||
		infoEntry.dev !== expectedIdentity.infoDev ||
		infoEntry.ino !== expectedIdentity.infoIno ||
		infoEntry.nlink !== expectedIdentity.infoNlink ||
		infoEntry.size !== expectedIdentity.infoSize ||
		infoEntry.mtimeNs !== expectedIdentity.infoMtimeNs ||
		infoEntry.ctimeNs !== expectedIdentity.infoCtimeNs ||
		infoEntry.sha256 !== expectedIdentity.infoSha256
	)
		return false;
	// Bind the owner generation to the snapshot before exact removal. A successor
	// installed after this snapshot is rejected by the native identity check instead of
	// being moved into quarantine by a pathname-only rename.
	const expectedDigest = crypto.createHash("sha256").update(JSON.stringify(owner)).digest("hex");
	if (infoEntry.sha256 !== expectedDigest) return false;
	let removed: NativeExactUnlinkResult;
	try {
		removed = nativeFileLockBindings().exactRemoveDirectoryTree(nativeCapturePath, captured.snapshot);
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
			await fs.lstat(nativeCapturePath);
			return false;
		} catch (error) {
			if (isEnoent(error)) {
				pendingDetachedLockCleanups.set(owner, {
					path: removed.detachedPath,
					rootDev: captured.snapshot.rootDev,
					rootIno: captured.snapshot.rootIno,
				});
				await finishDetachedLockCleanup(owner);
				return true;
			}
			throw error;
		}
	}
	return false;
}

async function releaseOwnedLock(lockPath: string, owner: FileLockOwnerToken): Promise<void> {
	if (await finishDetachedLockCleanup(owner)) return;
	let preVerdictIdentity: GenericFileLockDirIdentity | undefined;
	try {
		preVerdictIdentity = (await captureFileLockDirIdentity(lockPath)) ?? undefined;
		if (preVerdictIdentity) fileLockDirIdentities.set(owner, preVerdictIdentity);
	} catch (error) {
		if (!isTransientReleaseError(error)) throw error;
	}
	let lastTransientError: unknown;
	for (let attempt = 0; attempt < FILE_LOCK_RELEASE_RETRY_ATTEMPTS; attempt++) {
		try {
			if (await finishDetachedLockCleanup(owner)) return;
			const outcome = await removeFileLockDirForGc(lockPath, owner, preVerdictIdentity);
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
	if (await quarantineReleasedLock(lockPath, owner, preVerdictIdentity)) return;
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

async function pendingLocalReleaseKey(lockPath: string, localKey: string): Promise<string | undefined> {
	const direct = localLockStates.get(localKey);
	if (direct) return direct.status === "held" ? undefined : localKey;
	let info: LockInfo | null;
	try {
		info = await readLockInfo(lockPath);
	} catch (error) {
		if (isTransientReleaseError(error)) return undefined;
		throw error;
	}
	const ownerToken = info?.owner_token;
	if (!ownerToken) return undefined;
	for (const [key, state] of localLockStates) {
		if (key !== localKey && state.status !== "held" && state.owner.owner_token === ownerToken) return key;
	}
	return undefined;
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
		if (process.platform === "linux" && (await fileLockRemovalTransitionExists(lockPath))) {
			return "blocked by retained removal transition; retry the owning process cleanup or inspect the exact orphan manually; unproven transition ownership is never removed";
		}
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
	const requestedFilePath: unknown = filePath;
	if (typeof requestedFilePath !== "string" || requestedFilePath.length === 0 || !path.isAbsolute(requestedFilePath))
		throw new TypeError("filePath must be a non-empty absolute path");
	if (requestedFilePath.includes("\0")) throw new TypeError("filePath must not contain NUL bytes");
	if (options.ownerHostId !== undefined && !options.ownerHostId) throw new Error("ownerHostId must be non-empty");
	if (options.previousOwnerHostIds?.some(hostId => !hostId))
		throw new Error("previousOwnerHostIds must contain only non-empty identities");
	const opts = { ...DEFAULT_OPTIONS, ...options };
	if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("File lock acquisition aborted");
	const lockPath = getLockPath(filePath);
	await ensureLockParent(path.dirname(lockPath));
	const ownerToken = crypto.randomUUID();
	const contentionStartTimes = new Map<string, string | null>();
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("File lock acquisition aborted");
		const localKey = await localLockKey(lockPath);
		const priorRelease = localLockStates.get(localKey);
		if (priorRelease && priorRelease.status !== "held" && pendingDetachedLockCleanups.has(priorRelease.owner)) {
			await retryPendingLocalRelease(lockPath, localKey);
			continue;
		}
		const owner = await tryAcquireLock(lockPath, opts.ownerHostId, ownerToken, opts.onAcquired);
		if (owner) {
			localLockStates.set(localKey, { owner, status: "held" });
			return () => releaseLock(lockPath, owner, localKey);
		}
		const pendingKey = await pendingLocalReleaseKey(lockPath, localKey);
		const localState = localLockStates.get(pendingKey ?? localKey);
		if (pendingKey !== undefined && localState?.status !== "held" && localState?.owner.owner_token !== undefined) {
			try {
				await retryPendingLocalRelease(lockPath, pendingKey);
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
