import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { GJC_SESSION_PREFIX, modeStatePath as sessionModeStatePath } from "../gjc-runtime/session-layout";
import { resolveGjcSessionForRead } from "../gjc-runtime/session-resolution";
import { ModeStateSchema } from "../gjc-runtime/state-schema";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { resolveToCwd } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";
import { listActiveSkills, readVisibleSkillActiveState, type SkillActiveEntry } from "./active-state";
import {
	type CanonicalGjcWorkflowSkill,
	sanctionedWorkflowStateCommand,
	workflowModeStateFileName,
} from "./workflow-state-contract";

export const DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE =
	"Deep-interview phase boundary: continue gathering context/questions/risks and emit a handoff/spec before code edits. Mutation tools and patch execution are blocked while deep-interview is active; finalize specs through `gjc deep-interview --write --stage final` or hand off to an execution phase.";
export const WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE =
	".gjc workflow state and artifacts are runtime-owned. Agent mutation tools cannot edit `.gjc/**`; use the sanctioned `gjc` CLI instead.";
export const RALPLAN_MUTATION_BLOCK_MESSAGE =
	"Ralplan planning phase boundary: keep refining the consensus plan and persist plan artifacts through `gjc ralplan --write` (stage scratch files under a temp dir if needed). Product-code mutation tools and patch execution are blocked while ralplan is active; mutate only after the plan is approved and execution begins.";
export const ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE =
	"Ultragoal goal-planning phase boundary: finish goal planning and record goals through `gjc ultragoal` before editing code. Product-code mutation tools and patch execution are blocked until goal planning completes and execution begins.";

/** Resolve the phase-boundary block message for the active planning skill. */
function planningPhaseBlockMessage(skill: CanonicalGjcWorkflowSkill): string {
	if (skill === "ralplan") return RALPLAN_MUTATION_BLOCK_MESSAGE;
	if (skill === "ultragoal") return ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE;
	return DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE;
}

const BLOCKED_TOOL_NAMES = new Set(["edit", "write", "ast_edit", "bash"]);
const ARCHIVE_OR_SQLITE_BASE_RE = /^(.+?\.(?:tar\.gz|sqlite3|sqlite|db3|zip|tgz|tar|db))(?:$|:)/i;
const INTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const VIM_FILE_SWITCH_RE = /^\s*:(?:e|e!|edit|edit!)(?:\s+([^<\r\n]+))?(?:<CR>|\r|\n|$)/i;
const BASH_TOKEN_RE = /'[^']*'|"(?:\\.|[^"\\])*"|\S+/g;
const BASH_REDIRECT_RE = /^(?:\d*)>>?$/;
const BASH_HEREDOC_RE = /^(?:\d*)<<-?$/;
// Shell command-list / redirection / substitution operators. Includes `\r` and
// `\n` because the shell treats a newline as a command separator and tool command
// strings can be multiline (e.g. heredocs).
const BASH_CONTROL_OPERATOR_RE = /[;&|<>`\r\n]|\$\(/;
// Best-effort, defense-in-depth bash mutation detection. The authoritative
// planning-phase guard is the dedicated `write`/`edit`/`ast_edit` tools (fully
// pathed); this catches the common shell mutators plus all redirect targets so a
// cooperative agent cannot trivially side-step those tools. It is deliberately
// NOT exhaustive: arbitrary interpreters (`python -c`, `node -e`) and the
// `key=value` operand forms of utilities like `dd of=` are not parsed, and path
// classification is lexical (no realpath), matching the rest of this guard and
// the broader `.gjc` path handling. Hardening any of these would require a real
// shell parser / symlink resolution and is out of scope for the planning rails.
const BASH_MUTATION_COMMANDS = new Set(["rm", "mv", "cp", "touch", "mkdir", "ln", "tee"]);

type ToolWithEditMode = AgentTool & {
	mode?: unknown;
	customWireName?: unknown;
};

export interface DeepInterviewMutationGuardInput {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	tool: ToolWithEditMode;
	args: unknown;
	forceOverride?: boolean;
	enforceWorkflowState?: boolean;
}

interface ExtractedTargets {
	paths: string[];
	unknown: boolean;
}

export interface DeepInterviewMutationDecision {
	blocked: boolean;
	message?: string;
	targets: string[];
	reason?: string;
	command?: string;
}

interface ModeState {
	active?: boolean;
	current_phase?: string;
	session_id?: string;
	thread_id?: string;
	[key: string]: unknown;
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function resolveBoundarySessionId(cwd: string, sessionId?: string): Promise<string | null> {
	const normalizedSessionId = sessionId?.trim();
	if (normalizedSessionId) return normalizedSessionId;
	try {
		return (await resolveGjcSessionForRead(cwd, { envSessionId: process.env.GJC_SESSION_ID })).gjcSessionId;
	} catch {
		return null;
	}
}

function modeStatePath(cwd: string, skill: string, sessionId: string): string {
	return sessionModeStatePath(cwd, sessionId, skill);
}

function warnInvalidModeState(filePath: string, error: string): void {
	logger.warn(`gjc skill-state: invalid mode-state at ${filePath}: ${error}`);
}

async function readValidatedModeState(filePath: string): Promise<ModeState | null> {
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch {
		return null;
	}
	let state: ModeState;
	try {
		state = JSON.parse(raw) as ModeState;
	} catch (error) {
		warnInvalidModeState(filePath, `invalid JSON: ${(error as Error).message}`);
		return null;
	}
	const parsed = ModeStateSchema.safeParse(state);
	if (!parsed.success) {
		warnInvalidModeState(filePath, parsed.error.message);
		return null;
	}
	return state;
}
async function readVisibleModeState(cwd: string, skill: string, sessionId: string): Promise<ModeState | null> {
	return await readValidatedModeState(modeStatePath(cwd, skill, sessionId));
}

/**
 * Phases that genuinely finish a workflow skill. Mirrors the Stop hook's
 * `STOP_RELEASING_PHASES` (`hooks/skill-state.ts`): `handoff` is intentionally
 * absent so a handoff-required planning skill (deep-interview/ralplan) keeps
 * blocking through its handoff/ask window until it is demoted or cleared.
 */
const WORKFLOW_FINISHED_PHASES = new Set(["complete", "completed", "failed", "cancelled", "canceled", "inactive"]);

function entryMatchesContext(entry: SkillActiveEntry, sessionId?: string, threadId?: string): boolean {
	if (sessionId && entry.session_id && entry.session_id !== sessionId) return false;
	if (threadId && entry.thread_id && entry.thread_id !== threadId) return false;
	return true;
}

function modeStateMatchesContext(state: ModeState, sessionId?: string, threadId?: string): boolean {
	if (sessionId && state.session_id && state.session_id !== sessionId) return false;
	if (threadId && state.thread_id && state.thread_id !== threadId) return false;
	return true;
}

/** Workflow skills that have a pre-approval planning posture this guard enforces. `team` never does. */
function isPlanningSkill(skill: string): skill is "deep-interview" | "ralplan" | "ultragoal" {
	return skill === "deep-interview" || skill === "ralplan" || skill === "ultragoal";
}

/**
 * Whether `skill` in `phase` is a pre-approval planning posture that must block
 * product-code mutation. `deep-interview` and `ralplan` are wholly pre-approval
 * (every phase blocks except a genuinely-finished one — `handoff` and ralplan's
 * `final` keep blocking until execution is approved and the skill is demoted).
 * `ultragoal` only blocks during `goal-planning`; once goals are created it is an
 * executor and mutates freely.
 */
function isBlockingPlanningPhase(skill: "deep-interview" | "ralplan" | "ultragoal", phase: string): boolean {
	const normalized = phase.trim().toLowerCase();
	if (skill === "ultragoal") return normalized === "goal-planning";
	return !WORKFLOW_FINISHED_PHASES.has(normalized);
}

interface ActivePlanningSkill {
	skill: "deep-interview" | "ralplan" | "ultragoal";
	phase: string;
}

/**
 * Pick the single CURRENT workflow entry among active entries.
 *
 * Steady state has exactly one active workflow skill (handoff demotes the prior
 * to `active:false`, which `listActiveSkills` already filters out). If several
 * are momentarily active, prefer the most-recently-updated entry so a stale
 * planning row (e.g. a still-active ralplan `final`) can never be selected over a
 * newer executor (ultragoal/team), and a planning *return* (newer `updated_at`)
 * reliably wins. Ties fall back to the resolved top-level `skill`, then to the
 * first entry, matching how the HUD/chain guard pick `activeSkills[0]`.
 */
function resolveCurrentWorkflowEntry(entries: SkillActiveEntry[], topLevelSkill: string): SkillActiveEntry {
	const ts = (entry: SkillActiveEntry): number => {
		const value = Date.parse(safeString(entry.updated_at) || safeString(entry.activated_at));
		return Number.isNaN(value) ? -1 : value;
	};
	let best = entries[0];
	for (const entry of entries) {
		const delta = ts(entry) - ts(best);
		if (delta > 0) best = entry;
		else if (delta === 0 && topLevelSkill && entry.skill === topLevelSkill) best = entry;
	}
	return best;
}

/**
 * Resolve the single active pre-approval planning skill for this context, or null.
 *
 * Transition/return safety: this keys off the ONE canonical current workflow
 * skill (the resolved top-level `skill` that the HUD and the skill-tool chain
 * guard treat as active), not an independent scan of every skill. A handoff
 * atomically demotes the prior skill and promotes the callee, and a return
 * (e.g. re-entering ralplan/deep-interview after an ultragoal goal completes)
 * re-activates the planning skill — in every case "whatever skill is current"
 * governs, so a stale planning entry can never block while an executor runs and
 * a resumed planning phase reliably re-blocks.
 *
 * Fail-open contract: a missing or invalid durable mode-state releases the block
 * (a corrupt state file must not lock all mutation), matching the guard's
 * historical behavior — this is intentionally looser than the Stop hook, which
 * fails closed for handoff-required skills.
 */
async function getActivePlanningSkill(
	cwd: string,
	sessionId?: string,
	threadId?: string,
): Promise<ActivePlanningSkill | null> {
	const resolvedSessionId = await resolveBoundarySessionId(cwd, sessionId);
	if (!resolvedSessionId) return { skill: "deep-interview", phase: "unresolved-session" };
	const skillState = await readVisibleSkillActiveState(cwd, resolvedSessionId);
	if (!skillState) return null;
	const activeEntries = listActiveSkills(skillState).filter(entry =>
		entryMatchesContext(entry, resolvedSessionId, threadId),
	);
	if (activeEntries.length === 0) return null;
	const current = resolveCurrentWorkflowEntry(activeEntries, safeString(skillState.skill).trim());
	if (!isPlanningSkill(current.skill)) return null;
	const modeState = await readVisibleModeState(cwd, current.skill, resolvedSessionId);
	if (!modeState) return null;
	if (modeState.active !== true) return null;
	if (!modeStateMatchesContext(modeState, resolvedSessionId, threadId)) return null;
	const phase = String(modeState.current_phase ?? current.phase ?? "").trim();
	if (!isBlockingPlanningPhase(current.skill, phase)) return null;
	return { skill: current.skill, phase };
}

function normalizePosix(value: string): string {
	return value.replace(/\\/g, "/");
}

function addPath(targets: ExtractedTargets, value: unknown): void {
	if (typeof value === "string" && value.trim().length > 0) {
		targets.paths.push(value.trim());
	}
}

function getRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractWriteTargets(args: unknown): ExtractedTargets {
	const record = getRecord(args);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	addPath(targets, record?.path);
	if (targets.paths.length === 0) targets.unknown = true;
	return targets;
}

function extractAstEditTargets(args: unknown): ExtractedTargets {
	const record = getRecord(args);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	const paths = record?.paths;
	if (Array.isArray(paths)) {
		for (const entry of paths) addPath(targets, entry);
	}
	if (targets.paths.length === 0) targets.unknown = true;
	return targets;
}

function extractVimSwitchTargets(steps: unknown, targets: ExtractedTargets): void {
	if (!Array.isArray(steps)) return;
	for (const step of steps) {
		const record = getRecord(step);
		const keys = record?.kbd;
		if (!Array.isArray(keys)) continue;
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const match = key.match(VIM_FILE_SWITCH_RE);
			if (!match) continue;
			const targetPath = match[1]?.trim();
			if (!targetPath) {
				targets.unknown = true;
				continue;
			}
			targets.paths.push(targetPath);
		}
	}
}

function extractApplyPatchTargets(args: unknown, targets: ExtractedTargets): boolean {
	const record = getRecord(args);
	const input = record?.input;
	if (typeof input !== "string") return false;
	try {
		for (const entry of expandApplyPatchToEntries({ input })) {
			addPath(targets, entry.path);
			addPath(targets, entry.rename);
		}
	} catch {
		targets.unknown = true;
	}
	return true;
}

function extractEditTargets(args: unknown, tool: ToolWithEditMode): ExtractedTargets {
	const record = getRecord(args);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	const customWireName = safeString(tool.customWireName);
	const mode = safeString(tool.mode);

	const isApplyPatchMode = customWireName === "apply_patch" || mode === "apply_patch";
	const hasApplyPatchInput = typeof record?.input === "string";
	if (isApplyPatchMode || hasApplyPatchInput) {
		extractApplyPatchTargets(args, targets);
		if (targets.paths.length === 0) targets.unknown = true;
		return targets;
	}

	addPath(targets, record?.path);
	addPath(targets, record?.file);
	const edits = record?.edits;
	if (Array.isArray(edits)) {
		for (const edit of edits) {
			const editRecord = getRecord(edit);
			addPath(targets, editRecord?.rename);
			addPath(targets, editRecord?.path);
		}
	}
	if (record?.file !== undefined || mode === "vim") {
		extractVimSwitchTargets(record?.steps, targets);
	}
	if (targets.paths.length === 0) targets.unknown = true;
	return targets;
}

function extractBashTargets(args: unknown): ExtractedTargets {
	const record = getRecord(args);
	const command = safeString(record?.command).trim();
	const targets: ExtractedTargets = { paths: [], unknown: false };
	if (!command) {
		targets.unknown = true;
		return targets;
	}
	// Fast path for a sanctioned `gjc …` invocation, but ONLY when it is a single
	// command with no shell control operators or redirects. Otherwise a compound
	// like `gjc … ; tee src/x` or `gjc … > .gjc/state/foo` would skip scanning and
	// bypass both the planning block and the always-on `.gjc/**` block, so fall
	// through to full token scanning (which leaves the `gjc` segment's own args
	// unextracted but still catches the trailing mutation/redirect).
	if (/^gjc(?:\s|$)/.test(command) && !BASH_CONTROL_OPERATOR_RE.test(command)) return targets;

	const tokens = command.match(BASH_TOKEN_RE)?.map(unquoteBashToken) ?? [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (BASH_REDIRECT_RE.test(token)) {
			addPath(targets, tokens[index + 1]);
			index++;
			continue;
		}
		const redirectMatch = token.match(/^(?:\d*)>>?(.+)$/);
		if (redirectMatch?.[1]) {
			addPath(targets, redirectMatch[1]);
			continue;
		}
		// A heredoc delimiter (`<<EOF`) is a here-document word, NOT a filesystem
		// target. Consume it without recording a target so a legitimate
		// `cat <<EOF > /tmp/scratch.md` is judged solely by its redirect target.
		if (BASH_HEREDOC_RE.test(token)) {
			index++;
			continue;
		}
		if (/^(?:\d*)<<-?.+$/.test(token)) {
			continue;
		}
		if (isMutationBashCommand(tokens, index)) {
			for (let targetIndex = index + 1; targetIndex < tokens.length; targetIndex++) {
				const target = tokens[targetIndex] ?? "";
				if (isBashCommandBoundary(target)) break;
				if (target.startsWith("-")) continue;
				addPath(targets, target);
			}
		}
	}
	return targets;
}

function unquoteBashToken(token: string): string {
	if (token.length < 2) return token;
	const quote = token[0];
	if ((quote === "'" || quote === '"') && token.at(-1) === quote) return token.slice(1, -1);
	return token;
}

function isBashCommandBoundary(token: string): boolean {
	return [";", "&&", "||", "|"].includes(token);
}

function isMutationBashCommand(tokens: string[], index: number): boolean {
	const token = path.basename(tokens[index] ?? "");
	if (BASH_MUTATION_COMMANDS.has(token)) return true;
	if (token !== "sed") return false;
	const next = tokens[index + 1] ?? "";
	return next === "-i" || next.startsWith("-i") || next.includes("i");
}

function extractTargets(tool: ToolWithEditMode, args: unknown): ExtractedTargets {
	if (tool.name === "write") return extractWriteTargets(args);
	if (tool.name === "ast_edit") return extractAstEditTargets(args);
	if (tool.name === "edit") return extractEditTargets(args, tool);
	if (tool.name === "bash") return extractBashTargets(args);
	return { paths: [], unknown: true };
}

function stripSelectorBase(rawPath: string): string {
	const archiveOrSqlite = rawPath.match(ARCHIVE_OR_SQLITE_BASE_RE);
	if (archiveOrSqlite?.[1]) return archiveOrSqlite[1];
	return rawPath;
}

function resolveRawPath(cwd: string, rawPath: string): { absolutePath?: string; unknown: boolean } {
	const normalized = rawPath.trim();
	if (!normalized) return { unknown: true };
	if (normalized === ".") return { absolutePath: path.resolve(cwd), unknown: false };
	if (normalized.startsWith("local://") || normalized.startsWith("local:/")) {
		const options = LocalProtocolHandler.resolveOptions();
		if (!options) return { unknown: true };
		try {
			return { absolutePath: resolveLocalUrlToPath(normalized, options), unknown: false };
		} catch {
			return { unknown: true };
		}
	}
	if (INTERNAL_SCHEME_RE.test(normalized)) return { unknown: true };

	const basePath = stripSelectorBase(normalized);
	try {
		return { absolutePath: resolveToCwd(basePath, cwd), unknown: false };
	} catch {
		return { unknown: true };
	}
}

function relativeGjcSegments(cwd: string, rawPath: string): string[] | null {
	const { absolutePath, unknown } = resolveRawPath(cwd, rawPath);
	if (unknown || !absolutePath) return null;
	const relative = path.relative(path.resolve(cwd), path.resolve(absolutePath));
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return normalizePosix(relative).split("/").filter(Boolean);
}

function blockedWorkflowStateSkill(cwd: string, rawPath: string): CanonicalGjcWorkflowSkill | null {
	const segments = relativeGjcSegments(cwd, rawPath);
	if (segments?.[0] !== ".gjc") return null;
	const generatedRoot = segments[1]?.startsWith(GJC_SESSION_PREFIX) ? segments[2] : segments[1];
	if (generatedRoot === "specs" || generatedRoot === "plans") return null;
	if (generatedRoot !== "state") return null;
	const fileName = segments.at(-1) ?? "";
	for (const skillName of ["deep-interview", "ralplan", "ultragoal", "team"] as const) {
		if (fileName === workflowModeStateFileName(skillName)) return skillName;
	}
	if (fileName === "skill-active-state.json") return "deep-interview";
	return null;
}

function firstBlockedWorkflowStateSkill(cwd: string, targets: ExtractedTargets): CanonicalGjcWorkflowSkill | null {
	for (const rawPath of targets.paths) {
		const skill = blockedWorkflowStateSkill(cwd, rawPath);
		if (skill) return skill;
	}
	return null;
}

function isAllowlistedPath(cwd: string, rawPath: string): boolean {
	const segments = relativeGjcSegments(cwd, rawPath);
	if (segments?.[0] !== ".gjc") return false;
	const generatedRoot = segments[1]?.startsWith(GJC_SESSION_PREFIX) ? segments[2] : segments[1];
	return generatedRoot === "specs" || generatedRoot === "plans";
}
function isBlockedGjcPath(cwd: string, rawPath: string): boolean {
	const segments = relativeGjcSegments(cwd, rawPath);
	return segments?.[0] === ".gjc";
}

function hasBlockedGjcTarget(cwd: string, targets: ExtractedTargets): boolean {
	return targets.paths.some(rawPath => isBlockedGjcPath(cwd, rawPath));
}

function allTargetsAllowlisted(cwd: string, targets: ExtractedTargets): boolean {
	return (
		!targets.unknown && targets.paths.length > 0 && targets.paths.every(rawPath => isAllowlistedPath(cwd, rawPath))
	);
}

function neutralTempRoots(): string[] {
	const roots = new Set<string>();
	const add = (value: string | undefined): void => {
		const trimmed = value?.trim();
		if (trimmed) roots.add(path.resolve(trimmed));
	};
	add(os.tmpdir());
	add(process.env.TMPDIR);
	for (const fixed of ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]) add(fixed);
	return [...roots];
}

function isPathWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrSelf(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return target;
	}
}

/**
 * Canonicalize a target whose leaf may not exist yet (we are about to write it):
 * realpath the nearest existing ancestor and re-append the not-yet-existing
 * suffix, so a symlinked ancestor (or macOS `/tmp` → `/private/tmp` alias) is
 * resolved to its real location.
 */
async function canonicalizeForContainment(absolutePath: string): Promise<string> {
	const suffix: string[] = [];
	let current = absolutePath;
	for (let depth = 0; depth < 64; depth++) {
		try {
			const real = await fs.realpath(current);
			return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) break;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
	return absolutePath;
}

/**
 * A neutral scratch path the planning-phase block tolerates: it resolves to a
 * system temp directory and lives OUTSIDE the project cwd. Files inside the
 * project tree (product code, `.gjc/**`) are never neutral, even when the cwd
 * itself is rooted under a temp dir. The lexical checks run first; a canonical
 * (symlink/alias-resolved) re-check then ensures the REAL target is still outside
 * the project and inside a real temp root, defeating a temp symlink that points
 * back into the repo or `.gjc/`.
 */
async function isNeutralTempPath(cwd: string, rawPath: string): Promise<boolean> {
	const { absolutePath, unknown } = resolveRawPath(cwd, rawPath);
	if (unknown || !absolutePath) return false;
	const resolvedCwd = path.resolve(cwd);
	if (isPathWithin(resolvedCwd, absolutePath)) return false;
	if (!neutralTempRoots().some(root => isPathWithin(root, absolutePath))) return false;
	const realTarget = await canonicalizeForContainment(absolutePath);
	if (isPathWithin(await realpathOrSelf(resolvedCwd), realTarget)) return false;
	const realRoots = await Promise.all(neutralTempRoots().map(realpathOrSelf));
	return realRoots.some(root => isPathWithin(root, realTarget));
}

/** Targets that remain disallowed during a planning phase (excludes neutral temp scratch). */
async function planningBlockedTargets(cwd: string, targets: ExtractedTargets): Promise<string[]> {
	const blocked: string[] = [];
	for (const rawPath of targets.paths) {
		if (!(await isNeutralTempPath(cwd, rawPath))) blocked.push(rawPath);
	}
	return blocked;
}
export async function assertDeepInterviewMutationRawPathsAllowed(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	rawPaths: string[];
	forceOverride?: boolean;
}): Promise<void> {
	const targets: ExtractedTargets = { paths: input.rawPaths, unknown: input.rawPaths.length === 0 };
	// Always-on `.gjc/**` runtime-owned block, in parity with getDeepInterviewMutationDecision
	// and ahead of forceOverride: a deferred ast_edit apply must not reach `.gjc/**` either.
	if (hasBlockedGjcTarget(input.cwd, targets)) {
		const stateSkill = firstBlockedWorkflowStateSkill(input.cwd, targets);
		const command = stateSkill ? sanctionedWorkflowStateCommand(stateSkill) : "gjc <workflow-command>";
		throw new ToolError(`${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}\nUse: ${command}`);
	}
	if (input.forceOverride) return;
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId);
	if (!planning) return;
	const message = planningPhaseBlockMessage(planning.skill);
	if (input.rawPaths.length === 0) throw new ToolError(message);
	const blocked = await planningBlockedTargets(input.cwd, targets);
	if (blocked.length > 0) throw new ToolError(message);
}

export async function getDeepInterviewMutationDecision(
	input: DeepInterviewMutationGuardInput,
): Promise<DeepInterviewMutationDecision> {
	if (!BLOCKED_TOOL_NAMES.has(input.tool.name)) return { blocked: false, targets: [] };
	const targets = extractTargets(input.tool, input.args);
	if (input.enforceWorkflowState !== false && hasBlockedGjcTarget(input.cwd, targets)) {
		const stateSkill = firstBlockedWorkflowStateSkill(input.cwd, targets);
		const command = stateSkill ? sanctionedWorkflowStateCommand(stateSkill) : "gjc <workflow-command>";
		return {
			blocked: true,
			message: `${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}\nUse: ${command}`,
			targets: targets.paths,
			reason: stateSkill ? "workflow-state-target" : "gjc-target",
			command,
		};
	}
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId);
	if (!planning) {
		return { blocked: false, targets: [] };
	}
	if (input.forceOverride) return { blocked: false, targets: [] };
	const message = planningPhaseBlockMessage(planning.skill);
	if (targets.unknown) {
		return {
			blocked: true,
			message,
			targets: targets.paths,
			reason: "unknown-target",
		};
	}
	// Neutral temp scratch (outside the project tree) stays writable so agents can
	// stage artifacts and feed their path to the sanctioned `gjc ... --write` CLIs.
	// Read-only / `gjc` bash extract no targets and fall through to allowed here.
	const blockedTargets = await planningBlockedTargets(input.cwd, targets);
	if (blockedTargets.length === 0) {
		return { blocked: false, targets: targets.paths };
	}
	return {
		blocked: true,
		message,
		targets: targets.paths,
		reason: allTargetsAllowlisted(input.cwd, targets) ? "handoff-artifact-tool-target" : "phase-boundary",
	};
}

export async function assertDeepInterviewMutationAllowed(input: DeepInterviewMutationGuardInput): Promise<void> {
	const decision = await getDeepInterviewMutationDecision(input);
	if (decision.blocked) throw new ToolError(decision.message ?? DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
}

/*
 * Generic cross-workflow names for this planning-phase mutation guard. The guard
 * now governs deep-interview, ralplan, and ultragoal goal-planning, so new
 * callers SHOULD use these names; the `*DeepInterview*` exports above remain as
 * compatibility aliases (and are still what the test-suite imports).
 */
export const getWorkflowMutationDecision = getDeepInterviewMutationDecision;
export const assertWorkflowMutationAllowed = assertDeepInterviewMutationAllowed;
export const assertWorkflowMutationRawPathsAllowed = assertDeepInterviewMutationRawPathsAllowed;
