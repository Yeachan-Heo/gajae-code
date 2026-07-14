import { randomUUID } from "node:crypto";
import { SdkClientError } from "../client/client";
import { readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";
import type { ChatDeliveryError } from "./chat-daemon-runtime";
import { ConversationStore } from "./conversation-store";
import {
	acceptsSlackInbound,
	normalizeSlackConversation,
	type SlackConversation,
	type SlackInboundDispatchReceipt,
	slackConversationKey,
} from "./slack-conversation";

export class SlackEndpointBindingError extends Error {
	constructor(message = "Slack session endpoint changed before dispatch.") {
		super(message);
		this.name = "SlackEndpointBindingError";
	}
}

class SlackStaleEffectError extends Error {
	constructor() {
		super("Slack effect is no longer current");
	}
}

class SlackReconciledAbsentEffectError extends Error {
	constructor() {
		super("Slack effect was not found during reconciliation");
	}
}

import { type ChatEffect, ChatEffectJournal, type ChatEffectLease } from "./chat-effect-journal";
import { SlackProviderError } from "./slack-live-provider";
import type { SlackPostedMessage, SlackProvider, SlackSocketEnvelope } from "./slack-provider";

// Durable filesystem publication leases must outlast one event-loop and persistence turn.
const MIN_PUBLICATION_LEASE_MS = 100;

export interface SlackEndpoint extends SdkSessionEndpoint {
	generation: number;
}

export interface SlackSdkClient {
	send(frame: Record<string, unknown>): void;
}

export interface SlackNotificationDaemonOptions {
	agentDir: string;
	repo: string;
	teamId: string;
	channelId: string;
	provider: SlackProvider;
	botUserId?: string;
	/** Fail-closed authorization for the paired Slack principal. */
	authorizeActor?: (actorId: string) => boolean | Promise<boolean>;
	store?: ConversationStore<SlackConversation>;
	now?: () => number;
	randomId?: () => string;
	/** Stable identity for the process attempting durable provider publication. */
	publicationOwnerId?: string;
	publicationLeaseMs?: number;

	resolveEndpoint?: (sessionId: string) => Promise<SlackEndpoint | null>;
	createClient: (endpoint: SlackEndpoint) => SlackSdkClient;
	onCommand?: (
		sessionId: string,
		content: string,
		endpoint: SlackEndpoint,
		idempotencyKey: string,
	) => Promise<boolean>;
}

type SlackEvent = {
	type?: unknown;
	channel?: unknown;
	ts?: unknown;
	thread_ts?: unknown;
	user?: unknown;
	bot_id?: unknown;
	subtype?: unknown;
	text?: unknown;
	client_msg_id?: unknown;
};

type EventsPayload = {
	type?: unknown;
	event_id?: unknown;
	team_id?: unknown;
	event_context?: unknown;
	event?: SlackEvent;
};
type SlackInboundRouting = {
	teamId: string;
	channelId: string;
	rootTs: string;
	actorId: string;
	eventId: string;
	interactionId: string;
	retryKey: string;
	eventContext?: string;
	kind: "action" | "command";
	actionId?: string;
};

type SlackInboundEffectPayload =
	| { type: "reply"; id: string; answer: string; idempotencyKey: string; routing: SlackInboundRouting }
	| { type: "command"; content: string; idempotencyKey: string; routing: SlackInboundRouting };

type SlackRootPublication = {
	conversation: SlackConversation;
	created: boolean;
};

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageFromEnvelope(
	payload: unknown,
):
	| { eventId: string; eventContext?: string; teamId: string; channelId: string; rootTs: string; event: SlackEvent }
	| undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const eventPayload = payload as EventsPayload;
	if (eventPayload.type !== "events_api" || !eventPayload.event || eventPayload.event.type !== "message")
		return undefined;
	const eventId = text(eventPayload.event_id);
	const teamId = text(eventPayload.team_id);
	const channelId = text(eventPayload.event.channel);
	const ts = text(eventPayload.event.ts);
	const rootTs = text(eventPayload.event.thread_ts) ?? ts;
	if (!eventId || !teamId || !channelId || !rootTs) return undefined;
	return {
		eventId,
		eventContext: text(eventPayload.event_context),
		teamId,
		channelId,
		rootTs,
		event: eventPayload.event,
	};
}

function nextRecord(record: SlackConversation, update: Partial<SlackConversation>): SlackConversation {
	return normalizeSlackConversation({ ...record, ...update, generation: record.generation + 1 });
}

/**
 * Slack Socket Mode notification daemon. Accepted inbound SDK effects are
 * persisted before acknowledgement, including their replay payload and captured
 * endpoint generation; endpoint credentials and Socket Mode cursors are never
 * written to disk.
 */

export class SlackNotificationDaemon {
	readonly store: ConversationStore<SlackConversation>;
	readonly #now: () => number;
	readonly #randomId: () => string;
	readonly #resolveEndpoint: (sessionId: string) => Promise<SlackEndpoint | null>;
	readonly #publicationOwnerId: string;
	readonly #publicationLeaseMs: number;
	readonly #journal: ChatEffectJournal;

	readonly #inflightInbound = new Set<string>();
	readonly #activeWork = new Set<Promise<unknown>>();
	readonly #rollovers = new Map<string, Promise<SlackRootPublication>>();
	#lifecycleTail: Promise<void> = Promise.resolve();
	#lifecycleGeneration = 0;
	#startedGeneration: number | undefined;
	#startOperation: Promise<void> | undefined;
	#startOperationGeneration: number | undefined;
	#stopOperation: Promise<void> | undefined;
	#started = false;
	#providerStarting = false;
	#providerRunning = false;
	#providerStopRequestedGeneration: number | undefined;
	#leaseRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
	#leaseRecoveryAt: number | undefined;
	#leaseRecoveryFailures = 0;
	#leaseRecoveryTimerGeneration = 0;
	#leaseRecoveryScheduling: Promise<void> = Promise.resolve();
	#recoveringLeasedEffects = false;

	constructor(private readonly options: SlackNotificationDaemonOptions) {
		this.store =
			options.store ?? new ConversationStore<SlackConversation>({ agentDir: options.agentDir, kind: "slack" });
		this.#now = options.now ?? Date.now;
		this.#randomId = options.randomId ?? randomUUID;
		this.#publicationOwnerId = options.publicationOwnerId ?? randomUUID();
		this.#publicationLeaseMs = Math.max(options.publicationLeaseMs ?? 30_000, MIN_PUBLICATION_LEASE_MS);
		this.#journal = new ChatEffectJournal({ agentDir: options.agentDir, transport: "slack", now: this.#now });
		this.#resolveEndpoint =
			options.resolveEndpoint ??
			(async sessionId => {
				const endpoint = await readSdkSessionEndpoint(options.repo, sessionId);
				return endpoint ? { ...endpoint, generation: 1 } : null;
			});
	}

	async start(): Promise<void> {
		const lifecycleGeneration = this.#lifecycleGeneration;
		if (this.#started && this.#startedGeneration === lifecycleGeneration) return;
		if (this.#startOperation && this.#startOperationGeneration === lifecycleGeneration)
			return await this.#startOperation;
		const operation = this.#enqueueLifecycle(async () => {
			if (lifecycleGeneration !== this.#lifecycleGeneration || this.#started) return;
			this.#started = true;
			this.#startedGeneration = lifecycleGeneration;
			try {
				// Recovery is a barrier: Socket Mode must not ACK an envelope before the
				// mapping authority represented by durable effects has been restored.
				await this.#reconcileTerminalProviderReceipts();
				await this.#reconcileTerminalInboundReceipts();
				const providerRecoveryFailed = await this.#drainProviderEffects();
				await this.#drainPendingDispatches();
				await this.#scheduleLeaseRecovery(providerRecoveryFailed);
				// stop() invalidates this generation synchronously before it joins the
				// lifecycle queue, so no stale recovery can open Socket Mode.
				if (
					lifecycleGeneration !== this.#lifecycleGeneration ||
					!this.#started ||
					this.#startedGeneration !== lifecycleGeneration
				) {
					this.#started = false;
					this.#startedGeneration = undefined;
					this.#clearLeaseRecoveryTimer();
					return;
				}
				this.#providerStarting = true;
				try {
					await this.options.provider.start(async envelope => {
						await this.#track(this.handleEnvelope(envelope));
					});
					this.#providerRunning = true;
				} finally {
					this.#providerStarting = false;
				}
				if (lifecycleGeneration !== this.#lifecycleGeneration || this.#startedGeneration !== lifecycleGeneration) {
					this.#started = false;
					this.#startedGeneration = undefined;
					this.#providerRunning = false;
					this.#clearLeaseRecoveryTimer();
					if (this.#providerStopRequestedGeneration !== lifecycleGeneration) await this.options.provider.stop();
				}
			} catch (error) {
				if (this.#startedGeneration === lifecycleGeneration) {
					this.#started = false;
					this.#startedGeneration = undefined;
					this.#clearLeaseRecoveryTimer();
				}
				throw error;
			}
		});
		this.#startOperation = operation;
		this.#startOperationGeneration = lifecycleGeneration;
		try {
			await operation;
		} finally {
			if (this.#startOperation === operation) {
				this.#startOperation = undefined;
				this.#startOperationGeneration = undefined;
			}
		}
	}

	async stop(): Promise<void> {
		if (this.#stopOperation) return await this.#stopOperation;
		const lifecycleGeneration = this.#lifecycleGeneration++;
		const stopProvider = this.#providerStarting || this.#providerRunning;
		this.#started = false;
		this.#startedGeneration = undefined;
		this.#providerRunning = false;
		this.#clearLeaseRecoveryTimer();
		if (stopProvider) this.#providerStopRequestedGeneration = lifecycleGeneration;
		const providerStop = stopProvider ? this.options.provider.stop() : undefined;
		const operation = this.#enqueueLifecycle(async () => {
			// Calling provider.stop() before joining the lifecycle queue lets a provider
			// cancel an open that resolves only after its socket is stopped.
			if (providerStop) await providerStop;
			// Drain until quiescent: a tracked task can schedule further tracked work
			// (recovery/reconciliation) while we await, and any that outlives stop() would
			// bleed timing pressure into the next daemon/test. #started is already false,
			// so no new lease-recovery timers can be armed and the loop terminates.
			while (this.#activeWork.size > 0) await Promise.all([...this.#activeWork]);
		});
		this.#stopOperation = operation;
		try {
			await operation;
		} finally {
			if (this.#stopOperation === operation) this.#stopOperation = undefined;
		}
	}

	/** Accepted inbound effects are durably claimed before their Socket Mode ACK. */
	async handleEnvelope(envelope: SlackSocketEnvelope): Promise<boolean> {
		if (!text(envelope.envelope_id)) return false;
		const inbound = messageFromEnvelope(envelope.payload);
		if (!inbound || inbound.teamId !== this.options.teamId || inbound.channelId !== this.options.channelId) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		const actorId = text(inbound.event.user);
		if (
			inbound.event.bot_id ||
			inbound.event.subtype === "bot_message" ||
			actorId === this.options.botUserId ||
			!actorId ||
			!(await this.#actorAuthorized(actorId))
		) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		const claim = await this.#claimInbound(inbound, actorId);
		if (!claim) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		const inflightKey = `${claim.key}\u0000${claim.receipt.key}`;
		if (this.#inflightInbound.has(inflightKey)) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		this.#inflightInbound.add(inflightKey);
		try {
			await this.options.provider.ack(envelope.envelope_id);
			return await this.#dispatchInbound(claim);
		} finally {
			this.#inflightInbound.delete(inflightKey);
			await this.#scheduleLeaseRecovery();
		}
	}

	#track<T>(work: Promise<T>): Promise<T> {
		this.#activeWork.add(work);
		return work.finally(() => this.#activeWork.delete(work));
	}

	#enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const scheduled = this.#lifecycleTail.then(operation, operation);
		this.#lifecycleTail = scheduled.then(
			() => undefined,
			() => undefined,
		);
		return scheduled;
	}

	async postRoot(sessionId: string, body: string, endpointGeneration?: number): Promise<SlackConversation> {
		return (await this.#postRoot(sessionId, body, endpointGeneration)).conversation;
	}

	async #postRoot(sessionId: string, body: string, endpointGeneration?: number): Promise<SlackRootPublication> {
		const endpoint = await this.#resolveEndpoint(sessionId);
		if (!endpoint || (endpointGeneration !== undefined && endpoint.generation !== endpointGeneration))
			throw new SlackEndpointBindingError("Slack root publication requires the current session endpoint.");
		const generation = endpoint.generation;
		const pendingKey = this.#intentKey(sessionId);
		let claimed = false;
		const pending = await this.store.transact(pendingKey, current => {
			if (current?.state === "active") return current;
			const now = this.#now();
			if (
				current?.rootPublicationOwner !== undefined &&
				current.rootPublicationOwner !== this.#publicationOwnerId &&
				!this.#leaseExpired(current.rootPublicationLeaseExpiresAt, now)
			)
				return current;
			if (current?.state === "posting_root") {
				if (current.rootPublicationOwner === this.#publicationOwnerId) return current;
				claimed = true;
				return nextRecord(current, {
					rootPublicationOwner: this.#publicationOwnerId,
					rootPublicationLeaseExpiresAt: now + this.#publicationLeaseMs,
					rootPublicationFence: (current.rootPublicationFence ?? 0) + 1,
					updatedAt: now,
				});
			}
			claimed = true;
			return {
				generation: (current?.generation ?? 0) + 1,
				state: "posting_root",
				teamId: this.options.teamId,
				channelId: this.options.channelId,
				sessionId,
				clientMsgId: this.#randomId(),
				rootPublicationOwner: this.#publicationOwnerId,
				rootPublicationLeaseExpiresAt: now + this.#publicationLeaseMs,
				rootPublicationFence: (current?.rootPublicationFence ?? 0) + 1,
				endpointGeneration: generation,
				updatedAt: now,
				seenEventIds: current?.seenEventIds ?? [],
				seenContextIds: current?.seenContextIds ?? [],
				seenRetryKeys: current?.seenRetryKeys ?? [],
				seenInteractionIds: current?.seenInteractionIds ?? [],
				inboundDispatches: current?.inboundDispatches ?? [],
			};
		});
		if (!pending?.clientMsgId) throw new Error("Unable to persist Slack root post intent");
		if (pending.state === "active") {
			if (pending.endpointGeneration !== generation) throw new SlackEndpointBindingError();
			return { conversation: pending, created: false };
		}
		if (!claimed)
			return { conversation: await this.#waitForRoot(pendingKey, sessionId, body, generation), created: false };
		if (pending.endpointGeneration !== generation) throw new SlackEndpointBindingError();
		const clientMsgId = pending.clientMsgId;
		const fence = pending.rootPublicationFence;
		if (fence === undefined) throw new Error("Unable to fence Slack root post intent");
		let posted: SlackPostedMessage | null = null;
		let createdRootEffect = false;
		try {
			await this.#withRootLease(pendingKey, clientMsgId, fence, async () => {
				const effectId = `root:${sessionId}:${clientMsgId}`;
				const durable = await this.#providerEffectPayload(effectId, sessionId, generation, {
					channel: this.options.channelId,
					text: body,
					clientMsgId,
				});
				createdRootEffect = !durable.existed;
				posted = await this.#postDurable(effectId, sessionId, generation, durable.payload);
			});
		} catch (error) {
			if (this.#isUncertainPostFailure(error)) {
				// The journal retains the stable root effect for fenced reconciliation.
			}
			if (!posted) {
				if (!this.#isUncertainPostFailure(error)) {
					await this.store.transact(pendingKey, current =>
						current?.clientMsgId === clientMsgId &&
						current.rootPublicationOwner === this.#publicationOwnerId &&
						current.rootPublicationFence === fence
							? nextRecord(current, {
									state: "error",
									rootPublicationOwner: undefined,
									rootPublicationLeaseExpiresAt: undefined,
									updatedAt: this.#now(),
									lastError: "provider_failure",
								})
							: current,
					);
				}
				throw error;
			}
		}
		if (!posted) throw new Error("Slack root post was not confirmed");
		const confirmedPosted = posted as SlackPostedMessage;
		// A confirmed receipt remains authoritative even if the endpoint rolled after
		// dispatch; resume performs any required replacement after reconciliation.
		const active = await this.store.transact(pendingKey, current => {
			if (
				!current ||
				current.clientMsgId !== clientMsgId ||
				current.rootPublicationOwner !== this.#publicationOwnerId ||
				current.rootPublicationFence !== fence
			)
				return current;
			return nextRecord(current, {
				state: "active",
				rootTs: confirmedPosted.ts,
				endpointGeneration: generation,
				updatedAt: this.#now(),
				lastError: undefined,
				rootPublicationOwner: undefined,
				rootPublicationLeaseExpiresAt: undefined,
			});
		});
		if (!active) throw new Error("Slack root mapping disappeared");
		if (active.state !== "active")
			return { conversation: await this.#waitForRoot(pendingKey, sessionId, body, generation), created: false };
		return { conversation: active, created: createdRootEffect };
	}

	/** Deliver a notification into the mapped root thread, creating that root once. */
	async notify(
		sessionId: string,
		body: string,
		actionId?: string,
		endpointGeneration?: number,
	): Promise<SlackConversation> {
		const endpoint = await this.#resolveEndpoint(sessionId);
		if (!endpoint || (endpointGeneration !== undefined && endpoint.generation !== endpointGeneration))
			throw new SlackEndpointBindingError("Slack notification requires the current session endpoint.");
		const generation = endpoint.generation;
		const existing = await this.findSession(sessionId, false);
		const usedExistingRoot =
			existing?.record.state === "active" &&
			!!existing.record.rootTs &&
			existing.record.endpointGeneration === generation;
		let conversation: SlackConversation;
		let bodyWasUsedAsRoot = false;
		if (usedExistingRoot) {
			conversation = existing.record;
		} else {
			const publication =
				existing?.record.state === "active"
					? await this.#resumeWithRootPublication(sessionId, body, generation)
					: await this.#postRoot(sessionId, body, generation);
			conversation = publication.conversation;
			bodyWasUsedAsRoot = publication.created;
		}
		if (!conversation.rootTs) return conversation;
		const key = this.#intentKey(sessionId);
		const conversationGeneration = this.#requireEndpointGeneration(conversation);
		if (conversationGeneration !== generation) throw new SlackEndpointBindingError();
		if (bodyWasUsedAsRoot) {
			if (!actionId) return conversation;
			const active = await this.store.transact(key, current =>
				current && acceptsSlackInbound(current, conversation.rootTs!, conversationGeneration)
					? nextRecord(current, { pendingActionId: actionId, updatedAt: this.#now() })
					: current,
			);
			if (!active) throw new Error("Slack root disappeared while activating action authority");
			return active;
		}
		if (!actionId) {
			await this.#postDurable(`notification:${sessionId}:${this.#randomId()}`, sessionId, conversationGeneration, {
				channel: conversation.channelId,
				threadTs: conversation.rootTs,
				text: body,
				clientMsgId: this.#randomId(),
			});
			return conversation;
		}
		let actionClaimed = false;
		const intent = await this.store.transact(key, current => {
			if (!current || !acceptsSlackInbound(current, conversation.rootTs!, conversationGeneration)) return current;
			const now = this.#now();
			if (current.outboundActionId && current.outboundActionId !== actionId) return current;
			if (current.outboundActionId === actionId) {
				if (
					current.outboundActionOwner === this.#publicationOwnerId ||
					!this.#leaseExpired(current.outboundActionLeaseExpiresAt, now)
				)
					return current;
				actionClaimed = true;
				return nextRecord(current, {
					outboundActionOwner: this.#publicationOwnerId,
					outboundActionLeaseExpiresAt: now + this.#publicationLeaseMs,
					outboundActionFence: (current.outboundActionFence ?? 0) + 1,
					updatedAt: now,
				});
			}
			actionClaimed = true;
			return nextRecord(current, {
				outboundActionId: actionId,
				outboundActionClientMsgId: this.#randomId(),
				outboundActionOwner: this.#publicationOwnerId,
				outboundActionLeaseExpiresAt: now + this.#publicationLeaseMs,
				outboundActionFence: (current.outboundActionFence ?? 0) + 1,
				updatedAt: now,
			});
		});
		if (!intent || intent.outboundActionId !== actionId || !intent.outboundActionClientMsgId) {
			throw new Error("Another Slack action publication is pending");
		}
		if (!actionClaimed) return await this.#waitForAction(key, sessionId, body, actionId);
		const clientMsgId = intent.outboundActionClientMsgId;
		const fence = intent.outboundActionFence;
		if (fence === undefined) throw new Error("Unable to fence Slack action post intent");
		let published: SlackPostedMessage | null = null;
		try {
			await this.#withActionLease(key, clientMsgId, fence, async () => {
				const effectId = `action:${sessionId}:${actionId}:${clientMsgId}`;
				const durable = await this.#providerEffectPayload(effectId, sessionId, conversationGeneration, {
					channel: conversation.channelId,
					threadTs: conversation.rootTs,
					text: body,
					clientMsgId,
				});
				published = await this.#postDurable(effectId, sessionId, conversationGeneration, durable.payload);
			});
		} catch (error) {
			if (this.#isUncertainPostFailure(error)) {
				// The journal retains the stable action effect for fenced reconciliation.
			}
			if (!published) {
				if (!this.#isUncertainPostFailure(error)) {
					await this.store.transact(key, current =>
						current?.outboundActionClientMsgId === clientMsgId &&
						current.outboundActionOwner === this.#publicationOwnerId &&
						current.outboundActionFence === fence
							? nextRecord(current, {
									outboundActionId: undefined,
									outboundActionClientMsgId: undefined,
									outboundActionOwner: undefined,
									outboundActionLeaseExpiresAt: undefined,
									updatedAt: this.#now(),
								})
							: current,
					);
				}
				throw error;
			}
		}
		const active = await this.store.transact(key, current =>
			current?.outboundActionClientMsgId === clientMsgId &&
			current.outboundActionOwner === this.#publicationOwnerId &&
			current.outboundActionFence === fence
				? nextRecord(current, {
						pendingActionId: actionId,
						outboundActionId: undefined,
						outboundActionClientMsgId: undefined,
						outboundActionOwner: undefined,
						outboundActionLeaseExpiresAt: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
		if (!active) throw new Error("Slack conversation disappeared while activating action authority");
		return active;
	}

	/** Posts a safe command outcome to the active mapped root thread. */
	async postCommandResult(sessionId: string, content: string): Promise<boolean> {
		const found = await this.findSession(sessionId, false);
		if (found?.record.state !== "active" || !found.record.rootTs) return false;
		const generation = this.#requireEndpointGeneration(found.record);
		await this.#postDurable(`command-result:${sessionId}:${this.#randomId()}`, sessionId, generation, {
			channel: found.record.channelId,
			threadTs: found.record.rootTs,
			text: content,
			clientMsgId: this.#randomId(),
		});
		return true;
	}

	async resolveAction(sessionId: string, actionId: string): Promise<void> {
		const found = await this.findSession(sessionId, true);
		if (!found) return;
		await this.store.transact(found.key, current =>
			current?.pendingActionId === actionId
				? nextRecord(current, { pendingActionId: undefined, updatedAt: this.#now() })
				: current,
		);
	}

	async close(sessionId: string, marker = "Session closed."): Promise<boolean> {
		const found = await this.findSession(sessionId, true);
		if (!found?.record.rootTs || found.record.state !== "active") return false;
		const effectId = `close-marker:${sessionId}:${found.record.clientMsgId ?? found.record.rootTs}`;
		const existing = await this.#journal.read<{
			channel: string;
			text: string;
			threadTs?: string;
			clientMsgId: string;
		}>(effectId);
		const durable = await this.#providerEffectPayload(
			effectId,
			sessionId,
			this.#requireEndpointGeneration(found.record),
			{
				channel: found.record.channelId,
				threadTs: found.record.rootTs,
				text: marker,
				clientMsgId: existing?.payload.clientMsgId ?? this.#randomId(),
			},
		);
		await this.#postDurable(effectId, sessionId, this.#requireEndpointGeneration(found.record), durable.payload);
		await this.store.transact(found.key, current =>
			current
				? nextRecord(current, { state: "closed_marker", pendingActionId: undefined, updatedAt: this.#now() })
				: current,
		);

		return true;
	}

	async resume(sessionId: string, body: string, endpointGeneration?: number): Promise<SlackConversation> {
		return (await this.#resumeWithRootPublication(sessionId, body, endpointGeneration)).conversation;
	}

	async #resumeWithRootPublication(
		sessionId: string,
		body: string,
		endpointGeneration?: number,
	): Promise<SlackRootPublication> {
		const inFlight = this.#rollovers.get(sessionId);
		if (inFlight) {
			const publication = await inFlight;
			const activeGeneration = this.#requireEndpointGeneration(publication.conversation);
			if (endpointGeneration === undefined || endpointGeneration === activeGeneration)
				return { conversation: publication.conversation, created: false };
			if (endpointGeneration < activeGeneration)
				throw new SlackEndpointBindingError("Slack root belongs to a newer endpoint generation.");
			return await this.#resumeWithRootPublication(sessionId, body, endpointGeneration);
		}
		const rollover = this.#resumeRoot(sessionId, body, endpointGeneration);
		this.#rollovers.set(sessionId, rollover);
		try {
			return await rollover;
		} finally {
			if (this.#rollovers.get(sessionId) === rollover) this.#rollovers.delete(sessionId);
		}
	}

	async #resumeRoot(sessionId: string, body: string, endpointGeneration?: number): Promise<SlackRootPublication> {
		const endpoint = await this.#resolveEndpoint(sessionId);
		if (!endpoint || (endpointGeneration !== undefined && endpoint.generation !== endpointGeneration))
			throw new SlackEndpointBindingError("Slack root rollover requires the current session endpoint.");
		const generation = endpoint.generation;
		const forced = endpointGeneration === undefined;
		let waitedForRollover = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			let previous = await this.findSession(sessionId, true);
			while (previous?.record.state === "posting_root") {
				const reconciled = await this.#waitForRootReconciliation(previous.key, previous.record);
				if (!reconciled) throw new Error("Slack root mapping disappeared during reconciliation.");
				previous = { key: previous.key, record: reconciled };
				waitedForRollover = true;
			}
			if (!previous) return await this.#postRoot(sessionId, body, generation);
			if (previous.record.state !== "active") {
				if (
					previous.record.rootPublicationOwner !== this.#publicationOwnerId &&
					!this.#leaseExpired(previous.record.rootPublicationLeaseExpiresAt, this.#now())
				) {
					waitedForRollover = true;
					await Bun.sleep(10);
					continue;
				}
				return await this.#postRoot(sessionId, body, generation);
			}
			const previousGeneration = this.#requireEndpointGeneration(previous.record);
			if (previousGeneration > generation)
				throw new SlackEndpointBindingError("Slack root belongs to a newer endpoint generation.");
			if (previousGeneration === generation && (!forced || waitedForRollover))
				return { conversation: previous.record, created: false };

			let claimed = false;
			let fence: number | undefined;
			const locked = await this.store.transact(previous.key, current => {
				if (
					current?.state !== "active" ||
					current.rootTs !== previous!.record.rootTs ||
					current.endpointGeneration !== previousGeneration
				)
					return current;
				const now = this.#now();
				if (
					current.rootPublicationOwner === this.#publicationOwnerId ||
					!this.#leaseExpired(current.rootPublicationLeaseExpiresAt, now)
				)
					return current;
				claimed = true;
				fence = (current.rootPublicationFence ?? 0) + 1;
				return nextRecord(current, {
					rootPublicationOwner: this.#publicationOwnerId,
					rootPublicationLeaseExpiresAt: now + this.#publicationLeaseMs,
					rootPublicationFence: fence,
					updatedAt: now,
				});
			});
			if (!locked) throw new Error("Slack root mapping disappeared during rollover.");
			if (!claimed || fence === undefined) {
				waitedForRollover = true;
				await Bun.sleep(10);
				continue;
			}
			let closed = false;
			try {
				closed = await this.close(sessionId);
			} catch (error) {
				if (!(error instanceof SlackStaleEffectError)) throw error;
				// The old-generation close marker was deliberately suppressed after
				// reconciliation; this fenced rollover still owns the state transition.
				closed = true;
			}
			const resumed = await this.store.transact(previous.key, current =>
				closed &&
				current &&
				(current.state === "closed_marker" || current.state === "active") &&
				current.rootPublicationOwner === this.#publicationOwnerId &&
				current.rootPublicationFence === fence
					? nextRecord(current, { state: "resumed_root", pendingActionId: undefined, updatedAt: this.#now() })
					: current,
			);
			if (
				resumed?.state === "resumed_root" &&
				resumed.rootPublicationOwner === this.#publicationOwnerId &&
				resumed.rootPublicationFence === fence
			)
				return await this.#postRoot(sessionId, body, generation);
			waitedForRollover = true;
			await Bun.sleep(10);
		}
		throw new Error("Slack root rollover is still pending");
	}

	async #claimInbound(
		inbound: {
			eventId: string;
			eventContext?: string;
			teamId: string;
			channelId: string;
			rootTs: string;
			event: SlackEvent;
		},
		actorId: string,
	): Promise<
		{ key: string; endpoint: SlackEndpoint; sessionId: string; receipt: SlackInboundDispatchReceipt } | undefined
	> {
		const document = await this.store.load();
		const matched = Object.entries(document.conversations)
			.map(([mappingKey, candidate]) => ({ mappingKey, candidate }))
			.filter(
				({ candidate }) =>
					candidate.teamId === inbound.teamId &&
					candidate.channelId === inbound.channelId &&
					candidate.rootTs === inbound.rootTs,
			)
			.sort(
				(left, right) =>
					(right.candidate.endpointGeneration ?? -1) - (left.candidate.endpointGeneration ?? -1) ||
					right.candidate.generation - left.candidate.generation ||
					right.candidate.updatedAt - left.candidate.updatedAt,
			)[0];
		if (!matched) return undefined;
		const { mappingKey: key, candidate: record } = matched;
		if (
			!record.sessionId ||
			!record.endpointGeneration ||
			!acceptsSlackInbound(record, inbound.rootTs, record.endpointGeneration)
		)
			return undefined;
		const endpoint = await this.#resolveEndpoint(record.sessionId);
		if (!endpoint || endpoint.generation !== record.endpointGeneration) return undefined;
		const interactionId = text(inbound.event.client_msg_id) ?? inbound.eventId;
		const retryKey = `${inbound.eventId}:${interactionId}`;
		const inboundText = text(inbound.event.text);
		const command = inboundText?.startsWith("/sdk ") ?? false;

		const idempotencyKey = `slack:${inbound.teamId}:${inbound.channelId}:${inbound.rootTs}:${actorId}:${inbound.eventId}:${interactionId}`;
		const effectId = `inbound:${inbound.teamId}:${inbound.channelId}:${inbound.rootTs}:${actorId}:${inbound.eventId}:${interactionId}`;
		const routing: SlackInboundRouting = {
			teamId: inbound.teamId,
			channelId: inbound.channelId,
			rootTs: inbound.rootTs,
			eventId: inbound.eventId,
			interactionId,
			actorId,
			retryKey,
			eventContext: inbound.eventContext,
			kind: command ? "command" : "action",
			...(command ? {} : record.pendingActionId ? { actionId: record.pendingActionId } : {}),
		};
		const initialPayload: SlackInboundEffectPayload | undefined = command
			? { type: "command", content: inboundText!, idempotencyKey, routing }
			: record.pendingActionId
				? { type: "reply", id: record.pendingActionId, answer: inboundText ?? "", idempotencyKey, routing }
				: undefined;
		const existingEffect = await this.#journal.read<SlackInboundEffectPayload>(effectId);
		const payload = existingEffect?.payload ?? initialPayload;
		if (!payload) return undefined;
		await this.#rescheduleAfterEffectTransition(
			this.#journal.enqueue({
				id: effectId,
				kind: command ? "sdk.inbound.command" : "sdk.inbound.reply",
				transport: "slack",
				sessionId: record.sessionId,
				endpointGeneration: endpoint.generation,
				payload,
			}),
		);
		let sessionId: string | undefined;
		let receipt: SlackInboundDispatchReceipt | undefined;
		await this.store.transact(key, current => {
			if (!current?.sessionId || !acceptsSlackInbound(current, inbound.rootTs, endpoint.generation)) return current;
			const existing = (current.inboundDispatches ?? []).find(
				candidate =>
					candidate.eventId === inbound.eventId ||
					candidate.interactionId === interactionId ||
					candidate.retryKey === retryKey ||
					(inbound.eventContext !== undefined && candidate.eventContext === inbound.eventContext),
			);
			if (existing) {
				sessionId = current.sessionId;
				receipt = existing;
				return current;
			}
			if (
				current.seenEventIds.includes(inbound.eventId) ||
				current.seenInteractionIds.includes(interactionId) ||
				current.seenRetryKeys.includes(retryKey) ||
				(inbound.eventContext !== undefined && current.seenContextIds.includes(inbound.eventContext)) ||
				(!command && !current.pendingActionId)
			)
				return current;
			sessionId = current.sessionId;
			receipt = {
				key: `${inbound.eventId}:${interactionId}`,
				eventId: inbound.eventId,
				interactionId,
				retryKey,
				eventContext: inbound.eventContext,
				kind: command ? "command" : "action",
				...(command ? {} : { actionId: current.pendingActionId }),
				endpointGeneration: endpoint.generation,
				effectId,
				idempotencyKey,
			};
			return nextRecord(current, {
				inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
				updatedAt: this.#now(),
			});
		});
		return sessionId && receipt ? { key, endpoint, sessionId, receipt } : undefined;
	}

	async #dispatchInbound(claim: {
		key: string;
		endpoint: SlackEndpoint;
		sessionId: string;
		receipt: SlackInboundDispatchReceipt;
	}): Promise<boolean> {
		const current = await this.store.read(claim.key);
		const effect = await this.#journal.read<SlackInboundEffectPayload>(claim.receipt.effectId);
		if (effect?.state === "terminal") {
			await this.#finalizeTerminalInboundDispatch(claim.key, claim.receipt);
			return false;
		}
		if (
			!current ||
			!this.#mappedInboundDispatchable(current, claim.receipt, effect) ||
			claim.receipt.endpointGeneration !== claim.endpoint.generation
		) {
			await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_mapping");
			return false;
		}
		return await this.#dispatchEffect(claim, claim.receipt.effectId);
	}

	async #dispatchEffect(
		claim: { key: string; endpoint: SlackEndpoint; sessionId: string; receipt: SlackInboundDispatchReceipt },
		effectId: string,
	): Promise<boolean> {
		const effect = await this.#rescheduleAfterEffectTransition(
			this.#journal.claim<SlackInboundEffectPayload>(
				effectId,
				this.#publicationOwnerId,
				Math.max(this.#publicationLeaseMs, 100),
			),
		);
		if (!effect) return false;
		if (!this.#matchesInboundEffect(effect, claim.receipt)) {
			await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_mapping");
			return false;
		}
		const lease: ChatEffectLease = { owner: this.#publicationOwnerId, epoch: effect.epoch };
		try {
			if (effect.payload.type === "command") {
				const payload = effect.payload;
				const accepted = await this.#withEffectLease(effect.id, lease, async () => {
					if (!(await this.#inboundEffectCurrent(claim, effect.id))) throw new SlackStaleEffectError();
					return await (this.options.onCommand?.(
						claim.sessionId,
						payload.content,
						claim.endpoint,
						payload.idempotencyKey,
					) ?? Promise.resolve(false));
				});
				if (!(await this.#inboundEffectCurrent(claim, effect.id))) {
					await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_binding");
					return false;
				}
				const recorded = await this.#journal.record(effect.id, lease, "terminal", {
					status: accepted ? "accepted" : "rejected",
				});
				if (recorded) await this.#finishDispatch(claim, "terminal");
				return accepted && !!recorded;
			}
			await this.#withEffectLease(effect.id, lease, async () => {
				if (!(await this.#inboundEffectCurrent(claim, effect.id))) throw new SlackStaleEffectError();
				this.options.createClient(claim.endpoint).send(effect.payload);
			});
			if (!(await this.#inboundEffectCurrent(claim, effect.id))) {
				await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_binding");
				return false;
			}
			const recorded = await this.#journal.record(effect.id, lease, "terminal", { status: "sent" });
			if (recorded) await this.#finishDispatch(claim, "terminal");
			return !!recorded;
		} catch (error) {
			if (error instanceof SlackStaleEffectError) {
				await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_binding");
				return false;
			}
			const state = this.#isDefiniteSdkPreSendFailure(error) ? "accepted" : "uncertain";

			const recorded = await this.#rescheduleAfterEffectTransition(
				this.#journal.record(effect.id, lease, state, { status: state }),
			);
			if (recorded && state === "accepted") await this.#releaseDispatch(claim);
			else if (recorded) await this.#finishDispatch(claim, "uncertain");
			return false;
		}
	}

	async #inboundEffectCurrent(
		claim: { key: string; endpoint: SlackEndpoint; sessionId: string; receipt: SlackInboundDispatchReceipt },
		effectId: string,
	): Promise<boolean> {
		const endpoint = await this.#resolveEndpoint(claim.sessionId);
		if (!endpoint || endpoint.generation !== claim.endpoint.generation) return false;
		const [current, effect] = await Promise.all([
			this.store.read(claim.key),
			this.#journal.read<SlackInboundEffectPayload>(effectId),
		]);
		return (
			!!current &&
			!!effect &&
			current.sessionId === claim.sessionId &&
			acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation) &&
			claim.receipt.endpointGeneration === claim.endpoint.generation &&
			this.#matchesInboundEffect(effect, claim.receipt) &&
			(await this.#actorAuthorized(effect.payload.routing.actorId)) &&
			(current.inboundDispatches ?? []).some(receipt => this.#sameInboundReceipt(receipt, claim.receipt))
		);
	}

	async #withEffectLease<T>(id: string, lease: ChatEffectLease, operation: () => Promise<T>): Promise<T> {
		// The effect was just claimed, so its lease is current. The periodic renewal
		// still protects the external operation without another durable write first.
		return await this.#withRenewal(
			operation,
			async () => {
				if (
					!(await this.#rescheduleAfterEffectTransition(
						this.#journal.renew(id, lease, Math.max(this.#publicationLeaseMs, 100)),
					))
				)
					throw new Error("Slack effect lease renewal failed");
			},
			false,
		);
	}

	async #drainPendingDispatches(): Promise<void> {
		await this.#reconcileTerminalInboundReceipts();
		const document = await this.store.load();
		const dispatchableEffectIds = new Set<string>();
		for (const [key, record] of Object.entries(document.conversations)) {
			for (const receipt of record.inboundDispatches ?? []) {
				const effect = await this.#journal.read<SlackInboundEffectPayload>(receipt.effectId);
				if (effect?.state === "terminal") {
					await this.#finalizeTerminalInboundDispatch(key, receipt);
					continue;
				}
				if (!this.#mappedInboundDispatchable(record, receipt, effect)) {
					await this.#terminalizeStaleInboundDispatch(key, receipt, "stale_mapping");
					continue;
				}
				const endpoint = await this.#resolveEndpoint(record.sessionId!);
				if (!endpoint || endpoint.generation !== receipt.endpointGeneration) {
					await this.#terminalizeStaleInboundDispatch(key, receipt, "stale_binding");
					continue;
				}
				if (
					effect.state === "uncertain" ||
					(effect.state === "leased" && (effect.leaseExpiresAt ?? 0) > this.#now())
				)
					continue;
				dispatchableEffectIds.add(receipt.effectId);
				const inflightKey = `${key}\u0000${receipt.key}`;
				if (this.#inflightInbound.has(inflightKey)) continue;
				this.#inflightInbound.add(inflightKey);
				try {
					await this.#dispatchInbound({ key, endpoint, sessionId: record.sessionId!, receipt });
				} finally {
					this.#inflightInbound.delete(inflightKey);
				}
			}
		}
		for (const effect of await this.#journal.list()) {
			if (
				dispatchableEffectIds.has(effect.id) ||
				effect.transport !== "slack" ||
				effect.state === "terminal" ||
				!effect.sessionId ||
				(effect.kind !== "sdk.inbound.command" && effect.kind !== "sdk.inbound.reply")
			)
				continue;
			const adopted = await this.#adoptOrphanInbound(effect as ChatEffect<SlackInboundEffectPayload>);
			if (!adopted) continue;
			const endpoint = await this.#resolveEndpoint(adopted.sessionId);
			if (
				!endpoint ||
				endpoint.generation !== adopted.receipt.endpointGeneration ||
				!(await this.#inboundEffectCurrent(
					{ key: adopted.key, endpoint, sessionId: adopted.sessionId, receipt: adopted.receipt },
					effect.id,
				))
			) {
				await this.#terminalizeStaleInboundDispatch(adopted.key, adopted.receipt, "stale_binding");
				continue;
			}
			if (effect.state === "uncertain" || (effect.state === "leased" && (effect.leaseExpiresAt ?? 0) > this.#now()))
				continue;
			await this.#dispatchInbound({
				key: adopted.key,
				endpoint,
				sessionId: adopted.sessionId,
				receipt: adopted.receipt,
			});
		}
	}

	async #actorAuthorized(actorId: string): Promise<boolean> {
		const authorizeActor = this.options.authorizeActor;
		if (!authorizeActor || !text(actorId)) return false;
		try {
			return await authorizeActor(actorId);
		} catch {
			return false;
		}
	}
	#validInboundRouting(routing: SlackInboundRouting): boolean {
		return (
			routing.teamId === this.options.teamId &&
			routing.channelId === this.options.channelId &&
			text(routing.rootTs) !== undefined &&
			text(routing.actorId) !== undefined &&
			text(routing.eventId) !== undefined &&
			text(routing.interactionId) !== undefined &&
			routing.retryKey === `${routing.eventId}:${routing.interactionId}` &&
			(routing.eventContext === undefined || text(routing.eventContext) !== undefined) &&
			(routing.kind === "command" || (routing.kind === "action" && text(routing.actionId) !== undefined))
		);
	}
	#matchesInboundEffect(effect: ChatEffect<SlackInboundEffectPayload>, receipt: SlackInboundDispatchReceipt): boolean {
		const payload = effect.payload;
		const routing = payload?.routing;
		if (
			!routing ||
			!this.#validInboundRouting(routing) ||
			!effect.sessionId ||
			!Number.isSafeInteger(effect.endpointGeneration) ||
			effect.endpointGeneration <= 0
		)
			return false;
		const effectId = `inbound:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.actorId}:${routing.eventId}:${routing.interactionId}`;
		const idempotencyKey = `slack:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.actorId}:${routing.eventId}:${routing.interactionId}`;
		return (
			effect.id === effectId &&
			payload.idempotencyKey === idempotencyKey &&
			receipt.key === `${routing.eventId}:${routing.interactionId}` &&
			receipt.eventId === routing.eventId &&
			receipt.interactionId === routing.interactionId &&
			receipt.retryKey === routing.retryKey &&
			receipt.eventContext === routing.eventContext &&
			receipt.kind === routing.kind &&
			receipt.actionId === routing.actionId &&
			receipt.endpointGeneration === effect.endpointGeneration &&
			receipt.effectId === effect.id &&
			receipt.idempotencyKey === payload.idempotencyKey &&
			((payload.type === "command" && routing.kind === "command" && effect.kind === "sdk.inbound.command") ||
				(payload.type === "reply" &&
					routing.kind === "action" &&
					effect.kind === "sdk.inbound.reply" &&
					payload.id === routing.actionId))
		);
	}
	#sameInboundReceipt(left: SlackInboundDispatchReceipt, right: SlackInboundDispatchReceipt): boolean {
		return (
			left.key === right.key &&
			left.eventId === right.eventId &&
			left.interactionId === right.interactionId &&
			left.retryKey === right.retryKey &&
			left.eventContext === right.eventContext &&
			left.kind === right.kind &&
			left.actionId === right.actionId &&
			left.endpointGeneration === right.endpointGeneration &&
			left.effectId === right.effectId &&
			left.idempotencyKey === right.idempotencyKey
		);
	}
	#mappedInboundDispatchable(
		record: SlackConversation,
		receipt: SlackInboundDispatchReceipt,
		effect: ChatEffect<SlackInboundEffectPayload> | undefined,
	): effect is ChatEffect<SlackInboundEffectPayload> {
		return (
			!!effect &&
			record.state === "active" &&
			!!record.sessionId &&
			!!record.rootTs &&
			acceptsSlackInbound(record, record.rootTs, receipt.endpointGeneration) &&
			record.sessionId === effect.sessionId &&
			this.#matchesInboundEffect(effect, receipt)
		);
	}
	async #reconcileTerminalInboundReceipts(): Promise<void> {
		for (const effect of await this.#journal.list()) {
			if (
				effect.transport !== "slack" ||
				effect.state !== "terminal" ||
				(effect.kind !== "sdk.inbound.command" && effect.kind !== "sdk.inbound.reply")
			)
				continue;
			const payload = effect.payload as SlackInboundEffectPayload;
			if (!payload?.routing || !this.#validInboundRouting(payload.routing)) continue;
			const key = slackConversationKey({
				teamId: payload.routing.teamId,
				channelId: payload.routing.channelId,
				rootTs: payload.routing.rootTs,
			});
			const current = await this.store.read(key);
			let receipt: SlackInboundDispatchReceipt | undefined;
			if (current && current.sessionId === effect.sessionId) {
				receipt = current.inboundDispatches?.find(candidate =>
					this.#matchesInboundEffect(effect as ChatEffect<SlackInboundEffectPayload>, candidate),
				);
			}
			if (receipt) await this.#finalizeTerminalInboundDispatch(key, receipt);
		}
	}
	async #terminalizeStaleInboundDispatch(
		key: string,
		receipt: SlackInboundDispatchReceipt,
		status: "stale_binding" | "stale_mapping",
	): Promise<void> {
		await this.#journal.terminalize(receipt.effectId, { status });
		await this.#finalizeTerminalInboundDispatch(key, receipt);
	}
	async #finalizeTerminalInboundDispatch(key: string, receipt: SlackInboundDispatchReceipt): Promise<void> {
		await this.store.transact(key, current => {
			const found = current?.inboundDispatches?.find(candidate => this.#sameInboundReceipt(candidate, receipt));
			return !current || !found ? current : this.#completeInboundDispatch(current, found, true);
		});
	}
	#completeInboundDispatch(
		current: SlackConversation,
		receipt: SlackInboundDispatchReceipt,
		terminal: boolean,
	): SlackConversation {
		return nextRecord(current, {
			pendingActionId:
				receipt.kind === "action" && current.pendingActionId === receipt.actionId
					? undefined
					: current.pendingActionId,
			seenEventIds: [...current.seenEventIds, receipt.eventId],
			seenInteractionIds: [...current.seenInteractionIds, receipt.interactionId],
			seenRetryKeys: [...current.seenRetryKeys, receipt.retryKey],
			seenContextIds:
				receipt.eventContext === undefined
					? current.seenContextIds
					: [...current.seenContextIds, receipt.eventContext],
			inboundDispatches: terminal
				? (current.inboundDispatches ?? []).filter(candidate => !this.#sameInboundReceipt(candidate, receipt))
				: current.inboundDispatches,
			updatedAt: this.#now(),
		});
	}
	async #adoptOrphanInbound(
		effect: ChatEffect<SlackInboundEffectPayload>,
	): Promise<{ key: string; sessionId: string; receipt: SlackInboundDispatchReceipt } | undefined> {
		const payload = effect.payload;
		const routing = payload?.routing;
		if (!routing || !this.#validInboundRouting(routing) || !(await this.#actorAuthorized(routing.actorId))) {
			await this.#terminalizeRejectedInbound(effect.id);
			return undefined;
		}
		const matches = Object.entries((await this.store.load()).conversations).filter(
			([, record]) =>
				record.teamId === routing.teamId &&
				record.channelId === routing.channelId &&
				record.rootTs === routing.rootTs,
		);
		if (matches.length !== 1) {
			await this.#terminalizeRejectedInbound(effect.id);
			return undefined;
		}
		const key = matches[0]![0];
		const expectedEffectId = `inbound:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.actorId}:${routing.eventId}:${routing.interactionId}`;
		const expectedIdempotencyKey = `slack:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.actorId}:${routing.eventId}:${routing.interactionId}`;
		const validPayload =
			effect.transport === "slack" &&
			!!effect.sessionId &&
			Number.isSafeInteger(effect.endpointGeneration) &&
			effect.endpointGeneration > 0 &&
			effect.id === expectedEffectId &&
			payload.idempotencyKey === expectedIdempotencyKey &&
			((payload.type === "command" && routing.kind === "command" && effect.kind === "sdk.inbound.command") ||
				(payload.type === "reply" &&
					routing.kind === "action" &&
					effect.kind === "sdk.inbound.reply" &&
					payload.id === routing.actionId));
		let receipt: SlackInboundDispatchReceipt | undefined;
		await this.store.transact(key, current => {
			if (
				!validPayload ||
				!current ||
				!effect.sessionId ||
				current.sessionId !== effect.sessionId ||
				!acceptsSlackInbound(current, routing.rootTs, effect.endpointGeneration)
			)
				return current;
			const existing = (current.inboundDispatches ?? []).find(
				candidate =>
					candidate.eventId === routing.eventId ||
					candidate.interactionId === routing.interactionId ||
					candidate.retryKey === routing.retryKey ||
					(routing.eventContext !== undefined && candidate.eventContext === routing.eventContext),
			);
			if (existing) {
				if (this.#matchesInboundEffect(effect, existing)) receipt = existing;
				return current;
			}
			if (
				current.seenEventIds.includes(routing.eventId) ||
				current.seenInteractionIds.includes(routing.interactionId) ||
				current.seenRetryKeys.includes(routing.retryKey) ||
				(routing.eventContext !== undefined && current.seenContextIds.includes(routing.eventContext)) ||
				(routing.kind === "action" && current.pendingActionId !== routing.actionId)
			)
				return current;
			receipt = {
				key: `${routing.eventId}:${routing.interactionId}`,
				eventId: routing.eventId,
				interactionId: routing.interactionId,
				retryKey: routing.retryKey,
				eventContext: routing.eventContext,
				kind: routing.kind,
				...(routing.kind === "action" ? { actionId: routing.actionId } : {}),
				endpointGeneration: effect.endpointGeneration,
				effectId: effect.id,
				idempotencyKey: payload.idempotencyKey,
			};
			return nextRecord(current, {
				inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
				updatedAt: this.#now(),
			});
		});
		if (receipt && effect.sessionId) return { key, sessionId: effect.sessionId, receipt };
		await this.#terminalizeRejectedInbound(effect.id);
		return undefined;
	}

	async #terminalizeRejectedInbound(effectId: string): Promise<void> {
		await this.#journal.terminalize(effectId, { status: "rejected" });
	}

	async #finishDispatch(
		claim: { key: string; endpoint: SlackEndpoint; receipt: SlackInboundDispatchReceipt },
		state: "terminal" | "uncertain",
	): Promise<void> {
		await this.store.transact(claim.key, current => {
			if (!current || !acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation)) return current;
			const found = (current.inboundDispatches ?? []).find(receipt =>
				this.#sameInboundReceipt(receipt, claim.receipt),
			);
			return found ? this.#completeInboundDispatch(current, found, state === "terminal") : current;
		});
	}

	async #releaseDispatch(claim: {
		key: string;
		endpoint: SlackEndpoint;
		receipt: SlackInboundDispatchReceipt;
	}): Promise<void> {
		await this.store.transact(claim.key, current => {
			if (!current || !acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation)) return current;
			const found = (current.inboundDispatches ?? []).find(receipt =>
				this.#sameInboundReceipt(receipt, claim.receipt),
			);
			return found
				? nextRecord(current, {
						inboundDispatches: (current.inboundDispatches ?? []).filter(
							candidate => !this.#sameInboundReceipt(candidate, found),
						),
						updatedAt: this.#now(),
					})
				: current;
		});
	}

	async #reconcileTerminalProviderReceipts(): Promise<void> {
		for (const effect of await this.#journal.list()) {
			try {
				if (effect.kind !== "provider-post" || effect.transport !== "slack" || effect.state !== "terminal")
					continue;
				const payload = effect.payload as { channel?: unknown; threadTs?: unknown; clientMsgId?: unknown };
				const receipt = effect.receipt;
				if (
					receipt?.provider !== "slack" ||
					typeof payload.clientMsgId !== "string" ||
					(receipt.status !== "posted" && receipt.status !== "not_found") ||
					(receipt.status === "posted" && typeof receipt.timestamp !== "string")
				)
					continue;
				const normalized = {
					channel: payload.channel,
					threadTs: payload.threadTs,
					clientMsgId: payload.clientMsgId,
				};
				if (typeof normalized.threadTs === "string") {
					if (receipt.status === "posted") await this.#activateReconciledAction(effect, normalized);
					else await this.#releaseUnreconciledAction(effect, normalized);
				} else if (receipt.status === "posted") {
					await this.#activateReconciledRoot(effect, normalized, receipt.timestamp!);
				} else {
					await this.#releaseUnreconciledRoot(effect, normalized);
				}
			} catch {
				await this.#recordRecoveryFailure(effect);
			}
		}
	}

	async #activateReconciledRoot(
		effect: ChatEffect,
		payload: { channel?: unknown; clientMsgId: string },
		rootTs: string,
	): Promise<void> {
		if (
			!effect.sessionId ||
			typeof payload.channel !== "string" ||
			payload.channel !== this.options.channelId ||
			!Number.isSafeInteger(effect.endpointGeneration) ||
			effect.endpointGeneration <= 0
		)
			return;
		// Receipt recovery must retain the original mapping through an endpoint roll;
		// inbound routing still fences it against the now-current endpoint generation.
		await this.store.transact(this.#intentKey(effect.sessionId), current =>
			current &&
			current.state === "posting_root" &&
			current.sessionId === effect.sessionId &&
			current.teamId === this.options.teamId &&
			current.channelId === payload.channel &&
			current.clientMsgId === payload.clientMsgId &&
			current.endpointGeneration === effect.endpointGeneration
				? nextRecord(current, {
						state: "active",
						rootTs,
						endpointGeneration: effect.endpointGeneration,
						rootPublicationOwner: undefined,
						rootPublicationLeaseExpiresAt: undefined,
						lastError: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
	}

	async #activateReconciledAction(
		effect: ChatEffect,
		payload: { channel?: unknown; threadTs?: unknown; clientMsgId: string },
	): Promise<void> {
		if (
			!effect.sessionId ||
			typeof payload.channel !== "string" ||
			typeof payload.threadTs !== "string" ||
			!Number.isSafeInteger(effect.endpointGeneration) ||
			effect.endpointGeneration <= 0
		)
			return;
		const threadTs = payload.threadTs;
		const document = await this.store.load();
		const found = Object.entries(document.conversations)
			.map(([key, record]) => ({ key, record }))
			.filter(
				({ record }) =>
					record.state === "active" &&
					record.sessionId === effect.sessionId &&
					record.teamId === this.options.teamId &&
					record.channelId === payload.channel &&
					record.rootTs === threadTs &&
					record.endpointGeneration === effect.endpointGeneration &&
					record.outboundActionClientMsgId === payload.clientMsgId &&
					typeof record.outboundActionId === "string",
			)[0];
		if (!found) return;
		await this.store.transact(found.key, current =>
			current &&
			acceptsSlackInbound(current, threadTs, effect.endpointGeneration) &&
			current.outboundActionClientMsgId === payload.clientMsgId &&
			current.outboundActionId === found.record.outboundActionId
				? nextRecord(current, {
						pendingActionId: current.outboundActionId,
						outboundActionId: undefined,
						outboundActionClientMsgId: undefined,
						outboundActionOwner: undefined,
						outboundActionLeaseExpiresAt: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
	}
	async #releaseUnreconciledRoot(
		effect: ChatEffect,
		payload: { channel?: unknown; clientMsgId: string },
	): Promise<void> {
		if (
			!effect.sessionId ||
			typeof payload.channel !== "string" ||
			payload.channel !== this.options.channelId ||
			!Number.isSafeInteger(effect.endpointGeneration) ||
			effect.endpointGeneration <= 0
		)
			return;
		await this.store.transact(this.#intentKey(effect.sessionId), current =>
			current &&
			current.state === "posting_root" &&
			current.sessionId === effect.sessionId &&
			current.teamId === this.options.teamId &&
			current.channelId === payload.channel &&
			current.clientMsgId === payload.clientMsgId &&
			current.endpointGeneration === effect.endpointGeneration
				? nextRecord(current, {
						state: "error",
						rootPublicationOwner: undefined,
						rootPublicationLeaseExpiresAt: undefined,
						lastError: "provider_not_found",
						updatedAt: this.#now(),
					})
				: current,
		);
	}
	async #releaseUnreconciledAction(
		effect: ChatEffect,
		payload: { channel?: unknown; threadTs?: unknown; clientMsgId: string },
	): Promise<void> {
		if (
			!effect.sessionId ||
			typeof payload.channel !== "string" ||
			typeof payload.threadTs !== "string" ||
			!Number.isSafeInteger(effect.endpointGeneration) ||
			effect.endpointGeneration <= 0
		)
			return;
		const threadTs = payload.threadTs;
		const document = await this.store.load();
		const found = Object.entries(document.conversations).find(
			([, record]) =>
				record.state === "active" &&
				record.sessionId === effect.sessionId &&
				record.teamId === this.options.teamId &&
				record.channelId === payload.channel &&
				record.rootTs === threadTs &&
				record.endpointGeneration === effect.endpointGeneration &&
				record.outboundActionClientMsgId === payload.clientMsgId,
		);
		if (!found) return;
		await this.store.transact(found[0], current =>
			current &&
			acceptsSlackInbound(current, threadTs, effect.endpointGeneration) &&
			current.outboundActionClientMsgId === payload.clientMsgId
				? nextRecord(current, {
						outboundActionId: undefined,
						outboundActionClientMsgId: undefined,
						outboundActionOwner: undefined,
						outboundActionLeaseExpiresAt: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
	}
	async #recordRecoveryFailure(effect: ChatEffect): Promise<void> {
		try {
			if (!effect.sessionId) return;
			const found = await this.findSession(effect.sessionId, true);
			if (!found) return;
			await this.store.transact(found.key, current => {
				if (!current || current.sessionId !== effect.sessionId) return current;
				return nextRecord(current, { lastError: "recovery_failure", updatedAt: this.#now() });
			});
		} catch {
			// Diagnostics must never remove the durable recovery trigger.
		}
	}

	async #drainProviderEffects(): Promise<boolean> {
		let failed = false;
		for (const effect of await this.#journal.list()) {
			try {
				if (effect.kind !== "provider-post" || effect.state === "terminal") continue;
				const current = !!effect.sessionId && (await this.#providerEffectCurrent(effect));
				if (!current && effect.state !== "uncertain" && effect.state !== "leased") {
					await this.#journal.terminalize(effect.id, { provider: "slack", status: "stale_noop" });
					continue;
				}
				if (!effect.sessionId) continue;
				const payload = effect.payload as {
					channel?: unknown;
					text?: unknown;
					threadTs?: unknown;
					clientMsgId?: unknown;
				};
				if (
					typeof payload.channel !== "string" ||
					typeof payload.text !== "string" ||
					typeof payload.clientMsgId !== "string" ||
					(payload.threadTs !== undefined && typeof payload.threadTs !== "string")
				)
					continue;
				await this.#postDurable(effect.id, effect.sessionId, effect.endpointGeneration, {
					channel: payload.channel,
					text: payload.text,
					...(typeof payload.threadTs === "string" ? { threadTs: payload.threadTs } : {}),
					clientMsgId: payload.clientMsgId,
				});
			} catch {
				failed = true;
				await this.#recordRecoveryFailure(effect);
			}
		}
		await this.#reconcileTerminalProviderReceipts();
		return failed;
	}
	async #rescheduleAfterEffectTransition<T extends ChatEffect | undefined>(transition: Promise<T>): Promise<T> {
		const effect = await transition;
		if (effect?.state !== "terminal") await this.#scheduleLeaseRecovery();
		return effect;
	}
	async #scheduleLeaseRecovery(recoveryFailed = false): Promise<void> {
		const scheduled = this.#leaseRecoveryScheduling.then(async () => {
			await this.#scheduleLeaseRecoveryNow(recoveryFailed);
		});
		this.#leaseRecoveryScheduling = scheduled.catch(() => undefined);
		return await scheduled;
	}
	async #scheduleLeaseRecoveryNow(recoveryFailed: boolean): Promise<void> {
		if (!this.#started) return;
		const now = this.#now();
		const recoveryAt = (await this.#journal.list())
			.filter(effect => effect.transport === "slack")
			.reduce<number | undefined>(
				(earliest, effect) => {
					const claimAt =
						effect.state === "leased" && Number.isFinite(effect.leaseExpiresAt)
							? effect.leaseExpiresAt
							: effect.state === "pending" ||
									effect.state === "accepted" ||
									(effect.state === "uncertain" && !effect.kind.includes(".inbound."))
								? now
								: undefined;
					return claimAt === undefined || (earliest !== undefined && earliest <= claimAt) ? earliest : claimAt;
				},
				recoveryFailed ? now : undefined,
			);
		if (!this.#started) return;
		if (recoveryAt === undefined) {
			this.#clearLeaseRecoveryTimer();
			this.#leaseRecoveryFailures = 0;
			return;
		}
		if (this.#leaseRecoveryAt !== undefined && this.#leaseRecoveryAt <= recoveryAt) return;
		this.#clearLeaseRecoveryTimer();
		this.#leaseRecoveryAt = recoveryAt;
		const delay =
			recoveryAt <= now
				? Math.min(1_000, 25 * 2 ** Math.min(this.#leaseRecoveryFailures, 5))
				: Math.min(recoveryAt - now, 2_147_483_647);
		const timerGeneration = this.#leaseRecoveryTimerGeneration;
		this.#leaseRecoveryTimer = setTimeout(() => {
			if (!this.#started || timerGeneration !== this.#leaseRecoveryTimerGeneration) return;
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			void this.#track(this.#recoverLeasedEffects());
		}, delay);
	}
	#clearLeaseRecoveryTimer(): void {
		this.#leaseRecoveryTimerGeneration++;
		if (this.#leaseRecoveryTimer) clearTimeout(this.#leaseRecoveryTimer);
		this.#leaseRecoveryTimer = undefined;
		this.#leaseRecoveryAt = undefined;
	}
	async #recoverLeasedEffects(): Promise<void> {
		if (!this.#started || this.#recoveringLeasedEffects) return;
		this.#recoveringLeasedEffects = true;
		let failed = false;
		try {
			try {
				await this.#reconcileTerminalProviderReceipts();
			} catch {
				failed = true;
			}
			try {
				failed ||= await this.#drainProviderEffects();
			} catch {
				failed = true;
			}
			try {
				await this.#reconcileTerminalProviderReceipts();
			} catch {
				failed = true;
			}
			try {
				await this.#drainPendingDispatches();
			} catch {
				failed = true;
			}
		} finally {
			if (failed) this.#leaseRecoveryFailures = Math.min(this.#leaseRecoveryFailures + 1, 5);
			else this.#leaseRecoveryFailures = 0;
			try {
				await this.#scheduleLeaseRecovery(failed);
			} catch {
				/* retained effects are retried by the next trigger */
			} finally {
				this.#recoveringLeasedEffects = false;
			}
		}
	}

	async #providerEffectCurrent(effect: ChatEffect): Promise<boolean> {
		if (!effect.sessionId || !Number.isSafeInteger(effect.endpointGeneration) || effect.endpointGeneration <= 0)
			return false;
		const endpoint = await this.#resolveEndpoint(effect.sessionId);
		if (!endpoint || endpoint.generation !== effect.endpointGeneration) return false;
		const payload = effect.payload as { threadTs?: unknown };
		const threadTs = payload.threadTs;
		const records = Object.values((await this.store.load()).conversations);
		if (typeof threadTs === "string") {
			return records.some(
				record =>
					record.sessionId === effect.sessionId &&
					acceptsSlackInbound(record, threadTs, effect.endpointGeneration),
			);
		}
		return records.some(
			record =>
				record.sessionId === effect.sessionId &&
				record.endpointGeneration === effect.endpointGeneration &&
				record.state === "posting_root",
		);
	}

	async #providerEffectPayload(
		id: string,
		sessionId: string,
		endpointGeneration: number,
		expected: { channel: string; text: string; threadTs?: string; clientMsgId: string },
	): Promise<{ payload: typeof expected; existed: boolean }> {
		const existing = await this.#journal.read<typeof expected>(id);
		if (!existing) return { payload: expected, existed: false };
		const payload = existing.payload;
		if (
			existing.kind !== "provider-post" ||
			existing.transport !== "slack" ||
			existing.sessionId !== sessionId ||
			existing.endpointGeneration !== endpointGeneration ||
			typeof payload.channel !== "string" ||
			typeof payload.text !== "string" ||
			typeof payload.clientMsgId !== "string" ||
			(payload.threadTs !== undefined && typeof payload.threadTs !== "string") ||
			payload.channel !== expected.channel ||
			payload.threadTs !== expected.threadTs ||
			payload.clientMsgId !== expected.clientMsgId
		) {
			throw new SlackEndpointBindingError("Slack provider effect identity does not match the durable occurrence.");
		}
		return { payload, existed: true };
	}

	async #postDurable(
		id: string,
		sessionId: string,
		endpointGeneration: number,
		payload: { channel: string; text: string; threadTs?: string; clientMsgId: string },
	): Promise<SlackPostedMessage> {
		if (!Number.isSafeInteger(endpointGeneration) || endpointGeneration <= 0)
			throw new SlackEndpointBindingError("Slack provider effects require a positive endpoint generation.");
		const initial = await this.#rescheduleAfterEffectTransition(
			this.#journal.enqueue({
				id,
				kind: "provider-post",
				transport: "slack",
				sessionId,
				endpointGeneration,
				payload,
			}),
		);
		const fromReceipt = (effect: typeof initial): SlackPostedMessage | undefined => {
			if (
				effect.state !== "terminal" ||
				effect.receipt?.status !== "posted" ||
				!effect.receipt.channelId ||
				!effect.receipt.timestamp
			)
				return undefined;
			return {
				channel: effect.receipt.channelId,
				ts: effect.receipt.timestamp,
				client_msg_id: effect.receipt.messageId,
			};
		};
		const completed = fromReceipt(initial);
		if (completed) return completed;
		if (initial.state === "terminal") throw new Error("Slack provider effect previously failed");
		let effect: ChatEffect<typeof payload> | undefined;
		for (let attempt = 0; attempt < 100 && !effect; attempt++) {
			effect = await this.#rescheduleAfterEffectTransition(
				this.#journal.claim<typeof payload>(id, this.#publicationOwnerId, Math.max(this.#publicationLeaseMs, 100)),
			);
			if (effect) break;
			const current = await this.#journal.read<typeof payload>(id);
			if (current) {
				const posted = fromReceipt(current);
				if (posted) return posted;
				if (current.state === "terminal") throw new Error("Slack provider effect previously failed");
			}
			await Bun.sleep(1);
		}
		if (!effect) throw new Error("Slack provider effect is owned by another worker");
		const lease: ChatEffectLease = { owner: this.#publicationOwnerId, epoch: effect.epoch };
		// A recovered lease may have crossed the provider boundary before its owner
		// died, and a fresh post may have reached Slack at a now-superseded generation.
		// Reconcile first in all cases. Only an effect that may have crossed the
		// provider boundary is terminalized after an absent reconciliation; a stale
		// pending effect remains nonterminal for recovery.
		const requiresReconciliation =
			initial.state === "accepted" || initial.state === "uncertain" || initial.state === "leased";
		try {
			const posted = await this.#withEffectLease(id, lease, async () => {
				const found = await this.options.provider.findMessageByClientMsgId({
					channel: effect!.payload.channel,
					threadTs: effect!.payload.threadTs,
					clientMsgId: effect!.payload.clientMsgId,
				});
				if (found) return found;
				if (!(await this.#providerEffectCurrent(effect!))) {
					if (requiresReconciliation) throw new SlackReconciledAbsentEffectError();
					throw new SlackStaleEffectError();
				}
				return await this.options.provider.postMessage(effect!.payload);
			});

			if (
				!(await this.#journal.record(id, lease, "terminal", {
					provider: "slack",
					channelId: posted.channel,
					timestamp: posted.ts,
					messageId: posted.client_msg_id ?? posted.ts,
					status: "posted",
				}))
			)
				throw new Error("Slack provider effect lease expired before commit");

			return posted;
		} catch (error) {
			if (error instanceof SlackReconciledAbsentEffectError) {
				await this.#rescheduleAfterEffectTransition(
					this.#journal.record(id, lease, "terminal", { provider: "slack", status: "not_found" }),
				);
				throw new SlackStaleEffectError();
			}
			if (error instanceof SlackStaleEffectError) throw error;
			if (this.#isUncertainPostFailure(error)) {
				try {
					const reconciled = await this.#withEffectLease(
						id,
						lease,
						async () =>
							await this.options.provider.findMessageByClientMsgId({
								channel: effect!.payload.channel,
								threadTs: effect!.payload.threadTs,
								clientMsgId: effect!.payload.clientMsgId,
							}),
					);
					if (reconciled) {
						if (
							!(await this.#journal.record(id, lease, "terminal", {
								provider: "slack",
								channelId: reconciled.channel,
								timestamp: reconciled.ts,
								messageId: reconciled.client_msg_id ?? reconciled.ts,
								status: "posted",
							}))
						)
							throw new Error("Slack provider effect lease expired before commit");
						return reconciled;
					}
				} catch {
					// Preserve the uncertain effect for a later reconciliation attempt.
				}
			}
			const uncertain = this.#isUncertainPostFailure(error);
			await this.#rescheduleAfterEffectTransition(
				this.#journal.record(id, lease, uncertain ? "uncertain" : "terminal", {
					provider: "slack",
					status: uncertain ? "uncertain" : "failed",
				}),
			);
			throw error;
		}
	}

	async #withRootLease<T>(key: string, clientMsgId: string, fence: number, operation: () => Promise<T>): Promise<T> {
		return await this.#withPublicationLease(operation, async () => {
			let renewed = false;
			await this.store.transact(key, current => {
				if (
					!current ||
					current.clientMsgId !== clientMsgId ||
					current.rootPublicationOwner !== this.#publicationOwnerId ||
					current.rootPublicationFence !== fence
				)
					return current;
				renewed = true;
				return nextRecord(current, {
					rootPublicationLeaseExpiresAt: this.#now() + this.#publicationLeaseMs,
					updatedAt: this.#now(),
				});
			});
			if (!renewed) throw new Error("Slack root publication lease renewal failed");
		});
	}

	async #withActionLease<T>(key: string, clientMsgId: string, fence: number, operation: () => Promise<T>): Promise<T> {
		return await this.#withPublicationLease(operation, async () => {
			let renewed = false;
			await this.store.transact(key, current => {
				if (
					!current ||
					current.outboundActionClientMsgId !== clientMsgId ||
					current.outboundActionOwner !== this.#publicationOwnerId ||
					current.outboundActionFence !== fence
				)
					return current;
				renewed = true;
				return nextRecord(current, {
					outboundActionLeaseExpiresAt: this.#now() + this.#publicationLeaseMs,
					updatedAt: this.#now(),
				});
			});
			if (!renewed) throw new Error("Slack action publication lease renewal failed");
		});
	}

	async #withPublicationLease<T>(operation: () => Promise<T>, renew: () => Promise<void>): Promise<T> {
		return await this.#withRenewal(operation, renew);
	}

	async #withRenewal<T>(
		operation: () => Promise<T>,
		renew: () => Promise<void>,
		renewBeforeOperation = true,
	): Promise<T> {
		if (renewBeforeOperation) await renew();
		let failure: unknown;
		let renewing = Promise.resolve();
		let renewalPending = false;
		const renewLease = async () => {
			try {
				await renew();
			} catch (error) {
				failure ??= error;
			}
		};
		const timer = setInterval(
			() => {
				if (renewalPending || failure) return;
				renewalPending = true;
				renewing = renewing.then(renewLease).finally(() => {
					renewalPending = false;
				});
			},
			Math.max(1, Math.floor(this.#publicationLeaseMs / 4)),
		);
		try {
			const result = await operation();
			await renewing;
			if (failure) throw failure;
			return result;
		} finally {
			clearInterval(timer);
			await renewing;
		}
	}

	async #waitForRootReconciliation(key: string, initial: SlackConversation): Promise<SlackConversation | undefined> {
		const clientMsgId = initial.clientMsgId;
		const endpointGeneration = initial.endpointGeneration;
		if (
			typeof clientMsgId !== "string" ||
			typeof endpointGeneration !== "number" ||
			!Number.isSafeInteger(endpointGeneration) ||
			endpointGeneration <= 0
		)
			throw new SlackEndpointBindingError("Slack root publication has no stable reconciliation identity.");
		for (let attempt = 0; attempt < 100; attempt++) {
			const current = await this.store.read(key);
			if (
				current?.state !== "posting_root" ||
				current.clientMsgId !== clientMsgId ||
				current.endpointGeneration !== endpointGeneration
			)
				return current;
			const effect:
				| ChatEffect<{
						channel?: unknown;
						text?: unknown;
						threadTs?: unknown;
						clientMsgId?: unknown;
				  }>
				| undefined = await this.#journal.read(`root:${current.sessionId}:${clientMsgId}`);
			if (effect?.state === "terminal") {
				await this.#reconcileTerminalProviderReceipts();
				await Bun.sleep(10);
				continue;
			}
			const payload: { channel?: unknown; text?: unknown; threadTs?: unknown; clientMsgId?: unknown } | undefined =
				effect?.payload;
			if (
				effect?.kind === "provider-post" &&
				effect.transport === "slack" &&
				effect.sessionId === current.sessionId &&
				typeof current.sessionId === "string" &&
				effect.endpointGeneration === endpointGeneration &&
				(effect.state === "pending" ||
					effect.state === "accepted" ||
					effect.state === "uncertain" ||
					(effect.state === "leased" && this.#leaseExpired(effect.leaseExpiresAt, this.#now()))) &&
				payload &&
				typeof payload.channel === "string" &&
				payload.channel === current.channelId &&
				typeof payload.text === "string" &&
				payload.threadTs === undefined &&
				payload.clientMsgId === clientMsgId
			) {
				try {
					await this.#postDurable(effect.id, current.sessionId, endpointGeneration, {
						channel: payload.channel,
						text: payload.text,
						clientMsgId,
					});
				} catch (error) {
					if (!(error instanceof SlackStaleEffectError)) throw error;
				}
				await this.#reconcileTerminalProviderReceipts();
				continue;
			}
			await Bun.sleep(10);
		}
		throw new Error("Slack root post reconciliation is still pending");
	}

	async #waitForRoot(
		key: string,
		sessionId: string,
		body: string,
		endpointGeneration: number,
	): Promise<SlackConversation> {
		for (let attempt = 0; attempt < 100; attempt++) {
			await Bun.sleep(10);
			const current = await this.store.read(key);
			if (current?.state === "active") {
				const currentGeneration = this.#requireEndpointGeneration(current);
				if (currentGeneration === endpointGeneration) return current;
				if (currentGeneration > endpointGeneration)
					throw new SlackEndpointBindingError("Slack root belongs to a newer endpoint generation.");
				return await this.resume(sessionId, body, endpointGeneration);
			}
			if (
				current?.state === "error" ||
				(current?.state === "posting_root" &&
					this.#leaseExpired(current.rootPublicationLeaseExpiresAt, this.#now())) ||
				(current !== undefined &&
					current.rootPublicationOwner !== undefined &&
					this.#leaseExpired(current.rootPublicationLeaseExpiresAt, this.#now()))
			) {
				return await this.postRoot(sessionId, body, endpointGeneration);
			}
		}
		throw new Error("Slack root post is still pending");
	}

	async #waitForAction(key: string, sessionId: string, body: string, actionId: string): Promise<SlackConversation> {
		for (let attempt = 0; attempt < 100; attempt++) {
			await Bun.sleep(10);
			const current = await this.store.read(key);
			if (current?.pendingActionId === actionId && !current.outboundActionId) return current;
			if (
				current?.outboundActionId === actionId &&
				this.#leaseExpired(current.outboundActionLeaseExpiresAt, this.#now())
			) {
				return await this.notify(sessionId, body, actionId);
			}
		}
		throw new Error("Slack action publication is still pending");
	}

	async findSession(
		sessionId: string,
		includeInactive: boolean,
	): Promise<
		| {
				key: string;
				record: SlackConversation;
		  }
		| undefined
	> {
		const document = await this.store.load();
		return Object.entries(document.conversations)
			.map(([key, record]) => ({ key, record }))
			.filter(
				entry =>
					entry.record.sessionId === sessionId &&
					(includeInactive ||
						entry.record.state === "active" ||
						entry.record.state === "posting_root" ||
						entry.record.state === "error"),
			)
			.sort(
				(left, right) =>
					(right.record.endpointGeneration ?? -1) - (left.record.endpointGeneration ?? -1) ||
					right.record.generation - left.record.generation ||
					right.record.updatedAt - left.record.updatedAt,
			)[0];
	}
	#intentKey(sessionId: string): string {
		return slackConversationKey({
			teamId: this.options.teamId,
			channelId: this.options.channelId,
			rootTs: `intent:${sessionId}`,
		});
	}
	#requireEndpointGeneration(record: SlackConversation): number {
		const generation = record.endpointGeneration;
		if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0)
			throw new SlackEndpointBindingError("Slack conversation has no current endpoint generation.");
		return generation;
	}
	#leaseExpired(expiresAt: number | undefined, now: number): boolean {
		return expiresAt === undefined || expiresAt <= now;
	}

	#isUncertainPostFailure(error: unknown): boolean {
		return (
			error instanceof SlackProviderError &&
			error.operation === "chat.postMessage" &&
			(error.code === "connection" || error.mayHaveBeenAccepted)
		);
	}
	#isDefiniteSdkPreSendFailure(error: unknown): boolean {
		if (error instanceof SlackEndpointBindingError) return true;
		if (error instanceof SdkClientError) return error.code === "connection_closed";
		return (
			error instanceof Error &&
			error.name === "ChatDeliveryError" &&
			(error as ChatDeliveryError).phase === "pre_send"
		);
	}
}
