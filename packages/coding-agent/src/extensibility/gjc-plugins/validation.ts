import { isKnownWorkflowState } from "../../gjc-runtime/workflow-manifest";
import type { CanonicalGjcWorkflowSkill } from "../../skill-state/active-state";
import { assertMcpInstallPolicy } from "./mcp-policy";
import {
	GJC_AGENT_SUBSKILL_PHASES,
	GJC_SUBSKILL_PARENT_AGENTS,
	GJC_SUBSKILL_PARENT_SKILLS,
	GjcPluginLoadError,
	type GjcPluginRegistryEntry,
	type GjcSubskillParentAgent,
	type LoadedSubskillBinding,
	type NormalizedGjcPluginBundle,
	type SubskillFrontmatter,
} from "./types";

function isParentSkill(value: string): value is CanonicalGjcWorkflowSkill {
	return (GJC_SUBSKILL_PARENT_SKILLS as readonly string[]).includes(value);
}

function isParentAgent(value: string): value is GjcSubskillParentAgent {
	return (GJC_SUBSKILL_PARENT_AGENTS as readonly string[]).includes(value);
}

export function validateBinding(fm: SubskillFrontmatter): void {
	const parent = fm.binds_to;
	if (isParentSkill(parent)) {
		if (!isKnownWorkflowState(parent, fm.phase)) {
			throw new GjcPluginLoadError("invalid_phase", `Invalid GJC sub-skill phase for ${parent}: ${fm.phase}`);
		}
		return;
	}

	if (isParentAgent(parent)) {
		if (!GJC_AGENT_SUBSKILL_PHASES[parent].includes(fm.phase)) {
			throw new GjcPluginLoadError("invalid_phase", `Invalid GJC sub-skill phase for ${parent}: ${fm.phase}`);
		}
		return;
	}

	throw new GjcPluginLoadError("invalid_parent", `Invalid GJC sub-skill parent: ${parent}`);
}

export function buildParentArgMap(
	bindings: readonly LoadedSubskillBinding[],
): Map<string, Map<string, LoadedSubskillBinding>> {
	const byParent = new Map<string, Map<string, LoadedSubskillBinding>>();
	for (const binding of bindings) {
		let byArg = byParent.get(binding.parent);
		if (!byArg) {
			byArg = new Map<string, LoadedSubskillBinding>();
			byParent.set(binding.parent, byArg);
		}
		const existing = byArg.get(binding.activationArg);
		if (existing) {
			throw new GjcPluginLoadError(
				"duplicate_arg",
				`Duplicate GJC sub-skill activation_arg for ${binding.parent}: ${binding.activationArg} (${existing.filePath}, ${binding.filePath})`,
			);
		}
		byArg.set(binding.activationArg, binding);
	}
	return byParent;
}

export function buildParentPhaseSet(bindings: readonly LoadedSubskillBinding[]): Set<string> {
	const seen = new Map<string, LoadedSubskillBinding>();
	for (const binding of bindings) {
		const key = `${binding.parent}\u0000${binding.phase}`;
		const existing = seen.get(key);
		if (existing) {
			throw new GjcPluginLoadError(
				"duplicate_parent_phase",
				`Duplicate GJC sub-skill parent/phase binding for ${binding.parent}/${binding.phase} (${existing.filePath}, ${binding.filePath})`,
			);
		}
		seen.set(key, binding);
	}
	return new Set(seen.keys());
}

/**
 * Hard install-time collision + security validation for a compiled bundle
 * against the effective installed registry (other plugins in the target scope
 * universe). Collisions are hard errors; the registry is the collision
 * authority, never capability first-wins.
 */
export function validateInstallPlan(
	bundle: NormalizedGjcPluginBundle,
	effectiveEntries: readonly GjcPluginRegistryEntry[],
): void {
	const others = effectiveEntries.filter(e => e.name !== bundle.name);

	const toolNames = new Set<string>();
	const hookKeys = new Set<string>();
	const mcpNames = new Set<string>();
	const appendixIds = new Set<string>();
	const subskillArgs = new Set<string>();
	const parentPhases = new Set<string>();
	for (const e of others) {
		for (const t of e.surfaces.tools) toolNames.add(t.name);
		for (const h of e.surfaces.hooks) hookKeys.add(h.extensionId);
		for (const m of e.surfaces.mcps) mcpNames.add(m.name);
		for (const a of e.surfaces.systemAppendices) appendixIds.add(a.extensionId);
		for (const a of e.surfaces.agentAppendices) appendixIds.add(a.extensionId);
		for (const s of e.surfaces.subskills) {
			subskillArgs.add(`${s.parent}\u0000${s.activationArg}`);
			parentPhases.add(`${s.parent}\u0000${s.phase}`);
		}
	}

	// Check candidate surfaces against the effective registry AND against each
	// other (intra-bundle duplicates are also hard errors).
	for (const t of bundle.surfaces.tools) {
		if (toolNames.has(t.name)) {
			throw new GjcPluginLoadError("duplicate_tool", `GJC plugin tool name collides: ${t.name}`);
		}
		toolNames.add(t.name);
	}
	for (const h of bundle.surfaces.hooks) {
		if (hookKeys.has(h.extensionId)) {
			throw new GjcPluginLoadError("duplicate_hook", `GJC plugin hook collides: ${h.extensionId}`);
		}
		hookKeys.add(h.extensionId);
	}
	for (const m of bundle.surfaces.mcps) {
		if (mcpNames.has(m.name)) {
			throw new GjcPluginLoadError("duplicate_mcp", `GJC plugin MCP name collides: ${m.name}`);
		}
		mcpNames.add(m.name);
		assertMcpInstallPolicy(m.config, { pluginRoot: bundle.root });
	}
	for (const a of [...bundle.surfaces.systemAppendices, ...bundle.surfaces.agentAppendices]) {
		if (appendixIds.has(a.extensionId)) {
			throw new GjcPluginLoadError("duplicate_appendix", `GJC plugin appendix collides: ${a.extensionId}`);
		}
		appendixIds.add(a.extensionId);
	}
	for (const s of bundle.surfaces.subskills) {
		const argKey = `${s.parent}\u0000${s.activationArg}`;
		const phaseKey = `${s.parent}\u0000${s.phase}`;
		if (subskillArgs.has(argKey)) {
			throw new GjcPluginLoadError(
				"duplicate_arg",
				`GJC plugin subskill activation_arg collides for ${s.parent}: ${s.activationArg}`,
			);
		}
		if (parentPhases.has(phaseKey)) {
			throw new GjcPluginLoadError(
				"duplicate_parent_phase",
				`GJC plugin subskill parent/phase collides: ${s.parent}/${s.phase}`,
			);
		}
		subskillArgs.add(argKey);
		parentPhases.add(phaseKey);
	}
}
