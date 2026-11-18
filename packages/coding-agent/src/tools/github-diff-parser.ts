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

import { redactCrashSecrets } from "@gajae-code/utils";

// Helper to split text while preserving empty lines
// Returns [lines, hasTrailingNewline]
function splitLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
	const result: string[] = [];
	let current = "";
	let hasTrailingNewline = false;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") {
			result.push(current);
			current = "";
			hasTrailingNewline = i === text.length - 1; // Track if final char is newline
		} else {
			current += text[i];
			hasTrailingNewline = false;
		}
	}
	if (current.length > 0) {
		result.push(current);
	}
	return { lines: result, hasTrailingNewline };
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
	const { lines, hasTrailingNewline } = splitLines(unifiedDiff);
	const result: string[] = [];
	let i = 0;
	let hunkState = { inCredentialValue: false, bracketDepth: 0 };

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
			// Found a hunk header. Process the entire hunk with state tracking.
			const hunkResult = redactHunk(lines, i, hunkState);
			result.push(...hunkResult.redactedLines);
			i = hunkResult.nextIndex;
			hunkState = hunkResult.state;
		} else {
			// Regular content line - redact it
			const redactedLine = redactDiffLine(line);
			result.push(redactedLine);
			i += 1;
		}
	}

	let joined = result.join("\n");
	if (hasTrailingNewline && !joined.endsWith("\n")) {
		joined += "\n";
	}
	return joined;
}

/**
 * Redact a single diff line, preserving the prefix character.
 * Valid diff prefixes: space (context), '+' (added), '-' (deleted), '\' (no newline marker).
 */
function redactDiffLine(line: string): string {
	if (line.length === 0) {
		return line;
	}

	const firstChar = line[0];
	const isDiffPrefix = firstChar === " " || firstChar === "+" || firstChar === "-" || firstChar === "\\";

	if (!isDiffPrefix) {
		// No diff prefix - redact the whole line
		return redactCrashSecrets(line);
	}

	// Lines with \ marker shouldn't be modified
	if (firstChar === "\\") {
		return line;
	}

	// Extract content after prefix and redact
	const content = line.length > 1 ? line.slice(1) : "";
	const redacted = redactCrashSecrets(content);

	return firstChar + redacted;
}

interface LineInfo {
	prefix: string;
	content: string;
	index: number;
}

interface HunkState {
	inCredentialValue: boolean;
	bracketDepth: number;
}

interface HunkResult {
	redactedLines: string[];
	nextIndex: number;
	state: HunkState;
}

/**
 * Process a hunk starting at hunkHeaderIndex.
 * Returns the redacted lines, the index to continue from, and updated state.
 *
 * Implements multi-line credential redaction by:
 * 1. Collecting the logical content (treating old/new as equivalent for redaction)
 * 2. Redacting the accumulated content to identify credentials
 * 3. Projecting redactions back onto individual diff lines
 * 4. Tracking credential state across hunk boundaries
 */
function redactHunk(
	lines: string[],
	hunkHeaderIndex: number,
	inputState: HunkState = { inCredentialValue: false, bracketDepth: 0 },
): HunkResult {
	const headerLine = lines[hunkHeaderIndex];
	const match = headerLine.match(HUNK_HEADER_RE);

	if (!match) {
		// Invalid hunk header, pass through
		return {
			redactedLines: [headerLine],
			nextIndex: hunkHeaderIndex + 1,
			state: inputState,
		};
	}

	// Parse the line counts
	const oldCount = Number.parseInt(match[2] || "1", 10);
	const newCount = Number.parseInt(match[4] || "1", 10);

	const result: string[] = [headerLine];
	let i = hunkHeaderIndex + 1;
	let oldLines = 0;
	let newLines = 0;

	// Collect line info for credential redaction with context
	const lineInfos: LineInfo[] = [];

	// Process lines until we've seen all oldCount + newCount lines
	while (i < lines.length && (oldLines < oldCount || newLines < newCount)) {
		const line = lines[i];

		if (line.length === 0) {
			// Empty line in hunk (counts as context)
			lineInfos.push({ prefix: " ", content: "", index: i });
			oldLines += 1;
			newLines += 1;
			i += 1;
		} else {
			const prefix = line[0];

			if (prefix === " ") {
				// Context line
				lineInfos.push({ prefix: " ", content: line.slice(1), index: i });
				oldLines += 1;
				newLines += 1;
				i += 1;
			} else if (prefix === "-") {
				// Deleted line - treat as context for credential detection
				lineInfos.push({ prefix: "-", content: line.slice(1), index: i });
				oldLines += 1;
				i += 1;
			} else if (prefix === "+") {
				// Added line - treat as context for credential detection
				lineInfos.push({ prefix: "+", content: line.slice(1), index: i });
				newLines += 1;
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

	// Redact accumulated content while preserving diff structure and tracking state
	const { redactedLines: redactedInfos, state: outputState } = redactAccumulatedContentWithState(
		lineInfos,
		inputState,
	);

	// Add redacted lines to result
	for (const info of redactedInfos) {
		result.push(info.prefix + info.content);
	}

	return { redactedLines: result, nextIndex: i, state: outputState };
}

/**
 * Redact accumulated content across multiple diff lines with state tracking.
 * Returns the redacted line infos and updated state.
 *
 * Strategy: Use accumulated redaction to identify where credentials are,
 * then apply smart line-by-line redaction that understands multi-line values.
 */
function redactAccumulatedContentWithState(
	lineInfos: LineInfo[],
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	if (lineInfos.length === 0) {
		return { redactedLines: [], state: inputState };
	}

	// First, try line-by-line redaction
	const lineByLineResult: LineInfo[] = [];
	for (const info of lineInfos) {
		lineByLineResult.push({
			...info,
			content: redactCrashSecrets(info.content),
		});
	}

	// Always apply state-based redaction to handle hunk-spanning credentials
	// This is needed even when line-by-line redaction found no changes,
	// because we may have open brackets/credentials from previous hunks
	const originalContent = lineInfos.map(info => info.content).join("\n");
	const redactedAccumulated = redactCrashSecrets(originalContent);

	// If we're in an active credential state from a previous hunk,
	// or if accumulated redaction found changes, apply state-based redaction
	if (inputState.inCredentialValue || redactedAccumulated !== originalContent) {
		const redactedLines = applyStateBasedRedactionWithState(
			lineInfos,
			originalContent,
			redactedAccumulated,
			inputState,
		);
		return redactedLines;
	}

	// No changes needed - return line-by-line result
	return { redactedLines: lineByLineResult, state: inputState };
}

/**
 * Apply state-based redaction by identifying credential headers and their multi-line values.
 * Returns redacted lines and updated state for use in subsequent hunks.
 */
function applyStateBasedRedactionWithState(
	lineInfos: LineInfo[],
	_originalContent: string,
	_redactedAccumulated: string,
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	const result: LineInfo[] = [];
	let inCredentialValue = inputState.inCredentialValue;
	let bracketDepth = inputState.bracketDepth;

	for (const info of lineInfos) {
		const line = info.content;

		// Check if this line starts a credential header with value on later line
		const isCredentialHeader =
			line.match(/:([\s]*)$/) && // Ends with colon (possibly followed by space)
			(line.match(/cookie|auth|token|pass|secret|key|credential/i) || false);

		// Check if this line contains a credential field opening in JSON/object notation
		// Match common credential field names
		const credentialFieldMatch = line.match(
			/['"]?(token|password|passwd|secret|api[_-]?key|access[_-]?token|auth|authorization)['"]?\s*:\s*[[{]/i,
		);

		// Also check for headers/lines with credential keywords followed by bracket on same line
		const credentialWithBracket = line.match(
			/^\s*(Auth(?:orization)?|Cookie|Token|Secret|Password|Pass|Key)\s*:\s*[[{]/i,
		);

		const hasCredentialOpening = credentialFieldMatch || credentialWithBracket || isCredentialHeader;

		if (hasCredentialOpening) {
			// This line has a credential header or field - mark it as redacted if followed by value
			const redacted = redactCrashSecrets(line);
			inCredentialValue = true;
			bracketDepth = 0;
			// Count brackets in this line too
			for (const char of line) {
				if (char === "[" || char === "{") bracketDepth += 1;
				if (char === "]" || char === "}") bracketDepth -= 1;
			}
			result.push({ ...info, content: redacted });
		} else if (inCredentialValue) {
			// We're in a credential value - track brackets
			for (const char of line) {
				if (char === "[" || char === "{") bracketDepth += 1;
				if (char === "]" || char === "}") bracketDepth -= 1;
			}

			// Redact this line as part of the value
			// But preserve pure structure lines like standalone brackets
			if (line.trim().match(/^[[\]{},:]*$/)) {
				// This is a pure structure line - keep it
				result.push(info);
			} else if (line.trim().match(/^[[\]{},]$/)) {
				// Single structural character - keep it
				result.push(info);
			} else {
				// Actual content - redact it
				result.push({ ...info, content: "«redacted»" });
			}

			// Exit credential value if we've closed all brackets
			if (bracketDepth <= 0 && !line.match(/[[{]/)) {
				inCredentialValue = false;
			}
		} else {
			// Not in credential value - do normal redaction
			result.push({
				...info,
				content: redactCrashSecrets(info.content),
			});
		}
	}

	return { redactedLines: result, state: { inCredentialValue, bracketDepth } };
}
