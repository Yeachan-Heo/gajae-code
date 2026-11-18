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

// Helper to split text while preserving empty lines and tracking terminal newline.
// Returns [lines, hasTrailingNewline]
function splitLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
	const result: string[] = [];
	let current = "";
	let hasTrailingNewline = false;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") {
			result.push(current);
			current = "";
			// hasTrailingNewline tracks whether the final split ended with newline
			hasTrailingNewline = i === text.length - 1;
		} else {
			current += text[i];
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

/** Hunk header format: @@ -oldStart,oldCount +newStart,newCount @@ or with optional context */
const HUNK_HEADER_RE = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(?: (.*))?$/;

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
	const initialState: HunkState = { inCredentialValue: false, bracketDepth: 0, bracketStack: [] };
	let hunkState = initialState;

	while (i < lines.length) {
		const line = lines[i];

		// Reset credential state at file boundaries
		if (line.startsWith("diff --git")) {
			result.push(line);
			i += 1;
			hunkState = { ...initialState }; // Reset for new file
		} else if (line.startsWith("index ")) {
			result.push(line);
			i += 1;
		} else if (line.startsWith("--- ")) {
			// Scrub old-side path for credential-shaped filenames
			result.push(redactDiffLine(line));
			i += 1;
		} else if (line.startsWith("+++ ")) {
			// Scrub new-side path for credential-shaped filenames
			result.push(redactDiffLine(line));
			i += 1;
		} else if (
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
	noNewlineMarker?: boolean; // True if this line is immediately followed by a no-newline marker
}

interface HunkState {
	inCredentialValue: boolean;
	bracketDepth: number;
	bracketStack: string[]; // Track opening bracket types to validate matching
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
 * 5. Scrubbing optional source-derived context in hunk headers
 * 6. Preserving no-newline markers in correct order
 */
function redactHunk(
	lines: string[],
	hunkHeaderIndex: number,
	inputState: HunkState = { inCredentialValue: false, bracketDepth: 0, bracketStack: [] },
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

	// Extract hunk header parts: hunk metadata and optional source-derived context
	const hunkHeaderCore = match[1];
	const optionalContext = match[2] || "";

	// Scrub the optional context (source-derived section) which may contain credentials.
	// This includes hunk context suffix like function name which could have credential values.
	const scrubbedContext = optionalContext ? redactCrashSecrets(optionalContext) : "";
	const scrubbedHeaderLine = scrubbedContext ? `${hunkHeaderCore} ${scrubbedContext}` : hunkHeaderCore;

	// Parse the line counts from the core header
	const coreMatch = hunkHeaderCore.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/);
	if (!coreMatch) {
		return {
			redactedLines: [scrubbedHeaderLine],
			nextIndex: hunkHeaderIndex + 1,
			state: inputState,
		};
	}

	const oldCount = Number.parseInt(coreMatch[2] || "1", 10);
	const newCount = Number.parseInt(coreMatch[4] || "1", 10);

	const result: string[] = [scrubbedHeaderLine];
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
				const lineInfo: LineInfo = { prefix: " ", content: line.slice(1), index: i };
				oldLines += 1;
				newLines += 1;
				i += 1;
				// Check if next line is a no-newline marker
				if (i < lines.length && lines[i] === "\\ No newline at end of file") {
					lineInfo.noNewlineMarker = true;
					i += 1;
				}
				lineInfos.push(lineInfo);
			} else if (prefix === "-") {
				// Deleted line - treat as context for credential detection
				const lineInfo: LineInfo = { prefix: "-", content: line.slice(1), index: i };
				oldLines += 1;
				i += 1;
				// Check if next line is a no-newline marker
				if (i < lines.length && lines[i] === "\\ No newline at end of file") {
					lineInfo.noNewlineMarker = true;
					i += 1;
				}
				lineInfos.push(lineInfo);
			} else if (prefix === "+") {
				// Added line - treat as context for credential detection
				const lineInfo: LineInfo = { prefix: "+", content: line.slice(1), index: i };
				newLines += 1;
				i += 1;
				// Check if next line is a no-newline marker
				if (i < lines.length && lines[i] === "\\ No newline at end of file") {
					lineInfo.noNewlineMarker = true;
					i += 1;
				}
				lineInfos.push(lineInfo);
			} else if (prefix === "\\") {
				// Unexpected no-newline marker at this position, skip
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

	// Add redacted lines to result, restoring no-newline markers at their original positions
	for (const info of redactedInfos) {
		result.push(info.prefix + info.content);
		// Emit no-newline marker immediately after the line it describes
		if (info.noNewlineMarker) {
			result.push("\\ No newline at end of file");
		}
	}

	return { redactedLines: result, nextIndex: i, state: outputState };
}

/**
 * Redact accumulated content across multiple diff lines with state tracking.
 * Returns the redacted line infos and updated state.
 *
 * Strategy: Use accumulated redaction with the shared redactor to identify
 * where credentials are located and their byte offsets, then apply those
 * redactions back onto individual diff lines while preserving state across
 * hunk and file boundaries.
 */
function redactAccumulatedContentWithState(
	lineInfos: LineInfo[],
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	if (lineInfos.length === 0) {
		return { redactedLines: [], state: inputState };
	}

	// Get redacted version from shared redactor to identify credential boundaries
	const originalContent = lineInfos.map(info => info.content).join("\n");
	const redactedAccumulated = redactCrashSecrets(originalContent);

	// Always apply state-based redaction to handle hunk-spanning credentials and
	// to properly project shared redactor results back onto individual diff lines.
	// This is needed even when no line-by-line changes were found,
	// because we may have open brackets/credentials from previous hunks.
	const redactedLines = applyStateBasedRedactionWithState(lineInfos, originalContent, redactedAccumulated, inputState);

	return redactedLines;
}

/**
 * Track bracket depth with quote awareness and matching pair validation.
 * Ensures `]` only closes `[` and `}` only closes `{` to avoid false matches
 * on malformed bracket nesting. Maintains bracket stack across calls for state tracking.
 */
function countBracketsQuoteAwareWithStack(
	text: string,
	bracketStack: string[],
): { depthDelta: number; newStack: string[] } {
	let depth = 0;
	let inString = false;
	let stringChar: string | null = null;
	const stack = [...bracketStack]; // Copy to maintain immutability

	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];

		// Handle escape sequences
		if (inString && char === "\\") {
			i += 1; // Skip next character
			continue;
		}

		// Track quote state
		if ((char === '"' || char === "'") && (!inString || char === stringChar)) {
			inString = !inString;
			stringChar = inString ? char : null;
			continue;
		}

		// Count brackets only when not inside a string
		if (!inString) {
			if (char === "[") {
				depth += 1;
				stack.push("[");
			} else if (char === "{") {
				depth += 1;
				stack.push("{");
			} else if (char === "]") {
				// Only close if top is matching bracket
				if (stack.length > 0 && stack[stack.length - 1] === "[") {
					depth -= 1;
					stack.pop();
				}
				// Otherwise, mismatched closer; don't decrement
			} else if (char === "}") {
				// Only close if top is matching bracket
				if (stack.length > 0 && stack[stack.length - 1] === "{") {
					depth -= 1;
					stack.pop();
				}
				// Otherwise, mismatched closer; don't decrement
			}
		}
	}

	return { depthDelta: depth, newStack: stack };
}

/**
 * Apply state-based redaction using the shared redactor's output to identify
 * credential boundaries, then track multi-line credential state with quote-aware
 * bracket matching. Returns redacted lines and updated state for use in subsequent hunks.
 */
function applyStateBasedRedactionWithState(
	lineInfos: LineInfo[],
	originalContent: string,
	redactedAccumulated: string,
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	const result: LineInfo[] = [];
	let inCredentialValue = inputState.inCredentialValue;
	let bracketDepth = inputState.bracketDepth;
	let bracketStack = [...inputState.bracketStack];

	// Quick path: if no redactions found and not in an open state, do simple per-line redaction
	if (redactedAccumulated === originalContent && !inputState.inCredentialValue) {
		for (const info of lineInfos) {
			result.push({
				...info,
				content: redactCrashSecrets(info.content),
			});
		}
		return { redactedLines: result, state: inputState };
	}

	// When the shared redactor found changes or we're in an open credential state,
	// apply line-by-line state tracking with bracket awareness.
	for (const info of lineInfos) {
		const line = info.content;

		// Check if this line starts a credential header with value on later line
		const isCredentialHeader =
			line.match(/:(\s*)$/) && // Ends with colon (possibly followed by space)
			(line.match(/cookie|auth|token|pass|secret|key|credential/i) || false);

		// Check if this line contains a credential field opening in JSON/object notation
		const credentialFieldMatch = line.match(
			/['"]?(token|password|passwd|secret|api[_-]?key|access[_-]?token|auth|authorization)['"]?\s*:\s*[[{]/i,
		);

		// Also check for headers/lines with credential keywords followed by bracket on same line
		const credentialWithBracket = line.match(
			/^\s*(Auth(?:orization)?|Cookie|Token|Secret|Password|Pass|Key)\s*:\s*[[{]/i,
		);

		const hasCredentialOpening = credentialFieldMatch || credentialWithBracket || isCredentialHeader;

		if (hasCredentialOpening) {
			// This line starts a credential header or field
			const redacted = redactCrashSecrets(line);
			inCredentialValue = true;
			bracketDepth = 0;
			bracketStack = [];
			// Count brackets in this line using quote-aware matching
			const { depthDelta, newStack } = countBracketsQuoteAwareWithStack(line, bracketStack);
			bracketDepth += depthDelta;
			bracketStack = newStack;
			result.push({ ...info, content: redacted });
		} else if (inCredentialValue) {
			// We're in a credential value - track brackets with quote awareness
			const { depthDelta, newStack } = countBracketsQuoteAwareWithStack(line, bracketStack);
			bracketDepth += depthDelta;
			bracketStack = newStack;

			// Redact this line as part of the credential value
			// But preserve pure structure lines like standalone brackets
			if (line.trim().match(/^[[\]{},:]*$/)) {
				// This is a pure structure line - keep it as-is
				result.push(info);
			} else {
				// Actual content - redact it
				result.push({ ...info, content: "«redacted»" });
			}

			// Exit credential value when all brackets are closed
			if (bracketDepth <= 0 && !line.match(/[[{]/)) {
				inCredentialValue = false;
			}
		} else {
			// Not in credential value - do normal per-line redaction
			result.push({
				...info,
				content: redactCrashSecrets(info.content),
			});
		}
	}

	return { redactedLines: result, state: { inCredentialValue, bracketDepth, bracketStack } };
}
