import { isKnownWorkflowState } from "../../gjc-runtime/workflow-manifest";
import type { CanonicalGjcWorkflowSkill } from "../../skill-state/active-state";
import {
	GJC_AGENT_SUBSKILL_PHASES,
	GJC_SUBSKILL_PARENT_AGENTS,
	GJC_SUBSKILL_PARENT_SKILLS,
	GjcPluginLoadError,
	type GjcSubskillParentAgent,
	type LoadedSubskillBinding,
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
