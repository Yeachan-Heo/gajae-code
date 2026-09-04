import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
} from "@gajae-code/natives";
import {
	type GenericFileLockDirIdentity,
	genericFileLockDirStaleVerdict,
	processStartTime as portableProcessStartTime,
	readFileLockObservationForGc,
} from "../config/file-lock";
import { loadInstallationHostId, loadLegacyInstallationHostId } from "../config/machine-identity";
import { readLinuxProcStartTimeSync } from "./linux-proc";

/** SHA-256 of the empty payload; the constant identity of every verified-empty receipt. */
const EMPTY_FILE_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * The one lock implementation for a coordinator-shared session state file.
 *
 * The Coordinator MCP server and the runtime sidecar both read-modify-write the same
 * `session-states/<id>.json`, so they must contend on one lock with one on-disk owner
 * format. That format is the regular-file `<file>.lock` owner JSON the base Coordinator
 * wrote. The base RUNTIME did not use it: it guarded this path with the generic
 * directory-style lock, so a `<file>.lock/` DIRECTORY left by an older runtime is a real
 * on-disk shape this code still has to survive.
 *
 * Both shapes are therefore handled, and neither is guessed at: `lstat` decides which one
 * is present, a directory is evaluated by the generic protocol's own implementation, and
 * anything that is neither a regular file nor a directory fails closed — a symlink, FIFO,
 * socket, or device at this path is not a lock this code wrote, and reading or removing
 * it would follow an attacker-chosen target.
 */
const LOCK_ACQUIRE_RETRY_MS = 5;
const LOCK_ACQUIRE_MAX_RETRY_MS = 100;
const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const RELEASED_TRANSITION_GRACE_MS = 1_000;

interface LockRetryBudget {
	startedAt: number;
	nextDelayMs: number;
	attempts: number;
}

function lockRetryBudget(): LockRetryBudget {
	return { startedAt: performance.now(), nextDelayMs: LOCK_ACQUIRE_RETRY_MS, attempts: 0 };
}

function lockRetryElapsedMs(budget: LockRetryBudget): number {
	return Math.max(0, performance.now() - budget.startedAt);
}

function lockRetryExhausted(budget: LockRetryBudget): boolean {
	return lockRetryElapsedMs(budget) >= LOCK_ACQUIRE_TIMEOUT_MS;
}

async function waitForLockRetry(budget: LockRetryBudget): Promise<boolean> {
	budget.attempts++;
	const remainingMs = LOCK_ACQUIRE_TIMEOUT_MS - lockRetryElapsedMs(budget);
	if (remainingMs <= 0) return false;
	await Bun.sleep(Math.min(budget.nextDelayMs, remainingMs));
	budget.nextDelayMs = Math.min(LOCK_ACQUIRE_MAX_RETRY_MS, budget.nextDelayMs * 2);
	return lockRetryElapsedMs(budget) < LOCK_ACQUIRE_TIMEOUT_MS;
}

/**
 * The claim that serializes PATHNAME TRANSITIONS of `<file>.lock` among current writers.
 *
 * `<file>.lock` cannot serialize its own creation and removal on its own: a base writer
 * that only ever `open(..., "wx")`s the path is a real contender this protocol cannot
 * exclude, and interleaving its create with a reclaimer's delete is what corrupts
 * ownership. So every current transition of that pathname — acquire, stale reclaim,
 * write-failure cleanup, release — is made under this separate claim. Only pathname
 * bookkeeping happens inside it; the caller's state-file operation never does.
 *
 * The claim is an atomic empty directory at `<file>.lock.transition`; its machine-qualified
 * owner record is the sibling `<file>.lock.transition.owner`. `mkdir` admits exactly one
 * contender, while the held directory prevents a successor until release unlinks the
 * validated sidecar and atomically `rmdir`s the claim. A crash before either step leaves a
 * directory that a successor may reclaim only with proof: a host-qualified owner whose pid
 * is proven dead, plus an exact directory-generation and tree match at removal time.
 *
 * The separate sidecar keeps the claim directory empty, which is what makes `rmdir` the
 * identity-safe portable release primitive. The path stays distinct from `<file>.lock`
 * (whose regular-file owner format base writers read) and from the outer
 * `locks/mutation.lock` (whose generic directory semantics are unchanged).
 */
const LOCK_TRANSITION_RESOURCE_SUFFIX = ".transition";
const LINUX_PROC_START_TIME_FORMAT = "linux-proc-v1";
const PORTABLE_START_TIME_FORMAT = "ps-utc-v1";
const TRANSIENT_LOCK_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "sharing_violation"]);

interface TransitionDirectoryGeneration {
	dev: bigint;
	ino: bigint;
	mode: bigint;
	nlink: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

const TRANSITION_DIRECTORY_OPEN_FLAGS =
	fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0) | (fsSync.constants.O_NOFOLLOW ?? 0);

async function captureTransitionDirectoryGenerationFromHandle(
	handle: fs.FileHandle,
): Promise<TransitionDirectoryGeneration> {
	const stat = await handle.stat({ bigint: true });
	if (!stat.isDirectory()) throw new Error("Transition claim is no longer a directory.");
	return transitionGenerationFromStat(stat as fsSync.BigIntStats);
}

function transitionGenerationFromStat(stat: fsSync.BigIntStats): TransitionDirectoryGeneration {
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		nlink: stat.nlink,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

interface PendingTransitionRelease {
	phase: "setup" | "release";
	token: string;
	generation?: TransitionDirectoryGeneration;
	/** Physical claim pathname used for every native identity operation. */
	nativePath?: string;
	/** A no-follow descriptor captured immediately after mkdir. This remains the
	 * authority when setup generation capture itself faults or the pathname is
	 * replaced before recovery gets to run. */
	generationHandle?: fs.FileHandle;
	/** Descriptor retained when a rewrite fault defeats immediate repair. */
	repairHandle?: fs.FileHandle;
	repairBytes?: string;
	repairSnapshot?: LockOwnerSnapshot;
	held?: LockOwnerSnapshot;
	releasedOwner?: SessionStateLockOwner;
	recoverable: boolean;
	recovery?: Promise<boolean>;
}

interface LocalTransitionQueue {
	waiters: Array<() => void>;
}

const pendingTransitionReleases = new Map<string, PendingTransitionRelease>();
const localTransitionQueues = new Map<string, LocalTransitionQueue>();

async function joinLocalTransitionQueue(
	key: string,
	transitionDir: string,
	retryBudget?: LockRetryBudget,
): Promise<LocalTransitionQueue | undefined> {
	const queue = localTransitionQueues.get(key);
	if (!queue) return undefined;
	const ready = Promise.withResolvers<void>();
	const queuedAt = performance.now();
	SessionStateLockTestHooks.afterLocalTransitionQueued?.(transitionDir);
	queue.waiters.push(ready.resolve);
	await ready.promise;
	if (retryBudget) retryBudget.startedAt += Math.max(0, performance.now() - queuedAt);
	return queue;
}

function claimLocalTransitionQueue(key: string): LocalTransitionQueue {
	const queue: LocalTransitionQueue = { waiters: [] };
	localTransitionQueues.set(key, queue);
	return queue;
}

function releaseLocalTransitionQueue(key: string, queue: LocalTransitionQueue): void {
	const next = queue.waiters.shift();
	if (next) {
		next();
		return;
	}
	if (localTransitionQueues.get(key) === queue) localTransitionQueues.delete(key);
}

function clearPendingTransitionRelease(key: string, pending?: PendingTransitionRelease): void {
	const current = pendingTransitionReleases.get(key);
	if (pending !== undefined && current !== pending) return;
	pendingTransitionReleases.delete(key);
	const handle = (pending ?? current)?.generationHandle;
	if (handle) {
		(pending ?? current)!.generationHandle = undefined;
		void handle.close().catch(() => undefined);
	}
	const repairHandle = (pending ?? current)?.repairHandle;
	if (repairHandle) {
		(pending ?? current)!.repairHandle = undefined;
		void repairHandle.close().catch(() => undefined);
	}
}

async function repairPendingOwnerRecord(pending: PendingTransitionRelease): Promise<boolean> {
	const handle = pending.repairHandle;
	if (!handle || pending.repairBytes === undefined) return true;
	try {
		await writeOwnerBytes(handle, Buffer.from(pending.repairBytes, "utf8"));
		const stat = await handle.stat({ bigint: true });
		pending.repairSnapshot = ownerSnapshotFrom(stat, Buffer.from(pending.repairBytes, "utf8"));
		await handle.close();
		pending.repairHandle = undefined;
		return true;
	} catch {
		return false;
	}
}

async function ensureSessionStateParent(directory: string): Promise<void> {
	const missing: string[] = [];
	let current = path.resolve(directory);
	for (;;) {
		try {
			const existing = await fs.stat(current);
			if (!existing.isDirectory())
				throw Object.assign(new Error(`Session state parent is not a directory: ${current}.`), {
					code: "ENOTDIR",
					path: current,
				});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

function isTransientLockError(error: unknown): boolean {
	if (
		error !== null &&
		typeof error === "object" &&
		TRANSIENT_LOCK_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "")
	)
		return true;
	return error instanceof Error && isTransientLockError(error.cause);
}

function transientNativeResultError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`Native lock operation is transiently unavailable: ${code}.`), { code });
}

async function removeTransitionDir(transitionDir: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rmdir(transitionDir);
			return;
		} catch (error) {
			if (!isTransientLockError(error) || attempt >= 4) throw error;
			await Bun.sleep(LOCK_ACQUIRE_RETRY_MS);
		}
	}
}

function removeOwnedTransitionClaim(nativePath: string, generation: TransitionDirectoryGeneration): boolean {
	const native = nativeSessionStateLock();
	const captured = native.snapshotDirectoryTree(nativePath);
	if (!captured.ok || !captured.snapshot) return captured.code === "not_found";
	const root = captured.snapshot.entries.find(entry => entry.relativePath === "");
	if (
		root?.kind !== "directory" ||
		root.dev !== String(generation.dev) ||
		root.ino !== String(generation.ino) ||
		root.nlink !== String(generation.nlink) ||
		root.mtimeNs !== String(generation.mtimeNs) ||
		root.ctimeNs !== String(generation.ctimeNs)
	)
		return false;
	const removed = native.exactRemoveDirectoryTree(nativePath, captured.snapshot);
	return (
		removed.ok ||
		removed.code === "not_found" ||
		(removed.code === "cleanup_pending" &&
			removed.payloadDurable === true &&
			removed.detachedPath === `${nativePath}.removing` &&
			removed.retainedSuccessorPath === undefined &&
			removed.retainedUnknownPath === undefined &&
			removed.retainedPlaceholderPath === undefined)
	);
}

async function transitionRecoveryKey(transitionDir: string): Promise<string> {
	try {
		return path.normalize(await fs.realpath(transitionDir));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && !isTransientLockError(error)) throw error;
	}
	const parent = path.dirname(transitionDir);
	let canonicalParent: string;
	try {
		canonicalParent = await fs.realpath(parent);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && !isTransientLockError(error)) throw error;
		canonicalParent = path.resolve(parent);
	}
	return path.normalize(path.join(canonicalParent, path.basename(transitionDir)));
}

/** Resolve the owned claim to its physical path while it is still present. */
async function canonicalOwnedTransitionPath(transitionDir: string): Promise<string> {
	return path.normalize(await fs.realpath(transitionDir));
}

function sameTransitionGeneration(left: TransitionDirectoryGeneration, right: TransitionDirectoryGeneration): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

interface SessionStateLockOwner {
	pid: number;
	start_time: string;
	start_time_format?: string;
	token: string;
	owner_host_id?: string;
	released?: true;
}

type OwnerRewriteFailure = Error & {
	repairSnapshot?: LockOwnerSnapshot;
	repairHandle?: fs.FileHandle;
	repairBytes?: string;
};

/**
 * How a `<file>.lock` owner record can be opened safely on this platform.
 *
 * `posix-nofollow` proves the object's TYPE from the descriptor the bytes come off, so the
 * pathname can change freely without ever being followed. Windows has neither `O_NOFOLLOW`
 * nor `O_NONBLOCK`, so no such descriptor exists there and `windows-validated` brackets the
 * open with `lstat`/`fstat` identity proofs instead. `unsupported` is neither, and the
 * owner protocol fails closed rather than reading a pathname it cannot vouch for.
 */
export type SessionStateLockOwnerAccessStrategy = "posix-nofollow" | "windows-validated" | "unsupported";

const POSIX_NOFOLLOW_AVAILABLE =
	typeof fsSync.constants.O_NOFOLLOW === "number" && typeof fsSync.constants.O_NONBLOCK === "number";

/**
 * Select the safe owner-record access protocol for one platform/runtime pair.
 *
 * Platform identity comes first. A win32 runtime may expose numeric compatibility constants
 * without providing POSIX no-follow semantics, so their mere presence must never select the
 * POSIX path there.
 *
 * @internal Pure seam for cross-platform detection tests.
 */
export function detectedSessionStateLockOwnerAccessStrategy(
	platform: NodeJS.Platform,
	posixNoFollowAvailable: boolean,
): SessionStateLockOwnerAccessStrategy {
	if (platform === "win32") return "windows-validated";
	return posixNoFollowAvailable ? "posix-nofollow" : "unsupported";
}

const DETECTED_OWNER_ACCESS_STRATEGY = detectedSessionStateLockOwnerAccessStrategy(
	process.platform,
	POSIX_NOFOLLOW_AVAILABLE,
);

/**
 * Test seams for the windows a reclaim passes through: the moment the path's TYPE has just
 * been decided and its owner has not been read yet, the stale verdict, and the FINAL
 * identity validation immediately before the unlink. Production code never sets them.
 */
export const SessionStateLockTestHooks: {
	afterLockTypeDecision?: (lockFile: string) => void | Promise<void>;
	afterStaleInspection?: (lockFile: string) => void | Promise<void>;
	beforeStaleRemoval?: (lockFile: string) => void | Promise<void>;
	afterTransitionStaleInspection?: (transitionFile: string) => void | Promise<void>;
	beforeTransitionStaleRemoval?: (transitionFile: string) => void | Promise<void>;
	afterLegacyDirectoryStaleVerdict?: (lockDir: string) => void | Promise<void>;
	/**
	 * @internal Which owner-access strategy to exercise, so the Windows path can be proved
	 * on the test filesystem this suite actually runs on. Production code never sets it,
	 * and it is never serialized or exposed as runtime configuration.
	 */
	ownerAccessStrategy?: SessionStateLockOwnerAccessStrategy;
	/**
	 * @internal How an owner pid is probed for liveness. Whether a signal is permitted is a
	 * property of the OS and this process's privileges, so it cannot be arranged on disk.
	 * Production code never sets it, and it is never serialized or exposed as runtime
	 * configuration.
	 */
	probeProcessSignal?: (pid: number) => void;
	/**
	 * @internal Runs inside a NEW owner record's write, after the exclusive create has
	 * taken the pathname and before the record's bytes land. Throwing from it fails that
	 * write exactly as an I/O fault does, which is the only deterministic way to reach the
	 * write-failure cleanup and prove what that cleanup is authorized to delete.
	 * Production code never sets it, and it is never serialized or exposed as runtime
	 * configuration.
	 */
	ownerRecordWriteFault?: (file: string) => void | Promise<void>;
	/** @internal Stable host identity seam for shared-volume ownership tests. */
	ownerHostId?: () => string | Promise<string>;
	/** @internal Installation identity loader seam for cache retry tests. */
	loadInstallationHostId?: () => Promise<string>;
	/** @internal Previous identity seam for upgrade recovery tests. */
	legacyOwnerHostId?: () => string | Promise<string>;
	/** @internal Lets legacy same-host fixtures exercise their pre-qualification paths. */
	unqualifiedOwnerIsLocal?: boolean;
	/** @internal Runs after final live-owner validation and before descriptor rewrite. */
	afterCurrentOwnerValidation?: (file: string) => void | Promise<void>;
	/** @internal Fault seam immediately before a held owner record rewrite mutates bytes. */
	beforeOwnerRecordRewrite?: (file: string) => void | Promise<void>;
	/** @internal Fault seam immediately before final transition-generation validation. */
	beforeTransitionReleaseLstat?: (transitionDir: string) => void | Promise<void>;
	/** @internal Fault seam immediately before setup generation capture. */
	beforeTransitionSetupLstat?: (transitionDir: string) => void | Promise<void>;
	/**
	 * @internal Runs after a live owner has been proven and immediately before its
	 * final pathname capture for release. Tests use it to replace the pathname and
	 * prove that live-owner cleanup refuses a successor.
	 */
	beforeCurrentOwnerRelease?: (file: string) => void | Promise<void>;
	beforeLegacyDirectoryRemoval?: (lockDir: string) => void | Promise<void>;
	/** @internal Last quarantine name minted in the current lock cycle (tests). */
	lastQuarantineName?: string;
	/** @internal Count of quarantine names minted in the current lock cycle (tests). */
	quarantineMints?: number;
	/** @internal Force the next mint to this name so leftover-collision tests can plant it. */
	forcedQuarantineName?: string;
	/** @internal Observes bounded acquisition retries without changing their timing. */
	afterAcquireContention?: (lockFile: string, attempt: number, elapsedMs: number) => void;
	/** @internal Observes process-local admission without altering on-disk ownership. */
	afterLocalTransitionQueued?: (transitionDir: string) => void;
	/** @internal Runs after transition mkdir contention and before stale-claim inspection. */
	afterTransitionClaimContention?: (transitionDir: string) => void | Promise<void>;
} = {};

/** Raised when the lock could not be acquired; callers map it to their own refusal. */
export type SessionStateLockUnavailableReason =
	| "acquire_timeout"
	| "legacy_directory_owner_unprovenanced"
	| "lock_initialization_failed"
	| "lock_inspection_failed"
	| "lock_owner_live_or_unverifiable"
	| "lock_owner_record_fresh"
	| "lock_owner_record_unprovenanced"
	| "lock_release_failed"
	| "transition_claim_timeout"
	| "unsafe_lock_path_type";

interface SessionStateLockUnavailableDetails {
	lockPath: string;
	reason: SessionStateLockUnavailableReason;
	attempts?: number;
	elapsedMs?: number;
	cause?: unknown;
}

export class SessionStateLockUnavailableError extends Error {
	readonly lockPath?: string;
	readonly reason?: SessionStateLockUnavailableReason;
	readonly attempts?: number;
	readonly elapsedMs?: number;

	constructor(causeOrDetails?: unknown | SessionStateLockUnavailableDetails) {
		const details =
			causeOrDetails !== null &&
			typeof causeOrDetails === "object" &&
			"lockPath" in causeOrDetails &&
			"reason" in causeOrDetails
				? (causeOrDetails as SessionStateLockUnavailableDetails)
				: undefined;
		super(
			details
				? `Coordinator session state lock is unavailable at ${details.lockPath}: ${details.reason}.`
				: "Coordinator session state lock is unavailable.",
		);
		this.name = "SessionStateLockUnavailableError";
		if (details) {
			this.lockPath = details.lockPath;
			this.reason = details.reason;
			this.attempts = details.attempts;
			this.elapsedMs = details.elapsedMs;
			if (details.cause !== undefined) this.cause = details.cause;
		} else if (causeOrDetails !== undefined) {
			this.cause = causeOrDetails;
		}
	}
}

/**
 * Log fields describing a persist failure: the error text plus, when a session state
 * lock refusal sits anywhere in the cause chain, its typed `reason` and `lockPath`.
 * Wrapping errors (`PreviousRuntimeStateReadError`, `AggregateError`) are searched
 * so the actionable detail is never buried behind a generic message.
 */
export function sessionStateLockFailureFields(error: unknown): {
	error: string;
	reason?: SessionStateLockUnavailableReason;
	lockPath?: string;
} {
	const fields: { error: string; reason?: SessionStateLockUnavailableReason; lockPath?: string } = {
		error: String(error),
	};
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === null || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		if (current instanceof SessionStateLockUnavailableError) {
			if (current.reason !== undefined) fields.reason = current.reason;
			if (current.lockPath !== undefined) fields.lockPath = current.lockPath;
			if (fields.reason !== undefined && fields.lockPath !== undefined) return fields;
		}
		if (current instanceof AggregateError) queue.push(...current.errors);
		if ("cause" in current) queue.push((current as { cause?: unknown }).cause);
	}
	return fields;
}

function boundedPersistFailureClassPart(value: unknown, fallback: string): string {
	if (typeof value !== "string" && typeof value !== "number") return fallback;
	const normalized = String(value)
		.replace(/[^A-Za-z0-9_.-]/gu, "_")
		.slice(0, 64);
	return normalized || fallback;
}

function persistFailureProperty(value: unknown, name: string): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
	try {
		return Reflect.get(value, name);
	} catch {
		return undefined;
	}
}

function persistFailureConstructorName(error: unknown): string {
	if (error === null) return "null";
	if (typeof error !== "object" && typeof error !== "function") return typeof error;
	const ctor = persistFailureProperty(error, "constructor");
	const name = persistFailureProperty(ctor, "name");
	return typeof name === "string" && name.length > 0 ? name : "Object";
}

/**
 * Build a bounded warn-window partition without including arbitrary error text. Typed lock
 * refusals use their stable reason; all other failures use the root constructor and the
 * first structured `code`/`errno` found in the error/cause chain.
 */
function persistFailureClass(error: unknown): string {
	const lockFields = sessionStateLockFailureFields(error);
	if (lockFields.reason !== undefined) return `reason:${lockFields.reason}`;
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];
	let code: unknown;
	let errno: unknown;
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === null || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		code ??= persistFailureProperty(current, "code");
		errno ??= persistFailureProperty(current, "errno");
		if (code !== undefined && errno !== undefined) break;
		if (current instanceof AggregateError) queue.push(...current.errors);
		const cause = persistFailureProperty(current, "cause");
		if (cause !== undefined) queue.push(cause);
	}
	return `error:${boundedPersistFailureClassPart(persistFailureConstructorName(error), "Object")}:code=${boundedPersistFailureClassPart(code, "none")}:errno=${boundedPersistFailureClassPart(errno, "none")}`;
}

export const PERSIST_FAILURE_WARN_WINDOW_MS = 30_000;
const persistFailureLastWarnedAt = new Map<string, number>();

/**
 * Whether a persist failure should be logged at warn level. The first failure for each
 * document and stable failure class in a 30s window warns; repeats are the caller's cue
 * to log at debug instead.
 */
export function shouldWarnPersistFailure(key: string, error: unknown, now = Date.now()): boolean {
	for (const [otherKey, warnedAt] of persistFailureLastWarnedAt) {
		if (now - warnedAt >= PERSIST_FAILURE_WARN_WINDOW_MS) persistFailureLastWarnedAt.delete(otherKey);
	}
	const scopedKey = `${key}\u0000${persistFailureClass(error)}`;
	const last = persistFailureLastWarnedAt.get(scopedKey);
	if (last !== undefined && now - last < PERSIST_FAILURE_WARN_WINDOW_MS) return false;
	persistFailureLastWarnedAt.set(scopedKey, now);
	return true;
}

/** @internal Test seam: forget every persist-failure warn window. */
export function resetPersistFailureWarnWindows(): void {
	persistFailureLastWarnedAt.clear();
}

function lockUnavailable(
	lockPath: string,
	reason: SessionStateLockUnavailableReason,
	budget?: LockRetryBudget,
	cause?: unknown,
): SessionStateLockUnavailableError {
	return new SessionStateLockUnavailableError({
		lockPath,
		reason,
		...(budget ? { attempts: budget.attempts + 1, elapsedMs: Math.round(lockRetryElapsedMs(budget)) } : {}),
		...(cause === undefined ? {} : { cause }),
	});
}

function lockDiagnostic(
	error: unknown,
	lockPath: string,
	reason: SessionStateLockUnavailableReason,
	budget?: LockRetryBudget,
): unknown {
	if (!(error instanceof SessionStateLockUnavailableError) || error.lockPath !== undefined) return error;
	return lockUnavailable(lockPath, reason, budget, error.cause ?? error);
}

/**
 * The identity-bound deletion primitives this lock is built on.
 *
 * There is no portable atomic compare-and-delete in `fs`: validating a record and then
 * unlinking its PATHNAME is always two syscalls, and a successor that claims the path in
 * between loses its brand-new lock to the first reclaimer. These natives close that hole
 * for real — every removal is descriptor-relative, no-follow, and refuses unless the
 * object still carries the exact `dev`/`ino`/`nlink`/`size`/`mtimeNs`/SHA-256 identity the
 * caller proved. A replacement is therefore never deleted, by construction rather than by
 * a narrower window.
 */
export type SessionStateLockNativeBindings = Pick<
	typeof import("@gajae-code/natives"),
	"exactRemoveDirectoryTree" | "exactUnlink" | "exactUnlinkDirect" | "snapshotDirectoryTree"
>;

/** How the deletion primitives are obtained. Throwing means they are unavailable. */
type SessionStateLockNativeLoader = () => SessionStateLockNativeBindings;

let injectedNativeLoader: SessionStateLockNativeLoader | undefined;
let loadedNativeBindings: SessionStateLockNativeBindings | undefined;

/**
 * @internal The seam focused TS tests bind a faithful in-process implementation to.
 *
 * It exists because the deletion contract — "refuse unless the object on disk still has
 * exactly this identity" — is the thing under test, and a test double that merely reports
 * success would assert nothing.
 *
 * A LOADER rather than a value, so the unavailable case needs no special production
 * branch: a loader that throws is indistinguishable from an addon that will not load,
 * which is the only way to observe that path where the addon is present. Passing
 * `undefined` restores the real addon.
 */
export function setSessionStateLockNativeBindings(load: SessionStateLockNativeLoader | undefined): void {
	injectedNativeLoader = load;
}

/**
 * Resolve the deletion primitives, loading the addon on first real use.
 *
 * @throws {SessionStateLockUnavailableError} when they cannot be loaded. There is no
 * `fs.rm` fallback: an unavailable identity-bound delete means this process cannot prove
 * what it would be deleting, and deleting anyway is the exact defect these primitives fix.
 */
function nativeSessionStateLock(): SessionStateLockNativeBindings {
	try {
		if (injectedNativeLoader) return injectedNativeLoader();
		if (!loadedNativeBindings)
			loadedNativeBindings = require("@gajae-code/natives") as SessionStateLockNativeBindings;
		return loadedNativeBindings;
	} catch (error) {
		throw error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error);
	}
}

/**
 * Start time stamped into a NEW owner record.
 *
 * Linux `/proc` is preferred because it is the value base owners on that platform were
 * written from, so a base reader still recognizes this incarnation. Everywhere else the
 * portable `ps` value is used instead of giving up and writing `unknown`, which would
 * make PID reuse undetectable.
 */
function ownerStartIdentity(pid: number): { start_time: string; start_time_format?: string } {
	const procStartTime = readLinuxProcStartTimeSync(pid);
	if (procStartTime !== null) return { start_time: procStartTime, start_time_format: LINUX_PROC_START_TIME_FORMAT };
	const portableStartTime = portableProcessStartTime(pid);
	if (portableStartTime !== null)
		return { start_time: portableStartTime, start_time_format: PORTABLE_START_TIME_FORMAT };
	return { start_time: "unknown" };
}

function validLockOwner(value: unknown): value is SessionStateLockOwner {
	if (!value || typeof value !== "object") return false;
	const owner = value as Partial<SessionStateLockOwner>;
	const startTimeFormatValid =
		owner.start_time_format === undefined ||
		owner.start_time_format === LINUX_PROC_START_TIME_FORMAT ||
		owner.start_time_format === PORTABLE_START_TIME_FORMAT;
	return (
		typeof owner.pid === "number" &&
		Number.isSafeInteger(owner.pid) &&
		owner.pid > 0 &&
		typeof owner.start_time === "string" &&
		startTimeFormatValid &&
		typeof owner.token === "string" &&
		owner.token.length > 0 &&
		(owner.owner_host_id === undefined ||
			(typeof owner.owner_host_id === "string" && owner.owner_host_id.length > 0)) &&
		(owner.released === undefined || owner.released === true)
	);
}

let ownerHostIdPromise: Promise<string> | undefined;
let ownerHostIdLoader: (() => Promise<string>) | undefined;
let legacyOwnerHostIdPromise: Promise<string> | undefined;

async function currentOwnerHostId(): Promise<string> {
	try {
		let hostId: string;
		if (SessionStateLockTestHooks.ownerHostId) {
			hostId = await SessionStateLockTestHooks.ownerHostId();
		} else {
			const loader = SessionStateLockTestHooks.loadInstallationHostId ?? loadInstallationHostId;
			if (ownerHostIdLoader !== loader) {
				ownerHostIdLoader = loader;
				ownerHostIdPromise = undefined;
			}
			const promise = ownerHostIdPromise ?? loader();
			ownerHostIdPromise = promise;
			try {
				hostId = await promise;
			} catch (error) {
				if (ownerHostIdPromise === promise) ownerHostIdPromise = undefined;
				throw error;
			}
		}
		if (!hostId) throw new Error("Host identity is unavailable.");
		return hostId;
	} catch (error) {
		throw error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error);
	}
}

async function currentLegacyOwnerHostId(): Promise<string> {
	if (SessionStateLockTestHooks.legacyOwnerHostId) return await SessionStateLockTestHooks.legacyOwnerHostId();
	const promise = legacyOwnerHostIdPromise ?? loadLegacyInstallationHostId();
	legacyOwnerHostIdPromise = promise;
	try {
		return await promise;
	} catch (error) {
		if (legacyOwnerHostIdPromise === promise) legacyOwnerHostIdPromise = undefined;
		throw error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error);
	}
}

/**
 * Whether the process holding `owner` is still the incarnation that took the lock.
 *
 * Owner records exist in three vintages: base `unknown`, base Linux `/proc` ticks, and
 * the portable `ps` timestamp written today. A recorded value matching EITHER reader is
 * the same incarnation. Only when a reader actually produced a value and NO reader agreed
 * is the mismatch proved — an unreadable or unknown start time is indeterminate, and
 * indeterminate never means "safe to steal".
 */
function sameOwnerIncarnation(owner: SessionStateLockOwner): boolean {
	if (owner.start_time === "unknown" || owner.start_time.length === 0) return true;
	const procStartTime = readLinuxProcStartTimeSync(owner.pid);
	const psStartTime = portableProcessStartTime(owner.pid);
	if (owner.start_time_format === LINUX_PROC_START_TIME_FORMAT)
		return procStartTime === null || procStartTime === owner.start_time;
	if (owner.start_time_format === PORTABLE_START_TIME_FORMAT)
		return psStartTime === null || psStartTime === owner.start_time;
	if (procStartTime !== null && procStartTime === owner.start_time) return true;
	if (psStartTime !== null && psStartTime === owner.start_time) return true;
	// Legacy records do not identify the encoding of their ps timestamp. A mismatch
	// may be only a caller timezone/locale change, so an alive unversioned owner is
	// never reclaimable on identity mismatch.
	return true;
}

/**
 * What one liveness probe of an owner pid can prove.
 *
 * `process.kill(pid, 0)` answers three different questions at once and only ONE of its
 * answers means the owner is gone. `ESRCH` is that proof. `EPERM` is its opposite — the
 * process exists, this one just may not signal it, which is the ordinary answer for an
 * owner running as another user, under a different container UID, or behind a sandbox
 * policy. Anything else is a question the OS declined to answer.
 *
 * The generic `mutation.lock` protocol classifies the same three answers, but its helper is
 * private to that protocol and takes no probe seam; duplicating the classification here
 * keeps this lock's semantics provable without widening the generic lock's surface.
 */
type OwnerProcessLiveness = "alive" | "dead" | "unknown";

function probeOwnerProcess(pid: number): OwnerProcessLiveness {
	try {
		const probe = SessionStateLockTestHooks.probeProcessSignal;
		if (probe) probe(pid);
		else process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		return code === "EPERM" ? "alive" : "unknown";
	}
}

/**
 * Whether the lock at hand still has an owner, for reclaim purposes.
 *
 * Only `dead` — a probe that PROVED the pid is gone, or a live pid whose recorded
 * incarnation is provably not the one running — ever authorizes deleting the record.
 * `unknown` liveness is reported as an owner, because a probe the OS refused to answer is
 * not evidence of death, and the exact-identity unlink cannot undo a false verdict: the
 * record still is the record that was judged, so the compare-and-delete matches and a live
 * holder loses its lock.
 */
async function lockOwnerIsAlive(value: unknown): Promise<boolean> {
	if (!validLockOwner(value)) return false;
	const owner = value;
	if (owner.owner_host_id === undefined) {
		if (SessionStateLockTestHooks.unqualifiedOwnerIsLocal !== true) return true;
	} else if (owner.owner_host_id !== (await currentOwnerHostId())) {
		if (owner.owner_host_id !== (await currentLegacyOwnerHostId())) return true;
	}
	// PID and process-start values are host-local. A current writer on a shared
	// volume must never classify a foreign owner from a local ESRCH result.
	const liveness = probeOwnerProcess(owner.pid);
	if (liveness === "dead") return false;
	if (liveness === "unknown") return true;
	return sameOwnerIncarnation(owner);
}

type MalformedOwnerProvenance = "dead_local" | "live_or_unverifiable" | "unprovenanced";

/**
 * Recognize only the historical near-owner shape that current writers never emit:
 * every ownership field is valid, but `released: false` makes the record malformed.
 * Host qualification plus a dead-pid proof makes stale reclamation safe; every other
 * malformed payload remains unprovenanced and fail-closed.
 */
async function malformedOwnerProvenance(value: unknown): Promise<MalformedOwnerProvenance> {
	if (SessionStateLockTestHooks.unqualifiedOwnerIsLocal === true) return "dead_local";
	if (!value || typeof value !== "object" || Array.isArray(value)) return "unprovenanced";
	const owner = value as Partial<Omit<SessionStateLockOwner, "released">> & { released?: unknown };
	if (
		typeof owner.pid !== "number" ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid <= 0 ||
		typeof owner.start_time !== "string" ||
		owner.start_time.length === 0 ||
		typeof owner.token !== "string" ||
		owner.token.length === 0 ||
		owner.released !== false ||
		(owner.start_time_format !== undefined &&
			owner.start_time_format !== LINUX_PROC_START_TIME_FORMAT &&
			owner.start_time_format !== PORTABLE_START_TIME_FORMAT)
	)
		return "unprovenanced";
	if (owner.owner_host_id === undefined) return "unprovenanced";
	if (
		owner.owner_host_id !== (await currentOwnerHostId()) &&
		owner.owner_host_id !== (await currentLegacyOwnerHostId())
	) {
		return "unprovenanced";
	}
	return probeOwnerProcess(owner.pid) === "dead" ? "dead_local" : "live_or_unverifiable";
}

/**
 * The immutable identity of the EXACT owner bytes one decision was made from.
 *
 * Every field is read from the descriptor the bytes came off, never re-derived from the
 * pathname afterwards, so it names one inode incarnation and one payload. `sha256` is over
 * the bytes that were actually read, which is what makes "the record I judged" and "the
 * record I am about to delete" the same provable object rather than the same string.
 */
interface LockOwnerSnapshot {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	sha256: string;
	bytes: string;
}

/**
 * No-follow, non-blocking read flags.
 *
 * `lstat` deciding the path is a regular file and a later `readFile(path)` are two
 * syscalls on a MUTABLE pathname: in between, the path can become a symlink whose target
 * this process would then read and reclaim, or a FIFO whose open never returns. Opening
 * `O_RDONLY | O_NONBLOCK | O_NOFOLLOW` once and proving the TYPE from that descriptor
 * removes the window entirely — a link refuses to open, a writerless FIFO opens without
 * blocking and is then rejected by `fstat`.
 */
const POSIX_OWNER_READ_FLAGS = POSIX_NOFOLLOW_AVAILABLE
	? fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK | fsSync.constants.O_NOFOLLOW
	: undefined;

/** Which strategy the owner protocol runs under right now. */
function ownerAccessStrategy(): SessionStateLockOwnerAccessStrategy {
	return SessionStateLockTestHooks.ownerAccessStrategy ?? DETECTED_OWNER_ACCESS_STRATEGY;
}

/** Whether two stat results name the same regular-file incarnation. */
function sameRegularFileIdentity(left: fsSync.BigIntStats, right: fsSync.BigIntStats): boolean {
	return (
		left.isFile() &&
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

function ownerSnapshotFrom(stat: fsSync.BigIntStats, bytes: Buffer): LockOwnerSnapshot {
	return {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.toString("utf8"),
	};
}

/** Capture the owner record through a descriptor whose no-follow type proof is its own. */
async function capturePosixLockOwner(lockFile: string, flags: number): Promise<LockOwnerSnapshot | null> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(lockFile, flags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		// `ELOOP` is the no-follow refusal itself; every other failure is equally unproven.
		throw new SessionStateLockUnavailableError(error);
	}
	try {
		const opened = await handle.stat({ bigint: true });
		// Proved from the open descriptor, so this is the type of the object being read —
		// not the type some earlier `lstat` saw at a pathname that has since moved on.
		if (!opened.isFile())
			throw new SessionStateLockUnavailableError(new Error("Lock path is not a regular owner file."));
		const bytes = await handle.readFile();
		const settled = await handle.stat({ bigint: true });
		// The identity must bracket the read: a record rewritten while it was being read
		// has no single payload, so it is reported as nothing rather than mis-identified.
		if (!sameRegularFileIdentity(opened, settled) || settled.size !== BigInt(bytes.byteLength)) return null;
		return ownerSnapshotFrom(settled, bytes);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Capture the owner record where no no-follow descriptor exists.
 *
 * Windows offers neither `O_NOFOLLOW` nor `O_NONBLOCK`, so the type cannot be proved by
 * the open itself. It is proved around it instead: an `lstat` BEFORE the open must already
 * show a regular file, the opened descriptor's own `fstat` and a second `lstat` must both
 * still be that same regular-file incarnation, and only then are any bytes read — from the
 * handle, never from the pathname. A reparse point, a type swap, or an inode substitution
 * anywhere in that bracket refuses or reports nothing, so no foreign object is ever read
 * through and none is ever attributed an identity that could authorize its removal.
 *
 * This is selected only under the win32 strategy. It makes no claim about Unix FIFOs: a
 * blocking open is precisely what `O_NONBLOCK` exists for, and that flag is what POSIX
 * keeps.
 */
async function captureWindowsLockOwner(lockFile: string, flags: number): Promise<LockOwnerSnapshot | null> {
	let before: fsSync.BigIntStats;
	try {
		before = await fs.lstat(lockFile, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new SessionStateLockUnavailableError(error);
	}
	if (before.isSymbolicLink())
		throw new SessionStateLockUnavailableError(new Error("Lock path is a reparse point, not an owner file."));
	if (!before.isFile())
		throw new SessionStateLockUnavailableError(new Error("Lock path is not a regular owner file."));
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(lockFile, flags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new SessionStateLockUnavailableError(error);
	}
	try {
		const opened = await handle.stat({ bigint: true });
		const relinked = await fs.lstat(lockFile, { bigint: true }).catch(() => null);
		if (relinked?.isSymbolicLink() === true)
			throw new SessionStateLockUnavailableError(new Error("Lock path became a reparse point under the read."));
		// The open landed on the object the pre-`lstat` judged, and the pathname still
		// names it. Either disagreement means the bytes have no attributable identity.
		if (!sameRegularFileIdentity(before, opened)) return null;
		if (!relinked || !sameRegularFileIdentity(before, relinked)) return null;
		const bytes = await handle.readFile();
		const settled = await handle.stat({ bigint: true });
		if (!sameRegularFileIdentity(opened, settled) || settled.size !== BigInt(bytes.byteLength)) return null;
		return ownerSnapshotFrom(settled, bytes);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Capture the regular `<file>.lock` owner record, or prove nothing is there to capture.
 *
 * @returns `null` when the path holds no record this call can speak for: it is absent, or
 * it changed underneath the read, so no identity can be attributed to the bytes obtained.
 * @throws {SessionStateLockUnavailableError} when the path is occupied by something the
 * owner protocol never writes, or when no strategy can read one safely here. Nothing is
 * read through it and nothing is removed.
 */
async function captureRegularLockOwner(lockFile: string): Promise<LockOwnerSnapshot | null> {
	const strategy = ownerAccessStrategy();
	if (strategy === "windows-validated") return await captureWindowsLockOwner(lockFile, fsSync.constants.O_RDONLY);
	if (strategy === "posix-nofollow" && POSIX_OWNER_READ_FLAGS !== undefined)
		return await capturePosixLockOwner(lockFile, POSIX_OWNER_READ_FLAGS);
	throw new SessionStateLockUnavailableError(new Error("No-follow owner reads are unsupported on this platform."));
}

/** Whether two captures name the same inode incarnation holding the same bytes. */
function sameLockOwnerSnapshot(left: LockOwnerSnapshot, right: LockOwnerSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

function sameLockOwnerObject(left: LockOwnerSnapshot, right: LockOwnerSnapshot): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

/**
 * What an identity-bound removal is allowed to conclude.
 *
 * `refused` is the safety verdict and is never treated as progress: the canonical pathname
 * was not provably detached, so it may still hold an object this process does not own.
 */
type ExactRemovalOutcome = "removed" | "absent" | "identity_mismatch" | "refused";

/**
 * A single-component quarantine destination, required by the native primitive so that
 * authority over a detached record survives a crash between detach and unlink.
 */
function lockQuarantineName(existing?: string): string {
	const name =
		existing ??
		SessionStateLockTestHooks.forcedQuarantineName ??
		`.gjc-delete-session-state-lock-${randomUUID()}.json`;
	if (!existing) {
		SessionStateLockTestHooks.lastQuarantineName = name;
		SessionStateLockTestHooks.quarantineMints = (SessionStateLockTestHooks.quarantineMints ?? 0) + 1;
	}
	return name;
}

/**
 * Delete the regular owner record at `file`, but only while it is still EXACTLY `identity`.
 *
 * @throws {SessionStateLockUnavailableError} when the primitive itself cannot run. It is
 * never downgraded to `fs.rm`: not knowing what is at the pathname is precisely the state
 * in which deleting it destroys a successor's lock.
 */
function exactUnlinkOwnerRecord(
	file: string,
	identity: LockOwnerSnapshot,
	quarantineName: string,
): ExactRemovalOutcome {
	let result: NativeExactUnlinkResult;
	try {
		result = nativeSessionStateLock().exactUnlink(file, {
			dev: identity.dev,
			ino: identity.ino,
			nlink: identity.nlink,
			size: identity.size,
			mtimeNs: identity.mtimeNs,
			sha256: identity.sha256,
			quarantineName,
		});
	} catch (error) {
		throw new SessionStateLockUnavailableError(error);
	}
	if (result.ok) return "removed";
	if (result.code === "not_found") return "absent";
	if (result.code === "identity_mismatch") return "identity_mismatch";
	// `cleanup_pending` means the canonical name WAS detached and only the quarantined
	// copy of our own record is still around, so the pathname is free — but only when the
	// retained artifact is durable and no successor or unidentified object was retained.
	// Any retained successor makes this a refusal: the pathname is not ours to reuse.
	if (
		result.code === "cleanup_pending" &&
		result.payloadDurable === true &&
		result.detachedPath !== undefined &&
		result.retainedSuccessorPath === undefined &&
		result.retainedUnknownPath === undefined
	)
		return "removed";
	return "refused";
}

/**
 * Flags for taking an owner record: create it or fail, and never through a link.
 *
 * `O_EXCL` is what makes the claim exclusive, and `O_NOFOLLOW` is what keeps a pre-planted
 * symlink at the path from turning that create into a write somewhere else.
 *
 * Windows has no `O_NOFOLLOW`, but it does not need one here: create-new semantics refuse
 * ANY pre-existing final component, symlink and reparse point included, so the create can
 * only ever land on an object this call brought into existence. The identity is then taken
 * from that writing handle, so the record authorized for removal is the one just written
 * rather than whatever the pathname resolves to afterwards.
 */
const POSIX_OWNER_CREATE_FLAGS =
	typeof fsSync.constants.O_NOFOLLOW === "number"
		? fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW
		: undefined;

const CREATE_NEW_OWNER_FLAGS = fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY;

function ownerCreateFlags(): number | undefined {
	const strategy = ownerAccessStrategy();
	if (strategy === "windows-validated") return CREATE_NEW_OWNER_FLAGS;
	return strategy === "posix-nofollow" ? POSIX_OWNER_CREATE_FLAGS : undefined;
}

async function newLockOwner(): Promise<SessionStateLockOwner> {
	const identity = ownerStartIdentity(process.pid);
	return {
		pid: process.pid,
		...identity,
		token: randomUUID(),
		owner_host_id: await currentOwnerHostId(),
	};
}

function releasedOwnerForHost(ownerHostId: string, token = randomUUID()): SessionStateLockOwner {
	return {
		// PID 1 exists in every supported process namespace. Legacy readers that do
		// not understand `released` therefore keep this compatibility fence instead
		// of deleting it and racing a current writer.
		pid: 1,
		start_time: "unknown",
		token,
		owner_host_id: ownerHostId,
		released: true,
	};
}

async function releasedLockOwner(): Promise<SessionStateLockOwner> {
	return releasedOwnerForHost(await currentOwnerHostId());
}

/**
 * The object a descriptor is currently open on.
 *
 * `dev`/`ino` and nothing else: this names the OBJECT rather than a payload or a moment,
 * which is exactly what an open descriptor pins. While the descriptor is open the inode
 * cannot be recycled, so an equal pair at a pathname can only be that same object — never
 * a successor that happened to land on a reused inode number.
 */
interface OpenOwnerIdentity {
	dev: bigint;
	ino: bigint;
}

/** Identity of the regular file `handle` is open on, or `null` when it cannot be proved. */
async function openOwnerIdentity(handle: fs.FileHandle): Promise<OpenOwnerIdentity | null> {
	try {
		const stat = await handle.stat({ bigint: true });
		return stat.isFile() ? { dev: stat.dev, ino: stat.ino } : null;
	} catch {
		return null;
	}
}

/**
 * Retract the record a failed write left behind — and only that record.
 *
 * The authority to delete it belongs to the writer's OWN open file, not to whatever the
 * pathname names by the time this runs. Those are different objects far more often than
 * the window suggests: the partial record can be stale-reclaimed and the freed pathname
 * taken by a successor between the fault and this cleanup. Capturing "whatever is there
 * now" and handing it to the identity-bound unlink deletes that successor's live lock, and
 * the compare-and-delete cannot object — the capture and the authorization would be the
 * same foreign object.
 *
 * So on POSIX the created descriptor is still open here, and it stays open: it is what makes
 * the comparison sound instead of merely likely, because the created inode cannot be recycled
 * underneath a successor while this process holds it. Only when a fresh no-follow capture
 * of the pathname proves to be that same still-open object is the existing exact unlink
 * allowed to run — and it then closes the remaining capture-to-unlink race on the bytes.
 *
 * Windows inverts that order. Opening the object for DELETE while this descriptor pins it
 * fails (the create descriptor grants no share-delete), so the descriptor cannot outlive the
 * proof there. It has already vouched for the object identity before it closes; afterwards
 * the compare-and-delete itself re-proves the FULL recorded identity — dev/ino, link count,
 * size, mtime, and payload hash — against whatever the pathname names at delete time. A
 * successor that takes the pathname in the close-to-delete window fails that compare and is
 * left alone, which keeps the retraction fail-closed without the descriptor.
 *
 * Anything short of that proof — a descriptor that no longer answers, a capture that
 * refuses or reports a type swap, a different object at the path — leaves the pathname
 * exactly as it is for the normal stale protocol.
 */
async function retractFailedOwnerRecord(
	file: string,
	handle: fs.FileHandle,
	created: OpenOwnerIdentity | null,
	quarantineName: string,
): Promise<void> {
	if (!created) return;
	const stillOpen = await openOwnerIdentity(handle);
	if (!stillOpen || stillOpen.dev !== created.dev || stillOpen.ino !== created.ino) return;
	if (ownerAccessStrategy() === "windows-validated") await handle.close().catch(() => undefined);
	const current = await captureRegularLockOwner(file).catch(() => null);
	if (!current || current.dev !== created.dev || current.ino !== created.ino) return;
	exactUnlinkOwnerRecord(file, current, quarantineName);
}

/**
 * Take `file` as a regular owner record and capture the exact identity of the bytes just
 * written, from the SAME descriptor that wrote them.
 *
 * That identity is the only thing that will ever authorize deleting this record again, so
 * it has to describe the object on disk rather than the string that was handed over. The
 * same descriptor is what authorizes retracting the record when the write FAILS: it is
 * held open across the whole cleanup, so the object this call created cannot be confused
 * with a successor that took the pathname after a stale reclaim freed it.
 *
 * The deletion primitive is resolved BEFORE the record is created. A record this process
 * cannot ever remove is worse than no record at all: it is indistinguishable from a live
 * holder, so it would strand the pathname for every later contender instead of failing the
 * one call that could not proceed.
 *
 * @throws `EEXIST` (or `EISDIR`/`EPERM`) unchanged, so callers can tell contention apart
 * from failure.
 */
async function createOwnerLock(
	file: string,
	owner: SessionStateLockOwner,
	quarantineName: string,
): Promise<LockOwnerSnapshot> {
	const flags = ownerCreateFlags();
	if (flags === undefined)
		throw new SessionStateLockUnavailableError(
			new Error("Safe owner record creation is unsupported on this platform."),
		);
	nativeSessionStateLock();
	const handle = await fs.open(file, flags, 0o600);
	const bytes = Buffer.from(JSON.stringify(owner), "utf8");
	// Taken from the SAME descriptor the exclusive create produced, before anything is
	// written through it. `O_EXCL` proves the object did not exist a moment ago, so this
	// pair names the record this call brought into existence and nothing else.
	let created: OpenOwnerIdentity | null = null;
	try {
		await handle.chmod(0o600);
		created = await openOwnerIdentity(handle);
		await SessionStateLockTestHooks.ownerRecordWriteFault?.(file);
		await handle.writeFile(bytes);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || stat.size !== BigInt(bytes.byteLength))
			throw new SessionStateLockUnavailableError(new Error("Owner record did not land as a regular file."));
		return ownerSnapshotFrom(stat, bytes);
	} catch (error) {
		// Deliberately BEFORE any close: releasing the descriptor first would free the
		// created inode for reuse and turn a successor into a match.
		try {
			await retractFailedOwnerRecord(file, handle, created, quarantineName);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Owner record write failed and its identity-bound cleanup also failed.",
			);
		}
		throw error;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

const POSIX_OWNER_REWRITE_FLAGS = POSIX_NOFOLLOW_AVAILABLE
	? fsSync.constants.O_RDWR | fsSync.constants.O_NONBLOCK | fsSync.constants.O_NOFOLLOW
	: undefined;

async function writeOwnerBytes(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
	await handle.truncate(0);
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
		if (bytesWritten <= 0) throw new Error("Owner record rewrite made no progress.");
		offset += bytesWritten;
	}
	await handle.truncate(bytes.byteLength);
	await handle.sync();
}

async function rewriteHeldOwnerRecord(
	file: string,
	held: LockOwnerSnapshot,
	replacement: SessionStateLockOwner,
	allowSuccessorAfterRewrite = false,
): Promise<LockOwnerSnapshot> {
	const strategy = ownerAccessStrategy();
	let before: fsSync.BigIntStats | undefined;
	if (strategy === "windows-validated") {
		before = await fs.lstat(file, { bigint: true }).catch(error => {
			throw new SessionStateLockUnavailableError(error);
		});
		if (before.isSymbolicLink() || !before.isFile())
			throw new SessionStateLockUnavailableError(new Error("Owner record cannot be rewritten safely."));
	}
	const flags = strategy === "windows-validated" ? fsSync.constants.O_RDWR : POSIX_OWNER_REWRITE_FLAGS;
	if (flags === undefined)
		throw new SessionStateLockUnavailableError(new Error("No-follow owner rewrites are unsupported."));
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, flags);
	} catch (error) {
		throw new SessionStateLockUnavailableError(error);
	}
	let mutationStarted = false;
	let rewriteHookPassed = false;
	let retainRepairHandle = false;
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) throw new SessionStateLockUnavailableError(new Error("Owner record is not regular."));
		if (before && !sameRegularFileIdentity(before, opened))
			throw new SessionStateLockUnavailableError(new Error("Owner record changed while opening for rewrite."));
		if (before) {
			const relinked = await fs.lstat(file, { bigint: true }).catch(() => null);
			if (!relinked || !sameRegularFileIdentity(opened, relinked))
				throw new SessionStateLockUnavailableError(new Error("Owner pathname changed while opening for rewrite."));
		}
		const currentBytes = await handle.readFile();
		const settled = await handle.stat({ bigint: true });
		if (!sameRegularFileIdentity(opened, settled) || settled.size !== BigInt(currentBytes.byteLength))
			throw new SessionStateLockUnavailableError(new Error("Owner record changed before rewrite."));
		if (!sameLockOwnerSnapshot(ownerSnapshotFrom(settled, currentBytes), held))
			throw new SessionStateLockUnavailableError(new Error("Owner record identity changed before rewrite."));
		await handle.chmod(0o600);

		const replacementBytes = Buffer.from(JSON.stringify(replacement), "utf8");
		mutationStarted = true;
		await SessionStateLockTestHooks.beforeOwnerRecordRewrite?.(file);
		rewriteHookPassed = true;
		await writeOwnerBytes(handle, replacementBytes);
		const rewritten = await handle.stat({ bigint: true });
		const canonical = await captureRegularLockOwner(file);
		if (!canonical || canonical.dev !== rewritten.dev || canonical.ino !== rewritten.ino)
			throw new SessionStateLockUnavailableError(new Error("Owner pathname changed after rewrite."));
		if (canonical.bytes !== replacementBytes.toString("utf8")) {
			let successor: unknown;
			try {
				successor = JSON.parse(canonical.bytes);
			} catch {
				successor = null;
			}
			if (!allowSuccessorAfterRewrite || !validLockOwner(successor) || successor.released === true)
				throw new SessionStateLockUnavailableError(new Error("Owner record changed after rewrite."));
		}
		return canonical;
	} catch (error) {
		// Keep the descriptor as the repair authority until the held bytes have
		// been restored. A truncate/write/fsync fault may leave a malformed or
		// partially committed record; closing first would force recovery to trust
		// an unproven pathname and can wedge a successor behind the transition.
		let repairNeeded = mutationStarted;
		if (mutationStarted && !rewriteHookPassed) {
			try {
				repairNeeded = (await handle.readFile()).toString("utf8") !== held.bytes;
			} catch {
				repairNeeded = true;
			}
		}
		if (repairNeeded) {
			let repaired: LockOwnerSnapshot;
			try {
				await writeOwnerBytes(handle, Buffer.from(held.bytes, "utf8"));
				const repairedStat = await handle.stat({ bigint: true });
				repaired = ownerSnapshotFrom(repairedStat, Buffer.from(held.bytes, "utf8"));
			} catch (repairError) {
				const aggregate = new AggregateError(
					[error, repairError],
					"Owner record rewrite failed and its descriptor-bound repair also failed.",
				);
				const failure = aggregate as OwnerRewriteFailure;
				failure.repairHandle = handle;
				failure.repairBytes = held.bytes;
				// The finally block must not close this handle: it is now the only
				// authority capable of repairing the exact inode without trusting its
				// mutable pathname.
				retainRepairHandle = true;
				throw failure;
			}
			const wrapped =
				error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error);
			(wrapped as OwnerRewriteFailure).repairSnapshot = repaired;
			throw wrapped;
		}
		throw error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error);
	} finally {
		if (!retainRepairHandle) await handle.close().catch(() => undefined);
	}
}

async function acquireOwnerLock(
	file: string,
	owner: SessionStateLockOwner,
	quarantineName: string,
	onRewriteFailure?: (held: LockOwnerSnapshot) => void,
): Promise<LockOwnerSnapshot> {
	nativeSessionStateLock();
	try {
		return await createOwnerLock(file, owner, quarantineName);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const stat = await fs.lstat(file).catch(() => null);
		if (!stat?.isFile()) throw error;
		const current = await captureRegularLockOwner(file).catch(() => null);
		if (!current) throw error;
		let observed: unknown;
		try {
			observed = JSON.parse(current.bytes);
		} catch {
			throw error;
		}
		if (!validLockOwner(observed)) throw error;
		if (observed.released !== true) {
			if (await lockOwnerIsAlive(observed)) throw error;
			const removed = exactUnlinkOwnerRecord(file, current, quarantineName);
			if (removed !== "removed" && removed !== "absent") throw error;
			return await createOwnerLock(file, owner, quarantineName);
		}
		try {
			return await rewriteHeldOwnerRecord(file, current, owner);
		} catch (error) {
			onRewriteFailure?.(current);
			throw error;
		}
	}
}

/**
 * Give up an owner record this process holds.
 *
 * Live-owner release rewrites the held inode into a durable released tombstone instead of
 * unlinking its pathname. Current writers reuse that exact inode under the transition
 * claim; legacy/base writers see PID 1 as live and remain fenced. Holding the descriptor
 * across verification and rewrite means a successor that replaces the pathname is never
 * modified or deleted. This stays portable on filesystems that reject Linux renameat2
 * exchange/no-replace (notably CephFS).
 *
 * Stale-owner reclaim still uses the native identity-bound detach protocol because no live
 * owner or transition claim can vouch for that pathname. A mismatch here likewise leaves a
 * successor strictly alone. A released tombstone is reclaimable on every platform when its
 * owner host is this installation and the transition directory is proven empty and unchanged:
 * the tombstone is the release marker, while the directory generation binds that marker to
 * the exact claim that release failed to remove.
 */
async function releaseOwnerLock(file: string, held: LockOwnerSnapshot): Promise<void> {
	let owner: unknown;
	try {
		owner = JSON.parse(held.bytes);
	} catch {
		owner = null;
	}
	if (
		!validLockOwner(owner) ||
		owner.pid !== process.pid ||
		owner.owner_host_id !== (await currentOwnerHostId()) ||
		!sameOwnerIncarnation(owner)
	) {
		throw new SessionStateLockUnavailableError(new Error("Owner record is not held by this process incarnation."));
	}
	try {
		await SessionStateLockTestHooks.beforeCurrentOwnerRelease?.(file);
	} catch (error) {
		throw new SessionStateLockUnavailableError(error);
	}
	const current = await captureRegularLockOwner(file);
	if (!current) throw new SessionStateLockUnavailableError(new Error("Owner record disappeared before release."));
	if (!sameLockOwnerSnapshot(current, held)) {
		throw new SessionStateLockUnavailableError(new Error("Owner record changed before release."));
	}
	try {
		await SessionStateLockTestHooks.afterCurrentOwnerValidation?.(file);
	} catch (error) {
		throw new SessionStateLockUnavailableError(error);
	}
	await rewriteHeldOwnerRecord(file, held, await releasedLockOwner(), true);
}

/**
 * Reclaim a regular owner record whose owner is dead, or whose malformed bytes have
 * outlived the stale window.
 *
 * The identity is re-captured immediately before the delete, and the delete itself refuses
 * unless the object still carries it. That second half is what makes this safe against a
 * base or legacy writer, which takes no claim and can create the pathname at any instant:
 * a successor is reported as `identity_mismatch` and survives untouched, and the caller
 * simply retries.
 */
type SessionStateLockReclaimResult =
	| "absent_or_changed"
	| "legacy_directory_unprovenanced"
	| "owner_removed"
	| "owner_live_or_unverifiable"
	| "owner_record_fresh"
	| "owner_unprovenanced"
	| "reclaimed";

async function reclaimStaleOwnerRecord(
	file: string,
	hooks: {
		afterInspection?: (file: string) => void | Promise<void>;
		beforeRemoval?: (file: string) => void | Promise<void>;
	},
	quarantineName?: string,
): Promise<SessionStateLockReclaimResult> {
	const snapshot = await captureRegularLockOwner(file);
	if (!snapshot) return "absent_or_changed";
	let owner: unknown;
	try {
		owner = JSON.parse(snapshot.bytes);
	} catch {
		owner = null;
	}
	if (!validLockOwner(owner)) {
		const provenance = await malformedOwnerProvenance(owner);
		if (provenance === "unprovenanced") return "owner_unprovenanced";
		if (provenance === "live_or_unverifiable") return "owner_live_or_unverifiable";
		// The mtime of the very inode the bytes were read from, not a fresh path `stat`.
		if (Date.now() - Number(snapshot.mtimeNs / 1_000_000n) < LOCK_STALE_MS) return "owner_record_fresh";
	} else if (await lockOwnerIsAlive(owner)) return "owner_live_or_unverifiable";
	await hooks.afterInspection?.(file);
	const current = await captureRegularLockOwner(file);
	if (!current || !sameLockOwnerSnapshot(current, snapshot)) return "absent_or_changed";
	await hooks.beforeRemoval?.(file);
	const reserved = quarantineName ?? lockQuarantineName();
	await removeVerifiedEmptyQuarantine(path.dirname(file), reserved);
	const outcome = exactUnlinkOwnerRecord(file, current, reserved);
	// A successor that took the path in the final window keeps it; this call just loses.
	if (outcome === "refused")
		throw new SessionStateLockUnavailableError(new Error("Stale owner record could not be reclaimed."));
	if (outcome === "removed") return "owner_removed";
	return "absent_or_changed";
}

/**
 * Verified empty leftover at a reserved quarantine name is incomplete debris, not
 * in-progress cleanup.
 *
 * Deletion authority is the native identity-bound direct unlink — never a plain
 * pathname unlink. A replacement planted at the reserved name between observation
 * and deletion has a different inode identity and is refused by construction.
 */
export async function removeVerifiedEmptyQuarantine(directory: string, name: string): Promise<void> {
	// The name must be a single path component on every supported platform: both
	// separator forms and drive/colon syntax are rejected before path.join, so a
	// caller-controlled name can never escape the lock directory (Windows included).
	if (
		!name.startsWith(".gjc-delete-") ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes(":") ||
		name.includes("\0")
	)
		return;
	const target = path.join(directory, name);
	let parent: fsSync.BigIntStats;
	try {
		parent = await fs.stat(path.dirname(target), { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let stat: fsSync.BigIntStats;
	try {
		stat = await fs.lstat(target, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0n || stat.nlink !== 1n) return;
	const result = nativeSessionStateLock().exactUnlinkDirect(target, {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		parentDev: parent.dev,
		parentIno: parent.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		sha256: EMPTY_FILE_SHA256,
		quarantineName: `.gjc-delete-cleanup-${randomUUID()}.json`,
	});
	if (result.ok) return;
	const retained = [
		result.detachedPath,
		result.retainedSuccessorPath,
		result.retainedPlaceholderPath,
		result.retainedUnknownPath,
	].filter((value): value is string => typeof value === "string");
	// not_found is an ordinary concurrent-cleanup race; identity_mismatch without a
	// retained path means the native restored the verified object to its original
	// name and a replacement owns the pathname now — both leave nothing hidden.
	if (retained.length === 0 && (result.code === "not_found" || result.code === "identity_mismatch")) return;
	// Anything else is fail-closed and observable: the stale reclaim must not proceed
	// while recovery evidence (a stranded detached object, a retained successor, or an
	// unrecovered placeholder) would otherwise vanish silently.
	throw new SessionStateLockUnavailableError(
		new Error(
			`Verified empty quarantine cleanup did not complete (${result.code ?? "unknown"})` +
				(retained.length > 0 ? `; retained: ${retained.join(", ")}` : "") +
				".",
		),
	);
}

async function releaseTransitionClaim(
	transitionDir: string,
	ownerFile: string,
	held: LockOwnerSnapshot,
	recoveryKey: string,
	transitionGeneration: TransitionDirectoryGeneration,
	nativePath: string,
): Promise<void> {
	let heldOwner: SessionStateLockOwner;
	try {
		heldOwner = JSON.parse(held.bytes) as SessionStateLockOwner;
	} catch (error) {
		throw new SessionStateLockUnavailableError(error);
	}
	const releasedOwner = releasedOwnerForHost(heldOwner.owner_host_id ?? "", randomUUID());
	// Arm recovery before every fallible release phase. In particular, an initial
	// lstat/capture or a rewrite that commits bytes and then reports an I/O fault must not
	// strand the claim without a generation-bound replay record.
	pendingTransitionReleases.set(recoveryKey, {
		phase: "release",
		token: releasedOwner.token,
		generation: transitionGeneration,
		nativePath,
		held,
		releasedOwner,
		recoverable: false,
	});
	try {
		await SessionStateLockTestHooks.beforeCurrentOwnerRelease?.(ownerFile);
		const current = await captureRegularLockOwner(ownerFile);
		if (!current || !sameLockOwnerSnapshot(current, held))
			throw new SessionStateLockUnavailableError(new Error("Transition owner changed before release."));
		await SessionStateLockTestHooks.afterCurrentOwnerValidation?.(ownerFile);
		await rewriteHeldOwnerRecord(ownerFile, held, releasedOwner);
		await SessionStateLockTestHooks.beforeTransitionReleaseLstat?.(transitionDir);
		const currentTransition = await fs.lstat(transitionDir, { bigint: true });
		if (
			!currentTransition.isDirectory() ||
			!sameTransitionGeneration(transitionGenerationFromStat(currentTransition), transitionGeneration)
		)
			throw new SessionStateLockUnavailableError(new Error("Transition claim changed before release."));
		await removeTransitionDir(transitionDir);
		clearPendingTransitionRelease(recoveryKey);
	} catch (error) {
		const currentPending = pendingTransitionReleases.get(recoveryKey);
		if (currentPending && currentPending.held === held) {
			const rewriteFailure = error as OwnerRewriteFailure;
			const repaired = rewriteFailure.repairSnapshot;
			if (repaired && sameLockOwnerObject(repaired, held)) currentPending.held = repaired;
			if (rewriteFailure.repairHandle) {
				currentPending.repairHandle = rewriteFailure.repairHandle;
				currentPending.repairBytes = rewriteFailure.repairBytes ?? held.bytes;
			}
			currentPending.recoverable = true;
		}
		throw error;
	}
}

async function reclaimStaleTransitionClaim(transitionDir: string, quarantineName: string): Promise<boolean> {
	let stat: fsSync.BigIntStats;
	try {
		stat = await fs.lstat(transitionDir, { bigint: true });
	} catch {
		return false;
	}
	// Regular-file claims belong to the superseded protocol. They retain the old
	// exact-identity stale path; released PID-1 tombstones deliberately require
	// explicit cleanup before this atomic-directory protocol can take over.
	if (stat.isFile()) {
		const reclaimed = await reclaimStaleOwnerRecord(
			transitionDir,
			{
				afterInspection: SessionStateLockTestHooks.afterTransitionStaleInspection,
				beforeRemoval: SessionStateLockTestHooks.beforeTransitionStaleRemoval,
			},
			quarantineName,
		);
		return reclaimed === "owner_removed";
	}
	if (!stat.isDirectory()) throw new SessionStateLockUnavailableError();
	const ownerSnapshot = await captureRegularLockOwner(`${transitionDir}.owner`);
	if (!ownerSnapshot) return false;
	let owner: unknown;
	try {
		owner = JSON.parse(ownerSnapshot.bytes);
	} catch {
		return false;
	}
	if (!validLockOwner(owner)) return false;
	await SessionStateLockTestHooks.afterTransitionStaleInspection?.(transitionDir);
	if (owner.released === true) {
		// A released record is safe only when it is qualified by this installation.
		// Never let a shared-volume tombstone, an absent identity, or a legacy foreign
		// identity authorize removal of a claim this process cannot own.
		if (owner.owner_host_id === undefined) return false;
		const currentHost = await currentOwnerHostId();
		const legacyHost = await currentLegacyOwnerHostId();
		if (owner.owner_host_id !== currentHost && owner.owner_host_id !== legacyHost) return false;
		if (Date.now() - Number(ownerSnapshot.mtimeNs / 1_000_000n) < RELEASED_TRANSITION_GRACE_MS) return false;
	} else if (await lockOwnerIsAlive(owner)) {
		// Only a host-qualified owner whose pid is PROVEN dead (ESRCH, or a live pid
		// with a provably different incarnation) authorizes reclaim. The generation
		// + exact-tree checks below then bind the removal to the very directory
		// inspected here, on every platform; a claim stranded by a force-quit
		// (`postmortem.quit`) would otherwise wall the session directory forever.
		return false;
	}
	const generation = transitionGenerationFromStat(stat);
	const nativePath = await canonicalOwnedTransitionPath(transitionDir).catch(() => null);
	if (!nativePath) return false;
	const captured = nativeSessionStateLock().snapshotDirectoryTree(nativePath);
	if (!captured.ok || !captured.snapshot) return false;
	const root = captured.snapshot.entries.find(entry => entry.relativePath === "");
	if (
		root?.kind !== "directory" ||
		root.dev !== String(generation.dev) ||
		root.ino !== String(generation.ino) ||
		root.nlink !== String(generation.nlink) ||
		root.mtimeNs !== String(generation.mtimeNs) ||
		root.ctimeNs !== String(generation.ctimeNs)
	)
		return false;
	if (captured.snapshot.entries.length !== 1) return false;
	const removed = nativeSessionStateLock().exactRemoveDirectoryTree(nativePath, captured.snapshot);
	if (removed.ok || removed.code === "not_found") {
		exactUnlinkOwnerRecord(`${transitionDir}.owner`, ownerSnapshot, quarantineName);
		return removed.ok;
	}
	if (
		removed.code === "cleanup_pending" &&
		removed.payloadDurable === true &&
		removed.detachedPath === `${nativePath}.removing` &&
		removed.retainedSuccessorPath === undefined &&
		removed.retainedUnknownPath === undefined &&
		removed.retainedPlaceholderPath === undefined
	) {
		// The captured claim is proven empty, so the native detach receipt leaves an
		// empty directory at detachedPath. Remove that exact directory directly: calling
		// the detach primitive again would deterministically create a second `.removing`
		// collision on POSIX. rmdir never follows a directory's contents and refuses if a
		// successor populated the detached path.
		await removeTransitionDir(removed.detachedPath);
		exactUnlinkOwnerRecord(`${transitionDir}.owner`, ownerSnapshot, quarantineName);
		return true;
	}
	throw new SessionStateLockUnavailableError(
		new Error(`Stale transition claim could not be reclaimed (${removed.code ?? "unknown"}).`),
	);
}

/** Run one pathname transition under an atomic `mkdir`/`rmdir` claim. */
/**
 * Recover a transition claim this process stranded in a prior failed release.
 *
 * `releaseTransitionClaim` rewrites the owner record to its released tombstone
 * before removing the claim directory, so a transiently denied `rmdir` (Windows
 * sharing denial, EBUSY/EPERM) leaves a RELEASED owner record plus an intact
 * claim. Without recovery, that claim is a fail-closed wall this same process
 * then deadlocks on: the on-disk owner is live (this process), so
 * `reclaimStaleTransitionClaim` refuses it forever. The recorded released token
 * authorizes completing exactly that release: the record must still carry the
 * same token with `released: true` — any other content is a successor's claim
 * and stays untouched.
 */
async function recoverPendingTransitionRelease(
	transitionDir: string,
	recoveryKey: string,
	quarantineName: string,
): Promise<boolean> {
	let pendingKey = recoveryKey;
	let pending = pendingTransitionReleases.get(pendingKey);
	if (pending === undefined) {
		// Parent realpath can be transiently unavailable during release. A later alias
		// may therefore compute a different lexical key; generation identity is the
		// authority for finding that stranded entry, never the pathname spelling.
		const current = await fs.lstat(transitionDir, { bigint: true }).catch(() => null);
		if (!current?.isDirectory()) return false;
		for (const [key, candidate] of pendingTransitionReleases) {
			if (
				candidate.generation &&
				sameTransitionGeneration(candidate.generation, {
					dev: current.dev,
					ino: current.ino,
					mode: current.mode,
					nlink: current.nlink,
					mtimeNs: current.mtimeNs,
					ctimeNs: current.ctimeNs,
				})
			) {
				pendingKey = key;
				pending = candidate;
				break;
			}
		}
	}
	if (pending === undefined) return false;
	// The record is armed before release's fallible phases, but it is not authority
	// for a contender while that release is still in progress. The owner that armed
	// it flips this bit only when a phase actually throws.
	if (!pending.recoverable) return false;
	if (pending.recovery) return await pending.recovery;
	const recovery = (async (): Promise<boolean> => {
		const ownerFile = `${transitionDir}.owner`;
		if (!pending.generation) {
			// A generation-less pending setup has no pathname authority. The only
			// safe recovery source is the descriptor retained immediately after mkdir;
			// never snapshot an arbitrary successor now occupying the alias.
			if (!pending.generationHandle) return false;
			try {
				pending.generation = await captureTransitionDirectoryGenerationFromHandle(pending.generationHandle);
			} catch {
				return false;
			}
		}
		const pendingGeneration = pending.generation;
		if (!pendingGeneration) return false;
		let current: fsSync.BigIntStats | null;
		try {
			current = await fs.lstat(transitionDir, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				clearPendingTransitionRelease(pendingKey, pending);
				return true;
			}
			return false;
		}
		// A successor may have replaced the claim after the original release failed.
		// Never let this cleanup remove that new generation, even if its owner sidecar
		// happens to carry the same released token.
		if (
			!current.isDirectory() ||
			!sameTransitionGeneration(pendingGeneration, {
				dev: current.dev,
				ino: current.ino,
				mode: current.mode,
				nlink: current.nlink,
				mtimeNs: current.mtimeNs,
				ctimeNs: current.ctimeNs,
			})
		) {
			clearPendingTransitionRelease(pendingKey, pending);
			return false;
		}
		if (!(await repairPendingOwnerRecord(pending))) return false;
		if (pending.repairSnapshot && pending.held && sameLockOwnerObject(pending.repairSnapshot, pending.held))
			pending.held = pending.repairSnapshot;
		if (pending.phase === "setup") {
			try {
				if (pending.held) {
					const outcome = exactUnlinkOwnerRecord(ownerFile, pending.held, quarantineName);
					if (outcome !== "removed" && outcome !== "absent") {
						clearPendingTransitionRelease(pendingKey, pending);
						return false;
					}
				} else if (await captureRegularLockOwner(ownerFile)) {
					return false;
				}
				await removeTransitionDir(transitionDir);
				clearPendingTransitionRelease(pendingKey, pending);
				return true;
			} catch {
				return false;
			}
		}
		if (!pending.held || !pending.releasedOwner) {
			clearPendingTransitionRelease(pendingKey, pending);
			return false;
		}
		try {
			let pendingOwner = await captureRegularLockOwner(ownerFile);
			if (!pendingOwner) return false;
			let parsed: Partial<SessionStateLockOwner>;
			try {
				parsed = JSON.parse(pendingOwner.bytes) as Partial<SessionStateLockOwner>;
			} catch {
				// A rewrite can truncate the held inode and fail before replacement
				// bytes land. The malformed payload is still ours only when its object
				// identity is the held inode; exact unlink then re-proves the current
				// bytes before removing it. A different inode is a successor and stays.
				if (!sameLockOwnerObject(pendingOwner, pending.held)) {
					clearPendingTransitionRelease(pendingKey, pending);
					return false;
				}
				const outcome = exactUnlinkOwnerRecord(ownerFile, pendingOwner, quarantineName);
				if (outcome !== "removed" && outcome !== "absent") return false;
				await removeTransitionDir(transitionDir);
				clearPendingTransitionRelease(pendingKey, pending);
				return true;
			}
			if (parsed.token !== pending.token || parsed.released !== true) {
				// A rewrite may have failed before touching the inode. Retry it only when
				// the owner path is still the exact record this transition held; any other
				// bytes belong to a successor and invalidate this pending authority.
				if (!sameLockOwnerSnapshot(pendingOwner, pending.held)) {
					clearPendingTransitionRelease(pendingKey, pending);
					return false;
				}
				try {
					await rewriteHeldOwnerRecord(ownerFile, pendingOwner, pending.releasedOwner);
				} catch {
					// Keep the generation record. A later contender can retry this
					// release without replaying the already-completed transition.
					return false;
				}
				pendingOwner = await captureRegularLockOwner(ownerFile);
				if (!pendingOwner) return false;
				try {
					parsed = JSON.parse(pendingOwner.bytes) as Partial<SessionStateLockOwner>;
				} catch {
					return false;
				}
			}
			if (parsed.token !== pending.token || parsed.released !== true) return false;
			let nativeTransitionPath = pending.nativePath;
			if (nativeTransitionPath === undefined) {
				try {
					nativeTransitionPath = await canonicalOwnedTransitionPath(transitionDir);
					pending.nativePath = nativeTransitionPath;
				} catch {
					return false;
				}
			}
			const captured = nativeSessionStateLock().snapshotDirectoryTree(nativeTransitionPath);
			if (captured.code === "sharing_violation") return false;
			if (
				!captured.ok ||
				!captured.snapshot ||
				captured.snapshot.rootDev !== String(current.dev) ||
				captured.snapshot.rootIno !== String(current.ino)
			) {
				clearPendingTransitionRelease(pendingKey, pending);
				return false;
			}
			const capturedRoot = captured.snapshot.entries.find(entry => entry.relativePath === "");
			if (
				!capturedRoot ||
				capturedRoot.dev !== String(pendingGeneration.dev) ||
				capturedRoot.ino !== String(pendingGeneration.ino) ||
				capturedRoot.nlink !== String(pendingGeneration.nlink) ||
				capturedRoot.mtimeNs !== String(pendingGeneration.mtimeNs) ||
				capturedRoot.ctimeNs !== String(pendingGeneration.ctimeNs)
			) {
				clearPendingTransitionRelease(pendingKey, pending);
				return false;
			}
			const removed = nativeSessionStateLock().exactRemoveDirectoryTree(nativeTransitionPath, captured.snapshot);
			if (removed.code === "sharing_violation") return false;
			if (removed.ok || removed.code === "not_found") {
				clearPendingTransitionRelease(pendingKey, pending);
				return true;
			}
			if (removed.code === "identity_mismatch") {
				clearPendingTransitionRelease(pendingKey, pending);
				return false;
			}
			if (
				removed.code === "cleanup_pending" &&
				removed.payloadDurable === true &&
				removed.detachedPath === `${nativeTransitionPath}.removing` &&
				removed.retainedSuccessorPath === undefined &&
				removed.retainedUnknownPath === undefined &&
				removed.retainedPlaceholderPath === undefined
			) {
				clearPendingTransitionRelease(pendingKey, pending);
				return true;
			}
			return false;
		} catch (error) {
			if (isTransientLockError(error)) return false;
			return false;
		}
	})();
	pending.recovery = recovery;
	try {
		return await recovery;
	} finally {
		if (pending.recovery === recovery) pending.recovery = undefined;
	}
}

/**
 * Run one pathname transition under an atomic `mkdir`/`rmdir` claim.
 *
 * Same-process contenders join the current claim owner's lifetime before consuming their
 * bounded filesystem-contention budget. The on-disk protocol remains authoritative across
 * processes; this queue only prevents a descheduled local owner from timing out its own
 * successor while it still legitimately holds the claim.
 */
async function withLockPathTransition<T>(
	lockFile: string,
	transition: () => Promise<T>,
	quarantineName = lockQuarantineName(),
	retryBudget?: LockRetryBudget,
): Promise<T> {
	if (ownerAccessStrategy() === "unsupported")
		throw new SessionStateLockUnavailableError(new Error("Safe transition ownership is unsupported."));
	const transitionDir = `${lockFile}${LOCK_TRANSITION_RESOURCE_SUFFIX}`;
	const recoveryKey = await transitionRecoveryKey(transitionDir);
	const localKey = recoveryKey;
	const owner = await newLockOwner();
	const budget = retryBudget ?? lockRetryBudget();
	let localTurn = await joinLocalTransitionQueue(localKey, transitionDir, budget);
	const claimLocalTurn = (): void => {
		localTurn ??= claimLocalTransitionQueue(localKey);
	};
	const joinLocalTurn = async (): Promise<boolean> => {
		if (localTurn) return false;
		const joined = await joinLocalTransitionQueue(localKey, transitionDir, budget);
		if (!joined) return false;
		localTurn = joined;
		return true;
	};
	try {
		return await runLockPathTransition(
			lockFile,
			recoveryKey,
			owner,
			budget,
			claimLocalTurn,
			joinLocalTurn,
			transition,
			quarantineName,
		);
	} finally {
		if (localTurn) releaseLocalTransitionQueue(localKey, localTurn);
	}
}

async function runLockPathTransition<T>(
	lockFile: string,
	recoveryKey: string,
	owner: SessionStateLockOwner,
	budget: LockRetryBudget,
	claimLocalTurn: () => void,
	joinLocalTurn: () => Promise<boolean>,
	transition: () => Promise<T>,
	quarantineName = lockQuarantineName(),
): Promise<T> {
	if (ownerAccessStrategy() === "unsupported")
		throw new SessionStateLockUnavailableError(new Error("Safe transition ownership is unsupported."));
	const transitionDir = `${lockFile}${LOCK_TRANSITION_RESOURCE_SUFFIX}`;
	const ownerFile = `${transitionDir}.owner`;

	for (;;) {
		if (ownerAccessStrategy() === "unsupported" && fsSync.existsSync(transitionDir))
			throw new SessionStateLockUnavailableError(new Error("Safe transition ownership is unsupported."));
		if (await recoverPendingTransitionRelease(transitionDir, recoveryKey, quarantineName)) {
			// The claim this process stranded in an earlier failed release is gone;
			// fall through and retry the mkdir immediately.
		}
		if (await joinLocalTurn()) continue;
		try {
			await fs.mkdir(transitionDir, { mode: 0o700 });
			claimLocalTurn();
			await fs.chmod(transitionDir, 0o700);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && !isTransientLockError(error)) throw new SessionStateLockUnavailableError(error);
			if (await joinLocalTurn()) continue;
			await SessionStateLockTestHooks.afterTransitionClaimContention?.(transitionDir);
			if (await reclaimStaleTransitionClaim(transitionDir, quarantineName)) {
				if (lockRetryExhausted(budget))
					throw lockUnavailable(transitionDir, "transition_claim_timeout", budget, error);
				continue;
			}
			if (!(await waitForLockRetry(budget)))
				throw lockUnavailable(transitionDir, "transition_claim_timeout", budget, error);
			continue;
		}
		const pendingSetup: PendingTransitionRelease = {
			phase: "setup",
			token: owner.token,
			recoverable: false,
		};
		pendingTransitionReleases.set(recoveryKey, pendingSetup);
		let transitionGeneration: TransitionDirectoryGeneration;
		try {
			if (process.platform === "win32") {
				// Windows has no no-follow directory descriptor through Node's fs
				// flags. Capture the generation immediately after the exclusive mkdir and
				// before canonicalization, so a replacement cannot become our authority.
				const transitionStat = await fs.lstat(transitionDir, { bigint: true });
				if (!transitionStat.isDirectory()) throw new Error("Transition claim is no longer a directory.");
				transitionGeneration = transitionGenerationFromStat(transitionStat);
				pendingSetup.generation = transitionGeneration;
				await SessionStateLockTestHooks.beforeTransitionSetupLstat?.(transitionDir);
				pendingSetup.nativePath = await canonicalOwnedTransitionPath(transitionDir);
				const rebound = await fs.lstat(transitionDir, { bigint: true });
				if (
					!rebound.isDirectory() ||
					!sameTransitionGeneration(transitionGenerationFromStat(rebound), transitionGeneration)
				)
					throw new Error("Transition claim changed during physical path capture.");
			} else {
				// Retain no-follow authority before the fault seam and before any
				// recovery pathname lookup. A later lstat cannot distinguish this
				// claim from a successor that replaced the name after setup failed.
				pendingSetup.generationHandle = await fs.open(transitionDir, TRANSITION_DIRECTORY_OPEN_FLAGS);
				transitionGeneration = await captureTransitionDirectoryGenerationFromHandle(pendingSetup.generationHandle);
				await SessionStateLockTestHooks.beforeTransitionSetupLstat?.(transitionDir);
				pendingSetup.nativePath = await canonicalOwnedTransitionPath(transitionDir);
				await pendingSetup.generationHandle.close();
				pendingSetup.generationHandle = undefined;
			}
			pendingSetup.generation ??= transitionGeneration;
		} catch (error) {
			pendingSetup.recoverable = true;
			// If opening the just-created claim itself failed, no descriptor or
			// generation proves which object the pathname names. Retain the claim
			// fail-closed rather than spinning recovery against an unproven path.
			if (!pendingSetup.generationHandle && !pendingSetup.generation)
				throw new SessionStateLockUnavailableError(error);
			for (;;) {
				if (await recoverPendingTransitionRelease(transitionDir, recoveryKey, quarantineName)) break;
				if (!pendingTransitionReleases.has(recoveryKey)) break;
				if (!(await waitForLockRetry(budget)))
					throw lockUnavailable(transitionDir, "transition_claim_timeout", budget, error);
			}
			throw new SessionStateLockUnavailableError(error);
		}
		if (!transitionGeneration)
			throw new SessionStateLockUnavailableError(new Error("Transition claim generation unavailable."));
		let held: LockOwnerSnapshot;
		try {
			held = await acquireOwnerLock(ownerFile, owner, quarantineName, failedHeld => {
				pendingSetup.held = failedHeld;
			});
		} catch (error) {
			const pending = pendingTransitionReleases.get(recoveryKey);
			// `acquireOwnerLock` owns the only descriptor that can authorize
			// cleanup of a failed create. Once it returns an error that descriptor
			// is gone; a pathname capture here could be a successor's owner and
			// must never be handed to exact-unlink as our authority.
			if (pending) {
				const rewriteFailure = error as OwnerRewriteFailure;
				if (
					rewriteFailure.repairSnapshot &&
					pending.held &&
					sameLockOwnerObject(rewriteFailure.repairSnapshot, pending.held)
				)
					pending.held = rewriteFailure.repairSnapshot;
				if (rewriteFailure.repairHandle) {
					pending.repairHandle = rewriteFailure.repairHandle;
					pending.repairBytes = rewriteFailure.repairBytes;
				}
				pending.recoverable = true;
			}
			try {
				// If no owner pathname exists, setup never established an owner and
				// this claim can be removed only when its captured directory identity
				// still matches. A raw rmdir could delete an empty successor claim.
				const ownerStat = await fs.lstat(ownerFile).catch(error => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				});
				if (!ownerStat) {
					if (
						ownerAccessStrategy() !== "unsupported" &&
						pending?.nativePath &&
						pending.generation &&
						removeOwnedTransitionClaim(pending.nativePath, pending.generation)
					) {
						clearPendingTransitionRelease(recoveryKey, pending);
					}
				}
			} catch {
				if (pending) pending.recoverable = true;
			}
			throw error;
		}
		const outcome = await transition().then(
			value => ({ ok: true as const, value }),
			error => ({ ok: false as const, error }),
		);
		try {
			await releaseTransitionClaim(
				transitionDir,
				ownerFile,
				held,
				recoveryKey,
				transitionGeneration!,
				pendingSetup.nativePath!,
			);
		} catch (releaseError) {
			if (ownerAccessStrategy() === "unsupported") {
				if (outcome.ok)
					throw new SessionStateLockUnavailableError(
						new AggregateError([releaseError], "Transition claim cannot be released safely."),
					);
				throw new SessionStateLockUnavailableError(
					new AggregateError([outcome.error, releaseError], "Lock path transition and release both failed."),
				);
			}
			// The release rewrite may itself have succeeded before the claim-dir
			// removal was denied (transient sharing denial). Recover the stranded
			// claim in-process without replaying a transition that already succeeded.
			if (pendingTransitionReleases.has(recoveryKey)) {
				for (;;) {
					if (await recoverPendingTransitionRelease(transitionDir, recoveryKey, quarantineName)) {
						if (outcome.ok) return outcome.value;
						throw outcome.error;
					}
					if (!pendingTransitionReleases.has(recoveryKey)) break;
					if (!(await waitForLockRetry(budget))) break;
				}
			}
			if (outcome.ok)
				throw new SessionStateLockUnavailableError(
					new Error("Successful pathname transition could not release its claim."),
				);
			if (!outcome.ok)
				throw new SessionStateLockUnavailableError(
					new AggregateError([outcome.error, releaseError], "Lock path transition and release both failed."),
				);
			throw releaseError;
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}
}

/**
 * Reclaim the base regular-file `<file>.lock` when its owner is dead, or when a malformed
 * record has outlived the stale window.
 *
 * Two independent guarantees, because one contender class each defeats the other one:
 * the transition claim keeps CURRENT writers of this protocol out of the create/delete
 * window, and the identity-bound delete keeps a BASE writer — which takes no claim and
 * just creates the pathname — from having its brand-new lock unlinked.
 */
async function reclaimStaleRegularLock(
	lockFile: string,
	quarantineName?: string,
	retryBudget?: LockRetryBudget,
): Promise<SessionStateLockReclaimResult> {
	const reserved = quarantineName ?? lockQuarantineName();
	return await withLockPathTransition(
		lockFile,
		async () =>
			await reclaimStaleOwnerRecord(
				lockFile,
				{
					afterInspection: SessionStateLockTestHooks.afterStaleInspection,
					beforeRemoval: SessionStateLockTestHooks.beforeStaleRemoval,
				},
				reserved,
			),
		reserved,
		retryBudget,
	);
}

/**
 * Whether two tree captures describe the same directory down to every entry.
 *
 * Structural equality over the evidence the native primitive itself consumes: the root's
 * own `dev`/`ino`, and each entry's position, kind, inode identity, and content hash. A
 * successor that recreated the path is a different root inode; a successor that reused it
 * differs in some entry. Neither can look like survival.
 */
function sameDirectoryTreeSnapshot(left: NativeDirectoryTreeSnapshot, right: NativeDirectoryTreeSnapshot): boolean {
	if (left.rootDev !== right.rootDev || left.rootIno !== right.rootIno) return false;
	if (left.entries.length !== right.entries.length) return false;
	return left.entries.every((entry, index) => {
		const other = right.entries[index];
		return (
			other !== undefined &&
			entry.relativePath === other.relativePath &&
			entry.kind === other.kind &&
			entry.dev === other.dev &&
			entry.ino === other.ino &&
			entry.nlink === other.nlink &&
			entry.size === other.size &&
			entry.mtimeNs === other.mtimeNs &&
			entry.ctimeNs === other.ctimeNs &&
			entry.sha256 === other.sha256
		);
	});
}

function legacyDirectoryMatchesVerdict(
	snapshot: NativeDirectoryTreeSnapshot,
	identity: GenericFileLockDirIdentity,
): boolean {
	const info = snapshot.entries.find(entry => entry.relativePath === "info");
	return (
		snapshot.rootDev === identity.rootDev &&
		snapshot.rootIno === identity.rootIno &&
		info?.kind === "file" &&
		info.dev === identity.infoDev &&
		info.ino === identity.infoIno &&
		info.nlink === identity.infoNlink &&
		info.size === identity.infoSize &&
		info.mtimeNs === identity.infoMtimeNs &&
		info.ctimeNs === identity.infoCtimeNs &&
		info.sha256 === identity.infoSha256
	);
}

/**
 * Capture the exact tree at `lockDir`, or prove there is nothing there to capture.
 *
 * @returns `null` when the path is gone. A symlink, a special file, or anything else that
 * cannot be described entry-by-entry is not a legacy lock directory.
 * @throws {SessionStateLockUnavailableError} when the tree exists but cannot be described
 * exactly. A tree that cannot be described exactly cannot be removed exactly, so its bytes
 * stay where they are and the caller is told the lock is unusable.
 */
function captureLegacyDirectoryTree(
	native: SessionStateLockNativeBindings,
	lockDir: string,
): NativeDirectoryTreeSnapshot | null {
	let captured: NativeDirectoryTreeResult;
	try {
		captured = native.snapshotDirectoryTree(lockDir);
	} catch (error) {
		throw new SessionStateLockUnavailableError(error);
	}
	if (captured.ok && captured.snapshot) return captured.snapshot;
	if (captured.code === "not_found" || captured.code === "not_directory" || captured.code === "not_a_directory")
		return null;
	if (captured.code === "sharing_violation")
		throw new SessionStateLockUnavailableError(transientNativeResultError(captured.code));
	throw new SessionStateLockUnavailableError(
		new Error(`Legacy lock directory could not be captured: ${captured.code ?? "unknown"}.`),
	);
}

/**
 * Evaluate a `<file>.lock/` DIRECTORY left behind by a base runtime that guarded this same
 * state file with the generic directory-style lock.
 *
 * A directory at this path makes an exclusive create fail `EISDIR` forever, which is
 * exactly the stranding this shared lock exists to prevent — in the other direction.
 *
 * The VERDICT stays with the generic implementation, which owns that format: duplicating
 * its parser and liveness rules is how a live owner gets reaped by a timestamp it never
 * wrote. Only the REMOVAL is taken over, because that protocol can offer nothing better
 * than re-reading a token and then unlinking a pathname — and a successor can change the
 * tree underneath a token that still reads the same.
 *
 * But the verdict is rendered against a PATHNAME, and the object it judged is not the
 * object that would be deleted. A legacy writer takes no transition claim, so it can
 * remove the judged directory and create a brand-new LIVE one at the same path; capturing
 * "whatever is there now" hands the successor's own tree to the exact removal, which then
 * matches and deletes a live lock. The compare-and-delete protected the object it was
 * given — the authorization simply belonged to a different one.
 *
 * So the identity BRACKETS the verdict: the tree is captured before it, captured again
 * after it, and removed only when both captures are the same tree. Any replacement in that
 * window makes the two disagree and the reclaim declines, leaving the successor untouched.
 *
 * Nothing creates such a directory at this path anymore.
 */
async function reclaimStaleDirectoryLock(
	lockFile: string,
	quarantineName?: string,
	retryBudget?: LockRetryBudget,
): Promise<SessionStateLockReclaimResult> {
	const reserved = quarantineName ?? lockQuarantineName();
	return await withLockPathTransition(
		lockFile,
		async () => {
			const native = nativeSessionStateLock();
			const initial = captureLegacyDirectoryTree(native, lockFile);
			if (!initial) return "absent_or_changed";
			const initialRoot = initial.entries.find(entry => entry.relativePath === "");
			if (!initialRoot) return "legacy_directory_unprovenanced";
			if (initial.entries.length === 1) {
				if (Date.now() - Number(BigInt(initialRoot.mtimeNs) / 1_000_000n) < LOCK_STALE_MS)
					return "owner_record_fresh";
				await SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict?.(lockFile);
				const authorized = captureLegacyDirectoryTree(native, lockFile);
				if (!authorized || !sameDirectoryTreeSnapshot(initial, authorized)) return "absent_or_changed";
				await SessionStateLockTestHooks.beforeLegacyDirectoryRemoval?.(lockFile);
				let removed: NativeExactUnlinkResult;
				try {
					removed = native.exactRemoveDirectoryTree(lockFile, authorized);
				} catch (error) {
					throw new SessionStateLockUnavailableError(error);
				}
				if (removed.ok || removed.code === "not_found") return "reclaimed";
				if (removed.code === "identity_mismatch") return "absent_or_changed";
				if (
					removed.code === "cleanup_pending" &&
					removed.payloadDurable === true &&
					removed.detachedPath === `${lockFile}.removing` &&
					removed.retainedSuccessorPath === undefined &&
					removed.retainedUnknownPath === undefined &&
					removed.retainedPlaceholderPath === undefined
				) {
					try {
						await fs.lstat(lockFile);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return "reclaimed";
						throw new SessionStateLockUnavailableError(error);
					}
				}
				throw new SessionStateLockUnavailableError(
					new Error(`Empty legacy lock directory could not be removed: ${removed.code ?? "unknown"}.`),
				);
			}
			const ownerHostId =
				SessionStateLockTestHooks.unqualifiedOwnerIsLocal === true ? undefined : await currentOwnerHostId();
			let verdict = await genericFileLockDirStaleVerdict(lockFile, LOCK_STALE_MS, ownerHostId);
			if (!verdict.stale && ownerHostId !== undefined)
				verdict = await genericFileLockDirStaleVerdict(lockFile, LOCK_STALE_MS, await currentLegacyOwnerHostId());
			if (!verdict.stale)
				return (await readFileLockObservationForGc(lockFile))
					? "owner_live_or_unverifiable"
					: "legacy_directory_unprovenanced";
			const before = captureLegacyDirectoryTree(native, lockFile);
			if (!before || !legacyDirectoryMatchesVerdict(before, verdict.identity)) return "absent_or_changed";
			await SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict?.(lockFile);
			const authorized = captureLegacyDirectoryTree(native, lockFile);
			if (
				!authorized ||
				!legacyDirectoryMatchesVerdict(authorized, verdict.identity) ||
				!sameDirectoryTreeSnapshot(before, authorized)
			)
				return "absent_or_changed";
			await SessionStateLockTestHooks.beforeLegacyDirectoryRemoval?.(lockFile);
			let removed: NativeExactUnlinkResult;
			try {
				removed = native.exactRemoveDirectoryTree(lockFile, authorized);
			} catch (error) {
				throw new SessionStateLockUnavailableError(error);
			}
			if (removed.ok || removed.code === "not_found") return "reclaimed";
			if (
				removed.code === "cleanup_pending" &&
				removed.payloadDurable === true &&
				removed.detachedPath === `${lockFile}.removing`
			) {
				try {
					await fs.lstat(lockFile);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return "reclaimed";
					throw new SessionStateLockUnavailableError(error);
				}
			}
			if (removed.code === "sharing_violation")
				throw new SessionStateLockUnavailableError(transientNativeResultError(removed.code));
			if (removed.code === "identity_mismatch") return "absent_or_changed";
			throw new SessionStateLockUnavailableError(
				new Error(`Legacy lock directory could not be removed: ${removed.code ?? "unknown"}.`),
			);
		},
		reserved,
		retryBudget,
	);
}

/**
 * Decide what actually occupies the lock path, without following it.
 *
 * @internal exported as the seam these decisions are tested through: a live legacy
 * directory owner must be provably left alone without waiting out a real stale window.
 */
async function reclaimStaleSessionStateLockWithinBudget(
	lockFile: string,
	quarantineName: string | undefined,
	retryBudget: LockRetryBudget,
): Promise<SessionStateLockReclaimResult> {
	let stat: fsSync.Stats;
	try {
		stat = await fs.lstat(lockFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent_or_changed";
		throw error;
	}
	if (stat.isDirectory()) {
		return await reclaimStaleDirectoryLock(lockFile, quarantineName, retryBudget);
	}
	// A symlink, FIFO, socket, or device is not a shape either lock protocol writes.
	// Opening one follows an attacker-chosen target and a FIFO read blocks forever, so the
	// path is refused outright rather than inspected or removed.
	if (!stat.isFile()) throw lockUnavailable(lockFile, "unsafe_lock_path_type");
	await SessionStateLockTestHooks.afterLockTypeDecision?.(lockFile);
	return await reclaimStaleRegularLock(lockFile, quarantineName, retryBudget);
}

export async function reclaimStaleSessionStateLock(lockFile: string, quarantineName?: string): Promise<void> {
	const budget = lockRetryBudget();
	try {
		await reclaimStaleSessionStateLockWithinBudget(lockFile, quarantineName, budget);
	} catch (error) {
		throw lockDiagnostic(error, lockFile, "lock_inspection_failed", budget);
	}
}

/**
 * Serialize one read-modify-write of `stateFile` against every other holder of
 * `<stateFile>.lock`.
 *
 * Taking the path, cleaning up a failed write, and releasing are all pathname transitions,
 * so each runs under the transition claim — never the caller's operation, which holds the
 * lock file itself and may run for as long as it needs.
 */
export async function withSessionStateFileLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	const lockFile = `${stateFile}.lock`;
	const budget = lockRetryBudget();
	let owner: SessionStateLockOwner;
	try {
		owner = await newLockOwner();
		await ensureSessionStateParent(path.dirname(stateFile));
	} catch (error) {
		const cause = error instanceof SessionStateLockUnavailableError ? (error.cause ?? error) : error;
		throw lockUnavailable(lockFile, "lock_initialization_failed", budget, cause);
	}
	const cycleQuarantine = lockQuarantineName();
	let lastReason: SessionStateLockUnavailableReason = "acquire_timeout";
	for (;;) {
		let held: LockOwnerSnapshot | undefined;
		let callbackFailure = false;
		let callbackError: unknown;
		try {
			// Contention (`EEXIST`, or `EISDIR`/`EPERM` for a legacy directory owner)
			// propagates out of the claim to the evaluation below; the claim is released
			// first, so the reclaim that follows can take it.
			held = await withLockPathTransition(
				lockFile,
				() => acquireOwnerLock(lockFile, owner, cycleQuarantine),
				cycleQuarantine,
				budget,
			);
			let outcome: { ok: true; value: T } | { ok: false; error: unknown };
			try {
				outcome = { ok: true, value: await operation() };
			} catch (error) {
				outcome = { ok: false, error };
			}
			const record = held;
			// Released against the identity captured when it was written, so a record that
			// is no longer ours is left for its owner rather than unlinked by name.
			let releaseFailure: { error: unknown } | undefined;
			try {
				await withLockPathTransition(lockFile, async () => releaseOwnerLock(lockFile, record), cycleQuarantine);
			} catch (error) {
				releaseFailure = { error };
			}
			if (!outcome.ok) {
				if (releaseFailure)
					throw new AggregateError(
						[outcome.error, releaseFailure.error],
						"Session state operation failed and its owner record could not be released.",
					);
				callbackFailure = true;
				callbackError = outcome.error;
				throw outcome.error;
			}
			if (releaseFailure) throw releaseFailure.error;
			return outcome.value;
		} catch (error) {
			if (callbackFailure && error === callbackError) throw error;
			// A fault after the lock was taken belongs to the operation, not to acquisition.
			if (held) throw lockDiagnostic(error, lockFile, "lock_release_failed");
			// Without a safe owner-record access strategy, retrying cannot make the
			// transition claim removable. Preserve it as a fail-closed fence instead
			// of spinning until the acquisition budget expires.
			if (ownerAccessStrategy() === "unsupported")
				throw lockDiagnostic(error, lockFile, "lock_inspection_failed", budget);
			// A legacy `<file>.lock/` directory reports EISDIR (EPERM on some platforms);
			// both are contention to be evaluated, not a hard failure.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EISDIR" && !isTransientLockError(error))
				throw lockDiagnostic(
					error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error),
					lockFile,
					"lock_inspection_failed",
					budget,
				);
			const reclaim = await reclaimStaleSessionStateLockWithinBudget(lockFile, cycleQuarantine, budget).catch(
				error => {
					throw lockDiagnostic(error, lockFile, "lock_inspection_failed", budget);
				},
			);
			if (reclaim === "owner_unprovenanced")
				throw lockUnavailable(lockFile, "lock_owner_record_unprovenanced", budget);
			if (reclaim === "legacy_directory_unprovenanced") lastReason = "legacy_directory_owner_unprovenanced";
			else if (reclaim === "owner_live_or_unverifiable") lastReason = "lock_owner_live_or_unverifiable";
			else if (reclaim === "owner_record_fresh") lastReason = "lock_owner_record_fresh";
			SessionStateLockTestHooks.afterAcquireContention?.(lockFile, budget.attempts + 1, lockRetryElapsedMs(budget));
			if (!(await waitForLockRetry(budget))) throw lockUnavailable(lockFile, lastReason, budget);
		}
	}
}
