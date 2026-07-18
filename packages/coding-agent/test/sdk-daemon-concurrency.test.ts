import { describe, expect, test } from "bun:test";
import { isProcessIncarnation, processIncarnation } from "../src/sdk/broker/process-incarnation";
import { ChatEffectJournal, MAX_TERMINAL_CHAT_EFFECTS } from "../src/sdk/bus/chat-effect-journal";
import {
	boundedDedupe,
	ConversationLockTimeoutError,
	type ConversationRecord,
	ConversationStore,
	conversationStorePath,
	MAX_DEDUPE_IDS,
} from "../src/sdk/bus/conversation-store";
import type { SlackConversation } from "../src/sdk/bus/slack-conversation";
import { MemoryConversationStoreFs } from "./fixtures/chat-daemon-stores";

interface TestConversation extends ConversationRecord {
	state: "creating" | "active";
	seenEventIds: string[];
}

function record(generation: number, state: TestConversation["state"] = "creating"): TestConversation {
	return { generation, state, seenEventIds: [] };
}

describe("ConversationStore", () => {
	test("creates the transport store under the SDK daemon path and permits one concurrent creator", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs, now: () => 1 });
		expect(store.filePath).toBe(conversationStorePath("/agent", "discord"));
		const [first, second] = await Promise.all([
			store.write("mapping", undefined, record(1)),
			store.write("mapping", undefined, record(1)),
		]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(await store.read("mapping")).toEqual(record(1));
		expect(fs.modes.get(store.filePath)).toBe(0o600);
		expect(fs.modes.get("/agent/sdk/daemons/discord")).toBe(0o700);
	});

	test("does not reclaim a newly created lock before its owner publishes metadata", async () => {
		const entered = Promise.withResolvers<void>();
		const observedEmptyLock = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		class PausingFs extends MemoryConversationStoreFs {
			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (flags === "wx" && !paused) {
					paused = true;
					entered.resolve();
					await release.promise;
				}
				return handle;
			}
			override async readFile(file: string, encoding: "utf8") {
				const value = await super.readFile(file, encoding);
				if (paused && file.endsWith(".lock") && value === "") observedEmptyLock.resolve();
				return value;
			}
		}
		const fs = new PausingFs();
		const first = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 101,
			pidAlive: () => true,
		});
		const second = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: () => true,
		});
		const firstWrite = first.write("mapping", undefined, record(1));
		await entered.promise;
		let secondSettled = false;
		const secondWrite = second.write("mapping", undefined, record(1)).finally(() => {
			secondSettled = true;
		});
		await observedEmptyLock.promise;
		expect(secondSettled).toBe(false);
		release.resolve();
		expect((await Promise.all([firstWrite, secondWrite])).filter(Boolean)).toHaveLength(1);
	});

	test("recovers a lock whose recorded owner is dead", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: pid => pid === 202,
		});
		fs.files.set(`${store.filePath}.lock`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		expect(await store.write("mapping", undefined, record(1))).toBe(true);
	});
	test("recovers an abandoned reclaim lock owned by a reused PID", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: () => true,
			pidIncarnation: pid => (pid === 101 ? "current" : "writer"),
		});
		fs.files.set(`${store.filePath}.lock`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		fs.files.set(`${store.filePath}.lock.reclaim`, JSON.stringify({ pid: 101, incarnation: "old", timestamp: 1 }));
		await expect(store.write("mapping", undefined, record(1))).resolves.toBe(true);
		expect(fs.files.has(`${store.filePath}.lock.reclaim`)).toBe(false);
	});

	test("does not steal a fresh live reclaim lock or bypass the lock timeout", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: pid => pid !== 101,
			pidIncarnation: pid => (pid === 303 ? "darwin:1700000000:123456" : "darwin:1700000000:654321"),
			lockTimeoutMs: 0,
		});
		fs.files.set(
			`${store.filePath}.lock`,
			JSON.stringify({ pid: 101, incarnation: "darwin:1700000000:999999", timestamp: 1 }),
		);
		fs.files.set(
			`${store.filePath}.lock.reclaim`,
			JSON.stringify({ pid: 303, incarnation: "darwin:1700000000:123456", timestamp: 1 }),
		);
		await expect(store.write("mapping", undefined, record(1))).rejects.toBeInstanceOf(ConversationLockTimeoutError);
		expect(fs.files.get(`${store.filePath}.lock.reclaim`)).toBe(
			JSON.stringify({ pid: 303, incarnation: "darwin:1700000000:123456", timestamp: 1 }),
		);
	});

	test("default-path lock uses canonical processIncarnation format", async () => {
		let capturedLock: string | undefined;
		class CapturingFs extends MemoryConversationStoreFs {
			override async open(file: string, flags: string) {
				const handle = await super.open(file, flags);
				if (flags === "wx" && file.endsWith(".lock")) {
					return {
						...handle,
						writeFile: async (data: string, encoding: "utf8") => {
							capturedLock = data.trim();
							await handle.writeFile(data, encoding);
						},
					};
				}
				return handle;
			}
		}
		const capturingFs = new CapturingFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs: capturingFs,
			pid: process.pid,
			pidAlive: () => true,
		});
		await store.write("mapping", undefined, record(1));
		expect(capturedLock).toBeDefined();
		const lock = JSON.parse(capturedLock!);
		expect(lock.pid).toBe(process.pid);
		// The incarnation must be canonical (not a locale-dependent lstart string).
		expect(isProcessIncarnation(lock.incarnation)).toBe(true);
		expect(lock.incarnation).toBe(processIncarnation(process.pid));
	});

	test("reclaims a non-canonical locale-dependent Darwin lock as not-owned", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "discord",
			fs,
			pid: 202,
			pidAlive: () => true,
			pidIncarnation: () => "darwin:1700000000:123456",
		});
		// Simulate a stale lock written by the old locale-dependent defaultPidIncarnation.
		fs.files.set(
			`${store.filePath}.lock`,
			JSON.stringify({ pid: 101, incarnation: "darwin:Thu Jul 17 10:00:00 2025", timestamp: 1 }),
		);
		expect(await store.write("mapping", undefined, record(1))).toBe(true);
	});

	test("serializes separate store instances so independent mapping updates do not overwrite one another", async () => {
		const fs = new MemoryConversationStoreFs();
		const first = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "slack", fs, now: () => 2 });
		const second = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "slack", fs, now: () => 2 });
		await Promise.all([first.write("one", undefined, record(1)), second.write("two", undefined, record(1))]);
		expect((await first.load()).conversations).toEqual({ one: record(1), two: record(1) });
	});

	test("rejects a stale generation and restores persisted mappings after restart", async () => {
		const fs = new MemoryConversationStoreFs();
		const initial = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "slack", fs, now: () => 2 });
		expect(await initial.write("mapping", undefined, record(1))).toBe(true);
		expect(await initial.write("mapping", 1, record(2, "active"))).toBe(true);
		expect(await initial.write("mapping", 1, record(2, "active"))).toBe(false);
		const restarted = new ConversationStore<TestConversation>({
			agentDir: "/agent",
			kind: "slack",
			fs,
			now: () => 3,
		});
		expect(await restarted.read("mapping")).toEqual(record(2, "active"));
	});

	test("bounds durable dedupe identifiers without retaining duplicate values", () => {
		const ids = Array.from({ length: MAX_DEDUPE_IDS + 2 }, (_, index) => `event-${index}`);
		const bounded = boundedDedupe(["event-0", ...ids, "event-1"]);
		expect(bounded).toHaveLength(MAX_DEDUPE_IDS);
		expect(bounded[0]).toBe("event-2");
		expect(bounded.at(-1)).toBe(`event-${MAX_DEDUPE_IDS + 1}`);
	});

	test("keeps the prior document intact when fsync or rename fails", async () => {
		const fs = new MemoryConversationStoreFs();
		const store = new ConversationStore<TestConversation>({ agentDir: "/agent", kind: "discord", fs, now: () => 4 });
		await store.write("mapping", undefined, record(1));
		fs.failFileSync = true;
		await expect(store.write("mapping", 1, record(2))).rejects.toThrow("sync failed");
		fs.failFileSync = false;
		fs.failRename = true;
		await expect(store.write("mapping", 1, record(2))).rejects.toThrow("rename failed");
		expect(await store.read("mapping")).toEqual(record(1));
		expect(fs.calls.some(call => call.startsWith("sync:/agent/sdk/daemons/discord/conversations.json."))).toBe(true);
	});
});

describe("ChatEffectJournal", () => {
	test("keeps provider payloads out of mappings while replaying the protected journal after restart", async () => {
		const fs = new MemoryConversationStoreFs();
		const mappings = new ConversationStore<SlackConversation>({ agentDir: "/agent", kind: "slack", fs });
		const journal = new ChatEffectJournal({ agentDir: "/agent", transport: "slack", fs, now: () => 1 });
		await journal.enqueue({
			id: "inbound:evt-1",
			kind: "command",
			transport: "slack",
			sessionId: "session",
			endpointGeneration: 4,
			payload: { content: "/sdk secret-command", token: "super-secret" },
		});
		await mappings.write("team:channel:root", undefined, {
			generation: 1,
			state: "active",
			teamId: "team",
			channelId: "channel",
			rootTs: "root",
			sessionId: "session",
			endpointGeneration: 4,
			updatedAt: 1,
			seenEventIds: [],
			seenContextIds: [],
			seenRetryKeys: [],
			seenInteractionIds: [],
			inboundDispatches: [
				{
					key: "evt-1",
					eventId: "evt-1",
					interactionId: "interaction",
					retryKey: "retry",
					kind: "command",
					endpointGeneration: 4,
					effectId: "inbound:evt-1",
					idempotencyKey: "inbound:evt-1",
				},
			],
		});
		const mappingBody = fs.files.get(mappings.filePath) ?? "";
		expect(mappingBody).not.toContain("secret-command");
		expect(mappingBody).not.toContain("super-secret");
		expect(fs.modes.get(journal.filePath)).toBe(0o600);
		const restarted = new ChatEffectJournal({ agentDir: "/agent", transport: "slack", fs, now: () => 2 });
		expect(await restarted.replayable("slack", 4)).toEqual([
			expect.objectContaining({
				id: "inbound:evt-1",
				payload: { content: "/sdk secret-command", token: "super-secret" },
			}),
		]);
	});

	test("takes over expired leases and fences stale owners from terminal commits", async () => {
		const fs = new MemoryConversationStoreFs();
		const first = new ChatEffectJournal({ agentDir: "/agent", transport: "discord", fs, now: () => 1 });
		await first.enqueue({
			id: "effect",
			kind: "reply",
			transport: "discord",
			endpointGeneration: 2,
			payload: { answer: "body" },
		});
		const oldLease = await first.claim("effect", "old", 5);
		expect(oldLease).toMatchObject({ state: "leased", epoch: 1 });
		const second = new ChatEffectJournal({ agentDir: "/agent", transport: "discord", fs, now: () => 7 });
		const newLease = await second.claim("effect", "new", 5);
		expect(newLease).toMatchObject({ state: "leased", owner: "new", epoch: 2 });
		expect(await first.record("effect", { owner: "old", epoch: oldLease!.epoch }, "terminal")).toBeUndefined();
		expect(
			await second.record("effect", { owner: "new", epoch: newLease!.epoch }, "terminal", { messageId: "remote" }),
		).toMatchObject({ state: "terminal", receipt: { messageId: "remote" } });
	});

	test("retains more than 128 nonterminal effects while bounding terminal history", async () => {
		const fs = new MemoryConversationStoreFs();
		const journal = new ChatEffectJournal({ agentDir: "/agent", transport: "discord", fs, now: () => 1 });
		for (let index = 0; index < 130; index++)
			await journal.enqueue({
				id: `pending-${index}`,
				kind: "reply",
				transport: "discord",
				endpointGeneration: 1,
				payload: { index },
			});
		for (let index = 0; index < 130; index++) {
			await journal.enqueue({
				id: `terminal-${index}`,
				kind: "reply",
				transport: "discord",
				endpointGeneration: 1,
				payload: { index },
			});
			const lease = await journal.claim(`terminal-${index}`, "owner", 10);
			await journal.record(`terminal-${index}`, { owner: "owner", epoch: lease!.epoch }, "terminal");
		}
		const effects = await journal.list();
		expect(effects.filter(effect => effect.state !== "terminal")).toHaveLength(130);
		expect(effects.filter(effect => effect.state === "terminal")).toHaveLength(MAX_TERMINAL_CHAT_EFFECTS);
	});
});
