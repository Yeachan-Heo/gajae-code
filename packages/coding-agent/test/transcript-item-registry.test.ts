import { describe, expect, test } from "bun:test";
import { TranscriptItemRegistry, transcriptItemId } from "../src/modes/transcript-item-registry";

describe("TranscriptItemRegistry", () => {
	test("reconciles a selected provisional stream to its canonical entry while retaining its alias", () => {
		const registry = new TranscriptItemRegistry();
		const streaming = { content: [{ type: "text", text: "draft" }] };
		const selectedId = registry.startStream({ promptGeneration: 4, messageOrdinal: 2, source: streaming });
		const persisted = { entryId: "a1", contentIndex: 0, content: [{ type: "text", text: "final" }] };
		const canonicalId = registry.endStream(selectedId, { kind: "assistant-text", source: persisted });

		expect(canonicalId).toBe(transcriptItemId.assistantContent("a1", 0));
		expect(registry.canonicalId(selectedId)).toBe(canonicalId);
		expect(registry.resolveSourcePayload(selectedId)?.text).toBe("final");
		expect(registry.has(selectedId)).toBe(true);
	});

	test("uses the live streaming object for start, delta, and persisted end payloads", () => {
		const registry = new TranscriptItemRegistry();
		const streaming = { content: [{ type: "text", text: "start" }] };
		const id = registry.startStream({ promptGeneration: "turn-1", messageOrdinal: 0, source: streaming });
		expect(id).toBe("stream:turn-1:0");
		expect(registry.resolveSourcePayload(id)?.text).toBe("start");

		streaming.content[0].text = "start + delta";
		expect(registry.resolveSourcePayload(id)?.text).toBe("start + delta");

		registry.endStream(id, {
			kind: "assistant-text",
			source: { entryId: "entry-1", contentIndex: 0, content: [{ type: "text", text: "complete" }] },
		});
		expect(registry.resolveSourcePayload(id)?.text).toBe("complete");
	});

	test("coalesces successive read calls into one group with group metadata", () => {
		const registry = new TranscriptItemRegistry();
		const id = registry.coalesceReadGroup("reads-1", { text: "a.ts\nb.ts" }, ["tool-1"]);
		const sameId = registry.coalesceReadGroup("reads-1", { text: "a.ts\nb.ts\nc.ts" }, ["tool-1", "tool-2"]);

		expect(sameId).toBe(id);
		expect(registry.resolveSourcePayload(id)).toMatchObject({
			text: "a.ts\nb.ts\nc.ts",
			metadata: { groupId: "reads-1", toolCallIds: ["tool-1", "tool-2"] },
		});
		expect(registry.capabilities(id)).toEqual({ copyable: true, foldable: true, rawViewable: true });
	});

	test("rebuild replaces the transcript and expires reconciliation aliases", () => {
		const registry = new TranscriptItemRegistry();
		const streamId = registry.startStream({ promptGeneration: 1, messageOrdinal: 1, source: "draft" });
		registry.endStream(streamId, { kind: "user", source: { entryId: "old", text: "old" } });
		registry.rebuild([{ kind: "user", source: { entryId: "new", text: "new" } }]);

		expect(registry.resolveSourcePayload(streamId)).toBeUndefined();
		expect(registry.resolveSourcePayload(transcriptItemId.entry("old"))).toBeUndefined();
		expect(registry.resolveSourcePayload(transcriptItemId.entry("new"))?.text).toBe("new");
	});

	test("evicts history items and clears all session-local state on a session switch", () => {
		const registry = new TranscriptItemRegistry();
		registry.switchSession("session-a");
		const userId = registry.register({ kind: "user", source: { entryId: "u1", text: "hello" } });
		const toolId = registry.register({ kind: "tool", source: { toolCallId: "t1", text: "result" } });
		expect(registry.evict(userId)).toBe(true);
		expect(registry.has(userId)).toBe(false);
		expect(registry.has(toolId)).toBe(true);

		registry.switchSession("session-b");
		expect(registry.sessionId).toBe("session-b");
		expect(registry.has(toolId)).toBe(false);
	});

	test("retires aborted streams without leaving a resolvable provisional item", () => {
		const registry = new TranscriptItemRegistry();
		const id = registry.startStream({ promptGeneration: 5, messageOrdinal: 3, source: "partial" });
		expect(registry.retireStream(id)).toBe(true);
		expect(registry.resolveSourcePayload(id)).toBeUndefined();
		expect(registry.retireStream(id)).toBe(false);
	});

	test("retires an aborted stream before its generation slot is reused", () => {
		const registry = new TranscriptItemRegistry();
		const first = registry.startStream({ promptGeneration: "generation-1", messageOrdinal: 0, source: "partial" });
		expect(registry.retireStream(first)).toBe(true);

		const replacement = registry.startStream({
			promptGeneration: "generation-1",
			messageOrdinal: 0,
			source: "replacement",
		});
		expect(replacement).toBe(first);
		expect(registry.resolveSourcePayload(replacement)?.text).toBe("replacement");
	});

	test("never reconciles a completed alias or overwrites a conflicting canonical item", () => {
		const registry = new TranscriptItemRegistry();
		const completed = registry.startStream({ promptGeneration: 1, messageOrdinal: 0, source: "draft" });
		const canonical = registry.endStream(completed, {
			kind: "assistant-text",
			source: { entryId: "entry-a", contentIndex: 0, text: "final" },
		});
		expect(
			registry.endStream(completed, { kind: "user", source: { entryId: "wrong", text: "wrong" } }),
		).toBeUndefined();
		expect(registry.resolveSourcePayload(canonical!)?.text).toBe("final");

		const live = registry.startStream({ promptGeneration: 1, messageOrdinal: 1, source: "other draft" });
		expect(
			registry.endStream(live, {
				kind: "assistant-text",
				source: { entryId: "entry-a", contentIndex: 0, text: "collision" },
			}),
		).toBeUndefined();
		expect(registry.resolveSourcePayload(live)?.text).toBe("other draft");
		expect(registry.resolveSourcePayload(canonical!)?.text).toBe("final");
	});
});

test("retains enriched tool result metadata without changing the payload shape", () => {
	const registry = new TranscriptItemRegistry();
	const id = registry.register({
		id: "tool:metadata",
		kind: "tool",
		source: "tool-1",
		getPayload: () => ({
			text: "path: src/file.ts\n✓ done",
			metadata: {
				name: "read",
				arguments: { path: "src/file.ts" },
				intent: "Inspect file",
				isError: false,
				resultText: "",
				hasResult: true,
			},
			source: "tool-1",
		}),
	});
	expect(registry.resolveSourcePayload(id)).toMatchObject({
		text: "path: src/file.ts\n✓ done",
		metadata: { resultText: "", hasResult: true },
	});
});
