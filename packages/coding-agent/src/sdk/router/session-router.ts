import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
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

type HeldFrame = Readonly<{ seq: number; frame: Record<string, unknown> }>;
type FrameOrigin = "live" | "ordered";
type ReplayBarrier = {
	held: HeldFrame[] | undefined;
	detached: boolean;
	failed: boolean;
};

type AttachedSession = {
	readonly id: string;
	readonly sessionId: string;
	readonly endpoint: SdkSessionEndpoint;
	readonly generation: number;
	readonly pid: number;
	readonly endpointMtimeMs: number;
	readonly runEpoch: number;
	readonly client: SessionRouterClient;
	readonly indexed: IndexedSession;
	readonly cursor: { seq: number };
	readonly barrier: ReplayBarrier;
	readonly capability: SessionAttachment;
	readonly notificationSubscription: NotificationSubscription;
	notificationCancelled: boolean;
	readonly notificationCursor: { generation: number; seq: number };
	published: boolean;
	initializingPublication: boolean;
	readyTail: Promise<void>;
	readonly publication: { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void };
	dispose: () => void;
};

const REPLAY_BARRIER_LIMIT = 1_024;
const REPLAY_RETRY_ATTEMPTS = 3;
const REPLAY_RETRY_BACKOFF_MS = 100;
const DELIVERY_ATTEMPT_LIMIT = 3;
const ATTACH_CONCURRENCY = 4;
const ATTACH_CONNECT_TIMEOUT_MS = 10_000;
const NOTIFICATION_WORK_TIMEOUT_MS = 5_000;
const NOTIFICATION_WORK_TIMEOUT = Symbol("notification_work_timeout");
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

function readReplayGap(
	value: unknown,
):
	| Readonly<{ kind: "generation_reset"; toGeneration: number }>
	| Readonly<{ kind: "sequence_gap"; fromSeq: number; toSeq: number }>
	| undefined {
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

function sameIndexedAuthority(expected: IndexedSession, current: IndexedSession): boolean {
	return (
		current.sessionId === expected.sessionId &&
		current.live &&
		isSessionAuthorityEligible(current) &&
		!current.terminalUncertain &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs
	);
}

type AdoptedSession = {
	readonly generation: number;
	readonly pid: number;
	readonly endpointMtimeMs: number;
	readonly attachment: SessionAttachment;
};

/**
 * Broker-index-backed SDK attachment authority. Providers receive only opaque
 * attachment capabilities; endpoint records and SDK clients remain here.
 */
export class SessionRouter {
	readonly #agentDir: string;
	readonly #deps: SessionRouterDeps;
	readonly #correlateFrame: SessionRouterFrameCorrelator;
	readonly #index: SessionIndex;
	readonly #sessions = new Map<string, AttachedSession>();
	readonly #adopted = new Map<string, AdoptedSession>();
	readonly #retirements = new Map<string, Promise<void>>();
	readonly #retirementVersions = new Map<string, number>();
	readonly #pending = new Set<Promise<void>>();
	readonly #frameTails = new Map<string, Promise<void>>();
	readonly #undelivered = new Map<string, { generation: number; seq: number; attempts: number }>();
	readonly #recoveredFrames = new Map<
		string,
		{ generation: number; frames: Array<{ seq: number; frame: Record<string, unknown> }> }
	>();
	readonly #reviving = new Set<string>();
	readonly #notificationReceipts = new Map<string, NotificationCleanupReceipt>();
	#stopTimer: (() => void) | undefined;
	#reconcileTail: Promise<void> = Promise.resolve();
	#reconcilePending: { readonly runEpoch: number } | undefined;
	#ready = false;
	#started = false;
	#stopController = new AbortController();
	#runEpoch = 0;

	constructor(options: SessionRouterOptions) {
		this.#agentDir = options.agentDir;
		this.#deps = options.deps ?? {};
		this.#correlateFrame = options.correlateFrame ?? fallbackCorrelation;
		this.#index = this.#deps.createIndex?.(options.agentDir) ?? new DefaultSessionIndex(options.agentDir);
	}

	/** Provider-local cleanup outcomes; core authority never depends on these. */
	notificationCleanupReceipts(): NotificationCleanupReceipt[] {
		return [...this.#notificationReceipts.values()].map(receipt => ({ ...receipt }));
	}

	isReady(): boolean {
		return this.#ready;
	}

	/** Starts reconciliation and the index watcher. */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		const runEpoch = ++this.#runEpoch;
		if (this.#stopController.signal.aborted) {
			this.#stopController = new AbortController();
			this.#reconcileTail = Promise.resolve();
			this.#reconcilePending = undefined;
			this.#frameTails.clear();
		}
		try {
			await this.#serialReconcile(runEpoch);
			if (!this.#running(runEpoch)) return;
			const timer = (this.#deps.setInterval ?? setInterval)(
				() => this.#schedule(this.#serialReconcile(runEpoch)),
				2_000,
			);
			this.#stopTimer = () => (this.#deps.clearInterval ?? clearInterval)(timer);
		} catch (error) {
			if (this.#running(runEpoch)) await this.stop();
			throw error;
		}
	}

	/** Exposed for deterministic callers and reconciliation tests. */
	reconcile(): Promise<void> {
		return this.#serialReconcile(this.#runEpoch);
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
		const repo = path.resolve(fallback.cwd);
		const stateRoot = path.join(repo, ".gjc", "state");
		const indexed: IndexedSession = {
			sessionId,
			locator: { repo, stateRoot },
			endpointGeneration,
			pid,
			endpointMtimeMs,
			live: true,
			indexSeq: 0,
			identityProvenance: "legacy",
			ambiguous: false,
			terminal: false,
		};
		const endpoint: SdkSessionEndpoint = {
			sessionId,
			url: endpointRecord.url,
			token: endpointRecord.token,
			pid,
			path: path.join(stateRoot, "sdk", `${sessionId}.json`),
		};
		const attached = await this.#attach(indexed, this.#runEpoch, endpoint, true, true);
		const current = this.#sessions.get(sessionId);
		const capability = current?.capability;
		if (!attached || !current || !capability)
			throw new SessionRouterError("pre_send", "Broker session endpoint could not be attached.");
		const listing = this.#index.listSessions();
		const indexedCurrent =
			listing.warnings.length === 0 ? listing.sessions.find(item => item.sessionId === sessionId) : undefined;
		if (indexedCurrent && sameIndexedAuthority(indexed, indexedCurrent)) await this.#serialReconcile(this.#runEpoch);
		return capability;
	}

	async stop(): Promise<void> {
		if (this.#stopTimer) this.#stopTimer();
		this.#stopTimer = undefined;
		this.#started = false;
		this.#runEpoch += 1;
		this.#stopController.abort();
		this.#ready = false;
		const shutdownTasks: Promise<void>[] = [];
		for (const [sessionId, attached] of this.#sessions) {
			this.#sessions.delete(sessionId);
			attached.dispose();
			this.#detachNotification(attached, "removed");
			shutdownTasks.push((async () => await attached.client.close())());
			void Promise.resolve(this.#deps.onSessionRemoved?.(attached.capability)).catch(error =>
				logger.warn(`SDK provider cleanup failed during router stop: ${String(error)}`),
			);
		}
		this.#adopted.clear();
		// Provider notification work is detached and bounded independently; core
		// shutdown waits only for Router reconciliation and client close.
		const pending = Promise.allSettled([this.#reconcileTail, ...shutdownTasks]);
		const outcome = await Promise.race([
			pending.then(results => ({ kind: "settled" as const, results })),
			Bun.sleep(5_000).then(() => ({ kind: "timeout" as const })),
		]);
		if (outcome.kind === "timeout") {
			logger.warn(
				"SessionRouter shutdown exceeded 5000ms; authority is revoked and cleanup continues in background.",
			);
			return;
		}
		const errors = outcome.results
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map(result => result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "SessionRouter shutdown failed.");
	}

	/** Returns an opaque lease only while the exact attachment generation is live. */
	attachment(sessionId: string, expectedGeneration?: number): SessionAttachment | null {
		const attached = this.#sessions.get(sessionId);
		if (!attached || !this.#attachmentPublished(attached)) return null;
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
		const publishing = this.#sessions.get(sessionId);
		if (!expectedAttachment || publishing?.capability !== expectedAttachment || !publishing.initializingPublication)
			await this.#serialReconcile(this.#runEpoch);
		const attached = this.#sessions.get(sessionId);
		if (!attached || !this.#attachmentPublished(attached))
			throw new SessionRouterError("pre_send", "SDK session attachment is unavailable: session not published.");
		if (expectedGeneration !== undefined && expectedGeneration !== attached.generation)
			throw new SessionRouterError("pre_send", "SDK session endpoint changed before command dispatch.");
		if (expectedAttachment !== undefined && attached.capability !== expectedAttachment)
			throw new SessionRouterError("pre_send", "SDK session attachment changed before command dispatch.");
		if (attached.initializingPublication) {
			const endpoint = await this.#readEndpoint(attached.indexed);
			if (
				!endpoint ||
				endpoint.url !== attached.endpoint.url ||
				endpoint.token !== attached.endpoint.token ||
				endpoint.pid !== attached.pid
			) {
				await this.#retireAttachment(attached, endpoint ? "replaced_same_generation" : undefined);
				throw new SessionRouterError("pre_send", "SDK session attachment changed during publication.");
			}
		}
		// A caller that sized its own budget keeps it; everything else gets the
		// long-lived session budget instead of the transport's one-shot default,
		// which a cold host's first credential-collecting query outruns (#4258).
		const response = await attached.client.request(this.#prepareFrame(attached, frame), {
			...options,
			timeoutMs: options?.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS,
		});
		if (
			!this.#attachmentPublished(attached) ||
			(expectedGeneration !== undefined && attached.generation !== expectedGeneration) ||
			(expectedAttachment !== undefined && attached.capability !== expectedAttachment)
		)
			throw new SessionRouterError("ambiguous", "SDK session attachment changed while awaiting command response.");
		return response;
	}

	/** Resolves the exact provider-neutral binding authority for operator adoption. */
	async bindingAuthority(sessionId: string): Promise<{ sessionId: string; endpointGeneration: number } | undefined> {
		const attached = this.#sessions.get(sessionId);
		if (!attached || !this.#attachmentPublished(attached)) return undefined;
		let indexed: IndexedSession | undefined;
		try {
			await this.#index.refresh();
			const listing = this.#index.listSessions();
			if (listing.warnings.length > 0) return undefined;
			indexed = listing.sessions.find(candidate => candidate.sessionId === sessionId);
		} catch {
			return undefined;
		}
		if (!indexed?.live || !isSessionAuthorityEligible(indexed) || indexed.terminalUncertain) return undefined;
		if (
			!Number.isSafeInteger(indexed.endpointGeneration) ||
			indexed.endpointGeneration <= 0 ||
			indexed.endpointGeneration !== attached.generation ||
			indexed.endpointMtimeMs === undefined
		)
			return undefined;
		if (!Number.isSafeInteger(indexed.pid) || indexed.pid <= 0) return undefined;
		const endpoint = await this.#readEndpoint(indexed).catch(() => null);
		if (!endpoint || endpoint.stale === true || endpoint.pid !== indexed.pid || !endpoint.token) return undefined;
		if (this.#sessions.get(sessionId) !== attached || !this.#attachmentPublished(attached)) return undefined;
		return { sessionId, endpointGeneration: attached.generation };
	}

	/** Activates a prepared session through one Router-owned, one-shot SDK client. */
	async activatePreparedSession(sessionId: string): Promise<ActivatedPreparedSession> {
		let indexed: IndexedSession | undefined;
		try {
			await this.#index.open();
			await this.#index.refresh();
			const listing = this.#index.listSessions();
			if (listing.warnings.length > 0)
				throw new SessionActivationError(
					"session_not_live",
					"Session activation requires an intact session index.",
				);
			indexed = listing.sessions.find(candidate => candidate.sessionId === sessionId);
		} catch (error) {
			if (error instanceof SessionActivationError) throw error;
			throw new SessionActivationError(
				"session_not_live",
				"Session activation requires an exact live session endpoint.",
			);
		}
		if (
			!indexed?.live ||
			!isSessionAuthorityEligible(indexed) ||
			indexed.terminalUncertain ||
			!Number.isSafeInteger(indexed.endpointGeneration) ||
			indexed.endpointGeneration <= 0 ||
			!Number.isSafeInteger(indexed.pid) ||
			indexed.pid <= 0 ||
			typeof indexed.endpointMtimeMs !== "number" ||
			!Number.isFinite(indexed.endpointMtimeMs) ||
			indexed.endpointMtimeMs <= 0
		)
			throw new SessionActivationError(
				"session_not_live",
				"Session activation requires an exact live session endpoint.",
			);
		const endpoint = await this.#readEndpoint(indexed).catch(() => null);
		if (!endpoint || endpoint.stale === true || !endpoint.url || !endpoint.token || endpoint.pid !== indexed.pid)
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
						pid: indexed.pid,
						endpointMtimeMs: indexed.endpointMtimeMs,
					})
				: connectPreparedSession(endpoint));
		} catch {
			throw new SessionActivationError("activation_unavailable", "The session endpoint could not be reached.");
		}
		try {
			const currentEndpoint = await this.#readEndpoint(indexed).catch(() => null);
			if (
				!currentEndpoint ||
				currentEndpoint.url !== endpoint.url ||
				currentEndpoint.token !== endpoint.token ||
				currentEndpoint.pid !== endpoint.pid
			)
				throw new SessionActivationError(
					"session_not_live",
					"The session endpoint changed before activation could be dispatched.",
				);
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

	#serialReconcile(runEpoch: number): Promise<void> {
		if (!this.#running(runEpoch)) return Promise.resolve();
		const pending = this.#reconcilePending;
		if (pending?.runEpoch === runEpoch) return this.#reconcileTail;
		const queued = { runEpoch };
		this.#reconcilePending = queued;
		const task = this.#reconcileTail
			.catch(() => undefined)
			.then(async () => {
				if (this.#reconcilePending === queued) this.#reconcilePending = undefined;
				try {
					await this.#reconcile(runEpoch);
					if (!this.#running(runEpoch)) return;
					this.#ready = true;
					this.#deps.onReconciled?.();
				} catch (error) {
					if (this.#running(runEpoch)) this.#ready = false;
					throw error;
				}
			});
		this.#reconcileTail = task;
		return task;
	}

	async #reconcile(runEpoch: number): Promise<void> {
		if (!this.#running(runEpoch)) return;
		await this.#index.open();
		if (!this.#running(runEpoch)) return;
		await this.#index.refresh();
		if (!this.#running(runEpoch)) return;
		const indexed = this.#index.listSessions();
		const live =
			indexed.warnings.length === 0
				? indexed.sessions.filter(
						session => session.live && isSessionAuthorityEligible(session) && !session.terminalUncertain,
					)
				: [];
		const liveIds = new Set(live.map(session => session.sessionId));
		const attachedIds = new Set<string>();
		if (indexed.warnings.length === 0) {
			for (const [sessionId, adopted] of [...this.#adopted]) {
				const attached = this.#sessions.get(sessionId);
				const indexedSession = indexed.sessions.find(session => session.sessionId === sessionId);
				if (!attached || attached.capability !== adopted.attachment) {
					this.#adopted.delete(sessionId);
					continue;
				}
				const exactIndex =
					indexedSession?.live === true &&
					isSessionAuthorityEligible(indexedSession) &&
					!indexedSession.terminalUncertain &&
					indexedSession.endpointGeneration === adopted.generation &&
					indexedSession.pid === adopted.pid &&
					indexedSession.endpointMtimeMs === adopted.endpointMtimeMs;
				const endpoint = exactIndex ? await this.#readEndpoint(indexedSession).catch(() => null) : null;
				if (
					!exactIndex ||
					!endpoint ||
					endpoint.pid !== adopted.pid ||
					endpoint.url !== attached.endpoint.url ||
					endpoint.token !== attached.endpoint.token
				) {
					this.#adopted.delete(sessionId);
					await this.#retireAttachment(attached);
					continue;
				}
				try {
					if (await this.#publishAttachment(attached, true)) {
						this.#adopted.delete(sessionId);
						attachedIds.add(sessionId);
					}
				} catch {
					this.#adopted.delete(sessionId);
					await this.#retireAttachment(attached);
				}
			}
		}
		let nextAttachment = 0;
		const attachWorkers = Array.from({ length: Math.min(ATTACH_CONCURRENCY, live.length) }, async () => {
			for (;;) {
				if (!this.#running(runEpoch)) return;
				const session = live[nextAttachment++];
				if (!session) return;
				try {
					if (await this.#attach(session, runEpoch)) attachedIds.add(session.sessionId);
				} catch {
					const failed = this.#sessions.get(session.sessionId);
					if (failed?.runEpoch === runEpoch)
						await this.#retireAttachment(failed, liveIds.has(session.sessionId) ? "replaced" : "removed");
					if (this.#running(runEpoch))
						logger.warn(
							`SDK session attachment failed for indexed session ${session.sessionId} at generation ${session.endpointGeneration}; the endpoint remains unauthorized.`,
						);
				}
			}
		});
		await Promise.all(attachWorkers);
		if (!this.#running(runEpoch)) return;
		const cleanupErrors: unknown[] = [];
		for (const [sessionId, attached] of [...this.#sessions]) {
			if (attachedIds.has(sessionId)) continue;
			if (!this.#running(runEpoch) || this.#sessions.get(sessionId) !== attached) continue;
			if (!liveIds.has(sessionId)) {
				this.#undelivered.delete(sessionId);
				this.#recoveredFrames.delete(sessionId);
			}
			try {
				await this.#retireAttachment(attached, liveIds.has(sessionId) ? "replaced" : "removed");
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "SessionRouter stale cleanup failed.");
	}

	async #readEndpoint(indexed: IndexedSession): Promise<SdkSessionEndpoint | null> {
		if (!isSessionAuthorityEligible(indexed)) return null;
		const repo = path.resolve(indexed.locator.repo);
		const defaultStateRoot = path.join(repo, ".gjc", "state");
		const indexedStateRoot = path.resolve(indexed.locator.stateRoot);
		const scope =
			indexedStateRoot === defaultStateRoot
				? "default"
				: indexedStateRoot === path.join(defaultStateRoot, "chat")
					? "chat"
					: undefined;
		if (!scope || indexed.endpointMtimeMs === undefined || !Number.isFinite(indexed.endpointMtimeMs)) return null;
		const endpoint = await readSdkSessionEndpoint(repo, indexed.sessionId, scope);
		if (!endpoint || endpoint.stale || endpoint.pid !== indexed.pid) return null;
		const endpointStat = await fs.stat(endpoint.path).catch(() => undefined);
		if (!endpointStat || endpointStat.mtimeMs !== indexed.endpointMtimeMs) return null;
		let raw: Record<string, unknown>;
		try {
			const parsed = JSON.parse(await Bun.file(endpoint.path).text());
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			raw = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
		if (
			raw.sessionId !== indexed.sessionId ||
			raw.pid !== indexed.pid ||
			raw.stale === true ||
			raw.url !== endpoint.url ||
			raw.token !== endpoint.token
		)
			return null;
		const endpointStatAfterRead = await fs.stat(endpoint.path).catch(() => undefined);
		if (!endpointStatAfterRead || endpointStatAfterRead.mtimeMs !== indexed.endpointMtimeMs) return null;
		await this.#index.refresh();
		const listing = this.#index.listSessions();
		if (listing.warnings.length > 0) return null;
		const current = listing.sessions.find(session => session.sessionId === indexed.sessionId);
		if (!current || !sameIndexedAuthority(indexed, current)) return null;
		return endpoint;
	}

	async #createAttachedClient(
		indexed: IndexedSession,
		endpoint: SdkSessionEndpoint,
		runEpoch: number,
	): Promise<SessionRouterClient | undefined> {
		const endpointMtimeMs = indexed.endpointMtimeMs;
		if (endpointMtimeMs === undefined) return undefined;
		const createClient = this.#deps.createClient;
		let transport: SdkClient | undefined;
		let connection: Promise<SessionRouterClient>;
		if (createClient) {
			connection = createClient({
				sessionId: indexed.sessionId,
				generation: indexed.endpointGeneration,
				pid: indexed.pid,
				endpointMtimeMs,
			});
		} else {
			const defaultClient = new SdkClient(endpoint.url, endpoint.token, { ...ACP_SESSION_RECONNECT });
			transport = defaultClient;
			connection = defaultClient.connect().then(() => defaultClient);
		}
		const stopped = Promise.withResolvers<void>();
		const timeout = Promise.withResolvers<void>();
		const signal = this.#stopController.signal;
		const onStop = (): void => stopped.resolve();
		if (!this.#running(runEpoch) || signal.aborted) onStop();
		else signal.addEventListener("abort", onStop, { once: true });
		const timer = (this.#deps.setTimeout ?? setTimeout)(() => timeout.resolve(), ATTACH_CONNECT_TIMEOUT_MS);
		timer.unref?.();
		try {
			const outcome = await Promise.race([
				connection.then(client => ({ kind: "client" as const, client })),
				stopped.promise.then(() => ({ kind: "stopped" as const })),
				timeout.promise.then(() => ({ kind: "timeout" as const })),
			]);
			if (outcome.kind === "client") return outcome.client;
			if (transport) void transport.close().catch(() => undefined);
			void connection.then(client => client.close().catch(() => undefined)).catch(() => undefined);
			if (outcome.kind === "stopped") return undefined;
			throw new SessionRouterError("pre_send", "SDK session attachment connection timed out.");
		} finally {
			(this.#deps.clearTimeout ?? clearTimeout)(timer);
			signal.removeEventListener("abort", onStop);
		}
	}

	async #attach(
		indexed: IndexedSession,
		runEpoch: number,
		resolvedEndpoint?: SdkSessionEndpoint,
		skipReplay = false,
		deferPublication = false,
	): Promise<boolean> {
		const retirementVersion = this.#retirementVersions.get(indexed.sessionId) ?? 0;
		const retirement = this.#retirements.get(indexed.sessionId);
		if (retirement) await retirement;
		if (!this.#running(runEpoch)) return false;
		if (indexed.endpointMtimeMs === undefined) return false;
		const endpoint = resolvedEndpoint ?? (await this.#readEndpoint(indexed));
		const retirementAfterValidation = this.#retirements.get(indexed.sessionId);
		if (retirementAfterValidation) await retirementAfterValidation;
		if ((this.#retirementVersions.get(indexed.sessionId) ?? 0) !== retirementVersion)
			return await this.#attach(indexed, runEpoch, undefined, skipReplay, deferPublication);
		if (!this.#running(runEpoch)) return false;
		if (!endpoint) return false;
		const existing = this.#sessions.get(indexed.sessionId);
		const resumable =
			existing !== undefined &&
			existing.endpoint.url === endpoint.url &&
			existing.endpoint.token === endpoint.token &&
			existing.generation === indexed.endpointGeneration &&
			existing.pid === indexed.pid &&
			existing.endpointMtimeMs === indexed.endpointMtimeMs;
		if (existing && resumable && !existing.barrier.failed) {
			this.#reviveTransport(existing);
			return true;
		}
		const resumeSeq = existing && resumable ? existing.cursor.seq : 0;
		if (existing) {
			this.#adopted.delete(indexed.sessionId);

			this.#sessions.delete(indexed.sessionId);
			existing.dispose();
			this.#detachNotification(
				existing,
				existing.generation === indexed.endpointGeneration ? "replaced_same_generation" : "replaced",
			);
			try {
				await existing.client.close();
			} catch (error) {
				logger.warn(
					`SDK session replacement transport cleanup failed for ${indexed.sessionId}; authority remains revoked (${String(error)}).`,
				);
			}
			void Promise.resolve(
				this.#deps.onSessionRemoved?.(
					existing.capability,
					existing.generation === indexed.endpointGeneration &&
						(existing.endpoint.url !== endpoint.url ||
							existing.endpoint.token !== endpoint.token ||
							existing.pid !== indexed.pid ||
							existing.endpointMtimeMs !== indexed.endpointMtimeMs)
						? "replaced_same_generation"
						: "replaced",
				),
			).catch(error => logger.warn(`SDK provider cleanup failed after replacement: ${String(error)}`));
			if (!resumable) {
				this.#undelivered.delete(indexed.sessionId);
				this.#recoveredFrames.delete(indexed.sessionId);
			}
		}
		const client = await this.#createAttachedClient(indexed, endpoint, runEpoch);
		if (!client) return false;

		if (!this.#running(runEpoch)) {
			await client.close().catch(() => undefined);
			return false;
		}
		if ((this.#retirementVersions.get(indexed.sessionId) ?? 0) !== retirementVersion) {
			await client.close().catch(() => undefined);
			const currentRetirement = this.#retirements.get(indexed.sessionId);
			if (currentRetirement) await currentRetirement;
			return await this.#attach(indexed, runEpoch, undefined, skipReplay, deferPublication);
		}
		let attached: AttachedSession | undefined;
		const barrier: ReplayBarrier = { held: undefined, detached: false, failed: false };
		const publication = Promise.withResolvers<void>();
		void publication.promise.catch(() => undefined);
		const capability: SessionAttachment = Object.freeze({
			authorityId: sessionAttachmentAuthorityId({
				sessionId: indexed.sessionId,
				generation: indexed.endpointGeneration,
				pid: indexed.pid,
				endpointMtimeMs: indexed.endpointMtimeMs,
				url: endpoint.url,
				token: endpoint.token,
			}),
			sessionId: indexed.sessionId,
			generation: indexed.endpointGeneration,
			get connectionId(): string | undefined {
				return attached?.client.connectionId;
			},
			isCurrent: () => attached !== undefined && this.#attachmentPublished(attached),
			send: async (frame: Record<string, unknown>) => {
				if (!attached || !this.#attachmentPublished(attached))
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				if (attached.initializingPublication) {
					const endpoint = await this.#readEndpoint(attached.indexed);
					if (
						!endpoint ||
						endpoint.url !== attached.endpoint.url ||
						endpoint.token !== attached.endpoint.token ||
						endpoint.pid !== attached.pid
					) {
						await this.#retireAttachment(attached, endpoint ? "replaced_same_generation" : undefined);
						throw new SessionRouterError("pre_send", "SDK session attachment changed during publication.");
					}
				} else await this.#serialReconcile(runEpoch);
				if (!attached || !this.#attachmentPublished(attached))
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				attached.client.send(this.#prepareFrame(attached, frame));
			},
			retire: async () => {
				if (attached) await this.#retireAttachment(attached);
			},
		});
		const notificationCursor = { generation: indexed.endpointGeneration, seq: resumeSeq };
		const notificationSubscription: NotificationSubscription = Object.freeze({
			sessionId: indexed.sessionId,
			subscriptionId: `notification:${indexed.sessionId}:${crypto.randomUUID()}`,
			cursor: notificationCursor,
			isActive: () => attached !== undefined && !attached.notificationCancelled && this.#attachmentLive(attached),
			send: (frame: Record<string, unknown>) => {
				if (!attached || attached.notificationCancelled || !this.#attachmentLive(attached))
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
				if (attached) this.#detachNotification(attached, "cancelled");
				if (reason) this.#recordNotificationReceipt(notificationSubscription, "pending", reason);
			},
		});
		const disposeFrames = client.onFrame(frame => {
			if (!attached) return;
			const task =
				frame.type === "event_replay_result" && frame.seq === undefined
					? this.#deliverOutOfBandFrame(attached, frame)
					: this.#enqueueFrame(attached, frame, "live");
			this.#schedule(task);
		});
		const disposeReconnect = client.onReconnect?.(() => {
			if (attached) {
				attached.barrier.held ??= [];
				this.#schedule(this.#reinitializeAttachment(attached));
			}
		});
		attached = {
			initializingPublication: false,
			id: crypto.randomUUID(),
			sessionId: indexed.sessionId,
			endpoint,
			pid: indexed.pid,
			endpointMtimeMs: indexed.endpointMtimeMs,
			generation: indexed.endpointGeneration,
			runEpoch,
			client,
			indexed,
			readyTail: Promise.resolve(),
			cursor: { seq: resumeSeq },
			barrier,
			capability,
			notificationSubscription,
			notificationCancelled: false,
			notificationCursor,
			published: false,
			publication,
			dispose: () => {
				disposeFrames();
				disposeReconnect?.();
				barrier.detached = true;
				if (!attached?.published)
					publication.reject(
						new SessionRouterError("pre_send", "SDK session publication was detached before completion."),
					);
				barrier.held = undefined;
			},
		};
		this.#sessions.set(indexed.sessionId, attached);
		if (deferPublication)
			this.#adopted.set(indexed.sessionId, {
				generation: indexed.endpointGeneration,
				pid: indexed.pid,
				endpointMtimeMs: indexed.endpointMtimeMs,
				attachment: capability,
			});
		try {
			await this.#deps.onAttachment?.(capability);
			this.#recordNotificationReceipt(notificationSubscription, "pending");
			void Promise.resolve()
				.then(() => this.#deps.onNotificationSubscription?.(notificationSubscription))
				.catch(error => {
					this.#detachNotification(attached!, "cancelled");
					logger.warn(`SDK notification subscription admission failed: ${String(error)}`);
				});
		} catch (error) {
			const failedStillCurrent = this.#sessions.get(indexed.sessionId) === attached;
			this.#adopted.delete(indexed.sessionId);
			if (failedStillCurrent) this.#sessions.delete(indexed.sessionId);
			attached.dispose();
			await attached.client.close().catch(() => undefined);
			if (failedStillCurrent)
				try {
					await this.#deps.onSessionRemoved?.(capability);
				} catch {
					// Attachment publication failed closed; provider cleanup remains best effort.
				}
			throw error;
		}
		if (deferPublication) return true;
		return await this.#publishAttachment(attached, skipReplay);
	}

	async #publishAttachment(attached: AttachedSession, skipReplay: boolean): Promise<boolean> {
		if (attached.published) return this.#attachmentPublished(attached);
		if (!this.#attachmentLive(attached)) return false;
		const endpoint = await this.#readEndpoint(attached.indexed).catch(() => null);
		if (!this.#attachmentLive(attached)) return false;
		if (
			!endpoint ||
			endpoint.url !== attached.endpoint.url ||
			endpoint.token !== attached.endpoint.token ||
			endpoint.pid !== attached.pid
		) {
			await this.#retireAttachment(attached, endpoint ? "replaced_same_generation" : undefined);
			return false;
		}
		if (!skipReplay) attached.barrier.held ??= [];
		attached.published = true;
		attached.publication.resolve();
		attached.initializingPublication = true;
		try {
			void Promise.resolve()
				.then(() => this.#deps.onNotificationSubscriptionReady?.(attached.notificationSubscription))
				.catch(error => {
					this.#detachNotification(attached, "cancelled");
					logger.warn(`SDK notification subscription ready hook failed locally: ${String(error)}`);
				});
			await this.#deps.onAttachmentReady?.(attached.capability);
		} catch (error) {
			const stillCurrent = this.#sessions.get(attached.sessionId) === attached;
			attached.published = false;
			this.#adopted.delete(attached.sessionId);
			if (stillCurrent) this.#sessions.delete(attached.sessionId);
			attached.dispose();
			await attached.client.close().catch(() => undefined);
			if (stillCurrent)
				try {
					await this.#deps.onSessionRemoved?.(attached.capability);
				} catch {
					// Ready publication failed closed; provider cleanup remains best effort.
				}
			throw error;
		} finally {
			attached.initializingPublication = false;
		}
		if (skipReplay) return true;
		if (!(await this.#deliverRecoveredFrames(attached))) return false;
		await this.#replayAttachment(attached, attached.cursor.seq);
		return true;
	}

	async #reinitializeAttachment(attached: AttachedSession): Promise<void> {
		const previous = attached.readyTail;
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				if (!this.#attachmentLive(attached)) return;
				const endpoint = await this.#readEndpoint(attached.indexed);
				if (
					!endpoint ||
					endpoint.url !== attached.endpoint.url ||
					endpoint.token !== attached.endpoint.token ||
					endpoint.pid !== attached.pid
				) {
					await this.#retireAttachment(attached, endpoint ? "replaced_same_generation" : undefined);
					return;
				}
				attached.initializingPublication = true;
				try {
					void Promise.resolve()
						.then(() => this.#deps.onNotificationSubscriptionReady?.(attached.notificationSubscription))
						.catch(error => {
							this.#detachNotification(attached, "cancelled");
							logger.warn(`SDK notification subscription reconnect hook failed locally: ${String(error)}`);
						});
					await this.#deps.onAttachmentReady?.(attached.capability);
				} catch {
					await this.#retireAttachment(attached);
					return;
				} finally {
					attached.initializingPublication = false;
				}
				if (this.#attachmentLive(attached)) await this.#replayAttachment(attached, attached.cursor.seq);
			});
		attached.readyTail = current;
		await current;
	}
	#reviveTransport(attached: AttachedSession): void {
		const connect = attached.client.connect?.bind(attached.client);
		if (!connect || this.#reviving.has(attached.id)) return;
		this.#reviving.add(attached.id);
		void connect()
			.catch(() => undefined)
			.finally(() => this.#reviving.delete(attached.id));
	}

	#running(runEpoch: number): boolean {
		return this.#started && runEpoch === this.#runEpoch;
	}

	#attachmentLive(attached: AttachedSession): boolean {
		return (
			this.#running(attached.runEpoch) &&
			!attached.barrier.detached &&
			!attached.barrier.failed &&
			this.#sessions.get(attached.sessionId) === attached
		);
	}

	#attachmentPublished(attached: AttachedSession): boolean {
		return attached.published && this.#attachmentLive(attached);
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

	async #boundedNotificationWork<T>(work: () => Promise<T> | T): Promise<T | typeof NOTIFICATION_WORK_TIMEOUT> {
		const timeout: Promise<typeof NOTIFICATION_WORK_TIMEOUT> = Bun.sleep(NOTIFICATION_WORK_TIMEOUT_MS).then(
			() => NOTIFICATION_WORK_TIMEOUT,
		);
		return await Promise.race([Promise.resolve().then(work), timeout]);
	}

	#detachNotification(
		attached: AttachedSession,
		reason: "removed" | "replaced" | "replaced_same_generation" | "cancelled",
	): void {
		if (attached.notificationCancelled) return;
		attached.notificationCancelled = true;
		this.#recordNotificationReceipt(attached.notificationSubscription, "pending", reason);
		const work = this.#boundedNotificationWork(() =>
			this.#deps.onNotificationSubscriptionRemoved?.(attached.notificationSubscription, reason),
		)
			.then(
				result =>
					this.#recordNotificationReceipt(
						attached.notificationSubscription,
						result === NOTIFICATION_WORK_TIMEOUT ? "failed" : "completed",
						reason,
					),
				(error: unknown) =>
					this.#recordNotificationReceipt(
						attached.notificationSubscription,
						"failed",
						error instanceof Error ? error.message : String(error),
					),
			)
			.catch(() => undefined);
		void work;
	}

	#dispatchNotificationFrame(attached: AttachedSession, frame: SessionRouterFrame): void {
		if (attached.notificationCancelled || !this.#attachmentLive(attached)) return;
		const callback = this.#deps.onNotificationFrame;
		if (!callback) return;
		const work = this.#boundedNotificationWork(async () => {
			await callback(attached.notificationSubscription, frame);
			return true;
		}).then(
			result => {
				if (result === NOTIFICATION_WORK_TIMEOUT) {
					this.#detachNotification(attached, "cancelled");
					return;
				}
				if (frame.seq !== undefined)
					attached.notificationSubscription.advanceCursor(frame.generation ?? attached.generation, frame.seq);
			},
			(error: unknown) => {
				this.#detachNotification(attached, "cancelled");
				logger.warn(
					`SDK notification subscription ${attached.notificationSubscription.subscriptionId} failed locally: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			},
		);
		void work;
	}

	async #retireAttachment(
		attached: AttachedSession,
		explicitReason?: "removed" | "replaced" | "replaced_same_generation",
	): Promise<void> {
		this.#adopted.delete(attached.sessionId);
		if (this.#sessions.get(attached.sessionId) !== attached) return;
		this.#retirementVersions.set(attached.sessionId, (this.#retirementVersions.get(attached.sessionId) ?? 0) + 1);
		this.#sessions.delete(attached.sessionId);
		attached.dispose();
		const gate = Promise.withResolvers<void>();
		this.#retirements.set(attached.sessionId, gate.promise);
		try {
			let reason = explicitReason;
			if (reason === undefined) {
				try {
					await this.#index.refresh();
					const current = this.#index
						.listSessions()
						.sessions.find(session => session.sessionId === attached.sessionId);
					if (
						current?.live &&
						(current.endpointGeneration !== attached.generation ||
							current.pid !== attached.pid ||
							current.endpointMtimeMs !== attached.endpointMtimeMs)
					)
						reason = current.endpointGeneration === attached.generation ? "replaced_same_generation" : "replaced";
				} catch {
					// Revocation remains terminal when current Broker authority cannot be proven.
				}
			}
			reason ??= "removed";
			void Promise.resolve(this.#deps.onSessionRemoved?.(attached.capability, reason)).catch(error =>
				logger.warn(`SDK provider cleanup failed after authority revocation: ${String(error)}`),
			);
			this.#detachNotification(attached, reason);
			await attached.client.close().catch(() => undefined);
		} finally {
			gate.resolve();
			if (this.#retirements.get(attached.sessionId) === gate.promise) this.#retirements.delete(attached.sessionId);
		}
	}

	#failBarrier(attached: AttachedSession, reason: string): void {
		if (attached.barrier.detached || attached.barrier.failed) return;
		attached.barrier.failed = true;
		attached.barrier.held = undefined;
		logger.warn(
			`chat daemon replay barrier failed (${reason}); rebuilding session ${attached.sessionId} at generation ${attached.generation} from seq ${attached.cursor.seq}.`,
		);
	}
	#failDelivery(attached: AttachedSession, seq: number, error: unknown): void {
		const previous = this.#undelivered.get(attached.sessionId);
		const attempts = previous?.generation === attached.generation && previous.seq === seq ? previous.attempts + 1 : 1;
		const reason = error instanceof Error ? error.message : String(error);
		if (attempts >= DELIVERY_ATTEMPT_LIMIT) {
			this.#undelivered.delete(attached.sessionId);
			this.#removeRecoveredFrame(attached.sessionId, attached.generation, seq);
			attached.cursor.seq = seq;
			logger.warn(
				`chat daemon conceded seq ${seq} of session ${attached.sessionId} at generation ${attached.generation} after ${attempts} refused publications (${reason}); delivery resumes above it.`,
			);
			return;
		}
		this.#undelivered.set(attached.sessionId, { generation: attached.generation, seq, attempts });
		this.#failBarrier(attached, `publication failed at seq ${seq} (${reason})`);
	}

	#rememberRecoveredFrame(attached: AttachedSession, seq: number, frame: Record<string, unknown>): void {
		let pending = this.#recoveredFrames.get(attached.sessionId);
		if (!pending || pending.generation !== attached.generation) {
			pending = { generation: attached.generation, frames: [] };
			this.#recoveredFrames.set(attached.sessionId, pending);
		}
		const existing = pending.frames.find(item => item.seq === seq);
		if (existing) existing.frame = frame;
		else {
			pending.frames.push({ seq, frame });
			pending.frames.sort((left, right) => left.seq - right.seq);
		}
	}

	#removeRecoveredFrame(sessionId: string, generation: number, seq: number): void {
		const pending = this.#recoveredFrames.get(sessionId);
		if (!pending || pending.generation !== generation) return;
		pending.frames = pending.frames.filter(item => item.seq !== seq);
		if (pending.frames.length === 0) this.#recoveredFrames.delete(sessionId);
	}

	async #deliverRecoveredFrames(attached: AttachedSession): Promise<boolean> {
		const pending = this.#recoveredFrames.get(attached.sessionId);
		if (!pending || pending.generation !== attached.generation) return true;
		for (const item of [...pending.frames]) {
			if (item.seq <= attached.cursor.seq) {
				this.#removeRecoveredFrame(attached.sessionId, attached.generation, item.seq);
				continue;
			}
			await this.#enqueueFrame(attached, item.frame, "ordered");
			if (attached.barrier.detached || attached.barrier.failed) return false;
		}
		return true;
	}

	#schedule(task: Promise<void>): void {
		this.#pending.add(task);
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		);
	}

	async #deliverOutOfBandFrame(attached: AttachedSession, frame: Record<string, unknown>): Promise<void> {
		if (!this.#attachmentLive(attached)) return;
		if (!attached.published) {
			await attached.publication.promise.catch(() => undefined);
			if (!this.#attachmentPublished(attached)) return;
		}
		const correlated = this.#correlateFrame(frame);
		if (!correlated) return;
		if (correlated.sessionId !== undefined && correlated.sessionId !== attached.sessionId) return;
		if (correlated.generation !== undefined && correlated.generation !== attached.generation) return;
		this.#dispatchNotificationFrame(attached, correlated);
		void Promise.resolve(this.#deps.onFrame?.(attached.capability, correlated)).catch(error =>
			logger.warn(`SDK provider frame hook failed: ${String(error)}`),
		);
	}
	#enqueueFrame(attached: AttachedSession, frame: Record<string, unknown>, origin: FrameOrigin): Promise<void> {
		const previous = this.#frameTails.get(attached.id) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				if (!this.#attachmentLive(attached)) return;
				if (!attached.published) {
					await attached.publication.promise.catch(() => undefined);
					if (!this.#attachmentPublished(attached)) return;
				}
				const correlated = this.#correlateFrame(frame);
				if (!correlated) return;
				const seq = typeof frame.seq === "number" && Number.isSafeInteger(frame.seq) ? frame.seq : undefined;
				if (correlated.sessionId !== undefined && correlated.sessionId !== attached.sessionId) return;
				if (correlated.generation !== undefined && correlated.generation !== attached.generation) return;
				if (seq !== undefined && correlated.generation === undefined) return;
				const ownsSequence =
					correlated.generation === attached.generation &&
					(correlated.sessionId === undefined || correlated.sessionId === attached.sessionId);
				if (seq !== undefined && ownsSequence) {
					if (seq <= attached.cursor.seq) return;
					const held = attached.barrier.held;
					if (held && origin === "live") {
						if (held.length >= REPLAY_BARRIER_LIMIT) {
							this.#failBarrier(attached, `hold buffer overflowed at ${REPLAY_BARRIER_LIMIT} frames`);
							return;
						}
						held.push({ seq, frame });
						return;
					}
				}
				const publicationId =
					seq !== undefined && ownsSequence ? `${attached.sessionId}:${attached.generation}:${seq}` : undefined;
				try {
					const notificationFrame = publicationId === undefined ? correlated : { ...correlated, publicationId };
					this.#dispatchNotificationFrame(attached, notificationFrame);
					await this.#deps.onFrame?.(attached.capability, notificationFrame);
				} catch (error) {
					if (!this.#attachmentLive(attached)) return;
					if (seq === undefined || !ownsSequence) throw error;
					this.#failDelivery(attached, seq, error);
					return;
				}
				if (!this.#attachmentLive(attached)) return;
				if (seq !== undefined && ownsSequence) {
					this.#undelivered.delete(attached.sessionId);
					this.#removeRecoveredFrame(attached.sessionId, attached.generation, seq);
					if (seq > attached.cursor.seq) attached.cursor.seq = seq;
				}
			});
		this.#frameTails.set(attached.id, current);
		void current.then(
			() => {
				if (this.#frameTails.get(attached.id) === current) this.#frameTails.delete(attached.id);
			},
			() => {
				if (this.#frameTails.get(attached.id) === current) this.#frameTails.delete(attached.id);
			},
		);
		return current;
	}

	async #drainHeldFrames(attached: AttachedSession, held: HeldFrame[]): Promise<void> {
		for (;;) {
			if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
			if (held.length === 0) {
				attached.barrier.held = undefined;
				return;
			}
			const batch = held.splice(0, held.length).sort((left, right) => left.seq - right.seq);
			for (const entry of batch) await this.#enqueueFrame(attached, entry.frame, "ordered");
		}
	}

	async #replayAttachment(attached: AttachedSession, sinceSeq: number): Promise<void> {
		if (!this.#attachmentLive(attached)) return;
		const held: HeldFrame[] = attached.barrier.held ?? [];
		attached.barrier.held = held;
		try {
			let replay: Record<string, unknown>;
			for (let attempt = 0; ; attempt++) {
				try {
					const stopped = Promise.withResolvers<void>();
					const onStop = (): void => stopped.resolve();
					if (this.#stopController.signal.aborted) stopped.resolve();
					else this.#stopController.signal.addEventListener("abort", onStop, { once: true });
					const replayRequest = attached.client.request({
						type: "event_replay",
						sinceGeneration: attached.generation,
						sinceSeq,
					});
					let outcome: { kind: "response"; value: Record<string, unknown> } | { kind: "stopped" };
					try {
						outcome = await Promise.race([
							replayRequest.then(value => ({ kind: "response" as const, value })),
							stopped.promise.then(() => ({ kind: "stopped" as const })),
						]);
					} finally {
						this.#stopController.signal.removeEventListener("abort", onStop);
					}
					if (outcome.kind === "stopped") return;
					replay = outcome.value;
					break;
				} catch {
					if (attempt >= REPLAY_RETRY_ATTEMPTS) {
						this.#failBarrier(attached, "replay went unanswered");
						return;
					}
					await Bun.sleep(REPLAY_RETRY_BACKOFF_MS * 2 ** attempt);
					if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
				}
			}
			if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
			await this.#frameTails.get(attached.id)?.catch(() => undefined);
			if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
			const events = Array.isArray(replay.events)
				? replay.events.filter(
						(event): event is Record<string, unknown> =>
							!!event && typeof event === "object" && !Array.isArray(event),
					)
				: [];
			if (replay.gap !== undefined) {
				const gap = readReplayGap(replay.gap);
				if (!gap) {
					this.#failBarrier(attached, "replay reported a gap it did not state");
					return;
				}
				if (gap.kind === "generation_reset") {
					this.#failBarrier(attached, `replay reported a generation reset to ${gap.toGeneration}`);
					return;
				}
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
				const recovered = held.filter(entry => entry.seq <= gap.toSeq).sort((left, right) => left.seq - right.seq);
				const carried = held.filter(entry => entry.seq > gap.toSeq);
				held.splice(0, held.length, ...carried);
				const recoveredNote =
					recovered.length > 0 ? `, ${recovered.length} of them recovered from live delivery` : "";
				logger.warn(
					`chat daemon replay conceded a retention gap (sequences ${gap.fromSeq}-${gap.toSeq} are gone from the host${recoveredNote}); session ${attached.sessionId} generation ${attached.generation} resumes at seq ${gap.toSeq + 1}.`,
				);
				for (const entry of recovered) this.#rememberRecoveredFrame(attached, entry.seq, entry.frame);
				if (!(await this.#deliverRecoveredFrames(attached))) return;
				if (gap.toSeq > attached.cursor.seq) attached.cursor.seq = gap.toSeq;
			}
			for (const event of events) await this.#enqueueFrame(attached, event, "ordered");
			await this.#drainHeldFrames(attached, held);
		} finally {
			if (attached.barrier.held === held) attached.barrier.held = undefined;
		}
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
