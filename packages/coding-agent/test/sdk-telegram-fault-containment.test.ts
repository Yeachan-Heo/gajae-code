import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { parseTopicRegistryState, TopicRegistry } from "../src/sdk/bus/topic-registry";
import { type NotificationSubscription, SessionRouter, type SessionRouterClient } from "../src/sdk/router";

interface RouterHarness {
	router: SessionRouter;
	index: SessionIndex;
	sessionId: string;
	authority: { generation: number; pid: number; endpointMtimeMs: number; live: boolean };
	client: SessionRouterClient;
	emit(frame: Record<string, unknown>): void;
	subscription?: NotificationSubscription;
	frames: Record<string, unknown>[];
	root: string;
}

async function routerHarness(
	onSubscriptionFrame?: (subscription: NotificationSubscription, frame: unknown) => Promise<void>,
): Promise<RouterHarness> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-fault-"));
	const agentDir = path.join(root, ".gjc", "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "telegram-fault-session";
	const endpointFile = path.join(stateRoot, "sdk", `${sessionId}.json`);
	fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
	fs.writeFileSync(
		endpointFile,
		JSON.stringify({ sessionId, url: "ws://router.test", token: "secret", pid: process.pid }),
	);
	const endpointMtimeMs = fs.statSync(endpointFile).mtimeMs;
	const index = await new SessionIndex(agentDir).open();
	await index.append({
		type: "host_registered",
		sessionId,
		locator: { cwd: root, worktreeRoot: null, stateRoot },
		endpointGeneration: 7,
		pid: process.pid,
		endpointMtimeMs,
	});
	await index.append({
		type: "host_heartbeat",
		sessionId,
		locator: { cwd: root, worktreeRoot: null, stateRoot },
		endpointGeneration: 7,
		pid: process.pid,
		endpointMtimeMs,
		activity: { state: "active", at: 1 },
	});
	let receive: ((frame: Record<string, unknown>) => void) | undefined;
	let reconnect: (() => void) | undefined;
	const frames: Record<string, unknown>[] = [];
	const client: SessionRouterClient = {
		onFrame: handler => {
			receive = handler;
			return () => {
				if (receive === handler) receive = undefined;
			};
		},
		onReconnect: handler => {
			reconnect = handler;
			return () => {
				if (reconnect === handler) reconnect = undefined;
			};
		},
		request: async frame => {
			frames.push(frame);
			return frame.type === "event_replay" ? { ok: true, generation: 7, lastSeq: 0, events: [] } : { ok: true };
		},
		close: async () => undefined,
		send: frame => frames.push(frame),
	};
	let subscription: NotificationSubscription | undefined;
	const router = new SessionRouter({
		agentDir,
		deps: {
			createIndex: () => index,
			createClient: async () => client,
			onNotificationSubscription: value => {
				subscription = value;
			},
			onNotificationFrame: async (value, frame) => {
				if (onSubscriptionFrame) await onSubscriptionFrame(value, frame);
			},
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => undefined) as unknown as typeof clearInterval,
		},
	});
	await router.start();
	const readinessDeadline = Date.now() + 5_000;
	while ((!subscription || !router.attachment(sessionId)) && Date.now() < readinessDeadline) await Bun.sleep(5);
	if (!subscription || !router.attachment(sessionId)) {
		await router.stop();
		fs.rmSync(root, { recursive: true, force: true });
		throw new Error("Router did not publish Telegram and SDK capabilities before the readiness deadline");
	}
	return {
		router,
		index,
		sessionId,
		authority: { generation: 7, pid: process.pid, endpointMtimeMs, live: true },
		client,
		emit: frame => receive?.(frame),
		subscription,
		frames,
		root,
	};
}

async function dispose(harness: RouterHarness): Promise<void> {
	await harness.router.stop();
	fs.rmSync(harness.root, { recursive: true, force: true });
}

describe("Telegram fault containment on production Router and registry surfaces", () => {
	test.each([
		["poisoned replay", async (subscription: NotificationSubscription) => subscription.cancel("poisoned replay")],
		["replacement cleanup", async (subscription: NotificationSubscription) => subscription.cancel("replacement")],
	])("isolates %s while sibling SDK authority and active turn remain usable", async (_name, inject) => {
		const harness = await routerHarness();
		try {
			const subscription = harness.subscription;
			if (!subscription) throw new Error("Router did not publish notification subscription");
			const attachment = harness.router.attachment(harness.sessionId);
			if (!attachment) throw new Error("Router did not publish SDK attachment");
			const authorityId = attachment.authorityId;
			await inject(subscription);
			expect(
				await harness.router.request(
					harness.sessionId,
					{ type: "sdk_query", activeTurnId: "turn-7" },
					7,
					attachment,
				),
			).toEqual({ ok: true });
			expect(harness.router.attachment(harness.sessionId)?.authorityId).toBe(authorityId);
			expect(harness.router.attachment(harness.sessionId)?.isCurrent()).toBe(true);
			expect(subscription.isActive()).toBe(false);
		} finally {
			await dispose(harness);
		}
	});

	test("Telegram generation skew changes only its cursor while core authority and active turn remain usable", async () => {
		const harness = await routerHarness();
		try {
			const subscription = harness.subscription;
			const attachment = harness.router.attachment(harness.sessionId);
			if (!subscription || !attachment) throw new Error("Router did not publish both capabilities");
			const authorityId = attachment.authorityId;
			subscription.advanceCursor(99, 1);
			expect(subscription.cursor).toEqual({ generation: 99, seq: 1 });
			expect(
				await harness.router.request(
					harness.sessionId,
					{ type: "sdk_query", activeTurnId: "turn-7" },
					7,
					attachment,
				),
			).toEqual({ ok: true });
			expect(harness.router.attachment(harness.sessionId)?.authorityId).toBe(authorityId);
			expect(subscription.isActive()).toBe(true);
		} finally {
			await dispose(harness);
		}
	});

	test("hung Telegram callback is bounded to provider cleanup while core request remains dispatchable", async () => {
		const entered = Promise.withResolvers<void>();
		const harness = await routerHarness(async (_subscription, frame) => {
			if ((frame as { body?: { type?: string } }).body?.type === "telegram_hung") {
				entered.resolve();
				await new Promise<never>(() => undefined);
			}
		});
		try {
			const attachment = harness.router.attachment(harness.sessionId);
			if (!attachment) throw new Error("missing core attachment");
			const authorityId = attachment.authorityId;
			harness.emit({
				type: "event",
				sessionId: harness.sessionId,
				generation: 7,
				seq: 12,
				payload: { type: "telegram_hung" },
			});
			await entered.promise;
			await harness.router.request(harness.sessionId, { type: "sdk_query", activeTurnId: "turn-7" }, 7, attachment);
			expect(harness.router.attachment(harness.sessionId)?.authorityId).toBe(authorityId);
			expect(harness.router.attachment(harness.sessionId)?.isCurrent()).toBe(true);
		} finally {
			await dispose(harness);
		}
	});

	test("v2 endpoint-shaped input migrates without archiving and serialization has only Telegram binding", async () => {
		const state = parseTopicRegistryState({
			version: 2,
			topics: {
				s1: {
					topicId: "44",
					topicOrigin: "daemon_created",
					identitySent: true,
					createdAt: 1,
					authorityState: "active",
					chatId: "42",
					endpointKey: "ws://old",
					endpointDigest: "secret",
					endpointGeneration: 3,
					endpointIncarnation: 2,
					replayGeneration: 3,
					replaySeq: 8,
				},
			},
		});
		if (!state) throw new Error("migration returned no state");
		const registry = new TopicRegistry(state);
		expect(registry.get("s1")?.authorityState).toBe("active");
		expect(registry.replayCursor("s1")).toEqual({ generation: 3, seq: 8 });
		const serialized = JSON.stringify(registry.serialize());
		expect(serialized).not.toContain("endpointKey");
		expect(serialized).not.toContain("endpointDigest");
		expect(serialized).not.toContain("endpointGeneration");
		expect(serialized).not.toContain("endpointIncarnation");
		expect(registry.serialize().topics.s1.telegramBinding).toEqual({ chatId: "42", transport: "telegram" });
	});

	test("corrupt registry fails closed locally and explicit archive remains the only terminal transition", async () => {
		expect(() =>
			parseTopicRegistryState({
				version: 2,
				topics: {
					s1: {
						topicId: "1",
						identitySent: false,
						createdAt: 1,
						telegramBinding: { chatId: "42", transport: "discord" },
					},
				},
			}),
		).toThrow("malformed Telegram topic state");
		const registry = new TopicRegistry();
		await registry.getOrCreateTopic("s1", async () => "1");
		expect(registry.get("s1")?.authorityState).toBe("active");
		registry.beginArchive("s1", undefined, Date.now(), "session_closed");
		expect(registry.get("s1")?.authorityState).toBe("archive_pending");
	});
});
