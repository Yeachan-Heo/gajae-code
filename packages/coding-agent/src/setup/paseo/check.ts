/**
 * Read-only diagnosis for `gjc setup paseo --check`.
 *
 * Two layers, deliberately separated:
 *
 * - L1 is everything GJC can observe on the filesystem. Any non-clean L1
 *   condition is `drift`, checked first and independent of the daemon.
 * - L2 is a bounded probe of the Paseo daemon. It only runs when L1 is clean,
 *   and it partitions the remaining three states by its own outcome.
 *
 * That ordering is what makes the four states mutually exclusive: `pass`,
 * `stale`, and `skipped` all require a clean L1 and are then distinguished
 * solely by whether the daemon answered and whether it listed our entry. A
 * daemon that is merely down can never produce `drift`.
 *
 * This module never writes. `stale` in particular must not restart anything --
 * Paseo has no reload verb and its own skill forbids restarting without
 * explicit user approval, which is exactly why `stale` exists as a state.
 */
import * as fs from "node:fs/promises";
import { recoverIntent } from "./install-saga";
import { PaseoPublishError, readTarget } from "./json-publisher";
import { createOrchestrationSeed } from "./orchestration-preferences";
import { readIntent, readProvenance } from "./paseo-ownership";
import { buildProviderEntry, hasProviderConflict, providerKeyFor, resolveGjcCommand } from "./provider-config";
import type { DriftReason, SetupCheckResult } from "./result-types";
import type { PaseoSetupDependencies } from "./setup-deps";
import { resolveSkillsBridgeSource, scanSkillsBridgeDrift } from "./skills-bridge";

const PROBE_TIMEOUT_MS = 5_000;

export const STALE_GUIDANCE =
	"Paseo has not picked up the new provider entry yet. Paseo does not reload config.json automatically; restart the Paseo daemon yourself when convenient (GJC will not restart it for you).";

export interface CheckOptions {
	readonly mpreset?: string;
	readonly force?: boolean;
}

/** Collect every L1 (filesystem) observation without touching the daemon. */
async function collectL1(deps: PaseoSetupDependencies, options: CheckOptions): Promise<DriftReason[]> {
	const reasons: DriftReason[] = [];
	const providerKey = providerKeyFor(options.mpreset);

	// An interrupted earlier run leaves a durable intent. Report it, never repair
	// it here -- `--check` is read-only.
	const intent = await readIntent(deps.paths.intentRecord).catch((error: Error) => {
		// A corrupt record is itself drift (#4644 review r10); the remaining
		// checks still run, but recovery stays refused until it is resolved.
		reasons.push({
			code: "partial-install",
			subject: deps.paths.intentRecord,
			detail: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	});
	if (intent) {
		// `repair: false` keeps this read-only; the intent is reported, never settled.
		const recovery = await recoverIntent(deps.paths.intentRecord, {
			repair: false,
			expectedTargetPaths: [deps.paths.configJson, deps.paths.orchestrationPreferences, deps.paths.bridgeDir],
			expectedProvenancePath: deps.paths.provenanceLedger,
		});
		if (recovery) {
			reasons.push({
				code: "partial-install",
				subject: deps.paths.intentRecord,
				detail: recovery.detail,
			});
		}
	}

	const resolution = resolveGjcCommand();
	if (!resolution.ok) {
		reasons.push({ code: "missing-executable", subject: "command[0]", detail: resolution.detail });
	}

	let configParsed: Record<string, unknown> | undefined;
	try {
		const config = await readTarget(deps.paths.configJson);
		configParsed = config.parsed;
	} catch (error) {
		if (error instanceof PaseoPublishError && error.refusal.reason !== "cas-conflict") {
			reasons.push({
				code: error.refusal.reason === "parse-refusal" ? "parse-refusal" : "format-drift",
				subject: deps.paths.configJson,
				detail: error.message,
			});
		} else {
			throw error;
		}
	}

	if (configParsed) {
		const providers = readProviders(configParsed);
		const existing = providers?.[providerKey];
		if (existing === undefined) {
			reasons.push({
				code: "missing-provider-entry",
				subject: `agents.providers.${providerKey}`,
				detail: "GJC is not registered as a Paseo provider",
			});
		} else if (resolution.ok) {
			const desired = buildProviderEntry(resolution.command, options.mpreset);
			const conflict = hasProviderConflict(configParsed, providerKey, desired);
			if (conflict.conflict && !options.force) {
				reasons.push({
					code: "owned-key-conflict",
					subject: conflict.subject,
					detail: `${conflict.detail} Re-run with --force to overwrite it.`,
				});
			}
		}
	}

	// AC-14 is about what the provider file actually records, not about what we
	// would write today: a stale entry pointing at a deleted binary is exactly the
	// case worth reporting, and it must surface even under --force.
	if (configParsed) {
		const recorded = readProviders(configParsed)?.[providerKey];
		const command =
			recorded && typeof recorded === "object" ? (recorded as { command?: unknown }).command : undefined;
		const executable = Array.isArray(command) && typeof command[0] === "string" ? command[0] : undefined;
		if (executable !== undefined && !(await isExecutable(executable))) {
			reasons.push({
				code: "missing-executable",
				subject: executable,
				detail: "the provider entry records a command that is missing or not executable",
			});
		}
	}

	try {
		const preferences = await readTarget(deps.paths.orchestrationPreferences);
		const seed = createOrchestrationSeed(preferences.parsed);
		if (seed.seededKeys.length > 0) {
			reasons.push({
				code: "unseeded-orchestration-role",
				subject: deps.paths.orchestrationPreferences,
				detail: `orchestration roles still unset: ${seed.seededKeys.join(", ")}`,
			});
		}
	} catch (error) {
		if (error instanceof PaseoPublishError && error.refusal.reason !== "cas-conflict") {
			reasons.push({
				code: error.refusal.reason === "parse-refusal" ? "parse-refusal" : "format-drift",
				subject: deps.paths.orchestrationPreferences,
				detail: error.message,
			});
		} else {
			throw error;
		}
	}

	// Keep check mode on the exact same source resolver as bridge install and
	// drift scanning, including the legacy custom `paths.agentsSkillsDir`
	// fallback when callers omit `skillsSource`.
	const source = await resolveSkillsBridgeSource(deps);
	if (source === undefined) {
		reasons.push({
			code: "missing-skills-directory",
			subject: "paseo skills source",
			detail:
				"no Paseo skills directory found; the skills bridge is skipped (supported: ~/.agents/skills, a Paseo.app bundle)",
		});
	}

	const ledger = await readProvenance(deps.paths.provenanceLedger);
	reasons.push(...(await scanSkillsBridgeDrift(deps, ledger.bridgeEntries, ledger.bridgeEntryIdentities)));
	return reasons;
}

function readProviders(config: Record<string, unknown>): Record<string, unknown> | undefined {
	const agents = config.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	return providers as Record<string, unknown>;
}

async function isExecutable(candidate: string): Promise<boolean> {
	try {
		await fs.access(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Diagnose the installation.
 *
 * Precedence is total and the predicates are disjoint by construction:
 * drift absorbs every non-clean L1 condition, and the remaining three states
 * partition the L2 outcome space (reachable-with-entry / reachable-without-entry
 * / unreachable).
 */
export async function checkPaseoSetup(
	deps: PaseoSetupDependencies,
	options: CheckOptions = {},
): Promise<SetupCheckResult> {
	const reasons = await collectL1(deps, options);
	if (reasons.length > 0) return { component: "paseo", status: "drift", reasons };

	const outcome = await deps.runProviderLs(PROBE_TIMEOUT_MS);
	if (outcome.kind !== "ok") {
		// The daemon being down, slow, or speaking an unexpected dialect says
		// nothing about whether our files are correct -- and L1 already proved
		// they are. Reporting drift here would blame GJC for Paseo being asleep.
		return { component: "paseo", status: "skipped", reasons: [] };
	}

	const providerKey = providerKeyFor(options.mpreset);
	const row = outcome.rows.find(candidate => candidate.id === providerKey);
	if (!row) return { component: "paseo", status: "stale", reasons: [], guidance: STALE_GUIDANCE };

	// Paseo listing the provider is not the same as Paseo being able to use it.
	// Reporting `pass` for a row it marks unavailable would claim a working
	// integration the user does not have.
	if (row.status !== undefined && row.status !== "available") {
		return {
			component: "paseo",
			status: "stale",
			reasons: [],
			guidance: `Paseo knows about the GJC provider but reports it as "${row.status}". ${STALE_GUIDANCE}`,
		};
	}
	return { component: "paseo", status: "pass", reasons: [] };
}
