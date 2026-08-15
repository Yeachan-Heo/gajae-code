import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { getNotificationConfig } from "../src/sdk/bus/config";
import { createNotificationsExtension, projectToolSummary } from "../src/sdk/bus/index";
import { NotificationSessionController } from "../src/sdk/bus/session-control";
import type { EnsureDaemonResult } from "../src/sdk/bus/telegram-daemon";
import { SessionSdkHost } from "../src/sdk/host";
import { isolatedNotificationSettings } from "./helpers/notification-settings";
import { readTestSdkEndpoint } from "./helpers/sdk-endpoint";
import { withTelegramOrchestrationProvenance } from "./helpers/telegram-topic-test";

const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await sleep(10);
	}
}

type Handler = (event: never, ctx: never) => unknown;
type Frame = Record<string, unknown>;

const tempDirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface SetupResult {
	handlers: Map<string, Handler>;
	ctx: never;
	frames: Frame[];
	ws: WebSocket;
	url: string;
	sessionId: string;
	token: string;
}

interface SetupOptions {
	settingsOverrides?: Record<string, unknown>;
	ensureTelegramDaemon?: (input: { settings: Settings }) => Promise<EnsureDaemonResult>;
}

async function setup(
	tool: { safeSummary?: (kind: "args" | "result", value: unknown) => string } = {},
	options: SetupOptions = {},
): Promise<SetupResult & { settings?: Settings; controller?: NotificationSessionController }> {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-tool-"));
	tempDirs.push(cwd);
	const settings =
		options.settingsOverrides === undefined
			? undefined
			: isolatedNotificationSettings(path.join(cwd, ".gjc", "agent"), options.settingsOverrides);
	const controller =
		settings === undefined
			? undefined
			: new NotificationSessionController({
					eligible: true,
					getConfig: () => getNotificationConfig(settings),
				});
	withTelegramOrchestrationProvenance(() =>
		createNotificationsExtension(api, {
			...(settings ? { settings, controller } : {}),
			...(options.ensureTelegramDaemon ? { ensureTelegramDaemon: options.ensureTelegramDaemon } : {}),
		}),
	);
	const sessionId = `tool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Tool activity test",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		resolveTool: () => tool,
	} as never;
	await handlers.get("session_start")!({ type: "session_start" } as never, ctx);

	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "endpoint file");
	const { url, token } = readTestSdkEndpoint(endpointFile);
	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	sockets.push(ws);
	ws.addEventListener("message", event => frames.push(JSON.parse(String((event as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("websocket error")));
	});
	ws.send(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["tool_activity_v2"] }));
	await sleep(50);
	await sleep(250);
	return { handlers, ctx, frames, ws, url, sessionId, token, settings, controller };
}

async function setConfig(
	setupResult: SetupResult,
	config: { verbosity?: "lean" | "verbose"; redact?: boolean },
): Promise<void> {
	setupResult.ws.send(
		JSON.stringify({ type: "config_command", sessionId: setupResult.sessionId, token: setupResult.token, ...config }),
	);
	await waitFor(
		() =>
			setupResult.frames.some(
				frame =>
					frame.type === "config_update" &&
					(config.verbosity === undefined || frame.verbosity === config.verbosity) &&
					(config.redact === undefined || frame.redact === config.redact),
			),
		"config update",
	);
}

function activityFrames(frames: Frame[]): Frame[] {
	return frames.filter(frame => frame.type === "tool_activity");
}

function reasoningFrames(frames: Frame[]): Frame[] {
	return frames.filter(frame => frame.type === "reasoning_summary");
}

describe("notification tool activity projection", () => {
	test("uses only tool-owned summaries and rejects sensitive or raw values", () => {
		const safe = { safeSummary: (kind: "args" | "result") => `${kind}:${"x".repeat(400)}` };
		expect(projectToolSummary(safe, "args", { intent: "model-only", raw: "never" })).toHaveLength(280);
		expect(
			projectToolSummary({ safeSummaryFields: { args: ["path"] } }, "args", { path: "ok", token: "never" }),
		).toBe('{"path":"ok"}');
		expect(projectToolSummary(undefined, "args", { raw: "never" })).toBeUndefined();
		expect(projectToolSummary({ safeSummary: () => "Bearer secret" }, "result", {})).toBeUndefined();
	});
});

describe("SDK replay capability filter", () => {
	test("filters gated frames without tool_activity_v2 and keeps them with it", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "session",
			stateRoot: "/tmp/session",
			token: "token",
			connectionCapabilities: connectionId =>
				connectionId === "legacy"
					? new Set()
					: connectionId === "capable"
						? new Set(["tool_activity_v2"])
						: undefined,
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
				return "written";
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		host.emitEvent({ kind: "tool_activity", payload: { type: "tool_activity" } });
		host.emitEvent({ kind: "reasoning_summary", payload: { type: "reasoning_summary" } });
		host.emitEvent({ kind: "activity", payload: { type: "activity" } });

		receive("legacy", { type: "event_replay", id: "legacy", sinceSeq: 0, capabilities: [] });
		await wait();
		expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
			"activity",
		]);

		receive("capable", {
			type: "event_replay",
			id: "capable",
			sinceSeq: 0,
			capabilities: [],
		});
		await wait();
		expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
			"tool_activity",
			"reasoning_summary",
			"activity",
		]);
	});
});

test("live positioned tool events use the same negotiated capability gate as replay", async () => {
	await withNotifications(async () => {
		const capable = await setup();
		const legacyFrames: Frame[] = [];
		const legacy = new WebSocket(`${capable.url}/?token=${encodeURIComponent(capable.token)}`);
		sockets.push(legacy);
		legacy.addEventListener("message", event => legacyFrames.push(JSON.parse(String((event as MessageEvent).data))));
		await new Promise<void>((resolve, reject) => {
			legacy.addEventListener("open", () => resolve());
			legacy.addEventListener("error", () => reject(new Error("websocket error")));
		});
		legacy.send(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: [] }));
		await sleep(50);

		capable.ws.send(JSON.stringify({ type: "event_replay", id: "capable-attach", sinceSeq: 0 }));
		legacy.send(JSON.stringify({ type: "event_replay", id: "legacy-attach", sinceSeq: 0 }));
		await waitFor(
			() => capable.frames.some(frame => frame.type === "event_replay_result" && frame.id === "capable-attach"),
			"capable attachment replay",
		);
		await waitFor(
			() => legacyFrames.some(frame => frame.type === "event_replay_result" && frame.id === "legacy-attach"),
			"legacy attachment replay",
		);
		const capableReplay = capable.frames.find(
			frame => frame.type === "event_replay_result" && frame.id === "capable-attach",
		)!;
		const legacyReplay = legacyFrames.find(
			frame => frame.type === "event_replay_result" && frame.id === "legacy-attach",
		)!;

		await capable.handlers.get("turn_start")!({ type: "turn_start" } as never, capable.ctx);
		await capable.handlers.get("tool_execution_start")!(
			{
				type: "tool_execution_start",
				toolCallId: "positioned-call",
				toolName: "apply_patch",
				args: {},
			} as never,
			capable.ctx,
		);
		await capable.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "positioned-call",
				toolName: "apply_patch",
				result: {},
				isError: false,
			} as never,
			capable.ctx,
		);
		await waitFor(
			() =>
				capable.frames.filter(
					frame =>
						frame.type === "event" &&
						frame.kind === "tool_activity" &&
						typeof frame.seq === "number" &&
						frame.seq > Number(capableReplay.lastSeq),
				).length === 2,
			"capability-gated live positioned tool events",
		);
		await sleep(100);

		const capableLive = capable.frames.filter(
			frame =>
				frame.type === "event" &&
				frame.kind === "tool_activity" &&
				typeof frame.seq === "number" &&
				frame.seq > Number(capableReplay.lastSeq),
		);
		expect(capableLive.map(frame => (frame.payload as Record<string, unknown>).phase)).toEqual([
			"started",
			"completed",
		]);
		expect(
			legacyFrames.filter(
				frame =>
					frame.type === "event" &&
					frame.kind === "tool_activity" &&
					typeof frame.seq === "number" &&
					frame.seq > Number(legacyReplay.lastSeq),
			),
		).toHaveLength(0);

		capable.ws.send(
			JSON.stringify({
				type: "event_replay",
				id: "capable-after",
				sinceGeneration: capableReplay.generation,
				sinceSeq: capableReplay.lastSeq,
			}),
		);
		legacy.send(
			JSON.stringify({
				type: "event_replay",
				id: "legacy-after",
				sinceGeneration: legacyReplay.generation,
				sinceSeq: legacyReplay.lastSeq,
			}),
		);
		await waitFor(
			() => capable.frames.some(frame => frame.type === "event_replay_result" && frame.id === "capable-after"),
			"capable parity replay",
		);
		await waitFor(
			() => legacyFrames.some(frame => frame.type === "event_replay_result" && frame.id === "legacy-after"),
			"legacy parity replay",
		);
		const capableAfter = capable.frames.find(
			frame => frame.type === "event_replay_result" && frame.id === "capable-after",
		)!;
		const legacyAfter = legacyFrames.find(
			frame => frame.type === "event_replay_result" && frame.id === "legacy-after",
		)!;
		expect((capableAfter.events as Frame[]).filter(frame => frame.kind === "tool_activity")).toEqual(capableLive);
		expect((legacyAfter.events as Frame[]).filter(frame => frame.kind === "tool_activity")).toHaveLength(0);
	});
}, 30000);

async function withNotifications(run: () => Promise<void>): Promise<void> {
	const previous = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = previous;
	}
}

test("extension handlers emit lean tool activity without summaries or reasoning", async () => {
	await withNotifications(async () => {
		const result = await setup();
		await result.handlers.get("turn_start")!({ type: "turn_start" } as never, result.ctx);
		await result.handlers.get("tool_execution_start")!(
			{
				type: "tool_execution_start",
				toolCallId: "lean-call",
				toolName: "apply_patch",
				args: { command: "secret" },
			} as never,
			result.ctx,
		);
		await result.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "lean-call",
				toolName: "apply_patch",
				result: { output: "secret" },
				isError: false,
			} as never,
			result.ctx,
		);
		await result.handlers.get("reasoning_summary_end")!(
			{
				type: "reasoning_summary_end",
				contentIndex: 0,
				content: "summary",
				message: { content: [{ type: "thinking", provenance: "summary", summaryText: "summary" }] },
			} as never,
			result.ctx,
		);
		await waitFor(() => activityFrames(result.frames).length === 2, "lean tool frames");
		expect(activityFrames(result.frames)).toEqual([
			expect.objectContaining({ toolCallId: "lean-call", toolName: "apply_patch", phase: "started" }),
			expect.objectContaining({ toolCallId: "lean-call", toolName: "apply_patch", phase: "completed" }),
		]);
		for (const frame of activityFrames(result.frames)) {
			expect(frame.argsSummary).toBeUndefined();
			expect(frame.resultSummary).toBeUndefined();
		}
		expect(reasoningFrames(result.frames)).toHaveLength(0);
	});
}, 30000);

test("extension handlers project bounded verbose safe summaries and suppress redacted frames", async () => {
	await withNotifications(async () => {
		const verbose = await setup({ safeSummary: kind => `${kind}:${"x".repeat(400)}` });
		await setConfig(verbose, { verbosity: "verbose" });
		await verbose.handlers.get("tool_execution_start")!(
			{
				type: "tool_execution_start",
				toolCallId: "verbose-call",
				toolName: "apply_patch",
				args: { raw: "never" },
			} as never,
			verbose.ctx,
		);
		await verbose.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "verbose-call",
				toolName: "apply_patch",
				result: { raw: "never" },
				isError: false,
			} as never,
			verbose.ctx,
		);
		await waitFor(() => activityFrames(verbose.frames).length === 2, "verbose tool frames");
		const completed = activityFrames(verbose.frames)[1]!;
		expect(completed.argsSummary).toHaveLength(280);
		expect(completed.resultSummary).toHaveLength(280);

		const redacted = await setup();
		await setConfig(redacted, { verbosity: "verbose", redact: true });
		await redacted.handlers.get("turn_start")!({ type: "turn_start" } as never, redacted.ctx);
		await redacted.handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolCallId: "redacted-call", toolName: "apply_patch", args: {} } as never,
			redacted.ctx,
		);
		await redacted.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "redacted-call",
				toolName: "apply_patch",
				result: {},
				isError: false,
			} as never,
			redacted.ctx,
		);
		await redacted.handlers.get("reasoning_summary_end")!(
			{
				type: "reasoning_summary_end",
				contentIndex: 0,
				content: "summary",
				message: { content: [{ type: "thinking", provenance: "summary", summaryText: "summary" }] },
			} as never,
			redacted.ctx,
		);
		await sleep(100);
		expect(activityFrames(redacted.frames)).toHaveLength(0);
		expect(reasoningFrames(redacted.frames)).toHaveLength(0);
	});
}, 30000);

test("reasoning summary handlers use stable item references and reject raw provenance", async () => {
	await withNotifications(async () => {
		const result = await setup();
		await setConfig(result, { verbosity: "verbose" });
		for (const { content, itemId, provenance } of [
			{ content: "one", itemId: "rs_a", provenance: "summary" },
			{ content: "two", itemId: "rs_b", provenance: "mixed" },
			{ content: "fresh", itemId: undefined, provenance: "summary" },
			{ content: "raw", itemId: "rs_raw", provenance: "raw" },
		] as const) {
			await result.handlers.get("turn_start")!({ type: "turn_start" } as never, result.ctx);
			await result.handlers.get("reasoning_summary_end")!(
				{
					type: "reasoning_summary_end",
					contentIndex: 0,
					content,
					message: { content: [{ type: "thinking", itemId, provenance, summaryText: content }] },
				} as never,
				result.ctx,
			);
		}
		await waitFor(() => reasoningFrames(result.frames).length === 3, "reasoning summary frames");
		const refs = reasoningFrames(result.frames).map(frame => frame.turnRef);
		expect(refs).toEqual(["rs_a", "rs_b", undefined]);
		expect(new Set(refs.filter((ref): ref is string => ref !== undefined)).size).toBe(2);
	});
}, 30000);

test("reasoning summaries require canonical summaryText and never fall back to event content", async () => {
	await withNotifications(async () => {
		const result = await setup();
		await setConfig(result, { verbosity: "verbose" });

		await result.handlers.get("reasoning_summary_end")!(
			{
				type: "reasoning_summary_end",
				contentIndex: 0,
				content: "unsafe event fallback",
				message: { content: [{ type: "thinking", provenance: "mixed" }] },
			} as never,
			result.ctx,
		);
		await sleep(50);
		expect(reasoningFrames(result.frames)).toHaveLength(0);

		await result.handlers.get("reasoning_summary_end")!(
			{
				type: "reasoning_summary_end",
				contentIndex: 0,
				content: "different unsafe event content",
				message: {
					content: [{ type: "thinking", provenance: "summary", summaryText: "canonical safe summary" }],
				},
			} as never,
			result.ctx,
		);
		await waitFor(() => reasoningFrames(result.frames).length === 1, "canonical reasoning summary frame");
		expect(reasoningFrames(result.frames)[0]).toEqual(expect.objectContaining({ text: "canonical safe summary" }));
	});
}, 30000);

test("redact transition cancels visible tools before suppressing later detail", async () => {
	await withNotifications(async () => {
		const result = await setup();
		await result.handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolCallId: "redact-transition", toolName: "shell", args: {} } as never,
			result.ctx,
		);
		await waitFor(() => activityFrames(result.frames).length === 1, "started tool frame");

		await setConfig(result, { redact: true });
		await waitFor(
			() =>
				activityFrames(result.frames).some(
					frame => frame.toolCallId === "redact-transition" && frame.phase === "cancelled",
				),
			"redact transition terminal frame",
		);
		const terminalIndex = result.frames.findIndex(
			frame =>
				frame.type === "tool_activity" && frame.toolCallId === "redact-transition" && frame.phase === "cancelled",
		);
		const configIndex = result.frames.findIndex(frame => frame.type === "config_update" && frame.redact === true);
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(configIndex).toBeGreaterThan(terminalIndex);

		await result.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "redact-transition",
				toolName: "shell",
				result: { hidden: true },
				isError: false,
			} as never,
			result.ctx,
		);
		await sleep(50);
		const frames = activityFrames(result.frames).filter(frame => frame.toolCallId === "redact-transition");
		expect(frames).toEqual([
			expect.objectContaining({ phase: "started" }),
			expect.objectContaining({ phase: "cancelled" }),
		]);
	});
}, 30000);

test("tool ending during Telegram owner preflight is cancelled once when redaction commits", async () => {
	await withNotifications(async () => {
		let deferEnsure = false;
		const ensureEntered = Promise.withResolvers<void>();
		const releaseEnsure = Promise.withResolvers<void>();
		const result = await setup(
			{ safeSummary: () => "sensitive summary" },
			{
				settingsOverrides: {
					"notifications.enabled": true,
					"notifications.redact": false,
					"notifications.verbosity": "verbose",
					"notifications.telegram.botToken": "123456:secret-token",
					"notifications.telegram.chatId": "42",
				},
				ensureTelegramDaemon: async () => {
					if (!deferEnsure) return "attached";
					ensureEntered.resolve();
					await releaseEnsure.promise;
					return "attached";
				},
			},
		);
		if (!result.settings || !result.controller) throw new Error("Expected configured notification runtime.");

		await result.handlers.get("tool_execution_start")!(
			{
				type: "tool_execution_start",
				toolCallId: "preflight-redaction",
				toolName: "shell",
				args: { secret: "sensitive args" },
			} as never,
			result.ctx,
		);
		await waitFor(() => activityFrames(result.frames).length === 1, "started tool frame");

		// Reconciliation must never await daemon ownership. The ownership identity
		// is deliberately UNCHANGED here (only delivery policy changes), so the
		// settled outcome is reused and adapters stay authorized — the contract
		// under test is that the redaction commit still terminalizes the in-flight
		// tool exactly once. Adapter withholding on an ownership-identity change is
		// covered separately in notifications-daemon-isolation.test.ts.
		deferEnsure = true;
		result.settings.set("notifications.redact", true);
		const settled = await Promise.race([
			result.controller.reconcileCurrentSession(result.ctx).then(() => "settled" as const),
			sleep(5000).then(() => "hung" as const),
		]);
		expect(settled).toBe("settled");

		// The redaction commit terminalizes the in-flight tool exactly once; the
		// later end event must not add a second terminal frame.
		await waitFor(
			() =>
				activityFrames(result.frames).some(
					frame => frame.toolCallId === "preflight-redaction" && frame.phase === "cancelled",
				),
			"committed redaction terminal frame",
		);
		await result.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "preflight-redaction",
				toolName: "shell",
				result: { secret: "sensitive result" },
				isError: false,
			} as never,
			result.ctx,
		);
		await sleep(50);
		releaseEnsure.resolve();

		const toolFrames = activityFrames(result.frames).filter(frame => frame.toolCallId === "preflight-redaction");
		expect(toolFrames).toEqual([
			expect.objectContaining({ phase: "started" }),
			expect.objectContaining({ phase: "cancelled" }),
		]);
		for (const frame of toolFrames) {
			expect(frame.argsSummary).toBeUndefined();
			expect(frame.resultSummary).toBeUndefined();
		}
		expect(JSON.stringify(toolFrames)).not.toContain("sensitive");

		deferEnsure = false;
		result.settings.set("notifications.redact", false);
		await result.controller.reconcileCurrentSession(result.ctx);
		await result.handlers.get("agent_end")!({ type: "agent_end" } as never, result.ctx);
		await sleep(50);
		expect(activityFrames(result.frames).filter(frame => frame.toolCallId === "preflight-redaction")).toEqual(
			toolFrames,
		);
	});
}, 30000);

test("a deferred Telegram owner preflight never holds reconciliation or duplicates a tool terminal", async () => {
	await withNotifications(async () => {
		let deferEnsure = false;
		const ensureEntered = Promise.withResolvers<void>();
		const releaseEnsure = Promise.withResolvers<void>();
		const result = await setup(
			{ safeSummary: kind => `owner-preflight-${kind}-summary-sentinel` },
			{
				settingsOverrides: {
					"notifications.enabled": true,
					"notifications.redact": false,
					"notifications.verbosity": "verbose",
					"notifications.telegram.botToken": "123456:secret-token",
					"notifications.telegram.chatId": "42",
				},
				ensureTelegramDaemon: async () => {
					if (!deferEnsure) return "attached";
					ensureEntered.resolve();
					await releaseEnsure.promise;
					return "attached";
				},
			},
		);
		if (!result.controller) throw new Error("Expected configured notification runtime.");

		await result.handlers.get("tool_execution_start")!(
			{
				type: "tool_execution_start",
				toolCallId: "preflight-non-redaction",
				toolName: "shell",
				args: { secret: "owner-preflight-args-sentinel" },
			} as never,
			result.ctx,
		);
		await waitFor(() => activityFrames(result.frames).length === 1, "started tool frame");

		// Reconciliation must never await daemon ownership. Ownership identity is
		// unchanged here, so the settled outcome is reused and adapters stay
		// authorized; the contract under test is that reconciliation settles
		// promptly and the tool terminalizes exactly once.
		deferEnsure = true;
		const settled = await Promise.race([
			result.controller.reconcileCurrentSession(result.ctx).then(() => "settled" as const),
			sleep(5000).then(() => "hung" as const),
		]);
		expect(settled).toBe("settled");

		await result.handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolCallId: "preflight-non-redaction",
				toolName: "shell",
				result: { secret: "owner-preflight-result-sentinel" },
				isError: false,
			} as never,
			result.ctx,
		);
		releaseEnsure.resolve();
		await waitFor(
			() =>
				activityFrames(result.frames).some(
					frame => frame.toolCallId === "preflight-non-redaction" && frame.phase === "completed",
				),
			"committed non-redaction terminal frame",
		);

		const toolFrames = activityFrames(result.frames).filter(frame => frame.toolCallId === "preflight-non-redaction");
		expect(toolFrames).toEqual([
			expect.objectContaining({ phase: "started" }),
			expect.objectContaining({ phase: "completed" }),
		]);
		// Policy is committed and non-redacted by the time the tool ends, so
		// summaries are correctly present; the contract under test is that a
		// deferred daemon ensure neither held reconciliation nor produced a
		// duplicate terminal frame.
		expect(toolFrames.at(-1)?.resultSummary).toContain("sentinel");

		await result.handlers.get("agent_end")!({ type: "agent_end" } as never, result.ctx);
		await result.handlers.get("session_shutdown")!({ type: "session_shutdown" } as never, result.ctx);
		await sleep(50);
		expect(activityFrames(result.frames).filter(frame => frame.toolCallId === "preflight-non-redaction")).toEqual(
			toolFrames,
		);
	});
}, 30000);

test("agent end and session shutdown use explicit synthetic terminal phases", async () => {
	await withNotifications(async () => {
		const result = await setup();
		for (const [toolCallId, stopReason, phase] of [
			["cancelled-call", "cancelled", "cancelled"],
			["failed-call", undefined, "failed"],
		] as const) {
			await result.handlers.get("tool_execution_start")!(
				{ type: "tool_execution_start", toolCallId, toolName: "shell", args: {} } as never,
				result.ctx,
			);
			await result.handlers.get("agent_end")!({ type: "agent_end", stopReason } as never, result.ctx);
			await waitFor(
				() => activityFrames(result.frames).some(frame => frame.toolCallId === toolCallId && frame.phase === phase),
				`${phase} terminal frame`,
			);
		}

		await result.handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolCallId: "shutdown-call", toolName: "shell", args: {} } as never,
			result.ctx,
		);
		await result.handlers.get("session_shutdown")!({ type: "session_shutdown" } as never, result.ctx);
		await waitFor(
			() =>
				activityFrames(result.frames).some(
					frame => frame.toolCallId === "shutdown-call" && frame.phase === "cancelled",
				),
			"shutdown terminal frame",
		);
		const shutdownTerminals = activityFrames(result.frames).filter(
			frame => frame.toolCallId === "shutdown-call" && frame.phase === "cancelled",
		);
		expect(shutdownTerminals).toHaveLength(1);
	});
}, 30000);
