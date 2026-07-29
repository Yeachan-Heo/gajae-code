/**
 * Structured metadata for tool outputs.
 *
 * Tools populate details.meta using the fluent OutputMetaBuilder.
 * The tool wrapper automatically formats and appends notices at message boundary.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolExecFn,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@gajae-code/agent-core";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import { getDefault, type Settings } from "../config/settings";
import { formatGroupedDiagnosticMessages } from "../lsp/utils";
import type { Theme } from "../modes/theme/theme";
import { sessionArtifactCapability } from "../session/session-manager";
import {
	formatMiddleElisionMarker,
	type OutputSummary,
	type ReadWindow,
	type TruncationResult,
	truncateMiddle,
	truncateTail,
} from "../session/streaming-output";

import { formatBytes, wrapBrackets } from "./render-utils";
import { renderError } from "./tool-errors";

/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	/** Coordinate basis for shown/head/tail ranges. Omitted means file coordinates; "window" is the selected-range coordinate system. */
	rangeBase?: "file" | "window";
	noticeOwner?: "body";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	/** Line range shown (1-indexed, inclusive). Omitted for middle elision. */
	shownRange?: { start: number; end: number };
	/** Head/tail line ranges shown when direction === "middle". */
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	/** Partial source-line preview retained by a directional window. */
	partialLine?: { line: number; bytes: number; sourceBytes: number };
	/** Bytes elided from the middle. */
	elidedBytes?: number;
	/** Lines elided from the middle. */
	elidedLines?: number;
	/** Artifact ID when output was persisted; completeness is tracked separately below. */
	artifactId?: string;
	/** Bytes omitted from an artifact after its hard storage cap was reached. */
	artifactTruncatedBytes?: number;
	/** Bounded diagnostic when artifact writer creation, write, or finalization failed. */
	artifactFailureDiagnostic?: string;
	/** Next offset for pagination (head truncation only) */
	nextOffset?: number;
}

/**
 * Source resolution info for the output.
 */
export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string };

/**
 * LSP diagnostic info (for edit/write tools).
 */
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

/**
 * Limit-specific notices.
 */
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	columnTruncated?: { maxColumn: number };
}

/**
 * Structured metadata for tool outputs.
 */
export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: SourceMeta;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}

// =============================================================================
// OutputMetaBuilder - Fluent API for building OutputMeta
// =============================================================================

export interface TruncationOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
	artifactId?: string;
	maxBytes?: number;
	noticeOwner?: "body";
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
	noticeOwner?: "body";
}

export interface TruncationTextOptions {
	direction: "head" | "tail" | "middle";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
	artifactId?: string;
	noticeOwner?: "body";
}

/**
 * Fluent builder for OutputMeta.
 *
 * @example
 * ```ts
 * details.meta = outputMeta()
 *   .truncation(truncation, { direction: "head" })
 *   .matchLimit(limitReached ? effectiveLimit : 0)
 *   .columnTruncated(linesTruncated ? DEFAULT_MAX_COLUMN : 0)
 *   .get();
 * ```
 */
export class OutputMetaBuilder {
	#meta: OutputMeta = {};

	/** Add truncation info from TruncationResult. No-op if not truncated. */
	truncation(result: TruncationResult, options: TruncationOptions): this {
		if (!result.truncated) return this;

		const { direction, startLine = 1, totalFileLines, artifactId, noticeOwner, maxBytes } = options;
		const outputLines = result.outputLines ?? result.totalLines;
		const outputBytes = result.outputBytes ?? result.totalBytes;
		const isMiddle = direction === "middle" || result.truncatedBy === "middle";
		const truncatedBy: "lines" | "bytes" | "middle" = isMiddle
			? "middle"
			: result.truncatedBy === "lines"
				? "lines"
				: "bytes";

		const effectiveTotalLines = totalFileLines ?? result.totalLines;
		const owner = noticeOwner !== undefined ? { noticeOwner } : {};

		if (isMiddle) {
			const elidedLines = result.elidedLines ?? Math.max(0, effectiveTotalLines - outputLines);
			const elidedBytes = result.elidedBytes ?? Math.max(0, result.totalBytes - outputBytes);
			// Reconstruct head/tail line ranges. The kept output spans the first
			// `headLines` lines and the last `tailLines` lines of the source; lines
			// in the middle (count == elidedLines) are dropped.
			const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				...owner,
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
				...(maxBytes !== undefined ? { maxBytes } : {}),
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange:
					tailLines > 0 ? { start: effectiveTotalLines - tailLines + 1, end: effectiveTotalLines } : undefined,
				elidedLines,
				elidedBytes,
				artifactId,
			};
			return this;
		}

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = result.totalLines - outputLines + 1;
			shownEnd = result.totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			...owner,
			totalLines: effectiveTotalLines,
			totalBytes: result.totalBytes,
			outputLines,
			outputBytes,
			...(maxBytes !== undefined ? { maxBytes } : {}),
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add metadata from the actual head/tail windows retained by middle truncation. */
	truncationWindows(
		windows: ReadWindow,
		options: {
			artifactId?: string;
			noticeOwner?: "body";
			maxBytes?: number;
			rangeBase?: "file" | "window";
		} = {},
	): this {
		if (windows.kind === "full") return this;

		const { artifactId, noticeOwner, rangeBase } = options;
		const maxBytes = options.maxBytes ?? (windows as ReadWindow & { maxBytes?: number }).maxBytes;
		const outputLinesOverride = (windows as ReadWindow & { outputLinesOverride?: number }).outputLinesOverride;
		const outputBytesOverride = (windows as ReadWindow & { outputBytesOverride?: number }).outputBytesOverride;
		const owner = noticeOwner !== undefined ? { noticeOwner } : {};
		const rangeBaseMeta = rangeBase !== undefined ? { rangeBase } : {};
		const hiddenReason = (windows as ReadWindow & { truncatedBy?: "lines" | "bytes" | "middle" }).truncatedBy;
		const fallbackTruncatedBy: "lines" | "bytes" = hiddenReason === "bytes" ? "bytes" : "lines";
		const partialTail = windows.tail?.kind === "partial-line" ? windows.tail : undefined;
		if (partialTail) {
			const headBytes = windows.head?.bytes ?? 0;
			const separatorBytes = windows.head ? 1 : 0;
			const markerBytes =
				windows.elidedLines > 0
					? Buffer.byteLength(formatMiddleElisionMarker(windows.elidedLines, windows.elidedBytes), "utf-8") + 1
					: 0;
			this.#meta.truncation = {
				direction: windows.kind === "tail-only" ? "tail" : "middle",
				truncatedBy: "bytes",
				...owner,
				...rangeBaseMeta,
				totalLines: windows.totalLines,
				totalBytes: windows.totalBytes,
				outputLines:
					outputLinesOverride ??
					(windows.head
						? windows.head.lines + partialTail.lines + (windows.elidedLines > 0 ? 1 : 0)
						: partialTail.lines),
				outputBytes: outputBytesOverride ?? headBytes + partialTail.bytes + separatorBytes + markerBytes,
				...(maxBytes !== undefined ? { maxBytes } : {}),
				partialLine: {
					line: partialTail.origin.startLine,
					bytes: partialTail.bytes,
					sourceBytes: partialTail.sourceLineBytes,
				},
				artifactId,
			};
			return this;
		}

		if (windows.kind === "head-only" && windows.head) {
			const { head } = windows;
			this.#meta.truncation = {
				direction: "head",
				truncatedBy: fallbackTruncatedBy,
				...owner,
				...rangeBaseMeta,
				totalLines: windows.totalLines,
				totalBytes: windows.totalBytes,
				outputLines: outputLinesOverride ?? head.lines,
				outputBytes: outputBytesOverride ?? head.bytes,
				...(maxBytes !== undefined ? { maxBytes } : {}),
				shownRange: { start: head.origin.startLine, end: head.origin.endLine },
				artifactId,
				nextOffset: head.origin.endLine + 1,
			};
			return this;
		}

		if (windows.kind === "tail-only" && windows.tail) {
			const { tail } = windows;
			this.#meta.truncation = {
				direction: "tail",
				truncatedBy: fallbackTruncatedBy,
				...owner,
				...rangeBaseMeta,
				totalLines: windows.totalLines,
				totalBytes: windows.totalBytes,
				outputLines: outputLinesOverride ?? tail.lines,
				outputBytes: outputBytesOverride ?? tail.bytes,
				...(maxBytes !== undefined ? { maxBytes } : {}),
				shownRange: { start: tail.origin.startLine, end: tail.origin.endLine },
				artifactId,
			};
			return this;
		}

		const { head, tail } = windows;
		if (!head || !tail) return this;
		const marker = formatMiddleElisionMarker(windows.elidedLines, windows.elidedBytes);
		this.#meta.truncation = {
			direction: "middle",
			truncatedBy: "middle",
			...owner,
			...rangeBaseMeta,
			totalLines: windows.totalLines,
			totalBytes: windows.totalBytes,
			outputLines: head.lines + tail.lines + 1,
			outputBytes: head.bytes + tail.bytes + Buffer.byteLength(marker, "utf-8") + 2,
			...(maxBytes !== undefined ? { maxBytes } : {}),
			headRange: { start: head.origin.startLine, end: head.origin.endLine },
			tailRange: { start: tail.origin.startLine, end: tail.origin.endLine },
			elidedLines: windows.elidedLines,
			elidedBytes: windows.elidedBytes,
			artifactId,
		};
		return this;
	}

	/** Add truncation info from OutputSummary. No-op if not truncated or artifact evidence is absent. */
	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		const artifactFailureDiagnostic = summary.artifactFailureDiagnostic;
		const artifactTruncatedBytes =
			summary.artifactTruncatedBytes != null && summary.artifactTruncatedBytes > 0
				? summary.artifactTruncatedBytes
				: undefined;
		const hasArtifactEvidence =
			summary.artifactId !== undefined ||
			artifactFailureDiagnostic !== undefined ||
			artifactTruncatedBytes !== undefined;
		if (!summary.truncated && !hasArtifactEvidence) return this;

		const { direction, startLine = 1, totalFileLines, noticeOwner } = options;
		const totalLines = totalFileLines ?? summary.totalLines;
		const bodyHasArtifact =
			summary.artifactId !== undefined && summary.output.includes(`artifact://${summary.artifactId}`);
		const bodyOwnsArtifact =
			bodyHasArtifact &&
			(artifactTruncatedBytes === undefined ||
				(summary.artifactId !== undefined &&
					summary.output.includes(formatArtifactReference(summary.artifactId, artifactTruncatedBytes))));
		const owner =
			noticeOwner !== undefined ? { noticeOwner } : bodyOwnsArtifact ? { noticeOwner: "body" as const } : {};

		// Middle elision: the sink retained head + tail with an elision marker.
		if (summary.elidedBytes != null && summary.elidedBytes > 0) {
			const elidedLines = summary.elidedLines ?? Math.max(0, totalLines - summary.outputLines);
			const keptLines = Math.max(0, summary.outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				...owner,
				totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange: tailLines > 0 ? { start: totalLines - tailLines + 1, end: totalLines } : undefined,
				elidedBytes: summary.elidedBytes,
				elidedLines,
				artifactId: summary.artifactId,
				artifactTruncatedBytes,
				artifactFailureDiagnostic,
			};
			return this;
		}

		const truncatedBy: "lines" | "bytes" =
			summary.outputBytes < summary.totalBytes
				? "bytes"
				: summary.outputLines < summary.totalLines
					? "lines"
					: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = totalLines - summary.outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + summary.outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			...owner,
			totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId: summary.artifactId,
			artifactTruncatedBytes,
			artifactFailureDiagnostic,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from truncated output text. No-op if truncation not detected. */
	truncationFromText(text: string, options: TruncationTextOptions): this {
		const outputLines = text.length > 0 ? text.split("\n").length : 0;
		const outputBytes = Buffer.byteLength(text, "utf-8");
		const totalLines = options.totalLines ?? outputLines;
		const totalBytes = options.totalBytes ?? outputBytes;

		const truncated = totalLines > outputLines || totalBytes > outputBytes || false;
		if (!truncated) return this;

		const truncatedBy: "lines" | "bytes" =
			options.maxBytes && outputBytes >= options.maxBytes
				? "bytes"
				: totalBytes > outputBytes
					? "bytes"
					: totalLines > outputLines
						? "lines"
						: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (options.direction === "tail") {
			shownStart = totalLines - outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = 1;
			shownEnd = outputLines;
		}

		this.#meta.truncation = {
			direction: options.direction,
			truncatedBy,
			...(options.noticeOwner !== undefined ? { noticeOwner: options.noticeOwner } : {}),
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			maxBytes: options.maxBytes,
			artifactId: options.artifactId,
			shownRange: { start: shownStart, end: shownEnd },
			nextOffset: options.direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add match limit notice. No-op if reached <= 0. */
	matchLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, matchLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notices in one call. */
	limits(limits: { matchLimit?: number; resultLimit?: number; headLimit?: number; columnMax?: number }): this {
		if (limits.matchLimit !== undefined) {
			this.matchLimit(limits.matchLimit);
		}
		if (limits.resultLimit !== undefined) {
			this.resultLimit(limits.resultLimit);
		}
		if (limits.headLimit !== undefined) {
			this.headLimit(limits.headLimit);
		}
		if (limits.columnMax !== undefined) {
			this.columnTruncated(limits.columnMax);
		}
		return this;
	}

	/** Add result limit notice. No-op if reached <= 0. */
	resultLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, resultLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notice for head truncation. No-op if reached <= 0. */
	headLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, headLimit: { reached, suggestion } };
		return this;
	}

	/** Add column truncation notice. No-op if maxColumn <= 0. */
	columnTruncated(maxColumn: number): this {
		if (maxColumn <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, columnTruncated: { maxColumn } };
		return this;
	}

	/** Add source path info. */
	sourcePath(value: string): this {
		this.#meta.source = { type: "path", value };
		return this;
	}

	/** Add source URL info. */
	sourceUrl(value: string): this {
		this.#meta.source = { type: "url", value };
		return this;
	}

	/** Add internal URL source info (skill://, agent://, artifact://). */
	sourceInternal(value: string): this {
		this.#meta.source = { type: "internal", value };
		return this;
	}

	/** Add LSP diagnostics. No-op if no messages. */
	diagnostics(summary: string, messages: string[]): this {
		if (messages.length === 0) return this;
		this.#meta.diagnostics = { summary, messages };
		return this;
	}

	/** Get the built OutputMeta, or undefined if empty. */
	get(): OutputMeta | undefined {
		return Object.keys(this.#meta).length > 0 ? this.#meta : undefined;
	}
}

/** Create a new OutputMetaBuilder. */
export function outputMeta(): OutputMetaBuilder {
	return new OutputMetaBuilder();
}

// =============================================================================
// Notice formatting
// =============================================================================

export function formatFullOutputReference(artifactId: string): string {
	return `Read artifact://${artifactId} for full output`;
}

/**
 * Format an artifact reference without claiming completeness when storage was hard-capped.
 */
export function formatArtifactReference(artifactId: string, artifactTruncatedBytes?: number): string {
	if (artifactTruncatedBytes != null && artifactTruncatedBytes > 0) {
		return `Read artifact://${artifactId} for retained output (at least ${formatBytes(artifactTruncatedBytes)} omitted by the artifact storage cap)`;
	}
	return formatFullOutputReference(artifactId);
}

function formatTruncationArtifactNotice(truncation: TruncationMeta): string {
	const reference = truncation.artifactId
		? formatArtifactReference(truncation.artifactId, truncation.artifactTruncatedBytes)
		: undefined;
	if (truncation.artifactFailureDiagnostic) {
		const failure = `Artifact storage failed: ${truncation.artifactFailureDiagnostic}`;
		if (reference) return `${reference}; ${failure}`;
		return failure;
	}
	if (reference) return reference;
	return `Artifact storage omitted at least ${formatBytes(truncation.artifactTruncatedBytes ?? 0)}; no artifact reference is available`;
}

function hasArtifactNotice(truncation: TruncationMeta): boolean {
	return (
		truncation.artifactId != null ||
		(truncation.artifactTruncatedBytes ?? 0) > 0 ||
		truncation.artifactFailureDiagnostic != null
	);
}

function formatTruncationRangeTotal(truncation: TruncationMeta): string {
	return truncation.rangeBase === "window"
		? `the selected ${truncation.totalLines}-line range`
		: `${truncation.totalLines}`;
}

export function formatTruncationMetaNotice(truncation: TruncationMeta): string {
	const rangeTotal = formatTruncationRangeTotal(truncation);
	if (truncation.partialLine) {
		let notice = `Showing last ${formatBytes(truncation.partialLine.bytes)} of line ${truncation.partialLine.line} of ${rangeTotal}`;
		if (truncation.partialLine.sourceBytes > truncation.partialLine.bytes) {
			notice += ` (line is ${formatBytes(truncation.partialLine.sourceBytes)})`;
		}
		if (hasArtifactNotice(truncation)) {
			notice += `. ${formatTruncationArtifactNotice(truncation)}`;
		}
		return notice;
	}

	let notice: string;

	if (truncation.direction === "middle") {
		const head = truncation.headRange;
		const tail = truncation.tailRange;
		const totalLines = truncation.totalLines;
		const elidedBytes = truncation.elidedBytes ?? Math.max(0, truncation.totalBytes - truncation.outputBytes);
		const elidedLines = truncation.elidedLines ?? Math.max(0, totalLines - truncation.outputLines);
		const headPart = head ? `lines ${head.start}-${head.end}` : "";
		const tailPart = tail ? `${tail.start}-${tail.end}` : "";
		if (head && tail && elidedLines === 0 && head.start === tail.start && head.end === tail.end) {
			notice = `Showing head and tail of line ${head.start} of ${rangeTotal}; ${formatBytes(elidedBytes)} middle bytes elided`;
		} else if (headPart && tailPart) {
			notice = `Showing ${headPart} and ${tailPart} of ${rangeTotal}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`;
		} else {
			notice = `Showing ${truncation.outputLines} of ${rangeTotal}${truncation.rangeBase === "window" ? "" : " lines"}; ${formatBytes(elidedBytes)} middle bytes elided`;
		}
		if (hasArtifactNotice(truncation)) {
			notice += `. ${formatTruncationArtifactNotice(truncation)}`;
		}
		return notice;
	}

	const range = truncation.shownRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${rangeTotal}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${rangeTotal}${truncation.rangeBase === "window" ? "" : " lines"}`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use :${truncation.nextOffset} to continue`;
	}

	if (hasArtifactNotice(truncation)) {
		notice += `. ${formatTruncationArtifactNotice(truncation)}`;
	}

	return notice;
}

/**
 * Format styled artifact reference with warning color and brackets.
 * For TUI rendering of truncation warnings.
 */
export function formatStyledArtifactReference(artifactId: string, theme: Theme): string {
	return theme.fg("warning", formatFullOutputReference(artifactId));
}

/**
 * Format notices from OutputMeta for LLM consumption.
 * Returns empty string if no notices needed.
 */
export function formatOutputNotice(meta: OutputMeta | undefined): string {
	if (!meta) return "";

	const parts: string[] = [];

	// Truncation notice
	if (meta.truncation && meta.truncation.noticeOwner !== "body") {
		parts.push(formatTruncationMetaNotice(meta.truncation));
	}

	// Limit notices
	if (meta.limits?.matchLimit) {
		const l = meta.limits.matchLimit;
		parts.push(`${l.reached} matches limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.resultLimit) {
		const l = meta.limits.resultLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.headLimit) {
		const l = meta.limits.headLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.columnTruncated) {
		parts.push(`Some lines truncated to ${meta.limits.columnTruncated.maxColumn} chars`);
	}

	// Diagnostics
	let diagnosticsNotice = "";
	if (meta.diagnostics && meta.diagnostics.messages.length > 0) {
		const d = meta.diagnostics;
		diagnosticsNotice = `\n\nLSP Diagnostics (${d.summary}):\n${formatGroupedDiagnosticMessages(d.messages)}`;
	}

	const notice = parts.length ? `\n\n[${parts.join(". ")}]` : "";
	return notice + diagnosticsNotice;
}

/**
 * Format a styled truncation warning message.
 * Returns null if no truncation metadata present.
 */
export function formatStyledTruncationWarning(meta: OutputMeta | undefined, theme: Theme): string | null {
	const truncation = meta?.truncation;
	if (!truncation) return null;
	if (
		truncation.noticeOwner === "body" &&
		truncation.totalBytes === truncation.outputBytes &&
		truncation.totalLines === truncation.outputLines
	) {
		return null;
	}
	const warningMeta =
		truncation.noticeOwner === "body"
			? {
					...truncation,
					artifactId: undefined,
					artifactTruncatedBytes: undefined,
					artifactFailureDiagnostic: undefined,
				}
			: truncation;
	const message = formatTruncationMetaNotice(warningMeta);
	return theme.fg("warning", wrapBrackets(message, theme));
}

/**
 * Strip the trailing notice that {@link appendOutputNotice} bakes into the
 * LLM-facing content body. Renderers should call this before printing
 * `result.content` text in the TUI, because they emit a styled warning line of
 * their own; without this, users see the same `[Showing lines …]` string twice
 * (once verbatim from the body, once as the styled `⟨…⟩` warning).
 *
 * Safe to call eagerly: returns the input unchanged when no notice is present
 * (e.g. during streaming, before {@link wrappedExecute} runs).
 */
export function stripOutputNotice(text: string, meta: OutputMeta | undefined): string {
	const notice = formatOutputNotice(meta);
	if (!notice) return text;
	// Trim trailing whitespace from `text` and from the notice itself so we
	// match regardless of whether: (a) the caller already trimEnd()'d, (b)
	// extra blank lines slipped in after the notice (diagnostics blocks add
	// `\n\n` between sections, OutputSink may pad), or (c) neither. Returns
	// the prefix before the notice so the caller can re-trim as needed.
	const trimmedText = text.trimEnd();
	const trimmedNotice = notice.trimEnd();
	if (trimmedText.endsWith(trimmedNotice)) {
		return trimmedText.slice(0, -trimmedNotice.length);
	}
	return text;
}

// =============================================================================
// Tool wrapper
// =============================================================================

/**
 * Append output notice to tool result content if meta is present.
 */
function appendOutputNotice(
	content: (TextContent | ImageContent)[],
	meta: OutputMeta | undefined,
): (TextContent | ImageContent)[] {
	const notice = formatOutputNotice(meta);
	if (!notice) return content;

	const result = [...content];
	for (let i = result.length - 1; i >= 0; i--) {
		const item = result[i];
		if (item.type === "text") {
			result[i] = { ...item, text: item.text + notice };
			return result;
		}
	}

	result.push({ type: "text", text: notice.trim() });
	return result;
}

const kUnwrappedExecute = Symbol("OutputMeta.UnwrappedExecute");

// =============================================================================
// Centralized artifact spill for large tool results
// =============================================================================

/** Resolved artifact spill config sourced from the session settings (or schema defaults). */
function getSpillConfig(s: Settings | undefined) {
	type Path =
		| "tools.artifactSpillThreshold"
		| "tools.artifactTailBytes"
		| "tools.artifactTailLines"
		| "tools.artifactHeadBytes"
		| "tools.maxInlineResultBytes"
		| "tools.readArtifactSpillThreshold";
	const get = <P extends Path>(path: P) => s?.get(path) ?? getDefault(path);
	return {
		threshold: get("tools.artifactSpillThreshold") * 1024,
		readThreshold: get("tools.readArtifactSpillThreshold") * 1024,
		tailBytes: get("tools.artifactTailBytes") * 1024,
		tailLines: get("tools.artifactTailLines"),
		headBytes: get("tools.artifactHeadBytes") * 1024,
		maxInlineBytes: get("tools.maxInlineResultBytes") * 1024,
	};
}

/**
 * Resolve the OutputSink `headBytes` budget from session settings.
 * Exposed so streaming executors (bash/python/ssh/eval) can opt into
 * middle elision with the same per-user configuration.
 */
export function resolveOutputSinkHeadBytes(s: Settings | undefined): number {
	return getSpillConfig(s).headBytes;
}

export const BASH_DEFAULT_OUTPUT_TAIL_BYTES = 1024;

/**
 * Bash uses a deliberately small tail window to nudge callers toward focused
 * commands and dedicated search tools. An explicitly configured shared tail
 * budget still wins.
 */
export function resolveBashOutputSinkTailBytes(s: Settings): number {
	const configuredTailBytes = s.get("tools.artifactTailBytes");
	const hasExplicitTailBytes =
		typeof s.has === "function" ? s.has("tools.artifactTailBytes") : configuredTailBytes !== undefined;
	return hasExplicitTailBytes && configuredTailBytes !== undefined
		? configuredTailBytes * 1024
		: BASH_DEFAULT_OUTPUT_TAIL_BYTES;
}
/**
 * Bash keeps only the tail unless the user explicitly opts into the shared
 * head-retention setting. Schema defaults still apply to other streaming
 * tools without silently turning Bash back into middle-elision mode.
 */
export function resolveBashOutputSinkHeadBytes(s: Settings): number {
	const configuredHeadBytes = s.get("tools.artifactHeadBytes");
	const hasExplicitHeadBytes =
		typeof s.has === "function" ? s.has("tools.artifactHeadBytes") : configuredHeadBytes !== undefined;
	return hasExplicitHeadBytes && configuredHeadBytes !== undefined ? configuredHeadBytes * 1024 : 0;
}

/**
 * Resolve the per-line column cap from session settings. Shared by streaming
 * executors (bash/python/ssh/eval via OutputSink) and the `read` tool's
 * line-buffer post-processing, so one setting controls both surfaces.
 */
export function resolveOutputMaxColumns(s: Settings | undefined): number {
	return s?.get("tools.outputMaxColumns") ?? getDefault("tools.outputMaxColumns");
}

/**
 * If the tool result text exceeds the spill threshold, save the full output
 * as a session artifact and replace the content with a head+tail (middle
 * elision) view plus an artifact reference. When `tools.artifactHeadBytes`
 * is 0, falls back to tail-only truncation. Skips when the tool already
 * saved its own artifact (e.g. bash/python via OutputSink).
 */
function artifactCapabilityForContext(context: AgentToolContext | undefined) {
	return sessionArtifactCapability(context?.sessionManager);
}

async function spillLargeResultToArtifact(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<AgentToolResult> {
	if (toolName === "read" && (result.details as { spillEligible?: boolean } | undefined)?.spillEligible !== true) {
		return result;
	}

	const artifactCapability = artifactCapabilityForContext(context);
	if (!artifactCapability) return result;
	const { threshold, readThreshold, tailBytes, tailLines, headBytes } = getSpillConfig(context?.settings);
	// `read` manages its own per-range truncation, but the combined multi-range
	// output has no cap — enforce a read-specific (higher) combined threshold
	// instead of exempting read entirely. 0 disables read spill (backstop only).
	const effectiveThreshold = toolName === "read" ? readThreshold : threshold;
	if (effectiveThreshold <= 0) return result;

	// Skip if tool already saved an artifact
	const existingMeta: OutputMeta | undefined = result.details?.meta;
	if (existingMeta?.truncation?.artifactId) return result;

	// Measure total text content
	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	if (textParts.length === 0) return result;

	const fullText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= effectiveThreshold) return result;

	// Save full output as artifact
	const artifactId = await artifactCapability.saveArtifact(fullText, toolName);
	if (!artifactId) return result;

	// Truncate: middle elision when a head budget is configured, otherwise tail-only.
	const useMiddle = headBytes > 0;
	const truncated = useMiddle
		? truncateMiddle(fullText, {
				maxBytes: headBytes + tailBytes,
				maxLines: tailLines * 2,
				maxHeadBytes: headBytes,
				maxHeadLines: tailLines,
			})
		: truncateTail(fullText, {
				maxBytes: tailBytes,
				maxLines: tailLines,
			});

	// Replace text blocks with single truncated block, keep images
	const newContent: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		if (block.type !== "text") {
			newContent.push(block);
		}
	}
	newContent.push({ type: "text", text: truncated.content });

	// Build truncation meta
	const outputLines = truncated.outputLines ?? truncated.totalLines;
	const outputBytes = truncated.outputBytes ?? truncated.totalBytes;
	let truncationMeta: TruncationMeta;
	if (truncated.truncatedBy === "middle") {
		const elidedLines = truncated.elidedLines ?? Math.max(0, truncated.totalLines - outputLines);
		const elidedBytes = truncated.elidedBytes ?? Math.max(0, truncated.totalBytes - outputBytes);
		const keptLines = Math.max(0, outputLines - 1); // -1 for marker line
		const headLines = Math.ceil(keptLines / 2);
		const tailLineCount = keptLines - headLines;
		truncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: headBytes + tailBytes,
			headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
			tailRange:
				tailLineCount > 0
					? { start: truncated.totalLines - tailLineCount + 1, end: truncated.totalLines }
					: undefined,
			elidedLines,
			elidedBytes,
			artifactId,
		};
	} else {
		const shownStart = truncated.totalLines - outputLines + 1;
		truncationMeta = {
			direction: "tail",
			truncatedBy: truncated.truncatedBy ?? "bytes",
			totalLines: truncated.totalLines,
			totalBytes: truncated.totalBytes,
			outputLines,
			outputBytes,
			maxBytes: tailBytes,
			shownRange: { start: shownStart, end: truncated.totalLines },
			artifactId,
		};
	}

	const newMeta: OutputMeta = { ...(existingMeta ?? {}), truncation: truncationMeta };
	const newDetails = { ...(result.details ?? {}), meta: newMeta };

	return { ...result, content: newContent, details: newDetails };
}

const BODY_TRUNCATION_FOOTER_KEY = "__bodyTruncationFooter";

function stripBodyOwnedTruncationFooter(text: string, details: unknown): string {
	const footer = (details as { [BODY_TRUNCATION_FOOTER_KEY]?: unknown } | undefined)?.[BODY_TRUNCATION_FOOTER_KEY];
	if (typeof footer !== "string" || footer.length === 0) return text;
	const trimmedText = text.trimEnd();
	const trimmedFooter = footer.trim();
	if (!trimmedText.endsWith(trimmedFooter)) return text;
	return trimmedText.slice(0, -trimmedFooter.length).trimEnd();
}

/**
 * Absolute inline-size backstop enforced after {@link spillLargeResultToArtifact}.
 *
 * The threshold-based spill above has escape hatches: it skips ineligible `read`
 * results and results that already carry an `artifactId` (a tool may set
 * partial truncation meta yet still emit oversized inline text). This backstop
 * closes those gaps: when `tools.maxInlineResultBytes` is configured (> 0), any
 * final result whose inline text exceeds the cap is force-saved to an artifact
 * (reusing an existing artifactId to avoid double-artifacting) and truncated to a
 * head+tail view that fits the cap. Disabled by default (opt-in pending
 * measurement); a 0 cap returns the result untouched.
 */
async function enforceInlineResultBackstop(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<AgentToolResult> {
	const { maxInlineBytes, tailLines, headBytes } = getSpillConfig(context?.settings);
	if (maxInlineBytes <= 0) return result;

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	if (textParts.length === 0) return result;

	const renderedText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
	const fullText = stripBodyOwnedTruncationFooter(renderedText, result.details);
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= maxInlineBytes) return result;

	// Reuse an existing artifact (avoid double-artifacting); otherwise save the
	// full output so the truncated view keeps a reference to the complete text.
	const existingMeta: OutputMeta | undefined = result.details?.meta;
	let artifactId = existingMeta?.truncation?.artifactId;
	const artifactCapability = artifactCapabilityForContext(context);
	if (!artifactId && artifactCapability) {
		artifactId = (await artifactCapability.saveArtifact(fullText, toolName)) ?? undefined;
	}

	// Budget head+tail below the cap, reserving room for the elision marker so the
	// composed `<head>\n<marker>\n<tail>` view never exceeds the configured cap.
	const MARKER_RESERVE = 256;
	const budget = maxInlineBytes - MARKER_RESERVE;
	const useMiddle = headBytes > 0 && budget > 0;
	let truncated = useMiddle
		? truncateMiddle(fullText, {
				maxBytes: budget,
				maxLines: tailLines * 2,
				maxHeadBytes: Math.min(headBytes, Math.floor(budget / 2)),
				maxHeadLines: tailLines,
			})
		: truncateTail(fullText, { maxBytes: maxInlineBytes, maxLines: tailLines });

	// Defensive clamp: guarantee the contract even for pathological marker sizes.
	if (Buffer.byteLength(truncated.content, "utf-8") > maxInlineBytes) {
		truncated = truncateTail(fullText, { maxBytes: maxInlineBytes, maxLines: tailLines });
	}

	const newContent: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		if (block.type !== "text") {
			newContent.push(block);
		}
	}
	newContent.push({ type: "text", text: truncated.content });

	const outputLines = truncated.outputLines ?? truncated.totalLines;
	const outputBytes = truncated.outputBytes ?? truncated.totalBytes;
	const truncationMeta: TruncationMeta =
		truncated.truncatedBy === "middle"
			? {
					direction: "middle",
					truncatedBy: "middle",
					totalLines: truncated.totalLines,
					totalBytes: truncated.totalBytes,
					outputLines,
					outputBytes,
					maxBytes: maxInlineBytes,
					elidedLines: truncated.elidedLines ?? Math.max(0, truncated.totalLines - outputLines),
					elidedBytes: truncated.elidedBytes ?? Math.max(0, truncated.totalBytes - outputBytes),
					artifactId,
				}
			: {
					direction: "tail",
					truncatedBy: truncated.truncatedBy ?? "bytes",
					totalLines: truncated.totalLines,
					totalBytes: truncated.totalBytes,
					outputLines,
					outputBytes,
					maxBytes: maxInlineBytes,
					shownRange: { start: truncated.totalLines - outputLines + 1, end: truncated.totalLines },
					artifactId,
				};

	const newMeta: OutputMeta = { ...(existingMeta ?? {}), truncation: truncationMeta };
	const newDetails = { ...(result.details ?? {}), meta: newMeta };
	return { ...result, content: newContent, details: newDetails };
}

// =============================================================================
// Tool wrapper
// =============================================================================

async function wrappedExecute(
	this: AgentTool & { [kUnwrappedExecute]: AgentToolExecFn },
	toolCallId: string,
	params: any,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
): Promise<AgentToolResult> {
	const originalExecute = this[kUnwrappedExecute];

	try {
		let result = await originalExecute.call(this, toolCallId, params, signal, onUpdate, context);

		// Spill large results to artifact, truncate to tail
		result = await spillLargeResultToArtifact(result, this.name, context);

		// Absolute inline-size backstop: catches oversized text the threshold spill
		// skipped (read exemption, tools with pre-existing partial artifact meta).
		result = await enforceInlineResultBackstop(result, this.name, context);

		// Append notices from meta
		const meta: OutputMeta | undefined = result.details?.meta;
		if (meta) {
			return {
				...result,
				content: appendOutputNotice(result.content, meta),
			};
		}
		return result;
	} catch (e) {
		// Re-throw with formatted message so agent-loop sets isError flag
		throw new Error(renderError(e));
	}
}

/**
 * Wrap a tool to:
 * 1. Automatically append output notices based on details.meta
 * 2. Handle ToolError rendering
 */
export function wrapToolWithMetaNotice<T extends AgentTool<any, any, any>>(tool: T): T {
	if (kUnwrappedExecute in tool) {
		return tool;
	}

	const originalExecute = tool.execute;

	return Object.defineProperties(tool, {
		[kUnwrappedExecute]: {
			value: originalExecute,
			enumerable: false,
			configurable: true,
		},
		execute: {
			value: wrappedExecute,
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}
