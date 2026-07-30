import { describe, expect, test } from "bun:test";
import { TopicRegistry, type TopicRegistryState } from "../src/sdk/bus/topic-registry";

/**
 * A crash mid-close leaves a `delete_pending` record on disk. Loading it
 * quarantines its topic id so no stale route survives. Once the delete settles
 * definitely, the quarantine must be released: the id is no longer claimed by
 * any record, so a later adoption of that same user-created Telegram topic has
 * to be routable in the same daemon process, exactly as it is after a restart.
 */
describe("TopicRegistry settled delete", () => {
	const fencedState = (): TopicRegistryState => ({
		topics: {
			closing: {
				topicId: "42",
				identitySent: true,
				createdAt: 1,
				topicOrigin: "user_created",
				authorityState: "delete_pending",
				authorityEpoch: 1,
				chatId: "77",
				endpointKey: "ws://closing",
				endpointDigest: "digest-closing",
				endpointGeneration: 1,
			},
		},
		fences: { closing: 1 },
	});

	const resumedBinding = {
		chatId: "77",
		endpointKey: "ws://resumed",
		endpointDigest: "digest-resumed",
		endpointGeneration: 1,
	};

	test("releases the topic-id quarantine so a re-adopted user topic routes inbound", async () => {
		const reg = new TopicRegistry(fencedState());
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(false);

		expect(reg.settleDelete("closing", "42")).toBe(true);
		expect(reg.get("closing")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(true);

		const adopted = await reg.getOrCreateTopic(
			"resumed",
			async () => "42",
			() => 2,
			undefined,
			resumedBinding,
			undefined,
			undefined,
			"user_created",
		);
		expect(adopted.topicId).toBe("42");
		expect(reg.sessionForTopic("42")).toBe("resumed");
		expect(reg.endpointAuthority(resumedBinding)).toEqual({ state: "unique", sessionId: "resumed" });
	});

	test("routes an adopted topic identically before and after a restart reload", async () => {
		const live = new TopicRegistry(fencedState());
		expect(live.settleDelete("closing", "42")).toBe(true);
		await live.getOrCreateTopic(
			"resumed",
			async () => "42",
			() => 2,
			undefined,
			resumedBinding,
			undefined,
			undefined,
			"user_created",
		);

		const reloaded = new TopicRegistry(live.serialize());
		expect(reloaded.sessionForTopic("42")).toBe("resumed");
		expect(live.sessionForTopic("42")).toBe(reloaded.sessionForTopic("42"));
	});
});
