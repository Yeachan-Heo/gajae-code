import { ABORT_MARKER, ABORT_WARNING, BEGIN_PATCH_MARKER, END_PATCH_MARKER, RANGE_INTERIOR_HASH } from "./constants";
import {
	computeLineHash,
	describeAnchorExamples,
	HL_BODY_SEP_RE_RAW,
	HL_FILE_PREFIX,
	HL_HASH_CAPTURE_RE_RAW,
	HL_OP_CHARS,
	HL_OP_INSERT_AFTER,
	HL_OP_INSERT_BEFORE,
	HL_OP_REPLACE,
} from "./hash";
import type { Anchor, HashlineCursor, HashlineEdit } from "./types";

// Leniently accept anchors copied from read/search output:
//   - optional leading line-marker decoration (`*`, `>`, `+`, `-`)
//   - the required `LINE+HASH`
//   - an optional trailing `|TEXT` body (or anything after the hash) so users
//     can paste a full `LINE+HASH|TEXT` line verbatim.
const LID_CAPTURE_RE = new RegExp(`^\\s*[>+\\-*]*\\s*${HL_HASH_CAPTURE_RE_RAW}(?:\\|.*)?\\s*$`);
const regexEscape = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const BARE_LINE_REF_RE = /^\s*[>+\-*]*\s*([1-9]\d*)(?:\s*(?:-|\.\.)\s*([1-9]\d*))?\s*$/;

/**
 * An op referenced lines by number alone, without the content hash. The edit
 * is never applied on a line number alone; the executor answers with the
 * current full anchors for {@link lines} so the model can retry without an
 * extra read.
 */
export class HashlineMissingHashError extends Error {
	constructor(
		message: string,
		readonly lines: { start: number; end: number },
	) {
		super(message);
		this.name = "HashlineMissingHashError";
	}
}

function parseLid(raw: string, lineNum: number): Anchor {
	const match = LID_CAPTURE_RE.exec(raw);
	if (!match) {
		const bare = BARE_LINE_REF_RE.exec(raw);
		if (bare) {
			const start = Number.parseInt(bare[1], 10);
			const end = bare[2] === undefined ? start : Number.parseInt(bare[2], 10);
			throw new HashlineMissingHashError(
				`line ${lineNum}: anchor ${JSON.stringify(raw.trim())} is missing its hash; ` +
					`use the full anchor such as ${describeAnchorExamples(String(start))}.`,
				{ start: Math.min(start, end), end: Math.max(start, end) },
			);
		}
		throw new Error(
			`line ${lineNum}: expected a full anchor such as ${describeAnchorExamples("119")}; ` +
				`got ${JSON.stringify(raw)}.`,
		);
	}
	return { line: Number.parseInt(match[1], 10), hash: match[2] };
}

interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

function parseRange(raw: string, lineNum: number): ParsedRange {
	// Reject an all-numeric range (`16..18`, `16-18`) as a whole so the error
	// carries the full span rather than just its first endpoint.
	if (BARE_LINE_REF_RE.test(raw)) parseLid(raw, lineNum);
	if (!raw.includes("..")) {
		const start = parseLid(raw, lineNum);
		return { start, end: { ...start } };
	}
	const [startRaw, endRaw, extra] = raw.split("..");
	if (extra !== undefined || !startRaw || !endRaw) {
		throw new Error(
			`line ${lineNum}: range must include exactly two full anchors separated by "..". ` +
				`For a one-line edit, repeat the same anchor on both sides.`,
		);
	}
	const start = parseLid(startRaw, lineNum);
	const end = parseLid(endRaw, lineNum);
	if (end.line < start.line) {
		throw new Error(`line ${lineNum}: range ${startRaw}..${endRaw} ends before it starts.`);
	}
	if (end.line === start.line && end.hash !== start.hash) {
		throw new Error(`line ${lineNum}: range ${startRaw}..${endRaw} uses two different hashes for the same line.`);
	}
	return { start, end };
}

function expandRange(range: ParsedRange): Anchor[] {
	const anchors: Anchor[] = [];
	for (let line = range.start.line; line <= range.end.line; line++) {
		const hash =
			line === range.start.line ? range.start.hash : line === range.end.line ? range.end.hash : RANGE_INTERIOR_HASH;
		anchors.push({ line, hash });
	}
	return anchors;
}

function parseInsertTarget(raw: string, lineNum: number, kind: "before" | "after"): HashlineCursor {
	if (raw === "BOF") return { kind: "bof" };
	if (raw === "EOF") return { kind: "eof" };
	const cursorKind = kind === "before" ? "before_anchor" : "after_anchor";
	return { kind: cursorKind, anchor: parseLid(raw, lineNum) };
}

/**
 * Decide how to interpret the optional `|TEXT` body captured on an insert
 * op line:
 *   - For BOF/EOF cursors the body is always treated as an inline payload
 *     line (there's no anchor hash to compare against).
 *   - For anchored cursors, compute the hash of TEXT at the anchor's line
 *     number. If it matches the anchor's hash, the body is just a verbatim
 *     copy of the anchored line — discard it, payload must come from the
 *     following lines as usual.
 *   - Otherwise the body is the first (or only) payload line for this op.
 */
function resolveInlineInsertBody(cursor: HashlineCursor, body: string | undefined): string | undefined {
	if (body === undefined) return undefined;
	if (cursor.kind !== "before_anchor" && cursor.kind !== "after_anchor") return body;
	const { line, hash } = cursor.anchor;
	if (computeLineHash(line, body) === hash) return undefined;
	return body;
}

// Insert ops leniently accept a trailing `|TEXT` body on the op line itself
// (e.g. `»502zk|\tconst foo = ...`). The anchor token excludes `|` so the body
// is captured separately; resolveInlineInsertBody decides whether to treat the
// captured text as a verbatim anchor decoration (when its hash matches the
// anchor's) or as an inline payload line.
const INSERT_BEFORE_OP_RE = new RegExp(
	`^${regexEscape(HL_OP_INSERT_BEFORE)}\\s*([^|\\s]+)(?:${HL_BODY_SEP_RE_RAW}(.*))?\\s*$`,
);
const INSERT_AFTER_OP_RE = new RegExp(
	`^${regexEscape(HL_OP_INSERT_AFTER)}\\s*([^|\\s]+)(?:${HL_BODY_SEP_RE_RAW}(.*))?\\s*$`,
);
const REPLACE_OP_RE = new RegExp(`^${regexEscape(HL_OP_REPLACE)}\\s*([^\\s+<\\-=]\\S*)\\s*$`);

function isEnvelopeOrAbortMarkerLine(line: string): boolean {
	const trimmed = line.trimEnd();
	return trimmed === BEGIN_PATCH_MARKER || trimmed === END_PATCH_MARKER || trimmed === ABORT_MARKER;
}

function isPayloadTerminatorLine(line: string): boolean {
	const first = line[0];
	return (
		first === HL_FILE_PREFIX ||
		(first !== undefined && HL_OP_CHARS.includes(first)) ||
		isEnvelopeOrAbortMarkerLine(line)
	);
}

export function cloneCursor(cursor: HashlineCursor): HashlineCursor {
	if (cursor.kind === "before_anchor") return { kind: "before_anchor", anchor: { ...cursor.anchor } };
	if (cursor.kind === "after_anchor") return { kind: "after_anchor", anchor: { ...cursor.anchor } };
	return cursor;
}

function collectPayload(
	lines: string[],
	startIndex: number,
	opLineNum: number,
	requirePayload: boolean,
): { payload: string[]; nextIndex: number } {
	const payload: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const line = lines[index];
		if (isPayloadTerminatorLine(line)) break;
		payload.push(line);
		index++;
	}
	if (payload.length === 0 && requirePayload) {
		throw new Error(
			`line ${opLineNum}: ${HL_OP_INSERT_BEFORE} and ${HL_OP_INSERT_AFTER} operations require at least one verbatim payload line.`,
		);
	}
	return { payload, nextIndex: index };
}

export function parseHashline(diff: string): HashlineEdit[] {
	return parseHashlineWithWarnings(diff).edits;
}

export function parseHashlineWithWarnings(diff: string): { edits: HashlineEdit[]; warnings: string[] } {
	const edits: HashlineEdit[] = [];
	const warnings: string[] = [];
	const lines = diff.split(/\r?\n/);
	if (diff.endsWith("\n") && lines.at(-1) === "") lines.pop();
	let editIndex = 0;

	const pushInsert = (cursor: HashlineCursor, text: string, lineNum: number) => {
		edits.push({ kind: "insert", cursor: cloneCursor(cursor), text, lineNum, index: editIndex++ });
	};

	for (let i = 0; i < lines.length; ) {
		const lineNum = i + 1;
		const line = lines[i];

		if (line.trim().length === 0) {
			i++;
			continue;
		}
		if (line === END_PATCH_MARKER) {
			break;
		}
		if (line === ABORT_MARKER) {
			warnings.push(ABORT_WARNING);
			break;
		}
		if (line === BEGIN_PATCH_MARKER) {
			i++;
			continue;
		}

		const insertBeforeMatch = INSERT_BEFORE_OP_RE.exec(line);
		if (insertBeforeMatch) {
			const cursor = parseInsertTarget(insertBeforeMatch[1], lineNum, "before");
			const inlineBody = resolveInlineInsertBody(cursor, insertBeforeMatch[2]);
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, inlineBody === undefined);
			if (inlineBody !== undefined) pushInsert(cursor, inlineBody, lineNum);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const insertAfterMatch = INSERT_AFTER_OP_RE.exec(line);
		if (insertAfterMatch) {
			const cursor = parseInsertTarget(insertAfterMatch[1], lineNum, "after");
			const inlineBody = resolveInlineInsertBody(cursor, insertAfterMatch[2]);
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, inlineBody === undefined);
			if (inlineBody !== undefined) pushInsert(cursor, inlineBody, lineNum);
			for (const text of payload) pushInsert(cursor, text, lineNum);
			i = nextIndex;
			continue;
		}

		const replaceMatch = REPLACE_OP_RE.exec(line);
		if (replaceMatch) {
			const range = parseRange(replaceMatch[1], lineNum);
			const { payload, nextIndex } = collectPayload(lines, i + 1, lineNum, false);
			if (payload.length > 0) {
				for (const text of payload) {
					edits.push({
						kind: "insert",
						cursor: { kind: "before_anchor", anchor: { ...range.start } },
						text,
						lineNum,
						index: editIndex++,
					});
				}
			}
			for (const anchor of expandRange(range)) {
				edits.push({ kind: "delete", anchor, lineNum, index: editIndex++ });
			}
			i = nextIndex;
			continue;
		}

		if (isPayloadTerminatorLine(line) || /^[-@\u00B6]/u.test(line)) {
			throw new Error(
				`line ${lineNum}: unrecognized op. Use ${HL_OP_INSERT_BEFORE}ANCHOR (insert before), ${HL_OP_INSERT_AFTER}ANCHOR (insert after), or ${HL_OP_REPLACE}A..B (replace/delete). ` +
					`Got ${JSON.stringify(line)}.`,
			);
		}

		throw new Error(
			`line ${lineNum}: payload line has no preceding ${HL_OP_INSERT_BEFORE}, ${HL_OP_INSERT_AFTER}, or ${HL_OP_REPLACE} operation. ` +
				`Got ${JSON.stringify(line)}.`,
		);
	}

	return { edits, warnings };
}
