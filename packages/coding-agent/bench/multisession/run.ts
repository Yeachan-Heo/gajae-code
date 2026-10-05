/**
 * RFC #6247 Phase A run protocol (S6). Bench-only CLI.
 *
 *   bun bench/multisession/run.ts --arm broker      --reps 5 [--seconds 30]
 *   bun bench/multisession/run.ts --arm standalone  --n 1,3,5 --reps 5 [--churn 20] [--idle-ms 30000]
 *   bun bench/multisession/run.ts --arm preflight
 *   bun bench/multisession/run.ts --arm worker      --n 1,3,5 --reps 5 [--churn 20]
 *   bun bench/multisession/run.ts --characterize
 *   bun bench/multisession/run.ts --sanity          (non-gating: both arms, N=3, default real model)
 *   bun bench/multisession/run.ts --report <artifacts dir>
 *
 * `preflight` and `worker` refuse to run unless the posted pre-registration
 * receipt matches the current contract digest; `worker` and `sanity`
 * additionally need a passing preflight bound to the current clean source,
 * workload, bootstrap and Bun version. Raw samples land in
 * `<repo>/artifacts/multisession/`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as util from "node:util";
import { createArm, type Arm } from "./arms";
import { measureBrokerBaseline } from "./broker-baseline";
import { characterize } from "./characterize";
import { Cohort } from "./cohort";
import {
	checkAdmission,
	contractDigest,
	loadContract,
	type PreflightRecord,
	type PreregistrationContract,
	type PreregistrationReceipt,
} from "./contract";
import { compareEvidence } from "./normalize";
import { createRealPreflightAdapter, decidePreflight, preflightRecord } from "./preflight";
import { currentProvenance, type Provenance } from "./provenance";
import { evaluate, hostResidueFootprint, renderMarkdown } from "./report";
import { SANITY_UNAVAILABLE } from "./session-runner";
import type { WorkloadVariant } from "./workload";
import {
	type ArmKind,
	type BrokerBaselineRecord,
	benchNow,
	type ChurnRecord,
	type CohortSample,
	type OrphanReceipt,
	type RepRecord,
	type RunnerEvent,
} from "./types";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
export const ARTIFACTS_ROOT = path.join(REPO_ROOT, "artifacts", "multisession");
export const RECEIPT_PATH = path.join(import.meta.dir, "preregistration-receipt.json");
export const PREFLIGHT_PATH = path.join(ARTIFACTS_ROOT, "preflight.json");

const TICK_MS = 1_000;
/** Ticks later than this after their scheduled instant count as missed. */
const TICK_TOLERANCE_MS = 500;
const OWNERSHIP_SCAN_MS = 100;
const STEADY_EXCLUSION_MS = 2_000;
const SESSION_TIMEOUT_MS = 30 * 60_000;

function progress(message: string): void {
	process.stderr.write(`[multisession] ${message}\n`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, `${JSON.stringify(value, null, "\t")}\n`);
}

async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
	const handle = Bun.file(file);
	return (await handle.exists()) ? ((await handle.json()) as T) : undefined;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

interface Sampler {
	readonly samples: CohortSample[];
	/** Resolves with the tick index of the first sample at or after `atMs` (null when that tick was missed). */
	sampleAtOrAfter(atMs: number): Promise<number | null>;
	stop(): Promise<void>;
}

/**
 * Takes one cohort sample per scheduled 1 Hz tick and an ownership scan every
 * 100 ms in between. A tick serviced more than TICK_TOLERANCE_MS late is not
 * sampled at all; the eligibility policy then counts it as incomplete.
 */
function startSampler(cohort: Cohort, startedAt: number, phaseAt: (t: number) => string): Sampler {
	const samples: CohortSample[] = [];
	const tickWaiters: Array<{ atMs: number; resolve: (tick: number | null) => void }> = [];
	let running = true;
	const loop = (async () => {
		let tick = 0;
		let nextScan = benchNow();
		while (running) {
			const scheduled = startedAt + tick * TICK_MS;
			const now = benchNow();
			if (now >= scheduled) {
				const late = now - scheduled > TICK_TOLERANCE_MS;
				if (!late) {
					cohort.scanOwnership();
					samples.push(cohort.sample(tick, phaseAt(now)));
				}
				for (const waiter of tickWaiters.splice(0)) {
					if (scheduled >= waiter.atMs) waiter.resolve(late ? null : tick);
					else tickWaiters.push(waiter);
				}
				tick += 1;
				continue;
			}
			if (now >= nextScan) {
				cohort.scanOwnership();
				nextScan = benchNow() + OWNERSHIP_SCAN_MS;
			}
			await Bun.sleep(Math.max(1, Math.min(scheduled, nextScan) - benchNow()));
		}
		for (const waiter of tickWaiters.splice(0)) waiter.resolve(null);
	})();
	return {
		samples,
		sampleAtOrAfter(atMs) {
			const { promise, resolve } = Promise.withResolvers<number | null>();
			tickWaiters.push({ atMs, resolve });
			return promise;
		},
		async stop() {
			running = false;
			await loop;
		},
	};
}

function phaseEvents(events: RunnerEvent[], sessionIndex: number): Array<Extract<RunnerEvent, { type: "phase" }>> {
	return events.filter(
		(event): event is Extract<RunnerEvent, { type: "phase" }> => event.type === "phase" && event.sessionIndex === sessionIndex,
	);
}

/**
 * Steady-state window: from STEADY_EXCLUSION_MS after the last session became
 * ready until the first session started disposing.
 */
function steadyWindow(arm: Arm, indices: number[]): { start: number; end: number } | null {
	const readyTimes: number[] = [];
	const disposingTimes: number[] = [];
	for (const index of indices) {
		const phases = phaseEvents(arm.events, index);
		const ready = phases.find(event => event.phase === "ready");
		const disposing = phases.find(event => event.phase === "disposing");
		if (!ready || !disposing) return null;
		readyTimes.push(ready.t);
		disposingTimes.push(disposing.t);
	}
	const start = Math.max(...readyTimes) + STEADY_EXCLUSION_MS;
	const end = Math.min(...disposingTimes);
	return end > start ? { start, end } : null;
}

// ---------------------------------------------------------------------------
// Repetitions
// ---------------------------------------------------------------------------

interface RepOptions {
	kind: ArmKind;
	n: number;
	rep: number;
	idleMs: number;
	variant: WorkloadVariant;
	runId: string;
	runDir: string;
}

function newCohort(token: string): Cohort {
	return new Cohort({ token, driverPid: process.pid, runStartEpochMs: Date.now() });
}

export async function runRep(options: RepOptions): Promise<RepRecord> {
	const label = `${options.kind}-n${options.n}-r${options.rep}`;
	const rootDir = path.join(options.runDir, label);
	await fs.mkdir(rootDir, { recursive: true });
	const token = `${options.runId}:${label}`;
	const cohort = newCohort(token);
	const arm = createArm({ kind: options.kind, rootDir, idleMs: options.idleMs, variant: options.variant, token, cohort });
	const indices = Array.from({ length: options.n }, (_, index) => index);
	let window: { start: number; end: number } | null = null;
	const startedAt = benchNow();
	const sampler = startSampler(cohort, startedAt, t => {
		if (window) return t < window.start ? "startup" : t < window.end ? "active" : "teardown";
		return "running";
	});
	let invalidReason: string | undefined;
	let teardownTick: number | null = null;
	let visibilityCheck: RepRecord["visibilityCheck"] = { passed: false, reason: "not run" };
	try {
		arm.createSessions(indices);
		visibilityCheck = cohort.visibilityCheck();
		await arm.waitDisposed(indices, SESSION_TIMEOUT_MS);
		const failures = indices.map(index => arm.sessions.get(index)?.error).filter(error => error !== undefined);
		if (failures.length > 0) invalidReason = `session error: ${failures[0]}`;
		window = steadyWindow(arm, indices);
		for (const index of indices) await arm.closeSession(index);
		const lastClose = benchNow();
		teardownTick = await sampler.sampleAtOrAfter(lastClose + 10_000);
		if (teardownTick === null) invalidReason ??= "teardown tick missed";
	} catch (error) {
		invalidReason = `harness: ${error instanceof Error ? error.message : String(error)}`;
		arm.abort();
	} finally {
		await sampler.stop();
		await arm.shutdown().catch(() => arm.abort());
	}
	await Bun.sleep(1_000);
	cohort.scanOwnership();
	const orphans = cohort.orphanCheck();
	cohort.close();
	if (!window) invalidReason ??= "steady-state window could not be determined";
	const gatedWindowTicks = window
		? sampler.samples.length === 0
			? []
			: Array.from({ length: Math.ceil((window.end - startedAt) / TICK_MS) + 1 }, (_, tick) => tick).filter(tick => {
					const at = startedAt + tick * TICK_MS;
					return at >= window!.start && at < window!.end;
				})
		: [];
	const coldReadyMs: number[] = [];
	const warmAdmissionMs: number[] = [];
	for (const index of indices) {
		const timing = arm.sessions.get(index);
		if (!timing?.readyAt) continue;
		coldReadyMs.push(timing.readyAt - timing.coldStart);
		if (timing.warm) warmAdmissionMs.push(timing.readyAt - timing.createdAt);
	}
	const record: RepRecord = {
		arm: options.kind,
		n: options.n,
		rep: options.rep,
		samples: sampler.samples,
		gatedWindowTicks,
		teardownTick,
		runnerEvents: arm.events,
		coldReadyMs,
		warmAdmissionMs,
		visibilityCheck,
		orphans,
		...(invalidReason ? { invalidReason } : {}),
	};
	// Sanity reps are non-gating; their own prefix keeps them out of `--report`.
	const recordPrefix = options.variant === "sanity" ? "sanity" : "rep";
	await writeJson(path.join(options.runDir, `${recordPrefix}-${label}.json`), record);
	return record;
}

/**
 * Churn (S3): the same arm instance across `cycles` cycles of create×5 →
 * full workload (idle 0) → close×5, sampling 10 s after each fifth close.
 * The Worker arm keeps ONE resident host for all cycles.
 */
export async function runChurn(options: { kind: ArmKind; cycles: number; runId: string; runDir: string }): Promise<ChurnRecord> {
	const label = `${options.kind}-churn`;
	const rootDir = path.join(options.runDir, label);
	await fs.mkdir(rootDir, { recursive: true });
	const token = `${options.runId}:${label}`;
	const cohort = newCohort(token);
	const arm = createArm({ kind: options.kind, rootDir, idleMs: 0, variant: "full", token, cohort });
	const cycleSamples: CohortSample[] = [];
	const hostFootprints: Array<number | null> = [];
	const cycleErrors: string[][] = [];
	let completedCycles = 0;
	try {
		for (let cycle = 0; cycle < options.cycles; cycle += 1) {
			const indices = Array.from({ length: 5 }, (_, slot) => cycle * 5 + slot);
			arm.createSessions(indices);
			await arm.waitDisposed(indices, SESSION_TIMEOUT_MS);
			cycleErrors.push(
				indices.flatMap(index => {
					const error = arm.sessions.get(index)?.error;
					return error === undefined ? [] : [`session ${index}: ${error}`];
				}),
			);
			for (const index of indices) await arm.closeSession(index);
			await Bun.sleep(10_000);
			cohort.scanOwnership();
			const sample = cohort.sample(cycle, `post-close-cycle-${cycle + 1}`);
			cycleSamples.push(sample);
			hostFootprints.push(hostFootprint(sample, options.kind));
			completedCycles += 1;
			progress(`${label} cycle ${cycle + 1}/${options.cycles} armTotal=${sample.armTotal ?? "incomplete"}`);
		}
	} catch (error) {
		progress(`${label} aborted: ${error instanceof Error ? error.message : String(error)}`);
		arm.abort();
	} finally {
		await arm.shutdown().catch(() => arm.abort());
	}
	await Bun.sleep(1_000);
	cohort.scanOwnership();
	const record: ChurnRecord = {
		arm: options.kind,
		cycleSamples,
		hostFootprints,
		cycleErrors,
		completedCycles,
		orphans: cohort.orphanCheck(),
	};
	cohort.close();
	await writeJson(path.join(options.runDir, `churn-${options.kind}.json`), record);
	return record;
}

function hostFootprint(sample: CohortSample, kind: ArmKind): number | null {
	return sample.complete ? hostResidueFootprint(sample, kind) : null;
}

export interface SanityArmSummary {
	arm: ArmKind;
	sessions: number;
	completedSessions: number;
	errors: string[];
	turnLatencyMs: number[];
	peakArmFootprint: number | null;
	orphans: OrphanReceipt;
}

export type SanitySummary =
	| { status: "skipped"; reason: string }
	| { status: "ran"; nonGating: true; arms: SanityArmSummary[] };

/** Summarize one sanity rep: completion, real-provider turn latency, and peak footprint. */
export function summarizeSanityRep(record: RepRecord): SanityArmSummary {
	const errors = record.runnerEvents
		.filter((event): event is Extract<RunnerEvent, { type: "error" }> => event.type === "error")
		.map(event => event.message);
	const completed = new Set(
		record.runnerEvents.filter(event => event.type === "done").map(event => event.sessionIndex),
	);
	const turnLatencyMs = record.runnerEvents
		.filter((event): event is Extract<RunnerEvent, { type: "turn" }> => event.type === "turn" && event.ok)
		.map(event => event.endedAt - event.startedAt);
	const totals = record.samples
		.filter(sample => sample.complete && sample.armTotal !== null)
		.map(sample => sample.armTotal as number);
	return {
		arm: record.arm,
		sessions: record.n,
		completedSessions: completed.size,
		errors,
		turnLatencyMs,
		peakArmFootprint: totals.length > 0 ? Math.max(...totals) : null,
		orphans: record.orphans,
	};
}

async function runSanity(runId: string, runDir: string): Promise<SanitySummary> {
	const arms: SanityArmSummary[] = [];
	for (const kind of ["standalone", "worker"] as const) {
		const record = await runRep({ kind, n: 3, rep: 0, idleMs: 0, variant: "sanity", runId, runDir });
		const summary = summarizeSanityRep(record);
		const unavailable = summary.errors.find(error => error.startsWith(SANITY_UNAVAILABLE));
		// No model or credentials is the plan's documented skip, not a failure.
		if (unavailable) return { status: "skipped", reason: unavailable };
		arms.push(summary);
	}
	return { status: "ran", nonGating: true, arms };
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

async function admit(kind: "preflight" | "worker", contract: PreregistrationContract, provenance: Provenance): Promise<void> {
	const receipt = await readJsonIfExists<PreregistrationReceipt>(RECEIPT_PATH);
	const preflight = kind === "worker" ? await readJsonIfExists<PreflightRecord>(PREFLIGHT_PATH) : undefined;
	const admission = checkAdmission(kind, {
		contract,
		...(receipt ? { receipt } : {}),
		...(preflight ? { preflight } : {}),
		current: provenance,
	});
	if (!admission.ok) throw new Error(`refusing --arm ${kind}: ${admission.reason}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function collectJson(dir: string): Promise<Array<{ file: string; value: unknown }>> {
	const out: Array<{ file: string; value: unknown }> = [];
	for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		if (!/^(rep-|churn-|broker\.json$|characterization\.json$)/.test(entry.name)) continue;
		const file = path.join(entry.parentPath, entry.name);
		out.push({ file, value: await Bun.file(file).json() });
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

function evidenceDirs(rep: RepRecord): Map<number, string> {
	const dirs = new Map<number, string>();
	for (const event of rep.runnerEvents) if (event.type === "done") dirs.set(event.sessionIndex, event.evidenceDir);
	return dirs;
}

/** Environment pins that must be identical across every report operand. */
const PROVENANCE_PINS = [
	"sourceSha",
	"dirty",
	"workloadDigest",
	"bootstrapDigest",
	"bunVersion",
	"osVersion",
	"cpu",
	"contractDigest",
] as const;

/**
 * Every operand (reps, churn, B, characterization) is read from its run
 * directory's environment.json; operands from different source, configuration,
 * Bun, or machine pins are never combined into one report.
 */
export async function assertConsistentProvenance(files: string[]): Promise<void> {
	const pinsByRun = new Map<string, string>();
	for (const file of files) {
		const runDir = path.dirname(file);
		if (pinsByRun.has(runDir)) continue;
		const environment = await readJsonIfExists<Record<string, unknown>>(path.join(runDir, "environment.json"));
		if (!environment) throw new Error(`Report operand ${file} has no environment.json pins`);
		const missing = PROVENANCE_PINS.filter(pin => environment[pin] === undefined || environment[pin] === null);
		if (missing.length > 0) throw new Error(`Report operand ${file} is missing provenance pins: ${missing.join(", ")}`);
		pinsByRun.set(runDir, JSON.stringify(PROVENANCE_PINS.map(pin => [pin, environment[pin]])));
	}
	const distinct = new Set(pinsByRun.values());
	if (distinct.size > 1) {
		const lines = [...pinsByRun].map(([runDir, pins]) => `${path.basename(runDir)}: ${pins}`);
		throw new Error(`Report operands have inconsistent provenance pins:\n${lines.join("\n")}`);
	}
}

export async function buildReport(dir: string): Promise<{ markdown: string; fidelityDiffs: string[] }> {
	const contract = await loadContract();
	const files = await collectJson(dir);
	// Later files (sorted by run directory timestamp) supersede earlier ones for the same key.
	const reps = new Map<string, RepRecord>();
	const churn: { standalone?: ChurnRecord; worker?: ChurnRecord } = {};
	let broker: BrokerBaselineRecord = { reps: [], b: null };
	let characterization: "equal" | "differs" | "unavailable" = "unavailable";
	await assertConsistentProvenance(files.map(({ file }) => file));
	for (const { file, value } of files) {
		const name = path.basename(file);
		if (name.startsWith("rep-")) {
			const rep = value as RepRecord;
			reps.set(`${rep.arm}:${rep.n}:${rep.rep}`, rep);
		} else if (name.startsWith("churn-")) {
			const record = value as ChurnRecord;
			churn[record.arm] = record;
		} else if (name === "broker.json") broker = value as BrokerBaselineRecord;
		else if (name === "characterization.json") characterization = (value as { outcome: typeof characterization }).outcome;
	}
	const standalone = [...reps.values()].filter(rep => rep.arm === "standalone");
	const worker = [...reps.values()].filter(rep => rep.arm === "worker");

	// Fidelity: every Worker session's evidence must equal the same session index
	// of the same (n, rep) standalone run after normalization.
	const fidelityDiffs: string[] = [];
	let compared = 0;
	// Every gated repetition of either arm needs a matched counterpart and every
	// session index needs evidence on both sides; anything missing is a difference.
	const pairKeys = new Set([...reps.values()].map(rep => `${rep.n}:${rep.rep}`));
	for (const key of [...pairKeys].sort()) {
		const [n, repIndex] = key.split(":").map(Number);
		const standaloneRep = reps.get(`standalone:${key}`);
		const workerRep = reps.get(`worker:${key}`);
		if (!standaloneRep || !workerRep) {
			fidelityDiffs.push(`n${n} r${repIndex}: no ${standaloneRep ? "worker" : "standalone"} repetition to compare`);
			continue;
		}
		const a = evidenceDirs(standaloneRep);
		const b = evidenceDirs(workerRep);
		for (let index = 0; index < n; index += 1) {
			const standaloneDir = a.get(index);
			const workerDir = b.get(index);
			if (!standaloneDir || !workerDir) {
				fidelityDiffs.push(`n${n} r${repIndex} s${index}: no ${standaloneDir ? "worker" : "standalone"} evidence`);
				continue;
			}
			const comparison = await compareEvidence(standaloneDir, workerDir);
			compared += 1;
			if (!comparison.equal)
				fidelityDiffs.push(...comparison.diffs.slice(0, 5).map(diff => `n${n} r${repIndex} s${index}: ${diff}`));
		}
	}
	const report = evaluate({
		contract,
		standalone,
		worker,
		churn,
		broker,
		fidelity: { equal: compared > 0 && fidelityDiffs.length === 0 },
		characterization,
	});
	const header = [
		`Contract digest: \`${contractDigest(contract)}\``,
		`Fidelity comparisons: ${compared} session pairs, ${fidelityDiffs.length} differences`,
		"",
	].join("\n");
	return { markdown: `${header}\n${renderMarkdown(report)}`, fidelityDiffs };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const { values } = util.parseArgs({
		args: process.argv.slice(2),
		options: {
			arm: { type: "string" },
			n: { type: "string", default: "1,3,5" },
			reps: { type: "string", default: "5" },
			churn: { type: "string", default: "0" },
			"idle-ms": { type: "string", default: "30000" },
			seconds: { type: "string", default: "30" },
			report: { type: "string" },
			characterize: { type: "boolean", default: false },
			sanity: { type: "boolean", default: false },
		},
		strict: true,
	});

	if (values.report) {
		const { markdown, fidelityDiffs } = await buildReport(path.resolve(values.report));
		const out = path.join(path.resolve(values.report), "report.md");
		await Bun.write(out, markdown);
		if (fidelityDiffs.length > 0) await writeJson(path.join(path.resolve(values.report), "fidelity-diffs.json"), fidelityDiffs);
		process.stdout.write(markdown);
		return;
	}

	const mode = values.characterize ? "characterize" : values.sanity ? "sanity" : values.arm;
	if (mode !== "characterize" && mode !== "sanity" && !ARM_MODES.includes(mode as (typeof ARM_MODES)[number])) {
		throw new Error(`--arm must be one of ${ARM_MODES.join("|")} (or use --report / --characterize / --sanity)`);
	}
	const ns = values.n.split(",").map(value => positiveInteger("--n", value));
	const repCount = positiveInteger("--reps", values.reps);
	const cycles = nonNegativeInteger("--churn", values.churn);
	const idleMs = nonNegativeInteger("--idle-ms", values["idle-ms"]);
	const seconds = positiveInteger("--seconds", values.seconds);

	const provenance = await currentProvenance();
	const contract = await loadContract();
	// Admission is decided before anything is written, so a refused run leaves no run directory.
	if (mode === "sanity" || mode === "worker") await admit("worker", contract, provenance);
	if (mode === "preflight") await admit("preflight", contract, provenance);
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`;
	const runDir = path.join(ARTIFACTS_ROOT, runId);
	await writeJson(path.join(runDir, "environment.json"), {
		...provenance,
		contractDigest: contractDigest(contract),
		argv: process.argv.slice(2),
		bunConfig: "default (no --smol)",
	});

	switch (mode) {
		case "characterize": {
			const outcome = await characterize();
			await writeJson(path.join(runDir, "characterization.json"), outcome);
			progress(`characterization: ${JSON.stringify(outcome)}`);
			return;
		}
		case "sanity": {
			// Non-gating real-provider check: both arms, N=3, the operator's default model.
			const summary = await runSanity(runId, runDir);
			await writeJson(path.join(runDir, "sanity.json"), summary);
			progress(`sanity: ${JSON.stringify(summary)}`);
			return;
		}
		case "broker": {
			const record = await measureBrokerBaseline({ reps: repCount, seconds });
			await writeJson(path.join(runDir, "broker.json"), record);
			progress(`broker baseline B=${record.b ?? "insufficient-evidence"}`);
			return;
		}
		case "preflight": {
			const outcome = await decidePreflight(
				createRealPreflightAdapter({ workDir: path.join(runDir, "preflight"), runId, driverStartEpochMs: Date.now() }),
			);
			const record = preflightRecord(outcome, provenance, contractDigest(contract));
			await writeJson(path.join(runDir, "preflight.json"), record);
			await writeJson(PREFLIGHT_PATH, record);
			progress(`preflight ${record.result}: ${record.checks.filter(check => !check.passed).map(check => check.name).join(", ") || "all checks passed"}`);
			if (record.result !== "pass") process.exitCode = 2;
			return;
		}
		case "standalone":
		case "worker": {
			for (const n of ns) {
				for (let rep = 0; rep < repCount; rep += 1) {
					const record = await runRep({ kind: mode, n, rep, idleMs, variant: "full", runId, runDir });
					progress(
						`${mode} n=${n} rep=${rep} ${record.invalidReason ? `INVALID (${record.invalidReason})` : "ok"} samples=${record.samples.length} orphans=${record.orphans.owned.length + record.orphans.unresolved.length}`,
					);
				}
			}
			if (cycles > 0) await runChurn({ kind: mode, cycles, runId, runDir });
			return;
		}
	}
}

const ARM_MODES = ["broker", "standalone", "preflight", "worker"] as const;

function positiveInteger(flag: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer, got "${value}"`);
	return parsed;
}

function nonNegativeInteger(flag: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
	return parsed;
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		// A refusal or failed run is an expected outcome, reported without a stack.
		process.stderr.write(`multisession: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
	process.exit();
}
