/**
 * Host-side implementations for the Telegram `/menu` button surface.
 *
 * These back the optional `getMenuSkillIds` / `getMenuModelOptions` /
 * `runMenuSkill` / `setMenuModelByRef` ExtensionAPI methods. They live here so
 * every host that wires an {@link AgentSession} into the extension runtime can
 * expose the menu capabilities with one-line delegations, and the heavy skill /
 * model logic (which mirrors the ACP text-mode path) is written once.
 *
 * Skill execution reuses the exact ACP single-invocation flow
 * (`resolveSubskillActivationForSkillInvocation` -> `buildSkillPromptMessage` ->
 * `promptCustomMessage`). Model switching is temporary-only via
 * `setModelTemporary`, so saved defaults / role overrides / profiles are never
 * touched.
 */

import type { Model } from "@gajae-code/ai";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../session/messages";
import { resolveSubskillActivationForSkillInvocation } from "../gjc-plugins/activation";
import { buildSkillPromptMessage, getSkillSlashCommandNames } from "../skills";
import { buildMenuModelOptions } from "./menu-model-options";
import type { MenuModelOption } from "./types";

export type { MenuModelOption };

function modelRef(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Slash-command names of the non-hidden skills the session exposes (or empty when disabled). */
export function getMenuSkillIds(session: AgentSession): string[] {
	if (!session.skillsSettings?.enableSkillCommands) return [];
	return session.skills
		.filter(skill => skill.hide !== true)
		.map(skill => getSkillSlashCommandNames(skill)[0])
		.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Picker options for the model menu: the curated default models are always
 * offered (intersected with availability), with the current model pinned first
 * and recent-usage models filling the remaining slots.
 */
export function getMenuModelOptions(session: AgentSession): MenuModelOption[] {
	const available = session.getAvailableModels().map(model => ({ ref: modelRef(model), label: model.id }));
	const currentRef = session.model ? modelRef(session.model) : undefined;
	const mruRefs = session.settings.getStorage()?.getModelUsageOrder?.() ?? [];
	return buildMenuModelOptions({ available, currentRef, mruRefs });
}

/** Switch ONLY the current session's temporary model. Throws when `ref` is unavailable. */
export async function setMenuModelByRef(
	session: AgentSession,
	ref: string,
): Promise<{ previous?: string; next: string }> {
	const target = session.getAvailableModels().find(model => modelRef(model) === ref);
	if (!target) throw new Error(`model not available: ${ref}`);
	const previous = session.model ? modelRef(session.model) : undefined;
	await session.setModelTemporary(target);
	return { previous, next: ref };
}

/** Run a skill by its slash-command name with `prompt` as its argument (ACP-parity flow). */
export async function runMenuSkill(session: AgentSession, skillName: string, prompt: string): Promise<void> {
	if (!session.skillsSettings?.enableSkillCommands) {
		throw new Error("skill commands are disabled for this session");
	}
	const skill = session.skills.find(
		candidate => candidate.hide !== true && getSkillSlashCommandNames(candidate).includes(skillName),
	);
	if (!skill) throw new Error(`unknown skill: ${skillName}`);

	const activation = await resolveSubskillActivationForSkillInvocation({
		cwd: session.sessionManager.getCwd(),
		sessionId: session.sessionId,
		skillName: skill.name,
		args: prompt,
	});
	const built = await buildSkillPromptMessage(skill, activation.cleanedArgs, {
		subskillActivation: activation.activation,
		subskillActivationSet: activation.activeSubskillsToPersist,
		cwd: session.sessionManager.getCwd(),
		sessionId: session.sessionId,
	});
	await session.promptCustomMessage({
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: built.message,
		display: true,
		details: built.details,
		attribution: "user",
	});
}
