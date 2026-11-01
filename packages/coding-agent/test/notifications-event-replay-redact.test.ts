import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getNotificationConfig } from "../src/sdk/bus/config";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { NotificationSessionController } from "../src/sdk/bus/session-control";
import {
	cleanupFixtureRoots,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";
import { readTestSdkEndpoint } from "./helpers/sdk-endpoint";
import { withTelegramOrchestrationProvenance } from "./helpers/telegram-topic-test";

const MARKER = "PLAINTEXT_REPLAY_MARKER";
// The session broker resolves hardware identity with ioreg, which lives in /usr/sbin.
if (!process.env.PATH?.split(":").includes("/usr/sbin")) {
	process.env.PATH = `${process.env.PATH ?? ""}:/usr/sbin`;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(25);
	}
	throw new Error(`timeout waiting for ${label}`);
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Frame = {
	type?: string;
	id?: string;
	text?: string;
	redact?: boolean;
	events?: Array<{ kind?: string; payload?: { text?: string; diff?: string } }>;
};

const cleanupRoots: FixtureRootCleanup[] = [];
const openSockets: WebSocket[] = [];
const envKeys = ["GJC_NOTIFICATIONS", "GJC_NOTIFICATIONS_STREAM", "GJC_NOTIFICATIONS_STREAM_INTERVAL_MS"] as const;
let savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
	for (const ws of openSockets.splice(0)) ws.close();
	await cleanupFixtureRoots(cleanupRoots);
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	savedEnv = {};
});

async function boot(): Promise<{
	handlers: Map<string, Handler>;
	ctx: unknown;
	frames: Frame[];
	ws: WebSocket;
	url: string;
	token: string;
}> {
	for (const key of envKeys) savedEnv[key] = process.env[key];
	process.env.GJC_NOTIFICATIONS = "1";
	process.env.GJC_NOTIFICATIONS_STREAM = "1";
	process.env.GJC_NOTIFICATIONS_STREAM_INTERVAL_MS = "1";
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-replay-redact-"));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanupRoots.push(cleanup);
	const settings = isolatedNotificationSettings(agentDir, {
		"notifications.verbosity": "verbose",
		"notifications.redact": false,
	});
	const controller = new NotificationSessionController({
		eligible: true,
		getConfig: () => getNotificationConfig(settings),
	});
	withTelegramOrchestrationProvenance(() =>
		createNotificationsExtension(api, { settings, controller, ensureTelegramDaemon: async () => "attached" }),
	);
	const sid = `replay-redact-${process.pid}-${Date.now()}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Replay Redact",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		getContextUsage: () => undefined,
		getModel: () => undefined,
		getActivePromptHandle: () => undefined,
	};
	registerNotificationRuntime(cleanup, {
		key: `notification-session:${sid}`,
		shutdown: async () => {
			await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		},
	});
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`);
	await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file");
	const { url, token } = readTestSdkEndpoint(endpointFile);
	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("websocket error")));
	});
	ws.addEventListener("message", event => frames.push(JSON.parse(String((event as MessageEvent).data)) as Frame));
	await sleep(50);
	return { handlers, ctx, frames, ws, url, token };
}

function replayEvents(frames: Frame[], id: string): NonNullable<Frame["events"]> {
	const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === id);
	expect(replay?.events).toBeDefined();
	return replay!.events!;
}

async function replay(url: string, token: string, id: string): Promise<Frame[]> {
	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", event => frames.push(JSON.parse(String((event as MessageEvent).data)) as Frame));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("websocket error")));
	});
	ws.send(JSON.stringify({ type: "event_replay", id, sinceSeq: 0 }));
	await waitFor(() => frames.some(frame => frame.type === "event_replay_result" && frame.id === id), 4000, id);
	return frames;
}

test("event_replay keeps stored plaintext while the switch is off", async () => {
	const session = await boot();
	await session.handlers.get("message_update")!(
		{ type: "message_update", message: { role: "assistant", content: MARKER } },
		session.ctx,
	);
	await waitFor(
		() => session.frames.some(frame => frame.type === "turn_stream" && frame.text?.includes(MARKER)),
		3000,
		"live turn",
	);
	const frames = await replay(session.url, session.token, "allowed");
	const events = replayEvents(frames, "allowed");
	expect(events.some(event => event.kind === "turn_stream" && event.payload?.text?.includes(MARKER))).toBe(true);
	expect(events.some(event => event.kind === "identity_header" || event.kind === "activity")).toBe(true);
	await session.handlers.get("session_shutdown")!({ type: "session_shutdown" }, session.ctx);
}, 20000);

test("event_replay drops stored plaintext after redaction and keeps other events", async () => {
	const session = await boot();
	await session.handlers.get("message_update")!(
		{ type: "message_update", message: { role: "assistant", content: MARKER } },
		session.ctx,
	);
	await waitFor(
		() => session.frames.some(frame => frame.type === "turn_stream" && frame.text?.includes(MARKER)),
		3000,
		"live turn",
	);
	session.ws.send(
		JSON.stringify({
			type: "config_command",
			sessionId: (session.ctx as { sessionManager: { getSessionId: () => string } }).sessionManager.getSessionId(),
			token: session.token,
			redact: true,
		}),
	);
	await waitFor(
		() => session.frames.some(frame => frame.type === "config_update" && frame.redact === true),
		3000,
		"redact update",
	);
	const frames = await replay(session.url, session.token, "withheld");
	const events = replayEvents(frames, "withheld");
	expect(JSON.stringify(events)).not.toContain(MARKER);
	expect(events.some(event => event.kind === "turn_stream")).toBe(false);
	expect(
		events.some(
			event => event.kind === "config_update" || event.kind === "identity_header" || event.kind === "activity",
		),
	).toBe(true);
	await session.handlers.get("session_shutdown")!({ type: "session_shutdown" }, session.ctx);
}, 20000);
