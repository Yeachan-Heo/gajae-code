import { describe, expect, test } from "bun:test";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import {
	estimateToolOutputPruneSavings,
	type PruneConfig,
	pruneToolOutputs,
} from "@gajae-code/agent-core/compaction/pruning";
import type { ToolResultMessage } from "@gajae-code/ai/types";

let sequence = 0;

function assistantCall(callId: string, toolName: string, args: Record<string, unknown>): SessionEntry {
	sequence++;
	return {
		type: "message",
		id: `assistant-${sequence}`,
		parentId: null,
		timestamp: new Date(sequence).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: sequence,
		},
	} as SessionEntry;
}

function result(callId: string, toolName: string, text = "x ".repeat(4_000), isError = false): SessionMessageEntry {
	sequence++;
	return {
		type: "message",
		id: `result-${sequence}`,
		parentId: null,
		timestamp: new Date(sequence).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: sequence,
		} as ToolResultMessage,
	} as SessionMessageEntry;
}

function pair(
	entries: SessionEntry[],
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
	text?: string,
	isError = false,
): SessionMessageEntry {
	entries.push(assistantCall(callId, toolName, args));
	const toolResult = result(callId, toolName, text, isError);
	entries.push(toolResult);
	return toolResult;
}

function user(id: string): SessionEntry {
	sequence++;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(sequence).toISOString(),
		message: { role: "user", content: "continue", timestamp: sequence },
	} as SessionEntry;
}

function textOf(entry: SessionMessageEntry): string {
	const content = (entry.message as ToolResultMessage).content;
	return Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
}

const EAGER: PruneConfig = {
	protectTokens: 0,
	minimumSavings: 0,
	protectedTools: ["read"],
	staleOverridableTools: ["read"],
};

function prunedIds(entries: SessionEntry[]): string[] {
	return pruneToolOutputs(entries, EAGER).prunedEntries.map(entry => entry.id);
}

describe("compaction pruning QA red-team gates", () => {
	test("C1 fences stale and >40k-token outputs in the newest two real turns, and can be disabled", () => {
		const entries: SessionEntry[] = [user("turn-1")];
		const oldRead = pair(entries, "old-read", "read", { path: "src/fence.ts" });
		entries.push(user("turn-2"));
		const newestRead = pair(entries, "new-read", "read", { path: "src/fence.ts" }, "huge ".repeat(30_000));

		expect(pruneToolOutputs(entries, EAGER).prunedEntries).toEqual([]);
		expect(textOf(oldRead)).not.toStartWith("[Output truncated");
		expect(textOf(newestRead)).not.toStartWith("[Output truncated");

		const disabled = pruneToolOutputs(entries, { ...EAGER, protectRecentTurns: 0 });
		expect(disabled.prunedEntries.map(entry => entry.id)).toContain(oldRead.id);

		const oneTurn: SessionEntry[] = [user("only-turn")];
		pair(oneTurn, "one-old", "read", { path: "src/only.ts" });
		pair(oneTurn, "one-new", "read", { path: "src/only.ts" });
		expect(pruneToolOutputs(oneTurn, EAGER).prunedEntries).toEqual([]);
	});

	test("C1 fences exactly two recent turns while pruning a stale third-oldest turn", () => {
		const entries: SessionEntry[] = [user("turn-1")];
		const oldest = pair(entries, "oldest-read", "read", { path: "src/exact-fence.ts" });
		entries.push(user("turn-2"));
		const second = pair(entries, "second-read", "read", { path: "src/exact-fence.ts" });
		entries.push(user("turn-3"));
		const newest = pair(entries, "newest-read", "read", { path: "src/exact-fence.ts" });

		const pruned = pruneToolOutputs(entries, EAGER).prunedEntries.map(entry => entry.id);
		expect(pruned).toContain(oldest.id);
		expect(pruned).not.toContain(second.id);
		expect(pruned).not.toContain(newest.id);
	});

	test("C1 clamps a bashExecution-only turn fence to its oldest boundary", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "bash-boundary",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "bashExecution", command: "bun test", output: "ok" } as never,
			} as SessionEntry,
		];
		const stale = pair(entries, "bash-old", "read", { path: "src/bash-fence.ts" });
		pair(entries, "bash-new", "read", { path: "src/bash-fence.ts" });

		expect(pruneToolOutputs(entries, EAGER).prunedEntries).toEqual([]);
		expect(textOf(stale)).not.toStartWith("[Output truncated");
	});

	test("C2 conservatively supersedes only bounded containing reads and exact repeats", () => {
		for (const [earlierPath, laterPath, supersedes] of [
			["file.ts:301-450", "file.ts:1", false],
			["file.ts:100-200", "file.ts:raw", false],
			["file.ts:50-60", "file.ts:1-500", true],
			["file.ts:50-60", "file.ts:1-500:raw", false],
			["file.ts:2-4:raw", "file.ts:2-4:raw", true],
			["file.ts:5-16", "file.ts:5-16,960-973", false],
			["file.ts:960-973", "file.ts:5-16,960-973", false],
			["file.ts:50-60", "file.ts:1-500:conflicts", false],
			["file.ts:50-60:conflicts", "file.ts:1-500", false],
			["file.ts:50-60:conflicts", "file.ts:50-60:conflicts", true],
			["file.ts:L50-L60", "file.ts:L1-L500", true],
			["file.ts:L50-L60", "file.ts:RAW", false],
		] as const) {
			const entries: SessionEntry[] = [];
			const earlier = pair(entries, `earlier-${earlierPath}`, "read", { path: earlierPath });
			pair(entries, `later-${laterPath}`, "read", { path: laterPath });
			expect(prunedIds(entries).includes(earlier.id), `${earlierPath} <- ${laterPath}`).toBe(supersedes);
		}
	});

	test("C3 artifact notices retain exact reversible originals and the second gate leaves no orphans", () => {
		const entries: SessionEntry[] = [];
		const old = pair(entries, "artifact-old", "bash", { command: "echo old" });
		const artifactResult = pruneToolOutputs(
			entries,
			{ ...EAGER, protectedTools: [] },
			{ artifactRefMaxChars: 64, artifactRef: () => "artifact://1" },
		);
		expect(textOf(old)).toContain("full output: artifact://1]");
		expect(artifactResult.originals).toEqual([
			{
				entryId: old.id,
				toolName: "bash",
				originalText: "x ".repeat(4_000),
				tokens: artifactResult.originals[0]?.tokens,
				complete: true,
			},
		]);

		expect(artifactResult.originals.map(original => original.entryId).sort()).toEqual(
			artifactResult.prunedEntries.map(entry => entry.id).sort(),
		);

		const gatedEntries: SessionEntry[] = [];
		const gated = pair(gatedEntries, "artifact-gated", "bash", { command: "echo gated" }, "small output ".repeat(30));
		const baseline = pruneToolOutputs([result("probe", "bash", "small output ".repeat(30))], {
			...EAGER,
			protectedTools: [],
		});
		let artifactCalls = 0;
		const options = {
			artifactRefMaxChars: 10_000,
			artifactRef: () => {
				artifactCalls++;
				return `artifact://${"x".repeat(9_980)}`;
			},
		};
		const estimate = estimateToolOutputPruneSavings(
			gatedEntries,
			{ ...EAGER, protectedTools: [], minimumSavings: baseline.tokensSaved },
			options,
		);
		const blocked = pruneToolOutputs(
			gatedEntries,
			{ ...EAGER, protectedTools: [], minimumSavings: baseline.tokensSaved },
			options,
		);
		expect(estimate).toEqual({ prunableCount: 0, tokensSaved: 0 });
		expect(artifactCalls).toBe(0);
		expect(blocked.prunedCount).toBe(0);
		expect(blocked.originals).toEqual([]);
		expect(textOf(gated)).toBe("small output ".repeat(30));
	});

	test("C3 propagates artifactRef failures rather than silently losing reversible output", () => {
		const entries: SessionEntry[] = [result("throwing-artifact", "bash")];
		expect(() =>
			pruneToolOutputs(
				entries,
				{ ...EAGER, protectedTools: [] },
				{
					artifactRefMaxChars: 64,
					artifactRef: () => {
						throw new Error("artifact store unavailable");
					},
				},
			),
		).toThrow("artifact store unavailable");
	});

	test("C3 planner failures leave every candidate unmodified", () => {
		const entries = [result("artifact-first", "bash"), result("artifact-second", "bash")];
		const before = entries.map(entry => textOf(entry));
		let calls = 0;
		expect(() =>
			pruneToolOutputs(
				entries,
				{ ...EAGER, protectedTools: [] },
				{
					artifactRefMaxChars: 64,
					artifactRef: original => {
						calls++;
						if (original.entryId === entries[0].id) throw new Error("second planner failed");
						return "artifact://1";
					},
				},
			),
		).toThrow("second planner failed");
		expect(calls).toBe(2);
		expect(entries.map(entry => textOf(entry))).toEqual(before);
		expect(entries.every(entry => (entry.message as ToolResultMessage).prunedAt === undefined)).toBe(true);
	});

	test("C3 rejects dense or malformed artifact references before mutation", () => {
		const dense = result("artifact-dense", "bash");
		const original = textOf(dense);
		expect(() =>
			pruneToolOutputs(
				[dense],
				{ ...EAGER, protectedTools: [] },
				{
					artifactRefMaxChars: 64,
					artifactRef: () => `artifact://${"界".repeat(20)}`,
				},
			),
		).toThrow("numeric artifact://<id>");
		expect(textOf(dense)).toBe(original);
		expect((dense.message as ToolResultMessage).prunedAt).toBeUndefined();
	});

	test("C3 rejects numeric artifact references with trailing line terminators", () => {
		const output = result("artifact-newline", "bash");
		const original = textOf(output);
		expect(() =>
			pruneToolOutputs(
				[output],
				{ ...EAGER, protectedTools: [] },
				{
					artifactRefMaxChars: 64,
					artifactRef: () => "artifact://123\n",
				},
			),
		).toThrow("numeric artifact://<id>");
		expect(textOf(output)).toBe(original);
		expect((output.message as ToolResultMessage).prunedAt).toBeUndefined();
	});

	test("C3 ASCII max-length planning never overstates final savings", () => {
		const estimateEntry = result("artifact-estimate", "bash");
		const actualEntry = result("artifact-actual", "bash");
		const options = { artifactRefMaxChars: 64 };
		const estimate = estimateToolOutputPruneSavings([estimateEntry], { ...EAGER, protectedTools: [] }, options);
		const actual = pruneToolOutputs(
			[actualEntry],
			{ ...EAGER, protectedTools: [] },
			{
				...options,
				artifactRef: () => `artifact://${"1".repeat(53)}`,
			},
		);
		expect(estimate.prunableCount).toBe(1);
		expect(actual.prunedCount).toBe(1);
		expect(actual.tokensSaved).toBeGreaterThanOrEqual(estimate.tokensSaved);
	});

	test("C3 captures all text blocks completely and publishes an artifact notice", () => {
		const output = result("multi-text", "bash");
		(output.message as ToolResultMessage).content = [
			{ type: "text", text: "first block ".repeat(1_000) },
			{ type: "text", text: "second block ".repeat(1_000) },
		];
		let artifactCalls = 0;
		const pruned = pruneToolOutputs(
			[output],
			{ ...EAGER, protectedTools: [] },
			{
				artifactRefMaxChars: 64,
				artifactRef: () => {
					artifactCalls++;
					return "artifact://2";
				},
			},
		);

		expect(artifactCalls).toBe(1);
		expect(pruned.originals).toHaveLength(1);
		expect(pruned.originals[0]).toMatchObject({
			originalText: `${"first block ".repeat(1_000)}\n${"second block ".repeat(1_000)}`,
			complete: true,
		});
		expect(textOf(output)).toContain("full output: artifact://2");
	});

	test("C3 does not publish incomplete image-containing results as full artifacts", () => {
		const output = result("image-result", "bash");
		(output.message as ToolResultMessage).content = [
			{ type: "text", text: "before image ".repeat(1_000) },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{ type: "text", text: "after image ".repeat(1_000) },
		];
		let artifactCalls = 0;
		const pruned = pruneToolOutputs(
			[output],
			{ ...EAGER, protectedTools: [] },
			{
				artifactRefMaxChars: 64,
				artifactRef: () => {
					artifactCalls++;
					return "artifact://must-not-exist";
				},
			},
		);

		expect(artifactCalls).toBe(0);
		expect(pruned.originals[0]).toMatchObject({ complete: false });
		expect(textOf(output)).not.toContain("full output:");
	});

	test("C4 preserves an early error against a 10k-character tail within the absolute digest budget", () => {
		const entries: SessionEntry[] = [];
		const bash = pair(
			entries,
			"error-tail",
			"bash",
			{ command: "false" },
			`ERROR: 磁盘已满\n${"z".repeat(10_000)}`,
			true,
		);
		pruneToolOutputs(entries, { ...EAGER, protectedTools: [] });
		const notice = textOf(bash);
		expect(notice).toContain("error=ERROR: 磁盘已满");
		expect(notice.length).toBeLessThan(700);
		expect(notice).toMatch(/^\[Output truncated - \d+ tokens; exit=1; error=.*\]$/);
	});

	test("C4 compares error notices against all joined text blocks", () => {
		const output = result("multi-block-error", "edit", undefined, true);
		const firstBlock = "error";
		const secondBlock = "details ".repeat(100);
		(output.message as ToolResultMessage).content = [
			{ type: "text", text: firstBlock },
			{ type: "text", text: secondBlock },
		];

		const pruned = pruneToolOutputs([output], { ...EAGER, protectedTools: [] });
		expect(pruned.prunedEntries).toEqual([output]);
		expect(textOf(output).length).toBeGreaterThan(firstBlock.length);
		expect(textOf(output).length).toBeLessThan(`${firstBlock}\n${secondBlock}`.length);
	});
});
