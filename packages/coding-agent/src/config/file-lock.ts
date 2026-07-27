import * as asyncHooks from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils/fs-error";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

/** Owner identity stamped into a `<file>.lock/info` record. */
export interface FileLockOwnerToken {
	pid: number;
	incarnation?: string;
	owner_id?: string;

	/** Legacy lock metadata; new locks use `incarnation`. */
	start_time?: string;
	timestamp: number;
}

type LockInfo = FileLockOwnerToken & { incarnation: string; owner_id: string };
type OwnerLiveness = "alive" | "dead" | "unknown";
type FileLockProcessObservation = { state: "live"; incarnation: string } | { state: "dead" } | { state: "unknown" };
type FileLockProcessObserver = (pid: number) => FileLockProcessObservation;

type LockInfoRead = { kind: "owner"; owner: FileLockOwnerToken } | { kind: "missing" } | { kind: "invalid" };

/**
 * Returns the OS-provided process start timestamp for compatibility with callers
 * that used the prior Unix-only PID-reuse helper. File lock ownership uses
 * `processIncarnation` instead.
 */
export function processStartTime(pid: number): string | null {
	try {
		const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return null;
		const startTime = new TextDecoder().decode(result.stdout).trim();
		return startTime || null;
	} catch {
		return null;
	}
}

function windowsProcessIncarnation(pid: number): string | null {
	try {
		const command = [
			`$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'`,
			"if ($null -ne $process) {",
			"$process.CreationDate.ToUniversalTime().Ticks",
			"}",
		].join(" ");
		const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return null;
		const creationTicks = new TextDecoder().decode(result.stdout).trim();
		return /^\d+$/.test(creationTicks) ? `windows:${creationTicks}` : null;
	} catch {
		return null;
	}
}

function processIncarnation(pid: number): string | null {
	if (process.platform === "win32") return windowsProcessIncarnation(pid);
	const startTime = processStartTime(pid);
	return startTime ? `unix:${startTime}` : null;
}

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

function observeProcess(pid: number): FileLockProcessObservation {
	const liveness = ownerLiveness(pid);
	if (liveness === "dead") return { state: "dead" };
	if (liveness === "unknown") return { state: "unknown" };
	const incarnation = processIncarnation(pid);
	return incarnation ? { state: "live", incarnation } : { state: "unknown" };
}

const processObserverContext = new asyncHooks.AsyncLocalStorage<FileLockProcessObserver>();
const ownProcessIncarnations = new WeakMap<FileLockProcessObserver, string>();

/** @internal Test-only process probe override. */
export function __setFileLockProcessObserverForTests(observer: FileLockProcessObserver | undefined): void {
	processObserverContext.enterWith(observer ?? observeProcess);
}

const activeProcessObserver = (): FileLockProcessObserver => processObserverContext.getStore() ?? observeProcess;

function isCanonicalLockOwner(owner: FileLockOwnerToken): owner is LockInfo {
	return (
		typeof owner.incarnation === "string" &&
		!!owner.incarnation &&
		typeof owner.owner_id === "string" &&
		!!owner.owner_id
	);
}

function currentProcessIncarnation(): string {
	const observer = activeProcessObserver();
	const cached = ownProcessIncarnations.get(observer);
	if (cached !== undefined) return cached;
	const observation = observer(process.pid);
	if (observation.state === "live") {
		ownProcessIncarnations.set(observer, observation.incarnation);
		return observation.incarnation;
	}
	const fallback = `fallback:${randomUUID()}`;
	ownProcessIncarnations.set(observer, fallback);
	return fallback;
}

async function writeLockInfo(lockPath: string): Promise<LockInfo> {
	const info: LockInfo = {
		pid: process.pid,
		incarnation: currentProcessIncarnation(),
		owner_id: randomUUID(),
		timestamp: Date.now(),
	};
	await Bun.write(`${lockPath}/info`, JSON.stringify(info));
	return info;
}

function parseLockInfo(parsed: unknown): FileLockOwnerToken | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { pid, incarnation, owner_id, start_time, timestamp } = parsed as Partial<FileLockOwnerToken>;
	if (
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		(incarnation !== undefined && (typeof incarnation !== "string" || !incarnation)) ||
		(owner_id !== undefined && (typeof owner_id !== "string" || !owner_id)) ||
		(start_time !== undefined && (typeof start_time !== "string" || !start_time))
	)
		return null;
	return { pid, incarnation, owner_id, start_time, timestamp };
}

async function readLockInfoState(lockPath: string): Promise<LockInfoRead> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(`${lockPath}/info`, "utf-8"));
	} catch (error) {
		if (isEnoent(error)) return { kind: "missing" };
		if (error instanceof SyntaxError) return { kind: "invalid" };
		throw error;
	}
	const owner = parseLockInfo(parsed);
	return owner ? { kind: "owner", owner } : { kind: "invalid" };
}

async function readLockInfo(lockPath: string): Promise<FileLockOwnerToken | null> {
	const result = await readLockInfoState(lockPath);
	return result.kind === "owner" ? result.owner : null;
}

/** @internal */
export async function readFileLockInfoForGc(lockDir: string): Promise<FileLockOwnerToken | null> {
	return await readLockInfo(lockDir);
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
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

function sameOwnerIdentity(current: FileLockOwnerToken, expected: FileLockOwnerToken): boolean {
	if (isCanonicalLockOwner(current) && isCanonicalLockOwner(expected)) {
		return (
			current.owner_id === expected.owner_id &&
			current.pid === expected.pid &&
			current.incarnation === expected.incarnation
		);
	}

	// Keep the public GC helper usable for legacy records. Lock acquire/release
	// never reaches this branch: legacy metadata is deliberately fail-closed.
	return (
		!isCanonicalLockOwner(current) &&
		!isCanonicalLockOwner(expected) &&
		current.pid === expected.pid &&
		current.timestamp === expected.timestamp &&
		(expected.start_time === undefined || current.start_time === expected.start_time)
	);
}

function observationProvesOwnerStale(owner: LockInfo, observation: FileLockProcessObservation): boolean {
	if (observation.state === "dead") return true;
	return (
		observation.state === "live" &&
		!owner.incarnation.startsWith("fallback:") &&
		observation.incarnation !== owner.incarnation
	);
}

async function reclaimStaleRemovalGuard(guardPath: string, expected: LockInfo): Promise<boolean> {
	const reapingPath = `${guardPath}.reaping`;
	try {
		await fs.link(guardPath, reapingPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		if (code !== "EEXIST") throw error;
		let existingReaper: FileLockOwnerToken | null;
		try {
			existingReaper = parseLockInfo(JSON.parse(await fs.readFile(reapingPath, "utf8")));
		} catch {
			return false;
		}
		if (
			!existingReaper ||
			!isCanonicalLockOwner(existingReaper) ||
			!observationProvesOwnerStale(existingReaper, activeProcessObserver()(existingReaper.pid))
		) {
			return false;
		}
		await fs.rm(reapingPath, { force: true });
		try {
			await fs.link(guardPath, reapingPath);
		} catch (retryError) {
			if ((retryError as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw retryError;
		}
	}
	let reclaimed = false;
	let operationError: unknown;
	try {
		const reapingOwner = parseLockInfo(JSON.parse(await fs.readFile(reapingPath, "utf8")));
		if (reapingOwner && sameOwnerIdentity(reapingOwner, expected)) {
			const [guardStat, reapingStat] = await Promise.all([fs.stat(guardPath), fs.stat(reapingPath)]);
			if (guardStat.dev === reapingStat.dev && guardStat.ino === reapingStat.ino) {
				await fs.rm(guardPath, { force: true });
				reclaimed = true;
			}
		}
	} catch (error) {
		if (!isEnoent(error)) operationError = error;
	}
	let cleanupError: unknown;
	try {
		const current = parseLockInfo(JSON.parse(await fs.readFile(reapingPath, "utf8")));
		if (current && sameOwnerIdentity(current, expected)) await fs.rm(reapingPath, { force: true });
	} catch (error) {
		if (!isEnoent(error)) cleanupError = error;
	}
	if (operationError && cleanupError) {
		throw new AggregateError([operationError, cleanupError], "Removal guard recovery and cleanup both failed");
	}
	if (operationError) throw operationError;
	if (cleanupError) throw cleanupError;
	return reclaimed;
}

async function tryAcquireRemovalGuard(lockDir: string): Promise<LockInfo | null> {
	const guardPath = `${lockDir}.remove`;
	const owner: LockInfo = {
		pid: process.pid,
		incarnation: currentProcessIncarnation(),
		owner_id: randomUUID(),
		timestamp: Date.now(),
	};
	const candidatePath = `${guardPath}.${owner.owner_id}.candidate`;
	try {
		await Bun.write(candidatePath, JSON.stringify(owner));
		await fs.link(candidatePath, guardPath);
	} catch (error) {
		await fs.rm(candidatePath, { force: true });
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let existing: FileLockOwnerToken | null;
		try {
			existing = parseLockInfo(JSON.parse(await fs.readFile(guardPath, "utf8")));
		} catch {
			return null;
		}
		if (
			!existing ||
			!isCanonicalLockOwner(existing) ||
			!observationProvesOwnerStale(existing, activeProcessObserver()(existing.pid)) ||
			!(await reclaimStaleRemovalGuard(guardPath, existing))
		) {
			return null;
		}
		return tryAcquireRemovalGuard(lockDir);
	}
	await fs.rm(candidatePath, { force: true });
	return owner;
}

async function releaseRemovalGuard(lockDir: string, expected: LockInfo): Promise<void> {
	const guardPath = `${lockDir}.remove`;
	try {
		const current = parseLockInfo(JSON.parse(await fs.readFile(guardPath, "utf8")));
		if (current && sameOwnerIdentity(current, expected)) await fs.rm(guardPath, { force: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function removeFileLockDirByStatForGc(lockDir: string, expected: LockDirStatToken): Promise<boolean> {
	const guard = await tryAcquireRemovalGuard(lockDir);
	if (!guard) return false;
	try {
		const currentInfo = await readLockInfoState(lockDir);
		if (currentInfo.kind !== "missing") return false;
		const currentStats = await fs.stat(lockDir);
		if (!sameStatToken(statToken(currentStats), expected)) return false;
		await fs.rm(lockDir, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	} finally {
		await releaseRemovalGuard(lockDir, guard);
	}
}

/**
 * @internal
 * Fail-closed removal of a lock dir whose owner is expected to be dead or
 * finished. Re-reads the owner token as close to unlink as possible and only
 * deletes when it still has the expected canonical owner identity.
 */
export async function removeFileLockDirForGc(
	lockDir: string,
	expected: FileLockOwnerToken,
): Promise<FileLockGcRemoval> {
	const guard = await tryAcquireRemovalGuard(lockDir);
	if (!guard) return "owner_changed";
	try {
		const current = await readLockInfo(lockDir);
		if (!current) return "missing";
		if (!sameOwnerIdentity(current, expected)) return "owner_changed";
		await fs.rm(lockDir, { recursive: true, force: true });
		return "removed";
	} finally {
		await releaseRemovalGuard(lockDir, guard);
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

async function staleLockSnapshot(lockPath: string, staleMs: number): Promise<LockStaleSnapshot> {
	const result = await readLockInfoState(lockPath);
	if (result.kind === "invalid") return { stale: false };
	if (result.kind === "missing") {
		try {
			const stats = await fs.stat(lockPath);
			if (Date.now() - stats.mtimeMs <= staleMs) return { stale: false };
			return { stale: true, owner: null, stat: statToken(stats) };
		} catch (error) {
			if (isEnoent(error)) return { stale: false };
			throw error;
		}
	}

	if (!isCanonicalLockOwner(result.owner)) {
		// A bare pid/timestamp record is malformed for lock acquisition and must
		// remain protected. Retain dead-owner cleanup only for the prior
		// pid/start_time format so existing GC-era locks do not become permanent.
		if (result.owner.start_time && activeProcessObserver()(result.owner.pid).state === "dead") {
			return { stale: true, owner: result.owner };
		}
		return { stale: false };
	}

	const observation = activeProcessObserver()(result.owner.pid);
	if (observationProvesOwnerStale(result.owner, observation)) {
		return { stale: true, owner: result.owner };
	}

	// A matching canonical process and an indeterminate process observation both
	// remain protected indefinitely. Elapsed time cannot prove either is stale.
	return { stale: false };
}

async function removeStaleLockForAcquire(lockPath: string, snapshot: LockStaleSnapshot): Promise<boolean> {
	if (!snapshot.stale) return false;
	if (snapshot.owner) return (await removeFileLockDirForGc(lockPath, snapshot.owner)) === "removed";
	return removeFileLockDirByStatForGc(lockPath, snapshot.stat);
}

async function tryAcquireLock(lockPath: string): Promise<LockInfo | null> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	try {
		await fs.mkdir(lockPath);
		try {
			return await writeLockInfo(lockPath);
		} catch (error) {
			await fs.rm(lockPath, { recursive: true, force: true });
			throw error;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw error;
	}
}

async function releaseLock(lockPath: string, owner: LockInfo): Promise<void> {
	const outcome = await removeFileLockDirForGc(lockPath, owner);
	if (outcome !== "removed") throw new Error(`Failed to release file lock: ${outcome}.`);
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		const owner = await tryAcquireLock(lockPath);
		if (owner) return () => releaseLock(lockPath, owner);

		const stale = await staleLockSnapshot(lockPath, opts.staleMs);
		if (await removeStaleLockForAcquire(lockPath, stale)) {
			// Reclaiming a dead/reused lock must be followed by an immediate acquire
			// attempt, even with `retries: 0`; cleanup is not a failed contention try.
			const reclaimedOwner = await tryAcquireLock(lockPath);
			if (reclaimedOwner) return () => releaseLock(lockPath, reclaimedOwner);
		}
		if (attempt < opts.retries) await Bun.sleep(opts.retryDelayMs);
	}
	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
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
