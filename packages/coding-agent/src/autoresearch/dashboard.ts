/**
 * Autoresearch TUI dashboard (ported from the deleted extension's
 * `dashboard.ts`): run table plus collapsed/expanded rendering.
 *
 * The extension version rendered through TUI widget/overlay machinery with
 * theme colors; this rebuild renders the same content as sanitized plain text
 * lines (every string passes through `replaceTabs` and `truncateToWidth` like
 * the other renderers) so it can be shown in any text surface.
 */
import { replaceTabs, truncateToWidth } from "@gajae-code/tui";
import { formatElapsed, formatNum, isBetter } from "./harness";
import {
	type AutoresearchExperimentResult,
	type AutoresearchExperimentState,
	findBaselineMetric,
	findBaselineRunNumber,
	findBaselineSecondary,
} from "./runs";

export interface AutoresearchDashboardRuntime {
	modeOn: boolean;
	running?: { command: string; startedAt: number } | null;
	pendingRun?: {
		runNumber: number;
		passed: boolean;
		parsedPrimary: number | null;
	} | null;
}

export interface AutoresearchDashboardInput {
	state: AutoresearchExperimentState;
	runtime?: AutoresearchDashboardRuntime;
}

/** Collapsed one-line summary. */
export function renderCollapsedLine(input: AutoresearchDashboardInput, width = 120): string {
	const state = input.state;
	const runtime = input.runtime ?? { modeOn: true };
	if (runtime.pendingRun) {
		const parts = [
			"autoresearch",
			` pending run #${runtime.pendingRun.runNumber}`,
			runtime.pendingRun.passed ? " pass" : " fail",
		];
		if (runtime.pendingRun.parsedPrimary !== null) {
			parts.push(` | ${state.metricName}=${formatNum(runtime.pendingRun.parsedPrimary, state.metricUnit)}`);
		}
		parts.push(" | log required");
		if (!runtime.modeOn) parts.push(" | mode off");
		return truncateToWidth(replaceTabs(parts.join("")), width);
	}
	if (state.results.length === 0) {
		const modeStatus = runtime.modeOn ? "baseline pending" : "mode off";
		const parts = ["autoresearch", ` ${modeStatus}`];
		if (state.name) parts.push(` | ${replaceTabs(state.name)}`);
		if (runtime.modeOn) parts.push(" | run the baseline");
		return truncateToWidth(replaceTabs(parts.join("")), width);
	}
	const current = state.results.filter(result => result.segment === state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const best = findBestResult(state);
	const archivedRuns = Math.max(0, state.results.length - current.length);
	const parts = ["autoresearch", ` ${current.length} runs`, ` ${kept} kept`];
	if (archivedRuns > 0) parts.push(` +${archivedRuns} archived`);
	if (crashed > 0) parts.push(` ${crashed} crash`);
	if (checksFailed > 0) parts.push(` ${checksFailed} checks_failed`);
	parts.push(" | ");
	if (best && state.bestMetric !== null && best.metric !== state.bestMetric) {
		parts.push(`best ${formatNum(best.metric, state.metricUnit)}`);
		parts.push(` baseline ${formatNum(state.bestMetric, state.metricUnit)}`);
	} else if (state.bestMetric !== null) {
		parts.push(`baseline ${formatNum(state.bestMetric, state.metricUnit)}`);
	} else {
		parts.push("no kept runs yet");
	}
	if (state.confidence !== null) {
		parts.push(" | ");
		parts.push(`conf ${state.confidence.toFixed(1)}x`);
	}
	if (runtime.running) {
		parts.push(` | running ${formatElapsed(Date.now() - runtime.running.startedAt)}`);
	} else if (!runtime.modeOn) {
		parts.push(" | mode off");
	}
	parts.push(" | ctrl+x expand");
	return truncateToWidth(replaceTabs(parts.join("")), width);
}

/** Expanded header line. */
export function renderExpandedHeader(input: AutoresearchDashboardInput, width = 120): string {
	const state = input.state;
	const label = state.name ? ` autoresearch: ${replaceTabs(state.name)} ` : " autoresearch ";
	const hint = " ctrl+x collapse  ctrl+shift+x overlay ";
	const fillWidth = Math.max(0, width - label.length - hint.length);
	return truncateToWidth(`${label}${"-".repeat(fillWidth)}${hint}`, width);
}

/**
 * Expanded dashboard body: segment summary, baseline/best lines, then the run
 * table. `maxRows > 0` keeps only the last `maxRows` rows of the current
 * segment (with an ellipsis for hidden earlier runs); `0` shows all.
 */
export function renderDashboardLines(input: AutoresearchDashboardInput, width = 120, maxRows = 0): string[] {
	const state = input.state;
	const runtime = input.runtime ?? { modeOn: true };
	if (state.results.length === 0) {
		if (runtime.pendingRun) {
			const lines = [
				truncateToWidth(`Pending run: #${runtime.pendingRun.runNumber}`, width),
				truncateToWidth(
					`Result: ${runtime.pendingRun.passed ? "passed" : "failed"}${
						runtime.pendingRun.parsedPrimary !== null
							? `  ${state.metricName} ${formatNum(runtime.pendingRun.parsedPrimary, state.metricUnit)}`
							: ""
					}`,
					width,
				),
				truncateToWidth("Next action: log the run before starting another benchmark.", width),
			];
			if (!runtime.modeOn) lines.push(truncateToWidth("Mode: off", width));
			return lines;
		}
		if (runtime.modeOn) {
			return [
				truncateToWidth("Current segment: 0 runs", width),
				truncateToWidth("Baseline: pending", width),
				truncateToWidth("Next action: run and log the baseline experiment.", width),
			];
		}
		return ["No experiments logged yet."];
	}

	const current = state.results.filter(result => result.segment === state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const discarded = current.filter(result => result.status === "discard").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const lines = [
		truncateToWidth(
			`Current segment: ${current.length} runs  ${kept} kept  ${discarded} discarded  ${crashed} crashed  ${checksFailed} checks_failed`,
			width,
		),
		truncateToWidth(
			`Baseline: ${formatNum(baseline, state.metricUnit)}${baselineRunNumber ? ` (#${baselineRunNumber})` : ""}`,
			width,
		),
	];
	if (state.results.length > current.length) {
		lines.push(
			truncateToWidth(`Archived from earlier segments: ${state.results.length - current.length} runs`, width),
		);
	}
	if (runtime.pendingRun) {
		lines.push(
			truncateToWidth(
				`Pending run: #${runtime.pendingRun.runNumber} (${runtime.pendingRun.passed ? "passed" : "failed"}) — log required`,
				width,
			),
		);
	}
	if (!runtime.modeOn) {
		lines.push(truncateToWidth("Mode: off", width));
	}
	if (best) {
		let progress = `Best: ${formatNum(best.metric, state.metricUnit)} (#${best.runNumber})`;
		if (baseline !== null && baseline !== 0 && best.metric !== baseline) {
			const delta = ((best.metric - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			progress += ` ${sign}${delta.toFixed(1)}%`;
		}
		if (state.confidence !== null) {
			progress += `  conf ${state.confidence.toFixed(1)}x`;
		}
		lines.push(truncateToWidth(progress, width));
		if (state.secondaryMetrics.length > 0) {
			const details = state.secondaryMetrics
				.map(metric =>
					renderSecondarySummary(
						metric.name,
						best.metrics[metric.name],
						baselineSecondary[metric.name],
						metric.unit,
					),
				)
				.filter((value): value is string => Boolean(value));
			if (details.length > 0) {
				lines.push(truncateToWidth(`Secondary: ${details.join("  ")}`, width));
			}
		}
	}
	lines.push("");
	lines.push(truncateToWidth(renderTableHeader(state), width));
	lines.push(truncateToWidth("-".repeat(Math.max(0, width - 1)), width));

	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	if (visible.length < current.length) {
		lines.push(`... ${current.length - visible.length} earlier runs hidden ...`);
	}
	for (const result of visible) {
		lines.push(truncateToWidth(renderResultRow(result, state, baselineSecondary), width));
	}
	return lines.map(line => replaceTabs(line));
}

/** The full expanded dashboard (header + body). */
export function renderExpandedDashboard(input: AutoresearchDashboardInput, width = 120, maxRows = 0): string {
	return [renderExpandedHeader(input, width), ...renderDashboardLines(input, width, maxRows)].join("\n");
}

function renderTableHeader(state: AutoresearchExperimentState): string {
	const secondaryHeader = state.secondaryMetrics.map(metric => truncateToWidth(metric.name, 10)).join(" ");
	return `${"#".padEnd(4)}${"commit".padEnd(10)}${state.metricName.padEnd(12)}${
		secondaryHeader ? `${secondaryHeader} ` : ""
	}${"status".padEnd(14)}description`;
}

function renderResultRow(
	result: AutoresearchExperimentResult,
	state: AutoresearchExperimentState,
	baselineSecondary: { [key: string]: number },
): string {
	const secondary = state.secondaryMetrics
		.map(metric =>
			truncateToWidth(
				renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
				10,
			).padEnd(11),
		)
		.join("");
	return (
		`${String(result.runNumber).padEnd(4)}` +
		`${(result.commit || "-").padEnd(10)}` +
		`${formatNum(result.metric, state.metricUnit).padEnd(12)}` +
		`${secondary}` +
		`${result.status.padEnd(14)}` +
		`${replaceTabs(result.description)}`
	);
}

function renderSecondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
	if (value === undefined) return "-";
	const formatted = formatNum(value, unit);
	if (baseline === undefined || baseline === 0 || baseline === value) return formatted;
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${formatted} ${sign}${delta.toFixed(1)}%`;
}

function renderSecondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	if (baseline === undefined || baseline === 0 || baseline === value) {
		return `${name} ${formatNum(value, unit)}`;
	}
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${name} ${formatNum(value, unit)} ${sign}${delta.toFixed(1)}%`;
}

/** Best kept, unflagged result in the current segment (direction-aware). */
function findBestResult(state: AutoresearchExperimentState): AutoresearchExperimentResult | null {
	let best: AutoresearchExperimentResult | null = null;
	for (const result of state.results) {
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.flagged || result.metric <= 0)
			continue;
		if (!best || isBetter(result.metric, best.metric, state.bestDirection)) {
			best = result;
		}
	}
	return best;
}
