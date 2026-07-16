import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { applyOwnerOnlyPathSecurity, renameNoReplacePath, verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";

export const MANAGED_ARTIFACT_MAX_DEPTH = 32;
export const MANAGED_ARTIFACT_MAX_FILES = 10_000;
export const MANAGED_ARTIFACT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MANAGED_ARTIFACT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LOCK_LEASE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

const LOCK_STALE_RECHECK_MS = 100;

export type ManagedStorageFailure =
	| "migration_busy"
	| "binding_conflict"
	| "binding_invalid"
	| "destination_conflict"
	| "source_changed"
	| "unsafe_artifacts"
	| "durability_failed"
	| "migration_retired"
	| "managed_storage_unsupported";

export interface ManagedStorageLock {
	path: string;
	attemptId: string;
	assertOwned(): void;
	release(): Promise<void>;
}

export interface ManagedFileSnapshot {
	bytes: Buffer;
	identity: { dev: bigint; ino: bigint; size: number; mtimeNs: bigint };
}

type NativeSecurity = { ok: true } | { ok: false; code: string };
type LockRecord = {
	attemptId: string;
	pid: number;
	bootId?: string;
	processStartId: string;
	createdAt: number;
	heartbeatAt: number;
	leaseExpiresAt: number;
};

const PROCESS_START_ID = randomUUID();

function securityError(pathname: string, result: NativeSecurity): Error {
	return new Error(
		result.ok
			? `Unexpected security state for ${pathname}`
			: `Owner-only security rejected ${pathname}: ${result.code}`,
	);
}

function secure(pathname: string, kind: "directory" | "file"): void {
	const applied = applyOwnerOnlyPathSecurity(pathname, kind) as NativeSecurity;
	if (!applied.ok) throw securityError(pathname, applied);
	const verified = verifyOwnerOnlyPathSecurity(pathname, kind) as NativeSecurity;
	if (!verified.ok) throw securityError(pathname, verified);
}

function assertSafeDirectory(pathname: string): void {
	const stat = fs.lstatSync(pathname);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${pathname}`);
}

export function shouldFsyncManagedDirectory(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

function fsyncDirectory(pathname: string): void {
	if (!shouldFsyncManagedDirectory()) return;
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function bootId(): string | undefined {
	try {
		return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return undefined;
	}
}

function identity(stat: fs.BigIntStats): ManagedFileSnapshot["identity"] {
	return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs };
}

function sameIdentity(left: ManagedFileSnapshot["identity"], right: ManagedFileSnapshot["identity"]): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
	);
}

function parseLock(pathname: string): LockRecord | undefined {
	try {
		const stat = fs.lstatSync(pathname);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		const value: unknown = JSON.parse(fs.readFileSync(pathname, "utf8"));
		if (!value || typeof value !== "object") return undefined;
		const record = value as Partial<LockRecord>;
		return typeof record.attemptId === "string" &&
			typeof record.pid === "number" &&
			typeof record.processStartId === "string" &&
			typeof record.leaseExpiresAt === "number" &&
			typeof record.heartbeatAt === "number" &&
			typeof record.createdAt === "number"
			? (record as LockRecord)
			: undefined;
	} catch {
		return undefined;
	}
}

function ownerDefinitelyGone(record: LockRecord): boolean {
	if (record.bootId && bootId() && record.bootId !== bootId()) return true;
	try {
		process.kill(record.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function writeLockDescriptor(fd: number, record: LockRecord): void {
	const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
	const written = fs.writeSync(fd, encoded, 0, encoded.byteLength, 0);
	if (written !== encoded.byteLength) throw new Error("durability_failed");
	fs.fsyncSync(fd);
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Create a managed directory and fail closed unless its owner-only mode/ACL verifies. */
export function ensureManagedDirectory(pathname: string): void {
	fs.mkdirSync(pathname, { recursive: true, mode: 0o700 });
	assertSafeDirectory(pathname);
	secure(pathname, "directory");
}

/** Captures header/hash/copy input from one no-follow descriptor and rechecks the pathname before use. */
export function captureManagedFileNoFollow(pathname: string): ManagedFileSnapshot {
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.nlink > 1) throw new Error("source_changed");
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.byteLength) {
			const count = fs.readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
			if (count === 0) throw new Error("source_changed");
			offset += count;
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameIdentity(identity(before), identity(after))) throw new Error("source_changed");
		const named = fs.lstatSync(pathname, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(identity(before), identity(named)))
			throw new Error("source_changed");
		return { bytes, identity: identity(before) };
	} finally {
		fs.closeSync(fd);
	}
}

/** Atomically publishes bytes without replacing an existing destination. */
export async function publishManagedFileNoReplace(
	destination: string,
	bytes: Uint8Array,
	assertOwned?: () => void,
): Promise<void> {
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
	let fd: number | undefined;
	try {
		assertOwned?.();
		fd = fs.openSync(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		let offset = 0;
		while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		secure(staging, "file");
		assertOwned?.();
		const published = renameNoReplacePath(staging, destination);
		if (!published.ok) {
			if (published.code === "quarantine_collision") throw new Error("destination_conflict");
			throw new Error("durability_failed");
		}
		secure(destination, "file");
		fsyncDirectory(parent);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		await fsp.unlink(staging).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

export function publishManagedFileNoReplaceSync(destination: string, bytes: Uint8Array): void {
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
	let failure: unknown;
	try {
		const fd = fs.openSync(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			let offset = 0;
			while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		secure(staging, "file");
		const published = renameNoReplacePath(staging, destination);
		if (!published.ok) {
			if (published.code === "quarantine_collision") throw new Error("destination_conflict");
			throw new Error("durability_failed");
		}
		secure(destination, "file");
		fsyncDirectory(parent);
	} catch (error) {
		failure = error;
	}
	try {
		fs.unlinkSync(staging);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
	}
	if (failure !== undefined) throw failure;
}

/** Copy the exact bytes captured from one no-follow source descriptor. */
export async function copyManagedFileNoReplace(
	source: string,
	destination: string,
	snapshot = captureManagedFileNoFollow(source),
): Promise<void> {
	const named = captureManagedFileNoFollow(source);
	if (!sameIdentity(snapshot.identity, named.identity) || !snapshot.bytes.equals(named.bytes))
		throw new Error("source_changed");
	await publishManagedFileNoReplace(destination, snapshot.bytes);
	const destinationSnapshot = captureManagedFileNoFollow(destination);
	if (!destinationSnapshot.bytes.equals(snapshot.bytes)) throw new Error("durability_failed");
}

/** Acquire a lease lock with bounded wait, heartbeats, conservative stale reclaim, and fencing. */
export async function acquireManagedLock(locksDirectory: string, name: string): Promise<ManagedStorageLock> {
	ensureManagedDirectory(locksDirectory);
	const lockPath = path.join(locksDirectory, `${name}.lock`);
	const deadline = Date.now() + LOCK_WAIT_MS;
	let staleObservedAt: number | undefined;
	while (true) {
		const attemptId = randomUUID();
		const now = Date.now();
		const record: LockRecord = {
			attemptId,
			pid: process.pid,
			bootId: bootId(),
			processStartId: PROCESS_START_ID,
			createdAt: now,
			heartbeatAt: now,
			leaseExpiresAt: now + LOCK_LEASE_MS,
		};
		try {
			const fd = fs.openSync(
				lockPath,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
				fs.fsyncSync(fd);
				secure(lockPath, "file");
				fsyncDirectory(locksDirectory);
			} catch (error) {
				fs.closeSync(fd);
				throw error;
			}
			const lockIdentity = fs.fstatSync(fd, { bigint: true });
			let released = false;
			let descriptorClosed = false;
			const closeDescriptor = (): void => {
				if (!descriptorClosed) {
					fs.closeSync(fd);
					descriptorClosed = true;
				}
			};
			const assertOwned = (): void => {
				const current = parseLock(lockPath);
				let named: fs.BigIntStats;
				try {
					named = fs.lstatSync(lockPath, { bigint: true });
				} catch {
					throw new Error("migration_busy");
				}
				if (
					released ||
					descriptorClosed ||
					!current ||
					!sameFileIdentity(lockIdentity, named) ||
					current.attemptId !== attemptId ||
					current.leaseExpiresAt < Date.now()
				)
					throw new Error("migration_busy");
			};
			const heartbeat = setInterval(() => {
				try {
					assertOwned();
					const now = Date.now();
					writeLockDescriptor(fd, { ...record, heartbeatAt: now, leaseExpiresAt: now + LOCK_LEASE_MS });
				} catch {
					/* fencing rejects later publication */
				}
			}, LOCK_HEARTBEAT_MS);
			return {
				path: lockPath,
				attemptId,
				assertOwned,
				async release(): Promise<void> {
					clearInterval(heartbeat);
					try {
						assertOwned();
						const now = Date.now();
						// Do not unlink by pathname: a stale owner could otherwise remove a successor.
						// The lease is retired through the verified inode-bound descriptor instead.
						writeLockDescriptor(fd, { ...record, heartbeatAt: now, leaseExpiresAt: now });
						fsyncDirectory(locksDirectory);
					} finally {
						released = true;
						closeDescriptor();
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = parseLock(lockPath);
			if (owner && owner.leaseExpiresAt < Date.now()) {
				const ownerGone = ownerDefinitelyGone(owner);
				if (staleObservedAt === undefined) staleObservedAt = Date.now();
				if (ownerGone || Date.now() - staleObservedAt >= LOCK_STALE_RECHECK_MS) {
					const quarantine = `${lockPath}.${randomUUID()}.stale`;
					try {
						fs.renameSync(lockPath, quarantine);
						const quarantined = parseLock(quarantine);
						if (!quarantined || quarantined.attemptId !== owner.attemptId) throw new Error("migration_busy");
						fs.unlinkSync(quarantine);
						fsyncDirectory(locksDirectory);
					} catch {
						/* retry owner observation */
					}
					staleObservedAt = undefined;
				}
			} else staleObservedAt = undefined;
			if (Date.now() >= deadline) throw new Error("migration_busy");
			await new Promise<void>(resolve => setTimeout(resolve, 50));
		}
	}
}

/** Bounds a no-follow artifact tree before it can be copied or deleted. */
export function validateManagedArtifactTree(root: string): void {
	let files = 0;
	let bytes = 0;
	const visit = (directory: string, depth: number): void => {
		if (depth > MANAGED_ARTIFACT_MAX_DEPTH) throw new Error("unsafe_artifacts");
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			const stat = fs.lstatSync(entryPath);
			if (stat.isSymbolicLink()) throw new Error("unsafe_artifacts");
			if (stat.isDirectory()) {
				visit(entryPath, depth + 1);
				continue;
			}
			if (stat.nlink > 1) throw new Error("unsafe_artifacts");
			if (!stat.isFile() || stat.size > MANAGED_ARTIFACT_MAX_FILE_BYTES) throw new Error("unsafe_artifacts");
			files++;
			bytes += stat.size;
			if (files > MANAGED_ARTIFACT_MAX_FILES || bytes > MANAGED_ARTIFACT_MAX_TOTAL_BYTES)
				throw new Error("unsafe_artifacts");
		}
	};
	const rootStat = fs.lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe_artifacts");
	visit(root, 0);
}

/** Flush a copied managed artifact tree, including empty directories, before publishing its receipt. */
export function fsyncManagedArtifactTree(root: string): void {
	const visit = (pathname: string): void => {
		const stat = fs.lstatSync(pathname);
		if (stat.isSymbolicLink()) throw new Error("unsafe_artifacts");
		if (stat.isFile()) {
			const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			return;
		}
		if (!stat.isDirectory()) throw new Error("unsafe_artifacts");
		for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) visit(path.join(pathname, entry.name));
		fsyncDirectory(pathname);
	};
	validateManagedArtifactTree(root);
	visit(root);
	validateManagedArtifactTree(root);
}

export async function publishManagedTombstone(
	destination: string,
	record: Record<string, unknown>,
	assertOwned?: () => void,
): Promise<void> {
	await publishManagedFileNoReplace(
		destination,
		new TextEncoder().encode(
			`${JSON.stringify(record, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
		),
		assertOwned,
	);
}

export async function unlinkManagedFileVerified(
	pathname: string,
	expected: ManagedFileSnapshot["identity"],
): Promise<void> {
	const snapshot = captureManagedFileNoFollow(pathname);
	if (!sameIdentity(snapshot.identity, expected)) throw new Error("source_changed");
	await fsp.unlink(pathname);
	fsyncDirectory(path.dirname(pathname));
}
