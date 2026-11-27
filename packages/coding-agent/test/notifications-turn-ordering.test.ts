import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { kProviderResolvedToolCall } from "@gajae-code/ai/utils/block-symbols";
import { createNotificationsExtension } from "../src/sdk/bus/index";
import { TOOL_ACTIVITY_CAPABILITY } from "../src/sdk/bus/telegram-daemon";
import { POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY } from "../src/sdk/host/host";
import {
	cleanupFixtureRoots,
	createNotificationFixtureRoot,
	type FixtureRootCleanup,
	isolatedNotificationSettings,
	registerNotificationRuntime,
} from "./helpers/notification-settings";
import { readTestSdkEndpoint } from "./helpers/sdk-endpoint";

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
	id?: string;
	kind?: string;
	payload?: Frame;
	seq?: number;
	generation?: number;
	text?: string;
	verbosity?: "lean" | "verbose";
	redact?: boolean;
	tokenUsage?: string;
	model?: string;
	cwd?: string;
	state?: string;
	updateId?: number;
	reason?: string;
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
	options: {
		contextUsage?: TestContextUsage | false;
		model?: TestModel | false;
		readNotificationDiffStat?: (cwd: string) => Promise<string | undefined>;
		sendUserMessageOverride?: (content: unknown, options: unknown) => Promise<void> | void;
	} = {},
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
		sendUserMessage: options?.sendUserMessageOverride ?? (() => {}),
	} as never;

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notif-order-"));
	const agentDir = path.join(cwd, ".gjc", "agent");
	const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
	cleanupRoots.push(cleanup);
	createNotificationsExtension(api, {
		settings: isolatedNotificationSettings(agentDir),
		readNotificationDiffStat: options.readNotificationDiffStat,
	});
	const sid = `order-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		getActivePromptHandle: () => undefined,
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
	const { url, token } = readTestSdkEndpoint(endpointFile);

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

		// A later turn with different text is held under lean until agent_end.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "All done." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "All done." } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(1);

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(() => turnStreams().length === 2, 3000, "settled turn_stream at idle");
		expect(turnStreams()[1]!.text).toContain("All done.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a replay-attached subscriber receives one live representation of a turn frame", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws } = await setup();
		const legacyFrames: Frame[] = [];
		const legacy = new WebSocket(ws.url);
		openSockets.push(legacy);
		legacy.addEventListener("message", event => legacyFrames.push(JSON.parse(String((event as MessageEvent).data))));
		const opened = Promise.withResolvers<void>();
		legacy.addEventListener("open", () => opened.resolve(), { once: true });
		legacy.addEventListener("error", () => opened.reject(new Error("legacy ws error")), { once: true });
		await opened.promise;
		ws.send(
			JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				capabilities: [POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY],
			}),
		);
		ws.send(
			JSON.stringify({
				type: "event_replay",
				id: "positioned-live-regression",
				sinceGeneration: 0,
				sinceSeq: 0,
				capabilities: [],
			}),
		);
		await waitFor(() => frames.some(frame => frame.type === "event_replay_result"), 3000, "event replay result");
		frames.splice(0);

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "One visible result." } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "one-copy", args: {} },
			ctx,
		);

		const turnRepresentations = () =>
			frames.filter(
				frame => frame.type === "turn_stream" || (frame.type === "event" && frame.kind === "turn_stream"),
			);
		await waitFor(() => turnRepresentations().length >= 1, 3000, "live turn representation");
		await waitFor(
			() => legacyFrames.filter(frame => frame.type === "turn_stream").length >= 1,
			3000,
			"legacy raw turn representation",
		);
		await sleep(150);
		expect(turnRepresentations()).toEqual([
			expect.objectContaining({
				type: "event",
				kind: "turn_stream",
				seq: expect.any(Number),
				payload: expect.objectContaining({ type: "turn_stream", text: "One visible result." }),
			}),
		]);
		expect(legacyFrames.filter(frame => frame.type === "turn_stream")).toEqual([
			expect.objectContaining({ type: "turn_stream", text: "One visible result." }),
		]);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("recipient-bound idle follows positioned activity and identity delivery", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws } = await setup();
		ws.send(
			JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				capabilities: [POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY, TOOL_ACTIVITY_CAPABILITY],
			}),
		);
		ws.send(
			JSON.stringify({
				type: "event_replay",
				id: "idle-ordering-regression",
				sinceGeneration: 0,
				sinceSeq: 0,
				capabilities: [POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY, TOOL_ACTIVITY_CAPABILITY],
			}),
		);
		await waitFor(() => frames.some(frame => frame.type === "event_replay_result"), 3000, "event replay result");
		frames.splice(0);

		// Keep enough directed work ahead of the terminal identity to exercise the
		// independent directed/broadcast queues instead of relying on an idle socket.
		for (let index = 0; index < 32; index++) {
			await handlers.get("tool_execution_start")!(
				{
					type: "tool_execution_start",
					toolName: "read",
					toolCallId: `ordering-${index}`,
					args: {},
				},
				ctx,
			);
		}
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		const identityIndex = () => frames.findIndex(frame => frame.type === "event" && frame.kind === "identity_header");
		const idleIndex = () => frames.findIndex(frame => frame.type === "action_needed" && frame.kind === "idle");
		await waitFor(() => identityIndex() >= 0 && idleIndex() >= 0, 3000, "ordered identity and idle frames");
		expect(identityIndex()).toBeLessThan(idleIndex());
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

test("drops an asynchronous context update completed after redaction changes", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const diffEntered = Promise.withResolvers<void>();
		const releaseDiff = Promise.withResolvers<string | undefined>();
		const { handlers, ctx, frames, ws, token, sid } = await setup({
			readNotificationDiffStat: async () => {
				diffEntered.resolve();
				return await releaseDiff.promise;
			},
		});
		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "verbose" }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.verbosity === "verbose"));
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await diffEntered.promise;

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, redact: true }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.redact === true));
		releaseDiff.resolve("1 file changed");
		await sleep(100);

		expect(frames.some(f => f.type === "context_update")).toBe(false);
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
// within a turn, lean defers the settled answer until agent_end, and verbose
// still streams per turn_end. All turn output arrives as a `finalized`-phase frame.
//
// The emit site tags each turn_stream with a `finalAnswer` bit (false for the
// pre-ask lead-in, true at settled final). The Rust wire struct `TurnStream`
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

test("a distinct lean answer after a pre-ask lead-in streams only at agent_end", async () => {
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

		// Intermediate tool-turn narration must not flood under lean.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Checking the merge base." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: "Checking the merge base." },
			},
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(1);

		// Latest settled answer overwrites the deferred text and flushes at idle.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Done, merged the feature branch." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{
				type: "turn_end",
				turnIndex: 2,
				message: { role: "assistant", content: "Done, merged the feature branch." },
			},
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(1);

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(() => turnStreams().length === 2, 3000, "settled turn_stream");
		expect(turnStreams()[1]!.text).toContain("Done, merged the feature branch.");
		expect(phaseOf(turnStreams()[1]!)).toBe("finalized");
		expect(finalAnswerOf(turnStreams()[1]!)).toBe(true);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean does not re-emit intermediate narration after a later ask lead-in at idle", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		// Intermediate tool-turn narration is deferred under lean.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Intermediate narration" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Intermediate narration" } },
			ctx,
		);
		await sleep(100);
		expect(turnStreams().length).toBe(0);

		// Later ask lead-in flushes immediately and must supersede the deferred text.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Choose one:" } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-1", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "ask lead-in");
		expect(turnStreams()[0]!.text).toContain("Choose one:");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(false);

		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "Choose one:" } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(200);

		// Idle must not re-emit "Intermediate narration" as finalAnswer after the ask lead-in.
		const finals = turnStreams().filter(f => finalAnswerOf(f) === true);
		expect(finals.length).toBe(0);
		expect(turnStreams().some(f => f.text?.includes("Intermediate narration"))).toBe(false);
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean ask-free turns emit a single settled turn_stream only at agent_end", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Working on it…" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Working on it…" } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(0);

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "All finished." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "All finished." } },
			ctx,
		);
		await sleep(150);
		expect(turnStreams().length).toBe(0);

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(() => turnStreams().length === 1, 3000, "settled turn_stream");
		expect(turnStreams()[0]!.text).toContain("All finished.");
		expect(phaseOf(turnStreams()[0]!)).toBe("finalized");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(true);

		// No second frame for a single agent settle.
		await sleep(150);
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean preserves a user-request receipt when an autonomous continuation acknowledges a background notice", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: { role: "assistant", content: "Completed: migrated all records and verified the result." },
			},
			ctx,
		);
		await handlers.get("turn_end")!(
			{
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", content: "Completed: migrated all records and verified the result." },
			},
			ctx,
		);

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		// A background/subagent completion arrives after turn_start and is autonomous.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Acknowledged background completion." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: "Acknowledged background completion." },
			},
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "composed settled receipt");
		expect(turnStreams()[0]!.text).toContain("Completed: migrated all records and verified the result.");
		expect(turnStreams()[0]!.text).toContain("Acknowledged background completion.");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(true);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("normal agent-start turn-start user-message order retains the first lean receipt", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Completion receipt." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "first user receipt");
		expect(turnStreams()[0]!.text).toContain("Completion receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a direct user prompt remains user-attributed after framework context in the same turn", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "custom",
					customType: "volatile-project-context",
					attribution: "agent",
					content: "context",
				},
			},
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Completion receipt." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "user-attributed receipt");
		expect(turnStreams()[0]!.text).toContain("Completion receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("agent-attributed user-role notifications do not supersede a pending settlement", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "First request." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "First receipt." } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", attribution: "agent", content: "Internal resource notice." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "retained user receipt");
		expect(turnStreams()[0]!.text).toContain("First receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("an autonomous ask lead-in does not erase the prior user-request receipt", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Completion receipt." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Choose a follow-up action." } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-1", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "autonomous ask lead-in");
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "Choose a follow-up action." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 2, 3000, "retained receipt after ask");
		expect(turnStreams()[1]!.text).toContain("Completion receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean does not replay a retained receipt when the same text is published as an autonomous ask lead-in", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const receipt = "Completed the work. Choose the next action.";

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: receipt } },
			ctx,
		);

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: receipt } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-duplicate", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "autonomous ask lead-in");
		expect(turnStreams()[0]!.text).toContain(receipt);
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(false);

		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: receipt } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(250);

		expect(turnStreams()).toHaveLength(1);
		expect(turnStreams().some(frame => finalAnswerOf(frame) === true)).toBe(false);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean retains an ask lead-in receipt when no subscriber accepts the publication", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, ws } = await setup();
		const url = ws.url;
		const receipt = "Completed the work while the remote was disconnected.";

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the disconnected task." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: receipt } },
			ctx,
		);

		const closed = Promise.withResolvers<void>();
		ws.addEventListener("close", () => closed.resolve(), { once: true });
		ws.close();
		await closed.promise;
		// Let the server retire the authenticated connection and its broadcast
		// receiver before the autonomous lead-in attempts publication.
		await sleep(250);

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: receipt } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-disconnected", args: {} },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: receipt } },
			ctx,
		);

		const replacementFrames: Frame[] = [];
		const replacement = new WebSocket(url);
		openSockets.push(replacement);
		replacement.addEventListener("message", event =>
			replacementFrames.push(JSON.parse(String((event as MessageEvent).data))),
		);
		const opened = Promise.withResolvers<void>();
		replacement.addEventListener("open", () => opened.resolve(), { once: true });
		replacement.addEventListener("error", () => opened.reject(new Error("replacement ws error")), { once: true });
		await opened.promise;
		await sleep(250);

		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		const turnStreams = () => replacementFrames.filter(frame => frame.type === "turn_stream");
		await waitFor(() => turnStreams().length === 1, 3000, "retained receipt after reconnect");
		expect(turnStreams()[0]!.text).toContain(receipt);
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(true);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("an autonomous ask consumes only its matching receipt from a composed lean settlement", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const userReceipt = "Completed the requested migration.";
		const autonomousReceipt = "Background verification finished.";

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Migrate the records." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: userReceipt } },
			ctx,
		);

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: autonomousReceipt } },
			ctx,
		);

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 2 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "follow-up ready" } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: autonomousReceipt } },
			ctx,
		);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-composed", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "composed settlement ask lead-in");
		expect(turnStreams()[0]!.text).toContain(autonomousReceipt);
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(false);

		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 2, message: { role: "assistant", content: autonomousReceipt } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await waitFor(() => turnStreams().length === 2, 3000, "retained distinct user receipt");

		expect(turnStreams()[1]!.text).toContain(userReceipt);
		expect(turnStreams()[1]!.text).not.toContain(autonomousReceipt);
		expect(finalAnswerOf(turnStreams()[1]!)).toBe(true);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("an autonomous tool continuation retains its provenance through a message-less turn", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Completion receipt." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "Autonomous update." } },
			ctx,
		);
		// Tool-loop continuation has no new prompt message, so it must retain its autonomous provenance.
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 2 }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 2, message: { role: "assistant", content: "Final autonomous outcome." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "composed autonomous outcome");
		expect(turnStreams()[0]!.text).toContain("Completion receipt.");
		expect(turnStreams()[0]!.text).toContain("Final autonomous outcome.");
		expect(turnStreams()[0]!.text).not.toContain("Autonomous update.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a user-attributed custom message starts a new settlement window", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "First request." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "First receipt." } },
			ctx,
		);

		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: { role: "custom", customType: "skill-prompt", attribution: "user", content: "Second request." },
			},
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "Second receipt." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "user-attributed custom receipt");
		expect(turnStreams()[0]!.text).toContain("Second receipt.");
		expect(turnStreams()[0]!.text).not.toContain("First receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a batched user prompt shares one settlement window", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		for (const content of ["First batched input.", "Second batched input."])
			await handlers.get("message_end")!({ type: "message_end", message: { role: "user", content } }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Batched receipt." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "batched receipt");
		expect(turnStreams()[0]!.text).toContain("Batched receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a new user request supersedes the preceding lean settlement window", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "First request." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "First receipt." } },
			ctx,
		);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Second request." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "Second receipt." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "superseding receipt");
		expect(turnStreams()[0]!.text).toContain("Second receipt.");
		expect(turnStreams()[0]!.text).not.toContain("First receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a user boundary suppresses a turn that started in the preceding settlement window", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "First request." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		// A newly submitted user request opens a new window before the prior turn closes.
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Second request." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Stale first receipt." } },
			ctx,
		);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "Second receipt." } },
			ctx,
		);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "current-window receipt");
		expect(turnStreams()[0]!.text).toContain("Second receipt.");
		expect(turnStreams()[0]!.text).not.toContain("Stale first receipt.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean bounds autonomous settlement composition to the receipt and latest material update", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const turn = async (turnIndex: number, text: string, autonomous = false): Promise<void> => {
			await handlers.get("turn_start")!({ type: "turn_start", turnIndex }, ctx);
			if (autonomous)
				await handlers.get("message_end")!(
					{ type: "message_end", message: { role: "custom", customType: "subagent", content: "worker complete" } },
					ctx,
				);
			await handlers.get("turn_end")!(
				{ type: "turn_end", turnIndex, message: { role: "assistant", content: text } },
				ctx,
			);
		};

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Complete the request." } },
			ctx,
		);
		await turn(0, "Completion receipt.");
		await turn(1, "Material update one.", true);
		await turn(2, "Material update two.", true);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "bounded composed receipt");
		expect(turnStreams()[0]!.text).toContain("Completion receipt.");
		expect(turnStreams()[0]!.text).toContain("Material update two.");
		expect(turnStreams()[0]!.text).not.toContain("Material update one.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

/**
 * Drives one real-shaped agent-loop turn: assistant text plus tool calls is
 * followed by the tool results the loop emits as `message_end` before the next
 * turn starts; a turn without tool calls settles.
 */
async function toolLoopTurn(
	handlers: Map<string, Handler>,
	ctx: unknown,
	turnIndex: number,
	text: string,
	options: { toolCall?: string; steering?: string } = {},
): Promise<void> {
	await handlers.get("turn_start")!({ type: "turn_start", turnIndex }, ctx);
	if (options.steering)
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: { role: "custom", customType: "async-result", attribution: "agent", content: options.steering },
			},
			ctx,
		);
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	if (options.toolCall)
		content.push({ type: "toolCall", id: options.toolCall, name: "bash", arguments: { command: "true" } });
	const message = { role: "assistant", content, stopReason: options.toolCall ? "toolUse" : "stop" };
	await handlers.get("message_end")!({ type: "message_end", message }, ctx);
	if (options.toolCall) {
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "bash", toolCallId: options.toolCall, args: {} },
			ctx,
		);
		await handlers.get("tool_execution_end")!(
			{
				type: "tool_execution_end",
				toolName: "bash",
				toolCallId: options.toolCall,
				result: { content: [] },
				isError: false,
			},
			ctx,
		);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: options.toolCall,
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
				},
			},
			ctx,
		);
	}
	await handlers.get("turn_end")!({ type: "turn_end", turnIndex, message }, ctx);
}

test("lean keeps the final answer when a same-run autonomous follow-up settles after it", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const finalAnswer = "Final report: all five steps are done and verified.";
		const followUp = "Both background reviews were already handled above.";

		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Work through the instruction file." } },
			ctx,
		);
		await toolLoopTurn(handlers, ctx, 0, "Now the code under fix.", { toolCall: "call-0" });
		await toolLoopTurn(handlers, ctx, 1, "Checking the build output.", { toolCall: "call-1" });
		await toolLoopTurn(handlers, ctx, 2, "Applying the edit.", { toolCall: "call-2" });
		await toolLoopTurn(handlers, ctx, 3, finalAnswer);
		// A queued background result continues the same busy run after the final answer.
		await toolLoopTurn(handlers, ctx, 4, followUp, { steering: "2 background jobs have completed." });
		await sleep(150);
		expect(turnStreams().length).toBe(0);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "settled receipt");
		const text = turnStreams()[0]!.text ?? "";
		expect(text).toContain(finalAnswer);
		expect(text).toContain(followUp);
		expect(text.indexOf(finalAnswer)).toBeLessThan(text.indexOf(followUp));
		expect(text).not.toContain("Now the code under fix.");
		expect(text).not.toContain("Applying the edit.");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(true);
		await sleep(150);
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean keeps a provider-resolved final answer when a same-run async result follows it", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const finalAnswer = "Final report: the provider ran the checks and they pass.";
		const followUp = "The background job finished as well.";

		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Run the checks." } },
			ctx,
		);
		// Devin ACP reports tools its own agent ran as display-only blocks on a
		// completed turn; the agent loop never dispatches them, so the turn settles.
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: finalAnswer },
				{
					type: "toolCall",
					id: "devin-0",
					name: "bash",
					arguments: { command: "bun test" },
					[kProviderResolvedToolCall]: true,
				},
			],
			stopReason: "stop",
		};
		await handlers.get("message_end")!({ type: "message_end", message }, ctx);
		await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message }, ctx);
		await toolLoopTurn(handlers, ctx, 1, followUp, { steering: "1 background job has completed." });
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "settled receipt");
		const text = turnStreams()[0]!.text ?? "";
		expect(text).toContain(finalAnswer);
		expect(text).toContain(followUp);
		expect(text.indexOf(finalAnswer)).toBeLessThan(text.indexOf(followUp));
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean does not anchor tool-loop narration when autonomous input steers a run mid-flight", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const finalAnswer = "Final report: the migration is complete.";
		const followUp = "That review result was already applied.";

		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Run the migration." } },
			ctx,
		);
		await toolLoopTurn(handlers, ctx, 0, "Reading the schema first.", { toolCall: "call-0" });
		// A peer message steers into the running loop; the tool work continues.
		await toolLoopTurn(handlers, ctx, 1, "Noted the peer message; continuing.", {
			toolCall: "call-1",
			steering: "peer message",
		});
		await toolLoopTurn(handlers, ctx, 2, "Running the migration.", { toolCall: "call-2" });
		await toolLoopTurn(handlers, ctx, 3, finalAnswer);
		await toolLoopTurn(handlers, ctx, 4, followUp, { steering: "review complete" });
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 1, 3000, "settled receipt");
		const text = turnStreams()[0]!.text ?? "";
		expect(text).toContain(finalAnswer);
		expect(text).toContain(followUp);
		expect(text).not.toContain("Reading the schema first.");
		expect(text).not.toContain("Running the migration.");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a tool-using user request keeps its final answer through a later autonomous ask lead-in", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");
		const finalAnswer = "Final report: the requested change is merged.";

		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Merge the change." } },
			ctx,
		);
		await toolLoopTurn(handlers, ctx, 0, "Rebasing first.", { toolCall: "call-0" });
		await toolLoopTurn(handlers, ctx, 1, finalAnswer);

		// A queued background result continues the run and asks a follow-up question.
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 2 }, ctx);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: { role: "custom", customType: "async-result", attribution: "agent", content: "job done" },
			},
			ctx,
		);
		const leadIn = {
			role: "assistant",
			content: [
				{ type: "text", text: "Choose a follow-up action." },
				{ type: "toolCall", id: "ask-2", name: "ask", arguments: {} },
			],
			stopReason: "toolUse",
		};
		await handlers.get("message_end")!({ type: "message_end", message: leadIn }, ctx);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-2", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "autonomous ask lead-in");
		await handlers.get("tool_execution_end")!(
			{ type: "tool_execution_end", toolName: "ask", toolCallId: "ask-2", result: { content: [] }, isError: false },
			ctx,
		);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "ask-2",
					toolName: "ask",
					content: [{ type: "text", text: "A" }],
				},
			},
			ctx,
		);
		await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 2, message: leadIn }, ctx);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);

		await waitFor(() => turnStreams().length === 2, 3000, "retained final answer after ask");
		expect(turnStreams()[1]!.text).toContain(finalAnswer);
		expect(turnStreams()[1]!.text).not.toContain("Rebasing first.");
		expect(finalAnswerOf(turnStreams()[1]!)).toBe(true);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("lean does not re-emit tool-loop narration after an ask lead-in in the same run", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "user", content: "Pick a deployment target." } },
			ctx,
		);
		await toolLoopTurn(handlers, ctx, 0, "Listing the available targets.", { toolCall: "call-0" });

		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		const leadIn = {
			role: "assistant",
			content: [
				{ type: "text", text: "Choose one:" },
				{ type: "toolCall", id: "ask-0", name: "ask", arguments: {} },
			],
			stopReason: "toolUse",
		};
		await handlers.get("message_end")!({ type: "message_end", message: leadIn }, ctx);
		await handlers.get("tool_execution_start")!(
			{ type: "tool_execution_start", toolName: "ask", toolCallId: "ask-0", args: {} },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "ask lead-in");
		expect(turnStreams()[0]!.text).toContain("Choose one:");
		await handlers.get("tool_execution_end")!(
			{ type: "tool_execution_end", toolName: "ask", toolCallId: "ask-0", result: { content: [] }, isError: false },
			ctx,
		);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "ask-0",
					toolName: "ask",
					content: [{ type: "text", text: "A" }],
				},
			},
			ctx,
		);
		await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 1, message: leadIn }, ctx);
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(200);

		expect(turnStreams().some(f => f.text?.includes("Listing the available targets."))).toBe(false);
		expect(turnStreams().length).toBe(1);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("verbose still streams a finalized turn_stream at each turn_end", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "verbose" }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.verbosity === "verbose"), 3000, "verbose");

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "Step one complete." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: "Step one complete." } },
			ctx,
		);
		await waitFor(() => turnStreams().length === 1, 3000, "first verbose turn_stream");
		expect(turnStreams()[0]!.text).toContain("Step one complete.");
		expect(finalAnswerOf(turnStreams()[0]!)).toBe(true);

		await handlers.get("message_end")!(
			{ type: "message_end", message: { role: "assistant", content: "All finished." } },
			ctx,
		);
		await handlers.get("turn_end")!(
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", content: "All finished." } },
			ctx,
		);
		await waitFor(() => turnStreams().length === 2, 3000, "second verbose turn_stream");
		expect(turnStreams()[1]!.text).toContain("All finished.");
		expect(finalAnswerOf(turnStreams()[1]!)).toBe(true);

		// agent_end must not re-emit already-streamed verbose turns.
		await handlers.get("agent_end")!({ type: "agent_end" }, ctx);
		await sleep(150);
		expect(turnStreams().length).toBe(2);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

const messageRefOf = (f: Frame): string | undefined => (f as { messageRef?: string }).messageRef;

// Decision A / Pro round-5 regression: a stream-enabled *verbose* turn must finalize
// as an editable (messageRef-bearing) frame even when live frames were async and
// none landed before turn_end — so the daemon keeps it on the HTML edit path and
// never rich-promotes a streamed final — and a late message_update after turn_end
// must be dropped so no stale live edit follows the final. Lean deliberately
// suppresses live streaming and defers settled answers to agent_end.
test("stream-enabled final always carries a messageRef and a late message_update is dropped", async () => {
	const prevN = process.env.GJC_NOTIFICATIONS;
	const prevS = process.env.GJC_NOTIFICATIONS_STREAM;
	process.env.GJC_NOTIFICATIONS = "1";
	process.env.GJC_NOTIFICATIONS_STREAM = "1";
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup();
		const turnStreams = () => frames.filter(f => f.type === "turn_stream");

		ws.send(JSON.stringify({ type: "config_command", sessionId: sid, token, verbosity: "verbose" }));
		await waitFor(() => frames.some(f => f.type === "config_update" && f.verbosity === "verbose"), 3000, "verbose");

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

// #4528 lifecycle regression: a daemon-originated user message must be acked
// `accepted` at session preflight acceptance (before turn_start). Pre-acceptance
// rejection must not accept; a failure after acceptance must still reject.
test("inbound user_message acks accepted at preflight acceptance and rejected on late failure", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	type AcceptanceOptions = {
		onPreflightAcceptCommit?: () => void;
		onPreflightAccepted?: () => void;
	};
	type Submission = {
		content: unknown;
		options: AcceptanceOptions;
		promise: Promise<void>;
		resolve: () => void;
		reject: (reason?: unknown) => void;
	};
	const sendCalls: Submission[] = [];
	try {
		const { handlers, ctx, frames, ws, token, sid } = await setup({
			sendUserMessageOverride: (content, options) => {
				const held = Promise.withResolvers<void>();
				sendCalls.push({ content, options: options as AcceptanceOptions, ...held });
				// Return the held promise itself: the bus registers its await continuation
				// synchronously before the test can release this submission.
				return held.promise;
			},
		});
		const acks = (updateId: number) =>
			frames
				.filter(f => f.type === "inbound_ack" && f.updateId === updateId)
				.map(f => ({
					state: f.state,
					updateId: f.updateId,
					...(f.reason === undefined ? {} : { reason: f.reason }),
				}));
		const submit = async (updateId: number, text: string): Promise<Submission> => {
			const index = sendCalls.length;
			ws.send(JSON.stringify({ type: "user_message", sessionId: sid, token, text, updateId }));
			await waitFor(() => sendCalls.length === index + 1, 3000, `submission ${updateId}`);
			const call = sendCalls[index]!;
			expect(call.content).toBe(text);
			expect(call.options).toHaveProperty("onPreflightAcceptCommit");
			expect(call.options).toHaveProperty("onPreflightAccepted");
			return call;
		};
		const repeatCallbacks = (call: Submission): void => {
			call.options.onPreflightAcceptCommit!();
			call.options.onPreflightAccepted!();
			call.options.onPreflightAcceptCommit!();
			call.options.onPreflightAccepted!();
		};
		const flushAcks = async (updateId: number): Promise<void> => {
			// This authenticated socket's correlated replay response follows directed
			// acks already queued by callbacks, turn_start, and the settled bus await.
			const id = `inbound-acceptance-${updateId}`;
			ws.send(JSON.stringify({ type: "event_replay", id, sinceGeneration: 0, sinceSeq: 0 }));
			await waitFor(
				() => frames.some(f => f.type === "event_replay_result" && f.id === id),
				3000,
				`ack barrier ${updateId}`,
			);
		};
		const rejectSubmission = async (call: Submission): Promise<void> => {
			call.reject(new Error("admission rejected"));
			await call.promise.catch(() => {});
		};

		// --- Accepted path: the ack must land at preflight acceptance, before the
		// test releases the prompt promise, and before turn_start fires.
		const committed = await submit(9001, "hello from telegram");
		committed.options.onPreflightAcceptCommit!();
		await waitFor(() => acks(9001).some(a => a.state === "accepted"), 3000, "accepted inbound_ack");
		repeatCallbacks(committed);

		// turn_start now fires while the prompt is still held pending: the
		// update was already registered, so consumption acks rather than races.
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await waitFor(() => acks(9001).some(a => a.state === "consumed"), 3000, "consumed inbound_ack");
		expect(sendCalls.length).toBe(1);
		repeatCallbacks(committed);
		committed.resolve();
		// Await the SAME returned promise, after the bus's earlier continuation:
		// its synchronous post-await acceptance fallback has now run.
		await committed.promise;
		repeatCallbacks(committed);
		await flushAcks(9001);
		expect(acks(9001)).toEqual([
			{ state: "accepted", updateId: 9001 },
			{ state: "consumed", updateId: 9001 },
		]);

		// --- Rejected path: a late admission rejection acks rejected, never accepted.
		const rejected = await submit(9002, "second try");
		await rejectSubmission(rejected);
		await flushAcks(9002);
		expect(acks(9002)).toEqual([{ state: "rejected", updateId: 9002, reason: "injection_failed" }]);

		// The legacy callback independently accepts; commit is not required first.
		const legacy = await submit(9003, "legacy acceptance");
		legacy.options.onPreflightAccepted!();
		await waitFor(() => acks(9003).some(a => a.state === "accepted"), 3000, "legacy accepted inbound_ack");
		repeatCallbacks(legacy);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 1 }, ctx);
		await waitFor(() => acks(9003).some(a => a.state === "consumed"), 3000, "legacy consumed inbound_ack");
		repeatCallbacks(legacy);
		legacy.resolve();
		await legacy.promise;
		repeatCallbacks(legacy);
		await flushAcks(9003);
		expect(acks(9003)).toEqual([
			{ state: "accepted", updateId: 9003 },
			{ state: "consumed", updateId: 9003 },
		]);

		// With no callback, successful settlement must supply acceptance itself.
		const fallback = await submit(9004, "settlement fallback");
		fallback.resolve();
		await fallback.promise;
		await waitFor(() => acks(9004).some(a => a.state === "accepted"), 3000, "fallback accepted inbound_ack");
		repeatCallbacks(fallback);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 2 }, ctx);
		await waitFor(() => acks(9004).some(a => a.state === "consumed"), 3000, "fallback consumed inbound_ack");
		repeatCallbacks(fallback);
		await flushAcks(9004);
		expect(acks(9004)).toEqual([
			{ state: "accepted", updateId: 9004 },
			{ state: "consumed", updateId: 9004 },
		]);

		// Acceptance does not suppress a later rejection: preserve both wire acks.
		const lateFailure = await submit(9005, "failure after acceptance");
		lateFailure.options.onPreflightAcceptCommit!();
		await waitFor(() => acks(9005).some(a => a.state === "accepted"), 3000, "late-failure accepted inbound_ack");
		repeatCallbacks(lateFailure);
		await rejectSubmission(lateFailure);
		repeatCallbacks(lateFailure);
		await flushAcks(9005);
		expect(acks(9005)).toEqual([
			{ state: "accepted", updateId: 9005 },
			{ state: "rejected", updateId: 9005, reason: "injection_failed" },
		]);
		expect(sendCalls.length).toBe(5);
	} finally {
		// Do not leave the extension awaiting a held prompt if any assertion fails.
		for (const call of sendCalls) call.resolve();
		await Promise.allSettled(sendCalls.map(call => call.promise));
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);
