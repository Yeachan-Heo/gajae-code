import { describe, expect, it } from "bun:test";
import { MAX_LABEL_MAP_ENTRIES, REPAINT_STORM_THRESHOLD, RenderMetrics } from "@gajae-code/tui/metrics";
import { makeRecordedSession, runReplay } from "./replay-harness";

function recordUnexpectedRender(metrics: RenderMetrics, cause = "extraLines > height"): void {
	metrics.recordFullRedraw(cause);
	metrics.recordRender(1);
}

function recordExpectedRender(metrics: RenderMetrics, cause = "terminal width changed"): void {
	metrics.recordFullRedraw(cause);
	metrics.recordRender(1);
}

describe("RenderMetrics red-team coverage", () => {
	it("keeps disabled record paths zeroed under high-volume no-op calls", () => {
		const metrics = new RenderMetrics(false);

		for (let i = 0; i < 100_000; i++) {
			metrics.recordRequest(`source-${i % 17}`);
			metrics.recordRender(i % 101);
			metrics.recordFullRedraw(i % 2 === 0 ? "extraLines > height" : "terminal width changed");
			metrics.setOwnerGauge("owner", i);
			metrics.setTimerGauge("timer", i);
		}

		expect(metrics.sampleRss()).toBe(0);
		const snapshot = metrics.snapshot();
		expect(snapshot.enabled).toBe(false);
		expect(snapshot.renderCount).toBe(0);
		expect(snapshot.renderDurations).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
		expect(snapshot.durationsTruncated).toBe(false);
		expect(snapshot.requestSources).toEqual({});
		expect(snapshot.fullRedrawCount).toBe(0);
		expect(snapshot.fullRedrawCauses).toEqual({});
		expect(snapshot.repaintStorms).toBe(0);
		expect(snapshot.maxConsecutiveFullRedraws).toBe(0);
		expect(snapshot.rss).toEqual({
			samples: 0,
			baselineBytes: null,
			lastBytes: null,
			peakBytes: 0,
			growthBytes: 0,
			returnBytes: null,
			heapBaselineBytes: null,
			heapReturnBytes: null,
			returnWithinBaselineFraction: null,
		});
		expect(snapshot.ownerGauges).toEqual({});
		expect(snapshot.timerGauges).toEqual({});
	});

	it("counts storms only for consecutive unexpected full-redraw runs at threshold boundaries", () => {
		const belowThreshold = new RenderMetrics(true);
		for (let i = 0; i < REPAINT_STORM_THRESHOLD - 1; i++) recordUnexpectedRender(belowThreshold);
		let snapshot = belowThreshold.snapshot();
		expect(snapshot.maxConsecutiveFullRedraws).toBe(REPAINT_STORM_THRESHOLD - 1);
		expect(snapshot.repaintStorms).toBe(0);

		const exactlyThreshold = new RenderMetrics(true);
		for (let i = 0; i < REPAINT_STORM_THRESHOLD; i++) recordUnexpectedRender(exactlyThreshold);
		snapshot = exactlyThreshold.snapshot();
		expect(snapshot.maxConsecutiveFullRedraws).toBe(REPAINT_STORM_THRESHOLD);
		expect(snapshot.repaintStorms).toBe(1);

		const interrupted = new RenderMetrics(true);
		for (let i = 0; i < REPAINT_STORM_THRESHOLD - 1; i++) recordUnexpectedRender(interrupted, "scrollback overflow");
		recordExpectedRender(interrupted, "terminal width changed");
		for (let i = 0; i < REPAINT_STORM_THRESHOLD - 1; i++) recordUnexpectedRender(interrupted, "scrollback overflow");
		snapshot = interrupted.snapshot();
		expect(snapshot.fullRedrawCauses["scrollback overflow"]).toBe((REPAINT_STORM_THRESHOLD - 1) * 2);
		expect(snapshot.fullRedrawCauses["terminal width changed"]).toBe(1);
		expect(snapshot.maxConsecutiveFullRedraws).toBe(REPAINT_STORM_THRESHOLD - 1);
		expect(snapshot.repaintStorms).toBe(0);

		recordUnexpectedRender(interrupted, "scrollback overflow");
		snapshot = interrupted.snapshot();
		expect(snapshot.maxConsecutiveFullRedraws).toBe(REPAINT_STORM_THRESHOLD);
		expect(snapshot.repaintStorms).toBe(1);
	});

	it("returns zeroed, singleton, and monotonic percentile duration stats at boundaries", () => {
		const empty = new RenderMetrics(true);
		expect(empty.snapshot().renderDurations).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });

		const single = new RenderMetrics(true);
		single.recordRender(42);
		expect(single.snapshot().renderDurations).toEqual({
			count: 1,
			meanMs: 42,
			p50Ms: 42,
			p95Ms: 42,
			p99Ms: 42,
			maxMs: 42,
		});

		const distributed = new RenderMetrics(true);
		for (const sample of [1, 2, 3, 4, 5, 50, 75, 100, 150, 200]) distributed.recordRender(sample);
		const stats = distributed.snapshot().renderDurations;
		expect(stats.count).toBe(10);
		expect(stats.p50Ms).toBeLessThanOrEqual(stats.p95Ms);
		expect(stats.p95Ms).toBeLessThanOrEqual(stats.p99Ms);
		expect(stats.p99Ms).toBeLessThanOrEqual(stats.maxMs);
		expect(stats.maxMs).toBe(200);
	});

	it("preserves replay viewport and scrollback byte-for-byte with metrics under narrow stress", async () => {
		const fixture = makeRecordedSession(80, 0x5eed, 40, 24);
		const withMetrics = await runReplay(fixture, { metrics: true });
		const withoutMetrics = await runReplay(fixture, { metrics: false });

		expect(withMetrics.turns).toBe(80);
		expect(withoutMetrics.turns).toBe(80);
		expect(withoutMetrics.finalViewport.join("\n")).toBe(withMetrics.finalViewport.join("\n"));
		expect(withoutMetrics.scrollback.join("\n")).toBe(withMetrics.scrollback.join("\n"));
	}, 60000);

	it("tracks RSS samples with non-negative growth, peak at least baseline, and last set", () => {
		const metrics = new RenderMetrics(true);
		const samples = [metrics.sampleRss(), metrics.sampleRss(), metrics.sampleRss(), metrics.sampleRss()];
		const snapshot = metrics.snapshot();

		expect(samples.every(sample => sample > 0)).toBe(true);
		expect(snapshot.rss.samples).toBe(samples.length);
		expect(snapshot.rss.baselineBytes).toBe(samples[0]);
		expect(snapshot.rss.lastBytes).toBe(samples[samples.length - 1]);
		expect(snapshot.rss.peakBytes).toBeGreaterThanOrEqual(snapshot.rss.baselineBytes ?? 0);
		expect(snapshot.rss.peakBytes).toBeGreaterThanOrEqual(snapshot.rss.lastBytes ?? 0);
		expect(snapshot.rss.growthBytes).toBeGreaterThanOrEqual(0);
	});

	it("bounds enabled metric label maps and aggregates overflow under other", () => {
		const metrics = new RenderMetrics(true);

		for (let i = 0; i < MAX_LABEL_MAP_ENTRIES * 4; i++) {
			metrics.recordRequest(`plugin-source-${i}`);
			metrics.recordHelper(`helper-${i}`, 2);
		}

		const snapshot = metrics.snapshot();
		expect(Object.keys(snapshot.requestSources)).toHaveLength(MAX_LABEL_MAP_ENTRIES);
		expect(snapshot.requestSources.other).toBe(MAX_LABEL_MAP_ENTRIES * 4 - (MAX_LABEL_MAP_ENTRIES - 1));
		expect(Object.keys(snapshot.helperStats)).toHaveLength(MAX_LABEL_MAP_ENTRIES);
		expect(snapshot.helperStats.other).toEqual({
			count: MAX_LABEL_MAP_ENTRIES * 4 - (MAX_LABEL_MAP_ENTRIES - 1),
			totalMs: (MAX_LABEL_MAP_ENTRIES * 4 - (MAX_LABEL_MAP_ENTRIES - 1)) * 2,
			meanMs: 2,
		});
	});

	it("normalizes dynamic full-redraw causes before retaining labels", () => {
		const metrics = new RenderMetrics(true);

		for (let i = 0; i < MAX_LABEL_MAP_ENTRIES * 4; i++) {
			metrics.recordFullRedraw(`extraLines > height (${i + 1} > ${i % 37})`);
			metrics.recordFullRedraw(`firstChanged < viewportTop (${i} < ${i + 10})`);
			metrics.recordFullRedraw(`terminal height changed (${i + 20} -> ${i + 21})`);
		}

		const snapshot = metrics.snapshot();
		expect(Object.keys(snapshot.fullRedrawCauses)).toEqual([
			"extraLines > height",
			"firstChanged < viewportTop",
			"terminal height changed",
		]);
		expect(snapshot.fullRedrawCauses["extraLines > height"]).toBe(MAX_LABEL_MAP_ENTRIES * 4);
		expect(snapshot.fullRedrawCauses["firstChanged < viewportTop"]).toBe(MAX_LABEL_MAP_ENTRIES * 4);
		expect(snapshot.fullRedrawCauses["terminal height changed"]).toBe(MAX_LABEL_MAP_ENTRIES * 4);
		expect(snapshot.fullRedrawCauses.other).toBeUndefined();
	});
});
