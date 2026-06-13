/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import { compileSecretRegex } from "../src/secrets/regex";

describe("compileSecretRegex", () => {
	it("adds global flag when not provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+", "i");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("defaults to global flag when no flags provided", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("g");
	});

	it("rejects invalid regex pattern", () => {
		expect(() => compileSecretRegex("(")).toThrow();
	});
	it("rejects invalid regex flags", () => {
		expect(() => compileSecretRegex("x", "zz")).toThrow();
	});
});

describe("SecretObfuscator regex behavior", () => {
	it("obfuscates and deobfuscates regex matches with flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = "API_KEY=abc and api-key=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("supports bare regex patterns without explicit flags", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+" }]);
		const text = "api_key=abc and API_KEY=def";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toEqual(text);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(text);
	});
	it("deobfuscates placeholders through object payloads", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+", flags: "i" }]);
		const original = {
			cmd: "API_KEY=abc and api-key=def",
			status: "ok",
		};
		const obfuscated = {
			cmd: obfuscator.obfuscate(original.cmd),
			status: original.status,
		};
		expect(obfuscator.deobfuscateObject(obfuscated)).toEqual({
			cmd: original.cmd,
			status: original.status,
		});
	});
});

describe("SecretObfuscator single-pass equivalence", () => {
	function placeholder(index: number): string {
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		let v = Bun.hash.xxHash32(String(index), 0x5345_4352);
		let tag = "#";
		for (let i = 0; i < 4; i++) {
			tag += chars[v % chars.length];
			v = Math.floor(v / chars.length);
		}
		return `${tag}#`;
	}

	function referenceObfuscate(
		entries: Array<{ type: "plain"; content: string; mode?: "obfuscate" | "replace"; replacement?: string }>,
		text: string,
	): string {
		let result = text;
		const replaceMappingsBySecret = new Map<string, string>();
		const obfuscateMappingsBySecret = new Map<string, string>();
		let index = 0;
		for (const entry of entries) {
			if ((entry.mode ?? "obfuscate") === "replace")
				replaceMappingsBySecret.set(entry.content, entry.replacement ?? entry.content);
			else obfuscateMappingsBySecret.set(entry.content, placeholder(index++));
		}
		for (const mapping of [...replaceMappingsBySecret].sort((a, b) => b[0].length - a[0].length))
			result = result.split(mapping[0]).join(mapping[1]);
		for (const mapping of [...obfuscateMappingsBySecret].sort((a, b) => b[0].length - a[0].length))
			result = result.split(mapping[0]).join(mapping[1]);
		return result;
	}

	it("matches sequential longest-first output for seeded adversarial plain mappings", () => {
		let seed = 0xdecafbad;
		const random = (): number => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		for (let round = 0; round < 120; round++) {
			const entries: Array<{
				type: "plain";
				content: string;
				mode?: "obfuscate" | "replace";
				replacement?: string;
			}> = [
				{ type: "plain", content: "abc" },
				{ type: "plain", content: "bc", mode: "replace", replacement: round % 2 === 0 ? "abc-wrap" : "R" },
				{
					type: "plain",
					content: placeholder(0).slice(1, 4),
					mode: "replace",
					replacement: "PLACEHOLDER-SUBSTRING",
				},
			];
			for (let i = 0; i < 10; i++) {
				const stem = `s${Math.floor(random() * 5)}`;
				const content = stem + "x".repeat(Math.floor(random() * 4));
				entries.push(
					random() < 0.5
						? { type: "plain", content }
						: {
								type: "plain",
								content,
								mode: "replace",
								replacement: random() < 0.25 ? `pre-${content}-post` : `r${round}_${i}`,
							},
				);
			}
			const tokens = entries.map(entry => entry.content);
			const text = Array.from({ length: 120 }, (_, i) => {
				const token = tokens[Math.floor(random() * tokens.length)]!;
				const overlap = token.length > 1 ? token.slice(1) : token;
				return i % 3 === 0 ? `${token}${overlap}` : token;
			}).join("|");
			expect(new SecretObfuscator(entries).obfuscate(text)).toBe(referenceObfuscate(entries, text));
		}
	});

	it("falls back when a replacement or placeholder contains another secret", () => {
		const entries = [
			{ type: "plain", content: "abc" },
			{ type: "plain", content: "bc", mode: "replace", replacement: "abc" },
		] as const;
		const text = "abc bc zabc";
		expect(new SecretObfuscator([...entries]).obfuscate(text)).toBe(referenceObfuscate([...entries], text));
	});

	it("falls back for cross-phase substring overlap", () => {
		const entries = [
			{ type: "plain", content: "abc" },
			{ type: "plain", content: "bc", mode: "replace", replacement: "R" },
		] as const;
		expect(new SecretObfuscator([...entries]).obfuscate("abc")).toBe("aR");
		expect(new SecretObfuscator([...entries]).obfuscate("abc bc zabc")).toBe(
			referenceObfuscate([...entries], "abc bc zabc"),
		);
	});
});

describe("SecretObfuscator sorted mapping cache", () => {
	function oldObfuscate(
		entries: Array<{ type: "plain"; content: string; mode?: "obfuscate" | "replace"; replacement?: string }>,
		text: string,
	): string {
		let result = text;
		const replaceMappings = new Map<string, string>();
		const plainMappings = new Map<string, string>();
		for (const entry of entries) {
			const mode = entry.mode ?? "obfuscate";
			if (mode === "replace") {
				replaceMappings.set(entry.content, entry.replacement ?? entry.content.replace(/./g, "x"));
			} else {
				plainMappings.set(
					entry.content,
					new SecretObfuscator(entries.slice(0, entries.indexOf(entry) + 1)).obfuscate(entry.content),
				);
			}
		}
		for (const [secret, replacement] of [...replaceMappings].sort((a, b) => b[0].length - a[0].length)) {
			result = result.split(secret).join(replacement);
		}
		for (const [secret, placeholder] of [...plainMappings].sort((a, b) => b[0].length - a[0].length)) {
			result = result.split(secret).join(placeholder);
		}
		return result;
	}

	it("preserves longest-first plain mapping output", () => {
		const entries = [
			{ type: "plain", content: "token", mode: "replace", replacement: "SHORT" },
			{ type: "plain", content: "token-extended", mode: "replace", replacement: "LONG" },
			{ type: "plain", content: "secret" },
			{ type: "plain", content: "secret-value" },
		] as const;
		const text = "token token-extended secret secret-value";
		const obfuscator = new SecretObfuscator([...entries]);
		expect(obfuscator.obfuscate(text)).toBe(oldObfuscate([...entries], text));
	});

	it("matches the previous sorted-per-call behavior for random plain secret sets", () => {
		let seed = 0x12345678;
		const random = (): number => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		for (let round = 0; round < 50; round++) {
			const entries: Array<{ type: "plain"; content: string; mode?: "replace"; replacement?: string }> = [];
			for (let i = 0; i < 12; i++) {
				const base = `s${Math.floor(random() * 6)}`;
				const content = base + "x".repeat(Math.floor(random() * 5));
				entries.push(
					random() < 0.5
						? { type: "plain", content }
						: { type: "plain", content, mode: "replace", replacement: `r${round}_${i}` },
				);
			}
			const text = Array.from(
				{ length: 80 },
				() => `s${Math.floor(random() * 6)}${"x".repeat(Math.floor(random() * 5))}`,
			).join(" ");
			const obfuscator = new SecretObfuscator(entries);
			expect(obfuscator.obfuscate(text)).toBe(oldObfuscate(entries, text));
		}
	});

	it("keeps regex-discovered obfuscation stable and reversible", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "secret-[a-z]+" }]);
		const text = "secret-short secret-muchlonger secret-short";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toBe(text);
		expect(obfuscator.deobfuscate(obfuscated)).toBe(text);
	});
});
