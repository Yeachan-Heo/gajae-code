import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalEnvKey, getAgentDir, getConfigRootDir, getTrustedHomeDir } from "./dirs";
import { isSafeEnvName, isSafeEnvValue } from "./spawn-env";

export { filterProcessEnv, isSafeEnvName, isSafeEnvValue } from "./spawn-env";

import { parseEnvFile, parseEnvFileContent, parseShellEnvFile } from "./env-file";

// Re-exported so the public surface of this module is unchanged.
export { isValidEnvName, parseEnvFile, parseShellEnvFile } from "./env-file";

function loadProjectEnv(): { values: Record<string, string>; dynamic: Set<string> } {
	const cwd = process.cwd();
	const nodeEnv = process.env.NODE_ENV || Bun.env.NODE_ENV;
	// Match Bun's dotenv precedence. Validate before interpolation so a hostile
	// NODE_ENV cannot introduce separators or `..` path segments.
	const validNodeEnv = nodeEnv && /^[A-Za-z0-9_-]+$/.test(nodeEnv) ? nodeEnv : undefined;
	const files = [
		".env",
		...(validNodeEnv ? [`.env.${validNodeEnv}`] : []),
		...(validNodeEnv !== "test" ? [".env.local"] : []),
		...(validNodeEnv ? [`.env.${validNodeEnv}.local`] : []),
	];
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
			if (/[$`]/.test(value)) dynamic.add(key);
			else dynamic.delete(key);
		}
	}
	return { values, dynamic };
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

// Eagerly parse the trusted user's env files and the project .env (from cwd)
const homeShellEnv = trustedEnvHome
	? {
			...parseShellEnvFile(path.join(trustedEnvHome, ".zshenv")),
			...parseShellEnvFile(path.join(trustedEnvHome, ".zprofile")),
			...parseShellEnvFile(path.join(trustedEnvHome, ".zshrc")),
			...parseShellEnvFile(path.join(trustedEnvHome, ".bash_profile")),
			...parseShellEnvFile(path.join(trustedEnvHome, ".bashrc")),
		}
	: {};
const homeEnv =
	trustedEnvHome && path.resolve(trustedEnvHome) !== path.resolve(process.cwd())
		? parseEnvFile(path.join(trustedEnvHome, ".env"))
		: {};
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

declare const endpointConfigurationBrand: unique symbol;

/** Opaque, immutable snapshot of endpoint-routing environment values. */
export type EndpointConfiguration = {
	readonly [endpointConfigurationBrand]: true;
};

const endpointRoutingEnvNames = new Set([
	"AZURE_OPENAI_RESOURCE_NAME",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_API_VERSION",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"CLAUDE_CODE_USE_FOUNDRY",
]);
const mergedEndpointRoutingEnvNames = new Set(["AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_API_VERSION"]);
const endpointConfigurationValues = new WeakMap<object, ReadonlyMap<string, string | undefined>>();

function isEndpointRoutingEnvName(name: string): boolean {
	return endpointRoutingEnvNames.has(name) || (name.endsWith("_BASE_URL") && isSafeEnvName(name));
}

function readLiveEndpointConfigurationValue(name: string): string | undefined {
	return mergedEndpointRoutingEnvNames.has(name) ? Bun.env[name] : $credentialEnv(name);
}

/**
 * Capture the effective endpoint-routing values under their existing source policies.
 * Credentials and ADC sources are deliberately not included.
 */
export function captureEndpointConfiguration(): EndpointConfiguration {
	const values = new Map<string, string | undefined>();
	for (const name of endpointRoutingEnvNames) values.set(name, readLiveEndpointConfigurationValue(name));

	// Enumerate the private trusted source snapshots plus the current runtime key
	// set, then ask the established resolver which value (if any) is effective.
	// Project-only keys can be candidates, but $credentialEnv continues to reject
	// them according to its existing provenance policy.
	const baseUrlNames = new Set([
		...Object.keys(inheritedEnv),
		...Object.keys(agentEnv),
		...Object.keys(piEnv),
		...Object.keys(homeEnv),
		...Object.keys(homeShellEnv),
		...Object.keys(Bun.env),
	]);
	for (const name of baseUrlNames) {
		if (name.endsWith("_BASE_URL") && isSafeEnvName(name)) values.set(name, $credentialEnv(name));
	}

	const handle = Object.freeze(Object.create(null)) as EndpointConfiguration;
	endpointConfigurationValues.set(handle, values);
	return handle;
}

/** Validate a supplied handle before handing it to any downstream consumer. */
export function assertEndpointConfiguration(configuration?: EndpointConfiguration): void {
	if (configuration === undefined) return;
	if (
		(typeof configuration !== "object" && typeof configuration !== "function") ||
		configuration === null ||
		!Object.isFrozen(configuration) ||
		!endpointConfigurationValues.has(configuration)
	) {
		throw new TypeError("Invalid endpoint configuration handle");
	}
}

/**
 * Read a captured routing value, or use the established live source policy when
 * no capture was supplied. A valid capture never falls back to live state.
 */
export function readEndpointConfiguration(
	configuration: EndpointConfiguration | undefined,
	name: string,
): string | undefined {
	if (!isEndpointRoutingEnvName(name)) throw new TypeError(`Not an endpoint-routing environment variable: ${name}`);
	assertEndpointConfiguration(configuration);
	if (configuration === undefined) return readLiveEndpointConfigurationValue(name);
	return endpointConfigurationValues.get(configuration)?.get(name);
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
