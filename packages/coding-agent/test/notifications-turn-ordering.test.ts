import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/notifications/index";
import { readEndpoint } from "../src/notifications/telegram-reference";

/**
 * Regression for the text-before-ask ordering bug: the assistant text that
 * precedes an ask must reach the remote BEFORE the ask's action_needed (it used
 * to arrive only at turn_end, after the ask resolved), must not be emitted twice
 * once turn_end fires, and must never mirror the user's own prompt back as turn
 * output (message_end fires for user messages too).
 */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000, label = "condition"): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
		await sleep(10);
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Frame = { type: string; text?: string; verbosity?: "lean" | "verbose"; tokenUsage?: string; model?: string };

const tempDirs: string[] = [];
const openSockets: WebSocket[] = [];
afterEach(() => {
	for (const ws of openSockets.splice(0)) ws.close();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Boot the notifications extension against a real NotificationServer + WS client. */
async function setup(): Promise<{
	handlers: Map<string, Handler>;
	ctx: unknown;
	frames: Frame[];
	ws: WebSocket;
	token: string;
	sid: string;
}> {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-order-"));
	tempDirs.push(cwd);
	const sid = `order-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Ordering Test",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		getContextUsage: () => ({ tokens: 12, contextWindow: 100 }),
		getModel: () => ({ id: "test-model" }),
	} as never;

	await handlers.get("session_start")!({ type: "session_start" }, ctx);

	const endpointFile = path.join(cwd, ".gjc", "state", "notifications", `${sid}.json`);
	await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file");
	const { url, token } = readEndpoint(endpointFile);

	const frames: Frame[] = [];
	const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
	openSockets.push(ws);
	ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws error")));
	});
	// Let the server-side connection subscribe before any (unbuffered) broadcast.
	await sleep(250);
	return { handlers, ctx, frames, ws, token, sid };
}

test("assistant text preceding an ask is flushed before the ask and not duplicated at turn_end", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// The assistant message (lead-in text) completes, then the ask tool starts.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Here are your options:" } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "t1", args: {} },
			ctx,
		);

		// The lead-in must be flushed now (before the ask), not at turn_end.
		await waitFor(() => turnStreams().length === 1, 3000, "pre-ask turn_stream");
		expect(turnStreams()[0]!.text).toContain("Here are your options:");

		// turn_end for the same message must NOT duplicate the lead-in.
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Here are your options:" } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(1);

		// A later turn with different text streams once at turn_end.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "All done." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "All done." } },
			ctx,
		);
		await waitFor(() => turnStreams().length === 2, 3000, "second turn_stream");
		expect(turnStreams()[1]!.text).toContain("All done.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a tool-only ask turn does not mirror the preceding user prompt as turn output", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// The user's prompt fires message_end (role user) first.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "please ask me something" } },
			ctx,
		);
		// The assistant turn is tool-only: a message with NO text, just the ask tool_use.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: [{ type: "tool_use", name: "ask" }] } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "t1", args: {} },
			ctx,
		);
		await sleep(250);

		// Nothing should have been streamed: the user's prompt must not be mirrored,
		// and the assistant turn had no text of its own.
		expect(turnStreams().length).toBe(0);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("inbound /verbose and /lean update runtime verbosity and confirmation policy", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const configUpdates = () => frames.filter(f => f.type === "config_update");
		const contextUpdates = () => frames.filter(f => f.type === "context_update");

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(200);
		expect(contextUpdates().length).toBe(0);

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "verbose" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "verbose"), 3000, "verbose config_update");

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(
			() => contextUpdates().some(f => f.tokenUsage === "12/100" && f.model === "test-model"),
			3000,
			"verbose context_update",
		);

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "lean" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "lean"), 3000, "lean config_update");

		const beforeLeanIdle = contextUpdates().length;
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(200);
		expect(contextUpdates().length).toBe(beforeLeanIdle);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("session shutdown emits session_closed before stopping the endpoint", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitFor(() => frames.some(f => f.type === "activity"), 3000, "activity frame");
		frames.length = 0;
		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		await waitFor(() => frames.some(f => f.type === "session_closed"), 3000, "session_closed frame");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);
