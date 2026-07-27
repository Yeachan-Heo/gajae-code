import * as fs from "node:fs";
import * as path from "node:path";
import { Process, ProcessStatus } from "@gajae-code/natives";
import type { Subprocess } from "bun";
import { $pickCredentialEnv, $pickflag, filterProcessEnv } from "./env";
import { $which } from "./which";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}
let cachedShellConfig: ShellConfig | null = null;

/**
 * Strip disabled macOS malloc-stack-logging vars from `process.env` in place.
 *
 * macOS leaves `MallocStackLogging=0` (or similar) inherited by debug-attached
 * shells. Bun's libc init then prints `MallocStackLogging: can't turn off
 * malloc stack logging because it was not enabled.` to stderr for every
 * subprocess. Scrubbing once at startup means every child we spawn — bash,
 * bun subagents, plugin installs, ptree commands — inherits a clean env.
 */
export function scrubProcessEnv(): void {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
}

/**
 * Check if a shell binary is executable.
 */
function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the spawn environment (cached).
 *
 * `CI=true` is injected unless the documented `GJC_BASH_NO_CI` (or its legacy
 * `PI_BASH_NO_CI` / `CLAUDE_BASH_NO_CI` aliases) is set to a canonical truthy
 * flag value.
 */
function buildSpawnEnv(shell: string): Record<string, string> {
	const noCI = $pickflag("GJC_BASH_NO_CI", "PI_BASH_NO_CI", "CLAUDE_BASH_NO_CI");
	const inherited = filterProcessEnv(Bun.env);
	delete inherited.GJC_SESSION_FILE;
	delete inherited.GJC_MANAGED_OWNER_TRANSCRIPT_PATH;
	return {
		...inherited,
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		GJCCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	} as Record<string, string>;
}

/**
 * Get shell args, optionally including login shell flag.
 *
 * Honors the documented `GJC_BASH_NO_LOGIN` first, with `PI_BASH_NO_LOGIN` and
 * `CLAUDE_BASH_NO_LOGIN` as legacy aliases. Boolean-like values follow the
 * canonical flag contract (`1`/`Y`/`TRUE`/`YES`/`ON`, case-insensitive), so an
 * explicit `GJC_BASH_NO_LOGIN=0` keeps the login shell even when a legacy alias
 * is set to a truthy value.
 */
function getShellArgs(): string[] {
	const noLogin = $pickflag("GJC_BASH_NO_LOGIN", "PI_BASH_NO_LOGIN", "CLAUDE_BASH_NO_LOGIN");
	return noLogin ? ["-c"] : ["-l", "-c"];
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 *
 * Resolved from trusted sources only. The prefix is interpolated ahead of every
 * bash command (`${prefix} ${command}`) and executed through the shell, so it is
 * an arbitrary-command-execution surface. `$env` merges the caller's
 * `cwd/.env`, which means repository content could otherwise set it; resolution
 * therefore goes through the non-project resolver (launching shell plus
 * GJC/user-owned `.env` files), matching how provider credentials are resolved.
 */
function getShellPrefix(): string | undefined {
	return $pickCredentialEnv("PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX");
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(): string | undefined {
	for (const name of ["bash", "bash.exe", "sh", "sh.exe"]) {
		const resolved = $which(name);
		if (resolved) return resolved;
	}

	if (process.platform !== "win32") {
		const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
		const candidates = ["bash", "sh"];

		for (const name of candidates) {
			for (const dir of searchPaths) {
				const fullPath = path.join(dir, name);
				if (fs.existsSync(fullPath)) return fullPath;
			}
		}
	}

	return undefined;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	// 1. Check user-specified shell path
	if (customShellPath) {
		if (fs.existsSync(customShellPath)) {
			cachedShellConfig = buildConfig(customShellPath);
			return cachedShellConfig;
		}
		throw new Error(
			`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.gjc/agent/settings.json`,
		);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = Bun.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = Bun.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (fs.existsSync(path)) {
				cachedShellConfig = buildConfig(path);
				return cachedShellConfig;
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = $which("bash.exe");
		if (bashOnPath) {
			cachedShellConfig = buildConfig(bashOnPath);
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				`  3. Set shellPath in ~/.gjc/agent/settings.json\n\n` +
				`Searched Git Bash in:\n${paths.map(p => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: prefer user's shell from $SHELL if it's bash/zsh and executable
	const userShell = Bun.env.SHELL;
	const isValidShell = userShell && (userShell.includes("bash") || userShell.includes("zsh"));
	if (isValidShell && isExecutable(userShell)) {
		cachedShellConfig = buildConfig(userShell);
		return cachedShellConfig;
	}

	// 4. Fallback: use basic shell
	const basicShell = resolveBasicShell();
	if (basicShell) {
		cachedShellConfig = buildConfig(basicShell);
		return cachedShellConfig;
	}
	cachedShellConfig = buildConfig("sh");
	return cachedShellConfig;
}

/**
 * Clear the memoized shell configuration so the next {@link getShellConfig}
 * call re-resolves the shell and re-reads the environment (shell selection and
 * the bash CI/login flags). Primarily for tests that vary those inputs.
 */
export function resetShellConfigCache(): void {
	cachedShellConfig = null;
}

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
	if (typeof pid !== "number") {
		if (pid.killed) return false;
		if (pid.exitCode !== null) return false;
		return true;
	}

	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

export async function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		return proc.exited.then(
			() => true,
			() => true,
		);
	}

	return (await Process.fromPid(proc)?.waitForExit({ signal: abortSignal })) ?? true;
}
