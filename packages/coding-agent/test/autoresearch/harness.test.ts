import { describe, expect, it } from "bun:test";
import {
	ASI_LINE_PREFIX,
	DEFAULT_HARNESS_COMMAND,
	formatElapsed,
	formatNum,
	HARNESS_FILENAME,
	inferMetricUnitFromName,
	isBetter,
	METRIC_LINE_PREFIX,
	parseAsiLines,
	parseHarnessOutput,
	parseMetricLines,
} from "../../src/autoresearch/harness";

describe("autoresearch harness contract", () => {
	it("defines the canonical autoresearch.sh entrypoint contract", () => {
		expect(HARNESS_FILENAME).toBe("autoresearch.sh");
		expect(DEFAULT_HARNESS_COMMAND).toBe("bash autoresearch.sh");
		expect(METRIC_LINE_PREFIX).toBe("METRIC");
		expect(ASI_LINE_PREFIX).toBe("ASI");
	});

	it("parses METRIC lines with noise interleaved", () => {
		const output = [
			"building benchmark...",
			"METRIC latency_ms=12.5",
			"some progress line",
			"METRIC peak_mem_mb=1024",
			"done",
		].join("\n");
		const metrics = parseMetricLines(output);
		expect(metrics.get("latency_ms")).toBe(12.5);
		expect(metrics.get("peak_mem_mb")).toBe(1024);
		expect(metrics.size).toBe(2);
	});

	it("ignores malformed METRIC lines rather than throwing", () => {
		const output = [
			"METRIC no-equals",
			"METRIC =5",
			"METRIC name=",
			"METRIC __proto__=7",
			"METRIC constructor=7",
			"METRIC nan=NaN",
			"METRIC inf=Infinity",
			"not even a metric line",
			"METRIC valid=3",
		].join("\n");
		const metrics = parseMetricLines(output);
		expect(metrics.size).toBe(1);
		expect(metrics.get("valid")).toBe(3);
	});

	it("parses ASI lines with typed values and ignores malformed ones", () => {
		const output = [
			"ASI hypothesis=vectorized loop is bound on cache",
			"ASI success=true",
			"ASI count=42",
			"ASI ratio=0.5",
			"ASI nothing=null",
			'ASI tags=["a","b"]',
			'ASI meta={"x":1}',
			"ASI broken",
			"ASI =value",
			"ASI __proto__=pwn",
		].join("\n");
		const asi = parseAsiLines(output);
		expect(asi).not.toBeNull();
		expect(asi!.hypothesis).toBe("vectorized loop is bound on cache");
		expect(asi!.success).toBe(true);
		expect(asi!.count).toBe(42);
		expect(asi!.ratio).toBe(0.5);
		expect(asi!.nothing).toBeNull();
		expect(asi!.tags).toEqual(["a", "b"]);
		expect(asi!.meta).toEqual({ x: 1 });
		expect(Object.hasOwn(asi!, "__proto__")).toBe(false);
	});

	it("returns null from parseAsiLines when no line parses", () => {
		expect(parseAsiLines("no asi lines here\nASI broken")).toBeNull();
	});

	it("surfaces the primary metric plus secondary values from mixed output", () => {
		const output = [
			"compiling...",
			"METRIC latency_ms=9.4",
			"ASI rollback_reason=none",
			"METRIC throughput=1200",
			"exit",
		].join("\n");
		const parsed = parseHarnessOutput(output, "latency_ms");
		expect(parsed.primary).toBe(9.4);
		expect(parsed.metrics).toEqual({ latency_ms: 9.4, throughput: 1200 });
		expect(parsed.asi).toEqual({ rollback_reason: "none" });
	});

	it("falls back to the first METRIC line when no primary name is given", () => {
		const parsed = parseHarnessOutput("METRIC first=1\nMETRIC second=2");
		expect(parsed.primary).toBe(1);
	});

	it("reports a null primary when the named metric never parsed", () => {
		const parsed = parseHarnessOutput("no metrics", "latency_ms");
		expect(parsed.primary).toBeNull();
		expect(parsed.metrics).toEqual({});
	});

	it("respects metric direction in isBetter", () => {
		expect(isBetter(3, 5, "lower")).toBe(true);
		expect(isBetter(5, 3, "lower")).toBe(false);
		expect(isBetter(5, 3, "higher")).toBe(true);
		expect(isBetter(3, 5, "higher")).toBe(false);
	});

	it("infers units from metric names", () => {
		expect(inferMetricUnitFromName("latency_ms")).toBe("ms");
		expect(inferMetricUnitFromName("latency_µs")).toBe("µs");
		expect(inferMetricUnitFromName("build_s")).toBe("s");
		expect(inferMetricUnitFromName("mem_mb")).toBe("mb");
		expect(inferMetricUnitFromName("score")).toBe("");
	});

	it("formats numbers with units and elapsed time", () => {
		expect(formatNum(1234, "ms")).toBe("1,234ms");
		expect(formatNum(9.42, "ms")).toBe("9.42ms");
		expect(formatNum(null, "ms")).toBe("-");
		expect(formatElapsed(65_000)).toBe("1m 05s");
		expect(formatElapsed(9_000)).toBe("9s");
	});
});
