import { randomBytes } from "node:crypto";
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
	buildWorkflowStateReceipt,
	canonicalWorkflowSkill,
	describeWorkflowStateContract,
	type WorkflowStateReceipt,
} from "../skill-state/workflow-state-contract";

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

const FLAGS_WITH_VALUES = new Set(["--input", "--mode", "--session-id", "--thread-id", "--turn-id", "--to"]);
const ACTION_NAMES = new Set(["read", "write", "clear", "contract", "handoff"]);

interface ParsedInvocation {
	action: "read" | "write" | "clear" | "contract" | "handoff";
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
		return { action: first as ParsedInvocation["action"] };
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

	// Session-id resolution order: explicit --session-id flag, then payload
	// session_id, then GJC_SESSION_ID env var (set by AgentSession.sdk for
	// agent-initiated CLI invocations). The env-var default keeps shell
	// snippets in skill docs short while still routing writes/reads to the
	// caller's session-scoped state files.
	let sessionId = flagValue(args, "--session-id")?.trim() || undefined;
	if (!sessionId && payload && typeof payload.session_id === "string") {
		sessionId = payload.session_id.trim() || undefined;
	}
	if (!sessionId) {
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

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
	await fs.rename(tmp, filePath);
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
async function handleRead(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill);
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.sessionId));
	if (mode) {
		const filePath = modeStateFile(cwd, mode, selectors.sessionId);
		const existing = await readJsonFile(filePath);
		return {
			status: 0,
			stdout: `${JSON.stringify({ skill: mode, state: existing, storage_path: filePath }, null, 2)}\n`,
		};
	}
	const filePath = activeStateFile(cwd, selectors.sessionId);
	const existing = await readJsonFile(filePath);
	return { status: 0, stdout: `${JSON.stringify(existing ?? {}, null, 2)}\n` };
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
	const existing = await readJsonFile(filePath);
	const nowIsoStr = nowIso();
	const receipt = buildWorkflowStateReceipt({
		cwd,
		skill: mode,
		owner: "gjc-state-cli",
		command: `gjc state ${mode} write`,
		sessionId,
		nowIso: nowIsoStr,
	});
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
	await writeJsonAtomic(filePath, merged);

	const phase = typeof merged.current_phase === "string" ? merged.current_phase : undefined;
	const active = merged.active !== false;
	await syncWorkflowSkillState({ cwd, mode, sessionId, threadId, turnId, active, phase, payload: merged, receipt });

	return {
		status: 0,
		stdout: `${JSON.stringify({ skill: mode, state: merged, receipt }, null, 2)}\n`,
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
	await writeJsonAtomic(filePath, cleared);

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

	return { status: 0, stdout: `${JSON.stringify(cleared, null, 2)}\n` };
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
	const callerReceipt = buildWorkflowStateReceipt({
		cwd,
		skill: caller,
		owner: "gjc-state-cli",
		command: `gjc state ${caller} handoff --to ${callee}`,
		sessionId,
		nowIso: handoffAt,
	});
	const calleeReceipt = buildWorkflowStateReceipt({
		cwd,
		skill: callee,
		owner: "gjc-state-cli",
		command: `gjc state ${caller} handoff --to ${callee}`,
		sessionId,
		nowIso: handoffAt,
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

	// Atomic write order (architecture blocker AR-3): mode-state files first,
	// then a single atomic active-state mutation per file (session before root)
	// via applyHandoffToActiveState. The single-write transaction prevents the
	// HUD from observing a window where neither caller nor callee is active,
	// and write order keeps the session-scoped source of truth ahead of the
	// root aggregate. strict:true on the active-state read tolerates ENOENT
	// only; corrupt JSON / IO failures propagate as non-zero CLI status.
	await writeJsonAtomic(calleePath, mergedCalleeState);
	await writeJsonAtomic(callerPath, mergedCallerState);
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
	return { status: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
}

export async function runNativeStateCommand(args: string[], cwd = process.cwd()): Promise<StateCommandResult> {
	try {
		const parsed = parsePositionalArgs(args);
		switch (parsed.action) {
			case "read":
				return await handleRead(args, cwd, parsed.positionalSkill);
			case "write":
				return await handleWrite(args, cwd, parsed.positionalSkill);
			case "clear":
				return await handleClear(args, cwd, parsed.positionalSkill);
			case "contract":
				return await handleContract(args, cwd, parsed.positionalSkill);
			case "handoff":
				return await handleHandoff(args, cwd, parsed.positionalSkill);
			default:
				return { status: 2, stderr: `Unknown gjc state command: ${parsed.action}\n` };
		}
	} catch (error) {
		if (error instanceof StateCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
