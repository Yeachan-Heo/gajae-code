
import type { invalidateFsScanCache as invalidateFsScanCacheFn } from "@gajae-code/natives";

let nativeInvalidateFsScanCache: typeof invalidateFsScanCacheFn | undefined;


function invalidateFsScanCacheNative(path: string): void {
	nativeInvalidateFsScanCache ??= (require("@gajae-code/natives") as { invalidateFsScanCache: typeof invalidateFsScanCacheFn }).invalidateFsScanCache;
	nativeInvalidateFsScanCache(path);
}

/**
 * Invalidate shared filesystem scan caches after a content write/update.
 */
export function invalidateFsScanAfterWrite(path: string): void {
	invalidateFsScanCacheNative(path);
}

/**
 * Invalidate shared filesystem scan caches after deleting a file.
 */
export function invalidateFsScanAfterDelete(path: string): void {
	invalidateFsScanCacheNative(path);
}

/**
 * Invalidate shared filesystem scan caches after a rename/move.
 *
 * Some watchers care about the disappearance at the old path; others about the
 * appearance at the new one. Bust both to keep callers honest.
 */
export function invalidateFsScanAfterRename(oldPath: string, newPath: string): void {
	invalidateFsScanCacheNative(oldPath);
	if (newPath !== oldPath) {
		invalidateFsScanCacheNative(newPath);
	}
}
