import { describe, expect, it } from "bun:test";

import { redactSecrets, SECRET_PATTERN_IDS, scanSecretContent, scanSecretFindings } from "../../src/policy/secret-scan";

const SECRET_VALUES = {
	keyworded: "token-abcdefghijkl",
	jwtLike: "headerSegment1234.payloadSegment5678.signatureSegment9012",
	aws: "AKIAABCDEFGHIJKLMNOP",
	github: "github_pat_A1b2C3d4E5f6G7h8I9j0",
} as const;

describe("memory secret scanner", () => {
	it("covers every ported pattern with stable IDs, normalized lines, and redacted excerpts", () => {
		expect(SECRET_PATTERN_IDS).toEqual({
			keyworded: "keyworded-secret",
			jwtLike: "jwt-like-token",
			aws: "aws-access-key",
			github: "github-token",
		});

		const input = [
			"decomposed e\u0301 context",
			`keyword: ${SECRET_VALUES.keyworded}`,
			`jwt: ${SECRET_VALUES.jwtLike}`,
			`aws: ${SECRET_VALUES.aws}`,
			`github: ${SECRET_VALUES.github}`,
		].join("\r\n");

		const scanned = scanSecretContent(input);
		expect(scanned.ok).toBe(true);
		if (!scanned.ok) return;

		expect(scanned.value.redacted).toBe(
			[
				"decomposed é context",
				"keyword: [REDACTED]",
				"jwt: [REDACTED]",
				"aws: [REDACTED]",
				"github: [REDACTED]",
			].join("\n"),
		);
		expect(scanned.value.findings).toEqual([
			{
				kind: "secret-pattern",
				patternId: "keyworded-secret",
				sensitivity: "restricted",
				line: 2,
				excerptRedacted: "keyword: [REDACTED]",
			},
			{
				kind: "secret-pattern",
				patternId: "jwt-like-token",
				sensitivity: "restricted",
				line: 3,
				excerptRedacted: "jwt: [REDACTED]",
			},
			{
				kind: "secret-pattern",
				patternId: "aws-access-key",
				sensitivity: "restricted",
				line: 4,
				excerptRedacted: "aws: [REDACTED]",
			},
			{
				kind: "secret-pattern",
				patternId: "github-token",
				sensitivity: "restricted",
				line: 5,
				excerptRedacted: "github: [REDACTED]",
			},
		]);
	});

	it("covers alternate keyword, AWS, and GitHub spellings in the same redacted contract", () => {
		const variants = [
			["sk-abcdefghijkl", "keyworded-secret"],
			["pk-abcdefghijkl", "keyworded-secret"],
			["rk-abcdefghijkl", "keyworded-secret"],
			["tok-abcdefghijkl", "keyworded-secret"],
			["key-abcdefghijkl", "keyworded-secret"],
			["secret-abcdefghijkl", "keyworded-secret"],
			["token-abcdefghijkl", "keyworded-secret"],
			["password-abcdefghijkl", "keyworded-secret"],
			["ASIAABCDEFGHIJKLMNOP", "aws-access-key"],
			["ghp_A1b2C3d4E5f6", "github-token"],
			["gho_A1b2C3d4E5f6", "github-token"],
			["ghs_A1b2C3d4E5f6", "github-token"],
			["ghu_A1b2C3d4E5f6", "github-token"],
			["ghr_A1b2C3d4E5f6", "github-token"],
			["github_pat_A1b2C3d4E5f6", "github-token"],
		] as const;

		for (const [secret, patternId] of variants) {
			const scanned = scanSecretContent(secret);
			expect(scanned).toEqual({
				ok: true,
				value: {
					findings: [
						{
							kind: "secret-pattern",
							patternId,
							sensitivity: "restricted",
							line: 1,
							excerptRedacted: "[REDACTED]",
						},
					],
					redacted: "[REDACTED]",
				},
			});
			expect(JSON.stringify(scanned)).not.toContain(secret);
		}
	});

	it("never returns raw secret material through scan, findings, or redaction APIs", () => {
		const input = Object.values(SECRET_VALUES).join("\n");
		const scanned = scanSecretContent(input);
		const findings = scanSecretFindings(input);
		const redacted = redactSecrets(input);

		for (const result of [scanned, findings, redacted]) {
			expect(result.ok).toBe(true);
			expect(JSON.stringify(result)).not.toContain(SECRET_VALUES.keyworded);
			for (const secret of Object.values(SECRET_VALUES)) {
				expect(JSON.stringify(result)).not.toContain(secret);
			}
		}
		if (scanned.ok) expect(scanned.value.redacted).toContain("[REDACTED]");
		if (findings.ok) expect(findings.value).toHaveLength(4);
		if (redacted.ok) expect(redacted.value).toBe("[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]");
	});

	it("keeps CRLF and decomposed Unicode deterministic while preserving ordinary prose", () => {
		const prose = "ordinary e\u0301 prose\r\nwithout credentials";
		const redacted = redactSecrets(prose);
		expect(redacted).toEqual({ ok: true, value: "ordinary é prose\nwithout credentials" });

		const noMatch = scanSecretContent(prose);
		expect(noMatch).toEqual({
			ok: true,
			value: { findings: [], redacted: "ordinary é prose\nwithout credentials" },
		});
	});

	it("stays bounded on many matches across many lines while preserving line numbers and redaction", () => {
		const lines = Array.from(
			{ length: 2_000 },
			(_, index) => `line ${index} token-${String(index).padStart(12, "0")} sk-${String(index).padStart(12, "0")}`,
		);
		const input = lines.join("\n");
		const started = Date.now();
		const scanned = scanSecretContent(input);
		const elapsed = Date.now() - started;
		expect(scanned.ok).toBe(true);
		if (!scanned.ok) return;
		expect(elapsed).toBeLessThan(5_000);
		expect(scanned.value.findings).toHaveLength(lines.length * 2);
		expect(scanned.value.findings.map(finding => finding.line)).toEqual(
			lines.flatMap((_, index) => [index + 1, index + 1]),
		);
		expect(scanned.value.findings.every(finding => finding.excerptRedacted.includes("[REDACTED]"))).toBe(true);
		expect(scanned.value.redacted).not.toContain("token-000000000000");
		expect(scanned.value.redacted).not.toContain("sk-000000000000");
	});

	it("stays linear on long alphanumeric runs and still detects real JWTs", () => {
		// The unanchored JWT pattern backtracked catastrophically here: a megabyte
		// of a single repeated character never finished, which is a denial-of-service
		// risk for any large memory document reaching the scanner.
		const started = Date.now();
		const scanned = scanSecretContent("a".repeat(1_048_577));
		const elapsed = Date.now() - started;
		expect(scanned.ok).toBe(true);
		if (scanned.ok) expect(scanned.value.findings).toEqual([]);
		expect(elapsed).toBeLessThan(5_000);

		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const detected = scanSecretContent(`bearer ${jwt}\n`);
		expect(detected.ok).toBe(true);
		if (!detected.ok) return;
		expect(detected.value.findings.map(finding => finding.patternId)).toContain("jwt-like-token");
		expect(detected.value.redacted).not.toContain(jwt);
	});
});
