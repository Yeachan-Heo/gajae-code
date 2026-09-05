import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { ChatDeliveryError } from "../src/sdk/bus/chat-daemon-runtime";
import { __chatEffectJournalTestHooks, ChatEffectJournal } from "../src/sdk/bus/chat-effect-journal";
import { ConversationStore } from "../src/sdk/bus/conversation-store";
import type { SlackConversation } from "../src/sdk/bus/slack-conversation";
import { SlackEndpointBindingError, SlackNotificationDaemon } from "../src/sdk/bus/slack-daemon";
import { SlackLiveProvider, SlackProviderError } from "../src/sdk/bus/slack-live-provider";
import { SlackProvider, type SlackSocketEnvelope } from "../src/sdk/bus/slack-provider";
import { SdkClientError } from "../src/sdk/client/client";
import { type SessionAttachment, SessionRouterError } from "../src/sdk/router";

afterEach(() => {
	__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = undefined;
});

class FakeSlack {
	handler: ((envelope: SlackSocketEnvelope) => void | Promise<void>) | undefined;
	acks: string[] = [];
	reactions: Array<{ channel: string; timestamp: string; name: string }> = [];
	posts: Array<{ channel: string; text: string; threadTs?: string; clientMsgId: string }> = [];
	knownMessages = new Map<string, { channel: string; ts: string; client_msg_id: string }>();
	knownTimestamps = new Set<string>();
	stopError?: Error;
	failPost = false;
	failPostAfterAccept = false;
	failPostProtocolAfterAccept = false;
	failStart = false;
	failFinds = 0;
	onAck?: (envelopeId: string) => Promise<void>;
	postGate?: Promise<void>;
	startGate?: Promise<void>;
	stopGate?: Promise<void>;
	startUntilStopped = false;
	postStarts = 0;
	postSignals: AbortSignal[] = [];
	throwOnAbortedPost = false;
	#postStartWaiters: Array<{ count: number; resolve: () => void }> = [];
	#startWaiters: Array<{ count: number; resolve: () => void }> = [];
	#startStopGate = Promise.withResolvers<void>();
	startCalls = 0;
	stops = 0;
	onFind?: (clientMsgId: string) => Promise<void>;
	onPost?: (input: { channel: string; text: string; threadTs?: string; clientMsgId: string }) => void | Promise<void>;
	onReaction?: (input: {
		channel: string;
		timestamp: string;
		name: string;
		signal?: AbortSignal;
	}) => void | Promise<void>;
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
		await this.stopGate;
		if (this.stopError) throw this.stopError;
	}

	async ack(envelopeId: string): Promise<void> {
		this.acks.push(envelopeId);
		await this.onAck?.(envelopeId);
	}

	async addReaction(input: { channel: string; timestamp: string; name: string; signal?: AbortSignal }): Promise<void> {
		const { signal: _signal, ...reaction } = input;
		this.reactions.push(reaction);
		await this.onReaction?.(input);
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
		signal?: AbortSignal;
	}): Promise<{ channel: string; ts: string; client_msg_id: string }> {
		this.postStarts++;
		this.#resolvePostStartWaiters();
		if (input.signal) this.postSignals.push(input.signal);
		await this.postGate;
		if (this.throwOnAbortedPost) input.signal?.throwIfAborted();
		if (this.failPost) throw new Error("Slack rate limited");
		this.posts.push(input);
		await this.onPost?.(input);
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
	async findMessageByTimestamp(input: {
		channel: string;
		ts: string;
	}): Promise<{ channel: string; ts: string } | null> {
		return this.knownTimestamps.has(input.ts) ? { channel: input.channel, ts: input.ts } : null;
	}
}

function endpoint(sessionId: string, generation = 1): SessionAttachment {
	return {
		authorityId: `${sessionId}:${generation}`,
		sessionId,
		generation,
		isCurrent: () => true,
		send: () => undefined,
		sendMaintenance: () => {},
	};
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	const aborted = Promise.withResolvers<void>();
	const onAbort = (): void => aborted.resolve();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await aborted.promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
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
		setEndpointGeneration: (generation: number | undefined) => void,
		agentDir: string,
	) => Promise<void>,
	options: {
		onCommand?: (sessionId: string, content: string) => Promise<boolean>;
		attachmentSend?: (injected: Array<Record<string, unknown>>) => { send(frame: Record<string, unknown>): unknown };
		authorizeActor?: ((actorId: string) => boolean | Promise<boolean>) | false;
		now?: () => number;
		resolveAttachment?: (sessionId: string) => Promise<SessionAttachment | null>;
	} = {},
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-daemon-"));
	let daemon: SlackNotificationDaemon | undefined;
	try {
		const fake = new FakeSlack();
		const injected: Array<Record<string, unknown>> = [];
		let endpointGeneration: number | undefined = 1;
		const attachment = options.attachmentSend?.(injected);
		let id = 0;
		daemon = new SlackNotificationDaemon({
			agentDir,
			repo: agentDir,
			teamId: "T1",
			channelId: "C1",
			provider: new SlackProvider(fake),
			randomId: () => `client-id-${++id}`,
			resolveAttachment:
				options.resolveAttachment ??
				(async sessionId => {
					if (endpointGeneration === undefined) return null;
					return {
						...endpoint(sessionId, endpointGeneration),
						send: (frame: Record<string, unknown>) => {
							if (attachment) return attachment.send(frame);
							injected.push(frame);
						},
						sendMaintenance: () => {},
					};
				}),
			now: options.now,
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
	overrides: {
		actorId?: string;
		clientMsgId?: string;
		eventContext?: string;
		botId?: string;
		payloadType?: "event_callback" | "events_api";
		subtype?: string;
		text?: string;
	} = {},
): SlackSocketEnvelope {
	return {
		envelope_id: envelopeId,
		payload: {
			type: overrides.payloadType ?? "event_callback",
			event_id: eventId,
			event_context: overrides.eventContext,
			team_id: "T1",
			event: {
				type: "message",
				channel: "C1",
				ts: `2.${eventId}`,
				thread_ts: rootTs,
				user: overrides.actorId ?? "U1",
				bot_id: overrides.botId,
				subtype: overrides.subtype,
				text: overrides.text ?? "reply",
				client_msg_id: overrides.clientMsgId,
			},
		},
	};
}

describe("SlackNotificationDaemon fake-provider acceptance", () => {
	it("migrates persisted attachment and effect authority after device binding", async () => {
		let authorityId = "legacy-authority";
		await withDaemon(
			async (daemon, _fake, _injected, _setEndpointGeneration, agentDir) => {
				const conversation = await daemon.notify("session", "root");
				authorityId = "device-bound-authority";
				__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = () => {
					throw new Error("effect migration exploded");
				};
				await expect(
					daemon.migrateAttachmentAuthority("session", 1, "legacy-authority", authorityId),
				).rejects.toThrow("effect migration exploded");

				const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
				const fenced = Object.values((await store.load()).conversations).find(
					record => record.sessionId === "session" && record.rootTs === conversation.rootTs,
				);
				expect(fenced?.attachmentAuthorityId).toBe("device-bound-authority");
				expect(fenced?.attachmentAuthorityMigrationFromId).toBe("legacy-authority");

				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				let effect = (await journal.list()).find(record => record.kind === "provider-post");
				expect((effect?.payload as { attachmentAuthorityId?: string }).attachmentAuthorityId).toBe(
					"legacy-authority",
				);

				__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = undefined;
				await daemon.migrateAttachmentAuthority("session", 1, "legacy-authority", authorityId);
				const migrated = Object.values((await store.load()).conversations).find(
					record => record.sessionId === "session" && record.rootTs === conversation.rootTs,
				);
				expect(migrated?.attachmentAuthorityMigrationFromId).toBeUndefined();
				effect = (await journal.list()).find(record => record.kind === "provider-post");
				expect((effect?.payload as { attachmentAuthorityId?: string }).attachmentAuthorityId).toBe(
					"device-bound-authority",
				);
				__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = undefined;
			},
			{
				resolveAttachment: async sessionId => ({ ...endpoint(sessionId), authorityId }),
			},
		);
	});

	it("replays a stable notification from the legacy payload while migration is fenced", async () => {
		let authorityId = "legacy-authority";
		await withDaemon(
			async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
				await daemon.notify("session", "root");
				await daemon.notify("session", "legacy notification", undefined, 1, "stable-notification");
				const postsBeforeMigration = fake.posts.length;
				authorityId = "device-bound-authority";
				__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = () => {
					throw new Error("effect migration exploded");
				};
				await expect(
					daemon.migrateAttachmentAuthority("session", 1, "legacy-authority", authorityId),
				).rejects.toThrow("effect migration exploded");
				__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = undefined;

				await daemon.notify("session", "replacement body", undefined, 1, "stable-notification");
				expect(fake.posts).toHaveLength(postsBeforeMigration);
				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				const effect = (await journal.list()).find(candidate => candidate.id.startsWith("notification:session:"));
				expect(effect).toMatchObject({
					payload: {
						text: "legacy notification",
						attachmentAuthorityId: "legacy-authority",
					},
				});
				const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
				expect(
					Object.values((await store.load()).conversations).find(record => record.sessionId === "session"),
				).toMatchObject({ attachmentAuthorityMigrationFromId: "legacy-authority" });
			},
			{
				resolveAttachment: async sessionId => ({ ...endpoint(sessionId), authorityId }),
			},
		);
	});

	it("rejects a provider effect that omits attachment authority", async () => {
		await withDaemon(
			async (daemon, _fake, _injected, _setEndpointGeneration, agentDir) => {
				await daemon.notify("session", "root");
				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				await expect(
					journal.enqueue({
						id: "missing-authority",
						kind: "provider-post",
						transport: "slack",
						sessionId: "session",
						endpointGeneration: 1,
						payload: {
							channel: "C1",
							threadTs: "1.1",
							text: "forged",
							clientMsgId: "missing-authority",
							attachmentAuthorityId: undefined,
						},
					}),
				).rejects.toThrow("attachment authority");
			},
			{
				resolveAttachment: async sessionId => ({ ...endpoint(sessionId), authorityId: "current-authority" }),
			},
		);
	});

	it("fences an effect enqueued after the migration journal snapshot", async () => {
		let authorityId = "legacy-authority";
		await withDaemon(
			async (daemon, _fake, _injected, _setEndpointGeneration, agentDir) => {
				await daemon.notify("session", "root");
				authorityId = "current-authority";
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let paused = true;
				__chatEffectJournalTestHooks.beforeAuthorityMigrationEffect = async () => {
					if (!paused) return;
					paused = false;
					entered.resolve();
					await release.promise;
				};

				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				const migration = daemon.migrateAttachmentAuthority("session", 1, "legacy-authority", "current-authority");
				await entered.promise;
				const late = journal.enqueue({
					id: "late-slack-effect",
					kind: "provider-post",
					transport: "slack",
					sessionId: "session",
					endpointGeneration: 1,
					payload: {
						channel: "C1",
						threadTs: "1.1",
						text: "late",
						clientMsgId: "late-slack-effect",
						attachmentAuthorityId: "legacy-authority",
					},
				});
				release.resolve();
				await migration;
				await expect(late).rejects.toThrow("attachment authority");
				expect(await journal.read("late-slack-effect")).toBeUndefined();
				const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
				const migrated = Object.values((await store.load()).conversations).find(
					record => record.sessionId === "session",
				);
				expect(migrated?.attachmentAuthorityId).toBe("current-authority");
				expect(migrated?.attachmentAuthorityMigrationFromId).toBeUndefined();
			},
			{
				resolveAttachment: async sessionId => ({ ...endpoint(sessionId), authorityId }),
			},
		);
	});

	it("scopes deterministic root publication identities to the configured channel", async () => {
		const firstAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-root-channel-one-"));
		const secondAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-root-channel-two-"));
		const fake = new FakeSlack();
		const createDaemon = (agentDir: string, channelId: string) =>
			new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId,
				provider: new SlackProvider(fake),
				resolveAttachment: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
		const first = createDaemon(firstAgentDir, "C1");
		const second = createDaemon(secondAgentDir, "C2");
		try {
			await first.notify("session", "ready", undefined, 1, "publication");
			await second.notify("session", "ready", undefined, 1, "publication");
			const roots = fake.posts.filter(post => post.threadTs === undefined);
			expect(roots.map(post => post.channel)).toEqual(["C1", "C2"]);
			expect(new Set(roots.map(post => post.clientMsgId)).size).toBe(2);
		} finally {
			await Promise.all([first.stop(), second.stop()]);
			await Promise.all([
				fs.rm(firstAgentDir, { recursive: true, force: true }),
				fs.rm(secondAgentDir, { recursive: true, force: true }),
			]);
		}
	});

	it("acknowledges accepted, rejected, and duplicate envelopes before their outcome", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "event-1");
			const accepted = await daemon.handleEnvelope(messageEnvelope("accepted", "event-1", root.rootTs!));
			const rejected = await daemon.handleEnvelope({ envelope_id: "rejected", payload: { type: "unsupported" } });
			const duplicate = await daemon.handleEnvelope(messageEnvelope("duplicate", "event-1", root.rootTs!));
			expect([accepted, rejected, duplicate]).toEqual([true, false, false]);
			expect(fake.acks).toEqual(["accepted", "rejected", "duplicate"]);
			expect(fake.reactions).toEqual([{ channel: "C1", timestamp: "2.event-1", name: "eyes" }]);
			expect(injected).toHaveLength(1);
		});
	});

	it("does not reject an accepted turn or leak provider details when its reaction fails", async () => {
		const secret = "xoxb-reaction-secret";
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		process.on("unhandledRejection", onUnhandled);
		try {
			await withDaemon(async (daemon, fake, injected) => {
				const root = await daemon.postRoot("session", "root");
				fake.onReaction = async () => {
					throw new Error(secret);
				};

				await expect(
					daemon.handleEnvelope(messageEnvelope("reaction-rejected", "reaction-rejected-event", root.rootTs!)),
				).resolves.toBe(true);
				for (let index = 0; index < 6; index++) await Promise.resolve();
				await Bun.sleep(0);

				expect(injected).toHaveLength(1);
				expect(warning.mock.calls).toEqual([["Slack inbound acknowledgement reaction failed."]]);
				expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
				expect(unhandled).toEqual([]);
			});
		} finally {
			process.off("unhandledRejection", onUnhandled);
			warning.mockRestore();
		}
	});

	it("does not couple accepted turn dispatch to a stalled reaction and aborts it at the deadline", async () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await withDaemon(async (daemon, fake, injected) => {
				const root = await daemon.postRoot("session", "root");
				const reactionStarted = Promise.withResolvers<AbortSignal>();
				const reactionAborted = Promise.withResolvers<void>();
				fake.onReaction = async input => {
					if (!input.signal) throw new Error("Reaction signal missing");
					reactionStarted.resolve(input.signal);
					await waitForAbort(input.signal);
					reactionAborted.resolve();
					input.signal.throwIfAborted();
				};
				vi.useFakeTimers();
				try {
					const handled = daemon.handleEnvelope(
						messageEnvelope("reaction-stalled", "reaction-stalled-event", root.rootTs!),
					);
					const signal = await reactionStarted.promise;
					await expect(handled).resolves.toBe(true);
					expect(injected).toHaveLength(1);
					expect(signal.aborted).toBe(false);

					vi.advanceTimersByTime(4_999);
					expect(signal.aborted).toBe(false);
					vi.advanceTimersByTime(1);
					await reactionAborted.promise;
					for (let index = 0; index < 6; index++) await Promise.resolve();

					expect(signal.aborted).toBe(true);
					expect(warning.mock.calls).toEqual([
						["Slack inbound acknowledgement reaction exceeded the 5000ms deadline and was aborted."],
					]);
				} finally {
					vi.useRealTimers();
				}
			});
		} finally {
			warning.mockRestore();
		}
	});

	it("aborts and drains a stalled reaction during shutdown without an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		process.on("unhandledRejection", onUnhandled);
		try {
			await withDaemon(async (daemon, fake) => {
				const root = await daemon.postRoot("session", "root");
				const reactionStarted = Promise.withResolvers<AbortSignal>();
				let reactionFinished = false;
				fake.onReaction = async input => {
					if (!input.signal) throw new Error("Reaction signal missing");
					reactionStarted.resolve(input.signal);
					try {
						await waitForAbort(input.signal);
						input.signal.throwIfAborted();
					} finally {
						reactionFinished = true;
					}
				};

				await expect(
					daemon.handleEnvelope(messageEnvelope("reaction-shutdown", "reaction-shutdown-event", root.rootTs!)),
				).resolves.toBe(true);
				const signal = await reactionStarted.promise;
				await daemon.stop();
				expect(reactionFinished).toBe(true);
				await Bun.sleep(0);

				expect(signal.aborted).toBe(true);
				expect(warning).not.toHaveBeenCalled();
				expect(unhandled).toEqual([]);
			});
		} finally {
			process.off("unhandledRejection", onUnhandled);
			warning.mockRestore();
		}
	});

	it("aborts and drains a stalled reaction when attachment ownership is retired", async () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await withDaemon(async (daemon, fake) => {
				const root = await daemon.postRoot("session", "root");
				const reactionStarted = Promise.withResolvers<AbortSignal>();
				let reactionFinished = false;
				fake.onReaction = async input => {
					if (!input.signal) throw new Error("Reaction signal missing");
					reactionStarted.resolve(input.signal);
					try {
						await waitForAbort(input.signal);
						input.signal.throwIfAborted();
					} finally {
						reactionFinished = true;
					}
				};

				await expect(
					daemon.handleEnvelope(messageEnvelope("reaction-retired", "reaction-retired-event", root.rootTs!)),
				).resolves.toBe(true);
				const signal = await reactionStarted.promise;
				await daemon.retireAttachment("session", 1);
				expect(reactionFinished).toBe(true);

				expect(signal.aborted).toBe(true);
				expect(warning).not.toHaveBeenCalled();
			});
		} finally {
			warning.mockRestore();
		}
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

	it("rejects bot, edited, and thread-broadcast messages in mapped threads", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			const cases = [
				["bot", { botId: "B1" }],
				["edited", { subtype: "message_changed" }],
				["broadcast", { subtype: "thread_broadcast" }],
				["integration", { subtype: "file_share" }],
			] as const;
			for (const [name, overrides] of cases) {
				expect(await daemon.handleEnvelope(messageEnvelope(name, `${name}-event`, root.rootTs!, overrides))).toBe(
					false,
				);
			}
			expect(fake.acks).toEqual(["bot", "edited", "broadcast", "integration"]);
			expect(injected).toEqual([]);
		});
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
				publicationLeaseMs: 500,
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
			for (let attempt = 0; attempt < 80 && renewedLease.generation === firstLease.generation; attempt++) {
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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

	it("posts the close marker after Router attachment revocation", async () => {
		await withDaemon(async (daemon, fake, _injected, setEndpointGeneration) => {
			await daemon.postRoot("session", "root");
			setEndpointGeneration(undefined);
			expect(await daemon.close("session")).toBe(true);
			expect(fake.posts.map(post => post.text)).toEqual(["root", "Session closed."]);
		});
	});

	it("clears an exact terminally rejected cleanup before successor attachment", async () => {
		await withDaemon(async (daemon, fake) => {
			await daemon.postRoot("session", "root");
			fake.failPost = true;
			await expect(daemon.close("session", undefined, 1)).rejects.toThrow("Slack rate limited");
			expect((await daemon.findSession("session", true))?.record.cleanupEffectId).toContain(
				"close-marker-cleanup:session:",
			);
			fake.failPost = false;
			await daemon.recoverCleanup("session", 1);
			const recovered = (await daemon.findSession("session", true))?.record;
			expect(recovered?.state).toBe("active");
			expect(recovered?.cleanupEffectId).toBeUndefined();
		});
	});

	it("rejects a delayed cleanup callback for a successor generation", async () => {
		await withDaemon(async (daemon, fake, _injected, setEndpointGeneration) => {
			await daemon.postRoot("session", "root");
			setEndpointGeneration(2);
			await daemon.resume("session", "successor", 2);
			const posts = fake.posts.length;
			expect(await daemon.close("session", undefined, 1)).toBe(false);
			expect(fake.posts).toHaveLength(posts);
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
				resolveAttachment: async sessionId => endpoint(sessionId, generation),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId, generation),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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
				resolveAttachment: async (sessionId: string) => endpoint(sessionId),
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => injected.push(frame),
					sendMaintenance: () => {},
				}),
			});
			await restarted.start();
			expect(fake.acks).toContain("early");
			expect(injected).toEqual([expect.objectContaining({ type: "reply", id: "action", answer: "reply" })]);
		} finally {
			await restarted?.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("deduplicates event and interaction identifiers without treating event context as unique", async () => {
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
			await daemon.handleEnvelope(
				messageEnvelope("same-context", "event-3", root.rootTs!, {
					clientMsgId: "interaction-3",
					eventContext: "context-1",
					text: "next turn",
				}),
			);
			expect(injected).toEqual([
				expect.objectContaining({
					type: "reply",
					id: "event-1",
					answer: "reply",
					idempotencyKey: "slack:T1:C1:1.1:U1:event-1:interaction-1",
				}),
				expect.objectContaining({
					type: "user_message",
					sessionId: "session",
					text: "next turn",
					idempotencyKey: "slack:T1:C1:1.1:U1:event-3:interaction-3",
				}),
			]);
		});
	});

	it("acknowledges reconnect redelivery without injecting it a second time", async () => {
		await withDaemon(async (daemon, fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "event-1");
			await daemon.start();
			const firstHandler = fake.handler;
			expect(firstHandler).toBeDefined();
			await firstHandler!(messageEnvelope("first", "event-1", root.rootTs!));
			await daemon.stop();
			await daemon.start();
			const redeliveryHandler = fake.handler;
			expect(redeliveryHandler).toBeDefined();
			await redeliveryHandler!(messageEnvelope("redelivery", "event-1", root.rootTs!));
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
					attachmentAuthorityId: "session:1",
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

	it("bounds stop when a tracked /sdk command never settles", async () => {
		let stopping = false;
		let nowCalls = 0;
		const commandStarted = Promise.withResolvers<void>();
		const neverSettles = Promise.withResolvers<boolean>();
		await withDaemon(
			async (daemon, fake) => {
				await daemon.postRoot("session", "root");
				await daemon.start();
				const handler = fake.handler;
				if (!handler) throw new Error("Slack Socket Mode handler was not installed");
				void handler(
					messageEnvelope("never-settles", "never-settles-event", "1.1", {
						text: "/sdk hi",
					}),
				);
				await commandStarted.promise;
				stopping = true;
				await daemon.stop();
				expect(fake.stops).toBe(1);
				nowCalls = 0;
			},
			{
				now: () => (stopping ? (nowCalls++ === 0 ? 0 : 5_001) : 0),
				onCommand: async () => {
					commandStarted.resolve();
					return await neverSettles.promise;
				},
			},
		);
	});

	it("retains a timed-out provider shutdown until it settles before restarting", async () => {
		let stopping = false;
		let nowCalls = 0;
		const releaseStop = Promise.withResolvers<void>();
		await withDaemon(
			async (daemon, fake) => {
				fake.stopGate = releaseStop.promise;
				await daemon.start();
				stopping = true;
				await daemon.stop();
				expect(fake.stops).toBe(1);
				expect(daemon.restartBlocked()).toBe(true);

				let restarted = false;
				const restarting = daemon.start().then(() => {
					restarted = true;
				});
				await Promise.resolve();
				expect(restarted).toBe(false);
				expect(fake.startCalls).toBe(1);

				releaseStop.resolve();
				await restarting;
				expect(fake.startCalls).toBe(2);
				stopping = false;
				nowCalls = 0;
			},
			{ now: () => (stopping ? (nowCalls++ === 0 ? 0 : 5_001) : 0) },
		);
	});

	it("bounds a start predecessor that never settles", async () => {
		let stopping = false;
		let nowCalls = 0;
		const neverSettles = Promise.withResolvers<void>();
		await withDaemon(
			async (daemon, fake) => {
				fake.startGate = neverSettles.promise;
				void daemon.start();
				await fake.waitForStartCount(1);
				stopping = true;
				await daemon.stop();
				expect(fake.stops).toBe(1);
				nowCalls = 0;
			},
			{ now: () => (stopping ? (nowCalls++ === 0 ? 0 : 5_001) : 0) },
		);
	});

	it("does not let a detached startup clear a restarted daemon", async () => {
		let boundedStop = false;
		let nowCalls = 0;
		const oldStartGate = Promise.withResolvers<void>();
		await withDaemon(
			async (daemon, fake) => {
				fake.startGate = oldStartGate.promise;
				const oldStart = daemon.start();
				await fake.waitForStartCount(1);
				boundedStop = true;
				await daemon.stop();
				boundedStop = false;
				fake.startGate = undefined;
				await daemon.start();
				expect(fake.startCalls).toBe(2);
				await daemon.stop();
				expect(fake.stops).toBe(2);
				await daemon.start();
				expect(fake.startCalls).toBe(3);
				oldStartGate.resolve();
				await oldStart;
				expect(fake.stops).toBe(2);
				await daemon.stop();
				expect(fake.stops).toBe(3);
				nowCalls = 0;
			},
			{ now: () => (boundedStop ? (nowCalls++ === 0 ? 0 : 5_001) : 0) },
		);
	});

	it("fences tracked outbound notification work that races stop", async () => {
		let stopping = false;
		let nowCalls = 0;
		const findStarted = Promise.withResolvers<void>();
		const releaseFind = Promise.withResolvers<void>();
		await withDaemon(
			async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
				await daemon.postRoot("session", "root");
				fake.onFind = async () => {
					findStarted.resolve();
					await releaseFind.promise;
				};
				const posting = daemon.notify("session", "late notification");
				await findStarted.promise;
				stopping = true;
				await daemon.stop();
				releaseFind.resolve();
				await expect(posting).rejects.toThrow("shutdown");
				expect(fake.posts.map(post => post.text)).toEqual(["root"]);
				const effect = (await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).find(candidate =>
					candidate.id.startsWith("notification:"),
				);
				expect(effect).toMatchObject({ state: "uncertain", receipt: { status: "shutdown_timeout" } });
				nowCalls = 0;
			},
			{ now: () => (stopping ? (nowCalls++ === 0 ? 0 : 5_001) : 0) },
		);
	});

	it("fences tracked close-marker work that races stop", async () => {
		let stopping = false;
		let nowCalls = 0;
		const findStarted = Promise.withResolvers<void>();
		const releaseFind = Promise.withResolvers<void>();
		await withDaemon(
			async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
				await daemon.postRoot("session", "root");
				fake.onFind = async () => {
					findStarted.resolve();
					await releaseFind.promise;
				};
				const closing = daemon.close("session");
				await findStarted.promise;
				stopping = true;
				await daemon.stop();
				releaseFind.resolve();
				await expect(closing).rejects.toThrow("shutdown");
				expect(fake.posts.map(post => post.text)).toEqual(["root"]);
				const effect = (await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).find(candidate =>
					candidate.id.startsWith("close-marker"),
				);
				expect(effect).toMatchObject({ state: "uncertain", receipt: { status: "shutdown_timeout" } });
				nowCalls = 0;
			},
			{ now: () => (stopping ? (nowCalls++ === 0 ? 0 : 5_001) : 0) },
		);
	});

	it("does not let a cleanup close overwrite a successor mapping", async () => {
		const postGate = Promise.withResolvers<void>();
		await withDaemon(async (daemon, fake, _injected, setEndpointGeneration) => {
			const root = await daemon.postRoot("session", "root");
			setEndpointGeneration(undefined);
			fake.postGate = postGate.promise;
			const closing = daemon.close("session");
			await fake.waitForPostStartCount(2);
			const key = "T1:C1:intent:session";
			await daemon.store.transact(key, current =>
				current
					? {
							...current,
							state: "active",
							rootTs: "successor-root",
							clientMsgId: "successor-client",
							endpointGeneration: 2,
							updatedAt: current.updatedAt + 1,
							generation: current.generation + 1,
						}
					: current,
			);
			postGate.resolve();
			expect(await closing).toBe(false);
			expect(await daemon.store.read(key)).toMatchObject({
				state: "active",
				rootTs: "successor-root",
				clientMsgId: "successor-client",
				endpointGeneration: 2,
			});
			expect(fake.posts).toContainEqual(expect.objectContaining({ threadTs: root.rootTs, text: "Session closed." }));
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
				resolveAttachment: async sessionId => endpoint(sessionId, generation),
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
	it("claims /sdk event and retry identifiers before command dispatch", async () => {
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
				).toBe(true);
				expect(commands).toEqual([
					{ sessionId: "session", content: "/sdk status" },
					{ sessionId: "session", content: "/sdk status" },
				]);
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
				resolveAttachment: async sessionId => endpoint(sessionId),
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
				resolveAttachment: async sessionId => endpoint(sessionId),
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

	it("replays persisted message classification after pending action state changes", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-message-replay-"));
		try {
			const firstProvider = new FakeSlack();
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(firstProvider),
				resolveAttachment: async sessionId => endpoint(sessionId),
				authorizeActor: actorId => actorId === "U1",
			});
			const root = await first.postRoot("session", "root");
			firstProvider.onAck = async () => {
				throw new Error("crash after ACK");
			};
			await expect(
				first.handleEnvelope(
					messageEnvelope("first", "message-event", root.rootTs!, {
						clientMsgId: "message-id",
						text: "persisted prompt",
					}),
				),
			).rejects.toThrow("crash after ACK");
			await first.store.transact("T1:C1:intent:session", current =>
				current ? { ...current, generation: current.generation + 1, pendingActionId: "new-action" } : current,
			);

			const replayed: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => replayed.push(frame),
					sendMaintenance: () => {},
				}),
				authorizeActor: actorId => actorId === "U1",
			});
			await restarted.start();
			expect(replayed).toEqual([
				expect.objectContaining({ type: "user_message", sessionId: "session", text: "persisted prompt" }),
			]);
			await restarted.stop();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("replays an orphaned message effect when a stale intent gains a pending action", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-orphan-message-"));
		try {
			const first = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				resolveAttachment: async sessionId => endpoint(sessionId),
			});
			const root = await first.postRoot("session", "root");
			const effectId = `inbound:T1:C1:${root.rootTs}:U1:message-event:message-id`;
			const idempotencyKey = `slack:T1:C1:${root.rootTs}:U1:message-event:message-id`;
			const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
			await journal.enqueue({
				id: effectId,
				kind: "sdk.inbound.user_message",
				transport: "slack",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "user_message",
					sessionId: "session",
					text: "persisted prompt",
					idempotencyKey,
					routing: {
						teamId: "T1",
						channelId: "C1",
						rootTs: root.rootTs!,
						attachmentAuthorityId: "session:1",
						actorId: "U1",
						eventId: "message-event",
						interactionId: "message-id",
						retryKey: "message-event:message-id",
						kind: "message",
					},
				},
			});
			await first.store.transact("T1:C1:intent:session", current =>
				current ? { ...current, generation: current.generation + 1, pendingActionId: "new-action" } : current,
			);
			await first.stop();

			const replayed: Array<Record<string, unknown>> = [];
			const restarted = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(new FakeSlack()),
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => replayed.push(frame),
					sendMaintenance: () => {},
				}),
				authorizeActor: actorId => actorId === "U1",
			});
			await restarted.start();
			expect(replayed).toEqual([
				expect.objectContaining({ type: "user_message", sessionId: "session", text: "persisted prompt" }),
			]);
			expect(await journal.read(effectId)).toMatchObject({ state: "terminal", receipt: { status: "sent" } });
			await restarted.stop();
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
				resolveAttachment: async sessionId => endpoint(sessionId),
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => injected.push(frame),
					sendMaintenance: () => {},
				}),
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

	it("starts a user turn after durable action resolution", async () => {
		await withDaemon(async (daemon, _fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.notify("session", "question", "resolved-action");
			await daemon.resolveAction("session", "resolved-action");
			expect(
				await daemon.handleEnvelope(
					messageEnvelope("stale", "stale-event", root.rootTs!, { clientMsgId: "stale-id" }),
				),
			).toBe(true);
			expect(injected).toEqual([
				expect.objectContaining({
					type: "user_message",
					sessionId: "session",
					text: "reply",
				}),
			]);
		});
	});

	it("does not revive a stale idle notification id as a reply action", async () => {
		await withDaemon(async (daemon, _fake, injected) => {
			const root = await daemon.postRoot("session", "root");
			await daemon.store.transact("T1:C1:intent:session", current =>
				current ? { ...current, generation: current.generation + 1, pendingActionId: "idle:session#1" } : current,
			);
			expect(
				await daemon.handleEnvelope(
					messageEnvelope("stale-idle", "stale-idle-event", root.rootTs!, {
						clientMsgId: "stale-idle-message",
						text: "fresh prompt",
					}),
				),
			).toBe(true);
			expect(injected).toEqual([
				expect.objectContaining({ type: "user_message", sessionId: "session", text: "fresh prompt" }),
			]);
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
				attachmentSend: injected => ({
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

	it("awaits an async stale attachment rejection before journaling inbound success", async () => {
		let sendAttempts = 0;
		await withDaemon(
			async (daemon, _fake, injected, _setEndpointGeneration, agentDir) => {
				const root = await daemon.postRoot("session", "root");
				await daemon.notify("session", "question", "action-1");
				const inbound = messageEnvelope("first", "event-1", root.rootTs!, { clientMsgId: "interaction-1" });
				const idempotencyKey = "slack:T1:C1:1.1:U1:event-1:interaction-1";
				const effectId = "inbound:T1:C1:1.1:U1:event-1:interaction-1";
				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });

				expect(await daemon.handleEnvelope(inbound)).toBe(false);
				expect(await journal.read(effectId)).toMatchObject({
					state: "accepted",
					receipt: { status: "accepted" },
				});
				expect(injected).toEqual([]);

				expect(await daemon.handleEnvelope({ ...inbound, envelope_id: "redelivery" })).toBe(true);
				expect(sendAttempts).toBe(2);
				expect(injected).toEqual([expect.objectContaining({ idempotencyKey })]);
				expect(await journal.read(effectId)).toMatchObject({
					state: "terminal",
					receipt: { status: "sent" },
				});
			},
			{
				attachmentSend: injected => ({
					async send(frame) {
						sendAttempts++;
						if (sendAttempts === 1) {
							await Promise.resolve();
							throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: () => {
						throw new SdkClientError("connection_closed", "before send");
					},
					sendMaintenance: () => {},
				}),
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => replayed.push(frame),
					sendMaintenance: () => {},
				}),
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
				resolveAttachment: async sessionId => endpoint(sessionId),
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => replayed.push(frame),
					sendMaintenance: () => {},
				}),
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
				attachmentSend: injected => ({
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
				attachmentSend: injected => ({
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: () => {
						throw new SdkClientError("unavailable", "accepted then disconnected");
					},
					sendMaintenance: () => {},
				}),

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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => replayed.push(frame),
					sendMaintenance: () => {},
				}),
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
				resolveAttachment: async sessionId => endpoint(sessionId),
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
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					send: (frame: Record<string, unknown>) => injected.push(frame),
					sendMaintenance: () => {},
				}),
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
				resolveAttachment: async sessionId => endpoint(sessionId, generation),
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
				resolveAttachment: async sessionId => {
					if (failScheduledDrain) {
						scheduledDrainFailed.resolve();
						throw new Error("transient endpoint lookup failure");
					}
					return { ...endpoint(sessionId), send: (frame: Record<string, unknown>) => injected.push(frame) };
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
						attachmentAuthorityId: "session:1",
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
			const store = daemon.store;
			await daemon.stop();
			daemon = undefined;
			expect(await journal.read(effectId)).toMatchObject({ state: "terminal", receipt: { status: "sent" } });
			const recovered = await store.read("T1:C1:intent:session");
			expect(recovered?.inboundDispatches).toEqual([]);
			expect(recovered?.seenEventIds).toContain("event-1");
			expect(recovered?.seenInteractionIds).toContain("interaction-1");
		} finally {
			await daemon?.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
	it("propagates a rejected provider shutdown after local draining", async () => {
		await withDaemon(async (daemon, fake) => {
			await daemon.start();
			const failure = new Error("Socket Mode stop failed");
			fake.stopError = failure;

			await expect(daemon.stop()).rejects.toBe(failure);
			expect(fake.stops).toBe(1);
			expect(daemon.restartBlocked()).toBe(true);
		});
	});

	it("keeps an operator-bound root on the current attachment authority", async () => {
		await withDaemon(async (daemon, fake) => {
			const rootTs = "9.123";
			fake.knownTimestamps.add(rootTs);

			const bound = await daemon.bindExistingRoot("session", rootTs);
			expect(bound.attachmentAuthorityId).toBe("session:1");

			await daemon.notify("session", "notification", undefined, 1);
			expect(fake.posts).toEqual([
				expect.objectContaining({ channel: "C1", threadTs: rootTs, text: "notification" }),
			]);
		});
	});

	it("revalidates the fallback attachment authority persisted for an adopted root", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-bind-authority-"));
		try {
			const fake = new FakeSlack();
			const rootTs = "9.124";
			fake.knownTimestamps.add(rootTs);
			let attachmentResolutions = 0;
			const daemon = new SlackNotificationDaemon({
				agentDir,
				repo: agentDir,
				teamId: "T1",
				channelId: "C1",
				provider: new SlackProvider(fake),
				resolveAttachment: async sessionId => ({
					...endpoint(sessionId),
					authorityId: attachmentResolutions++ === 0 ? undefined : "fallback-authority",
				}),
			});

			await expect(daemon.bindExistingRoot("session", rootTs)).resolves.toMatchObject({
				rootTs,
				attachmentAuthorityId: "fallback-authority",
			});
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("terminalizes retired inbound effects before a same-generation mapping can replay them", async () => {
		let commands = 0;
		await withDaemon(
			async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
				const root = await daemon.postRoot("session", "root");
				fake.onAck = async () => {
					throw new Error("crash after acknowledgement");
				};
				await expect(
					daemon.handleEnvelope(
						messageEnvelope("claimed", "retired-command", root.rootTs!, {
							clientMsgId: "retired-command-id",
							text: "/sdk control turn.prompt {}",
						}),
					),
				).rejects.toThrow("crash after acknowledgement");

				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				const effect = (await journal.list()).find(candidate => candidate.id.startsWith("inbound:"));
				if (!effect) throw new Error("Inbound command effect was not journaled");
				expect(effect.state).toBe("pending");

				await daemon.retireAttachment("session", 1);
				expect(await journal.read(effect.id)).toMatchObject({
					state: "terminal",
					receipt: { status: "stale_binding" },
				});

				const key = "T1:C1:intent:session";
				expect((await daemon.store.read(key))?.inboundDispatches).toEqual([]);
				await daemon.store.transact(key, current =>
					current
						? {
								...current,
								state: "active",
								endpointGeneration: 1,
								attachmentAuthorityId: "session:1",
								generation: current.generation + 1,
								updatedAt: current.updatedAt + 1,
							}
						: current,
				);
				await daemon.start();
				expect(commands).toBe(0);
			},
			{
				onCommand: async () => {
					commands++;
					return true;
				},
			},
		);
	});

	it("returns after the retirement deadline while slow journal terminalization keeps the old scope fenced", async () => {
		let commands = 0;
		let retiring = false;
		let nowCalls = 0;
		await withDaemon(
			async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
				const root = await daemon.postRoot("session", "root");
				fake.onAck = async () => {
					throw new Error("crash after acknowledgement");
				};
				await expect(
					daemon.handleEnvelope(
						messageEnvelope("claimed", "retirement-liveness", root.rootTs!, {
							clientMsgId: "retirement-liveness-id",
							text: "/sdk control turn.prompt {}",
						}),
					),
				).rejects.toThrow("crash after acknowledgement");

				const journal = new ChatEffectJournal({ agentDir, transport: "slack" });
				const effect = (await journal.list()).find(candidate => candidate.id.startsWith("inbound:"));
				if (!effect) throw new Error("Inbound command effect was not journaled");
				const lockPath = `${journal.filePath}.lock`;
				await fs.writeFile(
					lockPath,
					`${JSON.stringify({ pid: process.pid, incarnation: "unavailable", timestamp: Date.now() })}\n`,
					{ mode: 0o600 },
				);
				try {
					retiring = true;
					const retirement = daemon.retireAttachment("session", 1);
					expect(
						await Promise.race([
							retirement.then(() => "retired" as const),
							// Liveness bound, not a latency assertion: the guarded failure mode is
							// retirement blocking indefinitely on the held journal lock. 100ms was
							// routinely exceeded by healthy retirement on loaded CI shard runners.
							Bun.sleep(2000).then(() => "blocked" as const),
						]),
					).toBe("retired");

					const key = "T1:C1:intent:session";
					const fenced = await daemon.store.read(key);
					expect(fenced?.state).toBe("closed_marker");
					expect(fenced?.inboundDispatches).toEqual([]);

					fake.onAck = undefined;
					await daemon.store.transact(key, current =>
						current
							? {
									...current,
									state: "active",
									endpointGeneration: 1,
									attachmentAuthorityId: "session:1",
									generation: current.generation + 1,
									updatedAt: current.updatedAt + 1,
								}
							: current,
					);
					const replaying = daemon.handleEnvelope(
						messageEnvelope("replay", "retirement-liveness", root.rootTs!, {
							clientMsgId: "retirement-liveness-id",
							text: "/sdk control turn.prompt {}",
						}),
					);
					await Bun.sleep(20);
					expect(commands).toBe(0);

					await fs.rm(lockPath, { force: true });
					await expect(replaying).resolves.toBe(false);
					await retirement;
					expect(await journal.read(effect.id)).toMatchObject({
						state: "terminal",
						receipt: { status: "stale_binding" },
					});
					expect(commands).toBe(0);
				} finally {
					retiring = false;
					nowCalls = 0;
					await fs.rm(lockPath, { force: true });
				}
			},
			{
				now: () => (retiring ? (nowCalls++ === 0 ? 0 : 5_001) : 0),
				onCommand: async () => {
					commands++;
					return true;
				},
			},
		);
	});

	it("waits for an admitted provider post before attachment retirement completes", async () => {
		const releasePost = Promise.withResolvers<void>();
		const providerPosted = Promise.withResolvers<void>();
		await withDaemon(async (daemon, fake) => {
			await daemon.postRoot("session", "root");
			fake.postGate = releasePost.promise;
			let retired = false;
			fake.onPost = input => {
				if (input.text !== "in-flight notification") return;
				expect(retired).toBe(false);
				providerPosted.resolve();
			};
			const outcome = daemon.notify("session", "in-flight notification").then(
				() => "fulfilled" as const,
				() => "rejected" as const,
			);
			await fake.waitForPostStartCount(2);

			const retiring = daemon.retireAttachment("session", 1).then(() => {
				retired = true;
			});
			await Promise.resolve();
			expect(retired).toBe(false);

			releasePost.resolve();
			await providerPosted.promise;
			expect(retired).toBe(false);
			await retiring;
			expect(await outcome).toBe("rejected");
		});
	});

	it("does not drain or invalidate another session's provider post during attachment retirement", async () => {
		const releasePost = Promise.withResolvers<void>();
		await withDaemon(async (daemon, fake) => {
			await daemon.postRoot("session-a", "A root");
			await daemon.postRoot("session-b", "B root");
			fake.postGate = releasePost.promise;
			const posting = daemon.notify("session-b", "B in-flight notification");
			await fake.waitForPostStartCount(3);

			const retiring = daemon.retireAttachment("session-a", 1);
			const retirement = await Promise.race([
				retiring.then(() => "retired" as const),
				Bun.sleep(100).then(() => "blocked" as const),
			]);
			releasePost.resolve();
			await retiring;

			expect(retirement).toBe("retired");
			await expect(posting).resolves.toMatchObject({ sessionId: "session-b" });
			expect(fake.posts).toContainEqual(expect.objectContaining({ text: "B in-flight notification" }));
		});
	});

	it("bounds retirement, aborts the provider post, and fences the effect after the deadline", async () => {
		const releasePost = Promise.withResolvers<void>();
		let retiring = false;
		let nowCalls = 0;
		await withDaemon(
			async (daemon, fake, _injected, _setEndpointGeneration, agentDir) => {
				await daemon.postRoot("session", "root");
				fake.postSignals = [];
				fake.postGate = releasePost.promise;
				fake.throwOnAbortedPost = true;
				const posting = daemon.notify("session", "deadline-fenced notification");
				await fake.waitForPostStartCount(2);

				retiring = true;
				await daemon.retireAttachment("session", 1);

				expect(fake.postSignals).toHaveLength(1);
				expect(fake.postSignals[0]?.aborted).toBe(true);
				releasePost.resolve();
				expect(
					await posting.then(
						() => "fulfilled" as const,
						() => "rejected" as const,
					),
				).toBe("rejected");
				const effect = (await new ChatEffectJournal({ agentDir, transport: "slack" }).list()).find(candidate =>
					candidate.id.startsWith("notification:"),
				);
				expect(effect).toMatchObject({ state: "terminal", receipt: { status: "stale_binding" } });
				expect(fake.posts.map(post => post.text)).toEqual(["root"]);
				retiring = false;
				nowCalls = 0;
			},
			{ now: () => (retiring ? (nowCalls++ === 0 ? 0 : 5_001) : 0) },
		);
	});

	it("aborts a rate-limit backoff before issuing another fetch", async () => {
		const backoff = Promise.withResolvers<void>();
		const sleepStarted = Promise.withResolvers<void>();
		let fetches = 0;
		const provider = new SlackLiveProvider({
			appToken: "xapp-test",
			botToken: "xoxb-test",
			fetch: async () => {
				fetches++;
				if (fetches === 1)
					return new Response(JSON.stringify({ ok: false }), {
						status: 429,
						headers: { "Content-Type": "application/json", "Retry-After": "60" },
					});
				throw new Error("Unexpected Slack retry after cancellation");
			},
			sleep: async () => {
				sleepStarted.resolve();
				await backoff.promise;
			},
		});
		const controller = new AbortController();
		const posting = provider.postMessage({
			channel: "C1",
			text: "hello",
			clientMsgId: "client-1",
			signal: controller.signal,
		});
		await sleepStarted.promise;
		try {
			controller.abort();
			expect(
				await Promise.race([
					posting.then(
						() => "fulfilled" as const,
						() => "aborted" as const,
					),
					Bun.sleep(100).then(() => "blocked" as const),
				]),
			).toBe("aborted");
			expect(fetches).toBe(1);
			backoff.resolve();
			await Promise.resolve();
			expect(fetches).toBe(1);
		} finally {
			backoff.resolve();
			await posting.catch(() => undefined);
		}
	});
});
