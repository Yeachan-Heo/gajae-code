import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { readEndpoint } from "../src/sdk/bus/telegram-reference";
import {
	cleanupFixtureRoots,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

/**
 * Regression for "hard terminal close orphans the Telegram topic": a native
 * terminal-window close (SIGHUP), SIGTERM, or fatal error never runs
 * AgentSession.dispose(), so the `session_shutdown` extension event does not
 * fire and no `session_closed` frame reaches connected clients — the daemon
 * keeps the session's forum topic forever. The notifications extension must
 * register a postmortem cleanup that emits `session_closed` on those teardown
 * paths, and cancel it when the session stops through any other path.
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000, label = "condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${label}`);
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Frame = { type: string; sessionId?: string };
type CleanupCallback = (reason: postmortem.Reason) => void | Promise<void>;

const cleanupRoots: FixtureRootCleanup[] = [];
const openSockets: WebSocket[] = [];
afterEach(async () => {
	for (const ws of openSockets.splice(0)) ws.close();
	await cleanupFixtureRoots(cleanupRoots);
	vi.restoreAllMocks();
});

async function createHarness(prefix: string) {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanupRoots.push(cleanup);
	createNotificationsExtension(api, { settings: isolatedNotificationSettings(agentDir) });

	const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const sid = `${prefix}${suffix}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Original",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;

	const endpoint = path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`);
	return { handlers, ctx, sid, endpoint, cleanup };
}

async function connectFrames(endpoint: string): Promise<Frame[]> {
	const { url, token } = readEndpoint(endpoint);
	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws error")));
	});
	await sleep(250);
	return frames;
}

async function withNotifications<T>(fn: () => Promise<T>): Promise<T> {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		return await fn();
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}

test("postmortem teardown emits session_closed to connected clients", async () => {
	await withNotifications(async () => {
		const registered = new Map<string, CleanupCallback>();
		vi.spyOn(postmortem, "register").mockImplementation((id: string, cb: CleanupCallback) => {
			registered.set(id, cb);
			return () => {
				registered.delete(id);
			};
		});

		const harness = await createHarness("gjc-notif-pm-");
		registerNotificationRuntime(harness.cleanup, {
			key: `notification-session:${harness.sid}`,
			shutdown: async () => {
				await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
			},
		});
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		await waitFor(() => fs.existsSync(harness.endpoint), 4000, "endpoint file");
		const frames = await connectFrames(harness.endpoint);

		const cleanup = registered.get(`notifications-session-closed:${harness.sid}`);
		expect(cleanup).toBeDefined();

		// Simulate the postmortem signal path (SIGHUP/SIGTERM/fatal error).
		await cleanup!(postmortem.Reason.SIGTERM);
		await cleanup!(postmortem.Reason.SIGTERM);

		await waitFor(
			() => frames.some(f => f.type === "session_closed" && f.sessionId === harness.sid),
			4000,
			"session_closed frame",
		);
		await sleep(100);
		expect(frames.filter(f => f.type === "session_closed" && f.sessionId === harness.sid)).toHaveLength(1);
	});
}, 20000);

test("graceful session_shutdown cancels the postmortem registration", async () => {
	await withNotifications(async () => {
		const registered = new Map<string, CleanupCallback>();
		vi.spyOn(postmortem, "register").mockImplementation((id: string, cb: CleanupCallback) => {
			registered.set(id, cb);
			return () => {
				registered.delete(id);
			};
		});

		const harness = await createHarness("gjc-notif-pm-cancel-");
		registerNotificationRuntime(harness.cleanup, {
			key: `notification-session:${harness.sid}`,
			shutdown: async () => {
				await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
			},
		});
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		await waitFor(() => fs.existsSync(harness.endpoint), 4000, "endpoint file");
		expect(registered.has(`notifications-session-closed:${harness.sid}`)).toBe(true);

		// A clean /quit path emits session_shutdown; the postmortem registration
		// must be cancelled so process teardown cannot double-fire.
		await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
		expect(registered.has(`notifications-session-closed:${harness.sid}`)).toBe(false);
	});
}, 20000);
