import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface MemoryLockOptions {
	readonly staleMs?: number;
	readonly retries?: number;
	readonly retryDelayMs?: number;
}

export interface MemoryLockOwner {
	readonly pid: number;
	readonly startedAt: number;
	readonly host: string;
	readonly token: string;
	readonly relPath?: string;
}

export interface MemoryLockHandle {
	readonly relPath: string;
	readonly lockPath: string;
	readonly owner: MemoryLockOwner;
	release(): Promise<void>;
}

export class MemoryLockError extends Error {
	readonly code = "lock-conflict" as const;
	readonly exitCode = 12 as const;
	readonly relPath: string;

	constructor(relPath: string, detail: string) {
		super(detail);
		this.name = "MemoryLockError";
		this.relPath = relPath;
	}
}

// The retry budget bounds the total wait, not the contender count: a short poll
// interval keeps highly concurrent append fan-out (one lock per JSONL line)
// within the same overall window instead of serializing at 50 handoffs/second.
const DEFAULT_MEMORY_LOCK_OPTIONS: Required<MemoryLockOptions> = Object.freeze({
	staleMs: 30_000,
	retries: 4_000,
	retryDelayMs: 1,
});

const LOCAL_HOST = os.hostname();

interface LockDirectoryIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

type OwnerRead =
	| { readonly kind: "owner"; readonly owner: MemoryLockOwner }
	| { readonly kind: "invalid" }
	| { readonly kind: "missing" };

type ProcessLiveness = "alive" | "dead" | "unknown";

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

/** Compare root-relative paths by their normalized UTF-8 byte sequence. */
export function compareMemoryLockPaths(left: string, right: string): number {
	return compareUtf8(left, right);
}

/** Return a new array in the lock acquisition order required by M6. */
export function sortMemoryLockPaths(paths: readonly string[]): string[] {
	return [...paths].sort(compareMemoryLockPaths);
}

function normalizeRelPath(relPath: string): string {
	if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\u0000") || relPath.includes("\\")) {
		throw new MemoryLockError(String(relPath), "lock path is malformed");
	}
	const normalized = relPath.normalize("NFC");
	if (path.posix.isAbsolute(normalized)) throw new MemoryLockError(relPath, "lock path must be relative");
	const parts = normalized.split("/");
	if (parts.some(part => part.length === 0 || part === "." || part === "..")) {
		throw new MemoryLockError(relPath, "lock path contains an unsafe component");
	}
	return normalized;
}

function normalizeRootPath(rootPath: string, relPath: string): string {
	if (
		typeof rootPath !== "string" ||
		rootPath.length === 0 ||
		rootPath.includes("\u0000") ||
		!path.isAbsolute(rootPath)
	) {
		throw new MemoryLockError(relPath, "memory root must be an absolute path");
	}
	return path.resolve(rootPath);
}

function memoryPathDigest(relPath: string): string {
	return createHash("sha256").update(relPath, "utf8").digest("hex");
}

function pathLockFileName(relPath: string): string {
	return `target-${memoryPathDigest(relPath)}.lock`;
}

function namedLockFileName(name: string): string {
	return `${name}.lock`;
}

function normalizeLockName(name: string): string {
	if (
		typeof name !== "string" ||
		name.length === 0 ||
		name.includes("\u0000") ||
		name.includes("/") ||
		name.includes("\\")
	) {
		throw new MemoryLockError(String(name), "named lock is malformed");
	}
	return name.normalize("NFC");
}

export function memoryLockPath(rootPath: string, relPath: string): string {
	const normalized = normalizeRelPath(relPath);
	const root = normalizeRootPath(rootPath, normalized);
	return path.join(root, ".locks", pathLockFileName(normalized));
}

function lockIdentity(stats: Stats): LockDirectoryIdentity {
	return {
		dev: stats.dev,
		ino: stats.ino,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
	};
}

function sameLockIdentity(left: LockDirectoryIdentity, right: LockDirectoryIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function sameOwner(left: MemoryLockOwner, right: MemoryLockOwner): boolean {
	return (
		left.pid === right.pid &&
		left.startedAt === right.startedAt &&
		left.host === right.host &&
		left.token === right.token &&
		left.relPath === right.relPath
	);
}

function parseOwner(value: unknown): MemoryLockOwner | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const candidate = value as {
		readonly pid?: unknown;
		readonly startedAt?: unknown;
		readonly host?: unknown;
		readonly token?: unknown;
		readonly relPath?: unknown;
	};
	const startedAt =
		typeof candidate.startedAt === "number"
			? candidate.startedAt
			: typeof candidate.startedAt === "string"
				? Date.parse(candidate.startedAt)
				: Number.NaN;
	if (
		typeof candidate.pid !== "number" ||
		!Number.isSafeInteger(candidate.pid) ||
		candidate.pid <= 0 ||
		!Number.isFinite(startedAt) ||
		startedAt < 0 ||
		typeof candidate.host !== "string" ||
		candidate.host.length === 0 ||
		typeof candidate.token !== "string" ||
		candidate.token.length === 0 ||
		(candidate.relPath !== undefined && typeof candidate.relPath !== "string")
	) {
		return null;
	}
	return {
		pid: candidate.pid,
		startedAt,
		host: candidate.host,
		token: candidate.token,
		...(candidate.relPath === undefined ? {} : { relPath: candidate.relPath }),
	};
}

async function readOwner(lockPath: string): Promise<OwnerRead> {
	try {
		const raw = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
		try {
			const parsed: unknown = JSON.parse(raw);
			const owner = parseOwner(parsed);
			return owner === null ? { kind: "invalid" } : { kind: "owner", owner };
		} catch {
			return { kind: "invalid" };
		}
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "invalid" };
	}
}

function processLiveness(pid: number): ProcessLiveness {
	if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

async function ensureLockRoot(rootPath: string, relPath: string): Promise<string> {
	let rootStats: Stats;
	try {
		rootStats = await fs.lstat(rootPath);
	} catch (error) {
		throw new MemoryLockError(relPath, `memory root is unavailable: ${errorCode(error) ?? "read-failed"}`);
	}
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
		throw new MemoryLockError(relPath, "memory root is not a directory");

	const lockRoot = path.join(rootPath, ".locks");
	try {
		const stats = await fs.lstat(lockRoot);
		if (!stats.isDirectory() || stats.isSymbolicLink())
			throw new MemoryLockError(relPath, "lock root is not a directory");
	} catch (error) {
		if (error instanceof MemoryLockError) throw error;
		if (errorCode(error) !== "ENOENT") throw new MemoryLockError(relPath, "lock root is unreadable");
		try {
			await fs.mkdir(lockRoot, { mode: 0o700 });
			await fs.chmod(lockRoot, 0o700);
		} catch (mkdirError) {
			if (errorCode(mkdirError) !== "EEXIST") throw new MemoryLockError(relPath, "lock root cannot be created");
		}
	}
	return lockRoot;
}

function ownerRecord(errorRelPath: string, ownerRelPath: string | undefined): MemoryLockOwner {
	const owner: MemoryLockOwner = {
		pid: process.pid,
		startedAt: Date.now(),
		host: LOCAL_HOST,
		token: randomUUID(),
		...(ownerRelPath === undefined ? {} : { relPath: ownerRelPath }),
	};
	if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
		throw new MemoryLockError(errorRelPath, "process identity is invalid");
	return owner;
}

async function writeOwner(lockPath: string, relPath: string, owner: MemoryLockOwner): Promise<void> {
	const ownerPath = path.join(lockPath, "owner.json");
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(ownerPath, "wx", 0o600);
		const bytes = Buffer.from(JSON.stringify(owner), "utf8");
		const result = await handle.write(bytes, 0, bytes.byteLength, null);
		if (result.bytesWritten !== bytes.byteLength) throw new Error("short lock-owner write");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
	} catch (error) {
		if (handle !== undefined) await handle.close().catch(() => undefined);
		throw new MemoryLockError(relPath, `lock owner record failed: ${errorCode(error) ?? "write-failed"}`);
	}
}

async function lockStats(
	lockPath: string,
): Promise<{ readonly identity: LockDirectoryIdentity; readonly ageMs: number } | null> {
	try {
		const stats = await fs.stat(lockPath);
		return { identity: lockIdentity(stats), ageMs: Math.max(0, Date.now() - stats.mtimeMs) };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

async function removeStaleLock(
	lockPath: string,
	snapshot: { readonly identity: LockDirectoryIdentity; readonly owner: MemoryLockOwner | null },
): Promise<boolean> {
	const current = await lockStats(lockPath);
	if (current === null || !sameLockIdentity(current.identity, snapshot.identity)) return false;
	const currentOwner = await readOwner(lockPath);
	if (snapshot.owner === null) {
		if (currentOwner.kind === "owner") return false;
	} else if (currentOwner.kind !== "owner" || !sameOwner(currentOwner.owner, snapshot.owner)) {
		return false;
	}
	try {
		await fs.rm(lockPath, { recursive: true, force: false });
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

type StaleLockSnapshot =
	| { readonly stale: false }
	| { readonly stale: true; readonly identity: LockDirectoryIdentity; readonly owner: MemoryLockOwner | null };

async function staleLockSnapshot(lockPath: string, staleMs: number, relPath: string): Promise<StaleLockSnapshot> {
	const stats = await lockStats(lockPath);
	if (stats === null) return { stale: false };
	const ownerResult = await readOwner(lockPath);
	if (ownerResult.kind === "owner") {
		const owner = ownerResult.owner;
		if (owner.relPath !== undefined && owner.relPath !== relPath) {
			throw new MemoryLockError(relPath, "lock filename collision cannot be verified");
		}
		const liveness = owner.host === LOCAL_HOST ? processLiveness(owner.pid) : "unknown";
		if (liveness === "alive") return { stale: false };
		if (liveness === "dead" || Date.now() - owner.startedAt > staleMs) {
			return { stale: true, identity: stats.identity, owner };
		}
		return { stale: false };
	}
	if (stats.ageMs > staleMs) return { stale: true, identity: stats.identity, owner: null };
	if (ownerResult.kind === "invalid") return { stale: false };
	if (ownerResult.kind === "missing") return { stale: false };
	throw new MemoryLockError(relPath, "lock owner state is indeterminate");
}

function lockOptions(options: MemoryLockOptions | undefined, relPath: string): Required<MemoryLockOptions> {
	const resolved: Required<MemoryLockOptions> = {
		staleMs: options?.staleMs ?? DEFAULT_MEMORY_LOCK_OPTIONS.staleMs,
		retries: options?.retries ?? DEFAULT_MEMORY_LOCK_OPTIONS.retries,
		retryDelayMs: options?.retryDelayMs ?? DEFAULT_MEMORY_LOCK_OPTIONS.retryDelayMs,
	};
	if (
		!Number.isFinite(resolved.staleMs) ||
		resolved.staleMs < 0 ||
		!Number.isInteger(resolved.retries) ||
		resolved.retries <= 0 ||
		!Number.isFinite(resolved.retryDelayMs) ||
		resolved.retryDelayMs < 0
	) {
		throw new MemoryLockError(relPath, "lock options are invalid");
	}
	return resolved;
}

async function cleanupUnownedLock(lockPath: string): Promise<void> {
	await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
}

async function acquireLock(
	lockPath: string,

	handleRelPath: string,
	ownerRelPath: string | undefined,
	options: MemoryLockOptions | undefined,
): Promise<MemoryLockHandle> {
	const resolvedOptions = lockOptions(options, handleRelPath);
	for (let attempt = 0; attempt < resolvedOptions.retries; attempt += 1) {
		const owner = ownerRecord(handleRelPath, ownerRelPath);
		try {
			await fs.mkdir(lockPath, { mode: 0o700 });
			try {
				await fs.chmod(lockPath, 0o700);
				await writeOwner(lockPath, handleRelPath, owner);
			} catch (error) {
				await cleanupUnownedLock(lockPath);
				throw error;
			}

			let released = false;
			return {
				relPath: handleRelPath,
				lockPath,
				owner,
				release: async () => {
					if (released) throw new MemoryLockError(handleRelPath, "lock was already released");
					const current = await readOwner(lockPath);
					if (current.kind !== "owner" || !sameOwner(current.owner, owner)) {
						throw new MemoryLockError(handleRelPath, "lock ownership changed before release");
					}
					try {
						await fs.rm(lockPath, { recursive: true, force: false });
						released = true;
					} catch (error) {
						throw new MemoryLockError(
							handleRelPath,
							`lock release failed: ${errorCode(error) ?? "remove-failed"}`,
						);
					}
				},
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				if (error instanceof MemoryLockError) throw error;
				throw new MemoryLockError(handleRelPath, `lock acquisition failed: ${errorCode(error) ?? "mkdir-failed"}`);
			}
			let stale: StaleLockSnapshot;
			try {
				stale = await staleLockSnapshot(lockPath, resolvedOptions.staleMs, handleRelPath);
			} catch (staleError) {
				if (staleError instanceof MemoryLockError) throw staleError;
				throw new MemoryLockError(
					handleRelPath,
					`lock state cannot be verified: ${errorCode(staleError) ?? "read-failed"}`,
				);
			}
			if (stale.stale) {
				try {
					if (await removeStaleLock(lockPath, stale)) continue;
				} catch (removeError) {
					throw new MemoryLockError(
						handleRelPath,
						`stale lock cannot be reclaimed: ${errorCode(removeError) ?? "remove-failed"}`,
					);
				}
			}
			if (attempt + 1 < resolvedOptions.retries) await Bun.sleep(resolvedOptions.retryDelayMs);
		}
	}
	throw new MemoryLockError(handleRelPath, `lock acquisition exhausted after ${resolvedOptions.retries} attempts`);
}

/** Acquire a lock named under `<memoryRoot>/.locks`. */
export async function acquireNamedLock(
	rootPath: string,
	name: string,
	options?: MemoryLockOptions,
): Promise<MemoryLockHandle> {
	const normalizedName = normalizeLockName(name);
	const root = normalizeRootPath(rootPath, normalizedName);
	const lockRoot = await ensureLockRoot(root, normalizedName);
	return acquireLock(path.join(lockRoot, namedLockFileName(normalizedName)), normalizedName, undefined, options);
}

/** Acquire a lock for a root-relative path under the central lock directory. */
export async function acquirePathLock(
	rootPath: string,
	relPath: string,
	options?: MemoryLockOptions,
): Promise<MemoryLockHandle> {
	const normalizedRelPath = normalizeRelPath(relPath);
	const root = normalizeRootPath(rootPath, normalizedRelPath);
	const lockRoot = await ensureLockRoot(root, normalizedRelPath);
	return acquireLock(
		path.join(lockRoot, pathLockFileName(normalizedRelPath)),
		normalizedRelPath,
		normalizedRelPath,
		options,
	);
}

async function withAcquiredLock<T>(acquire: () => Promise<MemoryLockHandle>, operation: () => Promise<T>): Promise<T> {
	const handle = await acquire();
	const outcome = await Promise.resolve()
		.then(operation)
		.then(
			value => ({ ok: true as const, value }),
			error => ({ ok: false as const, error }),
		);
	try {
		await handle.release();
	} catch (releaseError) {
		if (!outcome.ok)
			throw new AggregateError([outcome.error, releaseError], "memory lock operation and release both failed");
		throw releaseError;
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

/** Run an asynchronous operation while holding a root-relative path lock. */
export async function withPathLock<T>(
	rootPath: string,
	relPath: string,
	operation: () => Promise<T>,
	options?: MemoryLockOptions,
): Promise<T> {
	return withAcquiredLock(() => acquirePathLock(rootPath, relPath, options), operation);
}

/** Backwards-compatible internal alias for path locks. */
export async function withMemoryLock<T>(
	rootPath: string,
	relPath: string,
	operation: () => Promise<T>,
	options?: MemoryLockOptions,
): Promise<T> {
	return withPathLock(rootPath, relPath, operation, options);
}

/** Run an asynchronous write operation while holding the apply lock and path locks in fixed order. */
export async function withMemoryWriteLocks<T>(
	root: string,
	relPaths: readonly string[],
	operation: () => Promise<T>,
): Promise<T> {
	let applyLock: MemoryLockHandle | undefined;
	const pathLocks: MemoryLockHandle[] = [];
	try {
		applyLock = await acquireNamedLock(root, "apply");
		for (const relPath of sortMemoryLockPaths(relPaths)) pathLocks.push(await acquirePathLock(root, relPath));
		return await operation();
	} finally {
		for (let index = pathLocks.length - 1; index >= 0; index -= 1) await pathLocks[index]?.release();
		if (applyLock !== undefined) await applyLock.release();
	}
}
