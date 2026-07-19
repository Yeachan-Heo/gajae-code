import type { Observation, SessionState } from "./types";

export const OWNER_STARTUP_BLOCKER = "owner-died-before-first-prompt";

export interface CompletedTerminalEvent {
	cursor: number;
	createdAt: string;
	kind: string;
}

export function isOwnerLivenessBlocker(blocker: string): boolean {
	return blocker === "detached-owner-not-live" || blocker.startsWith("owner-vanished:");
}

export function needsVanishedOwnerBlock(
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): boolean {
	if (observation.ownerLive || state.lifecycle !== "observing") return false;
	if (completedTerminal || observation.observedSignals.includes("completed")) return false;
	return observation.observedSignals.some(
		signal => signal === "prompt-accepted" || signal === "tool-call" || signal === "streaming",
	);
}

export async function reconcileOwnerLifecycle(input: {
	state: SessionState;
	observation: Observation;
	completedTerminal: CompletedTerminalEvent | null;
	startupBlocked: boolean;
	persist: (state: SessionState) => Promise<void>;
	nowIso: () => string;
}): Promise<SessionState> {
	const { state, observation, completedTerminal } = input;
	if (
		completedTerminal &&
		!observation.ownerLive &&
		observation.gitDelta === "clean" &&
		state.lifecycle !== "completed" &&
		state.lifecycle !== "retired"
	) {
		state.lifecycle = "completed";
		state.blockers = state.blockers.filter(blocker => !isOwnerLivenessBlocker(blocker));
		state.updatedAt = input.nowIso();
		await input.persist(state);
	}
	if (needsVanishedOwnerBlock(state, observation, completedTerminal)) {
		const blocker = `owner-vanished:${observation.gitDelta}`;
		state.lifecycle = "blocked";
		state.blockers = state.blockers.includes(blocker) ? state.blockers : [...state.blockers, blocker];
		state.updatedAt = input.nowIso();
		await input.persist(state);
	}
	if (input.startupBlocked && state.lifecycle !== "completed" && state.lifecycle !== "retired") {
		state.lifecycle = "blocked";
		state.blockers = state.blockers.includes(OWNER_STARTUP_BLOCKER)
			? state.blockers
			: [...state.blockers, OWNER_STARTUP_BLOCKER];
		state.updatedAt = input.nowIso();
		await input.persist(state);
	}
	return state;
}
