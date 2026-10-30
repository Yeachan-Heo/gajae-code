import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalEnvKey, getTrustedHomeDir } from "./dirs";
import {
	$credentialEnv,
	$inheritedEnv,
	$pickCredentialEnv,
	$pickflag,
	filterProcessEnv,
	startupProjectEnvSnapshot,
} from "./env";
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
 * Variables that make the shell, Bun, or git run code on their own. Bun's
 * `BUN_OPTIONS` can preload code before a source-mode worker entrypoint; bash
 * sources `BASH_ENV` (sh: `ENV`) before every non-interactive command, and zsh
 * sources `$ZDOTDIR/.zshenv`. git applies `GIT_CONFIG_*`, reads config from
 * `GIT_DIR`/`GIT_COMMON_DIR`, `$XDG_CONFIG_HOME/git/config` and `$HOME/.gitconfig`;
 * on Windows it can also derive its home from `USERPROFILE`, `HOMEDRIVE` and
 * `HOMEPATH`. It runs e.g. `core.fsmonitor` during `git status` and helpers from
 * `GIT_EXEC_PATH`, `GIT_PROXY_COMMAND` for `git://` remotes,
 * `GIT_EXTERNAL_DIFF`, `GIT_SSH(_COMMAND)`, `GIT_ASKPASS` (auth prompts, even
 * with `GIT_TERMINAL_PROMPT=0`), and, when neither `GIT_ASKPASS` nor
 * `core.askPass` is set, `SSH_ASKPASS` (also ssh's own passphrase and host-key
 * prompt program) and `GIT_SEQUENCE_EDITOR` (`git rebase -i`).
 * `GIT_TEMPLATE_DIR` can also seed executable hooks when `git init` creates a
 * repository. Interpreters the shell starts also load code named by the
 * environment: Node `NODE_OPTIONS` (`--require`), Python `PYTHONPATH`
 * (`sitecustomize`), `PYTHONUSERBASE` (`usercustomize`), and `PYTHONSTARTUP`
 * (interactive startup), Perl `PERL5OPT`/`PERL5LIB` (`-M`), the JVM
 * `JAVA_TOOL_OPTIONS`/`JDK_JAVA_OPTIONS` (`-javaagent`). The dynamic loader
 * runs code for every dynamically linked command from `LD_PRELOAD` and `LD_AUDIT` modules, and
 * resolves libraries from `LD_LIBRARY_PATH` first, so a project directory there
 * can shadow a system library (macOS: `DYLD_INSERT_LIBRARIES` and the
 * `DYLD_*_LIBRARY_PATH`/`DYLD_*_FRAMEWORK_PATH` search overrides). Sibling
 * spellings load the same code: Perl `PERLLIB`, the JVM `_JAVA_OPTIONS`, and npm
 * `npm_config_node_options` (matched separately below, in any case). Common tools also read programs from the
 * environment: ripgrep `RIPGREP_CONFIG_PATH` (a config file that can add
 * `--pre=<program>`), GNU tar `TAR_OPTIONS` (`--use-compress-program`,
 * `--to-command`), rsync `RSYNC_RSH`, make `MAKEFLAGS` (`SHELL=`) and
 * `MAKEFILES` (a makefile with `$(shell …)`), and bash `SHELLOPTS`, which turns on
 * `xtrace` so `PS4` command substitutions run in every `bash -c`. A repository
 * `.env` must not be able to set them, or bash tool commands could execute
 * repository code.
 */
const PROJECT_DENIED_SPAWN_ENV =
	/^(?:BASH_ENV|BUN_OPTIONS|ENV|ZDOTDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_SEQUENCE_EDITOR|GIT_TEMPLATE_DIR|NODE_OPTIONS|PYTHONPATH|PYTHONUSERBASE|PYTHONSTARTUP|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|PERLLIB|RIPGREP_CONFIG_PATH|TAR_OPTIONS|RSYNC_RSH|MAKEFLAGS|MAKEFILES|SHELLOPTS|PS4|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|DYLD_(?:INSERT_LIBRARIES|LIBRARY_PATH|FALLBACK_LIBRARY_PATH|FRAMEWORK_PATH|FALLBACK_FRAMEWORK_PATH|VERSIONED_LIBRARY_PATH|VERSIONED_FRAMEWORK_PATH)|GIT_CONFIG_(?:COUNT|PARAMETERS|GLOBAL|SYSTEM|KEY_\d+|VALUE_\d+))$/;
/**
 * npm reads `npm_config_<key>` with the prefix in any case and normalizes the key
 * (case and `_`/`-`), so `npm_config_Node_Options` and `npm_config_node-options`
 * both set `node-options`, which npm hands to the Node processes it starts as
 * `NODE_OPTIONS`, and `script-shell` picks the program every lifecycle script
 * (`npm run`, `npm test`, install hooks) runs through.
 */
const PROJECT_DENIED_NPM_SPAWN_ENV = /^npm_config_(?:node[_-]options|script[_-]shell)$/i;
const PROJECT_HOME_SPAWN_ENV = new Set(["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);

/**
 * Names of hook-capable variables whose live value came from the project `.env`.
 *
 * Provenance comes from `$inheritedEnv`, the same launch snapshot that guards
 * credentials: a value the launching shell exported with a different value than
 * the project declaration is kept. Bun does not reveal which source supplied a
 * value, so an inherited value the project repeats verbatim, or a key the project
 * declares dynamically, is ambiguous and fails closed (dropped).
 */
export function projectDeclaredSpawnHookNames(env: Record<string, string | undefined> = Bun.env): string[] {
	const snapshot = startupProjectEnvSnapshot();
	const names: string[] = [];
	for (const name of Object.keys(env)) {
		const key = canonicalEnvKey(name);
		const dynamic = snapshot.dynamic.has(key);
		const denied = PROJECT_DENIED_SPAWN_ENV.test(key) || PROJECT_DENIED_NPM_SPAWN_ENV.test(key);
		if (!denied || (snapshot.values[key] === undefined && !dynamic)) continue;
		if (env[name] === undefined || (!dynamic && $inheritedEnv(name) !== undefined)) continue;
		names.push(name);
	}
	return names;
}

/** The account home GJC trusts, or undefined when none is trustworthy. */
function trustedHome(): string | undefined {
	try {
		return getTrustedHomeDir();
	} catch {
		return undefined;
	}
}

/**
 * Remove project-declared hook variables from a spawn environment in place.
 * If removing a home selector leaves `HOME` unset, provide the trusted account
 * home when one exists rather than allowing a Windows profile fallback.
 */
export function stripProjectSpawnHooks(env: Record<string, string>): Record<string, string> {
	const removed = projectDeclaredSpawnHookNames(env);
	for (const name of removed) delete env[name];
	const removedHomeSelector = removed.some(name => PROJECT_HOME_SPAWN_ENV.has(canonicalEnvKey(name)));
	if ((env.HOME === undefined || env.HOME === "") && (process.platform !== "win32" || removedHomeSelector)) {
		const home = trustedHome();
		if (home !== undefined) env.HOME = home;
		else delete env.HOME;
	}
	return env;
}

/**
 * The process environment without project-declared hook variables, for spawning
 * the bash tool's shell processes (isolated worker chain and PTY sessions).
 */
export function projectSafeSpawnEnv(): Record<string, string> {
	return stripProjectSpawnHooks(filterProcessEnv(Bun.env));
}

/** Provide the trusted HOME override needed when PTY hook filtering removes a home selector. */
export function projectSafeHomeOverride(explicit?: Record<string, string>): Record<string, string> {
	if (Object.hasOwn(explicit ?? {}, "HOME")) return {};
	const removesHomeSelector = projectDeclaredSpawnHookNames().some(
		name => !Object.hasOwn(explicit ?? {}, name) && PROJECT_HOME_SPAWN_ENV.has(canonicalEnvKey(name)),
	);
	if (!removesHomeSelector) return {};
	const home = projectSafeSpawnEnv().HOME;
	return home === undefined ? {} : { HOME: home };
}

/**
 * Build the spawn environment (cached).
 *
 * The spawn environment is the inherited process environment plus the fixed
 * hardening entries below. `CI` is not injected: a process that did not export
 * it must not look like CI to the tools it runs.
 */
function buildSpawnEnv(shell: string): Record<string, string> {
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
	// Bun fills an unset SHELL from cwd/.env, so read only the launching shell's value.
	const userShell = $credentialEnv("SHELL");
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
