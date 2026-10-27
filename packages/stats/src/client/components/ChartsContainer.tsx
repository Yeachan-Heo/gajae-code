import {
	CategoryScale,
	Chart as ChartJS,
	Filler,
	Legend,
	LinearScale,
	LineElement,
	PointElement,
	Title,
	Tooltip,
} from "chart.js";
import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import type { ModelTimeSeriesPoint, TimeRange } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import { buildModelPreferenceSeries } from "./chart-shared";
import { formatRangeTick, rangeMeta } from "./range-meta";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const MODEL_COLORS = [
	"#a78bfa", // violet
	"#22d3ee", // cyan
	"#ec4899", // pink
	"#4ade80", // green
	"#fbbf24", // amber
	"#f87171", // red
	"#60a5fa", // blue
];

const CHART_THEMES = {
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
interface ChartsContainerProps {
	modelSeries: ModelTimeSeriesPoint[];
	timeRange: TimeRange;
}

export function ChartsContainer({ modelSeries, timeRange }: ChartsContainerProps) {
	const chartData = useMemo(() => buildModelPreferenceSeries(modelSeries), [modelSeries]);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const meta = rangeMeta(timeRange);
	const data = {
		labels: chartData.data.map(d => formatRangeTick(d.timestamp, timeRange)),
		datasets: chartData.series.map((seriesName, index) => ({
			label: seriesName,
			data: chartData.data.map(d => d.shares[seriesName] ?? 0),
			borderColor: MODEL_COLORS[index % MODEL_COLORS.length],
			backgroundColor: `${MODEL_COLORS[index % MODEL_COLORS.length]}20`,
			fill: true,
			tension: 0.4,
			pointRadius: 0,
			pointHoverRadius: 4,
			borderWidth: 2,
		})),
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: {
			mode: "index" as const,
			intersect: false,
		},
		plugins: {
			legend: {
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
					label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => {
						const label = context.dataset.label ?? "";
						const value = context.parsed.y;
						return `${label}: ${(value ?? 0).toFixed(1)}%`;
					},
				},
			},
		},
		scales: {
			x: {
				grid: {
					color: chartTheme.grid,
					drawBorder: false,
				},
				ticks: {
					color: chartTheme.tick,
					font: { size: 11 },
				},
			},
			y: {
				grid: {
					color: chartTheme.grid,
					drawBorder: false,
				},
				ticks: {
					color: chartTheme.tick,
					font: { size: 11 },
					callback: (value: number | string) => `${value}%`,
				},
				min: 0,
				max: 100,
			},
		},
	};

	return (
		<div className="surface overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)]">
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">Model Preference</h3>
				<p className="text-xs text-[var(--text-muted)] mt-1">Share of requests over {meta.windowLabel}</p>
			</div>
			<div className="p-5 min-h-[320px]">
				{chartData.data.length === 0 ? (
					<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
						No data available
					</div>
				) : (
					<div className="h-[280px]">
						<Line data={data} options={options} />
					</div>
				)}
			</div>
		</div>
	);
}
