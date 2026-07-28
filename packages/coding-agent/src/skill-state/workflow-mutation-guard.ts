import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { GJC_SESSION_PREFIX, modeStatePath as sessionModeStatePath } from "../gjc-runtime/session-layout";
import { resolveGjcSessionForRead } from "../gjc-runtime/session-resolution";
import { ModeStateSchema } from "../gjc-runtime/state-schema";
import { getSkillManifest } from "../gjc-runtime/workflow-manifest";
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
/**
 * Only `/dev/null` is exempt. `/dev/stdout`, `/dev/stderr`, and `/dev/fd/<n>` are descriptor
 * aliases: `exec 1<>src/product.ts; printf x >/dev/stdout` reaches a real repository file
 * through a rebound descriptor, so they must stay blocked.
 */
const DEVICE_SINK_PATHS = new Set(["/dev/null"]);
/** Bash write forms the plain `>`/`>>` scanner misses: clobber, dup-to-path, and read-write open. */
const BASH_EXTENDED_WRITE_RE = /(?:>\||<>|>&(?![\s;&|]*(?:\d+|-)(?:[\s;&|]|$)))\s*([^\s;&|]+)/g;
/** Descriptor rebinding is not statically resolvable; any `exec` redirection forces a fail-closed verdict. */
const BASH_EXEC_REDIRECT_RE = /(?:^|[;&|\n])\s*(?:sudo\s+)?exec\b[^;&|\n]*[<>]/i;

const ARCHIVE_OR_SQLITE_BASE_RE = /^(.+?\.(?:tar\.gz|sqlite3|sqlite|db3|zip|tgz|tar|db))(?:$|:)/i;
const INTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const VIM_FILE_SWITCH_RE = /^\s*:(?:e|e!|edit|edit!)(?:\s+([^<\r\n]+))?(?:<CR>|\r|\n|$)/i;
const BASH_MUTATION_COMMAND_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?(?:tee|touch|rm|mkdir|cp|mv|install|truncate)\b([^;&|\n]*)|(?:^|[^<>])(?:>>?|\d>>?)\s*([^\s;&|]+)/gi;
const BASH_IN_PLACE_MUTATION_COMMAND_RE = /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:sed|perl)\b([^;&|\n]*)/gi;
const BASH_OPAQUE_INTERPRETER_WRITE_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:-c|-e)\b[^;&|\n]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;
const BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:<<[-]?\s*['"]?\w+['"]?)[\s\S]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;
const BASH_DD_OUTPUT_RE = /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?dd\b([^;&|\n]*)/gi;
/** `sort -o <file>` / `sort --output=<file>` writes the named file without any shell redirection. */
const BASH_SORT_OUTPUT_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?['"]?sort['"]?\b([^;&|\n]*)/gi;

/**
 * Read-only helpers that may appear alongside `gjc` in a whitelisted pipeline.
 * Deliberately tiny: every entry must be incapable of writing files even via
 * its own options (`sort -o`/`tee` style output flags disqualify a command
 * from this list), and redirections disqualify the whitelist entirely.
 */
const GJC_PIPELINE_READ_ONLY_COMMANDS = new Set([
	"gjc",
	"cat",
	"echo",
	"jq",
	"grep",
	"head",
	"tail",
	"wc",
	"cut",
	"tr",
	"true",
]);
/**
 * Env assignment prefix tolerated before a whitelisted command: only names the
 * sanctioned workflows genuinely need, with plain values. PATH, loader
 * variables (LD_/DYLD_ prefixes), and arbitrary names are rejected so the prefix
 * cannot redirect which executable a bare `gjc` resolves to.
 */
const SIMPLE_ENV_ASSIGNMENT_RE =
	/^(?:GJC_SESSION_ID|GJC_STATE_SESSION_ID|LC_ALL|LANG|TZ|NO_COLOR)=[A-Za-z0-9_@%^+,./:-]*$/;
/** Any mention of a bare `gjc` word; such commands must be provably pure or fail closed. */
const MENTIONS_GJC_RE = /(?:^|[\s;&|("'`])gjc(?:[\s;&|)"'`]|$)/;
const HEREDOC_OPERATOR_RE = /<<-?\s*(['"])(\w+)\1/;

type ToolWithEditMode = AgentTool & {
	mode?: unknown;
	customWireName?: unknown;
};

export interface WorkflowMutationGuardInput {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	tool: ToolWithEditMode;
	args: unknown;
	forceOverride?: boolean;
	enforceWorkflowState?: boolean;
	guardContext?: WorkflowGuardContext;
}

interface ExtractedTargets {
	paths: string[];
	unknown: boolean;
}

export interface WorkflowMutationDecision {
	blocked: boolean;
	message?: string;
	targets: string[];
	reason?: string;
	command?: string;
}

export interface WorkflowGuardContext {
	sessionId: string | null;
	activeState: Awaited<ReturnType<typeof readVisibleSkillActiveState>>;
	modeStates: ReadonlyMap<string, ModeState | null>;
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

export async function readWorkflowGuardContext(
	cwd: string,
	options: { sessionId?: string; threadId?: string } = {},
): Promise<WorkflowGuardContext> {
	const sessionId = await resolveBoundarySessionId(cwd, options.sessionId);
	if (!sessionId) return { sessionId: null, activeState: null, modeStates: new Map() };
	const activeState = await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" });
	const skills = activeState ? [...new Set(listActiveSkills(activeState).map(entry => entry.skill))] : [];
	const modeStates = new Map(
		await Promise.all(
			skills.map(
				async skill => [skill, await readValidatedModeState(modeStatePath(cwd, skill, sessionId))] as const,
			),
		),
	);
	return { sessionId, activeState, modeStates };
}

/**
 * Phases that genuinely finish a workflow skill. Mirrors the Stop hook's
 * `STOP_RELEASING_PHASES` (`hooks/skill-state.ts`): `handoff` is intentionally
 * absent so a handoff-required planning skill (deep-interview/ralplan) keeps
 * blocking through its handoff/ask window until it is demoted or cleared.
 */

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
	return !getSkillManifest(skill).stopReleasingPhases.includes(normalized);
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
	context?: WorkflowGuardContext,
): Promise<ActivePlanningSkill | null> {
	const guardContext = context ?? (await readWorkflowGuardContext(cwd, { sessionId, threadId }));
	const resolvedSessionId = guardContext.sessionId;
	if (!resolvedSessionId) return null;
	const skillState = guardContext.activeState;

	if (!skillState) return null;
	const activeEntries = listActiveSkills(skillState).filter(entry =>
		entryMatchesContext(entry, resolvedSessionId, threadId),
	);
	if (activeEntries.length === 0) return null;
	const current = resolveCurrentWorkflowEntry(activeEntries, safeString(skillState.skill).trim());
	if (!isPlanningSkill(current.skill)) return null;
	const modeState = guardContext.modeStates.get(current.skill) ?? null;

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
function shellWords(argsText: string): string[] {
	return argsText.match(/(?:[^\s'"\\]+|'[^']*'|"[^"]*")+/g) ?? [];
}

function cleanShellWord(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function isDeviceSinkPath(value: string): boolean {
	return DEVICE_SINK_PATHS.has(cleanShellWord(value));
}

/**
 * Remove quoted-delimiter heredoc bodies (pure stdin data) from a command so the
 * remaining text contains only real shell syntax. Returns null when the command
 * is not safely analyzable: an unquoted heredoc delimiter (its body undergoes
 * command/parameter expansion) or a missing terminator both disqualify it.
 */
function stripQuotedHeredocBodies(command: string): string | null {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const withoutQuoted = line.replace(HEREDOC_OPERATOR_RE, " ");
		// Any remaining heredoc operator has an unquoted delimiter (its body expands) — not analyzable.
		if (withoutQuoted.includes("<<")) return null;
		const heredoc = line.match(HEREDOC_OPERATOR_RE);
		kept.push(withoutQuoted);
		if (!heredoc) continue;
		const delimiter = heredoc[2];
		const dashed = heredoc[0].startsWith("<<-");
		let terminated = false;
		for (i++; i < lines.length; i++) {
			const candidate = dashed ? lines[i].replace(/^\t+/, "") : lines[i];
			if (candidate === delimiter) {
				terminated = true;
				break;
			}
		}
		if (!terminated) return null;
	}
	return kept.join("\n");
}

/**
 * Whether every pipeline/list segment of `command` is a `gjc` invocation or a
 * known read-only helper, with no redirections, command substitution, process
 * substitution, backticks, or unquoted heredocs. Such commands cannot write
 * repository files, so the guard admits them before the opaque-interpreter
 * heuristics would otherwise flag `gjc`-driven shell functions/heredocs as
 * unknown-target — the CLI the workflow itself instructs the agent to run.
 */
function isPureGjcReadOnlyBashCommand(command: string): boolean {
	if (!MENTIONS_GJC_RE.test(command)) return false;
	// A carriage return can hide a following command from the line-oriented scan.
	if (command.includes("\r")) return false;
	// Backslash line continuations change Bash's logical-line structure (e.g. a
	// continued quoted-heredoc delimiter can hide a trailing command from a
	// physical-line scanner), so any backslash disqualifies the fast path.
	if (command.includes("\\")) return false;
	const stripped = stripQuotedHeredocBodies(command);
	if (stripped === null) return false;
	if (/[`<>()]|\$\(|\$\{/.test(stripped)) return false;
	const segments = stripped
		.split(/\|\||&&|[|;&\n]/)
		.map(segment => segment.trim())
		.filter(segment => segment.length > 0);
	if (segments.length === 0) return false;
	for (const segment of segments) {
		const words = shellWords(segment);
		let index = 0;
		while (index < words.length && SIMPLE_ENV_ASSIGNMENT_RE.test(words[index] ?? "")) index++;
		const executable = words[index];
		// The executable word must be an unquoted bare allowlisted name; quoting
		// tricks (`"sort"`) or paths never qualify.
		if (!executable || !/^[a-z]+$/.test(executable) || !GJC_PIPELINE_READ_ONLY_COMMANDS.has(executable)) return false;
	}
	return true;
}

function extractBashTargets(args: unknown): ExtractedTargets {
	const record = getRecord(args);
	const command = safeString(record?.command);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	if (!command.trim()) {
		targets.unknown = true;
		return targets;
	}
	// Pure `gjc`/read-only pipelines are admitted before the opaque heuristics so the
	// workflow-sanctioned CLI is never blocked as unknown-target (#guard-vs-cli conflict).
	if (isPureGjcReadOnlyBashCommand(command)) {
		return targets;
	}
	// Fail closed for anything that *mentions* `gjc` but is not a verified pure
	// allowlisted pipeline. Without this, a command the whitelist rejected (a bad
	// env prefix, a quoted/expanded executable, a hidden continuation) would fall
	// through to the legacy heuristics, which report no target for an unrecognized
	// writer and would therefore read as "safe".
	if (MENTIONS_GJC_RE.test(command)) {
		targets.unknown = true;
		return targets;
	}
	if (BASH_OPAQUE_INTERPRETER_WRITE_RE.test(command) || BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE.test(command)) {
		targets.unknown = true;
	}
	// `exec 1<>file` rebinds a descriptor, so a later `>/dev/null` may not reach the device at all.
	if (BASH_EXEC_REDIRECT_RE.test(command)) {
		targets.unknown = true;
	}
	for (const match of command.matchAll(BASH_EXTENDED_WRITE_RE)) {
		const cleaned = cleanShellWord(match[1] ?? "");
		if (!cleaned) targets.unknown = true;
		else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
	}
	for (const match of command.matchAll(BASH_SORT_OUTPUT_RE)) {
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			if (part === "-o" || part === "--output") {
				const output = parts[index + 1];
				if (!output) targets.unknown = true;
				else if (!isDeviceSinkPath(output)) addPath(targets, output);
			} else if (part.startsWith("--output=")) {
				const output = part.slice("--output=".length);
				if (!output) targets.unknown = true;
				else if (!isDeviceSinkPath(output)) addPath(targets, output);
			} else if (/^-[A-Za-z]*o$/.test(part)) {
				// combined short options ending in -o, e.g. `-uo file`
				const output = parts[index + 1];
				if (!output) targets.unknown = true;
				else if (!isDeviceSinkPath(output)) addPath(targets, output);
			} else if (/^-[A-Za-z]*o.+$/.test(part)) {
				// attached short-option argument, e.g. `-osrc/product.ts` or `-uosrc/product.ts`
				const output = part.slice(part.indexOf("o", 1) + 1);
				if (!output) targets.unknown = true;
				else if (!isDeviceSinkPath(output)) addPath(targets, output);
			}
		}
	}
	for (const match of command.matchAll(BASH_DD_OUTPUT_RE)) {
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		// Every `of=` counts: GNU dd honors the last one, so `of=/dev/null of=real.ts` writes real.ts.
		const outputs = parts.filter(part => part.startsWith("of="));
		if (outputs.length === 0) targets.unknown = true;
		for (const output of outputs) {
			const outputPath = cleanShellWord(output.slice(3));
			if (!outputPath) targets.unknown = true;
			else if (!isDeviceSinkPath(outputPath)) addPath(targets, outputPath);
		}
	}
	for (const match of command.matchAll(BASH_IN_PLACE_MUTATION_COMMAND_RE)) {
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		const hasInPlaceFlag = parts.some(part => /^-.*i/.test(part));
		if (!hasInPlaceFlag) continue;
		const target = [...parts].reverse().find(part => part && !part.startsWith("-"));
		if (target) addPath(targets, target);
		else targets.unknown = true;
	}
	for (const match of command.matchAll(BASH_MUTATION_COMMAND_RE)) {
		const redirected = match[2]?.trim();
		if (redirected) {
			const cleaned = cleanShellWord(redirected);
			// A capture that dequotes to nothing (e.g. `>" src.ts"`) is a truncated parse, not a safe no-op.
			if (!cleaned) targets.unknown = true;
			else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
			continue;
		}
		const parts = shellWords(match[1] ?? "");
		const commandName = match[0]
			?.match(
				/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?(tee|touch|rm|mkdir|cp|mv|install|truncate)\b/i,
			)?.[1]
			?.toLowerCase();
		const targetParts =
			commandName === "cp" || commandName === "mv" || commandName === "install" || commandName === "truncate"
				? parts.slice(-1)
				: parts;
		for (const part of targetParts) {
			const cleaned = cleanShellWord(part);
			if (!cleaned || cleaned.startsWith("-")) continue;
			addPath(targets, cleaned);
		}
	}
	return targets;
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
		if (isAllowlistedPath(cwd, rawPath)) continue;
		if (!(await isNeutralTempPath(cwd, rawPath))) blocked.push(rawPath);
	}
	return blocked;
}
export async function assertWorkflowMutationRawPathsAllowed(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	rawPaths: string[];
	forceOverride?: boolean;
	guardContext?: WorkflowGuardContext;
}): Promise<void> {
	const targets: ExtractedTargets = { paths: input.rawPaths, unknown: input.rawPaths.length === 0 };
	// Always-on `.gjc/**` runtime-owned block, ahead of forceOverride.
	// A deferred ast_edit apply must not reach `.gjc/**` either.
	if (hasBlockedGjcTarget(input.cwd, targets)) {
		const stateSkill = firstBlockedWorkflowStateSkill(input.cwd, targets);
		const command = stateSkill ? sanctionedWorkflowStateCommand(stateSkill) : "gjc <workflow-command>";
		throw new ToolError(`${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}\nUse: ${command}`);
	}
	if (input.forceOverride) return;
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId, input.guardContext);

	if (!planning) return;
	const message = planningPhaseBlockMessage(planning.skill);
	if (input.rawPaths.length === 0) throw new ToolError(message);
	const blocked = await planningBlockedTargets(input.cwd, targets);
	if (blocked.length > 0) throw new ToolError(message);
}

export async function getWorkflowMutationDecision(
	input: WorkflowMutationGuardInput,
): Promise<WorkflowMutationDecision> {
	if (!BLOCKED_TOOL_NAMES.has(input.tool.name)) return { blocked: false, targets: [] };
	const targets = extractTargets(input.tool, input.args);
	if (input.tool.name !== "bash" && input.enforceWorkflowState !== false && hasBlockedGjcTarget(input.cwd, targets)) {
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
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId, input.guardContext);
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

export async function assertWorkflowMutationAllowed(input: WorkflowMutationGuardInput): Promise<void> {
	const decision = await getWorkflowMutationDecision(input);
	if (decision.blocked) throw new ToolError(decision.message ?? DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
}
