/**
 * Default Chrome profile discovery (plan Phase 2 wiring).
 *
 * Locates the user's real Chrome "Default" profile directory per OS so the
 * default headless launch path can warm up synthetic sessions from an isolated
 * copy of it (see profile-warmup.ts + profile-posture.ts). Pure path logic with
 * an injectable existence check, so it is unit-testable without touching the
 * real filesystem.
 */

import * as os from "node:os";
import * as path from "node:path";

export interface DiscoveryEnv {
	platform: NodeJS.Platform;
	home: string;
	/** Injectable for tests; defaults to fs.existsSync at call sites. */
	exists: (p: string) => boolean;
	/** Windows LOCALAPPDATA override (tests / non-default installs). */
	localAppData?: string;
}

/** Candidate Chrome user-data roots for the platform (most common first). */
export function chromeUserDataRoots(env: DiscoveryEnv): string[] {
	switch (env.platform) {
		case "darwin":
			return [path.join(env.home, "Library", "Application Support", "Google", "Chrome")];
		case "win32": {
			const localAppData = env.localAppData ?? path.join(env.home, "AppData", "Local");
			return [path.join(localAppData, "Google", "Chrome", "User Data")];
		}
		default:
			return [path.join(env.home, ".config", "google-chrome"), path.join(env.home, ".config", "chromium")];
	}
}

export interface DiscoveredProfile {
	userDataDir: string;
	profileDirectory: string;
	profileDir: string;
}

/**
 * Discover the default Chrome profile, or null when none is present.
 * Only returns a profile whose directory actually exists.
 */
export function discoverDefaultChromeProfile(
	env: DiscoveryEnv,
	profileDirectory = "Default",
): DiscoveredProfile | null {
	for (const userDataDir of chromeUserDataRoots(env)) {
		const profileDir = path.join(userDataDir, profileDirectory);
		if (env.exists(profileDir)) {
			return { userDataDir, profileDirectory, profileDir };
		}
	}
	return null;
}

/** Convenience wrapper using the live OS environment + fs. */
export function defaultDiscoveryEnv(exists: (p: string) => boolean): DiscoveryEnv {
	return { platform: process.platform, home: os.homedir(), exists };
}
