import { describe, expect, test } from "bun:test";
import { type TopicRecord, TopicRegistry, type TopicRegistryState } from "../src/sdk/bus/topic-registry";

function boundRecord(
	topicId: string,
	authorityEpoch: number,
	authorityState: TopicRecord["authorityState"],
): TopicRecord {
	return {
		topicId,
		topicOrigin: "daemon_created",
		sessionUuid: `session-${topicId}`,
		identitySent: false,
		createdAt: 1,
		authorityEpoch,
		authorityState,
		chatId: "chat",
		endpointKey: "endpoint",
		endpointDigest: "digest",
		endpointIncarnation: 0,
	};
}

function state(topics: Record<string, TopicRecord>, fences: Record<string, number>): TopicRegistryState {
	return { version: 2, registryGeneration: 1, topics, fences };
}

describe("TopicRegistry archive settlement fencing", () => {
	test("a stale result cannot settle a newer archive fence", () => {
		const registry = new TopicRegistry(state({ A: boundRecord("42", 1, "active") }, { A: 1 }));
		expect(registry.beginArchive("A", "host", 1)?.authorityEpoch).toBe(2);
		const staleEpoch = registry.authorityEpoch("A");
		expect(registry.beginArchive("A", "host", 2)?.authorityEpoch).toBe(3);

		expect(registry.settleArchive("A", "42", staleEpoch)).toBe(false);
		expect(registry.get("A")).toMatchObject({ authorityEpoch: 3, authorityState: "archive_pending" });
		expect(registry.sessionForTopic("42")).toBeUndefined();
		expect(registry.isTopicIdAvailable("42")).toBe(false);
	});

	test("a definite result retains inactive authority and its topic-id quarantine", () => {
		const registry = new TopicRegistry(state({ A: boundRecord("42", 1, "archive_pending") }, { A: 1 }));

		expect(registry.settleArchive("A", "42", 1)).toBe(true);
		expect(registry.get("A")).toMatchObject({ topicId: "42", authorityEpoch: 1, authorityState: "inactive" });
		expect(registry.sessionForTopic("42")).toBeUndefined();
		expect(registry.isTopicIdAvailable("42")).toBe(false);
	});

	test("a failed publication restores only its exact archive fence", () => {
		const registry = new TopicRegistry(state({ A: boundRecord("42", 1, "active") }, { A: 1 }));
		const snapshot = registry.captureArchiveAuthority("A");
		expect(registry.beginArchive("A", "host", 1)?.authorityEpoch).toBe(2);
		expect(registry.settleArchive("A", "42", 2)).toBe(true);

		expect(registry.restoreArchiveFence(snapshot)).toBe(true);
		expect(registry.get("A")).toMatchObject({ authorityEpoch: 2, authorityState: "archive_pending" });
		expect(registry.sessionForTopic("42")).toBeUndefined();
	});

	test("a stale rollback cannot reactivate a newer archive generation", () => {
		const registry = new TopicRegistry(state({ A: boundRecord("42", 1, "active") }, { A: 1 }));
		const snapshot = registry.captureArchiveAuthority("A");
		expect(registry.beginArchive("A", "host", 1)?.authorityEpoch).toBe(2);
		expect(registry.settleArchive("A", "42", 2)).toBe(true);
		expect(registry.beginArchive("A", "host", 2)?.authorityEpoch).toBe(3);

		expect(registry.restoreArchiveFence(snapshot)).toBe(false);
		expect(registry.get("A")).toMatchObject({ authorityEpoch: 3, authorityState: "archive_pending" });
	});

	test("saturated authority refuses create, archive, settlement, and rollback", async () => {
		const max = Number.MAX_SAFE_INTEGER;
		const registry = new TopicRegistry(state({ A: boundRecord("42", max, "active") }, { A: max }));
		const snapshot = registry.captureArchiveAuthority("A");
		const absent = new TopicRegistry(state({}, { missing: max }));
		let createCalled = false;

		await expect(
			absent.getOrCreateTopic("missing", async () => {
				createCalled = true;
				return "43";
			}),
		).rejects.toThrow("topic authority epoch is exhausted");
		expect(createCalled).toBe(false);
		expect(registry.beginArchive("A", "host", 1)).toBeUndefined();
		expect(registry.get("A")?.authorityState).toBe("archive_exhausted");
		expect(registry.settleArchive("A", "42", max)).toBe(false);
		expect(registry.restoreArchiveAuthority(snapshot)).toBe(false);
		expect(registry.restoreArchiveFence(snapshot)).toBe(false);
	});
});
