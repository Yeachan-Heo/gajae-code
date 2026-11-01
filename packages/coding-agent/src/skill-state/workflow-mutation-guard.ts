import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";
import { canonicalEnvKey, type ProjectEnvSnapshot, projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { isAutoresearchAuthorizedResearchPath } from "../autoresearch/git";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import {
	GJC_SESSION_PREFIX,
	sessionDirName,
	modeStatePath as sessionModeStatePath,
} from "../gjc-runtime/session-layout";
import { resolveGjcSessionForRead } from "../gjc-runtime/session-resolution";
import { ModeStateSchema } from "../gjc-runtime/state-schema";
import { workflowEnvelopeChecksumStatus } from "../gjc-runtime/state-writer";
import { getSkillManifest } from "../gjc-runtime/workflow-manifest";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { isGithubReadOnlyArgs } from "../tools/github-side-effect";
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
export const AUTORESEARCH_MUTATION_BLOCK_MESSAGE =
	"Autoresearch research-only boundary: this workflow produces findings, evidence, and a verdict — never product code. Product-code mutation tools and patch execution are blocked everywhere, on every branch. Write the root `autoresearch.sh` only with direct file tools; mission state stays writable through the sanctioned `gjc autoresearch` CLI. Run experiments through the `python` tool, or finish the mission and hand off to an approved implementation workflow.";

/** Resolve the phase-boundary block message for the active planning skill. */
function planningPhaseBlockMessage(skill: CanonicalGjcWorkflowSkill): string {
	if (skill === "ralplan") return RALPLAN_MUTATION_BLOCK_MESSAGE;
	if (skill === "autoresearch") return AUTORESEARCH_MUTATION_BLOCK_MESSAGE;
	if (skill === "ultragoal") return ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE;
	return DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE;
}

/**
 * Tools whose execute path can mutate product state. `github` is included so
 * side-effect ops share this guard. `eval` and `python` run code that can write
 * files without going through edit, write, or bash.
 */
export const WORKFLOW_MUTATION_TOOL_NAMES = ["edit", "write", "ast_edit", "bash", "github", "eval", "python"] as const;

const BLOCKED_TOOL_NAMES = new Set<string>(WORKFLOW_MUTATION_TOOL_NAMES);
const AUTORESEARCH_HARNESS_FILE_TOOL_NAMES = new Set(["edit", "write"]);

export function isWorkflowMutationTool(name: string): boolean {
	return BLOCKED_TOOL_NAMES.has(name);
}
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
/**
 * Executable wrappers that run their operand as a command (`command rm x`,
 * `env rm x`, `exec rm x`). Bash resolves through them, so the mutator that
 * follows is a real write. Left unmodeled they produced no target and no
 * unknown flag, letting a mutation cross the planning boundary. `env` may
 * carry `NAME=value` assignments before the wrapped command.
 */
const BASH_COMMAND_WRAPPER_SOURCE =
	"(?:(?:command|builtin|exec|nohup|nice|ionice|stdbuf|setsid|time|env)\\s+(?:-[^\\s]+\\s+(?:\\d+\\s+)?|\\w+=[^\\s]*\\s+)*)*";
/**
 * Shell keywords that open a NEW command position without a `;`/`|`/`&`
 * separator in front of the command word (`then rm x`, `do rm x`, `else rm x`).
 * Normalizing them to separators lets the existing mutation regexes see the
 * command position instead of treating `then rm` as one opaque word.
 */
const BASH_COMMAND_POSITION_KEYWORD_RE = /(?:^|[;&|(\n{}])\s*(?:then|else|elif|do|in|\{|!)(?=\s)/gi;
const BASH_MUTATION_COMMAND_RE = new RegExp(
	`(?:^|[;&|(\\n])\\s*(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|()]*\\/)?(?:tee|touch|rm|mkdir|cp|mv|install|truncate|chmod|ln)\\b([^;&|()\\n]*)|(?:^|[^<>])(?:>>?|\\d>>?)\\s*([^\\s;&|]+)`,
	"gi",
);
/** Command-word extractor; must accept the same prefixes as `BASH_MUTATION_COMMAND_RE`. */
const BASH_MUTATION_COMMAND_NAME_RE = new RegExp(
	`(?:^|[;&|(\\n])\\s*(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|()]*\\/)?(tee|touch|rm|mkdir|cp|mv|install|truncate|chmod|ln)\\b`,
	"i",
);
const BASH_CHMOD_MODE_RE = /^(?:[0-7]{1,4}|(?:[ugoa]*[+=-][rwxXstugo]*)(?:,[ugoa]*[+=-][rwxXstugo]*)*)$/;
const BASH_IN_PLACE_MUTATION_COMMAND_RE = new RegExp(
	`(?:^|[;&|(\\n])\\s*(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|()]*\\/)?(?:sed|perl)\\b([^;&|()\\n]*)`,
	"gi",
);
/**
 * Write APIs a planning one-liner cannot be allowed to call. The destination is
 * not a static path the temp allowlist can trust, so a match fails closed the
 * same way `open(` / `writeFile(` / `.write(` already do. `perl` is included
 * because `perl -e 'open(...)'` is that same call.
 */
const BASH_INTERPRETER_WRITE_API_PATTERNS = [
	"open\\s*\\(",
	"writeFile(?:Sync)?\\s*\\(",
	"appendFile(?:Sync)?\\s*\\(",
	"file_put_contents\\s*\\(",
	"fwrite\\s*\\(",
	"fputs\\s*\\(",
	"unlink\\s*\\(",
	"rename\\s*\\(",
	"mkdir\\s*\\(",
	"rmdir\\s*\\(",
	"copy\\s*\\(",
	"symlink\\s*\\(",
	"link\\s*\\(",
	"move_uploaded_file\\s*\\(",
	"truncate\\s*\\(",
	"touch\\s*\\(",
	"\\.write\\s*\\(",
	"shutil\\s*\\.\\s*(?:copy2?|copyfileobj|copyfile)\\s*\\(",
	"os\\s*\\.\\s*symlink\\s*\\(",
] as const;
const BASH_INTERPRETER_WRITE_API = `(?:${BASH_INTERPRETER_WRITE_API_PATTERNS.join("|")})`;
const BASH_INTERPRETER_WRITE_API_EXCLUDING_OPEN = `(?:${BASH_INTERPRETER_WRITE_API_PATTERNS.slice(1).join("|")})`;
const INTERPRETER_OUTPUT_METHOD_ASSIGNMENT_RE =
	/^\b(?:(?:process|Bun|Deno|sys)(?:\s*\.\s*(?:stdout|stderr)|\s*\[\s*["'`](?:stdout|stderr)["'`]\s*\])|(?:process|Bun|Deno|sys)\s*\[\s*[^\]]+\s*\]\s*(?:\.\s*write|\[\s*["'`]write["'`]\s*\])|(?:(?:globalThis|global)\s*\.\s*)?console)(?:\s*(?:\.\s*[\w$]+|\[\s*[^\]]+\s*\]))?\s*(?:\|\|=|&&=|\?\?=|[+\-*/%&|^]?=(?!=|>))/;

/**
 * A stream object can also be mutated reflectively, so an exempted
 * `process.stdout.write(...)` is only trustworthy when nothing in the source can
 * have replaced that method (`Object.assign(process.stdout, {write: ...})`).
 */
const INTERPRETER_OUTPUT_STREAM_MUTATION_RE =
	/\b(?:Object\s*\.\s*(?:assign|definePropert(?:y|ies))|Reflect\s*\.\s*(?:set|defineProperty))\s*\(\s*(?:process|Bun|Deno|sys)\s*(?:\.\s*(?:stdout|stderr)|\[\s*["'`](?:stdout|stderr)["'`]\s*\])/;
/**
 * Inline interpreter source is opaque whenever it exposes code evaluation or
 * reflective loading. This deliberately scans the complete source spelling,
 * including quoted spans, because another language may evaluate those spans.
 */
const INTERPRETER_DYNAMIC_EXECUTION_RE =
	/\b(?:eval|exec|execfile|Function|instance_eval|instance_exec|class_eval|class_exec|module_eval|module_exec|send|public_send|__send__|method_missing|__import__|exec_module|import_module|run_path|run_module|loadstring|dofile|loadfile|load|source|include|include_once|require_once|create_function|call_user_func(?:_array)?|setTimeout|setInterval|runInThisContext|runInNewContext|runInContext|getattr|setattr|__getattr__|__getattribute__|ReflectionClass|ReflectionFunction|ReflectionMethod|invokeMethod|invokeArgs)\b/;
const INTERPRETER_FILESYSTEM_REQUIRE_RE =
	/\b(?:require|import|from)\s*(?:\(\s*)?(['"\x60])(?:node:)?(?:fs(?:\/promises)?|fs-extra|graceful-fs|child_process|fileutils|io|lfs)\1(?:\s*\))?/i;
const INTERPRETER_NONLITERAL_REQUIRE_RE = /\brequire\s*(?:\(\s*(?!['"\x60])|\s+(?!['"\x60]))/i;
const SHELL_DOT_SOURCE_RE = /(?:^|[;&|\n])\s*(?:(?:if|then|do)\s+)?\.\s+(?:["'$`]|[A-Za-z0-9_./~])/;
/** Executable Python source evaluation and dynamic imports make payloads opaque; compile() alone is inert. */
const PYTHON_DYNAMIC_EXECUTION_IDENTIFIER_RE =
	/^(?:exec|eval|execfile|__import__|exec_module|import_module|run_path|run_module|getattr|setattr|__getattr__|__getattribute__)\b/;
const PYTHON_DYNAMIC_EXECUTION_TOKEN_RE =
	/\b(?:exec|eval|execfile|__import__|exec_module|import_module|run_path|run_module|getattr|setattr|__getattr__|__getattribute__)\b/;
/** JavaScript evaluation exposes unscanned code. */
const JAVASCRIPT_DYNAMIC_EXECUTION_IDENTIFIER_RE = /^(?:eval|Function)(?![\w$])/;
const BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE = new RegExp(
	`(?:^|[;&|\\n])\\s*(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?(?:python3?|node|ruby|perl)\\b[^;&|\\n]*(?:<<[-]?\\s*['"]?\\w+['"]?)[\\s\\S]*${BASH_INTERPRETER_WRITE_API}`,
	"i",
);
const BASH_DD_OUTPUT_RE = new RegExp(
	`(?:^|[;&|\\n])\\s*(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|]*\\/)?dd\\b([^;&|\\n]*)`,
	"gi",
);
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

/** Canonical workflow skills whose active posture gates product-code mutation. */
type MutationGatedSkill = "deep-interview" | "ralplan" | "ultragoal" | "autoresearch";

/** Workflow skills whose active posture this guard enforces against product-code mutation. */
function isPlanningSkill(skill: string): skill is MutationGatedSkill {
	return skill === "deep-interview" || skill === "ralplan" || skill === "ultragoal" || skill === "autoresearch";
}

/**
 * Whether `skill` in `phase` is a pre-approval planning posture that must block
 * product-code mutation. `deep-interview` and `ralplan` are wholly pre-approval
 * (every phase blocks except a genuinely-finished one — `handoff` and ralplan's
 * `final` keep blocking until execution is approved and the skill is demoted).
 * `ultragoal` only blocks during `goal-planning`; once goals are created it is an
 * executor and mutates freely.
 */
function isBlockingPlanningPhase(skill: MutationGatedSkill, phase: string): boolean {
	const normalized = phase.trim().toLowerCase();
	if (skill === "ultragoal") return normalized === "goal-planning";
	return !getSkillManifest(skill).stopReleasingPhases.includes(normalized);
}

interface ActivePlanningSkill {
	skill: MutationGatedSkill;
	phase: string;
}

/**
 * Pick the single CURRENT workflow entry among active entries.
 *
 * Steady state has exactly one active workflow skill (handoff demotes the prior
 * to `active:false`, which `listActiveSkills` already filters out). If several
 * are momentarily active, prefer the most-recently-updated entry so a stale
 * planning row (e.g. a still-active ralplan `final`) can never be selected over a
 * newer executor (ultragoal/autoresearch), and a planning *return* (newer `updated_at`)
 * reliably wins. Ties fall back to the resolved top-level `skill`, then to the
 * first entry, matching how the HUD/chain guard pick `activeSkills[0]`.
 */
export function resolveCurrentWorkflowEntry(entries: SkillActiveEntry[], topLevelSkill: string): SkillActiveEntry {
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
 * Fail-open contract: a missing or schema-invalid durable mode-state releases
 * the block (a corrupt state file must not lock all mutation), matching the
 * guard's historical behavior — this is intentionally looser than the Stop
 * hook, which fails closed for handoff-required skills. A checksum mismatch is
 * not that case: the file is still schema-valid, and the CLI already refuses
 * it as an out-of-band edit. The guard keeps the active entry's phase instead
 * of letting the forged `current_phase` or `active: false` release the block.
 * An unsigned envelope may restate that entry, but it may not release a block
 * the entry still holds. It may still name a stricter blocking phase: the
 * pre-fix guard honored that phase, and dropping it would allow an edit the
 * base rejected. A `session_id` or `thread_id` that does not match this
 * session is the same kind of claim: it does not make the file someone else's,
 * and it does not open the block. A matching `content_sha256` whose context
 * also matches is the existing writer stamp and is trusted.
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
	const activePhase = String(current.phase ?? "").trim();
	const posture = planningPostureFromModeState(current.skill, activePhase, modeState, resolvedSessionId, threadId);
	if (posture.tampered) {
		warnInvalidModeState(
			modeStatePath(cwd, current.skill, resolvedSessionId),
			"out-of-band edit detected (content_sha256 mismatch)",
		);
	}
	if (!posture.blocking) return null;
	return { skill: current.skill, phase: posture.phase };
}

/**
 * Decide whether `modeState` may release the planning block.
 *
 * The active entry is the seal. A mode-state file releases that seal only when
 * its writer-stamped `content_sha256` matches and its session context matches,
 * or when an unsigned file in the same context does not claim a looser posture
 * than the entry. An unsigned file may still impose a stricter blocking phase.
 * Checksum mismatch ignores the file. A context mismatch does not release the
 * entry's block: the file was read from this session's path.
 */
function planningPostureFromModeState(
	skill: MutationGatedSkill,
	activePhase: string,
	modeState: ModeState,
	sessionId?: string,
	threadId?: string,
): { blocking: boolean; phase: string; tampered: boolean } {
	const status = workflowEnvelopeChecksumStatus(modeState);
	if (status === "mismatch") {
		return {
			blocking: isBlockingPlanningPhase(skill, activePhase),
			phase: activePhase,
			tampered: true,
		};
	}
	if (!modeStateMatchesContext(modeState, sessionId, threadId)) {
		return {
			blocking: isBlockingPlanningPhase(skill, activePhase),
			phase: activePhase,
			tampered: false,
		};
	}
	if (status === "match") {
		if (modeState.active !== true) return { blocking: false, phase: activePhase, tampered: false };
		const phase = String(modeState.current_phase ?? activePhase).trim();
		return { blocking: isBlockingPlanningPhase(skill, phase), phase, tampered: false };
	}
	if (!isBlockingPlanningPhase(skill, activePhase)) {
		const stricterPhase = String(modeState.current_phase ?? "").trim();
		if (modeState.active === true && stricterPhase && isBlockingPlanningPhase(skill, stricterPhase)) {
			return { blocking: true, phase: stricterPhase, tampered: false };
		}
		return { blocking: false, phase: activePhase, tampered: false };
	}
	if (modeState.active !== true) return { blocking: true, phase: activePhase, tampered: false };
	const modePhase = String(modeState.current_phase ?? "").trim();
	if (
		modePhase &&
		!isBlockingPlanningPhase(skill, modePhase) &&
		modePhase.trim().toLowerCase() !== activePhase.trim().toLowerCase()
	) {
		return { blocking: true, phase: activePhase, tampered: false };
	}
	const phase = modePhase || activePhase;
	return { blocking: isBlockingPlanningPhase(skill, phase), phase, tampered: false };
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
 * Blank out quoted spans so shell metacharacters inside a literal argument
 * value (e.g. `--evidence "p99 500ms -> 120ms"`) are not misread as
 * redirections or separators.
 *
 * Both quote styles are masked because in POSIX shells neither one can contain
 * a redirection or a command separator: `>`, `|`, `;`, and `&` are always
 * literal data inside quotes. Masking only single quotes made every `>` in
 * double-quoted PROSE look like a real redirect, so ordinary evidence text
 * (`"throughput > baseline"`, `"500ms -> 120ms"`) was scanned as a file write
 * and blocked.
 *
 * Double quotes differ from single quotes in one way that matters here: they
 * still expand `$(...)` and backticks, and that substitution IS live code. So
 * the literal text of a double-quoted span is masked while any substitution
 * inside it is preserved verbatim for the scanners that follow.
 *
 * One span is never prose: a quoted word that is the OPERAND of a redirection
 * or of `of=` (`> "/dev/null"`, `>" src.ts"`, `of=" /dev/null"`) names a file.
 * Masking it would erase the very path the sink and bypass checks must read, so
 * operand spans are preserved verbatim. The returned dequoted view performs
 * shell quote removal for executable-word/argument extraction while replacing
 * quoted separators with inert placeholders.
 */
/**
 * Does the double quote at `quoteIndex` open a redirection / `of=` operand
 * rather than a prose argument? Only whitespace may sit between the operator
 * and the quote, so `> "x"`, `>"x"`, `2>>"x"`, `>|"x"`, and `of="x"` all
 * qualify, while `--evidence "a > b"` does not.
 */
function opensRedirectionOperand(command: string, quoteIndex: number): boolean {
	let cursor = quoteIndex - 1;
	while (cursor >= 0 && (command[cursor] === " " || command[cursor] === "\t")) cursor -= 1;
	if (cursor < 0) return false;
	const previous = command[cursor];
	if (previous === ">" || previous === "<" || previous === "|" || previous === "&") {
		// `|`/`&` qualify only as part of a redirection operator (`>|`, `>&`).
		if (previous === "|" || previous === "&") {
			const before = command[cursor - 1];
			return before === ">" || before === "<";
		}
		return true;
	}
	// `of="..."` (dd) names an output file the same way a redirection does.
	return previous === "=" && /(?:^|[\s;&|])of=$/i.test(command.slice(0, cursor + 1));
}

interface MaskedQuotedSpans {
	masked: string;
	/**
	 * Quote removal preserves executable word characters while neutralizing
	 * quoted separators/metacharacters. This lets mutation extraction recognize
	 * `r"m"` and `rm "src/product.ts"` without re-exposing prose as syntax.
	 */
	dequoted: string;
	/** True when live syntax cannot be balanced by this lightweight parser. */
	unmodeled: boolean;
}

type QuotedSpanFrame = {
	kind: "root" | "paren" | "backtick";
	quote: "none" | "single" | "double";
	parenDepth: number;
	quotedOperand: boolean;
	/** An unquoted `#` comment consumes the rest of this live frame line. */
	comment: boolean;
	/** Last live byte in this frame, used for comment-boundary recognition. */
	previous: string;
	/** True while the frame is at a command-list boundary before its first word. */
	expectCommand: boolean;
};

function maskQuotedSpans(command: string): MaskedQuotedSpans {
	let masked = "";
	let dequoted = "";
	let unmodeledSyntax = false;
	const frames: QuotedSpanFrame[] = [
		{
			kind: "root",
			quote: "none",
			parenDepth: 0,
			quotedOperand: false,
			comment: false,
			previous: "",
			expectCommand: true,
		},
	];
	const dequoteData = (character: string): string => (/[\w./-]/.test(character) ? character : "_");
	const appendLive = (frame: QuotedSpanFrame, character: string): void => {
		masked += character;
		dequoted += character;
		frame.previous = character;
		if (character === "\n" || ";|&".includes(character)) frame.expectCommand = true;
		else if (character === "(" && frame.kind === "paren") frame.expectCommand = true;
		else if (!/\s/.test(character)) frame.expectCommand = false;
	};
	const appendQuoted = (character: string, operand: boolean): void => {
		if (operand) masked += character;
		else masked += character === "\n" ? "\n" : " ";
		dequoted += dequoteData(character);
	};

	for (let index = 0; index < command.length; index += 1) {
		const frame = frames.at(-1) as QuotedSpanFrame;
		const character = command[index] as string;
		const next = command[index + 1];

		// A comment inside a live substitution must not let a literal `)` close
		// that substitution. Preserve the newline as syntax, but mask all bytes
		// before it as inert comment data.
		if (frame.comment) {
			if (character === "\n") {
				frame.comment = false;
				appendLive(frame, character);
			} else {
				appendQuoted(character, false);
			}
			continue;
		}

		// Backslash escapes are quote syntax, not command boundaries. In the
		// dequoted view the escaped byte survives only as data; in the masked
		// view preserve the historical bytes so redirection extraction remains
		// conservative.
		if (character === "\\" && frame.quote !== "single") {
			if (next === undefined) {
				appendQuoted(character, frame.quote !== "none" && frame.quotedOperand);
				continue;
			}
			if (next === "\n") {
				index += 1;
				continue;
			}
			if (frame.quote === "none" || frame.quotedOperand) masked += character + next;
			else masked += "  ";
			dequoted += dequoteData(next);
			frame.previous = "_";
			if (frame.quote === "none") frame.expectCommand = false;
			index += 1;
			continue;
		}

		if (frame.quote === "single") {
			if (character === "'") {
				masked += character;
				frame.quote = "none";
				frame.quotedOperand = false;
				frame.previous = character;
			} else {
				appendQuoted(character, frame.quotedOperand);
			}
			continue;
		}

		if (frame.quote === "double") {
			if (character === '"') {
				masked += character;
				frame.quote = "none";
				frame.quotedOperand = false;
				frame.previous = character;
				continue;
			}
			// A substitution is live even when it appears inside a double-quoted
			// argument. Push a separate parser frame so quotes/parentheses inside
			// the substitution cannot close the surrounding `"` prematurely.
			if (character === "$" && next === "(") {
				masked += "$(";
				dequoted += "$(";
				frame.previous = "(";
				frame.expectCommand = false;
				frames.push({
					kind: "paren",
					quote: "none",
					parenDepth: 0,
					quotedOperand: false,
					comment: false,
					previous: "",
					expectCommand: true,
				});
				index += 1;
				continue;
			}
			if (character === "`") {
				masked += character;
				dequoted += character;
				frame.previous = character;
				frame.expectCommand = false;
				frames.push({
					kind: "backtick",
					quote: "none",
					parenDepth: 0,
					quotedOperand: false,
					comment: false,
					previous: "",
					expectCommand: true,
				});
				continue;
			}
			appendQuoted(character, frame.quotedOperand);
			continue;
		}

		// A command-substitution frame closes only at its own unquoted `)`.
		// Parentheses nested inside `$((…))`/`$( (… ) …)` are tracked separately.
		if (frame.kind === "paren" && character === ")") {
			if (frame.parenDepth > 0) {
				frame.parenDepth -= 1;
				appendLive(frame, character);
			} else {
				appendLive(frame, character);
				frames.pop();
				const parent = frames.at(-1);
				if (parent) {
					// A substitution close belongs to the current shell word.
					parent.previous = "_";
					parent.expectCommand = false;
				}
			}
			continue;
		}
		if (frame.kind === "backtick" && character === "`") {
			appendLive(frame, character);
			frames.pop();
			const parent = frames.at(-1);
			if (parent) {
				parent.previous = character;
				parent.expectCommand = false;
			}
			continue;
		}

		if (frame.quote === "none" && character === "#" && (frame.previous === "" || /[\s;|&()]/.test(frame.previous))) {
			frame.comment = true;
			appendQuoted(character, false);
			continue;
		}
		if (frame.quote === "none" && frame.expectCommand) {
			const ahead = command.slice(index, index + 9);
			if (
				frame.kind !== "root" &&
				/^(?:case|if|for|while|until|select|function|time|!|\{)(?:[\s;|&()]|$)/.test(ahead)
			) {
				// Compound commands have command positions the mutation regexes do
				// not model; `case` also uses `)` as a pattern terminator. Balanced
				// parentheses alone cannot authorize these live substitution bodies.
				unmodeledSyntax = true;
			} else if (frame.kind === "root" && /^(?:case|select|function)(?:[\s;|&()]|$)/.test(ahead)) {
				// At the root the other compounds are recovered by command-position
				// keyword normalization below, but `case` overloads `)` as a pattern
				// terminator and `select`/`function` introduce command positions the
				// regexes cannot attribute. Fail closed instead of scanning blind.
				unmodeledSyntax = true;
			}
		}
		if (character === "'") {
			masked += character;
			frame.quote = "single";
			// A single-quoted redirection/`of=` operand names a file exactly like a
			// double-quoted one (`> '/dev/null'`, `of='/dev/null'`). Masking it would
			// erase the path the sink and bypass checks must read.
			frame.quotedOperand = opensRedirectionOperand(command, index);
			frame.previous = character;
			frame.expectCommand = false;
			continue;
		}
		if (character === '"') {
			masked += character;
			frame.quote = "double";
			frame.quotedOperand = opensRedirectionOperand(command, index);
			frame.previous = character;
			frame.expectCommand = false;
			continue;
		}
		if (character === "$" && next === "(") {
			masked += "$(";
			dequoted += "$(";
			frame.previous = "(";
			frame.expectCommand = false;
			frames.push({
				kind: "paren",
				quote: "none",
				parenDepth: 0,
				quotedOperand: false,
				comment: false,
				previous: "",
				expectCommand: true,
			});
			index += 1;
			continue;
		}
		// ANSI-C (`$'…'`) and locale-translated (`$"…"`) quoting: bash strips the
		// `$` during quote removal, so `$'rm' src/product.ts` really executes `rm`.
		// The dequoted view must drop the `$` too, otherwise the executable word
		// keeps a leading `$` and misses the mutation regexes entirely. The masked
		// (syntax) view keeps the byte so redirection offsets stay conservative.
		if (character === "$" && (next === "'" || next === '"')) {
			masked += character;
			frame.quote = next === "'" ? "single" : "double";
			masked += next;
			frame.quotedOperand = opensRedirectionOperand(command, index);
			frame.previous = next;
			frame.expectCommand = false;
			index += 1;
			continue;
		}
		if (character === "`") {
			appendLive(frame, character);
			frames.push({
				kind: "backtick",
				quote: "none",
				parenDepth: 0,
				quotedOperand: false,
				comment: false,
				previous: "",
				expectCommand: true,
			});
			continue;
		}
		if (frame.kind === "paren" && character === "(") frame.parenDepth += 1;
		appendLive(frame, character);
	}

	// An unbalanced quote/substitution means the parse is unreliable; keep the
	// original text so both passes remain fail-closed rather than going blind.
	const root = frames[0];
	const unbalanced = frames.length !== 1 || root?.quote !== "none";
	if (unbalanced || unmodeledSyntax) {
		return { masked: command, dequoted: command, unmodeled: true };
	}
	// `then rm x` / `do rm x` / `{ rm x` put a mutator in a command position that
	// is not preceded by a `;`/`|`/`&` separator, so the mutation regexes would
	// read `then rm` as a single opaque word. Replacing the keyword with a `;`
	// keeps byte length (match offsets stay aligned) while exposing the position.
	const exposeCommandPositions = (value: string): string =>
		value.replace(BASH_COMMAND_POSITION_KEYWORD_RE, segment => {
			const keyword = segment.trimEnd();
			return `${keyword.slice(0, keyword.length - 1)};`.padEnd(segment.length, " ");
		});
	return { masked: exposeCommandPositions(masked), dequoted: exposeCommandPositions(dequoted), unmodeled: false };
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

/**
 * A command-substitution body and whether its delimiters were balanced. An
 * unbalanced body is an unreliable parse and the caller fails closed on it.
 */
interface SubstitutionBody {
	body: string;
	balanced: boolean;
}

/** Keep parser-frame recursion bounded before extractBashTargets' semantic depth guard. */
const SUBSTITUTION_PARSER_MAX_DEPTH = 64;

/**
 * Scan a `$(` body starting just after the opening paren. Quotes inside the
 * body are honoured: a `)` inside `'...'` or `"..."` is data, not the closer.
 * Nested substitutions are scanned with their own quote/comment frame, so a
 * `#` or quote inside `$(...)` nested in a double-quoted outer substitution
 * cannot desynchronise this frame. Returns the body and the index just past
 * its closing paren, or `end === command.length` with `balanced: false`.
 */
function scanDollarParenBody(command: string, start: number, parserDepth = 0): SubstitutionBody & { end: number } {
	let depth = 1;
	let inSingle = false;
	let inDouble = false;
	let inComment = false;
	let previous = "";
	for (let cursor = start; cursor < command.length; cursor += 1) {
		const character = command[cursor];
		if (inComment) {
			if (character === "\n") {
				inComment = false;
				previous = character;
			}
			continue;
		}
		if (character === "\\" && !inSingle) {
			cursor += 1;
			previous = "x";
			continue;
		}
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			previous = character;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			previous = character;
			continue;
		}
		if (inSingle) continue;
		if (character === "$" && command[cursor + 1] === "(") {
			if (parserDepth >= SUBSTITUTION_PARSER_MAX_DEPTH) {
				return { body: command.slice(start), balanced: false, end: command.length };
			}
			const nested = scanDollarParenBody(command, cursor + 2, parserDepth + 1);
			if (!nested.balanced) {
				return { body: command.slice(start), balanced: false, end: command.length };
			}
			cursor = nested.end - 1;
			previous = "x";
			continue;
		}
		if (character === "`") {
			if (parserDepth >= SUBSTITUTION_PARSER_MAX_DEPTH) {
				return { body: command.slice(start), balanced: false, end: command.length };
			}
			const nested = scanBacktickBody(command, cursor + 1, parserDepth + 1);
			if (!nested.balanced) {
				return { body: command.slice(start), balanced: false, end: command.length };
			}
			cursor = nested.end - 1;
			previous = "x";
			continue;
		}
		if (!inDouble && character === "#" && (previous === "" || /\s/.test(previous) || ";|&()".includes(previous))) {
			inComment = true;
			continue;
		}
		if (!inDouble && character === "(") depth += 1;
		else if (!inDouble && character === ")") {
			depth -= 1;
			if (depth === 0) {
				return { body: command.slice(start, cursor), balanced: true, end: cursor + 1 };
			}
			previous = ")";
			continue;
		}
		previous = character;
	}
	return { body: command.slice(start), balanced: false, end: command.length };
}

/**
 * Scan a backtick command substitution with the same quote/comment rules as
 * `scanDollarParenBody`. Nested `$()` frames are skipped with their own
 * parser so backticks in those frames cannot close this one.
 */
function scanBacktickBody(command: string, start: number, parserDepth = 0): SubstitutionBody & { end: number } {
	let inSingle = false;
	let inDouble = false;
	let inComment = false;
	let previous = "";
	for (let cursor = start; cursor < command.length; cursor += 1) {
		const character = command[cursor];
		if (inComment) {
			if (character === "\n") {
				inComment = false;
				previous = character;
			}
			continue;
		}
		if (character === "\\" && !inSingle) {
			cursor += 1;
			previous = "x";
			continue;
		}
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			previous = character;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			previous = character;
			continue;
		}
		if (inSingle) continue;
		if (character === "$" && command[cursor + 1] === "(") {
			if (parserDepth >= SUBSTITUTION_PARSER_MAX_DEPTH) {
				return { body: command.slice(start), balanced: false, end: command.length };
			}
			const nested = scanDollarParenBody(command, cursor + 2, parserDepth + 1);
			if (!nested.balanced) {
				return { body: command.slice(start), balanced: false, end: command.length };
			}
			cursor = nested.end - 1;
			previous = "x";
			continue;
		}
		if (character === "`") {
			return { body: command.slice(start, cursor), balanced: true, end: cursor + 1 };
		}
		if (!inDouble && character === "#" && (previous === "" || /\s/.test(previous) || ";|&()".includes(previous))) {
			inComment = true;
			continue;
		}
		previous = character;
	}
	return { body: command.slice(start), balanced: false, end: command.length };
}

/**
 * Collect the bodies of `$(...)` and backtick command substitutions. Their
 * contents are a live command list wherever they appear -- including inside a
 * double-quoted span -- so the caller rescans each one as its own script.
 *
 * Quote state is tracked the way the shell does it: an apostrophe inside a
 * double-quoted word is data, not a single-quote opener, so `"it's $(rm x)"`
 * still yields the substitution; a `)` inside a quoted argument does not close
 * the body, so `$(printf ')'; rm x)` yields the whole body. Single-quoted spans
 * are skipped because they suppress substitution entirely. Shell comments are
 * skipped only at word boundaries, and their quote-like text cannot poison the
 * surrounding frame. A body whose delimiters never balance is reported as such
 * so the caller fails closed.
 */
function extractSubstitutionBodies(command: string): SubstitutionBody[] {
	const bodies: SubstitutionBody[] = [];
	let inSingle = false;
	let inDouble = false;
	let inComment = false;
	let previous = "";
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (inComment) {
			if (character === "\n") {
				inComment = false;
				previous = character;
			}
			continue;
		}
		if (character === "\\" && !inSingle) {
			index += 1;
			previous = "x";
			continue;
		}
		if (character === "'" && !inDouble) {
			inSingle = !inSingle;
			previous = character;
			continue;
		}
		if (character === '"' && !inSingle) {
			inDouble = !inDouble;
			previous = character;
			continue;
		}
		if (inSingle) continue;
		if (character === "$" && command[index + 1] === "(") {
			const scanned = scanDollarParenBody(command, index + 2);
			bodies.push({ body: scanned.body, balanced: scanned.balanced });
			index = scanned.end - 1;
			previous = "x";
			continue;
		}
		if (character === "`") {
			const scanned = scanBacktickBody(command, index + 1);
			bodies.push({ body: scanned.body, balanced: scanned.balanced });
			index = scanned.end - 1;
			previous = "x";
			continue;
		}
		if (!inDouble && character === "#" && (previous === "" || /\s/.test(previous) || ";|&()".includes(previous))) {
			inComment = true;
			continue;
		}
		previous = character;
	}
	return bodies;
}

const BASH_SED_COMMAND_RE = new RegExp(
	`(?:^|[;&|(\\n])\\s*(?:(?:if|then|else|elif|do|in|while|until)\\s+)*(?:!\\s+)?(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|()]*\\/)?sed\\b((?:'[^']*'|"(?:\\\\.|[^"\\\\])*"|\\\\.|[^'";&|()\\n\\\\])*)`,
	"gi",
);
const BASH_AWK_COMMAND_RE = new RegExp(
	`(?:^|[;&|(\\n])\\s*(?:(?:if|then|else|elif|do|in)\\s+)*(?:!\\s+)?(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|()]*\\/)?(?:awk|gawk|mawk|nawk|busybox\\s+awk)\\b((?:'[^']*'|"(?:\\\\.|[^"\\\\])*"|\\\\.|[^'";&|()\\n\\\\])*)`,
	"gi",
);

/** `true` when index sits at a sed command letter, not inside a pattern. */
function sedCommandPosition(script: string, index: number): boolean {
	if (index === 0) return true;
	return /[\s;{}\n\d$,]/.test(script[index - 1] ?? "");
}

function sedWriteName(script: string, index: number): { path: string | null; next: number } {
	let cursor = index;
	while (cursor < script.length && (script[cursor] === " " || script[cursor] === "\t")) cursor++;
	const start = cursor;
	while (cursor < script.length && script[cursor] !== ";" && script[cursor] !== "\n" && script[cursor] !== "}") {
		cursor++;
	}
	return { path: cursor > start ? script.slice(start, cursor) : null, next: cursor };
}

function sedAddressEnd(script: string, start: number): number | undefined {
	if (script[start] === "/") {
		let cursor = start + 1;
		while (cursor < script.length) {
			if (script[cursor] === "\\") {
				cursor += 2;
				continue;
			}
			if (script[cursor] === "/") return cursor + 1;
			cursor++;
		}
		return undefined;
	}
	if (script[start] === "$") return start + 1;
	if (!/\d/.test(script[start] ?? "")) return undefined;
	let cursor = start + 1;
	while (/\d/.test(script[cursor] ?? "")) cursor++;
	if (script[cursor] === "~") {
		cursor++;
		while (/\d/.test(script[cursor] ?? "")) cursor++;
	}
	return cursor;
}

function sedAddressWithModifiersEnd(script: string, start: number): number | undefined {
	let cursor = sedAddressEnd(script, start);
	if (cursor === undefined) return undefined;
	if (script[start] === "/") {
		while (script[cursor] === "I" || script[cursor] === "M") cursor++;
	}
	return cursor;
}

function sedRegexAddressWritePath(script: string, start: number): { path: string | null; next: number } | undefined {
	let cursor = sedAddressWithModifiersEnd(script, start);
	if (cursor === undefined) return undefined;
	while (script[cursor] === " " || script[cursor] === "\t") cursor++;
	if (script[cursor] === ",") {
		cursor++;
		while (script[cursor] === " " || script[cursor] === "\t") cursor++;
		const rangeEnd = sedAddressWithModifiersEnd(script, cursor);
		if (rangeEnd === undefined) return undefined;
		cursor = rangeEnd;
		while (script[cursor] === " " || script[cursor] === "\t") cursor++;
	}
	if (script[cursor] === "!") cursor++;
	while (script[cursor] === " " || script[cursor] === "\t") cursor++;
	if ((script[cursor] !== "w" && script[cursor] !== "W") || !" \t;\n}".includes(script[cursor + 1] ?? "\n")) {
		return undefined;
	}
	return sedWriteName(script, cursor + 1);
}

/**
 * Filename a sed script writes with the `w`/`W` command or an `s///w file` flag.
 * `undefined` means this text does not write. `null` means it writes without a
 * literal filename.
 */
/**
 * GNU sed can execute shell commands: the `e` command replaces the pattern
 * space with a shell command's output and `s///e` runs the result. Neither form
 * names a file, so their write targets cannot be derived and the whole program
 * must be treated as an unclassified mutation.
 */
function sedScriptRunsShellCommand(script: string): boolean {
	// GNU sed accepts a numeric, `$`, or regular-expression address (`/re/e cmd`).
	if (/(?:^|[;{}\n])\s*(?:(?:[0-9$]+(?:,[0-9$]+)?|\/(?:\\[\s\S]|[^\\/\n])*\/)\s*!?\s*)?e(?=[\s;}\n]|$)/.test(script))
		return true;
	return /\bs(\W)(?:\\.|(?!\1)[^\n])*?\1(?:\\.|(?!\1)[^\n])*?\1[gpiImM0-9]*e(?![A-Za-z])/.test(script);
}

function sedScriptWritePath(script: string): string | null | undefined {
	if (sedScriptRunsShellCommand(script)) return null;
	let index = 0;
	let foundWrite = false;
	let foundPath: string | null | undefined;
	while (index < script.length) {
		const character = script[index] ?? "";
		if (" \t\n;{}".includes(character)) {
			index++;
			continue;
		}
		if (character === "/" && sedCommandPosition(script, index)) {
			const written = sedRegexAddressWritePath(script, index);
			if (written) {
				if (foundWrite) return null;
				foundWrite = true;
				foundPath = written.path;
				index = Math.max(written.next, index + 1);
				continue;
			}
		}
		if ((character === "w" || character === "W") && sedCommandPosition(script, index)) {
			const next = script[index + 1];
			if (next === undefined || " \t;\n}".includes(next)) {
				const taken = sedWriteName(script, index + 1);
				if (foundWrite) return null;
				foundWrite = true;
				foundPath = taken.path;
				index = Math.max(taken.next, index + 1);
				continue;
			}
		}
		if (character === "s" && index + 1 < script.length) {
			const delimiter = script[index + 1] ?? "";
			if (delimiter && !/[\s\\]/.test(delimiter)) {
				index += 2;
				let fields = 1;
				while (index < script.length && fields < 3) {
					if (script[index] === "\\") {
						index += 2;
						continue;
					}
					if (script[index] === delimiter) fields++;
					index++;
				}
				while (index < script.length && script[index] !== ";" && script[index] !== "\n" && script[index] !== "}") {
					if (
						(script[index] === "w" || script[index] === "W") &&
						(script[index + 1] === " " || script[index + 1] === "\t")
					) {
						const taken = sedWriteName(script, index + 1);
						if (foundWrite) return null;
						foundWrite = true;
						foundPath = taken.path;
						index = Math.max(taken.next, index + 1);
						break;
					}
					index++;
				}
				continue;
			}
		}
		index++;
	}
	return foundWrite ? foundPath : undefined;
}

/**
 * `-c`/`-e` bodies are one shell word, so a `;` inside the quotes is not a
 * statement break. The line-oriented interpreter regex stops at that `;` and
 * misses `import shutil; shutil.copy(...)`.
 */
function interpreterStatementEnd(command: string, start: number): number {
	let index = start;
	let inSingle = false;
	let inDouble = false;
	while (index < command.length) {
		const character = command[index] ?? "";
		if (inSingle) {
			if (character === "'") inSingle = false;
			index++;
			continue;
		}
		if (inDouble) {
			if (character === "\\") {
				index += 2;
				continue;
			}
			if (character === '"') inDouble = false;
			index++;
			continue;
		}
		if (character === "'") {
			inSingle = true;
			index++;
			continue;
		}
		if (character === '"') {
			inDouble = true;
			index++;
			continue;
		}
		if (character === "\\") {
			index += 2;
			continue;
		}
		if (character === ";" || character === "&" || character === "|" || character === "\n") break;
		index++;
	}
	return index;
}

function pythonFStringExecutableCode(source: string, start: number): { code: string; end: number } {
	const quoteLength = source.startsWith('"""', start) || source.startsWith("'''", start) ? 3 : 1;
	const quote = source.slice(start, start + quoteLength);
	const fields: { brackets: number; format: boolean }[] = [];
	let code = "";
	for (let index = start + quoteLength; index < source.length; index++) {
		const character = source[index];
		const field = fields.at(-1);
		if (!field && source.startsWith(quote, index)) return { code, end: index + quoteLength };
		if (!field || field.format) {
			if (!field && character === "\\" && (source[index + 1] === quote[0] || source[index + 1] === "\\")) {
				index++;
			} else if (!field && (source.startsWith("{{", index) || source.startsWith("}}", index))) {
				index++;
			} else if (character === "{") {
				fields.push({ brackets: 0, format: false });
				code += ";";
			} else if (field && character === "}") {
				fields.pop();
				code += ";";
			}
			continue;
		}
		const isFString =
			(character === "'" || character === '"') &&
			/(?:^|[^\w])(?:[rR]?[fF]|[fF][rR])$/.test(source.slice(Math.max(0, index - 3), index));
		const nested = isFString ? pythonFStringExecutableCode(source, index) : undefined;
		const end = nested?.end ?? skipNoise(source, index, "py");
		if (end !== index) {
			code += nested ? `;${nested.code};` : " ";
			index = end - 1;
			continue;
		}
		if (character === "}" && field.brackets === 0) {
			fields.pop();
			code += ";";
		} else if (character === ":" && field.brackets === 0) {
			field.format = true;
		} else {
			if (character === "(" || character === "[" || character === "{") field.brackets++;
			if (character === ")" || character === "]" || character === "}") field.brackets--;
			code += character;
		}
	}
	return { code, end: source.length };
}

function pythonSystemCallArguments(script: string): { starts: number[]; unclassifiable: boolean } {
	const starts: number[] = [];
	let quote: "'" | '"' | null = null;
	let tripleQuote = false;
	let inComment = false;
	let unclassifiable = false;
	for (let index = 0; index < script.length; index++) {
		const character = script[index] ?? "";
		if (inComment) {
			if (character === "\n") inComment = false;
			continue;
		}
		if (quote) {
			if (character === "\\") {
				index++;
				continue;
			}
			if (tripleQuote && script.startsWith(quote.repeat(3), index)) {
				quote = null;
				tripleQuote = false;
				index += 2;
				continue;
			}
			if (!tripleQuote && character === quote) quote = null;
			continue;
		}
		if (character === "#") {
			inComment = true;
			continue;
		}
		if (character === "'" || character === '"') {
			const isFString = /(?:^|[^\w])(?:[rR]?[fF]|[fF][rR])$/.test(script.slice(0, index));
			tripleQuote = script.startsWith(character.repeat(3), index);
			quote = character;
			if (tripleQuote) {
				const close = script.indexOf(character.repeat(3), index + 3);
				const body = close < 0 ? script.slice(index + 3) : script.slice(index + 3, close);
				if (isFString && /\bos\s*\.\s*system\s*\(/.test(body)) unclassifiable = true;
				index += 2;
			} else if (isFString) {
				let close = index + 1;
				while (close < script.length) {
					if (script[close] === "\\") {
						close += 2;
						continue;
					}
					if (script[close] === character) break;
					close++;
				}
				if (/\bos\s*\.\s*system\s*\(/.test(script.slice(index + 1, close))) unclassifiable = true;
			}
			continue;
		}
		const call = script.slice(index).match(/^\bos\s*\.\s*system\s*\(/);
		if (call) {
			starts.push(index + call[0].length);
			index += call[0].length - 1;
		}
	}
	// `os.system` can reach the shell under another name: a captured callable
	// (`run = os.system`), a module alias (`import os as o`), a direct import alias
	// (`from os import system as run`), or any other `<obj>.system(...)`. Neither form
	// names its command here, so the shell payload is unclassifiable rather than invisible.
	const systemCalls = (script.match(/\.\s*system\s*\(/g) ?? []).length;
	const osSystemCalls = (script.match(/\bos\s*\.\s*system\s*\(/g) ?? []).length;
	if (systemCalls > osSystemCalls) unclassifiable = true;
	if (/\b[A-Za-z_]\w*\s*=\s*(?:os\s*\.\s*(?:system|popen)|subprocess\s*\.\s*\w+)\b/.test(script))
		unclassifiable = true;
	// Reuse the interpreter lexer so inert import/call text cannot shadow live aliases.
	let code = "";
	let interpolatedCode = "";
	for (let index = 0; index < script.length; ) {
		const isFString =
			(script[index] === "'" || script[index] === '"') &&
			/(?:^|[^\w])(?:[rR]?[fF]|[fF][rR])$/.test(script.slice(Math.max(0, index - 3), index));
		const fString = isFString ? pythonFStringExecutableCode(script, index) : undefined;
		const end = fString?.end ?? skipNoise(script, index, "py");
		if (end !== index) {
			const source = script.slice(index, end);
			if (fString) interpolatedCode += `;${fString.code};`;
			code += source.replace(/[^\n]/g, " ");
			index = end;
		} else {
			code += script[index];
			index++;
		}
	}
	code = code.replace(/\\\r?\n/g, " ");
	const callableCode = `${code}\n${interpolatedCode}`.replace(/\\\r?\n/g, " ");
	for (const imported of code.matchAll(/\bfrom\s+os\s+import\s+(?:\(([^)]*)\)|([^;\n]+))/g)) {
		const names = imported[1] ?? imported[2] ?? "";
		for (const name of names.matchAll(/(?:^|,)\s*(?:system(?:\s+as\s+([A-Za-z_]\w*))?|\*)\s*(?=,|$)/g)) {
			const importedName = name[1] ?? "system";
			if (new RegExp(`\\b${importedName}\\s*\\(`).test(callableCode)) unclassifiable = true;
		}
	}
	return { starts, unclassifiable };
}

function pythonSystemCommand(script: string, start: number): string | undefined {
	let index = start;
	while (/\s/.test(script[index] ?? "")) index++;
	const quote = script[index];
	if (quote !== "'" && quote !== '"') return undefined;
	const tripleQuote = script.startsWith(quote.repeat(3), index);
	index += tripleQuote ? 3 : 1;
	let value = "";
	let hasEscape = false;
	while (index < script.length) {
		if (script[index] === "\\") {
			hasEscape = true;
			index += 2;
			continue;
		}
		if (tripleQuote && script.startsWith(quote.repeat(3), index)) {
			index += 3;
			while (/\s/.test(script[index] ?? "")) index++;
			return !hasEscape && script[index] === ")" ? value : undefined;
		}
		if (!tripleQuote && script[index] === quote) {
			index++;
			while (/\s/.test(script[index] ?? "")) index++;
			return !hasEscape && script[index] === ")" ? value : undefined;
		}
		value += script[index];
		index++;
	}
	return undefined;
}

function collectPythonSystemWrites(
	script: string,
	targets: ExtractedTargets,
	depth: number,
	perlStartupConfigured: boolean,
): void {
	const calls = pythonSystemCallArguments(script);
	if (calls.unclassifiable) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	for (const start of calls.starts) {
		const payload = pythonSystemCommand(script, start);
		if (payload === undefined || depth >= 2) {
			targets.explicitMutation = true;
			targets.unknown = true;
			continue;
		}
		const nested = extractBashTargets({ command: payload }, depth + 1, perlStartupConfigured);
		for (const nestedPath of nested.paths) addPath(targets, nestedPath);
		if (nested.unknown) {
			targets.explicitMutation = true;
			targets.unknown = true;
		}
		if (nested.explicitMutation) targets.explicitMutation = true;
	}
}

function cleanInterpreterCodeWord(word: string): string | undefined {
	if (!word.startsWith("$'")) {
		const fullyQuoted = (/^'[^']*'$/.test(word) || /^"(?:\\.|[^"\\])*"$/.test(word)) && word.length >= 2;
		if (word.includes("$'") && !fullyQuoted) return undefined;
		return cleanShellWord(word);
	}
	if (word.length < 3 || !word.endsWith("'")) return undefined;

	let decoded = "";
	for (let index = 2; index < word.length - 1; index++) {
		const character = word[index] ?? "";
		if (character !== "\\") {
			if (character === "'") return undefined;
			decoded += character;
			continue;
		}
		const escapeCode = word[++index];
		if (escapeCode === undefined) return undefined;
		switch (escapeCode) {
			case "a":
				decoded += "\x07";
				break;
			case "b":
				decoded += "\b";
				break;
			case "e":
			case "E":
				decoded += "\x1b";
				break;
			case "f":
				decoded += "\f";
				break;
			case "n":
				decoded += "\n";
				break;
			case "r":
				decoded += "\r";
				break;
			case "t":
				decoded += "\t";
				break;
			case "v":
				decoded += "\v";
				break;
			case "\\":
			case "'":
			case '"':
			case "?":
				decoded += escapeCode;
				break;
			case "c": {
				const control = word[++index];
				if (control === undefined || control.charCodeAt(0) > 0x7f) return undefined;
				const code = control === "?" ? 0x7f : control.toUpperCase().charCodeAt(0) & 0x1f;
				if (code === 0) return undefined;
				decoded += String.fromCharCode(code);
				break;
			}
			case "x": {
				let digits = "";
				while (digits.length < 2 && /[\da-f]/i.test(word[index + 1] ?? "")) {
					digits += word[++index];
				}
				if (!digits) return undefined;
				const code = Number.parseInt(digits, 16);
				if (code === 0) return undefined;
				decoded += String.fromCharCode(code);
				break;
			}
			case "u":
			case "U": {
				const width = escapeCode === "u" ? 4 : 8;
				const digits = word.slice(index + 1, index + 1 + width);
				if (digits.length !== width || !new RegExp(`^[\\da-f]{${width}}$`, "i").test(digits)) return undefined;
				const code = Number.parseInt(digits, 16);
				if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
				decoded += String.fromCodePoint(code);
				index += width;
				break;
			}
			default: {
				if (!/[0-7]/.test(escapeCode)) return undefined;
				let digits = escapeCode;
				while (digits.length < 3 && /[0-7]/.test(word[index + 1] ?? "")) {
					digits += word[++index];
				}
				const code = Number.parseInt(digits, 8);
				if (code === 0 || code > 0xff) return undefined;
				decoded += String.fromCharCode(code);
				break;
			}
		}
	}
	return decoded;
}

function collectInterpreterOneLinerWrites(
	command: string,
	targets: ExtractedTargets,
	depth: number,
	perlStartupConfigured: boolean,
): void {
	const api = new RegExp(BASH_INTERPRETER_WRITE_API, "i");
	const names = new RegExp(
		`(?:^|[;&|\\n])\\s*(?:(?:if|then|else|elif|do|in|while|until)\\s+)*(?:!\\s+)?(?:\\w+=[^\\s]+\\s+)*(?:sudo\\s+)?${BASH_COMMAND_WRAPPER_SOURCE}(?:[^\\s;&|()]*\\/)?(?:busybox\\s+)?(python(?:\\d+(?:\\.\\d+)*)?|pypy(?:\\d+(?:\\.\\d+)*)?|node(?:js)?|bun|deno|ruby|jruby|perl|php(?:\\d+(?:\\.\\d+)*)?|lua(?:\\d+(?:\\.\\d+)*)?|bash|ash|sh|zsh|dash|ksh|fish)\\b`,
		"gi",
	);
	for (const match of command.matchAll(names)) {
		const start = (match.index ?? 0) + match[0].length;
		const tail = command.slice(start, interpreterStatementEnd(command, start));
		const words = shellWords(tail);
		const parts = words.map(cleanShellWord);
		const binary = (match[1] ?? "").toLowerCase();
		if (binary === "perl") {
			if (perlStartupConfigured) {
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
			// shellWords does not decode unquoted escapes in interpreter options.
			for (const escapeMatch of tail.matchAll(/\\/g)) {
				if (!shellSyntaxPosition(tail, escapeMatch.index)) continue;
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
		}
		const options = interpreterCodeOptions(binary);
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index] ?? "";
			// Module/debugger switches, including bundled -wM, run unscanned code.
			if (binary === "perl" && /^-[^eEImMd]*[mMd]/.test(part)) {
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
			let rawScript: string | undefined;
			const option = options.find(
				candidate =>
					part === candidate || (candidate.length === 2 && part.startsWith(candidate) && part.length > 2),
			);
			if (option && part === option) {
				rawScript = words[++index];
			} else if (option) {
				const rawWord = words[index] ?? "";
				rawScript = rawWord.startsWith("-") ? rawWord.slice(option.length) : part.slice(option.length);
			} else {
				const longOption = options.find(
					candidate => candidate.startsWith("--") && part.startsWith(`${candidate}=`),
				);
				if (!longOption) continue;
				rawScript = words[index]?.slice(longOption.length + 1);
			}
			if (rawScript === undefined) continue;
			// Node preload options (-r/--require) load external files that cannot be scanned,
			// so fail closed when encountered.
			if ((option === "-r" || option === "--require") && /^(?:node|bun)$/.test(binary)) {
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
			const script = cleanInterpreterCodeWord(rawScript);
			if (
				script === undefined ||
				(!rawScript.startsWith("$'") && shellWordHasExpansion(rawScript)) ||
				containsOpaqueInterpreterSource(script, binary)
			) {
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
			if (/^(?:bash|ash|sh|zsh|dash|ksh|fish)$/.test(binary)) {
				if (depth >= 2) {
					targets.explicitMutation = true;
					targets.unknown = true;
					return;
				}
				const nested = extractBashTargets({ command: script }, depth + 1, perlStartupConfigured);
				for (const nestedPath of nested.paths) addPath(targets, nestedPath);
				if (nested.unknown) targets.unknown = true;
				if (nested.explicitMutation) targets.explicitMutation = true;
				continue;
			}
			const language = /^(?:python|pypy)/.test(binary)
				? "py"
				: /^(?:node|bun|deno)$/.test(binary)
					? "js"
					: /^(?:ruby|jruby)$/.test(binary)
						? "ruby"
						: "perl";
			if (/^(?:python|pypy)/.test(binary)) {
				scanInterpreterWrites(script, "py", targets);
				if (
					interpreterCodeContainsWriteApi(script, "py", new RegExp(BASH_INTERPRETER_WRITE_API_EXCLUDING_OPEN, "i"))
				) {
					targets.explicitMutation = true;
					targets.unknown = true;
				}
				collectPythonSystemWrites(script, targets, depth, perlStartupConfigured);
				continue;
			}
			if (interpreterCodeContainsWriteApi(script, language, api)) {
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
		}
	}
}

function interpreterCodeOptions(binary: string): string[] {
	if (/^(?:python|pypy)/.test(binary)) return ["-c"];
	if (/^(?:node|bun)$/.test(binary)) return ["-r", "--require", "-e", "--eval", "-p", "--print"];
	if (binary === "deno") return ["eval", "-e", "--eval"];
	if (/^(?:ruby|jruby|perl|lua)/.test(binary)) return ["-e"];
	if (/^php/.test(binary)) return ["-r"];
	if (/^(?:bash|ash|sh|zsh|dash|ksh|fish)$/.test(binary)) return ["-c"];
	return [];
}

function containsOpaqueInterpreterSource(source: string, binary: string): boolean {
	return (
		(!/^(?:python|pypy)/.test(binary) && INTERPRETER_DYNAMIC_EXECUTION_RE.test(source)) ||
		INTERPRETER_FILESYSTEM_REQUIRE_RE.test(source) ||
		INTERPRETER_NONLITERAL_REQUIRE_RE.test(source) ||
		(/^php/.test(binary) && /\bassert\b/i.test(source)) ||
		(/^(?:bash|ash|sh|zsh|dash|ksh|fish)$/.test(binary) && SHELL_DOT_SOURCE_RE.test(source))
	);
}

function interpreterCodeContainsWriteApi(
	script: string,
	language: "py" | "js" | "ruby" | "perl",
	api?: RegExp,
): boolean {
	const apiAtStart = api ? new RegExp(`^(?:${api.source})`, "i") : undefined;
	// Reflective mutation of a stream object defeats the stdout/stderr write
	// exemption: the method that runs may write to a file. Fail closed instead.
	const streamMutated =
		INTERPRETER_OUTPUT_METHOD_ASSIGNMENT_RE.test(script) || INTERPRETER_OUTPUT_STREAM_MUTATION_RE.test(script);
	let index = 0;
	while (index < script.length) {
		if (language === "js" && script[index] === "`") {
			const template = readJavaScriptTemplate(script, index);
			if (
				!template ||
				template.expressions.some(expression => interpreterCodeContainsWriteApi(expression, "js", api))
			)
				return true;
			index = template.end;
			continue;
		}
		if (language === "py" || language === "js") {
			const next = skipNoise(script, index, language);
			if (next !== index) {
				const skipped = script.slice(index, next);
				const isInterpolated =
					language === "py" &&
					/(?:^|[^\w])(?:[rR]?[fF]|[fF][rR])$/.test(script.slice(Math.max(0, index - 3), index)) &&
					skipped.includes("{");
				if (isInterpolated && (api?.test(skipped) || PYTHON_DYNAMIC_EXECUTION_TOKEN_RE.test(skipped))) return true;
				index = next;
				continue;
			}
			if (language === "js" && script[index] === "/") {
				const end = skipJavaScriptRegex(script, index);
				if (end === undefined) return true;
				if (end !== index) {
					index = end;
					continue;
				}
			}
		} else {
			const next = skipOtherInterpreterNoise(script, index);
			if (next !== index) {
				const skipped = script.slice(index, next);
				if (language === "perl" && script[index] === '"' && /(?:^|[^\\])(?:\\\\)*[$@]/.test(skipped)) return true;
				if (language === "ruby" && script[index] !== "'" && skipped.includes("#{") && api?.test(skipped))
					return true;
				index = next;
				continue;
			}
		}
		if (INTERPRETER_OUTPUT_METHOD_ASSIGNMENT_RE.test(script.slice(index))) return true;
		if (language === "js" && script[index] === "\\") return true;
		if (language === "js" && javaScriptExposesConstructor(script, index)) return true;
		if (language === "py" && PYTHON_DYNAMIC_EXECUTION_IDENTIFIER_RE.test(script.slice(index))) return true;
		if (
			language === "js" &&
			!/[\w$]/.test(script[index - 1] ?? "") &&
			JAVASCRIPT_DYNAMIC_EXECUTION_IDENTIFIER_RE.test(script.slice(index))
		)
			return true;
		if (language === "js" && !/[\w$]/.test(script[index - 1] ?? "") && javaScriptLoadsOpaqueModule(script, index))
			return true;
		if (
			language === "js" &&
			!/[\w$]/.test(script[index - 1] ?? "") &&
			/^(?:process|Bun|globalThis|global|module)(?![\w$])/.test(script.slice(index))
		) {
			const access = script.slice(index).replace(/^(?:process|Bun|globalThis|global|module)\s*/, "");
			if (/^module\b/.test(script.slice(index)) && !/^\.\s*(?:filename|id|loaded)(?![\w$\\])/.test(access))
				return true;
			if (/^\.\s*(?:binding|_linkedBinding|getBuiltinModule)(?![\w$\\])/.test(access)) return true;
			// Only direct writes and scalar terminal properties avoid exposing a
			// mutable stream through aliases, arguments or computed access.
			if (!/^(?:\.\s*[A-Za-z_$][\w$]*(?![\w$\\])|\[\s*["'][^"'\\]+["']\s*\])/.test(access)) return true;
			if (
				/^\[\s*["'](?:process|Bun|globalThis|global|module|require|eval|Function|binding|_linkedBinding|getBuiltinModule)["']\s*\]/.test(
					access,
				)
			)
				return true;
			if (
				/^(?:\.\s*(?:stdout|stderr)\b|\[\s*["'`](?:stdout|stderr)["'`]\s*\])/.test(access) &&
				!/^[.]\s*(?:stdout|stderr)\s*\.\s*(?:write\s*\(|(?:isTTY|columns|rows|fd)(?![\w$\\]))/.test(access)
			)
				return true;
		}
		if (
			language === "perl" &&
			/^(?:use|no)\b/.test(script.slice(index)) &&
			!/[\p{ID_Continue}:'$@%&]$/u.test(script.slice(0, index))
		)
			return true;
		const perlOpen = language === "perl" ? /^(?:CORE::)?open\b/.exec(script.slice(index)) : null;
		if (perlOpen) {
			// Both `open(...)` and the list form `open H, MODE, EXPR` matter; only an
			// explicit read mode is safe, and an unparsed open fails closed.
			if (!isReadOnlyPerlOpen(script, index)) return true;
			index += perlOpen[0].length;
			continue;
		}
		if (apiAtStart?.test(script.slice(index))) {
			const outputWrite =
				!streamMutated &&
				/^\.\s*write\s*\(/.test(script.slice(index)) &&
				/\b(?:process|Bun)\s*\.\s*(?:stdout|stderr)\s*$/.test(script.slice(0, index));
			if (!outputWrite) return true;
		}
		index += 1;
	}
	return false;
}

/**
 * Perl `open` accepts two spellings — `open(H, MODE, EXPR)` and the list form
 * `open H, MODE, EXPR` — and only an explicit read mode is safe. Any other shape
 * (write/pipe modes, a variable mode, or an unparsed statement) fails closed.
 */
function isReadOnlyPerlOpen(script: string, index: number): boolean {
	const prefix = script.slice(0, index);
	// Custom functions and methods can ignore a read-looking mode operand.
	if (/[\p{ID_Continue}:'$@%&]$/u.test(prefix) || /(?:->|::|&)\s*(?:#[^\n]*\n\s*)*$/.test(prefix)) return false;
	const rest = script.slice(index);
	const open = /^(?:CORE::)?open\b/.exec(rest);
	if (!open) return false;
	const parenthesized = /^(?:CORE::)?open\s*\(/.exec(rest);
	const body = parenthesized ? rest.slice(parenthesized[0].length) : rest.slice(open[0].length);
	const delimiters: string[] = [];
	let stringChar = "";
	let modeStart = -1;
	let modeEnd = -1;
	let end = body.length;
	let closed = !parenthesized;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];

		if (stringChar) {
			if (ch === "\\" && i + 1 < body.length) {
				i++;
				continue;
			}
			if (ch === stringChar) stringChar = "";
			continue;
		}

		if (ch === "'" || ch === '"') {
			stringChar = ch;
			continue;
		}

		if (ch === "#" || ch === "`") return false;
		if (ch === "(" || ch === "[" || ch === "{") delimiters.push(ch);
		else if (ch === ")" || ch === "]" || ch === "}") {
			if (delimiters.length === 0) {
				if (ch !== ")" && (parenthesized || ch !== "}")) return false;
				end = i;
				closed = ch === ")" || !parenthesized;
				break;
			}
			if (delimiters.pop() !== ({ ")": "(", "]": "[", "}": "{" } as const)[ch]) return false;
		} else if (ch === ";" && delimiters.length === 0) {
			end = i;
			break;
		} else if (ch === "," && delimiters.length === 0) {
			if (modeStart < 0) modeStart = i + 1;
			else if (modeEnd < 0) modeEnd = i;
			else return false;
		}
	}

	if (!closed || delimiters.length !== 0 || stringChar || modeStart < 0) return false;
	if (
		!/^(?:(?:my|our|local)\s+)?[$*]?(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(body.slice(0, modeStart - 1).trim())
	)
		return false;
	if (modeEnd >= 0 && !body.slice(modeEnd + 1, end).trim()) return false;
	const modeArg = body.slice(modeStart, modeEnd < 0 ? end : modeEnd).trim();
	const quotedMode = /^(?:'((?:[^'\\]|\\\\)*)'|"((?:[^"\\$@]|\\\\)*)")$/.exec(modeArg);
	if (!quotedMode) return false;
	const mode = (quotedMode[1] ?? quotedMode[2]).trim();
	return mode.startsWith("<") && !mode.startsWith("<+") && !mode.includes("|");
}

function skipJavaScriptTrivia(script: string, index: number): number {
	while (index < script.length) {
		if (/\s/.test(script[index])) index += 1;
		else if (script.startsWith("//", index) || script.startsWith("/*", index)) index = skipNoise(script, index, "js");
		else break;
	}
	return index;
}

function javaScriptExposesConstructor(script: string, index: number): boolean {
	if (script[index] === ".") {
		const member = skipJavaScriptTrivia(script, index + 1);
		return /^constructor(?![\w$])/.test(script.slice(member));
	}
	if (script[index] !== "[") return false;
	const member = skipJavaScriptTrivia(script, index + 1);
	const quote = script[member];
	if (quote !== '"' && quote !== "'" && quote !== "`") return false;
	const end = quote === "`" ? readJavaScriptTemplate(script, member)?.end : skipNoise(script, member, "js");
	if (end === undefined) return true;
	const key = script.slice(member + 1, end - 1);
	if (
		key !== "constructor" &&
		!key.includes("\\") &&
		!(quote === "`" && key.includes("${")) &&
		script[skipJavaScriptTrivia(script, end)] === "]"
	)
		return false;
	let prefix = "";
	for (let cursor = 0; cursor < index; cursor++) {
		const next = skipNoise(script, cursor, "js");
		if (next !== cursor) {
			prefix += script[cursor] === "/" ? " " : '""';
			cursor = next - 1;
		} else if (script[cursor] === "/" || script[cursor] === "`") {
			const end =
				script[cursor] === "/" ? skipJavaScriptRegex(script, cursor) : readJavaScriptTemplate(script, cursor)?.end;
			if (end === undefined || end > index) return true;
			prefix += end === cursor ? "/" : '""';
			cursor = end === cursor ? cursor : end - 1;
		} else prefix += script[cursor];
	}
	prefix = prefix.trimEnd();
	return /(?:[\w$)\]}"'`]|\?\.)$/.test(prefix) && !/\b(?:return|yield|throw)$/.test(prefix);
}

function javaScriptLoadsOpaqueModule(script: string, index: number): boolean {
	const loader = /^(require|import|from)(?![\w$])/.exec(script.slice(index));
	if (!loader) return false;
	let cursor = skipJavaScriptTrivia(script, index + loader[0].length);
	const parenthesized = script[cursor] === "(";
	if (loader[1] === "from" && parenthesized) return false;
	if (parenthesized) cursor = skipJavaScriptTrivia(script, cursor + 1);
	if (script[cursor] !== '"' && script[cursor] !== "'") return loader[1] === "require" || parenthesized;
	const end = skipNoise(script, cursor, "js");
	const module = simpleLiteral(script.slice(cursor, end));
	if (module === null || (parenthesized && script[skipJavaScriptTrivia(script, end)] !== ")")) return true;
	return (
		/^(?:node:)?(?:process|module)$/.test(module) ||
		INTERPRETER_FILESYSTEM_REQUIRE_RE.test(`require(${JSON.stringify(module)})`)
	);
}

/** Ambiguous slash contexts fail closed rather than misreading regexp braces as template boundaries. */
function skipJavaScriptRegex(script: string, index: number): number | undefined {
	const prefix = script.slice(0, index).trimEnd();
	const previous = prefix.at(-1);
	const keyword =
		/(?:^|([^\w$]))(?:return|throw|case|yield|await|void|typeof|delete|in|of|instanceof|else|do|break|continue)$/.exec(
			prefix,
		);
	let beforeKeyword = "";
	if (keyword) {
		const end = keyword.index + (keyword[1]?.length ?? 0);
		for (let cursor = 0; cursor < end; cursor++) {
			const next = skipNoise(prefix, cursor, "js");
			if (next !== cursor) {
				if (prefix[cursor] !== "/") beforeKeyword = '"';
				cursor = next - 1;
			} else {
				if (prefix[cursor] === "/" || prefix[cursor] === "`") return undefined;
				if (!/\s/.test(prefix[cursor])) beforeKeyword = prefix[cursor];
			}
		}
	}
	let startsExpression =
		previous === undefined || /[([{=,:;!?&|*%~^<>]/.test(previous) || (keyword !== null && beforeKeyword !== ".");
	if (!startsExpression) {
		if (previous === ")") {
			const parentheses: number[] = [];
			let opening = -1;
			for (let cursor = 0; cursor < prefix.length; cursor++) {
				const next = skipNoise(prefix, cursor, "js");
				if (next !== cursor) {
					cursor = next - 1;
					continue;
				}
				if (prefix[cursor] === "`" || prefix[cursor] === "/") return undefined;
				if (prefix[cursor] === "(") parentheses.push(cursor);
				else if (prefix[cursor] === ")") opening = parentheses.pop() ?? -1;
			}
			const beforeOpening = prefix.slice(0, opening).trimEnd();
			if (opening < 0 || beforeOpening.endsWith("*/")) return undefined;
			startsExpression = /(?:^|[;{}])\s*(?:else\s+)?(?:if|while|for|with|switch|catch)$/.test(beforeOpening);
			if (!startsExpression && /\b(?:if|while|for|with|switch|catch)$/.test(beforeOpening)) return undefined;
		}
		if (!startsExpression) return /[\w$\])'"\x60]/.test(previous ?? "") ? index : undefined;
	}
	let characterClass = false;
	for (let cursor = index + 1; cursor < script.length; cursor++) {
		const character = script[cursor];
		if (/[\n\r\u2028\u2029]/.test(character)) return undefined;
		if (character === "\\") cursor += 1;
		else if (character === "[") characterClass = true;
		else if (character === "]") characterClass = false;
		else if (character === "/" && !characterClass) {
			cursor += 1;
			while (/[a-z]/i.test(script[cursor] ?? "")) cursor += 1;
			return cursor;
		}
	}
	return undefined;
}

function readJavaScriptTemplate(
	script: string,
	index: number,
	depth = 0,
): { end: number; expressions: string[] } | undefined {
	if (depth >= 8) return undefined;
	const expressions: string[] = [];
	let cursor = index + 1;
	while (cursor < script.length) {
		if (script[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (script[cursor] === "`") return { end: cursor + 1, expressions };
		if (script.startsWith("${", cursor)) {
			const start = cursor + 2;
			cursor = start;
			let braces = 1;
			while (cursor < script.length && braces > 0) {
				if (script[cursor] === "`") {
					const nested = readJavaScriptTemplate(script, cursor, depth + 1);
					if (!nested) return undefined;
					cursor = nested.end;
					continue;
				}
				const next = skipNoise(script, cursor, "js");
				if (next !== cursor) {
					cursor = next;
					continue;
				}
				if (script[cursor] === "/") {
					const end = skipJavaScriptRegex(script, cursor);
					if (end === undefined) return undefined;
					if (end !== cursor) {
						cursor = end;
						continue;
					}
				}
				if (script[cursor] === "{") braces += 1;
				else if (script[cursor] === "}") braces -= 1;
				cursor += 1;
			}
			if (braces !== 0) return undefined;
			expressions.push(script.slice(start, cursor - 1));
			continue;
		}
		cursor += 1;
	}
	return undefined;
}

function skipOtherInterpreterNoise(script: string, index: number): number {
	const character = script[index] ?? "";
	if (character === "#") {
		const end = script.indexOf("\n", index);
		return end < 0 ? script.length : end;
	}
	if (character !== "'" && character !== '"' && character !== "`") return index;
	let cursor = index + 1;
	while (cursor < script.length) {
		if (script[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (script[cursor] === character) return cursor + 1;
		cursor += 1;
	}
	return script.length;
}

function collectSedScriptWrites(command: string, targets: ExtractedTargets): void {
	for (const match of command.matchAll(BASH_SED_COMMAND_RE)) {
		const matchIndex = match.index ?? 0;
		if (!shellSyntaxPosition(command, matchIndex)) continue;
		const words = shellWords(match[1] ?? "").map(cleanShellWord);
		const parsed = sedScriptOperands(words);
		if (parsed.unknown) {
			targets.explicitMutation = true;
			targets.unknown = true;
		}
		for (const script of parsed.scripts) {
			const writePath = sedScriptWritePath(script);
			if (writePath === undefined) continue;
			targets.explicitMutation = true;
			if (writePath && !isDeviceSinkPath(writePath)) addPath(targets, writePath);
			else if (!writePath) targets.unknown = true;
		}
	}
}

function sedScriptOperands(words: string[]): { scripts: string[]; unknown: boolean } {
	const scripts: string[] = [];
	let hasBareScript = false;
	let unknown = false;
	for (let index = 0; index < words.length; index++) {
		const word = words[index] ?? "";
		if (!word) continue;
		if (word === "--") {
			if (!hasBareScript && scripts.length === 0 && words[index + 1]) scripts.push(words[index + 1] ?? "");
			break;
		}
		if (word === "-e" || word === "--expression") {
			const script = words[index + 1];
			if (script) scripts.push(script);
			index += 1;
			continue;
		}
		if (word.startsWith("--expression=")) {
			scripts.push(word.slice("--expression=".length));
			continue;
		}
		if (word.startsWith("-e") && word.length > 2) {
			scripts.push(word.slice(2));
			continue;
		}
		if (word === "-f" || word === "--file") {
			// The script contents are not present in the command, so their write behavior is opaque.
			unknown = true;
			index += 1;
			continue;
		}
		if (word.startsWith("--file=") || (word.startsWith("-f") && word.length > 2)) {
			unknown = true;
			continue;
		}
		if (word === "-l" || word === "--line-length") {
			index += 1;
			continue;
		}
		if (word.startsWith("-")) continue;
		if (!hasBareScript && scripts.length === 0) {
			scripts.push(word);
			hasBareScript = true;
		}
	}
	return { scripts, unknown };
}

function shellSyntaxPosition(command: string, targetIndex: number, allowComment = false): boolean {
	let quote: "'" | '"' | null = null;
	let inComment = false;
	let previous = "";
	for (let index = 0; index < targetIndex; index++) {
		const character = command[index] ?? "";
		if (inComment) {
			if (character === "\n") {
				inComment = false;
				previous = character;
			}
			continue;
		}
		if (quote === "'") {
			if (character === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (character === "\\") {
				index++;
				continue;
			}
			if (character === '"') quote = null;
			continue;
		}
		if (character === "\\") {
			index++;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "#" && (previous === "" || /\s/.test(previous) || ";|&()".includes(previous))) {
			inComment = true;
			continue;
		}
		previous = character;
	}
	if (command[targetIndex] === "\n" && inComment) return quote === null;
	return quote === null && (allowComment || !inComment);
}

function awkRegexCanStart(tokens: AwkToken[]): boolean {
	const previous = tokens.at(-1);
	if (!previous) return true;
	if (previous.kind === "separator") return true;
	return (
		(previous.kind === "symbol" &&
			["{", "(", "[", ",", "?", ":", "=", "==", "!=", "!", "&&", "||", "~", "!~"].includes(previous.value)) ||
		(previous.kind === "word" && ["print", "printf", "return"].includes(previous.value))
	);
}

function awkRegexEnd(program: string, start: number): number | undefined {
	let inCharacterClass = false;
	for (let index = start + 1; index < program.length; index++) {
		const character = program[index] ?? "";
		if (character === "\\") {
			index++;
			continue;
		}
		if (character === "[" && !inCharacterClass) inCharacterClass = true;
		else if (character === "]" && inCharacterClass) inCharacterClass = false;
		else if (character === "/" && !inCharacterClass) return index + 1;
		else if (character === "\n") return undefined;
	}
	return undefined;
}

interface AwkToken {
	kind: "word" | "string" | "symbol" | "separator";
	value: string;
	unsafeEscapes?: boolean;
}

function tokenizeAwkProgram(program: string): { tokens: AwkToken[]; balanced: boolean } {
	const tokens: AwkToken[] = [];
	let balanced = true;
	for (let index = 0; index < program.length; ) {
		const character = program[index] ?? "";
		if (character === "\n") {
			tokens.push({ kind: "separator", value: character });
			index++;
			continue;
		}
		if (/\s/.test(character)) {
			index++;
			continue;
		}
		if (character === "#") {
			while (index < program.length && program[index] !== "\n") index++;
			continue;
		}
		if (character === '"') {
			let value = "";
			let unsafeEscapes = false;
			let closed = false;
			index++;
			while (index < program.length) {
				const next = program[index] ?? "";
				if (next === "\\") {
					const escapedChar = program[index + 1] ?? "";
					if (escapedChar === "\\" || escapedChar === '"') {
						value += escapedChar;
						index += 2;
						continue;
					}
					switch (escapedChar) {
						case "a":
							value += "\u0007";
							index += 2;
							continue;
						case "b":
							value += "\b";
							index += 2;
							continue;
						case "f":
							value += "\f";
							index += 2;
							continue;
						case "n":
							value += "\n";
							index += 2;
							continue;
						case "r":
							value += "\r";
							index += 2;
							continue;
						case "t":
							value += "\t";
							index += 2;
							continue;
						case "v":
							value += "\u000b";
							index += 2;
							continue;
					}
					if (/[0-7]/.test(escapedChar)) {
						let end = index + 1;
						while (end < program.length && end < index + 4 && /[0-7]/.test(program[end] ?? "")) end++;
						value += String.fromCharCode(Number.parseInt(program.slice(index + 1, end), 8));
						index = end;
						continue;
					}
					if (escapedChar === "x") {
						let end = index + 2;
						while (end < program.length && /[\da-f]/i.test(program[end] ?? "")) end++;
						const hex = program.slice(index + 2, end);
						const codePoint = hex ? Number.parseInt(hex, 16) : Number.NaN;
						if (hex && codePoint <= 0xffff) value += String.fromCharCode(codePoint);
						else unsafeEscapes = true;
						index = end;
						continue;
					}
					unsafeEscapes = true;
					if (escapedChar) value += escapedChar;
					index += escapedChar ? 2 : 1;
					continue;
				}
				if (next === '"') {
					closed = true;
					index++;
					break;
				}
				value += next;
				index++;
			}
			if (!closed) balanced = false;
			tokens.push({ kind: "string", value, unsafeEscapes });
			continue;
		}
		if (character === "/" && awkRegexCanStart(tokens)) {
			const end = awkRegexEnd(program, index);
			if (end === undefined) balanced = false;
			else {
				tokens.push({ kind: "symbol", value: "regex" });
				index = end;
				continue;
			}
		}
		if (/[A-Za-z_]/.test(character)) {
			const start = index++;
			while (/[A-Za-z0-9_]/.test(program[index] ?? "")) index++;
			tokens.push({ kind: "word", value: program.slice(start, index) });
			continue;
		}
		if (character === ";") {
			tokens.push({ kind: "separator", value: character });
			index++;
			continue;
		}
		const pair = program.slice(index, index + 2);
		const operator = [">>", ">=", "==", "!=", "<=", "&&", "||", "!~", "++", "--"].includes(pair) ? pair : character;
		tokens.push({ kind: "symbol", value: operator });
		index += operator.length;
	}
	return { tokens, balanced };
}

interface AwkProgramSource {
	source: string;
	expanded: boolean;
}

function shellWordHasExpansion(word: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < word.length; index++) {
		const character = word[index] ?? "";
		if (quote === "'") {
			if (character === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (character === "\\") {
				index++;
				continue;
			}
			if (character === '"') quote = null;
			else if (character === "$" || character === "`") return true;
			continue;
		}
		if (character === "\\") {
			index++;
			continue;
		}
		if (character === "'" || character === '"') quote = character;
		else if (character === "$" || character === "`") return true;
	}
	return quote !== null;
}

function awkPrograms(words: string[]): { programs: AwkProgramSource[]; unknown: boolean } {
	const programs: AwkProgramSource[] = [];
	const noOperandOptions = new Set([
		"-b",
		"-c",
		"-C",
		"-g",
		"-h",
		"-M",
		"-n",
		"-N",
		"-O",
		"-P",
		"-r",
		"-s",
		"-S",
		"-t",
		"-V",
		"--characters-as-bytes",
		"--csv",
		"--help",
		"--lint",
		"--lint-no-ext",
		"--lint-old",
		"--posix",
		"--sandbox",
		"--traditional",
		"--version",
	]);
	let unknown = false;
	let hasFileProgram = false;
	let hasSourceOption = false;
	const programSource = (raw: string): AwkProgramSource => ({
		source: cleanShellWord(raw),
		expanded: shellWordHasExpansion(raw),
	});
	const operand = (index: number): string | undefined => {
		const next = words[index + 1];
		if (!next) {
			unknown = true;
			return undefined;
		}
		return next;
	};
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (!word) continue;
		if (/^(?:\d+)?(?:>>?|<<<?|&>)/.test(word)) {
			if (/^(?:\d+)?(?:>>?|<<<?)$/.test(word)) index++;
			continue;
		}
		const part = cleanShellWord(word);
		if (part === "--") {
			if (hasFileProgram || hasSourceOption) break;
			const program = words[index + 1];
			if (!program) unknown = true;
			else programs.push(programSource(program));
			break;
		}
		if (part === "-e" || part === "--source") {
			const program = operand(index);
			if (program) programs.push(programSource(program));
			hasSourceOption = true;
			index++;
			continue;
		}
		if (part.startsWith("--source=")) {
			programs.push(programSource(part.slice("--source=".length)));
			hasSourceOption = true;
			continue;
		}
		if (part === "-v" || part === "--assign" || part === "-F" || part === "--field-separator") {
			if (!operand(index)) continue;
			index++;
			continue;
		}
		if (part === "-W") {
			const extension = operand(index);
			if (extension !== "version" && extension !== "lint" && extension !== "posix") {
				unknown = true;
				break;
			}
			index++;
			continue;
		}
		if (part.startsWith("-W")) {
			const extension = part.slice(2);
			if (extension !== "version" && extension !== "lint" && extension !== "posix") {
				unknown = true;
				break;
			}
			continue;
		}
		if (part.startsWith("--assign=") || part.startsWith("--field-separator=")) continue;
		if (part === "-f" || part === "--file" || part === "-E") {
			if (!operand(index)) continue;
			hasFileProgram = true;
			index++;
			continue;
		}
		if (part.startsWith("--file=") || (part.startsWith("-f") && part.length > 2)) {
			hasFileProgram = true;
			continue;
		}
		if (part.startsWith("-e") && part.length > 2) {
			programs.push(programSource(part.slice(2)));
			hasSourceOption = true;
			continue;
		}
		if (part.startsWith("-v") && part.length > 2) continue;
		if (part.startsWith("-F") && part.length > 2) continue;
		if (part.startsWith("-") && noOperandOptions.has(part)) continue;
		if (part.startsWith("-") && /^-[bcCghMnNPrStV]+$/.test(part)) continue;
		if (part.startsWith("-")) {
			unknown = true;
			break;
		}
		if (hasFileProgram || hasSourceOption) break;
		programs.push(programSource(word));
		break;
	}
	if (hasFileProgram) unknown = true;
	return { programs, unknown };
}

function analyzeAwkProgram(program: string): { paths: string[]; unknown: boolean } {
	const { tokens, balanced } = tokenizeAwkProgram(program);
	const paths: string[] = [];
	let unknown =
		!balanced ||
		tokens.some(
			(token, index) => token.kind === "word" && token.value === "system" && tokens[index + 1]?.value === "(",
		);
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let statementStart = true;
	let pendingControlParen = false;
	const controlParens: boolean[] = [];
	let printStatement: { braceDepth: number; parenDepth: number; bracketDepth: number } | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (token.kind === "separator") {
			if (parenDepth === 0 && bracketDepth === 0) {
				printStatement = undefined;
				statementStart = true;
				pendingControlParen = false;
			}
			continue;
		}
		if (token.kind === "string" || token.kind === "word") {
			if (token.kind === "word" && statementStart && (token.value === "print" || token.value === "printf")) {
				printStatement = { braceDepth, parenDepth, bracketDepth };
				statementStart = false;
				pendingControlParen = false;
				continue;
			}
			if (token.kind === "word" && statementStart && ["for", "if", "while"].includes(token.value)) {
				pendingControlParen = true;
				statementStart = false;
				continue;
			}
			if (token.kind === "word" && statementStart && ["do", "else"].includes(token.value)) {
				statementStart = true;
				pendingControlParen = false;
				continue;
			}
			statementStart = false;
			pendingControlParen = false;
			continue;
		}
		if (token.value === "{") {
			braceDepth++;
			printStatement = undefined;
			statementStart = true;
			pendingControlParen = false;
			continue;
		}
		if (token.value === "}") {
			braceDepth--;
			if (braceDepth < 0) unknown = true;
			printStatement = undefined;
			statementStart = true;
			pendingControlParen = false;
			continue;
		}
		if (token.value === "(") {
			controlParens.push(pendingControlParen);
			pendingControlParen = false;
			parenDepth++;
			statementStart = false;
			continue;
		}
		if (token.value === ")") {
			parenDepth--;
			if (parenDepth < 0) unknown = true;
			statementStart = controlParens.pop() ?? false;
			continue;
		}
		if (token.value === "[") {
			bracketDepth++;
			statementStart = false;
			continue;
		}
		if (token.value === "]") {
			bracketDepth--;
			if (bracketDepth < 0) unknown = true;
			statementStart = false;
			continue;
		}
		if (token.value === ">" || token.value === ">>") {
			if (
				printStatement &&
				braceDepth === printStatement.braceDepth &&
				parenDepth === printStatement.parenDepth &&
				bracketDepth === printStatement.bracketDepth
			) {
				const destination = tokens[index + 1];
				const trailing = tokens[index + 2];
				if (
					destination?.kind !== "string" ||
					destination.unsafeEscapes ||
					(destination.value !== "" && trailing && trailing.kind !== "separator" && trailing.value !== "}")
				) {
					unknown = true;
				} else if (destination.value) {
					paths.push(destination.value);
				} else {
					unknown = true;
				}
			}
			statementStart = false;
			continue;
		}
		if (token.value === "|") {
			// AWK pipe I/O executes a command; print, printf, and getline effects are opaque.
			unknown = true;
			statementStart = false;
			continue;
		}
		if (token.value === ";" && parenDepth === 0 && bracketDepth === 0) {
			printStatement = undefined;
			statementStart = true;
			pendingControlParen = false;
			continue;
		}
		statementStart = false;
		pendingControlParen = false;
	}
	if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0 || controlParens.length > 0) unknown = true;
	return { paths, unknown };
}

function collectAwkProgramWrites(command: string, targets: ExtractedTargets): void {
	for (const match of command.matchAll(BASH_AWK_COMMAND_RE)) {
		const matchIndex = match.index ?? 0;
		if (!shellSyntaxPosition(command, matchIndex)) continue;
		const matchEnd = matchIndex + match[0].length;
		const { programs, unknown } = awkPrograms(shellWords(match[1] ?? ""));
		if (!shellSyntaxPosition(command, matchEnd, true) || unknown) {
			targets.explicitMutation = true;
			targets.unknown = true;
		}
		for (const program of programs) {
			if (program.expanded) {
				targets.explicitMutation = true;
				targets.unknown = true;
			}
			const analyzed = analyzeAwkProgram(program.source);
			if (analyzed.unknown) {
				targets.explicitMutation = true;
				targets.unknown = true;
			}
			for (const destination of analyzed.paths) {
				targets.explicitMutation = true;
				if (!isDeviceSinkPath(destination)) addPath(targets, destination);
			}
		}
	}
}

function hasPerlStartupAssignment(dequotedView: string): boolean {
	return commandListSegments(dequotedView.replace(/([<>])&(?=\s*(?:\d|-))/g, "$1")).some(segment => {
		const command = commandPositionWords(segment)[0];
		if (command && ["export", "declare", "typeset", "local", "readonly"].includes(command))
			return /(?:^|\s)PERL5(?:OPT|DB)[=_]/.test(segment);
		let operand = false;
		let wrapper = false;
		let env = false;
		for (const word of segment.trim().split(/\s+/)) {
			if (operand) {
				operand = false;
				continue;
			}
			if (SHELL_REDIRECTION_TOKEN_RE.test(word)) {
				operand = /^\d*[<>]+$/.test(word);
				continue;
			}
			if (SHELL_RESERVED_PREFIX_WORDS.has(word)) continue;
			if (SHELL_COMMAND_WRAPPER_WORDS.has(word) || word === "env") {
				wrapper = true;
				env ||= word === "env";
				continue;
			}
			if (wrapper && word.startsWith("-")) {
				operand = ["-n", "-u", "--unset", "-C", "--chdir", "-a", "--argv0"].includes(word);
				continue;
			}
			if (env && /^PERL5(?:OPT|DB)[=_]/.test(word)) return true;
			if (!/^\w+=/.test(word)) break;
			if (/^PERL5(?:OPT|DB)=/.test(word)) return true;
		}
		return false;
	});
}

function extractBashTargets(args: unknown, depth = 0, perlStartupConfigured = false): ExtractedTargets {
	const record = getRecord(args);
	const command = safeString(record?.command);
	const env = getRecord(record?.env);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	if (!command.trim()) {
		targets.unknown = true;
		return targets;
	}
	const heredoc = maskHeredocBodies(command);
	const scanned = maskQuotedSpans(heredoc.masked);
	perlStartupConfigured ||=
		Boolean(env?.PERL5OPT || env?.PERL5DB || process.env.PERL5OPT || process.env.PERL5DB) ||
		hasPerlStartupAssignment(scanned.dequoted);
	// A literal `sh|bash|zsh -c '<script>'` payload is a real command list. Its
	// mutations never match the top-level patterns, so recurse into it; anything
	// deeper than a bounded depth is not statically analyzable and fails closed.
	for (const match of command.matchAll(BASH_NESTED_SHELL_RE)) {
		if (depth >= 2) {
			targets.explicitMutation = true;
			targets.unknown = true;
			break;
		}
		const nested = extractBashTargets({ command: match[2] ?? match[4] ?? "" }, depth + 1, perlStartupConfigured);
		for (const nestedPath of nested.paths) addPath(targets, nestedPath);
		if (nested.unknown) targets.unknown = true;
		if (nested.explicitMutation) targets.explicitMutation = true;
	}
	// `$(...)` / backticks are a nested command list, exactly like `sh -c`: the
	// statement anchors below (`^`, `;`, `&`, `|`, newline) never see inside one,
	// so `echo "$(rm -rf src/x.ts)"` would otherwise scan clean. Heredoc masking
	// removes literal data-consumer bodies first; the extractor then ignores
	// inert `#` tails without touching quote/escape bytes needed by extraction.
	for (const substitution of extractSubstitutionBodies(heredoc.masked)) {
		if (depth >= 2 || !substitution.balanced) {
			targets.explicitMutation = true;
			targets.unknown = true;
			break;
		}
		const nested = extractBashTargets({ command: substitution.body }, depth + 1, perlStartupConfigured);
		for (const nestedPath of nested.paths) addPath(targets, nestedPath);
		if (nested.unknown) targets.unknown = true;
		if (nested.explicitMutation) targets.explicitMutation = true;
	}
	// Heredoc bodies fed to data consumers are inert document payloads; mask them
	// so spec/plan text cannot fake redirections. Script-consumer bodies survive
	// the mask and are still scanned as live code below.
	if (heredoc.opaqueExpansion || heredoc.mutatingConsumer) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	// Nested scripts were read from the raw text above. Redirection extraction
	// uses the quote-preserving syntax view; command extraction uses its
	// dequoted executable-word view so quoted operands and split command words
	// remain visible without turning prose into syntax.
	if (scanned.unmodeled) {
		// A live substitution construct we cannot balance (for example a
		// `case` pattern whose `)` is not the substitution close) must never
		// silently hide a mutation from the scanner.
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	if (BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE.test(heredoc.masked)) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	// `exec 1<>file` rebinds a descriptor, so a later `>/dev/null` may not reach the device at all.
	if (BASH_EXEC_REDIRECT_RE.test(scanned.masked)) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	for (const match of scanned.masked.matchAll(BASH_EXTENDED_WRITE_RE)) {
		targets.explicitMutation = true;
		const cleaned = cleanShellWord(match[1] ?? "");
		if (!cleaned) targets.unknown = true;
		else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
	}
	for (const match of scanned.masked.matchAll(BASH_DD_OUTPUT_RE)) {
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
	for (const match of scanned.dequoted.matchAll(BASH_IN_PLACE_MUTATION_COMMAND_RE)) {
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		const hasInPlaceFlag = parts.some(part => /^-.*i/.test(part));
		if (!hasInPlaceFlag) continue;
		targets.explicitMutation = true;
		const target = [...parts].reverse().find(part => part && !part.startsWith("-"));
		if (target) addPath(targets, target);
		else targets.unknown = true;
	}
	for (const match of scanned.masked.matchAll(BASH_MUTATION_COMMAND_RE)) {
		const redirected = match[2]?.trim();
		if (!redirected) continue;
		targets.explicitMutation = true;
		const cleaned = cleanShellWord(redirected);
		// A capture that dequotes to nothing (e.g. `>" src.ts"`) is a truncated parse, not a safe no-op.
		if (!cleaned) targets.unknown = true;
		else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
	}
	for (const match of scanned.dequoted.matchAll(BASH_MUTATION_COMMAND_RE)) {
		// Redirections are extracted from the quote-preserving syntax view above.
		// The dequoted view exists so quote-split command words (`r"m"`) and
		// quoted operands (`rm "src/product.ts"`) still reach this command branch.
		if (match[2]) continue;
		targets.explicitMutation = true;
		const parts = shellWords(match[1] ?? "");
		const commandName = match[0]?.match(BASH_MUTATION_COMMAND_NAME_RE)?.[1]?.toLowerCase();
		const chmodModeIndex =
			commandName === "chmod" ? parts.findIndex(part => BASH_CHMOD_MODE_RE.test(cleanShellWord(part))) : -1;
		let targetParts = parts;
		if (
			commandName === "cp" ||
			commandName === "mv" ||
			commandName === "install" ||
			commandName === "truncate" ||
			commandName === "ln"
		) {
			targetParts = parts.slice(-1);
		} else if (commandName === "chmod" && chmodModeIndex >= 0) {
			targetParts = parts.filter((_part, index) => index !== chmodModeIndex);
		}
		let extractedTarget = false;
		for (const part of targetParts) {
			const cleaned = cleanShellWord(part);
			if (!cleaned || cleaned.startsWith("-")) continue;
			// Redirection/heredoc operator words (`>/dev/null`, `<<'DOC'`, `2>&1`) are
			// not argument paths; their targets are captured by the redirect scanners.
			if (/^\d*[<>]/.test(cleaned)) continue;
			addPath(targets, cleaned);
			extractedTarget = true;
		}
		// A recognized mutator with no attributable operand is not a safe no-op:
		// quote masking, unsupported expansions, and option-only invocations all
		// fail closed rather than allowing a targetless mutation through planning.
		if (!extractedTarget) targets.unknown = true;
	}
	// `sed w file` and `s///w file` write without `-i`. `awk 'print > "file"'`
	// writes inside the program, which is not a shell redirection.
	collectInterpreterOneLinerWrites(heredoc.masked, targets, depth, perlStartupConfigured);
	collectSedScriptWrites(heredoc.masked, targets);
	collectAwkProgramWrites(heredoc.masked, targets);
	return targets;
}
/**
 * Read-only github ops extract no mutation. Every other op fails closed during
 * planning: remote push, PR creation, and worktree/config writes are not a
 * filesystem path the planning allowlist can clear.
 */
function extractGithubTargets(args: unknown): ExtractedTargets {
	if (isGithubReadOnlyArgs(args)) return { paths: [], unknown: false };
	return { paths: [], unknown: true, explicitMutation: true };
}

function simpleLiteral(raw: string): string | null {
	const trimmed = raw.trim();
	const quote = trimmed[0];
	if ((quote !== "'" && quote !== '"') || trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) return null;
	const body = trimmed.slice(1, -1);
	return /[\\\n${]/.test(body) || body.includes(quote) ? null : body;
}

function pythonFStringContainsDynamicExecution(code: string, start: number, end: number): boolean {
	const source = code.slice(start, end);
	const isFString = /(?:^|[^\w])(?:[rR]?[fF]|[fF][rR])$/.test(code.slice(Math.max(0, start - 3), start));
	return isFString && source.includes("{") && PYTHON_DYNAMIC_EXECUTION_TOKEN_RE.test(source);
}

function skipNoise(code: string, index: number, language: "py" | "js"): number {
	if (language === "py" && (code.startsWith('"""', index) || code.startsWith("'''", index))) {
		const quote = code.slice(index, index + 3);
		let cursor = index + 3;
		while (cursor < code.length && !code.startsWith(quote, cursor)) cursor += code[cursor] === "\\" ? 2 : 1;
		return Math.min(code.length, cursor + 3);
	}
	const character = code[index] ?? "";
	if (character === "'" || character === '"') {
		let cursor = index + 1;
		while (cursor < code.length && code[cursor] !== character) cursor += code[cursor] === "\\" ? 2 : 1;
		return Math.min(code.length, cursor + 1);
	}
	if (
		(language === "py" && character === "#") ||
		(language === "js" && character === "/" && code[index + 1] === "/")
	) {
		const end = language === "js" ? code.slice(index).search(/[\n\r\u2028\u2029]/) : code.slice(index).indexOf("\n");
		return end < 0 ? code.length : index + end;
	}
	if (language === "js" && character === "/" && code[index + 1] === "*") {
		const end = code.indexOf("*/", index + 2);
		return end < 0 ? code.length : end + 2;
	}
	return index;
}

function readArg(code: string, index: number): { raw: string; end: number } | null {
	let cursor = index;
	while (/\s/.test(code[cursor] ?? "")) cursor += 1;
	if (cursor >= code.length || code[cursor] === ")") return null;
	const start = cursor;
	let depth = 0;
	while (cursor < code.length) {
		const character = code[cursor];
		if (character === "(") depth += 1;
		else if ((character === "," || character === ")") && depth === 0) break;
		else if (character === ")") depth -= 1;
		else if (character === "'" || character === '"') {
			const quote = character;
			cursor += 1;
			while (cursor < code.length && code[cursor] !== quote) cursor += code[cursor] === "\\" ? 2 : 1;
		}
		cursor += 1;
	}
	const raw = code.slice(start, cursor).trim();
	return raw.length > 0 ? { raw, end: cursor } : null;
}

/** Omitted mode is Python's default `"r"`. A non-literal mode cannot be proved read-only. */
function modeWrites(raw: string | undefined): boolean | null {
	if (raw === undefined) return false;
	const literal = simpleLiteral(raw);
	return literal === null ? null : /[wax+]/.test(literal);
}

const PY_OS_MUTATORS = new Set(
	"remove unlink rename replace rmtree move copy copy2 copyfile symlink link mkdir makedirs rmdir truncate open".split(
		" ",
	),
);
/** Copy and rename write the destination, not only the source. */
const TWO_ARG_MUTATORS = new Set(
	"rename replace move copy copy2 copyfile symlink link renameSync copyFileSync".split(" "),
);
const JS_FS_MUTATORS = new Set(
	"writeFileSync writeFile appendFileSync appendFile rmSync unlinkSync renameSync copyFileSync mkdirSync openSync".split(
		" ",
	),
);

function nextCallArg(code: string, end: number): { raw: string; end: number } | null {
	let cursor = end;
	while (/\s/.test(code[cursor] ?? "")) cursor += 1;
	if (code[cursor] !== ",") return null;
	return readArg(code, cursor + 1);
}

function openModeWrites(code: string, first: { raw: string; end: number }): boolean | null {
	let cursor = first.end;
	let positionalIndex = 1;
	let mode: string | undefined;
	let unknownMode = false;
	while (cursor < code.length) {
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] !== ",") break;
		const argument = readArg(code, cursor + 1);
		if (!argument) break;
		const raw = argument.raw.trim();
		if (raw.startsWith("*") || raw.startsWith("**")) {
			unknownMode = true;
		} else {
			const keyword = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(raw);
			if (keyword?.[1] === "mode") {
				if (mode !== undefined) unknownMode = true;
				else mode = keyword[2];
			} else if (!keyword && positionalIndex === 1) {
				if (mode !== undefined) unknownMode = true;
				else mode = raw;
			}
		}
		positionalIndex += 1;
		cursor = argument.end;
	}
	if (unknownMode) return null;
	return modeWrites(mode);
}

/** Whitespace or a backslash-newline may sit before an attribute (`shutil .copy`). */
function skipCallGap(code: string, index: number): number {
	let cursor = index;
	while (cursor < code.length) {
		const character = code[cursor] ?? "";
		if (/\s/.test(character)) {
			cursor += 1;
			continue;
		}
		if (character === "\\" && code[cursor + 1] === "\n") {
			cursor += 2;
			continue;
		}
		if (character === "\\" && code[cursor + 1] === "\r" && code[cursor + 2] === "\n") {
			cursor += 3;
			continue;
		}
		break;
	}
	return cursor;
}

function literalWrite(targets: ExtractedTargets, raw: string | undefined, write: boolean | null): void {
	if (write === false) return;
	targets.explicitMutation = true;
	const literal = raw === undefined ? null : simpleLiteral(raw);
	if (write === null || literal === null || literal.length === 0) {
		targets.unknown = true;
		return;
	}
	addPath(targets, literal);
}

/** Arguments of one Path() call, through its own closing parenthesis. */
function readPathConstructor(code: string, argAt: number): { parts: string[]; after: number } | null {
	let cursor = argAt;
	const parts: string[] = [];
	while (cursor < code.length) {
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] === ")") return { parts, after: cursor + 1 };
		const argument = readArg(code, cursor);
		if (!argument) return null;
		parts.push(argument.raw);
		cursor = argument.end;
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] === ",") {
			cursor += 1;
			continue;
		}
		if (code[cursor] === ")") return { parts, after: cursor + 1 };
		return null;
	}
	return null;
}

/** pathlib keeps the last absolute segment. A non-literal segment is an unresolved receiver. */
function literalPathReceiver(parts: string[]): string | null {
	if (parts.length === 0) return ".";
	let joined = "";
	for (const part of parts) {
		const literal = simpleLiteral(part);
		if (literal === null) return null;
		if (path.isAbsolute(literal)) joined = literal;
		else joined = joined ? path.join(joined, literal) : literal;
	}
	return joined.length === 0 ? "." : joined;
}

/** `Path.open()` defaults to read mode; a dynamic mode cannot be proven read-only. */
function pathlibOpenModeWrites(code: string, methodAt: number): boolean | null {
	const call = /^\s*\.\s*open\s*\(/.exec(code.slice(methodAt));
	if (!call) return false;
	let cursor = methodAt + call[0].length;
	let mode: string | undefined;
	let modeSeen = false;
	let unknownMode = false;
	let positionalIndex = 0;
	while (cursor < code.length) {
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] === ")") break;
		const argument = readArg(code, cursor);
		if (!argument) return null;
		const raw = argument.raw.trim();
		if (raw.startsWith("*") || raw.startsWith("**")) {
			unknownMode = true;
		} else {
			const keyword = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(raw);
			if (keyword?.[1] === "mode") {
				if (modeSeen) unknownMode = true;
				else {
					mode = keyword[2];
					modeSeen = true;
				}
			} else if (!keyword && positionalIndex === 0) {
				if (modeSeen) unknownMode = true;
				else {
					mode = raw;
					modeSeen = true;
				}
			}
		}
		positionalIndex += 1;
		cursor = argument.end;
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] === ",") cursor += 1;
		else if (code[cursor] !== ")") return null;
	}
	return unknownMode ? null : modeWrites(mode);
}

/** Calls inside strings or comments are skipped. A non-literal write path fails closed. */
function scanInterpreterWrites(code: string, language: "py" | "js", targets: ExtractedTargets): void {
	let index = 0;
	const recognizedPathMethodIndexes = new Set<number>();
	while (index < code.length) {
		const trivia = skipNoise(code, index, language);
		if (trivia !== index) {
			if (language === "py" && pythonFStringContainsDynamicExecution(code, index, trivia)) {
				targets.explicitMutation = true;
				targets.unknown = true;
				return;
			}
			index = trivia;
			continue;
		}
		if (
			INTERPRETER_OUTPUT_METHOD_ASSIGNMENT_RE.test(code.slice(index)) ||
			INTERPRETER_OUTPUT_STREAM_MUTATION_RE.test(code.slice(index))
		) {
			targets.explicitMutation = true;
			targets.unknown = true;
			return;
		}
		const previous = index === 0 ? "" : (code[index - 1] ?? "");
		if ((index > 0 && /[\w]/.test(previous)) || !/[A-Za-z_]/.test(code[index] ?? "")) {
			index += 1;
			continue;
		}
		const ident = /^[A-Za-z_]\w*/.exec(code.slice(index));
		if (!ident) {
			index += 1;
			continue;
		}
		const name = ident[0];
		if (language === "py" && PYTHON_DYNAMIC_EXECUTION_IDENTIFIER_RE.test(name)) {
			targets.explicitMutation = true;
			targets.unknown = true;
			return;
		}
		let receiverDot = index - 1;
		while (receiverDot >= 0 && /\s/.test(code[receiverDot] ?? "")) receiverDot -= 1;
		const unresolvedPathMethod =
			language === "py" &&
			code[receiverDot] === "." &&
			(/^write_\w+$/.test(name) || name === "touch" || name === "open");
		if (unresolvedPathMethod && !recognizedPathMethodIndexes.has(index)) {
			const callAt = skipCallGap(code, index + name.length);
			if (code[callAt] === "(") {
				const writes = name === "open" ? pathlibOpenModeWrites(code, receiverDot) : true;
				if (writes !== false) {
					targets.explicitMutation = true;
					targets.unknown = true;
				}
				index = Math.max(callAt + 1, index + name.length);
				continue;
			}
		}
		if ((name === "write" || name === "append") && previous === ".") {
			index += name.length;
			continue;
		}
		let cursor = skipCallGap(code, index + name.length);
		let dotted = "";
		if (code[cursor] === ".") {
			const methodAt = skipCallGap(code, cursor + 1);
			const dot = /^\w+/.exec(code.slice(methodAt));
			dotted = dot?.[0] ?? "";
			cursor = methodAt + dotted.length;
		}
		const paren = /^\s*\(/.exec(code.slice(cursor));
		const helper = (name === "write" || name === "append") && dotted === "";
		const open = (name === "open" && language === "py") || (name === "openSync" && language === "js");
		const pathCtor =
			(name === "Path" && dotted === "") || (language === "py" && name === "pathlib" && dotted === "Path");
		const osCall =
			language === "py" &&
			((name === "os" && PY_OS_MUTATORS.has(dotted)) || (name === "shutil" && PY_OS_MUTATORS.has(dotted)));
		const jsCall =
			language === "js" && ((JS_FS_MUTATORS.has(name) && dotted === "") || (name === "Bun" && dotted === "write"));
		if (!paren || (!helper && !(open && dotted === "") && !pathCtor && !osCall && !jsCall)) {
			index += name.length;
			continue;
		}
		const argAt = cursor + paren[0].length;
		const first = readArg(code, argAt);
		if (pathCtor) {
			const ctor = readPathConstructor(code, argAt);
			if (!ctor) {
				index += 1;
				continue;
			}
			const method = /^\s*\.\s*(write_\w+|open|touch)\s*\(/.exec(code.slice(ctor.after));
			if (method) {
				if (ctor.parts.length > 1) {
					recognizedPathMethodIndexes.add(ctor.after + method[0].indexOf(method[1]));
				}
				const writes = method[1] === "open" ? pathlibOpenModeWrites(code, ctor.after) : true;
				if (writes !== false) {
					targets.explicitMutation = true;
					const receiver = literalPathReceiver(ctor.parts);
					if (writes === null || receiver === null || receiver.length === 0) targets.unknown = true;
					else addPath(targets, receiver);
				}
			}
			// Extra segments stay in the argument walk so a nested mutator is still recorded.
			index =
				ctor.parts.length > 1 ? index + name.length : Math.max(ctor.after + (method?.[0].length ?? 0), index + 1);
			continue;
		}
		if (!first) {
			literalWrite(targets, undefined, null);
			index = Math.max(argAt, index + 1);
			continue;
		}
		if (open && dotted === "") {
			literalWrite(targets, first.raw, openModeWrites(code, first));
			index = Math.max(first.end, index + 1);
			continue;
		}
		literalWrite(targets, first.raw, true);
		let end = first.end;
		if (TWO_ARG_MUTATORS.has(dotted || name)) {
			const second = nextCallArg(code, first.end);
			if (!second) literalWrite(targets, undefined, null);
			else {
				literalWrite(targets, second.raw, true);
				end = second.end;
			}
		}
		index = Math.max(end, index + 1);
	}
}

function extractCodeToolTargets(toolName: string, args: unknown): ExtractedTargets {
	const targets: ExtractedTargets = { paths: [], unknown: false };
	const record = getRecord(args);
	if (!record) {
		targets.unknown = true;
		targets.explicitMutation = true;
		return targets;
	}
	if (toolName === "python") {
		if ((safeString(record.action) || "execute") === "clear") return targets;
		if (typeof record.code !== "string" || record.code.trim() === "") return targets;
		scanInterpreterWrites(record.code, "py", targets);
		return targets;
	}
	if (!Array.isArray(record.cells)) {
		targets.unknown = true;
		targets.explicitMutation = true;
		return targets;
	}
	for (const cell of record.cells) {
		const cellRecord = getRecord(cell);
		if (typeof cellRecord?.code !== "string") {
			targets.unknown = true;
			targets.explicitMutation = true;
			continue;
		}
		if (cellRecord.language === "py") scanInterpreterWrites(cellRecord.code, "py", targets);
		else if (cellRecord.language === "js") {
			scanInterpreterWrites(cellRecord.code, "js", targets);
			if (interpreterCodeContainsWriteApi(cellRecord.code, "js")) {
				targets.unknown = true;
				targets.explicitMutation = true;
			}
		} else {
			targets.unknown = true;
			targets.explicitMutation = true;
		}
	}
	return targets;
}

function extractTargets(tool: ToolWithEditMode, args: unknown): ExtractedTargets {
	if (tool.name === "write") return extractWriteTargets(args);
	if (tool.name === "ast_edit") return extractAstEditTargets(args);
	if (tool.name === "edit") return extractEditTargets(args, tool);
	if (tool.name === "bash") return extractBashTargets(args);
	if (tool.name === "github") return extractGithubTargets(args);
	if (tool.name === "python" || tool.name === "eval") return extractCodeToolTargets(tool.name, args);
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
	for (const skillName of ["deep-interview", "ralplan", "ultragoal"] as const) {
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

function planningSessionDirName(sessionId: string | null | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	return sessionDirName(trimmed);
}

/** Specs and plans are planning-writable. A `_session-` directory must be this session's encoded name. */
function isAllowlistedPath(cwd: string, rawPath: string, sessionId?: string | null): boolean {
	const segments = relativeGjcSegments(cwd, rawPath);
	if (segments?.[0] !== ".gjc") return false;
	const head = segments[1];
	if (head?.startsWith(GJC_SESSION_PREFIX)) {
		const bound = planningSessionDirName(sessionId);
		if (!bound || head !== bound) return false;
		return segments[2] === "specs" || segments[2] === "plans";
	}
	return head === "specs" || head === "plans";
}
function isBlockedGjcPath(cwd: string, rawPath: string): boolean {
	const segments = relativeGjcSegments(cwd, rawPath);
	return segments?.[0] === ".gjc";
}

function hasBlockedGjcTarget(cwd: string, targets: ExtractedTargets): boolean {
	return targets.paths.some(rawPath => isBlockedGjcPath(cwd, rawPath));
}

function allTargetsAllowlisted(cwd: string, targets: ExtractedTargets, sessionId?: string | null): boolean {
	return (
		!targets.unknown &&
		targets.paths.length > 0 &&
		targets.paths.every(rawPath => isAllowlistedPath(cwd, rawPath, sessionId))
	);
}

/** POSIX directories that are temp roots even when `TMPDIR` is unset or poisoned. */
const POSIX_SYSTEM_TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];

/**
 * `os.tmpdir()` follows `TMPDIR`, and Bun copies `cwd/.env` into the environment
 * when that variable was unset. A repository can therefore name an arbitrary
 * directory. Declarations below are not neutral scratch roots.
 */
function tempEnvNames(): readonly string[] {
	return process.platform === "win32" ? ["TEMP", "TMP", "TMPDIR"] : ["TMPDIR"];
}

const PROJECT_TEMP_DOTENV_MAX_FILE_BYTES = 64 * 1024;

// The snapshot is the cwd at module import, not a directory created later or a chdir before this module is imported.
const startupTempSnapshot = projectEnvSnapshot(process.cwd(), {
	maxFileBytes: PROJECT_TEMP_DOTENV_MAX_FILE_BYTES,
});

function projectTempSnapshots(cwd: string): ProjectEnvSnapshot[] {
	// Check both the cwd's .env and the startup snapshot (for module-import-time cwd).
	// The cwd's .env catches project-declared TMPDIR in the current working directory.
	// The startup snapshot is a fallback for when the cwd's .env is deleted or inaccessible
	// (e.g., after unlink or chdir), and also handles the case where cwd differs from the
	// module-import-time cwd. These workspace-controlled files are read as bounded regular files.
	const snapshots: ProjectEnvSnapshot[] = [
		projectEnvSnapshot(cwd, { maxFileBytes: PROJECT_TEMP_DOTENV_MAX_FILE_BYTES }),
		startupTempSnapshot,
	];
	return snapshots;
}

/** macOS account temp directory. `getconf` does not read `TMPDIR`. */
let darwinUserTempDirCache: string | undefined | null = null;
function darwinUserTempDir(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	if (darwinUserTempDirCache !== null) return darwinUserTempDirCache;
	darwinUserTempDirCache = undefined;
	try {
		const result = Bun.spawnSync({
			cmd: ["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"],
			env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return undefined;
		const value = new TextDecoder().decode(result.stdout).trim();
		if (value) darwinUserTempDirCache = value;
	} catch {
		// Fixed `/tmp` roots still cover the POSIX default.
	}
	return darwinUserTempDirCache ?? undefined;
}

function addResolvedTempRoot(roots: Set<string>, value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed) roots.add(path.resolve(trimmed));
}

function isPlatformTempPath(resolved: string): boolean {
	for (const root of POSIX_SYSTEM_TEMP_ROOTS) {
		const resolvedRoot = path.resolve(root);
		if (resolved === resolvedRoot || isPathWithin(resolvedRoot, resolved)) return true;
	}
	const darwin = darwinUserTempDir();
	if (!darwin) return false;
	const resolvedDarwin = path.resolve(darwin);
	return resolved === resolvedDarwin || isPathWithin(resolvedDarwin, resolved);
}

/** True when `live` is declared, or cannot be trusted because a dotenv layer was unsafe to read. */
function projectDeclaresTempPath(snapshots: readonly ProjectEnvSnapshot[], live: string): boolean {
	const trimmedLive = live.trim();
	if (!trimmedLive) return false;
	const resolvedLive = path.resolve(trimmedLive);
	for (const snapshot of snapshots) {
		if (snapshot.incomplete && !isPlatformTempPath(resolvedLive)) return true;
		for (const name of tempEnvNames()) {
			const key = canonicalEnvKey(name);
			const declared = snapshot.values[key];
			if (declared === undefined) continue;
			if (snapshot.dynamic.has(key)) {
				// Expansion is not comparable. A dynamic value that landed on a
				// real system temp dir is already allowed through those roots.
				if (!isPlatformTempPath(resolvedLive)) return true;
				continue;
			}
			const trimmedDeclared = declared.trim();
			if (trimmedDeclared && path.resolve(trimmedDeclared) === resolvedLive) return true;
		}
	}
	return false;
}

function neutralTempRoots(cwd: string): string[] {
	const roots = new Set<string>();
	for (const fixed of POSIX_SYSTEM_TEMP_ROOTS) addResolvedTempRoot(roots, fixed);
	addResolvedTempRoot(roots, darwinUserTempDir());
	const candidates = [os.tmpdir(), process.env.TMPDIR];
	if (process.platform === "win32") candidates.push(process.env.TEMP, process.env.TMP);
	const snapshots = projectTempSnapshots(cwd);
	for (const candidate of candidates) {
		if (!candidate || projectDeclaresTempPath(snapshots, candidate)) continue;
		addResolvedTempRoot(roots, candidate);
	}
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
	const roots = neutralTempRoots(cwd);
	const realRoots = await Promise.all(roots.map(realpathOrSelf));
	// Accept both spellings (`/var/folders` and `/private/var/folders`) before the
	// canonical re-check. The re-check still rejects a temp path whose real
	// target is inside the project.
	const lexicalRoots = new Set([...roots, ...realRoots]);
	if (![...lexicalRoots].some(root => isPathWithin(root, absolutePath))) return false;
	const realTarget = await canonicalizeForContainment(absolutePath);
	if (isPathWithin(await realpathOrSelf(resolvedCwd), realTarget)) return false;
	return realRoots.some(root => isPathWithin(root, realTarget));
}

/** realpath cannot expose another name for the same inode outside a writable root. */
async function hasUnsharedFileTarget(cwd: string, rawPath: string): Promise<boolean> {
	const { absolutePath, unknown } = resolveRawPath(cwd, rawPath);
	if (unknown || !absolutePath) return false;
	try {
		const target = await fs.stat(absolutePath);
		return !target.isFile() || target.nlink === 1;
	} catch (error) {
		// New scratch files remain writable; inaccessible or unresolvable targets fail closed.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** Targets that remain disallowed during a planning phase (excludes neutral temp scratch). */
async function planningBlockedTargets(
	cwd: string,
	targets: ExtractedTargets,
	sessionId?: string | null,
): Promise<string[]> {
	const blocked: string[] = [];
	for (const rawPath of targets.paths) {
		if (!(await hasUnsharedFileTarget(cwd, rawPath))) {
			blocked.push(rawPath);
			continue;
		}
		if (isAllowlistedPath(cwd, rawPath, sessionId)) continue;
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
	const guardContext =
		input.guardContext ??
		(await readWorkflowGuardContext(input.cwd, { sessionId: input.sessionId, threadId: input.threadId }));
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId, guardContext);

	if (!planning) return;
	const message = planningPhaseBlockMessage(planning.skill);
	if (input.rawPaths.length === 0) throw new ToolError(message);
	const blocked = await planningBlockedTargets(input.cwd, targets, guardContext.sessionId);
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
	const guardContext =
		input.guardContext ??
		(await readWorkflowGuardContext(input.cwd, { sessionId: input.sessionId, threadId: input.threadId }));
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId, guardContext);
	if (!planning) {
		return { blocked: false, targets: [] };
	}
	if (input.forceOverride) return { blocked: false, targets: [] };
	// Autoresearch is research-only: it never edits product code, on any branch.
	// The only agent-writable surface is the mission's own research artifact —
	// the `autoresearch.sh` harness at the workdir root (mission state under
	// `.gjc/**` is runtime-owned and only the sanctioned CLI writes it). A branch
	// name is not authorization: an `autoresearch/*` branch isolates keep/discard
	// bookkeeping, it does not turn product edits into research.
	//
	// Shell and code-execution tools can run multiple operations before writing,
	// so checking the harness once cannot protect the later write destination.
	// Only direct file-mutation tools may use the harness exception.
	// The allowance requires at least one named target: `every` is vacuously true
	// for an empty list, so an opaque mutation that resolves to NO target (e.g.
	// `python3 -c "open('src/product.ts','w').write('x')"`) would otherwise skip
	// the fail-closed check below and be waved through on a research mission.
	// Bash is a compound command list, not a write boundary: an earlier `ln` or
	// `mv` can retarget the harness before a later redirection. Harness changes
	// must use a single-target file tool so the final path is checked for symlinks
	// immediately before that write operation.
	if (
		planning.skill === "autoresearch" &&
		AUTORESEARCH_HARNESS_FILE_TOOL_NAMES.has(input.tool.name) &&
		targets.paths.length > 0 &&
		!targets.unknown &&
		targets.paths.every(p => isAutoresearchAuthorizedResearchPath(input.cwd, p)) &&
		(await Promise.all(targets.paths.map(p => hasUnsharedFileTarget(input.cwd, p)))).every(Boolean)
	) {
		return { blocked: false, targets: targets.paths };
	}
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
	const blockedTargets = await planningBlockedTargets(input.cwd, targets, guardContext.sessionId);
	if (blockedTargets.length === 0) {
		return { blocked: false, targets: targets.paths };
	}
	return {
		blocked: true,
		message,
		targets: targets.paths,
		reason: allTargetsAllowlisted(input.cwd, targets, guardContext.sessionId)
			? "handoff-artifact-tool-target"
			: "phase-boundary",
	};
}

export async function assertWorkflowMutationAllowed(input: WorkflowMutationGuardInput): Promise<void> {
	const decision = await getWorkflowMutationDecision(input);
	if (decision.blocked) throw new ToolError(decision.message ?? DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
}
