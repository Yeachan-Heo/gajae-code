import { readVisibleSkillActiveState } from "../../skill-state/active-state";
import { initialPhaseForSkill } from "../../skill-state/initial-phase";
import { readActiveSubskillsForParent } from "./state";
import { GJC_SUBSKILL_PARENT_AGENTS, type LoadedSubskillActivation } from "./types";

export async function readSubskillBody(filePath: string): Promise<string> {
	const content = await Bun.file(filePath).text();
	return content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function wrapSubskillBlock(
	activation: {
		plugin: string;
		subskillName: string;
		parent: string;
		phase: string;
		activationArg: string;
		filePath: string;
	},
	body: string,
): string {
	return `\n\n---\n\n<gjc-subskill plugin="${escapeAttribute(activation.plugin)}" name="${escapeAttribute(activation.subskillName)}" parent="${escapeAttribute(activation.parent)}" phase="${escapeAttribute(activation.phase)}" arg="${escapeAttribute(activation.activationArg)}">\n${body}\n</gjc-subskill>`;
}

export async function resolveCurrentPhaseForParent(input: {
	cwd: string;
	sessionId?: string;
	parent: string;
	explicitPhase?: string;
}): Promise<string> {
	const explicitPhase = input.explicitPhase?.trim();
	if (explicitPhase) return explicitPhase;

	const state = await readVisibleSkillActiveState(input.cwd, input.sessionId);
	const persistedPhase = state?.active_skills?.find(entry => entry.skill === input.parent)?.phase?.trim();
	if (persistedPhase) return persistedPhase;

	if (state?.skill === input.parent) {
		const statePhase = state.phase?.trim();
		if (statePhase) return statePhase;
	}

	return initialPhaseForSkill(input.parent);
}

export async function buildSubskillInjection(input: {
	cwd: string;
	sessionId?: string;
	skillName: string;
	activation?: LoadedSubskillActivation;
	currentPhase?: string;
}): Promise<{ block: string; details?: LoadedSubskillActivation } | null> {
	const resolvedPhase = await resolveCurrentPhaseForParent({
		cwd: input.cwd,
		sessionId: input.sessionId,
		parent: input.skillName,
		explicitPhase: input.currentPhase,
	});

	const directActivation = input.activation;
	if (directActivation?.parent === input.skillName && directActivation.phase === resolvedPhase) {
		const body = await readSubskillBody(directActivation.filePath);
		return { block: wrapSubskillBlock(directActivation, body), details: directActivation };
	}

	const [entry] = await readActiveSubskillsForParent({
		cwd: input.cwd,
		sessionId: input.sessionId,
		parent: input.skillName,
		phase: resolvedPhase,
	});
	if (!entry) return null;

	const activation: LoadedSubskillActivation = {
		plugin: entry.plugin,
		subskillName: entry.subskillName,
		parent: entry.parent,
		bindsTo: entry.bindsTo,
		phase: entry.phase,
		activationArg: entry.activationArg,
		filePath: entry.filePath,
		toolPaths: entry.toolPaths,
	};
	const body = await readSubskillBody(activation.filePath);
	return { block: wrapSubskillBlock(activation, body), details: activation };
}

export async function buildAgentSubskillInjection(input: {
	cwd: string;
	sessionId?: string;
	agentName: string;
}): Promise<string> {
	if (!(GJC_SUBSKILL_PARENT_AGENTS as readonly string[]).includes(input.agentName)) return "";

	const entries = await readActiveSubskillsForParent({
		cwd: input.cwd,
		sessionId: input.sessionId,
		parent: input.agentName,
		phase: "prompt",
	});
	if (entries.length === 0) return "";

	const blocks = await Promise.all(
		entries.map(async entry => {
			const body = await readSubskillBody(entry.filePath);
			return wrapSubskillBlock(entry, body);
		}),
	);
	return blocks.join("");
}
