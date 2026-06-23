import { describe, expect, test } from "bun:test";
import { createDiscordAdapter, createSlackAdapter } from "../src/notifications/chat-adapters";
import { NotificationPresentationEngine, type NotificationReplyRoute } from "../src/notifications/engine";

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
