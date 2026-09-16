/**
 * D7 plugin.quarantine-selected — core-owned durable disable/quarantine writer
 * for exactly one selected (family, scope, name) target, across all three
 * plugin families (GJC bundles, npm packages, marketplace-installed plugins).
 *
 * This module NEVER installs, fetches, reinstalls, imports, or executes
 * plugin code. It only flips the durable "enabled" bit each family's real
 * session-startup consumer already honors:
 *   - gjc:         GjcPluginRegistryEntry.enabled (readEffectiveRegistryUnpersisted /
 *                   loadEffectiveGjcPluginRegistry -> session-validation -> activation).
 *   - npm (user):   gjc-plugins.lock.json PluginRuntimeState.enabled, consumed by
 *                   getEnabledPlugins() (extensibility/plugins/loader.ts).
 *   - npm (project): .gjc/plugin-overrides.json `disabled` list, consumed by the
 *                   same getEnabledPlugins().
 *   - marketplace:  installed_plugins.json InstalledPluginEntry.enabled, consumed
 *                   by listClaudePluginRoots() (discovery/helpers.ts) via
 *                   `entry.enabled === false` skip.
 *
 * Disable-only: this action never re-enables (D7 has no enable path; an
 * unsafe target requires only plugin-change authorization to quarantine, but
 * re-enabling it is a deliberate separate decision outside this module).
 */

import { invalidateClaudePluginRoots, listClaudePluginRoots } from "../../discovery/helpers";
import {
	type GjcLifecycleContext,
	getGjcBundleEnablementState,
	setGjcBundleQuarantineExpectedBaseline,
} from "../../extensibility/gjc-plugins/lifecycle";
import { readEffectiveRegistryUnpersisted } from "../../extensibility/gjc-plugins/registry";
import type { GjcBundleIdentity } from "../../extensibility/gjc-plugins/types";
import { getEnabledPlugins } from "../../extensibility/plugins/loader";
import { PluginManager } from "../../extensibility/plugins/manager";
import {
	getInstalledPluginEnablementState,
	getInstalledPluginsRegistryPath,
	setInstalledPluginEnabled,
} from "../../extensibility/plugins/marketplace/registry";
import { pluginTargetId } from "./ids";
import { DoctorJournal, DoctorJournalCreateError } from "./journal";

export type PluginQuarantineFamily = "gjc" | "npm" | "marketplace";

export interface PluginQuarantineTarget {
	family: PluginQuarantineFamily;
	scope: "user" | "project";
	name: string;
}

export interface PluginQuarantineRequest extends PluginQuarantineTarget {
	/** Absolute project cwd; required for gjc/npm project-scope targets. */
	cwd: string;
	/** Home identity used for the marketplace startup-filter reread. */
	home: string;
	/** Explicit override for the marketplace installed_plugins.json path (tests). */
	registryPath?: string;
	/** Journal identity — required by applyPluginQuarantine, ignored by preview. */
	journalRoot?: string;
	runId?: string;
	rootId: string;
}

export type PluginQuarantineBlockReason =
	| "invalid_target"
	| "not_installed"
	| "unsafe_link"
	| "registry_unreadable"
	| "malformed_registry"
	| "identity_mismatch";

export interface PluginQuarantinePlan {
	target: PluginQuarantineTarget;
	targetId?: string;
	enabled: boolean;
	baseline: string;
	status: "ready" | "not_needed" | "blocked";
	reason?: PluginQuarantineBlockReason;
}

export type PluginQuarantineApplyStatus = "verified" | "not_needed" | "conflict" | "blocked" | "uncertain";

export interface PluginQuarantineApplyResult {
	status: PluginQuarantineApplyStatus;
	reason?: string;
	/** True once any durable mutation attempt started (journal `applying` appended). */
	sideEffectStarted: boolean;
	/** Fresh post-commit startup-filter observation for the selected target only. */
	targetExcludedFromStartup?: boolean;
	journalPath?: string;
}

const VALID_NAME = /^[A-Za-z0-9_.@-]{1,256}$/;
const VALID_NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

function authOk(authorizations: readonly string[] | undefined): boolean {
	return authorizations?.includes("plugin-change") === true;
}

function invalidTarget(target: PluginQuarantineTarget): boolean {
	return (
		!target.name ||
		target.name === "." ||
		target.name === ".." ||
		!(target.family === "npm"
			? target.name.length <= 214 && VALID_NPM_NAME.test(target.name)
			: VALID_NAME.test(target.name))
	);
}

/**
 * Read-only preview: resolves the exact family writer's current durable
 * enablement state and CAS baseline for one (family, scope, name) target.
 * Never imports, fetches, or executes plugin code, and performs no writes.
 */
export async function previewPluginQuarantine(input: PluginQuarantineRequest): Promise<PluginQuarantinePlan> {
	if (invalidTarget(input) || !/^r[0-9a-f]{64}$/.test(input.rootId))
		return { target: input, enabled: false, baseline: "", status: "blocked", reason: "invalid_target" };
	const targetId = pluginTargetId(input.rootId, input.family, input.scope, input.name);

	if (input.family === "gjc") {
		const result = await getGjcBundleEnablementState(
			{ cwd: input.cwd },
			{ kind: "gjc-bundle", scope: input.scope, name: input.name },
		);
		if (!result.ok) {
			const reason: PluginQuarantineBlockReason =
				result.error.code === "registry_unreadable" ? "registry_unreadable" : "not_installed";
			return { target: input, targetId, enabled: false, baseline: "", status: "blocked", reason };
		}
		const enabled = result.value.enabled;
		return {
			target: input,
			targetId,
			enabled,
			baseline: result.value.baseline,
			status: enabled ? "ready" : "not_needed",
		};
	}

	if (input.family === "npm") {
		const manager = new PluginManager(input.cwd);
		const state = await manager.getEnablementState(input.name, input.scope);
		if (state.status === "malformed")
			return {
				target: input,
				targetId,
				enabled: false,
				baseline: "",
				status: "blocked",
				reason: "malformed_registry",
			};
		if (state.status === "not_installed")
			return { target: input, targetId, enabled: false, baseline: "", status: "blocked", reason: "not_installed" };
		return {
			target: input,
			targetId,
			enabled: state.enabled,
			baseline: state.baseline,
			status: state.enabled ? "ready" : "not_needed",
		};
	}

	// marketplace
	const filePath = input.registryPath ?? getInstalledPluginsRegistryPath();
	const state = await getInstalledPluginEnablementState(filePath, input.name, input.scope);
	if (state.status === "unsafe_link")
		return { target: input, targetId, enabled: false, baseline: "", status: "blocked", reason: "unsafe_link" };
	if (state.status === "malformed")
		return { target: input, targetId, enabled: false, baseline: "", status: "blocked", reason: "malformed_registry" };
	if (state.status === "not_installed")
		return { target: input, targetId, enabled: false, baseline: "", status: "blocked", reason: "not_installed" };
	// Marketplace quarantine is metadata-only: an absent or unreadable cached
	// artifact at installPath never blocks disabling. That is a D6 concern.
	return {
		target: input,
		targetId,
		enabled: state.enabled,
		baseline: state.baseline,
		status: state.enabled ? "ready" : "not_needed",
	};
}

/** Fresh, independent re-read of the exact startup consumer for one family/scope/name target. */
async function targetExcludedFromStartup(input: PluginQuarantineRequest): Promise<boolean> {
	if (input.family === "gjc") {
		const effective = await readEffectiveRegistryUnpersisted(input.scope, input.cwd);
		const entry = effective.plugins.find(p => p.name === input.name);
		return !entry?.enabled;
	}
	if (input.family === "npm") {
		const enabled = await getEnabledPlugins(input.cwd);
		return !enabled.some(p => p.name === input.name);
	}
	await invalidateClaudePluginRoots(input.home, input.cwd);
	const { roots } = await listClaudePluginRoots(input.home, input.cwd);
	return !roots.some(r => r.id === input.name && r.scope === input.scope);
}

async function otherTargetsPreserved(input: PluginQuarantineRequest, before: Set<string>): Promise<boolean> {
	if (input.family === "gjc") {
		const effective = await readEffectiveRegistryUnpersisted(input.scope, input.cwd);
		const after = new Set(effective.plugins.filter(p => p.enabled).map(p => `${p.scope}:${p.name}`));
		for (const key of before) {
			if (key === `${input.scope}:${input.name}`) continue;
			if (!after.has(key)) return false;
		}
		return true;
	}
	if (input.family === "npm") {
		const enabled = await getEnabledPlugins(input.cwd);
		const after = new Set(enabled.map(p => p.name));
		for (const key of before) {
			if (key === input.name) continue;
			if (!after.has(key)) return false;
		}
		return true;
	}
	const { roots } = await listClaudePluginRoots(input.home, input.cwd);
	const after = new Set(roots.map(r => `${r.scope}:${r.id}`));
	for (const key of before) {
		if (key === `${input.scope}:${input.name}`) continue;
		if (!after.has(key)) return false;
	}
	return true;
}

async function snapshotOthers(input: PluginQuarantineRequest): Promise<Set<string>> {
	if (input.family === "gjc") {
		const effective = await readEffectiveRegistryUnpersisted(input.scope, input.cwd);
		return new Set(effective.plugins.filter(p => p.enabled).map(p => `${p.scope}:${p.name}`));
	}
	if (input.family === "npm") {
		const enabled = await getEnabledPlugins(input.cwd);
		return new Set(enabled.map(p => p.name));
	}
	const { roots } = await listClaudePluginRoots(input.home, input.cwd);
	return new Set(roots.map(r => `${r.scope}:${r.id}`));
}

/**
 * Mutating action. Authorization is checked before any risk evaluation, lock
 * acquisition, or journal access — an unauthorized caller learns nothing
 * beyond "authorization required" and causes zero side effects. D7 is
 * disable-only: `enabled: true` is never accepted here.
 *
 * Runs the canonical create -> before -> applying -> verified|failed -> close
 * journal cycle (one journal per run, `plugin.quarantine-selected` selection),
 * then independently re-reads the real startup consumer for the selected
 * target only before reporting `verified` (never a fabricated generic ready).
 */
export async function applyPluginQuarantine(
	input: PluginQuarantineRequest,
	authorizations: readonly string[],
	expected: PluginQuarantinePlan,
): Promise<PluginQuarantineApplyResult> {
	if (!authOk(authorizations)) return { status: "blocked", reason: "authorization_missing", sideEffectStarted: false };

	if (
		!expected ||
		expected.target.family !== input.family ||
		expected.target.scope !== input.scope ||
		expected.target.name !== input.name ||
		expected.targetId !== pluginTargetId(input.rootId, input.family, input.scope, input.name)
	)
		return { status: "blocked", reason: "original_target_missing", sideEffectStarted: false };
	const plan = await previewPluginQuarantine(input);
	if (plan.baseline !== expected.baseline)
		return { status: "conflict", reason: "stale_baseline", sideEffectStarted: false };
	if (plan.status === "blocked") return { status: "blocked", reason: plan.reason, sideEffectStarted: false };
	if (plan.status === "not_needed") {
		const excluded = await targetExcludedFromStartup(input);
		return {
			status: excluded ? "not_needed" : "blocked",
			reason: excluded ? undefined : "startup_filter_not_confirmed",
			sideEffectStarted: false,
			targetExcludedFromStartup: excluded,
		};
	}

	if (!input.journalRoot || !input.runId)
		return { status: "blocked", reason: "journal_identity_missing", sideEffectStarted: false };
	const targetId = plan.targetId ?? pluginTargetId(input.rootId, input.family, input.scope, input.name);
	const repairId = "plugin.quarantine-selected" as const;

	const others = await snapshotOthers(input);
	let journal: DoctorJournal;
	try {
		journal = await DoctorJournal.create(input.journalRoot, input.runId);
	} catch (error) {
		if (error instanceof DoctorJournalCreateError)
			return {
				status: error.sideEffectStarted ? "uncertain" : "blocked",
				reason: error.reasonCode,
				sideEffectStarted: error.sideEffectStarted,
			};
		return { status: "uncertain", reason: "journal_unavailable", sideEffectStarted: true };
	}

	const sideEffectStarted = true;
	try {
		await journal.append({ repairId, targetId, phase: "before", before: { value: plan.enabled } });
		await journal.append({ repairId, targetId, phase: "applying" });

		let mutationOutcome: "updated" | "not_needed";
		if (input.family === "gjc") {
			const result = await setGjcBundleQuarantineExpectedBaseline(
				{ cwd: input.cwd } as GjcLifecycleContext,
				{ kind: "gjc-bundle", scope: input.scope, name: input.name } as GjcBundleIdentity,
				false,
				plan.baseline,
			);
			if (!result.ok) {
				const code = result.error.code;
				await journal.append({ repairId, targetId, phase: "failed", outcome: "failed" });
				return { status: code === "stale_baseline" ? "conflict" : "blocked", reason: code, sideEffectStarted };
			}
			mutationOutcome = result.value.mutated ? "updated" : "not_needed";
		} else if (input.family === "npm") {
			const manager = new PluginManager(input.cwd);
			try {
				const result = await manager.setEnabled(input.name, false, input.scope, plan.baseline);
				mutationOutcome = result.status;
			} catch (error) {
				const code = (error as { code?: string }).code ?? "repair_execution_unverified";
				await journal.append({ repairId, targetId, phase: "failed", outcome: "failed" });
				return { status: code === "stale_baseline" ? "conflict" : "blocked", reason: code, sideEffectStarted };
			}
		} else {
			const filePath = input.registryPath ?? getInstalledPluginsRegistryPath();
			try {
				mutationOutcome = await setInstalledPluginEnabled(filePath, input.name, input.scope, false, plan.baseline);
			} catch (error) {
				const code = (error as { code?: string }).code ?? "repair_execution_unverified";
				await journal.append({ repairId, targetId, phase: "failed", outcome: "failed" });
				return { status: code === "stale_baseline" ? "conflict" : "blocked", reason: code, sideEffectStarted };
			}
		}

		// Independent post-commit reread of the actual startup consumer for
		// ONLY the selected target, plus confirmation every other currently
		// enabled target in this family/scope was left untouched.
		const excluded = await targetExcludedFromStartup(input);
		const preserved = await otherTargetsPreserved(input, others);
		if (!excluded || !preserved) {
			await journal.append({ repairId, targetId, phase: "uncertain", outcome: "conflict" });
			return {
				status: "conflict",
				reason: "startup_filter_not_confirmed",
				sideEffectStarted,
				targetExcludedFromStartup: excluded,
			};
		}
		await journal.append({
			repairId,
			targetId,
			phase: "verified",
			after: { value: false },
			outcome: mutationOutcome === "updated" ? "verified" : "not_needed",
		});
		return { status: "verified", sideEffectStarted, targetExcludedFromStartup: true, journalPath: journal.path };
	} catch (error) {
		try {
			await journal.append({ repairId, targetId, phase: "uncertain", outcome: "uncertain" });
		} catch {
			// A terminal result has already been selected; the journal append
			// failure is reported via the outer uncertain result below.
		}
		return {
			status: "uncertain",
			reason: error instanceof Error ? error.name : "repair_execution_unverified",
			sideEffectStarted,
			journalPath: journal.path,
		};
	} finally {
		journal.close();
	}
}
