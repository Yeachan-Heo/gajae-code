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
	runPerfCorpusBenchmark,
	updateMemoryHighWaterSamples,
} from "../bench/perf-corpus.bench";
import {
	type HotspotClassification,
	hasProfilerSelfTimeEvidence,
	isHotspotStatus,
	type MemoryUsageSample,
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

// Mirrors resolveGitProvenance()'s repository-root resolution so precondition
// checks below never depend on the ambient process cwd (CI shard tasks run
// `bun test` with cwd pinned to a package subdirectory, not the repo root).
const repositoryRoot = path.resolve(import.meta.dir, "../../..");

const memoryControlKeys = ["GJC_MEMORY_PROFILE", "GJC_MEMORY_ITERATIONS", "GJC_MEMORY_DURATION_MS"] as const;
let originalMemoryControls = new Map<(typeof memoryControlKeys)[number], string | undefined>();

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
		const expectedParentArgv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
		expect(report.runner.command).toBe(expectedParentArgv.join(" "));
		expect(report.runner.argv).toEqual(expectedParentArgv);
		expect(report.runner.environment).toEqual({
			GJC_MEMORY_PROFILE: "short",
			GJC_MEMORY_ITERATIONS: String(report.runner.iterationsTarget),
		});
		expect(report.runner.iterationsTarget).toBeGreaterThan(0);
		expect(typeof report.runner.gcExposed).toBe("boolean");
		expect(report.runner.memoryChildExecArgv).toEqual([]);
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
	test("git provenance precondition survives a subdirectory ambient cwd (regression for dev CI run 30291963270)", () => {
		// CI runs coding-agent test shards with process cwd pinned to
		// packages/coding-agent (a subdirectory), not the repo root. This test
		// pins process.cwd() to that same subdirectory before invoking the
		// shared repositoryRoot-based precondition helper, so a future
		// regression that drops the explicit { cwd: repositoryRoot } option
		// (and silently falls back to ambient cwd) is caught even when this
		// suite happens to run from the repo root.
		const previousCwd = process.cwd();
		try {
			process.chdir(path.join(repositoryRoot, "packages", "coding-agent"));
			const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
			expect(revision.exitCode).toBe(0);
			expect(new TextDecoder().decode(revision.stdout).trim()).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			process.chdir(previousCwd);
		}
	});
	test("prefers checked-out HEAD over workflow SHA provenance", () => {
		const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
		if (revision.exitCode !== 0) {
			throw new Error(`git revision unavailable: ${new TextDecoder().decode(revision.stderr)}`);
		}
		const expectedSha = new TextDecoder().decode(revision.stdout).trim();
		const previousGitSha = process.env.GITHUB_SHA;
		process.env.GITHUB_SHA = "b".repeat(40);
		try {
			expect(runPerfCorpusBenchmark().gitSha).toBe(expectedSha);
		} finally {
			if (previousGitSha === undefined) delete process.env.GITHUB_SHA;
			else process.env.GITHUB_SHA = previousGitSha;
		}
	});
	test("falls back to GITHUB_SHA when Git is unavailable", () => {
		const previousGitSha = process.env.GITHUB_SHA;
		const spawnSync = vi.spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("git unavailable");
		});
		process.env.GITHUB_SHA = "c".repeat(40);
		try {
			expect(resolveGitProvenance()).toEqual({
				sha: "c".repeat(40),
				dirty: true,
				worktreeFingerprint: "unavailable",
			});
		} finally {
			spawnSync.mockRestore();
			if (previousGitSha === undefined) delete process.env.GITHUB_SHA;
			else process.env.GITHUB_SHA = previousGitSha;
		}
	});
	test("resolves provenance from the benchmark checkout instead of the caller cwd", () => {
		const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
		if (revision.exitCode !== 0) {
			throw new Error(`git revision unavailable: ${new TextDecoder().decode(revision.stderr)}`);
		}
		const expectedSha = new TextDecoder().decode(revision.stdout).trim();
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

	test("emits detailed memory baselines for every required product surface", () => {
		const report = runPerfCorpusBenchmark();
		const baselines = report.fixtures.flatMap(fixture => (fixture.memoryBaseline ? [fixture.memoryBaseline] : []));
		expect(new Set(baselines.map(baseline => baseline.surface))).toEqual(new Set(REQUIRED_MEMORY_SURFACES));
		expect(report.runner.profile).toBe("short");
		expect(report.runner.memoryIsolation).toBe("in-process");
		for (const baseline of baselines) {
			expect(baseline.samples.length).toBeGreaterThanOrEqual(2);
			expect(baseline.postTeardown.elapsedMs).toBeGreaterThanOrEqual(baseline.samples.at(-1)?.elapsedMs ?? 0);
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
			expect(baseline.samples.every(sample => sample.externalBytes >= sample.arrayBuffersBytes)).toBe(true);
			expect(baseline.rssSlopeBytesPerSecond === null || Number.isFinite(baseline.rssSlopeBytesPerSecond)).toBe(
				true,
			);
			expect(baseline.heapSlopeBytesPerSecond === null || Number.isFinite(baseline.heapSlopeBytesPerSecond)).toBe(
				true,
			);
			expect(baseline.postTeardown.rssBytes).toBeGreaterThan(0);
		}
	});

	test("isolates each memory surface in a fresh Bun process", () => {
		const report = runPerfCorpusBenchmark({ isolatedMemory: true });
		const baselines = report.fixtures.flatMap(fixture => (fixture.memoryBaseline ? [fixture.memoryBaseline] : []));
		expect(baselines).toHaveLength(REQUIRED_MEMORY_SURFACES.length);
		expect(report.runner.memoryIsolation).toBe("process-per-surface");
		expect(report.runner.argv).toEqual([process.execPath, ...process.execArgv, ...process.argv.slice(1)]);
		expect(report.runner.memoryChildExecArgv).toEqual(["--smol", "--expose-gc"]);
		expect(report.runner.environment).toEqual({
			GJC_MEMORY_PROFILE: "short",
			GJC_MEMORY_ITERATIONS: String(report.runner.iterationsTarget),
		});
		expect(report.runner.gcExposed).toBe(typeof globalThis.gc === "function");
		expect(report.runner.memoryChildGcExposed).toBe(true);
		expect(baselines.every(baseline => baseline.samples[0]!.rssBytes > 0)).toBe(true);
		expect(validatePerfCorpusReport(report)).toEqual({ ok: true, errors: [] });
	}, 15_000);

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
								samples: [{ ...baseline.samples[0]!, rssBytes: Number.NaN }],
							},
						}
					: candidate,
			),
		};
		const validation = validatePerfCorpusReport(tampered);
		expect(validation.ok).toBe(false);
		expect(validation.errors.some(error => error.includes("requires at least two samples"))).toBe(true);
		expect(validation.errors.some(error => error.includes(".rssBytes invalid"))).toBe(true);
		const incompleteSample: Partial<MemoryUsageSample> = { ...baseline.samples[0] };
		delete incompleteSample.heapUsedBytes;
		const incomplete: PerfCorpusReport = {
			...report,
			fixtures: report.fixtures.map((candidate, index) =>
				index === fixtureIndex
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								samples: [incompleteSample as MemoryUsageSample, baseline.samples[1]!],
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
								samples: [baseline.samples[0], null],
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
			`fixture ${fixture.fixtureId}: memoryBaseline sample ${baseline.samples.length} invalid`,
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
			`fixture ${fixture.fixtureId}: memoryBaseline postTeardown predates workload samples`,
		);
	});

	test("rejects physically impossible external-memory samples", () => {
		const report = runPerfCorpusBenchmark();
		const fixture = report.fixtures.find(candidate => candidate.memoryBaseline);
		if (!fixture?.memoryBaseline) throw new Error("memory baseline fixture unavailable");
		const baseline = fixture.memoryBaseline;
		const sample = baseline.samples[0];
		const impossible = {
			...report,
			fixtures: report.fixtures.map(candidate =>
				candidate === fixture
					? {
							...candidate,
							memoryBaseline: {
								...baseline,
								samples: [
									{ ...sample, externalBytes: sample.arrayBuffersBytes - 1 },
									...baseline.samples.slice(1),
								],
							},
						}
					: candidate,
			),
		} satisfies PerfCorpusReport;
		expect(validatePerfCorpusReport(impossible).errors).toContain(
			`fixture ${fixture.fixtureId}: memoryBaseline sample 0 arrayBuffersBytes exceeds externalBytes`,
		);
	});

	test("preserves independent per-metric high-water samples", () => {
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
		const baseline = sample(0, 100, 100, 100, 50);
		const peaks = { rss: baseline, heap: baseline, external: baseline, arrayBuffers: baseline };
		const rssPeak = sample(1, 900, 110, 110, 55);
		const heapPeak = sample(2, 800, 700, 120, 60);
		const externalPeak = sample(3, 700, 600, 500, 70);
		const arrayBufferPeak = sample(4, 600, 500, 450, 400);

		for (const candidate of [rssPeak, heapPeak, externalPeak, arrayBufferPeak]) {
			updateMemoryHighWaterSamples(peaks, candidate);
		}

		expect(peaks).toEqual({
			rss: rssPeak,
			heap: heapPeak,
			external: externalPeak,
			arrayBuffers: arrayBufferPeak,
		});
	});
	test("requests throttled TUI high-water callbacks before teardown", () => {
		const workload = createTuiWorkload();
		const forceValues: Array<boolean | undefined> = [];
		workload.run(3, force => forceValues.push(force));
		expect(forceValues).toEqual([undefined, undefined, undefined]);
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

	test("calculates slopes only from the steady-state window", () => {
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
	test("rejects reported slopes that do not match periodic slope samples", () => {
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
			`fixture ${fixture.fixtureId}: memoryBaseline.rssSlopeBytesPerSecond does not match slope samples`,
		);
	});
	test("keeps independently retained peaks out of slope evidence", () => {
		const report = runPerfCorpusBenchmark();
		for (const fixture of report.fixtures) {
			const baseline = fixture.memoryBaseline;
			if (!baseline) continue;
			expect(baseline.slopeSamples.length).toBeLessThanOrEqual(baseline.samples.length);
			expect(baseline.rssSlopeBytesPerSecond).toBe(calculateMemorySlope(baseline.slopeSamples, "rssBytes"));
			expect(baseline.heapSlopeBytesPerSecond).toBe(calculateMemorySlope(baseline.slopeSamples, "heapUsedBytes"));
		}
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
		const legacySchema = { ...report, schema: "gjc.perf-corpus/1" } as unknown as PerfCorpusReport;
		expect(validatePerfCorpusReport(legacySchema).errors).toContain(
			'invalid schema "gjc.perf-corpus/1", expected "gjc.perf-corpus/2"',
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
			`fixture ${fixture.fixtureId}: rssMemory.growthBytes does not match detailed samples`,
		);
		const firstSample = validBaseline.samples[0];
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
								samples: oversizedSamples,
								rssSlopeBytesPerSecond: null,
								heapSlopeBytesPerSecond: null,
							},
						}
					: candidate,
			),
		};
		expect(validatePerfCorpusReport(oversizedPersistedReport)).toEqual({ ok: true, errors: [] });
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
	test("treats a missing process-table sampler as unavailable", () => {
		const originalSpawnSync = Bun.spawnSync;
		const spawnSyncSpy = vi.spyOn(Bun, "spawnSync");
		spawnSyncSpy.mockImplementation(((command: string[], options?: object) => {
			if (command[0] === "ps") throw new Error("ENOENT");
			return originalSpawnSync(command, options as never);
		}) as unknown as typeof Bun.spawnSync);
		try {
			const report = runPerfCorpusBenchmark();
			for (const fixture of report.fixtures) {
				if (!fixture.memoryBaseline) continue;
				expect(fixture.memoryBaseline.processTreeSampler).toBe("unavailable");
				expect(fixture.memoryBaseline.processTreeBaselineRssBytes).toBeNull();
				expect(fixture.memoryBaseline.processTreePostTeardownRssBytes).toBeNull();
			}
			expect(validatePerfCorpusReport(report)).toEqual({ ok: true, errors: [] });
		} finally {
			spawnSyncSpy.mockRestore();
		}
	});
	test("does not claim post-GC return metrics when GC is unavailable", () => {
		const report = runPerfCorpusBenchmark();
		if (globalThis.gc) return;
		for (const fixture of report.fixtures) {
			if (!fixture.memoryBaseline) continue;
			expect(fixture.rssMemory.returnBytes).toBeNull();
			expect(fixture.rssMemory.heapReturnBytes).toBeNull();
		}
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
