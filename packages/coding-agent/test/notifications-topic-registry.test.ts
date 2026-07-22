import { describe, expect, test } from "bun:test";
import { TopicRegistry, type TopicRegistryState } from "../src/sdk/bus/topic-registry";

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
		const reg = new TopicRegistry({ topics: { s1: { topicId: "42", identitySent: false, createdAt: 1 } } });
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

	test("deletes topic records so later use creates a fresh topic", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");

		expect(reg.delete("s1")).toBe(true);
		expect(reg.delete("s1")).toBe(false);
		expect(reg.get("s1")).toBeUndefined();
		expect(reg.sessionForTopic("1")).toBeUndefined();

		let created = false;
		const rec = await reg.getOrCreateTopic("s1", async () => {
			created = true;
			return "2";
		});
		expect(created).toBe(true);
		expect(rec.topicId).toBe("2");
		expect(reg.sessionForTopic("2")).toBe("s1");
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
		expect(reg.beginDelete("s1")).toBeUndefined();
		created.resolve("42");
		await expect(create).rejects.toThrow("topic authority was revoked during creation");
		expect(reg.get("s1")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.serialize().topics.s1).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
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
					reg.beginDelete("s1");
				},
			),
		).rejects.toThrow("topic authority was revoked during creation");
		expect(reg.sessionForTopic("42")).toBeUndefined();
		expect(reg.get("s1")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reg.serialize().topics.s1).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
	});
	test("retains a delete-pending record and epoch without restoring its inbound route", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42", Date.now, undefined, {
			chatId: "42",
			endpointKey: "ws://s1",
			endpointDigest: "digest-s1",
			endpointGeneration: 1,
		});
		reg.beginDelete("s1");

		const reloaded = new TopicRegistry(reg.serialize());

		expect(reloaded.get("s1")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reloaded.sessionForTopic("42")).toBeUndefined();
		await expect(reloaded.getOrCreateTopic("s1", async () => "43")).rejects.toThrow(
			"topic authority is deletion-fenced",
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

		expect(reloaded.get("s1")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
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

		expect(reg.get("s1")).toMatchObject({ authorityState: "delete_pending" });
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

		expect(reg.get("active")?.authorityState).toBeUndefined();
		expect(reg.get("fenced")).toMatchObject({ authorityState: "delete_pending" });
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
		const snapshot = reg.captureDeleteAuthority("A");
		reg.beginDelete("A");
		await reg.getOrCreateTopic("B", async () => "42", Date.now, undefined, binding("B"));

		expect(reg.restoreDeleteAuthority(snapshot)).toBe(true);
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
