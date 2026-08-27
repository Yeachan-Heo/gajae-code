import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSettingsInitialized, Settings } from "../config/settings";
import { syncSkillActiveState } from "../skill-state/active-state";
import { buildRalplanHudSummary } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import { repo } from "../utils/git";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import {
	formatRalplanStagePresence,
	parseRalplanIndexLine,
	type RalplanIndexRow,
	summarizeRalplanIndex,
} from "./ledger-event-renderer";
import {
	type IndexedReviewArtifact,
	parseReviewConflictDocument,
	reviewArtifactIndexKey,
	serializeReviewConflictDocument,
} from "./ralplan-review-conflicts";
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
import { gjcRoot, modeStatePath, sessionIdFromDirName, sessionPlansDir } from "./session-layout";
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
import {
	resolveWorkflowSetting,
	WorkflowSettingError,
	type WorkflowSettingKey,
	type WorkflowSettingParseResult,
} from "./workflow-settings";
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
 *    / Critic / intent / disposition / revision / post-interview / ADR / final artifacts under
 *    `.gjc/plans/ralplan/<run-id>/`, maintains an `index.jsonl` audit log, copies `final`
 *    stages to `pending-approval.md`, and advances the HUD chip to reflect the latest
 *    persisted stage. Disposition stage artifacts are fail-closed JSON documents that
 *    record typed review conflicts with authoritative same-pass source receipts (#2902).
 */

export interface RalplanCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const KNOWN_STAGES = [
	"planner",
	"intent",
	"architect",
	"critic",
	"disposition",
	"revision",
	"post-interview",
	"adr",
	"final",
] as const;
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
export type RalplanAutoHandoffTarget = "off" | "ultragoal" | "autoresearch";

export interface RalplanAutoHandoffResolution {
	configuredTarget: RalplanAutoHandoffTarget;
	effectiveTarget: RalplanAutoHandoffTarget;
	degradationReason: string | null;
	source: string;
}

const RALPLAN_AUTO_HANDOFF_TARGETS = new Set<RalplanAutoHandoffTarget>(["off", "ultragoal", "autoresearch"]);

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

/** Adapt a nullable parser to the shared resolver's parse-result shape. */
function workflowSettingParse<T>(
	parse: (value: unknown) => T | null,
	reason: string,
): (value: unknown) => WorkflowSettingParseResult<T> {
	return value => {
		const parsed = parse(value);
		return parsed === null ? { kind: "invalid", reason } : { kind: "valid", value: parsed };
	};
}

/**
 * Resolve a strict ralplan setting through the shared five-layer resolver.
 * Malformed/invalid explicit sources in any layer/format fail closed (exit 2)
 * and never fall through to a lower layer or the built-in default.
 */
async function resolveStrictRalplanSetting<T>(
	cwd: string,
	key: WorkflowSettingKey,
	parse: (value: unknown) => WorkflowSettingParseResult<T>,
	defaultValue: T,
	agentDir?: string,
): Promise<{ value: T; source: string }> {
	try {
		const resolution = await resolveWorkflowSetting(cwd, key, {
			defaultValue,
			parse,
			invalidPolicy: "throw",
			// The session's effective agent profile: an SDK session created with
			// `createAgentSession({ agentDir })` resolves against that directory
			// instead of the process-global default.
			agentDir: agentDir ?? (isSettingsInitialized() ? Settings.instance.getAgentDir() : undefined),
		});
		return { value: resolution.value, source: resolution.source };
	} catch (error) {
		if (error instanceof WorkflowSettingError) {
			throw new RalplanCommandError(2, `invalid ralplan settings at ${error.path}: ${error.reason}`);
		}
		throw error;
	}
}

/**
 * Resolve the ralplan consensus iteration cap through the shared resolver.
 * Project `.gjc/config.yml` and `.gjc/settings.json` beat user layers.
 */
export async function resolveRalplanMaxIterations(
	cwd: string,
	agentDir?: string,
): Promise<{ maxIterations: number; source: string }> {
	const { value, source } = await resolveStrictRalplanSetting(
		cwd,
		"gjc.ralplan.maxIterations",
		workflowSettingParse(
			parseMaxIterationsValue,
			`expected gjc.ralplan.maxIterations to be an integer between 1 and ${RALPLAN_MAX_ITERATIONS_LIMIT}`,
		),
		RALPLAN_DEFAULT_MAX_ITERATIONS,
		agentDir,
	);
	return { maxIterations: value, source };
}

function parseRalplanAutoHandoffTarget(value: unknown): RalplanAutoHandoffTarget | undefined {
	return typeof value === "string" && RALPLAN_AUTO_HANDOFF_TARGETS.has(value as RalplanAutoHandoffTarget)
		? (value as RalplanAutoHandoffTarget)
		: undefined;
}

type RalplanAutoHandoffOptions = {
	planningStuck?: boolean;
	/** The session's effective agent directory (see resolveWorkflowSetting). */
	agentDir?: string;
};

function parsePresentRalplanAutoHandoff(value: unknown): WorkflowSettingParseResult<RalplanAutoHandoffTarget> {
	const target = parseRalplanAutoHandoffTarget(value);
	return target === undefined
		? { kind: "invalid", reason: "expected gjc.ralplan.autoHandoff to be one of off, ultragoal, autoresearch" }
		: { kind: "valid", value: target };
}

export async function resolveRalplanAutoHandoff(
	cwd: string,
	options: RalplanAutoHandoffOptions = {},
): Promise<RalplanAutoHandoffResolution> {
	const { value, source } = await resolveStrictRalplanSetting(
		cwd,
		"gjc.ralplan.autoHandoff",
		parsePresentRalplanAutoHandoff,
		"off",
		options.agentDir,
	);
	return resolveRalplanAutoHandoffTarget(value, source, options);
}

function resolveRalplanAutoHandoffTarget(
	configuredTarget: RalplanAutoHandoffTarget,
	source: string,
	options: RalplanAutoHandoffOptions,
): RalplanAutoHandoffResolution {
	if (options.planningStuck) {
		return { configuredTarget, effectiveTarget: "off", degradationReason: "planning_stuck", source };
	}
	return { configuredTarget, effectiveTarget: configuredTarget, degradationReason: null, source };
}

function parseMaxReviewPassesPerLaneValue(value: unknown): number | null {
	return parseBoundedPositiveInteger(value, RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT);
}

/** Resolve the per-lane review-pass budget through the shared resolver. */
export async function resolveRalplanMaxReviewPassesPerLane(
	cwd: string,
	agentDir?: string,
): Promise<{ maxReviewPassesPerLane: number; source: string }> {
	const { value, source } = await resolveStrictRalplanSetting(
		cwd,
		"gjc.ralplan.maxReviewPassesPerLane",
		workflowSettingParse(
			parseMaxReviewPassesPerLaneValue,
			`expected gjc.ralplan.maxReviewPassesPerLane to be an integer between 1 and ${RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT}`,
		),
		RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE,
		agentDir,
	);
	return { maxReviewPassesPerLane: value, source };
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
	"--worktree-root",
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

/* --------------------------- target worktree root --------------------------- */

/**
 * Explicit target-worktree routing (#4693). `--worktree-root <path>` selects the
 * canonical git worktree that owns every ralplan persistence root (run state,
 * stage artifacts, index ledger, HUD state, stuck markers, and review-budget
 * accounting) regardless of the writer process's ambient cwd. Without the flag,
 * behavior stays cwd-based. The invoking cwd is retained only for resolving a
 * relative `--artifact` input file.
 */
interface RalplanTargetRoot {
	/** Canonical persistence root: the invocation cwd, or the --worktree-root target. */
	root: string;
	/** True when the caller explicitly selected the target via --worktree-root. */
	explicit: boolean;
}

export async function resolveRalplanTargetRoot(
	args: readonly string[],
	invocationCwd: string,
): Promise<RalplanTargetRoot> {
	const occurrences: number[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--worktree-root") occurrences.push(index);
	}
	if (occurrences.length === 0) return { root: invocationCwd, explicit: false };
	if (occurrences.length > 1) {
		throw new RalplanCommandError(2, "ralplan --worktree-root may be supplied at most once");
	}
	const flagIndex = occurrences[0]!;
	const raw = args[flagIndex + 1];
	if (raw === undefined || raw.startsWith("-")) {
		throw new RalplanCommandError(2, "--worktree-root requires a non-empty path");
	}
	const trimmed = raw.trim();
	if (!trimmed) throw new RalplanCommandError(2, "--worktree-root requires a non-empty path");
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(invocationCwd, trimmed);
	// Canonicalize (and prove existence) before any state or artifact write.
	let canonical: string;
	try {
		canonical = await fs.realpath(resolved);
	} catch {
		throw new RalplanCommandError(2, `ralplan --worktree-root does not exist: ${resolved}`);
	}
	const stat = await fs.stat(canonical);
	if (!stat.isDirectory()) {
		throw new RalplanCommandError(2, `ralplan --worktree-root is not a directory: ${canonical}`);
	}
	const repository = await repo.resolve(canonical);
	if (!repository) {
		throw new RalplanCommandError(2, `ralplan --worktree-root is not inside a git repository: ${canonical}`);
	}
	// Do not pass the caret-containing `HEAD^{commit}` revision here. On Windows,
	// Bun may dispatch git through a `.cmd` shim, where `^` is interpreted by the
	// command shell before git receives the argument. HEAD is sufficient after
	// resolving a repository root: an unborn or non-commit HEAD still fails the
	// same validation, while the argv remains shell-safe on every platform.
	const verified = Bun.spawn(["git", "-C", canonical, "rev-parse", "--verify", "HEAD"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [verifiedStatus, verifiedOutput] = await Promise.all([verified.exited, new Response(verified.stdout).text()]);
	const headObject = verifiedOutput.trim();
	if (verifiedStatus !== 0 || !/^[0-9a-f]{40}$/u.test(headObject)) {
		throw new RalplanCommandError(2, `ralplan --worktree-root is not a valid git worktree: ${canonical}`);
	}
	const objectType = Bun.spawn(["git", "-C", canonical, "cat-file", "-t", headObject], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [objectTypeStatus, objectTypeOutput] = await Promise.all([
		objectType.exited,
		new Response(objectType.stdout).text(),
	]);
	if (objectTypeStatus !== 0 || objectTypeOutput.trim() !== "commit") {
		throw new RalplanCommandError(2, `ralplan --worktree-root is not a commit worktree: ${canonical}`);
	}
	let worktreeRoot: string;
	try {
		worktreeRoot = await fs.realpath(repository.repoRoot);
	} catch {
		worktreeRoot = path.resolve(repository.repoRoot);
	}
	if (worktreeRoot !== canonical) {
		throw new RalplanCommandError(
			2,
			`ralplan --worktree-root must be the git worktree root (${worktreeRoot}), not a subdirectory: ${canonical}`,
		);
	}
	return { root: canonical, explicit: true };
}

export async function assertExplicitTargetGjcNotSymlinked(root: string): Promise<void> {
	const gjcRoot = path.join(root, ".gjc");
	let st: fssync.Stats;
	try {
		st = await fs.lstat(gjcRoot);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return;
		throw new RalplanCommandError(2, `failed to inspect ${gjcRoot}: ${err.message}`);
	}
	if (st.isSymbolicLink()) {
		throw new RalplanCommandError(2, `ralplan --worktree-root refuses a symlinked .gjc root: ${gjcRoot}`);
	}
	const realGjc = await fs.realpath(gjcRoot);
	const realRoot = await fs.realpath(root);
	const relative = path.relative(realRoot, realGjc);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new RalplanCommandError(2, `ralplan --worktree-root .gjc escapes the target worktree: ${gjcRoot}`);
	}
}

async function readConfinedArtifactFile(candidate: string, confineRoot: string): Promise<string> {
	let realRoot: string;
	try {
		realRoot = await fs.realpath(confineRoot);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		throw new RalplanCommandError(2, `failed to read --artifact ${candidate}: ${err.message}`);
	}
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(candidate, fssync.constants.O_RDONLY | fssync.constants.O_NOFOLLOW);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		throw new RalplanCommandError(2, `failed to read --artifact ${candidate}: ${err.message}`);
	}
	try {
		const opened = await handle.stat();
		if (!opened.isFile()) {
			throw new RalplanCommandError(2, `ralplan --artifact is not a regular file: ${candidate}`);
		}
		const fdPath = `/proc/self/fd/${handle.fd}`;
		let openedIdentity: string;
		try {
			openedIdentity = await fs.realpath(fdPath);
		} catch {
			throw new RalplanCommandError(2, `ralplan --artifact identity could not be established: ${candidate}`);
		}
		const relative = path.relative(realRoot, openedIdentity);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new RalplanCommandError(2, `ralplan --artifact path escapes the invoking cwd: ${candidate}`);
		}
		return await handle.readFile("utf-8");
	} finally {
		await handle.close();
	}
}
async function resolveArtifactContent(
	rawArtifact: string,
	cwd: string,
	options: { confineRoot?: string } = {},
): Promise<string> {
	if (isRestrictedRoleAgentBash()) return rawArtifact;
	const candidate = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(cwd, rawArtifact);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) {
			if (options.confineRoot) return await readConfinedArtifactFile(candidate, options.confineRoot);
			return await fs.readFile(candidate, "utf-8");
		}
	} catch (error) {
		if (error instanceof RalplanCommandError) throw error;
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
async function enforceRalplanRepositoryBinding(
	cwd: string,
	sessionId: string,
	options: { exactWorktreeRoot?: boolean } = {},
): Promise<RepositoryBinding> {
	const statePath = ralplanStatePath(cwd, sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "corrupt") {
		throw new RalplanCommandError(
			2,
			`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to proceed at ${statePath}`,
		);
	}
	if (existingRead.kind === "absent") {
		if (options.exactWorktreeRoot) {
			// Explicit-target mode declares the run lives exactly at the selected
			// worktree. A missing seed there means the target does not own this run
			// (e.g. a linked worktree that merely shares commonDir): fail before any
			// filesystem mutation instead of stamping fragmented authority (#4693).
			throw new RalplanCommandError(
				2,
				`ralplan --worktree-root ${cwd} holds no seeded ralplan run state for session ${sessionId}; seed the run at the target worktree first, or pass the seeded run's repository_binding.worktreeRoot`,
			);
		}
		// No prior seed — capture live authority so subsequent handoffs still have a stamp.
		return publicRepositoryBinding(await captureRepositoryBinding(cwd, { displayPath: cwd }));
	}
	const raw = existingRead.value.repository_binding ?? existingRead.value.repositoryBinding;
	if (raw === undefined) {
		if (options.exactWorktreeRoot) {
			throw new RalplanCommandError(
				2,
				`ralplan run state at ${statePath} predates repository binding; re-seed the run at the target worktree`,
			);
		}
		// Legacy seeds without a field: stamp current cwd and require future writes match it.
		return publicRepositoryBinding(await captureRepositoryBinding(cwd, { displayPath: cwd }));
	}
	try {
		const binding = parseRepositoryBinding(raw);
		if (options.exactWorktreeRoot) {
			// #4693: explicit-target mode requires exact canonical worktreeRoot
			// equality with the seeded run binding; a linked worktree that only
			// shares commonDir is a different artifact root and is rejected.
			const active = await captureRepositoryBinding(cwd);
			if (path.resolve(active.worktreeRoot) !== path.resolve(binding.worktreeRoot)) {
				throw new RepositoryBindingError(
					"identity_mismatch",
					`ralplan explicit target worktree must exactly equal the run's bound worktreeRoot (linked worktrees sharing one commonDir are not accepted in --worktree-root mode). target=${active.worktreeRoot} bound=${binding.worktreeRoot}`,
				);
			}
			return publicRepositoryBinding(binding);
		}
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
				delete existing.planning_stuck;
				delete existing.auto_handoff;
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
				lockHeld: true,
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
				lockHeld: true,
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
				lockHeld: true,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan lane-verdict", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
			return true;
		},
		{ cwd },
	);
}
function ralplanPlanningStuckIndexKey(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const record = entry as Record<string, unknown>;
	return record.planning_stuck === true ? "planning_stuck" : undefined;
}

async function recordRalplanPlanningStuck(
	cwd: string,
	sessionId: string,
	runId: string,
	reason: string,
): Promise<void> {
	const runDir = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId);
	await appendJsonlIdempotent(
		path.join(runDir, "index.jsonl"),
		{
			event: "planning_stuck",
			planning_stuck: true,
			marker: PLANNING_STUCK_MARKER,
			reason,
			created_at: new Date().toISOString(),
		},
		{
			cwd,
			audit: {
				category: "ledger",
				verb: "append",
				owner: "gjc-runtime",
				skill: "ralplan",
				sessionId,
			},
			key: ralplanPlanningStuckIndexKey,
		},
	);
	const statePath = ralplanStatePath(cwd, sessionId);
	await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") return;
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};
			if (existing.run_id !== runId) return;
			existing.planning_stuck = { marker: PLANNING_STUCK_MARKER, reason };
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				lockHeld: true,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan planning-stuck", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
		},
		{ cwd },
	);
}

async function readRalplanFinalAdmission(
	cwd: string,
	sessionId: string,
	runId: string,
): Promise<RalplanAutoHandoffResolution | undefined> {
	const index = await loadRalplanIndexForCap(cwd, sessionId, runId);
	if (index.rawText === undefined) return undefined;
	let finalAdmission: RalplanAutoHandoffResolution | undefined;
	for (const line of index.rawText.split(/\r?\n/)) {
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (row.stage === "final" && typeof row.path === "string" && typeof row.sha256 === "string") {
				finalAdmission = parseRalplanFinalAdmission(row.auto_handoff) ?? unavailableRalplanFinalAdmission();
			}
		} catch {
			// The artifact dedupe guard handles malformed ledger records separately.
		}
	}
	return finalAdmission;
}

async function readRalplanPlanningStuck(cwd: string, sessionId: string, runId: string): Promise<boolean> {
	const index = await loadRalplanIndexForCap(cwd, sessionId, runId);
	if (index.rawText === undefined) return index.indexPresent;
	if (index.indexPresent && index.rawLineCount > 0 && index.parseableLines === 0) return true;
	for (const line of index.rawText.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (row.planning_stuck === true) return true;
		} catch {
			return true;
		}
	}
	return false;
}

async function persistRalplanFinalAdmission(
	cwd: string,
	sessionId: string,
	runId: string,
	admission: RalplanAutoHandoffResolution,
): Promise<void> {
	const statePath = ralplanStatePath(cwd, sessionId);
	await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to record final admission`,
				);
			}
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};
			if (existing.run_id !== runId) return;
			existing.auto_handoff = admission;
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				lockHeld: true,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan final-admission", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
		},
		{ cwd },
	);
}

async function findExistingRalplanRunOwners(cwd: string, runId: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await fs.readdir(gjcRoot(cwd), { withFileTypes: true });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
		throw error;
	}

	const owners = await Promise.all(
		entries.map(async entry => {
			if (!entry.isDirectory()) return undefined;
			const sessionId = sessionIdFromDirName(entry.name);
			if (!sessionId) return undefined;

			const stateRead = await readExistingStateForMutation(ralplanStatePath(cwd, sessionId));
			const stateOwnsRun =
				stateRead.kind === "valid" &&
				typeof stateRead.value.run_id === "string" &&
				stateRead.value.run_id.trim() === runId;
			if (stateOwnsRun) return sessionId;

			try {
				const stat = await fs.stat(path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId));
				return stat.isDirectory() ? sessionId : undefined;
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err.code === "ENOENT" || err.code === "ENOTDIR") return undefined;
				throw error;
			}
		}),
	);
	return owners.filter((owner): owner is string => owner !== undefined).sort();
}

async function resolveArtifactSessionId(args: readonly string[], cwd: string, explicitRunId: string | undefined) {
	const flagSessionId = flagValue(args, "--session-id");
	const currentSession = resolveGjcSessionForWrite(cwd, {
		flagValue: flagSessionId,
		envSessionId: process.env.GJC_SESSION_ID,
	});
	if (!explicitRunId) return currentSession.gjcSessionId;

	const owners = await findExistingRalplanRunOwners(cwd, explicitRunId);
	if (owners.length === 0) return currentSession.gjcSessionId;
	if (owners.length > 1) {
		throw new RalplanCommandError(
			2,
			`ralplan run ${explicitRunId} has multiple owner sessions (${owners.join(", ")}); repair the fragmented run before writing`,
		);
	}

	const ownerSessionId = owners[0]!;
	if (flagSessionId !== undefined && currentSession.gjcSessionId !== ownerSessionId) {
		throw new RalplanCommandError(
			2,
			`ralplan run ${explicitRunId} is owned by session ${ownerSessionId}, not ${currentSession.gjcSessionId}`,
		);
	}
	return ownerSessionId;
}

async function resolveArtifactArgs(
	args: readonly string[],
	cwd: string,
	artifactBaseCwd: string = cwd,
	options: { confineArtifactRoot?: string } = {},
): Promise<ResolvedArtifactArgs> {
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

	const explicitRunId = flagValue(args, "--run-id")?.trim();
	if (explicitRunId) assertSafePathComponent(explicitRunId, "run-id");

	const sessionId = await resolveArtifactSessionId(args, cwd, explicitRunId);
	assertSafePathComponent(sessionId, "session-id");
	const sessionIdRaw = sessionId;

	// Precedence for run_id:
	//   1. explicit --run-id flag
	//   2. existing run_id field in the resolved owner session's ralplan state
	//   3. resolved owner session id
	//   4. freshly generated default run id
	const runId = explicitRunId || (await readActiveRunId(cwd, sessionId)) || sessionIdRaw || defaultRunId();
	assertSafePathComponent(runId, "run-id");

	const artifact =
		artifactEnvName !== undefined
			? (process.env[GJC_RALPLAN_ARTIFACT_ENV] ?? "")
			: await resolveArtifactContent(rawArtifact!, artifactBaseCwd, {
					confineRoot: options.confineArtifactRoot,
				});
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
	finalAdmission?: RalplanAutoHandoffResolution,
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
		...(finalAdmission ? { auto_handoff: finalAdmission } : {}),
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
	autoHandoff?: RalplanAutoHandoffResolution;
}

function parseRalplanFinalAdmission(value: unknown): RalplanAutoHandoffResolution | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const admission = value as Record<string, unknown>;
	if (
		!RALPLAN_AUTO_HANDOFF_TARGETS.has(admission.configuredTarget as RalplanAutoHandoffTarget) ||
		!RALPLAN_AUTO_HANDOFF_TARGETS.has(admission.effectiveTarget as RalplanAutoHandoffTarget) ||
		(typeof admission.degradationReason !== "string" && admission.degradationReason !== null) ||
		typeof admission.source !== "string"
	) {
		return undefined;
	}
	return {
		configuredTarget: admission.configuredTarget as RalplanAutoHandoffTarget,
		effectiveTarget: admission.effectiveTarget as RalplanAutoHandoffTarget,
		degradationReason: typeof admission.degradationReason === "string" ? admission.degradationReason : null,
		source: admission.source,
	};
}

function unavailableRalplanFinalAdmission(): RalplanAutoHandoffResolution {
	return {
		configuredTarget: "off",
		effectiveTarget: "off",
		degradationReason: "admission_unavailable",
		source: "ledger",
	};
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
			...(stage === "final" ? { autoHandoff: parseRalplanFinalAdmission(record.auto_handoff) } : {}),
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
	finalAdmission?: RalplanAutoHandoffResolution,
): Promise<ExistingStageArtifact> {
	const createdAt = new Date().toISOString();
	const indexEntry = {
		stage: resolved.stage,
		stage_n: resolved.stageN,
		path: onDisk.path,
		created_at: createdAt,
		sha256: onDisk.sha256,
		...(finalAdmission ? { auto_handoff: finalAdmission } : {}),
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
				...(resolved.stage === "final"
					? { autoHandoff: parseRalplanFinalAdmission(record.auto_handoff) ?? unavailableRalplanFinalAdmission() }
					: {}),
			};
		}
	}
	return {
		path: onDisk.path,
		sha256: onDisk.sha256,
		createdAt,
		...(resolved.stage === "final" ? { autoHandoff: finalAdmission ?? unavailableRalplanFinalAdmission() } : {}),
	};
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
	let autoHandoff: RalplanAutoHandoffResolution | undefined;
	let planningStuck = false;
	if (options.runId && options.sessionId) {
		const [rows, lastReviewVerdict, persistedAutoHandoff, persistedPlanningStuck] = await Promise.all([
			readRalplanIndexRows(options.cwd, options.sessionId, options.runId),
			readRalplanLastReviewVerdict(options.cwd, options.sessionId),
			readRalplanFinalAdmission(options.cwd, options.sessionId, options.runId),
			readRalplanPlanningStuck(options.cwd, options.sessionId, options.runId),
		]);
		verdict = lastReviewVerdict;
		autoHandoff = persistedAutoHandoff;
		planningStuck = persistedPlanningStuck;
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
		autoHandoff,
		planningStuck,
		pendingApproval: options.pendingApproval,
		latestSummary: options.latestSummary,
		updatedAt: new Date().toISOString(),
	});
}

/**
 * Disposition-stage artifacts are machine-checkable JSON. Validate, enforce
 * authoritative same-pass provenance against the run index, and re-serialize to
 * canonical form so join gates and re-review share one shape (#2902 / #3013).
 */
function normalizeDispositionArtifact(raw: string, expectedStageN: number, indexText: string | undefined): string {
	try {
		const indexedArtifacts = buildIndexedReviewArtifacts(indexText);
		const doc = parseReviewConflictDocument(raw, {
			expectedStageN,
			indexedArtifacts,
		});
		return serializeReviewConflictDocument(doc);
	} catch (error) {
		throw new RalplanCommandError(
			2,
			`invalid ralplan disposition artifact: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Parse complete path/sha256 rows from a run `index.jsonl` snapshot for provenance. */
function buildIndexedReviewArtifacts(indexText: string | undefined): Map<string, IndexedReviewArtifact> {
	const map = new Map<string, IndexedReviewArtifact>();
	if (indexText === undefined) return map;
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
		if (typeof record.stage !== "string") continue;
		if (typeof record.stage_n !== "number" || !Number.isInteger(record.stage_n)) continue;
		if (typeof record.path !== "string" || typeof record.sha256 !== "string") continue;
		// Last complete row for an identity wins (matches findExistingStageArtifact).
		map.set(reviewArtifactIndexKey(record.stage, record.stage_n), {
			path: record.path,
			sha256: record.sha256,
		});
	}
	return map;
}

async function handleArtifactWrite(
	args: readonly string[],
	cwd: string,
	agentDir?: string,
): Promise<RalplanCommandResult> {
	// #4693: explicit --worktree-root binds every persistence root to the selected
	// canonical worktree; the invocation cwd survives only for --artifact input
	// file resolution. Validation happens here, before any state/artifact write.
	const target = await resolveRalplanTargetRoot(args, cwd);
	const persistCwd = target.root;
	if (target.explicit) await assertExplicitTargetGjcNotSymlinked(persistCwd);
	const resolved = await resolveArtifactArgs(args, persistCwd, cwd, {
		confineArtifactRoot: target.explicit ? cwd : undefined,
	});
	const persistedRoleState = parsePersistedRoleStateArgs(args, resolved.stage);
	const laneVerdict = parseLaneVerdictArgs(args, resolved.stage, resolved.stageN);
	// Fail closed before stage persistence / path writes when cwd drifted to a sibling repo.
	const repositoryBinding = await enforceRalplanRepositoryBinding(persistCwd, resolved.sessionId, {
		exactWorktreeRoot: target.explicit,
	});
	// Artifact file paths (when --artifact points at a file) must stay under the bound
	// worktree in cwd-based mode. Explicit-target mode confines the file to the
	// invoking cwd (including realpath/symlink escape) before the content is read.
	const rawArtifact = flagValue(args, "--artifact");
	if (rawArtifact && !isRestrictedRoleAgentBash()) {
		const candidate = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(cwd, rawArtifact);
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile() && !target.explicit) {
				assertPathUnderRepositoryBinding(repositoryBinding, candidate);
			}
		} catch (error) {
			if (error instanceof RepositoryBindingError) {
				throw new RalplanCommandError(2, `ralplan repository binding rejected: ${error.message}`);
			}
			// Non-file / missing path is inline content; resolveArtifactContent already handled it.
		}
	}

	// Read the ledger once before persistence. The dedupe guard, both gates, and
	// disposition provenance consume this same snapshot so no additional ledger
	// read can slip between gate evaluation and persistence.
	const indexLoad = await loadRalplanIndexForCap(persistCwd, resolved.sessionId, resolved.runId);

	// Disposition stage: fail-closed parse/normalize with authoritative receipts (#2902).
	const normalizedArtifact =
		resolved.stage === "disposition"
			? normalizeDispositionArtifact(resolved.artifact, resolved.stageN, indexLoad.rawText)
			: resolved.artifact;
	const content = normalizedArtifact.endsWith("\n") ? normalizedArtifact : `${normalizedArtifact}\n`;
	const sha256 = createHash("sha256").update(content).digest("hex");

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
		if (resolved.stage === "final") await ensureFinalPendingApproval(persistCwd, resolved, existingArtifact);
		return await buildDeduplicatedResult(resolved, existingArtifact, sha256, persistCwd, repositoryBinding);
	}

	// `persistArtifact` writes the artifact before its ledger row. If a process crashed
	// in that gap, an identical retry repairs the row and remains a normal deduplicated
	// receipt; a differing retry retains the ordinary no-overwrite refusal.
	const onDiskArtifact = await findOnDiskStageArtifact(persistCwd, resolved);
	if (onDiskArtifact) {
		if (onDiskArtifact.sha256 !== sha256) {
			throw new RalplanCommandError(
				2,
				`refusing to overwrite ralplan ${resolved.stage} stage ${resolved.stageN} at ${onDiskArtifact.path}: an artifact with different content already exists (existing sha256=${onDiskArtifact.sha256}, new sha256=${sha256}). Use a new --stage_n to record another pass.`,
			);
		}
		if (resolved.stage === "final") await ensureFinalPendingApproval(persistCwd, resolved, onDiskArtifact);
		const repairedArtifact = await repairMissingStageArtifactLedger(
			persistCwd,
			resolved,
			onDiskArtifact,
			resolved.stage === "final" ? unavailableRalplanFinalAdmission() : undefined,
		);
		let appliedPersistedRoleState: PersistedRoleStateUpdate | undefined;
		if (
			persistedRoleState &&
			(await applyPersistedRoleStateUpdate(persistCwd, resolved.sessionId, persistedRoleState, resolved.runId))
		) {
			appliedPersistedRoleState = persistedRoleState;
		}
		let appliedLaneVerdict: LaneVerdictUpdate | undefined;
		if (laneVerdict && (await applyLaneVerdictUpdate(persistCwd, resolved.sessionId, laneVerdict, resolved.runId))) {
			appliedLaneVerdict = laneVerdict;
		}
		return await buildDeduplicatedResult(
			resolved,
			repairedArtifact,
			sha256,
			persistCwd,
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
		countRalplanOnDiskOpeners(persistCwd, resolved.sessionId, resolved.runId),
		countRalplanOnDiskLaneArtifacts(persistCwd, resolved.sessionId, resolved.runId),
		resolveRalplanMaxIterations(persistCwd, agentDir),
		resolveRalplanMaxReviewPassesPerLane(persistCwd, agentDir),
	]);
	const capDecision = evaluateRalplanIterationCap({
		rows: indexLoad.rows,
		stage: resolved.stage,
		maxIterations: iterationLimit.maxIterations,
		iterationFloor: onDiskOpeners,
	});
	if (!capDecision.allowed) {
		await recordRalplanPlanningStuck(persistCwd, resolved.sessionId, resolved.runId, capDecision.reason);
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
		await recordRalplanPlanningStuck(persistCwd, resolved.sessionId, resolved.runId, laneBudgetDecision.reason);
		return buildLaneBudgetStuckResult({
			json: resolved.json,
			stage: resolved.stage,
			stageN: resolved.stageN,
			runId: resolved.runId,
			decision: laneBudgetDecision,
			source: laneLimit.source,
		});
	}

	let autoHandoff: RalplanAutoHandoffResolution | undefined;
	if (resolved.stage === "final") {
		// Resolve and validate the configured admission before any final artifact or
		// state write. The ledger row below is the durable receipt for deduplicated
		// retries; state is only a current-session projection.
		autoHandoff = await resolveRalplanAutoHandoff(persistCwd, {
			agentDir,
			planningStuck: await readRalplanPlanningStuck(persistCwd, resolved.sessionId, resolved.runId),
		});
	}
	// Keep run-state `current_phase` coherent with the stage being persisted.
	await persistActiveRunId(persistCwd, resolved.sessionId, resolved.runId, resolved.stage);
	const persisted = await persistArtifact(resolved, persistCwd, content, sha256, autoHandoff);
	if (persistedRoleState) {
		await applyPersistedRoleStateUpdate(persistCwd, resolved.sessionId, persistedRoleState);
	}
	if (laneVerdict) {
		await applyLaneVerdictUpdate(persistCwd, resolved.sessionId, laneVerdict);
	}
	if (autoHandoff) {
		await persistRalplanFinalAdmission(persistCwd, resolved.sessionId, resolved.runId, autoHandoff);
	}
	await writeSessionActivityMarker(persistCwd, resolved.sessionId, {
		writer: "ralplan-runtime",
		path: persisted.path,
	});
	await syncRalplanHud({
		cwd: persistCwd,
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
		session_id: resolved.sessionId,
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
	if (autoHandoff) payload.auto_handoff = autoHandoff;

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
function applyRalplanPlanningStuckOverride(
	admission: RalplanAutoHandoffResolution,
	planningStuck: boolean,
): RalplanAutoHandoffResolution {
	return planningStuck ? { ...admission, effectiveTarget: "off", degradationReason: "planning_stuck" } : admission;
}

async function buildDeduplicatedResult(
	resolved: ResolvedArtifactArgs,
	existing: ExistingStageArtifact,
	sha256: string,
	cwd: string,
	repositoryBinding: RepositoryBinding,
	laneVerdict?: LaneVerdictUpdate,
	persistedRoleState?: PersistedRoleStateUpdate,
): Promise<RalplanCommandResult> {
	const payload: Record<string, unknown> = {
		session_id: resolved.sessionId,
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
		const planningStuck = await readRalplanPlanningStuck(cwd, resolved.sessionId, resolved.runId);
		payload.auto_handoff = applyRalplanPlanningStuckOverride(
			existing.autoHandoff ?? unavailableRalplanFinalAdmission(),
			planningStuck,
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
	explicitTarget = false,
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
		? await enforceRalplanRepositoryBinding(cwd, resolved.sessionId, { exactWorktreeRoot: explicitTarget })
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
	// #4693: explicit --worktree-root seeds and binds the run at the selected
	// canonical worktree instead of the ambient invocation cwd.
	const target = await resolveRalplanTargetRoot(args, cwd);
	if (target.explicit) await assertExplicitTargetGjcNotSymlinked(target.root);
	const resolved = resolveConsensusArgs(args, target.root);
	if (!resolved.task) {
		throw new RalplanCommandError(2, 'gjc ralplan requires a task description, e.g. `gjc ralplan "<task>"`.');
	}
	const { statePath, runId, repositoryBinding } = await seedRalplanState(target.root, resolved, target.explicit);
	const mode = resolved.deliberate ? "deliberate" : "short";
	await syncRalplanHud({
		cwd: target.root,
		sessionId: resolved.sessionId,
		stage: "planner",
		runId,
		pendingApproval: false,
		iteration: 1,
		latestSummary: `${mode} run · ${resolved.interactive ? "interactive" : "automated"}`,
	});

	const summary = {
		session_id: resolved.sessionId,
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

export async function runNativeRalplanCommand(
	args: string[],
	cwd = process.cwd(),
	options: { agentDir?: string } = {},
): Promise<RalplanCommandResult> {
	try {
		if (isRalplanDoctorInvocation(args)) return await handleDoctor(args, cwd);
		if (isRalplanArtifactWriteInvocation(args)) return await handleArtifactWrite(args, cwd, options.agentDir);
		return await handleConsensusHandoff(args, cwd);
	} catch (error) {
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
