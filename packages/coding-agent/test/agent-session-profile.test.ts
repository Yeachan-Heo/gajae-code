import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	analyzeRetention,
	type CpuProfile,
	captureAgentSessionProfile,
	type GcSample,
	type HeapCensus,
	heapSnapshotReachableBytes,
	reclassifyAgentSessionHotspots,
	summarizeCpuProfile,
} from "../bench/agent-session-profile";
import {
	type PerfCorpusReport,
	validateHotspotClassification,
	validatePerfCorpusReport,
} from "../bench/perf-corpus-schema";

/** The corpus runner only accepts its canonical entrypoint, so run it as a subprocess. */
function runPerfCorpusBenchmark(): PerfCorpusReport {
	const result = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../bench/perf-corpus.bench.ts")], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...process.env },
	});
	if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return JSON.parse(new TextDecoder().decode(result.stdout)) as PerfCorpusReport;
}

const ROOT = "/repo";
const SESSION_FILE = `file://${ROOT}/packages/coding-agent/src/session/session-manager.ts`;

function frame(functionName: string, lineNumber = 0, url = SESSION_FILE) {
	return { functionName, url, lineNumber };
}

function gcSample(elapsedMs: number, heapUsedBytes: number, objectCount: number, rssBytes = 200 << 20): GcSample {
	return {
		elapsedMs,
		iterations: elapsedMs * 10,
		preGcRssBytes: rssBytes + (8 << 20),
		preGcHeapUsedBytes: heapUsedBytes + (10 << 20),
		rssBytes,
		heapUsedBytes,
		externalBytes: 4 << 20,
		objectCount,
	};
}

describe("summarizeCpuProfile", () => {
	// root -> run -> getEntries -> visit -> visit (recursive) ; run -> appendEntry
	const profile: CpuProfile = {
		nodes: [
			{ id: 1, callFrame: frame("(root)", 0, ""), children: [2] },
			{ id: 2, callFrame: frame("run", 12), children: [3, 6] },
			{ id: 3, callFrame: frame("getEntries", 19500), children: [4] },
			{ id: 4, callFrame: frame("visit", 5512), children: [5] },
			{ id: 5, callFrame: frame("visit", 5512), children: [] },
			{ id: 6, callFrame: frame("#appendEntry", 18027), children: [] },
		],
		samples: [5, 5, 4, 6, 3],
		timeDeltas: [1000, 1000, 1000, 2000, 500],
	};

	test("attributes self time to the leaf and total time once per stack symbol", () => {
		const bySymbol = new Map(summarizeCpuProfile(profile, ROOT).map(sample => [sample.symbol, sample]));
		const visit = bySymbol.get("visit (packages/coding-agent/src/session/session-manager.ts:5513)");
		expect(visit).toEqual({
			symbol: "visit (packages/coding-agent/src/session/session-manager.ts:5513)",
			selfTimeMs: 3,
			totalTimeMs: 3,
		});
		expect(bySymbol.get("getEntries (packages/coding-agent/src/session/session-manager.ts:19501)")).toMatchObject({
			selfTimeMs: 0.5,
			totalTimeMs: 3.5,
		});
		expect(bySymbol.get("run (packages/coding-agent/src/session/session-manager.ts:13)")?.totalTimeMs).toBe(5.5);
		expect([...bySymbol.keys()].some(symbol => symbol.startsWith("(root)"))).toBe(false);
	});

	test("orders symbols by total time", () => {
		const totals = summarizeCpuProfile(profile, ROOT).map(sample => sample.totalTimeMs ?? 0);
		expect(totals).toEqual([...totals].sort((a, b) => b - a));
	});
});

function census(reachableBytes: number, objectTypeCounts: Record<string, number> = {}): HeapCensus {
	return { reachableBytes, objectTypeCounts };
}

describe("heapSnapshotReachableBytes", () => {
	test("sums self_size across nodes using the snapshot's field layout", () => {
		const snapshot = {
			snapshot: { meta: { node_fields: ["type", "name", "id", "self_size", "edge_count"] } },
			nodes: [0, 0, 1, 100, 2, 0, 1, 2, 250, 0, 3, 4, 3, 7, 0],
		};
		expect(heapSnapshotReachableBytes(JSON.stringify(snapshot))).toBe(357);
	});

	test("rejects snapshots without a self_size field", () => {
		const snapshot = { snapshot: { meta: { node_fields: ["type", "name"] } }, nodes: [0, 0] };
		expect(() => heapSnapshotReachableBytes(JSON.stringify(snapshot))).toThrow("no self_size");
	});

	test("counts a real Bun V8 snapshot within the live heap", () => {
		Bun.gc(true);
		const reachable = heapSnapshotReachableBytes(Bun.generateHeapSnapshot("v8"));
		expect(reachable).toBeGreaterThan(0);
		expect(reachable).toBeLessThanOrEqual(process.memoryUsage().heapTotal * 2);
	});
});

describe("analyzeRetention", () => {
	test("flat reachable heap with high RSS is bounded high-water even when heapUsed steps up", () => {
		const samples = [
			gcSample(0, 20 << 20, 290_000, 140 << 20),
			gcSample(1_000, 22 << 20, 293_000, 220 << 20),
			gcSample(2_000, 18 << 20, 281_000, 226 << 20),
			gcSample(3_000, 34 << 20, 280_500, 210 << 20),
			gcSample(4_000, 34 << 20, 280_200, 208 << 20),
		];
		const retention = analyzeRetention(samples, census(24 << 20, { Array: 100 }), census(24 << 20, { Array: 120 }));
		expect(retention.verdict).toBe("bounded-high-water");
		// Steady state starts at the 1 s sample (warm-up = first quarter of 4 s).
		expect(retention.postGcHeapGrowthBytes).toBe(12 << 20);
		expect(retention.reachableBytesGrowth).toBe(0);
		expect(retention.peakRssBytes).toBe((226 << 20) + (8 << 20));
		expect(retention.growingObjectTypes).toEqual([{ type: "Array", earlyCount: 100, lateCount: 120, delta: 20 }]);
	});

	test("reachable growth past tolerance is retention and names growing types", () => {
		const samples = [0, 1_000, 2_000, 3_000, 4_000].map(elapsed =>
			gcSample(elapsed, (20 << 20) + elapsed * 2_048, 280_000 + elapsed),
		);
		const retention = analyzeRetention(
			samples,
			census(20 << 20, { string: 1_000, Map: 5 }),
			census(26 << 20, { string: 60_000, Map: 5 }),
		);
		expect(retention.verdict).toBe("reachable-retention");
		expect(retention.reachableBytesGrowth).toBe(6 << 20);
		expect(retention.postGcHeapSlopeBytesPerSecond).toBe(2_048_000);
		expect(retention.growingObjectTypes.map(growth => growth.type)).toEqual(["string"]);
	});

	test("object-count growth alone flags retention when bytes stay within tolerance", () => {
		const samples = [0, 1_000, 2_000, 3_000].map(elapsed => gcSample(elapsed, 20 << 20, 100_000 + elapsed * 5));
		expect(analyzeRetention(samples, census(20 << 20), census(20 << 20)).verdict).toBe("reachable-retention");
	});

	test("rejects fewer than three samples", () => {
		expect(() => analyzeRetention([gcSample(0, 1, 1), gcSample(1, 1, 1)], census(1), census(1))).toThrow(
			"at least three GC samples",
		);
	});
});

describe("reclassifyAgentSessionHotspots", () => {
	const retention = analyzeRetention(
		[gcSample(0, 20 << 20, 280_000), gcSample(1_000, 20 << 20, 280_000), gcSample(2_000, 20 << 20, 280_000)],
		census(20 << 20),
		census(20 << 20),
	);
	const samples = [
		{
			symbol: "getEntries (packages/coding-agent/src/session/session-manager.ts:19501)",
			selfTimeMs: 2,
			totalTimeMs: 450,
		},
		{
			symbol: "#appendEntry (packages/coding-agent/src/session/session-manager.ts:18028)",
			selfTimeMs: 1,
			totalTimeMs: 30,
		},
		{ symbol: "getEntriesCount (packages/coding-agent/src/session/other.ts:1)", selfTimeMs: 900, totalTimeMs: 900 },
	];
	const byId = new Map(
		reclassifyAgentSessionHotspots(samples, 1_000, retention, "artifacts/p.cpuprofile").map(c => [c.hotspotId, c]),
	);

	test("confirms a hotspot at or above the CPU share threshold and anchors it to the exact sample symbol", () => {
		expect(byId.get("M02")).toMatchObject({
			status: "CPU-self-time confirmed",
			evidenceClass: "profiler-self-time",
			artifactRefs: [samples[0].symbol, "artifacts/p.cpuprofile"],
		});
		expect(byId.get("M02")?.notes).toContain("RSS growth is allocator high-water");
	});

	test("demotes an exercised hotspot below the threshold to not-visible", () => {
		expect(byId.get("M01")).toMatchObject({
			status: "not-visible",
			artifactRefs: [samples[1].symbol, "artifacts/p.cpuprofile"],
		});
	});

	test("marks unexercised hotspots needs-trace-coverage without matching prefix-similar symbols", () => {
		for (const id of ["M03", "M04", "M05", "H10"]) {
			expect(byId.get(id)).toMatchObject({
				status: "needs-trace-coverage",
				artifactRefs: ["artifacts/p.cpuprofile"],
			});
		}
	});

	test("every classification passes the corpus classification validator", () => {
		for (const classification of byId.values()) expect(validateHotspotClassification(classification)).toEqual([]);
	});
});

describe("captureAgentSessionProfile", () => {
	let outDir: string | undefined;
	afterEach(async () => {
		if (outDir) await fs.rm(outDir, { recursive: true, force: true });
		outDir = undefined;
	});

	test("records a CPU profile, two heap snapshots, and evidence-derived classifications", async () => {
		outDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-session-profile-"));
		const report = await captureAgentSessionProfile({ outDir, durationMs: 2_000, sampleIntervalMs: 200 });
		const cpuProfile = (await Bun.file(path.join(outDir, "agent-session-lifecycle.cpuprofile")).json()) as CpuProfile;
		expect(cpuProfile.samples.length).toBeGreaterThan(0);
		for (const name of ["early", "late"]) {
			const snapshot = (await Bun.file(
				path.join(outDir, `agent-session-lifecycle.${name}.heapsnapshot`),
			).json()) as {
				snapshot: { node_count: number };
			};
			expect(snapshot.snapshot.node_count).toBeGreaterThan(0);
		}
		expect(report.gcSamples.length).toBeGreaterThanOrEqual(3);
		expect(report.iterations).toBeGreaterThan(0);
		expect(["bounded-high-water", "reachable-retention"]).toContain(report.retention.verdict);
		const profiledSymbols = (report.profilerSelfTime.samples ?? []).map(sample => sample.symbol);
		expect(profiledSymbols.some(symbol => symbol.startsWith("getEntries ("))).toBe(true);
		expect(report.profilerSelfTime.artifactPath).toBe(report.artifacts.cpuProfile);
		expect(report.hotspotClassifications.map(c => c.hotspotId).sort()).toEqual([
			"H10",
			"M01",
			"M02",
			"M03",
			"M04",
			"M05",
		]);
		for (const classification of report.hotspotClassifications) {
			expect(classification.evidenceClass).toBe("profiler-self-time");
			expect(classification.artifactRefs).toContain(report.artifacts.cpuProfile);
		}

		// The captured evidence drops into the corpus report and satisfies its anchoring rules.
		const corpus = runPerfCorpusBenchmark();
		const withProfile: PerfCorpusReport = {
			...corpus,
			fixtures: corpus.fixtures.map(fixture =>
				fixture.fixtureId === report.fixtureId
					? { ...fixture, profilerSelfTime: report.profilerSelfTime }
					: fixture,
			),
			hotspotClassifications: [
				...corpus.hotspotClassifications.filter(
					c => !report.hotspotClassifications.some(r => r.hotspotId === c.hotspotId),
				),
				...report.hotspotClassifications,
			],
		};
		expect(validatePerfCorpusReport(withProfile)).toEqual({ ok: true, errors: [] });
	}, 60_000);
});
