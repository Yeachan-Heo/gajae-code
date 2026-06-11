import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@gajae-code/ai";
import type { SessionEntry, SessionMessageEntry } from "../src/compaction/entries";
import { type PruneConfig, pruneToolOutputs } from "../src/compaction/pruning";

let idCounter = 0;

function assistantCallEntry(callId: string, toolName: string, args: Record<string, unknown>): SessionEntry {
	idCounter++;
	return {
		type: "message",
		id: `a-${idCounter}`,
		parentId: null,
		timestamp: new Date(idCounter).toISOString(),
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
			timestamp: idCounter,
		},
	} as SessionEntry;
}

function toolResultEntry(callId: string, toolName: string, sizeChars = 8000, isError = false): SessionMessageEntry {
	idCounter++;
	return {
		type: "message",
		id: `r-${idCounter}`,
		parentId: null,
		timestamp: new Date(idCounter).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: `result-${callId} ${"x ".repeat(Math.floor(sizeChars / 2))}` }],
			isError,
			timestamp: idCounter,
		} as ToolResultMessage,
	} as SessionMessageEntry;
}

function pair(
	entries: SessionEntry[],
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
	sizeChars = 8000,
	isError = false,
): SessionMessageEntry {
	entries.push(assistantCallEntry(callId, toolName, args));
	const result = toolResultEntry(callId, toolName, sizeChars, isError);
	entries.push(result);
	return result;
}

const EAGER: PruneConfig = {
	protectTokens: 0,
	minimumSavings: 0,
	protectedTools: ["skill", "read"],
	staleOverridableTools: ["read"],
};

function prunedIds(entries: SessionEntry[], config: PruneConfig = EAGER): string[] {
	return pruneToolOutputs(entries, config)
		.prunedEntries.map(entry => entry.id)
		.sort();
}

describe("pruning staleness red-team", () => {
	it("orphaned tool results do not crash and fall back to classic pruning/protection", () => {
		const entries: SessionEntry[] = [
			toolResultEntry("missing-read-call", "read"),
			toolResultEntry("missing-bash-call", "bash"),
		];

		expect(() => pruneToolOutputs(entries, EAGER)).not.toThrow();
		expect(prunedIds(entries)).toEqual([]);
	});

	it("different tools targeting the same path do not cross-supersede by path alone", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/shared.ts" });
		const inspect = pair(entries, "c2", "inspect_image", { path: "src/shared.ts" });

		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).not.toContain(read.id);
		expect(ids).not.toContain(inspect.id);
	});

	it("recognizes path, file_path, and filePath variants for read invalidation by edits", () => {
		const entries: SessionEntry[] = [];
		const pathRead = pair(entries, "c1", "read", { path: "src/path.ts" });
		const snakeRead = pair(entries, "c2", "read", { file_path: "src/snake.ts" });
		const camelRead = pair(entries, "c3", "read", { filePath: "src/camel.ts" });
		pair(entries, "c4", "edit", { file_path: "src/path.ts" }, 100);
		pair(entries, "c5", "write", { filePath: "src/snake.ts" }, 100);
		pair(entries, "c6", "apply_patch", { path: "src/camel.ts" }, 100);

		const ids = prunedIds(entries);
		expect(ids).toEqual(expect.arrayContaining([pathRead.id, snakeRead.id, camelRead.id]));
	});

	it("keeps pattern keys order-sensitive for paths arrays", () => {
		const entries: SessionEntry[] = [];
		const first = pair(entries, "c1", "search", { pattern: "needle", paths: ["a", "b"] });
		const reversed = pair(entries, "c2", "search", { pattern: "needle", paths: ["b", "a"] });

		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).not.toContain(first.id);
		expect(ids).not.toContain(reversed.id);
	});

	it("does not stale earlier reads when the later edit result is an error", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		pair(entries, "c2", "edit", { path: "src/a.ts" }, 100, true);

		expect(prunedIds(entries)).not.toContain(read.id);
	});

	it("handles interleaved already-pruned entries without losing staleness decisions", () => {
		const entries: SessionEntry[] = [];
		const oldRead = pair(entries, "c1", "read", { path: "src/a.ts" });
		const alreadyPruned = pair(entries, "c2", "bash", { command: "old" });
		(alreadyPruned.message as ToolResultMessage).prunedAt = 123;
		(alreadyPruned.message as ToolResultMessage).content = [
			{ type: "text", text: "[Output truncated - 100 tokens]" },
		];
		const newRead = pair(entries, "c3", "read", { path: "src/a.ts" });

		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).toContain(oldRead.id);
		expect(ids).not.toContain(alreadyPruned.id);
		expect(ids).not.toContain(newRead.id);
	});

	it("processes a 1000+ entry list within a sanity performance bound", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 550; i++) {
			pair(entries, `c${i}`, "bash", { command: `echo ${i}` }, 200);
		}
		const start = performance.now();
		const result = pruneToolOutputs(entries, { ...EAGER, protectedTools: [], minimumSavings: 0 });
		const elapsedMs = performance.now() - start;

		expect(entries.length).toBeGreaterThan(1000);
		expect(result.prunedCount).toBeGreaterThan(0);
		expect(elapsedMs).toBeLessThan(2000);
	});

	it("for three reads of the same file, only the latest survives protected", () => {
		const entries: SessionEntry[] = [];
		const first = pair(entries, "c1", "read", { path: "src/a.ts" });
		const second = pair(entries, "c2", "read", { path: "src/a.ts" });
		const third = pair(entries, "c3", "read", { path: "src/a.ts" });

		const ids = prunedIds(entries);
		expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
		expect(ids).not.toContain(third.id);
	});

	it("keeps stale protected non-overridable skill output protected inside the protect window", () => {
		const entries: SessionEntry[] = [];
		const oldSkill = pair(entries, "c1", "skill", { path: "skills/x.md" });
		const newSkill = pair(entries, "c2", "skill", { path: "skills/x.md" });

		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).not.toContain(oldSkill.id);
		expect(ids).not.toContain(newSkill.id);
	});
});
