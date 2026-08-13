/**
 * Top-level orchestration for `gjc setup paseo`.
 *
 * Dispatches to diagnosis, install, or removal, and owns the flag combinations
 * that must be rejected before any target is touched.
 */
import { Settings } from "../../config/settings";
import { checkPaseoSetup } from "./check";
import { type CompletedStep, compensate, receiptStep, recoverIntent, runJsonStep, SagaStepError } from "./install-saga";
import { PaseoPublishError, readTarget } from "./json-publisher";
import { createOrchestrationSeed, removeSeededRoles } from "./orchestration-preferences";
import { readProvenance, writeProvenance } from "./paseo-ownership";
import {
	buildProviderEntry,
	createProviderMutation,
	hasProviderConflict,
	providerEntryHash,
	providerKeyFor,
	resolveGjcCommand,
} from "./provider-config";
import { removePaseoSetup } from "./remove";
import type { PaseoInstallResult, PaseoRemoveResult, SetupCheckResult } from "./result-types";
import type { PaseoSetupDependencies } from "./setup-deps";
import {
	installSkillsBridge,
	inverseSkillsBridge,
	preflightSkillsBridge,
	registerSkillsBridgeDirectory,
} from "./skills-bridge";

export interface PaseoSetupFlags {
	readonly check?: boolean;
	readonly json?: boolean;
	readonly force?: boolean;
	readonly remove?: boolean;
	readonly mpreset?: string;
}

export class PaseoSetupUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaseoSetupUsageError";
	}
}

export type PaseoSetupOutcome =
	| { readonly kind: "check"; readonly result: SetupCheckResult }
	| { readonly kind: "install"; readonly result: PaseoInstallResult }
	| { readonly kind: "remove"; readonly result: PaseoRemoveResult };

/**
 * Reject flag combinations that have no coherent meaning.
 *
 * Rejected before any read or write so a misuse can never leave partial state.
 */
export function assertUsableFlags(flags: PaseoSetupFlags): void {
	if (flags.check && flags.remove) {
		throw new PaseoSetupUsageError(
			"--check and --remove cannot be combined: --check only reports, --remove mutates.",
		);
	}
	if (flags.mpreset !== undefined && flags.mpreset.trim() === "") {
		throw new PaseoSetupUsageError("--mpreset requires a preset name.");
	}
}

export async function runPaseoSetup(flags: PaseoSetupFlags, deps: PaseoSetupDependencies): Promise<PaseoSetupOutcome> {
	assertUsableFlags(flags);

	if (flags.check) {
		const result = await checkPaseoSetup(deps, { mpreset: flags.mpreset, force: flags.force });
		return { kind: "check", result };
	}

	if (flags.remove) {
		const settings = await Settings.init();
		const result = await removePaseoSetup(deps, {
			now: deps.now(),
			unregisterBridgeDirectory: async () => {
				await unregisterBridgeDirectory(settings, deps.paths.bridgeDir);
			},
		});
		return { kind: "remove", result };
	}

	return { kind: "install", result: await installPaseoSetup(flags, deps) };
}

/**
 * Run the four-step install saga.
 *
 * Preflight happens first and is entirely read-only, so the common failure
 * cases (unparseable config, a conflicting entry, an unresolvable executable, a
 * foreign file sitting at one of our bridge names) all abort before anything is
 * written and therefore need no compensation.
 */
async function installPaseoSetup(flags: PaseoSetupFlags, deps: PaseoSetupDependencies): Promise<PaseoInstallResult> {
	const now = deps.now();

	// An interrupted earlier run must be settled before starting a new one. A
	// discardable intent is cleared here; a `complete-ledger` intent whose ledger
	// contents are unknown to this run is reported rather than guessed at, and
	// the steps below re-derive and commit the same provenance anyway.
	const recovery = await recoverIntent(deps.paths.intentRecord, { repair: true });
	if (recovery && !recovery.recovered) {
		return {
			outcome: "partial-install",
			compensated: [],
			uncompensated: [deps.paths.intentRecord],
			evidence: { failedStep: "intent-recovery", detail: recovery.detail, retained: [deps.paths.intentRecord] },
		};
	}

	const resolution = resolveGjcCommand();
	if (!resolution.ok) {
		throw new PaseoSetupUsageError(
			`Cannot register GJC with Paseo: ${resolution.detail}. Paseo needs an absolute command path, so GJC will not write a bare 'gjc' string.`,
		);
	}

	const providerKey = providerKeyFor(flags.mpreset);
	const entry = buildProviderEntry(resolution.command, flags.mpreset);

	const config = await readTarget(deps.paths.configJson);
	const conflict = hasProviderConflict(config.parsed, providerKey, entry);
	if (conflict.conflict && !flags.force) {
		throw new PaseoSetupUsageError(`${conflict.detail} Re-run with --force to overwrite it.`);
	}

	const preferences = await readTarget(deps.paths.orchestrationPreferences);
	const seed = createOrchestrationSeed(preferences.parsed);
	const bridgePreflight = await preflightSkillsBridge(deps);

	const completed: CompletedStep[] = [];
	const changed: string[] = [];
	const entryHash = providerEntryHash(entry);

	try {
		// Step 1: provider entry + provider-key provenance.
		const step1 = await runJsonStep({
			label: deps.paths.configJson,
			step: "provider-config",
			targetPath: deps.paths.configJson,
			provenancePath: deps.paths.provenanceLedger,
			intentPath: deps.paths.intentRecord,
			ownedKeys: [`agents.providers.${providerKey}`],
			mutate: createProviderMutation(config, providerKey, entry),
			nextLedger: ledger => ({ ...ledger, providerKeys: { ...ledger.providerKeys, [providerKey]: entryHash } }),
			revert: draft => removeProviderKey(draft, providerKey),
			revertLedger: ledger => {
				const providerKeys = { ...ledger.providerKeys };
				delete providerKeys[providerKey];
				return { ...ledger, providerKeys };
			},
			now,
		});
		completed.push(step1.completed);
		if (step1.changed) changed.push(deps.paths.configJson);

		// Step 2: seed empty orchestration roles only.
		if (seed.seededKeys.length > 0) {
			const step2 = await runJsonStep({
				label: deps.paths.orchestrationPreferences,
				step: "orchestration-preferences",
				targetPath: deps.paths.orchestrationPreferences,
				provenancePath: deps.paths.provenanceLedger,
				intentPath: deps.paths.intentRecord,
				ownedKeys: [...seed.seededKeys],
				mutate: seed.mutate,
				nextLedger: ledger => ({
					...ledger,
					seededOrchestrationKeys: { ...ledger.seededOrchestrationKeys, ...seed.seededValues },
				}),
				// Compensation must reach the same nested map the forward step wrote.
				revert: draft => removeSeededRoles(draft, seed.seededKeys, () => true),
				revertLedger: ledger => {
					const seededOrchestrationKeys = { ...ledger.seededOrchestrationKeys };
					for (const key of seed.seededKeys) delete seededOrchestrationKeys[key];
					return { ...ledger, seededOrchestrationKeys };
				},
				now,
			});
			completed.push(step2.completed);
			if (step2.changed) changed.push(deps.paths.orchestrationPreferences);
		}

		// Step 3: the symlink bridge.
		const bridge = await installSkillsBridge(bridgePreflight);
		if (bridge.createdEntries.length > 0 || bridge.bridgeDirCreated) {
			changed.push(deps.paths.bridgeDir);
			const ledger = await readProvenance(deps.paths.provenanceLedger);
			await writeProvenance(deps.paths.provenanceLedger, {
				...ledger,
				bridgePath: deps.paths.bridgeDir,
				bridgeEntries: [...bridge.createdEntries],
				bridgeDirCreated: bridge.bridgeDirCreated,
			});
			completed.push({
				label: deps.paths.bridgeDir,
				undo: async () => {
					try {
						await inverseSkillsBridge(deps, bridge);
						return { status: "reverted" as const };
					} catch (error) {
						return {
							status: "conflict" as const,
							detail: error instanceof Error ? error.message : String(error),
							retained: [deps.paths.bridgeDir],
						};
					}
				},
			});
		}

		// Step 4: register the bridge with GJC skill discovery.
		const settings = await Settings.init();
		const receipt = await registerSkillsBridgeDirectory(settings, deps.paths.bridgeDir);
		completed.push(receiptStep("config.yml skills.customDirectories", receipt));
		changed.push("config.yml skills.customDirectories");
	} catch (error) {
		const failure =
			error instanceof SagaStepError
				? error
				: new SagaStepError(
						"install",
						error instanceof PaseoPublishError || error instanceof Error ? error.message : String(error),
					);
		const outcome = await compensate(completed, failure);
		return { outcome: "partial-install", ...outcome };
	}

	return { outcome: "installed", changed };
}

function removeProviderKey(draft: Record<string, unknown>, providerKey: string): void {
	const agents = draft.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
	delete (providers as Record<string, unknown>)[providerKey];
}

async function unregisterBridgeDirectory(settings: Settings, bridgeDir: string): Promise<void> {
	await settings.commitAtomicBatchWithCurrent(current => {
		const skills = current.skills;
		if (!skills || typeof skills !== "object" || Array.isArray(skills)) return [];
		const directories = (skills as Record<string, unknown>).customDirectories;
		if (!Array.isArray(directories)) return [];
		const next = directories.filter(directory => directory !== bridgeDir);
		if (next.length === directories.length) return [];
		return [{ path: "skills.customDirectories", op: "set", value: next }];
	});
}
