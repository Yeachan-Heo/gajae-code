import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir } from "./dirs";
import { isSafeEnvName, isSafeEnvValue } from "./spawn-env";

export { filterProcessEnv, isSafeEnvName, isSafeEnvValue } from "./spawn-env";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

function stripInlineShellComment(value: string): string {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
			return value.slice(0, i).trimEnd();
		}
	}
	return value.trimEnd();
}

/**
 * Parses simple POSIX shell environment assignments from files such as
 * ~/.zshrc without executing user shell code. Supports `export KEY=value` and
 * `KEY=value`, including single/double quoted literal values. Dynamic shell
 * expressions are intentionally ignored because evaluating startup files would
 * run arbitrary code during CLI startup.
 */
export function parseShellEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
			if (!match) continue;

			const key = match[1];
			if (!isValidEnvName(key)) continue;

			let value = stripInlineShellComment(match[2] ?? "").trim();
			if (value.endsWith(";")) value = value.slice(0, -1).trimEnd();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;
			if (/[$`]/.test(value)) continue;

			result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	return result;
}

/**
 * Parses a .env file synchronously and extracts key-value string pairs.
 * Ignores lines that are empty or start with '#'. Trims whitespace.
 * Allows values to be quoted with single or double quotes.
 * Returns an object of key-value pairs.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			// Skip comments and blank lines
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			if (!isValidEnvName(key)) continue;

			let value = trimmed.slice(eqIndex + 1).trim();

			// Remove surrounding quotes (" or ')
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;

			result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	return result;
}

function resolveFileEnvValue(file: Record<string, string>, name: string): string | undefined {
	if (!isSafeEnvName(name)) return undefined;
	const value = file[name];
	if (value === undefined || !isSafeEnvValue(value)) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function filterCredentialInheritedEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (!isSafeEnvName(key) || value === undefined || !isSafeEnvValue(value)) continue;

		// Bun may have already loaded cwd/.env before JS runs. It does not expose the
		// source of each entry, so an exact match with projectEnv is ambiguous. Use
		// the safer credential rule: ambiguous project matches are excluded from the
		// credential-only inherited snapshot, while remaining available through $env.
		const projectValue = resolveFileEnvValue(projectEnv, key);
		if (projectValue !== undefined && projectValue === value) continue;

		result[key] = value;
	}
	return result;
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeShellEnv = {
	...parseShellEnvFile(path.join(os.homedir(), ".zshenv")),
	...parseShellEnvFile(path.join(os.homedir(), ".zprofile")),
	...parseShellEnvFile(path.join(os.homedir(), ".zshrc")),
	...parseShellEnvFile(path.join(os.homedir(), ".bash_profile")),
	...parseShellEnvFile(path.join(os.homedir(), ".bashrc")),
};
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

const inheritedEnv = filterCredentialInheritedEnv(Bun.env);

export function $inheritedEnv(name: string): string | undefined {
	return resolveFileEnvValue(inheritedEnv, name);
}

function resolveLiveCredentialEnvValue(name: string): string | undefined {
	if (!isSafeEnvName(name)) return undefined;
	const value = Bun.env[name];
	if (value === undefined || !isSafeEnvValue(value)) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;

	const projectValue = resolveFileEnvValue(projectEnv, name);
	if (
		projectValue !== undefined &&
		projectValue === trimmed &&
		resolveFileEnvValue(inheritedEnv, name) === undefined
	) {
		return undefined;
	}

	return trimmed;
}

for (const file of [projectEnv, agentEnv, piEnv, homeEnv, homeShellEnv]) {
	for (const key in file) {
		if (!Bun.env[key]) {
			Bun.env[key] = file[key];
		}
	}
}

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@gajae-code/utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 *
 * Provider credential resolution must not use this merged view because it includes the
 * caller's cwd/.env. Use $credentialEnv/$pickCredentialEnv for model authentication.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Resolve credential-bearing environment variables without consulting the caller's project .env.
 *
 * GJC loads cwd/.env into $env for project-aware tools, but model-provider authentication should
 * only use values explicitly inherited from the launching shell or GJC/user-owned config files.
 */
export function $credentialEnv(name: string): string | undefined {
	return (
		$inheritedEnv(name) ??
		resolveLiveCredentialEnvValue(name) ??
		resolveFileEnvValue(agentEnv, name) ??
		resolveFileEnvValue(piEnv, name) ??
		resolveFileEnvValue(homeEnv, name) ??
		resolveFileEnvValue(homeShellEnv, name)
	);
}

/**
 * Resolve the first credential env value from the given keys, excluding cwd/.env overlays.
 */
export function $pickCredentialEnv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = $credentialEnv(key);
		if (value) return value;
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, NaN, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

/** True when `BUN_ENV` or `NODE_ENV` is the string `test`. */
export function isBunTestRuntime(): boolean {
	return Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `PI_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = { "1": true, Y: true, TRUE: true, YES: true, ON: true };
export function $flag(name: string, def: boolean = false): boolean {
	const value = $env[name]?.trim();
	if (!value) return def;
	// Boolean-like env values are documented as case-insensitive (`1`/`true`/`yes`/`on`),
	// so normalize before the lookup — otherwise `FOO=true` (the common lowercase spelling)
	// would silently read as false while only `FOO=TRUE`/`FOO=1` worked.
	return TRUTHY[value.toUpperCase()] === true;
}
