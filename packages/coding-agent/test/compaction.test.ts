import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import {
	type CompactionSettings,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateEntryTokens,
	findCutPoint,
	getLastAssistantUsage,
	prepareCompaction,
	type RemoteCompactionFallbackHealthEvent,
	type RemoteCompactionFallbackHealthHooks,
	resolveThresholdTokens,
	shouldCompact,
} from "@gajae-code/agent-core/compaction/compaction";
import * as ai from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { encodeTextSignatureV1 } from "@gajae-code/ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, ProviderPayload, ToolResultMessage, Usage } from "@gajae-code/ai/types";
import { hookFetch } from "@gajae-code/utils";
import {
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/session/session-manager";
import { e2eApiKey } from "./utilities";

// ============================================================================
// Test fixtures
// ============================================================================

async function loadLargeSessionEntries(): Promise<SessionEntry[]> {
	const sessionPath = path.join(import.meta.dirname, "fixtures/large-session.jsonl");
	const content = await Bun.file(sessionPath).text();
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `tool-${entryCounter}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createOpenAiAssistantMessage(
	text: string,
	model: Model,
	usage?: Usage,
	encryptedReasoning: string = "encrypted-reasoning",
	providerPayload?: ProviderPayload,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Reasoning summary",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					encrypted_content: encryptedReasoning,
					summary: [{ type: "summary_text", text: "Reasoning summary" }],
				}),
			},
			{ type: "text", text },
		],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		providerPayload,
		timestamp: Date.now(),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		model: `${provider}/${modelId}`,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		// default mode uses legacy reserve behavior:
		// effective reserve = max(floor(100000 * 0.15), 10000) = 15000, threshold = 85000
		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(86000, 100000, settings)).toBe(true);
		expect(shouldCompact(84000, 100000, settings)).toBe(false);
	});

	it("should use configured threshold percent", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: 90,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(89_000, 100_000, settings)).toBe(false);
		expect(shouldCompact(90_001, 100_000, settings)).toBe(true);
	});

	it("should use legacy reserve behavior when threshold is set to default sentinel", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 30_000,
			keepRecentTokens: 20_000,
		};

		// effective reserve = max(15000, 30000) = 30000, threshold = 70000
		expect(shouldCompact(70_000, 100_000, settings)).toBe(false);
		expect(shouldCompact(70_001, 100_000, settings)).toBe(true);
	});

	it("should return false when strategy is off", () => {
		const settings: CompactionSettings = {
			enabled: true,
			strategy: "off",
			thresholdPercent: 1,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(99_000, 100_000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});

	it("reserves the model's max output budget so input cannot fill the whole window", () => {
		// GPT-5.5-like: 400K total window, 128K reserved max output.
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};

		// Safe input budget = 400K - max(15%*400K=60K, 16384, 128K) = 400K - 128K = 272K.
		expect(resolveThresholdTokens(400_000, settings, 128_000)).toBe(272_000);
		expect(shouldCompact(271_999, 400_000, settings, 128_000)).toBe(false);
		expect(shouldCompact(272_001, 400_000, settings, 128_000)).toBe(true);

		// Separation guard: the same 300K input must NOT pack against the total window
		// when output is reserved (would be allowed if budget == total context).
		expect(shouldCompact(300_000, 400_000, settings, 128_000)).toBe(true);
		expect(shouldCompact(300_000, 400_000, settings, 0)).toBe(false);
	});

	it("ignores max output reservation when it is below the percentage/floor reserve", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		// 8K max output is smaller than the 15% floor (15K) -> threshold unchanged at 85K.
		expect(resolveThresholdTokens(100_000, settings, 8_000)).toBe(85_000);
		expect(resolveThresholdTokens(100_000, settings, 0)).toBe(85_000);
	});
});

describe("remote compaction setting", () => {
	it("forwards an explicit initiator override to local summarization requests", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 2000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 5000, 0))),
			createMessageEntry(createUserMessage("Turn 3")),
			createMessageEntry(createAssistantMessage("Answer 3", createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: false,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy
			.mockResolvedValueOnce(createAssistantMessage("History summary"))
			.mockResolvedValueOnce(createAssistantMessage("Turn prefix summary"));

		await compact(preparation, model, "test-api-key", undefined, undefined, {
			initiatorOverride: "agent",
		});

		expect(completeSimpleSpy).toHaveBeenCalledTimes(2);
		for (const call of completeSimpleSpy.mock.calls) {
			const options = call[2] as { initiatorOverride?: string } | undefined;
			expect(options?.initiatorOverride).toBe("agent");
		}
	});

	it("uses local summarization when remote compaction is disabled", async () => {
		const model = getBundledModel("openai", "gpt-4o");
		if (!model) {
			throw new Error("Expected openai/gpt-4o model to exist");
		}

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 2000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 5000, 0))),
			createMessageEntry(createUserMessage("Turn 3")),
			createMessageEntry(createAssistantMessage("Answer 3", createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: false,
			remoteEndpoint: "https://compaction.example.test/summarize",
		});
		expect(preparation).toBeDefined();
		if (!preparation) {
			throw new Error("Expected compaction preparation");
		}

		const fetchSpy = vi.fn(
			(_input, _init, _next) =>
				new Response(JSON.stringify({ summary: "remote summary" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		using _hook = hookFetch(fetchSpy);
		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(createAssistantMessage("Local history summary"))
			.mockResolvedValueOnce(createAssistantMessage("Local turn summary"));

		const result = await compact(preparation, model, "test-api-key");

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(completeSpy).toHaveBeenCalledTimes(2);
		expect(result.summary).toContain("Local history summary");
		expect(result.shortSummary).toBe("Local history summary");
	});

	it("preserves prior compaction items and encrypted reasoning for OpenAI remote compaction", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) {
			throw new Error("Expected openai/gpt-5.1 model to exist");
		}

		const oldUser = createMessageEntry(createUserMessage("Older turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Older answer"));
		const previousCompaction = createCompactionEntry("Previous summary", oldAssistant.id);
		previousCompaction.preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Previous preserved user" }] },
					{ type: "compaction", encrypted_content: "prior_encrypted" },
				],
				compactionItem: { type: "compaction", encrypted_content: "prior_encrypted" },
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(
				createOpenAiAssistantMessage(
					"Answer 1",
					model,
					createMockUsage(0, 100, 4000, 0),
					"encrypted_reasoning_turn_1",
				),
			),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(
				createOpenAiAssistantMessage(
					"Answer 2",
					model,
					createMockUsage(0, 100, 9000, 0),
					"encrypted_reasoning_turn_2",
				),
			),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		expect(preparation).toBeDefined();
		if (!preparation) {
			throw new Error("Expected compaction preparation");
		}

		const remoteOutput = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Compacted retained user" }] },
			{ type: "compaction", encrypted_content: "new_encrypted" },
		];
		const fetchSpy = vi.fn(
			(_input, _init, _next) =>
				new Response(JSON.stringify({ output: remoteOutput }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		using _hook = hookFetch(fetchSpy);
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy
			.mockResolvedValueOnce(createAssistantMessage("History summary"))
			.mockResolvedValueOnce(createAssistantMessage("Turn prefix summary"))
			.mockResolvedValueOnce(createAssistantMessage("Short summary"));

		const result = await compact(preparation, model, "test-api-key");
		const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(requestBody.input[0]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Previous preserved user" }],
		});
		expect(requestBody.input[1]).toEqual({ type: "compaction", encrypted_content: "prior_encrypted" });
		expect(
			requestBody.input.some(
				item => item.type === "reasoning" && item.encrypted_content === "encrypted_reasoning_turn_1",
			),
		).toBe(true);
		expect(result.summary).toContain("History summary");
		expect(result.preserveData).toEqual({
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: remoteOutput,
				compactionItem: { type: "compaction", encrypted_content: "new_encrypted" },
			},
		});
	});

	it("reports OpenAI remote compaction fallback and recovery through the session-owned health hook", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(
				createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 9000, 0), "encrypted_reasoning"),
			),
			createMessageEntry(createUserMessage("Turn 2")),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchSpy = vi
			.fn()
			.mockReturnValueOnce(new Response("remote down", { status: 500, statusText: "Bad Gateway" }))
			.mockReturnValueOnce(
				new Response(JSON.stringify({ output: { type: "compaction" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockReturnValueOnce(
				new Response(JSON.stringify({ output: [{ type: "message", role: "assistant" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockReturnValueOnce(
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		using _hook = hookFetch(fetchSpy);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Local summary"));
		const events: RemoteCompactionFallbackHealthEvent[] = [];
		const health: RemoteCompactionFallbackHealthHooks = {
			recordRemoteCompactionFallback(event) {
				events.push(event);
			},
		};

		await compact(preparation, model, "test-api-key", undefined, undefined, {
			remoteCompactionFallbackHealth: health,
		});
		await compact(preparation, model, "test-api-key", undefined, undefined, {
			remoteCompactionFallbackHealth: health,
		});
		await compact(preparation, model, "test-api-key", undefined, undefined, {
			remoteCompactionFallbackHealth: health,
		});
		await compact(preparation, model, "test-api-key", undefined, undefined, {
			remoteCompactionFallbackHealth: health,
		});

		expect(events).toEqual([
			{
				kind: "fallback",
				error: "Remote compaction failed (500 Bad Gateway)",
				model: model.id,
				provider: model.provider,
			},
			{
				kind: "fallback",
				error: "Remote compaction response malformed output (outputType=object)",
				model: model.id,
				provider: model.provider,
			},
			{
				kind: "fallback",
				error: "Remote compaction response missing compaction item (rawOutputLength=1, outputTypes=message, replacementHistoryLength=1)",
				model: model.id,
				provider: model.provider,
			},
			{ kind: "success", model: model.id, provider: model.provider },
		]);
	});

	it("does not report remote compaction cancellation as fallback health", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(
				createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 9000, 0), "encrypted_reasoning"),
			),
			createMessageEntry(createUserMessage("Turn 2")),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const abortError = Object.assign(new Error("operation aborted"), { name: "AbortError" });
		const fetchSpy = vi.fn().mockRejectedValueOnce(abortError);
		using _hook = hookFetch(fetchSpy);
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Local summary"));
		const events: RemoteCompactionFallbackHealthEvent[] = [];
		const health: RemoteCompactionFallbackHealthHooks = {
			recordRemoteCompactionFallback(event) {
				events.push(event);
			},
		};

		await expect(
			compact(preparation, model, "test-api-key", undefined, undefined, {
				remoteCompactionFallbackHealth: health,
			}),
		).rejects.toThrow("operation aborted");

		expect(events).toEqual([]);
		expect(completeSpy).not.toHaveBeenCalled();
	});
	it("prefers persisted assistant native history snapshots for OpenAI remote compaction", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const assistantHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Canonical user" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Canonical assistant" }] },
		];
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("generic user that should be replaced")),
			createMessageEntry(
				createOpenAiAssistantMessage(
					"generic assistant that should be replaced",
					model,
					createMockUsage(0, 100, 9000, 0),
					"encrypted_reasoning_turn_1",
					{ type: "openaiResponsesHistory", provider: "openai", items: assistantHistory },
				),
			),
			createMessageEntry(createUserMessage("follow-up user")),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchSpy = vi.fn(
			(_input, _init, _next) =>
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		using _hook = hookFetch(fetchSpy);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key");
		const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};

		expect(requestBody.input).toEqual([
			...assistantHistory,
			{ type: "message", role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("uses the ChatGPT Codex compact endpoint for openai-codex models", async () => {
		const baseModel = getBundledModel("openai", "gpt-5.1");
		if (!baseModel) throw new Error("Expected openai/gpt-5.1 model to exist");

		const model: Model = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchSpy = vi.fn(
			(_input, _init, _next) =>
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		using _hook = hookFetch(fetchSpy);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
	});

	it("preserves codex assistant text signature metadata in remote compaction history", async () => {
		const baseModel = getBundledModel("openai", "gpt-5.1");
		if (!baseModel) throw new Error("Expected openai/gpt-5.1 model to exist");

		const model: Model = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Answer 1",
					textSignature: encodeTextSignatureV1("msg_original", "commentary"),
				},
			],
			usage: createMockUsage(0, 100, 9000, 0),
			stopReason: "stop",
			timestamp: Date.now(),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};

		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Turn 1")), createMessageEntry(assistant)];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchSpy = vi.fn(
			(_input, _init, _next) =>
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		using _hook = hookFetch(fetchSpy);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key");
		const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};
		const assistantItem = requestBody.input.find(item => item.type === "message" && item.role === "assistant");

		expect(assistantItem).toMatchObject({
			type: "message",
			role: "assistant",
			id: "msg_original",
			phase: "commentary",
		});
	});

	it("filters remote compact output and uses explicit remote instructions", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const remoteOutput = [
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "stale developer" }] },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "<system-reminder>wrapped</system-reminder>" }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Real preserved user" }] },
			{ type: "reasoning", encrypted_content: "secret" },
			{ type: "function_call_output", call_id: "call_1", output: "ignored" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Kept assistant" }] },
			{ type: "compaction", encrypted_content: "new_encrypted" },
		];
		const fetchSpy = vi.fn(
			(_input, _init, _next) =>
				new Response(JSON.stringify({ output: remoteOutput }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		using _hook = hookFetch(fetchSpy);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		const result = await compact(preparation, model, "test-api-key", undefined, undefined, {
			remoteInstructions: "BASE INSTRUCTIONS",
		});
		const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
			instructions: string;
		};

		expect(requestBody.instructions).toBe("BASE INSTRUCTIONS");
		expect(result.preserveData).toEqual({
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Real preserved user" }] },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Kept assistant" }] },
					{ type: "compaction", encrypted_content: "new_encrypted" },
				],
				compactionItem: { type: "compaction", encrypted_content: "new_encrypted" },
			},
		});
	});

	it("clears stale OpenAI remote preserve data when local compaction runs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const oldUser = createMessageEntry(createUserMessage("Older turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Older answer"));
		const previousCompaction = createCompactionEntry("Previous summary", oldAssistant.id);
		previousCompaction.preserveData = {
			otherState: "keep-me",
			openaiRemoteCompaction: {
				replacementHistory: [{ type: "compaction", encrypted_content: "stale_encrypted" }],
				compactionItem: { type: "compaction", encrypted_content: "stale_encrypted" },
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 4000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 9000, 0))),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy
			.mockResolvedValueOnce(createAssistantMessage("History summary"))
			.mockResolvedValueOnce(createAssistantMessage("Turn prefix summary"))
			.mockResolvedValueOnce(createAssistantMessage("Short summary"));

		const result = await compact(preparation, model, "test-api-key");

		expect(result.preserveData).toEqual({ otherState: "keep-me" });
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});

	it("keeps the latest assistant/tool-result pair when the newest entry is an uncuttable tool result", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1")),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("A2")),
			createMessageEntry(createToolResultMessage("x".repeat(10_000))),
		];

		const result = findCutPoint(entries, 0, entries.length, 1);

		expect(result.firstKeptEntryIndex).toBe(3);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(2);
	});
	it("counts custom-message content when retaining the recent context window", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("old turn")),
			{
				type: "custom_message",
				id: "custom-context",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "goal-context",
				content: "x".repeat(400),
				display: false,
			},
			createMessageEntry(createUserMessage("new turn")),
		];

		expect(estimateEntryTokens(entries[1]!)).toBeGreaterThanOrEqual(100);
		expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(1);
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.models.default).toBe("anthropic/claude-sonnet-4-5");
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0].role).toBe("compactionSummary");
		expect((loaded.messages[0] as any).summary).toContain("Summary of 1,a,2,b");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// Issue #849: explicit model_change wins over assistant-message inference.
		expect(loaded.models.default).toBe("openai/gpt-4");
		expect(loaded.thinkingLevel).toBe("high");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should find cut point in large session", async () => {
		const entries = await loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = await loadLargeSessionEntries();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, e2eApiKey("ANTHROPIC_API_KEY")!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = await loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, e2eApiKey("ANTHROPIC_API_KEY")!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});
