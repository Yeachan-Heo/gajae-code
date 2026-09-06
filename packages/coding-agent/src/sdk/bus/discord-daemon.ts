import { createHash, randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import { SdkClientError } from "../client/client";
import { type SessionAttachment, SessionRouterError } from "../router";
import type { ChatDeliveryError } from "./chat-daemon-runtime";

import {
	type ChatEffect,
	ChatEffectJournal,
	type ChatEffectLease,
	type ChatEffectReceipt,
} from "./chat-effect-journal";
import { ConversationStore } from "./conversation-store";

import {
	type DiscordConversation,
	type DiscordInboundDispatchReceipt,
	discordConversationKey,
	normalizeDiscordConversation,
} from "./discord-conversation";
import type { DiscordInboundEvent, DiscordMessageComponent, DiscordProvider, DiscordThread } from "./discord-provider";

const FAILURE = "This conversation is no longer available.";

export class DiscordAttachmentBindingError extends Error {
	constructor(message = "Discord session attachment changed before outbound publication.") {
		super(message);
		this.name = "DiscordAttachmentBindingError";
	}
}

type DiscordClosingIntent = Readonly<{ nonce: string; at: number }>;

function closingIntent(record: DiscordConversation | undefined): DiscordClosingIntent | undefined {
	const candidate = record as { state?: unknown; closingNonce?: unknown; closingAt?: unknown } | undefined;
	return candidate?.state === "closing" &&
		typeof candidate.closingNonce === "string" &&
		typeof candidate.closingAt === "number"
		? { nonce: candidate.closingNonce, at: candidate.closingAt }
		: undefined;
}

function withClosingIntent(record: DiscordConversation, nonce: string, at: number): DiscordConversation {
	return {
		...record,
		generation: record.generation + 1,
		state: "closing",
		closingNonce: nonce,
		closingAt: at,
		pendingActionId: undefined,
		pendingActionNonce: undefined,
		pendingActionEffectId: undefined,
	} as unknown as DiscordConversation;
}

function withoutClosingIntent(record: DiscordConversation, closedAt: number): DiscordConversation {
	const {
		closingNonce: _closingNonce,
		closingAt: _closingAt,
		...rest
	} = record as DiscordConversation & {
		closingNonce?: unknown;
		closingAt?: unknown;
	};
	return {
		...rest,
		generation: record.generation + 1,
		state: "closed",
		closedAt,
		pendingActionId: undefined,
		pendingActionNonce: undefined,
		pendingActionEffectId: undefined,
	};
}

export interface DiscordLeaseRecoveryScheduler {
	setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface DiscordNotificationDaemonOptions {
	agentDir: string;
	guildId: string;
	parentChannelId: string;
	provider: DiscordProvider;
	now?: () => number;
	leaseRecoveryScheduler?: DiscordLeaseRecoveryScheduler;
	resolveAttachment: (
		sessionId: string,
		expectedGeneration?: number,
	) => SessionAttachment | null | Promise<SessionAttachment | null>;
	onCommand?: (
		sessionId: string,
		content: string,
		attachment: SessionAttachment,
		idempotencyKey: string,
	) => Promise<boolean>;
}

export interface DiscordNotificationInput {
	sessionId: string;
	endpointGeneration: number;
	attachmentAuthorityId?: string;
	content: string;
	threadName?: string;
	actionId?: string;
	options?: string[];
	publicationId?: string;
}

type DiscordInboundEffectPayload =
	| {
			type: "command";
			content: string;
			idempotencyKey: string;
			routing: DiscordInboundRouting;
	  }
	| {
			type: "reply";
			id: string;
			answer: string | number;
			idempotencyKey: string;
			routing: DiscordInboundRouting;
	  };

type DiscordInboundRouting = {
	guildId: string;
	parentId: string;
	threadId: string;
	eventId: string;
	attachmentAuthorityId?: string;
	interactionId?: string;
	kind: "command" | "action";
	actionId?: string;
	actionNonce?: string;
};

function backfilledEffectIncarnationId(record: DiscordConversation): string {
	if (record.effectIncarnationId) return record.effectIncarnationId;
	if (record.createNonce) return record.createNonce;
	return `legacy-${createHash("sha256")
		.update(
			[record.appId, record.guildId, record.parentChannelId, record.threadId ?? "", record.sessionId ?? ""].join(
				"\u0000",
			),
		)
		.digest("hex")
		.slice(0, 32)}`;
}

type DiscordInboundClaim = {
	record: DiscordConversation;
	receipt: DiscordInboundDispatchReceipt;
	liveCallbackEffect?: ChatEffect<DiscordInboundEffectPayload>;
};

type DiscordInboundSnapshot = {
	record: DiscordConversation;
	receipt: DiscordInboundDispatchReceipt;
	effect: ChatEffect<DiscordInboundEffectPayload>;
};

function attachmentAcceptsAuthority(attachment: SessionAttachment, authorityId: string | undefined): boolean {
	return (
		attachment.authorityId === authorityId ||
		(attachment.legacyAuthorityId !== undefined && attachment.legacyAuthorityId === authorityId)
	);
}

function recordAcceptsAuthority(record: DiscordConversation, authorityId: string | undefined): boolean {
	return (
		record.attachmentAuthorityId === authorityId ||
		(record.attachmentAuthorityMigrationFromId !== undefined &&
			record.attachmentAuthorityMigrationFromId === authorityId)
	);
}

/** SDK-only Discord threaded notification daemon. It owns no AgentSession and never retains endpoint credentials. */
export class DiscordNotificationDaemon {
	readonly #store: ConversationStore<DiscordConversation>;
	readonly #now: () => number;
	readonly #leaseRecoveryScheduler: DiscordLeaseRecoveryScheduler;
	readonly #creates = new Map<string, Promise<DiscordConversation>>();
	readonly #resumes = new Map<string, Promise<DiscordConversation | undefined>>();
	readonly #archives = new Map<string, Promise<void>>();
	readonly #resolveAttachment: (
		sessionId: string,
		expectedGeneration?: number,
	) => SessionAttachment | null | Promise<SessionAttachment | null>;
	readonly #effects: ChatEffectJournal;
	readonly #activeWork = new Map<Promise<unknown>, string | undefined>();
	readonly #workInvalidators = new Set<() => Promise<void>>();
	readonly #sessionInvalidators = new Map<string, Set<() => Promise<void>>>();
	readonly #inflightInbound = new Set<string>();
	#started = false;
	#lifecycleGeneration = 0;
	#workGeneration = 0;
	#startTask: Promise<void> | undefined;
	#stopTask: Promise<void> | undefined;
	#providerStarting = false;
	#providerLifecycleTail: Promise<void> | undefined;
	#providerLifecycleError: unknown;
	#providerLifecycleErrorSet = false;

	#leaseRecoveryTimer: unknown;
	#leaseRecoveryAt: number | undefined;
	#leaseRecoveryFailures = 0;

	readonly #dispatchOwner = randomUUID();
	readonly #dispatchLeaseMs = 60_000;
	readonly #providerOwner = randomUUID();
	readonly #providerLeaseMs = 60_000;
	readonly #migratedAttachmentAuthorities = new Set<string>();
	constructor(private readonly options: DiscordNotificationDaemonOptions) {
		this.#store = new ConversationStore({ agentDir: options.agentDir, kind: "discord", now: options.now });
		this.#effects = new ChatEffectJournal({ agentDir: options.agentDir, transport: "discord", now: options.now });
		this.#now = options.now ?? Date.now;
		this.#leaseRecoveryScheduler = options.leaseRecoveryScheduler ?? {
			setTimeout: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
			clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.#resolveAttachment = async (sessionId, expectedGeneration) => {
			const attachment = await options.resolveAttachment(sessionId, expectedGeneration);
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
		if (this.#started && !this.#stopTask) return;
		if (this.#providerLifecycleErrorSet) throw this.#providerLifecycleError;
		if (this.#providerLifecycleTail) {
			const tail = this.#providerLifecycleTail;
			const settled = await Promise.race([
				Promise.allSettled([tail]).then(() => true),
				Bun.sleep(5_000).then(() => false),
			]);
			if (!settled) throw new Error("Prior Discord provider shutdown did not settle before restart.");
			try {
				await tail;
			} catch (error) {
				this.#recordProviderLifecycleError(error);
				throw error;
			}
			if (this.#providerLifecycleTail === tail) this.#providerLifecycleTail = undefined;
		}
		if (this.#stopTask) {
			await this.#stopTask;
			return await this.start();
		}
		if (this.#startTask) return await this.#startTask;

		const lifecycleGeneration = ++this.#lifecycleGeneration;
		const task = this.#start(lifecycleGeneration);
		this.#startTask = task;
		try {
			await task;
		} finally {
			if (this.#startTask === task) this.#startTask = undefined;
		}
	}

	async #start(lifecycleGeneration: number): Promise<void> {
		try {
			// Provider start is the delivery boundary; complete crash recovery first.
			await this.#reconcileTerminalInboundReceipts();
			const closingBeforeProviderRecoveryFailed = await this.#recoverClosingConversations();
			const providerRecoveryFailed = await this.#drainProviderEffects();
			await this.#reconcileTerminalInboundReceipts();
			const closingAfterProviderRecoveryFailed = await this.#recoverClosingConversations();
			const inboundRecoveryFailed = await this.#drainPendingDispatches();
			const recoveryFailed =
				closingBeforeProviderRecoveryFailed ||
				providerRecoveryFailed ||
				closingAfterProviderRecoveryFailed ||
				inboundRecoveryFailed;
			if (lifecycleGeneration !== this.#lifecycleGeneration) return;

			this.#started = true;
			await this.#scheduleLeaseRecovery(recoveryFailed);
			// stop() invalidates this generation before awaiting recovery or start. This
			// guard is immediately adjacent to the Gateway-open boundary.
			if (lifecycleGeneration !== this.#lifecycleGeneration) {
				this.#started = false;
				return;
			}
			this.#providerStarting = true;
			try {
				await this.options.provider.start(
					async event => {
						if (lifecycleGeneration !== this.#lifecycleGeneration || !this.#started) return;
						const record = await this.#byThread(event.guildId, event.parentId, event.threadId);
						await this.#track(this.handleInbound(event), record?.sessionId);
					},
					() => {},
				);
			} finally {
				this.#providerStarting = false;
			}
			if (lifecycleGeneration !== this.#lifecycleGeneration) {
				this.#started = false;
				try {
					await this.options.provider.stop();
				} catch (error) {
					this.#recordProviderLifecycleError(error);
					throw error;
				}
			}
		} catch (error) {
			if (lifecycleGeneration === this.#lifecycleGeneration) {
				this.#started = false;
				if (this.#leaseRecoveryTimer !== undefined)
					this.#leaseRecoveryScheduler.clearTimeout(this.#leaseRecoveryTimer);
				this.#leaseRecoveryTimer = undefined;
				this.#leaseRecoveryAt = undefined;
			}
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.#stopTask) return await this.#stopTask;

		const starting = this.#startTask;
		const stopProvider = this.#started || this.#providerStarting;
		++this.#lifecycleGeneration;
		this.#started = false;
		if (this.#leaseRecoveryTimer !== undefined) this.#leaseRecoveryScheduler.clearTimeout(this.#leaseRecoveryTimer);
		this.#leaseRecoveryTimer = undefined;
		this.#leaseRecoveryAt = undefined;

		const task = this.#stop(starting, stopProvider);
		this.#stopTask = task;
		try {
			await task;
		} finally {
			if (this.#stopTask === task) this.#stopTask = undefined;
		}
	}

	async #stop(starting: Promise<void> | undefined, stopProvider: boolean): Promise<void> {
		const drainDeadline = this.#now() + 5_000;
		let providerStopError: unknown;
		let providerStopRejected = false;
		const providerLifecycle = (async () => {
			// Calling provider.stop() before awaiting start lets a provider cancel a
			// Gateway open that is already in flight. #start rechecks the generation
			// after it resolves and closes any late open.
			if (stopProvider) {
				try {
					await this.options.provider.stop();
				} catch (error) {
					providerStopRejected = true;
					providerStopError = error;
				}
			}
			try {
				await starting;
			} catch {
				// The caller of start() owns its recovery/start error; stop still drains it.
			}
			if (this.#providerStarting || this.#started) {
				this.#started = false;
				try {
					await this.options.provider.stop();
				} catch (error) {
					providerStopRejected = true;
					providerStopError ??= error;
				}
			}
			if (providerStopRejected) throw providerStopError;
		})();
		const providerOutcome = await Promise.race([
			providerLifecycle.then(
				() => ({ kind: "settled" as const }),
				error => ({ kind: "rejected" as const, error }),
			),
			Bun.sleep(Math.max(0, drainDeadline - this.#now())).then(() => ({ kind: "timeout" as const })),
		]);
		if (providerOutcome.kind === "rejected") {
			this.#recordProviderLifecycleError(providerOutcome.error);
			await this.#invalidateActiveWork();
			await this.#drainActiveWork(drainDeadline);
			throw providerOutcome.error;
		}
		if (providerOutcome.kind === "timeout") {
			this.#retainProviderLifecycle(providerLifecycle);
			await this.#invalidateActiveWork();
			await this.#drainActiveWork(drainDeadline);
			logger.warn(
				"Discord provider lifecycle exceeded the 5000ms shutdown drain; continuing with Router revocation.",
			);
			return;
		}
		// Drain until quiescent, but never let a hung provider REST request prevent
		// SessionRouter authority revocation and daemon ownership release.
		await this.#drainActiveWork(drainDeadline);
	}

	async #invalidateActiveWork(): Promise<void> {
		this.#workGeneration += 1;
		await Promise.allSettled([...this.#workInvalidators].map(invalidate => invalidate()));
	}
	async #invalidateSessionWork(sessionId: string): Promise<void> {
		await Promise.allSettled([...(this.#sessionInvalidators.get(sessionId) ?? [])].map(invalidate => invalidate()));
	}

	async #drainActiveWork(deadline: number): Promise<void> {
		while (this.#activeWork.size > 0) {
			const remaining = deadline - this.#now();
			if (remaining <= 0) {
				await this.#invalidateActiveWork();
				logger.warn("Discord provider work exceeded the 5000ms shutdown drain; continuing with Router revocation.");
				return;
			}
			const settled = await Promise.race([
				Promise.allSettled([...this.#activeWork.keys()]).then(() => true),
				Bun.sleep(remaining).then(() => false),
			]);
			if (!settled) {
				await this.#invalidateActiveWork();
				logger.warn("Discord provider work exceeded the 5000ms shutdown drain; continuing with Router revocation.");
				return;
			}
		}
	}
	async #drainSessionWork(sessionId: string, deadline: number): Promise<void> {
		while (true) {
			const work = [...this.#activeWork.entries()]
				.filter(([, activeSessionId]) => activeSessionId === sessionId)
				.map(([promise]) => promise);
			if (work.length === 0) return;
			const remaining = deadline - this.#now();
			if (remaining <= 0) return;
			await Promise.race([Promise.allSettled(work), Bun.sleep(remaining)]);
		}
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

	/**
	 * Frame-driven publication work is tracked like inbound events so that stop()
	 * drains it while the Router still holds attachment authority. A session
	 * replayed during teardown otherwise reaches its post-provider binding
	 * revalidation only after Router.stop() has revoked the attachment, turning a
	 * legitimate create into a spurious teardown rejection.
	 */
	async notify(input: DiscordNotificationInput): Promise<DiscordConversation> {
		return await this.#track(this.#notify(input), input.sessionId);
	}
	async #notify(input: DiscordNotificationInput): Promise<DiscordConversation> {
		await this.#requireLiveBinding(input.sessionId, input.endpointGeneration, input.attachmentAuthorityId);
		const conversation = await this.#ensureConversation(input);
		await this.#requireLiveBinding(input.sessionId, input.endpointGeneration, input.attachmentAuthorityId);
		if (conversation.state !== "active" || !conversation.threadId) throw new Error("Discord thread is unavailable");
		const pendingActionId = input.actionId;
		const authoritative = pendingActionId
			? await this.#ensureActionPublication(conversation, pendingActionId)
			: conversation;
		await this.#requireLiveBinding(input.sessionId, input.endpointGeneration, input.attachmentAuthorityId);
		const components =
			pendingActionId && authoritative.pendingActionNonce && input.options && input.options.length > 0
				? actionComponents(
						authoritative.endpointGeneration!,
						pendingActionId,
						authoritative.pendingActionNonce,
						input.options,
					)
				: undefined;

		// The durable action publication intent, rather than this notification call,
		// owns the provider-visible effect identity. This makes retries reconcile the
		// original post and preserves the original component route.
		const effectId = pendingActionId
			? authoritative.pendingActionEffectId!
			: `notification:${authoritative.threadId}:${input.publicationId ?? randomUUID()}`;
		await this.#postEffect(effectId, authoritative, input.content, components, pendingActionId !== undefined);

		return authoritative;
	}

	/** Migrate pre-device-binding mapping and effect authority after Router proof. */
	async migrateAttachmentAuthority(
		sessionId: string,
		endpointGeneration: number,
		previousAuthorityId: string,
		currentAuthorityId: string,
	): Promise<void> {
		if (!previousAuthorityId || !currentAuthorityId || previousAuthorityId === currentAuthorityId) return;
		await this.#effects.withSessionMutationGate(sessionId, async () => {
			const document = await this.#store.load();
			for (const key of Object.keys(document.conversations)) {
				await this.#store.transact(key, current => {
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
					return normalizeDiscordConversation({
						...current,
						generation: current.generation + 1,
						attachmentAuthorityId: currentAuthorityId,
						attachmentAuthorityMigrationFromId: previousAuthorityId,
						updatedAt: this.#now(),
					});
				});
			}
			await this.#effects.migrateAttachmentAuthorityIdWhileHoldingGate(
				sessionId,
				endpointGeneration,
				previousAuthorityId,
				currentAuthorityId,
			);
			for (const key of Object.keys(document.conversations)) {
				await this.#store.transact(key, current => {
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
					return normalizeDiscordConversation({
						...current,
						generation: current.generation + 1,
						attachmentAuthorityMigrationFromId: undefined,
						...(inboundDispatches === undefined ? {} : { inboundDispatches }),
						updatedAt: this.#now(),
					});
				});
			}
		});
	}

	/** Posts a safe command outcome to the active mapped conversation. */
	async postCommandResult(sessionId: string, content: string): Promise<boolean> {
		return await this.#track(this.#postCommandResult(sessionId, content), sessionId);
	}
	async #postCommandResult(sessionId: string, content: string): Promise<boolean> {
		const record = await this.#bySession(sessionId);
		if (record?.state !== "active" || !record.threadId) return false;
		await this.#postEffect(`command-result:${record.threadId}:${randomUUID()}`, record, content);
		return true;
	}

	async close(sessionId: string, endpointGeneration?: number): Promise<void> {
		const closing = await this.#markClosing(sessionId, endpointGeneration);
		if (closing) await this.#driveClose(closing);
	}

	async recoverCleanup(
		sessionId: string,
		endpointGeneration: number,
		authorityId?: string,
		legacyAuthorityId?: string,
	): Promise<boolean> {
		const record = await this.#bySession(sessionId);
		if (record?.endpointGeneration !== endpointGeneration) return true;
		if (record?.state === "closed" || record?.state === "archived" || record?.state === "resuming") return true;
		if (
			!closingIntent(record) &&
			record?.state === "active" &&
			(record.attachmentAuthorityId === authorityId ||
				(legacyAuthorityId !== undefined && record.attachmentAuthorityId === legacyAuthorityId))
		)
			return true;
		if (!closingIntent(record)) return false;
		await this.#driveClose(record);
		return true;
	}

	async retireAttachment(sessionId: string, endpointGeneration: number): Promise<void> {
		await this.#invalidateSessionWork(sessionId);
		const intentKey = this.#intentKey(sessionId);
		const now = this.#now();
		const record = await this.#effects.withSessionMutationGate(sessionId, async () => {
			await this.#store.transact(intentKey, current => {
				if (
					current?.state !== "creating" ||
					current.sessionId !== sessionId ||
					current.endpointGeneration !== endpointGeneration
				)
					return current;
				return normalizeDiscordConversation({
					...current,
					generation: current.generation + 1,
					state: "closed",
					createNonce: undefined,
					createOwner: undefined,
					createLeaseExpiresAt: undefined,
					closedAt: now,
					updatedAt: now,
				});
			});
			return await this.#bySession(sessionId);
		});
		if (!record?.threadId || record.endpointGeneration !== endpointGeneration) return;
		await this.#drainSessionWork(sessionId, this.#now() + 5_000);
		for (const receipt of record.inboundDispatches ?? [])
			await this.#terminalizeInbound(record, receipt, "stale_binding");
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId,
		});
		await this.#effects.withSessionMutationGate(sessionId, async () => {
			await this.#store.transact(key, current =>
				current?.sessionId === sessionId && current.endpointGeneration === endpointGeneration
					? withoutClosingIntent(current, now)
					: current,
			);
		});
	}

	async archive(sessionId: string): Promise<void> {
		const running = this.#archives.get(sessionId);
		if (running) return await running;
		const task = this.#archive(sessionId);
		this.#archives.set(sessionId, task);
		try {
			await task;
		} finally {
			this.#archives.delete(sessionId);
		}
	}

	async #archive(sessionId: string): Promise<void> {
		const record = await this.#bySession(sessionId);
		if (!record?.threadId || record.state !== "active") return;
		await this.#requireLiveBinding(record.sessionId!, record.endpointGeneration!, record.attachmentAuthorityId);
		const archiving = await this.#beginArchive(record);
		const occurrenceId = archiving.archiveOccurrenceId;
		if (!occurrenceId || !archiving.archiveEffectId) throw new Error("Discord archive occurrence is unavailable");
		await this.#threadEffect(archiving.archiveEffectId, archiving, "archive", false, false, occurrenceId);
		await this.#requireLiveBinding(
			archiving.sessionId!,
			archiving.endpointGeneration!,
			archiving.attachmentAuthorityId,
		);
		await this.#completeArchive(archiving, occurrenceId);
	}

	async resume(
		sessionId: string,
		endpointGeneration: number,
		attachmentAuthorityId?: string,
	): Promise<DiscordConversation | undefined> {
		return await this.#track(this.#resumeAdmission(sessionId, endpointGeneration, attachmentAuthorityId), sessionId);
	}
	async #resumeAdmission(
		sessionId: string,
		endpointGeneration: number,
		attachmentAuthorityId?: string,
	): Promise<DiscordConversation | undefined> {
		const running = this.#resumes.get(sessionId);
		if (running) return await running;
		const task = this.#resume(sessionId, endpointGeneration, attachmentAuthorityId);
		this.#resumes.set(sessionId, task);
		try {
			return await task;
		} finally {
			this.#resumes.delete(sessionId);
		}
	}

	async #resume(
		sessionId: string,
		endpointGeneration: number,
		attachmentAuthorityId?: string,
	): Promise<DiscordConversation | undefined> {
		let record = await this.#bySession(sessionId);
		if (!record?.threadId || record.state === "closed") return undefined;
		if (
			attachmentAuthorityId !== undefined &&
			!(await this.#mappingAuthorityCurrent(record, endpointGeneration, attachmentAuthorityId))
		) {
			await this.retireAttachment(sessionId, record.endpointGeneration ?? endpointGeneration);
			return undefined;
		}
		if (closingIntent(record)) {
			await this.#driveClose(record);
			return undefined;
		}
		await this.#requireLiveBinding(sessionId, endpointGeneration, attachmentAuthorityId);
		const current = await this.#bySession(sessionId);
		if (
			!current?.threadId ||
			current.threadId !== record.threadId ||
			current.state !== record.state ||
			current.endpointGeneration !== record.endpointGeneration ||
			!recordAcceptsAuthority(current, attachmentAuthorityId)
		)
			return undefined;
		record = current;
		const resumeOccurrenceId = randomUUID();
		const effectIncarnationId = backfilledEffectIncarnationId(record);
		const resuming = await this.#replace(record, {
			...record,
			state: "resuming",
			endpointGeneration,
			attachmentAuthorityId,
			effectIncarnationId,
			resumeOccurrenceId,
			resumeEffectId: `unarchive:${record.threadId}:${effectIncarnationId}:${resumeOccurrenceId}`,
			pendingActionId: undefined,
			pendingActionNonce: undefined,
			pendingActionEffectId: undefined,
		});
		try {
			const occurrenceId = resuming.resumeOccurrenceId;
			if (!occurrenceId || !resuming.resumeEffectId) throw new Error("Discord resume occurrence is unavailable");
			await this.#threadEffect(resuming.resumeEffectId, resuming, "unarchive", false, false, occurrenceId);
			await this.#requireLiveBinding(sessionId, endpointGeneration, attachmentAuthorityId);
			return await this.#completeResume(resuming, occurrenceId);
		} catch {
			await this.#requireLiveBinding(sessionId, endpointGeneration, attachmentAuthorityId);
			const superseded = await this.#replace(resuming, {
				...resuming,
				state: "archived",
				resumeOccurrenceId: undefined,
				resumeEffectId: undefined,
				pendingActionId: undefined,
				pendingActionNonce: undefined,
				pendingActionEffectId: undefined,
			});

			const replacement = await this.#create(
				sessionId,
				endpointGeneration,
				`resume-${randomUUID()}`,
				undefined,
				attachmentAuthorityId,
			);
			await this.#requireLiveBinding(sessionId, endpointGeneration, attachmentAuthorityId);
			await this.#replace(superseded, { ...superseded, supersededByThreadId: replacement.threadId });
			return replacement;
		}
	}

	async resolveAction(sessionId: string, actionId: string): Promise<void> {
		const record = await this.#bySession(sessionId);
		if (record?.pendingActionId === actionId && record.pendingActionNonce)
			await this.#clearPending(record, actionId, record.pendingActionNonce);
	}

	async handleInbound(event: DiscordInboundEvent): Promise<void> {
		if (event.bot || event.authorId === this.options.provider.botUserId) return;
		await this.#reconcileTerminalInboundReceipts();
		let record = await this.#byThread(event.guildId, event.parentId, event.threadId);
		if (!record?.sessionId) {
			await this.#fail(event.threadId);
			return;
		}
		const claim = await this.#claimInbound(record, event);
		if (claim === "invalid") {
			await this.#fail(event.threadId);
			return;
		}
		if (!claim || this.#inflightInbound.has(claim.receipt.effectId)) return;
		this.#inflightInbound.add(claim.receipt.effectId);
		try {
			record = claim.record;
			let receipt = claim.receipt;
			// Interaction callbacks have a short provider deadline. The mapping and
			// journal claim are sufficient to acknowledge; attachment discovery waits.
			const attachment = event.interaction
				? null
				: await this.#resolveAttachment(record.sessionId!, record.endpointGeneration);
			if (!event.interaction) {
				const postImage = await this.#reloadInboundSnapshot(record, receipt);
				if (!postImage || !this.#matches(postImage.record, attachment)) {
					await this.#fail(event.threadId);
					return;
				}
				record = postImage.record;
				receipt = postImage.receipt;
			}
			if (!event.interaction && !attachment) {
				await this.#fail(event.threadId);
				return;
			}
			await this.#dispatchInbound(record, attachment, receipt, event.interaction, claim.liveCallbackEffect);
		} finally {
			this.#inflightInbound.delete(claim.receipt.effectId);
			await this.#scheduleLeaseRecovery();
		}
	}

	#track<T>(work: Promise<T>, sessionId?: string): Promise<T> {
		this.#activeWork.set(work, sessionId);
		return work.finally(() => this.#activeWork.delete(work));
	}

	async #claimInbound(
		record: DiscordConversation,
		event: DiscordInboundEvent,
	): Promise<DiscordInboundClaim | "invalid" | undefined> {
		if (record.state !== "active" || closingIntent(record)) return "invalid";
		const route = event.interaction ? decodeCustomId(event.interaction.customId) : undefined;
		const command = !event.interaction && event.content?.startsWith("/sdk ");
		if (!command && (!route || !event.interaction)) return "invalid";
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		let receipt: DiscordInboundDispatchReceipt | undefined;
		let valid = false;
		let claimedRecord: DiscordConversation | undefined;
		const effectId = `discord:${record.appId}:${record.guildId}:${record.parentChannelId}:${record.threadId}:${event.id}`;
		const idempotencyKey = effectId;
		let liveCallbackEffect: ChatEffect<DiscordInboundEffectPayload> | undefined;
		await this.#effects.withSessionMutationGate(record.sessionId!, async () => {
			const current = await this.#store.read(key);
			if (
				current?.state !== "active" ||
				closingIntent(current) ||
				current.sessionId !== record.sessionId ||
				current.endpointGeneration !== record.endpointGeneration
			)
				return;
			if (!command && (!route || route.generation !== current.endpointGeneration)) return;
			const desiredRouting: DiscordInboundRouting = {
				guildId: event.guildId,
				parentId: event.parentId,
				threadId: event.threadId,
				eventId: event.id,
				...(current.attachmentAuthorityId === undefined
					? {}
					: { attachmentAuthorityId: current.attachmentAuthorityId }),
				...(event.interaction ? { interactionId: event.interaction.id } : {}),
				kind: command ? "command" : "action",
				...(!command ? { actionId: route!.actionId, actionNonce: route!.actionNonce } : {}),
			};
			const desiredPayload: DiscordInboundEffectPayload = command
				? { type: "command", content: event.content!, idempotencyKey, routing: desiredRouting }
				: {
						type: "reply",
						id: route!.actionId,
						answer: componentAnswer(event.interaction!.value ?? ""),
						idempotencyKey,
						routing: desiredRouting,
					};
			const existingEffect = await this.#effects.read<DiscordInboundEffectPayload>(effectId);
			const payload = existingEffect?.payload ?? desiredPayload;
			const routing = payload.routing;
			claimedRecord = current;
			if (event.interaction) {
				liveCallbackEffect = await this.#rescheduleAfterEffectTransition(
					this.#effects.enqueueAndClaimWhileHoldingSessionMutationGate(
						{
							id: effectId,
							kind: "discord.inbound.action",
							transport: "discord",
							sessionId: current.sessionId,
							endpointGeneration: current.endpointGeneration!,
							payload,
						},
						this.#dispatchOwner,
						this.#dispatchLeaseMs,
					),
				);
			} else {
				await this.#rescheduleAfterEffectTransition(
					this.#effects.enqueueWhileHoldingSessionMutationGate({
						id: effectId,
						kind: "discord.inbound.command",
						transport: "discord",
						sessionId: current.sessionId,
						endpointGeneration: current.endpointGeneration!,
						payload,
					}),
				);
			}

			await this.#store.transact(key, current => {
				if (
					current?.state !== "active" ||
					current.endpointGeneration !== record.endpointGeneration ||
					!recordAcceptsAuthority(current, routing.attachmentAuthorityId)
				)
					return current;
				const interactionId = event.interaction?.id;
				const existing = (current.inboundDispatches ?? []).find(
					item =>
						item.eventId === event.id || (interactionId !== undefined && item.interactionId === interactionId),
				);
				if (existing) {
					valid = true;
					receipt = existing;
					claimedRecord = current;
					return current;
				}
				if (
					!command &&
					(current.pendingActionId !== route!.actionId || current.pendingActionNonce !== route!.actionNonce)
				)
					return current;
				if (
					!command &&
					(current.inboundDispatches ?? []).some(
						item =>
							item.kind === "action" &&
							item.actionId === route!.actionId &&
							item.actionNonce === route!.actionNonce,
					)
				)
					return current;
				valid = true;
				receipt = command
					? {
							key: event.id,
							eventId: event.id,
							kind: "command",
							endpointGeneration: record.endpointGeneration!,
							...(routing.attachmentAuthorityId === undefined
								? {}
								: { attachmentAuthorityId: routing.attachmentAuthorityId }),
							effectId,
							idempotencyKey,
						}
					: {
							key: event.id,
							eventId: event.id,
							interactionId: interactionId!,
							kind: "action",
							actionId: route!.actionId,
							actionNonce: route!.actionNonce,
							endpointGeneration: record.endpointGeneration!,
							...(routing.attachmentAuthorityId === undefined
								? {}
								: { attachmentAuthorityId: routing.attachmentAuthorityId }),
							effectId,
							idempotencyKey,
						};
				claimedRecord = current;
				return normalizeDiscordConversation({
					...current,
					generation: current.generation + 1,
					updatedAt: this.#now(),
					inboundDispatches: [...(current.inboundDispatches ?? []), receipt!],
				});
			});
		});
		if (!valid || !receipt) {
			await this.#terminalizeRejectedInbound(
				effectId,
				liveCallbackEffect ? { owner: this.#dispatchOwner, epoch: liveCallbackEffect.epoch } : undefined,
			);
			return "invalid";
		}
		if (liveCallbackEffect && liveCallbackEffect.id !== receipt.effectId) {
			await this.#terminalizeRejectedInbound(liveCallbackEffect.id, {
				owner: this.#dispatchOwner,
				epoch: liveCallbackEffect.epoch,
			});
			liveCallbackEffect = undefined;
		}
		return { record: claimedRecord ?? record, receipt, liveCallbackEffect };
	}
	async #dispatchInbound(
		record: DiscordConversation,
		initialAttachment: SessionAttachment | null,
		receipt: DiscordInboundDispatchReceipt,
		interaction?: DiscordInboundEvent["interaction"],
		liveCallbackEffect?: ChatEffect<DiscordInboundEffectPayload>,
	): Promise<void> {
		const claimedEffect =
			liveCallbackEffect ??
			(await this.#rescheduleAfterEffectTransition(
				this.#effects.claim<DiscordInboundEffectPayload>(
					receipt.effectId,
					this.#dispatchOwner,
					this.#dispatchLeaseMs,
				),
			));
		if (!claimedEffect) return;
		let effect: ChatEffect<DiscordInboundEffectPayload> = claimedEffect;
		let lease = { owner: this.#dispatchOwner, epoch: effect.epoch };

		let postImage = await this.#reloadInboundSnapshot(record, receipt);
		if (!postImage) {
			await this.#terminalizeInbound(record, receipt, "rejected", lease);

			return;
		}
		record = postImage.record;
		receipt = postImage.receipt;
		effect = postImage.effect;
		if (effect.state !== "leased" || effect.owner !== lease.owner || effect.epoch !== lease.epoch) return;
		if (receipt.kind === "action" && !this.#hasDurableDeferIntent(effect)) {
			// Callback tokens cannot survive a restart. Persist the intent before remote
			// I/O so recovery can safely resume SDK delivery whether defer reached Discord
			// or the process stopped first.
			if (!interaction) {
				await this.#terminalizeInbound(record, receipt, "callback_token_unavailable", lease);

				return;
			}

			let callbackLeaseLost = false;
			let callbackRenewal: Promise<boolean> | undefined;
			const renewCallbackLease = async (): Promise<boolean> => {
				if (callbackLeaseLost) return false;
				if (callbackRenewal) return await callbackRenewal;
				const renewal = (async (): Promise<boolean> => {
					if (
						!(await this.#rescheduleAfterEffectTransition(
							this.#effects.renew(effect.id, lease, this.#dispatchLeaseMs),
						))
					)
						callbackLeaseLost = true;
					return !callbackLeaseLost;
				})();
				callbackRenewal = renewal;
				try {
					return await renewal;
				} finally {
					if (callbackRenewal === renewal) callbackRenewal = undefined;
				}
			};
			const timer = setInterval(
				() => {
					void renewCallbackLease().catch(() => {});
				},
				Math.max(1, Math.floor(this.#dispatchLeaseMs / 3)),
			);
			try {
				if (!(await renewCallbackLease())) return;
				const prepared = await this.#rescheduleAfterEffectTransition(
					this.#effects.recordReceipt<DiscordInboundEffectPayload>(effect.id, lease, { status: "defer_intent" }),
				);
				if (!prepared) return;
				effect = prepared;
				if (!(await renewCallbackLease())) return;
				await this.options.provider.deferInteraction({ id: interaction.id, token: interaction.token });
				if (!(await renewCallbackLease())) return;
				const deferred = await this.#rescheduleAfterEffectTransition(
					this.#effects.record(effect.id, lease, "accepted", { status: "deferred" }),
				);
				if (!deferred) return;
				const reclaimed = await this.#rescheduleAfterEffectTransition(
					this.#effects.claim<DiscordInboundEffectPayload>(effect.id, this.#dispatchOwner, this.#dispatchLeaseMs),
				);
				if (!reclaimed) return;
				effect = reclaimed;
				lease = { owner: this.#dispatchOwner, epoch: effect.epoch };
			} catch (error) {
				const definitelyUnsent = this.#isDefiniteCallbackPreSendFailure(error);
				await this.#rescheduleAfterEffectTransition(
					this.#effects.record(effect.id, lease, "accepted", {
						status: definitelyUnsent ? "callback_pre_send_failure" : "defer_intent",
					}),
				);
				throw new Error("Discord interaction callback failed");
			} finally {
				clearInterval(timer);
			}
		}

		postImage = await this.#reloadInboundSnapshot(record, receipt);
		if (postImage === undefined || postImage.effect.state !== "leased") {
			await this.#terminalizeInbound(record, receipt, "stale_binding", lease);

			return;
		}
		record = postImage.record;
		receipt = postImage.receipt;
		effect = postImage.effect;
		const attachment =
			initialAttachment ?? (await this.#resolveAttachment(record.sessionId!, receipt.endpointGeneration));
		postImage = await this.#reloadInboundSnapshot(record, receipt);
		if (!postImage) {
			await this.#rescheduleAfterEffectTransition(
				this.#effects.record(effect.id, lease, "accepted", {
					status: this.#inboundAcceptedStatus(effect, "pre_send_binding_changed"),
				}),
			);
			return;
		}
		record = postImage.record;
		receipt = postImage.receipt;
		effect = postImage.effect;
		if (!this.#matches(record, attachment) || receipt.endpointGeneration !== attachment.generation) {
			await this.#rescheduleAfterEffectTransition(
				this.#effects.record(effect.id, lease, "accepted", {
					status: this.#inboundAcceptedStatus(effect, "pre_send_binding_changed"),
				}),
			);
			return;
		}

		let leaseLost = false;
		let renewal: Promise<boolean> | undefined;
		const renew = async (): Promise<boolean> => {
			if (leaseLost) return false;
			if (renewal) return await renewal;
			const currentRenewal = (async (): Promise<boolean> => {
				if (
					!(await this.#rescheduleAfterEffectTransition(
						this.#effects.renew(effect.id, lease, this.#dispatchLeaseMs),
					))
				)
					leaseLost = true;
				return !leaseLost;
			})();
			renewal = currentRenewal;
			try {
				return await currentRenewal;
			} finally {
				if (renewal === currentRenewal) renewal = undefined;
			}
		};
		const timer = setInterval(
			() => {
				void renew().catch(() => {});
			},
			Math.max(1, Math.floor(this.#dispatchLeaseMs / 3)),
		);
		try {
			if (!(await renew())) return;
			if (!this.#matches(record, attachment) || receipt.endpointGeneration !== attachment.generation) {
				await this.#rescheduleAfterEffectTransition(
					this.#effects.record(effect.id, lease, "accepted", {
						status: this.#inboundAcceptedStatus(effect, "pre_send_binding_changed"),
					}),
				);
				return;
			}

			if (!(await renew())) return;
			const beforeSend = await this.#reloadInboundSnapshot(record, receipt);
			if (!beforeSend) {
				await this.#terminalizeInbound(record, receipt, "stale_binding", lease);

				return;
			}
			record = beforeSend.record;
			receipt = beforeSend.receipt;
			effect = beforeSend.effect;
			if (!this.#matches(record, attachment) || receipt.endpointGeneration !== attachment.generation) {
				await this.#rescheduleAfterEffectTransition(
					this.#effects.record(effect.id, lease, "accepted", {
						status: this.#inboundAcceptedStatus(effect, "pre_send_binding_changed"),
					}),
				);
				return;
			}

			if (effect.payload.type === "command")
				await this.options.onCommand?.(
					record.sessionId!,
					effect.payload.content,
					attachment,
					effect.payload.idempotencyKey,
				);
			else await attachment.send(effect.payload);
			if (!leaseLost && (await renew()) && (await this.#effects.record(effect.id, lease, "terminal")))
				await this.#finishInbound(record, receipt);
		} catch (error) {
			if (!leaseLost) {
				const state = this.#isDefiniteSdkPreSendFailure(error) ? "accepted" : "uncertain";
				await this.#rescheduleAfterEffectTransition(
					this.#effects.record(effect.id, lease, state, {
						status: state === "accepted" ? this.#inboundAcceptedStatus(effect, "pre_send_failure") : "uncertain",
					}),
				);
			}
		} finally {
			clearInterval(timer);
		}
	}
	#hasDurableDeferIntent(effect: ChatEffect<DiscordInboundEffectPayload>): boolean {
		return (
			effect.kind === "discord.inbound.action" &&
			(effect.receipt?.status === "defer_intent" || effect.receipt?.status === "deferred")
		);
	}
	#inboundAcceptedStatus(effect: ChatEffect<DiscordInboundEffectPayload>, fallback: string): string {
		return this.#hasDurableDeferIntent(effect) ? (effect.receipt?.status ?? fallback) : fallback;
	}

	#hasLiveCallbackLease(effect: ChatEffect | undefined): boolean {
		return (
			effect?.kind === "discord.inbound.action" &&
			effect.state === "leased" &&
			typeof effect.owner === "string" &&
			(effect.leaseExpiresAt ?? 0) > this.#now()
		);
	}

	async #drainPendingDispatches(): Promise<boolean> {
		await this.#reconcileTerminalInboundReceipts();
		let recoveryFailed = false;
		const dispatched = new Set<string>();
		for (const initialRecord of Object.values((await this.#store.load()).conversations)) {
			if (!initialRecord.threadId || !initialRecord.sessionId || initialRecord.state !== "active") continue;
			let record = initialRecord;
			let attachment: SessionAttachment | null = null;
			let attachmentResolved = false;
			for (const [index, initialReceipt] of (record.inboundDispatches ?? []).entries()) {
				let receipt = initialReceipt;
				// Never race a foreground handleInbound() dispatch: while an effect is
				// in-flight it briefly unowns itself (record "accepted"/"deferred" before
				// reclaiming), a window in which recovery could otherwise claim it and
				// deliver its reply on the recovery timer instead of the awaited path.
				if (this.#inflightInbound.has(receipt.effectId)) {
					dispatched.add(receipt.effectId);
					continue;
				}
				if (
					receipt.kind === "action" &&
					(record.inboundDispatches ?? [])
						.slice(0, index)
						.some(
							candidate =>
								candidate.kind === "action" &&
								candidate.actionId === receipt.actionId &&
								candidate.actionNonce === receipt.actionNonce,
						)
				) {
					await this.#terminalizeInbound(record, receipt, "duplicate_action");
					continue;
				}
				const effect = await this.#effects.read(receipt.effectId);
				if (!effect) {
					// Referenced effects are retained by terminal pruning. Preserve the
					// receipt and retry recovery rather than acknowledging lost authority.
					recoveryFailed = true;
					continue;
				}
				if (effect?.state === "terminal") {
					await this.#finishInbound(record, receipt);
					continue;
				}
				if (this.#hasLiveCallbackLease(effect)) {
					dispatched.add(receipt.effectId);
					continue;
				}
				if (!attachmentResolved) {
					attachment = await this.#resolveAttachment(record.sessionId!, receipt.endpointGeneration);
					attachmentResolved = true;
				}
				const postImage = await this.#reloadInboundSnapshot(record, receipt);
				if (!postImage) {
					await this.#terminalizeInbound(record, receipt, "stale_binding");
					continue;
				}
				record = postImage.record;
				receipt = postImage.receipt;
				if (!this.#matches(record, attachment) || receipt.endpointGeneration !== attachment.generation) {
					await this.#terminalizeInbound(record, receipt, "stale_binding");
					continue;
				}
				dispatched.add(receipt.effectId);
				await this.#dispatchInbound(record, attachment, receipt);
			}
		}

		// Effects are the authority: a crash between enqueue and mapping receipt
		// publication must not strand a command at restart. Adoption revalidates
		// the current mapping before an orphan can reach the SDK.
		for (const effect of await this.#effects.list()) {
			if (
				effect.transport !== "discord" ||
				effect.state === "terminal" ||
				!effect.kind.startsWith("discord.inbound.") ||
				dispatched.has(effect.id) ||
				this.#inflightInbound.has(effect.id) ||
				this.#hasLiveCallbackLease(effect)
			)
				continue;
			const payload = effect.payload as DiscordInboundEffectPayload;
			const routing = payload.routing;
			if (!routing) continue;
			const adopted = await this.#adoptOrphanInbound(
				effect.id,
				effect.sessionId,
				effect.endpointGeneration,
				payload,
				routing,
			);
			if (!adopted) continue;
			const attachment = await this.#resolveAttachment(adopted.record.sessionId!, effect.endpointGeneration);
			const postImage = await this.#reloadInboundSnapshot(adopted.record, adopted.receipt);
			if (
				!postImage ||
				!this.#matches(postImage.record, attachment) ||
				attachment.generation !== postImage.receipt.endpointGeneration
			) {
				await this.#terminalizeInbound(adopted.record, adopted.receipt, "stale_binding");
				continue;
			}
			await this.#dispatchInbound(postImage.record, attachment, postImage.receipt);
		}
		return recoveryFailed;
	}
	async #adoptOrphanInbound(
		effectId: string,
		sessionId: string | undefined,
		endpointGeneration: number,
		payload: DiscordInboundEffectPayload,
		routing: DiscordInboundRouting,
	): Promise<{ record: DiscordConversation; receipt: DiscordInboundDispatchReceipt } | undefined> {
		const key = discordConversationKey({
			appId: this.options.provider.applicationId,
			guildId: routing.guildId,
			parentChannelId: routing.parentId,
			threadId: routing.threadId,
		});
		let record: DiscordConversation | undefined;
		let receipt: DiscordInboundDispatchReceipt | undefined;
		const structurallyValid = (): boolean =>
			effectId ===
				`discord:${this.options.provider.applicationId}:${routing.guildId}:${routing.parentId}:${routing.threadId}:${routing.eventId}` &&
			payload.idempotencyKey === effectId &&
			(payload.type === "command"
				? routing.kind === "command"
				: routing.kind === "action" && payload.id === routing.actionId && typeof routing.actionNonce === "string");
		if (sessionId !== undefined)
			await this.#effects.withSessionMutationGate(sessionId, async () => {
				const currentEffect = await this.#effects.read<DiscordInboundEffectPayload>(effectId);
				if (!currentEffect || currentEffect.id !== effectId) return;
				if (!currentEffect.sessionId) return;
				sessionId = currentEffect.sessionId;
				endpointGeneration = currentEffect.endpointGeneration;
				payload = currentEffect.payload;
				routing = payload.routing;
				await this.#store.transact(key, current => {
					if (
						!structurallyValid() ||
						!current ||
						current.state !== "active" ||
						current.sessionId !== sessionId ||
						current.endpointGeneration !== endpointGeneration ||
						!recordAcceptsAuthority(current, routing.attachmentAuthorityId)
					)
						return current;
					const existing = (current.inboundDispatches ?? []).find(
						candidate =>
							candidate.eventId === routing.eventId ||
							(routing.interactionId !== undefined && candidate.interactionId === routing.interactionId),
					);
					if (existing) {
						if (
							existing.effectId !== effectId ||
							existing.idempotencyKey !== payload.idempotencyKey ||
							existing.endpointGeneration !== endpointGeneration ||
							existing.kind !== routing.kind ||
							(existing.kind === "action" &&
								(existing.actionId !== routing.actionId ||
									existing.actionNonce !== routing.actionNonce ||
									existing.interactionId !== routing.interactionId))
						)
							return current;

						record = current;
						receipt = existing;
						return current;
					}
					if (
						current.seenEventIds.includes(routing.eventId) ||
						(routing.interactionId !== undefined && current.seenInteractionIds.includes(routing.interactionId)) ||
						(routing.kind === "action" &&
							(current.pendingActionId !== routing.actionId ||
								current.pendingActionNonce !== routing.actionNonce))
					)
						return current;
					if (
						routing.kind === "action" &&
						(current.inboundDispatches ?? []).some(
							candidate =>
								candidate.kind === "action" &&
								candidate.actionId === routing.actionId &&
								candidate.actionNonce === routing.actionNonce,
						)
					)
						return current;

					receipt = this.#receiptFromRouting(effectId, endpointGeneration, payload.idempotencyKey, routing);
					record = normalizeDiscordConversation({
						...current,
						generation: current.generation + 1,
						updatedAt: this.#now(),
						inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
					});
					return record;
				});
			});
		if (record && receipt) return { record, receipt };
		await this.#terminalizeRejectedInbound(effectId);
		return undefined;
	}
	#sameInboundIdentity(left: DiscordInboundDispatchReceipt, right: DiscordInboundDispatchReceipt): boolean {
		return (
			left.key === right.key &&
			left.eventId === right.eventId &&
			left.interactionId === right.interactionId &&
			left.kind === right.kind &&
			left.actionId === right.actionId &&
			left.actionNonce === right.actionNonce &&
			left.endpointGeneration === right.endpointGeneration &&
			left.effectId === right.effectId &&
			left.idempotencyKey === right.idempotencyKey
		);
	}
	async #reloadInboundSnapshot(
		record: DiscordConversation,
		receipt: DiscordInboundDispatchReceipt,
	): Promise<DiscordInboundSnapshot | undefined> {
		const current = await this.#byThread(record.guildId, record.parentChannelId, record.threadId!);
		const currentReceipt = current?.inboundDispatches?.find(candidate =>
			this.#sameInboundIdentity(candidate, receipt),
		);
		const effect = await this.#effects.read<DiscordInboundEffectPayload>(receipt.effectId);
		if (
			!current ||
			!currentReceipt ||
			!effect ||
			current.state !== "active" ||
			current.sessionId !== record.sessionId ||
			current.endpointGeneration !== receipt.endpointGeneration ||
			!recordAcceptsAuthority(current, currentReceipt.attachmentAuthorityId) ||
			!recordAcceptsAuthority(current, effect.payload.routing.attachmentAuthorityId) ||
			effect.sessionId !== current.sessionId ||
			effect.endpointGeneration !== receipt.endpointGeneration
		)
			return undefined;
		if (
			currentReceipt.kind === "action" &&
			(current.pendingActionId !== currentReceipt.actionId ||
				current.pendingActionNonce !== currentReceipt.actionNonce)
		)
			return undefined;
		return { record: current, receipt: currentReceipt, effect };
	}
	#completeInbound(record: DiscordConversation, receipt: DiscordInboundDispatchReceipt): DiscordConversation {
		const clearsAction =
			receipt.kind === "action" &&
			record.pendingActionId === receipt.actionId &&
			record.pendingActionNonce === receipt.actionNonce;
		return normalizeDiscordConversation({
			...record,
			generation: record.generation + 1,
			updatedAt: this.#now(),
			pendingActionId: clearsAction ? undefined : record.pendingActionId,
			pendingActionNonce: clearsAction ? undefined : record.pendingActionNonce,
			pendingActionEffectId: clearsAction ? undefined : record.pendingActionEffectId,
			seenEventIds: [...record.seenEventIds, receipt.eventId],
			seenInteractionIds:
				receipt.interactionId === undefined
					? record.seenInteractionIds
					: [...record.seenInteractionIds, receipt.interactionId],
			inboundDispatches: (record.inboundDispatches ?? []).filter(
				candidate => !this.#sameInboundIdentity(candidate, receipt),
			),
		});
	}
	#hasLiveEffectLease(effect: ChatEffect | undefined): boolean {
		return (
			effect?.state === "leased" && typeof effect.owner === "string" && (effect.leaseExpiresAt ?? 0) > this.#now()
		);
	}
	async #terminalizeEffect(
		id: string,
		status: string,
		lease?: ChatEffectLease,
		holdingGate = false,
	): Promise<boolean> {
		if (lease) {
			const terminalized = holdingGate
				? await this.#effects.recordWhileHoldingSessionMutationGate(id, lease, "terminal", { status })
				: await this.#effects.record(id, lease, "terminal", { status });
			return terminalized?.state === "terminal";
		}
		const effect = await this.#effects.read(id);
		if (!effect || effect.state === "terminal") return true;
		if (effect.state === "uncertain" || this.#hasLiveEffectLease(effect)) return false;
		if (effect.state === "leased") {
			const claimed = holdingGate
				? await this.#effects.claimWhileHoldingSessionMutationGate(id, this.#providerOwner, this.#providerLeaseMs)
				: await this.#effects.claim(id, this.#providerOwner, this.#providerLeaseMs);
			if (!claimed) return false;
			if (holdingGate)
				await this.#effects.recordWhileHoldingSessionMutationGate(
					id,
					{ owner: this.#providerOwner, epoch: claimed.epoch },
					"uncertain",
					{ status: "stale_lease_expired" },
				);
			else
				await this.#effects.record(id, { owner: this.#providerOwner, epoch: claimed.epoch }, "uncertain", {
					status: "stale_lease_expired",
				});
			return false;
		}
		return (
			(
				await (holdingGate
					? this.#effects.terminalizeWhileHoldingSessionMutationGate(id, { status })
					: this.#effects.terminalize(id, { status }))
			)?.state === "terminal"
		);
	}
	async #terminalizeRejectedInbound(effectId: string, lease?: ChatEffectLease): Promise<void> {
		await this.#terminalizeEffect(effectId, "rejected", lease);
	}
	async #terminalizeInbound(
		record: DiscordConversation,
		receipt: DiscordInboundDispatchReceipt,
		status: string,
		lease?: ChatEffectLease,
	): Promise<void> {
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		await this.#effects.withSessionMutationGate(record.sessionId!, async () => {
			const current = await this.#store.read(key);
			const matching = current?.inboundDispatches?.find(candidate => this.#sameInboundIdentity(candidate, receipt));
			const effectiveReceipt = matching ?? receipt;
			if (!(await this.#terminalizeEffect(effectiveReceipt.effectId, status, lease, true))) return;
			await this.#store.transact(key, current => {
				const matching = current?.inboundDispatches?.find(candidate =>
					this.#sameInboundIdentity(candidate, effectiveReceipt),
				);
				return !current || !matching ? current : this.#completeInbound(current, matching);
			});
		});
	}
	#receiptFromRouting(
		effectId: string,
		endpointGeneration: number,
		idempotencyKey: string,
		routing: DiscordInboundRouting,
	): DiscordInboundDispatchReceipt {
		return routing.kind === "command"
			? {
					key: routing.eventId,
					eventId: routing.eventId,
					kind: "command",
					endpointGeneration,
					...(routing.attachmentAuthorityId === undefined
						? {}
						: { attachmentAuthorityId: routing.attachmentAuthorityId }),
					effectId,
					idempotencyKey,
				}
			: {
					key: routing.eventId,
					eventId: routing.eventId,
					interactionId: routing.interactionId!,
					kind: "action",
					actionId: routing.actionId!,
					actionNonce: routing.actionNonce!,
					endpointGeneration,
					...(routing.attachmentAuthorityId === undefined
						? {}
						: { attachmentAuthorityId: routing.attachmentAuthorityId }),
					effectId,
					idempotencyKey,
				};
	}

	async #finishInbound(record: DiscordConversation, receipt: DiscordInboundDispatchReceipt): Promise<void> {
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		await this.#effects.withSessionMutationGate(record.sessionId!, async () => {
			await this.#store.transact(key, current => {
				const matching = current?.inboundDispatches?.find(candidate =>
					this.#sameInboundIdentity(candidate, receipt),
				);
				return !current || !matching ? current : this.#completeInbound(current, matching);
			});
		});
	}
	async #reconcileTerminalInboundReceipts(): Promise<void> {
		for (const effect of await this.#effects.list()) {
			if (
				effect.transport !== "discord" ||
				effect.state !== "terminal" ||
				(effect.kind !== "discord.inbound.command" && effect.kind !== "discord.inbound.action")
			)
				continue;
			const payload = effect.payload as DiscordInboundEffectPayload;
			const routing = payload?.routing;
			if (
				!routing ||
				!effect.sessionId ||
				!routing.guildId ||
				!routing.parentId ||
				!routing.threadId ||
				!routing.eventId ||
				payload.idempotencyKey !== effect.id ||
				effect.id !==
					`discord:${this.options.provider.applicationId}:${routing.guildId}:${routing.parentId}:${routing.threadId}:${routing.eventId}` ||
				(payload.type === "command"
					? routing.kind !== "command" || effect.kind !== "discord.inbound.command"
					: routing.kind !== "action" ||
						effect.kind !== "discord.inbound.action" ||
						!routing.interactionId ||
						!routing.actionId ||
						!routing.actionNonce ||
						payload.id !== routing.actionId)
			)
				continue;
			const receipt = this.#receiptFromRouting(
				effect.id,
				effect.endpointGeneration,
				payload.idempotencyKey,
				routing,
			);
			const record = await this.#byThread(routing.guildId, routing.parentId, routing.threadId);
			if (record?.inboundDispatches?.some(candidate => this.#sameInboundIdentity(candidate, receipt)))
				await this.#finishInbound(record, receipt);
		}
	}

	#matches(record: DiscordConversation, attachment: SessionAttachment | null): attachment is SessionAttachment {
		if (!attachment?.isCurrent()) return false;
		return (
			record.state === "active" &&
			record.endpointGeneration === attachment.generation &&
			attachmentAcceptsAuthority(attachment, record.attachmentAuthorityId)
		);
	}
	async #bindingCurrent(
		sessionId: string,
		endpointGeneration: number,
		attachmentAuthorityId?: string,
	): Promise<boolean> {
		try {
			const attachment = await this.#resolveAttachment(sessionId, endpointGeneration);
			return (
				!!attachment &&
				attachment.isCurrent() &&
				attachment.generation === endpointGeneration &&
				attachmentAcceptsAuthority(attachment, attachmentAuthorityId)
			);
		} catch {
			return false;
		}
	}
	async #requireLiveBinding(
		sessionId: string,
		endpointGeneration: number,
		attachmentAuthorityId?: string,
	): Promise<void> {
		if (!(await this.#bindingCurrent(sessionId, endpointGeneration, attachmentAuthorityId)))
			throw new DiscordAttachmentBindingError();
	}
	async #mappingAuthorityCurrent(
		record: DiscordConversation,
		endpointGeneration: number,
		requestedAuthorityId: string | undefined,
	): Promise<boolean> {
		if (requestedAuthorityId === undefined || record.attachmentAuthorityId === requestedAuthorityId) return true;
		if (!record.sessionId || record.endpointGeneration !== endpointGeneration) return false;
		return (
			(await this.#bindingCurrent(record.sessionId, endpointGeneration, record.attachmentAuthorityId)) &&
			(await this.#bindingCurrent(record.sessionId, endpointGeneration, requestedAuthorityId))
		);
	}
	#isDefiniteSdkPreSendFailure(error: unknown): boolean {
		if (error instanceof DiscordAttachmentBindingError) return true;
		if (error instanceof SessionRouterError) return error.phase === "pre_send";
		if (error instanceof SdkClientError) return error.code === "connection_closed";
		return (
			error instanceof Error &&
			error.name === "ChatDeliveryError" &&
			(error as ChatDeliveryError).phase === "pre_send"
		);
	}
	#isDefiniteCallbackPreSendFailure(error: unknown): boolean {
		// This is intentionally limited to Discord's received-and-rejected callback
		// response. Transport errors, connection loss, and arbitrary provider errors
		// leave the persisted defer intent authoritative because the callback may have
		// been accepted before its HTTP response was lost.
		return error instanceof Error && /^Discord API request failed \(4\d\d\)$/.test(error.message);
	}

	async #ensureConversation(input: DiscordNotificationInput): Promise<DiscordConversation> {
		const existing = await this.#bySession(input.sessionId);
		if (existing && closingIntent(existing)) {
			await this.#driveClose(existing);
			throw new Error("Discord thread is closing");
		}
		if (existing?.state === "active" && existing.threadId) {
			if (
				existing.endpointGeneration === input.endpointGeneration &&
				(await this.#mappingAuthorityCurrent(existing, input.endpointGeneration, input.attachmentAuthorityId))
			)
				return existing;
			if (
				existing.endpointGeneration === input.endpointGeneration &&
				input.attachmentAuthorityId !== undefined &&
				!(await this.#mappingAuthorityCurrent(existing, input.endpointGeneration, input.attachmentAuthorityId))
			) {
				await this.retireAttachment(input.sessionId, input.endpointGeneration);
				return await this.#ensureConversation(input);
			}
			await this.#requireLiveBinding(input.sessionId, input.endpointGeneration, input.attachmentAuthorityId);
			return await this.#replace(existing, {
				...existing,
				endpointGeneration: input.endpointGeneration,
				attachmentAuthorityId: input.attachmentAuthorityId,
			});
		}
		const inFlight = this.#creates.get(input.sessionId);
		if (inFlight) {
			let created: DiscordConversation;
			try {
				created = await inFlight;
			} catch {
				await this.#requireLiveBinding(input.sessionId, input.endpointGeneration, input.attachmentAuthorityId);
				return await this.#ensureConversation(input);
			}
			if (
				created.endpointGeneration === input.endpointGeneration &&
				(await this.#mappingAuthorityCurrent(created, input.endpointGeneration, input.attachmentAuthorityId))
			)
				return created;
			await this.#requireLiveBinding(input.sessionId, input.endpointGeneration, input.attachmentAuthorityId);
			return await this.#replace(created, {
				...created,
				endpointGeneration: input.endpointGeneration,
				attachmentAuthorityId: input.attachmentAuthorityId,
			});
		}
		const pending = this.#create(
			input.sessionId,
			input.endpointGeneration,
			randomUUID(),
			input.threadName,
			input.attachmentAuthorityId,
		);
		this.#creates.set(input.sessionId, pending);
		try {
			return await pending;
		} finally {
			this.#creates.delete(input.sessionId);
		}
	}

	async #create(
		sessionId: string,
		endpointGeneration: number,
		nonce: string,
		name = "GJC session",
		attachmentAuthorityId?: string,
	): Promise<DiscordConversation> {
		const intentKey = this.#intentKey(sessionId);
		const owner = randomUUID();
		let intent: DiscordConversation | undefined;
		for (;;) {
			const active = await this.#bySession(sessionId);
			if (active && closingIntent(active)) {
				await this.#driveClose(active);
				throw new Error("Discord thread is closing");
			}
			if (active?.state === "active" && active.threadId) {
				if (
					active.endpointGeneration === endpointGeneration &&
					(await this.#mappingAuthorityCurrent(active, endpointGeneration, attachmentAuthorityId))
				)
					return active;
				if (
					active.endpointGeneration === endpointGeneration &&
					attachmentAuthorityId !== undefined &&
					!(await this.#mappingAuthorityCurrent(active, endpointGeneration, attachmentAuthorityId))
				) {
					await this.retireAttachment(sessionId, endpointGeneration);
					continue;
				}
				await this.#requireLiveBinding(sessionId, endpointGeneration, attachmentAuthorityId);
				return await this.#replace(active, { ...active, endpointGeneration, attachmentAuthorityId });
			}
			const now = this.#now();
			await this.#requireLiveBinding(sessionId, endpointGeneration, attachmentAuthorityId);
			intent = await this.#effects.withSessionMutationGate(
				sessionId,
				async () =>
					await this.#store.transact(intentKey, old => {
						if (old?.state === "creating" && old.createOwner && (old.createLeaseExpiresAt ?? 0) > now) return old;
						return {
							generation: (old?.generation ?? 0) + 1,
							state: "creating",
							appId: this.options.provider.applicationId,
							guildId: this.options.guildId,
							parentChannelId: this.options.parentChannelId,
							sessionId,
							endpointGeneration,
							attachmentAuthorityId,
							createNonce: old?.createNonce ?? nonce,
							createOwner: owner,
							createLeaseExpiresAt: now + 60_000,
							updatedAt: now,
							seenEventIds: [],
							seenInteractionIds: [],
						};
					}),
			);
			if (!intent) throw new Error("Unable to persist Discord create intent");
			if (intent.createOwner === owner) break;
			await Bun.sleep(Math.min(25, Math.max(1, (intent.createLeaseExpiresAt ?? now) - now)));
		}
		const active = await this.#bySession(sessionId);
		if (active?.state === "active" && active.threadId) {
			if (active.endpointGeneration === endpointGeneration) return active;
			await this.#requireLiveBinding(sessionId, endpointGeneration, active.attachmentAuthorityId);
			return await this.#replace(active, { ...active, endpointGeneration });
		}
		let thread: DiscordThread | null;
		try {
			thread = await this.#withCreateIntentLease(intent, () =>
				this.#createThreadEffect(intent, name, attachmentAuthorityId),
			);
			await this.#requireLiveBinding(sessionId, endpointGeneration, intent.attachmentAuthorityId);
		} catch (error) {
			await this.#abandonCreator(intentKey, intent);
			throw error;
		}
		const currentIntent = await this.#store.read(intentKey);
		if (
			currentIntent?.state !== "creating" ||
			currentIntent.createOwner !== intent.createOwner ||
			currentIntent.generation !== intent.generation ||
			currentIntent.attachmentAuthorityId !== intent.attachmentAuthorityId ||
			(currentIntent.createLeaseExpiresAt ?? 0) <= this.#now()
		) {
			throw new Error("Discord create intent lost its fence before mapping commit");
		}
		await this.#requireLiveBinding(sessionId, endpointGeneration, intent.attachmentAuthorityId);
		const key = discordConversationKey({
			appId: intent.appId,
			guildId: intent.guildId,
			parentChannelId: intent.parentChannelId,
			threadId: thread.id,
		});
		let committed = false;
		const record = await this.#effects.withSessionMutationGate(
			sessionId,
			async () =>
				await this.#store.transactWithSnapshot(key, (old, conversations) => {
					const current = conversations[intentKey];
					if (
						current?.state !== "creating" ||
						current.createOwner !== intent.createOwner ||
						current.generation !== intent.generation ||
						current.attachmentAuthorityId !== intent.attachmentAuthorityId ||
						(current.createLeaseExpiresAt ?? 0) <= this.#now()
					)
						return old;
					committed = true;
					return normalizeDiscordConversation({
						generation: (old?.generation ?? 0) + 1,
						state: "active",
						appId: intent.appId,
						guildId: intent.guildId,
						parentChannelId: intent.parentChannelId,
						threadId: thread.id,
						sessionId,
						endpointGeneration,
						attachmentAuthorityId: intent.attachmentAuthorityId,
						...(current.attachmentAuthorityMigrationFromId === undefined
							? {}
							: { attachmentAuthorityMigrationFromId: current.attachmentAuthorityMigrationFromId }),
						createNonce: intent.createNonce,
						effectIncarnationId: old?.effectIncarnationId ?? intent.effectIncarnationId ?? randomUUID(),
						updatedAt: this.#now(),
						seenEventIds:
							old?.attachmentAuthorityId === intent.attachmentAuthorityId ? (old?.seenEventIds ?? []) : [],
						seenInteractionIds:
							old?.attachmentAuthorityId === intent.attachmentAuthorityId ? (old?.seenInteractionIds ?? []) : [],
						inboundDispatches:
							old?.attachmentAuthorityId === intent.attachmentAuthorityId ? old?.inboundDispatches : undefined,
					});
				}),
		);
		if (!committed || !record) throw new Error("Discord create intent lost its fence before mapping commit");
		await this.#effects.withSessionMutationGate(sessionId, async () => {
			await this.#store.delete(intentKey, intent.generation);
		});
		return record;
	}

	async #sessionMappings(sessionId: string): Promise<DiscordConversation[]> {
		return Object.values((await this.#store.load()).conversations).filter(
			record => record.sessionId === sessionId && record.state !== "creating",
		);
	}
	async #bySession(sessionId: string): Promise<DiscordConversation | undefined> {
		const document = await this.#store.load();
		return Object.values(document.conversations)
			.filter(record => record.sessionId === sessionId && record.state !== "creating")
			.sort(
				(left, right) =>
					stateRank(left.state) - stateRank(right.state) ||
					right.generation - left.generation ||
					right.updatedAt - left.updatedAt,
			)[0];
	}
	async #byThread(
		guildId: string,
		parentChannelId: string,
		threadId: string,
	): Promise<DiscordConversation | undefined> {
		return await this.#store.read(
			discordConversationKey({ appId: this.options.provider.applicationId, guildId, parentChannelId, threadId }),
		);
	}
	#closeMarkerEffectId(record: DiscordConversation): string {
		const intent = closingIntent(record);
		if (!record.threadId || !intent) throw new Error("Discord close intent is unavailable.");
		return `close-marker:${record.threadId}:${intent.nonce}`;
	}
	#closeArchiveEffectId(record: DiscordConversation): string {
		const intent = closingIntent(record);
		if (!record.threadId || !intent) throw new Error("Discord close intent is unavailable.");
		return `close-archive:${record.threadId}:${intent.nonce}`;
	}
	async #markClosing(sessionId: string, endpointGeneration?: number): Promise<DiscordConversation | undefined> {
		const record = await this.#bySession(sessionId);
		if (!record?.threadId || record.state === "closed") return undefined;
		if (endpointGeneration !== undefined && record.endpointGeneration !== endpointGeneration) return undefined;
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId,
		});
		let closing: DiscordConversation | undefined;
		await this.#effects.withSessionMutationGate(sessionId, async () => {
			await this.#store.transact(key, current => {
				if (
					!current ||
					current.sessionId !== sessionId ||
					!current.threadId ||
					current.state === "closed" ||
					(endpointGeneration !== undefined && current.endpointGeneration !== endpointGeneration)
				)
					return current;
				if (closingIntent(current)) {
					closing = current;
					return current;
				}
				closing = normalizeDiscordConversation(withClosingIntent(current, randomUUID(), this.#now()));
				return closing;
			});
		});
		return closing;
	}
	async #driveClose(record: DiscordConversation): Promise<void> {
		if (!record.threadId) return;
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId,
		});
		let current = await this.#store.read(key);
		if (!current || !closingIntent(current)) return;
		for (const receipt of current.inboundDispatches ?? [])
			await this.#terminalizeInbound(current, receipt, "closing");
		current = await this.#store.read(key);
		if (!current || !closingIntent(current)) return;
		const closingRecord = current;
		const intent = closingIntent(closingRecord)!;
		await this.#postEffect(
			this.#closeMarkerEffectId(closingRecord),
			closingRecord,
			"This conversation is closed.",
			undefined,
			false,
			true,
		);
		await this.#threadEffect(this.#closeArchiveEffectId(closingRecord), closingRecord, "archive", true, true);
		await this.#effects.withSessionMutationGate(closingRecord.sessionId!, async () => {
			await this.#store.transact(key, candidate => {
				const candidateIntent = closingIntent(candidate);
				return candidate &&
					candidate.sessionId === closingRecord.sessionId &&
					candidateIntent?.nonce === intent.nonce
					? normalizeDiscordConversation(withoutClosingIntent(candidate, this.#now()))
					: candidate;
			});
		});
	}
	async #recoverClosingConversations(): Promise<boolean> {
		let failed = false;
		for (const record of Object.values((await this.#store.load()).conversations)) {
			if (!closingIntent(record)) continue;
			try {
				await this.#driveClose(record);
			} catch {
				failed = true;
			}
		}
		return failed;
	}
	async #replace(
		current: DiscordConversation,
		next: Omit<DiscordConversation, "generation"> & { generation?: number },
	): Promise<DiscordConversation> {
		const key = current.threadId
			? discordConversationKey({
					appId: current.appId,
					guildId: current.guildId,
					parentChannelId: current.parentChannelId,
					threadId: current.threadId,
				})
			: this.#intentKey(current.sessionId!);
		const result = await this.#effects.withSessionMutationGate(
			current.sessionId!,
			async () =>
				await this.#store.write(key, current.generation, {
					...next,
					generation: current.generation + 1,
					updatedAt: this.#now(),
				}),
		);
		if (!result) {
			const stored = await this.#store.read(key);
			throw new Error(
				`Discord conversation changed concurrently (key=${key}, expected=${current.generation}, actual=${stored?.generation ?? "missing"})`,
			);
		}
		return (await this.#store.read(key))!;
	}
	async #beginArchive(record: DiscordConversation): Promise<DiscordConversation> {
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		let archiving: DiscordConversation | undefined;
		await this.#effects.withSessionMutationGate(record.sessionId!, async () => {
			await this.#store.transact(key, current => {
				if (
					current?.state !== "active" ||
					current.sessionId !== record.sessionId ||
					current.endpointGeneration !== record.endpointGeneration
				)
					return current;
				if (current.archiveOccurrenceId) {
					archiving = current;
					return current;
				}
				const archiveOccurrenceId = randomUUID();
				const effectIncarnationId = backfilledEffectIncarnationId(current);
				archiving = normalizeDiscordConversation({
					...current,
					generation: current.generation + 1,
					updatedAt: this.#now(),
					effectIncarnationId,
					archiveOccurrenceId,
					archiveEffectId: `archive:${current.threadId}:${effectIncarnationId}:${archiveOccurrenceId}`,
				});

				return archiving;
			});
		});
		if (!archiving) throw new Error("Discord archive intent lost its authority");
		return archiving;
	}
	async #completeArchive(record: DiscordConversation, occurrenceId: string): Promise<void> {
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		await this.#effects.withSessionMutationGate(record.sessionId!, async () => {
			await this.#store.transact(key, current => {
				if (
					current?.state !== "active" ||
					current.sessionId !== record.sessionId ||
					current.archiveOccurrenceId !== occurrenceId
				)
					return current;
				return normalizeDiscordConversation({
					...current,
					generation: current.generation + 1,
					updatedAt: this.#now(),
					state: "archived",
					archivedAt: this.#now(),
					archiveOccurrenceId: undefined,
					archiveEffectId: undefined,
				});
			});
		});
	}
	async #completeResume(record: DiscordConversation, occurrenceId: string): Promise<DiscordConversation> {
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		const completed = await this.#effects.withSessionMutationGate(
			record.sessionId!,
			async () =>
				await this.#store.transact(key, current => {
					if (
						!current ||
						current.sessionId !== record.sessionId ||
						current.endpointGeneration !== record.endpointGeneration
					)
						return current;
					if (current.state === "active" && current.resumeOccurrenceId === undefined) return current;
					if (current.state !== "resuming" || current.resumeOccurrenceId !== occurrenceId) return current;
					return normalizeDiscordConversation({
						...current,
						generation: current.generation + 1,
						updatedAt: this.#now(),
						state: "active",
						archivedAt: undefined,
						resumeOccurrenceId: undefined,
						resumeEffectId: undefined,
					});
				}),
		);
		if (completed?.state !== "active" || completed.sessionId !== record.sessionId)
			throw new Error("Discord resume occurrence lost its authority");
		return completed;
	}
	async #abandonCreator(intentKey: string, intent: DiscordConversation): Promise<void> {
		await this.#effects.withSessionMutationGate(intent.sessionId!, async () => {
			await this.#store.transact(intentKey, current => {
				if (!current || current.generation !== intent.generation || current.createOwner !== intent.createOwner)
					return current;
				return normalizeDiscordConversation({
					...current,
					generation: current.generation + 1,
					updatedAt: this.#now(),
					createOwner: undefined,
					createLeaseExpiresAt: undefined,
				});
			});
		});
	}
	#intentKey(sessionId: string): string {
		return `${this.options.provider.applicationId}:${this.options.guildId}:${this.options.parentChannelId}:creating:${sessionId}`;
	}
	#removeSessionInvalidator(sessionId: string, set: Set<() => Promise<void>>, invalidate: () => Promise<void>): void {
		set.delete(invalidate);
		if (set.size === 0 && this.#sessionInvalidators.get(sessionId) === set)
			this.#sessionInvalidators.delete(sessionId);
	}
	async #withCreateIntentLease<T>(intent: DiscordConversation, work: () => Promise<T>): Promise<T> {
		let lost = false;
		let renewal: Promise<boolean> | undefined;
		let expectedGeneration = intent.generation;
		const workGeneration = this.#workGeneration;
		const abandonCurrent = async (): Promise<void> => {
			await this.#abandonCreator(this.#intentKey(intent.sessionId!), intent);
		};
		const invalidate = async (): Promise<void> => {
			lost = true;
			const activeRenewal = renewal;
			if (activeRenewal) await activeRenewal.catch(() => false);
			await abandonCurrent();
		};
		this.#workInvalidators.add(invalidate);
		const sessionInvalidators = this.#sessionInvalidators.get(intent.sessionId!) ?? new Set<() => Promise<void>>();
		sessionInvalidators.add(invalidate);
		this.#sessionInvalidators.set(intent.sessionId!, sessionInvalidators);
		const renew = async (): Promise<boolean> => {
			if (lost || workGeneration !== this.#workGeneration) {
				await invalidate();
				return false;
			}
			if (renewal) return await renewal;
			const currentRenewal = (async (): Promise<boolean> => {
				const now = this.#now();
				const current = await this.#effects.withSessionMutationGate(
					intent.sessionId!,
					async () =>
						await this.#store.transact(this.#intentKey(intent.sessionId!), candidate => {
							if (
								candidate?.state !== "creating" ||
								candidate.createOwner !== intent.createOwner ||
								candidate.generation !== expectedGeneration ||
								(candidate.createLeaseExpiresAt ?? 0) <= now
							)
								return candidate;
							return {
								...candidate,
								generation: candidate.generation + 1,
								createLeaseExpiresAt: now + this.#providerLeaseMs,
								updatedAt: now,
							};
						}),
				);
				if (workGeneration !== this.#workGeneration) {
					if (current?.state === "creating" && current.createOwner === intent.createOwner) {
						intent.generation = current.generation;
						intent.createLeaseExpiresAt = current.createLeaseExpiresAt;
					}
					lost = true;
					await abandonCurrent();
					return false;
				}
				if (
					current?.state !== "creating" ||
					current.createOwner !== intent.createOwner ||
					current.generation !== expectedGeneration + 1 ||
					(current.createLeaseExpiresAt ?? 0) <= now
				) {
					lost = true;
				} else {
					expectedGeneration = current.generation;
					intent.generation = current.generation;
					intent.createLeaseExpiresAt = current.createLeaseExpiresAt;
				}
				return !lost;
			})();
			renewal = currentRenewal;
			try {
				return await currentRenewal;
			} finally {
				if (renewal === currentRenewal) renewal = undefined;
			}
		};
		if (!(await renew())) throw new Error("Discord create intent lost its fence");
		const timer = setInterval(
			() => {
				void renew().catch(() => {});
			},
			Math.max(1, Math.floor(this.#providerLeaseMs / 3)),
		);
		try {
			const result = await work();
			if (!(await renew())) throw new Error("Discord create intent lost its fence");
			return result;
		} finally {
			clearInterval(timer);
			this.#workInvalidators.delete(invalidate);
			this.#removeSessionInvalidator(intent.sessionId!, sessionInvalidators, invalidate);
		}
	}
	async #clearPending(record: DiscordConversation, actionId: string, actionNonce: string): Promise<void> {
		const key = record.threadId
			? discordConversationKey({
					appId: record.appId,
					guildId: record.guildId,
					parentChannelId: record.parentChannelId,
					threadId: record.threadId,
				})
			: this.#intentKey(record.sessionId!);
		await this.#effects.withSessionMutationGate(record.sessionId!, async () => {
			await this.#store.transact(key, current => {
				if (current?.pendingActionId !== actionId || current.pendingActionNonce !== actionNonce) return current;
				return normalizeDiscordConversation({
					...current,
					generation: current.generation + 1,
					updatedAt: this.#now(),
					pendingActionId: undefined,
					pendingActionNonce: undefined,
					pendingActionEffectId: undefined,
				});
			});
		});
	}
	async #ensureActionPublication(record: DiscordConversation, actionId: string): Promise<DiscordConversation> {
		const key = discordConversationKey({
			appId: record.appId,
			guildId: record.guildId,
			parentChannelId: record.parentChannelId,
			threadId: record.threadId!,
		});
		await this.#requireLiveBinding(record.sessionId!, record.endpointGeneration!, record.attachmentAuthorityId);
		const result = await this.#effects.withSessionMutationGate(
			record.sessionId!,
			async () =>
				await this.#store.transact(key, current => {
					if (
						current?.state !== "active" ||
						current.sessionId !== record.sessionId ||
						current.endpointGeneration !== record.endpointGeneration ||
						!recordAcceptsAuthority(current, record.attachmentAuthorityId)
					)
						return current;
					if (current.pendingActionId === actionId && current.pendingActionNonce && current.pendingActionEffectId)
						return current;
					const actionNonce =
						current.pendingActionId === actionId && current.pendingActionNonce
							? current.pendingActionNonce
							: randomUUID();
					return normalizeDiscordConversation({
						...current,
						generation: current.generation + 1,
						updatedAt: this.#now(),
						pendingActionId: actionId,
						pendingActionNonce: actionNonce,
						pendingActionEffectId: `action-publication:${current.threadId}:${actionId}:${actionNonce}`,
					});
				}),
		);
		if (
			result?.state !== "active" ||
			result.sessionId !== record.sessionId ||
			result.endpointGeneration !== record.endpointGeneration ||
			result.pendingActionId !== actionId ||
			!result.pendingActionNonce ||
			!result.pendingActionEffectId
		) {
			throw new Error("Discord action publication intent lost its authority");
		}
		return result;
	}

	async #runEffect<TPayload>(
		id: string,
		kind: string,
		sessionId: string | undefined,
		endpointGeneration: number,
		payload: TPayload,
		operation: (ensure: () => Promise<void>, beforeProvider: () => void) => Promise<ChatEffectReceipt>,
		revalidate: () => boolean | Promise<boolean>,
		terminalizeStaleBeforeProvider = false,
	): Promise<ChatEffectReceipt> {
		const workGeneration = this.#workGeneration;
		const claimed = await this.#rescheduleAfterEffectTransition(
			sessionId === undefined
				? this.#effects.enqueueAndClaim<TPayload>(
						{ id, kind, transport: "discord", sessionId, endpointGeneration, payload },
						this.#providerOwner,
						this.#providerLeaseMs,
					)
				: this.#effects.withSessionMutationGate(sessionId, async () =>
						this.#effects.enqueueAndClaimWhileHoldingSessionMutationGate<TPayload>(
							{ id, kind, transport: "discord", sessionId, endpointGeneration, payload },
							this.#providerOwner,
							this.#providerLeaseMs,
						),
					),
		);
		let effect: ChatEffect<TPayload>;
		if (claimed) {
			// Fresh effect atomically inserted into a live lease. This closes the
			// enqueue→claim window in which the same-process lease-recovery timer could
			// claim the still-"pending" effect first and make this foreground claim fail
			// with "owned by another worker" (mirrors the inbound enqueueAndClaim path).
			effect = claimed;
		} else {
			const initial = await this.#effects.read<TPayload>(id);
			if (initial?.state === "terminal") {
				if (!initial.receipt) throw new Error(`Discord effect ${id} has no receipt`);
				if (terminalizeStaleBeforeProvider && initial.receipt.status === "stale_noop")
					throw new DiscordAttachmentBindingError("Discord thread effect is no longer current.");
				return initial.receipt;
			}
			const reclaimed = await this.#rescheduleAfterEffectTransition(
				this.#effects.claim<TPayload>(id, this.#providerOwner, this.#providerLeaseMs),
			);
			if (!reclaimed) throw new Error(`Discord effect ${id} is owned by another worker`);
			effect = reclaimed;
		}
		const lease: ChatEffectLease = { owner: this.#providerOwner, epoch: effect.epoch };
		if (workGeneration !== this.#workGeneration) {
			await this.#rescheduleAfterEffectTransition(
				this.#effects.record(id, lease, "uncertain", { status: "shutdown_timeout" }),
			);
			throw new Error(`Discord effect ${id} was admitted after shutdown drain expiry`);
		}
		let renewalLost = false;
		let revalidationFailed = false;
		let providerEffectStarted = false;
		let renewal: Promise<boolean> | undefined;
		const invalidate = async (): Promise<void> => {
			renewalLost = true;
			await this.#rescheduleAfterEffectTransition(
				this.#effects.record(id, lease, "uncertain", { status: "shutdown_timeout" }),
			);
		};
		this.#workInvalidators.add(invalidate);
		let sessionInvalidators: Set<() => Promise<void>> | undefined;
		if (sessionId !== undefined) {
			sessionInvalidators = this.#sessionInvalidators.get(sessionId) ?? new Set<() => Promise<void>>();
			sessionInvalidators.add(invalidate);
			this.#sessionInvalidators.set(sessionId, sessionInvalidators);
		}
		const renewLease = async (): Promise<boolean> => {
			if (renewalLost || workGeneration !== this.#workGeneration) {
				renewalLost = true;
				return false;
			}
			if (renewal) return await renewal;
			const currentRenewal = (async (): Promise<boolean> => {
				const renewed = await this.#rescheduleAfterEffectTransition(
					this.#effects.renew(id, lease, this.#providerLeaseMs),
				);
				if (workGeneration !== this.#workGeneration) {
					await invalidate();
					return false;
				}
				if (!renewed) renewalLost = true;
				return !renewalLost;
			})();
			renewal = currentRenewal;
			try {
				return await currentRenewal;
			} finally {
				if (renewal === currentRenewal) renewal = undefined;
			}
		};
		const timer = setInterval(
			() => {
				void renewLease().catch(() => {});
			},
			Math.max(1, Math.floor(this.#providerLeaseMs / 3)),
		);
		const ensure = async (): Promise<void> => {
			if (!(await renewLease())) throw new Error(`Discord effect ${id} lost its fence`);
			if (!(await revalidate())) {
				revalidationFailed = true;
				renewalLost = true;
				throw new Error(`Discord effect ${id} lost its fence`);
			}
		};
		try {
			await ensure();
			const receipt = await operation(ensure, () => {
				providerEffectStarted = true;
			});
			if (!(await renewLease())) throw new Error(`Discord effect ${id} lost its fence`);
			const committed = await this.#effects.record(id, lease, "terminal", receipt);
			if (!committed) throw new Error(`Discord effect ${id} lost its fence before commit`);
			return receipt;
		} catch (error) {
			if (terminalizeStaleBeforeProvider && revalidationFailed && !providerEffectStarted)
				await this.#rescheduleAfterEffectTransition(
					this.#effects.record(id, lease, "terminal", { status: "stale_noop" }),
				);
			else if (!renewalLost)
				await this.#rescheduleAfterEffectTransition(
					this.#effects.record(id, lease, "uncertain", { status: "uncertain" }),
				);
			throw error;
		} finally {
			clearInterval(timer);
			this.#workInvalidators.delete(invalidate);
			if (sessionId !== undefined && sessionInvalidators !== undefined)
				this.#removeSessionInvalidator(sessionId, sessionInvalidators, invalidate);
		}
	}

	async #postEffect(
		id: string,
		record: DiscordConversation,
		content: string,
		components?: DiscordMessageComponent[],
		actionPublication = false,
		closing = false,
		allowInactive = false,
	): Promise<void> {
		const nonce = discordEffectNonce(id);
		const existingEffect = await this.#effects.read<{
			threadId: string;
			content: string;
			nonce: string;
			components?: DiscordMessageComponent[];
			attachmentAuthorityId?: string;
		}>(id);
		const payload = existingEffect?.payload ?? {
			threadId: record.threadId!,
			content,
			nonce,
			...(record.attachmentAuthorityId === undefined ? {} : { attachmentAuthorityId: record.attachmentAuthorityId }),
			...(components ? { components } : {}),
		};
		if (!recordAcceptsAuthority(record, payload.attachmentAuthorityId))
			throw new DiscordAttachmentBindingError("Discord provider effect belongs to another attachment.");
		await this.#runEffect(
			id,
			"post-message",
			record.sessionId,
			record.endpointGeneration!,
			payload,
			async ensure => {
				await ensure();
				const reconciled = await this.options.provider.findMessageByNonce({
					threadId: payload.threadId,
					nonce: payload.nonce,
				});
				if (reconciled)
					return {
						provider: "discord",
						messageId: reconciled.id,
						threadId: record.threadId,
						status: "reconciled",
					};
				await ensure();
				const posted = await this.options.provider.postMessage({
					threadId: payload.threadId,
					content: payload.content,
					nonce: payload.nonce,
					...(payload.components ? { components: payload.components } : {}),
				});
				return { provider: "discord", messageId: posted.id, threadId: record.threadId, status: "posted" };
			},
			async () => {
				if (
					!closing &&
					!allowInactive &&
					(!record.sessionId ||
						!(await this.#bindingCurrent(
							record.sessionId,
							record.endpointGeneration!,
							record.attachmentAuthorityId,
						)))
				)
					return false;
				const current = await this.#byThread(record.guildId, record.parentChannelId, record.threadId!);
				const migratedEffect = await this.#effects.read<typeof payload>(id);
				const intent = current ? closingIntent(current) : undefined;
				const mappingCurrent = closing
					? !!current &&
						closingIntent(record)?.nonce === intent?.nonce &&
						current.sessionId === record.sessionId &&
						current.endpointGeneration === record.endpointGeneration
					: !!current &&
						(allowInactive || current.state === "active") &&
						current.endpointGeneration === record.endpointGeneration &&
						!!migratedEffect &&
						recordAcceptsAuthority(current, migratedEffect.payload.attachmentAuthorityId) &&
						(!actionPublication || current.pendingActionEffectId === id);
				return mappingCurrent;
			},
		);
	}
	async #threadEffect(
		id: string,
		record: DiscordConversation,
		operation: "archive" | "unarchive",
		locked = false,
		closing = false,
		occurrenceId?: string,
	): Promise<void> {
		const expectedPayload = {
			threadId: record.threadId!,
			locked,
			...(record.attachmentAuthorityId === undefined ? {} : { attachmentAuthorityId: record.attachmentAuthorityId }),
			...(occurrenceId === undefined ? {} : { occurrenceId }),
		};
		const existingEffect = await this.#effects.read<typeof expectedPayload>(id);
		const payload = existingEffect?.payload ?? expectedPayload;
		if (
			payload.threadId !== expectedPayload.threadId ||
			payload.locked !== expectedPayload.locked ||
			payload.occurrenceId !== expectedPayload.occurrenceId ||
			!recordAcceptsAuthority(record, payload.attachmentAuthorityId)
		)
			throw new DiscordAttachmentBindingError("Discord thread effect belongs to another attachment.");
		await this.#runEffect(
			id,
			operation,
			record.sessionId,
			record.endpointGeneration!,
			payload,

			async (ensure, beforeProvider) => {
				await ensure();
				beforeProvider();
				if (operation === "archive")
					await this.options.provider.archiveThread({
						threadId: record.threadId!,
						...(locked ? { locked: true } : {}),
					});
				else await this.options.provider.unarchiveThread({ threadId: record.threadId! });
				return { provider: "discord", threadId: record.threadId, status: operation };
			},
			async () => {
				if (
					!closing &&
					(!record.sessionId ||
						!(await this.#bindingCurrent(
							record.sessionId,
							record.endpointGeneration!,
							record.attachmentAuthorityId,
						)))
				)
					return false;
				const current = await this.#byThread(record.guildId, record.parentChannelId, record.threadId!);
				const migratedEffect = await this.#effects.read<typeof expectedPayload>(id);
				const intent = current ? closingIntent(current) : undefined;
				const mappingCurrent = closing
					? !!current &&
						closingIntent(record)?.nonce === intent?.nonce &&
						current.sessionId === record.sessionId &&
						current.endpointGeneration === record.endpointGeneration
					: !!current &&
						current.state === (operation === "archive" ? "active" : "resuming") &&
						current.endpointGeneration === record.endpointGeneration &&
						!!migratedEffect &&
						recordAcceptsAuthority(current, migratedEffect.payload.attachmentAuthorityId) &&
						(occurrenceId === undefined ||
							(operation === "archive"
								? current.archiveEffectId === id && current.archiveOccurrenceId === occurrenceId
								: current.resumeEffectId === id && current.resumeOccurrenceId === occurrenceId));
				return mappingCurrent;
			},
			!closing,
		);
	}
	async #createThreadEffect(
		intent: DiscordConversation,
		name: string,
		attachmentAuthorityId = intent.attachmentAuthorityId,
	): Promise<DiscordThread> {
		const effectId = `create:${intent.sessionId}:${intent.createNonce}`;
		const nonce = discordEffectNonce(effectId);
		const expectedPayload = {
			guildId: intent.guildId,
			parentId: intent.parentChannelId,
			name,
			nonce,
			...(attachmentAuthorityId === undefined ? {} : { attachmentAuthorityId }),
		};
		const existingEffect = await this.#effects.read<typeof expectedPayload>(effectId);
		const payload = existingEffect?.payload ?? expectedPayload;
		if (
			payload.guildId !== expectedPayload.guildId ||
			payload.parentId !== expectedPayload.parentId ||
			payload.name !== expectedPayload.name ||
			payload.nonce !== expectedPayload.nonce ||
			!recordAcceptsAuthority(intent, payload.attachmentAuthorityId)
		)
			throw new DiscordAttachmentBindingError("Discord create effect belongs to another attachment.");
		const receipt = await this.#runEffect(
			effectId,
			"create-thread",
			intent.sessionId,
			intent.endpointGeneration!,
			payload,
			async ensure => {
				await ensure();
				const existing = await this.options.provider.findThreadByNonce({
					guildId: intent.guildId,
					parentId: intent.parentChannelId,
					nonce,
				});
				await ensure();
				const thread =
					existing ??
					(await this.options.provider.createThread({
						guildId: intent.guildId,
						parentId: intent.parentChannelId,
						name,
						nonce,
					}));
				return {
					provider: "discord",
					threadId: thread.id,
					channelId: thread.parentId,
					status: existing ? "reconciled" : "created",
				};
			},
			async () => {
				const current = await this.#store.read(this.#intentKey(intent.sessionId!));
				return (
					current?.state === "creating" &&
					current.createOwner === intent.createOwner &&
					current.generation === intent.generation &&
					(current.createLeaseExpiresAt ?? 0) > this.#now() &&
					current.attachmentAuthorityId === attachmentAuthorityId &&
					(await this.#bindingCurrent(intent.sessionId!, intent.endpointGeneration!, attachmentAuthorityId))
				);
			},
		);
		if (!receipt.threadId) throw new Error("Discord create effect has no thread receipt");
		return { id: receipt.threadId, guildId: intent.guildId, parentId: intent.parentChannelId, archived: false };
	}
	async #recoverCreateThread(
		effect: ChatEffect,
		payload: {
			guildId?: string;
			parentId?: string;
			name?: string;
			nonce?: string;
			attachmentAuthorityId?: string;
		},
	): Promise<void> {
		if (!effect.sessionId || !payload.nonce) return;
		const intentKey = this.#intentKey(effect.sessionId);
		const effectId = effect.id;
		type CreateThreadPayload = {
			guildId?: string;
			parentId?: string;
			name?: string;
			nonce?: string;
			attachmentAuthorityId?: string;
		};
		const matchesCreateOperation = (
			candidate: DiscordConversation | undefined,
			candidateEffect: ChatEffect<CreateThreadPayload> | undefined,
		): candidate is DiscordConversation => {
			const candidatePayload = candidateEffect?.payload;
			return (
				!!candidate &&
				!!candidateEffect &&
				candidateEffect.id === effectId &&
				candidateEffect.kind === "create-thread" &&
				candidateEffect.transport === "discord" &&
				candidateEffect.sessionId === effect.sessionId &&
				candidateEffect.endpointGeneration === effect.endpointGeneration &&
				candidatePayload?.guildId === payload.guildId &&
				candidatePayload?.parentId === payload.parentId &&
				candidatePayload?.name === payload.name &&
				candidatePayload?.nonce === payload.nonce &&
				candidate.sessionId === effect.sessionId &&
				candidate.endpointGeneration === effect.endpointGeneration &&
				candidate.state === "creating" &&
				candidate.guildId === payload.guildId &&
				candidate.parentChannelId === payload.parentId &&
				candidate.createNonce !== undefined &&
				candidateEffect.id === `create:${candidate.sessionId}:${candidate.createNonce}` &&
				discordEffectNonce(candidateEffect.id) === candidatePayload?.nonce &&
				recordAcceptsAuthority(candidate, candidatePayload?.attachmentAuthorityId)
			);
		};
		let intent: DiscordConversation | undefined;
		let currentEffect: ChatEffect<CreateThreadPayload> | undefined;
		await this.#effects.withSessionMutationGate(effect.sessionId, async () => {
			intent = await this.#store.read(intentKey);
			currentEffect = await this.#effects.read<CreateThreadPayload>(effectId);
		});
		if (!matchesCreateOperation(intent, currentEffect)) {
			if (effect.state !== "terminal") await this.#terminalizeEffect(effect.id, "rejected");

			return;
		}
		const bindingCurrent = await this.#bindingCurrent(
			effect.sessionId,
			effect.endpointGeneration,
			payload.attachmentAuthorityId,
		);
		await this.#effects.withSessionMutationGate(effect.sessionId, async () => {
			intent = await this.#store.read(intentKey);
			currentEffect = await this.#effects.read<CreateThreadPayload>(effectId);
		});
		if (!bindingCurrent) {
			await this.#effects.withSessionMutationGate(effect.sessionId, async () => {
				const current = await this.#store.read(intentKey);
				const latestEffect = await this.#effects.read<CreateThreadPayload>(effectId);
				if (matchesCreateOperation(current, latestEffect)) await this.#store.delete(intentKey, current.generation);
			});
			return;
		}
		if (!matchesCreateOperation(intent, currentEffect)) {
			if (currentEffect?.state !== "terminal") await this.#terminalizeEffect(effectId, "rejected");

			return;
		}
		if (!intent || !currentEffect) return;
		const recoveredIntent = intent;
		const recoveredEffect = currentEffect;
		if (recoveredEffect.state !== "terminal") {
			await this.#create(
				recoveredIntent.sessionId!,
				recoveredIntent.endpointGeneration!,
				recoveredIntent.createNonce!,
				recoveredEffect.payload.name,
				recoveredIntent.attachmentAuthorityId,
			);
			return;
		}
		const threadId = recoveredEffect.receipt?.threadId;
		if (!threadId) return;
		// Any durable mapping for this session is already session-level authority.
		// Do not let a terminal receipt reactivate an older remote thread merely
		// because its exact thread key is absent. Delete only this generation so a
		// later notification must mint a fresh nonce and provider effect.
		let hasSessionMappings = false;
		await this.#effects.withSessionMutationGate(effect.sessionId, async () => {
			hasSessionMappings = (await this.#sessionMappings(effect.sessionId!)).length > 0;
			if (!hasSessionMappings) return;
			const current = await this.#store.read(intentKey);
			const latestEffect = await this.#effects.read<CreateThreadPayload>(effectId);
			if (matchesCreateOperation(current, latestEffect)) await this.#store.delete(intentKey, current.generation);
		});
		if (hasSessionMappings) {
			return;
		}
		await this.#requireLiveBinding(
			recoveredIntent.sessionId!,
			recoveredIntent.endpointGeneration!,
			recoveredIntent.attachmentAuthorityId,
		);
		const key = discordConversationKey({
			appId: recoveredIntent.appId,
			guildId: recoveredIntent.guildId,
			parentChannelId: recoveredIntent.parentChannelId,
			threadId,
		});
		let committed = false;
		await this.#effects.withSessionMutationGate(effect.sessionId, async () => {
			const latestEffect = await this.#effects.read<CreateThreadPayload>(effectId);
			await this.#store.transactWithSnapshot(key, (old, conversations) => {
				const current = conversations[intentKey];
				if (
					old ||
					latestEffect?.state !== "terminal" ||
					latestEffect.receipt?.threadId !== threadId ||
					!matchesCreateOperation(current, latestEffect)
				)
					return old;
				committed = true;
				return normalizeDiscordConversation({
					generation: 1,
					state: "active",
					appId: current.appId,
					guildId: current.guildId,
					parentChannelId: current.parentChannelId,
					threadId,
					sessionId: current.sessionId,
					endpointGeneration: current.endpointGeneration,
					attachmentAuthorityId: current.attachmentAuthorityId,
					createNonce: current.createNonce,
					effectIncarnationId: current.createNonce,
					updatedAt: this.#now(),
					seenEventIds: [],
					seenInteractionIds: [],
				});
			});
		});
		if (committed)
			await this.#effects.withSessionMutationGate(effect.sessionId, async () => {
				const current = await this.#store.read(intentKey);
				const latestEffect = await this.#effects.read<CreateThreadPayload>(effectId);
				if (matchesCreateOperation(current, latestEffect)) await this.#store.delete(intentKey, current.generation);
			});
	}
	async #drainProviderEffects(): Promise<boolean> {
		let failed = false;
		for (const effect of await this.#effects.list()) {
			if (
				effect.transport !== "discord" ||
				(effect.state === "terminal" &&
					effect.kind !== "create-thread" &&
					effect.kind !== "archive" &&
					effect.kind !== "unarchive")
			)
				continue;
			if (this.#hasLiveEffectLease(effect)) continue;

			const payload = effect.payload as {
				guildId?: string;
				parentId?: string;
				name?: string;
				nonce?: string;
				threadId?: string;
				content?: string;
				components?: DiscordMessageComponent[];
				locked?: boolean;
				occurrenceId?: string;
			};
			const providerEffect =
				effect.kind === "post-message" || effect.kind === "archive" || effect.kind === "unarchive";
			if (
				providerEffect &&
				(!effect.sessionId ||
					!payload.threadId ||
					(effect.kind === "post-message" && payload.content === undefined))
			) {
				await this.#terminalizeEffect(effect.id, "stale_noop");

				continue;
			}
			try {
				if (effect.kind === "create-thread" && effect.sessionId && payload.nonce) {
					await this.#recoverCreateThread(effect, payload);
				}
				if (effect.kind === "post-message" && payload.threadId && payload.content !== undefined) {
					const record = await this.#byThread(
						this.options.guildId,
						this.options.parentChannelId,
						payload.threadId,
					);
					const closing = closingIntent(record);
					const closeMarker = !!closing && effect.id === this.#closeMarkerEffectId(record!);
					const inactiveFailure = effect.id.startsWith("failure:");
					if (
						!record ||
						(record.state !== "active" && !closeMarker && !inactiveFailure) ||
						record.endpointGeneration !== effect.endpointGeneration ||
						(effect.id.startsWith("action-publication:") && record.pendingActionEffectId !== effect.id)
					) {
						await this.#terminalizeEffect(effect.id, "stale_noop");
					} else {
						await this.#postEffect(
							effect.id,
							record,
							payload.content,
							payload.components,
							effect.id.startsWith("action-publication:"),
							closeMarker,
							inactiveFailure,
						);
					}
				}
				if ((effect.kind === "archive" || effect.kind === "unarchive") && payload.threadId) {
					const record = await this.#byThread(
						this.options.guildId,
						this.options.parentChannelId,
						payload.threadId,
					);
					const closing = closingIntent(record);
					const closeArchive =
						!!closing &&
						effect.kind === "archive" &&
						payload.locked === true &&
						effect.id === this.#closeArchiveEffectId(record!);
					const occurrenceId = payload.occurrenceId;
					const occurrenceMatches =
						closeArchive ||
						(!!record &&
							typeof occurrenceId === "string" &&
							effect.id === (effect.kind === "archive" ? record.archiveEffectId : record.resumeEffectId) &&
							(effect.kind === "archive"
								? record.archiveOccurrenceId === occurrenceId
								: record.resumeOccurrenceId === occurrenceId));
					if (
						!record ||
						(!closeArchive &&
							(effect.kind === "archive" ? record.state !== "active" : record.state !== "resuming")) ||
						record.endpointGeneration !== effect.endpointGeneration ||
						!occurrenceMatches
					) {
						await this.#terminalizeEffect(effect.id, "stale_noop");
					} else {
						await this.#threadEffect(effect.id, record, effect.kind, payload.locked, closeArchive, occurrenceId);
						if (!closeArchive && occurrenceId) {
							if (effect.kind === "archive") await this.#completeArchive(record, occurrenceId);
							else await this.#completeResume(record, occurrenceId);
						}
					}
				}
			} catch {
				failed = true; /* retained for a later journal-authoritative replay */
			}
		}
		return failed;
	}
	async #rescheduleAfterEffectTransition<T extends ChatEffect | undefined>(transition: Promise<T>): Promise<T> {
		const effect = await transition;
		if (effect?.state !== "terminal") await this.#scheduleLeaseRecovery();
		return effect;
	}
	async #scheduleLeaseRecovery(recoveryFailed = false): Promise<void> {
		if (!this.#started) return;
		const lifecycleGeneration = this.#lifecycleGeneration;
		const effects = await this.#effects.list();
		if (!this.#started || lifecycleGeneration !== this.#lifecycleGeneration) return;
		const now = this.#now();
		const recoveryAt = effects
			.filter(effect => effect.transport === "discord")
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
		if (recoveryAt === undefined) {
			if (this.#leaseRecoveryTimer !== undefined)
				this.#leaseRecoveryScheduler.clearTimeout(this.#leaseRecoveryTimer);
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			this.#leaseRecoveryFailures = 0;
			return;
		}
		if (this.#leaseRecoveryAt !== undefined && this.#leaseRecoveryAt <= recoveryAt) return;
		if (this.#leaseRecoveryTimer !== undefined) this.#leaseRecoveryScheduler.clearTimeout(this.#leaseRecoveryTimer);
		this.#leaseRecoveryAt = recoveryAt;
		const delay =
			recoveryAt <= now
				? Math.min(1_000, 25 * 2 ** Math.min(this.#leaseRecoveryFailures, 5))
				: Math.min(recoveryAt - now, 2_147_483_647);
		this.#leaseRecoveryTimer = this.#leaseRecoveryScheduler.setTimeout(() => {
			if (lifecycleGeneration !== this.#lifecycleGeneration) return;
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			return this.#track(this.#recoverLeasedEffects()).catch(() => {});
		}, delay);
	}
	async #recoverLeasedEffects(): Promise<void> {
		if (!this.#started) return;
		let failed = false;
		try {
			try {
				await this.#reconcileTerminalInboundReceipts();
				failed ||= await this.#recoverClosingConversations();
				failed ||= await this.#drainProviderEffects();
				await this.#reconcileTerminalInboundReceipts();
				failed ||= await this.#recoverClosingConversations();
			} catch {
				failed = true;
			}
			try {
				failed = (await this.#drainPendingDispatches()) || failed;
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
			}
		}
	}

	async #fail(threadId: string): Promise<void> {
		try {
			const record = await this.#byThread(this.options.guildId, this.options.parentChannelId, threadId);
			if (record)
				await this.#postEffect(
					`failure:${threadId}:${randomUUID()}`,
					record,
					FAILURE,
					undefined,
					false,
					false,
					true,
				);
		} catch {}
	}
}

function decodeCustomId(value: string): { generation: number; actionId: string; actionNonce: string } | undefined {
	const match = /^gjc:(\d+):([^:]+):([0-9a-f-]{36})$/.exec(value);
	if (!match) return undefined;
	const generation = Number(match[1]);
	return Number.isSafeInteger(generation) && generation >= 0
		? { generation, actionId: match[2]!, actionNonce: match[3]! }
		: undefined;
}

function stateRank(state: string): number {
	return state === "closing"
		? -1
		: state === "active"
			? 0
			: state === "resuming"
				? 1
				: state === "archived"
					? 2
					: state === "closed"
						? 3
						: 4;
}

function actionComponents(
	generation: number,
	actionId: string,
	actionNonce: string,
	options: string[],
): DiscordMessageComponent[] {
	return [
		{
			type: 1,
			components: [
				{
					type: 3,
					customId: `gjc:${generation}:${actionId}:${actionNonce}`,
					placeholder: "Choose an option",
					minValues: 1,
					maxValues: 1,
					options: options.slice(0, 25).map((option, index) => ({
						label: option.slice(0, 100) || `Option ${index + 1}`,
						value: String(index),
					})),
				},
			],
		},
	];
}

function componentAnswer(value: string | number): string | number {
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const index = Number(value);
		if (Number.isSafeInteger(index)) return index;
	}
	return value;
}

function discordEffectNonce(effectId: string): string {
	// Discord nonces are bounded; hash the durable effect identifier rather than
	// truncating its potentially shared prefix.
	return `gjc-${createHash("sha256").update(effectId).digest("hex").slice(0, 21)}`;
}
