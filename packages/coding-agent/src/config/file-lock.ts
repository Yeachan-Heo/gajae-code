import * as fs from "node:fs/promises";
import { isEnoent } from "@gajae-code/utils";

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

interface LockInfo {
	pid: number;
	timestamp: number;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

async function writeLockInfo(lockPath: string): Promise<void> {
	const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
	await Bun.write(`${lockPath}/info`, JSON.stringify(info));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const content = await fs.readFile(`${lockPath}/info`, "utf-8");
		return JSON.parse(content) as LockInfo;
	} catch {
		return null;
	}
}

/** @internal */
export async function readFileLockInfoForGc(lockDir: string): Promise<{ pid: number; timestamp: number } | null> {
	const info = await readLockInfo(lockDir);
	if (!info) return null;
	if (!Number.isFinite(info.pid) || info.pid <= 0) return null;
	if (!Number.isFinite(info.timestamp)) return null;
	return info;
}

/** @internal */
export async function removeFileLockDirForGc(lockDir: string): Promise<void> {
	await fs.rm(lockDir, { recursive: true, force: true });
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
	const info = await readLockInfo(lockPath);
	if (!info) return true;

	if (!isProcessAlive(info.pid)) return true;

	if (Date.now() - info.timestamp > staleMs) return true;

	return false;
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
	try {
		await fs.mkdir(lockPath);
		await writeLockInfo(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

async function releaseLock(lockPath: string): Promise<void> {
	try {
		await fs.rm(lockPath, { recursive: true });
	} catch {
		// Ignore errors on release
	}
}

async function lockExists(lockPath: string): Promise<boolean> {
	try {
		await fs.stat(lockPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		if (await tryAcquireLock(lockPath)) {
			return () => releaseLock(lockPath);
		}

		if ((await lockExists(lockPath)) && (await isLockStale(lockPath, opts.staleMs))) {
			await releaseLock(lockPath);
			continue;
		}

		await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		await release();
	}
}
