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
import { type OutputSummary, type TruncationResult, truncateMiddle, truncateTail } from "../session/streaming-output";
import { formatBytes, wrapBrackets } from "./render-utils";
import { renderError } from "./tool-errors";

/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
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
	/** Bytes elided from the middle. */
	elidedBytes?: number;
	/** Lines elided from the middle. */
	elidedLines?: number;
	/** Artifact ID if full output was saved */
	artifactId?: string;
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
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
}

export interface TruncationTextOptions {
	direction: "head" | "tail" | "middle";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
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

		const { direction, startLine = 1, totalFileLines, artifactId } = options;
		const outputLines = result.outputLines ?? result.totalLines;
		const outputBytes = result.outputBytes ?? result.totalBytes;
		const isMiddle = direction === "middle" || result.truncatedBy === "middle";
		const truncatedBy: "lines" | "bytes" | "middle" = isMiddle
			? "middle"
			: result.truncatedBy === "lines"
				? "lines"
				: "bytes";

		const effectiveTotalLines = totalFileLines ?? result.totalLines;

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
				totalLines: effectiveTotalLines,
				totalBytes: result.totalBytes,
				outputLines,
				outputBytes,
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
			totalLines: effectiveTotalLines,
			totalBytes: result.totalBytes,
			outputLines,
			outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from OutputSummary. No-op if not truncated. */
	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		if (!summary.truncated) return this;

		const { direction, startLine = 1, totalFileLines } = options;
		const totalLines = totalFileLines ?? summary.totalLines;

		// Middle elision: the sink retained head + tail with an elision marker.
		if (summary.elidedBytes != null && summary.elidedBytes > 0) {
			const elidedLines = summary.elidedLines ?? Math.max(0, totalLines - summary.outputLines);
			const keptLines = Math.max(0, summary.outputLines - 1); // -1 for marker line
			const headLines = Math.ceil(keptLines / 2);
			const tailLines = keptLines - headLines;
			this.#meta.truncation = {
				direction: "middle",
				truncatedBy: "middle",
				totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				headRange: headLines > 0 ? { start: 1, end: headLines } : undefined,
				tailRange: tailLines > 0 ? { start: totalLines - tailLines + 1, end: totalLines } : undefined,
				elidedBytes: summary.elidedBytes,
				elidedLines,
				artifactId: summary.artifactId,
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
			totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId: summary.artifactId,
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
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			maxBytes: options.maxBytes,
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

export function formatTruncationMetaNotice(truncation: TruncationMeta): string {
	let notice: string;

	if (truncation.direction === "middle") {
		const head = truncation.headRange;
		const tail = truncation.tailRange;
		const totalLines = truncation.totalLines;
		const elidedBytes = truncation.elidedBytes ?? Math.max(0, truncation.totalBytes - truncation.outputBytes);
		const elidedLines = truncation.elidedLines ?? Math.max(0, totalLines - truncation.outputLines);
		const headPart = head ? `lines ${head.start}-${head.end}` : "";
		const tailPart = tail ? `${tail.start}-${tail.end}` : "";
		if (headPart && tailPart) {
			notice = `Showing ${headPart} and ${tailPart} of ${totalLines}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`;
		} else {
			notice = `Showing ${truncation.outputLines} of ${totalLines} lines; middle elided`;
		}
		if (truncation.artifactId != null) {
			notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
		}
		return notice;
	}

	const range = truncation.shownRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use :${truncation.nextOffset} to continue`;
	}

	if (truncation.artifactId != null) {
		notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
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
	if (meta.truncation) {
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
	if (!meta?.truncation) return null;
	const message = formatTruncationMetaNotice(meta.truncation);
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

/**
 * Absolute inline-size backstop enforced after {@link spillLargeResultToArtifact}.
 *
 * The threshold-based spill above has escape hatches: it early-returns for the
 * `read` tool and for results that already carry an `artifactId` (a tool may set
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

	const fullText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
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
