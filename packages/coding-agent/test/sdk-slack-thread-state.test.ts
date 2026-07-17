import { describe, expect, it } from "bun:test";
import {
	acceptsSlackInbound,
	normalizeSlackConversation,
	type SlackConversation,
	slackConversationKey,
} from "../src/sdk/bus/slack-conversation";

const active: SlackConversation = {
	generation: 3,
	state: "active" as const,
	teamId: "T1",
	channelId: "C1",
	rootTs: "171.1",
	sessionId: "session-1",
	endpointGeneration: 7,
	updatedAt: 1,
	seenEventIds: [],
	seenContextIds: [],
	seenRetryKeys: [],
	seenInteractionIds: [],
};

describe("Slack thread state", () => {
	it("requires the exact active root and endpoint generation", () => {
		expect(acceptsSlackInbound(active, "171.1", 7)).toBe(true);
		expect(acceptsSlackInbound(active, "171.2", 7)).toBe(false);
		expect(acceptsSlackInbound(active, "171.1", 8)).toBe(false);
		expect(acceptsSlackInbound({ ...active, state: "closed_marker" }, "171.1", 7)).toBe(false);
	});

	it("bounds durable identifier-only dedupe fields", () => {
		const ids = Array.from({ length: 140 }, (_, index) => `event-${index}`);
		const normalized = normalizeSlackConversation({
			...active,
			seenEventIds: ids,
			seenContextIds: ids,
			seenRetryKeys: ids,
			seenInteractionIds: ids,
		});
		expect(normalized.seenEventIds).toHaveLength(128);
		expect(normalized.seenEventIds[0]).toBe("event-12");
	});

	it("keys a thread by team, channel, and root only", () => {
		const key = slackConversationKey({ teamId: "T1", channelId: "C1", rootTs: "171.1" });
		expect(key).toBe("T1:C1:171.1");
		expect(key).not.toContain("token");
		expect(key).not.toContain("body");
	});
});
