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

import { redactCrashSecrets, redactCrashSecretsPreservingLines } from "@gajae-code/utils";

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
			const paths = parseDiffGitPaths(line);
			if (paths) {
				const redactedOld = redactDiffHeaderPath(paths.oldPath);
				const redactedNew = redactDiffHeaderPath(paths.newPath);
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
			// Found a hunk header. Collect all hunks for this file until the next file or EOF.
			const hunksResult = redactAllHunksInFile(lines, i, hunkState);
			result.push(...hunksResult.redactedLines);
			i = hunksResult.nextIndex;
			hunkState = hunksResult.state;
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
 * Parse a "diff --git" line to extract old and new paths.
 * Handles both unquoted paths (no spaces) and C-quoted paths (can contain spaces).
 * Returns {oldPath, newPath} or null if parsing fails.
 */
function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } | null {
	if (!line.startsWith("diff --git ")) return null;

	const rest = line.slice("diff --git ".length);
	let oldPath: string | null = null;
	let newPath: string | null = null;
	let pos = 0;

	// Parse first path (old path)
	if (rest[pos] === '"') {
		// C-quoted path: find the closing quote, handling escapes
		pos += 1; // Skip opening quote
		let endPos = pos;
		while (endPos < rest.length) {
			if (rest[endPos] === "\\" && endPos + 1 < rest.length) {
				endPos += 2; // Skip escape sequence
			} else if (rest[endPos] === '"') {
				oldPath = rest.slice(0, endPos + 1); // Include quotes
				pos = endPos + 1;
				break;
			} else {
				endPos += 1;
			}
		}
	} else {
		// Unquoted path: read until space
		const spaceIndex = rest.indexOf(" ", pos);
		if (spaceIndex === -1) return null;
		oldPath = rest.slice(pos, spaceIndex);
		pos = spaceIndex;
	}

	if (!oldPath) return null;

	// Skip spaces between paths
	while (pos < rest.length && rest[pos] === " ") {
		pos += 1;
	}

	// Parse second path (new path)
	if (pos < rest.length) {
		if (rest[pos] === '"') {
			// C-quoted path: take everything from pos to end (including quotes)
			newPath = rest.slice(pos);
		} else {
			// Unquoted path: take everything from pos to end
			newPath = rest.slice(pos);
		}
	}

	if (!newPath) return null;

	return { oldPath, newPath };
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
 * Shared credential detector: checks if a path component is credential-shaped.
 * Used by both diff header scrubbing and metadata redaction to ensure consistent rules.
 *
 * Returns true if the component should be redacted; false otherwise.
 */
export function isCredentialShapedPathComponent(component: string): boolean {
	// Check for explicit credential keywords (including when separated by spaces)
	const credentialKeywordPattern =
		/(?:^|[-_. ])(?:secret|token|password|api[_-]?key|credential|private[_-]?key|refresh[_-]?token)(?:[-_. ]|$|\.[a-z]+$)/i;

	if (credentialKeywordPattern.test(component)) {
		return true;
	}

	// Check for GitHub token patterns (ghp_, gho_, ghu_, etc.)
	// GitHub tokens have specific prefixes and are followed by 36-40+ hex/alphanumeric characters
	if (/(^|[-_.])(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9_]+/i.test(component)) {
		return true;
	}

	// Check for AWS access key patterns (AKIA followed by 16 uppercase alphanumeric)
	if (/AKIA[0-9A-Z]{16}/i.test(component)) {
		return true;
	}

	// Check for other token-shaped patterns in filenames
	// Only redact if it looks like a hex/base64 token, not a service name or class name
	const hexTokenMatch = component.match(/[a-f0-9]{20,}|[A-Z0-9]{30,}/i);
	if (hexTokenMatch) {
		// This looks like a hex token or base64 blob in the filename
		return true;
	}

	return false;
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
		if (isCredentialShapedPathComponent(component)) {
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
	inYamlBlockScalar?: boolean; // Track if we're in a YAML block scalar (terminated by dedent or end of hunk)
	// Independent tracking for old-side (deleted) and new-side (added) projections
	// This handles asymmetric containers where old side is deeper than new side
	oldSideBracketDepth?: number; // Old-side (context+deleted) bracket depth
	oldSideBracketStack?: string[]; // Old-side bracket stack
	newSideBracketDepth?: number; // New-side (context+added) bracket depth
	newSideBracketStack?: string[]; // New-side bracket stack
}

/**
 * Process all hunks in a file, building file-wide projections so containers can span hunks.
 * Collects all hunks between here and the next file/EOF, then redacts them as a unit.
 */
function redactAllHunksInFile(
	lines: string[],
	startHunkIndex: number,
	inputState: HunkState,
): { redactedLines: string[]; nextIndex: number; state: HunkState } {
	const hunks: Array<{ headerIndex: number; header: string; lineInfos: LineInfo[] }> = [];
	let i = startHunkIndex;

	// Collect all consecutive hunks until we hit a file boundary or EOF
	while (i < lines.length && lines[i].startsWith("@@")) {
		const headerIndex = i;
		const headerLine = lines[i];
		const match = headerLine.match(HUNK_HEADER_RE);

		if (!match) {
			// Invalid hunk header, skip
			i += 1;
			continue;
		}

		const hunkHeaderCore = match[1];
		const optionalContext = match[2];
		const scrubbedHeaderLine =
			optionalContext !== undefined ? `${hunkHeaderCore} ${redactCrashSecrets(optionalContext)}` : hunkHeaderCore;

		const coreMatch = hunkHeaderCore.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/);
		if (!coreMatch) {
			i += 1;
			continue;
		}

		const oldCount = Number.parseInt(coreMatch[2] || "1", 10);
		const newCount = Number.parseInt(coreMatch[4] || "1", 10);

		const lineInfos: LineInfo[] = [];
		i += 1;
		let oldLines = 0;
		let newLines = 0;

		// Collect lines for this hunk
		while (i < lines.length && (oldLines < oldCount || newLines < newCount)) {
			const line = lines[i];

			if (line.length === 0) {
				lineInfos.push({ prefix: " ", content: "", index: i });
				oldLines += 1;
				newLines += 1;
				i += 1;
			} else {
				const prefix = line[0];

				if (prefix === " ") {
					const lineInfo: LineInfo = { prefix: " ", content: line.slice(1), index: i };
					oldLines += 1;
					newLines += 1;
					i += 1;
					if (i < lines.length && lines[i] === "\\ No newline at end of file") {
						lineInfo.noNewlineMarker = true;
						i += 1;
					}
					lineInfos.push(lineInfo);
				} else if (prefix === "-") {
					const lineInfo: LineInfo = { prefix: "-", content: line.slice(1), index: i };
					oldLines += 1;
					i += 1;
					if (i < lines.length && lines[i] === "\\ No newline at end of file") {
						lineInfo.noNewlineMarker = true;
						i += 1;
					}
					lineInfos.push(lineInfo);
				} else if (prefix === "+") {
					const lineInfo: LineInfo = { prefix: "+", content: line.slice(1), index: i };
					newLines += 1;
					i += 1;
					if (i < lines.length && lines[i] === "\\ No newline at end of file") {
						lineInfo.noNewlineMarker = true;
						i += 1;
					}
					lineInfos.push(lineInfo);
				} else if (prefix === "\\") {
					i += 1;
				} else {
					// Hit next hunk or file boundary
					break;
				}
			}
		}

		hunks.push({ headerIndex, header: scrubbedHeaderLine, lineInfos });
	}

	// Now build file-wide projections across all hunks
	const allLineInfos: LineInfo[] = [];
	for (const hunk of hunks) {
		allLineInfos.push(...hunk.lineInfos);
	}

	const { redactedLines: redactedInfos, state: outputState } = redactAccumulatedContentWithState(
		allLineInfos,
		inputState,
	);

	// Map redacted lines back to individual hunks
	const result: string[] = [];
	let redactedIndex = 0;

	for (const hunk of hunks) {
		result.push(hunk.header);

		for (let _i = 0; _i < hunk.lineInfos.length; _i++) {
			if (redactedIndex < redactedInfos.length) {
				const redactedInfo = redactedInfos[redactedIndex];
				result.push(redactedInfo.prefix + redactedInfo.content);
				if (redactedInfo.noNewlineMarker) {
					result.push("\\ No newline at end of file");
				}
				redactedIndex += 1;
			}
		}
	}

	return { redactedLines: result, nextIndex: i, state: outputState };
}

/**
 * Redact accumulated content across multiple diff lines with per-side projection strategy.
 * Returns the redacted line infos and updated state.
 *
 * Uses redactCrashSecretsPreservingLines to maintain exact line counts, eliminating
 * the need for fail-closed behavior. Strategy:
 * 1. Build two projections: old = context + '-' lines, new = context + '+' lines
 * 2. Run redactCrashSecretsPreservingLines on each projection independently
 * 3. Map redacted lines back by index (line counts are guaranteed to match)
 * 4. For context lines, use the old-side redacted content (should be same on both sides)
 * 5. Track and return updated state for cross-hunk credential containers
 */
function redactAccumulatedContentWithState(
	lineInfos: LineInfo[],
	inputState: HunkState,
): { redactedLines: LineInfo[]; state: HunkState } {
	if (lineInfos.length === 0) {
		return { redactedLines: [], state: inputState };
	}

	// Build old-side projection: context lines + deleted lines, tracking their indices
	const oldProjectionIndices: number[] = [];
	const oldProjectionLines: string[] = [];
	for (let i = 0; i < lineInfos.length; i += 1) {
		const info = lineInfos[i];
		if (info.prefix === " " || info.prefix === "-") {
			oldProjectionIndices.push(i);
			oldProjectionLines.push(info.content);
		}
	}

	// Build new-side projection: context lines + added lines, tracking their indices
	const newProjectionIndices: number[] = [];
	const newProjectionLines: string[] = [];
	for (let i = 0; i < lineInfos.length; i += 1) {
		const info = lineInfos[i];
		if (info.prefix === " " || info.prefix === "+") {
			newProjectionIndices.push(i);
			newProjectionLines.push(info.content);
		}
	}

	// Join projections with newlines and redact them using line-preserving variant
	const oldProjectionOriginal = oldProjectionLines.length === 0 ? "" : oldProjectionLines.join("\n");
	const newProjectionOriginal = newProjectionLines.length === 0 ? "" : newProjectionLines.join("\n");
	const oldProjectionRedacted = redactCrashSecretsPreservingLines(oldProjectionOriginal);
	const newProjectionRedacted = redactCrashSecretsPreservingLines(newProjectionOriginal);

	// Split back to lines by newline, but handle empty projections
	const oldRedactedLines = oldProjectionRedacted === "" ? [] : oldProjectionRedacted.split("\n");
	const newRedactedLines = newProjectionRedacted === "" ? [] : newProjectionRedacted.split("\n");

	// Verify line count is preserved (should always be true with line-preserving redaction)
	if (oldRedactedLines.length !== oldProjectionLines.length) {
		throw new Error(
			`Line count mismatch in old projection: original ${oldProjectionLines.length}, redacted ${oldRedactedLines.length}`,
		);
	}
	if (newRedactedLines.length !== newProjectionLines.length) {
		throw new Error(
			`Line count mismatch in new projection: original ${newProjectionLines.length}, redacted ${newRedactedLines.length}`,
		);
	}

	// Determine which sides changed
	const oldSideChanged = oldProjectionOriginal !== oldProjectionRedacted;
	const newSideChanged = newProjectionOriginal !== newProjectionRedacted;

	// Map redactions back to individual diff lines by index
	const result: LineInfo[] = [];

	for (let i = 0; i < lineInfos.length; i += 1) {
		const info = lineInfos[i];
		const prefix = info.prefix;

		let redactedContent = info.content;

		if (prefix === " ") {
			// Context line: appears in both projections
			const oldIdx = oldProjectionIndices.indexOf(i);
			const newIdx = newProjectionIndices.indexOf(i);

			if (oldIdx >= 0 && newIdx >= 0) {
				if (!oldSideChanged && !newSideChanged) {
					// Neither side changed: use original
					redactedContent = info.content;
				} else {
					// Use old-side redacted content (should match new-side for context lines)
					redactedContent = oldRedactedLines[oldIdx];
				}
			}
		} else if (prefix === "-") {
			// Deleted line: appears in old projection only
			const oldIdx = oldProjectionIndices.indexOf(i);

			if (oldIdx >= 0) {
				if (oldSideChanged) {
					// Map by index - line count is guaranteed to match
					redactedContent = oldRedactedLines[oldIdx];
				}
			}
		} else if (prefix === "+") {
			// Added line: appears in new projection only
			const newIdx = newProjectionIndices.indexOf(i);

			if (newIdx >= 0) {
				if (newSideChanged) {
					// Map by index - line count is guaranteed to match
					redactedContent = newRedactedLines[newIdx];
				}
			}
		}

		result.push({ ...info, content: redactedContent });
	}

	// Update state based on bracket tracking and post-process redacted lines for incomplete containers
	// This persists credential container state across hunk boundaries within the same file.
	// Track brackets in the ORIGINAL projection content (before redaction) so we see
	// actual brackets, not placeholders. The goal is to know whether we're inside a
	// container at the end of this hunk, which determines redaction in the next hunk.
	// Since projections can be asymmetric (old side opens container, new side doesn't),
	// we track the old-side state which carries forward to the next hunk.
	const outputState: HunkState = { ...inputState };

	// Helper to update bracket stack based on a line of text, with quote-awareness.
	// Brackets inside quoted strings are not counted as container brackets.
	// Returns [newDepth, inStringAtEnd] to track multi-line strings.
	const processBracketsQuoteAware = (
		stack: string[],
		text: string,
		depth: number,
		inStringAtStart: boolean,
	): [number, boolean] => {
		let inString = inStringAtStart;
		let stringDelimiter = "";
		let localDepth = depth;

		for (let i = 0; i < text.length; i += 1) {
			const char = text[i];

			// Handle escape sequences in strings
			if (inString && char === "\\" && i + 1 < text.length) {
				i += 1; // Skip the escaped character
				continue;
			}

			// Handle string delimiters
			if (!inString && (char === '"' || char === "'")) {
				inString = true;
				stringDelimiter = char;
				continue;
			} else if (inString && char === stringDelimiter) {
				inString = false;
				stringDelimiter = "";
				continue;
			}

			// Only track brackets when not inside a string
			if (!inString) {
				if (char === "[" || char === "{") {
					stack.push(char);
					localDepth += 1;
				} else if (char === "]" && stack.length > 0 && stack[stack.length - 1] === "[") {
					stack.pop();
					localDepth = Math.max(0, localDepth - 1);
				} else if (char === "}" && stack.length > 0 && stack[stack.length - 1] === "{") {
					stack.pop();
					localDepth = Math.max(0, localDepth - 1);
				}
			}
		}

		return [localDepth, inString];
	};

	// Pre-calculate bracket depths for both projections independently
	// OLD PROJECTION: based on context + deleted lines only
	// NEW PROJECTION: based on context + added lines only
	// This ensures deleted lines don't contaminate new projection state calculations
	const depthAtStartOfLine: Array<{ oldDepth: number; newDepth: number }> = [];

	// Build state for OLD projection (context + deleted lines)
	const oldProjectionStateAtLine: number[] = [];
	let oldProjDepth = inputState.oldSideBracketDepth ?? inputState.bracketDepth;
	const oldProjStack: string[] = [...(inputState.oldSideBracketStack ?? inputState.bracketStack)];

	let oldInString = false; // Track if we're in a string at line end for multi-line string continuation

	for (let i = 0; i < lineInfos.length; i += 1) {
		const originalInfo = lineInfos[i];
		const prefix = originalInfo.prefix;

		oldProjectionStateAtLine.push(oldProjDepth);

		if (prefix === " " || prefix === "-") {
			const oldIdx = oldProjectionIndices.indexOf(i);
			if (oldIdx >= 0) {
				const originalContent = oldProjectionLines[oldIdx];
				[oldProjDepth, oldInString] = processBracketsQuoteAware(
					oldProjStack,
					originalContent,
					oldProjDepth,
					oldInString,
				);
			}
		}
	}

	// Build state for NEW projection (context + added lines)
	const newProjectionStateAtLine: number[] = [];
	let newProjDepth = inputState.newSideBracketDepth ?? inputState.bracketDepth;
	const newProjStack: string[] = [...(inputState.newSideBracketStack ?? inputState.bracketStack)];
	let newInString = false; // Track if we're in a string at line end for multi-line string continuation

	for (let i = 0; i < lineInfos.length; i += 1) {
		const originalInfo = lineInfos[i];
		const prefix = originalInfo.prefix;

		newProjectionStateAtLine.push(newProjDepth);

		if (prefix === " " || prefix === "+") {
			const newIdx = newProjectionIndices.indexOf(i);
			if (newIdx >= 0) {
				const originalContent = newProjectionLines[newIdx];
				[newProjDepth, newInString] = processBracketsQuoteAware(
					newProjStack,
					originalContent,
					newProjDepth,
					newInString,
				);
			}
		}
	}

	// Now create depthAtStartOfLine combining both projections
	for (let i = 0; i < lineInfos.length; i += 1) {
		depthAtStartOfLine.push({
			oldDepth: oldProjectionStateAtLine[i],
			newDepth: newProjectionStateAtLine[i],
		});
	}

	// Initialize with independent states if available, otherwise use the shared state
	let oldBracketDepth = inputState.oldSideBracketDepth ?? inputState.bracketDepth;
	const oldBracketStack: string[] = [...(inputState.oldSideBracketStack ?? inputState.bracketStack)];
	let newBracketDepth = inputState.newSideBracketDepth ?? inputState.bracketDepth;
	const newBracketStack: string[] = [...(inputState.newSideBracketStack ?? inputState.bracketStack)];

	// Helper to check if a line looks like it's part of a data structure (JSON/YAML key-value pairs)
	// vs. plain text comment or label. Lines with quotes or colons are likely structure data.
	const looksLikeStructureData = (content: string): boolean => {
		// Check if line starts with a quote (JSON string) or looks like a JSON key
		if (/^\s*["']/.test(content)) return true;
		// Check if line contains a colon followed by whitespace or bracket (YAML/JSON key-value)
		if (/:(?:\s|$|\{|\[)/.test(content)) return true;
		return false;
	};

	// Also redact lines that are inside incomplete containers
	// (containers opened in previous hunks or opened in this hunk but not closed)
	// We track bracket depth and stack separately for each projection since they can be asymmetric
	// Asymmetric containers: if old side is deeper, redact new side too for safety
	let oldInStringTrack = false; // Track string state across lines in final pass
	let newInStringTrack = false; // Track string state across lines in final pass

	for (let i = 0; i < lineInfos.length; i += 1) {
		const info = result[i]; // The corresponding redacted line info
		const originalInfo = lineInfos[i];
		const prefix = originalInfo.prefix;

		// Use the bracket depth at the START of this line (pre-calculated)
		const startDepths = depthAtStartOfLine[i] || { oldDepth: 0, newDepth: 0 };

		// Handle deleted lines only (old-side projection)
		// Context lines are shared and have already been processed by redactCrashSecretsPreservingLines.
		// Only deleted lines (which appear only on the old side) may need redaction
		// if the opening bracket was on a previous hunk's deleted line.
		if (prefix === "-") {
			const oldIdx = oldProjectionIndices.indexOf(i);
			if (oldIdx >= 0) {
				const originalContent = oldProjectionLines[oldIdx];

				// Check if this line is only structural (brackets, whitespace, etc.)
				// Don't redact purely structural lines - they're important for preserving format
				const isOnlyStructure = /^[\s[\]{}:,.]*$/.test(info.content);

				// If we're inside a container at the START of this line, redact it
				// But skip purely structural lines
				if (
					startDepths.oldDepth > 0 &&
					info.content !== "" &&
					!isOnlyStructure &&
					!info.content.includes("«redacted")
				) {
					info.content = "«redacted»";
				}

				// Update bracket depth and stack for next line, tracking old-side independently
				[oldBracketDepth, oldInStringTrack] = processBracketsQuoteAware(
					oldBracketStack,
					originalContent,
					oldBracketDepth,
					oldInStringTrack,
				);
			}
		}

		// Handle context lines (old-side projection) - track bracket depth and selectively redact
		// Redact lines that look like they're part of a data structure (JSON/YAML), but keep plain text
		if (prefix === " ") {
			const oldIdx = oldProjectionIndices.indexOf(i);
			const newIdx = newProjectionIndices.indexOf(i);
			if (oldIdx >= 0) {
				const originalContent = oldProjectionLines[oldIdx];
				const isOnlyStructure = /^[\s[\]{}:,.]*$/.test(info.content);
				const isStructureData = looksLikeStructureData(info.content);

				// Redact if:
				// 1. Inside container at START of line AND looks like structure data, OR
				// 2. Inside a multi-line string at START of line (oldInStringTrack=true)
				// Also skip purely structural lines and already-redacted content
				if (
					info.content !== "" &&
					!isOnlyStructure &&
					!info.content.includes("«redacted") &&
					((startDepths.oldDepth > 0 && isStructureData) || // Inside container + looks like structure
						oldInStringTrack) // Inside a multi-line string continuation
				) {
					info.content = "«redacted»";
				}

				// Update bracket depth and stack for old-side
				[oldBracketDepth, oldInStringTrack] = processBracketsQuoteAware(
					oldBracketStack,
					originalContent,
					oldBracketDepth,
					oldInStringTrack,
				);
			}
			if (newIdx >= 0) {
				const originalContent = newProjectionLines[newIdx];

				// Also update bracket depth for new-side projection (tracked separately, not carried forward)
				[newBracketDepth, newInStringTrack] = processBracketsQuoteAware(
					newBracketStack,
					originalContent,
					newBracketDepth,
					newInStringTrack,
				);
			}
		}

		// Handle added lines only (new-side projection)
		// Context lines are shared and have already been processed by redactCrashSecretsPreservingLines.
		// Only added lines (which appear only on the new side) may need redaction
		// if the opening bracket was on a previous hunk's added line.
		// Also redact if oldBracketDepth > newBracketDepth (asymmetric container).
		if (prefix === "+") {
			const newIdx = newProjectionIndices.indexOf(i);
			if (newIdx >= 0) {
				const originalContent = newProjectionLines[newIdx];

				// Check if this line is only structural (brackets, whitespace, etc.)
				// Don't redact purely structural lines - they're important for preserving format
				const isOnlyStructure = /^[\s[\]{}:,.]*$/.test(info.content);

				// Redact if:
				// 1. We're inside a container on the new side AT START OF LINE, OR
				// 2. We're in an asymmetric container (old side deeper than new side AT START OF LINE)
				// But skip purely structural lines
				if (
					(startDepths.newDepth > 0 || startDepths.oldDepth > startDepths.newDepth) &&
					info.content !== "" &&
					!isOnlyStructure &&
					!info.content.includes("«redacted")
				) {
					info.content = "«redacted»";
				}

				// Update bracket depth for next line (new side only, not carried forward)
				[newBracketDepth, newInStringTrack] = processBracketsQuoteAware(
					newBracketStack,
					originalContent,
					newBracketDepth,
					newInStringTrack,
				);
			}
		}
	}

	// Update output state with both old and new projection states carried forward
	// Old-side state (context + deleted) persists to detect asymmetric containers in next hunk
	// New-side state (context + added) is the final file state for redaction
	outputState.bracketStack = newBracketStack;
	outputState.bracketDepth = newBracketDepth;
	outputState.oldSideBracketStack = oldBracketStack;
	outputState.oldSideBracketDepth = oldProjDepth;
	outputState.newSideBracketStack = newBracketStack;
	outputState.newSideBracketDepth = newBracketDepth;
	if (newBracketDepth > 0) {
		outputState.inCredentialValue = true;
	} else {
		outputState.inCredentialValue = false;
	}

	return { redactedLines: result, state: outputState };
}
