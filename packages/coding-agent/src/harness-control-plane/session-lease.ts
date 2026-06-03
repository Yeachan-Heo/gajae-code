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
import { sessionPaths } from "./storage";

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
	probe?: (pid: number) => boolean;
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
	const existing = await readLease(root, sessionId);
	if (existing && existing.ownerId !== opts.ownerId && !isStale(existing, opts)) {
		throw new LeaseError(`lease_held:${sessionId}`, "lease_held");
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
}

/** Refresh the lease expiry. Only the recorded owner may heartbeat (single-writer). */
export async function heartbeat(
	root: string,
	sessionId: string,
	ownerId: string,
	ttlMs: number,
	clock?: () => number,
): Promise<SessionLease> {
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
}

/** Whether `ownerId` is the live, unexpired single writer permitted to append events. */
export function canWriteEvents(lease: SessionLease, ownerId: string, clock?: () => number): boolean {
	return lease.ownerId === ownerId && !isExpired(lease, clock);
}

/** Release the lease (owner shutdown). Only the holder may release. */
export async function releaseLease(root: string, sessionId: string, ownerId: string): Promise<void> {
	const lease = await readLease(root, sessionId);
	if (!lease) return;
	if (lease.ownerId !== ownerId) throw new LeaseError(`not_lease_holder:${sessionId}`, "not_lease_holder");
	await fs.rm(sessionPaths(root, sessionId).lease, { force: true });
}
