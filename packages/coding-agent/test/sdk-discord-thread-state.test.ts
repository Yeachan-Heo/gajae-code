import { describe, expect, test } from "bun:test";
import {
	acceptsDiscordInbound,
	type DiscordConversation,
	discordConversationKey,
} from "../src/sdk/bus/discord-conversation";

function record(): DiscordConversation {
	return {
		generation: 1,
		state: "active",
		appId: "app",
		guildId: "guild",
		parentChannelId: "parent",
		threadId: "thread",
		sessionId: "session",
		endpointGeneration: 4,
		updatedAt: 0,
		seenEventIds: [],
		seenInteractionIds: [],
	};
}

describe("Discord conversation identity", () => {
	test("uses the complete app, guild, parent and thread identity", () => {
		expect(
			discordConversationKey({ appId: "app", guildId: "guild", parentChannelId: "parent", threadId: "thread" }),
		).toBe("app:guild:parent:thread");
	});
	test("rejects stale, superseded, archived and generation-mismatched inbound events", () => {
		const active = record();
		expect(acceptsDiscordInbound(active, "thread", 4)).toBe(true);
		expect(acceptsDiscordInbound(active, "other", 4)).toBe(false);
		expect(acceptsDiscordInbound(active, "thread", 5)).toBe(false);
		expect(acceptsDiscordInbound({ ...active, state: "archived" }, "thread", 4)).toBe(false);
		expect(acceptsDiscordInbound({ ...active, supersededByThreadId: "new" }, "thread", 4)).toBe(false);
	});
});
