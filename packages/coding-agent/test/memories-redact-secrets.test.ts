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

	it("redacts the remaining shapes its sibling scrubbers already list", () => {
		// All synthetic. Each of these is catalogued by
		// `session-import/redact.ts` and `utils/crash-redaction.ts`, both of which
		// persist less than this scrubber does: memory output is written to disk
		// and the summary is replayed into every later session.
		const cases = {
			// ABIA (bearer) and ACCA (context) sit beside AKIA/ASIA in AWS's own
			// identifier prefix table.
			awsBearer: "ABIAIOSFODNN7EXAMPLE",
			awsContext: "ACCAIOSFODNN7EXAMPLE",
			googleApiKey: `AIza${"S".repeat(35)}`,
			// Assembled at runtime: a literal of this shape trips GitHub push
			// protection even though the value is synthetic.
			slack: ["xoxb", "0".repeat(11), "0".repeat(11), "abcdefghijklmnop"].join("-"),
		};
		for (const value of Object.values(cases)) {
			const out = redact(`observed ${value} in the log`);
			expect(out).not.toContain(value);
			expect(out).toContain("observed");
		}

		const pemBody = "MIIEowIBAAKCAQEAxGZ0000abcdefgHIJKLmnop";
		const pem = redact(`key was -----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY----- done`);
		expect(pem).not.toContain(pemBody);
		expect(pem).toContain("key was");

		const url = redact("cloned https://deploy:s3cr3tvalue@git.example.com/x.git ok");
		expect(url).not.toContain("s3cr3tvalue");
		expect(url).toContain("cloned");
	});

	it("scans a large credential-free consolidation output in linear time", () => {
		// The JWT-shaped rule's first segment used to start at every offset of a
		// long token-character run and backtrack through each length before
		// failing to find `.`, which is quadratic: 25k/50k/100k/200k characters
		// cost 165ms/661ms/2.6s/10.6s on text holding no secret at all. Phase-2
		// consolidation output is model-generated and routinely long.
		const body = "x".repeat(200_000);
		const startedAt = performance.now();
		const out = redact(body);
		const elapsedMs = performance.now() - startedAt;

		expect(out).toBe(body);
		// Linear scanning lands near 2ms; the budget is loose so it fails only on
		// quadratic scanning.
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("leaves ordinary prose alone", () => {
		const prose = "Ran the github workflow twice; the second attempt passed.";
		expect(redact(prose)).toBe(prose);
	});
	it("redacts the vendor tokens the egress guard classifies as credential-like", () => {
		// `crash/upstream/envelope.ts` refuses to transmit these four shapes.
		// Assembled at runtime so no literal of this shape is committed.
		const cases = {
			npm: ["npm", "a".repeat(36)].join("_"),
			gitlab: ["glpat", "b".repeat(24)].join("-"),
			stripe: ["sk", "live", "c".repeat(24)].join("_"),
			huggingface: ["hf", "d".repeat(34)].join("_"),
		};
		for (const value of Object.values(cases)) {
			const out = redact(`observed ${value} in the log`);
			expect(out).not.toContain(value);
			expect(out).toContain("observed");
		}
	});

	it("keeps vendor prefix lookalikes that are too short to be tokens", () => {
		for (const benign of ["npm install express", "the hf_ prefix", "glpat-short"]) {
			expect(redact(benign)).toContain(benign.split(" ")[0]);
		}
	});
});
