import { describe, expect, test } from "bun:test";
import { createDiscordAdapter, createSlackAdapter } from "../src/sdk/bus/chat-adapters";
import { NotificationPresentationEngine, type NotificationReplyRoute } from "../src/sdk/bus/engine";

const secretCorpus = [
	"raw prompt body",
	"transcript chunk",
	"xoxb-secret-token",
	"https://hooks.slack.com/services/T/B/C",
	"/home/alice/private/repo",
	"bot-token-secret",
];

describe("Discord and Slack notification adapters", () => {
	test("render ask events and map replies without owning daemon lifecycle", () => {
		const discord = createDiscordAdapter({ channelId: "discord-channel" });
		const slack = createSlackAdapter({ channelId: "slack-channel" });
		const engine = new NotificationPresentationEngine([discord, slack], {
			redact: true,
			sessionTag: sessionId => sessionId.slice(-6),
		});
		const replies: NotificationReplyRoute[] = [];
		engine.connectSession("session-abcdef", { sendReply: route => replies.push(route) });

		const payloads = engine.fanout({
			type: "action_needed",
			id: "ask-1",
			kind: "ask",
			sessionId: "session-abcdef",
			question: "Proceed with deploy?",
			options: ["Yes", "No"],
			summary: "prompt context is intentionally not needed for routing",
		});

		expect(payloads.map(payload => payload.adapter)).toEqual(["discord", "slack"]);
		expect(JSON.stringify(payloads[0]!.body)).toContain("Proceed with deploy?");
		expect(JSON.stringify(payloads[1]!.body)).toContain("1. Yes");
		expect(payloads[0]!.route).toEqual({ sessionId: "session-abcdef", actionId: "ask-1" });

		expect(engine.routeInbound("discord", { sessionId: "session-abcdef", actionId: "ask-1", answer: 0 })).toBe(true);
		expect(engine.routeInbound("slack", { sessionId: "session-abcdef", actionId: "ask-1", text: "No" })).toBe(true);
		expect(replies).toEqual([
			{ sessionId: "session-abcdef", actionId: "ask-1", answer: 0 },
			{ sessionId: "session-abcdef", actionId: "ask-1", answer: "No" },
		]);
	});

	test("redacts public payload boundaries for non-ask events", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: true,
			sessionTag: () => "abcdef",
		});
		const payloads = engine.fanout({
			type: "action_needed",
			id: "idle-1",
			kind: "idle",
			sessionId: "session-abcdef",
			summary: secretCorpus.join(" "),
		});
		const serialized = JSON.stringify(payloads);
		expect(serialized).toContain("Agent idle");
		for (const secret of secretCorpus) expect(serialized).not.toContain(secret);
	});

	test("ignore unknown or stale inbound replies", () => {
		const engine = new NotificationPresentationEngine([createDiscordAdapter()], {
			redact: false,
			sessionTag: () => "abcdef",
		});
		engine.connectSession("session-abcdef", { sendReply: () => expect.unreachable("stale reply routed") });
		expect(engine.routeInbound("discord", { sessionId: "session-abcdef", actionId: "missing", answer: 0 })).toBe(
			false,
		);
		expect(engine.routeInbound("slack", { sessionId: "session-abcdef", actionId: "missing", answer: 0 })).toBe(false);
	});
});

describe("notification quiet visible allowlist", () => {
	const quietEngine = () =>
		new NotificationPresentationEngine([createDiscordAdapter(), createSlackAdapter()], {
			redact: false,
			sessionTag: () => "abcdef",
		});

	test("quiet silences session_ready/identity/config residual bodies but keeps ask visible", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		// ask stays visible under quiet
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-1",
			kind: "ask",
			sessionId: "session-a",
			question: "Proceed?",
			options: ["Yes", "No"],
		});
		expect(ask).toHaveLength(2);
		expect(JSON.stringify(ask)).toContain("Proceed?");
		// identity_header residual is silent under quiet
		const identity = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "identity_header", sessionId: "session-a", title: "Replay identity", repo: "replay-repo", branch: "replay-branch" },
		});
		expect(identity).toEqual([]);
		// config_update residual is silent under quiet
		const configUpdate = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "config_update", sessionId: "session-a", verbosity: "lean" },
		});
		expect(configUpdate).toEqual([]);
		// session_ready residual (as a generic frame) is silent under quiet
		const sessionReady = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "session_ready", sessionId: "session-a", generation: 1 },
		});
		expect(sessionReady).toEqual([]);
	});

	test("quiet keeps idle visible", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		const idle = engine.fanout({
			type: "action_needed",
			id: "idle-1",
			kind: "idle",
			sessionId: "session-a",
			summary: "waiting for input",
		});
		expect(idle).toHaveLength(2);
		expect(JSON.stringify(idle)).toContain("Agent idle");
	});

	test("quiet keeps user control results visible", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		const controlResult = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "control_command_result", sessionId: "session-a", status: "ok", message: "model switched" },
		});
		expect(controlResult).toHaveLength(2);
		expect(JSON.stringify(controlResult)).toContain("GJC control command result");
	});

	test("quiet keeps authorized explicit attachments visible", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		const fileAttachment = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "file_attachment", sessionId: "session-a", name: "report.md", caption: "monthly report" },
		});
		expect(fileAttachment).toHaveLength(2);
		const imageAttachment = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "image_attachment", sessionId: "session-a", caption: "screenshot" },
		});
		expect(imageAttachment).toHaveLength(2);
	});

	test("quiet silences unknown and automatic frames (turn_stream, tool_activity, reasoning_summary)", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		for (const frameType of ["turn_stream", "tool_activity", "reasoning_summary", "context_update", "unknown_frame_type"]) {
			const payloads = engine.fanout({
				type: "frame",
				sessionId: "session-a",
				frame: { type: frameType, sessionId: "session-a", text: "automatic content" },
			});
			expect(payloads).toEqual([]);
		}
	});

	test("quiet silences non-ask/non-idle action kinds", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		const payloads = engine.fanout({
			type: "action_needed",
			id: "other-1",
			kind: "approval",
			sessionId: "session-a",
			question: "Approve?",
		});
		expect(payloads).toEqual([]);
	});

	test("session A quiet cannot silence session B lean (two-session isolation)", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		engine.connectSession("session-b", { sendReply: () => undefined }, "lean");
		// Session A quiet: identity residual silent
		expect(
			engine.fanout({
				type: "frame",
				sessionId: "session-a",
				frame: { type: "identity_header", sessionId: "session-a", title: "A", repo: "a-repo", branch: "a-branch" },
			}),
		).toEqual([]);
		// Session B lean: identity residual visible
		const bIdentity = engine.fanout({
			type: "frame",
			sessionId: "session-b",
			frame: { type: "identity_header", sessionId: "session-b", title: "B", repo: "b-repo", branch: "b-branch" },
		});
		expect(bIdentity).toHaveLength(2);
		expect(JSON.stringify(bIdentity)).toContain("b-repo");
		// Session A quiet: turn_stream silent
		expect(
			engine.fanout({
				type: "frame",
				sessionId: "session-a",
				frame: { type: "turn_stream", sessionId: "session-a", text: "A streaming" },
			}),
		).toEqual([]);
		// Session B lean: turn_stream visible
		const bStream = engine.fanout({
			type: "frame",
			sessionId: "session-b",
			frame: { type: "turn_stream", sessionId: "session-b", text: "B streaming" },
		});
		expect(bStream).toHaveLength(2);
		expect(JSON.stringify(bStream)).toContain("B streaming");
	});

	test("missing session policy fails closed under quiet for automatic content, but allowlists ask", () => {
		const engine = quietEngine();
		// No connectSession call — session has no policy entry (fail-closed quiet).
		expect(
			engine.fanout({
				type: "frame",
				sessionId: "session-unknown",
				frame: { type: "turn_stream", sessionId: "session-unknown", text: "orphaned" },
			}),
		).toEqual([]);
		// Allowlisted asks still deliver under fail-closed quiet for an unknown session.
		const ask = engine.fanout({
			type: "action_needed",
			id: "ask-orphan",
			kind: "ask",
			sessionId: "session-unknown",
			question: "Proceed?",
			options: ["Yes"],
		});
		expect(ask).toHaveLength(2);
		expect(JSON.stringify(ask)).toContain("Proceed?");
	});

	test("strict per-session config_update via setSessionVerbosity is monotonic and isolated", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "quiet");
		engine.connectSession("session-b", { sendReply: () => undefined }, "lean");
		const aBefore = engine.getSessionPolicy("session-a")!;
		expect(aBefore.verbosity).toBe("quiet");
		// Update session A to lean; generation must increase.
		const aGen = engine.setSessionVerbosity("session-a", "lean");
		expect(aGen).toBeGreaterThan(aBefore.policyGeneration);
		expect(engine.getSessionPolicy("session-a")?.verbosity).toBe("lean");
		// Session B policy is unchanged by A's update.
		expect(engine.getSessionPolicy("session-b")?.verbosity).toBe("lean");
		expect(engine.getSessionPolicy("session-b")?.policyGeneration).toBe(engine.getSessionPolicy("session-b")!.policyGeneration);
		// After A becomes lean, A's identity residual is now visible.
		const aIdentity = engine.fanout({
			type: "frame",
			sessionId: "session-a",
			frame: { type: "identity_header", sessionId: "session-a", title: "A", repo: "a-repo", branch: "a-branch" },
		});
		expect(aIdentity).toHaveLength(2);
		// setSessionVerbosity on an unknown session returns undefined (no policy change).
		expect(engine.setSessionVerbosity("session-unknown", "quiet")).toBeUndefined();
	});

	test("dropSession clears the per-session policy (fail closed after drop)", () => {
		const engine = quietEngine();
		engine.connectSession("session-a", { sendReply: () => undefined }, "lean");
		expect(engine.getSessionPolicy("session-a")?.verbosity).toBe("lean");
		engine.dropSession("session-a");
		expect(engine.getSessionPolicy("session-a")).toBeUndefined();
		// After drop, fanout fails closed (quiet) for the dropped session.
		expect(
			engine.fanout({
				type: "frame",
				sessionId: "session-a",
				frame: { type: "turn_stream", sessionId: "session-a", text: "after drop" },
			}),
		).toEqual([]);
	});
});
