import { randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import { SdkClientError } from "../client/client";
import { SESSION_PREPARED_EVENT } from "../host/host";

import type { SessionRouterDeps } from "../router";

import { type SessionAttachment, SessionRouter, SessionRouterError, type SessionRouterFrame } from "../router";

import { createDiscordAdapter, createSlackAdapter } from "./chat-adapters";
import {
	type ChatOperationRequest,
	type ChatTransport,
	projectChatCommandOutcome,
	sendAuthorizedChatOperation,
} from "./chat-command-policy";
import type { ChatDaemonCommandBindInput, ChatDaemonCommandOutcome } from "./chat-daemon-command-channel";
import type { ChatDaemonKind } from "./chat-daemon-control";
import { isControlPlaneFrameType } from "./control-plane-frames";
import { DiscordNotificationDaemon } from "./discord-daemon";

import { DiscordLiveProvider } from "./discord-live-provider";
import type { DiscordProvider } from "./discord-provider";
import { type NotificationEvent, NotificationPresentationEngine } from "./engine";
import { SlackNotificationDaemon } from "./slack-daemon";
import { SlackLiveProvider } from "./slack-live-provider";
import { SlackProvider, type SlackProviderClient } from "./slack-provider";
import { SlackThreadBindingError } from "./slack-thread-binding";

export interface ChatDaemonRuntimeConfig {
	identity: string;
	notifications: {
		discord?: { botToken: string; applicationId: string; guildId: string; parentChannelId: string };
		slack?: { botToken: string; appToken: string; workspaceId: string; channelId: string; authorizedUserId?: string };
	};
	presentation?: { redact: boolean; verbosity: "lean" | "verbose" };
}

export type ChatDeliveryPhase = "pre_send" | "ambiguous";

/** An authorized SDK command could not be conclusively delivered. */
export class ChatDeliveryError extends Error {
	constructor(readonly phase: ChatDeliveryPhase) {
		super("Authorized chat SDK command delivery failed.");
		this.name = "ChatDeliveryError";
	}
}

function chatDeliveryPhase(error: unknown): ChatDeliveryPhase | undefined {
	if (error instanceof SessionRouterError) return error.phase;

	if (error instanceof ChatDeliveryError) return error.phase;
	if (!(error instanceof SdkClientError)) return undefined;
	// `uncertain_after_send` is the one code that states outright that the frame
	// reached the host: reporting it as a definite failure would tell the operator a
	// prompt was rejected while the session may already be running it.
	return [
		"connection_closed",
		"unavailable",
		"timeout",
		"reconnect_exhausted",
		"protocol_error",
		"uncertain_after_send",
	].includes(error.code)
		? "ambiguous"
		: undefined;
}

export interface ChatDaemonRuntimeDeps {
	createDiscordProvider?: (
		config: NonNullable<ChatDaemonRuntimeConfig["notifications"]["discord"]>,
	) => DiscordProvider;
	createSlackProvider?: (
		config: NonNullable<ChatDaemonRuntimeConfig["notifications"]["slack"]>,
	) => SlackProviderClient;
	routerDeps?: SessionRouterDeps;
}

/** The lifecycle signals that decide whether a chat root exists at all. */
const LIFECYCLE_EVENT_NAMES: ReadonlySet<string> = new Set([
	SESSION_PREPARED_EVENT,
	"session_ready",
	"session_closed",
	"session_terminated",
]);

function isLifecycleEvent(name: string | undefined): boolean {
	return name !== undefined && LIFECYCLE_EVENT_NAMES.has(name);
}

function isReservedIdentity(name: string | undefined): boolean {
	return isLifecycleEvent(name) || isControlPlaneFrameType(name);
}

/**
 * Chat notifications in lean mode are an answer surface, not a mirror of the
 * session protocol. Lifecycle, identity, and activity frames remain available
 * to verbose consumers, while finalized answers and action-needed events are
 * delivered in lean mode.
 */
export function shouldPublishChatFrame(
	frame: Record<string, unknown>,
	verbosity: "lean" | "verbose" | undefined,
): boolean {
	if (verbosity !== "lean") return frame.type !== "turn_stream" || frame.phase !== "live";
	return frame.type === "turn_stream" && frame.phase === "finalized" && frame.finalAnswer === true;
}

/**
 * A final answer's message ref identifies its one rendered message even when
 * the SDK transport delivers an unpositioned duplicate frame.
 */
export function publicationIdForFinalChatAnswer(sessionId: string, frame: Record<string, unknown>): string | undefined {
	if (
		frame.type !== "turn_stream" ||
		frame.phase !== "finalized" ||
		frame.finalAnswer !== true ||
		typeof frame.messageRef !== "string" ||
		frame.messageRef.length === 0
	)
		return undefined;
	return `turn:${sessionId}:${frame.messageRef}`;
}

/** One delivered frame reduced to a single event identity. */
type CorrelatedFrame = SessionRouterFrame;

function eventPayload(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	if (frame.type !== "event") return undefined;
	const payload = frame.payload;
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: undefined;
}

function readEventName(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readSessionId(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function readGeneration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readSequence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * What one representation of a frame states about an identity it owns.
 *
 * `absent` means the representation does not own the property at all. `invalid`
 * means it owns the property while stating something that cannot be that
 * identity — which is not the same thing, because reading an invalid duplicate
 * as absent silently promotes the other representation to sole authority over a
 * frame that stated two.
 */
type IdentityClaim<T> = Readonly<{ state: "absent" } | { state: "invalid" } | { state: "stated"; value: T }>;

const ABSENT_IDENTITY: IdentityClaim<never> = { state: "absent" };

/**
 * Read one representation's claim about `key`.
 *
 * Ownership of the property is the claim, never its value: a representation
 * that owns `key` has stated it, so `undefined` is a malformed statement rather
 * than silence. Value equality cannot tell the two apart, and treating an owned
 * `undefined` as absence is exactly what lets a frame state one identity twice
 * while only one of the two is ever checked.
 */
function identityClaim<T>(
	frame: Record<string, unknown> | undefined,
	key: "sessionId" | "generation" | "name" | "kind" | "seq",
	read: (value: unknown) => T | undefined,
): IdentityClaim<T> {
	if (!frame || !Object.hasOwn(frame, key)) return ABSENT_IDENTITY;
	const value = read(frame[key]);
	return value === undefined ? { state: "invalid" } : { state: "stated", value };
}

/**
 * Reduce one identity stated by both representations of a frame to one value.
 *
 * A duplicated identity is a single authority tuple: when both sides supply it
 * they must both be well-typed and equal, whatever the event's class. A claim
 * that cannot be the identity it names is never reconciled at all — on either
 * side, and whether or not the other side stated anything — because the only
 * alternative is to let the frame proceed under an identity it contradicted. A
 * single-sided identity is read from the side that supplied it, so ordinary
 * wrappers that carry the identity only on the envelope stay compatible.
 */
function reconcileIdentity<T>(
	envelope: IdentityClaim<T>,
	payload: IdentityClaim<T>,
): Readonly<{ ok: true; value: T | undefined } | { ok: false }> {
	if (envelope.state === "invalid" || payload.state === "invalid") return { ok: false };
	if (envelope.state === "absent") return { ok: true, value: payload.state === "stated" ? payload.value : undefined };
	if (payload.state === "absent") return { ok: true, value: envelope.value };
	return envelope.value === payload.value ? { ok: true, value: envelope.value } : { ok: false };
}

/**
 * Reduce the two spellings of one event envelope's identity to a single name.
 *
 * `name` and `kind` are aliases, not two authorities: the host emits ordinary
 * frames as `{ kind: <payload.type>, payload }` and lifecycle signals as
 * `{ name: <lifecycle>, … }`, so a frame that owns only one is read from that
 * one. Owning both obliges them to be well-typed and exactly equal. Preferring
 * either alias would let a benign transport name clear lifecycle and
 * control-plane filtering while the other spelling carries the reserved
 * identity — `control_response`, `session_closed`, `event_replay_result` — that
 * a later step consumes.
 */
function envelopeEventName(
	frame: Record<string, unknown>,
): Readonly<{ ok: true; value: string | undefined } | { ok: false }> {
	if (frame.type !== "event") return { ok: true, value: undefined };
	return reconcileIdentity(identityClaim(frame, "name", readEventName), identityClaim(frame, "kind", readEventName));
}

/**
 * Reduce one delivered frame to a single event identity, or reject it whole.
 *
 * An event envelope and its payload are two representations of one event, never
 * two authorities. The host emits ordinary frames as `{ kind: <payload.type>,
 * payload }` and lifecycle signals unwrapped as `{ name: <lifecycle>,
 * sessionId, generation }`, so a frame that names a different session, a
 * different generation, or a different lifecycle identity in each representation
 * is malformed. Correlating first is what stops the envelope from clearing one
 * filter while the payload supplies the identity a later step consumes.
 *
 * Different semantic layers stay legal: an ordinary transport envelope may name
 * `notification` while its payload carries an unrelated event `type`. A reserved
 * identity — a lifecycle signal or a control-plane discriminant — on either side
 * additionally obliges both sides to agree on the event name, and a duplicated
 * session or generation is read from the single side that supplied it.
 *
 * The envelope's own `name`/`kind` aliases are reduced first, before the payload
 * is projected at all, so a frame whose two spellings disagree is inert ahead of
 * every filter and every mutation rather than after one of them.
 */
function correlateFrame(frame: Record<string, unknown>): CorrelatedFrame | undefined {
	const envelopeName = envelopeEventName(frame);
	if (!envelopeName.ok) return undefined;
	const payload = eventPayload(frame);
	const body = payload ?? frame;
	const sessionId = reconcileIdentity(
		identityClaim(frame, "sessionId", readSessionId),
		identityClaim(payload, "sessionId", readSessionId),
	);
	if (!sessionId.ok) return undefined;
	const bodyName = typeof body.type === "string" ? body.type : undefined;
	// A reserved marker on either side must be the frame's whole identity: an
	// envelope that says something else is smuggling a lifecycle signal past
	// lifecycle filtering, or a control-plane body past control-plane filtering.
	if (
		payload &&
		envelopeName.value !== bodyName &&
		(isReservedIdentity(envelopeName.value) || isReservedIdentity(bodyName))
	)
		return undefined;
	const generation = reconcileIdentity(
		identityClaim(frame, "generation", readGeneration),
		identityClaim(payload, "generation", readGeneration),
	);
	if (!generation.ok) return undefined;
	const seq = reconcileIdentity(
		identityClaim(frame, "seq", readSequence),
		identityClaim(payload, "seq", readSequence),
	);
	if (!seq.ok) return undefined;
	return {
		body,
		name: envelopeName.value ?? bodyName,
		sessionId: sessionId.value,
		generation: generation.value,
		seq: seq.value,
	};
}

/**
 * Worker-owned session discovery and event fanout. It connects only through the
 * public SDK transport and retains SDK credentials solely in live client objects.
 */
export class ChatDaemonRuntime {
	readonly #router: SessionRouter;
	readonly #attachments = new Map<string, SessionAttachment>();
	readonly #cleanupWork = new Map<string, Promise<void>>();
	readonly #retirementWork = new Map<string, Promise<void>>();
	readonly #attachmentBarriers = new Map<string, Promise<void>>();
	readonly #cleanupFailures = new Map<string, unknown>();
	#replayReady: Promise<void> = Promise.resolve();
	#stopping = false;
	#discord: DiscordNotificationDaemon | undefined;
	#slack: SlackNotificationDaemon | undefined;
	#presentation: NotificationPresentationEngine | undefined;
	#transportHealthy: (() => boolean) | undefined;

	constructor(
		private readonly input: { kind: ChatDaemonKind; agentDir: string; config: ChatDaemonRuntimeConfig },
		private readonly deps: ChatDaemonRuntimeDeps = {},
	) {
		this.#router = new SessionRouter({
			agentDir: input.agentDir,
			correlateFrame,
			deps: {
				...deps.routerDeps,
				onFrame: async (attachment, frame) => await this.#handleFrame(attachment, frame),
				onAttachment: async attachment => this.#onAttachment(attachment),
				onReplayReady: async () => await this.#replayReady,
				onSessionRemoved: async (attachment, reason) => await this.#onSessionRemoved(attachment, reason),
			},
		});
	}

	async start(): Promise<void> {
		const replayReady = Promise.withResolvers<void>();
		this.#replayReady = replayReady.promise;
		// Startup can fail before any attachment observes the replay barrier. Mark
		// the rejection handled without changing what actual waiters observe.
		void this.#replayReady.catch(() => undefined);
		if (this.#cleanupWork.size > 0 || this.#retirementWork.size > 0) {
			const retirements = [...this.#retirementWork.entries()];
			const cleanup = [...this.#cleanupWork.values()];
			const retirement = retirements.map(([, work]) => work);
			const settled = await Promise.race([
				Promise.all([Promise.allSettled(cleanup), Promise.allSettled(retirement)]).then(() => true),
				Bun.sleep(5_000).then(() => false),
			]);
			if (!settled) throw new Error("Prior provider cleanup did not settle before chat daemon restart.");
			const failures = await Promise.all([Promise.allSettled(cleanup), Promise.allSettled(retirement)]);
			const rejected = failures
				.flat()
				.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (rejected.length > 0) {
				logger.warn(`SDK chat daemon retained ${rejected.length} prior cleanup failure(s) for recovery.`);
			}
			for (const [sessionId, work] of retirements)
				if (this.#retirementWork.get(sessionId) === work && !rejected.some(result => result.status === "rejected"))
					this.#retirementWork.delete(sessionId);
			for (const [sessionId, work] of [...this.#cleanupWork.entries()])
				if (work !== undefined && !rejected.some(result => result.status === "rejected"))
					this.#cleanupWork.delete(sessionId);
		}
		this.#attachments.clear();
		const retainedProvider =
			this.input.kind === "discord"
				? this.#discord?.restartBlocked()
					? this.#discord
					: undefined
				: this.#slack?.restartBlocked()
					? this.#slack
					: undefined;
		if (retainedProvider) {
			try {
				await this.#router.start();
				await retainedProvider.start();
				replayReady.resolve();
				return;
			} catch (error) {
				replayReady.reject(error);
				await this.#router.stop().catch(() => undefined);
				throw error;
			}
		}
		if (this.input.kind === "discord") {
			const config = this.input.config.notifications.discord;
			if (!config) throw new Error("Discord chat daemon provider configuration is unavailable.");
			const provider = (
				this.deps.createDiscordProvider ??
				((value: NonNullable<ChatDaemonRuntimeConfig["notifications"]["discord"]>) =>
					new DiscordLiveProvider(value))
			)(config);
			this.#transportHealthy = () => this.#router.isReady() && (provider.transportHealthy ?? true);
			this.#presentation = new NotificationPresentationEngine(
				[createDiscordAdapter({ channelId: config.parentChannelId })],
				{
					redact: this.input.config.presentation?.redact ?? true,
				},
			);
			this.#discord = new DiscordNotificationDaemon({
				agentDir: this.input.agentDir,
				guildId: config.guildId,
				parentChannelId: config.parentChannelId,
				provider,
				resolveAttachment: (sessionId, expectedGeneration) =>
					this.#router.attachment(sessionId, expectedGeneration),
				onCommand: async (sessionId, content, attachment, idempotencyKey) =>
					await this.#runChatCommand("discord", sessionId, content, attachment, idempotencyKey),
			});
		} else {
			const config = this.input.config.notifications.slack;
			if (!config) throw new Error("Slack chat daemon provider configuration is unavailable.");
			const provider = (
				this.deps.createSlackProvider ??
				((value: NonNullable<ChatDaemonRuntimeConfig["notifications"]["slack"]>) => new SlackLiveProvider(value))
			)(config);
			this.#transportHealthy = () => this.#router.isReady() && (provider.transportHealthy ?? true);
			this.#presentation = new NotificationPresentationEngine(
				[createSlackAdapter({ channelId: config.channelId })],
				{
					redact: this.input.config.presentation?.redact ?? true,
				},
			);
			this.#slack = new SlackNotificationDaemon({
				agentDir: this.input.agentDir,
				repo: "",
				teamId: config.workspaceId,
				channelId: config.channelId,
				provider: new SlackProvider(provider),
				authorizeActor: async actorId => config.authorizedUserId === actorId,
				resolveAttachment: async sessionId => this.#router.attachment(sessionId),
				resolveBindingAuthority: async sessionId => await this.#router.bindingAuthority(sessionId),
				onCommand: async (sessionId, content, attachment, idempotencyKey) =>
					await this.#runChatCommand("slack", sessionId, content, attachment, idempotencyKey),
			});
		}
		try {
			await this.#router.start();
			if (this.#discord) await this.#discord.start();
			if (this.#slack) await this.#slack.start();
			replayReady.resolve();
		} catch (error) {
			replayReady.reject(error);
			await this.stop();
			throw error;
		}
	}

	transportHealthy(): boolean {
		return this.#transportHealthy?.() ?? false;
	}

	/** Reconcile indexed attachments and optionally wait for their replay tails. */
	async reconcile(options: { waitForReplay?: boolean } = {}): Promise<void> {
		await this.#router.reconcile(options);
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		let routerError: unknown;
		try {
			await this.#router.stop();
		} catch (error) {
			routerError = error;
		}
		const cleanupDrain = Promise.allSettled([...this.#cleanupWork.values(), ...this.#retirementWork.values()]);
		const cleanupSettled = await Promise.race([cleanupDrain.then(() => true), Bun.sleep(5_000).then(() => false)]);
		const cleanupResults = cleanupSettled
			? await cleanupDrain
			: [{ status: "rejected" as const, reason: new Error("Provider cleanup exceeded shutdown drain.") }];
		if (!cleanupSettled)
			logger.warn("SDK chat daemon cleanup exceeded the shutdown drain; provider stop will invalidate it.");
		const providerResults = await Promise.allSettled([this.#discord?.stop(), this.#slack?.stop()]);
		const discordRestartBlocked = this.#discord?.restartBlocked() ?? false;
		const slackRestartBlocked = this.#slack?.restartBlocked() ?? false;
		if (!discordRestartBlocked) this.#discord = undefined;
		if (!slackRestartBlocked) this.#slack = undefined;
		if (!discordRestartBlocked && !slackRestartBlocked) {
			this.#presentation = undefined;
			this.#transportHealthy = undefined;
		}
		this.#stopping = false;
		const failures = [
			...(routerError === undefined ? [] : [{ status: "rejected" as const, reason: routerError }]),
			...cleanupResults,
			...providerResults,
		].filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0)
			throw new AggregateError(
				failures.map(result => result.reason),
				"Provider shutdown failed after Router authority revocation.",
			);
	}

	/** Adopt an operator-supplied Slack root through the provider's presentation store. */
	async bindExistingRoot(request: ChatDaemonCommandBindInput): Promise<ChatDaemonCommandOutcome> {
		const slack = this.#slack;
		if (!slack) return { ok: false, certainty: "rejected", code: "target_not_configured" };
		try {
			const bound = await slack.bindExistingRoot(request.sessionId, request.rootTs, request.commitAuthority);
			if (!bound.rootTs || bound.endpointGeneration === undefined)
				return { ok: false, certainty: "rejected", code: "binding_failed" };
			return {
				ok: true,
				sessionId: request.sessionId,
				endpointGeneration: bound.endpointGeneration,
				teamId: bound.teamId,
				channelId: bound.channelId,
				rootTs: bound.rootTs,
			};
		} catch (error) {
			const code = error instanceof SlackThreadBindingError ? error.code : "binding_failed";
			return code === "binding_outcome_unknown"
				? { ok: false, certainty: "unknown", code }
				: { ok: false, certainty: "rejected", code };
		}
	}

	async #onAttachment(attachment: SessionAttachment): Promise<void> {
		const revivedTransport = this.#attachments.get(attachment.sessionId) === attachment;
		this.#attachments.set(attachment.sessionId, attachment);
		if (revivedTransport) {
			this.#presentation?.connectSession(attachment.sessionId, {
				sendReply: route => attachment.send({ type: "reply", id: route.actionId, answer: route.answer }),
			});
			return;
		}
		const discord = this.#discord;
		const slack = this.#slack;
		const barrier = (async () => {
			const retirement = this.#retirementWork.get(attachment.sessionId);
			let retirementFailure: unknown;
			if (retirement) {
				try {
					await retirement;
				} catch (error) {
					retirementFailure = error;
					logger.warn(`SDK chat daemon retirement cleanup failed before successor attachment: ${String(error)}`);
				}
			}
			const cleanup = this.#cleanupWork.get(attachment.sessionId);
			if (cleanup) await cleanup.catch(error => logger.warn(`SDK cleanup retry pending: ${String(error)}`));
			const [discordRecovered, slackRecovered] = await Promise.all([
				discord?.recoverCleanup(attachment.sessionId, attachment.generation, attachment.authorityId) ?? true,
				slack?.recoverCleanup(attachment.sessionId, attachment.generation, attachment.authorityId) ?? true,
			]);
			if (!discordRecovered || !slackRecovered)
				throw new Error("successor_attachment_blocked_until_retirement_is_verified");
			if (cleanup !== undefined && this.#cleanupWork.get(attachment.sessionId) === cleanup) {
				this.#cleanupWork.delete(attachment.sessionId);
				this.#cleanupFailures.delete(attachment.sessionId);
			}
			if (
				retirementFailure !== undefined &&
				retirement &&
				this.#retirementWork.get(attachment.sessionId) === retirement
			)
				this.#retirementWork.delete(attachment.sessionId);
		})();
		this.#attachmentBarriers.set(attachment.sessionId, barrier);
		try {
			await barrier;
			if (this.#attachments.get(attachment.sessionId) !== attachment) return;
			this.#presentation?.connectSession(attachment.sessionId, {
				sendReply: route => attachment.send({ type: "reply", id: route.actionId, answer: route.answer }),
			});
		} finally {
			if (this.#attachmentBarriers.get(attachment.sessionId) === barrier)
				this.#attachmentBarriers.delete(attachment.sessionId);
		}
	}

	async #onSessionRemoved(
		attachment: SessionAttachment,
		reason: "removed" | "replaced" | "replaced_same_generation" = "removed",
	): Promise<void> {
		if (this.#attachments.get(attachment.sessionId) !== attachment) return;
		if (reason === "replaced_same_generation") {
			const retirement = this.#trackRetirement(attachment);
			this.#attachments.delete(attachment.sessionId);
			await retirement;
			return;
		}
		this.#attachments.delete(attachment.sessionId);
		if (reason === "removed" && !this.#stopping) await this.#trackCleanup(attachment);
	}

	#trackRetirement(attachment: SessionAttachment): Promise<void> {
		const sessionId = attachment.sessionId;
		const discord = this.#discord;
		const slack = this.#slack;
		const previous = this.#retirementWork.get(sessionId);
		const work = (
			previous
				? previous.catch(error => {
						this.#cleanupFailures.set(sessionId, error);
					})
				: Promise.resolve()
		).then(async () => {
			// Capture the predecessor providers before stop() can clear the runtime
			// fields. The successor barrier owns this promise until every retirement
			// waiter settles, even when takeover overlaps worker shutdown.
			await discord?.retireAttachment(sessionId, attachment.generation);
			await slack?.retireAttachment(sessionId, attachment.generation);
		});
		this.#retirementWork.set(sessionId, work);
		void work.then(
			() => {
				if (this.#retirementWork.get(sessionId) === work) this.#retirementWork.delete(sessionId);
			},
			() => undefined,
		);
		return work;
	}

	async #handleFrame(attachment: SessionAttachment, correlated: CorrelatedFrame): Promise<void> {
		if (this.#attachments.get(attachment.sessionId) !== attachment) return;
		await this.#attachmentBarriers.get(attachment.sessionId);
		if (this.#attachments.get(attachment.sessionId) !== attachment) return;
		const normalizedFrame = correlated.body;
		const publicationId =
			publicationIdForFinalChatAnswer(attachment.sessionId, normalizedFrame) ?? correlated.publicationId;
		const bodyType = typeof normalizedFrame.type === "string" ? normalizedFrame.type : undefined;
		if (isControlPlaneFrameType(correlated.name) || isControlPlaneFrameType(bodyType)) return;
		if (normalizedFrame.type === "turn_stream" && normalizedFrame.phase === "live") return;
		if (correlated.sessionId !== undefined && correlated.sessionId !== attachment.sessionId) return;
		const sessionId = attachment.sessionId;
		const name = correlated.name;
		if (name === "session_closed" || name === "session_terminated") {
			await this.#trackCleanup(attachment);
			return;
		}
		if (name === SESSION_PREPARED_EVENT || bodyType === SESSION_PREPARED_EVENT) return;
		if (name === "session_ready") {
			// The attachment itself is the endpoint-generation authority. An
			// unpositioned session_ready frame deliberately carries no ring
			// generation; reject only an explicit, conflicting Router-owned value.
			if (correlated.generation !== undefined && correlated.generation !== attachment.generation) return;
			await this.#resume(
				sessionId,
				attachment.generation,
				attachment.authorityId,
				"GJC session ready.",
				publicationId,
			);
			return;
		}
		const notification = this.#notificationEvent(sessionId, normalizedFrame);
		if (notification?.type === "action_resolved") {
			await Promise.all([
				this.#discord?.resolveAction(sessionId, notification.id),
				this.#slack?.resolveAction(sessionId, notification.id),
			]);
			return;
		}
		if (!notification) return;
		if (
			notification.type === "frame" &&
			!shouldPublishChatFrame(normalizedFrame, this.input.config.presentation?.verbosity)
		)
			return;
		const payload = this.#presentation?.fanout(notification)[0];
		const body = payload?.body;
		const content =
			body && typeof body === "object" && !Array.isArray(body)
				? typeof (body as Record<string, unknown>).content === "string"
					? (body as Record<string, unknown>).content
					: (body as Record<string, unknown>).text
				: undefined;
		if (typeof content !== "string") return;
		if (this.#discord)
			await this.#discord.notify({
				sessionId,
				endpointGeneration: attachment.generation,
				attachmentAuthorityId: attachment.authorityId,
				content,
				...(publicationId === undefined ? {} : { publicationId }),
				...(notification.type === "action_needed"
					? { actionId: notification.id, options: notification.options }
					: {}),
			});
		if (this.#slack)
			await this.#slack.notify(
				sessionId,
				content,
				notification.type === "action_needed" && notification.kind === "ask" ? notification.id : undefined,
				attachment.generation,
				publicationId,
			);
	}

	#trackCleanup(attachment: SessionAttachment): Promise<void> {
		const sessionId = attachment.sessionId;
		const previous = this.#cleanupWork.get(sessionId);
		const work = (
			previous
				? previous.catch(error => {
						this.#cleanupFailures.set(sessionId, error);
					})
				: Promise.resolve()
		).then(async () => {
			await this.#closeProviders(attachment);
		});
		this.#cleanupWork.set(sessionId, work);
		void work.then(
			() => {
				if (this.#cleanupWork.get(sessionId) === work) {
					this.#cleanupWork.delete(sessionId);
					this.#cleanupFailures.delete(sessionId);
				}
			},
			() => undefined,
		);
		return work;
	}
	async #closeProviders(attachment: SessionAttachment): Promise<void> {
		const discord = this.#discord;
		const slack = this.#slack;
		await discord?.close(attachment.sessionId, attachment.generation);
		await slack?.close(attachment.sessionId, undefined, attachment.generation);
	}

	async #resume(
		sessionId: string,
		generation: number,
		attachmentAuthorityId: string | undefined,
		content: string,
		publicationId?: string,
	): Promise<void> {
		if (this.#discord) {
			await this.#discord.resume(sessionId, generation, attachmentAuthorityId);
			await this.#discord.notify({
				sessionId,
				endpointGeneration: generation,
				attachmentAuthorityId,
				content,
				...(publicationId === undefined ? {} : { publicationId }),
			});
		}
		if (this.#slack) await this.#slack.resume(sessionId, content, generation, publicationId);
	}

	async #runChatCommand(
		transport: ChatTransport,
		sessionId: string,
		content: string,
		expectedAttachment: SessionAttachment,
		idempotencyKey: string = randomUUID(),
	): Promise<boolean> {
		const match = /^\/sdk\s+(control|query|global)\s+([^\s]+)(?:\s+(.+))?\s*$/.exec(content);
		if (!match) return false;
		const kind = match[1] as "control" | "query" | "global";
		let input: unknown = {};
		if (match[3]) {
			try {
				input = JSON.parse(match[3]);
			} catch {
				return false;
			}
		}
		if (!input || typeof input !== "object" || Array.isArray(input)) return false;
		const operation = match[2]!;
		let outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
		try {
			outcome = await sendAuthorizedChatOperation(transport, { kind, operation, input }, async () => {
				if (kind === "global")
					return await this.#runGlobalCommand(operation, input as Record<string, unknown>, idempotencyKey);
				if (!expectedAttachment.isCurrent()) throw new ChatDeliveryError("pre_send");
				return await this.#router.request(
					sessionId,
					kind === "control"
						? { type: "control_request", operation, input, confirm: true, idempotencyKey }
						: { type: "query_request", query: operation, input, idempotencyKey },
					expectedAttachment.generation,
					expectedAttachment,
				);
			});
		} catch (error) {
			const phase = chatDeliveryPhase(error);
			if (phase) throw error instanceof ChatDeliveryError ? error : new ChatDeliveryError(phase);
			if (!(error instanceof SdkClientError)) throw new ChatDeliveryError("ambiguous");
			outcome = {
				ok: false,
				error: { code: error.code, message: error.message },
			};
		}
		await this.#postCommandOutcome(transport, sessionId, { kind, operation }, outcome);
		return outcome.ok;
	}

	async #runGlobalCommand(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey: string,
	): Promise<Record<string, unknown>> {
		if (operation !== "session.list") throw new ChatDeliveryError("pre_send");
		try {
			return await this.#router.listBrokerSessions(input, idempotencyKey);
		} catch (error) {
			if (error instanceof SessionRouterError) throw new ChatDeliveryError(error.phase);
			throw error;
		}
	}

	async #postCommandOutcome(
		transport: ChatTransport,
		sessionId: string,
		request: Pick<ChatOperationRequest, "kind" | "operation">,
		outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } },
	): Promise<void> {
		const content = JSON.stringify(projectChatCommandOutcome(request, outcome));
		if (transport === "discord") await this.#discord?.postCommandResult(sessionId, content);
		else await this.#slack?.postCommandResult(sessionId, content);
	}

	#notificationEvent(sessionId: string, frame: Record<string, unknown>): NotificationEvent {
		if (frame.type === "action_needed" && typeof frame.id === "string" && typeof frame.kind === "string") {
			return {
				type: "action_needed",
				id: frame.id,
				kind: frame.kind,
				sessionId,
				...(typeof frame.question === "string" ? { question: frame.question } : {}),
				...(Array.isArray(frame.options) && frame.options.every(option => typeof option === "string")
					? { options: frame.options.filter((option): option is string => typeof option === "string") }
					: {}),
				...(typeof frame.summary === "string" ? { summary: frame.summary } : {}),
			};
		}
		if (frame.type === "action_resolved" && typeof frame.id === "string")
			return { type: "action_resolved", id: frame.id, sessionId };
		return { type: "frame", sessionId, frame };
	}
}
