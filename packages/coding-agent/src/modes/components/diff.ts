import { getIndentation, sanitizeText } from "@gajae-code/utils";
import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../../modes/theme/theme";
import { type CodeFrameMarker, formatCodeFrameLine, replaceTabs } from "../../tools/render-utils";

/** SGR dim on / normal intensity — additive, preserves fg/bg colors. */
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

/**
 * Visualize leading whitespace (indentation) with dim glyphs.
 * Tabs become ` → ` and spaces become `·`. Only affects whitespace
 * before the first non-whitespace character; remaining tabs in code
 * content are replaced with spaces (like replaceTabs).
 */
function visualizeIndent(text: string, filePath?: string): string {
	const match = text.match(/^([ \t]+)/);
	if (!match) return replaceTabs(text, filePath);
	const indent = match[1];
	const rest = text.slice(indent.length);
	const tabWidth = getIndentation(filePath);
	const leftPadding = Math.floor(tabWidth / 2);
	const rightPadding = Math.max(0, tabWidth - leftPadding - 1);
	const tabMarker = `${DIM}${" ".repeat(leftPadding)}→${" ".repeat(rightPadding)}${DIM_OFF}`;
	let visible = "";
	for (const ch of indent) {
		if (ch === "\t") {
			visible += tabMarker;
		} else {
			visible += `${DIM}·${DIM_OFF}`;
		}
	}
	return `${visible}${replaceTabs(rest, filePath)}`;
}

/**
 * Parse diff line to extract prefix, line number, and content.
 * Supported formats: "+123|content" (canonical) and "+123 content" (legacy).
 */
function parseDiffLine(line: string): { prefix: CodeFrameMarker; lineNum: string; content: string } | null {
	const canonical = line.match(/^([+-\s])(\s*\d+)\|(.*)$/);
	if (canonical) {
		return { prefix: canonical[1] as CodeFrameMarker, lineNum: canonical[2] ?? "", content: canonical[3] ?? "" };
	}
	const legacy = line.match(/^([+-\s])(?:(\s*\d+)\s)?(.*)$/);
	if (!legacy) return null;
	return { prefix: legacy[1] as CodeFrameMarker, lineNum: legacy[2] ?? "", content: legacy[3] ?? "" };
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path used to resolve indentation (.editorconfig + defaults) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const lines = sanitizeText(diffText).split("\n");
	const result: string[] = [];
	const parsedLines = lines.map(parseDiffLine);
	const lineNumberWidth = parsedLines.reduce((width, parsed) => {
		const lineNumber = parsed?.lineNum.trim() ?? "";
		return Math.max(width, lineNumber.length);
	}, 0);

	// Batch-highlight context (unedited) lines so consecutive lines tokenize
	// with full multi-line context. Highlighting is a no-op when no language
	// can be detected from the file path.
	const contextHighlights = highlightContextLines(parsedLines, options.filePath);
	// Track the line number rendered on the previous emitted line so we can
	// blank out duplicate gutters. Two cases trigger this:
	//  1. Single-line replacement (`-N` followed by `+N`) — the `+N` repeats `N`.
	//  2. Insertion followed by context (`+N` then ` N` if producer used oldLine).
	let prevLineNum = "";

	const formatLine = (prefix: CodeFrameMarker, lineNum: string, content: string): string => {
		if (lineNum.trim().length === 0) {
			prevLineNum = "";
			return `${prefix}${content}`;
		}
		const trimmed = lineNum.trim();
		const displayNum = trimmed === prevLineNum ? "" : trimmed;
		prevLineNum = trimmed;
		return formatCodeFrameLine(prefix, displayNum, content, lineNumberWidth);
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			prevLineNum = "";
			result.push(theme.fg("toolDiffContext", replaceTabs(line, options.filePath)));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(
					theme.fg(
						"toolDiffRemoved",
						formatLine("-", removed.lineNum, visualizeIndent(removedLine, options.filePath)),
					),
				);
				result.push(
					theme.fg("toolDiffAdded", formatLine("+", added.lineNum, visualizeIndent(addedLine, options.filePath))),
				);
			} else {
				for (const removed of removedLines) {
					result.push(
						theme.fg(
							"toolDiffRemoved",
							formatLine("-", removed.lineNum, visualizeIndent(removed.content, options.filePath)),
						),
					);
				}
				for (const added of addedLines) {
					result.push(
						theme.fg(
							"toolDiffAdded",
							formatLine("+", added.lineNum, visualizeIndent(added.content, options.filePath)),
						),
					);
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(
				theme.fg(
					"toolDiffAdded",
					formatLine("+", parsed.lineNum, visualizeIndent(parsed.content, options.filePath)),
				),
			);
			i++;
		} else {
			const highlighted = contextHighlights.get(i);
			const content =
				highlighted !== undefined
					? replaceTabs(highlighted, options.filePath)
					: visualizeIndent(parsed.content, options.filePath);
			result.push(theme.fg("toolDiffContext", formatLine(" ", parsed.lineNum, content)));
			i++;
		}
	}

	return result.join("\n");
}

/**
 * Batch-highlight runs of consecutive context lines.
 * Returns a map keyed by index in `parsedLines` to the highlighted content
 * for that line. Lines whose language is unknown are not added to the map,
 * letting callers fall back to the existing rendering path.
 */
function highlightContextLines(
	parsedLines: Array<{ prefix: CodeFrameMarker; lineNum: string; content: string } | null>,
	filePath: string | undefined,
): Map<number, string> {
	const map = new Map<number, string>();
	const lang = filePath ? getLanguageFromPath(filePath) : undefined;
	if (!lang) return map;

	let runIndices: number[] = [];
	let runContents: string[] = [];
	const flush = () => {
		if (runContents.length === 0) return;
		const highlighted = highlightCode(runContents.join("\n"), lang);
		for (let k = 0; k < runIndices.length; k++) {
			map.set(runIndices[k], highlighted[k] ?? runContents[k]);
		}
		runIndices = [];
		runContents = [];
	};

	for (let j = 0; j < parsedLines.length; j++) {
		const p = parsedLines[j];
		// Collapse markers ("...") are emitted as context lines but are not real
		// code; highlighting them produces nonsense (e.g. "..." → spread operator)
		// and would also stitch together unrelated context blocks across the gap.
		const isCollapseMarker = p?.prefix === " " && (p.content === "..." || p.content === "…");
		if (p && p.prefix === " " && !isCollapseMarker) {
			runIndices.push(j);
			runContents.push(p.content);
		} else {
			flush();
		}
	}
	flush();
	return map;
}
