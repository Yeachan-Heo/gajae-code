import { describe, expect, test } from "bun:test";
import {
	cpuPercent,
	DEFAULT_IDLE_WINDOW_SECONDS,
	DEFAULT_MAX_IDLE_CPU_PERCENT,
	MIN_SAMPLE_INTERVAL_SECONDS,
	parseCpuTime,
	parseIdleCpuArgs,
	summarizeIdleCpu,
} from "./measure-idle-cpu";

describe("parseCpuTime", () => {
	test("parses minute:second values from ps -o time=", () => {
		expect(parseCpuTime("00:02.87")).toBeCloseTo(2.87, 5);
		expect(parseCpuTime("01:02.50")).toBeCloseTo(62.5, 5);
		expect(parseCpuTime("  00:00.00  ")).toBe(0);
	});

	test("parses hour and day forms", () => {
		expect(parseCpuTime("2:03:04")).toBe(2 * 3600 + 3 * 60 + 4);
		expect(parseCpuTime("1-02:03:04")).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
	});

	test("rejects garbage instead of silently returning zero", () => {
		expect(parseCpuTime("")).toBeUndefined();
		expect(parseCpuTime("n/a")).toBeUndefined();
		expect(parseCpuTime("12")).toBeUndefined();
		expect(parseCpuTime("2:03")).toBe(123);
	});
});

describe("cpuPercent", () => {
	test("converts a cumulative CPU delta into percent of one core", () => {
		expect(cpuPercent(1.5, 60)).toBeCloseTo(2.5, 5);
		expect(cpuPercent(0, 60)).toBe(0);
	});

	test("never divides by a zero window", () => {
		expect(cpuPercent(5, 0)).toBe(0);
		expect(cpuPercent(5, -1)).toBe(0);
	});
});

describe("summarizeIdleCpu", () => {
	test("reports median, p95 and max of the sampled window", () => {
		// One startup/resize spike among a long idling window must not fail the run.
		const summary = summarizeIdleCpu([...Array(19).fill(0.2), 8], DEFAULT_MAX_IDLE_CPU_PERCENT);
		expect(summary.median).toBe(0.2);
		expect(summary.p95).toBe(0.2);
		expect(summary.max).toBe(8);
		expect(summary.exceeded).toBe(false);
	});

	test("flags a session that stays above the ceiling", () => {
		// The 2026-10-23 incident measured roughly 16% CPU per idle session.
		const summary = summarizeIdleCpu([15.8, 16.1, 16.4, 16.0, 15.9], DEFAULT_MAX_IDLE_CPU_PERCENT);
		expect(summary.exceeded).toBe(true);
		expect(summary.median).toBeCloseTo(16, 0);
	});

	test("treats the ceiling as inclusive and an empty window as not exceeded", () => {
		expect(summarizeIdleCpu([3, 3, 3], 3).exceeded).toBe(false);
		expect(summarizeIdleCpu([], 3)).toEqual({ samples: [], median: 0, p95: 0, max: 0, exceeded: false });
	});
});

describe("parseIdleCpuArgs", () => {
	test("defaults to the documented ten minute protocol", () => {
		const options = parseIdleCpuArgs(["--pid", "42"]);
		expect(options.pids).toEqual([42]);
		expect(options.seconds).toBe(DEFAULT_IDLE_WINDOW_SECONDS);
		expect(options.maxPercent).toBe(DEFAULT_MAX_IDLE_CPU_PERCENT);
	});

	test("answers help without demanding a pid", () => {
		const options = parseIdleCpuArgs(["--help"]);
		expect(options.help).toBe(true);
		expect(options.pids).toEqual([]);
	});

	test("accepts several pids and explicit windows", () => {
		const options = parseIdleCpuArgs(["--pids", "42,43", "--seconds", "60", "--interval", "5", "--json"]);
		expect(options.pids).toEqual([42, 43]);
		expect(options.seconds).toBe(60);
		expect(options.intervalSeconds).toBe(5);
		expect(options.json).toBe(true);
	});

	test("keeps the sample interval at or above the floor", () => {
		expect(parseIdleCpuArgs(["--pid", "42", "--interval", "0.1"]).intervalSeconds).toBe(MIN_SAMPLE_INTERVAL_SECONDS);
	});

	test("rejects missing values, unknown flags and invalid pids", () => {
		expect(() => parseIdleCpuArgs(["--pid"])).toThrow("requires a value");
		expect(() => parseIdleCpuArgs(["--pid", "abc"])).toThrow("invalid pid");
		expect(() => parseIdleCpuArgs(["--wat"])).toThrow("unknown argument");
		expect(() => parseIdleCpuArgs([])).toThrow("at least one --pid is required");
	});
});
