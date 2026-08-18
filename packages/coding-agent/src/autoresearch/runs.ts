/**
 * Durable autoresearch run storage: session-scoped JSONL run records plus
 * baseline/best-metric math, ported from the deleted extension's
 * `storage.ts` + `state.ts` without SQLite.
 *
 * Everything lives under the session autoresearch root
 * (`<cwd>/.gjc/_session-{id}/autoresearch/`): `runs.jsonl` holds one JSON
 * object per run and `experiment.json` holds the metric/session configuration.
 * The legacy global store (a per-project SQLite DB keyed outside the session)
 * is intentionally dead — no code path here resolves or writes it.
 *
 * Flagged runs MUST be excluded from baseline and best-metric computation;
 * metric direction (lower-is-better vs higher-is-better) is respected.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { sessionAutoresearchDir } from "../gjc-runtime/session-layout";
import { resolveGjcSessionForWrite } from "../gjc-runtime/session-resolution";
import {
	appendJsonl,
	type StateWriterOptions,
	withWorkflowStateLock,
	writeTextAtomic,
} from "../gjc-runtime/state-writer";
import { dedupeStrings, inferMetricUnitFromName, isBetter, normalizePathSpec } from "./harness";
import type { ASIData, ExperimentStatus, MetricDef, MetricDirection, NumericMetricMap } from "./types";

export type { ASIData, ExperimentStatus, MetricDirection, NumericMetricMap };

export interface AutoresearchExperimentConfig {
	name: string;
	goal: string | null;
	primaryMetric: string;
	metricUnit: string;
	direction: MetricDirection;
	preferredCommand: string | null;
	branch: string | null;
	baselineCommit: string | null;
	currentSegment: number;
	maxIterations: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	secondaryMetrics: string[];
	notes: string;
	createdAt: number;
	closedAt: number | null;
}

export interface AutoresearchRunRecord {
	runId: string;
	runNumber: number;
	segment: number;
	command: string;
	startedAt: number;
	completedAt: number | null;
	durationMs: number | null;
	exitCode: number | null;
	timedOut: boolean;
	status: ExperimentStatus | null;
	description: string | null;
	metric: number | null;
	metrics: NumericMetricMap;
	asi: ASIData | null;
	commitHash: string | null;
	confidence: number | null;
	preRunDirtyPaths: string[];
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
	loggedAt: number | null;
	abandonedAt: number | null;
}

export interface AutoresearchRunsPaths {
	dir: string;
	runsPath: string;
	configPath: string;
}

export function autoresearchRunsPaths(cwd: string, sessionId?: string | null): AutoresearchRunsPaths {
	const resolvedSessionId =
		sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
	const dir = sessionAutoresearchDir(cwd, resolvedSessionId);
	return {
		dir,
		runsPath: path.join(dir, "runs.jsonl"),
		configPath: path.join(dir, "experiment.json"),
	};
}

function auditFor(
	cwd: string,
	sessionId: string,
	verb: string,
	category: "state" | "ledger" = "state",
): StateWriterOptions {
	return {
		cwd,
		audit: {
			category,
			verb,
			owner: "gjc-runtime",
			skill: "autoresearch",
			sessionId,
		},
	};
}

const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeMetrics(value: unknown): NumericMetricMap {
	if (typeof value !== "object" || value === null) return {};
	const out: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) out[key] = entryValue;
	}
	return out;
}

function normalizeRunRecord(value: unknown): AutoresearchRunRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.runId !== "string" || record.runId === "") return null;
	const status = record.status as AutoresearchRunRecord["status"];
	if (
		status !== null &&
		status !== undefined &&
		status !== "keep" &&
		status !== "discard" &&
		status !== "crash" &&
		status !== "checks_failed"
	) {
		return null;
	}
	return {
		runId: record.runId,
		runNumber: typeof record.runNumber === "number" ? record.runNumber : 0,
		segment: typeof record.segment === "number" ? record.segment : 0,
		command: typeof record.command === "string" ? record.command : "",
		startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
		completedAt: typeof record.completedAt === "number" ? record.completedAt : null,
		durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
		exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
		timedOut: record.timedOut === true,
		status: status ?? null,
		description: typeof record.description === "string" ? record.description : null,
		metric: typeof record.metric === "number" && Number.isFinite(record.metric) ? record.metric : null,
		metrics: sanitizeMetrics(record.metrics),
		asi: typeof record.asi === "object" && record.asi !== null ? (record.asi as ASIData) : null,
		commitHash: typeof record.commitHash === "string" ? record.commitHash : null,
		confidence:
			typeof record.confidence === "number" && Number.isFinite(record.confidence) ? record.confidence : null,
		preRunDirtyPaths: toStringArray(record.preRunDirtyPaths),
		modifiedPaths: toStringArray(record.modifiedPaths),
		scopeDeviations: toStringArray(record.scopeDeviations),
		justification: typeof record.justification === "string" ? record.justification : null,
		flagged: record.flagged === true,
		flaggedReason: typeof record.flaggedReason === "string" ? record.flaggedReason : null,
		loggedAt: typeof record.loggedAt === "number" ? record.loggedAt : null,
		abandonedAt: typeof record.abandonedAt === "number" ? record.abandonedAt : null,
	};
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

export function createAutoresearchExperimentConfig(input: {
	name: string;
	goal?: string | null;
	primaryMetric: string;
	metricUnit?: string;
	direction?: MetricDirection;
	preferredCommand?: string | null;
	branch?: string | null;
	baselineCommit?: string | null;
	maxIterations?: number | null;
	scopePaths?: string[];
	offLimits?: string[];
	constraints?: string[];
	secondaryMetrics?: string[];
	notes?: string;
	createdAt?: number;
}): AutoresearchExperimentConfig {
	return {
		name: input.name,
		goal: input.goal ?? null,
		primaryMetric: input.primaryMetric,
		metricUnit: input.metricUnit ?? "",
		direction: input.direction ?? "lower",
		preferredCommand: input.preferredCommand ?? null,
		branch: input.branch ?? null,
		baselineCommit: input.baselineCommit ?? null,
		currentSegment: 0,
		maxIterations: input.maxIterations ?? null,
		scopePaths: dedupeStrings((input.scopePaths ?? []).map(normalizePathSpec)),
		offLimits: dedupeStrings((input.offLimits ?? []).map(normalizePathSpec)),
		constraints: dedupeStrings(input.constraints ?? []),
		secondaryMetrics: dedupeStrings(input.secondaryMetrics ?? []),
		notes: input.notes ?? "",
		createdAt: input.createdAt ?? Date.now(),
		closedAt: null,
	};
}

function normalizeExperimentConfig(value: unknown): AutoresearchExperimentConfig | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name === "") return null;
	const direction: MetricDirection = record.direction === "higher" ? "higher" : "lower";
	return {
		name: record.name,
		goal: typeof record.goal === "string" ? record.goal : null,
		primaryMetric: typeof record.primaryMetric === "string" ? record.primaryMetric : "metric",
		metricUnit: typeof record.metricUnit === "string" ? record.metricUnit : "",
		direction,
		preferredCommand: typeof record.preferredCommand === "string" ? record.preferredCommand : null,
		branch: typeof record.branch === "string" ? record.branch : null,
		baselineCommit: typeof record.baselineCommit === "string" ? record.baselineCommit : null,
		currentSegment: typeof record.currentSegment === "number" ? record.currentSegment : 0,
		maxIterations: typeof record.maxIterations === "number" ? record.maxIterations : null,
		scopePaths: toStringArray(record.scopePaths),
		offLimits: toStringArray(record.offLimits),
		constraints: toStringArray(record.constraints),
		secondaryMetrics: toStringArray(record.secondaryMetrics),
		notes: typeof record.notes === "string" ? record.notes : "",
		createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
		closedAt: typeof record.closedAt === "number" ? record.closedAt : null,
	};
}

/**
 * Session-scoped JSONL run store. Reads are served from a cached in-memory
 * snapshot; every mutation routes through the sanctioned `.gjc/**` state-writer
 * primitives (append for new runs, locked rewrite for updates).
 */
export class AutoresearchRunsStore {
	readonly #paths: AutoresearchRunsPaths;
	readonly #cwd: string;
	readonly #sessionId: string;
	#config: AutoresearchExperimentConfig | null;
	#runs: AutoresearchRunRecord[];

	private constructor(input: {
		paths: AutoresearchRunsPaths;
		cwd: string;
		sessionId: string;
		config: AutoresearchExperimentConfig | null;
		runs: AutoresearchRunRecord[];
	}) {
		this.#paths = input.paths;
		this.#cwd = input.cwd;
		this.#sessionId = input.sessionId;
		this.#config = input.config;
		this.#runs = input.runs;
	}

	static async open(cwd: string, sessionId?: string | null): Promise<AutoresearchRunsStore> {
		const resolvedSessionId =
			sessionId?.trim() || resolveGjcSessionForWrite(cwd, { envSessionId: process.env.GJC_SESSION_ID }).gjcSessionId;
		const paths = autoresearchRunsPaths(cwd, resolvedSessionId);
		const config = await readExperimentConfig(paths.configPath);
		const runs = await readRunRecords(paths.runsPath);
		return new AutoresearchRunsStore({
			paths,
			cwd,
			sessionId: resolvedSessionId,
			config,
			runs,
		});
	}

	get paths(): AutoresearchRunsPaths {
		return this.#paths;
	}

	get config(): AutoresearchExperimentConfig | null {
		return this.#config;
	}

	get runs(): AutoresearchRunRecord[] {
		return [...this.#runs];
	}

	/** Persist the experiment configuration (first write creates the file). */
	async saveConfig(config: AutoresearchExperimentConfig): Promise<void> {
		await writeTextAtomic(
			this.#paths.configPath,
			`${JSON.stringify(config, null, 2)}\n`,
			auditFor(this.#cwd, this.#sessionId, "write"),
		);
		this.#config = config;
		this.#config = config;
	}

	/** Seed the in-memory config without persisting (mission-derived defaults). */
	setInMemoryConfig(config: AutoresearchExperimentConfig): void {
		this.#config = config;
	}

	/** Start a run: append its record line and return the created record. */
	async startRun(input: {
		segment?: number;
		command: string;
		preRunDirtyPaths?: string[];
		startedAt?: number;
	}): Promise<AutoresearchRunRecord> {
		const runNumber = this.#runs.reduce((max, run) => Math.max(max, run.runNumber), 0) + 1;
		const record: AutoresearchRunRecord = {
			runId: cryptoRandomId(),
			runNumber,
			segment: input.segment ?? this.#config?.currentSegment ?? 0,
			command: input.command,
			startedAt: input.startedAt ?? Date.now(),
			completedAt: null,
			durationMs: null,
			exitCode: null,
			timedOut: false,
			status: null,
			description: null,
			metric: null,
			metrics: {},
			asi: null,
			commitHash: null,
			confidence: null,
			preRunDirtyPaths: [...(input.preRunDirtyPaths ?? [])],
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			flagged: false,
			flaggedReason: null,
			loggedAt: null,
			abandonedAt: null,
		};
		await appendJsonl(this.#paths.runsPath, record, auditFor(this.#cwd, this.#sessionId, "run_started", "ledger"));
		this.#runs.push(record);
		return { ...record };
	}

	/** Mark a completed run (exit code, duration, parsed metrics/ASI). */
	async completeRun(runId: string, patch: Partial<AutoresearchRunRecord>): Promise<AutoresearchRunRecord> {
		return this.#updateRun(runId, current => ({
			...current,
			...patch,
			completedAt: patch.completedAt ?? Date.now(),
		}));
	}

	/** Log a run: final status, description, metric, ASI, paths, confidence. */
	async logRun(runId: string, patch: Partial<AutoresearchRunRecord>): Promise<AutoresearchRunRecord> {
		return this.#updateRun(runId, current => ({
			...current,
			...patch,
			status: patch.status ?? null,
			loggedAt: patch.loggedAt ?? Date.now(),
		}));
	}

	/** Flag a run as suspect; flagged runs are excluded from baseline/best math. */
	async flagRun(runId: string, reason: string): Promise<AutoresearchRunRecord> {
		return this.#updateRun(runId, current => ({
			...current,
			flagged: true,
			flaggedReason: reason,
		}));
	}

	async updateRunConfidence(runId: string, confidence: number | null): Promise<AutoresearchRunRecord> {
		return this.#updateRun(runId, current => ({ ...current, confidence }));
	}

	/** Abandon every pending run; returns how many were abandoned. */
	async abandonPendingRuns(): Promise<number> {
		const pending = this.#runs.filter(run => run.status === null && run.abandonedAt === null);
		if (pending.length === 0) return 0;
		await this.#rewrite(runs => {
			for (const run of runs) {
				if (run.status === null && run.abandonedAt === null) {
					run.abandonedAt = Date.now();
				}
			}
		});
		return pending.length;
	}

	/** Most recent pending (started, unlogged, unabandoned) run, or null. */
	getPendingRun(): AutoresearchRunRecord | null {
		for (let index = this.#runs.length - 1; index >= 0; index -= 1) {
			const run = this.#runs[index];
			if (run.status === null && run.abandonedAt === null) return { ...run };
		}
		return null;
	}

	listRuns(): AutoresearchRunRecord[] {
		return this.#runs.map(run => ({ ...run }));
	}

	listLoggedRuns(): AutoresearchRunRecord[] {
		return this.#runs.filter(run => run.status !== null).map(run => ({ ...run }));
	}

	async #updateRun(
		runId: string,
		mutate: (current: AutoresearchRunRecord) => AutoresearchRunRecord,
	): Promise<AutoresearchRunRecord> {
		let updated: AutoresearchRunRecord | null = null;
		await this.#rewrite(runs => {
			for (const run of runs) {
				if (run.runId === runId) {
					const next = mutate(run);
					Object.assign(run, next);
					updated = { ...next };
					break;
				}
			}
		});
		if (updated === null) {
			throw new Error(`Autoresearch run ${runId} not found`);
		}
		return updated;
	}

	/** Locked read-modify-write of runs.jsonl; refreshes the in-memory snapshot. */
	async #rewrite(mutate: (runs: AutoresearchRunRecord[]) => void): Promise<void> {
		await withWorkflowStateLock(
			this.#paths.runsPath,
			async () => {
				const runs = await readRunRecords(this.#paths.runsPath);
				mutate(runs);
				const text = runs.map(run => JSON.stringify(run)).join("\n");
				await writeTextAtomic(
					this.#paths.runsPath,
					text.length > 0 ? `${text}\n` : "",
					auditFor(this.#cwd, this.#sessionId, "run_updated", "ledger"),
				);
				this.#runs = runs.map(run => ({ ...run }));
			},
			{ cwd: this.#cwd },
		);
	}
}

function cryptoRandomId(): string {
	return crypto.randomUUID();
}

async function readRunRecords(runsPath: string): Promise<AutoresearchRunRecord[]> {
	const records: AutoresearchRunRecord[] = [];
	try {
		const raw = await Bun.file(runsPath).text();
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const record = normalizeRunRecord(JSON.parse(trimmed) as unknown);
			if (record) records.push(record);
		}
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return records;
}

async function readExperimentConfig(configPath: string): Promise<AutoresearchExperimentConfig | null> {
	try {
		return normalizeExperimentConfig(await Bun.file(configPath).json());
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

// ---------------------------------------------------------------------------
// Baseline / best-metric math (ported from the extension's state.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape the math operates on; both persisted run records
 * and rebuilt experiment results satisfy it.
 */
export interface BaselineCandidate {
	segment: number;
	status: ExperimentStatus | null;
	metric: number | null;
	metrics: NumericMetricMap;
	flagged: boolean;
	runNumber: number;
}

export function currentResults(results: readonly BaselineCandidate[], segment: number): BaselineCandidate[] {
	return results.filter(result => result.segment === segment);
}

/** First kept, unflagged run in the segment — the baseline. */
export function findBaselineResult(results: readonly BaselineCandidate[], segment: number): BaselineCandidate | null {
	return currentResults(results, segment).find(result => result.status === "keep" && !result.flagged) ?? null;
}

export function findBaselineMetric(results: readonly BaselineCandidate[], segment: number): number | null {
	const baseline = findBaselineResult(results, segment);
	return baseline && baseline.metric !== null ? baseline.metric : null;
}

/** Best kept, unflagged metric in the segment, honoring direction. */
export function findBestKeptMetric(
	results: readonly BaselineCandidate[],
	segment: number,
	direction: MetricDirection,
): number | null {
	let best: number | null = null;
	for (const result of currentResults(results, segment)) {
		if (result.status !== "keep" || result.flagged || result.metric === null) continue;
		if (best === null || isBetter(result.metric, best, direction)) {
			best = result.metric;
		}
	}
	return best;
}

export function findBaselineRunNumber(results: readonly BaselineCandidate[], segment: number): number | null {
	const baseline = findBaselineResult(results, segment);
	return baseline ? baseline.runNumber : null;
}

/** Baseline secondary-metric values, filling gaps from other unflagged runs. */
export function findBaselineSecondary(
	results: readonly BaselineCandidate[],
	segment: number,
	knownMetrics: MetricDef[],
): NumericMetricMap {
	const baseline = findBaselineResult(results, segment);
	const values: NumericMetricMap = baseline ? { ...baseline.metrics } : {};
	for (const metric of knownMetrics) {
		if (values[metric.name] !== undefined) continue;
		for (const result of currentResults(results, segment)) {
			if (result.flagged) continue;
			const value = result.metrics[metric.name];
			if (value !== undefined) {
				values[metric.name] = value;
				break;
			}
		}
	}
	return values;
}

export function sortedMedian(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const midpoint = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
	}
	return sorted[midpoint]!;
}

/**
 * Confidence score: how many multiples of the observed noise floor (median
 * absolute deviation) separate the best kept metric from the baseline. Null
 * when there are too few runs, no baseline, or no measurable spread.
 */
export function computeConfidence(
	results: readonly BaselineCandidate[],
	segment: number,
	direction: MetricDirection,
): number | null {
	const current = currentResults(results, segment).filter(
		result => !result.flagged && result.metric !== null && result.metric > 0,
	);
	if (current.length < 3) return null;

	const values = current.map(result => result.metric as number);
	const median = sortedMedian(values);
	const mad = sortedMedian(values.map(value => Math.abs(value - median)));
	if (mad === 0) return null;

	const baseline = findBaselineMetric(results, segment);
	if (baseline === null) return null;

	let bestKept: number | null = null;
	for (const result of current) {
		if (result.status !== "keep" || (result.metric ?? 0) <= 0) continue;
		if (bestKept === null || isBetter(result.metric as number, bestKept, direction)) {
			bestKept = result.metric as number;
		}
	}
	if (bestKept === null || bestKept === baseline) return null;

	return Math.abs(bestKept - baseline) / mad;
}

export interface AutoresearchExperimentResult {
	runNumber: number;
	commit: string;
	metric: number | null;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi?: ASIData;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
}

export interface AutoresearchExperimentState {
	results: AutoresearchExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	goal: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	confidence: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	notes: string;
	branch: string | null;
	baselineCommit: string | null;
}

/** Rebuild the experiment state view from the persisted config + logged runs. */
export function buildAutoresearchExperimentState(
	config: AutoresearchExperimentConfig,
	loggedRuns: AutoresearchRunRecord[],
): AutoresearchExperimentState {
	const secondaryMetrics: MetricDef[] = config.secondaryMetrics.map(name => ({
		name,
		unit: inferMetricUnitFromName(name),
	}));
	const results: AutoresearchExperimentResult[] = [];
	for (const run of loggedRuns) {
		if (run.status === null) continue;
		const result: AutoresearchExperimentResult = {
			runNumber: run.runNumber,
			commit: run.commitHash ?? "",
			metric: run.metric,
			metrics: { ...run.metrics },
			status: run.status,
			description: run.description ?? "",
			timestamp: run.loggedAt ?? run.startedAt,
			segment: run.segment,
			confidence: run.confidence,
			asi: run.asi ?? undefined,
			modifiedPaths: [...run.modifiedPaths],
			scopeDeviations: [...run.scopeDeviations],
			justification: run.justification,
			flagged: run.flagged,
			flaggedReason: run.flaggedReason,
		};
		results.push(result);
		if (run.segment === config.currentSegment) {
			registerSecondaryMetrics(secondaryMetrics, run.metrics);
		}
	}

	const bestMetric = findBaselineMetric(results, config.currentSegment);
	const confidence = computeConfidence(results, config.currentSegment, config.direction);
	return {
		results,
		bestMetric,
		bestDirection: config.direction,
		metricName: config.primaryMetric,
		metricUnit: config.metricUnit,
		secondaryMetrics,
		name: config.name,
		goal: config.goal,
		currentSegment: config.currentSegment,
		maxExperiments: config.maxIterations,
		confidence,
		scopePaths: [...config.scopePaths],
		offLimits: [...config.offLimits],
		constraints: [...config.constraints],
		notes: config.notes,
		branch: config.branch,
		baselineCommit: config.baselineCommit,
	};
}

function registerSecondaryMetrics(metrics: MetricDef[], values: NumericMetricMap): void {
	for (const name of Object.keys(values)) {
		if (metrics.some(metric => metric.name === name)) continue;
		metrics.push({
			name,
			unit: inferMetricUnitFromName(name),
		});
	}
}
