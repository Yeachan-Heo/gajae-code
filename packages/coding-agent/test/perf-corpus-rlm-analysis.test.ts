import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGitProvenance } from "../bench/perf-corpus.bench";
import {
	MEMORY_CAPTURE_SEMANTICS_ID,
	type MemoryBaselineMetric,
	type MemorySurface,
	memoryRuntimeControlIdentity,
	type PerfCorpusReport,
} from "../bench/perf-corpus-schema";

const driverPath = path.resolve(import.meta.dir, "../bench/perf-corpus-rlm-analysis.py");
const preregistrationPath = path.resolve(import.meta.dir, "../bench/perf-corpus-preregistration.json");
const templatePath = path.resolve(import.meta.dir, "../bench/perf-corpus-rlm-template.ipynb");
const bundleDirectory = path.dirname(driverPath);
const canonicalBenchmarkPath = path.resolve(import.meta.dir, "../bench/perf-corpus.bench.ts");

function runPerfCorpusBenchmark(): PerfCorpusReport {
	const result = Bun.spawnSync([process.execPath, ...process.execArgv, canonicalBenchmarkPath], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...process.env, GJC_MEMORY_ITERATIONS: process.env.GJC_MEMORY_ITERATIONS ?? "1" },
	});
	if (result.exitCode !== 0) {
		throw new Error(decoder.decode(result.stderr));
	}
	return JSON.parse(decoder.decode(result.stdout)) as PerfCorpusReport;
}
const gitSha = "0123456789abcdef0123456789abcdef01234567";
const expectedTemplateSha256 = "dab587637aa4202c97348dbe2f856df95827598bc8abd87079af8b6e91884d36";
const decoder = new TextDecoder();
let temporaryRoot = "";
let preregistration: Preregistration;
let driverSha256 = "";
let preregistrationSha256 = "";
let authenticatedLauncher: AuthenticatedLauncher;
const treeSha = "d".repeat(40);
const worktreeFingerprint = "c".repeat(64);
const captureRuntimeControlIdentity = "e".repeat(64);
const captureId = "f".repeat(64);
const hostId = "1".repeat(64);
let expectedClosureDigest = "";
let expectedScheduleDigest = "";
let expectedProtocolDigest = "";
const sealedDigestsByDirectory = new Map<string, { attemptLedgerSha256: string; rawManifestSha256: string }>();

interface ScheduleItem {
	attemptId: string;
	profile: "short" | "soak";
	attemptNumber: number;
	expectedFilename: string;
}

interface AdmissionRow {
	slotId: string;
	surfaceOrder: MemorySurface[];
}

interface ScheduledReport extends ScheduleItem {
	admissionNumber: number;
	slotId: string;
	surfaceOrder: MemorySurface[];
}

interface Preregistration {
	cohort: {
		profiles: Record<
			"short" | "soak",
			{
				requiredAdmittedBlocks: number;
				attemptCap: number;
				durationTargetMs: number;
				iterationsTarget: number;
				maximumPeriodicSamples: number;
				elapsedDurationToleranceMs: number;
			}
		>;
		sharedRunnerProvenanceFields: string[];
	};
	captureControls: {
		admissionRows: Record<"short" | "soak", AdmissionRow[]>;
		schedule: ScheduleItem[];
	};
	sealedInputContract: {
		protocolDigestFields: string[];
	};
}

type SlopePlan = number | { steadyDeltas: number[] };

type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface MemorySample {
	elapsedMs: number;
	rssBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalBytes: number;
	arrayBuffersBytes: number;
	activeResourceCount: number;
}

interface ByteExtremum {
	valueBytes: number;
	elapsedMs: number;
}

interface SyntheticMemoryBaseline {
	periodicSamples: MemorySample[];
	observedExtrema: {
		heapUsedBytes: ByteExtremum;
	};
	heapSlopeBytesPerSecond: number | null;
	processTreeBaselineRssBytes: number | null;
	processTreePostTeardownRssBytes: number | null;
	processTreeSampler: "ps" | "unavailable";
	ordinal: number;
	childPid: number;
	parentPid: number;
	captureSemanticsId: string;
}

interface SyntheticReportMutationSurface {
	gitDirty: boolean;
	runner: PerfCorpusReport["runner"];
	fixtures: Array<{
		sourceClass: string;
		privacy: Record<string, JsonValue>;
		memoryBaseline: SyntheticMemoryBaseline;
	}>;
	hotspotClassifications: JsonObject[];
	thresholdLedger: JsonObject[];
	depthProbe?: JsonValue;
}

interface ValidationError {
	code: string;
	filename?: string;
	message?: string;
	blockId?: string;
	attemptId?: string;
}

interface AdmissionSummary {
	attemptsObserved?: number;
	admittedBlocks: number;
	invalidBlocks: number;
	notEvaluatedBlocks: number;
	excludedBlocks: number;
}

interface SurfaceDecision {
	primaryBca: {
		resamples: number;
	};
	endpointPositiveSigns: number;
	theilSenPositiveSigns: number;
	surfacePass: boolean;
}

interface ValidationResult {
	evidenceStatus: string;
	actionDecision: string;
	actionAnalysis: {
		surfaces: Record<string, SurfaceDecision>;
	};
	hashBindings: {
		driverSha256: string;
		preregistrationSha256: string;
		templateSha256: string;
		expectedTreeSha: string;
		expectedClosureDigest: string;
		expectedWorktreeFingerprint: string;
		expectedRuntimeControlIdentity: string;
		expectedCaptureId: string;
		expectedScheduleDigest: string;
		expectedProtocolDigest: string;
		attemptLedgerSha256: string;
		rawManifestSha256: string;
		orderedReportHashes: Array<{
			sequence: number;
			attemptId: string;
			admissionSlotId: string;
			profile: string;
			filename: string;
			sha256: string;
		}>;
	};
	admissionTraceability: Array<{
		ledgerSequence: number;
		attemptId: string;
		admissionSlotId: string;
		profile: string;
		filename: string;
		sha256: string;
	}>;
	admission: Record<"short" | "soak", AdmissionSummary>;
	claimPolicy: {
		p95: {
			status: string;
			finiteUpperEndpointAvailable: boolean;
			empiricalP95Emitted: boolean;
		};
	};
	cohort?: {
		sharedRunnerProvenance: Record<string, JsonValue>;
	};
	diagnostics: {
		validationErrors: ValidationError[];
		attemptTelemetry?: Array<{
			attemptId: string;
			telemetryBefore: JsonObject;
			telemetryAfter: JsonObject;
		}>;
		driftOrderTimeTelemetrySensitivities?: Record<string, JsonValue>;
		validatedAttemptOrder?: string[];
	};
	runLevelPointsByProfileAndSurface?: Record<string, Record<string, JsonValue[]>>;
	descriptiveByProfileAndSurface?: Record<string, Record<string, Record<string, JsonValue>>>;
}

interface NotebookCell {
	cell_type: string;
	source: string[];
}

interface Notebook {
	cells: NotebookCell[];
}

interface AuthenticatedLauncher {
	readonly code: string;
	readonly immutableMountAttestation: "1";
	readonly templateSha256: string;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error("canonical JSON primitive is unsupported");
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (typeof value !== "object") throw new Error("canonical JSON value is unsupported");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function canonicalDigest(value: unknown): string {
	return sha256(canonicalJson(value));
}

function sealedObject(payload: Record<string, JsonValue>): Record<string, JsonValue> {
	return {
		...payload,
		seal: {
			algorithm: "sha256-canonical-json",
			digest: canonicalDigest(payload),
		},
	};
}

function payloadWithoutSeal(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "seal")) as JsonObject;
}

async function writeSealedJson(target: string, payload: JsonObject): Promise<Uint8Array> {
	const raw = new TextEncoder().encode(`${JSON.stringify(sealedObject(payload))}\n`);
	await fs.writeFile(target, raw);
	return raw;
}

async function resealCorpus(directory: string): Promise<void> {
	const ledgerPath = path.join(directory, "perf-corpus-attempt-ledger.json");
	const manifestPath = path.join(directory, "perf-corpus-raw-manifest.json");
	const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as JsonObject;
	const attempts = ledger.attempts as JsonObject[];
	const reportEntries: JsonObject[] = [];
	for (const [index, attempt] of attempts.entries()) {
		const filename = attempt.reportFilename as string;
		const raw = await fs.readFile(path.join(directory, filename));
		let report: JsonObject | null = null;
		try {
			report = JSON.parse(raw.toString("utf8")) as JsonObject;
		} catch {
			// Preserve the sealed attempt controls for deliberately malformed raw bytes.
		}
		attempt.reportSizeBytes = raw.byteLength;
		attempt.reportSha256 = sha256(raw);
		if (report !== null) {
			const runner = report.runner as JsonObject;
			attempt.actualSurfaceOrder = runner.memorySurfaceOrder!;
			attempt.runtimeControlIdentity = runner.runtimeControlIdentity!;
		}
		reportEntries.push({
			sequence: index + 1,
			attemptId: attempt.attemptId!,
			filename,
			sizeBytes: raw.byteLength,
			sha256: sha256(raw),
		});
	}
	const ledgerRaw = await writeSealedJson(ledgerPath, payloadWithoutSeal(ledger));
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as JsonObject;
	for (const field of [
		"sealedAt",
		"captureId",
		"measurementGitSha",
		"measurementTreeSha",
		"closureDigest",
		"worktreeFingerprint",
		"runtimeControlIdentity",
		"scheduleDigest",
		"protocolDigest",
	]) {
		manifest[field] = ledger[field]!;
	}
	manifest.ledger = {
		filename: "perf-corpus-attempt-ledger.json",
		sizeBytes: ledgerRaw.byteLength,
		sha256: sha256(ledgerRaw),
	};
	manifest.reports = reportEntries;
	const manifestRaw = await writeSealedJson(manifestPath, payloadWithoutSeal(manifest));
	sealedDigestsByDirectory.set(path.resolve(directory), {
		attemptLedgerSha256: sha256(ledgerRaw),
		rawManifestSha256: sha256(manifestRaw),
	});
}

function authenticateTemplateBytes(templateBytes: Uint8Array): AuthenticatedLauncher {
	const observedDigest = sha256(templateBytes);
	if (observedDigest !== expectedTemplateSha256) {
		throw new Error(
			`trusted template SHA-256 mismatch: expected ${expectedTemplateSha256}, observed ${observedDigest}`,
		);
	}
	const notebook = JSON.parse(decoder.decode(templateBytes)) as Notebook;
	const codeCell = notebook.cells.find(cell => cell.cell_type === "code");
	if (!codeCell) throw new Error("authenticated template has no code cell");
	return Object.freeze({
		code: codeCell.source.join(""),
		immutableMountAttestation: "1" as const,
		templateSha256: expectedTemplateSha256,
	});
}

async function loadAuthenticatedLauncher(target: string): Promise<AuthenticatedLauncher> {
	const templateBytes = await fs.readFile(target);
	return authenticateTemplateBytes(templateBytes);
}

function sample(elapsedMs: number, heapUsedBytes: number): MemorySample {
	return {
		elapsedMs,
		rssBytes: 200_000_000,
		heapUsedBytes,
		heapTotalBytes: 240_000_000,
		externalBytes: 8_000_000,
		arrayBuffersBytes: 4_000_000,
		activeResourceCount: 3,
	};
}

function endpointSlope(periodicSamples: MemorySample[], key: "rssBytes" | "heapUsedBytes"): number | null {
	const first = periodicSamples[0]!;
	const last = periodicSamples.at(-1)!;
	const duration = last.elapsedMs - first.elapsedMs;
	if (duration < 250) return null;
	const cutoff = first.elapsedMs + Math.min(250, duration / 4);
	const steady = periodicSamples.filter(item => item.elapsedMs >= cutoff);
	if (steady.length < 2 || steady.at(-1)!.elapsedMs - steady[0]!.elapsedMs < 250) return null;
	return ((steady.at(-1)![key] - steady[0]![key]) * 1000) / (steady.at(-1)!.elapsedMs - steady[0]!.elapsedMs);
}

function baseline(
	surface: MemorySurface,
	profile: "short" | "soak",
	iterationsTarget: number,
	plan: SlopePlan,
	ordinal: number,
): MemoryBaselineMetric {
	const initialHeap = 100_000_000;
	const periodicSamples =
		typeof plan === "number"
			? [0, 1, 2, 3, 4].map(index => {
					const elapsedMs = index * (profile === "soak" ? 7_500 : 250);
					return sample(elapsedMs, initialHeap + Math.round((plan * elapsedMs) / 1000));
				})
			: [
					sample(0, initialHeap),
					...plan.steadyDeltas.map((delta, index) =>
						sample(
							(index + 1) * (profile === "soak" ? 30_000 / plan.steadyDeltas.length : 250),
							initialHeap + delta,
						),
					),
				];
	const finalElapsed = periodicSamples.at(-1)!.elapsedMs;
	const heapMaximum = Math.max(...periodicSamples.map(item => item.heapUsedBytes));
	const extrema = {
		rssBytes: { valueBytes: 200_000_000, elapsedMs: 0 },
		heapUsedBytes: {
			valueBytes: heapMaximum,
			elapsedMs: periodicSamples.findLast(item => item.heapUsedBytes === heapMaximum)!.elapsedMs,
		},
		externalBytes: { valueBytes: 8_000_000, elapsedMs: 0 },
		arrayBuffersBytes: { valueBytes: 4_000_000, elapsedMs: 0 },
	};
	return {
		surface,
		profile,
		iterations: iterationsTarget,
		operations: iterationsTarget,
		operationsPerSecond: iterationsTarget / Math.max(finalElapsed / 1000, 1e-6),
		periodicSamples,
		observedExtrema: extrema,
		sampling: {
			periodicCadenceTargetMs: profile === "soak" ? 50 : 0,
			highWaterCadenceTargetMs: profile === "soak" ? 10 : 0,
			periodicDeadlinesMissed: 0,
			highWaterCallbacks: 0,
			highWaterProbes: 0,
			forcedHighWaterProbes: 0,
			throttledHighWaterCallbacks: 0,
		},
		postTeardown: sample(finalElapsed + 1, initialHeap),
		rssSlopeBytesPerSecond: endpointSlope(periodicSamples, "rssBytes"),
		heapSlopeBytesPerSecond: endpointSlope(periodicSamples, "heapUsedBytes"),
		processTreeBaselineRssBytes: null as number | null,
		processTreePostTeardownRssBytes: null as number | null,
		processTreeSampler: "unavailable",
		ordinal,
		childPid: 10_000 + ordinal,
		parentPid: 9_000,
		captureSemanticsId: MEMORY_CAPTURE_SEMANTICS_ID,
	};
}

function reportFor(
	schedule: ScheduledReport,
	blockIndex: number,
	slopeFor: (surface: string, blockIndex: number) => SlopePlan,
): PerfCorpusReport {
	const profileConfig = preregistration.cohort.profiles[schedule.profile];
	const fixtures: PerfCorpusReport["fixtures"] = schedule.surfaceOrder.map((surface, ordinal) => {
		const memoryBaseline = baseline(
			surface,
			schedule.profile,
			profileConfig.iterationsTarget,
			slopeFor(surface, blockIndex),
			ordinal,
		);
		const runElapsedMs = memoryBaseline.periodicSamples.at(-1)!.elapsedMs;
		return {
			fixtureId: `memory-${surface}`,
			fixtureClass: "large-transcript",
			sourceClass: "synthetic",
			workloadTags: ["memory", surface],
			privacy: {
				rawPrivateTranscriptCommitted: false,
				redactionNotes: "fully synthetic memory lifecycle fixture; no private or provider content",
			},
			wallClockPhase: { run: { elapsedMs: runElapsedMs, advisoryOnly: true } },
			processCpuUsage: { run: { userMicros: 1, systemMicros: 1, elapsedMs: runElapsedMs } },
			profilerSelfTime: { profiler: "none" },
			rssMemory: {
				baselineBytes: memoryBaseline.periodicSamples[0]!.rssBytes,
				peakBytes: memoryBaseline.observedExtrema.rssBytes.valueBytes,
				growthBytes: 0,
				returnBytes: memoryBaseline.postTeardown.rssBytes,
				heapBaselineBytes: memoryBaseline.periodicSamples[0]!.heapUsedBytes,
				heapReturnBytes: memoryBaseline.postTeardown.heapUsedBytes,
			},
			byteParity: {},
			memoryBaseline,
		};
	});
	const environment: Record<string, string> = {
		GJC_MEMORY_PROFILE: schedule.profile,
		GJC_MEMORY_ITERATIONS: String(profileConfig.iterationsTarget),
		GJC_MEMORY_SURFACE_ORDER: schedule.surfaceOrder.join(","),
	};
	if (schedule.profile === "soak") environment.GJC_MEMORY_DURATION_MS = String(profileConfig.durationTargetMs);
	const command = "bun packages/coding-agent/bench/perf-corpus.bench.ts";
	const argv = ["bun", "packages/coding-agent/bench/perf-corpus.bench.ts"];
	const closureManifest = [`packages/coding-agent/bench/perf-corpus.bench.ts:${"a".repeat(64)}`];
	const runner: PerfCorpusReport["runner"] = {
		command,
		runtimeCommand: command,
		runtimeControlIdentity: "",
		argv,
		environment,
		platform: "darwin",
		arch: "arm64",
		bunVersion: "1.3.14",
		bunExecutable: "bun",
		bunExecutableSha256: "b".repeat(64),
		worktreeFingerprint: "c".repeat(64),
		closureDigest: sha256(`${closureManifest.join("\n")}\n`),
		closureManifest,
		ci: false,
		profile: schedule.profile,
		durationTargetMs: profileConfig.durationTargetMs,
		memoryIsolation: "process-per-surface",
		memorySurfaceOrder: schedule.surfaceOrder,
		iterationsTarget: profileConfig.iterationsTarget,
		gcExposed: false,
		memoryChildGcExposed: true,
		memoryChildExecArgv: ["--smol", "--expose-gc"],
		runnerPid: 9_000,
	};
	runner.runtimeControlIdentity = memoryRuntimeControlIdentity(runner);
	return {
		schema: "gjc.perf-corpus/3",
		generatedAt: new Date(Date.UTC(2026, 6, 27, 0, 0, blockIndex)).toISOString(),
		gitSha,
		gitDirty: false,
		runner,
		fixtures,
		hotspotClassifications: [],
		thresholdLedger: [],
	};
}

async function writeCorpus(
	directory: string,
	slopeFor: (surface: string, blockIndex: number) => SlopePlan = () => 100_000,
	invalidAttemptIds: readonly string[] = [],
): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	const invalidSet = new Set(invalidAttemptIds);
	const admitted = { short: 0, soak: 0 };
	const reports: Array<{ schedule: ScheduledReport; blockIndex: number; report: PerfCorpusReport }> = [];
	for (const [blockIndex, attempt] of preregistration.captureControls.schedule.entries()) {
		const profileConfig = preregistration.cohort.profiles[attempt.profile];
		if (admitted[attempt.profile] >= profileConfig.requiredAdmittedBlocks) continue;
		const invalid = invalidSet.has(attempt.attemptId);
		const row = preregistration.captureControls.admissionRows[attempt.profile][admitted[attempt.profile]]!;
		const schedule = {
			...attempt,
			admissionNumber: admitted[attempt.profile] + 1,
			slotId: row.slotId,
			surfaceOrder: row.surfaceOrder,
		};
		reports.push({ schedule, blockIndex, report: reportFor(schedule, blockIndex, slopeFor) });
		if (!invalid) admitted[attempt.profile]++;
	}
	for (const { schedule, report } of reports) {
		await fs.writeFile(path.join(directory, schedule.expectedFilename), `${JSON.stringify(report)}\n`);
	}
	const scheduleDigest = expectedScheduleDigest;
	const protocolDigest = expectedProtocolDigest;
	let cursorMs = Date.UTC(2026, 6, 27, 0, 0, 0);
	const attempts: JsonObject[] = [];
	for (const [index, { schedule, report }] of reports.entries()) {
		const durationMs = Math.max(preregistration.cohort.profiles[schedule.profile].durationTargetMs, 1_000);
		const startedAt = new Date(cursorMs).toISOString();
		const endedAt = new Date(cursorMs + durationMs).toISOString();
		const reportRaw = await fs.readFile(path.join(directory, schedule.expectedFilename));
		attempts.push({
			sequence: index + 1,
			attemptId: schedule.attemptId,
			attemptNumber: schedule.attemptNumber,
			admissionSlotId: schedule.slotId,
			profile: schedule.profile,
			expectedSurfaceOrder: schedule.surfaceOrder,
			actualSurfaceOrder: [...report.runner.memorySurfaceOrder],
			startedAt,
			endedAt,
			cooldownAfterPreviousSeconds: index === 0 ? 0 : 60,
			hostId,
			platform: "darwin",
			arch: "arm64",
			powerSource: "AC",
			powerMode: "performance",
			sequential: true,
			interrupted: false,
			parentClosed: true,
			childrenClosed: true,
			reportFilename: schedule.expectedFilename,
			reportSizeBytes: reportRaw.byteLength,
			reportSha256: sha256(reportRaw),
			measurementGitSha: gitSha,
			measurementTreeSha: treeSha,
			closureDigest: report.runner.closureDigest,
			worktreeFingerprint: report.runner.worktreeFingerprint,
			runtimeControlIdentity: report.runner.runtimeControlIdentity,
			telemetryBefore: telemetry(startedAt),
			telemetryAfter: telemetry(endedAt),
		});
		cursorMs += durationMs + 60_000;
	}
	const sealedAt = new Date(cursorMs).toISOString();
	const ledgerPayload: JsonObject = {
		schema: "gjc.perf-corpus-attempt-ledger/1",
		version: 1,
		complete: true,
		sealedAt,
		captureId,
		measurementGitSha: gitSha,
		measurementTreeSha: treeSha,
		closureDigest: expectedClosureDigest,
		worktreeFingerprint,
		runtimeControlIdentity: captureRuntimeControlIdentity,
		scheduleDigest,
		protocolDigest,
		host: {
			hostId,
			platform: "darwin",
			arch: "arm64",
			powerSource: "AC",
			powerMode: "performance",
		},
		attempts,
	};
	const ledgerRaw = await writeSealedJson(path.join(directory, "perf-corpus-attempt-ledger.json"), ledgerPayload);
	const manifestPayload: JsonObject = {
		schema: "gjc.perf-corpus-raw-manifest/1",
		version: 1,
		complete: true,
		sealedAt,
		captureId,
		measurementGitSha: gitSha,
		measurementTreeSha: treeSha,
		closureDigest: expectedClosureDigest,
		worktreeFingerprint,
		runtimeControlIdentity: captureRuntimeControlIdentity,
		scheduleDigest,
		protocolDigest,
		ledger: {
			filename: "perf-corpus-attempt-ledger.json",
			sizeBytes: ledgerRaw.byteLength,
			sha256: sha256(ledgerRaw),
		},
		reports: attempts.map(attempt => ({
			sequence: attempt.sequence!,
			attemptId: attempt.attemptId!,
			filename: attempt.reportFilename!,
			sizeBytes: attempt.reportSizeBytes!,
			sha256: attempt.reportSha256!,
		})),
	};
	const manifestRaw = await writeSealedJson(path.join(directory, "perf-corpus-raw-manifest.json"), manifestPayload);
	sealedDigestsByDirectory.set(path.resolve(directory), {
		attemptLedgerSha256: sha256(ledgerRaw),
		rawManifestSha256: sha256(manifestRaw),
	});
}

function telemetry(timestamp: string): JsonObject {
	return {
		timestamp,
		thermalState: { availability: "supported", value: "nominal" },
		memoryPressure: { availability: "supported", value: "normal" },
		loadAverage1m: { availability: "supported", value: 1 },
		freeMemoryBytes: { availability: "supported", value: 16 * 1024 * 1024 * 1024 },
	};
}

async function mutateReport(
	directory: string,
	filename: string,
	mutate: (report: SyntheticReportMutationSurface) => void,
): Promise<void> {
	const target = path.join(directory, filename);
	const report = JSON.parse(await fs.readFile(target, "utf8")) as SyntheticReportMutationSurface;
	mutate(report);
	await fs.writeFile(target, `${JSON.stringify(report)}\n`);
	await resealCorpus(directory);
}

async function mutateLedger(directory: string, mutate: (ledger: JsonObject) => void): Promise<void> {
	const target = path.join(directory, "perf-corpus-attempt-ledger.json");
	const ledger = JSON.parse(await fs.readFile(target, "utf8")) as JsonObject;
	mutate(ledger);
	await writeSealedJson(target, payloadWithoutSeal(ledger));
	await resealCorpus(directory);
}

async function mutateManifest(directory: string, mutate: (manifest: JsonObject) => void): Promise<void> {
	const target = path.join(directory, "perf-corpus-raw-manifest.json");
	const manifest = JSON.parse(await fs.readFile(target, "utf8")) as JsonObject;
	mutate(manifest);
	const raw = await writeSealedJson(target, payloadWithoutSeal(manifest));
	const current = sealedDigestsByDirectory.get(path.resolve(directory));
	if (!current) throw new Error("sealed corpus digest fixture is missing");
	sealedDigestsByDirectory.set(path.resolve(directory), {
		attemptLedgerSha256: current.attemptLedgerSha256,
		rawManifestSha256: sha256(raw),
	});
}

function invoke(
	inputDirectory: string,
	outputDirectory: string,
	options: {
		bundleDir?: string;
		cwd?: string;
		driverDigest?: string;
		preregistrationDigest?: string;
		pythonPath?: string;
		readOnlyAttestation?: string;
		expectedGitSha?: string;
		expectedTreeSha?: string;
		expectedClosureDigest?: string;
		expectedWorktreeFingerprint?: string;
		expectedRuntimeControlIdentity?: string;
		expectedCaptureId?: string;
		expectedScheduleDigest?: string;
		expectedProtocolDigest?: string;
	} = {},
) {
	const launcher = authenticatedLauncher;
	const sealedDigests = sealedDigestsByDirectory.get(path.resolve(inputDirectory));
	if (!sealedDigests) throw new Error(`sealed digests are unavailable for ${inputDirectory}`);
	chmodSync(inputDirectory, 0o555);
	let result: Bun.SyncSubprocess<"pipe", "pipe">;
	try {
		result = Bun.spawnSync(
			[
				"python3",
				"-S",
				"-c",
				[
					"def display(value): pass",
					launcher.code,
					"raise SystemExit(0 if completed['result']['evidenceStatus'] == 'SUFFICIENT_EVIDENCE' else 3)",
				].join("\n"),
			],
			{
				cwd: options.cwd,
				env: {
					...process.env,
					...(options.pythonPath === undefined ? {} : { PYTHONPATH: options.pythonPath }),
					GJC_PERF_CORPUS_BUNDLE_DIR: options.bundleDir ?? bundleDirectory,
					GJC_PERF_CORPUS_INPUT_DIR: inputDirectory,
					GJC_PERF_CORPUS_OUTPUT_DIR: outputDirectory,
					GJC_PERF_CORPUS_EXPECTED_GIT_SHA: options.expectedGitSha ?? gitSha,
					GJC_PERF_CORPUS_EXPECTED_TREE_SHA: options.expectedTreeSha ?? treeSha,
					GJC_PERF_CORPUS_EXPECTED_CLOSURE_DIGEST: options.expectedClosureDigest ?? expectedClosureDigest,
					GJC_PERF_CORPUS_EXPECTED_WORKTREE_FINGERPRINT:
						options.expectedWorktreeFingerprint ?? worktreeFingerprint,
					GJC_PERF_CORPUS_EXPECTED_RUNTIME_CONTROL_IDENTITY:
						options.expectedRuntimeControlIdentity ?? captureRuntimeControlIdentity,
					GJC_PERF_CORPUS_EXPECTED_CAPTURE_ID: options.expectedCaptureId ?? captureId,
					GJC_PERF_CORPUS_EXPECTED_SCHEDULE_DIGEST: options.expectedScheduleDigest ?? expectedScheduleDigest,
					GJC_PERF_CORPUS_EXPECTED_PROTOCOL_DIGEST: options.expectedProtocolDigest ?? expectedProtocolDigest,
					GJC_PERF_CORPUS_TEMPLATE_SHA256: launcher.templateSha256,
					GJC_PERF_CORPUS_DRIVER_SHA256: options.driverDigest ?? driverSha256,
					GJC_PERF_CORPUS_PREREGISTRATION_SHA256: options.preregistrationDigest ?? preregistrationSha256,
					GJC_PERF_CORPUS_ATTEMPT_LEDGER_SHA256: sealedDigests.attemptLedgerSha256,
					GJC_PERF_CORPUS_RAW_MANIFEST_SHA256: sealedDigests.rawManifestSha256,
					GJC_PERF_CORPUS_INPUT_MOUNT_READ_ONLY: options.readOnlyAttestation ?? launcher.immutableMountAttestation,
				},
			},
		);
	} finally {
		chmodSync(inputDirectory, 0o755);
	}
	return {
		exitCode: result!.exitCode,
		stdout: decoder.decode(result!.stdout),
		stderr: decoder.decode(result!.stderr),
	};
}

async function readResult(outputDirectory: string): Promise<ValidationResult> {
	return JSON.parse(
		await fs.readFile(path.join(outputDirectory, "perf-corpus-rlm-result.json"), "utf8"),
	) as ValidationResult;
}
async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

function validationCodes(result: ValidationResult): string[] {
	return result.diagnostics.validationErrors.map(item => item.code);
}

beforeAll(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-perf-corpus-rlm-"));
	const [driverBytes, preregistrationBytes, launcher] = await Promise.all([
		fs.readFile(driverPath),
		fs.readFile(preregistrationPath),
		loadAuthenticatedLauncher(templatePath),
	]);
	driverSha256 = sha256(driverBytes);
	preregistrationSha256 = sha256(preregistrationBytes);
	preregistration = JSON.parse(preregistrationBytes.toString("utf8"));
	expectedClosureDigest = sha256(`packages/coding-agent/bench/perf-corpus.bench.ts:${"a".repeat(64)}\n`);
	expectedScheduleDigest = canonicalDigest(preregistration.captureControls.schedule);
	const preregistrationRecord = preregistration as unknown as JsonObject;
	expectedProtocolDigest = canonicalDigest(
		Object.fromEntries(
			preregistration.sealedInputContract.protocolDigestFields.map(field => [field, preregistrationRecord[field]]),
		),
	);
	authenticatedLauncher = launcher;
});

afterAll(async () => {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("trusted perf-corpus RLM analysis driver", () => {
	test("admits the real producer provenance contract through Python replay", async () => {
		const input = path.join(temporaryRoot, "producer-contract-input");
		const output = path.join(temporaryRoot, "producer-contract-output");
		const surfaceOrder = preregistration.captureControls.admissionRows.short[0]!.surfaceOrder;
		const previousEnvironment = {
			profile: process.env.GJC_MEMORY_PROFILE,
			duration: process.env.GJC_MEMORY_DURATION_MS,
			iterations: process.env.GJC_MEMORY_ITERATIONS,
			surfaceOrder: process.env.GJC_MEMORY_SURFACE_ORDER,
		};
		let report: PerfCorpusReport;
		try {
			process.env.GJC_MEMORY_PROFILE = "short";
			delete process.env.GJC_MEMORY_DURATION_MS;
			process.env.GJC_MEMORY_ITERATIONS = String(preregistration.cohort.profiles.short.iterationsTarget);
			process.env.GJC_MEMORY_SURFACE_ORDER = surfaceOrder.join(",");
			report = runPerfCorpusBenchmark();
		} finally {
			if (previousEnvironment.profile === undefined) delete process.env.GJC_MEMORY_PROFILE;
			else process.env.GJC_MEMORY_PROFILE = previousEnvironment.profile;
			if (previousEnvironment.duration === undefined) delete process.env.GJC_MEMORY_DURATION_MS;
			else process.env.GJC_MEMORY_DURATION_MS = previousEnvironment.duration;
			if (previousEnvironment.iterations === undefined) delete process.env.GJC_MEMORY_ITERATIONS;
			else process.env.GJC_MEMORY_ITERATIONS = previousEnvironment.iterations;
			if (previousEnvironment.surfaceOrder === undefined) delete process.env.GJC_MEMORY_SURFACE_ORDER;
			else process.env.GJC_MEMORY_SURFACE_ORDER = previousEnvironment.surfaceOrder;
		}

		const baselines = report.fixtures.flatMap(fixture =>
			fixture.memoryBaseline === undefined ? [] : [fixture.memoryBaseline],
		);
		expect(baselines).toHaveLength(surfaceOrder.length);
		expect(baselines.every(baseline => baseline.captureSemanticsId === MEMORY_CAPTURE_SEMANTICS_ID)).toBe(true);
		expect(report.runner.closureDigest).toBe(sha256(`${report.runner.closureManifest.join("\n")}\n`));
		expect(report.runner.runtimeControlIdentity).toBe(memoryRuntimeControlIdentity(report.runner));

		// Replay the REAL runner provenance block over the deterministic synthetic body. The real
		// short-profile measurement payload (periodicSamples/extrema/slopes/sampling/postTeardown) is
		// host- and timing-dependent, and the driver enforces preregistered sample-count, elapsed-duration,
		// and timestamp-separation bounds that a variable-speed CI runner cannot be guaranteed to meet.
		// So provenance crosses the Python boundary for real while the payload stays synthetic; the real
		// report's own invariants are asserted directly above and below this graft.
		await writeCorpus(input);
		const replayReport = JSON.parse(await fs.readFile(path.join(input, "short-01.json"), "utf8")) as PerfCorpusReport;
		// The graft is only valid while the synthetic short-01 fixture and the real bench run agree on
		// surface order; assert that correspondence before overwriting it, so a preregistration schedule
		// change fails here instead of as an opaque ordinal error inside the driver.
		expect(replayReport.runner.memorySurfaceOrder).toEqual(report.runner.memorySurfaceOrder);
		replayReport.gitSha = report.gitSha;
		replayReport.gitDirty = false;
		replayReport.runner = structuredClone(report.runner);
		replayReport.fixtures.forEach((fixture, index) => {
			if (fixture.memoryBaseline === undefined) return;
			fixture.memoryBaseline.parentPid = report.runner.runnerPid;
			fixture.memoryBaseline.childPid = report.runner.runnerPid + index + 1;
		});
		expect(replayReport.runner.bunExecutable).toBe("bun");
		expect(replayReport.runner.argv[0]).toBe("bun");
		expect(replayReport.runner.command).toBe(replayReport.runner.argv.join(" "));
		expect(JSON.stringify(replayReport)).not.toContain(path.resolve(import.meta.dir, "../../.."));
		expect(JSON.stringify(replayReport)).not.toContain(process.execPath);
		await fs.writeFile(path.join(input, "short-01.json"), `${JSON.stringify(replayReport)}\n`);
		for (const entry of await fs.readdir(input)) {
			if (entry.endsWith(".json") && entry !== "short-01.json" && !entry.startsWith("perf-corpus-")) {
				await fs.unlink(path.join(input, entry));
			}
		}
		await mutateLedger(input, ledger => {
			ledger.attempts = (ledger.attempts as JsonObject[]).filter(
				attempt => attempt.reportFilename === "short-01.json",
			);
			ledger.measurementGitSha = report.gitSha;
			ledger.closureDigest = report.runner.closureDigest;
			ledger.worktreeFingerprint = report.runner.worktreeFingerprint;
			(ledger.host as JsonObject).platform = report.runner.platform;
			(ledger.host as JsonObject).arch = report.runner.arch;
			for (const attempt of ledger.attempts as JsonObject[]) {
				attempt.sequence = 1;
				attempt.cooldownAfterPreviousSeconds = 0;
				attempt.measurementGitSha = report.gitSha;
				attempt.closureDigest = report.runner.closureDigest;
				attempt.worktreeFingerprint = report.runner.worktreeFingerprint;
				attempt.platform = report.runner.platform;
				attempt.arch = report.runner.arch;
			}
		});
		expect(
			invoke(input, output, {
				expectedGitSha: report.gitSha,
				expectedClosureDigest: report.runner.closureDigest,
				expectedWorktreeFingerprint: report.runner.worktreeFingerprint,
			}).exitCode,
		).toBe(3);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors.filter(error => error.filename === "short-01.json")).toEqual([]);
		expect(result.admission.short.admittedBlocks).toBeGreaterThanOrEqual(1);
	});

	type PrivateRunnerCase = readonly [string, (runner: PerfCorpusReport["runner"]) => void, string];
	const invalidRunnerArgvCase = (name: string, argv: string[]): PrivateRunnerCase => [
		name,
		runner => {
			runner.argv = argv;
			runner.command = runner.argv.join(" ");
			runner.runtimeCommand = runner.command;
		},
		"runner.argv must begin with bun and contain only logical repository-relative values",
	];
	const privateRunnerCases: readonly PrivateRunnerCase[] = [
		[
			"command",
			runner => {
				runner.command = "bun /private/tmp/checkout/packages/coding-agent/bench/perf-corpus.bench.ts";
				runner.runtimeCommand = runner.command;
			},
			"runner.command must exactly match the logical runner.argv",
		],
		[
			"argv",
			runner => {
				runner.argv = ["bun", "/private/tmp/checkout/packages/coding-agent/bench/perf-corpus.bench.ts"];
			},
			"runner.argv must begin with bun and contain only logical repository-relative values",
		],
		[
			"bunExecutable",
			runner => {
				runner.bunExecutable = "/private/tmp/runtime/bin/bun";
			},
			'bunExecutable must be the logical identifier "bun"',
		],
		[
			"traversal argv",
			runner => {
				runner.argv = ["bun", "packages/../private/perf-corpus.bench.ts"];
				runner.command = runner.argv.join(" ");
				runner.runtimeCommand = runner.command;
			},
			"runner.argv must begin with bun and contain only logical repository-relative values",
		],
		[
			"backslash argv",
			runner => {
				runner.argv = ["bun", "packages\\coding-agent\\bench\\perf-corpus.bench.ts"];
				runner.command = runner.argv.join(" ");
				runner.runtimeCommand = runner.command;
			},
			"runner.argv must begin with bun and contain only logical repository-relative values",
		],
		[
			"file URI argv",
			runner => {
				runner.argv = ["bun", "file:///private/tmp/perf-corpus.bench.ts"];
				runner.command = runner.argv.join(" ");
				runner.runtimeCommand = runner.command;
			},
			"runner.argv must begin with bun and contain only logical repository-relative values",
		],
		[
			"embedded absolute argv",
			runner => {
				runner.argv = ["bun", "label,/private/tmp/perf-corpus.bench.ts"];
				runner.command = runner.argv.join(" ");
				runner.runtimeCommand = runner.command;
			},
			"runner.argv must begin with bun and contain only logical repository-relative values",
		],
		invalidRunnerArgvCase("home argv", ["bun", "~/private/perf-corpus.bench.ts"]),
		invalidRunnerArgvCase("drive argv", ["bun", "C:/private/perf-corpus.bench.ts"]),
		invalidRunnerArgvCase("parenthesized absolute argv", ["bun", "label(/private/tmp/perf-corpus.bench.ts)"]),
		invalidRunnerArgvCase("bracketed absolute argv", ["bun", "label[/private/tmp/perf-corpus.bench.ts]"]),
		invalidRunnerArgvCase("punctuation absolute argv", ["bun", "label|/private/tmp/perf-corpus.bench.ts"]),
		...["\n", "\r", "\u2028", "\u2029"].flatMap(terminator => [
			invalidRunnerArgvCase(`script terminator ${terminator.codePointAt(0)!.toString(16)}`, [
				"bun",
				`packages/coding-agent/bench/perf-corpus.bench.ts${terminator}`,
			]),
			invalidRunnerArgvCase(`flag terminator ${terminator.codePointAt(0)!.toString(16)}`, [
				"bun",
				`--smol${terminator}`,
				"packages/coding-agent/bench/perf-corpus.bench.ts",
			]),
		]),
		invalidRunnerArgvCase("eval flag", ["bun", "--eval", "packages/coding-agent/bench/perf-corpus.bench.ts"]),
		invalidRunnerArgvCase("unknown flag", ["bun", "--evil", "packages/coding-agent/bench/perf-corpus.bench.ts"]),
		invalidRunnerArgvCase("alternate script", [
			"bun",
			"packages/coding-agent/bench/memory-baseline-session-child.ts",
		]),
		invalidRunnerArgvCase("post-script flag", ["bun", "packages/coding-agent/bench/perf-corpus.bench.ts", "--smol"]),
		invalidRunnerArgvCase("duplicate smol flag", [
			"bun",
			"--smol",
			"--smol",
			"packages/coding-agent/bench/perf-corpus.bench.ts",
		]),
		invalidRunnerArgvCase("duplicate expose-gc flag", [
			"bun",
			"--expose-gc",
			"--expose-gc",
			"packages/coding-agent/bench/perf-corpus.bench.ts",
		]),
		invalidRunnerArgvCase("reversed flags", [
			"bun",
			"--expose-gc",
			"--smol",
			"packages/coding-agent/bench/perf-corpus.bench.ts",
		]),
	];

	test.each(
		privateRunnerCases,
	)("rejects a host-private runner %s before admission", async (name, mutate, expectedMessage) => {
		const input = path.join(temporaryRoot, `private-runner-${name}-input`);
		const output = path.join(temporaryRoot, `private-runner-${name}-output`);
		await writeCorpus(input, () => 100_000, ["short-01"]);
		let runtimeControlIdentity = "";
		await mutateReport(input, "short-01.json", report => {
			mutate(report.runner);
			report.runner.runtimeControlIdentity = memoryRuntimeControlIdentity(report.runner);
			runtimeControlIdentity = report.runner.runtimeControlIdentity;
		});
		await mutateLedger(input, ledger => {
			const attempt = (ledger.attempts as JsonObject[]).find(item => item.reportFilename === "short-01.json");
			if (!attempt) throw new Error("short-01 ledger attempt unavailable");
			attempt.runtimeControlIdentity = runtimeControlIdentity;
		});

		expect(invoke(input, output).exitCode).toBe(0);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({ filename: "short-01.json", message: expect.stringContaining(expectedMessage) }),
		);
		expect(result.admission.short.invalidBlocks).toBe(1);
		expect(result.admissionTraceability.some(item => item.attemptId === "short-01")).toBe(false);
	});

	test("fails closed when Git checkout provenance is unavailable", () => {
		const spawnSync = vi.spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("git unavailable");
		});
		try {
			expect(() => resolveGitProvenance()).toThrow("git HEAD provenance unavailable");
		} finally {
			spawnSync.mockRestore();
		}
	});
	test("emits byte-identical canonical 10,000-resample results for the sealed all-positive cohort", async () => {
		const input = path.join(temporaryRoot, "deterministic-input");
		const firstOutput = path.join(temporaryRoot, "deterministic-output-a");
		const secondOutput = path.join(temporaryRoot, "deterministic-output-b");
		await writeCorpus(input);
		const first = invoke(input, firstOutput);
		const second = invoke(input, secondOutput);
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(await fs.readFile(path.join(firstOutput, "perf-corpus-rlm-result.json"), "utf8")).toBe(
			await fs.readFile(path.join(secondOutput, "perf-corpus-rlm-result.json"), "utf8"),
		);
		const result = await readResult(firstOutput);
		expect(result.evidenceStatus).toBe("SUFFICIENT_EVIDENCE");
		expect(result.actionDecision).toBe("ACTION");
		expect(result.actionAnalysis.surfaces.tui.primaryBca.resamples).toBe(10_000);
		expect(result.hashBindings).toMatchObject({
			driverSha256,
			preregistrationSha256,
			templateSha256: expectedTemplateSha256,
		});
		expect(result.cohort?.sharedRunnerProvenance).toMatchObject({
			runtimeCommand: "bun packages/coding-agent/bench/perf-corpus.bench.ts",
			bunVersion: "1.3.14",
			bunExecutable: "bun",
			bunExecutableSha256: "b".repeat(64),
			worktreeFingerprint: "c".repeat(64),
		});
		const sealedDigests = sealedDigestsByDirectory.get(path.resolve(input));
		expect(sealedDigests).toBeDefined();
		expect(result.hashBindings).toMatchObject(sealedDigests!);
		expect(result.hashBindings.orderedReportHashes).toHaveLength(29);
		expect(result.admissionTraceability).toHaveLength(29);
		expect(result.admissionTraceability.map(item => item.sha256)).toEqual(
			result.hashBindings.orderedReportHashes.map(item => item.sha256),
		);
		expect(result.admission.short).toMatchObject({
			admittedBlocks: 5,
			invalidBlocks: 0,
			notEvaluatedBlocks: 0,
			excludedBlocks: 0,
		});
		expect(result.admission.soak).toMatchObject({
			admittedBlocks: 24,
			invalidBlocks: 0,
			notEvaluatedBlocks: 0,
			excludedBlocks: 0,
		});
		expect(result.claimPolicy.p95).toMatchObject({
			status: "OMITTED_IMPOSSIBLE",
			finiteUpperEndpointAvailable: false,
			empiricalP95Emitted: false,
		});
	});

	test("rejects reversed chronology, overlap, and cooldown below 60 seconds in the sealed ledger", async () => {
		for (const [name, mutate] of [
			[
				"reversed-order",
				(ledger: JsonObject) => {
					ledger.attempts = [...(ledger.attempts as JsonObject[])].reverse();
				},
			],
			[
				"overlap",
				(ledger: JsonObject) => {
					const attempts = ledger.attempts as JsonObject[];
					attempts[1]!.startedAt = attempts[0]!.startedAt!;
					attempts[1]!.cooldownAfterPreviousSeconds = 0;
				},
			],
			[
				"short-cooldown",
				(ledger: JsonObject) => {
					const attempts = ledger.attempts as JsonObject[];
					const priorEnd = Date.parse(attempts[0]!.endedAt as string);
					const startedAt = new Date(priorEnd + 59_000).toISOString();
					const endedAt = new Date(priorEnd + 60_000).toISOString();
					attempts[1]!.startedAt = startedAt;
					attempts[1]!.endedAt = endedAt;
					attempts[1]!.cooldownAfterPreviousSeconds = 59;
					attempts[1]!.telemetryBefore = telemetry(startedAt);
					attempts[1]!.telemetryAfter = telemetry(endedAt);
				},
			],
		] as const) {
			const input = path.join(temporaryRoot, `sealed-${name}-input`);
			const output = path.join(temporaryRoot, `sealed-${name}-output`);
			await writeCorpus(input);
			await mutateLedger(input, mutate);
			expect(invoke(input, output).exitCode).toBe(3);
			expect(validationCodes(await readResult(output))).toContain("SEALED_INPUT_INVALID");
		}
	});
	test("applies one-sided upward ambient load drift while retaining absolute and free-memory controls", async () => {
		const lowerLaterInput = path.join(temporaryRoot, "lower-later-load-input");
		const lowerLaterOutput = path.join(temporaryRoot, "lower-later-load-output");
		await writeCorpus(lowerLaterInput);
		await mutateLedger(lowerLaterInput, ledger => {
			const attempts = ledger.attempts as JsonObject[];
			((attempts[0]!.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 2.5;
			((attempts[1]!.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 0.25;
		});
		expect(invoke(lowerLaterInput, lowerLaterOutput).exitCode).toBe(0);
		expect((await readResult(lowerLaterOutput)).evidenceStatus).toBe("SUFFICIENT_EVIDENCE");

		const exactIncreaseInput = path.join(temporaryRoot, "exact-upward-load-drift-input");
		const exactIncreaseOutput = path.join(temporaryRoot, "exact-upward-load-drift-output");
		await writeCorpus(exactIncreaseInput);
		await mutateLedger(exactIncreaseInput, ledger => {
			const attempts = ledger.attempts as JsonObject[];
			((attempts[0]!.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 1.2;
			((attempts[1]!.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 2.2;
		});
		expect(invoke(exactIncreaseInput, exactIncreaseOutput).exitCode).toBe(0);
		expect((await readResult(exactIncreaseOutput)).evidenceStatus).toBe("SUFFICIENT_EVIDENCE");

		const excessiveIncreaseInput = path.join(temporaryRoot, "excessive-upward-load-drift-input");
		const excessiveIncreaseOutput = path.join(temporaryRoot, "excessive-upward-load-drift-output");
		await writeCorpus(excessiveIncreaseInput);
		await mutateLedger(excessiveIncreaseInput, ledger => {
			const attempts = ledger.attempts as JsonObject[];
			((attempts[0]!.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 1.2;
			((attempts[1]!.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 2.200001;
		});
		expect(invoke(excessiveIncreaseInput, excessiveIncreaseOutput).exitCode).toBe(3);
		expect((await readResult(excessiveIncreaseOutput)).diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "SEALED_INPUT_INVALID",
				message: expect.stringContaining("telemetryBefore.loadAverage1m ambient drift"),
			}),
		);

		const absoluteAfterInput = path.join(temporaryRoot, "absolute-after-load-input");
		const absoluteAfterOutput = path.join(temporaryRoot, "absolute-after-load-output");
		await writeCorpus(absoluteAfterInput);
		await mutateLedger(absoluteAfterInput, ledger => {
			const attempt = (ledger.attempts as JsonObject[])[0]!;
			((attempt.telemetryAfter as JsonObject).loadAverage1m as JsonObject).value = 4.01;
		});
		expect(invoke(absoluteAfterInput, absoluteAfterOutput).exitCode).toBe(3);
		expect((await readResult(absoluteAfterOutput)).diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "SEALED_INPUT_INVALID",
				message: expect.stringContaining("telemetryAfter.loadAverage1m exceeds bound"),
			}),
		);

		const afterFreeMemoryDriftInput = path.join(temporaryRoot, "after-free-memory-drift-input");
		const afterFreeMemoryDriftOutput = path.join(temporaryRoot, "after-free-memory-drift-output");
		await writeCorpus(afterFreeMemoryDriftInput);
		await mutateLedger(afterFreeMemoryDriftInput, ledger => {
			const attempt = (ledger.attempts as JsonObject[])[0]!;
			((attempt.telemetryAfter as JsonObject).freeMemoryBytes as JsonObject).value = 8 * 1024 * 1024 * 1024;
		});
		expect(invoke(afterFreeMemoryDriftInput, afterFreeMemoryDriftOutput).exitCode).toBe(3);
		expect((await readResult(afterFreeMemoryDriftOutput)).diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "SEALED_INPUT_INVALID",
				message: expect.stringContaining("freeMemoryBytes telemetry drift"),
			}),
		);

		const withinAttemptRiseInput = path.join(temporaryRoot, "within-attempt-load-rise-input");
		const withinAttemptRiseOutput = path.join(temporaryRoot, "within-attempt-load-rise-output");
		await writeCorpus(withinAttemptRiseInput);
		await mutateLedger(withinAttemptRiseInput, ledger => {
			const attempt = (ledger.attempts as JsonObject[])[0]!;
			((attempt.telemetryBefore as JsonObject).loadAverage1m as JsonObject).value = 1.54;
			((attempt.telemetryAfter as JsonObject).loadAverage1m as JsonObject).value = 2.71;
		});
		expect(invoke(withinAttemptRiseInput, withinAttemptRiseOutput).exitCode).toBe(0);
		const withinAttemptRiseResult = await readResult(withinAttemptRiseOutput);
		expect(withinAttemptRiseResult.evidenceStatus).toBe("SUFFICIENT_EVIDENCE");
		expect(withinAttemptRiseResult.diagnostics.attemptTelemetry?.[0]).toMatchObject({
			telemetryBefore: { loadAverage1m: { availability: "supported", value: 1.54 } },
			telemetryAfter: { loadAverage1m: { availability: "supported", value: 2.71 } },
		});
	});

	test("rejects host, power, thermal, interruption, and process-closure drift", async () => {
		for (const [name, mutate] of [
			["host", (ledger: JsonObject) => ((ledger.host as JsonObject).hostId = "2".repeat(64))],
			["power", (ledger: JsonObject) => ((ledger.host as JsonObject).powerSource = "battery")],
			[
				"thermal-critical",
				(ledger: JsonObject) => {
					const attempt = (ledger.attempts as JsonObject[])[0]!;
					const before = attempt.telemetryBefore as JsonObject;
					(before.thermalState as JsonObject).value = "critical";
				},
			],
			[
				"telemetry-unavailable",
				(ledger: JsonObject) => {
					const attempt = (ledger.attempts as JsonObject[])[0]!;
					const before = attempt.telemetryBefore as JsonObject;
					(before.memoryPressure as JsonObject).availability = "unavailable";
					(before.memoryPressure as JsonObject).value = null;
				},
			],
			["interruption", (ledger: JsonObject) => ((ledger.attempts as JsonObject[])[0]!.interrupted = true)],
			["process-leak", (ledger: JsonObject) => ((ledger.attempts as JsonObject[])[0]!.childrenClosed = false)],
		] as const) {
			const input = path.join(temporaryRoot, `control-${name}-input`);
			const output = path.join(temporaryRoot, `control-${name}-output`);
			await writeCorpus(input);
			await mutateLedger(input, mutate);
			expect(invoke(input, output).exitCode).toBe(3);
			expect(validationCodes(await readResult(output))).toContain("SEALED_INPUT_INVALID");
		}
	});

	test("rejects report/ledger host platform and arch binding drift", async () => {
		// The driver raises both messages from one loop, but recovers the finding code from message
		// text: it matches "platform"/"architecture", so `arch` drift falls through to
		// REPORT_VALIDATION_FAILED instead of PLATFORM_DRIFT. That asymmetry is a driver defect, and
		// the driver is SHA-256-bound into every publication receipt, so it cannot be corrected here.
		// These expectations pin the observed codes so a classifier change is caught rather than
		// silently absorbed; they record current behavior and do not endorse the split.
		for (const [field, ledgerValue, expectedCode] of [
			["platform", "linux", "PLATFORM_DRIFT"],
			["arch", "x64", "REPORT_VALIDATION_FAILED"],
		] as const) {
			const input = path.join(temporaryRoot, `host-binding-${field}-input`);
			const output = path.join(temporaryRoot, `host-binding-${field}-output`);
			await writeCorpus(input);
			// Keep ledger host and every attempt internally consistent so the earlier host/power
			// equality gate still passes; only the report/ledger binding may disagree.
			await mutateLedger(input, ledger => {
				(ledger.host as JsonObject)[field] = ledgerValue;
				for (const attempt of ledger.attempts as JsonObject[]) attempt[field] = ledgerValue;
			});
			expect(invoke(input, output).exitCode).toBe(3);
			const result = await readResult(output);
			expect(result.diagnostics.validationErrors).toContainEqual(
				expect.objectContaining({
					code: expectedCode,
					message: `short-01.json: report/ledger host ${field} binding mismatch`,
				}),
			);
			expect(result.admission.short.admittedBlocks).toBe(0);
			expect(result.admission.soak.admittedBlocks).toBe(0);
		}
	});

	test("rejects raw report byte mismatch as a sealed-input failure and missing or extra manifest entries", async () => {
		const reportInput = path.join(temporaryRoot, "report-binding-input");
		const reportOutput = path.join(temporaryRoot, "report-binding-output");
		await writeCorpus(reportInput);
		await fs.appendFile(path.join(reportInput, "soak-01.json"), " ");
		expect(invoke(reportInput, reportOutput).exitCode).toBe(3);
		expect(validationCodes(await readResult(reportOutput))).toContain("SEALED_INPUT_INVALID");

		for (const [name, mutate] of [
			["missing", (manifest: JsonObject) => (manifest.reports as JsonObject[]).pop()],
			[
				"extra",
				(manifest: JsonObject) =>
					(manifest.reports as JsonObject[]).push({
						sequence: 999,
						attemptId: "soak-30",
						filename: "soak-30.json",
						sizeBytes: 1,
						sha256: "0".repeat(64),
					}),
			],
		] as const) {
			const input = path.join(temporaryRoot, `manifest-${name}-input`);
			const output = path.join(temporaryRoot, `manifest-${name}-output`);
			await writeCorpus(input);
			await mutateManifest(input, mutate);
			expect(invoke(input, output).exitCode).toBe(3);
			expect(validationCodes(await readResult(output))).toContain("SEALED_INPUT_INVALID");
		}
	});

	test("does not let a valid frozen replacement mask an earlier sealed report byte mismatch", async () => {
		const input = path.join(temporaryRoot, "tampered-replacement-input");
		const output = path.join(temporaryRoot, "tampered-replacement-output");
		await writeCorpus(input, () => 100_000, ["short-01"]);
		await mutateReport(input, "short-01.json", report => {
			report.gitDirty = true;
		});
		await fs.appendFile(path.join(input, "short-01.json"), " ");

		expect(await pathExists(path.join(input, "short-02.json"))).toBe(true);
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual([
			expect.objectContaining({
				code: "SEALED_INPUT_INVALID",
				message: "short-01.json: report filename/size/SHA-256 binding mismatch",
			}),
		]);
		expect(result.admission.short).toMatchObject({
			attemptsObserved: 0,
			admittedBlocks: 0,
			invalidBlocks: 0,
		});
		expect(result.admissionTraceability).toEqual([]);
	});

	test("rejects authenticated M/tree/C/fingerprint/control binding drift", async () => {
		for (const [name, options] of [
			["measurement", { expectedGitSha: "a".repeat(40) }],
			["tree", { expectedTreeSha: "a".repeat(40) }],
			["closure", { expectedClosureDigest: "a".repeat(64) }],
			["fingerprint", { expectedWorktreeFingerprint: "a".repeat(64) }],
			["control", { expectedRuntimeControlIdentity: "a".repeat(64) }],
		] as const) {
			const input = path.join(temporaryRoot, `binding-${name}-input`);
			const output = path.join(temporaryRoot, `binding-${name}-output`);
			await writeCorpus(input);
			expect(invoke(input, output, options).exitCode).toBe(3);
			expect(validationCodes(await readResult(output))).toContain("SEALED_INPUT_INVALID");
		}
	});

	test("rejects nested private/provider fields and authenticated preregistration policy drift", async () => {
		const privateInput = path.join(temporaryRoot, "nested-private-input");
		const privateOutput = path.join(temporaryRoot, "nested-private-output");
		await writeCorpus(privateInput, () => 100_000, ["short-01"]);
		await mutateReport(privateInput, "short-01.json", report => {
			report.fixtures[0]!.privacy.providerPayload = "forbidden";
		});
		expect(invoke(privateInput, privateOutput).exitCode).toBe(0);
		const privateResult = await readResult(privateOutput);
		expect(privateResult.diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({ code: "PRIVACY_TAXONOMY_INVALID", filename: "short-01.json" }),
		);

		const policyInput = path.join(temporaryRoot, "policy-drift-input");
		const policyOutput = path.join(temporaryRoot, "policy-drift-output");
		const policyBundle = path.join(temporaryRoot, "policy-drift-bundle");
		await writeCorpus(policyInput);
		await fs.mkdir(policyBundle);
		const policy = JSON.parse(await fs.readFile(preregistrationPath, "utf8")) as JsonObject;
		const analysis = policy.analysis as JsonObject;
		const actionFamily = analysis.actionFamily as JsonObject;
		const bootstrap = actionFamily.bootstrap as JsonObject;
		bootstrap.resamples = 9_999;
		const policyBytes = `${JSON.stringify(policy, null, 2)}\n`;
		await Promise.all([
			fs.copyFile(driverPath, path.join(policyBundle, path.basename(driverPath))),
			fs.writeFile(path.join(policyBundle, path.basename(preregistrationPath)), policyBytes),
		]);
		const policyInvocation = invoke(policyInput, policyOutput, {
			bundleDir: policyBundle,
			preregistrationDigest: sha256(policyBytes),
		});
		expect(policyInvocation.exitCode).not.toBe(0);
		expect(policyInvocation.stderr).toContain("authenticated preregistration policy drift");
		expect(await pathExists(policyOutput)).toBe(false);
	});

	test("rejects malformed nested hotspot and threshold-ledger containers", async () => {
		const input = path.join(temporaryRoot, "nested-container-input");
		const output = path.join(temporaryRoot, "nested-container-output");
		await writeCorpus(input, () => 100_000, ["short-01", "short-02"]);
		await mutateReport(input, "short-01.json", report => {
			report.hotspotClassifications = [
				{
					hotspotId: "M01",
					status: "covered-current",
					evidenceClass: "rss-memory",
					artifactRefs: [],
					notes: "synthetic",
					unexpected: true,
				},
			];
		});
		await mutateReport(input, "short-02.json", report => {
			report.thresholdLedger = [{ name: "memory", advisoryOrEnforced: 1 }];
		});
		expect(invoke(input, output).exitCode).toBe(0);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ filename: "short-01.json", code: "REPORT_VALIDATION_FAILED" }),
				expect.objectContaining({ filename: "short-02.json", code: "REPORT_VALIDATION_FAILED" }),
			]),
		);
	});

	test("reuses each fixed admission slot after an invalid preallocated attempt", async () => {
		const input = path.join(temporaryRoot, "replacement-input");
		const output = path.join(temporaryRoot, "replacement-output");
		await writeCorpus(input, () => 100_000, ["short-01", "soak-01"]);
		await Promise.all(
			["short-01.json", "soak-01.json"].map(filename =>
				mutateReport(input, filename, report => {
					report.gitDirty = true;
				}),
			),
		);
		expect(invoke(input, output).exitCode).toBe(0);
		const result = await readResult(output);
		expect(result.admission.short).toMatchObject({
			attemptsObserved: 6,
			admittedBlocks: 5,
			invalidBlocks: 1,
			notEvaluatedBlocks: 0,
		});
		expect(result.admission.soak).toMatchObject({
			attemptsObserved: 25,
			admittedBlocks: 24,
			invalidBlocks: 1,
			notEvaluatedBlocks: 0,
		});
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ attemptId: "short-01", blockId: "short-slot-01" }),
				expect.objectContaining({ attemptId: "soak-01", blockId: "soak-slot-01" }),
			]),
		);
		expect(result.diagnostics.validatedAttemptOrder).toEqual(
			expect.arrayContaining(["short-02", "short-06", "soak-02", "soak-25"]),
		);
		expect(result.runLevelPointsByProfileAndSurface?.short.cli).toEqual(
			expect.arrayContaining([expect.objectContaining({ attemptId: "short-02", blockId: "short-slot-01" })]),
		);
		expect(result.runLevelPointsByProfileAndSurface?.soak.cli).toEqual(
			expect.arrayContaining([expect.objectContaining({ attemptId: "soak-02", blockId: "soak-slot-01" })]),
		);
	});
	test("fails closed when an authenticated report is mutated in place with its mtime restored after byte capture", async () => {
		const input = path.join(temporaryRoot, "post-capture-drift-input");
		const output = path.join(temporaryRoot, "post-capture-drift-output");
		await writeCorpus(input);
		const sealedDigests = sealedDigestsByDirectory.get(path.resolve(input));
		if (!sealedDigests) throw new Error("sealed digests are unavailable for post-capture drift test");
		const harness = [
			"import importlib.util, json, os, pathlib, sys",
			"spec = importlib.util.spec_from_file_location('analysis', os.environ['DRIVER'])",
			"module = importlib.util.module_from_spec(spec)",
			"sys.modules['analysis'] = module",
			"spec.loader.exec_module(module)",
			"original = module._validate_sealed_inputs",
			"def capture_then_mutate_in_place(*args):",
			"    captured = original(*args)",
			"    report = pathlib.Path(os.environ['INPUT']) / 'short-01.json'",
			"    original_stat = report.stat()",
			"    with report.open('r+b') as handle:",
			"        first = handle.read(1)",
			"        handle.seek(0)",
			"        handle.write(b' ' if first != b' ' else b'\\t')",
			"        handle.flush()",
			"        os.fsync(handle.fileno())",
			"    os.utime(report, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))",
			"    if report.stat().st_ctime_ns == original_stat.st_ctime_ns:",
			"        raise RuntimeError('in-place mutation did not update ctime_ns')",
			"    return captured",
			"module._validate_sealed_inputs = capture_then_mutate_in_place",
			"result = module.run_analysis(",
			"    os.environ['INPUT'], os.environ['OUTPUT'], pathlib.Path(os.environ['PREREG']).read_bytes(),",
			"    os.environ['GIT_SHA'], os.environ['TREE_SHA'], os.environ['CLOSURE_DIGEST'],",
			"    os.environ['WORKTREE_FINGERPRINT'], os.environ['CONTROL_IDENTITY'], os.environ['CAPTURE_ID'],",
			"    os.environ['SCHEDULE_DIGEST'], os.environ['PROTOCOL_DIGEST'], os.environ['DRIVER_DIGEST'],",
			"    os.environ['PREREG_DIGEST'], os.environ['TEMPLATE_DIGEST'], os.environ['LEDGER_DIGEST'],",
			"    os.environ['MANIFEST_DIGEST'],",
			")",
			"print(json.dumps(result['result']))",
		].join("\n");
		const subprocess = Bun.spawnSync(["python3", "-S", "-c", harness], {
			env: {
				...process.env,
				DRIVER: driverPath,
				INPUT: input,
				OUTPUT: output,
				PREREG: preregistrationPath,
				GIT_SHA: gitSha,
				TREE_SHA: treeSha,
				CLOSURE_DIGEST: expectedClosureDigest,
				WORKTREE_FINGERPRINT: worktreeFingerprint,
				CONTROL_IDENTITY: captureRuntimeControlIdentity,
				CAPTURE_ID: captureId,
				SCHEDULE_DIGEST: expectedScheduleDigest,
				PROTOCOL_DIGEST: expectedProtocolDigest,
				DRIVER_DIGEST: driverSha256,
				PREREG_DIGEST: preregistrationSha256,
				TEMPLATE_DIGEST: expectedTemplateSha256,
				LEDGER_DIGEST: sealedDigests.attemptLedgerSha256,
				MANIFEST_DIGEST: sealedDigests.rawManifestSha256,
			},
		});
		expect(subprocess.exitCode).toBe(0);
		const result = JSON.parse(decoder.decode(subprocess.stdout)) as ValidationResult;
		expect(result.evidenceStatus).toBe("INSUFFICIENT_EVIDENCE");
		expect(validationCodes(result)).toContain("AUTHENTICATED_INPUT_METADATA_DRIFT");
	});
	test.each([
		["report", "short-01.json"],
		["attempt ledger", "perf-corpus-attempt-ledger.json"],
		["raw manifest", "perf-corpus-raw-manifest.json"],
	] as const)("fails closed when an authenticated %s disappears after byte capture", async (_label, filename) => {
		const input = path.join(temporaryRoot, `post-capture-disappearance-${filename}`);
		const output = path.join(temporaryRoot, `post-capture-disappearance-output-${filename}`);
		await writeCorpus(input);
		const sealedDigests = sealedDigestsByDirectory.get(path.resolve(input));
		if (!sealedDigests) throw new Error("sealed digests are unavailable for post-capture disappearance test");
		const harness = [
			"import importlib.util, json, os, pathlib, sys",
			"spec = importlib.util.spec_from_file_location('analysis', os.environ['DRIVER'])",
			"module = importlib.util.module_from_spec(spec)",
			"sys.modules['analysis'] = module",
			"spec.loader.exec_module(module)",
			"original = module._validate_sealed_inputs",
			"def capture_then_remove(*args):",
			"    captured = original(*args)",
			"    (pathlib.Path(os.environ['INPUT']) / os.environ['TARGET']).unlink()",
			"    return captured",
			"module._validate_sealed_inputs = capture_then_remove",
			"result = module.run_analysis(",
			"    os.environ['INPUT'], os.environ['OUTPUT'], pathlib.Path(os.environ['PREREG']).read_bytes(),",
			"    os.environ['GIT_SHA'], os.environ['TREE_SHA'], os.environ['CLOSURE_DIGEST'],",
			"    os.environ['WORKTREE_FINGERPRINT'], os.environ['CONTROL_IDENTITY'], os.environ['CAPTURE_ID'],",
			"    os.environ['SCHEDULE_DIGEST'], os.environ['PROTOCOL_DIGEST'], os.environ['DRIVER_DIGEST'],",
			"    os.environ['PREREG_DIGEST'], os.environ['TEMPLATE_DIGEST'], os.environ['LEDGER_DIGEST'],",
			"    os.environ['MANIFEST_DIGEST'],",
			")",
			"print(json.dumps(result['result']))",
		].join("\n");
		const subprocess = Bun.spawnSync(["python3", "-S", "-c", harness], {
			env: {
				...process.env,
				DRIVER: driverPath,
				INPUT: input,
				OUTPUT: output,
				PREREG: preregistrationPath,
				TARGET: filename,
				GIT_SHA: gitSha,
				TREE_SHA: treeSha,
				CLOSURE_DIGEST: expectedClosureDigest,
				WORKTREE_FINGERPRINT: worktreeFingerprint,
				CONTROL_IDENTITY: captureRuntimeControlIdentity,
				CAPTURE_ID: captureId,
				SCHEDULE_DIGEST: expectedScheduleDigest,
				PROTOCOL_DIGEST: expectedProtocolDigest,
				DRIVER_DIGEST: driverSha256,
				PREREG_DIGEST: preregistrationSha256,
				TEMPLATE_DIGEST: expectedTemplateSha256,
				LEDGER_DIGEST: sealedDigests.attemptLedgerSha256,
				MANIFEST_DIGEST: sealedDigests.rawManifestSha256,
			},
		});
		expect(subprocess.exitCode).toBe(0);
		const result = JSON.parse(decoder.decode(subprocess.stdout)) as ValidationResult;
		expect(result.evidenceStatus).toBe("INSUFFICIENT_EVIDENCE");
		expect(validationCodes(result)).toContain("AUTHENTICATED_INPUT_METADATA_DRIFT");
	});

	test("defaults insufficient evidence to NOT_EVALUATED with truthful missing-member accounting", async () => {
		const input = path.join(temporaryRoot, "missing-input");
		const output = path.join(temporaryRoot, "missing-output");
		await writeCorpus(input);
		await fs.rm(path.join(input, "soak-24.json"));
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(result.evidenceStatus).toBe("INSUFFICIENT_EVIDENCE");
		expect(result.actionDecision).toBe("NOT_EVALUATED");
		expect(result.admission.soak).toMatchObject({
			attemptsObserved: 0,
			admittedBlocks: 0,
			invalidBlocks: 0,
			notEvaluatedBlocks: 24,
			excludedBlocks: 0,
		});
		expect(validationCodes(result)).toContain("SEALED_INPUT_INVALID");
		expect(result.claimPolicy.p95).toMatchObject({
			status: "OMITTED_IMPOSSIBLE",
			finiteUpperEndpointAvailable: false,
			empiricalP95Emitted: false,
		});
	});

	test("collects structured errors from early and late invalid blocks without fabricating exclusions", async () => {
		const input = path.join(temporaryRoot, "multi-invalid-input");
		const output = path.join(temporaryRoot, "multi-invalid-output");
		await writeCorpus(input, () => 100_000, ["short-01", "soak-24"]);
		const early = path.join(input, "short-01.json");
		const raw = await fs.readFile(early, "utf8");
		await fs.writeFile(
			early,
			raw.replace('"schema":"gjc.perf-corpus/3"', '"schema":"gjc.perf-corpus/3","schema":"gjc.perf-corpus/3"'),
		);
		await mutateReport(input, "soak-24.json", report => {
			report.runner.memorySurfaceOrder = [...report.runner.memorySurfaceOrder].reverse();
		});
		expect(invoke(input, output).exitCode).toBe(0);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "DUPLICATE_JSON_KEY", filename: "short-01.json" }),
				expect.objectContaining({ code: "SURFACE_ORDER_DRIFT", filename: "soak-24.json" }),
			]),
		);
		expect(result.admission.short).toMatchObject({
			admittedBlocks: 5,
			invalidBlocks: 1,
			notEvaluatedBlocks: 0,
			excludedBlocks: 0,
		});
		expect(result.admission.soak).toMatchObject({
			admittedBlocks: 24,
			invalidBlocks: 1,
			notEvaluatedBlocks: 0,
			excludedBlocks: 0,
		});
	});

	test("fails closed when an individually valid shared runner provenance field drifts", async () => {
		const input = path.join(temporaryRoot, "shared-provenance-input");
		const output = path.join(temporaryRoot, "shared-provenance-output");
		await writeCorpus(input);
		await mutateReport(input, "soak-24.json", report => {
			report.runner.worktreeFingerprint = "d".repeat(64);
			report.runner.runtimeControlIdentity = memoryRuntimeControlIdentity(report.runner);
		});
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "PROVENANCE_DRIFT",
				message: expect.stringContaining("report/ledger worktreeFingerprint binding mismatch"),
			}),
		);
	});

	test("enforces fixed JSON depth and per-file byte bounds", async () => {
		const depthInput = path.join(temporaryRoot, "json-depth-input");
		const depthOutput = path.join(temporaryRoot, "json-depth-output");
		await writeCorpus(depthInput, () => 100_000, ["short-02"]);
		await mutateReport(depthInput, "short-02.json", report => {
			let nested: JsonValue = "leaf";
			for (let index = 0; index < 45; index++) nested = { nested };
			report.depthProbe = nested;
		});
		expect(invoke(depthInput, depthOutput).exitCode).toBe(0);
		const depthResult = await readResult(depthOutput);
		expect(validationCodes(depthResult)).toContain("JSON_DEPTH_BOUND_EXCEEDED");
		expect(depthResult.admission.short).toMatchObject({ admittedBlocks: 5, invalidBlocks: 1, notEvaluatedBlocks: 0 });

		const byteInput = path.join(temporaryRoot, "json-byte-input");
		const byteOutput = path.join(temporaryRoot, "json-byte-output");
		await writeCorpus(byteInput, () => 100_000, ["short-03"]);
		await fs.writeFile(path.join(byteInput, "short-03.json"), Buffer.alloc(8_388_609, 0x20));
		await resealCorpus(byteInput);
		expect(invoke(byteInput, byteOutput).exitCode).toBe(3);
		expect(validationCodes(await readResult(byteOutput))).toContain("SEALED_INPUT_INVALID");
	});

	test("rejects fixed sample-count and elapsed-duration bounds before estimator pair work", async () => {
		const input = path.join(temporaryRoot, "sample-bounds-input");
		const output = path.join(temporaryRoot, "sample-bounds-output");
		await writeCorpus(input, () => 100_000, ["short-01", "soak-24"]);
		await mutateReport(input, "short-01.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples = Array.from({ length: 23 }, (_, index) =>
				sample(index * 250, 100_000_000 + index),
			);
		});
		await mutateReport(input, "soak-24.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples.at(-1)!.elapsedMs = 30_250.001;
		});
		expect(invoke(input, output).exitCode).toBe(0);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "PERIODIC_SAMPLE_BOUND_EXCEEDED", filename: "short-01.json" }),
				expect.objectContaining({ code: "ELAPSED_DURATION_BOUND_EXCEEDED", filename: "soak-24.json" }),
			]),
		);
	});

	test("accepts zero action slopes while rejecting extreme duration and near-equal timestamps", async () => {
		const input = path.join(temporaryRoot, "numeric-edge-input");
		const output = path.join(temporaryRoot, "numeric-edge-output");
		await writeCorpus(input, () => 100_000, ["soak-01", "soak-24"]);
		await mutateReport(input, "soak-01.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples[2].elapsedMs = 7_500.0001;
		});
		await mutateReport(input, "soak-02.json", report => {
			const measured = report.fixtures[0].memoryBaseline;
			for (const item of measured.periodicSamples) item.heapUsedBytes = 100_000_000;
			measured.heapSlopeBytesPerSecond = 0;
			measured.observedExtrema.heapUsedBytes = { valueBytes: 100_000_000, elapsedMs: 0 };
		});
		await mutateReport(input, "soak-24.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples.at(-1)!.elapsedMs = 1e300;
		});
		expect(invoke(input, output).exitCode).toBe(0);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "TIMESTAMP_SEPARATION_INVALID", filename: "soak-01.json" }),
				expect.objectContaining({ code: "ELAPSED_DURATION_BOUND_EXCEEDED", filename: "soak-24.json" }),
			]),
		);
	});

	test("separates endpoint and Theil-Sen conditions for both eligible surfaces", async () => {
		const endpointPassTheilFail: SlopePlan = {
			steadyDeltas: [0, -10_000_000, -20_000_000, -30_000_000, 50_000_000],
		};
		const endpointFailTheilPass: SlopePlan = {
			steadyDeltas: [0, 10_000_000, 20_000_000, 30_000_000, -50_000_000],
		};
		for (const surface of ["agent-session", "tui"]) {
			for (const [label, plan, endpointPositive, theilPositive] of [
				["endpoint-pass", endpointPassTheilFail, 24, 0],
				["theil-pass", endpointFailTheilPass, 0, 24],
			] as const) {
				const input = path.join(temporaryRoot, `${surface}-${label}-input`);
				const output = path.join(temporaryRoot, `${surface}-${label}-output`);
				await writeCorpus(input, (candidate, blockIndex) => {
					if (preregistration.captureControls.schedule[blockIndex]!.profile !== "soak") return 100_000;
					return candidate === surface ? plan : 100_000;
				});
				expect(invoke(input, output).exitCode).toBe(0);
				const result = await readResult(output);
				const decision = result.actionAnalysis.surfaces[surface];
				expect(result.actionDecision).toBe("NO_ACTION");
				expect(decision.endpointPositiveSigns).toBe(endpointPositive);
				expect(decision.theilSenPositiveSigns).toBe(theilPositive);
				expect(decision.surfacePass).toBe(false);
			}
		}
	});

	test("matches the deterministic 10,000-resample golden at the exact action boundary", () => {
		const boundary = 1_048_576 / 30;
		const program = [
			"import hashlib,json,os",
			`path=${JSON.stringify(driverPath)}`,
			`expected=${JSON.stringify(driverSha256)}`,
			"fd=os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))",
			"try: raw=os.read(fd, 1024*1024)",
			"finally: os.close(fd)",
			"assert hashlib.sha256(raw).hexdigest()==expected",
			"namespace={'__name__':'gjc_unit_only','__file__':'<verified-unit-driver>'}",
			"exec(compile(raw, namespace['__file__'], 'exec', dont_inherit=True), namespace)",
			`print(json.dumps(namespace['_unit_only_bca_reference']([${boundary}]*24), sort_keys=True))`,
		].join("\n");
		const invocation = Bun.spawnSync(["python3", "-c", program]);
		expect(invocation.exitCode).toBe(0);
		const result = JSON.parse(decoder.decode(invocation.stdout));
		expect(result).toMatchObject({
			resamples: 10_000,
			seed: 0x3279b4e7,
			lower: boundary,
			upper: boundary,
			biasCorrection: 0,
			acceleration: 0,
		});
	});

	test("does not execute altered driver bytes before digest authentication", async () => {
		const input = path.join(temporaryRoot, "altered-driver-input");
		const output = path.join(temporaryRoot, "altered-driver-output");
		const bundle = path.join(temporaryRoot, "altered-driver-bundle");
		const marker = path.join(temporaryRoot, "altered-driver-side-effect");
		await writeCorpus(input);
		await fs.mkdir(bundle);
		const altered = `${await fs.readFile(driverPath, "utf8")}\nPath(${JSON.stringify(marker)}).write_text("executed")\n`;
		await Promise.all([
			fs.writeFile(path.join(bundle, path.basename(driverPath)), altered),
			fs.copyFile(preregistrationPath, path.join(bundle, path.basename(preregistrationPath))),
		]);
		const invocation = invoke(input, output, { bundleDir: bundle });
		expect(invocation.exitCode).not.toBe(0);
		expect(invocation.stderr).toContain("SHA-256 mismatch");
		expect(await pathExists(marker)).toBe(false);
		expect(await pathExists(output)).toBe(false);
	});

	test("does not parse or execute altered template bytes before fixed-digest authentication", async () => {
		const input = path.join(temporaryRoot, "altered-template-input");
		const output = path.join(temporaryRoot, "altered-template-output");
		const alteredTemplate = path.join(temporaryRoot, "altered-template.ipynb");
		const marker = path.join(temporaryRoot, "altered-template-side-effect");
		await writeCorpus(input);
		const notebook: Notebook = {
			cells: [
				{
					cell_type: "code",
					source: [`open(${JSON.stringify(marker)}, "w").write("executed")\n`, authenticatedLauncher.code],
				},
			],
		};
		await fs.writeFile(alteredTemplate, JSON.stringify(notebook));
		const launch = loadAuthenticatedLauncher(alteredTemplate).then(() => invoke(input, output));
		await expect(launch).rejects.toThrow("trusted template SHA-256 mismatch");
		expect(await pathExists(marker)).toBe(false);
		expect(await pathExists(output)).toBe(false);
	});

	test("rejects nested input and bundle import paths before shadow modules execute", async () => {
		const input = path.join(temporaryRoot, "shadow-nested-input");
		const inputShadow = path.join(input, "nested", "imports");
		const inputOutput = path.join(temporaryRoot, "shadow-nested-input-output");
		const inputMarker = path.join(temporaryRoot, "shadow-nested-input-marker");
		await writeCorpus(input);
		await fs.mkdir(inputShadow, { recursive: true });
		await fs.writeFile(
			path.join(inputShadow, "pathlib.py"),
			`open(${JSON.stringify(inputMarker)}, "w").write("executed")\n`,
		);
		const inputInvocation = invoke(input, inputOutput, { pythonPath: inputShadow });
		expect(inputInvocation.exitCode).not.toBe(0);
		expect(inputInvocation.stderr).toContain("descendants must not be on Python import search paths");
		expect(await pathExists(inputMarker)).toBe(false);
		expect(await pathExists(inputOutput)).toBe(false);

		const bundleInput = path.join(temporaryRoot, "shadow-nested-bundle-input");
		const bundle = path.join(temporaryRoot, "shadow-nested-bundle");
		const bundleShadow = path.join(bundle, "nested", "imports");
		const bundleOutput = path.join(temporaryRoot, "shadow-nested-bundle-output");
		const bundleMarker = path.join(temporaryRoot, "shadow-nested-bundle-marker");
		await writeCorpus(bundleInput);
		await fs.mkdir(bundleShadow, { recursive: true });
		await Promise.all([
			fs.copyFile(driverPath, path.join(bundle, path.basename(driverPath))),
			fs.copyFile(preregistrationPath, path.join(bundle, path.basename(preregistrationPath))),
			fs.writeFile(
				path.join(bundleShadow, "pathlib.py"),
				`open(${JSON.stringify(bundleMarker)}, "w").write("executed")\n`,
			),
		]);
		const bundleInvocation = invoke(bundleInput, bundleOutput, {
			bundleDir: bundle,
			pythonPath: bundleShadow,
		});
		expect(bundleInvocation.exitCode).not.toBe(0);
		expect(bundleInvocation.stderr).toContain("descendants must not be on Python import search paths");
		expect(await pathExists(bundleMarker)).toBe(false);
		expect(await pathExists(bundleOutput)).toBe(false);
	});

	test("resolves an empty import path to cwd and rejects an untrusted cwd before imports", async () => {
		const input = path.join(temporaryRoot, "shadow-cwd-input");
		const output = path.join(temporaryRoot, "shadow-cwd-output");
		const marker = path.join(temporaryRoot, "shadow-cwd-marker");
		await writeCorpus(input);
		await fs.writeFile(path.join(input, "pathlib.py"), `open(${JSON.stringify(marker)}, "w").write("executed")\n`);
		const invocation = invoke(input, output, { cwd: input });
		expect(invocation.exitCode).not.toBe(0);
		expect(invocation.stderr).toContain("descendants must not be on Python import search paths");
		expect(await pathExists(marker)).toBe(false);
		expect(await pathExists(output)).toBe(false);
	});

	test("requires external immutable-mount attestation and has no canonical resample bypass", async () => {
		const input = path.join(temporaryRoot, "trust-controls-input");
		await writeCorpus(input);
		const invocation = invoke(input, path.join(temporaryRoot, "trust-controls-output"), {
			readOnlyAttestation: "0",
		});
		expect(invocation.exitCode).not.toBe(0);
		expect(invocation.stderr).toContain("immutable read-only input mount");
		const driver = await fs.readFile(driverPath, "utf8");
		expect(driver).not.toContain("--test-mode");
		expect(driver).not.toContain("--resamples");
		expect(driver).not.toContain("GJC_PERF_CORPUS_RLM_TEST_ONLY");
	});

	test("keeps ps and unavailable sampler/value combinations consistent", async () => {
		const validInput = path.join(temporaryRoot, "sampler-valid-input");
		const validOutput = path.join(temporaryRoot, "sampler-valid-output");
		await writeCorpus(validInput);
		await mutateReport(validInput, "short-01.json", report => {
			const measured = report.fixtures[0].memoryBaseline;
			measured.processTreeSampler = "ps";
			measured.processTreeBaselineRssBytes = 210_000_000;
			measured.processTreePostTeardownRssBytes = 205_000_000;
		});
		expect(invoke(validInput, validOutput).exitCode).toBe(0);

		const invalidInput = path.join(temporaryRoot, "sampler-invalid-input");
		const invalidOutput = path.join(temporaryRoot, "sampler-invalid-output");
		await writeCorpus(invalidInput, () => 100_000, ["short-01", "soak-24"]);
		await mutateReport(invalidInput, "short-01.json", report => {
			report.fixtures[0].memoryBaseline.processTreeSampler = "ps";
		});
		await mutateReport(invalidInput, "soak-24.json", report => {
			const measured = report.fixtures[0].memoryBaseline;
			measured.processTreeBaselineRssBytes = 1;
			measured.processTreePostTeardownRssBytes = 1;
		});
		expect(invoke(invalidInput, invalidOutput).exitCode).toBe(0);
		const result = await readResult(invalidOutput);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filename: "short-01.json",
					message: expect.stringContaining("ps sampler requires"),
				}),
				expect.objectContaining({
					filename: "soak-24.json",
					message: expect.stringContaining("unavailable sampler requires"),
				}),
			]),
		);
	});

	test("rejects symlinks and unexpected entries without reading them", async () => {
		const input = path.join(temporaryRoot, "unsafe-input");
		const output = path.join(temporaryRoot, "unsafe-output");
		await writeCorpus(input, () => 100_000, ["short-01", "short-02"]);
		const target = path.join(input, "short-01.json");
		const replacement = path.join(temporaryRoot, "outside-report.json");
		await fs.rename(target, replacement);
		await fs.symlink(replacement, target);
		await fs.rm(path.join(input, "short-02.json"));
		await fs.writeFile(path.join(input, "notes.txt"), "never interpret this content");
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(validationCodes(result)).toContain("SEALED_INPUT_INVALID");
	});
});
