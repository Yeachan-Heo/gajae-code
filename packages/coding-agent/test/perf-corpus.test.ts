import { describe, expect, test } from "bun:test";
import { runPerfCorpusBenchmark } from "../bench/perf-corpus.bench";
import {
	type HotspotClassification,
	hasProfilerSelfTimeEvidence,
	isHotspotStatus,
	PERF_CORPUS_SCHEMA,
	type PerfCorpusReport,
	REQUIRED_FIXTURE_CLASSES,
	V1_V3_RECLASSIFICATION,
	validateHotspotClassification,
	validatePerfCorpusReport,
} from "../bench/perf-corpus-schema";
import {
	APPLIED_PERF_THRESHOLDS,
	HELD_PERF_THRESHOLDS,
	validatePerfThresholdLedger,
} from "../bench/perf-threshold.ledger";

describe("perf corpus schema + runner", () => {
	test("runner emits the schema with separated evidence fields and >=3 required fixture classes", () => {
		const report = runPerfCorpusBenchmark();
		expect(report.schema).toBe(PERF_CORPUS_SCHEMA);
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
