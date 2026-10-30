/**
 * SessionLease — the construct that makes live control honest without a global daemon.
 *
 * Exactly one live `RuntimeOwner` holds the lease for a session; only the lease holder
 * may append events or run the default router. A stale lease (owner dead OR expired) may
 * be taken over, incrementing `leaseEpoch`, but a stale lease is NEVER permission for
 * destructive recovery (that gate lives in the classifier/recovery layer).
 */
import { createHash, randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isFileLockAcquireTimeout, withFileLock } from "../config/file-lock";

import { controlSocketPath, controlSocketPathFor, sessionPaths, stableRootKey } from "./storage";

export interface SessionLease {
	ownerId: string;
	sessionId: string;
	pid: number;
	leaseTokenHash: string;
	endpoint: { kind: "unix-socket" | "fifo"; path: string } | null;
	eventsPath: string;
	heartbeatAt: string;
	expiresAt: string;
	leaseEpoch: number;
	writer: { ownerId: string; leaseEpoch: number };
}

export class LeaseError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "LeaseError";
	}
}
export type LeaseStatus = "missing" | "live" | "expiredAlive" | "dead" | "epermAlive";

type PidStatus = "alive" | "dead" | "eperm";

function nowMs(clock?: () => number): number {
	return clock ? clock() : Date.now();
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

async function writeLeaseAtomic(file: string, lease: SessionLease): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
	await fs.writeFile(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
	await fs.rename(tmp, file);
}
function leaseMutationLockPath(root: string, sessionId: string): string {
	return sessionPaths(root, sessionId).lease;
}

function isOwnedUnixEndpointPath(root: string, sessionId: string, endpointPath: string, fallbackPath: string): boolean {
	const resolvedEndpoint = path.resolve(endpointPath);
	if (resolvedEndpoint === path.resolve(fallbackPath)) return true;
	try {
		return resolvedEndpoint === path.resolve(controlSocketPath(root, sessionId));
	} catch {
		return false;
	}
}

/** Lexical identity of two socket paths. Blank, padded, and NUL paths do not match. */
export function classifyOwnerSocketLexical(candidate: string, canonical: string): "match" | "mismatch" {
	const left = lexicalOwnerSocketKey(candidate);
	const right = lexicalOwnerSocketKey(canonical);
	if (left === null || right === null) return "mismatch";
	return left === right ? "match" : "mismatch";
}

function lexicalOwnerSocketKey(socketPath: string): string | null {
	if (typeof socketPath !== "string") return null;
	if (socketPath.length === 0 || socketPath.trim() !== socketPath || socketPath.includes("\0")) return null;
	const resolved = path.resolve(socketPath);
	if (!path.isAbsolute(resolved)) return null;
	return resolved;
}

function socketBaseNamesMatch(left: string, right: string): boolean {
	const leftName = path.basename(left);
	const rightName = path.basename(right);
	if (leftName === rightName) return true;
	if (process.platform !== "darwin" && process.platform !== "win32") return false;
	return leftName.toLowerCase() === rightName.toLowerCase();
}

function ownerSocketPathsMatch(candidate: string, canonical: string): boolean {
	if (classifyOwnerSocketLexical(candidate, canonical) === "match") return true;
	const left = lexicalOwnerSocketKey(candidate);
	const right = lexicalOwnerSocketKey(canonical);
	if (left === null || right === null || !socketBaseNamesMatch(left, right)) return false;
	// Fast-path: if parent dirs are identical strings, no need for expensive realpath resolution
	const leftDir = path.dirname(left);
	const rightDir = path.dirname(right);
	if (leftDir === rightDir) return true;
	try {
		return fsSync.realpathSync(leftDir) === fsSync.realpathSync(rightDir);
	} catch {
		return false;
	}
}

const SOCKET_RECORD_MAX_BYTES = 1024;

export interface OwnerSocketRecordIdentity {
	ownerId: string;
	leaseEpoch: number;
	nonce: string;
}

interface OwnerSocketRecord extends OwnerSocketRecordIdentity {
	socketPath: string;
	pid: number;
}

function processUid(): number | null {
	const uid = process.getuid?.();
	return typeof uid === "number" ? uid : null;
}

function noFollowFlag(): number {
	return fsSync.constants.O_NOFOLLOW ?? 0;
}

/** Windows never gets a record: its owner check would need SID-based ACL verification. */
function ownerSocketRecordRoot(): string | null {
	if (process.platform === "win32") return null;
	const uid = processUid();
	if (uid === null) return null;
	return path.join("/tmp", `gjc-socknote-${uid}`);
}

/** Private record path for this session. Null when the store root cannot be named. */
export function ownerSocketRecordPath(root: string, sessionId: string): string | null {
	const base = ownerSocketRecordRoot();
	if (!base) return null;
	const digest = createHash("sha256")
		.update(`${stableRootKey(root)}\0${sessionId}`)
		.digest("hex")
		.slice(0, 24);
	return path.join(base, digest, "record.json");
}

function ensureTrustedDir(dir: string): boolean {
	try {
		fsSync.mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
	}
	return recordDirTrusted(dir);
}

function recordDirTrusted(dir: string): boolean {
	try {
		const st = fsSync.lstatSync(dir);
		if (st.isSymbolicLink() || !st.isDirectory()) return false;
		if (process.platform === "win32") return false;
		const uid = processUid();
		if (uid === null || st.uid !== uid) return false;
		if ((st.mode & 0o077) !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

function recordFileTrusted(st: fsSync.Stats): boolean {
	if (!st.isFile()) return false;
	if (process.platform === "win32") return false;
	const uid = processUid();
	if (uid === null || st.uid !== uid) return false;
	return (st.mode & 0o077) === 0;
}
/** In-process seam. Production leaves this unset. A test may swap the store after the directory check. */
let ownerSocketRecordAfterDirCheck: (() => void) | null = null;

export function setOwnerSocketRecordAfterDirCheck(hook: (() => void) | null): void {
	ownerSocketRecordAfterDirCheck = hook;
}

interface DirIdentity {
	dev: number;
	ino: number;
}

function trustedDirIdentity(dir: string): DirIdentity | null {
	if (!recordDirTrusted(dir)) return null;
	try {
		const st = fsSync.lstatSync(dir);
		return { dev: st.dev, ino: st.ino };
	} catch {
		return null;
	}
}

function sameDirIdentity(dir: string, identity: DirIdentity): boolean {
	try {
		const st = fsSync.lstatSync(dir);
		return !st.isSymbolicLink() && st.isDirectory() && st.dev === identity.dev && st.ino === identity.ino;
	} catch {
		return false;
	}
}

function storeIdentities(file: string): { parent: DirIdentity; dir: DirIdentity } | null {
	const dir = path.dirname(file);
	const parent = trustedDirIdentity(path.dirname(dir));
	const leaf = trustedDirIdentity(dir);
	if (!parent || !leaf) return null;
	return { parent, dir: leaf };
}

function storeIdentityHeld(file: string, ids: { parent: DirIdentity; dir: DirIdentity }): boolean {
	const dir = path.dirname(file);
	return sameDirIdentity(path.dirname(dir), ids.parent) && sameDirIdentity(dir, ids.dir);
}

export function recordFromText(text: string): OwnerSocketRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const row = parsed as Record<string, unknown>;
	if (typeof row.socketPath !== "string" || row.socketPath.length === 0 || row.socketPath.length > 200) return null;
	if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0) return null;
	if (typeof row.ownerId !== "string" || row.ownerId.length === 0 || row.ownerId.length > 200) return null;
	if (typeof row.leaseEpoch !== "number" || !Number.isInteger(row.leaseEpoch) || row.leaseEpoch < 0) return null;
	if (typeof row.nonce !== "string" || !/^[0-9a-f]{64}$/.test(row.nonce)) return null;
	return {
		socketPath: row.socketPath,
		pid: row.pid,
		ownerId: row.ownerId,
		leaseEpoch: row.leaseEpoch,
		nonce: row.nonce,
	};
}
function readOwnerSocketRecord(root: string, sessionId: string): OwnerSocketRecord | null {
	const file = ownerSocketRecordPath(root, sessionId);
	if (!file) return null;
	const ids = storeIdentities(file);
	if (!ids) return null;
	try {
		ownerSocketRecordAfterDirCheck?.();
	} catch {
		return null;
	}
	if (!storeIdentityHeld(file, ids)) return null;
	let fd: number | undefined;
	try {
		const flags = fsSync.constants.O_RDONLY | noFollowFlag() | (fsSync.constants.O_NONBLOCK ?? 0);
		fd = fsSync.openSync(file, flags);
		if (!storeIdentityHeld(file, ids)) return null;
		const st = fsSync.fstatSync(fd);
		if (!recordFileTrusted(st)) return null;
		if (st.size <= 0 || st.size > SOCKET_RECORD_MAX_BYTES) return null;
		const buf = Buffer.alloc(st.size);
		if (fsSync.readSync(fd, buf, 0, st.size, 0) !== st.size) return null;
		return recordFromText(buf.toString("utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				fsSync.closeSync(fd);
			} catch {
				/* The descriptor is already closed. */
			}
		}
	}
}

function writeOwnerSocketRecord(file: string, record: OwnerSocketRecord): void {
	const dir = path.dirname(file);
	if (!ensureTrustedDir(path.dirname(dir)) || !ensureTrustedDir(dir)) return;
	const ids = storeIdentities(file);
	if (!ids) return;
	try {
		ownerSocketRecordAfterDirCheck?.();
	} catch {
		return;
	}
	if (!storeIdentityHeld(file, ids)) return;
	const tmp = `${file}.tmp-${process.pid}`;
	const flags = fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY | noFollowFlag();
	let fd: number | undefined;
	let created = false;
	try {
		fd = fsSync.openSync(tmp, flags, 0o600);
		created = true;
		const st = fsSync.fstatSync(fd);
		if (!recordFileTrusted(st)) return;
		const body = JSON.stringify(record);
		if (Buffer.byteLength(body) > SOCKET_RECORD_MAX_BYTES) return;
		if (fsSync.writeSync(fd, body) !== Buffer.byteLength(body)) return;
		fsSync.closeSync(fd);
		fd = undefined;
		if (!storeIdentityHeld(file, ids)) return;
		fsSync.renameSync(tmp, file);
		created = false;
	} catch {
		return;
	} finally {
		if (fd !== undefined) {
			try {
				fsSync.closeSync(fd);
			} catch {
				/* The descriptor is already closed. */
			}
		}
		if (created) {
			try {
				fsSync.unlinkSync(tmp);
			} catch {
				/* The exclusive file is ours; a later publish skips a leftover. */
			}
		}
	}
}

function trustedOwnerSocket(
	root: string,
	sessionId: string,
	endpointPath: string,
	lease: SessionLease | null,
): string | null {
	try {
		const computed = controlSocketPathFor(root, sessionId);
		if (computed && ownerSocketPathsMatch(endpointPath, computed)) return computed;
	} catch {
		/* A matching record can still name the owner socket. */
	}
	if (!lease) return null;
	const noted = readOwnerSocketRecord(root, sessionId);
	if (!noted || !isOwnerAlive(noted.pid)) return null;
	if (noted.ownerId !== lease.ownerId || noted.leaseEpoch !== lease.leaseEpoch) return null;
	if (noted.nonce !== lease.leaseTokenHash) return null;
	if (!ownerSocketPathsMatch(endpointPath, noted.socketPath)) return null;
	return noted.socketPath;
}

/**
 * Path the CLI may dial for this lease endpoint.
 * Returns the private socket, never an unmatched lease string.
 * A missing file still returns that path so a manual owner stays addressable before listen.
 * A symlink or a non-socket does not. A record is used only when its lease identity matches.
 */
export function canonicalLeaseSocket(
	root: string,
	sessionId: string,
	endpointPath: string,
	lease: SessionLease | null = null,
): string | null {
	const canonical = trustedOwnerSocket(root, sessionId, endpointPath, lease);
	if (!canonical) return null;
	try {
		const stat = fsSync.lstatSync(canonical);
		if (stat.isSymbolicLink() || !stat.isSocket()) return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return canonical;
		return null;
	}
	return canonical;
}
async function withLeaseMutationLock<T>(root: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = leaseMutationLockPath(root, sessionId);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	try {
		return await withFileLock(lockPath, fn, {
			staleMs: 30_000,
			retries: 100,
			retryDelayMs: 20,
		});
	} catch (error) {
		if (isFileLockAcquireTimeout(error)) {
			throw new LeaseError(`lease_lock_timeout:${sessionId}`, "lease_lock_timeout");
		}
		throw error;
	}
}

export async function readLease(root: string, sessionId: string): Promise<SessionLease | null> {
	try {
		const raw = await fs.readFile(sessionPaths(root, sessionId).lease, "utf8");
		return JSON.parse(raw) as SessionLease;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Publish the socket record only while this identity still holds the lease. */
export async function publishOwnerSocketRecord(
	root: string,
	sessionId: string,
	socketPath: string,
	identity: OwnerSocketRecordIdentity,
): Promise<void> {
	try {
		await withLeaseMutationLock(root, sessionId, async () => {
			const lease = await readLease(root, sessionId);
			if (!lease || lease.pid !== process.pid) return;
			if (lease.ownerId !== identity.ownerId || lease.leaseEpoch !== identity.leaseEpoch) return;
			if (lease.leaseTokenHash !== identity.nonce) return;
			if (lease.endpoint?.kind !== "unix-socket") return;
			if (!ownerSocketPathsMatch(lease.endpoint.path, socketPath)) return;
			const file = ownerSocketRecordPath(root, sessionId);
			if (!file) return;
			writeOwnerSocketRecord(file, {
				socketPath,
				pid: lease.pid,
				ownerId: lease.ownerId,
				leaseEpoch: lease.leaseEpoch,
				nonce: identity.nonce,
			});
		});
	} catch {
		/* Same-directory routing does not need the record. */
	}
}

/** Remove the record only when it still names this lease identity. */
export async function clearOwnerSocketRecord(
	root: string,
	sessionId: string,
	identity: OwnerSocketRecordIdentity,
): Promise<void> {
	try {
		await withLeaseMutationLock(root, sessionId, async () => {
			const noted = readOwnerSocketRecord(root, sessionId);
			if (!noted) return;
			if (noted.ownerId !== identity.ownerId || noted.leaseEpoch !== identity.leaseEpoch) return;
			if (noted.nonce !== identity.nonce) return;
			const file = ownerSocketRecordPath(root, sessionId);
			if (!file) return;
			fsSync.unlinkSync(file);
		});
	} catch {
		/* An unreadable record is already ignored. */
	}
}

export function isExpired(lease: SessionLease, clock?: () => number): boolean {
	return Date.parse(lease.expiresAt) <= nowMs(clock);
}

function defaultPidStatusProbe(pid: number): PidStatus {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "eperm";
		return "dead";
	}
}

export function classifyLeaseStatus(
	lease: SessionLease | null,
	opts?: { clock?: () => number; probe?: (pid: number) => PidStatus },
): LeaseStatus {
	if (!lease) return "missing";
	const status = (opts?.probe ?? defaultPidStatusProbe)(lease.pid);
	if (status === "dead") return "dead";
	if (status === "eperm") return "epermAlive";
	return isExpired(lease, opts?.clock) ? "expiredAlive" : "live";
}

function classifyProbeFromBoolean(
	probe?: (pid: number) => boolean | PidStatus,
): ((pid: number) => PidStatus) | undefined {
	if (!probe) return undefined;
	return pid => {
		const status = probe(pid);
		return typeof status === "boolean" ? (status ? "alive" : "dead") : status;
	};
}

/** Liveness probe via signal 0. Defaults to the real process table; injectable for tests. */
export function isOwnerAlive(pid: number, probe?: (pid: number) => boolean): boolean {
	if (probe) return probe(pid);
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH = no such process; EPERM = exists but not ours (treat as alive).
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isStale(
	lease: SessionLease,
	opts?: { clock?: () => number; probe?: (pid: number) => boolean },
): boolean {
	return isExpired(lease, opts?.clock) || !isOwnerAlive(lease.pid, opts?.probe);
}

export interface AcquireOptions {
	ownerId: string;
	pid: number;
	endpoint?: SessionLease["endpoint"];
	eventsPath: string;
	ttlMs: number;
	clock?: () => number;
	probe?: (pid: number) => boolean | PidStatus;
}

export interface AcquiredLease {
	lease: SessionLease;
	token: string;
}

/**
 * Acquire (or take over a stale) lease. Fails closed with `lease_held` when another
 * owner is not dead. A missing socket record, or an endpoint outside the computed
 * socket, does not authorize replacement. Re-acquiring as the current owner refreshes.
 */
export async function acquireLease(root: string, sessionId: string, opts: AcquireOptions): Promise<AcquiredLease> {
	return await withLeaseMutationLock(root, sessionId, async () => {
		const existing = await readLease(root, sessionId);
		if (existing && existing.ownerId !== opts.ownerId) {
			const classifiedOwnerId = existing.ownerId;
			const classifiedEpoch = existing.leaseEpoch;
			const status = classifyLeaseStatus(existing, {
				clock: opts.clock,
				probe: classifyProbeFromBoolean(opts.probe),
			});
			if (status !== "dead") {
				throw new LeaseError(`lease_held:${sessionId}`, "lease_held");
			}
			const reread = await readLease(root, sessionId);
			if (!reread || reread.ownerId !== classifiedOwnerId || reread.leaseEpoch !== classifiedEpoch) {
				throw new LeaseError(`lease_held:${sessionId}`, "lease_held");
			}
		}
		const priorEpoch = existing?.leaseEpoch ?? 0;
		const epoch = existing && existing.ownerId === opts.ownerId ? priorEpoch : priorEpoch + 1;
		const token = randomBytes(16).toString("hex");
		const now = nowMs(opts.clock);
		const lease: SessionLease = {
			ownerId: opts.ownerId,
			sessionId,
			pid: opts.pid,
			leaseTokenHash: hashToken(token),
			endpoint: opts.endpoint ?? null,
			eventsPath: opts.eventsPath,
			heartbeatAt: new Date(now).toISOString(),
			expiresAt: new Date(now + opts.ttlMs).toISOString(),
			leaseEpoch: epoch,
			writer: { ownerId: opts.ownerId, leaseEpoch: epoch },
		};
		await writeLeaseAtomic(sessionPaths(root, sessionId).lease, lease);
		return { lease, token };
	});
}

/** Refresh the lease expiry. Only the recorded owner may heartbeat (single-writer). */
export async function heartbeat(
	root: string,
	sessionId: string,
	ownerId: string,
	ttlMs: number,
	clock?: () => number,
): Promise<SessionLease> {
	return await withLeaseMutationLock(root, sessionId, async () => {
		const lease = await readLease(root, sessionId);
		if (!lease) throw new LeaseError(`no_lease:${sessionId}`, "no_lease");
		if (lease.ownerId !== ownerId) throw new LeaseError(`not_lease_holder:${sessionId}`, "not_lease_holder");
		const now = nowMs(clock);
		const next: SessionLease = {
			...lease,
			heartbeatAt: new Date(now).toISOString(),
			expiresAt: new Date(now + ttlMs).toISOString(),
		};
		await writeLeaseAtomic(sessionPaths(root, sessionId).lease, next);
		return next;
	});
}

/** Whether `ownerId` is the live, unexpired single writer permitted to append events. */
export function canWriteEvents(lease: SessionLease, ownerId: string, clock?: () => number): boolean {
	return lease.ownerId === ownerId && !isExpired(lease, clock);
}

/** Release the lease (owner shutdown). Only the holder may release. */
export async function releaseLease(root: string, sessionId: string, ownerId: string): Promise<void> {
	await withLeaseMutationLock(root, sessionId, async () => {
		const lease = await readLease(root, sessionId);
		if (!lease) return;
		if (lease.ownerId !== ownerId) throw new LeaseError(`not_lease_holder:${sessionId}`, "not_lease_holder");
		await fs.rm(sessionPaths(root, sessionId).lease, { force: true });
	});
}

export async function reapDeadOwnerArtifacts(
	root: string,
	sessionId: string,
	expectedOwnerId: string,
	expectedEpoch: number,
	opts?: { clock?: () => number; probe?: (pid: number) => PidStatus },
): Promise<boolean> {
	return await withLeaseMutationLock(root, sessionId, async () => {
		const lease = await readLease(root, sessionId);
		if (!lease || lease.ownerId !== expectedOwnerId || lease.leaseEpoch !== expectedEpoch) return false;
		if (classifyLeaseStatus(lease, opts) !== "dead") return false;
		const paths = sessionPaths(root, sessionId);
		const endpointPath =
			lease.endpoint?.kind === "unix-socket" &&
			isOwnedUnixEndpointPath(root, sessionId, lease.endpoint.path, paths.controlSock)
				? lease.endpoint.path
				: null;
		await fs.rm(paths.controlSock, { force: true });
		if (endpointPath) await fs.rm(endpointPath, { force: true });
		await fs.rm(paths.lease, { force: true });
		return true;
	});
}
