import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, resolveEquivalentPath } from "@gajae-code/utils";
import { matchesIndexedEndpointFile } from "../broker/endpoint-authority";
import {
	canonicalSessionCwd,
	SessionIndex as DefaultSessionIndex,
	type IndexedSession,
	isSessionAuthorityEligible,
	resolveSessionLocator,
	type SessionIndex,
} from "../broker/session-index";
import { cancellableSleep, lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { SdkClient, SdkClientError, type SdkDispatchContext, type SdkDispatchHandler } from "../client/client";
import {
	endpointDirectory,
	readSdkBrokerDiscovery,
	readSdkSessionEndpoint,
	type SdkSessionEndpoint,
} from "../client/discovery";
import {
	type ActivatedPreparedSession,
	type PreparedSessionActivationClient,
	requestPreparedSessionActivation,
	SessionActivationError,
} from "../session-activation";
import { ACP_SESSION_RECONNECT, SESSION_REQUEST_TIMEOUT_MS } from "../session-reconnect";

export interface SessionEndpointIdentity {
	readonly dev: bigint;
	readonly mtimeMs: number;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly size: bigint;
	readonly dev: bigint;
	readonly ino: bigint;
}

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
	/** Proven no-follow endpoint identity, when the caller has one. */
	endpointIdentity?: SessionEndpointIdentity;
}): string {
	const endpointAuthorityDigest = crypto
		.createHash("sha256")
		.update(JSON.stringify({ url: input.url, token: input.token }))
		.digest("hex");
	const endpointIdentity = input.endpointIdentity
		? {
				dev: input.endpointIdentity.dev.toString(),
				mtimeMs: input.endpointIdentity.mtimeMs,
				mtimeNs: input.endpointIdentity.mtimeNs.toString(),
				ctimeNs: input.endpointIdentity.ctimeNs.toString(),
				size: input.endpointIdentity.size.toString(),
				dev: input.endpointIdentity.dev.toString(),
				ino: input.endpointIdentity.ino.toString(),
			}
		: undefined;
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
				endpointAuthorityDigest,
				endpointIdentity,
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
	/**
	 * Idempotent provider-lease heartbeat send that skips the pre-send authority
	 * reconcile (#4689).
	 *
	 * Optional so existing exported-capability implementations (including
	 * consumer-provided `resolveAttachment` callbacks on the Discord/Slack daemon
	 * options) stay source- and runtime-compatible (#4730 review). It is NOT a
	 * fail-open fallback: a caller that finds it absent must fail closed rather
	 * than route the heartbeat through `send()`, which would restore the 5s
	 * heartbeat-forced locked rescan this fix exists to remove. Router-owned
	 * attachments always provide it.
	 */
	sendMaintenance?(leaseId: string): unknown;
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

export interface SessionGenerationEvidence {
	readonly source: "session_index";
	readonly observedIndexSeq: number;
	readonly evidenceIndexSeq: number;
}

export interface SessionGenerationUnknownEvidence {
	readonly source: "session_index";
	readonly observedIndexSeq: number;
}

export type SessionGenerationStatus =
	| {
			readonly status: "current";
			readonly evidence: SessionGenerationEvidence;
	  }
	| {
			readonly status: "retired";
			readonly evidence: SessionGenerationEvidence & {
				readonly event: "host_unregistered" | "session_closed" | "session_deleted";
			};
	  }
	| {
			readonly status: "replaced";
			readonly currentGeneration: number;
			readonly evidence: SessionGenerationEvidence;
	  }
	| {
			readonly status: "unknown";
			readonly reason:
				| "invalid_generation"
				| "index_unavailable"
				| "index_incomplete"
				| "session_not_observed"
				| "generation_not_observed"
				| "generation_reused"
				| "ambiguous_authority"
				| "proof_expired"
				| "reconciliation_incomplete";
			readonly evidence?: SessionGenerationUnknownEvidence;
	  };

/** The transport surface Router keeps private behind its attachment capabilities. */
export interface SessionRouterClient {
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void;
	onReconnect?(handler: () => void): () => void;
	connect?(): Promise<void>;
	request(
		frame: Record<string, unknown>,
		options?: {
			timeoutMs?: number;
			/** Synchronous pre-send observer; a throw aborts the dispatch before the wire. */
			beforeDispatch?: (context: SdkDispatchContext) => void;
			/** Synchronous post-send boundary observer for transport-close-aware consumers. */
			onDispatch?: (context: SdkDispatchContext) => void;
		},
	): Promise<Record<string, unknown>>;
	/** Current private transport connection identity, surfaced only through its exact attachment. */
	readonly connectionId?: string;

	close(): Promise<void>;
	send(frame: Record<string, unknown>): void;
}

/** One frame after the caller's envelope/payload identity correlation. */
/** One frame after the caller's envelope/payload identity correlation. */
export interface SessionRouterFrame {
	readonly body: Record<string, unknown>;
	readonly name: string | undefined;
	readonly sessionId: string | undefined;
	readonly revision?: number;
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
	/** Test/runtime observer invoked after a frame's delivery and cursor update settle. */
	onFrameSettled?: (attachment: SessionAttachment, frame: SessionRouterFrame) => void;
	onAttachment?: (attachment: SessionAttachment) => Promise<void> | void;
	/** Called only after the opaque capability becomes externally current. */
	onAttachmentReady?: (attachment: SessionAttachment) => Promise<void> | void;
	/** Called before deferred replay may perform provider-facing mutations. */
	onReplayReady?: () => Promise<void> | void;
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
	/** Test seam for the idle liveness-sweep cadence (#4689). */
	idleSweepMs?: number;
	/** Test seam for the bounded initial attach pass. */
	startupAttachBudgetMs?: number;
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
	/** Limits attachment to exact ids selected by a Broker-scoped operation. */
	sessionIds?: readonly string[];
	deps?: SessionRouterDeps;
	/** Runtime-specific identity validation; Router supplies a conservative fallback. */
	correlateFrame?: SessionRouterFrameCorrelator;
}

/**
 * Builds the observer-facing frame for router dispatch callbacks: the injected
 * session endpoint token (and any other credential-shaped field) is removed,
 * and the result is deep-frozen so a malicious observer can neither read
 * credentials nor mutate what the wire carries. The internal wire frame keeps
 * the token; only the callback copy is redacted.
 */
function redactDispatchFrame(frame: Record<string, unknown>): Record<string, unknown> {
	const redacted: Record<string, unknown> = { ...frame };
	delete redacted.token;
	const frozen = deepFreeze(redacted);
	return frozen as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
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
	/** No-follow endpoint identity proven before this attachment became current. */
	readonly endpointIdentity: SessionEndpointIdentity;
	readonly runEpoch: number;
	readonly client: SessionRouterClient;
	readonly indexed: IndexedSession;
	readonly cursor: { seq: number };
	readonly barrier: ReplayBarrier;
	readonly capability: SessionAttachment;
	readonly notificationSubscription: NotificationSubscription;
	notificationCancelled: boolean;
	/** Consecutive refused notification publications; reset by the next delivered frame. */
	notificationFailures: number;
	readonly notificationCursor: { generation: number; seq: number };
	published: boolean;
	initializingPublication: boolean;
	replayPending: boolean;
	replayPendingSince?: number;
	replayPendingToken?: object;
	drainingHeldSeq?: number;
	drainingHeldBatch?: HeldFrame[];
	readyTail: Promise<void>;
	readonly publication: { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void };
	dispose: () => void;
};

/**
 * True when the transport dispatched the frame and the peer never answered it.
 *
 * `SdkClient` mints `uncertain_after_send` exactly for a request whose frame
 * reached the socket before its budget lapsed or the connection dropped, which
 * is the signature of a live listener with a stalled event loop. The attach-path
 * replay treats it as definitive for that pass instead of retrying, because an
 * identical retry has nothing new to observe.
 */
function isUnansweredAfterDispatch(error: unknown): boolean {
	return error instanceof SdkClientError && error.code === "uncertain_after_send";
}

const REPLAY_BARRIER_LIMIT = 1_024;
const REPLAY_PENDING_STALL_MS = 10_000;
const REPLAY_RETRY_ATTEMPTS = 3;
const REPLAY_RETRY_BACKOFF_MS = 100;
const DELIVERY_ATTEMPT_LIMIT = 3;
const ATTACH_CONCURRENCY = 4;
/**
 * How long `start()` waits for the initial attach pass before returning.
 *
 * A session host whose listener accepts while its loop never serves answers
 * nothing, and the initial pass is what `start()` awaits, so startup used to
 * cost the sum of every such session's request budget: 40.7s of a 40.9s
 * measured startup for ONE wedged host, against callers that allow 10s.
 *
 * A per-request cap is the wrong instrument — a host settling a cancellation
 * grace is legitimately slow to answer a replay, and cutting it there fails a
 * barrier that flow depends on. So the budget is on the pass, not the frame:
 * the pass keeps running to completion in the background (it is serialized on
 * the reconcile tail like every other pass, and the 2s tick converges after
 * it), while `start()` stops blocking the caller on stragglers. Attachments
 * that answered are already published and usable when this lapses.
 */
const STARTUP_ATTACH_BUDGET_MS = 5_000;
/** Bound on the straggler list in one startup diagnostic line. */
const STARTUP_STRAGGLER_LOG_LIMIT = 8;
const ATTACH_CONNECT_TIMEOUT_MS = 10_000;
const NOTIFICATION_WORK_TIMEOUT_MS = 5_000;
// Core shutdown waits only for Router reconciliation and client close; provider
// notification work is bounded separately by NOTIFICATION_WORK_TIMEOUT_MS.
const ROUTER_SHUTDOWN_TIMEOUT_MS = 5_000;
/**
 * Idle liveness-sweep cadence (#4689). When the session index is unchanged and
 * no adoption is pending, the 2s reconcile tick is only a change-stamp check;
 * the full attach/retire body runs on index changes and on this sweep, which
 * bounds time-driven transitions (dead host pid, aged heartbeat, dropped
 * transport revival) without re-projecting the whole index every tick. 30s
 * stays well inside the index's own 2×60s heartbeat-freshness window.
 */
const SESSION_ROUTER_IDLE_SWEEP_MS = 30_000;
const NOTIFICATION_WORK_TIMEOUT = Symbol("notification_work_timeout");
/**
 * Consecutive local notification-dispatch failures tolerated before the
 * subscription is conceded. A provider that refuses ONE publication is not a
 * dead subscription: it has already settled that publication as rejected on its
 * own side, and the next frame normally succeeds. Cancelling on the first
 * rejection latched `notificationCancelled` for the life of the
 * `AttachedSession`, which only a new attachment clears -- a still-running
 * session never gets one, so its mirroring stayed dead until the session was
 * restarted. Mirrors {@link DELIVERY_ATTEMPT_LIMIT} on the ordered path.
 */
const NOTIFICATION_LOCAL_FAILURE_LIMIT = 5;
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

function readNonnegativeSequence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function lstatEndpoint(file: string): Promise<SessionEndpointIdentity | undefined> {
	const stat = await fs.lstat(file).catch(() => undefined);
	if (!stat?.isFile()) return undefined;
	const identity = await fs.lstat(file, { bigint: true }).catch(() => undefined);
	if (!identity?.isFile()) return undefined;
	if (
		stat.size !== Number(identity.size) ||
		stat.ino !== Number(identity.ino) ||
		Math.abs(stat.mtimeMs - Number(identity.mtimeNs) / 1_000_000) > 0.0005 ||
		Math.abs(stat.ctimeMs - Number(identity.ctimeNs) / 1_000_000) > 0.0005
	)
		return undefined;
	return {
		dev: identity.dev,
		mtimeMs: stat.mtimeMs,
		mtimeNs: identity.mtimeNs,
		ctimeNs: identity.ctimeNs,
		size: identity.size,
		dev: identity.dev,
		ino: identity.ino,
	};
}

function warningAffectsSession(warning: string, sessionId: string): boolean {
	return !warning.startsWith("Session ") || warning.includes(`Session ${sessionId} `);
}

function sameEndpointIdentity(expected: SessionEndpointIdentity, current: SessionEndpointIdentity): boolean {
	return (
		expected.dev === current.dev &&
		expected.mtimeMs === current.mtimeMs &&
		expected.mtimeNs === current.mtimeNs &&
		expected.ctimeNs === current.ctimeNs &&
		expected.size === current.size &&
		expected.dev === current.dev &&
		expected.ino === current.ino
	);
}

function matchesIndexedEndpointIdentity(identity: SessionEndpointIdentity, indexed: IndexedSession): boolean {
	return (
		indexed.endpointMtimeMs !== undefined &&
		Number.isFinite(indexed.endpointMtimeMs) &&
		Math.abs(identity.mtimeMs - indexed.endpointMtimeMs) <= 0.001 &&
		(indexed.endpointFileId === undefined || indexed.endpointFileId === `${identity.dev}:${identity.ino}`)
	);
}

function readFrameSequenceClaim(frame: Record<string, unknown>): {
	claimed: boolean;
	valid: boolean;
	seq?: number;
} {
	if (!Object.hasOwn(frame, "seq")) return { claimed: false, valid: true };
	const seq = readSequence(frame.seq);
	return seq === undefined ? { claimed: true, valid: false } : { claimed: true, valid: true, seq };
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
	if (outerSession !== undefined && innerSession !== undefined && outerSession !== innerSession) return undefined;
	const sessionClaim = outerSession !== undefined ? outerSession : innerSession;
	const generationClaim = outerGeneration;
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
		revision: typeof frame.revision === "number" ? frame.revision : undefined,
		generation,
		commandId,
		turnId,
		seq: readSequence(frame.seq),
	};
}

function coordinateFreeRouterFrame(correlated: SessionRouterFrame): SessionRouterFrame {
	return {
		body: correlated.body,
		name: correlated.name,
		sessionId: correlated.sessionId,
		...(correlated.revision === undefined ? {} : { revision: correlated.revision }),
		generation: undefined,
		seq: undefined,
		...(correlated.commandId === undefined ? {} : { commandId: correlated.commandId }),
		...(correlated.turnId === undefined ? {} : { turnId: correlated.turnId }),
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
	readonly #sessionIds: ReadonlySet<string> | undefined;
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
	#reconcilePending: { readonly runEpoch: number; force: boolean } | undefined;
	#attachmentTails = new Map<string, Promise<boolean>>();
	/**
	 * Set when a live indexed session failed to attach; keeps the idle gate
	 * from parking retries until the 30s sweep (#4689 review).
	 */
	#retryPending = false;
	/** Monotonic time of the last completed full reconcile body (#4689). */
	#lastReconcileSweepAt = 0;
	/** Index sequence the last completed full reconcile body processed (#4689). */
	#lastReconciledIndexSeq = -1;
	#ready = false;
	#started = false;
	#startPromise: Promise<void> | undefined;
	#stopPromise: Promise<void> | undefined;
	#stopController = new AbortController();
	#runEpoch = 0;

	constructor(options: SessionRouterOptions) {
		this.#agentDir = options.agentDir;
		this.#sessionIds = options.sessionIds === undefined ? undefined : new Set(options.sessionIds);
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
		if (this.#stopPromise) await this.#stopPromise;
		if (this.#startPromise) return await this.#startPromise;
		if (this.#started) return;
		this.#started = true;
		const startup = this.#startImpl();
		this.#startPromise = startup;
		try {
			await startup;
		} finally {
			if (this.#startPromise === startup) this.#startPromise = undefined;
		}
	}

	async #startImpl(): Promise<void> {
		const runEpoch = ++this.#runEpoch;
		if (this.#stopController.signal.aborted) {
			this.#stopController = new AbortController();
			this.#reconcileTail = Promise.resolve();
			this.#reconcilePending = undefined;
			this.#frameTails.clear();
			this.#attachmentTails.clear();
			// A restart must re-run the full body on the first tick: reset the
			// idle-gate markers so stale state cannot carry across run epochs.
			this.#lastReconcileSweepAt = 0;
			this.#lastReconciledIndexSeq = -1;
		}
		try {
			// Seed a cold reader from the snapshot before the forced authority refresh.
			// Forced passes must not reopen the index repeatedly, but startup still
			// needs the one-time open/replay boundary for compacted indexes.
			await this.#index.open();
			// Startup keeps its settled contract for every host that answers within
			// STARTUP_ATTACH_BUDGET_MS: those attachments are published with their
			// initial replay delivered. Past that budget the pass continues in the
			// background instead of owning the caller's deadline.
			const initialPass = this.#serialReconcile(runEpoch, true, true);
			// Cancelled as soon as the race settles. Promise.race leaves the loser pending,
			// and a pending Bun.sleep keeps the event loop alive, so a startup that settled
			// in milliseconds still owed the rest of the budget before the process could exit.
			const startupCutoff = new AbortController();
			const settled = await Promise.race([
				initialPass.then(() => true),
				cancellableSleep(this.#deps.startupAttachBudgetMs ?? STARTUP_ATTACH_BUDGET_MS, startupCutoff.signal).then(
					() => false,
				),
			]).finally(() => startupCutoff.abort());
			if (!settled) {
				// Name the sessions the budget was spent on. Without this the lapse is
				// silent and the only symptom is a slow startup somewhere else, which
				// is what made the original 40s stall cost an instrumented bisect to
				// attribute. Session id and pid identify the process an operator has
				// to look at; endpoint url and token are never logged.
				const stragglers = this.#index
					.listSessions()
					.sessions.filter(session => {
						if (!session.live) return false;
						const attached = this.#sessions.get(session.sessionId);
						// No attachment yet, or one whose replay barrier is still open:
						// publication precedes replay, so `published` alone cannot tell
						// an attachment that finished replaying from one still waiting.
						return attached?.published !== true || attached.barrier.held !== undefined;
					})
					.map(session => `${session.sessionId}@pid ${session.pid}`);
				if (stragglers.length > 0)
					logger.warn(
						`SDK session Router startup returned before ${stragglers.length} attachment(s) settled: ${stragglers.slice(0, STARTUP_STRAGGLER_LOG_LIMIT).join(", ")}${stragglers.length > STARTUP_STRAGGLER_LOG_LIMIT ? ", …" : ""}. Those hosts have not answered their initial replay; reconciliation keeps retrying them, and a host that never answers needs that process stopped.`,
					);
				void initialPass.catch(error =>
					logger.warn(`SDK session Router initial reconciliation failed after startup returned: ${String(error)}`),
				);
			}
			if (!this.#running(runEpoch)) return;
			const timer = (this.#deps.setInterval ?? setInterval)(
				() => this.#schedule(this.#serialReconcile(runEpoch, true)),
				2_000,
			);
			// Reconciliation is background upkeep and must not be the reason a host process
			// stays alive. stop() still clears it on the normal path; this only keeps a
			// caller that never stops the Router from hanging at exit.
			timer.unref?.();
			this.#stopTimer = () => (this.#deps.clearInterval ?? clearInterval)(timer);
		} catch (error) {
			if (this.#running(runEpoch)) await this.stop();
			throw error;
		}
	}

	/** Exposed for deterministic callers and reconciliation tests. */
	async reconcile(options: { waitForReplay?: boolean } = {}): Promise<void> {
		const waitForReplay = options.waitForReplay ?? true;
		// Explicit callers always force the full body (#4689): the idle gate must
		// never make an explicit reconcile a no-op.
		await this.#serialReconcile(this.#runEpoch, !waitForReplay, true);
		if (!waitForReplay) return;
		// Periodic reconciliation may have published an attachment while its
		// initial replay continues on that attachment's isolated ready tail.
		// Explicit callers retain the historical synchronous contract without
		// putting any ready tail back onto the fleet-wide reconcile tail.
		await Promise.all([...this.#sessions.values()].map(attached => attached.readyTail));
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
			(this.#sessionIds !== undefined && !this.#sessionIds.has(sessionId ?? "")) ||
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
		const cwd = await canonicalSessionCwd(fallback.cwd);
		const stateRoot = path.join(cwd, ".gjc", "state");
		const indexed: IndexedSession = {
			sessionId,
			locator: await resolveSessionLocator(cwd, stateRoot),
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
		const indexedCurrent = listing.warnings.some(warning => warningAffectsSession(warning, sessionId))
			? undefined
			: listing.sessions.find(item => item.sessionId === sessionId);
		if (indexedCurrent && sameIndexedAuthority(indexed, indexedCurrent))
			await this.#serialReconcile(this.#runEpoch, true, true);
		return capability;
	}

	async stop(): Promise<void> {
		if (this.#stopPromise) return await this.#stopPromise;
		const stopping = this.#stopImpl();
		this.#stopPromise = stopping;
		try {
			await stopping;
		} finally {
			if (this.#stopPromise === stopping) this.#stopPromise = undefined;
		}
	}

	async #stopImpl(): Promise<void> {
		// Detach the in-flight startup promise before invalidating its epoch. A
		// later start must not return a promise owned by the stopped epoch.
		this.#startPromise = undefined;
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
			shutdownTasks.push(
				Promise.resolve(this.#deps.onSessionRemoved?.(attached.capability)).catch(error => {
					logger.warn(`SDK provider cleanup failed during router stop: ${String(error)}`);
					throw error;
				}),
			);
		}
		this.#adopted.clear();
		// Provider notification work is detached and bounded independently; core
		// shutdown waits only for Router reconciliation and client close.
		const pending = Promise.allSettled([this.#reconcileTail, ...this.#attachmentTails.values(), ...shutdownTasks]);
		// Cancelled once the race settles, so a completed shutdown does not hold the
		// event loop open for the remainder of the timeout.
		const shutdownCutoff = new AbortController();
		const outcome = await Promise.race([
			pending.then(results => ({ kind: "settled" as const, results })),
			cancellableSleep(ROUTER_SHUTDOWN_TIMEOUT_MS, shutdownCutoff.signal).then(() => ({
				kind: "timeout" as const,
			})),
		]).finally(() => shutdownCutoff.abort());
		if (outcome.kind === "timeout") {
			logger.warn(
				`SessionRouter shutdown exceeded ${ROUTER_SHUTDOWN_TIMEOUT_MS}ms; authority is revoked and cleanup continues in background.`,
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
		options?: {
			timeoutMs?: number;
			beforeDispatch?: (context: SdkDispatchContext) => void;
			onDispatch?: SdkDispatchHandler;
		},
	): Promise<Record<string, unknown>> {
		const matchesExpectedAuthority = (attachment: SessionAttachment): boolean =>
			expectedAttachment === undefined ||
			attachment === expectedAttachment ||
			(expectedAttachment.authorityId !== undefined && attachment.authorityId === expectedAttachment.authorityId);
		const publishing = this.#sessions.get(sessionId);
		if (!publishing || !matchesExpectedAuthority(publishing.capability) || !publishing.initializingPublication)
			await this.#serialReconcile(this.#runEpoch, true, true);
		const attached = this.#sessions.get(sessionId);
		if (!attached || !this.#attachmentPublished(attached))
			throw new SessionRouterError("pre_send", "SDK session attachment is unavailable: session not published.");
		if (expectedGeneration !== undefined && expectedGeneration !== attached.generation)
			throw new SessionRouterError("pre_send", "SDK session endpoint changed before command dispatch.");
		if (!matchesExpectedAuthority(attached.capability))
			throw new SessionRouterError("pre_send", "SDK session attachment changed before command dispatch.");
		if (attached.initializingPublication) {
			const proven = await this.#readProvenEndpoint(attached.indexed);
			if (
				!proven ||
				proven.endpoint.url !== attached.endpoint.url ||
				proven.endpoint.token !== attached.endpoint.token ||
				proven.endpoint.pid !== attached.pid ||
				!sameEndpointIdentity(attached.endpointIdentity, proven.identity)
			) {
				await this.#retireAttachment(attached, proven ? "replaced_same_generation" : undefined);
				throw new SessionRouterError("pre_send", "SDK session attachment changed during publication.");
			}
		}
		// A caller that sized its own budget keeps its own; everything else gets
		// the long-lived session budget instead of the transport's one-shot
		// default, which a cold host's first credential-collecting query
		// outruns (#4258).
		// Dispatch observers must never see the injected session endpoint
		// token: the wire frame alone carries credentials, and the observer
		// context is a deep-frozen, token-redacted copy (#4640 review).
		const wireFrame = this.#prepareFrame(attached, frame);
		const { beforeDispatch, onDispatch, ...requestOptions } = options ?? {};
		const response = await attached.client.request(wireFrame, {
			...requestOptions,
			timeoutMs: requestOptions.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS,
			...(beforeDispatch
				? {
						beforeDispatch: (context: SdkDispatchContext) => {
							return beforeDispatch({
								...context,
								frame: redactDispatchFrame(context.frame),
							});
						},
					}
				: {}),
			...(onDispatch
				? {
						onDispatch: (context: SdkDispatchContext) => {
							return onDispatch({
								...context,
								frame: redactDispatchFrame(context.frame),
							});
						},
					}
				: {}),
		});
		const settled = this.#sessions.get(sessionId);
		if (
			!settled ||
			!this.#attachmentPublished(settled) ||
			(expectedGeneration !== undefined && settled.generation !== expectedGeneration) ||
			!matchesExpectedAuthority(settled.capability)
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
			if (listing.warnings.some(warning => warningAffectsSession(warning, sessionId))) return undefined;
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
		const proven = await this.#readProvenEndpoint(indexed).catch(() => null);
		if (
			!proven ||
			proven.endpoint.stale === true ||
			proven.endpoint.pid !== indexed.pid ||
			!proven.endpoint.token ||
			!sameEndpointIdentity(attached.endpointIdentity, proven.identity)
		)
			return undefined;
		if (this.#sessions.get(sessionId) !== attached || !this.#attachmentPublished(attached)) return undefined;
		return { sessionId, endpointGeneration: attached.generation };
	}

	/**
	 * Reconciles one exact endpoint generation without exposing endpoint or process
	 * credentials. Retirement is returned only from a retained positive terminal
	 * index event; absence, corruption, incomplete reconciliation, and generation
	 * reuse remain explicitly unknown.
	 */
	async generationStatus(sessionId: string, endpointGeneration: number): Promise<SessionGenerationStatus> {
		if (!Number.isSafeInteger(endpointGeneration) || endpointGeneration <= 0)
			return { status: "unknown", reason: "invalid_generation" };
		try {
			await this.#index.open();
			const status = await this.#index.generationStatus(sessionId, endpointGeneration);
			const evidence: SessionGenerationUnknownEvidence = {
				source: "session_index",
				observedIndexSeq: status.observedIndexSeq,
			};
			switch (status.status) {
				case "current":
					return { status: "current", evidence: { ...evidence, evidenceIndexSeq: status.evidenceIndexSeq } };
				case "retired":
					return {
						status: "retired",
						evidence: { ...evidence, evidenceIndexSeq: status.evidenceIndexSeq, event: status.event },
					};
				case "replaced":
					return {
						status: "replaced",
						currentGeneration: status.currentGeneration,
						evidence: { ...evidence, evidenceIndexSeq: status.evidenceIndexSeq },
					};
				case "unknown":
					return { status: "unknown", reason: status.reason, evidence };
			}
		} catch {
			return { status: "unknown", reason: "index_unavailable" };
		}
	}

	/** Activates a prepared session through one Router-owned, one-shot SDK client. */
	async activatePreparedSession(sessionId: string): Promise<ActivatedPreparedSession> {
		let indexed: IndexedSession | undefined;
		try {
			await this.#index.open();
			await this.#index.refresh();
			const listing = this.#index.listSessions();
			if (listing.warnings.some(warning => warningAffectsSession(warning, sessionId)))
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
		const provenEndpoint = await this.#readProvenEndpoint(indexed).catch(() => null);
		const endpoint = provenEndpoint?.endpoint;
		if (
			!provenEndpoint ||
			!endpoint ||
			endpoint.stale === true ||
			!endpoint.url ||
			!endpoint.token ||
			endpoint.pid !== indexed.pid
		)
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
			const currentProvenEndpoint = await this.#readProvenEndpoint(indexed).catch(() => null);
			const currentEndpoint = currentProvenEndpoint?.endpoint;
			if (
				!currentProvenEndpoint ||
				!currentEndpoint ||
				currentEndpoint.url !== endpoint.url ||
				currentEndpoint.token !== endpoint.token ||
				currentEndpoint.pid !== endpoint.pid ||
				!sameEndpointIdentity(provenEndpoint.identity, currentProvenEndpoint.identity)
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

	#serialReconcile(runEpoch: number, deferReplay = false, force = false): Promise<void> {
		if (!this.#running(runEpoch)) return Promise.resolve();
		const pending = this.#reconcilePending;
		if (pending?.runEpoch === runEpoch) {
			// A dispatch that needs the exact authority body must not inherit an
			// already-queued idle-timer pass: escalate the queued pass (#4689
			// review). If the pass already started, this call queues a forced
			// follow-up on the tail instead.
			if (force) pending.force = true;
			return this.#reconcileTail;
		}
		const queued = { runEpoch, force };
		this.#reconcilePending = queued;
		const task = this.#reconcileTail
			.catch(() => undefined)
			.then(async () => {
				if (this.#reconcilePending === queued) this.#reconcilePending = undefined;
				try {
					await this.#reconcile(runEpoch, deferReplay, queued.force);
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

	async #reconcile(runEpoch: number, deferReplay = false, force = false): Promise<void> {
		if (!this.#running(runEpoch)) return;
		// Idle-poll fast path (#4689) is for TIMER TICKS ONLY. A forced pass backs
		// a dispatch, adoption, explicit reconcile, or start, and must serialize
		// against the index lock: the unlocked stamp cut cannot order itself
		// against a writer that commits an unregister/re-registration between the
		// stat and the listSessions()/request() below, which would let a forced
		// request go out through a no-longer-authoritative attachment (#4730
		// review). Forced passes therefore take the locked authority read.
		// `refresh()` is the locked read; `open()` is deliberately NOT re-run per
		// forced pass -- re-entering it disturbs the shared open-group state that
		// live attachments and replay cursors depend on, which broke socket-loss
		// resume.
		let changed: boolean;
		if (force) {
			await this.#index.refresh();
			changed = true;
		} else changed = await this.#index.refreshIfChanged();
		if (!this.#running(runEpoch)) return;
		// Idle gate (#4689), timer ticks ONLY: dispatch, adoption, explicit
		// reconcile, and start pass force=true and keep the exact locked
		// authority body. A gated tick must also never park local recovery: a
		// failed replay barrier, a retired-but-listed attachment, or an
		// unpublished attachment all force the body. `changed` covers durable
		// index updates; a corrupt suffix never takes the stamp fast path.
		const sweepDue =
			performance.now() - this.#lastReconcileSweepAt >= (this.#deps.idleSweepMs ?? SESSION_ROUTER_IDLE_SWEEP_MS);
		if (
			!force &&
			!changed &&
			!sweepDue &&
			this.#adopted.size === 0 &&
			!this.#retryPending &&
			!this.#hasUnhealthyAttachment() &&
			this.#index.indexSeq === this.#lastReconciledIndexSeq
		) {
			// The 2s tick is also the session-transport revival mechanism:
			// connect() is a cheap no-op on a healthy socket, so skipped ticks
			// keep the reconnect latency without re-projecting the index.
			for (const attached of this.#sessions.values()) this.#reviveTransport(attached);
			return;
		}
		const indexed = this.#index.listSessions();
		const live = indexed.sessions.filter(
			session =>
				!indexed.warnings.some(warning => warningAffectsSession(warning, session.sessionId)) &&
				session.live &&
				isSessionAuthorityEligible(session) &&
				!session.terminalUncertain &&
				(this.#sessionIds === undefined || this.#sessionIds.has(session.sessionId)),
		);
		const liveIds = new Set(live.map(session => session.sessionId));
		const attachedIds = new Set<string>();
		for (const [sessionId, adopted] of [...this.#adopted]) {
			if (indexed.warnings.some(warning => warningAffectsSession(warning, sessionId))) continue;
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
		let nextAttachment = 0;
		let attachThrew = false;
		const attachWorkers = Array.from({ length: Math.min(ATTACH_CONCURRENCY, live.length) }, async () => {
			for (;;) {
				if (!this.#running(runEpoch)) return;
				const session = live[nextAttachment++];
				if (!session) return;
				try {
					if (await this.#attach(session, runEpoch, undefined, false, false, deferReplay))
						attachedIds.add(session.sessionId);
				} catch {
					// A live row that failed to attach is local recovery state the
					// durable index cannot see: keep ticks retrying it (#4689).
					// A definitive no-endpoint #attach miss (returned false) does
					// not latch — that row can never attach.
					attachThrew = true;
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
		this.#lastReconcileSweepAt = performance.now();
		// Record the snapshot the body actually enumerated: a nested exact
		// refresh during endpoint validation may have already advanced the
		// index past it, and those newer events were NOT processed here.
		this.#lastReconciledIndexSeq = indexed.indexSeq;
		// The retry latch is set only where a live row's attach throws (see the
		// attach worker); a definitive no-endpoint miss can never attach.
		this.#retryPending = attachThrew && live.some(session => !attachedIds.has(session.sessionId));
	}

	/**
	 * Bounded, lock-free endpoint-authority read for maintenance heartbeats
	 * (#4730 review). `#readEndpoint` finishes with a locked `#index.refresh()`,
	 * which on the 5s lease heartbeat would restore exactly the locked full index
	 * scan this work removes. The heartbeat does not need index re-projection: it
	 * only needs to know that THIS endpoint record still carries the authority
	 * the attachment was published with, which the endpoint file itself proves.
	 * Returns true only when the durable record still matches.
	 */
	async #endpointAuthorityUnchanged(attached: AttachedSession): Promise<boolean> {
		const indexed = attached.indexed;
		if (!isSessionAuthorityEligible(indexed)) return false;
		if (indexed.endpointMtimeMs === undefined || !Number.isFinite(indexed.endpointMtimeMs)) return false;
		// mtime alone is not a replacement-safe identity (#4730 review): a rewrite or
		// rename-replace inside one filesystem tick can preserve it. The inode the
		// attachment was PUBLISHED against is therefore the identity, and the
		// generation is compared so a re-registration reusing the same url/token/pid
		// cannot keep the old attachment authorized.
		const identityBefore = await lstatEndpoint(attached.endpoint.path);
		if (!identityBefore || !sameEndpointIdentity(attached.endpointIdentity, identityBefore)) return false;
		if (!matchesIndexedEndpointIdentity(identityBefore, indexed)) return false;
		let raw: Record<string, unknown>;
		try {
			const parsed = JSON.parse(await Bun.file(attached.endpoint.path).text());
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
			raw = parsed as Record<string, unknown>;
		} catch {
			return false;
		}
		if (
			raw.sessionId !== indexed.sessionId ||
			raw.pid !== attached.pid ||
			raw.stale === true ||
			raw.url !== attached.endpoint.url ||
			raw.token !== attached.endpoint.token
		)
			return false;
		// The endpoint record itself carries no generation, so generation identity
		// comes from the indexed row this attachment was published against.
		if (indexed.endpointGeneration !== attached.generation) return false;
		if (raw.endpointGeneration !== undefined && raw.endpointGeneration !== attached.generation) return false;
		const identityAfter = await lstatEndpoint(attached.endpoint.path);
		return (
			identityAfter !== undefined &&
			matchesIndexedEndpointIdentity(identityAfter, indexed) &&
			sameEndpointIdentity(attached.endpointIdentity, identityAfter)
		);
	}

	/**
	 * Returns the endpoint together with the full identity this read PROVED (#4730
	 * review). The identity travels with the value instead of living in a side
	 * map, so every consumer decision compares the same proof and the two cannot
	 * drift apart.
	 */
	async #readProvenEndpoint(
		indexed: IndexedSession,
	): Promise<{ endpoint: SdkSessionEndpoint; identity: SessionEndpointIdentity } | null> {
		if (!isSessionAuthorityEligible(indexed)) return null;
		const cwd = indexed.locator.cwd;
		const defaultStateRoot = path.join(cwd, ".gjc", "state");
		// Locator cwd is already canonical. `stateRoot` remains the host-provided
		// authority path, so this comparison resolves equivalent paths only for the
		// state-root identity boundary; cwd never retains lexical symlink spellings.
		const indexedStateRoot = resolveEquivalentPath(indexed.locator.stateRoot);
		const scope =
			indexedStateRoot === resolveEquivalentPath(defaultStateRoot)
				? "default"
				: indexedStateRoot === resolveEquivalentPath(path.join(defaultStateRoot, "chat"))
					? "chat"
					: undefined;
		if (!scope || indexed.endpointMtimeMs === undefined || !Number.isFinite(indexed.endpointMtimeMs)) return null;
		const endpointPath = path.join(endpointDirectory(cwd, scope), `${indexed.sessionId}.json`);
		const endpointIdentity = await lstatEndpoint(endpointPath);
		const endpoint = await readSdkSessionEndpoint(cwd, indexed.sessionId, scope);
		if (!endpoint || endpoint.stale || endpoint.pid !== indexed.pid) return null;
		if (!endpointIdentity || !matchesIndexedEndpointIdentity(endpointIdentity, indexed)) return null;
		// Identity is proven INSIDE this authority read (#4730 review): sampling it
		// afterwards would let an identical rename between the read and the sample
		// install the replacement's inode as the trusted baseline.
		const provenIdentity = endpointIdentity;
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
		// Fail CLOSED on stat error and on any identity change across the body read.
		const endpointIdentityAfterRead = await lstatEndpoint(endpoint.path);
		if (
			!endpointIdentityAfterRead ||
			!matchesIndexedEndpointIdentity(endpointIdentityAfterRead, indexed) ||
			!sameEndpointIdentity(endpointIdentity, endpointIdentityAfterRead)
		)
			return null;
		await this.#index.refresh();
		const listing = this.#index.listSessions();
		if (listing.warnings.some(warning => warningAffectsSession(warning, indexed.sessionId))) return null;
		const current = listing.sessions.find(session => session.sessionId === indexed.sessionId);
		if (!current || !sameIndexedAuthority(indexed, current)) return null;
		return { endpoint, identity: provenIdentity };
	}

	/** Endpoint-only view for callers that do not make an authority decision. */
	async #readEndpoint(indexed: IndexedSession): Promise<SdkSessionEndpoint | null> {
		return (await this.#readProvenEndpoint(indexed))?.endpoint ?? null;
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
		deferReplay = false,
	): Promise<boolean> {
		const previous = this.#attachmentTails.get(indexed.sessionId) ?? Promise.resolve(true);
		const task = previous
			.catch(() => false)
			.then(() =>
				this.#attachUnserialized(indexed, runEpoch, resolvedEndpoint, skipReplay, deferPublication, deferReplay),
			);
		this.#attachmentTails.set(indexed.sessionId, task);
		try {
			return await task;
		} finally {
			if (this.#attachmentTails.get(indexed.sessionId) === task) this.#attachmentTails.delete(indexed.sessionId);
		}
	}

	async #attachUnserialized(
		indexed: IndexedSession,
		runEpoch: number,
		resolvedEndpoint?: SdkSessionEndpoint,
		skipReplay = false,
		deferPublication = false,
		deferReplay = false,
	): Promise<boolean> {
		const retirementVersion = this.#retirementVersions.get(indexed.sessionId) ?? 0;
		const retirement = this.#retirements.get(indexed.sessionId);
		if (retirement) await retirement;
		if (!this.#running(runEpoch)) return false;
		if (indexed.endpointMtimeMs === undefined) return false;
		// The identity travels with the endpoint from its authority read (#4730
		// review). A pre-resolved endpoint (adoption/lifecycle handoff) had no
		// authority read of its own, so it samples once here.
		const proven = resolvedEndpoint === undefined ? await this.#readProvenEndpoint(indexed) : null;
		const endpoint = resolvedEndpoint ?? proven?.endpoint ?? null;
		const endpointIdentity =
			resolvedEndpoint === undefined ? proven?.identity : await lstatEndpoint(resolvedEndpoint.path);
		const retirementAfterValidation = this.#retirements.get(indexed.sessionId);
		if (retirementAfterValidation) await retirementAfterValidation;
		if ((this.#retirementVersions.get(indexed.sessionId) ?? 0) !== retirementVersion)
			return await this.#attachUnserialized(indexed, runEpoch, undefined, skipReplay, deferPublication, deferReplay);
		if (!this.#running(runEpoch)) return false;
		if (!endpoint || !endpointIdentity) return false;
		const existing = this.#sessions.get(indexed.sessionId);
		const resumable =
			existing !== undefined &&
			existing.endpoint.url === endpoint.url &&
			existing.endpoint.token === endpoint.token &&
			existing.generation === indexed.endpointGeneration &&
			existing.pid === indexed.pid &&
			existing.endpointMtimeMs === indexed.endpointMtimeMs &&
			endpointIdentity !== undefined &&
			sameEndpointIdentity(existing.endpointIdentity, endpointIdentity);
		if (
			existing &&
			resumable &&
			!existing.barrier.failed &&
			(!existing.replayPending || Date.now() - (existing.replayPendingSince ?? Date.now()) < REPLAY_PENDING_STALL_MS)
		) {
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
							existing.endpointMtimeMs !== indexed.endpointMtimeMs ||
							endpointIdentity === undefined ||
							!sameEndpointIdentity(existing.endpointIdentity, endpointIdentity))
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
			return await this.#attachUnserialized(indexed, runEpoch, undefined, skipReplay, deferPublication, deferReplay);
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
				endpointIdentity,
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
					const proven = await this.#readProvenEndpoint(attached.indexed);
					if (
						!proven ||
						proven.endpoint.url !== attached.endpoint.url ||
						proven.endpoint.token !== attached.endpoint.token ||
						proven.endpoint.pid !== attached.pid ||
						!sameEndpointIdentity(attached.endpointIdentity, proven.identity)
					) {
						await this.#retireAttachment(attached, proven ? "replaced_same_generation" : undefined);
						throw new SessionRouterError("pre_send", "SDK session attachment changed during publication.");
					}
				} else await this.#serialReconcile(runEpoch, true, true);
				if (!attached || !this.#attachmentPublished(attached))
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				attached.client.send(this.#prepareFrame(attached, frame));
			},
			/**
			 * Provider-lease heartbeats skip the pre-send authority reconcile
			 * (#4689): the frame is idempotent and advisory, the native server
			 * drops wrong-token/stale-connection frames, and the 2s tick plus
			 * 30s sweep revalidate authority on their own cadence. The frame
			 * shape is fixed here so no command traffic can take this path;
			 * dispatch keeps using send().
			 */
			sendMaintenance: async (leaseId: string) => {
				if (!attached || !this.#attachmentPublished(attached))
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				// Renewal must fail closed against durable authority (#4730 review):
				// the idle path can defer full projection to the 30s sweep, so an
				// endpoint replaced in that window would otherwise keep receiving lease
				// renewals. This is the bounded LOCK-FREE check: it reads only this
				// endpoint record and never re-enters the locked index rescan, which on
				// a 5s heartbeat would restore the very cost #4689 removes.
				if (!(await this.#endpointAuthorityUnchanged(attached)))
					throw new SessionRouterError("pre_send", "SDK session endpoint authority changed before lease renewal.");
				if (!attached || !this.#attachmentPublished(attached))
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				attached.client.send(this.#prepareFrame(attached, { type: "provider_heartbeat", leaseId }));
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
			replayPending: false,
			id: crypto.randomUUID(),
			sessionId: indexed.sessionId,
			endpoint,
			pid: indexed.pid,
			endpointMtimeMs: indexed.endpointMtimeMs,
			endpointIdentity,
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
			notificationFailures: 0,
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
		// Re-check at publication (#4730 review): the endpoint must STILL be the
		// file authority validated. Fail closed on stat error or any identity
		// change instead of publishing an attachment bound to a successor.
		// Every rejection here must roll the connected client back fully (#4730
		// review): the transport is already open at this point, so returning without
		// closing it leaks an unowned connection.
		const rollback = async (): Promise<false> => {
			attached.dispose();
			await client.close().catch(() => undefined);
			return false;
		};
		const publishIdentity = await lstatEndpoint(endpoint.path);
		if (!publishIdentity || !sameEndpointIdentity(endpointIdentity, publishIdentity)) return await rollback();
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
		return await this.#publishAttachment(attached, skipReplay, deferReplay);
	}

	async #publishAttachment(attached: AttachedSession, skipReplay: boolean, deferReplay = false): Promise<boolean> {
		if (attached.published) return this.#attachmentPublished(attached);
		if (!this.#attachmentLive(attached)) return false;
		const proven = await this.#readProvenEndpoint(attached.indexed).catch(() => null);
		if (!this.#attachmentLive(attached)) return false;
		// The commit point compares the PROVEN endpoint identity alongside url/token/pid
		// (#4730 review): an identical-byte rename during the pre-publication
		// hooks matches every other field, so identity is what rejects it. The
		// value compared here is the one the authority read proved, not a later
		// observation, so the proof and its consumer cannot drift apart.
		if (
			!proven ||
			proven.endpoint.url !== attached.endpoint.url ||
			proven.endpoint.token !== attached.endpoint.token ||
			proven.endpoint.pid !== attached.pid ||
			!sameEndpointIdentity(attached.endpointIdentity, proven.identity)
		) {
			await this.#retireAttachment(attached, proven ? "replaced_same_generation" : undefined);
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
		// When the caller drives the serialized reconcile tail (periodic
		// re-attachment after a rehost), initial replay must not hold it: each
		// replay owns its own retry budget, so awaiting it here wedges all later
		// reconciles (and the sends that funnel through them) until the budget
		// expires. The barrier still holds live frames, so ordering and
		// generation fences are unchanged; replay just runs on the attachment's
		// ready tail like the reconnect path (#4527).
		if (deferReplay) {
			const replayToken = {};
			attached.replayPending = true;
			attached.replayPendingSince = Date.now();
			attached.replayPendingToken = replayToken;
			attached.readyTail = attached.readyTail
				.catch(() => undefined)
				.then(async () => {
					if (!this.#attachmentLive(attached)) return;
					await this.#deps.onReplayReady?.();
					if (!this.#attachmentLive(attached)) return;
					if (!(await this.#deliverRecoveredFrames(attached))) return;
					await this.#replayAttachment(attached, attached.cursor.seq);
				})
				.catch(error => {
					attached.barrier.failed = true;
					logger.warn(`SDK deferred replay failed for ${attached.sessionId}: ${String(error)}`);
				})
				.finally(() => {
					if (attached.replayPendingToken === replayToken) {
						attached.replayPending = false;
						attached.replayPendingSince = undefined;
						attached.replayPendingToken = undefined;
					}
				});
			return true;
		}
		await this.#deps.onReplayReady?.();
		if (!(await this.#deliverRecoveredFrames(attached))) return false;
		await this.#replayAttachment(attached, attached.cursor.seq);
		return true;
	}

	async #reinitializeAttachment(attached: AttachedSession): Promise<void> {
		// A prior ready tail may be waiting for publication work carried by the dead
		// socket. Chaining the reconnect behind it prevents the replacement from even
		// issuing replay. Replace its hold-array identity to fence that tail, but carry
		// forward frames it had not started draining; the active draining sequence is
		// already represented by the independent frame tail.
		if (attached.barrier.held) {
			const carried = [...(attached.drainingHeldBatch ?? []), ...attached.barrier.held];
			attached.drainingHeldBatch = undefined;
			attached.barrier.held = carried
				.filter(entry => entry.seq !== attached.drainingHeldSeq)
				.filter((entry, index, entries) => entries.findIndex(candidate => candidate.seq === entry.seq) === index);
		}
		const replayToken = {};
		attached.replayPending = true;
		attached.replayPendingSince = Date.now();
		attached.replayPendingToken = replayToken;
		const current = Promise.resolve().then(async () => {
			if (!this.#attachmentLive(attached)) return;
			const proven = await this.#readProvenEndpoint(attached.indexed);
			if (
				!proven ||
				proven.endpoint.url !== attached.endpoint.url ||
				proven.endpoint.token !== attached.endpoint.token ||
				proven.endpoint.pid !== attached.pid ||
				!sameEndpointIdentity(attached.endpointIdentity, proven.identity)
			) {
				await this.#retireAttachment(attached, proven ? "replaced_same_generation" : undefined);
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
				await this.#deps.onReplayReady?.();
			} catch {
				await this.#retireAttachment(attached);
				return;
			} finally {
				attached.initializingPublication = false;
			}
			if (this.#attachmentLive(attached)) await this.#replayAttachment(attached, attached.cursor.seq);
		});
		attached.readyTail = current.finally(() => {
			if (attached.replayPendingToken === replayToken) {
				attached.replayPending = false;
				attached.replayPendingSince = undefined;
				attached.replayPendingToken = undefined;
			}
		});
		await attached.readyTail;
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

	/**
	 * Idle-gate guard (#4689): local recovery state the durable index cannot
	 * see. A failed/detached replay barrier or an unpublished attachment must
	 * force the next full body instead of waiting for the sweep.
	 */
	#hasUnhealthyAttachment(): boolean {
		for (const attached of this.#sessions.values()) {
			if (
				attached.barrier.failed ||
				attached.barrier.detached ||
				!attached.published ||
				(attached.replayPending &&
					Date.now() - (attached.replayPendingSince ?? Date.now()) >= REPLAY_PENDING_STALL_MS)
			)
				return true;
		}
		return false;
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
		// The dominant cost of a one-shot `gjc sdk` command: notification work that
		// finished in milliseconds left this timeout pending, and a pending Bun.sleep
		// keeps the event loop alive, so the process wrote its response and then idled
		// for the full budget before exiting.
		const cutoff = new AbortController();
		const timeout: Promise<typeof NOTIFICATION_WORK_TIMEOUT> = cancellableSleep(
			NOTIFICATION_WORK_TIMEOUT_MS,
			cutoff.signal,
		).then(() => NOTIFICATION_WORK_TIMEOUT);
		try {
			return await Promise.race([Promise.resolve().then(work), timeout]);
		} finally {
			cutoff.abort();
		}
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
				// A delivered frame ends the consecutive-failure run.
				attached.notificationFailures = 0;
				if (frame.seq !== undefined)
					attached.notificationSubscription.advanceCursor(frame.generation ?? attached.generation, frame.seq);
			},
			(error: unknown) => {
				// Concede only after a bounded consecutive run: a single refused
				// publication drops that frame, it does not end the subscription.
				attached.notificationFailures += 1;
				const detail = error instanceof Error ? error.message : String(error);
				if (attached.notificationFailures >= NOTIFICATION_LOCAL_FAILURE_LIMIT) {
					this.#detachNotification(attached, "cancelled");
					logger.warn(
						`SDK notification subscription ${attached.notificationSubscription.subscriptionId} failed locally ${attached.notificationFailures} times in a row; cancelling: ${detail}`,
					);
					return;
				}
				logger.warn(
					`SDK notification subscription ${attached.notificationSubscription.subscriptionId} refused one frame (${attached.notificationFailures}/${NOTIFICATION_LOCAL_FAILURE_LIMIT}); subscription retained: ${detail}`,
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
		const notificationFrame = coordinateFreeRouterFrame(correlated);
		this.#dispatchNotificationFrame(attached, notificationFrame);
		void Promise.resolve(this.#deps.onFrame?.(attached.capability, notificationFrame)).catch(error =>
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
				const sequenceClaim = readFrameSequenceClaim(frame);
				const ringFrame = frame.type === "event";
				const generationClaim = Object.hasOwn(frame, "generation");
				const outerGeneration = generationClaim ? readGeneration(frame.generation) : undefined;
				const partialCoordinate = ringFrame && sequenceClaim.claimed !== generationClaim;
				if (!sequenceClaim.valid || partialCoordinate || (generationClaim && outerGeneration === undefined)) {
					this.#failBarrier(attached, "protocol error: malformed sequence coordinate");
					return;
				}
				const seq = ringFrame ? sequenceClaim.seq : undefined;
				if (correlated.sessionId !== undefined && correlated.sessionId !== attached.sessionId) return;
				if (outerGeneration !== undefined && outerGeneration !== attached.generation) return;
				const ownsSequence = seq !== undefined && outerGeneration === attached.generation;
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
				const coordinateFree = coordinateFreeRouterFrame(correlated);
				const notificationFrame: SessionRouterFrame =
					publicationId === undefined
						? coordinateFree
						: { ...coordinateFree, generation: outerGeneration, publicationId, seq };
				try {
					this.#dispatchNotificationFrame(attached, notificationFrame);
					await this.#deps.onFrame?.(attached.capability, notificationFrame);
				} catch (error) {
					if (!this.#attachmentLive(attached)) return;
					if (seq === undefined || !ownsSequence) throw error;
					this.#failDelivery(attached, seq, error);
					this.#deps.onFrameSettled?.(attached.capability, notificationFrame);
					return;
				}
				if (!this.#attachmentLive(attached)) return;
				if (seq !== undefined && ownsSequence) {
					this.#undelivered.delete(attached.sessionId);
					this.#removeRecoveredFrame(attached.sessionId, attached.generation, seq);
					if (seq > attached.cursor.seq) attached.cursor.seq = seq;
				}
				if (seq !== undefined && ownsSequence)
					this.#deps.onFrameSettled?.(attached.capability, { ...notificationFrame, seq });
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
			attached.drainingHeldBatch = batch;
			for (;;) {
				const entry = batch.shift();
				if (!entry) break;
				attached.drainingHeldSeq = entry.seq;
				try {
					await this.#enqueueFrame(attached, entry.frame, "ordered");
				} finally {
					if (attached.drainingHeldSeq === entry.seq) attached.drainingHeldSeq = undefined;
				}
				if (attached.barrier.held !== held) return;
			}
			if (attached.drainingHeldBatch === batch) attached.drainingHeldBatch = undefined;
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
				} catch (error) {
					// A host that took the frame and never answered will not answer an
					// identical retry: the socket is up and its loop is not serving.
					// Retrying here multiplies one request budget by the whole ladder
					// INSIDE the attach pass that `start()` awaits, so a single wedged
					// session stalls Router startup past every caller's budget (a real
					// 4-attempt × 10s stall measured against a spinning session host).
					// Fail the barrier on the first such outcome and let the 2s tick
					// re-attach: a failed barrier already forces the full reconcile body
					// (#4689). Pre-dispatch failures stay on the retry ladder.
					if (isUnansweredAfterDispatch(error)) {
						this.#failBarrier(attached, "replay went unanswered by a live transport");
						return;
					}
					if (attempt >= REPLAY_RETRY_ATTEMPTS) {
						this.#failBarrier(attached, "replay went unanswered");
						return;
					}
					// Awaited backoff rather than a raced timeout, but it must still not sleep
					// through a shutdown: cancelling on stop lets the process exit promptly.
					await cancellableSleep(REPLAY_RETRY_BACKOFF_MS * 2 ** attempt, this.#stopController.signal);
					if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
				}
			}
			if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
			await this.#frameTails.get(attached.id)?.catch(() => undefined);
			if (attached.barrier.held !== held || !this.#attachmentLive(attached)) return;
			if (!Array.isArray(replay.events)) {
				this.#failBarrier(attached, "replay response omitted an events array");
				return;
			}
			if (replay.ok !== true || readGeneration(replay.generation) !== attached.generation) {
				this.#failBarrier(attached, "replay response failed or crossed generations");
				return;
			}
			const lastSeq = readNonnegativeSequence(replay.lastSeq);
			if (lastSeq === undefined || lastSeq < sinceSeq) {
				this.#failBarrier(attached, "replay response omitted a coherent high-watermark");
				return;
			}
			const events = replay.events.filter(
				(event): event is Record<string, unknown> => !!event && typeof event === "object" && !Array.isArray(event),
			);
			if (events.length !== replay.events.length) {
				this.#failBarrier(attached, "replay response contained a malformed event");
				return;
			}
			let previousSeq = -1;
			for (const event of events) {
				if (event.type !== "event") {
					this.#failBarrier(attached, "replay response contained a non-event frame");
					return;
				}
				const generation = readGeneration(event.generation);
				const seq = readSequence(event.seq);
				if (generation !== attached.generation || seq === undefined || seq <= previousSeq || seq > lastSeq) {
					this.#failBarrier(attached, "replay response contained invalid or unordered coordinates");
					return;
				}
				previousSeq = seq;
			}
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
				if (gap.toSeq > lastSeq) {
					this.#failBarrier(attached, "replay gap exceeded the reported high-watermark");
					return;
				}
				const retained = events
					.map(event => readSequence(event.seq))
					.find(seq => seq !== undefined && seq >= gap.fromSeq && seq <= gap.toSeq);
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
