import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
} from "@gajae-code/natives";
import { genericFileLockDirIsStale, processStartTime as portableProcessStartTime } from "../config/file-lock";
import { loadInstallationHostId, loadLegacyInstallationHostId } from "../config/machine-identity";
import { readLinuxProcStartTimeSync } from "./linux-proc";

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
const LOCK_ACQUIRE_ATTEMPTS = 12_000;
const LOCK_ACQUIRE_RETRY_MS = 5;
const LOCK_STALE_MS = 30_000;

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
 * fail-closed directory for explicit recovery; concurrent automatic reclaim cannot prove
 * that a directory + sibling sidecar still name the claim it inspected.
 *
 * The separate sidecar keeps the claim directory empty, which is what makes `rmdir` the
 * identity-safe portable release primitive. The path stays distinct from `<file>.lock`
 * (whose regular-file owner format base writers read) and from the outer
 * `locks/mutation.lock` (whose generic directory semantics are unchanged).
 */
const LOCK_TRANSITION_RESOURCE_SUFFIX = ".transition";
const LINUX_PROC_START_TIME_FORMAT = "linux-proc-v1";
const PORTABLE_START_TIME_FORMAT = "ps-utc-v1";
const TRANSIENT_LOCK_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function isTransientLockError(error: unknown): boolean {
	return TRANSIENT_LOCK_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

interface SessionStateLockOwner {
	pid: number;
	start_time: string;
	start_time_format?: string;
	token: string;
	owner_host_id?: string;
	released?: true;
}

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
	/**
	 * @internal Runs after a live owner has been proven and immediately before its
	 * final pathname capture for release. Tests use it to replace the pathname and
	 * prove that live-owner cleanup refuses a successor.
	 */
	beforeCurrentOwnerRelease?: (file: string) => void | Promise<void>;
	beforeLegacyDirectoryRemoval?: (lockDir: string) => void | Promise<void>;
} = {};

/** Raised when the lock could not be acquired; callers map it to their own refusal. */
export class SessionStateLockUnavailableError extends Error {
	constructor(cause?: unknown) {
		super("Coordinator session state lock is unavailable.");
		this.name = "SessionStateLockUnavailableError";
		if (cause !== undefined) this.cause = cause;
	}
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
	"exactRemoveDirectoryTree" | "exactUnlink" | "snapshotDirectoryTree"
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
let legacyOwnerHostIdPromise: Promise<string> | undefined;

async function currentOwnerHostId(): Promise<string> {
	try {
		let hostId: string;
		if (SessionStateLockTestHooks.ownerHostId) {
			hostId = await SessionStateLockTestHooks.ownerHostId();
		} else {
			const promise =
				ownerHostIdPromise ?? (SessionStateLockTestHooks.loadInstallationHostId ?? loadInstallationHostId)();
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
function lockQuarantineName(): string {
	return `.gjc-delete-session-state-lock-${randomUUID()}.json`;
}

/**
 * Delete the regular owner record at `file`, but only while it is still EXACTLY `identity`.
 *
 * @throws {SessionStateLockUnavailableError} when the primitive itself cannot run. It is
 * never downgraded to `fs.rm`: not knowing what is at the pathname is precisely the state
 * in which deleting it destroys a successor's lock.
 */
function exactUnlinkOwnerRecord(file: string, identity: LockOwnerSnapshot): ExactRemovalOutcome {
	let result: NativeExactUnlinkResult;
	try {
		result = nativeSessionStateLock().exactUnlink(file, {
			dev: identity.dev,
			ino: identity.ino,
			nlink: identity.nlink,
			size: identity.size,
			mtimeNs: identity.mtimeNs,
			sha256: identity.sha256,
			quarantineName: lockQuarantineName(),
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

async function releasedLockOwner(): Promise<SessionStateLockOwner> {
	return {
		// PID 1 exists in every supported process namespace. Legacy readers that do
		// not understand `released` therefore keep this compatibility fence instead
		// of deleting it and racing a current writer.
		pid: 1,
		start_time: "unknown",
		token: randomUUID(),
		owner_host_id: await currentOwnerHostId(),
		released: true,
	};
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
): Promise<void> {
	if (!created) return;
	const stillOpen = await openOwnerIdentity(handle);
	if (!stillOpen || stillOpen.dev !== created.dev || stillOpen.ino !== created.ino) return;
	if (ownerAccessStrategy() === "windows-validated") await handle.close().catch(() => undefined);
	const current = await captureRegularLockOwner(file).catch(() => null);
	if (!current || current.dev !== created.dev || current.ino !== created.ino) return;
	exactUnlinkOwnerRecord(file, current);
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
async function createOwnerLock(file: string, owner: SessionStateLockOwner): Promise<LockOwnerSnapshot> {
	const flags = ownerCreateFlags();
	if (flags === undefined)
		throw new SessionStateLockUnavailableError(
			new Error("Safe owner record creation is unsupported on this platform."),
		);
	nativeSessionStateLock();
	const handle = await fs.open(file, flags);
	const bytes = Buffer.from(JSON.stringify(owner), "utf8");
	// Taken from the SAME descriptor the exclusive create produced, before anything is
	// written through it. `O_EXCL` proves the object did not exist a moment ago, so this
	// pair names the record this call brought into existence and nothing else.
	let created: OpenOwnerIdentity | null = null;
	try {
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
			await retractFailedOwnerRecord(file, handle, created);
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

		const replacementBytes = Buffer.from(JSON.stringify(replacement), "utf8");
		await handle.truncate(0);
		let offset = 0;
		while (offset < replacementBytes.byteLength) {
			const { bytesWritten } = await handle.write(
				replacementBytes,
				offset,
				replacementBytes.byteLength - offset,
				offset,
			);
			if (bytesWritten <= 0) throw new Error("Owner record rewrite made no progress.");
			offset += bytesWritten;
		}
		await handle.truncate(replacementBytes.byteLength);
		await handle.sync();
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
		throw error instanceof SessionStateLockUnavailableError ? error : new SessionStateLockUnavailableError(error);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function acquireOwnerLock(file: string, owner: SessionStateLockOwner): Promise<LockOwnerSnapshot> {
	nativeSessionStateLock();
	try {
		return await createOwnerLock(file, owner);
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
		if (!validLockOwner(observed) || observed.released !== true) throw error;
		return await rewriteHeldOwnerRecord(file, current, owner);
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
 * successor strictly alone.
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
async function reclaimStaleOwnerRecord(
	file: string,
	hooks: {
		afterInspection?: (file: string) => void | Promise<void>;
		beforeRemoval?: (file: string) => void | Promise<void>;
	},
): Promise<void> {
	const snapshot = await captureRegularLockOwner(file);
	if (!snapshot) return;
	let owner: unknown;
	try {
		owner = JSON.parse(snapshot.bytes);
	} catch {
		owner = null;
	}
	if (!validLockOwner(owner)) {
		if (SessionStateLockTestHooks.unqualifiedOwnerIsLocal !== true) return;
		// The mtime of the very inode the bytes were read from, not a fresh path `stat`.
		if (Date.now() - Number(snapshot.mtimeNs / 1_000_000n) < LOCK_STALE_MS) return;
	} else if (await lockOwnerIsAlive(owner)) return;
	await hooks.afterInspection?.(file);
	const current = await captureRegularLockOwner(file);
	if (!current || !sameLockOwnerSnapshot(current, snapshot)) return;
	await hooks.beforeRemoval?.(file);
	const outcome = exactUnlinkOwnerRecord(file, current);
	// A successor that took the path in the final window keeps it; this call just loses.
	if (outcome === "refused")
		throw new SessionStateLockUnavailableError(new Error("Stale owner record could not be reclaimed."));
}

async function releaseTransitionClaim(
	transitionDir: string,
	ownerFile: string,
	held: LockOwnerSnapshot,
): Promise<void> {
	await SessionStateLockTestHooks.beforeCurrentOwnerRelease?.(ownerFile);
	const current = await captureRegularLockOwner(ownerFile);
	if (!current || !sameLockOwnerSnapshot(current, held))
		throw new SessionStateLockUnavailableError(new Error("Transition owner changed before release."));
	await SessionStateLockTestHooks.afterCurrentOwnerValidation?.(ownerFile);
	await rewriteHeldOwnerRecord(ownerFile, held, await releasedLockOwner());
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

async function reclaimStaleTransitionClaim(transitionDir: string): Promise<void> {
	const stat = await fs.lstat(transitionDir).catch(() => null);
	if (!stat) return;
	// Regular-file claims belong to the superseded protocol. They retain the old
	// exact-identity stale path; released PID-1 tombstones deliberately require
	// explicit cleanup before this atomic-directory protocol can take over.
	if (stat.isFile()) {
		await reclaimStaleOwnerRecord(transitionDir, {
			afterInspection: SessionStateLockTestHooks.afterTransitionStaleInspection,
			beforeRemoval: SessionStateLockTestHooks.beforeTransitionStaleRemoval,
		});
		return;
	}
	if (!stat.isDirectory()) throw new SessionStateLockUnavailableError();
	// No portable operation can atomically prove that this directory + sibling
	// sidecar are still the dead claim two concurrent reclaimers inspected. A
	// crashed atomic claim therefore stays fail-closed for explicit recovery.
}

/** Run one pathname transition under an atomic `mkdir`/`rmdir` claim. */
async function withLockPathTransition<T>(lockFile: string, transition: () => Promise<T>): Promise<T> {
	const transitionDir = `${lockFile}${LOCK_TRANSITION_RESOURCE_SUFFIX}`;
	const ownerFile = `${transitionDir}.owner`;
	const owner = await newLockOwner();
	for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
		try {
			await fs.mkdir(transitionDir);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && !isTransientLockError(error)) throw new SessionStateLockUnavailableError(error);
			await reclaimStaleTransitionClaim(transitionDir);
			await Bun.sleep(LOCK_ACQUIRE_RETRY_MS);
			continue;
		}
		let held: LockOwnerSnapshot;
		try {
			held = await acquireOwnerLock(ownerFile, owner);
		} catch (error) {
			await fs.rmdir(transitionDir).catch(() => undefined);
			throw error;
		}
		const outcome = await transition().then(
			value => ({ ok: true as const, value }),
			error => ({ ok: false as const, error }),
		);
		try {
			await releaseTransitionClaim(transitionDir, ownerFile, held);
		} catch (releaseError) {
			if (!outcome.ok)
				throw new SessionStateLockUnavailableError(
					new AggregateError([outcome.error, releaseError], "Lock path transition and release both failed."),
				);
			throw releaseError;
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}
	throw new SessionStateLockUnavailableError();
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
async function reclaimStaleRegularLock(lockFile: string): Promise<void> {
	await withLockPathTransition(
		lockFile,
		async () =>
			await reclaimStaleOwnerRecord(lockFile, {
				afterInspection: SessionStateLockTestHooks.afterStaleInspection,
				beforeRemoval: SessionStateLockTestHooks.beforeStaleRemoval,
			}),
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
	if (captured.code === "not_found") return null;
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
async function reclaimStaleDirectoryLock(lockFile: string): Promise<void> {
	await withLockPathTransition(lockFile, async () => {
		const native = nativeSessionStateLock();
		const before = captureLegacyDirectoryTree(native, lockFile);
		if (!before) return;
		const ownerHostId =
			SessionStateLockTestHooks.unqualifiedOwnerIsLocal === true ? undefined : await currentOwnerHostId();
		let stale = await genericFileLockDirIsStale(lockFile, LOCK_STALE_MS, ownerHostId);
		if (!stale && ownerHostId !== undefined)
			stale = await genericFileLockDirIsStale(lockFile, LOCK_STALE_MS, await currentLegacyOwnerHostId());
		if (!stale) return;
		await SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict?.(lockFile);
		const authorized = captureLegacyDirectoryTree(native, lockFile);
		// The verdict spoke for `before`; only an unchanged tree carries that authority.
		if (!authorized || !sameDirectoryTreeSnapshot(before, authorized)) return;
		await SessionStateLockTestHooks.beforeLegacyDirectoryRemoval?.(lockFile);
		let removed: NativeExactUnlinkResult;
		try {
			// The SAME verified capture the verdict was bound to, so a replacement that
			// lands after this point is still refused by the primitive itself.
			removed = native.exactRemoveDirectoryTree(lockFile, authorized);
		} catch (error) {
			throw new SessionStateLockUnavailableError(error);
		}
		if (removed.ok || removed.code === "not_found") return;
		// Current natives may finish the security-critical phase by durably scrubbing the
		// authorized tree and detaching it to the one replayable `.removing` name. That
		// retained cleanup authority is not a live lock: acquisition may continue only when
		// the typed receipt names exactly that sibling and the original namespace is still
		// absent. A successor already at the lock path remains authoritative and fails closed.
		if (
			removed.code === "cleanup_pending" &&
			removed.payloadDurable === true &&
			removed.detachedPath === `${lockFile}.removing`
		) {
			try {
				await fs.lstat(lockFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw new SessionStateLockUnavailableError(error);
			}
		}
		// The tree changed after it was captured, so it belongs to a successor now.
		if (removed.code === "identity_mismatch") return;
		throw new SessionStateLockUnavailableError(
			new Error(`Legacy lock directory could not be removed: ${removed.code ?? "unknown"}.`),
		);
	});
}

/**
 * Decide what actually occupies the lock path, without following it.
 *
 * @internal exported as the seam these decisions are tested through: a live legacy
 * directory owner must be provably left alone without waiting out a real stale window.
 */
export async function reclaimStaleSessionStateLock(lockFile: string): Promise<void> {
	let stat: fsSync.Stats;
	try {
		stat = await fs.lstat(lockFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stat.isDirectory()) {
		await reclaimStaleDirectoryLock(lockFile);
		return;
	}
	// A symlink, FIFO, socket, or device is not a shape either lock protocol writes.
	// Opening one follows an attacker-chosen target and a FIFO read blocks forever, so the
	// path is refused outright rather than inspected or removed.
	if (!stat.isFile()) throw new SessionStateLockUnavailableError();
	await SessionStateLockTestHooks.afterLockTypeDecision?.(lockFile);
	await reclaimStaleRegularLock(lockFile);
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
	const owner = await newLockOwner();
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
		let held: LockOwnerSnapshot | undefined;
		try {
			// Contention (`EEXIST`, or `EISDIR`/`EPERM` for a legacy directory owner)
			// propagates out of the claim to the evaluation below; the claim is released
			// first, so the reclaim that follows can take it.
			held = await withLockPathTransition(lockFile, () => acquireOwnerLock(lockFile, owner));
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
				await withLockPathTransition(lockFile, async () => releaseOwnerLock(lockFile, record));
			} catch (error) {
				releaseFailure = { error };
			}
			if (!outcome.ok) {
				if (releaseFailure)
					throw new AggregateError(
						[outcome.error, releaseFailure.error],
						"Session state operation failed and its owner record could not be released.",
					);
				throw outcome.error;
			}
			if (releaseFailure) throw releaseFailure.error;
			return outcome.value;
		} catch (error) {
			// A fault after the lock was taken belongs to the operation, not to acquisition.
			if (held) throw error;
			// A legacy `<file>.lock/` directory reports EISDIR (EPERM on some platforms);
			// both are contention to be evaluated, not a hard failure.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EISDIR" && !isTransientLockError(error))
				throw error instanceof SessionStateLockUnavailableError
					? error
					: new SessionStateLockUnavailableError(error);
			await reclaimStaleSessionStateLock(lockFile);
			await Bun.sleep(LOCK_ACQUIRE_RETRY_MS);
		}
	}
	throw new SessionStateLockUnavailableError();
}
