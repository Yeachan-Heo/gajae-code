import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../src/config/settings";
import { TELEGRAM_PARSE_MODE } from "../src/sdk/bus/html-format";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import type { AgentDirSessionLifecycleService } from "../src/sdk/lifecycle/client";
import type { ListRecentSessionsResult } from "../src/sdk/lifecycle/recent-sessions";

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

type Call = { operation: string; requestKey?: string; actor?: unknown; target?: unknown };

function lifecycleHarness() {
	const calls: Call[] = [];
	let recent: ListRecentSessionsResult = { kind: "complete", entries: [], warnings: [] };
	const service = {
		createExternal: async (request: Record<string, unknown>) => {
			calls.push({
				operation: "session.create",
				requestKey: request.requestKey as string,
				actor: request.actor,
				target: request.target,
			});
			return { ok: true, operation: "session.create", result: { sessionId: "broker-session-1", cwd: "/repo" } };
		},
		close: async (request: Record<string, unknown>) => {
			calls.push({
				operation: "session.close",
				requestKey: request.requestKey as string,
				actor: request.actor,
				target: request.target,
			});
			return { ok: true, operation: "session.close", result: { sessionId: "broker-session-1" } };
		},
		resumeExternal: async (request: Record<string, unknown>) => {
			calls.push({
				operation: "session.resume",
				requestKey: request.requestKey as string,
				actor: request.actor,
				target: request.target,
			});
			return {
				kind: "result",
				outcome: { ok: true, operation: "session.resume", result: { sessionId: "broker-session-1", reused: true } },
			};
		},
		listRecent: async () => ({ ...recent }),
	} as unknown as AgentDirSessionLifecycleService;
	return { calls, service, setRecent: (value: ListRecentSessionsResult) => (recent = value) };
}

function bot() {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const api = {
		call: async (method: string, body: Record<string, unknown>) => {
			calls.push({ method, body });
			if (method === "getChat") return { ok: true, result: { id: body.chat_id, type: "private" } };
			return { ok: true, result: [] };
		},
	};
	return { api: api as never, calls };
}

function daemon(
	agentDir: string,
	botApi: never,
	service: AgentDirSessionLifecycleService,
	factoryCalls: { count: number },
): TelegramNotificationDaemon {
	return new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner",
		botToken: "tok",
		chatId: "42",
		botApi,
		createLifecycleService: () => {
			factoryCalls.count++;
			return service;
		},
	});
}

function message(text: string, updateId: number, threadId?: number): unknown {
	return {
		update_id: updateId,
		message: {
			chat: { id: "42", type: "private" },
			from: { id: 42, is_bot: false },
			text,
			message_id: updateId,
			...(threadId === undefined ? {} : { message_thread_id: threadId }),
		},
	};
}

describe("Telegram lifecycle command routing", () => {
	test("routes create, close, and resume only through the SDK lifecycle service", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-route-"));
		const { calls, service } = lifecycleHarness();
		const { api, calls: botCalls } = bot();
		const factoryCalls = { count: 0 };
		const daemonInstance = daemon(agentDir, api, service, factoryCalls);
		await daemonInstance.handleTelegramUpdate(message("/session_create path /repo", 10));
		await daemonInstance.handleTelegramUpdate(message("/session_close broker-session-1", 11));
		await daemonInstance.handleTelegramUpdate(message("/session_resume broker-session-1", 12));
		expect(calls.map(call => call.operation)).toEqual(["session.create", "session.close", "session.resume"]);
		expect(calls.map(call => call.requestKey)).toEqual(["telegram:42:10", "telegram:42:11", "telegram:42:12"]);
		expect(calls.every(call => call.actor && typeof call.actor === "object")).toBe(true);
		expect(JSON.stringify(botCalls)).not.toContain("endpoint");
		expect(JSON.stringify(botCalls)).not.toContain("token");
		expect(factoryCalls.count).toBe(1);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("resumes the durably associated session when invoked without an id in its old thread", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-thread-route-"));
		const notificationsDir = path.join(agentDir, "notifications");
		fs.mkdirSync(notificationsDir, { recursive: true });
		fs.writeFileSync(
			path.join(notificationsDir, "telegram-topics.json"),
			JSON.stringify({
				version: 2,
				registryGeneration: 1,
				topics: {
					"broker-session-1": {
						topicId: "77",
						topicOrigin: "daemon_created",
						sessionUuid: "00000000-0000-4000-8000-000000000077",
						identitySent: true,
						createdAt: 1,
						authorityEpoch: 1,
						authorityState: "inactive",
						chatId: "42",
						telegramBinding: { chatId: "42", transport: "telegram" },
					},
				},
			}),
		);
		const { calls, service } = lifecycleHarness();
		const telegram = bot();
		const daemonInstance = daemon(agentDir, telegram.api, service, { count: 0 });
		try {
			await daemonInstance.loadTopics();
			await daemonInstance.handleTelegramUpdate(message("/session_resume", 13, 77));
			expect(calls).toContainEqual(
				expect.objectContaining({
					operation: "session.resume",
					target: { sessionIdOrPrefix: "broker-session-1" },
				}),
			);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("duplicate update across daemon restart reuses one stable lifecycle request key", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-restart-"));
		const { calls, service } = lifecycleHarness();
		const firstBot = bot();
		const secondBot = bot();
		const first = daemon(agentDir, firstBot.api, service, { count: 0 });
		const second = daemon(agentDir, secondBot.api, service, { count: 0 });
		await first.handleTelegramUpdate(message("/session_create path /repo", 99));
		await second.handleTelegramUpdate(message("/session_create path /repo", 99));
		expect(calls.map(call => call.requestKey)).toEqual(["telegram:42:99", "telegram:42:99"]);
		expect(new Set(calls.map(call => call.requestKey)).size).toBe(1);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("limits distinct session creates per Telegram actor without blocking idempotent retries", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-rate-limit-"));
		const { calls, service } = lifecycleHarness();
		const telegram = bot();
		const daemonInstance = daemon(agentDir, telegram.api, service, { count: 0 });
		try {
			await daemonInstance.handleTelegramUpdate(message("/session_create path /repo", 201));
			await daemonInstance.handleTelegramUpdate(message("/session_create path /repo", 202));
			await daemonInstance.handleTelegramUpdate(message("/session_create path /repo", 203));
			await daemonInstance.handleTelegramUpdate(message("/session_create path /repo", 204));
			expect(calls.filter(call => call.operation === "session.create").map(call => call.requestKey)).toEqual([
				"telegram:42:201",
				"telegram:42:202",
				"telegram:42:203",
			]);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("session_recent is provided by lifecycleService.listRecent and rendered without credentials", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-recent-"));
		const { service, setRecent } = lifecycleHarness();
		setRecent({
			kind: "complete",
			entries: [
				{
					sessionId: "broker-session-1",
					path: "/repo",
					sessionStateFile: "/sessions/broker-session-1.jsonl",
					mtimeMs: 1,
				},
			],
			warnings: [],
		});
		const { api, calls } = bot();
		const daemonInstance = daemon(agentDir, api, service, { count: 0 });
		await daemonInstance.handleTelegramUpdate(message("/session_recent", 101));
		const recent = calls.find(call => call.method === "sendMessage");
		expect(recent?.body.parse_mode).toBe(TELEGRAM_PARSE_MODE);
		expect(String(recent?.body.text)).toContain("broker-session-1");
		expect(String(recent?.body.text)).toContain("saved");
		expect(String(recent?.body.text)).toContain("/session_resume broker-session-1");
		expect(JSON.stringify(calls)).not.toContain("endpoint");
		expect(JSON.stringify(calls)).not.toContain("token");
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
});
