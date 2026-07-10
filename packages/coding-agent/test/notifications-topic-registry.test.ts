import { describe, expect, test } from "bun:test";
import { TopicRegistry } from "../src/notifications/topic-registry";

describe("TopicRegistry", () => {
	test("creates a topic once and reuses it on resume", async () => {
		const reg = new TopicRegistry();
		let creates = 0;
		const create = async () => {
			creates++;
			return `topic-${creates}`;
		};
		const first = await reg.getOrCreateTopic("sess-1", create, () => 1000);
		const second = await reg.getOrCreateTopic("sess-1", create, () => 2000);
		expect(first.topicId).toBe("topic-1");
		expect(second.topicId).toBe("topic-1");
		expect(creates).toBe(1);
		expect(first.createdAt).toBe(1000);
	});

	test("distinct sessions get distinct topics", async () => {
		const reg = new TopicRegistry();
		let n = 0;
		const create = async () => `topic-${++n}`;
		const a = await reg.getOrCreateTopic("s1", create);
		const b = await reg.getOrCreateTopic("s2", create);
		expect(a.topicId).not.toBe(b.topicId);
	});

	test("identity header is sent exactly once per topic", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "t1");
		expect(reg.needsIdentity("s1")).toBe(true);
		reg.markIdentitySent("s1");
		expect(reg.needsIdentity("s1")).toBe(false);
	});

	test("separates rename detection from successful name commit", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"s1",
			async () => "t1",
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
			async () => "t1",
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
					topicId: "bad",
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
					topicId: "legacy",
					identitySent: false,
					createdAt: 1,
					name: "Legacy name",
					userNameUpdateId: 99,
					identityKey: "repo\0legacy",
				},
				user: {
					topicId: "user",
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
		await reg.getOrCreateTopic("s1", async () => "t-99");
		expect(reg.sessionForTopic("t-99")).toBe("s1");
		expect(reg.sessionForTopic("nope")).toBeUndefined();
	});

	test("round-trips through serialize and reload, preserving reuse + identity", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic(
			"s1",
			async () => "t1",
			() => 5,
		);
		reg.markIdentitySent("s1");
		const reloaded = new TopicRegistry(reg.serialize());
		let created = false;
		const rec = await reloaded.getOrCreateTopic("s1", async () => {
			created = true;
			return "tNEW";
		});
		expect(created).toBe(false);
		expect(rec.topicId).toBe("t1");
		expect(reloaded.needsIdentity("s1")).toBe(false);
		expect(reloaded.sessionForTopic("t1")).toBe("s1");
	});

	test("serializes an optional Telegram chat scope", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "t1");
		expect(reg.serialize("-10042")).toMatchObject({
			chatId: "-10042",
			topics: { s1: { topicId: "t1" } },
		});
	});
	test("concurrent getOrCreateTopic for one session creates exactly one topic (no race)", async () => {
		const reg = new TopicRegistry();
		let creates = 0;
		const create = async () => {
			creates++;
			await new Promise(r => setTimeout(r, 5));
			return `topic-${creates}`;
		};
		// identity + idle + turn frames all first-touch the session concurrently.
		const results = await Promise.all([
			reg.getOrCreateTopic("s1", create),
			reg.getOrCreateTopic("s1", create),
			reg.getOrCreateTopic("s1", create),
		]);
		expect(creates).toBe(1);
		expect(results.map(r => r.topicId)).toEqual(["topic-1", "topic-1", "topic-1"]);
		expect(reg.sessionForTopic("topic-1")).toBe("s1");
	});
	test("cancelling an in-flight create discards its remote winner without replacing a fresh topic", async () => {
		const reg = new TopicRegistry();
		const createStarted = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<void>();
		const discarded: string[] = [];
		const stale = reg.getOrCreateTopic(
			"s1",
			async () => {
				createStarted.resolve();
				await releaseCreate.promise;
				return "stale";
			},
			() => 1,
			"stale name",
			async topicId => {
				discarded.push(topicId);
			},
		);
		await createStarted.promise;

		expect(reg.cancelPendingCreate("s1")).toBe(true);
		expect(reg.cancelPendingCreate("s1")).toBe(false);
		const fresh = await reg.getOrCreateTopic(
			"s1",
			async () => "fresh",
			() => 2,
			"fresh name",
		);
		releaseCreate.resolve();

		await expect(stale).rejects.toThrow("topic creation cancelled");
		expect(discarded).toEqual(["stale"]);
		expect(fresh.topicId).toBe("fresh");
		expect(reg.get("s1")?.topicId).toBe("fresh");
		expect(reg.sessionForTopic("stale")).toBeUndefined();
		expect(reg.sessionForTopic("fresh")).toBe("s1");
	});

	test("deletes topic records so later use creates a fresh topic", async () => {
		const reg = new TopicRegistry();
		await reg.getOrCreateTopic("s1", async () => "t1");

		expect(reg.delete("s1")).toBe(true);
		expect(reg.delete("s1")).toBe(false);
		expect(reg.get("s1")).toBeUndefined();
		expect(reg.sessionForTopic("t1")).toBeUndefined();

		let created = false;
		const rec = await reg.getOrCreateTopic("s1", async () => {
			created = true;
			return "t2";
		});
		expect(created).toBe(true);
		expect(rec.topicId).toBe("t2");
		expect(reg.sessionForTopic("t2")).toBe("s1");
	});
	test("pending deletion remains durable while an in-flight replacement publishes", async () => {
		const reg = new TopicRegistry();
		const stale = await reg.getOrCreateTopic("s1", async () => "stale");
		expect(reg.delete("s1")).toBe(true);

		const createStarted = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<void>();
		const freshPromise = reg.getOrCreateTopic("s1", async () => {
			createStarted.resolve();
			await releaseCreate.promise;
			return "fresh";
		});
		await createStarted.promise;

		expect(reg.queuePendingDelete("s1", stale.topicId, stale.createdAt)).toBe(true);
		expect(reg.queuePendingDelete("s1", stale.topicId, stale.createdAt)).toBe(false);
		releaseCreate.resolve();
		const fresh = await freshPromise;

		expect(reg.get("s1")).toBe(fresh);
		expect(reg.sessionForTopic("stale")).toBeUndefined();
		expect(reg.sessionForTopic("fresh")).toBe("s1");
		expect(reg.pendingDeletesForSession("s1").map(record => record.topicId)).toEqual(["stale"]);

		const reloaded = new TopicRegistry(reg.serialize("-10042"));
		expect(reloaded.get("s1")?.topicId).toBe("fresh");
		expect(reloaded.pendingDeletesForSession("s1").map(record => record.topicId)).toEqual(["stale"]);
		expect(reloaded.deletePendingDelete("stale")).toBe(true);
		expect(reloaded.pendingDeletesForSession("s1")).toEqual([]);
	});
	test("duplicate active topic ids fail closed instead of assigning inbound authority", () => {
		const reg = new TopicRegistry({
			topics: {
				first: { topicId: "777", identitySent: true, createdAt: 1 },
				second: { topicId: "777", identitySent: true, createdAt: 2 },
			},
		});

		expect(reg.get("first")).toBeUndefined();
		expect(reg.get("second")).toBeUndefined();
		expect(reg.sessionForTopic("777")).toBeUndefined();
		expect(reg.serialize().topics).toEqual({});
	});

	test("persisted pending deletion cannot target any active topic claim", () => {
		const reg = new TopicRegistry({
			topics: {
				active: { topicId: "777", identitySent: true, createdAt: 1 },
			},
			pendingDeletes: [{ sessionId: "old", topicId: "777", createdAt: 0 }],
		});

		expect(reg.get("active")?.topicId).toBe("777");
		expect(reg.sessionForTopic("777")).toBe("active");
		expect(reg.pendingDeletesForSession("old")).toEqual([]);
		expect(reg.serialize().pendingDeletes).toBeUndefined();
	});

	test("runtime topic-id collisions preserve the existing active or pending owner", async () => {
		const active = new TopicRegistry();
		await active.getOrCreateTopic("active", async () => "777");
		expect(active.queuePendingDelete("old", "777", 0)).toBe(false);
		expect(active.get("active")?.topicId).toBe("777");

		const deleting = new TopicRegistry();
		expect(deleting.queuePendingDelete("old", "777", 0)).toBe(true);
		await expect(deleting.getOrCreateTopic("replacement", async () => "777")).rejects.toThrow("conflicting topic id");
		expect(deleting.get("replacement")).toBeUndefined();
		expect(deleting.pendingDeletesForSession("old").map(record => record.topicId)).toEqual(["777"]);
	});
});
