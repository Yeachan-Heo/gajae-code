/**
 * Exa TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for Exa search results.
 */
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { logger } from "@gajae-code/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import {
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getDomain,
	getPreviewLines,
	PREVIEW_LIMITS,
	resolveRenderCapability,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../tools/render-utils";
import type { ExaRenderDetails } from "./types";

const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.COLLAPSED_LINES;
const COLLAPSED_PREVIEW_LINE_LEN = TRUNCATE_LENGTHS.LONG;
const EXPANDED_TEXT_LINES = 5;
const EXPANDED_TEXT_LINE_LEN = 90;
const MAX_TITLE_LEN = TRUNCATE_LENGTHS.TITLE;
const MAX_HIGHLIGHT_LEN = TRUNCATE_LENGTHS.CONTENT;

function renderErrorMessage(message: string, theme: Theme): Text {
	const clean = message.replace(/^Error:\s*/, "").trim();
	return new Text(
		`${formatStatusIcon("error", theme)} ${theme.fg("error", `Error: ${clean || "Unknown error"}`)}`,
		0,
		0,
	);
}

function renderEmptyMessage(message: string, theme: Theme): Text {
	return new Text(`${formatStatusIcon("warning", theme)} ${theme.fg("muted", message)}`, 0, 0);
}

/** Render Exa result with tree-based layout */
export function renderExaResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ExaRenderDetails },
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const { expanded } = options;
	const details = result.details;

	if (details?.error) {
		logger.error("Exa render error", { error: details.error, toolName: details.toolName });
		return renderErrorMessage(details.error, uiTheme);
	}

	const response = details?.response;
	if (!response) {
		if (details?.raw) {
			const rawText = typeof details.raw === "string" ? details.raw : JSON.stringify(details.raw, null, 2);
			const rawLines = rawText.split("\n").filter(l => l.trim());
			const maxLines = expanded ? rawLines.length : Math.min(rawLines.length, COLLAPSED_PREVIEW_LINES);
			const displayLines = rawLines.slice(0, maxLines);
			const remaining = rawLines.length - maxLines;
			const expandHint = formatExpandHint(uiTheme, expanded, remaining > 0, resolveRenderCapability(options));

			let text = `${formatStatusIcon("info", uiTheme)} ${uiTheme.fg("dim", "Raw response")}${expandHint}`;

			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg(
					"toolOutput",
					truncateToWidth(displayLines[i], COLLAPSED_PREVIEW_LINE_LEN),
				)}`;
			}

			if (remaining > 0) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg(
					"muted",
					formatMoreItems(remaining, "line"),
				)}`;
			}

			return new Text(text, 0, 0);
		}
		return renderEmptyMessage("No response data", uiTheme);
	}

	const results = response.results ?? [];
	const resultCount = results.length;
	const cost = response.costDollars?.total;
	const time = response.searchTime;

	const icon = formatStatusIcon(resultCount > 0 ? "success" : "warning", uiTheme);

	const metaParts = [formatCount("result", resultCount)];
	if (cost !== undefined) metaParts.push(`cost:$${cost.toFixed(4)}`);
	if (time !== undefined) metaParts.push(`time:${time.toFixed(2)}s`);
	const summaryText = metaParts.join(uiTheme.sep.dot);

	let hasMorePreview = false;
	if (!expanded && resultCount > 0) {
		const previewText = results[0].text ?? results[0].title ?? "";
		const totalLines = previewText.split("\n").filter(l => l.trim()).length;
		hasMorePreview = totalLines > COLLAPSED_PREVIEW_LINES || resultCount > 1;
	}
	const expandHint = formatExpandHint(uiTheme, expanded, hasMorePreview, resolveRenderCapability(options));

	let text = `${icon} ${uiTheme.fg("dim", summaryText)}${expandHint}`;

	if (!expanded) {
		if (resultCount === 0) {
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", "No results")}`;
			return new Text(text, 0, 0);
		}

		const first = results[0];
		const previewText = first.text ?? first.title ?? "";
		const previewLines = previewText
			? getPreviewLines(previewText, COLLAPSED_PREVIEW_LINES, COLLAPSED_PREVIEW_LINE_LEN)
			: [];
		const safePreviewLines = previewLines.length > 0 ? previewLines : ["No preview text"];
		const totalLines = previewText.split("\n").filter(l => l.trim()).length;
		const remainingLines = Math.max(0, totalLines - previewLines.length);
		const extraItems: string[] = [];
		if (remainingLines > 0) {
			extraItems.push(formatMoreItems(remainingLines, "line"));
		}
		if (resultCount > 1) {
			extraItems.push(formatMoreItems(resultCount - 1, "result"));
		}

		for (let i = 0; i < safePreviewLines.length; i++) {
			const isLast = i === safePreviewLines.length - 1 && extraItems.length === 0;
			const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
			const line = safePreviewLines[i];
			const color = line === "No preview text" ? "muted" : "toolOutput";
			text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg(color, line)}`;
		}

		for (let i = 0; i < extraItems.length; i++) {
			const isLast = i === extraItems.length - 1;
			const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
			text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("muted", extraItems[i])}`;
		}

		return new Text(text, 0, 0);
	}

	if (resultCount === 0) {
		text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", "No results")}`;
		return new Text(text, 0, 0);
	}

	for (let i = 0; i < results.length; i++) {
		const res = results[i];
		const isLast = i === results.length - 1;
		const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
		const cont = isLast ? " " : uiTheme.tree.vertical;

		const title = truncateToWidth(res.title ?? "Untitled", MAX_TITLE_LEN);
		const domain = res.url ? getDomain(res.url) : "";
		const domainPart = domain ? uiTheme.fg("dim", ` (${domain})`) : "";

		text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("accent", title)}${domainPart}`;

		if (res.url) {
			text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
				"mdLinkUrl",
				res.url,
			)}`;
		}

		if (res.author) {
			text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
				"muted",
				`Author: ${res.author}`,
			)}`;
		}

		if (res.publishedDate) {
			text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
				"muted",
				`Published: ${res.publishedDate}`,
			)}`;
		}

		if (res.text) {
			const textLines = res.text.split("\n").filter(l => l.trim());
			const displayLines = textLines.slice(0, EXPANDED_TEXT_LINES);
			for (const line of displayLines) {
				text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
					"toolOutput",
					truncateToWidth(line.trim(), EXPANDED_TEXT_LINE_LEN),
				)}`;
			}
			if (textLines.length > EXPANDED_TEXT_LINES) {
				text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
					"muted",
					formatMoreItems(textLines.length - EXPANDED_TEXT_LINES, "line"),
				)}`;
			}
		}

		if (res.highlights?.length) {
			text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
				"accent",
				"Highlights",
			)}`;
			const maxHighlights = Math.min(res.highlights.length, 3);
			for (let j = 0; j < maxHighlights; j++) {
				const h = res.highlights[j];
				text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
					"muted",
					`${uiTheme.format.dash} ${truncateToWidth(h, MAX_HIGHLIGHT_LEN)}`,
				)}`;
			}
			if (res.highlights.length > maxHighlights) {
				text += `\n ${uiTheme.fg("dim", cont)} ${uiTheme.fg("dim", uiTheme.tree.hook)} ${uiTheme.fg(
					"muted",
					formatMoreItems(res.highlights.length - maxHighlights, "highlight"),
				)}`;
			}
		}
	}

	return new Text(text, 0, 0);
}

/** Render Exa call (query/args preview) */
export function renderExaCall(args: Record<string, unknown>, toolName: string, uiTheme: Theme): Component {
	const toolLabel = toolName || "Exa Search";
	const query = typeof args.query === "string" ? truncateToWidth(args.query, 80) : "?";
	const numResults = typeof args.num_results === "number" ? args.num_results : undefined;

	let text = `${uiTheme.fg("toolTitle", toolLabel)} ${uiTheme.fg("accent", query)}`;
	if (numResults !== undefined) {
		text += ` ${uiTheme.fg("muted", `results:${numResults}`)}`;
	}

	return new Text(text, 0, 0);
}
