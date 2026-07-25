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

/**
 * Fsync a parent directory after an atomic publish (temp write → file fsync →
 * rename/link), tolerating exactly the unsupported Windows directory-sync
 * codes during the `sync()` stage.
 *
 * Error precedence is preserved end to end: directory `open()` failures,
 * unclassified `sync()` failures, and `close()` failures all propagate
 * fail-closed; only a classified Windows `sync()` failure is downgraded to a
 * best-effort barrier. The handle is always closed once opened.
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
