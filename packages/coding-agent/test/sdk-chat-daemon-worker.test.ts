import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime, type ChatDaemonSdkClient } from "../src/sdk/bus/chat-daemon-runtime";
import { ChatEffectJournal } from "../src/sdk/bus/chat-effect-journal";
import { ConversationStore } from "../src/sdk/bus/conversation-store";
import type {
	DiscordInboundEvent,
	DiscordMessageComponent,
	DiscordProvider,
	DiscordThread,
} from "../src/sdk/bus/discord-provider";
import { type SlackConversation, slackConversationKey } from "../src/sdk/bus/slack-conversation";
import type { SlackProviderClient, SlackSocketEnvelope } from "../src/sdk/bus/slack-provider";
import { SdkClientError } from "../src/sdk/client/client";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

type SlackPost = { channel: string; text: string; threadTs?: string; clientMsgId: string };

class FakeSlackProvider implements SlackProviderClient {
	started = false;
	stopped = false;
	posts: SlackPost[] = [];
	#postWaiters: Array<{ count: number; predicate: (post: SlackPost) => boolean; resolve: () => void }> = [];
	handler: ((envelope: SlackSocketEnvelope) => void | Promise<void>) | undefined;

	async start(handler: (envelope: SlackSocketEnvelope) => void | Promise<void>): Promise<void> {
		this.started = true;
		this.handler = handler;
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	waitForPostCount(count: number, predicate: (post: SlackPost) => boolean): Promise<void> {
		if (this.posts.filter(predicate).length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#postWaiters.push({ count, predicate, resolve: waiter.resolve });
		return waiter.promise;
	}
	#resolvePostWaiters(): void {
		this.#postWaiters = this.#postWaiters.filter(waiter => {
			if (this.posts.filter(waiter.predicate).length < waiter.count) return true;
			waiter.resolve();
			return false;
		});
	}
	async ack(): Promise<void> {}
	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
	}): Promise<{ channel: string; ts: string; client_msg_id: string }> {
		this.posts.push(input);
		this.#resolvePostWaiters();
		return { channel: input.channel, ts: `1.${this.posts.length}`, client_msg_id: input.clientMsgId };
	}
	async findMessageByClientMsgId(): Promise<null> {
		return null;
	}
}

class FakeDiscordProvider implements DiscordProvider {
	readonly applicationId = "app";
	readonly botUserId = "bot";
	started = false;
	stopped = false;
	threads: DiscordThread[] = [];
	messages: Array<{ threadId: string; content: string; components?: DiscordMessageComponent[] }> = [];
	#threadWaiters: Array<{ count: number; resolve: () => void }> = [];
	#messageWaiters: Array<{
		predicate: (message: { threadId: string; content: string; components?: DiscordMessageComponent[] }) => boolean;
		resolve: () => void;
	}> = [];
	#archiveWaiters: Array<{ count: number; resolve: () => void }> = [];
	archives: string[] = [];
	handler: ((event: DiscordInboundEvent) => Promise<void>) | undefined;
	startupInbound: DiscordInboundEvent | undefined;

	waitForThreadCount(count: number): Promise<void> {
		if (this.threads.length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#threadWaiters.push({ count, resolve: waiter.resolve });
		return waiter.promise;
	}
	waitForMessage(
		predicate: (message: { threadId: string; content: string; components?: DiscordMessageComponent[] }) => boolean,
	): Promise<void> {
		if (this.messages.some(predicate)) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#messageWaiters.push({ predicate, resolve: waiter.resolve });
		return waiter.promise;
	}
	#resolveMessageWaiters(): void {
		this.#messageWaiters = this.#messageWaiters.filter(waiter => {
			if (!this.messages.some(waiter.predicate)) return true;
			waiter.resolve();
			return false;
		});
	}
	waitForArchiveCount(count: number): Promise<void> {
		if (this.archives.length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#archiveWaiters.push({ count, resolve: waiter.resolve });
		return waiter.promise;
	}
	#resolveArchiveWaiters(): void {
		this.#archiveWaiters = this.#archiveWaiters.filter(waiter => {
			if (this.archives.length < waiter.count) return true;
			waiter.resolve();
			return false;
		});
	}
	#resolveThreadWaiters(): void {
		this.#threadWaiters = this.#threadWaiters.filter(waiter => {
			if (this.threads.length < waiter.count) return true;
			waiter.resolve();
			return false;
		});
	}
	async createThread(input: {
		guildId: string;
		parentId: string;
		name: string;
		nonce: string;
	}): Promise<DiscordThread> {
		const thread = {
			id: `thread-${this.threads.length + 1}`,
			guildId: input.guildId,
			parentId: input.parentId,
			archived: false,
		};
		this.threads.push(thread);
		this.#resolveThreadWaiters();
		return thread;
	}
	async findThreadByNonce(): Promise<DiscordThread | null> {
		return null;
	}
	async findMessageByNonce(): Promise<{ id: string } | null> {
		return null;
	}
	async postMessage(input: {
		threadId: string;
		content: string;
		nonce?: string;
		components?: DiscordMessageComponent[];
	}): Promise<{ id: string }> {
		this.messages.push({
			threadId: input.threadId,
			content: input.content,
			...(input.components ? { components: input.components } : {}),
		});
		this.#resolveMessageWaiters();
		return { id: String(this.messages.length) };
	}
	async deferInteraction(): Promise<void> {}
	async archiveThread(input: { threadId: string }): Promise<void> {
		this.archives.push(input.threadId);
		this.#resolveArchiveWaiters();
	}
	async unarchiveThread(): Promise<void> {
		throw new Error("closed threads require replacement");
	}
	async start(onEvent: (event: DiscordInboundEvent) => Promise<void>): Promise<void> {
		this.started = true;
		this.handler = onEvent;
		if (this.startupInbound) await onEvent(this.startupInbound);
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
}

class FakeSdkClient implements ChatDaemonSdkClient {
	closed = false;
	sent: Record<string, unknown>[] = [];
	requests: Record<string, unknown>[] = [];
	handler: ((frame: Record<string, unknown>) => void) | undefined;
	#sentWaiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: () => void }> = [];
	#requestWaiters: Array<{ predicate: (frame: Record<string, unknown>) => boolean; resolve: () => void }> = [];
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void {
		this.handler = handler;
		return () => {
			this.handler = undefined;
		};
	}
	waitForSent(predicate: (frame: Record<string, unknown>) => boolean): Promise<void> {
		if (this.sent.some(predicate)) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#sentWaiters.push({ predicate, resolve: waiter.resolve });
		return waiter.promise;
	}
	waitForRequest(predicate: (frame: Record<string, unknown>) => boolean): Promise<void> {
		if (this.requests.some(predicate)) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#requestWaiters.push({ predicate, resolve: waiter.resolve });
		return waiter.promise;
	}
	#resolveRequestWaiters(): void {
		this.#requestWaiters = this.#requestWaiters.filter(waiter => {
			if (!this.requests.some(waiter.predicate)) return true;
			waiter.resolve();
			return false;
		});
	}
	#resolveSentWaiters(): void {
		this.#sentWaiters = this.#sentWaiters.filter(waiter => {
			if (!this.sent.some(waiter.predicate)) return true;
			waiter.resolve();
			return false;
		});
	}
	async request(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
		this.requests.push(frame);
		this.#resolveRequestWaiters();
		if (frame.type === "event_replay")
			return { events: [{ type: "event", name: "session_ready", sessionId: "session", generation: 1 }] };
		return { ok: true, result: { source: "sdk", body: "daemon-result-secret" } };
	}
	send(frame: Record<string, unknown>): void {
		this.sent.push(frame);
		this.#resolveSentWaiters();
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

describe("chat daemon worker", () => {
	let root = "";
	afterEach(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("creates a real configured runtime, maps event threads, routes safe replies, handles lifecycle transitions, and cleans up", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-worker-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const provider = new FakeDiscordProvider();
		const client = new FakeSdkClient();
		client.request = async frame => {
			client.requests.push(frame);
			if (frame.type === "event_replay")
				return {
					events: [
						{ type: "event", name: "session_ready", sessionId: "session", generation: 1 },
						{
							type: "event",
							name: "identity_header",
							payload: {
								type: "identity_header",
								sessionId: "session",
								title: "Replay identity",
								repo: "replay-repo",
								branch: "replay-branch",
							},
						},
					],
				};
			return { ok: true, result: { source: "sdk", body: "daemon-result-secret" } };
		};
		const startupInbound: DiscordInboundEvent = {
			id: "startup-query",
			guildId: "guild",
			parentId: "parent",
			threadId: "thread-1",
			authorId: "human",
			content: "/sdk query todo.list {}",
		};
		const brokerClient = new FakeSdkClient();
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "broker-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
		const runtime = new ChatDaemonRuntime(
			{
				kind: "discord",
				agentDir,
				config: {
					identity: "fingerprint-only",
					notifications: {
						discord: { botToken: "bot-token", applicationId: "app", guildId: "guild", parentChannelId: "parent" },
					},
				},
			},
			{
				createDiscordProvider: () => provider,
				createClient: async () => client,
				createBrokerClient: async () => brokerClient,
				createIndex: () => index,
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
			},
		);

		await runtime.start();
		await provider.handler?.(startupInbound);
		expect(provider.started).toBe(true);
		expect(client.requests).toContainEqual(
			expect.objectContaining({ type: "query_request", query: "todo.list", input: {} }),
		);
		expect(provider.threads).toHaveLength(1);
		const turnStreamPosted = provider.waitForMessage(message => message.content === "GJC turn stream\noutbound");
		expect(provider.messages).toContainEqual({
			threadId: "thread-1",
			content: "GJC identity header\ntitle: Replay identity\nrepo: replay-repo\nbranch: replay-branch",
		});
		client.handler?.({ type: "turn_stream", sessionId: "session", text: "outbound" });
		await turnStreamPosted;
		expect(provider.messages).toContainEqual({ threadId: "thread-1", content: "GJC turn stream\noutbound" });
		const actionPosted = provider.waitForMessage(message => message.components !== undefined);
		client.handler?.({
			type: "action_needed",
			sessionId: "session",
			id: "action",
			kind: "ask",
			question: "Continue?",
			options: ["safe"],
		});
		await actionPosted;
		const actionCustomId = provider.messages.find(message => message.components)?.components?.[0]?.components[0]
			?.customId;
		expect(actionCustomId).toBeDefined();
		const actionReplySent = client.waitForSent(frame => frame.type === "reply" && frame.id === "action");
		await provider.handler?.({
			id: "inbound",
			guildId: "guild",
			parentId: "parent",
			threadId: "thread-1",
			authorId: "human",
			interaction: { id: "interaction", token: "interaction-token", customId: actionCustomId!, value: "0" },
		});
		await actionReplySent;
		expect(client.sent).toContainEqual(expect.objectContaining({ type: "reply", id: "action", answer: 0 }));
		const queryRequest = client.waitForRequest(
			request => request.type === "query_request" && request.query === "todo.list",
		);
		const queryResult = provider.waitForMessage(
			message =>
				message.content === JSON.stringify({ ok: true, result: { operation: "todo.list", status: "completed" } }),
		);
		await provider.handler?.({
			id: "query",
			guildId: "guild",
			parentId: "parent",
			threadId: "thread-1",
			authorId: "human",
			content: "/sdk query todo.list {}",
		});
		await Promise.all([queryRequest, queryResult]);
		expect(provider.messages).toContainEqual({
			threadId: "thread-1",
			content: JSON.stringify({ ok: true, result: { operation: "todo.list", status: "completed" } }),
		});
		expect(JSON.stringify(provider.messages)).not.toContain("daemon-result-secret");
		const prohibitedResult = provider.waitForMessage(
			message =>
				message.content ===
				JSON.stringify({
					ok: false,
					error: { code: "unsupported_on_chat", message: "Command could not be completed." },
				}),
		);
		await provider.handler?.({
			id: "prohibited",
			guildId: "guild",
			parentId: "parent",
			threadId: "thread-1",
			authorId: "human",
			content: "/sdk global session.get_endpoint {}",
		});
		await prohibitedResult;
		expect(client.requests.some(request => request.operation === "session.get_endpoint")).toBe(false);
		expect(brokerClient.requests.some(request => request.operation === "session.get_endpoint")).toBe(false);
		expect(provider.messages).toContainEqual({
			threadId: "thread-1",
			content: JSON.stringify({
				ok: false,
				error: { code: "unsupported_on_chat", message: "Command could not be completed." },
			}),
		});
		for (const [id, content] of [
			["shell", '/sdk control bash.execute {"command":"echo daemon-result-secret"}'],
			["provider", "/sdk control host_tools.register {}"],
			["reverse", "/sdk reverse filesystem.read {}"],
			["secret", '/sdk control config.patch {"botToken":"daemon-result-secret"}'],
		] as const)
			await provider.handler?.({
				id,
				guildId: "guild",
				parentId: "parent",
				threadId: "thread-1",
				authorId: "human",
				content,
			});
		const prohibitedOperations = new Set(["bash.execute", "host_tools.register", "filesystem.read", "config.patch"]);
		expect(
			[...client.requests, ...brokerClient.requests].some(request =>
				prohibitedOperations.has(String(request.operation)),
			),
		).toBe(false);
		expect(JSON.stringify(provider.messages)).not.toContain("daemon-result-secret");
		const globalRequest = brokerClient.waitForRequest(
			request => request.type === "broker_request" && request.operation === "session.list",
		);
		const globalResult = provider.waitForMessage(
			message =>
				message.content ===
				JSON.stringify({ ok: true, result: { operation: "session.list", status: "completed" } }),
		);
		await provider.handler?.({
			id: "global",
			guildId: "guild",
			parentId: "parent",
			threadId: "thread-1",
			authorId: "human",
			content: "/sdk global session.list {}",
		});
		await Promise.all([globalRequest, globalResult]);
		expect(brokerClient.requests).toContainEqual(
			expect.objectContaining({
				type: "broker_request",
				operation: "session.list",
				input: {},
				idempotencyKey: expect.any(String),
			}),
		);
		expect(provider.messages).toContainEqual({
			threadId: "thread-1",
			content: JSON.stringify({ ok: true, result: { operation: "session.list", status: "completed" } }),
		});
		const archivedThread = provider.waitForArchiveCount(1);
		client.handler?.({
			type: "event",
			kind: "session_closed",
			payload: { type: "session_closed", sessionId: "session" },
		});
		await archivedThread;
		expect(provider.archives).toEqual(["thread-1"]);
		client.handler?.({ type: "event", name: "session_ready", sessionId: "session", generation: 2 });
		const replacementThread = provider.waitForThreadCount(2);
		client.handler?.({ type: "event", name: "session_ready", sessionId: "session", generation: 1 });
		await replacementThread;
		expect(provider.threads).toHaveLength(2);
		await runtime.stop();
		expect(client.closed).toBe(true);
		expect(provider.stopped).toBe(true);
	}, 20_000);

	it("fails closed when a replacement client cannot connect", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-replace-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "old-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const provider = new FakeDiscordProvider();
		const oldClient = new FakeSdkClient();
		let tick: (() => void) | undefined;
		const runtime = new ChatDaemonRuntime(
			{
				kind: "discord",
				agentDir,
				config: {
					identity: "fingerprint-only",
					notifications: {
						discord: { botToken: "bot-token", applicationId: "app", guildId: "guild", parentChannelId: "parent" },
					},
				},
			},
			{
				createDiscordProvider: () => provider,
				createClient: async endpoint => {
					if (endpoint.token === "new-token") throw new Error("replacement unavailable");
					return oldClient;
				},
				createIndex: () => index,
				setInterval: ((callback: () => void) => {
					tick = callback;
					return 0;
				}) as unknown as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
			},
		);
		await runtime.start();
		const lateOldFrame = oldClient.handler!;
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "new-token" }),
		);
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		tick?.();
		await Bun.sleep(10);
		expect(oldClient.closed).toBe(true);
		lateOldFrame({ type: "turn_stream", sessionId: "session", text: "stale" });
		await Bun.sleep(10);
		expect(provider.messages.some(message => message.content.includes("stale"))).toBe(false);
		await runtime.stop();
	});

	it("discards queued frames emitted by a replaced attachment", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-frame-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "old-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const provider = new FakeDiscordProvider();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let blockLookup = false;
		provider.findMessageByNonce = async () => {
			if (!blockLookup) return null;
			entered.resolve();
			await release.promise;
			return null;
		};
		const oldClient = new FakeSdkClient();
		const newClient = new FakeSdkClient();
		let tick: (() => void) | undefined;
		const runtime = new ChatDaemonRuntime(
			{
				kind: "discord",
				agentDir,
				config: {
					identity: "fingerprint-only",
					notifications: {
						discord: { botToken: "bot-token", applicationId: "app", guildId: "guild", parentChannelId: "parent" },
					},
				},
			},
			{
				createDiscordProvider: () => provider,
				createClient: async endpoint => (endpoint.token === "old-token" ? oldClient : newClient),
				createIndex: () => index,
				setInterval: ((callback: () => void) => {
					tick = callback;
					return 0;
				}) as unknown as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
			},
		);
		await runtime.start();
		blockLookup = true;
		oldClient.handler?.({ type: "turn_stream", sessionId: "session", text: "block" });
		await entered.promise;
		oldClient.handler?.({ type: "turn_stream", sessionId: "session", text: "stale queued" });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "new-token" }),
		);
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const replacementReplay = newClient.waitForRequest(frame => frame.type === "event_replay");
		tick?.();
		await replacementReplay;
		expect(oldClient.closed).toBe(true);
		expect(newClient.handler).toBeDefined();
		release.resolve();
		const freshDelivered = provider.waitForMessage(message => message.content.includes("fresh replacement"));
		newClient.handler?.({ type: "turn_stream", sessionId: "session", text: "fresh replacement" });
		await freshDelivered;
		expect(provider.messages.some(message => message.content.includes("fresh replacement"))).toBe(true);
		expect(provider.messages.some(message => message.content.includes("stale queued"))).toBe(false);
		await runtime.stop();
	});

	it("persists Slack action authority across restart, restores it for inbound replies, and clears resolved actions", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-slack-worker-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
		const readConversation = async (): Promise<SlackConversation | undefined> =>
			Object.values((await store.load()).conversations).find(record => record.sessionId === "session");
		const waitForConversation = async (predicate: (conversation: SlackConversation | undefined) => boolean) => {
			const deadline = Date.now() + 5_000;
			while (true) {
				const conversation = await readConversation();
				if (predicate(conversation)) return conversation;
				if (Date.now() >= deadline) throw new Error("Timed out waiting for durable Slack conversation state");
				await Bun.sleep(10);
			}
		};
		const runtimeInput = {
			kind: "slack" as const,
			agentDir,
			config: {
				identity: "fingerprint-only",
				notifications: {
					slack: {
						botToken: "bot-token",
						appToken: "app-token",
						workspaceId: "team",
						channelId: "channel",
						authorizedUserId: "human",
					},
				},
			},
		};
		const timerDeps = {
			createIndex: () => index,
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => {}) as typeof clearInterval,
		};
		const firstProvider = new FakeSlackProvider();
		const firstClient = new FakeSdkClient();
		const firstRuntime = new ChatDaemonRuntime(runtimeInput, {
			...timerDeps,
			createSlackProvider: () => firstProvider,
			createClient: async () => firstClient,
		});
		await firstRuntime.start();
		firstClient.handler?.({
			type: "action_needed",
			sessionId: "session",
			id: "action-before-restart",
			kind: "ask",
			question: "Continue?",
			options: ["safe"],
		});
		await waitForConversation(conversation => conversation?.pendingActionId === "action-before-restart");
		expect((await readConversation())?.pendingActionId).toBe("action-before-restart");
		await firstRuntime.stop();

		const restartedProvider = new FakeSlackProvider();
		const restartedClient = new FakeSdkClient();
		const restartedRuntime = new ChatDaemonRuntime(runtimeInput, {
			...timerDeps,
			createSlackProvider: () => restartedProvider,
			createClient: async () => restartedClient,
		});
		await restartedRuntime.start();
		const persisted = await readConversation();
		expect(persisted?.pendingActionId).toBe("action-before-restart");
		expect(persisted?.rootTs).toBeDefined();
		const replySent = restartedClient.waitForSent(
			frame => frame.type === "reply" && frame.id === "action-before-restart" && frame.answer === "safe",
		);
		await restartedProvider.handler?.({
			envelope_id: "reply-envelope",
			payload: {
				type: "events_api",
				event_id: "reply-event",
				team_id: "team",
				event: {
					type: "message",
					channel: "channel",
					ts: "2.1",
					thread_ts: persisted?.rootTs,
					user: "human",
					text: "safe",
					client_msg_id: "reply-id",
				},
			},
		});
		await replySent;
		expect(restartedClient.sent).toContainEqual(
			expect.objectContaining({ type: "reply", id: "action-before-restart", answer: "safe" }),
		);

		restartedClient.handler?.({
			type: "action_needed",
			sessionId: "session",
			id: "action-to-resolve",
			kind: "ask",
			question: "Again?",
			options: ["safe"],
		});
		await waitForConversation(conversation => conversation?.pendingActionId === "action-to-resolve");
		expect((await readConversation())?.pendingActionId).toBe("action-to-resolve");
		restartedClient.handler?.({ type: "action_resolved", sessionId: "session", id: "action-to-resolve" });
		await waitForConversation(conversation => conversation?.pendingActionId === undefined);
		await restartedRuntime.stop();
	});
	it("replays Slack control, query, and global commands with their durable receipt keys", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-slack-command-keys-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "broker-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
		const provider = new FakeSlackProvider();
		const client = new FakeSdkClient();
		const broker = new FakeSdkClient();
		const runtime = new ChatDaemonRuntime(
			{
				kind: "slack",
				agentDir,
				config: {
					identity: "fingerprint-only",
					notifications: {
						slack: {
							botToken: "bot-token",
							appToken: "app-token",
							workspaceId: "team",
							channelId: "channel",
							authorizedUserId: "human",
						},
					},
				},
			},
			{
				createSlackProvider: () => provider,
				createClient: async () => client,
				createBrokerClient: async () => broker,
				createIndex: () => index,
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
			},
		);
		await runtime.start();
		const rootTs = provider.posts[0]?.clientMsgId === undefined ? undefined : "1.1";
		expect(rootTs).toBeDefined();
		const command = (eventId: string, clientMsgId: string, text: string): SlackSocketEnvelope => ({
			envelope_id: `${eventId}-envelope`,
			payload: {
				type: "events_api",
				event_id: eventId,
				team_id: "team",
				event: {
					type: "message",
					channel: "channel",
					ts: `2.${eventId}`,
					thread_ts: rootTs,
					user: "human",
					text,
					client_msg_id: clientMsgId,
				},
			},
		});
		const controlReceived = client.waitForRequest(
			request => request.type === "control_request" && request.operation === "turn.abort",
		);
		const queryReceived = client.waitForRequest(
			request => request.type === "query_request" && request.query === "todo.list",
		);
		const globalReceived = broker.waitForRequest(
			request => request.type === "broker_request" && request.operation === "session.list",
		);
		provider.handler?.(command("control-event", "control-id", "/sdk control turn.abort {}"));
		provider.handler?.(command("query-event", "query-id", "/sdk query todo.list {}"));
		provider.handler?.(command("global-event", "global-id", "/sdk global session.list {}"));
		await Promise.all([controlReceived, queryReceived, globalReceived]);
		expect(client.requests).toContainEqual({
			type: "control_request",
			operation: "turn.abort",
			input: {},
			confirm: true,
			idempotencyKey: "slack:team:channel:1.1:human:control-event:control-id",
		});
		expect(client.requests).toContainEqual({
			type: "query_request",
			query: "todo.list",
			input: {},
			idempotencyKey: "slack:team:channel:1.1:human:query-event:query-id",
		});
		expect(broker.requests).toContainEqual({
			type: "broker_request",
			operation: "session.list",
			input: {},
			idempotencyKey: "slack:team:channel:1.1:human:global-event:global-id",
		});
		await Bun.sleep(10);
		expect(JSON.stringify(provider.posts)).not.toContain("daemon-result-secret");
		const requestsBeforeProhibited = client.requests.length;
		for (const [eventId, clientMsgId, text] of [
			["shell-event", "shell-id", '/sdk control bash.execute {"command":"echo daemon-result-secret"}'],
			["endpoint-event", "endpoint-id", "/sdk global session.get_endpoint {}"],
			["provider-event", "provider-id", "/sdk control host_uri.register {}"],
			["secret-event", "secret-id", '/sdk control config.patch {"appToken":"daemon-result-secret"}'],
			["reverse-event", "reverse-id", "/sdk reverse filesystem.read {}"],
		] as const)
			provider.handler?.(command(eventId, clientMsgId, text));
		await Bun.sleep(10);
		expect(client.requests).toHaveLength(requestsBeforeProhibited);
		expect(broker.requests).toHaveLength(1);
		await runtime.stop();
	});
	it("retains a sent control prompt as ambiguous when its SDK response is lost", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-command-response-loss-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const runtimeInput = {
			kind: "slack" as const,
			agentDir,
			config: {
				identity: "fingerprint-only",
				notifications: {
					slack: {
						botToken: "bot-token",
						appToken: "app-token",
						workspaceId: "team",
						channelId: "channel",
						authorizedUserId: "human",
					},
				},
			},
		};
		const timerDeps = {
			createIndex: () => index,
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => {}) as typeof clearInterval,
		};
		const firstProvider = new FakeSlackProvider();
		const firstClient = new FakeSdkClient();
		firstClient.request = async frame => {
			firstClient.requests.push(frame);
			if (frame.type === "event_replay")
				return { events: [{ type: "event", name: "session_ready", sessionId: "session", generation: 1 }] };
			throw new SdkClientError("connection_closed", "SDK connection closed after accepting the control request");
		};
		const firstRuntime = new ChatDaemonRuntime(runtimeInput, {
			...timerDeps,
			createSlackProvider: () => firstProvider,
			createClient: async () => firstClient,
		});
		await firstRuntime.start();
		const rootTs = "1.1";
		expect(firstProvider.posts).toHaveLength(1);
		await firstProvider.handler?.({
			envelope_id: "prompt-envelope",
			payload: {
				type: "events_api",
				event_id: "prompt-event",
				team_id: "team",
				event: {
					type: "message",
					channel: "channel",
					ts: "2.1",
					thread_ts: rootTs,
					user: "human",
					text: '/sdk control turn.prompt {"text":"accepted prompt"}',
					client_msg_id: "prompt-id",
				},
			},
		});
		expect(firstClient.requests).toContainEqual({
			type: "control_request",
			operation: "turn.prompt",
			input: { text: "accepted prompt" },
			confirm: true,
			idempotencyKey: "slack:team:channel:1.1:human:prompt-event:prompt-id",
		});
		const effectId = "inbound:team:channel:1.1:human:prompt-event:prompt-id";
		expect(await new ChatEffectJournal({ agentDir, transport: "slack" }).read(effectId)).toMatchObject({
			kind: "sdk.inbound.command",
			state: "uncertain",
			receipt: { status: "uncertain" },
		});
		await firstRuntime.stop();

		const restartedProvider = new FakeSlackProvider();
		const restartedClient = new FakeSdkClient();
		const restartedRuntime = new ChatDaemonRuntime(runtimeInput, {
			...timerDeps,
			createSlackProvider: () => restartedProvider,
			createClient: async () => restartedClient,
		});
		await restartedRuntime.start();
		expect(restartedClient.requests).toEqual([expect.objectContaining({ type: "event_replay" })]);
		expect(restartedClient.requests).not.toContainEqual(
			expect.objectContaining({ type: "control_request", operation: "turn.prompt" }),
		);
		await restartedRuntime.stop();
	});
	it("uses the production SdkClient loopback boundary while Discord remains fake", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-worker-wire-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		const token = "loopback-sdk-token";
		const frames: Record<string, unknown>[] = [];
		let socket: any;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(peer) {
					socket = peer;
					peer.send(JSON.stringify({ type: "hello", connectionId: "chat-worker-loopback" }));
				},
				message(peer, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					frames.push(frame);
					if (frame.type === "event_replay") {
						peer.send(
							JSON.stringify({
								type: "event_replay_response",
								id: frame.id,
								events: [
									{
										type: "action_needed",
										sessionId: "session",
										id: "wire-action",
										kind: "ask",
										question: "Continue?",
										options: ["safe"],
									},
								],
							}),
						);
						return;
					}
					peer.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							result: { source: "loopback", body: "loopback-result-secret" },
						}),
					);
				},
			},
		});
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({ sessionId: "session", url: `ws://127.0.0.1:${server.port}`, token }),
			);
			const index = await new SessionIndex(agentDir).open();
			await index.append({
				type: "host_registered",
				sessionId: "session",
				locator: { repo: root, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			const provider = new FakeDiscordProvider();
			const runtime = new ChatDaemonRuntime(
				{
					kind: "discord",
					agentDir,
					config: {
						identity: "fingerprint-only",
						notifications: {
							discord: {
								botToken: "bot-token",
								applicationId: "app",
								guildId: "guild",
								parentChannelId: "parent",
							},
						},
					},
				},
				{
					createDiscordProvider: () => provider,
					createIndex: () => index,
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			);
			const replayedThread = provider.waitForThreadCount(1);
			await runtime.start();
			expect(provider.started).toBe(true);
			await replayedThread;
			expect(provider.threads).toHaveLength(1);
			expect(frames).toContainEqual(expect.objectContaining({ type: "event_replay" }));

			const queryResultPosted = provider.waitForMessage(
				message =>
					message.threadId === "thread-1" &&
					message.content ===
						JSON.stringify({ ok: true, result: { operation: "todo.list", status: "completed" } }),
			);
			await provider.handler?.({
				id: "wire-query",
				guildId: "guild",
				parentId: "parent",
				threadId: "thread-1",
				authorId: "human",
				content: "/sdk query todo.list {}",
			});
			await queryResultPosted;
			expect(frames).toContainEqual(
				expect.objectContaining({ type: "query_request", query: "todo.list", input: {} }),
			);
			expect(
				provider.messages.some(
					message =>
						message.threadId === "thread-1" &&
						message.content ===
							JSON.stringify({ ok: true, result: { operation: "todo.list", status: "completed" } }),
				),
			).toBe(true);
			expect(JSON.stringify(provider.messages)).not.toContain("loopback-result-secret");

			socket.send(JSON.stringify({ type: "event", name: "session_ready", sessionId: "session", generation: 2 }));
			await Bun.sleep(10);
			expect(provider.threads).toHaveLength(1);
			await runtime.stop();
		} finally {
			server.stop(true);
		}
	});
	it("routes Slack safe queries through the production Session SDK host across generation and worker restart", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-slack-production-host-"));
		const agentDir = path.join(root, ".gjc", "agent");
		const host = await startProductionSdkHost(root);
		const endpointPath = path.join(root, ".gjc", "state", "sdk", `${host.sessionId}.json`);
		const index = await new SessionIndex(agentDir).open();
		let tick: (() => void) | undefined;
		const config = {
			identity: "fingerprint-only",
			notifications: {
				slack: {
					botToken: "bot-token",
					appToken: "app-token",
					workspaceId: "team",
					channelId: "channel",
					authorizedUserId: "human",
				},
			},
		};
		const command = (eventId: string): SlackSocketEnvelope => ({
			envelope_id: `${eventId}-envelope`,
			payload: {
				type: "events_api",
				event_id: eventId,
				team_id: "team",
				event: {
					type: "message",
					channel: "channel",
					ts: `2.${eventId}`,
					thread_ts: "root",
					user: "human",
					text: "/sdk query todo.list {}",
					client_msg_id: `${eventId}-message`,
				},
			},
		});
		const startRuntime = (provider: FakeSlackProvider, onReconciled?: () => void) =>
			new ChatDaemonRuntime(
				{ kind: "slack", agentDir, config },
				{
					createSlackProvider: () => provider,
					createIndex: () => index,
					onReconciled,
					setInterval: ((callback: () => void) => {
						tick = callback;
						return 0;
					}) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			);
		try {
			await index.append({
				type: "host_registered",
				sessionId: host.sessionId,
				locator: { repo: root, stateRoot: path.join(root, ".gjc", "state") },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
			const rootKey = slackConversationKey({ teamId: "team", channelId: "channel", rootTs: "root" });
			await store.write(rootKey, undefined, {
				generation: 1,
				state: "active",
				teamId: "team",
				channelId: "channel",
				rootTs: "root",
				sessionId: host.sessionId,
				endpointGeneration: 1,
				updatedAt: Date.now(),
				seenEventIds: [],
				seenContextIds: [],
				seenRetryKeys: [],
				seenInteractionIds: [],
				inboundDispatches: [],
			});

			const firstProvider = new FakeSlackProvider();
			const generationTwoReconciled = Promise.withResolvers<void>();
			let reconciliationCount = 0;
			const firstRuntime = startRuntime(firstProvider, () => {
				reconciliationCount++;
				if (reconciliationCount === 2) generationTwoReconciled.resolve();
			});
			await firstRuntime.start();
			const firstCommandResult = firstProvider.waitForPostCount(1, post =>
				post.text.includes('"operation":"todo.list"'),
			);
			await firstProvider.handler?.(command("first"));
			await firstCommandResult;
			expect(firstProvider.posts.filter(post => post.text.includes('"operation":"todo.list"'))).toHaveLength(1);

			await index.append({
				type: "host_registered",
				sessionId: host.sessionId,
				locator: { repo: root, stateRoot: path.join(root, ".gjc", "state") },
				endpointGeneration: 2,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			await store.transact(rootKey, current =>
				current
					? { ...current, generation: current.generation + 1, endpointGeneration: 2, updatedAt: Date.now() }
					: current,
			);
			expect(tick).toBeDefined();
			tick?.();
			await generationTwoReconciled.promise;
			const generationTwoCommandResult = firstProvider.waitForPostCount(2, post =>
				post.text.includes('"operation":"todo.list"'),
			);
			await firstProvider.handler?.(command("generation-two"));
			await generationTwoCommandResult;
			expect(firstProvider.posts.filter(post => post.text.includes('"operation":"todo.list"'))).toHaveLength(2);
			await firstRuntime.stop();
			expect(firstProvider.stopped).toBe(true);

			const restartedProvider = new FakeSlackProvider();
			const restartedRuntime = startRuntime(restartedProvider);
			const restartedCommandResult = restartedProvider.waitForPostCount(1, post =>
				post.text.includes('"operation":"todo.list"'),
			);
			await restartedRuntime.start();
			await restartedProvider.handler?.(command("after-restart"));
			await restartedCommandResult;
			expect(restartedProvider.posts.filter(post => post.text.includes('"operation":"todo.list"'))).toHaveLength(1);
			await restartedRuntime.stop();
			expect(restartedProvider.stopped).toBe(true);
		} finally {
			await host.stop();
		}
	}, 20_000);
});
