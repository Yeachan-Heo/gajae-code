import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramRemoteNotifier } from "../src/notifier";
import { STATE_FILE_NAME, SubscriptionStore } from "../src/subscriptions";
import type { ChatReply, CoordinationStatus, SessionStatus, WatchEventsResult } from "../src/types";
import { FakeCoordinatorClient } from "./helpers";

function statusFor(sessionId = "sess-1", status: SessionStatus = "blocked", name = "Safe Name"): CoordinationStatus {
	const turnStatus = status === "waiting_for_input" ? "waiting_for_answer" : status === "done" ? "completed" : status;
	return {
		ok: true,
		sessions: [{ session_id: sessionId, branch: name }],
		sessionStates: [
			{
				session_id: sessionId,
				state: status === "blocked" ? "blocked" : "running",
				live: true,
				updated_at: "2026-06-15T00:00:00.000Z",
			},
		],
		turns: [{ session_id: sessionId, status: turnStatus, turn_id: "turn-1" }],
	};
}

async function makeStore(): Promise<{ store: SubscriptionStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "gtr-notifier-"));
	return { store: await SubscriptionStore.open({ stateDir: dir, now: () => 1_000_000 }), dir };
}

function result(events: WatchEventsResult["events"], latestSeq = events.at(-1)?.seq ?? 0): WatchEventsResult {
	return { ok: true, events, latestSeq, timedOut: false };
}

function makeOutbound(script: Array<{ ok: boolean; retryAfterMs?: number }> = []) {
	return {
		sends: [] as Array<{ chatId: string; reply: ChatReply }>,
		sleeps: [] as number[],
		async send(message: { chatId: string; reply: ChatReply }) {
			this.sends.push(message);
			return script.shift() ?? { ok: true };
		},
	};
}

async function runOnce(notifier: TelegramRemoteNotifier): Promise<void> {
	await (notifier as unknown as { pollDrain(timeoutMs: number): Promise<boolean> }).pollDrain(1);
}

describe("TelegramRemoteNotifier", () => {
	test("empty timeout with higher latestSeq does not advance cursor", async () => {
		const { store } = await makeStore();
		const coordinator = new FakeCoordinatorClient();
		coordinator.watchScript = [{ ok: true, events: [], latestSeq: 99, timedOut: true }];
		const outbound = makeOutbound();
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(store.getCursor()).toBe(0);
	});

	test("full pages drain and cursor advances only through returned processed seqs", async () => {
		const { store } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = statusFor();
		coordinator.watchScript = [
			result(
				Array.from({ length: 100 }, (_, i) => ({
					seq: i + 1,
					kind: "session.state_changed",
					sessionId: i === 0 ? "sess-1" : null,
				})),
				1000,
			),
			result(
				Array.from({ length: 100 }, (_, i) => ({ seq: i + 101, kind: "session.state_changed", sessionId: null })),
				1000,
			),
			result(
				Array.from({ length: 50 }, (_, i) => ({ seq: i + 201, kind: "session.state_changed", sessionId: null })),
				1000,
			),
		];
		const outbound = makeOutbound();
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(store.getCursor()).toBe(250);
		expect(coordinator.countOf("watchEvents")).toBe(3);
	});

	test("same session and state in one drain sends once", async () => {
		const { store } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = statusFor();
		coordinator.watchScript = [
			result([
				{ seq: 1, kind: "session.state_changed", sessionId: "sess-1" },
				{ seq: 2, kind: "turn.waiting_for_answer", sessionId: "sess-1" },
			]),
		];
		const outbound = makeOutbound();
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(outbound.sends).toHaveLength(1);
		expect(store.getCursor()).toBe(2);
	});

	test("unfollowed events send nothing and advance", async () => {
		const { store } = await makeStore();
		const coordinator = new FakeCoordinatorClient();
		coordinator.watchScript = [result([{ seq: 7, kind: "session.state_changed", sessionId: "sess-1" }])];
		const outbound = makeOutbound();
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(outbound.sends).toHaveLength(0);
		expect(store.getCursor()).toBe(7);
	});

	test("failed delivery blocks cursor at prior contiguous seq", async () => {
		const { store } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		await store.follow({ sessionId: "sess-2", chatId: "100", userId: "100" });
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = {
			ok: true,
			sessions: [{ session_id: "sess-1" }, { session_id: "sess-2" }],
			sessionStates: [
				{ session_id: "sess-1", state: "errored", live: true },
				{ session_id: "sess-2", state: "errored", live: true },
			],
			turns: [
				{ session_id: "sess-1", status: "failed" },
				{ session_id: "sess-2", status: "failed" },
			],
		};
		coordinator.watchScript = [
			result([
				{ seq: 1, kind: "turn.failed", sessionId: "sess-1" },
				{ seq: 2, kind: "turn.failed", sessionId: "sess-2" },
			]),
		];
		const outbound = makeOutbound([{ ok: true }, { ok: false }]);
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(store.getCursor()).toBe(1);
	});

	test("partial failure replays undelivered event and persists no dedupe ledger", async () => {
		const { store, dir } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		await store.follow({ sessionId: "sess-2", chatId: "100", userId: "100" });
		const status: CoordinationStatus = {
			ok: true,
			sessions: [{ session_id: "sess-1" }, { session_id: "sess-2" }],
			sessionStates: [
				{ session_id: "sess-1", state: "errored", live: true },
				{ session_id: "sess-2", state: "errored", live: true },
			],
			turns: [
				{ session_id: "sess-1", status: "failed" },
				{ session_id: "sess-2", status: "failed" },
			],
		};
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = status;
		coordinator.watchScript = [
			result([
				{ seq: 1, kind: "turn.failed", sessionId: "sess-1" },
				{ seq: 2, kind: "turn.failed", sessionId: "sess-2" },
			]),
		];
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound: makeOutbound([{ ok: true }, { ok: false }]),
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		const restarted = await SubscriptionStore.open({ stateDir: dir, now: () => 1_000_000 });
		const replay = new FakeCoordinatorClient();
		replay.status = status;
		replay.watchScript = [result([{ seq: 2, kind: "turn.failed", sessionId: "sess-2" }])];
		const outbound = makeOutbound();
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator: replay,
				outbound,
				subscriptions: restarted,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(outbound.sends[0]?.reply.text).toContain("sess-2");
		const persisted = JSON.parse(await readFile(join(dir, STATE_FILE_NAME), "utf8"));
		expect(Object.keys(persisted).sort()).toEqual(["subscriptions", "version", "watchCursor"]);
	});

	test("retry_after coalesces to digest and sleeps before retry", async () => {
		const { store } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = statusFor();
		coordinator.watchScript = [result([{ seq: 1, kind: "session.state_changed", sessionId: "sess-1" }])];
		const outbound = makeOutbound([{ ok: false, retryAfterMs: 42 }, { ok: true }]);
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async ms => {
					outbound.sleeps.push(ms);
				},
			}),
		);
		expect(outbound.sleeps).toEqual([42]);
		expect(outbound.sends.at(-1)?.reply.text).toContain("Session updates:");
		expect(store.getCursor()).toBe(1);
	});

	test("hostile routing fields are not rendered or logged", async () => {
		const { store } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = statusFor("sess-1", "blocked", "Clean");
		coordinator.watchScript = [
			result([
				{
					seq: 1,
					kind: "session.state_changed",
					sessionId: "sess-1",
					summary: "SECRET",
					metadata: "SECRET",
					payload_ref: "SECRET",
				} as never,
			]),
		];
		const outbound = makeOutbound();
		const logs: string[] = [];
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
				logger: (event, fields) => logs.push(`${event}:${JSON.stringify(fields)}`),
			}),
		);
		const serialized = JSON.stringify(outbound.sends);
		expect(serialized).not.toContain("SECRET");
		expect(logs.join("\n")).not.toContain("SECRET");
	});

	test("multi-chat partial delivery does not advance cursor and replays after restart", async () => {
		const { store } = await makeStore();
		await store.follow({ sessionId: "sess-1", chatId: "100", userId: "100" });
		await store.follow({ sessionId: "sess-1", chatId: "200", userId: "200" });
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = statusFor();
		coordinator.watchScript = [result([{ seq: 1, kind: "session.state_changed", sessionId: "sess-1" }])];
		// First follower chat succeeds, second follower chat fails (no retryAfter).
		const outbound = makeOutbound([{ ok: true }, { ok: false }]);
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator,
				outbound,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(outbound.sends.length).toBe(2);
		expect(store.getCursor()).toBe(0);

		// Restart with the same store: event 1 replays because the cursor never advanced past it.
		const coordinator2 = new FakeCoordinatorClient();
		coordinator2.status = statusFor();
		coordinator2.watchScript = [result([{ seq: 1, kind: "session.state_changed", sessionId: "sess-1" }])];
		const outbound2 = makeOutbound();
		await runOnce(
			new TelegramRemoteNotifier({
				coordinator: coordinator2,
				outbound: outbound2,
				subscriptions: store,
				renderCard: card,
				sleep: async () => {},
			}),
		);
		expect(outbound2.sends.length).toBeGreaterThanOrEqual(1);
	});
});

function card(rawSessionId: string, view: { name: string; status: string }): ChatReply {
	return { kind: "chat", text: `card ${rawSessionId} ${view.name} ${view.status}` };
}
