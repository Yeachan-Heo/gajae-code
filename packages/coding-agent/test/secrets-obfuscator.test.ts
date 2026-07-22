/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSecretObfuscator, loadSecrets } from "../src/secrets";
import { deobfuscateSessionContext, SecretObfuscator } from "../src/secrets/obfuscator";
import { compileSecretRegex } from "../src/secrets/regex";
import {
	associateSessionMessageEntryId,
	associateSessionMessageViewportAnchorId,
	getSessionMessageEntryId,
	getSessionMessageViewportAnchorId,
	type SessionContext,
} from "../src/session/session-manager";

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);

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

	it("rejects sticky regex flags that would defeat global scanning", () => {
		expect(() => compileSecretRegex("token-[a-z]+", "y")).toThrow('sticky "y" flag');
		expect(() => compileSecretRegex("/token-[a-z]+/y")).toThrow('sticky "y" flag');
	});

	it("preserves safe quantified alternation and regex literal flags", () => {
		const regex = compileSecretRegex("/(?:api|token)-[a-z]+/i", "m");
		expect(regex.source).toBe("(?:api|token)-[a-z]+");
		expect(regex.flags).toBe("gim");
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

	it("scans globally after a nonmatching prefix", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "token-[a-z]+", flags: "i" }]);
		const original = "prefix token-alpha suffix";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toContain("token-alpha");
		expect(obfuscator.deobfuscate(obfuscated)).toBe(original);
	});

	it("preserves zero-length regex handling", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "(?=token)" }]);
		expect(obfuscator.obfuscate("token token")).toBe("token token");
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

describe("loadSecrets regex provenance", () => {
	it("accepts global regexes while ignoring project regexes without dropping project plain entries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-secrets-provenance-"));
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		try {
			await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(
				path.join(agentDir, "secrets.yml"),
				[
					'- type: regex\n  content: "token-[a-z]+"',
					'- type: regex\n  content: "shared-[a-z]+"\n  mode: replace\n  replacement: GLOBAL',
				].join("\n"),
			);
			await Bun.write(
				path.join(cwd, ".gjc", "secrets.yml"),
				[
					"- type: plain\n  content: project-secret",
					'- type: plain\n  content: "shared-[a-z]+"',
					'- type: regex\n  content: "project-[a-z]+"',
					'- type: regex\n  content: "shared-[a-z]+"\n  mode: replace\n  replacement: PROJECT',
				].join("\n"),
			);

			const entries = await loadSecrets(cwd, agentDir);
			expect(entries).toContainEqual({
				type: "plain",
				content: "project-secret",
				mode: "obfuscate",
				replacement: undefined,
				flags: undefined,
			});
			expect(entries).not.toContainEqual(expect.objectContaining({ content: "project-[a-z]+" }));
			expect(entries).toContainEqual(expect.objectContaining({ content: "token-[a-z]+" }));
			expect(entries).toContainEqual(expect.objectContaining({ content: "shared-[a-z]+", replacement: "GLOBAL" }));
			expect(entries).toContainEqual(expect.objectContaining({ type: "plain", content: "shared-[a-z]+" }));
			expect(entries).not.toContainEqual(expect.objectContaining({ replacement: "PROJECT" }));

			const obfuscator = new SecretObfuscator(entries);
			const obfuscated = obfuscator.obfuscate("project-secret token-alpha project-alpha shared-beta");
			expect(obfuscated).not.toContain("project-secret");
			expect(obfuscated).not.toContain("token-alpha");
			expect(obfuscated).toContain("project-alpha");
			expect(obfuscated).toContain("GLOBAL");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("treats an agent directory inside the project as project scope", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-secrets-contained-agent-"));
		const cwd = path.join(root, "project");
		const agentDir = path.join(cwd, "caller-agent");
		try {
			await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(agentDir, "secrets.yml"), '- type: regex\n  content: "contained-[a-z]+"');

			const entries = await loadSecrets(cwd, agentDir);
			expect(entries).not.toContainEqual(expect.objectContaining({ type: "regex" }));
			expect(new SecretObfuscator(entries).obfuscate("contained-secret")).toBe("contained-secret");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed when agent directory canonicalization is unavailable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-secrets-canonical-failure-"));
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		try {
			await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(agentDir, "secrets.yml"), '- type: regex\n  content: "uncertain-[a-z]+"');
			const realpathSpy = spyOn(fs, "realpath").mockRejectedValue(new Error("canonicalization unavailable"));
			try {
				const entries = await loadSecrets(cwd, agentDir);
				expect(entries).not.toContainEqual(expect.objectContaining({ type: "regex" }));
				expect(new SecretObfuscator(entries).obfuscate("uncertain-secret")).toBe("uncertain-secret");
			} finally {
				realpathSpy.mockRestore();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")("classifies agent directory symlink aliases fail closed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-secrets-agent-alias-"));
		const cwd = path.join(root, "project");
		const outsideAgentDir = path.join(root, "outside-agent");
		const insideAgentDir = path.join(cwd, "inside-agent");
		const lexicalInsideAlias = path.join(cwd, "outside-alias");
		const canonicalInsideAlias = path.join(root, "inside-alias");
		try {
			await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
			await fs.mkdir(outsideAgentDir, { recursive: true });
			await fs.mkdir(insideAgentDir, { recursive: true });
			await Bun.write(path.join(outsideAgentDir, "secrets.yml"), '- type: regex\n  content: "outside-[a-z]+"');
			await Bun.write(path.join(insideAgentDir, "secrets.yml"), '- type: regex\n  content: "inside-[a-z]+"');
			await fs.symlink(outsideAgentDir, lexicalInsideAlias, "dir");
			await fs.symlink(insideAgentDir, canonicalInsideAlias, "dir");

			expect(await loadSecrets(cwd, lexicalInsideAlias)).toEqual([]);
			expect(await loadSecrets(cwd, canonicalInsideAlias)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("deobfuscateSessionContext", () => {
	it("preserves persisted entry identity on cloned messages", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "secret" }]);
		const unchangedMessage = { role: "user" as const, content: "ordinary", timestamp: 1 };
		const message = { role: "user" as const, content: obfuscator.obfuscate("secret"), timestamp: 2 };
		associateSessionMessageEntryId(unchangedMessage, "entry-1");
		associateSessionMessageEntryId(message, "entry-2");
		associateSessionMessageViewportAnchorId(message, "live-anchor-2");
		const context: SessionContext = {
			messages: [unchangedMessage, message],
			thinkingLevel: "off",
			models: {},
			configuredModelChains: {},
			injectedTtsrRules: [],
			ttsrMessageCount: 0,
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};

		const result = deobfuscateSessionContext(context, obfuscator);
		const resultMessage = result.messages[1];
		expect(result.messages[0]).toBe(unchangedMessage);
		expect(getSessionMessageEntryId(result.messages[0])).toBe("entry-1");
		expect(resultMessage).not.toBe(message);
		if (resultMessage.role !== "user") throw new Error(`Expected user message, got ${resultMessage.role}`);
		expect(resultMessage.content).toBe("secret");
		expect(getSessionMessageEntryId(resultMessage)).toBe("entry-2");
		expect(getSessionMessageViewportAnchorId(resultMessage)).toBe("live-anchor-2");
	});
});

describe("SecretObfuscator single-pass equivalence", () => {
	function placeholder(secret: string): string {
		return new SecretObfuscator([{ type: "plain", content: secret }], TEST_KEY).obfuscate(secret);
	}

	function referenceObfuscate(
		entries: Array<{ type: "plain"; content: string; mode?: "obfuscate" | "replace"; replacement?: string }>,
		text: string,
	): string {
		let result = text;
		const replaceMappingsBySecret = new Map<string, string>();
		const obfuscateMappingsBySecret = new Map<string, string>();
		for (const entry of entries) {
			if ((entry.mode ?? "obfuscate") === "replace")
				replaceMappingsBySecret.set(entry.content, entry.replacement ?? entry.content);
			else obfuscateMappingsBySecret.set(entry.content, placeholder(entry.content));
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
					content: placeholder("abc").slice(1, 4),
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
			expect(new SecretObfuscator(entries, TEST_KEY).obfuscate(text)).toBe(referenceObfuscate(entries, text));
		}
	});

	it("falls back when a replacement or placeholder contains another secret", () => {
		const entries = [
			{ type: "plain", content: "abc" },
			{ type: "plain", content: "bc", mode: "replace", replacement: "abc" },
		] as const;
		const text = "abc bc zabc";
		expect(new SecretObfuscator([...entries], TEST_KEY).obfuscate(text)).toBe(referenceObfuscate([...entries], text));
	});

	it("falls back for cross-phase substring overlap", () => {
		const entries = [
			{ type: "plain", content: "abc" },
			{ type: "plain", content: "bc", mode: "replace", replacement: "R" },
		] as const;
		expect(new SecretObfuscator([...entries], TEST_KEY).obfuscate("abc")).toBe("aR");
		expect(new SecretObfuscator([...entries], TEST_KEY).obfuscate("abc bc zabc")).toBe(
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
					new SecretObfuscator(entries.slice(0, entries.indexOf(entry) + 1), TEST_KEY).obfuscate(entry.content),
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
		const obfuscator = new SecretObfuscator([...entries], TEST_KEY);
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
			const obfuscator = new SecretObfuscator(entries, TEST_KEY);
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

describe("SecretObfuscator authenticated placeholders", () => {
	const otherKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

	it("round-trips only known versioned authenticated tokens", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "secret-value" }], TEST_KEY);
		const token = obfuscator.obfuscate("secret-value");
		expect(token).toMatch(/^#GJC1_[A-Za-z0-9_-]{22}#$/);
		expect(obfuscator.deobfuscate(token)).toBe("secret-value");
		for (const opaque of [
			"#AAAA#",
			"#GJC0_0123456789012345678901#",
			"#GJC1_0123456789012345678901#",
			"#GJC1_short#",
		]) {
			expect(obfuscator.deobfuscate(opaque)).toBe(opaque);
		}
	});

	it("matches the fixed authenticated-placeholder vector", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "secret-value" }], TEST_KEY);
		expect(obfuscator.obfuscate("secret-value")).toBe("#GJC1_LEyH7CSGoVYoWfjXx6PKVQ#");
	});

	it("keeps helper-created plain tokens stable within the process", () => {
		const entries = [{ type: "plain" as const, content: "process-secret" }];
		const first = createSecretObfuscator(entries);
		const second = createSecretObfuscator(entries);
		const token = first.obfuscate("process-secret");
		expect(second.obfuscate("process-secret")).toBe(token);
		expect(second.deobfuscate(token)).toBe("process-secret");
	});

	it("keeps fixed-key tokens stable and treats prior-process tokens as opaque under a new key", () => {
		const entries = [{ type: "plain" as const, content: "secret-value" }];
		const first = new SecretObfuscator(entries, TEST_KEY);
		const second = new SecretObfuscator(entries, TEST_KEY);
		const isolated = new SecretObfuscator(entries, otherKey);
		const token = first.obfuscate("secret-value");
		expect(second.obfuscate("secret-value")).toBe(token);
		expect(second.deobfuscate(token)).toBe("secret-value");
		expect(isolated.obfuscate("secret-value")).not.toBe(token);
		expect(isolated.deobfuscate(token)).toBe(token);
	});

	it("derives token identity independently of entry order", () => {
		const forward = new SecretObfuscator(
			[
				{ type: "plain", content: "first-secret" },
				{ type: "plain", content: "second-secret" },
			],
			TEST_KEY,
		);
		const reversed = new SecretObfuscator(
			[
				{ type: "plain", content: "second-secret" },
				{ type: "plain", content: "first-secret" },
			],
			TEST_KEY,
		);
		expect(forward.obfuscate("first-secret")).toBe(reversed.obfuscate("first-secret"));
	});

	it("reverses regex discoveries only in their originating instance", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "secret-[a-z]+" }], TEST_KEY);
		const text = "secret-short secret-muchlonger secret-short";
		const obfuscated = obfuscator.obfuscate(text);
		expect(obfuscated).not.toContain("secret-");
		expect(obfuscator.deobfuscate(obfuscated)).toBe(text);

		const reloaded = new SecretObfuscator([{ type: "regex", content: "secret-[a-z]+" }], TEST_KEY);
		const crossKey = new SecretObfuscator([{ type: "regex", content: "secret-[a-z]+" }], otherKey);
		expect(reloaded.deobfuscate(obfuscated)).toBe(obfuscated);
		expect(crossKey.deobfuscate(obfuscated)).toBe(obfuscated);
	});
});
