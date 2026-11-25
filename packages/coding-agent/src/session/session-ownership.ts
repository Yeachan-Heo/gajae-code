/**
 * Session ownership core: one session is open for writing in one live process.
 *
 * A claim is a kernel lock on `<trusted home>/.gjc/runtime/session-owners/<key>.session-owner`
 * (the native `FileLock`), so it ends when its holder exits, however it exits. A holder record
 * beside it names the holder for warnings; the lock is the truth and the record only a label.
 *
 * Dormant: no caller outside this module and its tests yet. The claim set, the mode setting and
 * the factory wiring arrive in later steps of the single-owner programme.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FileLock,
	type FileLockAcquireResult,
	FileLockAcquireStatus,
	FileLockFailure,
	type FileLockProbeResult,
	FileLockProbeState,
	probeFileLock,
	tryAcquireFileLock,
} from "@gajae-code/natives";
import { getTrustedHomeDir, isEnoent, logger } from "@gajae-code/utils";
import { VERSION } from "@gajae-code/utils/cli-metadata";
import { observeProcess, processIncarnation } from "../sdk/broker/process-incarnation";
import {
	classifySessionOwnerEntry,
	SESSION_OWNER_RECORD_SUFFIX,
	SESSION_OWNER_SIDECAR_SUFFIX,
	SESSION_OWNERS_RELATIVE_DIR,
} from "./session-owners-layout";
import { type SessionOwnershipTestHookSlot, sessionOwnershipTestHookSlot } from "./session-ownership-mode";
import {
	assertAppendLockHomeNotSharedWritable,
	assertNoReparsePath,
	assertRuntimeLockDirectoryUnchanged,
	canonicalPathSync,
	prepareRuntimeLockDirectory,
	type RuntimeLockDirectory,
} from "./session-storage";

const SIDECAR_SUFFIX = SESSION_OWNER_SIDECAR_SUFFIX;
const RECORD_SUFFIX = SESSION_OWNER_RECORD_SUFFIX;
const RECORD_VERSION = 1;
const RECORD_MAX_BYTES = 4096;
/** Every native call answers within this budget, or reports `timed_out`. */
const NATIVE_BUDGET_MS = 2_000;
const PROBE_CONCURRENCY = 16;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Keys must not differ only in case: macOS volumes are case-insensitive by default. */
const PLAIN_KEY = /^[a-z0-9_-]{1,128}$/;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
/** A UTC instant as `Date#toISOString` writes it; anything else in a record is not shown. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const SESSION_OWNER_SURFACES = ["app", "terminal", "print", "sdk-host", "acp-host", "sdk"] as const;
export type SessionOwnerBaseSurface = (typeof SESSION_OWNER_SURFACES)[number];
/** Where the holder runs; a subagent child carries its parent's surface plus ` (subagent)`. */
export type SessionOwnerSurface = SessionOwnerBaseSurface | `${SessionOwnerBaseSurface} (subagent)`;

/** A verified holder: its lock is held, and (on this host) its pid and incarnation match its record. */
export interface SessionOwnerHolder {
	readonly surface: SessionOwnerSurface;
	readonly pid: number;
	/** Present only when the holder runs on another host, whose pid cannot be checked here. */
	readonly host?: string;
	readonly gjcVersion?: string;
	readonly claimedAt?: string;
}

export type SessionOwnerUnknownReason = "unavailable" | "timed_out" | "failed";

export type SessionOwnerProbe =
	| { readonly state: "free" }
	| { readonly state: "held"; readonly self: boolean; readonly holder?: SessionOwnerHolder }
	| { readonly state: "unknown"; readonly reason: SessionOwnerUnknownReason; readonly code?: string };

export interface SessionOwnerClaim {
	readonly sessionId: string;
	readonly surface: SessionOwnerSurface;
	/** True when this process already held the session and this claim shares it. */
	readonly shared: boolean;
	readonly released: boolean;
	/** Drop this claim. Idempotent; the last claim of a session removes the record, then unlocks. */
	release(): void;
}

export type SessionOwnerClaimResult =
	| { readonly status: "claimed"; readonly claim: SessionOwnerClaim }
	| { readonly status: "held"; readonly holder?: SessionOwnerHolder }
	/** Fail-open: no claim was taken and the caller proceeds as before (design §2.7). */
	| { readonly status: "skipped"; readonly reason: "unavailable" | "timed_out"; readonly code?: string };

/** Lock calls, replaceable by tests to reach the fail-open paths. */
export interface SessionOwnerLockBackend {
	tryAcquire(sidecar: string, timeoutMs: number): Promise<FileLockAcquireResult>;
	probe(sidecar: string, timeoutMs: number): Promise<FileLockProbeResult>;
}

/**
 * Test-only seams. Code, not environment, so a project `.env` cannot reach them. One object per
 * process (see {@link sessionOwnershipTestHookSlot}), shared by every copy of this module.
 */
export const SessionOwnershipTestHooks: SessionOwnershipTestHookSlot & {
	lockBackend?: SessionOwnerLockBackend;
	/** Runs after a record's temp file is written and before it is renamed into place. */
	beforeRecordPublish?: () => void;
} = sessionOwnershipTestHookSlot();

const nativeBackend: SessionOwnerLockBackend = {
	tryAcquire: (sidecar, timeoutMs) => tryAcquireFileLock(sidecar, timeoutMs),
	probe: (sidecar, timeoutMs) => probeFileLock(sidecar, timeoutMs),
};

function backend(): SessionOwnerLockBackend {
	return SessionOwnershipTestHooks.lockBackend ?? nativeBackend;
}

/**
 * A failure that refuses the session, as the append lock refuses it (design §2.7). `code` is the
 * machine code: `owners_directory_unsafe` (a safety check refused the directory),
 * `owners_directory_io` (the filesystem refused, e.g. EROFS or ENOSPC; see `errno`),
 * `owners_directory_changed`, or the lock's own failure code.
 */
export class SessionOwnershipError extends Error {
	readonly code: string;
	readonly errno: string | undefined;
	readonly operatorMessage =
		"gjc could not check safely whether another process has this session open, so it was not opened for writing. Check that .gjc/runtime in your home directory belongs to you and is writable.";

	constructor(code: string, options?: { cause?: unknown; errno?: string }) {
		super(`session_ownership_failed: ${code}`, options);
		this.name = "SessionOwnershipError";
		this.code = code;
		this.errno = options?.errno;
	}
}

/** Classify a directory setup failure: a filesystem errno, or a refused safety check. */
function directoryFailure(error: unknown): SessionOwnershipError {
	const errno = (error as { code?: unknown } | undefined)?.code;
	if (typeof errno === "string" && /^E[A-Z0-9]+$/.test(errno))
		return new SessionOwnershipError("owners_directory_io", { cause: error, errno });
	return new SessionOwnershipError("owners_directory_unsafe", { cause: error });
}

// =============================================================================
// Key and directory
// =============================================================================

/**
 * The sidecar key for a session id: the id itself when it is a lower-case safe file name,
 * otherwise `h-<hash>`. Ids with upper case are hashed so two ids differing only in case never
 * share a sidecar on a case-insensitive volume; ids starting with `h-` are hashed so no id can
 * name another's sidecar.
 */
export function sessionOwnerKey(sessionId: string): string {
	if (sessionId.length === 0) throw new TypeError("session id must not be empty");
	if (PLAIN_KEY.test(sessionId) && !sessionId.startsWith("h-")) return sessionId;
	return `h-${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32)}`;
}

function trustedHome(): string {
	return canonicalPathSync(SessionOwnershipTestHooks.homeOverride ?? getTrustedHomeDir());
}

export function sessionOwnersDirectory(): string {
	return path.join(trustedHome(), SESSION_OWNERS_RELATIVE_DIR);
}

/** The append lock's checks without creating anything; `undefined` when no claim was ever made here. */
function inspectOwnersDirectory(): string | undefined {
	const home = trustedHome();
	assertAppendLockHomeNotSharedWritable(home);
	const owners = path.join(home, SESSION_OWNERS_RELATIVE_DIR);
	assertNoReparsePath(owners);
	try {
		if (!fs.lstatSync(owners).isDirectory()) throw new Error("session_owners_not_directory");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	return owners;
}

function assertOwnersDirectoryUnchanged(directory: RuntimeLockDirectory): void {
	try {
		assertRuntimeLockDirectoryUnchanged(directory.directories, "owners_directory_changed", directory.label);
	} catch (error) {
		throw new SessionOwnershipError("owners_directory_changed", { cause: error });
	}
}

// =============================================================================
// Holder record
// =============================================================================

interface OwnerRecord {
	readonly v: number;
	readonly sessionId: string;
	readonly claimNonce: string;
	readonly pid: number;
	readonly processIncarnation: string | null;
	readonly surface: SessionOwnerSurface;
	readonly host: string;
	readonly gjcVersion: string;
	readonly claimedAt: string;
}

function isSurface(value: unknown): value is SessionOwnerSurface {
	if (typeof value !== "string") return false;
	const base = value.endsWith(" (subagent)") ? value.slice(0, -" (subagent)".length) : value;
	return (SESSION_OWNER_SURFACES as readonly string[]).includes(base);
}

function parseRecord(text: string): OwnerRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	const valid =
		r.v === RECORD_VERSION &&
		typeof r.sessionId === "string" &&
		typeof r.claimNonce === "string" &&
		typeof r.pid === "number" &&
		Number.isSafeInteger(r.pid) &&
		r.pid > 0 &&
		(r.processIncarnation === null || typeof r.processIncarnation === "string") &&
		isSurface(r.surface) &&
		typeof r.host === "string" &&
		r.host.length <= 255 &&
		typeof r.gjcVersion === "string" &&
		typeof r.claimedAt === "string" &&
		r.claimedAt.length <= 64;
	return valid ? (r as unknown as OwnerRecord) : undefined;
}

/** Read a record without following a link, bounded; any defect reads as no record. */
function readRecord(recordPath: string): OwnerRecord | undefined {
	let fd: number;
	try {
		fd = fs.openSync(recordPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
	} catch {
		return undefined;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return undefined;
		// Only this user's gjc writes records here; anything else is not a label to show.
		const uid = process.getuid?.();
		if (uid !== undefined && stat.uid !== uid) return undefined;
		const buffer = Buffer.alloc(stat.size);
		const read = fs.readSync(fd, buffer, 0, buffer.byteLength, 0);
		return parseRecord(buffer.subarray(0, read).toString("utf8"));
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

/** Publish a record atomically: an exclusive owner-only temp file, then a rename over the old one. */
function writeRecord(recordPath: string, record: OwnerRecord): void {
	const temp = `${recordPath}.${record.claimNonce}.tmp`;
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
	let published = false;
	try {
		const fd = fs.openSync(temp, flags, 0o600);
		try {
			fs.writeSync(fd, JSON.stringify(record));
		} finally {
			fs.closeSync(fd);
		}
		SessionOwnershipTestHooks.beforeRecordPublish?.();
		fs.renameSync(temp, recordPath);
		published = true;
	} finally {
		// The temp name carries this claim's nonce, so it is never another writer's file.
		if (!published) fs.rmSync(temp, { force: true });
	}
}

/** A record's `claimedAt`, re-serialised, or `undefined` when it is not a plain UTC instant. */
function safeInstant(value: string): string | undefined {
	if (!ISO_INSTANT.test(value)) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The holder a record names, if it checks out; otherwise `undefined` ("another gjc process"). */
function verifiedHolder(record: OwnerRecord | undefined, sessionId: string): SessionOwnerHolder | undefined {
	if (!record || record.sessionId !== sessionId) return undefined;
	const gjcVersion = SAFE_VERSION.test(record.gjcVersion) ? record.gjcVersion : undefined;
	const base = { surface: record.surface, pid: record.pid, gjcVersion, claimedAt: safeInstant(record.claimedAt) };
	// A live pid with a matching start incarnation is this host's process even if the host name
	// changed since the record was written (macOS renames hosts with the network).
	if (observeProcess(record.pid, record.processIncarnation ?? undefined) === "alive") return base;
	if (record.host === os.hostname() || !SAFE_HOST.test(record.host)) return undefined;
	return { ...base, host: record.host };
}

// =============================================================================
// Process-global registry
// =============================================================================

interface RegistryEntry {
	readonly sessionId: string;
	readonly surface: SessionOwnerSurface;
	readonly nonce: string;
	readonly claimedAt: string;
	readonly recordPath: string;
	readonly lock: FileLock;
	holders: number;
}

interface SessionOwnerRegistry {
	/** Held claims by sidecar path; the count is how many claims share one lock. */
	readonly entries: Map<string, RegistryEntry>;
	/** Acquires in flight, so a second claim in this process waits instead of contending. */
	readonly pending: Map<string, Promise<void>>;
	/** Set once a lock call reports `unavailable`: claims are off for this process. */
	unavailable: string | undefined;
	/** In-process event counts (design §2.9); added after v1 shipped, so a v1 registry may lack it. */
	counters?: Map<SessionOwnershipCounter, number>;
}

/** Versioned, so two copies of this module in one realm share one registry (design §2.5). */
const REGISTRY_KEY = Symbol.for("gajae-code.session-ownership.registry.v1");

function registry(): SessionOwnerRegistry {
	const store = globalThis as unknown as Record<symbol, SessionOwnerRegistry | undefined>;
	let found = store[REGISTRY_KEY];
	if (!found) {
		found = { entries: new Map(), pending: new Map(), unavailable: undefined };
		store[REGISTRY_KEY] = found;
	}
	return found;
}

/**
 * Test-only: forget the `unavailable` latch and the counters, and drop any claim a test leaked, unlocking it, then
 * throw if one was leaked. The registry is clean either way, so one leak fails one test only.
 */
export function resetSessionOwnershipForTests(): void {
	const current = registry();
	current.unavailable = undefined;
	current.counters?.clear();
	const leaked = [...current.entries.values()];
	current.entries.clear();
	for (const entry of leaked) entry.lock.release();
	if (leaked.length > 0) throw new Error(`${leaked.length} session claim(s) were never released`);
}

/** Events counted for the observe phase (design §2.9). In-process only until the stats step lands. */
export type SessionOwnershipCounter =
	| "release_after_deferred_timeout"
	| "session_write_without_claim"
	/** Claims still in the claim set of a manager that was garbage-collected: a missed release. */
	| "claims_abandoned"
	/** A manager's session id changed outside any transition, so no settle followed it. */
	| "bind_outside_transition"
	/** A claim for a non-current id was added outside any transition: an unrelated settle could drop it. */
	| "target_staged_outside_transition";

export function countSessionOwnershipEvent(name: SessionOwnershipCounter): void {
	const current = registry();
	current.counters ??= new Map();
	current.counters.set(name, (current.counters.get(name) ?? 0) + 1);
}

/** A snapshot of this process's counts; a name never counted reads 0. */
export function sessionOwnershipCounters(): Readonly<Record<SessionOwnershipCounter, number>> {
	const counters = registry().counters;
	return {
		release_after_deferred_timeout: counters?.get("release_after_deferred_timeout") ?? 0,
		claims_abandoned: counters?.get("claims_abandoned") ?? 0,
		bind_outside_transition: counters?.get("bind_outside_transition") ?? 0,
		target_staged_outside_transition: counters?.get("target_staged_outside_transition") ?? 0,
		session_write_without_claim: counters?.get("session_write_without_claim") ?? 0,
	};
}

function markUnavailable(code: string | undefined): string {
	const current = registry();
	const latched = code ?? "unavailable";
	if (current.unavailable === undefined) {
		current.unavailable = latched;
		logger.warn("Session ownership is unavailable; claims are off for this process", { code: latched });
	}
	return current.unavailable;
}

class Claim implements SessionOwnerClaim {
	readonly #sidecar: string;
	readonly #entry: RegistryEntry;
	readonly shared: boolean;
	#released = false;

	constructor(sidecar: string, entry: RegistryEntry, shared: boolean) {
		this.#sidecar = sidecar;
		this.#entry = entry;
		this.shared = shared;
	}

	get sessionId(): string {
		return this.#entry.sessionId;
	}

	get surface(): SessionOwnerSurface {
		return this.#entry.surface;
	}

	get released(): boolean {
		return this.#released;
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		const entry = this.#entry;
		entry.holders -= 1;
		if (entry.holders > 0) return;
		const entries = registry().entries;
		// A test reset dropped and unlocked this entry; the sidecar may now name a newer claim.
		if (entries.get(this.#sidecar) !== entry) return;
		// Synchronous from here to the unlock, so no claim in this process can meet its own lock.
		entries.delete(this.#sidecar);
		// Remove the record before the lock, so a successor's record is never removed; leave a
		// record whose nonce is not ours.
		if (readRecord(entry.recordPath)?.claimNonce === entry.nonce) {
			try {
				fs.unlinkSync(entry.recordPath);
			} catch (error) {
				if (!isEnoent(error)) logger.warn("Session owner record removal failed", { error: String(error) });
			}
		}
		entry.lock.release();
	}
}

function selfHolder(entry: RegistryEntry): SessionOwnerHolder {
	return { surface: entry.surface, pid: process.pid, gjcVersion: VERSION, claimedAt: entry.claimedAt };
}

// =============================================================================
// Claim and probe
// =============================================================================

/**
 * Claim `sessionId` for this process. A session this process already holds is shared (design D10).
 * Throws `SessionOwnershipError` when the owners directory or the lock fails in a way that must
 * refuse the session; only `unavailable` and `timed_out` fail open (design §2.7).
 */
export async function claimSessionOwner(
	sessionId: string,
	request: { readonly surface: SessionOwnerSurface },
): Promise<SessionOwnerClaimResult> {
	const key = sessionOwnerKey(sessionId);
	const current = registry();
	if (current.unavailable !== undefined)
		return { status: "skipped", reason: "unavailable", code: current.unavailable };
	let directory: RuntimeLockDirectory;
	try {
		directory = prepareRuntimeLockDirectory("session-owners", trustedHome());
	} catch (error) {
		throw directoryFailure(error);
	}
	const owners = directory.path;
	const sidecar = path.join(owners, `${key}${SIDECAR_SUFFIX}`);
	for (;;) {
		const held = current.entries.get(sidecar);
		if (held) {
			held.holders += 1;
			return { status: "claimed", claim: new Claim(sidecar, held, true) };
		}
		const pending = current.pending.get(sidecar);
		if (!pending) break;
		await pending;
	}
	// The acquire waited on may have found the platform unavailable.
	if (current.unavailable !== undefined)
		return { status: "skipped", reason: "unavailable", code: current.unavailable };
	const { promise, resolve } = Promise.withResolvers<void>();
	current.pending.set(sidecar, promise);
	try {
		assertOwnersDirectoryUnchanged(directory);
		const result = await backend().tryAcquire(sidecar, NATIVE_BUDGET_MS);
		switch (result.status) {
			case FileLockAcquireStatus.Acquired: {
				if (!result.lock) throw new SessionOwnershipError("acquired_without_lock");
				// A swap during the acquire would leave this lock in a directory other processes no
				// longer see; release it and refuse, as the append lock does.
				try {
					assertOwnersDirectoryUnchanged(directory);
				} catch (error) {
					result.lock.release();
					throw error;
				}
				const entry: RegistryEntry = {
					sessionId,
					surface: request.surface,
					nonce: randomUUID(),
					claimedAt: new Date().toISOString(),
					recordPath: path.join(owners, `${key}${RECORD_SUFFIX}`),
					lock: result.lock,
					holders: 1,
				};
				try {
					writeRecord(entry.recordPath, {
						v: RECORD_VERSION,
						sessionId,
						claimNonce: entry.nonce,
						pid: process.pid,
						processIncarnation: processIncarnation(process.pid) ?? null,
						surface: entry.surface,
						host: os.hostname(),
						gjcVersion: VERSION,
						claimedAt: entry.claimedAt,
					});
				} catch (error) {
					// The lock is the truth; without a record the holder reads as "another gjc process".
					// A record left by an earlier holder must not name that holder instead: this claim
					// holds the lock, so no live process owns it.
					logger.warn("Session owner record write failed", { error: String(error) });
					try {
						fs.unlinkSync(entry.recordPath);
					} catch (unlinkError) {
						if (!isEnoent(unlinkError))
							logger.warn("Stale session owner record removal failed", { error: String(unlinkError) });
					}
				}
				current.entries.set(sidecar, entry);
				return { status: "claimed", claim: new Claim(sidecar, entry, false) };
			}
			case FileLockAcquireStatus.Held:
				return {
					status: "held",
					holder: verifiedHolder(readRecord(path.join(owners, `${key}${RECORD_SUFFIX}`)), sessionId),
				};
			case FileLockAcquireStatus.Unavailable:
				return { status: "skipped", reason: "unavailable", code: markUnavailable(result.code) };
			case FileLockAcquireStatus.TimedOut:
				// A stall is not a platform property: skip this claim only, and try again next time.
				logger.warn("Session ownership claim timed out; this claim is skipped", { code: result.code });
				return { status: "skipped", reason: "timed_out", code: result.code };
			default:
				throw new SessionOwnershipError(result.code ?? "lock_failed");
		}
	} finally {
		current.pending.delete(sidecar);
		resolve();
	}
}

/** `present`, `missing`, or the code of the failure that refused the directory. */
type OwnersDirectoryState = "present" | "missing" | { readonly failed: string };

async function probeOne(owners: string, state: OwnersDirectoryState, sessionId: string): Promise<SessionOwnerProbe> {
	const current = registry();
	const sidecar = path.join(owners, `${sessionOwnerKey(sessionId)}${SIDECAR_SUFFIX}`);
	// This process's own claims come first: the registry knows them whatever the directory says.
	for (let pending = current.pending.get(sidecar); pending; pending = current.pending.get(sidecar)) await pending;
	const own = current.entries.get(sidecar);
	if (own) return { state: "held", self: true, holder: selfHolder(own) };
	if (state === "missing") return { state: "free" };
	if (typeof state === "object") return { state: "unknown", reason: "failed", code: state.failed };
	if (current.unavailable !== undefined) return { state: "unknown", reason: "unavailable", code: current.unavailable };
	const result = await backend().probe(sidecar, NATIVE_BUDGET_MS);
	switch (result.state) {
		case FileLockProbeState.Free:
			return { state: "free" };
		case FileLockProbeState.Held: {
			const recordPath = sidecar.slice(0, -SIDECAR_SUFFIX.length) + RECORD_SUFFIX;
			return { state: "held", self: false, holder: verifiedHolder(readRecord(recordPath), sessionId) };
		}
		default: {
			const reason = result.reason ?? FileLockFailure.Failed;
			// Only an unsupported platform proves a claim would fail too: on macOS the probe is an
			// F_GETLK query while a claim is flock(2), so a probe's ENOTSUP says nothing about claims.
			if (reason === FileLockFailure.Unavailable && result.code === "unsupported_platform")
				markUnavailable(result.code);
			return { state: "unknown", reason, code: result.code };
		}
	}
}

/**
 * Report, for each id, whether a live process holds it, without taking anything. Three-valued:
 * destructive operations need `free`. Throws only for an empty id, and never creates the directory.
 */
export async function probeSessionOwners(sessionIds: readonly string[]): Promise<Map<string, SessionOwnerProbe>> {
	const ids = [...new Set(sessionIds)];
	for (const id of ids) sessionOwnerKey(id);
	const results = new Map<string, SessionOwnerProbe>();
	const owners = sessionOwnersDirectory();
	let state: OwnersDirectoryState;
	try {
		state = inspectOwnersDirectory() === undefined ? "missing" : "present";
	} catch (error) {
		logger.warn("Session owners directory failed its checks", { error: String(error) });
		state = { failed: directoryFailure(error).code };
	}
	for (let start = 0; start < ids.length; start += PROBE_CONCURRENCY) {
		const batch = ids.slice(start, start + PROBE_CONCURRENCY);
		const probes = await Promise.all(batch.map(id => probeOne(owners, state, id)));
		for (const [index, id] of batch.entries()) results.set(id, probes[index]);
	}
	return results;
}

export async function probeSessionOwner(sessionId: string): Promise<SessionOwnerProbe> {
	const probe = (await probeSessionOwners([sessionId])).get(sessionId);
	if (!probe) throw new Error("probe returned no result");
	return probe;
}

// =============================================================================
// Inventory (read-only; design §2.9)
// =============================================================================

/**
 * What the record beside a held sidecar says: `verified` (its holder checks out), `holder_gone` (a
 * process on this host that no longer exists, impossible under a kernel lock and so a bug signal),
 * `unverified` (alive but unprovable), `absent`, or `invalid` (unreadable, or naming another key).
 */
export type SessionOwnerRecordState = "verified" | "holder_gone" | "unverified" | "absent" | "invalid";

/** A held (or unprobeable) sidecar. Every field is checked: records are untrusted input. */
export interface SessionOwnerSidecar {
	readonly key: string;
	readonly state: "held" | "unknown";
	/** This process holds it. */
	readonly self: boolean;
	readonly record: SessionOwnerRecordState;
	/** The id the record names, only when it maps to this key and is a safe id. */
	readonly sessionId?: string;
	readonly holder?: SessionOwnerHolder;
	/** The pid of a `holder_gone` record. */
	readonly gonePid?: number;
}

export interface SessionOwnersInventory {
	readonly directory: "missing" | "present";
	readonly sidecars: number;
	readonly records: number;
	/** Entries that are neither a sidecar nor a record with a well-formed key. */
	readonly unrecognized: number;
	/** Allocated size of the directory and its entries (apparent size where blocks are not reported). */
	readonly diskBytes: number;
	readonly held: readonly SessionOwnerSidecar[];
}

function describeRecord(
	record: OwnerRecord | undefined,
	key: string,
): Omit<SessionOwnerSidecar, "key" | "state" | "self"> {
	if (!record) return { record: "absent" };
	if (record.sessionId.length === 0 || sessionOwnerKey(record.sessionId) !== key) return { record: "invalid" };
	const sessionId = SAFE_ID.test(record.sessionId) ? record.sessionId : undefined;
	const holder = verifiedHolder(record, record.sessionId);
	if (holder) return { record: "verified", sessionId, holder };
	const gone =
		record.host === os.hostname() && observeProcess(record.pid, record.processIncarnation ?? undefined) === "exited";
	return gone ? { record: "holder_gone", sessionId, gonePid: record.pid } : { record: "unverified", sessionId };
}

/**
 * Every held sidecar under the owners directory, with its checked holder, plus the directory's
 * counts. Read-only: it probes and reads, never claims, writes, unlinks or creates the directory.
 * `keys` limits the probes (and the counts) to those sidecars, for a second look at suspects; this
 * process's own claims, read from the registry, are always included.
 * Throws `SessionOwnershipError` when the directory fails the append lock's safety checks.
 */
export async function inspectSessionOwners(
	options: { readonly keys?: readonly string[] } = {},
): Promise<SessionOwnersInventory> {
	const current = registry();
	let owners: string | undefined;
	try {
		owners = inspectOwnersDirectory();
	} catch (error) {
		throw directoryFailure(error);
	}
	const self = new Map<string, RegistryEntry>();
	for (const [sidecar, entry] of current.entries) self.set(path.basename(sidecar, SIDECAR_SUFFIX), entry);
	const held: SessionOwnerSidecar[] = [...self].map(([key, entry]) => ({
		key,
		state: "held",
		self: true,
		record: "verified",
		sessionId: SAFE_ID.test(entry.sessionId) ? entry.sessionId : undefined,
		holder: selfHolder(entry),
	}));
	const counts = { sidecars: 0, records: 0, unrecognized: 0, diskBytes: 0 };
	if (!owners) return { directory: "missing", ...counts, held };
	const keys: string[] = [];
	const names = options.keys ? options.keys.map(key => `${key}${SIDECAR_SUFFIX}`) : [".", ...fs.readdirSync(owners)];
	for (const name of names) {
		let isFile = false;
		try {
			const stat = fs.lstatSync(path.join(owners, name));
			counts.diskBytes += stat.blocks ? stat.blocks * 512 : stat.size;
			isFile = stat.isFile();
		} catch {}
		if (name === ".") continue;
		const entry = classifySessionOwnerEntry(name, isFile);
		if (entry.kind === "sidecar") {
			counts.sidecars += 1;
			if (!self.has(entry.key)) keys.push(entry.key);
		} else if (entry.kind === "record") counts.records += 1;
		else counts.unrecognized += 1;
	}
	const directory = owners;
	const inspectOne = async (key: string): Promise<SessionOwnerSidecar | undefined> => {
		let state: SessionOwnerSidecar["state"] = "unknown";
		if (current.unavailable === undefined) {
			const probe = await backend().probe(path.join(directory, `${key}${SIDECAR_SUFFIX}`), NATIVE_BUDGET_MS);
			if (probe.state === FileLockProbeState.Free) return undefined;
			if (probe.state === FileLockProbeState.Held) state = "held";
		}
		const record = readRecord(path.join(directory, `${key}${RECORD_SUFFIX}`));
		return { key, state, self: false, ...describeRecord(record, key) };
	};
	for (let start = 0; start < keys.length; start += PROBE_CONCURRENCY) {
		const found = await Promise.all(keys.slice(start, start + PROBE_CONCURRENCY).map(inspectOne));
		for (const sidecar of found) if (sidecar) held.push(sidecar);
	}
	held.sort((a, b) => a.key.localeCompare(b.key));
	return { directory: "present", ...counts, held };
}

// =============================================================================
// Refusal
// =============================================================================

const SURFACE_NOUNS: Record<SessionOwnerBaseSurface, string> = {
	app: "the Gajae Code app",
	terminal: "another terminal",
	print: "a gjc -p run",
	"sdk-host": "an SDK session host",
	"acp-host": "an ACP session host",
	sdk: "an application using the gjc SDK",
};

/**
 * How a holder is named to a person (design §3.4). The holder is checked again here, because a
 * caller may build one: anything malformed reads as "another gjc process", never as raw text.
 */
export function sessionOwnerHolderPhrase(holder: SessionOwnerHolder | undefined): string {
	if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !isSurface(holder.surface))
		return "another gjc process";
	if (holder.host !== undefined)
		return SAFE_HOST.test(holder.host)
			? `a gjc process on ${holder.host} (pid ${holder.pid})`
			: "another gjc process";
	const subagent = holder.surface.endsWith(" (subagent)");
	const base = (subagent ? holder.surface.slice(0, -" (subagent)".length) : holder.surface) as SessionOwnerBaseSurface;
	const noun = SURFACE_NOUNS[base];
	return subagent ? `a subagent of ${noun} (pid ${holder.pid})` : `${noun} (pid ${holder.pid})`;
}

/**
 * A session another live process holds for writing. `message` is the stable machine code; the
 * fixed, path-free `operatorMessage` is what a person sees.
 */
export class SessionHeldError extends Error {
	readonly code = "session_held";
	readonly sessionId: string;
	readonly holder: SessionOwnerHolder | undefined;
	readonly operatorMessage: string;

	constructor(sessionId: string, holder?: SessionOwnerHolder) {
		super("session_held");
		this.name = "SessionHeldError";
		this.sessionId = sessionId;
		this.holder = holder;
		// Only a safe id is quoted, shortened as the CLI shows it; any other id may hold any text.
		const subject = SAFE_ID.test(sessionId) ? `Session ${sessionId.slice(0, 8)}` : "This session";
		this.operatorMessage = `${subject} is open for writing in ${sessionOwnerHolderPhrase(holder)}. Only one process can write a session at a time. Close it there, or fork it to continue in a copy.`;
	}
}
