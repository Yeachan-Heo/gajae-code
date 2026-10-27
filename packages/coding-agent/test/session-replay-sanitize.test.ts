import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadCorpusManifest,
	type SessionJsonlEntry,
	sha256Hex,
	toolCallSequence,
} from "../bench/session-replay/corpus.js";
import { isStructuralStringKey, SANITIZER_VERSION, sanitizeSession } from "../bench/session-replay/sanitize.js";

const fixtureRoot = "/r";
const corpusDir = path.resolve(import.meta.dir, "../bench/session-replay/corpus");
const WORD_PATTERN = /[\p{L}\p{N}]{6,}/gu;

function collectPrivacyWords(
	value: unknown,
	key: string,
	parentType: unknown,
	insideArguments: boolean,
	words: Set<string>,
): void {
	if (typeof value === "string") {
		if (key === "arguments" && !insideArguments) {
			try {
				collectPrivacyWords(JSON.parse(value) as unknown, key, parentType, true, words);
				return;
			} catch {
				// Invalid JSON arguments are free text.
			}
		}
		if (isStructuralStringKey(key, parentType, value, insideArguments)) return;
		WORD_PATTERN.lastIndex = 0;
		for (const match of value.matchAll(WORD_PATTERN)) {
			if (match[0] !== undefined) words.add(match[0]);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPrivacyWords(item, key, parentType, insideArguments, words);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	const nextInsideArguments = insideArguments || key === "arguments";
	for (const [childKey, childValue] of Object.entries(record)) {
		collectPrivacyWords(childValue, childKey, record.type, nextInsideArguments, words);
	}
}

function privacyWords(jsonl: string): Set<string> {
	const words = new Set<string>();
	for (const line of jsonl.split(/\r?\n/)) {
		if (line.trim().length > 0) collectPrivacyWords(JSON.parse(line) as unknown, "", undefined, false, words);
	}
	return words;
}

function parseEntries(jsonl: string): SessionJsonlEntry[] {
	const entries: SessionJsonlEntry[] = [];
	for (const line of jsonl.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("Invalid test JSONL entry");
		const value = parsed as Record<string, unknown>;
		if (typeof value.type !== "string") throw new Error("Invalid test JSONL type");
		entries.push({ type: value.type, message: value.message });
	}
	return entries;
}

function firstMessageText(jsonl: string): string {
	for (const entry of parseEntries(jsonl)) {
		if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const block = message.content.find(item => typeof item === "object" && item !== null && "text" in item);
		if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string")
			return block.text;
	}
	throw new Error("User text not found in sanitized session");
}

function sessionJsonl(message: unknown): string {
	return `${[
		JSON.stringify({
			type: "session",
			version: 3,
			id: "session-test",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/private/worktree",
			title: "Private session title",
		}),
		JSON.stringify({
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message,
		}),
	].join("\n")}\n`;
}

describe("session replay sanitizer", () => {
	it("is deterministic for identical content and seed", () => {
		const raw = sessionJsonl({
			role: "user",
			content: [{ type: "text", text: "Same deterministic message content." }],
		});
		const first = sanitizeSession(raw, { seed: "deterministic-seed", fixtureRoot });
		const second = sanitizeSession(raw, { seed: "deterministic-seed", fixtureRoot });
		expect(first).toEqual(second);
		expect(first.jsonl).not.toContain("Same deterministic message content.");
		const sanitizedHeader = JSON.parse(first.jsonl.split("\n")[0] ?? "{}") as { cwd?: string; title?: string };
		expect(sanitizedHeader.cwd).toBe(fixtureRoot);
		expect(sanitizedHeader.title).not.toBe("Private session title");
	});

	it("preserves UTF-16 length, newline positions, and character script classes", () => {
		const original = "AaZz09 !\n漢字中\n한글😀e\u0301";
		const raw = sessionJsonl({ role: "user", content: [{ type: "text", text: original }] });
		const sanitized = firstMessageText(sanitizeSession(raw, { seed: "script-class-seed", fixtureRoot }).jsonl);
		expect(sanitized.length).toBe(original.length);
		expect(
			[...sanitized].map((character, index) => (character === "\n" ? index : -1)).filter(index => index >= 0),
		).toEqual([...original].map((character, index) => (character === "\n" ? index : -1)).filter(index => index >= 0));
		expect(sanitized.split("\n").map(line => line.length)).toEqual(original.split("\n").map(line => line.length));

		const before = [...original];
		const after = [...sanitized];
		expect(after).toHaveLength(before.length);
		for (let index = 0; index < before.length; index++) {
			const source = before[index];
			const output = after[index];
			if (source === undefined || output === undefined) throw new Error("Character comparison failed");
			if (/^[A-Z]$/.test(source)) expect(output).toMatch(/^[A-Z]$/);
			else if (/^[a-z]$/.test(source)) expect(output).toMatch(/^[a-z]$/);
			else if (/^[0-9]$/.test(source)) expect(output).toMatch(/^[0-9]$/);
			else if (/^[\u4e00-\u9fff]$/.test(source)) {
				expect(output.codePointAt(0)).toBeGreaterThanOrEqual(0x4e00);
				expect(output.codePointAt(0)).toBeLessThanOrEqual(0x9fff);
			} else if (/^[\uac00-\ud7af]$/.test(source)) {
				expect(output.codePointAt(0)).toBeGreaterThanOrEqual(0xac00);
				expect(output.codePointAt(0)).toBeLessThanOrEqual(0xd7af);
			} else if (source === "😀") expect(output.length).toBe(2);
			else if (source === "\u0301") expect(/\p{M}/u.test(output)).toBe(true);
			else expect(output).toBe(source);
		}
		expect(sanitized).toContain("\n");
	});

	it("rewrites repeated paths stably under fixtureRoot and keeps extensions", () => {
		const originalPath = "/Users/private/project/src/private-module.tsx";
		const raw = sessionJsonl({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: originalPath, paths: [originalPath], file: originalPath },
				},
				{
					type: "toolCall",
					id: "call-2",
					name: "glob",
					arguments: { pattern: "/Users/private/project/src/**/*.tsx" },
				},
			],
		});
		const first = sanitizeSession(raw, { seed: "path-seed", fixtureRoot });
		const second = sanitizeSession(raw, { seed: "path-seed", fixtureRoot });
		const entries = parseEntries(first.jsonl);
		const message = entries.find(entry => entry.type === "message")?.message as {
			content: Array<{ arguments: Record<string, unknown> }>;
		};
		const firstArgs = message.content[0]?.arguments;
		const globArgs = message.content[1]?.arguments;
		const rewritten = firstArgs?.path;
		expect(typeof rewritten).toBe("string");
		expect(rewritten).toStartWith(`${fixtureRoot}${path.sep}`);
		expect(path.extname(rewritten as string)).toBe(".tsx");
		expect(firstArgs?.paths).toEqual([rewritten]);
		expect(firstArgs?.file).toBe(rewritten);
		expect(globArgs?.pattern).toStartWith(`${fixtureRoot}${path.sep}`);
		expect(path.extname(globArgs?.pattern as string)).toBe(".tsx");
		expect(first.jsonl).toBe(second.jsonl);
		expect(first.jsonl).not.toContain(originalPath);
		expect(first.jsonl).toContain(`${fixtureRoot}${path.sep}`);
	});

	it("preserves assistant tool-call name order and sequence hash", () => {
		const raw = sessionJsonl({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/private/a.ts" } },
				{ type: "text", text: "Private explanation." },
				{
					type: "toolCall",
					id: "call-2",
					name: "edit",
					arguments: { path: "/private/b.ts", oldText: "private source" },
				},
			],
		});
		const before = toolCallSequence(parseEntries(raw));
		const after = toolCallSequence(
			parseEntries(sanitizeSession(raw, { seed: "tool-sequence-seed", fixtureRoot }).jsonl),
		);
		expect(after).toEqual(before);
		expect(sha256Hex(JSON.stringify(after))).toBe(sha256Hex(JSON.stringify(before)));
	});

	it("removes the seeded privacy canary from user text, tool arguments, tool results, and nested custom state", () => {
		const canary = "GJC-PRIVACY-CANARY-7f3a";
		const raw = `${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "canary-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/private/worktree",
			}),
			JSON.stringify({
				type: "message",
				id: "canary-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: `Please inspect ${canary} carefully.` }] },
			}),
			JSON.stringify({
				type: "message",
				id: "canary-call",
				parentId: "canary-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "search",
							arguments: { query: canary, nested: { text: canary } },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "canary-result",
				parentId: "canary-call",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "search",
					content: [{ type: "text", text: `Result for ${canary} contains private data.` }],
					isError: false,
				},
			}),
			JSON.stringify({
				type: "custom",
				id: "canary-state",
				parentId: "canary-result",
				timestamp: "2026-01-01T00:00:04.000Z",
				customType: "state",
				data: {
					nested: {
						reason: `${canary} clear low-risk prompt stays on direct implementation path`,
						statement: `Statement ${canary}`,
						route: `Route rationale ${canary}`,
						promptPreview: `Prompt preview ${canary}`,
						evidence: `Evidence record ${canary}`,
					},
				},
			}),
		].join("\n")}\n`;
		const sanitized = sanitizeSession(raw, { seed: "canary-sanitizer-seed", fixtureRoot });
		const sourceWords = privacyWords(raw);
		const outputWords = privacyWords(sanitized.jsonl);
		expect(sourceWords).toContain("PRIVACY");
		expect(sourceWords).toContain("CANARY");
		for (const word of sourceWords) expect(outputWords.has(word)).toBe(false);
		expect(sanitized.jsonl).not.toContain(canary);
		expect(sanitized.redactionNotes).toContain("redacted");
	});

	it("preserves ANSI escape sequences while sanitizing their surrounding text", () => {
		const raw = sessionJsonl({ role: "user", content: [{ type: "text", text: "\u001b[31mprivate words\u001b[0m" }] });
		const sanitized = firstMessageText(sanitizeSession(raw, { seed: "ansi-seed", fixtureRoot }).jsonl);
		expect(sanitized).toStartWith("\u001b[31m");
		expect(sanitized).toEndWith("\u001b[0m");
		expect(sanitized).not.toContain("private words");
	});
	it("replaces image content with a text placeholder that records the byte length", () => {
		const raw = sessionJsonl({ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
		const sanitized = sanitizeSession(raw, { seed: "image-seed", fixtureRoot });
		expect(sanitized.jsonl).not.toContain("aGVsbG8=");
		expect(sanitized.jsonl).toContain("binary content removed: 5 bytes");
	});

	it("matches committed corpus manifest bytes and tool-call sequence hashes", async () => {
		const manifest = await loadCorpusManifest(corpusDir);
		expect(manifest.schema).toBe("gjc.session-replay-corpus/1");
		expect(manifest.sanitizerVersion).toBe(SANITIZER_VERSION);
		expect(manifest.entries.length).toBeGreaterThanOrEqual(4);
		const realEntries = manifest.entries.filter(entry => entry.sourceClass === "sanitized-real");
		expect(realEntries.length).toBeGreaterThanOrEqual(3);
		expect(realEntries.some(entry => entry.assistantTurns >= 50)).toBe(true);
		expect(
			realEntries.some(
				entry =>
					entry.toolCalls >= 20 &&
					entry.toolKinds.includes("read") &&
					entry.toolKinds.includes("edit") &&
					entry.toolKinds.includes("bash") &&
					(entry.toolKinds.includes("grep") || entry.toolKinds.includes("search")),
			),
		).toBe(true);
		expect(realEntries.some(entry => entry.hasCompaction)).toBe(true);
		expect(manifest.entries.some(entry => entry.sourceClass === "synthetic")).toBe(true);
		for (const entry of manifest.entries) {
			if (entry.sourceClass !== "sanitized-real") continue;
			const checkedWords = entry.redactionNotes.match(/privacy scan checked (\d+)\/(\d+) distinct words/);
			expect(Number(checkedWords?.[1] ?? 0)).toBeGreaterThanOrEqual(200);
			expect(Number(checkedWords?.[2] ?? 0)).toBeGreaterThanOrEqual(Number(checkedWords?.[1] ?? 0));
		}
		for (const entry of manifest.entries) {
			const jsonl = await Bun.file(path.join(corpusDir, entry.file)).text();
			expect(jsonl).not.toContain(os.homedir());
			const header = JSON.parse(jsonl.split("\n")[0] ?? "{}") as { cwd?: string };
			expect(header.cwd).toBe("/r");
			const entries = parseEntries(jsonl);
			expect(new TextEncoder().encode(jsonl).byteLength).toBe(entry.bytes);
			expect(sha256Hex(JSON.stringify(toolCallSequence(entries)))).toBe(entry.toolCallSeqSha256);
		}
	});
});
