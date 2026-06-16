import { describe, expect, it } from "bun:test";
import {
	emergencyCompactionReason,
	DEFAULT_EMERGENCY_COMPACTION_LIMITS as LIM,
} from "@gajae-code/agent-core/compaction";
import type { Message } from "@gajae-code/ai";
import { AppendOnlyContextManager, type BuildOptions } from "../src/append-only-context";
import type { AgentContext } from "../src/types";

const BUILD_OPTS: BuildOptions = { intentTracing: false };

function makeContext(): AgentContext {
	return { systemPrompt: ["sys"], messages: [], tools: [] };
}

function message(content: unknown, role: Message["role"] = "user"): Message {
	return { role, content } as Message;
}

function contents(manager: AppendOnlyContextManager): unknown[] {
	return manager.build(makeContext(), BUILD_OPTS).messages.map(m => m.content);
}

function installClearCounter(manager: AppendOnlyContextManager): () => number {
	let clears = 0;
	const originalClear = manager.log.clear.bind(manager.log);
	manager.log.clear = () => {
		clears++;
		originalClear();
	};
	return () => clears;
}

describe("agent memory red-team: F5 append-only rewrite detection", () => {
	it("detects in-place rewrites of nested, array, number, boolean, and null content without ref-equality masking", () => {
		const manager = new AppendOnlyContextManager();
		const clearCount = installClearCounter(manager);
		const synced = [
			message({
				blocks: [{ type: "text", text: "original", score: 1, enabled: true, maybe: "present" }],
				meta: { count: 2, flags: [true, false], empty: null },
			}),
			message(["tail", { nested: { value: 7 } }], "assistant"),
		];

		manager.syncMessages(synced);
		expect(clearCount()).toBe(0);

		const content = synced[0]!.content as unknown as {
			blocks: Array<{ type: string; text: string; score: number; enabled: boolean; maybe: string | null }>;
			meta: { count: number; flags: boolean[]; empty: null | { filled: boolean } };
		};
		content.blocks[0]!.text = "rewritten";
		content.blocks[0]!.score = 99;
		content.blocks[0]!.enabled = false;
		content.blocks[0]!.maybe = null;
		content.meta.count = 3;
		content.meta.flags.push(true);
		content.meta.empty = { filled: true };

		manager.syncMessages(synced);
		expect(clearCount()).toBe(1);
		expect(contents(manager)).toEqual([
			{
				blocks: [{ type: "text", text: "rewritten", score: 99, enabled: false, maybe: null }],
				meta: { count: 3, flags: [true, false, true], empty: { filled: true } },
			},
			["tail", { nested: { value: 7 } }],
		]);
		expect(manager.log.length).toBe(2);
	});

	it("does not rebuild or grow on identical content supplied as new object instances", () => {
		const manager = new AppendOnlyContextManager();
		const clearCount = installClearCounter(manager);
		const first = [
			message({ nested: { value: 1 }, list: [1, true, null] }),
			message({ nested: { value: 2 }, list: [2, false, null] }, "assistant"),
		];
		const second = [
			message({ nested: { value: 1 }, list: [1, true, null] }),
			message({ nested: { value: 2 }, list: [2, false, null] }, "assistant"),
		];

		manager.syncMessages(first);
		manager.syncMessages(second);

		expect(clearCount()).toBe(0);
		expect(manager.log.length).toBe(2);
		expect(contents(manager)).toEqual([
			{ nested: { value: 1 }, list: [1, true, null] },
			{ nested: { value: 2 }, list: [2, false, null] },
		]);
	});

	it("clears and resyncs when a non-seeded provider context compacts to a shorter array", () => {
		const manager = new AppendOnlyContextManager();
		const clearCount = installClearCounter(manager);

		manager.syncMessages([message("one"), message("two", "assistant"), message("three")]);
		manager.syncMessages([message("summary")]);

		expect(clearCount()).toBe(1);
		expect(manager.log.length).toBe(1);
		expect(contents(manager)).toEqual(["summary"]);
	});
});

describe("agent memory red-team: F9 seeded rebase", () => {
	it("rebases instead of throwing when a seeded fork grows then shrinks below last sync while preserving seed prefix", () => {
		const seed = [message("seed-1"), message("seed-2", "assistant")];
		const manager = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		const clearCount = installClearCounter(manager);

		manager.syncMessages([...seed, message("child-1"), message("child-2", "assistant")]);
		expect(contents(manager)).toEqual(["seed-1", "seed-2", "child-1", "child-2"]);

		expect(() => manager.syncMessages([...seed, message("child-1-rebased")])).not.toThrow();
		expect(clearCount()).toBe(1);
		expect(contents(manager)).toEqual(["seed-1", "seed-2", "child-1-rebased"]);

		manager.syncMessages([...seed, message("child-1-rebased"), message("normal-append", "assistant")]);
		expect(contents(manager)).toEqual(["seed-1", "seed-2", "child-1-rebased", "normal-append"]);
	});

	it("rebases instead of throwing after an in-place rewrite of a synced child and then drops seeded binding", () => {
		const seed = [message("seed-1")];
		const manager = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		const clearCount = installClearCounter(manager);
		const child = message({ tool: { calls: [{ id: 1, ok: true, value: null }] } });
		const synced = [...seed, child];

		manager.syncMessages(synced);
		const childContent = child.content as unknown as {
			tool: { calls: Array<{ id: number; ok: boolean; value: null | string }> };
		};
		childContent.tool.calls[0]!.id = 2;
		childContent.tool.calls[0]!.ok = false;
		childContent.tool.calls[0]!.value = "rewritten";

		expect(() => manager.syncMessages(synced)).not.toThrow();
		expect(clearCount()).toBe(1);
		expect(contents(manager)).toEqual(["seed-1", { tool: { calls: [{ id: 2, ok: false, value: "rewritten" }] } }]);

		manager.syncMessages([...synced, message("normal-after-rebase", "assistant")]);
		expect(contents(manager)).toEqual([
			"seed-1",
			{ tool: { calls: [{ id: 2, ok: false, value: "rewritten" }] } },
			"normal-after-rebase",
		]);
	});
});

describe("agent memory red-team: F6 emergency compaction guard", () => {
	const zeroish = { heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 };

	it("uses strict greater-than boundaries for every default emergency limit", () => {
		expect(
			emergencyCompactionReason({
				heapUsedBytes: LIM.heapUsedBytes,
				providerBytes: LIM.providerBytes,
				messageCount: LIM.messageCount,
				imageBytes: LIM.imageBytes,
			}),
		).toBeNull();
		expect(emergencyCompactionReason({ ...zeroish, heapUsedBytes: LIM.heapUsedBytes + 1 })).toBe("heap");
		expect(emergencyCompactionReason({ ...zeroish, providerBytes: LIM.providerBytes + 1 })).toBe("providerBytes");
		expect(emergencyCompactionReason({ ...zeroish, imageBytes: LIM.imageBytes + 1 })).toBe("imageBytes");
		expect(emergencyCompactionReason({ ...zeroish, messageCount: LIM.messageCount + 1 })).toBe("messageCount");
	});

	it("prioritizes heap before provider bytes before image bytes before message count", () => {
		expect(
			emergencyCompactionReason({
				heapUsedBytes: LIM.heapUsedBytes + 1,
				providerBytes: LIM.providerBytes + 1,
				imageBytes: LIM.imageBytes + 1,
				messageCount: LIM.messageCount + 1,
			}),
		).toBe("heap");
		expect(
			emergencyCompactionReason({
				...zeroish,
				providerBytes: LIM.providerBytes + 1,
				imageBytes: LIM.imageBytes + 1,
				messageCount: LIM.messageCount + 1,
			}),
		).toBe("providerBytes");
		expect(
			emergencyCompactionReason({ ...zeroish, imageBytes: LIM.imageBytes + 1, messageCount: LIM.messageCount + 1 }),
		).toBe("imageBytes");
	});

	it("honors custom limits and never triggers on a zero-ish sample", () => {
		const limits = { heapUsedBytes: 10, providerBytes: 20, imageBytes: 30, messageCount: 40 };
		expect(emergencyCompactionReason(zeroish, limits)).toBeNull();
		expect(emergencyCompactionReason({ ...zeroish, heapUsedBytes: 10 }, limits)).toBeNull();
		expect(emergencyCompactionReason({ ...zeroish, heapUsedBytes: 11 }, limits)).toBe("heap");
		expect(emergencyCompactionReason({ ...zeroish, providerBytes: 21 }, limits)).toBe("providerBytes");
		expect(emergencyCompactionReason({ ...zeroish, imageBytes: 31 }, limits)).toBe("imageBytes");
		expect(emergencyCompactionReason({ ...zeroish, messageCount: 41 }, limits)).toBe("messageCount");
	});
});
