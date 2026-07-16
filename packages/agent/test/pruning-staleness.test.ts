import { describe, expect, it } from "bun:test";
import type { ToolCall, ToolResultMessage } from "@gajae-code/ai";
import { estimateEntryTokens } from "../src/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "../src/compaction/entries";
import {
	DEFAULT_PRUNE_CONFIG,
	type PruneConfig,
	pruneAssistantToolArguments,
	pruneToolOutputs,
} from "../src/compaction/pruning";

/**
 * Staleness-aware pruning: superseded tool results (same target read/searched
 * again later, or a covered file edited later) are pruned before merely-old
 * ones, and superseded `read` results lose their protected-tool immunity while
 * the most recent read per file stays protected.
 */

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

function toolCallBlock(entry: SessionEntry): ToolCall {
	expect(entry.type).toBe("message");
	const message = (entry as SessionMessageEntry).message;
	expect(message.role).toBe("assistant");
	const block = message.role === "assistant" ? message.content[0] : undefined;
	expect(block?.type).toBe("toolCall");
	return block as ToolCall;
}

function argumentSentinel(entry: SessionEntry): Record<string, unknown> {
	return toolCallBlock(entry).arguments;
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

/** A call+result pair appended as two entries. */
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

function prunedIds(entries: SessionEntry[], config: PruneConfig): string[] {
	const result = pruneToolOutputs(entries, config);
	return result.prunedEntries.map(entry => entry.id).sort();
}

describe("staleness supersession ordering", () => {
	it("a later read of the same file supersedes the earlier read (earlier prunable, latest protected)", () => {
		const entries: SessionEntry[] = [];
		const oldRead = pair(entries, "c1", "read", { path: "src/a.ts" });
		const newRead = pair(entries, "c2", "read", { path: "src/a.ts" });
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(oldRead.id);
		expect(ids).not.toContain(newRead.id);
	});

	it("supersedes all-but-latest repeated idempotent bash test commands", () => {
		const entries: SessionEntry[] = [];
		const oldest = pair(entries, "c1", "bash", { command: "bun   test packages/agent" });
		const middle = pair(entries, "c2", "bash", { command: "bun test packages/agent" });
		const latest = pair(entries, "c3", "bash", { command: "bun test packages/agent" });
		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).toContain(oldest.id);
		expect(ids).toContain(middle.id);
		expect(ids).not.toContain(latest.id);
	});

	it("does not supersede idempotent bash commands run from different directories", () => {
		const entries: SessionEntry[] = [];
		const first = pair(entries, "c1", "bash", { command: "bun test packages/agent", cwd: "/repo-a" });
		const second = pair(entries, "c2", "bash", { command: "bun test packages/agent", cwd: "/repo-b" });
		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).not.toContain(first.id);
		expect(ids).not.toContain(second.id);
	});

	it("does not supersede non-allowlisted bash commands", () => {
		const entries: SessionEntry[] = [];
		const oldest = pair(entries, "c1", "bash", { command: "git log --oneline" });
		const latest = pair(entries, "c2", "bash", { command: "git log --oneline" });
		const ids = prunedIds(entries, { ...EAGER, protectTokens: 1_000_000 });
		expect(ids).not.toContain(oldest.id);
		expect(ids).not.toContain(latest.id);
	});

	it("a later containing read range supersedes an earlier contained range", () => {
		const entries: SessionEntry[] = [];
		const contained = pair(entries, "c1", "read", { path: "src/a.ts:50-100" });
		const containing = pair(entries, "c2", "read", { path: "src/a.ts:1-200" });
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(contained.id);
		expect(ids).not.toContain(containing.id);
	});

	it("does not let a bounded bare selector supersede an unseen distant range", () => {
		const entries: SessionEntry[] = [];
		const distant = pair(entries, "c1", "read", { path: "src/a.ts:10000-10050" });
		const bounded = pair(entries, "c2", "read", { path: "src/a.ts:1" });
		const ids = prunedIds(entries, EAGER);
		expect(ids).not.toContain(distant.id);
		expect(ids).not.toContain(bounded.id);
	});

	it("lets a raw read supersede an earlier contained range", () => {
		const entries: SessionEntry[] = [];
		const ranged = pair(entries, "c1", "read", { path: "src/a.ts:10000-10050" });
		const raw = pair(entries, "c2", "read", { path: "src/a.ts:raw" });
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(ranged.id);
		expect(ids).not.toContain(raw.id);
	});

	it("partially overlapping read ranges do not supersede each other", () => {
		const entries: SessionEntry[] = [];
		const first = pair(entries, "c1", "read", { path: "src/a.ts:50-100" });
		const overlap = pair(entries, "c2", "read", { path: "src/a.ts:75-125" });
		const ids = prunedIds(entries, EAGER);
		expect(ids).not.toContain(first.id);
		expect(ids).not.toContain(overlap.id);
	});

	it("uses relaxed minimum for over-threshold pruning without changing the default", () => {
		const entries: SessionEntry[] = [];
		pair(entries, "c1", "read", { path: "src/a.ts" }, 62_000);
		pair(entries, "c2", "read", { path: "src/a.ts" }, 62_000);
		expect(pruneToolOutputs(entries, DEFAULT_PRUNE_CONFIG).prunedCount).toBe(0);
		const result = pruneToolOutputs(entries, DEFAULT_PRUNE_CONFIG, { relaxedMinimum: 0 });
		expect(result.tokensSaved).toBeGreaterThanOrEqual(15_000);
		expect(result.tokensSaved).toBeLessThan(DEFAULT_PRUNE_CONFIG.minimumSavings);
		expect(result.prunedCount).toBe(1);
	});

	it("a later identical search supersedes the earlier one; different patterns are independent", () => {
		const entries: SessionEntry[] = [];
		const oldSearch = pair(entries, "c1", "search", { pattern: "foo", paths: ["src"] });
		const otherSearch = pair(entries, "c2", "search", { pattern: "bar", paths: ["src"] });
		const newSearch = pair(entries, "c3", "search", { pattern: "foo", paths: ["src"] });
		// Use a config protecting nothing but with a window so only stale items are pruned.
		const config: PruneConfig = { ...EAGER, protectTokens: 1_000_000 };
		const ids = prunedIds(entries, config);
		expect(ids).toContain(oldSearch.id);
		expect(ids).not.toContain(otherSearch.id);
		expect(ids).not.toContain(newSearch.id);
	});

	it("delimiter-looking patterns/paths never collide (canonical tuple keys)", () => {
		const entries: SessionEntry[] = [];
		// Historic collision shapes under naive `${name}:${pattern}@${paths.join(",")}` keys:
		const a = pair(entries, "c1", "search", { pattern: "foo@a", paths: ["b"] });
		const b = pair(entries, "c2", "search", { pattern: "foo", paths: ["a@b"] });
		const c = pair(entries, "c3", "search", { pattern: "x", paths: ["a,b"] });
		const d = pair(entries, "c4", "search", { pattern: "x", paths: ["a", "b"] });
		const config: PruneConfig = { ...EAGER, protectTokens: 1_000_000 };
		const ids = prunedIds(entries, config);
		expect(ids).not.toContain(a.id);
		expect(ids).not.toContain(b.id);
		expect(ids).not.toContain(c.id);
		expect(ids).not.toContain(d.id);
	});

	it("a later edit to a file supersedes an earlier read of that file", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		pair(entries, "c2", "edit", { path: "src/a.ts" }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(read.id);
	});

	it("an edit to a different file does not stale the read", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		pair(entries, "c2", "edit", { path: "src/b.ts" }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).not.toContain(read.id);
	});

	it("an apply_patch envelope edit supersedes earlier reads of every patched file", () => {
		const entries: SessionEntry[] = [];
		const readA = pair(entries, "c1", "read", { path: "src/a.ts" });
		const readB = pair(entries, "c2", "read", { path: "src/b.ts" });
		const readC = pair(entries, "c3", "read", { path: "src/c.ts" });
		const envelope = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@",
			"-old",
			"+new",
			"*** Delete File: src/b.ts",
			"*** End Patch",
		].join("\n");
		pair(entries, "c4", "apply_patch", { input: envelope }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(readA.id);
		expect(ids).toContain(readB.id);
		expect(ids).not.toContain(readC.id);
	});

	it("an apply_patch-shaped envelope sent through the edit tool also supersedes reads", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		const envelope = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-old", "+new", "*** End Patch"].join(
			"\n",
		);
		pair(entries, "c2", "edit", { input: envelope }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(read.id);
	});

	it("a Move to: rename destination invalidates earlier reads of that destination", () => {
		const entries: SessionEntry[] = [];
		const readDest = pair(entries, "c1", "read", { path: "src/dest.ts" });
		const envelope = [
			"*** Begin Patch",
			"*** Update File: src/source.ts",
			"*** Move to: src/dest.ts",
			"@@",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");
		pair(entries, "c2", "apply_patch", { input: envelope }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(readDest.id);
	});

	it("a later edit invalidates selector-qualified reads of the same file", () => {
		const entries: SessionEntry[] = [];
		const rangeRead = pair(entries, "c1", "read", { path: "src/a.ts:50-100" });
		const rawRead = pair(entries, "c2", "read", { path: "src/a.ts:2-4:raw" });
		const otherFile = pair(entries, "c3", "read", { path: "src/b.ts:50-100" });
		pair(entries, "c4", "edit", { path: "src/a.ts" }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(rangeRead.id);
		expect(ids).toContain(rawRead.id);
		expect(ids).not.toContain(otherFile.id);
	});

	it("search pagination pages do not supersede each other", () => {
		const entries: SessionEntry[] = [];
		const pageOne = pair(entries, "c1", "search", { pattern: "foo", paths: ["src"] });
		const pageTwo = pair(entries, "c2", "search", { pattern: "foo", paths: ["src"], skip: 20 });
		const config: PruneConfig = { ...EAGER, protectTokens: 1_000_000 };
		const ids = prunedIds(entries, config);
		expect(ids).not.toContain(pageOne.id);
		expect(ids).not.toContain(pageTwo.id);
	});

	it("searches with different result-shaping flags do not supersede each other", () => {
		const entries: SessionEntry[] = [];
		const caseSensitive = pair(entries, "c1", "search", { pattern: "foo", paths: ["src"] });
		const caseInsensitive = pair(entries, "c2", "search", { pattern: "foo", paths: ["src"], i: true });
		const noGitignore = pair(entries, "c3", "search", { pattern: "foo", paths: ["src"], gitignore: false });
		const config: PruneConfig = { ...EAGER, protectTokens: 1_000_000 };
		const ids = prunedIds(entries, config);
		expect(ids).not.toContain(caseSensitive.id);
		expect(ids).not.toContain(caseInsensitive.id);
		expect(ids).not.toContain(noGitignore.id);
	});

	it("an applied ast_edit/resolve result invalidates earlier reads of touched files", () => {
		const entries: SessionEntry[] = [];
		const readA = pair(entries, "c1", "read", { path: "src/a.ts" });
		const readB = pair(entries, "c2", "read", { path: "src/b.ts" });
		// Applied AST edit (direct or via the hidden resolve tool) reports touched files in details.
		entries.push(assistantCallEntry("c3", "resolve", { action: "apply", reason: "Apply." }));
		const resolveResult = toolResultEntry("c3", "resolve", 100);
		(resolveResult.message as ToolResultMessage & { details?: unknown }).details = {
			applied: true,
			files: ["src/a.ts"],
		};
		entries.push(resolveResult);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(readA.id);
		expect(ids).not.toContain(readB.id);
	});

	it("a dry-run (not applied) ast_edit preview does not invalidate reads", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		entries.push(assistantCallEntry("c2", "ast_edit", { paths: ["src/**/*.ts"] }));
		const previewResult = toolResultEntry("c2", "ast_edit", 100);
		(previewResult.message as ToolResultMessage & { details?: unknown }).details = {
			applied: false,
			files: ["src/a.ts"],
		};
		entries.push(previewResult);
		const ids = prunedIds(entries, EAGER);
		expect(ids).not.toContain(read.id);
	});

	it("a resolve apply with nested sourceResultDetails invalidates touched files", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		entries.push(assistantCallEntry("c2", "resolve", { action: "apply", reason: "Apply." }));
		const resolveResult = toolResultEntry("c2", "resolve", 100);
		(resolveResult.message as ToolResultMessage & { details?: unknown }).details = {
			label: "AST Edit",
			sourceResultDetails: { applied: true, files: ["src/a.ts"] },
		};
		entries.push(resolveResult);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(read.id);
	});

	it("a partially applied (errored) AST resolve still invalidates the applied files", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/a.ts" });
		entries.push(assistantCallEntry("c2", "resolve", { action: "apply", reason: "Apply." }));
		const staleApply = toolResultEntry("c2", "resolve", 100, true);
		(staleApply.message as ToolResultMessage & { details?: unknown }).details = {
			sourceResultDetails: { applied: true, files: ["src/a.ts"] },
		};
		entries.push(staleApply);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(read.id);
	});

	it("failed files in a multi-file edit result do not stale their reads", () => {
		const entries: SessionEntry[] = [];
		const readOk = pair(entries, "c1", "read", { path: "src/ok.ts" });
		const readFailed = pair(entries, "c2", "read", { path: "src/failed.ts" });
		const envelope = [
			"*** Begin Patch",
			"*** Update File: src/ok.ts",
			"@@",
			"-a",
			"+b",
			"*** Update File: src/failed.ts",
			"@@",
			"-x",
			"+y",
			"*** End Patch",
		].join("\n");
		entries.push(assistantCallEntry("c3", "apply_patch", { input: envelope }));
		const patchResult = toolResultEntry("c3", "apply_patch", 100);
		(patchResult.message as ToolResultMessage & { details?: unknown }).details = {
			perFileResults: [
				{ path: "src/ok.ts", isError: false },
				{ path: "src/failed.ts", isError: true, errorText: "hash mismatch" },
			],
		};
		entries.push(patchResult);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(readOk.id);
		expect(ids).not.toContain(readFailed.id);
	});

	it("a same-path edit that partly succeeds still invalidates its reads", () => {
		const entries: SessionEntry[] = [];
		const read = pair(entries, "c1", "read", { path: "src/multi.ts" });
		const envelope = ["*** Begin Patch", "*** Update File: src/multi.ts", "@@", "-a", "+b", "*** End Patch"].join(
			"\n",
		);
		entries.push(assistantCallEntry("c2", "apply_patch", { input: envelope }));
		const patchResult = toolResultEntry("c2", "apply_patch", 100);
		// apply_patch emits multiple entries for the same path: an earlier
		// same-path hunk succeeds while a later same-path hunk fails. The file
		// still mutated, so reads of it must be invalidated.
		(patchResult.message as ToolResultMessage & { details?: unknown }).details = {
			perFileResults: [
				{ path: "src/multi.ts", isError: false },
				{ path: "src/multi.ts", isError: true, errorText: "hash mismatch" },
			],
		};
		entries.push(patchResult);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(read.id);
	});

	it("a failed rename hunk does not stale reads of its Move to destination", () => {
		const entries: SessionEntry[] = [];
		const readDest = pair(entries, "c1", "read", { path: "src/dest.ts" });
		const readOk = pair(entries, "c2", "read", { path: "src/ok.ts" });
		const envelope = [
			"*** Begin Patch",
			"*** Update File: src/ok.ts",
			"@@",
			"-a",
			"+b",
			"*** Update File: src/source.ts",
			"*** Move to: src/dest.ts",
			"@@",
			"-x",
			"+y",
			"*** End Patch",
		].join("\n");
		entries.push(assistantCallEntry("c3", "apply_patch", { input: envelope }));
		const patchResult = toolResultEntry("c3", "apply_patch", 100);
		(patchResult.message as ToolResultMessage & { details?: unknown }).details = {
			perFileResults: [
				{ path: "src/ok.ts", isError: false },
				{ path: "src/source.ts", isError: true, errorText: "hash mismatch" },
			],
		};
		entries.push(patchResult);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(readOk.id);
		expect(ids).not.toContain(readDest.id);
	});

	it("a suffix-resolved read is invalidated via its resolvedPath details", () => {
		const entries: SessionEntry[] = [];
		// Read called with a bare filename; tool resolved it to src/foo.ts.
		entries.push(assistantCallEntry("c1", "read", { path: "foo.ts" }));
		const suffixRead = toolResultEntry("c1", "read", 8000);
		(suffixRead.message as ToolResultMessage & { details?: unknown }).details = {
			resolvedPath: "src/foo.ts",
			suffixResolution: { from: "foo.ts", to: "src/foo.ts" },
		};
		entries.push(suffixRead);
		pair(entries, "c2", "edit", { path: "src/foo.ts" }, 100);
		const ids = prunedIds(entries, EAGER);
		expect(ids).toContain(suffixRead.id);
	});

	it("an errored later result does not supersede the earlier success", () => {
		const entries: SessionEntry[] = [];
		const okRead = pair(entries, "c1", "read", { path: "src/a.ts" });
		pair(entries, "c2", "read", { path: "src/a.ts" }, 100, true);
		const ids = prunedIds(entries, EAGER);
		expect(ids).not.toContain(okRead.id);
	});
});

describe("protect-window interaction", () => {
	it("stale results inside the protect window are still prunable; fresh ones are not", () => {
		const entries: SessionEntry[] = [];
		const staleRead = pair(entries, "c1", "read", { path: "src/a.ts" });
		const freshBash = pair(entries, "c2", "bash", { command: "ls" });
		const newRead = pair(entries, "c3", "read", { path: "src/a.ts" });
		// Window large enough that everything is "recent".
		const config: PruneConfig = { ...EAGER, protectTokens: 1_000_000 };
		const ids = prunedIds(entries, config);
		expect(ids).toContain(staleRead.id);
		expect(ids).not.toContain(freshBash.id);
		expect(ids).not.toContain(newRead.id);
	});

	it("non-stale results keep classic window semantics (old beyond window prunable)", () => {
		const entries: SessionEntry[] = [];
		const oldBash = pair(entries, "c1", "bash", { command: "a" }, 60_000);
		const newBash = pair(entries, "c2", "bash", { command: "b" }, 60_000);
		// Each result is ~15k tokens (60k chars / 4). The 10k window is smaller than
		// one result, so only the newest result stays inside the recency window and
		// the older one falls beyond it and is prunable.
		const config: PruneConfig = { ...EAGER, protectTokens: 10_000 };
		const ids = prunedIds(entries, config);
		expect(ids).toContain(oldBash.id);
		expect(ids).not.toContain(newBash.id);
	});

	it("minimumSavings hysteresis still gates staleness pruning", () => {
		const entries: SessionEntry[] = [];
		pair(entries, "c1", "read", { path: "src/a.ts" }, 400);
		pair(entries, "c2", "read", { path: "src/a.ts" }, 400);
		const config: PruneConfig = { ...EAGER, minimumSavings: 50_000 };
		const result = pruneToolOutputs(entries, config);
		expect(result.prunedCount).toBe(0);
		expect(result.prunedEntries).toEqual([]);
	});
});

describe("protected tools", () => {
	it("the most recent read per file is never pruned even with zero protect window", () => {
		const entries: SessionEntry[] = [];
		const reads = ["a", "b", "c"].map(name => pair(entries, `c-${name}`, "read", { path: `src/${name}.ts` }));
		const ids = prunedIds(entries, EAGER);
		for (const read of reads) expect(ids).not.toContain(read.id);
	});

	it("non-overridable protected tools (skill) stay protected even when superseded", () => {
		const entries: SessionEntry[] = [];
		const oldSkill = pair(entries, "c1", "skill", { path: "skills/x.md" });
		pair(entries, "c2", "skill", { path: "skills/x.md" });
		const ids = prunedIds(entries, EAGER);
		expect(ids).not.toContain(oldSkill.id);
	});

	it("default config keeps read in protectedTools and staleOverridableTools", () => {
		expect(DEFAULT_PRUNE_CONFIG.protectedTools).toContain("read");
		expect(DEFAULT_PRUNE_CONFIG.staleOverridableTools).toContain("read");
	});

	it("config without staleOverridableTools behaves like classic protection", () => {
		const entries: SessionEntry[] = [];
		const oldRead = pair(entries, "c1", "read", { path: "src/a.ts" });
		pair(entries, "c2", "read", { path: "src/a.ts" });
		const config: PruneConfig = { protectTokens: 0, minimumSavings: 0, protectedTools: ["read"] };
		const ids = prunedIds(entries, config);
		expect(ids).not.toContain(oldRead.id);
	});
});
describe("assistant edit argument pruning", () => {
	it("detects customWireName apply_patch candidates and prunes stale arguments", () => {
		const entries: SessionEntry[] = [];
		const staleCall = assistantCallEntry("c1", "edit", {
			input: ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-old", "+new", "*** End Patch"].join("\n"),
			payload: "x".repeat(2000),
		});
		toolCallBlock(staleCall).customWireName = "apply_patch";
		entries.push(staleCall, toolResultEntry("c1", "edit", 100));
		pair(entries, "c2", "write", { path: "src/a.ts", content: "new" }, 100);

		const result = pruneAssistantToolArguments(entries, EAGER);

		expect(result.argumentPrunedCount).toBe(1);
		expect(result.argumentTokensSaved).toBeGreaterThan(0);
		expect(result.prunedEntries.map(entry => entry.id)).toEqual([staleCall.id]);
		expect(argumentSentinel(staleCall)).toMatchObject({
			pruned: true,
			reason: "stale_tool_arguments",
			pathHints: ["src/a.ts"],
		});
	});

	it("stales earlier edit arguments only from later successful tool results", () => {
		const entries: SessionEntry[] = [];
		const oldEdit = assistantCallEntry("c1", "edit", {
			path: "src/a.ts",
			old_string: "a",
			new_string: "b".repeat(2000),
		});
		entries.push(oldEdit, toolResultEntry("c1", "edit", 100));
		pair(entries, "c2", "write", { path: "src/a.ts", content: "c" }, 100);

		const result = pruneAssistantToolArguments(entries, EAGER);

		expect(result.argumentPrunedCount).toBe(1);
		expect(argumentSentinel(oldEdit).reason).toBe("stale_tool_arguments");
	});

	it("failed edits do not stale earlier arguments for the same path", () => {
		const entries: SessionEntry[] = [];
		const oldEdit = assistantCallEntry("c1", "edit", {
			path: "src/a.ts",
			old_string: "a",
			new_string: "b".repeat(2000),
		});
		entries.push(oldEdit, toolResultEntry("c1", "edit", 100));
		pair(entries, "c2", "write", { path: "src/a.ts", content: "c" }, 100, true);

		const result = pruneAssistantToolArguments(entries, EAGER);

		expect(result.argumentPrunedCount).toBe(0);
		expect(argumentSentinel(oldEdit).reason).not.toBe("stale_tool_arguments");
	});

	it("keeps the latest edit arguments and ambiguous-path calls", () => {
		const entries: SessionEntry[] = [];
		const ambiguous = assistantCallEntry("c0", "ast_edit", { ops: [{ pat: "foo", out: "bar" }] });
		entries.push(ambiguous, toolResultEntry("c0", "ast_edit", 100));
		const oldEdit = assistantCallEntry("c1", "edit", {
			path: "src/a.ts",
			old_string: "a",
			new_string: "b".repeat(2000),
		});
		entries.push(oldEdit, toolResultEntry("c1", "edit", 100));
		const latestCall = assistantCallEntry("c2", "write", { path: "src/a.ts", content: "c".repeat(2000) });
		entries.push(latestCall, toolResultEntry("c2", "write", 100));

		const result = pruneAssistantToolArguments(entries, EAGER);

		expect(result.argumentPrunedCount).toBe(1);
		expect(result.prunedEntries.map(entry => entry.id)).toEqual([oldEdit.id]);
		expect(argumentSentinel(ambiguous).reason).not.toBe("stale_tool_arguments");
		expect(argumentSentinel(latestCall).reason).not.toBe("stale_tool_arguments");
	});

	it("is idempotent and shrinks assistant token estimates", () => {
		const entries: SessionEntry[] = [];
		const oldEdit = assistantCallEntry("c1", "edit", {
			path: "src/a.ts",
			old_string: "a",
			new_string: "b".repeat(4000),
		});
		entries.push(oldEdit, toolResultEntry("c1", "edit", 100));
		pair(entries, "c2", "write", { path: "src/a.ts", content: "c" }, 100);
		const beforeTokens = estimateEntryTokens(oldEdit);

		const first = pruneAssistantToolArguments(entries, EAGER);
		const afterTokens = estimateEntryTokens(oldEdit);
		const second = pruneAssistantToolArguments(entries, EAGER);

		expect(first.argumentPrunedCount).toBe(1);
		expect(first.argumentTokensSaved).toBeGreaterThan(0);
		expect(afterTokens).toBeLessThan(beforeTokens);
		expect(second).toEqual({ argumentPrunedCount: 0, argumentTokensSaved: 0, prunedEntries: [] });
	});

	it("does not prune a multi-file apply_patch when only one touched file is later mutated", () => {
		const entries: SessionEntry[] = [];
		const multiFile = assistantCallEntry("c1", "apply_patch", {
			input: [
				"*** Begin Patch",
				"*** Update File: src/a.ts",
				"@@",
				"-olda",
				"+newa",
				"*** Update File: src/b.ts",
				"@@",
				"-oldb",
				"+newb",
				"*** End Patch",
			].join("\n"),
			payload: "x".repeat(2000),
		});
		entries.push(multiFile, toolResultEntry("c1", "apply_patch", 100));
		// Later successful write touches ONLY src/a.ts; src/b.ts is still current.
		pair(entries, "c2", "write", { path: "src/a.ts", content: "c" }, 100);

		const result = pruneAssistantToolArguments(entries, EAGER);

		expect(result.argumentPrunedCount).toBe(0);
		expect(argumentSentinel(multiFile).reason).not.toBe("stale_tool_arguments");
	});

	it("prunes a multi-file apply_patch only when every touched file is later mutated", () => {
		const entries: SessionEntry[] = [];
		const multiFile = assistantCallEntry("c1", "apply_patch", {
			input: [
				"*** Begin Patch",
				"*** Update File: src/a.ts",
				"@@",
				"-olda",
				"+newa",
				"*** Update File: src/b.ts",
				"@@",
				"-oldb",
				"+newb",
				"*** End Patch",
			].join("\n"),
			payload: "x".repeat(2000),
		});
		entries.push(multiFile, toolResultEntry("c1", "apply_patch", 100));
		pair(entries, "c2", "write", { path: "src/a.ts", content: "c" }, 100);
		pair(entries, "c3", "write", { path: "src/b.ts", content: "d" }, 100);

		const result = pruneAssistantToolArguments(entries, EAGER);

		expect(result.argumentPrunedCount).toBe(1);
		expect(argumentSentinel(multiFile).reason).toBe("stale_tool_arguments");
	});
});
