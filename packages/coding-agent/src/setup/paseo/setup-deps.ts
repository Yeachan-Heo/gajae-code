/**
 * Injectable dependency surface for `gjc setup paseo`.
 *
 * Every module in this directory takes `PaseoSetupDependencies` explicitly so
 * tests can substitute paths, the Paseo CLI probe, and the clock without
 * `mock.module()`. Production wiring calls `createDefaultPaseoSetupDependencies()`.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";

/** The five Paseo skills this setup links. `context-search` is deliberately excluded. */
export const INSTALL_SKILL_NAMES = [
	"paseo",
	"paseo-advisor",
	"paseo-committee",
	"paseo-handoff",
	"paseo-loop",
] as const;

export type InstallSkillName = (typeof INSTALL_SKILL_NAMES)[number];

/** Prefix used to enumerate Paseo-owned skills when scanning for drift. */
export const PASEO_SKILL_PREFIX = "paseo";

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
	/** `~/.agents/skills` -- READ-ONLY, never written by this setup. */
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
}

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
	const configured = env.PASEO_HOME?.trim();
	if (!configured) return path.join(home, ".paseo");
	const expanded =
		configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;
	return path.resolve(expanded);
}

export function createDefaultPaseoPaths(
	agentDir: string = getAgentDir(),
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = {},
): PaseoPaths {
	const paseoHome = resolvePaseoHome(env, home);
	return {
		configJson: path.join(paseoHome, "config.json"),
		orchestrationPreferences: path.join(paseoHome, "orchestration-preferences.json"),
		agentsSkillsDir: path.join(home, ".agents", "skills"),
		bridgeDir: path.join(agentDir, "paseo-skills"),
		provenanceLedger: path.join(agentDir, "paseo", "provenance.json"),
		intentRecord: path.join(agentDir, "paseo", "intent.json"),
		gjcSkillsDir: path.join(agentDir, "skills"),
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
		paths: createDefaultPaseoPaths(getAgentDir(), os.homedir(), process.env),
		runProviderLs,
		now: () => new Date(),
	};
}
