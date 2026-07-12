import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/notifications/index";
import { readEndpoint } from "../src/notifications/telegram-reference";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { daemonPaths } from "../src/notifications/daemon-paths";
import { tokenFingerprint } from "../src/notifications/config";
import { DAEMON_GENERATION, DAEMON_VERSION } from "../src/notifications/telegram-daemon";

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
	verbosity?: "lean" | "verbose";
	tokenUsage?: string;
	model?: string;
	cwd?: string;
};

type TestContextUsage = { tokens: number | null; contextWindow: number };
type TestModel = { id?: string };

const tempDirs: string[] = [];
const openSockets: WebSocket[] = [];
// Telegram-gate tests re-point the module-global agent dir resolver; capture the
// original at load and restore it after every test so it never leaks.
const originalAgentDir = getAgentDir();
afterEach(() => {
	for (const ws of openSockets.splice(0)) ws.close();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	setAgentDir(originalAgentDir);
});

/** Boot the notifications extension against a real NotificationServer + WS client. */
async function setup(options: { contextUsage?: TestContextUsage | false; model?: TestModel | false } = {}): Promise<{
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
		getContextUsage: () =>
			options.contextUsage === false ? undefined : (options.contextUsage ?? { tokens: 12, contextWindow: 100 }),
		getModel: () => (options.model === false ? undefined : (options.model ?? { id: "test-model" })),
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
// (crates/gjc-notifications/src/protocol.rs) carries it as an optional
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

// ---------------------------------------------------------------------------
// Telegram registration hard-gate regression coverage.
//
// These exercise the REAL createNotificationsExtension() / NotificationServer
// lifecycle (no mocks of ensureTelegramDaemonRunning): a configured-Telegram
// session must complete a fresh daemon registration BEFORE it publishes an
// endpoint, registers its answer source, or pins its identity header. Only
// `owner_spawned` / `attached` clear the gate; `blocked`, a thrown registration,
// or any other result fails the session before any publication. They rely on
// the real roots lock (withFileLock retries:"forever"), the additive roots
// `sessionLeases` / `orphanCandidates` maps, the two-phase absence candidate,
// registration-before-endpoint ordering, the literal `{ok:true}` requirement,
// and selective compaction — at the observable endpoint-file / registry level.
//
// The configured-Telegram gate is only reached when a Settings override is
// passed to createNotificationsExtension (otherwise settingsAvailable is false
// and the gate is skipped, which is why the ordering tests above never hit it).
// ---------------------------------------------------------------------------

/** Make a temp dir tracked for afterEach cleanup. */
function mkdtemp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeJsonFile(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function endpointFileFor(cwd: string, sid: string): string {
	return path.join(cwd, ".gjc", "state", "notifications", `${sid}.json`);
}

function sessionLeaseOf(rootsFile: string, sid: string): { leaseId: string; refreshedAt: number } | undefined {
	const reg = readJsonFile(rootsFile);
	const leases = (reg?.sessionLeases ?? {}) as Record<string, { leaseId: string; refreshedAt: number }>;
	return leases[sid];
}

function orphanCandidateOf(rootsFile: string, sid: string): unknown {
	const reg = readJsonFile(rootsFile);
	const candidates = (reg?.orphanCandidates ?? {}) as Record<string, unknown>;
	return candidates[sid];
}

/** Persist a live daemon-ownership record (telegram-daemon.state.json) under agentDir. */
function seedDaemonOwner(agentDir: string, owner: { tokenFingerprint: string; chatId: string }): void {
	const { dir, state } = daemonPaths(agentDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		state,
		`${JSON.stringify(
			{
				pid: process.pid,
				ownerId: "seeded-live-owner",
				tokenFingerprint: owner.tokenFingerprint,
				chatId: owner.chatId,
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				roots: [],
				version: DAEMON_VERSION,
				generation: DAEMON_GENERATION,
			},
			null,
			2,
		)}\n`,
	);
}

/** Pre-seed the roots registry with a stale session lease + orphan-candidate delete proof. */
function seedRootsRegistry(rootsFile: string, sid: string, root: string, oldLeaseId: string): void {
	const stale = Date.now() - 100_000;
	writeJsonFile(rootsFile, {
		version: 1,
		roots: [root],
		sessions: { [sid]: root },
		sessionLeases: { [sid]: { leaseId: oldLeaseId, refreshedAt: stale } },
		orphanCandidates: { [sid]: { observedAt: stale, leaseId: oldLeaseId, topicId: "777" } },
	});
}

function telegramSettings(botToken: string, chatId: string): Settings {
	return Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": botToken,
		"notifications.telegram.chatId": chatId,
	});
}

/** Register the real notifications extension against a configured-Telegram Settings. */
function buildTelegramHarness(settings: Settings, cwd: string, sid: string): {
	handlers: Map<string, Handler>;
	ctx: unknown;
} {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api, { settings });
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => "Telegram Gate Test",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
		getContextUsage: () => ({ tokens: 12, contextWindow: 100 }),
		getModel: () => ({ id: "test-model" }),
	} as never;
	return { handlers, ctx };
}

test("a configured-Telegram session blocked by a live owner with a different identity fails before any endpoint/runtime/identity publication", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const agentDir = mkdtemp("gjc-tg-blocked-agent-");
		setAgentDir(agentDir);
		const botToken = "77:blocked-bot-token";
		const chatId = "123456789";
		const settings = telegramSettings(botToken, chatId);
		// A live owner (our own pid) advertising a DIFFERENT token fingerprint and
		// chat id -> acquireDaemonOwnership returns blocked WITHOUT spawning, so
		// ensureTelegramDaemonRunning resolves "blocked" and the gate fails.
		seedDaemonOwner(agentDir, { tokenFingerprint: "000000000000", chatId: "999999999" });

		const cwd = mkdtemp("gjc-tg-blocked-cwd-");
		const sid = `blocked-${process.pid}-${Date.now()}`;
		const { handlers, ctx } = buildTelegramHarness(settings, cwd, sid);
		const endpointFile = endpointFileFor(cwd, sid);

		// session_start resolves (the gate returns "failed"); server.start() is never
		// reached, so no endpoint / runtime / identity is published.
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await sleep(300);
		expect(fs.existsSync(endpointFile)).toBe(false);
		// Registration now runs BEFORE ownership acquisition (the registration-first
		// contract), so a lease IS committed even though ownership later blocks — but
		// the blocked ownership still fails the gate, so NO endpoint is published.
		const rootsFile = daemonPaths(agentDir).roots;
		expect(sessionLeaseOf(rootsFile, sid)).toBeDefined();
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a configured-Telegram session whose daemon registration throws fails before any publication", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const agentDir = mkdtemp("gjc-tg-throw-agent-");
		setAgentDir(agentDir);
		const settings = telegramSettings("55:throw-bot-token", "77777777");
		// Registration runs first, so its ensureDir (recursive mkdir on the daemon
		// notifications dir) throws EEXIST because that path is a regular file.
		// registerNotificationRoot -> ensureTelegramDaemonRunning re-throw; the gate
		// catches the throw and returns "failed" before any endpoint publication.
		fs.writeFileSync(path.join(agentDir, "notifications"), "not-a-directory");

		const cwd = mkdtemp("gjc-tg-throw-cwd-");
		const sid = `throw-${process.pid}-${Date.now()}`;
		const { handlers, ctx } = buildTelegramHarness(settings, cwd, sid);
		const endpointFile = endpointFileFor(cwd, sid);

		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await sleep(300);
		expect(fs.existsSync(endpointFile)).toBe(false);
		// The notifications dir is a file, so no roots registry could ever be written.
		expect(fs.existsSync(daemonPaths(agentDir).roots)).toBe(false);
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a notifications-enabled session with Telegram NOT configured skips the registration gate and still publishes its endpoint", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const agentDir = mkdtemp("gjc-tg-skip-agent-");
		setAgentDir(agentDir);
		// Enabled but with NO boundary credentials -> isTelegramConfigured is false ->
		// the registration gate is skipped entirely (the "disabled" EnsureDaemonResult
		// branch is unreachable through the gate with the same cfg, so it is represented
		// by this skip path).
		const settings = Settings.isolated({ "notifications.enabled": true });

		const cwd = mkdtemp("gjc-tg-skip-cwd-");
		const sid = `skip-${process.pid}-${Date.now()}`;
		const { handlers, ctx } = buildTelegramHarness(settings, cwd, sid);
		const endpointFile = endpointFileFor(cwd, sid);

		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file (non-Telegram)");
		expect(fs.existsSync(endpointFile)).toBe(true);
		// No Telegram registration ran -> no lease for this session.
		const rootsFile = daemonPaths(agentDir).roots;
		if (fs.existsSync(rootsFile)) {
			expect(sessionLeaseOf(rootsFile, sid)).toBeUndefined();
		}
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("a configured-Telegram session that attaches publishes its endpoint only after registration commits the session lease", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		const agentDir = mkdtemp("gjc-tg-ok-agent-");
		setAgentDir(agentDir);
		const botToken = "12:ok-bot-token";
		const chatId = "3133731337";
		const settings = telegramSettings(botToken, chatId);
		// A fresh, identity-MATCHING live owner (current generation) -> attaches WITHOUT
		// spawning, then runs the real registerNotificationRoot before returning.
		seedDaemonOwner(agentDir, { tokenFingerprint: tokenFingerprint(botToken), chatId });

		const cwd = mkdtemp("gjc-tg-ok-cwd-");
		const sid = `ok-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const { handlers, ctx } = buildTelegramHarness(settings, cwd, sid);
		const endpointFile = endpointFileFor(cwd, sid);
		const rootsFile = daemonPaths(agentDir).roots;

		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file (configured-Telegram success)");

		// Endpoint published AND registration already committed a fresh lease for this
		// session (registration is awaited before server.start()).
		expect(fs.existsSync(endpointFile)).toBe(true);
		const lease = sessionLeaseOf(rootsFile, sid);
		expect(lease).toBeDefined();
		expect(typeof lease?.leaseId).toBe("string");

		// The published runtime is live: agent_start emits an observable activity frame.
		// (Contrast with the blocked / throw cases, where no runtime is ever published.)
		const { url, token } = readEndpoint(endpointFile);
		const frames: Frame[] = [];
		const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
		openSockets.push(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("ws error")));
		});
		ws.addEventListener("message", ev => frames.push(JSON.parse(String((ev as MessageEvent).data))));
		await sleep(250);
		await handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitFor(() => frames.some(f => f.type === "activity"), 3000, "activity frame");
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);

test("configured-Telegram start waits behind a long-held roots lock, then a fresh lease commits before the endpoint and the stale delete proof is invalidated", async () => {
	const prevEnv = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	try {
		// A configured-Telegram session whose ownership is a fresh identity-matching
		// live owner attaches WITHOUT spawning, then calls the real
		// registerNotificationRoot under the forever roots lock before publishing.
		const agentDir = mkdtemp("gjc-tg-race-agent-");
		setAgentDir(agentDir);
		const botToken = "99:race-bot-token";
		const chatId = "424242424";
		const settings = telegramSettings(botToken, chatId);
		seedDaemonOwner(agentDir, { tokenFingerprint: tokenFingerprint(botToken), chatId });

		const cwd = mkdtemp("gjc-tg-race-cwd-");
		const sid = `race-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const paths = daemonPaths(agentDir);
		const root = path.join(cwd, ".gjc", "state");
		const OLD_LEASE = "old-lease-stale-proof";
		// Pre-seed a stale orphan-candidate delete proof (old lease) for this session.
		seedRootsRegistry(paths.roots, sid, root, OLD_LEASE);

		const { handlers, ctx } = buildTelegramHarness(settings, cwd, sid);
		const endpointFile = endpointFileFor(cwd, sid);

		// Hold the REAL roots lock (the delete transaction's forever lock) with a LIVE
		// owner so stale-reaping never reclaims it; registerNotificationRoot must wait.
		const lockDir = `${paths.roots}.lock`;
		fs.mkdirSync(lockDir);
		fs.writeFileSync(path.join(lockDir, "info"), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
		const heldSince = Date.now();

		// Fire session_start without awaiting: the gate reaches registerNotificationRoot
		// and blocks on the held lock, so the endpoint cannot publish.
		const startPromise = handlers.get("session_start")!({ type: "session_start" }, ctx) as Promise<unknown>;
		await sleep(500);
		expect(fs.existsSync(endpointFile)).toBe(false);

		// Hold well beyond the OLD finite lock budget (default 50 retries * 100ms ~= 5s).
		await sleep(5000);
		expect(fs.existsSync(endpointFile)).toBe(false);

		// Discriminating check: under the old finite budget registration would have
		// thrown (~5s) and startPromise resolved as "failed". Under retries:"forever" it
		// must STILL be waiting on the lock past the 5.25s budget.
		let resolvedEarly = false;
		startPromise.then(() => {
			resolvedEarly = true;
		});
		await sleep(300);
		expect(resolvedEarly).toBe(false);
		expect(fs.existsSync(endpointFile)).toBe(false);
		expect(Date.now() - heldSince).toBeGreaterThan(5250);

		// Release the lock (the in-flight delete transaction finishes). Registration
		// acquires it, commits a FRESH lease (new leaseId) and clears the orphan
		// candidate, THEN the gate proceeds and the endpoint publishes.
		fs.rmSync(lockDir, { recursive: true, force: true });
		await startPromise;
		await waitFor(() => fs.existsSync(endpointFile), 4000, "endpoint file after lock release");
		expect(fs.existsSync(endpointFile)).toBe(true);

		// Fresh lease committed before the endpoint, and the stale delete proof is
		// invalidated: the orphan candidate was cleared by registration, and the live
		// leaseId no longer matches the old proof. deleteOrphanedTopic's under-lock
		// revalidation (`!lease || !candidate`, then `candidate.leaseId !==
		// lease.leaseId`) would now abort — the old proof cannot delete again.
		const lease = sessionLeaseOf(paths.roots, sid);
		expect(lease).toBeDefined();
		expect(typeof lease?.leaseId).toBe("string");
		expect(lease?.leaseId).not.toBe(OLD_LEASE);
		expect(orphanCandidateOf(paths.roots, sid)).toBeUndefined();
	} finally {
		if (prevEnv === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = prevEnv;
	}
}, 30000);
