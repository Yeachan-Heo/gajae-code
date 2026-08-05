import { describe, expect, test } from "bun:test";
import { DAEMON_GENERATION, SERVING_EPOCH } from "../src/sdk/bus/telegram-daemon-contract";
import { parseTopicRegistryState, TopicRegistry, type TopicRegistryState } from "../src/sdk/bus/topic-registry";

describe("TopicRegistry", () => {
	test("creates a topic once and reuses it on resume", async () => {
		const reg = new TopicRegistry();
		let creates = 0;
		const create = async () => {
			creates++;
			return String(creates);
		};
		const first = await reg.getOrCreateTopic("sess-1", create, () => 1000);
		const second = await reg.getOrCreateTopic("sess-1", create, () => 2000);
		expect(first.topicId).toBe("1");
		expect(second.topicId).toBe("1");
		expect(creates).toBe(1);
		expect(first.createdAt).toBe(1000);
	});

	test("distinct sessions get distinct topics", async () => {
		const reg = new TopicRegistry();
		let n = 0;
		const create = async () => String(++n);
		const a = await reg.getOrCreateTopic("s1", create);
		const b = await reg.getOrCreateTopic("s2", create);
		expect(a.topicId).not.toBe(b.topicId);
	});

	test("identity header is sent exactly once per topic", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");
		expect(reg.needsIdentity("s1")).toBe(true);
		reg.markIdentitySent("s1");
		expect(reg.needsIdentity("s1")).toBe(false);
	});

	test("separates rename detection from successful name commit", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"s1",
			async () => "1",
			() => 1000,
			"GJC abc123",
		);

		expect(reg.needsRename("s1", "repo/main")).toBe(true);
		expect(reg.needsRename("missing", "repo/main")).toBe(false);

		reg.markNameApplied("s1", "repo/main");
		expect(reg.needsRename("s1", "repo/main")).toBe(false);
		expect(reg.get("s1")?.name).toBe("repo/main");
		expect(reg.get("s1")?.nameOwner).toBeUndefined();
	});

	test("user-owned names block daemon renames and survive serialization", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"s1",
			async () => "1",
			() => 1000,
			"repo/main",
			{ chatId: "42", endpointKey: "ws://s1", endpointDigest: "digest-s1", endpointGeneration: 1 },
		);
		reg.markIdentityKey("s1", "repo\0main");

		expect(reg.markUserName("s1", "My focus", 1)).toBe("updated");
		expect(reg.needsRename("s1", "repo/main - Generated title")).toBe(false);
		expect(reg.userOwnedName("s1")).toBe("My focus");
		expect(reg.userNameToReconcile("s1")).toBe("My focus");
		reg.markNameApplied("s1", "repo/main - Generated title");
		expect(reg.userOwnedName("s1")).toBe("My focus");
		expect(reg.markUserName("s1", "Latest focus", 2)).toBe("updated");
		expect(reg.markUserName("s1", "Duplicate focus", 2)).toBe("duplicate");
		expect(reg.markUserName("s1", "Stale focus", 1)).toBe("stale");
		expect(reg.markUserNameReconciled("s1", "My focus")).toBe(false);
		expect(reg.userNameToReconcile("s1")).toBe("Latest focus");
		expect(reg.markUserName("s1", "My focus", 3)).toBe("updated");

		expect(reg.markUserNameReconciled("s1", "My focus")).toBe(true);
		const reloaded = new TopicRegistry(reg.serialize());
		expect(reloaded.userOwnedName("s1")).toBe("My focus");
		expect(reloaded.userNameToReconcile("s1")).toBeUndefined();
		expect(reloaded.get("s1")?.identityKey).toBe("repo\0main");
		expect(reloaded.needsRename("s1", "repo/main - Another title")).toBe(false);
	});

	test.each([
		["empty name", { name: "", userNameUpdateId: 3 }],
		["whitespace name", { name: " \t\n ", userNameUpdateId: 3 }],
		["negative update id", { name: "Blocked name", userNameUpdateId: -1 }],
	])("malformed persisted user authority (%s) falls back to daemon naming", (_name, fields) => {
		const reg = new TopicRegistry({
			topics: {
				bad: {
					topicId: "1",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					chatId: "42",
					endpointKey: "ws://bad",
					endpointDigest: "digest-bad",
					endpointGeneration: 1,
					nameOwner: "user",
					nameReconcilePending: true,
					...fields,
				},
			},
		});
		expect(reg.needsRename("bad", "Generated name")).toBe(true);
		expect(reg.get("bad")?.nameOwner).toBeUndefined();
		expect(reg.get("bad")?.nameReconcilePending).toBeUndefined();
		expect(reg.get("bad")?.userNameUpdateId).toBeUndefined();
	});

	test("legacy user authority without an update id remains user-owned", () => {
		const reg = new TopicRegistry({
			topics: {
				legacy: {
					topicId: "1",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					chatId: "42",
					endpointKey: "ws://legacy",
					endpointDigest: "digest-legacy",
					endpointGeneration: 1,
					nameOwner: "user",
					name: "Missing source id",
				},
			},
		});
		expect(reg.needsRename("legacy", "Generated name")).toBe(false);
		expect(reg.userOwnedName("legacy")).toBe("Missing source id");
	});

	test("retains valid user authority and normalizes legacy name state", () => {
		const reg = new TopicRegistry({
			topics: {
				legacy: {
					topicId: "1",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					chatId: "42",
					endpointKey: "ws://legacy",
					endpointDigest: "digest-legacy",
					endpointGeneration: 1,
					name: "Legacy name",
					userNameUpdateId: 99,
					identityKey: "repo\0legacy",
				},
				user: {
					topicId: "2",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					chatId: "42",
					endpointKey: "ws://user",
					endpointDigest: "digest-user",
					endpointGeneration: 1,
					name: "Preserved name",
					nameOwner: "user",
					nameReconcilePending: true,
					userNameUpdateId: 3,
				},
			},
		});
		expect(reg.needsRename("legacy", "Generated name")).toBe(true);
		expect(reg.get("legacy")?.userNameUpdateId).toBeUndefined();
		expect(reg.get("legacy")?.identityKey).toBe("repo\0legacy");
		expect(reg.markUserName("legacy", "Another user name", 1)).toBe("updated");
		expect(reg.userOwnedName("user")).toBe("Preserved name");
		expect(reg.userNameToReconcile("user")).toBe("Preserved name");
	});

	test("rejects a persisted binding with present malformed evidence", () => {
		const reg = new TopicRegistry({
			topics: {
				s1: {
					topicId: "42",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					chatId: "42",
					endpointKey: "key",
					endpointDigest: "digest",
					endpointGeneration: -1,
				},
			},
		});
		expect(
			reg.bindEndpoint("s1", { chatId: "42", endpointKey: "key", endpointDigest: "digest", endpointGeneration: 1 }),
		).toBe("rejected");
		expect(reg.get("s1")?.bindingMalformed).toBe(true);
	});

	test("retires an unbound legacy topic without validated chat affinity", async () => {
		const reg = new TopicRegistry({
			topics: { s1: { topicId: "42", topicOrigin: "daemon_created", identitySent: false, createdAt: 1 } },
		});
		expect(reg.get("s1")).toBeUndefined();
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(
			reg.bindEndpoint("s1", { chatId: "42", endpointKey: "key", endpointDigest: "digest", endpointGeneration: 1 }),
		).toBe("rejected");
		const fresh = await reg.getOrCreateTopic("s1", async () => "43", Date.now, undefined, {
			chatId: "42",
			endpointKey: "key",
			endpointDigest: "digest",
			endpointGeneration: 1,
		});
		expect(fresh.topicId).toBe("43");
		expect(reg.sessionForTopic("43")).toBe("s1");
	});
	test("rejects a lower replay generation for the same endpoint without mutating durable authority", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42", Date.now, undefined, {
			chatId: "42",
			endpointKey: "endpoint",
			endpointDigest: "digest",
			endpointGeneration: 9,
		});
		expect(
			reg.bindEndpoint("s1", {
				chatId: "42",
				endpointKey: "endpoint",
				endpointDigest: "digest",
				endpointGeneration: 9,
			}),
		).toBe("unchanged");
		expect(
			reg.bindEndpoint("s1", {
				chatId: "42",
				endpointKey: "endpoint",
				endpointDigest: "digest",
				endpointGeneration: 8,
			}),
		).toBe("rejected");
		expect(reg.serialize().topics.s1).toMatchObject({
			endpointGeneration: 9,
			endpointKey: "endpoint",
			endpointDigest: "digest",
		});
	});

	test("resolves session for a topic id (inbound routing)", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "99");
		expect(reg.sessionForTopic("99")).toBe("s1");
		expect(reg.sessionForTopic("nope")).toBeUndefined();
	});

	test("retires an unbound persisted topic across restart", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"s1",
			async () => "1",
			() => 5,
		);
		reg.markIdentitySent("s1");
		const reloaded = new TopicRegistry(reg.serialize());

		expect(reloaded.get("s1")).toBeUndefined();
		expect(reloaded.sessionForTopic("1")).toBeUndefined();
		const fresh = await reloaded.getOrCreateTopic("s1", async () => "2", Date.now, undefined, {
			chatId: "42",
			endpointKey: "key",
			endpointDigest: "digest",
			endpointGeneration: 1,
		});
		expect(fresh.topicId).toBe("2");
	});
	test("persists a monotonic SDK replay cursor across daemon restarts", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1", Date.now, undefined, {
			chatId: "42",
			endpointKey: "ws://s1",
			endpointDigest: "digest-s1",
			endpointGeneration: 1,
		});
		expect(reg.replayCursor("s1")).toBeUndefined();
		expect(reg.markReplayCursor("s1", 2, 7)).toBe(true);
		expect(reg.markReplayCursor("s1", 2, 6)).toBe(false);
		expect(reg.markReplayCursor("s1", 1, 99)).toBe(false);

		const reloaded = new TopicRegistry(reg.serialize());
		expect(reloaded.replayCursor("s1")).toEqual({ generation: 2, seq: 7 });
		expect(reloaded.markReplayCursor("s1", 3, 1)).toBe(true);
		expect(reloaded.replayCursor("s1")).toEqual({ generation: 3, seq: 1 });
	});

	test("concurrent getOrCreateTopic for one session creates exactly one topic (no race)", async () => {
		const reg = new TopicRegistry();
		let creates = 0;
		const create = async () => {
			creates++;
			await new Promise(r => setTimeout(r, 5));
			return String(creates);
		};
		// identity + idle + turn frames all first-touch the session concurrently.
		const results = await Promise.all([
			reg.getOrCreateTopic("s1", create),
			reg.getOrCreateTopic("s1", create),
			reg.getOrCreateTopic("s1", create),
		]);
		expect(creates).toBe(1);
		expect(results.map(r => r.topicId)).toEqual(["1", "1", "1"]);
		expect(reg.sessionForTopic("1")).toBe("s1");
	});
	test("restored durable create claim blocks a second remote create", async () => {
		const state: TopicRegistryState = {
			version: 2,
			topics: {},
			createClaims: {
				s1: { sessionId: "s1", authorityEpoch: 0, createdAt: 1 },
			},
		};
		const reg = new TopicRegistry(state);
		let creates = 0;
		await expect(
			reg.getOrCreateTopic("s1", async () => {
				creates++;
				return "2";
			}),
		).rejects.toThrow("topic create claim requires reconciliation");
		expect(creates).toBe(0);
		expect(reg.pendingCreateClaims()).toEqual([{ sessionId: "s1", authorityEpoch: 0, createdAt: 1 }]);
	});
	test("restored create claim rejects different active binding evidence", () => {
		const claimBinding = {
			chatId: "42",
			endpointKey: "old-key",
			endpointDigest: "old-digest",
			endpointGeneration: 1,
		};
		const reg = new TopicRegistry({
			version: 2,
			topics: {
				s1: {
					topicId: "9",
					topicOrigin: "daemon_created",
					sessionUuid: "00000000-0000-4000-8000-000000000009",
					identitySent: false,
					createdAt: 1,
					authorityEpoch: 0,
					authorityState: "active",
					chatId: "42",
					endpointKey: "new-key",
					endpointDigest: "new-digest",
					endpointGeneration: 1,
					endpointIncarnation: 0,
				},
			},
			createClaims: {
				s1: { sessionId: "s1", authorityEpoch: 0, createdAt: 1, binding: claimBinding },
			},
		});
		expect(reg.reconcileCreateClaim("s1", reg.get("s1"))).toBe(false);
		expect(reg.pendingCreateClaims()).toEqual([
			{ sessionId: "s1", authorityEpoch: 0, createdAt: 1, binding: claimBinding },
		]);
	});

	test("retains archived topic records and never recreates physical topics", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");

		reg.beginArchive("s1");
		expect(reg.get("s1")?.authorityState).toBe("archive_pending");
		expect(reg.sessionForTopic("1")).toBeUndefined();

		await expect(reg.getOrCreateTopic("s1", async () => "2")).rejects.toThrow("topic authority is archive-fenced");
		expect(reg.get("s1")?.topicId).toBe("1");
	});
	test.each([
		["empty", ""],
		["non-decimal", "1e2"],
		["zero", "0"],
		["negative", "-1"],
		["non-safe", "9007199254740992"],
	])("rejects malformed persisted topic ids (%s)", (_name, topicId) => {
		const state = {
			topics: { bad: { topicId, identitySent: false, createdAt: 1 } },
		} as unknown as TopicRegistryState;
		const reg = new TopicRegistry(state);
		expect(reg.get("bad")).toBeUndefined();
		expect(reg.sessionForTopic(topicId)).toBeUndefined();
	});

	test.each([
		"",
		"1e2",
		"0",
		"-1",
		"9007199254740992",
		1,
		null,
	])("rejects malformed create callback topic id (%p)", async topicId => {
		const reg = new TopicRegistry();
		await expect(reg.getOrCreateTopic("bad", async () => topicId)).rejects.toThrow(
			"createForumTopic: invalid message_thread_id",
		);
		expect(reg.get("bad")).toBeUndefined();
	});
	test("retains an accepted revoked create as a durable delete fence", async () => {
		const reg = new TopicRegistry();
		const created = Promise.withResolvers<string>();
		const create = reg.getOrCreateTopic("s1", () => created.promise);
		expect(reg.beginArchive("s1")).toBeUndefined();
		created.resolve("42");
		await expect(create).rejects.toThrow("topic authority was revoked during creation");
		expect(reg.get("s1")).toMatchObject({ topicId: "42", authorityState: "archive_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.serialize().topics.s1).toMatchObject({ topicId: "42", authorityState: "archive_pending" });
	});
	test("never activates a staged topic whose authority is revoked during durable commit", async () => {
		const reg = new TopicRegistry();
		await expect(
			reg.getOrCreateTopic(
				"s1",
				async () => "42",
				Date.now,
				undefined,
				undefined,
				async () => {
					reg.beginArchive("s1");
				},
			),
		).rejects.toThrow("topic authority was revoked during creation");
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.get("s1")).toMatchObject({ topicId: "42", authorityState: "archive_pending" });
		expect(reg.serialize().topics.s1).toMatchObject({ topicId: "42", authorityState: "archive_pending" });
	});
	test("retains a delete-pending record and epoch without restoring its inbound route", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42", Date.now, undefined, {
			chatId: "42",
			endpointKey: "ws://s1",
			endpointDigest: "digest-s1",
			endpointGeneration: 1,
		});
		reg.beginArchive("s1");

		const reloaded = new TopicRegistry(reg.serialize());

		expect(reloaded.get("s1")).toMatchObject({ topicId: "42", authorityState: "archive_pending" });
		expect(reloaded.sessionForTopic("42")).toBeUndefined();
		await expect(reloaded.getOrCreateTopic("s1", async () => "43")).rejects.toThrow(
			"topic authority is archive-fenced",
		);
	});
	test("fails closed after restart when a durable fence supersedes an active record epoch", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42", Date.now, undefined, {
			chatId: "42",
			endpointKey: "ws://s1",
			endpointDigest: "digest-s1",
			endpointGeneration: 1,
		});
		const snapshot = reg.serialize();
		snapshot.fences = { s1: (snapshot.topics.s1.authorityEpoch ?? 0) + 1 };

		const reloaded = new TopicRegistry(snapshot);

		expect(reloaded.get("s1")).toMatchObject({ topicId: "42", authorityState: "archive_pending" });
		expect(reloaded.sessionForTopic("42")).toBeUndefined();
	});
	test("rebuilds inbound routes from merged records on repeated load", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42", Date.now, undefined, {
			chatId: "42",
			endpointKey: "ws://s1",
			endpointDigest: "digest-s1",
			endpointGeneration: 1,
		});
		expect(reg.sessionForTopic("42")).toBe("s1");

		reg.load({
			topics: {
				s1: {
					topicId: "42",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					chatId: "42",
					endpointKey: "ws://s1",
					endpointDigest: "digest-s1",
					endpointGeneration: 1,
					authorityState: "delete_pending",
				},
			},
		});

		expect(reg.get("s1")).toMatchObject({ authorityState: "archive_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
	});
	test.each([
		["active then fenced", ["active", "fenced"]],
		["fenced then active", ["fenced", "active"]],
	] as const)("fails closed for an active and delete-pending topic collision (%s)", (_name, order) => {
		const reg = new TopicRegistry();
		for (const sessionId of order) {
			reg.load({
				topics: {
					[sessionId]: {
						topicId: "42",
						topicOrigin: "daemon_created",
						identitySent: false,
						createdAt: 1,
						chatId: "42",
						endpointKey: `ws://${sessionId}`,
						endpointDigest: `digest-${sessionId}`,
						endpointGeneration: 1,
						...(sessionId === "fenced" ? { authorityState: "delete_pending" as const } : {}),
					},
				},
			});
		}

		expect(reg.get("active")?.authorityState).toBe("active");
		expect(reg.get("fenced")).toMatchObject({ authorityState: "archive_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
	});
	test("failed close restore retains a topic-id collision quarantine", async () => {
		const reg = new TopicRegistry();
		const binding = (sessionId: string) => ({
			chatId: "42",
			endpointKey: `ws://${sessionId}`,
			endpointDigest: `digest-${sessionId}`,
			endpointGeneration: 1,
		});
		await reg.getOrCreateTopic("A", async () => "42", Date.now, undefined, binding("A"));
		const snapshot = reg.captureArchiveAuthority("A");
		reg.beginArchive("A");
		await reg.getOrCreateTopic("B", async () => "42", Date.now, undefined, binding("B"));

		expect(reg.restoreArchiveAuthority(snapshot)).toBe(true);
		expect(reg.sessionForTopic("42")).toBeUndefined();
	});
});

test("distinguishes absent, unique, and ambiguous endpoint authority", async () => {
	const reg = new TopicRegistry();
	const binding = { chatId: "42", endpointKey: "ws://endpoint", endpointDigest: "digest", endpointGeneration: 1 };

	expect(reg.endpointAuthority(binding)).toEqual({ state: "none" });
	await reg.getOrCreateTopic("A", async () => "1", Date.now, undefined, binding);
	expect(reg.endpointAuthority(binding)).toEqual({ state: "unique", sessionId: "A" });
	await reg.getOrCreateTopic("B", async () => "2", Date.now, undefined, binding);
	expect(reg.endpointAuthority(binding)).toEqual({ state: "ambiguous" });
});

test("preserves a no-provenance endpoint claim before a held create can stage its record", async () => {
	const reg = new TopicRegistry();
	const binding = { chatId: "42", endpointKey: "ws://endpoint", endpointDigest: "digest", endpointGeneration: 1 };
	const create = Promise.withResolvers<string>();
	const creating = reg.getOrCreateTopic("B", () => create.promise, Date.now, undefined, binding);

	expect(reg.endpointAuthority(binding)).toEqual({ state: "ambiguous" });
	create.resolve("2");
	await creating;
	expect(reg.endpointAuthority(binding)).toEqual({ state: "unique", sessionId: "B" });
});
test("publishes generation 51 at serving epoch 5", () => {
	expect(DAEMON_GENERATION).toBe(51);
	expect(SERVING_EPOCH).toBe(5);
});
test("archives pending topics into retained inactive records", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic("session", async () => "42", Date.now, undefined, {
		chatId: "42",
		endpointKey: "endpoint",
		endpointDigest: "digest",
		endpointGeneration: 1,
	});

	registry.beginArchive("session");
	expect(registry.get("session")?.authorityState).toBe("archive_pending");
	expect(registry.settleArchive("session", "42", registry.authorityEpoch("session"))).toBe(true);
	expect(registry.get("session")?.authorityState).toBe("inactive");
	expect(registry.serialize().topics.session?.topicId).toBe("42");
});
test("a stale archive result cannot settle a newer archive fence", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic("session", async () => "43");
	expect(registry.beginArchive("session", "host-a", 100)).toBeDefined();
	const dispatchedEpoch = registry.authorityEpoch("session");
	expect(registry.beginArchive("session", "host-a", 101)).toBeDefined();

	expect(registry.settleArchive("session", "43", dispatchedEpoch)).toBe(false);
	expect(registry.get("session")).toMatchObject({
		topicId: "43",
		authorityState: "archive_pending",
		authorityEpoch: dispatchedEpoch + 1,
	});
});

test("saturated authority epochs fail closed for create, archive, and settlement", async () => {
	const absent = new TopicRegistry({
		version: 2,
		registryGeneration: 1,
		topics: {},
		fences: { absent: Number.MAX_SAFE_INTEGER },
	});
	await expect(absent.getOrCreateTopic("absent", async () => "44")).rejects.toThrow(
		"topic authority epoch is exhausted",
	);

	const saturated = new TopicRegistry({
		version: 2,
		registryGeneration: 1,
		topics: {
			session: {
				topicId: "45",
				topicOrigin: "daemon_created",
				sessionUuid: "session-uuid",
				identitySent: false,
				createdAt: 1,
				authorityEpoch: Number.MAX_SAFE_INTEGER,
				authorityState: "active",
				chatId: "42",
				endpointKey: "endpoint",
				endpointDigest: "digest",
			},
		},
		fences: { session: Number.MAX_SAFE_INTEGER },
	});
	expect(saturated.beginArchive("session", "host-a", 100)).toBeUndefined();
	expect(saturated.get("session")?.authorityState).toBe("archive_exhausted");
	expect(saturated.settleArchive("session", "45", Number.MAX_SAFE_INTEGER)).toBe(false);
	expect(saturated.archivePendingSessionIds(100)).toEqual(["session"]);
});

test("rejects future topic registry versions and quarantines retained legacy records", () => {
	expect(() => parseTopicRegistryState({ version: 3, topics: {} })).toThrow("unsupported future Telegram topic state");

	const state = parseTopicRegistryState({
		topics: {
			legacy: {
				topicId: "42",
				topicOrigin: "daemon_created",
				identitySent: true,
				createdAt: 1,
				chatId: "42",
				endpointKey: "endpoint",
				endpointDigest: "digest",
			},
		},
	})!;
	const registry = new TopicRegistry(state);

	expect(registry.get("legacy")).toMatchObject({ topicId: "42", authorityState: "legacy_quarantined" });
	expect(registry.sessionForTopic("42")).toBeUndefined();
});
test("fences a concurrent host and permits same-topic resume only before grace expiry", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic(
		"session",
		async () => "42",
		() => 100,
	);
	expect(registry.acquireLease("session", "host-a", 100, 1_000, 500)).toBe(true);
	expect(registry.acquireLease("session", "host-b", 200, 1_000, 500)).toBe(false);
	expect(registry.releaseLeaseToGrace("session", "host-a", 300, 500)).toBe(true);
	expect(registry.acquireLease("session", "host-a", 700, 1_000, 500)).toBe(true);
	expect(registry.releaseLeaseToGrace("session", "host-a", 800, 500)).toBe(true);
	expect(registry.acquireLease("session", "host-a", 1_301, 1_000, 500)).toBe(false);
});

test("retains lease identity and registry generation across serialization", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic("session", async () => "42", Date.now, undefined, {
		chatId: "42",
		endpointKey: "endpoint",
		endpointDigest: "digest",
	});
	expect(registry.acquireLease("session", "host-a", 100, 1_000, 500)).toBe(true);
	registry.markRegistryPublished(4);
	const restored = new TopicRegistry(registry.serialize());
	expect(restored.registryVersion()).toBe(4);
	expect(restored.get("session")).toMatchObject({
		sessionUuid: expect.any(String),
		leaseOwner: "host-a",
		leaseHeartbeatAt: 100,
		leaseExpiresAt: 1_100,
	});
});
test("terminal archive states cannot be revived by lease or orphan transitions", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic(
		"session",
		async () => "42",
		() => 0,
		undefined,
		{
			chatId: "42",
			endpointKey: "endpoint",
			endpointDigest: "digest",
		},
	);
	registry.beginArchive("session");
	for (let attempt = 0; attempt < 9; attempt++) registry.scheduleArchiveRetry("session", attempt);
	expect(registry.get("session")?.authorityState).toBe("archive_pending");
	expect(registry.acquireLease("session", "host", 10, 1_000, 500)).toBe(false);
	expect(registry.archivePendingSessionIds(70_000)).toEqual(["session"]);
	expect(registry.archiveExhaustedSessionIds()).toEqual([]);
	expect(registry.markOrphaned("session", 10)).toBe(false);
	expect(registry.clearOrphaned("session")).toBe(false);
	await expect(registry.getOrCreateTopic("session", async () => "43")).rejects.toThrow("archive-fenced");
});
test("durably publishes a pre-create claim before invoking the remote creator", async () => {
	const registry = new TopicRegistry();
	const commit = Promise.withResolvers<void>();
	let createCalled = false;
	const creating = registry.getOrCreateTopic(
		"session",
		async () => {
			createCalled = true;
			return "42";
		},
		() => 100,
		"topic",
		{ chatId: "42", endpointKey: "endpoint", endpointDigest: "digest" },
		() => commit.promise,
	);
	await Promise.resolve();
	expect(createCalled).toBe(false);
	expect(registry.serialize().createClaims?.session).toMatchObject({
		sessionId: "session",
		authorityEpoch: 0,
		createdAt: 100,
	});
	commit.resolve();
	await creating;
	expect(createCalled).toBe(true);
	expect(registry.serialize().createClaims?.session).toBeUndefined();
});
test("retains adopted topics and rejects an unexpired foreign archive owner", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic(
		"session",
		async () => "42",
		() => 100,
		undefined,
		{ chatId: "42", endpointKey: "endpoint", endpointDigest: "digest" },
		undefined,
		undefined,
		"user_created",
	);
	expect(registry.beginArchive("session", "host-a", 100)).toBeUndefined();
	expect(registry.serialize().topics.session?.topicOrigin).toBe("user_created");

	const daemonTopic = new TopicRegistry();
	await daemonTopic.getOrCreateTopic(
		"daemon",
		async () => "43",
		() => 100,
		undefined,
		{ chatId: "42", endpointKey: "endpoint-2", endpointDigest: "digest-2" },
	);
	expect(daemonTopic.acquireLease("daemon", "host-a", 100, 1_000, 0)).toBe(true);
	expect(daemonTopic.beginArchive("daemon", "host-b", 101)).toBeUndefined();
	expect(daemonTopic.beginArchive("daemon", "host-b", 1_101)?.archiveHostId).toBe("host-b");
	expect(daemonTopic.archiveAuthorityAllows("daemon", "host-b", 1_101)).toBe(true);
});
test("accepted-create compensation publishes exact host and archive epoch authority", async () => {
	const registry = new TopicRegistry();
	const binding = { chatId: "42", endpointKey: "endpoint", endpointDigest: "digest", endpointGeneration: 1 };
	await registry.getOrCreateTopic(
		"session",
		async () => "44",
		() => 100,
		undefined,
		binding,
	);
	const fenced = registry.fenceAcceptedCreateForLease("session", "44", 0, "host-a", () => 101, undefined, binding);
	expect(fenced).toMatchObject({
		topicId: "44",
		authorityState: "archive_pending",
		archiveHostId: "host-a",
		archiveLeaseEpoch: 1,
		authorityEpoch: 1,
	});
	expect(registry.archiveAuthorityAllows("session", "host-a", 101)).toBe(true);
	expect(registry.archiveAuthorityAllows("session", "host-b", 101)).toBe(false);
});

test("retains inactive predecessor evidence when an authenticated successor rotates", async () => {
	const registry = new TopicRegistry();
	const original = { chatId: "42", endpointKey: "old", endpointDigest: "old-digest", endpointGeneration: 1 };
	await registry.getOrCreateTopic(
		"session",
		async () => "45",
		() => 100,
		undefined,
		original,
	);
	expect(registry.beginArchive("session", "host-a", 101)).toBeDefined();
	expect(registry.settleArchive("session", "45", registry.authorityEpoch("session"))).toBe(true);
	expect(
		registry.retireInactiveEndpointForSuccessor("session", {
			chatId: "42",
			endpointKey: "new",
			endpointDigest: "new-digest",
			endpointGeneration: 2,
		}),
	).toBe(true);
	const serialized = registry.serialize();
	expect(serialized.topics.session).toBeUndefined();
	expect(serialized.retiredTopics?.session).toEqual([
		expect.objectContaining({
			topicId: "45",
			topicOrigin: "daemon_created",
			authorityState: "inactive",
			archiveHostId: "host-a",
		}),
	]);
	expect(new TopicRegistry(serialized).serialize().retiredTopics).toEqual(serialized.retiredTopics);
});
