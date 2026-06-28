import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";

/** Prefix of every computer-use screenshot fallback directory created under the OS temp dir. */
export const SCREENSHOT_FALLBACK_DIR_PREFIX = "gjc-computer-screenshots-";

let screenshotFallbackDirsCreated = false;

/** Lazy-arm marker: called when the first screenshot fallback dir is created this process. */
export function markScreenshotFallbackDirCreatedForGc(): void {
	screenshotFallbackDirsCreated = true;
}

/** Whether any screenshot fallback dir has been created this process (GC lazy-arm gate). */
export function hasCreatedScreenshotFallbackDir(): boolean {
	return screenshotFallbackDirsCreated;
}

/** Test-only: reset the lazy-arm marker between cases. */
export function resetScreenshotFallbackGcForTest(): void {
	screenshotFallbackDirsCreated = false;
}

export interface ScreenshotGcOptions {
	now: () => number;
	staleMs: number;
	/** Base dir to scan; defaults to os.tmpdir(). Injectable for tests. */
	tmpDir?: string;
}

/**
 * Disk-only GC for stale computer-use screenshot fallback directories. Scans the temp dir for
 * `gjc-computer-screenshots-*` directories and removes those whose mtime is older than `staleMs`.
 * Never throws on a per-directory failure; the whole sweep is best-effort.
 */
export async function cleanupStaleScreenshotFallbackDirs(
	options: ScreenshotGcOptions,
): Promise<{ scanned: number; removed: number }> {
	const base = options.tmpDir ?? os.tmpdir();
	const entries: Dirent[] = await fs.readdir(base, { withFileTypes: true }).catch(err => {
		logger.debug("screenshot GC: failed to read temp dir", { base, error: (err as Error).message });
		return [] as Dirent[];
	});

	const now = options.now();
	let scanned = 0;
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(SCREENSHOT_FALLBACK_DIR_PREFIX)) continue;
		scanned++;
		const dir = path.join(base, entry.name);
		try {
			const stat = await fs.stat(dir);
			if (now - stat.mtimeMs <= options.staleMs) continue;
			await fs.rm(dir, { recursive: true, force: true });
			removed++;
		} catch (err) {
			logger.debug("screenshot GC: failed to remove stale dir", { dir, error: (err as Error).message });
		}
	}
	return { scanned, removed };
}
