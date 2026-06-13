import { describe, expect, test } from "bun:test";
import { estimateTokens } from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import { type PruneConfig, pruneToolOutputs } from "@gajae-code/agent-core/compaction/pruning";
import type { ToolResultMessage } from "@gajae-code/ai/types";

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

function textOf(entry: SessionMessageEntry): string {
	const content = (entry.message as ToolResultMessage).content;
	expect(Array.isArray(content)).toBe(true);
	const block = Array.isArray(content) ? content[0] : undefined;
	expect(block?.type).toBe("text");
	return block?.type === "text" ? block.text : "";
}

function tokens(entry: SessionMessageEntry): number {
	return estimateTokens(entry.message);
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

		expect(result.prunedEntries.map(entry => entry.id)).toEqual(["dup-b", "dup-a", "empty"]);
		expect(result.prunedCount).toBe(3);
		expect(textOf(empty)).toStartWith("[Output truncated - 0 tokens");
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
