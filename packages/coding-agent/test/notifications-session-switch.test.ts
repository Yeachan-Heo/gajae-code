import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/notifications/index";
import { readEndpoint } from "../src/notifications/telegram-reference";

/**
 * Regression for "notifications SDK spawns a new session instead of renaming":
 * an in-process session id change (`/new`, plan "approve and execute", fork,
 * resume) emits `session_switch` with a new session id. Previously the
 * notifications runtime was keyed only on `session_start`, so the new id had no
 * runtime and a fresh NotificationServer + endpoint discovery file + Telegram
 * topic would spawn instead of the existing thread being reused/renamed.
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
type Frame = { type: string; title?: string; sessionId?: string; state?: string };

const tempDirs: string[] = [];
const openSockets: WebSocket[] = [];
afterEach(() => {
	for (const ws of openSockets.splice(0)) ws.close();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

function createHarness(prefix: string, initialName: string | undefined = "Original") {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);

	const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let sid = `${prefix}${suffix}`;
	let name: string | undefined = initialName;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => name,
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;

	const notifDir = path.join(cwd, ".gjc", "state", "notifications");
	return {
		handlers,
		ctx,
		cwd,
		notifDir,
		get sid() {
			return sid;
		},
		set sid(value: string) {
			sid = value;
		},
		get name() {
			return name;
		},
		set name(value: string | undefined) {
			name = value;
		},
		endpoint(id = sid) {
			return path.join(notifDir, `${id}.json`);
		},
		previousSessionFile(id: string) {
			return path.join(cwd, ".gjc", "agent", "sessions", `ts_${id}.jsonl`);
		},
	};
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

async function startAndConnect(harness: ReturnType<typeof createHarness>): Promise<Frame[]> {
	await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
	await waitFor(() => fs.existsSync(harness.endpoint()), 4000, "original endpoint file");
	return connectFrames(harness.endpoint());
}

test("session_switch reuses the existing topic instead of spawning a new session", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const handlers = new Map<string, Handler>();
		const api = {
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			sendUserMessage: () => {},
		} as never;
		createNotificationsExtension(api);

		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-switch-"));
		tempDirs.push(cwd);

		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let sid = `switch-a-${suffix}`;
		let name = "Original";
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => sid,
				getSessionName: () => name,
				getArtifactsDir: () => cwd,
				getCwd: () => cwd,
			},
		} as never;

		await handlers.get("session_start")!({ type: "session_start" }, ctx);

		const notifDir = path.join(cwd, ".gjc", "state", "notifications");
		const originalEndpoint = path.join(notifDir, `${sid}.json`);
		await waitFor(() => fs.existsSync(originalEndpoint), 4000, "original endpoint file");

		const { url, token } = readEndpoint(originalEndpoint);
		const frames: Frame[] = [];
		const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
		openSockets.push(ws);
		ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("ws error")));
		});
		await sleep(250);

		// In-process session change: a fresh session id with a new (already-set) title.
		const previousSessionId = sid;
		sid = `switch-b-${suffix}`;
		name = "Renamed Plan";
		const previousSessionFile = path.join(cwd, ".gjc", "agent", "sessions", `ts_${previousSessionId}.jsonl`);
		await handlers.get("session_switch")!({ type: "session_switch", reason: "new", previousSessionFile }, ctx);

		// No new "session": the new id does NOT get its own endpoint discovery file,
		// and the original server keeps serving.
		const newEndpoint = path.join(notifDir, `${sid}.json`);
		expect(fs.existsSync(newEndpoint)).toBe(false);
		expect(fs.existsSync(originalEndpoint)).toBe(true);

		// The existing topic is renamed: an identity_header with the new title is
		// re-asserted over the SAME socket (the daemon edits the topic in place).
		await waitFor(
			() => frames.some(f => f.type === "identity_header" && f.title === "Renamed Plan"),
			4000,
			"identity_header rename frame",
		);

		// The runtime was re-keyed: events for the NEW id keep flowing over the same
		// socket. Without the re-key, agent_start would find no runtime and emit nothing.
		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitFor(
			() => frames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === sid),
			4000,
			"busy activity for new session id",
		);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("session_switch with missing previousSessionFile is a safe no-op", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-missing-prev-");
		const frames = await startAndConnect(harness);
		const originalId = harness.sid;
		const originalEndpoint = harness.endpoint(originalId);

		harness.sid = `switch-new-${originalId}`;
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: undefined },
			harness.ctx,
		);
		await sleep(250);

		expect(fs.existsSync(originalEndpoint)).toBe(true);
		expect(fs.existsSync(harness.endpoint(harness.sid))).toBe(false);

		harness.sid = originalId;
		await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.ctx);
		await waitFor(
			() => frames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === originalId),
			4000,
			"busy activity for original session id",
		);
	});
}, 30000);

test("session_switch with matching previous and current ids is a safe no-op", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-same-id-");
		const frames = await startAndConnect(harness);
		const originalId = harness.sid;
		const originalEndpoint = harness.endpoint(originalId);

		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(originalId) },
			harness.ctx,
		);
		await sleep(250);

		expect(fs.existsSync(originalEndpoint)).toBe(true);
		expect(frames.filter(f => f.type === "identity_header" && f.sessionId === originalId)).toHaveLength(0);

		await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.ctx);
		await waitFor(
			() => frames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === originalId),
			4000,
			"busy activity for unchanged session id",
		);
	});
}, 30000);

test("session_switch with no runtime for previous id is a safe no-op", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-no-runtime-");
		const missingPrevId = `missing-${harness.sid}`;
		const newId = harness.sid;

		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(missingPrevId) },
			harness.ctx,
		);
		await sleep(250);

		expect(fs.existsSync(harness.endpoint(newId))).toBe(false);
	});
}, 30000);

test("session_switch to unnamed session reuses socket without switch identity frame", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-unnamed-");
		const frames = await startAndConnect(harness);
		const originalId = harness.sid;
		const originalEndpoint = harness.endpoint(originalId);
		const initialFrameCount = frames.length;

		harness.sid = `switch-b-${originalId}`;
		harness.name = undefined;
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(originalId) },
			harness.ctx,
		);
		await sleep(250);

		expect(fs.existsSync(originalEndpoint)).toBe(true);
		expect(fs.existsSync(harness.endpoint(harness.sid))).toBe(false);
		expect(frames.slice(initialFrameCount).some(f => f.type === "identity_header")).toBe(false);

		await harness.handlers.get("agent_end")!({ type: "agent_end" }, harness.ctx);
		await waitFor(
			() => frames.some(f => f.type === "activity" && f.state === "idle" && f.sessionId === harness.sid),
			4000,
			"idle activity for unnamed switched session id",
		);
	});
}, 30000);

test("session_switch can chain A to B to C while keeping only the original endpoint", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-chain-");
		const frames = await startAndConnect(harness);
		const a = harness.sid;
		const originalEndpoint = harness.endpoint(a);
		const b = `switch-b-${a}`;
		const c = `switch-c-${a}`;

		harness.sid = b;
		harness.name = "Session B";
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(a) },
			harness.ctx,
		);
		harness.sid = c;
		harness.name = "Session C";
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(b) },
			harness.ctx,
		);
		await sleep(250);

		expect(fs.existsSync(originalEndpoint)).toBe(true);
		expect(fs.existsSync(harness.endpoint(b))).toBe(false);
		expect(fs.existsSync(harness.endpoint(c))).toBe(false);

		await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.ctx);
		await waitFor(
			() => frames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === c),
			4000,
			"busy activity for twice-switched session id",
		);
	});
}, 30000);
test("session_switch reason=resume starts a fresh runtime for the resumed session's own topic", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-resume-");
		await startAndConnect(harness);
		const idA = harness.sid;
		const endpointA = harness.endpoint(idA);
		expect(fs.existsSync(endpointA)).toBe(true);

		// Resume loads a DIFFERENT already-persisted session (its own id + title),
		// which owns its own forum topic — it must not hijack this terminal's topic.
		const idB = `resumed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		harness.sid = idB;
		harness.name = "Resumed Session";
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", reason: "resume", previousSessionFile: harness.previousSessionFile(idA) },
			harness.ctx,
		);

		// The previous session's endpoint is torn down and the resumed session gets
		// its OWN endpoint discovery file (its own topic), not the previous one.
		const endpointB = harness.endpoint(idB);
		await waitFor(() => fs.existsSync(endpointB), 4000, "resumed endpoint file");
		await waitFor(() => !fs.existsSync(endpointA), 4000, "previous endpoint removed");

		// The resumed session's fresh runtime serves over its own socket.
		const frames = await connectFrames(endpointB);
		await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.ctx);
		await waitFor(
			() => frames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === idB),
			4000,
			"busy activity for resumed session id",
		);
	});
}, 30000);
