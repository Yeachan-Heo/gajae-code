/**
 * SessionLease — the construct that makes live control honest without a global daemon.
 *
 * Exactly one live `RuntimeOwner` holds the lease for a session; only the lease holder
 * may append events or run the default router. A stale lease (owner dead OR expired) may
 * be taken over, incrementing `leaseEpoch`, but a stale lease is NEVER permission for
 * destructive recovery (that gate lives in the classifier/recovery layer).
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { controlSocketPath, sessionPaths } from "./storage";

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
const LEASE_LOCK_RETRIES = 100;
const LEASE_LOCK_RETRY_DELAY_MS = 20;
const LEASE_LOCK_FILE_SUFFIX = ".json";

interface LeaseLockInfo {
	pid: number;
	token: string;
}

function leaseMutationLockPath(root: string, sessionId: string): string {
	return `${sessionPaths(root, sessionId).lease}.lock`;
}

function leaseMutationLockFile(lockPath: string, token: string): string {
	return path.join(lockPath, `${token}${LEASE_LOCK_FILE_SUFFIX}`);
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

function isPathExistsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR";
}

function isIgnorableLockDirRemoveError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST";
}

async function removeEmptyLockDir(lockPath: string): Promise<void> {
	try {
		await fs.rmdir(lockPath);
	} catch (error) {
		if (!isIgnorableLockDirRemoveError(error)) throw error;
	}
}

function parseLeaseLockInfo(raw: string): LeaseLockInfo | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const info = parsed as Record<string, unknown>;
		return typeof info.pid === "number" && typeof info.token === "string"
			? { pid: info.pid, token: info.token }
			: null;
	} catch {
		return null;
	}
}

async function readLeaseLockInfo(lockFile: string): Promise<LeaseLockInfo | null> {
	try {
		return parseLeaseLockInfo(await fs.readFile(lockFile, "utf8"));
	} catch {
		return null;
	}
}

async function createLeaseMutationLock(lockPath: string, info: LeaseLockInfo): Promise<boolean> {
	const tmpPath = `${lockPath}.tmp-${info.token}`;
	await fs.rm(tmpPath, { recursive: true, force: true });
	await fs.mkdir(tmpPath, { mode: 0o700 });
	try {
		await fs.writeFile(leaseMutationLockFile(tmpPath, info.token), `${JSON.stringify(info)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(tmpPath, lockPath);
		return true;
	} catch (error) {
		await fs.rm(tmpPath, { recursive: true, force: true });
		if (isPathExistsError(error)) return false;
		throw error;
	}
}

async function recoverLegacyStaleLeaseLock(lockPath: string): Promise<void> {
	const info = await readLeaseLockInfo(lockPath);
	if (!info || defaultPidStatusProbe(info.pid) !== "dead") return;
	try {
		await fs.unlink(lockPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "EISDIR") throw error;
	}
}

async function recoverStaleLeaseMutationLock(lockPath: string): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(lockPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return;
		if (code === "ENOTDIR") {
			await recoverLegacyStaleLeaseLock(lockPath);
			return;
		}
		throw error;
	}
	const lockFiles = entries.filter(entry => entry.endsWith(LEASE_LOCK_FILE_SUFFIX));
	if (lockFiles.length === 0) {
		await removeEmptyLockDir(lockPath);
		return;
	}
	if (lockFiles.length !== 1) return;
	const lockFile = lockFiles[0];
	const info = await readLeaseLockInfo(path.join(lockPath, lockFile));
	if (!info || lockFile !== `${info.token}${LEASE_LOCK_FILE_SUFFIX}`) return;
	if (defaultPidStatusProbe(info.pid) !== "dead") return;
	// Delete only the stale owner's token-named file; a fresh lock uses a different file name.
	await fs.rm(path.join(lockPath, lockFile), { force: true });
	await removeEmptyLockDir(lockPath);
}

async function releaseLeaseMutationLock(lockPath: string, token: string): Promise<void> {
	await fs.rm(leaseMutationLockFile(lockPath, token), { force: true });
	await removeEmptyLockDir(lockPath);
}

async function acquireLeaseMutationLock(root: string, sessionId: string): Promise<() => Promise<void>> {
	const lockPath = leaseMutationLockPath(root, sessionId);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < LEASE_LOCK_RETRIES; attempt++) {
		const token = randomBytes(16).toString("hex");
		const info: LeaseLockInfo = { pid: process.pid, token };
		if (await createLeaseMutationLock(lockPath, info)) return () => releaseLeaseMutationLock(lockPath, token);
		await recoverStaleLeaseMutationLock(lockPath);
		await Bun.sleep(LEASE_LOCK_RETRY_DELAY_MS);
	}
	throw new LeaseError(`lease_lock_timeout:${sessionId}`, "lease_lock_timeout");
}

async function withLeaseMutationLock<T>(root: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
	const release = await acquireLeaseMutationLock(root, sessionId);
	try {
		return await fn();
	} finally {
		await release();
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
 * Acquire (or take over a stale) lease. Fails closed with `lease_held` when a live,
 * unexpired lease is held by a different owner. Re-acquiring as the current owner refreshes.
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
