import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationServer } from "../../natives/native/index.js";
import { Settings } from "../src/config/settings";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { createNotificationsExtension } from "../src/sdk/bus";
import {
	type BotApi,
	registerNotificationRoot,
	type TelegramDaemonFs,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";

const THREAD_ID = 901;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function stopDetachedBroker(agentDir: string): Promise<void> {
	const discovery = await readBrokerDiscovery(agentDir);
	if (!discovery) return;
	try {
		process.kill(discovery.pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(discovery.pid, 0);
			await sleep(25);
		} catch {
			return;
		}
	}
	try {
		process.kill(discovery.pid, "SIGKILL");
	} catch {}
}

class Bot implements BotApi {
	readonly calls: Array<{
		method: string;
		body: Record<string, unknown>;
		options?: { noRetry?: boolean; signal?: AbortSignal };
	}> = [];
	async call(method: string, body: unknown, options?: { noRetry?: boolean; signal?: AbortSignal }): Promise<unknown> {
		this.calls.push({ method, body: body as Record<string, unknown>, options });
		switch (method) {
			case "getChat":
				return { ok: true, result: { type: "private" } };
			case "getMe":
				return { ok: true, result: { username: "gjc_bot" } };
			case "createForumTopic":
				return { ok: true, result: { message_thread_id: THREAD_ID } };
			case "sendMessage":
			case "sendRichMessage":
				return { ok: true, result: { message_id: this.calls.length } };
			default:
				return { ok: true, result: true };
		}
	}
	count(method: string): number {
		return this.calls.filter(call => call.method === method).length;
	}
}

function isolatedSettings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": "42",
		"notifications.telegram.btw.enabled": true,
	}) as Settings;
	return new Proxy(base, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}
test("real notifications extension rebinds /btw without provider replay or main-session injection", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-btw-extension-e2e-"));
	const cwd = path.join(agentDir, "repo");
	const sessionId = "btw-extension-e2e";
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const providerCalls: Array<{ prompt: string; signal?: AbortSignal }> = [];
	const providerResponse = Promise.withResolvers<{ replyText: string }>();
	let mainSessionInjections = 0;
	const settings = isolatedSettings(agentDir);
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Extension BTW",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		getContextUsage: () => undefined,
		getModel: () => undefined,
	} as never;
	const bot = new Bot();
	const daemon = new TelegramNotificationDaemon({
		settings,
		ownerId: "owner",
		botToken: "token",
		chatId: "42",
		botApi: bot,
		fs: fs.promises as unknown as TelegramDaemonFs,
		pidAlive: () => true,
		btw: { enabled: true },
		rich: { enabled: true },
	});
	try {
		createNotificationsExtension(
			{
				on: (event: string, handler: (event: unknown, context: unknown) => Promise<unknown>) =>
					handlers.set(event, handler),
				registerCommand: () => {},
				sendUserMessage: async () => {
					mainSessionInjections++;
				},
			} as never,
			{
				settings,
				runEphemeralTurn: async (prompt, signal) => {
					providerCalls.push({ prompt, signal });
					if (signal?.aborted) throw signal.reason;
					return await providerResponse.promise;
				},
				ensureTelegramDaemon: async input => {
					await registerNotificationRoot(input);
					return "attached";
				},
			},
		);
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await daemon.scanRoots();
		await waitFor(
			() =>
				daemon.sessions.get(sessionId)?.ephemeralCapable === true &&
				(daemon.sessions.get(sessionId)?.hostGeneration ?? 0) >= 1 &&
				bot.count("createForumTopic") === 1 &&
				bot.count("sendMessage") >= 1,
			"extension daemon capability, topic, and identity",
		);
		const sendMessageBefore = bot.count("sendMessage");
		const richBefore = bot.count("sendRichMessage");
		await daemon.handleTelegramUpdate({
			update_id: 87,
			message: {
				message_id: 870,
				chat: { id: 42 },
				message_thread_id: THREAD_ID,
				text: "/btw exact side question",
			},
		});
		await waitFor(() => providerCalls.length === 1, "EphemeralTurnHost provider invocation");
		daemon.sessions.get(sessionId)!.ws.close();
		await waitFor(() => !daemon.sessions.has(sessionId), "extension transient transport loss");
		await daemon.scanRoots();
		await waitFor(
			() =>
				daemon.sessions.get(sessionId)?.ephemeralCapable === true &&
				(daemon.sessions.get(sessionId)?.hostGeneration ?? 0) >= 1,
			"extension replacement capability replay",
		);
		await sleep(80);
		expect(providerCalls).toHaveLength(1);
		providerResponse.resolve({ replyText: "| Formula | Value |\n| --- | --- |\n| $x^2$ | 4 |" });
		await waitFor(() => bot.count("sendRichMessage") === richBefore + 1, "correlated rich /btw delivery");
		expect(providerCalls).toHaveLength(1);
		expect(providerCalls[0]!.prompt).toBe(`<btw>
This is an ephemeral side question for the current interactive session.
Answer briefly and directly using the conversation context already provided.
Do not use tools.
Do not ask follow-up questions.
Question:
exact side question
</btw>`);
		expect(providerCalls[0]!.signal).toBeInstanceOf(AbortSignal);
		expect(mainSessionInjections).toBe(0);
		expect(bot.count("sendMessage")).toBe(sendMessageBefore);
		const richCalls = bot.calls.filter(call => call.method === "sendRichMessage");
		const richCall = richCalls.at(-1)!;
		expect(richCalls).toHaveLength(richBefore + 1);
		expect(richCall.body).toEqual({
			chat_id: "42",
			message_thread_id: THREAD_ID,
			reply_parameters: { message_id: 870 },
			rich_message: {
				markdown: "| Formula | Value |\n| --- | --- |\n| $x^2$ | 4 |",
				skip_entity_detection: true,
			},
		});
		expect(richCall.options?.noRetry).toBe(true);
		expect(richCall.options?.signal).toBeInstanceOf(AbortSignal);
	} finally {
		if (handlers.has("session_shutdown")) await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		daemon.requestStop();
		await sleep(40);
		await stopDetachedBroker(agentDir);
		await fs.promises.rm(agentDir, { recursive: true, force: true });
	}
}, 30_000);

test("/btw travels through NotificationServer and a real WebSocket with one strict terminal dispatch", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-btw-e2e-"));
	try {
		const settings = isolatedSettings(agentDir);
		const sessionId = "btw-e2e";
		const cwd = path.join(agentDir, "repo");
		await registerNotificationRoot({ settings, cwd, sessionId });
		const server = new NotificationServer(sessionId, "token", path.join(cwd, ".gjc", "state"), true);
		const inbound: Array<Record<string, unknown>> = [];
		const inboundKinds: string[] = [];
		server.onSdkFrame((error, frame) => {
			if (error || !frame) return;
			const request = JSON.parse(frame.json) as Record<string, unknown>;
			if (request.type !== "event_replay") return;
			server.sendTo(
				frame.connectionId,
				JSON.stringify({
					type: "event_replay_result",
					id: request.id,
					ok: true,
					generation: 4,
					lastSeq: 0,
					events: [],
				}),
			);
		});
		server.onInbound((error, frame) => {
			if (error || !frame) return;
			inboundKinds.push(frame.kind);
			if (frame.kind !== "ephemeral_turn") return;
			inbound.push(frame as unknown as Record<string, unknown>);
		});
		await server.start();
		const bot = new Bot();
		const daemon = new TelegramNotificationDaemon({
			settings,
			ownerId: "owner",
			botToken: "token",
			chatId: "42",
			botApi: bot,
			fs: fs.promises as unknown as TelegramDaemonFs,
			pidAlive: () => true,
			btw: { enabled: true },
		});
		try {
			await daemon.scanRoots();
			await waitFor(() => daemon.sessions.has(sessionId) && server.clientCount() === 1, "daemon connection");
			server.pushFrame(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ephemeral_turn_v1"] }));
			server.pushFrame(
				JSON.stringify({ type: "identity_header", sessionId, repo: "repo", branch: "main", machine: "test" }),
			);
			await waitFor(() => bot.count("createForumTopic") === 1, "known private topic");
			await waitFor(
				() =>
					daemon.sessions.get(sessionId)?.hostGeneration === 4 &&
					daemon.sessions.get(sessionId)?.ephemeralCapable === true,
				"ephemeral capability replay",
			);
			await sleep(80);
			const terminalDispatchCount = () =>
				bot.calls.filter(call => call.method === "sendMessage" || call.method === "sendRichMessage").length;
			const before = terminalDispatchCount();
			await daemon.handleTelegramUpdate({
				update_id: 7,
				message: { message_id: 70, chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw status?" },
			});
			await waitFor(() => inbound.length === 1, "ephemeral turn");
			expect(inbound).toHaveLength(1);
			expect(inboundKinds).toEqual(["ephemeral_turn"]);
			expect(inbound[0]).toMatchObject({
				sessionId,
				updateId: 7,
				messageId: 70,
				threadId: String(THREAD_ID),
				text: "status?",
			});
			const turn = inbound[0]!;
			const connectionId = turn.connectionId;
			if (typeof connectionId !== "string" || !connectionId)
				throw new Error("native inbound event did not preserve the authenticated connection ID");
			for (const mismatch of [
				{ updateId: 8 },
				{ messageId: 71 },
				{ threadId: String(THREAD_ID + 1) },
				{ sessionId: "other" },
			]) {
				server.sendTo(
					connectionId,
					JSON.stringify({
						type: "ephemeral_turn_result",
						sessionId,
						requestId: turn.requestId,
						updateId: 7,
						messageId: 70,
						threadId: String(THREAD_ID),
						status: "ok",
						text: "wrong",
						...mismatch,
					}),
				);
				await sleep(40);
				expect(terminalDispatchCount(), JSON.stringify(mismatch)).toBe(before);
			}
			const terminal = {
				type: "ephemeral_turn_result",
				sessionId,
				requestId: turn.requestId,
				updateId: 7,
				messageId: 70,
				threadId: String(THREAD_ID),
				status: "ok",
				text: "ephemeral answer",
			};
			server.sendTo(connectionId, JSON.stringify(terminal));
			await waitFor(() => terminalDispatchCount() === before + 1, "Telegram terminal dispatch");
			server.sendTo(connectionId, JSON.stringify(terminal));
			await sleep(80);
			expect(terminalDispatchCount()).toBe(before + 1);
			const reply = bot.calls.at(-1)!;
			expect(reply.body).toMatchObject({ chat_id: "42", message_thread_id: THREAD_ID });
		} finally {
			daemon.requestStop();
			server.stop();
			await sleep(40);
			await fs.promises.rm(agentDir, { recursive: true, force: true });
		}
	} catch (err) {
		await fs.promises.rm(agentDir, { recursive: true, force: true });
		throw err;
	}
}, 30_000);
test("/btw reconnect rebinds the existing provider request without cancellation", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-btw-reconnect-e2e-"));
	try {
		const settings = isolatedSettings(agentDir);
		const sessionId = "btw-reconnect-e2e";
		const cwd = path.join(agentDir, "repo");
		await registerNotificationRoot({ settings, cwd, sessionId });
		const inbound: Array<Record<string, unknown>> = [];
		const cancelFrames: Array<Record<string, unknown>> = [];
		const installCallbacks = (server: NotificationServer) => {
			server.onSdkFrame((error, frame) => {
				if (error || !frame) return;
				const request = JSON.parse(frame.json) as Record<string, unknown>;
				if (request.type === "ephemeral_turn_cancel") cancelFrames.push(request);
				if (request.type === "event_replay") {
					server.sendTo(
						frame.connectionId,
						JSON.stringify({
							type: "event_replay_result",
							id: request.id,
							ok: true,
							generation: 4,
							lastSeq: 0,
							events: [],
						}),
					);
				}
			});
			server.onInbound((error, frame) => {
				if (error || !frame) return;
				const message = frame as unknown as Record<string, unknown>;
				if (frame.kind === "ephemeral_turn") inbound.push(message);
			});
		};
		const server = new NotificationServer(sessionId, "token", path.join(cwd, ".gjc", "state"), true);
		installCallbacks(server);
		await server.start();
		const bot = new Bot();
		const daemon = new TelegramNotificationDaemon({
			settings,
			ownerId: "owner",
			botToken: "token",
			chatId: "42",
			botApi: bot,
			fs: fs.promises as unknown as TelegramDaemonFs,
			pidAlive: () => true,
			btw: { enabled: true },
			rich: { enabled: false },
		});
		try {
			await daemon.scanRoots();
			await waitFor(() => daemon.sessions.has(sessionId) && server.clientCount() === 1, "initial daemon connection");
			server.pushFrame(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ephemeral_turn_v1"] }));
			server.pushFrame(
				JSON.stringify({ type: "identity_header", sessionId, repo: "repo", branch: "main", machine: "test" }),
			);
			await waitFor(
				() => daemon.sessions.get(sessionId)?.hostGeneration === 4 && bot.count("createForumTopic") === 1,
				"initial generation-4 topic",
			);
			await sleep(80);
			await daemon.handleTelegramUpdate({
				update_id: 17,
				message: { message_id: 170, chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw survive?" },
			});
			await waitFor(() => inbound.length === 1, "initial ephemeral provider call");
			const turn = inbound[0]!;
			const beforeTerminal = bot.count("sendMessage");

			daemon.sessions.get(sessionId)!.ws.close();
			await waitFor(() => !daemon.sessions.has(sessionId) && server.clientCount() === 0, "transient transport loss");
			expect(cancelFrames).toHaveLength(0);
			expect(inbound).toHaveLength(1);

			await daemon.scanRoots();
			await waitFor(
				() => daemon.sessions.has(sessionId) && server.clientCount() === 1,
				"replacement daemon connection",
			);
			server.pushFrame(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ephemeral_turn_v1"] }));
			await waitFor(() => daemon.sessions.get(sessionId)?.hostGeneration === 4, "replacement generation-4 replay");
			expect(inbound).toHaveLength(2);
			expect(inbound[1]!.requestId).toBe(turn.requestId);
			expect(cancelFrames).toHaveLength(0);

			const terminal = {
				type: "ephemeral_turn_result",
				sessionId,
				requestId: turn.requestId,
				updateId: 17,
				messageId: 170,
				threadId: String(THREAD_ID),
				status: "ok",
				text: "survived replacement",
			};
			server.pushFrame(JSON.stringify(terminal));
			await waitFor(() => bot.count("sendMessage") === beforeTerminal + 1, "single replacement terminal dispatch");
			server.pushFrame(JSON.stringify(terminal));
			await sleep(80);
			expect(bot.count("sendMessage")).toBe(beforeTerminal + 1);
			expect(inbound).toHaveLength(2);
			expect(cancelFrames).toHaveLength(0);
		} finally {
			daemon.requestStop();
			server.stop();
			await sleep(40);
			await fs.promises.rm(agentDir, { recursive: true, force: true });
		}
	} catch (err) {
		await fs.promises.rm(agentDir, { recursive: true, force: true });
		throw err;
	}
}, 30_000);
test("/btw generation replacement terminalizes an old pending request exactly once", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-btw-crash-e2e-"));
	try {
		const settings = isolatedSettings(agentDir);
		const sessionId = "btw-crash-e2e";
		const cwd = path.join(agentDir, "repo");
		await registerNotificationRoot({ settings, cwd, sessionId });
		const inbound: Array<Record<string, unknown>> = [];
		const cancelFrames: Array<Record<string, unknown>> = [];
		let replayGeneration = 4;
		const installCallbacks = (server: NotificationServer): void => {
			server.onSdkFrame((error, frame) => {
				if (error || !frame) return;
				const request = JSON.parse(frame.json) as Record<string, unknown>;
				if (request.type === "ephemeral_turn_cancel") cancelFrames.push(request);
				if (request.type !== "event_replay") return;
				server.sendTo(
					frame.connectionId,
					JSON.stringify({
						type: "event_replay_result",
						id: request.id,
						ok: true,
						generation: replayGeneration,
						lastSeq: 0,
						events: [],
					}),
				);
			});
			server.onInbound((error, frame) => {
				if (!error && frame?.kind === "ephemeral_turn") inbound.push(frame as unknown as Record<string, unknown>);
			});
		};
		let server = new NotificationServer(sessionId, "token", path.join(cwd, ".gjc", "state"), true);
		installCallbacks(server);
		await server.start();
		const bot = new Bot();
		const daemon = new TelegramNotificationDaemon({
			settings,
			ownerId: "owner",
			botToken: "token",
			chatId: "42",
			botApi: bot,
			fs: fs.promises as unknown as TelegramDaemonFs,
			pidAlive: () => true,
			btw: { enabled: true },
			rich: { enabled: false },
		});
		try {
			await daemon.scanRoots();
			await waitFor(
				() => daemon.sessions.has(sessionId) && server.clientCount() === 1,
				"crash test daemon connection",
			);
			server.pushFrame(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ephemeral_turn_v1"] }));
			server.pushFrame(
				JSON.stringify({ type: "identity_header", sessionId, repo: "repo", branch: "main", machine: "test" }),
			);
			await waitFor(
				() =>
					daemon.sessions.get(sessionId)?.hostGeneration === 4 &&
					daemon.sessions.get(sessionId)?.ephemeralCapable === true &&
					bot.count("createForumTopic") === 1,
				"crash test generation-4 topic",
			);
			await sleep(80);
			await daemon.handleTelegramUpdate({
				update_id: 27,
				message: { message_id: 270, chat: { id: 42 }, message_thread_id: THREAD_ID, text: "/btw crash?" },
			});
			await waitFor(() => inbound.length === 1, "crash test provider call");
			const turn = inbound[0]!;
			const dispatches = () =>
				bot.calls.filter(call => call.method === "sendMessage" || call.method === "sendRichMessage").length;
			const beforeTerminal = dispatches();

			await server.stopAndWait();
			await waitFor(() => !daemon.sessions.has(sessionId), "crashed transport loss");
			expect(cancelFrames).toHaveLength(0);
			expect(inbound).toHaveLength(1);
			replayGeneration = 5;

			server = new NotificationServer(sessionId, "token", path.join(cwd, ".gjc", "state"), true);
			installCallbacks(server);
			await server.start();
			await daemon.scanRoots();
			await waitFor(
				() => daemon.sessions.has(sessionId) && server.clientCount() === 1,
				"post-crash daemon connection",
			);
			server.pushFrame(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["ephemeral_turn_v1"] }));
			await waitFor(() => daemon.sessions.get(sessionId)?.hostGeneration === 5, "post-crash generation-5 replay");
			expect(inbound).toHaveLength(1);
			expect(cancelFrames).toHaveLength(0);

			server.pushFrame(
				JSON.stringify({
					type: "ephemeral_turn_result",
					sessionId,
					requestId: turn.requestId,
					updateId: 27,
					messageId: 270,
					threadId: String(THREAD_ID),
					status: "ok",
					text: "must not cross crash boundary",
				}),
			);
			await sleep(120);
			expect(dispatches()).toBe(beforeTerminal + 1);
			expect(bot.calls.at(-1)!.body).toMatchObject({
				text: "This /btw question stopped because the GJC session closed or changed. Reopen it and try again.",
			});
			expect(inbound).toHaveLength(1);
			expect(cancelFrames).toHaveLength(0);
		} finally {
			daemon.requestStop();
			server.stop();
			await sleep(40);
			await fs.promises.rm(agentDir, { recursive: true, force: true });
		}
	} catch (err) {
		await fs.promises.rm(agentDir, { recursive: true, force: true });
		throw err;
	}
}, 30_000);
