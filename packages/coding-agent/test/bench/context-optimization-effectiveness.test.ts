import { describe, expect, it } from "bun:test";
import {
	buildMixedEditingSession,
	measureCacheEpochDiscipline,
	measureIngestDigest,
	measurePruningGain,
	measureRollupCompression,
	runContextOptimizationBenchmark,
} from "../../bench/context-optimization.bench";

/**
 * Effectiveness invariants for the context-optimization work (#508/#509/#510).
 *
 * These lock the *direction and magnitude* of the improvements measured by
 * bench/context-optimization.bench.ts on deterministic fixtures, so a future
 * change that silently regresses the optimizations fails CI instead of only
 * showing up in a manually-run benchmark.
 */

const session = buildMixedEditingSession();

describe("staleness-aware pruning effectiveness (#508)", () => {
	const gain = measurePruningGain(session);

	it("recovers strictly more tokens than classic selection", () => {
		expect(gain.stalenessAware.tokensSaved).toBeGreaterThan(gain.classic.tokensSaved);
	});

	it("recovers superseded protected reads that classic can never touch", () => {
		expect(gain.staleReadsPruned).toBeGreaterThan(0);
	});

	it("recovers at least 2x the classic savings on the mixed editing fixture", () => {
		// Measured ~5.5x at introduction; 2x leaves headroom for fixture drift
		// while still catching a meaningful regression.
		expect(gain.stalenessAware.tokensSaved).toBeGreaterThanOrEqual(gain.classic.tokensSaved * 2);
	});

	it("is deterministic", () => {
		expect(measurePruningGain(session)).toEqual(gain);
	});
});

describe("cache-epoch discipline effectiveness (#508)", () => {
	const report = measureCacheEpochDiscipline(session, 120_000);

	it("threshold gating rewrites history strictly less often than per-turn pruning", () => {
		expect(report.thresholdRewrites).toBeLessThan(report.perTurnRewrites);
	});

	it("saves estimated re-cache tokens", () => {
		expect(report.recacheTokensSaved).toBeGreaterThan(0);
		expect(report.thresholdRecacheTokens).toBeLessThan(report.perTurnRecacheTokens);
	});
});

describe("phase-rollup compression effectiveness (#509)", () => {
	const report = measureRollupCompression(8);

	it("produces a valid hash-sealed rollup", () => {
		expect(report.rollupValid).toBe(true);
	});

	it("compresses 8 inline child receipts to at most half the bytes", () => {
		// Measured ~31% at introduction; 50% leaves headroom.
		expect(report.compressionRatio).toBeLessThanOrEqual(0.5);
	});

	it("compression improves with fan-out (fixed envelope amortizes)", () => {
		const small = measureRollupCompression(4);
		const large = measureRollupCompression(16);
		expect(large.compressionRatio).toBeLessThanOrEqual(small.compressionRatio);
	});
});

describe("receipt-ingest digest effectiveness (#509)", () => {
	const report = measureIngestDigest(50);

	it("caps the model-facing digest regardless of batch size", () => {
		expect(report.digestCapRespected).toBe(true);
		expect(measureIngestDigest(200).digestCapRespected).toBe(true);
	});

	it("keeps the digest under 5% of the raw batch bytes", () => {
		expect(report.digestRatio).toBeLessThan(0.05);
	});

	it("stays fail-closed while compressing: tampered receipts rejected, real one transitions", () => {
		expect(report.tamperedRejected).toBe(49);
		expect(report.finalLifecycle).toBe("completed");
	});
});

describe("full benchmark report", () => {
	it("runs end-to-end and reports every section", () => {
		const report = runContextOptimizationBenchmark();
		expect(report.pruningGain.stalenessAware.tokensSaved).toBeGreaterThan(0);
		expect(report.cacheEpoch.turns).toBeGreaterThan(0);
		expect(report.rollupCompression.rollupValid).toBe(true);
		expect(report.ingestDigest.digestCapRespected).toBe(true);
		expect(report.perf.ingestBatchMsPerOp).toBeLessThan(50);
		expect(report.perf.rollupBuildMsPerOp).toBeLessThan(50);
	}, 30_000);
});
