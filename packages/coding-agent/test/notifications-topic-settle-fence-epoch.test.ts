import { describe, expect, test } from "bun:test";
import { TopicRegistry, type TopicRegistryState } from "../src/sdk/bus/topic-registry";

const binding = (sessionId: string) => ({
	chatId: "42",
	endpointKey: `ws://${sessionId}`,
	endpointDigest: `digest-${sessionId}`,
	endpointGeneration: 1,
});

/** A persisted record with a complete endpoint binding (pre-binding records are retired on load). */
const boundRecord = (sessionId: string, topicId: string, authorityEpoch: number, fenced: boolean) => ({
	topicId,
	identitySent: false,
	createdAt: 1,
	authorityEpoch,
	...binding(sessionId),
	...(fenced ? { authorityState: "delete_pending" as const } : {}),
});

describe("TopicRegistry delete settlement fencing", () => {
	test("a settled delete releases the topic-id quarantine so a re-adopted topic routes inbound", async () => {
		const state: TopicRegistryState = {
			topics: { A: boundRecord("A", "42", 1, true) },
			fences: { A: 1 },
		};
		const reg = new TopicRegistry(state);

		// The delete-pending record quarantines its topic id: not routable, not adoptable.
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(false);

		expect(reg.settleDelete("A", "42", reg.authorityEpoch("A"))).toBe(true);

		// Once the record is gone its topic id no longer collides, so it becomes
		// adoptable and routable without waiting for a daemon restart.
		expect(reg.get("A")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(true);
		await reg.getOrCreateTopic(
			"B",
			async () => "42",
			() => 2,
			undefined,
			binding("B"),
		);
		expect(reg.sessionForTopic("42")).toBe("B");
	});

	test("a stale E1 settlement cannot settle the newer E2 delete fence for the same session and topic", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"A",
			async () => "42",
			() => 1,
			undefined,
			binding("A"),
		);

		// E1 fences the session and dispatches its remote delete under this epoch.
		reg.beginDelete("A");
		const dispatchedEpochE1 = reg.authorityEpoch("A");

		// Before E1's definite result arrives, a scan/close-started E2 delete
		// re-fences the same session and topic, superseding E1's authority.
		reg.beginDelete("A");
		const dispatchedEpochE2 = reg.authorityEpoch("A");
		expect(dispatchedEpochE2).toBeGreaterThan(dispatchedEpochE1);

		// E1's definite result must not settle E2's fence.
		expect(reg.settleDelete("A", "42", dispatchedEpochE1)).toBe(false);

		// E2's delete_pending record and its quarantine survive intact.
		expect(reg.get("A")).toMatchObject({
			topicId: "42",
			authorityState: "delete_pending",
			authorityEpoch: dispatchedEpochE2,
		});
		expect(reg.authorityEpoch("A")).toBe(dispatchedEpochE2);
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(false);

		// The owning E2 epoch still settles normally.
		expect(reg.settleDelete("A", "42", dispatchedEpochE2)).toBe(true);
	});

	test("restoring the delete fence after a failed persist re-quarantines a colliding topic id", () => {
		// Persisted active+pending collision: B is active on the same topic id that
		// delete-pending A still holds, so the id is ambiguous and routes nowhere.
		const state: TopicRegistryState = {
			topics: { A: boundRecord("A", "42", 1, true), B: boundRecord("B", "42", 0, false) },
			fences: { A: 1 },
		};
		const reg = new TopicRegistry(state);
		expect(reg.sessionForTopic("42")).toBeUndefined();

		const snapshot = reg.captureDeleteAuthority("A");
		expect(reg.settleDelete("A", "42", reg.authorityEpoch("A"))).toBe(true);

		// Settlement rebuilt derived routes, so the surviving colliding record is now routable.
		expect(reg.sessionForTopic("42")).toBe("B");

		// The final topic-state persist fails and the delete fence is reinstated.
		expect(reg.restoreDeleteFence(snapshot)).toBe(true);

		// The restored fence must re-quarantine the topic id; inbound routing to the
		// collision partner must not stay open.
		expect(reg.get("A")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(false);
	});
});
