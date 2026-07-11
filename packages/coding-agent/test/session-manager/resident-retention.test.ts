import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, Message, ProviderPayload, TextContent } from "@gajae-code/ai";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
} from "@gajae-code/coding-agent/session/session-storage";
import { getAgentDir, getBlobsDir, setAgentDir } from "@gajae-code/utils";

const LARGE_TEXT = "T".repeat(700_000);
const LARGE_IMAGE = Buffer.alloc(180_000, 7).toString("base64");
const LARGE_PROVIDER_IMAGE_URL = `data:image/png;base64,${Buffer.alloc(180_000, 9).toString("base64")}`;
const LARGE_PROVIDER_OBJECT_IMAGE_URL = `data:image/png;base64,${Buffer.alloc(180_000, 10).toString("base64")}`;
const LARGE_PROVIDER_OBJECT_SIBLING = `${"object-image-url-sibling".repeat(40_000)}UNIQUE_OBJECT_IMAGE_URL_TAIL`;
const TRUNCATION_NOTICE = "[Session persistence truncated large content]";
const BLOB_REF = "blob:sha256:";
const SAME_BYTES = Buffer.from("same bytes for text and image".repeat(30_000));
const SAME_BYTES_TEXT = SAME_BYTES.toString("utf8");
const SAME_BYTES_IMAGE = SAME_BYTES.toString("base64");
const HISTORICAL_IMAGE_BYTES = Buffer.alloc(180_000, 11);
const HISTORICAL_IMAGE = HISTORICAL_IMAGE_BYTES.toString("base64");
const HISTORICAL_PROVIDER_IMAGE_URL = `data:image/png;base64,${Buffer.alloc(180_000, 13).toString("base64")}`;
const ORIGINAL_AGENT_DIR = getAgentDir();
let tempAgentDir: string | undefined;

function isolateBlobDir(): void {
	if (!tempAgentDir) tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-blob-regression-"));
	setAgentDir(tempAgentDir);
}

function blobFiles(): string[] {
	const blobsDir = getBlobsDir();
	if (!fs.existsSync(blobsDir)) return [];
	return fs.readdirSync(blobsDir).map(name => path.join(blobsDir, name));
}

afterEach(() => {
	setAgentDir(ORIGINAL_AGENT_DIR);
	if (tempAgentDir) {
		fs.rmSync(tempAgentDir, { recursive: true, force: true });
		tempAgentDir = undefined;
	}
});

function assistantMessage(
	content: Extract<Message, { role: "assistant" }>["content"] = [{ type: "text", text: "ok" }],
): Message {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			premiumRequests: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function largeUserMessage(): Message {
	return {
		role: "user",
		content: [
			{ type: "text", text: LARGE_TEXT },
			{ type: "image", data: LARGE_IMAGE, mimeType: "image/png" },
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [
				{ type: "message", role: "user", content: [{ type: "input_image", image_url: LARGE_PROVIDER_IMAGE_URL }] },
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: { url: LARGE_PROVIDER_OBJECT_IMAGE_URL, detail: LARGE_PROVIDER_OBJECT_SIBLING },
						},
					],
				},
			],
		} satisfies ProviderPayload,
		timestamp: 1,
	};
}

function residentJson(session: SessionManager): string {
	return JSON.stringify(session.captureState().fileEntries);
}

function expectResidentBounded(session: SessionManager): void {
	const json = residentJson(session);
	expect(json).toContain(BLOB_REF);
	expect(json).not.toContain(LARGE_TEXT.slice(0, 100));
	expect(json).not.toContain(LARGE_IMAGE.slice(0, 100));
	expect(json).not.toContain(LARGE_PROVIDER_IMAGE_URL.slice(0, 100));
	expect(json).not.toContain(LARGE_PROVIDER_OBJECT_IMAGE_URL.slice(0, 100));
	expect(json).not.toContain(LARGE_PROVIDER_OBJECT_SIBLING.slice(0, 100));
	expect(json.length).toBeLessThan(20_000);
}

async function persistedText(session: SessionManager, storage: MemorySessionStorage): Promise<string> {
	await session.flush();
	return storage.readTextSync(session.getSessionFile()!);
}

class ThrowingWriterStorage extends MemorySessionStorage {
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = super.openWriter(path, options);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: () => {
				throw new Error("sync persist failed");
			},
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

class ThrowingRewriteStorage extends MemorySessionStorage {
	shouldThrowSyncWrite = false;

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = super.openWriter(path, options);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => {
				if (this.shouldThrowSyncWrite && path.includes(".tmp")) throw new Error("sync rewrite failed");
				writer.writeLineSync(line);
			},
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			close: () => writer.close(),
			closeSync: () => writer.closeSync(),
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}
class RenameFailRewriteStorage extends MemorySessionStorage {
	failTempRename = false;
	failTargetWrite = false;

	writeTextSync(target: string, content: string): void {
		if (this.failTargetWrite && target.endsWith(".jsonl")) {
			super.writeTextSync(target, "");
			throw new Error("target write truncated");
		}
		super.writeTextSync(target, content);
	}

	rename(source: string, target: string): Promise<void> {
		if (this.failTempRename && source.includes(".tmp") && target.endsWith(".jsonl")) {
			return Promise.reject(new Error(`rename failed: ${source} -> ${target}`));
		}
		return super.rename(source, target);
	}

	renameSync(source: string, target: string): void {
		if (this.failTempRename && source.includes(".tmp") && target.endsWith(".jsonl")) {
			throw new Error(`rename failed: ${source} -> ${target}`);
		}
		super.renameSync(source, target);
	}
}

class FsCodeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

class RenameEpermSyncStorage extends MemorySessionStorage {
	failNextSessionReplace = false;
	backupCleanupPath: string | undefined;

	renameSync(source: string, target: string): void {
		if (
			this.failNextSessionReplace &&
			source.includes(".tmp") &&
			target.endsWith(".jsonl") &&
			this.existsSync(target)
		) {
			this.failNextSessionReplace = false;
			throw new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${target}'`);
		}
		return super.renameSync(source, target);
	}

	unlinkSync(target: string): void {
		if (target.endsWith(".bak")) {
			this.backupCleanupPath = target;
		}
		return super.unlinkSync(target);
	}
}

describe("SessionManager resident retention boundaries", () => {
	it("keeps resident entries bounded after fresh large appends while readers materialize full content and JSONL stays capped text", async () => {
		isolateBlobDir();
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const small = { role: "user" as const, content: "small exact", timestamp: 0 };
		session.appendMessage(small);
		session.appendMessage(assistantMessage());
		const before = await persistedText(session, storage);

		const largeId = session.appendMessage(largeUserMessage());
		session.appendMessage(assistantMessage());
		const persisted = await persistedText(session, storage);

		expectResidentBounded(session);
		expect(persisted).toContain(BLOB_REF);
		expect(persisted).toContain(TRUNCATION_NOTICE);
		expect(persisted).toContain(LARGE_TEXT.slice(0, 100));
		expect(persisted).not.toContain(LARGE_IMAGE.slice(0, 100));
		expect(persisted).not.toContain(LARGE_PROVIDER_IMAGE_URL.slice(0, 100));
		expect(persisted).not.toContain(LARGE_PROVIDER_OBJECT_IMAGE_URL.slice(0, 100));
		expect(persisted).not.toContain(LARGE_PROVIDER_OBJECT_SIBLING.slice(-100));
		expect(blobFiles()).toHaveLength(3);
		expect(blobFiles().some(file => fs.readFileSync(file, "utf8").includes(LARGE_TEXT.slice(-100)))).toBe(false);
		expect(before).toContain(JSON.stringify(small));

		const entry = session.getEntry(largeId);
		expect(entry?.type).toBe("message");
		const message = entry?.type === "message" ? entry.message : undefined;
		expect(JSON.stringify(message)).toContain(LARGE_TEXT);
		expect(JSON.stringify(message)).toContain(LARGE_IMAGE);
		expect(JSON.stringify(message)).toContain(LARGE_PROVIDER_IMAGE_URL);
		expect(JSON.stringify(message)).toContain(LARGE_PROVIDER_OBJECT_IMAGE_URL);
		expect(JSON.stringify(message)).toContain(LARGE_PROVIDER_OBJECT_SIBLING);
		expect(JSON.stringify(session.buildSessionContext().messages)).toContain(LARGE_TEXT);
	});

	it("re-externalizes branch residents after creating a branch from a large-output path", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const largeId = session.appendMessage(largeUserMessage());
		session.appendMessage(assistantMessage());

		const branchFile = session.createBranchedSession(largeId);
		expect(branchFile).toBeString();
		expectResidentBounded(session);
		const entry = session.getEntry(largeId);
		expect(JSON.stringify(entry)).toContain(LARGE_TEXT);
		expect(storage.readTextSync(branchFile!)).toContain(BLOB_REF);
	});

	it("resolves historical persisted blob refs before bounding residents and materializing readers", async () => {
		isolateBlobDir();
		const storage = new MemorySessionStorage();
		const imageRef = (await SessionManager.create("/cwd", "/sessions", storage).putBlob(HISTORICAL_IMAGE_BYTES)).ref;
		const providerRef = (
			await SessionManager.create("/cwd", "/sessions", storage).putBlob(
				Buffer.from(HISTORICAL_PROVIDER_IMAGE_URL, "utf8"),
			)
		).ref;
		const sessionFile = "/sessions/historical.jsonl";
		const header = {
			type: "session",
			version: 3,
			id: "sess-historical",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/cwd",
		};
		const first = {
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "image", data: imageRef, mimeType: "image/png" }],
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: providerRef }] }],
				},
				timestamp: 1,
			},
		};
		const second = {
			type: "message",
			id: "msg-2",
			parentId: "msg-1",
			timestamp: "2025-01-01T00:00:02.000Z",
			message: assistantMessage(),
		};
		storage.writeTextSync(sessionFile, `${[header, first, second].map(entry => JSON.stringify(entry)).join("\n")}\n`);

		const session = await SessionManager.open(sessionFile, "/sessions", storage);
		const materialized = [
			JSON.stringify(session.getEntry("msg-1")),
			JSON.stringify(session.getEntries()),
			JSON.stringify(session.getBranch()),
			JSON.stringify(session.getChildren("msg-1")),
			JSON.stringify(session.getLeafEntry()),
			JSON.stringify(session.buildSessionContext().messages),
		].join("\n");

		expect(materialized).toContain(HISTORICAL_IMAGE);
		expect(materialized).toContain(HISTORICAL_PROVIDER_IMAGE_URL);
		expect(materialized).not.toContain(BLOB_REF);
		expectResidentBounded(session);
		expect(storage.readTextSync(sessionFile)).toContain(BLOB_REF);
	});

	it("keeps residents bounded after reload and fork while materializing readers", async () => {
		const storage = new MemorySessionStorage();
		const original = SessionManager.create("/cwd", "/sessions", storage);
		const largeId = original.appendMessage(largeUserMessage());
		original.appendMessage(assistantMessage());
		await original.flush();
		const sessionFile = original.getSessionFile()!;

		const reloaded = await SessionManager.open(sessionFile, "/sessions", storage);
		expectResidentBounded(reloaded);
		expect(JSON.stringify(reloaded.getEntry(largeId))).toContain(LARGE_PROVIDER_IMAGE_URL);

		const forked = await SessionManager.forkFrom(sessionFile, "/cwd", "/sessions", storage);
		expectResidentBounded(forked);
		expect(JSON.stringify(forked.buildSessionContext().messages)).toContain(TRUNCATION_NOTICE);
		expect(storage.readTextSync(forked.getSessionFile()!)).toContain(BLOB_REF);
	});

	it("rethrows synchronous persist failures from append", () => {
		const storage: SessionStorage = new ThrowingWriterStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		expect(() => session.appendMessage(assistantMessage())).toThrow("sync persist failed");
	});

	it("does not clobber the previous JSONL when sync temp rename fails", () => {
		const storage = new RenameFailRewriteStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const sessionFile = session.getSessionFile()!;
		session.appendMessage(assistantMessage());
		const before = storage.readTextSync(sessionFile);
		session.restoreState({ ...session.captureState(), flushed: false });

		storage.failTempRename = true;
		storage.failTargetWrite = true;
		expect(() => session.appendCustomEntry("rewrite", { payload: "new content" })).toThrow("rename failed");

		expect(storage.readTextSync(sessionFile)).toBe(before);
		expect(storage.readTextSync(sessionFile)).not.toBe("");
	});

	it("keeps sync EPERM rewrite fallback inside the storage backend", () => {
		const storage = new RenameEpermSyncStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const sessionFile = session.getSessionFile()!;
		session.appendMessage(assistantMessage());
		session.restoreState({ ...session.captureState(), flushed: false });

		storage.failNextSessionReplace = true;
		expect(() => session.appendCustomEntry("rewrite", { payload: "new content" })).not.toThrow();

		expect(storage.readTextSync(sessionFile)).toContain("new content");
		const backupPath = storage.backupCleanupPath;
		if (!backupPath) throw new Error("Expected sync EPERM fallback to create a storage backup");
		expect(storage.existsSync(backupPath)).toBe(false);
	});

	it("preserves the previous JSONL after sync rewrite failure", () => {
		const storage = new ThrowingRewriteStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const sessionFile = session.getSessionFile()!;
		session.appendMessage(assistantMessage());
		const before = storage.readTextSync(sessionFile);
		session.restoreState({ ...session.captureState(), flushed: false });

		storage.shouldThrowSyncWrite = true;
		expect(() => session.appendCustomEntry("large", { payload: LARGE_TEXT })).toThrow("sync rewrite failed");

		expect(storage.readTextSync(sessionFile)).toBe(before);
		expect(storage.readTextSync(sessionFile)).toContain("first");
		expect(storage.readTextSync(sessionFile)).not.toBe("");
	});

	it("keeps in-memory resident blobs off the global blob dir while readers materialize full content", () => {
		const storage = new MemorySessionStorage();
		const blobsDir = getBlobsDir();
		const before = new Set(storage.listFilesSync(blobsDir, "*"));
		const session = SessionManager.inMemory("/cwd", storage);
		const id = session.appendMessage(largeUserMessage());

		expectResidentBounded(session);
		expect(new Set(storage.listFilesSync(blobsDir, "*"))).toEqual(before);
		expect(JSON.stringify(session.getEntry(id))).toContain(LARGE_TEXT);
		expect(JSON.stringify(session.buildSessionContext().messages)).toContain(LARGE_IMAGE);
	});

	it("materializes the same blob bytes independently for text and image decode modes", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.inMemory("/cwd", storage);
		const text = SAME_BYTES_TEXT;
		const image = SAME_BYTES_IMAGE;
		const id = session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text },
				{ type: "image", data: image, mimeType: "image/png" },
			] satisfies (TextContent | ImageContent)[],
			timestamp: 1,
		});

		const entry = session.getEntry(id);
		expect(entry?.type).toBe("message");
		const content =
			entry?.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)
				? entry.message.content
				: [];
		expect(content[0]).toEqual({ type: "text", text });
		expect(content[1]).toEqual({ type: "image", data: image, mimeType: "image/png" });
	});

	it("keeps large custom payloads bounded in resident entries while materializing readers", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const id = session.appendCustomEntry("large-custom", { arbitraryPayload: LARGE_TEXT });

		expectResidentBounded(session);
		expect(JSON.stringify(session.captureState().fileEntries)).not.toContain(LARGE_TEXT.slice(0, 100));
		expect(JSON.stringify(session.getEntry(id))).toContain(LARGE_TEXT);
	});

	it("materializes generic data-key resident strings as utf8 text, not image base64", () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const genericContent = { data: LARGE_TEXT } as unknown as Message["content"];
		const id = session.appendMessage({ role: "user", content: genericContent, timestamp: 1 } as Message);
		const base64Text = Buffer.from(LARGE_TEXT, "utf8").toString("base64");

		expectResidentBounded(session);
		expect(JSON.stringify(session.captureState().fileEntries)).not.toContain(LARGE_TEXT.slice(0, 100));

		const entry = session.getEntry(id);
		expect(entry?.type).toBe("message");
		const materializedContent =
			entry?.type === "message" && "content" in entry.message ? entry.message.content : undefined;
		expect(JSON.stringify(materializedContent)).toBe(JSON.stringify({ data: LARGE_TEXT }));
		expect(session.getEntries().find(item => item.id === id)).toEqual(entry);
		const contextUserMessage = session.buildSessionContext().messages.find(message => message.role === "user");
		expect(
			JSON.stringify(contextUserMessage && "content" in contextUserMessage ? contextUserMessage.content : undefined),
		).toBe(JSON.stringify({ data: LARGE_TEXT }));
		expect(JSON.stringify(entry)).not.toContain(base64Text.slice(0, 100));
	});
});
