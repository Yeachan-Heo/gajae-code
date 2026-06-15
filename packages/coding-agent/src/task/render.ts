/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import path from "node:path";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { formatNumber } from "@gajae-code/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import {
	formatBadge,
	formatBytes,
	formatDuration,
	formatMoreItems,
	formatStatusIcon,
	replaceTabs,
	truncateToWidth,
} from "../tools/render-utils";
import {
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseReportFindingDetails,
	type ReportFindingDetails,
	type SubmitReviewDetails,
} from "../tools/review";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine } from "../tui";
import type { TaskResultReceipt } from "./receipt";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, TaskParams, TaskToolDetails } from "./types";

/**
 * Get status icon for agent state.
 * For running status, uses animated spinner if spinnerFrame is provided.
 * Maps AgentProgress status to styled icon format.
 */
function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "aborted":
			return formatStatusIcon("aborted", theme);
		case "paused":
			return formatStatusIcon("pending", theme);
	}
}

/** Append tool-count, context, cumulative-tokens, and cost stats to a status line string. */
function appendAgentStats(
	line: string,
	opts: {
		toolCount?: number;
		tokens: number;
		contextTokens?: number;
		contextWindow?: number;
		cost: number;
	},
	theme: Theme,
): string {
	if (opts.toolCount) {
		line += `${theme.sep.dot}${theme.fg("dim", `${opts.toolCount} tools`)}`;
	}
	// Current per-turn context — what the user reads as "how full is the context".
	// Cumulative tokens (billing volume) renders separately with a Σ sigil to avoid
	// being mistaken for current window pressure.
	if (opts.contextTokens && opts.contextTokens > 0) {
		const ctx =
			opts.contextWindow && opts.contextWindow > 0
				? `${formatNumber(opts.contextTokens)}/${formatNumber(opts.contextWindow)} ctx`
				: `${formatNumber(opts.contextTokens)} ctx`;
		line += `${theme.sep.dot}${theme.fg("dim", ctx)}`;
		if (opts.tokens > 0) {
			line += `${theme.sep.dot}${theme.fg("dim", `Σ${formatNumber(opts.tokens)}`)}`;
		}
	} else if (opts.tokens > 0) {
		line += `${theme.sep.dot}${theme.fg("dim", `Σ${formatNumber(opts.tokens)}`)}`;
	}
	if (opts.cost > 0) {
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${opts.cost.toFixed(2)}`)}`;
	}
	return line;
}

function formatFindingSummary(findings: ReportFindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}

	const parts: string[] = [];
	for (const label of PRIORITY_LABELS) {
		const { symbol, color } = getPriorityInfo(label);
		const count = counts[label] ?? 0;
		const text = theme.fg(color, `${label}:${count}`);
		parts.push(theme.styledSymbol(symbol, color) ? `${theme.styledSymbol(symbol, color)} ${text}` : text);
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

function normalizeReportFindings(value: unknown): ReportFindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: ReportFindingDetails[] = [];
	for (const item of value) {
		const finding = parseReportFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

function formatModelSubstitutionWarning(warning: { requested: string; effective: string }): string {
	return `Requested model substituted: ${warning.requested} -> ${warning.effective}`;
}

function formatJsonScalar(value: unknown, _theme: Theme): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const trimmed = truncateToWidth(value, 70);
		return `"${trimmed}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function formatTaskId(id: string): string {
	const segments = id.split(".");
	if (segments.length < 2) return id;

	const parsed = segments.map(segment => segment.match(/^(\d+)-(.+)$/));
	if (parsed.some(match => !match)) return id;

	const indices = parsed.map(match => match![1]).join(".");
	const labels = parsed.map(match => match![2]).join(">");
	return `${indices} ${labels}`;
}

function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
		const scalar = formatJsonScalar(val, theme);

		if (scalar) {
			const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");
			pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
			return;
		}

		if (Array.isArray(val)) {
			const header = key ? theme.fg("muted", key) : theme.fg("muted", "array");
			pushLine(`${prefix}${iconArray} ${header}`);
			if (val.length === 0) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"[]",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = [...ancestors, !isLast];
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, nextAncestors, i === val.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		if (val && typeof val === "object") {
			const header = key ? theme.fg("muted", key) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			const entries = Object.entries(val as Record<string, unknown>);
			if (entries.length === 0) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"{}",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = [...ancestors, !isLast];
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, nextAncestors, i === entries.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");
		pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", String(val))}`);
	};

	const renderRoot = (val: unknown) => {
		if (Array.isArray(val)) {
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, [], i === val.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		if (val && typeof val === "object") {
			const entries = Object.entries(val as Record<string, unknown>);
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, [], i === entries.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		renderNode(val, undefined, [], true, 0);
	};

	renderRoot(value);

	return { lines, truncated };
}

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 3,
	maxExpanded = 10,
	warning?: string,
): string[] {
	const lines: string[] = [];
	const trimmedOutput = output.trimEnd();
	if (!trimmedOutput && !warning) return lines;

	if (warning) {
		lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
		lines.push(
			`${continuePrefix}  ${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(warning, 80),
			)}`,
		);

		if (!trimmedOutput) {
			return lines;
		}

		if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmedOutput);

				if (!expanded) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", formatOutputInline(parsed, theme))}`);
					return lines;
				}

				const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
				if (tree.lines.length > 0) {
					for (const line of tree.lines) {
						lines.push(`${continuePrefix}  ${line}`);
					}
					if (tree.truncated) {
						lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
					}
					return lines;
				}
			} catch {
				// Fall back to raw output
			}
		}

		const outputLines = output.trimEnd().split("\n");
		const previewCount = expanded ? maxExpanded : maxCollapsed;
		for (const line of outputLines.slice(0, previewCount)) {
			lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
		}

		if (outputLines.length > previewCount) {
			lines.push(
				`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`,
			);
		}

		return lines;
	}

	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);

			// Collapsed: inline format like Args
			if (!expanded) {
				lines.push(`${continuePrefix}${theme.fg("dim", formatOutputInline(parsed, theme))}`);
				return lines;
			}

			// Expanded: tree format
			lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
			const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
			if (tree.lines.length > 0) {
				for (const line of tree.lines) {
					lines.push(`${continuePrefix}  ${line}`);
				}
				if (tree.truncated) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
				}
				return lines;
			}
		} catch {
			// Fall back to raw output
		}
	}

	lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);

	const outputLines = output.trimEnd().split("\n");
	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}

	if (outputLines.length > previewCount) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`);
	}

	return lines;
}

function renderTaskSection(
	task: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxExpanded = 20,
): string[] {
	const lines: string[] = [];
	const trimmed = task.trim();
	if (!expanded || !trimmed) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, maxExpanded)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}
	if (taskLines.length > maxExpanded) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(taskLines.length - maxExpanded, "line"))}`);
	}

	return lines;
}

function formatScalarInline(value: unknown, maxLen: number, _theme: Theme): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const firstLine = value.split("\n")[0].trim();
		if (firstLine.length === 0) return `"" (${value.split("\n").length} lines)`;
		const preview = truncateToWidth(firstLine, maxLen);
		if (value.includes("\n")) return `"${preview}…" (${value.split("\n").length} lines)`;
		return `"${preview}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return String(value);
}

function formatOutputInline(data: unknown, theme: Theme, maxWidth = 80): string {
	if (data === null || data === undefined) return "Output: none";

	// For scalars, show directly
	if (typeof data !== "object") {
		return `Output: ${formatScalarInline(data, 60, theme)}`;
	}

	// For arrays, show count and first element preview
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		const preview = formatScalarInline(data[0], 40, theme);
		return `Output: [${data.length} items] ${preview}${data.length > 1 ? "…" : ""}`;
	}

	// For objects, show key=value pairs inline
	const entries = Object.entries(data as Record<string, unknown>);
	if (entries.length === 0) return "Output: {}";

	const pairs: string[] = [];
	let totalLen = "Output: ".length;

	for (const [key, value] of entries) {
		const valueStr = formatScalarInline(value, 24, theme);
		const pairStr = `${key}=${valueStr}`;
		const addLen = pairs.length > 0 ? pairStr.length + 2 : pairStr.length; // +2 for ", "

		if (totalLen + addLen > maxWidth && pairs.length > 0) {
			pairs.push("…");
			break;
		}

		pairs.push(pairStr);
		totalLen += addLen;
	}

	return `Output: ${pairs.join(", ")}`;
}

/**
 * Render the tool call arguments.
 */
export function renderCall(args: TaskParams, _options: RenderResultOptions, theme: Theme): Component {
	const lines: string[] = [];
	lines.push(renderStatusLine({ icon: "pending", title: "Task", description: args.agent }, theme));

	const contextTemplate = args.context ?? "";
	const context = contextTemplate.trim();
	const hasContext = context.length > 0;
	const branch = theme.fg("dim", theme.tree.branch);
	const last = theme.fg("dim", theme.tree.last);
	const vertical = theme.fg("dim", theme.tree.vertical);
	const showIsolated = "isolated" in args && args.isolated === true;

	if (hasContext) {
		lines.push(` ${branch} ${theme.fg("dim", "Context")}`);
		for (const line of context.split("\n")) {
			const content = line ? theme.fg("muted", replaceTabs(line)) : "";
			lines.push(` ${vertical}  ${content}`);
		}
		const taskPrefix = showIsolated ? branch : last;
		lines.push(
			` ${taskPrefix} ${theme.fg("dim", "Tasks")}: ${theme.fg("muted", `${args.tasks?.length ?? 0} agents`)}`,
		);
		if (showIsolated) {
			lines.push(` ${last} ${theme.fg("dim", "Isolated")}: ${theme.fg("muted", "true")}`);
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	lines.push(`${theme.fg("dim", "Tasks")}: ${theme.fg("muted", `${args.tasks?.length ?? 0} agents`)}`);
	if (showIsolated) {
		lines.push(`${theme.fg("dim", "Isolated")}: ${theme.fg("muted", "true")}`);
	}

	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(
	progress: AgentProgress,
	isLast: boolean,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	/** When true, omit wall-clock-derived displays (current-tool elapsed, retry
	 * countdown) so the output is a pure function of `progress` — required when the
	 * caller caches these lines (the `subagent` await panel). */
	staticTime = false,
): string[] {
	const lines: string[] = [];
	const prefix = isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
	const continuePrefix = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	// Main status line: id: description [status] · stats · ⟨agent⟩
	const description = progress.description?.trim();
	const displayId = formatTaskId(progress.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)}`;

	// Show retry-blocked badge so the parent immediately sees that a child
	// is sleeping on a provider 429, not silently progressing. Wins over the
	// generic running spinner because "we're waiting on a quota window" is
	// the operationally meaningful state.
	if (progress.retryState && progress.status === "running") {
		statusLine += ` ${formatBadge("retrying", "warning", theme)}`;
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		statusLine += ` ${formatBadge("rate-limited", "error", theme)}`;
	} else if (progress.status === "failed" || progress.status === "aborted") {
		const statusLabel = progress.status === "failed" ? "failed" : "aborted";
		statusLine += ` ${formatBadge(statusLabel, iconColor, theme)}`;
	}

	if (progress.status === "running") {
		if (!description) {
			const taskPreview = truncateToWidth(progress.assignment ?? progress.task, 40);
			statusLine += ` ${theme.fg("muted", taskPreview)}`;
		}
		statusLine = appendAgentStats(statusLine, progress, theme);
	} else if (progress.status === "completed") {
		statusLine = appendAgentStats(statusLine, progress, theme);
	}

	lines.push(statusLine);

	lines.push(...renderTaskSection(progress.assignment ?? progress.task, continuePrefix, expanded, theme));
	if (progress.modelSubstitutionWarning) {
		lines.push(
			`${continuePrefix}${theme.fg(
				"warning",
				truncateToWidth(replaceTabs(formatModelSubstitutionWarning(progress.modelSubstitutionWarning)), 90),
			)}`,
		);
	}

	// Current tool (if running) or most recent completed tool
	if (progress.status === "running") {
		if (progress.currentTool) {
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("muted", progress.currentTool)}`;
			const toolDetail = progress.lastIntent ?? progress.currentToolArgs;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(toolDetail), 40))}`;
			}
			if (!staticTime && progress.currentToolStartMs) {
				const elapsed = Date.now() - progress.currentToolStartMs;
				if (elapsed > 5000) {
					toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
				}
			}
			lines.push(toolLine);
		} else if (progress.recentTools.length > 0) {
			// Show most recent completed tool when idle between tools
			const recent = progress.recentTools[0];
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("dim", recent.tool)}`;
			const toolDetail = progress.lastIntent ?? recent.args;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(toolDetail), 40))}`;
			}
			lines.push(toolLine);
		}
	}

	// Retry detail line: surface why the subagent is paused and roughly how
	// long until the next attempt. Without this, the parent UI would just
	// keep spinning while a child sleeps on a 3-hour provider rate-limit.
	if (progress.retryState && progress.status === "running") {
		const attemptLabel = progress.retryState.unbounded
			? `attempt ${progress.retryState.attempt}`
			: `${progress.retryState.attempt}/${progress.retryState.maxAttempts}`;
		// `staticTime` omits the wall-clock countdown so a cached await body stays a
		// pure function of its key (the producer already drops time-only churn).
		let waitLabel = "";
		if (!staticTime) {
			const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - Date.now());
			waitLabel = remainingMs > 0 ? ` in ${formatDuration(remainingMs)}` : " now";
		}
		const summary = `retrying ${attemptLabel}${waitLabel}: ${truncateToWidth(replaceTabs(progress.retryState.errorMessage), 60)}`;
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("warning", summary)}`);
	} else if (progress.retryFailure && progress.status !== "running") {
		const summary = `auto-retry gave up after ${progress.retryFailure.attempt} attempt${
			progress.retryFailure.attempt === 1 ? "" : "s"
		}: ${truncateToWidth(replaceTabs(progress.retryFailure.errorMessage), 80)}`;
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("error", summary)}`);
	}

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		// For completed tasks, check for review verdict from yield tool
		if (progress.status === "completed") {
			const completeData = progress.extractedToolData.yield as Array<{ data: unknown }> | undefined;
			const reportFindingData = normalizeReportFindings(progress.extractedToolData.report_finding);
			const reviewData = completeData
				?.map(c => c.data as SubmitReviewDetails)
				.filter(d => d && typeof d === "object" && "overall_correctness" in d);
			if (reviewData && reviewData.length > 0) {
				const summary = reviewData[reviewData.length - 1];
				const findings = reportFindingData;
				lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
				return lines; // Review result handles its own rendering
			}
		}

		for (const toolName in progress.extractedToolData) {
			const dataArray = progress.extractedToolData[toolName];
			// Handle report_finding with tree formatting
			if (toolName === "report_finding") {
				const findings = normalizeReportFindings(dataArray);
				if (findings.length === 0) continue;
				lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);
				lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
				continue;
			}

			// Nested `task` data has its own dedicated tree renderer below that
			// also merges in the in-flight snapshot — skip the generic inline
			// path so we don't render twice.
			if (toolName === "task") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				const displayCount = expanded ? (dataArray as unknown[]).length : 3;
				const recentData = (dataArray as unknown[]).slice(-displayCount);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if ((dataArray as unknown[]).length > displayCount) {
					lines.push(
						`${continuePrefix}${theme.fg(
							"dim",
							formatMoreItems((dataArray as unknown[]).length - displayCount, "item"),
						)}`,
					);
				}
			}
		}
	}

	// Nested `task` tree: completed sub-calls from `extractedToolData.task` plus
	// the in-flight snapshot (if any). Surfacing this in the live view means
	// the user sees deep-tree progress without waiting for this agent to finish
	// its own turn.
	const completedTaskCalls = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (completedTaskCalls.length > 0 || inflight) {
		const snapshots = inflight ? [...completedTaskCalls, inflight] : completedTaskCalls;
		const nestedLines = renderNestedTaskTree(snapshots, expanded, theme, spinnerFrame, staticTime);
		for (const line of nestedLines) {
			lines.push(`${continuePrefix}${line}`);
		}
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		const output = progress.recentOutput.join("\n");
		lines.push(...renderOutputSection(output, continuePrefix, true, theme, 2, 6));
	}

	return lines;
}

/**
 * Public wrapper to render a single subagent's live `AgentProgress` for the
 * `subagent` await panel. Reuses the internal task-progress renderer so the
 * await panel stays at parity with the inline task panel.
 */
export function renderSubagentLiveProgress(
	progress: AgentProgress,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	staticTime = false,
): string[] {
	return renderAgentProgress(progress, true, expanded, theme, spinnerFrame, staticTime);
}

/**
 * Render review result with combined verdict + findings in tree structure.
 */
function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Verdict line
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const verdictIcon = summary.overall_correctness === "correct" ? theme.status.success : theme.status.error;
	lines.push(
		`${continuePrefix} Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${theme.fg(
			verdictColor,
			verdictIcon,
		)} ${theme.fg("dim", `(${(summary.confidence * 100).toFixed(0)}% confidence)`)}`,
	);

	// Explanation preview (first ~80 chars when collapsed, full when expanded)
	if (summary.explanation) {
		if (expanded) {
			lines.push(`${continuePrefix}${theme.fg("dim", "Summary")}`);
			const explanationLines = summary.explanation.split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}  ${theme.fg("dim", replaceTabs(line))}`);
			}
		} else {
			// Preview: first sentence or ~100 chars (flatten tabs/newlines first)
			const flat = replaceTabs(summary.explanation).replace(/[\r\n]+/g, " ");
			const firstSentence = flat.split(/[.!?]/)[0].trim();
			const preview = truncateToWidth(`${firstSentence}.`, 100);
			lines.push(`${continuePrefix}${theme.fg("dim", preview)}`);
		}
	}

	// Findings summary + list
	lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);

	if (findings.length > 0) {
		lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
	}

	return lines;
}

/**
 * Render review findings list.
 */
function renderFindings(
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Sort by priority (lower = more severe) when collapsed to show most important first
	const sortedFindings = expanded
		? findings
		: [...findings].sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sortedFindings.length : Math.min(3, sortedFindings.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sortedFindings[i];
		const isLastFinding = i === displayCount - 1 && (expanded || sortedFindings.length <= 3);
		const findingPrefix = isLastFinding ? theme.tree.last : theme.tree.branch;
		const findingContinue = isLastFinding ? "   " : `${theme.tree.vertical}  `;

		const { color } = getPriorityInfo(finding.priority);
		const rawTitle = finding.title?.replace(/^\[P\d\]\s*/, "") ?? "Untitled";
		const titleText = replaceTabs(rawTitle).replace(/[\r\n]+/g, " ");
		const loc = `${path.basename(finding.file_path || "<unknown>")}:${finding.line_start}`;

		lines.push(
			`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${finding.priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
		);

		// Show body when expanded
		if (expanded && finding.body) {
			// Wrap body text
			const bodyLines = finding.body.split("\n");
			for (const bodyLine of bodyLines) {
				lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", replaceTabs(bodyLine))}`);
			}
		}
	}

	if (!expanded && findings.length > 3) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - 3, "finding"))}`);
	}

	return lines;
}

/**
 * Render final result for a single agent.
 */
function renderAgentResult(result: TaskResultReceipt, isLast: boolean, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const prefix = isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch);
	const continuePrefix = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

	const success = result.status === "completed";
	const mergeFailed = result.status === "merge_failed";
	const aborted = result.status === "aborted";
	const icon = success
		? theme.status.success
		: aborted
			? theme.status.aborted
			: mergeFailed
				? theme.status.warning
				: theme.status.error;
	const iconColor = success ? "success" : mergeFailed ? "warning" : "error";
	const statusText = mergeFailed ? "merge failed" : success ? "done" : result.status;

	const description = result.description?.trim();
	const displayId = formatTaskId(result.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)} ${formatBadge(
		statusText,
		iconColor,
		theme,
	)}`;
	statusLine = appendAgentStats(
		statusLine,
		{
			tokens: result.tokens,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.cost ?? result.usage?.cost.total ?? 0,
		},
		theme,
	);
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;
	if (result.truncated || result.previewTruncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}
	lines.push(statusLine);

	lines.push(...renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme));

	if (result.review) {
		if (result.review.overallCorrectness) {
			lines.push(`${continuePrefix}${theme.fg("dim", `Review: ${result.review.overallCorrectness}`)}`);
		}
		if (result.review.findingCount > 0) {
			lines.push(`${continuePrefix}${theme.fg("dim", `${result.review.findingCount} findings`)}`);
			if (expanded && result.review.findings) {
				for (const finding of result.review.findings) {
					const severity = finding.severity ? `${finding.severity}: ` : "";
					lines.push(`${continuePrefix}${theme.fg("dim", `- ${severity}${finding.summary}`)}`);
				}
			}
		}
	} else if (!result.modelSubstitutionWarning) {
		lines.push(...renderOutputSection(result.preview, continuePrefix, expanded, theme, 3, 12));
	}
	if (result.modelSubstitutionWarning) {
		lines.push(
			`${continuePrefix}${theme.fg(
				"warning",
				truncateToWidth(replaceTabs(formatModelSubstitutionWarning(result.modelSubstitutionWarning)), 90),
			)}`,
		);
	}
	if (result.roi?.lowRoi) {
		lines.push(`${continuePrefix}${theme.fg("warning", "low ROI: produced no material contribution")}`);
	}

	if (result.outputRef) {
		lines.push(
			`${continuePrefix}${theme.fg(
				"dim",
				`Output: ${result.outputRef.uri} (${formatBytes(result.outputRef.sizeBytes)}, ${result.outputRef.lineCount} lines)`,
			)}`,
		);
	} else if (result.outputUnavailable) {
		lines.push(`${continuePrefix}${theme.fg("dim", "Output artifact unavailable")}`);
	}

	if (result.branchName && success) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Branch: ${result.branchName}`)}`);
	}
	if (result.abortSummary) {
		lines.push(
			`${continuePrefix}${theme.fg("error", theme.status.aborted)} ${theme.fg("dim", truncateToWidth(replaceTabs(result.abortSummary), 80))}`,
		);
	}
	if (result.errorSummary && (!success || mergeFailed)) {
		lines.push(
			`${continuePrefix}${theme.fg(mergeFailed ? "warning" : "error", truncateToWidth(replaceTabs(result.errorSummary), 70))}`,
		);
	}
	return lines;
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;

	if (!details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		return new Text(theme.fg("dim", truncateToWidth(text, 100)), 0, 0);
	}

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const { expanded, isPartial, spinnerFrame } = options;
			const key = new Hasher()
				.bool(expanded)
				.bool(isPartial)
				.u32(spinnerFrame ?? 0)
				.u32(width)
				.digest();
			if (cached?.key === key) return cached.lines;

			const lines: string[] = [];

			const shouldRenderProgress =
				Boolean(details.progress && details.progress.length > 0) && (isPartial || details.results.length === 0);
			if (shouldRenderProgress && details.progress) {
				details.progress.forEach((progress, i) => {
					const isLast = i === details.progress!.length - 1;
					lines.push(...renderAgentProgress(progress, isLast, expanded, theme, spinnerFrame));
				});
			} else if (details.results && details.results.length > 0) {
				details.results.forEach((res, i) => {
					const isLast = i === details.results.length - 1;
					lines.push(...renderAgentResult(res, isLast, expanded, theme));
				});

				const abortedCount = details.results.filter(r => r.status === "aborted").length;
				const mergeFailedCount = details.results.filter(r => r.status === "merge_failed").length;
				const successCount = details.results.filter(r => r.status === "completed").length;
				const failCount = details.results.length - successCount - mergeFailedCount - abortedCount;
				let summary = `${theme.fg("dim", "Total:")} `;
				if (abortedCount > 0) {
					summary += theme.fg("error", `${abortedCount} aborted`);
					if (successCount > 0 || mergeFailedCount > 0 || failCount > 0) summary += theme.sep.dot;
				}
				if (successCount > 0) {
					summary += theme.fg("success", `${successCount} succeeded`);
					if (mergeFailedCount > 0 || failCount > 0) summary += theme.sep.dot;
				}
				if (mergeFailedCount > 0) {
					summary += theme.fg("warning", `${mergeFailedCount} merge failed`);
					if (failCount > 0) summary += theme.sep.dot;
				}
				if (failCount > 0) {
					summary += theme.fg("error", `${failCount} failed`);
				}
				summary += `${theme.sep.dot}${theme.fg("dim", formatDuration(details.totalDurationMs))}`;
				lines.push(summary);
			}

			if (lines.length === 0) {
				const text = fallbackText.trim() ? fallbackText : "No results";
				const result = [theme.fg("dim", truncateToWidth(text, width))];
				cached = { key, lines: result };
				return result;
			}

			if (fallbackText.trim()) {
				const summaryLines = fallbackText.split("\n");
				const markerIndex = summaryLines.findIndex(
					line =>
						line.includes("<system-notification>") ||
						line.startsWith("Applied patches:") ||
						line.startsWith("No changes to apply."),
				);
				if (markerIndex >= 0) {
					const extra = summaryLines.slice(markerIndex);
					for (const line of extra) {
						if (!line.trim()) continue;
						lines.push(theme.fg("dim", line));
					}
				}
			}

			const indented = lines.map(line =>
				line.length > 0 ? truncateToWidth(`   ${line}`, width, Ellipsis.Omit) : "",
			);
			cached = { key, lines: indented };
			return indented;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

function renderNestedTaskResults(detailsList: TaskToolDetails[], expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (!details.results || details.results.length === 0) continue;
		details.results.forEach((result, index) => {
			const isLast = index === details.results.length - 1;
			lines.push(...renderAgentResult(result, isLast, expanded, theme));
		});
	}
	return lines;
}

/**
 * Render a list of `TaskToolDetails` snapshots — completed (`results[]`) or
 * in-flight (`progress[]`) — as an interleaved tree. Used by the live progress
 * view to surface nested subagent activity while this agent is still running.
 */
function renderNestedTaskTree(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	staticTime = false,
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		const hasResults = Boolean(details.results && details.results.length > 0);
		if (hasResults) {
			details.results.forEach((result, index) => {
				const isLast = index === details.results.length - 1;
				lines.push(...renderAgentResult(result, isLast, expanded, theme));
			});
			continue;
		}
		const inflight = details.progress;
		if (inflight && inflight.length > 0) {
			inflight.forEach((prog, index) => {
				const isLast = index === inflight.length - 1;
				lines.push(...renderAgentProgress(prog, isLast, expanded, theme, spinnerFrame, staticTime));
			});
		}
	}
	return lines;
}

subprocessToolRegistry.register<TaskToolDetails>("task", {
	extractData: event => {
		const details = event.result?.details;
		return isTaskToolDetails(details) ? details : undefined;
	},
	renderFinal: (allData, theme, expanded) => {
		const lines = renderNestedTaskResults(allData, expanded, theme);
		return new Text(lines.join("\n"), 0, 0);
	},
});

export const taskToolRenderer = {
	renderCall,
	renderResult,
};
