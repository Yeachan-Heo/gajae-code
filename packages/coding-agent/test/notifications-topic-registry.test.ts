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
		["missing update id", { name: "Missing source id" }],
	])("malformed persisted user authority (%s) falls back to daemon naming", (_name, fields) => {
		const reg = new TopicRegistry({
			topics: {
				bad: {
					topicId: "1",
					identitySent: false,
					createdAt: 1,
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

	test("retains valid user authority and normalizes legacy name state", () => {
		const reg = new TopicRegistry({
			topics: {
				legacy: {
					topicId: "1",
					identitySent: false,
					createdAt: 1,
					name: "Legacy name",
					userNameUpdateId: 99,
					identityKey: "repo\0legacy",
				},
				user: {
					topicId: "2",
					identitySent: false,
					createdAt: 1,
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

	test("resolves session for a topic id (inbound routing)", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "99");
		expect(reg.sessionForTopic("99")).toBe("s1");
		expect(reg.sessionForTopic("nope")).toBeUndefined();
	});

	test("round-trips through serialize and reload, preserving reuse + identity", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"s1",
			async () => "1",
			() => 5,
		);
		reg.markIdentitySent("s1");
		const reloaded = new TopicRegistry(reg.serialize());
		let created = false;
		const rec = await reloaded.getOrCreateTopic("s1", async () => {
			created = true;
			return "2";
		});
		expect(created).toBe(false);
		expect(rec.topicId).toBe("1");
		expect(reloaded.needsIdentity("s1")).toBe(false);
		expect(reloaded.sessionForTopic("1")).toBe("s1");
	});
	test("persists a monotonic SDK replay cursor across daemon restarts", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "1");
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
	test("retains a delete-pending record and epoch without restoring its inbound route", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42");
		reg.beginDelete("s1");

		const reloaded = new TopicRegistry(reg.serialize());

		expect(reloaded.get("s1")).toMatchObject({ topicId: "42", authorityState: "delete_pending" });
		expect(reloaded.sessionForTopic("42")).toBeUndefined();
		await expect(reloaded.getOrCreateTopic("s1", async () => "43")).rejects.toThrow(
			"topic authority is deletion-fenced",
		);
	});
	test("rebuilds inbound routes from merged records on repeated load", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "42");
		expect(reg.sessionForTopic("42")).toBe("s1");

		reg.load({
			topics: {
				s1: {
					topicId: "42",
					identitySent: false,
					createdAt: 1,
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
						...(sessionId === "fenced" ? { authorityState: "delete_pending" as const } : {}),
					},
				},
			});
		}

		expect(reg.get("active")?.authorityState).toBeUndefined();
		expect(reg.get("fenced")).toMatchObject({ authorityState: "delete_pending" });
		expect(reg.sessionForTopic("42")).toBeUndefined();
	});
});
