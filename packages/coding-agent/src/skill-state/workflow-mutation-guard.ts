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
/** Literal `sh|bash|zsh -c '<script>'` payloads whose nested script must also be scanned. */
const BASH_NESTED_SHELL_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?(?:ba|z|da)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(?:(')([^']*)'|(")([^"]*)")/g;
/** Heredoc opener (`<<`/`<<-` plus an optionally quoted delimiter); `<<<` here-strings excluded. */
const BASH_HEREDOC_OPEN_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\s]+)'|"([^"\s]+)"|(\\)?([A-Za-z_][\w.-]*))/g;
/** Consumers whose stdin is inert data: their heredoc bodies are safe to mask. Anything else stays live. */
const HEREDOC_DATA_CONSUMERS = new Set([
	"cat",
	"tee",
	"head",
	"tail",
	"wc",
	"sort",
	"uniq",
	"tr",
	"cut",
	"grep",
	"column",
	"nl",
	"fold",
	"fmt",
	"base64",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"sha512sum",
	"shasum",
	"jq",
	"yq",
]);
/** Stdin appliers whose heredoc body mutates files in ways no body scan can model. */
const HEREDOC_MUTATING_CONSUMERS = new Set(["patch", "ed", "ex", "sqlite3"]);

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
	/**
	 * Set when a bash command was recognized as performing a filesystem write.
	 * During a planning phase an unrecognized bash command is allowed (reading
	 * and inspection must not be blocked); only a recognized mutation blocks.
	 */
	explicitMutation?: boolean;
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

/**
 * Blank out single-quoted spans so shell metacharacters inside a literal
 * argument value (e.g. `--value 'uses `x`; a > b'`) are not misread as
 * redirections or separators. Single quotes suppress every expansion in POSIX
 * shells, so their contents are always inert data. Double-quoted spans are left
 * intact because they still expand `$(...)` and backticks.
 */
function maskSingleQuotedSpans(command: string): string {
	let masked = "";
	let inSingle = false;
	for (const character of command) {
		if (character === "'") {
			inSingle = !inSingle;
			masked += character;
			continue;
		}
		masked += inSingle && character !== "\n" ? " " : character;
	}
	// An unbalanced quote means the parse is unreliable; keep the original text
	// so the scanner stays fail-closed rather than blind.
	return inSingle ? command : masked;
}

function isDeviceSinkPath(value: string): boolean {
	return DEVICE_SINK_PATHS.has(cleanShellWord(value));
}

interface HeredocMaskResult {
	masked: string;
	/** An unquoted-delimiter heredoc body carried `$(…)`/backtick expansion — live code the scanner cannot model. */
	opaqueExpansion: boolean;
	/** The heredoc feeds a stdin applier (patch/ed/ex/sqlite3) whose body mutates files no scan can attribute. */
	mutatingConsumer: boolean;
}

/** Quote/substitution state carried ACROSS physical lines so multiline constructs cannot fake heredoc openers. */
interface ShellQuoteState {
	inSingle: boolean;
	inDouble: boolean;
	/** The open single quote is ANSI-C (`$'…'`): backslash escapes inside it decode at runtime. */
	inAnsiC: boolean;
	/**
	 * Paren stack inside substitutions: `true` for a `$(`/`<(`/`>(` opener
	 * (its `)` is a word character), `false` for a plain nested paren (its `)`
	 * is an operator, so a following `#` starts a comment).
	 */
	parenStack: boolean[];
}

/**
 * Mask one physical line for syntax analysis, carrying `state` across lines:
 * quoted spans and backslash-escaped characters become spaces (they are data,
 * never syntax), so a `<<` inside `"…"`/`'…'` — even when the quote opened on a
 * PREVIOUS line — or an escaped separator like `\|` is never misread. An
 * unquoted `#` at a word boundary starts a comment: the rest of the line is
 * blanked without touching quote state, so a stray quote inside a comment
 * cannot poison later lines. A `)` closing a `$(`/`<(`/`>(` substitution is
 * part of the current word (`x=$(true)#literal`), not a comment boundary.
 * `masked` is the same length as the input so match offsets stay aligned.
 * `dequoted` applies bash-like QUOTE REMOVAL instead — quote/backslash marks
 * drop, quoted word characters stay, quoted metacharacters neutralize to `_` —
 * so obfuscated spellings (`e\val`, `'ev'al`) reassemble into their real
 * command word without quoted data ever forming fake command boundaries. A
 * leading `$` immediately before `'…'` (ANSI-C) or `"…"` (locale-translated)
 * is stripped during quote removal too, so `$'eval'`/`$"eval"` dequote to
 * plain `eval`, matching real bash quote-removal semantics for both forms.
 * `continued` reports an unescaped trailing backslash outside quotes (logical
 * line continuation).
 */
function maskLineForSyntax(
	line: string,
	state: ShellQuoteState,
): { masked: string; dequoted: string; continued: boolean; ansiCEscape: boolean } {
	let masked = "";
	let dequoted = "";
	let escaped = false;
	let previous = "";
	let ansiCEscape = false;
	// Quoted data keeps word characters (so `'ev'al` reassembles to `eval`) but
	// neutralizes everything else to `_` so it can never form a command boundary.
	const dequoteData = (character: string): string => (/[\w./-]/.test(character) ? character : "_");
	for (const character of line) {
		if (state.inSingle) {
			if (character === "'") {
				state.inSingle = false;
				state.inAnsiC = false;
			} else {
				// ANSI-C escapes (`$'\145val'`) decode at runtime into characters the
				// dequoted view cannot reproduce — flag them so the caller fails closed.
				if (state.inAnsiC && character === "\\") ansiCEscape = true;
				masked += " ";
				dequoted += dequoteData(character);
				previous = character;
				continue;
			}
			masked += "'";
			previous = character;
			continue;
		}
		if (escaped) {
			escaped = false;
			masked += " ";
			dequoted += dequoteData(character);
			previous = character;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			masked += " ";
			previous = character;
			continue;
		}
		if (state.inDouble) {
			if (character === '"') state.inDouble = false;
			else {
				masked += " ";
				dequoted += dequoteData(character);
				previous = character;
				continue;
			}
			masked += '"';
			previous = character;
			continue;
		}
		if (
			character === "(" &&
			(previous === "$" || previous === "<" || previous === ">" || state.parenStack.length > 0)
		) {
			// Substitution opener, or any paren nested INSIDE one (e.g. `$((1))`,
			// `$(f (x))`): both must be balanced before the substitution closes.
			state.parenStack.push(previous === "$" || previous === "<" || previous === ">");
			masked += character;
			dequoted += character;
			previous = character;
			continue;
		}
		if (character === ")" && state.parenStack.length > 0) {
			const wasSubstitutionOpener = state.parenStack.pop() === true;
			masked += character;
			dequoted += character;
			// A substitution close binds to the surrounding word (`x=$(true)#lit`);
			// a nested subshell close is an operator, so `#` after it comments.
			previous = wasSubstitutionOpener ? "x" : ")";
			continue;
		}
		if (
			character === "#" &&
			(previous === "" || previous === " " || previous === "\t" || ";|&()".includes(previous))
		) {
			// Comment: blank the remainder without evaluating quotes inside it.
			masked += " ".repeat(line.length - masked.length);
			return { masked, dequoted, continued: false, ansiCEscape };
		}
		if (character === "'") {
			state.inSingle = true;
			masked += "'";
			// ANSI-C quoting `$'…'`: bash strips the `$` during quote removal, and
			// escapes inside decode at runtime.
			if (dequoted.endsWith("$")) {
				dequoted = dequoted.slice(0, -1);
				state.inAnsiC = true;
			}
			previous = character;
			continue;
		}
		if (character === '"') {
			state.inDouble = true;
			masked += '"';
			// `$"…"` locale-translated strings undergo the same quote removal as
			// ANSI-C `$'…'`: bash drops the `$`, so `$"eval"` dequotes to `eval`.
			if (dequoted.endsWith("$")) dequoted = dequoted.slice(0, -1);
			previous = character;
			continue;
		}
		masked += character;
		dequoted += character;
		previous = character;
	}
	return { masked, dequoted, continued: escaped, ansiCEscape };
}

const DATA_CONSUMER_NAMES = new Set(HEREDOC_DATA_CONSUMERS);
/**
 * Command-position words that force the fail-closed pass. `eval`/`source`/`.`
 * can install a shadow from data the syntax view has blanked (quoted strings,
 * /dev/stdin). `case` introduces pattern `)` terminators that desync the
 * substitution-depth scanner (`$(case x in x) …;; esac)`), making comment
 * detection unreliable — masking is disabled rather than guessing.
 */
const SHELL_EVALUATED_COMMANDS = new Set(["eval", "source", ".", "case"]);

/** Wrappers whose next word is still the effective command (`builtin eval …`, `command cat …`). */
const SHELL_COMMAND_WRAPPER_WORDS = new Set(["sudo", "builtin", "command", "exec", "nohup", "nice"]);

/** Reserved words that introduce a nested command position (`if eval …`, `while eval …`). */
const SHELL_RESERVED_PREFIX_WORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"while",
	"until",
	"do",
	"time",
	"coproc",
	"{",
	"!",
]);

/** A redirection token (`</dev/null`, `2>err`, `>out`) — not a command word. */
const SHELL_REDIRECTION_TOKEN_RE = /^\d*[<>]/;

/** Command-position words of one command-list segment: the first real word plus words after reserved prefixes. */
function commandPositionWords(segment: string): string[] {
	const words: string[] = [];
	let expectCommand = true;
	let afterWrapper = false;
	let afterBareRedirection = false;
	for (const word of segment.trim().split(/\s+/)) {
		if (!word) continue;
		// A bare redirection operator (`<`, `2>`) consumes the NEXT word as its target.
		if (afterBareRedirection) {
			afterBareRedirection = false;
			continue;
		}
		if (expectCommand) {
			if (/^\w+=/.test(word)) continue;
			// Leading redirections precede the command word (`</dev/null eval …`).
			// A bare operator (`<`, `2>`) additionally consumes its separated target.
			if (SHELL_REDIRECTION_TOKEN_RE.test(word)) {
				if (/^\d*[<>]+$/.test(word)) afterBareRedirection = true;
				continue;
			}
			if (SHELL_COMMAND_WRAPPER_WORDS.has(word.toLowerCase())) {
				// The wrapper's effective command follows, possibly after options/`--`.
				afterWrapper = true;
				continue;
			}
			if (afterWrapper && (word === "--" || word.startsWith("-"))) {
				// `command -v`/`-V` only DESCRIBES its operand — the rest is data.
				if (/^-[a-zA-Z]*[vV]/.test(word)) return words;
				// Other wrapper options (`command -p`, `builtin --`) precede the real command.
				continue;
			}
			afterWrapper = false;
			if (SHELL_RESERVED_PREFIX_WORDS.has(word.toLowerCase())) {
				// Reserved word keeps the NEXT word in command position.
				continue;
			}
			words.push(word.split("/").pop()?.toLowerCase() ?? "");
			expectCommand = false;
		}
		// Argument position: only real list operators (handled by the segment
		// split) restore command position — reserved-word TEXT here is data.
	}
	return words;
}

/** Command-list segments of a dequoted view (split at `;`, `|`, `&`, `(`, backtick, newline). */
function commandListSegments(dequotedView: string): string[] {
	return dequotedView.split(/[;|&(`\n]/);
}

/**
 * True when any command-position word of the dequoted syntax view is
 * eval/source/`.` — including nested positions after reserved words
 * (`if eval …`). `echo eval` and `find .` never match because their
 * tokens sit in argument position.
 */
function hasShellEvaluatedCommand(dequotedView: string): boolean {
	return commandListSegments(dequotedView).some(segment =>
		commandPositionWords(segment).some(word => SHELL_EVALUATED_COMMANDS.has(word)),
	);
}

/**
 * True when live syntax actually DECLARES a shadow of an allowlisted
 * data-consumer name: `name()` at a command-list start, `function name`,
 * or `alias name=…` — each in command position, so `echo function cat`
 * (argument position) never matches.
 */
function hasDataConsumerShadow(dequotedView: string): boolean {
	for (const segment of commandListSegments(dequotedView)) {
		const words = commandPositionWords(segment);
		for (let index = 0; index < words.length; index++) {
			const word = words[index] ?? "";
			if (word === "function") {
				// commandPositionWords stops after the first non-reserved word, so
				// re-inspect the raw segment for the name following `function`.
				const rawWords = segment.trim().split(/\s+/).filter(Boolean);
				const at = rawWords.findIndex(raw => raw.toLowerCase() === "function");
				const name = rawWords[at + 1]?.split("/").pop()?.toLowerCase() ?? "";
				if (DATA_CONSUMER_NAMES.has(name)) return true;
			}
			if (word === "alias") {
				const rawWords = segment.trim().split(/\s+/).filter(Boolean);
				if (rawWords.some(raw => DATA_CONSUMER_NAMES.has(raw.split("=")[0]?.toLowerCase() ?? ""))) return true;
			}
		}
	}
	// `name()` / `name ()` in command position — allow reserved-word prefixes
	// (`then cat() { … }`) before the name (POSIX function definition).
	const nameGroup = [...DATA_CONSUMER_NAMES].join("|");
	const reservedGroup = [...SHELL_RESERVED_PREFIX_WORDS].filter(word => /^\w+$/.test(word)).join("|");
	return new RegExp(
		`(?:^|[;|&{(\`\\n])\\s*(?:(?:${reservedGroup}|\\{|!)\\s+)*(?:${nameGroup})\\s*\\(\\s*\\)`,
		"i",
	).test(dequotedView);
}

/** First command word of a pipeline-segment slice of a quote-masked opener line. */
function firstCommandWord(segment: string): string {
	return commandPositionWords(segment)[0] ?? "";
}

/**
 * Classify the command consuming the heredoc at offset `at` of the comment-cut,
 * quote-masked opener line — including every DOWNSTREAM pipe stage, because
 * `cat <<'EOF' | bash` hands the body to the interpreter even though `cat` is
 * inert. Only a pipeline whose every stage is an explicitly inert data consumer
 * qualifies for body masking; any stdin applier stage fails closed; anything
 * else (interpreters, awk, unknown binaries) keeps the body live.
 */
function heredocConsumerKind(syntaxLine: string, at: number): "data" | "mutating" | "other" {
	let start = 0;
	for (let index = at - 1; index >= 0; index--) {
		const character = syntaxLine[index] ?? "";
		if (";|&(`".includes(character) || character === "\n") {
			start = index + 1;
			break;
		}
	}
	// The heredoc's own simple command plus every downstream `|` stage until the
	// command list ends (`;`, `&&`, `||`, `&`, backtick, or subshell close).
	const segments: string[] = [syntaxLine.slice(start, at)];
	let cursor = at;
	while (cursor < syntaxLine.length) {
		const character = syntaxLine[cursor] ?? "";
		if (character === ";" || character === "&" || character === "`" || character === ")") break;
		if (character === "|") {
			if (syntaxLine[cursor + 1] === "|") break;
			let stageEnd = cursor + 1;
			while (stageEnd < syntaxLine.length && !";|&`)".includes(syntaxLine[stageEnd] ?? "")) stageEnd++;
			segments.push(syntaxLine.slice(cursor + 1, stageEnd));
			cursor = stageEnd;
			continue;
		}
		cursor++;
	}
	let kind: "data" | "mutating" | "other" = "data";
	for (const segment of segments) {
		const base = firstCommandWord(segment);
		if (HEREDOC_MUTATING_CONSUMERS.has(base)) return "mutating";
		if (!HEREDOC_DATA_CONSUMERS.has(base)) kind = "other";
	}
	return kind;
}

/**
 * Blank out heredoc BODY lines so document payloads (markdown specs, plans,
 * fixtures) piped to an explicitly inert data consumer (`cat <<'EOF' >
 * /tmp/spec.md`) are not misread as shell commands: body text like `a > b` or
 * stray apostrophes must not register redirection targets or unbalance the
 * quote masker. Bodies stay UNMASKED (scanned as today) for every other
 * consumer — interpreters, awk, unknown binaries — because there the body may
 * be live code. Stdin appliers (patch/ed/ex/sqlite3) flag `mutatingConsumer`
 * and the caller fails closed. Unquoted-delimiter bodies still expand
 * `$(…)`/backticks in real shells, so masked ones flag `opaqueExpansion`. A
 * `<<` inside a comment or a quoted span (including a quote opened on a
 * previous line) is not an opener; a line-continued opener, a shadowed
 * data-consumer name (`cat() { … }`), and an unterminated heredoc all keep
 * their bodies live so the scanner stays fail-closed rather than blind.
 */
function maskHeredocBodies(command: string): HeredocMaskResult {
	if (!command.includes("<<")) return { masked: command, opaqueExpansion: false, mutatingConsumer: false };
	const first = maskHeredocBodiesPass(command, false);
	// Fail closed on live-syntax constructs that can install a shadow the syntax
	// view cannot see: a function/alias definition of an allowlisted consumer
	// name, or a command-position eval/source/`.` whose argument is blanked
	// quoted data. Both run against the DEQUOTED view so quoting tricks
	// (`e\val`, `'ev'al`) cannot hide the word, while heredoc bodies and
	// comments stay excluded — a spec that merely DOCUMENTS `cat() { … }` or
	// mentions "eval" in prose stays inert.
	if (first.ansiCEscape || hasDataConsumerShadow(first.dequotedView) || hasShellEvaluatedCommand(first.dequotedView)) {
		return maskHeredocBodiesPass(command, true).result;
	}
	return first.result;
}

function maskHeredocBodiesPass(
	command: string,
	shadowed: boolean,
): { result: HeredocMaskResult; dequotedView: string; ansiCEscape: boolean } {
	const lines = command.split("\n");
	const out: string[] = [];
	const dequotedLines: string[] = [];
	const state: ShellQuoteState = { inSingle: false, inDouble: false, inAnsiC: false, parenStack: [] };
	let previousContinued = false;
	let opaqueExpansion = false;
	let mutatingConsumer = false;
	let sawAnsiCEscape = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		out.push(line);
		// Cross-line quote masking decides whether a `<<` is real syntax or inert
		// data — even when the enclosing quote opened on a previous line.
		const { masked, dequoted, continued, ansiCEscape } = maskLineForSyntax(line, state);
		if (ansiCEscape) sawAnsiCEscape = true;
		const syntax = masked;
		const isContinuationLine = previousContinued;
		// Bash removes a backslash-newline pair entirely: fold a continuation into
		// the previous dequoted line so split command words (`e\` + `val`)
		// reassemble for command/shadow detection.
		if (isContinuationLine && dequotedLines.length > 0) {
			let previousDequoted = dequotedLines[dequotedLines.length - 1] ?? "";
			// A continuation can also split ANSI-C/locale quoting (`$\` + `'eval'` or
			// `$\` + `"eval"`): the rejoined `$'`/`$"` still drops its `$` during
			// quote removal.
			if (previousDequoted.endsWith("$") && (line.startsWith("'") || line.startsWith('"'))) {
				previousDequoted = previousDequoted.slice(0, -1);
				// The masker already opened this quote as ordinary (it ran before the
				// fold), so re-check the rejoined ANSI-C span for runtime-decoding
				// escapes (`$\` + `'\145val'`) it could not have flagged.
				if (line.startsWith("'") && /^'[^']*\\/.test(line)) sawAnsiCEscape = true;
			}
			dequotedLines[dequotedLines.length - 1] = previousDequoted + dequoted;
		} else {
			dequotedLines.push(dequoted);
		}
		previousContinued = continued;
		for (const match of line.matchAll(BASH_HEREDOC_OPEN_RE)) {
			const at = match.index ?? 0;
			if (syntax.slice(at, at + 2) !== "<<") continue;
			const delimiter = match[2] ?? match[3] ?? match[5] ?? "";
			if (!delimiter) continue;
			let kind = heredocConsumerKind(syntax, at);
			// A continued/continuation opener line hides part of the pipeline
			// (`cat <<'EOF' \` / `| bash`); a shadowed consumer name is untrustworthy.
			// Both downgrade masking eligibility, never block eligibility.
			if (kind === "data" && (shadowed || continued || isContinuationLine)) kind = "other";
			if (kind === "mutating") mutatingConsumer = true;
			const quoted = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined;
			const stripTabs = match[1] === "-";
			let end = -1;
			for (let scan = index + 1; scan < lines.length; scan++) {
				const candidate = stripTabs ? (lines[scan] ?? "").replace(/^\t+/, "") : (lines[scan] ?? "");
				if (candidate === delimiter) {
					end = scan;
					break;
				}
			}
			if (end === -1) {
				return {
					result: { masked: command, opaqueExpansion, mutatingConsumer },
					dequotedView: dequotedLines.join("\n"),
					ansiCEscape: sawAnsiCEscape,
				};
			}
			const maskBody = kind === "data" || kind === "mutating";
			for (let body = index + 1; body < end; body++) {
				const bodyLine = lines[body] ?? "";
				if (maskBody && !quoted && /\$\(|`/.test(bodyLine)) opaqueExpansion = true;
				out.push(maskBody ? "" : bodyLine);
			}
			out.push(lines[end] ?? "");
			index = end;
			// Heredoc bodies are data: they never affect the shell quote state or
			// the syntax view used for shadow detection.
			previousContinued = false;
		}
	}
	return {
		result: { masked: out.join("\n"), opaqueExpansion, mutatingConsumer },
		dequotedView: dequotedLines.join("\n"),
		ansiCEscape: sawAnsiCEscape,
	};
}

function extractBashTargets(args: unknown, depth = 0): ExtractedTargets {
	const record = getRecord(args);
	const command = safeString(record?.command);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	if (!command.trim()) {
		targets.unknown = true;
		return targets;
	}
	// A literal `sh|bash|zsh -c '<script>'` payload is a real command list. Its
	// mutations never match the top-level patterns, so recurse into it; anything
	// deeper than a bounded depth is not statically analyzable and fails closed.
	for (const match of command.matchAll(BASH_NESTED_SHELL_RE)) {
		if (depth >= 2) {
			targets.explicitMutation = true;
			targets.unknown = true;
			break;
		}
		const nested = extractBashTargets({ command: match[2] ?? match[4] ?? "" }, depth + 1);
		for (const nestedPath of nested.paths) addPath(targets, nestedPath);
		if (nested.unknown) targets.unknown = true;
		if (nested.explicitMutation) targets.explicitMutation = true;
	}
	// Heredoc bodies fed to data consumers are inert document payloads; mask them
	// so spec/plan text cannot fake redirections. Script-consumer bodies survive
	// the mask and are still scanned as live code below.
	const heredoc = maskHeredocBodies(command);
	if (heredoc.opaqueExpansion || heredoc.mutatingConsumer) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	// Nested scripts were read from the raw text above; every scanner below works
	// on the masked view so quoted argument data cannot look like a redirection.
	const scanned = maskSingleQuotedSpans(heredoc.masked);
	if (
		BASH_OPAQUE_INTERPRETER_WRITE_RE.test(heredoc.masked) ||
		BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE.test(heredoc.masked)
	) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	// `exec 1<>file` rebinds a descriptor, so a later `>/dev/null` may not reach the device at all.
	if (BASH_EXEC_REDIRECT_RE.test(scanned)) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	for (const match of scanned.matchAll(BASH_EXTENDED_WRITE_RE)) {
		targets.explicitMutation = true;
		const cleaned = cleanShellWord(match[1] ?? "");
		if (!cleaned) targets.unknown = true;
		else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
	}
	for (const match of scanned.matchAll(BASH_DD_OUTPUT_RE)) {
		targets.explicitMutation = true;
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
	for (const match of scanned.matchAll(BASH_IN_PLACE_MUTATION_COMMAND_RE)) {
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		const hasInPlaceFlag = parts.some(part => /^-.*i/.test(part));
		if (!hasInPlaceFlag) continue;
		targets.explicitMutation = true;
		const target = [...parts].reverse().find(part => part && !part.startsWith("-"));
		if (target) addPath(targets, target);
		else targets.unknown = true;
	}
	for (const match of scanned.matchAll(BASH_MUTATION_COMMAND_RE)) {
		targets.explicitMutation = true;
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
			// Redirection/heredoc operator words (`>/dev/null`, `<<'DOC'`, `2>&1`) are
			// not argument paths; their targets are captured by the redirect scanners.
			if (/^\d*[<>]/.test(cleaned)) continue;
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
	// Bash during a planning phase blocks only when a filesystem mutation was
	// actually recognized. Inspection, reads, and CLI invocations the scanner does
	// not model stay usable; other tools keep failing closed on unknown targets.
	if (targets.unknown && (input.tool.name !== "bash" || targets.explicitMutation)) {
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
