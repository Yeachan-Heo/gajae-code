import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, resolveEquivalentPath } from "@gajae-code/utils";
import {
	SessionIndex as DefaultSessionIndex,
	type IndexedSession,
	isSessionAuthorityEligible,
	type SessionIndex,
} from "../broker/session-index";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { SdkClient } from "../client/client";
import { readSdkBrokerDiscovery, readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";
import {
	type ActivatedPreparedSession,
	type PreparedSessionActivationClient,
	requestPreparedSessionActivation,
	SessionActivationError,
} from "../session-activation";
import { ACP_SESSION_RECONNECT, SESSION_REQUEST_TIMEOUT_MS } from "../session-reconnect";

/**
 * Exact identity of one attached SDK session endpoint. Providers persist it next to
 * their conversation state and re-prove it before every resume, so it must be derived
 * in exactly one place: a caller that recomputes the digest by hand silently stops
 * matching the moment the bound fields change.
 */
export function sessionAttachmentAuthorityId(input: {
	sessionId: string;
	generation: number;
	pid: number;
	endpointMtimeMs: number | undefined;
	url: string;
	token: string;
}): string {
	const endpointAuthorityDigest = crypto
		.createHash("sha256")
		.update(JSON.stringify({ url: input.url, token: input.token }))
		.digest("hex");
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
				endpointAuthorityDigest,
			}),
		)
		.digest("hex");
}

/** The only capability a provider may retain for an attached SDK session. */
export interface SessionAttachment {
	readonly sessionId: string;
	readonly authorityId?: string;
	/** Current Router-owned transport identity for this exact attachment's reverse leases. */
	readonly connectionId?: string;
	readonly generation: number;
	isCurrent(): boolean;
	send(frame: Record<string, unknown>): unknown;
	/** Revoke this exact capability after provider admission or replay fails closed. */
	retire?(): Promise<void>;
}

/**
 * Provider-local notification capability. This is deliberately not an
 * attachment lease: it carries no endpoint, connection, generation, or
 * authority identity and its cancellation can only stop this subscription.
 */
export interface NotificationSubscription {
	readonly sessionId: string;
	readonly subscriptionId: string;
	readonly cursor: { readonly generation: number; readonly seq: number };
	readonly isActive: () => boolean;
	readonly send: (frame: Record<string, unknown>) => unknown;
	readonly advanceCursor: (generation: number, seq: number) => void;
	readonly cancel: (reason?: string) => void;
}

export type NotificationCleanupState = "pending" | "failed" | "completed";

export interface NotificationCleanupReceipt {
	readonly subscriptionId: string;
	readonly sessionId: string;
	readonly state: NotificationCleanupState;
	readonly reason?: string;
}

/** The transport surface Router keeps private behind its attachment capabilities. */
export interface SessionRouterClient {
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void;
	onReconnect?(handler: () => void): () => void;
	connect?(): Promise<void>;
	request(frame: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
	/** Current private transport connection identity, surfaced only through its exact attachment. */
	readonly connectionId?: string;

	close(): Promise<void>;
	send(frame: Record<string, unknown>): void;
}

/** One frame after the caller's envelope/payload identity correlation. */
export interface SessionRouterFrame {
	readonly body: Record<string, unknown>;
	readonly name: string | undefined;
	readonly sessionId: string | undefined;
	readonly generation: number | undefined;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly publicationId?: string;
	readonly seq?: number;
}

export type SessionRouterFrameCorrelator = (frame: Record<string, unknown>) => SessionRouterFrame | undefined;

export interface SessionRouterDeps {
	createClient?: (authority: {
		readonly sessionId: string;
		readonly generation: number;
		readonly pid: number;
		readonly endpointMtimeMs: number;
	}) => Promise<SessionRouterClient>;
	createIndex?: (agentDir: string) => SessionIndex;
	createBrokerClient?: () => Promise<SessionRouterClient>;
	/** Receives only an opaque capability and correlated provider-neutral frames. */
	onFrame?: (attachment: SessionAttachment, frame: SessionRouterFrame) => Promise<void> | void;
	onAttachment?: (attachment: SessionAttachment) => Promise<void> | void;
	/** Called only after the opaque capability becomes externally current. */
	onAttachmentReady?: (attachment: SessionAttachment) => Promise<void> | void;
	/** Called when the Broker index no longer reports an attached session as live. */
	onSessionRemoved?: (
		attachment: SessionAttachment,
		reason?: "removed" | "replaced" | "replaced_same_generation",
	) => Promise<void> | void;
	/** Narrow provider surface for notification consumers such as Telegram. */
	onNotificationSubscription?: (subscription: NotificationSubscription) => Promise<void> | void;
	onNotificationSubscriptionReady?: (subscription: NotificationSubscription) => Promise<void> | void;
	onNotificationFrame?: (subscription: NotificationSubscription, frame: SessionRouterFrame) => Promise<void> | void;
	onNotificationSubscriptionRemoved?: (
		subscription: NotificationSubscription,
		reason?: "removed" | "replaced" | "replaced_same_generation" | "cancelled",
	) => Promise<void> | void;
	onReconciled?: () => void;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
}

export type SessionRouterProviderDeps = Pick<
	SessionRouterDeps,
	| "createClient"
	| "createIndex"
	| "createBrokerClient"
	| "setInterval"
	| "clearInterval"
	| "setTimeout"
	| "clearTimeout"
	| "onReconciled"
>;

export interface SessionRouterOptions {
	agentDir: string;
	deps?: SessionRouterDeps;
	/** Runtime-specific identity validation; Router supplies a conservative fallback. */
	correlateFrame?: SessionRouterFrameCorrelator;
}

export type SessionRouterErrorPhase = "pre_send" | "ambiguous";

export class SessionRouterError extends Error {
	constructor(
		readonly phase: SessionRouterErrorPhase,
		message = "SDK session attachment is unavailable.",
	) {
		super(message);
		this.name = "SessionRouterError";
	}
}

/**
 * One directly attached session. The stub-and-preserve extraction (issue #4530)
 * removed the #4098 broker-index authority machinery (replay barriers, generation
 * and endpoint-mtime fencing, adoption deferral, retirement versioning, delivery
 * concession bookkeeping); an attachment is now exactly a Router-owned client plus
 * the opaque provider capabilities derived from it.
 */
type AttachedSession = {
	readonly sessionId: string;
	readonly endpoint: SdkSessionEndpoint;
	readonly generation: number;
	readonly pid: number;
	readonly endpointMtimeMs: number;
	readonly source: "index" | "adopted";
	readonly client: SessionRouterClient;
	readonly capability: SessionAttachment;
	readonly notificationSubscription: NotificationSubscription;
	notificationCancelled: boolean;
	readonly notificationCursor: { generation: number; seq: number };
	frameTail: Promise<void>;
	disposed: boolean;
	dispose: () => void;
};

const ATTACH_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Client-message types the native session server authorizes with the
 * per-session endpoint token (`tokens_match` in crates/gjc-sdk server.rs).
 * Frames of these types without a matching `token` are dropped silently.
 */
const TOKEN_AUTHORIZED_FRAME_TYPES = new Set([
	"user_message",
	"reply",
	"ephemeral_turn",
	"ephemeral_turn_cancel",
	"config_command",
	"control_command",
]);

function readGeneration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readEndpointMtime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readSequence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function fallbackCorrelation(frame: Record<string, unknown>): SessionRouterFrame | undefined {
	const payload =
		frame.type === "event" && frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
			? (frame.payload as Record<string, unknown>)
			: undefined;
	const readSession = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	const readName = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
	const readCorrelation = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	const outerSession = frame.sessionId;
	const innerSession = payload?.sessionId;
	const outerGeneration = frame.generation;
	const innerGeneration = payload?.generation;
	if (outerSession !== undefined && innerSession !== undefined && outerSession !== innerSession) return undefined;
	if (outerGeneration !== undefined && innerGeneration !== undefined && outerGeneration !== innerGeneration)
		return undefined;
	const sessionClaim = outerSession !== undefined ? outerSession : innerSession;
	const generationClaim = outerGeneration !== undefined ? outerGeneration : innerGeneration;
	const sessionId = readSession(sessionClaim);
	const generation = readGeneration(generationClaim);
	if (sessionClaim !== undefined && sessionId === undefined) return undefined;
	if (generationClaim !== undefined && generation === undefined) return undefined;
	const body = payload ?? frame;
	const nestedEvent = payload
		? payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)
			? (payload.event as Record<string, unknown>)
			: undefined
		: undefined;
	const commandId =
		readCorrelation(frame.commandId) ??
		readCorrelation(payload?.commandId) ??
		readCorrelation(nestedEvent?.commandId);
	const turnId =
		readCorrelation(frame.turnId) ?? readCorrelation(payload?.turnId) ?? readCorrelation(nestedEvent?.turnId);
	return {
		body,
		name: readName(frame.name) ?? readName(frame.kind) ?? readName(body.type),
		sessionId,
		generation,
		commandId,
		turnId,
		seq: readSequence(frame.seq) ?? readSequence(payload?.seq),
	};
}

/**
 * Direct-attachment SDK session router. Providers receive only opaque attachment
 * capabilities; endpoint records and SDK clients remain here. This is the
 * stub-and-preserve replacement for the removed #4098 broker-index attachment
 * authority (issue #4530): attachments are established directly from the session
 * index or an ingested lifecycle result, frames are correlated and delivered in
 * arrival order, and revocation is a plain client close. The coherent #4098
 * authority implementation is preserved on the owner-controlled extraction refs.
 */
export class SessionRouter {
	readonly #agentDir: string;
	readonly #deps: SessionRouterDeps;
	readonly #correlateFrame: SessionRouterFrameCorrelator;
	readonly #index: SessionIndex;
	readonly #sessions = new Map<string, AttachedSession>();
	readonly #notificationReceipts = new Map<string, NotificationCleanupReceipt>();
	#stopTimer: (() => void) | undefined;
	#scanTail: Promise<void> = Promise.resolve();
	#ready = false;
	#started = false;

	constructor(options: SessionRouterOptions) {
		this.#agentDir = options.agentDir;
		this.#deps = options.deps ?? {};
		this.#correlateFrame = options.correlateFrame ?? fallbackCorrelation;
		this.#index = this.#deps.createIndex?.(options.agentDir) ?? new DefaultSessionIndex(options.agentDir);
	}

	/** Provider-local cleanup outcomes; core routing never depends on these. */
	notificationCleanupReceipts(): NotificationCleanupReceipt[] {
		return [...this.#notificationReceipts.values()].map(receipt => ({ ...receipt }));
	}

	isReady(): boolean {
		return this.#ready;
	}

	/** Attaches the currently indexed live sessions and keeps watching for changes. */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		try {
			await this.reconcile();
			if (!this.#started) return;
			const timer = (this.#deps.setInterval ?? setInterval)(() => {
				void this.reconcile().catch(error =>
					logger.warn(`SDK session scan failed: ${error instanceof Error ? error.message : String(error)}`),
				);
			}, 2_000);
			this.#stopTimer = () => (this.#deps.clearInterval ?? clearInterval)(timer);
		} catch (error) {
			if (this.#started) await this.stop();
			throw error;
		}
	}

	/** Re-scans the session index once, attaching new live sessions and retiring gone ones. */
	async reconcile(): Promise<void> {
		if (!this.#started) return;
		const task = this.#scanTail.catch(() => undefined).then(() => this.#scan());
		this.#scanTail = task;
		await task;
	}

	/** Ingests a credential-bearing Broker lifecycle result directly into Router custody. */
	async adoptLifecycleResult(
		value: unknown,
		fallback: { sessionId: string; cwd: string },
	): Promise<SessionAttachment> {
		const outer =
			value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		const result =
			outer.result !== null && typeof outer.result === "object" && !Array.isArray(outer.result)
				? (outer.result as Record<string, unknown>)
				: outer;
		const endpointValue = result.endpoint;
		const endpointRecord =
			endpointValue !== null && typeof endpointValue === "object" && !Array.isArray(endpointValue)
				? (endpointValue as Record<string, unknown>)
				: result;
		const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
		const endpointGeneration = readPositiveInteger(result.endpointGeneration);
		const pid = readPositiveInteger(result.pid);
		const endpointMtimeMs = readEndpointMtime(result.endpointMtimeMs);
		if (
			sessionId !== fallback.sessionId ||
			endpointGeneration === undefined ||
			pid === undefined ||
			endpointMtimeMs === undefined ||
			endpointRecord.sessionId !== sessionId ||
			endpointRecord.pid !== pid ||
			typeof endpointRecord.url !== "string" ||
			typeof endpointRecord.token !== "string"
		)
			throw new SessionRouterError(
				"pre_send",
				"Broker lifecycle result omitted an exact session endpoint authority.",
			);
		const endpoint: SdkSessionEndpoint = {
			sessionId,
			url: endpointRecord.url,
			token: endpointRecord.token,
			pid,
			path: path.join(path.resolve(fallback.cwd), ".gjc", "state", "sdk", `${sessionId}.json`),
		};
		return await this.#attachDirect({
			sessionId,
			generation: endpointGeneration,
			pid,
			endpointMtimeMs,
			endpoint,
			source: "adopted",
		});
	}

	async stop(): Promise<void> {
		if (this.#stopTimer) this.#stopTimer();
		this.#stopTimer = undefined;
		this.#started = false;
		this.#ready = false;
		const attached = [...this.#sessions.values()];
		this.#sessions.clear();
		const errors: unknown[] = [];
		for (const session of attached) {
			session.dispose();
			this.#detachNotification(session, "removed");
			try {
				await session.client.close();
			} catch (error) {
				errors.push(error);
			}
			void Promise.resolve(this.#deps.onSessionRemoved?.(session.capability, "removed")).catch(error =>
				logger.warn(`SDK provider cleanup failed during router stop: ${String(error)}`),
			);
		}
		await this.#scanTail.catch(() => undefined);
		if (errors.length > 0) throw new AggregateError(errors, "SessionRouter shutdown failed.");
	}

	/** Returns an opaque lease only while the exact attachment generation is live. */
	attachment(sessionId: string, expectedGeneration?: number): SessionAttachment | null {
		const attached = this.#sessions.get(sessionId);
		if (!attached || attached.disposed) return null;
		if (expectedGeneration !== undefined && expectedGeneration !== attached.generation) return null;
		return attached.capability;
	}

	#prepareFrame(attached: AttachedSession, frame: Record<string, unknown>): Record<string, unknown> {
		// The native session server authorizes these client-message types with
		// the per-session endpoint token and silently drops frames whose token
		// is missing or wrong. Providers only hold opaque capabilities (the
		// endpoint record lives here), so the router must stamp the token —
		// omitting it made every daemon-origin injection (Telegram → session)
		// vanish after the daemon had already ACKed the user's message.
		const withToken =
			typeof frame.type === "string" && TOKEN_AUTHORIZED_FRAME_TYPES.has(frame.type) && frame.token === undefined
				? { ...frame, token: attached.endpoint.token }
				: frame;
		const connectionId = attached.client.connectionId;
		if (connectionId === undefined) return withToken;
		if (withToken.connectionId !== undefined && withToken.connectionId !== connectionId)
			throw new SessionRouterError("pre_send", "SDK session transport identity changed before command dispatch.");
		return { ...withToken, connectionId };
	}

	/** Sends an SDK command through the current attachment without exposing its client. */
	async request(
		sessionId: string,
		frame: Record<string, unknown>,
		expectedGeneration?: number,
		expectedAttachment?: SessionAttachment,
		options?: { timeoutMs?: number },
	): Promise<Record<string, unknown>> {
		const attached = this.#sessions.get(sessionId);
		if (!attached || attached.disposed)
			throw new SessionRouterError("pre_send", "SDK session attachment is unavailable: session not attached.");
		if (expectedGeneration !== undefined && expectedGeneration !== attached.generation)
			throw new SessionRouterError("pre_send", "SDK session endpoint changed before command dispatch.");
		if (expectedAttachment !== undefined && attached.capability !== expectedAttachment)
			throw new SessionRouterError("pre_send", "SDK session attachment changed before command dispatch.");
		// A caller that sized its own budget keeps it; everything else gets the
		// long-lived session budget instead of the transport's one-shot default,
		// which a cold host's first credential-collecting query outruns (#4258).
		const response = await attached.client.request(this.#prepareFrame(attached, frame), {
			...options,
			timeoutMs: options?.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS,
		});
		if (
			this.#sessions.get(sessionId) !== attached ||
			attached.disposed ||
			(expectedGeneration !== undefined && attached.generation !== expectedGeneration) ||
			(expectedAttachment !== undefined && attached.capability !== expectedAttachment)
		)
			throw new SessionRouterError("ambiguous", "SDK session attachment changed while awaiting command response.");
		return response;
	}

	/** Resolves the provider-neutral binding authority for an attached session. */
	async bindingAuthority(sessionId: string): Promise<{ sessionId: string; endpointGeneration: number } | undefined> {
		const attached = this.#sessions.get(sessionId);
		if (!attached || attached.disposed) return undefined;
		return { sessionId, endpointGeneration: attached.generation };
	}

	/** Activates a prepared session through one Router-owned, one-shot SDK client. */
	async activatePreparedSession(sessionId: string): Promise<ActivatedPreparedSession> {
		const indexed = await this.#indexedLiveSession(sessionId);
		if (!indexed)
			throw new SessionActivationError(
				"session_not_live",
				"Session activation requires an exact live session endpoint.",
			);
		const endpoint = await this.#readEndpoint(indexed);
		if (!endpoint?.url || !endpoint.token)
			throw new SessionActivationError(
				"session_not_live",
				"Session activation requires a readable session discovery endpoint.",
			);

		let client: PreparedSessionActivationClient;
		try {
			client = await (this.#deps.createClient
				? this.#deps.createClient({
						sessionId: indexed.sessionId,
						generation: indexed.endpointGeneration,
						pid: indexed.pid ?? 0,
						endpointMtimeMs: indexed.endpointMtimeMs ?? 0,
					})
				: connectPreparedSession(endpoint));
		} catch {
			throw new SessionActivationError("activation_unavailable", "The session endpoint could not be reached.");
		}
		try {
			return await requestPreparedSessionActivation(client, sessionId, indexed.endpointGeneration);
		} finally {
			await client.close().catch(() => undefined);
		}
	}

	/** Lists saved sessions through Router-owned Broker discovery without exposing credentials or mutation authority. */
	async listBrokerSessions(input: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
		const operation = "session.list";
		const discovery = await readSdkBrokerDiscovery(this.#agentDir);
		if (!discovery) throw new SessionRouterError("pre_send", "SDK broker discovery is unavailable.");
		let client: SessionRouterClient;
		try {
			client = this.#deps.createBrokerClient
				? await this.#deps.createBrokerClient()
				: await SdkClient.connect(discovery.url, discovery.token);
		} catch {
			throw new SessionRouterError("pre_send", "SDK broker connection failed.");
		}
		try {
			const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
			return await client.request(
				{ type: "broker_request", operation, input, idempotencyKey },
				timeoutMs === undefined ? undefined : { timeoutMs },
			);
		} finally {
			await client.close().catch(error => {
				logger.warn(`SDK Broker session.list transport cleanup failed (${String(error)}).`);
			});
		}
	}

	async #indexedLiveSession(sessionId: string): Promise<IndexedSession | undefined> {
		try {
			await this.#index.open();
			await this.#index.refresh();
			const listing = this.#index.listSessions();
			if (listing.warnings.length > 0) return undefined;
			const indexed = listing.sessions.find(candidate => candidate.sessionId === sessionId);
			if (
				!indexed?.live ||
				!isSessionAuthorityEligible(indexed) ||
				indexed.terminalUncertain ||
				!Number.isSafeInteger(indexed.endpointGeneration) ||
				indexed.endpointGeneration <= 0
			)
				return undefined;
			return indexed;
		} catch {
			return undefined;
		}
	}

	/**
	 * Reads the discovery endpoint for an indexed session. The scope test compares
	 * path identity, not spelling, so symlinked cwds (macOS /var -> /private/var)
	 * keep resolving (#4645).
	 */
	async #readEndpoint(indexed: IndexedSession): Promise<SdkSessionEndpoint | null> {
		if (indexed.pid === undefined) return null;
		const repo = path.resolve(indexed.locator.repo);
		const defaultStateRoot = path.join(repo, ".gjc", "state");
		const indexedStateRoot = resolveEquivalentPath(indexed.locator.stateRoot);
		const scope =
			indexedStateRoot === resolveEquivalentPath(defaultStateRoot)
				? "default"
				: indexedStateRoot === resolveEquivalentPath(path.join(defaultStateRoot, "chat"))
					? "chat"
					: undefined;
		if (!scope) return null;
		const endpoint = await readSdkSessionEndpoint(repo, indexed.sessionId, scope).catch(() => null);
		if (!endpoint || endpoint.stale || endpoint.pid !== indexed.pid) return null;
		// A discovery record rewritten after broker registration is not the indexed
		// authority: the file's mtime must match the indexed endpoint mtime exactly.
		if (indexed.endpointMtimeMs !== undefined) {
			const stat = await fs.stat(endpoint.path).catch(() => undefined);
			if (!stat || stat.mtimeMs !== indexed.endpointMtimeMs) return null;
		}
		return endpoint;
	}

	async #scan(): Promise<void> {
		if (!this.#started) return;
		let live: IndexedSession[] = [];
		try {
			await this.#index.open();
			await this.#index.refresh();
			const listing = this.#index.listSessions();
			if (listing.warnings.length === 0)
				live = listing.sessions.filter(
					session => session.live && isSessionAuthorityEligible(session) && !session.terminalUncertain,
				);
		} catch (error) {
			this.#ready = false;
			throw error;
		}
		const liveIds = new Set(live.map(session => session.sessionId));
		for (const session of live) {
			if (!this.#started) return;
			const existing = this.#sessions.get(session.sessionId);
			if (
				existing &&
				!existing.disposed &&
				existing.generation === session.endpointGeneration &&
				existing.pid === session.pid &&
				existing.endpointMtimeMs === session.endpointMtimeMs
			) {
				// An unchanged index tuple is not enough: the discovery endpoint the
				// attachment was built from may have been removed or rewritten since.
				// Re-prove it and revoke the attachment when it no longer resolves.
				if (await this.#readEndpoint(session)) {
					this.#reviveTransport(existing);
					continue;
				}
				await this.#retire(existing, "removed");
				continue;
			}
			if (existing && !existing.disposed) await this.#retire(existing, "replaced");
			if (session.endpointMtimeMs === undefined || session.pid === undefined) continue;
			const endpoint = await this.#readEndpoint(session);
			if (!endpoint) continue;
			try {
				await this.#attachDirect({
					sessionId: session.sessionId,
					generation: session.endpointGeneration,
					pid: session.pid,
					endpointMtimeMs: session.endpointMtimeMs,
					endpoint,
					source: "index",
				});
			} catch (error) {
				logger.warn(
					`SDK session attachment failed for indexed session ${session.sessionId} at generation ${session.endpointGeneration}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		for (const [sessionId, attached] of [...this.#sessions]) {
			if (liveIds.has(sessionId) || attached.disposed || attached.source === "adopted") continue;
			await this.#retire(attached, "removed");
		}
		this.#ready = true;
		this.#deps.onReconciled?.();
	}

	async #attachDirect(input: {
		sessionId: string;
		generation: number;
		pid: number;
		endpointMtimeMs: number;
		endpoint: SdkSessionEndpoint;
		source: "index" | "adopted";
	}): Promise<SessionAttachment> {
		const existing = this.#sessions.get(input.sessionId);
		if (existing && !existing.disposed) await this.#retire(existing, "replaced");
		const client = await this.#createClient(input);
		let attached: AttachedSession | undefined;
		const capability: SessionAttachment = Object.freeze({
			authorityId: sessionAttachmentAuthorityId({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
				url: input.endpoint.url,
				token: input.endpoint.token,
			}),
			sessionId: input.sessionId,
			generation: input.generation,
			get connectionId(): string | undefined {
				return attached?.client.connectionId;
			},
			isCurrent: () =>
				attached !== undefined && !attached.disposed && this.#sessions.get(input.sessionId) === attached,
			send: async (frame: Record<string, unknown>) => {
				if (!attached || attached.disposed || this.#sessions.get(input.sessionId) !== attached)
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				attached.client.send(this.#prepareFrame(attached, frame));
			},
			retire: async () => {
				if (attached && !attached.disposed) await this.#retire(attached);
			},
		});
		const notificationCursor = { generation: input.generation, seq: 0 };
		const notificationSubscription: NotificationSubscription = Object.freeze({
			sessionId: input.sessionId,
			subscriptionId: `notification:${input.sessionId}:${crypto.randomUUID()}`,
			cursor: notificationCursor,
			isActive: () =>
				attached !== undefined &&
				!attached.disposed &&
				!attached.notificationCancelled &&
				this.#sessions.get(input.sessionId) === attached,
			send: (frame: Record<string, unknown>) => {
				if (!attached || attached.disposed || attached.notificationCancelled)
					throw new SessionRouterError("pre_send", "Notification subscription is cancelled.");
				attached.client.send(this.#prepareFrame(attached, frame));
			},
			advanceCursor: (generation: number, seq: number) => {
				if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(seq) || seq < 0) return;
				if (
					generation > notificationCursor.generation ||
					(generation === notificationCursor.generation && seq > notificationCursor.seq)
				) {
					notificationCursor.generation = generation;
					notificationCursor.seq = seq;
				}
			},
			cancel: (reason?: string) => {
				if (attached && !attached.notificationCancelled) this.#detachNotification(attached, "cancelled");
				if (reason) this.#recordNotificationReceipt(notificationSubscription, "pending", reason);
			},
		});
		const disposeFrames = client.onFrame(frame => {
			const current = attached;
			if (!current || current.disposed) return;
			current.frameTail = current.frameTail.catch(() => undefined).then(() => this.#deliverFrame(current, frame));
			void current.frameTail;
		});
		const disposeReconnect = client.onReconnect?.(() => {
			const current = attached;
			if (!current || current.disposed) return;
			// The provider handshake is re-run before the catch-up replay, and both
			// are serialized on the attachment's frame tail so live frames emitted
			// during the reconnect land behind the replay. A rejecting handshake
			// revokes the attachment, exactly like initial publication.
			current.frameTail = current.frameTail
				.catch(() => undefined)
				.then(async () => {
					if (current.disposed || this.#sessions.get(input.sessionId) !== current) return;
					try {
						await this.#deps.onAttachmentReady?.(capability);
					} catch (error) {
						logger.warn(
							`SDK provider reconnect hook failed; revoking the attachment: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
						await this.#retire(current);
						return;
					}
					await this.#replayAttached(current);
				});
			void current.frameTail;
		});
		attached = {
			sessionId: input.sessionId,
			endpoint: input.endpoint,
			generation: input.generation,
			pid: input.pid,
			endpointMtimeMs: input.endpointMtimeMs,
			source: input.source,
			client,
			capability,
			notificationSubscription,
			notificationCancelled: false,
			notificationCursor,
			frameTail: Promise.resolve(),
			disposed: false,
			dispose: () => {
				if (!attached || attached.disposed) return;
				attached.disposed = true;
				disposeFrames();
				disposeReconnect?.();
			},
		};
		this.#sessions.set(input.sessionId, attached);
		try {
			await this.#deps.onAttachment?.(capability);
			this.#recordNotificationReceipt(notificationSubscription, "pending");
			await Promise.resolve()
				.then(() => this.#deps.onNotificationSubscription?.(notificationSubscription))
				.catch(error => {
					if (attached) this.#detachNotification(attached, "cancelled");
					logger.warn(
						`SDK notification subscription admission failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			await Promise.resolve()
				.then(() => this.#deps.onNotificationSubscriptionReady?.(notificationSubscription))
				.catch(error => {
					if (attached) this.#detachNotification(attached, "cancelled");
					logger.warn(
						`SDK notification subscription ready hook failed locally: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
			await this.#deps.onAttachmentReady?.(capability);
		} catch (error) {
			if (this.#sessions.get(input.sessionId) === attached) this.#sessions.delete(input.sessionId);
			attached.dispose();
			await client.close().catch(() => undefined);
			void Promise.resolve(this.#deps.onSessionRemoved?.(capability, "removed")).catch(() => undefined);
			throw error;
		}
		// The initial event replay is serialized on the attachment's frame tail, so
		// any live frame emitted after the handler registration lands behind it.
		// Attachment publication awaits its completion: daemons reconstruct their
		// session state from these events and must observe a settled replay before
		// `start()` returns. There is deliberately no barrier/fencing machinery —
		// a replay failure is logged and live delivery continues (issue #4530).
		attached.frameTail = attached.frameTail.then(() => this.#replayAttached(attached));
		await attached.frameTail.catch(() => undefined);
		return capability;
	}

	async #replayAttached(attached: AttachedSession): Promise<void> {
		if (attached.disposed || this.#sessions.get(attached.sessionId) !== attached) return;
		let replay: Record<string, unknown>;
		try {
			replay = await attached.client.request({
				type: "event_replay",
				sinceGeneration: attached.generation,
				sinceSeq: attached.notificationCursor.seq,
			});
		} catch (error) {
			logger.warn(
				`SDK session ${attached.sessionId} event replay failed; live delivery continues (${String(error)}).`,
			);
			return;
		}
		if (attached.disposed || this.#sessions.get(attached.sessionId) !== attached) return;
		const events = Array.isArray(replay.events)
			? replay.events.filter(
					(event): event is Record<string, unknown> =>
						!!event && typeof event === "object" && !Array.isArray(event),
				)
			: [];
		for (const event of events) {
			if (attached.disposed || this.#sessions.get(attached.sessionId) !== attached) return;
			await this.#deliverFrame(attached, event);
		}
	}

	async #createClient(input: {
		sessionId: string;
		generation: number;
		pid: number;
		endpointMtimeMs: number;
		endpoint: SdkSessionEndpoint;
	}): Promise<SessionRouterClient> {
		const createClient = this.#deps.createClient;
		if (createClient)
			return await createClient({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
			});
		const client = new SdkClient(input.endpoint.url, input.endpoint.token, { ...ACP_SESSION_RECONNECT });
		const timeout = Promise.withResolvers<never>();
		const timer = (this.#deps.setTimeout ?? setTimeout)(
			() => timeout.reject(new SessionRouterError("pre_send", "SDK session attachment connection timed out.")),
			ATTACH_CONNECT_TIMEOUT_MS,
		);
		timer.unref?.();
		try {
			await Promise.race([client.connect(), timeout.promise]);
			return client;
		} catch (error) {
			void client.close().catch(() => undefined);
			throw error;
		} finally {
			(this.#deps.clearTimeout ?? clearTimeout)(timer);
		}
	}

	async #deliverFrame(attached: AttachedSession, frame: Record<string, unknown>): Promise<void> {
		if (attached.disposed || this.#sessions.get(attached.sessionId) !== attached) return;
		const correlated = this.#correlateFrame(frame);
		if (!correlated) return;
		if (correlated.sessionId !== undefined && correlated.sessionId !== attached.sessionId) return;
		if (correlated.generation !== undefined && correlated.generation !== attached.generation) return;
		const seq = correlated.seq;
		if (seq !== undefined) {
			if (correlated.generation === undefined) return;
			if (seq <= attached.notificationCursor.seq && correlated.generation === attached.notificationCursor.generation)
				return;
		}
		const publicationId =
			seq !== undefined && correlated.generation === attached.generation
				? `${attached.sessionId}:${attached.generation}:${seq}`
				: undefined;
		const delivered = publicationId === undefined ? correlated : { ...correlated, publicationId };
		this.#dispatchNotificationFrame(attached, delivered);
		await Promise.resolve()
			.then(() => this.#deps.onFrame?.(attached.capability, delivered))
			.catch(error =>
				logger.warn(`SDK provider frame hook failed: ${error instanceof Error ? error.message : String(error)}`),
			);
		if (seq !== undefined && !attached.disposed)
			attached.notificationCursor.seq = Math.max(attached.notificationCursor.seq, seq);
	}

	#recordNotificationReceipt(
		subscription: NotificationSubscription,
		state: NotificationCleanupState,
		reason?: string,
	): void {
		this.#notificationReceipts.set(subscription.subscriptionId, {
			subscriptionId: subscription.subscriptionId,
			sessionId: subscription.sessionId,
			state,
			...(reason ? { reason: reason.slice(0, 256) } : {}),
		});
	}

	#detachNotification(
		attached: AttachedSession,
		reason: "removed" | "replaced" | "replaced_same_generation" | "cancelled",
	): void {
		if (attached.notificationCancelled) return;
		attached.notificationCancelled = true;
		this.#recordNotificationReceipt(attached.notificationSubscription, "pending", reason);
		void Promise.resolve()
			.then(() => this.#deps.onNotificationSubscriptionRemoved?.(attached.notificationSubscription, reason))
			.then(
				() => this.#recordNotificationReceipt(attached.notificationSubscription, "completed", reason),
				(error: unknown) =>
					this.#recordNotificationReceipt(
						attached.notificationSubscription,
						"failed",
						error instanceof Error ? error.message : String(error),
					),
			);
	}

	#dispatchNotificationFrame(attached: AttachedSession, frame: SessionRouterFrame): void {
		if (attached.notificationCancelled || attached.disposed) return;
		const callback = this.#deps.onNotificationFrame;
		if (!callback) return;
		void Promise.resolve()
			.then(() => callback(attached.notificationSubscription, frame))
			.then(() => {
				if (frame.seq !== undefined)
					attached.notificationSubscription.advanceCursor(frame.generation ?? attached.generation, frame.seq);
			})
			.catch((error: unknown) => {
				if (!attached.disposed) this.#detachNotification(attached, "cancelled");
				logger.warn(
					`SDK notification subscription ${attached.notificationSubscription.subscriptionId} failed locally: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	}

	readonly #reviving = new Set<string>();

	/**
	 * Re-establishes a dropped transport in the background. `connect()` is a
	 * no-op on a healthy client and triggers the client's reconnect hook on a
	 * dropped one; concurrent revivals for the same attachment are coalesced.
	 */
	#reviveTransport(attached: AttachedSession): void {
		const connect = attached.client.connect?.bind(attached.client);
		if (!connect || this.#reviving.has(attached.capability.authorityId ?? attached.sessionId)) return;
		this.#reviving.add(attached.capability.authorityId ?? attached.sessionId);
		void connect()
			.catch(() => undefined)
			.finally(() => this.#reviving.delete(attached.capability.authorityId ?? attached.sessionId));
	}

	async #retire(
		attached: AttachedSession,
		reason: "removed" | "replaced" | "replaced_same_generation" = "removed",
	): Promise<void> {
		if (this.#sessions.get(attached.sessionId) === attached) this.#sessions.delete(attached.sessionId);
		if (attached.disposed) return;
		attached.dispose();
		this.#detachNotification(attached, reason);
		void Promise.resolve(this.#deps.onSessionRemoved?.(attached.capability, reason)).catch(error =>
			logger.warn(`SDK provider cleanup failed after attachment revocation: ${String(error)}`),
		);
		await attached.client
			.close()
			.catch(error =>
				logger.warn(
					`SDK session transport cleanup failed for ${attached.sessionId}; authority remains revoked (${String(error)}).`,
				),
			);
	}
}

async function connectPreparedSession(endpoint: {
	url: string;
	token: string;
}): Promise<PreparedSessionActivationClient> {
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { reconnectAttempts: 0 });
	return {
		request: async frame => (await client.request(frame)) as Record<string, unknown>,
		close: async () => await client.close(),
	};
}
