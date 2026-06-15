import { describe, expect, test } from "bun:test";
import {
	compareCronsNewestFirst,
	compareMonitorsNewestFirst,
	formatJobRef,
	formatRelative,
	formatRuntime,
	parseJobRef,
	previewText,
} from "../src/modes/components/jobs-format";
import type { CronJobView, MonitorJobView } from "../src/modes/jobs-observer";

function monitor(over: Partial<MonitorJobView> = {}): MonitorJobView {
	return { id: "m", label: "l", status: "running", startTime: 0, ...over };
}

function cron(over: Partial<CronJobView> = {}): CronJobView {
	return {
		id: "c",
		humanSchedule: "every 5m",
		cronExpression: "*/5 * * * *",
		prompt: "p",
		recurring: true,
		createdAt: 0,
		...over,
	};
}

describe("jobs-format", () => {
	test("previewText collapses whitespace and clips with an ellipsis", () => {
		expect(previewText("  a\n\tb   c  ")).toBe("a b c");
		expect(previewText("abcdef", 4)).toBe("abc…");
		expect(previewText("abcd", 4)).toBe("abcd");
		expect(previewText("anything", 0)).toBe("");
	});

	test("formatRelative renders future/past/unknown", () => {
		const now = 1_000_000;
		expect(formatRelative(now + 300_000, now)).toBe("in 5m");
		expect(formatRelative(now - 120_000, now)).toBe("2m ago");
		expect(formatRelative(now + 20_000, now)).toBe("now");
		expect(formatRelative(now + 2 * 3_600_000, now)).toBe("in 2h");
		expect(formatRelative(undefined, now)).toBe("—");
	});

	test("formatRuntime freezes at endTime and scales s/m/h", () => {
		const start = 1_000_000;
		// running: counts against now
		expect(formatRuntime(start, undefined, start + 5_000)).toBe("5s");
		expect(formatRuntime(start, undefined, start + 125_000)).toBe("2m");
		expect(formatRuntime(start, undefined, start + (3_600_000 + 180_000))).toBe("1h3m");
		expect(formatRuntime(start, undefined, start + 2 * 3_600_000)).toBe("2h");
		// terminal: frozen at endTime regardless of now
		expect(formatRuntime(start, start + 9_000, start + 999_999)).toBe("9s");
		// guard against negative
		expect(formatRuntime(start, undefined, start - 50)).toBe("0s");
	});

	test("parseJobRef / formatJobRef round-trip and reject non-refs", () => {
		expect(parseJobRef("monitor:abc")).toEqual({ kind: "monitor", id: "abc" });
		expect(parseJobRef("cron:x")).toEqual({ kind: "cron", id: "x" });
		expect(parseJobRef("noop")).toBeNull();
		expect(parseJobRef("other:1")).toBeNull();
		expect(parseJobRef("monitor:")).toBeNull();
		expect(formatJobRef({ kind: "monitor", id: "abc" })).toBe("monitor:abc");
	});

	test("comparators order newest-first", () => {
		const monitors = [monitor({ id: "old", startTime: 1 }), monitor({ id: "new", startTime: 9 })];
		expect([...monitors].sort(compareMonitorsNewestFirst).map(m => m.id)).toEqual(["new", "old"]);
		const crons = [cron({ id: "old", createdAt: 1 }), cron({ id: "new", createdAt: 9 })];
		expect([...crons].sort(compareCronsNewestFirst).map(c => c.id)).toEqual(["new", "old"]);
	});
});
