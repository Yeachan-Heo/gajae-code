import { resolveGjcSessionForRead, SessionResolutionError } from "../../gjc-runtime/session-resolution";

async function resolveBoundarySessionId(cwd: string, sessionId?: string): Promise<string | undefined> {
	const normalizedSessionId = sessionId?.trim();
	if (normalizedSessionId) return normalizedSessionId;
	try {
		return (await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	} catch (error) {
		if (error instanceof SessionResolutionError && error.code === "no_session") return undefined;
		throw error;
	}
}

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
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	if (!resolvedSessionId) return [];
	const state = await readVisibleSkillActiveState(input.cwd, resolvedSessionId);
	const parent = input.parent.trim();
	const phase = input.phase.trim();
	if (!state || !parent || !phase) return [];
	return (state.active_subskills ?? []).filter(entry => entry.parent === parent && entry.phase === phase);
}
