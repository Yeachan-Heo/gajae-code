import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentState } from "@gajae-code/agent-core";
import { exportFromFile, exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const API_KEY = "sk-htmlExportFakeKey1234";
const GITHUB_TOKEN = "ghp_htmlExportFakeToken123456";
const ORDINARY_SENTENCE = "The harbor ferry leaves at noon.";
const QUOTED_SENTENCE = 'he said "hello" and walked on';

function embeddedSessionText(html: string): string {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	if (!match?.[1]) throw new Error("HTML export is missing embedded session data");
	return Buffer.from(match[1], "base64").toString("utf8");
}

function stateWith(systemPrompt: string, toolDescription: string): AgentState {
	return {
		systemPrompt: [systemPrompt],
		tools: [{ name: "echo", description: toolDescription }],
	} as unknown as AgentState;
}

describe("session HTML export embed", () => {
	it("scrubs credential-shaped text from the embedded session", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-scrub-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "user",
				content: `${ORDINARY_SENTENCE} ${API_KEY} ${GITHUB_TOKEN}`,
				timestamp: 1,
			});
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, stateWith(`system ${API_KEY}`, `tool ${GITHUB_TOKEN}`), { outputPath });
			const html = await Bun.file(outputPath).text();
			const embedded = embeddedSessionText(html);
			const parsed = JSON.parse(embedded) as {
				systemPrompt?: string;
				tools?: Array<{ description?: string }>;
			};
			expect(html).not.toContain(API_KEY);
			expect(html).not.toContain(GITHUB_TOKEN);
			expect(embedded).not.toContain(API_KEY);
			expect(embedded).not.toContain(GITHUB_TOKEN);
			expect(embedded).toContain("«redacted-api-key»");
			expect(embedded).toContain("«redacted-github-token»");
			expect(embedded).toContain(ORDINARY_SENTENCE);
			expect(parsed.systemPrompt).toContain("«redacted-api-key»");
			expect(parsed.tools?.[0]?.description).toContain("«redacted-github-token»");
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("scrubs a labeled secret that contains a quotation mark", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-quote-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "user",
				content: 'password=abcdefgh"suffix',
				timestamp: 1,
			});
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			const parsed = JSON.parse(embedded) as { entries: Array<{ message?: { content?: string } }> };
			const content = JSON.stringify(parsed);
			expect(content).not.toContain("abcdefgh");
			expect(content).toContain("suffix");
			expect(content).toContain("«redacted»");
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("scrubs a nested password field in a tool-call argument", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-key-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "echo",
						arguments: { password: "abcdefgh1234", note: ORDINARY_SENTENCE },
					},
				],
				timestamp: 1,
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			expect(embedded).not.toContain("abcdefgh1234");
			expect(embedded).toContain("«redacted»");
			expect(embedded).toContain(ORDINARY_SENTENCE);
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("scrubs a short value under a password key", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-key-short-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-short",
						name: "echo",
						arguments: { password: "abc123", note: ORDINARY_SENTENCE },
					},
				],
				timestamp: 1,
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			expect(embedded).not.toContain("abc123");
			expect(embedded).toContain("«redacted»");
			expect(embedded).toContain(ORDINARY_SENTENCE);
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("masks a password field that is not a string", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-key-typed-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-typed",
						name: "echo",
						arguments: {
							password: 123456,
							wrapped: { password: ["abc123"] },
							count: 7,
							tags: ["public"],
							meta: { visible: true },
						},
					},
				],
				timestamp: 1,
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			const parsed = JSON.parse(embedded) as {
				entries: Array<{ message?: { content?: Array<{ arguments?: Record<string, unknown> }> } }>;
			};
			const args = parsed.entries[0]?.message?.content?.[0]?.arguments;
			expect(embedded).not.toContain("123456");
			expect(embedded).not.toContain("abc123");
			expect(args?.password).toBe("«redacted»");
			expect(args?.count).toBe(7);
			expect(args?.tags).toEqual(["public"]);
			expect(args?.meta).toEqual({ visible: true });
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("scrubs a nested password field that contains a quotation mark", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-key-quote-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-2",
						name: "echo",
						arguments: { password: 'abcdefgh"suffix', note: QUOTED_SENTENCE },
					},
				],
				timestamp: 1,
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			const parsed = JSON.parse(embedded) as { entries: unknown[] };
			expect(embedded).not.toContain("abcdefgh");
			expect(embedded).toContain("«redacted»");
			expect(parsed.entries.length).toBeGreaterThan(0);
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("masks a password field when the quotation mark is early", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-key-early-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-3",
						name: "echo",
						arguments: { password: 'abc"defghijkl1234', note: QUOTED_SENTENCE },
					},
				],
				timestamp: 1,
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			const outputPath = path.join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			const parsed = JSON.parse(embedded) as {
				entries: Array<{ message?: { content?: Array<{ arguments?: { note?: string } }> } }>;
			};
			expect(embedded).not.toContain("defghijkl1234");
			expect(embedded).toContain("«redacted»");
			expect(parsed.entries[0]?.message?.content?.[0]?.arguments?.note).toBe(QUOTED_SENTENCE);
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an ordinary message that contains a quotation mark", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-plain-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "user",
				content: QUOTED_SENTENCE,
				timestamp: 1,
			});
			const outputPath = path.join(tempDir, "export.html");
			const prompt = 'prompt says "ready"';
			await exportSessionToHtml(session, stateWith(prompt, "prints text"), { outputPath });
			const embedded = embeddedSessionText(await Bun.file(outputPath).text());
			const parsed = JSON.parse(embedded) as {
				entries: Array<{ message?: { content?: string } }>;
				systemPrompt?: string;
				tools?: Array<{ name?: string; description?: string }>;
			};
			expect(parsed.entries.some(entry => entry.message?.content === QUOTED_SENTENCE)).toBe(true);
			expect(parsed.systemPrompt).toBe(prompt);
			expect(parsed.tools?.[0]?.name).toBe("echo");
			expect(parsed.tools?.[0]?.description).toBe("prints text");
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an own __proto__ field from the session header", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-html-export-proto-"));
		let session: SessionManager | undefined;
		try {
			session = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
			session.appendMessage({
				role: "user",
				content: ORDINARY_SENTENCE,
				timestamp: 1,
			});
			await session.ensureOnDisk();
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("session file missing");
			const raw = await Bun.file(sessionFile).text();
			await session.close();
			session = undefined;
			const nl = raw.indexOf("\n");
			const headerJson = raw.slice(0, nl);
			JSON.parse(headerJson);
			const protoField = `${JSON.stringify("__proto__")}:{"marker":"kept-proto-field"}`;
			const copy = path.join(tempDir, "session.jsonl");
			await Bun.write(copy, `${headerJson.slice(0, -1)},${protoField}}${raw.slice(nl)}`);
			const outputPath = path.join(tempDir, "export.html");
			await exportFromFile(copy, { outputPath });
			const parsed = JSON.parse(embeddedSessionText(await Bun.file(outputPath).text())) as {
				header?: Record<string, unknown>;
			};
			expect(JSON.stringify(parsed.header)).toContain(protoField);
		} finally {
			await session?.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
