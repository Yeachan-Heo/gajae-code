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

	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const state = resolvedSessionId ? await readVisibleSkillActiveState(input.cwd, resolvedSessionId) : null;
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
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const resolvedPhase = await resolveCurrentPhaseForParent({
		cwd: input.cwd,
		sessionId: resolvedSessionId,
		parent: input.skillName,
		explicitPhase: input.currentPhase,
	});

	const directActivation = input.activation;
	if (directActivation?.parent === input.skillName && directActivation.phase === resolvedPhase) {
		const body = await readSubskillBody(directActivation.filePath);
		return { block: wrapSubskillBlock(directActivation, body), details: directActivation };
	}

	if (!resolvedSessionId) return null;

	const [entry] = await readActiveSubskillsForParent({
		cwd: input.cwd,
		sessionId: resolvedSessionId,
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

	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	if (!resolvedSessionId) return "";
	const entries = await readActiveSubskillsForParent({
		cwd: input.cwd,
		sessionId: resolvedSessionId,
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

// ---------------------------------------------------------------------------
// Tier-1 sub-skill advertisement (metadata-only, bounded, target-parent scoped)
// ---------------------------------------------------------------------------

import type { GjcPluginRegistryEntry } from "./types";

const ADVERT_MAX_ITEMS = 12;
const ADVERT_MAX_DESC = 200;
const ADVERT_MAX_FIELD = 80;
const ADVERT_MAX_BYTES = 4 * 1024;

function escapeAdvertAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface AdvertItem {
	plugin: string;
	name: string;
	description: string;
	activationArg: string;
	phase: string;
}

function clampField(value: string): string {
	const v = value.length > ADVERT_MAX_FIELD ? `${value.slice(0, ADVERT_MAX_FIELD - 1)}\u2026` : value;
	return escapeAdvertAttr(v);
}

function renderAdvertItem(it: AdvertItem): string {
	const desc =
		it.description.length > ADVERT_MAX_DESC
			? `${it.description.slice(0, ADVERT_MAX_DESC - 1)}\u2026`
			: it.description;
	return `  - plugin="${clampField(it.plugin)}" name="${clampField(it.name)}" activation_arg="${clampField(it.activationArg)}" phase="${clampField(it.phase)}": ${escapeAdvertAttr(desc)}`;
}

function wrapAdvert(kind: "skill" | "agent", parent: string, lines: string[]): string {
	return `<gjc-plugin-subskill-advertisement parent="${clampField(parent)}" kind="${kind}">\n${lines.join("\n")}\n</gjc-plugin-subskill-advertisement>`;
}

function renderAdvertisement(items: AdvertItem[], kind: "skill" | "agent", parent: string): string {
	if (items.length === 0) return "";
	// Build iteratively against the byte budget so the block is HARD-capped even
	// if individual items are large; every metadata field is also length-clamped.
	const candidates = items.slice(0, ADVERT_MAX_ITEMS);
	const lines: string[] = [];
	let shownCount = 0;
	for (const it of candidates) {
		const next = [...lines, renderAdvertItem(it)];
		const omittedNote = `  - ${items.length - (shownCount + 1)} additional plugin sub-skill(s) omitted; invoke explicitly with a known activation arg.`;
		const probe = wrapAdvert(kind, parent, items.length - (shownCount + 1) > 0 ? [...next, omittedNote] : next);
		if (Buffer.byteLength(probe) > ADVERT_MAX_BYTES) break;
		lines.push(renderAdvertItem(it));
		shownCount += 1;
	}
	const omitted = items.length - shownCount;
	if (shownCount === 0) {
		// Nothing fit: guaranteed-small overflow-only block.
		return wrapAdvert(kind, parent, [
			`  - ${items.length} plugin sub-skill(s) available; invoke explicitly with a known activation arg.`,
		]);
	}
	if (omitted > 0) {
		lines.push(
			`  - ${omitted} additional plugin sub-skill(s) omitted; invoke explicitly with a known activation arg.`,
		);
	}
	return wrapAdvert(kind, parent, lines);
}

function collectAdverts(entries: readonly GjcPluginRegistryEntry[], parent: string, phase?: string): AdvertItem[] {
	const items: AdvertItem[] = [];
	for (const entry of entries) {
		if (!entry.enabled) continue;
		const disabled = new Set(entry.disabledSurfaceIds);
		for (const s of entry.surfaces.subskills) {
			if (disabled.has(s.extensionId)) continue;
			if (s.parent !== parent) continue;
			if (phase && s.phase !== phase) continue;
			items.push({
				plugin: entry.name,
				name: s.name,
				description: s.description,
				activationArg: s.activationArg,
				phase: s.phase,
			});
		}
	}
	return items;
}

/**
 * Tier-1 advertisement for a workflow parent skill: bounded, metadata-only list
 * of installed sub-skills bound to `parent`, rendered ONLY in that parent's
 * prompt (never the global public-workflow-surface). No body content.
 */
export function buildSubskillAdvertisement(
	entries: readonly GjcPluginRegistryEntry[],
	parent: string,
	phase?: string,
): string {
	return renderAdvertisement(collectAdverts(entries, parent, phase), "skill", parent);
}

/** Tier-1 advertisement for a role-agent parent. */
export function buildAgentSubskillAdvertisement(entries: readonly GjcPluginRegistryEntry[], agentName: string): string {
	return renderAdvertisement(collectAdverts(entries, agentName), "agent", agentName);
}
