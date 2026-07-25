import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";

/**
 * Classifies directory-handle fsync failures that Windows cannot support.
 *
 * Windows cannot fsync a directory handle: libuv/Bun report `EPERM` (and other
 * runtimes report `EINVAL`/`ENOTSUP`/`EOPNOTSUPP`) when `fsync` is applied to a
 * directory file descriptor. Callers that fsync a parent directory after an
 * atomic temp-file rename should treat exactly these codes as an unsupported
 * platform operation and continue; every other failure remains fail-closed.
 */
export function isUnsupportedWindowsDirectorySyncError(
	error: unknown,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	// Bun reports EPERM when fsync is applied to a Windows directory handle.
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

export interface DirectorySyncHandle {
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface DirectorySyncOptions {
	platform?: NodeJS.Platform;
	/** Injectable directory-open seam for tests; production callers omit it. */
	open?: (directory: string) => Promise<DirectorySyncHandle>;
}

export interface DirectorySyncOptionsSync {
	platform?: NodeJS.Platform;
	/** Injectable directory-open seam for tests; production callers omit it. */
	open?: (directory: string) => number;
	sync?: (descriptor: number) => void;
	close?: (descriptor: number) => void;
}

/**
 * Fsync a parent directory after an atomic publish (temp write → file fsync →
 * rename/link). Use this durability-contract policy where unsupported Windows
 * directory sync is tolerated but all other failures remain fail-closed.
 */
export async function syncDirectoryBestEffort(directory: string, options: DirectorySyncOptions = {}): Promise<void> {
	const platform = options.platform ?? process.platform;
	const open = options.open ?? (async (target: string): Promise<DirectorySyncHandle> => fs.open(target, "r"));
	const handle = await open(directory);
	try {
		await handle.sync();
	} catch (error) {
		if (!isUnsupportedWindowsDirectorySyncError(error, platform)) throw error;
	} finally {
		await handle.close();
	}
}
/**
 * Synchronous equivalent of `syncDirectoryBestEffort`.
 */
export function syncDirectoryBestEffortSync(directory: string, options: DirectorySyncOptionsSync = {}): void {
	const platform = options.platform ?? process.platform;
	const open = options.open ?? ((target: string): number => fsSync.openSync(target, "r"));
	const sync = options.sync ?? fsSync.fsyncSync;
	const close = options.close ?? fsSync.closeSync;
	const descriptor = open(directory);
	try {
		try {
			sync(descriptor);
		} catch (error) {
			if (!isUnsupportedWindowsDirectorySyncError(error, platform)) throw error;
		}
	} finally {
		close(descriptor);
	}
}

/**
 * Fsync after a completed replacement where the durability barrier is purely
 * best-effort. Unlike `syncDirectoryBestEffort`, open, sync, and close
 * failures are all intentionally ignored.
 */
export async function syncDirectoryFullyBestEffort(
	directory: string,
	options: DirectorySyncOptions = {},
): Promise<void> {
	try {
		const open = options.open ?? (async (target: string): Promise<DirectorySyncHandle> => fs.open(target, "r"));
		const handle = await open(directory);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// The completed rename remains valid when the optional barrier is unavailable.
	}
}

/**
 * Synchronous equivalent of `syncDirectoryFullyBestEffort`.
 */
export function syncDirectoryFullyBestEffortSync(directory: string, options: DirectorySyncOptionsSync = {}): void {
	try {
		const open = options.open ?? ((target: string): number => fsSync.openSync(target, "r"));
		const sync = options.sync ?? fsSync.fsyncSync;
		const close = options.close ?? fsSync.closeSync;
		const descriptor = open(directory);
		try {
			sync(descriptor);
		} finally {
			close(descriptor);
		}
	} catch {
		// The completed rename remains valid when the optional barrier is unavailable.
	}
}
