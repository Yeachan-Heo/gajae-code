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
	buildRalplanHudSummary,
	buildTeamHudSummary,
	buildUltragoalHudSummary,
	deriveDeepInterviewHud,
} from "../skill-state/workflow-hud";
import {
	type AuditEntry,
	buildWorkflowStateReceipt,
	canonicalWorkflowSkill,
	describeWorkflowStateContract,
	WORKFLOW_STATE_VERSION,
	type WorkflowStateMutationOwner,
	type WorkflowStateReceipt,
} from "../skill-state/workflow-state-contract";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import { applyAmbiguityFloorToEnvelope } from "./deep-interview-ambiguity";
import { mergeDeepInterviewEnvelope, normalizeDeepInterviewEnvelope } from "./deep-interview-state";
import { activeSnapshotPath, auditPath, modeStatePath, sessionStateDir } from "./session-layout";
import {
	resolveGjcSessionForRead,
	resolveGjcSessionForWrite,
	SessionResolutionError,
	writeSessionActivityMarker,
} from "./session-resolution";
import { renderStateGraph, type StateGraphFormat } from "./state-graph";
import { migrateAndPersistLegacyState, migrateWorkflowState } from "./state-migrations";
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
	readExistingStateForMutation,
	type StateWriterAuditContext,
	softDelete,
	updateWorkflowTransactionJournal,
	type WorkflowEnvelopeIntegrityMismatch,
	writeGuardedWorkflowEnvelopeAtomic,
} from "./state-writer";
import { getSkillManifest, isKnownWorkflowState, isValidTransition, typedArgsFor } from "./workflow-manifest";

/**
 * Native implementation of the `gjc state read|write|clear` command surface.
 *
 * Simple file-receipt operations against session-scoped state under
 * `.gjc/_session-{id}/state/`. This is the sanctioned CLI mediator for
 * mutation-guarded GJC state — agents call it instead of editing those files directly.
 */

export interface StateCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const SKILL_ACTIVE_STATE_FILE = "skill-active-state.json";
const TERMINAL_CLEAR_PHASES = new Set(["complete", "completed", "cancelled", "canceled", "failed"]);
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
	"doctor",
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
	action:
		| "read"
		| "write"
		| "clear"
		| "contract"
		| "handoff"
		| "graph"
		| "prune"
		| "gc"
		| "migrate"
		| "status"
		| "doctor";
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
function isKnownMode(mode: string): mode is CanonicalGjcWorkflowSkill {
	return KNOWN_MODES.includes(mode);
}

function assertKnownMode(mode: string): asserts mode is CanonicalGjcWorkflowSkill {
	if (!isKnownMode(mode)) {
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
	gjcSessionId: string;
	threadId: string | undefined;
	turnId: string | undefined;
	payload: Record<string, unknown> | undefined;
}

// `clear` resolves like a read (explicit -> payload -> env -> latest-activity marker)
// per the spec: read/status/clear may fall back to the most-recent session. Commands
// that create or mutate new state roots still require an explicit/env session id.
const WRITE_SESSION_ACTIONS = new Set<ParsedInvocation["action"]>(["write", "handoff", "prune", "migrate"]);

async function resolveSelectors(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
	action: ParsedInvocation["action"],
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

	const sessionSources = {
		flagValue: flagValue(args, "--session-id"),
		payloadSessionId: payload?.session_id,
		envSessionId: process.env.GJC_SESSION_ID,
	};
	const session = WRITE_SESSION_ACTIONS.has(action)
		? resolveGjcSessionForWrite(cwd, sessionSources)
		: await resolveGjcSessionForRead(cwd, sessionSources);

	const threadId = flagValue(args, "--thread-id")?.trim() || undefined;
	if (threadId) assertSafePathComponent(threadId, "thread-id");
	const turnId = flagValue(args, "--turn-id")?.trim() || undefined;
	if (turnId) assertSafePathComponent(turnId, "turn-id");

	return {
		mode: mode as CanonicalGjcWorkflowSkill | undefined,
		gjcSessionId: session.gjcSessionId,
		threadId,
		turnId,
		payload,
	};
}

async function inferModeFromActiveState(
	cwd: string,
	sessionId: string,
): Promise<CanonicalGjcWorkflowSkill | undefined> {
	const state = await readVisibleSkillActiveState(cwd, sessionId);
	const entries = listActiveSkills(state);
	const candidate = entries[0]?.skill ?? state?.skill;
	if (!candidate) return undefined;
	const canonical = canonicalWorkflowSkill(candidate);
	return canonical ?? undefined;
}

function stateDirFor(cwd: string, sessionId: string): string {
	return sessionStateDir(cwd, sessionId);
}

function modeStateFile(cwd: string, mode: string, sessionId: string): string {
	return modeStatePath(cwd, sessionId, mode);
}

function activeStateFile(cwd: string, sessionId: string): string {
	return activeSnapshotPath(cwd, sessionId);
}

function stateRelativePath(cwd: string, filePath: string): string {
	return path.relative(cwd, filePath).split(path.sep).join(path.posix.sep);
}

async function touchStateActivityMarker(cwd: string, sessionId: string, filePath: string): Promise<void> {
	await writeSessionActivityMarker(cwd, sessionId, {
		writer: "state-runtime",
		path: stateRelativePath(cwd, filePath),
	});
}

async function readActivePhaseForSkill(
	cwd: string,
	sessionId: string,
	mode: CanonicalGjcWorkflowSkill,
): Promise<string | undefined> {
	const state = await readVisibleSkillActiveState(cwd, sessionId);
	const entries = listActiveSkills(state);
	const entry = entries.find(item => item.skill === mode) ?? (state?.skill === mode ? state : undefined);
	return isPlainObject(entry) && typeof entry.phase === "string" ? entry.phase.trim() || undefined : undefined;
}

async function describeStaleClearState(
	cwd: string,
	sessionId: string,
	mode: CanonicalGjcWorkflowSkill,
	existing: Record<string, unknown>,
): Promise<string | undefined> {
	const phase = typeof existing.current_phase === "string" ? existing.current_phase.trim() : undefined;
	if (phase && TERMINAL_CLEAR_PHASES.has(phase)) return `mode-state is already terminal (${phase})`;
	const activePhase = await readActivePhaseForSkill(cwd, sessionId, mode);
	if (activePhase && phase && activePhase !== phase) {
		return `active-state phase ${activePhase} differs from mode-state phase ${phase}`;
	}
	return undefined;
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
		process.stderr.write(`WARNING: failed to read ${filePath}; ignoring corrupt state: ${err.message}\n`);
		return null;
	}
}

async function readJsonValue(filePath: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf-8"));
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return null;
		process.stderr.write(`WARNING: failed to read ${filePath}; ignoring corrupt state: ${err.message}\n`);
		return null;
	}
}

type DoctorProblemType = "orphan_journal" | "checksum_mismatch" | "schema_violation" | "stale_active_state";

interface DoctorProblem {
	type: DoctorProblemType;
	skill?: CanonicalGjcWorkflowSkill;
	path: string;
	message: string;
	fixCommand: string;
}

interface DoctorSummary {
	ok: boolean;
	root: string;
	summary: {
		skills_scanned: number;
		files_scanned: number;
		journals_scanned: number;
		findings_total: number;
		by_kind: Record<DoctorProblemType, number>;
	};
	problems: DoctorProblem[];
}

async function readRawJson(filePath: string): Promise<{ exists: boolean; value?: unknown; error?: string }> {
	try {
		return { exists: true, value: JSON.parse(await fs.readFile(filePath, "utf-8")) };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { exists: false };
		return { exists: true, error: err.message };
	}
}

async function listJsonFiles(dir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter(entry => entry.endsWith(".json"))
		.sort()
		.map(entry => path.join(dir, entry));
}

function doctorProblem(
	type: DoctorProblemType,
	pathValue: string,
	message: string,
	fixCommand: string,
	skill?: CanonicalGjcWorkflowSkill,
): DoctorProblem {
	return skill
		? { type, skill, path: pathValue, message, fixCommand }
		: { type, path: pathValue, message, fixCommand };
}

function activeEntryDir(cwd: string, sessionId: string): string {
	return path.join(stateDirFor(cwd, sessionId), "active");
}

function skillFromActiveValue(value: unknown): string | undefined {
	return isPlainObject(value) && typeof value.skill === "string" ? value.skill : undefined;
}

function activeFlag(value: unknown): boolean {
	return isPlainObject(value) && value.active !== false;
}

function phaseFromActiveValue(value: unknown): string | undefined {
	if (!isPlainObject(value) || typeof value.phase !== "string") return undefined;
	const phase = value.phase.trim();
	return phase || undefined;
}

const RALPLAN_CANONICAL_PHASE_OVERRIDES = new Set([
	"final",
	"handoff",
	"complete",
	"completed",
	"failed",
	"cancelled",
	"canceled",
	"inactive",
]);

function modeStatePhase(value: unknown): string | undefined {
	if (!isPlainObject(value) || typeof value.current_phase !== "string") return undefined;
	const phase = value.current_phase.trim();
	if (!phase) return undefined;
	if (value.active === false && !RALPLAN_CANONICAL_PHASE_OVERRIDES.has(phase)) return undefined;
	return phase;
}

function pushPhaseDriftProblem(options: {
	problems: DoctorProblem[];
	pathValue: string;
	skill: CanonicalGjcWorkflowSkill;
	entryKind: "active entry" | "active snapshot";
	entrySkill: string;
	entryPhase: string | undefined;
	statePhase: string | undefined;
}): void {
	if (!options.entryPhase || !options.statePhase || options.entryPhase === options.statePhase) return;
	options.problems.push(
		doctorProblem(
			"stale_active_state",
			options.pathValue,
			`${options.entryKind} for ${options.entrySkill} phase ${options.entryPhase} differs from canonical mode-state phase ${options.statePhase}`,
			`gjc state ${options.skill} clear`,
			options.skill,
		),
	);
}

async function collectDoctorSummary(
	cwd: string,
	skill: CanonicalGjcWorkflowSkill | undefined,
	sessionId: string,
): Promise<DoctorSummary> {
	const root = sessionStateDir(cwd, sessionId);
	const skills = skill ? [skill] : [...CANONICAL_GJC_WORKFLOW_SKILLS];
	const problems: DoctorProblem[] = [];
	let filesScanned = 0;
	let journalsScanned = 0;
	const invalidModeStates = new Set<string>();

	for (const currentSkill of skills) {
		const filePath = modeStateFile(cwd, currentSkill, sessionId);
		const raw = await readRawJson(filePath);
		if (!raw.exists) continue;
		filesScanned += 1;
		if (raw.error) {
			problems.push(
				doctorProblem(
					"schema_violation",
					filePath,
					`mode-state JSON is unreadable: ${raw.error}`,
					`gjc state ${currentSkill} migrate`,
					currentSkill,
				),
			);
			invalidModeStates.add(currentSkill);
			continue;
		}
		const validation = validateWorkflowStateEnvelope(currentSkill, raw.value);
		if (!validation.valid) {
			problems.push(
				doctorProblem(
					"schema_violation",
					filePath,
					validation.error ?? `invalid ${currentSkill} state envelope`,
					`gjc state ${currentSkill} migrate`,
					currentSkill,
				),
			);
			invalidModeStates.add(currentSkill);
		}
		const mismatch = await detectWorkflowEnvelopeIntegrityMismatch(filePath);
		if (mismatch) {
			problems.push(
				doctorProblem(
					"checksum_mismatch",
					filePath,
					`expected sha256 ${mismatch.expected} but found ${mismatch.actual}`,
					`gjc state ${currentSkill} migrate`,
					currentSkill,
				),
			);
			invalidModeStates.add(currentSkill);
		}
	}

	const journalFiles = await listJsonFiles(path.join(root, "transactions"));
	for (const journalPath of journalFiles) {
		journalsScanned += 1;
		const raw = await readRawJson(journalPath);
		const value = raw.value;
		const status = isPlainObject(value) && typeof value.status === "string" ? value.status : undefined;
		const paths =
			isPlainObject(value) && Array.isArray(value.paths) ? value.paths.filter(p => typeof p === "string") : [];
		const hasLiveMutation = status === "pending" && paths.some(filePath => path.resolve(filePath).startsWith(root));
		if (!hasLiveMutation) {
			problems.push(
				doctorProblem(
					"orphan_journal",
					journalPath,
					"transaction journal has no matching live mutation",
					"gjc state prune --hard",
				),
			);
		}
	}

	const inspectActiveScope = async (scopeSessionId: string): Promise<void> => {
		const snapshotPath = activeStateFile(cwd, scopeSessionId);
		const snapshot = await readRawJson(snapshotPath);
		if (snapshot.exists) filesScanned += 1;
		const entryFiles = await listJsonFiles(activeEntryDir(cwd, scopeSessionId));
		const entrySkills = new Set<string>();
		for (const entryPath of entryFiles) {
			filesScanned += 1;
			const entry = await readRawJson(entryPath);
			const entrySkill = skillFromActiveValue(entry.value) ?? path.basename(entryPath, ".json");
			entrySkills.add(entrySkill);
			const canonical = canonicalWorkflowSkill(entrySkill);
			if (canonical && !skills.includes(canonical)) continue;
			const statePath = canonical
				? modeStateFile(cwd, canonical, scopeSessionId)
				: path.join(root, `${entrySkill}-state.json`);
			const state = await readRawJson(statePath);
			if (activeFlag(entry.value) && (!state.exists || !activeFlag(state.value))) {
				problems.push(
					doctorProblem(
						"stale_active_state",
						entryPath,
						`active entry for ${entrySkill} does not match a live active mode-state`,
						canonical ? `gjc state ${canonical} clear` : "gjc state prune --hard",
						canonical ?? undefined,
					),
				);
			}
			if (canonical && activeFlag(entry.value) && !invalidModeStates.has(canonical)) {
				pushPhaseDriftProblem({
					problems,
					pathValue: entryPath,
					skill: canonical,
					entryKind: "active entry",
					entrySkill,
					entryPhase: phaseFromActiveValue(entry.value),
					statePhase: modeStatePhase(state.value),
				});
			}
		}
		if (isPlainObject(snapshot.value)) {
			const activeSkills: unknown[] = Array.isArray(snapshot.value.active_skills)
				? snapshot.value.active_skills
				: [];
			for (const entry of activeSkills) {
				const entrySkill = skillFromActiveValue(entry);
				if (!entrySkill) continue;
				const canonical = canonicalWorkflowSkill(entrySkill);
				if (canonical && !skills.includes(canonical)) continue;
				if (activeFlag(entry) && !entrySkills.has(entrySkill)) {
					problems.push(
						doctorProblem(
							"stale_active_state",
							snapshotPath,
							`active snapshot lists ${entrySkill} but no raw per-skill active entry exists`,
							canonical ? `gjc state ${canonical} clear` : "gjc state prune --hard",
							canonical ?? undefined,
						),
					);
				}
				if (canonical && activeFlag(entry) && !invalidModeStates.has(canonical)) {
					const state = await readRawJson(modeStateFile(cwd, canonical, scopeSessionId));
					pushPhaseDriftProblem({
						problems,
						pathValue: snapshotPath,
						skill: canonical,
						entryKind: "active snapshot",
						entrySkill,
						entryPhase: phaseFromActiveValue(entry),
						statePhase: modeStatePhase(state.value),
					});
				}
			}
		}
	};

	await inspectActiveScope(sessionId);

	problems.sort(
		(a, b) =>
			a.type.localeCompare(b.type) || (a.skill ?? "").localeCompare(b.skill ?? "") || a.path.localeCompare(b.path),
	);
	const byKind: Record<DoctorProblemType, number> = {
		orphan_journal: 0,
		checksum_mismatch: 0,
		schema_violation: 0,
		stale_active_state: 0,
	};
	for (const problem of problems) byKind[problem.type] += 1;
	return {
		ok: problems.length === 0,
		root,
		summary: {
			skills_scanned: skills.length,
			files_scanned: filesScanned,
			journals_scanned: journalsScanned,
			findings_total: problems.length,
			by_kind: byKind,
		},
		problems,
	};
}

function renderDoctorText(summary: DoctorSummary): string {
	const lines = [
		`ok: ${summary.ok}`,
		`root: ${summary.root}`,
		`skills_scanned: ${summary.summary.skills_scanned}`,
		`files_scanned: ${summary.summary.files_scanned}`,
		`journals_scanned: ${summary.summary.journals_scanned}`,
		`findings_total: ${summary.summary.findings_total}`,
		`counts: ${Object.entries(summary.summary.by_kind)
			.map(([kind, count]) => `${kind}=${count}`)
			.join(", ")}`,
	];
	for (const problem of summary.problems) {
		lines.push(
			`finding: kind=${problem.type} skill=${problem.skill ?? "-"} path=${problem.path} message=${problem.message} fix=${problem.fixCommand}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

async function handleDoctor(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const rawSkill = flagValue(args, "--skill")?.trim() || flagValue(args, "--mode")?.trim() || positionalSkill?.trim();
	if (rawSkill) assertKnownMode(rawSkill);
	const payload = await readInputJson(flagValue(args, "--input"), cwd);
	const session = await resolveGjcSessionForRead(cwd, {
		flagValue: flagValue(args, "--session-id"),
		payloadSessionId: payload?.session_id,
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const summary = await collectDoctorSummary(
		cwd,
		rawSkill as CanonicalGjcWorkflowSkill | undefined,
		session.gjcSessionId,
	);
	return {
		status: summary.ok ? 0 : 1,
		stdout: hasFlag(args, "--json") ? `${JSON.stringify(summary, null, 2)}\n` : renderDoctorText(summary),
	};
}

async function warnAndAuditOutOfBandIfNeeded(
	cwd: string,
	sessionId: string,
	filePath: string,
	skill: CanonicalGjcWorkflowSkill,
	options?: { mutationId?: string; forced?: boolean },
): Promise<string | undefined> {
	let mismatch: WorkflowEnvelopeIntegrityMismatch | undefined;
	try {
		mismatch = await detectWorkflowEnvelopeIntegrityMismatch(filePath);
	} catch {
		// Unparseable/corrupt state has no recoverable checksum to compare; the strict
		// mutation reader already gates unforced overwrites, so fail-open here.
		return undefined;
	}
	if (!mismatch) return undefined;
	const message = `WARNING: workflow mode-state out-of-band edit detected for ${skill}: ${filePath} expected sha256 ${mismatch.expected} but found ${mismatch.actual}`;
	await appendAuditEntry(cwd, sessionId, {
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

function existingStateRevision(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const revision = (value as Record<string, unknown>).state_revision;
	return typeof revision === "number" && Number.isFinite(revision) ? revision : 0;
}

async function writeJsonAtomic(
	cwd: string,
	filePath: string,
	value: unknown,
	verb: "write" | "clear" | "handoff" | "reconcile" = "write",
	options?: {
		sessionId: string;
		skill?: CanonicalGjcWorkflowSkill;
		mutationId?: string;
		force?: boolean;
		fromPhase?: string;
		toPhase?: string;
		owner?: WorkflowStateMutationOwner;
	},
): Promise<{ warning?: string; stamped: Record<string, unknown>; revision: number }> {
	const warning = options?.skill
		? await warnAndAuditOutOfBandIfNeeded(cwd, options.sessionId, filePath, options.skill, {
				mutationId: options.mutationId,
				forced: options.force ?? false,
			})
		: undefined;
	if (warning && !options?.force) {
		throw new StateCommandError(2, `${warning}; use --force to overwrite tampered mode-state`);
	}
	// Authoritative CLI/runtime write. Stamp the next state_revision under the
	// writer lock; do not enforce an optimistic `expectedRevision` here (tamper
	// detection is handled by warnAndAuditOutOfBandIfNeeded above, and a forced
	// write must succeed over corrupt/missing prior state).
	const writeResult = await writeGuardedWorkflowEnvelopeAtomic(filePath, value, {
		cwd,
		policy: "source",
		audit: {
			sessionId: options?.sessionId ?? "",
			category: "state",
			verb,
			owner: options?.owner ?? "gjc-state-cli",
			skill: options?.skill,
			mutationId: options?.mutationId,
			fromPhase: options?.fromPhase,
			toPhase: options?.toPhase,
			forced: options?.force ?? false,
		},
	});
	// `writeResult.stamped` and `.revision` are computed inside the writer lock, so they are
	// the envelope/revision this write actually owns. Never post-lock re-read here: a concurrent
	// writer could advance the file before that read and make this payload publish another
	// writer's newer revision into the derived active-state cache.
	if (!writeResult.written || !isPlainObject(writeResult.stamped)) {
		throw new Error(`state writer did not return a stamped workflow envelope for ${filePath}`);
	}
	return { warning, stamped: writeResult.stamped, revision: writeResult.revision };
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
	sessionId: string,
): Promise<{ entries: unknown[]; limit: number; since?: string; truncated: boolean }> {
	const limit = parseLimitFlag(args);
	const since = parseSinceFlag(args);
	const auditFile = auditPath(cwd, sessionId);
	let raw = "";
	try {
		raw = await fs.readFile(auditFile, "utf-8");
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
	switch (mode) {
		case "deep-interview":
			return deriveDeepInterviewHud(payload, { updatedAt });
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
			const rawLedger = payload.latestLedgerEvent;
			const latestLedgerEvent =
				rawLedger && typeof rawLedger === "object" && !Array.isArray(rawLedger)
					? {
							event:
								typeof (rawLedger as Record<string, unknown>).event === "string"
									? ((rawLedger as Record<string, unknown>).event as string)
									: undefined,
							goalId:
								typeof (rawLedger as Record<string, unknown>).goalId === "string"
									? ((rawLedger as Record<string, unknown>).goalId as string)
									: undefined,
							timestamp:
								typeof (rawLedger as Record<string, unknown>).timestamp === "string"
									? ((rawLedger as Record<string, unknown>).timestamp as string)
									: undefined,
							kind:
								typeof (rawLedger as Record<string, unknown>).kind === "string"
									? ((rawLedger as Record<string, unknown>).kind as string)
									: undefined,
							evidence:
								typeof (rawLedger as Record<string, unknown>).evidence === "string"
									? ((rawLedger as Record<string, unknown>).evidence as string)
									: undefined,
						}
					: undefined;
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
				latestLedgerEvent,
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
	sessionId: string;
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
			sourceRevision: existingStateRevision(options.payload),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

/**
 * Reconcile a workflow skill's mode-state + active-state/HUD from a caller-derived
 * payload. Unlike `gjc state write`, this is a derived repair: callers reconcile from
 * an authoritative source (e.g. the ultragoal plan/ledger), where intermediate
 * aggregate phases like ultragoal `active -> pending` are legitimate, so it bypasses
 * ONLY verb transition-edge validation while preserving schema validation,
 * unknown-phase rejection, version/checksum stamping, and audit/out-of-band tamper
 * detection. Receipts carry `owner: "gjc-runtime"` and `verb: "reconcile"` so the
 * provenance is distinguishable from a user-initiated write.
 */
export async function reconcileWorkflowSkillState(options: {
	cwd: string;
	mode: CanonicalGjcWorkflowSkill;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	active: boolean;
	phase: string;
	payload: Record<string, unknown>;
	sourceRevision?: number;
}): Promise<{ stateFile: string }> {
	const { cwd, mode, threadId, turnId, active, payload } = options;
	const { gjcSessionId: sessionId } = resolveGjcSessionForWrite(cwd, {
		payloadSessionId: options.sessionId,
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const filePath = modeStateFile(cwd, mode, sessionId);
	const existingRead = await readExistingStateForMutation(filePath);
	const existingPayload = existingRead.kind === "valid" ? existingRead.value : {};
	const nowIsoStr = nowIso();
	const mutationId = `${mode}:reconcile:${nowIsoStr}`;

	const trimmedPhase = options.phase.trim();
	const manifestStates = new Set(getSkillManifest(mode).states.map(state => state.id));
	if (!manifestStates.has(trimmedPhase)) {
		throw new StateCommandError(2, `unknown ${mode} phase "${trimmedPhase}" for reconciliation`);
	}

	const fromPhase =
		typeof existingPayload.current_phase === "string" ? existingPayload.current_phase.trim() : undefined;
	const receipt = buildWorkflowStateReceipt({
		cwd,
		skill: mode,
		owner: "gjc-runtime",
		command: `gjc ${mode} (reconcile)`,
		sessionId,
		nowIso: nowIsoStr,
		mutationId,
	});
	receipt.verb = "reconcile";
	receipt.forced = true;
	receipt.from_phase = fromPhase;
	receipt.to_phase = trimmedPhase;

	const merged =
		mode === "deep-interview"
			? // Enforce the deterministic ambiguity floor on every reconcile so a
				// self-reported score can never undercut persisted contradiction evidence.
				(applyAmbiguityFloorToEnvelope(mergeDeepInterviewEnvelope(existingPayload, payload)).envelope as Record<
					string,
					unknown
				>)
			: mergeWithNullDelete(existingPayload, payload);
	merged.skill = mode;
	merged.current_phase = trimmedPhase;
	merged.active = active;
	merged.version = WORKFLOW_STATE_VERSION;
	merged.updated_at = nowIsoStr;
	merged.receipt = receipt;
	if (sessionId && typeof merged.session_id !== "string") merged.session_id = sessionId;

	const validation = validateWorkflowStateEnvelope(mode, merged);
	if (!validation.valid) throw new StateCommandError(2, validation.error ?? `invalid ${mode} state envelope`);

	if (existingRead.kind === "corrupt") await fs.rm(filePath, { force: true });
	await writeGuardedWorkflowEnvelopeAtomic(filePath, merged, {
		cwd,
		policy: "source",
		receipt: {
			cwd,
			skill: mode,
			owner: "gjc-runtime",
			command: `gjc ${mode} (reconcile)`,
			sessionId,
			nowIso: nowIsoStr,
			mutationId,
			verb: "reconcile",
			forced: true,
			fromPhase,
			toPhase: trimmedPhase,
		},
		audit: {
			category: "state",
			verb: "reconcile",
			owner: "gjc-runtime",
			sessionId,
			skill: mode,
			mutationId,
			forced: true,
			fromPhase,
			toPhase: trimmedPhase,
		},
	});
	const persisted = (await readJsonFile(filePath)) ?? {};
	const sourceRevision = options.sourceRevision ?? existingStateRevision(persisted);

	// Reconciliation drives the active-state/HUD update directly (not via the
	// best-effort syncWorkflowSkillState wrapper) so a failed HUD/active-state write
	// is surfaced to the caller and recorded as a reconcile failure, rather than
	// silently leaving a stale chip behind a freshly reconciled mode-state.
	await syncSkillActiveState({
		cwd,
		skill: mode,
		active,
		phase: trimmedPhase,
		sessionId,
		threadId,
		turnId,
		source: "gjc-runtime-reconcile",
		hud: buildHudForMode(mode, merged),
		receipt,
		sourceRevision,
	});
	await touchStateActivityMarker(cwd, sessionId, filePath);
	return { stateFile: filePath };
}
export async function readWorkflowStateJson(
	cwd: string,
	skill: CanonicalGjcWorkflowSkill,
	sessionId?: string,
): Promise<Record<string, unknown>> {
	const session = await resolveGjcSessionForRead(cwd, {
		payloadSessionId: sessionId,
		envSessionId: process.env.GJC_SESSION_ID,
	});
	return (await readJsonFile(modeStateFile(cwd, skill, session.gjcSessionId))) ?? {};
}

async function handleRead(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "read");
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.gjcSessionId));
	const fields = parseFieldsFlag(args);
	if (mode) {
		const filePath = modeStateFile(cwd, mode, selectors.gjcSessionId);
		const existing = await readWorkflowStateJson(cwd, mode, selectors.gjcSessionId);
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
	const filePath = activeStateFile(cwd, selectors.gjcSessionId);
	const existingRaw = await readJsonValue(filePath);
	const existing = isPlainObject(existingRaw) ? existingRaw : null;
	return { status: 0, stdout: `${JSON.stringify(existing ?? {}, null, 2)}\n` };
}

async function handleStatus(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "read");
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.gjcSessionId));
	if (!mode) {
		throw new StateCommandError(
			2,
			"gjc state status requires --mode <skill>, positional <skill>, input.skill, or an active workflow in the current session active state",
		);
	}
	const filePath = modeStateFile(cwd, mode, selectors.gjcSessionId);
	const existing = await readWorkflowStateJson(cwd, mode, selectors.gjcSessionId);
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
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "write");
	const { gjcSessionId: sessionId, threadId, turnId, payload } = selectors;
	if (!payload) throw new StateCommandError(2, "gjc state write requires --input '<json>'");
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, sessionId));
	if (!mode)
		throw new StateCommandError(
			2,
			"gjc state write requires --mode <skill>, positional <skill>, input.skill, or an active workflow in the current session active state",
		);

	const filePath = modeStateFile(cwd, mode, sessionId);
	const forced = hasFlag(args, "--force");
	const existingRead = await readExistingStateForMutation(filePath);
	if (existingRead.kind === "corrupt" && !forced) {
		throw new StateCommandError(
			2,
			`existing state for ${mode} is corrupt or tampered (${existingRead.error}); use --force to overwrite`,
		);
	}
	const existingPayload = existingRead.kind === "valid" ? existingRead.value : {};
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
	if (mode === "deep-interview") {
		// Deep-interview keeps interview data nested under `state` and merges rounds
		// losslessly by durable key; never flatten or delete `state` (that drops recorder history).
		// The deterministic ambiguity floor is applied after the merge so a reported
		// score written through the CLI can never undercut persisted contradiction evidence.
		merged = applyAmbiguityFloorToEnvelope(
			mergeDeepInterviewEnvelope(existingPayload, payload, { replace: hasFlag(args, "--replace") }),
		).envelope;
	} else if (hasFlag(args, "--replace")) {
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
	} else if (typeof merged.current_phase !== "string" || !merged.current_phase.trim()) {
		const retainedPhase =
			typeof existingPayload.current_phase === "string" ? existingPayload.current_phase.trim() : "";
		merged.current_phase = retainedPhase || initialPhaseForSkill(mode);
	} else {
		merged.current_phase = merged.current_phase.trim();
	}
	merged.version = WORKFLOW_STATE_VERSION;
	if (typeof merged.active !== "boolean") merged.active = true;
	merged.updated_at = nowIsoStr;
	merged.receipt = receipt;
	if (sessionId && typeof merged.session_id !== "string") merged.session_id = sessionId;

	const fromPhase =
		typeof existingPayload.current_phase === "string" ? existingPayload.current_phase.trim() : undefined;
	const toPhase = merged.current_phase as string;
	const manifestStates = new Set(getSkillManifest(mode).states.map(state => state.id));
	if (!manifestStates.has(toPhase) && !forced) {
		throw new StateCommandError(2, `unknown ${mode} phase "${toPhase}"; use --force to bypass`);
	}
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

	const {
		warning: outOfBandWarning,
		stamped,
		revision: stampedRevision,
	} = await writeJsonAtomic(cwd, filePath, merged, "write", {
		sessionId,
		skill: mode,
		mutationId,
		force: forced,
		fromPhase,
		toPhase,
	});
	const stampedReceipt = isPlainObject(stamped.receipt) ? stamped.receipt : {};

	const phase = typeof merged.current_phase === "string" ? merged.current_phase : undefined;
	const active = merged.active !== false;
	// Reflect the lock-owned mode-state revision onto the in-memory payload so the active-state/HUD
	// sync derives a `sourceRevision` from the revision this write actually owns (computed inside the
	// writer lock), not the stale pre-write value or a post-lock re-read a concurrent writer could
	// have advanced; otherwise the active-state writer stale-skips the update and the mirror keeps the
	// prior phase (e.g. staying "interviewing" after a "handoff" write).
	merged.state_revision = stampedRevision;
	await syncWorkflowSkillState({ cwd, mode, sessionId, threadId, turnId, active, phase, payload: merged, receipt });
	await touchStateActivityMarker(cwd, sessionId, filePath);

	return {
		status: 0,
		stdout: renderCliWriteReceipt({
			ok: true,
			skill: mode,
			state_path: receipt.state_path,
			current_phase: phase,
			active,
			mutation_id: typeof stampedReceipt.mutation_id === "string" ? stampedReceipt.mutation_id : mutationId,
			status: typeof stampedReceipt.status === "string" ? stampedReceipt.status : undefined,
			content_sha256: stampedReceipt.content_sha256,
		}),
		...(outOfBandWarning ? { stderr: `${outOfBandWarning}\n` } : {}),
	};
}

async function handleClear(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "clear");
	const { gjcSessionId: sessionId, threadId, turnId } = selectors;
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, sessionId));
	if (!mode)
		throw new StateCommandError(
			2,
			"gjc state clear requires --mode <skill>, positional <skill>, input.skill, or an active workflow in the current session active state",
		);

	const filePath = modeStateFile(cwd, mode, sessionId);
	const forced = hasFlag(args, "--force");
	const existingRead = await readExistingStateForMutation(filePath);
	if (existingRead.kind === "corrupt" && !forced) {
		throw new StateCommandError(
			2,
			`existing state for ${mode} is corrupt or tampered (${existingRead.error}); use --force to overwrite`,
		);
	}
	const existing = existingRead.kind === "valid" ? existingRead.value : {};
	const staleReason = await describeStaleClearState(cwd, sessionId, mode, existing);
	if (staleReason && !forced) {
		throw new StateCommandError(2, `existing state for ${mode} is stale (${staleReason}); use --force to clear`);
	}
	const clearedAt = nowIso();
	const cleared: Record<string, unknown> = {
		skill: mode,
		...existing,
		active: false,
		current_phase: "complete",
		updated_at: clearedAt,
		version: WORKFLOW_STATE_VERSION,
	};
	cleared.skill = mode;
	const mutationId = `${mode}:clear:${clearedAt}`;
	const receipt = buildWorkflowStateReceipt({
		cwd,
		skill: mode,
		owner: "gjc-state-cli",
		command: `gjc state ${mode} clear`,
		sessionId,
		nowIso: clearedAt,
		mutationId,
	});
	cleared.receipt = receipt;
	const { warning: outOfBandWarning, stamped } = await writeJsonAtomic(cwd, filePath, cleared, "clear", {
		sessionId,
		skill: mode,
		mutationId,
		force: forced,
		fromPhase: typeof existing.current_phase === "string" ? existing.current_phase : undefined,
		toPhase: "complete",
	});
	const stampedReceipt = isPlainObject(stamped.receipt) ? stamped.receipt : {};

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
	await touchStateActivityMarker(cwd, sessionId, filePath);
	return {
		status: 0,
		stdout: renderCliWriteReceipt({
			ok: true,
			skill: mode,
			state_path: receipt.state_path,
			active: false,
			current_phase: typeof cleared.current_phase === "string" ? cleared.current_phase : undefined,
			mutation_id: typeof stampedReceipt.mutation_id === "string" ? stampedReceipt.mutation_id : mutationId,
			status: typeof stampedReceipt.status === "string" ? stampedReceipt.status : undefined,
			content_sha256: stampedReceipt.content_sha256,
		}),
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
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "handoff");
	const { gjcSessionId: sessionId, threadId, turnId } = selectors;
	const caller = selectors.mode ?? (await inferModeFromActiveState(cwd, sessionId));
	if (!caller) {
		throw new StateCommandError(
			2,
			"gjc state handoff requires --mode <caller>, positional <caller>, input.skill, or an active workflow in the current session active state",
		);
	}
	const calleeRaw = flagValue(args, "--to")?.trim();
	if (!calleeRaw) {
		throw new StateCommandError(2, "gjc state handoff requires --to <callee>");
	}
	assertSafePathComponent(calleeRaw, "to");
	const callee = calleeRaw;
	const calleeIsWorkflow = isKnownMode(callee);
	if (callee === caller) {
		throw new StateCommandError(2, `gjc state handoff: --to must differ from caller (both are "${caller}")`);
	}

	const callerPath = modeStateFile(cwd, caller, sessionId);
	const calleePath = calleeIsWorkflow ? modeStateFile(cwd, callee, sessionId) : undefined;
	const forced = hasFlag(args, "--force");
	const callerRead = await readExistingStateForMutation(callerPath);
	if (callerRead.kind === "corrupt" && !forced) {
		throw new StateCommandError(
			2,
			`existing state for ${caller} is corrupt or tampered (${callerRead.error}); use --force to overwrite`,
		);
	}
	if (callerRead.kind === "absent") {
		throw new StateCommandError(
			2,
			`gjc state ${caller} handoff: caller is not active (no mode-state file at ${callerPath})`,
		);
	}
	const existingCaller = callerRead.kind === "valid" ? callerRead.value : {};

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

	// Runtime callees have no native mode-state to clear later, so do not
	// persist them as active-state entries; the prompt observer tracks them
	// in memory the same way direct `/skill:<runtime>` invocation does.
	if (!calleeIsWorkflow) {
		const normalizedCaller =
			caller === "deep-interview"
				? (normalizeDeepInterviewEnvelope(migrateWorkflowState(existingCaller, caller).state) as Record<
						string,
						unknown
					>)
				: migrateWorkflowState(existingCaller, caller).state;
		const mergedCallerState: Record<string, unknown> = {
			...normalizedCaller,
			skill: caller,
			version: WORKFLOW_STATE_VERSION,
			active: false,
			current_phase: "handoff",
			handoff_to: callee,
			handoff_at: handoffAt,
			updated_at: handoffAt,
			receipt: callerReceipt,
		};
		const force = hasFlag(args, "--force");
		await beginWorkflowTransactionJournal({
			cwd,
			sessionId,
			mutationId,
			caller,
			paths: [callerPath, activeStateFile(cwd, sessionId)],
		});
		const callerWrite = await writeJsonAtomic(cwd, callerPath, mergedCallerState, "handoff", {
			sessionId,
			skill: caller,
			mutationId,
			force,
			fromPhase: typeof existingCaller.current_phase === "string" ? existingCaller.current_phase : undefined,
			toPhase: "handoff",
		});
		await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, { steps: ["caller-mode-state"] });
		if (callerWrite.warning) process.stderr.write(`${callerWrite.warning}\n`);
		const stampedCallerReceipt = isPlainObject(callerWrite.stamped.receipt) ? callerWrite.stamped.receipt : {};
		await syncSkillActiveState({
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
		});
		await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, {
			steps: ["caller-mode-state", "active-state"],
		});
		await completeWorkflowTransactionJournal(cwd, sessionId, mutationId);
		await touchStateActivityMarker(cwd, sessionId, callerPath);
		return {
			status: 0,
			stdout: renderCliWriteReceipt({
				ok: true,
				from: caller,
				to: callee,
				handoff_at: handoffAt,
				phases: {
					from: mergedCallerState.current_phase,
				},
				receipts: {
					from: {
						mutation_id: stampedCallerReceipt.mutation_id,
						status: stampedCallerReceipt.status,
						content_sha256: stampedCallerReceipt.content_sha256,
					},
				},
				paths: {
					from: callerPath,
					active_state: activeStateFile(cwd, sessionId),
				},
			}),
		};
	}

	if (!calleePath) {
		throw new StateCommandError(2, `gjc state handoff failed to resolve workflow callee path for ${callee}`);
	}
	const calleeRead = await readExistingStateForMutation(calleePath);
	if (calleeRead.kind === "corrupt" && !forced) {
		throw new StateCommandError(
			2,
			`existing state for ${callee} is corrupt or tampered (${calleeRead.error}); use --force to overwrite`,
		);
	}
	const existingCallee = calleeRead.kind === "valid" ? calleeRead.value : {};
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
	const normalizedCaller =
		caller === "deep-interview"
			? (normalizeDeepInterviewEnvelope(migrateWorkflowState(existingCaller, caller).state) as Record<
					string,
					unknown
				>)
			: migrateWorkflowState(existingCaller, caller).state;
	const normalizedCallee =
		callee === "deep-interview"
			? (normalizeDeepInterviewEnvelope(migrateWorkflowState(existingCallee, callee).state) as Record<
					string,
					unknown
				>)
			: migrateWorkflowState(existingCallee, callee).state;
	const mergedCalleeState: Record<string, unknown> = {
		...normalizedCallee,
		skill: callee,
		version: WORKFLOW_STATE_VERSION,
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
		...normalizedCaller,
		skill: caller,
		version: WORKFLOW_STATE_VERSION,
		active: false,
		current_phase: "handoff",
		handoff_to: callee,
		handoff_at: handoffAt,
		updated_at: handoffAt,
		receipt: callerReceipt,
	};

	await beginWorkflowTransactionJournal({
		cwd,
		sessionId,
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
	const calleeWrite = await writeJsonAtomic(cwd, calleePath, mergedCalleeState, "handoff", {
		sessionId,
		skill: callee,
		mutationId,
		force,
		fromPhase: typeof existingCallee.current_phase === "string" ? existingCallee.current_phase : undefined,
		toPhase: calleeInitial,
	});
	await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, { steps: ["callee-mode-state"] });
	const callerWrite = await writeJsonAtomic(cwd, callerPath, mergedCallerState, "handoff", {
		sessionId,
		skill: caller,
		mutationId,
		force,
		fromPhase: typeof existingCaller.current_phase === "string" ? existingCaller.current_phase : undefined,
		toPhase: "handoff",
	});
	await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, {
		steps: ["callee-mode-state", "caller-mode-state"],
	});
	const warnings = [calleeWrite.warning, callerWrite.warning].filter(
		(warning): warning is string => typeof warning === "string",
	);
	const stampedCallerReceipt = isPlainObject(callerWrite.stamped.receipt) ? callerWrite.stamped.receipt : {};
	const stampedCalleeReceipt = isPlainObject(calleeWrite.stamped.receipt) ? calleeWrite.stamped.receipt : {};
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
	await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, {
		steps: ["callee-mode-state", "caller-mode-state", "active-state"],
	});
	await completeWorkflowTransactionJournal(cwd, sessionId, mutationId);
	await touchStateActivityMarker(cwd, sessionId, callerPath);

	return {
		status: 0,
		stdout: renderCliWriteReceipt({
			ok: true,
			from: caller,
			to: callee,
			handoff_at: handoffAt,
			phases: {
				from: mergedCallerState.current_phase,
				to: mergedCalleeState.current_phase,
			},
			receipts: {
				from: {
					mutation_id: stampedCallerReceipt.mutation_id,
					status: stampedCallerReceipt.status,
					content_sha256: stampedCallerReceipt.content_sha256,
				},
				to: {
					mutation_id: stampedCalleeReceipt.mutation_id,
					status: stampedCalleeReceipt.status,
					content_sha256: stampedCalleeReceipt.content_sha256,
				},
			},
			paths: {
				from: callerPath,
				to: calleePath,
				active_state: activeStateFile(cwd, sessionId),
			},
		}),
	};
}

async function handleContract(
	args: readonly string[],
	cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	const { mode } = await resolveSelectors(args, cwd, positionalSkill, "read");
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
	if (/^[^/]+-state\.json$/.test(normalized) || false) return undefined;
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
	sessionId: string,
	skills: readonly CanonicalGjcWorkflowSkill[],
): Promise<RetentionCandidate[]> {
	const stateRoot = sessionStateDir(cwd, sessionId);
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
	const session = await resolveGjcSessionForRead(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const eligible = selectRetentionEligible(await collectRetentionCandidates(cwd, session.gjcSessionId, skills));
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
				sessionId: session.gjcSessionId,
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
		pruned: pruned.map(filePath => path.relative(sessionStateDir(cwd, session.gjcSessionId), filePath)),
		counts,
	};
}

async function handleGraph(
	args: readonly string[],
	_cwd: string,
	positionalSkill: string | undefined,
): Promise<StateCommandResult> {
	if (hasFlag(args, "--history")) {
		const session = await resolveGjcSessionForRead(_cwd, {
			flagValue: flagValue(args, "--session-id"),
			envSessionId: process.env.GJC_SESSION_ID,
		});
		const history = await readAuditWindow(_cwd, args, session.gjcSessionId);
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
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "prune");
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.gjcSessionId));
	if (!mode) {
		throw new StateCommandError(
			2,
			"gjc state prune requires --mode <skill>, positional <skill>, input.skill, or an active workflow in the current session active state",
		);
	}
	const filePath = modeStateFile(cwd, mode, selectors.gjcSessionId);
	const olderThanDays = parseNonNegativeIntegerFlag(args, "--older-than");
	const status = flagValue(args, "--status")?.trim();
	const targets: GenericHardPruneTarget[] = [{ path: filePath, category: "prune" }];
	const audit: StateWriterAuditContext = {
		cwd,
		sessionId: selectors.gjcSessionId,
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
	const selectors = await resolveSelectors(args, cwd, positionalSkill, "migrate");
	const mode = selectors.mode ?? (await inferModeFromActiveState(cwd, selectors.gjcSessionId));
	if (!mode) {
		throw new StateCommandError(
			2,
			"gjc state migrate requires --mode <skill>, positional <skill>, input.skill, or an active workflow in the current session active state",
		);
	}
	const filePath = modeStateFile(cwd, mode, selectors.gjcSessionId);
	const forced = hasFlag(args, "--force");
	const mismatchWarning = await warnAndAuditOutOfBandIfNeeded(cwd, selectors.gjcSessionId, filePath, mode, {
		forced,
	});
	if (mismatchWarning && !forced) {
		throw new StateCommandError(2, `${mismatchWarning}; use --force to migrate tampered mode-state`);
	}
	const result = await migrateAndPersistLegacyState({
		cwd,
		skill: mode,
		statePath: filePath,
		sessionId: selectors.gjcSessionId,
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
			case "doctor":
				return await handleDoctor(args, cwd, parsed.positionalSkill);
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
		if (error instanceof SessionResolutionError) return { status: 2, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
