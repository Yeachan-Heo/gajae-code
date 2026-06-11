/**
 * TUI renderer for the `subagent` tool.
 *
 * The await panel surfaces each awaited subagent's live streaming status at
 * parity with the inline `task` panel by reusing `renderSubagentLiveProgress`.
 * Falls back to a `running, no activity yet` placeholder when a live producer
 * exists but has not emitted yet, and to a static status line when no live
 * producer is available (resumed-from-disk or backward-compat records).
 */
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderSubagentLiveProgress } from "../task/render";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine } from "../tui";
import {
	formatDuration,
	formatStatusIcon,
	getPreviewLines,
	replaceTabs,
	type ToolUIStatus,
	truncateToWidth,
} from "./render-utils";
import type { SubagentSnapshot, SubagentToolDetails } from "./subagent";

const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const PREVIEW_LINE_WIDTH = 80;

function statusIconKind(status: SubagentSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
		case "already_completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "not_found":
			return "warning";
		case "queued":
			return "pending";
		default:
			return "info";
	}
}

function renderSubagentSnapshot(
	snapshot: SubagentSnapshot,
	expanded: boolean,
	theme: Theme,
	spinnerFrame: number | undefined,
): string[] {
	const lines: string[] = [];
	const icon = formatStatusIcon(
		statusIconKind(snapshot.status),
		theme,
		snapshot.status === "running" ? spinnerFrame : undefined,
	);
	const id = theme.fg("muted", snapshot.id);
	const status = theme.fg("dim", snapshot.status);
	const duration = theme.fg("dim", formatDuration(snapshot.durationMs));
	lines.push(`${icon} ${id} ${status} ${duration}`);

	// Static receipt fields (parity with the markdown content for non-await actions).
	if (snapshot.jobId !== snapshot.id) lines.push(`  ${theme.fg("dim", `Job: ${snapshot.jobId}`)}`);
	if (snapshot.agent && snapshot.agent !== "unknown") {
		lines.push(`  ${theme.fg("dim", `Agent: ${snapshot.agent} (${snapshot.agentSource})`)}`);
	}
	if (snapshot.description) lines.push(`  ${theme.fg("dim", `Description: ${snapshot.description}`)}`);
	if (snapshot.outputRef) lines.push(`  ${theme.fg("dim", `Output: ${snapshot.outputRef}`)}`);
	if (snapshot.assignment) {
		lines.push(`  ${theme.fg("dim", "Assignment:")}`);
		for (const al of snapshot.assignment.split("\n")) lines.push(`    ${theme.fg("toolOutput", replaceTabs(al))}`);
	}

	// Defense in depth: the producer only attaches `progress` when a live
	// producer exists (subagent.ts #liveProgressFields), but the renderer
	// also honors an explicit `liveProgressAvailable: false` so stale retained
	// progress can never resurrect a live panel (AC5).
	if (snapshot.progress && snapshot.liveProgressAvailable !== false) {
		// Live streaming panel (full task-panel parity), indented under the header.
		for (const pl of renderSubagentLiveProgress(snapshot.progress, expanded, theme, spinnerFrame)) {
			lines.push(`  ${pl}`);
		}
	} else if (snapshot.liveProgressAvailable && (snapshot.status === "running" || snapshot.status === "queued")) {
		lines.push(`  ${theme.fg("dim", "running, no activity yet")}`);
	}

	const preview = snapshot.errorText?.trim() || snapshot.resultText?.trim();
	if (preview) {
		const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
		const tone = snapshot.errorText ? "error" : "dim";
		for (const pl of getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode)) {
			lines.push(`  ${theme.fg(tone, replaceTabs(pl))}`);
		}
		if (snapshot.truncated) {
			lines.push(
				`  ${theme.fg("dim", "Preview truncated; use the output ref or explicit ids with `verbosity=full` for more.")}`,
			);
		}
	}

	if (snapshot.guidance) lines.push(`  ${theme.fg("dim", snapshot.guidance)}`);
	return lines;
}

export const subagentToolRenderer = {
	inline: true,

	renderCall(_args: unknown, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(renderStatusLine({ icon: "pending", title: "Subagent" }, theme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
		options: RenderResultOptions,
		theme: Theme,
	): Component {
		const subagents = result.details?.subagents ?? [];
		if (subagents.length === 0) {
			const fallback = result.content.find(c => c.type === "text")?.text || "No subagents";
			return new Text(theme.fg("dim", truncateToWidth(fallback, 100)), 0, 0);
		}

		const runningCount = subagents.filter(s => s.status === "running").length;

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const expanded = options.expanded;
				const spinnerFrame = options.spinnerFrame ?? 0;
				const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).digest();
				if (cached?.key === key) return cached.lines;

				const header = renderStatusLine(
					{
						icon: runningCount > 0 ? "info" : "success",
						spinnerFrame: runningCount > 0 ? options.spinnerFrame : undefined,
						title: "Subagent",
						description:
							runningCount > 0
								? `awaiting ${runningCount} of ${subagents.length}`
								: `${subagents.length} ${subagents.length === 1 ? "subagent" : "subagents"}`,
					},
					theme,
				);

				const lines: string[] = [header];
				// Discoverability: the inline panel is a bounded preview; the session
				// observer (ctrl+s) streams the full per-subagent message history.
				if (runningCount > 0) {
					lines.push(`  ${theme.fg("dim", "(ctrl+s to observe sessions)")}`);
				}
				for (const snapshot of subagents) {
					lines.push(...renderSubagentSnapshot(snapshot, expanded, theme, options.spinnerFrame));
				}

				const out = lines.map(l => (l.length > 0 ? truncateToWidth(l, width, Ellipsis.Omit) : ""));
				cached = { key, lines: out };
				return out;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},

	mergeCallAndResult: true,
};
