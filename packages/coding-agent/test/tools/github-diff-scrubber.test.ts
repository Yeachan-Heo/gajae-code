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

		it("[P2] redacts multi-line PEM blocks in diff format", () => {
			// A PEM block that spans multiple lines should be fully redacted
			const diff = [
				...HEADER,
				"@@ -0,0 +1,3 @@",
				"+-----BEGIN PRIVATE KEY-----",
				"+MIIEvQIBADANBgkqhkiG9w0BAQE",
				"+-----END PRIVATE KEY-----",
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// PEM content should be redacted
			expect(scrubbed).not.toContain("BEGIN PRIVATE KEY");
			expect(scrubbed).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQE");
			expect(scrubbed).not.toContain("END PRIVATE KEY");

			// Line count should be preserved
			expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);

			// Hunk header should be preserved
			expect(scrubbed).toContain("@@ -0,0 +1,3 @@");
		});

		describe("probepark findings - false positive prevention", () => {
			it("does not redact legitimate files like passport.js", () => {
				const diff = [
					"diff --git a/src/passport.js b/src/passport.js",
					"index 1111111..2222222 100644",
					"--- a/src/passport.js",
					"+++ b/src/passport.js",
					"@@ -1,2 +1,2 @@",
					" const strategy = new LocalStrategy();",
					" module.exports = strategy;",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// passport.js should NOT be redacted (it's a legitimate library)
				expect(scrubbed).toContain("passport.js");
				expect(scrubbed).not.toContain("file-redacted");
			});

			it("does not redact legitimate files like keyboard.ts", () => {
				const diff = [
					"diff --git a/src/keyboard.ts b/src/keyboard.ts",
					"index 1111111..2222222 100644",
					"--- a/src/keyboard.ts",
					"+++ b/src/keyboard.ts",
					"@@ -1,2 +1,2 @@",
					" interface KeyboardEvent {}",
					" export default KeyboardEvent;",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// keyboard.ts should NOT be redacted
				expect(scrubbed).toContain("keyboard.ts");
				expect(scrubbed).not.toContain("file-redacted");
			});

			it("does not redact legitimate files like author.md", () => {
				const diff = [
					"diff --git a/docs/author.md b/docs/author.md",
					"index 1111111..2222222 100644",
					"--- a/docs/author.md",
					"+++ b/docs/author.md",
					"@@ -1,2 +1,2 @@",
					" # Author",
					" Some author information",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// author.md should NOT be redacted
				expect(scrubbed).toContain("author.md");
				expect(scrubbed).not.toContain("file-redacted");
			});

			it("does not redact legitimate files like authorization-service.ts", () => {
				const diff = [
					"diff --git a/src/authorization-service.ts b/src/authorization-service.ts",
					"index 1111111..2222222 100644",
					"--- a/src/authorization-service.ts",
					"+++ b/src/authorization-service.ts",
					"@@ -1,2 +1,2 @@",
					" export class AuthorizationService {}",
					" export default AuthorizationService;",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// authorization-service.ts should NOT be redacted (it's a business logic service)
				expect(scrubbed).toContain("authorization-service.ts");
				expect(scrubbed).not.toContain("file-redacted");
			});

			it("DOES redact actual credential files like secret-api-key.json", () => {
				const diff = [
					"diff --git a/config/secret-api-key.json b/config/secret-api-key.json",
					"index 1111111..2222222 100644",
					"--- a/config/secret-api-key.json",
					"+++ b/config/secret-api-key.json",
					"@@ -1,1 +1,1 @@",
					' {"api": "sensitive"}',
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// secret-api-key.json SHOULD be redacted
				expect(scrubbed).toContain("file-redacted");
				expect(scrubbed).not.toContain("secret-api-key");
			});

			it("DOES redact actual credential files like .env.local with password", () => {
				const diff = [
					"diff --git a/config/.env.password b/config/.env.password",
					"index 1111111..2222222 100644",
					"--- a/config/.env.password",
					"+++ b/config/.env.password",
					"@@ -1,1 +1,1 @@",
					" DB_PASSWORD=secret123",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// .env.password SHOULD be redacted
				expect(scrubbed).toContain("file-redacted");
				expect(scrubbed).not.toContain(".env.password");
			});

			it("[P2] scrubs C-quoted paths containing credentials", () => {
				// C-quoted paths: Git uses these for paths with special characters
				const diff = [
					'diff --git "a/config/secret-token.env" "b/config/secret-token.env"',
					"index 1111111..2222222 100644",
					'--- "a/config/secret-token.env"',
					'+++ "b/config/secret-token.env"',
					"@@ -1,1 +1,1 @@",
					" token=abc123",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Credential path should be redacted
				expect(scrubbed).not.toContain("secret-token");
			});

			it("[P2] scrubs rename headers with credential-shaped paths", () => {
				// Rename operations preserve old path in header
				const diff = [
					"diff --git a/src/api-secret-key.ts b/src/config.ts",
					"similarity index 100%",
					"rename from src/api-secret-key.ts",
					"rename to src/config.ts",
					"index 1111111..2222222 100644",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Credential-shaped path in rename headers should be redacted
				expect(scrubbed).not.toContain("api-secret-key");
			});

			it("[P2] scrubs copy headers with credential-shaped paths", () => {
				// Copy operations preserve source path in header
				const diff = [
					"diff --git a/src/api-password.ts b/src/api-password-backup.ts",
					"similarity index 100%",
					"copy from src/api-password.ts",
					"copy to src/api-password-backup.ts",
					"index 1111111..2222222 100644",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Credential-shaped paths in copy headers should be redacted
				expect(scrubbed).not.toContain("api-password");
			});

			it("[P2] handles mixed-content PEM blocks with surrounding context", () => {
				// PEM blocks can appear with surrounding content in the same hunk
				const diff = [
					...HEADER,
					"@@ -0,0 +1,6 @@",
					"+// Key setup",
					"+-----BEGIN PRIVATE KEY-----",
					"+MIIEvQIBADANBgkqhkiG9w0BAQE",
					"+-----END PRIVATE KEY-----",
					"+// Key initialized",
					"+console.log('ready');",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// PEM content should be redacted
				expect(scrubbed).not.toContain("BEGIN PRIVATE KEY");
				expect(scrubbed).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQE");

				// But surrounding context should be preserved
				expect(scrubbed).toContain("// Key setup");
				expect(scrubbed).toContain("// Key initialized");
				expect(scrubbed).toContain("console.log");

				// Line count should be preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});
		});

		describe("snowykr P2 findings - independent projections", () => {
			it("[P2] keeps old and new diff projections independent", () => {
				// Issue: A deleted line closes a bracket that was opened in an added line.
				// The state must not leak between projections.
				const diff = [
					...HEADER,
					"@@ -1,3 +1,3 @@ ",
					' {"token": [',
					'-  "old-side-secret"],',
					'+  "new-side-secret"],',
					'  "keep": 1}',
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Both projections should have credentials redacted independently
				expect(scrubbed).not.toContain("old-side-secret");
				expect(scrubbed).not.toContain("new-side-secret");

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);

				// Hunk header still parseable
				expect(scrubbed).toContain("@@ -1,3 +1,3 @@ ");
			});

			it("[P2] projects partial redactor matches back onto mixed hunks", () => {
				// Issue: A split key/colon JSON credential loses context
				const diff = [
					...HEADER,
					"@@ -0,0 +1,5 @@ ",
					'+  "token": [',
					'+    "split-secret-token"',
					"+  ],",
					'+  "other": "value"',
					"+}",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Split credential should be redacted
				expect(scrubbed).not.toContain("split-secret-token");

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("[P2] scrubs parsed paths in all textual diff headers", () => {
				// C-quoted path with credential-shaped filename
				const diff = [
					'diff --git "a/config/ghp_secret123.env" "b/config/ghp_secret123.env"',
					"index 1111111..2222222 100644",
					'--- "a/config/ghp_secret123.env"',
					'+++ "b/config/ghp_secret123.env"',
					"@@ -1,1 +1,1 @@ ",
					" TOKEN=abc123",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Credential-shaped path should be redacted
				expect(scrubbed).not.toContain("ghp_secret123");
				expect(scrubbed).toContain("file-redacted");
			});

			it("[P3] redacts paths repeated in binary-diff summaries", () => {
				// Binary files line with credential-shaped paths
				const diff = [
					"diff --git a/secret.bin b/secret.bin",
					"Binary files a/secret.bin and b/secret.bin differ",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Paths in binary files line should be redacted
				expect(scrubbed).not.toContain("secret.bin");
				expect(scrubbed).toContain("file-redacted");
			});
		});
	});
});
