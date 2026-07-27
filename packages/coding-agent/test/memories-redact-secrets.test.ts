import { describe, expect, it } from "bun:test";
import { redactMemorySecretsForTesting as redact } from "@gajae-code/coding-agent/memories";

/**
 * `docs/memory.md`: "All output is scanned for secrets before being written to
 * disk." Phase-2 consolidation writes `MEMORY.md` and `memory_summary.md`, and
 * the summary is injected into every later session — so anything that survives
 * this scrub is both persisted and re-fed to the model indefinitely.
 *
 * The scrubber covered AWS, JWTs and keyword-prefixed keys, but no GitHub token
 * shape: they carry none of the keywords the first pattern looks for. The
 * sibling scrubber in `session/contribution-prep.ts` already covers all three
 * GitHub prefixes, so this closes a gap the repo had already recognized
 * elsewhere.
 */

describe("memory consolidation secret redaction", () => {
	it("redacts GitHub token formats", () => {
		const cases = [
			"ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
			"gho_A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
			"ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
			"github_pat_11ABCDEFG0hijklmnopq_RSTUVWXYZ0123456789",
		];
		for (const token of cases) {
			const out = redact(`the deploy step used ${token} for auth`);
			expect(out).not.toContain(token);
			expect(out).toContain("[REDACTED]");
			// Surrounding context survives so the memory stays useful.
			expect(out).toContain("the deploy step used");
		}
	});

	it("keeps redacting the shapes it already covered", () => {
		const preserved = {
			aws: "AKIA1234567890ABCDEF",
			awsTemporary: "ASIA1234567890ABCDEF",
			openai: "sk-A1b2C3d4E5f6G7h8I9j0",
			jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9Pl",
		};
		for (const value of Object.values(preserved)) {
			expect(redact(`value ${value}`)).not.toContain(value);
		}
	});

	it("leaves ordinary prose alone", () => {
		const prose = "Ran the github workflow twice; the second attempt passed.";
		expect(redact(prose)).toBe(prose);
	});
});
