import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension, projectToolSummary } from "../src/sdk/bus/index";
import { readEndpoint } from "../src/sdk/bus/telegram-reference";
import { SessionSdkHost } from "../src/sdk/host";

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
	sessionId: string;
	token: string;
}

async function setup(
	tool: { safeSummary?: (kind: "args" | "result", value: unknown) => string } = {},
): Promise<SetupResult> {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-tool-"));
	tempDirs.push(cwd);
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
	const { url, token } = readEndpoint(endpointFile);
	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	sockets.push(ws);
	ws.addEventListener("message", event => frames.push(JSON.parse(String((event as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("websocket error")));
	});
	ws.send(JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["tool_activity_v1"] }));
	await sleep(50);
	await sleep(250);
	return { handlers, ctx, frames, ws, sessionId, token };
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
	test("filters gated frames without tool_activity_v1 and keeps them with it", async () => {
		let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const host = new SessionSdkHost({
			sessionId: "session",
			stateRoot: "/tmp/session",
			token: "token",
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
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
			capabilities: ["tool_activity_v1"],
		});
		await wait();
		expect((sent.at(-1)!.frame.events as Array<{ kind: string }>).slice(1).map(event => event.kind)).toEqual([
			"tool_activity",
			"reasoning_summary",
			"activity",
		]);
	});
});

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

test("redact transition terminalizes visible tools before suppressing later detail", async () => {
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
					frame => frame.toolCallId === "redact-transition" && frame.phase === "unknown",
				),
			"redact transition terminal frame",
		);
		const terminalIndex = result.frames.findIndex(
			frame =>
				frame.type === "tool_activity" && frame.toolCallId === "redact-transition" && frame.phase === "unknown",
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
			expect.objectContaining({ phase: "unknown" }),
		]);
	});
}, 30000);

test("agent end and session shutdown terminalize open tool activity", async () => {
	await withNotifications(async () => {
		const result = await setup();
		for (const [toolCallId, stopReason, phase] of [
			["cancelled-call", "cancelled", "cancelled"],
			["unknown-call", undefined, "unknown"],
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
					frame => frame.toolCallId === "shutdown-call" && frame.phase === "unknown",
				),
			"shutdown terminal frame",
		);
		const shutdownTerminals = activityFrames(result.frames).filter(
			frame => frame.toolCallId === "shutdown-call" && frame.phase === "unknown",
		);
		expect(shutdownTerminals).toHaveLength(1);
	});
}, 30000);
