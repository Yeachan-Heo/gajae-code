import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { type IndexedSession, SessionIndex } from "../broker/session-index";
import { SdkClient, SdkClientError } from "../client/client";
import { readSdkBrokerDiscovery, readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";
import { SESSION_PREPARED_EVENT } from "../host/host";
import { ACP_SESSION_RECONNECT } from "../session-reconnect";

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
	/**
	 * Announces that a replacement socket is live. Optional because command-scoped
	 * clients (the broker client, one-shot doubles) never outlive one socket, while
	 * every long-lived attachment's client carries it.
	 */
	onReconnect?(handler: () => void): () => void;
	/** Re-dials a retired socket; a no-op on a live one. */
	connect?(): Promise<void>;
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

/** One live frame held behind a replay barrier, kept with the sequence that orders it. */
type HeldFrame = Readonly<{ seq: number; frame: Record<string, unknown> }>;

/**
 * Which producer handed a frame to delivery.
 *
 * A reconnect has two at once — the replacement socket, whose subscription never
 * stopped, and the replay answer — and only the socket's frames may be held: the
 * barrier drains by re-entering delivery with the frames it holds, and holding those
 * a second time would never publish anything.
 */
type FrameOrigin = "live" | "ordered";

/**
 * Ingress fence one attachment applies while its replay is outstanding.
 *
 * `held` is non-undefined exactly while a replay round owns this attachment's live
 * ingress, and the array identity is that round's ticket: a later round or a disposal
 * installs or revokes its own, so an earlier round can tell it no longer owns the
 * buffer instead of stranding — or publishing — someone else's frames.
 */
type ReplayBarrier = {
	held: HeldFrame[] | undefined;
	detached: boolean;
	/**
	 * Set when a round could not close the gap it fenced — the replay went
	 * unanswered, or the hold buffer overflowed. The attachment stops delivering
	 * from that point on, because lifting the fence instead would let the next live
	 * frame drag the cursor over sequences nobody ever delivered.
	 */
	failed: boolean;
};

/**
 * How many live frames one attachment holds while its replay is outstanding.
 *
 * The window is a single round trip on an open socket, so the bound is only there
 * to keep a flooding session from growing the buffer without limit. Overflow is
 * barrier failure rather than an eviction: the oldest held frame is the one the
 * cursor needs next, and dropping the newest still leaves a hole no drain can
 * close, so the attachment is rebuilt from its cursor and its replay re-fetches
 * the whole gap instead.
 */
const REPLAY_BARRIER_LIMIT = 1_024;

/**
 * How many times one round re-issues a refused replay, and the backoff it doubles
 * from.
 *
 * A socket that never dropped sends no hello, so nothing but this round can
 * re-issue the replay it owes — `client.onReconnect` fires only for a new
 * connection id. The retry therefore rides the same live socket, and the budget is
 * bounded so a host that never serves the gap ends in a rebuild rather than a
 * barrier that fences ingress forever.
 */
const REPLAY_RETRY_ATTEMPTS = 3;
const REPLAY_RETRY_BACKOFF_MS = 100;

/**
 * How many rounds re-serve one sequence whose publication failed before it is conceded.
 *
 * A refused publication holds the cursor below its frame, and the rebuild that follows
 * re-serves exactly that frame. A surface that is down for good would repeat that
 * forever and deliver nothing else, so the rounds are bounded: past this count the frame
 * is conceded the way a retention gap is, and the stream resumes above it.
 */
const DELIVERY_ATTEMPT_LIMIT = 3;

type AttachedSession = Readonly<{
	id: string;
	sessionId: string;
	endpoint: SdkSessionEndpoint;
	generation: number;
	client: ChatDaemonSdkClient;
	/**
	 * How far this attachment has consumed its session's event stream. The record is
	 * frozen; this cursor is the one thing that must keep moving with delivery,
	 * because a reconnect resumes from exactly here.
	 */
	cursor: { seq: number };
	/**
	 * Ordering fence between the two producers a reconnect creates. Frozen with the
	 * record like the cursor; only its own fields move.
	 */
	barrier: ReplayBarrier;
	dispose: () => void;
}>;

/**
 * Default transport for one attached session.
 *
 * The attachment is long-lived — its frame subscription survives until an
 * explicit detach or endpoint roll — and it sits under the host's liveness
 * reaper, which drops any session that has not ponged within HEARTBEAT_TTL_MS.
 * The transport's one-shot defaults give up after 175ms, so every stall the host
 * reaps would be unrecoverable; the shared session budget outlives that TTL.
 */
async function connectAttachedSession(endpoint: SdkSessionEndpoint): Promise<ChatDaemonSdkClient> {
	return await SdkClient.connect(endpoint.url, endpoint.token, { ...ACP_SESSION_RECONNECT });
}

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

function readSequence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * What one `event_replay_result` states about the range it could not answer.
 *
 * A gap is the host's own admission, not an inference this side draws:
 * `sequence_gap` names sequences its ring has already evicted, and
 * `generation_reset` says the stream this cursor belongs to no longer exists.
 * Reading it whole — rather than treating every truthy `gap` alike — is what
 * keeps a bounded, nameable loss apart from an answer nothing can be concluded
 * from, and the two owe opposite responses.
 */
type ReplayGap =
	| Readonly<{ kind: "generation_reset"; toGeneration: number }>
	| Readonly<{ kind: "sequence_gap"; fromSeq: number; toSeq: number }>;

function readReplayGap(value: unknown): ReplayGap | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const gap = value as Record<string, unknown>;
	if (gap.kind === "generation_reset") {
		const toGeneration = readGeneration(gap.toGeneration);
		return toGeneration === undefined ? undefined : { kind: "generation_reset", toGeneration };
	}
	if (gap.kind !== "sequence_gap") return undefined;
	const fromSeq = readSequence(gap.fromSeq);
	const toSeq = readSequence(gap.toSeq);
	if (fromSeq === undefined || toSeq === undefined || toSeq < fromSeq) return undefined;
	return { kind: "sequence_gap", fromSeq, toSeq };
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
	/**
	 * The frame an attachment failed to publish, with how many rounds have tried it.
	 *
	 * Keyed by session rather than by attachment because the retire-and-rebuild a refused
	 * publication triggers replaces the attachment: the count has to outlive it, or a
	 * surface that is down for good would rebuild from the same sequence forever. It does
	 * not outlive the stream, though: a sequence names a frame only within one endpoint
	 * generation, so a rolled endpoint reopens a sequence space whose first frame nothing
	 * has ever been offered. Charging it for what an earlier generation's frame cost would
	 * concede it after a single refusal.
	 */
	readonly #undelivered = new Map<string, { generation: number; seq: number; attempts: number }>();
	readonly #reviving = new Set<string>();
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
		const resumable =
			existing !== undefined &&
			existing.endpoint.url === endpoint.url &&
			existing.endpoint.token === endpoint.token &&
			existing.generation === indexed.endpointGeneration;
		if (existing && resumable && !existing.barrier.failed) {
			// The attachment is current, so reconcile's remaining job is keeping its socket
			// dialed: `SdkClient` retires a closed socket and re-dials only on the next
			// request, and a passive subscription issues none.
			this.#reviveTransport(existing);
			return;
		}
		// A failed barrier is rebuilt rather than revived, and its cursor travels into the
		// replacement: same endpoint, same generation, same stream, so the replay this
		// attach issues asks for exactly the gap the failed round left open, and every
		// sequence already published stays below the cursor that drops it. A rolled
		// generation is a different stream, so that fence resets the cursor to zero.
		const resumeSeq = existing && resumable ? existing.cursor.seq : 0;
		if (existing) {
			this.#sessions.delete(indexed.sessionId);
			existing.dispose();
			await existing.client.close();
		}
		const client = await (this.deps.createClient ?? connectAttachedSession)(endpoint);
		let attached: AttachedSession | undefined;
		const barrier: ReplayBarrier = { held: undefined, detached: false, failed: false };
		const disposeFrames = client.onFrame(frame => {
			if (attached) this.schedule(this.enqueueFrame(attached, frame, "live"));
		});
		// The frame subscription is client-scoped and survives the socket, but a
		// replacement socket resumes delivery where the stream stands then. Only a replay
		// from this attachment's cursor closes the gap the drop left behind, and that cursor
		// is read here — synchronously with the hello — so the replay asks for exactly the
		// gap the barrier it opens is holding the replacement socket's frames ahead of.
		//
		// Deliberately outside `#pending`, like `#reviveTransport`: a replay that never
		// answers must not make `stop()` wait for it. Disposal revokes the barrier and
		// closing the client settles the request, so the round ends without publishing.
		const disposeReconnect = client.onReconnect?.(() => {
			if (attached) void this.#replayAttachment(attached, attached.cursor.seq).catch(() => undefined);
		});
		attached = Object.freeze({
			id: randomUUID(),
			sessionId: indexed.sessionId,
			endpoint,
			generation: indexed.endpointGeneration,
			client,
			cursor: { seq: resumeSeq },
			barrier,
			dispose: () => {
				disposeFrames();
				disposeReconnect?.();
				// A detached attachment's outstanding replay is dead work: revoking the
				// barrier here is what keeps its held frames off the newer attachment.
				barrier.detached = true;
				barrier.held = undefined;
			},
		});
		this.#sessions.set(indexed.sessionId, attached);
		this.#presentation?.connectSession(indexed.sessionId, {
			sendReply: route => {
				if (this.#sessions.get(indexed.sessionId) !== attached)
					throw new Error("Session endpoint changed before reply.");
				attached.client.send({ type: "reply", id: route.actionId, answer: route.answer });
			},
		});
		await this.#replayAttachment(attached, resumeSeq);
	}

	/**
	 * Keep an established attachment's socket dialed.
	 *
	 * `SdkClient` never opens a replacement socket on its own: it retires the closed
	 * incarnation and re-dials on the next `connect`/`request`. A chat attachment is
	 * purely passive, so without this probe a transient drop would silently end
	 * delivery for good. `connect()` resolves immediately on a live socket, spends the
	 * session reconnect budget on a dead one, and — because reconcile only reaches
	 * here for an endpoint it has just re-read as current at this generation — never
	 * revives an attachment the index has moved on from.
	 */
	#reviveTransport(attached: AttachedSession): void {
		const connect = attached.client.connect?.bind(attached.client);
		if (!connect || this.#reviving.has(attached.id)) return;
		this.#reviving.add(attached.id);
		// Deliberately outside `#pending`: the reconnect budget outlives the heartbeat
		// TTL, and `stop()` must not wait for it. Closing the client aborts it instead.
		void connect()
			.catch(() => undefined)
			.finally(() => this.#reviving.delete(attached.id));
	}

	/**
	 * Issue one replay for `attached` and publish its answer ahead of the live frames
	 * that raced it.
	 *
	 * A reconnect leaves two producers writing one stream: the replacement socket, whose
	 * subscription never stopped, and the replay answer. Ingress is therefore fenced for
	 * the whole round trip — frames the socket delivers after the hello are held, the
	 * replayed events are published first, and the held frames are drained afterwards in
	 * sequence order — so delivery follows sequence rather than arrival. Both paths
	 * publish through the same cursor, so an event both producers carried is published
	 * exactly once. Frames carrying no sequence of this attachment's own cannot be
	 * ordered against a replay at all, so they are never held and never delayed.
	 *
	 * The replay is fenced exactly like `attach()`: it is issued for the attachment's
	 * own endpoint generation and from its own cursor, and it is dropped whole if the
	 * runtime has since detached, rolled, or superseded this attachment — so a stale
	 * incarnation can never resurrect its events onto a newer one's root.
	 *
	 * A refused replay loses nothing either: the cursor stays where the request was
	 * issued from, the held frames stay held, and the round re-issues on the socket
	 * it already has. When that budget runs out the barrier fails whole and the
	 * attachment is rebuilt from its cursor. A replay that reports a retention gap
	 * is not a round to retry: the sequences it names are evicted at the host, so no
	 * rebuild can re-fetch them. That round concedes them instead — loudly — carries
	 * the cursor over them, and publishes the suffix the host did keep, so the gap
	 * costs exactly the sequences the host lost and nothing that follows them. The
	 * concession is what moves the cursor, not the suffix: a host that kept every
	 * sequence above the gap can still answer with none of them, and a cursor left
	 * below the lost range would concede it again on every later replay. A gap is
	 * conceded only where it answers this round's own request: one that opens above
	 * the cursor, or that the same answer returns retained events from, states no
	 * bounded loss and is fenced like any other answer nothing can be concluded from.
	 * What the host evicted is not what delivery lost: a sequence in the conceded
	 * range that the replacement socket already carried is held by this round's
	 * barrier, so it is published before the cursor steps over the rest.
	 */
	async #replayAttachment(attached: AttachedSession, sinceSeq: number): Promise<void> {
		if (!this.#attachmentLive(attached)) return;
		const held: HeldFrame[] = [];
		attached.barrier.held = held;
		try {
			let replay: Record<string, unknown>;
			for (let attempt = 0; ; attempt++) {
				try {
					replay = await attached.client.request({
						type: "event_replay",
						sinceGeneration: attached.generation,
						sinceSeq,
					});
					break;
				} catch {
					// An unanswered replay is a transport failure, not a delivery decision, and
					// the gap it owed is still owed: the cursor stays at `sinceSeq` and the held
					// frames stay held, so the retry asks for exactly the same gap. It is issued
					// on this attachment's own live socket, which is the only producer that can
					// close the gap when no hello is coming.
					if (attempt >= REPLAY_RETRY_ATTEMPTS) {
						this.#failBarrier(attached, "replay went unanswered");
						return;
					}
					await Bun.sleep(REPLAY_RETRY_BACKOFF_MS * 2 ** attempt);
					// A later round or a disposal may have taken this attachment's ingress over
					// while the retry waited. That round owes the same gap from the same cursor,
					// so this one stands down instead of asking for it twice.
					if (attached.barrier.held !== held) return;
					if (!this.#attachmentLive(attached)) return;
				}
			}
			if (attached.barrier.held !== held) return;
			if (!this.#attachmentLive(attached)) return;
			// The answer rides the same socket as the live frames that preceded it, but
			// ingress is a queue: a frame this socket already delivered can still be in
			// flight when the answer resolves, and the hold buffer does not carry it until
			// it lands. What live delivery already carried is therefore only readable once
			// that queue has caught up, so the round joins it before reading its own
			// answer — otherwise a conceded range would step the cursor over a sequence
			// still on its way into the buffer, and that frame would be dropped as already
			// delivered by a cursor no producer ever published it past.
			await this.#frameTails.get(attached.sessionId)?.catch(() => undefined);
			if (attached.barrier.held !== held) return;
			if (!this.#attachmentLive(attached)) return;
			// The answer's own events are read before anything is concluded from its gap: a
			// concession is only readable against the suffix it arrived with.
			const events = Array.isArray(replay.events)
				? replay.events.filter(
						(event): event is Record<string, unknown> =>
							!!event && typeof event === "object" && !Array.isArray(event),
					)
				: [];
			if (replay.gap !== undefined) {
				// The host answered, and its answer says part of what this cursor asked for
				// is gone for good. Neither a retry nor a rebuild can recover an evicted
				// sequence, so refusing to publish would trade a bounded loss for a total
				// outage on a healthy socket, and the 2-second reconcile would rebuild into
				// the same gap forever. Concede it instead — loudly — and publish the suffix
				// the host did keep, so the gap costs exactly the sequences the host lost and
				// nothing that follows them.
				const gap = readReplayGap(replay.gap);
				if (!gap) {
					this.#failBarrier(attached, "replay reported a gap it did not state");
					return;
				}
				if (gap.kind === "generation_reset") {
					// A reset stream shares no sequence space with this cursor, so nothing in
					// the answer can be ordered against it. Reconcile rebuilds against the
					// generation the index publishes now, which is a different fence entirely.
					this.#failBarrier(attached, `replay reported a generation reset to ${gap.toGeneration}`);
					return;
				}
				// A gap is a statement about this round's own request, so it is conceded only
				// where it answers one: it must open at the first sequence this round asked
				// for, and the suffix the host kept must sit entirely above it. A range this
				// cursor never asked about, or one the same answer returns events from, states
				// no bounded loss at all, and conceding it would fence off sequences the host
				// still holds — the one thing a retention gap must never cost.
				if (gap.fromSeq !== sinceSeq + 1) {
					this.#failBarrier(
						attached,
						`replay conceded sequences ${gap.fromSeq}-${gap.toSeq} for a request that resumed from seq ${sinceSeq}`,
					);
					return;
				}
				const retained = events
					.map(event => readSequence(event.seq))
					.find(seq => seq !== undefined && seq <= gap.toSeq);
				if (retained !== undefined) {
					this.#failBarrier(
						attached,
						`replay conceded sequences ${gap.fromSeq}-${gap.toSeq} while returning seq ${retained}`,
					);
					return;
				}
				// A sequence the host lost from its ring can still have arrived over the
				// replacement socket and be sitting in this round's hold buffer: the two
				// producers fail independently, so eviction at the host says nothing about
				// what live delivery already carried. Those frames are published here — in
				// sequence order, ahead of the retained suffix that sits above them — and
				// leave the buffer, so the concession costs only the sequences neither
				// producer holds and the drain cannot re-offer one the cursor just passed.
				const recovered = held.filter(entry => entry.seq <= gap.toSeq).sort((left, right) => left.seq - right.seq);
				const carried = held.filter(entry => entry.seq > gap.toSeq);
				held.splice(0, held.length, ...carried);
				const recoveredNote =
					recovered.length > 0 ? `, ${recovered.length} of them recovered from live delivery` : "";
				logger.warn(
					`chat daemon replay conceded a retention gap (sequences ${gap.fromSeq}-${gap.toSeq} are gone from the host${recoveredNote}); session ${attached.sessionId} generation ${attached.generation} resumes at seq ${gap.toSeq + 1}.`,
				);
				for (const entry of recovered) await this.enqueueFrame(attached, entry.frame, "ordered");
				// The concession itself carries the cursor over the rest of the lost range,
				// because the retained suffix cannot be trusted to do it: `SessionSdkHost`
				// drops capability-gated kinds from every replay answer, so a host that still
				// holds every sequence above the gap can legitimately answer with none of
				// them. A cursor left below a range no host can re-serve would resume the
				// next replay from the same evicted sequence and concede the same permanent
				// loss on every reconnect, forever.
				if (gap.toSeq > attached.cursor.seq) attached.cursor.seq = gap.toSeq;
			}
			for (const event of events) await this.enqueueFrame(attached, event, "ordered");
			await this.#drainHeldFrames(attached, held);
		} finally {
			// Only this round's own buffer is revoked: a later round or a disposal may have
			// installed its own, and clearing that one would strand the frames it holds.
			if (attached.barrier.held === held) attached.barrier.held = undefined;
		}
	}

	/**
	 * Whether `attached` is still the incarnation this runtime publishes through.
	 *
	 * Detachment, supersession, and a barrier that could not close its gap all retire
	 * an attachment the same way: whatever it still carries is dead work, and
	 * publishing any of it would either resurrect a stale incarnation or step the
	 * cursor over a sequence nobody delivered.
	 */
	#attachmentLive(attached: AttachedSession): boolean {
		return (
			!attached.barrier.detached && !attached.barrier.failed && this.#sessions.get(attached.sessionId) === attached
		);
	}

	/**
	 * Retire one attachment whose barrier could not close the gap it fenced.
	 *
	 * The cursor is left at the last contiguously published sequence and delivery
	 * stops there, so nothing can carry it over the gap. Reconcile then rebuilds the
	 * attachment against the same endpoint generation and hands that cursor to the
	 * replacement, whose replay re-fetches exactly what this round could not close —
	 * held frames are dropped only because that replay re-issues every one of them.
	 * Only an inconclusive round retires this way: a host that names what it lost is
	 * conceded where the answer is read, because no rebuild could recover it.
	 *
	 * Loud, because a barrier that cannot close is a transport fault rather than a
	 * delivery decision.
	 */
	#failBarrier(attached: AttachedSession, reason: string): void {
		if (attached.barrier.detached || attached.barrier.failed) return;
		attached.barrier.failed = true;
		attached.barrier.held = undefined;
		logger.warn(
			`chat daemon replay barrier failed (${reason}); rebuilding session ${attached.sessionId} at generation ${attached.generation} from seq ${attached.cursor.seq}.`,
		);
	}

	/**
	 * Retire one attachment whose frame reached a surface without landing on it.
	 *
	 * The cursor is delivery's record, so a frame no surface took must stay above it. The
	 * attachment is retired exactly like one whose barrier failed, and the rebuild replays
	 * from a cursor that still sits below the frame. Later frames cannot drag the cursor
	 * over it either, because a retired attachment publishes nothing.
	 *
	 * The rounds are bounded, because a surface that is down for good would re-serve that
	 * same sequence forever and never deliver another. On the last one the frame is
	 * conceded — loudly, like a retention gap — and the cursor steps over it, since a
	 * stream that never advances again loses every later frame instead of just this one.
	 */
	#failDelivery(attached: AttachedSession, seq: number, error: unknown): void {
		const previous = this.#undelivered.get(attached.sessionId);
		const attempts = previous?.generation === attached.generation && previous.seq === seq ? previous.attempts + 1 : 1;
		const reason = error instanceof Error ? error.message : String(error);
		if (attempts >= DELIVERY_ATTEMPT_LIMIT) {
			this.#undelivered.delete(attached.sessionId);
			attached.cursor.seq = seq;
			logger.warn(
				`chat daemon conceded seq ${seq} of session ${attached.sessionId} at generation ${attached.generation} after ${attempts} refused publications (${reason}); delivery resumes above it.`,
			);
			return;
		}
		this.#undelivered.set(attached.sessionId, { generation: attached.generation, seq, attempts });
		this.#failBarrier(attached, `publication failed at seq ${seq} (${reason})`);
	}

	/**
	 * Publish what this round held, lowest sequence first, then reopen live ingress.
	 *
	 * Frames keep arriving while the drain runs, so the barrier is only lifted by a pass
	 * that finds nothing left to publish: lifting it earlier would let a frame arriving
	 * mid-drain overtake one still held. That lift is synchronous with the emptiness
	 * check, because anything queued behind an await could otherwise land in a buffer
	 * nobody owns any more.
	 */
	async #drainHeldFrames(attached: AttachedSession, held: HeldFrame[]): Promise<void> {
		for (;;) {
			if (attached.barrier.held !== held) return;
			if (!this.#attachmentLive(attached)) return;
			if (held.length === 0) {
				attached.barrier.held = undefined;
				return;
			}
			const batch = held.splice(0, held.length).sort((left, right) => left.seq - right.seq);
			for (const entry of batch) await this.enqueueFrame(attached, entry.frame, "ordered");
		}
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
	private enqueueFrame(attached: AttachedSession, frame: Record<string, unknown>, origin: FrameOrigin): Promise<void> {
		const previous = this.#frameTails.get(attached.sessionId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(async () => await this.handleFrame(attached, frame, origin));
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
	private async handleFrame(
		attached: AttachedSession,
		frame: Record<string, unknown>,
		origin: FrameOrigin,
	): Promise<void> {
		if (!this.#attachmentLive(attached)) return;
		// Correlate before anything is acted on. A frame whose envelope and payload
		// disagree on session, lifecycle identity, or lifecycle generation is not a
		// usable event, so it is dropped whole — no close, resume, notify, resolve,
		// root, or mapping mutation — on the replay path and the live path alike.
		const correlated = correlateFrame(frame);
		if (!correlated) return;
		// One event delivered under this attachment's identity is one sequence, and a
		// reconnect leaves two producers carrying it: the replacement socket, whose
		// subscription never stopped, and the replay answer. So the cursor both orders
		// delivery and settles it. A sequence at or below the cursor was already
		// published and is rejected outright rather than merely declining to advance,
		// or the frame both producers carried is published twice; and every sequence
		// above it advances the cursor, including the ones the filters below drop,
		// because a cursor left behind by dropped-but-delivered frames would re-deliver
		// every notification interleaved with them. The fences are the two `attach()`
		// already applies — this session, this endpoint generation — so a foreign or
		// superseded frame neither moves the cursor nor enters the barrier.
		const seq = typeof frame.seq === "number" && Number.isSafeInteger(frame.seq) ? frame.seq : undefined;
		const ownsSequence =
			correlated.generation === attached.generation &&
			(correlated.sessionId === undefined || correlated.sessionId === attached.sessionId);
		if (seq !== undefined && ownsSequence) {
			if (seq <= attached.cursor.seq) return;
			const held = attached.barrier.held;
			if (held && origin === "live") {
				// A replay is outstanding, so where this frame sits in the stream is not
				// settled yet: hold it, and let the drain place it after the answer.
				if (held.length >= REPLAY_BARRIER_LIMIT) {
					// Overflow is not a choice between frames: evicting the oldest silently
					// skips the sequence the cursor needs next, and evicting the newest leaves
					// a hole no drain can close. So the barrier fails whole instead, and the
					// rebuild re-fetches the gap from this attachment's own cursor — the host
					// answers with whatever of it survived, and names the rest as lost.
					this.#failBarrier(attached, `hold buffer overflowed at ${REPLAY_BARRIER_LIMIT} frames`);
					return;
				}
				held.push({ seq, frame });
				return;
			}
		}
		// Publication is the delivery boundary. The cursor records what was delivered, so
		// it may pass this sequence only once every configured surface has taken the
		// frame: moving it first turns one refused publication into permanent loss,
		// because the next replay would resume above a frame nobody ever published.
		// Rebuilds and replays retain this stream identity, so an acknowledgement that
		// disappears after provider acceptance is reconciled as the same publication.
		const publicationId =
			seq !== undefined && ownsSequence ? `${attached.sessionId}:${attached.generation}:${seq}` : undefined;
		try {
			await this.#publishFrame(attached, correlated, publicationId);
		} catch (error) {
			// An unsequenced frame has no cursor to hold back, so its failure stays a
			// rejection for the frame queue to absorb.
			if (seq === undefined || !ownsSequence) throw error;
			this.#failDelivery(attached, seq, error);
			return;
		}
		if (seq !== undefined && ownsSequence) {
			this.#undelivered.delete(attached.sessionId);
			// The publish was awaited, so a concession may have carried the cursor past this
			// sequence in the meantime. Delivery records a sequence; it never rewinds one.
			if (seq > attached.cursor.seq) attached.cursor.seq = seq;
		}
	}

	/**
	 * Publish one correlated frame to every surface this runtime fans out to.
	 *
	 * Split from sequencing so the two outcomes stay distinguishable: returning means the
	 * frame is delivered — published, or deliberately dropped by a filter that leaves
	 * nothing to publish — and throwing means no surface took it. Only the caller moves
	 * the cursor, and only on the first.
	 */
	async #publishFrame(attached: AttachedSession, correlated: CorrelatedFrame, publicationId?: string): Promise<void> {
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
			await this.resume(sessionId, attached.generation, "GJC session ready.", publicationId);
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
				...(publicationId === undefined ? {} : { publicationId }),
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
				publicationId,
			);
	}

	private async close(sessionId: string): Promise<void> {
		this.#undelivered.delete(sessionId);
		await this.#discord?.close(sessionId);
		await this.#slack?.close(sessionId);
	}

	// Each surface takes the identity on the call that actually publishes, so a retry
	// reconciles the attempt it retries instead of adding a second message. Discord's
	// resume only unarchives the thread — the publication, and the nonce reconciled
	// against it, belong to the notify below. Slack's resume rolls the root over and
	// posts the body itself, so it carries the identity directly.
	private async resume(sessionId: string, generation: number, content: string, publicationId?: string): Promise<void> {
		if (this.#discord) {
			await this.#discord.resume(sessionId, generation);
			await this.#discord.notify({
				sessionId,
				endpointGeneration: generation,
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
