import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type IndexedSession, SessionIndex } from "../broker/session-index";
import { SdkClient, SdkClientError } from "../client/client";
import { readSdkBrokerDiscovery, readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";
import { SESSION_PREPARED_EVENT } from "../host/host";

import { createDiscordAdapter, createSlackAdapter } from "./chat-adapters";
import { type ChatTransport, projectChatCommandOutcome, sendAuthorizedChatOperation } from "./chat-command-policy";
import type { ChatDaemonCommandBindInput, ChatDaemonCommandOutcome } from "./chat-daemon-command-channel";
import type { ChatDaemonKind } from "./chat-daemon-control";
import { isControlPlaneFrameType } from "./control-plane-frames";
import { type DiscordEndpointBinding, DiscordEndpointBindingError, DiscordNotificationDaemon } from "./discord-daemon";
import { DiscordLiveProvider } from "./discord-live-provider";
import type { DiscordProvider } from "./discord-provider";
import { type NotificationEvent, NotificationPresentationEngine } from "./engine";
import {
	type SlackBindingAuthority,
	type SlackEndpoint,
	SlackEndpointBindingError,
	SlackNotificationDaemon,
} from "./slack-daemon";
import { SlackLiveProvider } from "./slack-live-provider";
import { SlackProvider, type SlackProviderClient } from "./slack-provider";
import { resolveSessionBindingAuthority, SlackThreadBindingError } from "./slack-thread-binding";

export interface ChatDaemonRuntimeConfig {
	identity: string;
	notifications: {
		discord?: { botToken: string; applicationId: string; guildId: string; parentChannelId: string };
		slack?: { botToken: string; appToken: string; workspaceId: string; channelId: string; authorizedUserId?: string };
	};
	presentation?: { redact: boolean; verbosity: "lean" | "verbose" };
}

export interface ChatDaemonSdkClient {
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void;
	request(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
	close(): Promise<void>;
	send(frame: Record<string, unknown>): void;
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
	if (error instanceof ChatDeliveryError) return error.phase;
	if (!(error instanceof SdkClientError)) return undefined;
	// `connection_closed` conveys no send-progress guarantee: SdkClient also emits it
	// when a pending, already-sent request loses its response.
	return ["connection_closed", "unavailable", "timeout", "reconnect_exhausted", "protocol_error"].includes(error.code)
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
	createClient?: (endpoint: SdkSessionEndpoint) => Promise<ChatDaemonSdkClient>;
	createIndex?: (agentDir: string) => SessionIndex;
	createBrokerClient?: (endpoint: { url: string; token: string }) => Promise<ChatDaemonSdkClient>;
	onReconciled?: () => void;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}

type AttachedSession = Readonly<{
	id: string;
	sessionId: string;
	endpoint: SdkSessionEndpoint;
	generation: number;
	client: ChatDaemonSdkClient;
	dispose: () => void;
}>;

/**
 * The lifecycle signals that decide whether a chat root exists at all. They are
 * the only event names that close, resume, or withhold a session's publication,
 * so their identity may never be assembled from two disagreeing representations
 * of one frame.
 */
const LIFECYCLE_EVENT_NAMES: ReadonlySet<string> = new Set([
	SESSION_PREPARED_EVENT,
	"session_ready",
	"session_closed",
	"session_terminated",
]);

function isLifecycleEvent(name: string | undefined): boolean {
	return name !== undefined && LIFECYCLE_EVENT_NAMES.has(name);
}

/**
 * Names whose presence obliges a frame to mean exactly one thing. Lifecycle
 * signals decide whether a chat root exists at all; control-plane
 * discriminants may never be presented at all. Either identity appearing on
 * only one of a frame's two representations is a smuggling attempt, not an
 * event.
 */
function isReservedIdentity(name: string | undefined): boolean {
	return isLifecycleEvent(name) || isControlPlaneFrameType(name);
}

/** One delivered frame reduced to a single event identity. */
type CorrelatedFrame = Readonly<{
	/** The event body a notification is projected from. */
	body: Record<string, unknown>;
	name: string | undefined;
	sessionId: string | undefined;
	generation: number | undefined;
}>;

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
	key: "sessionId" | "generation" | "name" | "kind",
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
	return {
		body,
		name: envelopeName.value ?? bodyName,
		sessionId: sessionId.value,
		generation: generation.value,
	};
}

/**
 * Worker-owned session discovery and event fanout. It connects only through the
 * public SDK transport and retains endpoint tokens solely in live client objects.
 */
export class ChatDaemonRuntime {
	readonly #sessions = new Map<string, AttachedSession>();
	readonly #index: SessionIndex;
	#stopTimer: (() => void) | undefined;
	readonly #pending = new Set<Promise<void>>();
	readonly #frameTails = new Map<string, Promise<void>>();
	#reconcileTail: Promise<void> = Promise.resolve();

	#discord: DiscordNotificationDaemon | undefined;
	#slack: SlackNotificationDaemon | undefined;
	#presentation: NotificationPresentationEngine | undefined;
	#transportHealthy: (() => boolean) | undefined;
	#reconcileReady = false;

	constructor(
		private readonly input: { kind: ChatDaemonKind; agentDir: string; config: ChatDaemonRuntimeConfig },
		private readonly deps: ChatDaemonRuntimeDeps = {},
	) {
		this.#index = deps.createIndex?.(input.agentDir) ?? new SessionIndex(input.agentDir);
	}

	async start(): Promise<void> {
		if (this.input.kind === "discord") {
			const config = this.input.config.notifications.discord;
			if (!config) throw new Error("Discord chat daemon provider configuration is unavailable.");
			const provider = (
				this.deps.createDiscordProvider ??
				((value: NonNullable<ChatDaemonRuntimeConfig["notifications"]["discord"]>) =>
					new DiscordLiveProvider(value))
			)(config);
			this.#transportHealthy = () => this.#reconcileReady && (provider.transportHealthy ?? true);
			this.#presentation = new NotificationPresentationEngine(
				[createDiscordAdapter({ channelId: config.parentChannelId })],
				{
					redact: this.input.config.presentation?.redact ?? true,
					sessionTag: sessionId => sessionId.slice(-6),
				},
			);
			this.#discord = new DiscordNotificationDaemon({
				agentDir: this.input.agentDir,
				repo: "",
				guildId: config.guildId,
				parentChannelId: config.parentChannelId,
				provider,
				resolveEndpoint: async sessionId => this.#discordEndpoint(sessionId),
				onCommand: async (sessionId, content, endpoint, idempotencyKey) => {
					const attached = this.#sessions.get(sessionId);
					if (!attached || !endpoint.isCurrent())
						throw new DiscordEndpointBindingError("Discord session endpoint changed before command dispatch.");
					return await this.#runChatCommand("discord", sessionId, content, attached.client, idempotencyKey);
				},
			});
		} else {
			const config = this.input.config.notifications.slack;
			if (!config) throw new Error("Slack chat daemon provider configuration is unavailable.");
			const provider = (
				this.deps.createSlackProvider ??
				((value: NonNullable<ChatDaemonRuntimeConfig["notifications"]["slack"]>) => new SlackLiveProvider(value))
			)(config);
			this.#transportHealthy = () => this.#reconcileReady && (provider.transportHealthy ?? true);
			this.#presentation = new NotificationPresentationEngine(
				[createSlackAdapter({ channelId: config.channelId })],
				{
					redact: this.input.config.presentation?.redact ?? true,
					sessionTag: sessionId => sessionId.slice(-6),
				},
			);
			this.#slack = new SlackNotificationDaemon({
				agentDir: this.input.agentDir,
				repo: "",
				teamId: config.workspaceId,
				channelId: config.channelId,
				provider: new SlackProvider(provider),
				authorizeActor: async actorId => config.authorizedUserId === actorId,
				createClient: endpoint => {
					const attached = this.#sessions.get(endpoint.sessionId);
					if (
						!attached ||
						attached.generation !== endpoint.generation ||
						attached.endpoint.url !== endpoint.url ||
						attached.endpoint.token !== endpoint.token
					)
						throw new SlackEndpointBindingError();
					return {
						send: frame => {
							if (this.#sessions.get(endpoint.sessionId) !== attached) throw new SlackEndpointBindingError();
							attached.client.send(frame);
						},
					};
				},
				resolveEndpoint: async sessionId => await this.resolveEndpoint(sessionId),
				resolveBindingAuthority: async sessionId => await this.#slackBindingAuthority(sessionId),
				onCommand: async (sessionId, content, endpoint, idempotencyKey) => {
					const attached = this.#sessions.get(sessionId);
					if (
						!attached ||
						attached.generation !== endpoint.generation ||
						attached.endpoint.url !== endpoint.url ||
						attached.endpoint.token !== endpoint.token
					)
						throw new SlackEndpointBindingError("Slack session endpoint changed before command dispatch.");
					return await this.#runChatCommand("slack", sessionId, content, attached.client, idempotencyKey);
				},
			});
		}
		try {
			await this.#serialReconcile();
			if (this.#discord) await this.#discord.start();
			if (this.#slack) await this.#slack.start();
			const timer = (this.deps.setInterval ?? setInterval)(() => {
				this.schedule(this.#serialReconcile());
			}, 2_000);
			this.#stopTimer = () => (this.deps.clearInterval ?? clearInterval)(timer);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	transportHealthy(): boolean {
		return this.#transportHealthy?.() ?? false;
	}

	async stop(): Promise<void> {
		if (this.#stopTimer) this.#stopTimer();
		this.#stopTimer = undefined;
		await Promise.all([this.#discord?.stop(), this.#slack?.stop()]);
		this.#discord = undefined;
		this.#slack = undefined;
		this.#presentation = undefined;
		this.#transportHealthy = undefined;
		this.#reconcileReady = false;
		await Promise.allSettled([...this.#pending]);
		for (const [sessionId, attached] of this.#sessions) {
			this.#sessions.delete(sessionId);
			attached.dispose();
			await attached.client.close();
		}
	}

	#serialReconcile(): Promise<void> {
		const task = this.#reconcileTail
			.catch(() => undefined)
			.then(async () => {
				try {
					await this.reconcile();
					this.#reconcileReady = true;
					this.deps.onReconciled?.();
				} catch (error) {
					this.#reconcileReady = false;
					throw error;
				}
			});
		this.#reconcileTail = task;
		return task;
	}
	private async reconcile(): Promise<void> {
		await this.#index.open();
		await this.#index.refresh();
		const live = this.#index.listSessions().sessions.filter(session => session.live);
		const ids = new Set(live.map(session => session.sessionId));
		for (const session of live) await this.attach(session);
		for (const [sessionId, attached] of this.#sessions) {
			if (ids.has(sessionId)) continue;
			this.#sessions.delete(sessionId);
			attached.dispose();
			await attached.client.close();
			await this.close(sessionId);
		}
	}

	private async attach(indexed: IndexedSession): Promise<void> {
		const repo = path.resolve(indexed.locator.repo);
		const defaultStateRoot = path.join(repo, ".gjc", "state");
		const indexedStateRoot = path.resolve(indexed.locator.stateRoot);
		const scope =
			indexedStateRoot === defaultStateRoot
				? "default"
				: indexedStateRoot === path.join(defaultStateRoot, "chat")
					? "chat"
					: undefined;
		if (!scope || indexed.endpointMtimeMs === undefined) return;
		const endpoint = await readSdkSessionEndpoint(repo, indexed.sessionId, scope);
		if (!endpoint || endpoint.stale) return;
		const endpointStat = await fs.stat(endpoint.path).catch(() => undefined);
		if (!endpointStat || endpointStat.mtimeMs !== indexed.endpointMtimeMs) return;
		const existing = this.#sessions.get(indexed.sessionId);
		if (
			existing &&
			existing.endpoint.url === endpoint.url &&
			existing.endpoint.token === endpoint.token &&
			existing.generation === indexed.endpointGeneration
		)
			return;
		if (existing) {
			this.#sessions.delete(indexed.sessionId);
			existing.dispose();
			await existing.client.close();
		}
		const client = await (this.deps.createClient ?? (async value => await SdkClient.connect(value.url, value.token)))(
			endpoint,
		);
		let attached: AttachedSession | undefined;
		const dispose = client.onFrame(frame => {
			if (attached) this.schedule(this.enqueueFrame(attached, frame));
		});
		attached = Object.freeze({
			id: randomUUID(),
			sessionId: indexed.sessionId,
			endpoint,
			generation: indexed.endpointGeneration,
			client,
			dispose,
		});
		this.#sessions.set(indexed.sessionId, attached);
		this.#presentation?.connectSession(indexed.sessionId, {
			sendReply: route => {
				if (this.#sessions.get(indexed.sessionId) !== attached)
					throw new Error("Session endpoint changed before reply.");
				attached.client.send({ type: "reply", id: route.actionId, answer: route.answer });
			},
		});
		const replay = await client.request({
			type: "event_replay",
			sinceGeneration: indexed.endpointGeneration,
			sinceSeq: 0,
		});
		if (Array.isArray(replay.events))
			for (const event of replay.events)
				if (event && typeof event === "object" && !Array.isArray(event))
					await this.enqueueFrame(attached, event as Record<string, unknown>);
	}

	private async resolveEndpoint(sessionId: string): Promise<SlackEndpoint | null> {
		const attached = this.#sessions.get(sessionId);
		return attached ? { ...attached.endpoint, generation: attached.generation } : null;
	}

	/**
	 * Exact authority for adopting an existing root: the runtime must currently
	 * hold this session's attachment, the index must still list it as live and
	 * non-terminal with an intact replay, and its discovery endpoint must be
	 * readable, non-stale, and owned by the indexed host pid at the same
	 * generation. Re-reading the attachment afterwards rejects a session that
	 * detached or rolled while the index and endpoint were being consulted.
	 */
	async #slackBindingAuthority(sessionId: string): Promise<SlackBindingAuthority | undefined> {
		const attached = this.#sessions.get(sessionId);
		if (!attached) return undefined;
		const authority = await resolveSessionBindingAuthority({ sessionIndex: this.#index, sessionId });
		if (!authority || authority.endpointGeneration !== attached.generation) return undefined;
		if (this.#sessions.get(sessionId) !== attached) return undefined;
		return { sessionId, endpointGeneration: attached.generation };
	}

	/**
	 * Adopt an operator-supplied Slack root for one attached session. Returns a
	 * machine-readable rejection instead of throwing so the daemon control plane
	 * can answer without exposing internal failure detail.
	 */
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
			// `binding_outcome_unknown` is the store's typed statement that the
			// mapping may already be applied. It must travel as an indeterminate
			// outcome, never as a rejection the operator could act on.
			const code = error instanceof SlackThreadBindingError ? error.code : "binding_failed";
			return code === "binding_outcome_unknown"
				? { ok: false, certainty: "unknown", code }
				: { ok: false, certainty: "rejected", code };
		}
	}
	#discordEndpoint(sessionId: string): DiscordEndpointBinding | null {
		const attached = this.#sessions.get(sessionId);
		if (!attached) return null;
		return {
			generation: attached.generation,
			isCurrent: () => this.#sessions.get(sessionId) === attached,
			send: frame => {
				if (this.#sessions.get(sessionId) !== attached) throw new DiscordEndpointBindingError();
				attached.client.send(frame);
			},
		};
	}

	private schedule(task: Promise<void>): void {
		this.#pending.add(task);
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		);
	}
	private enqueueFrame(attached: AttachedSession, frame: Record<string, unknown>): Promise<void> {
		const previous = this.#frameTails.get(attached.sessionId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(async () => await this.handleFrame(attached, frame));
		this.#frameTails.set(attached.sessionId, current);
		void current.then(
			() => {
				if (this.#frameTails.get(attached.sessionId) === current) this.#frameTails.delete(attached.sessionId);
			},
			() => {
				if (this.#frameTails.get(attached.sessionId) === current) this.#frameTails.delete(attached.sessionId);
			},
		);
		return current;
	}
	private async handleFrame(attached: AttachedSession, frame: Record<string, unknown>): Promise<void> {
		if (this.#sessions.get(attached.sessionId) !== attached) return;
		// Correlate before anything is acted on. A frame whose envelope and payload
		// disagree on session, lifecycle identity, or lifecycle generation is not a
		// usable event, so it is dropped whole — no close, resume, notify, resolve,
		// root, or mapping mutation — on the replay path and the live path alike.
		const correlated = correlateFrame(frame);
		if (!correlated) return;
		const normalizedFrame = correlated.body;
		// The SDK's own request/response traffic arrives on this same observer:
		// `SdkClient` settles a pending request and still forwards that frame to
		// every handler. A protocol answer carries no user-visible content, so it
		// is dropped here — ahead of presentation fanout and of every root,
		// mapping, resume, close, and action mutation — on both delivery paths.
		// Its nested payload is discarded with it and never reprojected.
		const bodyType = typeof normalizedFrame.type === "string" ? normalizedFrame.type : undefined;
		if (isControlPlaneFrameType(correlated.name) || isControlPlaneFrameType(bodyType)) return;
		if (normalizedFrame.type === "turn_stream" && normalizedFrame.phase === "live") return;
		if (correlated.sessionId !== undefined && correlated.sessionId !== attached.sessionId) return;
		const sessionId = attached.sessionId;
		const name = correlated.name;
		if (name === "session_closed" || name === "session_terminated") {
			await this.close(sessionId);
			return;
		}
		// `session_prepared` is control-plane evidence only: the session holds
		// endpoint authority while deliberately withholding readiness. It carries no
		// user-visible content and must never create or adopt a root, notify, or
		// resume — at this attachment's generation or any other. Foreign session ids
		// are already rejected above, so every prepared frame is inert here, and a
		// stale or foreign one cannot mutate state either.
		if (name === SESSION_PREPARED_EVENT || bodyType === SESSION_PREPARED_EVENT) return;
		if (name === "session_ready") {
			if (correlated.generation !== attached.generation) return;
			await this.resume(sessionId, attached.generation, "GJC session ready.");
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
				endpointGeneration: attached.generation,
				content,
				...(notification.type === "action_needed"
					? { actionId: notification.id, options: notification.options }
					: {}),
			});
		if (this.#slack)
			await this.#slack.notify(
				sessionId,
				content,
				notification.type === "action_needed" ? notification.id : undefined,
				attached.generation,
			);
	}

	private async close(sessionId: string): Promise<void> {
		await this.#discord?.close(sessionId);
		await this.#slack?.close(sessionId);
	}

	private async resume(sessionId: string, generation: number, content: string): Promise<void> {
		if (this.#discord) {
			await this.#discord.resume(sessionId, generation);
			await this.#discord.notify({ sessionId, endpointGeneration: generation, content });
		}
		if (this.#slack) await this.#slack.resume(sessionId, content, generation);
	}
	async #runChatCommand(
		transport: ChatTransport,
		sessionId: string,
		content: string,
		boundClient?: ChatDaemonSdkClient,
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
				const client = boundClient ?? this.#sessions.get(sessionId)?.client;
				if (!client) throw new ChatDeliveryError("pre_send");
				return await client.request(
					kind === "control"
						? { type: "control_request", operation, input, confirm: true, idempotencyKey }
						: { type: "query_request", query: operation, input, idempotencyKey },
				);
			});
		} catch (error) {
			const phase = chatDeliveryPhase(error);
			if (phase) throw error instanceof ChatDeliveryError ? error : new ChatDeliveryError(phase);
			if (!(error instanceof SdkClientError)) throw new ChatDeliveryError("ambiguous");
			outcome = {
				ok: false,
				error: {
					code: error.code,
					message: error.message,
				},
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
		const discovery = await readSdkBrokerDiscovery(this.input.agentDir);
		if (!discovery) throw new ChatDeliveryError("pre_send");
		let client: ChatDaemonSdkClient;
		try {
			client = await (
				this.deps.createBrokerClient ?? (async endpoint => await SdkClient.connect(endpoint.url, endpoint.token))
			)({ url: discovery.url, token: discovery.token });
		} catch {
			throw new ChatDeliveryError("pre_send");
		}
		try {
			return await client.request({ type: "broker_request", operation, input, idempotencyKey });
		} finally {
			await client.close();
		}
	}
	async #postCommandOutcome(
		transport: ChatTransport,
		sessionId: string,
		request: Pick<import("./chat-command-policy").ChatOperationRequest, "kind" | "operation">,
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
