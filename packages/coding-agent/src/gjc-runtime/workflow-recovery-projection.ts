/**
 * Structured workflow recovery projection for compaction (#4560).
 *
 * Compaction previously preserved only a thin best-effort state projection
 * (active goal objective/status, workflow phase, open todos) plus a generic
 * continuation prompt. Long Ralplan/Ultragoal runs could therefore lose the
 * precise accepted scope/progress/evidence contract, then drift or spin in
 * zero-progress continuation loops after compaction.
 *
 * This module derives a bounded structured projection from the canonical
 * durable state — Ralplan `final`/`index.jsonl` run artifacts and Ultragoal
 * `goals.json` + `ledger.jsonl` — through read-only filesystem access. It
 * never mutates workflow state and degrades safely (undefined) on malformed,
 * stale, or tampered durable state so compaction falls back to the previous
 * thin projection rather than failing.
 */
import * as crypto from "node:crypto";
import { constants as nodeFsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { modeStatePath, sessionPlansDir } from "./session-layout";
import { getUltragoalPaths, readUltragoalLedger, readUltragoalPlan } from "./ultragoal-runtime";

/** Skills whose durable state can produce a structured recovery projection. */
export type WorkflowRecoverySkill = "ralplan" | "ultragoal";

export interface WorkflowRecoveryScopeItem {
	kind: "accepted" | "non_goal";
	text: string;
}

export interface WorkflowRecoveryProjection {
	skill: WorkflowRecoverySkill;
	/** Canonical durable state that produced this projection. */
	source: "ralplan-final" | "ralplan-run" | "ultragoal-plan";
	/** Bounded accepted objective for the current work contract. */
	objective: string;
	/** Bounded accepted scope + explicit non-goals (scope reload, not expansion). */
	scope: WorkflowRecoveryScopeItem[];
	/** Bounded acceptance criteria / verification obligations. */
	acceptanceCriteria: string[];
	/** Unresolved decisions carried from the durable contract, bounded. */
	unresolved: string[];
	/** Durable identity + integrity digest of the source state. */
	provenance: {
		planPath?: string;
		runId?: string;
		stage?: string;
		sha256?: string;
	};
	/** Current goal + measurable progress counters from canonical state. */
	currentGoal?: {
		goalId: string;
		status: string;
		objective: string;
	};
	progress: {
		totalGoals?: number;
		completedGoals?: number;
		outstandingGoals?: number;
		/** Latest boundary review generation recorded in the ledger. */
		latestReviewGeneration?: number;
		/** Frozen source hash of the latest joined review cohort, if any. */
		latestCohortSourceHash?: string;
		/** Ledger event id of the newest event backing this projection. */
		latestLedgerEventId?: string;
	};
	/** Exact next bounded action class for resumption. */
	nextAction: {
		actionClass:
			| "continue-current-goal"
			| "start-next-goal"
			| "resolve-review-blockers"
			| "run-boundary-cohort"
			| "run-plan-review"
			| "revise-plan"
			| "reconcile-intent"
			| "final-aggregate-checkpoint"
			| "awaiting-approval"
			| "unknown";
		goalId?: string;
		detail?: string;
	};
	/** #4560: measurable-progress basis for bounding zero-progress cycles. */
	zeroProgress: {
		fingerprint: string;
		unchangedObservations: number;
		stalled: boolean;
	};
}
/** #4560: compaction-observation memory for zero-progress bounding. */
export interface WorkflowRecoveryZeroProgressMemory {
	/** Last observed progress fingerprint per skill. */
	lastFingerprint?: string;
	/** Consecutive compaction observations with an unchanged fingerprint. */
	unchangedObservations: number;
}

/** #4560: bound repeated zero-progress continuation cycles (#4560). */
export const ZERO_PROGRESS_STALL_THRESHOLD = 2;

export function trackWorkflowRecoveryZeroProgress(
	memory: WorkflowRecoveryZeroProgressMemory | undefined,
	projection: WorkflowRecoveryProjection,
): WorkflowRecoveryZeroProgressMemory {
	const fingerprint = hashWorkflowRecoveryProjection(projection);
	if (!memory) return { lastFingerprint: fingerprint, unchangedObservations: 0 };
	const unchanged = memory.lastFingerprint === fingerprint ? memory.unchangedObservations + 1 : 0;
	return { lastFingerprint: fingerprint, unchangedObservations: unchanged };
}

export function isWorkflowRecoveryStalled(memory: WorkflowRecoveryZeroProgressMemory | undefined): boolean {
	return (memory?.unchangedObservations ?? 0) >= ZERO_PROGRESS_STALL_THRESHOLD;
}

const MAX_OBJECTIVE_CHARS = 600;
const MAX_ITEM_CHARS = 240;
const MAX_SCOPE_ITEMS = 12;
const MAX_CRITERIA_ITEMS = 12;
const MAX_UNRESOLVED_ITEMS = 8;

function boundText(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

/**
 * Read an artifact exactly once and derive both its text and its digest from
 * the same bytes. Reading for projection and reopening for hashing lets a
 * concurrent replacement produce a digest over benign bytes while different
 * bytes reach the continuation prompt, so the two must never be split.
 * The handle is opened with `O_NOFOLLOW` and its identity is verified to be a
 * regular file before any bytes are trusted.
 */
async function readArtifactWithDigest(filePath: string): Promise<{ text: string; sha256: string } | undefined> {
	if (process.platform === "win32") return undefined;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, nodeFsConstants.O_RDONLY | nodeFsConstants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile()) return undefined;
		const buffer = await handle.readFile();
		return {
			text: buffer.toString("utf8"),
			sha256: `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`,
		};
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

interface ParsedHeadingSection {
	title: string;
	lines: string[];
}

/** Split a markdown artifact into bounded `## `-level sections. */
function parseMarkdownSections(markdown: string): ParsedHeadingSection[] {
	const sections: ParsedHeadingSection[] = [];
	let current: ParsedHeadingSection | undefined;
	for (const rawLine of markdown.split(/\r?\n/)) {
		const heading = /^##\s+(.*)$/.exec(rawLine);
		if (heading) {
			current = { title: heading[1].trim(), lines: [] };
			sections.push(current);
		} else if (current) {
			current.lines.push(rawLine);
		}
	}
	return sections.slice(0, 24);
}

/** Extract bounded list items from a section body (normalizes nested bullets). */
function sectionListItems(section: ParsedHeadingSection | undefined, maxItems: number): string[] {
	if (!section) return [];
	const items: string[] = [];
	for (const line of section.lines) {
		const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
		const text = boundText(bullet ? bullet[1] : line.trim().length > 0 ? line : undefined, MAX_ITEM_CHARS);
		if (text) items.push(text);
		if (items.length >= maxItems) break;
	}
	return items;
}

function findSection(sections: ParsedHeadingSection[], needles: readonly string[]): ParsedHeadingSection | undefined {
	const normalized = needles.map(needle => needle.toLowerCase());
	return sections.find(section => normalized.some(needle => section.title.toLowerCase().includes(needle)));
}

function findSectionExact(
	sections: ParsedHeadingSection[],
	titles: readonly string[],
): ParsedHeadingSection | undefined {
	const normalized = new Set(titles.map(title => title.toLowerCase()));
	return sections.find(section => normalized.has(section.title.toLowerCase()));
}

/**
 * Verify that every component of `child` below `root` is a real directory and
 * not a symlink. Checking only the leaf is insufficient: a symlinked ancestor
 * can relocate the effective root outside the expected tree while the leaf's
 * relative-realpath check still succeeds.
 */
async function isSymlinkFreeDescent(root: string, child: string): Promise<boolean> {
	const relative = path.relative(root, child);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	let current = root;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) return false;
	}
	return true;
}

async function resolveRalplanArtifactPath(
	runDir: string,
	recordedPath: string,
	plansRoot: string,
): Promise<string | undefined> {
	const candidate = path.isAbsolute(recordedPath) ? recordedPath : path.resolve(runDir, recordedPath);
	try {
		// Anchor beneath a canonical, symlink-free session plans root so that no
		// ancestor of the run directory can redirect recovery out of the tree.
		const plansReal = await fs.realpath(plansRoot);
		if (!(await isSymlinkFreeDescent(plansReal, path.resolve(runDir)))) return undefined;
		const runStat = await fs.lstat(runDir);
		if (!runStat.isDirectory() || runStat.isSymbolicLink()) return undefined;
		if (!(await isSymlinkFreeDescent(path.resolve(runDir), candidate))) return undefined;
		const [runReal, artifactReal] = await Promise.all([fs.realpath(runDir), fs.realpath(candidate)]);
		const relative = path.relative(runReal, artifactReal);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
		const stat = await fs.lstat(artifactReal);
		return stat.isFile() ? artifactReal : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Extract the bounded objective from a Ralplan final plan artifact. The
 * objective is the first non-empty prose line of the document (before the
 * first `##` heading), which is the durable plan statement of intent.
 */
function objectiveFromMarkdown(markdown: string): string | undefined {
	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("#")) continue;
		if (line.length === 0) continue;
		return boundText(line, MAX_OBJECTIVE_CHARS);
	}
	return undefined;
}

export interface RalplanFinalProjectionInput {
	cwd: string;
	sessionId: string;
	runId: string;
}

interface RalplanProjectionInput extends RalplanFinalProjectionInput {
	lastReviewVerdict?: string;
	lastReviewVerdictLane?: string;
}

interface RalplanProjectionRow {
	stage?: unknown;
	stage_n?: unknown;
	path?: unknown;
	sha256?: unknown;
	event?: unknown;
	planning_stuck?: unknown;
}

/**
 * Build a recovery projection from the newest complete Ralplan `final` stage
 * row of a run. Returns undefined when no parseable final artifact exists —
 * compaction then degrades to the thin projection instead of guessing.
 */
async function projectRalplanRunInternal(
	input: RalplanProjectionInput,
	finalOnly: boolean,
): Promise<WorkflowRecoveryProjection | undefined> {
	const plansRoot = sessionPlansDir(input.cwd, input.sessionId);
	const runDir = path.join(plansRoot, "ralplan", input.runId);
	const rows: RalplanProjectionRow[] = [];
	try {
		const text = await fs.readFile(path.join(runDir, "index.jsonl"), "utf8");
		for (const line of text.split(/\r?\n/).map(value => value.trim())) {
			if (line.length === 0) continue;
			const parsed = JSON.parse(line) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
			rows.push(parsed as RalplanProjectionRow);
		}
	} catch {
		return undefined;
	}
	const finalRow = [...rows].reverse().find(row => row.stage === "final");
	const planRow = [...rows].reverse().find(row => row.stage === "revision" || row.stage === "planner");
	const artifactRow = finalOnly ? finalRow : (finalRow ?? planRow);
	if (
		typeof artifactRow?.path !== "string" ||
		artifactRow.path.trim().length === 0 ||
		typeof artifactRow.sha256 !== "string"
	)
		return undefined;
	const artifactPath = await resolveRalplanArtifactPath(runDir, artifactRow.path, plansRoot);
	if (!artifactPath) return undefined;
	const artifact = await readArtifactWithDigest(artifactPath);
	if (!artifact) return undefined;
	const markdown = artifact.text;
	const objective = objectiveFromMarkdown(markdown);
	if (!objective) return undefined;
	const sections = parseMarkdownSections(markdown);
	const primaryAcceptance = sectionListItems(
		findSection(sections, ["acceptance criteria", "verification", "test plan"]),
		MAX_CRITERIA_ITEMS,
	);
	const acceptance =
		primaryAcceptance.length > 0
			? primaryAcceptance
			: sectionListItems(findSectionExact(sections, ["acceptance"]), MAX_CRITERIA_ITEMS);
	const nonGoals = sectionListItems(
		findSectionExact(sections, ["non-goals", "non goals", "non-goal", "out of scope"]),
		MAX_SCOPE_ITEMS,
	);
	const unresolved = sectionListItems(
		findSection(sections, ["intent reconciliation", "open confirmation", "unresolved"]),
		MAX_UNRESOLVED_ITEMS,
	);
	const scope: WorkflowRecoveryScopeItem[] = sectionListItems(
		findSectionExact(sections, ["scope", "accepted scope"]),
		MAX_SCOPE_ITEMS,
	).map(text => ({ kind: "accepted" as const, text }));
	for (const text of nonGoals) scope.push({ kind: "non_goal" as const, text });
	const sha256 = artifact.sha256;
	const recorded = artifactRow.sha256.startsWith("sha256:") ? artifactRow.sha256 : `sha256:${artifactRow.sha256}`;
	if (!/^sha256:[0-9a-f]{64}$/.test(recorded) || recorded !== sha256) return undefined;
	const stage = typeof artifactRow.stage === "string" ? artifactRow.stage : "unknown";
	const latestStage = typeof rows.at(-1)?.stage === "string" ? rows.at(-1)?.stage : undefined;
	const planningStuck = rows.some(row => row.event === "planning_stuck" && row.planning_stuck === true);
	let nextAction: WorkflowRecoveryProjection["nextAction"];
	if (planningStuck) {
		nextAction = { actionClass: "awaiting-approval", detail: "planning-stuck" };
	} else if (stage === "final") {
		nextAction = { actionClass: "awaiting-approval" };
	} else if (latestStage === "critic") {
		nextAction =
			input.lastReviewVerdictLane === "critic" && input.lastReviewVerdict === "OKAY"
				? { actionClass: "reconcile-intent" }
				: { actionClass: "revise-plan" };
	} else if (latestStage === "planner" || latestStage === "revision") {
		// The manifest requires planner -> intent before Architect/Critic consensus.
		// Resuming straight to review here would spend the expensive consensus lanes
		// on a draft whose material intent was never reconciled.
		nextAction = { actionClass: "reconcile-intent", detail: `${latestStage}-without-intent-receipt` };
	} else {
		nextAction = { actionClass: "run-plan-review" };
	}
	const projection: Omit<WorkflowRecoveryProjection, "zeroProgress"> = {
		skill: "ralplan",
		source: stage === "final" ? "ralplan-final" : "ralplan-run",
		objective,
		scope,
		acceptanceCriteria: acceptance,
		unresolved,
		provenance: { planPath: artifactPath, runId: input.runId, stage, sha256 },
		progress: {},
		nextAction,
	};
	return withZeroProgress(projection);
}

export async function projectRalplanFinalRun(
	input: RalplanFinalProjectionInput,
): Promise<WorkflowRecoveryProjection | undefined> {
	return await projectRalplanRunInternal(input, true);
}

export async function projectRalplanRun(
	input: RalplanProjectionInput,
): Promise<WorkflowRecoveryProjection | undefined> {
	return await projectRalplanRunInternal(input, false);
}

function isSafeRunId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value === value.trim() &&
		path.basename(value) === value &&
		value !== "." &&
		value !== ".."
	);
}

/**
 * Project the active Ralplan run recorded in durable mode state. When legacy
 * state has no run id, fall back to complete runs ordered by index freshness,
 * skipping unfinished or malformed candidates instead of letting them shadow
 * the newest usable final contract.
 */
export async function projectLatestRalplanRun(input: {
	cwd: string;
	sessionId: string;
}): Promise<WorkflowRecoveryProjection | undefined> {
	const root = path.join(sessionPlansDir(input.cwd, input.sessionId), "ralplan");
	let stateText: string | undefined;
	try {
		stateText = await fs.readFile(modeStatePath(input.cwd, input.sessionId, "ralplan"), "utf8");
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			return undefined;
		}
	}
	if (stateText !== undefined) {
		let state: {
			run_id?: unknown;
			last_review_verdict?: unknown;
			last_review_verdict_lane?: unknown;
		};
		try {
			state = JSON.parse(stateText) as typeof state;
		} catch {
			return undefined;
		}
		if (state.run_id !== undefined && !isSafeRunId(state.run_id)) return undefined;
		if (isSafeRunId(state.run_id)) {
			return await projectRalplanRun({
				...input,
				runId: state.run_id,
				lastReviewVerdict: typeof state.last_review_verdict === "string" ? state.last_review_verdict : undefined,
				lastReviewVerdictLane:
					typeof state.last_review_verdict_lane === "string" ? state.last_review_verdict_lane : undefined,
			});
		}
	}
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const candidates = await Promise.all(
			entries
				.filter(entry => entry.isDirectory() && isSafeRunId(entry.name))
				.map(async entry => ({
					runId: entry.name,
					mtimeMs:
						(await fs.stat(path.join(root, entry.name, "index.jsonl")).catch(() => undefined))?.mtimeMs ?? -1,
				})),
		);
		candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.runId.localeCompare(right.runId));
		for (const candidate of candidates) {
			const projection = await projectRalplanRun({ ...input, runId: candidate.runId });
			if (projection) return projection;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
/**
 * Build a recovery projection from Ultragoal canonical durable state. The
 * accepted contract is the aggregate objective plus the goal list; progress
 * and next action are derived from `goals.json` status plus the newest ledger
 * receipts, never from conversation memory.
 */
export async function projectUltragoalRun(input: {
	cwd: string;
	sessionId: string;
}): Promise<WorkflowRecoveryProjection | undefined> {
	const plan = await readUltragoalPlan(input.cwd, input.sessionId).catch(() => null);
	if (!plan?.goals?.length) return undefined;
	const ledger = await readUltragoalLedger(input.cwd, input.sessionId).catch(() => null);
	if (!ledger) return undefined;
	const paths = getUltragoalPaths(input.cwd, input.sessionId);
	const schedulable = plan.goals.filter(goal => goal.status !== "complete" && goal.status !== "superseded");
	const currentGoal = plan.goals.find(goal => goal.status === "active" || goal.status === "failed") ?? schedulable[0];
	const reviewBlocked = plan.goals.find(goal => goal.status === "review_blocked");
	const lastCheckpoint = [...ledger]
		.reverse()
		.find(event => event.event === "goal_checkpointed" && event.status === "complete");
	// Newest joined cohort generation/sourceHash across all complete checkpoints.
	let latestReviewGeneration: number | undefined;
	let latestCohortSourceHash: string | undefined;
	for (const event of ledger) {
		if (event.event !== "goal_checkpointed" || event.status !== "complete") continue;
		const cohort = readCohortFromLedgerEvent(event);
		if (!cohort) continue;
		if (latestReviewGeneration === undefined || cohort.reviewGeneration >= latestReviewGeneration) {
			latestReviewGeneration = cohort.reviewGeneration;
			latestCohortSourceHash = cohort.sourceHash;
		}
	}
	const outstanding = schedulable.length;
	const scope: WorkflowRecoveryScopeItem[] = [
		{
			kind: "accepted",
			text: boundText(plan.gjcObjective, MAX_OBJECTIVE_CHARS) ?? "Ultragoal aggregate run",
		},
	];
	for (const goal of plan.goals.slice(0, MAX_SCOPE_ITEMS - 1)) {
		const text = boundText(goal.title || goal.objective, MAX_ITEM_CHARS);
		if (text) scope.push({ kind: "accepted", text: `goal ${goal.id}: ${text}` });
	}
	const acceptance: string[] = [];
	for (const goal of plan.goals.slice(0, MAX_CRITERIA_ITEMS)) {
		// Acceptance = per-goal completion evidence currently recorded durably.
		const evidence = boundText(goal.evidence, MAX_ITEM_CHARS);
		if (goal.status === "complete" && evidence) acceptance.push(`${goal.id} complete: ${evidence}`);
	}
	let nextAction: WorkflowRecoveryProjection["nextAction"] = { actionClass: "unknown" };
	if (reviewBlocked) {
		nextAction = {
			actionClass: "resolve-review-blockers",
			goalId: reviewBlocked.id,
			detail: boundText(reviewBlocked.objective, MAX_ITEM_CHARS),
		};
	} else if (outstanding === 0) {
		nextAction = { actionClass: "final-aggregate-checkpoint" };
	} else if (currentGoal) {
		nextAction = {
			actionClass: currentGoal.status === "active" ? "continue-current-goal" : "start-next-goal",
			goalId: currentGoal.id,
			detail: boundText(currentGoal.objective, MAX_ITEM_CHARS),
		};
	}
	const projection: Omit<WorkflowRecoveryProjection, "zeroProgress"> = {
		skill: "ultragoal",
		source: "ultragoal-plan",
		objective: boundText(plan.gjcObjective, MAX_OBJECTIVE_CHARS) ?? "Ultragoal aggregate run",
		scope,
		acceptanceCriteria: acceptance,
		unresolved: reviewBlocked
			? [`review blockers open on ${reviewBlocked.id}`]
			: schedulable
					.filter(goal => goal.status === "blocked" || goal.status === "failed")
					.slice(0, MAX_UNRESOLVED_ITEMS)
					.map(goal =>
						`${goal.id} ${goal.status}: ${boundText(goal.evidence ?? "", MAX_ITEM_CHARS) ?? ""}`.trim(),
					),
		provenance: { planPath: paths.goalsPath },
		currentGoal: currentGoal
			? {
					goalId: currentGoal.id,
					status: currentGoal.status,
					objective: boundText(currentGoal.objective, MAX_OBJECTIVE_CHARS) ?? "",
				}
			: undefined,
		progress: {
			totalGoals: plan.goals.length,
			completedGoals: plan.goals.filter(goal => goal.status === "complete").length,
			outstandingGoals: outstanding,
			latestReviewGeneration,
			latestCohortSourceHash,
			latestLedgerEventId: lastCheckpoint?.eventId ?? [...ledger].at(-1)?.eventId,
		},
		nextAction,
	};
	return withZeroProgress(projection);
}

/** Attach a fresh zero-progress fingerprint to a built projection. */
function withZeroProgress(projection: Omit<WorkflowRecoveryProjection, "zeroProgress">): WorkflowRecoveryProjection {
	const fingerprint = hashWorkflowRecoveryProjection(projection as WorkflowRecoveryProjection);
	return {
		...projection,
		zeroProgress: { fingerprint, unchangedObservations: 0, stalled: false },
	};
}

function readCohortFromLedgerEvent(
	event: UltragoalLedgerLike,
): { reviewGeneration: number; sourceHash: string } | undefined {
	const gate = event.qualityGateJson;
	if (!gate || typeof gate !== "object" || Array.isArray(gate)) return undefined;
	const iteration = (gate as { iteration?: unknown }).iteration;
	if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) return undefined;
	const cohort = (iteration as { reviewCohort?: unknown }).reviewCohort;
	if (!cohort || typeof cohort !== "object" || Array.isArray(cohort)) return undefined;
	const reviewGeneration = (cohort as { reviewGeneration?: unknown }).reviewGeneration;
	const sourceHash = (cohort as { sourceHash?: unknown }).sourceHash;
	if (typeof reviewGeneration !== "number" || typeof sourceHash !== "string") return undefined;
	return { reviewGeneration, sourceHash };
}

interface UltragoalLedgerLike {
	event?: string;
	status?: string;
	eventId?: string;
	qualityGateJson?: unknown;
}

/** Stable digest over the projection's contract-relevant fields. */
export function hashWorkflowRecoveryProjection(projection: WorkflowRecoveryProjection): string {
	const basis = {
		skill: projection.skill,
		source: projection.source,
		objective: projection.objective,
		scope: projection.scope,
		acceptanceCriteria: projection.acceptanceCriteria,
		unresolved: projection.unresolved,
		provenance: projection.provenance,
		currentGoal: projection.currentGoal,
		progressBasis: {
			totalGoals: projection.progress.totalGoals,
			completedGoals: projection.progress.completedGoals,
			outstandingGoals: projection.progress.outstandingGoals,
			latestCohortSourceHash: projection.progress.latestCohortSourceHash,
		},
		nextAction: projection.nextAction,
	};
	return `sha256:${crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex")}`;
}
