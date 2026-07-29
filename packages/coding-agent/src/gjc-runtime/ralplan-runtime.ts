import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@gajae-code/utils";
import { syncSkillActiveState } from "../skill-state/active-state";
import { buildRalplanHudSummary } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import {
	formatRalplanStagePresence,
	parseRalplanIndexLine,
	type RalplanIndexRow,
	summarizeRalplanIndex,
} from "./ledger-event-renderer";
import {
	assertCwdMatchesRepositoryBinding,
	assertPathUnderRepositoryBinding,
	captureRepositoryBinding,
	parseRepositoryBinding,
	publicRepositoryBinding,
	type RepositoryBinding,
	RepositoryBindingError,
} from "./repository-binding";
import { GJC_RALPLAN_ARTIFACT_ENV, isRestrictedRoleAgentBash } from "./restricted-role-agent-bash";
import { gjcRoot, modeStatePath, sessionPlansDir } from "./session-layout";
import { resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { migrateWorkflowState } from "./state-migrations";
import { runNativeStateCommand } from "./state-runtime";
import {
	appendJsonlIdempotent,
	readExistingStateForMutation,
	withWorkflowStateLock,
	writeArtifact,
	writeWorkflowEnvelopeAtomic,
} from "./state-writer";
import { assertSafePathComponent, CommandError, flagValue, hasFlag } from "./workflow-cli-common";
import { getSkillManifest } from "./workflow-manifest";

/**
 * Native implementation of `gjc ralplan`.
 *
 * Two invocation shapes are handled natively:
 *
 * 1. **Consensus handoff**: `gjc ralplan [--interactive] [--deliberate] [--architect <kind>]
 *    [--critic <kind>] [--session-id <id>] "<task>"` validates the documented flag surface,
 *    seeds `.gjc/state/ralplan-state.json`, and updates the shared HUD rail via
 *    `syncSkillActiveState`. The CLI never *runs* the Planner / Architect / Critic loop itself —
 *    that lives in the bundled `/skill:ralplan` skill — but it accepts every documented flag so
 *    scripted users see a useful response and the active run is visible to the TUI.
 *
 * 2. **Artifact write**: `gjc ralplan --write --stage <type> --stage_n <N>
 *    (--artifact <path-or-string> | --artifact-env GJC_RALPLAN_ARTIFACT)
 *    [--run-id <id>] [--session-id <id>] [--lane-verdict <token>] [--json]` persists Planner / Architect
 *    / Critic / revision / post-interview / ADR / final markdown under `.gjc/plans/ralplan/<run-id>/`, maintains
 *    an `index.jsonl` audit log, copies `final` stages to `pending-approval.md`, and advances
 *    the HUD chip to reflect the latest persisted stage.
 */

export interface RalplanCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const KNOWN_STAGES = ["planner", "architect", "critic", "revision", "post-interview", "adr", "final"] as const;
type RalplanStage = (typeof KNOWN_STAGES)[number];
/** Default consensus iterations (planner + revision openers) per run. Matches SKILL.md re-review cap. */
export const RALPLAN_DEFAULT_MAX_ITERATIONS = 5;
/** Inclusive upper bound for `gjc.ralplan.maxIterations` settings overrides. */
export const RALPLAN_MAX_ITERATIONS_LIMIT = 20;
/** Operator-visible stuck signal for headless/CI orchestration (#3165). */
export const PLANNING_STUCK_MARKER = "PLANNING-STUCK";
/** Default architect/critic review passes per consensus iteration. */
export const RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE = 1;
/** Inclusive upper bound for `gjc.ralplan.maxReviewPassesPerLane` settings overrides. */
export const RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT = 10;

const RALPLAN_ITERATION_OPENER_STAGES = new Set<RalplanStage>(["planner", "revision"]);

/** Collapse duplicate ledger rows for the same deterministic stage artifact before review-lane budget accounting. */
function deduplicateRalplanIndexRowsByStageIdentity(rows: readonly RalplanIndexRow[]): RalplanIndexRow[] {
	const seen = new Set<string>();
	return rows.filter(row => {
		if (typeof row.stageN !== "number") return true;
		const identity = `${row.stage}\u0000${row.stageN}`;
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

export type RalplanIterationCapDecision =
	| {
			allowed: true;
			currentIterations: number;
			projectedIterations: number;
			maxIterations: number;
	  }
	| {
			allowed: false;
			currentIterations: number;
			projectedIterations: number;
			maxIterations: number;
			reason: string;
	  };

/**
 * Pure consensus-iteration budget gate (#3165).
 *
 * A `planner` or `revision` write opens a new iteration (same definition as
 * `summarizeRalplanIndex`). Other stages never open iterations and are always
 * allowed by this gate — including `final` after the cap is already reached.
 *
 * `iterationFloor` raises the observed opener count when on-disk evidence or a
 * recovered ledger is higher than the parsed index (fail-closed vs wipe/truncate).
 */
export function evaluateRalplanIterationCap(input: {
	rows: readonly RalplanIndexRow[];
	stage: string;
	maxIterations?: number;
	/** Minimum opener count (e.g. on-disk stage-*-{planner,revision}.md). */
	iterationFloor?: number;
}): RalplanIterationCapDecision {
	const maxIterations =
		typeof input.maxIterations === "number" &&
		Number.isInteger(input.maxIterations) &&
		input.maxIterations >= 1 &&
		input.maxIterations <= RALPLAN_MAX_ITERATIONS_LIMIT
			? input.maxIterations
			: RALPLAN_DEFAULT_MAX_ITERATIONS;
	const fromIndex = summarizeRalplanIndex(input.rows).iteration;
	const floor =
		typeof input.iterationFloor === "number" && Number.isInteger(input.iterationFloor) && input.iterationFloor > 0
			? input.iterationFloor
			: 0;
	const currentIterations = Math.max(fromIndex, floor);
	if (!RALPLAN_ITERATION_OPENER_STAGES.has(input.stage as RalplanStage)) {
		return {
			allowed: true,
			currentIterations,
			projectedIterations: currentIterations,
			maxIterations,
		};
	}
	const projectedIterations = currentIterations + 1;
	if (projectedIterations > maxIterations) {
		const ledgerNote = floor > fromIndex ? ` (ledger under-count: index=${fromIndex}, on-disk openers=${floor})` : "";
		return {
			allowed: false,
			currentIterations,
			projectedIterations,
			maxIterations,
			reason:
				`ralplan consensus iteration cap exceeded: opening ${input.stage} would start ` +
				`iteration ${projectedIterations} (max ${maxIterations})${ledgerNote}`,
		};
	}
	return {
		allowed: true,
		currentIterations,
		projectedIterations,
		maxIterations,
	};
}

export type RalplanReviewLane = "architect" | "critic";

export type RalplanReviewLaneBudgetDecision =
	| {
			allowed: true;
			lane?: RalplanReviewLane;
			currentPasses: number;
			projectedPasses: number;
			maxReviewPassesPerLane: number;
			finalSlot: boolean;
			ledgerNote?: string;
	  }
	| {
			allowed: false;
			lane: RalplanReviewLane;
			currentPasses: number;
			projectedPasses: number;
			maxReviewPassesPerLane: number;
			finalSlot: false;
			ledgerNote?: string;
			reason: string;
	  };

/**
 * Pure per-lane review-pass budget gate. Architect and critic passes are limited
 * within the current consensus iteration; all other stages remain unconditionally
 * available as escalation paths.
 */
export function evaluateRalplanReviewLaneBudget(input: {
	rows: readonly RalplanIndexRow[];
	stage: string;
	maxReviewPassesPerLane?: unknown;
	onDiskLaneCounts?: { architect: number; critic: number };
}): RalplanReviewLaneBudgetDecision {
	const maxReviewPassesPerLane =
		typeof input.maxReviewPassesPerLane === "number" &&
		Number.isInteger(input.maxReviewPassesPerLane) &&
		input.maxReviewPassesPerLane >= 1 &&
		input.maxReviewPassesPerLane <= RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT
			? input.maxReviewPassesPerLane
			: RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE;
	if (input.stage !== "architect" && input.stage !== "critic") {
		return {
			allowed: true,
			currentPasses: 0,
			projectedPasses: 0,
			maxReviewPassesPerLane,
			finalSlot: false,
		};
	}

	const lane = input.stage as RalplanReviewLane;
	const rows = deduplicateRalplanIndexRowsByStageIdentity(input.rows);
	const summary = summarizeRalplanIndex(rows);
	const indexCurrent = summary.currentStages.filter(stage => stage === lane).length;
	const parsedTotal = rows.filter(row => row.stage === lane).length;
	const onDiskRaw = input.onDiskLaneCounts?.[lane];
	const onDiskTotal = typeof onDiskRaw === "number" && Number.isInteger(onDiskRaw) && onDiskRaw > 0 ? onDiskRaw : 0;
	const diskExcess = Math.max(0, onDiskTotal - parsedTotal);
	const currentPasses = indexCurrent + diskExcess;
	const projectedPasses = currentPasses + 1;
	const ledgerNote =
		diskExcess > 0
			? ` (ledger under-count: parsed ${lane} rows=${parsedTotal}, on-disk ${lane} artifacts=${onDiskTotal})`
			: undefined;
	const finalSlot = projectedPasses === maxReviewPassesPerLane;
	if (projectedPasses > maxReviewPassesPerLane) {
		return {
			allowed: false,
			lane,
			currentPasses,
			projectedPasses,
			maxReviewPassesPerLane,
			finalSlot: false,
			ledgerNote,
			reason:
				`ralplan review lane budget exceeded: ${lane} pass ${projectedPasses} of max ${maxReviewPassesPerLane} ` +
				`in consensus iteration ${Math.max(1, summary.iteration)}${ledgerNote ?? ""}`,
		};
	}
	return {
		allowed: true,
		lane,
		currentPasses,
		projectedPasses,
		maxReviewPassesPerLane,
		finalSlot,
		ledgerNote,
	};
}

function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** Filename pattern for persisted planner/revision stage artifacts. */
const OPENER_ARTIFACT_RE = /^stage-\d{2,}-(planner|revision)\.md$/;
const LANE_ARTIFACT_RE = /^stage-\d{2,}-(architect|critic)\.md$/;

/**
 * Count on-disk planner/revision stage artifacts for a run. Used as a floor when
 * `index.jsonl` is missing, empty, truncated, or otherwise under-counts openers.
 */
export async function countRalplanOnDiskOpeners(cwd: string, sessionId: string, runId: string): Promise<number> {
	const runDir = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId);
	try {
		const entries = await fs.readdir(runDir);
		let count = 0;
		for (const name of entries) {
			if (OPENER_ARTIFACT_RE.test(name)) count += 1;
		}
		return count;
	} catch {
		return 0;
	}
}

/**
 * Count on-disk Architect/Critic stage artifacts for a run. This is the
 * fail-closed floor for a missing, truncated, or malformed `index.jsonl`.
 */
export async function countRalplanOnDiskLaneArtifacts(
	cwd: string,
	sessionId: string,
	runId: string,
): Promise<{ architect: number; critic: number }> {
	const runDir = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId);
	try {
		const entries = await fs.readdir(runDir);
		const counts = { architect: 0, critic: 0 };
		for (const name of entries) {
			const match = LANE_ARTIFACT_RE.exec(name);
			if (match) counts[match[1] as RalplanReviewLane] += 1;
		}
		return counts;
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return { architect: 0, critic: 0 };
		throw error;
	}
}

/**
 * Load index rows for cap enforcement. Unlike HUD reads, returns structural
 * signals so callers can fail closed when the ledger is empty/malformed while
 * opener artifacts already exist on disk.
 */
export async function loadRalplanIndexForCap(
	cwd: string,
	sessionId: string,
	runId: string,
): Promise<{
	rows: RalplanIndexRow[];
	indexPresent: boolean;
	parseableLines: number;
	rawLineCount: number;
	rawText?: string;
}> {
	const indexPath = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId, "index.jsonl");
	try {
		const text = await fs.readFile(indexPath, "utf8");
		const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
		const rows: RalplanIndexRow[] = [];
		for (const line of lines) {
			const row = parseRalplanIndexLine(line);
			if (row) rows.push(row);
		}
		return {
			rows,
			indexPresent: true,
			parseableLines: rows.length,
			rawLineCount: lines.length,
			rawText: text,
		};
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
		if (code === "ENOENT") {
			return { rows: [], indexPresent: false, parseableLines: 0, rawLineCount: 0 };
		}
		// Unreadable index: treat as present-but-untrusted empty parse.
		return { rows: [], indexPresent: true, parseableLines: 0, rawLineCount: 0 };
	}
}

function parseBoundedPositiveInteger(value: unknown, limit: number): number | null {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= limit
		? value
		: null;
}

function parseMaxIterationsValue(value: unknown): number | null {
	return parseBoundedPositiveInteger(value, RALPLAN_MAX_ITERATIONS_LIMIT);
}

async function readSettingsMaxIterations(settingsPath: string): Promise<number | null> {
	try {
		const raw = await Bun.file(settingsPath).text();
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const flat = parseMaxIterationsValue(parsed["gjc.ralplan.maxIterations"]);
		if (flat !== null) return flat;
		const gjc = parsed.gjc;
		if (gjc && typeof gjc === "object") {
			const ralplan = (gjc as Record<string, unknown>).ralplan;
			if (ralplan && typeof ralplan === "object") {
				return parseMaxIterationsValue((ralplan as Record<string, unknown>).maxIterations);
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Resolve ralplan consensus iteration cap. Project `./.gjc/settings.json` overrides
 * user settings, else default 5.
 */
export async function resolveRalplanMaxIterations(cwd: string): Promise<{ maxIterations: number; source: string }> {
	const projectPath = path.join(gjcRoot(cwd), "settings.json");
	const project = await readSettingsMaxIterations(projectPath);
	if (project !== null) return { maxIterations: project, source: projectPath };
	const userPath = path.join(getConfigRootDir(), "settings.json");
	const user = await readSettingsMaxIterations(userPath);
	if (user !== null) return { maxIterations: user, source: userPath };
	return { maxIterations: RALPLAN_DEFAULT_MAX_ITERATIONS, source: "default" };
}

function parseMaxReviewPassesPerLaneValue(value: unknown): number | null {
	return parseBoundedPositiveInteger(value, RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT);
}

type RalplanReviewPassesPerLaneSetting =
	| { kind: "absent" }
	| { kind: "valid"; value: number }
	| { kind: "invalid"; reason: string };

function parsePresentMaxReviewPassesPerLane(value: unknown): RalplanReviewPassesPerLaneSetting {
	const parsed = parseMaxReviewPassesPerLaneValue(value);
	return parsed === null
		? {
				kind: "invalid",
				reason:
					"expected gjc.ralplan.maxReviewPassesPerLane to be an integer between 1 and " +
					RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT,
			}
		: { kind: "valid", value: parsed };
}

function parseMaxReviewPassesPerLaneSettings(parsed: unknown): RalplanReviewPassesPerLaneSetting {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "absent" };
	const settings = parsed as Record<string, unknown>;
	if (Object.hasOwn(settings, "gjc.ralplan.maxReviewPassesPerLane")) {
		return parsePresentMaxReviewPassesPerLane(settings["gjc.ralplan.maxReviewPassesPerLane"]);
	}
	const gjc = settings.gjc;
	if (!gjc || typeof gjc !== "object" || Array.isArray(gjc)) return { kind: "absent" };
	const ralplan = (gjc as Record<string, unknown>).ralplan;
	if (!ralplan || typeof ralplan !== "object" || Array.isArray(ralplan)) return { kind: "absent" };
	const ralplanSettings = ralplan as Record<string, unknown>;
	if (!Object.hasOwn(ralplanSettings, "maxReviewPassesPerLane")) return { kind: "absent" };
	return parsePresentMaxReviewPassesPerLane(ralplanSettings.maxReviewPassesPerLane);
}

async function readSettingsMaxReviewPassesPerLane(settingsPath: string): Promise<RalplanReviewPassesPerLaneSetting> {
	let raw: string;
	try {
		raw = await Bun.file(settingsPath).text();
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return { kind: "absent" };
		return {
			kind: "invalid",
			reason: `unable to read settings: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			kind: "invalid",
			reason: `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return parseMaxReviewPassesPerLaneSettings(parsed);
}

/** Resolve the per-lane review-pass budget with project-over-user precedence. */
export async function resolveRalplanMaxReviewPassesPerLane(
	cwd: string,
): Promise<{ maxReviewPassesPerLane: number; source: string }> {
	const projectPath = path.join(gjcRoot(cwd), "settings.json");
	const project = await readSettingsMaxReviewPassesPerLane(projectPath);
	if (project.kind === "invalid") {
		throw new RalplanCommandError(2, `invalid ralplan settings at ${projectPath}: ${project.reason}`);
	}
	if (project.kind === "valid") return { maxReviewPassesPerLane: project.value, source: projectPath };
	const userPath = path.join(getConfigRootDir(), "settings.json");
	const user = await readSettingsMaxReviewPassesPerLane(userPath);
	if (user.kind === "invalid") {
		throw new RalplanCommandError(2, `invalid ralplan settings at ${userPath}: ${user.reason}`);
	}
	if (user.kind === "valid") return { maxReviewPassesPerLane: user.value, source: userPath };
	return { maxReviewPassesPerLane: RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE, source: "default" };
}

function buildPlanningStuckResult(input: {
	json: boolean;
	stage: RalplanStage;
	stageN: number;
	runId: string;
	decision: Extract<RalplanIterationCapDecision, { allowed: false }>;
	source: string;
}): RalplanCommandResult {
	const detail =
		`${PLANNING_STUCK_MARKER}: ${input.decision.reason} ` +
		`(run_id=${input.runId}, stage=${input.stage}, stage_n=${input.stageN}, source=${input.source}). ` +
		`Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.`;
	if (input.json) {
		return {
			status: 3,
			stdout: `${JSON.stringify(
				{
					ok: false,
					planning_stuck: true,
					marker: PLANNING_STUCK_MARKER,
					run_id: input.runId,
					stage: input.stage,
					stage_n: input.stageN,
					iteration: input.decision.currentIterations,
					projected_iteration: input.decision.projectedIterations,
					max_iterations: input.decision.maxIterations,
					max_iterations_source: input.source,
					reason: input.decision.reason,
				},
				null,
				2,
			)}\n`,
			stderr: `${detail}\n`,
		};
	}
	return {
		status: 3,
		stdout: `${PLANNING_STUCK_MARKER}\n`,
		stderr: `${detail}\n`,
	};
}

function buildLaneBudgetStuckResult(input: {
	json: boolean;
	stage: RalplanStage;
	stageN: number;
	runId: string;
	decision: Extract<RalplanReviewLaneBudgetDecision, { allowed: false }>;
	source: string;
}): RalplanCommandResult {
	const detail =
		`${PLANNING_STUCK_MARKER}: ${input.decision.reason} ` +
		`(run_id=${input.runId}, stage=${input.stage}, stage_n=${input.stageN}, source=${input.source}). ` +
		`Stop re-invoking the ${input.decision.lane} review lane in this consensus iteration; ` +
		"route a rule-2-justified blocker through a Planner revision opener (fresh lane budget) while opener budget remains, " +
		"or escalate the best existing plan via post-interview/adr/final without auto-implementation.";
	if (input.json) {
		return {
			status: 3,
			stdout: `${JSON.stringify(
				{
					ok: false,
					planning_stuck: true,
					marker: PLANNING_STUCK_MARKER,
					run_id: input.runId,
					stage: input.stage,
					stage_n: input.stageN,
					lane: input.decision.lane,
					passes: input.decision.currentPasses,
					projected_passes: input.decision.projectedPasses,
					max_review_passes_per_lane: input.decision.maxReviewPassesPerLane,
					max_review_passes_source: input.source,
					reason: input.decision.reason,
				},
				null,
				2,
			)}\n`,
			stderr: `${detail}\n`,
		};
	}
	return {
		status: 3,
		stdout: `${PLANNING_STUCK_MARKER}\n`,
		stderr: `${detail}\n`,
	};
}

const KNOWN_ARCHITECT_KINDS = new Set(["openai-code"]);
const KNOWN_CRITIC_KINDS = new Set(["openai-code"]);

const SUBAGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const KNOWN_FALLBACK_REASONS = new Set([
	"context_unavailable",
	"not_found",
	"no_runner",
	"resume_failed",
	"process_restart",
	"missing_record",
]);

class RalplanCommandError extends CommandError {
	constructor(exitStatus: number, message: string) {
		super(exitStatus, message);
		this.name = "RalplanCommandError";
	}
}

const VALUE_FLAGS = new Set([
	"--stage",
	"--stage_n",
	"--artifact",
	"--artifact-env",
	"--run-id",
	"--session-id",
	"--architect",
	"--critic",
	"--planner-id",
	"--planner-resumable",
	"--architect-id",
	"--architect-resumable",
	"--critic-id",
	"--critic-resumable",
	"--fallback-reason",
	"--fallback-attempted-id",
	"--fallback-stage-n",
	"--fallback-receipt-path",
	"--lane-verdict",
]);

export function isRalplanArtifactWriteInvocation(args: readonly string[]): boolean {
	return hasFlag(args, "--write");
}

function isRalplanDoctorInvocation(args: readonly string[]): boolean {
	return args[0] === "doctor";
}

function assertKnownStage(stage: string): asserts stage is RalplanStage {
	if (!(KNOWN_STAGES as readonly string[]).includes(stage)) {
		throw new RalplanCommandError(2, `unknown --stage: ${stage}. Expected one of: ${KNOWN_STAGES.join(", ")}.`);
	}
}

function parseStageN(raw: string | undefined): number {
	if (!raw) throw new RalplanCommandError(2, "--stage_n is required");
	if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
		throw new RalplanCommandError(2, `invalid --stage_n: ${raw}. Expected integer 1..999.`);
	}
	const value = Number.parseInt(raw, 10);
	if (value < 1 || value > 999) {
		throw new RalplanCommandError(2, `invalid --stage_n: ${raw}. Expected integer 1..999.`);
	}
	return value;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

function defaultRunId(now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = now.getUTCDate().toString().padStart(2, "0");
	const hh = now.getUTCHours().toString().padStart(2, "0");
	const min = now.getUTCMinutes().toString().padStart(2, "0");
	const suffix = randomBytes(2).toString("hex");
	return `${yyyy}-${mm}-${dd}-${hh}${min}-${suffix}`;
}

async function resolveArtifactContent(rawArtifact: string, cwd: string): Promise<string> {
	if (isRestrictedRoleAgentBash()) return rawArtifact;
	const candidate = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(cwd, rawArtifact);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) return await fs.readFile(candidate, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
			throw new RalplanCommandError(2, `failed to read --artifact ${candidate}: ${err.message}`);
		}
	}
	return rawArtifact;
}

/* ------------------------------ artifact write ------------------------------ */

interface ResolvedArtifactArgs {
	stage: RalplanStage;
	stageN: number;
	runId: string;
	artifact: string;
	sessionId: string;
	json: boolean;
}

function ralplanStatePath(cwd: string, sessionId: string): string {
	return modeStatePath(cwd, sessionId, "ralplan");
}

async function readActiveRunId(cwd: string, sessionId: string): Promise<string | undefined> {
	const statePath = ralplanStatePath(cwd, sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "absent") return undefined;
	if (existingRead.kind === "corrupt") {
		throw new RalplanCommandError(
			2,
			`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
		);
	}
	const candidate = typeof existingRead.value.run_id === "string" ? existingRead.value.run_id.trim() : "";
	if (!candidate) return undefined;
	assertSafePathComponent(candidate, "run-id");
	return candidate;
}

/**
 * Read the authoritative repository binding from ralplan run state and fail closed
 * when the active cwd no longer matches (handoff / QA / stage write) (#2901).
 */
async function enforceRalplanRepositoryBinding(cwd: string, sessionId: string): Promise<RepositoryBinding> {
	const statePath = ralplanStatePath(cwd, sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "corrupt") {
		throw new RalplanCommandError(
			2,
			`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to proceed at ${statePath}`,
		);
	}
	if (existingRead.kind === "absent") {
		// No prior seed — capture live authority so subsequent handoffs still have a stamp.
		return publicRepositoryBinding(await captureRepositoryBinding(cwd, { displayPath: cwd }));
	}
	const raw = existingRead.value.repository_binding ?? existingRead.value.repositoryBinding;
	try {
		if (raw === undefined) {
			// Legacy seeds without a field: stamp current cwd and require future writes match it.
			return publicRepositoryBinding(await captureRepositoryBinding(cwd, { displayPath: cwd }));
		}
		const binding = parseRepositoryBinding(raw);
		await assertCwdMatchesRepositoryBinding(cwd, binding);
		return publicRepositoryBinding(binding);
	} catch (error) {
		if (error instanceof RepositoryBindingError) {
			throw new RalplanCommandError(2, `ralplan repository binding rejected: ${error.message}`);
		}
		throw new RalplanCommandError(
			2,
			`ralplan repository binding rejected: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Run-state phases that an artifact write must never reopen. Once ralplan has
 * reached a terminal/handed-off phase, a stray `--write` must not regress
 * `current_phase` back to a stage — that would silently re-arm a chain guard or
 * undo Stop semantics. Every other phase advances to track the stage just
 * persisted so run-state stays coherent with the active ralplan stage.
 */

/** Phase that keeps run-state coherent with the stage just written, preserving locked phases. */
function advanceCurrentPhase(existingPhase: unknown, stage: RalplanStage): string {
	const current = typeof existingPhase === "string" ? existingPhase.trim() : "";
	if (current && getSkillManifest("ralplan").phaseLock.includes(current)) return current;
	return stage;
}

async function persistActiveRunId(cwd: string, sessionId: string, runId: string, stage: RalplanStage): Promise<void> {
	const statePath = ralplanStatePath(cwd, sessionId);
	return await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			}
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};

			// A new run_id is a fresh run, not a stray write on the prior run: never inherit a
			// previous run's terminal/locked phase (which would start the new run already
			// "complete"/"handoff" and disarm the Stop hook). PHASE_LOCK only guards same-run writes.
			const isNewRun = existing.run_id !== runId;
			const nextPhase = isNewRun ? stage : advanceCurrentPhase(existing.current_phase, stage);
			if (isNewRun) {
				// State writes shallow-merge, so clear both HUD verdict sources at the run boundary.
				delete existing.verdict;
				for (const key of Object.keys(existing)) {
					if (key.startsWith("last_review_verdict")) delete existing[key];
				}
			}
			if (
				existing.run_id === runId &&
				existing.version === WORKFLOW_STATE_VERSION &&
				existing.current_phase === nextPhase &&
				(existing.active === true || getSkillManifest("ralplan").phaseLock.includes(nextPhase))
			) {
				return;
			}
			existing.run_id = runId;
			if (typeof existing.skill !== "string") existing.skill = "ralplan";
			// A successful persist means ralplan is actively writing this run's artifacts, so always
			// re-assert active. Fallback-only init left active:false after a clear (#644, sibling of #638).
			existing.active = true;
			existing.current_phase = nextPhase;
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan persist-run-id", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
		},
		{ cwd },
	);
}

/* ---------------------- persisted role-agent run-state --------------------- */

type PersistedRole = "planner" | RalplanReviewLane;

interface PersistedRoleStateUpdate {
	role: PersistedRole;
	subagentId?: string;
	resumable?: boolean;
	fallbackReason?: string;
	fallbackAttemptedId?: string;
	fallbackStageN?: number;
	fallbackReceiptPath?: string;
}

interface LaneVerdictUpdate {
	lane: RalplanReviewLane;
	verdict: string;
	stageN: number;
}

const PERSISTED_ROLES = ["planner", "architect", "critic"] as const;

const PERSISTED_ROLE_FLAGS: Record<PersistedRole, { id: string; resumable: string }> = {
	planner: { id: "--planner-id", resumable: "--planner-resumable" },
	architect: { id: "--architect-id", resumable: "--architect-resumable" },
	critic: { id: "--critic-id", resumable: "--critic-resumable" },
};

const LANE_VERDICTS: Record<RalplanReviewLane, ReadonlySet<string>> = {
	architect: new Set(["CLEAR", "WATCH", "BLOCK"]),
	critic: new Set(["OKAY", "ITERATE", "REJECT"]),
};

function parseBooleanFlag(raw: string, flag: string): boolean {
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new RalplanCommandError(2, `invalid ${flag}: ${raw}. Expected "true" or "false".`);
}

function assertSubagentId(value: string, label: string): void {
	if (!SUBAGENT_ID_RE.test(value)) {
		throw new RalplanCommandError(2, `invalid ${label}: ${value}`);
	}
}

function roleStateFlagValue(args: readonly string[], flag: string): string | undefined {
	const value = flagValue(args, flag);
	if (value === undefined && hasFlag(args, flag)) {
		throw new RalplanCommandError(2, `missing value for ${flag}.`);
	}
	return value;
}

function persistedRoleForStage(stage: RalplanStage): PersistedRole | undefined {
	if (stage === "planner" || stage === "revision") return "planner";
	if (stage === "architect" || stage === "critic") return stage;
	return undefined;
}

function suppliedPersistedRoleFlag(args: readonly string[], role: PersistedRole): string | undefined {
	const flags = PERSISTED_ROLE_FLAGS[role];
	if (hasFlag(args, flags.id)) return flags.id;
	if (hasFlag(args, flags.resumable)) return flags.resumable;
	return undefined;
}

/**
 * Parse the optional same-session persisted role-agent metadata that may ride
 * alongside a `--write`. Planner metadata rides planner/revision stages;
 * Architect and Critic metadata ride only their matching review lane. This is
 * an audit/routing hint, not a durable subagent registry.
 */
function parsePersistedRoleStateArgs(
	args: readonly string[],
	stage: RalplanStage,
): PersistedRoleStateUpdate | undefined {
	const role = persistedRoleForStage(stage);
	for (const candidate of PERSISTED_ROLES) {
		const suppliedFlag = suppliedPersistedRoleFlag(args, candidate);
		if (suppliedFlag && candidate !== role) {
			const expectedStages = candidate === "planner" ? "planner or revision" : candidate;
			throw new RalplanCommandError(
				2,
				`${suppliedFlag} is only valid with --stage ${expectedStages} (received ${stage}).`,
			);
		}
	}

	const fallbackFlagsPresent = [
		"--fallback-reason",
		"--fallback-attempted-id",
		"--fallback-stage-n",
		"--fallback-receipt-path",
	].some(flag => hasFlag(args, flag));
	if (!role) {
		if (fallbackFlagsPresent) {
			throw new RalplanCommandError(
				2,
				`--fallback-reason is only valid with --stage planner, revision, architect, or critic (received ${stage}).`,
			);
		}
		return undefined;
	}

	const flags = PERSISTED_ROLE_FLAGS[role];
	const subagentId = roleStateFlagValue(args, flags.id);
	const resumableRaw = roleStateFlagValue(args, flags.resumable);
	const fallbackReason = roleStateFlagValue(args, "--fallback-reason");
	const fallbackAttemptedId = roleStateFlagValue(args, "--fallback-attempted-id");
	const fallbackStageNRaw = roleStateFlagValue(args, "--fallback-stage-n");
	const fallbackReceiptPath = roleStateFlagValue(args, "--fallback-receipt-path");

	const anyPresent = [
		subagentId,
		resumableRaw,
		fallbackReason,
		fallbackAttemptedId,
		fallbackStageNRaw,
		fallbackReceiptPath,
	].some(value => value !== undefined);
	if (!anyPresent) return undefined;

	const update: PersistedRoleStateUpdate = { role };
	if (subagentId !== undefined) {
		assertSubagentId(subagentId, flags.id);
		update.subagentId = subagentId;
	}
	if (resumableRaw !== undefined) {
		update.resumable = parseBooleanFlag(resumableRaw, flags.resumable);
	}

	const anyFallback = [fallbackReason, fallbackAttemptedId, fallbackStageNRaw, fallbackReceiptPath].some(
		value => value !== undefined,
	);
	if (anyFallback) {
		if (!fallbackReason) {
			throw new RalplanCommandError(2, `--fallback-reason is required when recording ${role} fallback metadata.`);
		}
		if (!KNOWN_FALLBACK_REASONS.has(fallbackReason)) {
			throw new RalplanCommandError(
				2,
				`invalid --fallback-reason: ${fallbackReason}. Expected one of: ${[...KNOWN_FALLBACK_REASONS].join(", ")}.`,
			);
		}
		update.fallbackReason = fallbackReason;
		if (fallbackAttemptedId === undefined) {
			throw new RalplanCommandError(
				2,
				`--fallback-attempted-id is required when recording ${role} fallback metadata.`,
			);
		}
		assertSubagentId(fallbackAttemptedId, "--fallback-attempted-id");
		update.fallbackAttemptedId = fallbackAttemptedId;
		if (fallbackStageNRaw === undefined) {
			throw new RalplanCommandError(2, `--fallback-stage-n is required when recording ${role} fallback metadata.`);
		}
		update.fallbackStageN = parseStageN(fallbackStageNRaw);
		if (fallbackReceiptPath !== undefined) {
			if (fallbackReceiptPath.trim() === "") {
				throw new RalplanCommandError(2, "--fallback-receipt-path must not be empty.");
			}
			update.fallbackReceiptPath = fallbackReceiptPath;
		}
	}

	return update;
}

/** Parse the self-reported review verdict carried by a lane artifact write. */
function parseLaneVerdictArgs(
	args: readonly string[],
	stage: RalplanStage,
	stageN: number,
): LaneVerdictUpdate | undefined {
	const rawVerdict = roleStateFlagValue(args, "--lane-verdict");
	if (rawVerdict === undefined) return undefined;
	if (stage !== "architect" && stage !== "critic") {
		throw new RalplanCommandError(
			2,
			`--lane-verdict is only valid with --stage architect or critic (received ${stage}).`,
		);
	}
	const verdict = rawVerdict.trim().toUpperCase();
	if (!LANE_VERDICTS[stage].has(verdict)) {
		throw new RalplanCommandError(
			2,
			`invalid --lane-verdict for ${stage}: ${rawVerdict}. Expected one of: ${[...LANE_VERDICTS[stage]].join(", ")}.`,
		);
	}
	return { lane: stage, verdict, stageN };
}

/**
 * Snake-case projection of persisted role metadata for state JSON + receipts.
 * Omitted fields stay absent — an unknown resumability value is never encoded
 * as literal null.
 */
function persistedRoleStatePayload(update: PersistedRoleStateUpdate): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	const prefix = update.role;
	if (update.subagentId !== undefined) {
		payload[prefix === "planner" ? "planner_subagent_id" : `${prefix}_id`] = update.subagentId;
	}
	if (update.resumable !== undefined) payload[`${prefix}_resumable`] = update.resumable;
	if (update.fallbackReason !== undefined) payload[`${prefix}_fallback_reason`] = update.fallbackReason;
	if (update.fallbackAttemptedId !== undefined)
		payload[`${prefix}_fallback_attempted_id`] = update.fallbackAttemptedId;
	if (update.fallbackStageN !== undefined) payload[`${prefix}_fallback_stage_n`] = update.fallbackStageN;
	if (update.fallbackReceiptPath !== undefined) {
		payload[`${prefix}_fallback_receipt_path`] = update.fallbackReceiptPath;
	}
	return payload;
}

/**
 * Merge persisted role-agent metadata into the ralplan run-state JSON, optionally only for its active run.
 * This is a same-session audit/routing hint only; it does not create a durable
 * cross-process subagent registry, ledger entry, or additional state file.
 */
async function applyPersistedRoleStateUpdate(
	cwd: string,
	sessionId: string,
	update: PersistedRoleStateUpdate,
	expectedActiveRunId?: string,
): Promise<boolean> {
	const statePath = ralplanStatePath(cwd, sessionId);
	return await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			}
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};
			if (expectedActiveRunId !== undefined && existing.run_id !== expectedActiveRunId) return false;
			Object.assign(existing, persistedRoleStatePayload(update));
			if (typeof existing.skill !== "string") existing.skill = "ralplan";
			if (typeof existing.active !== "boolean") existing.active = true;
			if (typeof existing.current_phase !== "string") existing.current_phase = "planner";
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				receipt: {
					cwd,
					skill: "ralplan",
					owner: "gjc-runtime",
					command: `gjc ralplan ${update.role}-state`,
					sessionId,
				},
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
			return true;
		},
		{ cwd },
	);
}

/** Merge a lane's self-reported verdict into the same-session ralplan run state, optionally only for its active run. */
async function applyLaneVerdictUpdate(
	cwd: string,
	sessionId: string,
	update: LaneVerdictUpdate,
	expectedActiveRunId?: string,
): Promise<boolean> {
	const statePath = ralplanStatePath(cwd, sessionId);
	return await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			}
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};
			if (expectedActiveRunId !== undefined && existing.run_id !== expectedActiveRunId) return false;
			Object.assign(existing, {
				last_review_verdict: update.verdict,
				last_review_verdict_lane: update.lane,
				last_review_verdict_stage_n: update.stageN,
			});
			if (typeof existing.skill !== "string") existing.skill = "ralplan";
			if (typeof existing.active !== "boolean") existing.active = true;
			if (typeof existing.current_phase !== "string") existing.current_phase = "planner";
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan lane-verdict", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
			return true;
		},
		{ cwd },
	);
}

async function resolveArtifactArgs(args: readonly string[], cwd: string): Promise<ResolvedArtifactArgs> {
	const stage = flagValue(args, "--stage");
	if (!stage) throw new RalplanCommandError(2, "--stage is required for ralplan --write");
	assertKnownStage(stage);

	const stageN = parseStageN(flagValue(args, "--stage_n"));

	const rawArtifact = flagValue(args, "--artifact");
	const artifactEnvName = flagValue(args, "--artifact-env");
	const artifactSources = [rawArtifact, artifactEnvName].filter(value => value !== undefined);
	if (artifactSources.length === 0 || artifactSources.some(value => value === "")) {
		throw new RalplanCommandError(2, "--artifact or --artifact-env is required for ralplan --write");
	}
	if (artifactSources.length > 1) {
		throw new RalplanCommandError(2, "--artifact and --artifact-env are mutually exclusive");
	}
	if (artifactEnvName !== undefined && artifactEnvName !== GJC_RALPLAN_ARTIFACT_ENV) {
		throw new RalplanCommandError(2, `--artifact-env must be ${GJC_RALPLAN_ARTIFACT_ENV}`);
	}

	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");
	const sessionIdRaw = sessionId;

	// Precedence for run_id:
	//   1. explicit --run-id flag
	//   2. existing run_id field in .gjc/state[/sessions/<id>]/ralplan-state.json
	//   3. explicit --session-id flag (use as run id)
	//   4. freshly generated default run id
	const explicitRunId = flagValue(args, "--run-id")?.trim();
	const runId = explicitRunId || (await readActiveRunId(cwd, sessionId)) || sessionIdRaw || defaultRunId();
	assertSafePathComponent(runId, "run-id");

	const artifact =
		artifactEnvName !== undefined
			? (process.env[GJC_RALPLAN_ARTIFACT_ENV] ?? "")
			: await resolveArtifactContent(rawArtifact!, cwd);
	if (artifact === "") {
		throw new RalplanCommandError(2, "artifact content is empty");
	}
	return { stage: stage as RalplanStage, stageN, runId, artifact, sessionId, json: hasFlag(args, "--json") };
}

interface PersistedArtifact {
	runId: string;
	path: string;
	stage: RalplanStage;
	stageN: number;
	sha256: string;
	createdAt: string;
	pendingApprovalPath?: string;
}

/**
 * Content-addressed identity for an `index.jsonl` row: a repeated `--write` of the
 * same `(stage, stage_n)` at identical content (same sha256) is the #638 duplicate
 * the append must collapse. Rows missing these fields opt out of dedup.
 */
function ralplanIndexKey(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const record = entry as Record<string, unknown>;
	const { stage, stage_n, sha256 } = record;
	if (typeof stage !== "string" || typeof stage_n !== "number" || typeof sha256 !== "string") return undefined;
	return `${stage}\u0000${stage_n}\u0000${sha256}`;
}

async function persistArtifact(
	resolved: ResolvedArtifactArgs,
	cwd: string,
	content: string,
	sha256: string,
): Promise<PersistedArtifact> {
	const runDir = path.join(sessionPlansDir(cwd, resolved.sessionId), "ralplan", resolved.runId);

	const fileName = `stage-${pad2(resolved.stageN)}-${resolved.stage}.md`;
	const filePath = path.join(runDir, fileName);
	await writeArtifact(filePath, content, {
		cwd,
		audit: {
			category: "artifact",
			verb: "write",
			owner: "gjc-runtime",
			skill: "ralplan",
			sessionId: resolved.sessionId,
		},
	});

	const createdAt = new Date().toISOString();
	const indexEntry = {
		stage: resolved.stage,
		stage_n: resolved.stageN,
		path: filePath,
		created_at: createdAt,
		sha256,
	};
	await appendJsonlIdempotent(path.join(runDir, "index.jsonl"), indexEntry, {
		cwd,
		audit: {
			category: "ledger",
			verb: "append",
			owner: "gjc-runtime",
			skill: "ralplan",
			sessionId: resolved.sessionId,
		},
		key: ralplanIndexKey,
	});

	let pendingApprovalPath: string | undefined;
	if (resolved.stage === "final") {
		pendingApprovalPath = path.join(runDir, "pending-approval.md");
		await writeArtifact(pendingApprovalPath, content, {
			cwd,
			audit: {
				category: "artifact",
				verb: "write",
				owner: "gjc-runtime",
				skill: "ralplan",
				sessionId: resolved.sessionId,
			},
		});
	}

	return {
		runId: resolved.runId,
		path: filePath,
		stage: resolved.stage,
		stageN: resolved.stageN,
		sha256,
		createdAt,
		pendingApprovalPath,
	};
}

/** The persisted `(stage, stage_n)` artifact recorded in a run's `index.jsonl`. */
interface ExistingStageArtifact {
	path: string;
	sha256: string;
	createdAt: string;
}

/**
 * Find the most recent complete `index.jsonl` row for a `(stage, stage_n)` pair
 * in the single ledger snapshot used by the dedupe guard and both budget gates.
 * A parseable row missing `path` or `sha256` is intentionally treated as missing
 * so the deterministic on-disk probe can repair the crash gap.
 */
function findExistingStageArtifact(
	indexText: string | undefined,
	stage: RalplanStage,
	stageN: number,
): ExistingStageArtifact | undefined {
	if (indexText === undefined) return undefined;
	let match: ExistingStageArtifact | undefined;
	for (const line of indexText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let row: unknown;
		try {
			row = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const record = row as Record<string, unknown>;
		if (record.stage !== stage || record.stage_n !== stageN) continue;
		if (typeof record.path !== "string" || typeof record.sha256 !== "string") continue;
		match = {
			path: record.path,
			sha256: record.sha256,
			createdAt: typeof record.created_at === "string" ? record.created_at : "",
		};
	}
	return match;
}

interface OnDiskStageArtifact {
	path: string;
	sha256: string;
}

/** Probe the deterministic artifact path left by a crash before ledger append. */
async function findOnDiskStageArtifact(
	cwd: string,
	resolved: Pick<ResolvedArtifactArgs, "sessionId" | "runId" | "stage" | "stageN">,
): Promise<OnDiskStageArtifact | undefined> {
	const filePath = path.join(
		sessionPlansDir(cwd, resolved.sessionId),
		"ralplan",
		resolved.runId,
		`stage-${pad2(resolved.stageN)}-${resolved.stage}.md`,
	);
	try {
		const content = await fs.readFile(filePath, "utf8");
		return { path: filePath, sha256: createHash("sha256").update(content).digest("hex") };
	} catch (error) {
		const code = getErrorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

/** Ensure a deduplicated final stage still has its byte-identical pending-approval copy. */
async function ensureFinalPendingApproval(
	cwd: string,
	resolved: Pick<ResolvedArtifactArgs, "sessionId" | "runId" | "stageN">,
	stageArtifact: Pick<OnDiskStageArtifact, "path" | "sha256">,
): Promise<string> {
	const pendingApprovalPath = path.join(
		sessionPlansDir(cwd, resolved.sessionId),
		"ralplan",
		resolved.runId,
		"pending-approval.md",
	);
	const stageContent = await fs.readFile(stageArtifact.path);
	const stageSha256 = createHash("sha256").update(stageContent).digest("hex");
	if (stageSha256 !== stageArtifact.sha256) {
		throw new RalplanCommandError(
			2,
			`refusing to deduplicate ralplan final stage ${resolved.stageN}: stage artifact sha256 mismatch at ${stageArtifact.path} (ledger sha256=${stageArtifact.sha256}, artifact sha256=${stageSha256}).`,
		);
	}

	let pendingContent: Buffer;
	try {
		pendingContent = await fs.readFile(pendingApprovalPath);
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") throw error;
		await writeArtifact(pendingApprovalPath, stageContent.toString("utf8"), {
			cwd,
			audit: {
				category: "artifact",
				verb: "write",
				owner: "gjc-runtime",
				skill: "ralplan",
				sessionId: resolved.sessionId,
			},
		});
		return pendingApprovalPath;
	}

	const pendingSha256 = createHash("sha256").update(pendingContent).digest("hex");
	if (!pendingContent.equals(stageContent) || pendingSha256 !== stageSha256) {
		throw new RalplanCommandError(
			2,
			`refusing to deduplicate ralplan final stage ${resolved.stageN}: pending approval content mismatch at ${pendingApprovalPath} (stage sha256=${stageSha256}, pending sha256=${pendingSha256}).`,
		);
	}
	return pendingApprovalPath;
}

/** Append the missing row for a deterministic artifact that survived a crash gap. */
async function repairMissingStageArtifactLedger(
	cwd: string,
	resolved: Pick<ResolvedArtifactArgs, "sessionId" | "runId" | "stage" | "stageN">,
	onDisk: OnDiskStageArtifact,
): Promise<ExistingStageArtifact> {
	const createdAt = new Date().toISOString();
	const indexEntry = {
		stage: resolved.stage,
		stage_n: resolved.stageN,
		path: onDisk.path,
		created_at: createdAt,
		sha256: onDisk.sha256,
	};
	const result = await appendJsonlIdempotent(
		path.join(sessionPlansDir(cwd, resolved.sessionId), "ralplan", resolved.runId, "index.jsonl"),
		indexEntry,
		{
			cwd,
			audit: {
				category: "ledger",
				verb: "append",
				owner: "gjc-runtime",
				skill: "ralplan",
				sessionId: resolved.sessionId,
			},
			key: ralplanIndexKey,
		},
	);
	const duplicate = result.duplicate;
	if (duplicate && typeof duplicate === "object" && !Array.isArray(duplicate)) {
		const record = duplicate as Record<string, unknown>;
		if (typeof record.path === "string" && typeof record.sha256 === "string") {
			return {
				path: record.path,
				sha256: record.sha256,
				createdAt: typeof record.created_at === "string" ? record.created_at : createdAt,
			};
		}
	}
	return { path: onDisk.path, sha256: onDisk.sha256, createdAt };
}

/**
 * Read and parse the run's `index.jsonl` rows. Best-effort: returns [] when the
 * file is absent or unreadable so HUD sync never fails on a missing index.
 */
async function readRalplanIndexRows(cwd: string, sessionId: string, runId: string): Promise<RalplanIndexRow[]> {
	try {
		const indexPath = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId, "index.jsonl");
		const text = await fs.readFile(indexPath, "utf8");
		const rows: RalplanIndexRow[] = [];
		for (const line of text.split(/\r?\n/)) {
			const row = parseRalplanIndexLine(line);
			if (row) rows.push(row);
		}
		return rows;
	} catch {
		return [];
	}
}

/** Read the lane verdict from ralplan run state without making HUD sync fail on state read errors. */
async function readRalplanLastReviewVerdict(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		const existingRead = await readExistingStateForMutation(ralplanStatePath(cwd, sessionId));
		return existingRead.kind === "valid" && typeof existingRead.value.last_review_verdict === "string"
			? existingRead.value.last_review_verdict
			: undefined;
	} catch {
		return undefined;
	}
}

async function syncRalplanHud(options: {
	cwd: string;
	sessionId: string;
	stage: string;
	pendingApproval: boolean;
	iteration?: number;
	runId?: string;
	reviewPassBudget?: number;
	latestSummary?: string;
}): Promise<void> {
	try {
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "ralplan",
			active: !options.pendingApproval || options.stage === "final",
			phase: options.stage,
			sessionId: options.sessionId,
			source: "gjc-ralplan-native",
			hud: await buildRalplanHud(options),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

async function buildRalplanHud(options: {
	cwd: string;
	stage: string;
	pendingApproval: boolean;
	iteration?: number;
	latestSummary?: string;
	runId?: string;
	sessionId?: string;
	reviewPassBudget?: number;
}) {
	let iterationFromIndex: number | undefined;
	let stages: string | undefined;
	let architectPasses: number | undefined;
	let criticPasses: number | undefined;
	let verdict: string | undefined;
	if (options.runId && options.sessionId) {
		const [rows, lastReviewVerdict] = await Promise.all([
			readRalplanIndexRows(options.cwd, options.sessionId, options.runId),
			readRalplanLastReviewVerdict(options.cwd, options.sessionId),
		]);
		verdict = lastReviewVerdict;
		if (rows.length > 0) {
			const summary = summarizeRalplanIndex(rows);
			iterationFromIndex = summary.iteration;
			stages = formatRalplanStagePresence(summary.currentStages);
			architectPasses = summary.currentStages.filter(stage => stage === "architect").length;
			criticPasses = summary.currentStages.filter(stage => stage === "critic").length;
		}
	}
	return buildRalplanHudSummary({
		stage: options.stage,
		iteration: options.iteration,
		iterationFromIndex,
		stages,
		architectPasses,
		criticPasses,
		reviewPassBudget: options.reviewPassBudget,
		verdict,
		pendingApproval: options.pendingApproval,
		latestSummary: options.latestSummary,
		updatedAt: new Date().toISOString(),
	});
}

async function handleArtifactWrite(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	const resolved = await resolveArtifactArgs(args, cwd);
	const persistedRoleState = parsePersistedRoleStateArgs(args, resolved.stage);
	const laneVerdict = parseLaneVerdictArgs(args, resolved.stage, resolved.stageN);
	// Fail closed before stage persistence / path writes when cwd drifted to a sibling repo.
	const repositoryBinding = await enforceRalplanRepositoryBinding(cwd, resolved.sessionId);
	// Artifact file paths (when --artifact points at a file) must stay under the bound root.
	const rawArtifact = flagValue(args, "--artifact");
	if (rawArtifact && !isRestrictedRoleAgentBash()) {
		const candidate = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(cwd, rawArtifact);
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) {
				assertPathUnderRepositoryBinding(repositoryBinding, candidate);
			}
		} catch (error) {
			if (error instanceof RepositoryBindingError) {
				throw new RalplanCommandError(2, `ralplan repository binding rejected: ${error.message}`);
			}
			// Non-file / missing path is inline content; resolveArtifactContent already handled it.
		}
	}
	const content = resolved.artifact.endsWith("\n") ? resolved.artifact : `${resolved.artifact}\n`;
	const sha256 = createHash("sha256").update(content).digest("hex");

	// Read the ledger once before persistence. The dedupe guard and both gates
	// consume this same snapshot so no additional ledger read can slip between gate
	// evaluation and persistence.
	const indexLoad = await loadRalplanIndexForCap(cwd, resolved.sessionId, resolved.runId);

	// Duplicate-write guard: a second `--write` for the same (stage, stage_n) must not
	// silently clobber the artifact or append a duplicate ledger row. Classify before any
	// state mutation so a conflict never regresses run-state phase.
	const existingArtifact = findExistingStageArtifact(indexLoad.rawText, resolved.stage, resolved.stageN);
	if (existingArtifact) {
		if (existingArtifact.sha256 !== sha256) {
			throw new RalplanCommandError(
				2,
				`refusing to overwrite ralplan ${resolved.stage} stage ${resolved.stageN} at ${existingArtifact.path}: an artifact with different content already exists (existing sha256=${existingArtifact.sha256}, new sha256=${sha256}). Use a new --stage_n to record another pass.`,
			);
		}
		if (resolved.stage === "final") await ensureFinalPendingApproval(cwd, resolved, existingArtifact);
		return buildDeduplicatedResult(resolved, existingArtifact, sha256, cwd, repositoryBinding);
	}

	// `persistArtifact` writes the artifact before its ledger row. If a process crashed
	// in that gap, an identical retry repairs the row and remains a normal deduplicated
	// receipt; a differing retry retains the ordinary no-overwrite refusal.
	const onDiskArtifact = await findOnDiskStageArtifact(cwd, resolved);
	if (onDiskArtifact) {
		if (onDiskArtifact.sha256 !== sha256) {
			throw new RalplanCommandError(
				2,
				`refusing to overwrite ralplan ${resolved.stage} stage ${resolved.stageN} at ${onDiskArtifact.path}: an artifact with different content already exists (existing sha256=${onDiskArtifact.sha256}, new sha256=${sha256}). Use a new --stage_n to record another pass.`,
			);
		}
		if (resolved.stage === "final") await ensureFinalPendingApproval(cwd, resolved, onDiskArtifact);
		const repairedArtifact = await repairMissingStageArtifactLedger(cwd, resolved, onDiskArtifact);
		let appliedPersistedRoleState: PersistedRoleStateUpdate | undefined;
		if (
			persistedRoleState &&
			(await applyPersistedRoleStateUpdate(cwd, resolved.sessionId, persistedRoleState, resolved.runId))
		) {
			appliedPersistedRoleState = persistedRoleState;
		}
		let appliedLaneVerdict: LaneVerdictUpdate | undefined;
		if (laneVerdict && (await applyLaneVerdictUpdate(cwd, resolved.sessionId, laneVerdict, resolved.runId))) {
			appliedLaneVerdict = laneVerdict;
		}
		return buildDeduplicatedResult(
			resolved,
			repairedArtifact,
			sha256,
			cwd,
			repositoryBinding,
			appliedLaneVerdict,
			appliedPersistedRoleState,
		);
	}

	// Consensus iteration budget (#3165): refuse new planner/revision openers past the cap.
	// Dedupe returns above so identical re-writes never stuck-signal. Non-openers (architect,
	// critic, final, …) remain allowed so operators can escalate without auto-implementation.
	// On-disk opener artifacts floor the count so a wiped/truncated/malformed index.jsonl cannot
	// under-count and fail open after prior planner/revision writes.
	//
	// Gate evaluation, artifact write, and ledger append are sequential within one
	// `gjc ralplan --write` invocation. This is NOT exclusive across processes: no
	// run-scoped lock or CAS admission exists, intentionally matching #3165's
	// check-then-persist exposure.
	const [onDiskOpeners, onDiskLaneArtifacts, iterationLimit, laneLimit] = await Promise.all([
		countRalplanOnDiskOpeners(cwd, resolved.sessionId, resolved.runId),
		countRalplanOnDiskLaneArtifacts(cwd, resolved.sessionId, resolved.runId),
		resolveRalplanMaxIterations(cwd),
		resolveRalplanMaxReviewPassesPerLane(cwd),
	]);
	const capDecision = evaluateRalplanIterationCap({
		rows: indexLoad.rows,
		stage: resolved.stage,
		maxIterations: iterationLimit.maxIterations,
		iterationFloor: onDiskOpeners,
	});
	if (!capDecision.allowed) {
		return buildPlanningStuckResult({
			json: resolved.json,
			stage: resolved.stage,
			stageN: resolved.stageN,
			runId: resolved.runId,
			decision: capDecision,
			source: iterationLimit.source,
		});
	}
	const laneBudgetDecision = evaluateRalplanReviewLaneBudget({
		rows: indexLoad.rows,
		stage: resolved.stage,
		maxReviewPassesPerLane: laneLimit.maxReviewPassesPerLane,
		onDiskLaneCounts: onDiskLaneArtifacts,
	});
	if (!laneBudgetDecision.allowed) {
		return buildLaneBudgetStuckResult({
			json: resolved.json,
			stage: resolved.stage,
			stageN: resolved.stageN,
			runId: resolved.runId,
			decision: laneBudgetDecision,
			source: laneLimit.source,
		});
	}

	// Keep run-state `current_phase` coherent with the stage being persisted.
	await persistActiveRunId(cwd, resolved.sessionId, resolved.runId, resolved.stage);
	const persisted = await persistArtifact(resolved, cwd, content, sha256);
	if (persistedRoleState) {
		await applyPersistedRoleStateUpdate(cwd, resolved.sessionId, persistedRoleState);
	}
	if (laneVerdict) {
		await applyLaneVerdictUpdate(cwd, resolved.sessionId, laneVerdict);
	}
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "ralplan-runtime", path: persisted.path });
	await syncRalplanHud({
		cwd,
		sessionId: resolved.sessionId,
		stage: persisted.stage,
		runId: persisted.runId,
		pendingApproval: persisted.stage === "final",
		iteration: persisted.stageN,
		reviewPassBudget: laneLimit.maxReviewPassesPerLane,
		latestSummary: `persisted ${persisted.stage} stage ${persisted.stageN}`,
	});
	const reviewBudgetWarning =
		laneBudgetDecision.lane && laneBudgetDecision.finalSlot && laneBudgetDecision.maxReviewPassesPerLane > 1
			? {
					lane: laneBudgetDecision.lane,
					passes: laneBudgetDecision.projectedPasses,
					max: laneBudgetDecision.maxReviewPassesPerLane,
				}
			: undefined;

	const payload: Record<string, unknown> = {
		run_id: persisted.runId,
		path: persisted.path,
		stage: persisted.stage,
		stage_n: persisted.stageN,
		sha256: persisted.sha256,
		repository_binding: repositoryBinding,
		created_at: persisted.createdAt,
	};
	if (persisted.pendingApprovalPath) payload.pending_approval_path = persisted.pendingApprovalPath;
	if (persistedRoleState) payload[`${persistedRoleState.role}_state`] = persistedRoleStatePayload(persistedRoleState);
	if (reviewBudgetWarning) payload.review_budget_warning = reviewBudgetWarning;
	if (laneVerdict) payload.lane_verdict = { lane: laneVerdict.lane, verdict: laneVerdict.verdict };

	const stdout = resolved.json
		? `${JSON.stringify(payload, null, 2)}\n`
		: `${reviewBudgetWarning ? `Warning: ralplan ${reviewBudgetWarning.lane} review budget final slot used (${reviewBudgetWarning.passes}/${reviewBudgetWarning.max}).\n` : ""}Persisted ralplan ${persisted.stage} stage ${persisted.stageN} at ${persisted.path}.\n`;
	return { status: 0, stdout };
}

/**
 * Deterministic receipt for an identical repeated `--write`. Ledger-backed duplicates
 * do not rewrite artifacts, append rows, or churn run state; a crash-gap repair may
 * complete riding persisted role/lane metadata before returning this receipt.
 */
function buildDeduplicatedResult(
	resolved: ResolvedArtifactArgs,
	existing: ExistingStageArtifact,
	sha256: string,
	cwd: string,
	repositoryBinding: RepositoryBinding,
	laneVerdict?: LaneVerdictUpdate,
	persistedRoleState?: PersistedRoleStateUpdate,
): RalplanCommandResult {
	const payload: Record<string, unknown> = {
		run_id: resolved.runId,
		path: existing.path,
		stage: resolved.stage,
		stage_n: resolved.stageN,
		sha256,
		repository_binding: repositoryBinding,
		created_at: existing.createdAt,
		deduplicated: true,
	};
	if (laneVerdict) payload.lane_verdict = { lane: laneVerdict.lane, verdict: laneVerdict.verdict };
	if (persistedRoleState) {
		payload[`${persistedRoleState.role}_state`] = persistedRoleStatePayload(persistedRoleState);
	}
	if (resolved.stage === "final") {
		payload.pending_approval_path = path.join(
			sessionPlansDir(cwd, resolved.sessionId),
			"ralplan",
			resolved.runId,
			"pending-approval.md",
		);
	}
	const stdout = resolved.json
		? `${JSON.stringify(payload, null, 2)}\n`
		: `ralplan ${resolved.stage} stage ${resolved.stageN} already persisted at ${existing.path} (identical content; no changes written).\n`;
	return { status: 0, stdout };
}

/* -------------------------------- handoff -------------------------------- */

interface ConsensusHandoffArgs {
	interactive: boolean;
	deliberate: boolean;
	architectKind?: string;
	criticKind?: string;
	sessionId: string;
	task: string;
	json: boolean;
}

function extractPositionalTask(args: readonly string[]): string {
	const parts: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (VALUE_FLAGS.has(arg)) {
			skipNext = true;
			continue;
		}
		if (arg === "--interactive" || arg === "--deliberate" || arg === "--write" || arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new RalplanCommandError(2, `unknown flag for gjc ralplan: ${arg}`);
		}
		parts.push(arg);
	}
	return parts.join(" ").trim();
}

function resolveConsensusArgs(args: readonly string[], cwd: string): ConsensusHandoffArgs {
	if (hasFlag(args, "--lane-verdict")) {
		throw new RalplanCommandError(2, "--lane-verdict is only supported with gjc ralplan --write.");
	}
	const architectKind = flagValue(args, "--architect")?.trim() || undefined;
	if (architectKind && !KNOWN_ARCHITECT_KINDS.has(architectKind)) {
		throw new RalplanCommandError(
			2,
			`unknown --architect kind: ${architectKind}. Expected one of: ${[...KNOWN_ARCHITECT_KINDS].join(", ")}.`,
		);
	}
	const criticKind = flagValue(args, "--critic")?.trim() || undefined;
	if (criticKind && !KNOWN_CRITIC_KINDS.has(criticKind)) {
		throw new RalplanCommandError(
			2,
			`unknown --critic kind: ${criticKind}. Expected one of: ${[...KNOWN_CRITIC_KINDS].join(", ")}.`,
		);
	}
	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");
	const task = extractPositionalTask(args);
	return {
		interactive: hasFlag(args, "--interactive"),
		deliberate: hasFlag(args, "--deliberate"),
		architectKind,
		criticKind,
		sessionId,
		task,
		json: hasFlag(args, "--json"),
	};
}

async function seedRalplanState(
	cwd: string,
	resolved: ConsensusHandoffArgs,
): Promise<{ statePath: string; runId: string; repositoryBinding: RepositoryBinding }> {
	const statePath = ralplanStatePath(cwd, resolved.sessionId);
	// Reuse an existing run id when present so a re-invocation of `gjc ralplan "task"` doesn't
	// orphan in-progress artifacts under a fresh run id.
	const existingRunId = await readActiveRunId(cwd, resolved.sessionId);
	const runId = existingRunId ?? resolved.sessionId ?? defaultRunId();
	assertSafePathComponent(runId, "run-id");
	const now = new Date().toISOString();
	// When an active seed already carries authority, re-entry must match it (fail closed).
	// Otherwise stamp the current cwd as the durable binding for this run.
	const repositoryBinding = existingRunId
		? await enforceRalplanRepositoryBinding(cwd, resolved.sessionId)
		: publicRepositoryBinding(await captureRepositoryBinding(cwd, { displayPath: cwd }));
	const payload: Record<string, unknown> = {
		active: true,
		current_phase: "planner",
		skill: "ralplan",
		version: WORKFLOW_STATE_VERSION,
		mode: resolved.deliberate ? "deliberate" : "short",
		interactive: resolved.interactive,
		task: resolved.task,
		run_id: runId,
		updated_at: now,
		repository_binding: repositoryBinding,
	};
	if (resolved.architectKind) payload.architect_kind = resolved.architectKind;
	if (resolved.criticKind) payload.critic_kind = resolved.criticKind;
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		receipt: {
			cwd,
			skill: "ralplan",
			owner: "gjc-runtime",
			command: "gjc ralplan seed",
			sessionId: resolved.sessionId,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "ralplan",
			sessionId: resolved.sessionId,
		},
	});
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "ralplan-runtime", path: statePath });
	return { statePath, runId, repositoryBinding };
}

async function handleConsensusHandoff(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	const resolved = resolveConsensusArgs(args, cwd);
	if (!resolved.task) {
		throw new RalplanCommandError(2, 'gjc ralplan requires a task description, e.g. `gjc ralplan "<task>"`.');
	}
	const { statePath, runId, repositoryBinding } = await seedRalplanState(cwd, resolved);
	const mode = resolved.deliberate ? "deliberate" : "short";
	await syncRalplanHud({
		cwd,
		sessionId: resolved.sessionId,
		stage: "planner",
		runId,
		pendingApproval: false,
		iteration: 1,
		latestSummary: `${mode} run · ${resolved.interactive ? "interactive" : "automated"}`,
	});

	const summary = {
		skill: "ralplan",
		mode,
		state_path: statePath,
		run_id: runId,
		handoff: "/skill:ralplan",
		repository_binding: repositoryBinding,
	};
	const stdout = resolved.json
		? renderCliWriteReceipt({ ok: true, ...summary })
		: [
				`ralplan seed run_id=${runId}`,
				`state_path=${statePath}`,
				`mode=${mode} interactive=${resolved.interactive} architect=${resolved.architectKind ?? "default"} critic=${resolved.criticKind ?? "default"}`,
				"handoff=/skill:ralplan",
				"",
			].join("\n");
	return { status: 0, stdout };
}

async function handleDoctor(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	return await runNativeStateCommand(["doctor", "--skill", "ralplan", ...args.slice(1)], cwd);
}

/* -------------------------------- entry --------------------------------- */

export async function runNativeRalplanCommand(args: string[], cwd = process.cwd()): Promise<RalplanCommandResult> {
	try {
		if (isRalplanDoctorInvocation(args)) return await handleDoctor(args, cwd);
		if (isRalplanArtifactWriteInvocation(args)) return await handleArtifactWrite(args, cwd);
		return await handleConsensusHandoff(args, cwd);
	} catch (error) {
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
