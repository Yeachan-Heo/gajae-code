import * as Diff from "diff";
import { generateDiffString } from "../edit/diff";
import type { FileReadCache } from "../edit/file-read-cache";
import { getNativeDiffBindings } from "../internal/native-diff";
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
	"Recovered from stale anchors using a previous read snapshot (file changed externally between read and edit).";

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
 * against a cached pre-edit snapshot of the file and 3-way-merging the result
 * onto the current on-disk content. Returns `null` when no recovery is
 * possible — callers should propagate the original mismatch error in that
 * case.
 *
 * Recovery is gated on a strict precondition: every line the model anchored
 * MUST be present in the cached snapshot AND its content MUST hash to the
 * model-supplied hash. This prevents 3-way merges from silently sliding onto
 * the wrong site when only tangential parts of the file went stale.
 */
export function tryRecoverHashlineWithCache(args: HashlineRecoveryArgs): HashlineRecoveryResult | null {
	const { cache, absolutePath, currentText, edits, options } = args;
	const snapshot = cache.get(absolutePath);
	if (!snapshot || snapshot.lines.size === 0) return null;

	// Precondition: the model's anchors must be vouched-for by the cache. If
	// even one anchored line is missing from the snapshot, or its cached
	// content hashes to a different value than the model supplied, refuse —
	// any merge from here is a guess.
	const anchors = collectEditAnchors(edits);
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

	const patch = {
		oldFileName: "file",
		newFileName: "file",
		oldHeader: "",
		newHeader: "",
		hunks: getNativeDiffBindings().structuredPatchHunks(previousText, applied.lines, 3),
	};
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
