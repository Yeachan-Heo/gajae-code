import { describe, expect, test } from "bun:test";
import { TopicRegistry, type TopicRegistryState, type TopicSettledDelete } from "../src/sdk/bus/topic-registry";

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

/** Narrow an accepted phase-1 settlement without weakening the refusal contract. */
const requireSettled = (settled: TopicSettledDelete | undefined): TopicSettledDelete => {
	if (!settled) throw new Error("expected the settlement to be accepted");
	return settled;
};

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

		const settled = requireSettled(reg.settleDelete("A", "42", reg.authorityEpoch("A")));
		expect(reg.commitSettledDelete(settled)).toBe(true);

		// Once the record is gone and its clear is durable, its topic id no longer
		// collides, so it becomes adoptable and routable without a daemon restart.
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
		expect(reg.settleDelete("A", "42", dispatchedEpochE1)).toBeUndefined();

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
		expect(reg.settleDelete("A", "42", dispatchedEpochE2)).toBeDefined();
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
		const settled = requireSettled(reg.settleDelete("A", "42", reg.authorityEpoch("A")));
		expect(reg.commitSettledDelete(settled)).toBe(true);

		// The committed clear rebuilt derived routes, so the surviving colliding
		// record is now routable.
		expect(reg.sessionForTopic("42")).toBe("B");

		// A later close-path publication fails and the delete fence is reinstated.
		expect(reg.restoreDeleteFence(snapshot)).toBe(true);

		// The restored fence must re-quarantine the topic id; inbound routing to the
		// collision partner must not stay open.
		expect(reg.get("A")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(false);
	});

	test("authority epochs saturate at the safe-integer bound and a saturated fence refuses settlement", () => {
		const max = Number.MAX_SAFE_INTEGER;
		const state: TopicRegistryState = {
			topics: { A: boundRecord("A", "42", max, false) },
			fences: { A: max },
		};
		const reg = new TopicRegistry(state);
		expect(reg.authorityEpoch("A")).toBe(max);

		// Fencing at the bound must not produce MAX_SAFE_INTEGER + 1: that value is
		// not a safe integer and compares equal to its own successor, so it could
		// never distinguish one delete generation from the next.
		expect(reg.beginDelete("A")?.authorityEpoch).toBe(max);
		expect(reg.authorityEpoch("A")).toBe(max);
		expect(Number.isSafeInteger(reg.authorityEpoch("A"))).toBe(true);
		expect(reg.serialize().fences?.A).toBe(max);

		// A saturated epoch can no longer prove exclusive authority, so settlement
		// fails closed: the fence and the topic-id quarantine are both retained.
		expect(reg.settleDelete("A", "42", max)).toBeUndefined();
		expect(reg.get("A")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reg.isTopicIdAvailable("42")).toBe(false);

		// Dispatched epochs that are not non-negative safe integers are rejected
		// outright rather than compared numerically.
		expect(reg.settleDelete("A", "42", max + 1)).toBeUndefined();
		expect(reg.settleDelete("A", "42", -1)).toBeUndefined();
		expect(reg.settleDelete("A", "42", Number.NaN)).toBeUndefined();
		expect(reg.settleDelete("A", "42", 1.5)).toBeUndefined();
	});

	test("a rollback refuses any settlement whose post-settlement state no longer holds", async () => {
		const reg = new TopicRegistry({ topics: { A: boundRecord("A", "42", 1, true) }, fences: { A: 1 } });
		const settled = requireSettled(reg.settleDelete("A", "42", reg.authorityEpoch("A")));

		// A concurrent re-fence advances the session epoch past the settlement, so
		// the settled state is no longer the state a rollback would be undoing.
		reg.beginDelete("A");
		expect(reg.authorityEpoch("A")).toBe(settled.settledEpoch + 1);

		expect(reg.rollbackSettledDelete(settled)).toBe(false);
		// The stale record must not resurrect and must not clobber the newer fence.
		expect(reg.get("A")).toBeUndefined();
		expect(reg.authorityEpoch("A")).toBe(settled.settledEpoch + 1);
		// Fail closed: the clear is still unpublished, so the id stays quarantined.
		expect(reg.isTopicIdAvailable("42")).toBe(false);

		// A record recreated for the same session while the clear is still in flight
		// is likewise not the post-settlement state a rollback may undo.
		const reg2 = new TopicRegistry({ topics: { A: boundRecord("A", "42", 1, true) }, fences: { A: 1 } });
		const settled2 = requireSettled(reg2.settleDelete("A", "42", reg2.authorityEpoch("A")));
		await reg2.getOrCreateTopic(
			"A",
			async () => "43",
			() => 2,
			undefined,
			binding("A"),
		);
		expect(reg2.authorityEpoch("A")).toBe(settled2.settledEpoch);
		expect(reg2.rollbackSettledDelete(settled2)).toBe(false);
		expect(reg2.get("A")).toMatchObject({ topicId: "43" });
		expect(reg2.get("A")?.authorityState).toBeUndefined();
	});

	test("a settled delete keeps its topic id quarantined until the clear is durable", async () => {
		const reg = new TopicRegistry({ topics: { A: boundRecord("A", "42", 1, true) }, fences: { A: 1 } });
		const settled = requireSettled(reg.settleDelete("A", "42", reg.authorityEpoch("A")));

		// Phase 1 drops the record but must not publish routes: the clear lives only
		// in memory, so the id is neither adoptable nor routable during the write.
		expect(reg.get("A")).toBeUndefined();
		expect(reg.isTopicIdAvailable("42")).toBe(false);
		expect(reg.sessionForTopic("42")).toBeUndefined();

		// An adopt racing the held write is admitted as a record but stays unrouted,
		// so nothing is delivered against a clear that may still roll back.
		await reg.getOrCreateTopic(
			"B",
			async () => "42",
			() => 2,
			undefined,
			binding("B"),
		);
		expect(reg.sessionForTopic("42")).toBeUndefined();

		// Phase 2 publishes routes only once the clear is durable.
		expect(reg.commitSettledDelete(settled)).toBe(true);
		expect(reg.sessionForTopic("42")).toBe("B");
		expect(reg.isTopicIdAvailable("42")).toBe(false);
	});

	test("a refused settlement yields no rollback token, so it cannot restore anything", () => {
		// The persisted fence is newer than the record's own authority, so this
		// dispatched epoch never owned the fence and settlement must be refused.
		const reg = new TopicRegistry({ topics: { A: boundRecord("A", "42", 1, true) }, fences: { A: 2 } });
		expect(reg.settleDelete("A", "42", 1)).toBeUndefined();

		// Refusal is total: fence, record and quarantine are intact, and no token
		// exists for any caller to hand back to a rollback.
		expect(reg.get("A")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reg.authorityEpoch("A")).toBe(2);
		expect(reg.isTopicIdAvailable("42")).toBe(false);
		expect(reg.sessionForTopic("42")).toBeUndefined();
	});
});
