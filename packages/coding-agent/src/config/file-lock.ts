import * as crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
	NativeNoReplaceResult,
	RecoveryFsPublishResult,
} from "@gajae-code/natives";
import {
	exactRestore,
	exactUnlinkDirect,
	exactUnlinkOpenFile,
	openRecoveryFsRoot,
	renameDirectoryNoReplacePathAsync,
	renameNoReplacePathAsync,
	snapshotDirectoryTree,
} from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { isEnoent } from "@gajae-code/utils/fs-error";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { projectSafeSpawnEnv } from "@gajae-code/utils/shell-config";

export interface FileLockOptions {
	staleMs?: number;
	/** Age after which an ownerless removal transition may be adopted; defaults to `staleMs`. */
	orphanTransitionAgeMs?: number;
	retries?: number;
	retryDelayMs?: number;
	signal?: AbortSignal;
	onAcquired?: () => void;
	onContended?: () => void;
	/** Stable host identity required to safely reclaim locks on a shared volume. */
	ownerHostId?: string;
	/** Previous local host identities accepted only when deciding stale-owner reclamation. */
	previousOwnerHostIds?: readonly string[];
}

export type FileLockAcquireReason = "acquire_timeout" | "orphan_transition";
export type FileLockPublicationFailureCode = "access_denied" | "sharing_violation";

/**
 * Why the acquire path could not retire a lock directory whose owner it had already
 * proven dead. Attached to `FileLockAcquireError` so a host whose lock-removal path
 * refuses the directory is not misreported as a live or unreaped owner. The acquire
 * loop still contends after a refusal (a concurrent reclaimer may finish the same dead
 * generation); this records the cause that exhaustion must report.
 */
export interface FileLockStaleRemovalFailure {
	/** Guarded-removal outcome; refusals are surfaced only after exhaustion revalidates the dead generation. */
	outcome: "cleanup_failed" | "owner_changed" | "missing" | "error";
	/** Native/errno code carried by the refusal, when one was present. */
	code?: string;
	/** Human-readable cause surfaced to the operator at exhaustion. */
	message: string;
	/** Platform-specific manual cleanup command, set only when the same dead owner persists at exhaustion. */
	manualCleanupCommand?: string;
}

export class FileLockAcquireError extends Error {
	readonly code: FileLockAcquireReason;

	constructor(
		readonly filePath: string,
		readonly lockPath: string,
		readonly attempts: number,
		readonly holder: string,
		readonly reason: FileLockAcquireReason = "acquire_timeout",
		readonly orphanPath?: string,
		readonly removalFailure?: FileLockStaleRemovalFailure,
		readonly publicationFailureCode?: FileLockPublicationFailureCode,
		/** True only when exhaustion proved a same-host owner process is live. */
		readonly holderIsLive = false,
	) {
		const detail =
			reason === "orphan_transition" && orphanPath ? `blocked by retained removal transition ${orphanPath}` : holder;
		const removalDetail = removalFailure
			? ` The dead owner's lock directory could not be reaped on this host (${removalFailure.message}${
					removalFailure.code ? ` [${removalFailure.code}]` : ""
				})`
			: "";
		const cleanupDetail = removalFailure?.manualCleanupCommand
			? `; manual cleanup is appropriate only after independently verifying this exact directory still belongs to the dead owner and no successor has taken it: ${removalFailure.manualCleanupCommand}`
			: "";
		const publicationDetail = publicationFailureCode
			? `; last lock publication failed with ${publicationFailureCode}`
			: "";
		const contentionGuidance =
			publicationFailureCode === "access_denied" && !holderIsLive
				? ""
				: "; a live owner is never displaced — if this is an SDK broker (gjc sdk session list), it must finish or be stopped before retrying";
		super(
			`Failed to acquire lock for ${filePath} after ${attempts} attempts: ${detail}${removalDetail}${publicationDetail} (${lockPath})${contentionGuidance}${cleanupDetail}`,
		);
		this.code = reason;
		this.name = "FileLockAcquireError";
	}
}

export class FileLockStagingCleanupError extends Error {
	readonly code: string | undefined;

	constructor(
		readonly lockPath: string,
		readonly stagingPath: string,
		cause: unknown,
	) {
		const code =
			typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
				? cause.code
				: undefined;
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to clean staged file-lock publication at ${stagingPath}${code ? ` (${code})` : ""}: ${detail}`);
		this.code = code;
		this.name = "FileLockStagingCleanupError";
	}
}

export function isFileLockAcquireTimeout(error: unknown): error is FileLockAcquireError {
	return (
		error instanceof FileLockAcquireError &&
		error.code === "acquire_timeout" &&
		(error.publicationFailureCode !== "access_denied" || error.holderIsLive)
	);
}

const DEFAULT_OPTIONS: Required<
	Omit<
		FileLockOptions,
		"orphanTransitionAgeMs" | "ownerHostId" | "previousOwnerHostIds" | "signal" | "onAcquired" | "onContended"
	>
> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

type FileLockStagingFileIdentity = { dev: string; ino: string };
type FileLockStagingRootIdentity = {
	rootDev: string;
	rootIno: string;
	treeSnapshot?: NativeDirectoryTreeSnapshot;
	infoFileIdentity?: FileLockStagingFileIdentity;
};
type PendingFileLockStagingCleanup = {
	lockPath: string;
	identity?: FileLockStagingRootIdentity;
};

const pendingStagingCleanups = new Map<string, PendingFileLockStagingCleanup>();

/**
 * Windows can transiently deny a no-replace publication while another process holds
 * the staged or destination path open. Retry only validated pre-mutation receipts;
 * persistent access-denied failures remain fatal rather than being reported as contention.
 */
const PUBLICATION_TRANSIENT_RETRY_ATTEMPTS = 3;
const PUBLICATION_TRANSIENT_RETRY_DELAY_MS = 10;
/** Allow one caller backoff for transient Windows denial without multiplying a persistent ACL failure by the full lock wait. */
const MAX_ACCESS_DENIED_PUBLICATION_ACQUISITION_ATTEMPTS = 2;

/** Grace period after which an unpublished removal transition becomes reclaimable as orphan. */
const REMOVAL_TRANSITION_GRACE_MS = 10_000;
/**
 * Additional buffer beyond the grace period to ensure a retained removal transition
 * whose owner died is reclaimed promptly, decoupled from acquisition retry budget.
 * This bounds how long a dead owner's transition can block lock acquisition.
 */
const REMOVAL_TRANSITION_ADOPTION_BUFFER_MS = 5_000;
export const FILE_LOCK_ORPHAN_TRANSITION_ADOPTION_AGE_MS =
	REMOVAL_TRANSITION_GRACE_MS + REMOVAL_TRANSITION_ADOPTION_BUFFER_MS;

/** Release retries cover transient handle denial and a competing exact-removal quarantine cleanup. */
export const FILE_LOCK_RELEASE_RETRY_ATTEMPTS = 20;
export const FILE_LOCK_RELEASE_RETRY_DELAY_MS = 25;
const PROCESS_START_TIME_FORMAT = "utc-v1";

type LocalLockState = {
	owner: FileLockOwnerToken;
	status: "held" | "release_pending" | "releasing";
	releasePath?: string;
	releasePromise?: Promise<void>;
};

/**
 * Process-local ownership is deliberately separate from PID liveness. A PID only says
 * that a process exists; this table says which exact acquisition generation this process
 * created, so a nested contender cannot steal a lock from a still-running holder.
 */
const localLockStates = new Map<string, LocalLockState>();
const MAX_FILE_LOCK_REMOVAL_RECORD_BYTES = 64 * 1024;

type LockInfo = FileLockOwnerToken;

export const FileLockTestHooks: {
	afterParentMkdir?: (lockPath: string) => void | Promise<void>;
	afterStagingInfoWrite?: (stagingPath: string) => void | Promise<void>;
	stagingInfoIdentity?: (
		infoPath: string,
		capture: () => Promise<FileLockStagingFileIdentity>,
	) => Promise<FileLockStagingFileIdentity>;
	stagingInfoCleanup?: (
		infoPath: string,
		callerFd: number,
		quarantineName: string,
	) => NativeExactUnlinkResult | Promise<NativeExactUnlinkResult>;
	beforeDetachedLockCleanup?: (detachedPath: string) => boolean | Promise<boolean>;
	afterRemovalOwnerPublish?: (transitionPath: string) => void | Promise<void>;
	afterRemovalTransitionMissing?: (transitionPath: string) => void | Promise<void>;
	afterForeignTransitionMissing?: (transitionPath: string) => void | Promise<void>;
	beforeRemovalRecordUnlink?: (recordPath: string) => boolean | Promise<boolean>;
	beforeRemovalOwnerPublish?: (transitionPath: string) => void | Promise<void>;
	cleanupPendingStaging?: (stagingPath: string) => Promise<void>;
	stagingRootIdentity?: (stagingPath: string) => FileLockStagingRootIdentity | Promise<FileLockStagingRootIdentity>;
	nativePublicationBindings?: () => {
		renameNoReplacePathAsync: typeof renameNoReplacePathAsync;
		renameDirectoryNoReplacePathAsync: typeof renameDirectoryNoReplacePathAsync;
	};
	stagingIdentityEvidence?: () => {
		processIncarnation: string | null;
		startTime: string | null;
	};
	processIncarnation?: (pid: number) => string | null;
	nativeQuarantineBindings?: () => NativeFileLockBindings;
	nativeExactRemovalProbe?: () => boolean | Promise<boolean>;
} = {};

type FileLockAcquisitionRetryBudget = {
	remainingDelays: number;
	retryDelayMs: number;
	signal?: AbortSignal;
};

function throwIfFileLockAcquisitionAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("File lock acquisition aborted");
}

async function sleepFileLockRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(delayMs);
		return;
	}
	throwIfFileLockAcquisitionAborted(signal);
	const settled = Promise.withResolvers<void>();
	const onAbort = (): void => {
		settled.reject(signal.reason ?? new Error("File lock acquisition aborted"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal.aborted) onAbort();
		await Promise.race([Bun.sleep(Math.max(0, delayMs)), settled.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function captureFileLockStagingRootIdentity(
	stagingPath: string,
	retryBudget: FileLockAcquisitionRetryBudget,
): Promise<FileLockStagingRootIdentity> {
	const capture = FileLockTestHooks.stagingRootIdentity;
	if (capture) return await capture(stagingPath);
	for (;;) {
		try {
			const root = await fs.lstat(stagingPath, { bigint: true });
			if (!root.isDirectory() || root.isSymbolicLink())
				throw Object.assign(new Error("Staged file-lock root is not a directory."), { code: "identity_mismatch" });
			return {
				rootDev: canonicalLockDeviceId(root.dev).toString(),
				rootIno: canonicalLockFileId(root.ino).toString(),
			};
		} catch (error) {
			if (!isTransientReleaseError(error) || retryBudget.remainingDelays === 0) throw error;
			retryBudget.remainingDelays--;
			await sleepFileLockRetry(retryBudget.retryDelayMs, retryBudget.signal);
		}
	}
}

async function captureFileLockStagingTreeSnapshot(
	stagingPath: string,
	retryBudget: FileLockAcquisitionRetryBudget,
): Promise<NativeDirectoryTreeSnapshot> {
	for (;;) {
		const captured = nativeFileLockBindings().snapshotDirectoryTree(stagingPath);
		if (captured.ok && captured.snapshot) return captured.snapshot;
		const code = captured.code ?? "snapshot_unavailable";
		if (
			code !== "access_denied" &&
			code !== "io_error" &&
			code !== "permission_denied" &&
			code !== "sharing_violation"
		) {
			throw Object.assign(new Error(`Failed to snapshot staged file lock: ${code}.`), { code });
		}
		if (retryBudget.remainingDelays === 0)
			throw Object.assign(new Error(`Failed to snapshot staged file lock: ${code}.`), { code });
		retryBudget.remainingDelays--;
		await sleepFileLockRetry(retryBudget.retryDelayMs, retryBudget.signal);
	}
}

function bindFileLockStagingTreeSnapshot(
	stagingPath: string,
	identity: FileLockStagingRootIdentity,
	snapshot: NativeDirectoryTreeSnapshot,
): FileLockStagingRootIdentity {
	if (snapshot.rootDev !== identity.rootDev || snapshot.rootIno !== identity.rootIno)
		throw Object.assign(new Error(`Staged file-lock root identity changed while snapshotting ${stagingPath}.`), {
			code: "identity_mismatch",
		});
	return { ...identity, treeSnapshot: snapshot };
}

function matchesExpectedFileLockStagingTree(
	snapshot: NativeDirectoryTreeSnapshot,
	identity: FileLockStagingRootIdentity,
): boolean {
	const root = snapshot.entries.find(entry => entry.relativePath === "");
	if (
		snapshot.rootDev !== identity.rootDev ||
		snapshot.rootIno !== identity.rootIno ||
		root?.kind !== "directory" ||
		root.dev !== identity.rootDev ||
		root.ino !== identity.rootIno
	)
		return false;
	if (snapshot.entries.length === 1) return true;
	if (snapshot.entries.length !== 2 || !identity.infoFileIdentity) return false;
	const info = snapshot.entries.find(entry => entry.relativePath === "info");
	return (
		info?.kind === "file" &&
		info.dev === identity.infoFileIdentity.dev &&
		info.ino === identity.infoFileIdentity.ino &&
		info.nlink === "1"
	);
}

async function captureFileLockStagingCleanupIdentity(
	stagingPath: string,
	identity: FileLockStagingRootIdentity,
	retryBudget: FileLockAcquisitionRetryBudget,
): Promise<FileLockStagingRootIdentity> {
	const snapshot = await captureFileLockStagingTreeSnapshot(stagingPath, retryBudget);
	// A replay can authorize only the empty root or that root plus this attempt's exact info inode.
	if (!matchesExpectedFileLockStagingTree(snapshot, identity))
		throw Object.assign(
			new Error("Staged file-lock contents changed before cleanup authority was captured; refusing removal."),
			{ code: "identity_unavailable" },
		);
	return bindFileLockStagingTreeSnapshot(stagingPath, identity, snapshot);
}

async function hasPendingStagingRootIdentity(
	stagingPath: string,
	identity: FileLockStagingRootIdentity,
): Promise<boolean> {
	let root: BigIntStats;
	try {
		root = await fs.lstat(stagingPath, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	if (
		!root.isDirectory() ||
		root.isSymbolicLink() ||
		canonicalLockDeviceId(root.dev).toString() !== identity.rootDev ||
		canonicalLockFileId(root.ino).toString() !== identity.rootIno
	)
		throw Object.assign(new Error("Staged file-lock root identity changed; refusing removal."), {
			code: "identity_mismatch",
		});
	return true;
}

async function removePendingStaging(stagingPath: string, identity: FileLockStagingRootIdentity): Promise<void> {
	const cleanup = FileLockTestHooks.cleanupPendingStaging;
	if (cleanup) {
		if (!(await hasPendingStagingRootIdentity(stagingPath, identity))) return;
		await cleanup(stagingPath);
		return;
	}
	if (!identity.infoFileIdentity && process.platform !== "win32") {
		if (!(await hasPendingStagingRootIdentity(stagingPath, identity))) return;
		const captured = nativeFileLockBindings().snapshotDirectoryTree(stagingPath);
		const root = captured.snapshot?.entries.find(entry => entry.relativePath === "");
		if (
			!captured.ok ||
			!captured.snapshot ||
			captured.snapshot.entries.length !== 1 ||
			captured.snapshot.rootDev !== identity.rootDev ||
			captured.snapshot.rootIno !== identity.rootIno ||
			root?.kind !== "directory" ||
			root.dev !== identity.rootDev ||
			root.ino !== identity.rootIno
		)
			throw Object.assign(
				new Error("Staged file-lock root is not empty and its info identity is unavailable; refusing removal."),
				{ code: captured.code ?? "identity_unavailable" },
			);
		// Unlike recursive removal, rmdir cannot consume an entry that appears after
		// the empty-tree proof; it fails with ENOTEMPTY instead.
		await fs.rmdir(stagingPath);
		return;
	}
	if (process.platform === "win32") {
		if (!identity.treeSnapshot && !(await hasPendingStagingRootIdentity(stagingPath, identity))) return;
		if (!identity.treeSnapshot)
			throw Object.assign(new Error("Staged file-lock tree identity is unavailable; refusing removal."), {
				code: "identity_unavailable",
			});
		// A pathname check followed by fs.rm can erase a replacement installed in
		// between; Windows cleanup must revalidate the captured tree atomically.
		const removal = nativeFileLockBindings().exactRemoveDirectoryTree(stagingPath, identity.treeSnapshot);
		if (!removal.ok && removal.code !== "not_found") {
			const detachedPath = validateDetachedStagingCleanupPath(stagingPath, removal.detachedPath);
			throw Object.assign(new Error(`Failed to remove staged file-lock tree: ${removal.code ?? "unknown"}.`), {
				code: removal.code ?? "cleanup_failed",
				...(detachedPath === undefined ? {} : { detachedPath }),
			});
		}
		return;
	}
	if (await hasPendingStagingRootIdentity(stagingPath, identity))
		await fs.rm(stagingPath, { recursive: true, force: true });
}

function sameFileLockPath(left: string, right: string): boolean {
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

function validateDetachedStagingCleanupPath(stagingPath: string, detachedPath: string | undefined): string | undefined {
	if (detachedPath === undefined) return undefined;
	if (!sameFileLockPath(detachedPath, stagingPath) && !sameFileLockPath(detachedPath, `${stagingPath}.removing`))
		throw Object.assign(new Error("Native staging cleanup returned an unexpected detached path."), {
			code: "identity_mismatch",
		});
	return detachedPath;
}

function detachedStagingCleanupPath(stagingPath: string, error: unknown): string {
	if (typeof error !== "object" || error === null || !("detachedPath" in error)) return stagingPath;
	const detachedPath = (error as { detachedPath?: unknown }).detachedPath;
	try {
		return (
			validateDetachedStagingCleanupPath(stagingPath, typeof detachedPath === "string" ? detachedPath : undefined) ??
			stagingPath
		);
	} catch {
		return stagingPath;
	}
}

function retainPendingStagingCleanup(
	lockPath: string,
	stagingPath: string,
	identity: FileLockStagingRootIdentity | undefined,
	error: unknown,
): void {
	pendingStagingCleanups.set(stagingPath, { lockPath, identity });
	logger.debug("Retained file-lock staging cleanup", { stagingPath, error: String(error) });
}

async function abortStagingCleanup(
	lockPath: string,
	stagingPath: string,
	identity: FileLockStagingRootIdentity,
	signal: AbortSignal,
): Promise<never> {
	let cleanupPath = stagingPath;
	try {
		await removePendingStaging(cleanupPath, identity);
		pendingStagingCleanups.delete(cleanupPath);
	} catch (error) {
		cleanupPath = detachedStagingCleanupPath(cleanupPath, error);
		if (cleanupPath !== stagingPath) pendingStagingCleanups.delete(stagingPath);
		// The stage is still owned by this acquisition. Preserve an in-process retry
		// until another acquisition can clean it; after process exit the orphan reaper
		// can safely reclaim it once this publisher is no longer live.
		retainPendingStagingCleanup(lockPath, cleanupPath, identity, error);
	}
	throw signal.reason ?? new Error("File lock acquisition aborted");
}

async function retryPendingStagingCleanups(
	lockPath: string,
	retryBudget: FileLockAcquisitionRetryBudget,
): Promise<void> {
	const lockKey = await localLockKey(lockPath);
	for (const [stagingPath, pending] of pendingStagingCleanups) {
		if ((await localLockKey(pending.lockPath)) !== lockKey) continue;
		if (!pending.identity) {
			try {
				await fs.lstat(stagingPath);
			} catch (error) {
				if (isEnoent(error)) {
					pendingStagingCleanups.delete(stagingPath);
					continue;
				}
				if (retryBudget.signal?.aborted) throw retryBudget.signal.reason ?? error;
				throw new FileLockStagingCleanupError(lockPath, stagingPath, error);
			}
			const error = Object.assign(new Error("Retained staging cleanup has no captured identity."), {
				code: "identity_unavailable",
			});
			throw new FileLockStagingCleanupError(lockPath, stagingPath, error);
		}
		let identity = pending.identity;
		if (process.platform === "win32" && !identity.treeSnapshot) {
			try {
				if (!(await hasPendingStagingRootIdentity(stagingPath, identity))) {
					pendingStagingCleanups.delete(stagingPath);
					continue;
				}
				identity = await captureFileLockStagingCleanupIdentity(stagingPath, identity, retryBudget);
				pendingStagingCleanups.set(stagingPath, { ...pending, identity });
			} catch (error) {
				if (retryBudget.signal?.aborted) throw retryBudget.signal.reason ?? error;
				throw new FileLockStagingCleanupError(lockPath, stagingPath, error);
			}
		}
		await cleanupPendingStagingOrThrow(lockPath, stagingPath, identity, retryBudget);
	}
}

async function cleanupPendingStagingOrThrow(
	lockPath: string,
	stagingPath: string,
	identity: FileLockStagingRootIdentity,
	retryBudget: FileLockAcquisitionRetryBudget,
): Promise<void> {
	let cleanupPath = stagingPath;
	for (;;) {
		if (retryBudget.signal?.aborted) await abortStagingCleanup(lockPath, cleanupPath, identity, retryBudget.signal);
		try {
			await removePendingStaging(cleanupPath, identity);
			pendingStagingCleanups.delete(cleanupPath);
			return;
		} catch (error) {
			if (retryBudget.signal?.aborted)
				await abortStagingCleanup(lockPath, cleanupPath, identity, retryBudget.signal);
			const detachedPath = detachedStagingCleanupPath(cleanupPath, error);
			if (detachedPath !== cleanupPath) {
				pendingStagingCleanups.delete(cleanupPath);
				cleanupPath = detachedPath;
			}
			if (!isTransientReleaseError(error) || retryBudget.remainingDelays <= 0) {
				retainPendingStagingCleanup(lockPath, cleanupPath, identity, error);
				throw new FileLockStagingCleanupError(lockPath, cleanupPath, error);
			}
			// An open child can deny both publication and removal on Windows. Keep the
			// same staging identity and share the outer acquisition delay budget.
			retainPendingStagingCleanup(lockPath, cleanupPath, identity, error);
			retryBudget.remainingDelays--;
			try {
				await sleepFileLockRetry(retryBudget.retryDelayMs, retryBudget.signal);
			} catch (abortError) {
				if (!retryBudget.signal?.aborted) throw abortError;
				await abortStagingCleanup(lockPath, cleanupPath, identity, retryBudget.signal);
			}
		}
	}
}

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
			env: { ...projectSafeSpawnEnv(), LC_ALL: "C", LANG: "C", TZ: "UTC" },
		});
		if (result.exitCode !== 0) return null;
		const startTime = new TextDecoder().decode(result.stdout).trim();
		return startTime || null;
	} catch {
		return null;
	}
}

let ownProcessStartTime: string | undefined;
let ownProcessIncarnation: string | null | undefined;

function currentProcessStartTime(): string {
	if (ownProcessStartTime === undefined) ownProcessStartTime = processStartTime(process.pid) ?? "unknown";
	return ownProcessStartTime;
}

function nativeProcessIncarnation(pid: number): string | null {
	try {
		const incarnation = nativeProcessBindings().Process.fromPid(pid)?.incarnation;
		return typeof incarnation === "string" && incarnation.length > 0 ? incarnation : null;
	} catch {
		return null;
	}
}

function processIncarnation(pid: number): string | null {
	try {
		const testHook = FileLockTestHooks.processIncarnation;
		return testHook ? testHook(pid) : nativeProcessIncarnation(pid);
	} catch {
		return null;
	}
}

function currentProcessIncarnation(): string | null {
	if (ownProcessIncarnation === undefined) ownProcessIncarnation = nativeProcessIncarnation(process.pid);
	return ownProcessIncarnation;
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
	if (owner.process_incarnation) {
		const currentIncarnation = processIncarnation(owner.pid);
		return currentIncarnation === null || currentIncarnation === owner.process_incarnation;
	}
	if (!owner.start_time || owner.start_time === "unknown") return true;
	const currentStartTime = cachedProcessStartTime(owner, startTimeCache);
	if (currentStartTime === null || currentStartTime === owner.start_time) return true;
	// A start-time mismatch proves PID reuse only for records that identify the
	// canonical UTC encoding. Legacy records did not identify their timestamp format,
	// so a locale/timezone change can make a live holder look different and must never
	// authorize its removal.
	return owner.start_time_format !== PROCESS_START_TIME_FORMAT;
}

function ownerIdentityIsProven(owner: FileLockOwnerToken): boolean {
	if (owner.process_incarnation) {
		const currentIncarnation = processIncarnation(owner.pid);
		if (currentIncarnation !== null) return currentIncarnation === owner.process_incarnation;
	}
	if (owner.start_time_format !== PROCESS_START_TIME_FORMAT || !owner.start_time || owner.start_time === "unknown")
		return false;
	const currentStartTime = cachedProcessStartTime(owner);
	return currentStartTime !== null && currentStartTime === owner.start_time;
}

function lockInfo(ownerHostId: string | undefined, ownerToken: string): LockInfo {
	const incarnation = currentProcessIncarnation();
	return {
		pid: process.pid,
		start_time: currentProcessStartTime(),
		start_time_format: PROCESS_START_TIME_FORMAT,
		...(incarnation === null ? {} : { process_incarnation: incarnation }),
		timestamp: Date.now(),
		owner_token: ownerToken,
		...(ownerHostId === undefined ? {} : { owner_host_id: ownerHostId }),
	};
}

async function writeLockInfo(
	lockPath: string,
	info: LockInfo,
	retryBudget: FileLockAcquisitionRetryBudget,
	onFileCreated: (identity: FileLockStagingFileIdentity) => void,
): Promise<LockInfo> {
	// Owner metadata must stay readable by its own process under a restrictive
	// umask: release re-reads this record to authorize removal, and an info file
	// born mode 000 under umask 0777 would wedge the lock at first release.
	// Keep the created file's identity through setup so an early cleanup can reject
	// a same-name replacement instead of treating a later tree snapshot as authority.
	const handle = await fs.open(`${lockPath}/info`, "wx", 0o600);
	try {
		let identity: FileLockStagingFileIdentity;
		try {
			for (;;) {
				try {
					const captureIdentity = async (): Promise<FileLockStagingFileIdentity> => {
						const stats = await handle.stat({ bigint: true });
						return {
							dev: canonicalLockDeviceId(stats.dev).toString(),
							ino: canonicalLockFileId(stats.ino).toString(),
						};
					};
					const testCaptureIdentity = FileLockTestHooks.stagingInfoIdentity;
					identity = testCaptureIdentity
						? await testCaptureIdentity(`${lockPath}/info`, captureIdentity)
						: await captureIdentity();
					break;
				} catch (error) {
					if (!isTransientReleaseError(error) || retryBudget.remainingDelays === 0) throw error;
					retryBudget.remainingDelays--;
					await sleepFileLockRetry(retryBudget.retryDelayMs, retryBudget.signal);
				}
			}
		} catch (error) {
			// Without the handle's inode identity, retaining this empty info entry would
			// make both immediate cleanup and the later orphan reaper fail closed.
			try {
				const infoPath = `${lockPath}/info`;
				const quarantineName = `${path.basename(infoPath)}.cleanup.${crypto.randomUUID()}`;
				const cleanup = await (FileLockTestHooks.stagingInfoCleanup
					? FileLockTestHooks.stagingInfoCleanup(infoPath, handle.fd, quarantineName)
					: exactUnlinkOpenFile(infoPath, handle.fd, quarantineName));
				if (!cleanup.ok && cleanup.code !== "not_found")
					throw Object.assign(
						new Error(`Identity-bound cleanup of staged file-lock info failed: ${cleanup.code ?? "unknown"}.`),
						{ code: cleanup.code ?? "identity_unavailable" },
					);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Failed to remove staged file-lock info after identity capture failed at ${lockPath}.`,
				);
			}
			throw error;
		}
		onFileCreated(identity);
		await handle.writeFile(JSON.stringify(info));
		await handle.chmod(0o600);
		return info;
	} finally {
		await handle.close();
	}
}

type LockInfoFileState = {
	dev: bigint;
	ino: bigint;
	mode: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	birthtimeNs: bigint;
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

/** Bun/libuv may expose Windows file IDs as i64; native snapshots use u64. */
function canonicalLockFileId(value: bigint): bigint {
	if (value < -(1n << 63n) || value > (1n << 64n) - 1n) throw new Error("file_lock_identity_out_of_range");
	return BigInt.asUintN(64, value);
}

/** Windows volume serials are u32 even when Bun returns a signed `stat.dev`. */
function canonicalLockDeviceId(value: bigint): bigint {
	if (process.platform !== "win32") return canonicalLockFileId(value);
	if (value < -(1n << 31n) || value > (1n << 32n) - 1n) throw new Error("file_lock_identity_out_of_range");
	return BigInt.asUintN(32, value);
}

function lockInfoFileState(stats: BigIntStats): LockInfoFileState | null {
	if (stats.isSymbolicLink() || !stats.isFile()) return null;
	// Some supported filesystems report creation time as missing or epoch zero. Keep
	// the stable dev/inode identity and content evidence usable instead of wedging
	// acquire/release/GC on a metadata field the filesystem cannot provide.
	const birthtimeNs = typeof stats.birthtimeNs === "bigint" && stats.birthtimeNs > 0n ? stats.birthtimeNs : 0n;
	return {
		dev: canonicalLockDeviceId(stats.dev),
		ino: canonicalLockFileId(stats.ino),
		mode: stats.mode,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
		birthtimeNs,
		nlink: stats.nlink,
	};
}

function sameLockInfoFileState(left: LockInfoFileState, right: LockInfoFileState): boolean {
	const birthtimeMatches =
		left.birthtimeNs === 0n || right.birthtimeNs === 0n || left.birthtimeNs === right.birthtimeNs;
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		birthtimeMatches &&
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
		root: { dev: canonicalLockDeviceId(root.dev), ino: canonicalLockFileId(root.ino), mode: root.mode },
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
		rootDev: canonicalLockDeviceId(state.root.dev).toString(),
		rootIno: canonicalLockFileId(state.root.ino).toString(),
		infoDev: canonicalLockDeviceId(state.file.dev).toString(),
		infoIno: canonicalLockFileId(state.file.ino).toString(),
		infoNlink: String(state.file.nlink),
		infoSize: String(state.file.size),
		infoMtimeNs: String(state.file.mtimeNs),
		infoCtimeNs: String(state.file.ctimeNs),
		infoBirthtimeNs: String(state.file.birthtimeNs),
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
	const { pid, start_time, start_time_format, process_incarnation, timestamp, owner_host_id, owner_token } =
		parsed as Partial<LockInfo>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time)) ||
		(start_time_format !== undefined && (typeof start_time_format !== "string" || !start_time_format)) ||
		(process_incarnation !== undefined && (typeof process_incarnation !== "string" || !process_incarnation)) ||
		(owner_host_id !== undefined && (typeof owner_host_id !== "string" || !owner_host_id)) ||
		(owner_token !== undefined && (typeof owner_token !== "string" || !owner_token))
	)
		return null;
	return { pid, start_time, start_time_format, process_incarnation, timestamp, owner_host_id, owner_token };
}

function parseLockInfoBytes(bytes: string): LockInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { pid, start_time, start_time_format, process_incarnation, timestamp, owner_host_id, owner_token } =
		parsed as Partial<LockInfo>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time)) ||
		(start_time_format !== undefined && (typeof start_time_format !== "string" || !start_time_format)) ||
		(process_incarnation !== undefined && (typeof process_incarnation !== "string" || !process_incarnation)) ||
		(owner_host_id !== undefined && (typeof owner_host_id !== "string" || !owner_host_id)) ||
		(owner_token !== undefined && (typeof owner_token !== "string" || !owner_token))
	)
		return null;
	return { pid, start_time, start_time_format, process_incarnation, timestamp, owner_host_id, owner_token };
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
	/** Kernel-derived identity for the exact process generation owning `pid`. */
	process_incarnation?: string;
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
const pendingDetachedLockCleanups = new WeakMap<
	object,
	{ path: string; rootDev: string; rootIno: string; snapshot: NativeDirectoryTreeSnapshot }
>();

/**
 * Complete a detached lock quarantine without the native exact-removal primitive.
 * The tree was already retired through a handle-bound no-replace detach, so the
 * parked root identity is re-verified immediately before the filesystem removes
 * it; an identity mismatch leaves the quarantine untouched for a later attempt.
 * Returns true when the quarantine is gone (or was already absent).
 */
async function removeDetachedLockQuarantineOnDisk(
	detachedPath: string,
	rootDev: string,
	rootIno: string,
): Promise<boolean> {
	let current: BigIntStats;
	try {
		current = await fs.lstat(detachedPath, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return true;
		throw error;
	}
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		canonicalLockDeviceId(current.dev).toString() !== rootDev ||
		canonicalLockFileId(current.ino).toString() !== rootIno
	) {
		return false;
	}
	if ((await FileLockTestHooks.beforeDetachedLockCleanup?.(detachedPath)) === false) return false;
	await fs.rm(detachedPath, { recursive: true, force: true });
	return true;
}

function markLocalRemovalResumable(transitionPath: string, rootDev: string, rootIno: string): void {
	const recordPath = removalRecordPath(transitionPath);
	const local = localRemovalRecords.get(recordPath);
	if (!local) return;
	try {
		const record = JSON.parse(local.bytes) as Partial<RemovalTransitionOwnerRecord>;
		if (record.rootDev === rootDev && record.rootIno === rootIno)
			localRemovalRecords.set(recordPath, { ...local, resumable: true });
	} catch {
		// A malformed local receipt cannot authorize resuming a detached tree.
	}
}

async function finishDetachedLockCleanup(owner: FileLockOwnerToken): Promise<boolean> {
	const pending = pendingDetachedLockCleanups.get(owner);
	if (!pending) return false;
	try {
		const current = await fs.lstat(pending.path, { bigint: true });
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			canonicalLockDeviceId(current.dev).toString() !== pending.rootDev ||
			canonicalLockFileId(current.ino).toString() !== pending.rootIno
		) {
			throw new Error("Detached file lock cleanup identity changed; refusing removal");
		}
		// The native replay only exists where the native exact-removal primitive is
		// usable. A host whose minifilter rejects that primitive would otherwise never
		// finish the quarantine its own fallback created, so finish on disk instead.
		if (process.platform === "win32" && (await isNativeExactRemovalUsable())) {
			const removal = nativeFileLockBindings().exactRemoveDirectoryTree(pending.path, pending.snapshot);
			if (removal.code === "cleanup_pending" || (!removal.ok && isTransientReleaseError(removal))) return false;
			if (!removal.ok && removal.code !== "not_found")
				throw new Error(`Failed to finish detached file lock cleanup: ${removal.code ?? "unknown"}.`);
		} else {
			await fs.rm(pending.path, { recursive: true, force: true });
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	pendingDetachedLockCleanups.delete(owner);
	await clearRemovalRecord(pending.path);
	return true;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function fileLockRemovalTransitionPath(lockPath: string): string {
	return derivedFileLockPath(lockPath, ".removing");
}

/** Keep derived siblings bounded without changing the canonical lock identity. */
function derivedFileLockPath(sourcePath: string, suffix: string): string {
	const name = path.basename(sourcePath);
	const derived = `${name}${suffix}`;
	const bounded =
		Buffer.byteLength(derived, "utf8") <= 255
			? derived
			: `.gjc-lock-${crypto.createHash("sha256").update(name).digest("hex")}${suffix}`;
	return path.join(path.dirname(sourcePath), bounded);
}

function removalRecordPath(transitionPath: string): string {
	return derivedFileLockPath(transitionPath, ".owner");
}

type RemovalTransitionOwnerRecord = {
	owner: FileLockOwnerToken;
	rootDev: string;
	rootIno: string;
};

type LocalRemovalRecord = { bytes: string; resumable: boolean; inFlight: boolean };

const localRemovalRecords = new Map<string, LocalRemovalRecord>();

function sameRemovalRecordBytes(left: string, right: string): boolean {
	try {
		const a = JSON.parse(left) as RemovalTransitionOwnerRecord;
		const b = JSON.parse(right) as RemovalTransitionOwnerRecord;
		const aOwner = parseLockInfoBytes(JSON.stringify(a.owner));
		const bOwner = parseLockInfoBytes(JSON.stringify(b.owner));
		return (
			aOwner !== null &&
			bOwner !== null &&
			a.rootDev === b.rootDev &&
			a.rootIno === b.rootIno &&
			JSON.stringify(aOwner) === JSON.stringify(bOwner)
		);
	} catch {
		return false;
	}
}

function isResumableLocalRemoval(transitionPath: string, record: RemovalTransitionOwnerRecord): boolean {
	const local = localRemovalRecords.get(removalRecordPath(transitionPath));
	return local?.resumable === true && !local.inFlight && sameRemovalRecordBytes(local.bytes, JSON.stringify(record));
}

function isLocalRemovalInFlight(transitionPath: string, record: RemovalTransitionOwnerRecord): boolean {
	const local = localRemovalRecords.get(removalRecordPath(transitionPath));
	return local?.inFlight === true && sameRemovalRecordBytes(local.bytes, JSON.stringify(record));
}

function markLocalRemovalCompleted(transitionPath: string, expectedBytes?: string): void {
	const recordPath = removalRecordPath(transitionPath);
	const local = localRemovalRecords.get(recordPath);
	if (!local?.inFlight || (expectedBytes !== undefined && !sameRemovalRecordBytes(local.bytes, expectedBytes))) return;
	localRemovalRecords.set(recordPath, { ...local, inFlight: false });
}

async function readBoundedRemovalRecordBytes(recordPath: string): Promise<Buffer | null> {
	const bytes = Buffer.from(
		await Bun.file(recordPath)
			.slice(0, MAX_FILE_LOCK_REMOVAL_RECORD_BYTES + 1)
			.arrayBuffer(),
	);
	return bytes.length > MAX_FILE_LOCK_REMOVAL_RECORD_BYTES ? null : bytes;
}

type FileLockRemovalTransitionState = "active" | "abandoned" | "orphan_transition";
type FileLockOrphanTransition = { kind: "orphan_transition"; path: string };
type FileLockPublicationRetry = { kind: "publication_retry"; code: FileLockPublicationFailureCode };
type FileLockAcquisitionResult = LockInfo | FileLockOrphanTransition | FileLockPublicationRetry | null;

async function readRemovalTransitionOwnerRecord(transitionPath: string): Promise<RemovalTransitionOwnerRecord | null> {
	try {
		const recordPath = removalRecordPath(transitionPath);
		const stat = await fs.lstat(recordPath, { bigint: true });
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1n ||
			stat.size > BigInt(MAX_FILE_LOCK_REMOVAL_RECORD_BYTES)
		)
			return null;
		const bytes = await readBoundedRemovalRecordBytes(recordPath);
		if (!bytes) return null;
		const record = JSON.parse(bytes.toString("utf8")) as RemovalTransitionOwnerRecord;
		const owner = parseLockInfoBytes(JSON.stringify(record.owner));
		return owner && typeof record.rootDev === "string" && typeof record.rootIno === "string"
			? { owner, rootDev: record.rootDev, rootIno: record.rootIno }
			: null;
	} catch (error) {
		if (isEnoent(error)) return null;
		logger.debug("Failed to read removal transition owner record", { error });
		return null;
	}
}

async function classifyFileLockRemovalTransition(
	lockPath: string,
	orphanAgeMs: number,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
): Promise<FileLockRemovalTransitionState | null> {
	const transitionPath = fileLockRemovalTransitionPath(lockPath);
	let transition: BigIntStats;
	try {
		transition = await fs.lstat(transitionPath, { bigint: true });
		if (!transition.isDirectory() || transition.isSymbolicLink()) return "active";
	} catch (error) {
		if (isEnoent(error)) {
			await FileLockTestHooks.afterRemovalTransitionMissing?.(transitionPath);
			const recordPath = removalRecordPath(transitionPath);
			const recordedOwner = await readRemovalTransitionOwnerRecord(transitionPath);
			if (!recordedOwner) {
				try {
					await fs.lstat(recordPath);
					return "active";
				} catch (recordError) {
					return isEnoent(recordError) ? null : "active";
				}
			}
			const localRecord = localRemovalRecords.get(recordPath);
			if (localRecord && sameRemovalRecordBytes(localRecord.bytes, JSON.stringify(recordedOwner))) {
				if (localRecord.inFlight) return "active";
				if (!(await clearCompletedLocalRemovalRecord(lockPath, transitionPath, recordedOwner, localRecord)))
					return "active";
				return null;
			}
			if (lockRecordIsForeignHost(recordedOwner.owner, ownerHostId, previousOwnerHostIds)) {
				// Never probe a foreign PID. Absence of both captured names proves
				// retirement completed, rather than a live remover awaiting detach.
				return (await clearCompletedForeignRemovalRecord(lockPath, transitionPath, recordedOwner))
					? null
					: "active";
			}
			// Another same-host process may have completed native removal but been
			// unable to unlink its receipt. Prove the captured generation is absent
			// before treating its still-live publisher PID as an active retirement.
			if (await removalTransitionIsComplete(lockPath, transitionPath, recordedOwner))
				return (await removeRemovalRecord(recordPath, JSON.stringify(recordedOwner))) ? null : "active";
			if (ownerIsAlive(recordedOwner.owner) || ownerLiveness(recordedOwner.owner.pid) === "unknown") return "active";
			return (await removeRemovalRecord(recordPath, JSON.stringify(recordedOwner))) ? null : "active";
		}
		throw error;
	}

	// A sibling record survives rename and scrub without mutating the captured tree.
	const recordedOwner = await readRemovalTransitionOwnerRecord(transitionPath);
	if (recordedOwner) {
		if (
			await retainedRemovalRecordIsForeignHost(
				transitionPath,
				recordedOwner.owner,
				orphanAgeMs,
				ownerHostId,
				previousOwnerHostIds,
			)
		)
			return "active";
		if (
			canonicalLockDeviceId(transition.dev).toString() !== recordedOwner.rootDev ||
			canonicalLockFileId(transition.ino).toString() !== recordedOwner.rootIno
		)
			return "active";
		if (isLocalRemovalInFlight(transitionPath, recordedOwner)) return "active";
		if (isResumableLocalRemoval(transitionPath, recordedOwner)) return "orphan_transition"; // The remover itself may resume its own interrupted cleanup.
		return ownerIsAlive(recordedOwner.owner) || ownerLiveness(recordedOwner.owner.pid) === "unknown"
			? "active"
			: "orphan_transition";
	}
	try {
		await fs.lstat(removalRecordPath(transitionPath));
		return "active";
	} catch (error) {
		if (!isEnoent(error)) return "active";
	}

	const observation = await readLockInfoObservation(transitionPath);
	if (!observation) {
		try {
			if (Date.now() - Number(transition.mtimeMs) >= orphanAgeMs && (await fs.readdir(transitionPath)).length === 0)
				return "orphan_transition";
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
		return "active";
	}
	const info = parseLockInfoBytes(observation.bytes);
	if (info) {
		const stale = await staleLockSnapshot(transitionPath, 0, ownerHostId, previousOwnerHostIds, undefined, true);
		return stale.stale ? "abandoned" : "active";
	}

	const infoAgeMs = Date.now() - Number(observation.state.file.mtimeNs / 1_000_000n);
	return Number.isFinite(infoAgeMs) && infoAgeMs >= orphanAgeMs ? "orphan_transition" : "active";
}

function isFileLockOrphanTransition(value: FileLockAcquisitionResult): value is FileLockOrphanTransition {
	return value !== null && "kind" in value && value.kind === "orphan_transition";
}

function isFileLockPublicationRetry(value: FileLockAcquisitionResult): value is FileLockPublicationRetry {
	return value !== null && "kind" in value && value.kind === "publication_retry";
}

/** Without an owner, only an aged, completely empty directory is reclaimable. */
function isEmptyRemovalTransition(snapshot: NativeDirectoryTreeSnapshot, graceMs: number): boolean {
	const root = snapshot.entries[0];
	if (snapshot.entries.length !== 1 || root?.relativePath !== "" || root.kind !== "directory") return false;
	const ageMs = Date.now() - Number(root.mtimeNs) / 1_000_000;
	return Number.isFinite(ageMs) && ageMs >= graceMs;
}

async function removeRemovalRecord(recordPath: string, expectedBytes: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(recordPath, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_FILE_LOCK_REMOVAL_RECORD_BYTES))
			return false;
		const bytes = await readBoundedRemovalRecordBytes(recordPath);
		if (!bytes || !sameRemovalRecordBytes(bytes.toString("utf8"), expectedBytes)) return false;
		if ((await FileLockTestHooks.beforeRemovalRecordUnlink?.(recordPath)) === false) return false;
		return exactUnlinkDirect(recordPath, {
			dev: canonicalLockDeviceId(stat.dev),
			ino: canonicalLockFileId(stat.ino),
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			nlink: stat.nlink,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
			quarantineName: path.basename(
				derivedFileLockPath(recordPath, `.retired.${crypto.randomBytes(12).toString("base64url")}`),
			),
		}).ok;
	} catch (error) {
		if (isEnoent(error)) return true;
		throw error;
	}
}

async function clearRemovalRecord(transitionPath: string): Promise<void> {
	const recordPath = removalRecordPath(transitionPath);
	const local = localRemovalRecords.get(recordPath);
	if (!local || local.inFlight) return;
	const bytes = local.bytes;
	try {
		const transition = await fs.lstat(transitionPath, { bigint: true });
		const recorded = JSON.parse(bytes) as Partial<RemovalTransitionOwnerRecord>;
		if (
			transition.isDirectory() &&
			typeof recorded.rootDev === "string" &&
			typeof recorded.rootIno === "string" &&
			canonicalLockDeviceId(transition.dev).toString() === recorded.rootDev &&
			canonicalLockFileId(transition.ino).toString() === recorded.rootIno
		)
			return;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (await removeRemovalRecord(recordPath, bytes)) localRemovalRecords.delete(recordPath);
}

async function removalTransitionIsComplete(
	lockPath: string,
	transitionPath: string,
	record: RemovalTransitionOwnerRecord,
	afterTransitionMissing?: (transitionPath: string) => void | Promise<void>,
): Promise<boolean> {
	try {
		await fs.lstat(transitionPath);
		return false;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	await afterTransitionMissing?.(transitionPath);
	try {
		const canonical = await fs.lstat(lockPath, { bigint: true });
		if (
			canonicalLockDeviceId(canonical.dev).toString() === record.rootDev &&
			canonicalLockFileId(canonical.ino).toString() === record.rootIno
		)
			return false;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	try {
		await fs.lstat(transitionPath);
		return false;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return true;
}

async function clearCompletedLocalRemovalRecord(
	lockPath: string,
	transitionPath: string,
	record: RemovalTransitionOwnerRecord,
	localRecord: LocalRemovalRecord,
): Promise<boolean> {
	const recordPath = removalRecordPath(transitionPath);
	const current = localRemovalRecords.get(recordPath);
	if (
		current !== localRecord ||
		current.inFlight ||
		!(await removalTransitionIsComplete(lockPath, transitionPath, record))
	)
		return false;
	const latest = localRemovalRecords.get(recordPath);
	if (
		!latest ||
		latest.inFlight ||
		!sameRemovalRecordBytes(latest.bytes, localRecord.bytes) ||
		!(await removeRemovalRecord(recordPath, localRecord.bytes))
	)
		return false;
	const afterRemoval = localRemovalRecords.get(recordPath);
	if (afterRemoval?.inFlight || (afterRemoval && !sameRemovalRecordBytes(afterRemoval.bytes, localRecord.bytes)))
		return false;
	if (afterRemoval) localRemovalRecords.delete(recordPath);
	return true;
}

async function clearCompletedForeignRemovalRecord(
	lockPath: string,
	transitionPath: string,
	record: RemovalTransitionOwnerRecord,
): Promise<boolean> {
	if (
		!(await removalTransitionIsComplete(
			lockPath,
			transitionPath,
			record,
			FileLockTestHooks.afterForeignTransitionMissing,
		))
	)
		return false;
	return removeRemovalRecord(removalRecordPath(transitionPath), JSON.stringify(record));
}

async function publishRemovalRecord(
	transitionPath: string,
	snapshot: NativeDirectoryTreeSnapshot,
	ownerHostId?: string,
	resumable = false,
): Promise<boolean> {
	const recordPath = removalRecordPath(transitionPath);
	// A pre-detach refusal can leave a completed local receipt whose exact
	// unlink was temporarily refused. Release itself must retry that cleanup.
	await clearRemovalRecord(transitionPath);
	if (localRemovalRecords.has(recordPath)) return false;
	const bytes = JSON.stringify({
		owner: lockInfo(ownerHostId, crypto.randomUUID()),
		rootDev: snapshot.rootDev,
		rootIno: snapshot.rootIno,
	});
	if (Buffer.byteLength(bytes, "utf8") > MAX_FILE_LOCK_REMOVAL_RECORD_BYTES) return false;
	const staged = derivedFileLockPath(recordPath, `.${process.pid}.${crypto.randomBytes(12).toString("base64url")}`);
	await Bun.write(staged, bytes, { mode: 0o600 });
	let publishedLocally = false;
	try {
		await fs.chmod(staged, 0o600);
		await FileLockTestHooks.beforeRemovalOwnerPublish?.(transitionPath);
		const published = await renameNoReplacePathAsync(staged, recordPath);
		if (published.ok) {
			localRemovalRecords.set(recordPath, { bytes, resumable, inFlight: true });
			publishedLocally = true;
		}
	} catch (error) {
		if (publishedLocally) markLocalRemovalCompleted(transitionPath, bytes);
		await fs.rm(staged, { force: true }).catch(() => undefined);
		throw error;
	}
	try {
		await fs.rm(staged, { force: true });
	} catch (error) {
		if (publishedLocally) markLocalRemovalCompleted(transitionPath, bytes);
		throw error;
	}
	return publishedLocally;
}

/** Publish outside the captured tree, atomically and before native rename. */
async function exactRemoveLockTree(
	lockPath: string,
	snapshot: NativeDirectoryTreeSnapshot,
	ownerHostId?: string,
	parentIdentity?: { dev: bigint; ino: bigint },
	detachOnly?: boolean,
): Promise<NativeExactUnlinkResult> {
	if (lockPath.endsWith(".removing"))
		return nativeFileLockBindings().exactRemoveDirectoryTree(lockPath, snapshot, parentIdentity, detachOnly);
	const transitionPath = fileLockRemovalTransitionPath(lockPath);
	if (process.platform === "win32") {
		try {
			await fs.lstat(transitionPath);
			// Native removal can resume this generation when the canonical name is
			// already detached. A different generation at `.removing` is left for
			// acquisition-time adoption; never attach this owner record to it.
			try {
				await fs.lstat(lockPath);
				return { ok: false, code: "quarantine_collision" };
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			return nativeFileLockBindings().exactRemoveDirectoryTree(lockPath, snapshot, parentIdentity, detachOnly);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	const recordPath = removalRecordPath(transitionPath);
	const prior = await readRemovalTransitionOwnerRecord(transitionPath);
	if (prior && lockRecordIsForeignHost(prior.owner, ownerHostId, [])) {
		if (!(await clearCompletedForeignRemovalRecord(lockPath, transitionPath, prior)))
			return { ok: false, code: "removal_record_busy" };
	} else if (prior && !ownerIsAlive(prior.owner) && ownerLiveness(prior.owner.pid) !== "unknown") {
		try {
			await fs.lstat(transitionPath);
			return { ok: false, code: "identity_mismatch" };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (!(await removeRemovalRecord(recordPath, JSON.stringify(prior))))
			return { ok: false, code: "identity_mismatch" };
	}
	// A live remover still owns the sibling record, usually the previous lock
	// generation whose tree is gone but whose record clear is still in flight.
	// That is contention, not a changed owner: identity_mismatch makes a release
	// final and strands this live owner's lock for every other process.
	if (!(await publishRemovalRecord(transitionPath, snapshot, ownerHostId)))
		return { ok: false, code: "removal_record_busy" };
	const publishedRecordBytes = localRemovalRecords.get(recordPath)?.bytes;
	try {
		await FileLockTestHooks.afterRemovalOwnerPublish?.(transitionPath);
		const bindings = nativeFileLockBindings();
		if (process.platform === "win32" && !detachOnly) {
			const detached = bindings.exactRemoveDirectoryTree(lockPath, snapshot, parentIdentity, true);
			if (!detached.ok) return detached;
			if (
				detached.code !== undefined ||
				detached.detachedPath !== transitionPath ||
				Object.keys(detached).some(key => key !== "ok" && key !== "detachedPath")
			)
				return { ok: false, code: "identity_mismatch", detachedPath: detached.detachedPath };
			try {
				const removeResult = bindings.exactRemoveDirectoryTree(transitionPath, snapshot, parentIdentity);
				// Handle returned transient failures (not thrown exceptions):
				// when native pre-open fails with e.g. sharing_violation, the result
				// is returned without detachedPath. Mark the receipt resumable before
				// returning so that in-process retry or cleanup can complete the removal.
				if (!removeResult.ok && isResultTransientFailure(removeResult)) {
					markLocalRemovalResumable(transitionPath, snapshot.rootDev, snapshot.rootIno);
					// Transitionpath was successfully detached; include it in the result
					// so cleanup can continue in-process or by a later invocation.
					return { ...removeResult, detachedPath: transitionPath };
				}
				return removeResult;
			} catch (error) {
				// Also handle thrown errors (if implementation changes in future)
				if (isTransientReleaseError(error))
					markLocalRemovalResumable(transitionPath, snapshot.rootDev, snapshot.rootIno);
				throw error;
			}
		}
		return bindings.exactRemoveDirectoryTree(lockPath, snapshot, parentIdentity, detachOnly);
	} finally {
		markLocalRemovalCompleted(transitionPath, publishedRecordBytes);
		await clearRemovalRecord(transitionPath);
	}
}

/**
 * Adopt-and-finish a provably orphaned removal transition.
 *
 * The prepublished sibling carries the remover's process generation and the
 * captured root identity until cleanup finishes. A dead remover permits replay
 * even when death preceded payload scrub. Without that evidence only an aged
 * empty root is safe: zero-byte files alone do not prove abandonment. Native
 * identity verification and the durable-scrub receipt still govern completion.
 */
async function adoptOrphanedFileLockRemovalTransition(
	lockPath: string,
	orphanAgeMs: number,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
): Promise<boolean | "retry"> {
	const transitionPath = fileLockRemovalTransitionPath(lockPath);
	const recordedOwner = await readRemovalTransitionOwnerRecord(transitionPath);
	if (recordedOwner && ownerIsAlive(recordedOwner.owner) && !isResumableLocalRemoval(transitionPath, recordedOwner))
		return false;
	// Re-validate at the moment of adoption: a successor that published a parsed
	// owner or replaced the tree must never inherit an earlier orphan verdict.
	if (
		(await classifyFileLockRemovalTransition(lockPath, orphanAgeMs, ownerHostId, previousOwnerHostIds)) !==
		"orphan_transition"
	)
		return false;
	const captured = snapshotDirectoryTree(transitionPath);
	if (!captured.ok || !captured.snapshot) return false;
	const snapshot = captured.snapshot;
	if (!recordedOwner && !isEmptyRemovalTransition(snapshot, orphanAgeMs)) return false;
	if (recordedOwner && (snapshot.rootDev !== recordedOwner.rootDev || snapshot.rootIno !== recordedOwner.rootIno))
		return false;
	const recordPath = removalRecordPath(transitionPath);
	// Claim an ownerless generation without replacing any live publisher's record.
	// The snapshot binds both the grace verdict and subsequent native removal.
	if (recordedOwner) {
		const current = localRemovalRecords.get(recordPath);
		if (current?.inFlight) return false;
		localRemovalRecords.set(recordPath, {
			bytes: JSON.stringify(recordedOwner),
			resumable: true,
			inFlight: true,
		});
	} else if (!(await publishRemovalRecord(transitionPath, snapshot, ownerHostId, true))) {
		return false;
	}
	const removalRecordBytes = localRemovalRecords.get(recordPath)?.bytes;
	if (!removalRecordBytes) return false;
	const finish = async (): Promise<boolean> => {
		markLocalRemovalCompleted(transitionPath, removalRecordBytes);
		await clearRemovalRecord(transitionPath);
		logger.info(`file lock: reaped 1 stale lock artifact (${transitionPath})`);
		return true;
	};
	try {
		let removal: NativeExactUnlinkResult;
		try {
			removal = nativeFileLockBindings().exactRemoveDirectoryTree(transitionPath, snapshot);
		} catch (error) {
			if (isTransientReleaseError(error)) return "retry";
			throw error;
		}
		if (!removal.ok && isTransientReleaseError(removal)) return "retry";
		if (removal.ok === true) {
			return removal.code === undefined && Object.keys(removal).every(key => key === "ok") && (await finish());
		}
		if (
			removal.ok === false &&
			removal.code === "not_found" &&
			Object.keys(removal).every(key => key === "ok" || key === "code")
		)
			return await finish();
		// POSIX cannot bind a namespace unlink to the verified descriptor, so the
		// primitive retains the scrubbed tree under its deterministic name and the
		// caller finishes the on-disk removal. Finish only the exact tree this call
		// scrubbed; a retained successor/placeholder/unknown path is refused so a
		// replacement is never deleted.
		if (
			removal.ok === false &&
			removal.code === "cleanup_pending" &&
			removal.payloadDurable === true &&
			removal.detachedPath !== undefined &&
			path.resolve(removal.detachedPath) === path.resolve(transitionPath) &&
			removal.retainedSuccessorPath === undefined &&
			removal.retainedPlaceholderPath === undefined &&
			removal.retainedUnknownPath === undefined &&
			Object.keys(removal).every(key => ["ok", "code", "payloadDurable", "detachedPath"].includes(key))
		) {
			try {
				const finished = await removeDetachedLockQuarantineOnDisk(
					transitionPath,
					snapshot.rootDev,
					snapshot.rootIno,
				);
				return finished && (await finish());
			} catch (error) {
				if (isTransientReleaseError(error)) return "retry";
				throw error;
			}
		}
		return false;
	} finally {
		markLocalRemovalCompleted(transitionPath, removalRecordBytes);
	}
}

/**
 * Whether an abandoned transition's captured tree is safe to adopt: the root is
 * the transition directory, `info` is the only file, and every other entry is a
 * directory or an empty file. Any other payload means adoption refuses the
 * generation, so it must be reported as a block instead of a silent retry.
 */
function abandonedTransitionPayloadIsAdoptable(snapshot: NativeDirectoryTreeSnapshot): boolean {
	const root = snapshot.entries.find(entry => entry.relativePath === "");
	const infoEntry = snapshot.entries.find(entry => entry.relativePath === "info");
	return (
		root?.kind === "directory" &&
		infoEntry?.kind === "file" &&
		!snapshot.entries.some(
			entry =>
				entry.relativePath !== "" &&
				entry.relativePath !== "info" &&
				entry.kind !== "directory" &&
				(entry.kind !== "file" || entry.size !== "0"),
		)
	);
}

async function adoptAbandonedFileLockRemovalTransition(
	lockPath: string,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
): Promise<boolean> {
	const transitionPath = fileLockRemovalTransitionPath(lockPath);
	const recordedOwner = await readRemovalTransitionOwnerRecord(transitionPath);
	if (recordedOwner) return false; // The sibling-owner adoption path owns this generation.
	const stale = await staleLockSnapshot(transitionPath, 0, ownerHostId, previousOwnerHostIds, undefined, true);
	if (!stale.stale || !stale.identity) return false;
	if (!(await isNativeExactRemovalUsable())) return false;

	let captured: NativeDirectoryTreeResult;
	try {
		captured = nativeFileLockBindings().snapshotDirectoryTree(transitionPath);
	} catch (error) {
		if (isTransientReleaseError(error)) return false;
		throw error;
	}
	if (!captured.ok || !captured.snapshot) return false;
	const snapshot = captured.snapshot;
	if (!abandonedTransitionPayloadIsAdoptable(snapshot)) return false;
	const infoEntry = snapshot.entries.find(entry => entry.relativePath === "info");
	if (infoEntry?.kind !== "file") return false;
	const currentIdentity = await captureFileLockDirIdentity(transitionPath);
	if (!currentIdentity || !sameStableFileLockIdentity(currentIdentity, stale.identity)) return false;
	if (
		!nativeFileLockInfoMatchesStableIdentity(snapshot.rootDev, snapshot.rootIno, infoEntry, stale.identity) ||
		!nativeFileLockInfoMatchesContentEvidence(infoEntry, stale.identity)
	)
		return false;
	// Legacy info proves the old owner dead, but native scrub destroys that info.
	// Commit this remover's sibling identity before allowing any payload mutation.
	if (!(await publishRemovalRecord(transitionPath, snapshot, ownerHostId, true))) return false;
	const publishedRecordBytes = localRemovalRecords.get(removalRecordPath(transitionPath))?.bytes;
	if (!publishedRecordBytes) return false;
	try {
		let removal: NativeExactUnlinkResult;
		try {
			removal = nativeFileLockBindings().exactRemoveDirectoryTree(transitionPath, snapshot);
		} catch (error) {
			if (isTransientReleaseError(error)) return false;
			throw error;
		}
		let finished =
			removal.ok === true && removal.code === undefined && Object.keys(removal).every(key => key === "ok");
		if (
			removal.ok === false &&
			removal.code === "cleanup_pending" &&
			removal.payloadDurable === true &&
			removal.detachedPath !== undefined &&
			path.resolve(removal.detachedPath) === path.resolve(transitionPath) &&
			removal.retainedSuccessorPath === undefined &&
			removal.retainedPlaceholderPath === undefined &&
			removal.retainedUnknownPath === undefined &&
			Object.keys(removal).every(key => ["ok", "code", "payloadDurable", "detachedPath"].includes(key))
		)
			finished = await removeDetachedLockQuarantineOnDisk(transitionPath, snapshot.rootDev, snapshot.rootIno);
		if (
			removal.ok === false &&
			removal.code === "not_found" &&
			Object.keys(removal).every(key => key === "ok" || key === "code")
		)
			finished = true;
		if (finished) {
			markLocalRemovalCompleted(transitionPath, publishedRecordBytes);
			await clearRemovalRecord(transitionPath);
			logger.info(`file lock: reaped 1 stale lock artifact (${transitionPath})`);
		}
		return finished;
	} finally {
		markLocalRemovalCompleted(transitionPath, publishedRecordBytes);
	}
}

function sameFileLockTreeAfterPublication(
	staged: NativeDirectoryTreeSnapshot,
	published: NativeDirectoryTreeSnapshot,
): boolean {
	// ctime is intentionally omitted: native snapshots expose no birthtime, and a
	// metadata-only change must not reject an otherwise identical published tree.
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
				entry.sha256 === current.sha256
			);
		})
	);
}

async function matchesCommittedFileLockPublication(
	pendingPath: string,
	lockPath: string,
	staged: NativeDirectoryTreeSnapshot,
): Promise<boolean> {
	try {
		// A replacement, including a dangling symlink, is not a consumed staging name.
		await fs.lstat(pendingPath);
		return false;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const published = snapshotDirectoryTree(lockPath);
	return (
		published.ok && published.snapshot !== undefined && sameFileLockTreeAfterPublication(staged, published.snapshot)
	);
}

async function rollbackPublishedFileLock(
	canonicalParent: string,
	lockPath: string,
	pendingPath: string,
	stagedSnapshot: NativeDirectoryTreeSnapshot,
	parentIdentity: { dev: bigint; ino: bigint },
): Promise<void> {
	if (process.platform !== "linux") {
		// RecoveryFsRoot is Linux-only. POSIX exact restore retains the parent
		// and checks the directory identity around a same-kind placeholder exchange.
		const root = stagedSnapshot.entries.find(entry => entry.relativePath === "");
		if (!root) throw new Error("File lock rollback snapshot has no root");
		const rollback = exactRestore(lockPath, pendingPath, {
			dev: BigInt(stagedSnapshot.rootDev),
			ino: BigInt(stagedSnapshot.rootIno),
			parentDev: parentIdentity.dev,
			parentIno: parentIdentity.ino,
			size: BigInt(root.size),
			mtimeNs: BigInt(root.mtimeNs),
			directory: true,
		});
		const placeholder = rollback.retainedPlaceholderPath;
		const retainedPlaceholder =
			!rollback.ok &&
			rollback.code === "cleanup_pending" &&
			placeholder !== undefined &&
			rollback.detachedPath === undefined &&
			rollback.retainedSuccessorPath === undefined &&
			rollback.retainedUnknownPath === undefined;
		if (!rollback.ok && !retainedPlaceholder) {
			throw new Error(
				`Failed to roll back file lock published during removal transition: ${rollback.code ?? "unknown"}.`,
			);
		}
		// A root-only restore is not authority to delete substituted descendants.
		// Leave the retained tree untouched unless the complete snapshot still matches.
		const restored = snapshotDirectoryTree(pendingPath);
		if (!restored.ok || !restored.snapshot || !sameFileLockTreeAfterPublication(stagedSnapshot, restored.snapshot)) {
			throw new Error(`Failed to verify rolled back file lock: ${restored.code ?? "identity_mismatch"}.`);
		}
		if (retainedPlaceholder && placeholder !== undefined) {
			// exactRestore returns a retained, empty exchange placeholder. Its native
			// name encodes the identity it verified, not authority over an arbitrary path.
			const identity = /^\.gjc-exact-unlink-placeholder-([0-9a-f]+)-([0-9a-f]+)$/.exec(placeholder);
			if (!identity) throw new Error("File lock rollback placeholder identity is unavailable");
			const placeholderPath = path.join(canonicalParent, placeholder);
			try {
				const current = await fs.lstat(placeholderPath, { bigint: true });
				if (
					!current.isDirectory() ||
					current.isSymbolicLink() ||
					canonicalLockDeviceId(current.dev) !== BigInt(`0x${identity[1]}`) ||
					canonicalLockFileId(current.ino) !== BigInt(`0x${identity[2]}`)
				) {
					throw new Error("File lock rollback placeholder identity changed; refusing removal");
				}
				await fs.rmdir(placeholderPath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return;
	}
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
				"access_denied",
				"io_failure",
				"invalid_request",
				"interrupted",
				"identity_violation",
				"durability_not_provable",
				"sharing_violation",
				"access_denied",
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
			value.code === undefined &&
			value.diagnostic.collectionState === "unavailable" &&
			value.diagnostic.osCode === undefined &&
			value.diagnostic.syncFailures === undefined &&
			Object.keys(value.diagnostic).length === 2 &&
			value.primitive !== "unsupported" &&
			value.primitive !== "unknown" &&
			value.mutationState === "committed" &&
			value.reason === "none" &&
			value.phase === "complete" &&
			value.durabilityState === "not_attempted"
		);
	if (value.mutationState === "not_committed") return value.durabilityState === "not_attempted";
	if (value.mutationState === "committed") {
		// This is a committed namespace change, not authority to retry publication.
		// DrvFS can hide the renamed directory until the native source handle closes.
		return (
			value.code === "destination_identity_changed" &&
			value.durabilityState === "not_provable" &&
			value.reason === "identity_violation" &&
			value.primitive === "mkdirat_renameat_noreplace" &&
			value.phase === "terminal_identity" &&
			value.diagnostic.collectionState === "unavailable" &&
			Object.keys(value.diagnostic).length === 2
		);
	}
	return value.mutationState === "unknown" && value.durabilityState === "not_provable";
}

function isSuccessfulNativePublication(value: unknown, operation: "primary" | "directory"): boolean {
	if (!isValidNativeNoReplaceResult(value) || !value.ok) return false;
	if (operation === "directory") return value.primitive === "mkdirat_renameat_noreplace";
	// Native code records the primitive it actually invoked in the receipt. That
	// primitive is the producer-platform evidence; process.platform is only ambient
	// capability metadata and may be overridden by a coordinator discovery test.
	return (
		value.primitive === "renameat2_noreplace" ||
		value.primitive === "renameatx_np_excl" ||
		value.primitive === "windows_rename_noreplace"
	);
}

function isCommittedDirectoryVerificationFailure(value: unknown): value is NativeNoReplaceResult {
	return isValidNativeNoReplaceResult(value) && !value.ok && value.mutationState === "committed";
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

function isPreMutationPublicationContention(value: unknown): boolean {
	return (
		isValidNativeNoReplaceResult(value) &&
		!value.ok &&
		value.code === "sharing_violation" &&
		value.mutationState === "not_committed" &&
		value.durabilityState === "not_attempted" &&
		value.reason === value.code &&
		value.phase === "rename"
	);
}

function isPreMutationAccessDeniedPublication(value: unknown): boolean {
	return (
		isValidNativeNoReplaceResult(value) &&
		!value.ok &&
		value.code === "access_denied" &&
		value.mutationState === "not_committed" &&
		value.durabilityState === "not_attempted" &&
		value.reason === "access_denied" &&
		value.primitive === "windows_rename_noreplace" &&
		value.phase === "rename"
	);
}

function isPreMutationPublicationRetryable(value: unknown): boolean {
	return isPreMutationPublicationContention(value) || isPreMutationAccessDeniedPublication(value);
}

function preMutationPublicationFailureCode(value: unknown): FileLockPublicationFailureCode | undefined {
	if (isPreMutationPublicationContention(value)) return "sharing_violation";
	if (isPreMutationAccessDeniedPublication(value)) return "access_denied";
	return undefined;
}

async function publishNoReplaceWithTransientRetry(
	publish: (sourcePath: string, destinationPath: string) => Promise<NativeNoReplaceResult>,
	sourcePath: string,
	destinationPath: string,
	signal?: AbortSignal,
): Promise<NativeNoReplaceResult> {
	throwIfFileLockAcquisitionAborted(signal);
	let result = await publish(sourcePath, destinationPath);
	for (
		let attempt = 1;
		attempt < PUBLICATION_TRANSIENT_RETRY_ATTEMPTS && isPreMutationPublicationRetryable(result);
		attempt++
	) {
		await sleepFileLockRetry(PUBLICATION_TRANSIENT_RETRY_DELAY_MS * attempt, signal);
		throwIfFileLockAcquisitionAborted(signal);
		result = await publish(sourcePath, destinationPath);
	}
	return result;
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
	if (owner.process_incarnation) {
		if (ownerLiveness(owner.pid) !== "alive") return false;
		const currentIncarnation = processIncarnation(owner.pid);
		return currentIncarnation !== null && currentIncarnation !== owner.process_incarnation;
	}
	if (owner.start_time_format !== PROCESS_START_TIME_FORMAT || !owner.start_time || owner.start_time === "unknown")
		return false;
	if (ownerLiveness(owner.pid) !== "alive") return false;
	const currentStartTime = cachedProcessStartTime(owner, startTimeCache);
	return currentStartTime !== null && currentStartTime !== owner.start_time;
}

function ownerGenerationIsDead(owner: FileLockOwnerToken): boolean {
	return ownerLiveness(owner.pid) === "dead" || ownerIncarnationChanged(owner);
}

/** Outcome of a guarded lock-dir removal attempt (`removeFileLockDirForGc`). */
export type FileLockGcRemoval = "removed" | "owner_changed" | "missing" | "cleanup_failed";
type LockStaleSnapshot =
	| { stale: false }
	| { stale: true; owner: FileLockOwnerToken; identity: GenericFileLockDirIdentity };

/**
 * Identity evidence carried by the generic stale verdict into a later removal.
 *
 * `ctimeNs` is a mutable metadata-change time on every supported filesystem, so
 * it is retained for diagnostics/legacy consumers but is not part of the lock
 * identity predicate. `infoBirthtimeNs` is the creation time that stays bound
 * to the file object.
 */
export interface GenericFileLockDirIdentity {
	rootDev: string;
	rootIno: string;
	infoDev: string;
	infoIno: string;
	infoNlink: string;
	infoSize: string;
	infoMtimeNs: string;
	infoCtimeNs: string;
	infoBirthtimeNs: string;
	infoSha256: string;
}

function sameStableFileLockIdentity(left: GenericFileLockDirIdentity, right: GenericFileLockDirIdentity): boolean {
	const birthtimeMatches =
		left.infoBirthtimeNs === "0" || right.infoBirthtimeNs === "0" || left.infoBirthtimeNs === right.infoBirthtimeNs;
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		left.infoDev === right.infoDev &&
		left.infoIno === right.infoIno &&
		birthtimeMatches
	);
}

/** Content/topology evidence kept separate from the stable file identity. */
function sameFileLockContentEvidence(left: GenericFileLockDirIdentity, right: GenericFileLockDirIdentity): boolean {
	return (
		left.infoNlink === right.infoNlink &&
		left.infoSize === right.infoSize &&
		left.infoMtimeNs === right.infoMtimeNs &&
		left.infoSha256 === right.infoSha256
	);
}

function sameGenericFileLockDirIdentity(left: GenericFileLockDirIdentity, right: GenericFileLockDirIdentity): boolean {
	return sameStableFileLockIdentity(left, right) && sameFileLockContentEvidence(left, right);
}

function fileLockDirIdentityFromNativeSnapshot(snapshot: NativeDirectoryTreeSnapshot): GenericFileLockDirIdentity {
	const info = snapshot.entries.find(entry => entry.relativePath === "info");
	if (info?.kind !== "file" || !info.sha256) throw new Error("file_lock_snapshot_missing_owner_identity");
	return {
		rootDev: snapshot.rootDev,
		rootIno: snapshot.rootIno,
		infoDev: info.dev,
		infoIno: info.ino,
		infoNlink: info.nlink,
		infoSize: info.size,
		infoMtimeNs: info.mtimeNs,
		infoCtimeNs: info.ctimeNs,
		// Native snapshots do not expose birthtime; the remaining inode and content
		// evidence still binds this exact staged generation across publication.
		infoBirthtimeNs: "0",
		infoSha256: info.sha256,
	};
}

let nativeExactRemovalUsable: boolean | undefined;
let nativeExactRemovalProbePromise: Promise<boolean> | undefined;

async function probeNativeExactRemoval(): Promise<boolean> {
	const testProbe = FileLockTestHooks.nativeExactRemovalProbe;
	if (testProbe) return await testProbe();
	if (process.platform !== "win32") return true;

	let root: string;
	try {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-probe-"));
	} catch {
		// There is no evidence that native exact removal is unusable. Keep the
		// identity-bound path rather than changing cleanup semantics on an
		// unrelated temporary-directory failure.
		return true;
	}
	const probeDir = path.join(root, "probe.lock");
	try {
		await fs.mkdir(probeDir, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(probeDir, "info"), "probe");
		const captured = nativeFileLockBindings().snapshotDirectoryTree(probeDir);
		if (!captured.ok || !captured.snapshot) return false;
		return nativeFileLockBindings().exactRemoveDirectoryTree(probeDir, captured.snapshot).ok === true;
	} catch {
		return false;
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function isNativeExactRemovalUsable(): Promise<boolean> {
	if (FileLockTestHooks.nativeExactRemovalProbe) return await probeNativeExactRemoval();
	if (process.platform !== "win32") return true;
	if (FileLockTestHooks.nativeQuarantineBindings) return true;
	if (nativeExactRemovalUsable !== undefined) return nativeExactRemovalUsable;
	let probe = nativeExactRemovalProbePromise;
	if (!probe) {
		probe = probeNativeExactRemoval().then(usable => {
			nativeExactRemovalUsable = usable;
			return usable;
		});
		nativeExactRemovalProbePromise = probe;
	}
	try {
		return await probe;
	} finally {
		if (nativeExactRemovalProbePromise === probe) nativeExactRemovalProbePromise = undefined;
	}
}

async function removeVerifiedLockDirWithoutNative(
	lockDir: string,
	expected: NonNullable<NativeDirectoryTreeResult["snapshot"]>,
	owner?: FileLockOwnerToken,
): Promise<FileLockGcRemoval> {
	let parent: BigIntStats;
	try {
		parent = await fs.lstat(path.dirname(lockDir), { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return "owner_changed";
		if (isTransientReleaseError(error)) throw error;
		return "cleanup_failed";
	}
	const removal = await exactRemoveLockTree(
		lockDir,
		expected,
		owner?.owner_host_id,
		{ dev: canonicalLockDeviceId(parent.dev), ino: canonicalLockFileId(parent.ino) },
		true,
	);
	if (removal.ok && !removal.detachedPath) return "removed";
	if (removal.code === "not_found") return "removed";
	if (removal.code === "identity_mismatch" || removal.code === "parent_mismatch") return "owner_changed";
	if (!removal.detachedPath) return "cleanup_failed";
	if (owner) {
		pendingDetachedLockCleanups.set(owner, {
			path: removal.detachedPath,
			rootDev: expected.rootDev,
			rootIno: expected.rootIno,
			snapshot: expected,
		});
		return (await finishDetachedLockCleanup(owner)) ? "removed" : "cleanup_failed";
	}
	// The native exact-removal primitive is unavailable by definition on this path.
	// Replaying it here would recreate the very failure the fallback exists to avoid,
	// so complete the parked tree with an identity-checked filesystem removal instead.
	if (
		removal.retainedSuccessorPath !== undefined ||
		removal.retainedPlaceholderPath !== undefined ||
		removal.retainedUnknownPath !== undefined
	)
		return "cleanup_failed";
	let detachedCleanupCompleted: boolean;
	try {
		detachedCleanupCompleted = await removeDetachedLockQuarantineOnDisk(
			removal.detachedPath,
			expected.rootDev,
			expected.rootIno,
		);
	} catch (error) {
		markLocalRemovalResumable(removal.detachedPath, expected.rootDev, expected.rootIno);
		if (!isTransientReleaseError(error)) throw error;
		return "cleanup_failed";
	}
	if (!detachedCleanupCompleted) {
		markLocalRemovalResumable(removal.detachedPath, expected.rootDev, expected.rootIno);
		return "cleanup_failed";
	}
	await clearRemovalRecord(removal.detachedPath);
	return "removed";
}

async function removeVerifiedOwnedLockDirWithoutNative(
	lockDir: string,
	expected: GenericFileLockDirIdentity,
	owner: FileLockOwnerToken,
): Promise<FileLockGcRemoval> {
	try {
		await fs.lstat(lockDir, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return "removed";
		if (isTransientReleaseError(error)) throw error;
		return "cleanup_failed";
	}
	const current = await captureFileLockDirIdentity(lockDir);
	if (!current || !sameStableFileLockIdentity(current, expected)) return "owner_changed";
	const captured = nativeFileLockBindings().snapshotDirectoryTree(lockDir);
	if (!captured.ok || !captured.snapshot) return "owner_changed";
	const infoEntry = captured.snapshot.entries.find(entry => entry.relativePath === "info");
	if (
		!infoEntry ||
		!nativeFileLockInfoMatchesStableIdentity(
			captured.snapshot.rootDev,
			captured.snapshot.rootIno,
			infoEntry,
			expected,
		) ||
		!nativeFileLockInfoMatchesContentEvidence(infoEntry, expected)
	)
		return "owner_changed";
	return await removeVerifiedLockDirWithoutNative(lockDir, captured.snapshot, owner);
}

function nativeFileLockInfoMatchesStableIdentity(
	rootDev: string,
	rootIno: string,
	infoEntry: NativeDirectoryTreeSnapshot["entries"][number],
	expected: GenericFileLockDirIdentity,
): boolean {
	return (
		rootDev === expected.rootDev &&
		rootIno === expected.rootIno &&
		infoEntry.dev === expected.infoDev &&
		infoEntry.ino === expected.infoIno
	);
}

function nativeFileLockInfoMatchesContentEvidence(
	infoEntry: NativeDirectoryTreeSnapshot["entries"][number],
	expected: GenericFileLockDirIdentity,
): boolean {
	// Native snapshots expose a ctime-shaped field, but ctime is a mutable
	// metadata-change timestamp on every supported filesystem. The stable file
	// identity is checked separately; requiring ctime here would reject a
	// legitimate lock after chmod/ACL/indexer activity.
	return (
		infoEntry.nlink === expected.infoNlink &&
		infoEntry.size === expected.infoSize &&
		infoEntry.mtimeNs === expected.infoMtimeNs &&
		infoEntry.sha256 === expected.infoSha256
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
	if (!sameFileLockOwnerToken(current, expected)) {
		return "owner_changed";
	}
	if (!(await isNativeExactRemovalUsable()))
		return await removeVerifiedOwnedLockDirWithoutNative(lockDir, expectedIdentity, expected);
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
	const currentIdentity = await captureFileLockDirIdentity(nativeCapturePath);
	if (!currentIdentity || !sameStableFileLockIdentity(currentIdentity, expectedIdentity)) return "owner_changed";
	if (
		!captured.snapshot.rootDev ||
		!nativeFileLockInfoMatchesStableIdentity(
			captured.snapshot.rootDev,
			captured.snapshot.rootIno,
			infoEntry,
			expectedIdentity,
		) ||
		!nativeFileLockInfoMatchesContentEvidence(infoEntry, expectedIdentity)
	)
		return "owner_changed";
	let removed: NativeExactUnlinkResult;
	try {
		removed = await exactRemoveLockTree(nativeCapturePath, captured.snapshot, expected.owner_host_id);
		const retainedPath = fileLockRemovalTransitionPath(nativeCapturePath);
		if (
			process.platform === "linux" &&
			!nativeCapturePath.endsWith(".removing") &&
			removed.ok === false &&
			removed.code === "identity_mismatch" &&
			removed.retainedSuccessorPath === retainedPath &&
			Object.keys(removed).every(key => ["ok", "code", "retainedSuccessorPath"].includes(key))
		) {
			// DrvFS may hide the detached name while native code retains the source
			// handle. The receipt alone never authorizes deleting a reported successor:
			// require the complete original tree, then replay exact removal once at
			// the deterministic retained name, where no further rename is necessary.
			const retained = nativeFileLockBindings().snapshotDirectoryTree(retainedPath);
			if (
				retained.ok &&
				retained.snapshot &&
				sameFileLockTreeAfterPublication(captured.snapshot, retained.snapshot)
			) {
				const replay = nativeFileLockBindings().exactRemoveDirectoryTree(retainedPath, retained.snapshot);
				if (
					replay.ok !== false ||
					replay.code !== "cleanup_pending" ||
					replay.payloadDurable !== true ||
					replay.detachedPath !== retainedPath ||
					Object.keys(replay).some(key => !["ok", "code", "payloadDurable", "detachedPath"].includes(key))
				) {
					// A replay failure can carry detachedPath without authorizing payload
					// cleanup. Never forward such a receipt to the generic detach handler.
					logger.debug("Detached file lock replay did not prove durable cleanup", {
						originalCode: removed.code,
						replayCode: replay.code,
					});
					return "cleanup_failed";
				}
				removed = replay;
				logger.debug("Replayed identity-matched detached file lock removal", { code: removed.code });
			}
		}
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
	//
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
			snapshot: captured.snapshot,
		});
		let cleanupCompleted = false;
		try {
			cleanupCompleted = await finishDetachedLockCleanup(expected);
		} catch (error) {
			// Treat an OS sharing denial like a cleanup_pending receipt: both leave
			// this exact detached generation for a later local retry.
			if (!isTransientReleaseError(error)) throw error;
		}
		if (cleanupCompleted) return "removed";
		// Stale-owner cleanup has no LocalLockState release handle to drive another
		// retry. Mark the receipt resumable only after the native attempt returns;
		// other processes still see its live owner and remain fenced from adoption.
		markLocalRemovalResumable(detachedPath, captured.snapshot.rootDev, captured.snapshot.rootIno);
		return "cleanup_failed";
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

/**
 * Does this owner record belong to a machine other than the acquirer's?
 *
 * A host-qualified record is foreign unless the acquirer can prove it is its own:
 * either the identity matches, or it matches an identity this installation used
 * before. An acquirer carrying no host identity can prove nothing, so every
 * host-qualified record stays foreign to it. Foreign records fail closed — their
 * PID values and clocks are not meaningful here, so they are neither reclaimable
 * nor locally probeable for liveness.
 *
 * Shared by the reclamation verdict and the exhaustion diagnostic so the two can
 * never disagree about whose pid a record names.
 */
function lockRecordIsForeignHost(
	info: LockInfo,
	ownerHostId: string | undefined,
	previousOwnerHostIds: readonly string[],
): boolean {
	if (ownerHostId === undefined) return info.owner_host_id !== undefined;
	return info.owner_host_id !== ownerHostId && !previousOwnerHostIds.includes(info.owner_host_id ?? "");
}

/**
 * Host attribution for a `.removing.owner` record whose transition directory is
 * still on disk.
 *
 * Host-qualified records, and every record judged by an acquirer that carries no
 * host identity, follow `lockRecordIsForeignHost`. A hostless record judged by a
 * host-qualified acquirer has no provenance: it was written by a remover that
 * stamped no host id, either a build that predates host-id stamping on this
 * machine or a hostless caller sharing the volume. While that remover could still
 * be mid-removal it stays foreign, so a live remover on another host is never
 * probed. Once the record and every entry of the captured tree have been
 * quiescent for the orphan adoption age, the record carries strictly more
 * evidence than an ownerless transition, which is adopted at the same age, so its
 * pid is judged locally instead of wedging the lock forever. Any tree that cannot
 * be captured, and any timestamp that is not finite or lies in the future, keeps
 * the record foreign.
 */
async function retainedRemovalRecordIsForeignHost(
	transitionPath: string,
	owner: LockInfo,
	orphanAgeMs: number,
	ownerHostId: string | undefined,
	previousOwnerHostIds: readonly string[],
): Promise<boolean> {
	if (owner.owner_host_id !== undefined || ownerHostId === undefined)
		return lockRecordIsForeignHost(owner, ownerHostId, previousOwnerHostIds);
	let recordMtimeNs: bigint;
	try {
		recordMtimeNs = (await fs.lstat(removalRecordPath(transitionPath), { bigint: true })).mtimeNs;
	} catch (error) {
		if (isEnoent(error) || isTransientReleaseError(error)) return true;
		throw error;
	}
	if (!(await isNativeExactRemovalUsable())) return true;
	let captured: NativeDirectoryTreeResult;
	try {
		captured = nativeFileLockBindings().snapshotDirectoryTree(transitionPath);
	} catch (error) {
		if (isTransientReleaseError(error)) return true;
		throw error;
	}
	if (!captured.ok || !captured.snapshot || captured.snapshot.entries.length === 0) return true;
	const now = Date.now();
	const quiescent = (mtimeNs: bigint): boolean => {
		const ageMs = now - Number(mtimeNs / 1_000_000n);
		return Number.isFinite(ageMs) && ageMs >= orphanAgeMs;
	};
	if (!quiescent(recordMtimeNs)) return true;
	for (const entry of captured.snapshot.entries) {
		let mtimeNs: bigint;
		try {
			mtimeNs = BigInt(entry.mtimeNs);
		} catch {
			return true;
		}
		if (!quiescent(mtimeNs)) return true;
	}
	return false;
}

async function staleLockSnapshot(
	lockPath: string,
	_staleMs: number,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
	startTimeCache?: Map<string, string | null>,
	// `.removing` transitions are internal cleanup state this codebase's own removal
	// machinery produced, never a live holder's public identity: a hostless transition
	// record predates host-id stamping and is reclaimable by local liveness proof alone,
	// regardless of the acquirer's own host id. Active `<file>.lock` holders keep the
	// stricter fail-closed rule (see `lockRecordIsForeignHost`) because that record can
	// belong to a genuinely foreign process; only the two transition-specific callers
	// below set this.
	hostlessTransitionIsLocal = false,
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
		// This verdict can authorize cleanup only from a recorded owner generation.
		// Windows acquisition has a separate age- and identity-bound path for a
		// completely empty legacy directory; that path never treats it as a dead
		// owner or claims the existing directory as a new lock.
		return { stale: false };
	}

	// A host-qualified lock may only be reclaimed after proving that its owner is
	// local. Foreign and malformed host-qualified records fail closed: PID values
	// and clocks are not meaningful across hosts.
	const foreignCheckHostId = hostlessTransitionIsLocal && info.owner_host_id === undefined ? undefined : ownerHostId;
	if (lockRecordIsForeignHost(info, foreignCheckHostId, previousOwnerHostIds)) return { stale: false };
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

type RecordedStaleRemovalFailure = {
	owner: FileLockOwnerToken;
	identity: GenericFileLockDirIdentity;
	failure: FileLockStaleRemovalFailure;
};

/**
 * A recorded refusal describes exactly one dead owner generation and directory identity.
 * Re-read the pathname at exhaustion and report it only while both still match, so a refusal
 * recorded for a dead generation is never pinned onto a successor that took the pathname over
 * before the budget ran out, even if its legacy owner bytes are identical.
 */
async function staleRemovalFailureForCurrentGeneration(
	lockPath: string,
	recorded: RecordedStaleRemovalFailure | undefined,
): Promise<FileLockStaleRemovalFailure | undefined> {
	if (!recorded) return undefined;
	try {
		const observation = await readLockInfoObservation(lockPath);
		if (!observation) return undefined;
		const current = parseLockInfoBytes(observation.bytes);
		if (!current || !sameFileLockOwnerToken(current, recorded.owner) || !ownerGenerationIsDead(current))
			return undefined;
		const currentIdentity = fileLockDirIdentityFromPathState(observation.state, observation.bytes);
		if (!sameGenericFileLockDirIdentity(recorded.identity, currentIdentity)) return undefined;
		return {
			...recorded.failure,
			manualCleanupCommand: manualLockCleanupCommand(lockPath),
		};
	} catch {
		return undefined;
	}
}

function manualLockCleanupCommand(lockPath: string): string {
	if (process.platform === "win32") {
		const quotedPath = lockPath.replace(/'/g, "''");
		return `Remove-Item -LiteralPath '${quotedPath}' -Recurse -Force`;
	}
	const quotedPath = lockPath.replace(/'/g, "'\\''");
	return `rm -rf -- '${quotedPath}'`;
}

type FileLockRemovalAttempt = { removed: true } | { removed: false; failure?: FileLockStaleRemovalFailure };

async function removeStaleLockForAcquire(
	lockPath: string,
	snapshot: LockStaleSnapshot,
): Promise<FileLockRemovalAttempt> {
	if (!snapshot.stale) return { removed: false };
	try {
		const outcome = await removeFileLockDirForGc(lockPath, snapshot.owner, snapshot.identity);
		if (outcome === "removed") return { removed: true };
		// Either refusal can mean a successor or an incomplete publication owns the path;
		// keep it only as a diagnostic candidate and expose it at exhaustion if the same
		// dead owner still persists. Never fall back to path-only deletion.
		if (outcome === "owner_changed" || outcome === "missing") {
			return {
				removed: false,
				failure: {
					outcome,
					message:
						outcome === "owner_changed"
							? "the identity-bound removal guard returned owner_changed; no path-only fallback was attempted"
							: "the guarded removal could not read the owner record; no path-only fallback was attempted",
				},
			};
		}
		if (outcome !== "cleanup_failed") return { removed: false };
		return {
			removed: false,
			failure: {
				outcome,
				message: (await isNativeExactRemovalUsable())
					? "the identity-bound lock-removal path refused the dead owner's lock directory"
					: "the native exact-removal primitive is unavailable on this host and the verified detach fallback was refused",
			},
		};
	} catch (error) {
		// A removal refusal — transient or not — is not authority to fail or mutate by
		// another path. Keep contending, because a concurrent reclaimer may already be
		// completing the same dead generation, and record the cause so exhaustion
		// reports *why* a dead owner's lock could not be reaped instead of only
		// "dead but not reaped".
		return {
			removed: false,
			failure: {
				outcome: "error",
				code: (error as NodeJS.ErrnoException).code,
				message: (error as Error).message,
			},
		};
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
	ownerHostId: string | undefined,
	orphanTransitionAgeMs: number,
	previousOwnerHostIds: readonly string[],
	ownerToken = crypto.randomUUID(),
	onAcquired: (() => void) | undefined,
	retryBudget: FileLockAcquisitionRetryBudget,
	onPublished?: (owner: LockInfo) => void,
	onPublicationRolledBack?: (owner: LockInfo) => void,
	onPublicationFailed?: (owner: LockInfo, identity: GenericFileLockDirIdentity, releasePath: string) => void,
): Promise<FileLockAcquisitionResult> {
	await ensureLockParent(path.dirname(lockPath));
	const afterParentMkdir = FileLockTestHooks.afterParentMkdir;
	if (afterParentMkdir) await afterParentMkdir(lockPath);
	const stagingIdentity = currentFileLockStagingIdentity();
	const stagingHostIdentity = ownerHostId === undefined ? "" : `h${fileLockStagingIdentityHash(ownerHostId)}.`;
	const pendingPath = derivedFileLockPath(
		lockPath,
		stagingIdentity
			? `.pending.${process.pid}.${stagingHostIdentity}${stagingIdentity}.${crypto.randomBytes(12).toString("base64url")}`
			: `.pending.${process.pid}.${stagingHostIdentity}${crypto.randomUUID()}`,
	);
	const owner = lockInfo(ownerHostId, ownerToken);
	let removePending = false;
	let pendingStagingIdentity: FileLockStagingRootIdentity | undefined;
	let failedPublicationPath = lockPath;
	try {
		await fs.mkdir(pendingPath, { mode: 0o700 });
		removePending = true;
		try {
			pendingStagingIdentity = await captureFileLockStagingRootIdentity(pendingPath, retryBudget);
		} catch (error) {
			removePending = false;
			retainPendingStagingCleanup(lockPath, pendingPath, undefined, error);
			if (retryBudget.signal?.aborted) throw retryBudget.signal.reason ?? error;
			throw new FileLockStagingCleanupError(lockPath, pendingPath, error);
		}
		await fs.chmod(pendingPath, 0o700);
		await writeLockInfo(pendingPath, owner, retryBudget, infoFileIdentity => {
			if (!pendingStagingIdentity) throw new Error("Staged file-lock root identity is unavailable.");
			pendingStagingIdentity = { ...pendingStagingIdentity, infoFileIdentity };
		});
		await FileLockTestHooks.afterStagingInfoWrite?.(pendingPath);
		// A plain POSIX rename replaces an existing empty directory. The legacy
		// directory lock is a real holder, so publication must use the native
		// no-replace primitive rather than treating an empty destination as free.
		// The native primitive also rejects symlinked/reparse parents. Resolve the
		// already-created staging entry and its parent before publication so aliases
		// retain the same lock identity as the ordinary path.
		const canonicalParent = await fs.realpath(path.dirname(lockPath));
		const destinationPath = path.join(canonicalParent, path.basename(lockPath));
		failedPublicationPath = destinationPath;
		const parent = await fs.lstat(canonicalParent, { bigint: true });
		const parentIdentity = {
			dev: canonicalLockDeviceId(parent.dev),
			ino: canonicalLockFileId(parent.ino),
		};
		// Resolve only the stable parent: resolving the mutable staging final
		// component would follow an attacker-replaced symlink before native no-follow
		// validation gets a chance to reject it.
		const canonicalPendingPath = path.join(canonicalParent, path.basename(pendingPath));
		let stagedSnapshot: NativeDirectoryTreeSnapshot | undefined;
		// A predecessor may retain this deterministic sibling while native cleanup
		// is in progress on either platform. Do not let a successor publish until
		// the transition is gone or its dead owner has been safely adopted.
		let transitionState = await classifyFileLockRemovalTransition(
			destinationPath,
			orphanTransitionAgeMs,
			ownerHostId,
			previousOwnerHostIds,
		);
		if (transitionState === "orphan_transition") {
			// A scrubbed, aged transition is the residue of a removal whose owner died
			// before its final on-disk cleanup. Adopt and finish it here so the wedged
			// namespace heals instead of aborting (or re-spinning the whole budget).
			const adopted = await adoptOrphanedFileLockRemovalTransition(
				destinationPath,
				orphanTransitionAgeMs,
				ownerHostId,
				previousOwnerHostIds,
			);
			if (adopted === "retry") return null;
			if (!adopted) return { kind: "orphan_transition", path: fileLockRemovalTransitionPath(destinationPath) };
			transitionState = await classifyFileLockRemovalTransition(
				destinationPath,
				orphanTransitionAgeMs,
				ownerHostId,
				previousOwnerHostIds,
			);
		}
		if (transitionState === "orphan_transition")
			return { kind: "orphan_transition", path: fileLockRemovalTransitionPath(destinationPath) };
		if (transitionState === "abandoned") {
			if (await adoptAbandonedFileLockRemovalTransition(destinationPath, ownerHostId, previousOwnerHostIds)) {
				transitionState = await classifyFileLockRemovalTransition(
					destinationPath,
					orphanTransitionAgeMs,
					ownerHostId,
					previousOwnerHostIds,
				);
			} else {
				return null;
			}
		}
		if (transitionState !== null) return null;
		let stagedTree: NativeDirectoryTreeSnapshot;
		if (process.platform === "win32") {
			try {
				stagedTree = await captureFileLockStagingTreeSnapshot(canonicalPendingPath, retryBudget);
			} catch (error) {
				throw new FileLockStagingCleanupError(lockPath, pendingPath, error);
			}
		} else {
			const staged = snapshotDirectoryTree(canonicalPendingPath);
			if (!staged.ok || !staged.snapshot) {
				const failure = new Error(
					`Failed to snapshot staged file lock: ${staged.code ?? "unknown"}.`,
				) as NodeJS.ErrnoException;
				if (staged.code) failure.code = staged.code;
				throw failure;
			}
			stagedTree = staged.snapshot;
		}
		stagedSnapshot = stagedTree;
		if (pendingStagingIdentity)
			pendingStagingIdentity = bindFileLockStagingTreeSnapshot(
				canonicalPendingPath,
				pendingStagingIdentity,
				stagedTree,
			);
		const stagedIdentity = fileLockDirIdentityFromNativeSnapshot(stagedTree);
		const publication = FileLockTestHooks.nativePublicationBindings?.() ?? {
			renameNoReplacePathAsync,
			renameDirectoryNoReplacePathAsync,
		};
		const published = await publishNoReplaceWithTransientRetry(
			publication.renameNoReplacePathAsync,
			canonicalPendingPath,
			destinationPath,
			retryBudget.signal,
		);
		let publishedSuccessfully = isSuccessfulNativePublication(published, "primary");
		if (published.ok && !publishedSuccessfully)
			throw new Error("Failed to publish file lock: invalid primary success receipt.");
		if (!published.ok && isPreMutationUnsupportedRenameResult(published)) {
			const fallback = await publishNoReplaceWithTransientRetry(
				publication.renameDirectoryNoReplacePathAsync,
				canonicalPendingPath,
				destinationPath,
				retryBudget.signal,
			);
			const fallbackSuccessfully = isSuccessfulNativePublication(fallback, "directory");
			if (fallback.ok && !fallbackSuccessfully)
				throw new Error("Failed to publish file lock: invalid directory success receipt.");
			const fallbackFailureCode = preMutationPublicationFailureCode(fallback);
			let verifiedCommittedPublication = false;
			if (isCommittedDirectoryVerificationFailure(fallback)) {
				// The staged name has been consumed. Relinquish pathname cleanup even
				// if completion is refused: a replacement there is not our staged tree.
				removePending = false;
				verifiedCommittedPublication =
					stagedSnapshot !== undefined &&
					(await matchesCommittedFileLockPublication(canonicalPendingPath, destinationPath, stagedSnapshot));
				if (verifiedCommittedPublication) {
					logger.debug("Verified committed file lock publication after native identity refusal", {
						code: fallback.code,
						primitive: fallback.primitive,
					});
				}
			}
			if (fallbackSuccessfully || verifiedCommittedPublication) {
				publishedSuccessfully = true;
			} else if (fallback.reason === "destination_exists") {
				return null;
			} else if (fallbackFailureCode) {
				removePending = false;
				await cleanupPendingStagingOrThrow(lockPath, pendingPath, pendingStagingIdentity, retryBudget);
				return { kind: "publication_retry", code: fallbackFailureCode };
			} else {
				const failure = new Error(
					`Failed to publish file lock: ${fallback.code ?? fallback.reason ?? "unknown"}.`,
				) as NodeJS.ErrnoException;
				if (fallback.code) failure.code = fallback.code;
				throw failure;
			}
		}
		if (!publishedSuccessfully) {
			if (published.reason === "destination_exists") {
				return null;
			}
			const publicationFailureCode = preMutationPublicationFailureCode(published);
			if (publicationFailureCode) {
				removePending = false;
				await cleanupPendingStagingOrThrow(lockPath, pendingPath, pendingStagingIdentity, retryBudget);
				return { kind: "publication_retry", code: publicationFailureCode };
			}
			const failure = new Error(
				`Failed to publish file lock: ${published.code ?? published.reason ?? "unknown"}.`,
			) as NodeJS.ErrnoException;
			if (published.code) failure.code = published.code;
			throw failure;
		}
		removePending = false;
		try {
			// Preserve exact-generation release authority before post-publication checks
			// can throw; otherwise a live canonical owner can be left untracked locally.
			onPublished?.(owner);
			// The transition can appear after the pre-publication check only when the
			// predecessor atomically detaches its lock before this no-replace publish.
			// Roll this exact staged tree back to its UUID path before reporting
			// contention; never delete or rename the predecessor's `.removing` tree.
			if (stagedSnapshot) {
				const transitionState = await classifyFileLockRemovalTransition(
					destinationPath,
					orphanTransitionAgeMs,
					ownerHostId,
					previousOwnerHostIds,
				);
				if (transitionState !== null) {
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
					try {
						await rollbackPublishedFileLock(
							canonicalParent,
							destinationPath,
							canonicalPendingPath,
							publishedSnapshot.snapshot,
							parentIdentity,
						);
					} catch (error) {
						// Rollback can commit before a later verification or authority-close
						// failure. Release the staged generation at the path that actually
						// retains it, rather than retrying against the now-vacant canonical name.
						try {
							const stagedAgain = snapshotDirectoryTree(canonicalPendingPath);
							if (
								stagedAgain.ok &&
								stagedAgain.snapshot &&
								sameFileLockTreeAfterPublication(publishedSnapshot.snapshot, stagedAgain.snapshot)
							)
								failedPublicationPath = canonicalPendingPath;
						} catch {
							// Keep the canonical target when the staging identity cannot be proven.
						}
						throw error;
					}
					removePending = true;
					onPublicationRolledBack?.(owner);
					return transitionState === "orphan_transition"
						? { kind: "orphan_transition", path: fileLockRemovalTransitionPath(destinationPath) }
						: null;
				}
			}
			// Published and transition-free above, so an onAcquired failure must
			// propagate instead of retrying an acquisition that already owns the lock.
			onAcquired?.();
			return owner;
		} catch (error) {
			onPublicationFailed?.(owner, stagedIdentity, failedPublicationPath);
			throw error;
		}
	} finally {
		if (removePending && pendingStagingIdentity) {
			try {
				if (process.platform === "win32" && !pendingStagingIdentity.treeSnapshot)
					pendingStagingIdentity = await captureFileLockStagingCleanupIdentity(
						pendingPath,
						pendingStagingIdentity,
						retryBudget,
					);
				await removePendingStaging(pendingPath, pendingStagingIdentity);
				pendingStagingCleanups.delete(pendingPath);
			} catch (cleanupError) {
				const cleanupPath = detachedStagingCleanupPath(pendingPath, cleanupError);
				if (cleanupPath !== pendingPath) pendingStagingCleanups.delete(pendingPath);
				retainPendingStagingCleanup(lockPath, cleanupPath, pendingStagingIdentity, cleanupError);
			}
		}
	}
}

function isResultTransientFailure(result: { code?: string }): boolean {
	const code = result.code;
	return (
		code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY" || code === "sharing_violation"
	);
}

function isTransientReleaseError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return (
		code === "EBUSY" ||
		code === "EPERM" ||
		code === "EACCES" ||
		code === "ENOTEMPTY" ||
		code === "access_denied" ||
		code === "sharing_violation"
	);
}

function throwTransientNativeResult(code: string): never {
	throw Object.assign(new Error(`Native lock operation is transiently unavailable: ${code}.`), { code });
}

/**
 * The owner-generation fields a guarded removal and a diagnostic both have to agree on
 * before either may act on, or speak about, that generation.
 */
function sameFileLockOwnerToken(current: LockInfo, expected: FileLockOwnerToken): boolean {
	return (
		current.pid === expected.pid &&
		(expected.process_incarnation === undefined || current.process_incarnation === expected.process_incarnation) &&
		(expected.start_time === undefined || current.start_time === expected.start_time) &&
		current.owner_host_id === expected.owner_host_id &&
		(expected.owner_token === undefined || current.owner_token === expected.owner_token) &&
		current.timestamp === expected.timestamp
	);
}

type NativeFileLockBindings = {
	snapshotDirectoryTree(lockPath: string): NativeDirectoryTreeResult;
	exactRemoveDirectoryTree(
		lockPath: string,
		snapshot: NonNullable<NativeDirectoryTreeResult["snapshot"]>,
		parentIdentity?: { dev: bigint; ino: bigint },
		detachOnly?: boolean,
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
	if (!(await isNativeExactRemovalUsable()))
		return (await removeVerifiedOwnedLockDirWithoutNative(lockPath, expectedIdentity, owner)) === "removed";
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
	const currentIdentity = await captureFileLockDirIdentity(nativeCapturePath);
	if (!currentIdentity || !sameStableFileLockIdentity(currentIdentity, expectedIdentity)) return false;
	if (
		!nativeFileLockInfoMatchesStableIdentity(
			captured.snapshot.rootDev,
			captured.snapshot.rootIno,
			infoEntry,
			expectedIdentity,
		) ||
		!nativeFileLockInfoMatchesContentEvidence(infoEntry, expectedIdentity)
	)
		return false;
	// Bind the owner generation to the snapshot before exact removal. A successor
	// installed after this snapshot is rejected by the native identity check instead of
	// being moved into quarantine by a pathname-only rename.
	const expectedDigest = crypto.createHash("sha256").update(JSON.stringify(owner)).digest("hex");
	if (infoEntry.sha256 !== expectedDigest) return false;
	let removed: NativeExactUnlinkResult;
	try {
		removed = await exactRemoveLockTree(nativeCapturePath, captured.snapshot, owner.owner_host_id);
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
					snapshot: captured.snapshot,
				});
				return await finishDetachedLockCleanup(owner);
			}
			throw error;
		}
	}
	return false;
}

async function releaseOwnedLock(
	lockPath: string,
	owner: FileLockOwnerToken,
	captureInitialIdentity = false,
): Promise<void> {
	if (await finishDetachedLockCleanup(owner)) return;
	// Only the initial release may establish removal authority. Pending retries
	// must retain that evidence, even if a replacement carries identical info.
	// If the initial capture failed, a later pathname cannot supply authority.
	let preVerdictIdentity = fileLockDirIdentities.get(owner);
	if (captureInitialIdentity && !preVerdictIdentity) {
		try {
			preVerdictIdentity = (await captureFileLockDirIdentity(lockPath)) ?? undefined;
			if (preVerdictIdentity) fileLockDirIdentities.set(owner, preVerdictIdentity);
		} catch (error) {
			if (!isTransientReleaseError(error)) throw error;
		}
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
	const releasePromise = releaseOwnedLock(state.releasePath ?? lockPath, state.owner);
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
	const releasePromise = releaseOwnedLock(lockPath, owner, true);
	state.releasePromise = releasePromise;
	try {
		await releasePromise;
		if (localLockStates.get(key) === state) localLockStates.delete(key);
	} catch (error) {
		state.status = "release_pending";
		scheduleReleasePendingRetry(lockPath, key, state);
		throw error;
	} finally {
		if (state.releasePromise === releasePromise) state.releasePromise = undefined;
	}
}

const RELEASE_PENDING_RETRY_DELAYS_MS = [250, 1_000, 5_000, 15_000, 60_000];

/**
 * A failed release otherwise waits for this process's next acquisition of the
 * same path. An idle process may never acquire again and other processes never
 * displace a live owner, so retry in the background. Each retry re-runs the full
 * guarded release and can only remove this owner generation.
 */
function scheduleReleasePendingRetry(lockPath: string, key: string, state: LocalLockState, attempt = 0): void {
	const delay = RELEASE_PENDING_RETRY_DELAYS_MS[attempt];
	if (delay === undefined) {
		logger.warn("File lock release is still pending after background retries", { lockPath });
		return;
	}
	const timer = setTimeout(async () => {
		if (localLockStates.get(key) !== state) return;
		await retryPendingLocalRelease(lockPath, key).catch(() => undefined);
		if (localLockStates.get(key) === state) scheduleReleasePendingRetry(lockPath, key, state, attempt + 1);
	}, delay);
	timer.unref?.();
}
/**
 * Bounded, actionable description of who holds `lockPath` at exhaustion time.
 * Never a stealing authority: purely diagnostic, read once after the last retry.
 */
interface FileLockHolderDescription {
	description: string;
	isLive: boolean;
}

async function lockHolderDescription(
	lockPath: string,
	orphanTransitionAgeMs: number,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
): Promise<FileLockHolderDescription> {
	try {
		const transitionState = await classifyFileLockRemovalTransition(
			lockPath,
			orphanTransitionAgeMs,
			ownerHostId,
			previousOwnerHostIds,
		);
		if (transitionState === "orphan_transition")
			return { description: `orphan_transition at ${fileLockRemovalTransitionPath(lockPath)}`, isLive: false };
		if (transitionState === "abandoned")
			return {
				description: `blocked by abandoned removal transition at ${fileLockRemovalTransitionPath(lockPath)}; inspect and remove the directory manually once no publisher remains`,
				isLive: false,
			};
		if (transitionState === "active")
			return {
				description: `blocked by retained removal transition ${fileLockRemovalTransitionPath(lockPath)}; retry the owning process cleanup or inspect the exact orphan manually; unproven transition ownership is never removed`,
				isLive: false,
			};
		let info = await readLockInfo(lockPath);
		let bytes: string | null = null;
		if (!info) {
			bytes = await readLockInfoBytes(lockPath);
			info = bytes === null ? null : parseLockInfoBytes(bytes);
		}
		if (info) {
			// A lock record carrying a FOREIGN owner_host_id belongs to another
			// machine (shared-volume topic registry): its pid is meaningful only
			// on that host, so probing the same numeric pid here could mislabel a
			// coincident local process as the holder. Report the owner host with
			// unknown liveness instead. The same predicate that decides whether
			// the record is reclaimable decides whether its pid is probeable, so a
			// holder this acquirer *may* reclaim is never described as opaque.
			if (lockRecordIsForeignHost(info, ownerHostId, previousOwnerHostIds)) {
				// An unqualified record carries no host provenance at all. A host-aware
				// acquirer still fails closed on it — its pid is never probed and its
				// lock is never reclaimed — but the diagnostic must say the provenance
				// is missing instead of naming a host it does not have.
				const provenance =
					info.owner_host_id === undefined ? "on an unrecorded host" : `on host ${info.owner_host_id}`;
				return {
					description:
						`held by pid ${info.pid} ${provenance} (liveness unknown from this host)` +
						` since ${new Date(info.timestamp).toISOString()}`,
					isLive: false,
				};
			}
			// Same-host holder: label it live only when the PID is alive and its
			// recorded process identity matches exactly. Conservative uncertainty
			// still prevents reclamation, but is not proof for operator diagnostics.
			const pidLiveness = ownerLiveness(info.pid);
			const alive = pidLiveness === "alive" && ownerIdentityIsProven(info);
			const liveness = alive ? "live" : pidLiveness === "dead" ? "dead but not reaped" : "liveness unknown";
			return {
				description:
					`held by pid ${info.pid}` +
					// Keep the host on a host-qualified local record: on a shared volume the
					// same pathname is contended from several hosts, so naming the one whose
					// pid space this verdict came from is what makes it actionable.
					(info.owner_host_id === undefined ? "" : " on this host") +
					` (${liveness})` +
					` since ${new Date(info.timestamp).toISOString()}`,
				isLive: alive,
			};
		}
		try {
			if (bytes !== null)
				return {
					description:
						"held by an owner record that never became readable (empty, truncated, or non-JSON info); malformed records carry no liveness proof and are never reclaimed — inspect and remove the directory manually once no publisher remains",
					isLive: false,
				};
			await fs.stat(path.join(lockPath, "info"));
			return { description: "held by an owner whose metadata is not yet readable", isLive: false };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		try {
			if ((await fs.readdir(lockPath)).length === 0) {
				return {
					description:
						"held by an ownerless empty lock directory; inspect and remove this exact directory manually only after " +
						`confirming no publisher remains: ${manualLockCleanupCommand(lockPath)}`,
					isLive: false,
				};
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return { description: "held by an unrecognized owner record", isLive: false };
	} catch (error) {
		return { description: `held by an unreadable owner (${(error as Error).message})`, isLive: false };
	}
}

export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const requestedFilePath: unknown = filePath;
	if (typeof requestedFilePath !== "string" || requestedFilePath.length === 0 || !path.isAbsolute(requestedFilePath))
		throw new TypeError("filePath must be a non-empty absolute path");
	if (requestedFilePath.includes("\0")) throw new TypeError("filePath must not contain NUL bytes");
	if (options.ownerHostId !== undefined && !options.ownerHostId) throw new Error("ownerHostId must be non-empty");
	if (options.previousOwnerHostIds?.some(hostId => !hostId))
		throw new Error("previousOwnerHostIds must contain only non-empty identities");
	const opts = { ...DEFAULT_OPTIONS, ...options };
	if (opts.retries !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(opts.retries) || opts.retries < 1))
		throw new RangeError("retries must be a positive safe integer");
	const orphanTransitionAgeMs = options.orphanTransitionAgeMs ?? options.staleMs ?? DEFAULT_OPTIONS.staleMs;
	if (!Number.isFinite(orphanTransitionAgeMs) || orphanTransitionAgeMs < 0)
		throw new RangeError("orphanTransitionAgeMs must be a finite, non-negative number");

	if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("File lock acquisition aborted");
	const lockPath = getLockPath(filePath);
	// Bound staging cleanup across the outer retry budget: all staging cleanup retries
	// use a shared delay budget and are subject to the same abort signal as the lock acquisition.
	const retryBudget: FileLockAcquisitionRetryBudget = {
		remainingDelays: opts.retries - 1,
		retryDelayMs: opts.retryDelayMs,
		signal: opts.signal,
	};
	await ensureLockParent(path.dirname(lockPath));
	await retryPendingStagingCleanups(lockPath, retryBudget);
	try {
		await reapOrphanedLockStagingDirs(lockPath, {
			ownerHostId: opts.ownerHostId,
			previousOwnerHostIds: opts.previousOwnerHostIds,
		});
	} catch (error) {
		logger.debug("Failed to reap orphaned file-lock staging directories", { lockPath, error: String(error) });
	}
	const ownerToken = crypto.randomUUID();
	const contentionStartTimes = new Map<string, string | null>();
	let contentionObserved = false;
	let staleRemovalFailure: RecordedStaleRemovalFailure | undefined;
	let publicationFailureCode: FileLockPublicationFailureCode | undefined;
	let accessDeniedPublicationAttempts = 0;
	let attemptsMade = 0;
	let attemptBudget = opts.retries;
	let recoveryExtensions = 0;
	const extendAttemptBudgetAfterCleanup = (): void => {
		// Reaping is progress, but it still needs a fresh publication attempt. Bound
		// extensions so a stream of dead generations cannot make acquisition unbounded.
		if (recoveryExtensions >= opts.retries) return;
		recoveryExtensions++;
		attemptBudget++;
	};
	let attempt = 0;
	for (; attempt < attemptBudget; attempt++) {
		attemptsMade = attempt + 1;
		throwIfFileLockAcquisitionAborted(opts.signal);
		await retryPendingStagingCleanups(lockPath, retryBudget);
		const localKey = await localLockKey(lockPath);
		let publishedState: LocalLockState | undefined;
		const priorRelease = localLockStates.get(localKey);
		if (
			priorRelease &&
			priorRelease.status !== "held" &&
			(pendingDetachedLockCleanups.has(priorRelease.owner) ||
				(priorRelease.status === "release_pending" &&
					priorRelease.releasePath !== undefined &&
					!priorRelease.releasePromise))
		) {
			await retryPendingLocalRelease(lockPath, localKey);
			extendAttemptBudgetAfterCleanup();
			continue;
		}
		const result = await tryAcquireLock(
			lockPath,
			opts.ownerHostId,
			orphanTransitionAgeMs,
			opts.previousOwnerHostIds ?? [],
			ownerToken,
			opts.onAcquired,
			retryBudget,
			owner => {
				const state: LocalLockState = { owner, status: "held" };
				publishedState = state;
				localLockStates.set(localKey, state);
			},
			owner => {
				const state = publishedState;
				if (!state || state.owner.owner_token !== owner.owner_token) return;
				if (localLockStates.get(localKey) === state) localLockStates.delete(localKey);
				if (publishedState === state) publishedState = undefined;
			},
			(owner, identity, releasePath) => {
				const state = publishedState;
				if (!state || state.owner.owner_token !== owner.owner_token || localLockStates.get(localKey) !== state)
					return;
				fileLockDirIdentities.set(owner, identity);
				state.releasePath = releasePath;
				state.status = "release_pending";
				scheduleReleasePendingRetry(lockPath, localKey, state);
			},
		);
		if (isFileLockOrphanTransition(result)) {
			// Adoption is identity-bound and can be refused by a transient cleanup race.
			// Keep using the caller's bounded contention budget; the same generation is
			// revalidated before every later adoption attempt.
			publicationFailureCode = undefined;
			accessDeniedPublicationAttempts = 0;
			if (attempt + 1 === attemptBudget)
				throw new FileLockAcquireError(
					filePath,
					lockPath,
					opts.retries,
					`orphan transition retained at ${result.path}`,
					"orphan_transition",
					result.path,
				);
		} else if (isFileLockPublicationRetry(result)) {
			publicationFailureCode = result.code;
			accessDeniedPublicationAttempts = result.code === "access_denied" ? accessDeniedPublicationAttempts + 1 : 0;
		} else {
			publicationFailureCode = undefined;
			accessDeniedPublicationAttempts = 0;
			if (result) {
				const state = publishedState ?? { owner: result, status: "held" as const };
				state.status = "held";
				localLockStates.set(localKey, state);
				return () => releaseLock(lockPath, result, localKey);
			}
		}
		throwIfFileLockAcquisitionAborted(opts.signal);
		if (accessDeniedPublicationAttempts >= MAX_ACCESS_DENIED_PUBLICATION_ACQUISITION_ATTEMPTS) break;
		const publicationIsProvenContention = isFileLockPublicationRetry(result) && result.code === "sharing_violation";
		if (!contentionObserved && (!isFileLockPublicationRetry(result) || publicationIsProvenContention)) {
			contentionObserved = true;
			opts.onContended?.();
		}
		const pendingKey = await pendingLocalReleaseKey(lockPath, localKey);
		const localState = localLockStates.get(pendingKey ?? localKey);
		if (pendingKey !== undefined && localState?.status !== "held" && localState?.owner.owner_token !== undefined) {
			try {
				await retryPendingLocalRelease(lockPath, pendingKey);
				extendAttemptBudgetAfterCleanup();
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
		const staleRemoval = await removeStaleLockForAcquire(lockPath, stale);
		if (staleRemoval.removed) {
			staleRemovalFailure = undefined;
			extendAttemptBudgetAfterCleanup();
			continue;
		}
		staleRemovalFailure =
			stale.stale && staleRemoval.failure
				? { owner: stale.owner, identity: stale.identity, failure: staleRemoval.failure }
				: undefined;
		if (retryBudget.remainingDelays > 0) {
			retryBudget.remainingDelays--;
			await sleepFileLockRetry(opts.retryDelayMs, opts.signal);
		}
	}
	throwIfFileLockAcquisitionAborted(opts.signal);
	const holder = await lockHolderDescription(
		lockPath,
		orphanTransitionAgeMs,
		opts.ownerHostId,
		opts.previousOwnerHostIds ?? [],
	);
	const transitionState = await classifyFileLockRemovalTransition(
		lockPath,
		orphanTransitionAgeMs,
		opts.ownerHostId,
		opts.previousOwnerHostIds ?? [],
	);
	const transitionPath = transitionState ? fileLockRemovalTransitionPath(lockPath) : undefined;
	throw new FileLockAcquireError(
		filePath,
		lockPath,
		attemptsMade,
		holder.description,
		transitionState === "orphan_transition" ? "orphan_transition" : "acquire_timeout",
		transitionPath,
		await staleRemovalFailureForCurrentGeneration(lockPath, staleRemovalFailure),
		publicationFailureCode,
		holder.isLive,
	);
}
/**
 * Describes the retained removal transition blocking `filePath`, if one exists.
 *
 * `acquireFileLock` reports this on exhaustion, but a caller whose own budget
 * aborts the acquisition first would otherwise never learn that a stale
 * transition — not ordinary contention — is what blocked it. Such a caller can
 * ask directly after an abort so the block is surfaced instead of swallowed.
 */
export async function describeRetainedLockTransition(
	filePath: string,
	options: FileLockOptions = {},
): Promise<FileLockAcquireError | undefined> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const orphanTransitionAgeMs = options.orphanTransitionAgeMs ?? options.staleMs ?? DEFAULT_OPTIONS.staleMs;
	const lockPath = getLockPath(filePath);
	const previousOwnerHostIds = opts.previousOwnerHostIds ?? [];
	const transitionState = await classifyFileLockRemovalTransition(
		lockPath,
		orphanTransitionAgeMs,
		opts.ownerHostId,
		previousOwnerHostIds,
	);
	const reportsOrphanTransition = transitionState === "orphan_transition";
	// An abandoned generation with payload outside the adoption shape is never
	// reclaimable by this path, so it blocks renewal exactly like a retained orphan
	// transition. Reporting only `orphan_transition` would leave that case idle.
	const reportsUnadoptableAbandoned =
		transitionState === "abandoned" && (await abandonedTransitionIsUnadoptable(lockPath));
	if (!reportsOrphanTransition && !reportsUnadoptableAbandoned) return undefined;
	const holder = await lockHolderDescription(lockPath, orphanTransitionAgeMs, opts.ownerHostId, previousOwnerHostIds);
	return new FileLockAcquireError(
		filePath,
		lockPath,
		opts.retries,
		holder.description,
		"orphan_transition",
		fileLockRemovalTransitionPath(lockPath),
	);
}

/** A proven-dead abandoned generation whose payload adoption refuses on sight. */
async function abandonedTransitionIsUnadoptable(lockPath: string): Promise<boolean> {
	const transitionPath = fileLockRemovalTransitionPath(lockPath);
	if (await readRemovalTransitionOwnerRecord(transitionPath)) return false;
	if (!(await isNativeExactRemovalUsable())) return false;
	let captured: NativeDirectoryTreeResult;
	try {
		captured = nativeFileLockBindings().snapshotDirectoryTree(transitionPath);
	} catch (error) {
		if (isTransientReleaseError(error)) return false;
		throw error;
	}
	if (!captured.ok || !captured.snapshot) return false;
	// A shape adoption accepts is retried by the ordinary remover; only a refused
	// payload is a permanent block.
	return !abandonedTransitionPayloadIsAdoptable(captured.snapshot);
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
	const release = await acquireFileLock(filePath, options);
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

type FileLockStagingIdentity = { kind: "process_incarnation" | "start_time"; value: string };
type FileLockStagingOwner = { pid: number; identity?: FileLockStagingIdentity; ownerHostIdHash?: string };

const FILE_LOCK_STAGING_UNVERIFIED_GRACE_MS = 60_000;
const FILE_LOCK_STAGING_REAPER_BATCH_SIZE = 64;
const FILE_LOCK_STAGING_REAPER_MAX_CURSORS = 256;
const fileLockStagingReaperCursors = new Map<string, string>();

const FILE_LOCK_STAGING_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILE_LOCK_STAGING_NAME_WITH_IDENTITY =
	/^(?:.+\.lock|\.gjc-lock-[0-9a-f]{64})\.pending\.([1-9]\d*)\.(?:h([A-Za-z0-9_-]{16})\.)?([is][A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{16})$/;
const LEGACY_FILE_LOCK_STAGING_NAME = new RegExp(
	`^(?:.+\\.lock|\\.gjc-lock-[0-9a-f]{64})\\.pending\\.([1-9]\\d*)\\.(?:h([A-Za-z0-9_-]{16})\\.)?${FILE_LOCK_STAGING_UUID}$`,
);
const FILE_LOCK_STAGING_REMOVING_SUFFIX = ".removing";
function fileLockStagingOwner(name: string): FileLockStagingOwner | null {
	const stagingName = name.endsWith(FILE_LOCK_STAGING_REMOVING_SUFFIX)
		? name.slice(0, -FILE_LOCK_STAGING_REMOVING_SUFFIX.length)
		: name;
	const current = FILE_LOCK_STAGING_NAME_WITH_IDENTITY.exec(stagingName);
	const legacy = current ? null : LEGACY_FILE_LOCK_STAGING_NAME.exec(stagingName);
	const match = current ?? legacy;
	if (!match) return null;
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid)) return null;
	const ownerHostIdHash = match[2];
	if (!current) return { pid, ...(ownerHostIdHash === undefined ? {} : { ownerHostIdHash }) };
	const encodedIdentity = current[3] ?? "";
	return {
		pid,
		...(ownerHostIdHash === undefined ? {} : { ownerHostIdHash }),
		identity: {
			kind: encodedIdentity.startsWith("i") ? "process_incarnation" : "start_time",
			value: encodedIdentity.slice(1),
		},
	};
}

function fileLockStagingIdentityHash(identity: string): string {
	// Ninety-six bits are sufficient to disambiguate process generations while
	// keeping the sibling name within the old component-length envelope.
	return crypto.createHash("sha256").update(identity, "utf8").digest("base64url").slice(0, 16);
}

function fileLockStagingHostIdentityIsLocal(
	ownerHostIdHash: string | undefined,
	ownerHostId: string | undefined,
	previousOwnerHostIds: readonly string[],
): boolean {
	if (ownerHostId === undefined || ownerHostIdHash === undefined) return false;
	if (fileLockStagingIdentityHash(ownerHostId) === ownerHostIdHash) return true;
	return previousOwnerHostIds.some(
		previousOwnerHostId => fileLockStagingIdentityHash(previousOwnerHostId) === ownerHostIdHash,
	);
}

/**
 * A missing generation is represented by a legacy UUID name that forces a
 * liveness probe; never hash a synthetic "unknown" as if it were identity evidence.
 */
function currentFileLockStagingIdentity(): string | null {
	const evidence = FileLockTestHooks.stagingIdentityEvidence?.();
	const incarnation = evidence ? evidence.processIncarnation : currentProcessIncarnation();
	if (incarnation) return `i${fileLockStagingIdentityHash(incarnation)}`;
	const startTime = evidence ? evidence.startTime : currentProcessStartTime();
	if (!startTime || startTime === "unknown") return null;
	return `s${fileLockStagingIdentityHash(startTime)}`;
}

/** Return a name-encoded staging PID for GC discovery. */
export function fileLockStagingOwnerPid(name: string): number | null {
	return fileLockStagingOwner(name)?.pid ?? null;
}

export interface FileLockStagingResult {
	path: string;
	pid?: number;
	status: OwnerLiveness;
	removed: boolean;
	reason: string;
}

function fileLockStagingOwnerStatus(owner: FileLockOwnerToken, status: OwnerLiveness): OwnerLiveness {
	if (owner.process_incarnation) {
		const incarnation = processIncarnation(owner.pid);
		if (incarnation !== null) return incarnation === owner.process_incarnation ? "alive" : "dead";
	}
	if (owner.start_time_format === PROCESS_START_TIME_FORMAT && owner.start_time && owner.start_time !== "unknown") {
		const startTime = processStartTime(owner.pid);
		if (startTime !== null) return startTime === owner.start_time ? "alive" : "dead";
	}
	return status;
}

function fileLockStagingIsOldUnverifiedDirectory(snapshot: NativeDirectoryTreeSnapshot): boolean {
	const root = snapshot.entries.find(entry => entry.relativePath === "");
	const info = snapshot.entries.find(entry => entry.relativePath === "info");
	if (
		root?.kind !== "directory" ||
		snapshot.entries.length !== (info ? 2 : 1) ||
		(info && (info.kind !== "file" || info.size !== "0" || info.nlink !== "1"))
	)
		return false;
	try {
		const newestModificationNs = snapshot.entries.reduce((newest, entry) => {
			const modifiedNs = BigInt(entry.mtimeNs);
			return modifiedNs > newest ? modifiedNs : newest;
		}, 0n);
		const nowNs = BigInt(Date.now()) * 1_000_000n;
		return (
			newestModificationNs <= nowNs &&
			nowNs - newestModificationNs >= BigInt(FILE_LOCK_STAGING_UNVERIFIED_GRACE_MS) * 1_000_000n
		);
	} catch {
		return false;
	}
}

/** Observe identity before probing; neither a replacement nor a symlink inherits the verdict. */
export async function inspectFileLockStagingDir(
	stagingPath: string,
	probe: (pid: number) => OwnerLiveness = ownerLiveness,
	remove = false,
	ownerHostId?: string,
	previousOwnerHostIds: readonly string[] = [],
): Promise<FileLockStagingResult> {
	const kept: FileLockStagingResult = {
		path: stagingPath,
		status: "unknown",
		removed: false,
		reason: "unverified_staging_directory",
	};
	const nameOwner = fileLockStagingOwner(path.basename(stagingPath));
	if (!nameOwner) return kept;
	const namePid = nameOwner.pid;
	const nameHostIdentityIsLocal = fileLockStagingHostIdentityIsLocal(
		nameOwner.ownerHostIdHash,
		ownerHostId,
		previousOwnerHostIds,
	);
	if (nameOwner.ownerHostIdHash !== undefined && !nameHostIdentityIsLocal)
		return { ...kept, pid: namePid, reason: "host_qualified_staging_owner" };
	const canonical = await canonicalLockPathPreservingFinal(stagingPath);
	// A winning acquirer publishes (renames) its staging directory concurrently, so the
	// candidate can disappear between the caller's readdir and this observation.
	let root: BigIntStats;
	try {
		root = await fs.lstat(canonical, { bigint: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return { ...kept, reason: "enoent_already_gone" };
	}
	if (!root.isDirectory() || root.isSymbolicLink()) return kept;
	let namePidStatus: OwnerLiveness;
	if (nameOwner.identity) {
		const currentIdentity =
			nameOwner.identity.kind === "process_incarnation" ? processIncarnation(namePid) : processStartTime(namePid);
		if (currentIdentity !== null && fileLockStagingIdentityHash(currentIdentity) === nameOwner.identity.value) {
			return { ...kept, pid: namePid, status: "alive", reason: "live_staging_name_owner" };
		}
		const syntheticStartTimeFallback =
			nameOwner.identity.kind === "start_time" &&
			(nameOwner.identity.value === fileLockStagingIdentityHash(`${namePid}:unknown`) ||
				(currentIdentity !== null &&
					nameOwner.identity.value === fileLockStagingIdentityHash(`${namePid}:${currentIdentity}`)));
		// Older publishers hashed `${pid}:${startTime}` or `${pid}:unknown` when
		// start-time evidence was unavailable. A later raw start-time mismatch is
		// not proof those already-running staging owners are dead.
		namePidStatus = currentIdentity === null || syntheticStartTimeFallback ? probe(namePid) : "dead";
	} else {
		namePidStatus = probe(namePid);
	}
	if (namePidStatus !== "dead") {
		// Do not open the publication source while its owner may be live. On Windows an
		// info-file handle can prevent the owner's atomic directory rename. Legacy names
		// without generation evidence and unknown liveness fail closed.
		return {
			...kept,
			pid: namePid,
			status: namePidStatus,
			reason: namePidStatus === "alive" ? "live_staging_name_owner" : "staging_name_owner_liveness_unknown",
		};
	}
	const captured = nativeFileLockBindings().snapshotDirectoryTree(canonical);
	if (
		!captured.ok ||
		!captured.snapshot ||
		captured.snapshot.rootDev !== canonicalLockDeviceId(root.dev).toString() ||
		captured.snapshot.rootIno !== canonicalLockFileId(root.ino).toString()
	)
		return kept;
	const observation = await readFileLockObservationForGc(canonical);
	let pid: number;
	let status: OwnerLiveness;
	if (observation) {
		if (
			observation.identity.rootDev !== captured.snapshot.rootDev ||
			observation.identity.rootIno !== captured.snapshot.rootIno
		)
			return kept;
		pid = observation.info.pid;
		if (
			nameOwner.ownerHostIdHash !== undefined &&
			(observation.info.owner_host_id === undefined ||
				nameOwner.ownerHostIdHash !== fileLockStagingIdentityHash(observation.info.owner_host_id))
		)
			return { ...kept, pid, reason: "host_qualified_staging_owner" };
		if (lockRecordIsForeignHost(observation.info, ownerHostId, previousOwnerHostIds))
			return { ...kept, pid, reason: "host_qualified_staging_owner" };
		status = fileLockStagingOwnerStatus(observation.info, pid === namePid ? namePidStatus : probe(pid));
	} else {
		// An empty or missing info file has no owner identity. Reclaim it only after
		// the directory and its empty info file, if any, have been unchanged long
		// enough for an interrupted publisher to be safely distinguished from a
		// slow or paused live owner. The staging name must also prove its host,
		// because the PID in a foreign host's name has no local liveness meaning.
		// Non-empty malformed info remains fail-closed.
		if (!nameHostIdentityIsLocal || !fileLockStagingIsOldUnverifiedDirectory(captured.snapshot))
			return { ...kept, pid: namePid, reason: "unverified_staging_directory" };
		pid = namePid;
		status = namePidStatus;
	}
	if (pid === process.pid && observation && !ownerIncarnationChanged(observation.info)) status = "alive";
	if (status === "alive" && observation && ownerIncarnationChanged(observation.info)) status = "dead";
	const result: FileLockStagingResult = {
		path: stagingPath,
		pid,
		status,
		removed: false,
		reason: observation ? `file_lock_staging_owner_${status}` : `unverified_staging_directory_owner_${status}`,
	};
	if (status !== "dead" || !remove) return result;
	if (path.basename(canonical).endsWith(FILE_LOCK_STAGING_REMOVING_SUFFIX)) {
		const removal = await exactRemoveLockTree(canonical, captured.snapshot);
		if (removal.ok || removal.code === "not_found") return { ...result, removed: true, reason: "removed" };
		const detachedTreeWasDurablyScrubbed =
			removal.code === "cleanup_pending" &&
			removal.payloadDurable === true &&
			removal.detachedPath !== undefined &&
			sameFileLockPath(removal.detachedPath, canonical) &&
			removal.retainedSuccessorPath === undefined &&
			removal.retainedPlaceholderPath === undefined &&
			removal.retainedUnknownPath === undefined &&
			Object.keys(removal).every(key => ["ok", "code", "payloadDurable", "detachedPath"].includes(key));
		if (detachedTreeWasDurablyScrubbed) {
			const removed = await removeDetachedLockQuarantineOnDisk(
				canonical,
				captured.snapshot.rootDev,
				captured.snapshot.rootIno,
			);
			return { ...result, removed, reason: removed ? "removed" : "cleanup_pending" };
		}
		return { ...result, reason: removal.code ?? "cleanup_failed" };
	}
	if (observation) {
		const removal = await removeFileLockDirForGc(canonical, observation.info, observation.identity);
		return { ...result, removed: removal === "removed", reason: removal };
	}
	const removal = await removeVerifiedLockDirWithoutNative(canonical, captured.snapshot);
	return { ...result, removed: removal === "removed", reason: removal };
}

/** Bounded opportunistic cleanup; the acquisition caller treats failures as diagnostic only. */
export async function reapOrphanedLockStagingDirs(
	lockPath: string,
	options: Pick<FileLockOptions, "ownerHostId" | "previousOwnerHostIds"> = {},
): Promise<{
	removed: string[];
	retained: FileLockStagingResult[];
}> {
	const summary: { removed: string[]; retained: FileLockStagingResult[] } = { removed: [], retained: [] };
	const parent = path.dirname(lockPath);
	const prefix = `${path.basename(lockPath)}.pending.`;
	const boundedPrefix = `.gjc-lock-${crypto.createHash("sha256").update(path.basename(lockPath)).digest("hex")}.pending.`;
	const candidates = (await fs.readdir(parent))
		.filter(
			entry =>
				(entry.startsWith(prefix) || entry.startsWith(boundedPrefix)) && fileLockStagingOwnerPid(entry) !== null,
		)
		.sort();
	if (candidates.length <= FILE_LOCK_STAGING_REAPER_BATCH_SIZE) fileLockStagingReaperCursors.delete(lockPath);
	let startIndex = 0;
	if (candidates.length > FILE_LOCK_STAGING_REAPER_BATCH_SIZE) {
		const cursor = fileLockStagingReaperCursors.get(lockPath);
		if (cursor !== undefined) {
			const nextIndex = candidates.findIndex(entry => entry > cursor);
			if (nextIndex >= 0) startIndex = nextIndex;
		} else {
			startIndex = crypto.randomInt(candidates.length);
		}
	}
	const inspected = Math.min(candidates.length, FILE_LOCK_STAGING_REAPER_BATCH_SIZE);
	for (let index = 0; index < inspected; index++) {
		const entry = candidates[(startIndex + index) % candidates.length]!;
		if (candidates.length > FILE_LOCK_STAGING_REAPER_BATCH_SIZE) {
			fileLockStagingReaperCursors.delete(lockPath);
			fileLockStagingReaperCursors.set(lockPath, entry);
			if (fileLockStagingReaperCursors.size > FILE_LOCK_STAGING_REAPER_MAX_CURSORS) {
				const oldestPath = fileLockStagingReaperCursors.keys().next().value;
				if (oldestPath !== undefined) fileLockStagingReaperCursors.delete(oldestPath);
			}
		}
		const result = await inspectFileLockStagingDir(
			path.join(parent, entry),
			ownerLiveness,
			true,
			options.ownerHostId,
			options.previousOwnerHostIds,
		);
		if (result.removed) summary.removed.push(result.path);
		else summary.retained.push(result);
	}
	return summary;
}
