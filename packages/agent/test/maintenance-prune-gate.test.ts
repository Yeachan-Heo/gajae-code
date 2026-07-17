import { describe, expect, test } from "bun:test";
import type { SessionEntry, SessionMessageEntry } from "@gajae-code/agent-core/compaction/entries";
import {
	estimateToolOutputPruneSavings,
	type PruneConfig,
	pruneToolOutputs,
	shouldRunMaintenancePrune,
} from "@gajae-code/agent-core/compaction/pruning";
import type { ToolResultMessage } from "@gajae-code/ai/types";

const timestamp = "2026-06-12T00:00:00.000Z";

function toolEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.parse(timestamp),
		} as ToolResultMessage,
	};
}

function bigText(label: string, lines: number): string {
	return Array.from({ length: lines }, (_, i) => `${label}-${i} ${"x".repeat(60)}`).join("\n");
}

function clone(entries: SessionEntry[]): SessionEntry[] {
	return structuredClone(entries);
}

const config: PruneConfig = {
	protectTokens: 50,
	minimumSavings: 50,
	protectedTools: ["skill", "read"],
	staleOverridableTools: ["read"],
};

function textOf(entry: SessionEntry): string {
	const msg = (entry as SessionMessageEntry).message as ToolResultMessage;
	return msg.content.map(c => (c.type === "text" ? c.text : "")).join("");
}

describe("estimateToolOutputPruneSavings (Finding 13)", () => {
	test("estimates the same savings pruneToolOutputs would achieve, without mutating", () => {
		const entries = [
			toolEntry("old1", bigText("old1", 200)),
			toolEntry("old2", bigText("old2", 200)),
			toolEntry("recent", bigText("recent", 1)),
		];
		const before = textOf(entries[0]!);

		const estimate = estimateToolOutputPruneSavings(entries, config);

		// Non-mutating: original content is intact after estimation.
		expect(textOf(entries[0]!)).toBe(before);
		expect(estimate.tokensSaved).toBeGreaterThan(0);
		expect(estimate.prunableCount).toBeGreaterThan(0);

		// Matches the real (mutating) prune's savings on an identical clone.
		const real = pruneToolOutputs(clone(entries), config);
		expect(estimate.tokensSaved).toBe(real.tokensSaved);
		expect(estimate.prunableCount).toBe(real.prunedCount);
	});

	test("returns zero when total savings are below the configured minimum", () => {
		const entries = [toolEntry("a", bigText("a", 200)), toolEntry("b", bigText("b", 200))];
		const highMin: PruneConfig = { ...config, minimumSavings: 10_000_000 };
		const estimate = estimateToolOutputPruneSavings(entries, highMin);
		expect(estimate.tokensSaved).toBe(0);
		expect(estimate.prunableCount).toBe(0);
	});

	test("uses an explicit relaxed minimum for threshold compaction only", () => {
		const entries = [toolEntry("old1", bigText("old1", 200)), toolEntry("old2", bigText("old2", 200))];
		const highMin: PruneConfig = { ...config, minimumSavings: 10_000_000 };

		expect(estimateToolOutputPruneSavings(entries, highMin).tokensSaved).toBe(0);
		const relaxed = estimateToolOutputPruneSavings(entries, highMin, { relaxedMinimum: 0 });
		expect(relaxed.tokensSaved).toBeGreaterThan(0);
		expect(pruneToolOutputs(entries, highMin, { relaxedMinimum: 0 }).tokensSaved).toBe(relaxed.tokensSaved);
	});
});

describe("shouldRunMaintenancePrune (Finding 13)", () => {
	const base = { enabled: true, estimatedSavings: 30_000, minSavings: 8_000, cacheEpochResetCost: 5_000 };

	test("runs when opted in, savings clear the minimum, and savings beat the cache-epoch reset cost", () => {
		expect(shouldRunMaintenancePrune(base)).toBe(true);
	});

	test("blocked when disabled (default-off)", () => {
		expect(shouldRunMaintenancePrune({ ...base, enabled: false })).toBe(false);
	});

	test("does not run below the savings threshold", () => {
		expect(shouldRunMaintenancePrune({ ...base, estimatedSavings: 7_999 })).toBe(false);
	});

	test("does not run when savings do not exceed the cache-epoch reset cost", () => {
		expect(shouldRunMaintenancePrune({ ...base, estimatedSavings: 30_000, cacheEpochResetCost: 30_000 })).toBe(false);
		expect(shouldRunMaintenancePrune({ ...base, estimatedSavings: 30_000, cacheEpochResetCost: 40_000 })).toBe(false);
	});

	test("no cache means no reset cost, so a large reclaim runs", () => {
		expect(shouldRunMaintenancePrune({ ...base, cacheEpochResetCost: 0 })).toBe(true);
	});
});
