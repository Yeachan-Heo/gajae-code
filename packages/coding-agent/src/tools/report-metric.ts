/**
 * report_metric - lets a running subagent show a small bar chart of comparable
 * numeric measurements in the parent's live task card.
 *
 * Display only: the chart rides `AgentProgress.extractedToolData` to the parent
 * TUI and never enters the parent model's context or the subagent's result.
 */
import type { AgentTool } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text, visibleWidth } from "@gajae-code/tui";
import { formatNumber, isRecord, sanitizeDisplayLine } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { Theme } from "../modes/theme/theme";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import { truncateToWidth } from "./render-utils";

export const METRIC_MAX_ROWS = 8;
const METRIC_TITLE_MAX = 80;
const METRIC_LABEL_MAX = 32;
/** Charts kept per subagent; re-reporting a title replaces its chart. */
export const METRIC_MAX_CHARTS = 4;

/** Widest bar, so a wide terminal does not stretch a two-row chart across the screen. */
const BAR_MAX_CELLS = 24;
/** Below this many bar cells a chart cannot show proportions; render text instead. */
const BAR_MIN_CELLS = 4;
const LABEL_MAX_CELLS = 16;

export interface ReportMetricRow {
	label: string;
	value: number;
}

export interface ReportMetricDetails {
	title: string;
	rows: ReportMetricRow[];
}

const ReportMetricParams = z
	.object({
		title: z.string().min(1).max(METRIC_TITLE_MAX).describe("Chart title, e.g. 'Changed pixels by format'"),
		rows: z
			.array(
				z
					.object({
						label: z.string().min(1).max(METRIC_LABEL_MAX).describe("Short row label"),
						value: z.number().finite().nonnegative().describe("Non-negative number for this row"),
					})
					.strict(),
			)
			.min(1)
			.max(METRIC_MAX_ROWS)
			.describe(`1-${METRIC_MAX_ROWS} rows to compare`),
	})
	.strict();

function parseRow(value: unknown): ReportMetricRow | undefined {
	if (!isRecord(value)) return undefined;
	const label = typeof value.label === "string" ? sanitizeDisplayLine(value.label).trim() : "";
	const number = value.value;
	if (!label || typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined;
	return { label: label.slice(0, METRIC_LABEL_MAX), value: number };
}

/** Validate untrusted details (restored sessions, subprocess events) into a bounded metric. */
export function parseReportMetricDetails(value: unknown): ReportMetricDetails | undefined {
	if (!isRecord(value) || !Array.isArray(value.rows)) return undefined;
	const title = typeof value.title === "string" ? sanitizeDisplayLine(value.title).trim() : "";
	if (!title) return undefined;
	const rows: ReportMetricRow[] = [];
	for (const raw of value.rows.slice(0, METRIC_MAX_ROWS)) {
		const row = parseRow(raw);
		if (!row) return undefined;
		rows.push(row);
	}
	if (rows.length === 0) return undefined;
	return { title: title.slice(0, METRIC_TITLE_MAX), rows };
}

/** Latest chart per title, oldest first, bounded to `METRIC_MAX_CHARTS`. */
export function mergeReportMetric(existing: readonly unknown[], metric: ReportMetricDetails): ReportMetricDetails[] {
	const kept = existing
		.map(parseReportMetricDetails)
		.filter((item): item is ReportMetricDetails => item !== undefined && item.title !== metric.title);
	kept.push(metric);
	return kept.slice(-METRIC_MAX_CHARTS);
}

export function formatMetricValue(value: number): string {
	if (value >= 10_000) return formatNumber(value);
	if (Number.isInteger(value)) return String(value);
	return String(Number(value.toFixed(2)));
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function renderBar(fraction: number, cells: number, ascii: boolean): string {
	const exact = Math.min(Math.max(fraction, 0), 1) * cells;
	const full = Math.floor(exact);
	if (ascii) return "#".repeat(full);
	const partial = EIGHTHS[Math.floor((exact - full) * 8)] ?? "";
	return "█".repeat(full) + partial;
}

function padToWidth(text: string, width: number, alignRight = false): string {
	const pad = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return alignRight ? pad + text : text + pad;
}

/**
 * Render one metric as a title line plus one bar row per entry, fitted to
 * `width` columns including `prefix`. Too narrow for a readable bar, the rows
 * collapse into one `label value · label value` text line.
 */
export function renderMetricChart(metric: ReportMetricDetails, prefix: string, width: number, theme: Theme): string[] {
	const lines = [truncateToWidth(`${prefix}${theme.tree.hook} ${theme.fg("muted", metric.title)}`, width)];
	const rowPrefix = `${prefix}  `;
	const values = metric.rows.map(row => formatMetricValue(row.value));
	const labelCells = Math.min(LABEL_MAX_CELLS, Math.max(...metric.rows.map(row => visibleWidth(row.label))));
	const valueCells = Math.max(...values.map(value => visibleWidth(value)));
	const barCells = Math.min(BAR_MAX_CELLS, width - visibleWidth(rowPrefix) - labelCells - valueCells - 2);
	if (barCells < BAR_MIN_CELLS) {
		const text = metric.rows.map((row, index) => `${row.label} ${values[index]}`).join(theme.sep.dot);
		lines.push(truncateToWidth(`${rowPrefix}${theme.fg("dim", text)}`, width));
		return lines;
	}
	const max = Math.max(...metric.rows.map(row => row.value));
	const ascii = theme.getSymbolPreset() === "ascii";
	metric.rows.forEach((row, index) => {
		const label = padToWidth(truncateToWidth(row.label, labelCells), labelCells);
		const bar = padToWidth(renderBar(max > 0 ? row.value / max : 0, barCells, ascii), barCells);
		const value = padToWidth(values[index]!, valueCells, true);
		lines.push(`${rowPrefix}${theme.fg("dim", label)} ${theme.fg("accent", bar)} ${value}`);
	});
	return lines;
}

/**
 * Charts for a subagent's progress: the latest chart while collapsed, all kept
 * charts when expanded.
 */
export function renderMetricCharts(
	metrics: readonly ReportMetricDetails[],
	prefix: string,
	width: number,
	expanded: boolean,
	theme: Theme,
): string[] {
	const shown = expanded ? metrics : metrics.slice(-1);
	return shown.flatMap(metric => renderMetricChart(metric, prefix, width, theme));
}

export const reportMetricTool: AgentTool<typeof ReportMetricParams, ReportMetricDetails, Theme> = {
	name: "report_metric",
	label: "Report Metric",
	description: [
		"Show a small bar chart of comparable non-negative numbers in the parent's live task card while you work,",
		"e.g. sizes per format or timings per variant. Reporting again with the same title replaces that chart.",
		"Display only: the parent agent does not receive it, so include the numbers in your yield result as well.",
		"Use it only for numeric comparisons you actually measured, not for status updates.",
	].join(" "),
	parameters: ReportMetricParams,
	intent: "omit",
	async execute(_toolCallId, params) {
		const details: ReportMetricDetails = {
			title: params.title,
			rows: params.rows.map(row => ({ label: row.label, value: row.value })),
		};
		return {
			content: [{ type: "text", text: `Metric shown: ${details.title} (${details.rows.length} rows)` }],
			details,
		};
	},

	renderCall(args, _options, theme): Component {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("report_metric "))}${theme.fg("dim", String(args.title ?? ""))}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme): Component {
		const metric = parseReportMetricDetails(result.details);
		if (!metric) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}
		return {
			render: width => renderMetricChart(metric, "", width, theme),
			invalidate() {},
		};
	},
};

subprocessToolRegistry.register<ReportMetricDetails>("report_metric", {
	extractData: event => (event.isError ? undefined : parseReportMetricDetails(event.result?.details)),
});
