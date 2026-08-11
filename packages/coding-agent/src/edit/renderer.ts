/**
 * Edit tool renderer and LSP batching helpers.
 */

import type { Component } from "@gajae-code/tui";
import { Text, visibleWidth, wrapTextWithAnsi } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
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
import { expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import type { Operation } from "./modes/patch";
import { getEditRequestTargetInventory, orderedDistinctPaths, type PerFileDiffPreview } from "./streaming";

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

export interface EditRenderArgs {
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
	firstChangedLine?: number;
};

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

function getOperationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

function sanitizeDisplayPath(path: string): string {
	return replaceTabs(sanitizeText(path).replace(/[\r\n]/g, " "));
}

function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): string {
	const displayPath = sanitizeDisplayPath(rawPath);
	let pathDisplay = displayPath
		? fileHyperlink(displayPath, uiTheme.fg("accent", shortenPath(displayPath)))
		: uiTheme.fg("toolOutput", "…");

	if (options?.firstChangedLine) {
		pathDisplay += uiTheme.fg("warning", `:${options.firstChangedLine}`);
	}

	if (options?.rename) {
		const rename = sanitizeDisplayPath(options.rename);
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${fileHyperlink(rename, uiTheme.fg("accent", shortenPath(rename)))}`;
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

function formatMultiFileStreamingDiff(previews: PerFileDiffPreview[], uiTheme: Theme): string {
	const parts: string[] = [];
	for (const preview of previews) {
		if (!preview.diff && !preview.error) continue;
		const header = uiTheme.fg("dim", `\n\n── ${shortenPath(sanitizeDisplayPath(preview.path))} ──`);
		if (preview.error) {
			parts.push(`${header}\n${uiTheme.fg("error", replaceTabs(sanitizeText(preview.error), preview.path))}`);
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

function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
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
		text += uiTheme.fg("toolOutput", `\n… (${remainder.join(", ")}) ${formatExpandHint(uiTheme)}`);
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
		const inventory = getEditRequestTargetInventory(editArgs, renderContext?.editMode, {
			isPartial: options.isPartial,
		});
		const firstEdit = Array.isArray(editArgs.edits) && editArgs.edits.length > 0 ? editArgs.edits[0] : undefined;
		const rawPath = inventory.paths[0] ?? "";
		const rename = editArgs.rename || firstEdit?.rename || firstEdit?.move;
		const op = editArgs.op || firstEdit?.op || inventory.firstOp;
		const { description } = formatEditDescription(rawPath, uiTheme, options.expanded ? { rename } : undefined);
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";
		let text = `${formatTitle(getOperationTitle(op), uiTheme)} ${spinner ? `${spinner} ` : ""}${description}`;
		if (inventory.paths.length > 1) {
			text += uiTheme.fg("dim", ` (+${inventory.paths.length - 1} more)`);
		}
		if (!options.expanded) return new Text(text, 0, 0);

		text += getCallPreview(editArgs, rawPath, uiTheme, renderContext);
		if (inventory.parseError) {
			text += `\n\n${uiTheme.fg("error", truncateToWidth(replaceTabs(sanitizeText(inventory.parseError), rawPath), CALL_TEXT_PREVIEW_WIDTH))}`;
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
		const inventory = getEditRequestTargetInventory(args, options.renderContext?.editMode, {
			isPartial: options.isPartial,
		});
		const representedPaths = orderedDistinctPaths(perFileResults?.map(file => file.path) ?? []);
		if (perFileResults && (perFileResults.length > 1 || inventory.paths.length > 1)) {
			return renderMultiFileResult(
				perFileResults,
				inventory.paths.length,
				representedPaths.length,
				options,
				uiTheme,
				args,
			);
		}
		return renderSingleFileResult(result, options, uiTheme, args);
	},
};

function resolveCompletedEditIdentity(
	details: EditToolDetails | EditToolPerFileResult | undefined,
	args: EditRenderArgs | undefined,
	editMode: EditMode | undefined,
	isPartial: boolean,
): { path: string; op: Operation | undefined; move: string | undefined; firstChangedLine: number | undefined } {
	const firstEdit = args?.edits?.[0];
	const inventory = getEditRequestTargetInventory(args, editMode, { isPartial });
	const detailsPath = details && "path" in details ? details.path : undefined;
	return {
		path: detailsPath ?? args?.file_path ?? args?.path ?? firstEdit?.path ?? inventory.paths[0] ?? "",
		op: details?.op ?? args?.op ?? firstEdit?.op,
		move: details?.move ?? args?.rename ?? firstEdit?.rename ?? firstEdit?.move,
		firstChangedLine: details?.firstChangedLine ?? firstEdit?.firstChangedLine,
	};
}

export function getPerFileEditRenderArgs(
	args: EditRenderArgs | undefined,
	path: string,
	editMode: EditMode | undefined,
): EditRenderArgs | undefined {
	if (!args) return undefined;
	const matchingEdit = args.edits?.find(edit => edit.path === path);
	if (matchingEdit) {
		return {
			...args,
			path: matchingEdit.path,
			op: matchingEdit.op,
			rename: matchingEdit.rename ?? matchingEdit.move,
			edits: [matchingEdit],
		};
	}
	if (args.path === path || args.file_path === path) return args;
	if (editMode === "apply_patch" && typeof args.input === "string") {
		try {
			const entry = expandApplyPatchToPreviewEntries({ input: args.input }).find(
				candidate => candidate.path === path,
			);
			if (entry) return { path: entry.path, op: entry.op, rename: entry.rename, edits: [entry] };
		} catch {
			// Malformed free-form input has no safe per-file request metadata fallback.
		}
	}
	return undefined;
}

export function getPerFileEditRenderContext(
	renderContext: EditRenderContext | undefined,
	path: string,
): EditRenderContext | undefined {
	if (!renderContext) return undefined;
	const matchingPreview = renderContext.perFileDiffPreview?.find(preview => preview.path === path);
	const editDiffPreview = matchingPreview?.error
		? { error: matchingPreview.error }
		: matchingPreview
			? { diff: matchingPreview.diff ?? "", firstChangedLine: matchingPreview.firstChangedLine }
			: undefined;
	return { ...renderContext, editDiffPreview };
}

function hasDiagnostics(
	details: EditToolDetails | EditToolPerFileResult | undefined,
): details is (EditToolDetails | EditToolPerFileResult) & { diagnostics: FileDiagnosticsResult } {
	return details !== undefined && details.diagnostics !== undefined;
}

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
	const displayErrorText = isError && details && "displayErrorText" in details ? details.displayErrorText : undefined;
	const errorText = isError
		? displayErrorText ||
			(details && "errorText" in details && details.errorText) ||
			(result.content?.find(c => c.type === "text")?.text ?? "")
		: "";
	const baseIdentity = resolveCompletedEditIdentity(details, args, options.renderContext?.editMode, options.isPartial);
	let cached: RenderCache | undefined;

	return {
		render(width) {
			const { expanded, renderContext } = options;
			const preview = renderContext?.editDiffPreview;
			const previewLine = preview && "firstChangedLine" in preview ? preview.firstChangedLine : undefined;
			const identity = {
				...baseIdentity,
				firstChangedLine: baseIdentity.firstChangedLine ?? previewLine,
			};
			const { description } = formatEditDescription(identity.path, uiTheme, {
				rename: identity.move,
				firstChangedLine: identity.firstChangedLine,
			});
			const header = renderStatusLine(
				{ icon: isError ? "error" : "success", title: getOperationTitle(identity.op), description },
				uiTheme,
			);
			const key = new Hasher().bool(expanded).u32(width).str(header).digest();
			if (cached?.key === key) return cached.lines;

			let text = header;
			if (!expanded) {
				if (isError) {
					const cause = sanitizeText(errorText)
						.split("\n")
						.map(line => line.trim())
						.find(Boolean);
					if (cause) {
						const availableWidth = Math.max(1, Math.min(80, width > 0 ? width : 80));
						text += `\n${uiTheme.fg("error", truncateToWidth(replaceTabs(cause, identity.path), availableWidth))}`;
					}
				} else if (details?.diff) {
					const stats = getDiffStats(details.diff);
					text += `\n${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${formatDiffStats(
						stats.added,
						stats.removed,
						stats.hunks,
						uiTheme,
					)}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;
				}
				if (hasDiagnostics(details)) text += `\n${uiTheme.fg("dim", "Diagnostics available")}`;
			} else {
				const renderDiffFn = renderContext?.renderDiff ?? ((diff: string) => diff);
				if (isError) {
					if (errorText) text += `\n\n${uiTheme.fg("error", replaceTabs(sanitizeText(errorText), identity.path))}`;
				} else if (details?.diff) {
					text += renderDiffSection(details.diff, identity.path, true, uiTheme, renderDiffFn);
				} else if (preview) {
					if ("error" in preview) {
						text += `\n\n${uiTheme.fg("error", replaceTabs(sanitizeText(preview.error), identity.path))}`;
					} else if (preview.diff) {
						text += renderDiffSection(preview.diff, identity.path, true, uiTheme, renderDiffFn);
					}
				}
				if (hasDiagnostics(details)) {
					text += formatDiagnostics(details.diagnostics, true, uiTheme, (fp: string) =>
						uiTheme.getLangIcon(getLanguageFromPath(fp)),
					);
				}
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
	representedFiles: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args: EditRenderArgs | undefined,
): Component {
	const fileComponents = perFileResults.map(fileResult => {
		const fileOptions: RenderResultOptions & { renderContext?: EditRenderContext } = {
			...options,
			renderContext: getPerFileEditRenderContext(options.renderContext, fileResult.path),
		};
		const fileArgs = getPerFileEditRenderArgs(args, fileResult.path, options.renderContext?.editMode);
		return renderSingleFileResult(
			{ content: [], details: fileResult, isError: fileResult.isError },
			fileOptions,
			uiTheme,
			fileArgs,
		);
	});
	const remaining = options.isPartial ? Math.max(0, totalFiles - representedFiles) : 0;

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
