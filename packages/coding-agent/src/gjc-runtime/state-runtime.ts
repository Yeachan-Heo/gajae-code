import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import {
	applyHandoffToActiveState,
	CANONICAL_GJC_WORKFLOW_SKILLS,
	type CanonicalGjcWorkflowSkill,
	listActiveSkills,
	readVisibleSkillActiveState,
	syncSkillActiveState,
} from "../skill-state/active-state";
import { initialPhaseForSkill } from "../skill-state/initial-phase";
import {
	buildDeepInterviewHudSummary,
	buildRalplanHudSummary,
	buildTeamHudSummary,
	buildUltragoalHudSummary,
} from "../skill-state/workflow-hud";
import {
	type AuditEntry,
	buildWorkflowStateReceipt,
	canonicalWorkflowSkill,
	describeWorkflowStateContract,
	type WorkflowStateReceipt,
} from "../skill-state/workflow-state-contract";
import { renderStateGraph, type StateGraphFormat } from "./state-graph";
import { migrateAndPersistLegacyState } from "./state-migrations";
import {
	buildStateStatusSummary,
	compactProjectStateJson,
	projectStateFields,
	renderContractMarkdown,
	renderHistoryMarkdown,
	renderStateMarkdown,
	renderStateStatusLine,
	STATE_FIELD_ALLOWLIST,
	type StateProjectionField,
} from "./state-renderer";
import { validateWorkflowStateEnvelope } from "./state-validation";
import {
	appendAuditEntry,
	beginWorkflowTransactionJournal,
	completeWorkflowTransactionJournal,
	detectWorkflowEnvelopeIntegrityMismatch,
	type GenericHardPruneTarget,
	hardPrune,
	type StateWriterAuditContext,
	softDelete,
	updateWorkflowTransactionJournal,
	writeWorkflowEnvelopeAtomic,
} from "./state-writer";
import { getSkillManifest, isKnownWorkflowState, isValidTransition, typedArgsFor } from "./workflow-manifest";

/**
 * Native implementation of the `gjc state read|write|clear` command surface.
 *
 * Simple file-receipt operations against `.gjc/state/[sessions/<id>/]<mode>-state.json` and
 * `.gjc/state/[sessions/<id>/]skill-active-state.json`. This is the sanctioned CLI mediator for
 * the mutation-guarded `.gjc/state` ACL — agents call it instead of editing those files directly.
 */

export interface StateCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const SKILL_ACTIVE_STATE_FILE = "skill-active-state.json";
const PATH_COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const KNOWN_MODES: readonly string[] = CANONICAL_GJC_WORKFLOW_SKILLS;

class StateCommandError extends Error {
	constructor(
		public readonly exitStatus: number,
		message: string,
	) {
		super(message);
		this.name = "StateCommandError";
	}
}

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

const GRAPH_FORMATS = new Set(["ascii", "mermaid", "dot"]);
const FLAGS_WITH_VALUES = new Set([
	"--input",
	"--mode",
	"--session-id",
	"--thread-id",
	"--turn-id",
	"--to",
	"--skill",
	"--format",
	"--older-than",
	"--status",
	"--fields",
	"--since",
	"--limit",
]);
const ACTION_NAMES = new Set([
	"read",
	"write",
	"clear",
	"contract",
	"handoff",
	"graph",
	"prune",
	"gc",
	"migrate",
	"status",
]);
const BOOLEAN_FLAGS = new Set([
	"--json",
	"--replace",
	"--hard",
	"--dry-run",
	"--migrate",
	"--compact",
	"--history",
	"--force",
]);
const VERB_SPECIFIC_FLAGS = new Set([
	"--skill",
	"--format",
	"--older-than",
	"--status",
	"--fields",
	"--since",
	"--limit",
	"--history",
]);

function flagName(arg: string): string | undefined {
	if (!arg.startsWith("--")) return undefined;
	const equalsIndex = arg.indexOf("=");
	return equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
}

function manifestFlagNames(action: ParsedInvocation["action"], positionalSkill: string | undefined): Set<string> {
	const names = new Set<string>();
	const skills =
		positionalSkill && KNOWN_MODES.includes(positionalSkill)
			? [positionalSkill as CanonicalGjcWorkflowSkill]
			: CANONICAL_GJC_WORKFLOW_SKILLS;
	for (const skill of skills) {
		for (const arg of typedArgsFor(skill, action)) names.add(`--${arg.name}`);
	}
	return names;
}

function assertKnownFlags(args: readonly string[], parsed: ParsedInvocation): void {
	const manifestFlags = manifestFlagNames(parsed.action, parsed.positionalSkill);
	for (const arg of args) {
		const flag = flagName(arg);
		if (!flag) continue;
		if (
			FLAGS_WITH_VALUES.has(flag) ||
			BOOLEAN_FLAGS.has(flag) ||
			VERB_SPECIFIC_FLAGS.has(flag) ||
			manifestFlags.has(flag)
		) {
			continue;
		}
		throw new StateCommandError(2, `unknown gjc state flag: ${flag}`);
	}
}

interface ParsedInvocation {
	action: "read" | "write" | "clear" | "contract" | "handoff" | "graph" | "prune" | "gc" | "migrate" | "status";
	positionalSkill?: string;
}

function parsePositionalArgs(args: readonly string[]): ParsedInvocation {
	let skipNext = false;
	const positional: string[] = [];
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (FLAGS_WITH_VALUES.has(arg)) {
			skipNext = true;
			continue;
		}
		if (!arg.startsWith("-")) positional.push(arg);
	}
	// Documented argv shapes:
	//   gjc state read|write|clear|contract ...
	//   gjc state <skill> read|write|contract ...
	const first = positional[0];
	const second = positional[1];
	if (first && ACTION_NAMES.has(first)) {
		return { action: first as ParsedInvocation["action"], positionalSkill: second };
	}
	if (first && second && ACTION_NAMES.has(second)) {
		return { action: second as ParsedInvocation["action"], positionalSkill: first };
	}
	// `gjc state <skill>` alone defaults to read for that skill.
	if (first && !second) {
		return { action: "read", positionalSkill: first };
	}
	return { action: "read" };
}

function assertSafePathComponent(value: string, label: string): void {
	if (!PATH_COMPONENT_RE.test(value) || value.includes("..")) {
		throw new StateCommandError(2, `invalid path component for --${label}: ${value}`);
	}
}

function assertKnownMode(mode: string): asserts mode is CanonicalGjcWorkflowSkill {
	if (!KNOWN_MODES.includes(mode)) {
		throw new StateCommandError(2, `unknown --mode: ${mode}. Expected one of: ${KNOWN_MODES.join(", ")}.`);
	}
}

async function readInputJson(value: string | undefined, cwd: string): Promise<Record<string, unknown> | undefined> {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	let raw: string;
	if (trimmed.startsWith("@")) {
		const filePath = path.resolve(cwd, trimmed.slice(1));
		try {
			raw = await fs.readFile(filePath, "utf-8");
		} catch (error) {
			throw new StateCommandError(2, `failed to read --input file ${filePath}: ${(error as Error).message}`);
		}
	} else {
		raw = trimmed;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new StateCommandError(2, `--input is not valid JSON: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new StateCommandError(2, "--input must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

interface ResolvedSelectors {
	mode: CanonicalGjcWorkflowSkill | undefined;
	sessionId: string | undefined;
	threadId: string | undefined;
	turnId: string | undefined;
	payload: Record<string, unknown> | undefined;
}

async function resolveSelectors(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<ResolvedSelectors> {
	const payload = await readInputJson(flagValue(args, "--input"), cwd);

	const candidates: Array<string | undefined> = [
		flagValue(args, "--mode")?.trim() || undefined,
		positionalSkill?.trim() || undefined,
		typeof payload?.mode === "string" ? (payload.mode as string).trim() || undefined : undefined,
		typeof payload?.skill === "string" ? (payload.skill as string).trim() || undefined : undefined,
	];
	let mode: string | undefined;
	for (const candidate of candidates) {
		if (candidate) {
			mode = candidate;
			break;
		}
	}
	if (mode) assertKnownMode(mode);

	const explicitSessionId = flagValue(args, "--session-id");
	// Session-id resolution order: explicit --session-id flag, then payload
	// session_id, then GJC_SESSION_ID env var (set by AgentSession.sdk for
	// agent-initiated CLI invocations). The env-var default keeps shell
	// snippets in skill docs short while still routing writes/reads to the
	// caller's session-scoped state files.
	let sessionId = explicitSessionId !== undefined ? explicitSessionId.trim() || undefined : undefined;
	if (!sessionId && payload && typeof payload.session_id === "string") {
		sessionId = payload.session_id.trim() || undefined;
	}
	if (!sessionId && explicitSessionId === undefined) {
		const envSessionId = process.env.GJC_SESSION_ID?.trim();
		if (envSessionId) sessionId = envSessionId;
	}
	if (sessionId) assertSafePathComponent(sessionId, "session-id");

	const threadId = flagValue(args, "--thread-id")?.trim() || undefined;
	if (threadId) assertSafePathComponent(threadId, "thread-id");
	const turnId = flagValue(args, "--turn-id")?.trim() || undefined;
	if (turnId) assertSafePathComponent(turnId, "turn-id");

	return { mode: mode as CanonicalGjcWorkflowSkill | undefined, sessionId, threadId, turnId, payload };
}

async function inferModeFromActiveState(
	cwd: string,
	sessionId: string | undefined,
): Promise<CanonicalGjcWorkflowSkill | undefined> {
	const state = await readVisibleSkillActiveState(cwd, sessionId);
	const entries = listActiveSkills(state);
	const candidate = entries[0]?.skill ?? state?.skill;
	if (!candidate) return undefined;
	const canonical = canonicalWorkflowSkill(candidate);
	return canonical ?? undefined;
}

function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function stateDirFor(cwd: string, sessionId: string | undefined): string {
	const base = path.join(cwd, ".gjc", "state");
	if (!sessionId) return base;
	return path.join(base, "sessions", encodeSessionSegment(sessionId));
}

function modeStateFile(cwd: string, mode: string, sessionId: string | undefined): string {
	return path.join(stateDirFor(cwd, sessionId), `${mode}-state.json`);
}

function activeStateFile(cwd: string, sessionId: string | undefined): string {
	return path.join(stateDirFor(cwd, sessionId), SKILL_ACTIVE_STATE_FILE);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return null;
		throw new StateCommandError(1, `failed to read ${filePath}: ${err.message}`);
	}
}

async function readJsonValue(filePath: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf-8"));
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return null;
		throw new StateCommandError(1, `failed to read ${filePath}: ${err.message}`);
	}
}

async function warnAndAuditOutOfBandIfNeeded(
	cwd: string,
	filePath: string,
	skill: CanonicalGjcWorkflowSkill,
	options?: { mutationId?: string; forced?: boolean },
): Promise<string | undefined> {
	const mismatch = await detectWorkflowEnvelopeIntegrityMismatch(filePath);
	if (!mismatch) return undefined;
	const message = `WARNING: workflow mode-state out-of-band edit detected for ${skill}: ${filePath} expected sha256 ${mismatch.expected} but found ${mismatch.actual}`;
	await appendAuditEntry(cwd, {
		ts: new Date().toISOString(),
		skill,
		category: "state",
		verb: "out_of_band_detected",
		owner: "gjc-state-cli",
		mutation_id: options?.mutationId ?? `${skill}:out-of-band:${new Date().toISOString()}`,
		forced: options?.forced ?? false,
		paths: [filePath],
		expected_sha256: mismatch.expected,
		actual_sha256: mismatch.actual,
	} as AuditEntry);
	return message;
}

async function writeJsonAtomic(
	cwd: string,
	filePath: string,
	value: unknown,
	verb: "write" | "clear" | "handoff" = "write",
	options?: {
		skill?: CanonicalGjcWorkflowSkill;
		mutationId?: string;
		force?: boolean;
		fromPhase?: string;
		toPhase?: string;
	},
): Promise<string | undefined> {
	const warning = options?.skill
		? await warnAndAuditOutOfBandIfNeeded(cwd, filePath, options.skill, {
				mutationId: options.mutationId,
				forced: options.force ?? false,
			})
		: undefined;
	if (warning && !options?.force) {
		throw new StateCommandError(2, `${warning}; use --force to overwrite tampered mode-state`);
	}
	await writeWorkflowEnvelopeAtomic(filePath, value, {
		cwd,
		audit: {
			category: "state",
			verb,
			owner: "gjc-state-cli",
			skill: options?.skill,
			mutationId: options?.mutationId,
			fromPhase: options?.fromPhase,
			toPhase: options?.toPhase,
			forced: options?.force ?? false,
		},
	});
	return warning;
}

function parseFieldsFlag(args: readonly string[]): StateProjectionField[] | undefined {
	const raw = flagValue(args, "--fields");
	if (raw === undefined) return undefined;
	const allowed = new Set<string>(STATE_FIELD_ALLOWLIST);
	const fields = raw
		.split(",")
		.map(field => field.trim())
		.filter(Boolean);
	const unknown = fields.filter(field => !allowed.has(field));
	if (unknown.length) {
		throw new StateCommandError(
			2,
			`unknown --fields value(s): ${unknown.join(", ")}. Allowed fields: ${STATE_FIELD_ALLOWLIST.join(", ")}`,
		);
	}
	return fields as StateProjectionField[];
}

function parseLimitFlag(args: readonly string[], defaultLimit = 50): number {
	const raw = flagValue(args, "--limit");
	if (raw === undefined) return defaultLimit;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
		throw new StateCommandError(2, "gjc state --limit requires an integer from 1 to 500");
	}
	return parsed;
}

function parseSinceFlag(args: readonly string[]): string | undefined {
	const raw = flagValue(args, "--since")?.trim();
	if (!raw) return undefined;
	const duration = raw.match(/^(\d+)(m|h|d)$/);
	if (duration) {
		const amount = Number(duration[1]);
		const unit = duration[2];
		const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
		return new Date(Date.now() - amount * multiplier).toISOString();
	}
	if (Number.isNaN(Date.parse(raw)))
		throw new StateCommandError(2, "gjc state --since requires an ISO timestamp or duration like 30m, 6h, 7d");
	return new Date(raw).toISOString();
}

async function readAuditWindow(
	cwd: string,
	args: readonly string[],
): Promise<{ entries: unknown[]; limit: number; since?: string; truncated: boolean }> {
	const limit = parseLimitFlag(args);
	const since = parseSinceFlag(args);
	const auditPath = path.join(cwd, ".gjc", "state", "audit.jsonl");
	let raw = "";
	try {
		raw = await fs.readFile(auditPath, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") throw error;
	}
	const selected: unknown[] = [];
	let matched = 0;
	const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (since && isPlainObject(entry) && typeof entry.ts === "string" && Date.parse(entry.ts) < Date.parse(since))
			break;
		matched += 1;
		if (selected.length < limit) selected.push(entry);
	}
	return { entries: selected.reverse(), limit, ...(since ? { since } : {}), truncated: matched > limit };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Shallow-merge `source` into `target`, with the convention that a `source` key whose value is
 * `null` deletes that key from `target`. Nested objects are replaced wholesale (not deep-merged)
 * so callers retain explicit control over substructure semantics; pre-existing skills that want
 * to merge nested fields can supply the full sub-object themselves.
 */
function mergeWithNullDelete(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (value === null) {
			delete result[key];
		} else {
			result[key] = value;
		}
	}
	return result;
}

function nowIso(): string {
	return new Date().toISOString();
}

function buildHudForMode(
	mode: CanonicalGjcWorkflowSkill,
	payload: Record<string, unknown>,
): WorkflowHudSummary | undefined {
	const updatedAt = new Date().toISOString();
	const phase = typeof payload.current_phase === "string" ? payload.current_phase : undefined;
	const stateField = isPlainObject(payload.state) ? (payload.state as Record<string, unknown>) : {};
	switch (mode) {
		case "deep-interview": {
			const pick = <T>(key: string, guard: (value: unknown) => value is T): T | undefined => {
				const v = (stateField as Record<string, unknown>)[key] ?? (payload as Record<string, unknown>)[key];
				return guard(v) ? v : undefined;
			};
			const isNumber = (v: unknown): v is number => typeof v === "number";
			const isString = (v: unknown): v is string => typeof v === "string";
			const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
			const ambiguity = pick("current_ambiguity", isNumber);
			const threshold = pick("threshold", isNumber);
			const rounds = pick("rounds", isArray);
			const targetComponent = pick("last_targeted_component_id", isString);
			const weakestDimension = pick("weakest_dimension", isString);
			return buildDeepInterviewHudSummary({
				phase,
				ambiguity,
				threshold,
				roundCount: rounds?.length,
				targetComponent,
				weakestDimension,
				updatedAt,
			});
		}
		case "ralplan": {
			const stage =
				typeof payload.current_phase === "string"
					? (payload.current_phase as string)
					: typeof payload.mode === "string"
						? (payload.mode as string)
						: undefined;
			const verdict = typeof payload.verdict === "string" ? (payload.verdict as string) : undefined;
			const iteration = typeof payload.iteration === "number" ? (payload.iteration as number) : undefined;
			const pendingApproval = payload.pending_approval === true || stage === "final";
			return buildRalplanHudSummary({
				stage,
				verdict,
				iteration,
				pendingApproval,
				updatedAt,
			});
		}
		case "ultragoal": {
			const goals = Array.isArray(payload.goals)
				? (payload.goals as Array<{ id?: string; title?: string; status?: string }>).filter(
						g => g && typeof g.id === "string" && typeof g.title === "string" && typeof g.status === "string",
					)
				: [];
			const counts: Record<string, number> = {};
			for (const goal of goals) {
				const status = goal.status as string;
				counts[status] = (counts[status] ?? 0) + 1;
			}
			const currentGoalRaw = goals.find(g => g.status === "active") ?? goals.find(g => g.status === "pending");
			const status = typeof payload.status === "string" ? (payload.status as string) : (phase ?? "pending");
			return buildUltragoalHudSummary({
				status,
				currentGoal: currentGoalRaw
					? {
							id: currentGoalRaw.id as string,
							title: currentGoalRaw.title as string,
							status: currentGoalRaw.status as string,
						}
					: undefined,
				counts,
				goals: goals.map(g => ({ id: g.id as string, title: g.title as string, status: g.status as string })),
				updatedAt,
			});
		}
		case "team": {
			const teamPhase = typeof payload.phase === "string" ? (payload.phase as string) : (phase ?? "running");
			const taskCounts =
				typeof payload.task_counts === "object" && payload.task_counts && !Array.isArray(payload.task_counts)
					? (payload.task_counts as Record<string, number>)
					: {};
			const taskTotal = typeof payload.task_total === "number" ? (payload.task_total as number) : 0;
			const workers = Array.isArray(payload.workers)
				? (payload.workers as Array<{ id?: string; status?: string }>)
						.filter(w => w && typeof w.id === "string")
						.map(w => ({
							id: w.id as string,
							status: typeof w.status === "string" ? (w.status as string) : undefined,
						}))
				: [];
			return buildTeamHudSummary({
				phase: teamPhase,
				task_total: taskTotal,
				task_counts: taskCounts,
				workers,
				updated_at: updatedAt,
			});
		}
		default:
			return undefined;
	}
}

async function syncWorkflowSkillState(options: {
	cwd: string;
	mode: CanonicalGjcWorkflowSkill;
	sessionId: string | undefined;
	threadId?: string;
	turnId?: string;
	active: boolean;
	phase: string | undefined;
	payload: Record<string, unknown>;
	receipt?: WorkflowStateReceipt;
}): Promise<void> {
	try {
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: options.mode,
			active: options.active,
			phase: options.phase,
			sessionId: options.sessionId,
			threadId: options.threadId,
			turnId: options.turnId,
			source: "gjc-state-cli",
			hud: buildHudForMode(options.mode, options.payload),
			...(options.receipt ? { receipt: options.receipt } : {}),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}
export async function readWorkflowStateJson(
	cwd: string,
	skill: CanonicalGjcWorkflowSkill,
	sessionId?: string,
): Promise<Record<string, unknown>> {
	return (await readJsonFile(modeStateFile(cwd, skill, sessionId))) ?? {};
}

async function handleRead(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.sessionId));
	const fields = parseFieldsFlag(args);
	if (mode) {
		const filePath = modeStateFile(cwd, mode, selectors.sessionId);
		const existing = await readWorkflowStateJson(cwd, mode, selectors.sessionId);
		const envelope = { skill: mode, state: existing, storage_path: filePath };
		const manifest = getSkillManifest(mode);
		if (fields) {
			const projected = projectStateFields(mode, envelope, manifest, fields);
			return {
				status: 0,
				stdout: hasFlag(args, "--json")
					? `${JSON.stringify(projected, null, 2)}\n`
					: renderStateMarkdown(mode, projected, manifest),
			};
		}
		if (hasFlag(args, "--compact")) {
			const compact = compactProjectStateJson(mode, envelope, manifest);
			return {
				status: 0,
				stdout: hasFlag(args, "--json")
					? `${JSON.stringify(compact, null, 2)}\n`
					: renderStateMarkdown(mode, envelope, manifest),
			};
		}
		return {
			status: 0,
			stdout: hasFlag(args, "--json")
				? `${JSON.stringify(envelope, null, 2)}\n`
				: renderStateMarkdown(mode, envelope, manifest),
		};
	}
	const filePath = activeStateFile(cwd, selectors.sessionId);
	const existingRaw = await readJsonValue(filePath);
	const existing = isPlainObject(existingRaw) ? existingRaw : null;
	return { status: 0, stdout: `${JSON.stringify(existing ?? {}, null, 2)}\n` };
}

async function handleStatus(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.sessionId));
	if (!mode) {
		throw new StateCommandError(
			2,
			"gjc state status requires --mode <skill>, positional <skill>, input.skill, or an active workflow in .gjc/state/skill-active-state.json",
		);
	}
	const filePath = modeStateFile(cwd, mode, selectors.sessionId);
	const existing = await readWorkflowStateJson(cwd, mode, selectors.sessionId);
	const summary = buildStateStatusSummary(
		mode,
		{ skill: mode, state: existing, storage_path: filePath },
		getSkillManifest(mode),
		filePath,
	);
	return {
		status: 0,
		stdout: hasFlag(args, "--json") ? `${JSON.stringify(summary, null, 2)}\n` : renderStateStatusLine(summary),
	};
}

async function handleWrite(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const { sessionId, threadId, turnId, payload } = selectors;
	if (!payload) throw new StateCommandError(2, "gjc state write requires --input '<json>'");
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, sessionId));
	if (!mode)
		throw new StateCommandError(
			2,
			"gjc state write requires --mode <skill>, positional <skill>, input.skill, or an active workflow in .gjc/state/skill-active-state.json",
		);

	const filePath = modeStateFile(cwd, mode, sessionId);
	const existingRaw = await readJsonValue(filePath);
	const existing = isPlainObject(existingRaw) ? existingRaw : null;
	const nowIsoStr = nowIso();
	const mutationId = `${mode}:${nowIsoStr}`;
	const receipt = buildWorkflowStateReceipt({
		cwd,
		skill: mode,
		owner: "gjc-state-cli",
		command: `gjc state ${mode} write`,
		sessionId,
		nowIso: nowIsoStr,
		mutationId,
	});
	if (existingRaw !== null && !isPlainObject(existingRaw)) {
		throw new StateCommandError(2, `existing state for ${mode} must be a JSON object before write`);
	}
	const existingPayload = existing ?? {};
	const innerState = (payload.state as Record<string, unknown> | undefined) ?? {};
	const incomingPhase =
		typeof payload.current_phase === "string" && payload.current_phase.trim()
			? payload.current_phase.trim()
			: typeof payload.phase === "string" && payload.phase.trim()
				? payload.phase.trim()
				: typeof innerState.current_phase === "string" && (innerState.current_phase as string).trim()
					? (innerState.current_phase as string).trim()
					: undefined;
	let merged: Record<string, unknown>;
	if (hasFlag(args, "--replace")) {
		merged = { ...payload };
	} else {
		merged = mergeWithNullDelete(existingPayload, payload);
		// Flatten payload.state.* into the top-level envelope so downstream consumers
		// see a single canonical structure with the receipt at top level.
		if (payload.state && typeof payload.state === "object" && !Array.isArray(payload.state)) {
			merged = mergeWithNullDelete(merged, payload.state as Record<string, unknown>);
			delete merged.state;
		}
	}
	const preDefaultValidation = validateWorkflowStateEnvelope(mode, merged);
	if (!preDefaultValidation.valid) {
		throw new StateCommandError(2, preDefaultValidation.error ?? `invalid ${mode} state envelope`);
	}
	merged.skill = mode;
	if (incomingPhase) {
		merged.current_phase = incomingPhase;
	} else if (typeof merged.current_phase !== "string") {
		merged.current_phase =
			typeof existingPayload.current_phase === "string" ? existingPayload.current_phase : "active";
	}
	if (typeof merged.version !== "number") merged.version = 1;
	if (typeof merged.active !== "boolean") merged.active = true;
	merged.updated_at = nowIsoStr;
	merged.receipt = receipt;
	if (sessionId && typeof merged.session_id !== "string") merged.session_id = sessionId;

	const fromPhase = typeof existingPayload.current_phase === "string" ? existingPayload.current_phase : undefined;
	const toPhase = typeof merged.current_phase === "string" ? merged.current_phase : undefined;
	const forced = hasFlag(args, "--force");
	if (fromPhase && toPhase && isKnownWorkflowState(mode, fromPhase) && isKnownWorkflowState(mode, toPhase)) {
		if (!isValidTransition(mode, fromPhase, toPhase) && !forced) {
			throw new StateCommandError(
				2,
				`invalid ${mode} phase transition from ${fromPhase} to ${toPhase}; use --force to bypass`,
			);
		}
	}

	const validation = validateWorkflowStateEnvelope(mode, merged);
	if (!validation.valid) throw new StateCommandError(2, validation.error ?? `invalid ${mode} state envelope`);

	const outOfBandWarning = await writeJsonAtomic(cwd, filePath, merged, "write", {
		skill: mode,
		mutationId,
		force: forced,
		fromPhase,
		toPhase,
	});

	const phase = typeof merged.current_phase === "string" ? merged.current_phase : undefined;
	const active = merged.active !== false;
	await syncWorkflowSkillState({ cwd, mode, sessionId, threadId, turnId, active, phase, payload: merged, receipt });

	return {
		status: 0,
		stdout: `${JSON.stringify({ skill: mode, state: merged, receipt }, null, 2)}\n`,
		...(outOfBandWarning ? { stderr: `${outOfBandWarning}\n` } : {}),
	};
}

async function handleClear(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const { sessionId, threadId, turnId } = selectors;
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, sessionId));
	if (!mode)
		throw new StateCommandError(
			2,
			"gjc state clear requires --mode <skill>, positional <skill>, input.skill, or an active workflow in .gjc/state/skill-active-state.json",
		);

	const filePath = modeStateFile(cwd, mode, sessionId);
	const existing = (await readJsonFile(filePath)) ?? {};
	const cleared: Record<string, unknown> = {
		...existing,
		active: false,
		current_phase: "complete",
		updated_at: nowIso(),
	};
	const outOfBandWarning = await writeJsonAtomic(cwd, filePath, cleared, "clear", {
		skill: mode,
		force: hasFlag(args, "--force"),
		fromPhase: typeof existing.current_phase === "string" ? existing.current_phase : undefined,
		toPhase: "complete",
	});

	await syncWorkflowSkillState({
		cwd,
		mode,
		sessionId,
		threadId,
		turnId,
		active: false,
		phase: "complete",
		payload: cleared,
	});
	return {
		status: 0,
		stdout: `${JSON.stringify(cleared, null, 2)}\n`,
		...(outOfBandWarning ? { stderr: `${outOfBandWarning}\n` } : {}),
	};
}

/**
 * `handoff` exists in two distinct roles:
 *   - As a verb: this CLI action, which atomically transitions caller→callee.
 *     Writes the callee mode-state first, the caller mode-state second, then
 *     syncs both `skill-active-state.json` files. Every intermediate crashed
 *     state remains HUD-coherent: the active-state file either reflects the
 *     old skill entirely or the new skill entirely, never both as active.
 *   - As a phase: `current_phase: "handoff"` is set by this verb when demoting
 *     the caller. Agents writing `current_phase: "handoff"` manually via
 *     `gjc state <skill> write` are declaring "I am ready to be handed off";
 *     the next agent-initiated `skill` tool call will then satisfy the phase
 *     guard and may chain.
 *
 * `handoff` is in the terminal-phase set used by `isTerminalModeState` and by
 * the skill tool's chain guard. A manual `current_phase: "handoff"` write does
 * NOT mark `active: false` — only this verb does that — so a skill that wrote
 * the phase remains in `skill-active-state.json` until a chain call (or
 * explicit `clear`) demotes it.
 */
async function handleHandoff(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const { sessionId, threadId, turnId } = selectors;
	const caller = selectors.mode ?? (await inferModeFromActiveState(cwd, sessionId));
	if (!caller) {
		throw new StateCommandError(
			2,
			"gjc state handoff requires --mode <caller>, positional <caller>, input.skill, or an active workflow in .gjc/state/skill-active-state.json",
		);
	}
	const calleeRaw = flagValue(args, "--to")?.trim();
	if (!calleeRaw) {
		throw new StateCommandError(2, "gjc state handoff requires --to <callee>");
	}
	assertKnownMode(calleeRaw);
	const callee = calleeRaw as CanonicalGjcWorkflowSkill;
	if (callee === caller) {
		throw new StateCommandError(2, `gjc state handoff: --to must differ from caller (both are "${caller}")`);
	}

	const callerPath = modeStateFile(cwd, caller, sessionId);
	const calleePath = modeStateFile(cwd, callee, sessionId);
	const existingCaller = await readJsonFile(callerPath);
	if (!existingCaller) {
		throw new StateCommandError(
			2,
			`gjc state ${caller} handoff: caller is not active (no mode-state file at ${callerPath})`,
		);
	}
	const existingCallee = (await readJsonFile(calleePath)) ?? {};

	const handoffAt = nowIso();
	const mutationId = `${caller}:handoff:${callee}:${handoffAt}`;
	const callerReceipt = buildWorkflowStateReceipt({
		cwd,
		skill: caller,
		owner: "gjc-state-cli",
		command: `gjc state ${caller} handoff --to ${callee}`,
		sessionId,
		nowIso: handoffAt,
		mutationId,
	});
	const calleeReceipt = buildWorkflowStateReceipt({
		cwd,
		skill: callee,
		owner: "gjc-state-cli",
		command: `gjc state ${caller} handoff --to ${callee}`,
		sessionId,
		nowIso: handoffAt,
		mutationId,
	});

	const calleeInitial = initialPhaseForSkill(callee);
	const mergedCalleeState: Record<string, unknown> = {
		...existingCallee,
		skill: callee,
		version: typeof existingCallee.version === "number" ? existingCallee.version : 1,
		active: true,
		current_phase: calleeInitial,
		handoff_from: caller,
		handoff_at: handoffAt,
		updated_at: handoffAt,
		receipt: calleeReceipt,
	};
	if (sessionId && typeof mergedCalleeState.session_id !== "string") {
		mergedCalleeState.session_id = sessionId;
	}
	const mergedCallerState: Record<string, unknown> = {
		...existingCaller,
		skill: caller,
		active: false,
		current_phase: "handoff",
		handoff_to: callee,
		handoff_at: handoffAt,
		updated_at: handoffAt,
		receipt: callerReceipt,
	};

	await beginWorkflowTransactionJournal({
		cwd,
		mutationId,
		caller,
		callee,
		paths: [calleePath, callerPath, activeStateFile(cwd, sessionId)],
	});

	// Atomic write order (architecture blocker AR-3): mode-state files first,
	// then a single atomic active-state mutation per file (session before root)
	// via applyHandoffToActiveState. The single-write transaction prevents the
	// HUD from observing a window where neither caller nor callee is active,
	// and write order keeps the session-scoped source of truth ahead of the
	// root aggregate. strict:true on the active-state read tolerates ENOENT
	// only; corrupt JSON / IO failures propagate as non-zero CLI status.
	const force = hasFlag(args, "--force");
	const warnings = [
		await writeJsonAtomic(cwd, calleePath, mergedCalleeState, "handoff", {
			skill: callee,
			mutationId,
			force,
			fromPhase: typeof existingCallee.current_phase === "string" ? existingCallee.current_phase : undefined,
			toPhase: calleeInitial,
		}),
		await updateWorkflowTransactionJournal(cwd, mutationId, { steps: ["callee-mode-state"] }).then(() => undefined),
		await writeJsonAtomic(cwd, callerPath, mergedCallerState, "handoff", {
			skill: caller,
			mutationId,
			force,
			fromPhase: typeof existingCaller.current_phase === "string" ? existingCaller.current_phase : undefined,
			toPhase: "handoff",
		}),
		await updateWorkflowTransactionJournal(cwd, mutationId, {
			steps: ["callee-mode-state", "caller-mode-state"],
		}).then(() => undefined),
	].filter((warning): warning is string => typeof warning === "string");
	for (const warning of warnings) process.stderr.write(`${warning}\n`);
	if (process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER === mutationId) {
		throw new StateCommandError(1, `injected handoff failure after caller write for ${mutationId}`);
	}
	await applyHandoffToActiveState({
		cwd,
		nowIso: handoffAt,
		strict: true,
		caller: {
			cwd,
			skill: caller,
			active: false,
			phase: "handoff",
			sessionId,
			threadId,
			turnId,
			source: "gjc-state-cli",
			hud: buildHudForMode(caller, mergedCallerState),
			handoff_to: callee,
			handoff_at: handoffAt,
			receipt: callerReceipt,
		},
		callee: {
			cwd,
			skill: callee,
			active: true,
			phase: calleeInitial,
			sessionId,
			threadId,
			turnId,
			source: "gjc-state-cli",
			hud: buildHudForMode(callee, mergedCalleeState),
			handoff_from: caller,
			handoff_at: handoffAt,
			receipt: calleeReceipt,
		},
	});
	await updateWorkflowTransactionJournal(cwd, mutationId, {
		steps: ["callee-mode-state", "caller-mode-state", "active-state"],
	});
	await completeWorkflowTransactionJournal(cwd, mutationId);

	return {
		status: 0,
		stdout: `${JSON.stringify(
			{
				from: caller,
				to: callee,
				handoff_at: handoffAt,
				caller_state: mergedCallerState,
				callee_state: mergedCalleeState,
			},
			null,
			2,
		)}\n`,
	};
}

async function handleContract(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const { mode } = await resolveSelectors(args, cwd, positionalSkill);
	if (!mode) {
		throw new StateCommandError(2, "gjc state contract requires --mode <skill>, positional <skill>, or input.skill");
	}
	const payload = { skill: mode, contract: describeWorkflowStateContract(mode) };
	return {
		status: 0,
		stdout: hasFlag(args, "--json")
			? `${JSON.stringify(payload, null, 2)}\n`
			: renderContractMarkdown(mode, payload.contract),
	};
}

function parseNonNegativeIntegerFlag(args: readonly string[], flag: string): number | undefined {
	const value = flagValue(args, flag);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new StateCommandError(2, `gjc state ${flag} requires a non-negative integer value`);
	}
	return parsed;
}

function statusFromFile(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.status === "string") return record.status;
	if (record.receipt && typeof record.receipt === "object" && !Array.isArray(record.receipt)) {
		const receiptStatus = (record.receipt as Record<string, unknown>).status;
		if (typeof receiptStatus === "string") return receiptStatus;
	}
	return undefined;
}

interface RetentionCandidate {
	path: string;
	relativePath: string;
	category: string;
	mtimeMs: number;
	policy: { keep?: number; maxAgeDays?: number };
}

interface GcSummary {
	skill: CanonicalGjcWorkflowSkill | "all";
	dry_run: boolean;
	eligible: string[];
	pruned: string[];
	counts: Record<string, number>;
}

function categoryForStateRelativePath(relativePath: string): string | undefined {
	const normalized = relativePath.split(path.sep).join("/");
	if (normalized === "audit.jsonl") return undefined;
	if (normalized === SKILL_ACTIVE_STATE_FILE || normalized.endsWith(`/${SKILL_ACTIVE_STATE_FILE}`)) return undefined;
	if (normalized.startsWith("active/") || normalized.includes("/active/")) return undefined;
	if (
		/^[^/]+-state\.json$/.test(normalized) ||
		(normalized.includes("/sessions/") && /\/[^/]+-state\.json$/.test(normalized))
	)
		return undefined;
	if (normalized.startsWith("artifacts/") || normalized.includes("/artifacts/")) return "artifact";
	if (
		normalized.startsWith("logs/") ||
		normalized.includes("/logs/") ||
		normalized.endsWith(".log") ||
		normalized.endsWith(".jsonl")
	)
		return "log";
	if (normalized.startsWith("reports/") || normalized.includes("/reports/")) return "report";
	if (normalized.startsWith("ledgers/") || normalized.includes("/ledgers/")) return "ledger";
	if (normalized.startsWith("agents/") || normalized.includes("/agents/")) return "agents";
	if (normalized.startsWith("force/") || normalized.includes("/force/")) return "force";
	if (
		normalized.startsWith("prune/") ||
		normalized.includes("/prune/") ||
		normalized.startsWith("delete/") ||
		normalized.includes("/delete/")
	)
		return "prune/delete";
	if (normalized.startsWith("transactions/") || normalized.includes("/transactions/")) return "prune/delete";
	return undefined;
}

async function collectRetentionCandidates(
	cwd: string,
	skills: readonly CanonicalGjcWorkflowSkill[],
): Promise<RetentionCandidate[]> {
	const stateRoot = path.join(cwd, ".gjc", "state");
	const policies = new Map<string, { keep?: number; maxAgeDays?: number }>();
	for (const skill of skills) {
		for (const policy of getSkillManifest(skill).retention) {
			const existing = policies.get(policy.category);
			policies.set(policy.category, {
				keep: Math.max(existing?.keep ?? 0, policy.keep ?? 0) || undefined,
				maxAgeDays:
					existing?.maxAgeDays === undefined
						? policy.maxAgeDays
						: policy.maxAgeDays === undefined
							? existing.maxAgeDays
							: Math.max(existing.maxAgeDays, policy.maxAgeDays),
			});
		}
	}
	const candidates: RetentionCandidate[] = [];
	async function visit(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const filePath = path.join(dir, entry);
			const stat = await fs.stat(filePath);
			if (stat.isDirectory()) {
				await visit(filePath);
				continue;
			}
			if (!stat.isFile()) continue;
			const relativePath = path.relative(stateRoot, filePath);
			const category = categoryForStateRelativePath(relativePath);
			if (!category) continue;
			const policy = policies.get(category);
			if (!policy) continue;
			candidates.push({ path: filePath, relativePath, category, mtimeMs: stat.mtimeMs, policy });
		}
	}
	await visit(stateRoot);
	return candidates;
}

function selectRetentionEligible(candidates: readonly RetentionCandidate[]): RetentionCandidate[] {
	const now = Date.now();
	const byCategory = new Map<string, RetentionCandidate[]>();
	for (const candidate of candidates) {
		const list = byCategory.get(candidate.category) ?? [];
		list.push(candidate);
		byCategory.set(candidate.category, list);
	}
	const eligible = new Set<RetentionCandidate>();
	for (const list of byCategory.values()) {
		list.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));
		for (let index = 0; index < list.length; index += 1) {
			const candidate = list[index];
			const keep = candidate.policy.keep ?? 0;
			if (keep > 0 && index < keep) continue;
			if (candidate.policy.maxAgeDays !== undefined) {
				const maxAgeMs = candidate.policy.maxAgeDays * 24 * 60 * 60 * 1000;
				if (now - candidate.mtimeMs < maxAgeMs) continue;
			}
			if (candidate.policy.keep !== undefined || candidate.policy.maxAgeDays !== undefined) eligible.add(candidate);
		}
	}
	return [...eligible].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function buildGcSummary(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
	dryRun: boolean,
): Promise<GcSummary> {
	const rawSkill =
		flagValue(args, "--skill")?.trim() || flagValue(args, "--mode")?.trim() || positionalSkill?.trim() || "all";
	if (rawSkill !== "all") assertKnownMode(rawSkill);
	const skills = rawSkill === "all" ? CANONICAL_GJC_WORKFLOW_SKILLS : [rawSkill as CanonicalGjcWorkflowSkill];
	const eligible = selectRetentionEligible(await collectRetentionCandidates(cwd, skills));
	const counts: Record<string, number> = {};
	for (const candidate of eligible) counts[candidate.category] = (counts[candidate.category] ?? 0) + 1;
	const targets: GenericHardPruneTarget[] = eligible.map(candidate => ({
		path: candidate.path,
		category: candidate.category,
	}));
	let pruned: string[] = [];
	if (!dryRun && targets.length > 0) {
		const eligiblePaths = new Set(eligible.map(candidate => path.resolve(candidate.path)));
		pruned = await hardPrune(targets, context => eligiblePaths.has(path.resolve(context.path)), {
			cwd,
			audit: {
				cwd,
				skill: rawSkill,
				category: "prune",
				verb: "gc",
				owner: "gjc-state-cli",
			},
		});
	}
	return {
		skill: rawSkill as CanonicalGjcWorkflowSkill | "all",
		dry_run: dryRun,
		eligible: eligible.map(candidate => candidate.relativePath),
		pruned: pruned.map(filePath => path.relative(path.join(cwd, ".gjc", "state"), filePath)),
		counts,
	};
}

async function handleGraph(
	args: readonly string[],
	_cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	if (hasFlag(args, "--history")) {
		const history = await readAuditWindow(_cwd, args);
		return {
			status: 0,
			stdout: hasFlag(args, "--json") ? `${JSON.stringify(history, null, 2)}\n` : renderHistoryMarkdown(history),
		};
	}
	const rawSkill = flagValue(args, "--skill")?.trim() || positionalSkill?.trim() || "all";
	if (rawSkill !== "all") assertKnownMode(rawSkill);
	const format = flagValue(args, "--format")?.trim() || "ascii";
	if (!GRAPH_FORMATS.has(format)) {
		throw new StateCommandError(2, `Invalid graph format: ${format}. Expected one of: ascii, mermaid, dot.`);
	}
	return {
		status: 0,
		stdout: renderStateGraph(rawSkill as CanonicalGjcWorkflowSkill | "all", format as StateGraphFormat),
	};
}

async function handlePrune(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.sessionId));
	if (!mode) {
		throw new StateCommandError(
			2,
			"gjc state prune requires --mode <skill>, positional <skill>, input.skill, or an active workflow in .gjc/state/skill-active-state.json",
		);
	}
	const filePath = modeStateFile(cwd, mode, selectors.sessionId);
	const olderThanDays = parseNonNegativeIntegerFlag(args, "--older-than");
	const status = flagValue(args, "--status")?.trim();
	const targets: GenericHardPruneTarget[] = [{ path: filePath, category: "prune" }];
	const audit: StateWriterAuditContext = {
		cwd,
		skill: mode,
		category: "prune",
		verb: hasFlag(args, "--hard") ? "hard-prune" : "soft-delete",
		owner: "gjc-state-cli",
	};
	const olderThanMs = olderThanDays === undefined ? undefined : olderThanDays * 24 * 60 * 60 * 1000;
	const matchesSelector = async (
		stat: { mtimeMs: number | bigint },
		readJson: () => Promise<unknown>,
	): Promise<boolean> => {
		const mtimeMs = typeof stat.mtimeMs === "bigint" ? Number(stat.mtimeMs) : stat.mtimeMs;
		if (olderThanMs !== undefined && Date.now() - mtimeMs < olderThanMs) return false;
		if (status) return statusFromFile(await readJson()) === status;
		return true;
	};
	if (hasFlag(args, "--hard")) {
		const pruned = await hardPrune(
			targets,
			context => (context.stat ? matchesSelector(context.stat, context.readJson) : false),
			{ cwd, audit },
		);
		return { status: 0, stdout: `${JSON.stringify({ skill: mode, hard: true, pruned }, null, 2)}\n` };
	}
	let deleted: string[] = [];
	try {
		const stat = await fs.stat(filePath);
		if (await matchesSelector(stat, async () => JSON.parse(await fs.readFile(filePath, "utf-8")))) {
			const archivedPath = await softDelete(
				filePath,
				{ skill: mode, reason: "gjc state prune", status: status ?? null, older_than_days: olderThanDays ?? null },
				{ cwd, audit },
			);
			deleted = [archivedPath];
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") throw error;
	}
	return { status: 0, stdout: `${JSON.stringify({ skill: mode, hard: false, soft_deleted: deleted }, null, 2)}\n` };
}

async function handleGc(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const summary = await buildGcSummary(args, cwd, positionalSkill, hasFlag(args, "--dry-run"));
	return { status: 0, stdout: `${JSON.stringify(summary, null, 2)}\n` };
}

async function handleMigrate(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.sessionId));
	if (!mode) {
		throw new StateCommandError(
			2,
			"gjc state migrate requires --mode <skill>, positional <skill>, input.skill, or an active workflow in .gjc/state/skill-active-state.json",
		);
	}
	const filePath = modeStateFile(cwd, mode, selectors.sessionId);
	const mismatchWarning = await warnAndAuditOutOfBandIfNeeded(cwd, filePath, mode, {
		forced: hasFlag(args, "--force"),
	});
	const result = await migrateAndPersistLegacyState({
		cwd,
		skill: mode,
		statePath: filePath,
		sessionId: selectors.sessionId,
	});
	return {
		status: 0,
		stdout: `${JSON.stringify({ skill: mode, ...result, integrity_mismatch: Boolean(mismatchWarning) }, null, 2)}\n`,
		...(mismatchWarning ? { stderr: `${mismatchWarning}\n` } : {}),
	};
}

export async function runNativeStateCommand(args: string[], cwd = process.cwd()): Promise<StateCommandResult> {
	try {
		const parsed = parsePositionalArgs(args);
		assertKnownFlags(args, parsed);
		switch (parsed.action) {
			case "read":
				if (hasFlag(args, "--migrate")) return await handleMigrate(args, cwd, parsed.positionalSkill);
				return await handleRead(args, cwd, parsed.positionalSkill);
			case "write":
				return await handleWrite(args, cwd, parsed.positionalSkill);
			case "clear":
				return await handleClear(args, cwd, parsed.positionalSkill);
			case "contract":
				return await handleContract(args, cwd, parsed.positionalSkill);
			case "status":
				return await handleStatus(args, cwd, parsed.positionalSkill);
			case "handoff":
				return await handleHandoff(args, cwd, parsed.positionalSkill);
			case "graph":
				return await handleGraph(args, cwd, parsed.positionalSkill);
			case "prune":
				return await handlePrune(args, cwd, parsed.positionalSkill);
			case "gc":
				return await handleGc(args, cwd, parsed.positionalSkill);
			case "migrate":
				return await handleMigrate(args, cwd, parsed.positionalSkill);
			default:
				return { status: 2, stderr: `Unknown gjc state command: ${parsed.action}\n` };
		}
	} catch (error) {
		if (error instanceof StateCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
