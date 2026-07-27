import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const driverPath = path.resolve(import.meta.dir, "../bench/perf-corpus-rlm-analysis.py");
const preregistrationPath = path.resolve(import.meta.dir, "../bench/perf-corpus-preregistration.json");
const templatePath = path.resolve(import.meta.dir, "../bench/perf-corpus-rlm-template.ipynb");
const bundleDirectory = path.dirname(driverPath);
const gitSha = "0123456789abcdef0123456789abcdef01234567";
const expectedTemplateSha256 = "8599b3be29c688105e3bf85c492016d943e44f762d69409fb48b000f0e1c9df9";
const decoder = new TextDecoder();
let temporaryRoot = "";
let preregistration: Preregistration;
let driverSha256 = "";
let preregistrationSha256 = "";
let authenticatedLauncher: AuthenticatedLauncher;

interface ScheduleItem {
	blockId: string;
	profile: "short" | "soak";
	expectedFilename: string;
	surfaceOrder: string[];
}

interface Preregistration {
	cohort: {
		profiles: Record<
			"short" | "soak",
			{
				durationTargetMs: number;
				iterationsTarget: number;
				maximumPeriodicSamples: number;
				elapsedDurationToleranceMs: number;
			}
		>;
	};
	captureControls: { schedule: ScheduleItem[] };
}

type SlopePlan = number | { steadyDeltas: number[] };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
}

interface SyntheticReportMutationSurface {
	runner: {
		memorySurfaceOrder: string[];
	};
	fixtures: Array<{
		memoryBaseline: SyntheticMemoryBaseline;
	}>;
	depthProbe?: JsonValue;
}

interface ValidationError {
	code: string;
	filename?: string;
	message?: string;
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
	};
	admission: Record<"short" | "soak", AdmissionSummary>;
	claimPolicy: {
		p95: string;
	};
	diagnostics: {
		validationErrors: ValidationError[];
	};
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

function baseline(surface: string, profile: "short" | "soak", iterationsTarget: number, plan: SlopePlan) {
	const initialHeap = 100_000_000;
	const periodicSamples =
		typeof plan === "number"
			? [0, 250, 500, 750, 1000].map(elapsedMs =>
					sample(elapsedMs, initialHeap + Math.round((plan * elapsedMs) / 1000)),
				)
			: [
					sample(0, initialHeap),
					...plan.steadyDeltas.map((delta, index) => sample((index + 1) * 250, initialHeap + delta)),
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
	};
}

function reportFor(
	schedule: ScheduleItem,
	blockIndex: number,
	slopeFor: (surface: string, blockIndex: number) => SlopePlan,
) {
	const profileConfig = preregistration.cohort.profiles[schedule.profile];
	const fixtures = schedule.surfaceOrder.map(surface => {
		const memoryBaseline = baseline(
			surface,
			schedule.profile,
			profileConfig.iterationsTarget,
			slopeFor(surface, blockIndex),
		);
		const runElapsedMs = memoryBaseline.periodicSamples.at(-1)!.elapsedMs;
		return {
			fixtureId: `memory-${surface}`,
			fixtureClass: "large-transcript",
			sourceClass: "synthetic",
			workloadTags: ["memory", surface],
			privacy: { rawPrivateTranscriptCommitted: false },
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
	return {
		schema: "gjc.perf-corpus/3",
		generatedAt: "2026-07-27T00:00:00.000Z",
		gitSha,
		gitDirty: false,
		runner: {
			command: "bun packages/coding-agent/bench/perf-corpus.bench.ts",
			argv: ["bun", "packages/coding-agent/bench/perf-corpus.bench.ts"],
			environment,
			platform: "darwin",
			arch: "arm64",
			bunVersion: "1.3.0",
			profile: schedule.profile,
			durationTargetMs: profileConfig.durationTargetMs,
			memoryIsolation: "process-per-surface",
			iterationsTarget: profileConfig.iterationsTarget,
			gcExposed: false,
			memoryChildGcExposed: true,
			memoryChildExecArgv: ["--smol", "--expose-gc"],
			memorySurfaceOrder: schedule.surfaceOrder,
		},
		fixtures,
		hotspotClassifications: [],
	};
}

async function writeCorpus(
	directory: string,
	slopeFor: (surface: string, blockIndex: number) => SlopePlan = () => 100_000,
): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	await Promise.all(
		preregistration.captureControls.schedule.map(async (schedule, index) => {
			await fs.writeFile(
				path.join(directory, schedule.expectedFilename),
				`${JSON.stringify(reportFor(schedule, index, slopeFor))}\n`,
			);
		}),
	);
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
	} = {},
) {
	const launcher = authenticatedLauncher;
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
					GJC_PERF_CORPUS_EXPECTED_GIT_SHA: gitSha,
					GJC_PERF_CORPUS_TEMPLATE_SHA256: launcher.templateSha256,
					GJC_PERF_CORPUS_DRIVER_SHA256: options.driverDigest ?? driverSha256,
					GJC_PERF_CORPUS_PREREGISTRATION_SHA256: options.preregistrationDigest ?? preregistrationSha256,
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
	authenticatedLauncher = launcher;
});

afterAll(async () => {
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("trusted perf-corpus RLM analysis driver", () => {
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
		expect(result.claimPolicy.p95).toBe("OMITTED");
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
			attemptsObserved: 23,
			admittedBlocks: 23,
			invalidBlocks: 0,
			notEvaluatedBlocks: 1,
			excludedBlocks: 0,
		});
		expect(result.diagnostics.validationErrors).toContainEqual(
			expect.objectContaining({ code: "MISSING_SCHEDULED_BLOCK", filename: "soak-24.json" }),
		);
		expect(result.claimPolicy.p95).toBe("OMITTED");
	});

	test("collects structured errors from early and late invalid blocks without fabricating exclusions", async () => {
		const input = path.join(temporaryRoot, "multi-invalid-input");
		const output = path.join(temporaryRoot, "multi-invalid-output");
		await writeCorpus(input);
		const early = path.join(input, "short-01.json");
		const raw = await fs.readFile(early, "utf8");
		await fs.writeFile(
			early,
			raw.replace('"schema":"gjc.perf-corpus/3"', '"schema":"gjc.perf-corpus/3","schema":"gjc.perf-corpus/3"'),
		);
		await mutateReport(input, "soak-24.json", report => {
			report.runner.memorySurfaceOrder = [...report.runner.memorySurfaceOrder].reverse();
		});
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "DUPLICATE_JSON_KEY", filename: "short-01.json" }),
				expect.objectContaining({ code: "SURFACE_ORDER_DRIFT", filename: "soak-24.json" }),
			]),
		);
		expect(result.admission.short).toMatchObject({
			admittedBlocks: 4,
			invalidBlocks: 1,
			notEvaluatedBlocks: 0,
			excludedBlocks: 0,
		});
		expect(result.admission.soak).toMatchObject({
			admittedBlocks: 23,
			invalidBlocks: 1,
			notEvaluatedBlocks: 0,
			excludedBlocks: 0,
		});
	});

	test("enforces fixed JSON depth and per-file byte bounds", async () => {
		const input = path.join(temporaryRoot, "json-bounds-input");
		const output = path.join(temporaryRoot, "json-bounds-output");
		await writeCorpus(input);
		await mutateReport(input, "short-02.json", report => {
			let nested: JsonValue = "leaf";
			for (let index = 0; index < 45; index++) nested = { nested };
			report.depthProbe = nested;
		});
		await fs.writeFile(path.join(input, "short-03.json"), Buffer.alloc(8_388_609, 0x20));
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(validationCodes(result)).toEqual(
			expect.arrayContaining(["JSON_DEPTH_BOUND_EXCEEDED", "BYTE_BOUND_EXCEEDED"]),
		);
		expect(result.admission.short).toMatchObject({ admittedBlocks: 3, invalidBlocks: 2, notEvaluatedBlocks: 0 });
	});

	test("rejects fixed sample-count and elapsed-duration bounds before estimator pair work", async () => {
		const input = path.join(temporaryRoot, "sample-bounds-input");
		const output = path.join(temporaryRoot, "sample-bounds-output");
		await writeCorpus(input);
		await mutateReport(input, "short-01.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples = Array.from({ length: 23 }, (_, index) =>
				sample(index * 250, 100_000_000 + index),
			);
		});
		await mutateReport(input, "soak-24.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples.at(-1)!.elapsedMs = 1250.001;
		});
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "PERIODIC_SAMPLE_BOUND_EXCEEDED", filename: "short-01.json" }),
				expect.objectContaining({ code: "ELAPSED_DURATION_BOUND_EXCEEDED", filename: "soak-24.json" }),
			]),
		);
	});

	test("rejects extreme duration, near-equal timestamps, and zero action slopes", async () => {
		const input = path.join(temporaryRoot, "numeric-edge-input");
		const output = path.join(temporaryRoot, "numeric-edge-output");
		await writeCorpus(input);
		await mutateReport(input, "soak-01.json", report => {
			report.fixtures[0].memoryBaseline.periodicSamples[2].elapsedMs = 250.0001;
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
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(result.diagnostics.validationErrors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "TIMESTAMP_SEPARATION_INVALID", filename: "soak-01.json" }),
				expect.objectContaining({ code: "DERIVED_SLOPE_INVALID", filename: "soak-02.json" }),
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
			seed: 20260727,
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
		await writeCorpus(invalidInput);
		await mutateReport(invalidInput, "short-01.json", report => {
			report.fixtures[0].memoryBaseline.processTreeSampler = "ps";
		});
		await mutateReport(invalidInput, "soak-24.json", report => {
			const measured = report.fixtures[0].memoryBaseline;
			measured.processTreeBaselineRssBytes = 1;
			measured.processTreePostTeardownRssBytes = 1;
		});
		expect(invoke(invalidInput, invalidOutput).exitCode).toBe(3);
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
		await writeCorpus(input);
		const target = path.join(input, "short-01.json");
		const replacement = path.join(temporaryRoot, "outside-report.json");
		await fs.rename(target, replacement);
		await fs.symlink(replacement, target);
		await fs.rm(path.join(input, "short-02.json"));
		await fs.writeFile(path.join(input, "notes.txt"), "never interpret this content");
		expect(invoke(input, output).exitCode).toBe(3);
		const result = await readResult(output);
		expect(validationCodes(result)).toEqual(expect.arrayContaining(["UNSAFE_INPUT_ENTRY", "UNEXPECTED_INPUT_ENTRY"]));
	});
});
