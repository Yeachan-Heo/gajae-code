/**
 * Format a single line of match output for grep/ast-grep style results.
 *
 * The anchor/content separator is always `|`. Matched lines are prefixed
 * with `*`; context lines are prefixed with a single space so anchors
 * align in column. The anchor is the line number. Line numbers are never padded.
 */
export function formatMatchLine(lineNumber: number, line: string, isMatch: boolean): string {
	const marker = isMatch ? "*" : " ";
	return `${marker}${lineNumber}|${line}`;
}
