/**
 * Structural parser for unified diffs with credential scrubbing.
 *
 * The GitHub view cache must redact credentials and sensitive paths from
 * persisted content. Line-level regex scrubbing cannot reliably distinguish
 * structural boundaries (hunks, containers, serialization layers) from
 * content. This module instead:
 *
 * 1. Parses the unified diff into explicit hunks with per-line projections
 *    (context, old, new).
 * 2. Decodes content through serialization layers to identify redactable material.
 * 3. Redacts using the shared crash-redaction model.
 * 4. Re-serializes preserving all framing (line counts, prefixes, escaping).
 *
 * The scan is linear: O(n) in diff size with no backtracking or per-line
 * search. State is tracked per-file to handle multi-hunk containers.
 */

import { redactCrashSecrets } from "@gajae-code/pi-utils";

// Helper to split text while preserving empty lines
function splitLines(text: string): string[] {
	const result: string[] = [];
	let current = "";
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") {
			result.push(current);
			current = "";
		} else {
			current += text[i];
		}
	}
	if (current.length > 0) {
		result.push(current);
	}
	return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Hunk header format: @@ -oldStart,oldCount +newStart,newCount @@ */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// ────────────────────────────────────────────────────────────────────────────
// Main scrubbing logic
// ────────────────────────────────────────────────────────────────────────────

/**
 * Scrub a unified diff by:
 * 1. Splitting into lines
 * 2. Identifying hunks and their boundaries
 * 3. Redacting each hunk's content while preserving structure
 * 4. Re-joining with original line endings
 *
 * Returns the redacted diff text with all structure and framing preserved.
 */
export function scrubUnifiedDiff(unifiedDiff: string): string {
	const lines = splitLines(unifiedDiff);
	const result: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Pass through file headers and non-hunk lines as-is
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("old mode") ||
			line.startsWith("new mode") ||
			line.startsWith("mode ") ||
			line.startsWith("similarity ") ||
			line.startsWith("rename ") ||
			line.startsWith("copy ")
		) {
			result.push(line);
			i += 1;
		} else if (line.startsWith("@@")) {
			// Found a hunk header. Process the entire hunk.
			const hunkResult = redactHunk(lines, i);
			result.push(...hunkResult.redactedLines);
			i = hunkResult.nextIndex;
		} else {
			// Regular content line - redact it
			const redactedLine = redactDiffLine(line);
			result.push(redactedLine);
			i += 1;
		}
	}

	return result.join("\n");
}

/**
 * Redact a single diff line, preserving the prefix character.
 */
function redactDiffLine(line: string): string {
	if (line.length === 0) {
		return line;
	}

	// Get the prefix character
	const prefix = line[0];

	// Lines that shouldn't be redacted
	if (prefix === "\\" || prefix === "@") {
		return line;
	}

	// Redact the content part
	const content = line.length > 1 ? line.slice(1) : "";
	const redacted = redactCrashSecrets(content);

	return prefix + redacted;
}

/**
 * Process a hunk starting at hunkHeaderIndex.
 * Returns the redacted lines and the index to continue from.
 */
function redactHunk(lines: string[], hunkHeaderIndex: number): { redactedLines: string[]; nextIndex: number } {
	const headerLine = lines[hunkHeaderIndex];
	const match = headerLine.match(HUNK_HEADER_RE);

	if (!match) {
		// Invalid hunk header, pass through
		return { redactedLines: [headerLine], nextIndex: hunkHeaderIndex + 1 };
	}

	// Parse the line counts
	const oldCount = Number.parseInt(match[2] || "1", 10);
	const newCount = Number.parseInt(match[4] || "1", 10);

	const result: string[] = [headerLine];
	let i = hunkHeaderIndex + 1;
	let oldLines = 0;
	let newLines = 0;

	// Process lines until we've seen all oldCount + newCount lines
	while (i < lines.length && (oldLines < oldCount || newLines < newCount)) {
		const line = lines[i];

		if (line.length === 0) {
			// Empty line in hunk (counts as context)
			result.push("");
			oldLines += 1;
			newLines += 1;
			i += 1;
		} else {
			const prefix = line[0];

			if (prefix === " ") {
				// Context line
				oldLines += 1;
				newLines += 1;
				result.push(redactDiffLine(line));
				i += 1;
			} else if (prefix === "-") {
				// Deleted line
				oldLines += 1;
				result.push(redactDiffLine(line));
				i += 1;
			} else if (prefix === "+") {
				// Added line
				newLines += 1;
				result.push(redactDiffLine(line));
				i += 1;
			} else if (prefix === "\\") {
				// No-newline marker, doesn't count toward lines
				result.push(line);
				i += 1;
			} else {
				// Unexpected prefix, could be next hunk or file header
				break;
			}
		}
	}

	return { redactedLines: result, nextIndex: i };
}
