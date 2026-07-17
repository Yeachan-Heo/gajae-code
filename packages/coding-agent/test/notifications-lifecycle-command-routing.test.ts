import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../src/config/settings";
import { TELEGRAM_PARSE_MODE } from "../src/sdk/bus/html-format";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import {
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
} from "../src/session/internal/managed-session-scope";

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
			if (method === "getChat") return { ok: true, result: { id: body?.chat_id, type: "private" } };
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

function writeSession(
	agentDir: string,
	cwd: string,
	id: string,
	header: object,
	mtimeMs: number,
	entries: object[] = [],
): void {
	const sessionsRoot = path.join(agentDir, "sessions");
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(prepared.message);
	const file = path.join(prepared.scope.directoryPath, `${id}.jsonl`);
	const suffix = entries.length > 0 ? `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n` : "";
	fs.writeFileSync(file, `${JSON.stringify({ ...header, type: "session", id, cwd })}\n${suffix}`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
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
	test("/session_recent is sent as escaped bullet rows with inline code", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		const { calls, api } = spyBot();
		const daemon = makeDaemon(agentDir, api);
		(daemon as unknown as { lifecycleControlActive: boolean }).lifecycleControlActive = true;
		const cwd = path.join(agentDir, "repo-<tag>&branch", "x".repeat(100));
		fs.mkdirSync(cwd, { recursive: true });
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (let i = 0; i < 20; i++) {
			writeSession(agentDir, cwd, `s-${String(i).padStart(3, "0")}`, {}, 1000 + i);
		}

		await daemon.handleTelegramUpdate(msg("42", "/session_recent", 4));

		const sends = calls.filter(c => c.method === "sendMessage");
		expect(sends.length).toBe(1);
		expect(sends.every(c => c.body?.parse_mode === TELEGRAM_PARSE_MODE)).toBe(true);
		expect(sends.every(c => String(c.body?.text).length <= 4096)).toBe(true);
		const text = sends.map(c => String(c.body?.text)).join("");
		expect(text).not.toContain("<pre>");
		expect(text).toContain("<code>s-019</code>");
		expect(text).toContain(
			`<code>${cwd.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code>`,
		);
		expect(Array.from(text.matchAll(/^• <code>s-\d{3}<\/code> \(<code>.*<\/code>\)$/gm))).toHaveLength(10);
		cwdSpy.mockRestore();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	test("/session_recent hides internal helper sessions by default", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		const { calls, api } = spyBot();
		const daemon = makeDaemon(agentDir, api);
		(daemon as unknown as { lifecycleControlActive: boolean }).lifecycleControlActive = true;
		const cwd = path.join(agentDir, "repo-user");
		fs.mkdirSync(cwd, { recursive: true });
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		writeSession(agentDir, cwd, "user-session", {}, 1000);
		writeSession(agentDir, cwd, "helper-session", {}, 2000, [{ type: "session_init" }]);

		await daemon.handleTelegramUpdate(msg("42", "/session_recent", 5));

		const text = calls
			.filter(c => c.method === "sendMessage")
			.map(c => String(c.body?.text))
			.join("");
		expect(text).toContain("user-session");
		expect(text).toContain(cwd);
		expect(text).not.toContain("helper-session");
		cwdSpy.mockRestore();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	test("a paired private lifecycle response uses unsupported-platform copy", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lc-route-"));
		try {
			const { calls, api } = spyBot();
			const daemon = makeDaemon(agentDir, api);
			const control = daemon as unknown as {
				lifecycleControlActive: boolean;
				submitLifecycleFrame: () => Promise<{
					type: "session_lifecycle_error";
					requestId: string;
					status: "error";
					reason: "unsupported_platform";
					message: string;
				}>;
			};
			control.lifecycleControlActive = true;
			control.submitLifecycleFrame = async () => ({
				type: "session_lifecycle_error",
				requestId: "request-1",
				status: "error",
				reason: "unsupported_platform",
				message: "ignored",
			});

			await daemon.handleTelegramUpdate(msg("42", "/session_create path /repo", 6));

			const sends = calls.filter(call => call.method === "sendMessage");
			expect(sends).toHaveLength(1);
			expect(sends[0]?.body?.text).toBe(
				"Remote session lifecycle is unavailable on this psmux host because GJC cannot prove immutable session identity. No lifecycle action was performed. Use a local GJC terminal with a supported tmux provider.",
			);
			expect(String(sends[0]?.body?.text)).not.toContain("Launching");
			expect(String(sends[0]?.body?.text)).not.toContain("in progress");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
