import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime } from "../src/sdk/bus/chat-daemon-runtime";
import { ChatEffectJournal } from "../src/sdk/bus/chat-effect-journal";
import { ConversationStore, conversationStorePath } from "../src/sdk/bus/conversation-store";
import type {
	DiscordInboundEvent,
	DiscordMessageComponent,
	DiscordProvider,
	DiscordThread,
} from "../src/sdk/bus/discord-provider";
import { type SlackConversation, slackConversationKey } from "../src/sdk/bus/slack-conversation";
import type { SlackProviderClient, SlackSocketEnvelope } from "../src/sdk/bus/slack-provider";
import { SdkClientError } from "../src/sdk/client/client";
import { type SessionRouterClient, sessionAttachmentAuthorityId } from "../src/sdk/router";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

type SlackPost = { channel: string; text: string; threadTs?: string; clientMsgId: string };

async function withStageTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(() => timeout.reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

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
	readonly stopEntered = Promise.withResolvers<void>();
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
		this.stopEntered.resolve();
	}
}

class FakeSdkClient implements SessionRouterClient {
	readonly closeEntered = Promise.withResolvers<void>();
	closed = false;
	sent: Record<string, unknown>[] = [];
	requests: Record<string, unknown>[] = [];
	handler: ((frame: Record<string, unknown>) => void) | undefined;
	replayEvents: Record<string, unknown>[] = [
		{ type: "event", name: "session_ready", sessionId: "session", generation: 1, seq: 1 },
	];
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
		if (frame.type === "event_replay") {
			const generation = typeof frame.sinceGeneration === "number" ? frame.sinceGeneration : 1;
			const events = this.replayEvents.map((event, index) =>
				event.type === "event"
					? { ...event, sessionId: event.sessionId ?? "session", generation, seq: index + 1 }
					: {
							type: "event",
							kind: event.type,
							sessionId: event.sessionId ?? "session",
							generation,
							seq: index + 1,
							payload: event,
						},
			);
			return { ok: true, generation, lastSeq: events.length, events };
		}
		return { ok: true, result: { source: "sdk", body: "daemon-result-secret" } };
	}
	send(frame: Record<string, unknown>): void {
		this.sent.push(frame);
		this.#resolveSentWaiters();
	}
	async close(): Promise<void> {
		this.closed = true;
		this.closeEntered.resolve();
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
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		await index.append({
			type: "host_heartbeat",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			activity: { state: "idle", at: Date.now() },
		});
		const provider = new FakeDiscordProvider();
		const client = new FakeSdkClient();
		client.replayEvents = [
			{ type: "event", name: "session_ready", sessionId: "session", generation: 1, seq: 1 },
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
			{
				type: "event",
				name: "turn_stream",
				payload: { type: "turn_stream", phase: "live", sessionId: "session", text: "replayed live" },
			},
		];
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
				routerDeps: {
					createClient: async () => client,
					createBrokerClient: async () => brokerClient,
					createIndex: () => index,
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			},
		);

		const replayedThread = provider.waitForThreadCount(1);
		await runtime.start();
		await client.waitForRequest(frame => frame.type === "event_replay");
		await replayedThread;
		await runtime.reconcile({ waitForReplay: true });
		expect(client.requests.filter(frame => frame.type === "event_replay")).toHaveLength(1);
		expect(provider.threads).toHaveLength(1);
		const startupQueryDispatched = client.waitForRequest(
			frame => frame.type === "query_request" && frame.query === "todo.list",
		);
		if (!provider.handler) throw new Error("Discord provider did not publish its inbound handler.");
		await withStageTimeout("startup Discord query", provider.handler(startupInbound));
		await withStageTimeout("startup SDK query dispatch", startupQueryDispatched);
		expect(provider.started).toBe(true);
		const startupQueries = client.requests.filter(
			frame => frame.type === "query_request" && frame.query === "todo.list",
		);
		expect(startupQueries).toHaveLength(1);
		expect(startupQueries[0]).toMatchObject({ type: "query_request", query: "todo.list", input: {} });
		const turnStreamPosted = provider.waitForMessage(message => message.content === "GJC turn stream\noutbound");
		expect(provider.messages).toContainEqual({
			threadId: "thread-1",
			content: "GJC identity header\ntitle: Replay identity\nrepo: replay-repo\nbranch: replay-branch",
		});
		client.handler?.({ type: "turn_stream", phase: "live", sessionId: "session", text: "direct live" });
		client.handler?.({
			type: "event",
			name: "turn_stream",
			payload: { type: "turn_stream", phase: "live", sessionId: "session", text: "wrapped live" },
		});
		await Bun.sleep(10);
		expect(provider.messages.some(message => /(?:replayed|direct|wrapped) live/.test(message.content))).toBe(false);
		client.handler?.({ type: "turn_stream", sessionId: "session", text: "outbound" });
		await turnStreamPosted;
		expect(provider.messages).toContainEqual({ threadId: "thread-1", content: "GJC turn stream\noutbound" });
		const finalizedTurnStreamPosted = provider.waitForMessage(
			message => message.content === "GJC turn stream\nfinalized",
		);
		client.handler?.({ type: "turn_stream", phase: "finalized", sessionId: "session", text: "finalized" });
		await finalizedTurnStreamPosted;
		const wrappedMissingPhasePosted = provider.waitForMessage(
			message => message.content === "GJC turn stream\nwrapped missing phase",
		);
		client.handler?.({
			type: "event",
			name: "turn_stream",
			payload: { type: "turn_stream", sessionId: "session", text: "wrapped missing phase" },
		});
		await wrappedMissingPhasePosted;
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
		const secondQueryKey = "discord:app:guild:parent:thread-1:query";
		const queryRequest = client.waitForRequest(
			request =>
				request.type === "query_request" &&
				request.query === "todo.list" &&
				request.idempotencyKey === secondQueryKey,
		);
		const queryResultBody = JSON.stringify({ ok: true, result: { operation: "todo.list", status: "completed" } });
		const queryResultBaseline = provider.messages.filter(message => message.content === queryResultBody).length;
		const queryResult = provider.waitForMessage(
			() => provider.messages.filter(message => message.content === queryResultBody).length > queryResultBaseline,
		);
		if (!provider.handler) throw new Error("Discord provider lost its inbound handler.");
		await provider.handler({
			id: "query",
			guildId: "guild",
			parentId: "parent",
			threadId: "thread-1",
			authorId: "human",
			content: "/sdk query todo.list {}",
		});
		await Promise.all([queryRequest, queryResult]);
		expect(client.requests.filter(request => request.idempotencyKey === secondQueryKey)).toHaveLength(1);
		expect(provider.messages.filter(message => message.content === queryResultBody)).toHaveLength(
			queryResultBaseline + 1,
		);
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
		const archivedThread = provider.waitForArchiveCount(1);
		client.handler?.({
			type: "event",
			kind: "session_closed",
			payload: { type: "session_closed", sessionId: "session" },
		});
		await archivedThread;
		expect(provider.archives).toEqual(["thread-1"]);
		client.handler?.({ type: "event", name: "session_ready", sessionId: "session", generation: 2, seq: 4 });
		const replacementThread = provider.waitForThreadCount(2);
		client.handler?.({ type: "event", name: "session_ready", sessionId: "session", generation: 1, seq: 5 });
		await replacementThread;
		expect(provider.threads).toHaveLength(2);
		await runtime.stop();
		expect(client.closed).toBe(true);
		expect(provider.stopped).toBe(true);
	}, 20_000);

	it("uses the broker-authorized isolated chat endpoint", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-isolated-endpoint-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "chat", "sdk", "session.json");
		const defaultEndpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "chat-only-token" }),
		);
		await fs.mkdir(path.dirname(defaultEndpointPath), { recursive: true });
		await fs.writeFile(
			defaultEndpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:2", token: "shared-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(stateRoot, "chat") },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const provider = new FakeDiscordProvider();
		const client = new FakeSdkClient();
		let attachedAuthority: Record<string, unknown> | undefined;
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
				routerDeps: {
					createClient: async authority => {
						attachedAuthority = authority;
						return client;
					},
					createIndex: () => index,
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			},
		);
		await runtime.start();
		expect(attachedAuthority).toMatchObject({ sessionId: "session", generation: 1 });
		expect(attachedAuthority).not.toHaveProperty("token");
		await runtime.stop();
	});

	it("rejects a discovery record replaced after broker registration", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-endpoint-mtime-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "authorized-token" }),
		);
		const authorizedMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: authorizedMtimeMs,
		});
		await fs.writeFile(
			endpointPath,
			JSON.stringify({
				sessionId: "session",
				pid: process.pid,
				url: "ws://127.0.0.1:2",
				token: "substituted-token",
			}),
		);
		const later = new Date(authorizedMtimeMs + 2_000);
		await fs.utimes(endpointPath, later, later);
		let connected = false;
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
				createDiscordProvider: () => new FakeDiscordProvider(),
				routerDeps: {
					createClient: async () => {
						connected = true;
						return new FakeSdkClient();
					},
					createIndex: () => index,
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			},
		);
		await runtime.start();
		expect(connected).toBe(false);
		await runtime.stop();
	});

	it("fails closed when a replacement client cannot connect", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-replace-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "old-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		const provider = new FakeDiscordProvider();
		const oldClient = new FakeSdkClient();
		let tick: (() => void) | undefined;
		let createClientCalls = 0;
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
				routerDeps: {
					createClient: async () => {
						if (++createClientCalls === 2) throw new Error("replacement unavailable");
						return oldClient;
					},
					createIndex: () => index,
					setInterval: ((callback: () => void) => {
						tick = callback;
						return 0;
					}) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			},
		);
		await runtime.start();
		const lateOldFrame = oldClient.handler!;
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "new-token" }),
		);
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});
		tick?.();
		for (let attempt = 0; attempt < 2_000 && !oldClient.closed; attempt++) await Bun.sleep(1);
		expect(oldClient.closed).toBe(true);
		lateOldFrame({ type: "turn_stream", sessionId: "session", text: "stale" });
		await Bun.sleep(10);
		expect(provider.messages.some(message => message.content.includes("stale"))).toBe(false);
		await runtime.stop();
	});

	it("discards queued frames emitted by a same-generation successor attachment", async () => {
		const scenarios = [
			{ name: "same-generation first pass", generation: 1, stopDuringTakeover: false, retirementFails: false },
			{ name: "same-generation repeated pass", generation: 1, stopDuringTakeover: false, retirementFails: false },
			{ name: "same-generation worker shutdown", generation: 1, stopDuringTakeover: true, retirementFails: false },
			{
				name: "same-generation retirement failure",
				generation: 1,
				stopDuringTakeover: false,
				retirementFails: true,
			},
			{ name: "cross-generation replacement", generation: 2, stopDuringTakeover: false, retirementFails: false },
		] as const;
		for (const scenario of scenarios) {
			root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-frame-"));
			const agentDir = path.join(root, "agent");
			const stateRoot = path.join(root, ".gjc", "state");
			const endpointPath = path.join(stateRoot, "sdk", "session.json");
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "old-token" }),
			);
			const index = await new SessionIndex(agentDir).open();
			await index.append({
				type: "host_registered",
				sessionId: "session",
				locator: { cwd: root, worktreeRoot: null, stateRoot },
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
			newClient.replayEvents = [
				{ type: "event", name: "session_ready", sessionId: "session", generation: scenario.generation, seq: 1 },
			];
			let tick: (() => void) | undefined;
			let createClientCalls = 0;
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
					routerDeps: {
						createClient: async () => (++createClientCalls === 1 ? oldClient : newClient),
						createIndex: () => index,
						setInterval: ((callback: () => void) => {
							tick = callback;
							return 0;
						}) as unknown as typeof setInterval,
						clearInterval: (() => {}) as typeof clearInterval,
					},
				},
			);
			await runtime.start();
			await oldClient.waitForRequest(frame => frame.type === "event_replay");
			await runtime.reconcile({ waitForReplay: true });
			if (scenario.retirementFails) {
				await fs.chmod(path.dirname(conversationStorePath(agentDir, "discord")), 0o500);
			} else {
				blockLookup = true;
				oldClient.handler?.({ type: "turn_stream", sessionId: "session", text: `blocked ${scenario.name}` });
				await withStageTimeout("blocked frame lookup", entered.promise);
				oldClient.handler?.({ type: "turn_stream", sessionId: "session", text: `stale queued ${scenario.name}` });
			}
			await fs.writeFile(
				endpointPath,
				JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "new-token" }),
			);
			await index.append({
				type: "host_registered",
				sessionId: "session",
				locator: { cwd: root, worktreeRoot: null, stateRoot },
				endpointGeneration: scenario.generation,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			tick?.();
			if (scenario.retirementFails) {
				await withStageTimeout("failed successor attachment close", newClient.closeEntered.promise);
				expect(newClient.handler).toBeUndefined();
				await fs.chmod(path.dirname(conversationStorePath(agentDir, "discord")), 0o700);
				await runtime.reconcile({ waitForReplay: true });
				await withStageTimeout("worker shutdown after retirement failure", runtime.stop());
				expect(provider.messages.some(message => message.content.includes(`blocked ${scenario.name}`))).toBe(false);
				expect(provider.messages.some(message => message.content.includes(`stale queued ${scenario.name}`))).toBe(
					false,
				);
				await fs.rm(root, { recursive: true, force: true });
				root = "";
				continue;
			}
			const replacementReplay = newClient.waitForRequest(frame => frame.type === "event_replay");
			await withStageTimeout("successor event replay", replacementReplay);
			expect(oldClient.closed).toBe(true);
			expect(newClient.handler).toBeDefined();
			const freshContent = `fresh replacement ${scenario.name}`;
			if (scenario.stopDuringTakeover) {
				newClient.handler?.({ type: "turn_stream", sessionId: "session", text: freshContent });
				const stopping = runtime.stop();
				await provider.stopEntered.promise;
				release.resolve();
				await withStageTimeout("worker shutdown after successor takeover", stopping);
			} else {
				const freshDelivered = provider.waitForMessage(message => message.content.includes(freshContent));
				newClient.handler?.({ type: "turn_stream", sessionId: "session", text: freshContent });
				release.resolve();
				await withStageTimeout("successor frame delivery", freshDelivered);
				expect(provider.messages.some(message => message.content.includes(freshContent))).toBe(true);
				await runtime.stop();
			}
			expect(provider.messages.some(message => message.content.includes(`blocked ${scenario.name}`))).toBe(false);
			expect(provider.messages.some(message => message.content.includes(`stale queued ${scenario.name}`))).toBe(
				false,
			);
			await fs.rm(root, { recursive: true, force: true });
			root = "";
		}
	}, 60_000);

	it("persists Slack action authority across restart, restores it for inbound replies, and clears resolved actions", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-slack-worker-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
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
		const routerDeps = {
			createIndex: () => index,
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => {}) as typeof clearInterval,
		};
		const firstProvider = new FakeSlackProvider();
		const firstClient = new FakeSdkClient();
		const firstRuntime = new ChatDaemonRuntime(runtimeInput, {
			routerDeps: { ...routerDeps, createClient: async () => firstClient },
			createSlackProvider: () => firstProvider,
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
			routerDeps: { ...routerDeps, createClient: async () => restartedClient },
			createSlackProvider: () => restartedProvider,
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
		const idleDelivered = restartedProvider.waitForPostCount(1, post => post.text.includes("Agent idle"));
		restartedClient.handler?.({
			type: "action_needed",
			sessionId: "session",
			id: "idle:session#1",
			kind: "idle",
			question: "Agent idle",
			options: [],
		});
		await idleDelivered;
		expect((await readConversation())?.pendingActionId).toBeUndefined();
		const userMessageSent = restartedClient.waitForSent(
			frame => frame.type === "user_message" && frame.sessionId === "session" && frame.text === "next task",
		);
		await restartedProvider.handler?.({
			envelope_id: "user-message-envelope",
			payload: {
				type: "event_callback",
				event_id: "user-message-event",
				team_id: "team",
				event: {
					type: "message",
					channel: "channel",
					ts: "3.1",
					thread_ts: persisted?.rootTs,
					user: "human",
					text: "next task",
					client_msg_id: "user-message-id",
				},
			},
		});
		await userMessageSent;
		await restartedRuntime.stop();
	});
	// Wider timeout than bun:test's 5000ms default: this exercises a full
	// durable SessionIndex + ChatDaemonRuntime lifecycle with three concurrent
	// request waiters and occasionally exceeds 5s under CI shard contention
	// (observed timeout in dev CI run 30291963270, shard 2); reproduced
	// deterministically passing in 1.3-6.4s locally with no polling/race in
	// the waiter mechanism, so this raises budget rather than masking a hang.
	it("replays Slack control, query, and global commands with their durable receipt keys", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-slack-command-keys-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
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
		client.replayEvents = [
			{ type: "event", name: "session_ready", sessionId: "session", generation: 1, seq: 1 },
			{ type: "turn_stream", phase: "live", sessionId: "session", text: "replayed live" },
			{ type: "turn_stream", phase: "finalized", sessionId: "session", text: "replayed finalized" },
			{ type: "turn_stream", sessionId: "session", text: "replayed missing phase" },
		];
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
				routerDeps: {
					createClient: async () => client,
					createBrokerClient: async () => broker,
					createIndex: () => index,
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval,
				},
			},
		);
		await runtime.start();
		await provider.waitForPostCount(1, post => post.text === "GJC turn stream\nreplayed finalized");
		await provider.waitForPostCount(1, post => post.text === "GJC turn stream\nreplayed missing phase");
		client.handler?.({ type: "turn_stream", phase: "live", sessionId: "session", text: "direct live" });
		client.handler?.({
			type: "event",
			name: "turn_stream",
			payload: { type: "turn_stream", phase: "live", sessionId: "session", text: "wrapped live" },
		});
		await Bun.sleep(10);
		expect(provider.posts.some(post => /(?:replayed|direct|wrapped) live/.test(post.text))).toBe(false);
		client.handler?.({ type: "turn_stream", phase: "finalized", sessionId: "session", text: "direct finalized" });
		client.handler?.({ type: "turn_stream", sessionId: "session", text: "direct missing phase" });
		await provider.waitForPostCount(1, post => post.text === "GJC turn stream\ndirect finalized");
		await provider.waitForPostCount(1, post => post.text === "GJC turn stream\ndirect missing phase");
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
	}, 20000);
	it("retains a sent control prompt as ambiguous when its SDK response is lost", async () => {
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-chat-command-response-loss-"));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", "session.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "session", pid: process.pid, url: "ws://127.0.0.1:1", token: "endpoint-token" }),
		);
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "session",
			locator: { cwd: root, worktreeRoot: null, stateRoot },
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
		const routerDeps = {
			createIndex: () => index,
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => {}) as typeof clearInterval,
		};
		const firstProvider = new FakeSlackProvider();
		const firstClient = new FakeSdkClient();
		firstClient.request = async frame => {
			firstClient.requests.push(frame);
			if (frame.type === "event_replay")
				return {
					ok: true,
					generation: 1,
					lastSeq: 1,
					events: [{ type: "event", name: "session_ready", sessionId: "session", generation: 1, seq: 1 }],
				};
			throw new SdkClientError("uncertain_after_send", "SDK connection closed after accepting the control request");
		};
		const firstRuntime = new ChatDaemonRuntime(runtimeInput, {
			routerDeps: { ...routerDeps, createClient: async () => firstClient },
			createSlackProvider: () => firstProvider,
		});

		const firstReadyPost = firstProvider.waitForPostCount(1, post => post.threadTs === undefined);
		await firstRuntime.start();
		await firstReadyPost;
		await firstRuntime.reconcile({ waitForReplay: true });
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
			routerDeps: { ...routerDeps, createClient: async () => restartedClient },
			createSlackProvider: () => restartedProvider,
		});
		await restartedRuntime.start();
		await restartedClient.waitForRequest(frame => frame.type === "event_replay");
		await restartedRuntime.reconcile({ waitForReplay: true });
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
						const generation = typeof frame.sinceGeneration === "number" ? frame.sinceGeneration : 1;
						peer.send(
							JSON.stringify({
								type: "event_replay_response",
								id: frame.id,
								ok: true,
								generation,
								lastSeq: 1,
								events: [
									{
										type: "event",
										kind: "action_needed",
										sessionId: "session",
										generation,
										seq: 1,
										payload: {
											type: "action_needed",
											sessionId: "session",
											id: "wire-action",
											kind: "ask",
											question: "Continue?",
											options: ["safe"],
										},
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
				JSON.stringify({ sessionId: "session", pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token }),
			);
			const index = await new SessionIndex(agentDir).open();
			await index.append({
				type: "host_registered",
				sessionId: "session",
				locator: { cwd: root, worktreeRoot: null, stateRoot },
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
					routerDeps: {
						createIndex: () => index,
						setInterval: (() => 0) as unknown as typeof setInterval,
						clearInterval: (() => {}) as typeof clearInterval,
					},
				},
			);
			const replayedThread = provider.waitForThreadCount(1);
			await runtime.start();
			expect(provider.started).toBe(true);
			await replayedThread;
			await runtime.reconcile({ waitForReplay: true });
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

			socket.send(
				JSON.stringify({ type: "event", name: "session_ready", sessionId: "session", generation: 2, seq: 1 }),
			);
			await Bun.sleep(10);
			expect(provider.threads).toHaveLength(1);
			await runtime.stop();
		} finally {
			server.stop(true);
		}
	});
	// Full CI executes this production broker/host integration in its own task. Running
	// it after hundreds of unrelated tests in one Bun process can starve its broker
	// request boundary; the isolated task still exercises the real process topology.
	const skipProductionSessionHost =
		process.env.AFFECTED_TASK_KEY?.startsWith("test:@gajae-code/coding-agent:shard-") ?? false;
	const productionSessionHostTestName =
		"routes Slack safe queries through the production Session SDK host across worker restart";
	it.skipIf(skipProductionSessionHost)(
		productionSessionHostTestName,
		async () => {
			root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-slack-production-host-"));
			const agentDir = path.join(root, ".gjc", "agent");
			const host = await startProductionSdkHost(root);
			const endpointIdentity = await fs.stat(path.join(root, ".gjc", "state", "sdk", `${host.sessionId}.json`), {
				bigint: true,
			});
			const index = await new SessionIndex(agentDir).open();
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
						routerDeps: {
							createIndex: () => index,
							onReconciled,
							setInterval: (() => 0) as unknown as typeof setInterval,
							clearInterval: (() => {}) as typeof clearInterval,
						},
					},
				);
			try {
				await index.append({
					type: "host_registered",
					sessionId: host.sessionId,
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					endpointGeneration: 1,
					pid: host.endpoint.pid,
					endpointMtimeMs: host.endpointMtimeMs,
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
					// Derive through the Router's identity helper using the exact host
					// process tuple; hand-rolled or test-runner pids create stale roots.
					attachmentAuthorityId: sessionAttachmentAuthorityId({
						sessionId: host.sessionId,
						generation: 1,
						pid: host.endpoint.pid,
						endpointMtimeMs: host.endpointMtimeMs,
						url: host.endpoint.url,
						token: host.endpoint.token,
						endpointIdentity: {
							mtimeMs: host.endpointMtimeMs,
							mtimeNs: endpointIdentity.mtimeNs,
							ctimeNs: endpointIdentity.ctimeNs,
							size: endpointIdentity.size,
							ino: endpointIdentity.ino,
						},
					}),
					updatedAt: Date.now(),
					seenEventIds: [],
					seenContextIds: [],
					seenRetryKeys: [],
					seenInteractionIds: [],
					inboundDispatches: [],
				});

				const firstProvider = new FakeSlackProvider();
				const firstRuntime = startRuntime(firstProvider);
				await withStageTimeout("first runtime start", firstRuntime.start());
				await withStageTimeout("first runtime admission", firstRuntime.reconcile({ waitForReplay: true }));
				const firstCommandResult = firstProvider.waitForPostCount(1, post =>
					post.text.includes('"operation":"todo.list"'),
				);
				await firstProvider.handler?.(command("first"));
				await withStageTimeout("first Slack SDK result", firstCommandResult);
				expect(firstProvider.posts.filter(post => post.text.includes('"operation":"todo.list"'))).toHaveLength(1);

				await withStageTimeout("first runtime stop", firstRuntime.stop());
				expect(firstProvider.stopped).toBe(true);

				const restartedProvider = new FakeSlackProvider();
				const restartedRuntime = startRuntime(restartedProvider);
				const restartedCommandResult = restartedProvider.waitForPostCount(1, post =>
					post.text.includes('"operation":"todo.list"'),
				);
				await withStageTimeout("restarted runtime start", restartedRuntime.start());
				await withStageTimeout("restarted runtime admission", restartedRuntime.reconcile({ waitForReplay: true }));
				await restartedProvider.handler?.(command("after-restart"));
				await withStageTimeout("restarted Slack SDK result", restartedCommandResult);
				expect(restartedProvider.posts.filter(post => post.text.includes('"operation":"todo.list"'))).toHaveLength(
					1,
				);
				await withStageTimeout("restarted runtime stop", restartedRuntime.stop());
				expect(restartedProvider.stopped).toBe(true);
			} finally {
				await withStageTimeout("production SDK host stop", host.stop());
			}
		},
		60_000,
	);
});
