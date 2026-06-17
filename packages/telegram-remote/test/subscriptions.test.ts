import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionStore } from "../src/subscriptions";

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "telegram-remote-subscriptions-"));
	tempDirs.push(dir);
	return join(dir, "telegram-remote-state.json");
}

async function readState(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(filePath, "utf8"));
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("SubscriptionStore", () => {
	test("persists subscriptions across reload", async () => {
		const now = 1_000;
		const filePath = await tempFile();
		const store = await SubscriptionStore.load({ filePath, now: () => now });

		await store.follow({ sessionId: "session-a", chatId: "chat-1", userId: "user-1" });
		const reloaded = await SubscriptionStore.load({ filePath, now: () => now });

		expect(await reloaded.followers("session-a")).toEqual([
			{ sessionId: "session-a", chatId: "chat-1", userId: "user-1", expiresAt: now + 86_400_000, updatedAt: now },
		]);
	});

	test("prunes expired subscriptions and persists the pruned state", async () => {
		let now = 1_000;
		const filePath = await tempFile();
		const store = await SubscriptionStore.load({ filePath, now: () => now });
		await store.follow({ sessionId: "session-a", chatId: "chat-1", userId: null });

		now += 86_400_001;
		expect(await store.followers("session-a")).toEqual([]);
		const persisted = await readState(filePath);
		expect(persisted.subscriptions).toEqual([]);
	});

	test("keeps cursor monotonic and persists it", async () => {
		const filePath = await tempFile();
		const store = await SubscriptionStore.load({ filePath, now: () => 1_000 });

		await store.setCursor(10);
		await store.setCursor(8);

		expect(store.getCursor()).toBe(10);
		expect((await readState(filePath)).watchCursor).toBe(10);
	});

	test("fails closed on corrupted state", async () => {
		const filePath = await tempFile();
		await writeFile(filePath, "not json", "utf8");

		const store = await SubscriptionStore.load({ filePath, now: () => 1_000 });

		expect(store.snapshotState()).toEqual({ version: 1, watchCursor: 0, subscriptions: [] });
	});

	test("enforces max subscriptions by evicting oldest updated entries", async () => {
		let now = 1_000;
		const filePath = await tempFile();
		const store = await SubscriptionStore.load({ filePath, maxSubscriptions: 2, now: () => now });

		await store.follow({ sessionId: "old", chatId: "chat-1", userId: null });
		now += 1;
		await store.follow({ sessionId: "middle", chatId: "chat-2", userId: null });
		now += 1;
		await store.follow({ sessionId: "new", chatId: "chat-3", userId: null });

		const persisted = await readState(filePath);
		expect((persisted.subscriptions as unknown[]).length).toBeLessThanOrEqual(2);
		expect(
			(persisted.subscriptions as Array<{ sessionId: string }>).map(subscription => subscription.sessionId).sort(),
		).toEqual(["middle", "new"]);
	});

	test("writes atomically without leaving a temp file", async () => {
		const filePath = await tempFile();
		const store = await SubscriptionStore.load({ filePath, now: () => 1_000 });

		await store.follow({ sessionId: "session-a", chatId: "chat-1", userId: null });

		expect(await readState(filePath)).toMatchObject({ version: 1, watchCursor: 0 });
		await expect(readFile(`${filePath}.tmp`, "utf8")).rejects.toThrow();
	});

	test("persists exactly the routing schema and excludes event-store fields", async () => {
		const filePath = await tempFile();
		const store = await SubscriptionStore.load({ filePath, now: () => 1_000 });

		await store.follow({ sessionId: "session-a", chatId: "chat-1", userId: "user-1" });
		const persisted = await readState(filePath);
		const serialized = JSON.stringify(persisted);

		expect(Object.keys(persisted)).toEqual(["version", "watchCursor", "subscriptions"]);
		for (const excluded of [
			"dedupe",
			"lastDeliveredTransition",
			"events",
			"transitions",
			"summary",
			"metadata",
			"payload_ref",
		]) {
			expect(serialized).not.toContain(excluded);
		}
	});

	test("strips extra/nested fields from a seeded file on load+persist (no shadow event store)", async () => {
		const filePath = await tempFile();
		// A hostile/legacy file with event-store fields nested on a subscription.
		await writeFile(
			filePath,
			JSON.stringify({
				version: 1,
				watchCursor: 5,
				subscriptions: [
					{
						sessionId: "session-a",
						chatId: "chat-1",
						userId: "user-1",
						expiresAt: 9_000_000_000_000,
						updatedAt: 1_000,
						metadata: { secret: "LEAK" },
						payload_ref: "ref-1",
						events: [{ kind: "blocked" }],
					},
				],
			}),
			"utf8",
		);
		const store = await SubscriptionStore.load({ filePath, now: () => 2_000 });
		// Trigger a persist (cursor advance) so the normalized state is rewritten.
		await store.setCursor(10);
		const persisted = await readState(filePath);
		const serialized = JSON.stringify(persisted);
		for (const excluded of ["metadata", "payload_ref", "events", "LEAK", "ref-1"]) {
			expect(serialized).not.toContain(excluded);
		}
		const subs = persisted.subscriptions as Array<Record<string, unknown>>;
		expect(Object.keys(subs[0] ?? {}).sort()).toEqual(
			["chatId", "expiresAt", "sessionId", "updatedAt", "userId"].sort(),
		);
	});
});
