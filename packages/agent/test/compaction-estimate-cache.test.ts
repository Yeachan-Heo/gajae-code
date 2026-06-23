import { describe, expect, test } from "bun:test";
import { estimateEntriesTokens, estimateEntryTokens, findCutPoint } from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import {
	estimateOpenAiCompactInputTokens,
	resolveOpenAiCompactInputBudget,
	trimOpenAiCompactInput,
} from "@gajae-code/agent-core/compaction/openai";
import { type PruneConfig, pruneToolOutputs } from "@gajae-code/agent-core/compaction/pruning";
import type { AssistantMessage, Message, ToolResultMessage } from "@gajae-code/ai/types";

const timestamp = "2026-06-12T00:00:00.000Z";

function toolEntry(id: string, toolName: string, text: string, details?: unknown): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.parse(timestamp),
			...(details === undefined ? {} : { details }),
		} as ToolResultMessage,
	};
}

function textForTokens(label: string, repetitions: number): string {
	return Array.from({ length: repetitions }, (_, index) => `${label}-${index} alpha beta gamma delta epsilon`).join(
		"\n",
	);
}

function textOf(entry: SessionMessageEntry): string {
	const content = (entry.message as ToolResultMessage).content;
	return Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
}

function config(overrides: Partial<PruneConfig> = {}): PruneConfig {
	return {
		protectTokens: 0,
		minimumSavings: 0,
		protectedTools: ["skill", "read"],
		staleOverridableTools: ["read"],
		...overrides,
	};
}

function freshEstimateEntryTokens(entry: SessionMessageEntry): number {
	return estimateEntryTokens({ ...entry });
}

describe("entry token cache", () => {
	test("range estimates and cut point remain token-identical, and prune mutation invalidates cache by fingerprint", () => {
		const old = toolEntry("old", "bash", textForTokens("old", 120));
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.parse(timestamp) },
			},
			old,
			{
				type: "message",
				id: "assistant",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse(timestamp),
					content: [{ type: "text", text: "answer" }],
				} as Message,
			},
		];
		const beforeEntryTokens = estimateEntryTokens(old);
		const beforeTotal = estimateEntriesTokens(entries, 0, entries.length);
		expect(beforeTotal).toBe(estimateEntriesTokens(entries, 0, entries.length));
		expect(findCutPoint(entries, 0, entries.length, 1).firstKeptEntryIndex).toBeGreaterThanOrEqual(0);

		const result = pruneToolOutputs(entries, config({ minimumSavings: 0 }));
		expect(result.prunedEntries.map(entry => entry.id)).toContain("old");
		const afterEntryTokens = estimateEntryTokens(old);
		expect(afterEntryTokens).toBe(estimateEntryTokens(old));
		expect(afterEntryTokens).toBeLessThan(beforeEntryTokens);
		expect(estimateEntriesTokens(entries, 0, entries.length)).toBeLessThan(beforeTotal);
	});

	test("assistant tool-call argument insertion order invalidates the exact estimator-fragment fingerprint", () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.parse(timestamp),
			content: [
				{
					type: "toolCall",
					id: "call-order",
					name: "read",
					arguments: { a: 1, long_descriptive_property_name_with_many_tokens: "value with several words" },
				},
			],
		};
		const entry: SessionMessageEntry = { type: "message", id: "assistant-order", parentId: null, timestamp, message };
		const first = estimateEntryTokens(entry);
		const firstFresh = freshEstimateEntryTokens(entry);
		expect(first).toBe(firstFresh);

		message.content[0] = {
			type: "toolCall",
			id: "call-order",
			name: "read",
			arguments: { long_descriptive_property_name_with_many_tokens: "value with several words", a: 1 },
		};
		const secondFresh = freshEstimateEntryTokens(entry);
		expect(JSON.stringify(message.content[0].arguments)).not.toBe(
			JSON.stringify({ a: 1, long_descriptive_property_name_with_many_tokens: "value with several words" }),
		);
		expect(JSON.stringify(message.content[0].arguments).length).toBe(
			JSON.stringify({ a: 1, long_descriptive_property_name_with_many_tokens: "value with several words" }).length,
		);
		expect(secondFresh).toBeGreaterThan(0);
		expect(estimateEntryTokens(entry)).toBe(secondFresh);
	});

	test("entry token fingerprint preserves fragment boundaries and separators", () => {
		const entry: SessionMessageEntry = {
			type: "message",
			id: "boundary",
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [
					{ type: "text", text: "ab" },
					{ type: "text", text: "c" },
				],
				timestamp: Date.parse(timestamp),
			} as Message,
		};
		const first = estimateEntryTokens(entry);
		expect(first).toBe(freshEstimateEntryTokens(entry));

		entry.message = {
			role: "user",
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "bc" },
			],
			timestamp: Date.parse(timestamp),
		} as Message;
		expect(estimateEntryTokens(entry)).toBe(freshEstimateEntryTokens(entry));

		entry.message = {
			role: "user",
			content: [
				{ type: "text", text: "a\u001fb" },
				{ type: "text", text: "c" },
			],
			timestamp: Date.parse(timestamp),
		} as Message;
		expect(estimateEntryTokens(entry)).toBe(freshEstimateEntryTokens(entry));

		entry.message = {
			role: "user",
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b\u001fc" },
			],
			timestamp: Date.parse(timestamp),
		} as Message;
		expect(estimateEntryTokens(entry)).toBe(freshEstimateEntryTokens(entry));
	});

	test("entry token cache remains exactly equal to fresh estimateEntryTokens recomputation for every counted role", () => {
		const messages: Message[] = [
			{ role: "user", content: "user text", timestamp: Date.parse(timestamp) },
			{ role: "developer", content: "developer custom text", timestamp: Date.parse(timestamp) } as Message,
			{
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.parse(timestamp),
				content: [
					{ type: "text", text: "assistant text" },
					{ type: "thinking", thinking: "private thinking" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hello" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "screenshot",
				content: [
					{ type: "text", text: "tool output" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				isError: false,
				timestamp: Date.parse(timestamp),
			},
		];
		const entries: SessionEntry[] = [
			...messages.map(
				(message, index): SessionMessageEntry => ({
					type: "message",
					id: `msg-${index}`,
					parentId: null,
					timestamp,
					message,
				}),
			),
			{
				type: "custom_message",
				id: "custom",
				parentId: null,
				timestamp,
				customType: "note",
				display: false,
				content: "custom message text",
			},
			{
				type: "message",
				id: "bash",
				parentId: null,
				timestamp,
				message: { role: "bashExecution", command: "bun test", output: "ok output" } as unknown as Message,
			},
			{
				type: "message",
				id: "branch",
				parentId: null,
				timestamp,
				message: {
					role: "branchSummary",
					summary: "branch summary text",
					fromId: "root",
					timestamp: Date.parse(timestamp),
				} as unknown as Message,
			},
			{
				type: "message",
				id: "compaction",
				parentId: null,
				timestamp,
				message: {
					role: "compactionSummary",
					summary: "compaction summary text",
					tokensBefore: 10,
					timestamp: Date.parse(timestamp),
				} as unknown as Message,
			},
		];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			expect(estimateEntryTokens(entry)).toBe(freshEstimateEntryTokens(entry));
		}
		expect(estimateEntriesTokens(entries, 0, entries.length)).toBe(
			entries.reduce((total, entry) => total + estimateEntryTokens(entry), 0),
		);
	});
});

describe("digest pruning notices", () => {
	test("minimumSavings boundary uses exact digest notice", () => {
		const old = toolEntry("old", "bash", `${textForTokens("old", 120)}\nError: failed hard\nfinal output tail`, {
			exitCode: 2,
		});
		const thresholdProbe = [
			toolEntry("old", "bash", `${textForTokens("old", 120)}\nError: failed hard\nfinal output tail`, {
				exitCode: 2,
			}),
		];
		const threshold = pruneToolOutputs(thresholdProbe, config({ minimumSavings: 0 })).tokensSaved;

		const belowEntries = [
			toolEntry("old", "bash", `${textForTokens("old", 120)}\nError: failed hard\nfinal output tail`, {
				exitCode: 2,
			}),
		];
		expect(pruneToolOutputs(belowEntries, config({ minimumSavings: threshold + 1 })).prunedCount).toBe(0);

		const atEntries = [
			toolEntry("old", "bash", `${textForTokens("old", 120)}\nError: failed hard\nfinal output tail`, {
				exitCode: 2,
			}),
		];
		const at = pruneToolOutputs(atEntries, config({ minimumSavings: threshold }));
		expect(at.prunedCount).toBe(1);
		expect(textOf(atEntries[0])).toContain("exit=");
		expect(at.tokensSaved).toBe(Math.max(0, estimateEntryTokens(old) - Math.ceil(textOf(atEntries[0]).length / 4)));
	});

	test("digest notice is capped near generic size and generic already-pruned notices replay stably", () => {
		const long = toolEntry(
			"long",
			"search",
			`${textForTokens("search", 100)}\n120 matches in 45 files\nError: ${"x".repeat(1000)}`,
		);
		pruneToolOutputs([long], config());
		const notice = textOf(long);
		const generic = `[Output truncated - ${estimateEntryTokens(toolEntry("fresh", "search", `${textForTokens("search", 100)}\n120 matches in 45 files\nError: ${"x".repeat(1000)}`))} tokens]`;
		expect(Math.ceil(notice.length / 4)).toBeLessThanOrEqual(Math.floor(Math.ceil(generic.length / 4) * 1.25));

		const already = toolEntry("already", "bash", "[Output truncated - 400 tokens]");
		(already.message as ToolResultMessage).prunedAt = 123;
		const replay = pruneToolOutputs([already], config());
		expect(replay.prunedCount).toBe(0);
		expect(textOf(already)).toBe("[Output truncated - 400 tokens]");
	});
});

describe("OpenAI trim sizing", () => {
	test("resolveOpenAiCompactInputBudget reserves output and clamps tiny positive windows", () => {
		expect(resolveOpenAiCompactInputBudget(100, 0)).toBe(85);
		expect(resolveOpenAiCompactInputBudget(100, 20)).toBe(80);
		expect(resolveOpenAiCompactInputBudget(2, 0)).toBe(1);
		expect(resolveOpenAiCompactInputBudget(1, 0)).toBe(1);
		expect(resolveOpenAiCompactInputBudget(10, 20)).toBe(1);
		expect(resolveOpenAiCompactInputBudget(0, 0)).toBe(0);
		expect(resolveOpenAiCompactInputBudget(-5, 0)).toBe(0);
	});

	test("trimOpenAiCompactInput removes suffix items when resolved budget is below full context window", () => {
		const instructions = "compact";
		const contextWindow = 100;
		const budget = resolveOpenAiCompactInputBudget(contextWindow, 20);
		const items: Array<Record<string, unknown>> = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "keep user message" }] },
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "remove developer message ".repeat(8) }],
			},
		];

		expect(estimateOpenAiCompactInputTokens(items, instructions)).toBeLessThanOrEqual(contextWindow);
		expect(estimateOpenAiCompactInputTokens(items, instructions)).toBeGreaterThan(budget);
		expect(trimOpenAiCompactInput(items, contextWindow, instructions)).toEqual(items);
		expect(trimOpenAiCompactInput(items, budget, instructions)).toEqual([items[0]]);
	});

	test("trimOpenAiCompactInput matches full recount across removable scenarios", () => {
		const instructions = "compact these items";
		const scenarios: Array<{ name: string; items: Array<Record<string, unknown>>; budget: number }> = [
			{
				name: "developer suffix",
				budget: 48,
				items: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
					{ type: "message", role: "developer", content: [{ type: "input_text", text: "remove developer one" }] },
					{ type: "message", role: "developer", content: [{ type: "input_text", text: "remove developer two" }] },
				],
			},
			{
				name: "function call output removes paired call",
				budget: 55,
				items: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
					{ type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
					{ type: "function_call_output", call_id: "call-1", output: "large output".repeat(12) },
				],
			},
			{
				name: "custom tool output removes paired call",
				budget: 60,
				items: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
					{ type: "custom_tool_call", call_id: "custom-1", name: "bash", input: "echo hi" },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
					{ type: "custom_tool_call_output", call_id: "custom-1", output: "custom output".repeat(12) },
				],
			},
		];

		for (const scenario of scenarios) {
			const itemLengths = scenario.items.map(item => JSON.stringify(item).length);
			let runningChars = instructions.length;
			for (const length of itemLengths) runningChars += length;
			const simulatedItems = [...scenario.items];
			const simulatedLengths = [...itemLengths];
			function removeAt(index: number): void {
				runningChars -= simulatedLengths[index] ?? 0;
				simulatedItems.splice(index, 1);
				simulatedLengths.splice(index, 1);
				expect(runningChars, scenario.name).toBe(
					instructions.length + simulatedItems.reduce((total, item) => total + JSON.stringify(item).length, 0),
				);
			}
			while (simulatedItems.length > 0 && Math.ceil(runningChars / 4) > scenario.budget) {
				const last = simulatedItems[simulatedItems.length - 1];
				if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") {
					const callId = typeof last.call_id === "string" ? last.call_id : undefined;
					const callType = last.type === "custom_tool_call_output" ? "custom_tool_call" : "function_call";
					removeAt(simulatedItems.length - 1);
					if (callId) {
						const matchingCallIndex = simulatedItems.findLastIndex(
							item => item.type === callType && item.call_id === callId,
						);
						if (matchingCallIndex >= 0) removeAt(matchingCallIndex);
					}
					continue;
				}
				if (
					!last ||
					!(last.type === "function_call_output" || (last.type === "message" && last.role === "developer"))
				)
					break;
				removeAt(simulatedItems.length - 1);
			}

			const trimmed = trimOpenAiCompactInput(scenario.items, scenario.budget, instructions);
			expect(trimmed, scenario.name).toEqual(simulatedItems);
			expect(estimateOpenAiCompactInputTokens(trimmed, instructions), scenario.name).toBe(
				Math.ceil(runningChars / 4),
			);
		}
	});
});
