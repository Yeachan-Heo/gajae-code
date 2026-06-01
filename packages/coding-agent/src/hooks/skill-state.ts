import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillDiscoverySettings } from "../config/skill-settings-defaults";
import { isUltragoalBypassPrompt, readUltragoalVerificationState } from "../gjc-runtime/ultragoal-guard";
import { buildSessionContext, loadEntriesFromFile, type SessionEntry } from "../session/session-manager";
import type { SkillActiveEntry as CanonicalSkillActiveEntry, WorkflowHudSummary } from "../skill-state/active-state";
import {
	compareSkillKeywordMatches,
	GJC_SKILL_KEYWORD_DEFINITIONS,
	type GjcWorkflowSkill,
	isGjcWorkflowSkill,
} from "./skill-keywords";

export const GJC_STATE_DIR = ".gjc/state";
export const SKILL_ACTIVE_STATE_FILE = "skill-active-state.json";

export interface EffectiveSkillConfigInput {
	skillsSettings?: SkillDiscoverySettings;
	disabledExtensions?: string[];
	unavailableReason?: string;
}

const SANITIZED_CONFIG_VALUE_LIMIT = 80;
const DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD = 0.05;

function sanitizeConfigValue(value: string): string {
	const compact = value.replace(/[\r\n\t]+/g, " ").trim();
	return compact.length > SANITIZED_CONFIG_VALUE_LIMIT
		? `${compact.slice(0, SANITIZED_CONFIG_VALUE_LIMIT - 1)}…`
		: compact;
}

function countNonEmptyStrings(values: readonly string[] | undefined): number {
	return values?.filter(value => typeof value === "string" && value.trim().length > 0).length ?? 0;
}

function formatBoolean(name: string, value: boolean | undefined): string {
	return `${name}=${value === true ? "true" : value === false ? "false" : "unset"}`;
}

export function buildSanitizedEffectiveSkillConfigContext(input: EffectiveSkillConfigInput | undefined): string {
	if (!input || input.unavailableReason) {
		const reason = input?.unavailableReason ? sanitizeConfigValue(input.unavailableReason) : "not available";
		return `Sanitized effective skill config unavailable (${reason}); bundled GJC workflow activation remains available for deep-interview, ralplan, ultragoal, team.`;
	}

	const settings = input.skillsSettings ?? {};
	const includeSkillCount = countNonEmptyStrings(settings.includeSkills);
	const ignoredSkillCount = countNonEmptyStrings(settings.ignoredSkills);
	const disabledSkillExtensionCount = countNonEmptyStrings(
		(input.disabledExtensions ?? []).filter(extension => extension.startsWith("skill:")),
	);
	const customDirectoryCount = countNonEmptyStrings(settings.customDirectories);

	return [
		"Sanitized effective skill config for filesystem/custom skill discovery; bundled GJC workflow activation remains available for exactly deep-interview, ralplan, ultragoal, team.",
		`Skill discovery booleans: ${[
			formatBoolean("enabled", settings.enabled),
			formatBoolean("enableSkillCommands", settings.enableSkillCommands),
			formatBoolean("enablePiUser", settings.enablePiUser),
			formatBoolean("enablePiProject", settings.enablePiProject),
			formatBoolean("enableCodexUser", settings.enableCodexUser),
			formatBoolean("enableClaudeUser", settings.enableClaudeUser),
			formatBoolean("enableClaudeProject", settings.enableClaudeProject),
		].join(", ")}.`,
		`Skill discovery filters: includeSkills.count=${includeSkillCount}; ignoredSkills.count=${ignoredSkillCount}; disabledSkillExtensions.count=${disabledSkillExtensionCount}.`,
		`Custom skill directories: count=${customDirectoryCount}.`,
	].join(" ");
}

export interface SkillKeywordMatch {
	keyword: string;
	skill: GjcWorkflowSkill;
	priority: number;
}

export interface SkillActiveEntry extends Omit<CanonicalSkillActiveEntry, "skill"> {
	skill: GjcWorkflowSkill;
	phase?: string;
	active?: boolean;
	activated_at?: string;
	updated_at?: string;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	hud?: WorkflowHudSummary;
	stale?: boolean;
}

export interface SkillActiveState {
	version: number;
	active: boolean;
	skill: GjcWorkflowSkill;
	keyword: string;
	phase: string;
	activated_at: string;
	updated_at: string;
	source: "gjc-skill-state-hook";
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	initialized_mode?: GjcWorkflowSkill;
	initialized_state_path?: string;
	active_skills: SkillActiveEntry[];
}

export interface ModeState {
	active?: boolean;
	current_phase?: string;
	skill?: string;
	session_id?: string;
	thread_id?: string;
	cwd?: string;
	updated_at?: string;
	handoff_from?: string;
	handoff_to?: string;
	handoff_at?: string;
	[key: string]: unknown;
}

export interface RecordSkillActivationInput {
	cwd: string;
	text: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	nowIso?: string;
	stateDir?: string;
}

export interface StopHookInput {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	stateDir?: string;
	sessionFile?: string;
}

export interface UserPromptSubmitStateInput {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	stateDir?: string;
	prompt?: string;
	sessionFile?: string;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(value: string | undefined): boolean {
	return Boolean(value && /[a-z0-9_]/i.test(value));
}

function keywordToPattern(keyword: string): RegExp {
	const escaped = escapeRegex(keyword);
	const prefix = isWordChar(keyword[0]) ? "(?<![A-Za-z0-9_])" : "";
	const suffix = isWordChar(keyword[keyword.length - 1]) ? "(?![A-Za-z0-9_])" : "";
	return new RegExp(`${prefix}${escaped}${suffix}`, "i");
}

const KEYWORD_PATTERNS = GJC_SKILL_KEYWORD_DEFINITIONS.map(definition => ({
	...definition,
	pattern: keywordToPattern(definition.keyword),
}));

function parseExplicitSkillInvocations(text: string): {
	matches: SkillKeywordMatch[];
	sawExplicitLikeInvocation: boolean;
} {
	const matches: SkillKeywordMatch[] = [];
	let sawExplicitLikeInvocation = false;
	const explicitPattern = /\$((?:gjc:)?[a-z][a-z0-9-]*)/gi;
	const seenSkills = new Set<string>();
	let match = explicitPattern.exec(text);
	while (match !== null) {
		sawExplicitLikeInvocation = true;
		const token = match[1] ?? "";
		const normalized = token.startsWith("gjc:") ? token.slice(4) : token;
		if (isGjcWorkflowSkill(normalized) && !seenSkills.has(normalized)) {
			seenSkills.add(normalized);
			matches.push({
				keyword: match[0],
				skill: normalized,
				priority: GJC_SKILL_KEYWORD_DEFINITIONS.find(definition => definition.skill === normalized)?.priority ?? 0,
			});
		}
		match = explicitPattern.exec(text);
	}
	return { matches, sawExplicitLikeInvocation };
}

export function detectSkillKeywords(text: string): SkillKeywordMatch[] {
	const explicit = parseExplicitSkillInvocations(text);
	if (explicit.matches.length > 0) return explicit.matches;
	if (explicit.sawExplicitLikeInvocation) return [];

	const implicit: SkillKeywordMatch[] = [];
	for (const definition of KEYWORD_PATTERNS) {
		const match = text.match(definition.pattern);
		if (!match) continue;
		implicit.push({ keyword: match[0], skill: definition.skill, priority: definition.priority });
	}

	const merged: SkillKeywordMatch[] = [];
	for (const item of implicit.sort(compareSkillKeywordMatches)) {
		if (merged.some(existing => existing.skill === item.skill)) continue;
		merged.push(item);
	}
	return merged;
}

export function detectPrimarySkillKeyword(text: string): SkillKeywordMatch | null {
	return detectSkillKeywords(text)[0] ?? null;
}

export function resolveGjcStateDir(cwd: string, stateDir?: string): string {
	return stateDir ? path.resolve(cwd, stateDir) : path.join(cwd, GJC_STATE_DIR);
}

function encodeStatePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

import { initialPhaseForSkill } from "../skill-state/initial-phase";

// Re-export for existing callers and tests that imported it from this module.
export { initialPhaseForSkill };

function modeStateFileName(skill: GjcWorkflowSkill): string {
	return `${skill}-state.json`;
}

function modeStatePath(stateDir: string, skill: GjcWorkflowSkill, sessionId?: string): string {
	if (sessionId) return path.join(stateDir, "sessions", encodeStatePathSegment(sessionId), modeStateFileName(skill));
	return path.join(stateDir, modeStateFileName(skill));
}

function skillStatePath(stateDir: string, sessionId?: string): string {
	if (sessionId) return path.join(stateDir, "sessions", encodeStatePathSegment(sessionId), SKILL_ACTIVE_STATE_FILE);
	return path.join(stateDir, SKILL_ACTIVE_STATE_FILE);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		const raw = await Bun.file(filePath).text();
		return JSON.parse(raw) as T;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		return null;
	}
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function entryMatchesContext(
	entry: SkillActiveEntry,
	state: SkillActiveState,
	sessionId?: string,
	threadId?: string,
): boolean {
	const entrySessionId = entry.session_id ?? state.session_id;
	const entryThreadId = entry.thread_id ?? state.thread_id;
	if (sessionId && entrySessionId && entrySessionId !== sessionId) return false;
	if (threadId && entryThreadId && entryThreadId !== threadId) return false;
	return true;
}

function listActiveSkills(state: SkillActiveState | null): SkillActiveEntry[] {
	if (!state?.active) return [];
	return state.active_skills.filter(entry => entry.active !== false);
}

export async function readVisibleSkillActiveState(
	cwd: string,
	sessionId?: string,
	stateDir?: string,
): Promise<SkillActiveState | null> {
	const resolvedStateDir = resolveGjcStateDir(cwd, stateDir);
	if (sessionId) {
		const sessionState = await readJsonFile<SkillActiveState>(skillStatePath(resolvedStateDir, sessionId));
		if (sessionState) return sessionState;
	}
	return await readJsonFile<SkillActiveState>(skillStatePath(resolvedStateDir));
}

export async function recordSkillActivation(input: RecordSkillActivationInput): Promise<SkillActiveState | null> {
	const match = detectPrimarySkillKeyword(input.text);
	if (!match) return null;

	const resolvedStateDir = resolveGjcStateDir(input.cwd, input.stateDir);
	const nowIso = input.nowIso ?? new Date().toISOString();
	const phase = initialPhaseForSkill(match.skill);
	const initializedStatePath = modeStatePath(resolvedStateDir, match.skill, input.sessionId);
	const entry: SkillActiveEntry = {
		skill: match.skill,
		phase,
		active: true,
		activated_at: nowIso,
		updated_at: nowIso,
		...(input.sessionId ? { session_id: input.sessionId } : {}),
		...(input.threadId ? { thread_id: input.threadId } : {}),
		...(input.turnId ? { turn_id: input.turnId } : {}),
	};
	const state: SkillActiveState = {
		version: 1,
		active: true,
		skill: match.skill,
		keyword: match.keyword,
		phase,
		activated_at: nowIso,
		updated_at: nowIso,
		source: "gjc-skill-state-hook",
		...(input.sessionId ? { session_id: input.sessionId } : {}),
		...(input.threadId ? { thread_id: input.threadId } : {}),
		...(input.turnId ? { turn_id: input.turnId } : {}),
		initialized_mode: match.skill,
		initialized_state_path: initializedStatePath,
		active_skills: [entry],
	};
	const modeState: ModeState = {
		active: true,
		current_phase: phase,
		skill: match.skill,
		cwd: input.cwd,
		updated_at: nowIso,
		...(input.sessionId ? { session_id: input.sessionId } : {}),
		...(input.threadId ? { thread_id: input.threadId } : {}),
		...(input.turnId ? { turn_id: input.turnId } : {}),
	};
	if (match.skill === "deep-interview") {
		modeState.threshold = DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD;
		modeState.threshold_source = "default";
	}

	await writeJsonFile(initializedStatePath, modeState);
	await writeJsonFile(skillStatePath(resolvedStateDir, input.sessionId), state);
	if (!input.sessionId) return state;
	await writeJsonFile(skillStatePath(resolvedStateDir), state);
	return state;
}

function isTerminalModeState(state: ModeState | null): boolean {
	if (!state || state.active !== true) return true;
	const phase = String(state.current_phase ?? "")
		.trim()
		.toLowerCase();
	return ["complete", "completed", "handoff", "failed", "cancelled", "canceled", "inactive"].includes(phase);
}

async function readVisibleModeState(
	cwd: string,
	skill: GjcWorkflowSkill,
	sessionId?: string,
	stateDir?: string,
): Promise<{ state: ModeState; statePath: string } | null> {
	const resolvedStateDir = resolveGjcStateDir(cwd, stateDir);
	if (sessionId) {
		const sessionStatePath = modeStatePath(resolvedStateDir, skill, sessionId);
		const sessionState = await readJsonFile<ModeState>(sessionStatePath);
		if (sessionState) return { state: sessionState, statePath: sessionStatePath };
	}
	const rootStatePath = modeStatePath(resolvedStateDir, skill);
	const rootState = await readJsonFile<ModeState>(rootStatePath);
	if (!rootState) return null;
	return { state: rootState, statePath: rootStatePath };
}

function stateMatchesContext(state: ModeState, sessionId?: string, threadId?: string): boolean {
	if (sessionId && state.session_id && state.session_id !== sessionId) return false;
	if (threadId && state.thread_id && state.thread_id !== threadId) return false;
	return true;
}

async function readCurrentGoalObjectiveFromSessionFile(sessionFile: string | undefined): Promise<string | null> {
	const trimmed = sessionFile?.trim();
	if (!trimmed) return null;
	const entries = (await loadEntriesFromFile(trimmed)).filter(
		(entry): entry is SessionEntry => entry.type !== "session",
	);
	const context = buildSessionContext(entries);
	const goal = context.modeData?.goal;
	if (typeof goal !== "object" || goal === null) return null;
	const objective = (goal as { objective?: unknown }).objective;
	return typeof objective === "string" && objective.trim().length > 0 ? objective.trim() : null;
}

export async function buildActiveUltragoalPromptContext(input: UserPromptSubmitStateInput): Promise<string | null> {
	const visibleModeState = await readVisibleModeState(input.cwd, "ultragoal", input.sessionId, input.stateDir);
	if (!visibleModeState) return null;
	if (isTerminalModeState(visibleModeState.state)) return null;
	if (!stateMatchesContext(visibleModeState.state, input.sessionId, input.threadId)) return null;

	const phase = String(visibleModeState.state.current_phase ?? "active");
	const stateObjective =
		typeof visibleModeState.state.objective === "string"
			? visibleModeState.state.objective
			: typeof visibleModeState.state.gjcObjective === "string"
				? visibleModeState.state.gjcObjective
				: "";
	const sessionObjective = await readCurrentGoalObjectiveFromSessionFile(input.sessionFile);
	const normalizedPrompt = input.prompt?.replace(/\\?"/g, '"');
	const isBypassPrompt = Boolean(
		(normalizedPrompt && isUltragoalBypassPrompt(normalizedPrompt)) ||
			(input.prompt && /goal[\s\S]{0,80}complete/i.test(input.prompt)),
	);
	if (isBypassPrompt) {
		const objectives = [sessionObjective, stateObjective].filter(
			(value): value is string => typeof value === "string" && value.trim().length > 0,
		);
		if (objectives.length === 0) {
			return "BLOCK_ULTRAGOAL_COMPLETION: Active Ultragoal completion is blocked until a current GJC goal objective can be verified. Use durable blocker work or run strict `gjc ultragoal checkpoint --status complete --quality-gate-json <file> --gjc-goal-json <file>` before completion.";
		}
		for (const objective of objectives) {
			const diagnostic = await readUltragoalVerificationState({
				cwd: input.cwd,
				currentGoal: { objective },
			});
			if (diagnostic.state === "unrelated_goal") continue;
			if (!["inactive", "active_verified_complete"].includes(diagnostic.state)) {
				return `BLOCK_ULTRAGOAL_COMPLETION: ${diagnostic.message} Use durable blocker work or run strict \`gjc ultragoal checkpoint --status complete --quality-gate-json <file> --gjc-goal-json <file>\` before completion.`;
			}
		}
	}
	return `Ultragoal is active (phase: ${phase}; state: ${visibleModeState.statePath}). If the user prompt is a steering request, use \`gjc ultragoal steer\` to add or steer subgoals. Normal prose should not mutate Ultragoal state.`;
}

export async function buildSkillStopOutput(input: StopHookInput): Promise<Record<string, unknown> | null> {
	const resolvedStateDir = resolveGjcStateDir(input.cwd, input.stateDir);
	const skillState = await readVisibleSkillActiveState(input.cwd, input.sessionId, input.stateDir);
	const activeEntries = listActiveSkills(skillState).filter(entry =>
		skillState ? entryMatchesContext(entry, skillState, input.sessionId, input.threadId) : false,
	);
	if (!skillState || activeEntries.length === 0) return null;

	for (const entry of activeEntries) {
		const modeState = await readJsonFile<ModeState>(modeStatePath(resolvedStateDir, entry.skill, input.sessionId));
		if (isTerminalModeState(modeState)) continue;
		const phase = String(modeState?.current_phase ?? entry.phase ?? skillState.phase ?? "active");
		const statePath = modeStatePath(resolvedStateDir, entry.skill, input.sessionId);
		if (entry.skill === "ultragoal") {
			const objective =
				(await readCurrentGoalObjectiveFromSessionFile(input.sessionFile)) ??
				(typeof modeState?.objective === "string"
					? modeState.objective
					: typeof modeState?.gjcObjective === "string"
						? modeState.gjcObjective
						: "");
			if (objective) {
				const diagnostic = await readUltragoalVerificationState({
					cwd: input.cwd,
					currentGoal: { objective },
				});
				if (diagnostic.state === "active_verified_complete") continue;
				if (!["inactive", "unrelated_goal"].includes(diagnostic.state)) {
					const ultragoalMessage = `GJC ultragoal verification is blocking stop: ${diagnostic.message} Run strict checkpoint verification or record review blockers before stopping.`;
					return {
						decision: "block",
						reason: ultragoalMessage,
						stopReason: `gjc_ultragoal_verification_${diagnostic.state}`,
						systemMessage: ultragoalMessage,
					};
				}
			}
		}
		const systemMessage = `GJC skill "${entry.skill}" is still active (phase: ${phase}; state: ${statePath}). Continue or explicitly finish/cancel the skill before stopping.`;
		return {
			decision: "block",
			reason: systemMessage,
			stopReason: `gjc_skill_${entry.skill.replace(/-/g, "_")}_${phase.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
			systemMessage,
		};
	}

	return null;
}

export function buildSkillActivationAdditionalContext(
	state: SkillActiveState,
	effectiveSkillConfig?: EffectiveSkillConfigInput,
): string {
	return [
		`GJC native UserPromptSubmit detected workflow keyword "${state.keyword}" -> ${state.skill}.`,
		state.initialized_mode && state.initialized_state_path
			? `skill: ${state.initialized_mode} activated and initial state initialized at ${state.initialized_state_path}; use \`gjc state write/read/clear --input '<json>' --json\` for runtime state updates.`
			: null,
		state.skill === "ultragoal"
			? "Ultragoal is active. If the user prompt is a steering request, use `gjc ultragoal steer` to add or steer subgoals."
			: null,
		buildSanitizedEffectiveSkillConfigContext(effectiveSkillConfig),
		"Follow AGENTS.md routing and preserve GJC workflow transition and planning-safety rules.",
	]
		.filter((value): value is string => Boolean(value))
		.join(" ");
}
