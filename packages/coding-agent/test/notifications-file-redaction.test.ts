import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTelegramFileSink } from "../src/sdk/bus/attachment-registry";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { readEndpoint } from "../src/sdk/bus/telegram-reference";
import {
	cleanupFixtureRoots,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(pred: () => boolean, ms = 4000, label = "condition"): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${label}`);
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Frame = { type: string; redact?: boolean };

const cleanupRoots: FixtureRootCleanup[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
	for (const ws of openSockets.splice(0)) ws.close();
	await cleanupFixtureRoots(cleanupRoots);
});

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

async function createHarness(redact: boolean) {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-file-redaction-"));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanupRoots.push(cleanup);
	const settings = isolatedNotificationSettings(agentDir, { "notifications.redact": redact });
	createNotificationsExtension(api, { settings });
	const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let sid = `file-redaction-${suffix}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "File Redaction",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	const endpoint = () => path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`);

	return {
		handlers,
		ctx,
		cwd,
		cleanup,
		get sid() {
			return sid;
		},
		set sid(value: string) {
			sid = value;
		},
		endpoint,
	};
}

async function startAndConnect(harness: Awaited<ReturnType<typeof createHarness>>): Promise<{
	frames: Frame[];
	ws: WebSocket;
	token: string;
}> {
	registerNotificationRuntime(harness.cleanup, {
		key: `notification-session:${harness.sid}`,
		shutdown: async () => {
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
		},
	});
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	await waitFor(() => fs.existsSync(harness.endpoint()), 4000, "endpoint file");
	const { url, token } = readEndpoint(harness.endpoint());
	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws error")));
	});
	await sleep(250);
	return { frames, ws, token };
}

function expectRedactionBlocked(result: { ok: boolean; error?: string }) {
	expect(result.ok).toBe(false);
	expect(result.error).toContain("redaction is on");
}

test("runtime redaction blocks telegram_send file attachments before reading or forwarding", async () => {
	await withNotifications(async () => {
		const harness = await createHarness(false);
		const { frames, ws, token } = await startAndConnect(harness);

		ws.send(JSON.stringify({ type: "config_command", sessionId: harness.sid, token, redact: true }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.redact === true), 3000, "redact update");

		const sink = getTelegramFileSink(harness.sid);
		expect(sink).toBeDefined();
		const missingSecretPath = path.join(harness.cwd, "secret-does-not-exist.txt");
		const result = await sink!({ path: missingSecretPath, caption: "secret" });

		expectRedactionBlocked(result);
		expect(frames.some(f => f.type === "file_attachment")).toBe(false);

		await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
	});
}, 20000);

test("session_switch keeps telegram_send file attachments blocked under redaction", async () => {
	await withNotifications(async () => {
		const harness = await createHarness(true);
		registerNotificationRuntime(harness.cleanup, {
			key: `notification-session:${harness.sid}`,
			shutdown: async () => {
				await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
			},
		});
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		await waitFor(() => fs.existsSync(harness.endpoint()), 4000, "endpoint file");

		const previousId = harness.sid;
		expect(getTelegramFileSink(previousId)).toBeDefined();
		harness.sid = `file-redaction-new-${previousId}`;
		const previousSessionFile = path.join(harness.cwd, ".gjc", "agent", "sessions", `ts_${previousId}.jsonl`);
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", reason: "new", previousSessionFile },
			harness.ctx,
		);

		expect(getTelegramFileSink(previousId)).toBeUndefined();
		const switchedSink = getTelegramFileSink(harness.sid);
		expect(switchedSink).toBeDefined();
		const result = await switchedSink!({ path: path.join(harness.cwd, "secret-does-not-exist.txt") });
		expectRedactionBlocked(result);

		await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
	});
}, 20000);
