import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CoordinatorDirectoryBarrierOptions {
	platform?: NodeJS.Platform;
	openDirectory?: (directory: string) => Promise<fs.FileHandle>;
}

export interface CoordinatorFileDurabilityOptions {
	syncFile?: (handle: fs.FileHandle) => Promise<void>;
}

export interface CoordinatorAtomicWriteOptions
	extends CoordinatorDirectoryBarrierOptions,
		CoordinatorFileDurabilityOptions {
	rename?: (source: string, destination: string) => Promise<void>;
	/** Synchronous authority fence, checked after preparation immediately before publication. */
	isCurrent?: () => boolean;
}

/** The file was published, but its final directory barrier did not complete. */
export class CoordinatorPublicationUncertainError extends Error {
	constructor(cause: unknown) {
		super("coordinator publication outcome is uncertain", { cause });
	}
}

export async function ensureCoordinatorDirectory(
	directory: string,
	options: CoordinatorDirectoryBarrierOptions = {},
): Promise<void> {
	const missing: string[] = [];
	for (let current = directory; ; current = path.dirname(current)) {
		try {
			const stat = await fs.stat(current);
			if (!stat.isDirectory()) throw new Error(`coordinator directory is not a directory: ${current}`);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missing.push(current);
			if (current === path.dirname(current)) throw error;
		}
	}
	for (const created of missing.reverse()) {
		try {
			await fs.mkdir(created, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = await fs.stat(created);
			if (!stat.isDirectory()) throw error;
		}
		await syncCoordinatorDirectory(path.dirname(created), options);
	}
}

/**
 * Windows does not support fsync on directory handles. File contents must be
 * synced before publication; this barrier only makes the renamed directory
 * entry durable where the platform supports that operation.
 */
export function isUnsupportedWindowsDirectorySyncError(
	error: unknown,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	// Windows directory-handle barriers use the established broker precedent:
	// EPERM/EACCES are tolerated only for the directory open/sync operation.
	return code === "EPERM" || code === "EACCES";
}

export async function syncCoordinatorDirectory(
	directory: string,
	options: CoordinatorDirectoryBarrierOptions = {},
): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await (options.openDirectory ?? (path => fs.open(path, "r")))(directory);
	} catch (error) {
		if (!isUnsupportedWindowsDirectorySyncError(error, options.platform)) throw error;
		return;
	}
	let syncError: unknown;
	try {
		await handle.sync();
	} catch (error) {
		if (!isUnsupportedWindowsDirectorySyncError(error, options.platform)) syncError = error;
	}
	try {
		await handle.close();
	} catch (closeError) {
		if (syncError) throw new AggregateError([syncError, closeError], "coordinator directory sync and close failed");
		throw closeError;
	}
	if (syncError) throw syncError;
}

/** File durability is never best-effort: callers must abort on every failure. */
export async function syncCoordinatorFile(
	handle: fs.FileHandle,
	options: CoordinatorFileDurabilityOptions = {},
): Promise<void> {
	await (options.syncFile ?? (file => file.sync()))(handle);
}

/** Append a durable coordinator journal or diagnostic record, then barrier its parent. */
export async function appendCoordinatorFile(
	file: string,
	contents: string,
	options: CoordinatorDirectoryBarrierOptions & CoordinatorFileDurabilityOptions = {},
): Promise<void> {
	await ensureCoordinatorDirectory(path.dirname(file), options);
	let originalSize = 0;
	try {
		originalSize = (await fs.stat(file)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const handle = await fs.open(file, "a", 0o600);
	let writeError: unknown;
	try {
		await handle.writeFile(contents);
		await syncCoordinatorFile(handle, options);
	} catch (error) {
		writeError = error;
	}
	if (writeError) {
		try {
			await handle.truncate(originalSize);
			await syncCoordinatorFile(handle, options);
		} catch (rollbackError) {
			writeError = new AggregateError([writeError, rollbackError], "coordinator append rollback failed");
		}
	}
	try {
		await handle.close();
	} catch (closeError) {
		if (writeError) {
			const writeErrors = writeError instanceof AggregateError ? writeError.errors : [writeError];
			throw new AggregateError([...writeErrors, closeError], "coordinator append and close failed");
		}
		throw closeError;
	}
	if (writeError) throw writeError;
	try {
		await syncCoordinatorDirectory(path.dirname(file), options);
	} catch (error) {
		throw new CoordinatorPublicationUncertainError(error);
	}
}

/** Atomically publish a synced coordinator state file, then barrier its parent. */
export function writeCoordinatorAtomic(
	file: string,
	contents: string,
	options: CoordinatorAtomicWriteOptions & { isCurrent: () => boolean },
): Promise<"persisted" | "stale">;
export function writeCoordinatorAtomic(
	file: string,
	contents: string,
	options?: CoordinatorAtomicWriteOptions,
): Promise<undefined>;
export async function writeCoordinatorAtomic(
	file: string,
	contents: string,
	options: CoordinatorAtomicWriteOptions = {},
): Promise<undefined | "persisted" | "stale"> {
	await ensureCoordinatorDirectory(path.dirname(file), options);
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let published = false;
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		let writeError: unknown;
		try {
			await handle.writeFile(contents);
			await syncCoordinatorFile(handle, options);
		} catch (error) {
			writeError = error;
		}
		try {
			await handle.close();
		} catch (closeError) {
			if (writeError) throw new AggregateError([writeError, closeError], "coordinator write and close failed");
			throw closeError;
		}
		if (writeError) throw writeError;
		if (options.isCurrent && !options.isCurrent()) {
			await fs.rm(temporary, { force: true });
			await syncCoordinatorDirectory(path.dirname(file), options);
			return "stale";
		}
		await (options.rename ?? fs.rename)(temporary, file);
		published = true;
		await syncCoordinatorDirectory(path.dirname(file), options);
		if (options.isCurrent) return "persisted";
	} catch (error) {
		let cleanupError: unknown;
		try {
			await fs.rm(temporary, { force: true });
		} catch (cleanupFailure) {
			cleanupError = cleanupFailure;
		}
		let cleanupBarrierError: unknown;
		if (!cleanupError && !published) {
			try {
				await syncCoordinatorDirectory(path.dirname(file), options);
			} catch (barrierError) {
				cleanupBarrierError = barrierError;
			}
		}
		const failures = [error, cleanupError, cleanupBarrierError].filter(
			(value): value is unknown => value !== undefined,
		);
		if (published) throw new CoordinatorPublicationUncertainError(new AggregateError(failures));
		if (failures.length === 1) throw failures[0];
		throw new AggregateError(failures, "coordinator atomic write and cleanup failed");
	}
}
