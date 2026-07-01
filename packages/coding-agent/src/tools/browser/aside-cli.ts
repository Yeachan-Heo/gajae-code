import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Aside CLI discovery — pure probe, never installs.
 *
 * The Aside CLI is installed separately from the Aside.app browser (via the
 * documented installer, which symlinks `~/.local/bin/aside` to the bundled
 * `Aside CLI.app`). We look on PATH-equivalent locations first, then the
 * installer's canonical app-bundle location. Nothing here executes an
 * installer; missing-CLI handling is the caller's decision.
 */

export const ASIDE_INSTALL_URL = "https://releases.aside.com/install.sh";
export const ASIDE_INSTALL_COMMAND = "curl -fsSL https://releases.aside.com/install.sh | bash";

export type AsideCliProbe =
	| { ok: true; path: string }
	| { ok: false; searched: string[]; manualInstallCommand: string; url: string };

/** Candidate absolute paths for the `aside` CLI, in priority order. */
export function asideCliCandidates(home = os.homedir()): string[] {
	return [
		path.join(home, ".local", "bin", "aside"),
		path.join(home, ".aside", "cli", "Aside CLI.app", "Contents", "MacOS", "aside"),
	];
}

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return false;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve the first executable Aside CLI path, or null when none is found. */
export function resolveAsideCliPath(home = os.homedir()): string | null {
	for (const candidate of asideCliCandidates(home)) {
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}

/** Structured probe result for callers that need to guide installation. */
export function probeAsideCli(home = os.homedir()): AsideCliProbe {
	const searched = asideCliCandidates(home);
	const found = resolveAsideCliPath(home);
	if (found) return { ok: true, path: found };
	return { ok: false, searched, manualInstallCommand: ASIDE_INSTALL_COMMAND, url: ASIDE_INSTALL_URL };
}
