import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
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
	"Workflow state JSON is runtime-owned. Use `gjc state <skill> read|write --input '<json>'` for deep-interview, ralplan, ultragoal, and team. Planning artifacts under `.gjc/specs/` and `.gjc/plans/` remain allowed.";

const BLOCKED_TOOL_NAMES = new Set(["edit", "write", "ast_edit"]);
const ARCHIVE_OR_SQLITE_BASE_RE = /^(.+?\.(?:tar\.gz|sqlite3|sqlite|db3|zip|tgz|tar|db))(?:$|:)/i;
const INTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const VIM_FILE_SWITCH_RE = /^\s*:(?:e|e!|edit|edit!)(?:\s+([^<\r\n]+))?(?:<CR>|\r|\n|$)/i;

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

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function modeStatePath(cwd: string, skill: string, sessionId?: string): string {
	const stateDir = path.join(cwd, ".gjc", "state");
	const fileName = `${skill}-state.json`;
	if (sessionId) return path.join(stateDir, "sessions", encodePathSegment(sessionId), fileName);
	return path.join(stateDir, fileName);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await Bun.file(filePath).text()) as T;
	} catch {
		return null;
	}
}
async function readVisibleModeState(cwd: string, skill: string, sessionId?: string): Promise<ModeState | null> {
	if (sessionId) {
		const sessionState = await readJsonFile<ModeState>(modeStatePath(cwd, skill, sessionId));
		if (sessionState) return sessionState;
	}
	return await readJsonFile<ModeState>(modeStatePath(cwd, skill));
}

function isTerminalModeState(state: ModeState | null): boolean {
	if (state?.active !== true) return true;
	const phase = String(state.current_phase ?? "")
		.trim()
		.toLowerCase();
	return ["complete", "completed", "failed", "cancelled", "canceled", "inactive"].includes(phase);
}

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

async function isActiveDeepInterview(cwd: string, sessionId?: string, threadId?: string): Promise<boolean> {
	const skillState = await readVisibleSkillActiveState(cwd, sessionId);
	const activeDeepInterview = listActiveSkills(skillState).find(
		entry => entry.skill === "deep-interview" && entryMatchesContext(entry, sessionId, threadId),
	);
	if (!activeDeepInterview) return false;

	const modeState = await readVisibleModeState(cwd, "deep-interview", sessionId);
	if (isTerminalModeState(modeState)) return false;
	if (modeState && !modeStateMatchesContext(modeState, sessionId, threadId)) return false;
	return true;
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

function extractTargets(tool: ToolWithEditMode, args: unknown): ExtractedTargets {
	if (tool.name === "write") return extractWriteTargets(args);
	if (tool.name === "ast_edit") return extractAstEditTargets(args);
	if (tool.name === "edit") return extractEditTargets(args, tool);
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
	if (segments[1] === "specs" || segments[1] === "plans") return null;
	if (segments[1] !== "state") return null;
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
	return segments[1] === "specs" || segments[1] === "plans";
}

function allTargetsAllowlisted(cwd: string, targets: ExtractedTargets): boolean {
	return (
		!targets.unknown && targets.paths.length > 0 && targets.paths.every(rawPath => isAllowlistedPath(cwd, rawPath))
	);
}
export async function assertDeepInterviewMutationRawPathsAllowed(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	rawPaths: string[];
	forceOverride?: boolean;
}): Promise<void> {
	if (input.forceOverride) return;
	if (!(await isActiveDeepInterview(input.cwd, input.sessionId, input.threadId))) return;
	const targets: ExtractedTargets = { paths: input.rawPaths, unknown: input.rawPaths.length === 0 };
	if (targets.unknown || targets.paths.length > 0) {
		throw new ToolError(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
	}
}

export async function getDeepInterviewMutationDecision(
	input: DeepInterviewMutationGuardInput,
): Promise<DeepInterviewMutationDecision> {
	if (!BLOCKED_TOOL_NAMES.has(input.tool.name)) return { blocked: false, targets: [] };
	const targets = extractTargets(input.tool, input.args);
	if (input.enforceWorkflowState !== false) {
		const stateSkill = firstBlockedWorkflowStateSkill(input.cwd, targets);
		if (stateSkill) {
			const command = sanctionedWorkflowStateCommand(stateSkill);
			return {
				blocked: true,
				message: `${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}\nUse: ${command}`,
				targets: targets.paths,
				reason: "workflow-state-target",
				command,
			};
		}
	}
	if (!(await isActiveDeepInterview(input.cwd, input.sessionId, input.threadId))) {
		return { blocked: false, targets: [] };
	}
	if (input.forceOverride) return { blocked: false, targets: [] };
	if (targets.unknown) {
		return {
			blocked: true,
			message: DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
			targets: targets.paths,
			reason: "unknown-target",
		};
	}
	return {
		blocked: true,
		message: DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
		targets: targets.paths,
		reason: allTargetsAllowlisted(input.cwd, targets) ? "handoff-artifact-tool-target" : "phase-boundary",
	};
}

export async function assertDeepInterviewMutationAllowed(input: DeepInterviewMutationGuardInput): Promise<void> {
	const decision = await getDeepInterviewMutationDecision(input);
	if (decision.blocked) throw new ToolError(decision.message ?? DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
}
