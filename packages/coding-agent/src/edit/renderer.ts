import { resolveRenderCapability } from "../tools/render-utils";
/**
 * Edit tool renderer and LSP batching helpers.
 */

import type { Component } from "@gajae-code/tui";
import { Text, visibleWidth, wrapTextWithAnsi } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { HL_FILE_PREFIX } from "../hashline/hash";
import type { FileDiagnosticsResult } from "../lsp";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import {
	formatDiagnostics,
	formatDiffStats,
	formatExpandHint,
	formatStatusIcon,
	formatTitle,
	getDiffStats,
	getLspBatchRequest,
	type LspBatchRequest,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	truncateDiffByHunk,
} from "../tools/render-utils";
import { type VimRenderArgs, vimToolRenderer } from "../tools/vim";
import { fileHyperlink, Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import type { EditMode } from "../utils/edit-mode";
import type { VimToolDetails } from "../vim/types";
import type { DiffError, DiffResult } from "./diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import type { Operation } from "./modes/patch";
import type { PerFileDiffPreview } from "./streaming";

// ═══════════════════════════════════════════════════════════════════════════
// LSP Batching
// ═══════════════════════════════════════════════════════════════════════════

export { getLspBatchRequest, type LspBatchRequest };

// ═══════════════════════════════════════════════════════════════════════════
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** TUI-friendly error text. When present, rendered to the user instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
}

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
	/** Absolute file path for single-file edit results. Required by ACP diff metadata consumers. */
	path?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

interface EditRenderArgs {
	path?: string;
	file_path?: string;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	all?: boolean;
	// Patch mode fields
	op?: Operation;
	rename?: string;
	diff?: string;
	/**
	 * Computed preview diff (used when tool args don't include a diff, e.g. hashline mode).
	 */
	previewDiff?: string;
	__partialJson?: string;
	// Hashline mode fields
	edits?: EditRenderEntry[];
}

type EditRenderEntry = {
	path?: string;
	rename?: string;
	move?: string;
	op?: Operation;
};

interface HashlineInputRenderSummary {
	entries: Array<{ path: string }>;
}

interface ApplyPatchRenderSummary {
	entries: ApplyPatchEntry[];
	error?: string;
}

function isVimRenderArgs(args: EditRenderArgs | VimRenderArgs): args is VimRenderArgs {
	return (
		typeof args === "object" &&
		args !== null &&
		typeof (args as { file?: unknown }).file === "string" &&
		!("path" in args) &&
		!("file_path" in args) &&
		!("edits" in args)
	);
}

function isVimToolDetails(details: unknown): details is VimToolDetails {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return false;
	}
	const cursor = (details as { cursor?: unknown }).cursor;
	const viewportLines = (details as { viewportLines?: unknown }).viewportLines;
	return (
		typeof (details as { file?: unknown }).file === "string" &&
		typeof cursor === "object" &&
		cursor !== null &&
		Array.isArray(viewportLines)
	);
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Edit mode resolved by the caller; lets the renderer dispatch without shape-sniffing */
	editMode?: EditMode;
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: DiffResult | DiffError;
	/** Multi-file streaming diff preview (edits spanning several files) */
	perFileDiffPreview?: PerFileDiffPreview[];
	/** Raw in-flight edit text shown while a computed diff preview is unavailable */
	editStreamingFallback?: string;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

const EDIT_STREAMING_PREVIEW_LINES = 12;
const CALL_TEXT_PREVIEW_LINES = 6;
const CALL_TEXT_PREVIEW_WIDTH = 80;

/** Extract file path from an edit entry. */
function filePathFromEditEntry(p: string | undefined): string | undefined {
	return p ?? undefined;
}

function decodePartialJsonStringFragment(fragment: string): string {
	// Trim a trailing partial escape so JSON.parse sees a well-formed string.
	let text = fragment.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		// Streaming fragment isn't a valid JSON string yet; surface it raw rather
		// than ad-hoc unescaping that mishandles surrogates and partial escapes.
		return text;
	}
}

function extractPartialJsonString(partialJson: string | undefined, key: string): string | undefined {
	if (!partialJson) return undefined;
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "u");
	const match = pattern.exec(partialJson);
	if (!match) return undefined;
	return decodePartialJsonStringFragment(match[1]);
}

function getPartialJsonEditPath(args: EditRenderArgs): string | undefined {
	return filePathFromEditEntry(extractPartialJsonString(args.__partialJson, "path"));
}

/** Count distinct file paths in an edits array. */
function countEditFiles(edits: EditRenderEntry[]): number {
	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function getOperationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): string {
	let pathDisplay = rawPath
		? fileHyperlink(rawPath, uiTheme.fg("accent", shortenPath(rawPath)))
		: uiTheme.fg("toolOutput", "…");

	if (options?.firstChangedLine) {
		pathDisplay += uiTheme.fg("warning", `:${options.firstChangedLine}`);
	}

	if (options?.rename) {
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${fileHyperlink(options.rename, uiTheme.fg("accent", shortenPath(options.rename)))}`;
	}

	return pathDisplay;
}

function formatEditDescription(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): { language: string; description: string } {
	const language = getLanguageFromPath(rawPath) ?? "text";
	const icon = uiTheme.fg("muted", uiTheme.getLangIcon(language));
	return {
		language,
		description: `${icon} ${formatEditPathDisplay(rawPath, uiTheme, options)}`,
	};
}

function renderPlainTextPreview(text: string, uiTheme: Theme, filePath?: string): string {
	const previewLines = sanitizeText(text).split("\n");
	let preview = "\n\n";
	for (const line of previewLines.slice(0, CALL_TEXT_PREVIEW_LINES)) {
		preview += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line, filePath), CALL_TEXT_PREVIEW_WIDTH))}\n`;
	}
	if (previewLines.length > CALL_TEXT_PREVIEW_LINES) {
		preview += uiTheme.fg("dim", `… ${previewLines.length - CALL_TEXT_PREVIEW_LINES} more lines`);
	}
	return preview.trimEnd();
}

function formatStreamingDiff(diff: string, rawPath: string, uiTheme: Theme, label = "streaming"): string {
	if (!diff) return "";
	const lines = diff.split("\n");
	const total = lines.length;
	const displayLines = lines.slice(-EDIT_STREAMING_PREVIEW_LINES);
	const hidden = total - displayLines.length;
	let text = "\n\n";
	text += renderDiffColored(displayLines.join("\n"), { filePath: rawPath });
	if (hidden > 0) {
		text += uiTheme.fg("dim", `\n… (${label} +${hidden} lines)`);
	} else {
		text += uiTheme.fg("dim", `\n(${label})`);
	}
	return text;
}

function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

function formatMultiFileStreamingDiff(previews: PerFileDiffPreview[], uiTheme: Theme): string {
	const parts: string[] = [];
	for (const preview of previews) {
		if (!preview.diff && !preview.error) continue;
		const header = uiTheme.fg("dim", `\n\n── ${shortenPath(preview.path)} ──`);
		if (preview.error) {
			parts.push(`${header}\n${uiTheme.fg("error", replaceTabs(preview.error, preview.path))}`);
			continue;
		}
		if (preview.diff) {
			parts.push(`${header}${formatStreamingDiff(preview.diff, preview.path, uiTheme, "preview")}`);
		}
	}
	return parts.join("");
}

function getCallPreview(
	args: EditRenderArgs,
	rawPath: string,
	uiTheme: Theme,
	renderContext: EditRenderContext | undefined,
): string {
	const multi = renderContext?.perFileDiffPreview;
	if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) {
		return formatMultiFileStreamingDiff(multi, uiTheme);
	}
	if (args.previewDiff) {
		return formatStreamingDiff(args.previewDiff, rawPath, uiTheme, "preview");
	}
	if (args.diff && args.op) {
		return formatStreamingDiff(args.diff, rawPath, uiTheme);
	}
	if (args.diff) {
		return renderPlainTextPreview(args.diff, uiTheme, rawPath);
	}
	if (args.newText || args.patch) {
		return renderPlainTextPreview(args.newText ?? args.patch ?? "", uiTheme, rawPath);
	}
	if (renderContext?.editStreamingFallback) {
		return renderContext.editStreamingFallback;
	}
	return "";
}

const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";

function normalizeHashlineInputPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseHashlineInputPreviewHeader(line: string): string | null {
	if (!line.startsWith(HL_FILE_PREFIX)) return null;
	// Mirror hashline/input.ts: strip every leading file marker so canonical
	// `§ PATH` headers and stray `§§ PATH` / `§§§PATH` runs render clean paths.
	let prefixEnd = 0;
	while (prefixEnd < line.length && line[prefixEnd] === HL_FILE_PREFIX) prefixEnd++;
	const body = line.slice(prefixEnd).trim();
	const previewPath = normalizeHashlineInputPreviewPath(body);
	return previewPath.length > 0 ? previewPath : null;
}

function getHashlineInputPaths(input: string): string[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const paths: string[] = [];
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const path = parseHashlineInputPreviewHeader(line);
		if (path) paths.push(path);
	}
	return paths;
}

function getHashlineInputRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): HashlineInputRenderSummary | undefined {
	if (editMode !== "hashline" || typeof args.input !== "string") {
		return undefined;
	}
	return { entries: getHashlineInputPaths(args.input).map(path => ({ path })) };
}

function getApplyPatchRenderSummary(
	args: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): ApplyPatchRenderSummary | undefined {
	if (editMode !== undefined && editMode !== "apply_patch") {
		return undefined;
	}

	if (typeof args.input !== "string") {
		return undefined;
	}

	try {
		return { entries: expandApplyPatchToEntries({ input: args.input }) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (isPartial && error === MISSING_APPLY_PATCH_END_ERROR) {
			return { entries: expandApplyPatchToPreviewEntries({ input: args.input }) };
		}
		return { entries: [], error };
	}
}

function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
	expandHintCapability: import("../tools/render-utils").ExpandHintCapability,
): string {
	let text = "";
	const diffStats = getDiffStats(diff);
	text += `\n${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${formatDiffStats(
		diffStats.added,
		diffStats.removed,
		diffStats.hunks,
		uiTheme,
	)}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;

	const {
		text: truncatedDiff,
		hiddenHunks,
		hiddenLines,
	} = expanded
		? { text: diff, hiddenHunks: 0, hiddenLines: 0 }
		: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

	text += `\n\n${renderDiffFn(truncatedDiff, { filePath: rawPath })}`;
	if (!expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
		const remainder: string[] = [];
		if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
		if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
		text += uiTheme.fg(
			"toolOutput",
			`\n… (${remainder.join(", ")}) ${formatExpandHint(uiTheme, false, true, expandHintCapability)}`,
		);
	}
	return text;
}

function wrapEditRendererLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith("\x1b[39m") ? bodyWithReset.slice(0, -"\x1b[39m".length) : bodyWithReset;
	const diffMatch = /^([+\-\s])(\s*\d+)([|│])(.*)$/s.exec(body);

	if (!diffMatch) {
		return wrapTextWithAnsi(line, width);
	}

	const [, marker, lineNum, separator, content] = diffMatch;
	const prefix = `${marker}${lineNum}${separator}`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}${separator}`;
	const wrappedContent = wrapTextWithAnsi(content ?? "", contentWidth);

	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[39m`,
	);
}

export const editToolRenderer = {
	mergeCallAndResult: true,

	renderCall(
		args: EditRenderArgs | VimRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
	): Component {
		const renderContext = options.renderContext;
		// Dispatch on the explicit editMode when available; fall back to the
		// shape probe for legacy call sites that don't thread renderContext.
		if (renderContext?.editMode === "vim" || isVimRenderArgs(args)) {
			return vimToolRenderer.renderCall(args as VimRenderArgs, options, uiTheme);
		}

		const editArgs = args as EditRenderArgs;
		const hashlineInputSummary = getHashlineInputRenderSummary(editArgs, renderContext?.editMode);
		const applyPatchSummary = getApplyPatchRenderSummary(editArgs, options.isPartial, renderContext?.editMode);
		const firstApplyPatchEntry = applyPatchSummary?.entries[0];
		const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
		// Extract path from first edit entry when top-level path is absent (new schema)
		const firstEdit = Array.isArray(editArgs.edits) && editArgs.edits.length > 0 ? editArgs.edits[0] : undefined;
		const rawPath =
			editArgs.file_path ||
			editArgs.path ||
			filePathFromEditEntry(firstEdit?.path) ||
			getPartialJsonEditPath(editArgs) ||
			firstHashlineInputEntry?.path ||
			firstApplyPatchEntry?.path ||
			"";
		const rename = editArgs.rename || firstEdit?.rename || firstEdit?.move || firstApplyPatchEntry?.rename;
		const op = editArgs.op || firstEdit?.op || firstApplyPatchEntry?.op;
		const { description } = formatEditDescription(rawPath, uiTheme, { rename });
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";
		let text = `${formatTitle(getOperationTitle(op), uiTheme)} ${spinner ? `${spinner} ` : ""}${description}`;
		// Show file count hint for multi-file edits
		let fileCount = hashlineInputSummary?.entries.length ?? applyPatchSummary?.entries.length ?? 0;
		if (Array.isArray(editArgs.edits)) {
			fileCount = countEditFiles(editArgs.edits);
		}
		if (fileCount > 1) {
			text += uiTheme.fg("dim", ` (+${fileCount - 1} more)`);
		}
		text += getCallPreview(editArgs, rawPath, uiTheme, renderContext);
		if (applyPatchSummary?.error) {
			text += `\n\n${uiTheme.fg("error", truncateToWidth(replaceTabs(applyPatchSummary.error, rawPath), CALL_TEXT_PREVIEW_WIDTH))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		if (options.renderContext?.editMode === "vim" || isVimToolDetails(result.details)) {
			return vimToolRenderer.renderResult(
				result as { content: Array<{ type: string; text?: string }>; details?: VimToolDetails; isError?: boolean },
				options,
				uiTheme,
			);
		}

		const perFileResults = result.details?.perFileResults;
		const totalFiles = args?.edits ? countEditFiles(args.edits) : 0;
		if (perFileResults && (perFileResults.length > 1 || totalFiles > 1)) {
			return renderMultiFileResult(perFileResults, totalFiles, options, uiTheme);
		}
		return renderSingleFileResult(result, options, uiTheme, args);
	},
};

function renderSingleFileResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args?: EditRenderArgs,
): Component {
	const details = result.details;
	const isError = result.isError ?? (details && "isError" in details ? details.isError : false);
	const firstEdit = args?.edits?.[0];
	const hashlineInputSummary = getHashlineInputRenderSummary(args ?? {}, options.renderContext?.editMode);
	const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
	const rawPath =
		args?.file_path ||
		args?.path ||
		filePathFromEditEntry(firstEdit?.path) ||
		(details && "path" in details ? details.path : "") ||
		firstHashlineInputEntry?.path ||
		"";
	const op = args?.op || firstEdit?.op || details?.op;
	const rename = args?.rename || firstEdit?.rename || firstEdit?.move || details?.move;
	const { language } = formatEditDescription(rawPath, uiTheme, { rename });

	const editTextSource = args?.newText ?? args?.oldText ?? args?.diff ?? args?.patch;
	const metadataLineCount = editTextSource ? countLines(editTextSource) : null;
	const metadataLine = op !== "delete" ? `\n${formatMetadataLine(metadataLineCount, language, uiTheme)}` : "";

	const displayErrorText = isError && details && "displayErrorText" in details ? details.displayErrorText : undefined;
	const errorText = isError
		? displayErrorText ||
			(details && "errorText" in details && details.errorText) ||
			(result.content?.find(c => c.type === "text")?.text ?? "")
		: "";

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const { expanded, renderContext } = options;
			const editDiffPreview = renderContext?.editDiffPreview;
			const renderDiffFn = renderContext?.renderDiff ?? ((t: string) => t);
			const key = new Hasher().bool(expanded).u32(width).digest();
			if (cached?.key === key) return cached.lines;

			const firstChangedLine =
				(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
				(details && !isError ? details.firstChangedLine : undefined);
			const { description } = formatEditDescription(rawPath, uiTheme, { rename, firstChangedLine });

			const header = renderStatusLine(
				{
					icon: isError ? "error" : "success",
					title: getOperationTitle(op),
					description,
				},
				uiTheme,
			);
			let text = header;
			text += metadataLine;

			if (isError) {
				if (errorText) {
					text += `\n\n${uiTheme.fg("error", replaceTabs(errorText, rawPath))}`;
				}
			} else if (details?.diff) {
				text += renderDiffSection(
					details.diff,
					rawPath,
					expanded,
					uiTheme,
					renderDiffFn,
					resolveRenderCapability(options),
				);
			} else if (editDiffPreview) {
				if ("error" in editDiffPreview) {
					text += `\n\n${uiTheme.fg("error", replaceTabs(editDiffPreview.error, rawPath))}`;
				} else if (editDiffPreview.diff) {
					text += renderDiffSection(
						editDiffPreview.diff,
						rawPath,
						expanded,
						uiTheme,
						renderDiffFn,
						resolveRenderCapability(options),
					);
				}
			}

			if (details?.diagnostics) {
				text += formatDiagnostics(
					details.diagnostics,
					expanded,
					uiTheme,
					(fp: string) => uiTheme.getLangIcon(getLanguageFromPath(fp)),
					resolveRenderCapability(options),
				);
			}

			const lines =
				width > 0 ? text.split("\n").flatMap(line => wrapEditRendererLine(line, width)) : text.split("\n");
			cached = { key, lines };
			return lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

function renderMultiFileResult(
	perFileResults: EditToolPerFileResult[],
	totalFiles: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
): Component {
	const fileComponents = perFileResults.map(fileResult =>
		renderSingleFileResult({ content: [], details: fileResult, isError: fileResult.isError }, options, uiTheme),
	);
	const remaining = Math.max(0, totalFiles - perFileResults.length);

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const key = new Hasher().bool(options.expanded).u32(width).u32(perFileResults.length).u32(remaining).digest();
			if (cached?.key === key) return cached.lines;

			const allLines: string[] = [];
			for (let i = 0; i < fileComponents.length; i++) {
				if (i > 0) {
					allLines.push("");
				}
				allLines.push(...fileComponents[i].render(width));
			}

			// Show pending indicator for files still being processed
			if (remaining > 0) {
				if (allLines.length > 0) allLines.push("");
				const spinnerFrame = options.spinnerFrame;
				const spinner = spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, spinnerFrame) : "";
				allLines.push(
					renderStatusLine(
						{
							icon: "pending",
							title: "Edit",
							description: uiTheme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						uiTheme,
					),
				);
				if (spinner) {
					// Replace the pending icon with spinner on the last line
					allLines[allLines.length - 1] = allLines[allLines.length - 1].replace(/^(?:\x1b\[[^m]*m)*./u, spinner);
				}
			}

			cached = { key, lines: allLines };
			return allLines;
		},
		invalidate() {
			cached = undefined;
			for (const c of fileComponents) c.invalidate();
		},
	};
}
