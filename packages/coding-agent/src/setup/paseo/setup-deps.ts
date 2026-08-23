/**
 * Injectable dependency surface for `gjc setup paseo`.
 *
 * Every module in this directory takes `PaseoSetupDependencies` explicitly so
 * tests can substitute paths, the Paseo CLI probe, and the clock without
 * module-scope mocks.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getTrustedHomeDir, parseEnvFile } from "@gajae-code/utils";

/** Prefix used to enumerate Paseo-owned skills when scanning for drift. */
export const PASEO_SKILL_PREFIX = "paseo";

/**
 * Where Paseo keeps its skills.
 *
 * A CLI install materializes `~/.agents/skills`; a desktop app ships them inside
 * the app bundle. The bridge reads whichever exists and never writes either.
 */
export interface PaseoSkillSource {
	/** Absolute directory holding Paseo's skill folders. */
	readonly dir: string;
	/** `"user"` (`~/.agents/skills`) or `"app-bundle"` (inside a Paseo.app). */
	readonly origin: "user" | "app-bundle";
}

/** Default Paseo desktop app names, both install roots, in order. */
const PASEO_APP_NAMES = ["Paseo.app", "Paseo Beta.app", "Paseo Nightly.app"] as const;

/** Every app-bundle skills directory to probe. Bounded: a fixed list, never a search. */
export function paseoAppSkillsCandidates(home: string = getTrustedHomeDir()): readonly string[] {
	const roots = process.platform === "darwin" ? ["/Applications", path.join(home, "Applications")] : [];
	const candidates: string[] = [];
	for (const root of roots) {
		for (const app of PASEO_APP_NAMES) {
			candidates.push(path.join(root, app, "Contents", "Resources", "skills"));
		}
	}
	return candidates;
}

/**
 * Every project dotenv variant Bun can load for the current working directory.
 *
 * Bun's default order loads `.env`, then the `NODE_ENV`-specific file, then
 * `.env.local`, all from `process.cwd()` before any module runs. A repository
 * can define `PASEO_SKILLS_DIR` in any of them, so the trust check must
 * consider the full set, not just `.env`.
 */
function projectDotenvVariants(): readonly string[] {
	const env = process.env.NODE_ENV;
	const files = [".env", ".env.local"];
	if (env === "production" || env === "test") {
		files.push(`.env.${env}`, `.env.${env}.local`);
	} else {
		// Bun's mode defaults to development: with `NODE_ENV` unset, empty, or
		// any value other than production/test, `.env.development` and
		// `.env.development.local` still load (verified against the pinned
		// runtime), so the trust set must carry them for every such mode —
		// not only for the literal `NODE_ENV=development`.
		files.push(".env.development", ".env.development.local");
	}
	// `.env.production.local` is also in play for the default mode; checking it
	// in every mode keeps this a conservative superset of what Bun can load
	// rather than an exact precedence mirror.
	files.push(".env.production.local");
	return [...new Set(files)];
}

/**
 * `PASEO_SKILLS_DIR` as explicit user intent only.
 *
 * Bun loads the project dotenv variants above into `process.env` before any
 * module runs, so a cloned repository can point this override at a directory
 * the repository also ships -- and global `gjc setup paseo` run from inside
 * that checkout would bridge the repository's own `paseo*` prompt content into
 * the user's GJC configuration. The trust rule is presence-based across every
 * variant: the project defining the key in ANY dotenv file rejects the
 * override, because Bun expands interpolations (`$PWD`, `${VAR}`) before a
 * value comparison could match. An operator whose real environment carries the
 * same value loses the override while inside such a checkout -- the same
 * conservative trade the credential boundary already makes.
 */
function trustedPaseoSkillsDirOverride(): string | undefined {
	const value = process.env.PASEO_SKILLS_DIR;
	if (!value) return undefined;
	for (const file of projectDotenvVariants()) {
		if (parseEnvFile(path.join(process.cwd(), file)).PASEO_SKILLS_DIR !== undefined) return undefined;
	}
	return value;
}

/**
 * Resolve the directory Paseo's skills live in.
 *
 * `PASEO_SKILLS_DIR` overrides discovery for relocated bundles and tests; it is
 * honored only when it is explicit user intent (not the project `.env`), absolute,
 * and present, so a stale or untrusted variable can never produce bridge links.
 * `~/.agents/skills` wins over an app bundle because it is the user-visible
 * location GJC documented. Returns `undefined` when no source directory exists
 * at all -- the bridge is skipped, never guessed at.
 */
export async function resolvePaseoSkillsSource(
	home: string = getTrustedHomeDir(),
): Promise<PaseoSkillSource | undefined> {
	const override = trustedPaseoSkillsDirOverride();
	if (override !== undefined && path.isAbsolute(override) && (await isDirectory(override))) {
		return { dir: path.resolve(override), origin: "app-bundle" };
	}
	const userDir = path.join(home, ".agents", "skills");
	if (await isDirectory(userDir)) return { dir: userDir, origin: "user" };
	for (const candidate of paseoAppSkillsCandidates(home)) {
		if (await isDirectory(candidate)) return { dir: candidate, origin: "app-bundle" };
	}
	return undefined;
}
/**
 * Trust check for a RECORDED bridge source directory (#4644 reviews r10–r12).
 *
 * The provenance ledger's `bridgeSourceDir` drives link-text verification at
 * removal time, so a tampered ledger must not be able to name an arbitrary
 * directory as "the source". The trust rule mirrors DISCOVERY EXACTLY — the
 * recorded source must be a location `resolvePaseoSkillsSource` could have
 * returned: the default `~/.agents/skills`, one of the fixed Paseo.app bundle
 * `Contents/Resources/skills` roots under `/Applications` or `~/Applications`,
 * or the trusted `PASEO_SKILLS_DIR` override (compared canonically so a
 * relocated bundle through a symlink still matches). Anything else under the
 * home directory — an arbitrary user directory a tampered ledger names — is
 * refused. A vanished source still passes when its location is one of these
 * exact roots: Paseo being uninstalled must not wedge removal.
 */
export async function isTrustedRecordedSkillsSource(
	dir: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
	if (!path.isAbsolute(dir)) {
		return { ok: false, detail: `the recorded bridge source (${dir}) is not an absolute path` };
	}
	const resolved = (await fs.realpath(dir).catch(() => undefined)) ?? path.resolve(dir);
	const home = (await fs.realpath(getTrustedHomeDir()).catch(() => getTrustedHomeDir())) as string;
	const candidates = [
		path.join(home, ".agents", "skills"),
		...paseoAppSkillsCandidates(home).map(candidate =>
			candidate.startsWith("/Applications") || candidate.startsWith(home) ? candidate : path.join(home, candidate),
		),
	];
	for (const candidate of candidates) {
		const canonical = (await fs.realpath(candidate).catch(() => undefined)) ?? candidate;
		if (resolved === canonical || resolved === candidate) return { ok: true };
	}
	const override = trustedPaseoSkillsDirOverride();
	if (override !== undefined && path.isAbsolute(override)) {
		// The explicit override's RESOLVED target is trusted (#4644 review
		// r11): the override is the user's own declared intent, so a relocated
		// bundle reached through a symlink must not strand bridge ownership.
		const resolvedOverride = (await fs.realpath(override).catch(() => undefined)) ?? path.resolve(override);
		if (resolved === resolvedOverride) return { ok: true };
	}
	return {
		ok: false,
		detail: `the recorded bridge source (${dir}) is not a location Paseo skills discovery could produce; set PASEO_SKILLS_DIR to it if it is legitimate, then re-run`,
	};
}

async function isDirectory(candidate: string): Promise<boolean> {
	try {
		return (await fs.stat(candidate)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Base provider key written into `agents.providers`. */
export const PROVIDER_KEY = "gjc";

/** Paseo's undocumented provider inheritance contract, reverse-engineered from a hand-written config. */
export const PROVIDER_EXTENDS = "acp";

/**
 * Role keys Paseo stores under `providers` in `orchestration-preferences.json`.
 *
 * Verified against a live file: the roles are nested, not top-level, and the
 * sibling `preferences` array belongs to the user.
 */
export const ORCHESTRATION_ROLE_KEYS = ["impl", "ui", "research", "planning", "audit"] as const;

export interface PaseoPaths {
	/** `~/.paseo/config.json` */
	readonly configJson: string;
	/** `~/.paseo/orchestration-preferences.json` */
	readonly orchestrationPreferences: string;
	/**
	 * Paseo's skills directory -- READ-ONLY, never written by this setup.
	 * Retained for exported-contract compatibility: callers constructing
	 * `PaseoPaths` keep a field to read. The LIVE source the bridge links
	 * against is resolved per run via `resolvePaseoSkillsSource` (the default
	 * location, an app bundle, or an explicit `PASEO_SKILLS_DIR`), and that
	 * resolved path — not this field — is what the ledger records. REQUIRED
	 * again for external callers (#4644 review r14): they constructed the
	 * field before it ever became optional, so the required shape is the
	 * compatible one; hermetic fixtures pass their own concrete directory.
	 */
	readonly agentsSkillsDir: string;
	/** `<agentDir>/paseo-skills` -- the bridge directory this setup owns. */
	readonly bridgeDir: string;
	/** `<agentDir>/paseo/provenance.json` -- GJC-side ownership ledger. */
	readonly provenanceLedger: string;
	/** `<agentDir>/paseo/intent.json` -- durable crash-recovery intent record. */
	readonly intentRecord: string;
	/** `<agentDir>/skills` -- second protected tree, never written by this setup. */
	readonly gjcSkillsDir: string;
}

/** A provider row as `paseo provider ls --json` reports it. */
export interface PaseoProviderRow {
	readonly id: string;
	/** Paseo reports `"available"` for a provider it can actually reach. */
	readonly status?: string;
}

/** Distinct outcomes of probing `paseo provider ls --json`. Never collapsed into a boolean. */
export type PaseoLsOutcome =
	| { readonly kind: "ok"; readonly providerIds: readonly string[]; readonly rows: readonly PaseoProviderRow[] }
	| { readonly kind: "unavailable"; readonly detail: string }
	| { readonly kind: "timeout"; readonly timeoutMs: number }
	| { readonly kind: "malformed"; readonly detail: string }
	| { readonly kind: "nonzero-exit"; readonly exitCode: number; readonly detail: string };

export interface PaseoSetupDependencies {
	readonly paths: PaseoPaths;
	/** Bounded probe of the Paseo daemon. MUST enforce `timeoutMs` and kill the child on expiry. */
	runProviderLs(timeoutMs: number): Promise<PaseoLsOutcome>;
	now(): Date;
	/**
	 * Resolve Paseo's skills directory. Injectable so tests stay hermetic.
	 * Migration-safe default (#4644 review r13): an omitted resolver falls
	 * back to the REAL discovery order (`PASEO_SKILLS_DIR`, `~/.agents/skills`,
	 * a Paseo.app bundle) rather than failing to compile — existing callers
	 * constructing this exported interface keep type-checking — and the
	 * fallback is never a silent bridge skip: it resolves exactly what the
	 * production builder would.
	 */
	readonly skillsSource?: () => Promise<PaseoSkillSource | undefined>;
	/** Home directory used to derive the legacy pre-#4638 bridge source. */
	readonly home?: string;
	/**
	 * Trust check for a RECORDED bridge source directory at removal time.
	 * Optional only because hermetic fixtures inject a root-bounded
	 * equivalent: absence falls back to {@link isTrustedRecordedSkillsSource},
	 * the production trusted-home/app-bundle rule — never a silent pass-through.
	 */
	readonly trustedSkillsSource?: (dir: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
}

export function createDefaultPaseoPaths(
	agentDir: string = getAgentDir(),
	home: string = getTrustedHomeDir(),
): PaseoPaths {
	const paseoHome = path.join(home, ".paseo");
	return {
		configJson: path.join(paseoHome, "config.json"),
		orchestrationPreferences: path.join(paseoHome, "orchestration-preferences.json"),
		bridgeDir: path.join(agentDir, "paseo-skills"),
		provenanceLedger: path.join(agentDir, "paseo", "provenance.json"),
		intentRecord: path.join(agentDir, "paseo", "intent.json"),
		gjcSkillsDir: path.join(agentDir, "skills"),
		agentsSkillsDir: path.join(home, ".agents", "skills"),
	};
}

/**
 * Probe the Paseo daemon for its registered providers.
 *
 * The daemon may be down, wedged, or a different version, so every failure mode
 * is classified rather than collapsed: `--check` maps `unavailable`/`timeout` to
 * `skipped` and must never report `drift` because the daemon did not answer.
 */
async function runProviderLs(timeoutMs: number): Promise<PaseoLsOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const child = Bun.spawn(["paseo", "provider", "ls", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (controller.signal.aborted) return { kind: "timeout", timeoutMs };
		if (exitCode !== 0) return { kind: "nonzero-exit", exitCode, detail: stderr.trim().slice(0, 500) };
		return parseProviderLs(stdout);
	} catch (error) {
		if (controller.signal.aborted) return { kind: "timeout", timeoutMs };
		return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Parse `paseo provider ls --json`.
 *
 * The measured shape is an array of `{ provider, label, status, ... }` rows.
 * `id` and `name` are also accepted because the key is undocumented and has no
 * stability guarantee, and a bare string array is accepted for the same reason.
 */
export function parseProviderLs(stdout: string): PaseoLsOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		return { kind: "malformed", detail: error instanceof Error ? error.message : String(error) };
	}
	const raw = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { providers?: unknown }).providers)
			? ((parsed as { providers: unknown[] }).providers as unknown[])
			: undefined;
	if (!raw) return { kind: "malformed", detail: "expected an array or an object carrying a providers array" };

	const rows: PaseoProviderRow[] = [];
	for (const row of raw) {
		if (typeof row === "string") {
			rows.push({ id: row });
			continue;
		}
		if (!row || typeof row !== "object") {
			return { kind: "malformed", detail: "provider entry was not an object" };
		}
		const candidate = row as { provider?: unknown; id?: unknown; name?: unknown; status?: unknown };
		const id =
			typeof candidate.provider === "string"
				? candidate.provider
				: typeof candidate.id === "string"
					? candidate.id
					: typeof candidate.name === "string"
						? candidate.name
						: undefined;
		if (id === undefined) return { kind: "malformed", detail: "provider entry carried no string id" };
		rows.push(typeof candidate.status === "string" ? { id, status: candidate.status } : { id });
	}
	return { kind: "ok", providerIds: rows.map(row => row.id), rows };
}

export function createDefaultPaseoSetupDependencies(): PaseoSetupDependencies {
	return {
		paths: createDefaultPaseoPaths(),
		runProviderLs,
		now: () => new Date(),
		skillsSource: () => resolvePaseoSkillsSource(),
		home: getTrustedHomeDir(),
	};
}
