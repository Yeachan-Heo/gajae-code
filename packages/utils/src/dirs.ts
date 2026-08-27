/**
 * Centralized path helpers for gajae-code config directories.
 *
 * Uses GJC_CONFIG_DIR (legacy alias PI_CONFIG_DIR, default ".gjc") for the
 * config root and GJC_CODING_AGENT_DIR (legacy alias PI_CODING_AGENT_DIR) to
 * override the agent directory.
 *
 * On Linux, if XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME environment
 * variables are set, paths are redirected to XDG-compliant locations under
 * $XDG_*_HOME/gjc/. This requires running `gjc config migrate` first to
 * move data to the new locations. No filesystem existence checks are performed
 * — if the env var is set, gjc trusts that the migration has been done.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };
import { parseEnvFile } from "./env-file";

/** App name (e.g. "gjc") */
export const APP_NAME: string = "gjc";

/** Config directory name (e.g. ".gjc") */
export const CONFIG_DIR_NAME: string = ".gjc";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

/**
 * Build the diagnostic shown when the Bun runtime executing `gjc` is older
 * than {@link MIN_BUN_VERSION}. This is the most common Windows native-install
 * failure (issue #525): `bun install -g gajae-code` probes a recent Bun while
 * the `gjc` launcher resolves an older Bun still on PATH. The message names the
 * exact detected runtime path and gives a platform-specific upgrade + PATH fix
 * instead of a bare `bun upgrade`.
 *
 * Pure and platform-parameterized so it can be unit-tested cross-platform.
 */
export function formatBunRuntimeError(opts: {
	currentVersion: string;
	minVersion: string;
	execPath?: string;
	platform?: NodeJS.Platform;
}): string {
	const platform = opts.platform ?? process.platform;
	const lines = [
		`error: ${APP_NAME} requires Bun >= ${opts.minVersion}, but the running Bun is v${opts.currentVersion}.`,
	];
	if (opts.execPath) {
		lines.push(`  detected Bun runtime: ${opts.execPath}`);
	}
	if (platform === "win32") {
		lines.push(
			"",
			"The 'gjc' launcher is using an older Bun than the one used to install it.",
			"Upgrade Bun, then restart your terminal so PATH and the runtime refresh:",
			"",
			'  powershell -c "irm bun.sh/install.ps1|iex"',
			"",
			"After restarting the terminal, verify both versions match:",
			"  bun --version",
			"  gjc --version",
			"",
			"If 'gjc' still loads the old runtime, make sure %USERPROFILE%\\.bun\\bin is",
			"first on PATH and remove any stale Bun installs shadowing it.",
		);
	} else {
		lines.push(
			"",
			"Upgrade Bun, then restart your terminal:",
			"  bun upgrade",
			"",
			"Then verify:",
			"  bun --version",
			"  gjc --version",
		);
	}
	return `${lines.join("\n")}\n`;
}

// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
export function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string, platform: NodeJS.Platform = process.platform): string {
	const pathApi = platform === "win32" ? path.win32 : path;
	const resolvedPath = platform === process.platform ? resolveEquivalentPath(inputPath) : pathApi.resolve(inputPath);
	return platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

/** Return whether a relative path crosses above its root or is unexpectedly absolute. */
export function relativePathEscapesRoot(relative: string): boolean {
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return !relativePathEscapesRoot(relative);
}

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	const resolved = standardizeMacOSPath(path.resolve(dir));
	process.chdir(resolved);
	projectDir = standardizeMacOSPath(process.cwd());
}

/**
 * Reject a configured config-directory name that would escape the home-relative
 * root it is documented to stay under.
 *
 * The configured value names a directory beneath `<home>` — the discovery docs
 * state that "even an absolute-looking configured name is joined beneath
 * `<home>`", which `path.join` delivers for a leading separator but not for
 * `..` segments. Consumers join this name with `<home>` (and with project
 * ancestors) to locate user-level `mcp.json`, `SYSTEM.md`, skills, agents and
 * installed plugins, so a `..` segment would point that discovery at a
 * directory outside the config root entirely. Fall back to the default name
 * instead of honoring an escaping value.
 */
function sanitizeConfigDirName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (path.normalize(trimmed).split(/[\\/]/).includes("..")) return undefined;
	return trimmed;
}

/**
 * Windows environment variable names are case-insensitive, so a project dotenv
 * line `userprofile=...` is what `process.env.USERPROFILE` resolves to. Every
 * provenance lookup here is spelled in upper case, so the snapshot must be
 * keyed the same way or the declaration is invisible to the guard while still
 * being live in the process. POSIX names are case-sensitive and must not fold.
 */
export function canonicalEnvKey(name: string): string {
	return process.platform === "win32" ? name.toUpperCase() : name;
}

function projectEnvSnapshot(cwd = process.cwd()): { values: Record<string, string>; dynamic: Set<string> } {
	const nodeEnv = process.env.NODE_ENV;
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
		for (const [rawKey, value] of Object.entries(parseEnvFile(path.join(cwd, file)))) {
			const key = canonicalEnvKey(rawKey);
			values[key] = value;
			if (/[$`]/.test(value)) dynamic.add(key);
			else dynamic.delete(key);
		}
	}
	return { values, dynamic };
}

/**
 * Resolve an environment value only when it is not supplied by the caller's
 * project dotenv (or when the inherited value is observably distinct).
 *
 * The name is joined with the home directory to build the config root, and that
 * root plus the agent directory beneath it supply two of the `.env` files
 * `$credentialEnv` treats as trusted. Bun loads `cwd/.env` into `process.env`
 * before any module runs, so a repository could otherwise point the config root
 * at a directory it ships and have its own `.env` treated as trusted —
 * recovering every endpoint and credential redirect the boundary rejects.
 *
 * `env.ts` imports this module, so the check cannot go through `$credentialEnv`;
 * it applies the same conservative ambiguity rule directly: a value that matches
 * what the project `.env` sets is not honoured. An operator whose environment
 * happens to carry the identical value loses the override, which is the same
 * trade-off `resolveLiveCredentialEnvValue` already makes.
 */
function trustedValue(
	name: string,
	project: { values: Record<string, string>; dynamic: Set<string> },
): string | undefined {
	const value = process.env[name];
	if (!value) return undefined;
	const key = canonicalEnvKey(name);
	const projectValue = project.values[key];
	if (projectValue !== undefined && (project.dynamic.has(key) || projectValue === value)) return undefined;
	return value;
}

function resolveConfigDirName(project: { values: Record<string, string>; dynamic: Set<string> }): string {
	return (
		sanitizeConfigDirName(trustedValue("GJC_CONFIG_DIR", project)) ??
		sanitizeConfigDirName(trustedValue("PI_CONFIG_DIR", project)) ??
		CONFIG_DIR_NAME
	);
}

/**
 * A home directory is usable only when it is absolute and resolves to somewhere
 * strictly below a filesystem root. A relative value would anchor user state
 * beneath whatever the current directory happens to be, and a root would place
 * it at `/.gjc`.
 *
 * The root test normalizes first, because a root has many spellings: `/.`, `//`,
 * `/foo/..` and `C:\x\..` are all roots that a raw string comparison against
 * `path.parse(home).root` misses, and `path.join(home, ".gjc")` would happily
 * produce `/.gjc` from every one of them.
 *
 * The **original spelling** is returned, never the normalized form. Provenance
 * compares the declared dotenv value against this result, and both sides must
 * stay in the same spelling: canonicalizing only this side would make
 * `HOME=/tmp/base/../attacker` compare unequal to its own declaration and let a
 * project-planted home through as if it were operator-supplied.
 */
function usableHome(home: string | undefined): string | undefined {
	if (!home || !path.isAbsolute(home)) return undefined;
	const normalized = path.resolve(home);
	return normalized === path.parse(normalized).root ? undefined : home;
}

/**
 * The account home for the running uid, read through the operating system's own
 * account database.
 *
 * On Linux this must go through NSS rather than parsing `/etc/passwd`: LDAP and
 * SSSD accounts have no local passwd entry, and a direct file read would miss
 * them and fall through to an environment-derived value. `getent passwd` is the
 * NSS front end, so it resolves local and directory-backed accounts alike.
 *
 * Only an **environment-independent** result is memoized, and only on success.
 * The cache is keyed by the effective account identity, not by process lifetime:
 * a setuid or container identity transition must never reuse another uid's home.
 * The NSS answer cannot change during one identity's process lifetime, so
 * per-identity caching is safe.
 * The `os.userInfo()` fallback is different: Bun derives `homedir` from `$HOME`,
 * so caching it would freeze one side of the independence comparison in
 * {@link resolveTrustedHome}. A planted home that was live at first resolution
 * would stay cached, and once the runtime home moved it would no longer *equal*
 * the runtime home -- passing the echo check and being promoted to independent
 * evidence. Provenance is carried with the value so that can never happen.
 */
type AccountHome = { home: string; envDerived: boolean };
type AccountIdentity = { key: string; uid: number };

const accountHomeCache = new Map<string, AccountHome>();

function accountIdentity(info: os.UserInfo<string>): AccountIdentity {
	const uid = process.platform === "win32" ? info.uid : (process.geteuid?.() ?? info.uid);
	return {
		key: `${process.platform}:uid=${uid}:user=${info.username}`,
		uid,
	};
}

/** The uid's home field from the NSS account database, or undefined. */
function nssAccountHome(uid: number): string | undefined {
	try {
		// Spawned with an empty environment so nothing the caller controls (HOME,
		// NSS module configuration, locale) can steer the answer.
		const result = Bun.spawnSync({
			cmd: ["getent", "passwd", String(uid)],
			env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return undefined;
		// `getent` echoes passwd-format records; the home directory is field 6.
		const line = new TextDecoder().decode(result.stdout).split("\n")[0];
		return usableHome(line?.split(":")[5]);
	} catch {
		return undefined;
	}
}

function accountHomeFromSystem(): AccountHome | undefined {
	try {
		const info = os.userInfo();
		const identity = accountIdentity(info);
		const cached = accountHomeCache.get(identity.key);
		if (cached !== undefined) return cached;
		if (process.platform === "linux") {
			const nss = nssAccountHome(identity.uid);
			if (nss !== undefined) {
				// NSS is environment-independent and stable: safe to memoize.
				const result = { home: nss, envDerived: false };
				accountHomeCache.set(identity.key, result);
				return result;
			}
		}
		// `os.userInfo().homedir` is the portable path for macOS and Windows, and on
		// Linux is reached only when NSS is unavailable. Bun derives it from `$HOME`,
		// so it is re-read every time and never cached, and it is flagged so the
		// caller can refuse to treat it as independent evidence.
		const fallback = usableHome(info.homedir);
		if (fallback !== undefined) return { home: fallback, envDerived: true };
	} catch {
		// Do not retain or consult a prior identity's result when the current
		// identity cannot be observed. An unavailable uid is not evidence for any
		// other uid and must fail closed instead of inheriting stale state.
		return undefined;
	}
	return undefined;
}

/**
 * Resolve the authoritative home for user-scope state.
 *
 * Two properties must hold together, and pinning either one alone breaks the
 * other (issue #4761):
 *
 * 1. **Provenance.** Bun overlays a checkout's `.env` into `process.env` before
 *    any module runs, so a repository can plant HOME/USERPROFILE and redirect
 *    user state — including the `.env` files `$credentialEnv` treats as trusted.
 *    When the platform-authoritative variable is indistinguishable from the
 *    value the project dotenv declares, the OS account database wins instead.
 * 2. **Call-time resolution.** The trusted home is *derived*, never snapshotted
 *    at module load. A resolution frozen at import silently loses every
 *    user-scope location whenever the runtime home is established or changed
 *    after this module initializes — which is exactly how user-scope skill and
 *    MCP discovery regressed.
 *
 * `os.homedir()` is the runtime candidate: on POSIX it reflects HOME, on Windows
 * USERPROFILE, and it falls back to the account database on its own. Reading it
 * per call is what makes the contract call-time; the provenance comparison above
 * is what keeps an untrusted mutable home from being honored.
 */
function resolveTrustedHome(project: { values: Record<string, string>; dynamic: Set<string> }): string {
	const authoritativeHomeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
	const declaredHomeKey = canonicalEnvKey(authoritativeHomeKey);
	const declaredHome = project.values[declaredHomeKey];
	// A relative or filesystem-root runtime home would anchor user state beneath
	// the current directory (or at `/`), so it is not a usable candidate no matter
	// how it was supplied. Validate it exactly as the account home is validated.
	const runtimeHome = usableHome(os.homedir());
	// Only the platform-authoritative variable can select the home. In particular,
	// do not let the opposite platform variable (or a project dotenv value
	// overlaid into it) redirect user state when this is absent.
	const ambiguousHome =
		declaredHome !== undefined && (project.dynamic.has(declaredHomeKey) || declaredHome === runtimeHome);
	// The account lookup is consulted lazily. It can spawn the NSS front end, and
	// this resolver runs on every directory access, so an unambiguous runtime home
	// -- the ordinary CLI path -- must never pay for it.
	if (!ambiguousHome && runtimeHome !== undefined) return runtimeHome;

	const accountHome = accountHomeFromSystem();
	if (ambiguousHome) {
		// The account home is independent evidence only when it is not itself derived
		// from the environment. An `os.userInfo()` fallback echoes `$HOME`, so a
		// project-declared home would otherwise come back as its own justification.
		// Fail closed: with no independent evidence the resolver yields a filesystem
		// root, which `#homeAvailable` rejects, rather than honoring the declared
		// home. Issue #4773 owns widening that fallback; do not weaken it here.
		if (accountHome === undefined || accountHome.envDerived) return path.parse(process.cwd()).root;
		return accountHome.home;
	}
	// No usable runtime home: fall back to whatever the account database reports.
	if (accountHome !== undefined) return accountHome.home;
	throw new Error("Unable to determine a trustworthy account home directory");
}
export function getConfigAgentDirName(): string {
	return `${getConfigDirName()}/agent`;
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * Resolves and caches all gajae-code directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/gjc/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 *
 * The trusted home is re-derived on each access (see {@link resolveTrustedHome})
 * and every cached path is rebuilt when it changes, so a home established or
 * mocked after module load is honored without weakening the provenance rule.
 */
class DirResolver {
	configRoot: string;
	agentDir: string;
	readonly #projectEnv: { values: Record<string, string>; dynamic: Set<string> };
	#configDirName: string;
	readonly #agentDirOverride: boolean;
	#trustedHome: string;
	/**
	 * Whether this resolver's agent directory may follow `$XDG_*_HOME`, decided
	 * once at construction and never re-derived from the path afterwards.
	 */
	#xdgEligible: boolean;

	// Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
	// With XDG on Linux, they point to $XDG_*_HOME/gjc/.
	#rootDirs: Record<XdgCategory, string>;
	#agentDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(agentDirOverride?: string, snapshot = projectEnvSnapshot()) {
		this.#projectEnv = snapshot;
		this.#configDirName = resolveConfigDirName(snapshot);
		this.#trustedHome = resolveTrustedHome(snapshot);
		this.configRoot = path.join(this.#trustedHome, this.#configDirName);

		const defaultAgent = path.join(this.configRoot, "agent");
		this.#agentDirOverride = Boolean(agentDirOverride);
		this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
		// An agent directory equal to the home-derived default *is* the default
		// profile, XDG categories included, however it arrived.
		//
		// Deciding this from override state instead was tried and reverted: it is
		// unobservably wrong. `setAgentDir()` exports `GJC_CODING_AGENT_DIR`, so a
		// child process inherits the same value the parent set programmatically and
		// cannot tell the two apart. Treating the inherited form as "not default"
		// put parent and child on different storage lanes for one logical profile --
		// the parent reading `$XDG_STATE_HOME/gjc/python-gateway` while the child
		// read `<agentDir>/python-gateway`. Splitting a live store in half is worse
		// than the narrower complaint it was meant to answer.
		const isDefault = this.agentDir === defaultAgent;
		// That decision is then *sticky*. Recomputing it later from path shape is
		// what let a pinned agent directory silently change storage lane when a home
		// refresh made it coincide with the new default: `getAgentDir()` looked
		// unchanged while `agent.db` moved into `$XDG_DATA_HOME/gjc`.
		this.#xdgEligible = isDefault;

		this.#rootDirs = { data: this.configRoot, state: this.configRoot, cache: this.configRoot };
		this.#agentDirs = { data: this.agentDir, state: this.agentDir, cache: this.agentDir };
		this.refreshCategoryDirs(snapshot, isDefault);
	}

	/**
	 * `isDefault` decides whether the agent directory may follow `$XDG_*_HOME`.
	 *
	 * It is always supplied by the caller and never defaulted: the only correct
	 * value is the construction-time decision held in `#xdgEligible`, and
	 * re-deriving it from path shape is exactly the bug that let a directory
	 * change storage lane when a home refresh made its path coincide with the
	 * new default.
	 */
	private refreshCategoryDirs(
		snapshot: { values: Record<string, string>; dynamic: Set<string> },
		isDefault: boolean,
	): void {
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = trustedValue(envVar, snapshot);
				if (!value) return undefined;
				try {
					const joined = path.join(value, APP_NAME);
					return fs.existsSync(joined) ? joined : undefined;
				} catch {
					return undefined;
				}
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}
		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/**
	 * Re-derive the trusted home and the caller-supplied config-dir override
	 * without replacing the trust snapshot.
	 *
	 * Both inputs are call-time: the home comes from {@link resolveTrustedHome}
	 * (provenance-checked, never an import-time snapshot) and the config-dir name
	 * from the trusted-value rule. When either changes, the config root, the
	 * default agent dir, the XDG category dirs and both path caches are rebuilt
	 * so reads and writes cannot straddle two different homes.
	 */
	refreshConfigDirOverride(): void {
		const nextConfigDirName = resolveConfigDirName(this.#projectEnv);
		const nextHome = resolveTrustedHome(this.#projectEnv);
		if (nextConfigDirName === this.#configDirName && nextHome === this.#trustedHome) return;
		const nextConfigRoot = path.join(nextHome, nextConfigDirName);
		const nextAgentDir = this.#agentDirOverride ? this.agentDir : path.join(nextConfigRoot, "agent");
		this.#trustedHome = nextHome;
		this.#configDirName = nextConfigDirName;
		this.configRoot = nextConfigRoot;
		this.agentDir = nextAgentDir;
		// Reuse the construction-time decision rather than re-deriving it, so an
		// agent directory never changes storage lane just because a home refresh made
		// its path coincide with (or diverge from) the new default.
		this.refreshCategoryDirs(this.#projectEnv, this.#xdgEligible);
		this.#rootCache.clear();
		this.#agentCache.clear();
	}

	/** Whether the resolved home is a real directory rather than a filesystem root. */
	get #homeAvailable(): boolean {
		return this.#trustedHome !== path.parse(this.#trustedHome).root;
	}

	isProjectEnvDeclaration(name: string): boolean {
		return Object.hasOwn(this.#projectEnv.values, canonicalEnvKey(name));
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		this.refreshConfigDirOverride();
		if (!this.#homeAvailable) throw new Error("User state is unavailable: no trustworthy home directory");
		const cached = this.#rootCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(subdir, result);
		return result;
	}

	/** Agent subdirectory, with optional XDG override. */
	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		this.refreshConfigDirOverride();
		if (!this.#homeAvailable) throw new Error("User state is unavailable: no trustworthy home directory");
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const cached = this.#agentCache.get(subdir);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(subdir, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}

	get configDirName(): string {
		return this.#configDirName;
	}
	get trustedHome(): string {
		this.refreshConfigDirOverride();
		return this.#trustedHome;
	}
	assertHomeAvailable(): void {
		this.refreshConfigDirOverride();
		if (!this.#homeAvailable) throw new Error("User state is unavailable: no trustworthy home directory");
	}
	get trustSnapshot(): { values: Record<string, string>; dynamic: Set<string> } {
		return this.#projectEnv;
	}
}

const INITIAL_PROJECT_SNAPSHOT = projectEnvSnapshot();
const trustedAgentOverride =
	trustedValue("GJC_CODING_AGENT_DIR", INITIAL_PROJECT_SNAPSHOT) ??
	trustedValue("PI_CODING_AGENT_DIR", INITIAL_PROJECT_SNAPSHOT);
let dirs = new DirResolver(trustedAgentOverride, INITIAL_PROJECT_SNAPSHOT);

// =============================================================================
// Root directories
// =============================================================================

/** Get the config root directory (~/.gjc). */
export function getConfigRootDir(): string {
	dirs.refreshConfigDirOverride();
	dirs.assertHomeAvailable();
	return dirs.configRoot;
}

/**
 * The authoritative home for user-scope state.
 *
 * Provenance-checked and resolved at call time: a home established or changed
 * after this module loaded is honored, while a home the project dotenv could
 * have planted is rejected in favor of the OS account database. See
 * {@link resolveTrustedHome}.
 */
export function getTrustedHomeDir(): string {
	dirs.assertHomeAvailable();
	return dirs.trustedHome;
}

/** Trusted config root, resolved at call time; preserves the configured nested config-dir name. */
export function getTrustedConfigRootDir(): string {
	dirs.refreshConfigDirOverride();
	dirs.assertHomeAvailable();
	return dirs.configRoot;
}

/**
 * Set the coding agent directory. Creates a fresh resolver, invalidating all
 * cached paths.
 *
 * This also exports `GJC_CODING_AGENT_DIR`, so child processes inherit the same
 * selection and resolve the same storage lane.
 */
export function setAgentDir(dir: string): void {
	dirs = new DirResolver(dir, dirs.trustSnapshot);
	process.env.GJC_CODING_AGENT_DIR = dir;
}

/**
 * Rebuild the resolver from the current trusted environment. Callers that
 * temporarily used {@link setAgentDir} must first restore the original
 * GJC_CODING_AGENT_DIR / PI_CODING_AGENT_DIR values, then call this function;
 * an originally absent override remains absent and keeps following HOME.
 */
export function resetAgentDirFromEnvironment(): void {
	const snapshot = dirs.trustSnapshot;
	const override = trustedValue("GJC_CODING_AGENT_DIR", snapshot) ?? trustedValue("PI_CODING_AGENT_DIR", snapshot);
	dirs = new DirResolver(override, snapshot);
}

/** Get the agent config directory (~/.gjc/agent). */
export function getAgentDir(): string {
	dirs.refreshConfigDirOverride();
	dirs.assertHomeAvailable();
	return dirs.agentDir;
}

export function getConfigDirName(): string {
	dirs.refreshConfigDirOverride();
	return dirs.configDirName;
}
/**
 * Join a file under the provenance-checked agent directory, never the XDG
 * state category. Automatic crash relay must not follow `XDG_STATE_HOME`:
 * a checkout `.env` can set that variable and create `$XDG_STATE_HOME/gjc`,
 * which the ordinary state resolver would then treat as the crash store.
 */
export function getTrustedAgentFile(filename: string): string {
	return path.join(getAgentDir(), filename);
}

/** Whether the current checkout declares an environment key in its `.env`. */
export function isProjectEnvDeclaration(name: string): boolean {
	return dirs.isProjectEnvDeclaration(name);
}

/** Get the project-local config directory (.gjc). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Config-root subdirectories (~/.gjc/*)
// =============================================================================

/** Get the reports directory (~/.gjc/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.gjc/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file (~/.gjc/logs/gjc.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/**
 * Get the plugins directory (~/.gjc/plugins or its XDG equivalent).
 *
 * No-arg form (production callers) goes through the XDG-aware DirResolver so
 * reads and writes always agree. The optional `home` parameter names an explicit
 * home: when it differs from the authoritative home resolved right now it
 * short-circuits the resolver and returns `<home>/<configDir>/plugins`, giving
 * callers that carry their own home (and tests with a temp HOME) a deterministic
 * path. Passing the authoritative home explicitly is identical to the no-arg
 * form — XDG semantics are preserved.
 */
export function getPluginsDir(home?: string): string {
	if (home !== undefined) {
		const explicitPath = () => path.join(home, resolveConfigDirName(dirs.trustSnapshot), "plugins");
		try {
			if (home !== dirs.trustedHome) return explicitPath();
		} catch {
			// An explicit home is the caller's documented escape hatch. If the
			// authoritative home is unavailable, do not let its fail-closed resolver
			// prevent a caller-owned plugin path from being returned.
			return explicitPath();
		}
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Where npm installs packages (~/.gjc/plugins/node_modules). */
export function getPluginsNodeModules(): string {
	return path.join(getPluginsDir(), "node_modules");
}

/** Plugin manifest (~/.gjc/plugins/package.json). */
export function getPluginsPackageJson(): string {
	return path.join(getPluginsDir(), "package.json");
}

/** Plugin lock file (~/.gjc/plugins/gjc-plugins.lock.json). */
export function getPluginsLockfile(): string {
	return path.join(getPluginsDir(), "gjc-plugins.lock.json");
}

/** Get the remote mount directory (~/.gjc/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/** Get the agent-managed worktrees directory (~/.gjc/wt). */
export function getWorktreesDir(): string {
	return dirs.rootSubdir("wt", "data");
}

/** Get the SSH control socket directory (~/.gjc/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (~/.gjc/remote-host). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.gjc/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (~/.gjc/agent/python-gateway; XDG default: $XDG_STATE_HOME/gjc/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (~/.gjc/puppeteer). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/**
 * Stable 7-character hex digest of an absolute filesystem path.
 *
 * Used to pack the project identity into a single short fs-safe segment
 * (e.g. PR-checkout and task-isolation worktree dirs under `~/.gjc/wt/`).
 * Bun.hash is non-cryptographic — collision space is ~2^28, which is fine
 * for naming a handful of repos on a single machine. Same input on the
 * same Bun runtime yields the same output.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (~/.gjc/wt/<segment>). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (~/.gjc/gpu_cache.json). */
export function getGpuCachePath(): string {
	const defaultAgentDir = path.join(dirs.trustedHome, dirs.configDirName, "agent");
	if (path.resolve(dirs.agentDir) !== path.resolve(defaultAgentDir)) return path.join(dirs.agentDir, "gpu_cache.json");
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/**
 * Get the GitHub view cache database path (~/.gjc/cache/github-cache.db).
 * Honors the `GJC_GITHUB_CACHE_DB` env var when set so tests can isolate the
 * cache file without touching the rest of the config root.
 */
export function getGithubCacheDbPath(): string {
	const override = process.env.GJC_GITHUB_CACHE_DB;
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "github-cache.db"), "cache");
}

/** Get the durable tool-choice capability cache path. */
export function getToolChoiceCapabilityCachePath(): string {
	return dirs.rootSubdir(path.join("cache", "tool-choice-capabilities.db"), "cache");
}

/** Get the natives directory (~/.gjc/natives). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/** Get the stats database path (~/.gjc/stats.db). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

// =============================================================================
// Agent subdirectories (~/.gjc/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the sessions directory (~/.gjc/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory (~/.gjc/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the resident-text cache root for a profile agent directory. */
export function getResidentCacheRootDir(profileAgentDir: string): string {
	return dirs.agentSubdir(profileAgentDir, "resident-cache", "cache");
}

/** Get the managed cold-history sidecar cache root for a profile agent directory. */
export function getSidecarCacheRootDir(profileAgentDir: string): string {
	return dirs.agentSubdir(profileAgentDir, "sidecar-cache", "cache");
}

/** Get the custom themes directory (~/.gjc/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.gjc/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.gjc/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.gjc/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.gjc/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "modules");
}

/** Get the memories directory (~/.gjc/agent/memories). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (~/.gjc/agent/terminal-sessions). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the crash log path (~/.gjc/agent/gjc-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "gjc-crash.log", "state");
}

/** Get the crash event journal path (~/.gjc/agent/gjc-crash-events.jsonl). */
export function getCrashEventsPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "gjc-crash-events.jsonl", "state");
}

/** Get the compacted crash signature index path (~/.gjc/agent/gjc-crash-index.json). */
export function getCrashIndexPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "gjc-crash-index.json", "state");
}

/** Get the handled error log path (~/.gjc/agent/gjc-error.log). */
export function getHandledErrorLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "gjc-error.log", "state");
}

/** Get the handled error event journal path (~/.gjc/agent/gjc-error-events.jsonl). */
export function getHandledErrorEventsPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "gjc-error-events.jsonl", "state");
}

/** Get the compacted handled error signature index path (~/.gjc/agent/gjc-error-index.json). */
export function getHandledErrorIndexPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "gjc-error-index.json", "state");
}

/** Get the debug log path (~/.gjc/agent/gjc-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Project subdirectories (.gjc/*)
// =============================================================================

/** Get the project-level Python modules directory (.gjc/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.gjc/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.gjc/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/**
 * Get the primary MCP config file path (first candidate).
 *
 * User scope lives in the agent directory, so a profile override
 * (`--agent-dir`, `GJC_CODING_AGENT_DIR`, `setAgentDir()`) moves it. Pass
 * `agentDir` to resolve the scope of a session whose agent directory differs
 * from the process-wide one.
 */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir(), agentDir?: string): string {
	if (scope === "user") {
		return path.join(agentDir ?? getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir(), agentDir?: string): string {
	if (scope === "user") {
		return path.join(agentDir ?? getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}
