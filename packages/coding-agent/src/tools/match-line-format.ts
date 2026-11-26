import { computeLineHash } from "../edit/line-hash";

/**
 * Format a single line of match output for grep/ast-grep style results.
 *
 * The anchor/content separator is always `|`. Matched lines are prefixed
 * with `*`; context lines are prefixed with a single space so anchors
 * align in column. In hashline mode the anchor is `LINE+ID` (no `#`); in
 * plain mode it is just the line number. Line numbers are never padded.
 */
export function formatMatchLine(
	lineNumber: number,
	line: string,
	isMatch: boolean,
	options: { useHashLines: boolean },
): string {
	const marker = isMatch ? "*" : " ";
	if (options.useHashLines) {
		return `${marker}${lineNumber}${computeLineHash(lineNumber, line)}|${line}`;
	}
	return `${marker}${lineNumber}|${line}`;
}
