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
	/** Artifact ID for internal URL access (artifact://<id>) when truncated */
	artifactId?: string;
	/** Bytes omitted from artifact storage after the artifact hard cap was reached. */
	artifactTruncatedBytes?: number;
}

export interface OutputSinkOptions {
	artifactPath?: string;
	artifactId?: string;
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
}

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
 * Truncate content keeping a head window and a tail window, eliding the middle.
 *
 * The combined output is `<head>\n<marker>\n<tail>` when truncation is needed.
 * `maxHeadBytes` defaults to `floor(maxBytes / 2)`; the tail receives the
 * remainder. Falls back to `truncateTail` / `truncateHead` if either side's
 * budget is empty or the content already fits.
 */
export function truncateMiddle(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const headBytes = options.maxHeadBytes ?? Math.floor(maxBytes / 2);
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const headLines = options.maxHeadLines ?? Math.max(1, Math.floor(maxLines / 2));
	const tailLines = Math.max(0, maxLines - headLines);

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	// Degenerate budgets → fall back to one-sided truncation.
	if (headBytes <= 0 || headLines <= 0) {
		return truncateTail(content, { maxBytes: tailBytes || maxBytes, maxLines: tailLines || maxLines });
	}
	if (tailBytes <= 0 || tailLines <= 0) {
		return truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	}

	const head = truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	const tail = truncateTail(content, { maxBytes: tailBytes, maxLines: tailLines });

	const headLinesKept = head.outputLines ?? 0;
	const tailLinesKept = tail.outputLines ?? 0;
	const headBytesKept = head.outputBytes ?? Buffer.byteLength(head.content, "utf-8");
	const tailBytesKept = tail.outputBytes ?? Buffer.byteLength(tail.content, "utf-8");

	// Head unusable (first line exceeds budget) → tail-only.
	if (headLinesKept === 0 || head.firstLineExceedsLimit) return tail;
	// Tail unusable → head-only.
	if (tailLinesKept === 0) return head;
	// Windows overlap → no meaningful elision; return content untruncated.
	if (headLinesKept + tailLinesKept >= totalLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	const elidedLines = totalLines - headLinesKept - tailLinesKept;
	// `totalBytes - headBytesKept - tailBytesKept` includes newline separators
	// between the kept windows and the elided region; close enough for a notice.
	const elidedBytes = Math.max(0, totalBytes - headBytesKept - tailBytesKept);
	const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
	const composed = `${head.content}\n${marker}\n${tail.content}`;
	const markerBytes = Buffer.byteLength(marker, "utf-8");

	return {
		content: composed,
		truncated: true,
		truncatedBy: "middle",
		totalLines,
		totalBytes,
		outputLines: headLinesKept + tailLinesKept + 1,
		outputBytes: headBytesKept + tailBytesKept + markerBytes + 2,
		elidedLines,
		elidedBytes,
		lastLinePartial: tail.lastLinePartial,
		firstLineExceedsLimit: false,
	};
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

	// Per-line column cap streaming state (persists across `push` calls so a
	// long line split across chunks still trips the same trigger).
	#currentLineBytes = 0;
	#columnEllipsisAdded = false;
	#columnDroppedBytes = 0;
	#columnTruncatedLines = 0;
	#file?: {
		path: string;
		artifactId?: string;
		sink: Bun.FileSink;
	};

	// Raw prefix chunks not yet confirmed written to the file sink. This queue is
	// the only artifact replay source; retained head/tail windows are lossy views.
	#pendingFileWrites?: string[];
	#pendingFileWriteBytes = 0;
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
			coalesceSanitize = process.env.PI_OUTPUT_SANITIZE_COALESCE === "1",
		} = options ?? {};
		this.#artifactPath = artifactPath;
		this.#artifactId = artifactId;
		this.#spillThreshold = spillThreshold;
		this.#headLimit = Math.max(0, headBytes);
		this.#maxColumns = Math.max(0, maxColumns);
		this.#onChunk = onChunk;
		this.#onRawChunk = onRawChunk;
		this.#chunkThrottleMs = chunkThrottleMs;
		this.#artifactMaxBytes = Math.max(0, artifactMaxBytes);
		this.#coalesceSanitize = coalesceSanitize;
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
	push(chunk: string): void {
		if (!this.#coalesceSanitize) {
			this.#ingest(chunk);
			return;
		}
		this.#coalesceBuf += chunk;
		if (this.#coalesceBuf.length >= COALESCE_FLUSH_CHARS) {
			this.#flushCoalesced();
		}
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

		if (rawBytes === 0) return;

		const visibleChunk = this.#maxColumns > 0 ? this.#applyColumnCap(sanitizedChunk) : sanitizedChunk;
		if (this.#artifactPath && this.#maxColumns > 0) this.#enqueueFileWrite(rawChunk, rawBytes);
		if (this.#columnDroppedBytes > 0) this.#createFileSink();
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
					} else {
						// First overflow on this line: keep what fits, append ellipsis,
						// arm the skip-until-newline flag.
						const ellipsisBytes = 3; // "…" in UTF-8
						const headRoom = Math.max(0, remaining - ellipsisBytes);
						let keptBytes = 0;
						if (headRoom > 0) {
							const sliced = truncateHeadBytes(segment, headRoom);
							keptBytes = sliced.bytes;
							parts.push(sliced.text);
						}
						parts.push(ELLIPSIS);
						this.#columnDroppedBytes += segBytes - keptBytes;
						this.#columnTruncatedLines++;
						this.#currentLineBytes += keptBytes + ellipsisBytes;
						this.#columnEllipsisAdded = true;
					}
				}
			}
			if (nlIdx === -1) break;
			parts.push(NL);
			this.#currentLineBytes = 0;
			this.#columnEllipsisAdded = false;
			cursor = nlIdx + 1;
		}
		return parts.join("");
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

	#writeArtifactTruncationNotice(): void {
		if (this.#artifactTruncatedBytes <= 0 || this.#artifactTruncationNoticeWritten) return;
		const notice = this.#artifactTruncationNotice(this.#artifactTruncatedBytes);
		try {
			if (this.#fileReady && this.#file) {
				this.#file.sink.write(notice);
			} else {
				this.#queuePendingFileWrite(notice, Buffer.byteLength(notice, "utf-8"));
			}
			this.#artifactTruncationNoticeWritten = true;
		} catch {
			/* ignore */
		}
	}

	#queuePendingFileWrite(chunk: string, bytes = Buffer.byteLength(chunk, "utf-8")): void {
		if (!this.#pendingFileWrites) this.#pendingFileWrites = [chunk];
		else this.#pendingFileWrites.push(chunk);

		this.#pendingFileWriteBytes += bytes;
	}

	#enqueueFileWrite(chunk: string, bytes: number): void {
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
		} catch {
			try {
				void this.#file.sink.end();
			} catch {
				/* ignore */
			}
			this.#file = undefined;
			this.#fileReady = false;
			this.#queuePendingFileWrite(capped.chunk, capped.bytes);
			this.#createFileSink();
		}
	}

	#createFileSink(): boolean {
		if (this.#finalized) return false;

		if (!this.#artifactPath) return false;
		if (this.#fileReady) return this.#file != null;
		try {
			const sink = Bun.file(this.#artifactPath).writer();
			this.#file = { path: this.#artifactPath, artifactId: this.#artifactId, sink };

			const pending = this.#pendingFileWrites;
			if (pending) {
				for (const chunk of pending) sink.write(chunk);
			}

			this.#fileReady = true;
			this.#pendingFileWrites = undefined;
			this.#pendingFileWriteBytes = 0;

			return true;
		} catch {
			try {
				void this.#file?.sink?.end();
			} catch {
				/* ignore */
			}
			this.#file = undefined;
			// Keep #pendingFileWriteBytes in sync with the preserved queue so
			// later retry/threshold decisions don't undercount retained bytes.
			this.#pendingFileWriteBytes = this.#pendingFileWrites
				? this.#pendingFileWrites.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0)
				: 0;
			return false;
		}
	}

	createInput(): WritableStream<Uint8Array | string> {
		const dec = new TextDecoder("utf-8", { ignoreBOM: true });
		const finalize = () => {
			this.push(dec.decode());
		};
		return new WritableStream({
			write: chunk => {
				this.push(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }));
			},
			close: finalize,
			abort: finalize,
		});
	}

	/**
	 * Replace the in-memory buffer with the given text. Used when an upstream
	 * minimizer rewrites the captured output after the raw bytes have already
	 * been streamed.
	 *
	 * After this call the buffer is authoritative: streaming counters realign
	 * to the replacement, the retained head window is cleared, and head
	 * retention is disabled so subsequent `push()` calls append directly to the
	 * tail buffer instead of repopulating the (now meaningless) head window
	 * — which would otherwise reorder content and trip the middle-elision
	 * branch in `dump()` against stale totals.
	 */
	replace(text: string): void {
		this.#coalesceBuf = "";
		this.#setTail(text);
		this.#head = "";
		this.#headBytes = 0;
		this.#headRetentionDisabled = true;
		this.#totalBytes = this.#bufferBytes;
		this.#processedBytes = this.#bufferBytes;
		this.#totalLines = countNewlines(text);
		this.#processedLines = this.#totalLines;
		this.#sawData = text.length > 0;
		this.#truncated = false;
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
		if (this.#artifactTruncatedBytes > 0) this.#createFileSink();
		this.#writeArtifactTruncationNotice();
		if (this.#file) {
			artifactId = this.#file.artifactId;
			await this.#file.sink.end();
			this.#finalized = true;
		}
		if (this.#finalized) {
			// Terminal: the artifact is closed; replay state is no longer needed.
			this.#pendingFileWrites = undefined;
			this.#pendingFileWriteBytes = 0;
			this.#fileReady = false;
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
			// Middle was elided. Emit head + marker + tail.
			elidedBytes = Math.max(0, effectiveTotalBytes - headBytes - tailBytes);
			elidedLines = Math.max(0, processedTotalLines - headLines - tailLines);
			if (elidedLines === 0) {
				body = headText;
				outputBytes = headBytes;
				outputLines = headLines;
				this.#truncated = true;
			} else {
				const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
				const markerBytes = Buffer.byteLength(marker, "utf-8");
				const headSep = headText.endsWith("\n") ? "" : "\n";
				const tailSep = tailBuf.startsWith("\n") ? "" : "\n";
				body = `${headText}${headSep}${marker}${tailSep}${tailBuf}`;
				outputBytes = headBytes + markerBytes + tailBytes + headSep.length + tailSep.length;
				outputLines = headLines + 1 + tailLines;
				this.#truncated = true;
			}
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
