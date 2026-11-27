import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import {
	type BotApi,
	FilesystemTopicRegistryCasAuthority,
	HEARTBEAT_TTL_MS,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";
import type { TopicRegistryState } from "../src/sdk/bus/topic-registry";
import type { NotificationSubscription } from "../src/sdk/router";

const BOT_TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
const HOST_ID = "lease-host";
const SESSION_ID = "lease-session";

/** The persisted fields the lease-renewal contract asserts over. */
type PersistedTopic = {
	topicId?: string;
	identitySent?: boolean;
	authorityState?: string;
	leaseOwner?: string;
	leaseExpiresAt?: number;
	orphanedAt?: number;
	disconnectGraceExpiresAt?: number;
	archiveReason?: string;
};

type PersistedTopics = { topics: Record<string, PersistedTopic> };

/** A recorded Bot API call: the method name plus the request body we sent. */
type RecordedCall = { method: string; body: Record<string, unknown> };

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-lease-4647-"));
}

function settings(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.enabled": true,
		"notifications.telegram.botToken": BOT_TOKEN,
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function notificationSubscription(sessionId: string, generation = 1): NotificationSubscription {
	let active = true;
	const cursor = { generation, seq: 0 };
	return {
		sessionId,
		subscriptionId: `test:${sessionId}:${generation}`,
		cursor,
		isActive: () => active,
		send: () => undefined,
		advanceCursor: (nextGeneration, seq) => {
			cursor.generation = nextGeneration;
			cursor.seq = seq;
		},
		cancel: () => {
			active = false;
		},
	};
}

/** Bot that creates topic 555 once and records every Bot API call. */
function fakeBot(): { bot: BotApi; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const bot: BotApi = {
		call: async (method, body) => {
			calls.push({ method, body: (body ?? {}) as Record<string, unknown> });
			if (method === "createForumTopic") return { ok: true, result: { message_thread_id: 555 } };
			if (method === "getChat") return { ok: true, result: { id: 42, type: "private" } };
			if (method === "sendMessage") return { ok: true, result: { message_id: calls.length } };
			return { ok: true, result: true };
		},
	};
	return { bot, calls };
}

async function readPersistedTopics(agentDir: string): Promise<PersistedTopics> {
	return (await Bun.file(path.join(daemonPaths(agentDir).dir, "telegram-topics.json")).json()) as PersistedTopics;
}

async function persistedTopic(agentDir: string, sessionId: string): Promise<PersistedTopic> {
	const topics = await readPersistedTopics(agentDir);
	const topic = topics.topics[sessionId];
	if (!topic) throw new Error(`Expected a persisted topic record for ${sessionId}.`);
	return topic;
}

/** Rewrite the durable topic registry through the Bun write API. */
async function mutatePersistedTopics(agentDir: string, mutate: (topics: PersistedTopics) => void): Promise<void> {
	const topics = await readPersistedTopics(agentDir);
	mutate(topics);
	await Bun.write(path.join(daemonPaths(agentDir).dir, "telegram-topics.json"), `${JSON.stringify(topics)}\n`);
}

type LeaseHarness = {
	bot: ReturnType<typeof fakeBot>;
	daemon: TelegramNotificationDaemon;
	sessionId: string;
	send: (frame: Record<string, unknown>, publicationId: string) => Promise<unknown>;
};

const agentDirs: string[] = [];
afterEach(() => {
	for (const dir of agentDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Attach + authenticated replay so the session is `logicalSessionIdTrusted` with an
 * authorized recovery lease bound to its durable topic — the incident state from
 * issue #4647. `nowRef` is captured so a test can advance clock time afterwards.
 */
async function trustedAttachedSession(agentDir: string, nowRef: { now: number }): Promise<LeaseHarness> {
	const bot = fakeBot();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: HOST_ID,
		botToken: BOT_TOKEN,
		chatId: "42",
		botApi: bot.bot,
		now: () => nowRef.now,
		installationHostId: HOST_ID,
	});
	await daemon.loadTopics();
	const routing = daemon.attachmentRoutingHarnessForTest();
	const attachment = notificationSubscription(SESSION_ID);
	routing.attach(attachment);
	const session = daemon.sessions.get(attachment.sessionId);
	if (!session) throw new Error("Expected a routed Telegram attachment session.");
	await daemon.handleSessionMessage(session, {
		type: "event_replay_result",
		id: session.replayId,
		ok: true,
		generation: 1,
		lastSeq: 0,
		events: [{ payload: { type: "identity_header", sessionId: SESSION_ID, telegramTopicsEnabled: true } }],
	});
	return {
		bot,
		daemon,
		sessionId: SESSION_ID,
		send: (frame, publicationId) =>
			daemon.handleSessionMessage(session, { sessionId: SESSION_ID, ...frame }, publicationId),
	};
}

describe("Telegram trusted attachment topic-host lease renewal (#4647)", () => {
	test.each([1, 2])("recovery rejects a topic collision on write %i", async collisionWrite => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const initial = await trustedAttachedSession(agentDir, nowRef);
		initial.daemon.requestStop();
		await mutatePersistedTopics(agentDir, topics => {
			const topic = topics.topics[SESSION_ID]!;
			topic.authorityState = "disconnect_grace";
			topic.orphanedAt = nowRef.now;
			topic.leaseExpiresAt = nowRef.now;
			topic.disconnectGraceExpiresAt = nowRef.now + 60_000;
		});
		const authority = new FilesystemTopicRegistryCasAuthority(
			path.join(daemonPaths(agentDir).dir, "telegram-topics.json"),
			{
				installationHostId: HOST_ID,
			},
		);
		const grace = await authority.read();
		let writes = 0;
		let injected = false;
		let armed = false;
		const shared = {
			read: () => authority.read(),
			compareAndSet: async (generation: number, next: typeof grace) => {
				if (!armed) return authority.compareAndSet(generation, next);
				writes++;
				// Recovery's first write binds; its second write renews the lease.
				if (writes === collisionWrite) {
					const current = await authority.read();
					const topic = current.topics[SESSION_ID]!;
					const { disconnectGraceExpiresAt: _grace, orphanedAt: _orphaned, ...activeTopic } = topic;
					const winner = {
						...current,
						registryGeneration: generation + 1,
						topics: {
							...current.topics,
							other: {
								...activeTopic,
								sessionUuid: crypto.randomUUID(),
								authorityState: "active" as const,
								leaseOwner: "foreign",
								leaseExpiresAt: nowRef.now + 60_000,
							},
						},
					};
					expect(await authority.compareAndSet(generation, winner)).toBe(true);
					injected = true;
					return false;
				}
				return authority.compareAndSet(generation, next);
			},
		};
		const bot = fakeBot();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: HOST_ID,
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi: bot.bot,
			now: () => nowRef.now,
			installationHostId: HOST_ID,
			topicRegistryAuthority: shared,
		});
		try {
			await daemon.loadTopics();
			armed = true;
			daemon.attachmentRoutingHarnessForTest().attach(notificationSubscription(SESSION_ID));
			const session = daemon.sessions.get(SESSION_ID);
			if (!session) throw new Error("Expected a routed Telegram attachment session.");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [{ payload: { type: "identity_header", sessionId: SESSION_ID, telegramTopicsEnabled: true } }],
			});
			expect(injected).toBe(true);
			expect(daemon.sessions.has(SESSION_ID)).toBe(false);
			const persisted = await authority.read();
			if (collisionWrite === 1) expect(persisted.topics[SESSION_ID]?.authorityState).toBe("disconnect_grace");
			expect(persisted.topics[SESSION_ID]?.leaseExpiresAt).toBe(nowRef.now);
			expect(persisted.topics.other?.authorityState).toBe("active");
			await daemon
				.handleSessionMessage(
					session,
					{ type: "turn_stream", sessionId: SESSION_ID, phase: "finalized", text: "after rejection" },
					"lease-session:1:99",
				)
				.catch(() => undefined);
			expect(
				bot.calls.filter(call => call.method === "sendMessage" && call.body.message_thread_id === undefined),
			).toHaveLength(0);
		} finally {
			daemon.requestStop();
		}
	});

	test("identity-less grace resume rechecks topic collision on bind CAS retry", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const now = 1_000;
		const harness = await trustedAttachedSession(agentDir, { now });
		harness.daemon.requestStop();
		await mutatePersistedTopics(agentDir, topics => {
			const topic = topics.topics[SESSION_ID]!;
			topic.authorityState = "disconnect_grace";
			topic.orphanedAt = now;
			topic.disconnectGraceExpiresAt = now + 60_000;
		});
		const file = path.join(daemonPaths(agentDir).dir, "telegram-topics.json");
		const authority = new FilesystemTopicRegistryCasAuthority(file, { installationHostId: HOST_ID });
		let injected = false;
		const wrapped = {
			read: () => authority.read(),
			compareAndSet: async (generation: number, next: TopicRegistryState) => {
				// The first mutation in #recoverTopicBinding is the bind, before lease renewal.
				if (!injected && next.topics[SESSION_ID]?.authorityState === "active") {
					injected = true;
					const winner = await authority.read();
					const competing = { ...winner.topics[SESSION_ID]!, authorityState: "active" as const };
					delete competing.disconnectGraceExpiresAt;
					winner.topics.other = competing;
					winner.registryGeneration = generation + 1;
					expect(await authority.compareAndSet(generation, winner)).toBe(true);
					return false;
				}
				return authority.compareAndSet(generation, next);
			},
		};
		const bot = fakeBot();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: HOST_ID,
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi: bot.bot,
			now: () => now,
			installationHostId: HOST_ID,
			topicRegistryAuthority: wrapped,
		});
		try {
			await daemon.loadTopics();
			daemon.attachmentRoutingHarnessForTest().attach(notificationSubscription(SESSION_ID));
			const session = daemon.sessions.get(SESSION_ID);
			if (!session) throw new Error("Expected attachment");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [],
			});
			expect(injected).toBe(true);
			expect(daemon.sessions.has(SESSION_ID)).toBe(false);
			expect((await authority.read()).topics[SESSION_ID]?.authorityState).toBe("disconnect_grace");
			expect(bot.calls.filter(call => call.method === "createForumTopic" || call.method === "sendMessage")).toEqual(
				[],
			);
		} finally {
			daemon.requestStop();
		}
	});

	test.each([
		"deadline equal",
		"deadline past",
		"foreign lease",
		"topic collision",
	])("identity-less replay rejects %s without writes", async condition => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const now = 1_000;
		const harness = await trustedAttachedSession(agentDir, { now });
		harness.daemon.requestStop();
		await mutatePersistedTopics(agentDir, topics => {
			const topic = topics.topics[SESSION_ID]!;
			topic.authorityState = "disconnect_grace";
			topic.orphanedAt = now;
			topic.disconnectGraceExpiresAt =
				condition === "deadline equal" ? now : condition === "deadline past" ? now - 1 : now + 60_000;
			if (condition === "foreign lease") {
				topic.leaseOwner = "foreign";
				topic.leaseExpiresAt = now + 1;
			}
			if (condition === "topic collision")
				topics.topics.other = { ...topic, authorityState: "active", disconnectGraceExpiresAt: undefined };
		});
		const file = path.join(daemonPaths(agentDir).dir, "telegram-topics.json");
		const before = await Bun.file(file).text();
		const bot = fakeBot();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: HOST_ID,
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi: bot.bot,
			now: () => now,
			installationHostId: HOST_ID,
		});
		try {
			await daemon.loadTopics();
			daemon.attachmentRoutingHarnessForTest().attach(notificationSubscription(SESSION_ID));
			const session = daemon.sessions.get(SESSION_ID);
			if (!session) throw new Error("Expected attachment");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [],
			});
			expect(daemon.sessions.has(SESSION_ID)).toBe(false);
			expect(await Bun.file(file).text()).toBe(before);
			expect(bot.calls.filter(call => call.method === "createForumTopic" || call.method === "sendMessage")).toEqual(
				[],
			);
		} finally {
			daemon.requestStop();
		}
	});

	test.each(["same host", "expired foreign host"])("identity-less replay resumes grace with %s lease", async lease => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const harness = await trustedAttachedSession(agentDir, nowRef);
		harness.daemon.requestStop();
		await mutatePersistedTopics(agentDir, topics => {
			const topic = topics.topics[SESSION_ID]!;
			topic.authorityState = "disconnect_grace";
			topic.orphanedAt = nowRef.now;
			topic.disconnectGraceExpiresAt = nowRef.now + 60_000;
			topic.leaseOwner = lease === "same host" ? HOST_ID : "foreign";
			topic.leaseExpiresAt = lease === "same host" ? nowRef.now + 10_000 : nowRef.now - 1;
		});
		const bot = fakeBot();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: HOST_ID,
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi: bot.bot,
			now: () => nowRef.now,
			installationHostId: HOST_ID,
		});
		try {
			await daemon.loadTopics();
			daemon.attachmentRoutingHarnessForTest().attach(notificationSubscription(SESSION_ID));
			const session = daemon.sessions.get(SESSION_ID);
			if (!session) throw new Error("Expected attachment");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [],
			});
			expect(daemon.sessions.get(SESSION_ID)).toBe(session);
			const topic = await persistedTopic(agentDir, SESSION_ID);
			expect(topic.authorityState).toBe("active");
			expect(topic.leaseOwner).toBe(HOST_ID);
			expect(topic.topicId).toBe("555");
			expect(bot.calls.some(call => call.method === "createForumTopic")).toBe(false);
			await daemon.handleSessionMessage(
				session,
				{ type: "turn_stream", sessionId: SESSION_ID, phase: "finalized", text: "resumed" },
				"lease-session:1:3",
			);
			expect(bot.calls.filter(call => call.method === "sendMessage").at(-1)?.body.message_thread_id).toBe(555);
		} finally {
			daemon.requestStop();
		}
	});

	test("a live owned trusted attachment publishes after its host lease expired", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const harness = await trustedAttachedSession(agentDir, nowRef);
		try {
			// Identity was replayed; the topic exists and the identity header was sent.
			expect(harness.bot.calls.some(call => call.method === "createForumTopic")).toBe(true);
			expect((await persistedTopic(agentDir, SESSION_ID)).identitySent).toBe(true);

			// Advance past the 20s host-lease TTL while the attachment stays live and
			// owned. Before the fix every later frame was rejected pre-send.
			nowRef.now += HEARTBEAT_TTL_MS + 1_000;
			await harness.send(
				{ type: "turn_stream", phase: "finalized", text: "post-identity update" },
				"lease-session:1:3",
			);

			const sent = harness.bot.calls.filter(call => call.method === "sendMessage");
			expect(sent.length).toBeGreaterThan(0);
			expect(sent.at(-1)?.body.message_thread_id).toBe(555);
			const topic = await persistedTopic(agentDir, SESSION_ID);
			expect(topic.authorityState).toBe("active");
			expect((topic.leaseExpiresAt ?? 0) > nowRef.now).toBe(true);
		} finally {
			harness.daemon.requestStop();
		}
	});

	test("ownership heartbeat re-arms an expired owned lease without a publication", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const harness = await trustedAttachedSession(agentDir, nowRef);
		try {
			nowRef.now += HEARTBEAT_TTL_MS + 1_000;
			await harness.daemon.refreshOwnershipHeartbeat(SESSION_ID);
			const persisted = await persistedTopic(agentDir, SESSION_ID);
			expect(persisted.leaseExpiresAt).toBe(nowRef.now + HEARTBEAT_TTL_MS);
		} finally {
			harness.daemon.requestStop();
		}
	});

	test("an expired lease owned by a foreign host is never re-armed", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const harness = await trustedAttachedSession(agentDir, { now: 1_000 });
		try {
			await mutatePersistedTopics(agentDir, topics => {
				topics.topics[SESSION_ID]!.leaseOwner = "foreign";
				topics.topics[SESSION_ID]!.leaseExpiresAt = 999;
			});
			await (harness.daemon as unknown as { loadTopics(): Promise<void> }).loadTopics();
			harness.daemon.refreshOwnershipHeartbeat(SESSION_ID);
			const persisted = await persistedTopic(agentDir, SESSION_ID);
			expect(persisted.leaseExpiresAt).toBe(999);
		} finally {
			harness.daemon.requestStop();
		}
	});

	test("a non-owner trusted attachment still fails closed after TTL expiry", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const harness = await trustedAttachedSession(agentDir, nowRef);
		try {
			await mutatePersistedTopics(agentDir, topics => {
				topics.topics[SESSION_ID]!.leaseOwner = "foreign";
				topics.topics[SESSION_ID]!.leaseExpiresAt = nowRef.now + HEARTBEAT_TTL_MS + 1_000;
			});
			await (harness.daemon as unknown as { loadTopics(): Promise<void> }).loadTopics();
			nowRef.now += HEARTBEAT_TTL_MS + 1_001;
			await expect(
				harness.send({ type: "turn_stream", phase: "finalized", text: "no" }, "lease-session:1:5"),
			).rejects.toThrow("trusted attachment lease is stale");
		} finally {
			harness.daemon.requestStop();
		}
	});

	test("a grace-window topic is resumed, not rejected, by its still-attached owner", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const harness = await trustedAttachedSession(agentDir, nowRef);
		harness.daemon.requestStop();
		await mutatePersistedTopics(agentDir, topics => {
			topics.topics[SESSION_ID]!.authorityState = "disconnect_grace";
			topics.topics[SESSION_ID]!.orphanedAt = nowRef.now - 1;
			topics.topics[SESSION_ID]!.disconnectGraceExpiresAt = nowRef.now + 1;
		});
		const bot = fakeBot();
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: HOST_ID,
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi: bot.bot,
			now: () => nowRef.now,
			installationHostId: HOST_ID,
		});
		try {
			await daemon.loadTopics();
			daemon.attachmentRoutingHarnessForTest().attach(notificationSubscription(SESSION_ID));
			const session = daemon.sessions.get(SESSION_ID);
			if (!session) throw new Error("Expected a routed Telegram attachment session.");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [],
			});
			expect(daemon.sessions.get(SESSION_ID)).toBe(session);
			const topic = await persistedTopic(agentDir, SESSION_ID);
			expect(topic.authorityState).toBe("active");
			expect(topic.leaseOwner).toBe(HOST_ID);
			expect(bot.calls.some(call => call.method === "createForumTopic")).toBe(false);
			await daemon.handleSessionMessage(
				session,
				{ type: "turn_stream", sessionId: SESSION_ID, phase: "finalized", text: "resumed" },
				"lease-session:1:3",
			);
			expect(bot.calls.filter(call => call.method === "sendMessage").at(-1)?.body.message_thread_id).toBe(555);
		} finally {
			daemon.requestStop();
		}
	});

	test("an archive-fenced topic is never re-armed by a live attachment", async () => {
		const agentDir = tempAgentDir();
		agentDirs.push(agentDir);
		const nowRef = { now: 1_000 };
		const harness = await trustedAttachedSession(agentDir, nowRef);
		try {
			await mutatePersistedTopics(agentDir, topics => {
				topics.topics[SESSION_ID]!.authorityState = "archive_pending";
				topics.topics[SESSION_ID]!.archiveReason = "session_closed";
			});
			await (harness.daemon as unknown as { loadTopics(): Promise<void> }).loadTopics();
			nowRef.now += HEARTBEAT_TTL_MS + 1_000;

			await expect(
				harness.send({ type: "turn_stream", phase: "finalized", text: "no" }, "lease-session:1:11"),
			).rejects.toThrow("trusted attachment lease is stale");
			expect((await persistedTopic(agentDir, SESSION_ID)).authorityState).toBe("archive_pending");
		} finally {
			harness.daemon.requestStop();
		}
	});
});
