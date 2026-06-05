import * as path from "node:path";
import {
	type ActiveSessionScope,
	rebuildActiveSnapshot,
	removeActiveEntry,
	writeActiveEntry,
} from "../gjc-runtime/state-writer";
import type { WorkflowStateReceipt } from "./workflow-state-contract";

export const SKILL_ACTIVE_STATE_FILE = "skill-active-state.json";

export const CANONICAL_GJC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;

export type CanonicalGjcWorkflowSkill = (typeof CANONICAL_GJC_WORKFLOW_SKILLS)[number];
export type WorkflowHudSeverity = "info" | "warning" | "blocked" | "error" | "success";

export interface WorkflowHudChip {
	label: string;
	value?: string;
	priority?: number;
	severity?: WorkflowHudSeverity;
}

export interface WorkflowHudSummary {
	version: 1;
	summary?: string;
	chips?: WorkflowHudChip[];
	details?: WorkflowHudChip[];
	severity?: WorkflowHudSeverity;
	updated_at?: string;
}

export type { WorkflowStateReceipt } from "./workflow-state-contract";

export interface ActiveSubskillEntry {
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	activationArg: string;
	filePath: string;
	toolPaths: string[];
}

export interface SkillActiveEntry {
	skill: string;
	phase?: string;
	active?: boolean;
	activated_at?: string;
	updated_at?: string;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	hud?: WorkflowHudSummary;
	stale?: boolean;
	receipt?: WorkflowStateReceipt;
	handoff_from?: string;
	handoff_to?: string;
	handoff_at?: string;
	active_subskills?: ActiveSubskillEntry[];
}

export interface SkillActiveState {
	version?: number;
	active?: boolean;
	skill?: string;
	keyword?: string;
	phase?: string;
	activated_at?: string;
	updated_at?: string;
	source?: string;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	initialized_mode?: CanonicalGjcWorkflowSkill;
	initialized_state_path?: string;
	active_skills?: SkillActiveEntry[];
	active_subskills?: ActiveSubskillEntry[];
	[key: string]: unknown;
}

export interface SkillActiveStatePaths {
	rootPath: string;
	sessionPath?: string;
}

export interface SyncSkillActiveStateOptions {
	cwd: string;
	skill: string;
	active: boolean;
	phase?: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	nowIso?: string;
	source?: string;
	hud?: WorkflowHudSummary;
	receipt?: WorkflowStateReceipt;
	handoff_from?: string;
	handoff_to?: string;
	handoff_at?: string;
	active_subskills?: ActiveSubskillEntry[];
}

const HUD_TEXT_LIMIT = 80;
const HUD_CHIP_LIMIT = 6;
const HUD_DETAIL_LIMIT = 12;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const HUD_SEVERITIES = new Set<WorkflowHudSeverity>(["info", "warning", "blocked", "error", "success"]);

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function sanitizeHudString(value: unknown, limit = HUD_TEXT_LIMIT): string | undefined {
	const normalized = safeString(value)
		.replace(ANSI_PATTERN, "")
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	if (!normalized) return undefined;
	return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function normalizeSeverity(value: unknown): WorkflowHudSeverity | undefined {
	return typeof value === "string" && HUD_SEVERITIES.has(value as WorkflowHudSeverity)
		? (value as WorkflowHudSeverity)
		: undefined;
}

function normalizeHudChip(raw: unknown): WorkflowHudChip | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const label = sanitizeHudString(record.label, 32);
	if (!label) return null;
	const value = sanitizeHudString(record.value, HUD_TEXT_LIMIT);
	const priority =
		typeof record.priority === "number" && Number.isFinite(record.priority) ? record.priority : undefined;
	const severity = normalizeSeverity(record.severity);
	return {
		label,
		...(value ? { value } : {}),
		...(priority !== undefined ? { priority } : {}),
		...(severity ? { severity } : {}),
	};
}

function normalizeHudChips(raw: unknown, limit: number): WorkflowHudChip[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const chips = raw
		.map(normalizeHudChip)
		.filter((chip): chip is WorkflowHudChip => chip !== null)
		.slice(0, limit);
	return chips.length > 0 ? chips : undefined;
}

export function normalizeWorkflowHudSummary(raw: unknown): WorkflowHudSummary | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	const summary = sanitizeHudString(record.summary);
	const chips = normalizeHudChips(record.chips, HUD_CHIP_LIMIT);
	const details = normalizeHudChips(record.details, HUD_DETAIL_LIMIT);
	const severity = normalizeSeverity(record.severity);
	const updatedAt = sanitizeHudString(record.updated_at, 40);
	return {
		version: 1,
		...(summary ? { summary } : {}),
		...(chips ? { chips } : {}),
		...(details ? { details } : {}),
		...(severity ? { severity } : {}),
		...(updatedAt ? { updated_at: updatedAt } : {}),
	};
}

function normalizeWorkflowStateReceipt(raw: unknown): WorkflowStateReceipt | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	const skill = safeString(record.skill).trim();
	if (!isCanonicalGjcWorkflowSkill(skill)) return undefined;
	const owner = safeString(record.owner).trim();
	if (owner !== "gjc-state-cli" && owner !== "gjc-runtime" && owner !== "gjc-hook") return undefined;
	const command = sanitizeHudString(record.command, 120);
	const statePath = sanitizeHudString(record.state_path, 240);
	const storagePath = sanitizeHudString(record.storage_path, 240);
	const mutatedAt = sanitizeHudString(record.mutated_at, 40);
	const freshUntil = sanitizeHudString(record.fresh_until, 40);
	const status = safeString(record.status).trim();
	const mutationId = sanitizeHudString(record.mutation_id, 120);
	if (!command || !statePath || !storagePath || !mutatedAt || !freshUntil || !mutationId) return undefined;
	return {
		version: 1,
		skill,
		owner,
		command,
		state_path: statePath,
		storage_path: storagePath,
		mutated_at: mutatedAt,
		fresh_until: freshUntil,
		status: status === "stale" ? "stale" : "fresh",
		mutation_id: mutationId,
	};
}
function normalizeActiveSubskillEntry(raw: unknown): ActiveSubskillEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const plugin = safeString(record.plugin).trim();
	const subskillName = safeString(record.subskillName).trim();
	const parent = safeString(record.parent).trim();
	const bindsTo = safeString(record.bindsTo).trim();
	const phase = safeString(record.phase).trim();
	const activationArg = safeString(record.activationArg).trim();
	const filePath = safeString(record.filePath).trim();
	const toolPaths = Array.isArray(record.toolPaths)
		? record.toolPaths.map(item => safeString(item).trim()).filter(Boolean)
		: [];
	if (!plugin || !subskillName || !parent || !bindsTo || !phase || !activationArg || !filePath) return null;
	return { plugin, subskillName, parent, bindsTo, phase, activationArg, filePath, toolPaths };
}

function normalizeActiveSubskillEntries(raw: unknown): ActiveSubskillEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const entries = raw
		.map(normalizeActiveSubskillEntry)
		.filter((entry): entry is ActiveSubskillEntry => entry !== null);
	return entries.length > 0 ? entries : undefined;
}

function activeSubskillEntryKey(entry: ActiveSubskillEntry): string {
	return [entry.plugin, entry.parent, entry.phase, entry.activationArg].join("\0");
}

function unionActiveSubskillEntries(...entrySets: Array<ActiveSubskillEntry[] | undefined>): ActiveSubskillEntry[] {
	const merged: ActiveSubskillEntry[] = [];
	const seen = new Set<string>();
	for (const entries of entrySets) {
		for (const entry of entries ?? []) {
			const key = activeSubskillEntryKey(entry);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(entry);
		}
	}
	return merged;
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function entryKey(entry: Pick<SkillActiveEntry, "skill" | "session_id">): string {
	return `${entry.skill}::${safeString(entry.session_id).trim()}`;
}

function normalizeEntry(raw: unknown): SkillActiveEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const skill = safeString(record.skill).trim();
	if (!skill) return null;
	const hud = normalizeWorkflowHudSummary(record.hud);
	const receipt = normalizeWorkflowStateReceipt(record.receipt);
	const activeSubskills = normalizeActiveSubskillEntries(record.active_subskills);
	return {
		...record,
		skill,
		phase: safeString(record.phase).trim() || undefined,
		active: record.active !== false,
		activated_at: safeString(record.activated_at).trim() || undefined,
		updated_at: safeString(record.updated_at).trim() || undefined,
		session_id: safeString(record.session_id).trim() || undefined,
		thread_id: safeString(record.thread_id).trim() || undefined,
		turn_id: safeString(record.turn_id).trim() || undefined,
		handoff_from: safeString(record.handoff_from).trim() || undefined,
		handoff_to: safeString(record.handoff_to).trim() || undefined,
		handoff_at: safeString(record.handoff_at).trim() || undefined,
		...(hud ? { hud } : {}),
		...(receipt ? { receipt } : {}),
		...(activeSubskills ? { active_subskills: activeSubskills } : {}),
		stale: undefined,
	};
}

export function isCanonicalGjcWorkflowSkill(skill: string): skill is CanonicalGjcWorkflowSkill {
	return (CANONICAL_GJC_WORKFLOW_SKILLS as readonly string[]).includes(skill);
}

export function listActiveSkills(raw: unknown): SkillActiveEntry[] {
	if (!raw || typeof raw !== "object") return [];
	const state = raw as SkillActiveState;
	const deduped = new Map<string, SkillActiveEntry>();

	if (Array.isArray(state.active_skills)) {
		for (const candidate of state.active_skills) {
			const normalized = normalizeEntry(candidate);
			if (!normalized || normalized.active === false) continue;
			deduped.set(entryKey(normalized), normalized);
		}
	}

	const topLevelSkill = safeString(state.skill).trim();
	if (deduped.size === 0 && state.active === true && topLevelSkill) {
		const entry: SkillActiveEntry = {
			skill: topLevelSkill,
			phase: safeString(state.phase).trim() || undefined,
			active: true,
			activated_at: safeString(state.activated_at).trim() || undefined,
			updated_at: safeString(state.updated_at).trim() || undefined,
			session_id: safeString(state.session_id).trim() || undefined,
			thread_id: safeString(state.thread_id).trim() || undefined,
			turn_id: safeString(state.turn_id).trim() || undefined,
		};
		deduped.set(entryKey(entry), entry);
	}

	return [...deduped.values()];
}

export function normalizeSkillActiveState(raw: unknown): SkillActiveState | null {
	if (!raw || typeof raw !== "object") return null;
	const state = raw as SkillActiveState;
	const activeSkills = listActiveSkills(state);
	const primary = activeSkills.find(entry => entry.skill === safeString(state.skill).trim()) ?? activeSkills[0];
	const skill = safeString(state.skill).trim() || primary?.skill || "";
	if (!skill && activeSkills.length === 0) return null;
	return {
		...state,
		version: typeof state.version === "number" ? state.version : 1,
		active: typeof state.active === "boolean" ? state.active : activeSkills.length > 0,
		skill,
		keyword: safeString(state.keyword).trim(),
		phase: safeString(state.phase).trim() || primary?.phase || "",
		activated_at: safeString(state.activated_at).trim() || primary?.activated_at || "",
		updated_at: safeString(state.updated_at).trim() || primary?.updated_at || "",
		source: safeString(state.source).trim() || undefined,
		session_id: safeString(state.session_id).trim() || primary?.session_id || undefined,
		thread_id: safeString(state.thread_id).trim() || primary?.thread_id || undefined,
		turn_id: safeString(state.turn_id).trim() || primary?.turn_id || undefined,
		active_subskills: activeSkills.flatMap(entry => entry.active_subskills ?? []),
		active_skills: activeSkills.length > 0 ? activeSkills : [],
	};
}

export function getSkillActiveStatePaths(cwd: string, sessionId?: string): SkillActiveStatePaths {
	const stateDir = path.join(cwd, ".gjc", "state");
	const rootPath = path.join(stateDir, SKILL_ACTIVE_STATE_FILE);
	const normalizedSessionId = safeString(sessionId).trim();
	if (!normalizedSessionId) return { rootPath };
	return {
		rootPath,
		sessionPath: path.join(stateDir, "sessions", encodePathSegment(normalizedSessionId), SKILL_ACTIVE_STATE_FILE),
	};
}

/**
 * Raw read for handoff mutations. Returns the *unnormalized* parsed object so
 * inactive entries remain visible to `rawActiveEntries` — `normalizeSkillActiveState`
 * delegates to `listActiveSkills`, which filters out `active:false` rows for HUD
 * purposes. Handoff history (e.g. previously demoted callers carrying
 * `handoff_to`/`handoff_at` lineage) must survive across successive handoffs,
 * so the on-disk `active_skills` array is preserved verbatim and the next
 * write recomputes the per-skill row from there.
 *
 * Strict semantics: tolerates ENOENT only. Corrupt JSON / non-ENOENT I/O
 * errors propagate so callers can surface a non-zero CLI status.
 */
async function readRawActiveStateForHandoff(filePath: string, strict: boolean): Promise<SkillActiveState | null> {
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		if (!strict) return null;
		throw err;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as SkillActiveState;
	} catch (err) {
		if (!strict) return null;
		throw err;
	}
}

function rawActiveEntries(state: SkillActiveState | null): SkillActiveEntry[] {
	if (!state) return [];
	const out: SkillActiveEntry[] = [];
	if (Array.isArray(state.active_skills)) {
		for (const candidate of state.active_skills) {
			const normalized = normalizeEntry(candidate);
			if (normalized) out.push(normalized);
		}
	}
	// Legacy top-level fallback: pre-`active_skills` state files persisted a single
	// active workflow as top-level `{ active: true, skill, phase, … }` with no
	// `active_skills` array. `normalizeSkillActiveState` still synthesizes that row,
	// so the raw read used by the HUD, mutation guard, and caller inference must do
	// the same or it would treat a legacy active workflow as absent.
	if (out.length === 0 && state.active === true) {
		const skill = safeString(state.skill).trim();
		if (skill) {
			out.push({
				skill,
				phase: safeString(state.phase).trim() || undefined,
				active: true,
				activated_at: safeString(state.activated_at).trim() || undefined,
				updated_at: safeString(state.updated_at).trim() || undefined,
				session_id: safeString(state.session_id).trim() || undefined,
				thread_id: safeString(state.thread_id).trim() || undefined,
				turn_id: safeString(state.turn_id).trim() || undefined,
			});
		}
	}
	return out;
}

function filterRootEntriesForSession(entries: SkillActiveEntry[], sessionId?: string): SkillActiveEntry[] {
	const normalizedSessionId = safeString(sessionId).trim();
	if (!normalizedSessionId) return entries;
	return entries.filter(entry => {
		const entrySessionId = safeString(entry.session_id).trim();
		return entrySessionId.length === 0 || entrySessionId === normalizedSessionId;
	});
}

function entryRecency(entry: SkillActiveEntry): number {
	const stamp = entry.handoff_at || entry.updated_at || entry.activated_at;
	const ms = stamp ? Date.parse(stamp) : Number.NaN;
	// NaN signals "no trustworthy timestamp" so comparisons can refuse to let an
	// unknown-recency row win a tie; callers must treat NaN explicitly.
	return ms;
}

/**
 * Session ownership rank for a row visible to a `sessionId` read. When a concrete
 * session is in scope, a row owned by that exact session outranks a session-less
 * fallback row, which outranks a foreign-session row. Session-less rows are global
 * fallbacks and must never override a session's own state. With no scope session,
 * every row ranks equally.
 */
function sessionScopeRank(entry: SkillActiveEntry, sessionId?: string): number {
	const scope = safeString(sessionId).trim();
	if (!scope) return 0;
	const entrySession = safeString(entry.session_id).trim();
	if (entrySession === scope) return 2;
	if (entrySession.length === 0) return 1;
	return 0;
}

/**
 * Pick the surviving row for a single skill within a session-scoped visible set.
 * Precedence, highest first:
 *   1. exact-session ownership over a session-less fallback row,
 *   2. a strictly-newer valid timestamp,
 *   3. a valid timestamp over a missing/unparseable one,
 *   4. active over inactive — so an untrustworthy inactive row can never hide an
 *      active row — then merge order for a total tie.
 * A genuine handoff demotion still supersedes a stale active row of the same skill
 * because, within one session scope, it carries the newest valid timestamp.
 */
function moreVisibleEntry(
	incumbent: SkillActiveEntry,
	challenger: SkillActiveEntry,
	sessionId?: string,
): SkillActiveEntry {
	const scopeDelta = sessionScopeRank(incumbent, sessionId) - sessionScopeRank(challenger, sessionId);
	if (scopeDelta !== 0) return scopeDelta > 0 ? incumbent : challenger;
	const ri = entryRecency(incumbent);
	const rc = entryRecency(challenger);
	const vi = Number.isFinite(ri);
	const vc = Number.isFinite(rc);
	if (vi && vc && ri !== rc) return ri > rc ? incumbent : challenger;
	if (vi !== vc) return vi ? incumbent : challenger;
	const incumbentActive = incumbent.active !== false;
	const challengerActive = challenger.active !== false;
	if (incumbentActive !== challengerActive) return incumbentActive ? incumbent : challenger;
	return incumbent;
}

/**
 * Collapse the merged, session-scoped entries down to a single row per skill.
 * A handed-off skill can leave more than one row visible to a session — e.g. a
 * row seeded without a session id (rendered globally by
 * `filterRootEntriesForSession`) plus a later, session-scoped handoff demotion
 * of the same skill. Without this collapse the HUD renders the same workflow
 * twice and keeps showing a skill that has already handed control to its
 * successor. `moreVisibleEntry` picks the winner so a handoff demotion supersedes
 * an older stale `active:true` row (and is then dropped by the active filter
 * below) while a session's own active row is never hidden by a session-less or
 * untrustworthy-timestamp row.
 */
function dedupeVisibleBySkill(entries: SkillActiveEntry[], sessionId?: string): SkillActiveEntry[] {
	const winners = new Map<string, SkillActiveEntry>();
	for (const entry of entries) {
		const current = winners.get(entry.skill);
		winners.set(entry.skill, current ? moreVisibleEntry(current, entry, sessionId) : entry);
	}
	return [...winners.values()];
}

/**
 * The planning pipeline advances one stage at a time: `deep-interview →
 * ralplan → ultragoal`. Each stage is activated through its own command path
 * (`gjc deep-interview`, `gjc ralplan`, `gjc ultragoal`), and those activations
 * do not demote the previous stage's row — only the explicit `handoff` verb
 * does. Without this collapse, activating ultragoal while ralplan is still
 * `active:true` would render both stages and keep showing a workflow that has
 * already handed control forward. Keep only the most recently updated pipeline
 * stage so the HUD reflects the single current workflow. `team` is intentionally
 * excluded — it runs alongside ultragoal — and every non-pipeline skill is left
 * untouched.
 *
 * This is a HUD-display policy only. It is applied by the skill HUD renderer and
 * deliberately NOT folded into `readVisibleSkillActiveState`, whose callers (the
 * deep-interview mutation guard and handoff caller inference) must keep seeing
 * every genuinely-active skill rather than the single most-recent pipeline stage.
 */
const PLANNING_PIPELINE_SKILLS = new Set<string>(["deep-interview", "ralplan", "ultragoal"]);

export function collapsePlanningPipeline(entries: readonly SkillActiveEntry[]): SkillActiveEntry[] {
	const pipeline = entries.filter(entry => PLANNING_PIPELINE_SKILLS.has(entry.skill));
	if (pipeline.length <= 1) return [...entries];
	let current = pipeline[0];
	let currentRecency = entryRecency(current);
	for (const entry of pipeline) {
		const recency = entryRecency(entry);
		// Prefer a strictly-newer valid timestamp; a valid timestamp also beats a
		// missing/unparseable one. Ties (or all-invalid) keep the first stage
		// deterministically rather than letting an unknown-recency row win.
		const better = Number.isFinite(recency) && (!Number.isFinite(currentRecency) || recency > currentRecency);
		if (better) {
			current = entry;
			currentRecency = recency;
		}
	}
	return entries.filter(entry => !PLANNING_PIPELINE_SKILLS.has(entry.skill) || entry === current);
}

function mergeVisibleEntries(
	sessionState: SkillActiveState | null,
	rootState: SkillActiveState | null,
	sessionId?: string,
): SkillActiveEntry[] {
	// Use the raw (active + inactive) rows so a handoff demotion stays visible
	// long enough to supersede a stale same-skill row before the active filter.
	const rootEntries = filterRootEntriesForSession(rawActiveEntries(rootState), sessionId);
	const merged = new Map(rootEntries.map(entry => [entryKey(entry), entry]));
	for (const entry of rawActiveEntries(sessionState)) {
		merged.set(entryKey(entry), entry);
	}
	return dedupeVisibleBySkill([...merged.values()], sessionId).filter(entry => entry.active !== false);
}

export async function readVisibleSkillActiveState(cwd: string, sessionId?: string): Promise<SkillActiveState | null> {
	const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
	const [rootState, sessionState] = await Promise.all([
		readRawActiveStateForHandoff(rootPath, false),
		sessionPath ? readRawActiveStateForHandoff(sessionPath, false) : Promise.resolve(null),
	]);
	const activeSkills = mergeVisibleEntries(sessionState, rootState, sessionId);
	if (activeSkills.length === 0) return null;
	const primary = activeSkills[0];
	return {
		...(rootState ?? {}),
		...(sessionState ?? {}),
		version: 1,
		active: true,
		skill: primary?.skill ?? "",
		phase: primary?.phase ?? "",
		session_id: safeString(sessionId).trim() || primary?.session_id,
		active_skills: activeSkills,
		active_subskills: activeSkills.flatMap(entry => entry.active_subskills ?? []),
	};
}

function activeStateWriterAudit(verb: string) {
	return { category: "state" as const, verb, owner: "gjc-runtime" as const };
}

async function persistActiveEntry(
	cwd: string,
	sessionScope: ActiveSessionScope | undefined,
	entry: SkillActiveEntry,
): Promise<void> {
	if (entry.active === false) {
		await removeActiveEntry(cwd, sessionScope, entry.skill, {
			cwd,
			audit: activeStateWriterAudit("remove-active-entry"),
		});
	} else {
		await writeActiveEntry(cwd, sessionScope, entry.skill, entry, {
			cwd,
			audit: activeStateWriterAudit("write-active-entry"),
		});
	}
}

async function writeHandoffEntry(
	cwd: string,
	sessionScope: ActiveSessionScope | undefined,
	entry: SkillActiveEntry,
): Promise<void> {
	await writeActiveEntry(cwd, sessionScope, entry.skill, entry, {
		cwd,
		audit: activeStateWriterAudit("write-active-entry"),
	});
}

async function rebuildActiveState(cwd: string, sessionScope?: ActiveSessionScope): Promise<void> {
	await rebuildActiveSnapshot(cwd, sessionScope, { cwd, audit: activeStateWriterAudit("rebuild-active-snapshot") });
}

async function activeSubskillsForExistingEntry(
	cwd: string,
	sessionId: string | undefined,
	skill: string,
): Promise<ActiveSubskillEntry[] | undefined> {
	const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
	const [rootState, sessionState] = await Promise.all([
		readRawActiveStateForHandoff(rootPath, false),
		sessionPath ? readRawActiveStateForHandoff(sessionPath, false) : Promise.resolve(null),
	]);
	const existing = mergeVisibleEntries(sessionState, rootState, sessionId).find(entry => entry.skill === skill);
	return existing?.active_subskills;
}

export async function syncSkillActiveState(options: SyncSkillActiveStateOptions): Promise<void> {
	const preservedActiveSubskills =
		options.active_subskills === undefined
			? await activeSubskillsForExistingEntry(options.cwd, options.sessionId, options.skill)
			: undefined;
	const nowIso = options.nowIso ?? new Date().toISOString();
	const hud = normalizeWorkflowHudSummary(options.hud);
	const entry: SkillActiveEntry = {
		skill: options.skill,
		phase: options.phase,
		active: options.active,
		activated_at: nowIso,
		updated_at: nowIso,
		session_id: options.sessionId,
		thread_id: options.threadId,
		turn_id: options.turnId,
		...(options.handoff_from ? { handoff_from: options.handoff_from } : {}),
		...(options.handoff_to ? { handoff_to: options.handoff_to } : {}),
		...(options.handoff_at ? { handoff_at: options.handoff_at } : {}),
		...(hud ? { hud } : {}),
		...(options.receipt ? { receipt: options.receipt } : {}),
		...(options.active_subskills !== undefined
			? { active_subskills: options.active_subskills }
			: preservedActiveSubskills
				? { active_subskills: preservedActiveSubskills }
				: {}),
	};
	await persistActiveEntry(options.cwd, undefined, entry);
	await rebuildActiveState(options.cwd);

	if (!options.sessionId) return;
	const sessionScope = { sessionId: options.sessionId };
	await persistActiveEntry(options.cwd, sessionScope, entry);
	await rebuildActiveState(options.cwd, sessionScope);
}

export interface ApplyHandoffOptions {
	cwd: string;
	caller: SyncSkillActiveStateOptions;
	callee: SyncSkillActiveStateOptions;
	/** Shared timestamp; falls back to new Date().toISOString(). */
	nowIso?: string;
	/** When true, read errors other than ENOENT propagate. */
	strict?: boolean;
}

/**
 * Atomically apply a workflow-skill handoff to both the session-scoped and
 * root `skill-active-state.json` files in a single write per file.
 *
 * Write order: **session first, root last**. The session file is the
 * source of truth for HUD; the root aggregate must never lead the session
 * during a handoff window. Each file is rewritten once with caller demoted
 * to `active:false` (preserving `handoff_to`/`handoff_at` lineage) and
 * callee promoted to `active:true` (with `handoff_from`/`handoff_at`).
 */
export async function applyHandoffToActiveState(options: ApplyHandoffOptions): Promise<void> {
	const nowIso = options.nowIso ?? new Date().toISOString();
	const callerEntry = buildSyncEntry(options.caller, nowIso);
	const calleeEntry = buildSyncEntry(options.callee, nowIso);
	const sessionId = options.callee.sessionId ?? options.caller.sessionId;
	const { rootPath, sessionPath } = getSkillActiveStatePaths(options.cwd, sessionId);
	const readState = (filePath: string) => readRawActiveStateForHandoff(filePath, options.strict === true);
	await Promise.all([readState(rootPath), ...(sessionPath ? [readState(sessionPath)] : [])]);

	// A skill can hold more than one visible row in this session's scope — e.g.
	// it was seeded without a session id (rendered globally) and is now handed
	// off under a concrete session id. Supersede every same-session-scope row of
	// the caller and callee skills, not just the exact `skill::session_id` key,
	// so a stale `active:true` row cannot survive the demotion and keep showing
	// in the HUD. Rows owned by other sessions are left untouched.
	const handoffSession = safeString(sessionId).trim();
	const reassignedSkills = new Set([callerEntry.skill, calleeEntry.skill]);
	const supersedesVisible = (entry: SkillActiveEntry): boolean => {
		if (!reassignedSkills.has(entry.skill)) return false;
		const entrySession = safeString(entry.session_id).trim();
		return entrySession.length === 0 || entrySession === handoffSession;
	};
	const applyEntries = (entries: SkillActiveEntry[]): SkillActiveEntry[] => {
		const callerKey = entryKey(callerEntry);
		const priorCaller =
			entries.find(e => entryKey(e) === callerKey) ??
			entries.find(e => e.skill === callerEntry.skill && supersedesVisible(e) && Boolean(e.handoff_from));
		const kept = entries.filter(e => !supersedesVisible(e));
		// Merge prior lineage into the demoted caller so multi-step handoff
		// chains preserve `handoff_from` from the previous transition while
		// the new `handoff_to`/`handoff_at` describe this one.
		const mergedCaller: SkillActiveEntry = priorCaller
			? {
					...callerEntry,
					...(priorCaller.handoff_from && !callerEntry.handoff_from
						? { handoff_from: priorCaller.handoff_from }
						: {}),
					...(priorCaller.active_subskills ? { active_subskills: priorCaller.active_subskills } : {}),
				}
			: callerEntry;
		const activeSubskills = unionActiveSubskillEntries(priorCaller?.active_subskills, calleeEntry.active_subskills);
		const mergedCallee: SkillActiveEntry =
			activeSubskills.length > 0 ? { ...calleeEntry, active_subskills: activeSubskills } : calleeEntry;
		return [...kept, mergedCaller, mergedCallee];
	};
	const writeEntries = async (
		sessionScope: ActiveSessionScope | undefined,
		prior: SkillActiveState | null,
	): Promise<void> => {
		const nextEntries = applyEntries(rawActiveEntries(prior));
		for (const entry of nextEntries) {
			await writeHandoffEntry(options.cwd, sessionScope, entry);
		}
		await rebuildActiveState(options.cwd, sessionScope);
	};

	if (sessionPath) {
		const prior = await readState(sessionPath);
		await writeEntries({ sessionId }, prior);
	}
	const priorRoot = await readState(rootPath);
	await writeEntries(undefined, priorRoot);
}

function buildSyncEntry(options: SyncSkillActiveStateOptions, nowIso: string): SkillActiveEntry {
	const hud = normalizeWorkflowHudSummary(options.hud);
	return {
		skill: options.skill,
		phase: options.phase,
		active: options.active,
		activated_at: nowIso,
		updated_at: nowIso,
		session_id: options.sessionId,
		thread_id: options.threadId,
		turn_id: options.turnId,
		...(options.handoff_from ? { handoff_from: options.handoff_from } : {}),
		...(options.handoff_to ? { handoff_to: options.handoff_to } : {}),
		...(options.handoff_at ? { handoff_at: options.handoff_at } : {}),
		...(hud ? { hud } : {}),
		...(options.receipt ? { receipt: options.receipt } : {}),
		...(options.active_subskills ? { active_subskills: options.active_subskills } : {}),
	};
}
