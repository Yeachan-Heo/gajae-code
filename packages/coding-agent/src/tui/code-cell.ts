/**
 * Render a code or markdown cell with optional output section.
 */
import { Markdown } from "@gajae-code/tui";
import { getMarkdownTheme, highlightCode, type Theme } from "../modes/theme/theme";
import type { ExpandHintCapability } from "../tools/render-utils";
import {
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	noExpandHintCapability,
	replaceTabs,
} from "../tools/render-utils";
import { renderOutputBlock } from "./output-block";
import type { State } from "./types";

export interface CodeCellOptions {
	code: string;
	language?: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	codeMaxLines?: number;
	expanded?: boolean;
	expandHintCapability?: ExpandHintCapability;
	width: number;
}

function getState(status?: CodeCellOptions["status"]): State | undefined {
	if (!status) return undefined;
	if (status === "complete") return "success";
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	if (status === "running") return "running";
	return "pending";
}

function formatHeader(options: CodeCellOptions, theme: Theme): { title: string; meta?: string } {
	const { index, total, title, status, spinnerFrame, duration } = options;
	const parts: string[] = [];
	if (status) {
		const icon = formatStatusIcon(
			status === "complete"
				? "success"
				: status === "error"
					? "error"
					: status === "warning"
						? "warning"
						: status === "running"
							? "running"
							: "pending",
			theme,
			spinnerFrame,
		);
		if (status === "pending" || status === "running") {
			parts.push(`${icon} ${theme.fg("muted", status)}`);
		} else {
			parts.push(icon);
		}
	}
	if (index !== undefined && total !== undefined) {
		parts.push(theme.fg("accent", `[${index + 1}/${total}]`));
	}
	if (title) {
		parts.push(theme.fg("toolTitle", title));
	}
	const headerTitle = parts.length > 0 ? parts.join(" ") : theme.fg("toolTitle", "Code");

	const metaParts: string[] = [];
	if (duration !== undefined) {
		metaParts.push(theme.fg("dim", `(${formatDuration(duration)})`));
	}
	if (metaParts.length === 0) return { title: headerTitle };
	return { title: headerTitle, meta: metaParts.join(theme.fg("dim", theme.sep.dot)) };
}

/**
 * Normalize terminal control characters that would otherwise corrupt TUI rendering:
 * - Collapse `\r\n` to `\n`.
 * - Within a line, treat `\r` as a cursor-return overwrite by keeping only the
 *   final segment (mirrors how rsync/curl/pip progress bars render to a terminal).
 * Splits on `\n` and returns the cleaned lines.
 */
function sanitizeTerminalLines(text: string): string[] {
	return text.split(/\r?\n/).map(collapseCarriageReturns);
}

function collapseCarriageReturns(line: string): string {
	const idx = line.lastIndexOf("\r");
	return idx < 0 ? line : line.slice(idx + 1);
}
export function renderCodeCell(options: CodeCellOptions, theme: Theme): string[] {
	const { code, language, output, expanded = false, outputMaxLines = 6, codeMaxLines = 12, width } = options;
	const { title, meta } = formatHeader(options, theme);
	const state = getState(options.status);

	const normalizedCode = replaceTabs(code ?? "");
	const rawCodeLines = sanitizeTerminalLines(normalizedCode);
	const maxCodeLines = expanded ? rawCodeLines.length : Math.min(rawCodeLines.length, codeMaxLines);
	const visibleCode = rawCodeLines.slice(0, maxCodeLines).join("\n");
	const codeLines = highlightCode(visibleCode, language);
	const hiddenCodeLines = rawCodeLines.length - maxCodeLines;
	if (hiddenCodeLines > 0) {
		const hint = formatExpandHint(
			theme,
			expanded,
			hiddenCodeLines > 0,
			options.expandHintCapability ?? noExpandHintCapability,
		);
		const moreLine = `${formatMoreItems(hiddenCodeLines, "line")}${hint ? ` ${hint}` : ""}`;
		codeLines.push(theme.fg("dim", moreLine));
	}

	const outputLines: string[] = [];
	if (output?.trim()) {
		const rawLines = sanitizeTerminalLines(output);
		const maxLines = expanded ? rawLines.length : Math.min(rawLines.length, outputMaxLines);
		const displayLines = rawLines
			.slice(0, maxLines)
			.map(line => (line.includes("\x1b[") ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))));
		outputLines.push(...displayLines);
		const remaining = rawLines.length - maxLines;
		if (remaining > 0) {
			const hint = formatExpandHint(
				theme,
				expanded,
				remaining > 0,
				options.expandHintCapability ?? noExpandHintCapability,
			);
			const moreLine = `${formatMoreItems(remaining, "line")}${hint ? ` ${hint}` : ""}`;
			outputLines.push(theme.fg("dim", moreLine));
		}
	}

	const sections: Array<{ label?: string; lines: string[] }> = [{ lines: codeLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}

export interface MarkdownCellOptions {
	content: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	contentMaxLines?: number;
	expanded?: boolean;
	expandHintCapability?: ExpandHintCapability;
	width: number;
}

export function renderMarkdownCell(options: MarkdownCellOptions, theme: Theme): string[] {
	const { content, output, expanded = false, outputMaxLines = 6, contentMaxLines = 12, width } = options;
	const codeOptions: CodeCellOptions = {
		code: "",
		index: options.index,
		total: options.total,
		title: options.title,
		status: options.status,
		spinnerFrame: options.spinnerFrame,
		duration: options.duration,
		width,
	};
	const { title, meta } = formatHeader(codeOptions, theme);
	const state = getState(options.status);

	// Markdown component manages its own wrapping at the inner content width.
	// `renderOutputBlock` adds a `│ ` prefix + `│` suffix → 3 visible columns.
	const innerWidth = Math.max(20, width - 3);
	const allLines = content.trim() ? new Markdown(content, 0, 0, getMarkdownTheme()).render(innerWidth) : [];
	const maxContentLines = expanded ? allLines.length : Math.min(allLines.length, contentMaxLines);
	const contentLines = allLines.slice(0, maxContentLines);
	const hiddenContentLines = allLines.length - maxContentLines;
	if (hiddenContentLines > 0) {
		const hint = formatExpandHint(
			theme,
			expanded,
			hiddenContentLines > 0,
			options.expandHintCapability ?? noExpandHintCapability,
		);
		const moreLine = `${formatMoreItems(hiddenContentLines, "line")}${hint ? ` ${hint}` : ""}`;
		contentLines.push(theme.fg("dim", moreLine));
	}

	const outputLines: string[] = [];
	if (output?.trim()) {
		const rawLines = sanitizeTerminalLines(output);
		const maxLines = expanded ? rawLines.length : Math.min(rawLines.length, outputMaxLines);
		const displayLines = rawLines
			.slice(0, maxLines)
			.map(line => (line.includes("\x1b[") ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))));
		outputLines.push(...displayLines);
		const remaining = rawLines.length - maxLines;
		if (remaining > 0) {
			const hint = formatExpandHint(
				theme,
				expanded,
				remaining > 0,
				options.expandHintCapability ?? noExpandHintCapability,
			);
			const moreLine = `${formatMoreItems(remaining, "line")}${hint ? ` ${hint}` : ""}`;
			outputLines.push(theme.fg("dim", moreLine));
		}
	}

	const sections: Array<{ label?: string; lines: string[] }> = [{ lines: contentLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}
