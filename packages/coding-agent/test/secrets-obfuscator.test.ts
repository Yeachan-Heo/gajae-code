/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, DeveloperMessage, ToolResultMessage, UserMessage } from "@gajae-code/ai/core";
import { streamBedrock } from "@gajae-code/ai/providers/amazon-bedrock";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";
import { convertMessages as convertGoogleMessages } from "@gajae-code/ai/providers/google-shared";
import { streamOpenAIResponses } from "@gajae-code/ai/providers/openai-responses";
import { convertResponsesAssistantMessage } from "@gajae-code/ai/providers/openai-responses-shared";
import type { Model } from "@gajae-code/ai/types";
import { createSecretObfuscator, loadSecrets } from "../src/secrets";
import { deobfuscateSessionContext, obfuscateMessages, SecretObfuscator } from "../src/secrets/obfuscator";
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
const REPLACEMENT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

describe("SecretObfuscator keyed deterministic replacement", () => {
	const otherKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

	function replaceOutput(key: Uint8Array, secret: string, text = `db pw = ${secret}`): string {
		return new SecretObfuscator([{ type: "plain", content: secret, mode: "replace" }], key).obfuscate(text);
	}

	function derivedReplacement(key: Uint8Array, secret: string): string {
		const output = replaceOutput(key, secret, secret);
		expect(output.length).toBe(secret.length);
		return output;
	}

	it("derives replace-mode replacements from the key (key A/B divergence)", () => {
		const secret = "acme-staging-2024";
		expect(replaceOutput(TEST_KEY, secret)).not.toBe(replaceOutput(otherKey, secret));
	});

	it("is mutation-sensitive to the key: flipping one key byte changes the replacement", () => {
		const secret = "acme-staging-2024";
		const flipped = Uint8Array.from(TEST_KEY);
		flipped[0]! ^= 1;
		expect(replaceOutput(TEST_KEY, secret)).not.toBe(replaceOutput(flipped, secret));
	});

	it("is mutation-sensitive to the secret: changing one character changes the replacement", () => {
		expect(replaceOutput(TEST_KEY, "acme-staging-2024")).not.toBe(replaceOutput(TEST_KEY, "acme-staging-2025"));
	});

	it("prevents offline confirmation without the key", () => {
		const secret = "acme-staging-2024";
		const observed = replaceOutput(TEST_KEY, secret).split("db pw = ")[1]!;
		const candidates = ["prod-db-pass-1", "staging-2024", "dev-password-1", "acme-prod-2024", "acme-staging-2024"];
		// Attacker guesses with an attacker-chosen key: no candidate reproduces the observation.
		for (const candidate of candidates) {
			expect(replaceOutput(otherKey, candidate).split("db pw = ")[1]).not.toBe(observed);
		}
		// Positive control: with the true key, exactly the true secret matches.
		expect(replaceOutput(TEST_KEY, secret).split("db pw = ")[1]).toBe(observed);
		expect(replaceOutput(TEST_KEY, "prod-db-pass-1").split("db pw = ")[1]).not.toBe(observed);
	});

	it("keeps deterministic same-process output regardless of entry order", () => {
		const secret = "acme-staging-2024";
		const first = new SecretObfuscator([{ type: "plain", content: secret, mode: "replace" }], TEST_KEY);
		const second = new SecretObfuscator(
			[
				{ type: "plain", content: "other-secret" },
				{ type: "plain", content: secret, mode: "replace" },
			],
			TEST_KEY,
		);
		expect(second.obfuscate(`db pw = ${secret}`)).toBe(first.obfuscate(`db pw = ${secret}`));
	});

	it("preserves same-length alphanumeric output for ASCII, Unicode, and very long secrets", () => {
		const secrets = ["a", "acme-staging-2024", "héllo🔑secret", "x".repeat(5000)];
		for (const secret of secrets) {
			const output = derivedReplacement(TEST_KEY, secret);
			expect(output).toMatch(/^[A-Za-z0-9]*$/);
		}
	});

	it("never exposes the secret in replace-mode output", () => {
		const secrets = ["acme-staging-2024", "super-secret-token-abc", "x".repeat(64)];
		for (const secret of secrets) {
			const output = new SecretObfuscator([{ type: "plain", content: secret, mode: "replace" }], TEST_KEY).obfuscate(
				`db pw = ${secret} and again ${secret}`,
			);
			expect(output).not.toContain(secret);
			expect(output).toMatch(/^db pw = [A-Za-z0-9]+ and again [A-Za-z0-9]+$/);
		}
	});

	it("leaves explicit replacement values byte-identical", () => {
		const secret = "acme-staging-2024";
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: secret, mode: "replace", replacement: "FIXED-VALUE" }],
			TEST_KEY,
		);
		expect(obfuscator.obfuscate(`db pw = ${secret}`)).toBe("db pw = FIXED-VALUE");
		expect(obfuscator.obfuscate(secret)).toBe("FIXED-VALUE");
	});

	it("keys regex-discovered replace-mode substitutions too", () => {
		const matchText = "token-ab12";
		const keyed = new SecretObfuscator([{ type: "regex", content: "token-[a-z0-9]+", mode: "replace" }], TEST_KEY);
		const other = new SecretObfuscator([{ type: "regex", content: "token-[a-z0-9]+", mode: "replace" }], otherKey);
		const keyedOut = keyed.obfuscate(`value=${matchText}`);
		expect(keyedOut).not.toContain(matchText);
		expect(keyedOut).toMatch(/^value=[A-Za-z0-9]+$/);
		expect(keyedOut).not.toBe(other.obfuscate(`value=${matchText}`));
		expect(keyedOut.length).toBe(other.obfuscate(`value=${matchText}`).length);
	});

	it("treats an empty derived secret as a no-op replacement", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "", mode: "replace" }], TEST_KEY);
		expect(obfuscator.obfuscate("unchanged text")).toBe("unchanged text");
	});

	it("spreads derived characters across the alphabet without modulo bias", () => {
		let seed = 0x4166_2024;
		const random = (): number => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		const counts = new Map<string, number>();
		let total = 0;
		for (let round = 0; round < 200; round++) {
			let secret = "";
			for (let i = 0; i < 32; i++) secret += REPLACEMENT_ALPHABET[Math.floor(random() * 62)]!;
			const output = derivedReplacement(TEST_KEY, secret);
			for (const char of output) {
				counts.set(char, (counts.get(char) ?? 0) + 1);
				total++;
			}
		}
		expect(total).toBe(200 * 32);
		const expected = total / 62;
		for (const char of REPLACEMENT_ALPHABET) {
			const count = counts.get(char) ?? 0;
			expect(count).toBeGreaterThan(expected * 0.5);
			expect(count).toBeLessThan(expected * 1.5);
		}
	});
});

describe("obfuscateMessages", () => {
	it("obfuscates a tool-call argument that contains the configured secret, and still obfuscates text blocks", () => {
		const secret = "configured-secret-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], TEST_KEY);
		const text = { type: "text" as const, text: `visible ${secret}` };
		const thinking = {
			type: "thinking" as const,
			thinking: `plan ${secret}`,
			summaryText: `summary ${secret}`,
			rawText: secret,
		};
		const redacted = { type: "redactedThinking" as const, data: "opaque-without-secret" };
		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "bash",
			arguments: {
				command: `echo ${secret}`,
				retries: 1,
				nested: { token: secret, ok: true },
				items: ["keep", secret],
			},
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [text, thinking, redacted, toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const image = { type: "image" as const, data: secret, mimeType: "image/png" };
		const user = {
			role: "user" as const,
			content: [{ type: "text" as const, text: `user ${secret}` }, image],
			timestamp: 2,
		};
		const unchanged = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "no secret here" }],
			timestamp: 3,
		};

		const [obfuscatedAssistant, obfuscatedUser, obfuscatedUnchanged] = obfuscateMessages(obfuscator, [
			assistant,
			user,
			unchanged,
		]);

		expect(obfuscatedUnchanged).toBe(unchanged);
		if (obfuscatedAssistant.role !== "assistant") throw new Error("expected assistant message");
		const [obfuscatedText, obfuscatedThinking, obfuscatedRedacted, obfuscatedCall] = obfuscatedAssistant.content;
		if (obfuscatedText?.type !== "text") throw new Error("expected text block");
		expect(obfuscatedText.text).not.toContain(secret);
		expect(obfuscatedText.text).toContain("#GJC1_");

		if (obfuscatedCall?.type !== "toolCall") throw new Error("expected tool call");
		expect(JSON.stringify(obfuscatedCall.arguments)).not.toContain(secret);
		expect(obfuscatedCall.arguments.retries).toBe(1);
		expect(obfuscatedCall.arguments.nested.ok).toBe(true);
		expect(obfuscatedCall.arguments.items[0]).toBe("keep");
		expect(obfuscatedCall.id).toBe("call-1");
		expect(obfuscatedCall.name).toBe("bash");

		if (obfuscatedThinking?.type !== "thinking") throw new Error("expected thinking block");
		expect(obfuscatedThinking.thinking).not.toContain(secret);
		expect(obfuscatedThinking.summaryText).not.toContain(secret);
		expect(obfuscatedThinking.rawText).not.toContain(secret);
		expect(obfuscatedThinking.thinkingSignature).toBeUndefined();
		expect(obfuscatedThinking.type).toBe("thinking");

		if (obfuscatedRedacted?.type !== "redactedThinking") throw new Error("expected redacted thinking block");
		expect(obfuscatedRedacted).toBe(redacted);

		expect(obfuscator.deobfuscateObject(obfuscatedAssistant.content)).toEqual(assistant.content);

		if (obfuscatedUser.role !== "user" || !Array.isArray(obfuscatedUser.content)) {
			throw new Error("expected user content blocks");
		}
		const [obfuscatedUserText, obfuscatedImage] = obfuscatedUser.content;
		if (obfuscatedUserText?.type !== "text") throw new Error("expected user text block");
		expect(obfuscatedUserText.text).not.toContain(secret);
		expect(obfuscatedImage).toBe(image);
		expect(image.data).toBe(secret);
	});

	it("keeps an own __proto__ argument key through obfuscation and deobfuscation", () => {
		const secret = "configured-secret-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], TEST_KEY);
		const argumentsObject: Record<string, unknown> = {};
		Object.defineProperty(argumentsObject, "__proto__", {
			value: { token: secret },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		const toolCall = {
			type: "toolCall" as const,
			id: "call-proto",
			name: "bash",
			arguments: argumentsObject,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const [obfuscated] = obfuscateMessages(obfuscator, [assistant]);
		if (obfuscated?.role !== "assistant") throw new Error("expected assistant message");
		const call = obfuscated.content[0];
		if (call?.type !== "toolCall") throw new Error("expected tool call");
		expect(Object.hasOwn(call.arguments, "__proto__")).toBe(true);
		expect(JSON.stringify(call.arguments)).not.toContain(secret);
		const restored = obfuscator.deobfuscateObject(call.arguments);
		expect(Object.hasOwn(restored, "__proto__")).toBe(true);
		const own = Object.getOwnPropertyDescriptor(restored, "__proto__")?.value as { token?: string };
		expect(own.token).toBe(secret);
	});

	it("omits signed Anthropic and OpenAI thinking, and opaque redacted thinking, when a secret is present", () => {
		const secret = "configured-secret-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], TEST_KEY);
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const anthropicSignature = "anthropic-sig-keep";
		const openaiSignature = JSON.stringify({ id: "rs_1", encrypted_content: `cipher ${secret}` });
		const toolCall = {
			type: "toolCall" as const,
			id: "call-replay",
			name: "bash",
			arguments: { command: "echo ok" },
		};
		const anthropic: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `plan ${secret}`,
					thinkingSignature: anthropicSignature,
				},
				{ type: "redactedThinking", data: `blob ${secret}` },
				toolCall,
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const openai: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "clean reasoning",
					thinkingSignature: openaiSignature,
					itemId: "item-1",
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage,
			stopReason: "stop",
			timestamp: 2,
		};
		const cleanSigned: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "no secret here",
					thinkingSignature: "sig-unchanged",
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage,
			stopReason: "stop",
			timestamp: 3,
		};

		const [obfuscatedAnthropic, obfuscatedOpenai, obfuscatedClean] = obfuscateMessages(obfuscator, [
			anthropic,
			openai,
			cleanSigned,
		]);

		if (obfuscatedAnthropic?.role !== "assistant") throw new Error("expected anthropic assistant");
		expect(
			obfuscatedAnthropic.content.some(block => block.type === "thinking" || block.type === "redactedThinking"),
		).toBe(false);
		expect(JSON.stringify(obfuscatedAnthropic.content)).not.toContain(secret);
		expect(JSON.stringify(obfuscatedAnthropic.content)).not.toContain(anthropicSignature);
		expect(obfuscatedAnthropic.content).toEqual([toolCall]);

		if (obfuscatedOpenai?.role !== "assistant") throw new Error("expected openai assistant");
		expect(obfuscatedOpenai.content).toEqual([]);
		expect(JSON.stringify(obfuscatedOpenai)).not.toContain(secret);
		expect(JSON.stringify(obfuscatedOpenai)).not.toContain("rs_1");

		expect(obfuscatedClean).toBe(cleanSigned);
	});

	it("omits signed provider replay bytes and redacts only the text those providers do not sign", async () => {
		const secret = "configured-secret-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], TEST_KEY);
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const anthropicModel: Model<"anthropic-messages"> = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.anthropic.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 200_000,
			reasoning: true,
		};
		const responsesModel: Model<"openai-responses"> = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-4.1-mini",
			name: "gpt-4.1-mini",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 16_000,
			contextWindow: 128_000,
			reasoning: true,
		};
		const googleModel: Model<"google-generative-ai"> = {
			api: "google-generative-ai",
			provider: "google",
			id: "gemini-2.0-flash",
			name: "Gemini 2.0 Flash",
			baseUrl: "",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 1_000_000,
			reasoning: true,
		};
		const googleSignature = "QUJDRA==";
		const cleanReasoning = JSON.stringify({
			type: "reasoning",
			id: "rs_clean",
			encrypted_content: "enc-clean",
		});
		const anthropic: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `plan ${secret}`, thinkingSignature: "anthropic-sig" },
				{ type: "thinking", thinking: `unsigned ${secret}`, thinkingSignature: "" },
				{ type: "redactedThinking", data: `blob ${secret}` },
				{ type: "toolCall", id: "toolu_replay", name: "bash", arguments: { command: "echo ok" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: anthropicModel.id,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const responses: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `plan ${secret}`,
					thinkingSignature: cleanReasoning,
					itemId: "rs_clean",
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: responsesModel.id,
			usage,
			stopReason: "stop",
			timestamp: 2,
		};
		const google: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `plan ${secret}`, thinkingSignature: googleSignature },
				{
					type: "toolCall",
					id: "call_google",
					name: "bash",
					arguments: { command: `echo ${secret}` },
					thoughtSignature: googleSignature,
				},
			],
			api: "google-generative-ai",
			provider: "google",
			model: googleModel.id,
			usage,
			stopReason: "toolUse",
			timestamp: 3,
		};
		const completions: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `plan ${secret}`,
					thinkingSignature: "reasoning_content",
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "compat-model",
			usage,
			stopReason: "stop",
			timestamp: 4,
		};
		const history: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "visible reply" }],
			api: "openai-responses",
			provider: "openai",
			model: responsesModel.id,
			usage,
			stopReason: "stop",
			timestamp: 5,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [
					{ type: "reasoning", id: "rs_payload", encrypted_content: `cipher ${secret}` },
					{
						type: "function_call",
						call_id: "call_payload",
						name: "bash",
						arguments: JSON.stringify({ command: `echo ${secret}` }),
					},
					{
						type: "message",
						role: "assistant",
						status: "completed",
						id: "msg_clean",
						content: [{ type: "output_text", text: "clean reply" }],
					},
				],
			},
		};

		const [obfuscatedAnthropic, obfuscatedResponses, obfuscatedGoogle, obfuscatedCompletions, obfuscatedHistory] =
			obfuscateMessages(obfuscator, [anthropic, responses, google, completions, history]);
		if (obfuscatedAnthropic?.role !== "assistant") throw new Error("expected anthropic assistant");
		if (obfuscatedResponses?.role !== "assistant") throw new Error("expected responses assistant");
		if (obfuscatedGoogle?.role !== "assistant") throw new Error("expected google assistant");
		if (obfuscatedCompletions?.role !== "assistant") throw new Error("expected completions assistant");
		if (obfuscatedHistory?.role !== "assistant") throw new Error("expected history assistant");

		const anthropicWire = JSON.stringify(
			convertAnthropicMessages(
				[{ role: "user", content: "continue", timestamp: 1 }, obfuscatedAnthropic],
				anthropicModel,
				false,
			),
		);
		expect(anthropicWire).not.toContain(secret);
		expect(anthropicWire).not.toContain("anthropic-sig");
		expect(anthropicWire).not.toContain("redacted_thinking");
		expect(anthropicWire).toContain("tool_use");
		expect(anthropicWire).toContain("unsigned");
		const unsigned = obfuscatedAnthropic.content.find(block => block.type === "thinking");
		if (unsigned?.type !== "thinking") throw new Error("expected redacted unsigned thinking");
		expect(unsigned.thinking).not.toContain(secret);
		expect(unsigned.thinkingSignature).toBe("");

		const responsesBlock = obfuscatedResponses.content[0];
		if (responsesBlock?.type !== "thinking") throw new Error("expected responses thinking to stay");
		expect(responsesBlock.thinking).not.toContain(secret);
		expect(responsesBlock.thinkingSignature).toBe(cleanReasoning);
		const responsesWire = JSON.stringify(
			convertResponsesAssistantMessage(obfuscatedResponses, responsesModel, 0, new Set()),
		);
		expect(responsesWire).not.toContain(secret);
		expect(responsesWire).toContain("rs_clean");
		expect(responsesWire).toContain("enc-clean");

		const googleWire = JSON.stringify(
			convertGoogleMessages(googleModel, {
				messages: [{ role: "user", content: "continue", timestamp: 1 }, obfuscatedGoogle],
			}),
		);
		expect(googleWire).not.toContain(secret);
		expect(googleWire).not.toContain(googleSignature);
		expect(googleWire).toContain("bash");
		const googleCall = obfuscatedGoogle.content.find(block => block.type === "toolCall");
		if (googleCall?.type !== "toolCall") throw new Error("expected google tool call");
		expect(googleCall.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(googleCall.arguments)).not.toContain(secret);

		const completionsBlock = obfuscatedCompletions.content[0];
		if (completionsBlock?.type !== "thinking") throw new Error("expected completions thinking to stay");
		expect(completionsBlock.thinking).not.toContain(secret);
		expect(completionsBlock.thinkingSignature).toBe("reasoning_content");

		const historyItems = obfuscatedHistory.providerPayload?.items ?? [];
		expect(historyItems.some(item => item.type === "reasoning")).toBe(false);
		expect(JSON.stringify(historyItems)).not.toContain(secret);
		expect(JSON.stringify(historyItems)).toContain("call_payload");
		const controller = new AbortController();
		controller.abort();
		const payload = await Promise.race([
			new Promise<unknown>(resolve => {
				streamOpenAIResponses(
					responsesModel,
					{ messages: [{ role: "user", content: "continue", timestamp: 1 }, obfuscatedHistory] },
					{
						apiKey: "test-key",
						signal: controller.signal,
						onPayload: captured => resolve(captured),
					},
				);
			}),
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("OpenAI replay payload was not captured")), 20_000);
			}),
		]);
		const replayWire = JSON.stringify(payload);
		expect(replayWire).not.toContain(secret);
		expect(replayWire).not.toContain("rs_payload");
		expect(replayWire).toContain("call_payload");
		expect(replayWire).toContain("clean reply");
	});

	it("omits signed replay bytes when substitution would leave the secret unchanged", () => {
		const secret = "cycle-secret-value";
		const other = "cycle-other-valuex";
		const cycled = new SecretObfuscator(
			[
				{ type: "plain", content: secret, mode: "replace", replacement: other },
				{ type: "plain", content: other, mode: "replace", replacement: secret },
			],
			TEST_KEY,
		);
		const unchanged = new SecretObfuscator(
			[{ type: "plain", content: secret, mode: "replace", replacement: secret }],
			TEST_KEY,
		);
		expect(cycled.obfuscate(secret)).toBe(secret);
		expect(unchanged.obfuscate(`plan ${secret}`)).toBe(`plan ${secret}`);

		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const anthropicModel: Model<"anthropic-messages"> = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.anthropic.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 200_000,
			reasoning: true,
		};
		const signed = (): AssistantMessage => ({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `plan ${secret}`, thinkingSignature: "anthropic-cycle-sig" },
				{ type: "thinking", thinking: `unsigned ${secret}`, thinkingSignature: "" },
				{ type: "text", text: `visible ${secret}` },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: anthropicModel.id,
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const [cycledAssistant] = obfuscateMessages(cycled, [signed()]);
		if (cycledAssistant?.role !== "assistant") throw new Error("expected cycled assistant");
		expect(JSON.stringify(cycledAssistant)).not.toContain(secret);
		expect(JSON.stringify(cycledAssistant)).not.toContain("anthropic-cycle-sig");
		const cycledWire = JSON.stringify(
			convertAnthropicMessages(
				[{ role: "user", content: "continue", timestamp: 1 }, cycledAssistant],
				anthropicModel,
				false,
			),
		);
		expect(cycledWire).not.toContain(secret);
		expect(cycledWire).not.toContain("anthropic-cycle-sig");
		expect(cycledWire).toContain("unsigned");

		const [noopAssistant] = obfuscateMessages(unchanged, [signed()]);
		if (noopAssistant?.role !== "assistant") throw new Error("expected no-op assistant");
		expect(
			noopAssistant.content.some(
				block => block.type === "thinking" && block.thinkingSignature === "anthropic-cycle-sig",
			),
		).toBe(false);
		expect(JSON.stringify(noopAssistant)).not.toContain("anthropic-cycle-sig");
		const visible = noopAssistant.content.find(block => block.type === "text");
		if (visible?.type !== "text") throw new Error("expected visible text");
		expect(visible.text).toBe(`visible ${secret}`);
		const noopWire = JSON.stringify(
			convertAnthropicMessages(
				[{ role: "user", content: "continue", timestamp: 1 }, noopAssistant],
				anthropicModel,
				false,
			),
		);
		expect(noopWire).not.toContain("anthropic-cycle-sig");
		expect(noopWire).toContain("unsigned");
	});

	it("omits JSON-escaped secrets in signed, opaque, and replayed provider bytes", async () => {
		const secret = 'tok-"en"-value';
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], TEST_KEY);
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const anthropicModel: Model<"anthropic-messages"> = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.anthropic.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 200_000,
			reasoning: true,
		};
		const responsesModel: Model<"openai-responses"> = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-4.1-mini",
			name: "gpt-4.1-mini",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 16_000,
			contextWindow: 128_000,
			reasoning: true,
		};
		const bedrockModel: Model<"bedrock-converse-stream"> = {
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			id: "anthropic.claude-sonnet-4-6-v1:0",
			name: "Claude",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 200_000,
			reasoning: true,
		};
		const signature = JSON.stringify({
			type: "reasoning",
			id: "rs_quote",
			encrypted_content: `cipher ${secret}`,
		});
		const opaque = JSON.stringify({ blob: secret });
		const encodedArguments = JSON.stringify({ command: `echo ${secret}` });
		expect(signature.includes(secret)).toBe(false);
		expect(opaque.includes(secret)).toBe(false);
		expect(encodedArguments.includes(secret)).toBe(false);

		const anthropic: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "clean plan", thinkingSignature: signature },
				{ type: "redactedThinking", data: opaque },
				{ type: "toolCall", id: "toolu_quote", name: "bash", arguments: { command: "echo ok" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: anthropicModel.id,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const bedrock: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `plan ${secret}`, thinkingSignature: "bedrock-sig" },
				{ type: "toolCall", id: "toolu_bedrock", name: "bash", arguments: { command: "echo ok" } },
			],
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			model: bedrockModel.id,
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		};
		const history: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "visible reply" }],
			api: "openai-responses",
			provider: "openai",
			model: responsesModel.id,
			usage,
			stopReason: "stop",
			timestamp: 3,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [
					{
						type: "reasoning",
						id: "rs_quote",
						summary: [{ type: "summary_text", text: `note ${secret}` }],
						encrypted_content: "enc-clean",
					},
					{
						type: "function_call",
						call_id: "call_quote",
						name: "bash",
						arguments: encodedArguments,
					},
				],
			},
		};

		const [obfuscatedAnthropic, obfuscatedBedrock, obfuscatedHistory] = obfuscateMessages(obfuscator, [
			anthropic,
			bedrock,
			history,
		]);
		if (obfuscatedAnthropic?.role !== "assistant") throw new Error("expected anthropic assistant");
		if (obfuscatedBedrock?.role !== "assistant") throw new Error("expected bedrock assistant");
		if (obfuscatedHistory?.role !== "assistant") throw new Error("expected history assistant");

		const anthropicWire = JSON.stringify(
			convertAnthropicMessages(
				[{ role: "user", content: "continue", timestamp: 1 }, obfuscatedAnthropic],
				anthropicModel,
				false,
			),
		);
		expect(anthropicWire).not.toContain(secret);
		expect(anthropicWire).not.toContain("rs_quote");
		expect(anthropicWire).not.toContain("redacted_thinking");
		expect(anthropicWire).toContain("toolu_quote");

		expect(JSON.stringify(obfuscatedBedrock)).not.toContain(secret);
		expect(JSON.stringify(obfuscatedBedrock)).not.toContain("bedrock-sig");
		const controller = new AbortController();
		controller.abort();
		const bedrockPayload = await Promise.race([
			new Promise<unknown>(resolve => {
				streamBedrock(
					bedrockModel,
					{ messages: [{ role: "user", content: "continue", timestamp: 1 }, obfuscatedBedrock] },
					{
						region: "us-east-1",
						signal: controller.signal,
						onPayload: captured => resolve(captured),
					},
				);
			}),
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("Bedrock replay payload was not captured")), 20_000);
			}),
		]);
		const bedrockWire = JSON.stringify(bedrockPayload);
		expect(bedrockWire).not.toContain(secret);
		expect(bedrockWire).not.toContain("bedrock-sig");
		expect(bedrockWire).toContain("toolu_bedrock");

		const historyItems = obfuscatedHistory.providerPayload?.items ?? [];
		expect(historyItems.some(item => item.type === "reasoning")).toBe(false);
		expect(JSON.stringify(historyItems)).not.toContain(secret);
		expect(JSON.stringify(historyItems)).toContain("call_quote");
		const historyCall = historyItems.find(item => item.type === "function_call");
		if (!historyCall || typeof historyCall.arguments !== "string")
			throw new Error("expected encoded function_call arguments");
		const decodedCommand = (JSON.parse(historyCall.arguments) as { command?: string }).command;
		expect(decodedCommand).not.toContain(secret);
		expect(decodedCommand).toContain("#GJC1_");
		expect(decodedCommand).not.toBe(`echo ${secret}`);
		const replayPayload = await Promise.race([
			new Promise<unknown>(resolve => {
				streamOpenAIResponses(
					responsesModel,
					{ messages: [{ role: "user", content: "continue", timestamp: 1 }, obfuscatedHistory] },
					{
						apiKey: "test-key",
						signal: controller.signal,
						onPayload: captured => resolve(captured),
					},
				);
			}),
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("OpenAI replay payload was not captured")), 20_000);
			}),
		]);
		const replayWire = JSON.stringify(replayPayload);
		expect(replayWire).not.toContain(secret);
		expect(replayWire).not.toContain("rs_quote");
		expect(replayWire).toContain("call_quote");
		const replayCall = findFunctionCallArguments(replayPayload, "call_quote");
		if (replayCall === undefined) throw new Error("expected replayed function_call arguments");
		const replayCommand = (JSON.parse(replayCall) as { command?: string }).command;
		expect(replayCommand).not.toContain(secret);
		expect(replayCommand).toContain("#GJC1_");
	});

	it("redacts a secret that is only a JSON object key and keeps an explicit self-replacement", () => {
		const keySecret = "SYNTHETIC_TOKEN_42";
		const keep = "keep-value";
		const hide = "hide-value";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: keySecret },
				{ type: "plain", content: keep, mode: "replace", replacement: keep },
				{ type: "plain", content: hide, mode: "replace", replacement: "safe-value" },
			],
			TEST_KEY,
		);
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const encodedKey = JSON.stringify({ [keySecret]: "ok" });
		expect(encodedKey.includes(keySecret)).toBe(true);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: `${keep} ${hide}` },
				{
					type: "toolCall",
					id: "call-key",
					name: "bash",
					arguments: { body: encodedKey, note: `${keep} ${hide}` },
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1-mini",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [
					{
						type: "function_call",
						call_id: "call_key",
						name: "bash",
						arguments: encodedKey,
					},
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: `see ${keySecret}` },
							{ type: "input_image", image_url: `data:image/png;base64,AAAA${keySecret}BBBB` },
						],
					},
				],
			},
		};
		const [obfuscated] = obfuscateMessages(obfuscator, [assistant]);
		if (obfuscated?.role !== "assistant") throw new Error("expected assistant");
		const text = obfuscated.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("expected text");
		expect(text.text).toBe(`${keep} safe-value`);
		const call = obfuscated.content.find(block => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("expected tool call");
		const decodedBody = JSON.parse(String(call.arguments.body)) as Record<string, string>;
		expect(Object.keys(decodedBody)).not.toContain(keySecret);
		expect(JSON.stringify(decodedBody)).not.toContain(keySecret);
		expect(decodedBody[Object.keys(decodedBody)[0] ?? ""]).toBe("ok");
		expect(call.arguments.note).toBe(`${keep} safe-value`);
		const items = obfuscated.providerPayload?.items ?? [];
		const historyCall = items.find(item => item.type === "function_call");
		if (!historyCall || typeof historyCall.arguments !== "string") throw new Error("expected history arguments");
		const historyBody = JSON.parse(historyCall.arguments) as Record<string, string>;
		expect(Object.keys(historyBody)).not.toContain(keySecret);
		expect(historyBody[Object.keys(historyBody)[0] ?? ""]).toBe("ok");
		const historyMessage = items.find(item => item.type === "message");
		const parts = (historyMessage?.content ?? []) as Array<{ type?: string; text?: string; image_url?: string }>;
		expect(parts.find(part => part.type === "input_text")?.text).not.toContain(keySecret);
		expect(parts.find(part => part.type === "input_image")?.image_url).toBe(
			`data:image/png;base64,AAAA${keySecret}BBBB`,
		);
	});

	it("redacts image-shaped semantic JSON and a thinking string that is the whole secret", () => {
		const leaf = "SYNTHETIC_TOKEN_42";
		const whole = JSON.stringify({ token: "SYNTHETIC" });
		const imageShaped = JSON.stringify({ type: "image", data: leaf });
		const imageUrl = `data:image/png;base64,AAAA${leaf}BBBB`;
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: leaf },
				{ type: "plain", content: whole },
			],
			TEST_KEY,
		);
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const anthropicModel: Model<"anthropic-messages"> = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.anthropic.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8_192,
			contextWindow: 200_000,
			reasoning: true,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: `visible ${whole}` },
				{
					type: "thinking",
					thinking: whole,
					summaryText: `note ${whole}`,
					rawText: imageShaped,
				},
				{
					type: "toolCall",
					id: "call-shaped",
					name: "bash",
					arguments: {
						payload: { type: "image", data: leaf },
						encoded: imageShaped,
						whole,
					},
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [
					{
						type: "function_call",
						call_id: "call_whole",
						name: "bash",
						arguments: whole,
					},
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: whole },
							{ type: "input_image", image_url: imageUrl, caption: whole },
							{ type: "output_image", image: { data: leaf } },
							{ type: "image", data: leaf, mimeType: "image/png", alt: `see ${leaf}` },
						],
					},
				],
			},
		};
		const user: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: whole },
				{ type: "image", data: leaf, mimeType: "image/png" },
			],
			timestamp: 2,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-shaped",
			toolName: "bash",
			content: [
				{ type: "text", text: `result ${whole}` },
				{ type: "image", data: leaf, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 3,
		};
		const [obfuscatedAssistant, obfuscatedUser, obfuscatedResult] = obfuscateMessages(obfuscator, [
			assistant,
			user,
			toolResult,
		]);
		if (obfuscatedAssistant?.role !== "assistant") throw new Error("expected assistant");
		if (obfuscatedUser?.role !== "user") throw new Error("expected user");
		if (obfuscatedResult?.role !== "toolResult") throw new Error("expected tool result");

		const text = obfuscatedAssistant.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("expected text");
		expect(text.text).not.toContain(whole);
		expect(text.text).toContain("#GJC1_");
		const thinking = obfuscatedAssistant.content.find(block => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("expected unsigned thinking");
		expect(thinking.thinking).toBe("{}");
		expect(JSON.parse(thinking.thinking)).toEqual({});
		expect(thinking.summaryText).not.toContain(whole);
		expect(thinking.rawText).not.toContain(leaf);
		expect(thinking.rawText).not.toContain(imageShaped);
		const call = obfuscatedAssistant.content.find(block => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("expected tool call");
		expect(call.id).toBe("call-shaped");
		expect(call.name).toBe("bash");
		const payload = call.arguments.payload as { type?: string; data?: string };
		expect(payload.type).toBe("image");
		expect(payload.data).not.toContain(leaf);
		expect(payload.data).toContain("#GJC1_");
		const decoded = JSON.parse(String(call.arguments.encoded)) as { data?: string };
		expect(decoded.data).not.toContain(leaf);
		expect(String(call.arguments.whole)).toBe("{}");
		expect(JSON.parse(String(call.arguments.whole))).toEqual({});

		const wire = JSON.stringify(
			convertAnthropicMessages(
				[{ role: "user", content: "continue", timestamp: 1 }, obfuscatedAssistant],
				anthropicModel,
				false,
			),
		);
		expect(wire).not.toContain(leaf);
		expect(wire).not.toContain(whole);
		expect(wire).toContain("call-shaped");

		const items = obfuscatedAssistant.providerPayload?.items ?? [];
		const historyCall = items.find(item => item.type === "function_call");
		if (!historyCall || typeof historyCall.arguments !== "string") throw new Error("expected history arguments");
		expect(historyCall.arguments).toBe("{}");
		expect(JSON.parse(historyCall.arguments)).toEqual({});
		const historyMessage = items.find(item => item.type === "message");
		const parts = (historyMessage?.content ?? []) as Array<{
			type?: string;
			text?: string;
			image_url?: string;
			caption?: string;
			image?: { data?: string };
			data?: string;
			alt?: string;
		}>;
		expect(parts.find(part => part.type === "input_text")?.text).not.toContain(whole);
		const inputImage = parts.find(part => part.type === "input_image");
		expect(inputImage?.image_url).toBe(imageUrl);
		expect(inputImage?.caption).not.toContain(whole);
		expect(parts.find(part => part.type === "output_image")?.image?.data).toBe(leaf);
		const historyImage = parts.find(part => part.type === "image");
		expect(historyImage?.data).toBe(leaf);
		expect(historyImage?.alt).not.toContain(leaf);

		if (!Array.isArray(obfuscatedUser.content)) throw new Error("expected user content");
		const userText = obfuscatedUser.content.find(block => block.type === "text");
		if (userText?.type !== "text") throw new Error("expected user text");
		expect(userText.text).not.toContain(whole);
		const userImage = obfuscatedUser.content.find(block => block.type === "image");
		if (userImage?.type !== "image") throw new Error("expected user image");
		expect(userImage.data).toBe(leaf);
		const resultText = obfuscatedResult.content.find(block => block.type === "text");
		if (resultText?.type !== "text") throw new Error("expected tool result text");
		expect(resultText.text).not.toContain(whole);
		const resultImage = obfuscatedResult.content.find(block => block.type === "image");
		if (resultImage?.type !== "image") throw new Error("expected tool result image");
		expect(resultImage.data).toBe(leaf);
	});

	it("scrubs string content and double-encoded secrets without breaking JSON arguments", () => {
		const quoted = 'quoted-"token"';
		const trigger = "SYNTHETIC_TRIGGER";
		const whole = JSON.stringify({ token: "SYNTHETIC" });
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: quoted },
				{ type: "plain", content: whole },
				{ type: "plain", content: trigger, mode: "replace", replacement: JSON.stringify(quoted) },
			],
			TEST_KEY,
		);
		const doubleKey = JSON.stringify({ [JSON.stringify(quoted)]: "ok" });
		expect(doubleKey.includes(quoted)).toBe(false);
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const encodedBody = JSON.stringify({ command: `echo ${quoted}` });
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: doubleKey, summaryText: trigger, rawText: `raw ${trigger}` },
				{
					type: "toolCall",
					id: "call-json",
					name: "bash",
					arguments: { body: encodedBody, token: quoted, whole, [quoted]: "ok" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [{ type: "function_call", call_id: "call_json", name: "bash", arguments: whole }],
			},
		};
		const user: UserMessage = { role: "user", content: `prompt ${quoted}`, timestamp: 2 };
		const developer: DeveloperMessage = { role: "developer", content: quoted, timestamp: 3 };
		const [obfuscatedAssistant, obfuscatedUser, obfuscatedDeveloper] = obfuscateMessages(obfuscator, [
			assistant,
			user,
			developer,
		]);
		if (obfuscatedAssistant?.role !== "assistant") throw new Error("expected assistant");
		if (obfuscatedUser?.role !== "user" || typeof obfuscatedUser.content !== "string") {
			throw new Error("expected string user content");
		}
		if (obfuscatedDeveloper?.role !== "developer" || typeof obfuscatedDeveloper.content !== "string") {
			throw new Error("expected string developer content");
		}
		expect(obfuscatedUser.content).not.toContain(quoted);
		expect(obfuscatedUser.content).toContain("#GJC1_");
		expect(obfuscatedDeveloper.content).not.toContain(quoted);
		const thinking = obfuscatedAssistant.content.find(block => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("expected thinking");
		expect(revealsSecret(thinking.thinking, quoted)).toBe(false);
		expect(revealsSecret(thinking.summaryText ?? "", quoted)).toBe(false);
		expect(revealsSecret(thinking.rawText ?? "", quoted)).toBe(false);
		const call = obfuscatedAssistant.content.find(block => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("expected tool call");
		expect(call.id).toBe("call-json");
		expect(call.name).toBe("bash");
		const decodedBody = JSON.parse(String(call.arguments.body)) as { command?: string };
		expect(decodedBody.command).not.toContain(quoted);
		expect(JSON.parse(String(call.arguments.whole))).toEqual({});
		const restored = obfuscator.deobfuscateObject(call.arguments);
		expect(restored.token).toBe(quoted);
		expect(restored[quoted]).toBe("ok");
		const restoredBody = JSON.parse(String(restored.body)) as { command?: string };
		expect(restoredBody.command).toBe(`echo ${quoted}`);
		const historyCall = obfuscatedAssistant.providerPayload?.items?.find(item => item.type === "function_call");
		if (!historyCall || typeof historyCall.arguments !== "string") throw new Error("expected history arguments");
		expect(JSON.parse(historyCall.arguments)).toEqual({});
	});

	it("preserves unsafe JSON integers and does not treat escapes as literal secrets", () => {
		const leaf = "SYNTHETIC_TOKEN_42";
		const slashN = String.raw`SYNTHETIC_\nTOKEN`;
		const newlineValue = "SYNTHETIC_\nTOKEN";
		expect(slashN).not.toBe(newlineValue);
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: leaf },
				{ type: "plain", content: slashN },
			],
			TEST_KEY,
		);
		const integer = "9007199254740993";
		const body = `{"id":${integer},"token":"${leaf}"}`;
		const escaped = JSON.stringify({ [newlineValue]: newlineValue });
		expect(escaped.includes(slashN)).toBe(true);
		const literal = JSON.stringify({ v: slashN });
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-json-fidelity",
					name: "bash",
					arguments: { body, escaped, literal },
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1-mini",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [{ type: "function_call", call_id: "call_fidelity", name: "bash", arguments: body }],
			},
		};
		const [obfuscated] = obfuscateMessages(obfuscator, [assistant]);
		if (obfuscated?.role !== "assistant") throw new Error("expected assistant");
		const call = obfuscated.content.find(block => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("expected tool call");
		expect(String(call.arguments.body)).toContain(integer);
		expect(String(call.arguments.body)).not.toContain(leaf);
		expect(String(call.arguments.escaped)).toBe(escaped);
		expect(JSON.parse(String(call.arguments.escaped))[newlineValue]).toBe(newlineValue);
		const literalValue = JSON.parse(String(call.arguments.literal)).v;
		expect(literalValue).not.toContain(slashN);
		expect(literalValue).toContain("#GJC1_");
		const restored = obfuscator.deobfuscateObject(call.arguments);
		expect(String(restored.body)).toContain(integer);
		expect(String(restored.body)).toContain(leaf);
		expect(JSON.parse(String(restored.literal)).v).toBe(slashN);
		expect(JSON.parse(String(restored.escaped))[newlineValue]).toBe(newlineValue);
		const historyCall = obfuscated.providerPayload?.items?.find(item => item.type === "function_call");
		if (!historyCall || typeof historyCall.arguments !== "string") throw new Error("expected history arguments");
		expect(historyCall.arguments).toContain(integer);
		expect(historyCall.arguments).not.toContain(leaf);
		expect(JSON.parse(historyCall.arguments).id.toString()).not.toBe(integer);
		expect(historyCall.arguments.includes(integer)).toBe(true);
		const pin = "123456789";
		const pinObfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: pin, mode: "replace", replacement: "MASKED_PIN" },
				{ type: "plain", content: leaf, mode: "replace", replacement: "MASKED_TOKEN" },
			],
			TEST_KEY,
		);
		const pinDocument = `{"pin":${pin},"note":"${leaf}"}`;
		const pinUser: UserMessage = { role: "user", content: pinDocument, timestamp: 4 };
		const k1 = String.raw`{"token":"${leaf}","path":"a\/b"}`;
		const k2 = `{"token":"${leaf}","path":"a/b"}`;
		expect(k1).not.toBe(k2);
		const keyed: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-keys", name: "bash", arguments: { [k1]: "left", [k2]: "right" } }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1-mini",
			usage,
			stopReason: "toolUse",
			timestamp: 5,
		};
		const [obfuscatedPin] = obfuscateMessages(pinObfuscator, [pinUser]);
		const [obfuscatedKeys] = obfuscateMessages(obfuscator, [keyed]);
		if (obfuscatedPin?.role !== "user" || typeof obfuscatedPin.content !== "string") {
			throw new Error("expected pin user");
		}
		expect(obfuscatedPin.content).not.toContain(pin);
		expect(obfuscatedPin.content).not.toContain(leaf);
		expect(obfuscatedPin.content).toContain("MASKED_PIN");
		expect(obfuscatedPin.content).toContain("MASKED_TOKEN");
		expect(JSON.parse(obfuscatedPin.content).pin).toBe("MASKED_PIN");
		if (obfuscatedKeys?.role !== "assistant") throw new Error("expected keyed assistant");
		const keyedCall = obfuscatedKeys.content.find(block => block.type === "toolCall");
		if (keyedCall?.type !== "toolCall") throw new Error("expected keyed call");
		const restoredKeys = obfuscator.deobfuscateObject(keyedCall.arguments);
		expect(restoredKeys[k1]).toBe("left");
		expect(restoredKeys[k2]).toBe("right");
	});

	it("drops a nested JSON secret that remains after another field is replaced", () => {
		const credential = '{"token":"SYNTHETIC_CREDENTIAL"}';
		const note = "SYNTHETIC_NOTE";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: credential },
				{ type: "plain", content: note, mode: "replace", replacement: "SAFE_NOTE" },
			],
			TEST_KEY,
		);
		const document = `{"credential":{"token":"SYNTHETIC_CREDENTIAL"},"note":"${note}"}`;
		expect(document.includes(credential)).toBe(true);
		const user: UserMessage = { role: "user", content: document, timestamp: 1 };
		const developer: DeveloperMessage = { role: "developer", content: document, timestamp: 2 };
		const [obfuscatedUser, obfuscatedDeveloper] = obfuscateMessages(obfuscator, [user, developer]);
		if (obfuscatedUser?.role !== "user" || typeof obfuscatedUser.content !== "string") {
			throw new Error("expected user string");
		}
		if (obfuscatedDeveloper?.role !== "developer" || typeof obfuscatedDeveloper.content !== "string") {
			throw new Error("expected developer string");
		}
		for (const content of [obfuscatedUser.content, obfuscatedDeveloper.content]) {
			expect(content).not.toContain(credential);
			expect(content).not.toContain("SYNTHETIC_CREDENTIAL");
			expect(JSON.parse(content)).toEqual({});
		}
	});
});

function revealsSecret(value: unknown, secret: string, depth = 0): boolean {
	if (typeof value === "string") {
		if (value.includes(secret)) return true;
		if (depth >= 4 || value.length < 2) return false;
		const first = value.trim()[0];
		if (first !== "{" && first !== "[" && first !== '"') return false;
		try {
			return revealsSecret(JSON.parse(value), secret, depth + 1);
		} catch {
			return false;
		}
	}
	if (Array.isArray(value)) return value.some(item => revealsSecret(item, secret, depth));
	if (value !== null && typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).some(
			([key, item]) => revealsSecret(key, secret, depth) || revealsSecret(item, secret, depth),
		);
	}
	return false;
}

function findFunctionCallArguments(payload: unknown, callId: string): string | undefined {
	const stack: unknown[] = [payload];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			stack.push(...current);
			continue;
		}
		const record = current as Record<string, unknown>;
		if (record.type === "function_call" && record.call_id === callId && typeof record.arguments === "string") {
			return record.arguments;
		}
		for (const value of Object.values(record)) stack.push(value);
	}
	return undefined;
}
