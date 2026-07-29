/**
 * Review tools - report_finding for structured code review.
 *
 * Used by the reviewer agent to report findings in a structured way.
 * Hidden by default - only enabled when explicitly listed in agent's tools.
 * Reviewers finish via `yield` tool with SubmitReviewDetails schema.
 */
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import type { AgentTool } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Container, Text } from "@gajae-code/tui";
import { isRecord } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ReviewFinding } from "../task/types";
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: "status.error" | "status.warning" | "status.info";
	color: ThemeColor;
}

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

export function getPriorityInfo(priority: FindingPriority): FindingPriorityInfo {
	return PRIORITY_INFO[priority] ?? { ord: 3, symbol: "status.info", color: "muted" };
}

function getPriorityDisplay(
	priority: FindingPriority,
	theme: Theme,
): { label: string; icon: string; color: ThemeColor } {
	const label = priority;
	const meta = PRIORITY_INFO[priority] ?? { symbol: "status.info", color: "muted" as const };
	return {
		label,
		icon: theme.styledSymbol(meta.symbol, meta.color),
		color: meta.color,
	};
}

// report_finding schema
// report_finding schema
const ReportFindingParams = z
	.object({
		title: z.string().describe("prefixed imperative title"),
		body: z.string().describe("problem explanation"),
		priority: z.enum(["P0", "P1", "P2", "P3"] as const).describe("priority 0-3"),
		confidence: z.number().min(0).max(1).describe("confidence score"),
		file_path: z.string().describe("file path"),
		line_start: z.number().describe("start line"),
		line_end: z.number().describe("end line"),
	})
	.strict();

interface ReportFindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

export function parseReportFindingDetails(value: unknown): ReportFindingDetails | undefined {
	if (!isRecord(value)) return undefined;

	const title = typeof value.title === "string" ? value.title : undefined;
	const body = typeof value.body === "string" ? value.body : undefined;
	const priority = isFindingPriority(value.priority) ? value.priority : undefined;
	const confidence =
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1
			? value.confidence
			: undefined;
	const filePath = typeof value.file_path === "string" && value.file_path.length > 0 ? value.file_path : undefined;
	const lineStart =
		typeof value.line_start === "number" && Number.isFinite(value.line_start) ? value.line_start : undefined;
	const lineEnd = typeof value.line_end === "number" && Number.isFinite(value.line_end) ? value.line_end : undefined;

	if (
		title === undefined ||
		body === undefined ||
		priority === undefined ||
		confidence === undefined ||
		filePath === undefined ||
		lineStart === undefined ||
		lineEnd === undefined
	) {
		return undefined;
	}

	return {
		title,
		body,
		priority,
		confidence,
		file_path: filePath,
		line_start: lineStart,
		line_end: lineEnd,
	};
}

export const reportFindingTool: AgentTool<typeof ReportFindingParams, ReportFindingDetails, Theme> = {
	name: "report_finding",
	label: "Report Finding",
	description: "Report a code review finding. Use this for each issue found. Call yield when done.",
	parameters: ReportFindingParams,
	intent: "omit",
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { title, body, priority, confidence, file_path, line_start, line_end } = params;
		const location = `${file_path}:${line_start}${line_end !== line_start ? `-${line_end}` : ""}`;

		return {
			content: [
				{
					type: "text",
					text: `Finding recorded: ${priority} ${title}\nLocation: ${location}\nConfidence: ${(
						confidence * 100
					).toFixed(0)}%`,
				},
			],
			details: { title, body, priority, confidence, file_path, line_start, line_end },
		};
	},

	renderCall(args, _options, theme): Component {
		const { label, icon, color } = getPriorityDisplay(args.priority, theme);
		const titleText = String(args.title).replace(/^\[P\d\]\s*/, "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("report_finding "))}${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg(
				"dim",
				titleText,
			)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme): Component {
		const { details } = result;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		const { label, icon, color } = getPriorityDisplay(details.priority, theme);
		const location = `${details.file_path}:${details.line_start}${
			details.line_end !== details.line_start ? `-${details.line_end}` : ""
		}`;

		return new Text(
			`${theme.fg("success", theme.status.success)} ${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg(
				"dim",
				location,
			)}`,
			0,
			0,
		);
	},
};

/** SubmitReviewDetails - used for rendering review results from yield tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

// Re-export types for external use
export type { ReportFindingDetails };
/**
 * Convert tool-side `ReportFindingDetails` into the numeric-priority
 * `ReviewFinding` shape used by caller-owned reviewer payloads.
 *
 * The `report_finding` tool exposes `priority` as a string enum (`"P0".."P3"`)
 * for ergonomics, while reviewer schemas may explicitly declare numeric
 * priorities. This pure conversion does not add findings to completion data;
 * callers that include `findings` own both that field and its output schema.
 */
export function toReviewFinding(details: ReportFindingDetails): ReviewFinding {
	return {
		title: details.title,
		body: details.body,
		priority: getPriorityInfo(details.priority).ord,
		confidence: details.confidence,
		file_path: details.file_path,
		line_start: details.line_start,
		line_end: details.line_end,
	};
}

// Register report_finding handler
subprocessToolRegistry.register<ReportFindingDetails>("report_finding", {
	extractData: event => {
		if (event.isError) return undefined;
		return parseReportFindingDetails(event.result?.details);
	},

	renderInline: (data, theme) => {
		const { label, icon, color } = getPriorityDisplay(data.priority, theme);
		const titleText = data.title.replace(/^\[P\d\]\s*/, "");
		const loc = `${path.basename(data.file_path)}:${data.line_start}`;
		return new Text(`${icon} ${theme.fg(color, `[${label}]`)} ${titleText} ${theme.fg("dim", loc)}`, 0, 0);
	},

	renderFinal: (allData, theme, expanded) => {
		const container = new Container();
		const displayCount = expanded ? allData.length : Math.min(3, allData.length);

		for (let i = 0; i < displayCount; i++) {
			const data = allData[i];
			const { label, icon, color } = getPriorityDisplay(data.priority, theme);
			const titleText = data.title.replace(/^\[P\d\]\s*/, "");
			const loc = `${path.basename(data.file_path)}:${data.line_start}`;

			container.addChild(
				new Text(`  ${icon} ${theme.fg(color, `[${label}]`)} ${titleText} ${theme.fg("dim", loc)}`, 0, 0),
			);

			if (expanded && data.body) {
				container.addChild(new Text(`    ${theme.fg("dim", data.body)}`, 0, 0));
			}
		}

		if (allData.length > displayCount) {
			container.addChild(new Text(theme.fg("dim", `  … ${allData.length - displayCount} more findings`), 0, 0));
		}

		return container;
	},
});
