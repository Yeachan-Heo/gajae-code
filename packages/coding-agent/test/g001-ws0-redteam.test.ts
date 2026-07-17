import { describe, expect, test } from "bun:test";
import { ActionRegistry } from "../src/modes/action-registry";
import { TranscriptItemRegistry, transcriptItemId } from "../src/modes/transcript-item-registry";

describe("G001 WS0 red-team: TranscriptItemRegistry", () => {
	test("keeps simultaneous generations isolated and rejects rebinds for unknown or retired streams", () => {
		const registry = new TranscriptItemRegistry();
		const first = registry.startStream({ promptGeneration: "generation-a", messageOrdinal: 0, source: "first" });
		const second = registry.startStream({ promptGeneration: "generation-b", messageOrdinal: 0, source: "second" });
		expect(first).not.toBe(second);
		expect(registry.resolveSourcePayload(first)?.text).toBe("first");
		expect(registry.resolveSourcePayload(second)?.text).toBe("second");

		expect(
			registry.endStream("stream:unknown:0", {
				kind: "user",
				source: { entryId: "unexpected", text: "must not register" },
			}),
		).toBeUndefined();
		expect(registry.has(transcriptItemId.entry("unexpected"))).toBe(false);
		expect(registry.retireStream(first)).toBe(true);
		expect(
			registry.endStream(first, { kind: "user", source: { entryId: "retired", text: "must not register" } }),
		).toBeUndefined();
		expect(registry.resolveSourcePayload(first)).toBeUndefined();
		expect(registry.has(transcriptItemId.entry("retired"))).toBe(false);
	});

	test("expires aliases on rebuild, removes them on eviction and fully clears them on session switch", () => {
		const registry = new TranscriptItemRegistry();
		const stream = registry.startStream({ promptGeneration: 1, messageOrdinal: 0, source: "draft" });
		const canonical = registry.endStream(stream, {
			kind: "assistant-text",
			source: { entryId: "entry-a", contentIndex: 0, text: "final" },
		});
		expect(canonical).toBe(transcriptItemId.assistantContent("entry-a", 0));
		expect(registry.resolveSourcePayload(stream)?.text).toBe("final");
		expect(registry.evict(stream)).toBe(true);
		expect(registry.canonicalId(stream)).toBeUndefined();
		expect(registry.resolveSourcePayload(stream)).toBeUndefined();

		const rebuiltStream = registry.startStream({ promptGeneration: 2, messageOrdinal: 0, source: "draft" });
		registry.endStream(rebuiltStream, { kind: "user", source: { entryId: "entry-b", text: "final" } });
		registry.rebuild([{ kind: "user", source: { entryId: "entry-c", text: "rebuilt" } }]);
		expect(registry.resolveSourcePayload(rebuiltStream)).toBeUndefined();
		registry.switchSession("session-a");
		expect(registry.has(transcriptItemId.entry("entry-c"))).toBe(false);
		expect(registry.resolveSourcePayload(transcriptItemId.entry("entry-c"))).toBeUndefined();
	});

	test("does not leak coalesced membership across groups and resolves retired ids to nothing", () => {
		const registry = new TranscriptItemRegistry();
		const groupA = registry.coalesceReadGroup("a", { text: "a" }, ["tool-1", "tool-2"]);
		const groupB = registry.coalesceReadGroup("b", { text: "b" }, ["tool-2"]);
		registry.coalesceReadGroup("a", { text: "a-new" }, ["tool-3"]);
		expect(registry.resolveSourcePayload(groupA)).toMatchObject({
			text: "a-new",
			metadata: { groupId: "a", toolCallIds: ["tool-3"] },
		});
		expect(registry.resolveSourcePayload(groupB)).toMatchObject({
			text: "b",
			metadata: { groupId: "b", toolCallIds: ["tool-2"] },
		});

		const aborted = registry.startStream({ promptGeneration: 9, messageOrdinal: 9, source: { text: "partial" } });
		expect(registry.retireStream(aborted)).toBe(true);
		expect(registry.resolveSourcePayload(aborted)).toBeUndefined();
		expect(registry.evict(aborted)).toBe(false);
	});
});

describe("G001 WS0 red-team: ActionRegistry", () => {
	test("rejects duplicate registration and serializes concurrent executions", async () => {
		const errors: string[] = [];
		let started = 0;
		let release: (() => void) | undefined;
		const registry = new ActionRegistry({ context: undefined, showError: id => errors.push(id) });
		const action = {
			id: "app.clear" as const,
			title: "Clear",
			category: "Test",
			domains: ["global"] as const,
			availability: () => true,
			execute: async () => {
				started++;
				await new Promise<void>(resolve => {
					release = resolve;
				});
			},
		};
		registry.register(action);
		expect(() => registry.register(action)).toThrow("Action already registered: app.clear");
		const first = registry.execute("app.clear");
		expect(await registry.execute("app.clear")).toBe(false);
		expect(started).toBe(1);
		release?.();
		expect(await first).toBe(true);
		expect(errors).toEqual([]);
	});

	test("contains throwing availability and rejected execution without invoking unavailable actions", async () => {
		const errors: string[] = [];
		let unavailableCalls = 0;
		const registry = new ActionRegistry({ context: undefined, showError: id => errors.push(id) });
		registry.register({
			id: "app.exit",
			title: "Availability",
			category: "Test",
			domains: ["global"],
			availability: () => {
				throw new Error("predicate failure");
			},
			execute: () => {
				throw new Error("must not execute");
			},
		});
		registry.register({
			id: "app.suspend",
			title: "Unavailable",
			category: "Test",
			domains: ["global"],
			availability: () => false,
			execute: () => {
				unavailableCalls++;
			},
		});
		registry.register({
			id: "app.interrupt",
			title: "Rejecting",
			category: "Test",
			domains: ["global"],
			availability: () => true,
			execute: async () => {
				throw new Error("rejection");
			},
		});
		expect(registry.isAvailable("app.exit")).toBe(false);
		expect(await registry.execute("app.exit")).toBe(false);
		expect(await registry.execute("app.suspend")).toBe(false);
		expect(unavailableCalls).toBe(0);
		expect(await registry.execute("app.interrupt")).toBe(false);
		expect(errors).toEqual([
			"Action app.exit availability failed: predicate failure",
			"Action app.interrupt execution failed: rejection",
		]);
	});
});
