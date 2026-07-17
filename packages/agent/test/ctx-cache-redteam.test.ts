import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@gajae-code/ai";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, shouldCompact } from "../src/compaction/compaction";
import type { SessionEntry } from "../src/compaction/entries";
import { pruneToolOutputs } from "../src/compaction/pruning";

let sequence = 0;
const timestamp = "2026-07-16T00:00:00.000Z";

function message(role: "user" | "assistant", content: string): SessionEntry {
	sequence++;
	return {
		type: "message",
		id: `${role}-${sequence}`,
		parentId: null,
		timestamp,
		message:
			role === "user"
				? { role, content, timestamp: 0 }
				: {
						role,
						content: [{ type: "text", text: content }],
						timestamp: 0,
						stopReason: "stop",
						api: "x",
						provider: "x",
						model: "x",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
	} as SessionEntry;
}

function pair(entries: SessionEntry[], id: string, name: string, arguments_: Record<string, unknown>) {
	entries.push({
		type: "message",
		id: `call-${id}`,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: arguments_ }],
			timestamp: 0,
			stopReason: "toolUse",
			api: "x",
			provider: "x",
			model: "x",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	} as SessionEntry);
	const result = {
		type: "message",
		id: `result-${id}`,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "x ".repeat(8_000) }],
			isError: false,
			timestamp: 0,
		} as ToolResultMessage,
	} as SessionEntry;
	entries.push(result);
	return result;
}

const eager = {
	protectTokens: 1_000_000,
	minimumSavings: 0,
	protectedTools: ["read"],
	staleOverridableTools: ["read"],
};

describe("ctx-cache adversarial compaction and pruning", () => {
	test("honors exact threshold, 66k scaling, oversize keep windows, and invalid windows", () => {
		const settings = {
			...DEFAULT_COMPACTION_SETTINGS,
			reserveTokens: 0,
			keepRecentTokens: 100,
			remoteEnabled: false,
		};
		expect(shouldCompact(85, 100, settings)).toBe(false);
		expect(shouldCompact(86, 100, settings)).toBe(true);
		expect(shouldCompact(1_000, Number.NaN, settings)).toBe(false);

		sequence = 0;
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 260; i++) {
			entries.push(message("user", `u${i} ${"x".repeat(400)}`), message("assistant", `a${i} ${"y".repeat(400)}`));
		}
		const atBoundary = prepareCompaction(entries, settings, { contextWindow: 66_000 });
		expect(atBoundary?.tokenCorrection.keepRecentTokensCorrected).toBe(19_800);
		const oversize = prepareCompaction(
			entries,
			{ ...settings, keepRecentTokens: 1_000_000 },
			{ contextWindow: 66_000 },
		);
		expect(oversize).toBeUndefined();
		expect(
			prepareCompaction(entries, settings, { contextWindow: Number.NaN })?.tokenCorrection.keepRecentTokensCorrected,
		).toBe(100);
		expect(prepareCompaction(entries, settings)?.tokenCorrection.keepRecentTokensCorrected).toBe(100);
	});

	test("does not stale malformed read selectors or shell-operator and cross-cwd bash commands", () => {
		const entries: SessionEntry[] = [];
		const malformed = pair(entries, "r1", "read", { path: "src/a.ts:50-nope" });
		pair(entries, "e1", "edit", { path: "src/a.ts" });
		const chainedOne = pair(entries, "b1", "bash", { command: "bun test && echo done", cwd: "/repo" });
		const chainedTwo = pair(entries, "b2", "bash", { command: "bun test && echo done", cwd: "/repo" });
		const cwdOne = pair(entries, "b3", "bash", { command: "bun test", cwd: "/repo-a" });
		const cwdTwo = pair(entries, "b4", "bash", { command: "bun test", cwd: "/repo-b" });
		const ids = pruneToolOutputs(entries, eager).prunedEntries.map(entry => entry.id);
		expect(ids).not.toContain(malformed.id);
		expect(ids).not.toContain(chainedOne.id);
		expect(ids).not.toContain(chainedTwo.id);
		expect(ids).not.toContain(cwdOne.id);
		expect(ids).not.toContain(cwdTwo.id);
	});
});
