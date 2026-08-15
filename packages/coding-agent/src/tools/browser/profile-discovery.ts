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
import { $credentialEnv } from "@gajae-code/utils/env";

export interface DiscoveryEnv {
	platform: NodeJS.Platform;
	home: string;
	/** Injectable for tests; defaults to fs.existsSync at call sites. */
	exists: (p: string) => boolean;
	/** Windows LOCALAPPDATA override (tests / non-default installs). */
	localAppData?: string;
	/** Linux Chrome-specific default user-data override. */
	chromeUserDataDir?: string;
	/** Linux Chrome config-home override (takes precedence over XDG_CONFIG_HOME). */
	chromeConfigHome?: string;
	/** Linux XDG config-home override. */
	xdgConfigHome?: string;
}

function discoveryPath(env: DiscoveryEnv): typeof path.posix {
	return env.platform === "win32" ? path.win32 : path.posix;
}

/** Candidate Chrome user-data roots for the platform (most common first). */
export function chromeUserDataRoots(env: DiscoveryEnv): string[] {
	const platformPath = discoveryPath(env);
	switch (env.platform) {
		case "darwin":
			return [
				platformPath.join(env.home, "Library", "Application Support", "Google", "Chrome"),
				platformPath.join(env.home, "Library", "Application Support", "Google", "Chrome Beta"),
				platformPath.join(env.home, "Library", "Application Support", "Google", "Chrome Dev"),
				platformPath.join(env.home, "Library", "Application Support", "Google", "Chrome Canary"),
				platformPath.join(env.home, "Library", "Application Support", "Chromium"),
			];
		case "win32": {
			const localAppData = env.localAppData ?? platformPath.join(env.home, "AppData", "Local");
			return [
				platformPath.join(localAppData, "Google", "Chrome", "User Data"),
				platformPath.join(localAppData, "Google", "Chrome Beta", "User Data"),
				platformPath.join(localAppData, "Google", "Chrome Dev", "User Data"),
				platformPath.join(localAppData, "Google", "Chrome SxS", "User Data"),
				platformPath.join(localAppData, "Chromium", "User Data"),
			];
		}
		default: {
			const configHome = env.chromeConfigHome ?? env.xdgConfigHome ?? platformPath.join(env.home, ".config");
			return [
				...(env.chromeUserDataDir ? [env.chromeUserDataDir] : []),
				platformPath.join(configHome, "google-chrome"),
				platformPath.join(configHome, "google-chrome-beta"),
				platformPath.join(configHome, "google-chrome-unstable"),
				platformPath.join(configHome, "google-chrome-canary"),
				platformPath.join(configHome, "chromium"),
				platformPath.join(env.home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
				platformPath.join(env.home, ".var", "app", "org.chromium.Chromium", "config", "chromium"),
				platformPath.join(env.home, "snap", "chromium", "common", "chromium"),
				platformPath.join(env.home, "snap", "chromium", "current", ".config", "chromium"),
			];
		}
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
	const platformPath = discoveryPath(env);
	for (const userDataDir of chromeUserDataRoots(env)) {
		const profileDir = platformPath.join(userDataDir, profileDirectory);
		if (env.exists(profileDir)) {
			return { userDataDir, profileDirectory, profileDir };
		}
	}
	return null;
}

/** Convenience wrapper using the live OS environment + fs. */
export function defaultDiscoveryEnv(exists: (p: string) => boolean): DiscoveryEnv {
	const localAppData = $credentialEnv("LOCALAPPDATA");
	const chromeUserDataDir = $credentialEnv("CHROME_USER_DATA_DIR");
	const chromeConfigHome = $credentialEnv("CHROME_CONFIG_HOME");
	const xdgConfigHome = $credentialEnv("XDG_CONFIG_HOME");
	return {
		platform: process.platform,
		home: os.homedir(),
		exists,
		...(localAppData ? { localAppData } : {}),
		...(chromeUserDataDir ? { chromeUserDataDir } : {}),
		...(chromeConfigHome ? { chromeConfigHome } : {}),
		...(xdgConfigHome ? { xdgConfigHome } : {}),
	};
}
