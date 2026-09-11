import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { exactUnlink } from "@gajae-code/natives";
import { isEnoent, logger, postmortem } from "@gajae-code/utils";

const BLOB_PREFIX = "blob:sha256:";
const CANONICAL_BLOB_NAME = /^[0-9a-f]{64}$/;
const TAKE_BLOB_BUFFER_OWNERSHIP = Symbol("takeBlobBufferOwnership");

function isCanonicalBlobHash(hash: string): boolean {
	return hash.length === 64 && CANONICAL_BLOB_NAME.test(hash);
}

/**
 * Owner-only permissions for on-disk blob directories and files.
 *
 * Generic blob stores may live inside a managed session scope, whose snapshot
 * fails closed unless every descendant is owner-only. Resident text instead
 * uses a verified private cache root, but its instance directories and blobs
 * obey the same 0700/0600 contract.
 */
const BLOB_DIR_MODE = 0o700;
const BLOB_FILE_MODE = 0o600;

const RESIDENT_CACHE_OWNER_RECORD = "owner.json";
const RESIDENT_CACHE_GC_MAX_DIRECTORIES = 64;
const RESIDENT_CACHE_GC_MAX_DURATION_MS = 250;
const RESIDENT_CACHE_SWEEP_EXPECTED_IO_CODES = new Set([
	"EACCES",
	"EBUSY",
	"EEXIST",
	"EIO",
	"EISDIR",
	"ELOOP",
	"EMFILE",
	"ENAMETOOLONG",
	"ENFILE",
	"ENOENT",
	"ENOTDIR",
	"ENOTEMPTY",
	"EPERM",
	"EROFS",
	"ESTALE",
]);
const ownedResidentCacheInstanceDirs = new Set<string>();
const activeResidentCacheRootSweeps = new Set<string>();
let ownResidentCacheProcessStartTimeMs: number | null | undefined;

/** Marks `startTimeMs` as an absolute instant parsed from a UTC-pinned `ps` render. */
const RESIDENT_CACHE_START_TIME_BASIS = "utc";

interface ResidentCacheOwnerToken {
	readonly pid: number;
	readonly startTimeMs: number | null;
	/**
	 * Absent on tokens written before the start time was pinned to UTC. Such a
	 * value is a wall clock in the writer's zone, so comparing it against an
	 * absolute one proves nothing about PID reuse and must not imply staleness.
	 */
	readonly startTimeBasis?: string;
	readonly nonce: string;
	readonly createdAt?: number;
}

interface ResidentCacheOwnerSnapshot {
	readonly owner: ResidentCacheOwnerToken;
	readonly directory: fs.Stats;
}

/** Limits for a single best-effort resident-cache garbage-collection pass. */
export interface ResidentCacheGcSweepOptions {
	readonly maxDirectories?: number;
	readonly maxDurationMs?: number;
}

export interface BlobPutResult {
	hash: string;
	path: string;
	get ref(): string;
}

export interface CheckedBlobPutResult extends BlobPutResult {
	bytes: number;
}

export class BlobCorruptError extends Error {
	constructor(
		readonly hash: string,
		readonly path: string,
	) {
		super(`Blob ${hash} at ${path} failed SHA-256 verification`);
		this.name = "BlobCorruptError";
	}
}

/**
 * A resident-cache path or blob failed the owner-only verification contract.
 * SessionManager catches this error to demote the entire resident store to
 * memory before retrying the triggering write.
 */
export class ResidentCacheTrustError extends Error {
	/**
	 * errno of the OS failure this rejection wrapped (`ENOENT`, `EMFILE`, `EACCES`, …),
	 * or `undefined` when the rejection was a pure policy decision with no cause.
	 * `reason` alone names the *step* that failed; only this names *why*, so a
	 * demotion is diagnosable from a log line instead of requiring a debugger.
	 */
	readonly causeCode: string | undefined;
	/** Bounded one-line rendering of the wrapped cause for logs that must not serialize an arbitrary thrown value. */
	readonly causeSummary: string | undefined;

	constructor(
		readonly reason: string,
		readonly path: string,
		options?: ErrorOptions,
	) {
		super(`Resident cache trust validation failed (${reason}): ${path}`, options);
		this.name = "ResidentCacheTrustError";
		this.causeCode = errorCode(options?.cause);
		this.causeSummary = summarizeResidentCacheTrustCause(options?.cause);
	}
}

const RESIDENT_CACHE_CAUSE_SUMMARY_MAX_CHARS = 200;

function summarizeResidentCacheTrustCause(cause: unknown): string | undefined {
	if (cause === undefined) return undefined;
	let text: string;
	try {
		text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
	} catch {
		// A cause whose own stringification throws must not turn a demotion into a crash.
		return "<uninspectable cause>";
	}
	text = text.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length > RESIDENT_CACHE_CAUSE_SUMMARY_MAX_CHARS
		? `${text.slice(0, RESIDENT_CACHE_CAUSE_SUMMARY_MAX_CHARS - 1)}…`
		: text;
}

function residentCacheTrustError(reason: string, pathname: string, cause?: unknown): ResidentCacheTrustError {
	if (cause instanceof ResidentCacheTrustError) return cause;
	return new ResidentCacheTrustError(reason, pathname, cause === undefined ? undefined : { cause });
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function isExpectedResidentCacheSweepFailure(error: unknown): boolean {
	return (
		error instanceof ResidentCacheTrustError || RESIDENT_CACHE_SWEEP_EXPECTED_IO_CODES.has(errorCode(error) ?? "")
	);
}

function residentCacheOwnerUid(pathname: string): number {
	if (process.platform === "win32") {
		throw new ResidentCacheTrustError("unsupported_platform", pathname);
	}
	const uid = process.getuid?.();
	if (uid === undefined) throw new ResidentCacheTrustError("owner_identity_unavailable", pathname);
	return uid;
}

function hasOwnerOnlyMode(mode: number): boolean {
	return (mode & 0o077) === 0;
}

function residentCacheDirectoryOpenFlags(pathname: string): number {
	const noFollow = fs.constants.O_NOFOLLOW;
	const directory = fs.constants.O_DIRECTORY;
	if (!noFollow || !directory) throw new ResidentCacheTrustError("no_follow_unavailable", pathname);
	return fs.constants.O_RDONLY | directory | noFollow;
}

function hasSameFilesystemIdentity(a: fs.Stats, b: fs.Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function assertResidentCacheDirectory(pathname: string, uid: number): fs.Stats {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(pathname);
	} catch (error) {
		throw residentCacheTrustError("directory_unverifiable", pathname, error);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || !hasOwnerOnlyMode(stat.mode)) {
		throw new ResidentCacheTrustError("directory_untrusted", pathname);
	}
	return stat;
}

function assertResidentCacheDirectoryDescriptor(
	pathname: string,
	expected: fs.Stats,
	descriptor: number,
	uid: number,
): void {
	let opened: fs.Stats;
	try {
		opened = fs.fstatSync(descriptor);
	} catch (error) {
		throw residentCacheTrustError("directory_descriptor_unverifiable", pathname, error);
	}
	if (
		!opened.isDirectory() ||
		opened.uid !== uid ||
		!hasOwnerOnlyMode(opened.mode) ||
		!hasSameFilesystemIdentity(expected, opened)
	) {
		throw new ResidentCacheTrustError("directory_identity_changed", pathname);
	}
}

function openVerifiedResidentCacheDirectory(pathname: string, uid: number): number {
	const expected = assertResidentCacheDirectory(pathname, uid);
	let descriptor: number | null = null;
	try {
		descriptor = fs.openSync(pathname, residentCacheDirectoryOpenFlags(pathname));
		assertResidentCacheDirectoryDescriptor(pathname, expected, descriptor, uid);
		return descriptor;
	} catch (error) {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// Preserve the verification failure.
			}
		}
		throw residentCacheTrustError("directory_open_untrusted", pathname, error);
	}
}

function assertResidentCacheDirectoryPathMatchesDescriptor(pathname: string, descriptor: number, uid: number): void {
	const current = assertResidentCacheDirectory(pathname, uid);
	assertResidentCacheDirectoryDescriptor(pathname, current, descriptor, uid);
}

function residentCacheProcessStartTimeMs(pid: number): number | null {
	if (pid === process.pid && ownResidentCacheProcessStartTimeMs !== undefined) {
		return ownResidentCacheProcessStartTimeMs;
	}

	// Mirror file-lock's `ps`-based process incarnation probe, but pin the locale
	// AND the zone. `lstart` is a zoneless local wall clock rendered by `ps` from
	// /etc/localtime, while `Date.parse` of a zoneless string binds it to the JS
	// runtime's own zone. Those are two independent resolutions, so a reader whose
	// runtime resolves UTC while `ps` renders UTC+9 derives an epoch nine hours off
	// for the very same live process — and this value's only job is to detect PID
	// reuse, so a disagreeing reader reports every live owner as reused and the GC
	// reaps a running session's cache. Pinning TZ on the child fixes the rendering
	// side; the explicit GMT suffix fixes the parsing side.
	let startTimeMs: number | null = null;
	try {
		const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
		});
		if (result.exitCode === 0) {
			const rendered = new TextDecoder().decode(result.stdout).trim();
			const parsed = rendered ? Date.parse(`${rendered} GMT`) : Number.NaN;
			if (Number.isFinite(parsed)) startTimeMs = parsed;
		}
	} catch {
		// An unavailable process-start source cannot prove PID reuse.
	}
	if (pid === process.pid) ownResidentCacheProcessStartTimeMs = startTimeMs;
	return startTimeMs;
}

type ResidentCacheOwnerLiveness = "alive" | "dead" | "unknown";

function residentCacheOwnerLiveness(pid: number): ResidentCacheOwnerLiveness {
	if (!Number.isFinite(pid) || pid <= 0) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return "dead";
		// EPERM means the process exists but the current user cannot signal it.
		// All other errors leave liveness indeterminate and fail closed.
		return code === "EPERM" ? "alive" : "unknown";
	}
}

function isTrustedResidentCacheOwnerFile(stat: fs.Stats, uid: number): boolean {
	return (
		stat.isFile() &&
		!stat.isSymbolicLink() &&
		stat.uid === uid &&
		hasOwnerOnlyMode(stat.mode) &&
		stat.size <= 16 * 1024
	);
}

function parseResidentCacheOwnerToken(text: string): ResidentCacheOwnerToken | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { pid, startTimeMs, startTimeBasis, nonce, createdAt } = parsed as {
		pid?: unknown;
		startTimeMs?: unknown;
		startTimeBasis?: unknown;
		nonce?: unknown;
		createdAt?: unknown;
	};
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		(startTimeMs !== null && (typeof startTimeMs !== "number" || !Number.isFinite(startTimeMs))) ||
		(startTimeBasis !== undefined && typeof startTimeBasis !== "string") ||
		typeof nonce !== "string" ||
		nonce.length === 0 ||
		(createdAt !== undefined && (typeof createdAt !== "number" || !Number.isFinite(createdAt)))
	) {
		return null;
	}
	return {
		pid,
		startTimeMs,
		...(startTimeBasis === undefined ? {} : { startTimeBasis }),
		nonce,
		...(createdAt === undefined ? {} : { createdAt }),
	};
}

function sameResidentCacheOwnerToken(a: ResidentCacheOwnerToken, b: ResidentCacheOwnerToken): boolean {
	return (
		a.pid === b.pid &&
		a.startTimeMs === b.startTimeMs &&
		a.startTimeBasis === b.startTimeBasis &&
		a.nonce === b.nonce &&
		a.createdAt === b.createdAt
	);
}

function readResidentCacheOwnerSnapshot(instanceDir: string, uid: number): ResidentCacheOwnerSnapshot | null {
	let descriptor: number | null = null;
	try {
		descriptor = openVerifiedResidentCacheDirectory(instanceDir, uid);
		assertResidentCacheDirectoryPathMatchesDescriptor(instanceDir, descriptor, uid);
		const directory = fs.fstatSync(descriptor);
		const ownerPath = path.join(instanceDir, RESIDENT_CACHE_OWNER_RECORD);
		const before = fs.lstatSync(ownerPath);
		if (!isTrustedResidentCacheOwnerFile(before, uid)) return null;
		const owner = parseResidentCacheOwnerToken(fs.readFileSync(ownerPath, "utf8"));
		if (!owner) return null;
		const after = fs.lstatSync(ownerPath);
		if (!isTrustedResidentCacheOwnerFile(after, uid) || !hasSameFilesystemIdentity(before, after)) return null;
		assertResidentCacheDirectoryPathMatchesDescriptor(instanceDir, descriptor, uid);
		return { owner, directory };
	} catch {
		return null;
	} finally {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// A failed close cannot make a previously unreadable owner trustworthy.
			}
		}
	}
}

function writeResidentCacheOwnerToken(instanceDir: string, uid: number): void {
	const nonce = path.basename(instanceDir).slice("i-".length);
	if (!nonce) throw new ResidentCacheTrustError("instance_nonce_missing", instanceDir);
	const owner: ResidentCacheOwnerToken = {
		pid: process.pid,
		startTimeMs: residentCacheProcessStartTimeMs(process.pid),
		startTimeBasis: RESIDENT_CACHE_START_TIME_BASIS,
		nonce,
		createdAt: Date.now(),
	};
	const ownerPath = path.join(instanceDir, RESIDENT_CACHE_OWNER_RECORD);
	const noFollow = fs.constants.O_NOFOLLOW;
	if (!noFollow) throw new ResidentCacheTrustError("no_follow_unavailable", ownerPath);

	let descriptor: number | null = null;
	let expected: fs.Stats | null = null;
	let failure: ResidentCacheTrustError | null = null;
	try {
		descriptor = fs.openSync(
			ownerPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
			BLOB_FILE_MODE,
		);
		fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
		fs.fchmodSync(descriptor, BLOB_FILE_MODE);
		expected = fs.fstatSync(descriptor);
		if (!isTrustedResidentCacheOwnerFile(expected, uid)) {
			throw new ResidentCacheTrustError("owner_file_untrusted", ownerPath);
		}
	} catch (error) {
		failure = residentCacheTrustError("owner_write_failed", ownerPath, error);
	} finally {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch (error) {
				failure ??= residentCacheTrustError("owner_close_failed", ownerPath, error);
			}
		}
	}
	if (failure !== null) throw failure;

	try {
		const current = fs.lstatSync(ownerPath);
		if (
			expected === null ||
			!isTrustedResidentCacheOwnerFile(current, uid) ||
			!hasSameFilesystemIdentity(expected, current)
		) {
			throw new ResidentCacheTrustError("owner_identity_changed", ownerPath);
		}
	} catch (error) {
		throw residentCacheTrustError("owner_write_untrusted", ownerPath, error);
	}
}

function removeEmptyResidentCacheInstanceDir(instanceDir: string): void {
	try {
		const stat = fs.lstatSync(instanceDir);
		if (stat.isSymbolicLink()) {
			fs.unlinkSync(instanceDir);
		} else if (stat.isDirectory()) {
			fs.rmdirSync(instanceDir);
		}
	} catch {
		// The candidate is already absent, was replaced, or is no longer empty.
		// Never recursively delete an unverified path while handling a trust failure.
	}
}

function removeResidentCacheTreeNoFollow(pathname: string): void {
	const stat = fs.lstatSync(pathname);
	if (stat.isDirectory() && !stat.isSymbolicLink()) {
		for (const entry of fs.readdirSync(pathname)) {
			removeResidentCacheTreeNoFollow(path.join(pathname, entry));
		}
		fs.rmdirSync(pathname);
		return;
	}
	fs.unlinkSync(pathname);
}

/**
 * Disposal-time parent authority is an *identity* contract: the retained descriptor
 * must still name the same owned directory, so a substituted parent (rename, symlink,
 * or a foreign directory moved into place) fails closed and keeps disposal retryable.
 *
 * It deliberately does not re-assert the parent's owner-only mode. Adoption and every
 * read/write path already refuse an untrusted (group/other-accessible) cache root, and
 * the instance directory itself stays fully verified here — owner, mode, `O_NOFOLLOW`
 * open, and post-rename `dev`/`ino` identity. Requiring owner-only mode on the parent
 * *at disposal time* would instead turn a widened root into permanent retention of the
 * predecessor's resident session bytes, which is the leak disposal exists to prevent.
 */
function assertResidentCacheDisposalParentIdentity(pathname: string, descriptor: number, uid: number): void {
	let current: fs.Stats;
	try {
		current = fs.lstatSync(pathname);
	} catch (error) {
		throw residentCacheTrustError("directory_unverifiable", pathname, error);
	}
	if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== uid)
		throw new ResidentCacheTrustError("directory_untrusted", pathname);
	let opened: fs.Stats;
	try {
		opened = fs.fstatSync(descriptor);
	} catch (error) {
		throw residentCacheTrustError("directory_descriptor_unverifiable", pathname, error);
	}
	if (!opened.isDirectory() || opened.uid !== uid || !hasSameFilesystemIdentity(current, opened))
		throw new ResidentCacheTrustError("directory_identity_changed", pathname);
}

function assertResidentCacheDisposalParent(instanceDir: string, parentDescriptor: number): void {
	const parentDir = path.dirname(instanceDir);
	try {
		assertResidentCacheDisposalParentIdentity(parentDir, parentDescriptor, residentCacheOwnerUid(parentDir));
	} catch (error) {
		throw residentCacheTrustError("parent_authority_changed", instanceDir, error);
	}
}

export function disposeVerifiedResidentCacheInstanceDir(instanceDir: string, parentDescriptor?: number): void {
	const instanceKey = path.resolve(instanceDir);
	const uid = residentCacheOwnerUid(instanceDir);
	let parentVerified = false;
	if (parentDescriptor !== undefined) {
		assertResidentCacheDisposalParent(instanceDir, parentDescriptor);
		parentVerified = true;
	}
	// ENOENT is authoritative only while the retained parent still names the
	// directory or after this process has already retired its ownership record.
	try {
		fs.lstatSync(instanceDir);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw residentCacheTrustError("directory_unverifiable", instanceDir, error);
		if (parentDescriptor !== undefined) assertResidentCacheDisposalParent(instanceDir, parentDescriptor);
		if (!parentVerified && ownedResidentCacheInstanceDirs.has(instanceKey))
			throw residentCacheTrustError("directory_absence_unverified", instanceDir, error);
		ownedResidentCacheInstanceDirs.delete(instanceKey);
		return;
	}
	const quarantineDir = path.join(
		path.dirname(instanceDir),
		`${path.basename(instanceDir)}.dispose.${crypto.randomUUID()}`,
	);
	try {
		fs.lstatSync(quarantineDir);
		throw new ResidentCacheTrustError("quarantine_exists", quarantineDir);
	} catch (error) {
		if (error instanceof ResidentCacheTrustError) throw error;
		if (errorCode(error) !== "ENOENT") throw residentCacheTrustError("quarantine_unverifiable", quarantineDir, error);
	}

	let descriptor: number | null = null;
	let removed = false;
	try {
		descriptor = openVerifiedResidentCacheDirectory(instanceDir, uid);
		assertResidentCacheDirectoryPathMatchesDescriptor(instanceDir, descriptor, uid);
		const expected = fs.fstatSync(descriptor);
		if (parentDescriptor !== undefined) assertResidentCacheDisposalParent(instanceDir, parentDescriptor);
		fs.renameSync(instanceDir, quarantineDir);
		if (parentDescriptor !== undefined) assertResidentCacheDisposalParent(instanceDir, parentDescriptor);
		const moved = fs.lstatSync(quarantineDir);
		if (
			!moved.isDirectory() ||
			moved.isSymbolicLink() ||
			moved.uid !== uid ||
			!hasOwnerOnlyMode(moved.mode) ||
			!hasSameFilesystemIdentity(expected, moved)
		) {
			throw new ResidentCacheTrustError("quarantine_identity_changed", quarantineDir);
		}
		removeResidentCacheTreeNoFollow(quarantineDir);
		removed = true;
	} catch (error) {
		throw residentCacheTrustError("instance_dispose_failed", instanceDir, error);
	} finally {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The instance was either quarantined or left intact by the primary failure.
			}
		}
		if (removed) ownedResidentCacheInstanceDirs.delete(instanceKey);
	}
}

function removePartialResidentCacheInstanceDir(instanceDir: string): void {
	try {
		disposeVerifiedResidentCacheInstanceDir(instanceDir);
	} catch {
		removeEmptyResidentCacheInstanceDir(instanceDir);
	}
}

function isResidentCacheInstanceDirName(name: string): boolean {
	return /^(?:i-[A-Za-z0-9_-]+|s-[a-f0-9]{32})$/.test(name);
}

function residentCacheSweepLimit(value: number | undefined, ceiling: number): number {
	if (value === undefined || !Number.isFinite(value)) return ceiling;
	return Math.max(0, Math.min(Math.floor(value), ceiling));
}

function cachedResidentCacheProcessStartTimeMs(pid: number, cache: Map<number, number | null>): number | null {
	if (cache.has(pid)) return cache.get(pid) ?? null;
	const startTimeMs = residentCacheProcessStartTimeMs(pid);
	cache.set(pid, startTimeMs);
	return startTimeMs;
}

function residentCacheOwnerIsStale(
	owner: ResidentCacheOwnerToken,
	startTimeCache: Map<number, number | null>,
): boolean {
	const liveness = residentCacheOwnerLiveness(owner.pid);
	if (liveness === "dead") return true;
	if (liveness !== "alive" || owner.startTimeMs === null) return false;
	// A token from before the UTC pin carries a zone-dependent wall clock. Comparing
	// it against an absolute instant would read an ordinary timezone offset as PID
	// reuse and reap a live owner, so an unlabelled basis leaves reuse unproven.
	if (owner.startTimeBasis !== RESIDENT_CACHE_START_TIME_BASIS) return false;
	const currentStartTimeMs = cachedResidentCacheProcessStartTimeMs(owner.pid, startTimeCache);
	return currentStartTimeMs !== null && currentStartTimeMs !== owner.startTimeMs;
}

function reapResidentCacheInstanceDir(
	root: string,
	rootDescriptor: number,
	instanceDir: string,
	expected: ResidentCacheOwnerSnapshot,
	uid: number,
): boolean {
	const quarantineDir = path.join(root, `${path.basename(instanceDir)}.reap.${crypto.randomUUID()}`);
	try {
		fs.lstatSync(quarantineDir);
		return false;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return false;
	}

	// Re-read immediately before rename so a replacement owner cannot be reaped
	// based on the stale observation above (the same compare-before-delete shape
	// used by file-lock GC).
	const current = readResidentCacheOwnerSnapshot(instanceDir, uid);
	if (
		current === null ||
		!sameResidentCacheOwnerToken(current.owner, expected.owner) ||
		!hasSameFilesystemIdentity(current.directory, expected.directory)
	) {
		return false;
	}

	try {
		const beforeRename = fs.lstatSync(instanceDir);
		if (
			!beforeRename.isDirectory() ||
			beforeRename.isSymbolicLink() ||
			beforeRename.uid !== uid ||
			!hasOwnerOnlyMode(beforeRename.mode) ||
			!hasSameFilesystemIdentity(beforeRename, current.directory)
		) {
			return false;
		}
		assertResidentCacheDirectoryPathMatchesDescriptor(root, rootDescriptor, uid);
		fs.renameSync(instanceDir, quarantineDir);
		const moved = fs.lstatSync(quarantineDir);
		if (
			!moved.isDirectory() ||
			moved.isSymbolicLink() ||
			moved.uid !== uid ||
			!hasOwnerOnlyMode(moved.mode) ||
			!hasSameFilesystemIdentity(moved, current.directory)
		) {
			throw new ResidentCacheTrustError("reap_quarantine_identity_changed", quarantineDir);
		}
		removeResidentCacheTreeNoFollow(quarantineDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Best-effort cleanup of abandoned resident-cache instances. The root is
 * re-verified before scanning, work is bounded, and all failures fail closed.
 */
export async function sweepResidentCacheRoot(root: string, options: ResidentCacheGcSweepOptions = {}): Promise<void> {
	const rootKey = path.resolve(root);
	if (activeResidentCacheRootSweeps.has(rootKey)) return;
	activeResidentCacheRootSweeps.add(rootKey);
	try {
		// Yield before filesystem work so callers can fire-and-forget this sweep.
		await Promise.resolve();
		const startedAt = Date.now();
		const maxDirectories = residentCacheSweepLimit(options.maxDirectories, RESIDENT_CACHE_GC_MAX_DIRECTORIES);
		const maxDurationMs = residentCacheSweepLimit(options.maxDurationMs, RESIDENT_CACHE_GC_MAX_DURATION_MS);
		if (maxDirectories === 0 || maxDurationMs === 0) return;

		const uid = residentCacheOwnerUid(root);
		let rootDescriptor: number | null = null;
		try {
			// Do not create the root here: a failed verification must leave no new
			// cache state behind.
			rootDescriptor = openVerifiedResidentCacheDirectory(root, uid);
			assertResidentCacheDirectoryPathMatchesDescriptor(root, rootDescriptor, uid);
			const startTimeCache = new Map<number, number | null>();
			const entries = fs.opendirSync(root);
			try {
				let examined = 0;
				for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
					if (examined >= maxDirectories || Date.now() - startedAt >= maxDurationMs) return;
					if (!isResidentCacheInstanceDirName(entry.name)) continue;
					const instanceDir = path.join(root, entry.name);
					if (ownedResidentCacheInstanceDirs.has(path.resolve(instanceDir))) continue;
					assertResidentCacheDirectoryPathMatchesDescriptor(root, rootDescriptor, uid);
					examined++;
					const expected = readResidentCacheOwnerSnapshot(instanceDir, uid);
					if (expected === null || !residentCacheOwnerIsStale(expected.owner, startTimeCache)) continue;
					reapResidentCacheInstanceDir(root, rootDescriptor, instanceDir, expected, uid);
				}
			} finally {
				entries.closeSync();
			}
		} finally {
			if (rootDescriptor !== null) fs.closeSync(rootDescriptor);
		}
	} catch (error) {
		if (!isExpectedResidentCacheSweepFailure(error)) throw error;
		logger.debug("Resident cache GC sweep skipped", { root, error: String(error) });
	} finally {
		activeResidentCacheRootSweeps.delete(rootKey);
	}
}

function scheduleResidentCacheRootSweep(root: string): void {
	void sweepResidentCacheRoot(root).catch(error => {
		logger.debug("Resident cache GC sweep failed", { root, error: String(error) });
	});
}

/**
 * Create a private resident-cache instance directory beneath a trusted profile
 * root. The cache-owned root and nonce instance are both verified owner-only
 * directories; callers must use {@link EphemeralBlobStore.adoptVerifiedDir}
 * rather than the destructive EphemeralBlobStore constructor.
 */
function openVerifiedCacheInstanceDir(root: string, instanceName?: string): string {
	const uid = residentCacheOwnerUid(root);
	let rootDescriptor: number | null = null;
	let instanceDir: string | null = null;
	try {
		try {
			fs.mkdirSync(root, { recursive: true, mode: BLOB_DIR_MODE });
		} catch (error) {
			throw residentCacheTrustError("root_create_failed", root, error);
		}
		rootDescriptor = openVerifiedResidentCacheDirectory(root, uid);
		try {
			if (instanceName === undefined) instanceDir = fs.mkdtempSync(path.join(root, "i-"));
			else {
				if (!/^s-[a-f0-9]{32}$/.test(instanceName))
					throw new ResidentCacheTrustError("instance_name_invalid", instanceName);
				const candidate = path.join(root, instanceName);
				try {
					fs.mkdirSync(candidate, { mode: BLOB_DIR_MODE });
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
					const staleInstance = readResidentCacheOwnerSnapshot(candidate, uid);
					if (
						staleInstance === null ||
						!residentCacheOwnerIsStale(staleInstance.owner, new Map<number, number | null>()) ||
						!reapResidentCacheInstanceDir(root, rootDescriptor, candidate, staleInstance, uid)
					) {
						throw error;
					}
					fs.mkdirSync(candidate, { mode: BLOB_DIR_MODE });
				}
				instanceDir = candidate;
			}
		} catch (error) {
			throw residentCacheTrustError("instance_create_failed", root, error);
		}
		// Keep the root descriptor open while creating the nonce directory, then
		// re-check the path against that descriptor before trusting the child.
		assertResidentCacheDirectoryPathMatchesDescriptor(root, rootDescriptor, uid);
		let instanceDescriptor: number | null = null;
		try {
			instanceDescriptor = openVerifiedResidentCacheDirectory(instanceDir, uid);
		} finally {
			if (instanceDescriptor !== null) fs.closeSync(instanceDescriptor);
		}
		writeResidentCacheOwnerToken(instanceDir, uid);
		assertResidentCacheDirectoryPathMatchesDescriptor(root, rootDescriptor, uid);
		ownedResidentCacheInstanceDirs.add(path.resolve(instanceDir));
		scheduleResidentCacheRootSweep(root);
		return instanceDir;
	} catch (error) {
		if (instanceDir !== null) removePartialResidentCacheInstanceDir(instanceDir);
		throw residentCacheTrustError("instance_directory_untrusted", root, error);
	} finally {
		if (rootDescriptor !== null) {
			try {
				fs.closeSync(rootDescriptor);
			} catch {
				// Descriptor cleanup must not turn a verified candidate into a failure.
			}
		}
	}
}

export function openVerifiedResidentCacheInstanceDir(root: string): string {
	return openVerifiedCacheInstanceDir(root);
}

/** Open the deterministic per-session managed-sidecar instance in its separate cache root. */
export function openVerifiedSidecarCacheInstanceDir(root: string, sessionHash: string): string {
	return openVerifiedCacheInstanceDir(root, `s-${sessionHash}`);
}

function sha256Hex(data: Buffer): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function makeBlobPutResult(hash: string, blobPath: string): BlobPutResult;
function makeBlobPutResult(hash: string, blobPath: string, bytes: number): CheckedBlobPutResult;
function makeBlobPutResult(hash: string, blobPath: string, bytes?: number): BlobPutResult | CheckedBlobPutResult {
	const result = {
		hash,
		path: blobPath,
		get ref() {
			return `${BLOB_PREFIX}${hash}`;
		},
	};
	if (bytes === undefined) return result;
	return { ...result, bytes };
}

function fsyncDirBestEffortSync(dir: string): void {
	let fd: number | null = null;
	try {
		fd = fs.openSync(dir, "r");
		fs.fsyncSync(fd);
	} catch {
		// Best-effort only: some platforms/filesystems do not support fsync on directories.
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

/**
 * Best-effort fsync of an installed blob file. Used on install paths that
 * create the destination by copy (not hard-link from an already-fsynced temp),
 * so the durable-install contract holds there too. Failures are best-effort:
 * some platforms/filesystems reject fsync on read-only handles.
 */
function fsyncFileBestEffortSync(filePath: string): void {
	let fd: number | null = null;
	try {
		fd = fs.openSync(filePath, "r");
		fs.fsyncSync(fd);
	} catch {
		// Best-effort only.
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

function uniqueTempBlobPath(dir: string, hash: string): string {
	return path.join(dir, `${hash}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
}

function verifyBlobBytesSync(hash: string, blobPath: string, data: Buffer): void {
	if (sha256Hex(data) !== hash) throw new BlobCorruptError(hash, blobPath);
}

function verifyBlobFileSync(hash: string, blobPath: string): Buffer {
	const data = fs.readFileSync(blobPath);
	verifyBlobBytesSync(hash, blobPath, data);
	return data;
}

function isTrustedResidentCacheBlobDescriptor(stat: fs.Stats, uid: number): boolean {
	return stat.isFile() && stat.uid === uid && hasOwnerOnlyMode(stat.mode);
}

function isTrustedResidentCacheBlobFile(stat: fs.Stats, uid: number, byteLength: number): boolean {
	return isTrustedResidentCacheBlobDescriptor(stat, uid) && stat.size === byteLength;
}

function readVerifiedResidentCacheBlobSync(hash: string, blobPath: string): Buffer | null {
	const uid = residentCacheOwnerUid(blobPath);
	const noFollow = fs.constants.O_NOFOLLOW;
	if (!noFollow) throw new ResidentCacheTrustError("no_follow_unavailable", blobPath);

	let descriptor: number;
	try {
		descriptor = fs.openSync(blobPath, fs.constants.O_RDONLY | noFollow);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw residentCacheTrustError("blob_open_failed", blobPath, error);
	}

	let data: Buffer | null = null;
	let failure: ResidentCacheTrustError | null = null;
	try {
		const stat = fs.fstatSync(descriptor);
		if (!isTrustedResidentCacheBlobDescriptor(stat, uid)) {
			throw new ResidentCacheTrustError("blob_descriptor_untrusted", blobPath);
		}
		data = fs.readFileSync(descriptor);
		verifyBlobBytesSync(hash, blobPath, data);
	} catch (error) {
		failure = residentCacheTrustError("blob_read_untrusted", blobPath, error);
	} finally {
		try {
			fs.closeSync(descriptor);
		} catch (error) {
			failure ??= residentCacheTrustError("blob_close_failed", blobPath, error);
		}
	}
	if (failure !== null) throw failure;
	return data;
}

function assertResidentCacheBlobFile(pathname: string, uid: number, byteLength: number): fs.Stats {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(pathname);
	} catch (error) {
		throw residentCacheTrustError("blob_unverifiable", pathname, error);
	}
	if (!isTrustedResidentCacheBlobFile(stat, uid, byteLength)) {
		throw new ResidentCacheTrustError("blob_untrusted", pathname);
	}
	return stat;
}

function verifyExistingResidentCacheBlob(
	hash: string,
	blobPath: string,
	uid: number,
	byteLength: number,
): BlobPutResult {
	const before = assertResidentCacheBlobFile(blobPath, uid, byteLength);
	try {
		verifyBlobFileSync(hash, blobPath);
	} catch (error) {
		throw residentCacheTrustError("blob_content_unverifiable", blobPath, error);
	}
	const after = assertResidentCacheBlobFile(blobPath, uid, byteLength);
	if (!hasSameFilesystemIdentity(before, after)) {
		throw new ResidentCacheTrustError("blob_identity_changed", blobPath);
	}
	return makeBlobPutResult(hash, blobPath);
}

function removeNewResidentCacheBlob(blobPath: string, expected: fs.Stats): void {
	try {
		const current = fs.lstatSync(blobPath);
		if (current.isFile() && !current.isSymbolicLink() && hasSameFilesystemIdentity(current, expected)) {
			fs.unlinkSync(blobPath);
		}
	} catch {
		// A failed put must never delete a path whose identity no longer matches
		// the exclusively-created file descriptor we opened.
	}
}

function putResidentCacheBlobSync(dir: string, data: Buffer): BlobPutResult {
	const hash = sha256Hex(data);
	const blobPath = path.join(dir, hash);
	const uid = residentCacheOwnerUid(blobPath);
	const noFollow = fs.constants.O_NOFOLLOW;
	if (!noFollow) throw new ResidentCacheTrustError("no_follow_unavailable", blobPath);

	let descriptor: number;
	try {
		descriptor = fs.openSync(
			blobPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
			BLOB_FILE_MODE,
		);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return verifyExistingResidentCacheBlob(hash, blobPath, uid, data.byteLength);
		throw residentCacheTrustError("blob_create_failed", blobPath, error);
	}

	let created: fs.Stats | null = null;
	let failure: ResidentCacheTrustError | null = null;
	try {
		created = fs.fstatSync(descriptor);
		if (!created.isFile() || created.uid !== uid)
			throw new ResidentCacheTrustError("blob_descriptor_untrusted", blobPath);
		fs.fchmodSync(descriptor, BLOB_FILE_MODE);
		fs.writeFileSync(descriptor, data);
		const written = fs.fstatSync(descriptor);
		if (!isTrustedResidentCacheBlobFile(written, uid, data.byteLength)) {
			throw new ResidentCacheTrustError("blob_write_untrusted", blobPath);
		}
	} catch (error) {
		failure = residentCacheTrustError("blob_write_failed", blobPath, error);
	} finally {
		try {
			fs.closeSync(descriptor);
		} catch (error) {
			failure ??= residentCacheTrustError("blob_close_failed", blobPath, error);
		}
	}

	if (failure !== null) {
		if (created !== null) removeNewResidentCacheBlob(blobPath, created);
		throw failure;
	}
	return makeBlobPutResult(hash, blobPath);
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored at `<dir>/<sha256-hex>` with no extension. The SHA-256 hash is computed
 * over the raw binary data (not base64). Content-addressing makes writes idempotent and
 * provides automatic deduplication across sessions.
 */
export class BlobStore {
	constructor(readonly dir: string) {}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer): Promise<BlobPutResult> {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const result = {
			hash,
			path: blobPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};

		// Create the blob directory 0700 and the file 0600 at creation, mirroring
		// putSync/putImmutableSync. The previous Bun.write let the parent dir be
		// created with the process umask (e.g. 0755) and the file at 0644 before a
		// follow-up chmod, violating the owner-only contract above and leaving a
		// group/other-readable window a managed-tree snapshot fails closed on.
		await fsp.mkdir(this.dir, { recursive: true, mode: BLOB_DIR_MODE });
		await fsp.writeFile(blobPath, data, { mode: BLOB_FILE_MODE });
		return result;
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, _ownership?: typeof TAKE_BLOB_BUFFER_OWNERSHIP): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = path.join(this.dir, hash);
		const result = {
			hash,
			path: blobPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
		};
		fs.mkdirSync(this.dir, { recursive: true, mode: BLOB_DIR_MODE });
		fs.writeFileSync(blobPath, data, { mode: BLOB_FILE_MODE });
		return result;
	}

	/**
	 * Store a buffer that the caller will not mutate after this call returns.
	 * Resident-cache implementations may retain that private buffer without an
	 * additional defensive copy.
	 */
	putOwnedSync(data: Buffer): BlobPutResult {
		return this.putSync(data, TAKE_BLOB_BUFFER_OWNERSHIP);
	}

	/**
	 * Durably install binary data as an immutable content-addressed blob.
	 *
	 * Callers that persist references to this blob must mutate canonical session entries only
	 * after this method returns successfully. A corrupt pre-existing target is reported with
	 * {@link BlobCorruptError}; it is never silently overwritten or trusted.
	 */
	putImmutableSync(data: Buffer): CheckedBlobPutResult {
		const hash = sha256Hex(data);
		const blobPath = path.join(this.dir, hash);
		const result = makeBlobPutResult(hash, blobPath, data.byteLength);
		fs.mkdirSync(this.dir, { recursive: true, mode: BLOB_DIR_MODE });

		if (fs.existsSync(blobPath)) {
			verifyBlobFileSync(hash, blobPath);
			return result;
		}

		const tempPath = uniqueTempBlobPath(this.dir, hash);
		try {
			const fd = fs.openSync(tempPath, "wx", BLOB_FILE_MODE);
			try {
				fs.writeFileSync(fd, data);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}

			try {
				fs.linkSync(tempPath, blobPath);
			} catch (err) {
				if (isEnoent(err)) throw err;
				const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
				if (code === "EEXIST") {
					verifyBlobFileSync(hash, blobPath);
					return result;
				}
				if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
					// Hard links unsupported (e.g. cross-device / some network FS). Use an
					// EXCLUSIVE copy so a concurrently installed winner is never overwritten;
					// verify it by hash on EEXIST instead of clobbering it.
					try {
						fs.copyFileSync(tempPath, blobPath, fs.constants.COPYFILE_EXCL);
						// The temp was fsync'd before install, but copyFileSync creates a
						// fresh destination whose bytes are not yet durable — fsync it so the
						// durable-install contract holds on hard-link-unsupported paths too.
						fsyncFileBestEffortSync(blobPath);
					} catch (copyErr) {
						const copyCode =
							typeof copyErr === "object" && copyErr !== null && "code" in copyErr ? copyErr.code : undefined;
						if (copyCode === "EEXIST") {
							verifyBlobFileSync(hash, blobPath);
							return result;
						}
						throw copyErr;
					}
				} else {
					throw err;
				}
			}

			verifyBlobFileSync(hash, blobPath);
			fsyncDirBestEffortSync(this.dir);
			return result;
		} finally {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// Best-effort temp cleanup: never mask the primary result or throw.
			}
		}
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		if (!isCanonicalBlobHash(hash)) return null;
		const blobPath = path.join(this.dir, hash);
		try {
			const file = Bun.file(blobPath);
			const ab = await file.arrayBuffer();
			return Buffer.from(ab);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Synchronously read blob by hash, returns Buffer or null if not found. */
	getSync(hash: string): Buffer | null {
		if (!isCanonicalBlobHash(hash)) return null;
		const blobPath = path.join(this.dir, hash);
		try {
			return fs.readFileSync(blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Read blob by hash and verify its content hash; returns null if not found. */
	async getChecked(hash: string): Promise<Buffer | null> {
		return this.getCheckedSync(hash);
	}

	/** Synchronously read blob by hash and verify its content hash; returns null if not found. */
	getCheckedSync(hash: string): Buffer | null {
		if (!isCanonicalBlobHash(hash)) return null;
		const blobPath = path.join(this.dir, hash);
		try {
			return verifyBlobFileSync(hash, blobPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		if (!isCanonicalBlobHash(hash)) return false;
		try {
			await fsp.access(path.join(this.dir, hash));
			return true;
		} catch {
			return false;
		}
	}
}

interface EphemeralBlobStoreOptions {
	readonly adoptVerifiedDir?: boolean;
	readonly disposalParentDescriptor?: number;
}

/**
 * Resident-cache directories this process created and has not disposed.
 *
 * The directory name embeds the pid (`<session>-<pid>-<n>`), so a run that never
 * reaches `dispose()` cannot be cleaned by a later run: the next process picks a
 * different name, and the constructor's wipe only ever clears its own path. The
 * leftovers are therefore permanent. A developer machine held seven of them from
 * dead pids, up to 26 days old, totalling 13.4 MB of externalized session text.
 */
const liveResidentCacheDirs = new Set<string>();

/** Resident-cache directories still tracked by this process. Test seam. */
export function trackedResidentCacheDirsForTest(): string[] {
	return [...liveResidentCacheDirs];
}

/**
 * Sweep the directories this process created when it exits abnormally, matching
 * `shell-snapshot` and `python-runner-artifact`. Best-effort by contract: a
 * postmortem handler must not throw.
 */
postmortem.register("session-resident-cache", () => {
	for (const dir of [...liveResidentCacheDirs]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Exit path: a failed removal must not mask the original fault.
		}
		liveResidentCacheDirs.delete(dir);
	}
});

export class EphemeralBlobStore extends BlobStore {
	/**
	 * Bounded LRU byte budget for the in-memory buffer cache. Keeps recent
	 * resident blobs hot for rematerialization after the weak materialized
	 * view is collected, without re-pinning the whole session in RAM.
	 */
	static readonly #BUFFER_CACHE_MAX_BYTES = 8 * 1024 * 1024;

	#bufferCache = new Map<string, Buffer>();
	#bufferCacheBytes = 0;
	#adoptedVerifiedDir = false;
	#disposed = false;
	#disposalParentDescriptor: number | null = null;

	constructor(dir: string, options: EphemeralBlobStoreOptions = {}) {
		super(dir);
		this.#adoptedVerifiedDir = options.adoptVerifiedDir === true;
		this.#disposalParentDescriptor = options.disposalParentDescriptor ?? null;
		if (this.#adoptedVerifiedDir) return;
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true, mode: BLOB_DIR_MODE });
		liveResidentCacheDirs.add(dir);
	}

	/**
	 * Adopt a directory returned by {@link openVerifiedResidentCacheInstanceDir}
	 * without the ordinary constructor's destructive remove-and-recreate path.
	 */
	static adoptVerifiedDir(dir: string): EphemeralBlobStore {
		const uid = residentCacheOwnerUid(dir);
		let descriptor: number | null = null;
		let parentDescriptor: number | null = null;
		let failure: unknown;
		try {
			descriptor = openVerifiedResidentCacheDirectory(dir, uid);
			assertResidentCacheDirectoryPathMatchesDescriptor(dir, descriptor, uid);
			const parentDir = path.dirname(dir);
			const parentUid = residentCacheOwnerUid(parentDir);
			parentDescriptor = openVerifiedResidentCacheDirectory(parentDir, parentUid);
			assertResidentCacheDirectoryPathMatchesDescriptor(parentDir, parentDescriptor, parentUid);
		} catch (error) {
			failure = error;
		}
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch (error) {
				failure ??= residentCacheTrustError("instance_close_failed", dir, error);
			}
		}
		if (failure !== undefined) {
			if (parentDescriptor !== null) {
				try {
					fs.closeSync(parentDescriptor);
				} catch {
					// Preserve the adoption failure.
				}
			}
			removeEmptyResidentCacheInstanceDir(dir);
			throw residentCacheTrustError("instance_adoption_failed", dir, failure);
		}
		if (parentDescriptor === null) throw new ResidentCacheTrustError("parent_authority_unavailable", dir);
		return new EphemeralBlobStore(dir, { adoptVerifiedDir: true, disposalParentDescriptor: parentDescriptor });
	}

	#cachePut(hash: string, data: Buffer, ownership?: typeof TAKE_BLOB_BUFFER_OWNERSHIP): void {
		const existing = this.#bufferCache.get(hash);
		if (existing) {
			this.#bufferCache.delete(hash);
			this.#bufferCacheBytes -= existing.byteLength;
		}
		if (data.byteLength > EphemeralBlobStore.#BUFFER_CACHE_MAX_BYTES) return;
		this.#bufferCache.set(hash, ownership === TAKE_BLOB_BUFFER_OWNERSHIP ? data : Buffer.from(data));
		this.#bufferCacheBytes += data.byteLength;
		for (const [oldHash, oldData] of this.#bufferCache) {
			if (this.#bufferCacheBytes <= EphemeralBlobStore.#BUFFER_CACHE_MAX_BYTES) break;
			this.#bufferCache.delete(oldHash);
			this.#bufferCacheBytes -= oldData.byteLength;
		}
	}

	async put(data: Buffer): Promise<BlobPutResult> {
		if (!this.#adoptedVerifiedDir) return super.put(data);
		return this.putSync(data);
	}

	putSync(data: Buffer, ownership?: typeof TAKE_BLOB_BUFFER_OWNERSHIP): BlobPutResult {
		const result = this.#adoptedVerifiedDir ? putResidentCacheBlobSync(this.dir, data) : super.putSync(data);
		this.#cachePut(result.hash, data, ownership);
		return result;
	}

	putImmutableSync(data: Buffer): CheckedBlobPutResult {
		if (this.#adoptedVerifiedDir) {
			const result = putResidentCacheBlobSync(this.dir, data);
			this.#cachePut(result.hash, data);
			return makeBlobPutResult(result.hash, result.path, data.byteLength);
		}
		const result = super.putImmutableSync(data);
		this.#cachePut(result.hash, data);
		return result;
	}

	async get(hash: string): Promise<Buffer | null> {
		if (this.#adoptedVerifiedDir) return this.getSync(hash);
		return super.get(hash);
	}

	getSync(hash: string): Buffer | null {
		if (!isCanonicalBlobHash(hash)) return null;
		const cached = this.#bufferCache.get(hash);
		if (cached) {
			const blobPath = path.join(this.dir, hash);
			if (fs.existsSync(blobPath)) {
				// Refresh LRU recency on hit.
				this.#bufferCache.delete(hash);
				this.#bufferCache.set(hash, cached);
				return Buffer.from(cached);
			}
			this.#bufferCache.delete(hash);
			this.#bufferCacheBytes -= cached.byteLength;
		}

		const data = this.#adoptedVerifiedDir
			? readVerifiedResidentCacheBlobSync(hash, path.join(this.dir, hash))
			: super.getSync(hash);
		if (data) this.#cachePut(hash, data);
		return data;
	}

	/** Return a trusted in-memory copy without reopening an invalidated cache path. */
	getBufferedSync(hash: string): Buffer | null {
		const cached = this.#bufferCache.get(hash);
		if (!cached) return null;
		this.#bufferCache.delete(hash);
		this.#bufferCache.set(hash, cached);
		return Buffer.from(cached);
	}

	getCheckedSync(hash: string): Buffer | null {
		if (this.#adoptedVerifiedDir) return this.getSync(hash);
		const data = super.getCheckedSync(hash);
		if (data) this.#cachePut(hash, data);
		return data;
	}

	clear(): void {
		this.#bufferCache.clear();
		this.#bufferCacheBytes = 0;
		if (!this.#adoptedVerifiedDir) {
			fs.rmSync(this.dir, { recursive: true, force: true });
			fs.mkdirSync(this.dir, { recursive: true, mode: BLOB_DIR_MODE });
			return;
		}

		const uid = residentCacheOwnerUid(this.dir);
		const descriptor = openVerifiedResidentCacheDirectory(this.dir, uid);
		try {
			for (const entry of fs.readdirSync(this.dir)) {
				if (entry === RESIDENT_CACHE_OWNER_RECORD) continue;
				const blobPath = path.join(this.dir, entry);
				const stat = fs.lstatSync(blobPath);
				if (
					!isCanonicalBlobHash(entry) ||
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					stat.uid !== uid ||
					!hasOwnerOnlyMode(stat.mode)
				) {
					throw new ResidentCacheTrustError("clear_untrusted_entry", blobPath);
				}
				fs.unlinkSync(blobPath);
			}
		} catch (error) {
			throw residentCacheTrustError("clear_failed", this.dir, error);
		} finally {
			try {
				fs.closeSync(descriptor);
			} catch {
				// The clear result is already determined; do not mask it with cleanup.
			}
		}
	}

	dispose(): void {
		if (this.#adoptedVerifiedDir && this.#disposed) return;
		this.#bufferCache.clear();
		this.#bufferCacheBytes = 0;
		if (this.#adoptedVerifiedDir) {
			disposeVerifiedResidentCacheInstanceDir(this.dir, this.#disposalParentDescriptor ?? undefined);
			if (this.#disposalParentDescriptor !== null) {
				try {
					fs.closeSync(this.#disposalParentDescriptor);
				} catch {
					// Disposal is already complete; descriptor cleanup cannot restore the tree.
				}
				this.#disposalParentDescriptor = null;
			}
			this.#disposed = true;
			return;
		}
		// Untrack before removing so the sweep cannot race a clean disposal.
		liveResidentCacheDirs.delete(this.dir);
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

export interface MemoryBlobStoreOptions {
	/** A canonical store owns every reference in its session's resident entries. */
	readonly ownership?: "cache" | "canonical";
}

export class MemoryBlobStore extends BlobStore {
	/**
	 * Cache-owned stores use a bounded LRU. Canonical ownership deliberately
	 * retains every blob: a degraded resident session has no trusted disk store
	 * behind its references, so eviction would silently replace valid content
	 * with unavailable placeholders. This matches the pre-resident-cache
	 * in-RAM raw-string lifetime while leaving non-canonical caches bounded.
	 */
	static readonly #MAX_BYTES = 64 * 1024 * 1024;
	static readonly #MAX_COUNT = 4096;

	#blobs = new Map<string, Buffer>();
	#bytes = 0;
	#canonical: boolean;

	constructor(options: MemoryBlobStoreOptions = {}) {
		super(":memory:");
		this.#canonical = options.ownership === "canonical";
	}

	#store(hash: string, data: Buffer): void {
		const existing = this.#blobs.get(hash);
		if (existing) {
			this.#blobs.delete(hash);
			this.#bytes -= existing.byteLength;
		}
		this.#blobs.set(hash, data);
		this.#bytes += data.byteLength;
		if (this.#canonical) return;
		while (
			(this.#bytes > MemoryBlobStore.#MAX_BYTES || this.#blobs.size > MemoryBlobStore.#MAX_COUNT) &&
			this.#blobs.size > 1
		) {
			const oldest = this.#blobs.keys().next().value;
			if (oldest === undefined) break;
			const evicted = this.#blobs.get(oldest);
			this.#blobs.delete(oldest);
			if (evicted) this.#bytes -= evicted.byteLength;
		}
	}

	async put(data: Buffer): Promise<BlobPutResult> {
		return this.putSync(data);
	}

	putSync(data: Buffer, ownership?: typeof TAKE_BLOB_BUFFER_OWNERSHIP): BlobPutResult {
		const hash = sha256Hex(data);
		this.#store(hash, ownership === TAKE_BLOB_BUFFER_OWNERSHIP ? data : Buffer.from(data));
		return makeBlobPutResult(hash, `memory:${hash}`);
	}

	putImmutableSync(data: Buffer): CheckedBlobPutResult {
		const hash = sha256Hex(data);
		this.#store(hash, Buffer.from(data));
		return makeBlobPutResult(hash, `memory:${hash}`, data.byteLength);
	}

	async get(hash: string): Promise<Buffer | null> {
		return this.getSync(hash);
	}

	getSync(hash: string): Buffer | null {
		const data = this.#blobs.get(hash);
		if (!data) return null;
		if (!this.#canonical) {
			// Refresh LRU recency on hit so hot blobs survive eviction.
			this.#blobs.delete(hash);
			this.#blobs.set(hash, data);
		}
		return Buffer.from(data);
	}

	async getChecked(hash: string): Promise<Buffer | null> {
		return this.getCheckedSync(hash);
	}

	getCheckedSync(hash: string): Buffer | null {
		const data = this.getSync(hash);
		if (!data) return null;
		verifyBlobBytesSync(hash, `memory:${hash}`, data);
		return data;
	}

	async has(hash: string): Promise<boolean> {
		return this.#blobs.has(hash);
	}
}

export class ResidentBlobMissingError extends Error {
	constructor(
		readonly hash: string,
		readonly kind: "text" | "imageUrl" | "imageData",
		readonly sessionId?: string,
		readonly sessionFile?: string,
	) {
		// Every construction site already passes the session binding, so leaving it
		// out of the message meant a fail-closed abort surfaced a bare 64-hex hash:
		// nothing named the transcript to inspect, the session, or even the resident
		// cache as the subsystem. Both values are already logged elsewhere for this
		// store, so rendering them here exposes no new class of information.
		super(
			`Missing resident ${kind} blob: ${hash}` +
				(sessionId ? ` (session ${sessionId})` : "") +
				(sessionFile ? ` [${sessionFile}]` : ""),
		);
		this.name = "ResidentBlobMissingError";
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return parseBlobRef(data) !== null;
}

/** Extract the SHA-256 hash from a blob reference string. */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	return isCanonicalBlobHash(hash) ? hash : null;
}

/** Identify provider transport image data URLs so persistence can externalize and restore them losslessly. */
export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

/**
 * Externalize a provider image data URL to the blob store, returning a blob reference.
 * The full data URL string is preserved so transport-native history can be reconstructed on resume.
 */
export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

/** Synchronous variant of {@link externalizeImageDataUrl}. */
export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putOwnedSync(Buffer.from(dataUrl, "utf8")).ref;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export async function externalizeImageData(blobStore: BlobStore, base64Data: string): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer);
	return ref;
}

/** Synchronous variant of {@link externalizeImageData}. */
export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putOwnedSync(Buffer.from(base64Data, "base64")).ref;
}

/**
 * Resolve an externalized provider image data URL back to its original string.
 * If the data is not a blob reference, returns it unchanged.
 *
 * LEGACY PERSISTED-IMAGE COMPATIBILITY BOUNDARY: when the persisted blob is missing
 * (e.g. resuming an old session whose image blob was pruned), this warns and returns
 * the reference as-is rather than throwing, so legacy resume degrades gracefully.
 * New resident byte-sensitive TEXT uses the fail-closed path instead
 * (`resolveTextBlobSync` -> `ResidentBlobMissingError`). Do NOT route new byte-sensitive
 * resident data through this warn-and-return path.
 */
export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 *
 * LEGACY PERSISTED-IMAGE COMPATIBILITY BOUNDARY: when the blob is missing this warns
 * and returns the reference as-is (downstream sees an invalid base64 ref but does not
 * crash), preserving legacy-session resume. Byte-sensitive resident TEXT is fail-closed
 * via `resolveTextBlobSync`; do NOT route new byte-sensitive resident data here.
 */
export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

/** Synchronously resolve an externalized provider image data URL back to its original string. */
export function resolveImageDataUrlSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/** Synchronously resolve a blob reference back to base64 data. */
export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}

/**
 * Synchronously resolve a blob reference back to utf8 text.
 *
 * FAIL-CLOSED byte-sensitive path: a missing resident blob throws
 * `ResidentBlobMissingError` rather than degrading, so a missing resident text blob can
 * never silently leak a `blob:sha256:` ref into provider payloads, UI, or exports.
 * (Contrast the legacy persisted-image warn-and-return resolvers above.)
 */
export function resolveTextBlobSync(
	blobStore: BlobStore,
	data: string,
	context?: { kind?: "text"; sessionId?: string; sessionFile?: string },
): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		throw new ResidentBlobMissingError(hash, context?.kind ?? "text", context?.sessionId, context?.sessionFile);
	}
	return buffer.toString("utf8");
}

/**
 * FAIL-CLOSED resident variant of {@link resolveImageDataUrlSync}: a missing resident
 * image-data-url blob throws `ResidentBlobMissingError` ("imageUrl") instead of warn-returning,
 * so resident byte-sensitive provider image data can never leak a `blob:sha256:` ref into
 * materialized entries, context, or provider payloads. The warn-and-return `resolveImageDataUrl*`
 * resolvers remain ONLY for legacy persisted-image resume.
 */
export function resolveResidentImageDataUrlSync(
	blobStore: BlobStore,
	data: string,
	context?: { sessionId?: string; sessionFile?: string },
): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		throw new ResidentBlobMissingError(hash, "imageUrl", context?.sessionId, context?.sessionFile);
	}
	return buffer.toString("utf8");
}

/**
 * FAIL-CLOSED resident variant of {@link resolveImageDataSync}: a missing resident image blob
 * throws `ResidentBlobMissingError` ("imageData") instead of warn-returning a placeholder.
 */
export function resolveResidentImageDataSync(
	blobStore: BlobStore,
	data: string,
	context?: { sessionId?: string; sessionFile?: string },
): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;
	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		throw new ResidentBlobMissingError(hash, "imageData", context?.sessionId, context?.sessionFile);
	}
	return buffer.toString("base64");
}

// =============================================================================
// Canonical-store mark-and-sweep primitives (`gjc gc --disk`)
// =============================================================================
//
// The resident-cache sweep above bounds *cache* directories. These primitives
// expose the canonical `~/.gjc/agent/blobs` store to an out-of-process retention
// pass so it can mark live hashes from surviving transcripts and sweep the rest.
// They own no policy: the caller decides what "unreferenced" means.

/** One canonical blob file (`<blobsDir>/<sha256-hex>`) observed on disk. */
export interface CanonicalBlobEntry {
	readonly hash: string;
	readonly path: string;
	readonly bytes: number;
	readonly mtimeMs: number;
	readonly mtimeNs: bigint;
	readonly dev: bigint;
	readonly ino: bigint;
	readonly nlink: bigint;
}

const BLOB_REFERENCE = /blob:sha256:([0-9a-f]{64})/g;

/** Longest possible `blob:sha256:<hash>` reference, used to bound chunked scans. */
export const BLOB_REFERENCE_MAX_LENGTH = BLOB_PREFIX.length + 64;

/** Collect every `blob:sha256:<hash>` reference that appears in `text`. */
export function collectBlobReferences(text: string, into: Set<string>): void {
	for (const match of text.matchAll(BLOB_REFERENCE)) into.add(match[1]!);
}

/**
 * List canonical blob files. Anything that is not a plain, owner-visible regular
 * file named after its own hash (temp files, symlinks, subdirectories) is
 * skipped: a sweep must never reason about entries it cannot classify.
 */
export async function listCanonicalBlobs(dir: string): Promise<CanonicalBlobEntry[]> {
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const entries: CanonicalBlobEntry[] = [];
	for (const name of names) {
		if (!isCanonicalBlobHash(name)) continue;
		const blobPath = path.join(dir, name);
		let stat: fs.BigIntStats;
		try {
			stat = await fsp.lstat(blobPath, { bigint: true });
		} catch {
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) continue;
		entries.push({
			hash: name,
			path: blobPath,
			bytes: Number(stat.size),
			mtimeMs: Number(stat.mtimeMs),
			mtimeNs: stat.mtimeNs,
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
		});
	}
	return entries;
}

/**
 * Remove one canonical blob, fail-closed on identity drift. The entry captured
 * at scan time must still describe the file at unlink time (same inode, size and
 * mtime, still a single-link regular file), otherwise the blob is left in place.
 *
 * `beforeUnlink` runs after this function has verified the blob and immediately
 * before it calls unlink. Callers use it to bind external liveness evidence to
 * the verified blob identity, so a live reference that appears while the blob is
 * being revalidated prevents the destructive syscall.
 *
 * `failed` distinguishes an actual IO failure (which a caller should surface as
 * a failed reclaim) from a revalidation refusal (which is an ordinary KEEP).
 */
export async function removeCanonicalBlob(
	entry: CanonicalBlobEntry,
	options: { beforeUnlink?: () => Promise<boolean> } = {},
): Promise<{ removed: true } | { removed: false; reason: string; failed?: true }> {
	let stat: fs.BigIntStats;
	try {
		stat = await fsp.lstat(entry.path, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return { removed: false, reason: "blob_disappeared" };
		return { removed: false, reason: `blob_unverifiable: ${String(error)}`, failed: true };
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
		return { removed: false, reason: "blob_not_plain_file" };
	}
	if (
		stat.dev !== entry.dev ||
		stat.ino !== entry.ino ||
		stat.size !== BigInt(entry.bytes) ||
		stat.mtimeNs !== entry.mtimeNs
	) {
		return { removed: false, reason: "blob_changed" };
	}
	if (options.beforeUnlink && !(await options.beforeUnlink())) {
		return { removed: false, reason: "blob_reference_evidence_changed" };
	}
	const removed = exactUnlink(entry.path, {
		dev: entry.dev,
		ino: entry.ino,
		nlink: entry.nlink,
		size: BigInt(entry.bytes),
		mtimeNs: entry.mtimeNs,
		sha256: entry.hash,
		quarantineName: `.gjc-gc-blob-${entry.hash}`,
	});
	if (removed.ok) return { removed: true };
	if (removed.code === "cleanup_pending" && removed.detachedPath) {
		try {
			await fsp.unlink(removed.detachedPath);
			return { removed: true };
		} catch (error) {
			return { removed: false, reason: `blob_cleanup_failed: ${String(error)}`, failed: true };
		}
	}
	if (removed.code === "not_found") return { removed: false, reason: "blob_disappeared" };
	return { removed: false, reason: `blob_unlink_failed: ${removed.code ?? "unknown"}`, failed: true };
}
