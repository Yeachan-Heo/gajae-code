import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatDeliveryError } from "../src/sdk/bus/chat-daemon-runtime";
import { ChatEffectJournal } from "../src/sdk/bus/chat-effect-journal";
import { ConversationStore } from "../src/sdk/bus/conversation-store";
import type { SlackConversation } from "../src/sdk/bus/slack-conversation";
import { type SlackEndpoint, SlackEndpointBindingError, SlackNotificationDaemon } from "../src/sdk/bus/slack-daemon";
import { SlackProviderError } from "../src/sdk/bus/slack-live-provider";
import { SlackProvider, type SlackSocketEnvelope } from "../src/sdk/bus/slack-provider";
import { SdkClientError } from "../src/sdk/client/client";

class FakeSlack {
	handler: ((envelope: SlackSocketEnvelope) => void | Promise<void>) | undefined;
	acks: string[] = [];
	posts: Array<{ channel: string; text: string; threadTs?: string; clientMsgId: string }> = [];
	knownMessages = new Map<string, { channel: string; ts: string; client_msg_id: string }>();
	failPost = false;
	failPostAfterAccept = false;
	failPostProtocolAfterAccept = false;
	failStart = false;
	failFinds = 0;
	onAck?: (envelopeId: string) => Promise<void>;
	postGate?: Promise<void>;
	startGate?: Promise<void>;
	startUntilStopped = false;
	postStarts = 0;
	#postStartWaiters: Array<{ count: number; resolve: () => void }> = [];
	#startWaiters: Array<{ count: number; resolve: () => void }> = [];
	#startStopGate = Promise.withResolvers<void>();
	startCalls = 0;
	stops = 0;
	onFind?: (clientMsgId: string) => Promise<void>;
	onStart?: (handler: (envelope: SlackSocketEnvelope) => void | Promise<void>) => Promise<void>;

	async start(handler: (envelope: SlackSocketEnvelope) => void | Promise<void>): Promise<void> {
		this.startCalls++;
		this.#resolveStartWaiters();
		if (this.failStart) throw new Error("Socket Mode disconnected");
		if (this.startUntilStopped) await this.#startStopGate.promise;
		else await this.startGate;
		this.handler = handler;
		await this.onStart?.(handler);
	}

	async stop(): Promise<void> {
		this.stops++;
		this.#startStopGate.resolve();
	}

	async ack(envelopeId: string): Promise<void> {
		this.acks.push(envelopeId);
		await this.onAck?.(envelopeId);
	}

	waitForPostStartCount(count: number): Promise<void> {
		if (this.postStarts >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#postStartWaiters.push({ count, resolve: waiter.resolve });
		return waiter.promise;
	}
	waitForStartCount(count: number): Promise<void> {
		if (this.startCalls >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		this.#startWaiters.push({ count, resolve: waiter.resolve });
		return waiter.promise;
	}
	#resolveStartWaiters(): void {
		this.#startWaiters = this.#startWaiters.filter(waiter => {
			if (this.startCalls < waiter.count) return true;
			waiter.resolve();
			return false;
		});
	}
	#resolvePostStartWaiters(): void {
		this.#postStartWaiters = this.#postStartWaiters.filter(waiter => {
			if (this.postStarts < waiter.count) return true;
			waiter.resolve();
			return false;
		});
	}

	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
	}): Promise<{ channel: string; ts: string; client_msg_id: string }> {
		this.postStarts++;
		this.#resolvePostStartWaiters();
		await this.postGate;
		if (this.failPost) throw new Error("Slack rate limited");
		this.posts.push(input);
		const message = { channel: input.channel, ts: `1.${this.posts.length}`, client_msg_id: input.clientMsgId };
		this.knownMessages.set(input.clientMsgId, message);
		if (this.failPostAfterAccept) {
			this.failPostAfterAccept = false;
			throw new SlackProviderError("connection", "chat.postMessage");
		}
		if (this.failPostProtocolAfterAccept) {
			this.failPostProtocolAfterAccept = false;
			throw new SlackProviderError("protocol", "chat.postMessage", undefined, undefined, true);
		}
		return message;
	}

	async findMessageByClientMsgId(input: {
		clientMsgId: string;
	}): Promise<{ channel: string; ts: string; client_msg_id: string } | null> {
		if (this.failFinds > 0) {
			this.failFinds--;
			throw new SlackProviderError("connection", "chat.postMessage");
		}

		await this.onFind?.(input.clientMsgId);
		return this.knownMessages.get(input.clientMsgId) ?? null;
	}
}

function endpoint(sessionId: string, generation = 1): SlackEndpoint {
	return { sessionId, url: "ws://localhost", token: "not-persisted", path: "", generation };
}

type LoadBarrier = {
	remaining: number;
	gate: Promise<void>;
	onBlocked: () => void;
};

class BlockingSlackStore extends ConversationStore<SlackConversation> {
	constructor(
		agentDir: string,
		private readonly barrier: LoadBarrier,
	) {
		super({ agentDir, kind: "slack" });
	}

	async load() {
		const document = await super.load();
		if (this.barrier.remaining > 0) {
			this.barrier.remaining--;
			this.barrier.onBlocked();
			await this.barrier.gate;
		}
		return document;
	}
}

async function withDaemon(
	run: (
		daemon: SlackNotificationDaemon,
		fake: FakeSlack,
		injected: Array<Record<string, unknown>>,
		setEndpointGeneration: (generation: number) => void,
		agentDir: string,
	) => Promise<void>,
	options: {
		onCommand?: (sessionId: string, content: string) => Promise<boolean>;
		createClient?: (injected: Array<Record<string, unknown>>) => { send(frame: Record<string, unknown>): void };
		authorizeActor?: ((actorId: string) => boolean | Promise<boolean>) | false;
	} = {},
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-daemon-"));
	let daemon: SlackNotificationDaemon | undefined;
	try {
		const fake = new FakeSlack();
		const injected: Array<Record<string, unknown>> = [];
		let endpointGeneration = 1;
		let id = 0;
		daemon = new SlackNotificationDaemon({
			agentDir,
			repo: agentDir,
			teamId: "T1",
			channelId: "C1",
			provider: new SlackProvider(fake),
			randomId: () => `client-id-${++id}`,
			createClient: () =>
				options.createClient?.(injected) ?? {
					send(frame: Record<string, unknown>) {
						injected.push(frame);
					},
				},
			resolveEndpoint: async sessionId => endpoint(sessionId, endpointGeneration),
			onCommand: options.onCommand,
			...(options.authorizeActor === false
				? {}
				: { authorizeActor: options.authorizeActor ?? (async actorId => actorId === "U1") }),
		});
		await run(
			daemon,
			fake,
			injected,
			generation => {
				endpointGeneration = generation;
			},
			agentDir,
		);
	} finally {
		await daemon?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

function messageEnvelope(
	envelopeId: string,
	eventId: string,
	rootTs: string,
	overrides: { actorId?: string; clientMsgId?: string; eventContext?: string; text?: string } = {},
): SlackSocketEnvelope {
	return {
		envelope_id: envelopeId,
		payload: {
			type: "events_api",
			event_id: eventId,
			event_context: overrides.eventContext,
			team_id: "T1",
			event: {
				type: "message",
				channel: "C1",
				ts: `2.${eventId}`,
				thread_ts: rootTs,
				user: overrides.actorId ?? "U1",
				text: overrides.text ?? "reply",
				client_msg_id: overrides.clientMsgId,
			},
		},
	};
}

describe("SlackNotificationDaemon fake-provider acceptance", () => {
	it("acknowledges accepted, rejected, and duplicate envelopes before their outcome", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "event-1");
			const accepted = await daemon.handleEnvelope(messageEnvelope("accepted", "event-1", root.rootTs!));
			const rejected = await daemon.handleEnvelope({ envelope_id: "rejected", payload: { type: "unsupported" } });
			const duplicate = await daemon.handleEnvelope(messageEnvelope("duplicate", "event-1", root.rootTs!));
			expect([accepted, rejected, duplicate]).toEqual([true, false, false]);
			expect(fake.acks).toEqual(["accepted", "rejected", "duplicate"]);
			expect(injected).toHaveLength(1);
		});
	});

	it("rejects unpaired actors before inbound journaling or SDK dispatch", async () => {
		const commands: string[] = [];
		await withDaemon(
			async (daemon, fake, injected, _setEndpointGeneration, agentDir) => {
				const root = await daemon.postRoot("session", "root");
				await daemon.notify("session", "question", "action-1");
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("unpaired-command", "unpaired-command-event", root.rootTs!, {
							actorId: "unpaired",
							text: "/sdk query todo.list {}",
						}),
					),
				).toBe(false);
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("unpaired-reply", "unpaired-reply-event", root.rootTs!, {
							actorId: "unpaired",
						}),
					),
				).toBe(false);
				expect(fake.acks).toEqual(["unpaired-command", "unpaired-reply"]);
				expect(commands).toEqual([]);
				expect(injected).toEqual([]);
				expect(
					(await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).filter(effect =>
						effect.kind.startsWith("sdk.inbound."),
					),
				).toEqual([]);
				expect(Object.values((await daemon.store.load()).conversations)[0]?.inboundDispatches ?? []).toEqual([]);
			},
			{
				authorizeActor: actorId => actorId === "paired",
				onCommand: async (_sessionId, content) => {
					commands.push(content);
					return true;
				},
			},
		);
	});

	it("fails closed when no Slack principal is paired", async () => {
		await withDaemon(
			async (daemon, _fake, injected, _setEndpointGeneration, agentDir) => {
				const root = await daemon.postRoot("session", "root");
				await daemon.notify("session", "question", "action-1");
				expect(await daemon.handleEnvelope(messageEnvelope("unpaired", "event-1", root.rootTs!))).toBe(false);
				expect(injected).toEqual([]);
				expect(
					(await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).filter(effect =>
						effect.kind.startsWith("sdk.inbound."),
					),
				).toEqual([]);
			},
			{ authorizeActor: false },
		);
	});

	it("reconciles an uncertain root post with its client message id", async () => {
		await withDaemon(async (daemon, fake) => {
			fake.knownMessages.set("client-id-1", { channel: "C1", ts: "1.recovered", client_msg_id: "client-id-1" });
			const root = await daemon.postRoot("session", "root");
			expect(root.rootTs).toBe("1.recovered");
			expect(fake.posts).toHaveLength(0);
		});
	});

	it("allows only the durable posting-root owner to publish a concurrent root", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-concurrent-"));
		try {
			const fake = new FakeSlack();
			const options = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				randomId: () => "root-client-id",
				createClient: () => ({ send(_frame: Record<string, unknown>) {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
			};
			const [first, second] = await Promise.all([
				new SlackNotificationDaemon(options).postRoot("session", "root"),
				new SlackNotificationDaemon(options).postRoot("session", "root"),
			]);
			expect(first.rootTs).toBe(second.rootTs);
			expect(fake.posts).toEqual([expect.objectContaining({ clientMsgId: "root-client-id", text: "root" })]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("takes over an expired crashed root publisher while retaining its client message identity", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-root-lease-"));
		try {
			let now = 1;
			const fake = new FakeSlack();
			const base = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
				now: () => now,
				publicationLeaseMs: 10,
			};
			const first = new SlackNotificationDaemon({
				...base,
				randomId: () => "stable-root-id",
				publicationOwnerId: "crashed",
			});
			await first.postRoot("session", "root");
			const [key] = Object.keys((await first.store.load()).conversations);
			await first.store.transact(key!, current =>
				current
					? {
							...current,
							generation: current.generation + 1,
							state: "posting_root",
							rootTs: undefined,
							rootPublicationOwner: "crashed",
							rootPublicationLeaseExpiresAt: 10,
							updatedAt: now,
						}
					: current,
			);
			fake.knownMessages.clear();
			now = 11;
			const recovered = await new SlackNotificationDaemon({
				...base,
				randomId: () => "different-id",
				publicationOwnerId: "recovered",
			}).postRoot("session", "replacement");
			expect(recovered).toMatchObject({ state: "active", clientMsgId: "stable-root-id" });
			expect(fake.posts.filter(post => post.clientMsgId === "stable-root-id")).toHaveLength(1);
			expect(recovered.rootPublicationOwner).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("renews a live root lease across an external-call overrun so a peer cannot take over", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-root-renewal-"));
		try {
			const fake = new FakeSlack();
			const gate = Promise.withResolvers<void>();
			fake.postGate = gate.promise;
			const base = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
				publicationLeaseMs: 15,
			};
			const first = new SlackNotificationDaemon({
				...base,
				randomId: () => "stable-root-id",
				publicationOwnerId: "first",
			});
			const second = new SlackNotificationDaemon({
				...base,
				randomId: () => "stable-root-id",
				publicationOwnerId: "second",
			});
			const firstPost = first.postRoot("session", "root");
			await fake.waitForPostStartCount(1);
			const key = "T1:C1:intent:session";
			const firstLease = await first.store.read(key);
			if (!firstLease) throw new Error("Slack root lease was not persisted");
			let renewedLease = firstLease;
			for (let attempt = 0; attempt < 20 && renewedLease.generation === firstLease.generation; attempt++) {
				await Bun.sleep(25);
				renewedLease = (await first.store.read(key)) ?? renewedLease;
			}
			expect(renewedLease).toMatchObject({
				state: "posting_root",
				rootPublicationOwner: "first",
				rootPublicationFence: firstLease.rootPublicationFence,
			});
			expect(renewedLease.generation).toBeGreaterThan(firstLease.generation);
			const secondPost = second.postRoot("session", "root");
			gate.resolve();
			const [one, two] = await Promise.all([firstPost, secondPost]);
			expect(one).toMatchObject({ state: "active", rootTs: "1.1", clientMsgId: "stable-root-id" });
			expect(two.rootTs).toBe(one.rootTs);
			expect(fake.posts).toEqual([
				expect.objectContaining({ channel: "C1", text: "root", clientMsgId: "stable-root-id" }),
			]);
			expect(
				await new ChatEffectJournal({ agentDir, transport: "slack" }).read("root:session:stable-root-id"),
			).toMatchObject({
				state: "terminal",
				receipt: {
					provider: "slack",
					channelId: "C1",
					timestamp: one.rootTs,
					messageId: "stable-root-id",
					status: "posted",
				},
			});
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
	it("renews a live action lease across an external-call overrun", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-action-renewal-"));
		try {
			const fake = new FakeSlack();
			const base = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
				publicationLeaseMs: 15,
			};
			const root = new SlackNotificationDaemon({ ...base, randomId: () => "root", publicationOwnerId: "root" });
			await root.postRoot("session", "root");
			fake.postStarts = 0;
			const gate = Promise.withResolvers<void>();
			fake.postGate = gate.promise;
			const first = new SlackNotificationDaemon({
				...base,
				randomId: () => "stable-action-id",
				publicationOwnerId: "first",
			});
			const second = new SlackNotificationDaemon({
				...base,
				randomId: () => "stable-action-id",
				publicationOwnerId: "second",
			});
			const firstPost = first.notify("session", "question", "action");
			await fake.waitForPostStartCount(1);
			const key = "T1:C1:intent:session";
			const firstLease = await first.store.read(key);
			if (!firstLease) throw new Error("Slack action lease was not persisted");
			let renewedLease = firstLease;
			for (let attempt = 0; attempt < 20 && renewedLease.generation === firstLease.generation; attempt++) {
				await Bun.sleep(25);
				renewedLease = (await first.store.read(key)) ?? renewedLease;
			}
			expect(renewedLease).toMatchObject({
				outboundActionId: "action",
				outboundActionOwner: "first",
				outboundActionFence: firstLease.outboundActionFence,
			});
			expect(renewedLease.generation).toBeGreaterThan(firstLease.generation);
			const secondPost = second.notify("session", "question", "action");
			gate.resolve();
			const [one, two] = await Promise.all([firstPost, secondPost]);
			expect(one.pendingActionId).toBe("action");
			expect(two.pendingActionId).toBe("action");
			expect(fake.posts.filter(post => post.clientMsgId === "stable-action-id")).toEqual([
				expect.objectContaining({ channel: "C1", threadTs: "1.1", text: "question" }),
			]);
			expect(
				await new ChatEffectJournal({ agentDir, transport: "slack" }).read(
					"action:session:action:stable-action-id",
				),
			).toMatchObject({
				state: "terminal",
				receipt: {
					provider: "slack",
					channelId: "C1",
					timestamp: "1.2",
					messageId: "stable-action-id",
					status: "posted",
				},
			});
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("mints a new durable occurrence for a repeated outbound action", async () => {
		await withDaemon(async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
			await daemon.postRoot("session", "root");
			await daemon.notify("session", "first action", "action");
			await daemon.resolveAction("session", "action");
			await daemon.notify("session", "second action", "action");
			expect(fake.posts.filter(post => post.threadTs !== undefined).map(post => post.text)).toEqual([
				"first action",
				"second action",
			]);
			const effects = (await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).filter(effect =>
				effect.id.startsWith("action:session:action:"),
			);
			expect(effects).toHaveLength(2);
			expect(effects.map(effect => (effect.payload as { text?: unknown }).text)).toEqual([
				"first action",
				"second action",
			]);
		});
	});

	it("allows one cross-store lease holder to publish a shared outbound action", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-action-lease-"));
		try {
			const fake = new FakeSlack();
			const base = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
				publicationLeaseMs: 1_000,
			};
			const root = new SlackNotificationDaemon({
				...base,
				randomId: () => "root",
				publicationOwnerId: "root-owner",
			});
			await root.postRoot("session", "root");
			const first = new SlackNotificationDaemon({
				...base,
				randomId: () => "action-client",
				publicationOwnerId: "first",
			});
			const second = new SlackNotificationDaemon({
				...base,
				randomId: () => "action-client",
				publicationOwnerId: "second",
			});
			const [one, two] = await Promise.all([
				first.notify("session", "question", "action"),
				second.notify("session", "question", "action"),
			]);
			expect(fake.posts.filter(post => post.text === "question")).toHaveLength(1);
			expect(one.pendingActionId).toBe("action");
			expect(two.pendingActionId).toBe("action");
			const record = Object.values((await first.store.load()).conversations)[0]!;
			expect(record).toMatchObject({ state: "active", pendingActionId: "action" });
			expect(record.outboundActionOwner).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate a notification body while recreating an inactive root", async () => {
		await withDaemon(async (daemon, fake) => {
			await daemon.postRoot("session", "first root");
			await daemon.close("session");
			await daemon.notify("session", "replacement root");
			const replacements = fake.posts.filter(post => post.text === "replacement root");
			expect(replacements).toHaveLength(1);
			expect(replacements[0]?.threadTs).toBeUndefined();
		});
	});

	it("reconciles an accepted uncertain post with its original durable client message id", async () => {
		await withDaemon(async (daemon, fake) => {
			fake.failPostAfterAccept = true;
			const recovered = await daemon.postRoot("session", "root");
			expect(recovered.rootTs).toBe("1.1");
			expect(fake.posts).toEqual([expect.objectContaining({ clientMsgId: "client-id-1" })]);
			expect(Object.keys((await daemon.store.load()).conversations)).toHaveLength(1);
		});
	});
	it("reconciles a malformed accepted postMessage response by its durable client message id", async () => {
		await withDaemon(async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
			await daemon.start();
			const postMessage = fake.postMessage.bind(fake);
			fake.postMessage = async input => {
				try {
					return await postMessage(input);
				} catch (error) {
					fake.failFinds = 1;
					throw error;
				}
			};
			fake.failPostProtocolAfterAccept = true;
			await expect(daemon.postRoot("session", "root")).rejects.toThrow("protocol");
			for (let attempt = 0; attempt < 20; attempt++) {
				if ((await daemon.store.read("T1:C1:intent:session"))?.state === "active") break;
				await Bun.sleep(25);
			}
			expect(await daemon.store.read("T1:C1:intent:session")).toMatchObject({ state: "active", rootTs: "1.1" });
			expect(
				await new ChatEffectJournal({ agentDir, transport: "slack" }).read("root:session:client-id-1"),
			).toMatchObject({
				state: "terminal",
				receipt: { provider: "slack", status: "posted", messageId: "client-id-1" },
			});
			expect(fake.posts).toEqual([expect.objectContaining({ clientMsgId: "client-id-1" })]);
		});
	});

	it("reconciles a generation-rolled accepted post before allowing any replacement", async () => {
		await withDaemon(async (daemon, fake, _injected, setEndpointGeneration, agentDir) => {
			const releasePost = Promise.withResolvers<void>();
			const reconciliationStarted = Promise.withResolvers<void>();
			const releaseReconciliation = Promise.withResolvers<void>();
			fake.postGate = releasePost.promise;
			fake.onFind = async clientMsgId => {
				if (clientMsgId !== "client-id-1" || fake.posts.length === 0) return;
				reconciliationStarted.resolve();
				await releaseReconciliation.promise;
			};
			fake.failPostProtocolAfterAccept = true;
			const posting = daemon.postRoot("session", "root");
			await fake.waitForPostStartCount(1);
			setEndpointGeneration(2);
			releasePost.resolve();
			await reconciliationStarted.promise;
			expect(fake.posts).toEqual([expect.objectContaining({ clientMsgId: "client-id-1", text: "root" })]);
			expect(
				await new ChatEffectJournal({ agentDir, transport: "slack" }).read("root:session:client-id-1"),
			).toMatchObject({
				state: "leased",
			});
			releaseReconciliation.resolve();
			await expect(posting).resolves.toMatchObject({ state: "active", rootTs: "1.1", endpointGeneration: 1 });
			expect(fake.posts).toEqual([expect.objectContaining({ clientMsgId: "client-id-1", text: "root" })]);
			expect(
				await new ChatEffectJournal({ agentDir, transport: "slack" }).read("root:session:client-id-1"),
			).toMatchObject({
				state: "terminal",
				receipt: { provider: "slack", status: "posted", messageId: "client-id-1" },
			});
		});
	});

	it("serializes a live generation rollover behind an unresolved root and retains concurrent notifications", async () => {
		await withDaemon(async (daemon, fake, _injected, setEndpointGeneration, agentDir) => {
			const releasePost = Promise.withResolvers<void>();
			const reconciliationStarted = Promise.withResolvers<void>();
			const releaseReconciliation = Promise.withResolvers<void>();
			fake.postGate = releasePost.promise;
			fake.onFind = async clientMsgId => {
				if (clientMsgId !== "client-id-1" || fake.posts.length === 0) return;
				reconciliationStarted.resolve();
				await releaseReconciliation.promise;
			};
			fake.failPostProtocolAfterAccept = true;

			const generationOne = daemon.postRoot("session", "generation one root", 1);
			await fake.waitForPostStartCount(1);
			setEndpointGeneration(2);
			releasePost.resolve();
			await reconciliationStarted.promise;

			const generationTwoResume = daemon.resume("session", "generation two ready", 2);
			const generationTwoNotification = daemon.notify("session", "generation two notification", undefined, 2);
			expect(fake.posts.filter(post => post.threadTs === undefined)).toEqual([
				expect.objectContaining({ clientMsgId: "client-id-1", text: "generation one root" }),
			]);

			releaseReconciliation.resolve();
			const [first, resumed, notified] = await Promise.all([
				generationOne,
				generationTwoResume,
				generationTwoNotification,
			]);
			expect(first).toMatchObject({ rootTs: "1.1", clientMsgId: "client-id-1", endpointGeneration: 1 });
			expect(resumed).toMatchObject({ state: "active", endpointGeneration: 2 });
			expect(notified.rootTs).toBe(resumed.rootTs);
			expect(fake.posts.filter(post => post.threadTs === undefined)).toEqual([
				expect.objectContaining({ clientMsgId: "client-id-1", text: "generation one root" }),
				expect.objectContaining({ text: "generation two ready" }),
			]);
			expect(fake.posts.filter(post => post.threadTs === resumed.rootTs)).toEqual([
				expect.objectContaining({ text: "generation two notification" }),
			]);
			const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
			expect(await daemon.store.read("T1:C1:intent:session")).toMatchObject({
				state: "active",
				rootTs: resumed.rootTs,
				endpointGeneration: 2,
			});
			expect(await journal.read("root:session:client-id-1")).toMatchObject({
				state: "terminal",
				receipt: { provider: "slack", status: "posted", messageId: "client-id-1" },
			});
			expect(
				(await journal.list()).find(effect => {
					const payload = effect.payload as { text?: unknown };
					return effect.endpointGeneration === 2 && payload.text === "generation two notification";
				}),
			).toMatchObject({
				state: "terminal",
				payload: { threadTs: resumed.rootTs, text: "generation two notification" },
			});
		});
	});

	it("publishes the non-creator same-daemon rollover notification in the new root thread", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-rollover-same-daemon-"));
		let daemon: SlackNotificationDaemon | undefined;
		try {
			const fake = new FakeSlack();
			let generation = 1;
			const releaseLoads = Promise.withResolvers<void>();
			const loadsBlocked = Promise.withResolvers<void>();
			let blockedLoads = 0;
			const barrier: LoadBarrier = {
				remaining: 0,
				gate: releaseLoads.promise,
				onBlocked: () => {
					if (++blockedLoads === 2) loadsBlocked.resolve();
				},
			};
			const store = new BlockingSlackStore(agentDir, barrier);
			daemon = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				store,
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId, generation),
			});
			await daemon.postRoot("session", "generation one", 1);
			generation = 2;
			barrier.remaining = 2;
			const notifications = [
				daemon.notify("session", "first generation-two notification", undefined, 2),
				daemon.notify("session", "second generation-two notification", undefined, 2),
			];
			await loadsBlocked.promise;
			releaseLoads.resolve();
			const [first, second] = await Promise.all(notifications);
			expect(first.rootTs).toBe(second.rootTs);
			const rolloverRoots = fake.posts.filter(
				post =>
					post.threadTs === undefined &&
					(post.text === "first generation-two notification" ||
						post.text === "second generation-two notification"),
			);
			expect(rolloverRoots).toHaveLength(1);
			const threaded = fake.posts.filter(
				post =>
					post.threadTs === first.rootTs &&
					(post.text === "first generation-two notification" ||
						post.text === "second generation-two notification"),
			);
			expect(threaded).toHaveLength(1);
			expect(threaded[0]?.text).not.toBe(rolloverRoots[0]?.text);
		} finally {
			await daemon?.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("serializes rollover publication across daemon instances sharing the store", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-rollover-cross-daemon-"));
		try {
			const fake = new FakeSlack();
			let generation = 1;
			const releaseLoads = Promise.withResolvers<void>();
			const loadsBlocked = Promise.withResolvers<void>();
			let blockedLoads = 0;
			const barrier: LoadBarrier = {
				remaining: 0,
				gate: releaseLoads.promise,
				onBlocked: () => {
					if (++blockedLoads === 2) loadsBlocked.resolve();
				},
			};
			let id = 0;
			const options = (store: ConversationStore<SlackConversation>, publicationOwnerId: string) => ({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				store,
				publicationOwnerId,
				randomId: () => `client-${++id}`,
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId, generation),
			});
			const initial = new SlackNotificationDaemon(options(new BlockingSlackStore(agentDir, barrier), "initial"));
			await initial.postRoot("session", "generation one", 1);
			generation = 2;
			barrier.remaining = 2;
			const first = new SlackNotificationDaemon(options(new BlockingSlackStore(agentDir, barrier), "first"));
			const second = new SlackNotificationDaemon(options(new BlockingSlackStore(agentDir, barrier), "second"));
			const notifications = [
				first.notify("session", "first generation-two notification", undefined, 2),
				second.notify("session", "second generation-two notification", undefined, 2),
			];
			await loadsBlocked.promise;
			releaseLoads.resolve();
			const [one, two] = await Promise.all(notifications);
			expect(one.rootTs).toBe(two.rootTs);
			const rolloverRoots = fake.posts.filter(
				post =>
					post.threadTs === undefined &&
					(post.text === "first generation-two notification" ||
						post.text === "second generation-two notification"),
			);
			expect(rolloverRoots).toHaveLength(1);
			const threaded = fake.posts.filter(
				post =>
					post.threadTs === one.rootTs &&
					(post.text === "first generation-two notification" ||
						post.text === "second generation-two notification"),
			);
			expect(threaded).toHaveLength(1);
			expect(threaded[0]?.text).not.toBe(rolloverRoots[0]?.text);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("recovers a live transient provider failure without restart, input, or another notification", async () => {
		await withDaemon(async (daemon, fake) => {
			await daemon.start();
			const postMessage = fake.postMessage.bind(fake);
			fake.postMessage = async input => {
				try {
					return await postMessage(input);
				} catch (error) {
					fake.failFinds = 1;
					throw error;
				}
			};
			fake.failPostAfterAccept = true;
			await expect(daemon.postRoot("session", "root")).rejects.toThrow("connection");
			for (let attempt = 0; attempt < 20; attempt++) {
				const recovered = await daemon.store.read("T1:C1:intent:session");
				if (recovered?.state === "active") break;
				await Bun.sleep(25);
			}
			expect(await daemon.store.read("T1:C1:intent:session")).toMatchObject({ state: "active", rootTs: "1.1" });
			expect(fake.posts).toHaveLength(1);
		});
	});

	it("restores a root mapping from an accepted provider receipt during startup replay", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-root-receipt-"));
		try {
			const fake = new FakeSlack();
			const options = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				randomId: () => "root-client",
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
			};
			const first = new SlackNotificationDaemon(options);
			const posted = await first.postRoot("session", "root");
			const key = `T1:C1:intent:session`;
			await first.store.transact(key, current =>
				current
					? {
							...current,
							generation: current.generation + 1,
							state: "posting_root",
							rootTs: undefined,
							rootPublicationOwner: "crashed",
							rootPublicationLeaseExpiresAt: 0,
						}
					: current,
			);

			const restarted = new SlackNotificationDaemon(options);
			await restarted.start();
			const recovered = await restarted.store.read(key);
			expect(recovered).toMatchObject({ state: "active", rootTs: posted.rootTs, endpointGeneration: 1 });
			expect(recovered?.rootPublicationOwner).toBeUndefined();
			expect(fake.posts).toHaveLength(1);
			await restarted.stop();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("restores action authority from an accepted provider receipt during startup replay", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-action-receipt-"));
		try {
			const fake = new FakeSlack();
			let id = 0;
			const options = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				randomId: () => `client-${++id}`,
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
			};
			const first = new SlackNotificationDaemon(options);
			const root = await first.postRoot("session", "root");
			await first.notify("session", "question", "action");
			const key = `T1:C1:intent:session`;
			const actionClientMsgId = fake.posts.find(post => post.text === "question")!.clientMsgId;
			await first.store.transact(key, current =>
				current
					? {
							...current,
							generation: current.generation + 1,
							pendingActionId: undefined,
							outboundActionId: "action",
							outboundActionClientMsgId: actionClientMsgId,
							outboundActionOwner: "crashed",
							outboundActionLeaseExpiresAt: 0,
						}
					: current,
			);

			const restarted = new SlackNotificationDaemon(options);
			await restarted.start();
			const recovered = await restarted.store.read(key);
			expect(recovered).toMatchObject({ state: "active", rootTs: root.rootTs, pendingActionId: "action" });
			expect(recovered?.outboundActionId).toBeUndefined();
			expect(recovered?.outboundActionClientMsgId).toBeUndefined();
			expect(fake.posts.filter(post => post.text === "question")).toHaveLength(1);
			await restarted.stop();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("reconciles terminal root and action receipts before Socket Mode can ACK an early envelope", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-startup-barrier-"));
		let restarted: SlackNotificationDaemon | undefined;
		try {
			const fake = new FakeSlack();
			let id = 0;
			const options = {
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				randomId: () => `client-${++id}`,
				createClient: () => ({ send() {} }),
				resolveEndpoint: async (sessionId: string) => endpoint(sessionId),
				authorizeActor: (actorId: string) => actorId === "U1",
			};
			const first = new SlackNotificationDaemon(options);
			const root = await first.postRoot("session", "root");
			await first.notify("session", "question", "action");
			const key = "T1:C1:intent:session";
			const actionClientMsgId = fake.posts.find(post => post.text === "question")!.clientMsgId;
			await first.store.transact(key, current =>
				current
					? {
							...current,
							generation: current.generation + 1,
							state: "posting_root",
							rootTs: undefined,
							pendingActionId: undefined,
							rootPublicationOwner: "crashed",
							rootPublicationLeaseExpiresAt: 0,
							outboundActionId: "action",
							outboundActionClientMsgId: actionClientMsgId,
							outboundActionOwner: "crashed",
							outboundActionLeaseExpiresAt: 0,
						}
					: current,
			);

			const injected: Array<Record<string, unknown>> = [];
			fake.onAck = async envelopeId => {
				expect(envelopeId).toBe("early");
				expect(await restarted?.store.read(key)).toMatchObject({
					state: "active",
					rootTs: root.rootTs,
					pendingActionId: "action",
				});
			};
			fake.onStart = async handler => {
				await handler(messageEnvelope("early", "early-event", root.rootTs!, { clientMsgId: "early-interaction" }));
			};
			restarted = new SlackNotificationDaemon({
				...options,
				createClient: () => ({ send: frame => injected.push(frame) }),
			});
			await restarted.start();
			expect(fake.acks).toContain("early");
			expect(injected).toEqual([expect.objectContaining({ type: "reply", id: "action", answer: "reply" })]);
		} finally {
			await restarted?.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("deduplicates event retries, event contexts, and interaction/message identifiers", async () => {
		await withDaemon(async (daemon, _fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "event-1");
			await daemon.handleEnvelope(
				messageEnvelope("one", "event-1", root.rootTs!, {
					clientMsgId: "interaction-1",
					eventContext: "context-1",
				}),
			);
			await daemon.handleEnvelope(
				messageEnvelope("retry", "event-1", root.rootTs!, {
					clientMsgId: "interaction-1",
					eventContext: "context-1",
				}),
			);
			await daemon.handleEnvelope(
				messageEnvelope("same-interaction", "event-2", root.rootTs!, {
					clientMsgId: "interaction-1",
					eventContext: "context-2",
				}),
			);
			expect(injected).toEqual([
				expect.objectContaining({
					type: "reply",
					id: "event-1",
					answer: "reply",
					idempotencyKey: "slack:T1:C1:1.1:U1:event-1:interaction-1",
				}),
			]);
		});
	});

	it("acknowledges reconnect redelivery without injecting it a second time", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "event-1");
			await daemon.start();
			fake.handler?.(messageEnvelope("first", "event-1", root.rootTs!));
			for (let attempt = 0; attempt < 100 && injected.length === 0; attempt++) await Bun.sleep(1);
			await daemon.stop();
			await daemon.start();
			fake.handler?.(messageEnvelope("redelivery", "event-1", root.rootTs!));
			for (let attempt = 0; attempt < 100 && !fake.acks.includes("redelivery"); attempt++) await Bun.sleep(1);
			expect(fake.acks).toEqual(["first", "redelivery"]);
			expect(injected).toHaveLength(1);
			expect(fake.stops).toBe(1);
		});
	});

	it("uses a new immutable root on resume and rejects superseded-root input", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const original = await daemon.postRoot("session", "root");
			const resumed = await daemon.resume("session", "resumed root");
			expect(resumed.rootTs).not.toBe(original.rootTs);
			await daemon.handleEnvelope(messageEnvelope("old-root", "old-event", original.rootTs!));
			expect(fake.acks).toEqual(["old-root"]);
			expect(injected).toEqual([]);
		});
	});

	it("keeps the root stable for replayed readiness and supersedes only the current generation", async () => {
		await withDaemon(async (daemon, fake, _injected, setEndpointGeneration) => {
			const original = await daemon.postRoot("session", "root");
			const replayed = await daemon.resume("session", "ready", 1);
			expect(replayed.rootTs).toBe(original.rootTs);
			expect(fake.posts).toHaveLength(1);

			setEndpointGeneration(2);
			const generationTwo = await daemon.resume("session", "generation two", 2);
			setEndpointGeneration(3);
			const generationThree = await daemon.resume("session", "generation three", 3);
			expect(generationThree.rootTs).not.toBe(generationTwo.rootTs);
			expect(fake.posts.filter(post => post.threadTs === generationTwo.rootTs)).toHaveLength(0);
			expect(fake.posts.filter(post => post.threadTs !== undefined)).toHaveLength(0);
			expect(Object.keys((await daemon.store.load()).conversations)).toHaveLength(1);
		});
	});

	it("does not persist Socket Mode cursors and can restart after rate-limit or disconnect failures", async () => {
		await withDaemon(async (daemon, fake) => {
			fake.failPost = true;
			await expect(daemon.postRoot("session", "root")).rejects.toThrow("rate limited");
			fake.failPost = false;
			await expect(daemon.postRoot("session", "root")).resolves.toMatchObject({ state: "active" });
			const state = JSON.stringify(await daemon.store.load());
			expect(state).not.toContain("cursor");

			fake.failStart = true;
			await expect(daemon.start()).rejects.toThrow("disconnected");
			fake.failStart = false;
			await expect(daemon.start()).resolves.toBeUndefined();
		});
	});

	it("cancels a recovery-started Socket Mode open after stop invalidates its lifecycle generation", async () => {
		await withDaemon(async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
			const root = await daemon.postRoot("session", "root");
			const releaseRecovery = Promise.withResolvers<void>();
			const recoveryStarted = Promise.withResolvers<void>();
			fake.onFind = async () => {
				recoveryStarted.resolve();
				await releaseRecovery.promise;
			};
			await new ChatEffectJournal({ agentDir, transport: "slack" }).enqueue({
				id: "recovery-before-start",
				kind: "provider-post",
				transport: "slack",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					channel: "C1",
					threadTs: root.rootTs,
					text: "recovery before start",
					clientMsgId: "recovery-before-start",
				},
			});
			const starting = daemon.start();
			await recoveryStarted.promise;
			let stopped = false;
			const stopping = daemon.stop().then(() => {
				stopped = true;
			});
			await Promise.resolve();
			expect(stopped).toBe(false);
			releaseRecovery.resolve();
			await Promise.all([starting, stopping]);
			expect(fake.startCalls).toBe(0);
			expect(fake.stops).toBe(0);
			await Promise.all([daemon.start(), daemon.start()]);
			expect(fake.startCalls).toBe(1);
			await daemon.stop();
			expect(fake.stops).toBe(1);
		});
	});

	it("waits for an in-flight Socket Mode open before stop returns", async () => {
		await withDaemon(async (daemon, fake) => {
			const releaseStart = Promise.withResolvers<void>();
			fake.startGate = releaseStart.promise;
			const starting = daemon.start();
			await fake.waitForStartCount(1);
			expect(fake.startCalls).toBe(1);
			let stopped = false;
			const stopping = daemon.stop().then(() => {
				stopped = true;
			});
			await Promise.resolve();
			expect(stopped).toBe(false);
			releaseStart.resolve();
			await Promise.all([starting, stopping]);
			expect(fake.startCalls).toBe(1);
			expect(fake.stops).toBe(1);
		});
	});

	it("stops a Socket Mode open that completes only after provider stop without a duplicate close", async () => {
		await withDaemon(async (daemon, fake) => {
			fake.startUntilStopped = true;
			const starting = daemon.start();
			await fake.waitForStartCount(1);
			expect(fake.startCalls).toBe(1);

			const stopping = daemon.stop();
			await Promise.all([starting, stopping]);
			expect(fake.stops).toBe(1);
		});
	});

	it("suppresses a generation-N provider effect after close and generation-N+1 resume", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-stale-provider-effect-"));
		try {
			const fake = new FakeSlack();
			let generation = 1;
			const daemon = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId, generation),
			});
			const original = await daemon.postRoot("session", "root", 1);
			await new ChatEffectJournal({ agentDir, transport: "slack" }).enqueue({
				id: "stale-generation-one",
				kind: "provider-post",
				transport: "slack",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					channel: "C1",
					threadTs: original.rootTs!,
					text: "must not post",
					clientMsgId: "stale-generation-one",
				},
			});
			await daemon.close("session");
			generation = 2;
			await daemon.resume("session", "new root", 2);
			await daemon.start();
			const stale = await new ChatEffectJournal({ agentDir, transport: "slack" }).read("stale-generation-one");
			expect(stale).toMatchObject({ state: "terminal", receipt: { provider: "slack", status: "stale_noop" } });
			expect(fake.posts.filter(post => post.clientMsgId === "stale-generation-one")).toEqual([]);
			await Bun.sleep(50);
			expect(
				(await new ChatEffectJournal({ agentDir, transport: "slack" }).read("stale-generation-one"))?.state,
			).toBe("terminal");
			expect(fake.posts.filter(post => post.clientMsgId === "stale-generation-one")).toEqual([]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
	it("claims /sdk event, context, and retry identifiers before command dispatch", async () => {
		const commands: Array<{ sessionId: string; content: string }> = [];
		await withDaemon(
			async (daemon, _fake) => {
				const root = await daemon.postRoot("session", "root");
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("first", "command-event", root.rootTs!, {
							eventContext: "command-context",
							text: "/sdk status",
						}),
					),
				).toBe(true);
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("retry", "command-event", root.rootTs!, {
							eventContext: "command-context",
							text: "/sdk status",
						}),
					),
				).toBe(false);
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("same-context", "command-event-2", root.rootTs!, {
							eventContext: "command-context",
							text: "/sdk status",
						}),
					),
				).toBe(false);
				expect(commands).toEqual([{ sessionId: "session", content: "/sdk status" }]);
			},
			{
				onCommand: async (sessionId, content) => {
					commands.push({ sessionId, content });
					return true;
				},
			},
		);
	});

	it("replays an ACK-boundary command receipt with its persisted idempotency key", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-command-replay-"));
		try {
			const firstProvider = new FakeSlack();
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(firstProvider),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
				onCommand: async () => {
					throw new Error("command must not run before ACK");
				},
			});
			const root = await first.postRoot("session", "root");
			firstProvider.onAck = async () => {
				throw new Error("crash after ACK");
			};
			await expect(
				first.handleEnvelope(
					messageEnvelope("first", "command-event", root.rootTs!, {
						clientMsgId: "command-id",
						text: "/sdk query todo.list {}",
					}),
				),
			).rejects.toThrow("crash after ACK");

			const keys: string[] = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
				onCommand: async (_sessionId, _content, _endpoint, idempotencyKey) => {
					keys.push(idempotencyKey);
					return true;
				},
			});
			await restarted.start();
			expect(keys).toEqual(["slack:T1:C1:1.1:U1:command-event:command-id"]);
			expect(Object.values((await restarted.store.load()).conversations)[0]?.inboundDispatches).toEqual([]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("durably accepts ordered controls using their stable inbound key", async () => {
		const commands: string[] = [];
		await withDaemon(
			async (daemon, fake) => {
				const root = await daemon.postRoot("session", "root");
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("ordered", "ordered-event", root.rootTs!, { text: "/sdk control turn.prompt {}" }),
					),
				).toBe(true);
				expect(fake.acks).toEqual(["ordered"]);
				expect(commands).toEqual(["/sdk control turn.prompt {}"]);
				expect(Object.values((await daemon.store.load()).conversations)[0]?.inboundDispatches ?? []).toEqual([]);
			},
			{
				onCommand: async (_sessionId, command) => {
					commands.push(command);
					return true;
				},
			},
		);
	});

	it("claims concurrent duplicate replies before the SDK side effect", async () => {
		await withDaemon(async (daemon, _fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "action-1");
			const duplicate = messageEnvelope("duplicate", "reply-event", root.rootTs!, {
				clientMsgId: "reply-id",
				eventContext: "reply-context",
			});
			const outcomes = await Promise.all([
				daemon.handleEnvelope(duplicate),
				daemon.handleEnvelope({ ...duplicate, envelope_id: "duplicate-2" }),
			]);
			expect(outcomes.filter(Boolean)).toHaveLength(1);
			expect(injected).toEqual([
				expect.objectContaining({
					type: "reply",
					id: "action-1",
					answer: "reply",
					idempotencyKey: "slack:T1:C1:1.1:U1:reply-event:reply-id",
				}),
			]);
		});
	});

	it("restores durable pending action authority after restart", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-restart-"));
		try {
			const firstFake = new FakeSlack();
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(firstFake),
				randomId: () => "client-id",
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
			});
			const root = await first.postRoot("session", "root");
			await first.notify("session", "question", "restored-action");
			const injected: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				randomId: () => "client-id",
				createClient: () => ({
					send(frame) {
						injected.push(frame);
					},
				}),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			expect(
				await restarted.handleEnvelope(
					messageEnvelope("restart", "restart-event", root.rootTs!, { clientMsgId: "restart-id" }),
				),
			).toBe(true);
			expect(injected).toEqual([
				expect.objectContaining({
					type: "reply",
					id: "restored-action",
					answer: "reply",
					idempotencyKey: "slack:T1:C1:1.1:U1:restart-event:restart-id",
				}),
			]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects an action after durable resolution", async () => {
		await withDaemon(async (daemon, _fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "resolved-action");
			await daemon.resolveAction("session", "resolved-action");
			expect(
				await daemon.handleEnvelope(
					messageEnvelope("stale", "stale-event", root.rootTs!, { clientMsgId: "stale-id" }),
				),
			).toBe(false);
			expect(injected).toEqual([]);
		});
	});

	it("persists an accepted inbound claim before Socket Mode acknowledgement", async () => {
		await withDaemon(async (daemon, fake) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "action-1");
			fake.onAck = async () => {
				const record = Object.values((await daemon.store.load()).conversations)[0]!;
				expect(record.inboundDispatches).toContainEqual(
					expect.objectContaining({ effectId: expect.any(String), actionId: "action-1" }),
				);
			};
			expect(
				await daemon.handleEnvelope(
					messageEnvelope("claimed", "event-1", root.rootTs!, { clientMsgId: "interaction-1" }),
				),
			).toBe(true);
		});
	});

	it("retries a redelivery after a definite pre-send SDK failure", async () => {
		let fail = true;
		await withDaemon(
			async (daemon, _fake, injected) => {
				const root = await daemon.postRoot("session", "root");
				await daemon.notify("session", "question", "action-1");
				const inbound = messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" });
				expect(await daemon.handleEnvelope(inbound)).toBe(false);
				expect(await daemon.handleEnvelope({ ...inbound, envelope_id: "redelivery" })).toBe(true);
				expect(injected).toHaveLength(1);
			},
			{
				createClient: injected => ({
					send(frame) {
						if (fail) {
							fail = false;
							throw new SdkClientError("connection_closed", "SDK unavailable before send");
						}
						injected.push(frame);
					},
				}),
			},
		);
	});

	it("retries a definite pre-send failure from the journal after restart", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-definite-restart-"));
		try {
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({
					send() {
						throw new SdkClientError("connection_closed", "before send");
					},
				}),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			const root = await first.postRoot("session", "root");
			await first.notify("session", "question", "action-1");
			expect(
				await first.handleEnvelope(
					messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" }),
				),
			).toBe(false);
			const replayed: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({ send: frame => replayed.push(frame) }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			await restarted.start();
			expect(replayed).toEqual([expect.objectContaining({ type: "reply", id: "action-1" })]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("replays a durable pending claim after an ACK-boundary crash without losing authority", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "action-1");
			const inbound = messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" });
			fake.onAck = async () => {
				throw new Error("process crashed after ACK");
			};
			await expect(daemon.handleEnvelope(inbound)).rejects.toThrow("crashed after ACK");
			fake.onAck = undefined;
			expect(await daemon.handleEnvelope({ ...inbound, envelope_id: "redelivery" })).toBe(true);
			expect(fake.acks).toEqual(["first", "redelivery"]);
			expect(injected).toHaveLength(1);
		});
	});

	it("drains a durable ACK-boundary receipt on startup with its captured payload", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-startup-replay-"));
		try {
			const firstFake = new FakeSlack();
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(firstFake),
				randomId: () => "client-id",
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			const root = await first.postRoot("session", "root");
			await first.notify("session", "question", "action-1");
			firstFake.onAck = async () => {
				throw new Error("crash after ACK");
			};
			await expect(
				first.handleEnvelope(messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" })),
			).rejects.toThrow("crash after ACK");

			const replayed: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				randomId: () => "client-id",
				createClient: () => ({ send: frame => replayed.push(frame) }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			await restarted.start();
			expect(replayed).toEqual([
				expect.objectContaining({
					type: "reply",
					id: "action-1",
					answer: "reply",
					idempotencyKey: "slack:T1:C1:1.1:U1:event-1:interaction-1",
				}),
			]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("releases a generation-swapped pre-send receipt for redelivery", async () => {
		let swapped = false;
		let sent = false;
		await withDaemon(
			async (daemon, _fake) => {
				const root = await daemon.postRoot("session", "root");
				await daemon.notify("session", "question", "action-1");
				swapped = true;
				const inbound = messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" });
				expect(await daemon.handleEnvelope(inbound)).toBe(false);
				swapped = false;
				expect(await daemon.handleEnvelope({ ...inbound, envelope_id: "redelivery" })).toBe(true);
				expect(sent).toBe(true);
			},
			{
				createClient: injected => ({
					send(frame) {
						if (swapped) throw new SlackEndpointBindingError();
						sent = true;
						injected.push(frame);
					},
				}),
			},
		);
	});

	it("retries typed command pre-send delivery failures but retains ambiguous delivery", async () => {
		let retryableAttempts = 0;
		let ambiguousAttempts = 0;
		await withDaemon(
			async (daemon, _fake, _injected, _setEndpointGeneration, agentDir) => {
				const root = await daemon.postRoot("session", "root");
				const retryable = messageEnvelope("retryable-envelope", "retryable-event", root.rootTs!, {
					clientMsgId: "retryable-message",
					text: "/sdk query retryable {}",
				});
				expect(await daemon.handleEnvelope(retryable)).toBe(false);
				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				expect(
					await journal.read(`inbound:T1:C1:${root.rootTs}:U1:retryable-event:retryable-message`),
				).toMatchObject({
					state: "accepted",
					receipt: { status: "accepted" },
				});
				expect(await daemon.handleEnvelope({ ...retryable, envelope_id: "retryable-redelivery" })).toBe(true);
				expect(retryableAttempts).toBe(2);

				const ambiguous = messageEnvelope("ambiguous-envelope", "ambiguous-event", root.rootTs!, {
					clientMsgId: "ambiguous-message",
					text: "/sdk query ambiguous {}",
				});
				expect(await daemon.handleEnvelope(ambiguous)).toBe(false);
				expect(
					await journal.read(`inbound:T1:C1:${root.rootTs}:U1:ambiguous-event:ambiguous-message`),
				).toMatchObject({
					state: "uncertain",
					receipt: { status: "uncertain" },
				});
				expect(await daemon.handleEnvelope({ ...ambiguous, envelope_id: "ambiguous-redelivery" })).toBe(false);
				expect(ambiguousAttempts).toBe(1);
			},
			{
				onCommand: async (_sessionId, content) => {
					if (content.includes("retryable")) {
						retryableAttempts++;
						if (retryableAttempts === 1) throw new ChatDeliveryError("pre_send");
						return true;
					}
					ambiguousAttempts++;
					throw new ChatDeliveryError("ambiguous");
				},
			},
		);
	});

	it("retains more than 128 blocked dispatch receipts and suppresses their redeliveries", async () => {
		const blocked = Promise.withResolvers<void>();
		const allDispatched = Promise.withResolvers<void>();
		const commands: string[] = [];
		await withDaemon(
			async (daemon, _fake) => {
				const root = await daemon.postRoot("session", "root");
				const deliveries = Array.from({ length: 130 }, (_, index) =>
					daemon.handleEnvelope(
						messageEnvelope(`blocked-${index}`, `blocked-event-${index}`, root.rootTs!, {
							clientMsgId: `blocked-interaction-${index}`,
							text: `/sdk blocked-${index}`,
						}),
					),
				);
				await allDispatched.promise;
				const beforeCompletion = Object.values((await daemon.store.load()).conversations)[0]!;
				expect(beforeCompletion.inboundDispatches).toHaveLength(130);
				expect(
					await daemon.handleEnvelope(
						messageEnvelope("blocked-redelivery", "blocked-event-0", root.rootTs!, {
							clientMsgId: "blocked-interaction-0",
							text: "/sdk blocked-0",
						}),
					),
				).toBe(false);
				blocked.resolve();
				expect(await Promise.all(deliveries)).toEqual(Array.from({ length: 130 }, () => true));
				const completed = Object.values((await daemon.store.load()).conversations)[0]!;
				expect(completed.inboundDispatches).toHaveLength(0);
				expect(commands).toHaveLength(130);
			},
			{
				onCommand: async (_sessionId, command) => {
					commands.push(command);
					if (commands.length === 130) allDispatched.resolve();
					await blocked.promise;
					return true;
				},
			},
		);
	}, 30_000);

	it("retains an uncertain accepted SDK send claim and never resends it", async () => {
		await withDaemon(
			async (daemon, _fake, injected) => {
				const root = await daemon.postRoot("session", "root");
				await daemon.notify("session", "question", "action-1");
				const inbound = messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" });
				expect(await daemon.handleEnvelope(inbound)).toBe(false);
				expect(await daemon.handleEnvelope({ ...inbound, envelope_id: "redelivery" })).toBe(false);
				expect(injected).toHaveLength(1);
				const record = Object.values((await daemon.store.load()).conversations)[0]!;
				expect(record.inboundDispatches).toContainEqual(
					expect.objectContaining({ effectId: expect.any(String), actionId: "action-1" }),
				);
			},
			{
				createClient: injected => ({
					send(frame) {
						injected.push(frame);
						throw new SdkClientError("unavailable", "accepted then disconnected");
					},
				}),
			},
		);
	});

	it("does not replay an accepted-disconnected inbound reply after restart", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-inbound-uncertain-"));
		try {
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({
					send() {
						throw new SdkClientError("unavailable", "accepted then disconnected");
					},
				}),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			const root = await first.postRoot("session", "root");
			await first.notify("session", "question", "action-1");
			expect(
				await first.handleEnvelope(
					messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" }),
				),
			).toBe(false);
			const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
			expect((await journal.list()).find(effect => effect.id.includes("event-1"))).toMatchObject({
				kind: "sdk.inbound.reply",
				state: "uncertain",
			});
			await first.stop();

			const replayed: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({ send: frame => replayed.push(frame) }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			await restarted.start();
			expect(replayed).toEqual([]);
			await restarted.stop();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("terminalizes a crash-orphaned inbound effect after its root is superseded without SDK dispatch", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-orphan-root-"));
		try {
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
			});
			const original = await first.postRoot("session", "original root");
			const effectId = `inbound:T1:C1:${original.rootTs}:U1:event-1:interaction-1`;
			await new ChatEffectJournal({ agentDir, transport: "slack" }).enqueue({
				id: effectId,
				kind: "sdk.inbound.reply",
				transport: "slack",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "reply",
					id: "action-1",
					answer: "stale reply",
					idempotencyKey: `slack:T1:C1:${original.rootTs}:U1:event-1:interaction-1`,
					routing: {
						teamId: "T1",
						channelId: "C1",
						rootTs: original.rootTs!,
						actorId: "U1",
						eventId: "event-1",
						interactionId: "interaction-1",
						retryKey: "event-1:interaction-1",
						kind: "action",
						actionId: "action-1",
					},
				},
			});
			await first.stop();

			const injected: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				createClient: () => ({ send: frame => injected.push(frame) }),
				resolveEndpoint: async sessionId => endpoint(sessionId),
			});
			const replacement = await restarted.resume("session", "replacement root");
			expect(replacement.rootTs).not.toBe(original.rootTs);
			await restarted.notify("session", "replacement action", "action-2");
			await restarted.start();
			expect(injected).toEqual([]);
			expect(await new ChatEffectJournal({ agentDir, transport: "slack" }).read(effectId)).toMatchObject({
				state: "terminal",
				receipt: { status: "rejected" },
			});
			await restarted.stop();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("suppresses a generation-rotated provider effect before post or terminal commit", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-stale-effect-"));
		try {
			let generation = 1;
			const fake = new FakeSlack();
			const daemon = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				createClient: () => ({ send() {} }),
				resolveEndpoint: async sessionId => endpoint(sessionId, generation),
			});
			await daemon.postRoot("session", "root");
			fake.onFind = async () => {
				generation = 2;
			};
			await expect(daemon.notify("session", "must not post")).rejects.toThrow("no longer current");
			expect(fake.posts.map(post => post.text)).toEqual(["root"]);
			const effect = (await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).find(candidate =>
				candidate.id.startsWith("notification:"),
			);
			expect(effect?.state).not.toBe("terminal");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
	it("ACKs a redelivery yet recovers its dead unexpired lease without another envelope", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-lease-recovery-"));
		let daemon: SlackNotificationDaemon | undefined;
		try {
			let now = 0;
			let failScheduledDrain = false;
			const scheduledDrainFailed = Promise.withResolvers<void>();
			const fake = new FakeSlack();
			const injected: Array<Record<string, unknown>> = [];
			daemon = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				now: () => now,
				createClient: () => ({ send: frame => injected.push(frame) }),
				resolveEndpoint: async sessionId => {
					if (failScheduledDrain) {
						scheduledDrainFailed.resolve();
						throw new Error("transient endpoint lookup failure");
					}
					return endpoint(sessionId);
				},
				authorizeActor: actorId => actorId === "U1",
			});
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "action-1");
			const effectId = `inbound:T1:C1:${root.rootTs}:U1:event-1:interaction-1`;
			const journal = new ChatEffectJournal({ agentDir, transport: "slack", now: () => now });
			await journal.enqueue({
				id: effectId,
				kind: "sdk.inbound.reply",
				transport: "slack",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "reply",
					id: "action-1",
					answer: "reply",
					idempotencyKey: `slack:T1:C1:${root.rootTs}:U1:event-1:interaction-1`,
					routing: {
						teamId: "T1",
						channelId: "C1",
						rootTs: root.rootTs!,
						actorId: "U1",
						eventId: "event-1",
						interactionId: "interaction-1",
						retryKey: "event-1:interaction-1",
						kind: "action",
						actionId: "action-1",
					},
				},
			});
			await journal.claim(effectId, "dead-worker", 10);
			await daemon.start();
			expect(
				await daemon.handleEnvelope(
					messageEnvelope("redelivery", "event-1", root.rootTs!, { clientMsgId: "interaction-1" }),
				),
			).toBe(false);
			expect(fake.acks).toEqual(["redelivery"]);
			failScheduledDrain = true;
			now = 11;
			await scheduledDrainFailed.promise;
			failScheduledDrain = false;
			for (let attempt = 0; attempt < 20 && injected.length === 0; attempt++) await Bun.sleep(25);
			expect(injected).toEqual([
				expect.objectContaining({
					type: "reply",
					id: "action-1",
					answer: "reply",
					idempotencyKey: `slack:T1:C1:${root.rootTs}:U1:event-1:interaction-1`,
				}),
			]);
			expect(await journal.read(effectId)).toMatchObject({ state: "terminal", receipt: { status: "sent" } });
			for (let attempt = 0; attempt < 20; attempt++) {
				const current = await daemon.store.read("T1:C1:intent:session");
				if ((current?.inboundDispatches?.length ?? 0) === 0 && current?.seenEventIds?.includes("event-1")) break;
				await Bun.sleep(25);
			}
			const recovered = await daemon.store.read("T1:C1:intent:session");
			expect(recovered?.inboundDispatches).toEqual([]);
			expect(recovered?.seenEventIds).toContain("event-1");
			expect(recovered?.seenInteractionIds).toContain("interaction-1");
		} finally {
			await daemon?.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
