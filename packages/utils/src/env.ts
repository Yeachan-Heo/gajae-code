import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalEnvKey, getAgentDir, getConfigRootDir, getTrustedHomeDir, pathIdentityKey } from "./dirs";
import { isSafeEnvName, isSafeEnvValue } from "./spawn-env";

export { filterProcessEnv, isSafeEnvName, isSafeEnvValue } from "./spawn-env";

import {
	decodeEscapedProjectLiteral,
	parseEnvFile,
	parseEnvFileContent,
	parseShellEnvFile,
	projectDeclarationIsDynamic,
	projectEnvLayerFiles,
	projectEnvSnapshot,
} from "./env-file";

// Re-exported so the public surface of this module is unchanged.
export { isValidEnvName, parseEnvFile, parseShellEnvFile } from "./env-file";

function findClosingBrace(value: string, open: number): number {
	let depth = 1;
	for (let index = open + 2; index < value.length; index++) {
		if (value[index] === "\\") {
			index++;
			continue;
		}
		if (value[index] === "$" && value[index + 1] === "{") {
			depth++;
			index++;
		} else if (value[index] === "}" && --depth === 0) {
			return index;
		}
	}
	return -1;
}

function expandProjectEnvValue(value: string, resolve: (name: string) => string | undefined): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "\\" && value[index + 1] === "$") {
			result += "$";
			index++;
			continue;
		}
		if (char !== "$") {
			result += char;
			continue;
		}

		let name: string | undefined;
		let end = index;
		let fallback: string | undefined;
		if (value[index + 1] === "{") {
			const close = findClosingBrace(value, index);
			const expression = close < 0 ? undefined : value.slice(index + 2, close);
			const match = expression && /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(expression);
			if (match) {
				name = match[1];
				fallback = match[2];
				end = close;
			}
		} else {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(index + 1));
			if (match) {
				name = match[0];
				end = index + name.length;
			}
		}
		if (!name) {
			result += "$";
			continue;
		}
		result += resolve(name) ?? (fallback === undefined ? "" : expandProjectEnvValue(fallback, resolve));
		index = end;
	}
	return result;
}

function loadProjectEnv(): {
	values: Record<string, string>;
	loadedValues: Record<string, string>;
	dynamic: Set<string>;
} {
	const cwd = process.cwd();
	const nodeEnv = process.env.NODE_ENV || Bun.env.NODE_ENV;
	// Same file list as projectEnvSnapshot, so a loaded value stays project-controlled.
	const files = projectEnvLayerFiles(nodeEnv);
	const values: Record<string, string> = {};
	const dynamic = new Set<string>();
	for (const file of files) {
		const parsed = parseEnvFile(path.join(cwd, file));
		for (const [rawKey, value] of Object.entries(parsed)) {
			// Windows environment names are case-insensitive, so the guard lookups
			// below must see the same key Bun loaded into `process.env`.
			const key = canonicalEnvKey(rawKey);
			values[key] = value;
			// Track dynamic provenance only for the winning declaration.
			// Escaped dollars are literals, matching projectEnvSnapshot.
			if (projectDeclarationIsDynamic(value)) dynamic.add(key);
			else dynamic.delete(key);
		}
	}
	// Quoted escapes are not `$` or backticks, but Bun autoload decodes `\n`
	// and `\r` inside double quotes. `projectEnvSnapshot` already refuses that
	// shape. Union those keys. Do not copy its values: an unparsed declaration
	// is stored there as "" and must not overlay this layer. File selection
	// stays above, so a higher static layer still clears a lower dynamic one.
	for (const key of projectEnvSnapshot(cwd).dynamic) dynamic.add(key);

	const resolved = new Map<string, string>();
	const resolving = new Set<string>();
	const resolveProjectValue = (key: string): string | undefined => {
		const inherited = Bun.env[key];
		if (inherited !== undefined) return inherited;
		const cached = resolved.get(key);
		if (cached !== undefined) return cached;
		if (!Object.hasOwn(values, key) || resolving.has(key)) return undefined;

		resolving.add(key);
		const value = expandProjectEnvValue(values[key] ?? "", name => resolveProjectValue(canonicalEnvKey(name)));
		resolving.delete(key);
		resolved.set(key, value);
		return value;
	};
	for (const [key, value] of Object.entries(values)) {
		resolved.set(
			key,
			expandProjectEnvValue(value, name => resolveProjectValue(canonicalEnvKey(name))),
		);
	}
	// Expansion already read the raw text. Equality then uses Bun's decoded literal
	// for a declaration that is not dynamic, including an escaped dollar.
	for (const key of Object.keys(values)) {
		if (!dynamic.has(key)) values[key] = decodeEscapedProjectLiteral(values[key] ?? "");
	}
	return { values, loadedValues: Object.fromEntries(resolved), dynamic };
}

function resolveFileEnvValue(file: Record<string, string>, name: string): string | undefined {
	if (!isSafeEnvName(name)) return undefined;
	const value = file[canonicalEnvKey(name)];
	if (value === undefined || !isSafeEnvValue(value)) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

type TrustedAgentEnvRead =
	| { status: "missing"; values: Record<string, string> }
	| { status: "unavailable"; values: Record<string, string> }
	| { status: "ok"; values: Record<string, string> };

function readTrustedAgentEnv(): TrustedAgentEnvRead {
	let filePath: string;
	try {
		filePath = path.join(getAgentDir(), ".env");
	} catch {
		return { status: "unavailable", values: {} };
	}
	let fileDescriptor: number | undefined;
	try {
		const linkStats = fs.lstatSync(filePath);
		if (!linkStats.isFile()) return { status: "unavailable", values: {} };
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const fileStats = fs.fstatSync(fileDescriptor);
		if (!fileStats.isFile()) return { status: "unavailable", values: {} };
		const content = fs.readFileSync(fileDescriptor, "utf-8");
		return { status: "ok", values: parseEnvFileContent(content) };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		return code === "ENOENT" ? { status: "missing", values: {} } : { status: "unavailable", values: {} };
	} finally {
		if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
	}
}

function filterCredentialInheritedEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (!isSafeEnvName(key) || value === undefined || !isSafeEnvValue(value)) continue;

		// Bun may have already loaded cwd/.env before JS runs. It does not expose the
		// source of each entry, so a matching project declaration is ambiguous. A
		// dynamic dotenv declaration is also ambiguous even when expansion changes
		// its runtime value. Exclude those from the credential-only snapshot while
		// keeping them available through $env.
		const projectValue = resolveFileEnvValue(projectEnv, key);
		if (projectValue !== undefined && (projectSnapshot.dynamic.has(canonicalEnvKey(key)) || projectValue === value))
			continue;

		result[key] = value;
	}
	return result;
}

// Parse the current project's .env first. Bun may have overlaid HOME from it
// before this module runs, so a declared HOME must never select user credential
// files for the credential-only snapshot.
const projectSnapshot = loadProjectEnv();
const projectEnv = projectSnapshot.values;

/** Project dotenv as it was when this module loaded, before a later `chdir` or file delete. */
export function startupProjectEnvSnapshot(): { values: Record<string, string>; dynamic: Set<string> } {
	return { values: projectSnapshot.values, dynamic: projectSnapshot.dynamic };
}
const authoritativeHomeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
const declaredHomeKey = canonicalEnvKey(authoritativeHomeKey);
const declaredHome = projectEnv[declaredHomeKey];
const runtimeHome = process.env[authoritativeHomeKey];
const rejectProjectHome =
	declaredHome !== undefined &&
	runtimeHome !== undefined &&
	(projectSnapshot.dynamic.has(declaredHomeKey) || declaredHome === runtimeHome);
let trustedEnvHome: string | undefined;
try {
	trustedEnvHome = rejectProjectHome ? getTrustedHomeDir() : os.homedir();
} catch {
	// No trustworthy account home means no user credential files are trusted.
	trustedEnvHome = undefined;
}

// `path.resolve` does not follow symlinks, so macOS `/tmp` vs `/private/tmp`,
// a symlink home, or a bind mount compares unequal and would load the checkout
// as the trusted home. Keep the lexical check, then compare device/inode, then
// `pathIdentityKey` when the filesystem has no usable inode.
function credentialHomeMatchesCwd(home: string): boolean {
	const cwd = process.cwd();
	if (path.resolve(home) === path.resolve(cwd)) return true;
	try {
		const left = fs.statSync(home, { bigint: true });
		const right = fs.statSync(cwd, { bigint: true });
		if (left.isDirectory() && right.isDirectory() && left.ino !== 0n && right.ino !== 0n) {
			return left.dev === right.dev && left.ino === right.ino;
		}
	} catch {
		// Missing or unreadable: do not treat this directory as a credential home.
		return true;
	}
	return pathIdentityKey(home) === pathIdentityKey(cwd);
}

// Eagerly parse the trusted user's env files and the project .env (from cwd).
// When cwd is that home, both the dotenv and the shell startup files are the
// checkout, so neither is a credential source.
const credentialHomeIsCwd = trustedEnvHome !== undefined && credentialHomeMatchesCwd(trustedEnvHome);
const homeShellEnv =
	trustedEnvHome && !credentialHomeIsCwd
		? {
				...parseShellEnvFile(path.join(trustedEnvHome, ".zshenv")),
				...parseShellEnvFile(path.join(trustedEnvHome, ".zprofile")),
				...parseShellEnvFile(path.join(trustedEnvHome, ".zshrc")),
				...parseShellEnvFile(path.join(trustedEnvHome, ".bash_profile")),
				...parseShellEnvFile(path.join(trustedEnvHome, ".bashrc")),
			}
		: {};
const homeEnv = trustedEnvHome && !credentialHomeIsCwd ? parseEnvFile(path.join(trustedEnvHome, ".env")) : {};
let piEnv: Record<string, string> = {};
let agentEnv: Record<string, string> = {};
try {
	piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
	agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
} catch {
	// Keep credential resolution fail-closed when trusted user state is unavailable.
}
const initialTrustedAgentEnv = readTrustedAgentEnv();
const projectLoadedEnv: Record<string, string | undefined> = Object.fromEntries(
	Object.keys(projectEnv).map(key => [key, Bun.env[key]]),
);

const inheritedEnv = filterCredentialInheritedEnv(Bun.env);
const rotatingAgentEnvNames = new Set(Object.keys(agentEnv));

export function $inheritedEnv(name: string): string | undefined {
	const snapshotValue = resolveFileEnvValue(inheritedEnv, name);
	if (snapshotValue === undefined) return undefined;
	// The snapshot records provenance — this key was inherited from the launching
	// shell rather than the caller's cwd/.env — and pins the value so a later
	// in-process write cannot swap the credential we authenticate with. It is not
	// a cache that outlives the variable: once the key is removed from the live
	// environment it is no longer inherited, so deletion is honoured. Without
	// this, a credential present at import time can never be suppressed (tests
	// that clear provider env vars silently keep resolving the real credential).
	if (Bun.env[name] === undefined) return undefined;
	return snapshotValue;
}

function resolveLiveCredentialEnvValue(name: string): string | undefined {
	if (!isSafeEnvName(name)) return undefined;
	const value = Bun.env[name];
	if (value === undefined || !isSafeEnvValue(value)) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;

	if (
		Object.hasOwn(projectEnv, canonicalEnvKey(name)) &&
		resolveFileEnvValue(inheritedEnv, name) === undefined &&
		(projectSnapshot.dynamic.has(canonicalEnvKey(name)) ||
			trimmed === resolveFileEnvValue(projectEnv, name) ||
			trimmed === projectLoadedEnv[canonicalEnvKey(name)])
	) {
		return undefined;
	}

	return trimmed;
}

/**
 * Names a repository `.env` must not install into the process environment.
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate verification for every
 * fetch in the process, so a project `.env` pairing it with a proxy would expose
 * provider credentials to whoever answers the proxy.
 * `GJC_HARNESS_SOCKET_DIR` and `GJC_HARNESS_ROOT_REGISTRY_DIR` select the harness
 * control socket directory and the session-root registry. The harness reads both
 * from the process environment after this module loads, so a project `.env` must
 * not point either at a path the repository controls.
 * `PI_COMPILED` is the build script's `--define` marker for a standalone binary.
 * It is not a project setting: foreground `gjc sdk broker run` loads dotenv
 * in-process, and a repository-controlled true value must not be treated as
 * evidence that this process is that binary.
 * `GJC_SDK_DISABLE=1` is the operator opt-out for SDK hosting. Session startup
 * and the harness owner read it from the process environment after this module
 * loads, and they copy a value that is still set into the child environment.
 * A repository `.env` must not install it. A shell export is kept unless it is
 * the same string the project declares, or the project declaration is dynamic.
 * A dynamic declaration is ambiguous, so a different shell value is dropped too.
 * An escaped dollar is a literal, not a dynamic declaration.
 */
const PROJECT_DENIED_ENV_NAMES = [
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"GJC_HARNESS_SOCKET_DIR",
	"GJC_HARNESS_ROOT_REGISTRY_DIR",
	"PI_COMPILED",
	"GJC_SDK_DISABLE",
] as const;

// Bun may have loaded cwd/.env before JS runs. Drop a value the project declares
// (same provenance rule as the credential snapshot) and never copy it below.
// Removing `NODE_TLS_REJECT_UNAUTHORIZED` restores verification: Bun reads that
// switch per TLS connection. The same drop covers the harness directory names.
// A quoted escape is dynamic even when the line parser did not store a value.
for (const name of PROJECT_DENIED_ENV_NAMES) {
	const key = canonicalEnvKey(name);
	const declared = projectEnv[key];
	if (declared === undefined && !projectSnapshot.dynamic.has(key)) continue;
	const runtime = Bun.env[name];
	if (
		runtime !== undefined &&
		(projectSnapshot.dynamic.has(key) || runtime === declared || runtime.trim() === declared)
	) {
		delete Bun.env[name];
	}
}
const projectDeniedKeys = new Set<string>(PROJECT_DENIED_ENV_NAMES.map(canonicalEnvKey));

/**
 * Per-launch managed-owner context. Only a launcher or the managed-owner supervisor
 * sets these, for one exact child; a dotenv file in any layer is not a launch. The
 * copy below never installs them, so a process that loads this module cannot
 * acquire owner context it did not inherit. Inherited values are left untouched.
 */
const LAUNCHER_ONLY_ENV_NAMES = [
	"GJC_MANAGED_OWNER_CHILD_TOKEN",
	"GJC_MANAGED_OWNER_RUN_ID",
	"GJC_MANAGED_OWNER_INCARNATION",
	"GJC_MANAGED_OWNER_LAUNCH_BASELINE",
	"GJC_MANAGED_OWNER_REDACT_COMMAND",
	"GJC_MANAGED_OWNER_PREDECESSOR_TOKEN",
	"GJC_MANAGED_OWNER_PREDECESSOR_GENERATION",
	"GJC_MANAGED_OWNER_PREDECESSOR_RUN_ID",
	"GJC_MANAGED_OWNER_PREDECESSOR_INCARNATION",
	"GJC_MANAGED_OWNER_TRANSCRIPT_PATH",
	"GJC_TMUX_OWNER_STATE_DIR",
	"GJC_TMUX_OWNER_GENERATION",
	"GJC_TMUX_OWNER_SERVER_KEY",
	"GJC_TMUX_LAUNCHED",
] as const;
const launcherOnlyKeys = new Set<string>(LAUNCHER_ONLY_ENV_NAMES.map(canonicalEnvKey));

for (const file of [projectSnapshot.loadedValues, agentEnv, piEnv, homeEnv, homeShellEnv]) {
	for (const key in file) {
		if (file === projectSnapshot.loadedValues && projectDeniedKeys.has(key)) continue;
		if (launcherOnlyKeys.has(canonicalEnvKey(key))) continue;
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
 * Resolve a credential that may rotate in the trusted agent `.env` while this
 * process remains alive.
 *
 * Presence in the agent file establishes that file as the credential's
 * authority, even when the launching shell inherited an older value. This is
 * what lets an atomic token rotation repair a long-lived shell instead of
 * falling back to its revoked snapshot. Removal is authoritative too, so a
 * deleted token cannot silently reappear from that snapshot. Project `.env`
 * files are never consulted; shell values retain their normal precedence for
 * names the agent file does not own.
 */
export function $rotatingCredentialEnv(name: string): string | undefined {
	if (!isSafeEnvName(name)) return undefined;
	const agentRead = readTrustedAgentEnv();
	if (agentRead.status === "ok" && Object.hasOwn(agentRead.values, name)) rotatingAgentEnvNames.add(name);
	if (initialTrustedAgentEnv.status === "unavailable" && !rotatingAgentEnvNames.has(name)) return undefined;
	if (!rotatingAgentEnvNames.has(name)) return $credentialEnv(name);
	if (agentRead.status !== "ok") return undefined;
	return resolveFileEnvValue(agentRead.values, name);
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

function parsePositiveInteger(raw: string | undefined): number | undefined {
	const value = raw?.trim();
	if (!value || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, unsafe, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const parsed = parsePositiveInteger($env[name]);
	return parsed ?? defaultValue;
}

/** True when `BUN_ENV` or `NODE_ENV` is the string `test`. */
export function isBunTestRuntime(): boolean {
	return Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
}

/**
 * True when `moduleUrl` is a Bun standalone-binary module.
 * Bun rewrites `import.meta.url` for every module bundled into the executable
 * to an embedded virtual-filesystem path (`$bunfs`, `~BUN`, or `%7EBUN`).
 * This does not read the environment. `PI_COMPILED` is not evidence: a project
 * `.env` can declare it, and the launching shell can export it.
 */
export function isEmbeddedCompiledModule(moduleUrl: string = import.meta.url): boolean {
	return moduleUrl.includes("$bunfs") || moduleUrl.includes("~BUN") || moduleUrl.includes("%7EBUN");
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Prefers `PI_COMPILED` when the launching process already has it,
 * then {@link isEmbeddedCompiledModule}. Project dotenv cannot install
 * `PI_COMPILED`; callers that load a repository file must use
 * {@link isEmbeddedCompiledModule} so a shell export cannot redirect them.
 */
export function isCompiledBinary(): boolean {
	if (Bun.env.PI_COMPILED) return true;
	return isEmbeddedCompiledModule();
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

/** Resolve the first flag among keys that has a set value (GJC-first, PI fallback). Matches $flag semantics per key. */
export function $pickflag(...keys: string[]): boolean {
	for (const key of keys) {
		const value = $env[key]?.trim();
		if (value) return TRUTHY[value.toUpperCase()] === true;
	}
	return false;
}

/** Resolve the first positive integer among keys, else defaultValue (GJC-first). Set-but-invalid keys are skipped. */
export function $pickenvpos(keys: string[], defaultValue: number): number {
	for (const key of keys) {
		const parsed = parsePositiveInteger($env[key]);
		if (parsed !== undefined) return parsed;
	}
	return defaultValue;
}
