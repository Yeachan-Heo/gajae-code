import { createHash, randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import { SdkClientError } from "../client/client";
import { type SessionAttachment, SessionRouterError } from "../router";

import type { ChatDeliveryError } from "./chat-daemon-runtime";
import { ConversationStore } from "./conversation-store";
import {
	acceptsSlackInbound,
	normalizeSlackConversation,
	type SlackConversation,
	type SlackInboundDispatchReceipt,
	slackConversationKey,
} from "./slack-conversation";

import { assertBoundedSlackRootTs, claimSlackThreadBinding, SlackThreadBindingError } from "./slack-thread-binding";

export type { SlackThreadBindingErrorCode } from "./slack-thread-binding";
export { SlackThreadBindingError } from "./slack-thread-binding";

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

import {
	type ChatEffect,
	ChatEffectJournal,
	type ChatEffectLease,
	MAX_TERMINAL_CHAT_EFFECTS,
} from "./chat-effect-journal";
import { SlackProviderError } from "./slack-live-provider";
import type {
	SlackMessageSearchResult,
	SlackPostedMessage,
	SlackProvider,
	SlackSocketEnvelope,
} from "./slack-provider";

function slackPublicationClientMsgId(publicationId: string): string {
	const digest = createHash("sha256").update(publicationId).digest("hex");
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

// Durable filesystem publication leases must outlast one event-loop and persistence turn.
const MIN_PUBLICATION_LEASE_MS = 100;
const INBOUND_REACTION_DEADLINE_MS = 5_000;
const RETIREMENT_DRAIN_MS = 5_000;
const INBOUND_REACTION = "eyes";

type SlackProviderWorkScope = {
	sessionId: string;
	endpointGeneration: number;
	attachmentAuthorityId?: string;
};

type SlackProviderWork = {
	scopeKey: string;
	invalidate(): Promise<void>;
	abort(): void;
	/** Best-effort work is aborted before the graceful shutdown drain. */
	abortOnStop?: boolean;
	terminalize(): Promise<void>;
	settled: Promise<void>;
};

type SlackRetiredProviderWorkScope = {
	retirements: number;
	terminalizations: Set<Promise<void>>;
};

function slackProviderWorkScopeKey(scope: SlackProviderWorkScope): string {
	return JSON.stringify([scope.sessionId, scope.endpointGeneration, scope.attachmentAuthorityId]);
}

export interface SlackBindingAuthority {
	sessionId: string;
	endpointGeneration: number;
	attachmentAuthorityId?: string;
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

	resolveAttachment: (sessionId: string) => Promise<SessionAttachment | null>;
	/** Exact Router proof for adopting an existing root. */
	resolveBindingAuthority?: (sessionId: string) => Promise<SlackBindingAuthority | undefined>;
	onCommand?: (
		sessionId: string,
		content: string,
		attachment: SessionAttachment,
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
	attachmentAuthorityId?: string;
	actorId: string;
	eventId: string;
	interactionId: string;
	retryKey: string;
	eventContext?: string;
	kind: "action" | "command" | "message";
	actionId?: string;
};

type SlackInboundEffectPayload =
	| { type: "reply"; id: string; answer: string; idempotencyKey: string; routing: SlackInboundRouting }
	| { type: "command"; content: string; idempotencyKey: string; routing: SlackInboundRouting }
	| { type: "user_message"; sessionId: string; text: string; idempotencyKey: string; routing: SlackInboundRouting };

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
	if (
		(eventPayload.type !== "events_api" && eventPayload.type !== "event_callback") ||
		!eventPayload.event ||
		eventPayload.event.type !== "message"
	)
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

function attachmentAcceptsAuthority(attachment: SessionAttachment, authorityId: string | undefined): boolean {
	return (
		attachment.authorityId === authorityId ||
		(attachment.legacyAuthorityId !== undefined && attachment.legacyAuthorityId === authorityId)
	);
}

function recordAcceptsAuthority(record: SlackConversation, authorityId: string | undefined): boolean {
	return (
		record.attachmentAuthorityId === authorityId ||
		(record.attachmentAuthorityMigrationFromId !== undefined &&
			record.attachmentAuthorityMigrationFromId === authorityId)
	);
}

function replyableActionId(actionId: string | undefined): string | undefined {
	return actionId?.startsWith("idle:") ? undefined : actionId;
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
	readonly #resolveAttachment: (sessionId: string) => Promise<SessionAttachment | null>;
	readonly #resolveAttachmentRaw: (sessionId: string) => Promise<SessionAttachment | null>;

	readonly #publicationOwnerId: string;
	readonly #publicationLeaseMs: number;
	readonly #journal: ChatEffectJournal;

	readonly #inflightInbound = new Set<string>();
	readonly #activeWork = new Set<Promise<unknown>>();
	readonly #workInvalidators = new Set<SlackProviderWork>();
	readonly #retiredProviderWorkScopes = new Map<string, SlackRetiredProviderWorkScope>();
	readonly #rollovers = new Map<string, Promise<SlackRootPublication>>();
	#workGeneration = 0;
	#lifecycleTail: Promise<void> = Promise.resolve();
	#lifecycleGeneration = 0;
	#startedGeneration: number | undefined;
	#startOperation: Promise<void> | undefined;
	#startOperationGeneration: number | undefined;
	#stopOperation: Promise<void> | undefined;
	#started = false;
	#providerStartingGeneration: number | undefined;
	#providerRunningGeneration: number | undefined;
	readonly #providerStopRequestedGenerations = new Set<number>();
	#providerLifecycleTail: Promise<void> | undefined;
	#providerLifecycleError: unknown;
	#providerLifecycleErrorSet = false;
	#leaseRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
	#leaseRecoveryAt: number | undefined;
	#leaseRecoveryFailures = 0;
	#leaseRecoveryTimerGeneration = 0;
	#leaseRecoveryScheduling: Promise<void> = Promise.resolve();
	#recoveringLeasedEffects = false;
	readonly #migratedAttachmentAuthorities = new Set<string>();

	constructor(private readonly options: SlackNotificationDaemonOptions) {
		this.store =
			options.store ?? new ConversationStore<SlackConversation>({ agentDir: options.agentDir, kind: "slack" });
		this.#now = options.now ?? Date.now;
		this.#randomId = options.randomId ?? randomUUID;
		this.#publicationOwnerId = options.publicationOwnerId ?? randomUUID();
		this.#publicationLeaseMs = Math.max(options.publicationLeaseMs ?? 30_000, MIN_PUBLICATION_LEASE_MS);
		this.#journal = new ChatEffectJournal({ agentDir: options.agentDir, transport: "slack", now: this.#now });
		this.#resolveAttachmentRaw = options.resolveAttachment;
		this.#resolveAttachment = async sessionId => {
			const attachment = await this.#resolveAttachmentRaw(sessionId);
			const migrationKey = attachment
				? `${attachment.sessionId}:${attachment.generation}:${attachment.legacyAuthorityId ?? ""}:${attachment.authorityId ?? ""}`
				: undefined;
			if (
				attachment?.isCurrent() &&
				attachment.legacyAuthorityId &&
				attachment.authorityId &&
				attachment.legacyAuthorityId !== attachment.authorityId &&
				migrationKey &&
				!this.#migratedAttachmentAuthorities.has(migrationKey)
			) {
				await this.migrateAttachmentAuthority(
					attachment.sessionId,
					attachment.generation,
					attachment.legacyAuthorityId,
					attachment.authorityId,
				);
				this.#migratedAttachmentAuthorities.add(migrationKey);
			}
			return attachment;
		};
	}

	restartBlocked(): boolean {
		return this.#providerLifecycleTail !== undefined || this.#providerLifecycleErrorSet;
	}

	async start(): Promise<void> {
		if (this.#providerLifecycleErrorSet) throw this.#providerLifecycleError;
		if (this.#providerLifecycleTail) {
			const tail = this.#providerLifecycleTail;
			const settled = await Promise.race([
				Promise.allSettled([tail]).then(() => true),
				Bun.sleep(5_000).then(() => false),
			]);
			if (!settled) throw new Error("Prior Slack provider shutdown did not settle before restart.");
			try {
				await tail;
			} catch (error) {
				this.#recordProviderLifecycleError(error);
				throw error;
			}
			if (this.#providerLifecycleTail === tail) this.#providerLifecycleTail = undefined;
		}
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
					if (this.#startedGeneration === lifecycleGeneration) {
						this.#started = false;
						this.#startedGeneration = undefined;
						this.#clearLeaseRecoveryTimer();
					}
					return;
				}
				this.#providerStartingGeneration = lifecycleGeneration;
				try {
					await this.options.provider.start(async envelope => {
						if (
							!this.#started ||
							this.#startedGeneration !== lifecycleGeneration ||
							lifecycleGeneration !== this.#lifecycleGeneration
						)
							return;
						await this.#track(this.handleEnvelope(envelope));
					});
					if (this.#startedGeneration === lifecycleGeneration && this.#lifecycleGeneration === lifecycleGeneration)
						this.#providerRunningGeneration = lifecycleGeneration;
				} finally {
					if (this.#providerStartingGeneration === lifecycleGeneration)
						this.#providerStartingGeneration = undefined;
				}
				if (lifecycleGeneration !== this.#lifecycleGeneration || this.#startedGeneration !== lifecycleGeneration) {
					if (this.#startedGeneration === lifecycleGeneration) {
						this.#started = false;
						this.#startedGeneration = undefined;
						this.#clearLeaseRecoveryTimer();
					}
					if (this.#providerRunningGeneration === lifecycleGeneration) this.#providerRunningGeneration = undefined;
					if (!this.#providerStopRequestedGenerations.has(lifecycleGeneration)) await this.options.provider.stop();
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
		const stopProvider =
			this.#providerStartingGeneration === lifecycleGeneration ||
			this.#providerRunningGeneration === lifecycleGeneration;
		this.#started = false;
		this.#startedGeneration = undefined;
		if (this.#providerRunningGeneration === lifecycleGeneration) this.#providerRunningGeneration = undefined;
		this.#clearLeaseRecoveryTimer();
		for (const work of this.#workInvalidators) if (work.abortOnStop) work.abort();
		if (stopProvider) this.#providerStopRequestedGenerations.add(lifecycleGeneration);
		const providerStop = stopProvider ? Promise.resolve().then(() => this.options.provider.stop()) : undefined;
		const providerStopResult = providerStop?.then(
			() => ({ kind: "stopped" as const }),
			error => ({ kind: "rejected" as const, error }),
		);
		let providerStopError: unknown;
		let providerStopRejected = false;
		const shutdownDeadline = this.#now() + 5_000;
		const predecessor = this.#lifecycleTail;
		const operation = (async () => {
			const predecessorRemaining = shutdownDeadline - this.#now();
			const predecessorSettled =
				predecessorRemaining > 0 &&
				(await Promise.race([
					predecessor.then(
						() => true,
						() => true,
					),
					Bun.sleep(predecessorRemaining).then(() => false),
				]));
			if (!predecessorSettled) {
				await this.#invalidateActiveWork();
				logger.warn(
					"Slack lifecycle predecessor exceeded the shutdown deadline; continuing with Router revocation.",
				);
			}
			// Calling provider.stop() before joining the lifecycle queue lets a provider
			// cancel an open that resolves only after its socket is stopped. The same
			// operation deadline covers provider teardown and admitted work draining.
			if (providerStop && providerStopResult) {
				const remaining = shutdownDeadline - this.#now();
				const outcome = await Promise.race([
					providerStopResult,
					Bun.sleep(Math.max(0, remaining)).then(() => ({ kind: "timeout" as const })),
				]);
				if (outcome.kind === "rejected") {
					providerStopRejected = true;
					providerStopError = outcome.error;
				} else if (outcome.kind === "timeout") {
					this.#retainProviderLifecycle(providerStop);
					await this.#invalidateActiveWork();
					logger.warn("Slack provider stop exceeded the shutdown deadline; continuing with Router revocation.");
				}
			}
			// Drain until quiescent, but never let hung provider work prevent
			// SessionRouter authority revocation and daemon ownership release.
			while (this.#activeWork.size > 0) {
				const remaining = shutdownDeadline - this.#now();
				if (remaining <= 0) {
					await this.#invalidateActiveWork();
					logger.warn(
						"Slack provider work exceeded the 5000ms shutdown drain; continuing with Router revocation.",
					);
					break;
				}
				const settled = await Promise.race([
					Promise.allSettled([...this.#activeWork]).then(() => true),
					Bun.sleep(remaining).then(() => false),
				]);
				if (!settled) {
					await this.#invalidateActiveWork();
					logger.warn(
						"Slack provider work exceeded the 5000ms shutdown drain; continuing with Router revocation.",
					);
					break;
				}
			}
			if (providerStopRejected) {
				this.#recordProviderLifecycleError(providerStopError);
				throw providerStopError;
			}
		})();
		this.#lifecycleTail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#stopOperation = operation;
		try {
			await operation;
		} finally {
			if (this.#stopOperation === operation) this.#stopOperation = undefined;
		}
	}

	/** Accepted inbound effects are durably claimed before their Socket Mode ACK. */
	async handleEnvelope(envelope: SlackSocketEnvelope): Promise<boolean> {
		const lifecycleGeneration = this.#lifecycleGeneration;
		if (!text(envelope.envelope_id)) return false;
		const inbound = messageFromEnvelope(envelope.payload);
		if (!inbound || inbound.teamId !== this.options.teamId || inbound.channelId !== this.options.channelId) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		const actorId = text(inbound.event.user);
		if (
			inbound.event.bot_id ||
			inbound.event.subtype !== undefined ||
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
			const messageTs = text(inbound.event.ts);
			if (messageTs)
				this.#scheduleInboundReaction(
					claim.sessionId,
					claim.endpoint,
					inbound.channelId,
					messageTs,
					lifecycleGeneration,
				);
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

	/** Track the best-effort acknowledgement in the owning attachment's provider-work scope. */
	#scheduleInboundReaction(
		sessionId: string,
		endpoint: SessionAttachment,
		channel: string,
		timestamp: string,
		lifecycleGeneration: number,
	): void {
		const scope: SlackProviderWorkScope = {
			sessionId,
			endpointGeneration: endpoint.generation,
			...(endpoint.authorityId === undefined ? {} : { attachmentAuthorityId: endpoint.authorityId }),
		};
		const scopeKey = slackProviderWorkScopeKey(scope);
		const workGeneration = this.#workGeneration;
		const controller = new AbortController();
		const settled = Promise.withResolvers<void>();
		let abortKind: "deadline" | "lifecycle" | undefined;
		const abort = (kind: "deadline" | "lifecycle"): void => {
			abortKind ??= kind;
			controller.abort();
		};
		const work: SlackProviderWork = {
			scopeKey,
			invalidate: async () => abort("lifecycle"),
			abort: () => abort("lifecycle"),
			abortOnStop: true,
			terminalize: async () => abort("lifecycle"),
			settled: settled.promise,
		};
		this.#workInvalidators.add(work);
		const reaction = (async () => {
			const deadline = setTimeout(() => abort("deadline"), INBOUND_REACTION_DEADLINE_MS);
			try {
				if (
					workGeneration !== this.#workGeneration ||
					lifecycleGeneration !== this.#lifecycleGeneration ||
					this.#retiredProviderWorkScopes.has(scopeKey) ||
					!endpoint.isCurrent()
				) {
					abort("lifecycle");
					return;
				}
				await this.options.provider.addReaction({
					channel,
					timestamp,
					name: INBOUND_REACTION,
					signal: controller.signal,
				});
				if (abortKind === "deadline")
					logger.warn(
						`Slack inbound acknowledgement reaction exceeded the ${INBOUND_REACTION_DEADLINE_MS}ms deadline and was aborted.`,
					);
			} catch {
				if (abortKind !== "lifecycle")
					logger.warn(
						abortKind === "deadline"
							? `Slack inbound acknowledgement reaction exceeded the ${INBOUND_REACTION_DEADLINE_MS}ms deadline and was aborted.`
							: "Slack inbound acknowledgement reaction failed.",
					);
			} finally {
				clearTimeout(deadline);
				this.#workInvalidators.delete(work);
				settled.resolve();
				this.#tryReleaseRetiredProviderWorkScope(scopeKey);
			}
		})();
		void this.#track(reaction);
	}

	async #invalidateActiveWork(): Promise<void> {
		this.#workGeneration += 1;
		await Promise.allSettled([...this.#workInvalidators].map(work => work.invalidate()));
	}
	#fenceRetiredProviderWorkScope(scope: SlackProviderWorkScope): string {
		const scopeKey = slackProviderWorkScopeKey(scope);
		const retired = this.#retiredProviderWorkScopes.get(scopeKey);
		if (retired) retired.retirements++;
		else this.#retiredProviderWorkScopes.set(scopeKey, { retirements: 1, terminalizations: new Set() });
		return scopeKey;
	}
	#tryReleaseRetiredProviderWorkScope(scopeKey: string): void {
		const retired = this.#retiredProviderWorkScopes.get(scopeKey);
		if (
			retired?.retirements !== 0 ||
			retired.terminalizations.size > 0 ||
			[...this.#workInvalidators].some(work => work.scopeKey === scopeKey)
		)
			return;
		this.#retiredProviderWorkScopes.delete(scopeKey);
	}
	#trackRetirementTerminalization(scopeKey: string, terminalization: Promise<void>): void {
		const retired = this.#retiredProviderWorkScopes.get(scopeKey);
		if (!retired) return;
		retired.terminalizations.add(terminalization);
		void terminalization.then(() => {
			const current = this.#retiredProviderWorkScopes.get(scopeKey);
			if (!current) return;
			current.terminalizations.delete(terminalization);
			this.#tryReleaseRetiredProviderWorkScope(scopeKey);
		});
	}
	#retirementTerminalization(terminalizations: readonly Promise<unknown>[]): Promise<void> {
		return Promise.all(
			terminalizations.map(terminalization =>
				terminalization.then(
					() => undefined,
					error => {
						logger.warn(`Slack retired attachment terminalization failed: ${String(error)}`);
					},
				),
			),
		).then(() => undefined);
	}
	async #invalidateAndDrainProviderWork(scope: SlackProviderWorkScope, deadline: number): Promise<void> {
		const scopeKey = this.#fenceRetiredProviderWorkScope(scope);
		for (;;) {
			const active = [...this.#workInvalidators].filter(work => work.scopeKey === scopeKey);
			if (active.length === 0) return;
			for (const work of active) work.abort();
			const remaining = deadline - this.#now();
			if (remaining <= 0) {
				const terminalization = this.#retirementTerminalization(active.map(work => work.terminalize()));
				this.#trackRetirementTerminalization(scopeKey, terminalization);
				logger.warn("Slack attachment provider work exceeded the 5000ms retirement drain; fenced pending effects.");
				return;
			}
			const drained = await Promise.race([
				Promise.all(active.map(work => work.settled)).then(() => true),
				Bun.sleep(remaining).then(() => false),
			]);
			if (drained) continue;
			const lingering = [...this.#workInvalidators].filter(work => work.scopeKey === scopeKey);
			for (const work of lingering) work.abort();
			const terminalization = this.#retirementTerminalization(lingering.map(work => work.terminalize()));
			this.#trackRetirementTerminalization(scopeKey, terminalization);
			logger.warn("Slack attachment provider work exceeded the 5000ms retirement drain; fenced pending effects.");
			return;
		}
	}
	#releaseRetiredProviderWorkScope(scope: SlackProviderWorkScope): void {
		const scopeKey = slackProviderWorkScopeKey(scope);
		const retired = this.#retiredProviderWorkScopes.get(scopeKey);
		if (!retired || retired.retirements === 0) return;
		retired.retirements--;
		this.#tryReleaseRetiredProviderWorkScope(scopeKey);
	}

	#recordProviderLifecycleError(error: unknown): void {
		this.#providerLifecycleError = error;
		this.#providerLifecycleErrorSet = true;
	}

	#retainProviderLifecycle(tail: Promise<void>): void {
		this.#providerLifecycleTail = tail;
		void tail.then(
			() => {
				if (this.#providerLifecycleTail === tail) this.#providerLifecycleTail = undefined;
			},
			error => {
				this.#recordProviderLifecycleError(error);
				if (this.#providerLifecycleTail === tail) this.#providerLifecycleTail = undefined;
			},
		);
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

	/**
	 * Adopt an operator-supplied root in the configured workspace and channel
	 * without publishing a replacement root.
	 *
	 * The root is verified against the provider before any lock is taken, and the
	 * claim re-proves session authority inside the store lock. When the caller is
	 * the daemon command channel it also supplies `commitAuthority`, which
	 * re-proves the exact daemon owner tuple and takes terminal request
	 * authority in the same fence, so an ownership change or a cancellation
	 * between dispatch and commit leaves the store untouched. The claim targets
	 * the same session key stock publication uses, so a concurrent first
	 * notification observes the adopted root instead of posting a second one.
	 */
	async bindExistingRoot(
		sessionId: string,
		rootTs: string,
		commitAuthority?: () => Promise<boolean>,
	): Promise<SlackConversation> {
		assertBoundedSlackRootTs(rootTs);
		const authority = await this.#bindingAuthority(sessionId);
		if (!authority)
			throw new SlackThreadBindingError(
				"session_not_live",
				"Slack thread binding requires an exact live session endpoint.",
			);
		const attachment =
			authority.attachmentAuthorityId === undefined ? await this.#resolveAttachment(sessionId) : undefined;
		const attachmentAuthorityId =
			authority.attachmentAuthorityId ??
			(attachment?.generation === authority.endpointGeneration ? attachment.authorityId : undefined);
		await this.#verifyExistingRoot(rootTs);
		return await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await claimSlackThreadBinding({
					store: this.store,
					key: this.#intentKey(sessionId),
					teamId: this.options.teamId,
					channelId: this.options.channelId,
					sessionId,
					rootTs,
					endpointGeneration: authority.endpointGeneration,
					...(attachmentAuthorityId === undefined ? {} : { attachmentAuthorityId }),
					revalidate: async () => {
						const current = await this.#bindingAuthority(sessionId, false);
						if (
							!current ||
							current.endpointGeneration !== authority.endpointGeneration ||
							current.attachmentAuthorityId !== attachmentAuthorityId
						)
							return false;
						return commitAuthority ? await commitAuthority() : true;
					},
					now: this.#now,
				}),
		);
	}

	/**
	 * Endpoint authority for a binding. The runtime injects exact discovery and
	 * attachment authority; the fallback accepts only a resolvable endpoint with a
	 * usable generation, which is all a directly constructed daemon can prove.
	 */
	async #bindingAuthority(sessionId: string, migrate = true): Promise<SlackBindingAuthority | undefined> {
		const resolved = this.options.resolveBindingAuthority
			? await this.options.resolveBindingAuthority(sessionId)
			: undefined;
		if (this.options.resolveBindingAuthority && !resolved) return undefined;
		const endpoint = await (migrate ? this.#resolveAttachment(sessionId) : this.#resolveAttachmentRaw(sessionId));
		if (
			!endpoint?.isCurrent() ||
			endpoint.sessionId !== sessionId ||
			!Number.isSafeInteger(endpoint.generation) ||
			endpoint.generation <= 0 ||
			(resolved !== undefined &&
				(resolved.sessionId !== sessionId ||
					resolved.endpointGeneration !== endpoint.generation ||
					(resolved.attachmentAuthorityId !== undefined &&
						resolved.attachmentAuthorityId !== endpoint.authorityId)))
		)
			return undefined;
		return {
			sessionId,
			endpointGeneration: endpoint.generation,
			...(endpoint.authorityId === undefined ? {} : { attachmentAuthorityId: endpoint.authorityId }),
		};
	}

	/** Prove the operator-supplied root exists in the configured channel before persisting anything. */
	async #verifyExistingRoot(rootTs: string): Promise<void> {
		let found: SlackMessageSearchResult | null;
		try {
			found = await this.options.provider.findMessageByTimestamp({ channel: this.options.channelId, ts: rootTs });
		} catch {
			throw new SlackThreadBindingError(
				"provider_unavailable",
				"Slack could not be reached to verify the existing thread root.",
			);
		}
		if (!found || found.ts !== rootTs || found.channel !== this.options.channelId)
			throw new SlackThreadBindingError("root_not_found", "The Slack root was not found in the configured channel.");
	}

	async #postRoot(
		sessionId: string,
		body: string,
		endpointGeneration?: number,
		requestedClientMsgId?: string,
	): Promise<SlackRootPublication> {
		const endpoint = await this.#resolveAttachment(sessionId);
		if (!endpoint || (endpointGeneration !== undefined && endpoint.generation !== endpointGeneration))
			throw new SlackEndpointBindingError("Slack root publication requires the current session endpoint.");
		const generation = endpoint.generation;
		const pendingKey = this.#intentKey(sessionId);
		let claimed = false;
		const pending = await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await this.store.transact(pendingKey, current => {
					if (current?.state === "active" && attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId))
						return current;
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
						clientMsgId: requestedClientMsgId ?? this.#randomId(),
						rootPublicationOwner: this.#publicationOwnerId,
						rootPublicationLeaseExpiresAt: now + this.#publicationLeaseMs,
						rootPublicationFence: (current?.rootPublicationFence ?? 0) + 1,
						endpointGeneration: generation,
						attachmentAuthorityId: endpoint.authorityId,
						updatedAt: now,
						seenEventIds:
							current && attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId)
								? current.seenEventIds
								: [],
						seenContextIds:
							current && attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId)
								? current.seenContextIds
								: [],
						seenRetryKeys:
							current && attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId)
								? current.seenRetryKeys
								: [],
						seenInteractionIds:
							current && attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId)
								? current.seenInteractionIds
								: [],
						inboundDispatches:
							current && attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId)
								? (current.inboundDispatches ?? [])
								: [],
					};
				}),
		);
		// An already-active session root is authoritative whether this daemon
		// published it or adopted an operator-supplied one, so it is checked before
		// the publication identity a claim of our own would have written.
		if (pending?.state === "active" && pending.rootTs) {
			if (pending.endpointGeneration !== generation) throw new SlackEndpointBindingError();
			return { conversation: pending, created: false };
		}
		if (!pending?.clientMsgId) throw new Error("Unable to persist Slack root post intent");
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
				const durable = await this.#providerEffectPayload(
					effectId,
					sessionId,
					generation,
					{
						channel: this.options.channelId,
						text: body,
						clientMsgId,
						...(endpoint.authorityId === undefined ? {} : { attachmentAuthorityId: endpoint.authorityId }),
					},
					pending.attachmentAuthorityMigrationFromId,
				);
				createdRootEffect = !durable.existed;
				posted = await this.#postDurable(effectId, sessionId, generation, durable.payload);
			});
		} catch (error) {
			if (this.#isUncertainPostFailure(error)) {
				// The journal retains the stable root effect for fenced reconciliation.
			}
			if (!posted) {
				if (!this.#isUncertainPostFailure(error)) {
					await this.#journal.withSessionMutationGate(
						sessionId,
						async () =>
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
							),
					);
				}
				throw error;
			}
		}
		if (!posted) throw new Error("Slack root post was not confirmed");
		const confirmedPosted = posted as SlackPostedMessage;
		// A confirmed receipt remains authoritative even if the endpoint rolled after
		// dispatch; resume performs any required replacement after reconciliation.
		const active = await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await this.store.transact(pendingKey, current => {
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
						attachmentAuthorityId: endpoint.authorityId,
						updatedAt: this.#now(),
						lastError: undefined,
						rootPublicationOwner: undefined,
						rootPublicationLeaseExpiresAt: undefined,
					});
				}),
		);
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
		publicationId?: string,
	): Promise<SlackConversation> {
		return await this.#track(this.#notify(sessionId, body, actionId, endpointGeneration, publicationId));
	}

	async #notify(
		sessionId: string,
		body: string,
		actionId?: string,
		endpointGeneration?: number,
		publicationId?: string,
	): Promise<SlackConversation> {
		const endpoint = await this.#resolveAttachment(sessionId);
		if (!endpoint || (endpointGeneration !== undefined && endpoint.generation !== endpointGeneration))
			throw new SlackEndpointBindingError("Slack notification requires the current session endpoint.");
		const generation = endpoint.generation;
		const rootPublication =
			publicationId === undefined
				? undefined
				: await this.#publicationAttempt(
						`root:${this.options.teamId}:${this.options.channelId}:${sessionId}:${publicationId}`,
						clientMsgId => `root:${sessionId}:${clientMsgId}`,
					);
		const existing = await this.findSession(sessionId, false);
		const usedExistingRoot =
			existing?.record.state === "active" &&
			!!existing.record.rootTs &&
			existing.record.endpointGeneration === generation &&
			attachmentAcceptsAuthority(endpoint, existing.record.attachmentAuthorityId);
		let conversation: SlackConversation;
		let bodyWasUsedAsRoot =
			usedExistingRoot &&
			rootPublication !== undefined &&
			existing.record.clientMsgId === rootPublication.clientMsgId;
		if (usedExistingRoot) {
			conversation = existing.record;
		} else {
			const publication =
				existing?.record.state === "active"
					? await this.#resumeWithRootPublication(sessionId, body, generation, rootPublication?.clientMsgId)
					: await this.#postRoot(sessionId, body, generation, rootPublication?.clientMsgId);
			conversation = publication.conversation;
			bodyWasUsedAsRoot ||= publication.created;
		}
		if (!conversation.rootTs) return conversation;
		const key = usedExistingRoot && existing ? existing.key : this.#intentKey(sessionId);
		const conversationGeneration = this.#requireEndpointGeneration(conversation);
		if (conversationGeneration !== generation) throw new SlackEndpointBindingError();
		if (bodyWasUsedAsRoot) {
			if (!actionId) return conversation;
			const active = await this.#journal.withSessionMutationGate(
				sessionId,
				async () =>
					await this.store.transact(key, current =>
						current &&
						acceptsSlackInbound(current, conversation.rootTs!, conversationGeneration) &&
						recordAcceptsAuthority(current, conversation.attachmentAuthorityId)
							? nextRecord(current, { pendingActionId: actionId, updatedAt: this.#now() })
							: current,
					),
			);
			if (!active) throw new Error("Slack root disappeared while activating action authority");
			return active;
		}
		if (!actionId) {
			const publication =
				publicationId === undefined
					? {
							effectId: `notification:${sessionId}:${this.#randomId()}`,
							clientMsgId: this.#randomId(),
						}
					: await this.#publicationAttempt(
							`notification:${sessionId}:${publicationId}`,
							clientMsgId => `notification:${sessionId}:${clientMsgId}`,
						);
			const durable = await this.#providerEffectPayload(
				publication.effectId,
				sessionId,
				conversationGeneration,
				{
					channel: conversation.channelId,
					threadTs: conversation.rootTs,
					text: body,
					clientMsgId: publication.clientMsgId,
					...(conversation.attachmentAuthorityId === undefined
						? {}
						: { attachmentAuthorityId: conversation.attachmentAuthorityId }),
				},
				conversation.attachmentAuthorityMigrationFromId,
			);
			await this.#postDurable(publication.effectId, sessionId, conversationGeneration, durable.payload);
			return conversation;
		}
		let actionClaimed = false;
		const intent = await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await this.store.transact(key, current => {
					if (
						!current ||
						!acceptsSlackInbound(current, conversation.rootTs!, conversationGeneration) ||
						!recordAcceptsAuthority(current, conversation.attachmentAuthorityId)
					)
						return current;
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
				}),
		);
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
				const durable = await this.#providerEffectPayload(
					effectId,
					sessionId,
					conversationGeneration,
					{
						channel: conversation.channelId,
						threadTs: conversation.rootTs,
						text: body,
						clientMsgId,
						...(conversation.attachmentAuthorityId === undefined
							? {}
							: { attachmentAuthorityId: conversation.attachmentAuthorityId }),
					},
					conversation.attachmentAuthorityMigrationFromId,
				);
				published = await this.#postDurable(effectId, sessionId, conversationGeneration, durable.payload);
			});
		} catch (error) {
			if (this.#isUncertainPostFailure(error)) {
				// The journal retains the stable action effect for fenced reconciliation.
			}
			if (!published) {
				if (!this.#isUncertainPostFailure(error)) {
					await this.#journal.withSessionMutationGate(
						sessionId,
						async () =>
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
							),
					);
				}
				throw error;
			}
		}
		const active = await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await this.store.transact(key, current =>
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
				),
		);
		if (!active) throw new Error("Slack conversation disappeared while activating action authority");
		return active;
	}

	/** Migrate pre-device-binding mapping and effect authority after Router proof. */
	async migrateAttachmentAuthority(
		sessionId: string,
		endpointGeneration: number,
		previousAuthorityId: string,
		currentAuthorityId: string,
	): Promise<void> {
		if (!previousAuthorityId || !currentAuthorityId || previousAuthorityId === currentAuthorityId) return;
		await this.#journal.withSessionMutationGate(sessionId, async () => {
			const document = await this.store.load();
			for (const key of Object.keys(document.conversations)) {
				await this.store.transact(key, current => {
					if (!current || current.sessionId !== sessionId || current.endpointGeneration !== endpointGeneration)
						return current;
					if (
						current.attachmentAuthorityId !== previousAuthorityId &&
						!recordAcceptsAuthority(current, previousAuthorityId)
					)
						return current;
					if (
						current.attachmentAuthorityId === currentAuthorityId &&
						current.attachmentAuthorityMigrationFromId === previousAuthorityId
					)
						return current;
					return nextRecord(current, {
						attachmentAuthorityId: currentAuthorityId,
						attachmentAuthorityMigrationFromId: previousAuthorityId,
						updatedAt: this.#now(),
					});
				});
			}
			await this.#journal.migrateAttachmentAuthorityIdWhileHoldingGate(
				sessionId,
				endpointGeneration,
				previousAuthorityId,
				currentAuthorityId,
			);
			for (const key of Object.keys(document.conversations)) {
				await this.store.transact(key, current => {
					if (
						!current ||
						current.sessionId !== sessionId ||
						current.endpointGeneration !== endpointGeneration ||
						current.attachmentAuthorityId !== currentAuthorityId ||
						current.attachmentAuthorityMigrationFromId !== previousAuthorityId
					)
						return current;
					const inboundDispatches = current.inboundDispatches?.map(receipt => {
						if (receipt.attachmentAuthorityId !== previousAuthorityId) return receipt;
						return { ...receipt, attachmentAuthorityId: currentAuthorityId };
					});
					return nextRecord(current, {
						attachmentAuthorityMigrationFromId: undefined,
						...(inboundDispatches === undefined ? {} : { inboundDispatches }),
						updatedAt: this.#now(),
					});
				});
			}
		});
	}

	/** Posts a safe command outcome to the active mapped root. */
	async postCommandResult(sessionId: string, content: string): Promise<boolean> {
		return await this.#track(this.#postCommandResult(sessionId, content));
	}

	async #postCommandResult(sessionId: string, content: string): Promise<boolean> {
		const found = await this.findSession(sessionId, false);
		if (found?.record.state !== "active" || !found.record.rootTs) return false;
		const generation = this.#requireEndpointGeneration(found.record);
		await this.#postDurable(`command-result:${sessionId}:${this.#randomId()}`, sessionId, generation, {
			channel: found.record.channelId,
			threadTs: found.record.rootTs,
			text: content,
			clientMsgId: this.#randomId(),
			...(found.record.attachmentAuthorityId === undefined
				? {}
				: { attachmentAuthorityId: found.record.attachmentAuthorityId }),
		});
		return true;
	}

	async resolveAction(sessionId: string, actionId: string): Promise<void> {
		const found = await this.findSession(sessionId, true);
		if (!found) return;
		await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await this.store.transact(found.key, current =>
					current?.pendingActionId === actionId
						? nextRecord(current, { pendingActionId: undefined, updatedAt: this.#now() })
						: current,
				),
		);
	}

	async close(sessionId: string, marker = "Session closed.", endpointGeneration?: number): Promise<boolean> {
		return await this.#track(this.#close(sessionId, marker, true, endpointGeneration));
	}

	async recoverCleanup(
		sessionId: string,
		endpointGeneration: number,
		authorityId?: string,
		legacyAuthorityId?: string,
	): Promise<boolean> {
		const found = await this.findSession(sessionId, true);
		if (!found) return true;
		if (found.record.endpointGeneration !== endpointGeneration) return true;
		if (found.record.state === "closed_marker" || found.record.state === "error") return true;
		if (
			(found.record.state === "posting_root" || found.record.state === "resumed_root") &&
			(found.record.attachmentAuthorityId === authorityId ||
				(legacyAuthorityId !== undefined && found.record.attachmentAuthorityId === legacyAuthorityId))
		)
			return true;
		if (found.record.state !== "active") return false;
		if (!found.record.rootTs) return false;
		if (
			(found.record.attachmentAuthorityId === authorityId ||
				(legacyAuthorityId !== undefined && found.record.attachmentAuthorityId === legacyAuthorityId)) &&
			found.record.cleanupEffectId === undefined
		)
			return true;
		const effectId = `close-marker-cleanup:${sessionId}:${found.record.clientMsgId ?? found.record.rootTs}`;
		if (found.record.cleanupEffectId !== effectId) return false;
		const effect = await this.#journal.read(effectId);
		if (!effect || (effect.state === "terminal" && !effect.receipt?.messageId && !effect.receipt?.timestamp)) {
			await this.#journal.withSessionMutationGate(
				sessionId,
				async () =>
					await this.store.transact(found.key, current =>
						current?.cleanupEffectId === effectId
							? nextRecord(current, { cleanupEffectId: undefined, updatedAt: this.#now() })
							: current,
					),
			);
			return false;
		}
		await this.close(sessionId, "Session closed.", endpointGeneration);
		return true;
	}

	async retireAttachment(sessionId: string, endpointGeneration: number): Promise<void> {
		const found = await this.findSession(sessionId, true);
		if (found?.record.endpointGeneration !== endpointGeneration) return;
		const attachmentAuthorityId = found.record.attachmentAuthorityId;
		const scope: SlackProviderWorkScope = {
			sessionId,
			endpointGeneration,
			...(attachmentAuthorityId === undefined ? {} : { attachmentAuthorityId }),
		};
		const deadline = this.#now() + RETIREMENT_DRAIN_MS;
		let releaseScope = false;
		try {
			const draining = this.#invalidateAndDrainProviderWork(scope, deadline);
			let inboundDispatches: SlackInboundDispatchReceipt[] = [];
			// Persist the mapping fence before waiting on terminal effects. A detached
			// terminalization can then never be replayed through this attachment.
			await this.#journal.withSessionMutationGate(
				sessionId,
				async () =>
					await this.store.transact(found.key, record => {
						if (
							record?.sessionId !== sessionId ||
							record.endpointGeneration !== endpointGeneration ||
							record.attachmentAuthorityId !== attachmentAuthorityId
						)
							return record;
						inboundDispatches = [...(record.inboundDispatches ?? [])];
						return nextRecord(record, {
							state: "closed_marker",
							pendingActionId: undefined,
							cleanupEffectId: undefined,
							inboundDispatches: [],
							updatedAt: this.#now(),
						});
					}),
			);
			releaseScope = true;
			await draining;
			if (inboundDispatches.length === 0) return;
			const terminalization = this.#retirementTerminalization(
				inboundDispatches.map(receipt => this.#journal.terminalize(receipt.effectId, { status: "stale_binding" })),
			);
			this.#trackRetirementTerminalization(slackProviderWorkScopeKey(scope), terminalization);
			const remaining = deadline - this.#now();
			if (remaining <= 0) {
				logger.warn("Slack attachment retirement exceeded the 5000ms deadline; fenced pending inbound effects.");
				return;
			}
			const terminalized = await Promise.race([
				terminalization.then(() => true),
				Bun.sleep(remaining).then(() => false),
			]);
			if (!terminalized)
				logger.warn("Slack attachment retirement exceeded the 5000ms deadline; fenced pending inbound effects.");
		} finally {
			if (releaseScope) this.#releaseRetiredProviderWorkScope(scope);
		}
	}

	async #close(
		sessionId: string,
		marker: string,
		allowRemovedAttachment: boolean,
		expectedEndpointGeneration?: number,
	): Promise<boolean> {
		const found = await this.findSession(sessionId, true);
		if (!found?.record.rootTs || found.record.state !== "active") return false;
		if (expectedEndpointGeneration !== undefined && found.record.endpointGeneration !== expectedEndpointGeneration)
			return false;
		const effectId = `${allowRemovedAttachment ? "close-marker-cleanup" : "close-marker"}:${sessionId}:${found.record.clientMsgId ?? found.record.rootTs}`;
		if (allowRemovedAttachment) {
			let admitted = false;
			await this.#journal.withSessionMutationGate(
				sessionId,
				async () =>
					await this.store.transact(found.key, current => {
						if (
							current?.state !== "active" ||
							current.sessionId !== found.record.sessionId ||
							current.rootTs !== found.record.rootTs ||
							current.endpointGeneration !== found.record.endpointGeneration ||
							current.clientMsgId !== found.record.clientMsgId ||
							(current.cleanupEffectId !== undefined && current.cleanupEffectId !== effectId)
						)
							return current;
						admitted = true;
						return current.cleanupEffectId === effectId
							? current
							: nextRecord(current, { cleanupEffectId: effectId, updatedAt: this.#now() });
					}),
			);
			if (!admitted) return false;
		}
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
				...(found.record.attachmentAuthorityId === undefined
					? {}
					: { attachmentAuthorityId: found.record.attachmentAuthorityId }),
			},
			found.record.attachmentAuthorityMigrationFromId,
		);
		await this.#postDurable(effectId, sessionId, this.#requireEndpointGeneration(found.record), durable.payload);
		let closed = false;
		await this.#journal.withSessionMutationGate(
			sessionId,
			async () =>
				await this.store.transact(found.key, current => {
					if (
						current?.state !== "active" ||
						current.sessionId !== found.record.sessionId ||
						current.rootTs !== found.record.rootTs ||
						current.endpointGeneration !== found.record.endpointGeneration ||
						current.clientMsgId !== found.record.clientMsgId ||
						(allowRemovedAttachment && current.cleanupEffectId !== effectId)
					)
						return current;
					closed = true;
					return nextRecord(current, {
						state: "closed_marker",
						cleanupEffectId: undefined,
						pendingActionId: undefined,
						updatedAt: this.#now(),
					});
				}),
		);

		return closed;
	}

	async resume(
		sessionId: string,
		body: string,
		endpointGeneration?: number,
		publicationId?: string,
	): Promise<SlackConversation> {
		return await this.#track(this.#resume(sessionId, body, endpointGeneration, publicationId));
	}

	async #resume(
		sessionId: string,
		body: string,
		endpointGeneration?: number,
		publicationId?: string,
	): Promise<SlackConversation> {
		const rootPublication =
			publicationId === undefined
				? undefined
				: await this.#publicationAttempt(
						`root:${this.options.teamId}:${this.options.channelId}:${sessionId}:${publicationId}`,
						clientMsgId => `root:${sessionId}:${clientMsgId}`,
					);
		return (await this.#resumeWithRootPublication(sessionId, body, endpointGeneration, rootPublication?.clientMsgId))
			.conversation;
	}

	async #resumeWithRootPublication(
		sessionId: string,
		body: string,
		endpointGeneration?: number,
		requestedClientMsgId?: string,
	): Promise<SlackRootPublication> {
		const inFlight = this.#rollovers.get(sessionId);
		if (inFlight) {
			const publication = await inFlight;
			const activeGeneration = this.#requireEndpointGeneration(publication.conversation);
			if (endpointGeneration === undefined || endpointGeneration === activeGeneration)
				return { conversation: publication.conversation, created: false };
			if (endpointGeneration < activeGeneration)
				throw new SlackEndpointBindingError("Slack root belongs to a newer endpoint generation.");
			return await this.#resumeWithRootPublication(sessionId, body, endpointGeneration, requestedClientMsgId);
		}
		const rollover = this.#resumeRoot(sessionId, body, endpointGeneration, requestedClientMsgId);
		this.#rollovers.set(sessionId, rollover);
		try {
			return await rollover;
		} finally {
			if (this.#rollovers.get(sessionId) === rollover) this.#rollovers.delete(sessionId);
		}
	}

	async #resumeRoot(
		sessionId: string,
		body: string,
		endpointGeneration?: number,
		requestedClientMsgId?: string,
	): Promise<SlackRootPublication> {
		const endpoint = await this.#resolveAttachment(sessionId);
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
			if (!previous) return await this.#postRoot(sessionId, body, generation, requestedClientMsgId);
			if (previous.record.state !== "active") {
				if (
					previous.record.rootPublicationOwner !== this.#publicationOwnerId &&
					!this.#leaseExpired(previous.record.rootPublicationLeaseExpiresAt, this.#now())
				) {
					waitedForRollover = true;
					await Bun.sleep(10);
					continue;
				}
				return await this.#postRoot(sessionId, body, generation, requestedClientMsgId);
			}
			const previousGeneration = this.#requireEndpointGeneration(previous.record);
			if (previousGeneration > generation)
				throw new SlackEndpointBindingError("Slack root belongs to a newer endpoint generation.");
			if (
				previousGeneration === generation &&
				attachmentAcceptsAuthority(endpoint, previous.record.attachmentAuthorityId) &&
				(!forced || waitedForRollover)
			)
				return { conversation: previous.record, created: false };

			let claimed = false;
			let fence: number | undefined;
			const locked = await this.#journal.withSessionMutationGate(
				sessionId,
				async () =>
					await this.store.transact(previous.key, current => {
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
					}),
			);
			if (!locked) throw new Error("Slack root mapping disappeared during rollover.");
			if (!claimed || fence === undefined) {
				waitedForRollover = true;
				await Bun.sleep(10);
				continue;
			}
			let closed = false;
			try {
				closed = await this.#track(this.#close(sessionId, "Session closed.", false, previousGeneration));
			} catch (error) {
				if (!(error instanceof SlackStaleEffectError)) throw error;
				// The old-generation close marker was deliberately suppressed after
				// reconciliation; this fenced rollover still owns the state transition.
				closed = true;
			}
			const resumed = await this.#journal.withSessionMutationGate(
				sessionId,
				async () =>
					await this.store.transact(previous.key, current =>
						closed &&
						current &&
						(current.state === "closed_marker" || current.state === "active") &&
						current.rootPublicationOwner === this.#publicationOwnerId &&
						current.rootPublicationFence === fence
							? nextRecord(current, {
									state: "resumed_root",
									pendingActionId: undefined,
									updatedAt: this.#now(),
								})
							: current,
					),
			);
			if (
				resumed?.state === "resumed_root" &&
				resumed.rootPublicationOwner === this.#publicationOwnerId &&
				resumed.rootPublicationFence === fence
			)
				return await this.#postRoot(sessionId, body, generation, requestedClientMsgId);
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
		{ key: string; endpoint: SessionAttachment; sessionId: string; receipt: SlackInboundDispatchReceipt } | undefined
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
		const endpoint = await this.#resolveAttachment(record.sessionId);
		if (
			!endpoint ||
			endpoint.generation !== record.endpointGeneration ||
			!attachmentAcceptsAuthority(endpoint, record.attachmentAuthorityId)
		)
			return undefined;
		const interactionId = text(inbound.event.client_msg_id) ?? inbound.eventId;
		const retryKey = `${inbound.eventId}:${interactionId}`;
		const inboundText = text(inbound.event.text);
		if (!inboundText) return undefined;
		const command = inboundText.startsWith("/sdk ");
		const actionId = command ? undefined : replyableActionId(record.pendingActionId);
		const kind: SlackInboundRouting["kind"] = command ? "command" : actionId ? "action" : "message";

		const idempotencyKey = `slack:${inbound.teamId}:${inbound.channelId}:${inbound.rootTs}:${actorId}:${inbound.eventId}:${interactionId}`;
		const effectId = `inbound:${inbound.teamId}:${inbound.channelId}:${inbound.rootTs}:${actorId}:${inbound.eventId}:${interactionId}`;
		const routing: SlackInboundRouting = {
			teamId: inbound.teamId,
			channelId: inbound.channelId,
			rootTs: inbound.rootTs,
			...(record.attachmentAuthorityId === undefined ? {} : { attachmentAuthorityId: record.attachmentAuthorityId }),
			eventId: inbound.eventId,
			interactionId,
			actorId,
			retryKey,
			eventContext: inbound.eventContext,
			kind,
			...(actionId ? { actionId } : {}),
		};
		const initialPayload: SlackInboundEffectPayload = command
			? { type: "command", content: inboundText, idempotencyKey, routing }
			: actionId
				? { type: "reply", id: actionId, answer: inboundText, idempotencyKey, routing }
				: { type: "user_message", sessionId: record.sessionId, text: inboundText, idempotencyKey, routing };
		let sessionId: string | undefined;
		let receipt: SlackInboundDispatchReceipt | undefined;
		let payload: SlackInboundEffectPayload = initialPayload;
		await this.#journal.withSessionMutationGate(record.sessionId, async () => {
			const existingEffect = await this.#journal.read<SlackInboundEffectPayload>(effectId);
			payload = existingEffect?.payload ?? initialPayload;
			const dispatchKind = payload.routing.kind;
			await this.#rescheduleAfterEffectTransition(
				this.#journal.enqueueWhileHoldingSessionMutationGate({
					id: effectId,
					kind:
						dispatchKind === "command"
							? "sdk.inbound.command"
							: dispatchKind === "action"
								? "sdk.inbound.reply"
								: "sdk.inbound.user_message",
					transport: "slack",
					sessionId: record.sessionId,
					endpointGeneration: endpoint.generation,
					payload,
				}),
			);

			await this.store.transact(key, current => {
				if (
					!current?.sessionId ||
					!acceptsSlackInbound(current, inbound.rootTs, endpoint.generation) ||
					!attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId) ||
					!recordAcceptsAuthority(current, payload.routing.attachmentAuthorityId)
				)
					return current;
				const existing = (current.inboundDispatches ?? []).find(
					candidate =>
						candidate.eventId === inbound.eventId ||
						candidate.interactionId === interactionId ||
						candidate.retryKey === retryKey,
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
					(dispatchKind === "action" && replyableActionId(current.pendingActionId) !== payload.routing.actionId) ||
					(dispatchKind === "message" && replyableActionId(current.pendingActionId) !== undefined)
				)
					return current;
				sessionId = current.sessionId;
				receipt = {
					key: `${inbound.eventId}:${interactionId}`,
					eventId: inbound.eventId,
					interactionId,
					retryKey,
					eventContext: inbound.eventContext,
					kind: dispatchKind,
					...(dispatchKind === "action" ? { actionId: payload.routing.actionId } : {}),
					endpointGeneration: endpoint.generation,
					...(current.attachmentAuthorityId === undefined
						? {}
						: { attachmentAuthorityId: current.attachmentAuthorityId }),
					effectId,
					idempotencyKey,
				};
				return nextRecord(current, {
					inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
					updatedAt: this.#now(),
				});
			});
		});
		if (!sessionId || !receipt) {
			await this.#journal.terminalize(effectId, { status: "rejected" });
			return undefined;
		}
		return { key, endpoint, sessionId, receipt };
	}

	async #dispatchInbound(claim: {
		key: string;
		endpoint: SessionAttachment;

		sessionId: string;
		receipt: SlackInboundDispatchReceipt;
	}): Promise<boolean> {
		let effect: ChatEffect<SlackInboundEffectPayload> | undefined;
		let dispatchable = false;
		await this.#journal.withSessionMutationGate(claim.sessionId, async () => {
			const current = await this.store.read(claim.key);
			effect = await this.#journal.read<SlackInboundEffectPayload>(claim.receipt.effectId);
			if (effect?.state === "terminal") {
				await this.#finalizeTerminalInboundDispatchWhileHoldingGate(claim.key, claim.receipt);
				return;
			}
			dispatchable =
				!!current &&
				this.#mappedInboundDispatchable(current, claim.receipt, effect) &&
				claim.receipt.endpointGeneration === claim.endpoint.generation;
			if (!dispatchable) {
				if (effect)
					await this.#journal.terminalizeWhileHoldingSessionMutationGate(claim.receipt.effectId, {
						status: "stale_mapping",
					});
				await this.#finalizeTerminalInboundDispatchWhileHoldingGate(claim.key, claim.receipt);
			}
		});
		if (!dispatchable) return false;
		return await this.#dispatchEffect(claim, claim.receipt.effectId);
	}

	async #dispatchEffect(
		claim: { key: string; endpoint: SessionAttachment; sessionId: string; receipt: SlackInboundDispatchReceipt },

		effectId: string,
	): Promise<boolean> {
		let effect: ChatEffect<SlackInboundEffectPayload> | undefined;
		await this.#journal.withSessionMutationGate(claim.sessionId, async () => {
			effect = await this.#rescheduleAfterEffectTransition(
				this.#journal.claimWhileHoldingSessionMutationGate<SlackInboundEffectPayload>(
					effectId,
					this.#publicationOwnerId,
					Math.max(this.#publicationLeaseMs, 100),
				),
			);
			if (!effect) return;
			const current = await this.store.read(claim.key);
			if (!current || !this.#matchesInboundEffect(effect, claim.receipt, current)) {
				await this.#journal.terminalizeWhileHoldingSessionMutationGate(effectId, { status: "stale_mapping" });
				await this.#finalizeTerminalInboundDispatchWhileHoldingGate(claim.key, claim.receipt);
				effect = undefined;
			}
		});
		if (!effect) return false;
		const dispatchedEffect = effect;
		const lease: ChatEffectLease = { owner: this.#publicationOwnerId, epoch: dispatchedEffect.epoch };
		const workScope: SlackProviderWorkScope = {
			sessionId: claim.sessionId,
			endpointGeneration: claim.receipt.endpointGeneration,
			...(claim.receipt.attachmentAuthorityId === undefined
				? {}
				: { attachmentAuthorityId: claim.receipt.attachmentAuthorityId }),
		};
		try {
			if (dispatchedEffect.payload.type === "command") {
				const payload = dispatchedEffect.payload;
				const accepted = await this.#withEffectLease(dispatchedEffect.id, lease, workScope, async () => {
					if (!(await this.#inboundEffectCurrent(claim, dispatchedEffect.id))) throw new SlackStaleEffectError();
					return await (this.options.onCommand?.(
						claim.sessionId,
						payload.content,
						claim.endpoint,
						payload.idempotencyKey,
					) ?? Promise.resolve(false));
				});
				if (!(await this.#inboundEffectCurrent(claim, dispatchedEffect.id))) {
					await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_binding");
					return false;
				}
				const recorded = await this.#journal.record(dispatchedEffect.id, lease, "terminal", {
					status: accepted ? "accepted" : "rejected",
				});
				if (recorded) await this.#finishDispatch(claim, "terminal");
				return accepted && !!recorded;
			}
			await this.#withEffectLease(dispatchedEffect.id, lease, workScope, async () => {
				if (!(await this.#inboundEffectCurrent(claim, dispatchedEffect.id))) throw new SlackStaleEffectError();
				await claim.endpoint.send(dispatchedEffect.payload);
			});
			if (!(await this.#inboundEffectCurrent(claim, dispatchedEffect.id))) {
				await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_binding");
				return false;
			}
			const recorded = await this.#journal.record(dispatchedEffect.id, lease, "terminal", { status: "sent" });
			if (recorded) await this.#finishDispatch(claim, "terminal");
			return !!recorded;
		} catch (error) {
			if (error instanceof SlackStaleEffectError) {
				await this.#terminalizeStaleInboundDispatch(claim.key, claim.receipt, "stale_binding");
				return false;
			}
			const state = this.#isDefiniteSdkPreSendFailure(error) ? "accepted" : "uncertain";

			const recorded = await this.#rescheduleAfterEffectTransition(
				this.#journal.record(dispatchedEffect.id, lease, state, { status: state }),
			);
			if (recorded && state === "accepted") await this.#releaseDispatch(claim);
			else if (recorded) await this.#finishDispatch(claim, "uncertain");
			return false;
		}
	}

	async #inboundEffectCurrent(
		claim: { key: string; endpoint: SessionAttachment; sessionId: string; receipt: SlackInboundDispatchReceipt },

		effectId: string,
	): Promise<boolean> {
		const endpoint = await this.#resolveAttachment(claim.sessionId);
		if (!endpoint?.isCurrent()) return false;
		if (
			endpoint.authorityId !== undefined && claim.endpoint.authorityId !== undefined
				? endpoint.authorityId !== claim.endpoint.authorityId
				: endpoint.generation !== claim.endpoint.generation
		)
			return false;
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
			recordAcceptsAuthority(current, claim.receipt.attachmentAuthorityId) &&
			attachmentAcceptsAuthority(endpoint, current.attachmentAuthorityId) &&
			this.#matchesInboundEffect(effect, claim.receipt, current) &&
			(await this.#actorAuthorized(effect.payload.routing.actorId)) &&
			(current.inboundDispatches ?? []).some(receipt => this.#sameInboundReceipt(receipt, claim.receipt))
		);
	}

	async #withEffectLease<T>(
		id: string,
		lease: ChatEffectLease,
		scope: SlackProviderWorkScope,
		operation: (signal: AbortSignal) => Promise<T>,
		workGeneration = this.#workGeneration,
	): Promise<T> {
		const scopeKey = slackProviderWorkScopeKey(scope);
		const controller = new AbortController();
		let invalidation: Promise<void> | undefined;
		let terminalization: Promise<void> | undefined;
		let invalidated = false;
		const abort = (): void => {
			invalidated = true;
			controller.abort();
		};
		const invalidate = async (): Promise<void> => {
			abort();
			invalidation ??= this.#rescheduleAfterEffectTransition(
				this.#journal.record(id, lease, "uncertain", { status: "shutdown_timeout" }),
			).then(() => undefined);
			await invalidation;
		};
		const terminalize = async (): Promise<void> => {
			abort();
			terminalization ??= (async (): Promise<void> => {
				const receipt = { status: "stale_binding" };
				const terminalized = await this.#rescheduleAfterEffectTransition(
					this.#journal.terminalize(id, receipt, lease),
				);
				if (!terminalized) await this.#rescheduleAfterEffectTransition(this.#journal.terminalize(id, receipt));
			})();
			await terminalization;
		};
		const settled = Promise.withResolvers<void>();
		const work: SlackProviderWork = {
			scopeKey,
			invalidate,
			abort,
			terminalize,
			settled: settled.promise,
		};
		this.#workInvalidators.add(work);
		const retiring = (): boolean => this.#retiredProviderWorkScopes.has(scopeKey);
		const ensureLive = async (): Promise<void> => {
			if (retiring()) {
				await terminalize();
				throw new SlackStaleEffectError();
			}
			if (invalidated || workGeneration !== this.#workGeneration) {
				await invalidate();
				throw new Error(`Slack effect ${id} was admitted after shutdown drain expiry`);
			}
			if (
				!(await this.#rescheduleAfterEffectTransition(
					this.#journal.renew(id, lease, Math.max(this.#publicationLeaseMs, 100)),
				))
			)
				throw new Error("Slack effect lease renewal failed");
			if (retiring()) {
				await terminalize();
				throw new SlackStaleEffectError();
			}
			if (workGeneration !== this.#workGeneration) {
				await invalidate();
				throw new Error(`Slack effect ${id} lost its shutdown fence`);
			}
		};
		try {
			await ensureLive();
			const result = await this.#withRenewal(
				async () => {
					await ensureLive();
					try {
						return await operation(controller.signal);
					} catch (error) {
						if (retiring()) {
							await terminalize();
							throw new SlackStaleEffectError();
						}
						throw error;
					}
				},
				ensureLive,
				false,
			);
			await ensureLive();
			return result;
		} finally {
			this.#workInvalidators.delete(work);
			settled.resolve();
			this.#tryReleaseRetiredProviderWorkScope(scopeKey);
		}
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
				const endpoint = await this.#resolveAttachment(record.sessionId!);
				if (
					!endpoint ||
					endpoint.generation !== receipt.endpointGeneration ||
					!attachmentAcceptsAuthority(endpoint, record.attachmentAuthorityId)
				) {
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
				(effect.kind !== "sdk.inbound.command" &&
					effect.kind !== "sdk.inbound.reply" &&
					effect.kind !== "sdk.inbound.user_message")
			)
				continue;
			const adopted = await this.#adoptOrphanInbound(effect as ChatEffect<SlackInboundEffectPayload>);
			if (!adopted) continue;
			const endpoint = await this.#resolveAttachment(adopted.sessionId);
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
			(routing.kind === "command" ||
				routing.kind === "message" ||
				(routing.kind === "action" && text(routing.actionId) !== undefined))
		);
	}
	#matchesInboundEffect(
		effect: ChatEffect<SlackInboundEffectPayload>,
		receipt: SlackInboundDispatchReceipt,
		record?: SlackConversation,
	): boolean {
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
			(record
				? recordAcceptsAuthority(record, receipt.attachmentAuthorityId) &&
					recordAcceptsAuthority(record, routing.attachmentAuthorityId)
				: receipt.attachmentAuthorityId === routing.attachmentAuthorityId) &&
			receipt.effectId === effect.id &&
			receipt.idempotencyKey === payload.idempotencyKey &&
			((payload.type === "command" && routing.kind === "command" && effect.kind === "sdk.inbound.command") ||
				(payload.type === "reply" &&
					routing.kind === "action" &&
					effect.kind === "sdk.inbound.reply" &&
					payload.id === routing.actionId) ||
				(payload.type === "user_message" &&
					routing.kind === "message" &&
					effect.kind === "sdk.inbound.user_message" &&
					payload.sessionId === effect.sessionId))
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
			left.attachmentAuthorityId === right.attachmentAuthorityId &&
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
			recordAcceptsAuthority(record, receipt.attachmentAuthorityId) &&
			recordAcceptsAuthority(record, effect.payload.routing.attachmentAuthorityId) &&
			record.sessionId === effect.sessionId &&
			this.#matchesInboundEffect(effect, receipt, record)
		);
	}
	async #reconcileTerminalInboundReceipts(): Promise<void> {
		for (const effect of await this.#journal.list()) {
			if (
				effect.transport !== "slack" ||
				effect.state !== "terminal" ||
				(effect.kind !== "sdk.inbound.command" &&
					effect.kind !== "sdk.inbound.reply" &&
					effect.kind !== "sdk.inbound.user_message")
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
					this.#matchesInboundEffect(effect as ChatEffect<SlackInboundEffectPayload>, candidate, current),
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
		const current = await this.store.read(key);
		if (!current?.sessionId) {
			await this.#journal.terminalize(receipt.effectId, { status });
			return;
		}
		await this.#journal.withSessionMutationGate(current.sessionId, async () => {
			const effect = await this.#journal.read<SlackInboundEffectPayload>(receipt.effectId);
			const mapping = await this.store.read(key);
			if (
				status === "stale_mapping" &&
				mapping &&
				effect &&
				this.#mappedInboundDispatchable(mapping, receipt, effect)
			)
				return;
			if (effect?.state !== "terminal")
				await this.#journal.terminalizeWhileHoldingSessionMutationGate(receipt.effectId, { status });
			await this.#finalizeTerminalInboundDispatchWhileHoldingGate(key, receipt);
		});
	}
	async #finalizeTerminalInboundDispatch(key: string, receipt: SlackInboundDispatchReceipt): Promise<void> {
		const current = await this.store.read(key);
		if (!current?.sessionId) return;
		await this.#journal.withSessionMutationGate(current.sessionId, async () => {
			await this.#finalizeTerminalInboundDispatchWhileHoldingGate(key, receipt);
		});
	}
	async #finalizeTerminalInboundDispatchWhileHoldingGate(
		key: string,
		receipt: SlackInboundDispatchReceipt,
	): Promise<void> {
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
		let payload = effect.payload;
		let routing = payload?.routing;
		if (!routing || !this.#validInboundRouting(routing) || !(await this.#actorAuthorized(routing.actorId))) {
			await this.#terminalizeRejectedInbound(effect.id);
			return undefined;
		}
		if (!effect.sessionId) {
			await this.#terminalizeRejectedInbound(effect.id);
			return undefined;
		}
		let key: string | undefined;
		let validPayload = false;
		let receipt: SlackInboundDispatchReceipt | undefined;
		await this.#journal.withSessionMutationGate(effect.sessionId, async () => {
			const currentEffect = await this.#journal.read<SlackInboundEffectPayload>(effect.id);
			if (!currentEffect) return;
			effect = currentEffect;
			payload = currentEffect.payload;
			routing = payload.routing;
			if (!this.#validInboundRouting(routing)) return;
			const matches = Object.entries((await this.store.load()).conversations).filter(
				([, record]) =>
					record.teamId === routing.teamId &&
					record.channelId === routing.channelId &&
					record.rootTs === routing.rootTs,
			);
			if (matches.length !== 1) return;
			key = matches[0]![0];
			const expectedEffectId = `inbound:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.actorId}:${routing.eventId}:${routing.interactionId}`;
			const expectedIdempotencyKey = `slack:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.actorId}:${routing.eventId}:${routing.interactionId}`;
			validPayload =
				effect.transport === "slack" &&
				Number.isSafeInteger(effect.endpointGeneration) &&
				effect.endpointGeneration > 0 &&
				effect.id === expectedEffectId &&
				payload.idempotencyKey === expectedIdempotencyKey &&
				((payload.type === "command" && routing.kind === "command" && effect.kind === "sdk.inbound.command") ||
					(payload.type === "reply" &&
						routing.kind === "action" &&
						effect.kind === "sdk.inbound.reply" &&
						payload.id === routing.actionId) ||
					(payload.type === "user_message" &&
						routing.kind === "message" &&
						effect.kind === "sdk.inbound.user_message" &&
						payload.sessionId === effect.sessionId));
			if (!validPayload) return;
			await this.store.transact(key, current => {
				if (
					!current ||
					current.sessionId !== effect.sessionId ||
					!acceptsSlackInbound(current, routing.rootTs, effect.endpointGeneration) ||
					!recordAcceptsAuthority(current, routing.attachmentAuthorityId)
				)
					return current;
				const existing = (current.inboundDispatches ?? []).find(
					candidate =>
						candidate.eventId === routing.eventId ||
						candidate.interactionId === routing.interactionId ||
						candidate.retryKey === routing.retryKey,
				);
				if (existing) {
					if (this.#matchesInboundEffect(effect, existing, current)) receipt = existing;
					return current;
				}
				if (
					current.seenEventIds.includes(routing.eventId) ||
					current.seenInteractionIds.includes(routing.interactionId) ||
					current.seenRetryKeys.includes(routing.retryKey) ||
					(routing.kind === "action" && replyableActionId(current.pendingActionId) !== routing.actionId)
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
					...(routing.attachmentAuthorityId === undefined
						? {}
						: { attachmentAuthorityId: routing.attachmentAuthorityId }),
					effectId: effect.id,
					idempotencyKey: payload.idempotencyKey,
				};
				return nextRecord(current, {
					inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
					updatedAt: this.#now(),
				});
			});
		});
		if (receipt && key && effect.sessionId) return { key, sessionId: effect.sessionId, receipt };
		await this.#terminalizeRejectedInbound(effect.id);
		return undefined;
	}

	async #terminalizeRejectedInbound(effectId: string): Promise<void> {
		await this.#journal.terminalize(effectId, { status: "rejected" });
	}

	async #finishDispatch(
		claim: { key: string; endpoint: SessionAttachment; sessionId: string; receipt: SlackInboundDispatchReceipt },
		state: "terminal" | "uncertain",
	): Promise<void> {
		await this.#journal.withSessionMutationGate(claim.sessionId, async () => {
			await this.store.transact(claim.key, current => {
				if (!current || !acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation))
					return current;
				const found = (current.inboundDispatches ?? []).find(receipt =>
					this.#sameInboundReceipt(receipt, claim.receipt),
				);
				return found ? this.#completeInboundDispatch(current, found, state === "terminal") : current;
			});
		});
	}

	async #releaseDispatch(claim: {
		key: string;
		endpoint: SessionAttachment;
		sessionId: string;
		receipt: SlackInboundDispatchReceipt;
	}): Promise<void> {
		await this.#journal.withSessionMutationGate(claim.sessionId, async () => {
			await this.store.transact(claim.key, current => {
				if (!current || !acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation))
					return current;
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
		await this.#journal.withSessionMutationGate(
			effect.sessionId,
			async () =>
				await this.store.transact(this.#intentKey(effect.sessionId!), current =>
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
				),
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
		await this.#journal.withSessionMutationGate(
			effect.sessionId,
			async () =>
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
				),
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
		await this.#journal.withSessionMutationGate(
			effect.sessionId,
			async () =>
				await this.store.transact(this.#intentKey(effect.sessionId!), current =>
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
				),
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
		await this.#journal.withSessionMutationGate(
			effect.sessionId,
			async () =>
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
				),
		);
	}
	async #recordRecoveryFailure(effect: ChatEffect): Promise<void> {
		try {
			if (!effect.sessionId) return;
			const found = await this.findSession(effect.sessionId, true);
			if (!found) return;
			await this.#journal.withSessionMutationGate(
				effect.sessionId,
				async () =>
					await this.store.transact(found.key, current => {
						if (!current || current.sessionId !== effect.sessionId) return current;
						return nextRecord(current, { lastError: "recovery_failure", updatedAt: this.#now() });
					}),
			);
		} catch {
			// Diagnostics must never remove the durable recovery trigger.
		}
	}

	async #drainProviderEffects(): Promise<boolean> {
		let failed = false;
		for (const listedEffect of await this.#journal.list()) {
			let effect = listedEffect;
			try {
				if (effect.kind !== "provider-post" || effect.state === "terminal") continue;
				let current = !!effect.sessionId && (await this.#providerEffectCurrent(effect));
				if (!current && effect.sessionId) {
					const migrated = await this.#journal.read(effect.id);
					if (migrated && migrated.state !== "terminal") {
						effect = migrated;
						current = await this.#providerEffectCurrent(effect);
					}
				}
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
					attachmentAuthorityId?: unknown;
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
					...(typeof payload.attachmentAuthorityId === "string"
						? { attachmentAuthorityId: payload.attachmentAuthorityId }
						: {}),
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
		if (!effect.id.startsWith("close-marker-cleanup:")) {
			const endpoint = await this.#resolveAttachment(effect.sessionId);
			const payload = effect.payload as { attachmentAuthorityId?: unknown; threadTs?: unknown };
			const attachmentAuthorityId =
				typeof payload.attachmentAuthorityId === "string" ? payload.attachmentAuthorityId : undefined;
			if (
				!endpoint ||
				endpoint.generation !== effect.endpointGeneration ||
				!attachmentAcceptsAuthority(endpoint, attachmentAuthorityId)
			)
				return false;
		}
		const payload = effect.payload as { attachmentAuthorityId?: unknown; threadTs?: unknown };
		const threadTs = payload.threadTs;
		const records = Object.values((await this.store.load()).conversations);
		if (typeof threadTs === "string") {
			return records.some(
				record =>
					record.sessionId === effect.sessionId &&
					acceptsSlackInbound(record, threadTs, effect.endpointGeneration) &&
					recordAcceptsAuthority(
						record,
						typeof payload.attachmentAuthorityId === "string" ? payload.attachmentAuthorityId : undefined,
					),
			);
		}
		return records.some(
			record =>
				record.sessionId === effect.sessionId &&
				record.endpointGeneration === effect.endpointGeneration &&
				recordAcceptsAuthority(
					record,
					typeof payload.attachmentAuthorityId === "string" ? payload.attachmentAuthorityId : undefined,
				) &&
				record.state === "posting_root",
		);
	}

	/**
	 * Reuse one provider identity while its outcome is pending or uncertain. Only a
	 * terminal definite refusal advances to a fresh attempt identity, so safe retries
	 * remain possible without turning an ambiguous acknowledgement into a duplicate.
	 */
	async #publicationAttempt(
		baseId: string,
		effectIdForClientMsgId: (clientMsgId: string) => string,
	): Promise<{ effectId: string; clientMsgId: string }> {
		for (let attempt = 1; attempt <= MAX_TERMINAL_CHAT_EFFECTS + 1; attempt++) {
			const occurrenceId = attempt === 1 ? baseId : `${baseId}:retry:${attempt}`;
			const clientMsgId = slackPublicationClientMsgId(occurrenceId);
			const effectId = effectIdForClientMsgId(clientMsgId);
			const existing = await this.#journal.read(effectId);
			if (existing?.state !== "terminal" || existing.receipt?.status === "posted") return { effectId, clientMsgId };
		}
		throw new Error("Slack publication exhausted its retained definite-failure identities");
	}
	async #providerEffectPayload(
		id: string,
		sessionId: string,
		endpointGeneration: number,
		expected: {
			channel: string;
			text: string;
			threadTs?: string;
			clientMsgId: string;
			attachmentAuthorityId?: string;
		},
		migrationFromAuthorityId?: string,
	): Promise<{
		payload: typeof expected & { attachmentAuthorityId?: string };
		existed: boolean;
	}> {
		const durableExpected = { ...expected };
		const existing = await this.#journal.read<typeof durableExpected>(id);
		if (!existing) return { payload: durableExpected, existed: false };
		const payload = existing.payload;
		if (
			existing.kind !== "provider-post" ||
			existing.transport !== "slack" ||
			existing.sessionId !== sessionId ||
			existing.endpointGeneration !== endpointGeneration ||
			(payload.attachmentAuthorityId !== durableExpected.attachmentAuthorityId &&
				(migrationFromAuthorityId === undefined || payload.attachmentAuthorityId !== migrationFromAuthorityId)) ||
			typeof payload.channel !== "string" ||
			typeof payload.text !== "string" ||
			typeof payload.clientMsgId !== "string" ||
			(payload.threadTs !== undefined && typeof payload.threadTs !== "string") ||
			payload.channel !== durableExpected.channel ||
			payload.threadTs !== durableExpected.threadTs ||
			payload.clientMsgId !== durableExpected.clientMsgId
		) {
			throw new SlackEndpointBindingError("Slack provider effect identity does not match the durable occurrence.");
		}
		return { payload, existed: true };
	}

	async #postDurable(
		id: string,
		sessionId: string,
		endpointGeneration: number,
		payload: {
			channel: string;
			text: string;
			threadTs?: string;
			clientMsgId: string;
			attachmentAuthorityId?: string;
		},
	): Promise<SlackPostedMessage> {
		if (!Number.isSafeInteger(endpointGeneration) || endpointGeneration <= 0)
			throw new SlackEndpointBindingError("Slack provider effects require a positive endpoint generation.");
		const workGeneration = this.#workGeneration;
		let durablePayload = payload;
		let initial!: ChatEffect<typeof payload>;
		await this.#journal.withSessionMutationGate(sessionId, async () => {
			const mapping = Object.values((await this.store.load()).conversations).find(
				candidate => candidate.sessionId === sessionId && candidate.endpointGeneration === endpointGeneration,
			);
			const durable = await this.#providerEffectPayload(
				id,
				sessionId,
				endpointGeneration,
				payload,
				mapping?.attachmentAuthorityMigrationFromId,
			);
			durablePayload = durable.payload;
			initial = await this.#rescheduleAfterEffectTransition(
				this.#journal.enqueueWhileHoldingSessionMutationGate({
					id,
					kind: "provider-post",
					transport: "slack",
					sessionId,
					endpointGeneration,
					payload: durablePayload,
				}),
			);
		});
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
		const workScope: SlackProviderWorkScope = {
			sessionId,
			endpointGeneration,
			...(durablePayload.attachmentAuthorityId === undefined
				? {}
				: { attachmentAuthorityId: durablePayload.attachmentAuthorityId }),
		};
		// A recovered lease may have crossed the provider boundary before its owner
		// died, and a fresh post may have reached Slack at a now-superseded generation.
		// Reconcile first in all cases. Only an effect that may have crossed the
		// provider boundary is terminalized after an absent reconciliation; a stale
		// pending effect remains nonterminal for recovery.
		const requiresReconciliation =
			initial.state === "accepted" || initial.state === "uncertain" || initial.state === "leased";
		try {
			const posted = await this.#withEffectLease(
				id,
				lease,
				workScope,
				async signal => {
					const found = await this.options.provider.findMessageByClientMsgId({
						channel: effect!.payload.channel,
						threadTs: effect!.payload.threadTs,
						clientMsgId: effect!.payload.clientMsgId,
						signal,
					});
					if (found) return found;
					if (workGeneration !== this.#workGeneration)
						throw new Error(`Slack effect ${id} lost its shutdown fence`);
					if (!(await this.#providerEffectCurrent(effect!))) {
						if (requiresReconciliation) throw new SlackReconciledAbsentEffectError();
						throw new SlackStaleEffectError();
					}
					if (workGeneration !== this.#workGeneration)
						throw new Error(`Slack effect ${id} lost its shutdown fence`);
					return await this.options.provider.postMessage({ ...effect!.payload, signal });
				},
				workGeneration,
			);

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
						workScope,
						async signal =>
							await this.options.provider.findMessageByClientMsgId({
								channel: effect!.payload.channel,
								threadTs: effect!.payload.threadTs,
								clientMsgId: effect!.payload.clientMsgId,
								signal,
							}),
						workGeneration,
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
			const current = await this.store.read(key);
			if (current?.sessionId)
				await this.#journal.withSessionMutationGate(current.sessionId, async () => {
					await this.store.transact(key, candidate => {
						if (
							!candidate ||
							candidate.clientMsgId !== clientMsgId ||
							candidate.rootPublicationOwner !== this.#publicationOwnerId ||
							candidate.rootPublicationFence !== fence
						)
							return candidate;
						renewed = true;
						return nextRecord(candidate, {
							rootPublicationLeaseExpiresAt: this.#now() + this.#publicationLeaseMs,
							updatedAt: this.#now(),
						});
					});
				});
			if (!renewed) throw new Error("Slack root publication lease renewal failed");
		});
	}

	async #withActionLease<T>(key: string, clientMsgId: string, fence: number, operation: () => Promise<T>): Promise<T> {
		return await this.#withPublicationLease(operation, async () => {
			let renewed = false;
			const current = await this.store.read(key);
			if (current?.sessionId)
				await this.#journal.withSessionMutationGate(current.sessionId, async () => {
					await this.store.transact(key, candidate => {
						if (
							!candidate ||
							candidate.outboundActionClientMsgId !== clientMsgId ||
							candidate.outboundActionOwner !== this.#publicationOwnerId ||
							candidate.outboundActionFence !== fence
						)
							return candidate;
						renewed = true;
						return nextRecord(candidate, {
							outboundActionLeaseExpiresAt: this.#now() + this.#publicationLeaseMs,
							updatedAt: this.#now(),
						});
					});
				});
			if (!renewed) throw new Error("Slack action publication lease renewal failed");
		});
	}

	async #withPublicationLease<T>(operation: () => Promise<T>, renew: () => Promise<void>): Promise<T> {
		const workGeneration = this.#workGeneration;
		const fencedRenew = async (): Promise<void> => {
			if (workGeneration !== this.#workGeneration) throw new Error("Slack publication lost its shutdown fence");
			await renew();
			if (workGeneration !== this.#workGeneration) throw new Error("Slack publication lost its shutdown fence");
		};
		const result = await this.#withRenewal(async () => {
			if (workGeneration !== this.#workGeneration) throw new Error("Slack publication lost its shutdown fence");
			return await operation();
		}, fencedRenew);
		if (workGeneration !== this.#workGeneration) throw new Error("Slack publication lost its shutdown fence");
		return result;
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
						attachmentAuthorityId?: unknown;
				  }>
				| undefined = await this.#journal.read(`root:${current.sessionId}:${clientMsgId}`);
			if (effect?.state === "terminal") {
				await this.#reconcileTerminalProviderReceipts();
				await Bun.sleep(10);
				continue;
			}
			const payload:
				| {
						channel?: unknown;
						text?: unknown;
						threadTs?: unknown;
						clientMsgId?: unknown;
						attachmentAuthorityId?: unknown;
				  }
				| undefined = effect?.payload;
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
						...(typeof effect.payload.attachmentAuthorityId === "string"
							? { attachmentAuthorityId: effect.payload.attachmentAuthorityId }
							: {}),
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
		if (error instanceof SessionRouterError) return error.phase === "pre_send";
		if (error instanceof SdkClientError) return error.code === "connection_closed";
		return (
			error instanceof Error &&
			error.name === "ChatDeliveryError" &&
			(error as ChatDeliveryError).phase === "pre_send"
		);
	}
}
