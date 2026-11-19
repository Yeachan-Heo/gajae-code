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
	const initialState: HunkState = { inCredentialValue: false, bracketDepth: 0, bracketStack: [], inPemBlock: false };
	let hunkState = initialState;

	while (i < lines.length) {
		const line = lines[i];

		// Reset credential state at file boundaries
		if (line.startsWith("diff --git")) {
			// Redact paths in diff --git headers if they contain credential-like filenames
			// Handle both unquoted and C-quoted paths
			const gitMatch = line.match(/^diff --git (.+) (.+)$/);
			if (gitMatch) {
				const oldPath = gitMatch[1];
				const newPath = gitMatch[2];
				const redactedOld = redactDiffHeaderPath(oldPath);
				const redactedNew = redactDiffHeaderPath(newPath);
				result.push(`diff --git ${redactedOld} ${redactedNew}`);
			} else {
				result.push(line);
			}
			i += 1;
			hunkState = { ...initialState }; // Reset for new file
		} else if (line.startsWith("Binary files")) {
			// Scrub paths in binary diff lines: "Binary files a/... and b/... differ"
			const binaryMatch = line.match(/^Binary files (.+) and (.+) differ$/);
			if (binaryMatch) {
				const oldPath = binaryMatch[1];
				const newPath = binaryMatch[2];
				const redactedOld = redactDiffHeaderPath(oldPath);
				const redactedNew = redactDiffHeaderPath(newPath);
				result.push(`Binary files ${redactedOld} and ${redactedNew} differ`);
			} else {
				result.push(line);
			}
			i += 1;
		} else if (line.startsWith("index ")) {
			result.push(line);
			i += 1;
		} else if (line.startsWith("--- ")) {
			// Redact old-side path for credential-shaped filenames
			const minusMatch = line.match(/^--- (.+)$/);
			if (minusMatch) {
				const redactedPath = redactDiffHeaderPath(minusMatch[1]);
				result.push(`--- ${redactedPath}`);
			} else {
				result.push(redactDiffLine(line));
			}
			i += 1;
		} else if (line.startsWith("+++ ")) {
			// Redact new-side path for credential-shaped filenames
			const plusMatch = line.match(/^\+\+\+ (.+)$/);
			if (plusMatch) {
				const redactedPath = redactDiffHeaderPath(plusMatch[1]);
				result.push(`+++ ${redactedPath}`);
			} else {
				result.push(redactDiffLine(line));
			}
			i += 1;
		} else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
			// Scrub credential-shaped paths in rename headers
			const renameMatch = line.match(/^(rename (?:from|to) )(.+)$/);
			if (renameMatch) {
				const prefix = renameMatch[1];
				const path = renameMatch[2];
				const redactedPath = redactPathInDiffHeader(path);
				result.push(`${prefix}${redactedPath}`);
			} else {
				result.push(line);
			}
			i += 1;
		} else if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
			// Scrub credential-shaped paths in copy headers
			const copyMatch = line.match(/^(copy (?:from|to) )(.+)$/);
			if (copyMatch) {
				const prefix = copyMatch[1];
				const path = copyMatch[2];
				const redactedPath = redactPathInDiffHeader(path);
				result.push(`${prefix}${redactedPath}`);
			} else {
				result.push(line);
			}
			i += 1;
		} else if (
			line.startsWith("old mode") ||
			line.startsWith("new mode") ||
			line.startsWith("mode ") ||
			line.startsWith("similarity ")
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
 * Parse and redact a diff header path, handling both unquoted and C-quoted formats.
 * C-quoted paths look like: "a/file name" or "a/file\nname"
 * Returns the original format with redacted path content.
 */
function redactDiffHeaderPath(headerPath: string): string {
	// Check if path is C-quoted (starts and ends with quotes)
	if (headerPath.startsWith('"') && headerPath.endsWith('"')) {
		// C-quoted path: extract the prefix (a/ or b/), path, and suffix
		const innerPath = headerPath.slice(1, -1); // Remove quotes
		const innerMatch = innerPath.match(/^([ab])\/(.*)$/);
		if (innerMatch) {
			const prefix = innerMatch[1];
			const path = innerMatch[2];
			const redacted = redactPathInDiffHeader(path);
			// Return in quoted format
			return `"${prefix}/${redacted}"`;
		}
		return headerPath; // Return unchanged if parsing failed
	}

	// Unquoted path: extract prefix (a/ or b/) and redact the path part
	const unquotedMatch = headerPath.match(/^([ab])\/(.*)$/);
	if (unquotedMatch) {
		const prefix = unquotedMatch[1];
		const path = unquotedMatch[2];
		const redacted = redactPathInDiffHeader(path);
		return `${prefix}/${redacted}`;
	}

	return headerPath; // Return unchanged if neither format matched
}

/**
 * Redact paths in diff headers that may contain credential-shaped filenames.
 * Paths like 'src/secret-api-key.json' should be replaced with generic names.
 *
 * We redact path COMPONENTS that clearly indicate credentials:
 * - Explicit credential keywords: secret, token, password, api-key, etc.
 * - GitHub token patterns: ghp_*, gho_*, ghu_*, etc. (40+ chars of alphanumeric)
 * - AWS-style tokens: AKIA followed by 16 uppercase alphanumeric
 * - Generic token-shaped values: continuous sequences that look like tokens
 */
function redactPathInDiffHeader(pathSection: string): string {
	// Split path into components and check each one
	const components = pathSection.split("/");

	for (const component of components) {
		// Check for explicit credential keywords
		const credentialKeywordPattern =
			/(?:^|[-_.])(?:secret|token|password|api[_-]?key|credential|private[_-]?key)(?:[-_.]|$|\.[a-z]+$)/i;

		if (credentialKeywordPattern.test(component)) {
			return "file-redacted";
		}

		// Check for GitHub token patterns (ghp_, gho_, ghu_, etc.)
		// GitHub tokens have specific prefixes and are followed by 36-40+ hex/alphanumeric characters
		if (/(^|[-_.])(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9_]+/i.test(component)) {
			return "file-redacted";
		}

		// Check for AWS access key patterns (AKIA followed by 16 uppercase alphanumeric)
		if (/AKIA[0-9A-Z]{16}/i.test(component)) {
			return "file-redacted";
		}

		// Check for other token-shaped patterns in filenames
		// Only redact if it looks like a hex/base64 token, not a service name or class name
		const hexTokenMatch = component.match(/[a-f0-9]{20,}|[A-Z0-9]{30,}/i);
		if (hexTokenMatch) {
			// This looks like a hex token or base64 blob in the filename
			return "file-redacted";
		}
	}

	return pathSection;
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
	inPemBlock: boolean; // Track if we're inside a PEM block
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
	inputState: HunkState = { inCredentialValue: false, bracketDepth: 0, bracketStack: [], inPemBlock: false },
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
	const optionalContext = match[2];

	// Scrub the optional context (source-derived section) which may contain credentials.
	// This includes hunk context suffix like function name which could have credential values.
	let scrubbedHeaderLine: string;
	if (optionalContext !== undefined) {
		// There was a space separator in the original; preserve it even if context is empty
		const scrubbedContext = redactCrashSecrets(optionalContext);
		scrubbedHeaderLine = `${hunkHeaderCore} ${scrubbedContext}`;
	} else {
		// No space separator in the original
		scrubbedHeaderLine = hunkHeaderCore;
	}

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
 * Strategy: Keep old-side and new-side projections independent to prevent
 * state leakage between diff projections. Process each side separately,
 * then apply state-based tracking across all content to identify multi-line
 * credentials while respecting structural boundaries.
 */
function redactAccumulatedContentWithState(
	lineInfos: LineInfo[],
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	if (lineInfos.length === 0) {
		return { redactedLines: [], state: inputState };
	}

	// Process old-side and new-side projections independently to prevent
	// state leakage. A bracket on the deleted side must not interfere with
	// the added side's credential tracking.
	const oldSideLines = lineInfos.filter(info => info.prefix === "-" || info.prefix === " ");
	const newSideLines = lineInfos.filter(info => info.prefix === "+" || info.prefix === " ");

	// Get separate redacted versions for old and new sides
	const originalContent = lineInfos.map(info => info.content).join("\n");
	const oldSideContent = oldSideLines.map(info => info.content).join("\n");
	const newSideContent = newSideLines.map(info => info.content).join("\n");

	const redactedAccumulated = redactCrashSecrets(originalContent);
	const oldSideRedacted = redactCrashSecrets(oldSideContent);
	const newSideRedacted = redactCrashSecrets(newSideContent);

	// Apply state-based redaction with separate projection tracking
	const redactedLines = applyStateBasedRedactionWithIndependentProjections(
		lineInfos,
		originalContent,
		redactedAccumulated,
		oldSideRedacted,
		newSideRedacted,
		inputState,
	);

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
 * Identify which original line indices should be fully redacted based on accumulated redaction.
 * This catches multi-line credentials that don't match our pattern heuristics.
 *
 * We only use this for detecting when the ENTIRE hunk is replaced by a single marker
 * (e.g., pure PEM blocks). For mixed content, rely on state-based line-by-line tracking.
 */
function findFullyRedactedLinesByAccumulation(
	lineInfos: LineInfo[],
	originalContent: string,
	redactedAccumulated: string,
): Set<number> {
	const fullyRedactedLines = new Set<number>();

	// If no changes, nothing to redact
	if (redactedAccumulated === originalContent) {
		return fullyRedactedLines;
	}

	// Only mark all lines as fully redacted if the ENTIRE accumulated content becomes a single marker
	if (
		redactedAccumulated.match(/^«[a-z-]+»$/) ||
		redactedAccumulated.match(/^«[a-z-]+»\n?$/) ||
		redactedAccumulated.trim().match(/^«[a-z-]+»$/)
	) {
		// Entire content was replaced with a single redaction marker
		// This is the PEM-only case: multiple original lines become one marker
		for (let i = 0; i < lineInfos.length; i += 1) {
			fullyRedactedLines.add(i);
		}
	}

	return fullyRedactedLines;
}

/**
 * Apply state-based redaction with independent old/new projections.
 * Keeps bracket state separate for old-side and new-side to prevent
 * credentials in one projection from interfering with the other.
 */
function applyStateBasedRedactionWithIndependentProjections(
	lineInfos: LineInfo[],
	originalContent: string,
	redactedAccumulated: string,
	_oldSideRedacted: string,
	_newSideRedacted: string,
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	const result: LineInfo[] = [];
	const fileState = inputState;

	// First, identify if the entire hunk is a multi-line credential that gets fully redacted
	const fullyRedactedLines = findFullyRedactedLinesByAccumulation(lineInfos, originalContent, redactedAccumulated);

	// Quick path: if no redactions found and not in an open state, do simple per-line redaction
	if (fullyRedactedLines.size === 0 && redactedAccumulated === originalContent && !inputState.inCredentialValue) {
		for (const info of lineInfos) {
			result.push({
				...info,
				content: redactCrashSecrets(info.content),
			});
		}
		return { redactedLines: result, state: inputState };
	}

	// Process each line with independent projection-aware state tracking
	for (let lineIdx = 0; lineIdx < lineInfos.length; lineIdx += 1) {
		const info = lineInfos[lineIdx];
		const line = info.content;

		// If this line was identified as fully redacted by the accumulated redactor
		if (fullyRedactedLines.has(lineIdx)) {
			result.push({ ...info, content: "«redacted»" });
			continue;
		}

		// Check if this line is a PEM block marker
		const isPemBlockStart = line.match(/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
		const isPemBlockEnd = line.match(/^-----END [A-Z0-9 ]*PRIVATE KEY-----/);

		// Handle PEM block state
		if (isPemBlockStart || fileState.inPemBlock) {
			if (isPemBlockStart) {
				fileState.inPemBlock = true;
			}
			if (isPemBlockEnd) {
				fileState.inPemBlock = false;
			}
			result.push({ ...info, content: "«redacted»" });
			continue;
		}

		// Apply independent projection-aware credential tracking
		const redactedContent = redactCrashSecrets(line);

		// Check if this line starts a credential header with value on later line
		const isCredentialHeader =
			line.match(/:(\s*)$/) && // Ends with colon (possibly followed by space)
			(line.match(/cookie|auth|token|pass|secret|key|credential/i) || false);

		// Check if this line contains a credential field opening in JSON/object notation
		const credentialFieldMatch = line.match(
			/['"$]?(token|password|passwd|secret|api[_-]?key|access[_-]?token|auth|authorization)['"]?\s*:\s*[[{]/i,
		);

		// Also check for headers/lines with credential keywords followed by bracket on same line
		const credentialWithBracket = line.match(
			/^\s*(Auth(?:orization)?|Cookie|Token|Secret|Password|Pass|Key)\s*:\s*[[{]/i,
		);

		const hasCredentialOpening =
			credentialFieldMatch || credentialWithBracket || isCredentialHeader || isPemBlockStart;

		if (hasCredentialOpening) {
			// This line starts a credential header or field
			fileState.inCredentialValue = true;
			fileState.bracketDepth = 0;
			fileState.bracketStack = [];
			// Count brackets in this line using quote-aware matching
			const { depthDelta, newStack } = countBracketsQuoteAwareWithStack(line, fileState.bracketStack);
			fileState.bracketDepth += depthDelta;
			fileState.bracketStack = newStack;
			result.push({ ...info, content: redactedContent });
		} else if (fileState.inCredentialValue) {
			// We're in a credential value - track brackets with quote awareness
			const { depthDelta, newStack } = countBracketsQuoteAwareWithStack(line, fileState.bracketStack);
			fileState.bracketDepth += depthDelta;
			fileState.bracketStack = newStack;

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
			if (fileState.bracketDepth <= 0 && !line.match(/[[{]/)) {
				fileState.inCredentialValue = false;
			}
		} else {
			// Not in credential value - do normal per-line redaction
			result.push({
				...info,
				content: redactedContent,
			});
		}
	}

	return { redactedLines: result, state: fileState };
}
