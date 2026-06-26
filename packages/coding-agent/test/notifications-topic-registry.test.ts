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
});
