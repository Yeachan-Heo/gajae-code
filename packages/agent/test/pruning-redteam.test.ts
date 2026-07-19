import { describe, expect, test } from "bun:test";
import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import {
	type PruneConfig,
	pruneAssistantToolArguments,
	pruneToolOutputs,
} from "@gajae-code/agent-core/compaction/pruning";
import type { ToolCall, ToolResultMessage } from "@gajae-code/ai/types";

const timestamp = "2026-06-11T00:00:00.000Z";

function textForTokens(label: string, repetitions: number): string {
	return Array.from(
		{ length: repetitions },
		(_, index) => `${label}-${index.toString(36)} alpha beta gamma delta`,
	).join("\n");
}

function toolEntry(id: string, toolName: string, text: string, prunedAt?: number): SessionMessageEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: `call-${id}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.parse(timestamp),
	};
	if (prunedAt !== undefined) message.prunedAt = prunedAt;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message,
	};
}

function customEntry(id: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp,
		customType: "redteam-marker",
		data: { id },
	};
}

function assistantEntry(
	id: string,
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.parse(timestamp),
		},
	} as SessionMessageEntry;
}

function toolCallOf(entry: SessionMessageEntry): ToolCall {
	const message = entry.message;
	expect(message.role).toBe("assistant");
	const block = message.role === "assistant" ? message.content[0] : undefined;
	expect(block?.type).toBe("toolCall");
	return block as ToolCall;
}

function textOf(entry: SessionMessageEntry): string {
	const content = (entry.message as ToolResultMessage).content;
	expect(Array.isArray(content)).toBe(true);
	const block = Array.isArray(content) ? content[0] : undefined;
	expect(block?.type).toBe("text");
	return block?.type === "text" ? block.text : "";
}

function tokens(entry: SessionMessageEntry): number {
	return estimateMessageTokensHeuristic(entry.message);
}

function config(overrides: Partial<PruneConfig> = {}): PruneConfig {
	return {
		protectTokens: 0,
		minimumSavings: 0,
		protectedTools: ["skill", "read"],
		...overrides,
	};
}

describe("pruneToolOutputs red-team boundaries", () => {
	test("minimumSavings boundary is strict below and inclusive at the threshold", () => {
		const recent = toolEntry("recent", "bash", "recent guard text");
		const old = toolEntry("old", "bash", textForTokens("old-boundary", 80));
		const thresholdProbe = toolEntry("old", "bash", textForTokens("old-boundary", 80));
		const threshold = pruneToolOutputs([thresholdProbe], config({ minimumSavings: 0 })).tokensSaved;

		const belowEntries = [
			toolEntry("old", "bash", textForTokens("old-boundary", 80)),
			toolEntry("recent", "bash", "recent guard text"),
		];
		const below = pruneToolOutputs(
			belowEntries,
			config({ protectTokens: tokens(recent), minimumSavings: threshold + 1 }),
		);
		expect(below.prunedCount).toBe(0);
		expect(below.tokensSaved).toBe(0);
		expect(below.prunedEntries).toEqual([]);
		expect(textOf(belowEntries[0] as SessionMessageEntry)).not.toStartWith("[Output truncated - ");

		const atEntries = [
			toolEntry("old", "bash", textForTokens("old-boundary", 80)),
			toolEntry("recent", "bash", "recent guard text"),
		];
		const at = pruneToolOutputs(atEntries, config({ protectTokens: tokens(recent), minimumSavings: threshold }));
		expect(at.prunedCount).toBe(1);
		expect(at.tokensSaved).toBe(threshold);
		expect(at.prunedEntries.map(entry => entry.id)).toEqual(["old"]);
		expect(textOf(atEntries[0] as SessionMessageEntry)).toStartWith(`[Output truncated - ${tokens(old)} tokens`);
	});

	test("protect window accumulates newest-first and never prunes newest protected toolResults", () => {
		const old = toolEntry("old", "bash", textForTokens("old", 50));
		const middle = toolEntry("middle", "bash", textForTokens("middle", 50));
		const newest = toolEntry("newest", "bash", textForTokens("newest", 50));
		const entries = [old, middle, newest];

		const result = pruneToolOutputs(entries, config({ protectTokens: tokens(newest) + 1, minimumSavings: 0 }));

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["old"]);
		expect(textOf(old)).toStartWith("[Output truncated - ");
		expect(textOf(middle)).not.toStartWith("[Output truncated - ");
		expect(textOf(newest)).not.toStartWith("[Output truncated - ");
	});

	test("protected tool names are never pruned even when old and large", () => {
		const read = toolEntry("read-old", "read", textForTokens("read", 80));
		const skill = toolEntry("skill-old", "skill", textForTokens("skill", 80));
		const bash = toolEntry("bash-old", "bash", textForTokens("bash", 80));
		const newest = toolEntry("newest", "bash", "newest");
		const result = pruneToolOutputs(
			[read, skill, bash, newest],
			config({ protectTokens: tokens(newest), minimumSavings: 0 }),
		);

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["bash-old"]);
		expect(textOf(read)).not.toStartWith("[Output truncated - ");
		expect(textOf(skill)).not.toStartWith("[Output truncated - ");
		expect(textOf(bash)).toStartWith("[Output truncated - ");
	});

	test("already-pruned entries are not re-pruned and still count toward the protect window", () => {
		const old = toolEntry("old", "bash", textForTokens("old", 50));
		const alreadyPruned = toolEntry("already", "bash", "[Output truncated - 400 tokens]", 12345);
		const newest = toolEntry("newest", "bash", textForTokens("newest", 50));
		const entries = [old, alreadyPruned, newest];

		const result = pruneToolOutputs(
			entries,
			config({ protectTokens: tokens(newest) + tokens(alreadyPruned), minimumSavings: 0 }),
		);

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["old"]);
		expect((alreadyPruned.message as ToolResultMessage).prunedAt).toBe(12345);
		expect(textOf(alreadyPruned)).toBe("[Output truncated - 400 tokens]");
	});

	test("prunedEntries contains exactly mutated entries with preserved ids, truncation notice, and numeric prunedAt", () => {
		const pruneA = toolEntry("prune-a", "bash", textForTokens("a", 40));
		const pruneB = toolEntry("prune-b", "edit", textForTokens("b", 40));
		const newest = toolEntry("newest", "bash", "newest");
		const originalTokens = new Map([
			["prune-a", tokens(pruneA)],
			["prune-b", tokens(pruneB)],
		]);

		const result = pruneToolOutputs(
			[pruneA, customEntry("interleaved"), pruneB, newest],
			config({ protectTokens: tokens(newest), minimumSavings: 0 }),
		);

		expect(result.prunedEntries).toEqual([pruneB, pruneA]);
		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["prune-b", "prune-a"]);
		for (const entry of result.prunedEntries) {
			expect(textOf(entry)).toStartWith(`[Output truncated - ${originalTokens.get(entry.id)} tokens`);
			expect(typeof (entry.message as ToolResultMessage).prunedAt).toBe("number");
		}
		expect(result.prunedEntries.every(entry => textOf(entry).startsWith("[Output truncated - "))).toBe(true);
	});
	test("pruned error results preserve actionable evidence for non-digested tools", () => {
		const failure = toolEntry(
			"edit-failure",
			"edit",
			[
				"Patch application failed.",
				"Edit rejected: 2 anchors do not match the current file.",
				textForTokens("omitted-context", 80),
			].join("\n"),
		);
		(failure.message as ToolResultMessage).isError = true;
		const newest = toolEntry("newest", "bash", "newest");

		const result = pruneToolOutputs([failure, newest], config({ protectTokens: tokens(newest), minimumSavings: 0 }));

		expect(result.prunedEntries).toEqual([failure]);
		expect(textOf(failure)).toContain("error=Patch application failed.");
		expect(textOf(failure)).toContain("[Output truncated - ");
		expect(typeof (failure.message as ToolResultMessage).prunedAt).toBe("number");
	});
	test("mixed batches mutate and count only candidates with exact positive savings", () => {
		const shortError = toolEntry("short-error", "edit", "Patch failed.");
		(shortError.message as ToolResultMessage).isError = true;
		const profitable = toolEntry("profitable", "edit", textForTokens("large-success", 80));
		const shortErrorText = textOf(shortError);
		const profitableBefore = tokens(profitable);

		const result = pruneToolOutputs([shortError, profitable], config({ minimumSavings: 0 }));
		const profitableAfter = tokens(profitable);

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["profitable"]);
		expect(result.prunedCount).toBe(1);
		expect(result.tokensSaved).toBe(profitableBefore - profitableAfter);
		expect(textOf(shortError)).toBe(shortErrorText);
		expect((shortError.message as ToolResultMessage).prunedAt).toBeUndefined();
	});
	test("deterministic mixed-script matrix preserves positive-delta and exact-accounting invariants", () => {
		const scripts = ["ascii error", "오류 실패", "error 💥"] as const;
		const entries = Array.from({ length: 24 }, (_, index) => {
			const repetitions = index % 4 === 0 ? 2 : 20 + index;
			const text = Array.from({ length: repetitions }, () => scripts[index % scripts.length]).join("\n");
			const entry = toolEntry(`matrix-${index}`, index % 3 === 0 ? "bash" : "edit", text);
			(entry.message as ToolResultMessage).isError = index % 2 === 0;
			return entry;
		});
		const before = new Map(entries.map(entry => [entry.id, { text: textOf(entry), tokens: tokens(entry) }] as const));

		const result = pruneToolOutputs(entries, config({ minimumSavings: 0 }));
		let exactSavings = 0;
		const changedIds = new Set(result.prunedEntries.map(entry => entry.id));
		for (const entry of entries) {
			const snapshot = before.get(entry.id);
			expect(snapshot).toBeDefined();
			if (!snapshot) continue;
			if (!changedIds.has(entry.id)) {
				expect(textOf(entry)).toBe(snapshot.text);
				expect((entry.message as ToolResultMessage).prunedAt).toBeUndefined();
				continue;
			}
			const delta = snapshot.tokens - tokens(entry);
			expect(delta).toBeGreaterThan(0);
			if ((entry.message as ToolResultMessage).isError === true) {
				expect(textOf(entry).length).toBeLessThanOrEqual(snapshot.text.length);
			}
			exactSavings += delta;
		}
		expect(result.prunedCount).toBe(changedIds.size);
		expect(result.tokensSaved).toBe(exactSavings);
	});

	test("script-dense and character-expanding error notices remain unchanged", () => {
		for (const [id, text] of [
			["cjk", `오류 ${"실패".repeat(40)}`],
			["emoji", `error ${"💥".repeat(40)}`],
		] as const) {
			const failure = toolEntry(id, "edit", text);
			(failure.message as ToolResultMessage).isError = true;
			const beforeTokens = tokens(failure);

			const result = pruneToolOutputs([failure], config({ minimumSavings: 0 }));

			expect(result).toEqual({ prunedCount: 0, tokensSaved: 0, prunedEntries: [] });
			expect(textOf(failure)).toBe(text);
			expect(tokens(failure)).toBe(beforeTokens);
			expect((failure.message as ToolResultMessage).prunedAt).toBeUndefined();
		}
	});

	test("sanitizes retained error evidence and preserves generic success notice", () => {
		const failure = toolEntry(
			"hostile-error",
			"edit",
			`\u001b[31mPatch failed.\u001b[0m\u0000\n${textForTokens("context", 80)}`,
		);
		(failure.message as ToolResultMessage).isError = true;
		const success = toolEntry("generic-success", "edit", textForTokens("success", 80));
		const successTokens = tokens(success);

		const result = pruneToolOutputs([failure, success], config({ minimumSavings: 0 }));

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["generic-success", "hostile-error"]);
		expect(textOf(failure)).toContain("error=Patch failed.");
		expect(textOf(failure)).not.toContain("\u001b");
		expect(textOf(failure)).not.toContain("\u0000");
		expect(textOf(success)).toBe(`[Output truncated - ${successTokens} tokens]`);
	});
	test("preserves special bash and search digest shapes after sanitization", () => {
		const bash = toolEntry(
			"bash-error",
			"bash",
			`\u001b[31mcommand failed\u001b[0m\n${textForTokens("bash-context", 80)}\nfinal failure`,
		);
		(bash.message as ToolResultMessage).isError = true;
		(bash.message as ToolResultMessage & { details: { exitCode: number } }).details = { exitCode: 17 };
		const search = toolEntry(
			"search-error",
			"search",
			`12 matches in 3 files\nerror: engine failed\n${textForTokens("search-context", 80)}`,
		);
		(search.message as ToolResultMessage).isError = true;

		const result = pruneToolOutputs([bash, search], config({ minimumSavings: 0 }));

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["search-error", "bash-error"]);
		expect(textOf(bash)).toContain("exit=17");
		expect(textOf(bash)).toContain("tail=final failure");
		expect(textOf(bash)).toContain("error=command failed");
		expect(textOf(bash)).not.toContain("\u001b");
		expect(textOf(search)).toContain("matches=12");
		expect(textOf(search)).toContain("files=3");
		expect(textOf(search)).toContain("error=error: engine failed");
	});

	test("multi-block results keep first-text evidence and exact whole-entry savings", () => {
		const failure = toolEntry("multi-block", "edit", "placeholder");
		failure.message = {
			...(failure.message as ToolResultMessage),
			isError: true,
			content: [
				{ type: "image", data: "a".repeat(400), mimeType: "image/png" },
				{ type: "text", text: `Patch failed.\n${textForTokens("first-text", 40)}` },
				{ type: "text", text: textForTokens("later-text", 80) },
			],
		};
		const beforeTokens = tokens(failure);
		const firstTextLength = (
			(failure.message as ToolResultMessage).content as Array<{ type: string; text?: string }>
		).find(block => block.type === "text")?.text?.length;

		const result = pruneToolOutputs([failure], config({ minimumSavings: 0 }));

		expect(result.prunedEntries).toEqual([failure]);
		expect(textOf(failure)).toContain("error=Patch failed.");
		expect(textOf(failure).length).toBeLessThanOrEqual(firstTextLength ?? 0);
		expect(result.tokensSaved).toBe(beforeTokens - tokens(failure));

		const emptyFirst = toolEntry("empty-first", "edit", "placeholder");
		emptyFirst.message = {
			...(emptyFirst.message as ToolResultMessage),
			isError: true,
			content: [
				{ type: "text", text: "" },
				{ type: "text", text: textForTokens("later-error", 80) },
			],
		};
		const emptyFirstContent = (emptyFirst.message as ToolResultMessage).content;
		const excluded = pruneToolOutputs([emptyFirst], config({ minimumSavings: 0 }));
		expect(excluded).toEqual({ prunedCount: 0, tokensSaved: 0, prunedEntries: [] });
		expect((emptyFirst.message as ToolResultMessage).content).toEqual(emptyFirstContent);
		expect((emptyFirst.message as ToolResultMessage).prunedAt).toBeUndefined();
	});

	test("adversarial inputs: empty entries, non-messages, empty content, zero thresholds, and duplicate outputs", () => {
		expect(pruneToolOutputs([], config())).toEqual({ prunedCount: 0, tokensSaved: 0, prunedEntries: [] });

		const empty = toolEntry("empty", "bash", "");
		const duplicateA = toolEntry("dup-a", "bash", textForTokens("duplicate", 40));
		const duplicateB = toolEntry("dup-b", "bash", textForTokens("duplicate", 40));
		const entries: SessionEntry[] = [
			customEntry("start"),
			empty,
			customEntry("middle"),
			duplicateA,
			customEntry("middle-2"),
			duplicateB,
		];
		const result = pruneToolOutputs(entries, config({ protectTokens: 0, minimumSavings: 0 }));

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["dup-b", "dup-a"]);
		expect(result.prunedCount).toBe(2);
		expect(textOf(empty)).toBe("");
		expect((empty.message as ToolResultMessage).prunedAt).toBeUndefined();
		expect(textOf(duplicateA)).toStartWith("[Output truncated - ");
		expect(textOf(duplicateB)).toStartWith("[Output truncated - ");
	});

	test("mutating returned prunedEntries does not make the same entries re-prunable on a second call", () => {
		const old = toolEntry("old", "bash", textForTokens("old", 50));
		const newest = toolEntry("newest", "bash", "newest");
		const entries = [old, newest];

		const first = pruneToolOutputs(entries, config({ protectTokens: tokens(newest), minimumSavings: 0 }));
		expect(first.prunedEntries.map(entry => entry.id)).toEqual(["old"]);
		(first.prunedEntries[0].message as ToolResultMessage).content = [
			{ type: "text", text: "external mutation after pruning" },
		];

		const second = pruneToolOutputs(entries, config({ protectTokens: tokens(newest), minimumSavings: 0 }));
		expect(second).toEqual({ prunedCount: 0, tokensSaved: 0, prunedEntries: [] });
		expect((old.message as ToolResultMessage).prunedAt).toBeNumber();
	});
});

describe("pruneAssistantToolArguments red-team boundaries", () => {
	test("protect window preserves newest stale assistant arguments", () => {
		const stale = assistantEntry("a-old", "call-old", "edit", {
			path: "src/a.ts",
			old_string: "old",
			new_string: "new".repeat(1000),
		});
		const staleResult = toolEntry("old", "edit", "ok");
		const newest = assistantEntry("a-new", "call-new", "write", { path: "src/a.ts", content: "latest" });
		const newestResult = toolEntry("new", "write", "ok");
		const entries: SessionEntry[] = [stale, staleResult, newest, newestResult];

		const result = pruneAssistantToolArguments(
			entries,
			config({ protectTokens: estimateMessageTokensHeuristic(newest.message) + 1, minimumSavings: 0 }),
		);

		expect(result.argumentPrunedCount).toBe(0);
		expect(toolCallOf(stale).arguments).not.toHaveProperty("pruned");
	});

	test("already-pruned assistant arguments are not re-pruned", () => {
		const stale = assistantEntry("a-old", "call-old", "edit", {
			path: "src/a.ts",
			old_string: "old",
			new_string: "new".repeat(1000),
		});
		toolCallOf(stale).arguments = {
			pruned: true,
			reason: "stale_tool_arguments",
			pathHints: ["src/a.ts"],
			originalChars: 4096,
			prunedAt: 123,
		};
		const entries: SessionEntry[] = [
			stale,
			toolEntry("old", "edit", "ok"),
			assistantEntry("a-new", "call-new", "write", { path: "src/a.ts", content: "latest" }),
			toolEntry("new", "write", "ok"),
		];

		const result = pruneAssistantToolArguments(entries, config({ protectTokens: 0, minimumSavings: 0 }));

		expect(result).toEqual({ argumentPrunedCount: 0, argumentTokensSaved: 0, prunedEntries: [] });
		expect(toolCallOf(stale).arguments).toMatchObject({ pruned: true, prunedAt: 123 });
	});
});
