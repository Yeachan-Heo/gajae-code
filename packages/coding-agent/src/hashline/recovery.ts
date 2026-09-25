import * as Diff from "diff";
import { generateDiffString } from "../edit/diff";
import type { FileReadCache, FileReadSnapshot } from "../edit/file-read-cache";
import { HashlineMismatchError } from "./anchors";
import { applyHashlineEdits, type HashlineApplyResult } from "./apply";
import { computeLineHash } from "./hash";
import type { Anchor, HashlineApplyOptions, HashlineEdit } from "./types";

export interface HashlineRecoveryArgs {
	cache: FileReadCache;
	absolutePath: string;
	currentText: string;
	edits: HashlineEdit[];
	options: HashlineApplyOptions;
}

export interface HashlineRecoveryResult {
	lines: string;
	firstChangedLine: number | undefined;
	warnings: string[];
}

// Anchors are line-precise; never let Diff.applyPatch slide a hunk onto a
// duplicate closer 100+ lines away. If the snapshot-based replay does not
// align by exact line number, refuse and let the model re-read.
const HASHLINE_RECOVERY_FUZZ_FACTOR = 0;

const HASHLINE_RECOVERY_WARNING =
	"Recovered from stale anchors using a previous read snapshot (file changed between read and edit).";

/**
 * Line numbers outside a partial snapshot were filled from the live file when
 * building the replay base, so they say nothing about the version the anchors
 * were authored against. Drop such lines from a hunk's leading and trailing
 * context; refuse the hunk if any remaining old-side line is not covered.
 */
function trimHunkToSnapshot(
	hunk: Diff.StructuredPatchHunk,
	snapshot: FileReadSnapshot,
): Diff.StructuredPatchHunk | null {
	const oldLineNumbers: Array<number | undefined> = [];
	let oldLine = hunk.oldStart;
	for (const line of hunk.lines) {
		if (line[0] === " " || line[0] === "-") oldLineNumbers.push(oldLine++);
		else oldLineNumbers.push(undefined);
	}
	const covered = (index: number): boolean => {
		const lineNum = oldLineNumbers[index];
		return lineNum !== undefined && snapshot.lines.has(lineNum);
	};

	let start = 0;
	while (start < hunk.lines.length && hunk.lines[start][0] === " " && !covered(start)) start++;
	let end = hunk.lines.length;
	while (end > start && hunk.lines[end - 1][0] === " " && !covered(end - 1)) end--;
	const lines = hunk.lines.slice(start, end);
	for (let index = start; index < end; index++) {
		if (oldLineNumbers[index] !== undefined && !covered(index)) return null;
	}
	return {
		oldStart: hunk.oldStart + start,
		oldLines: lines.filter(line => line[0] === " " || line[0] === "-").length,
		newStart: hunk.newStart + start,
		newLines: lines.filter(line => line[0] === " " || line[0] === "+").length,
		lines,
	};
}

/**
 * `Diff.applyPatch` searches the whole file for a spot where a hunk's context
 * matches, so a hunk whose old side (context + deleted lines) occurs more than
 * once in the live file could land on the wrong copy. Refuse such replays.
 */
function everyHunkLandsUniquely(hunks: Diff.StructuredPatchHunk[], currentLines: string[]): boolean {
	for (const hunk of hunks) {
		const oldSide = hunk.lines.filter(line => line[0] === " " || line[0] === "-").map(line => line.slice(1));
		if (oldSide.length === 0) return false;
		let occurrences = 0;
		for (let start = 0; start + oldSide.length <= currentLines.length; start++) {
			let matches = true;
			for (let offset = 0; offset < oldSide.length; offset++) {
				if (currentLines[start + offset] !== oldSide[offset]) {
					matches = false;
					break;
				}
			}
			if (matches && ++occurrences > 1) return false;
		}
		if (occurrences !== 1) return false;
	}
	return true;
}

/** Collect every line anchor an edit batch depends on. */
function collectEditAnchors(edits: HashlineEdit[]): Anchor[] {
	const anchors: Anchor[] = [];
	for (const edit of edits) {
		if (edit.kind === "delete") {
			anchors.push(edit.anchor);
			continue;
		}
		const cursor = edit.cursor;
		if (cursor.kind === "before_anchor" || cursor.kind === "after_anchor") {
			anchors.push(cursor.anchor);
		}
	}
	return anchors;
}

/**
 * Attempt to recover from a `HashlineMismatchError` by replaying the edits
 * against a cached snapshot of the file and 3-way-merging the result onto the
 * current on-disk content. Returns `null` when no recovery is possible —
 * callers should propagate the original mismatch error in that case.
 *
 * Every retained snapshot generation is tried, newest first. The newest one
 * covers out-of-band changes (linter, subagent, user); older ones cover the
 * common case of the model re-using anchors from its original read after its
 * own previous edit shifted or rewrote lines.
 *
 * Recovery is gated on a strict precondition: every line the model anchored
 * MUST be present in the snapshot AND its content MUST hash to the
 * model-supplied hash. This prevents 3-way merges from silently sliding onto
 * the wrong site when only tangential parts of the file went stale.
 */
export function tryRecoverHashlineWithCache(args: HashlineRecoveryArgs): HashlineRecoveryResult | null {
	const { cache, absolutePath, currentText, edits, options } = args;
	const anchors = collectEditAnchors(edits);
	for (const snapshot of cache.generations(absolutePath)) {
		const recovered = tryRecoverFromSnapshot(snapshot, anchors, currentText, edits, options);
		if (recovered) return recovered;
	}
	return null;
}

function tryRecoverFromSnapshot(
	snapshot: FileReadSnapshot,
	anchors: Anchor[],
	currentText: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
): HashlineRecoveryResult | null {
	if (snapshot.lines.size === 0) return null;

	// Precondition: the model's anchors must be vouched-for by the snapshot. If
	// even one anchored line is missing from it, or its content hashes to a
	// different value than the model supplied, refuse — any merge from here is
	// a guess.
	for (const anchor of anchors) {
		const cachedLine = snapshot.lines.get(anchor.line);
		if (cachedLine === undefined) return null;
		if (computeLineHash(anchor.line, cachedLine) !== anchor.hash) return null;
	}

	const overlaid = currentText.split("\n");
	let maxCachedLine = 0;
	for (const lineNum of snapshot.lines.keys()) {
		if (lineNum > maxCachedLine) maxCachedLine = lineNum;
	}
	while (overlaid.length < maxCachedLine) overlaid.push("");
	for (const [lineNum, content] of snapshot.lines) {
		overlaid[lineNum - 1] = content;
	}
	// A full-file snapshot is authoritative about length too: live lines past
	// its end did not exist in the version the anchors were authored against.
	if (snapshot.lineCount !== undefined) overlaid.length = snapshot.lineCount;
	const previousText = overlaid.join("\n");
	if (previousText === currentText) return null;

	let applied: HashlineApplyResult;
	try {
		applied = applyHashlineEdits(previousText, edits, options);
	} catch (err) {
		if (err instanceof HashlineMismatchError) return null;
		throw err;
	}
	if (applied.lines === previousText) return null;

	const patch = Diff.structuredPatch("file", "file", previousText, applied.lines, "", "", { context: 3 });
	const hunks: Diff.StructuredPatchHunk[] = [];
	for (const hunk of patch.hunks) {
		const trimmed = trimHunkToSnapshot(hunk, snapshot);
		if (!trimmed) return null;
		hunks.push(trimmed);
	}
	patch.hunks = hunks;
	if (!everyHunkLandsUniquely(hunks, currentText.split("\n"))) return null;
	const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: HASHLINE_RECOVERY_FUZZ_FACTOR });
	if (typeof merged !== "string" || merged === currentText) return null;

	const mergedDiff = generateDiffString(currentText, merged);
	// Only surface the recovery warning when the merge actually changed
	// something visible. A no-op merge (e.g. trailing-newline only) is noise.
	const hasNetChange = mergedDiff.firstChangedLine !== undefined;
	const recoveryWarnings = hasNetChange
		? [HASHLINE_RECOVERY_WARNING, ...(applied.warnings ?? [])]
		: [...(applied.warnings ?? [])];

	return {
		lines: merged,
		firstChangedLine: mergedDiff.firstChangedLine ?? applied.firstChangedLine,
		warnings: recoveryWarnings,
	};
}
