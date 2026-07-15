/**
 * Isolated profile warm-up (plan Phase 2, R-C3).
 *
 * Aggressive real-profile reuse seeds a session with the user's cookies /
 * localStorage / cache. To stay safe (never lock or corrupt the live browser
 * session) we NEVER bind the source profile directly: we copy an allowlisted
 * subset of artifacts into an ephemeral, isolated directory and drive Chromium
 * against that copy. Chromium single-instance lock files (SingletonLock/Socket/
 * Cookie) are explicitly excluded so the isolated copy can never contend with a
 * running browser.
 *
 * This module is pure filesystem logic (no browser, no network) so it is
 * deterministically unit-testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Chromium single-instance lock artifacts — must never be copied. */
export const CHROME_LOCK_ARTIFACTS = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

/**
 * Profile-relative artifacts worth seeding for warm-up. Kept intentionally
 * small: session state (cookies, storage) plus a light cache. Anything not
 * listed is skipped, which also keeps the isolated copy cheap.
 */
export const WARMUP_ARTIFACTS = [
	"Cookies",
	"Cookies-journal",
	"Local Storage",
	"Session Storage",
	"IndexedDB",
	"Network",
	"Preferences",
] as const;

export interface WarmupManifest {
	sourceProfileDir: string;
	destDir: string;
	copied: string[];
	skippedMissing: string[];
	/** Always empty unless a lock artifact was seen (never copied). */
	excludedLocks: string[];
}

function copyRecursive(src: string, dest: string): void {
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true });
		for (const entry of fs.readdirSync(src)) {
			copyRecursive(path.join(src, entry), path.join(dest, entry));
		}
	} else {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
	}
}

/**
 * Copy warm-up artifacts from `sourceProfileDir` into an isolated `destDir`.
 *
 * Guarantees:
 * - The source profile is only ever read, never written or locked.
 * - Chromium lock artifacts are never copied (recorded in `excludedLocks`).
 * - Missing artifacts are skipped, not fatal (recorded in `skippedMissing`).
 */
export function collectWarmupArtifacts(sourceProfileDir: string, destDir: string): WarmupManifest {
	const manifest: WarmupManifest = {
		sourceProfileDir,
		destDir,
		copied: [],
		skippedMissing: [],
		excludedLocks: [],
	};

	if (!fs.existsSync(sourceProfileDir)) {
		throw new Error(`source profile directory does not exist: ${sourceProfileDir}`);
	}
	fs.mkdirSync(destDir, { recursive: true });

	// Record (but never copy) any lock artifacts present in the source.
	for (const lock of CHROME_LOCK_ARTIFACTS) {
		if (fs.existsSync(path.join(sourceProfileDir, lock))) {
			manifest.excludedLocks.push(lock);
		}
	}

	for (const artifact of WARMUP_ARTIFACTS) {
		const src = path.join(sourceProfileDir, artifact);
		if (!fs.existsSync(src)) {
			manifest.skippedMissing.push(artifact);
			continue;
		}
		copyRecursive(src, path.join(destDir, artifact));
		manifest.copied.push(artifact);
	}

	return manifest;
}
