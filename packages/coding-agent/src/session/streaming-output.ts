import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolUpdateCallback } from "@gajae-code/agent-core";

import { sanitizeText } from "@gajae-code/utils";
import { formatBytes } from "../tools/render-utils";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";

function sanitizeOutputChunk(rawChunk: string): string {
	return sanitizeWithOptionalSixelPassthrough(rawChunk, sanitizeText);
}

/**
 * Flush threshold for the opt-in sanitize-coalescing path (F21). When coalescing is enabled, raw
 * chunks accumulate until they reach this many chars, then are sanitized + delivered as one batch,
 * so many-small-chunk output pays one sanitize pass per batch instead of one per tiny chunk.
 */
const COALESCE_FLUSH_CHARS = 64 * 1024;

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const DEFAULT_MAX_COLUMN = 1024; // Max chars per grep match line
export const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

const NL = "\n";

const ELLIPSIS = "…";

// Bound the temporary parts/join allocation in #applyColumnCap for a single
// large callback. Keep batches small enough to avoid per-line retention work.
const COLUMN_CAP_BATCH_CHARS = 64 * 1024;

const outputPlainSecrets = new AsyncLocalStorage<readonly string[]>();

/** Run `fn` while column caps can see these plain secrets. */
export function runWithOutputRedaction<T>(plainSecrets: readonly string[], fn: () => T): T {
	return outputPlainSecrets.run(plainSecrets, fn);
}

/** Get the active plain secrets from AsyncLocalStorage, if any are set. */
function activePlainSecrets(): readonly string[] | undefined {
	const secrets = outputPlainSecrets.getStore();
	return secrets && secrets.length > 0 ? secrets : undefined;
}

/**
 * Pull a column-cap end back to the start of any plain secret that crosses it.
 * A secret that ends on the cut stays, so a later whole-string obfuscator can match it.
 */
function columnHeadEndOutsideSecrets(segment: string, end: number, secrets: readonly string[]): number {
	let cut = end;
	while (cut > 0) {
		let earliest = cut;
		for (const secret of secrets) {
			const secretChars = secret.length;
			if (secretChars === 0) continue;
			const windowStart = Math.max(0, cut - secretChars);
			const window = segment.slice(windowStart, Math.min(segment.length, cut + secretChars));
			const limit = cut - windowStart;
			let from = 0;
			while (from < limit) {
				const rel = window.indexOf(secret, from);
				if (rel === -1 || rel >= limit) break;
				if (rel + secretChars > limit) earliest = Math.min(earliest, windowStart + rel);
				from = rel + 1;
			}
		}
		if (earliest === cut) break;
		cut = earliest;
	}
	return cut;
}

/**
 * Pull a column-cap end off a proper prefix of a plain secret.
 * Each candidate's continuation is checked from longest to shortest.
 * A longer candidate that is already finished or contradicted does not hide
 * a shorter open prefix. A secret that already ends on the cut stays.
 */
function columnHeadEndBeforeOpenPrefix(text: string, end: number, secrets: readonly string[]): number {
	let cut = end;
	const after = text.slice(end);
	for (const secret of secrets) {
		const secretChars = secret.length;
		if (secretChars < 2 || end < 1) continue;
		if (end >= secretChars && text.slice(end - secretChars, end) === secret) continue;
		const maxPrefix = Math.min(secretChars - 1, end);
		for (let k = maxPrefix; k >= 1; k--) {
			if (text.slice(end - k, end) !== secret.slice(0, k)) continue;
			const rest = secret.slice(k);
			const have = Math.min(after.length, rest.length);
			if (have === rest.length) continue;
			if (after.slice(0, have) !== rest.slice(0, have)) continue;
			cut = Math.min(cut, end - k);
			break;
		}
	}
	return cut;
}

const ARTIFACT_WRITER_DIAGNOSTIC_MAX_BYTES = 256;

/**
 * Terminal publisher used when managed artifact storage exposes an ID but no
 * writable pathname. The sink supplies raw content retained up to its artifact
 * hard cap; `omittedBytes` is the source-byte count already omitted by that cap.
 * A successful publisher may report additional omitted bytes (for example, a
 * downstream storage cap); those counts are added to the sink summary. Failed
 * and unavailable results are surfaced through the bounded artifact diagnostic
 * without exposing an unresolvable artifact URL.
 */
export type TerminalArtifactPublishResult =
	| { status: "published"; artifactId: string; omittedBytes?: number }
	| { status: "unavailable" }
	| { status: "failed"; diagnostic: string };

export type TerminalArtifactPublisher = (
	content: string,
	info: { totalBytes: number; omittedBytes: number },
) => Promise<TerminalArtifactPublishResult>;

// =============================================================================
// Interfaces
// =============================================================================

export interface OutputSummary {
	output: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	/** Bytes elided from the middle when head-retain mode is active. */
	elidedBytes?: number;
	/** Lines elided from the middle when head-retain mode is active. */
	elidedLines?: number;
	/** Bytes dropped by the per-line column cap (sum across all lines). */
	columnDroppedBytes?: number;
	/** Number of distinct lines that hit the per-line column cap. */
	columnTruncatedLines?: number;
	/** Artifact ID for internal URL access (artifact://<id>) when output was persisted. */
	artifactId?: string;
	/** Bytes omitted from artifact storage after the artifact hard cap was reached. */
	artifactTruncatedBytes?: number;
	/** Bounded diagnostic when artifact writer or terminal publisher creation, write, finalization, or publication failed. */
	artifactFailureDiagnostic?: string;
}

export interface OutputSinkOptions {
	/**
	 * Deprecated managed artifact pathname. Bare paths are deliberately ignored:
	 * streaming output must be terminally published through ArtifactManager.
	 */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * Optional terminal publisher for managed artifact stores that do not expose a
	 * writable path. It is invoked only when visible spill/truncation requires an
	 * artifact, and receives raw content bounded by `artifactMaxBytes`.
	 */
	artifactPublisher?: TerminalArtifactPublisher;
	/** Tail buffer budget (bytes). Default DEFAULT_MAX_BYTES. */
	spillThreshold?: number;
	/**
	 * When > 0, the sink keeps the first `headBytes` of output in addition to
	 * the rolling tail window. Output between the two windows is elided
	 * (middle elision). Default 0 = tail-only behavior.
	 */
	headBytes?: number;
	/**
	 * Per-line byte cap. When > 0, lines wider than `maxColumns` bytes are
	 * truncated with an ellipsis at write time; remaining bytes up to the next
	 * `\n` are dropped. Cap state persists across chunks so split-mid-line
	 * writes still respect the budget. Default 0 = no per-line cap.
	 */
	maxColumns?: number;
	/** Hard cap for artifact writes/pending replay. Default DEFAULT_ARTIFACT_MAX_BYTES. */
	artifactMaxBytes?: number;
	onChunk?: (chunk: string) => void;
	/** Minimum ms between onChunk calls. 0 = every chunk (default). */
	chunkThrottleMs?: number;
	/**
	 * Unthrottled per-chunk callback fired *after* sanitization but *before*
	 * any throttle gating, column capping, or head/tail bookkeeping. Used by
	 * background-job substrate to record the complete process stream for the
	 * Monitor tool while keeping `onChunk` cheap for UI/progress.
	 *
	 * Receives the sanitized chunk verbatim; never receives the column-capped
	 * or minimized text. Implementations must be fast and side-effect-free
	 * relative to the sink (the sink does not catch errors from this callback).
	 */
	onRawChunk?: (chunk: string) => void;
	/**
	 * Opt-in (F21): when true, sanitization + live callback delivery + retention are coalesced over
	 * batched raw chunks instead of run per chunk, bounding sync CPU for many-small-chunk output. The
	 * raw artifact mirror stays byte-correct. Defaults to the PI_OUTPUT_SANITIZE_COALESCE env flag
	 * (default OFF — the per-chunk path is byte-identical to historical behavior).
	 */
	coalesceSanitize?: boolean;
}

export interface TruncationResult {
	content: string;
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines?: number;
	outputBytes?: number;
	/** Bytes elided from the middle (truncateMiddle only). */
	elidedBytes?: number;
	/** Lines elided from the middle (truncateMiddle only). */
	elidedLines?: number;
	lastLinePartial?: boolean;
	firstLineExceedsLimit?: boolean;
	lastLineExceedsLimit?: boolean;
}

/** Direction vocabulary used by callers that select which end of content to retain. */
export type TruncationDirection = "head" | "last" | "both";

export interface TruncationOptions {
	/** Maximum number of lines (default: 3000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
	/**
	 * For `truncateMiddle`: bytes reserved for the head window. The tail
	 * window receives `maxBytes - maxHeadBytes`. Default `floor(maxBytes/2)`.
	 */
	maxHeadBytes?: number;
	/**
	 * For `truncateMiddle`: lines reserved for the head window. The tail
	 * window receives `maxLines - maxHeadLines`. Default `floor(maxLines/2)`.
	 */
	maxHeadLines?: number;
	/** Direction to dispatch through truncateContent (head, last, or both). */
	direction?: TruncationDirection;
}

/** Result from byte-level truncation helpers. */
export interface ByteTruncationResult {
	text: string;
	bytes: number;
}

export interface TailTruncationNoticeOptions {
	fullOutputPath?: string;
	originalContent?: string;
	suffix?: string;
}

export interface HeadTruncationNoticeOptions {
	startLine?: number;
	totalFileLines?: number;
}

// =============================================================================
// Internal low-level helpers
// =============================================================================

/** Count newline characters via native substring search. */
function countNewlines(text: string): number {
	let count = 0;
	let pos = text.indexOf(NL);
	while (pos !== -1) {
		count++;
		pos = text.indexOf(NL, pos + 1);
	}
	return count;
}

/** Zero-copy view of a Uint8Array as a Buffer (copies only if already a Buffer). */
function asBuffer(data: Uint8Array): Buffer {
	return Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Advance past UTF-8 continuation bytes (10xxxxxx) to a leading byte. */
function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
	let i = Math.max(0, pos);
	while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

/** Retreat past UTF-8 continuation bytes to land on a leading byte. */
function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
	let i = Math.min(buf.length, Math.max(0, cut));
	// If the cut is at end-of-buffer, it's already a valid boundary.
	if (i >= buf.length) return buf.length;
	while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

// =============================================================================
// Byte-level truncation (windowed encoding)
// =============================================================================

function truncateBytesWindowed(
	data: string | Uint8Array,
	maxBytesRaw: number,
	mode: "head" | "tail",
): ByteTruncationResult {
	const maxBytes = maxBytesRaw;
	if (maxBytes === 0) return { text: "", bytes: 0 };

	// --------------------------
	// String path (windowed)
	// --------------------------
	if (typeof data === "string") {
		// Fast non-truncation check only when it *might* fit.
		if (data.length <= maxBytes) {
			const len = Buffer.byteLength(data, "utf-8");
			if (len <= maxBytes) return { text: data, bytes: len };
			// else: multibyte-heavy string; fall through to truncation using full string as window.
		}

		const window =
			mode === "head"
				? data.substring(0, Math.min(data.length, maxBytes))
				: data.substring(Math.max(0, data.length - maxBytes));

		const buf = Buffer.from(window, "utf-8");

		if (mode === "head") {
			const end = findUtf8BoundaryBackward(buf, maxBytes);
			if (end <= 0) return { text: "", bytes: 0 };
			const slice = buf.subarray(0, end);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		} else {
			const startAt = Math.max(0, buf.length - maxBytes);
			const start = findUtf8BoundaryForward(buf, startAt);
			const slice = buf.subarray(start);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		}
	}

	// --------------------------
	// Uint8Array / Buffer path
	// --------------------------
	const buf = asBuffer(data);
	if (buf.length <= maxBytes) return { text: buf.toString("utf-8"), bytes: buf.length };

	if (mode === "head") {
		const end = findUtf8BoundaryBackward(buf, maxBytes);
		if (end <= 0) return { text: "", bytes: 0 };
		const slice = buf.subarray(0, end);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	} else {
		const startAt = buf.length - maxBytes;
		const start = findUtf8BoundaryForward(buf, startAt);
		const slice = buf.subarray(start);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}
}

/**
 * Truncate a string/buffer to fit within a byte limit, keeping the tail.
 * Handles multi-byte UTF-8 boundaries correctly.
 */
export function truncateTailBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "tail");
}

/**
 * Truncate a string/buffer to fit within a byte limit, keeping the head.
 * Handles multi-byte UTF-8 boundaries correctly.
 */
export function truncateHeadBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "head");
}

// =============================================================================
// Line-level utilities
// =============================================================================

/**
 * Truncate a single line to max characters, appending '…' if truncated.
 */
export function truncateLine(
	line: string,
	maxChars: number = DEFAULT_MAX_COLUMN,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}…`, wasTruncated: true };
}

/**
 * Truncate each line to max characters without leaving a configured plain-secret
 * prefix in the retained text. Prior uncapped lines remain in scope because a
 * later line's cut can split a multiline secret.
 */
export function truncateTextWithSecretAwareness(
	text: string,
	maxChars: number = DEFAULT_MAX_COLUMN,
	secrets?: readonly string[],
): { text: string; wasTruncated: boolean } {
	const lines = text.split(NL);
	const activeSecrets = secrets ?? activePlainSecrets();
	if (!activeSecrets?.some(secret => secret.length > 0)) {
		let wasTruncated = false;
		const truncated = lines.map(line => {
			const result = truncateLine(line, maxChars);
			wasTruncated ||= result.wasTruncated;
			return result.text;
		});
		return { text: truncated.join(NL), wasTruncated };
	}

	const contextChars = activeSecrets.reduce((max, secret) => Math.max(max, secret.length), 0);
	let context = "";
	const outputParts: string[] = [];
	let wasTruncated = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const newline = index < lines.length - 1 ? NL : "";
		if (line.length <= maxChars) {
			outputParts.push(line, newline);
			context = (context + line + newline).slice(-contextChars);
			continue;
		}

		wasTruncated = true;
		const combined = context + line;
		let end = context.length + maxChars;
		while (end > 0) {
			const next = Math.min(
				columnHeadEndOutsideSecrets(combined, end, activeSecrets),
				columnHeadEndBeforeOpenPrefix(combined, end, activeSecrets),
			);
			if (next >= end) break;
			end = next;
		}

		if (end < context.length) {
			const retract = context.slice(end);
			let output = outputParts.join("");
			if (output.endsWith(retract)) {
				output = output.slice(0, output.length - retract.length);
				output += NL.repeat(countNewlines(retract));
			} else {
				output = NL.repeat(countNewlines(output));
			}
			outputParts.length = 0;
			outputParts.push(output);
		}
		const keptChars = Math.max(0, end - context.length);
		outputParts.push(line.slice(0, keptChars), ELLIPSIS, newline);
		context = "";
	}
	return { text: outputParts.join(""), wasTruncated };
}

// =============================================================================
// Content truncation (line + byte aware, no full Buffer allocation)
// =============================================================================

/** Shared helper to build a no-truncation result. */
export function noTruncResult(content: string, totalLines?: number, totalBytes?: number): TruncationResult {
	if (totalLines == null) totalLines = countNewlines(content) + 1;
	if (totalBytes == null) totalBytes = Buffer.byteLength(content, "utf-8");
	return { content, totalLines, totalBytes };
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Never returns partial lines. If the first line exceeds the byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 *
 * This implementation avoids Buffer.from(content) for the whole input.
 * It only computes UTF-8 byteLength for candidate lines that can still fit.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let cutIndex = 0; // char index where we cut (exclusive)
	let cursor = 0;

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.indexOf(NL, cursor);
		const lineEnd = nl === -1 ? content.length : nl;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		// No room even for separators / bytes.
		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		// Fast reject huge lines without slicing/encoding:
		// UTF-8 bytes >= UTF-16 code units, so if code units exceed remaining, bytes must exceed too.
		const lineCodeUnits = lineEnd - cursor;
		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		// Small slice (bounded by remaining <= maxBytes) for exact UTF-8 byte count.
		const lineText = content.slice(cursor, lineEnd);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		// Include the line (join semantics: no trailing newline after the last included line).
		bytesUsed += sepBytes + lineBytes;
		includedLines++;

		cutIndex = nl === -1 ? content.length : nl; // exclude the newline after the last included line
		if (nl === -1) break;
		cursor = nl + 1;
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: content.slice(0, cutIndex),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * May return a partial first line if the last line exceeds the byte limit.
 *
 * Also avoids Buffer.from(content) for the whole input.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let startIndex = content.length; // char index where output starts
	let end = content.length; // char index where current line ends (exclusive)

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.lastIndexOf(NL, end - 1);
		const lineStart = nl === -1 ? 0 : nl + 1;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		const lineCodeUnits = end - lineStart;

		// Fast reject huge line without slicing/encoding.
		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				// Window the line substring to avoid materializing a giant string.
				const windowStart = Math.max(lineStart, end - maxBytes);
				const window = content.substring(windowStart, end);
				const tail = truncateTailBytes(window, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
					lastLineExceedsLimit: true,
				};
			}
			break;
		}

		const lineText = content.slice(lineStart, end);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				const tail = truncateTailBytes(lineText, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
					lastLineExceedsLimit: true,
				};
			}
			break;
		}

		bytesUsed += sepBytes + lineBytes;
		includedLines++;
		startIndex = lineStart;

		if (nl === -1) break;
		end = nl; // exclude the newline itself; it'll be accounted as sepBytes in the next iteration
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: content.slice(startIndex),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

// =============================================================================
// Middle elision (keep head + tail, drop middle)
// =============================================================================

/**
 * Format the inline marker substituted for the elided middle region.
 * Returned without surrounding newlines so callers can position it freely.
 */
export function formatMiddleElisionMarker(elidedLines: number, elidedBytes: number): string {
	const linesPart = `${elidedLines.toLocaleString()} line${elidedLines === 1 ? "" : "s"}`;
	return `[… ${linesPart} elided (${formatBytes(elidedBytes)}) …]`;
}

/**
 * A retained source segment returned by {@link truncateMiddleWindows}.
 * Line coordinates are 1-indexed and inclusive.
 */
export type ReadSegment =
	| {
			kind: "lines";
			content: string;
			lines: number;
			bytes: number;
			origin: { startLine: number; endLine: number };
			lastLinePartial: false;
	  }
	| {
			kind: "partial-line";
			content: string;
			lines: 1;
			bytes: number;
			origin: { startLine: number; endLine: number };
			sourceLineBytes: number;
			lastLinePartial: true;
	  };

/** The actual windows retained by middle truncation. */
export interface ReadWindow {
	kind: "full" | "head-only" | "tail-only" | "middle";
	head?: ReadSegment;
	tail?: ReadSegment;
	// With normalized head/tail line budgets, an overlap cannot occur: a
	// source that can fit both windows returns `full`, otherwise their kept
	// line counts sum to less than the source. Retain this defensive value for
	// custom/future budgets and wire compatibility.
	overlap: "disjoint" | "adjacent" | "overlapping";
	elidedLines: number;
	elidedBytes: number;
	totalLines: number;
	totalBytes: number;
	/** @deprecated Non-enumerable compatibility reason for older consumers. */
	truncatedBy?: "lines" | "bytes" | "middle";
}

function outputLineCount(result: TruncationResult): number {
	return result.outputLines ?? (result.content.length === 0 ? 0 : countNewlines(result.content) + 1);
}

function outputByteCount(result: TruncationResult): number {
	return result.outputBytes ?? Buffer.byteLength(result.content, "utf-8");
}

function lastSourceLineBytes(content: string): number {
	const lineStart = content.lastIndexOf(NL) + 1;
	return Buffer.byteLength(content.slice(lineStart), "utf-8");
}

function makeReadSegment(
	result: TruncationResult,
	startLine: number,
	totalLines: number,
	sourceContent: string = result.content,
): ReadSegment | undefined {
	const lines = outputLineCount(result);
	if (lines <= 0) return undefined;
	const bytes = outputByteCount(result);
	const endLine = Math.min(totalLines, startLine + lines - 1);
	if (result.lastLinePartial) {
		const partialLine = endLine;
		return {
			kind: "partial-line",
			content: result.content,
			lines: 1,
			bytes,
			origin: { startLine: partialLine, endLine: partialLine },
			sourceLineBytes: lastSourceLineBytes(sourceContent),
			lastLinePartial: true,
		};
	}
	return {
		kind: "lines",
		content: result.content,
		lines,
		bytes,
		origin: { startLine, endLine },
		lastLinePartial: false,
	};
}

function withMiddleWindowReason(windows: ReadWindow, truncatedBy: "lines" | "bytes" | "middle"): ReadWindow {
	Object.defineProperty(windows, "truncatedBy", { value: truncatedBy, enumerable: false });
	return windows;
}

function fullReadWindow(
	content: string,
	totalLines: number,
	totalBytes: number,
	overlap: ReadWindow["overlap"] = "disjoint",
): ReadWindow {
	return {
		kind: "full",
		head: {
			kind: "lines",
			content,
			lines: totalLines,
			bytes: totalBytes,
			origin: { startLine: 1, endLine: totalLines },
			lastLinePartial: false,
		},
		overlap,
		elidedLines: 0,
		elidedBytes: 0,
		totalLines,
		totalBytes,
	};
}

/**
 * Truncate content while exposing the exact retained head/tail windows.
 *
 * The budget split and fallback ordering intentionally mirror truncateMiddle.
 * The overlap classification is performed before resolving an overlap to a
 * full window, so callers can distinguish disjoint, adjacent and overlapping
 * candidate windows even when no marker is needed.
 */
export function truncateMiddleWindows(content: string, options: TruncationOptions = {}): ReadWindow {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const headBytes = options.maxHeadBytes ?? Math.floor(maxBytes / 2);
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const headLines = options.maxHeadLines ?? Math.max(1, Math.floor(maxLines / 2));
	const tailLines = Math.max(0, maxLines - headLines);

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;
	if (totalBytes <= maxBytes && totalLines <= maxLines) return fullReadWindow(content, totalLines, totalBytes);

	const oneSided = (kind: "head-only" | "tail-only", result: TruncationResult, startLine: number): ReadWindow => {
		const lines = outputLineCount(result);
		const bytes = outputByteCount(result);
		const segment = makeReadSegment(result, startLine, totalLines, content);

		const windows: ReadWindow = {
			kind,
			...(kind === "head-only" ? (segment ? { head: segment } : {}) : segment ? { tail: segment } : {}),
			overlap: "disjoint",
			elidedLines: Math.max(0, totalLines - lines),
			elidedBytes: Math.max(0, totalBytes - bytes),
			totalLines,
			totalBytes,
		};
		return withMiddleWindowReason(windows, result.truncatedBy === "lines" ? "lines" : "bytes");
	};

	// Keep this order identical to truncateMiddle: degenerate budgets are
	// resolved before either one-sided truncator is called.
	if (headBytes <= 0 || headLines <= 0) {
		const tail = truncateTail(content, { maxBytes: tailBytes || maxBytes, maxLines: tailLines || maxLines });
		return oneSided("tail-only", tail, totalLines - outputLineCount(tail) + 1);
	}
	if (tailBytes <= 0 || tailLines <= 0) {
		const head = truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
		return oneSided("head-only", head, 1);
	}

	const head = truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	const tail = truncateTail(content, { maxBytes: tailBytes, maxLines: tailLines });
	const headLinesKept = outputLineCount(head);
	const tailLinesKept = outputLineCount(tail);
	const headBytesKept = outputByteCount(head);
	const tailBytesKept = outputByteCount(tail);

	// Head unusable (first line exceeds budget) → tail-only.
	if (headLinesKept === 0 || head.firstLineExceedsLimit) {
		return oneSided("tail-only", tail, totalLines - tailLinesKept + 1);
	}
	// Tail unusable → head-only.
	if (tailLinesKept === 0) return oneSided("head-only", head, 1);

	const headEnd = headLinesKept;
	const tailStart = totalLines - tailLinesKept + 1;
	const overlap: ReadWindow["overlap"] =
		headEnd + 1 < tailStart ? "disjoint" : headEnd + 1 === tailStart ? "adjacent" : "overlapping";
	const tailPartial = tail.lastLinePartial === true;

	// Adjacent/overlapping complete windows cover the whole source. Return one
	// full segment so renderers never insert a marker for an overlap.
	if (headLinesKept + tailLinesKept >= totalLines && !tailPartial) {
		return fullReadWindow(content, totalLines, totalBytes, overlap);
	}

	const headWindow = makeReadSegment(head, 1, totalLines, content);
	const tailWindow = makeReadSegment(tail, tailStart, totalLines, content);
	if (!headWindow || !tailWindow) return fullReadWindow(content, totalLines, totalBytes, overlap);

	const partialSourceBytes = tailWindow.kind === "partial-line" ? tailWindow.sourceLineBytes : tailWindow.bytes;
	const elidedLines = tailPartial
		? Math.max(0, tailStart - headEnd - 1)
		: Math.max(0, totalLines - headLinesKept - tailLinesKept);
	const elidedBytes = tailPartial
		? Math.max(0, totalBytes - headBytesKept - partialSourceBytes)
		: Math.max(0, totalBytes - headBytesKept - tailBytesKept);
	return withMiddleWindowReason(
		{
			kind: "middle",
			head: headWindow,
			tail: tailWindow,
			overlap,
			elidedLines,
			elidedBytes,
			totalLines,
			totalBytes,
		},
		"middle",
	);
}

/**
 * Truncate content keeping a head window and a tail window, eliding the middle.
 * The composed return shape remains field-for-field compatible with the
 * historical implementation; callers that need coordinates use
 * truncateMiddleWindows directly.
 */
export function truncateMiddle(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const headBytes = options.maxHeadBytes ?? Math.floor(maxBytes / 2);
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const headLines = options.maxHeadLines ?? Math.max(1, Math.floor(maxLines / 2));
	const tailLines = Math.max(0, maxLines - headLines);
	const windows = truncateMiddleWindows(content, options);

	switch (windows.kind) {
		case "full":
			return noTruncResult(content, windows.totalLines, windows.totalBytes);
		case "tail-only":
			return truncateTail(content, { maxBytes: tailBytes || maxBytes, maxLines: tailLines || maxLines });
		case "head-only":
			return truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
		case "middle": {
			const head = windows.head;
			const tail = windows.tail;
			if (!head || !tail) return noTruncResult(content, windows.totalLines, windows.totalBytes);
			if (head.lines + tail.lines >= windows.totalLines)
				return noTruncResult(content, windows.totalLines, windows.totalBytes);
			const legacyElidedLines = Math.max(0, windows.totalLines - head.lines - tail.lines);
			const legacyElidedBytes =
				tail.kind === "partial-line"
					? Math.max(0, windows.totalBytes - head.bytes - tail.bytes)
					: windows.elidedBytes;
			const marker = formatMiddleElisionMarker(legacyElidedLines, legacyElidedBytes);
			const markerBytes = Buffer.byteLength(marker, "utf-8");
			return {
				content: `${head.content}\n${marker}\n${tail.content}`,
				truncated: true,
				truncatedBy: "middle",
				totalLines: windows.totalLines,
				totalBytes: windows.totalBytes,
				outputLines: head.lines + tail.lines + 1,
				outputBytes: head.bytes + tail.bytes + markerBytes + 2,
				elidedLines: legacyElidedLines,
				elidedBytes: legacyElidedBytes,
				lastLinePartial: tail.lastLinePartial,
				firstLineExceedsLimit: false,
				...(tail.lastLinePartial ? { lastLineExceedsLimit: true } : {}),
			};
		}
	}
}

/**
 * Dispatch truncation using the caller-facing direction vocabulary.
 */
export function truncateContent(content: string, options: TruncationOptions = {}): TruncationResult {
	switch (options.direction) {
		case "last":
			return truncateTail(content, options);
		case "both":
			return truncateMiddle(content, options);
		default:
			return truncateHead(content, options);
	}
}

// =============================================================================
// TailBuffer — ring-style tail buffer with lazy joining
// =============================================================================

const MAX_PENDING = 10;

export class TailBuffer {
	#pending: string[] = [];
	#pos = 0; // byte count of the currently-held tail (after trims)

	constructor(readonly maxBytes: number) {}

	append(text: string): void {
		if (!text) return;

		const max = this.maxBytes;
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}

		const n = Buffer.byteLength(text, "utf-8");

		// If the incoming chunk alone is >= budget, it fully dominates the tail.
		if (n >= max) {
			const { text: t, bytes } = truncateTailBytes(text, max);
			this.#pending[0] = t;
			this.#pending.length = 1;
			this.#pos = bytes;
			return;
		}

		this.#pos += n;

		if (this.#pending.length === 0) {
			this.#pending[0] = text;
			this.#pending.length = 1;
		} else {
			this.#pending.push(text);
			if (this.#pending.length > MAX_PENDING) this.#compact();
		}

		// Trim when we exceed 2× budget to amortize cost.
		if (this.#pos > max * 2) this.#trimTo(max);
	}

	text(): string {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#flush();
	}

	bytes(): number {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#pos;
	}

	// -- private ---------------------------------------------------------------

	#compact(): void {
		this.#pending[0] = this.#pending.join("");
		this.#pending.length = 1;
	}

	#flush(): string {
		if (this.#pending.length === 0) return "";
		if (this.#pending.length > 1) this.#compact();
		return this.#pending[0];
	}

	#trimTo(max: number): void {
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}
		if (this.#pos <= max) return;

		const joined = this.#flush();
		const { text, bytes } = truncateTailBytes(joined, max);
		this.#pos = bytes;
		this.#pending[0] = text;
		this.#pending.length = 1;
	}
}

// =============================================================================
// OutputSink — line-buffered output with file spill support
// =============================================================================

const ARTIFACT_PUBLISH_MODE = 0o600;
const ARTIFACT_WRITE_HIGH_WATER = 64 * 1024;

type ArtifactByteSink = {
	write(chunk: string | Uint8Array): number;
	settled(): Promise<void> | undefined;
	writeFailed(): boolean;
	end(): Promise<void>;
};

function artifactNoFollowFlag(): number {
	return process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
}

function unlinkStagingIfSame(stagingPath: string, staged: { dev: bigint; ino: bigint }): void {
	try {
		const leftover = fs.lstatSync(stagingPath, { bigint: true });
		if (leftover.isSymbolicLink() || leftover.dev !== staged.dev || leftover.ino !== staged.ino) return;
		fs.unlinkSync(stagingPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Publish a 0600 staging inode onto `destination`.
 * `rename` replaces the directory entry and does not follow a symlink there.
 */
function publishArtifactStaging(stagingPath: string, destination: string, staged: { dev: bigint; ino: bigint }): void {
	let existing: fs.Stats | undefined;
	try {
		existing = fs.lstatSync(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
		throw new Error("artifact destination is not a regular file");
	}
	try {
		fs.renameSync(stagingPath, destination);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM") || !existing) throw error;
		const again = fs.lstatSync(destination);
		if (again.isSymbolicLink() !== existing.isSymbolicLink() || again.ino !== existing.ino) {
			throw new Error("artifact destination changed");
		}
		fs.unlinkSync(destination);
		fs.renameSync(stagingPath, destination);
	}
	const named = fs.lstatSync(destination, { bigint: true });
	if (named.isSymbolicLink() || !named.isFile() || named.dev !== staged.dev || named.ino !== staged.ino) {
		throw new Error("artifact destination changed");
	}
	if (process.platform !== "win32" && (Number(named.mode) & 0o777) !== ARTIFACT_PUBLISH_MODE) {
		throw new Error("artifact mode");
	}
}

class ArtifactStagingSink implements ArtifactByteSink {
	#fd: number | undefined;
	#ended = false;
	#queued = 0;
	#busy = false;
	#pending: Buffer | undefined;
	#pendingLen = 0;
	#tail: Promise<void> = Promise.resolve();
	#writeError: unknown;
	readonly #stagingPath: string;
	readonly #destination: string;
	readonly #inPlace: boolean;

	constructor(fd: number, stagingPath: string, destination: string, inPlace = false) {
		this.#fd = fd;
		this.#stagingPath = stagingPath;
		this.#destination = destination;
		this.#inPlace = inPlace;
	}

	write(chunk: string | Uint8Array): number {
		const fd = this.#fd;
		if (fd === undefined || this.#ended) throw new Error("artifact sink closed");
		if (this.#writeError) throw this.#writeError;
		const incoming = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		if (incoming.length === 0) return 0;
		// Callers that ignore settled() still run. One fs.write stays in flight; the rest share one buffer.
		this.#queued += incoming.length;
		this.#appendPending(incoming);
		this.#schedule(fd);
		return incoming.length;
	}

	settled(): Promise<void> | undefined {
		return this.#queued > ARTIFACT_WRITE_HIGH_WATER ? this.#tail : undefined;
	}

	writeFailed(): boolean {
		return this.#writeError !== undefined;
	}

	#appendPending(incoming: Buffer): void {
		if (this.#pending === undefined || this.#pendingLen === 0) {
			this.#pending = incoming;
			this.#pendingLen = incoming.length;
			return;
		}
		const need = this.#pendingLen + incoming.length;
		if (need > this.#pending.length) {
			const grown = Buffer.allocUnsafe(Math.max(need, this.#pending.length * 2));
			this.#pending.copy(grown, 0, 0, this.#pendingLen);
			this.#pending = grown;
		}
		incoming.copy(this.#pending, this.#pendingLen);
		this.#pendingLen = need;
	}

	#schedule(fd: number): void {
		if (this.#busy) return;
		this.#busy = true;
		this.#tail = this.#tail
			.then(() => this.#drain(fd))
			.finally(() => {
				this.#busy = false;
				const next = this.#fd;
				if (next !== undefined && this.#pendingLen > 0 && !this.#writeError) this.#schedule(next);
			});
	}

	async #drain(fd: number): Promise<void> {
		while (this.#pending && this.#pendingLen > 0 && !this.#writeError) {
			const pending = this.#pending;
			const length = this.#pendingLen;
			const buffer = length === pending.length ? pending : pending.subarray(0, length);
			this.#pending = undefined;
			this.#pendingLen = 0;
			await this.#flush(fd, buffer);
			this.#queued -= length;
		}
	}

	async #flush(fd: number, buffer: Buffer): Promise<void> {
		let offset = 0;
		try {
			while (!this.#writeError && offset < buffer.length) {
				const wrote = await new Promise<number>((resolve, reject) => {
					fs.write(fd, buffer, offset, buffer.length - offset, (error, bytes) =>
						error ? reject(error) : resolve(bytes),
					);
				});
				if (wrote <= 0) throw new Error("artifact write failed");
				offset += wrote;
			}
		} catch (error) {
			this.#writeError ??= error;
		}
	}

	async end(): Promise<void> {
		if (this.#ended) return;
		this.#ended = true;
		while (this.#busy || (this.#pendingLen > 0 && !this.#writeError)) {
			if (!this.#busy && this.#fd !== undefined) this.#schedule(this.#fd);
			const tail = this.#tail;
			await tail;
			if (tail === this.#tail && !this.#busy && (this.#pendingLen === 0 || this.#writeError)) break;
		}
		if (this.#writeError) {
			const failed = this.#fd;
			this.#fd = undefined;
			if (failed !== undefined)
				try {
					fs.closeSync(failed);
				} catch {
					/* keep the write error */
				}
			throw this.#writeError;
		}
		const fd = this.#fd;
		this.#fd = undefined;
		let staged: { dev: bigint; ino: bigint } | undefined;
		let closeError: unknown;
		try {
			if (fd === undefined) return;
			if (process.platform !== "win32") fs.fchmodSync(fd, ARTIFACT_PUBLISH_MODE);
			fs.fsyncSync(fd);
			const stat = fs.fstatSync(fd, { bigint: true });
			if (!stat.isFile()) throw new Error("artifact staging is not a regular file");
			if (process.platform !== "win32" && (Number(stat.mode) & 0o777) !== ARTIFACT_PUBLISH_MODE) {
				throw new Error("artifact mode");
			}
			staged = { dev: stat.dev, ino: stat.ino };
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EBADF") closeError = error;
				}
			}
		}
		if (closeError) throw closeError;
		if (!staged) return;
		if (this.#inPlace) {
			const named = fs.lstatSync(this.#destination, { bigint: true });
			if (named.isSymbolicLink() || !named.isFile() || named.dev !== staged.dev || named.ino !== staged.ino) {
				throw new Error("artifact destination changed");
			}
			if (process.platform !== "win32" && (Number(named.mode) & 0o777) !== ARTIFACT_PUBLISH_MODE) {
				throw new Error("artifact mode");
			}
			return;
		}
		try {
			publishArtifactStaging(this.#stagingPath, this.#destination, staged);
		} catch (error) {
			unlinkStagingIfSame(this.#stagingPath, staged);
			throw error;
		}
	}
}

function openExistingArtifactNoCreate(destination: string, createError: NodeJS.ErrnoException): ArtifactStagingSink {
	let existing: fs.BigIntStats;
	try {
		existing = fs.lstatSync(destination, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw createError;
		throw error;
	}
	// A missing write bit on the parent blocks create and rename. An existing regular file can still be opened.
	if (existing.isSymbolicLink() || !existing.isFile()) {
		throw new Error("artifact destination is not a regular file");
	}
	const flags = fs.constants.O_WRONLY | artifactNoFollowFlag();
	const fd = fs.openSync(destination, flags);
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.dev !== existing.dev || opened.ino !== existing.ino) {
			throw new Error("artifact destination changed");
		}
		if (process.platform !== "win32") {
			fs.fchmodSync(fd, ARTIFACT_PUBLISH_MODE);
			if ((Number(fs.fstatSync(fd).mode) & 0o777) !== ARTIFACT_PUBLISH_MODE) throw new Error("artifact mode");
		}
		fs.ftruncateSync(fd, 0);
		return new ArtifactStagingSink(fd, destination, destination, true);
	} catch (error) {
		try {
			fs.closeSync(fd);
		} catch {
			// The original open error is the one callers record.
		}
		throw error;
	}
}

function openArtifactStaging(destination: string): ArtifactStagingSink {
	const stagingPath = path.join(path.dirname(destination), `.${randomUUID()}.staging`);
	const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | artifactNoFollowFlag();
	let fd: number;
	try {
		fd = fs.openSync(stagingPath, flags, ARTIFACT_PUBLISH_MODE);
	} catch (error) {
		const denied = error as NodeJS.ErrnoException;
		if (denied.code === "EACCES" || denied.code === "EPERM") return openExistingArtifactNoCreate(destination, denied);
		throw error;
	}
	try {
		if (process.platform !== "win32") fs.fchmodSync(fd, ARTIFACT_PUBLISH_MODE);
		return new ArtifactStagingSink(fd, stagingPath, destination);
	} catch (error) {
		try {
			fs.closeSync(fd);
		} catch {
			// The original open error is the one callers record.
		}
		try {
			if (!fs.lstatSync(stagingPath).isSymbolicLink()) fs.unlinkSync(stagingPath);
		} catch {
			// Staging is already gone.
		}
		throw error;
	}
}

export class OutputSink {
	#buffer = "";
	#bufferBytes = 0;
	#head = "";
	#headBytes = 0;
	#headRetentionDisabled = false;
	#totalLines = 0; // newline count
	#totalBytes = 0;
	#processedBytes = 0;
	#processedLines = 0; // newline count after sanitize/column-cap
	#sawData = false;
	#truncated = false;
	#lastChunkTime = 0;
	#artifactBytes = 0;
	#artifactTruncatedBytes = 0;
	#artifactTruncationNoticeWritten = false;
	#artifactFailureDiagnostic?: string;
	#publishedArtifactId?: string;
	#artifactFinalizationFailed = false;

	// Per-line column cap streaming state (persists across `push` calls so a
	// long line split across chunks still trips the same trigger).
	#currentLineBytes = 0;
	#columnEllipsisAdded = false;
	#columnDroppedBytes = 0;
	#columnTruncatedLines = 0;
	/** Plain secrets captured when this sink is built inside an active redaction scope. */
	readonly #plainSecrets?: readonly string[];
	readonly #plainSecretContextChars: number;
	/** Text already retained for the open line. A later chunk may shorten it. */
	#columnLine = "";
	/** Bounded suffix of prior uncapped output, preserved for multiline secrets. */
	#columnLineContext = "";
	#file?: {
		path: string;
		artifactId?: string;
		sink: ArtifactByteSink;
	};

	// Raw prefix chunks not yet confirmed written to the file sink. This queue is
	// the pathname-backed artifact replay source; retained head/tail windows are lossy views.
	#pendingFileWrites?: string[];
	#pendingFileWriteBytes = 0;
	// Raw chunks retained for a terminal publisher. This queue is capped by
	// `#artifactMaxBytes` and is never used by pathname-backed sinks.
	#pendingArtifactContent?: string[];
	#artifactPublishAttempted = false;
	#finalized = false;

	#fileReady = false;

	readonly #artifactPath?: string;
	readonly #artifactId?: string;
	readonly #spillThreshold: number;
	readonly #headLimit: number;
	readonly #onChunk?: (chunk: string) => void;
	readonly #onRawChunk?: (chunk: string) => void;
	readonly #chunkThrottleMs: number;
	readonly #maxColumns: number;
	readonly #artifactMaxBytes: number;
	readonly #artifactPublisher?: TerminalArtifactPublisher;
	readonly #coalesceSanitize: boolean;
	#coalesceBuf = "";

	constructor(options?: OutputSinkOptions) {
		const {
			artifactPath,
			artifactId,
			spillThreshold = DEFAULT_MAX_BYTES,
			headBytes = 0,
			maxColumns = 0,
			onChunk,
			chunkThrottleMs = 0,
			onRawChunk,
			artifactMaxBytes = DEFAULT_ARTIFACT_MAX_BYTES,
			artifactPublisher,
			coalesceSanitize = process.env.PI_OUTPUT_SANITIZE_COALESCE === "1",
		} = options ?? {};
		// Managed callers omit artifactPath at the allocation boundary; explicit callers
		// retain the existing pathname-backed streaming contract.
		this.#artifactPath = artifactPath;
		this.#artifactId = artifactId;
		this.#spillThreshold = spillThreshold;
		this.#headLimit = Math.max(0, headBytes);
		this.#maxColumns = Math.max(0, maxColumns);
		this.#onChunk = onChunk;
		this.#onRawChunk = onRawChunk;
		this.#chunkThrottleMs = chunkThrottleMs;
		this.#artifactMaxBytes = Math.max(0, artifactMaxBytes);
		this.#artifactPublisher = artifactPublisher;
		this.#coalesceSanitize = coalesceSanitize;
		this.#plainSecrets = activePlainSecrets();
		this.#plainSecretContextChars = this.#plainSecrets?.reduce((max, secret) => Math.max(max, secret.length), 0) ?? 0;
	}

	#headText(): string {
		return this.#head;
	}

	#tailText(): string {
		return this.#buffer;
	}

	#setTail(text: string, bytes = Buffer.byteLength(text, "utf-8")): void {
		this.#buffer = text;
		this.#bufferBytes = bytes;
	}

	#appendTail(text: string, bytes: number): void {
		this.#buffer += text;
		this.#bufferBytes += bytes;
	}

	#appendHead(text: string, bytes: number): void {
		this.#head += text;
		this.#headBytes += bytes;
	}

	#trimTailTo(maxBytes: number): void {
		if (this.#bufferBytes <= maxBytes) return;
		const { text, bytes } = truncateTailBytes(this.#buffer, maxBytes);
		this.#buffer = text;
		this.#bufferBytes = bytes;
	}

	/**
	 * Push a chunk of output. Raw bytes are mirrored to artifacts, while the
	 * visible retention windows are selected from the sanitized/column-capped
	 * stream so production-default display matches the historical processed view.
	 */
	// F21: with coalescing enabled, accumulate raw chunks and process them in batches; the default
	// (disabled) path calls #ingest directly and is byte-identical to the historical per-chunk path.
	push(chunk: string): void | Promise<void> {
		if (!this.#coalesceSanitize) this.#ingest(chunk);
		else {
			this.#coalesceBuf += chunk;
			if (this.#coalesceBuf.length >= COALESCE_FLUSH_CHARS) this.#flushCoalesced();
		}
		return this.#file?.sink.settled();
	}

	/** Process any buffered coalesced chunks as a single batch (F21). */
	#flushCoalesced(): void {
		if (this.#coalesceBuf.length === 0) return;
		const batch = this.#coalesceBuf;
		this.#coalesceBuf = "";
		this.#ingest(batch);
	}

	#ingest(chunk: string): void {
		const rawChunk = chunk;

		// Live callbacks historically observe sanitized, uncapped chunks. The same
		// sanitized text is also the input to visible accounting/retention.
		const sanitizedChunk = sanitizeOutputChunk(rawChunk);

		if (this.#onRawChunk && sanitizedChunk.length > 0) {
			this.#onRawChunk(sanitizedChunk);
		}

		if (this.#onChunk) {
			const now = Date.now();
			if (now - this.#lastChunkTime >= this.#chunkThrottleMs) {
				this.#lastChunkTime = now;
				this.#onChunk(sanitizedChunk);
			}
		}

		const rawBytes = Buffer.byteLength(rawChunk, "utf-8");
		this.#totalBytes += rawBytes;

		if (rawChunk.length > 0) {
			this.#sawData = true;
			this.#totalLines += countNewlines(rawChunk);
		}

		// Mirror the original, unsanitized/uncapped bytes. Until the artifact sink is
		// open, keep an independent raw replay prefix because retained head/tail
		// windows are trimmed and cannot reconstruct byte-correct artifacts.
		if (this.#artifactPath && this.#maxColumns === 0) this.#enqueueFileWrite(rawChunk, rawBytes);
		else if (this.#artifactPublisher && this.#maxColumns === 0)
			this.#enqueueTerminalArtifactChunk(rawChunk, rawBytes);

		if (rawBytes === 0) return;

		if (this.#artifactPath && this.#maxColumns > 0) this.#enqueueFileWrite(rawChunk, rawBytes);
		else if (this.#artifactPublisher && this.#maxColumns > 0) this.#enqueueTerminalArtifactChunk(rawChunk, rawBytes);

		if (this.#maxColumns > 0) {
			if (this.#plainSecrets) {
				// Secret-aware cuts can retract text from an earlier line, so retain
				// each line before processing the next one.
				let cursor = 0;
				while (cursor < sanitizedChunk.length) {
					const newline = sanitizedChunk.indexOf(NL, cursor);
					const end = newline === -1 ? sanitizedChunk.length : newline + 1;
					this.#retainVisible(this.#applyColumnCap(sanitizedChunk.slice(cursor, end)));
					cursor = end;
				}
			} else {
				// Batch ordinary output while bounding #applyColumnCap's temporary
				// parts/join allocation for large single callbacks. Retaining each
				// line separately repeats accounting millions of times.
				let cursor = 0;
				while (cursor < sanitizedChunk.length) {
					let end = Math.min(cursor + COLUMN_CAP_BATCH_CHARS, sanitizedChunk.length);
					// UTF-8 byte accounting must not observe a surrogate pair as two
					// replacement characters when a batch boundary lands between them.
					if (end < sanitizedChunk.length) {
						const before = sanitizedChunk.charCodeAt(end - 1);
						const after = sanitizedChunk.charCodeAt(end);
						if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
					}
					this.#retainVisible(this.#applyColumnCap(sanitizedChunk.slice(cursor, end)));
					cursor = end;
				}
			}
		} else {
			this.#retainVisible(sanitizedChunk);
		}
		if (this.#columnDroppedBytes > 0) this.#createFileSink();
	}

	#retainVisible(visibleChunk: string): void {
		const visibleBytes = Buffer.byteLength(visibleChunk, "utf-8");
		if (visibleChunk.length > 0) {
			this.#processedBytes += visibleBytes;
			this.#processedLines += countNewlines(visibleChunk);
		}
		if (visibleBytes === 0) return;

		let tailChunk = visibleChunk;
		let tailBytes = visibleBytes;

		if (this.#headLimit > 0 && !this.#headRetentionDisabled && this.#headBytes < this.#headLimit) {
			const room = this.#headLimit - this.#headBytes;
			if (visibleBytes <= room) {
				this.#appendHead(visibleChunk, visibleBytes);
				return;
			}
			const headSlice = truncateHeadBytes(visibleChunk, room);
			this.#headRetentionDisabled = true;
			if (headSlice.bytes > 0) {
				this.#appendHead(headSlice.text, headSlice.bytes);
				tailChunk = visibleChunk.substring(headSlice.text.length);
				tailBytes = visibleBytes - headSlice.bytes;
			}
		}

		this.#pushTail(tailChunk, tailBytes);
	}

	/**
	 * Apply the per-line byte cap to `chunk`, dropping bytes that would push the
	 * current line beyond `#maxColumns`. Emits a single `…` once a line trips the
	 * cap; subsequent bytes are skipped until the next `\n`. State persists
	 * across calls so a long line split across chunks still produces one marker.
	 */

	#applyColumnCap(chunk: string): string {
		if (chunk.length === 0) return chunk;
		const max = this.#maxColumns;
		const parts: string[] = [];
		let cursor = 0;
		while (cursor < chunk.length) {
			const nlIdx = chunk.indexOf(NL, cursor);
			const segEnd = nlIdx === -1 ? chunk.length : nlIdx;
			if (segEnd > cursor) {
				const segment = chunk.substring(cursor, segEnd);
				const segBytes = Buffer.byteLength(segment, "utf-8");
				if (this.#columnEllipsisAdded) {
					// Past the cap; drop until newline.
					this.#columnDroppedBytes += segBytes;
				} else {
					const remaining = max - this.#currentLineBytes;
					if (segBytes <= remaining) {
						parts.push(segment);
						this.#currentLineBytes += segBytes;
						if (this.#plainSecrets) this.#columnLine += segment;
					} else {
						// First overflow on this line: keep what fits, append ellipsis,
						// arm the skip-until-newline flag. With secrets, do not emit a
						// kept-head suffix that is still a prefix of a plain secret, and
						// do not end inside one the whole-string obfuscator must see whole.
						const ellipsisBytes = 3; // "…" in UTF-8
						const headRoom = Math.max(0, remaining - ellipsisBytes);
						let keptBytes = 0;
						let keptText = "";
						if (headRoom > 0) {
							const sliced = truncateHeadBytes(segment, headRoom);
							keptText = sliced.text;
							keptBytes = sliced.bytes;
						}
						const secrets = this.#plainSecrets;
						let lineBytesReset = false;
						if (secrets && segment.startsWith(keptText)) {
							const prior = this.#columnLine;
							const prefix = this.#columnLineContext + prior;
							const text = prefix + segment;
							const cut = prefix.length + keptText.length;
							let end = cut;
							while (end > 0) {
								const next = Math.min(
									columnHeadEndOutsideSecrets(text, end, secrets),
									columnHeadEndBeforeOpenPrefix(text, end, secrets),
								);
								if (next >= end) break;
								end = next;
							}
							if (end < cut) {
								if (end < prefix.length) {
									this.#retractColumnSuffix(prefix.slice(end));
									if (end < this.#columnLineContext.length) {
										this.#columnLineContext = this.#columnLineContext.slice(0, end);
										this.#columnLine = "";
									} else {
										this.#columnLine = prior.slice(0, end - this.#columnLineContext.length);
									}
									keptText = "";
									keptBytes = 0;
								} else {
									keptText = segment.slice(0, end - prefix.length);
									keptBytes = Buffer.byteLength(keptText, "utf-8");
									this.#columnLine = prior + keptText;
								}
								// columnLine already includes the bytes kept from this segment.
								this.#currentLineBytes = Buffer.byteLength(this.#columnLine, "utf-8");
								lineBytesReset = true;
							} else {
								this.#columnLine = prior + keptText;
							}
						}
						if (keptText.length > 0) parts.push(keptText);
						parts.push(ELLIPSIS);
						this.#columnDroppedBytes += segBytes - keptBytes;
						this.#columnTruncatedLines++;
						this.#currentLineBytes += (lineBytesReset ? 0 : keptBytes) + ellipsisBytes;
						this.#columnEllipsisAdded = true;
					}
				}
			}
			if (nlIdx === -1) break;
			parts.push(NL);
			if (this.#plainSecretContextChars > 0 && !this.#columnEllipsisAdded) {
				const context = this.#columnLineContext + this.#columnLine + NL;
				this.#columnLineContext = context.slice(-this.#plainSecretContextChars);
			} else {
				this.#columnLineContext = "";
			}
			this.#currentLineBytes = 0;
			this.#columnEllipsisAdded = false;
			this.#columnLine = "";
			cursor = nlIdx + 1;
		}
		return parts.join("");
	}

	/** Remove a suffix of previously retained output after a secret-aware cut-back. */
	#retractColumnSuffix(suffix: string): void {
		if (suffix.length === 0) return;
		const bytes = Buffer.byteLength(suffix, "utf-8");
		const startByte = Math.max(0, this.#processedBytes - bytes);
		const tailStartByte = Math.max(0, this.#processedBytes - this.#bufferBytes);
		const keptTailBytes = Math.max(0, Math.min(this.#bufferBytes, startByte - tailStartByte));
		if (keptTailBytes < this.#bufferBytes) {
			const nextTail = truncateHeadBytes(this.#buffer, keptTailBytes);
			this.#setTail(nextTail.text, nextTail.bytes);
		}
		if (startByte < this.#headBytes) {
			const nextHead = truncateHeadBytes(this.#head, startByte);
			this.#head = nextHead.text;
			this.#headBytes = nextHead.bytes;
		}
		this.#processedBytes = Math.max(0, this.#processedBytes - bytes);
		this.#processedLines = Math.max(0, this.#processedLines - countNewlines(suffix));
		this.#columnDroppedBytes += bytes;
	}

	#retainedSummary(text: string): { text: string; bytes: number; lines: number } {
		return { text, bytes: Buffer.byteLength(text, "utf-8"), lines: text.length > 0 ? countNewlines(text) : 0 };
	}

	#willOverflow(dataBytes: number): boolean {
		// Triggers file mirroring as soon as the next chunk would push us over
		// the tail budget (head retention does not change spill-to-artifact).
		return this.#bufferBytes + dataBytes > this.#spillThreshold;
	}

	#pushTail(chunk: string, dataBytes: number): void {
		if (dataBytes === 0) return;

		const threshold = this.#spillThreshold;
		const willOverflow = this.#bufferBytes + dataBytes > threshold;

		if (!willOverflow) {
			this.#appendTail(chunk, dataBytes);
			return;
		}

		// Overflow: keep only a tail window in memory.
		this.#truncated = true;

		// Avoid creating a giant intermediate string when chunk alone dominates.
		if (dataBytes >= threshold) {
			const { text, bytes } = truncateTailBytes(chunk, threshold);
			this.#setTail(text, bytes);
		} else {
			// Intermediate size is bounded (<= threshold + dataBytes), safe to concat.
			this.#appendTail(chunk, dataBytes);
			this.#trimTailTo(threshold);
		}
	}

	#artifactTruncationNotice(droppedBytes: number): string {
		return `\n[artifact truncated after ${this.#artifactBytes} bytes; omitted at least ${droppedBytes} bytes]\n`;
	}

	#recordArtifactFailure(phase: "create" | "write" | "end", error: unknown): void {
		if (this.#artifactFailureDiagnostic) return;
		const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
		const normalized = message || "unknown storage error";
		this.#artifactFailureDiagnostic = truncateHeadBytes(
			`${phase}: ${normalized}`,
			ARTIFACT_WRITER_DIAGNOSTIC_MAX_BYTES,
		).text;
	}

	#recordTerminalArtifactDiagnostic(kind: "unavailable" | "failed", error?: unknown): void {
		if (this.#artifactFailureDiagnostic) return;
		const message =
			error === undefined
				? "terminal artifact publisher unavailable"
				: (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim() ||
					"unknown publication error";
		this.#artifactFailureDiagnostic = truncateHeadBytes(
			`${kind}: ${message}`,
			ARTIFACT_WRITER_DIAGNOSTIC_MAX_BYTES,
		).text;
	}

	// A failed write may have committed only a prefix, so the replay queue is no longer trustworthy.
	#failArtifact(phase: "create" | "write" | "end", error: unknown, sink?: ArtifactByteSink): void {
		this.#recordArtifactFailure(phase, error);
		this.#artifactFinalizationFailed = true;
		this.#file = undefined;
		this.#fileReady = false;
		this.#pendingFileWrites = undefined;
		this.#pendingFileWriteBytes = 0;
		if (!sink) return;
		try {
			void Promise.resolve(sink.end()).catch(endError => this.#recordArtifactFailure("end", endError));
		} catch (endError) {
			this.#recordArtifactFailure("end", endError);
		}
	}

	#capArtifactChunk(chunk: string, bytes: number): { chunk: string; bytes: number } | null {
		if (bytes === 0) return null;
		if (this.#artifactMaxBytes <= 0 || this.#artifactBytes >= this.#artifactMaxBytes) {
			this.#artifactTruncatedBytes += bytes;
			return null;
		}
		const room = this.#artifactMaxBytes - this.#artifactBytes;
		if (bytes <= room) {
			return { chunk, bytes };
		}
		const kept = truncateHeadBytes(chunk, room);
		this.#artifactTruncatedBytes += bytes - kept.bytes;
		return kept.bytes > 0 ? { chunk: kept.text, bytes: kept.bytes } : null;
	}

	async #writeArtifactTruncationNotice(): Promise<void> {
		if (
			this.#artifactFinalizationFailed ||
			this.#artifactTruncatedBytes <= 0 ||
			this.#artifactTruncationNoticeWritten
		)
			return;
		const notice = this.#artifactTruncationNotice(this.#artifactTruncatedBytes);
		try {
			if (this.#fileReady && this.#file) {
				await this.#file.sink.write(notice);
			} else {
				this.#queuePendingFileWrite(notice, Buffer.byteLength(notice, "utf-8"));
			}
			this.#artifactTruncationNoticeWritten = true;
		} catch (error) {
			this.#failArtifact("write", error, this.#file?.sink);
		}
	}

	#queuePendingFileWrite(chunk: string, bytes = Buffer.byteLength(chunk, "utf-8")): void {
		if (!this.#pendingFileWrites) this.#pendingFileWrites = [chunk];
		else this.#pendingFileWrites.push(chunk);

		this.#pendingFileWriteBytes += bytes;
	}

	#enqueueFileWrite(chunk: string, bytes: number): void {
		if (this.#artifactFinalizationFailed || this.#finalized) return;
		const capped = this.#capArtifactChunk(chunk, bytes);
		if (!capped) return;
		this.#artifactBytes += capped.bytes;
		if (!this.#fileReady || !this.#file) {
			this.#queuePendingFileWrite(capped.chunk, capped.bytes);
			if (this.#willOverflow(bytes) || this.#pendingFileWriteBytes > this.#spillThreshold) this.#createFileSink();
			return;
		}

		try {
			this.#file.sink.write(capped.chunk);
		} catch (error) {
			this.#failArtifact("write", error, this.#file.sink);
		}
	}

	#enqueueTerminalArtifactChunk(chunk: string, bytes: number): void {
		if (this.#artifactFinalizationFailed || this.#finalized) return;
		const capped = this.#capArtifactChunk(chunk, bytes);
		if (!capped) return;
		this.#artifactBytes += capped.bytes;
		if (!this.#pendingArtifactContent) this.#pendingArtifactContent = [capped.chunk];
		else this.#pendingArtifactContent.push(capped.chunk);
		const pending = this.#pendingArtifactContent;
		if (!pending) return;
		if (pending.length > MAX_PENDING) {
			pending[0] = pending.join("");
			pending.length = 1;
		}
	}

	#createFileSink(): boolean {
		if (this.#finalized || this.#artifactFinalizationFailed) return false;

		if (!this.#artifactPath) return false;
		if (this.#fileReady) return this.#file != null;

		let sink: ArtifactByteSink;
		try {
			sink = openArtifactStaging(this.#artifactPath);
		} catch (error) {
			this.#recordArtifactFailure("create", error);
			return false;
		}
		this.#file = { path: this.#artifactPath, artifactId: this.#artifactId, sink };

		try {
			const pending = this.#pendingFileWrites;
			if (pending && pending.length > 0) sink.write(pending.join(""));
		} catch (error) {
			this.#failArtifact("write", error, sink);
			return false;
		}

		this.#fileReady = true;
		this.#pendingFileWrites = undefined;
		this.#pendingFileWriteBytes = 0;
		return true;
	}

	#shouldPublishTerminalArtifact(): boolean {
		return (
			this.#artifactPublisher !== undefined &&
			this.#artifactPath === undefined &&
			(this.#truncated || this.#columnDroppedBytes > 0 || this.#artifactTruncatedBytes > 0)
		);
	}

	async #publishTerminalArtifact(): Promise<string | undefined> {
		if (
			!this.#shouldPublishTerminalArtifact() ||
			this.#artifactPublishAttempted ||
			this.#artifactFinalizationFailed
		) {
			return this.#publishedArtifactId;
		}
		this.#artifactPublishAttempted = true;
		const content = this.#pendingArtifactContent?.join("") ?? "";
		const omittedBytes = this.#artifactTruncatedBytes;
		try {
			const published = await this.#artifactPublisher!(content, {
				totalBytes: this.#totalBytes,
				omittedBytes,
			});
			if (published.status === "unavailable") {
				this.#recordTerminalArtifactDiagnostic("unavailable");
				this.#artifactFinalizationFailed = true;
				return undefined;
			}
			if (published.status === "failed") {
				this.#recordTerminalArtifactDiagnostic("failed", published.diagnostic);
				this.#artifactFinalizationFailed = true;
				return undefined;
			}
			if (published.artifactId.length === 0) {
				this.#recordTerminalArtifactDiagnostic("failed", "storage returned no artifact id");
				this.#artifactFinalizationFailed = true;
				return undefined;
			}
			if (published.omittedBytes !== undefined) {
				if (!Number.isSafeInteger(published.omittedBytes) || published.omittedBytes < 0) {
					this.#recordTerminalArtifactDiagnostic("failed", "publisher returned invalid omitted-byte accounting");
					this.#artifactFinalizationFailed = true;
					return undefined;
				}
				this.#artifactTruncatedBytes += published.omittedBytes;
			}
			this.#publishedArtifactId = published.artifactId;
			this.#finalized = true;
			return this.#publishedArtifactId;
		} catch (error) {
			this.#recordTerminalArtifactDiagnostic("failed", error);
			this.#artifactFinalizationFailed = true;
			return undefined;
		} finally {
			this.#pendingArtifactContent = undefined;
		}
	}

	createInput(): WritableStream<Uint8Array | string> {
		const dec = new TextDecoder("utf-8", { ignoreBOM: true });
		const finalize = () => {
			this.push(dec.decode());
		};
		return new WritableStream({
			write: chunk => this.push(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true })),
			close: finalize,
			abort: finalize,
		});
	}

	/**
	 * Replace the in-memory buffer with the given text. Used when an upstream
	 * minimizer rewrites the captured output after the raw bytes have already
	 * been streamed.
	 *
	 * After this call the replacement is authoritative: counters reflect its full
	 * size, the configured head+tail byte windows are retained with UTF-8-safe
	 * boundaries, and future head accumulation is disabled so later `push()` calls
	 * append directly to the tail without reordering the replacement.
	 */
	replace(text: string): void {
		this.#coalesceBuf = "";
		this.#columnLine = "";
		this.#columnLineContext = "";
		const replacementBytes = Buffer.byteLength(text, "utf-8");
		this.#head = "";
		this.#headBytes = 0;
		this.#setTail("");

		if (this.#headLimit > 0) {
			const head = truncateHeadBytes(text, this.#headLimit);
			this.#appendHead(head.text, head.bytes);
			const tailText = text.substring(head.text.length);
			this.#setTail(tailText, replacementBytes - head.bytes);
		} else {
			this.#setTail(text, replacementBytes);
		}
		this.#trimTailTo(this.#spillThreshold);
		this.#headRetentionDisabled = true;
		this.#totalBytes = replacementBytes;
		this.#processedBytes = replacementBytes;
		this.#totalLines = countNewlines(text);
		this.#processedLines = this.#totalLines;
		this.#sawData = text.length > 0;
		this.#truncated = replacementBytes > this.#headBytes + this.#bufferBytes;
		this.#currentLineBytes = 0;
		this.#columnEllipsisAdded = false;
		this.#columnDroppedBytes = 0;
		this.#columnTruncatedLines = 0;
	}

	async dump(notice?: string): Promise<OutputSummary> {
		this.#flushCoalesced();
		const noticeLine = notice ? `[${notice}]\n` : "";
		const totalLines = this.#sawData ? this.#totalLines + 1 : 0;

		let artifactId: string | undefined;
		if (this.#finalized) {
			artifactId = this.#publishedArtifactId ?? this.#artifactId;
		} else if (!this.#artifactFinalizationFailed) {
			if (this.#artifactPublisher && !this.#artifactPath) {
				artifactId = await this.#publishTerminalArtifact();
			}
			if (!this.#artifactFinalizationFailed && this.#artifactPath) {
				if (this.#artifactTruncatedBytes > 0) this.#createFileSink();
				await this.#writeArtifactTruncationNotice();
				if (this.#file) {
					try {
						await this.#file.sink.end();
						artifactId = this.#file.artifactId;
						this.#finalized = true;
					} catch (error) {
						this.#recordArtifactFailure(this.#file.sink.writeFailed() ? "write" : "end", error);
						this.#artifactFinalizationFailed = true;
						this.#file = undefined;
						this.#fileReady = false;
					}
				}
			}
		}
		if (this.#finalized) {
			// Terminal: the artifact is closed; replay state is no longer needed.
			this.#pendingFileWrites = undefined;
			this.#pendingFileWriteBytes = 0;
			this.#fileReady = false;
			this.#pendingArtifactContent = undefined;
		}
		// Non-finalized dumps (no artifact sink ever opened) keep the raw replay
		// queue so a later post-dump push that spills produces a CUMULATIVE
		// artifact, matching the cumulative visible summary/counters.

		// Compose the visible output from already-processed retention windows.
		const processedTotalLines = this.#sawData ? this.#processedLines + 1 : 0;
		const headText = this.#headText();
		const head = this.#retainedSummary(headText);

		const headBytes = head.bytes;
		const headLines = head.lines + (headBytes > 0 && !headText.endsWith("\n") ? 1 : 0);
		const tailBuf = this.#tailText();
		const tail = this.#retainedSummary(tailBuf);
		const tailBytes = tail.bytes;
		const tailLines = tailBuf.length > 0 ? tail.lines + 1 : 0;
		const effectiveTotalBytes = this.#processedBytes;

		let body: string;
		let outputBytes: number;
		let outputLines: number;
		let elidedBytes: number | undefined;
		let elidedLines: number | undefined;

		if (headBytes > 0 && effectiveTotalBytes > headBytes + tailBytes) {
			// Middle was elided. Emit both explicit windows, including when they are
			// fragments of one source line (the marker still carries byte evidence).
			elidedBytes = Math.max(0, effectiveTotalBytes - headBytes - tailBytes);
			elidedLines = Math.max(0, processedTotalLines - headLines - tailLines);
			const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
			const markerBytes = Buffer.byteLength(marker, "utf-8");
			const headSep = headText.endsWith("\n") ? "" : "\n";
			const tailSep = tailBuf.startsWith("\n") ? "" : "\n";
			body = `${headText}${headSep}${marker}${tailSep}${tailBuf}`;
			outputBytes = headBytes + markerBytes + tailBytes + headSep.length + tailSep.length;
			outputLines = headLines + 1 + tailLines;
			this.#truncated = true;
		} else if (headBytes > 0) {
			// Head + tail combine into the full buffered output (no overlap or elision).
			body = `${headText}${tailBuf}`;
			outputBytes = headBytes + tailBytes;
			outputLines = body.length > 0 ? countNewlines(body) + 1 : 0;
		} else {
			body = tailBuf;
			outputBytes = tailBytes;
			outputLines = tailLines;
		}

		if (this.#columnDroppedBytes > 0) this.#truncated = true;
		return {
			output: `${noticeLine}${body}`,
			truncated: this.#truncated,
			totalLines,
			totalBytes: this.#totalBytes,
			outputLines,
			outputBytes,
			elidedBytes,
			elidedLines,
			columnDroppedBytes: this.#columnDroppedBytes > 0 ? this.#columnDroppedBytes : undefined,
			columnTruncatedLines: this.#columnTruncatedLines > 0 ? this.#columnTruncatedLines : undefined,
			artifactTruncatedBytes: this.#artifactTruncatedBytes > 0 ? this.#artifactTruncatedBytes : undefined,
			artifactFailureDiagnostic: this.#artifactFailureDiagnostic,
			artifactId,
		};
	}
}

// =============================================================================
// Truncation notice formatting
// =============================================================================

/**
 * Format a truncation notice for tail-truncated output (bash, python, ssh).
 * Returns empty string if not truncated.
 */
export function formatTailTruncationNotice(
	truncation: TruncationResult,
	options: TailTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const { fullOutputPath, originalContent, suffix = "" } = options;
	const startLine = truncation.totalLines - (truncation.outputLines ?? truncation.totalLines) + 1;
	const endLine = truncation.totalLines;
	const fullOutputPart = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

	let notice: string;
	if (truncation.lastLinePartial) {
		let lastLineSizePart = "";
		if (originalContent) {
			const lastNl = originalContent.lastIndexOf(NL);
			const lastLine = lastNl === -1 ? originalContent : originalContent.substring(lastNl + 1);
			lastLineSizePart = ` (line is ${formatBytes(Buffer.byteLength(lastLine, "utf-8"))})`;
		}
		notice = `[Showing last ${formatBytes(truncation.outputBytes ?? truncation.totalBytes)} of line ${endLine}${lastLineSizePart}${fullOutputPart}${suffix}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputPart}${suffix}]`;
	}

	return `\n\n${notice}`;
}

/**
 * Format a truncation notice for head-truncated output (read tool).
 * Returns empty string if not truncated.
 */
export function formatHeadTruncationNotice(
	truncation: TruncationResult,
	options: HeadTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const startLineDisplay = options.startLine ?? 1;
	const totalFileLines = options.totalFileLines ?? truncation.totalLines;
	const endLineDisplay = startLineDisplay + (truncation.outputLines ?? truncation.totalLines) - 1;
	const nextOffset = endLineDisplay + 1;
	const notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use :${nextOffset} to continue]`;
	return `\n\n${notice}`;
}

// =============================================================================
// Streaming tail update helper (shared by bash/ssh tools)
// =============================================================================

/**
 * Build an onChunk handler that appends to a TailBuffer and emits a streaming
 * update (when `onUpdate` is defined) with the buffer's current text.
 */
export function streamTailUpdates<TDetails, TInput = unknown>(
	tailBuffer: TailBuffer,
	onUpdate: AgentToolUpdateCallback<TDetails, TInput> | undefined,
): (chunk: string) => void {
	return chunk => {
		tailBuffer.append(chunk);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: tailBuffer.text() }],
				details: {} as TDetails,
			});
		}
	};
}
