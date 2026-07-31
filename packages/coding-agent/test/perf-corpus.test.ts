import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionWorkload } from "../bench/memory-baseline-session-child";
import { createTuiWorkload } from "../bench/memory-baseline-tui-child";
import { createMemoryBaselineWorkloads } from "../bench/memory-baseline-workloads";
import {
	calculateMemorySlope,
	gitWorktreeFingerprint,
	normalizeProcessTreeRss,
	resolveGitProvenance,
	resolveMeasurementRuntimeProvenance,
	updateMemoryObservedExtrema,
} from "../bench/perf-corpus.bench";
import {
	type HotspotClassification,
	hasProfilerSelfTimeEvidence,
	isHotspotStatus,
	MEMORY_CAPTURE_SEMANTICS_ID,
	type MemoryUsageSample,
	memoryRuntimeControlIdentity,
	PERF_CORPUS_SCHEMA,
	type PerfCorpusReport,
	REQUIRED_FIXTURE_CLASSES,
	REQUIRED_MEMORY_SURFACES,
	V1_V3_RECLASSIFICATION,
	validateHotspotClassification,
	validatePerfCorpusReport,
} from "../bench/perf-corpus-schema";
import {
	APPLIED_PERF_THRESHOLDS,
	HELD_PERF_THRESHOLDS,
	validatePerfThresholdLedger,
} from "../bench/perf-threshold.ledger";

const memoryControlKeys = [
	"GJC_MEMORY_PROFILE",
	"GJC_MEMORY_ITERATIONS",
	"GJC_MEMORY_DURATION_MS",
	"GJC_MEMORY_SURFACE_ORDER",
] as const;
const canonicalBenchmarkPath = path.resolve(import.meta.dir, "../bench/perf-corpus.bench.ts");
const logicalBenchmarkPath = "packages/coding-agent/bench/perf-corpus.bench.ts";
const repositoryRoot = path.resolve(import.meta.dir, "../../..");
function checkedOutHead(): string {
	const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
	if (revision.exitCode !== 0) throw new Error("git revision unavailable");
	return new TextDecoder().decode(revision.stdout).trim();
}

function runPerfCorpusBenchmark(_options: { isolatedMemory?: boolean } = {}): PerfCorpusReport {
	const result = Bun.spawnSync([process.execPath, ...process.execArgv, canonicalBenchmarkPath], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...process.env },
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
	return JSON.parse(new TextDecoder().decode(result.stdout)) as PerfCorpusReport;
}

let originalMemoryControls = new Map<(typeof memoryControlKeys)[number], string | undefined>();
function expectedPublicRunnerArgv(): string[] {
	return ["bun", ...process.execArgv, logicalBenchmarkPath];
}

beforeEach(() => {
	originalMemoryControls = new Map(memoryControlKeys.map(key => [key, process.env[key]]));
	for (const key of memoryControlKeys) delete process.env[key];
});

afterEach(() => {
	for (const [key, value] of originalMemoryControls) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("perf corpus schema + runner", () => {
	test("runner emits the schema with separated evidence fields and >=3 required fixture classes", () => {
		const report = runPerfCorpusBenchmark();
		expect(report.schema).toBe(PERF_CORPUS_SCHEMA);
		expect(report.gitSha).toMatch(/^[0-9a-f]{40}$/);
		const expectedParentArgv = expectedPublicRunnerArgv();
		expect(report.runner.command).toBe(expectedParentArgv.join(" "));
		expect(report.runner.argv).toEqual(expectedParentArgv);
		expect(report.runner.runtimeCommand).toBe(report.runner.command);
		expect(report.runner.runtimeControlIdentity).toBe(memoryRuntimeControlIdentity(report.runner));
		expect(report.runner.runnerPid).toBeGreaterThan(0);
		expect(report.runner.bunVersion).toBe(process.versions.bun);
		expect(report.runner.bunExecutable).toBe("bun");
		expect(report.runner.bunExecutableSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(report.runner.worktreeFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(report.runner.closureDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(report.runner.closureManifest.length).toBeGreaterThan(0);
		expect(report.runner.closureManifest).toEqual([...report.runner.closureManifest].sort());
		expect(report.runner.environment).toEqual({
			GJC_MEMORY_PROFILE: "short",
			GJC_MEMORY_ITERATIONS: String(report.runner.iterationsTarget),
			GJC_MEMORY_SURFACE_ORDER: REQUIRED_MEMORY_SURFACES.join(","),
		});
		expect(report.runner.iterationsTarget).toBeGreaterThan(0);
		expect(typeof report.runner.gcExposed).toBe("boolean");
		expect(report.runner.memoryChildExecArgv).toEqual(["--smol", "--expose-gc"]);
		expect(report.runner.memorySurfaceOrder).toEqual([...REQUIRED_MEMORY_SURFACES]);
		expect(typeof report.gitDirty).toBe("boolean");
		const classes = new Set(report.fixtures.map(f => f.fixtureClass));
		for (const required of REQUIRED_FIXTURE_CLASSES) {
			expect(classes.has(required)).toBe(true);
		}
		expect(report.fixtures.length).toBeGreaterThanOrEqual(3);
		for (const fixture of report.fixtures) {
			// the three evidence classes are present as SEPARATE named fields
			expect(Object.keys(fixture.wallClockPhase).length).toBeGreaterThan(0);
			expect(Object.keys(fixture.processCpuUsage).length).toBeGreaterThan(0);
			expect(fixture.profilerSelfTime).toBeDefined();
			for (const metric of Object.values(fixture.wallClockPhase)) {
				expect(Number.isFinite(metric.elapsedMs)).toBe(true);
				expect(metric.advisoryOnly).toBe(true);
			}
			for (const metric of Object.values(fixture.processCpuUsage)) {
				expect(Number.isFinite(metric.userMicros)).toBe(true);
				expect(Number.isFinite(metric.systemMicros)).toBe(true);
			}
			expect(Number.isFinite(fixture.rssMemory.growthBytes)).toBe(true);
		}
	});
	test.each([
		["without runtime flags", []],
		["with --smol", ["--smol"]],
		["with --expose-gc", ["--expose-gc"]],
		["with ordered runtime flags", ["--smol", "--expose-gc"]],
	] as const)("accepts the canonical direct invocation %s", (_name, execArguments) => {
		const result = Bun.spawnSync([process.execPath, ...execArguments, canonicalBenchmarkPath], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: { ...process.env, GJC_MEMORY_ITERATIONS: "1" },
		});
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stderr)).toBe("");
		const report = JSON.parse(new TextDecoder().decode(result.stdout)) as PerfCorpusReport;
		expect(report.runner.argv).toEqual(["bun", ...execArguments, logicalBenchmarkPath]);
		expect(validatePerfCorpusReport(report)).toEqual({ ok: true, errors: [] });
	});

	test.each([
		["post-script flag", [canonicalBenchmarkPath, "--smol"]],
		["duplicate --smol", ["--smol", "--smol", canonicalBenchmarkPath]],
		["duplicate --expose-gc", ["--expose-gc", "--expose-gc", canonicalBenchmarkPath]],
		["reversed flags", ["--expose-gc", "--smol", canonicalBenchmarkPath]],
	])("rejects a non-canonical direct invocation with %s", (_name, argumentsAfterBun) => {
		const result = Bun.spawnSync([process.execPath, ...argumentsAfterBun], {
			cwd: path.resolve(import.meta.dir, "../../.."),
		});
		expect(result.exitCode).not.toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toBe("");
		expect(new TextDecoder().decode(result.stderr)).toContain(
			"benchmark runner invocation is outside the frozen public contract",
		);
	});

	test("rejects a dynamically imported wrapper that spoofs Bun.main and process.argv", async () => {
		const wrapperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-perf-corpus-wrapper-"));
		const wrapperPath = path.join(wrapperDirectory, "alternate-wrapper.ts");
		try {
			await Bun.write(
				wrapperPath,
				`(Bun as { main: string }).main = ${JSON.stringify(canonicalBenchmarkPath)};\n` +
					`process.argv.splice(0, process.argv.length, process.execPath, ${JSON.stringify(canonicalBenchmarkPath)});\n` +
					`const { runPerfCorpusBenchmark } = await import(${JSON.stringify(canonicalBenchmarkPath)});\n` +
					`process.stdout.write(JSON.stringify(runPerfCorpusBenchmark()));\n`,
			);
			const result = Bun.spawnSync([process.execPath, wrapperPath], {
				cwd: path.resolve(import.meta.dir, "../../.."),
			});
			expect(result.exitCode).not.toBe(0);
			expect(new TextDecoder().decode(result.stdout)).toBe("");
			expect(new TextDecoder().decode(result.stderr)).toContain(
				"benchmark runner invocation is outside the frozen public contract",
			);
		} finally {
			await fs.rm(wrapperDirectory, { recursive: true, force: true });
		}
	});
	test("prefers checked-out HEAD over workflow SHA provenance", () => {
		const expectedSha = checkedOutHead();

		const previousGitSha = process.env.GITHUB_SHA;
		process.env.GITHUB_SHA = "b".repeat(40);
		try {
			expect(runPerfCorpusBenchmark().gitSha).toBe(expectedSha);
		} finally {
			if (previousGitSha === undefined) delete process.env.GITHUB_SHA;
			else process.env.GITHUB_SHA = previousGitSha;
		}
	});
	test("fails closed when Git is unavailable", () => {
		const spawnSync = vi.spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("git unavailable");
		});
		try {
			expect(() => resolveGitProvenance()).toThrow("git HEAD provenance unavailable");
		} finally {
			spawnSync.mockRestore();
		}
	});
	test("resolves provenance from the benchmark checkout instead of the caller cwd", () => {
		const expectedSha = checkedOutHead();
		const previousCwd = process.cwd();
		try {
			process.chdir(os.tmpdir());
			expect(runPerfCorpusBenchmark().gitSha).toBe(expectedSha);
		} finally {
			process.chdir(previousCwd);
		}
	});
	test("fingerprints dirty file contents even when porcelain status is unchanged", async () => {
		const repository = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-perf-fingerprint-"));
		try {
			const runGit = (args: string[]) => {
				const result = Bun.spawnSync(["git", ...args], { cwd: repository });
				if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			};
			runGit(["init", "--quiet"]);
			await Bun.write(path.join(repository, "tracked.txt"), "tracked\n");
			runGit(["add", "tracked.txt"]);
			runGit([
				"-c",
				"user.name=GJC Test",
				"-c",
				"user.email=gjc@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"base",
			]);
			await Bun.write(path.join(repository, "untracked.txt"), "first\n");
			const first = gitWorktreeFingerprint(repository);
			await Bun.write(path.join(repository, "untracked.txt"), "second\n");
			const second = gitWorktreeFingerprint(repository);
			expect(first.dirty).toBe(true);
			expect(second.dirty).toBe(true);
			expect(second.fingerprint).not.toBe(first.fingerprint);
		} finally {
			await fs.rm(repository, { recursive: true, force: true });
		}
	});
	test("binds the public Bun identity, exact executable bytes, and canonical tracked closure manifest", () => {
		const repositoryRoot = path.resolve(import.meta.dir, "../../..");
		const provenance = resolveMeasurementRuntimeProvenance(repositoryRoot);
		const report = runPerfCorpusBenchmark();
		expect(report.runner.bunVersion).toBe(provenance.bunVersion);
		expect(report.runner.bunExecutable).toBe("bun");
		expect(report.runner.bunExecutableSha256).toBe(provenance.bunExecutableSha256);
		expect(report.runner.closureDigest).toBe(provenance.closureDigest);
		expect(report.runner.closureManifest).toEqual(provenance.closureManifest);
	});

	test("rejects tampered provenance identities and non-canonical closure manifests", () => {
		const report = runPerfCorpusBenchmark();
		const tamperedClosure = {
			...report,
			runner: { ...report.runner, closureDigest: "0".repeat(64) },
		};
		expect(validatePerfCorpusReport(tamperedClosure).errors).toContain(
			"runner.closureDigest does not match closureManifest",
		);
		const tamperedRuntime = {
			...report,
			runner: { ...report.runner, bunExecutableSha256: "0".repeat(64) },
		};
		expect(validatePerfCorpusReport(tamperedRuntime).errors).toContain(
			"runner.runtimeControlIdentity does not match runtime controls",
		);
		const privateManifest = {
			...report,
			runner: {
				...report.runner,
				closureManifest: [`/private/source.ts:${"a".repeat(64)}`, ...report.runner.closureManifest],
			},
		};
		expect(validatePerfCorpusReport(privateManifest).errors).toContain("runner.closureManifest invalid");
		const changedCommand = {
			...report,
			runner: { ...report.runner, runtimeCommand: "bun unexpected.ts" },
		};
		expect(validatePerfCorpusReport(changedCommand).errors).toContain(
			"runner.runtimeCommand must exactly match runner.command",
		);
		for (const scriptPath of [
			"packages/../private/perf-corpus.bench.ts",
			"packages\\coding-agent\\bench\\perf-corpus.bench.ts",
			"file:///private/tmp/perf-corpus.bench.ts",
			"label,/private/tmp/perf-corpus.bench.ts",
			"~/private/perf-corpus.bench.ts",
			"C:/private/perf-corpus.bench.ts",
			"label(/private/tmp/perf-corpus.bench.ts)",
			"label[/private/tmp/perf-corpus.bench.ts]",
			"label|/private/tmp/perf-corpus.bench.ts",
			"packages/coding-agent/bench/perf-corpus.bench.ts\n",
			"packages/coding-agent/bench/perf-corpus.bench.ts\r",
			"packages/coding-agent/bench/perf-corpus.bench.ts\u2028",
			"packages/coding-agent/bench/perf-corpus.bench.ts\u2029",
		]) {
			const argv = ["bun", scriptPath];
			const runner = {
				...report.runner,
				command: argv.join(" "),
				runtimeCommand: argv.join(" "),
				argv,
				runtimeControlIdentity: "",
			};
			runner.runtimeControlIdentity = memoryRuntimeControlIdentity(runner);
			expect(validatePerfCorpusReport({ ...report, runner }).errors).toContain(
				"runner.argv must begin with bun and contain only logical repository-relative values",
			);
		}
		for (const argv of [
			["bun", "packages/coding-agent/bench/perf-corpus.bench.ts", "--smol"],
			["bun", "--smol", "--smol", "packages/coding-agent/bench/perf-corpus.bench.ts"],
			["bun", "--expose-gc", "--expose-gc", "packages/coding-agent/bench/perf-corpus.bench.ts"],
			["bun", "--expose-gc", "--smol", "packages/coding-agent/bench/perf-corpus.bench.ts"],
		]) {
			const runner = {
				...report.runner,
				command: argv.join(" "),
				runtimeCommand: argv.join(" "),
				argv,
				runtimeControlIdentity: "",
			};
			runner.runtimeControlIdentity = memoryRuntimeControlIdentity(runner);
			expect(validatePerfCorpusReport({ ...report, runner }).errors).toContain(
				"runner.argv must begin with bun and contain only logical repository-relative values",
			);
		}
		for (const argv of [
			["bun", "--eval", "packages/coding-agent/bench/perf-corpus.bench.ts"],
			["bun", "--evil", "packages/coding-agent/bench/perf-corpus.bench.ts"],
			["bun", "packages/coding-agent/bench/memory-baseline-session-child.ts"],
		]) {
			const runner = {
				...report.runner,
				command: argv.join(" "),
				runtimeCommand: argv.join(" "),
				argv,
				runtimeControlIdentity: "",
			};
			runner.runtimeControlIdentity = memoryRuntimeControlIdentity(runner);
			expect(validatePerfCorpusReport({ ...report, runner }).errors).toContain(
				"runner.argv must begin with bun and contain only logical repository-relative values",
			);
		}
	});

	test("rejects unexpected and provider/private fields across the report taxonomy", () => {
		const report = runPerfCorpusBenchmark();
		const topLevel = { ...report, provider: "private" } as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(topLevel).errors).toContain("report.provider is not allowed");

		const fixture = report.fixtures[0];
		if (!fixture) throw new Error("fixture unavailable");
		const fixturePrivate = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							provider: { payload: "private" },
							privacy: { ...candidate.privacy, privateTranscript: "private" },
							sourceClass: "provider-private",
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		const privateErrors = validatePerfCorpusReport(fixturePrivate).errors;
		expect(privateErrors).toContain(`fixture ${fixture.fixtureId}.provider is not allowed`);
		expect(privateErrors).toContain(`fixture ${fixture.fixtureId}.privacy.privateTranscript is not allowed`);
		expect(privateErrors).toContain(`fixture ${fixture.fixtureId}: sourceClass invalid`);

		const unexpectedEnvironment = {
			...report,
			runner: {
				...report.runner,
				environment: { ...report.runner.environment, PROVIDER_API_KEY: "private" },
			},
		};
		expect(validatePerfCorpusReport(unexpectedEnvironment).errors).toContain(
			"runner.environment contains unexpected capture controls",
		);

		const baselineFixture = report.fixtures.find(candidate => candidate.memoryBaseline);
		if (!baselineFixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = baselineFixture.memoryBaseline;
		const unexpectedSample = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === baselineFixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								periodicSamples: [
									{ ...baseline.periodicSamples[0], providerResponse: "private" },
									...baseline.periodicSamples.slice(1),
								],
							},
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(unexpectedSample).errors).toContain(
			`fixture ${baselineFixture.fixtureId}.memoryBaseline sample 0.providerResponse is not allowed`,
		);

		const wrongCaptureSemantics = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === baselineFixture
					? {
							...candidate,
							memoryBaseline: { ...baseline, captureSemanticsId: "unstable" },
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(wrongCaptureSemantics).errors).toContain(
			`fixture ${baselineFixture.fixtureId}: memoryBaseline.captureSemanticsId invalid`,
		);
	});

	test("emits detailed memory baselines for every required product surface", () => {
		const report = runPerfCorpusBenchmark();
		const baselines = report.fixtures.flatMap(fixture => (fixture.memoryBaseline ? [fixture.memoryBaseline] : []));
		expect(new Set(baselines.map(baseline => baseline.surface))).toEqual(new Set(REQUIRED_MEMORY_SURFACES));
		expect(report.runner.profile).toBe("short");
		expect(report.runner.memoryIsolation).toBe("process-per-surface");
		expect(report.runner.memorySurfaceOrder).toEqual([...REQUIRED_MEMORY_SURFACES]);
		for (const baseline of baselines) {
			expect(baseline.ordinal).toBe(report.runner.memorySurfaceOrder.indexOf(baseline.surface));
			expect(baseline.childPid).not.toBe(report.runner.runnerPid);
			expect(baseline.parentPid).toBe(report.runner.runnerPid);
			expect(baseline.captureSemanticsId).toBe(MEMORY_CAPTURE_SEMANTICS_ID);
			expect(baseline.periodicSamples.length).toBeGreaterThanOrEqual(2);
			expect(baseline.postTeardown.elapsedMs).toBeGreaterThanOrEqual(
				baseline.periodicSamples.at(-1)?.elapsedMs ?? 0,
			);
			const fixture = report.fixtures.find(candidate => candidate.memoryBaseline === baseline);
			if (!fixture) throw new Error(`fixture unavailable for ${baseline.surface}`);
			const finalPeriodic = baseline.periodicSamples.at(-1);
			if (!finalPeriodic) throw new Error(`final periodic sample unavailable for ${baseline.surface}`);
			expect(fixture.wallClockPhase.run?.elapsedMs).toBe(finalPeriodic.elapsedMs);
			expect(Object.keys(baseline.observedExtrema).sort()).toEqual(
				["rssBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes"].sort(),
			);
			for (const domain of ["rssBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes"] as const) {
				const extremum = baseline.observedExtrema[domain];
				expect(extremum.elapsedMs).toBeLessThanOrEqual(finalPeriodic.elapsedMs);
				const periodicMaximum = Math.max(...baseline.periodicSamples.map(sample => sample[domain]));
				expect(extremum.valueBytes).toBeGreaterThanOrEqual(periodicMaximum);
			}
			expect(fixture.rssMemory.peakBytes).toBe(baseline.observedExtrema.rssBytes.valueBytes);
			expect(fixture.rssMemory.growthBytes).toBe(
				baseline.observedExtrema.rssBytes.valueBytes - baseline.periodicSamples[0]!.rssBytes,
			);
			expect(baseline.sampling.periodicCadenceTargetMs).toBe(0);
			expect(baseline.sampling.highWaterCadenceTargetMs).toBe(0);
			expect(baseline.sampling.highWaterCallbacks).toBe(
				baseline.sampling.highWaterProbes + baseline.sampling.throttledHighWaterCallbacks,
			);
			if (process.platform === "darwin" || process.platform === "linux") {
				expect(["ps", "unavailable"]).toContain(baseline.processTreeSampler);
				if (baseline.processTreeSampler === "ps") {
					expect(baseline.processTreeBaselineRssBytes).toBeGreaterThan(0);
					expect(baseline.processTreePostTeardownRssBytes).toBeGreaterThan(0);
				} else {
					expect(baseline.processTreeBaselineRssBytes).toBeNull();
					expect(baseline.processTreePostTeardownRssBytes).toBeNull();
				}
			}
			expect(Number.isFinite(baseline.operationsPerSecond)).toBe(true);
			expect(baseline.periodicSamples.every(sample => sample.externalBytes >= sample.arrayBuffersBytes)).toBe(true);
			expect(baseline.rssSlopeBytesPerSecond === null || Number.isFinite(baseline.rssSlopeBytesPerSecond)).toBe(
				true,
			);
			expect(baseline.heapSlopeBytesPerSecond === null || Number.isFinite(baseline.heapSlopeBytesPerSecond)).toBe(
				true,
			);
			expect(baseline.postTeardown.rssBytes).toBeGreaterThan(0);
		}
	});

	test("uses the canonical memory surface order for isolated runs without an explicit order", () => {
		expect(process.env.GJC_MEMORY_SURFACE_ORDER).toBeUndefined();
		const report = runPerfCorpusBenchmark({ isolatedMemory: true });
		const baselines = report.fixtures.flatMap(fixture => (fixture.memoryBaseline ? [fixture.memoryBaseline] : []));
		expect(baselines.map(baseline => baseline.surface)).toEqual([...REQUIRED_MEMORY_SURFACES]);
		expect(report.runner.memorySurfaceOrder).toEqual([...REQUIRED_MEMORY_SURFACES]);
		expect(report.runner.environment.GJC_MEMORY_SURFACE_ORDER).toBe(REQUIRED_MEMORY_SURFACES.join(","));
	}, 15_000);

	test("isolates each memory surface in a fresh Bun process using the preregistered order", () => {
		const customOrder = [...REQUIRED_MEMORY_SURFACES].reverse();
		process.env.GJC_MEMORY_SURFACE_ORDER = customOrder.join(",");
		const report = runPerfCorpusBenchmark({ isolatedMemory: true });
		const baselines = report.fixtures.flatMap(fixture => (fixture.memoryBaseline ? [fixture.memoryBaseline] : []));
		expect(baselines).toHaveLength(REQUIRED_MEMORY_SURFACES.length);
		expect(baselines.map(baseline => baseline.surface)).toEqual(customOrder);
		expect(report.runner.memoryIsolation).toBe("process-per-surface");
		expect(report.runner.memorySurfaceOrder).toEqual(customOrder);
		expect(report.runner.argv).toEqual(expectedPublicRunnerArgv());
		expect(report.runner.memoryChildExecArgv).toEqual(["--smol", "--expose-gc"]);
		expect(report.runner.environment).toEqual({
			GJC_MEMORY_PROFILE: "short",
			GJC_MEMORY_ITERATIONS: String(report.runner.iterationsTarget),
			GJC_MEMORY_SURFACE_ORDER: customOrder.join(","),
		});
		expect(report.runner.gcExposed).toBe(typeof globalThis.gc === "function");
		expect(report.runner.memoryChildGcExposed).toBe(true);
		expect(baselines.every(baseline => baseline.periodicSamples[0]!.rssBytes > 0)).toBe(true);
		expect(new Set(baselines.map(baseline => baseline.childPid)).size).toBe(REQUIRED_MEMORY_SURFACES.length);
		expect(new Set(baselines.map(baseline => baseline.parentPid))).toEqual(new Set([report.runner.runnerPid]));
		expect(baselines.map(baseline => baseline.ordinal)).toEqual(customOrder.map((_, index) => index));
		expect(baselines.every(baseline => baseline.childPid !== report.runner.runnerPid)).toBe(true);
		expect(validatePerfCorpusReport(report)).toEqual({ ok: true, errors: [] });

		const fixtureOrderMismatch = {
			...report,
			fixtures: [
				...report.fixtures.filter(fixture => !fixture.memoryBaseline),
				...report.fixtures.filter(fixture => fixture.memoryBaseline).reverse(),
			],
		};
		expect(validatePerfCorpusReport(fixtureOrderMismatch).errors).toContain(
			"memory baseline order must match runner.memorySurfaceOrder for process-per-surface",
		);

		const firstChildPid = baselines[0]?.childPid;
		if (!firstChildPid) throw new Error("isolated child PID unavailable");
		const duplicateChildPid: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate.memoryBaseline?.ordinal === 1
					? {
							...candidate,
							memoryBaseline: { ...candidate.memoryBaseline, childPid: firstChildPid },
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(duplicateChildPid).errors).toContain(
			"isolated memory baseline child PIDs must be distinct",
		);

		const wrongParent: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate.memoryBaseline?.ordinal === 0
					? {
							...candidate,
							memoryBaseline: { ...candidate.memoryBaseline, parentPid: report.runner.runnerPid + 1 },
						}
					: candidate,
			),
		};
		const wrongParentErrors = validatePerfCorpusReport(wrongParent).errors;
		expect(wrongParentErrors).toContain("memory baseline surfaces must have exactly one parent PID");
		expect(wrongParentErrors).toContain("isolated memory baseline process tree does not match runner PID");

		const wrongOrdinal: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate.memoryBaseline?.ordinal === 0
					? {
							...candidate,
							memoryBaseline: { ...candidate.memoryBaseline, ordinal: 1 },
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(wrongOrdinal).errors).toContain(
			"memory baseline ordinal/surface identity must match runner.memorySurfaceOrder",
		);
	}, 15_000);

	test("rejects malformed explicit process-per-surface orders without normalization", () => {
		const canonicalOrder = REQUIRED_MEMORY_SURFACES.join(",");
		const malformedOrders = [
			"",
			"cli",
			`${canonicalOrder},`,
			canonicalOrder.replace("shared-native", "cli"),
			canonicalOrder.replace("shared-native", "unknown"),
			canonicalOrder.replace("agent-session", " agent-session"),
		];
		for (const malformedOrder of malformedOrders) {
			process.env.GJC_MEMORY_SURFACE_ORDER = malformedOrder;
			expect(() => runPerfCorpusBenchmark({ isolatedMemory: true })).toThrow(
				"GJC_MEMORY_SURFACE_ORDER must be an exact comma-separated permutation",
			);
		}
	});

	test("fails closed when a required surface or detailed sample is invalid or incomplete", () => {
		const report = runPerfCorpusBenchmark();
		const withoutTui: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.filter(fixture => fixture.memoryBaseline?.surface !== "tui"),
		};
		expect(validatePerfCorpusReport(withoutTui).errors).toContain('memory baseline missing required surface "tui"');

		const fixtureIndex = report.fixtures.findIndex(fixture => fixture.memoryBaseline);
		const fixture = report.fixtures[fixtureIndex];
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const tampered: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								periodicSamples: [{ ...baseline.periodicSamples[0]!, rssBytes: Number.NaN }],
							},
						}
					: candidate,
			),
		};
		const validation = validatePerfCorpusReport(tampered);
		expect(validation.ok).toBe(false);
		expect(validation.errors.some(error => error.includes("requires at least two periodicSamples"))).toBe(true);
		expect(validation.errors.some(error => error.includes(".rssBytes invalid"))).toBe(true);
		const incompleteSample: Partial<MemoryUsageSample> = { ...baseline.periodicSamples[0] };
		delete incompleteSample.heapUsedBytes;
		const incomplete: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								periodicSamples: [incompleteSample as MemoryUsageSample, baseline.periodicSamples[1]!],
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(incomplete).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline sample 0.heapUsedBytes invalid`,
		);
	});
	test("rejects non-object memory samples without throwing", () => {
		const report = runPerfCorpusBenchmark();
		const fixtureIndex = report.fixtures.findIndex(fixture => fixture.memoryBaseline);
		const fixture = report.fixtures[fixtureIndex];
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const malformed = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								periodicSamples: [baseline.periodicSamples[0], null],
							},
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		const malformedResult = validatePerfCorpusReport(malformed);
		expect(malformedResult.ok).toBe(false);
		expect(malformedResult.errors).toContain(`fixture ${fixture.fixtureId}: memoryBaseline sample 1 invalid`);
		const malformedTeardown = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: { ...baseline, postTeardown: null },
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		const malformedTeardownResult = validatePerfCorpusReport(malformedTeardown);
		expect(malformedTeardownResult.ok).toBe(false);
		expect(malformedTeardownResult.errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline sample ${baseline.periodicSamples.length} invalid`,
		);
		const earlyTeardown = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								postTeardown: { ...baseline.postTeardown, elapsedMs: 0 },
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(earlyTeardown).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline postTeardown predates periodicSamples`,
		);
	});

	test("accepts Bun heap accounting while rejecting impossible external memory fields", () => {
		const report = runPerfCorpusBenchmark();
		const fixture = report.fixtures.find(candidate => candidate.memoryBaseline);
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const sampleIndex = baseline.periodicSamples.length - 1;
		const sample = baseline.periodicSamples[sampleIndex];
		const bunSample = { ...sample, heapUsedBytes: sample.heapTotalBytes + 1 };
		const periodicSamples = baseline.periodicSamples.map((candidate, index) =>
			index === sampleIndex ? bunSample : candidate,
		);
		const observedExtrema = {
			rssBytes: { ...baseline.observedExtrema.rssBytes },
			heapUsedBytes: { ...baseline.observedExtrema.heapUsedBytes },
			externalBytes: { ...baseline.observedExtrema.externalBytes },
			arrayBuffersBytes: { ...baseline.observedExtrema.arrayBuffersBytes },
		};
		updateMemoryObservedExtrema(observedExtrema, bunSample);
		const bunCounterexample = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								periodicSamples,
								observedExtrema,
								heapSlopeBytesPerSecond: calculateMemorySlope(periodicSamples, "heapUsedBytes"),
							},
						}
					: candidate,
			),
		} satisfies PerfCorpusReport;
		expect(validatePerfCorpusReport(bunCounterexample)).toEqual({ ok: true, errors: [] });

		const impossible = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								periodicSamples: baseline.periodicSamples.map((candidate, index) =>
									index === sampleIndex
										? { ...candidate, externalBytes: candidate.arrayBuffersBytes - 1 }
										: candidate,
								),
							},
						}
					: candidate,
			),
		} satisfies PerfCorpusReport;
		const impossibleResult = validatePerfCorpusReport(impossible);
		expect(impossibleResult.ok).toBe(false);
		expect(impossibleResult.errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline sample ${sampleIndex} arrayBuffersBytes exceeds externalBytes`,
		);
	});

	test("rejects malformed, tampered, and out-of-lifecycle observed extrema", () => {
		const report = runPerfCorpusBenchmark();
		const fixture = report.fixtures.find(candidate => candidate.memoryBaseline);
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const finalElapsedMs = baseline.periodicSamples.at(-1)?.elapsedMs ?? 0;
		const malformedShape = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								observedExtrema: {
									...baseline.observedExtrema,
									bogusBytes: { valueBytes: 1, elapsedMs: 0 },
								},
							},
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(malformedShape).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema must contain exactly four memory domains`,
		);
		const mixedChannels = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								samples: baseline.periodicSamples,
							},
						}
					: candidate,
			),
		} as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(mixedChannels).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.samples is not allowed in schema v3`,
		);

		const lateExtremum: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								observedExtrema: {
									...baseline.observedExtrema,
									heapUsedBytes: {
										...baseline.observedExtrema.heapUsedBytes,
										elapsedMs: finalElapsedMs + 1,
									},
								},
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(lateExtremum).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema.heapUsedBytes outside measurement lifecycle`,
		);

		const belowPeriodic: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								observedExtrema: {
									...baseline.observedExtrema,
									externalBytes: { valueBytes: 0, elapsedMs: 0 },
								},
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(belowPeriodic).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.observedExtrema.externalBytes below periodic observation`,
		);

		const tamperedRss: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								observedExtrema: {
									...baseline.observedExtrema,
									rssBytes: {
										valueBytes: baseline.observedExtrema.rssBytes.valueBytes + 1,
										elapsedMs: baseline.observedExtrema.rssBytes.elapsedMs,
									},
								},
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(tamperedRss).errors).toContain(
			`fixture ${fixture.fixtureId}: rssMemory.peakBytes does not match periodic/extrema evidence`,
		);
	});
	test("keeps independent observed extrema without contaminating periodic slopes and retains earliest ties", () => {
		const sample = (
			elapsedMs: number,
			rssBytes: number,
			heapUsedBytes: number,
			externalBytes: number,
			arrayBuffersBytes: number,
		): MemoryUsageSample => ({
			elapsedMs,
			rssBytes,
			heapUsedBytes,
			heapTotalBytes: Math.max(heapUsedBytes, 1_000),
			externalBytes,
			arrayBuffersBytes,
			activeResourceCount: 0,
		});
		const periodicSamples = [
			sample(0, 100, 100, 100, 50),
			sample(500, 150, 150, 110, 55),
			sample(1_000, 200, 200, 120, 60),
		];
		const extrema = {
			rssBytes: { valueBytes: 100, elapsedMs: 0 },
			heapUsedBytes: { valueBytes: 100, elapsedMs: 0 },
			externalBytes: { valueBytes: 100, elapsedMs: 0 },
			arrayBuffersBytes: { valueBytes: 50, elapsedMs: 0 },
		};
		const slopeBeforeExtrema = calculateMemorySlope(periodicSamples, "rssBytes");
		for (const candidate of [
			sample(100, 900, 110, 110, 55),
			sample(200, 800, 700, 120, 60),
			sample(300, 700, 600, 500, 70),
			sample(400, 600, 500, 450, 400),
			sample(450, 900, 700, 500, 400),
		]) {
			updateMemoryObservedExtrema(extrema, candidate);
		}

		expect(extrema).toEqual({
			rssBytes: { valueBytes: 900, elapsedMs: 100 },
			heapUsedBytes: { valueBytes: 700, elapsedMs: 200 },
			externalBytes: { valueBytes: 500, elapsedMs: 300 },
			arrayBuffersBytes: { valueBytes: 400, elapsedMs: 400 },
		});
		expect(periodicSamples).toHaveLength(3);
		expect(calculateMemorySlope(periodicSamples, "rssBytes")).toBe(slopeBeforeExtrema);
	});
	test("forces a TUI high-water callback after every render and before teardown", () => {
		const workload = createTuiWorkload();
		const forceValues: Array<boolean | undefined> = [];
		workload.run(3, force => forceValues.push(force));
		expect(forceValues).toEqual([true, true, true]);
		expect(workload.currentIndex()).toBe(3);
		workload.teardown();
	});
	test("forces a session sample after entry materialization", () => {
		const workload = createSessionWorkload();
		const forceValues: Array<boolean | undefined> = [];
		workload.run(128, force => forceValues.push(force));
		expect(forceValues).toHaveLength(129);
		expect(forceValues.at(-1)).toBe(true);
		workload.teardown();
	});

	test("rejects an empty corpus instead of skipping required memory surfaces", () => {
		const report = runPerfCorpusBenchmark();
		const empty = { ...report, fixtures: [] };
		const errors = validatePerfCorpusReport(empty).errors;
		for (const surface of REQUIRED_MEMORY_SURFACES) {
			expect(errors).toContain(`memory baseline missing required surface "${surface}"`);
		}
	});

	test("admits zero and near-zero negative slopes as non-positive steady-state evidence", () => {
		const sample = (elapsedMs: number, rssBytes: number): MemoryUsageSample => ({
			elapsedMs,
			rssBytes,
			heapUsedBytes: rssBytes,
			heapTotalBytes: rssBytes,
			externalBytes: 0,
			arrayBuffersBytes: 0,
			activeResourceCount: 0,
		});
		const stabilizedAfterWarmup = [
			sample(0, 100),
			sample(200, 200),
			sample(400, 200),
			sample(600, 200),
			sample(800, 200),
			sample(1_000, 200),
		];
		expect(calculateMemorySlope(stabilizedAfterWarmup, "rssBytes")).toBe(0);
		const nearZeroDecline = [sample(0, 200), sample(250, 200), sample(1_000_250, 199)];
		expect(calculateMemorySlope(nearZeroDecline, "rssBytes")).toBeCloseTo(-0.001, 12);
		const growingSteadyState = [
			sample(0, 100),
			sample(200, 200),
			sample(400, 200),
			sample(600, 220),
			sample(800, 240),
			sample(1_000, 260),
		];
		expect(calculateMemorySlope(growingSteadyState, "rssBytes")).toBe(100);
		expect(calculateMemorySlope([sample(0, 100), sample(200, 200)], "rssBytes")).toBeNull();
	});
	test("validates serialized zero/near-zero slopes as non-positive evidence", () => {
		const report = runPerfCorpusBenchmark();
		const fixture = report.fixtures.find(candidate => candidate.memoryBaseline);
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const first = baseline.periodicSamples[0];
		if (!first) throw new Error("baseline sample unavailable");
		const durationMs = 1_000_250;
		const finalIndex = baseline.periodicSamples.length - 1;
		const periodicSamples = baseline.periodicSamples.map((sample, index) => ({
			...sample,
			elapsedMs: index === finalIndex ? durationMs : (durationMs * index) / finalIndex,
			rssBytes: index === finalIndex ? first.rssBytes - 1 : first.rssBytes,
			heapUsedBytes: index === finalIndex ? first.heapUsedBytes - 1 : first.heapUsedBytes,
		}));
		const rssSlopeBytesPerSecond = calculateMemorySlope(periodicSamples, "rssBytes");
		const heapSlopeBytesPerSecond = calculateMemorySlope(periodicSamples, "heapUsedBytes");
		if (rssSlopeBytesPerSecond === null || heapSlopeBytesPerSecond === null) {
			throw new Error("near-zero slope unavailable");
		}
		expect(rssSlopeBytesPerSecond).toBeLessThanOrEqual(0);
		expect(heapSlopeBytesPerSecond).toBeLessThanOrEqual(0);
		expect(Math.abs(rssSlopeBytesPerSecond)).toBeLessThan(1);
		const serializedEvidence: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							wallClockPhase: {
								...candidate.wallClockPhase,
								run: { ...candidate.wallClockPhase.run!, elapsedMs: durationMs },
							},
							memoryBaseline: {
								...baseline,
								operationsPerSecond: baseline.operations / (durationMs / 1_000),
								periodicSamples,
								postTeardown: { ...baseline.postTeardown, elapsedMs: durationMs },
								rssSlopeBytesPerSecond,
								heapSlopeBytesPerSecond,
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(serializedEvidence)).toEqual({ ok: true, errors: [] });
	});
	test("rejects reported slopes that do not match the raw samples", () => {
		const report = runPerfCorpusBenchmark();
		const fixtureIndex = report.fixtures.findIndex(fixture => fixture.memoryBaseline);
		const fixture = report.fixtures[fixtureIndex];
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const tampered: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								rssSlopeBytesPerSecond: (baseline.rssSlopeBytesPerSecond ?? 0) + 1,
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(tampered).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.rssSlopeBytesPerSecond does not match periodicSamples`,
		);
	});
	test("preserves stateful workload indices across sampling chunks", () => {
		const workload = createMemoryBaselineWorkloads().find(candidate => candidate.surface === "shared-native");
		if (!workload) throw new Error("shared-native workload unavailable");
		expect(workload.run(1)).toBe(4_096);
		expect(workload.run(1)).toBe(4_224);
		workload.teardown();
		expect(workload.run(1)).toBe(4_096);
	});
	test("preserves TUI workload indices across sampling chunks", () => {
		const workload = createTuiWorkload();
		expect(workload.currentIndex()).toBe(0);
		expect(workload.run(1)).toBe(3);
		expect(workload.currentIndex()).toBe(1);
		expect(workload.run(1)).toBe(3);
		expect(workload.currentIndex()).toBe(2);
		workload.teardown();
		expect(workload.currentIndex()).toBe(0);
	});
	test("rejects malformed memory scalar fields and isolation metadata", () => {
		const report = runPerfCorpusBenchmark();
		const fixtureIndex = report.fixtures.findIndex(fixture => fixture.memoryBaseline);
		const fixture = report.fixtures[fixtureIndex];
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const validBaseline = fixture.memoryBaseline;
		const malformedBaseline = {
			...fixture.memoryBaseline,
			surface: "bogus",
			profile: "bogus",
			operations: null,
			operationsPerSecond: Number.POSITIVE_INFINITY,
			rssSlopeBytesPerSecond: Number.NaN,
			processTreeSampler: "bogus",
		} as unknown as typeof fixture.memoryBaseline;
		const malformed = {
			...report,
			runner: { ...report.runner, memoryIsolation: "bogus" },
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex ? { ...candidate, memoryBaseline: malformedBaseline } : candidate,
			),
		} as unknown as PerfCorpusReport;
		const errors = validatePerfCorpusReport(malformed).errors;
		expect(errors).toContain("runner.memoryIsolation invalid");
		expect(errors).toContain(`fixture ${fixture.fixtureId}: memoryBaseline.surface invalid`);
		expect(errors).toContain(`fixture ${fixture.fixtureId}: memoryBaseline.profile invalid`);
		expect(errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.operations must be a non-negative integer`,
		);
		expect(errors).toContain(`fixture ${fixture.fixtureId}: memoryBaseline.operationsPerSecond not finite`);
		expect(errors).toContain(`fixture ${fixture.fixtureId}: memoryBaseline.rssSlopeBytesPerSecond invalid`);
		expect(errors).toContain(`fixture ${fixture.fixtureId}: memoryBaseline.processTreeSampler invalid`);
		const profileMismatch = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: { ...validBaseline, profile: "soak" as const },
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(profileMismatch).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.profile must match runner.profile`,
		);
		const v2Schema = { ...report, schema: "gjc.perf-corpus/2" } as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(v2Schema).errors).toContain(
			'schema "gjc.perf-corpus/2" is incompatible with the v3 validator; expected "gjc.perf-corpus/3"',
		);
		const missingRunnerProfile = {
			...report,
			runner: { ...report.runner, profile: undefined },
		} as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(missingRunnerProfile).errors).toContain("runner.profile invalid");
		const invalidSoakDuration = {
			...report,
			runner: {
				...report.runner,
				profile: "soak" as const,
				durationTargetMs: 0,
				environment: {
					GJC_MEMORY_PROFILE: "soak",
					GJC_MEMORY_ITERATIONS: String(report.runner.iterationsTarget),
					GJC_MEMORY_DURATION_MS: "0",
				},
			},
		};
		expect(validatePerfCorpusReport(invalidSoakDuration).errors).toContain(
			"runner.durationTargetMs does not match profile bounds",
		);
		const missingMemoryChildGc = {
			...report,
			runner: { ...report.runner, memoryChildGcExposed: undefined },
		} as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(missingMemoryChildGc).errors).toContain("runner.memoryChildGcExposed invalid");
		const missingMemoryChildArgv = {
			...report,
			runner: { ...report.runner, memoryChildExecArgv: ["--smol"] },
		};
		expect(validatePerfCorpusReport(missingMemoryChildArgv).errors).toContain("runner.memoryChildExecArgv invalid");
		const insufficientIterations = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex ? { ...candidate, memoryBaseline: { ...validBaseline, iterations: 1 } } : candidate,
			),
		};
		expect(validatePerfCorpusReport(insufficientIterations).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.iterations below runner target`,
		);
		const inconsistentSummary = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							rssMemory: { ...candidate.rssMemory, growthBytes: candidate.rssMemory.growthBytes + 1 },
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(inconsistentSummary).errors).toContain(
			`fixture ${fixture.fixtureId}: rssMemory.growthBytes does not match periodic/extrema evidence`,
		);
		const firstSample = validBaseline.periodicSamples[0];
		const oversizedSamples = Array.from({ length: 1_000_000 }, () => firstSample);
		oversizedSamples[543_210] = { ...firstSample, rssBytes: firstSample.rssBytes + 1 };
		const oversizedPersistedReport = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							rssMemory: {
								...candidate.rssMemory,
								baselineBytes: firstSample.rssBytes,
								peakBytes: firstSample.rssBytes + 1,
								growthBytes: 1,
							},
							memoryBaseline: {
								...validBaseline,
								periodicSamples: oversizedSamples,
								rssSlopeBytesPerSecond: null,
								heapSlopeBytesPerSecond: null,
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(oversizedPersistedReport).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.periodicSamples exceeds cadence bound`,
		);
		const inconsistentThroughput = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...validBaseline,
								operationsPerSecond: validBaseline.operationsPerSecond + 1,
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(inconsistentThroughput).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline.operationsPerSecond does not match operations`,
		);
		const invalidSurfaceOrder = {
			...report,
			runner: {
				...report.runner,
				memorySurfaceOrder: [
					...REQUIRED_MEMORY_SURFACES.slice(0, -1),
					"cli",
				] as PerfCorpusReport["runner"]["memorySurfaceOrder"],
			},
		};
		expect(validatePerfCorpusReport(invalidSurfaceOrder).errors).toContain(
			"runner.memorySurfaceOrder must be an exact permutation of required memory surfaces",
		);
		const mismatchedSurfaceEnvironment = {
			...report,
			runner: {
				...report.runner,
				environment: {
					...report.runner.environment,
					GJC_MEMORY_SURFACE_ORDER: [...REQUIRED_MEMORY_SURFACES].reverse().join(","),
				},
			},
		};
		expect(validatePerfCorpusReport(mismatchedSurfaceEnvironment).errors).toContain(
			"runner.environment does not match memory controls",
		);
		const mismatchedEnvironment = {
			...report,
			runner: {
				...report.runner,
				memoryIsolation: "process-per-surface" as const,
				environment: { GJC_MEMORY_PROFILE: "soak", GJC_MEMORY_ITERATIONS: "1" },
			},
		};
		expect(validatePerfCorpusReport(mismatchedEnvironment).errors).toContain(
			"runner.environment does not match memory controls",
		);
		const gcUnavailableWithReturns = {
			...report,
			runner: { ...report.runner, gcExposed: false, memoryChildGcExposed: false },
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							rssMemory: { ...candidate.rssMemory, returnBytes: 1, heapReturnBytes: 1 },
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(gcUnavailableWithReturns).errors).toContain(
			`fixture ${fixture.fixtureId}: unavailable memory GC requires null return metrics`,
		);
		const gcExposedWithoutReturns = {
			...report,
			runner: { ...report.runner, gcExposed: true, memoryChildGcExposed: true },
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							rssMemory: { ...candidate.rssMemory, returnBytes: null, heapReturnBytes: null },
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(gcExposedWithoutReturns).errors).toContain(
			`fixture ${fixture.fixtureId}: exposed memory GC requires post-GC return metrics`,
		);
	});

	test("normalizes partial process-table failures to unavailable endpoints", () => {
		expect(normalizeProcessTreeRss(1_024, null)).toEqual({
			baselineBytes: null,
			postTeardownBytes: null,
			sampler: "unavailable",
		});
		expect(normalizeProcessTreeRss(null, 2_048)).toEqual({
			baselineBytes: null,
			postTeardownBytes: null,
			sampler: "unavailable",
		});
		expect(normalizeProcessTreeRss(1_024, 2_048)).toEqual({
			baselineBytes: 1_024,
			postTeardownBytes: 2_048,
			sampler: "ps",
		});
	});

	test("the base runner attaches no profiler, so no hotspot is CPU-self-time confirmed", () => {
		const report = runPerfCorpusBenchmark();
		expect(report.fixtures.every(f => f.profilerSelfTime.profiler === "none")).toBe(true);
		expect(report.fixtures.some(f => hasProfilerSelfTimeEvidence(f.profilerSelfTime))).toBe(false);
		expect(report.hotspotClassifications.some(c => c.status === "CPU-self-time confirmed")).toBe(false);
		expect(validatePerfCorpusReport(report).ok).toBe(true);
	});
});

describe("classification validation rejects CPU-self-time overclaiming", () => {
	test("a CPU-self-time confirmed classification without profiler evidence class/artifact is rejected", () => {
		const bad: HotspotClassification = {
			hotspotId: "HX",
			status: "CPU-self-time confirmed",
			evidenceClass: "wall-clock-proxy",
			artifactRefs: [],
			notes: "wall-clock only",
		};
		const errors = validateHotspotClassification(bad);
		expect(errors.length).toBeGreaterThan(0);
	});

	test("validatePerfCorpusReport rejects CPU-self-time confirmed when the corpus has no profiler artifacts", () => {
		const report = runPerfCorpusBenchmark();
		const tampered: PerfCorpusReport = {
			...report,
			hotspotClassifications: [
				{
					hotspotId: "H01",
					status: "CPU-self-time confirmed",
					evidenceClass: "profiler-self-time",
					artifactRefs: ["fabricated.json"],
					notes: "claims confirmed without corpus evidence",
				},
			],
		};
		const result = validatePerfCorpusReport(tampered);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("match captured profiler evidence"))).toBe(true);
	});

	test("validatePerfCorpusReport accepts CPU-self-time confirmed once a profiler artifact exists", () => {
		const report = runPerfCorpusBenchmark();
		const withProfiler: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((f, i) =>
				i === 0
					? {
							...f,
							profilerSelfTime: {
								profiler: "bun",
								artifactPath: "artifacts/profile.cpuprofile",
								samples: [{ symbol: "findMatch", selfTimeMs: 12.3 }],
							},
						}
					: f,
			),
			hotspotClassifications: [
				{
					hotspotId: "H01",
					status: "CPU-self-time confirmed",
					evidenceClass: "profiler-self-time",
					artifactRefs: ["artifacts/profile.cpuprofile"],
					notes: "profiler confirms self-time",
				},
			],
		};
		const result = validatePerfCorpusReport(withProfiler);
		expect(result.ok).toBe(true);
	});

	test("rejects a CPU-self-time claim whose artifactRef does not match the captured profiler evidence", () => {
		const report = runPerfCorpusBenchmark();
		const mismatched: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((f, i) =>
				i === 0
					? {
							...f,
							profilerSelfTime: {
								profiler: "bun",
								artifactPath: "artifacts/real.cpuprofile",
								samples: [{ symbol: "findMatch", selfTimeMs: 9 }],
							},
						}
					: f,
			),
			hotspotClassifications: [
				{
					hotspotId: "H02",
					status: "CPU-self-time confirmed",
					evidenceClass: "profiler-self-time",
					artifactRefs: ["artifacts/unrelated.cpuprofile"],
					notes: "unrelated artifact ref",
				},
			],
		};
		const result = validatePerfCorpusReport(mismatched);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("match captured profiler evidence"))).toBe(true);
	});

	test("a fixture with profiler 'none' cannot anchor a CPU-self-time claim even with a stray artifactPath/samples", () => {
		const report = runPerfCorpusBenchmark();
		const inconsistent: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((f, i) =>
				i === 0
					? {
							...f,
							profilerSelfTime: {
								profiler: "none",
								artifactPath: "artifacts/stray.cpuprofile",
								samples: [{ symbol: "strayFn", selfTimeMs: 5 }],
							},
						}
					: f,
			),
			hotspotClassifications: [
				{
					hotspotId: "H03",
					status: "CPU-self-time confirmed",
					evidenceClass: "profiler-self-time",
					artifactRefs: ["artifacts/stray.cpuprofile"],
					notes: "anchored to a profiler:none fixture",
				},
			],
		};
		const result = validatePerfCorpusReport(inconsistent);
		expect(result.ok).toBe(false);
		expect(result.errors.some(e => e.includes("match captured profiler evidence"))).toBe(true);
	});
});

describe("v1-v3 reclassification uses only the new vocabulary and never overclaims", () => {
	test("every entry has a valid status and none is CPU-self-time confirmed (no profiler corpus yet)", () => {
		expect(V1_V3_RECLASSIFICATION.length).toBe(16); // H01-H11 + M01-M05
		for (const c of V1_V3_RECLASSIFICATION) {
			expect(isHotspotStatus(c.status)).toBe(true);
			expect(validateHotspotClassification(c)).toEqual([]);
			expect(c.status).not.toBe("CPU-self-time confirmed");
		}
	});
});

describe("perf threshold ledger invariants", () => {
	test("all applied thresholds are valid and currently advisory-only", () => {
		expect(validatePerfThresholdLedger()).toEqual([]);
		expect(APPLIED_PERF_THRESHOLDS.every(t => t.advisoryOrEnforced === "advisory")).toBe(true);
		expect(HELD_PERF_THRESHOLDS.length).toBeGreaterThan(0);
	});

	test("an enforced threshold without benchmark + human approval evidence is rejected", () => {
		const errors = validatePerfThresholdLedger([
			{
				name: "bad.enforced",
				metricClass: "wall-clock-proxy",
				advisoryOrEnforced: "enforced",
				fixtureId: "startup-load",
				command: "bun packages/coding-agent/bench/perf-corpus.bench.ts",
				rationale: "enforced without evidence",
				varianceCharacterized: false,
			},
		]);
		expect(errors.length).toBeGreaterThan(0);
	});
});
