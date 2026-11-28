import { beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@gajae-code/agent-core/compaction/compaction";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import {
	getPreservedOpenAiRemoteCompactionData,
	withOpenAiRemoteCompactionPreserveData,
} from "@gajae-code/agent-core/compaction/openai";
import { getBundledModel } from "@gajae-code/ai/models";
import type { AssistantMessage, Usage } from "@gajae-code/ai/types";

beforeAll(() => {
	if (Bun.env.DEBUG) {
		// Debug logging enabled
	}
});

const timestamp = "2026-11-20T00:00:00.000Z";
const ts = Date.parse(timestamp);

function userEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: text, timestamp: ts },
	} as SessionMessageEntry;
}

function assistantEntry(id: string, text: string, usage?: Usage): SessionMessageEntry {
	const message = {
		role: "assistant",
		content: text,
		stopReason: "stop",
		timestamp: ts,
		...(usage ? { usage } : {}),
	} as unknown as AssistantMessage;
	return { type: "message", id, parentId: null, timestamp, message } as SessionMessageEntry;
}

function makeUsage(input: number): Usage {
	return { input, output: 10, cacheRead: 0, cacheWrite: 0 } as Usage;
}

// Create a long text that simulates a ~1000 token message per message
function longText(id: number): string {
	return `Long response for entry ${id}. `.repeat(100);
}

function buildEntries(lastUsageInput = 50000, turns = 30): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < turns; i++) {
		entries.push(userEntry(`u${i}`, `Query ${i}? ${longText(i)}`));
		const isLast = i === turns - 1;
		entries.push(assistantEntry(`a${i}`, longText(i), isLast ? makeUsage(lastUsageInput) : undefined));
	}
	return entries;
}

describe("preserve data extraction", () => {
	test("extracts OpenAI remote compaction data correctly", () => {
		const preserveData = withOpenAiRemoteCompactionPreserveData(undefined, {
			provider: "openai",
			replacementHistory: [],
			compactionItem: {
				type: "compaction",
				encrypted_content: "encrypted_data",
			},
		});

		const extracted = getPreservedOpenAiRemoteCompactionData(preserveData);
		expect(extracted).toBeDefined();
		expect(extracted?.provider).toBe("openai");
	});
});

describe("canReplayRemoteCompactionPreserveData", () => {
	// This is a private function, so we can't test it directly
	// But we can test its effect through prepareCompaction behavior
	test("OpenAI model can replay OpenAI remote compaction data", () => {
		const openai = getBundledModel("openai", "gpt-5.4");
		if (!openai) throw new Error("Expected openai model");

		const preserveData = withOpenAiRemoteCompactionPreserveData(undefined, {
			provider: "openai",
			replacementHistory: [],
			compactionItem: {
				type: "compaction",
				encrypted_content: "encrypted_data",
			},
		});

		const messages = buildEntries();
		const trailing: SessionEntry[] = [
			...messages,
			{
				type: "compaction",
				id: "comp1",
				parentId: messages[messages.length - 1].id ?? null,
				timestamp,
				summary: "Previous summary",
				firstKeptEntryId: "u0",
				tokensBefore: 10000,
				preserveData,
			} as CompactionEntry,
		];

		const prep = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, {
			activeModel: openai,
			contextWindow: 100000,
		});
		// OpenAI can replay, so it should return undefined (no re-expansion needed)
		expect(prep).toBeUndefined();
	});
});

describe("re-expand trailing remote compaction", () => {
	test("re-expands a trailing compaction when the active model cannot replay it", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-5");
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol");

		if (!claude || !codex) {
			throw new Error("Expected built-in models to exist");
		}

		// Build entries with a message history
		const messages = buildEntries();
		expect(messages.length).toBeGreaterThan(0); // Verify we have messages

		// Create a trailing OpenAI remote compaction (marked with preserveData)
		const trailing: SessionEntry[] = [
			...messages,
			{
				type: "compaction",
				id: "comp1",
				parentId: messages[messages.length - 1].id ?? null,
				timestamp,
				summary: "Previous summary",
				firstKeptEntryId: "u0",
				tokensBefore: 10000,
				preserveData: withOpenAiRemoteCompactionPreserveData(undefined, {
					provider: "openai",
					replacementHistory: [],
					compactionItem: {
						type: "compaction",
						encrypted_content: "encrypted_data",
					},
				}),
			} as CompactionEntry,
		];
		expect(trailing.length).toBe(messages.length + 1);

		// The OpenAI model (codex) that wrote the compaction can read it: nothing to re-expand
		const withOpenAi = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, {
			activeModel: codex,
			contextWindow: 100000,
		});
		expect(withOpenAi).toBeUndefined();

		// A different provider (Claude) cannot read the compaction: should re-expand
		const withClaude = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, {
			activeModel: claude,
			contextWindow: 100000,
		});
		if (!withClaude) {
			console.log("withClaude is undefined");
			console.log("trailing length:", trailing.length);
			console.log("last entry type:", trailing[trailing.length - 1]?.type);
		}
		expect(withClaude).toBeDefined();
		expect(withClaude?.messagesToSummarize.length).toBeGreaterThan(0);
	});

	test("handles trailing compaction with no active model", () => {
		const entries = buildEntries();

		// Create a trailing compaction
		const trailing: SessionEntry[] = [
			...entries,
			{
				type: "compaction",
				id: "comp1",
				parentId: entries[entries.length - 1].id ?? null,
				timestamp,
				summary: "Previous summary",
				firstKeptEntryId: "u0",
				tokensBefore: 10000,
				preserveData: withOpenAiRemoteCompactionPreserveData(undefined, {
					provider: "openai",
					replacementHistory: [],
					compactionItem: {
						type: "compaction",
						encrypted_content: "encrypted_data",
					},
				}),
			} as CompactionEntry,
		];

		// Without an active model, should return undefined (conservative)
		const preparation = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, { contextWindow: 100000 });
		expect(preparation).toBeUndefined();
	});

	test("preserves compaction when model can replay it after model change", () => {
		const openai1 = getBundledModel("openai", "gpt-5.4");
		const openai2 = getBundledModel("openai", "gpt-4");

		if (!openai1 || !openai2) {
			throw new Error("Expected built-in OpenAI models to exist");
		}

		const entries = buildEntries();

		// Create a trailing OpenAI compaction
		const trailing: SessionEntry[] = [
			...entries,
			{
				type: "compaction",
				id: "comp1",
				parentId: entries[entries.length - 1].id ?? null,
				timestamp,
				summary: "Previous summary",
				firstKeptEntryId: "u0",
				tokensBefore: 10000,
				preserveData: withOpenAiRemoteCompactionPreserveData(undefined, {
					provider: "openai",
					replacementHistory: [],
					compactionItem: {
						type: "compaction",
						encrypted_content: "encrypted_data",
					},
				}),
			} as CompactionEntry,
		];

		// Both OpenAI models can replay the compaction
		const prep1 = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, {
			activeModel: openai1,
			contextWindow: 100000,
		});
		expect(prep1).toBeUndefined();

		const prep2 = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, {
			activeModel: openai2,
			contextWindow: 100000,
		});
		expect(prep2).toBeUndefined();
	});

	test("preserves trailing compaction summary during re-expansion for incompatible model", () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!claude) throw new Error("Expected Claude model to exist");

		// Build entries with a message history (using default 30 turns and 50000 tokens)
		const messages = buildEntries();
		const trailingCompactionSummary =
			"Important context from previous summarization: User discussed project architecture and implementation details.";

		// Create a trailing OpenAI remote compaction with meaningful summary
		const trailing: SessionEntry[] = [
			...messages,
			{
				type: "compaction",
				id: "comp1",
				parentId: messages[messages.length - 1].id ?? null,
				timestamp,
				summary: trailingCompactionSummary,
				firstKeptEntryId: "u0",
				tokensBefore: 10000,
				preserveData: withOpenAiRemoteCompactionPreserveData(undefined, {
					provider: "openai",
					replacementHistory: [],
					compactionItem: {
						type: "compaction",
						encrypted_content: "encrypted_data",
					},
				}),
			} as CompactionEntry,
		];

		// Claude cannot replay the OpenAI compaction, so it should trigger re-expansion
		const prep = prepareCompaction(trailing, DEFAULT_COMPACTION_SETTINGS, {
			activeModel: claude,
			contextWindow: 100000,
		});
		expect(prep).toBeDefined();
		// The critical fix: the trailing compaction's summary must be preserved as previousSummary
		expect(prep?.previousSummary).toBe(trailingCompactionSummary);
	});
});
