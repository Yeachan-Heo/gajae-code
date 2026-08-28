import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { ImageContent, TextContent } from "@gajae-code/ai/core";
import type { SummaryResult } from "@gajae-code/natives";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { getRemoteDir, logger, prompt, readImageMetadata, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { getFileReadCache } from "../edit/file-read-cache";
import { isNotebookPath, readEditableNotebookText } from "../edit/notebook";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";

import { formatHashLine, formatHashLines, formatLineHash, HL_BODY_SEP } from "../hashline/hash";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import type { InternalUrl } from "../internal-urls/types";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import readDescription from "../prompts/tools/read.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { ReadSegment, ReadWindow, TruncationDirection, TruncationResult } from "../session/streaming-output";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatMiddleElisionMarker,
	truncateHead,
	truncateHeadBytes,
	truncateLine,
	truncateMiddleWindows,
	truncateTailBytes,
} from "../session/streaming-output";
import { fileHyperlink, renderCodeCell, renderMarkdownCell, renderStatusLine, tryResolveInternalUrlSync } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { ImageInputTooLargeError, loadImageInput, MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { convertFileWithMarkit } from "../utils/markit";
import { buildDirectoryTree, type DirectoryTree } from "../workspace-tree";
import { type ArchiveReader, openArchive, parseArchivePathCandidates } from "./archive-reader";
import {
	type ConflictEntry,
	type ConflictScope,
	formatConflictSummary,
	formatConflictWarning,
	getConflictHistory,
	parseConflictUri,
	renderConflictRegion,
	scanConflictLines,
	scanFileForConflicts,
} from "./conflict-detect";
import {
	executeReadUrl,
	isReadableUrlPath,
	loadReadUrlCacheEntry,
	parseReadUrlTarget,
	prepareReadUrlSelectorInput,
	type ReadUrlToolDetails,
	renderReadUrlCall,
	renderReadUrlResult,
	wrapUntrustedContent,
} from "./fetch";
import { applyListLimit } from "./list-limit";
import {
	formatFullOutputReference,
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveOutputMaxColumns,
	stripOutputNotice,
} from "./output-meta";
import {
	expandPath,
	formatPathRelativeToCwd,
	resolveReadPath,
	splitInternalUrlSel,
	splitPathAndSel,
} from "./path-utils";
import { type ReadRoute, resolveEffectiveDirection } from "./read-internals";
import { formatBytes, replaceTabs, shortenPath, wrapBrackets } from "./render-utils";
import {
	enforceSqliteQueryOnly,
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTableSchema,
	isSqliteFile,
	listTables,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	queryRows,
	renderRow,
	renderSchema,
	renderTable,
	renderTableList,
	resolveTableRowLookup,
} from "./sqlite-reader";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

type NativeReadBindings = Pick<typeof import("@gajae-code/natives"), "glob" | "summarizeCode">;
let nativeReadBindingsLoad: Promise<NativeReadBindings> | undefined;

async function nativeRead(): Promise<NativeReadBindings> {
	nativeReadBindingsLoad ??= Promise.resolve(require("@gajae-code/natives") as NativeReadBindings);
	return await nativeReadBindingsLoad;
}

// Document types converted to markdown via markit.
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;
const RAW_COLLECTOR_MAX_BYTES = MAX_SUMMARY_BYTES;

const BODY_TRUNCATION_FOOTER_KEY = "__bodyTruncationFooter";

function rememberBodyTruncationFooter(details: ReadToolDetails, footer: string): void {
	Object.defineProperty(details, BODY_TRUNCATION_FOOTER_KEY, { value: footer, configurable: true, enumerable: false });
}

/**
 * Per-line column cap for file reads. Lines wider than the value of
 * `tools.outputMaxColumns` are ellipsis-truncated at display time; the file
 * on disk is unchanged. Shared with the streaming sink path so one setting
 * covers `bash`/`ssh`/`python`/`js eval` and `read` uniformly.
 */
const PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);
// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid hangs
const REMOTE_MOUNT_PREFIX = getRemoteDir() + path.sep;

function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(REMOTE_MOUNT_PREFIX);
}

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatHashLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatHashLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} .. ${tailText.trim()}`;
	if (shouldAddHashLines) {
		const start = formatLineHash(startLine, headText);
		const end = formatLineHash(endLine, tailText);
		return { model: `${start}-${end}${HL_BODY_SEP}${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

function windowSegments(window: ReadWindow): ReadSegment[] {
	return [window.head, window.tail].filter((segment): segment is ReadSegment => segment !== undefined);
}

function windowHasPartialSegment(window: ReadWindow): boolean {
	return windowSegments(window).some(segment => segment.kind === "partial-line");
}

function partialTailOf(window: ReadWindow): Extract<ReadSegment, { kind: "partial-line" }> | undefined {
	const tail = window.tail;
	return tail?.kind === "partial-line" ? tail : undefined;
}

function linesOfSegment(segment: ReadSegment): string[] {
	return segment.content.split("\n");
}

function rebaseWindow(window: ReadWindow, offset: number): ReadWindow {
	const rebaseSegment = (segment: ReadSegment | undefined): ReadSegment | undefined => {
		if (!segment) return undefined;
		return {
			...segment,
			origin: {
				startLine: segment.origin.startLine + offset,
				endLine: segment.origin.endLine + offset,
			},
		};
	};
	const rebased: ReadWindow = {
		...window,
		head: rebaseSegment(window.head),
		tail: rebaseSegment(window.tail),
	};
	for (const key of ["maxBytes", "truncatedBy", "outputLinesOverride", "outputBytesOverride"] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(window, key);
		if (descriptor) Object.defineProperty(rebased, key, descriptor);
	}
	return rebased;
}

function renderReadWindow(
	window: ReadWindow,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
	maxColumns = 0,
): string {
	const renderSegment = (segment: ReadSegment): string => {
		const hash = shouldAddHashLines && segment.kind === "lines";
		const numbers = !hash && shouldAddLineNumbers;
		const renderContent =
			!hash && maxColumns > 0
				? segment.content
						.split("\n")
						.map(line => truncateLine(line, maxColumns).text)
						.join("\n")
				: segment.content;
		return formatTextWithMode(renderContent, segment.origin.startLine, hash, numbers);
	};
	const marker = formatMiddleElisionMarker(window.elidedLines, window.elidedBytes);
	if (window.kind === "full") return window.head ? renderSegment(window.head) : "";
	if (window.kind === "head-only") return window.head ? renderSegment(window.head) : "";
	if (window.kind === "tail-only") return window.tail ? renderSegment(window.tail) : "";
	if (!window.head || !window.tail) return "";
	if (window.elidedLines <= 0) return `${renderSegment(window.head)}\n${renderSegment(window.tail)}`;
	return `${renderSegment(window.head)}\n${marker}\n${renderSegment(window.tail)}`;
}

function windowOutputLines(window: ReadWindow): number {
	if (window.kind === "full") return window.head?.lines ?? 0;
	if (window.kind === "head-only") return window.head?.lines ?? 0;
	if (window.kind === "tail-only") return window.tail?.lines ?? 0;
	return (window.head?.lines ?? 0) + (window.tail?.lines ?? 0) + (window.elidedLines > 0 ? 1 : 0);
}

function windowOutputBytes(window: ReadWindow): number {
	if (window.kind === "full") return window.head?.bytes ?? 0;
	if (window.kind === "head-only") return window.head?.bytes ?? 0;
	if (window.kind === "tail-only") return window.tail?.bytes ?? 0;
	if (window.elidedLines <= 0) return (window.head?.bytes ?? 0) + (window.tail?.bytes ?? 0) + 1;
	const marker = formatMiddleElisionMarker(window.elidedLines, window.elidedBytes);
	return (window.head?.bytes ?? 0) + (window.tail?.bytes ?? 0) + Buffer.byteLength(marker, "utf-8") + 2;
}

function windowTruncatedBy(window: ReadWindow): "lines" | "bytes" | "middle" | undefined {
	return (window as ReadWindow & { truncatedBy?: "lines" | "bytes" | "middle" }).truncatedBy;
}

function makeWindowResult(window: ReadWindow, content: string): TruncationResult {
	const truncatedBy = windowTruncatedBy(window);
	const lastLineExceedsLimit = window.tail?.kind === "partial-line";
	return {
		content,
		truncated: window.kind !== "full",
		truncatedBy: truncatedBy ?? (window.kind === "middle" ? "middle" : "lines"),
		totalLines: window.totalLines,
		totalBytes: window.totalBytes,
		outputLines: windowOutputLines(window),
		outputBytes: windowOutputBytes(window),
		// `elidedLines`/`elidedBytes` are documented as middle-only on the legacy
		// `TruncationResult`; head/tail windows leave them absent so one-sided
		// results stay byte-identical to the pre-change shape.
		...(window.kind === "middle" ? { elidedLines: window.elidedLines, elidedBytes: window.elidedBytes } : {}),
		lastLinePartial: windowHasPartialSegment(window),
		firstLineExceedsLimit: false,
		...(lastLineExceedsLimit ? { lastLineExceedsLimit: true } : {}),
	};
}

function fullReadWindow(content: string, totalLines: number, totalBytes: number): ReadWindow {
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
		overlap: "disjoint",
		elidedLines: 0,
		elidedBytes: 0,
		totalLines,
		totalBytes,
	};
}

function selectReceiptWindow(
	allLines: readonly string[],
	direction: "head" | "tail",
	budgetLines: number,
	budgetBytes: number,
): ReadWindow {
	const totalLines = allLines.length;
	const fullContent = allLines.join("\n");
	const totalBytes = Buffer.byteLength(fullContent, "utf-8");
	const take = (from: number, step: 1 | -1): { picked: string[]; bytes: number; truncatedBy?: "lines" | "bytes" } => {
		const picked: string[] = [];
		let bytes = 0;
		let truncatedBy: "lines" | "bytes" | undefined;
		for (let i = from; i >= 0 && i < allLines.length; i += step) {
			if (picked.length >= budgetLines) {
				truncatedBy = "lines";
				break;
			}
			const lineBytes = Buffer.byteLength(allLines[i] ?? "", "utf-8") + (picked.length > 0 ? 1 : 0);
			if (bytes + lineBytes > budgetBytes) {
				// Report the constraint that actually bound the window. When the
				// line budget was already full, the byte overflow is incidental and
				// the materialized oracle calls it "lines"; matching keeps A26
				// parity honest.
				truncatedBy = picked.length >= budgetLines ? "lines" : "bytes";
				break;
			}
			picked.push(allLines[i] ?? "");
			bytes += lineBytes;
		}
		return { picked, bytes, truncatedBy };
	};
	const taken = direction === "head" ? take(0, 1) : take(allLines.length - 1, -1);
	if (direction === "tail") taken.picked.reverse();
	const startLine = direction === "head" ? 1 : totalLines - taken.picked.length + 1;
	const selected = taken.picked.join("\n");
	if (taken.picked.length === totalLines) return fullReadWindow(fullContent, totalLines, totalBytes);
	const segment: ReadSegment | undefined =
		taken.picked.length > 0
			? {
					kind: "lines",
					content: selected,
					lines: taken.picked.length,
					bytes: taken.bytes,
					origin: { startLine, endLine: startLine + taken.picked.length - 1 },
					lastLinePartial: false,
				}
			: undefined;
	const window: ReadWindow = {
		kind: direction === "head" ? "head-only" : "tail-only",
		...(direction === "head" ? (segment ? { head: segment } : {}) : segment ? { tail: segment } : {}),
		overlap: "disjoint",
		elidedLines: Math.max(0, totalLines - taken.picked.length),
		elidedBytes: Math.max(0, totalBytes - taken.bytes),
		totalLines,
		totalBytes,
	};
	if (taken.truncatedBy) Object.defineProperty(window, "truncatedBy", { value: taken.truncatedBy, enumerable: false });
	return window;
}

function selectReadWindow(
	text: string,
	allLines: readonly string[],
	direction: TruncationDirection,
	budgetLines: number,
	budgetBytes: number,
): ReadWindow {
	if (direction === "both") {
		return truncateMiddleWindows(text, { maxLines: budgetLines, maxBytes: budgetBytes });
	}
	return selectReceiptWindow(allLines, direction === "head" ? "head" : "tail", budgetLines, budgetBytes);
}

function formatDirectionalFooter(readPath: string, window: ReadWindow): string {
	if (window.kind === "full") return "";
	const total = window.totalLines;
	const shownSegments = windowSegments(window);
	const shownBytes =
		shownSegments.reduce((sum, segment) => sum + segment.bytes, 0) + Math.max(0, shownSegments.length - 1);
	const head = window.head;
	const tail = window.tail;
	const partialTail = partialTailOf(window);
	if (partialTail) {
		return `[Showing last ${formatBytes(partialTail.bytes)} of line ${partialTail.origin.startLine} (line is ${formatBytes(partialTail.sourceLineBytes)}); re-read ${readPath}:1-${total} or ${readPath}:raw for the full file]`;
	}
	if (window.kind === "tail-only" && tail) {
		const start = tail.origin.startLine;
		return `[Showing last ${tail.lines} of ${total} lines (lines ${start}-${tail.origin.endLine}, ~${Math.ceil(shownBytes / 1024)} KiB); omitted lines 1-${start - 1}; re-read ${readPath}:1-${total} or ${readPath}:raw for the full file]`;
	}
	if (window.kind === "middle" && head && tail) {
		const omittedStart = head.origin.endLine + 1;
		const omittedEnd = tail.origin.startLine - 1;
		return `[Showing lines 1-${head.origin.endLine} and ${tail.origin.startLine}-${tail.origin.endLine} of ${total} (~${Math.ceil(shownBytes / 1024)} KiB); omitted lines ${omittedStart}-${omittedEnd}; re-read ${readPath}:1-${total} or ${readPath}:raw for the full file]`;
	}
	const shown = head?.lines ?? 0;
	return `[Showing first ${shown} of ${total} lines (~${Math.ceil(shownBytes / 1024)} KiB); re-read ${readPath}:1-${total} or ${readPath}:raw for the full file]`;
}

function formatOversizedLineWarning(
	readPath: string,
	lineNumber: number,
	lineBytes: number,
	maxBytes: number,
	fullFileLines: number,
): string {
	return `[Line ${lineNumber} is ${formatBytes(lineBytes)}, exceeds ${formatBytes(maxBytes)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview. Re-read ${readPath}:1-${fullFileLines} or ${readPath}:raw for the full file]`;
}

function formatListingTruncationNotice(
	shownLines: number,
	shownBytes: number,
	absolutePath: string,
	direction: TruncationDirection,
): string {
	const retained = direction === "last" ? "last" : direction === "both" ? "first and last" : "first";
	const directionPart = direction === "head" ? "" : `; retained ${retained} lines`;
	return `[Listing truncated at ${shownLines} lines / ${Math.ceil(shownBytes / 1024)} KiB${directionPart}; read a deeper subpath (e.g. ${absolutePath}/<subdir>) to narrow the view]`;
}

function formatRawReadCapNotice(maxBytes: number, fileSize: number, direction: TruncationDirection): string {
	const retained = direction === "last" ? "last" : direction === "both" ? "first and last" : "first";
	const directionPart = direction === "head" ? "" : `; retained ${retained} bytes`;
	return `[Raw read capped at ${formatBytes(maxBytes)} of ${formatBytes(fileSize)}${directionPart}; re-read a line range to narrow the view]`;
}

/**
 * Footer appended to summarized reads telling the model how to recover the
 * elided body. Without this hint, agents either ignore the `...`/`{ .. }`
 * markers or burn a turn guessing the right selector (see issue #1046).
 */
function formatSummaryElisionFooter(readPath: string, elidedSpans: number, elidedLines: number): string {
	if (elidedSpans <= 0) return "";
	const spanWord = elidedSpans === 1 ? "region" : "regions";
	const lineWord = elidedLines === 1 ? "line" : "lines";
	const linePart = elidedLines > 0 ? `${elidedLines} ${lineWord} across ` : "";
	return `[${linePart}${elidedSpans} elided ${spanWord}; read ${readPath}:raw or a line range like ${readPath}:1-9999 for verbatim content]`;
}

function formatReceiptFooter(readPath: string, shownLines: number, totalLines: number, shownBytes: number): string {
	return `[Showing first ${shownLines} of ${totalLines} lines (~${Math.ceil(shownBytes / 1024)} KiB); re-read ${readPath}:1-${totalLines} or ${readPath}:raw for the full file]`;
}

function formatSummaryCapFooter(
	readPath: string,
	maxBytes: number,
	totalLines: number,
	direction: TruncationDirection = "head",
): string {
	const retained = direction === "last" ? "last" : direction === "both" ? "first and last" : "first";
	const directionPart = direction === "head" ? "" : `; retained ${retained} summary units`;
	return `[Summary truncated at ${Math.ceil(maxBytes / 1024)} KiB${directionPart}; re-read ${readPath}:1-${totalLines} or ${readPath}:raw for the full source]`;
}
const READ_CHUNK_SIZE = 8 * 1024;

/**
 * Context lines added around an explicit range read. Anchor-stale failures
 * cluster on edits whose anchors land just outside the most recent read
 * window, but the data (`scripts/session-stats/analyze_selector_reads.py`)
 * shows most follow-up reads are disjoint hops, not adjacent extensions —
 * so symmetric padding rarely pays for itself.
 *
 * Leading=1 catches accidental single-line reads where the anchor is the
 * line immediately above the requested start. Trailing=3 buffers the
 * common case where the agent asks for a narrow range and then needs the
 * next few lines to disambiguate an anchor.
 */
const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;

/**
 * Expand a [start, end) range with leading/trailing context lines on the
 * sides where the user actually constrained the range. A start of 0 (no
 * explicit offset) does not get leading context — that's already an
 * open-ended read from the top.
 */
function expandRangeWithContext(
	requestedStart: number,
	requestedEnd: number,
	totalLines: number,
	expandStart: boolean,
	expandEnd: boolean,
): { startLine: number; endLine: number } {
	return {
		startLine: expandStart ? Math.max(0, requestedStart - RANGE_LEADING_CONTEXT_LINES) : requestedStart,
		endLine: expandEnd ? Math.min(totalLines, requestedEnd + RANGE_TRAILING_CONTEXT_LINES) : requestedEnd,
	};
}

export async function streamLinesFromFile(
	filePath: string,
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
	signal?: AbortSignal,
	collect: "head" | "tail" | "both" = "head",
	collectEndExclusive: number | null = null,
): Promise<{
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	selectedBytesTotal: number;
	windowBytesTotal: number;
	windowLinesTotal: number;
	windowStartIndex: number;
	tailPartial?: { text: string; bytes: number; sourceIndex: number; sourceLineBytes: number };
	maxBytes: number;
	headLines?: string[];
	headBytes?: number;
	headStartIndex?: number;
	degenerateTailBudget: boolean;
	degenerateHeadBudget: boolean;
	headStoppedByBytes: boolean;
	headStoppedByLines: boolean;
	ringBudgetLines: number;
	ringEvictedForBytes: boolean;
	ringEvictedForLines: boolean;
	tailDroppedForBytes: boolean;
}> {
	const bufferChunk = Buffer.allocUnsafe(READ_CHUNK_SIZE);
	const collectedLines: string[] = [];
	let lineIndex = 0;
	let collectedBytes = 0;
	let stoppedByByteLimit = false;
	let doneCollecting = false;
	let fileHandle: fs.FileHandle | null = null;
	let currentLineLength = 0;
	let currentLineChunks: Buffer[] = [];
	let sawAnyByte = false;
	let endedWithNewline = false;
	let firstLinePreviewBytes = 0;
	const firstLinePreviewChunks: Buffer[] = [];
	let firstLineByteLength: number | undefined;
	let selectedBytesTotal = 0;
	let selectedLinesSeen = 0;
	let windowBytesTotal = 0;
	let windowLinesTotal = 0;
	let captureLine = false;
	let discardLineChunks = false;
	let lineCaptureLimit = 0;

	// A middle read uses the same split as truncateMiddleWindows. The candidate
	// state below is deliberately full-fit first: a file that fits the unsplit
	// budget must not lose bytes merely because the eventual mode is "both".
	const headBudgetBytes = collect === "both" ? Math.floor(maxBytes / 2) : 0;
	const ringBudgetBytes = collect === "both" ? Math.max(0, maxBytes - headBudgetBytes) : maxBytes;
	const headBudgetLines = collect === "both" ? Math.max(1, Math.floor(maxLinesToCollect / 2)) : 0;
	const ringBudgetLines = collect === "both" ? Math.max(0, maxLinesToCollect - headBudgetLines) : maxLinesToCollect;
	// Keep the full-fit candidate ahead of this classification. Once a split is
	// required, these predicates dispatch the effective one-sided window kind.
	const degenerateHeadBudget = collect === "both" && (headBudgetBytes <= 0 || headBudgetLines <= 0);
	const degenerateTailBudget = collect === "both" && (ringBudgetBytes <= 0 || ringBudgetLines <= 0);
	type BothState = "full-fit" | "split";
	let oneSidedDispatch: "head" | "tail" | undefined;
	let state: BothState = collect === "both" ? "full-fit" : "split";
	let fitLines: string[] = [];
	let fitByteLens: number[] = [];
	let fitBytes = 0;
	let fitStartIndex = -1;

	const ring: string[] = [];
	const ringLineBytes: number[] = [];
	let ringHead = 0;
	let ringBytes = 0;
	let ringStartIndex = 0;
	let ringOriginPending = true;
	let ringEvictedForBytes = false;
	let ringEvictedForLines = false;
	let tailDroppedForBytes = false;

	const headLines: string[] = [];
	let headBytes = 0;
	let headSealed = false;
	let headStoppedByBytes = false;
	let headStoppedByLines = false;

	let currentLineKept = 0;
	let currentLineDropped = false;
	let oversizedPending: { index: number; byteLength: number; preview: { text: string; bytes: number } } | undefined;

	const windowEndExclusive = collectEndExclusive === null ? Number.POSITIVE_INFINITY : collectEndExclusive;
	const inWindow = () => lineIndex >= startLine && lineIndex < windowEndExclusive;

	const setupLineState = () => {
		captureLine = collect === "head" && !doneCollecting && lineIndex >= startLine;
		discardLineChunks = !captureLine;
		if (captureLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			lineCaptureLimit = maxBytes - collectedBytes - separatorBytes;
			if (lineCaptureLimit <= 0) discardLineChunks = true;
		} else {
			lineCaptureLimit = 0;
		}
	};

	const decodeLine = (): string => {
		if (currentLineKept === 0) return "";
		if (currentLineChunks.length === 1 && currentLineChunks[0]?.length === currentLineKept) {
			return currentLineChunks[0].toString("utf-8");
		}
		return Buffer.concat(currentLineChunks, currentLineKept).toString("utf-8");
	};

	const maybeCapturePreview = (segment: Uint8Array) => {
		if (doneCollecting || lineIndex < startLine || collectedLines.length !== 0) return;
		if (firstLinePreviewBytes >= maxBytes || segment.length === 0) return;
		const remaining = maxBytes - firstLinePreviewBytes;
		const slice = segment.length > remaining ? segment.subarray(0, remaining) : segment;
		if (slice.length === 0) return;
		firstLinePreviewChunks.push(Buffer.from(slice));
		firstLinePreviewBytes += slice.length;
	};

	const trimCurrentLineBuffer = (cap: number) => {
		while (currentLineKept > cap && currentLineChunks.length > 0) {
			const front = currentLineChunks[0];
			const excess = currentLineKept - cap;
			if (front.length <= excess) {
				currentLineChunks.shift();
				currentLineKept -= front.length;
			} else {
				currentLineChunks[0] = Buffer.from(front.subarray(excess));
				currentLineKept -= excess;
			}
			currentLineDropped = true;
		}
	};

	const appendSegment = (segment: Uint8Array) => {
		currentLineLength += segment.length;
		if (collect === "head") {
			maybeCapturePreview(segment);
			if (!captureLine || discardLineChunks || segment.length === 0) return;
			if (currentLineLength <= lineCaptureLimit) {
				currentLineChunks.push(Buffer.from(segment));
				currentLineKept += segment.length;
			} else {
				discardLineChunks = true;
			}
			return;
		}
		if (!inWindow() || segment.length === 0) return;
		currentLineChunks.push(Buffer.from(segment));
		currentLineKept += segment.length;
		trimCurrentLineBuffer(collect === "both" && state === "full-fit" ? maxBytes : ringBudgetBytes);
	};

	const capturePartialPreview = (): { text: string; bytes: number } => {
		const raw = Buffer.concat(currentLineChunks, currentLineKept);
		let start = 0;
		while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start++;
		const aligned = raw.subarray(start);
		return { text: aligned.toString("utf-8"), bytes: aligned.length };
	};

	const pushSplit = (
		index: number,
		text: string,
		bytes: number,
		dropped: boolean,
		previewOverride?: { text: string; bytes: number },
	) => {
		if (collect === "both" && oneSidedDispatch !== "tail" && !headSealed) {
			if (dropped || bytes > headBudgetBytes) {
				headSealed = true;
				headStoppedByBytes = true;
			} else {
				const separatorBytes = headLines.length > 0 ? 1 : 0;
				if (headLines.length < headBudgetLines && headBytes + separatorBytes + bytes <= headBudgetBytes) {
					headLines.push(text);
					headBytes += separatorBytes + bytes;
				} else {
					headSealed = true;
					if (headLines.length >= headBudgetLines) headStoppedByLines = true;
					else headStoppedByBytes = true;
				}
			}
		}
		if (collect === "both" && oneSidedDispatch === "head") return;

		if (dropped || bytes > ringBudgetBytes) {
			const preview = previewOverride ?? truncateTailBytes(text, ringBudgetBytes);
			oversizedPending = { index, byteLength: bytes, preview };
			ring.length = 0;
			ringHead = 0;
			ringLineBytes.length = 0;
			ringBytes = 0;
			ringOriginPending = true;
			tailDroppedForBytes = true;
			return;
		}

		if (ringOriginPending) {
			ringStartIndex = index;
			ringOriginPending = false;
		}
		ring.push(text);
		ringLineBytes.push(bytes);
		ringBytes += (ring.length - ringHead > 1 ? 1 : 0) + bytes;
		oversizedPending = undefined;

		while (ring.length - ringHead > ringBudgetLines || (ringBytes > ringBudgetBytes && ring.length - ringHead > 1)) {
			if (ring.length - ringHead > ringBudgetLines) ringEvictedForLines = true;
			if (ringBytes > ringBudgetBytes) ringEvictedForBytes = true;
			const evictedBytes = ringLineBytes[ringHead] ?? 0;
			const evictedSep = ring.length - ringHead > 1 ? 1 : 0;
			ringBytes -= evictedBytes + evictedSep;
			ring[ringHead] = undefined as unknown as string;
			ringHead++;
			ringStartIndex++;
		}
		if (ring.length - ringHead === 0) ringOriginPending = true;
		if (ringHead > 4096) {
			ring.splice(0, ringHead);
			ringLineBytes.splice(0, ringHead);
			ringHead = 0;
		}
	};

	const transitionToSplit = () => {
		state = "split";
		oneSidedDispatch = degenerateHeadBudget ? "tail" : degenerateTailBudget ? "head" : undefined;
		for (let i = 0; i < fitLines.length; i++) {
			pushSplit(fitStartIndex + i, fitLines[i] ?? "", fitByteLens[i] ?? 0, false);
		}
		fitLines = [];
		fitByteLens = [];
		fitBytes = 0;
		fitStartIndex = -1;
		trimCurrentLineBuffer(ringBudgetBytes);
	};

	const finalizeLine = () => {
		if (lineIndex >= startLine && (selectedLineLimit === null || selectedLinesSeen < selectedLineLimit)) {
			selectedBytesTotal += currentLineLength + (selectedLinesSeen > 0 ? 1 : 0);
			selectedLinesSeen++;
		}
		if (inWindow()) {
			windowBytesTotal += currentLineLength + (windowLinesTotal > 0 ? 1 : 0);
			windowLinesTotal++;
		}

		if (collect === "head") {
			if (!doneCollecting && lineIndex >= startLine) {
				const separatorBytes = collectedLines.length > 0 ? 1 : 0;
				if (collectedLines.length >= maxLinesToCollect) {
					doneCollecting = true;
				} else if (collectedLines.length === 0 && currentLineLength > maxBytes) {
					stoppedByByteLimit = true;
					doneCollecting = true;
					if (firstLineByteLength === undefined) firstLineByteLength = currentLineLength;
				} else if (collectedLines.length > 0 && collectedBytes + separatorBytes + currentLineLength > maxBytes) {
					stoppedByByteLimit = true;
					doneCollecting = true;
				} else {
					const lineText = decodeLine();
					collectedLines.push(lineText);
					collectedBytes += separatorBytes + currentLineLength;
					if (firstLineByteLength === undefined) firstLineByteLength = currentLineLength;
					if (collectedBytes > maxBytes) {
						stoppedByByteLimit = true;
						doneCollecting = true;
					} else if (collectedLines.length >= maxLinesToCollect) {
						doneCollecting = true;
					}
				}
			} else if (lineIndex >= startLine && firstLineByteLength === undefined) {
				firstLineByteLength = currentLineLength;
			}
		} else if (inWindow()) {
			const lineText = decodeLine();
			if (collect === "both" && state === "full-fit") {
				const separatorBytes = fitLines.length > 0 ? 1 : 0;
				const stillFits =
					!currentLineDropped &&
					fitLines.length + 1 <= maxLinesToCollect &&
					fitBytes + separatorBytes + currentLineLength <= maxBytes;
				if (stillFits) {
					if (fitStartIndex < 0) fitStartIndex = lineIndex;
					fitLines.push(lineText);
					fitByteLens.push(currentLineLength);
					fitBytes += separatorBytes + currentLineLength;
				} else {
					transitionToSplit();
					pushSplit(lineIndex, lineText, currentLineLength, currentLineDropped, capturePartialPreview());
				}
			} else {
				pushSplit(lineIndex, lineText, currentLineLength, currentLineDropped, capturePartialPreview());
			}
		}

		lineIndex++;
		currentLineLength = 0;
		currentLineKept = 0;
		currentLineChunks = [];
		currentLineDropped = false;
		setupLineState();
	};

	setupLineState();

	try {
		fileHandle = await fs.open(filePath, "r");
		while (true) {
			throwIfAborted(signal);
			const { bytesRead } = await fileHandle.read(bufferChunk, 0, bufferChunk.length, null);
			if (bytesRead === 0) break;

			sawAnyByte = true;
			const chunk = bufferChunk.subarray(0, bytesRead);
			endedWithNewline = chunk[bytesRead - 1] === 0x0a;

			let start = 0;
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] === 0x0a) {
					const segment = chunk.subarray(start, i);
					if (segment.length > 0) appendSegment(segment);
					finalizeLine();
					start = i + 1;
				}
			}
			if (start < chunk.length) appendSegment(chunk.subarray(start));
		}
	} finally {
		if (fileHandle) await fileHandle.close();
	}

	if (endedWithNewline || currentLineLength > 0 || !sawAnyByte) finalizeLine();

	let firstLinePreview: { text: string; bytes: number } | undefined;
	if (firstLinePreviewBytes > 0) {
		const { text, bytes } = truncateHeadBytes(Buffer.concat(firstLinePreviewChunks, firstLinePreviewBytes), maxBytes);
		firstLinePreview = { text, bytes };
	}

	const tailPartial =
		collect !== "head" && oversizedPending
			? {
					text: oversizedPending.preview.text,
					bytes: oversizedPending.preview.bytes,
					sourceIndex: oversizedPending.index,
					sourceLineBytes: oversizedPending.byteLength,
				}
			: undefined;
	// I8: selected-window line totals are defined on the valid domain only;
	// out-of-bounds starts clamp the mathematical count at zero.
	// `inWindow()` above enforces the same predicate while collecting.
	// I8 is therefore `windowLinesTotal === Math.max(0, windowEnd - startLine)`.
	const ringSize = ring.length - ringHead;
	const ringLines = ring.slice(ringHead);
	const windowEnd = Math.min(collectEndExclusive ?? lineIndex, lineIndex);
	const windowStartIndex =
		collect === "head"
			? startLine
			: ringSize > 0
				? ringStartIndex
				: tailPartial
					? tailPartial.sourceIndex
					: windowEnd;

	if (collect !== "head") collectedBytes = ringBytes;

	const resolvedHeadLines = collect === "both" && state === "full-fit" ? fitLines : headLines;
	const resolvedHeadBytes = collect === "both" && state === "full-fit" ? fitBytes : headBytes;
	return {
		lines: collect === "head" ? collectedLines : ringLines,
		totalFileLines: lineIndex,
		collectedBytes,
		stoppedByByteLimit: collect === "head" ? stoppedByByteLimit : ringEvictedForBytes,
		firstLinePreview,
		firstLineByteLength,
		selectedBytesTotal,
		windowBytesTotal,
		windowLinesTotal,
		windowStartIndex,
		tailPartial,
		maxBytes,
		headLines: collect === "both" ? resolvedHeadLines : undefined,
		headBytes: collect === "both" ? resolvedHeadBytes : undefined,
		headStartIndex: collect === "both" ? startLine : undefined,
		degenerateTailBudget,
		degenerateHeadBudget,
		headStoppedByBytes,
		headStoppedByLines,
		ringBudgetLines,
		ringEvictedForBytes,
		ringEvictedForLines,
		tailDroppedForBytes,
	};
}

export function streamResultWindow(
	result: Awaited<ReturnType<typeof streamLinesFromFile>>,
	collect: "tail" | "both",
	startLine: number,
	collectEndExclusive: number | null,
): ReadWindow {
	const windowEnd = Math.min(collectEndExclusive ?? result.totalFileLines, result.totalFileLines);
	const totalLines = result.windowLinesTotal;
	const totalBytes = result.windowBytesTotal;
	const ringLines = result.lines;
	const partial = result.tailPartial;
	const attachReason = (window: ReadWindow, reason: "lines" | "bytes" | "middle" | undefined): ReadWindow => {
		Object.defineProperty(window, "maxBytes", { value: result.maxBytes, enumerable: false });
		if (reason !== undefined) Object.defineProperty(window, "truncatedBy", { value: reason, enumerable: false });
		return window;
	};
	const linesSegment = (lines: readonly string[], bytes: number, sourceStart: number): ReadSegment | undefined => {
		if (lines.length === 0) return undefined;
		return {
			kind: "lines",
			content: lines.join("\n"),
			lines: lines.length,
			bytes,
			origin: { startLine: sourceStart + 1, endLine: sourceStart + lines.length },
			lastLinePartial: false,
		};
	};
	const partialSegment = (): ReadSegment | undefined => {
		if (!partial) return undefined;
		return {
			kind: "partial-line",
			content: partial.text,
			lines: 1,
			bytes: partial.bytes,
			origin: { startLine: partial.sourceIndex + 1, endLine: partial.sourceIndex + 1 },
			sourceLineBytes: partial.sourceLineBytes,
			lastLinePartial: true,
		};
	};
	const sourceBytes = (lines: readonly string[]): number => Buffer.byteLength(lines.join("\n"), "utf-8");
	const tail = partialSegment() ?? linesSegment(ringLines, result.collectedBytes, result.windowStartIndex);
	const tailStartIndex = partial?.sourceIndex ?? (ringLines.length > 0 ? result.windowStartIndex : windowEnd);
	const tailCount = partial ? 1 : ringLines.length;
	const lineBudgetWon = !partial && result.ringEvictedForLines && tailCount >= result.ringBudgetLines;
	const tailReason: "lines" | "bytes" | undefined =
		partial || result.tailDroppedForBytes || (result.ringEvictedForBytes && !lineBudgetWon)
			? "bytes"
			: lineBudgetWon || tailCount < totalLines
				? "lines"
				: undefined;

	if (collect === "tail") {
		if (
			tailCount === totalLines &&
			!partial &&
			!result.ringEvictedForBytes &&
			!result.ringEvictedForLines &&
			!result.tailDroppedForBytes
		) {
			return {
				kind: "full",
				head: linesSegment(ringLines, totalBytes, startLine),
				overlap: "disjoint",
				elidedLines: 0,
				elidedBytes: 0,
				totalLines,
				totalBytes,
			};
		}
		return attachReason(
			{
				kind: "tail-only",
				...(tail ? { tail } : {}),
				overlap: "disjoint",
				elidedLines: Math.max(0, totalLines - tailCount),
				elidedBytes: partial
					? Math.max(0, totalBytes - partial.bytes)
					: Math.max(0, totalBytes - result.collectedBytes),
				totalLines,
				totalBytes,
			},
			tailReason,
		);
	}

	const headLines = result.headLines ?? [];
	const headCount = headLines.length;
	const headBytes = result.headBytes ?? sourceBytes(headLines);
	const head = linesSegment(headLines, headBytes, result.headStartIndex ?? startLine);
	const headEndExclusive = startLine + headCount;
	const windowLineCount = totalLines;
	const headReason: "lines" | "bytes" | undefined = result.degenerateTailBudget
		? result.headStoppedByBytes
			? "bytes"
			: result.headStoppedByLines || headCount < windowLineCount
				? "lines"
				: undefined
		: result.ringEvictedForBytes || result.tailDroppedForBytes
			? "bytes"
			: result.ringEvictedForLines || headCount < windowLineCount
				? "lines"
				: undefined;
	const makeHeadOnly = (): ReadWindow =>
		attachReason(
			{
				kind: "head-only",
				...(head ? { head } : {}),
				overlap: "disjoint",
				elidedLines: Math.max(0, windowLineCount - headCount),
				elidedBytes: Math.max(0, totalBytes - headBytes),
				totalLines: windowLineCount,
				totalBytes,
			},
			headReason,
		);
	const makeTailOnly = (): ReadWindow =>
		attachReason(
			{
				kind: "tail-only",
				...(tail ? { tail } : {}),
				overlap: "disjoint",
				elidedLines: Math.max(0, windowLineCount - tailCount),
				elidedBytes: partial
					? Math.max(0, totalBytes - partial.bytes)
					: Math.max(0, totalBytes - result.collectedBytes),
				totalLines: windowLineCount,
				totalBytes,
			},
			tailReason,
		);
	if (
		collect === "both" &&
		headCount === windowLineCount &&
		!partial &&
		!result.ringEvictedForBytes &&
		!result.ringEvictedForLines &&
		!result.tailDroppedForBytes
	) {
		return {
			kind: "full",
			head: linesSegment(headLines, totalBytes, startLine),
			overlap: "disjoint",
			elidedLines: 0,
			elidedBytes: 0,
			totalLines: windowLineCount,
			totalBytes,
		};
	}

	if (collect === "both" && result.degenerateHeadBudget) return makeTailOnly();
	if (collect === "both" && result.degenerateTailBudget) return makeHeadOnly();
	if (headCount === 0) return makeTailOnly();
	if (ringLines.length === 0 && !partial) return makeHeadOnly();
	if (!tail) return makeHeadOnly();

	const headTailGap = tailStartIndex - headEndExclusive;
	const overlap: ReadWindow["overlap"] = headTailGap > 0 ? "disjoint" : headTailGap === 0 ? "adjacent" : "overlapping";
	if (headTailGap <= 0) {
		const headKeep = Math.max(0, tailStartIndex - startLine);
		if (headKeep === 0) return makeTailOnly();
		if (!partial && headKeep + ringLines.length >= windowLineCount) {
			const fullLines = headLines.slice(0, headKeep).concat(ringLines);
			return {
				kind: "full",
				head: linesSegment(fullLines, totalBytes, startLine),
				overlap,
				elidedLines: 0,
				elidedBytes: 0,
				totalLines: windowLineCount,
				totalBytes,
			};
		}
		const keptHeadLines = headLines.slice(0, headKeep);
		const keptHead = linesSegment(keptHeadLines, sourceBytes(keptHeadLines), startLine);
		if (!keptHead) return makeTailOnly();
		return attachReason(
			{
				kind: "middle",
				head: keptHead,
				tail,
				overlap,
				elidedLines: partial ? Math.max(0, tailStartIndex - (startLine + headKeep)) : 0,
				elidedBytes: partial
					? Math.max(0, totalBytes - keptHead.bytes - partial.sourceLineBytes)
					: Math.max(0, totalBytes - keptHead.bytes - tail.bytes),
				totalLines: windowLineCount,
				totalBytes,
			},
			"middle",
		);
	}

	const elidedLines = partial ? Math.max(0, tailStartIndex - headEndExclusive) : headTailGap;
	const partialSourceBytes = partial ? partial.sourceLineBytes : tail.bytes;
	return attachReason(
		{
			kind: "middle",
			...(head ? { head } : {}),
			tail,
			overlap,
			elidedLines,
			elidedBytes: Math.max(0, totalBytes - headBytes - partialSourceBytes),
			totalLines: windowLineCount,
			totalBytes,
		},
		"middle",
	);
}

// Maximum image file size (20MB) - larger images will be rejected to prevent OOM during serialization
const MAX_IMAGE_SIZE = MAX_IMAGE_INPUT_BYTES;
const GLOB_TIMEOUT_MS = 5000;

function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Attempt to resolve a non-existent path by finding a unique suffix match within the workspace.
 * Uses a glob suffix pattern so the native engine handles matching directly.
 * Returns null when 0 or >1 candidates match (ambiguous = no auto-resolution).
 */
async function findUniqueSuffixMatch(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!normalized) return null;

	const timeoutSignal = AbortSignal.timeout(GLOB_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let matches: string[];
	const { glob } = await nativeRead();
	try {
		const result = await untilAborted(combinedSignal, () =>
			glob({
				pattern: `**/${normalized}`,
				path: cwd,
				// No fileType filter: matches both files and directories
				hidden: true,
			}),
		);
		matches = result.matches.map(m => m.path);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			if (!signal?.aborted) return null; // timeout — give up silently
			throw new ToolAbortError();
		}
		return null;
	}

	if (matches.length !== 1) return null;

	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

function decodeUtf8Text(bytes: Uint8Array): string | null {
	for (const byte of bytes) {
		if (byte === 0) return null;
	}

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}

const readSchema = z
	.object({
		path: z.string().describe('path or url; append :<sel> for line ranges or raw mode (e.g. "src/foo.ts:50-100")'),
		truncation: z
			.enum(["head", "last", "both"])
			.optional()
			.describe(
				"which end of an over-budget result to keep: head | last | both. Route defaults are route-aware: read.truncation is consulted for bare local and archive-member routes (factory default: last), while URL, converted, directory, range, internal, and other routes default to head. SQLite row, schema, and query reads ignore this parameter; raw reads honor explicit directions.",
			),
	})
	.strict();

export type ReadToolInput = z.infer<typeof readSchema>;

const UNSAFE_SUMMARY_PATH =
	/(?:\b(?:https?|wss?):\/\/|\b(?:api[-_ ]?key|access[-_ ]?token|bearer|secret|password)\b|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,})/i;

/** Project paths and output sizes without exposing read content or remote URLs. */
export function summarizeReadToolActivity(kind: "args" | "result", value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (kind === "args") {
		const readPath = record.path;
		if (
			typeof readPath !== "string" ||
			readPath.length === 0 ||
			readPath.length > 100 ||
			UNSAFE_SUMMARY_PATH.test(readPath)
		) {
			return undefined;
		}
		return readPath;
	}
	if (!Array.isArray(record.content)) return undefined;
	const text = record.content
		.filter(
			(block): block is { type: unknown; text: unknown } =>
				typeof block === "object" && block !== null && "type" in block && "text" in block,
		)
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");
	const lines = text.length === 0 ? 0 : text.split("\n").length;
	return `${lines} lines, ${Buffer.byteLength(text, "utf-8")} bytes`;
}

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationResult;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Whether this explicit content read may be spilled by output metadata. */
	spillEligible?: boolean;

	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: { text: string; startLine: number };
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	/** Number of unresolved git conflicts surfaced by this read (TUI uses for inline `⚠ N` badge). */
	conflictCount?: number;
}

type ReadParams = ReadToolInput;

/** Parsed representation of a path-embedded selector. */
type LineRange = { startLine: number; endLine: number | undefined };

type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean };

const LINE_RANGE_RE = /^L?(\d+)(?:([-+])L?(\d+)?)?$/i;

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}

/** Returns true when the selector requested multiple line ranges. */
function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

function parseLineRangeChunk(sel: string): LineRange | null {
	const lineMatch = LINE_RANGE_RE.exec(sel);
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	const sep = lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		// `301-` is shorthand for "from 301 onward" — equivalent to bare `301`.
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	}
	return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973`). Returns
 * the ranges in ascending order with overlapping/adjacent ranges merged so
 * downstream consumers can stream the file in a single forward pass per range.
 */
function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const chunks = sel.split(",");
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseLineRangeChunk(chunk);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.startLine - b.startLine);

	const merged: LineRange[] = [parsed[0]];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i];
		const last = merged[merged.length - 1];
		// Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
		if (last.endLine === undefined) continue;
		// Merge when current starts within (or immediately after) the last range.
		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw` or `raw:1-50`. Split into chunks and accept
	// any combination of one line range (possibly multi) and the literal `raw`.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const ranges = parseLineRanges(rangeChunk);
				if (ranges) {
					return { kind: "lines", ranges, raw: true };
				}
			}
		}
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	const ranges = parseLineRanges(sel);
	if (ranges) {
		return { kind: "lines", ranges };
	}
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}

interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
}

/**
 * Read tool implementation.
 *
 * Reads files with support for images, converted documents (via markit), and text.
 * Directories return a formatted listing with modification times.
 */
/**
 * Only an explicit bridge transport-unavailable marker authorizes falling back to
 * the agent host's disk. Raw OS errno values, including EACCES/EPERM, are
 * ambiguous at this boundary: treating them as transport failures can bypass a
 * remote client's access decision by reading the path locally.
 */
function isExplicitTransportUnavailable(error: unknown): boolean {
	const directCode =
		typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
	const namedCode = error instanceof Error ? error.name : undefined;
	const nestedCode =
		typeof error === "object" &&
		error !== null &&
		"data" in error &&
		typeof (error as { data?: unknown }).data === "object"
			? ((error as { data?: { code?: unknown } }).data?.code ?? undefined)
			: undefined;
	const code = directCode ?? nestedCode ?? namedCode;
	return code === "transport_unavailable" || code === "bridge_unavailable";
}

function isClientAuthorityDenial(error: unknown): boolean {
	return !isExplicitTransportUnavailable(error);
}

export class ReadTool implements AgentTool<typeof readSchema, ReadToolDetails> {
	readonly name = "read";
	readonly label = "Read";
	readonly loadMode = "essential";
	get description(): string {
		const displayMode = resolveFileDisplayMode(this.session);
		return prompt.render(readDescription, {
			DEFAULT_LIMIT: String(this.#defaultLimit),
			DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
			TRUNCATION_DEFAULT: String(this.session.settings.get("read.truncation") ?? "last"),
			RECEIPT_LINES: String(this.session.settings.get("read.receiptBudgetLines")),
			RECEIPT_KIB: String(this.session.settings.get("read.receiptBudgetBytes")),
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}
	readonly parameters = readSchema;
	readonly nonAbortable = true;
	readonly strict = true;
	readonly safeSummary = summarizeReadToolActivity;

	readonly #autoResizeImages: boolean;
	readonly #defaultLimit: number;

	constructor(private readonly session: ToolSession) {
		this.#autoResizeImages = session.settings.get("images.autoResize");
		this.#defaultLimit = Math.max(
			1,
			Math.min(session.settings.get("read.defaultLimit") ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES),
		);
	}

	async #resolveArchiveReadPath(readPath: string, signal?: AbortSignal): Promise<ResolvedArchiveReadPath | null> {
		const candidates = parseArchivePathCandidates(readPath);
		for (const candidate of candidates) {
			let absolutePath = resolveReadPath(candidate.archivePath, this.session.cwd);
			let suffixResolution: { from: string; to: string } | undefined;

			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) continue;
				return {
					absolutePath,
					archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
					suffixResolution,
				};
			} catch (error) {
				if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

				const suffixMatch = await findUniqueSuffixMatch(candidate.archivePath, this.session.cwd, signal);
				if (!suffixMatch) continue;

				try {
					const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
					if (retryStat.isDirectory()) continue;

					absolutePath = suffixMatch.absolutePath;
					suffixResolution = { from: candidate.archivePath, to: suffixMatch.displayPath };
					return {
						absolutePath,
						archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
						suffixResolution,
					};
				} catch (retryError) {
					if (!isNotFoundError(retryError)) {
						throw retryError;
					}
				}
			}
		}

		return null;
	}

	async #resolveSqliteReadPath(readPath: string, signal?: AbortSignal): Promise<ResolvedSqliteReadPath | null> {
		const candidates = parseSqlitePathCandidates(readPath);
		for (const candidate of candidates) {
			let absolutePath = resolveReadPath(candidate.sqlitePath, this.session.cwd);
			let suffixResolution: { from: string; to: string } | undefined;

			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) continue;
				if (!(await isSqliteFile(absolutePath))) continue;

				return {
					absolutePath,
					sqliteSubPath: candidate.subPath,
					queryString: candidate.queryString,
					suffixResolution,
				};
			} catch (error) {
				if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

				const suffixMatch = await findUniqueSuffixMatch(candidate.sqlitePath, this.session.cwd, signal);
				if (!suffixMatch) continue;

				try {
					const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
					if (retryStat.isDirectory()) continue;
					if (!(await isSqliteFile(suffixMatch.absolutePath))) continue;

					absolutePath = suffixMatch.absolutePath;
					suffixResolution = { from: candidate.sqlitePath, to: suffixMatch.displayPath };
					return {
						absolutePath,
						sqliteSubPath: candidate.subPath,
						queryString: candidate.queryString,
						suffixResolution,
					};
				} catch (retryError) {
					if (!isNotFoundError(retryError)) {
						throw retryError;
					}
				}
			}
		}

		return null;
	}

	#buildInMemoryTextResult(
		text: string,
		offset: number | undefined,
		limit: number | undefined,
		options: {
			details?: ReadToolDetails;
			sourcePath?: string;
			spillEligible?: boolean;
			receiptPath?: string;
			bodyFooterPath?: string;
			sourceUrl?: string;
			sourceInternal?: string;
			entityLabel: string;
			ignoreResultLimits?: boolean;
			resultByteCeiling?: number;
			raw?: boolean;
			immutable?: boolean;
			wrapUntrusted?: boolean;
			truncationDirection?: TruncationDirection;
			/** Truncation metadata stays relative to the selected body, not a protected prefix. */
			truncationMetadataBodyRelative?: boolean;
			/** Preserve this leading URL preamble while truncating only the selected body. */
			protectedPrefixChars?: number;
			cacheLinesFor?: string;
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		const requestedStart = offset ? Math.max(0, offset - 1) : 0;
		const ignoreResultLimits = options.ignoreResultLimits ?? false;
		const requestedEnd = limit !== undefined ? Math.min(requestedStart + limit, allLines.length) : allLines.length;
		const expanded = expandRangeWithContext(
			requestedStart,
			requestedEnd,
			allLines.length,
			offset !== undefined && offset > 1,
			limit !== undefined,
		);
		const startLine = expanded.startLine;
		const endLine = expanded.endLine;
		const startLineDisplay = startLine + 1;

		const resultBuilder = toolResult(details);
		if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
		if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
		if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

		if (requestedStart >= allLines.length) {
			const suggestion =
				allLines.length === 0
					? `The ${options.entityLabel} is empty.`
					: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
			return resultBuilder
				.text(
					`Line ${requestedStart + 1} is beyond end of ${options.entityLabel} (${allLines.length} lines total). ${suggestion}`,
				)
				.done();
		}

		const direction = options.truncationDirection ?? "head";
		const receipt = options.receiptPath !== undefined;
		const exposeReceiptHeadMeta = receipt && options.cacheLinesFor !== undefined;
		const bodyFooterPath = options.receiptPath ?? options.bodyFooterPath;
		const preservePrefix =
			direction !== "head" && options.protectedPrefixChars !== undefined && options.protectedPrefixChars > 0;
		const protectedPrefix = preservePrefix ? text.slice(0, options.protectedPrefixChars) : "";
		const protectedPrefixLines = preservePrefix ? protectedPrefix.split("\n").length - 1 : 0;
		const rangeStart = preservePrefix ? Math.max(startLine, protectedPrefixLines) : startLine;

		const rangeLines = allLines.slice(rangeStart, endLine);
		const rangeText = rangeLines.join("\n");
		const budgetLines = receipt
			? this.session.settings.get("read.receiptBudgetLines")
			: options.resultByteCeiling === undefined
				? DEFAULT_MAX_LINES
				: Number.MAX_SAFE_INTEGER;
		const budgetBytes = receipt
			? this.session.settings.get("read.receiptBudgetBytes") * 1024
			: (options.resultByteCeiling ?? DEFAULT_MAX_BYTES);
		const relativeWindow = ignoreResultLimits
			? fullReadWindow(rangeText, rangeLines.length, Buffer.byteLength(rangeText, "utf-8"))
			: selectReadWindow(
					receipt ? text : rangeText,
					receipt ? allLines : rangeLines,
					direction,
					budgetLines,
					budgetBytes,
				);
		// A directional head window cannot render anything when its first source line
		// exceeds the byte budget. Fall back to the historical head truncator so ACP
		// still emits the same UTF-8 preview and metadata as the pre-direction code.
		const oversizedHeadWindow =
			!receipt &&
			direction === "head" &&
			options.resultByteCeiling === undefined &&
			relativeWindow.kind === "head-only" &&
			relativeWindow.head === undefined;
		const legacyHeadByteCeiling = options.resultByteCeiling ?? (oversizedHeadWindow ? budgetBytes : undefined);
		const window = rebaseWindow(relativeWindow, receipt ? 0 : rangeStart);
		// Keep explicit ranges in the selected-window coordinate system for truncation metadata.
		// Rendered output still uses `window`, whose anchors retain absolute file line numbers.
		const metadataWindow =
			options.truncationMetadataBodyRelative || (offset !== undefined && direction !== "head")
				? relativeWindow
				: window;
		const metadataRangeBase =
			options.truncationMetadataBodyRelative || (offset !== undefined && direction !== "head")
				? "window"
				: undefined;
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = !shouldAddHashLines && displayMode.lineNumbers;
		const maxColumns = options.raw ? 0 : resolveOutputMaxColumns(this.session.settings);
		const bodyRawWindow = renderReadWindow(window, false, false, maxColumns);
		const bodyRenderedWindow = renderReadWindow(window, shouldAddHashLines, shouldAddLineNumbers, maxColumns);
		const rawWindow = preservePrefix ? `${protectedPrefix}${bodyRawWindow}` : bodyRawWindow;
		const renderedWindow = preservePrefix ? `${protectedPrefix}${bodyRenderedWindow}` : bodyRenderedWindow;
		const partialTail = partialTailOf(window);
		const partialTailWarning = partialTail !== undefined && shouldAddHashLines && bodyFooterPath !== undefined;
		if (partialTailWarning) {
			Object.defineProperty(metadataWindow, "outputLinesOverride", { value: 0, enumerable: false });
			Object.defineProperty(metadataWindow, "outputBytesOverride", { value: 0, enumerable: false });
		}
		const selectedContent = windowSegments(window)
			.map(segment => segment.content)
			.join("\n");
		details.displayContent = {
			text: rawWindow,
			startLine: preservePrefix
				? 1
				: (window.head?.origin.startLine ?? window.tail?.origin.startLine ?? startLineDisplay),
		};

		let usedLegacyHeadTruncation = false;
		let outputText = partialTailWarning
			? formatOversizedLineWarning(
					bodyFooterPath!,
					partialTail!.origin.startLine,
					partialTail!.sourceLineBytes,
					budgetBytes,
					totalLines,
				)
			: renderedWindow;
		let truncationResult: TruncationResult | undefined;
		if (window.kind !== "full" && (!receipt || direction !== "head" || exposeReceiptHeadMeta)) {
			const windowResult = makeWindowResult(metadataWindow, selectedContent);
			const baseTruncation =
				!receipt && direction === "head"
					? {
							...windowResult,
							truncated: true,
						}
					: windowResult;
			truncationResult = partialTailWarning
				? { ...baseTruncation, outputLines: 0, outputBytes: 0, lastLineExceedsLimit: true }
				: baseTruncation;
			details.truncation = truncationResult;
		}

		// Preserve the historical head byte-cap oversized-line behavior. The
		// directional window model is used for tail/both; head remains the old
		// oracle so existing hashline and snippet contracts stay byte-identical.
		if (!receipt && direction === "head" && legacyHeadByteCeiling !== undefined) {
			const legacy = truncateHead(rangeText, {
				maxBytes: legacyHeadByteCeiling,
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			truncationResult = legacy;
			usedLegacyHeadTruncation = legacy.truncated === true;
			details.truncation = legacy.truncated ? legacy : undefined;
			if (legacy.firstLineExceedsLimit) {
				const firstLine = allLines[startLine] ?? "";
				const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
				const snippet = truncateHeadBytes(firstLine, legacyHeadByteCeiling);
				if (shouldAddHashLines) {
					outputText = `[Line ${startLineDisplay} is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(legacyHeadByteCeiling)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
				} else {
					outputText = formatTextWithMode(snippet.text, startLineDisplay, false, shouldAddLineNumbers);
				}
				if (snippet.text.length === 0) {
					outputText = `[Line ${startLineDisplay} is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(legacyHeadByteCeiling)} limit. Unable to display a valid UTF-8 snippet.]`;
				}
				details.displayContent = { text: snippet.text, startLine: startLineDisplay };
			} else if (legacy.truncated) {
				outputText = formatTextWithMode(legacy.content, startLineDisplay, shouldAddHashLines, shouldAddLineNumbers);
			} else {
				outputText = formatTextWithMode(rangeText, startLineDisplay, shouldAddHashLines, shouldAddLineNumbers);
			}
		}

		const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
		if (bodyFooterPath !== undefined && window.kind !== "full" && !partialTailWarning) {
			// A head window only owns a body footer on the historical receipt paths.
			// Archive members and internal URLs reach here through `bodyFooterPath`
			// alone; adding a head footer there would emit a second notice beside the
			// wrapper's, changing output that must stay byte-identical when the
			// direction is rolled back to head.
			const footer =
				direction === "head"
					? receipt
						? formatReceiptFooter(
								bodyFooterPath,
								metadataWindow.head?.lines ?? 0,
								metadataWindow.totalLines,
								windowSegments(metadataWindow).reduce((sum, segment) => sum + segment.bytes, 0),
							)
						: undefined
					: formatDirectionalFooter(bodyFooterPath, metadataWindow);
			if (footer) {
				outputText += `\n\n${footer}`;
				if (direction !== "head") rememberBodyTruncationFooter(details, footer);
			}
		} else if (
			!receipt &&
			window.kind === "full" &&
			userLimitedLines !== undefined &&
			startLine + userLimitedLines < allLines.length
		) {
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;
			outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use :${nextOffset} to continue]`;
		}

		details.spillEligible =
			options.spillEligible === true && selectedContent.length > 0 && !windowHasPartialSegment(window);
		if (options.cacheLinesFor && !windowHasPartialSegment(window)) {
			for (const segment of windowSegments(window)) {
				if (segment.kind === "lines" && segment.lines > 0) {
					getFileReadCache(this.session).recordContiguous(
						options.cacheLinesFor,
						segment.origin.startLine,
						linesOfSegment(segment),
					);
				}
			}
		}
		resultBuilder.text(options.wrapUntrusted ? wrapUntrustedContent(outputText) : outputText);
		if (window.kind !== "full" && (!receipt || direction !== "head" || exposeReceiptHeadMeta)) {
			const receiptHead = receipt && direction === "head";
			if (receiptHead && truncationResult?.truncated) {
				const diskLike = {
					...truncationResult,
					totalBytes: Buffer.byteLength(selectedContent, "utf-8"),
				};
				resultBuilder.truncation(diskLike, {
					direction: "head",
					startLine: startLineDisplay,
					totalFileLines: totalLines,
				});
			} else if (usedLegacyHeadTruncation && truncationResult?.truncated) {
				resultBuilder.truncation(truncationResult, {
					direction: "head",
					startLine: startLineDisplay,
					totalFileLines: totalLines,
				});
			} else {
				// Only a directional window moves notice ownership into the body: its
				// footer names the kept range and the re-read path. A head window keeps
				// the wrapper notice, which carries the `:N to continue` hint instead.
				resultBuilder.truncationWindows(metadataWindow, {
					noticeOwner: bodyFooterPath !== undefined && direction !== "head" ? "body" : undefined,
					maxBytes: direction === "head" ? undefined : budgetBytes,
					rangeBase: metadataRangeBase,
				});
			}
		} else if (truncationResult?.truncated) {
			resultBuilder.truncation(truncationResult, {
				direction: "head",
				startLine: startLineDisplay,
				totalFileLines: totalLines,
			});
		}
		return resultBuilder.done();
	}

	/**
	 * Render a multi-range read against in-memory text. Each range emits a
	 * formatted block with its own anchors / line numbers, blocks are joined
	 * with an elision separator, and ranges past EOF surface as `[…]` notices
	 * so the model can correct the next call. No leading/trailing context is
	 * added — multi-range callers always specify exact bounds.
	 */
	#buildInMemoryMultiRangeResult(
		text: string,
		ranges: readonly LineRange[],
		options: {
			details?: ReadToolDetails;
			sourcePath?: string;
			sourceUrl?: string;
			sourceInternal?: string;
			entityLabel: string;
			raw?: boolean;
			immutable?: boolean;
			truncationDirection?: TruncationDirection;
			cacheLinesFor?: string;
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
		const maxColumns = resolveOutputMaxColumns(this.session.settings);
		const direction = options.truncationDirection ?? "head";
		let columnTruncated = 0;

		const resultBuilder = toolResult(details);
		if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
		if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
		if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

		const renderBlockWindow = (
			window: ReadWindow,
		): { text: string; partialTail?: Extract<ReadSegment, { kind: "partial-line" }> } => {
			const renderSegment = (segment: ReadSegment): string => {
				const hash = shouldAddHashLines && segment.kind === "lines";
				// A partial line is a byte suffix, not a complete source line. Never
				// give it an anchor that could make the preview look fully readable.
				const numbers = !hash && shouldAddLineNumbers && segment.kind === "lines";
				const renderContent =
					!options.raw && !hash && maxColumns > 0
						? segment.content
								.split("\n")
								.map(line => {
									const result = truncateLine(line, maxColumns);
									if (result.wasTruncated) columnTruncated = maxColumns;
									return result.text;
								})
								.join("\n")
						: segment.content;
				return formatTextWithMode(renderContent, segment.origin.startLine, hash, numbers);
			};
			let text = "";
			if (window.kind === "full") text = window.head ? renderSegment(window.head) : "";
			else if (window.kind === "head-only") text = window.head ? renderSegment(window.head) : "";
			else if (window.kind === "tail-only") text = window.tail ? renderSegment(window.tail) : "";
			else {
				const marker = formatMiddleElisionMarker(window.elidedLines, window.elidedBytes);
				if (window.head && window.tail) {
					text =
						window.elidedLines <= 0
							? `${renderSegment(window.head)}\n${renderSegment(window.tail)}`
							: `${renderSegment(window.head)}\n${marker}\n${renderSegment(window.tail)}`;
				}
			}
			return { text, partialTail: partialTailOf(window) };
		};

		const parts: string[] = [];
		let hasPartialSegment = false;
		const outOfBounds: LineRange[] = [];
		for (const range of ranges) {
			if (range.startLine > totalLines) {
				outOfBounds.push(range);
				continue;
			}
			const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
			const blockLines = allLines.slice(range.startLine - 1, effectiveEnd);
			const blockText = blockLines.join("\n");
			const requestedLength = range.endLine !== undefined ? range.endLine - range.startLine + 1 : this.#defaultLimit;
			const blockMaxLines = Math.min(requestedLength, DEFAULT_MAX_LINES);
			const blockMaxBytes = Math.max(DEFAULT_MAX_BYTES, blockMaxLines * 512);
			const relative = selectReadWindow(blockText, blockLines, direction, blockMaxLines, blockMaxBytes);
			const window = rebaseWindow(relative, range.startLine - 1);
			hasPartialSegment ||= windowHasPartialSegment(window);
			const rendered = renderBlockWindow(window);
			let blockOutput = rendered.text;
			if (rendered.partialTail) {
				const disclosurePath =
					options.sourceInternal ?? options.sourceUrl ?? options.sourcePath ?? options.entityLabel;
				blockOutput = shouldAddHashLines
					? formatOversizedLineWarning(
							disclosurePath,
							rendered.partialTail.origin.startLine,
							rendered.partialTail.sourceLineBytes,
							blockMaxBytes,
							totalLines,
						)
					: `${blockOutput}\n\n${formatDirectionalFooter(disclosurePath, window)}`;
			}
			parts.push(blockOutput);
			if (options.cacheLinesFor && !windowHasPartialSegment(window)) {
				for (const segment of windowSegments(window)) {
					if (segment.kind === "lines" && segment.lines > 0) {
						getFileReadCache(this.session).recordContiguous(
							options.cacheLinesFor,
							segment.origin.startLine,
							linesOfSegment(segment),
						);
					}
				}
			}
		}

		const outputText = parts.length > 0 ? parts.join("\n\n…\n\n") : "";
		const notices: string[] = [];
		for (const range of outOfBounds) {
			const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
			notices.push(`[Range ${bound} is beyond end of ${options.entityLabel} (${totalLines} lines total); skipped]`);
		}
		const finalText =
			notices.length > 0 ? (outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n")) : outputText;
		details.spillEligible = parts.length > 0 && !hasPartialSegment;
		resultBuilder.text(finalText);
		if (columnTruncated > 0) resultBuilder.limits({ columnMax: columnTruncated });
		return resultBuilder.done();
	}

	/**
	 * Stream multiple non-contiguous ranges from a local file. ACP bridge takes
	 * priority when present (editor buffer is source of truth); otherwise each
	 * range is streamed independently with its own line/byte budget. Out-of-bounds
	 * ranges surface as inline notices rather than aborting the read.
	 */
	async #readLocalFileMultiRange(
		absolutePath: string,
		ranges: readonly LineRange[],
		parsed: ParsedSelector,
		displayMode: { hashLines: boolean; lineNumbers: boolean },
		suffixResolution: { from: string; to: string } | undefined,
		signal: AbortSignal | undefined,
		direction: TruncationDirection,
	): Promise<{
		outputText: string;
		contentLineCount: number;
		columnTruncated: number;
		bridgeResult?: AgentToolResult<ReadToolDetails>;
	}> {
		const rawSelector = isRawSelector(parsed);

		// ACP bridge first — the editor's in-memory buffer is source of truth.
		const bridgePromise = this.#routeReadThroughBridge(absolutePath);
		if (bridgePromise !== undefined) {
			try {
				const bridgeText = await bridgePromise;
				const bridgeResult = this.#buildInMemoryMultiRangeResult(bridgeText, ranges, {
					details: { resolvedPath: absolutePath, suffixResolution },
					sourcePath: absolutePath,
					entityLabel: "file",
					raw: rawSelector,
					truncationDirection: direction,
					cacheLinesFor: absolutePath,
				});
				if (suffixResolution) {
					const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
					const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
					if (firstText) firstText.text = `${notice}\n${firstText.text}`;
				}
				return { outputText: "", contentLineCount: 0, columnTruncated: 0, bridgeResult };
			} catch (error) {
				if (isClientAuthorityDenial(error)) throw error;
				logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
			}
		}

		// The legacy stream collector remains the head/default implementation.
		// Directional multi-range reads use the same materialized window oracle as
		// ACP so each block has identical bytes, anchors, and cache entries.
		if (direction !== "head") {
			const diskText = await Bun.file(absolutePath).text();
			const result = this.#buildInMemoryMultiRangeResult(diskText, ranges, {
				details: { resolvedPath: absolutePath, suffixResolution },
				sourcePath: absolutePath,
				entityLabel: "file",
				raw: rawSelector,
				truncationDirection: direction,
				cacheLinesFor: absolutePath,
			});
			const firstText = result.content.find((content): content is TextContent => content.type === "text");
			if (suffixResolution && firstText) {
				const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
				firstText.text = `${notice}\n${firstText.text}`;
			}
			return { outputText: "", contentLineCount: 0, columnTruncated: 0, bridgeResult: result };
		}

		const shouldAddHashLines = !rawSelector && displayMode.hashLines;
		const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
		const maxColumns = resolveOutputMaxColumns(this.session.settings);

		const blocks: string[] = [];
		const notices: string[] = [];
		let columnTruncated = 0;
		let contentLineCount = 0;

		for (const range of ranges) {
			const rangeStart = range.startLine - 1; // 0-indexed
			const requestedLength = range.endLine !== undefined ? range.endLine - range.startLine + 1 : this.#defaultLimit;
			const maxLines = Math.min(requestedLength, DEFAULT_MAX_LINES);
			const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLines * 512);

			const streamResult = await streamLinesFromFile(
				absolutePath,
				rangeStart,
				maxLines,
				maxBytesForRead,
				maxLines,
				signal,
			);
			const totalFileLines = streamResult.totalFileLines;

			if (rangeStart >= totalFileLines) {
				const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
				notices.push(`[Range ${bound} is beyond end of file (${totalFileLines} lines total); skipped]`);
				continue;
			}

			const collectedLines = streamResult.lines;
			const cacheLines = collectedLines.slice();
			if (!rawSelector && !shouldAddHashLines && maxColumns > 0) {
				for (let i = 0; i < collectedLines.length; i++) {
					const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
					if (wasTruncated) {
						collectedLines[i] = text;
						columnTruncated = maxColumns;
					}
				}
			}

			contentLineCount += collectedLines.length;
			if (cacheLines.length > 0) {
				getFileReadCache(this.session).recordContiguous(absolutePath, range.startLine, cacheLines);
			}

			const blockText = collectedLines.join("\n");
			blocks.push(formatTextWithMode(blockText, range.startLine, shouldAddHashLines, shouldAddLineNumbers));
		}

		let outputText = blocks.join("\n\n…\n\n");
		if (notices.length > 0) {
			outputText = outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n");
		}
		return { outputText, contentLineCount, columnTruncated };
	}

	async #readArchiveDirectory(
		archive: ArchiveReader,
		archivePath: string,
		subPath: string,
		limit: number | undefined,
		details: ReadToolDetails,
		direction: TruncationDirection,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const DEFAULT_LIMIT = 500;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;
		const entries = archive.listDirectory(subPath);

		const listLimit = applyListLimit(entries, { limit: effectiveLimit });
		const limitedEntries = listLimit.items;
		const limitMeta = listLimit.meta;

		const results: string[] = [];
		for (const entry of limitedEntries) {
			throwIfAborted(signal);
			if (entry.isDirectory) {
				results.push(`${entry.name}/`);
				continue;
			}

			const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
			results.push(`${entry.name}${sizeSuffix}`);
		}

		const output = results.length > 0 ? results.join("\n") : "(empty archive directory)";
		const window = selectReadWindow(output, results, direction, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_BYTES);
		const rendered = prependSuffixResolutionNotice(renderReadWindow(window, false, false), details.suffixResolution);
		const directoryDetails: ReadToolDetails = {
			...details,
			isDirectory: true,
			...(window.kind !== "full" ? { truncation: makeWindowResult(window, output) } : {}),
		};
		const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(rendered);
		resultBuilder.sourcePath(archivePath).limits({ resultLimit: limitMeta.resultLimit?.reached });
		if (window.kind !== "full") {
			if (direction === "head") {
				resultBuilder.truncation(makeWindowResult(window, output), { direction: "head" });
			} else {
				resultBuilder.truncationWindows(window, { maxBytes: DEFAULT_MAX_BYTES });
			}
		}
		return resultBuilder.done();
	}

	async #readArchive(
		readPath: string,
		parsedSel: ParsedSelector,
		resolvedArchivePath: ResolvedArchiveReadPath,
		signal?: AbortSignal,
		truncationParam?: TruncationDirection,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		const archive = await openArchive(resolvedArchivePath.absolutePath);
		throwIfAborted(signal);

		const details: ReadToolDetails = {
			resolvedPath: resolvedArchivePath.absolutePath,
			suffixResolution: resolvedArchivePath.suffixResolution,
		};

		const node = archive.getNode(resolvedArchivePath.archiveSubPath);
		if (!node) {
			throw new ToolError(`Path '${readPath}' not found inside archive`);
		}
		const route: ReadRoute = node.isDirectory
			? "dir-archive"
			: isMultiRange(parsedSel)
				? "local-multi-range"
				: parsedSel.kind === "none"
					? "archive-member-bare"
					: "local-range";
		const direction = resolveEffectiveDirection(truncationParam, route, this.session.settings);

		if (node.isDirectory) {
			if (isMultiRange(parsedSel)) {
				throw new ToolError("Multi-range line selectors are not supported for archive directory listings.");
			}
			const { limit } = selToOffsetLimit(parsedSel);
			return this.#readArchiveDirectory(
				archive,
				resolvedArchivePath.absolutePath,
				resolvedArchivePath.archiveSubPath,
				limit,
				details,
				direction,
				signal,
			);
		}

		const entry = await archive.readFile(resolvedArchivePath.archiveSubPath);
		const text = decodeUtf8Text(entry.bytes);
		if (text === null && truncationParam !== undefined && truncationParam !== "head") {
			throw new ToolError("Explicit truncation for binary archive entries is not yet supported.");
		}
		if (text === null) {
			return toolResult<ReadToolDetails>(details)
				.text(
					prependSuffixResolutionNotice(
						`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`,
						resolvedArchivePath.suffixResolution,
					),
				)
				.sourcePath(resolvedArchivePath.absolutePath)
				.done();
		}

		const raw = isRawSelector(parsedSel);
		const result =
			isMultiRange(parsedSel) && parsedSel.kind === "lines"
				? this.#buildInMemoryMultiRangeResult(text, parsedSel.ranges, {
						details,
						sourcePath: resolvedArchivePath.absolutePath,
						entityLabel: "archive entry",
						raw,
						truncationDirection: direction,
					})
				: this.#buildInMemoryTextResult(
						text,
						selToOffsetLimit(parsedSel).offset,
						selToOffsetLimit(parsedSel).limit,
						{
							details,
							sourcePath: resolvedArchivePath.absolutePath,
							entityLabel: "archive entry",
							raw,
							truncationDirection: direction,
							bodyFooterPath: parsedSel.kind === "none" ? readPath : undefined,
						},
					);
		const firstText = result.content.find((content): content is TextContent => content.type === "text");
		if (firstText) {
			firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
		}
		return result;
	}

	async #readSqlite(
		resolvedSqlitePath: ResolvedSqliteReadPath,
		signal?: AbortSignal,
		truncationParam?: TruncationDirection,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);

		const selectorInput = {
			subPath: resolvedSqlitePath.sqliteSubPath,
			queryString: resolvedSqlitePath.queryString,
		};
		const selector = parseSqliteSelector(selectorInput.subPath, selectorInput.queryString);
		const details: ReadToolDetails = {
			resolvedPath: resolvedSqlitePath.absolutePath,
			suffixResolution: resolvedSqlitePath.suffixResolution,
		};
		const sqliteRoute: ReadRoute = selector.kind === "list" ? "sqlite-list" : "sqlite-rows";
		const direction = resolveEffectiveDirection(truncationParam, sqliteRoute, this.session.settings);
		// SQLite row/schema/query/raw selectors are row-selection routes: queryRows and
		// executeReadQuery apply their SQL row limits, while renderRow/renderTable only
		// cap individual cell width. No rendered-output truncator runs on these paths.
		// Keep explicit direction as a deliberate no-op there; sqlite-list below
		// truncates only its rendered table listing.

		let db: Database | null = null;
		try {
			db = new Database(resolvedSqlitePath.absolutePath, { readonly: true, strict: true });
			enforceSqliteQueryOnly(db);
			db.run("PRAGMA busy_timeout = 3000");
			throwIfAborted(signal);

			switch (selector.kind) {
				case "list": {
					const listLimit = applyListLimit(listTables(db), { limit: 500 });
					const body = renderTableList(listLimit.items);
					const window = selectReadWindow(
						body,
						body.split("\n"),
						direction,
						Number.MAX_SAFE_INTEGER,
						DEFAULT_MAX_BYTES,
					);
					const rendered = prependSuffixResolutionNotice(
						renderReadWindow(window, false, false),
						resolvedSqlitePath.suffixResolution,
					);
					details.truncation = window.kind !== "full" ? makeWindowResult(window, body) : undefined;
					const resultBuilder = toolResult<ReadToolDetails>(details)
						.text(rendered)
						.sourcePath(resolvedSqlitePath.absolutePath)
						.limits({ resultLimit: listLimit.meta.resultLimit?.reached });
					if (window.kind !== "full") {
						if (direction === "head") {
							resultBuilder.truncation(makeWindowResult(window, body), { direction: "head" });
						} else {
							resultBuilder.truncationWindows(window, { maxBytes: DEFAULT_MAX_BYTES });
						}
					}
					return resultBuilder.done();
				}
				case "schema": {
					const sampleRows = queryRows(db, selector.table, { limit: selector.sampleLimit, offset: 0 });
					let output = renderSchema(getTableSchema(db, selector.table), {
						columns: sampleRows.columns,
						rows: sampleRows.rows,
					});
					if (sampleRows.rows.length < sampleRows.totalCount) {
						const remaining = sampleRows.totalCount - sampleRows.rows.length;
						output += `\n[${remaining} more rows; append :${selector.table}?limit=20&offset=${sampleRows.rows.length} to the database path to continue]`;
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution))
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
				case "row": {
					const lookup = resolveTableRowLookup(db, selector.table);
					const row =
						lookup.kind === "pk"
							? getRowByKey(db, selector.table, lookup, selector.key)
							: getRowByRowId(db, selector.table, selector.key);
					if (!row) {
						return toolResult<ReadToolDetails>(details)
							.text(
								prependSuffixResolutionNotice(
									`No row found in table '${selector.table}' for key '${selector.key}'.`,
									resolvedSqlitePath.suffixResolution,
								),
							)
							.sourcePath(resolvedSqlitePath.absolutePath)
							.done();
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(renderRow(row), resolvedSqlitePath.suffixResolution))
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
				case "query": {
					const page = queryRows(db, selector.table, selector);
					return toolResult<ReadToolDetails>(details)
						.text(
							prependSuffixResolutionNotice(
								renderTable(page.columns, page.rows, {
									totalCount: page.totalCount,
									offset: selector.offset,
									limit: selector.limit,
									table: selector.table,
									dbPath: resolvedSqlitePath.absolutePath,
								}),
								resolvedSqlitePath.suffixResolution,
							),
						)
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
				case "raw": {
					const result = executeReadQuery(db, selector.sql);
					const table = renderTable(result.columns, result.rows, {
						totalCount: result.rows.length,
						offset: 0,
						limit: result.rows.length || DEFAULT_MAX_LINES,
						table: "query",
						dbPath: resolvedSqlitePath.absolutePath,
					});
					const body = result.truncated
						? `${table}\n\n[Output truncated to the first ${result.rows.length} rows; add a LIMIT clause to the query to bound or page the result.]`
						: table;
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(body, resolvedSqlitePath.suffixResolution))
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
			}

			throw new ToolError("Unsupported SQLite selector");
		} catch (error) {
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
	}

	#routeReadThroughBridge(
		absolutePath: string,
		options?: { line?: number; limit?: number },
	): Promise<string> | undefined {
		const bridge = this.session.getClientBridge?.();
		if (!bridge?.capabilities.readTextFile || !bridge.readTextFile) return undefined;
		return bridge.readTextFile({ path: absolutePath, ...options });
	}
	async #readMissingPathThroughBridge(
		absolutePath: string,
		parsed: ParsedSelector,
		_localReadPath: string,
		truncation: TruncationDirection | undefined,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReadToolDetails> | undefined> {
		const bridgePromise = this.#routeReadThroughBridge(absolutePath);
		if (bridgePromise === undefined) return undefined;
		throwIfAborted(signal);
		try {
			const bridgeText = await bridgePromise;
			if (parsed.kind === "conflicts") return undefined;
			const bareEligible = parsed.kind === "none";
			const route = isMultiRange(parsed)
				? "local-multi-range"
				: bareEligible
					? "local-bare-stream"
					: isRawSelector(parsed)
						? "local-raw"
						: "local-range";
			const direction = resolveEffectiveDirection(truncation, route, this.session.settings);
			if (isMultiRange(parsed) && parsed.kind === "lines") {
				return this.#buildInMemoryMultiRangeResult(bridgeText, parsed.ranges, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "file",
					raw: isRawSelector(parsed),
					truncationDirection: direction,
					cacheLinesFor: absolutePath,
				});
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#buildInMemoryTextResult(bridgeText, offset, limit, {
				details: { resolvedPath: absolutePath },
				sourcePath: absolutePath,
				entityLabel: "file",
				raw: isRawSelector(parsed),
				cacheLinesFor: absolutePath,
				truncationDirection: direction,
			});
		} catch (error) {
			if (isClientAuthorityDenial(error)) throw error;
			logger.warn("ACP fs readTextFile failed for a path missing on disk", { path: absolutePath, error });
			return undefined;
		}
	}

	async #trySummarize(absolutePath: string, fileSize: number, signal?: AbortSignal): Promise<SummaryResult | null> {
		if (fileSize > MAX_SUMMARY_BYTES) return null;

		try {
			throwIfAborted(signal);
			const bridgePromise = this.#routeReadThroughBridge(absolutePath);
			let code: string;
			if (bridgePromise !== undefined) {
				try {
					code = await bridgePromise;
				} catch (error) {
					if (isClientAuthorityDenial(error)) throw error;
					code = await Bun.file(absolutePath).text();
				}
			} else {
				code = await Bun.file(absolutePath).text();
			}
			throwIfAborted(signal);
			if (countTextLines(code) > MAX_SUMMARY_LINES) return null;

			const summarizeCode = (await nativeRead()).summarizeCode;
			return await summarizeCode({
				code,
				path: absolutePath,
				minBodyLines: this.session.settings.get("read.summarize.minBodyLines"),
				minCommentLines: this.session.settings.get("read.summarize.minCommentLines"),
			});
		} catch (error) {
			if (isClientAuthorityDenial(error)) throw error;
			return null;
		}
	}

	#renderSummary(summary: SummaryResult): {
		text: string;
		displayText: string;
		elidedSpans: number;
		elidedLines: number;
		capped: boolean;
	} {
		const displayMode = resolveFileDisplayMode(this.session);
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		// Flatten segments into per-line units so we can merge a kept-head /
		// elided / kept-tail sandwich into a single brace-pair line when the
		// boundary lines look like `… {` and `}` (or matching variants).
		type Unit =
			| { kind: "line"; line: number; text: string }
			| { kind: "elided"; startLine: number; endLine: number }
			| {
					kind: "merged";
					startLine: number;
					endLine: number;
					headText: string;
					tailText: string;
			  };

		const raw: Unit[] = [];
		for (const segment of summary.segments) {
			if (segment.kind === "elided") {
				raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
				continue;
			}
			const text = segment.text ?? "";
			if (text.length === 0) continue;
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
			}
		}

		const units: Unit[] = [];
		let i = 0;
		while (i < raw.length) {
			const cur = raw[i];
			if (cur.kind === "elided") {
				const prev = units.length > 0 ? units[units.length - 1] : null;
				const next = i + 1 < raw.length ? raw[i + 1] : null;
				if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
					units.pop();
					units.push({
						kind: "merged",
						startLine: prev.line,
						endLine: next.line,
						headText: prev.text,
						tailText: next.text,
					});
					i += 2;
					continue;
				}
			}
			units.push(cur);
			i++;
		}

		const modelParts: string[] = [];
		const displayParts: string[] = [];
		const capBytes = this.session.settings.get("read.summaryMaxBytes") * 1024;
		let usedBytes = 0;
		let elidedSpans = 0;
		let elidedLines = 0;
		let capDropped = false;
		for (const unit of units) {
			let model: string;
			let display: string;
			let implicitElidedLines = 0;
			if (unit.kind === "elided") {
				model = display = "...";
				implicitElidedLines = unit.endLine - unit.startLine + 1;
			} else if (unit.kind === "merged") {
				const formatted = formatMergedBraceLine(
					unit.startLine,
					unit.endLine,
					unit.headText,
					unit.tailText,
					shouldAddHashLines,
					shouldAddLineNumbers,
				);
				model = formatted.model;
				display = formatted.display;
				implicitElidedLines = Math.max(0, unit.endLine - unit.startLine - 1);
			} else {
				model = formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers);
				display = unit.text;
			}
			const separatorBytes = modelParts.length > 0 ? 1 : 0;
			if (usedBytes + separatorBytes + Buffer.byteLength(model, "utf-8") > capBytes) {
				capDropped = true;
				elidedSpans++;
				elidedLines += unit.kind === "line" ? 1 : unit.endLine - unit.startLine + 1;
				continue;
			}
			usedBytes += separatorBytes + Buffer.byteLength(model, "utf-8");
			modelParts.push(model);
			displayParts.push(display);
			if (unit.kind === "elided" || unit.kind === "merged") {
				elidedSpans++;
				elidedLines += implicitElidedLines;
			}
		}
		if (capDropped) {
			modelParts.push("…");
			displayParts.push("…");
		}
		return {
			text: modelParts.join("\n"),
			displayText: displayParts.join("\n"),
			elidedSpans,
			elidedLines,
			capped: capDropped,
		};
	}

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		let { path: readPath } = params;
		if (readPath.startsWith("file://")) {
			readPath = expandPath(readPath);
		}

		const conflictUri = parseConflictUri(readPath);
		if (conflictUri) {
			if (conflictUri.id === "*") {
				throw new ToolError(
					"Reading `conflict://*` is not supported — wildcards are write-only. Use the `<path>:conflicts` read selector for the full list of conflicts in a file, or read `conflict://<N>` to inspect a single block.",
				);
			}
			if (params.truncation !== undefined && params.truncation !== "head") {
				throw new ToolError("Explicit truncation for conflict:// regions is not yet supported.");
			}
			return this.#readConflictRegion(conflictUri.id, conflictUri.scope);
		}
		const displayMode = resolveFileDisplayMode(this.session);

		const parsedUrlTarget = parseReadUrlTarget(readPath);
		if (parsedUrlTarget) {
			if (!this.session.settings.get("fetch.enabled")) {
				throw new ToolError("URL reads are disabled by settings.");
			}
			if (parsedUrlTarget.offset !== undefined || parsedUrlTarget.limit !== undefined) {
				const cached = await loadReadUrlCacheEntry(
					this.session,
					{ path: parsedUrlTarget.path, raw: parsedUrlTarget.raw },
					signal,
					{
						ensureArtifact: true,
						preferCached: true,
					},
				);
				const requestedDirection = resolveEffectiveDirection(
					params.truncation,
					"url-cache-page",
					this.session.settings,
				);
				const direction =
					requestedDirection !== "head" && cached.wrappedPreambleChars === undefined ? "head" : requestedDirection;
				const selectorInput = prepareReadUrlSelectorInput(
					cached.output,
					cached.preambleChars,
					cached.wrappedPreambleChars,
				);

				return this.#buildInMemoryTextResult(selectorInput.text, parsedUrlTarget.offset, parsedUrlTarget.limit, {
					details: { ...cached.details },
					sourceUrl: cached.details.finalUrl,
					entityLabel: "URL output",
					immutable: true,
					wrapUntrusted: true,
					truncationDirection: direction,
					protectedPrefixChars: selectorInput.preambleChars,
					truncationMetadataBodyRelative: true,
				});
			}
			return executeReadUrl(
				this.session,
				{ path: parsedUrlTarget.path, raw: parsedUrlTarget.raw },
				signal,
				resolveEffectiveDirection(params.truncation, "url-reader", this.session.settings),
			);
		}

		// Handle internal URLs (agent://, artifact://, memory://, rule://, local://, gjc://, issue://, pr://).
		// Use the internal-URL-aware splitter so malformed selectors are peeled
		// off the URL and surfaced via parseSel rather than confusing handlers.
		const internalRouter = InternalUrlRouter.instance();
		if (internalRouter.canHandle(readPath)) {
			const internalTarget = splitInternalUrlSel(readPath, {
				activeSkillNames: (this.session.skills ?? []).map(skill => skill.name),
			});
			const parsed = parseSel(internalTarget.sel);
			if (internalTarget.sel !== undefined && parsed.kind === "none") {
				throw new ToolError(`Invalid internal URL selector "${internalTarget.sel}".`);
			}
			return this.#handleInternalUrl(internalTarget.path, parsed, signal, params.truncation);
		}

		const archivePath = await this.#resolveArchiveReadPath(readPath, signal);
		if (archivePath) {
			const archiveSubPath = splitPathAndSel(archivePath.archiveSubPath);
			const archiveParsed = parseSel(archiveSubPath.sel);
			return this.#readArchive(
				readPath,
				archiveParsed,
				{ ...archivePath, archiveSubPath: archiveSubPath.path },
				signal,
				params.truncation,
			);
		}

		const sqlitePath = await this.#resolveSqliteReadPath(readPath, signal);
		if (sqlitePath) {
			return this.#readSqlite(sqlitePath, signal, params.truncation);
		}

		const localTarget = splitPathAndSel(readPath);
		const localReadPath = localTarget.path;
		const parsed = parseSel(localTarget.sel);

		let absolutePath = resolveReadPath(localReadPath, this.session.cwd);
		let suffixResolution: { from: string; to: string } | undefined;

		let isDirectory = false;
		let fileSize = 0;
		try {
			const stat = await Bun.file(absolutePath).stat();
			fileSize = stat.size;
			isDirectory = stat.isDirectory();
		} catch (error) {
			if (isNotFoundError(error)) {
				const bridged = await this.#readMissingPathThroughBridge(
					absolutePath,
					parsed,
					localReadPath,
					params.truncation,
					signal,
				);
				if (bridged) return bridged;
				// Attempt unique suffix resolution before falling back to fuzzy suggestions
				if (!isRemoteMountPath(absolutePath)) {
					const suffixMatch = await findUniqueSuffixMatch(localReadPath, this.session.cwd, signal);
					if (suffixMatch) {
						try {
							const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
							absolutePath = suffixMatch.absolutePath;
							fileSize = retryStat.size;
							isDirectory = retryStat.isDirectory();
							suffixResolution = { from: localReadPath, to: suffixMatch.displayPath };
						} catch {
							// Suffix match candidate no longer stats — fall through to error path
						}
					}
				}

				if (!suffixResolution) {
					throw new ToolError(`Path '${localReadPath}' not found`);
				}
			} else {
				throw error;
			}
		}

		if (isDirectory) {
			if (isMultiRange(parsed)) {
				throw new ToolError("Multi-range line selectors are not supported for directory listings.");
			}
			const dirDirection = resolveEffectiveDirection(params.truncation, "dir-local", this.session.settings);
			const dirResult = await this.#readDirectory(
				absolutePath,
				selToOffsetLimit(parsed).limit,
				dirDirection,
				signal,
			);

			if (suffixResolution) {
				dirResult.details ??= {};
				dirResult.details.suffixResolution = suffixResolution;
			}
			return dirResult;
		}

		if (parsed.kind === "conflicts") {
			return this.#readFileConflicts(absolutePath, suffixResolution, signal, params.truncation);
		}

		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const shouldConvertWithMarkit = CONVERTIBLE_EXTENSIONS.has(ext);
		// Read the file based on type
		let content: Array<TextContent | ImageContent> | undefined;
		let details: ReadToolDetails = {};
		let sourcePath: string | undefined;
		let columnTruncated = 0;
		let truncationInfo:
			| {
					result: TruncationResult;
					options: {
						direction: "head";
						startLine?: number;
						totalFileLines?: number;
						noticeOwner?: "body";
						maxBytes?: number;
					};
			  }
			| undefined;
		let directionalWindow: ReadWindow | undefined;
		let directionalNoticeOwner: "body" | undefined;
		let directionalRangeBase: "file" | "window" | undefined;

		if (mimeType) {
			if (params.truncation !== undefined && params.truncation !== "head") {
				throw new ToolError("Explicit truncation for image reads is not yet supported.");
			}
			if (fileSize > MAX_IMAGE_SIZE) {
				const sizeStr = formatBytes(fileSize);
				const maxStr = formatBytes(MAX_IMAGE_SIZE);
				throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
			}
			try {
				const imageInput = await loadImageInput({
					path: readPath,
					cwd: this.session.cwd,
					autoResize: this.#autoResizeImages,
					maxBytes: MAX_IMAGE_SIZE,
					resolvedPath: absolutePath,
					detectedMimeType: mimeType,
				});
				if (!imageInput) {
					throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
				}
				content = [
					{ type: "text", text: imageInput.textNote },
					{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
				];
				details = {};
				sourcePath = imageInput.resolvedPath;
			} catch (error) {
				if (error instanceof ImageInputTooLargeError) {
					throw new ToolError(error.message);
				}
				throw error;
			}
		} else if (isNotebookPath(absolutePath) && !isRawSelector(parsed)) {
			const notebookText = await readEditableNotebookText(absolutePath, localReadPath);
			const direction = resolveEffectiveDirection(params.truncation, "converted", this.session.settings);
			if (isMultiRange(parsed) && parsed.kind === "lines") {
				return this.#buildInMemoryMultiRangeResult(notebookText, parsed.ranges, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "notebook",
					truncationDirection: direction,
				});
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#buildInMemoryTextResult(notebookText, offset, limit, {
				details: { resolvedPath: absolutePath },
				sourcePath: absolutePath,
				entityLabel: "notebook",
				spillEligible: parsed.kind !== "none",
				resultByteCeiling:
					parsed.kind !== "none"
						? Math.max(
								RAW_COLLECTOR_MAX_BYTES,
								this.session.settings.get("tools.readArtifactSpillThreshold") * 1024,
							)
						: undefined,
				receiptPath: parsed.kind === "none" ? localReadPath : undefined,
				truncationDirection: direction,
			});
		} else if (shouldConvertWithMarkit) {
			const result = await convertFileWithMarkit(absolutePath, signal);
			if (result.ok) {
				const direction = resolveEffectiveDirection(params.truncation, "converted", this.session.settings);
				const { offset, limit } = selToOffsetLimit(parsed);
				return this.#buildInMemoryTextResult(result.content, offset, limit, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "converted document",
					raw: isRawSelector(parsed),
					spillEligible: parsed.kind !== "none",
					resultByteCeiling:
						parsed.kind !== "none"
							? Math.max(
									RAW_COLLECTOR_MAX_BYTES,
									this.session.settings.get("tools.readArtifactSpillThreshold") * 1024,
								)
							: undefined,
					receiptPath: parsed.kind === "none" ? localReadPath : undefined,
					truncationDirection: direction,
				});
			}
			content = [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }];
			details = { spillEligible: false };
		} else {
			if (
				parsed.kind === "none" &&
				this.session.settings.get("read.summarize.enabled") &&
				(this.session.settings.get("read.summarize.prose") || !PROSE_SUMMARY_EXTENSIONS.has(ext))
			) {
				const summary = await this.#trySummarize(absolutePath, fileSize, signal);
				if (params.truncation !== undefined && params.truncation !== "head" && summary?.parsed) {
					throw new ToolError(
						"Explicit truncation for structural summaries is not yet supported; summary direction will be applied after summary units become directional.",
					);
				}
				if (summary?.parsed && summary.elided) {
					const renderedSummary = this.#renderSummary(summary);
					const footer = formatSummaryElisionFooter(
						localReadPath,
						renderedSummary.elidedSpans,
						renderedSummary.elidedLines,
					);
					const summaryTotalLines = Math.max(...summary.segments.map(segment => segment.endLine));
					const modelText = [
						renderedSummary.text,
						footer,
						renderedSummary.capped
							? formatSummaryCapFooter(
									localReadPath,
									this.session.settings.get("read.summaryMaxBytes") * 1024,
									summaryTotalLines,
								)
							: "",
					]
						.filter(Boolean)
						.join("\n\n");
					details = {
						spillEligible: false,
						displayContent: { text: renderedSummary.displayText, startLine: 1 },
						summary: {
							lines: countTextLines(renderedSummary.text),
							elidedSpans: renderedSummary.elidedSpans,
							elidedLines: renderedSummary.elidedLines,
						},
					};

					sourcePath = absolutePath;
					content = [{ type: "text", text: modelText }];
				}
			}

			if (!content) {
				if (isMultiRange(parsed) && parsed.kind === "lines") {
					const multiDirection = resolveEffectiveDirection(
						params.truncation,
						"local-multi-range",
						this.session.settings,
					);
					const multiResult = await this.#readLocalFileMultiRange(
						absolutePath,
						parsed.ranges,
						parsed,
						displayMode,
						suffixResolution,
						signal,
						multiDirection,
					);
					if (multiResult.bridgeResult) return multiResult.bridgeResult;
					content = [{ type: "text", text: multiResult.outputText }];
					sourcePath = absolutePath;
					details = { spillEligible: multiResult.contentLineCount > 0 };
					if (multiResult.columnTruncated > 0) {
						columnTruncated = multiResult.columnTruncated;
					}
				} else {
					// Raw text or line-range mode
					const { offset, limit } = selToOffsetLimit(parsed);
					const bareEligible = parsed.kind === "none";
					const localDirection = resolveEffectiveDirection(
						params.truncation,
						bareEligible ? "local-bare-stream" : isRawSelector(parsed) ? "local-raw" : "local-range",
						this.session.settings,
					);
					// Try ACP bridge first — editor's in-memory buffer is source of truth.
					// Request full text so local range rendering keeps normal context and line numbers.
					const bridgePromise = this.#routeReadThroughBridge(absolutePath);
					if (bridgePromise !== undefined) {
						try {
							const bridgeText = await bridgePromise;
							const bridgeResult = this.#buildInMemoryTextResult(bridgeText, offset, limit, {
								details: { resolvedPath: absolutePath, suffixResolution },
								sourcePath: absolutePath,
								entityLabel: "file",
								raw: isRawSelector(parsed),
								cacheLinesFor: absolutePath,
								truncationDirection: localDirection,
							});
							if (suffixResolution) {
								const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
								const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
								if (firstText) firstText.text = `${notice}\n${firstText.text}`;
							}
							return bridgeResult;
						} catch (error) {
							if (isClientAuthorityDenial(error)) throw error;
							logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
						}
					}

					// User-requested 0-indexed range start. Lines BEFORE this become
					// leading context (added below if offset is explicit).
					const requestedStart = offset ? Math.max(0, offset - 1) : 0;
					const expandStart = offset !== undefined && offset > 1;
					const expandEnd = limit !== undefined;
					const leadingContext = expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0;
					const trailingContext = expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0;
					const startLine = requestedStart - leadingContext;
					const startLineDisplay = startLine + 1;

					const isBareReceipt = parsed.kind === "none" && !content;
					const rawSelector = isRawSelector(parsed);
					const DEFAULT_LIMIT = this.#defaultLimit;
					const effectiveLimit = rawSelector ? Number.MAX_SAFE_INTEGER : (limit ?? DEFAULT_LIMIT);
					const receiptBudgetBytes = this.session.settings.get("read.receiptBudgetBytes") * 1024;
					const maxLinesToCollect = rawSelector
						? Number.MAX_SAFE_INTEGER
						: isBareReceipt
							? this.session.settings.get("read.receiptBudgetLines")
							: Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
					const selectedLineLimit = rawSelector ? null : effectiveLimit + leadingContext + trailingContext;
					const maxBytesForRead = rawSelector
						? Math.max(
								RAW_COLLECTOR_MAX_BYTES,
								this.session.settings.get("tools.readArtifactSpillThreshold") * 1024,
							)
						: isBareReceipt
							? receiptBudgetBytes
							: Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);
					const collectMode = localDirection === "head" ? "head" : localDirection === "last" ? "tail" : "both";
					const collectEndExclusive =
						rawSelector || isBareReceipt ? null : startLine + effectiveLimit + leadingContext + trailingContext;

					const streamResult = await streamLinesFromFile(
						absolutePath,
						startLine,
						maxLinesToCollect,
						maxBytesForRead,
						selectedLineLimit,
						signal,
						collectMode,
						collectEndExclusive,
					);

					const {
						lines: collectedLines,
						totalFileLines,
						collectedBytes,
						stoppedByByteLimit,
						firstLinePreview,
						firstLineByteLength,
					} = streamResult;

					// Check if offset is out of bounds - return graceful message instead of throwing
					if (requestedStart >= totalFileLines) {
						const suggestion =
							totalFileLines === 0
								? "The file is empty."
								: `Use :1 to read from the start, or :${totalFileLines} to read the last line.`;
						return toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
							.text(
								`Line ${requestedStart + 1} is beyond end of file (${totalFileLines} lines total). ${suggestion}`,
							)
							.done();
					}

					if (collectMode !== "head") {
						const window = streamResultWindow(streamResult, collectMode, startLine, collectEndExclusive);
						const metadataWindow = rebaseWindow(window, -startLine);
						directionalWindow = metadataWindow;
						directionalNoticeOwner = isBareReceipt ? "body" : undefined;
						directionalRangeBase = offset !== undefined && localDirection !== "head" ? "window" : undefined;
						const directionalPartial = windowHasPartialSegment(window);
						const shouldAddDirectionalHashLines = !rawSelector && displayMode.hashLines;
						const shouldAddDirectionalLineNumbers = rawSelector
							? false
							: !shouldAddDirectionalHashLines && displayMode.lineNumbers;
						const directionalMaxColumns = rawSelector ? 0 : resolveOutputMaxColumns(this.session.settings);
						if (!rawSelector && !shouldAddDirectionalHashLines && directionalMaxColumns > 0) {
							for (const segment of windowSegments(window)) {
								if (
									segment.content
										.split("\n")
										.some(line => truncateLine(line, directionalMaxColumns).wasTruncated)
								) {
									columnTruncated = directionalMaxColumns;
									break;
								}
							}
						}
						const selectedContent = windowSegments(window)
							.map(segment => segment.content)
							.join("\n");
						const partialTail = partialTailOf(window);
						const partialTailWarning = partialTail !== undefined && shouldAddDirectionalHashLines;
						if (partialTailWarning) {
							Object.defineProperty(window, "outputLinesOverride", { value: 0, enumerable: false });
							Object.defineProperty(window, "outputBytesOverride", { value: 0, enumerable: false });
							Object.defineProperty(metadataWindow, "outputLinesOverride", { value: 0, enumerable: false });
							Object.defineProperty(metadataWindow, "outputBytesOverride", { value: 0, enumerable: false });
						}
						const baseWindowResult =
							window.kind === "full" ? undefined : makeWindowResult(metadataWindow, selectedContent);
						const windowResult =
							baseWindowResult && partialTailWarning
								? { ...baseWindowResult, outputLines: 0, outputBytes: 0, lastLineExceedsLimit: true }
								: baseWindowResult;
						const rawWindow = renderReadWindow(window, false, false, directionalMaxColumns);
						let outputText = partialTailWarning
							? formatOversizedLineWarning(
									localReadPath,
									partialTail.origin.startLine,
									partialTail.sourceLineBytes,
									maxBytesForRead,
									totalFileLines,
								)
							: renderReadWindow(
									window,
									shouldAddDirectionalHashLines,
									shouldAddDirectionalLineNumbers,
									directionalMaxColumns,
								);
						const windowEnd = Math.min(collectEndExclusive ?? totalFileLines, totalFileLines);
						let bodyFooter: string | undefined;
						if (isBareReceipt && window.kind !== "full" && !partialTailWarning) {
							const footer = formatDirectionalFooter(localReadPath, metadataWindow);
							if (footer) {
								outputText += `\n\n${footer}`;
								bodyFooter = footer;
							}
						}
						if (rawSelector && window.kind !== "full") {
							outputText += `\n\n${formatRawReadCapNotice(maxBytesForRead, fileSize, localDirection)}`;
						}
						if (
							!isBareReceipt &&
							window.kind === "full" &&
							limit !== undefined &&
							startLine < windowEnd &&
							windowEnd < totalFileLines
						) {
							const remaining = totalFileLines - windowEnd;
							outputText += `\n\n[${remaining} more lines in file. Use :${windowEnd + 1} to continue]`;
						}
						details = {
							resolvedPath: absolutePath,
							suffixResolution,
							displayContent: {
								text: rawWindow,
								startLine: window.head?.origin.startLine ?? window.tail?.origin.startLine ?? startLineDisplay,
							},
							...(windowResult ? { truncation: windowResult } : {}),
							spillEligible: !isBareReceipt && selectedContent.length > 0 && !directionalPartial,
						};
						if (bodyFooter) rememberBodyTruncationFooter(details, bodyFooter);
						if (!directionalPartial) {
							for (const segment of windowSegments(window)) {
								if (segment.kind === "lines" && segment.lines > 0) {
									getFileReadCache(this.session).recordContiguous(
										absolutePath,
										segment.origin.startLine,
										linesOfSegment(segment),
									);
								}
							}
						}
						if (!partialTailWarning) {
							const conflictBlocks = windowSegments(window).flatMap(segment =>
								segment.kind === "lines"
									? scanConflictLines(linesOfSegment(segment), segment.origin.startLine)
									: [],
							);
							if (conflictBlocks.length > 0) {
								const history = getConflictHistory(this.session);
								const displayPathForWarning = formatPathRelativeToCwd(absolutePath, this.session.cwd);
								const entries = conflictBlocks.map(block =>
									history.register({
										absolutePath,
										displayPath: displayPathForWarning,
										...block,
									}),
								);
								// Cheap full-file scan only when the window already showed
								// at least one conflict — otherwise pay nothing on clean files.
								let totalInFile = entries.length;
								let scanTruncated = false;
								try {
									const fileScan = await scanFileForConflicts(absolutePath);
									totalInFile = Math.max(entries.length, fileScan.blocks.length);
									scanTruncated = fileScan.scanTruncated;
								} catch {
									// Best-effort enrichment; fall back to window-only count.
								}
								outputText += formatConflictWarning(entries, {
									totalInFile,
									displayPath: displayPathForWarning,
									scanTruncated,
								});
								details.conflictCount = entries.length;
							}
						}
						sourcePath = absolutePath;
						content = [{ type: "text", text: outputText }];
					} else {
						// Per-line column cap. Skipped in raw mode so `:raw` always returns
						// verbatim bytes for paste-back-into-tool workflows. Total byte/line
						// counts in `truncation` keep reflecting the source, not the trimmed
						// view — column truncation surfaces separately via `.limits()`.

						const shouldAddHashLines = !rawSelector && displayMode.hashLines;
						const maxColumns = resolveOutputMaxColumns(this.session.settings);
						if (!rawSelector && !shouldAddHashLines && maxColumns > 0) {
							for (let i = 0; i < collectedLines.length; i++) {
								const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
								if (wasTruncated) {
									collectedLines[i] = text;
									columnTruncated = maxColumns;
								}
							}
						}

						const selectedContent = collectedLines.join("\n");
						const userLimitedLines = collectedLines.length;

						const totalSelectedLines = totalFileLines - startLine;
						const totalSelectedBytes = collectedBytes;
						const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
						const firstLineExceedsLimit =
							firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;

						const truncation: TruncationResult = {
							content: selectedContent,
							truncated: wasTruncated,
							truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
							totalLines: totalSelectedLines,
							totalBytes: totalSelectedBytes,
							outputLines: collectedLines.length,
							outputBytes: collectedBytes,
							lastLinePartial: false,
							firstLineExceedsLimit,
						};

						if (collectedLines.length > 0 && !firstLineExceedsLimit) {
							getFileReadCache(this.session).recordContiguous(absolutePath, startLineDisplay, collectedLines);
						}

						const shouldAddLineNumbers = rawSelector
							? false
							: shouldAddHashLines
								? false
								: displayMode.lineNumbers;
						let capturedDisplayContent: { text: string; startLine: number } | undefined;
						const formatText = (text: string, startNum: number): string => {
							capturedDisplayContent = { text, startLine: startNum };
							return formatTextWithMode(text, startNum, shouldAddHashLines, shouldAddLineNumbers);
						};

						let outputText: string;

						if (truncation.firstLineExceedsLimit) {
							const firstLineBytes = firstLineByteLength ?? 0;
							const snippet = firstLinePreview ?? { text: "", bytes: 0 };

							if (shouldAddHashLines) {
								outputText = `[Line ${startLineDisplay} is ${formatBytes(
									firstLineBytes,
								)}, exceeds ${formatBytes(maxBytesForRead)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
							} else {
								outputText = formatText(snippet.text, startLineDisplay);
							}
							if (snippet.text.length === 0) {
								outputText = `[Line ${startLineDisplay} is ${formatBytes(
									firstLineBytes,
								)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
							}
							details = { truncation, spillEligible: !isBareReceipt && collectedLines.length > 0 };

							sourcePath = absolutePath;
							truncationInfo = {
								result: truncation,
								// Head receipts keep the wrapper notice: it carries the `:N to
								// continue` hint, which the body footer does not duplicate.
								// Only directional windows transfer notice ownership to the body.
								options: { direction: "head", startLine: startLineDisplay, totalFileLines },
							};
						} else if (truncation.truncated) {
							outputText = formatText(truncation.content, startLineDisplay);
							details = { truncation, spillEligible: !isBareReceipt && collectedLines.length > 0 };

							sourcePath = absolutePath;
							truncationInfo = {
								result: truncation,
								options: { direction: "head", startLine: startLineDisplay, totalFileLines },
							};
						} else if (startLine + userLimitedLines < totalFileLines) {
							const remaining = totalFileLines - (startLine + userLimitedLines);
							const nextOffset = startLine + userLimitedLines + 1;

							outputText = formatText(truncation.content, startLineDisplay);
							outputText += `\n\n[${remaining} more lines in file. Use :${nextOffset} to continue]`;
							details = { spillEligible: !isBareReceipt && collectedLines.length > 0 };

							sourcePath = absolutePath;
						} else {
							// No truncation, no user limit exceeded
							outputText = formatText(truncation.content, startLineDisplay);
							details = { spillEligible: !isBareReceipt && collectedLines.length > 0 };

							sourcePath = absolutePath;
						}
						if (isBareReceipt && (truncation.truncated || collectedLines.length < totalFileLines)) {
							outputText += `\n\n${formatReceiptFooter(localReadPath, collectedLines.length, totalFileLines, collectedBytes)}`;
						}
						if (rawSelector && truncation.truncated) {
							outputText += `\n\n${formatRawReadCapNotice(maxBytesForRead, fileSize, localDirection)}`;
						}

						if (capturedDisplayContent) {
							details.displayContent = capturedDisplayContent;
						}

						if (!firstLineExceedsLimit && collectedLines.length > 0) {
							const blocks = scanConflictLines(collectedLines, startLineDisplay);
							if (blocks.length > 0) {
								const history = getConflictHistory(this.session);
								const displayPathForWarning = formatPathRelativeToCwd(absolutePath, this.session.cwd);
								const entries = blocks.map(block =>
									history.register({
										absolutePath,
										displayPath: displayPathForWarning,
										...block,
									}),
								);
								// Cheap full-file scan only when the window already showed
								// at least one conflict — otherwise pay nothing on clean files.
								let totalInFile = entries.length;
								let scanTruncated = false;
								try {
									const fileScan = await scanFileForConflicts(absolutePath);
									totalInFile = Math.max(entries.length, fileScan.blocks.length);
									scanTruncated = fileScan.scanTruncated;
								} catch {
									// Best-effort enrichment; fall back to window-only count.
								}
								outputText += formatConflictWarning(entries, {
									totalInFile,
									displayPath: displayPathForWarning,
									scanTruncated,
								});
								details.conflictCount = entries.length;
							}
						}

						content = [{ type: "text", text: outputText }];
					}
				}
			}
		}

		if (suffixResolution) {
			details.suffixResolution = suffixResolution;
			// Inline resolution notice into first text block so the model sees the actual path
			const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
			const firstText = content.find((c): c is TextContent => c.type === "text");
			if (firstText) {
				firstText.text = `${notice}\n${firstText.text}`;
			} else {
				content = [{ type: "text", text: notice }, ...content];
			}
		}
		const resultBuilder = toolResult(details).content(content);
		if (sourcePath) {
			resultBuilder.sourcePath(sourcePath);
		}
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		if (directionalWindow) {
			resultBuilder.truncationWindows(directionalWindow, {
				noticeOwner: directionalNoticeOwner,
				rangeBase: directionalRangeBase,
			});
		}
		if (columnTruncated > 0) {
			resultBuilder.limits({ columnMax: columnTruncated });
		}
		return resultBuilder.done();
	}

	/**
	 * Render a `conflict://<N>` (or `conflict://<N>/<scope>`) region as
	 * regular file content. The lines are emitted with their original
	 * file line numbers so hashline anchors line up with the source
	 * file, and no truncation footer is appended.
	 */
	async #readConflictRegion(id: number, scope: ConflictScope | undefined): Promise<AgentToolResult<ReadToolDetails>> {
		const entry: ConflictEntry | undefined = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
			);
		}

		const region = renderConflictRegion(entry, scope);
		const displayMode = resolveFileDisplayMode(this.session);
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		const rawText = region.lines.join("\n");
		const formattedText = formatTextWithMode(rawText, region.startLine, shouldAddHashLines, shouldAddLineNumbers);

		const details: ReadToolDetails = {
			resolvedPath: entry.absolutePath,
			displayContent: { text: rawText, startLine: region.startLine },
		};
		return toolResult<ReadToolDetails>(details).text(formattedText).sourcePath(entry.absolutePath).done();
	}

	/**
	 * Implement the `<path>:conflicts` read selector: scan the whole file once, register
	 * every block in the session's conflict history, and return a compact
	 * `#N L_a-L_b` index instead of file content. Designed for heavily
	 * conflicted files where dumping every body would be wasteful.
	 */
	async #readFileConflicts(
		absolutePath: string,
		suffixResolution: { from: string; to: string } | undefined,
		signal: AbortSignal | undefined,
		truncationParam?: TruncationDirection,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		if (truncationParam !== undefined && truncationParam !== "head") {
			throw new ToolError(
				"Explicit truncation for :conflicts indexes is not yet supported; the conflict preamble and bulk-resolve notice will be preserved when a structural index window is added.",
			);
		}

		const scan = await scanFileForConflicts(absolutePath);
		const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
		const history = getConflictHistory(this.session);
		const entries = scan.blocks.map(block =>
			history.register({
				absolutePath,
				displayPath,
				...block,
			}),
		);

		const summary =
			entries.length === 0
				? `No unresolved git merge conflicts in ${displayPath}.`
				: formatConflictSummary(entries, { displayPath, scanTruncated: scan.scanTruncated });

		const details: ReadToolDetails = {
			resolvedPath: absolutePath,
			suffixResolution,
			conflictCount: entries.length,
		};
		return toolResult<ReadToolDetails>(details).text(summary).sourcePath(absolutePath).done();
	}

	/**
	 * Handle internal URLs (agent://, artifact://, memory://, rule://, local://).
	 * Supports pagination via offset/limit but rejects them when query extraction is used.
	 */
	async #handleInternalUrl(
		url: string,
		parsedSel: ParsedSelector,
		signal?: AbortSignal,
		truncationParam?: TruncationDirection,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const internalRouter = InternalUrlRouter.instance();

		// Check if URL has query extraction (agent:// only).
		// Use parseInternalUrl which handles colons in host (namespaced skills).
		let urlMeta: InternalUrl;
		try {
			urlMeta = parseInternalUrl(url);
		} catch (e) {
			throw new ToolError(e instanceof Error ? e.message : String(e));
		}
		const scheme = urlMeta.protocol.replace(/:$/, "").toLowerCase();
		let hasExtraction = false;
		if (scheme === "agent") {
			const hasPathExtraction = urlMeta.pathname && urlMeta.pathname !== "/" && urlMeta.pathname !== "";
			const queryParam = urlMeta.searchParams.get("q");
			const hasQueryExtraction = queryParam !== null && queryParam !== "";
			hasExtraction = hasPathExtraction || hasQueryExtraction;
		}

		// Reject line selectors when query extraction is used
		if (hasExtraction && parsedSel.kind !== "none" && parsedSel.kind !== "raw") {
			throw new ToolError("Cannot combine query extraction with line selectors");
		}

		// Resolve the internal URL
		const resource = await internalRouter.resolve(url, {
			cwd: this.session.cwd,
			getArtifactsDir: this.session.getArtifactsDir,
			getAuthorizedArtifactsDirs: this.session.getAuthorizedArtifactsDirs,
			settings: this.session.settings,
			signal,
			mcpManager: this.session.getMcpManager?.(),
			skills: this.session.skills,
			rules: this.session.rules,
			localProtocolOptions: this.session.localProtocolOptions,
			memoryRoot: this.session.memoryRoot,
		});
		const details: ReadToolDetails = { resolvedPath: resource.sourcePath, contentType: resource.contentType };

		// If extraction was used, return directly (no pagination)
		if (hasExtraction) {
			if (truncationParam !== undefined && truncationParam !== "head") {
				throw new ToolError("Explicit truncation for internal URL query extraction is not yet supported.");
			}
			return toolResult(details).text(resource.content).sourceInternal(url).done();
		}
		const direction = resolveEffectiveDirection(truncationParam, "converted", this.session.settings);

		const raw = isRawSelector(parsedSel);
		if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
			return this.#buildInMemoryMultiRangeResult(resource.content, parsedSel.ranges, {
				details,
				sourcePath: resource.sourcePath,
				sourceInternal: url,
				entityLabel: "resource",
				immutable: resource.immutable,
				raw,
				truncationDirection: direction,
			});
		}

		const { offset, limit } = selToOffsetLimit(parsedSel);
		return this.#buildInMemoryTextResult(resource.content, offset, limit, {
			details,
			sourcePath: resource.sourcePath,
			sourceInternal: url,
			entityLabel: "resource",
			ignoreResultLimits: scheme === "skill",
			immutable: resource.immutable,
			raw,
			truncationDirection: direction,
			bodyFooterPath: parsedSel.kind === "none" && !raw ? url : undefined,
		});
	}

	/** Read directory contents as a formatted listing */
	async #readDirectory(
		absolutePath: string,
		limit: number | undefined,
		direction: TruncationDirection,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const READ_DIRECTORY_MAX_DEPTH = 2;
		const READ_DIRECTORY_CHILD_LIMIT = 12;

		throwIfAborted(signal);
		let tree: DirectoryTree;
		try {
			tree = await buildDirectoryTree(absolutePath, {
				maxDepth: READ_DIRECTORY_MAX_DEPTH,
				perDirLimit: READ_DIRECTORY_CHILD_LIMIT,
				rootLimit: null,
				lineCap: limit ?? null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Cannot read directory: ${message}`);
		}
		throwIfAborted(signal);

		const receiptLines = this.session.settings.get("read.receiptBudgetLines");
		const receiptBytes = this.session.settings.get("read.receiptBudgetBytes") * 1024;
		const sourceLines = tree.totalLines <= 1 ? ["(empty directory)"] : tree.rendered.split("\n");
		const source = sourceLines.join("\n");
		const window = selectReadWindow(source, sourceLines, direction, receiptLines, receiptBytes);
		const shownLines = windowOutputLines(window);
		const shownSegments = windowSegments(window);
		const shownBytes =
			shownSegments.reduce((sum, segment) => sum + segment.bytes, 0) + Math.max(0, shownSegments.length - 1);
		let output = renderReadWindow(window, false, false);
		if (window.kind !== "full" || tree.truncated) {
			output += `\n\n${formatListingTruncationNotice(shownLines, shownBytes, absolutePath, direction)}`;
		}
		const details: ReadToolDetails = {
			isDirectory: true,
			spillEligible: false,
			resolvedPath: tree.rootPath,
			...(window.kind !== "full" && direction !== "head" ? { truncation: makeWindowResult(window, source) } : {}),
		};
		const resultBuilder = toolResult(details).text(output).sourcePath(tree.rootPath);
		if (window.kind !== "full" && direction !== "head")
			resultBuilder.truncationWindows(window, { noticeOwner: "body", maxBytes: receiptBytes });
		return resultBuilder.done();
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface ReadRenderArgs {
	path?: string;
	file_path?: string;
	sel?: string;
	// Legacy fields from old schema — tolerated for in-flight tool calls during transition
	offset?: number;
	limit?: number;
	raw?: boolean;
}

export const readToolRenderer = {
	renderCall(args: ReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		if (isReadableUrlPath(args.file_path || args.path || "")) {
			return renderReadUrlCall(args, _options, uiTheme);
		}

		const rawPath = args.file_path || args.path || "";
		const shortPath = shortenPath(rawPath);
		const linkTarget = tryResolveInternalUrlSync(rawPath);
		const filePath = linkTarget ? fileHyperlink(linkTarget, shortPath) : shortPath;
		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = filePath || "…";
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}

		const text = renderStatusLine({ icon: "pending", title: "Read", description: pathDisplay }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		if (urlDetails?.kind === "url" || isReadableUrlPath(args?.file_path || args?.path || "")) {
			return renderReadUrlResult(
				result as {
					content: Array<{ type: string; text?: string }>;
					details?: ReadUrlToolDetails;
					isError?: boolean;
				},
				options,
				uiTheme,
			);
		}

		if (result.isError) {
			const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const errorText = (rawErrorText || "Unknown error").replace(/^Error:\s*/, "");
			const rawPath = args?.file_path || args?.path || "";
			const filePath = shortenPath(rawPath);
			let title = filePath ? `Read ${filePath}` : "Read";
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			const header = renderStatusLine({ icon: "error", title }, uiTheme);
			const errorLines = errorText.split("\n").map(line => uiTheme.fg("error", replaceTabs(line)));
			const outputBlock = new CachedOutputBlock();
			return {
				render: (width: number) =>
					outputBlock.render({ header, state: "error", sections: [{ lines: errorLines }], width }, uiTheme),
				invalidate: () => outputBlock.invalidate(),
			};
		}
		const details = result.details;
		const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
		// Prefer structured `displayContent` from details when available so the TUI
		// shows clean file content (no model-only hashline anchors) without parsing the formatted text.
		// Fall back to the raw text, but strip the LLM-facing notice so it doesn't
		// echo next to the styled warning line below.
		const contentText = details?.displayContent?.text ?? stripOutputNotice(rawText, details?.meta);
		const imageContent = result.content?.find(c => c.type === "image");
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(splitPathAndSel(rawPath).path);

		const warningLines: string[] = [];
		const truncation = details?.meta?.truncation;
		const fallback = details?.truncation;
		if (details?.resolvedPath) {
			warningLines.push(uiTheme.fg("dim", wrapBrackets(`Resolved path: ${details.resolvedPath}`, uiTheme)));
		}
		if (truncation) {
			if (fallback?.firstLineExceedsLimit) {
				let warning = `First line exceeds ${formatBytes(fallback.outputBytes ?? fallback.totalBytes)} limit`;
				if (truncation.artifactId) {
					warning += `. ${formatFullOutputReference(truncation.artifactId)}`;
				}
				warningLines.push(uiTheme.fg("warning", wrapBrackets(warning, uiTheme)));
			} else {
				const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
				if (warning) warningLines.push(warning);
			}
		}

		if (imageContent) {
			const suffix = details?.suffixResolution;
			const displayPath = suffix ? shortenPath(suffix.to) : filePath || rawPath || "image";
			const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
			const header = renderStatusLine(
				{ icon: suffix ? "warning" : "success", title: "Read", description: `${displayPath}${correction}` },
				uiTheme,
			);
			const detailLines = contentText ? contentText.split("\n").map(line => uiTheme.fg("toolOutput", line)) : [];
			const lines = [...detailLines, ...warningLines];
			const outputBlock = new CachedOutputBlock();
			return {
				render: (width: number) =>
					outputBlock.render(
						{
							header,
							state: "success",
							sections: [
								{
									label: uiTheme.fg("toolTitle", "Details"),
									lines: lines.length > 0 ? lines : [uiTheme.fg("dim", "(image)")],
								},
							],
							width,
						},
						uiTheme,
					),
				invalidate: () => outputBlock.invalidate(),
			};
		}

		const suffix = details?.suffixResolution;
		const plainDisplayPath = suffix ? shortenPath(suffix.to) : filePath;
		// resolvedPath is the absolute fs path for fs-backed reads (regular files plus
		// local:// / memory:// / artifact:// resources). Fall back to a sync
		// resolver for fs-backed internal URLs so the title is clickable even before the
		// result lands or if the handler didn't populate resolvedPath.
		const absForLink = details?.resolvedPath ?? tryResolveInternalUrlSync(rawPath);
		const displayPath = absForLink ? fileHyperlink(absForLink, plainDisplayPath) : plainDisplayPath;
		const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
		let title = displayPath ? `Read ${displayPath}${correction}` : "Read";
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		if (details?.summary) {
			title += ` (summary: ${details.summary.elidedSpans} elided span${details.summary.elidedSpans === 1 ? "" : "s"})`;
		}
		if (details?.conflictCount && details.conflictCount > 0) {
			const n = details.conflictCount;
			title += ` ${uiTheme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
		}
		const rawRequested = args?.raw === true || isRawSelector(parseSel(splitPathAndSel(rawPath).sel));
		const isMarkdown = details?.contentType === "text/markdown" && !rawRequested;
		let cachedWidth: number | undefined;
		let cachedExpanded: boolean | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				const expanded = options.expanded;
				if (cachedLines && cachedWidth === width && cachedExpanded === expanded) return cachedLines;
				cachedLines = isMarkdown
					? renderMarkdownCell(
							{
								content: contentText,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								width,
							},
							uiTheme,
						)
					: renderCodeCell(
							{
								code: contentText,
								language: lang,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								width,
							},
							uiTheme,
						);
				cachedWidth = width;
				cachedExpanded = expanded;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedExpanded = undefined;
				cachedLines = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
