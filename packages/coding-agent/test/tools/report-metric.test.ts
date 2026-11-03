import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { getThemeByName, setThemeInstance, type Theme } from "../../src/modes/theme/theme";
import { renderResult as renderTaskResult } from "../../src/task/render";
import type { AgentProgress, TaskToolDetails } from "../../src/task/types";
import {
	METRIC_MAX_ROWS,
	parseReportMetricDetails,
	type ReportMetricDetails,
	renderMetricChart,
	reportMetricTool,
} from "../../src/tools/report-metric";

let theme: Theme;
beforeAll(async () => {
	theme = (await getThemeByName("red-claw"))!;
	setThemeInstance(theme);
});

const pixels: ReportMetricDetails = {
	title: "Max changed pixels by format",
	rows: [
		{ label: "png", value: 71 },
		{ label: "webp", value: 6841 },
		{ label: "avif", value: 7308 },
	],
};

const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line));

function asciiTheme(base: Theme): Theme {
	return new Proxy(base, {
		get(target, property) {
			if (property === "getSymbolPreset") return () => "ascii";
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("parseReportMetricDetails", () => {
	it("accepts a bounded chart and sanitizes display text", () => {
		expect(parseReportMetricDetails({ title: "t\u001b[31m", rows: [{ label: "a\nb", value: 1.5 }] })).toEqual({
			title: "t",
			rows: [{ label: "a b", value: 1.5 }],
		});
		const many = Array.from({ length: METRIC_MAX_ROWS + 3 }, (_, i) => ({ label: `r${i}`, value: i }));
		expect(parseReportMetricDetails({ title: "t", rows: many })?.rows).toHaveLength(METRIC_MAX_ROWS);
	});

	it("rejects charts that cannot be drawn", () => {
		for (const value of [
			undefined,
			{ title: "", rows: [{ label: "a", value: 1 }] },
			{ title: "t", rows: [] },
			{ title: "t", rows: [{ label: "a", value: -1 }] },
			{ title: "t", rows: [{ label: "a", value: Number.NaN }] },
			{ title: "t", rows: [{ label: "a", value: Number.POSITIVE_INFINITY }] },
			{ title: "t", rows: [{ label: "", value: 1 }] },
		]) {
			expect(parseReportMetricDetails(value)).toBeUndefined();
		}
	});
});

describe("renderMetricChart", () => {
	it("draws bars proportional to the largest value, fitted to the width", () => {
		const lines = renderMetricChart(pixels, "", 60, theme);
		const text = plain(lines);
		expect(text[0]).toContain("Max changed pixels by format");
		expect(text.slice(1)).toEqual([
			`  png  ${"▏".padEnd(24)}   71`,
			`  webp ${`${"█".repeat(22)}▍`.padEnd(24)} 6841`,
			`  avif ${"█".repeat(24)} 7308`,
		]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("shrinks the bar on a narrower terminal and keeps every line inside it", () => {
		const lines = renderMetricChart(pixels, "   ", 24, theme);
		const bars = plain(lines.slice(1)).map(line => line.match(/█+/)?.[0].length ?? 0);
		expect(bars[2]).toBe(24 - 3 - 2 - 4 - 4 - 2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	it("falls back to one text line when a bar cannot fit", () => {
		// 15 columns leave 3 bar cells after the indent, label, value, and spaces.
		const text = plain(renderMetricChart(pixels, "", 15, theme));
		expect(text).toHaveLength(2);
		expect(text[1]).toStartWith("  png 71");
		for (const line of text) expect(visibleWidth(line)).toBeLessThanOrEqual(15);
		expect(text[1]).not.toContain("█");
	});

	it("uses ASCII bars under the ascii symbol preset and empty bars for all-zero rows", () => {
		const ascii = plain(renderMetricChart(pixels, "", 60, asciiTheme(theme)));
		expect(ascii[3]).toContain("#".repeat(24));
		expect(ascii.join("\n")).not.toMatch(/[█▏▎▍▌▋▊▉]/);
		const zero = plain(
			renderMetricChart(
				{
					title: "none",
					rows: [
						{ label: "a", value: 0 },
						{ label: "b", value: 0 },
					],
				},
				"",
				40,
				theme,
			),
		);
		expect(zero.slice(1)).toEqual([`  a ${" ".repeat(24)} 0`, `  b ${" ".repeat(24)} 0`]);
	});

	it("abbreviates large values and trims fractions", () => {
		const text = plain(
			renderMetricChart(
				{
					title: "t",
					rows: [
						{ label: "a", value: 1_250_000 },
						{ label: "b", value: 0.125 },
					],
				},
				"",
				60,
				theme,
			),
		);
		expect(text[1]).toEndWith(" 1.3M");
		expect(text[2]).toEndWith(" 0.13");
	});
});

describe("report_metric tool", () => {
	it("returns the chart as details and a one-line result", async () => {
		const result = await reportMetricTool.execute("call", pixels, undefined, undefined, undefined as never);
		expect(result.details).toEqual(pixels);
		expect(result.content).toEqual([{ type: "text", text: "Metric shown: Max changed pixels by format (3 rows)" }]);
	});
});

describe("task card", () => {
	function details(metrics: ReportMetricDetails[]): TaskToolDetails {
		const progress: AgentProgress = {
			index: 0,
			id: "0-Measure",
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "measure formats",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 0,
			cost: 0,
			durationMs: 0,
			extractedToolData: { report_metric: metrics },
		};
		return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] } as TaskToolDetails;
	}

	function render(metrics: ReportMetricDetails[], expanded: boolean, width: number): string[] {
		return renderTaskResult(
			{ content: [{ type: "text", text: "" }], details: details(metrics) },
			{ expanded, isPartial: true, spinnerFrame: 0 },
			theme,
		).render(width);
	}

	const bytes: ReportMetricDetails = { title: "Output bytes", rows: [{ label: "png", value: 10 }] };

	it("renders the latest chart collapsed and every chart expanded, inside the width", () => {
		const collapsed = plain(render([bytes, pixels], false, 70)).join("\n");
		expect(collapsed).toContain("Max changed pixels by format");
		expect(collapsed).not.toContain("Output bytes");
		expect(collapsed).toContain("█".repeat(24));

		const expanded = render([bytes, pixels], true, 70);
		expect(plain(expanded).join("\n")).toContain("Output bytes");
		for (const line of expanded) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
	});

	it("degrades to text on a narrow terminal", () => {
		const text = plain(render([pixels], false, 20)).join("\n");
		expect(text).toContain("png 71");
		expect(text).not.toContain("█");
	});

	it("ignores malformed restored chart data", () => {
		const text = plain(render([{ title: "bad", rows: [{ label: "x", value: -5 }] }], false, 70)).join("\n");
		expect(text).not.toContain("bad");
	});
});
