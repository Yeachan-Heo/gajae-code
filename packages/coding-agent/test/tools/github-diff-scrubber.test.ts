/**
 * Behavioral acceptance tests for unified diff scrubbing.
 *
 * These tests verify that the structural diff scrubber redacts credentials
 * while preserving exactly:
 * - Line counts
 * - Per-line projection prefixes (space, +, -, \)
 * - Hunk header format and line counts
 * - Multi-line content including blank lines
 *
 * No canary value present in input may appear in persisted payload or cache.
 */
import { describe, expect, it } from "bun:test";
import { scrubUnifiedDiff } from "@gajae-code/coding-agent/tools/github-diff-parser";

const HEADER = ["diff --git a/a b/a", "index 1111111..2222222 100644", "--- a/a", "+++ b/a"];

describe("unified diff scrubber", () => {
	it("redacts a plain Cookie header", () => {
		const body = "Cookie: sid=plain-cookie-secret; theme=dark";
		const scrubbed = scrubUnifiedDiff(body);
		expect(scrubbed).not.toContain("plain-cookie-secret");
	});

	it("preserves line structure when redacting", () => {
		const diff = [...HEADER, "@@ -1,2 +1,2 @@", " line1", " line2"].join("\n");
		const scrubbed = scrubUnifiedDiff(diff);
		expect(scrubbed.split("\n").length).toBe(diff.split("\n").length);
	});

	describe("canary failures that must pass", () => {
		it("redacts JSON credential value inside mixed-side diff text", () => {
			// GAP 1: A JSON credential value inside raw mixed-side diff text
			// The hunk loses a row in the old line-regex approach.
			// Our structural parser must redact the canary and preserve line count.
			const diff = [
				...HEADER,
				"@@ -1,3 +1,3 @@",
				' {"token": [',
				'-  "old"],',
				'+  "mixed-json-canary"],',
				'  "keep": 1}',
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// No canary in output.
			expect(scrubbed).not.toContain("mixed-json-canary");

			// Line count preserved.
			expect(scrubbed.split("\n").length).toBe(diff.split("\n").length);

			// Hunk header still parseable.
			expect(scrubbed).toContain("@@ -1,3 +1,3 @@");
		});

		it("redacts header whose value starts on a later line", () => {
			// GAP 2: A header whose value starts on a later line
			// The header framing must be preserved.
			const diff = [...HEADER, "@@ -0,0 +1,4 @@", "+Cookie:", "+ [", '+  "header-fold-canary"', "+]", ""].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// No canary in output.
			expect(scrubbed).not.toContain("header-fold-canary");

			// Line count preserved.
			expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);

			// Hunk header preserved.
			expect(scrubbed).toContain("@@ -0,0 +1,4 @@");

			// Bracket structure preserved on its own line.
			expect(scrubbed).toContain("+ [");
		});

		it("redacts containers spanning hunk boundaries", () => {
			// GAP 3: A container opened in one hunk persists into the next
			// Our file-context tracking must handle this.
			const diff = [
				...HEADER,
				"@@ -1,1 +1,1 @@",
				"-Auth: [",
				"+Auth: [",
				"@@ -40,1 +40,1 @@",
				'-  "hunk-one-canary"',
				'+  "hunk-two-canary"',
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// No canaries in output.
			expect(scrubbed).not.toContain("hunk-one-canary");
			expect(scrubbed).not.toContain("hunk-two-canary");

			// Line count preserved (at hunk level).
			const originalLines = diff.split("\n").length;
			const scrubbedLines = scrubbed.split("\n").length;
			expect(scrubbedLines).toBe(originalLines);
		});
	});

	describe("positive controls", () => {
		it("round-trips a legitimate escaped JSON array byte for byte", () => {
			const body = 'payload: {\\"name\\": [\\"a]b\\"], \\"keep\\": 1}';
			expect(scrubUnifiedDiff(body)).toBe(body);
		});

		it("round-trips a legitimate diff with plain brackets", () => {
			const diff = [...HEADER, "@@ -1,2 +1,2 @@", " [1, 2, 3]", " keep]", "+ add]", ""].join("\n");
			expect(scrubUnifiedDiff(diff)).toBe(diff);
		});

		it("preserves line-count header format exactly", () => {
			const diff = [...HEADER, "@@ -10,5 +20,7 @@", " a", " b", " c", " d", " e", "+ f", "+ g", ""].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);
			expect(scrubbed).toContain("@@ -10,5 +20,7 @@");
		});
	});

	describe("snowykr findings", () => {
		it("[P2] preserves quote-aware redaction inside multiline containers", () => {
			// A multiline credential array containing a quoted bracket should not early-exit credential state
			const diff = [
				...HEADER,
				"@@ -0,0 +1,5 @@",
				"+Authorization: [",
				'+  "quoted-bracket-secret: ]"',
				'+  "another-secret"',
				"+]",
				"+keep this line",
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// Both secrets should be redacted
			expect(scrubbed).not.toContain("quoted-bracket-secret");
			expect(scrubbed).not.toContain("another-secret");

			// Keep line should NOT be redacted (credential state should exit after closing bracket)
			expect(scrubbed).toContain("keep this line");
		});

		it("[P2] scrubs source-derived hunk context", () => {
			// Hunk header may have optional context with credentials
			const diff = [
				...HEADER,
				'@@ -1,1 +1,1 @@ function getAuth(secret="auth-token-in-context") {',
				" content line",
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// Credential in hunk context should be redacted
			expect(scrubbed).not.toContain("auth-token-in-context");

			// Hunk header structure preserved
			expect(scrubbed).toMatch(/@@ -1,1 \+1,1 @@/);

			// Content line preserved
			expect(scrubbed).toContain(" content line");
		});

		it("[P2] preserves no-newline marker order", () => {
			// No-newline markers should come after the line they're attached to, not separately
			const diff = [...HEADER, "@@ -1,2 +1,1 @@", " line1", "-line2", "\\ No newline at end of file", ""].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// Extract the lines after the hunk header
			const lines = scrubbed.split("\n");
			const hunkIndex = lines.findIndex(l => l.startsWith("@@ "));
			const contentLines = lines.slice(hunkIndex + 1);

			// No-newline marker should be one of the last lines
			const markerIndex = contentLines.indexOf("\\ No newline at end of file");
			expect(markerIndex).toBeGreaterThanOrEqual(0);

			// Marker should come after content lines (not at the beginning)
			expect(markerIndex).toBeGreaterThan(0);
		});

		it("[P4] preserves terminal newline framing", () => {
			// Input ending with newline should output ending with newline
			const diff = `${[...HEADER, "@@ -1,2 +1,2 @@", " line1", " line2"].join("\n")}\n`;

			const scrubbed = scrubUnifiedDiff(diff);

			// Terminal newline should be preserved
			expect(scrubbed.endsWith("\n")).toBe(true);

			// Input without trailing newline should not get one
			const diffNoTrailing = [...HEADER, "@@ -1,2 +1,2 @@", " line1", " line2"].join("\n");
			const scrubbedNoTrailing = scrubUnifiedDiff(diffNoTrailing);
			expect(scrubbedNoTrailing.endsWith("\n")).toBe(false);
		});
	});
});
