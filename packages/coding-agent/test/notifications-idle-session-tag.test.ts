import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../src/config/settings";
import type { BotApi } from "../src/sdk/bus/telegram-daemon";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";

// ---------------------------------------------------------------------------
// Daemon-level pins for the #4855 session-tag decision: the flat private-chat
// fallback (no topic) renders the idle marker with the short session tag, while
// topic delivery keeps the bare marker per #981's identity-once contract. Asks
// never carry a tag on either path. These drive handleSessionMessage's
// action_needed branch end to end through the recording Bot API, covering the
// seam the renderer tests cannot see: which identity source the daemon passes.
// ---------------------------------------------------------------------------

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tg-idletag-"));
}

function settings(agentDir: string): Settings {
	return {
		getNotificationSettingsSnapshot: () => ({
			enabled: true,
			telegram: {
				complete: true,
				botToken: "123456:secret-token",
				chatId: "42",
				sound: "all",
				rich: { enabled: true },
				richDraft: { enabled: false },
				btw: { enabled: false },
				activation: {},
			},
			discord: { complete: false },
			slack: { complete: false },
			daemon: { idleTimeoutMs: 20 },
			sessionScope: "all",
		}),
		getAgentDir: () => agentDir,
	} as never as Settings;
}

/**
 * Recording Bot API. `topicCapable` false makes createForumTopic fail, which is
 * exactly the Threaded-Mode-unavailable condition that routes delivery to the
 * flat private-chat fallback.
 */
class IdleTagBot implements BotApi {
	calls: Array<{ method: string; body: any }> = [];
	topicCapable: boolean;
	constructor(topicCapable: boolean) {
		this.topicCapable = topicCapable;
	}
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown }).chat_id, type: "private" } };
		if (method === "createForumTopic") {
			if (!this.topicCapable) return { ok: false, description: "not a forum" };
			return { ok: true, result: { message_thread_id: 555 } };
		}
		if (method === "getForumTopicIconStickers") return { ok: true, result: [] };
		if (method === "sendRichMessage") return { ok: true, result: { message_id: 4242 } };
		if (method === "sendMessage") return { ok: true, result: { message_id: this.calls.length } };
		return { ok: true, result: true };
	}
}

function makeDaemon(bot: BotApi): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: settings(tempAgentDir()),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot as any,
	});
}

function session(id: string): any {
	return { sessionId: id, token: "tok", ws: { readyState: 1, send() {} }, pending: new Map() };
}

const idleAction = (sessionId: string) => ({
	type: "action_needed",
	id: "idle-1",
	kind: "idle",
	sessionId,
});

const askAction = (sessionId: string) => ({
	type: "action_needed",
	id: "ask-1",
	kind: "ask",
	sessionId,
	question: "Proceed?",
	options: ["Yes", "No"],
});

/** Every rendered remote message text (rich markdown + HTML bodies). */
const renderedTexts = (bot: IdleTagBot): string[] =>
	bot.calls.map(c => {
		const body = c.body as { text?: string; rich_message?: { markdown?: string } };
		return `${body.text ?? ""}${body.rich_message?.markdown ?? ""}`;
	});

const richIdleTexts = (bot: IdleTagBot): string[] =>
	bot.calls
		.filter(c => c.method === "sendRichMessage")
		.map(c => (c.body as { rich_message?: { markdown?: string } }).rich_message?.markdown ?? "");

test("flat fallback idle marker carries the short session tag (#4855)", async () => {
	const bot = new IdleTagBot(false);
	const daemon = makeDaemon(bot);
	const id = "session-abcdef";
	await daemon.handleSessionMessage(session(id), idleAction(id));
	expect(richIdleTexts(bot).join("\n")).toBe("🟢 Agent idle · abcdef");
	// No full session id is ever rendered.
	for (const text of renderedTexts(bot)) expect(text).not.toContain("session-abcdef");
});

test("topic-mode idle marker stays bare (#981 identity-once)", async () => {
	const bot = new IdleTagBot(true);
	const daemon = makeDaemon(bot);
	const id = "session-abcdef";
	await daemon.handleSessionMessage(session(id), idleAction(id));
	expect(richIdleTexts(bot).join("\n")).toBe("🟢 Agent idle");
	for (const text of renderedTexts(bot)) {
		expect(text).not.toContain("abcdef");
		expect(text).not.toContain("session-abcdef");
	}
});

test("flat fallback ask never carries the session tag", async () => {
	const bot = new IdleTagBot(false);
	const daemon = makeDaemon(bot);
	const id = "session-abcdef";
	await daemon.handleSessionMessage(session(id), askAction(id));
	const joined = renderedTexts(bot).join("\n");
	expect(joined).toContain("Proceed?");
	expect(joined).not.toContain("abcdef");
});
