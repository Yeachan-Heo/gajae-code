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
