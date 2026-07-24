import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { closeModelCache, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { getTelegramFileSink } from "../src/sdk/bus/attachment-registry";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { readEndpoint } from "../src/sdk/bus/telegram-reference";
import { SessionSdkHost } from "../src/sdk/host";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { getAskAnswerSource } from "../src/tools/ask-answer-registry";
import { cleanupFixtureRoot, registerFixtureRuntime } from "./helpers/fixture-broker-cleanup";
import {
	createNotificationFixtureRoot,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";

/**
 * Regression for "the SDK notification transport spawns a new session instead of renaming":
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

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
} {
	const result = Promise.withResolvers<T>();
	return { promise: result.promise, resolve: result.resolve, reject: result.reject };
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

function createHarness(
	prefix: string,
	initialName: string | undefined = "Original",
	onBranchStartupSettled?: (receipt: { sessionId: string; status: string }) => void,
) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, command),
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api, { onBranchStartupSettled });

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

	const notifDir = path.join(cwd, ".gjc", "state", "sdk");
	return {
		handlers,
		commands,
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

test("session_switch publishes successor SDK authority only after AgentSession restore commits", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-post-commit-switch-"));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const currentSessionManager = SessionManager.create(cwd, cwd);
	const targetSessionManager = SessionManager.create(cwd, cwd);
	targetSessionManager.appendMessage({ role: "user", content: "restored target message", timestamp: Date.now() });
	targetSessionManager.appendThinkingLevelChange("low");
	await targetSessionManager.ensureOnDisk();
	const targetSessionFile = targetSessionManager.getSessionFile();
	const targetSessionId = targetSessionManager.getSessionId();
	await targetSessionManager.close();
	if (!targetSessionFile) throw new Error("Expected persisted target session");

	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async () => {},
	} as never;
	createNotificationsExtension(api);
	const ctx = { cwd, sessionManager: currentSessionManager } as never;
	const predecessorSessionId = currentSessionManager.getSessionId();
	const predecessorEndpoint = path.join(cwd, ".gjc", "state", "sdk", `${predecessorSessionId}.json`);
	const successorEndpoint = path.join(cwd, ".gjc", "state", "sdk", `${targetSessionId}.json`);
	let session: AgentSession | undefined;
	let postCommitObserved = false;
	const extensionRunner = {
		hasHandlers: () => false,
		emit: async (event: { type: string; previousSessionFile?: string }) => {
			if (event.type !== "session_switch") return;
			postCommitObserved = true;
			expect(currentSessionManager.getSessionId()).toBe(targetSessionId);
			expect(session?.agent.state.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ role: "user", content: "restored target message" })]),
			);
			expect(session?.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(fs.existsSync(successorEndpoint)).toBe(false);
			await handlers.get("session_switch")!(event, ctx);
		},
	} as unknown as ExtensionRunner;

	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	registerFixtureRuntime(cleanup, {
		key: "auth-storage",
		requiredOwner: "runtime",
		dispose: async () => authStorage.close(),
	});
	registerFixtureRuntime(cleanup, {
		key: "model-cache",
		requiredOwner: "runtime",
		dispose: async () => void closeModelCache(path.join(cwd, "models.db")),
	});
	try {
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: currentSessionManager,
			settings: isolatedNotificationSettings(agentDir),
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			extensionRunner,
		});
		registerNotificationRuntime(cleanup, {
			key: "post-commit-switch",
			shutdown: async () => {
				await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
			},
			dispose: () => session!.dispose(),
		});
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await waitFor(() => fs.existsSync(predecessorEndpoint), 4000, "predecessor endpoint");

		expect(await session.switchSession(targetSessionFile)).toBe(true);
		expect(postCommitObserved).toBe(true);
		await waitFor(() => fs.existsSync(successorEndpoint), 4000, "successor endpoint");
		expect(fs.existsSync(predecessorEndpoint)).toBe(false);
	} finally {
		await cleanupFixtureRoot(cleanup);
		expect(cleanup.entries.get("auth-storage")?.phases.dispose).toBe("verified");
		expect(cleanup.phases.rootAbsent).toBe("verified");
	}
});

test("turn.prompt preflight rejection returns a correlated failure without an accepted lifecycle", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-prompt-preflight-"));
	tempDirs.push(cwd);
	const handlers = new Map<string, Handler>();
	createNotificationsExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async () => {
			throw Object.assign(new Error("submission preflight rejected"), { code: "unavailable" });
		},
	} as never);
	const sessionId = `preflight-${process.pid}-${Date.now()}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Preflight",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointPath), 4000, "preflight endpoint");
	const { url, token } = readEndpoint(endpointPath);
	const frames: Array<Record<string, unknown>> = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", event => frames.push(JSON.parse(String((event as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
	});
	ws.send(
		JSON.stringify({
			type: "control_request",
			id: "preflight-request",
			operation: "turn.prompt",
			input: { text: "will be rejected" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "preflight-request"),
		4000,
		"preflight failure response",
	);
	expect(frames.find(frame => frame.type === "control_response" && frame.id === "preflight-request")).toMatchObject({
		ok: false,
		error: { code: "unavailable", message: "submission preflight rejected" },
	});
	ws.send(JSON.stringify({ type: "event_replay", id: "preflight-events", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "preflight-events"),
		4000,
		"preflight lifecycle replay",
	);
	const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "preflight-events");
	expect((replay?.events as Array<Record<string, unknown>>).some(event => event.kind === "agent_start")).toBe(false);
	expect((replay?.events as Array<Record<string, unknown>>).some(event => event.kind === "agent_end")).toBe(false);
	expect((replay?.events as Array<Record<string, unknown>>).some(event => event.kind === "agent_failed")).toBe(false);
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
});

test("accepted turn.prompt submission failures emit a correlated terminal event", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-prompt-terminal-failure-"));
	tempDirs.push(cwd);
	const handlers = new Map<string, Handler>();
	createNotificationsExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: (_content: unknown, options: { onPreflightAccepted?: () => void } | undefined) => {
			options?.onPreflightAccepted?.();
			return Promise.reject(Object.assign(new Error("submission failed after acceptance"), { code: "unavailable" }));
		},
	} as never);
	const sessionId = `terminal-failure-${process.pid}-${Date.now()}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Terminal failure",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	const endpointPath = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointPath), 4000, "terminal failure endpoint");
	const { url, token } = readEndpoint(endpointPath);
	const frames: Array<Record<string, unknown>> = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", event => frames.push(JSON.parse(String((event as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
	});
	ws.send(
		JSON.stringify({
			type: "control_request",
			id: "terminal-failure-request",
			operation: "turn.prompt",
			input: { text: "will fail after acknowledgement" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_response" && frame.id === "terminal-failure-request"),
		4000,
		"accepted prompt response",
	);
	const response = frames.find(
		frame => frame.type === "control_response" && frame.id === "terminal-failure-request",
	) as { result?: { commandId?: string; turnId?: string } };
	expect(response.result).toMatchObject({ accepted: true });
	ws.send(JSON.stringify({ type: "event_replay", id: "terminal-failure-events", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "terminal-failure-events"),
		4000,
		"terminal failure lifecycle replay",
	);
	const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "terminal-failure-events");
	expect(replay?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "agent_failed",
				payload: expect.objectContaining({
					commandId: response.result?.commandId,
					turnId: response.result?.turnId,
					error: { code: "unavailable", message: "Prompt submission failed." },
				}),
			}),
		]),
	);
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
});

test("session_switch rotates SDK authority while preserving topic identity", async () => {
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

		const notifDir = path.join(cwd, ".gjc", "state", "sdk");
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

		const newEndpoint = path.join(notifDir, `${sid}.json`);
		expect(fs.existsSync(newEndpoint)).toBe(true);
		expect(getTelegramFileSink(sid)).toBeDefined();
		expect(fs.existsSync(originalEndpoint)).toBe(false);
		const newFrames = await connectFrames(newEndpoint);

		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitFor(
			() => newFrames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === sid),
			4000,
			"busy activity for rotated session id",
		);
		expect(frames.some(f => f.type === "activity" && f.sessionId === sid)).toBe(false);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
});

test("session_switch rotates authority without a previous session file", async () => {
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
		await waitFor(() => fs.existsSync(harness.endpoint(harness.sid)), 4000, "rotated endpoint without prior file");
		expect(fs.existsSync(originalEndpoint)).toBe(false);
		const rotatedFrames = await connectFrames(harness.endpoint(harness.sid));

		await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.ctx);
		await waitFor(
			() => rotatedFrames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === harness.sid),
			4000,
			"busy activity for rotated session id",
		);
		expect(frames.some(f => f.type === "activity" && f.sessionId === harness.sid)).toBe(false);
	});
});

test("session_branch rotates endpoint authority", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-branch-");
		await startAndConnect(harness);
		const originalId = harness.sid;
		const originalEndpoint = harness.endpoint(originalId);
		harness.sid = `branch-${originalId}`;

		await harness.handlers.get("session_branch")!(
			{ type: "session_branch", previousSessionFile: harness.previousSessionFile(originalId) },
			harness.ctx,
		);
		await waitFor(() => fs.existsSync(harness.endpoint()), 4000, "branched endpoint");
		expect(fs.existsSync(originalEndpoint)).toBe(false);
	});
});

test("session_branch with the same id does not await optional startup and reconciles after it settles", async () => {
	await withNotifications(async () => {
		const entered = deferred();
		const release = deferred();
		const hostStart = SessionSdkHost.prototype.start;
		let delayed = true;
		const startSpy = vi.spyOn(SessionSdkHost.prototype, "start").mockImplementation(async function (
			this: SessionSdkHost,
		) {
			if (delayed) {
				delayed = false;
				entered.resolve();
				await release.promise;
			}
			return await hostStart.call(this);
		});
		const harness = createHarness("gjc-notif-branch-same-pending-");
		try {
			const startup = harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
			await entered.promise;

			let branchSettled = false;
			const branch = Promise.resolve(
				harness.handlers.get("session_branch")!(
					{ type: "session_branch", previousSessionFile: harness.previousSessionFile(harness.sid) },
					harness.ctx,
				),
			).then(() => {
				branchSettled = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(branchSettled).toBe(true);

			release.resolve();
			await startup;
			await branch;
			expect(fs.existsSync(harness.endpoint())).toBe(true);
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
			expect(fs.existsSync(harness.endpoint())).toBe(false);
		} finally {
			release.resolve();
			startSpy.mockRestore();
		}
	});
});

test("session_branch settles before optional startup, publishes later, and shutdown drains its startup", async () => {
	await withNotifications(async () => {
		const entered = deferred();
		const release = deferred();
		const startupSettled = deferred<{ sessionId: string; status: string }>();
		const hostStart = SessionSdkHost.prototype.start;
		const startSpy = vi.spyOn(SessionSdkHost.prototype, "start").mockImplementation(async function (
			this: SessionSdkHost,
		) {
			entered.resolve();
			await release.promise;
			return await hostStart.call(this);
		});
		const harness = createHarness("gjc-notif-branch-new-pending-", "Original", receipt =>
			startupSettled.resolve(receipt),
		);
		try {
			const previousId = `previous-${harness.sid}`;
			let branchSettled = false;
			const branch = Promise.resolve(
				harness.handlers.get("session_branch")!(
					{ type: "session_branch", previousSessionFile: harness.previousSessionFile(previousId) },
					harness.ctx,
				),
			).then(() => {
				branchSettled = true;
			});
			await entered.promise;
			await Promise.resolve();
			await Promise.resolve();
			expect(branchSettled).toBe(true);
			expect(fs.existsSync(harness.endpoint())).toBe(false);

			release.resolve();
			await branch;
			expect((await startupSettled.promise).status).toBe("started");
			expect(fs.existsSync(harness.endpoint())).toBe(true);
			expect(getTelegramFileSink(harness.sid)).toBeDefined();

			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
			expect(fs.existsSync(harness.endpoint())).toBe(false);
		} finally {
			release.resolve();
			startSpy.mockRestore();
		}
	});
});

test("session_branch cleans up a failed deferred startup", async () => {
	await withNotifications(async () => {
		const entered = deferred();
		const release = deferred();
		const startSpy = vi.spyOn(SessionSdkHost.prototype, "start").mockImplementation(async function (
			this: SessionSdkHost,
		) {
			entered.resolve();
			await release.promise;
			throw new Error("deferred branch startup failed");
		});
		const startupSettled = deferred<{ sessionId: string; status: string }>();
		const harness = createHarness("gjc-notif-branch-failed-pending-", "Original", receipt =>
			startupSettled.resolve(receipt),
		);
		try {
			const branch = harness.handlers.get("session_branch")!(
				{ type: "session_branch", previousSessionFile: harness.previousSessionFile(`previous-${harness.sid}`) },
				harness.ctx,
			);
			await entered.promise;
			await branch;
			expect(getTelegramFileSink(harness.sid)).toBeUndefined();
			release.resolve();
			expect((await startupSettled.promise).status).toBe("failed");
			expect(fs.existsSync(harness.endpoint())).toBe(false);
			await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
			expect(fs.existsSync(harness.endpoint())).toBe(false);
			expect(getTelegramFileSink(harness.sid)).toBeUndefined();
		} finally {
			startSpy.mockRestore();
		}
	});
});

test("session_shutdown fences and drains deferred branch startup", async () => {
	await withNotifications(async () => {
		const entered = deferred();
		const release = deferred();
		const hostStart = SessionSdkHost.prototype.start;
		const startSpy = vi.spyOn(SessionSdkHost.prototype, "start").mockImplementation(async function (
			this: SessionSdkHost,
		) {
			entered.resolve();
			await release.promise;
			return await hostStart.call(this);
		});
		const harness = createHarness("gjc-notif-branch-shutdown-pending-");
		try {
			const branch = harness.handlers.get("session_branch")!(
				{ type: "session_branch", previousSessionFile: harness.previousSessionFile(`previous-${harness.sid}`) },
				harness.ctx,
			);
			await entered.promise;
			await branch;
			let shutdownSettled = false;
			const shutdown = Promise.resolve(
				harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx),
			).then(() => {
				shutdownSettled = true;
			});
			await Promise.resolve();
			expect(shutdownSettled).toBe(false);
			release.resolve();
			await shutdown;
			expect(fs.existsSync(harness.endpoint())).toBe(false);
			expect(getTelegramFileSink(harness.sid)).toBeUndefined();
		} finally {
			release.resolve();
			startSpy.mockRestore();
		}
	});
});

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
});

test("session_switch starts authority when the previous runtime is absent", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-no-runtime-");
		const missingPrevId = `missing-${harness.sid}`;
		const newId = harness.sid;

		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(missingPrevId) },
			harness.ctx,
		);
		await waitFor(() => fs.existsSync(harness.endpoint(newId)), 4000, "new endpoint after absent prior runtime");
	});
});

test("session_switch to unnamed session rotates the endpoint without a title frame", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-unnamed-");
		await startAndConnect(harness);
		const originalId = harness.sid;
		const originalEndpoint = harness.endpoint(originalId);

		harness.sid = `switch-b-${originalId}`;
		harness.name = undefined;
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(originalId) },
			harness.ctx,
		);
		await waitFor(() => fs.existsSync(harness.endpoint(harness.sid)), 4000, "unnamed rotated endpoint");
		expect(fs.existsSync(originalEndpoint)).toBe(false);
		const switchedFrames = await connectFrames(harness.endpoint(harness.sid));
		expect(switchedFrames.some(f => f.type === "identity_header")).toBe(false);

		await harness.handlers.get("agent_end")!({ type: "agent_end" }, harness.ctx);
		await waitFor(
			() => switchedFrames.some(f => f.type === "activity" && f.state === "idle" && f.sessionId === harness.sid),
			4000,
			"idle activity for unnamed rotated session id",
		);
	});
});

test("session_switch can chain A to B to C with one endpoint authority at a time", async () => {
	await withNotifications(async () => {
		const harness = createHarness("gjc-notif-switch-chain-");
		await startAndConnect(harness);
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
		await waitFor(() => fs.existsSync(harness.endpoint(b)), 4000, "session B endpoint");
		expect(fs.existsSync(originalEndpoint)).toBe(false);
		harness.sid = c;
		harness.name = "Session C";
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(b) },
			harness.ctx,
		);
		await waitFor(() => fs.existsSync(harness.endpoint(c)), 4000, "session C endpoint");
		expect(fs.existsSync(harness.endpoint(b))).toBe(false);
		const cFrames = await connectFrames(harness.endpoint(c));

		await harness.handlers.get("agent_start")!({ type: "agent_start" }, harness.ctx);
		await waitFor(
			() => cFrames.some(f => f.type === "activity" && f.state === "busy" && f.sessionId === c),
			4000,
			"busy activity for twice-rotated session id",
		);
	});
});
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
});

test("session_switch keeps notification resources inactive until notify on rebinds them to the new id", async () => {
	const previous = process.env.GJC_NOTIFICATIONS;
	delete process.env.GJC_NOTIFICATIONS;
	try {
		const harness = createHarness("gjc-notif-switch-off-");
		const originalId = harness.sid;
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		await waitFor(
			() => fs.existsSync(harness.endpoint(originalId)),
			4000,
			"SDK endpoint while notifications are off",
		);
		expect(getAskAnswerSource(originalId)).toBeUndefined();
		expect(getTelegramFileSink(originalId)).toBeUndefined();

		const newId = `switch-on-${originalId}`;
		harness.sid = newId;
		await harness.handlers.get("session_switch")!(
			{ type: "session_switch", previousSessionFile: harness.previousSessionFile(originalId) },
			harness.ctx,
		);
		await waitFor(() => fs.existsSync(harness.endpoint(newId)), 4000, "rebound SDK endpoint");
		expect(fs.existsSync(harness.endpoint(originalId))).toBe(false);
		expect(getAskAnswerSource(originalId)).toBeUndefined();
		expect(getTelegramFileSink(originalId)).toBeUndefined();
		expect(getAskAnswerSource(newId)).toBeUndefined();
		expect(getTelegramFileSink(newId)).toBeUndefined();

		process.env.GJC_NOTIFICATIONS = "1";
		await harness.commands
			.get("notify")!
			.handler("on", { ...(harness.ctx as Record<string, unknown>), ui: { notify: () => {} } });
		expect(getAskAnswerSource(originalId)).toBeUndefined();
		expect(getTelegramFileSink(originalId)).toBeUndefined();
		expect(getAskAnswerSource(newId)).toBeDefined();
		expect(getTelegramFileSink(newId)).toBeDefined();
	} finally {
		if (previous === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = previous;
	}
});
