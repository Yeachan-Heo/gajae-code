import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, TextContent, ToolCall, UserMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import {
	type ColdSpillRef,
	type CustomMessageEntry,
	SessionManager,
	type SessionMessageEntry,
} from "@gajae-code/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import { getBlobsDir } from "@gajae-code/utils";

const TURN_PAYLOAD_CHARS = 200_000;
const ONE_MIB_CHARS = 1_048_576;
const REF_BOUND = 8_000;
const BASE = 200_000;
const EXPLICIT_SMALL_BOUND = 100_000;
const CHUNK_CHARS = 500;
const CHUNKS_PER_TURN = Math.ceil(TURN_PAYLOAD_CHARS / CHUNK_CHARS);

function chunkedText(prefix: string): Array<{ type: "text"; text: string }> {
	return Array.from({ length: CHUNKS_PER_TURN }, (_, index) => ({
		type: "text" as const,
		text: `${prefix}-${index}-${"x".repeat(CHUNK_CHARS)}`,
	}));
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: chunkedText(text), timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `${text}:thinking`, thinkingSignature: "sig" },
			{ type: "redactedThinking", data: `${text}:redacted` },
			...chunkedText(text),
			{
				type: "toolCall",
				id: `tool-${text.slice(0, 12)}`,
				name: "apply_patch",
				arguments: { patch: chunkedText(text) },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function smallAssistantMessage(text: string): AssistantMessage {
	return { ...assistantMessage("small"), content: [{ type: "text", text }] };
}

function buildLargeSession(
	turns: number,
	persisted: boolean,
): {
	session: SessionManager;
	firstKeptEntryId: string;
	oldEntryId: string;
	oldAssistantEntryId: string;
	oldNeedle: string;
	before: number;
} {
	const storage = new MemorySessionStorage();
	const session = persisted
		? SessionManager.create("/cwd", "/sessions", storage)
		: SessionManager.inMemory("/cwd", storage);
	let firstKeptEntryId = "";
	let oldEntryId = "";
	let oldNeedle = "";
	let oldAssistantEntryId = "";
	for (let i = 0; i < turns; i++) {
		const needle = `needle-${i}`;
		const isTail = i >= turns - 2;
		const userId = session.appendMessage(
			isTail ? { role: "user", content: needle, timestamp: Date.now() } : userMessage(needle),
		);
		const assistantId = session.appendMessage(
			isTail ? smallAssistantMessage(`assistant-${i}-${needle}`) : assistantMessage(`assistant-${i}-${needle}`),
		);
		if (i === 0) {
			oldEntryId = userId;
			oldNeedle = needle;
			oldAssistantEntryId = assistantId;
		}
		if (i === turns - 2) firstKeptEntryId = userId;
	}
	const before = Math.max(session.hotRetainedMessageCharsForTests(), turns * TURN_PAYLOAD_CHARS * 2);
	return { session, firstKeptEntryId, oldEntryId, oldAssistantEntryId, oldNeedle, before };
}

function messageContentText(entry: SessionMessageEntry): string {
	const message = entry.message;
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return JSON.stringify(content);
}

function expectAssistantMetadata(message: SessionMessageEntry["message"]): void {
	expect(message.role).toBe("assistant");
	if (message.role !== "assistant") throw new Error("expected assistant message");
	expect(message.provider).toBe("anthropic");
	expect(message.model).toBe("test-model");
	expect(message.stopReason).toBe("stop");
	expect(message.usage).toEqual({
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
}

function coldSpillArgumentsSentinel(value: unknown): { refPath?: unknown; notice?: unknown } {
	expect(value).toBeObject();
	const sentinel = value as Record<string, unknown>;
	expect(sentinel.__gjcColdSpillArguments).toBe(true);
	return sentinel;
}

function residentTextSentinel(value: unknown): { kind?: unknown; ref?: unknown } {
	expect(value).toBeObject();
	const sentinel = value as Record<string, unknown>;
	expect(sentinel.__gjcResidentBlob).toBe(true);
	expect(sentinel.kind).toBe("text");
	return sentinel;
}

function toolCallArguments(entry: SessionMessageEntry): unknown {
	const message = entry.message;
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	const toolCall = content.find((block): block is ToolCall => block.type === "toolCall");
	expect(toolCall).toBeDefined();
	return toolCall?.arguments;
}

function buildResidentColdToolArgumentSession(): {
	session: SessionManager;
	oldAssistantEntryId: string;
	firstKeptEntryId: string;
	compactionEntryId: string;
	largeArgument: string;
} {
	const session = SessionManager.inMemory("/cwd", new MemorySessionStorage());
	const largeArgument = `resident-argument-${"z".repeat(5_000)}`;
	const oldAssistantEntryId = session.appendMessage({
		...assistantMessage("resident-cold-tool"),
		content: [
			{
				type: "toolCall",
				id: "resident-cold-tool",
				name: "resident_cold_tool",
				arguments: {
					payload: largeArgument,
					filler: Array.from({ length: 180 }, (_, index) => `filler-${index}`),
				},
			},
		],
	});
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
	return { session, oldAssistantEntryId, firstKeptEntryId, compactionEntryId, largeArgument };
}
function buildSelfContainedColdToolArgumentSession(): {
	session: SessionManager;
	oldAssistantEntryId: string;
	firstKeptEntryId: string;
	compactionEntryId: string;
	argumentPayload: Array<{ index: number; text: string }>;
} {
	const session = SessionManager.inMemory("/cwd", new MemorySessionStorage());
	const argumentPayload = Array.from({ length: 180 }, (_, index) => ({ index, text: `self-contained-${index}` }));
	const oldAssistantEntryId = session.appendMessage({
		...assistantMessage("self-contained-cold-tool"),
		content: [
			{
				type: "toolCall",
				id: "self-contained-cold-tool",
				name: "self_contained_cold_tool",
				arguments: {
					payload: argumentPayload,
				},
			},
		],
	});
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
	return { session, oldAssistantEntryId, firstKeptEntryId, compactionEntryId, argumentPayload };
}

function expectToolArgumentArrayPayload(
	entry: SessionMessageEntry,
	expected: Array<{ index: number; text: string }>,
): void {
	const args = toolCallArguments(entry);
	expect(args).toBeObject();
	expect((args as { payload?: unknown }).payload).toEqual(expected);
}

function expectToolArgumentPayload(entry: SessionMessageEntry, expected: string): void {
	const args = toolCallArguments(entry);
	expect(args).toBeObject();
	expect((args as { payload?: unknown }).payload).toBe(expected);
}
function expectNoResidentSentinel(value: unknown): void {
	expect(JSON.stringify(value)).not.toContain("__gjcResidentBlob");
}

function expectColdBlobSentinelFree(ref: ColdSpillRef, expected: unknown): void {
	const blobPath = path.join(getBlobsDir(), ref.sha256);
	const text = fs.readFileSync(blobPath, "utf8");
	expect(text).toBe(JSON.stringify(expected));
	expect(text).not.toContain("__gjcResidentBlob");
}

function buildMixedResidentAggregateToolArgumentSession(persisted: boolean): {
	session: SessionManager;
	oldAssistantEntryId: string;
	firstKeptEntryId: string;
	compactionEntryId: string;
	residentPayload: string;
	aggregatePayload: Array<{ index: number; text: string }>;
	before: number;
} {
	const storage = new MemorySessionStorage();
	const session = persisted
		? SessionManager.create("/cwd", "/sessions", storage)
		: SessionManager.inMemory("/cwd", storage);
	const residentPayload = `mixed-resident-argument-${"r".repeat(5_000)}`;
	const aggregatePayload = Array.from({ length: 20_000 }, (_, index) => ({
		index,
		text: `mixed-small-${index}-${"a".repeat(80)}`,
	}));
	const oldAssistantEntryId = session.appendMessage({
		...assistantMessage("mixed-resident-aggregate"),
		content: [
			{
				type: "toolCall",
				id: "mixed-resident-aggregate",
				name: "mixed_resident_aggregate",
				customWireName: "wire_mixed_resident_aggregate",
				arguments: {
					resident: { nested: residentPayload },
					aggregate: aggregatePayload,
				},
			},
		],
	});
	const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
	const before = session.hotRetainedMessageCharsForTests();
	return {
		session,
		oldAssistantEntryId,
		firstKeptEntryId,
		compactionEntryId,
		residentPayload,
		aggregatePayload,
		before,
	};
}

describe("SessionManager compacted cold-spill eviction", () => {
	for (const persisted of [false, true]) {
		it(`evicts compacted hot payloads without bulk materialization (${persisted ? "persisted" : "memory"})`, () => {
			const { session, firstKeptEntryId, oldEntryId, oldNeedle, before } = buildLargeSession(10, persisted);
			const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
			const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			const after = session.hotRetainedMessageCharsForTests();

			expect(result.evictedEntries).toBeGreaterThanOrEqual(0);
			expect(result.payloadRefs).toBeGreaterThanOrEqual(0);
			expect(after).toBeLessThan(ONE_MIB_CHARS);
			expect(after).toBeLessThan(before * 0.05);
			expect(result.coldSpillReadCount).toBe(0);
			expect(result.residentTextReadCount).toBe(0);
			expect(result.residentImageReadCount).toBe(0);

			const statsAfterEvict = session.getObservabilityStatsForTests();
			expect(statsAfterEvict.publicMaterializerCallCount).toBe(0);
			expect(statsAfterEvict.getEntryMaterializerCallCount).toBe(0);
			expect(statsAfterEvict.getBranchMaterializerCallCount).toBe(0);
			expect(statsAfterEvict.getEntriesMaterializerCallCount).toBe(0);
			expect(statsAfterEvict.materializedEntriesCachePopulateCount).toBe(0);

			const context = session.buildSessionContext();
			expect(JSON.stringify(context.messages)).toContain("summary");
			expect(JSON.stringify(context.messages)).not.toContain("Compacted history content evicted");
			const statsAfterContext = session.getObservabilityStatsForTests();
			expect(statsAfterContext.materializedEntriesCachePopulateCount).toBe(0);
			expect(statsAfterContext.coldSpillReadCount).toBe(0);
			expect(statsAfterContext.pathOnlyContextBuildCount).toBe(1);

			const fidelity = session.getEntryForFidelity(oldEntryId) as SessionMessageEntry;
			expect(messageContentText(fidelity)).toContain(oldNeedle);

			const second = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			expect(second.evictedEntries).toBe(0);
			expect(second.alreadyEvictedEntries).toBeGreaterThanOrEqual(0);
		});
	}

	it("keeps hot chars bounded with explicit 10-turn and 50-turn scaling constants", () => {
		const ten = buildLargeSession(10, false);
		const tenCompactionEntryId = ten.session.appendCompaction("summary", "short", ten.firstKeptEntryId, 123);
		const tenResult = ten.session.evictCompactedContent(ten.firstKeptEntryId, tenCompactionEntryId);
		const after10 = ten.session.hotRetainedMessageCharsForTests();
		expect(after10).toBeLessThanOrEqual(BASE + 10 * REF_BOUND);
		expect(tenResult.coldSpillReadCount).toBe(0);
		const tenContext = ten.session.buildSessionContext();
		expect(JSON.stringify(tenContext.messages)).toContain("summary");
		expect(ten.session.getObservabilityStatsForTests().coldSpillReadCount).toBe(0);
		expect(messageContentText(ten.session.getEntryForFidelity(ten.oldEntryId) as SessionMessageEntry)).toContain(
			ten.oldNeedle,
		);

		const fifty = buildLargeSession(50, false);
		const fiftyCompactionEntryId = fifty.session.appendCompaction("summary", "short", fifty.firstKeptEntryId, 123);
		const fiftyResult = fifty.session.evictCompactedContent(fifty.firstKeptEntryId, fiftyCompactionEntryId);
		const after50 = fifty.session.hotRetainedMessageCharsForTests();
		expect(after50).toBeLessThanOrEqual(BASE + 50 * REF_BOUND);
		expect(after50 - after10).toBeLessThan(EXPLICIT_SMALL_BOUND);
		expect(fifty.before).toBeGreaterThanOrEqual(10_000_000);
		expect(after50).toBeLessThan(ONE_MIB_CHARS);
		expect(after50).toBeLessThan(fifty.before * 0.05);
		expect(fiftyResult.coldSpillReadCount).toBe(0);
		const fiftyContext = fifty.session.buildSessionContext();
		expect(JSON.stringify(fiftyContext.messages)).toContain("summary");
		expect(fifty.session.getObservabilityStatsForTests().coldSpillReadCount).toBe(0);
		expect(messageContentText(fifty.session.getEntryForFidelity(fifty.oldEntryId) as SessionMessageEntry)).toContain(
			fifty.oldNeedle,
		);
	});

	for (const flow of ["manual", "auto"] as const) {
		it(`runs deterministic ${flow} compaction rebuild flow without public materializers`, () => {
			const { session, firstKeptEntryId } = buildLargeSession(10, false);
			const getEntriesSpy = vi.spyOn(session, "getEntries");
			const getBranchSpy = vi.spyOn(session, "getBranch");
			const getEntrySpy = vi.spyOn(session, "getEntry");
			try {
				const beforeAppend = session.getObservabilityStatsForTests();
				const compactionEntryId = session.appendCompaction(
					`${flow} deterministic summary`,
					"short",
					firstKeptEntryId,
					123,
				);
				const eviction = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
				expect(eviction.coldSpillWriteCount).toBeGreaterThan(0);
				expect(eviction.coldSpillReadCount).toBe(0);
				expect(eviction.residentTextReadCount).toBe(0);
				expect(eviction.residentImageReadCount).toBe(0);

				const afterEviction = session.getObservabilityStatsForTests();
				expect(getEntriesSpy).not.toHaveBeenCalled();
				expect(getBranchSpy).not.toHaveBeenCalled();
				expect(getEntrySpy).not.toHaveBeenCalled();
				expect(afterEviction.publicMaterializerCallCount).toBe(beforeAppend.publicMaterializerCallCount);
				expect(afterEviction.getEntryMaterializerCallCount).toBe(beforeAppend.getEntryMaterializerCallCount);
				expect(afterEviction.getBranchMaterializerCallCount).toBe(beforeAppend.getBranchMaterializerCallCount);
				expect(afterEviction.getEntriesMaterializerCallCount).toBe(beforeAppend.getEntriesMaterializerCallCount);
				expect(afterEviction.materializedEntriesCachePopulateCount).toBe(
					beforeAppend.materializedEntriesCachePopulateCount,
				);

				const providerContext = session.buildSessionContext();
				const displayContext = session.buildSessionContext();
				expect(JSON.stringify(providerContext.messages)).toContain(`${flow} deterministic summary`);
				expect(JSON.stringify(displayContext.messages)).toContain(`${flow} deterministic summary`);
				const afterRebuild = session.getObservabilityStatsForTests();
				expect(afterRebuild.publicMaterializerCallCount).toBe(beforeAppend.publicMaterializerCallCount);
				expect(afterRebuild.getEntryMaterializerCallCount).toBe(beforeAppend.getEntryMaterializerCallCount);
				expect(afterRebuild.getBranchMaterializerCallCount).toBe(beforeAppend.getBranchMaterializerCallCount);
				expect(afterRebuild.getEntriesMaterializerCallCount).toBe(beforeAppend.getEntriesMaterializerCallCount);
				expect(afterRebuild.materializedEntriesCachePopulateCount).toBe(
					beforeAppend.materializedEntriesCachePopulateCount,
				);
				expect(afterRebuild.coldSpillReadCount).toBe(0);
				expect(afterRebuild.pathOnlyContextBuildCount).toBe(1);

				const compactionEntry = session.getEntryForFidelity(compactionEntryId);
				expect(compactionEntry?.type).toBe("compaction");
				expect(JSON.stringify(compactionEntry)).toContain(`${flow} deterministic summary`);
				expect(getEntriesSpy).not.toHaveBeenCalled();
			} finally {
				getEntriesSpy.mockRestore();
				getBranchSpy.mockRestore();
				getEntrySpy.mockRestore();
			}
		});
	}

	it("runs real AgentSession compaction post-append path without public materializers", async () => {
		const tempDir = path.join(os.tmpdir(), `gjc-agent-compaction-eviction-${Date.now()}-${Math.random()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		let authStorage: AuthStorage | undefined;
		try {
			const { session, firstKeptEntryId } = buildLargeSession(10, false);
			session.appendCustomEntry("user_todo_edit", {
				phases: [
					{
						name: "phase",
						tasks: [
							{ content: "keep", status: "in_progress" },
							{ content: "strip", status: "completed" },
						],
					},
				],
			});
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: model!,
					systemPrompt: ["test"],
					tools: [],
				},
			});
			authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
			const agentSession = new AgentSession({
				agent,
				sessionManager: session,
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage),
			});
			const getEntriesSpy = vi.spyOn(session, "getEntries");
			const getBranchSpy = vi.spyOn(session, "getBranch");
			const getEntrySpy = vi.spyOn(session, "getEntry");
			const getEntryForFidelitySpy = vi.spyOn(session, "getEntryForFidelity");
			try {
				const beforeAppend = session.getObservabilityStatsForTests();
				const compactionEntryId = session.appendCompaction(
					"agent deterministic summary",
					"short",
					firstKeptEntryId,
					123,
				);
				const compactionEntry = await agentSession.applyCompactionPostAppendForTests(
					compactionEntryId,
					firstKeptEntryId,
					false,
				);
				const afterPostAppend = session.getObservabilityStatsForTests();

				expect(compactionEntry?.type).toBe("compaction");
				expect(JSON.stringify(compactionEntry)).toContain("agent deterministic summary");
				expect(getEntryForFidelitySpy).toHaveBeenCalledTimes(1);
				expect(getEntryForFidelitySpy).toHaveBeenCalledWith(compactionEntryId);
				expect(getEntriesSpy).not.toHaveBeenCalled();
				expect(getBranchSpy).not.toHaveBeenCalled();
				expect(getEntrySpy).not.toHaveBeenCalled();
				expect(afterPostAppend.publicMaterializerCallCount).toBe(beforeAppend.publicMaterializerCallCount);
				expect(afterPostAppend.getEntryMaterializerCallCount).toBe(beforeAppend.getEntryMaterializerCallCount);
				expect(afterPostAppend.getBranchMaterializerCallCount).toBe(beforeAppend.getBranchMaterializerCallCount);
				expect(afterPostAppend.getEntriesMaterializerCallCount).toBe(beforeAppend.getEntriesMaterializerCallCount);
				expect(afterPostAppend.materializedEntriesCachePopulateCount).toBe(
					beforeAppend.materializedEntriesCachePopulateCount,
				);
				expect(afterPostAppend.coldSpillWriteCount).toBeGreaterThan(beforeAppend.coldSpillWriteCount);
				expect(agentSession.getTodoPhases()).toEqual([
					{ name: "phase", tasks: [{ content: "keep", status: "in_progress" }] },
				]);
			} finally {
				getEntriesSpy.mockRestore();
				getBranchSpy.mockRestore();
				getEntrySpy.mockRestore();
				getEntryForFidelitySpy.mockRestore();
				await agentSession.dispose();
			}
		} finally {
			authStorage?.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a side branch rehydratable when active compaction is not on that branch", () => {
		const { session, firstKeptEntryId, oldEntryId, oldNeedle } = buildLargeSession(4, false);
		const sideLeaf = oldEntryId;
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		session.branch(sideLeaf);
		const context = session.buildSessionContext();
		expect(JSON.stringify(context.messages)).toContain(oldNeedle);
	});

	it("preserves OpenAI remote replacement provider payload on context build", () => {
		const { session, firstKeptEntryId } = buildLargeSession(4, false);
		const compactionEntryId = session.appendCompaction(
			"summary",
			"short",
			firstKeptEntryId,
			123,
			undefined,
			undefined,
			{
				openaiRemoteCompaction: { provider: "openai", replacementHistory: [{ type: "message", id: "remote-1" }] },
			},
		);
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		const context = session.buildSessionContext();
		expect(JSON.stringify(context.messages)).toContain("openaiResponsesHistory");
	});

	it("preserves assistant metadata and tool call identity in hot evicted entries", () => {
		const { session, firstKeptEntryId, oldAssistantEntryId } = buildLargeSession(4, false);
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);

		const hot = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
		expectAssistantMetadata(hot.message);
		expect(hot.evictedContent?.reason).toBe("compacted_history");
		const hotMessage = hot.message;
		const hotContent = "content" in hotMessage && Array.isArray(hotMessage.content) ? hotMessage.content : [];
		expect(hotContent.length).toBeGreaterThan(0);
		const toolCall = hotContent.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.id).toBe("tool-assistant-0-");
		expect(toolCall?.name).toBe("apply_patch");
	});

	it("cold-spills self-contained large tool arguments and rehydrates them for fidelity APIs", () => {
		const { session, oldAssistantEntryId, firstKeptEntryId, compactionEntryId, argumentPayload } =
			buildSelfContainedColdToolArgumentSession();

		const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		expect(result.residentTextReadCount).toBe(0);
		expect(result.residentImageReadCount).toBe(0);
		const canonicalAfter = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
		const sentinel = coldSpillArgumentsSentinel(toolCallArguments(canonicalAfter));
		expect(sentinel.refPath).toBe("message.content.0.arguments");
		expect(sentinel.notice).toBe("[Compacted history content evicted to durable cold storage]");

		expectToolArgumentArrayPayload(
			session.getEntryForFidelity(oldAssistantEntryId) as SessionMessageEntry,
			argumentPayload,
		);
		const branchEntry = session
			.getBranchForFidelity(oldAssistantEntryId)
			.find((entry): entry is SessionMessageEntry => entry.id === oldAssistantEntryId && entry.type === "message");
		expect(branchEntry).toBeDefined();
		expectToolArgumentArrayPayload(branchEntry as SessionMessageEntry, argumentPayload);
		const exportEntry = session
			.getEntriesForExport()
			.find((entry): entry is SessionMessageEntry => entry.id === oldAssistantEntryId && entry.type === "message");
		expect(exportEntry).toBeDefined();
		expectToolArgumentArrayPayload(exportEntry as SessionMessageEntry, argumentPayload);
		expectNoResidentSentinel(session.getEntryForFidelity(oldAssistantEntryId));
	});

	it("preserves custom message shell fields after eviction", () => {
		const session = SessionManager.inMemory("/cwd", new MemorySessionStorage());
		session.appendMessage(userMessage("old-user"));
		const customId = session.appendCustomMessageEntry(
			"custom.test",
			[
				{
					type: "toolCall",
					id: "custom-tool",
					name: "custom_tool",
					customWireName: "wire_custom_tool",
					arguments: { payload: Array.from({ length: 80 }, (_, index) => ({ index, text: `arg-${index}` })) },
				},
			] as unknown as CustomMessageEntry["content"],
			true,
			{ visible: true },
			"user",
		);
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);

		const hot = session.getCanonicalEntryForTests(customId) as CustomMessageEntry;
		expect(hot.type).toBe("custom_message");
		expect(hot.customType).toBe("custom.test");
		expect(hot.display).toBe(true);
		expect(hot.id).toBe(customId);
		expect(hot.parentId).not.toBeNull();
		expect(hot.evictedContent?.reason).toBe("compacted_history");
	});

	it("keeps legacy inferred default model when the only model-bearing assistant was evicted", () => {
		const { session, firstKeptEntryId } = buildLargeSession(4, false);
		const before = session.buildSessionContext().models.default;
		expect(before).toBe("anthropic/test-model");
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);

		expect(session.buildSessionContext().models.default).toBe(before);
	});

	it("promotes resident text sentinels to durable cold storage for fidelity rehydration", () => {
		const session = SessionManager.inMemory("/cwd", new MemorySessionStorage());
		const oldNeedle = `resident-user-text-${"u".repeat(520_000)}-end`;
		const oldEntryId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: oldNeedle }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		expect(result.residentTextReadCount).toBe(1);

		const hot = session.getCanonicalEntryForTests(oldEntryId) as SessionMessageEntry;
		const hotMessage = hot.message;
		const hotContent = "content" in hotMessage && Array.isArray(hotMessage.content) ? hotMessage.content : [];
		const textBlock = hotContent.find((block): block is TextContent => block.type === "text");
		expect(textBlock?.text).toBe("[Compacted history content evicted to durable cold storage]");
		expect(hot.evictedContent?.payloads["message.content.0.text"]).toBeDefined();

		const fidelity = session.getEntryForFidelity(oldEntryId) as SessionMessageEntry;
		expect(messageContentText(fidelity)).toContain(oldNeedle);
	});
	it("does not materialize promoted resident text as a heap string (originalChars is byte length)", () => {
		const session = SessionManager.inMemory("/cwd", new MemorySessionStorage());
		// Multi-byte text: UTF-8 byte length (6000) > JS string length (2000).
		const text = "각".repeat(2000);
		const expectedBytes = Buffer.byteLength(text, "utf8");
		expect(expectedBytes).toBeGreaterThan(text.length);
		const oldEntryId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		expect(result.residentTextReadCount).toBe(1);

		const hot = session.getCanonicalEntryForTests(oldEntryId) as SessionMessageEntry;
		const ref = hot.evictedContent?.payloads["message.content.0.text"];
		expect(ref).toBeDefined();
		// originalChars must be the UTF-8 BYTE length, proving eviction did not call
		// data.toString("utf8") (which would yield the smaller JS string length).
		expect(ref?.originalChars).toBe(expectedBytes);
		expect(ref?.originalChars).not.toBe(text.length);

		const fidelity = session.getEntryForFidelity(oldEntryId) as SessionMessageEntry;
		expect(messageContentText(fidelity)).toContain(text);
	});

	it("promotes resident sentinels in hot tool arguments and materializes them for fidelity APIs", () => {
		const { session, oldAssistantEntryId, firstKeptEntryId, compactionEntryId, largeArgument } =
			buildResidentColdToolArgumentSession();
		const canonicalBefore = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
		const beforeArgs = toolCallArguments(canonicalBefore) as { payload?: unknown };
		residentTextSentinel(beforeArgs.payload);

		const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		expect(result.residentTextReadCount).toBe(1);
		expect(result.residentImageReadCount).toBe(0);
		const canonicalAfter = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
		const afterArgs = toolCallArguments(canonicalAfter) as { payload?: unknown };
		expect(afterArgs.payload).toBe("[Compacted history content evicted to durable cold storage]");
		expect(canonicalAfter.evictedContent?.payloads["message.content.0.arguments.payload"]).toBeDefined();

		expectToolArgumentPayload(session.getEntryForFidelity(oldAssistantEntryId) as SessionMessageEntry, largeArgument);
		const branchEntry = session
			.getBranchForFidelity(oldAssistantEntryId)
			.find((entry): entry is SessionMessageEntry => entry.id === oldAssistantEntryId && entry.type === "message");
		expect(branchEntry).toBeDefined();
		expectToolArgumentPayload(branchEntry as SessionMessageEntry, largeArgument);
		const exportEntry = session
			.getEntriesForExport()
			.find((entry): entry is SessionMessageEntry => entry.id === oldAssistantEntryId && entry.type === "message");
		expect(exportEntry).toBeDefined();
		expectToolArgumentPayload(exportEntry as SessionMessageEntry, largeArgument);
		expectNoResidentSentinel(session.getEntryForFidelity(oldAssistantEntryId));
	});

	it("cold-spills mixed resident and self-contained aggregate tool arguments with bounded resident promotion", () => {
		const {
			session,
			oldAssistantEntryId,
			firstKeptEntryId,
			compactionEntryId,
			residentPayload,
			aggregatePayload,
			before,
		} = buildMixedResidentAggregateToolArgumentSession(false);
		const canonicalBefore = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
		const beforeArgs = toolCallArguments(canonicalBefore) as {
			resident?: { nested?: unknown };
			aggregate?: unknown;
		};
		const beforeResident = beforeArgs.resident?.nested;
		residentTextSentinel(beforeResident);

		const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		expect(result.residentTextReadCount).toBe(1);
		expect(result.residentImageReadCount).toBe(0);
		expect(session.hotRetainedMessageCharsForTests()).toBeLessThan(ONE_MIB_CHARS);
		expect(session.hotRetainedMessageCharsForTests()).toBeLessThan(before * 0.05);

		const canonicalAfter = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
		const afterArgs = toolCallArguments(canonicalAfter) as {
			resident?: { nested?: unknown };
			aggregate?: unknown;
		};
		expect(afterArgs.resident?.nested).toBe("[Compacted history content evicted to durable cold storage]");
		const residentRef = canonicalAfter.evictedContent?.payloads["message.content.0.arguments.resident.nested"];
		expect(residentRef).toBeDefined();
		const aggregateSentinel = coldSpillArgumentsSentinel(afterArgs.aggregate);
		expect(aggregateSentinel.refPath).toBe("message.content.0.arguments.aggregate");
		const aggregateRef = canonicalAfter.evictedContent?.payloads["message.content.0.arguments.aggregate"];
		expect(aggregateRef).toBeDefined();

		const fidelity = session.getEntryForFidelity(oldAssistantEntryId) as SessionMessageEntry;
		const fidelityArgs = toolCallArguments(fidelity) as {
			resident?: { nested?: unknown };
			aggregate?: unknown;
		};
		expect(fidelityArgs.resident?.nested).toBe(residentPayload);
		expect(fidelityArgs.aggregate).toEqual(aggregatePayload);
		expectNoResidentSentinel(fidelity);
	});

	it("rehydrates resident sentinels inside cold-spilled tool arguments for uncovered side branches", () => {
		const { session, oldAssistantEntryId, firstKeptEntryId, compactionEntryId, largeArgument } =
			buildResidentColdToolArgumentSession();
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		session.branch(oldAssistantEntryId);

		const context = session.buildSessionContext();
		const serialized = JSON.stringify(context.messages);
		expect(serialized).toContain(largeArgument);
		expect(serialized).not.toContain("__gjcResidentBlob");
	});

	it("rehydrates self-contained cold spills and resident-preserved arguments after persisted close and reopen", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cold-spill-reopen-"));
		let reopened: SessionManager | undefined;
		try {
			const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, root));
			const selfContainedPayload = Array.from({ length: 180 }, (_, index) => ({
				index,
				text: `persisted-self-contained-${index}`,
			}));
			const residentPayload = `persisted-resident-argument-${"r".repeat(5_000)}`;
			const selfContainedEntryId = session.appendMessage({
				...assistantMessage("persisted-self-contained"),
				content: [
					{
						type: "toolCall",
						id: "persisted-self-contained",
						name: "persisted_self_contained",
						arguments: { payload: selfContainedPayload },
					},
				],
			});
			const residentEntryId = session.appendMessage({
				...assistantMessage("persisted-resident"),
				content: [
					{
						type: "toolCall",
						id: "persisted-resident",
						name: "persisted_resident",
						arguments: { payload: residentPayload },
					},
				],
			});
			const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
			const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			expect(result.residentTextReadCount).toBe(1);
			expect(result.residentImageReadCount).toBe(0);
			const selfContainedHot = session.getCanonicalEntryForTests(selfContainedEntryId) as SessionMessageEntry;
			coldSpillArgumentsSentinel(toolCallArguments(selfContainedHot));
			const residentHot = session.getCanonicalEntryForTests(residentEntryId) as SessionMessageEntry;
			const residentHotArgs = toolCallArguments(residentHot) as { payload?: unknown };
			expect(residentHotArgs.payload).toBe("[Compacted history content evicted to durable cold storage]");
			expect(residentHot.evictedContent?.payloads["message.content.0.arguments.payload"]).toBeDefined();
			await session.ensureOnDisk();
			await session.rewriteEntries();
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await session.close();

			reopened = await SessionManager.open(sessionFile);
			expectToolArgumentArrayPayload(
				reopened.getEntryForFidelity(selfContainedEntryId) as SessionMessageEntry,
				selfContainedPayload,
			);
			expectToolArgumentPayload(
				reopened.getEntryForFidelity(residentEntryId) as SessionMessageEntry,
				residentPayload,
			);
			const branch = reopened.getBranchForFidelity(residentEntryId);
			const branchSelfContained = branch.find(
				(entry): entry is SessionMessageEntry => entry.id === selfContainedEntryId && entry.type === "message",
			);
			const branchResident = branch.find(
				(entry): entry is SessionMessageEntry => entry.id === residentEntryId && entry.type === "message",
			);
			expect(branchSelfContained).toBeDefined();
			expect(branchResident).toBeDefined();
			expectToolArgumentArrayPayload(branchSelfContained as SessionMessageEntry, selfContainedPayload);
			expectToolArgumentPayload(branchResident as SessionMessageEntry, residentPayload);
			const exported = reopened.getEntriesForExport();
			const exportSelfContained = exported.find(
				(entry): entry is SessionMessageEntry => entry.id === selfContainedEntryId && entry.type === "message",
			);
			const exportResident = exported.find(
				(entry): entry is SessionMessageEntry => entry.id === residentEntryId && entry.type === "message",
			);
			expect(exportSelfContained).toBeDefined();
			expect(exportResident).toBeDefined();
			expectToolArgumentArrayPayload(exportSelfContained as SessionMessageEntry, selfContainedPayload);
			expectToolArgumentPayload(exportResident as SessionMessageEntry, residentPayload);
			expectNoResidentSentinel(reopened.getEntryForFidelity(selfContainedEntryId));
			expectNoResidentSentinel(reopened.getEntryForFidelity(residentEntryId));

			reopened.branch(residentEntryId);
			const context = reopened.buildSessionContext();
			const serialized = JSON.stringify(context.messages);
			expect(serialized).toContain("persisted-self-contained-179");
			expect(serialized).toContain(residentPayload);
			expect(serialized).not.toContain("cold-spill blob unavailable");
			expect(serialized).not.toContain("__gjcResidentBlob");
		} finally {
			await reopened?.close();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("rehydrates mixed resident and self-contained aggregate tool arguments after persisted close and reopen", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cold-spill-mixed-reopen-"));
		let reopened: SessionManager | undefined;
		try {
			const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, root));
			const residentPayload = `mixed-persisted-resident-argument-${"r".repeat(5_000)}`;
			const aggregatePayload = Array.from({ length: 20_000 }, (_, index) => ({
				index,
				text: `mixed-persisted-small-${index}-${"a".repeat(80)}`,
			}));
			const oldAssistantEntryId = session.appendMessage({
				...assistantMessage("mixed-persisted-resident-aggregate"),
				content: [
					{
						type: "toolCall",
						id: "mixed-persisted-resident-aggregate",
						name: "mixed_persisted_resident_aggregate",
						arguments: { resident: { nested: residentPayload }, aggregate: aggregatePayload },
					},
				],
			});
			const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
			const before = session.hotRetainedMessageCharsForTests();

			const result = session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			expect(result.residentTextReadCount).toBe(1);
			expect(result.residentImageReadCount).toBe(0);
			expect(session.hotRetainedMessageCharsForTests()).toBeLessThan(ONE_MIB_CHARS);
			expect(session.hotRetainedMessageCharsForTests()).toBeLessThan(before * 0.05);
			const canonicalAfter = session.getCanonicalEntryForTests(oldAssistantEntryId) as SessionMessageEntry;
			const aggregateRef = canonicalAfter.evictedContent?.payloads["message.content.0.arguments.aggregate"];
			expect(aggregateRef).toBeDefined();
			expectColdBlobSentinelFree(aggregateRef as ColdSpillRef, aggregatePayload);
			const residentRef = canonicalAfter.evictedContent?.payloads["message.content.0.arguments.resident.nested"];
			expect(residentRef).toBeDefined();

			await session.ensureOnDisk();
			await session.rewriteEntries();
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await session.close();

			reopened = await SessionManager.open(sessionFile);
			const fidelity = reopened.getEntryForFidelity(oldAssistantEntryId) as SessionMessageEntry;
			const fidelityArgs = toolCallArguments(fidelity) as {
				resident?: { nested?: unknown };
				aggregate?: unknown;
			};
			expect(fidelityArgs.resident?.nested).toBe(residentPayload);
			expect(fidelityArgs.aggregate).toEqual(aggregatePayload);
			expectNoResidentSentinel(fidelity);
		} finally {
			await reopened?.close();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("creates branched sessions from cold-spill refs without truncating rehydrated content", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cold-spill-branch-"));
		let branch: SessionManager | undefined;
		try {
			const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, root));
			const marker = `branch-cold-marker-${"b".repeat(520_000)}-end`;
			const oldUserId = session.appendMessage({
				role: "user",
				content: [{ type: "text", text: marker }],
				timestamp: Date.now(),
			});
			const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
			session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			await session.ensureOnDisk();
			await session.flush();

			const branchFile = session.createBranchedSession(oldUserId);
			expect(branchFile).toBeString();
			await session.close();

			branch = await SessionManager.open(branchFile!);
			const fidelity = branch.getEntryForFidelity(oldUserId) as SessionMessageEntry;
			expect(messageContentText(fidelity)).toContain(marker);
			expect(messageContentText(fidelity).length).toBeGreaterThan(500_000);
			expect(messageContentText(fidelity)).not.toContain("truncated");
		} finally {
			await branch?.close();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("rehydrates cold-spill refs after a session file rename or move", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cold-spill-rename-"));
		let reopened: SessionManager | undefined;
		try {
			const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, root));
			const marker = `rename-cold-marker-${"r".repeat(520_000)}-end`;
			const oldUserId = session.appendMessage({
				role: "user",
				content: [{ type: "text", text: marker }],
				timestamp: Date.now(),
			});
			const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
			session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			await session.ensureOnDisk();
			await session.flush();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await session.close();

			const movedFile = path.join(root, "moved-session.jsonl");
			fs.renameSync(sessionFile, movedFile);

			reopened = await SessionManager.open(movedFile);
			const fidelity = reopened.getEntryForFidelity(oldUserId) as SessionMessageEntry;
			expect(messageContentText(fidelity)).toContain(marker);
		} finally {
			await reopened?.close();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps branch cold-spill refs rehydratable after deleting the source session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cold-spill-source-delete-"));
		let branch: SessionManager | undefined;
		try {
			const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, root));
			const marker = `source-delete-cold-marker-${"s".repeat(520_000)}-end`;
			const oldUserId = session.appendMessage({
				role: "user",
				content: [{ type: "text", text: marker }],
				timestamp: Date.now(),
			});
			const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
			session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
			await session.ensureOnDisk();
			await session.flush();
			const sourceFile = session.getSessionFile();
			if (!sourceFile) throw new Error("Expected persisted session file");
			const branchFile = session.createBranchedSession(oldUserId);
			expect(branchFile).toBeString();
			await session.close();

			fs.rmSync(sourceFile, { force: true });

			branch = await SessionManager.open(branchFile!);
			const fidelity = branch.getEntryForFidelity(oldUserId) as SessionMessageEntry;
			expect(messageContentText(fidelity)).toContain(marker);
		} finally {
			await branch?.close();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("keeps hot chars bounded for a 10MB fixture", () => {
		const { session, firstKeptEntryId, before } = buildLargeSession(50, false);
		const compactionEntryId = session.appendCompaction("summary", "short", firstKeptEntryId, 123);
		session.evictCompactedContent(firstKeptEntryId, compactionEntryId);
		const after = session.hotRetainedMessageCharsForTests();
		expect(before).toBeGreaterThanOrEqual(10_000_000);
		expect(after).toBeLessThanOrEqual(BASE + 50 * REF_BOUND);
		expect(after).toBeLessThan(ONE_MIB_CHARS);
		expect(after).toBeLessThan(before * 0.05);
	});
});
