import { execFileSync } from "node:child_process";

export const RECOMMENDED_MACOS_NOFILE_LIMIT = 4096;

export function parseNoFileLimit(text: string): number | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed === "unlimited") return undefined;
	const value = Number(trimmed);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function buildMacOSNoFileLimitWarning(currentLimit: number): string {
	return [
		`Warning: macOS file descriptor limit is low (ulimit -n = ${currentLimit}).`,
		'GJC and project dev servers can hit EMFILE / "too many open files" while scanning or watching repositories.',
		"For this terminal session, run:",
		`  ulimit -n ${RECOMMENDED_MACOS_NOFILE_LIMIT}`,
		"If your shell refuses that value, raise the per-user launchd limit and restart the terminal:",
		`  sudo launchctl limit maxfiles ${RECOMMENDED_MACOS_NOFILE_LIMIT} 65536`,
		"Avoid using huge values such as 2147483646 on macOS; they are commonly rejected or clamped.",
		"Set GJC_SKIP_NOFILE_CHECK=1 to silence this preflight warning.",
	].join("\n");
}

export interface WarnIfMacOSNoFileLimitTooLowDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	execFileSync?: typeof execFileSync;
	writeStderr?: (text: string) => void;
}

export function warnIfMacOSNoFileLimitTooLow(deps: WarnIfMacOSNoFileLimitTooLowDeps = {}): void {
	const platform = deps.platform ?? process.platform;
	if (platform !== "darwin") return;
	const env = deps.env ?? process.env;
	if (env.GJC_SKIP_NOFILE_CHECK === "1" || env.GJC_SKIP_NOFILE_CHECK === "true") return;

	const run = deps.execFileSync ?? execFileSync;
	let currentLimit: number | undefined;
	try {
		// Plain `sh -c`, not `-lc`: the value that matters is the limit this process
		// inherited (children report their inherited soft limit), and `-l` sources
		// the user's shell profile on every launch purely to produce a number that
		// may not even match what gjc is actually running under.
		currentLimit = parseNoFileLimit(run("/bin/sh", ["-c", "ulimit -n"], { encoding: "utf8" }));
	} catch {
		return;
	}
	if (currentLimit === undefined || currentLimit >= RECOMMENDED_MACOS_NOFILE_LIMIT) return;
	const write = deps.writeStderr ?? (text => process.stderr.write(text));
	write(`${buildMacOSNoFileLimitWarning(currentLimit)}\n`);
}
