import { describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatDeliveryError } from "../src/sdk/bus/chat-daemon-runtime";
import {
	type ChatEffect,
	ChatEffectJournal,
	type ChatEffectLease,
	type ChatEffectReceipt,
	type EnqueueChatEffect,
} from "../src/sdk/bus/chat-effect-journal";

import { ConversationStore } from "../src/sdk/bus/conversation-store";
import type { DiscordConversation } from "../src/sdk/bus/discord-conversation";
import {
	type DiscordEndpointBinding,
	DiscordEndpointBindingError,
	DiscordNotificationDaemon,
	type DiscordNotificationDaemonOptions,
} from "../src/sdk/bus/discord-daemon";
import type {
	DiscordInboundEvent,
	DiscordMessageComponent,
	DiscordProvider,
	DiscordThread,
} from "../src/sdk/bus/discord-provider";
import { SdkClientError } from "../src/sdk/client/client";

const actionCustomIds = new Map<string, string>();

class FakeDiscordProvider implements DiscordProvider {
	readonly applicationId = "app";
	readonly botUserId = "bot";
	readonly threads: DiscordThread[] = [];
	readonly messages: Array<{ threadId: string; content: string; components?: DiscordMessageComponent[] }> = [];
	readonly archived: Array<{ threadId: string; locked?: boolean }> = [];
	readonly unarchived: string[] = [];
	readonly threadsByNonce = new Map<string, DiscordThread>();
	readonly messageNonces = new Map<string, { id: string; threadId: string }>();
	creates = 0;
	failCreateAfterPersist = false;
	failUnarchive = false;
	failPost = false;
	failPostAfterPersist = false;
	failStart = false;
	handler: ((event: DiscordInboundEvent) => Promise<void>) | undefined;
	startEvent: DiscordInboundEvent | undefined;

	async createThread(input: {
		guildId: string;
		parentId: string;
		name: string;
		nonce: string;
	}): Promise<DiscordThread> {
		this.creates++;
		const thread = {
			id: `thread-${this.creates}`,
			guildId: input.guildId,
			parentId: input.parentId,
			archived: false,
		};
		this.threads.push(thread);
		this.threadsByNonce.set(input.nonce, thread);
		if (this.failCreateAfterPersist) {
			this.failCreateAfterPersist = false;
			throw new Error("Discord disconnected after accepting create");
		}
		return thread;
	}

	async findThreadByNonce(input: { guildId: string; parentId: string; nonce: string }): Promise<DiscordThread | null> {
		return this.threadsByNonce.get(input.nonce) ?? null;
	}

	async findMessageByNonce(input: { threadId: string; nonce: string }): Promise<{ id: string } | null> {
		const message = this.messageNonces.get(input.nonce);
		return message?.threadId === input.threadId ? { id: message.id } : null;
	}

	async postMessage(input: {
		threadId: string;
		content: string;
		nonce?: string;
		components?: DiscordMessageComponent[];
	}): Promise<{ id: string }> {
		if (this.failPost) throw new Error("Discord rate limited");
		const id = String(this.messages.length + 1);
		this.messages.push({
			threadId: input.threadId,
			content: input.content,
			...(input.components ? { components: input.components } : {}),
		});
		const customId = input.components?.[0]?.components[0]?.customId;
		if (customId) actionCustomIds.set(input.threadId, customId);

		if (input.nonce) this.messageNonces.set(input.nonce, { id, threadId: input.threadId });
		if (this.failPostAfterPersist) {
			this.failPostAfterPersist = false;
			throw new Error("Discord disconnected after accepting post");
		}
		return { id };
	}

	async deferInteraction(): Promise<void> {}

	async archiveThread(input: { threadId: string; locked?: boolean }): Promise<void> {
		this.archived.push(input);
		const thread = this.threads.find(candidate => candidate.id === input.threadId);
		if (thread) thread.archived = true;
	}

	async unarchiveThread(input: { threadId: string }): Promise<void> {
		this.unarchived.push(input.threadId);
		if (this.failUnarchive) throw new Error("Missing Manage Threads permission");
		const thread = this.threads.find(candidate => candidate.id === input.threadId);
		if (thread) thread.archived = false;
	}

	async start(onEvent: (event: DiscordInboundEvent) => Promise<void>): Promise<void> {
		if (this.failStart) throw new Error("Discord gateway disconnected");
		this.handler = onEvent;
		if (this.startEvent) await onEvent(this.startEvent);
	}

	async stop(): Promise<void> {}
}

async function withDaemon(
	run: (daemon: DiscordNotificationDaemon, provider: FakeDiscordProvider, agentDir: string) => Promise<void>,
	overrides: Partial<Pick<DiscordNotificationDaemonOptions, "resolveEndpoint" | "onCommand" | "now">> = {},
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-discord-daemon-"));
	let daemon: DiscordNotificationDaemon | undefined;
	try {
		const provider = new FakeDiscordProvider();
		actionCustomIds.clear();

		daemon = new DiscordNotificationDaemon({
			agentDir,
			repo: agentDir,
			guildId: "guild",
			parentChannelId: "parent",
			provider,
			resolveEndpoint: async (_sessionId, expectedGeneration = 1) => ({
				generation: expectedGeneration,
				isCurrent: () => true,
				send: () => {},
			}),
			...overrides,
		});
		await run(daemon, provider, agentDir);
	} finally {
		await daemon?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

function inbound(threadId: string, id: string, generation = 1, customId?: string): DiscordInboundEvent {
	return {
		id,
		guildId: "guild",
		parentId: "parent",
		threadId,
		authorId: "member",
		interaction: {
			id: `interaction-${id}`,
			token: `token-${id}`,
			customId:
				customId ?? actionCustomIds.get(threadId) ?? `gjc:${generation}:ask:00000000-0000-0000-0000-000000000000`,
			value: "yes",
		},
	};
}

describe("DiscordNotificationDaemon fake-provider acceptance", () => {
	test("reconciles an uncertain create by nonce instead of creating a second thread", async () => {
		await withDaemon(async (daemon, provider) => {
			provider.failCreateAfterPersist = true;
			await expect(daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" })).rejects.toThrow(
				"disconnected",
			);
			const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "retry" });
			expect(conversation.threadId).toBe("thread-1");
			expect(provider.creates).toBe(1);
			expect(provider.messages).toEqual([{ threadId: "thread-1", content: "retry" }]);
		});
	});

	test("elects one durable creator while another daemon waits for its mapping", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const originalCreate = provider.createThread.bind(provider);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			provider.createThread = async input => {
				entered.resolve();
				await release.promise;
				return await originalCreate(input);
			};
			const other = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
			});
			const first = daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "first" });
			await entered.promise;
			const second = other.notify({ sessionId: "session", endpointGeneration: 1, content: "second" });
			release.resolve();
			const [one, two] = await Promise.all([first, second]);
			expect(one.threadId).toBe(two.threadId);
			expect(provider.creates).toBe(1);
		});
	});

	test("restores a durable mapping after daemon restart without creating another thread", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const first = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 2, isCurrent: () => true, send: () => {} }),
			});
			const restored = await restarted.notify({
				sessionId: "session",
				endpointGeneration: 2,
				content: "after restart",
			});
			expect(restored.threadId).toBe(first.threadId);
			expect(restored.endpointGeneration).toBe(2);
			expect(provider.creates).toBe(1);
		});
	});

	test("archives then unarchives a resumable thread and replaces it when permission prevents unarchive", async () => {
		await withDaemon(async (daemon, provider) => {
			const original = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			await daemon.archive("session");
			const resumed = await daemon.resume("session", 2);
			expect(resumed?.threadId).toBe(original.threadId);
			expect(provider.unarchived).toEqual([original.threadId!]);

			await daemon.archive("session");
			provider.failUnarchive = true;
			const replacement = await daemon.resume("session", 3);
			expect(replacement?.threadId).toBe("thread-2");
			expect(provider.creates).toBe(2);
		});
	});

	test("fails closed for stale, superseded, and unavailable inbound routes", async () => {
		await withDaemon(async (daemon, provider) => {
			const first = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			await daemon.archive("session");
			provider.failUnarchive = true;
			const replacement = await daemon.resume("session", 2);
			await daemon.handleInbound(inbound(first.threadId!, "old", 1));
			await daemon.handleInbound(inbound(replacement!.threadId!, "stale", 1));
			expect(provider.messages.slice(-2)).toEqual([
				{ threadId: first.threadId!, content: "This conversation is no longer available." },
				{ threadId: replacement!.threadId!, content: "This conversation is no longer available." },
			]);
		});
	});

	test("surfaces notification permission and rate-limit failures without leaking a route", async () => {
		await withDaemon(async (daemon, provider) => {
			provider.failPost = true;
			await expect(daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" })).rejects.toThrow(
				"rate limited",
			);
			expect(provider.messages).toEqual([]);
		});
	});

	test("can restart its event subscription after a transient gateway disconnect", async () => {
		await withDaemon(async (daemon, provider) => {
			provider.failStart = true;
			await expect(daemon.start()).rejects.toThrow("gateway disconnected");
			provider.failStart = false;
			await daemon.start();
			expect(provider.handler).toBeDefined();
		});
	});

	test("emits a real select component and rejects it after action resolution or restart", async () => {
		await withDaemon(
			async (daemon, provider, agentDir) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 4,
					content: "Choose",
					actionId: "ask",
					options: ["Yes", "No"],
				});
				expect(provider.messages[0]?.components).toEqual([
					{
						type: 1,
						components: [
							{
								type: 3,
								customId: expect.stringMatching(/^gjc:4:ask:[0-9a-f-]{36}$/),
								placeholder: "Choose an option",
								minValues: 1,
								maxValues: 1,

								options: [
									{ label: "Yes", value: "0" },
									{ label: "No", value: "1" },
								],
							},
						],
					},
				]);
				const restarted = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					resolveEndpoint: async () => ({ generation: 4, isCurrent: () => true, send: () => {} }),
				});
				await restarted.resolveAction("session", "ask");
				await restarted.handleInbound(inbound(conversation.threadId!, "resolved", 4));
				expect(provider.messages.at(-1)).toEqual({
					threadId: conversation.threadId!,
					content: "This conversation is no longer available.",
				});
			},
			{
				resolveEndpoint: async () => ({ generation: 4, isCurrent: () => true, send: () => {} }),
			},
		);
	});

	test("prefers an active replacement over an archived superseded mapping", async () => {
		let generation = 1;
		await withDaemon(
			async (daemon, provider) => {
				const original = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
				await daemon.archive("session");
				provider.failUnarchive = true;
				generation = 2;
				const replacement = await daemon.resume("session", 2);
				const selected = await daemon.notify({ sessionId: "session", endpointGeneration: 2, content: "new" });
				expect(selected.threadId).toBe(replacement?.threadId);
				expect(selected.threadId).not.toBe(original.threadId);
			},
			{
				resolveEndpoint: async () => ({ generation, isCurrent: () => true, send: () => {} }),
			},
		);
	});

	test("coalesces simultaneous resumes into one replacement", async () => {
		await withDaemon(async (daemon, provider) => {
			await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			await daemon.archive("session");
			provider.failUnarchive = true;
			const [first, second] = await Promise.all([daemon.resume("session", 2), daemon.resume("session", 2)]);
			expect(first?.threadId).toBe(second?.threadId);
			expect(provider.creates).toBe(2);
		});
	});

	test("rejects /sdk commands from archived and superseded threads", async () => {
		const commands: string[] = [];
		await withDaemon(
			async (daemon, provider) => {
				const original = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
				await daemon.archive("session");
				await daemon.handleInbound({
					...inbound(original.threadId!, "archived-command"),
					interaction: undefined,
					content: "/sdk query Q01",
				});
				provider.failUnarchive = true;
				const replacement = await daemon.resume("session", 2);
				await daemon.handleInbound({
					...inbound(original.threadId!, "superseded-command"),
					interaction: undefined,
					content: "/sdk query Q01",
				});
				expect(commands).toEqual([]);
				expect(provider.messages.slice(-2)).toEqual([
					{ threadId: original.threadId!, content: "This conversation is no longer available." },
					{ threadId: original.threadId!, content: "This conversation is no longer available." },
				]);
				expect(replacement?.threadId).not.toBe(original.threadId);
			},
			{
				onCommand: async (_sessionId, command) => {
					commands.push(command);
					return true;
				},
			},
		);
	});

	test("claims a /sdk command before dispatch so redelivery runs it once", async () => {
		const commands: string[] = [];
		await withDaemon(
			async daemon => {
				const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
				const command = {
					...inbound(conversation.threadId!, "command-redelivery"),
					interaction: undefined,
					content: "/sdk query Q01",
				};
				await Promise.all([daemon.handleInbound(command), daemon.handleInbound(command)]);
				expect(commands).toEqual(["/sdk query Q01"]);
			},
			{
				onCommand: async (_sessionId, command) => {
					commands.push(command);
					return true;
				},
			},
		);
	});

	test("claims concurrent duplicate interactions durably before one SDK reply", async () => {
		const frames: Record<string, unknown>[] = [];
		const client = {
			send: (frame: Record<string, unknown>) => {
				frames.push(frame);
			},
		};
		await withDaemon(
			async daemon => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 4,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				const event = inbound(conversation.threadId!, "interaction-redelivery", 4);
				await Promise.all([daemon.handleInbound(event), daemon.handleInbound(event)]);
				expect(frames).toMatchObject([
					{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
				]);
			},
			{
				resolveEndpoint: async () => ({ generation: 4, isCurrent: () => true, send: frame => client.send(frame) }),
			},
		);
	});

	test("defers an interaction before a blocked endpoint resolver completes", async () => {
		const frames: Record<string, unknown>[] = [];
		const resolverRelease = Promise.withResolvers<void>();
		const deferred = Promise.withResolvers<void>();
		let blockResolver = false;
		await withDaemon(
			async (daemon, provider) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				blockResolver = true;
				provider.deferInteraction = async () => {
					deferred.resolve();
				};
				const handling = daemon.handleInbound(inbound(conversation.threadId!, "defer-before-resolve", 1));
				await deferred.promise;
				expect(frames).toEqual([]);
				resolverRelease.resolve();
				await handling;
				expect(frames).toMatchObject([
					{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
				]);
			},
			{
				resolveEndpoint: async () => {
					if (blockResolver) await resolverRelease.promise;
					return {
						generation: 1,
						isCurrent: () => true,
						send: frame => {
							frames.push(frame);
						},
					};
				},
			},
		);
	});
	test("recovery skips a live callback lease created before its dispatch", async () => {
		const frames: Record<string, unknown>[] = [];
		const journaled = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const originalEnqueueAndClaim = ChatEffectJournal.prototype.enqueueAndClaim;
		let recovery: DiscordNotificationDaemon | undefined;
		let deferred = 0;
		vi.spyOn(ChatEffectJournal.prototype, "enqueueAndClaim").mockImplementation(async function <TPayload>(
			this: ChatEffectJournal,
			input: EnqueueChatEffect<TPayload>,
			owner: string,
			leaseMs: number,
		): Promise<ChatEffect<TPayload> | undefined> {
			const claimed = (await originalEnqueueAndClaim.call(this, input, owner, leaseMs)) as
				| ChatEffect<TPayload>
				| undefined;
			// Barrier only the inbound action claim under test; outbound provider
			// effects also use enqueueAndClaim now and must not trip this fence.
			if (input.kind === "discord.inbound.action") {
				journaled.resolve();
				await release.promise;
			}
			return claimed;
		});
		try {
			await withDaemon(
				async (daemon, provider, agentDir) => {
					const conversation = await daemon.notify({
						sessionId: "session",
						endpointGeneration: 1,
						content: "Choose",
						actionId: "ask",
						options: ["Yes"],
					});
					provider.deferInteraction = async () => {
						deferred++;
					};
					const effectId = `discord:app:guild:parent:${conversation.threadId}:live-recovery-barrier`;
					const live = daemon.handleInbound(inbound(conversation.threadId!, "live-recovery-barrier", 1));
					await journaled.promise;

					const beforeRecovery = await new ChatEffectJournal({ agentDir, transport: "discord" }).read(effectId);
					expect(beforeRecovery).toMatchObject({ state: "leased", owner: expect.any(String) });
					expect(beforeRecovery?.leaseExpiresAt ?? 0).toBeGreaterThan(0);
					expect(JSON.stringify(beforeRecovery)).not.toContain("token-live-recovery-barrier");

					recovery = new DiscordNotificationDaemon({
						agentDir,
						repo: agentDir,
						guildId: "guild",
						parentChannelId: "parent",
						provider,
						resolveEndpoint: async () => ({
							generation: 1,
							isCurrent: () => true,
							send: frame => {
								frames.push(frame);
							},
						}),
					});
					await recovery.start();

					const afterRecovery = await new ChatEffectJournal({ agentDir, transport: "discord" }).read(effectId);
					expect(afterRecovery).toMatchObject({
						state: "leased",
						owner: beforeRecovery?.owner,
						epoch: beforeRecovery?.epoch,
					});
					expect(afterRecovery?.receipt).toBeUndefined();
					expect(deferred).toBe(0);
					expect(frames).toEqual([]);

					release.resolve();
					await live;
					expect(deferred).toBe(1);
					expect(frames).toMatchObject([
						{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
					]);
					expect(frames).toHaveLength(1);
					expect((await new ChatEffectJournal({ agentDir, transport: "discord" }).read(effectId))?.state).toBe(
						"terminal",
					);
					await recovery.stop();
					recovery = undefined;
				},
				{
					resolveEndpoint: async () => ({
						generation: 1,
						isCurrent: () => true,
						send: frame => {
							frames.push(frame);
						},
					}),
				},
			);
		} finally {
			release.resolve();
			await recovery?.stop();
			vi.restoreAllMocks();
		}
	});

	test("waits for an in-flight renewal before posting a provider message", async () => {
		vi.useFakeTimers();
		const originalRenew = ChatEffectJournal.prototype.renew;
		const findStarted = Promise.withResolvers<void>();
		const renewalStarted = Promise.withResolvers<void>();
		const releaseFind = Promise.withResolvers<void>();
		const releaseRenewal = Promise.withResolvers<void>();
		let blockRenewal = false;
		try {
			await withDaemon(async (daemon, provider, agentDir) => {
				const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
				provider.findMessageByNonce = async () => {
					blockRenewal = true;
					findStarted.resolve();
					await releaseFind.promise;
					return null;
				};
				vi.spyOn(ChatEffectJournal.prototype, "renew").mockImplementation(async function <TPayload = unknown>(
					this: ChatEffectJournal,
					id: string,
					lease: ChatEffectLease,
					leaseMs: number,
				): Promise<ChatEffect<TPayload> | undefined> {
					if (blockRenewal) {
						blockRenewal = false;
						renewalStarted.resolve();
						await releaseRenewal.promise;
					}
					return (await originalRenew.call(this, id, lease, leaseMs)) as ChatEffect<TPayload> | undefined;
				});
				const posting = daemon.postCommandResult("session", "blocked");
				await findStarted.promise;
				vi.advanceTimersByTime(20_000);
				await renewalStarted.promise;
				releaseFind.resolve();
				await Promise.resolve();
				expect(provider.messages).toEqual([{ threadId: conversation.threadId!, content: "open" }]);
				const pending = (await new ChatEffectJournal({ agentDir, transport: "discord" }).list()).find(
					effect =>
						effect.kind === "post-message" &&
						effect.payload &&
						(effect.payload as { content?: string }).content === "blocked",
				);
				expect(pending?.state).toBe("leased");
				releaseRenewal.resolve();
				await posting;
				expect(provider.messages).toEqual([
					{ threadId: conversation.threadId!, content: "open" },
					{ threadId: conversation.threadId!, content: "blocked" },
				]);
			});
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	test("recovers a create-thread effect at startup after remote creation without another notification", async () => {
		let now = 0;
		await withDaemon(
			async (daemon, provider, agentDir) => {
				provider.failCreateAfterPersist = true;
				await expect(
					daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" }),
				).rejects.toThrow("disconnected");
				expect(provider.creates).toBe(1);
				now = 60_001;
				const restarted = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
				});
				await restarted.start();
				const stored = await fs.readFile(
					path.join(agentDir, "sdk", "daemons", "discord", "conversations.json"),
					"utf8",
				);
				expect(stored).toContain('"state":"active"');
				expect(stored).toContain('"threadId":"thread-1"');
				expect(provider.creates).toBe(1);
				expect(provider.messages).toEqual([]);
				await restarted.stop();
			},
			{ now: () => now },
		);
	});
	test("recovers a live transient provider failure without restart, input, or another notification", async () => {
		await withDaemon(async (daemon, provider) => {
			await daemon.start();
			provider.failPost = true;
			await expect(
				daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "recovered" }),
			).rejects.toThrow("rate limited");
			provider.failPost = false;
			for (
				let attempt = 0;
				attempt < 20 && !provider.messages.some(message => message.content === "recovered");
				attempt++
			)
				await Bun.sleep(25);
			expect(provider.messages).toContainEqual(expect.objectContaining({ content: "recovered" }));
		});
	});

	test("reclaims an expired create fence and commits a terminal create-thread receipt at startup", async () => {
		const now = 60_001;
		await withDaemon(
			async (_daemon, provider, agentDir) => {
				const nonce = `gjc-${createHash("sha256").update("create:session:recovery-nonce").digest("hex").slice(0, 21)}`;
				const thread = await provider.createThread({
					guildId: "guild",
					parentId: "parent",
					name: "GJC session",
					nonce,
				});
				const journal = new ChatEffectJournal({ agentDir, transport: "discord", now: () => now });
				const effectId = "create:session:recovery-nonce";
				await journal.enqueue({
					id: effectId,
					kind: "create-thread",
					transport: "discord",
					sessionId: "session",
					endpointGeneration: 1,
					payload: { guildId: "guild", parentId: "parent", name: "GJC session", nonce },
				});
				const leased = await journal.claim(effectId, "crashed-owner", 1);
				expect(leased).toBeDefined();
				await journal.record(effectId, { owner: "crashed-owner", epoch: leased!.epoch }, "terminal", {
					provider: "discord",
					threadId: thread.id,
					status: "created",
				});
				const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord", now: () => now });
				await store.transact("app:guild:parent:creating:session", () => ({
					generation: 1,
					state: "creating",
					appId: "app",
					guildId: "guild",
					parentChannelId: "parent",
					sessionId: "session",
					endpointGeneration: 1,
					createNonce: "recovery-nonce",
					createOwner: "crashed-owner",
					createLeaseExpiresAt: 1,
					updatedAt: 1,
					seenEventIds: [],
					seenInteractionIds: [],
				}));
				const restarted = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
				});
				await restarted.start();
				const stored = await fs.readFile(
					path.join(agentDir, "sdk", "daemons", "discord", "conversations.json"),
					"utf8",
				);
				expect(stored).toContain(`"threadId":"${thread.id}"`);
				expect(provider.creates).toBe(1);
				expect(provider.messages).toEqual([]);
				await restarted.stop();
			},
			{ now: () => now },
		);
	});
	test("consumes terminal create intents represented by closed or archived mappings and recreates with a fresh effect", async () => {
		for (const state of ["closed", "archived"] as const) {
			await withDaemon(async (_daemon, provider, agentDir) => {
				const nonce = `gjc-${createHash("sha256").update("create:session:recovery").digest("hex").slice(0, 21)}`;
				const thread = await provider.createThread({
					guildId: "guild",
					parentId: "parent",
					name: "GJC session",
					nonce,
				});
				const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
				await journal.enqueue({
					id: "create:session:recovery",
					kind: "create-thread",
					transport: "discord",
					sessionId: "session",
					endpointGeneration: 1,
					payload: { guildId: "guild", parentId: "parent", name: "GJC session", nonce },
				});
				const lease = await journal.claim("create:session:recovery", "crashed-owner", 60_000);
				await journal.record(
					"create:session:recovery",
					{ owner: "crashed-owner", epoch: lease!.epoch },
					"terminal",
					{ provider: "discord", threadId: thread.id, status: "created" },
				);
				const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
				const intentKey = "app:guild:parent:creating:session";
				await store.transact(intentKey, () => ({
					generation: 1,
					state: "creating",
					appId: "app",
					guildId: "guild",
					parentChannelId: "parent",
					sessionId: "session",
					endpointGeneration: 1,
					createNonce: "recovery",
					updatedAt: 1,
					seenEventIds: [],
					seenInteractionIds: [],
				}));
				const key = `app:guild:parent:${thread.id}`;
				await store.transact(key, () => ({
					generation: 1,
					state,
					appId: "app",
					guildId: "guild",
					parentChannelId: "parent",
					threadId: thread.id,
					sessionId: "session",
					endpointGeneration: 1,
					updatedAt: 1,
					seenEventIds: [],
					seenInteractionIds: [],
				}));
				const restarted = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					resolveEndpoint: async () => ({ generation: 2, isCurrent: () => true, send: () => {} }),
				});
				await restarted.start();
				expect((await store.read(key))?.state).toBe(state);
				expect(await store.read(intentKey)).toBeUndefined();
				const replacement = await restarted.notify({
					sessionId: "session",
					endpointGeneration: 2,
					content: "reopened",
				});
				expect(replacement.threadId).toBe("thread-2");
				expect(provider.creates).toBe(2);
				expect((await store.read(key))?.state).toBe(state);
				const createEffects = (await journal.list()).filter(effect => effect.kind === "create-thread");
				expect(new Set(createEffects.map(effect => (effect.payload as { nonce: string }).nonce)).size).toBe(2);
				await restarted.stop();
			});
		}
	});
	test("does not activate a terminal create receipt when another mapping already owns the session", async () => {
		await withDaemon(async (_daemon, provider, agentDir) => {
			const nonce = `gjc-${createHash("sha256").update("create:session:stale").digest("hex").slice(0, 21)}`;
			const stale = await provider.createThread({
				guildId: "guild",
				parentId: "parent",
				name: "GJC session",
				nonce,
			});
			const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
			await journal.enqueue({
				id: "create:session:stale",
				kind: "create-thread",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: { guildId: "guild", parentId: "parent", name: "GJC session", nonce },
			});
			const lease = await journal.claim("create:session:stale", "crashed-owner", 60_000);
			await journal.record("create:session:stale", { owner: "crashed-owner", epoch: lease!.epoch }, "terminal", {
				provider: "discord",
				threadId: stale.id,
				status: "created",
			});
			const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
			const intentKey = "app:guild:parent:creating:session";
			await store.transact(intentKey, () => ({
				generation: 1,
				state: "creating",
				appId: "app",
				guildId: "guild",
				parentChannelId: "parent",
				sessionId: "session",
				endpointGeneration: 1,
				createNonce: "stale",
				updatedAt: 1,
				seenEventIds: [],
				seenInteractionIds: [],
			}));
			await store.transact("app:guild:parent:replacement", () => ({
				generation: 1,
				state: "active",
				appId: "app",
				guildId: "guild",
				parentChannelId: "parent",
				threadId: "replacement",
				sessionId: "session",
				endpointGeneration: 2,
				updatedAt: 2,
				supersededByThreadId: "successor",
				seenEventIds: [],
				seenInteractionIds: [],
			}));
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 2, isCurrent: () => true, send: () => {} }),
			});
			await restarted.start();
			expect(await store.read(`app:guild:parent:${stale.id}`)).toBeUndefined();
			expect(await store.read(intentKey)).toBeUndefined();
			expect(
				(await restarted.notify({ sessionId: "session", endpointGeneration: 2, content: "current" })).threadId,
			).toBe("replacement");
			await restarted.stop();
		});
	});

	test("retains action authority when the captured endpoint is replaced or removed before reply", async () => {
		for (const unavailable of ["replaced", "removed"] as const) {
			const frames: Record<string, unknown>[] = [];
			let current = true;
			let deferred = false;
			await withDaemon(
				async (daemon, provider) => {
					const conversation = await daemon.notify({
						sessionId: "session",
						endpointGeneration: 7,
						content: "Choose",
						actionId: "ask",
						options: ["Yes"],
					});
					provider.deferInteraction = async () => {
						if (!deferred) {
							deferred = true;
							current = false;
						}
					};
					await daemon.handleInbound(inbound(conversation.threadId!, `${unavailable}-first`, 7));
					expect(frames).toEqual([]);
					current = true;
					await daemon.handleInbound(inbound(conversation.threadId!, `${unavailable}-first`, 7));
					expect(frames).toMatchObject([
						{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
					]);
				},
				{
					resolveEndpoint: async (): Promise<DiscordEndpointBinding | null> =>
						current
							? {
									generation: 7,
									isCurrent: () => current,
									send: frame => {
										frames.push(frame);
									},
								}
							: unavailable === "removed"
								? null
								: {
										generation: 8,
										isCurrent: () => false,
										send: frame => {
											frames.push(frame);
										},
									},
				},
			);
		}
	});

	test("terminalizes callback-failed and stale action receipts on restart without redelivery", async () => {
		for (const staleBinding of [false, true]) {
			await withDaemon(async (daemon, provider, agentDir) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				provider.deferInteraction = async () => {
					throw new Error("callback failed");
				};
				await expect(
					daemon.handleInbound(inbound(conversation.threadId!, `restart-${staleBinding}`, 1)),
				).rejects.toThrow("callback failed");
				const restarted = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					resolveEndpoint: async () =>
						staleBinding ? null : { generation: 1, isCurrent: () => true, send: () => {} },
				});
				await restarted.start();
				const effects = await new ChatEffectJournal({ agentDir, transport: "discord" }).list();
				expect(effects.find(effect => effect.kind === "discord.inbound.action")?.state).toBe("terminal");
				const stored = JSON.parse(
					await fs.readFile(path.join(agentDir, "sdk", "daemons", "discord", "conversations.json"), "utf8"),
				) as { conversations: Record<string, DiscordConversation> };
				const mapping = Object.values(stored.conversations).find(
					record => record.threadId === conversation.threadId,
				);
				expect(mapping?.pendingActionNonce).toBeUndefined();
				expect(mapping?.inboundDispatches ?? []).toEqual([]);
				await restarted.stop();
			});
		}
	});

	test("retries an interaction after pre-send failure but never resends after cleanup becomes uncertain", async () => {
		const frames: Record<string, unknown>[] = [];
		let current = true;
		let deferFails = true;
		await withDaemon(
			async (daemon, provider) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				provider.deferInteraction = async () => {
					if (deferFails) {
						deferFails = false;
						throw new Error("before send");
					}
				};
				const retry = inbound(conversation.threadId!, "pre-send", 1);
				await expect(daemon.handleInbound(retry)).rejects.toThrow("Discord interaction callback failed");
				await daemon.handleInbound(retry);
				expect(frames).toMatchObject([
					{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
				]);

				current = true;

				const next = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Again",
					actionId: "ask",
					options: ["Yes"],
				});
				const uncertain = inbound(next.threadId!, "post-send", 1);
				provider.deferInteraction = async () => {};
				await daemon.handleInbound(uncertain);
				await daemon.handleInbound(uncertain);
				expect(frames).toHaveLength(2);
				expect(frames[1]).toMatchObject({
					type: "reply",
					id: "ask",
					answer: "yes",
					idempotencyKey: expect.any(String),
				});
			},
			{
				resolveEndpoint: async (): Promise<DiscordEndpointBinding | null> => ({
					generation: 1,
					isCurrent: () => current,
					send: frame => {
						frames.push(frame);
						current = false;
					},
				}),
			},
		);
	});
	test("rejects stale generations before action mapping mutation or provider publication", async () => {
		let generation = 1;
		await withDaemon(
			async (daemon, provider, agentDir) => {
				const initial = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
				generation = 2;
				await expect(
					daemon.notify({
						sessionId: "session",
						endpointGeneration: 1,
						content: "must not mutate",
						actionId: "stale",
						options: ["No"],
					}),
				).rejects.toBeInstanceOf(DiscordEndpointBindingError);
				const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
				const mapping = await store.read(`app:guild:parent:${initial.threadId}`);
				expect(mapping).toMatchObject({ endpointGeneration: 1 });
				expect(mapping?.pendingActionId).toBeUndefined();
				expect(provider.messages).toEqual([{ threadId: initial.threadId!, content: "open" }]);

				generation = 1;
				provider.findMessageByNonce = async () => {
					generation = 2;
					return null;
				};
				await expect(
					daemon.notify({
						sessionId: "session",
						endpointGeneration: 1,
						content: "must not publish",
						actionId: "raced",
						options: ["No"],
					}),
				).rejects.toThrow("lost its fence");
				expect(provider.messages).toEqual([{ threadId: initial.threadId!, content: "open" }]);
				const raced = (await new ChatEffectJournal({ agentDir, transport: "discord" }).list()).find(
					effect =>
						effect.kind === "post-message" &&
						(effect.payload as { content?: string }).content === "must not publish",
				);
				expect(raced?.state).toBe("leased");
			},
			{
				resolveEndpoint: async (): Promise<DiscordEndpointBinding> => ({
					generation,
					isCurrent: () => generation === 1,
					send: () => {},
				}),
			},
		);
	});

	test("retries typed command pre-send delivery failures but retains ambiguous delivery", async () => {
		let retryableAttempts = 0;
		let ambiguousAttempts = 0;
		await withDaemon(
			async (daemon, _provider, agentDir) => {
				const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
				const retryable = {
					...inbound(conversation.threadId!, "command-retryable", 1),
					interaction: undefined,
					content: "/sdk query retryable {}",
				};
				await daemon.handleInbound(retryable);
				const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
				expect(
					await journal.read(`discord:app:guild:parent:${conversation.threadId}:command-retryable`),
				).toMatchObject({
					state: "accepted",
					receipt: { status: "pre_send_failure" },
				});
				await daemon.handleInbound(retryable);
				expect(retryableAttempts).toBe(2);

				const ambiguous = {
					...inbound(conversation.threadId!, "command-ambiguous", 1),
					interaction: undefined,
					content: "/sdk query ambiguous {}",
				};
				await daemon.handleInbound(ambiguous);
				expect(
					await journal.read(`discord:app:guild:parent:${conversation.threadId}:command-ambiguous`),
				).toMatchObject({
					state: "uncertain",
					receipt: { status: "uncertain" },
				});
				await daemon.handleInbound(ambiguous);
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

	test("retries definite pre-send SDK and binding failures but preserves ambiguous sends", async () => {
		const frames: Record<string, unknown>[] = [];
		const failures: Error[] = [
			new DiscordEndpointBindingError(),
			new SdkClientError("connection_closed", "SDK unavailable before send"),
		];
		let ambiguous = false;
		await withDaemon(
			async (daemon, _provider, agentDir) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				const retry = inbound(conversation.threadId!, "definite-pre-send", 1);
				for (let attempt = 0; attempt < 2; attempt++) {
					await daemon.handleInbound(retry);
					const effect = await new ChatEffectJournal({ agentDir, transport: "discord" }).read(
						`discord:app:guild:parent:${conversation.threadId}:definite-pre-send`,
					);
					expect(effect).toMatchObject({ state: "accepted", receipt: { status: "deferred" } });
				}
				const effectsPath = path.join(agentDir, "sdk", "daemons", "discord", "effects.json");
				expect(await fs.readFile(effectsPath, "utf8")).not.toContain("token-definite-pre-send");
				await daemon.handleInbound(retry);
				expect(frames).toHaveLength(1);

				const uncertain = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Again",
					actionId: "ask",
					options: ["Yes"],
				});
				ambiguous = true;
				await daemon.handleInbound(inbound(uncertain.threadId!, "ambiguous-send", 1));
				const uncertainEffect = await new ChatEffectJournal({ agentDir, transport: "discord" }).read(
					`discord:app:guild:parent:${uncertain.threadId}:ambiguous-send`,
				);
				expect(uncertainEffect).toMatchObject({ state: "uncertain", receipt: { status: "uncertain" } });
				await daemon.handleInbound(inbound(uncertain.threadId!, "ambiguous-send", 1));
				expect(frames).toHaveLength(2);
			},
			{
				resolveEndpoint: async (): Promise<DiscordEndpointBinding> => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						const failure = failures.shift();
						if (failure) throw failure;
						frames.push(frame);
						if (ambiguous) throw new SdkClientError("unavailable", "SDK disconnected after send");
					},
				}),
			},
		);
	});

	test("recovers a callback-defer intent after the callback lease expires and fences a stale claimer", async () => {
		const frames: Record<string, unknown>[] = [];
		let now = 0;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await withDaemon(
			async (_daemon, provider, agentDir) => {
				const endpoint = async (): Promise<DiscordEndpointBinding> => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						frames.push(frame);
					},
				});
				const first = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: endpoint,
				});
				const conversation = await first.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				provider.deferInteraction = async () => {
					entered.resolve();
					await release.promise;
				};
				const blocked = first.handleInbound(inbound(conversation.threadId!, "claim-before-send", 1));
				await entered.promise;
				now = 60_001;
				const restarted = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: endpoint,
				});
				await restarted.start();
				expect(frames).toHaveLength(1);
				release.resolve();
				await blocked;
				expect(frames).toHaveLength(1);

				const retry = await restarted.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Again",
					actionId: "ask-retry",
					options: ["Yes"],
				});
				const retryCustomId = `gjc:1:ask-retry:${retry.pendingActionNonce!}`;
				provider.deferInteraction = async () => {
					throw new Error("Discord API request failed (400)");
				};
				await expect(
					restarted.handleInbound(inbound(retry.threadId!, "definite-pre-send", 1, retryCustomId)),
				).rejects.toThrow("Discord interaction callback failed");
				const afterPreSend = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: endpoint,
				});
				await afterPreSend.start();
				expect(frames).toHaveLength(1);

				const uncertain = await afterPreSend.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Last",
					actionId: "ask-uncertain",
					options: ["Yes"],
				});
				expect(uncertain.pendingActionNonce).toBeDefined();
				const uncertainCustomId = `gjc:1:ask-uncertain:${uncertain.pendingActionNonce!}`;
				provider.deferInteraction = async () => {};
				const originalSend = (await endpoint()).send;
				const throwingEndpoint = async (): Promise<DiscordEndpointBinding> => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						originalSend(frame);
						throw new Error("accepted then disconnected");
					},
				});
				const sender = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: throwingEndpoint,
				});
				await sender.handleInbound(inbound(uncertain.threadId!, "uncertain-post-send", 1, uncertainCustomId));
				expect(frames).toHaveLength(2);
				const afterUncertain = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					now: () => now,
					resolveEndpoint: endpoint,
				});
				await afterUncertain.start();
				expect(frames).toHaveLength(2);
			},
			{
				resolveEndpoint: async () => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						frames.push(frame);
					},
				}),
			},
		);
	});

	test("rejects stale commands before dispatch", async () => {
		const commands: string[] = [];
		let generation = 3;
		await withDaemon(
			async (daemon, provider) => {
				const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 3, content: "open" });
				generation = 4;
				await daemon.handleInbound({
					...inbound(conversation.threadId!, "stale-command"),
					interaction: undefined,
					content: "/sdk query todo.list {}",
				});
				expect(commands).toEqual([]);
				expect(provider.messages.at(-1)).toEqual({
					threadId: conversation.threadId!,
					content: "This conversation is no longer available.",
				});
			},
			{
				resolveEndpoint: async () => ({ generation, isCurrent: () => true, send: () => {} }),
				onCommand: async (_sessionId, content) => {
					commands.push(content);
					return true;
				},
			},
		);
	});
	test("keeps interaction callback tokens out of durable effects", async () => {
		await withDaemon(async (daemon, _provider, agentDir) => {
			const conversation = await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "Choose",
				actionId: "ask",
				options: ["Yes"],
			});
			await daemon.handleInbound(inbound(conversation.threadId!, "token-private", 1));
			const effects = await fs.readFile(path.join(agentDir, "sdk", "daemons", "discord", "effects.json"), "utf8");
			expect(effects).not.toContain("token-token-private");
			expect(effects).not.toContain('"token"');
		});
	});
	test("recovers a durable callback intent across crashes immediately before and after defer", async () => {
		for (const crashPoint of ["before_remote", "after_remote"] as const) {
			const frames: Record<string, unknown>[] = [];
			let now = 0;
			let deferred = 0;
			let deferReturned = false;
			let recovery: DiscordNotificationDaemon | undefined;
			const crashReached = Promise.withResolvers<void>();
			const releaseCrash = Promise.withResolvers<void>();
			const originalRecordReceipt = ChatEffectJournal.prototype.recordReceipt;
			const originalRenew = ChatEffectJournal.prototype.renew;
			try {
				await withDaemon(
					async (daemon, provider, agentDir) => {
						const conversation = await daemon.notify({
							sessionId: "session",
							endpointGeneration: 1,
							content: "Choose",
							actionId: "ask",
							options: ["Yes"],
						});
						const effectId = `discord:app:guild:parent:${conversation.threadId}:crash-${crashPoint}`;
						if (crashPoint === "before_remote") {
							vi.spyOn(ChatEffectJournal.prototype, "recordReceipt").mockImplementation(async function <
								TPayload,
							>(
								this: ChatEffectJournal,
								id: string,
								lease: ChatEffectLease,
								receipt: ChatEffectReceipt,
							): Promise<ChatEffect<TPayload> | undefined> {
								const recorded = (await originalRecordReceipt.call(this, id, lease, receipt)) as
									| ChatEffect<TPayload>
									| undefined;
								if (id === effectId && receipt.status === "defer_intent") {
									crashReached.resolve();
									await releaseCrash.promise;
								}
								return recorded;
							});
						} else {
							vi.spyOn(ChatEffectJournal.prototype, "renew").mockImplementation(async function <TPayload>(
								this: ChatEffectJournal,
								id: string,
								lease: ChatEffectLease,
								leaseMs: number,
							): Promise<ChatEffect<TPayload> | undefined> {
								const renewed = (await originalRenew.call(this, id, lease, leaseMs)) as
									| ChatEffect<TPayload>
									| undefined;
								if (id === effectId && lease.epoch === 1 && deferReturned) {
									crashReached.resolve();
									await releaseCrash.promise;
								}
								return renewed;
							});
						}
						provider.deferInteraction = async () => {
							deferred++;
							deferReturned = true;
						};
						const handling = daemon.handleInbound(inbound(conversation.threadId!, `crash-${crashPoint}`, 1));
						await crashReached.promise;

						const journal = new ChatEffectJournal({ agentDir, transport: "discord", now: () => now });
						const prepared = await journal.read(effectId);
						expect(prepared).toMatchObject({
							state: "leased",
							receipt: { status: "defer_intent" },
						});
						expect(JSON.stringify(prepared)).not.toContain(`token-crash-${crashPoint}`);
						expect(prepared?.id).toBe(effectId);
						expect(prepared?.generation).toBeGreaterThan(1);

						now = 60_001;
						recovery = new DiscordNotificationDaemon({
							agentDir,
							repo: agentDir,
							guildId: "guild",
							parentChannelId: "parent",
							provider,
							now: () => now,
							resolveEndpoint: async () => ({
								generation: 1,
								isCurrent: () => true,
								send: frame => {
									frames.push(frame);
								},
							}),
						});
						await recovery.start();
						expect(deferred).toBe(crashPoint === "before_remote" ? 0 : 1);
						expect(frames).toMatchObject([
							{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
						]);
						expect(frames).toHaveLength(1);
						expect(await journal.read(effectId)).toMatchObject({ state: "terminal" });

						releaseCrash.resolve();
						await handling;
						expect(deferred).toBe(crashPoint === "before_remote" ? 0 : 1);
						expect(frames).toHaveLength(1);
						await recovery.stop();
						recovery = undefined;
					},
					{ now: () => now },
				);
			} finally {
				releaseCrash.resolve();
				await recovery?.stop();
				vi.restoreAllMocks();
			}
		}
	});

	test("recovers a deferred action after a definite SDK pre-send failure without its callback token", async () => {
		const frames: Record<string, unknown>[] = [];
		let deferred = 0;
		await withDaemon(
			async (daemon, provider, agentDir) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				provider.deferInteraction = async () => {
					deferred++;
				};
				await daemon.handleInbound(inbound(conversation.threadId!, "deferred-retry", 1));

				const effectId = `discord:app:guild:parent:${conversation.threadId}:deferred-retry`;
				const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
				expect(await journal.read(effectId)).toMatchObject({ state: "accepted", receipt: { status: "deferred" } });
				const effects = await fs.readFile(path.join(agentDir, "sdk", "daemons", "discord", "effects.json"), "utf8");
				expect(effects).not.toContain("token-deferred-retry");

				const recovered = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					resolveEndpoint: async () => ({
						generation: 1,
						isCurrent: () => true,
						send: frame => {
							frames.push(frame);
						},
					}),
				});
				await recovered.start();
				expect(deferred).toBe(1);
				expect(frames).toMatchObject([
					{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
				]);
				expect(await journal.read(effectId)).toMatchObject({ state: "terminal" });
				await recovered.stop();
			},
			{
				resolveEndpoint: async () => ({
					generation: 1,
					isCurrent: () => true,
					send: () => {
						throw new DiscordEndpointBindingError();
					},
				}),
			},
		);
	});

	test("reconstructs an uncertain post receipt from its stable nonce without a duplicate", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			provider.failPostAfterPersist = true;
			await expect(daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" })).rejects.toThrow(
				"Discord disconnected after accepting post",
			);
			expect(provider.messages).toHaveLength(1);
			expect([...provider.messageNonces.keys()][0]).toMatch(/^gjc-[a-f0-9]{21}$/);
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
			});
			await restarted.start();
			expect(provider.messages).toHaveLength(1);
			await restarted.stop();
		});
	});

	test("reconciles an accepted action post after disconnect and accepts its published custom ID once", async () => {
		const frames: Record<string, unknown>[] = [];
		await withDaemon(async (daemon, provider, agentDir) => {
			provider.failPostAfterPersist = true;
			await expect(
				daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				}),
			).rejects.toThrow("Discord disconnected after accepting post");
			const threadId = provider.messages[0]!.threadId;
			const publishedCustomId = actionCustomIds.get(threadId)!;
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						frames.push(frame);
					},
				}),
			});
			await restarted.start();
			expect(provider.messages).toHaveLength(1);
			expect(actionCustomIds.get(threadId)).toBe(publishedCustomId);
			await restarted.handleInbound(inbound(threadId, "accepted-action", 1));
			expect(frames).toMatchObject([
				{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
			]);
			await restarted.handleInbound({
				...inbound(threadId, "duplicate-action", 1),
				interaction: {
					id: "interaction-duplicate-action",
					token: "token-duplicate-action",
					customId: publishedCustomId,
					value: "yes",
				},
			});
			expect(frames).toHaveLength(1);
			await restarted.stop();
		});
	});
	test("reuses a durable action publication intent after remote acceptance, reconnect, and repeated notification", async () => {
		const frames: Record<string, unknown>[] = [];
		await withDaemon(async (daemon, provider, agentDir) => {
			provider.failPostAfterPersist = true;
			await expect(
				daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				}),
			).rejects.toThrow("Discord disconnected after accepting post");
			const threadId = provider.messages[0]!.threadId;
			const publishedCustomId = actionCustomIds.get(threadId)!;
			const retried = await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "Choose again",
				actionId: "ask",
				options: ["Yes"],
			});
			expect(retried.pendingActionEffectId).toMatch(/^action-publication:/);
			expect(provider.messages).toHaveLength(1);
			expect(actionCustomIds.get(threadId)).toBe(publishedCustomId);

			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						frames.push(frame);
					},
				}),
			});
			await restarted.start();
			await restarted.handleInbound({
				...inbound(threadId, "original-route", 1),
				interaction: {
					id: "interaction-original-route",
					token: "token-original-route",
					customId: publishedCustomId,
					value: "yes",
				},
			});
			await restarted.handleInbound({
				...inbound(threadId, "original-route-duplicate", 1),
				interaction: {
					id: "interaction-original-route-duplicate",
					token: "token-original-route-duplicate",
					customId: publishedCustomId,
					value: "yes",
				},
			});
			expect(frames).toMatchObject([
				{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
			]);
			expect(frames).toHaveLength(1);
			await restarted.stop();
		});
	});
	test("rebinds an orphaned durable command effect during startup", async () => {
		const commands: string[] = [];
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
			const effectId = `discord:app:guild:parent:${conversation.threadId}:orphan-command`;
			await journal.enqueue({
				id: effectId,
				kind: "discord.inbound.command",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "command",
					content: "/sdk query recovered",
					idempotencyKey: effectId,
					routing: {
						guildId: "guild",
						parentId: "parent",
						threadId: conversation.threadId!,
						eventId: "orphan-command",
						kind: "command",
					},
				},
			});
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
				onCommand: async (_sessionId, command) => {
					commands.push(command);
					return true;
				},
			});
			await restarted.start();
			expect(commands).toEqual(["/sdk query recovered"]);
			await restarted.stop();
		});
	});
	test("completes recovery before Gateway delivery", async () => {
		const commands: string[] = [];
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const effectId = `discord:app:guild:parent:${conversation.threadId}:recovered`;
			await new ChatEffectJournal({ agentDir, transport: "discord" }).enqueue({
				id: effectId,
				kind: "discord.inbound.command",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "command",
					content: "/sdk recovered",
					idempotencyKey: effectId,
					routing: {
						guildId: "guild",
						parentId: "parent",
						threadId: conversation.threadId!,
						eventId: "recovered",
						kind: "command",
					},
				},
			});
			provider.startEvent = {
				...inbound(conversation.threadId!, "early"),
				interaction: undefined,
				content: "/sdk early",
			};
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
				onCommand: async (_sessionId, content) => {
					commands.push(content);
					return true;
				},
			});
			await restarted.start();
			expect(commands).toEqual(["/sdk recovered", "/sdk early"]);
			await restarted.stop();
		});
	});
	test("terminalizes a rejected orphan action after restart without dispatching it", async () => {
		const frames: Record<string, unknown>[] = [];
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "Choose",
				actionId: "ask",
				options: ["Yes"],
			});
			const effectId = `discord:app:guild:parent:${conversation.threadId}:crashed-rejected`;
			await new ChatEffectJournal({ agentDir, transport: "discord" }).enqueue({
				id: effectId,
				kind: "discord.inbound.action",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "reply",
					id: "ask",
					answer: "yes",
					idempotencyKey: effectId,
					routing: {
						guildId: "guild",
						parentId: "parent",
						threadId: conversation.threadId!,
						eventId: "crashed-rejected",
						interactionId: "interaction-crashed-rejected",
						kind: "action",
						actionId: "ask",
					},
				},
			});
			await daemon.resolveAction("session", "ask");
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						frames.push(frame);
					},
				}),
			});
			await restarted.start();
			expect(frames).toEqual([]);
			expect((await new ChatEffectJournal({ agentDir, transport: "discord" }).read(effectId))?.receipt).toEqual({
				status: "rejected",
			});
			await restarted.stop();
		});
	});
	test("terminalizes a mapping-rejected click and never adopts it after action ID reuse", async () => {
		const frames: Record<string, unknown>[] = [];
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "First",
				actionId: "ask",
				options: ["Yes"],
			});
			const oldCustomId = actionCustomIds.get(conversation.threadId!)!;
			await daemon.resolveAction("session", "ask");
			await daemon.handleInbound({
				...inbound(conversation.threadId!, "reused-rejected", 1),
				interaction: {
					id: "interaction-reused-rejected",
					token: "token-reused-rejected",
					customId: oldCustomId,
					value: "yes",
				},
			});
			const effectId = `discord:app:guild:parent:${conversation.threadId}:reused-rejected`;
			expect((await new ChatEffectJournal({ agentDir, transport: "discord" }).read(effectId))?.receipt).toEqual({
				status: "rejected",
			});
			await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "Second",
				actionId: "ask",
				options: ["Yes"],
			});
			expect(actionCustomIds.get(conversation.threadId!)).not.toBe(oldCustomId);
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({
					generation: 1,
					isCurrent: () => true,
					send: frame => {
						frames.push(frame);
					},
				}),
			});
			await restarted.start();
			expect(frames).toEqual([]);
			await restarted.stop();
		});
	});
	test("terminalizes stale non-closing archive and unarchive effects before provider calls", async () => {
		let generation = 1;
		await withDaemon(
			async (daemon, provider, agentDir) => {
				const archive = await daemon.notify({ sessionId: "archive", endpointGeneration: 1, content: "open" });
				const unarchive = await daemon.notify({ sessionId: "unarchive", endpointGeneration: 1, content: "open" });
				const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
				const unarchiveKey = `app:guild:parent:${unarchive.threadId}`;
				const unarchiveRecord = await store.read(unarchiveKey);
				expect(unarchiveRecord).toBeDefined();
				await store.write(unarchiveKey, unarchiveRecord!.generation, {
					...unarchiveRecord!,
					generation: unarchiveRecord!.generation + 1,
					state: "resuming",
					updatedAt: Date.now(),
				});
				const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
				await journal.enqueue({
					id: "live-stale-archive",
					kind: "archive",
					transport: "discord",
					sessionId: "archive",
					endpointGeneration: 1,
					payload: { threadId: archive.threadId! },
				});
				await journal.enqueue({
					id: "live-stale-unarchive",
					kind: "unarchive",
					transport: "discord",
					sessionId: "unarchive",
					endpointGeneration: 1,
					payload: { threadId: unarchive.threadId! },
				});
				generation = 2;
				await daemon.start();
				for (const id of ["live-stale-archive", "live-stale-unarchive"])
					expect(await journal.read(id)).toMatchObject({ state: "terminal", receipt: { status: "stale_noop" } });
				expect(provider.archived).toEqual([]);
				expect(provider.unarchived).toEqual([]);
			},
			{
				resolveEndpoint: async () => ({ generation, isCurrent: () => generation === 1, send: () => {} }),
			},
		);
	});

	test("terminalizes stale post, archive, and unarchive effects after close and generation-rotated resume", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const original = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
			await journal.enqueue({
				id: "stale-post",
				kind: "post-message",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: { threadId: original.threadId!, content: "must not post", nonce: "stale-post" },
			});
			await daemon.close("session");
			await journal.enqueue({
				id: "stale-archive",
				kind: "archive",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: { threadId: original.threadId! },
			});
			const archived = await daemon.notify({
				sessionId: "resumed-session",
				endpointGeneration: 1,
				content: "open resumed",
			});
			await daemon.archive("resumed-session");
			await journal.enqueue({
				id: "stale-unarchive",
				kind: "unarchive",
				transport: "discord",
				sessionId: "resumed-session",
				endpointGeneration: 1,
				payload: { threadId: archived.threadId! },
			});
			await daemon.resume("resumed-session", 2);
			await daemon.start();
			for (const id of ["stale-post", "stale-archive", "stale-unarchive"]) {
				expect(await journal.read(id)).toMatchObject({ state: "terminal", receipt: { status: "stale_noop" } });
			}
			expect(provider.messages.some(message => message.content === "must not post")).toBeFalse();
			const archiveCount = provider.archived.length;
			const unarchived = provider.unarchived.length;
			await Bun.sleep(50);
			for (const id of ["stale-post", "stale-archive", "stale-unarchive"])
				expect((await journal.read(id))?.state).toBe("terminal");
			expect(provider.archived).toHaveLength(archiveCount);
			expect(provider.unarchived).toHaveLength(unarchived);
		});
	});
	test("propagates callback defer failures through Gateway delivery after recording the receipt", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({
				sessionId: "session",
				endpointGeneration: 1,
				content: "Choose",
				actionId: "ask",
				options: ["Yes"],
			});
			provider.deferInteraction = async () => {
				throw new Error("callback unavailable");
			};
			provider.startEvent = inbound(conversation.threadId!, "callback-health", 1);
			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
			});
			await expect(restarted.start()).rejects.toThrow("Discord interaction callback failed");
			const effectId = `discord:app:guild:parent:${conversation.threadId}:callback-health`;
			expect((await new ChatEffectJournal({ agentDir, transport: "discord" }).read(effectId))?.receipt).toEqual({
				status: "defer_intent",
			});
		});
	});
	test("recovers a dead unexpired inbound lease without another gateway event and cancels it on stop", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-discord-lease-recovery-"));
		let restarted: DiscordNotificationDaemon | undefined;
		try {
			let now = 0;
			let failScheduledDrain = false;
			let failedScheduledDrains = 0;
			const provider = new FakeDiscordProvider();
			const endpoint = async (): Promise<DiscordEndpointBinding> => {
				if (failScheduledDrain) {
					failedScheduledDrains++;
					throw new Error("transient endpoint lookup failure");
				}
				return { generation: 1, isCurrent: () => true, send: () => {} };
			};
			const first = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				now: () => now,
				resolveEndpoint: endpoint,
			});
			const conversation = await first.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const journal = new ChatEffectJournal({ agentDir, transport: "discord", now: () => now });
			const leasedEffectId = `discord:app:guild:parent:${conversation.threadId}:leased-command`;
			const stoppedEffectId = `discord:app:guild:parent:${conversation.threadId}:stopped-command`;
			await journal.enqueue({
				id: leasedEffectId,
				kind: "discord.inbound.command",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "command",
					content: "/sdk query recovered",
					idempotencyKey: leasedEffectId,
					routing: {
						guildId: "guild",
						parentId: "parent",
						threadId: conversation.threadId!,
						eventId: "leased-command",
						kind: "command",
					},
				},
			});
			await journal.claim(leasedEffectId, "dead-worker", 10);
			const commands: string[] = [];
			restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				now: () => now,
				resolveEndpoint: endpoint,
				onCommand: async (_sessionId, command) => {
					commands.push(command);
					return true;
				},
			});
			await restarted.start();
			failScheduledDrain = true;
			now = 11;
			await Bun.sleep(30);
			expect(failedScheduledDrains).toBe(1);
			failScheduledDrain = false;
			await Bun.sleep(100);
			expect(commands).toEqual(["/sdk query recovered"]);
			await restarted.stop();
			restarted = undefined;

			await journal.enqueue({
				id: stoppedEffectId,
				kind: "discord.inbound.command",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "command",
					content: "/sdk query stopped",
					idempotencyKey: stoppedEffectId,
					routing: {
						guildId: "guild",
						parentId: "parent",
						threadId: conversation.threadId!,
						eventId: "stopped-command",
						kind: "command",
					},
				},
			});
			now = 20;
			await journal.claim(stoppedEffectId, "dead-worker", 10);
			const stoppedCommands: string[] = [];
			restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				now: () => now,
				resolveEndpoint: endpoint,
				onCommand: async (_sessionId, command) => {
					stoppedCommands.push(command);
					return true;
				},
			});
			await restarted.start();
			await restarted.stop();
			restarted = undefined;
			now = 31;
			await Bun.sleep(20);
			expect(stoppedCommands).toEqual([]);
		} finally {
			await restarted?.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
	test("preserves a lost defer response as a token-free SDK-recoverable intent", async () => {
		const frames: Record<string, unknown>[] = [];
		await withDaemon(
			async (daemon, provider, agentDir) => {
				const conversation = await daemon.notify({
					sessionId: "session",
					endpointGeneration: 1,
					content: "Choose",
					actionId: "ask",
					options: ["Yes"],
				});
				provider.deferInteraction = async () => {
					throw new Error("connection lost after Discord accepted the callback");
				};
				await expect(
					daemon.handleInbound(inbound(conversation.threadId!, "defer-response-lost", 1)),
				).rejects.toThrow("Discord interaction callback failed");

				const effectId = `discord:app:guild:parent:${conversation.threadId}:defer-response-lost`;
				const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
				expect(await journal.read(effectId)).toMatchObject({
					state: "accepted",
					receipt: { status: "defer_intent" },
				});
				expect(
					await fs.readFile(path.join(agentDir, "sdk", "daemons", "discord", "effects.json"), "utf8"),
				).not.toContain("token-defer-response-lost");

				const recovery = new DiscordNotificationDaemon({
					agentDir,
					repo: agentDir,
					guildId: "guild",
					parentChannelId: "parent",
					provider,
					resolveEndpoint: async () => ({
						generation: 1,
						isCurrent: () => true,
						send: frame => {
							frames.push(frame);
						},
					}),
				});
				await recovery.start();
				expect(frames).toMatchObject([
					{ type: "reply", id: "ask", answer: "yes", idempotencyKey: expect.any(String) },
				]);
				expect(await journal.read(effectId)).toMatchObject({ state: "terminal" });
				await recovery.stop();
			},
			{
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
			},
		);
	});

	test("fences a stopped Gateway start and keeps repeated starts idempotent", async () => {
		await withDaemon(async (daemon, provider) => {
			const startEntered = Promise.withResolvers<void>();
			const releaseStart = Promise.withResolvers<void>();
			let starts = 0;
			let stops = 0;
			let blockStart = true;
			provider.start = async onEvent => {
				starts++;
				if (blockStart) {
					startEntered.resolve();
					await releaseStart.promise;
				}
				provider.handler = onEvent;
			};
			provider.stop = async () => {
				stops++;
				provider.handler = undefined;
			};

			const starting = daemon.start();
			await startEntered.promise;
			const stopping = daemon.stop();
			releaseStart.resolve();
			await stopping;
			await starting;
			expect(provider.handler).toBeUndefined();
			expect(stops).toBeGreaterThan(0);

			blockStart = false;
			await daemon.start();
			await daemon.start();
			expect(starts).toBe(2);
		});
	});

	test("uses immutable journal identities and fences live leases from stale cleanup", async () => {
		await withDaemon(async (_daemon, _provider, agentDir) => {
			const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
			const input = {
				id: "immutable-effect",
				kind: "post-message",
				transport: "discord" as const,
				sessionId: "session",
				endpointGeneration: 1,
				payload: { threadId: "thread", content: "first" },
			};
			await journal.enqueue(input);
			expect((await journal.enqueue(input)).id).toBe(input.id);
			await expect(
				journal.enqueue({ ...input, payload: { threadId: "thread", content: "changed" } }),
			).rejects.toThrow("immutable identity");
			await expect(journal.enqueueAndClaim({ ...input, kind: "archive" }, "owner", 60_000)).rejects.toThrow(
				"immutable identity",
			);

			const leased = await journal.enqueueAndClaim(
				{ ...input, id: "live-effect", payload: { threadId: "thread", content: "live" } },
				"owner",
				60_000,
			);
			expect(leased).toBeDefined();
			await journal.terminalize("live-effect", { status: "stale_noop" });
			expect(await journal.read("live-effect")).toMatchObject({ state: "leased", owner: "owner" });
			await journal.record("live-effect", { owner: "owner", epoch: leased!.epoch }, "terminal");
		});
	});

	test("keeps a terminal effect referenced by a crash-window receipt through terminal pruning", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const effectId = `discord:app:guild:parent:${conversation.threadId}:prune-receipt`;
			const journal = new ChatEffectJournal({ agentDir, transport: "discord" });
			await journal.enqueue({
				id: effectId,
				kind: "discord.inbound.command",
				transport: "discord",
				sessionId: "session",
				endpointGeneration: 1,
				payload: {
					type: "command",
					content: "/sdk query preserved",
					idempotencyKey: effectId,
					routing: {
						guildId: "guild",
						parentId: "parent",
						threadId: conversation.threadId!,
						eventId: "prune-receipt",
						kind: "command",
					},
				},
			});
			const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
			const key = `app:guild:parent:${conversation.threadId}`;
			const mapping = await store.read(key);
			expect(mapping).toBeDefined();
			await store.write(key, mapping!.generation, {
				...mapping!,
				generation: mapping!.generation + 1,
				updatedAt: Date.now(),
				inboundDispatches: [
					{
						key: "prune-receipt",
						eventId: "prune-receipt",
						kind: "command",
						endpointGeneration: 1,
						effectId,
						idempotencyKey: effectId,
					},
				],
			});
			const lease = await journal.claim(effectId, "owner", 60_000);
			await journal.record(effectId, { owner: "owner", epoch: lease!.epoch }, "terminal");
			for (let index = 0; index < 129; index++) {
				const id = `terminal-prune-${index}`;
				await journal.enqueue({
					id,
					kind: "post-message",
					transport: "discord",
					sessionId: "session",
					endpointGeneration: 1,
					payload: { threadId: conversation.threadId!, content: String(index) },
				});
				const terminalLease = await journal.claim(id, "owner", 60_000);
				await journal.record(id, { owner: "owner", epoch: terminalLease!.epoch }, "terminal");
			}
			expect(await journal.read(effectId)).toMatchObject({ state: "terminal" });

			const restarted = new DiscordNotificationDaemon({
				agentDir,
				repo: agentDir,
				guildId: "guild",
				parentChannelId: "parent",
				provider,
				resolveEndpoint: async () => ({ generation: 1, isCurrent: () => true, send: () => {} }),
			});
			await restarted.start();
			expect((await store.read(key))?.inboundDispatches ?? []).toEqual([]);
			await restarted.stop();
		});
	});

	test("retains a receipt with a missing referenced effect for scheduled recovery", async () => {
		await withDaemon(async (daemon, _provider, agentDir) => {
			const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
			const key = `app:guild:parent:${conversation.threadId}`;
			const mapping = await store.read(key);
			expect(mapping).toBeDefined();
			const effectId = `discord:app:guild:parent:${conversation.threadId}:missing-effect`;
			await store.write(key, mapping!.generation, {
				...mapping!,
				generation: mapping!.generation + 1,
				updatedAt: Date.now(),
				inboundDispatches: [
					{
						key: "missing-effect",
						eventId: "missing-effect",
						kind: "command",
						endpointGeneration: 1,
						effectId,
						idempotencyKey: effectId,
					},
				],
			});

			await daemon.start();
			await Bun.sleep(30);
			expect((await store.read(key))?.inboundDispatches).toEqual([
				expect.objectContaining({ effectId, eventId: "missing-effect" }),
			]);
		});
	});

	test("backfills a legacy active mapping's archive effect lineage from its creation nonce", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
			const threadId = "legacy-active";
			const createNonce = "legacy-active-cycle";
			const key = `app:guild:parent:${threadId}`;
			await store.transact(key, () => ({
				generation: 1,
				state: "active",
				appId: "app",
				guildId: "guild",
				parentChannelId: "parent",
				threadId,
				sessionId: "legacy-active-session",
				endpointGeneration: 1,
				createNonce,
				updatedAt: 1,
				seenEventIds: [],
				seenInteractionIds: [],
			}));

			await daemon.archive("legacy-active-session");
			expect(await store.read(key)).toMatchObject({ state: "archived", effectIncarnationId: createNonce });
			expect(provider.archived).toEqual([{ threadId }]);
			const archive = (await new ChatEffectJournal({ agentDir, transport: "discord" }).list()).find(
				effect => effect.kind === "archive" && effect.id.startsWith(`archive:${threadId}:${createNonce}:`),
			);
			expect(archive).toBeDefined();
		});
	});

	test("backfills a legacy archived mapping before resuming its next lifecycle cycle", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const store = new ConversationStore<DiscordConversation>({ agentDir, kind: "discord" });
			const threadId = "legacy-archived";
			const createNonce = "legacy-archived-cycle";
			const key = `app:guild:parent:${threadId}`;
			await store.transact(key, () => ({
				generation: 1,
				state: "archived",
				appId: "app",
				guildId: "guild",
				parentChannelId: "parent",
				threadId,
				sessionId: "legacy-archived-session",
				endpointGeneration: 1,
				createNonce,
				updatedAt: 1,
				seenEventIds: [],
				seenInteractionIds: [],
			}));

			const resumed = await daemon.resume("legacy-archived-session", 2);
			expect(resumed).toMatchObject({ state: "active", effectIncarnationId: createNonce });
			expect(provider.unarchived).toEqual([threadId]);
			await daemon.archive("legacy-archived-session");
			const effects = (await new ChatEffectJournal({ agentDir, transport: "discord" }).list()).filter(
				effect =>
					(effect.kind === "archive" || effect.kind === "unarchive") &&
					effect.id.includes(`:${threadId}:${createNonce}:`),
			);
			expect(effects).toHaveLength(2);
			expect(new Set(effects.map(effect => effect.id)).size).toBe(2);
		});
	});

	test("uses a fresh durable archive occurrence for every archive cycle", async () => {
		await withDaemon(async (daemon, provider, agentDir) => {
			const conversation = await daemon.notify({ sessionId: "session", endpointGeneration: 1, content: "open" });
			await daemon.archive("session");
			await daemon.resume("session", 1);
			await daemon.archive("session");
			expect(provider.archived).toEqual([
				{ threadId: conversation.threadId! },
				{ threadId: conversation.threadId! },
			]);
			const archiveEffects = (await new ChatEffectJournal({ agentDir, transport: "discord" }).list()).filter(
				effect => effect.kind === "archive" && effect.receipt?.status === "archive",
			);
			expect(new Set(archiveEffects.map(effect => effect.id)).size).toBe(2);
		});
	});
});
