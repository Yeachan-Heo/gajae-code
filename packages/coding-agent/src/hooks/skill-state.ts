import { existsSync } from "node:fs";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import type { SkillDiscoverySettings } from "../config/skill-settings-defaults";
import { detectDeepInterviewPlaintextAskLeak } from "../deep-interview/plaintext-gate-guard";
import { activeSnapshotPath, modeStatePath as sessionModeStatePath } from "../gjc-runtime/session-layout";
import { resolveGjcSessionForRead } from "../gjc-runtime/session-resolution";
import { ModeStateSchema, SkillActiveStateSchema } from "../gjc-runtime/state-schema";
import {
	readExistingStateForMutation,
	writeGuardedJsonAtomic,
	writeGuardedWorkflowEnvelopeAtomic,
} from "../gjc-runtime/state-writer";
import { isUltragoalBypassPrompt, verifyUltragoalDurableCompletionState } from "../gjc-runtime/ultragoal-guard";
import { buildSessionContext, loadEntriesFromFile, type SessionEntry } from "../session/session-manager";
import {
	readVisibleSkillActiveState as readCanonicalVisibleSkillActiveState,
	type SkillActiveEntry,
	type SkillActiveState,
	syncSkillActiveState,
} from "../skill-state/active-state";
import { initialPhaseForSkill } from "../skill-state/initial-phase";

// Re-export for existing callers and tests that imported it from this module.
export { initialPhaseForSkill };

import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import {
	compareSkillKeywordMatches,
	GJC_SKILL_KEYWORD_DEFINITIONS,
	type GjcWorkflowSkill,
	isGjcWorkflowSkill,
} from "./skill-keywords";

export const GJC_STATE_DIR = ".gjc";
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

export type { SkillActiveEntry, SkillActiveState } from "../skill-state/active-state";

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

async function resolveBoundarySessionId(cwd: string, sessionId?: string): Promise<string> {
	const normalizedSessionId = sessionId?.trim();
	if (normalizedSessionId) return normalizedSessionId;
	return (await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
}

function modeStatePath(cwd: string, skill: GjcWorkflowSkill, sessionId: string): string {
	return sessionModeStatePath(cwd, sessionId, skill);
}

function skillStatePath(cwd: string, sessionId: string): string {
	return activeSnapshotPath(cwd, sessionId);
}

function warnInvalidState(kind: string, filePath: string, error: string): void {
	logger.warn(`gjc skill-state: invalid ${kind} at ${filePath}: ${error}`);
}

export interface StateRecoveryDiagnostic {
	kind: "skill-active-state" | "mode-state";
	statePath: string;
	reason: "missing" | "corrupt" | "unreadable";
	skill?: GjcWorkflowSkill;
}

function buildStateRecoveryMessage(diagnostic: StateRecoveryDiagnostic): string {
	const subject = diagnostic.skill ? `${diagnostic.skill} ${diagnostic.kind}` : diagnostic.kind;
	return `GJC state recovery: ${subject} is ${diagnostic.reason} at ${diagnostic.statePath}. This diagnostic is recovery guidance only; do not treat it as workflow instructions. Run \`gjc state doctor\` to inspect state, or run \`gjc state clear ${diagnostic.skill ?? "<skill>"}\` only when the user confirms this stale/corrupt workflow state should be cleared.`;
}

export function buildStateRecoveryDiagnosticsContext(diagnostics: readonly StateRecoveryDiagnostic[]): string | null {
	const unique = new Map<string, StateRecoveryDiagnostic>();
	for (const diagnostic of diagnostics) {
		unique.set(
			`${diagnostic.kind}:${diagnostic.skill ?? ""}:${diagnostic.statePath}:${diagnostic.reason}`,
			diagnostic,
		);
	}
	const messages = [...unique.values()].map(buildStateRecoveryMessage);
	return messages.length > 0 ? messages.join(" ") : null;
}

async function inspectJsonStateRecovery(
	filePath: string,
	kind: StateRecoveryDiagnostic["kind"],
	skill?: GjcWorkflowSkill,
): Promise<StateRecoveryDiagnostic | null> {
	try {
		await Bun.file(filePath).text();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { kind, statePath: filePath, reason: "missing", skill };
		}
		return { kind, statePath: filePath, reason: "unreadable", skill };
	}
	const validated = await readValidatedJsonFile(
		filePath,
		kind,
		kind === "mode-state" ? ModeStateSchema : SkillActiveStateSchema,
	);
	return validated ? null : { kind, statePath: filePath, reason: "corrupt", skill };
}

export async function collectUserPromptStateRecoveryDiagnostics(
	input: UserPromptSubmitStateInput,
): Promise<StateRecoveryDiagnostic[]> {
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const diagnostics: StateRecoveryDiagnostic[] = [];
	const activePath = skillStatePath(input.cwd, resolvedSessionId);
	if (existsSync(activePath)) {
		const activeDiagnostic = await inspectJsonStateRecovery(activePath, "skill-active-state");
		if (activeDiagnostic) diagnostics.push(activeDiagnostic);
	}
	const ultragoalPath = modeStatePath(input.cwd, "ultragoal", resolvedSessionId);
	if (existsSync(ultragoalPath)) {
		const ultragoalDiagnostic = await inspectJsonStateRecovery(ultragoalPath, "mode-state", "ultragoal");
		if (ultragoalDiagnostic) diagnostics.push(ultragoalDiagnostic);
	}
	return diagnostics;
}

async function readValidatedJsonFile<T>(
	filePath: string,
	kind: string,
	schema: { safeParse: (value: unknown) => { success: true } | { success: false; error: { message: string } } },
): Promise<T | null> {
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		warnInvalidState(kind, filePath, `read error: ${(error as Error).message}`);
		return null;
	}
	let value: T;
	try {
		value = JSON.parse(raw) as T;
	} catch (error) {
		warnInvalidState(kind, filePath, `invalid JSON: ${(error as Error).message}`);
		return null;
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		warnInvalidState(kind, filePath, parsed.error.message);
		return null;
	}
	return value;
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
	return (state.active_skills ?? []).filter(entry => entry.active !== false);
}

function isWorkflowActiveEntry(entry: SkillActiveEntry): entry is SkillActiveEntry & { skill: GjcWorkflowSkill } {
	return isGjcWorkflowSkill(entry.skill);
}

export async function readVisibleSkillActiveState(
	cwd: string,
	sessionId?: string,
	_stateDir?: string,
): Promise<SkillActiveState | null> {
	return await readCanonicalVisibleSkillActiveState(cwd, await resolveBoundarySessionId(cwd, sessionId));
}

interface SeedSkillActivationStateInput {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	nowIso?: string;
	stateDir?: string;
}

async function seedSkillActivationState(
	skill: GjcWorkflowSkill,
	keyword: string,
	source: string,
	input: SeedSkillActivationStateInput,
): Promise<SkillActiveState> {
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const nowIso = input.nowIso ?? new Date().toISOString();
	const phase = initialPhaseForSkill(skill);
	const initializedStatePath = modeStatePath(input.cwd, skill, resolvedSessionId);
	const entry: SkillActiveEntry = {
		skill,
		phase,
		active: true,
		activated_at: nowIso,
		updated_at: nowIso,
		session_id: resolvedSessionId,
		...(input.threadId ? { thread_id: input.threadId } : {}),
		...(input.turnId ? { turn_id: input.turnId } : {}),
	};
	const state: SkillActiveState = {
		version: 1,
		active: true,
		skill,
		keyword,
		phase,
		activated_at: nowIso,
		updated_at: nowIso,
		source,
		session_id: resolvedSessionId,
		...(input.threadId ? { thread_id: input.threadId } : {}),
		...(input.turnId ? { turn_id: input.turnId } : {}),
		initialized_mode: skill,
		initialized_state_path: initializedStatePath,
		active_skills: [entry],
	};
	const modeState: ModeState = {
		active: true,
		version: WORKFLOW_STATE_VERSION,
		current_phase: phase,
		skill,
		cwd: input.cwd,
		updated_at: nowIso,
		session_id: resolvedSessionId,
		...(input.threadId ? { thread_id: input.threadId } : {}),
		...(input.turnId ? { turn_id: input.turnId } : {}),
	};
	if (skill === "deep-interview") {
		modeState.threshold = DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD;
		modeState.threshold_source = "default";
	}

	await readExistingStateForMutation(initializedStatePath);
	const expectedRevision = 0;
	await writeGuardedWorkflowEnvelopeAtomic(initializedStatePath, modeState, {
		cwd: input.cwd,
		policy: "source",
		expectedRevision,
		receipt: {
			cwd: input.cwd,
			skill,
			owner: "gjc-hook",
			command: source,
			sessionId: resolvedSessionId,
		},
		audit: { category: "state", verb: "write", owner: "gjc-hook", skill, sessionId: resolvedSessionId },
	});
	const persistedModeState =
		(await readValidatedJsonFile<ModeState>(initializedStatePath, "mode-state", ModeStateSchema)) ?? modeState;
	const sourceRevision =
		typeof persistedModeState.state_revision === "number" && Number.isFinite(persistedModeState.state_revision)
			? persistedModeState.state_revision
			: undefined;

	try {
		await syncSkillActiveState({
			cwd: input.cwd,
			skill,
			active: true,
			phase,
			sessionId: resolvedSessionId,
			threadId: input.threadId,
			turnId: input.turnId,
			source,
			receipt: undefined,
			sourceRevision,
			nowIso,
		});
	} catch {
		// Derived active-state/HUD writes are best-effort during activation; source mode-state already persisted.
	}
	try {
		await writeGuardedJsonAtomic(skillStatePath(input.cwd, resolvedSessionId), state, {
			cwd: input.cwd,
			policy: "cache",
			sourceRevision: (sourceRevision ?? 0) + 1,
			receipt: undefined,
			audit: { category: "state", verb: "write", owner: "gjc-hook", sessionId: resolvedSessionId },
		});
	} catch {
		// Corrupt derived active-state is reported by recovery diagnostics; activation remains fail-open.
	}
	return state;
}

// Fallback for native-hook prompts when SkillPromptDetails.subskillActivation is absent;
// real /skill dispatch paths resolve sub-skill activation before prompt construction.
export async function recordSkillActivation(input: RecordSkillActivationInput): Promise<SkillActiveState | null> {
	const match = detectPrimarySkillKeyword(input.text);
	if (!match) return null;
	return await seedSkillActivationState(match.skill, match.keyword, "gjc-skill-state-hook", input);
}

export interface EnsureWorkflowSkillActivationInput {
	cwd: string;
	skill: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	nowIso?: string;
	stateDir?: string;
}

/**
 * Idempotently seed `.gjc/state` for a workflow skill that was invoked directly
 * (e.g. via `/skill:<name>`) rather than through keyword detection. This ensures
 * the mutation guard and Stop hook engage the moment a workflow skill becomes
 * active, instead of relying on the skill prompt to run its own state-init steps.
 *
 * The seed is non-destructive: if an active entry for this skill already exists
 * (for example after a `gjc state handoff` promotion that carries
 * `handoff_from`/`handoff_at` lineage), nothing is written so lineage is
 * preserved. Non-workflow skills are ignored.
 */
export async function ensureWorkflowSkillActivationState(
	input: EnsureWorkflowSkillActivationInput,
): Promise<SkillActiveState | null> {
	const skill = input.skill.trim();
	if (!isGjcWorkflowSkill(skill)) return null;
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const existing = await readVisibleSkillActiveState(input.cwd, resolvedSessionId, input.stateDir);
	const alreadyActive = listActiveSkills(existing).some(
		entry =>
			entry.skill === skill &&
			(existing ? entryMatchesContext(entry, existing, resolvedSessionId, input.threadId) : true),
	);
	if (alreadyActive) return existing;
	return await seedSkillActivationState(skill, `/skill:${skill}`, "gjc-skill-invocation", {
		cwd: input.cwd,
		sessionId: resolvedSessionId,
		threadId: input.threadId,
		turnId: input.turnId,
		nowIso: input.nowIso,
		stateDir: input.stateDir,
	});
}

function isTerminalModeState(state: ModeState | null): boolean {
	if (state?.active !== true) return true;
	const phase = String(state.current_phase ?? "")
		.trim()
		.toLowerCase();
	return ["complete", "completed", "handoff", "failed", "cancelled", "canceled", "inactive"].includes(phase);
}

/**
 * Phases that genuinely finish a skill and release the Stop block. Note that
 * "handoff" is intentionally absent: a skill sitting in the handoff phase has
 * declared it is ready to chain but has not yet been demoted/cleared, so it
 * must keep blocking until the chain (or an explicit clear) removes it.
 */
const STOP_RELEASING_PHASES = ["complete", "completed", "failed", "cancelled", "canceled", "inactive"] as const;

/**
 * Handoff workflows must never stop silently — they always have to offer the
 * user a next step (refine, hand off, or finish) via the ask tool. The Stop
 * hook keeps blocking these even in the "handoff" phase until they are demoted
 * (active:false) or cleared.
 */
function isHandoffRequiredSkill(skill: GjcWorkflowSkill): boolean {
	return skill === "deep-interview" || skill === "ralplan";
}

/**
 * Decide whether an active-state entry's mode-state releases the Stop block.
 *
 * For handoff-required skills a missing or unreadable mode-state does NOT
 * release the block: those workflows must always end by offering the user a
 * next step, so the `skill-active-state.json` entry stays authoritative until
 * the skill is demoted or cleared. For other skills a missing/corrupt
 * mode-state preserves the historical fail-open behavior so a broken state file
 * cannot lock a session.
 */
function modeStateReleasesStop(state: ModeState | null, handoffRequired: boolean): boolean {
	if (!state) return !handoffRequired;
	if (state.active !== true) return true;
	const phase = String(state.current_phase ?? "")
		.trim()
		.toLowerCase();
	if ((STOP_RELEASING_PHASES as readonly string[]).includes(phase)) return true;
	if (!handoffRequired && phase === "handoff") return true;
	return false;
}

function ultragoalDurableCompletionReleasesStop(state: string): boolean {
	return state === "inactive" || state === "active_verified_complete";
}

/**
 * Cross-file coherence guard for a mode-state that claims it releases the Stop
 * block. `modeStateReleasesStop` trusts a single mode-state file; if any writer
 * leaves that file stale or incoherent (e.g. `active:false` / a terminal phase
 * after a `clear` while a new run's goals are still pending), trusting it alone
 * silently defeats the Stop protection.
 *
 * This consults the authoritative durable state the Stop hook can already read
 * and returns a block reason when that state contradicts the release. It stays
 * cheap and read-only — ultragoal reads the durable plan; skills without an
 * independent durable source release as before.
 */
async function detectStaleModeStateRelease(
	skill: GjcWorkflowSkill,
	cwd: string,
	sessionId?: string | null,
): Promise<string | null> {
	if (skill !== "ultragoal") return null;
	const diagnostic = await verifyUltragoalDurableCompletionState({ cwd, sessionId });
	if (ultragoalDurableCompletionReleasesStop(diagnostic.state)) return null;
	return `${diagnostic.message} Run \`gjc ultragoal complete-goals\` to continue, or checkpoint a finished story with \`gjc ultragoal checkpoint --status complete --quality-gate-json <file>\`, before stopping`;
}

/**
 * Deep-interview terminal phases that represent an explicit abort/cancel rather
 * than an ordinary stop. These are legitimate terminals even without a
 * crystallized spec, so they must NOT be forced through crystallization.
 */
const DEEP_INTERVIEW_ABORT_PHASES = new Set(["failed", "cancelled", "canceled"]);

/**
 * A deep-interview run is "crystallized" once it has persisted a final spec.
 * `persistDeepInterviewSpec` records the spec path in the mode-state and writes
 * the artifact under `.gjc/specs/`, so a crystallized state carries a
 * `spec_path` that still resolves to a real file. A bare `spec_path` with no
 * backing file (deleted/stale/fabricated) does not count as crystallized.
 */
async function deepInterviewSpecCrystallized(state: ModeState, cwd: string): Promise<boolean> {
	const raw = state.spec_path;
	const specPath = typeof raw === "string" ? raw.trim() : "";
	if (!specPath) return false;
	const resolved = path.isAbsolute(specPath) ? specPath : path.resolve(cwd, specPath);
	try {
		return await Bun.file(resolved).exists();
	} catch {
		return false;
	}
}

/**
 * Deep-interview-scoped terminalization guard (#674). An ordinary stop must not
 * let a deep-interview run disappear as a generic stopped task while the user
 * still needs the distilled interview state: when its mode-state would release
 * the Stop block it must have actually crystallized the interview into a
 * persisted spec/handoff. Explicit abort/cancel phases and the `active:false`
 * demotion/clear outcome (the handoff/chain result) remain legitimate terminals.
 * Returns a public-safe diagnostic that forces crystallization, or null to
 * release. Scoped to deep-interview only — other workflows are untouched.
 */
async function detectUncrystallizedDeepInterviewStop(
	skill: GjcWorkflowSkill,
	state: ModeState | null,
	cwd: string,
): Promise<string | null> {
	if (skill !== "deep-interview") return null;
	// active:false is the demotion/clear outcome (chain handoff or explicit
	// clear already terminalized the run); a missing state blocks upstream.
	if (state?.active !== true) return null;
	const phase = String(state.current_phase ?? "")
		.trim()
		.toLowerCase();
	if (DEEP_INTERVIEW_ABORT_PHASES.has(phase)) return null;
	if (await deepInterviewSpecCrystallized(state, cwd)) return null;
	return `the deep-interview run reached a terminal phase ("${phase || "unknown"}") without crystallizing a usable spec/handoff. Run \`gjc deep-interview --write --stage final\` (optionally \`--handoff ralplan\`) to persist the distilled interview spec, hand off through the deep-interview policy, or explicitly cancel/clear the interview before stopping`;
}

async function readVisibleModeState(
	cwd: string,
	skill: GjcWorkflowSkill,
	sessionId?: string,
	_stateDir?: string,
): Promise<{ state: ModeState; statePath: string } | null> {
	const resolvedSessionId = await resolveBoundarySessionId(cwd, sessionId);
	const sessionStatePath = modeStatePath(cwd, skill, resolvedSessionId);
	const sessionState = await readValidatedJsonFile<ModeState>(sessionStatePath, "mode-state", ModeStateSchema);
	if (!sessionState) return null;
	return { state: sessionState, statePath: sessionStatePath };
}

function stateMatchesContext(state: ModeState, sessionId?: string, threadId?: string): boolean {
	if (sessionId && state.session_id && state.session_id !== sessionId) return false;
	if (threadId && state.thread_id && state.thread_id !== threadId) return false;
	return true;
}

async function readLatestAssistantTextFromSessionFile(sessionFile: string | undefined): Promise<string | null> {
	const trimmed = sessionFile?.trim();
	if (!trimmed) return null;
	let entries: SessionEntry[];
	try {
		entries = (await loadEntriesFromFile(trimmed)).filter((entry): entry is SessionEntry => entry.type !== "session");
	} catch {
		return null;
	}
	if (entries.length === 0) return null;
	const context = buildSessionContext(entries);
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		const trimmedText = text.trim();
		return trimmedText.length > 0 ? trimmedText : null;
	}
	return null;
}

async function shouldRescueDeepInterviewPlaintextAskLeak(
	skill: GjcWorkflowSkill,
	state: ModeState | null,
	cwd: string,
	sessionFile: string | undefined,
): Promise<boolean> {
	if (skill !== "deep-interview") return false;
	if (state?.active !== true) return false;
	const phase = String(state.current_phase ?? "")
		.trim()
		.toLowerCase();
	if (DEEP_INTERVIEW_ABORT_PHASES.has(phase)) return false;
	if (await deepInterviewSpecCrystallized(state, cwd)) return false;
	const latestAssistantText = await readLatestAssistantTextFromSessionFile(sessionFile);
	if (!latestAssistantText) return false;
	return detectDeepInterviewPlaintextAskLeak(latestAssistantText) !== null;
}

function buildDeepInterviewPlaintextAskLeakMessage(statePath: string): string {
	return `GJC deep-interview emitted a Deep Interview question/options block as plain text (${statePath}). It must not wait for a prose answer. Continue immediately by calling the ask tool with the Restate gate question and options: Yes, crystallize; Adjust wording; Missing scope; plus free text/custom input.`;
}

export async function buildActiveUltragoalPromptContext(input: UserPromptSubmitStateInput): Promise<string | null> {
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const visibleModeState = await readVisibleModeState(input.cwd, "ultragoal", resolvedSessionId, input.stateDir);
	if (!visibleModeState) return null;
	if (isTerminalModeState(visibleModeState.state)) return null;
	if (!stateMatchesContext(visibleModeState.state, resolvedSessionId, input.threadId)) return null;

	const phase = String(visibleModeState.state.current_phase ?? "active");
	const normalizedPrompt = input.prompt?.replace(/\\?"/g, '"');
	const isBypassPrompt = Boolean(
		(normalizedPrompt && isUltragoalBypassPrompt(normalizedPrompt)) ||
			(input.prompt && /goal[\s\S]{0,80}complete/i.test(input.prompt)),
	);
	if (isBypassPrompt) {
		const diagnostic = await verifyUltragoalDurableCompletionState({
			cwd: input.cwd,
			sessionId: resolvedSessionId,
		});
		if (!ultragoalDurableCompletionReleasesStop(diagnostic.state)) {
			return `BLOCK_ULTRAGOAL_COMPLETION: ${diagnostic.message} Use durable blocker work or run strict \`gjc ultragoal checkpoint --status complete --quality-gate-json <file>\` before completion.`;
		}
	}
	return `Ultragoal is active (phase: ${phase}; state: ${visibleModeState.statePath}). If the user prompt is a steering request, use \`gjc ultragoal steer\` to add or steer subgoals. Normal prose should not mutate Ultragoal state.`;
}

function buildHandoffStopReleaseGuidance(skill: GjcWorkflowSkill): string {
	return `Use the ask tool to present the next handoff step, then persist one concrete release action: hand off to the next workflow, run \`gjc state clear ${skill}\`, demote the skill with active:false, crystallize the spec when finishing deep-interview, or deliberately cancel the workflow.`;
}

function buildHandoffModeStateRecoveryMessage(skill: GjcWorkflowSkill, phase: string, statePath: string): string {
	return `GJC handoff skill "${skill}" mode-state is missing or corrupt (phase: ${phase}; state: ${statePath}). ${buildHandoffStopReleaseGuidance(skill)}`;
}

function buildHandoffForceAskMessage(skill: GjcWorkflowSkill, phase: string, statePath: string): string {
	if (skill === "deep-interview" && phase.trim().toLowerCase() === "interviewing") {
		return `GJC deep-interview is still interviewing and must not stop (${statePath}). Continue the active round immediately: score and persist an answered round, then report progress. Use the ask tool for the next question. Only stop after crystallizing, recording a handoff, or explicitly cancelling the workflow. ${buildHandoffStopReleaseGuidance(skill)}`;
	}
	return `GJC handoff skill "${skill}" must not stop without offering a next step (phase: ${phase}; state: ${statePath}). ${buildHandoffStopReleaseGuidance(skill)}`;
}

export async function buildSkillStopOutput(input: StopHookInput): Promise<Record<string, unknown> | null> {
	const resolvedSessionId = await resolveBoundarySessionId(input.cwd, input.sessionId);
	const skillState = await readVisibleSkillActiveState(input.cwd, resolvedSessionId, input.stateDir);
	const activeEntries = listActiveSkills(skillState)
		.filter(isWorkflowActiveEntry)
		.filter(entry =>
			skillState ? entryMatchesContext(entry, skillState, resolvedSessionId, input.threadId) : false,
		);
	if (!skillState || activeEntries.length === 0) return null;

	for (const entry of activeEntries) {
		const modeState = await readValidatedJsonFile<ModeState>(
			modeStatePath(input.cwd, entry.skill, resolvedSessionId),
			"mode-state",
			ModeStateSchema,
		);
		const handoffRequired = isHandoffRequiredSkill(entry.skill);
		if (!modeState && handoffRequired) {
			const phase = String(entry.phase ?? skillState.phase ?? "active");
			const statePath = modeStatePath(input.cwd, entry.skill, resolvedSessionId);
			const recoveryMessage = buildHandoffModeStateRecoveryMessage(entry.skill, phase, statePath);
			return {
				decision: "block",
				reason: recoveryMessage,
				stopReason: `gjc_skill_${entry.skill.replace(/-/g, "_")}_mode_state_recovery`,
				systemMessage: recoveryMessage,
			};
		}
		if (await shouldRescueDeepInterviewPlaintextAskLeak(entry.skill, modeState, input.cwd, input.sessionFile)) {
			const statePath = modeStatePath(input.cwd, entry.skill, resolvedSessionId);
			const rescueMessage = buildDeepInterviewPlaintextAskLeakMessage(statePath);
			return {
				decision: "block",
				reason: rescueMessage,
				stopReason: "gjc_skill_deep_interview_plaintext_ask_leak",
				systemMessage: rescueMessage,
			};
		}
		if (modeStateReleasesStop(modeState, handoffRequired)) {
			// A mode-state that claims it releases the Stop block must agree with
			// authoritative durable state. If a stale/incoherent mode-state would
			// release while the plan/ledger still shows pending work, block instead
			// of trusting the single file (see #659).
			const staleRelease = await detectStaleModeStateRelease(entry.skill, input.cwd, resolvedSessionId);
			if (staleRelease) {
				const coherenceMessage = `GJC skill "${entry.skill}" mode-state reports it released the Stop block (${modeStatePath(input.cwd, entry.skill, resolvedSessionId)}), but ${staleRelease}. The mode-state is incoherent with authoritative durable state; finish or explicitly clear the pending work before stopping.`;
				return {
					decision: "block",
					reason: coherenceMessage,
					stopReason: `gjc_skill_${entry.skill.replace(/-/g, "_")}_stale_mode_state`,
					systemMessage: coherenceMessage,
				};
			}
			// Deep-interview must not terminalize through an ordinary stop without
			// crystallizing its distilled interview state into a spec/handoff
			// (explicit abort/cancel and the active:false demotion are preserved
			// as legitimate terminals). See #674.
			const uncrystallized = await detectUncrystallizedDeepInterviewStop(entry.skill, modeState, input.cwd);
			if (uncrystallized) {
				const crystallizeMessage = `GJC deep-interview must crystallize before stopping (${modeStatePath(input.cwd, entry.skill, resolvedSessionId)}): ${uncrystallized}.`;
				return {
					decision: "block",
					reason: crystallizeMessage,
					stopReason: "gjc_skill_deep_interview_uncrystallized",
					systemMessage: crystallizeMessage,
				};
			}
			continue;
		}
		const phase = String(modeState?.current_phase ?? entry.phase ?? skillState.phase ?? "active");
		const statePath = modeStatePath(input.cwd, entry.skill, resolvedSessionId);
		if (entry.skill === "ultragoal") {
			const diagnostic = await verifyUltragoalDurableCompletionState({
				cwd: input.cwd,
				sessionId: resolvedSessionId,
			});
			if (ultragoalDurableCompletionReleasesStop(diagnostic.state)) continue;
			const ultragoalMessage = `GJC ultragoal verification is blocking stop: ${diagnostic.message} Run \`gjc ultragoal checkpoint --status complete --quality-gate-json <file>\` or record review blockers before stopping.`;
			return {
				decision: "block",
				reason: ultragoalMessage,
				stopReason: `gjc_ultragoal_verification_${diagnostic.state}`,
				systemMessage: ultragoalMessage,
			};
		}
		const systemMessage = handoffRequired
			? buildHandoffForceAskMessage(entry.skill, phase, statePath)
			: `GJC skill "${entry.skill}" is still active (phase: ${phase}; state: ${statePath}). Continue or explicitly finish/cancel the skill before stopping.`;
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
