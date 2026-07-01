import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../src/config/settings";
import { TELEGRAM_PARSE_MODE } from "../src/notifications/html-format";
import { TelegramNotificationDaemon } from "../src/notifications/telegram-daemon";

function settings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

interface Call {
	method: string;
	body: Record<string, unknown> | null;
}

function spyBot(): { calls: Call[]; api: never } {
	const calls: Call[] = [];
	const api = {
		call: async (method: string, body: Record<string, unknown> | null) => {
			calls.push({ method, body });
			return { ok: true, result: [] };
		},
	} as never;
	return { calls, api };
}

function makeDaemon(agentDir: string, bot: never): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi: bot,
	});
}

function msg(chatId: string, text: string, updateId: number): unknown {
	return { update_id: updateId, message: { chat: { id: chatId }, text, message_id: updateId } };
}

function writeSession(agentDir: string, project: string, id: string, header: object, mtimeMs: number): void {
	const dir = path.join(agentDir, "sessions", project);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
	fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

describe("lifecycle command routing (G009)", () => {
	test("a paired-chat /session_* command is detected and answered (no injection fallthrough)", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		const { calls, api } = spyBot();
		const daemon = makeDaemon(agentDir, api);
		// Control is not started in this unit (lifecycleControlActive=false), so the
		// command is detected + gated and answered with a not-available notice — it
		// must NOT fall through to threaded injection.
		await daemon.handleTelegramUpdate(msg("42", "/session_create path /repo", 1));
		const sends = calls.filter(c => c.method === "sendMessage");
		expect(sends.length).toBe(1);
		expect(String(sends[0]?.body?.chat_id)).toBe("42");
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("a non-paired chat /session_* command is ignored by the lifecycle path", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		const { calls, api } = spyBot();
		const daemon = makeDaemon(agentDir, api);
		await daemon.handleTelegramUpdate(msg("999", "/session_create path /repo", 2));
		// No lifecycle reply for an unpaired chat.
		expect(calls.filter(c => c.method === "sendMessage").length).toBe(0);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("a plain (non-command) paired-chat message is not treated as a lifecycle command", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		const { calls, api } = spyBot();
		const daemon = makeDaemon(agentDir, api);
		await daemon.handleTelegramUpdate(msg("42", "hello there", 3));
		// Not a /session_* command -> no lifecycle not-available reply.
		expect(calls.filter(c => c.method === "sendMessage").length).toBe(0);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	test("/session_recent is sent as escaped preformatted HTML chunks", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		const { calls, api } = spyBot();
		const daemon = makeDaemon(agentDir, api);
		(daemon as unknown as { lifecycleControlActive: boolean }).lifecycleControlActive = true;
		for (let i = 0; i < 20; i++) {
			writeSession(
				agentDir,
				"repo",
				`s-${String(i).padStart(3, "0")}`,
				{ cwd: `/repo/<tag>&branch/${"x".repeat(500)}` },
				1000 + i,
			);
		}

		await daemon.handleTelegramUpdate(msg("42", "/session_recent", 4));

		const sends = calls.filter(c => c.method === "sendMessage");
		expect(sends.length).toBeGreaterThan(1);
		expect(sends.every(c => c.body?.parse_mode === TELEGRAM_PARSE_MODE)).toBe(true);
		expect(sends.every(c => String(c.body?.text).length <= 4096)).toBe(true);
		expect(String(sends[0]?.body?.text).startsWith("<pre>")).toBe(true);
		expect(sends.map(c => String(c.body?.text)).join("")).toContain("/repo/&lt;tag&gt;&amp;branch");
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
});
