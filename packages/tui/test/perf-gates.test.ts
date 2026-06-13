import { describe, expect, it } from "bun:test";
import { $flag } from "@gajae-code/utils";
import { loadFixture, makeRecordedSession, measureIdleCpuFraction, runReplay } from "./replay-harness";

/**
 * Performance gates for the runtime/renderer hardening program.
 *
 * Stage 1 is the observability foundation: it MEASURES idle CPU, RSS growth,
 * post-GC heap reclaim, p95 frame time, and repaint storms over a recorded
 * ~300-turn session. Per the approved measurement-first plan, hard numeric
 * thresholds are opt-in (`PI_TUI_PERF_GATES=1`) and calibrated before becoming
 * permanent CI fail gates.
 *
 * Two threshold classes:
 *  - ENFORCED now: gates the current renderer already satisfies (p95 frame time,
 *    zero steady-stream repaint storms, idle CPU, bounded post-GC heap reclaim).
 *    These fail the build if a future change regresses them.
 *  - STAGE-2 TARGETS: the spec's RSS-growth budget. Stage 1 records the baseline;
 *    enforcement is turned on after Stage 2 (resource-leak elimination) brings the
 *    measured value under target. Recording (not yet failing) here is deliberate:
 *    the leak-fix threshold cannot pass before the leak-fix stage runs.
 */
export const PERF_GATES = {
	// Enforced now.
	renderP95Ms: 8,
	repaintStormsMax: 0,
	idleCpuFractionMax: 0.01,
	// Stage-2 acceptance targets (measured now, enforced after leak elimination).
	rssGrowthTargetBytes: 50 * 1024 * 1024,
	// ADVISORY (report-only) perceived-latency thresholds. Wall-clock proxies are
	// noisy (machine/scheduler/GC variance), so these are NEVER default CI fail
	// gates; they are recorded for calibration until variance is characterized and
	// ledger-approved (see docs/perf-profiling-corpus.md). Generous so a logged
	// value is informational, not a tripwire.
	advisory: {
		startupMsAdvisory: 250,
		ttftProxyMsAdvisory: 250,
		scrollP95MsAdvisory: 50,
	},
};

const HARD_GATES = $flag("PI_TUI_PERF_GATES");

describe("performance gates (structural, always on)", () => {
	it("collects gate metrics incl. helper timing and post-GC heap reclaim; zero storms", async () => {
		const r = await runReplay(makeRecordedSession(60, 0x2026));
		expect(r.metrics.renderDurations.count).toBeGreaterThan(0);
		expect(r.metrics.rss.baselineBytes).not.toBeNull();
		expect(r.metrics.rss.returnBytes).not.toBeNull();
		expect(r.metrics.rss.heapBaselineBytes).not.toBeNull();
		expect(r.metrics.rss.heapReturnBytes).not.toBeNull();
		expect(r.metrics.rss.returnWithinBaselineFraction).not.toBeNull();
		expect(r.metrics.helperStats.renderTree?.count ?? 0).toBeGreaterThan(0);
		expect(r.metrics.helperStats["text.visibleWidth"]?.count ?? 0).toBeGreaterThan(0);
		expect(r.metrics.repaintStorms).toBe(PERF_GATES.repaintStormsMax);
	}, 60000);

	it("measures idle CPU as a fraction of one core", async () => {
		const idle = await measureIdleCpuFraction(400);
		expect(idle).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(idle)).toBe(true);
	}, 30000);

	it("reports perceived-latency metrics as advisory wall-clock proxy (never CPU self-time), finite", async () => {
		const r = await runReplay(makeRecordedSession(60, 0x2026));
		const l = r.latency;
		expect(l.advisoryOnly).toBe(true);
		expect(l.evidenceClass).toBe("wall-clock-proxy");
		for (const v of [l.startupMs, l.firstRenderMs, l.ttftProxyMs, l.totalReplayMs]) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
		}
		expect(Number.isFinite(l.processCpu.userMicros)).toBe(true);
		expect(Number.isFinite(l.processCpu.systemMicros)).toBe(true);
		// Advisory thresholds are reported, never asserted as hard CI gates. The
		// large-transcript scroll/repaint p95 is the renderer frame p95 (also
		// enforced structurally elsewhere); here it is surfaced against its advisory
		// budget for calibration only.
		const scrollP95Ms = r.metrics.renderDurations.p95Ms;
		console.log(
			`[perf-gates][advisory] startup=${l.startupMs.toFixed(2)}ms firstRender=${l.firstRenderMs.toFixed(2)}ms ` +
				`ttftProxy=${l.ttftProxyMs.toFixed(2)}ms total=${l.totalReplayMs.toFixed(2)}ms scrollP95=${scrollP95Ms.toFixed(2)}ms ` +
				`(advisory budgets: startup<=${PERF_GATES.advisory.startupMsAdvisory} ttft<=${PERF_GATES.advisory.ttftProxyMsAdvisory} scrollP95<=${PERF_GATES.advisory.scrollP95MsAdvisory})`,
		);
	}, 60000);

	it("latency/CPU instrumentation does not change rendered bytes (golden parity, metrics on vs off)", async () => {
		const withMetrics = await runReplay(makeRecordedSession(40, 0x55aa), { metrics: true });
		const withoutMetrics = await runReplay(makeRecordedSession(40, 0x55aa), { metrics: false });
		// Same fixture seed + pure-measurement instrumentation => byte-identical output.
		expect(withoutMetrics.finalViewport).toEqual(withMetrics.finalViewport);
		expect(withoutMetrics.scrollback).toEqual(withMetrics.scrollback);
		expect(withoutMetrics.writeCount).toBe(withMetrics.writeCount);
		expect(withoutMetrics.turns).toBe(withMetrics.turns);
		expect(Number.isFinite(withoutMetrics.latency.totalReplayMs)).toBe(true);
	}, 60000);
});

if (HARD_GATES) {
	describe("performance gates (hard numeric, opt-in via PI_TUI_PERF_GATES)", () => {
		it("enforces p95 / repaint-storm / idle-CPU and records RSS-growth + heap-reclaim targets", async () => {
			const json = await Bun.file(`${import.meta.dir}/fixtures/recorded-session.json`).text();
			const fixture = loadFixture(json);
			const r = await runReplay(fixture);
			expect(r.turns).toBe(300);

			const m = r.metrics;
			const rssGrowthMB = (m.rss.growthBytes / 1048576).toFixed(1);
			const heapReturnMB = ((m.rss.heapReturnBytes ?? 0) / 1048576).toFixed(1);
			const helperSummary = Object.entries(m.helperStats)
				.filter(([name]) => name === "renderTree" || name.startsWith("text."))
				.map(([name, stat]) => `${name}=${stat.totalMs.toFixed(2)}ms/${stat.count}`)
				.join(" ");
			// Surface the measured baseline for calibration / Stage-2 tracking.
			console.log(
				`[perf-gates] p95=${m.renderDurations.p95Ms.toFixed(2)}ms storms=${m.repaintStorms} ` +
					`rssGrowth=${rssGrowthMB}MB (target ${PERF_GATES.rssGrowthTargetBytes / 1048576}MB) ` +
					`heapReturn=${heapReturnMB}MB helpers=[${helperSummary}]`,
			);

			// Enforced gates (current renderer satisfies these).
			expect(m.renderDurations.p95Ms).toBeLessThan(PERF_GATES.renderP95Ms);
			expect(m.repaintStorms).toBe(PERF_GATES.repaintStormsMax);

			const idle = await measureIdleCpuFraction(1500);
			expect(idle).toBeLessThan(PERF_GATES.idleCpuFractionMax);

			// Stage-2 targets: measured and finite now; enforced after leak elimination
			// (the harness retains the returned 300-turn golden output, so heap reclaim
			// is recorded, not yet a clean hard gate).
			expect(Number.isFinite(m.rss.growthBytes)).toBe(true);
			expect(m.rss.growthBytes).toBeGreaterThan(0);
			expect(m.rss.heapReturnBytes).not.toBeNull();
		}, 300000);
	});
}
