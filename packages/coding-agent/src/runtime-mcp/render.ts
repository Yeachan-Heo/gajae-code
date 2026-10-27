/**
 * TUI rendering for MCP tools.
 *
 * Provides structured display of MCP tool calls and results,
 * showing args and output in JSON tree format similar to task tool.
 */
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../tools/json-tree";
import { formatExpandHint, truncateToWidth } from "../tools/render-utils";
import { renderStatusLine } from "../tui";
import type { MCPToolDetails } from "./tool-bridge";

const UNTRUSTED_CONTENT_OPEN_LINE = "<untrusted-content>\n";
const UNTRUSTED_CONTENT_CLOSE_LINE = "\n</untrusted-content>";

/** Drop only the outer marker added for the model. The body stays escaped. */
function unwrapMarkedToolText(text: string): string {
	if (
		text.startsWith(UNTRUSTED_CONTENT_OPEN_LINE) &&
		text.endsWith(UNTRUSTED_CONTENT_CLOSE_LINE) &&
		text.length >= UNTRUSTED_CONTENT_OPEN_LINE.length + UNTRUSTED_CONTENT_CLOSE_LINE.length
	) {
		return text.slice(UNTRUSTED_CONTENT_OPEN_LINE.length, text.length - UNTRUSTED_CONTENT_CLOSE_LINE.length);
	}
	return text;
}

/**
 * Render MCP tool call.
 */
export function renderMCPCall(args: Record<string, unknown>, theme: Theme, label: string): Component {
	const lines: string[] = [];
	lines.push(renderStatusLine({ icon: "pending", title: label }, theme));

	if (args && typeof args === "object" && Object.keys(args).length > 0) {
		// Show args inline preview
		const preview = formatArgsInline(args, 70);
		if (preview) {
			lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
		}
	}

	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Render MCP tool result.
 */
export function renderMCPResult(
	result: { content: Array<{ type: string; text?: string }>; details?: MCPToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const { expanded } = options;
	const lines: string[] = [];

	// Args section (when expanded)
	if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
		lines.push(`${theme.fg("dim", "Args")}`);
		const maxDepth = JSON_TREE_MAX_DEPTH_EXPANDED;
		const maxLines = JSON_TREE_MAX_LINES_EXPANDED;
		const tree = renderJsonTreeLines(args, theme, maxDepth, maxLines, JSON_TREE_SCALAR_LEN_EXPANDED);
		for (const line of tree.lines) {
			lines.push(line);
		}
		if (tree.truncated) {
			lines.push(theme.fg("dim", "…"));
		}
		lines.push(""); // Blank line before output
	}

	// Output section
	const textContent = unwrapMarkedToolText(result.content?.find(c => c.type === "text")?.text ?? "");
	const trimmedOutput = textContent.trimEnd();

	if (!trimmedOutput) {
		lines.push(theme.fg("dim", "(no output)"));
		return new Text(lines.join("\n"), 0, 0);
	}

	// Try to parse as JSON for structured display
	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);
			const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
			const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
			const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
			const tree = renderJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);

			if (tree.lines.length > 0) {
				for (const line of tree.lines) {
					lines.push(line);
				}
				// Always show expand hint when collapsed (expanded view shows longer values and deeper nesting)
				if (!expanded) {
					lines.push(formatExpandHint(theme, expanded, true));
				} else if (tree.truncated) {
					lines.push(theme.fg("dim", "…"));
				}
				return new Text(lines.join("\n"), 0, 0);
			}
		} catch {
			// Fall through to raw output
		}
	}

	// Raw text output
	const outputLines = trimmedOutput.split("\n");
	const maxOutputLines = expanded ? 12 : 4;
	const displayLines = outputLines.slice(0, maxOutputLines);

	for (const line of displayLines) {
		lines.push(theme.fg("toolOutput", truncateToWidth(line, 80)));
	}

	if (outputLines.length > maxOutputLines) {
		const remaining = outputLines.length - maxOutputLines;
		lines.push(`${theme.fg("dim", `… ${remaining} more lines`)} ${formatExpandHint(theme, expanded, true)}`);
	} else if (!expanded) {
		// Show expand hint when collapsed even if all lines shown (lines may be truncated)
		lines.push(formatExpandHint(theme, expanded, true));
	}

	return new Text(lines.join("\n"), 0, 0);
}
