import { describe, expect, it } from "bun:test";
import { redactMemorySecretsForTesting as redact } from "@gajae-code/coding-agent/memories";

/** Stated Bearer/Basic value rule. The scrubber applies it only after a parse. */
function bearerOrBasicValueIsCredential(value: string): boolean {
	if (value.length < 8) return false;
	if (value.includes("+") || value.includes("/") || value.includes("=")) return true;
	return value.length >= 12 && /[0-9]/.test(value);
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-";
const QUOTES = [
	"colon",
	"eq",
	"dquote",
	"squote",
	"value-dquote",
	"value-squote",
	"bare",
	"bare-dquote",
	"bare-squote",
] as const;
const PREFIX = "note before ";
const SUFFIX = " note after";

function cased(word: string, mode: number): string {
	if (mode === 0) return word.toLowerCase();
	if (mode === 1) return word.toUpperCase();
	return [...word].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch)).join("");
}

function embed(auth: string, scheme: string, value: string, quoting: (typeof QUOTES)[number]): string {
	switch (quoting) {
		case "colon":
			return `${auth}: ${scheme} ${value}`;
		case "eq":
			return `${auth}=${scheme} ${value}`;
		case "dquote":
			return `"${auth}": "${scheme} ${value}"`;
		case "squote":
			return `'${auth}' = '${scheme} ${value}'`;
		case "value-dquote":
			return `${auth}: "${scheme} ${value}"`;
		case "value-squote":
			return `${auth}='${scheme} ${value}'`;
		case "bare":
			return `${scheme} ${value}`;
		case "bare-dquote":
			return `${scheme} "${value}"`;
		case "bare-squote":
			return `${scheme} '${value}'`;
	}
}

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

describe("bearer and basic credential properties", () => {
	it("replaces generated Bearer and Basic credentials and leaves credential-free prose", () => {
		const rng = mulberry32(0x3026819);
		const schemes = ["bearer", "basic"] as const;
		const seen = {
			schemes: new Set<string>(),
			cases: new Set<number>(),
			quotes: new Set<string>(),
			lengths: new Set<number>(),
			chars: new Set<string>(),
		};
		let credentials = 0;
		let kept = 0;

		const check = (value: string, scheme: "bearer" | "basic", quoting: (typeof QUOTES)[number], mode: number) => {
			const input = `${PREFIX}${embed(cased("authorization", mode), cased(scheme, mode), value, quoting)}${SUFFIX}`;
			const out = redact(input);
			if (!out.includes(PREFIX) || !out.includes(SUFFIX) || redact(out) !== out) {
				throw new Error(`surround or second pass changed: ${input} => ${out}`);
			}
			seen.schemes.add(scheme);
			seen.cases.add(mode);
			seen.quotes.add(quoting);
			seen.lengths.add(value.length);
			if (bearerOrBasicValueIsCredential(value)) {
				credentials += 1;
				for (const ch of value) seen.chars.add(ch);
				if (out.includes(value)) throw new Error(`credential survived: ${input} => ${out}`);
			} else if (/^[a1+/=]+$/.test(value)) {
				kept += 1;
				if (out !== input) throw new Error(`non-credential changed: ${input} => ${out}`);
			}
		};

		const boundary = (length: number, kind: "letters" | "digit" | "plus" | "slash" | "eq") => {
			const chars = Array.from({ length }, () => "a");
			if (kind === "digit") chars[length - 1] = "1";
			if (kind === "plus") chars[length - 1] = "+";
			if (kind === "slash") chars[length - 1] = "/";
			if (kind === "eq") chars[length - 1] = "=";
			return chars.join("");
		};

		for (const length of [7, 8, 11, 12, 13, 24]) {
			for (const kind of ["letters", "digit", "plus", "slash", "eq"] as const) {
				for (const scheme of schemes) {
					check(boundary(length, kind), scheme, "colon", 0);
				}
			}
		}
		for (const quoting of QUOTES) {
			for (const scheme of schemes) {
				for (const mode of [0, 1, 2]) {
					check("aaaaaaaaaaa1", scheme, quoting, mode);
					check("aaaaaaaaaaaa", scheme, quoting, mode);
					check("aaaaaaa+", scheme, quoting, mode);
					check("aaaaaaa", scheme, quoting, mode);
				}
			}
		}
		for (const ch of TOKEN_CHARS) {
			const quoting = QUOTES[ch.charCodeAt(0) % QUOTES.length] ?? "colon";
			check(`aaaaaaa1${ch}aaaa`, ch < "N" ? "bearer" : "basic", quoting, ch.charCodeAt(0) % 3);
		}
		for (let n = 0; n < 80; n += 1) {
			const length = [8, 11, 12, 16, 32][Math.floor(rng() * 5)];
			let value = "";
			for (let i = 0; i < length; i += 1) value += TOKEN_CHARS[Math.floor(rng() * TOKEN_CHARS.length)];
			check(value, schemes[Math.floor(rng() * 2)], QUOTES[Math.floor(rng() * QUOTES.length)], Math.floor(rng() * 3));
		}

		expect(credentials).toBeGreaterThan(100);
		expect(kept).toBeGreaterThan(20);
		expect(seen.schemes.has("bearer")).toBe(true);
		expect(seen.schemes.has("basic")).toBe(true);
		expect(seen.cases.has(0) && seen.cases.has(1) && seen.cases.has(2)).toBe(true);
		expect(seen.quotes.size).toBe(QUOTES.length);
		for (const length of [7, 8, 11, 12]) expect(seen.lengths.has(length)).toBe(true);
		for (const ch of TOKEN_CHARS) expect(seen.chars.has(ch)).toBe(true);

		const words = [
			"the",
			"ran",
			"github",
			"workflow",
			"twice",
			"and",
			"second",
			"attempt",
			"passed",
			"basic",
			"auth",
			"is",
			"documented",
			"for",
			"proxy",
			"bearer",
			"of",
			"this",
			"request",
			"caller",
			"note",
			"kept",
			"ordinary",
			"text",
		];
		const prose = [
			"Ran the github workflow twice; the second attempt passed.",
			"Basic authentication is documented for the proxy. The bearer of this request is the caller.",
		];
		for (let n = 0; n < 24; n += 1) {
			const parts: string[] = [];
			for (let i = 0; i < 14; i += 1) parts.push(words[Math.floor(rng() * words.length)] ?? "note");
			prose.push(parts.join(" "));
		}
		for (const sentence of prose) {
			if (redact(sentence) !== sentence) throw new Error(`prose changed: ${sentence}`);
		}
	});
});
