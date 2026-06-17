import { beforeEach, describe, expect, test } from "bun:test";
import { type GatewayPolicy, TelegramRemoteGateway } from "../src/gateway";
import { MESSAGES, UNAUTHORIZED_REFUSAL } from "../src/messages";
import { SubscriptionStore } from "../src/subscriptions";
import type { ChatReply, CoordinationStatus, OutgoingReply, TelegramInlineKeyboardButton } from "../src/types";
import { callback, FakeCoordinatorClient, message, preset, presetMap } from "./helpers";

function liveSession(): CoordinationStatus {
	return {
		ok: true,
		sessions: [{ session_id: "sess-1", branch: "main" }],
		sessionStates: [{ session_id: "sess-1", state: "running", live: true, updated_at: "2026-06-15T00:00:00.000Z" }],
		turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1" }],
	};
}

let coordinator: FakeCoordinatorClient;
let clock: number;

function makeGateway(overrides: Partial<GatewayPolicy> = {}): TelegramRemoteGateway {
	return new TelegramRemoteGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(["900"]),
			presets: presetMap(preset({ id: "demo", taskTemplate: "Task: {{task}}", taskMaxLen: 20 })),
			enableStop: true,
			confirmTtlMs: 1000,
			...overrides,
		},
		{ coordinator, now: () => clock },
	);
}

beforeEach(() => {
	coordinator = new FakeCoordinatorClient();
	clock = 0;
});

describe("authorization (default deny)", () => {
	test("an unlisted sender gets the boring refusal and triggers no backend call", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/sessions" }));
		expect(reply).toBe(UNAUTHORIZED_REFUSAL);
		expect(coordinator.calls).toHaveLength(0);
	});

	test("refusal is identical regardless of the attempted command (no hints)", async () => {
		const gateway = makeGateway();
		const a = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/start-session demo x" }));
		const b = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/stop sess-1 confirm" }));
		expect(a).toBe(UNAUTHORIZED_REFUSAL);
		expect(b).toBe(UNAUTHORIZED_REFUSAL);
	});

	test("authorization can be granted by chat id", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ userId: null, chatId: "900", text: "/help" }));
		expect(reply).toBe(MESSAGES.help);
	});

	test("with no allowlist nobody is authorized", async () => {
		const gateway = makeGateway({ allowedUserIds: new Set(), allowedChatIds: new Set() });
		const reply = await gateway.handleMessage(message({ text: "/help" }));
		expect(reply).toBe(UNAUTHORIZED_REFUSAL);
	});
});

describe("read commands", () => {
	test("/sessions renders bounded summaries", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: "/sessions" }));
		expect(reply).toContain("sess-1");
		expect(reply).toContain("working");
		expect(coordinator.countOf("getCoordinationStatus")).toBe(1);
	});

	test("/sessions reports a boring offline message when the backend is unreachable", async () => {
		coordinator.status = { ok: false, reason: "coordinator_unreachable", sessions: [], sessionStates: [], turns: [] };
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/sessions" }))).toBe(MESSAGES.backendOffline);
	});

	test("/observe requires a session id and rejects unknown sessions", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/observe" }))).toBe(MESSAGES.observeUsage);
		expect(await gateway.handleMessage(message({ text: "/observe missing" }))).toBe(MESSAGES.unknownSession);
		expect(await gateway.handleMessage(message({ text: "/observe sess-1" }))).toContain("status: working");
	});
});

describe("/presets discoverability", () => {
	test("authorized /presets lists only safe id and name", async () => {
		const gateway = makeGateway({
			presets: presetMap(
				preset({
					id: "demo",
					name: "Demo preset",
					workdir: "/secret/workdir",
					sessionCommand: "secret command",
					taskTemplate: "Secret {{task}}",
				}),
			),
		});
		const reply = await gateway.handleMessage(message({ text: "/presets" }));
		expect(reply).toContain("Demo preset (demo)");
		expect(reply).not.toContain("/secret/workdir");
		expect(reply).not.toContain("secret command");
		expect(reply).not.toContain("Secret {{task}}");
		expect(coordinator.calls).toHaveLength(0);
	});

	test("unauthorized /presets gets the identical refusal and no backend call", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/presets" }));
		expect(reply).toBe(UNAUTHORIZED_REFUSAL);
		expect(coordinator.calls).toHaveLength(0);
	});

	test("arg-less rich /start-session renders preset buttons", async () => {
		const gateway = makeGateway({
			enableRichMessages: true,
			presets: presetMap(preset({ id: "demo", name: "Demo preset" })),
		});
		const reply = asChat(await gateway.handleUpdate(message({ text: "/start-session" })));
		expect(reply.text).toContain("Demo preset (demo)");
		expect(buttons(reply).find(b => b.text === "Demo preset")).toBeDefined();
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("arg-less plain /start-session renders the safe preset id/name list", async () => {
		const gateway = makeGateway({
			enableRichMessages: false,
			presets: presetMap(preset({ id: "demo", name: "Demo preset", workdir: "/secret/workdir" })),
		});
		const reply = await gateway.handleMessage(message({ text: "/start-session" }));
		expect(reply).toContain("Demo preset (demo)");
		expect(reply).not.toContain("/secret/workdir");
	});
});

describe("/start-session preset binding", () => {
	test("missing preset id with no presets configured shows usage and calls no backend", async () => {
		const gateway = makeGateway({ presets: presetMap() });
		expect(await gateway.handleMessage(message({ text: "/start-session" }))).toBe(MESSAGES.startUsage);
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("unknown preset is rejected without enumeration and without a backend call", async () => {
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/start-session nope task" }))).toBe(MESSAGES.unknownPreset);
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("over-length task is rejected before any backend call", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: `/start-session demo ${"x".repeat(30)}` }));
		expect(reply).toBe(MESSAGES.taskTooLong);
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("start binds the preset workdir, never a chat-supplied path", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: "/start-session demo /etc/passwd" }));
		expect(coordinator.countOf("startSession")).toBe(1);
		expect(coordinator.calls[0]?.args).toEqual({ cwd: "/home/bot/src/project", prompt: "Task: /etc/passwd" });
		expect(reply).toContain("sess-1");
	});

	test("maps fail-closed mutation reasons to boring messages", async () => {
		const gateway = makeGateway();
		coordinator.startResult = { ok: false, reason: "coordinator_mutation_class_disabled:sessions" };
		expect(await gateway.handleMessage(message({ text: "/start-session demo x" }))).toBe(
			MESSAGES.sessionControlDisabled,
		);
		coordinator.startResult = { ok: false, reason: "coordinator_mutation_call_not_allowed:sessions" };
		expect(await gateway.handleMessage(message({ text: "/start-session demo x" }))).toBe(
			MESSAGES.sessionControlNotPermitted,
		);
	});
});

describe("/stop confirmation gating", () => {
	test("stop is disabled when reports mutation is not enabled", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway({ enableStop: false });
		expect(await gateway.handleMessage(message({ text: "/stop sess-1" }))).toBe(MESSAGES.sessionControlDisabled);
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("first /stop arms; a second /stop ... confirm executes the cancel once", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		const armed = await gateway.handleMessage(message({ text: "/stop sess-1" }));
		expect(armed).toContain("confirm");
		expect(coordinator.countOf("reportStatus")).toBe(0);

		const done = await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }));
		expect(done).toContain("Stop requested");
		expect(coordinator.countOf("reportStatus")).toBe(1);
		expect(coordinator.calls.at(-1)?.args).toMatchObject({
			sessionId: "sess-1",
			turnId: "turn-1",
			status: "cancelled",
		});
	});

	test("confirm without a prior arm does not execute", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }));
		expect(reply).toContain("confirm");
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("an expired arm must be re-confirmed", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway({ confirmTtlMs: 1000 });
		await gateway.handleMessage(message({ text: "/stop sess-1" }));
		clock = 2000; // beyond TTL
		const reply = await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }));
		expect(reply).toContain("confirm");
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("unknown session is refused before arming", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/stop missing" }))).toBe(MESSAGES.unknownSession);
	});

	test("an offline session fails closed: no arm, no report", async () => {
		coordinator.status = {
			ok: true,
			sessions: [{ session_id: "sess-1", branch: "main" }],
			sessionStates: [{ session_id: "sess-1", state: "running", live: false }],
			turns: [],
		};
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/stop sess-1" }))).toBe(MESSAGES.backendOffline);
		expect(await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }))).toBe(MESSAGES.backendOffline);
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});
});

describe("unknown commands", () => {
	test("authorized unknown command gets the boring unknown message", async () => {
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/shell rm -rf /" }))).toBe(MESSAGES.unknownCommand);
	});
});

const LONG_ID = `sess:gjc/feat-x&<unsafe>${"z".repeat(50)}`;

function longStatus(): CoordinationStatus {
	return {
		ok: true,
		sessions: [{ session_id: LONG_ID, branch: "main", cwd: "/secret/abs" }],
		sessionStates: [{ session_id: LONG_ID, state: "running", live: true }],
		turns: [{ session_id: LONG_ID, status: "active", turn_id: "turn-x" }],
	};
}

function buttons(reply: OutgoingReply): TelegramInlineKeyboardButton[] {
	if (reply.kind !== "chat" || !reply.replyMarkup) return [];
	return reply.replyMarkup.inline_keyboard.flat();
}

function asChat(reply: OutgoingReply): ChatReply {
	expect(reply.kind).toBe("chat");
	return reply as ChatReply;
}

describe("rich messaging + callbacks", () => {
	test("/sessions returns HTML with observe/stop buttons; callback_data is opaque and bounded", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		expect(reply.parseMode).toBe("HTML");
		expect(reply.text).toContain("<code>");
		expect(reply.text).not.toContain(LONG_ID);
		const btns = buttons(reply);
		expect(btns.find(b => b.text.startsWith("Observe"))).toBeDefined();
		expect(btns.find(b => b.text.startsWith("Stop"))).toBeDefined();
		for (const b of btns) {
			expect(Buffer.byteLength(b.callbackData, "utf8")).toBeLessThanOrEqual(64);
			expect(b.callbackData).not.toContain(LONG_ID);
		}
	});

	test("observe callback re-enters the read path only (no mutation)", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const sessions = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const observe = buttons(sessions).find(b => b.text.startsWith("Observe"))!;
		const before = coordinator.countOf("getCoordinationStatus");
		const reply = asChat(await gateway.handleUpdate(callback({ data: observe.callbackData })));
		expect(reply.text).toContain("status:");
		expect(coordinator.countOf("getCoordinationStatus")).toBe(before + 1);
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("stop arm -> confirm records cancelled once with the EXACT raw session id", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const sessions = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const stop = buttons(sessions).find(b => b.text.startsWith("Stop"))!;
		const arm = asChat(await gateway.handleUpdate(callback({ data: stop.callbackData })));
		expect(coordinator.countOf("reportStatus")).toBe(0);
		const confirm = buttons(arm).find(b => b.text === "Confirm stop")!;
		await gateway.handleUpdate(callback({ data: confirm.callbackData }));
		expect(coordinator.countOf("reportStatus")).toBe(1);
		expect(coordinator.calls.at(-1)?.args).toMatchObject({ sessionId: LONG_ID, status: "cancelled" });
	});

	test("replayed stop_confirm is answer-only and does not double-mutate", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const sessions = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const stop = buttons(sessions).find(b => b.text.startsWith("Stop"))!;
		const arm = asChat(await gateway.handleUpdate(callback({ data: stop.callbackData })));
		const confirm = buttons(arm).find(b => b.text === "Confirm stop")!;
		await gateway.handleUpdate(callback({ data: confirm.callbackData }));
		const replay = await gateway.handleUpdate(callback({ data: confirm.callbackData }));
		expect(replay.kind).toBe("callback_answer");
		expect(coordinator.countOf("reportStatus")).toBe(1);
	});

	test("unauthorized / forwarded callback is answer-only with no backend call", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const sessions = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const observe = buttons(sessions).find(b => b.text.startsWith("Observe"))!;
		const before = coordinator.calls.length;
		const reply = await gateway.handleUpdate(callback({ userId: "999", chatId: "999", data: observe.callbackData }));
		expect(reply.kind).toBe("callback_answer");
		if (reply.kind === "callback_answer") expect(reply.callbackAnswer.text).toBe(UNAUTHORIZED_REFUSAL);
		expect(coordinator.calls.length).toBe(before);
	});

	test("expired token is answer-only", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true, richCallbackTtlMs: 1000 });
		const sessions = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const observe = buttons(sessions).find(b => b.text.startsWith("Observe"))!;
		clock = 2000; // beyond the 1000ms TTL
		const reply = await gateway.handleUpdate(callback({ data: observe.callbackData }));
		expect(reply.kind).toBe("callback_answer");
		if (reply.kind === "callback_answer") expect(reply.callbackAnswer.text).toBe(MESSAGES.callbackExpired);
	});

	test("malformed callback_data and missing chat id are answer-only with no backend call", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const before = coordinator.calls.length;
		const malformed = await gateway.handleUpdate(callback({ data: "not-a-token" }));
		const missingChat = await gateway.handleUpdate(callback({ chatId: null, data: "gtr:v1:x" }));
		expect(malformed.kind).toBe("callback_answer");
		expect(missingChat.kind).toBe("callback_answer");
		expect(coordinator.calls.length).toBe(before);
	});

	test("preset callback_data is opaque and no-template preset starts in one tap", async () => {
		const gateway = makeGateway({
			enableRichMessages: true,
			presets: presetMap(
				preset({
					id: "plain",
					name: "Plain",
					taskTemplate: undefined,
					workdir: "/safe/cwd",
					sessionCommand: "hidden command",
				}),
			),
		});
		const presets = asChat(await gateway.handleUpdate(message({ text: "/presets" })));
		const button = buttons(presets).find(b => b.text === "Plain")!;
		expect(Buffer.byteLength(button.callbackData, "utf8")).toBeLessThanOrEqual(64);
		expect(button.callbackData).toMatch(/^gtr:v1:/);
		expect(button.callbackData).not.toContain("plain");
		expect(button.callbackData).not.toContain("/safe/cwd");
		expect(button.callbackData).not.toContain("hidden command");
		const reply = asChat(await gateway.handleUpdate(callback({ data: button.callbackData })));
		expect(reply.text).toContain("sess-1");
		expect(reply.callbackAnswer?.text).toBe(MESSAGES.callbackDone);
		expect(coordinator.calls.at(-1)?.args).toEqual({ cwd: "/safe/cwd", prompt: undefined });
	});

	test("templated preset prompts for task, then following plain text starts with sanitized task", async () => {
		const gateway = makeGateway({ enableRichMessages: true });
		const presets = asChat(await gateway.handleUpdate(message({ text: "/presets" })));
		const button = buttons(presets).find(b => b.text === "demo")!;
		const prompt = asChat(await gateway.handleUpdate(callback({ data: button.callbackData })));
		expect(prompt.text).toBe(MESSAGES.presetNeedsTask);
		expect(coordinator.countOf("startSession")).toBe(0);
		const reply = asChat(await gateway.handleUpdate(message({ text: "  fix\u0000\n bug  " })));
		expect(reply.text).toContain("sess-1");
		expect(coordinator.countOf("startSession")).toBe(1);
		expect(coordinator.calls.at(-1)?.args).toEqual({ cwd: "/home/bot/src/project", prompt: "Task: fix bug" });
	});

	test("a preset_start button is single-use: replay does not start a second session", async () => {
		const gateway = makeGateway({
			enableRichMessages: true,
			presets: presetMap(preset({ id: "plain", name: "Plain", taskTemplate: undefined })),
		});
		const presets = asChat(await gateway.handleUpdate(message({ text: "/presets" })));
		const button = buttons(presets).find(b => b.text === "Plain")!;
		const first = await gateway.handleUpdate(callback({ data: button.callbackData }));
		expect(first.kind).toBe("chat");
		expect(coordinator.countOf("startSession")).toBe(1);
		const replay = await gateway.handleUpdate(callback({ data: button.callbackData }));
		expect(replay.kind).toBe("callback_answer");
		expect(coordinator.countOf("startSession")).toBe(1);
	});

	test("cancel callback is answer-only and invalidates the token", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const sessions = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const stop = buttons(sessions).find(b => b.text.startsWith("Stop"))!;
		const arm = asChat(await gateway.handleUpdate(callback({ data: stop.callbackData })));
		const cancel = buttons(arm).find(b => b.text === "Cancel")!;
		const confirm = buttons(arm).find(b => b.text === "Confirm stop")!;
		const reply = await gateway.handleUpdate(callback({ data: cancel.callbackData }));
		expect(reply.kind).toBe("callback_answer");
		if (reply.kind === "callback_answer") expect(reply.callbackAnswer.text).toBe(MESSAGES.callbackCancelled);
		// Cancel revokes the paired confirm token: a later Confirm must not mutate.
		const afterConfirm = await gateway.handleUpdate(callback({ data: confirm.callbackData }));
		expect(afterConfirm.kind).toBe("callback_answer");
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("rich /stop arm shows the capped display id (not the raw id) plus a Confirm button", async () => {
		coordinator.status = longStatus();
		const gateway = makeGateway({ enableRichMessages: true });
		const arm = asChat(await gateway.handleUpdate(message({ text: `/stop ${LONG_ID}` })));
		expect(arm.parseMode).toBe("HTML");
		expect(arm.text).not.toContain(LONG_ID);
		expect(buttons(arm).find(b => b.text === "Confirm stop")).toBeDefined();
		// Confirm via the button records cancelled with the EXACT raw id.
		const confirm = buttons(arm).find(b => b.text === "Confirm stop")!;
		await gateway.handleUpdate(callback({ data: confirm.callbackData }));
		expect(coordinator.calls.at(-1)?.args).toMatchObject({ sessionId: LONG_ID, status: "cancelled" });
	});
});

describe("push follow/mute controls", () => {
	test("Follow and Mute buttons appear only when push and subscriptions are enabled", async () => {
		coordinator.status = longStatus();
		const withoutStore = makeGateway({ enableRichMessages: true, enablePush: true });
		const noPush = asChat(await withoutStore.handleUpdate(message({ text: "/sessions" })));
		expect(buttons(noPush).find(b => b.text.startsWith("Follow"))).toBeUndefined();

		const subscriptions = await SubscriptionStore.load({
			filePath: `/tmp/gtr-gateway-${Date.now()}-a.json`,
			now: () => clock,
		});
		const gateway = new TelegramRemoteGateway(
			{
				allowedUserIds: new Set(["100"]),
				allowedChatIds: new Set(["900"]),
				presets: presetMap(),
				enableStop: true,
				enableRichMessages: true,
				enablePush: true,
			},
			{ coordinator, now: () => clock, subscriptions },
		);
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		expect(buttons(reply).find(b => b.text.startsWith("Follow"))).toBeDefined();
		expect(buttons(reply).find(b => b.text.startsWith("Mute"))).toBeDefined();
	});

	test("Follow callback stores subscription and Mute removes it", async () => {
		coordinator.status = longStatus();
		const subscriptions = await SubscriptionStore.load({
			filePath: `/tmp/gtr-gateway-${Date.now()}-b.json`,
			now: () => clock,
		});
		const gateway = new TelegramRemoteGateway(
			{
				allowedUserIds: new Set(["100"]),
				allowedChatIds: new Set(["900"]),
				presets: presetMap(),
				enableStop: true,
				enableRichMessages: true,
				enablePush: true,
			},
			{ coordinator, now: () => clock, subscriptions },
		);
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const follow = buttons(reply).find(b => b.text.startsWith("Follow"))!;
		const followed = await gateway.handleUpdate(callback({ data: follow.callbackData }));
		expect(followed.kind).toBe("callback_answer");
		expect(await subscriptions.followers(LONG_ID)).toHaveLength(1);
		const observe = asChat(await gateway.handleUpdate(message({ text: `/observe ${LONG_ID}` })));
		const mute = buttons(observe).find(b => b.text === "Mute")!;
		await gateway.handleUpdate(callback({ data: mute.callbackData }));
		expect(await subscriptions.followers(LONG_ID)).toHaveLength(0);
	});

	test("unauthorized follow and mute are answer-only and do not mutate", async () => {
		coordinator.status = longStatus();
		const subscriptions = await SubscriptionStore.load({
			filePath: `/tmp/gtr-gateway-${Date.now()}-c.json`,
			now: () => clock,
		});
		const gateway = new TelegramRemoteGateway(
			{
				allowedUserIds: new Set(["100"]),
				allowedChatIds: new Set(["900"]),
				presets: presetMap(),
				enableStop: true,
				enableRichMessages: true,
				enablePush: true,
			},
			{ coordinator, now: () => clock, subscriptions },
		);
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const follow = buttons(reply).find(b => b.text.startsWith("Follow"))!;
		const denied = await gateway.handleUpdate(callback({ userId: "999", chatId: "999", data: follow.callbackData }));
		expect(denied.kind).toBe("callback_answer");
		expect(await subscriptions.followers(LONG_ID)).toHaveLength(0);
	});
});

function browsingStatus(
	count: number,
	overrides: Array<{
		id: string;
		branch?: string;
		state?: string;
		turn?: string;
		live?: boolean;
		updatedAt?: string;
	}> = [],
): CoordinationStatus {
	const sessions = [];
	const sessionStates = [];
	const turns = [];
	for (let i = 0; i < count; i += 1) {
		const id = `sess-${String(i + 1).padStart(2, "0")}`;
		sessions.push({ session_id: id, branch: `branch-${i + 1}` });
		sessionStates.push({
			session_id: id,
			state: "running",
			live: true,
			updated_at: `2026-06-15T00:${String(i).padStart(2, "0")}:00.000Z`,
		});
		turns.push({ session_id: id, status: "active", turn_id: `turn-${i + 1}` });
	}
	for (const item of overrides) {
		sessions.push({ session_id: item.id, branch: item.branch ?? "feature-special" });
		sessionStates.push({
			session_id: item.id,
			state: item.state ?? "running",
			live: item.live ?? true,
			updated_at: item.updatedAt ?? "2026-06-15T01:00:00.000Z",
		});
		if (item.turn) turns.push({ session_id: item.id, status: item.turn, turn_id: `turn-${item.id}` });
	}
	return { ok: true, sessions, sessionStates, turns };
}

describe("rich multi-session browsing", () => {
	test("/sessions <query> filters by substring", async () => {
		coordinator.status = browsingStatus(2, [{ id: LONG_ID, branch: "needle-branch" }]);
		const gateway = makeGateway({ enableRichMessages: true });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions needle" })));
		expect(reply.text).toContain("needle-branch");
		expect(reply.text).toContain("1 sessions");
		expect(reply.text).not.toContain("branch-1");
		expect(reply.text).not.toContain(LONG_ID);
	});

	test("filter buttons are present, opaque, bounded, and contain no filter/query/raw id", async () => {
		coordinator.status = browsingStatus(1, [{ id: LONG_ID, branch: "needle-branch" }]);
		const gateway = makeGateway({ enableRichMessages: true });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions needle" })));
		for (const label of ["live", "blocked", "done", "[all]"]) {
			expect(buttons(reply).find(b => b.text === label)).toBeDefined();
		}
		for (const b of buttons(reply)) {
			expect(b.callbackData.startsWith("gtr:v1:")).toBe(true);
			expect(Buffer.byteLength(b.callbackData, "utf8")).toBeLessThanOrEqual(64);
			expect(b.callbackData).not.toContain("live");
			expect(b.callbackData).not.toContain("blocked");
			expect(b.callbackData).not.toContain("done");
			expect(b.callbackData).not.toContain("all");
			expect(b.callbackData).not.toContain("needle");
			expect(b.callbackData).not.toContain(LONG_ID);
		}
	});

	test("paginates at 8 rows and Next callback renders page 2", async () => {
		coordinator.status = browsingStatus(9);
		const gateway = makeGateway({ enableRichMessages: true, enableStop: false });
		const first = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		expect(buttons(first).filter(b => b.text.startsWith("Observe"))).toHaveLength(8);
		expect(first.text).toContain("page 1/2");
		const next = buttons(first).find(b => b.text === "Next")!;
		const second = asChat(await gateway.handleUpdate(callback({ data: next.callbackData, messageId: 44 })));
		expect(second.text).toContain("page 2/2");
		expect(buttons(second).filter(b => b.text.startsWith("Observe"))).toHaveLength(1);
		expect(second.edit).toEqual({ messageId: 44 });
	});

	test("every list callback_data is <=64 bytes and never contains long raw id", async () => {
		coordinator.status = browsingStatus(10, [{ id: LONG_ID, branch: "long" }]);
		const gateway = makeGateway({ enableRichMessages: true });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		for (const b of buttons(reply)) {
			expect(Buffer.byteLength(b.callbackData, "utf8")).toBeLessThanOrEqual(64);
			expect(b.callbackData).not.toContain(LONG_ID);
		}
	});

	test("unauthorized list callback is answer-only and makes no coordinator call", async () => {
		coordinator.status = browsingStatus(1);
		const gateway = makeGateway({ enableRichMessages: true });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const filter = buttons(reply).find(b => b.text === "live")!;
		const before = coordinator.calls.length;
		const denied = await gateway.handleUpdate(callback({ userId: "999", chatId: "999", data: filter.callbackData }));
		expect(denied.kind).toBe("callback_answer");
		expect(coordinator.calls.length).toBe(before);
	});

	test("terminal/dead sessions older than 24h are excluded but within 24h are included", async () => {
		clock = Date.parse("2026-06-16T00:00:00.000Z");
		coordinator.status = browsingStatus(0, [
			{ id: "recent-done", state: "completed", turn: "completed", updatedAt: "2026-06-15T01:00:00.000Z" },
			{ id: "old-done", state: "completed", turn: "completed", updatedAt: "2026-06-14T23:00:00.000Z" },
			{ id: "live-old", state: "running", turn: "active", updatedAt: "2026-06-01T00:00:00.000Z" },
		]);
		const gateway = makeGateway({ enableRichMessages: true, enableStop: false });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		expect(reply.text).toContain("recent-done");
		expect(reply.text).toContain("live-old");
		expect(reply.text).not.toContain("old-done");
		expect(reply.text).toContain("2 sessions");
	});

	test("plain mode /sessions <query> filters the simple list by substring", async () => {
		coordinator.status = browsingStatus(2, [{ id: "sess-aa", branch: "needle-branch" }]);
		const gateway = makeGateway({ enableRichMessages: false });
		const reply = asChat(await gateway.handleUpdate(message({ text: "/sessions needle" })));
		expect(reply.parseMode).toBeUndefined();
		expect(reply.text).toContain("needle-branch");
		expect(reply.text).not.toContain("sess-02");
	});

	test("Observe from a list row edits the originating list message in place", async () => {
		coordinator.status = browsingStatus(3);
		const gateway = makeGateway({ enableRichMessages: true });
		const list = asChat(await gateway.handleUpdate(message({ text: "/sessions" })));
		const observe = buttons(list).find(b => b.text.startsWith("Observe"))!;
		const reply = asChat(await gateway.handleUpdate(callback({ data: observe.callbackData, messageId: 77 })));
		expect(reply.edit).toEqual({ messageId: 77 });
		expect(reply.text).toContain("status:");
	});
});
