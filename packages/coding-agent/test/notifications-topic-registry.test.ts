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
	test("ignores transient replay generation changes without mutating durable topic authority", async () => {
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
		).toBe("unchanged");
		expect(reg.serialize().topics.s1).toMatchObject({
			telegramBinding: { chatId: "42", transport: "telegram" },
		});
		expect(reg.serialize().topics.s1).not.toHaveProperty("endpointGeneration");
		expect(reg.serialize().topics.s1).not.toHaveProperty("endpointKey");
		expect(reg.serialize().topics.s1).not.toHaveProperty("endpointDigest");
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
	test("restored create claim reconciles by stable Telegram binding instead of endpoint credentials", () => {
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
		expect(reg.reconcileCreateClaim("s1", reg.get("s1"))).toBe(true);
		expect(reg.pendingCreateClaims()).toEqual([]);
	});

	test("retains archived topic records and never recreates physical topics", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");

		reg.beginArchive("s1", undefined, Date.now(), "session_closed");
		expect(reg.get("s1")?.authorityState).toBe("archive_pending");
		expect(reg.sessionForTopic("1")).toBeUndefined();

		await expect(reg.getOrCreateTopic("s1", async () => "2")).rejects.toThrow("topic authority is archive-fenced");
		expect(reg.get("s1")?.topicId).toBe("1");
	});
	test("clears disconnect grace before persisting an archive fence", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");
		expect(reg.markOrphaned("s1", 1_000)).toBe(true);

		reg.beginArchive("s1", undefined, 2_000, "session_closed");
		const snapshot = reg.serialize();

		expect(snapshot.topics.s1).toMatchObject({ authorityState: "archive_pending", orphanedAt: 1_000 });
		expect(snapshot.topics.s1.disconnectGraceExpiresAt).toBeUndefined();
		expect(parseTopicRegistryState(snapshot)).toBeDefined();
	});
	test("drops disconnect grace metadata when a durable fence promotes the record to archive pending", () => {
		const reg = new TopicRegistry({
			version: 2,
			registryGeneration: 1,
			fences: { s1: 2 },
			topics: {
				s1: {
					topicId: "1",
					topicOrigin: "daemon_created",
					identitySent: false,
					createdAt: 1,
					authorityEpoch: 1,
					authorityState: "disconnect_grace",
					orphanedAt: 1_000,
					disconnectGraceExpiresAt: 31_000,
					chatId: "42",
					endpointKey: "ws://s1",
					endpointDigest: "digest-s1",
					endpointGeneration: 1,
				},
			},
		});

		const snapshot = reg.serialize();
		expect(snapshot.topics.s1.authorityState).toBe("archive_pending");
		expect(snapshot.topics.s1.disconnectGraceExpiresAt).toBeUndefined();
		expect(parseTopicRegistryState(snapshot)).toBeDefined();
	});
	test("accepts an archive fence poisoned with a stray grace deadline and heals it on load", () => {
		// v0.12.12–v0.12.17 beginArchive moved disconnect_grace records to
		// archive_pending without clearing disconnectGraceExpiresAt. Rejecting
		// that persisted shape bricked the shared registry: the CAS authority
		// refused every subsequent read and write.
		const poisoned = {
			version: 2,
			registryGeneration: 4056,
			topics: {
				s1: {
					topicId: "14261",
					topicOrigin: "daemon_created",
					sessionUuid: "94fd6b56-a281-455b-b014-2ab3975bfa21",
					identitySent: true,
					createdAt: 1_785_971_485_050,
					orphanedAt: 1_785_991_593_616,
					creationLeaseEpoch: 0,
					authorityEpoch: 1,
					authorityState: "archive_pending",
					chatId: "42",
					endpointKey: "endpoint",
					endpointDigest: "digest",
					endpointGeneration: 1,
					endpointIncarnation: 0,
					archiveHostId: "host-a",
					archiveLeaseEpoch: 1,
					disconnectGraceExpiresAt: 1_785_991_623_616,
				},
			},
		} as unknown as TopicRegistryState;

		const state = parseTopicRegistryState(poisoned);
		expect(state).toBeDefined();

		const reg = new TopicRegistry(state);
		expect(reg.get("s1")).toMatchObject({ topicId: "14261", authorityState: "archive_pending" });
		const snapshot = reg.serialize();
		expect(snapshot.topics.s1.disconnectGraceExpiresAt).toBeUndefined();
		expect(parseTopicRegistryState(snapshot)).toBeDefined();
	});
	test("still rejects disconnect grace records missing the deadline or orphan timestamp", () => {
		const record = {
			topicId: "1",
			topicOrigin: "daemon_created",
			sessionUuid: "94fd6b56-a281-455b-b014-2ab3975bfa22",
			identitySent: false,
			createdAt: 1,
			authorityState: "disconnect_grace",
			orphanedAt: 1_000,
			disconnectGraceExpiresAt: 31_000,
			chatId: "42",
			endpointKey: "endpoint",
			endpointDigest: "digest",
		};
		const stateWith = (patch: object) =>
			({
				version: 2,
				registryGeneration: 1,
				topics: { s1: { ...record, ...patch } },
			}) as unknown as TopicRegistryState;

		expect(parseTopicRegistryState(stateWith({}))).toBeDefined();
		expect(() => parseTopicRegistryState(stateWith({ disconnectGraceExpiresAt: undefined }))).toThrow(
			"malformed Telegram topic state",
		);
		expect(() => parseTopicRegistryState(stateWith({ orphanedAt: undefined }))).toThrow(
			"malformed Telegram topic state",
		);
		expect(() => parseTopicRegistryState(stateWith({ disconnectGraceExpiresAt: "soon" }))).toThrow(
			"malformed Telegram topic state",
		);
		// The archive-family tolerance is scoped: a stray grace deadline on any
		// non-archive state is still rejected, never interpreted as healthy.
		expect(() => parseTopicRegistryState(stateWith({ authorityState: "active" }))).toThrow(
			"malformed Telegram topic state",
		);
		expect(() => parseTopicRegistryState(stateWith({ authorityState: "delete_pending" }))).toThrow(
			"malformed Telegram topic state",
		);
	});

	test("heals legacy closed-endpoint bindings persisted without a transport discriminator", () => {
		// Pre-#4401 writers stored closedEndpoints as bare
		// { chatId, endpointKey, endpointDigest, endpointGeneration } records.
		// Rejecting them bricked the shared CAS authority on every read.
		const stateWithClosed = (binding: object) =>
			({
				version: 2,
				registryGeneration: 1,
				topics: {},
				closedEndpoints: { s1: binding },
			}) as unknown as TopicRegistryState;

		const legacy = {
			chatId: "1824716193",
			endpointKey: "c367bef42406c4b5ab90f21f9e1634a49d6ca3fd8ec66f5cb14f2bd69a551034",
			endpointDigest: "c367bef42406c4b5ab90f21f9e1634a49d6ca3fd8ec66f5cb14f2bd69a551034",
			endpointGeneration: 1,
		};
		const state = parseTopicRegistryState(stateWithClosed(legacy));
		expect(state?.closedEndpoints?.s1).toMatchObject({ chatId: "1824716193", transport: "telegram" });
		// The input snapshot is never mutated; healing is in-memory only.
		expect("transport" in legacy).toBe(false);
		// Healed records are stripped to the durable Telegram binding shape:
		// no SDK endpoint identity (endpointKey/digest/generation) leaks
		// into the healed in-memory record.
		const healed = state?.closedEndpoints?.s1 as unknown as Record<string, unknown>;
		expect(healed.endpointKey).toBeUndefined();
		expect(healed.endpointDigest).toBeUndefined();
		expect(healed.endpointGeneration).toBeUndefined();

		// Partial legacy records (missing endpointDigest/generation) are
		// corruption, not pre-#4401 legacy data, and must stay rejected.
		expect(() => parseTopicRegistryState(stateWithClosed({ chatId: "1", endpointKey: "key" }))).toThrow(
			"malformed Telegram topic state",
		);

		// Truly malformed entries remain rejected.
		expect(() => parseTopicRegistryState(stateWithClosed({ endpointGeneration: 1 }))).toThrow(
			"malformed Telegram topic state",
		);
		expect(() => parseTopicRegistryState(stateWithClosed({ chatId: "1", transport: "discord" }))).toThrow(
			"malformed Telegram topic state",
		);
		// Non-object closedEndpoints (scalar/bool/array) stays rejected: the
		// healing path must not coerce it to {} and bypass fail-closed.
		for (const malformed of [1, true, []]) {
			expect(() =>
				parseTopicRegistryState({
					version: 2,
					registryGeneration: 1,
					topics: {},
					closedEndpoints: malformed,
				} as unknown as TopicRegistryState),
			).toThrow("malformed Telegram topic state");
		}
	});

	test("restores the exact disconnect grace deadline after archive publication fails", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");
		expect(reg.markOrphaned("s1", 1_000)).toBe(true);
		const authority = reg.captureArchiveAuthority("s1");

		reg.beginArchive("s1", undefined, 2_000, "session_closed");
		expect(reg.restoreArchiveAuthority(authority)).toBe(true);
		const snapshot = reg.serialize();

		expect(snapshot.topics.s1).toMatchObject({
			authorityState: "disconnect_grace",
			orphanedAt: 1_000,
			disconnectGraceExpiresAt: 31_000,
		});
		expect(parseTopicRegistryState(snapshot)).toBeDefined();
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
		expect(reg.beginArchive("s1", undefined, Date.now(), "session_closed")).toBeUndefined();
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
					reg.beginArchive("s1", undefined, Date.now(), "session_closed");
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
		reg.beginArchive("s1", undefined, Date.now(), "session_closed");

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
		reg.beginArchive("A", undefined, Date.now(), "session_closed");
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
test("publishes exact durable authority generation 179 at serving epoch 88", () => {
	// Generation 58: parser-valid durable-fence promotion and rollback.
	// Generation 152: a thrown steady heartbeat renewal in the run loop is
	// contained instead of terminating the daemon (#4200).
	// Generation 153: strict orchestration admission fences Telegram topics.
	// Generation 154: private-chat archives dispatch deleteForumTopic, settle
	// TOPIC_ID_INVALID, and drain durable archive retries periodically.
	// Generation 155: unified durable terminal-retention write path (#4329).
	// Generation 156: session eligibility follows configuration, and threaded
	// mode always uses threads instead of refusing a session's own declaration.
	// Generation 157: orphan-topic reconciliation with FORUM_TOPIC_NOT_FOUND
	// settlement and unsupported-method fallback.
	// Generation 158: fences the master-worker lifecycle: older daemons cannot
	// continue serving while this daemon adds or removes master-channel delivery
	// authority.
	// Generation 159: terminal-abort notification admission and cleanup semantics.
	// Generation 160: provider-local Telegram subscription fault containment.
	// Generation 161: durable cleanup/archive receipts and stable topic recovery.
	// Generation 162: detached chat-provider daemon ownership from session lifecycle.
	// Generation 164: auto-reap superseded Telegram daemon owners (#4403).
	// Generation 165: bounded lean settlement windows preserve user receipts.
	// Generation 166: complete owned process-group cleanup, fail-closed watchdog,
	// and daemon-internal orphan-owner reconciliation (#4403).
	// Generation 167: repairs the telegram daemon generation guard bootstrap so
	// the generator's post-fix manifest check byte-compares the regenerated disk
	// manifest against the current tree, and pre-registry legacy stray Telegram
	// daemons are auto-reaped (#4533).
	// Generation 168: adds per-update inbound acknowledgement authority and
	// monotonic reaction settlement for Telegram notification delivery (#4528).
	// Generation 169: delivers every ring-positioned session event live through
	// the bounded, capability-gated directed subscriber leg used by replay.
	// Generation 172 / epoch 88: fences the SessionRouter idle-poll rollout
	// (#4689). The daemon builds a SessionRouter, so a pre-upgrade owner would
	// retain the old per-tick locked index rescan. Generation alone does not
	// force replacement, so the serving epoch advances with it.

	// Generation 174: stale-package broker retirement changes protected daemon
	// launch and discovery authority after dev's generation-173 notification fix.
	// Generation 177: successful autonomous ask lead-ins consume only their exact
	// same-window lean settlement receipts; serving protocol remains epoch 88.
	// Generation 178: idle publication waits for positioned identity delivery to
	// cross the native writer barrier before the independent broadcast lane.
	// Generation 179: refreshes the native filesystem authority boundary used by
	// Paseo setup and recovery.
	expect(DAEMON_GENERATION).toBe(179);
	expect(SERVING_EPOCH).toBe(88);
});
test("archives pending topics into retained inactive records", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic("session", async () => "42", Date.now, undefined, {
		chatId: "42",
		endpointKey: "endpoint",
		endpointDigest: "digest",
		endpointGeneration: 1,
	});

	registry.beginArchive("session", undefined, Date.now(), "session_closed");
	expect(registry.get("session")?.authorityState).toBe("archive_pending");
	expect(registry.settleArchive("session", "42", registry.authorityEpoch("session"), "session_closed")).toBe(true);
	expect(registry.get("session")?.authorityState).toBe("inactive");
	expect(registry.serialize().topics.session?.topicId).toBe("42");
});
test("a stale archive result cannot settle a newer archive fence", async () => {
	const registry = new TopicRegistry();
	await registry.getOrCreateTopic("session", async () => "43");
	expect(registry.beginArchive("session", "host-a", 100, "session_closed")).toBeDefined();
	const dispatchedEpoch = registry.authorityEpoch("session");
	expect(registry.beginArchive("session", "host-a", 101, "session_closed")).toBeDefined();

	expect(registry.settleArchive("session", "43", dispatchedEpoch, "session_closed")).toBe(false);
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
	expect(saturated.beginArchive("session", "host-a", 100, "session_closed")).toBeUndefined();
	expect(saturated.get("session")?.authorityState).toBe("archive_exhausted");
	expect(saturated.settleArchive("session", "45", Number.MAX_SAFE_INTEGER, "session_closed")).toBe(false);
	expect(saturated.archivePendingSessionIds(100)).toEqual([]);
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
	registry.beginArchive("session", undefined, Date.now(), "session_closed");
	for (let attempt = 0; attempt < 9; attempt++) registry.scheduleArchiveRetry("session", attempt, "session_closed");
	expect(registry.get("session")?.authorityState).toBe("archive_pending");
	expect(registry.acquireLease("session", "host", 10, 1_000, 500)).toBe(false);
	expect(registry.archivePendingSessionIds(1_000_000)).toEqual(["session"]);
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
	expect(registry.beginArchive("session", "host-a", 100, "session_closed")).toBeUndefined();
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
	expect(daemonTopic.beginArchive("daemon", "host-b", 101, "session_closed")).toBeUndefined();
	expect(daemonTopic.beginArchive("daemon", "host-b", 1_101, "session_closed")?.archiveHostId).toBe("host-b");
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
	const fenced = registry.fenceAcceptedCreateForLease(
		"session",
		"44",
		0,
		"host-a",
		() => 101,
		undefined,
		binding,
		undefined,
		undefined,
		"create_compensation",
	);
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
	expect(registry.beginArchive("session", "host-a", 101, "session_closed")).toBeDefined();
	expect(registry.settleArchive("session", "45", registry.authorityEpoch("session"), "session_closed")).toBe(true);
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
