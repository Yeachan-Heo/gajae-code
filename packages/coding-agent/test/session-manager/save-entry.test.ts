import { describe, expect, it } from "bun:test";
import { type CustomEntry, SessionManager } from "@gajae-code/coding-agent/session/session-manager";

function hasUndefinedPlainObjectField(value: unknown): boolean {
	if (value === undefined) return true;
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(item => hasUndefinedPlainObjectField(item));
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).some(item => item === undefined || hasUndefinedPlainObjectField(item));
}

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_hook", { foo: "bar" });

		// Save another message
		const nativeHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
		];
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: nativeHistory },
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find(e => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_hook");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
		if (ctx.messages[1]?.role !== "assistant") throw new Error("Expected assistant message");
		expect(ctx.messages[1].providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai",
			items: nativeHistory,
		});
	});

	it("normalizes optional undefined fields before live session-entry persistence", () => {
		const session = SessionManager.inMemory();

		session.appendModeChange("goal", {
			goal: {
				id: "goal-1",
				objective: "finish issue",
				status: "complete",
				tokensUsed: undefined,
			},
		});
		session.appendCustomMessageEntry(
			"ask.prompt",
			"Choose an option",
			false,
			{
				customInput: undefined,
				selectedOptions: ["Done"],
				nested: { clarificationQuestion: undefined, retained: true },
			},
			"agent",
		);
		session.appendCustomEntry("goal-completed", {
			objective: "finish issue",
			tokensUsed: undefined,
			timeUsedSeconds: undefined,
		});

		const entries = session.getEntries();
		expect(entries).toHaveLength(3);
		expect(entries.some(entry => hasUndefinedPlainObjectField(entry))).toBe(false);
		expect(JSON.stringify(entries)).not.toContain("undefined");
	});
});
