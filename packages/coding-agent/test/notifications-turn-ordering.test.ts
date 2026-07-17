import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
type Frame = {
	type: string;
	text?: string;
	verbosity?: "quiet" | "lean" | "verbose";
	tokenUsage?: string;
	model?: string;
	cwd?: string;
	kind?: string;
	id?: string;
};

type TestContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	source: "provider_anchor" | "heuristic" | "unknown";
};
type TestModel = { id?: string };

const cleanupRoots: FixtureRootCleanup[] = [];
const openSockets: WebSocket[] = [];
afterEach(async () => {
	for (const ws of openSockets.splice(0)) ws.close();
	await cleanupFixtureRoots(cleanupRoots);
});

/** Boot the notifications extension against a real NotificationServer + WS client. */
async function setup(
	options: { contextUsage?: TestContextUsage | false; model?: TestModel | false; startVerbosity?: "quiet" | "lean" | "verbose" } = {},
): Promise<{
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

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-order-"));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanupRoots.push(cleanup);
	createNotificationsExtension(api, {
		settings: isolatedNotificationSettings(
			agentDir,
			options.startVerbosity ? { "notifications.verbosity": options.startVerbosity } : {},
		),
	});
	const sid = `order-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Ordering Test",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		getContextUsage: () =>
			options.contextUsage === false
				? undefined
				: (options.contextUsage ?? { tokens: 12, contextWindow: 100, percent: 12, source: "provider_anchor" }),
		getModel: () => (options.model === false ? undefined : (options.model ?? { id: "test-model" })),
	} as never;
	registerNotificationRuntime(cleanup, {
		key: `notification-session:${sid}`,
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		},
	});

	await handlers.get("session_start")!({ type: "session_start" }, ctx);

	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sid}.json`);
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
			() =>
				contextUpdates().some(
					f =>
						f.tokenUsage === "12/100" &&
						f.model === "test-model" &&
						f.cwd === path.basename((ctx as { cwd: string }).cwd),
				),
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

test("verbose idle context includes compact cwd without usage metadata", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup({ contextUsage: false, model: false });
		const configUpdates = () => frames.filter(f => f.type === "config_update");
		const contextUpdates = () => frames.filter(f => f.type === "context_update");

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "verbose" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "verbose"), 3000, "verbose config_update");

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(
			() =>
				contextUpdates().some(
					f =>
						f.cwd === path.basename((ctx as { cwd: string }).cwd) &&
						f.tokenUsage === undefined &&
						f.model === undefined,
				),
			3000,
			"cwd-only verbose context_update",
		);
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

// --- Turn-output streaming: observable ordering & dedup ---------------------
// These assert the WS-observable turn_stream contract: the pre-ask lead-in is
// flushed BEFORE the ask (not held until turn_end), identical text is deduped
// within a turn, distinct text streams again, and an ask-free turn streams
// exactly once. All turn output arrives as a `finalized`-phase frame.
//
// The emit site tags each turn_stream with a `finalAnswer` bit (false for the
// pre-ask lead-in, true at turn_end). The Rust wire struct `TurnStream`
// (crates/gjc-sdk/src/protocol.rs) carries it as an optional
// `final_answer` (serialized `finalAnswer`), so the bit is asserted here at the
// WS-observable level; the `finalAnswer` -> `richMarkdown` mapping itself is
// verified at the pure-renderer level in notifications-threaded-render.test.ts.

/** Read the `phase` discriminator off a captured turn_stream frame (survives the wire). */
const phaseOf = (f: Frame): string | undefined => (f as { phase?: string }).phase;
/** Read the `finalAnswer` bit off a captured turn_stream frame (survives the wire). */
const finalAnswerOf = (f: Frame): boolean | undefined => (f as { finalAnswer?: boolean }).finalAnswer;

test("a pre-ask lead-in is flushed as a finalized turn_stream before the ask, and an identical turn_end is deduped", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// Assistant lead-in completes, then the ask tool starts.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Pick a branch to merge:" } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "t1", args: {} },
			ctx,
		);

		// The pre-ask lead-in is flushed now (before any turn_end), as a finalized frame.
		await waitFor(() => turnStreams().length === 1, 3000, "pre-ask turn_stream");
		expect(turnStreams()[0]!.text).toContain("Pick a branch to merge:");
		expect(phaseOf(turnStreams()[0]!)).toBe("finalized");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(false);

		// turn_end with identical text is deduped: no second frame appears.
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Pick a branch to merge:" } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a distinct turn_end after a pre-ask lead-in streams a second finalized turn_stream", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Looking into it now." } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "t1", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "pre-ask turn_stream");
		expect(phaseOf(turnStreams()[0]!)).toBe("finalized");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(false);

		// A later turn resolves with DIFFERENT text: it streams once more, finalized.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Done, merged the feature branch." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: "Done, merged the feature branch." },
			},
			ctx,
		);
		await waitFor(() => turnStreams().length === 2, 3000, "final turn_stream");
		expect(turnStreams()[1]!.text).toContain("Done, merged the feature branch.");
		expect(phaseOf(turnStreams()[1]!)).toBe("finalized");
		expect(finalAnswerOf(turnStreams()[1]!)).toBe(true);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a turn_end with no preceding ask streams a single finalized turn_stream", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "All finished." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "All finished." } },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "final turn_stream");
		expect(turnStreams()[0]!.text).toContain("All finished.");
		expect(phaseOf(turnStreams()[0]!)).toBe("finalized");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(true);

		// No second frame for a single ask-free turn.
		await sleep(150);
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

const messageRefOf = (f: Frame): string | undefined => (f as { messageRef?: string }).messageRef;

// Decision A / Pro round-5 regression: a stream-enabled turn must finalize as an
// editable (messageRef-bearing) frame even when live frames were async and none
// landed before turn_end — so the daemon keeps it on the HTML edit path and never
// rich-promotes a streamed final — and a late message_update after turn_end must
// be dropped so no stale live edit follows the final.
test("stream-enabled final always carries a messageRef and a late message_update is dropped", async () => {
	const prevN = process.env.GJC_NOTIFICATIONS;
	const prevS = process.env.GJC_NOTIFICATIONS_STREAM;
	process.env.GJC_NOTIFICATIONS = "1";
	process.env.GJC_NOTIFICATIONS_STREAM = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		// turn_end with NO preceding message_update (live frames were async / none landed).
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Streamed final." } },
			ctx,
		);
		await waitFor(() => turnStreams().some(f => phaseOf(f) === "finalized"), 3000, "finalized frame");
		const finalFrame = turnStreams().find(f => phaseOf(f) === "finalized")!;
		expect(finalAnswerOf(finalFrame)).toBe(true);
		// A stream-enabled final MUST be editable (carry a messageRef) so the daemon
		// keeps it on the HTML edit path (shouldPromoteRich rejects editable frames).
		expect(typeof messageRefOf(finalFrame)).toBe("string");

		// A late async message_update after turn_end is dropped: no stale live frame.
		const before = turnStreams().length;
		await handlers.get("message_update")!(
			{ type: "message_update", message: { role: "assistant", content: "late partial after turn_end" } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(before);
		expect(turnStreams().some(f => phaseOf(f) === "live")).toBe(false);
	} finally {
		if (prevN === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevN;
		if (prevS === undefined) delete process.env.GJC_NOTIFICATIONS_STREAM;
		else process.env.GJC_NOTIFICATIONS_STREAM = prevS;
	}
}, 30000);

// --- Quiet emit-side suppression -------------------------------------------
// Quiet is a global action-only allowlist on the emit side: under quiet the SDK
// must NOT emit automatic content mirrors (turn_stream live + finalized + pre-ask
// flush, auto image_attachment, context_update, tool_activity, reasoning_summary).
// Only action-needed / control / explicit-attachment content is mirrored. The
// daemon-side allowlist is unit-tested in notification-verbosity; these tests
// assert the SDK emit boundary suppresses automatic frames while retaining
// lifecycle/identity/config frames and re-enables on quiet -> lean/verbose.

test("quiet suppresses finalized turn_stream (turn_end) and live turn_stream previews", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	const prevStream = process.env.GJC_NOTIFICATIONS_STREAM;
	process.env.GJC_NOTIFICATIONS = "1";
	process.env.GJC_NOTIFICATIONS_STREAM = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// Switch the session to quiet via the inbound config_command seam.
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "quiet" }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.verbosity === "quiet"), 3000, "quiet config_update");

		// A live preview and a finalized turn under quiet must NOT emit any turn_stream.
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_update")!(
			{ type: "message_update", message: { role: "assistant", content: "streaming under quiet" } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "final under quiet" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "final under quiet" } },
			ctx,
		);
		await sleep(250);
		expect(turnStreams().length).toBe(0);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
		if (prevStream === undefined) delete process.env.GJC_NOTIFICATIONS_STREAM;
		else process.env.GJC_NOTIFICATIONS_STREAM = prevStream;
	}
}, 30000);

test("quiet suppresses tool_activity (start + end) and context_update, but keeps activity + identity_header", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const toolActivity = () => frames.filter(f => f.type === "tool_activity");
		const contextUpdates = () => frames.filter(f => f.type === "context_update");
		const activity = () => frames.filter(f => f.type === "activity");
		const identityHeaders = () => frames.filter(f => f.type === "identity_header");

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "quiet" }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.verbosity === "quiet"), 3000, "quiet config_update");

		// A tool run under quiet emits no tool_activity.
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: {} },
			ctx,
		);
		await handlers.get("tool_execution_end")!(
			{ type: "tool_execution_end", toolName: "bash", toolCallId: "tc1", isError: false, result: {} },
			ctx,
		);
		await sleep(150);
		expect(toolActivity().length).toBe(0);

		// agent_end under quiet: no context_update (even though verbose-only), but
		// the lifecycle activity (idle) and identity_header frames are retained.
		const beforeIdle = activity().length;
		const beforeIdentity = identityHeaders().length;
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(() => activity().length > beforeIdle, 3000, "activity (idle) under quiet");
		await waitFor(() => identityHeaders().length > beforeIdentity, 3000, "identity_header under quiet");
		await sleep(200);
		expect(contextUpdates().length).toBe(0);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("quiet suppresses the pre-ask lead-in flush (no turn_stream before an ask)", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "quiet" }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.verbosity === "quiet"), 3000, "quiet config_update");

		// Assistant lead-in completes, then the ask tool starts. Under lean this
		// flushes the lead-in as a finalized turn_stream before the ask; under quiet
		// the flush is suppressed.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Pick a branch:" } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "t1", args: {} },
			ctx,
		);
		await sleep(250);
		expect(turnStreams().length).toBe(0);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("quiet -> lean switch re-enables turn_stream emission", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const configUpdates = () => frames.filter(f => f.type === "config_update");

		// Enter quiet, confirm suppression.
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "quiet" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "quiet"), 3000, "quiet config_update");
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "silenced under quiet" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "silenced under quiet" } },
			ctx,
		);
		await sleep(200);
		expect(turnStreams().length).toBe(0);

		// Switch back to lean: the next turn streams again.
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "lean" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "lean"), 3000, "lean config_update");
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "visible under lean" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "visible under lean" } },
			ctx,
		);
		await waitFor(() => turnStreams().some(f => f.text === "visible under lean"), 3000, "lean turn_stream");
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("quiet -> verbose switch re-enables context_update on idle", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const contextUpdates = () => frames.filter(f => f.type === "context_update");
		const configUpdates = () => frames.filter(f => f.type === "config_update");

		// Start quiet, confirm no context_update on idle.
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "quiet" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "quiet"), 3000, "quiet config_update");
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(250);
		expect(contextUpdates().length).toBe(0);

		// Switch to verbose: the next idle emits a context_update.
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "verbose" }));
		await waitFor(() => configUpdates().some(f => f.verbosity === "verbose"), 3000, "verbose config_update");
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(
			() => contextUpdates().some(f => f.tokenUsage === "12/100" && f.model === "test-model"),
			3000,
			"verbose context_update after quiet",
		);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("startup quiet (seed verbosity from settings) suppresses the first turn_stream", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup({ startVerbosity: "quiet" });
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// Booted directly into quiet: the very first turn emits no turn_stream.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "first turn under startup quiet" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "first turn under startup quiet" } },
			ctx,
		);
		await sleep(250);
		expect(turnStreams().length).toBe(0);

		// Sanity: the session still emits lifecycle activity (not suppressed).
		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitFor(() => frames.some(f => f.type === "activity"), 3000, "activity under startup quiet");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("an invalid verbosity value is ignored (no config_update, runtime unchanged)", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const configUpdates = () => frames.filter(f => f.type === "config_update");
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// Send a bogus verbosity: it must be ignored (strict parse), so no
		// config_update is emitted and the runtime stays at the lean default.
		const before = configUpdates().length;
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "loud" }));
		await sleep(250);
		expect(configUpdates().length).toBe(before);

		// The runtime is still lean: a turn streams normally.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "still lean" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "still lean" } },
			ctx,
		);
		await waitFor(() => turnStreams().some(f => f.text === "still lean"), 3000, "lean turn_stream after invalid");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);
