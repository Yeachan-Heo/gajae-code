import { describe, expect, it } from "bun:test";
import { SessionManager } from "../../src/session/session-manager";
import {
	pruneSupersededMaintenanceReminders,
	pruneSupersededVolatileProjectContext,
} from "../../src/session/volatile-context-pruning";

const custom = (id: string, customType: string, content: string) => ({
	id,
	parentId: null,
	timestamp: new Date().toISOString(),
	type: "custom_message" as const,
	customType,
	content,
	display: false,
});

describe("maintenance custom-message pruning", () => {
	it("keeps only the latest volatile project context", () => {
		const entries = [
			custom("one", "volatile-project-context", "old tree"),
			custom("two", "volatile-project-context", "new tree"),
		];
		const result = pruneSupersededVolatileProjectContext(entries);
		expect(result.changed.map(entry => entry.id)).toEqual(["one"]);
		expect(entries[0]?.content).toBe("[superseded volatile context pruned]");
		expect(entries[1]?.content).toBe("new tree");
	});

	it("retires only a prior known singleton reminder", () => {
		const entries = [
			custom("one", "todo-write-error-reminder", "old"),
			custom("two", "goal-reminder", "ordinary context"),
			custom("three", "todo-write-error-reminder", "new"),
		];
		const result = pruneSupersededMaintenanceReminders(entries);
		expect(result.changed.map(entry => entry.id)).toEqual(["one"]);
		expect(entries[0]?.content).toBe("[superseded volatile context pruned]");
		expect(entries[1]?.content).toBe("ordinary context");
		expect(entries[2]?.content).toBe("new");
	});

	it("preserves queued goal continuations because consumed state is not provable", () => {
		const entries = [
			custom("one", "goal-continuation", "continue first"),
			custom("two", "goal-continuation", "continue second"),
		];
		const result = pruneSupersededMaintenanceReminders(entries);
		expect(result.changed).toEqual([]);
		expect(entries.map(entry => entry.content)).toEqual(["continue first", "continue second"]);
	});

	it("does not rehydrate superseded content from a cold-spill marker", () => {
		const manager = SessionManager.create("/tmp", "/tmp");
		const id = manager.appendCustomMessageEntry("volatile-project-context", "old tree", false);
		const canonical = manager.getCanonicalEntryForTests(id);
		if (canonical?.type !== "custom_message") throw new Error("Expected custom message entry");
		canonical.evictedContent = {
			evictedAt: Date.now(),
			reason: "compacted_history",
			compactionEntryId: "compaction",
			firstKeptEntryId: "kept",
			payloads: {},
		};
		const updated = { ...canonical, content: "[superseded volatile context pruned]" };
		manager.applyCustomMessageEntryUpdates([updated]);
		const after = manager.getCanonicalEntryForTests(id);
		expect(after).toMatchObject({ type: "custom_message", content: "[superseded volatile context pruned]" });
		expect((after as typeof canonical).evictedContent).toBeUndefined();
	});
});
