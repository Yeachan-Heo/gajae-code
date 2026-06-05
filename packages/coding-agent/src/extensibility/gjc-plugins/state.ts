import type { ActiveSubskillEntry } from "../../skill-state/active-state";
import { readVisibleSkillActiveState } from "../../skill-state/active-state";
import type { LoadedSubskillActivation } from "./types";

export function toActiveSubskillEntry(activation: LoadedSubskillActivation): ActiveSubskillEntry {
	return {
		plugin: activation.plugin,
		subskillName: activation.subskillName,
		parent: activation.parent,
		bindsTo: activation.bindsTo,
		phase: activation.phase,
		activationArg: activation.activationArg,
		filePath: activation.filePath,
		toolPaths: activation.toolPaths,
	};
}

export async function readActiveSubskillsForParent(input: {
	cwd: string;
	sessionId?: string;
	parent: string;
	phase: string;
}): Promise<ActiveSubskillEntry[]> {
	const state = await readVisibleSkillActiveState(input.cwd, input.sessionId);
	const parent = input.parent.trim();
	const phase = input.phase.trim();
	if (!state || !parent || !phase) return [];
	return (state.active_subskills ?? []).filter(entry => entry.parent === parent && entry.phase === phase);
}
