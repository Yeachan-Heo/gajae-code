import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, StreamingEditFileCache } from "@gajae-code/coding-agent/session/agent-session";
import { EphemeralBlobStore, MemoryBlobStore } from "@gajae-code/coding-agent/session/blob-store";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

registerMockApi();
const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

function createSession(cwd: string, reply = "ok", tools: AgentTool[] = []) {
	const model = createMockModel({ handler: () => ({ content: [reply] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["test"], messages: [], tools },
		streamFn: model.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated({ "compaction.enabled": false, "edit.streamingAbort": true }),
		modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [model] } as never,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	sessions.push(session);
	return session;
}

function startEdit(session: AgentSession, filePath: string, id: string): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "edit", arguments: { path: filePath, diff: "" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	session.agent.emitExternalEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
	});
}

async function settleEvents(): Promise<void> {
	for (let index = 0; index < 30; index++) await Promise.resolve();
}

describe("session runtime cache hot paths", () => {
	it.each([
		["mixed multibyte", "界🙂".repeat(4000)],
		["surrogate boundary", `ab${"🙂".repeat(2000)}`],
	])("bounds oversized %s IRC replies with the existing suffix and intact code points", async (_label, source) => {
		using dir = TempDir.createSync("irc-byte-bound-");
		const session = createSession(dir.path(), source);
		const { replyText: reply } = await session.respondAsBackground({ from: "0-Main", message: "ping" });
		if (reply === null) throw new Error("Expected an IRC reply");
		const suffix = "\n[…truncated]";
		const budget = 4096 - Buffer.byteLength(suffix);
		let prefix = "";
		for (const glyph of source) {
			if (Buffer.byteLength(prefix + glyph) > budget) break;
			prefix += glyph;
		}
		expect(reply).toBe(prefix + suffix);
		expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(4096);
		expect(reply).not.toContain("�");
		expect(reply.isWellFormed()).toBe(true);
	});

	it("does not publish a delayed pre-cache read after edit invalidation or retire its replacement", async () => {
		using dir = TempDir.createSync("precache-token-");
		const filePath = path.resolve(dir.path(), "file.txt");
		await Bun.write(filePath, "old");
		const session = createSession(dir.path());
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const originalRead = fs.promises.readFile;
		let reads = 0;
		const readSpy = spyOn(fs.promises, "readFile").mockImplementation(((...args: Parameters<typeof originalRead>) => {
			if (String(args[0]) !== filePath) return originalRead(...args);
			reads++;
			if (reads === 1) {
				firstStarted.resolve();
				return first.promise;
			}
			secondStarted.resolve();
			return second.promise;
		}) as typeof originalRead);
		const publishSpy = spyOn(StreamingEditFileCache.prototype, "set");
		try {
			startEdit(session, filePath, "first");
			await firstStarted.promise;
			session.agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "first",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					details: { path: filePath },
					isError: false,
					timestamp: Date.now(),
				},
			});
			await settleEvents();
			startEdit(session, filePath, "second");
			await secondStarted.promise;
			first.resolve("old");
			await settleEvents();
			expect(publishSpy.mock.calls.filter(([key]) => key === filePath)).toHaveLength(0);
			startEdit(session, filePath, "third");
			await settleEvents();
			expect(reads).toBe(2);
			second.resolve("new");
			await settleEvents();
			expect(publishSpy.mock.calls.filter(([key]) => key === filePath)).toEqual([[filePath, "new"]]);
		} finally {
			first.resolve("old");
			second.resolve("new");
			readSpy.mockRestore();
			publishSpy.mockRestore();
		}
	});

	it("bounds unresolved pre-cache generations across repeated invalidation", async () => {
		using dir = TempDir.createSync("precache-generation-bound-");
		const filePath = path.resolve(dir.path(), "file.txt");
		await Bun.write(filePath, "old");
		const session = createSession(dir.path());
		const reads: Array<ReturnType<typeof Promise.withResolvers<string>>> = [];
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const originalRead = fs.promises.readFile;
		const readSpy = spyOn(fs.promises, "readFile").mockImplementation(((...args: Parameters<typeof originalRead>) => {
			if (String(args[0]) !== filePath) return originalRead(...args);
			const pending = Promise.withResolvers<string>();
			reads.push(pending);
			if (reads.length === 1) firstStarted.resolve();
			if (reads.length === 2) secondStarted.resolve();
			return pending.promise;
		}) as typeof originalRead);
		try {
			const invalidate = () =>
				session.agent.emitExternalEvent({
					type: "message_end",
					message: {
						role: "toolResult",
						toolCallId: "edit",
						toolName: "edit",
						content: [{ type: "text", text: "ok" }],
						details: { path: filePath },
						isError: false,
						timestamp: Date.now(),
					},
				});
			startEdit(session, filePath, "first");
			await firstStarted.promise;
			invalidate();
			await settleEvents();
			startEdit(session, filePath, "second");
			await secondStarted.promise;
			invalidate();
			startEdit(session, filePath, "third");
			await settleEvents();
			expect(readSpy).toHaveBeenCalledTimes(2);
			for (const pending of reads) pending.resolve("stale");
			await settleEvents();
		} finally {
			for (const pending of reads) pending.resolve("stale");
			readSpy.mockRestore();
		}
	});

	it("keeps only the current permission wrapper across bridge and provider replacements", () => {
		using dir = TempDir.createSync("wrapper-generations-");
		const tool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "test",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		};
		const mapSpy = spyOn(WeakMap.prototype, "set");
		try {
			const session = createSession(dir.path(), "ok", [tool]);
			for (let index = 0; index < 40; index++) {
				session.setClientBridge({
					capabilities: { requestPermission: true },
					requestPermission: async () => ({ outcome: "cancelled" }),
				});
				session.setSdkPermissionProvider(async () => ({ outcome: "cancelled" }));
				const wrapped = session.getToolForExecution("bash");
				expect(session.getToolForExecution("bash")).toBe(wrapped);
			}
			const maps = mapSpy.mock.calls.filter(([key, value]) => key === tool && value instanceof Map);
			expect(maps).toHaveLength(1);
			const versions = maps[0]![1] as Map<string, AgentTool>;
			expect(versions.size).toBe(1);
			expect(versions.values().next().value).toBe(session.getToolForExecution("bash"));
		} finally {
			mapSpy.mockRestore();
		}
	});

	it("reuses warm context without recursive sentinel traversal", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const expected = manager.buildSessionContext();
		const valuesSpy = spyOn(Object, "values");
		try {
			expect(manager.buildSessionContext()).toEqual(expected);
			expect(valuesSpy).not.toHaveBeenCalled();
			manager.appendMessage({ role: "user", content: "new revision", timestamp: 2 });
			expect(manager.buildSessionContext().messages).toHaveLength(2);
			expect(valuesSpy.mock.calls.length).toBeGreaterThan(0);
		} finally {
			valuesSpy.mockRestore();
		}
	});

	it("copies ordinary memory inputs but transfers owned inputs and isolates returned buffers", () => {
		const store = new MemoryBlobStore();
		const ordinary = Buffer.from("ordinary");
		const owned = Buffer.from("owned");
		const copySpy = spyOn(Buffer, "from");
		let ordinaryHash: string;
		let ownedHash: string;
		try {
			ordinaryHash = store.putSync(ordinary).hash;
			expect(copySpy.mock.calls.some(([value]) => value === ordinary)).toBe(true);
			copySpy.mockClear();
			ownedHash = store.putOwnedSync(owned).hash;
			expect(copySpy.mock.calls.some(([value]) => value === owned)).toBe(false);
		} finally {
			copySpy.mockRestore();
		}
		ordinary.fill(0);
		expect(store.getSync(ordinaryHash)?.toString()).toBe("ordinary");
		store.getSync(ownedHash)!.fill(0);
		expect(store.getSync(ownedHash)?.toString()).toBe("owned");
	});

	it("rejects oversized ephemeral buffers before copying and isolates accepted buffers", () => {
		using dir = TempDir.createSync("ephemeral-copy-bound-");
		const store = new EphemeralBlobStore(path.join(dir.path(), "cache"));
		try {
			for (const size of [8 * 1024 * 1024 - 1, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
				const input = Buffer.alloc(size, 65);
				const copySpy = spyOn(Buffer, "from");
				let hash: string;
				try {
					hash = store.putSync(input).hash;
					expect(copySpy.mock.calls.filter(([value]) => value === input).length).toBe(
						size > 8 * 1024 * 1024 ? 0 : 1,
					);
				} finally {
					copySpy.mockRestore();
				}
				input.fill(66);
				const cached = store.getBufferedSync(hash);
				if (size > 8 * 1024 * 1024) expect(cached).toBeNull();
				else {
					expect(cached?.length).toBe(size);
					expect(cached?.[0]).toBe(65);
				}
				expect(store.getSync(hash)?.[0]).toBe(65);
			}
		} finally {
			store.dispose();
		}
	});
});
