import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { formatHashLines } from "../../src/hashline/hash";
import {
	formatMiddleElisionMarker,
	type ReadSegment,
	type ReadWindow,
	truncateHead,
	truncateMiddleWindows,
	truncateTail,
} from "../../src/session/streaming-output";
import { streamLinesFromFile, streamResultWindow } from "../../src/tools/read";

type Direction = "head" | "last" | "both";

type Fixture = {
	name: string;
	content: string;
	maxLines: number;
	maxBytes: number;
	startLine?: number;
	endExclusive?: number;
};

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-stream-collector-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

function segmentShape(segment: ReadSegment | undefined) {
	if (!segment) return undefined;
	return segment.kind === "lines"
		? {
				kind: segment.kind,
				content: segment.content,
				lines: segment.lines,
				bytes: segment.bytes,
				origin: segment.origin,
				lastLinePartial: segment.lastLinePartial,
			}
		: {
				kind: segment.kind,
				content: segment.content,
				lines: segment.lines,
				bytes: segment.bytes,
				origin: segment.origin,
				sourceLineBytes: segment.sourceLineBytes,
				lastLinePartial: segment.lastLinePartial,
			};
}

function windowShape(window: ReadWindow) {
	return {
		kind: window.kind,
		overlap: window.overlap,
		elidedLines: window.elidedLines,
		elidedBytes: window.elidedBytes,
		totalLines: window.totalLines,
		totalBytes: window.totalBytes,
		head: segmentShape(window.head),
		tail: segmentShape(window.tail),
		// `truncatedBy` is deliberately non-enumerable on ReadWindow. Keep it in
		// this explicit projection so parity cannot silently miss it.
		truncatedBy: (window as ReadWindow & { truncatedBy?: string }).truncatedBy,
	};
}

function withReason(window: ReadWindow, reason: "lines" | "bytes" | "middle" | undefined): ReadWindow {
	if (reason !== undefined) Object.defineProperty(window, "truncatedBy", { value: reason, enumerable: false });
	return window;
}

function rebaseWindow(window: ReadWindow, offset: number): ReadWindow {
	const rebase = (segment: ReadSegment | undefined): ReadSegment | undefined => {
		if (!segment) return undefined;
		return {
			...segment,
			origin: {
				startLine: segment.origin.startLine + offset,
				endLine: segment.origin.endLine + offset,
			},
		};
	};
	const rebased: ReadWindow = { ...window, head: rebase(window.head), tail: rebase(window.tail) };
	return withReason(rebased, (window as ReadWindow & { truncatedBy?: "lines" | "bytes" | "middle" }).truncatedBy);
}

function segmentFromResult(
	result: { content: string; lines: number; bytes: number; lastLinePartial?: boolean; sourceLineBytes?: number },
	startLine: number,
): ReadSegment | undefined {
	if (result.lines <= 0) return undefined;
	return {
		kind: result.lastLinePartial ? "partial-line" : "lines",
		content: result.content,
		lines: result.lines,
		bytes: result.bytes,
		origin: { startLine: startLine + 1, endLine: startLine + result.lines },
		...(result.lastLinePartial
			? { sourceLineBytes: result.sourceLineBytes ?? result.bytes, lastLinePartial: true }
			: { lastLinePartial: false }),
	} as ReadSegment;
}

function headWindowFromStream(result: Awaited<ReturnType<typeof streamLinesFromFile>>, startLine: number): ReadWindow {
	const segment = segmentFromResult(
		{
			content: result.lines.join("\n"),
			lines: result.lines.length,
			bytes: result.collectedBytes,
		},
		startLine,
	);
	const totalLines = result.windowLinesTotal;
	const totalBytes = result.windowBytesTotal;
	const truncated = result.lines.length < totalLines || result.stoppedByByteLimit;
	return withReason(
		{
			kind: truncated ? "head-only" : "full",
			...(segment ? { head: segment } : {}),
			overlap: "disjoint",
			elidedLines: Math.max(0, totalLines - result.lines.length),
			elidedBytes: Math.max(0, totalBytes - result.collectedBytes),
			totalLines,
			totalBytes,
		},
		truncated ? (result.stoppedByByteLimit ? "bytes" : "lines") : undefined,
	);
}

function renderWindow(window: ReadWindow, hashLines: boolean): string {
	const render = (segment: ReadSegment): string =>
		hashLines && segment.kind === "lines"
			? formatHashLines(segment.content, segment.origin.startLine)
			: segment.content;
	if (window.kind === "full") return window.head ? render(window.head) : "";
	if (window.kind === "head-only") return window.head ? render(window.head) : "";
	if (window.kind === "tail-only") return window.tail ? render(window.tail) : "";
	if (!window.head || !window.tail) return "";
	return `${render(window.head)}\n${formatMiddleElisionMarker(window.elidedLines, window.elidedBytes)}\n${render(window.tail)}`;
}

function oracleFor(
	content: string,
	direction: Direction,
	maxLines: number,
	maxBytes: number,
	startLine: number,
	endExclusive: number | undefined,
): ReadWindow {
	const sourceLines = content.split("\n");
	const end = Math.min(endExclusive ?? sourceLines.length, sourceLines.length);
	const selected = sourceLines.slice(Math.max(0, startLine), Math.max(0, end));
	const selectedContent = selected.join("\n");
	const options = { maxLines, maxBytes };
	if (direction === "both") return rebaseWindow(truncateMiddleWindows(selectedContent, options), startLine);
	const result =
		direction === "head" ? truncateHead(selectedContent, options) : truncateTail(selectedContent, options);
	const totalLines = selectedContent.split("\n").length;
	const totalBytes = Buffer.byteLength(selectedContent, "utf8");
	const outputLines = result.outputLines ?? (result.content.length === 0 ? 0 : result.content.split("\n").length);
	const outputBytes = result.outputBytes ?? Buffer.byteLength(result.content, "utf8");
	const segmentStart = direction === "head" ? startLine : startLine + totalLines - outputLines;
	const segment = segmentFromResult(
		{
			content: result.content,
			lines: outputLines,
			bytes: outputBytes,
			lastLinePartial: result.lastLinePartial,
			sourceLineBytes: result.lastLinePartial
				? Buffer.byteLength(selected[totalLines - outputLines] ?? "", "utf8")
				: undefined,
		},
		segmentStart,
	);
	if (!result.truncated) {
		return {
			kind: "full",
			head: segment,
			overlap: "disjoint",
			elidedLines: 0,
			elidedBytes: 0,
			totalLines,
			totalBytes,
		};
	}
	return withReason(
		{
			kind: direction === "head" ? "head-only" : "tail-only",
			...(direction === "head" ? (segment ? { head: segment } : {}) : segment ? { tail: segment } : {}),
			overlap: "disjoint",
			elidedLines: Math.max(0, totalLines - outputLines),
			elidedBytes: Math.max(0, totalBytes - outputBytes),
			totalLines,
			totalBytes,
		},
		result.truncatedBy,
	);
}

async function collectWindow(filePath: string, direction: Direction, fixture: Fixture): Promise<ReadWindow> {
	const startLine = fixture.startLine ?? 0;
	const endExclusive = fixture.endExclusive ?? null;
	const result = await streamLinesFromFile(
		filePath,
		startLine,
		fixture.maxLines,
		fixture.maxBytes,
		null,
		undefined,
		direction === "head" ? "head" : direction === "last" ? "tail" : "both",
		endExclusive,
	);
	return direction === "head"
		? headWindowFromStream(result, startLine)
		: streamResultWindow(result, direction === "last" ? "tail" : "both", startLine, endExclusive);
}

const lines = Array.from({ length: 8 }, (_, index) => `L${index + 1}`);

const fixtures: Fixture[] = [
	{ name: "one-line-60-100-full-fit", content: "x".repeat(60), maxLines: 10, maxBytes: 100 },
	{
		name: "asymmetric-60-plus-30-full-fit",
		content: `${"a".repeat(60)}\n${"b".repeat(30)}`,
		maxLines: 10,
		maxBytes: 100,
	},
	{ name: "60-plus-45-transition", content: `${"a".repeat(60)}\n${"b".repeat(45)}`, maxLines: 10, maxBytes: 100 },
	{ name: "D1-short-giant-short-short", content: `short\n${"x".repeat(200)}\na\nb`, maxLines: 10, maxBytes: 40 },
	{ name: "D2-giant-last", content: `short\n${"x".repeat(200)}`, maxLines: 10, maxBytes: 40 },
	{ name: "D3-range-end", content: lines.join("\n"), maxLines: 4, maxBytes: 100, startLine: 1, endExclusive: 5 },
	{ name: "D4-both-giant-last", content: `short\n${"x".repeat(200)}`, maxLines: 10, maxBytes: 40 },
	{ name: "giant-first", content: `${"x".repeat(200)}\na\nb\nc`, maxLines: 10, maxBytes: 40 },
	{ name: "giant-middle", content: `a\nb\n${"x".repeat(200)}\nc\nd`, maxLines: 10, maxBytes: 40 },
	{
		name: "byte-and-line-caps",
		content: Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n"),
		maxLines: 4,
		maxBytes: 20,
	},
	{ name: "crlf", content: "a\r\nbb\r\nccc\r\ndddd\r\neeee", maxLines: 3, maxBytes: 12 },
	{ name: "trailing-newline", content: "a\nb\nc\n", maxLines: 3, maxBytes: 100 },
	{ name: "no-trailing-newline", content: "a\nb\nc", maxLines: 2, maxBytes: 100 },
	{ name: "exact-adjacent-2-plus-2", content: "aa\nbb\ncc\ndd", maxLines: 4, maxBytes: 10 },
	{ name: "degenerate-tail-lines-zero", content: lines.join("\n"), maxLines: 1, maxBytes: 50 },
	{ name: "degenerate-tail-lines-zero-byte-bound", content: lines.join("\n"), maxLines: 1, maxBytes: 2 },
	{ name: "degenerate-head-bytes-zero", content: lines.join("\n"), maxLines: 2, maxBytes: 1 },
	{ name: "degenerate-tail-full-fit", content: "x".repeat(60), maxLines: 1, maxBytes: 100 },
	{ name: "degenerate-head-line-unusable", content: lines.join("\n"), maxLines: 8, maxBytes: 3 },
	{ name: "degenerate-both-bytes-zero", content: lines.join("\n"), maxLines: 8, maxBytes: 0 },
];

describe("streaming ReadWindow parity with truncateMiddleWindows and directional oracles", () => {
	test("covers a degenerate split that failed before one-sided dispatch", async () => {
		const fixture: Fixture = { name: "B1-boundary", content: lines.join("\n"), maxLines: 1, maxBytes: 2 };
		const filePath = path.join(tempDir, "b1-boundary.txt");
		await fs.writeFile(filePath, fixture.content);
		const actual = await collectWindow(filePath, "both", fixture);
		const expected = oracleFor(fixture.content, "both", fixture.maxLines, fixture.maxBytes, 0, undefined);
		expect(windowShape(actual)).toEqual(windowShape(expected));
	});

	test("B1 degenerate budget matrix matches the materialized oracle kind", async () => {
		for (const [maxLines, maxBytes, expectedKind] of [
			[1, 50, "head-only"],
			[2, 1, "tail-only"],
			[8, 3, "tail-only"],
		] as const) {
			const fixture: Fixture = { name: `B1-${maxLines}-${maxBytes}`, content: lines.join("\n"), maxLines, maxBytes };
			const filePath = path.join(tempDir, `${fixture.name}.txt`);
			await fs.writeFile(filePath, fixture.content);
			const actual = await collectWindow(filePath, "both", fixture);
			const expected = oracleFor(fixture.content, "both", maxLines, maxBytes, 0, undefined);
			expect(actual.kind).toBe(expectedKind);
			expect(actual.kind).toBe(expected.kind);
			expect(windowShape(actual)).toEqual(windowShape(expected));
		}
	});

	for (const fixture of fixtures) {
		for (const direction of ["head", "last", "both"] as const) {
			for (const hashLines of [false, true]) {
				test(`${fixture.name}/${direction}/hashline-${hashLines ? "on" : "off"}`, async () => {
					const filePath = path.join(tempDir, `${fixture.name}.txt`);
					await fs.writeFile(filePath, fixture.content);
					const actual = await collectWindow(filePath, direction, fixture);
					const expected = oracleFor(
						fixture.content,
						direction,
						fixture.maxLines,
						fixture.maxBytes,
						fixture.startLine ?? 0,
						fixture.endExclusive,
					);
					expect(windowShape(actual)).toEqual(windowShape(expected));
					expect(renderWindow(actual, hashLines)).toBe(renderWindow(expected, hashLines));
				});
			}
		}
	}

	test("I8 uses the valid-window domain when start is beyond the selected end", async () => {
		const fixture: Fixture = {
			name: "I8",
			content: lines.join("\n"),
			maxLines: 4,
			maxBytes: 100,
			startLine: 10,
			endExclusive: 5,
		};
		const filePath = path.join(tempDir, "i8.txt");
		await fs.writeFile(filePath, fixture.content);
		const result = await streamLinesFromFile(
			filePath,
			fixture.startLine!,
			fixture.maxLines,
			fixture.maxBytes,
			null,
			undefined,
			"tail",
			fixture.endExclusive!,
		);
		const windowEnd = Math.min(fixture.endExclusive!, result.totalFileLines);
		expect(result.windowLinesTotal).toBe(Math.max(0, windowEnd - fixture.startLine!));
		expect(result.windowLinesTotal).toBeGreaterThanOrEqual(0);
	});
});
