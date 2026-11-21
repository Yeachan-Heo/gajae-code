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

			it("[P2] redacts paths with space-separated credential keywords", () => {
				// Issue: Metadata scrubber must match diff-header rules, including space boundaries
				// Paths like 'src/api secret token.js' have space-separated keywords
				const diff = [
					"diff --git a/src/api\\ secret\\ token.js b/src/api\\ secret\\ token.js",
					"index 1111111..2222222 100644",
					"--- a/src/api\\ secret\\ token.js",
					"+++ b/src/api\\ secret\\ token.js",
					"@@ -1,1 +1,1 @@ ",
					" // token value",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Space-separated credential keywords should be redacted
				expect(scrubbed).not.toContain("api secret token");
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

			it("[P2] redacts YAML block scalars with multiline indented values", () => {
				// YAML block scalar with pipe operator and indented values
				// This tests that accumulated context is used instead of per-line redaction
				const diff = [
					...HEADER,
					"@@ -1,5 +1,5 @@",
					" config:",
					" api_token: |",
					"   yaml-block-canary-value",
					"   more-secret-canary",
					" database:",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// All canaries should be redacted despite being in block scalar context
				expect(scrubbed).not.toContain("yaml-block-canary-value");
				expect(scrubbed).not.toContain("more-secret-canary");

				// YAML structure should be preserved
				expect(scrubbed).toContain("api_token: |");

				// Line count preserved
				const lines = scrubbed.split("\n");
				const originalLines = diff.split("\n");
				expect(lines).toHaveLength(originalLines.length);
			});

			it("[BLOCKING] redacts multi-line credentials on independent old/new projections", () => {
				// BLOCKING: This test validates that the independent projection fix actually works.
				// A replacement hunk where:
				// - deleted lines contain a PEM block (which is redacted as a whole)
				// - added lines contain a JSON structure with a credential
				// - both should be redacted independently; the old PEM block closure
				//   should NOT affect whether the new side recognizes its credential
				const diffReplacementWithMultiline = [
					...HEADER,
					"@@ -1,6 +1,6 @@",
					" context",
					"------BEGIN RSA PRIVATE KEY-----",
					'+  "token": [',
					"-pem-body-canary-line",
					'+    "json-token-canary-secret"',
					"------END RSA PRIVATE KEY-----",
					"+  ]",
					" more context",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diffReplacementWithMultiline);

				// CRITICAL: No canary from either side should survive
				// These canaries test that independent projections are actually applied
				expect(scrubbed).not.toContain("pem-body-canary-line");
				expect(scrubbed).not.toContain("json-token-canary-secret");
				expect(scrubbed).not.toContain("BEGIN RSA PRIVATE KEY");
				expect(scrubbed).not.toContain("END RSA PRIVATE KEY");

				// Line count must be preserved exactly
				const originalLines = diffReplacementWithMultiline.split("\n");
				const scrubbedLines = scrubbed.split("\n");
				expect(scrubbedLines).toHaveLength(originalLines.length);

				// Context lines must be preserved
				expect(scrubbed).toContain(" context");
				expect(scrubbed).toContain(" more context");

				// Hunk header must be unchanged
				expect(scrubbed).toContain("@@ -1,6 +1,6 @@");

				// Deleted and added lines should have bracket structure preserved at appropriate lines
				// The "+  ]" line should still be there (closing the JSON array)
				expect(scrubbed).toContain("+  ]");
			});

			it("[P2] applies independent projections for replacement hunks", () => {
				// Test: old and new sides with different structures
				// Both sides have multi-line credentials that should be redacted independently
				const diffIndependentStates = [
					...HEADER,
					"@@ -1,3 +1,3 @@",
					"-auth: [",
					"+auth: {",
					'-  "old-secret-canary"',
					'+  "new-secret-canary"',
					"-]",
					"+}",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diffIndependentStates);

				// Both secrets should be redacted
				expect(scrubbed).not.toContain("old-secret-canary");
				expect(scrubbed).not.toContain("new-secret-canary");

				// Verify the structure shows the redaction occurred (prefix + redaction marker)
				// All lines with credentials should show redaction
				expect(scrubbed).toContain("-auth: «redacted»");
				expect(scrubbed).toContain("+auth: «redacted»");

				// Line count preserved (3 old lines + 3 new lines = 6 content lines)
				const lines = scrubbed.split("\n");
				const originalLines = diffIndependentStates.split("\n");
				expect(lines).toHaveLength(originalLines.length);

				// Test: multi-line credential condensing
				// The old side has a multi-line structure that should be fully redacted
				const diffMultilineRedaction = [
					...HEADER,
					"@@ -1,4 +1,2 @@",
					"-Authorization: [",
					"+Authorization: simple-value",
					'-  "old-jwt-secret-canary"',
					"-]",
					" context",
					"",
				].join("\n");

				const scrubbed2 = scrubUnifiedDiff(diffMultilineRedaction);

				// All canaries should be redacted
				expect(scrubbed2).not.toContain("old-jwt-secret-canary");

				// Both old and new Authorization lines should be redacted
				expect(scrubbed2).not.toContain("-Authorization: [");
				expect(scrubbed2).not.toContain("+Authorization: simple-value");

				// Line count preserved
				expect(scrubbed2.split("\n")).toHaveLength(diffMultilineRedaction.split("\n").length);
			});
		});

		describe("snowykr P2 findings - detailed regression tests", () => {
			it("[P2] finding #2: header-only credential maintains state across continuation", () => {
				// Issue: +Cookie: then + sid=canary loses state before redacting the scalar continuation
				// A Cookie header split across multiple lines should maintain credential state
				const diff = [...HEADER, "@@ -0,0 +1,3 @@ ", "+Cookie:", "+  sid=header-only-canary", "+  path=/", ""].join(
					"\n",
				);

				const scrubbed = scrubUnifiedDiff(diff);

				// The canary value must be redacted despite being on a continuation line
				expect(scrubbed).not.toContain("header-only-canary");

				// Cookie: header structure should be preserved
				expect(scrubbed).toContain("+Cookie:");

				// Line count must be preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("[P2] finding #3: multiline openers include refresh_token and private_key patterns", () => {
				// Issue: multiline opener list omits shared redactor keys like refresh_token/private_key
				// These should be detected using the same patterns as redactCrashSecrets
				const diffWithRefreshToken = [
					...HEADER,
					"@@ -0,0 +1,4 @@ ",
					'+  "refresh_token": [',
					'+    "refresh-token-canary-value"',
					"+  ]",
					"",
				].join("\n");

				const scrubbed1 = scrubUnifiedDiff(diffWithRefreshToken);
				expect(scrubbed1).not.toContain("refresh-token-canary-value");

				const diffWithPrivateKey = [
					...HEADER,
					"@@ -0,0 +1,4 @@ ",
					'+  "private_key": [',
					'+    "private-key-canary-data"',
					"+  ]",
					"",
				].join("\n");

				const scrubbed2 = scrubUnifiedDiff(diffWithPrivateKey);
				expect(scrubbed2).not.toContain("private-key-canary-data");

				// Line counts preserved
				expect(scrubbed1.split("\n")).toHaveLength(diffWithRefreshToken.split("\n").length);
				expect(scrubbed2.split("\n")).toHaveLength(diffWithPrivateKey.split("\n").length);
			});

			it("[P2] finding #4: asymmetric projection state preserved at context lines", () => {
				// Issue: asymmetric old/new projection state is dropped at context lines/hunk transitions
				// When a context line appears, both old and new state should be synchronized properly
				const diff = [
					...HEADER,
					"@@ -1,5 +1,5 @@ ",
					' {"secret": [',
					'-  "old-side-canary"',
					'+  "new-side-canary"',
					" ]}",
					" context line",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Both side canaries must be redacted
				expect(scrubbed).not.toContain("old-side-canary");
				expect(scrubbed).not.toContain("new-side-canary");

				// Context line must be preserved
				expect(scrubbed).toContain(" context line");

				// Line count must be preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("[P2] finding #5: quoted diff --git paths with spaces are parsed correctly", () => {
				// Issue: quoted diff --git paths with spaces split wrongly
				// C-quoted paths like \"a/file with spaces.js\" should be handled correctly
				const diff = [
					'diff --git "a/api secret token.js" "b/api secret token.js"',
					"index 1111111..2222222 100644",
					'--- "a/api secret token.js"',
					'+++ "b/api secret token.js"',
					"@@ -1,2 +1,2 @@ ",
					" const x = 'value';",
					" module.exports = x;",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Credential-shaped path should be redacted
				expect(scrubbed).toContain("file-redacted");
				expect(scrubbed).not.toContain("api secret token");

				// File structure should be preserved (quotes intact)
				expect(scrubbed).toMatch(/".*file-redacted.*"/);

				// Content lines in hunk should be preserved
				expect(scrubbed).toContain("const x = 'value';");

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("[P2] finding #6: bracket stack handling does not degrade with long diffs", () => {
				// Issue: per-line nesting-stack clone is quadratic
				// We test that a large diff with many bracket operations completes efficiently
				// and doesn't have exponential behavior
				const lines = [HEADER[0], ...HEADER.slice(1)];
				lines.push("@@ -1,100 +1,100 @@ ");

				// Add 100 lines with bracket operations
				for (let i = 0; i < 100; i += 1) {
					if (i === 0) {
						lines.push(' {"token": [');
					} else if (i === 99) {
						lines.push(" ]");
						lines.push(" }");
					} else {
						lines.push(` "line-${i}-canary-data",`);
					}
				}
				lines.push("");

				const diff = lines.join("\n");
				const startTime = Date.now();
				const scrubbed = scrubUnifiedDiff(diff);
				const elapsed = Date.now() - startTime;

				// All canaries should be redacted
				for (let i = 1; i < 99; i += 1) {
					expect(scrubbed).not.toContain(`line-${i}-canary-data`);
				}

				// Should complete in reasonable time (< 500ms for 100 lines)
				// This catches quadratic behavior
				expect(elapsed).toBeLessThan(500);

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});
		});

		describe("required failing tests for redesign", () => {
			it("replacement hunk with different multi-line container secrets on each side", () => {
				// A replacement hunk where old side has multi-line credential with different secret than new side
				// Both should be redacted independently - no cross-side contamination
				const diff = [
					...HEADER,
					"@@ -1,5 +1,5 @@ ",
					' {"secret": [',
					'-  "old-side-secret-canary-123"',
					'+  "new-side-secret-canary-456"',
					" ]",
					" }",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Both old and new canaries should be redacted
				expect(scrubbed).not.toContain("old-side-secret-canary-123");
				expect(scrubbed).not.toContain("new-side-secret-canary-456");

				// Context lines should be preserved
				expect(scrubbed).toContain(' {"secret": [');
				expect(scrubbed).toContain(" ]");
				expect(scrubbed).toContain(" }");

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("folded Authorization header followed by space-indented value continuation", () => {
				// Authorization header followed by indented continuation on next line with space-prefix
				// The continuation should be redacted as part of the header value
				const diff = [
					...HEADER,
					"@@ -0,0 +1,3 @@ ",
					"+Authorization: Bearer",
					"+  folded-token-canary-xyz",
					"+next-line",
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// The folded continuation token should be redacted
				expect(scrubbed).not.toContain("folded-token-canary-xyz");

				// Authorization header structure should be preserved
				expect(scrubbed).toContain("+Authorization:");

				// Next-line should be preserved (credential state ended)
				expect(scrubbed).toContain("+next-line");

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("asymmetric open container with secrets spanning multiple hunks", () => {
				// A container opened on old side in hunk 1 with a secret inside
				// Should persist as "open" state across hunk boundary
				// Second hunk should maintain credential redaction on that side
				const diff = [
					...HEADER,
					"@@ -1,2 +1,2 @@ ",
					"-secret_key: [",
					"+secret_key: simple",
					" context",
					"@@ -40,2 +40,2 @@ ",
					'-  "hunk-two-old-canary"',
					'+  "hunk-two-new-canary"',
					"",
				].join("\n");

				const scrubbed = scrubUnifiedDiff(diff);

				// Both canaries should be redacted
				expect(scrubbed).not.toContain("hunk-two-old-canary");
				expect(scrubbed).not.toContain("hunk-two-new-canary");

				// Context line should be preserved
				expect(scrubbed).toContain(" context");

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});

			it("deep nesting perf test: 10k-deep structure under 200ms", () => {
				// Test that bracket tracking is O(n) and not O(n²) with deep nesting
				// Build a diff with 10k nested brackets
				const lines = [HEADER[0], ...HEADER.slice(1)];
				lines.push("@@ -1,10002 +1,10002 @@ ");

				lines.push(' {"secret": {');
				// Add 5000 nested levels
				for (let i = 0; i < 5000; i += 1) {
					lines.push(` "level_${i}": {`);
				}
				lines.push(' "deep": "deep-nesting-canary-9999"');
				// Close all levels
				for (let i = 0; i < 5000; i += 1) {
					lines.push(" }");
				}
				lines.push(" }");
				lines.push("");

				const diff = lines.join("\n");
				const startTime = Date.now();
				const scrubbed = scrubUnifiedDiff(diff);
				const elapsed = Date.now() - startTime;

				// Canary should be redacted
				expect(scrubbed).not.toContain("deep-nesting-canary-9999");

				// Should complete in reasonable time (< 200ms for 10k deep nesting)
				// This catches quadratic behavior and stack cloning issues
				expect(elapsed).toBeLessThan(200);

				// Line count preserved
				expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);
			});
		});

		it("redacts asymmetric closures: context opens, deleted closes, added has opaque value", () => {
			// P2-1 regression: When a context line opens a credential container,
			// a deleted-side closing bracket can clear state if old/new aren't tracked independently.
			// The added-side opaque scalar must still be redacted.
			const diff = [
				...HEADER,
				"@@ -1,4 +1,4 @@",
				' {"secrets": [', // context opens bracket on old side
				"-  ],", // deleted closes bracket (old-side bracket depth becomes 0)
				'+  "asymmetry-canary-secret"],', // added has opaque value inside container (new-side bracket depth > old)
				" }",
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// Canary must be redacted even though old-side bracket depth would be 0 at this point
			expect(scrubbed).not.toContain("asymmetry-canary-secret");

			// Line count must be preserved
			expect(scrubbed.split("\n")).toHaveLength(diff.split("\n").length);

			// Context lines and structure should be intact
			expect(scrubbed).toContain('{"secrets": [');
			expect(scrubbed).toContain(" }");
		});

		it("[P2] merges redaction conservatively - masks on either side win", () => {
			// Issue: When only the new projection masks a line, the old projection's
			// unredacted content was being used for context lines.
			// Solution: Conservative merge - if either side masks, use the masked version.
			// Test case: Authorization header appears only on new side of a context line
			const diff = [
				...HEADER,
				"@@ -1,3 +1,3 @@",
				" Authorization: Bearer old-token-keep",
				" shared-data",
				" final-line",
				"",
			].join("\n");

			const scrubbed = scrubUnifiedDiff(diff);

			// Context line must be redacted (old side has unmasked, new side is masked)
			// Conservative merge means: mask on either side wins
			expect(scrubbed).not.toContain("old-token-keep");
			// Other content preserved
			expect(scrubbed).toContain("shared-data");
			expect(scrubbed).toContain("final-line");
		});
	});
});
