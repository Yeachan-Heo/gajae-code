import { describe, expect, it } from "bun:test";
import { makeRecordedSession, runReplay } from "./replay-harness";

describe("replay harness", () => {
	it("produces metrics and golden output for a recorded session", async () => {
		const fixture = makeRecordedSession(40, 0x1234, 100, 30);
		const r = await runReplay(fixture);
		expect(r.turns).toBe(40);
		expect(r.metrics.enabled).toBe(true);
		expect(r.metrics.renderCount).toBeGreaterThan(0);
		expect(r.metrics.renderDurations.count).toBeGreaterThan(0);
		expect(r.metrics.rss.baselineBytes).not.toBeNull();
		expect(r.finalViewport.length).toBeGreaterThan(0);
		expect(Object.keys(r.metrics.requestSources).some(k => k.startsWith("replay."))).toBe(true);
	}, 60000);

	it("is deterministic: identical fixture -> identical viewport and scrollback", async () => {
		const a = await runReplay(makeRecordedSession(30, 0xabcd));
		const b = await runReplay(makeRecordedSession(30, 0xabcd));
		expect(b.finalViewport).toEqual(a.finalViewport);
		expect(b.scrollback).toEqual(a.scrollback);
	}, 60000);

	it("instrumentation does not change visible output (parity)", async () => {
		const withMetrics = await runReplay(makeRecordedSession(30, 0x55), { metrics: true });
		const withoutMetrics = await runReplay(makeRecordedSession(30, 0x55), { metrics: false });
		expect(withoutMetrics.finalViewport).toEqual(withMetrics.finalViewport);
		expect(withoutMetrics.scrollback).toEqual(withMetrics.scrollback);
	}, 60000);

	it("clean append-only streaming produces no repaint storms", async () => {
		const r = await runReplay(makeRecordedSession(60, 0x99));
		expect(r.metrics.repaintStorms).toBe(0);
	}, 60000);
});
