import { describe, expect, test } from "bun:test";
import { CALLBACK_PREFIX, CallbackTokenStore } from "../src/tokens";

describe("CallbackTokenStore", () => {
	test("round-trips list callback payloads", () => {
		const store = new CallbackTokenStore({ now: () => 100 });
		const data = store.issue({
			action: "sessions_filter",
			filter: "blocked",
			query: "feat x",
			page: 2,
			chatId: "chat-1",
			userId: "user-1",
			ttlMs: 1000,
		});
		expect(data.startsWith(CALLBACK_PREFIX)).toBe(true);
		expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
		const resolved = store.resolve(data, { chatId: "chat-1", userId: "user-1" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.record).toMatchObject({
				action: "sessions_filter",
				filter: "blocked",
				query: "feat x",
				page: 2,
				chatId: "chat-1",
				userId: "user-1",
			});
			expect("sessionId" in resolved.record).toBe(false);
		}
	});
	test("RPC UI/gate tokens are opaque, bound, TTL-expiring, and single-use", () => {
		let now = 100;
		const store = new CallbackTokenStore({ now: () => now });
		const data = store.issue({
			action: "gate_answer",
			gateId: "gate-secret",
			optionIndex: 0,
			answer: "approve-secret",
			idempotencyKey: "idem-secret",
			chatId: "chat-1",
			userId: "user-1",
			ttlMs: 10,
		});
		expect(data.startsWith(CALLBACK_PREFIX)).toBe(true);
		expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
		expect(data).not.toContain("gate-secret");
		expect(data).not.toContain("approve-secret");
		expect(data).not.toContain("idem-secret");
		expect(store.resolve(data, { chatId: "chat-2", userId: "user-1" })).toEqual({ ok: false, reason: "wrong_chat" });
		expect(store.resolve(data, { chatId: "chat-1", userId: "user-2" })).toEqual({ ok: false, reason: "wrong_user" });
		const resolved = store.resolve(data, { chatId: "chat-1", userId: "user-1" });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) throw new Error("expected token");
		store.markUsed(resolved.token);
		expect(store.resolve(data, { chatId: "chat-1", userId: "user-1" })).toEqual({ ok: false, reason: "used" });

		const expiring = store.issue({
			action: "ui_confirm",
			requestId: "request-secret",
			confirmed: true,
			chatId: "chat-1",
			userId: "user-1",
			ttlMs: 10,
		});
		now = 111;
		expect(store.resolve(expiring, { chatId: "chat-1", userId: "user-1" })).toEqual({ ok: false, reason: "expired" });
	});
});
