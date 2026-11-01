/**
 * Shared chart primitives for the dashboard timeline charts (BehaviorChart,
 * CostChart). Each chart owns its data shape and metric labels — this module
 * owns the layout, theme, legend/tooltip plumbing, and the top-N-by-model
 * bucketing scaffold that's identical between cost and behavior series.
 */

import { format } from "date-fns";
import type { ModelTimeSeriesPoint } from "../types";

export const MODEL_COLORS = [
	"#a78bfa", // violet
	"#22d3ee", // cyan
	"#ec4899", // pink
	"#4ade80", // green
	"#fbbf24", // amber
	"#f87171", // red
	"#60a5fa", // blue
];

export const CHART_THEMES = {
	dark: {
		legendLabel: "#94a3b8",
		tooltipBackground: "#16161e",
		tooltipTitle: "#f8fafc",
		tooltipBody: "#94a3b8",
		tooltipBorder: "rgba(255, 255, 255, 0.1)",
		grid: "rgba(255, 255, 255, 0.06)",
		tick: "#64748b",
	},
	light: {
		legendLabel: "#475569",
		tooltipBackground: "#ffffff",
		tooltipTitle: "#0f172a",
		tooltipBody: "#334155",
		tooltipBorder: "rgba(15, 23, 42, 0.18)",
		grid: "rgba(15, 23, 42, 0.08)",
		tick: "#64748b",
	},
} as const;

export type ChartTheme = (typeof CHART_THEMES)[keyof typeof CHART_THEMES];

export interface ChartSeries {
	labels: string[];
	datasets: Array<{ label: string; data: number[] }>;
}

interface TooltipItem {
	parsed: { y: number | null };
}

/** Tooltip + legend config common to bar and line variants of the time charts. */
export function buildSharedPlugins(opts: {
	chartTheme: ChartTheme;
	showLegend: boolean;
	defaultLabel: string;
	formatValue: (n: number) => string;
	footer?: (items: TooltipItem[]) => string | undefined;
}) {
	const { chartTheme, showLegend, defaultLabel, formatValue, footer } = opts;
	return {
		legend: {
			display: showLegend,
			position: "top" as const,
			align: "start" as const,
			labels: {
				color: chartTheme.legendLabel,
				usePointStyle: true,
				padding: 16,
				font: { size: 12 },
				boxWidth: 8,
			},
		},
		tooltip: {
			backgroundColor: chartTheme.tooltipBackground,
			titleColor: chartTheme.tooltipTitle,
			bodyColor: chartTheme.tooltipBody,
			borderColor: chartTheme.tooltipBorder,
			borderWidth: 1,
			padding: 12,
			cornerRadius: 8,
			callbacks: {
				label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => {
					const label = ctx.dataset.label ?? defaultLabel;
					const value = ctx.parsed.y ?? 0;
					return `${label}: ${formatValue(value)}`;
				},
				...(footer ? { footer } : {}),
			},
		},
	};
}

/** Y-axis tick formatter + grid/tick styling shared by both charts. */
export function buildSharedScales(opts: { chartTheme: ChartTheme; formatY: (n: number) => string }) {
	const { chartTheme, formatY } = opts;
	const sharedScaleBase = {
		grid: { color: chartTheme.grid, drawBorder: false },
		ticks: { color: chartTheme.tick, font: { size: 11 } },
	};
	const yScale = {
		...sharedScaleBase,
		ticks: {
			...sharedScaleBase.ticks,
			callback: (value: number | string) => formatY(Number(value)),
		},
		min: 0,
	};
	return { sharedScaleBase, yScale };
}

/** Stylistic defaults for a single line dataset in a stacked/by-model chart. */
export function lineDatasetStyle(color: string) {
	return {
		borderColor: color,
		backgroundColor: `${color}20`,
		fill: true,
		tension: 0,
		pointRadius: 3,
		pointHoverRadius: 4,
		borderWidth: 2,
	};
}

/** Stylistic defaults for a single bar dataset in a stacked chart. */
export function barDatasetStyle(color: string) {
	return {
		backgroundColor: color,
		borderColor: color,
		borderWidth: 0,
		borderRadius: 3,
	};
}

/**
 * Map a generic ChartSeries' datasets through a per-index style function so
 * callers can supply line or bar styling without repeating the label/data
 * spread at every chart site.
 */
export function styleDatasets(series: ChartSeries, styleFor: (index: number) => Record<string, unknown>) {
	return series.datasets.map((ds, index) => ({
		label: ds.label,
		data: ds.data,
		...styleFor(index),
	}));
}

/**
 * Bucket points by day into a single aggregate series. Caller supplies the
 * per-bucket accumulator + final value extractor; mirrors the shape of
 * `buildTopNByModelSeries` for the non-by-model variant of each time chart.
 */
export function buildAggregateTimeSeries<T extends { timestamp: number }, B>(
	points: T[],
	label: string,
	opts: {
		initBucket: () => B;
		accumulate: (bucket: B, point: T) => void;
		bucketToValue: (bucket: B) => number;
	},
): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };
	const { initBucket, accumulate, bucketToValue } = opts;
	const byDay = new Map<number, B>();
	for (const point of points) {
		const bucket = byDay.get(point.timestamp) ?? initBucket();
		accumulate(bucket, point);
		byDay.set(point.timestamp, bucket);
	}
	const sorted = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
	return {
		labels: sorted.map(([ts]) => format(new Date(ts), "MMM d")),
		datasets: [{ label, data: sorted.map(([, bucket]) => bucketToValue(bucket)) }],
	};
}

interface ModelKeyedPoint {
	timestamp: number;
	model: string;
	provider: string;
}

/**
 * Bucket points by day and by top-N model (with an "Other" rollup), producing
 * a ChartSeries. Caller controls how points contribute to ranking and to each
 * day-bucket value via the `rankWeight`/`accumulate`/`bucketToValue` callbacks
 * — keeps the behavior chart's rate math separate from the cost chart's sum.
 */
export function buildTopNByModelSeries<T extends ModelKeyedPoint, B>(
	points: T[],
	opts: {
		topN?: number;
		rankWeight: (point: T) => number;
		initBucket: () => B;
		accumulate: (bucket: B, point: T) => void;
		bucketToValue: (bucket: B) => number;
	},
): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };
	const { topN = 5, rankWeight, initBucket, accumulate, bucketToValue } = opts;

	const totals = new Map<string, { model: string; provider: string; weight: number }>();
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		if (existing) {
			existing.weight += rankWeight(point);
		} else {
			totals.set(key, { model: point.model, provider: point.provider, weight: rankWeight(point) });
		}
	}

	const sorted = [...totals.entries()].sort((a, b) => b[1].weight - a[1].weight);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(([key]) => key));

	const modelCount = new Map<string, number>();
	for (const [, { model }] of topEntries) {
		modelCount.set(model, (modelCount.get(model) ?? 0) + 1);
	}
	const labelByKey = new Map<string, string>();
	for (const [key, { model, provider }] of topEntries) {
		labelByKey.set(key, (modelCount.get(model) ?? 0) > 1 ? `${model} (${provider})` : model);
	}

	const allDays = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);
	const seriesNames = topEntries.map(([key]) => labelByKey.get(key) ?? key);
	const hasOther = points.some(p => !topKeys.has(`${p.model}::${p.provider}`));
	if (hasOther) seriesNames.push("Other");

	// Model labels are attacker-controlled strings. A plain object would treat
	// "__proto__" as the inherited prototype and mutate Object.prototype.
	const dayMap = new Map<number, Map<string, B>>();
	for (const day of allDays) dayMap.set(day, new Map());
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const label = topKeys.has(key) ? (labelByKey.get(key) ?? point.model) : "Other";
		const row = dayMap.get(point.timestamp);
		if (!row) continue;
		const bucket = row.get(label) ?? initBucket();
		accumulate(bucket, point);
		row.set(label, bucket);
	}

	return {
		labels: allDays.map(ts => format(new Date(ts), "MMM d")),
		datasets: seriesNames.map(name => ({
			label: name,
			data: allDays.map(day => {
				const bucket = dayMap.get(day)?.get(name);
				return bucket ? bucketToValue(bucket) : 0;
			}),
		})),
	};
}

// Model and provider names are unrestricted strings, so a delimiter-joined key
// ("a::b" + "c" vs "a" + "b::c") could merge two distinct model/provider pairs.
// JSON tuple keys cannot collide.
const modelKey = (model: string, provider: string) => JSON.stringify([model, provider]);

export function buildModelPreferenceSeries(
	points: ModelTimeSeriesPoint[],
	topN = 5,
): {
	data: Array<{ timestamp: number; total: number; shares: Record<string, number> }>;
	series: string[];
} {
	if (points.length === 0) return { data: [], series: [] };

	const totals = new Map<string, { model: string; provider: string; total: number }>();
	for (const point of points) {
		const key = modelKey(point.model, point.provider);
		const existing = totals.get(key);
		if (existing) {
			existing.total += point.requests;
		} else {
			totals.set(key, { model: point.model, provider: point.provider, total: point.requests });
		}
	}

	const sorted = [...totals.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.total - a.total);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(entry => entry.key));

	const topModelCounts = new Map<string, number>();
	for (const entry of topEntries) {
		topModelCounts.set(entry.model, (topModelCounts.get(entry.model) ?? 0) + 1);
	}

	const labelByKey = new Map<string, string>();
	const usedLabels = new Set<string>();
	// Provider-qualified labels ("foo (bar)") are the existing contract when one
	// model spans providers, so assign them first: a literal model named like
	// such a label must not take it over or merge the two series' shares. A
	// colliding entry is extended with its own provider. Every label is kept
	// unique; pass 1 still follows topEntries' request-rank order.
	for (const entry of topEntries) {
		if ((topModelCounts.get(entry.model) ?? 0) > 1) {
			let label = `${entry.model} (${entry.provider})`;
			while (usedLabels.has(label)) label = `${label} (${entry.provider})`;
			labelByKey.set(entry.key, label);
			usedLabels.add(label);
		}
	}
	// Pass 2 runs in key order, not request-rank order, so the labels do not
	// depend on which colliding model happens to have more requests.
	const singleProviderEntries = topEntries
		.filter(entry => !labelByKey.has(entry.key))
		.sort((a, b) => (a.key < b.key ? -1 : 1));
	for (const entry of singleProviderEntries) {
		let label = entry.model;
		while (usedLabels.has(label)) label = `${label} (${entry.provider})`;
		labelByKey.set(entry.key, label);
		usedLabels.add(label);
	}

	const series = topEntries.map(entry => labelByKey.get(entry.key) ?? entry.model);
	// The synthetic rollup label must be unique among the top-series labels: a
	// top model can itself be named "Other" (or "Other models", ...), so pick
	// the first unused label rather than assuming a single rename is enough.
	let otherLabel = "Other";
	while (series.includes(otherLabel)) otherLabel = `${otherLabel} models`;

	// Model labels are unrestricted strings. A plain object would resolve
	// inherited keys like "constructor" from the prototype, silently drop
	// "__proto__" writes, and let models named "total"/"timestamp" corrupt the
	// row's own bookkeeping, so buckets accumulate in Maps and label shares
	// live in their own namespace instead of mixing with row bookkeeping.
	const dataMap = new Map<number, Map<string, number>>();
	const dayTotals = new Map<number, number>();

	for (const point of points) {
		const key = modelKey(point.model, point.provider);
		const seriesLabel = topKeys.has(key) ? (labelByKey.get(key) ?? point.model) : otherLabel;
		const bucket = dataMap.get(point.timestamp) ?? new Map<string, number>();
		bucket.set(seriesLabel, (bucket.get(seriesLabel) ?? 0) + point.requests);
		dataMap.set(point.timestamp, bucket);
		dayTotals.set(point.timestamp, (dayTotals.get(point.timestamp) ?? 0) + point.requests);
	}

	if ([...dataMap.values()].some(row => (row.get(otherLabel) ?? 0) > 0)) {
		series.push(otherLabel);
	}

	const data = [...dataMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([timestamp, row]) => {
			const total = dayTotals.get(timestamp) ?? 0;
			const shares: Array<[string, number]> = [];
			for (const key of series) {
				shares.push([key, total > 0 ? ((row.get(key) ?? 0) / total) * 100 : 0]);
			}
			// Object.fromEntries stores "__proto__" as an own property instead of
			// routing the write to the prototype setter.
			return { timestamp, total, shares: Object.fromEntries(shares) };
		});

	return { data, series };
}

/** All Models / By Model segmented toggle — identical UI in every time chart. */
function ByModelToggle({ byModel, onChange }: { byModel: boolean; onChange: (v: boolean) => void }) {
	return (
		<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-sm)] p-0.5 border border-[var(--border-subtle)]">
			<button
				type="button"
				onClick={() => onChange(false)}
				className={`tab-btn text-xs ${!byModel ? "active" : ""}`}
			>
				All Models
			</button>
			<button type="button" onClick={() => onChange(true)} className={`tab-btn text-xs ${byModel ? "active" : ""}`}>
				By Model
			</button>
		</div>
	);
}

/**
 * Outer surface card used by both time charts. `controls` slot covers
 * chart-specific tabs (e.g. behavior metric picker); the by-model toggle and
 * empty-state are part of the frame so callers don't redeclare them.
 */
export function ChartFrame({
	title,
	subtitle,
	empty,
	emptyMessage,
	controls,
	byModel,
	onByModelChange,
	children,
}: {
	title: string;
	subtitle: string;
	empty: boolean;
	emptyMessage: string;
	controls?: React.ReactNode;
	byModel: boolean;
	onByModelChange: (v: boolean) => void;
	children: React.ReactNode;
}) {
	return (
		<div className="surface overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 flex-wrap">
				<div>
					<h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
					<p className="text-xs text-[var(--text-muted)] mt-1">{subtitle}</p>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					{controls}
					<ByModelToggle byModel={byModel} onChange={onByModelChange} />
				</div>
			</div>
			<div className="p-5 min-h-[320px]">
				{empty ? (
					<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
						{emptyMessage}
					</div>
				) : (
					<div className="h-[280px]">{children}</div>
				)}
			</div>
		</div>
	);
}
