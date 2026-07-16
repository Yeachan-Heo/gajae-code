import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import { glob, type SummaryResult, summarizeCode } from "@gajae-code/natives";
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
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	noTruncResult,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
	truncateLine,
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
	type ReadUrlToolDetails,
	renderReadUrlCall,
	renderReadUrlResult,
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
import { formatBytes, replaceTabs, shortenPath, wrapBrackets } from "./render-utils";
import {
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

// Document types converted to markdown via markit.
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;
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

async function streamLinesFromFile(
	filePath: string,
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
	signal?: AbortSignal,
): Promise<{
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	selectedBytesTotal: number;
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
	let captureLine = false;
	let discardLineChunks = false;
	let lineCaptureLimit = 0;

	const setupLineState = () => {
		captureLine = !doneCollecting && lineIndex >= startLine;
		discardLineChunks = !captureLine;
		if (captureLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			lineCaptureLimit = maxBytes - collectedBytes - separatorBytes;
			if (lineCaptureLimit <= 0) {
				discardLineChunks = true;
			}
		} else {
			lineCaptureLimit = 0;
		}
	};

	const decodeLine = (): string => {
		if (currentLineLength === 0) return "";
		if (currentLineChunks.length === 1 && currentLineChunks[0]?.length === currentLineLength) {
			return currentLineChunks[0].toString("utf-8");
		}
		return Buffer.concat(currentLineChunks, currentLineLength).toString("utf-8");
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

	const appendSegment = (segment: Uint8Array) => {
		currentLineLength += segment.length;
		maybeCapturePreview(segment);
		if (!captureLine || discardLineChunks || segment.length === 0) return;
		if (currentLineLength <= lineCaptureLimit) {
			currentLineChunks.push(Buffer.from(segment));
		} else {
			discardLineChunks = true;
		}
	};

	const finalizeLine = () => {
		if (lineIndex >= startLine && (selectedLineLimit === null || selectedLinesSeen < selectedLineLimit)) {
			selectedBytesTotal += currentLineLength + (selectedLinesSeen > 0 ? 1 : 0);
			selectedLinesSeen++;
		}

		if (!doneCollecting && lineIndex >= startLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			if (collectedLines.length >= maxLinesToCollect) {
				doneCollecting = true;
			} else if (collectedLines.length === 0 && currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
			} else if (collectedLines.length > 0 && collectedBytes + separatorBytes + currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
			} else {
				const lineText = decodeLine();
				collectedLines.push(lineText);
				collectedBytes += separatorBytes + currentLineLength;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
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

		lineIndex++;
		currentLineLength = 0;
		currentLineChunks = [];
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
					if (segment.length > 0) {
						appendSegment(segment);
					}
					finalizeLine();
					start = i + 1;
				}
			}

			if (start < chunk.length) {
				appendSegment(chunk.subarray(start));
			}
		}
	} finally {
		if (fileHandle) {
			await fileHandle.close();
		}
	}

	if (endedWithNewline || currentLineLength > 0 || !sawAnyByte) {
		finalizeLine();
	}

	let firstLinePreview: { text: string; bytes: number } | undefined;
	if (firstLinePreviewBytes > 0) {
		const { text, bytes } = truncateHeadBytes(Buffer.concat(firstLinePreviewChunks, firstLinePreviewBytes), maxBytes);
		firstLinePreview = { text, bytes };
	}

	return {
		lines: collectedLines,
		totalFileLines: lineIndex,
		collectedBytes,
		stoppedByByteLimit,
		firstLinePreview,
		firstLineByteLength,
		selectedBytesTotal,
	};
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
export class ReadTool implements AgentTool<typeof readSchema, ReadToolDetails> {
	readonly name = "read";
	readonly label = "Read";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = readSchema;
	readonly nonAbortable = true;
	readonly strict = true;
	readonly safeSummary = summarizeReadToolActivity;

	readonly #autoResizeImages: boolean;
	readonly #defaultLimit: number;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.#autoResizeImages = session.settings.get("images.autoResize");
		this.#defaultLimit = Math.max(
			1,
			Math.min(session.settings.get("read.defaultLimit") ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES),
		);
		this.description = prompt.render(readDescription, {
			DEFAULT_LIMIT: String(this.#defaultLimit),
			DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
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
			sourceUrl?: string;
			sourceInternal?: string;
			entityLabel: string;
			ignoreResultLimits?: boolean;
			raw?: boolean;
			immutable?: boolean;
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		// User-requested 0-indexed range start. Lines BEFORE this are leading
		// context (added below if offset is explicit).
		const requestedStart = offset ? Math.max(0, offset - 1) : 0;
		const ignoreResultLimits = options.ignoreResultLimits ?? false;
		const requestedEnd = limit !== undefined ? Math.min(requestedStart + limit, allLines.length) : allLines.length;
		// Expand only on sides the user actually constrained: leading context
		// when offset>1, trailing context when a finite limit was set.
		const expanded = expandRangeWithContext(
			requestedStart,
			requestedEnd,
			allLines.length,
			offset !== undefined && offset > 1,
			limit !== undefined,
		);
		const startLine = expanded.startLine;
		const endLineExpanded = expanded.endLine;
		const startLineDisplay = startLine + 1;

		const resultBuilder = toolResult(details);
		if (options.sourcePath) {
			resultBuilder.sourcePath(options.sourcePath);
		}
		if (options.sourceUrl) {
			resultBuilder.sourceUrl(options.sourceUrl);
		}
		if (options.sourceInternal) {
			resultBuilder.sourceInternal(options.sourceInternal);
		}

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

		const endLine = endLineExpanded;
		const selectedContent = allLines.slice(startLine, endLine).join("\n");
		const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
		const truncation = ignoreResultLimits ? noTruncResult(selectedContent) : truncateHead(selectedContent);

		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
		const formatText = (content: string, startNum: number): string => {
			details.displayContent = { text: content, startLine: startNum };
			return formatTextWithMode(content, startNum, shouldAddHashLines, shouldAddLineNumbers);
		};

		let outputText: string;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (truncation.firstLineExceedsLimit) {
			const firstLine = allLines[startLine] ?? "";
			const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
			const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);

			if (shouldAddHashLines) {
				outputText = `[Line ${startLineDisplay} is ${formatBytes(
					firstLineBytes,
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
			} else {
				outputText = formatText(snippet.text, startLineDisplay);
			}

			if (snippet.text.length === 0) {
				outputText = `[Line ${startLineDisplay} is ${formatBytes(
					firstLineBytes,
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
			}

			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (truncation.truncated) {
			outputText = formatText(truncation.content, startLineDisplay);
			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;

			outputText = formatText(selectedContent, startLineDisplay);
			outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use :${nextOffset} to continue]`;
		} else {
			outputText = formatText(truncation.content, startLineDisplay);
		}

		resultBuilder.text(outputText);
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
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
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		const resultBuilder = toolResult(details);
		if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
		if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
		if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

		const parts: string[] = [];
		const outOfBounds: LineRange[] = [];
		for (const range of ranges) {
			if (range.startLine > totalLines) {
				outOfBounds.push(range);
				continue;
			}
			const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
			const sliced = allLines.slice(range.startLine - 1, effectiveEnd).join("\n");
			parts.push(formatTextWithMode(sliced, range.startLine, shouldAddHashLines, shouldAddLineNumbers));
		}

		const outputText = parts.length > 0 ? parts.join("\n\n…\n\n") : "";
		const notices: string[] = [];
		for (const range of outOfBounds) {
			const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
			notices.push(`[Range ${bound} is beyond end of ${options.entityLabel} (${totalLines} lines total); skipped]`);
		}
		const finalText =
			notices.length > 0 ? (outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n")) : outputText;
		resultBuilder.text(finalText);
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
	): Promise<{
		outputText: string;
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
				});
				if (suffixResolution) {
					const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
					const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
					if (firstText) firstText.text = `${notice}\n${firstText.text}`;
				}
				return { outputText: "", columnTruncated: 0, bridgeResult };
			} catch (error) {
				logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
			}
		}

		const shouldAddHashLines = !rawSelector && displayMode.hashLines;
		const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
		const maxColumns = resolveOutputMaxColumns(this.session.settings);

		const blocks: string[] = [];
		const notices: string[] = [];
		let columnTruncated = 0;

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
			if (!rawSelector && !shouldAddHashLines && maxColumns > 0) {
				for (let i = 0; i < collectedLines.length; i++) {
					const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
					if (wasTruncated) {
						collectedLines[i] = text;
						columnTruncated = maxColumns;
					}
				}
			}

			if (collectedLines.length > 0) {
				getFileReadCache(this.session).recordContiguous(absolutePath, range.startLine, collectedLines);
			}

			const blockText = collectedLines.join("\n");
			blocks.push(formatTextWithMode(blockText, range.startLine, shouldAddHashLines, shouldAddLineNumbers));
		}

		let outputText = blocks.join("\n\n…\n\n");
		if (notices.length > 0) {
			outputText = outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n");
		}
		return { outputText, columnTruncated };
	}

	async #readArchiveDirectory(
		archive: ArchiveReader,
		archivePath: string,
		subPath: string,
		limit: number | undefined,
		details: ReadToolDetails,
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
		const text = prependSuffixResolutionNotice(output, details.suffixResolution);
		const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
		const directoryDetails: ReadToolDetails = { ...details, isDirectory: true };
		const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(truncation.content);
		resultBuilder.sourcePath(archivePath).limits({ resultLimit: limitMeta.resultLimit?.reached });
		if (truncation.truncated) {
			directoryDetails.truncation = truncation;
			resultBuilder.truncation(truncation, { direction: "head" });
		}
		return resultBuilder.done();
	}

	async #readArchive(
		readPath: string,
		parsedSel: ParsedSelector,
		resolvedArchivePath: ResolvedArchiveReadPath,
		signal?: AbortSignal,
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
				signal,
			);
		}

		const entry = await archive.readFile(resolvedArchivePath.archiveSubPath);
		const text = decodeUtf8Text(entry.bytes);
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

		let db: Database | null = null;
		try {
			db = new Database(resolvedSqlitePath.absolutePath, { readonly: true, strict: true });
			db.run("PRAGMA busy_timeout = 3000");
			throwIfAborted(signal);

			switch (selector.kind) {
				case "list": {
					const listLimit = applyListLimit(listTables(db), { limit: 500 });
					const output = prependSuffixResolutionNotice(
						renderTableList(listLimit.items),
						resolvedSqlitePath.suffixResolution,
					);
					const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
					details.truncation = truncation.truncated ? truncation : undefined;
					const resultBuilder = toolResult<ReadToolDetails>(details)
						.text(truncation.content)
						.sourcePath(resolvedSqlitePath.absolutePath)
						.limits({ resultLimit: listLimit.meta.resultLimit?.reached });
					if (truncation.truncated) {
						resultBuilder.truncation(truncation, { direction: "head" });
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

	async #trySummarize(absolutePath: string, fileSize: number, signal?: AbortSignal): Promise<SummaryResult | null> {
		if (fileSize > MAX_SUMMARY_BYTES) return null;

		try {
			throwIfAborted(signal);
			const bridgePromise = this.#routeReadThroughBridge(absolutePath);
			const code =
				bridgePromise !== undefined
					? await bridgePromise.catch(() => Bun.file(absolutePath).text())
					: await Bun.file(absolutePath).text();
			throwIfAborted(signal);
			if (countTextLines(code) > MAX_SUMMARY_LINES) return null;

			return summarizeCode({
				code,
				path: absolutePath,
				minBodyLines: this.session.settings.get("read.summarize.minBodyLines"),
				minCommentLines: this.session.settings.get("read.summarize.minCommentLines"),
			});
		} catch {
			return null;
		}
	}

	#renderSummary(summary: SummaryResult): {
		text: string;
		displayText: string;
		elidedSpans: number;
		elidedLines: number;
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
		let elidedSpans = 0;
		let elidedLines = 0;
		for (const unit of units) {
			if (unit.kind === "elided") {
				modelParts.push("...");
				displayParts.push("...");
				elidedSpans++;
				elidedLines += unit.endLine - unit.startLine + 1;
				continue;
			}
			if (unit.kind === "merged") {
				const formatted = formatMergedBraceLine(
					unit.startLine,
					unit.endLine,
					unit.headText,
					unit.tailText,
					shouldAddHashLines,
					shouldAddLineNumbers,
				);
				modelParts.push(formatted.model);
				displayParts.push(formatted.display);
				elidedSpans++;
				// Merged brace pair encloses (start+1)..(end-1) as elided.
				elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
				continue;
			}
			modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
			displayParts.push(unit.text);
		}

		return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedSpans, elidedLines };
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
				return this.#buildInMemoryTextResult(cached.output, parsedUrlTarget.offset, parsedUrlTarget.limit, {
					details: { ...cached.details },
					sourceUrl: cached.details.finalUrl,
					entityLabel: "URL output",
					immutable: true,
				});
			}
			return executeReadUrl(this.session, { path: parsedUrlTarget.path, raw: parsedUrlTarget.raw }, signal);
		}

		// Handle internal URLs (agent://, artifact://, memory://, rule://, local://, gjc://, issue://, pr://).
		// Use the internal-URL-aware splitter so malformed selectors are peeled
		// off the URL and surfaced via parseSel rather than confusing handlers.
		const internalRouter = InternalUrlRouter.instance();
		if (internalRouter.canHandle(readPath)) {
			const internalTarget = splitInternalUrlSel(readPath);
			const parsed = parseSel(internalTarget.sel);
			return this.#handleInternalUrl(internalTarget.path, parsed, signal);
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
			);
		}

		const sqlitePath = await this.#resolveSqliteReadPath(readPath, signal);
		if (sqlitePath) {
			return this.#readSqlite(sqlitePath, signal);
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
			const dirResult = await this.#readDirectory(absolutePath, selToOffsetLimit(parsed).limit, signal);
			if (suffixResolution) {
				dirResult.details ??= {};
				dirResult.details.suffixResolution = suffixResolution;
			}
			return dirResult;
		}

		if (parsed.kind === "conflicts") {
			return this.#readFileConflicts(absolutePath, suffixResolution, signal);
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
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (mimeType) {
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
			if (isMultiRange(parsed) && parsed.kind === "lines") {
				return this.#buildInMemoryMultiRangeResult(notebookText, parsed.ranges, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "notebook",
				});
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#buildInMemoryTextResult(notebookText, offset, limit, {
				details: { resolvedPath: absolutePath },
				sourcePath: absolutePath,
				entityLabel: "notebook",
			});
		} else if (shouldConvertWithMarkit) {
			// Convert document via markit.
			const result = await convertFileWithMarkit(absolutePath, signal);
			if (result.ok) {
				// Apply truncation to converted content
				const truncation = truncateHead(result.content);
				const outputText = truncation.content;

				details = { truncation };
				sourcePath = absolutePath;
				truncationInfo = { result: truncation, options: { direction: "head", startLine: 1 } };

				content = [{ type: "text", text: outputText }];
			} else if (result.error) {
				content = [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }];
			} else {
				content = [{ type: "text", text: `[Cannot read ${ext} file: conversion failed]` }];
			}
		} else {
			if (
				parsed.kind === "none" &&
				this.session.settings.get("read.summarize.enabled") &&
				(this.session.settings.get("read.summarize.prose") || !PROSE_SUMMARY_EXTENSIONS.has(ext))
			) {
				const summary = await this.#trySummarize(absolutePath, fileSize, signal);
				if (summary?.parsed && summary.elided) {
					const renderedSummary = this.#renderSummary(summary);
					const footer = formatSummaryElisionFooter(
						localReadPath,
						renderedSummary.elidedSpans,
						renderedSummary.elidedLines,
					);
					const modelText = footer ? `${renderedSummary.text}\n\n${footer}` : renderedSummary.text;
					details = {
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
					const multiResult = await this.#readLocalFileMultiRange(
						absolutePath,
						parsed.ranges,
						parsed,
						displayMode,
						suffixResolution,
						signal,
					);
					if (multiResult.bridgeResult) return multiResult.bridgeResult;
					content = [{ type: "text", text: multiResult.outputText }];
					sourcePath = absolutePath;
					details = {};
					if (multiResult.columnTruncated > 0) {
						columnTruncated = multiResult.columnTruncated;
					}
				} else {
					// Raw text or line-range mode
					const { offset, limit } = selToOffsetLimit(parsed);
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
							});
							if (suffixResolution) {
								const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
								const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
								if (firstText) firstText.text = `${notice}\n${firstText.text}`;
							}
							return bridgeResult;
						} catch (error) {
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

					const DEFAULT_LIMIT = this.#defaultLimit;
					const effectiveLimit = limit ?? DEFAULT_LIMIT;
					const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
					const selectedLineLimit = effectiveLimit + leadingContext + trailingContext;
					// Scale byte budget with line limit so the configured line count actually fits.
					// Assume ~512 bytes/line average; never go below the shared default.
					const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);

					const streamResult = await streamLinesFromFile(
						absolutePath,
						startLine,
						maxLinesToCollect,
						maxBytesForRead,
						selectedLineLimit,
						signal,
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

					// Per-line column cap. Skipped in raw mode so `:raw` always returns
					// verbatim bytes for paste-back-into-tool workflows. Total byte/line
					// counts in `truncation` keep reflecting the source, not the trimmed
					// view — column truncation surfaces separately via `.limits()`.
					const rawSelector = isRawSelector(parsed);
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
					const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;

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

					const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
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
						details = { truncation };
						sourcePath = absolutePath;
						truncationInfo = {
							result: truncation,
							options: { direction: "head", startLine: startLineDisplay, totalFileLines },
						};
					} else if (truncation.truncated) {
						outputText = formatText(truncation.content, startLineDisplay);
						details = { truncation };
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
						details = {};
						sourcePath = absolutePath;
					} else {
						// No truncation, no user limit exceeded
						outputText = formatText(truncation.content, startLineDisplay);
						details = {};
						sourcePath = absolutePath;
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
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
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
			settings: this.session.settings,
			signal,
		});
		const details: ReadToolDetails = { resolvedPath: resource.sourcePath, contentType: resource.contentType };

		// If extraction was used, return directly (no pagination)
		if (hasExtraction) {
			return toolResult(details).text(resource.content).sourceInternal(url).done();
		}

		const raw = isRawSelector(parsedSel);
		if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
			return this.#buildInMemoryMultiRangeResult(resource.content, parsedSel.ranges, {
				details,
				sourcePath: resource.sourcePath,
				sourceInternal: url,
				entityLabel: "resource",
				immutable: resource.immutable,
				raw,
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
		});
	}

	/** Read directory contents as a formatted listing */
	async #readDirectory(
		absolutePath: string,
		limit: number | undefined,
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

		const output = tree.totalLines <= 1 ? "(empty directory)" : tree.rendered;
		const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
		const details: ReadToolDetails = {
			isDirectory: true,
			resolvedPath: tree.rootPath,
		};

		const resultBuilder = toolResult(details).text(truncation.content).sourcePath(tree.rootPath);
		if (tree.truncated) {
			resultBuilder.limits({ resultLimit: 1 });
		}
		if (truncation.truncated) {
			resultBuilder.truncation(truncation, { direction: "head" });
			details.truncation = truncation;
		}

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
