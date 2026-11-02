import { createHash, randomUUID } from "node:crypto";
import type { LogLevel } from "@gajae-gateway/log";
import {
	assertControlAllowed,
	assertValidOpRef,
	type BrokerSession,
	CLIENT_REF_CONFLICT_CODE,
	decideRecovery,
	GjcCliError,
	isOpRefRejection,
	isTerminalStatus,
	OpRefRejectedError,
	projectOpState,
	type StatusReport,
} from "@gajae-gateway/subsession";
import {
	DEFAULT_SESSIONS_BUSY_STALL_MS,
	DEFAULT_SESSIONS_IDLE_RETIRE_MS,
	DEFAULT_SESSIONS_MAX_LIVE_HOSTS,
	DEFAULT_SESSIONS_UNRESOLVED_HOLD_MS,
	type GjcModelSelection,
	type GjcServiceTier,
	type SessionHostConfig,
} from "../config";
import { BrokerAuthorityError, type Store } from "../store";
import {
	type InboundMessageRow,
	type InboundTurn,
	type TerminalUnlinkedReason,
	terminalDeliveryIds,
} from "../store/groups/inbox";
import type { WriteTx } from "../store/tx";
import { type BrokerLivenessProbe, type BrokerLivenessVerdict, describeBindHold } from "./broker-liveness";
import type { FailedTurnEvidence } from "./failed-turn-evidence";
import { isSessionGoneCode } from "./gjc-contract";
import { GjcRuntimeError, sanitizeDiagnostic } from "./rebind";
import {
	ModelNotSelectedError,
	type SessionBinding,
	SessionBusyStalledError,
	type SessionContextUsage,
	type SessionPort,
	type TerminateHostOutcome,
} from "./session-port";
import {
	deterministicInterimDeliveryId,
	isRelayTransportFailure,
	TailCapacityError,
	type TailFrame,
	type TailHandle,
} from "./tail-runner";

export const DEFAULT_STALL_TIMEOUT_MS = 120_000;
/** Graceful shutdown gives accepted persona turns time to finish before their relays close. */
const PERSONA_SHUTDOWN_DRAIN_MS = 15_000;
/** Maximum silence after a tail stall before a still-nonterminal operation is cut off. */
export const STALLED_TURN_TERMINAL_TIMEOUT_MS = 10 * 60_000;
/**
 * How many times a turn may replace its session after the Router disowns it.
 * Each attempt binds a NEW session (bootstrapped with the last 24h of channel
 * context), so this is bounded work, not a resend of an accepted operation.
 */
const MAX_SEND_REBIND_ATTEMPTS = 3;
const RETIRED_REATTACH_DELAY_MS = 25;
const RETIRED_REATTACH_MAX_ATTEMPTS = 3;
/**
 * Grace before a decidable-terminal status may complete a turn whose tail has
 * not produced terminal evidence. One bounded hold keeps the tail the live
 * authority; after the grace the evidence is treated as genuinely unavailable
 * (post-crash ring loss) and status — the subsession reconcile authority —
 * completes with an explicit corroboration log.
 */
const STATUS_TERMINAL_GRACE_MS = 250;
/** `turn.result` recheck cadence for a running turn whose end no relay will announce: 250 ms doubling to 5 s. */
const STATUS_RECHECK_MIN_MS = 250;
const STATUS_RECHECK_MAX_MS = 5_000;
const HOST_TERMINATION_RECHECK_MS = 1_000;
/**
 * A transcript row is judged against the turn's dispatch floor with this much
 * slack: the host stamps rows and the gateway stamps dispatched_at on two
 * clocks. Same tolerance as SessionPort.fetchAssistantSince.
 */
/** Tolerated clock skew between the host's startedAt and the gateway's dispatch stamp. */
const TURN_FLOOR_SKEW_MS = 2_000;
const DISPATCH_FAILURE_RETRY_MS = 2_000;
/**
 * A prompt the host rejected in its submission phase never ran (gjc's
 * AgentBusy wait expired, #424). It is re-sent once after this pause, which
 * gives the still-finishing prior run time to go idle.
 */
const SUBMISSION_RETRY_DELAY_MS = 3_000;
/** Torn steer transports are replayed on the same clientRef this many times before the row is held. */
const STEER_REPLAY_ATTEMPTS = 2;
/** Bind failures back off exponentially from DISPATCH_FAILURE_RETRY_MS up to this ceiling. */
const DISPATCH_FAILURE_RETRY_MAX_MS = 60_000;
/** Identical bind failures before the broker's own discovery file is judged. */

function freshTurnMetaKey(originKey: string, epoch: number, triggerMessageId: string): string {
	return `fresh_turn_attempt:${originKey}:${epoch}:${triggerMessageId}`;
}

function providerTransportRetryMetaKey(originKey: string, epoch: number, triggerMessageId: string): string {
	return `provider_transport_retry_attempt:${originKey}:${epoch}:${triggerMessageId}`;
}

function failedTurnKeyPrefix(originKey: string): string {
	return `turn-failed:${originKey}:`;
}

function failedTurnResetCapKey(originKey: string): string {
	return `failed-turn-reset-cap:${createHash("sha256")
		.update(JSON.stringify([originKey]))
		.digest("hex")}`;
}

export function freshTurnAttempt(store: Store, originKey: string, epoch: number, triggerMessageId: string): number {
	const value = Number.parseInt(store.core.metaGet(freshTurnMetaKey(originKey, epoch, triggerMessageId)) ?? "0", 10);
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function providerTransportRetryAttempt(
	store: Store,
	originKey: string,
	epoch: number,
	triggerMessageId: string,
): number {
	const value = Number.parseInt(
		store.core.metaGet(providerTransportRetryMetaKey(originKey, epoch, triggerMessageId)) ?? "0",
		10,
	);
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** An escalated hold (#686) whose late answer is still wanted; restored on adoption after a restart. */
function escalatedHoldKey(opRef: string): string {
	return `escalated-hold:${opRef}`;
}

const ESCALATION_NOTICE_PREFIX = "escalation-notice:";

/**
 * Durable intent to post an escalation notice, deleted once the delivery ledger
 * owns it. Inbox retention keeps the trigger row while this key exists.
 */
function escalationNoticeKey(originKey: string, opRef: string): string {
	return `${ESCALATION_NOTICE_PREFIX}${originKey}#${opRef}`;
}

/** Origins holding an undelivered escalation notice; op-refs never contain `#`, origin keys may. */
function escalationNoticeOrigins(store: Store): string[] {
	return store.core
		.metaKeysInRange(ESCALATION_NOTICE_PREFIX, `${ESCALATION_NOTICE_PREFIX}\uffff`)
		.map((key) => key.slice(ESCALATION_NOTICE_PREFIX.length, key.lastIndexOf("#")));
}

function stalledExitProofKey(opRef: string): string {
	return `stalled-turn-exit:${createHash("sha256")
		.update(JSON.stringify([opRef]))
		.digest("hex")}`;
}

type StalledExitOwner = {
	readonly opRef: string;
	readonly originKey: string;
	readonly sessionId: string;
	readonly epoch: number;
	readonly repo: string;
};

/** The durable turn and current broker must still own the exact original producer. */
function stalledExitOwner(store: Store, owner: StalledExitOwner) {
	const row = store.inbox.turnRow(owner.opRef);
	const authority = store.bindings.authority;
	if (
		!authority ||
		!row ||
		row.state !== "pending" ||
		(row.turn_state !== "accepted" && row.turn_state !== "bound") ||
		row.origin_key !== owner.originKey ||
		row.bound_session_id !== owner.sessionId ||
		row.turn_epoch !== owner.epoch ||
		store.bindings.isQuarantined("inbound", row.message_id)
	)
		return undefined;
	try {
		const binding = store.bindings.assertOwnedSession(owner.sessionId, owner.repo, authority);
		if (binding.originKey !== owner.originKey || binding.epoch !== owner.epoch || binding.repo !== owner.repo)
			return undefined;
		return { ...owner, authority };
	} catch (error) {
		if (error instanceof BrokerAuthorityError) return undefined;
		throw error;
	}
}

function confirmedStalledExit(store: Store, owner: StalledExitOwner): boolean {
	const current = stalledExitOwner(store, owner);
	const raw = store.core.metaGet(stalledExitProofKey(owner.opRef));
	if (!current || raw === undefined) return false;
	try {
		const proof = JSON.parse(raw);
		return (
			proof !== null &&
			proof.version === 1 &&
			(proof.outcome === "terminated" || proof.outcome === "already_gone") &&
			proof.opRef === current.opRef &&
			proof.originKey === current.originKey &&
			proof.sessionId === current.sessionId &&
			proof.epoch === current.epoch &&
			proof.repo === current.repo &&
			proof.authority?.identity === current.authority.identity &&
			proof.authority?.canonicalAgentDir === current.authority.canonicalAgentDir
		);
	} catch {
		return false;
	}
}

function persistStalledExit(
	store: Store,
	owner: ReturnType<typeof stalledExitOwner>,
	outcome: "terminated" | "already_gone",
): boolean {
	if (!owner) return false;
	return store.transaction(() => {
		const current = stalledExitOwner(store, owner);
		if (
			!current ||
			current.authority.identity !== owner.authority.identity ||
			current.authority.canonicalAgentDir !== owner.authority.canonicalAgentDir
		)
			return false;
		const key = stalledExitProofKey(owner.opRef);
		// Never repair or overwrite a foreign/malformed proof into authority.
		if (store.core.metaGet(key) !== undefined) return confirmedStalledExit(store, owner);
		store.core.metaSet(key, JSON.stringify({ ...current, version: 1, outcome }));
		return true;
	});
}

function ownedTurnPrompt(store: Store, opRef: string) {
	const trigger = store.inbox.turnRow(opRef);
	if (!trigger?.bound_session_id || trigger.turn_epoch === null) return undefined;
	const authority = store.bindings.authority;
	const repo = store.bindings.workLaneRepoBySessionId(trigger.bound_session_id);
	if (!authority || !repo) return undefined;
	try {
		const owned = store.bindings.assertOwnedSession(trigger.bound_session_id, repo, authority);
		if (owned.originKey !== trigger.origin_key || owned.epoch !== trigger.turn_epoch) return undefined;
		return { sessionId: owned.sessionId, opRef, originKey: owned.originKey, epoch: owned.epoch, repo: owned.repo };
	} catch (error) {
		if (error instanceof BrokerAuthorityError) return undefined;
		throw error;
	}
}

/** Release refusal evidence only after this captured owner completes durably. */
function completeInboundTurn(
	store: Store,
	tx: WriteTx,
	opRef: string,
	unlinkedReason: TerminalUnlinkedReason = "no_delivery",
): number {
	const prompt = ownedTurnPrompt(store, opRef);
	const consumeExit = prompt !== undefined && confirmedStalledExit(store, prompt);
	const changed = store.inbox.turnComplete(tx, opRef, unlinkedReason);
	if (changed === 1 && prompt) store.bindings.abandonBrokerPromptBusyRefusal(tx, prompt);
	if (changed === 1 && consumeExit) store.core.metaDelete(stalledExitProofKey(opRef));
	if (changed === 1) store.core.metaDelete(escalatedHoldKey(opRef));
	return changed;
}

export function retryInboundTurn(store: Store, tx: WriteTx, opRef: string): number {
	store.core.assertActive(tx);
	const trigger = store.inbox.turnRow(opRef);
	if (!trigger || trigger.turn_epoch === null) throw new Error(`turn ${opRef} has no retryable trigger`);
	if (store.bindings.isQuarantined("inbound", trigger.message_id)) throw new BrokerAuthorityError("quarantined");
	if (!trigger.state || trigger.state !== "pending" || !["bound", "accepted"].includes(trigger.turn_state ?? ""))
		throw new Error(`turn ${opRef} cannot be requeued from its current lifecycle state`);
	const key = freshTurnMetaKey(trigger.origin_key, trigger.turn_epoch, trigger.message_id);
	const prior = Number.parseInt(store.core.metaGet(key) ?? "0", 10);
	const attempt = Number.isSafeInteger(prior) && prior >= 0 ? prior + 1 : 1;
	const prompt = ownedTurnPrompt(store, opRef);
	const consumeExit = prompt !== undefined && confirmedStalledExit(store, prompt);
	store.core.metaSet(key, String(attempt));
	const changed = store.inbox.turnRequeue(tx, opRef);
	if (changed > 0 && prompt) store.bindings.abandonBrokerPromptBusyRefusal(tx, prompt);
	if (changed > 0 && consumeExit) store.core.metaDelete(stalledExitProofKey(opRef));
	return attempt;
}

function retryProviderTransportTurn(store: Store, tx: WriteTx, opRef: string): number {
	store.core.assertActive(tx);
	const trigger = store.inbox.turnRow(opRef);
	if (!trigger || trigger.turn_epoch === null) throw new Error(`turn ${opRef} has no retryable trigger`);
	const retryKey = providerTransportRetryMetaKey(trigger.origin_key, trigger.turn_epoch, trigger.message_id);
	const previous = providerTransportRetryAttempt(store, trigger.origin_key, trigger.turn_epoch, trigger.message_id);
	retryInboundTurn(store, tx, opRef);
	const attempt = previous + 1;
	store.core.metaSet(retryKey, String(attempt));
	return attempt;
}

export function setContextFloor(
	store: Store,
	tx: WriteTx,
	originKey: string,
	floorAt = new Date().toISOString(),
): void {
	store.core.assertActive(tx);
	const prefix = failedTurnKeyPrefix(originKey);
	const end = `${prefix}\uffff`;
	const failedOps = new Set(store.core.metaKeysInRange(prefix, end).map((key) => key.slice(prefix.length)));
	store.inbox.contextSetFloor(tx, originKey, floorAt, failedOps);
	store.core.metaDeleteRange(tx, prefix, end);
}

function clearFailedTurnResetCap(store: Store, tx: WriteTx, originKey: string): void {
	store.core.assertActive(tx);
	store.core.metaSet(failedTurnResetCapKey(originKey), "0");
}

function failedTurnResetCapped(store: Store, originKey: string): boolean {
	const cap = store.core.metaGet(failedTurnResetCapKey(originKey));
	return cap !== undefined && cap !== "0";
}

export function resetFailedTurn(
	store: Store,
	tx: WriteTx,
	input: {
		readonly originKey: string;
		readonly epoch: number;
		readonly sessionId: string;
		readonly opRef: string;
		readonly triggerMessageId: string;
		readonly bypassCap?: boolean;
	},
): number | undefined {
	store.core.assertActive(tx);
	const trigger = store.inbox.turnRow(input.opRef);
	const session = store.bindings.getSessionRecord(input.originKey);
	const dedupeKey = `failed-turn-reset:${createHash("sha256")
		.update(JSON.stringify([input.originKey, input.triggerMessageId]))
		.digest("hex")}`;
	const capKey = failedTurnResetCapKey(input.originKey);
	const cap = store.core.metaGet(capKey);
	if (
		!trigger ||
		trigger.origin_key !== input.originKey ||
		trigger.message_id !== input.triggerMessageId ||
		trigger.turn_epoch !== input.epoch ||
		trigger.bound_session_id !== input.sessionId ||
		trigger.state !== "pending" ||
		trigger.turn_state !== "accepted" ||
		session?.epoch !== input.epoch ||
		session.sessionId !== input.sessionId ||
		store.core.metaGet(dedupeKey) !== undefined ||
		(cap !== undefined && cap !== "0" && !input.bypassCap)
	)
		return undefined;
	if (completeInboundTurn(store, tx, input.opRef, "turn_failed") !== 1)
		throw new Error("failed turn completion lost its fence");
	store.core.metaSet(dedupeKey, "1");
	store.core.metaSet(capKey, "1");
	store.inbox.contextConsume(tx, [input.triggerMessageId]);
	return store.bindings.rotateEpoch(tx, input.originKey);
}
export const BIND_WEDGE_PROBE_STRIKES = 5;
/** A turn held for host capacity re-checks at this cadence even if no host frees in between. */
const HOST_CAPACITY_RETRY_MS = 5_000;
export type HostRetireReason = "host_capacity" | "host_idle";
export type HostAdmission = { readonly admitted: true } | { readonly admitted: false; readonly live: number };
/**
 * Sends between full persona preambles on one session when nothing proved the
 * context lost it. A compaction that both starts and regrows inside one turn
 * leaves no drop in the context percentage sampled before each send; this
 * bounds how long such a session can run without its persona.
 */
export const PERSONA_PREAMBLE_REFRESH_SENDS = 25;
/**
 * Context size at which the persona actor compacts a session itself before the
 * next send. gjc compacts at 300K tokens by default, and a prompt that pushes a
 * session over that line makes gjc compact before accepting it, inside a 30s
 * wait it cannot meet at that size: #회의실 failed eight turns in a row that way
 * (2026-09-30). Compacting here, between turns with the origin's queue held,
 * leaves a whole turn (preamble, message, tool output) of room below gjc's line.
 */
export const PERSONA_COMPACTION_TOKENS = 200_000;

/** What the actor last put into one session's context: the persona preamble and the usage seen since. */
type PersonaPreambleState = {
	readonly signature: string;
	readonly contextPercent: number;
	readonly sendsSince: number;
};

/** A session's context right before a send: its usage when readable, and whether the actor just compacted it. */
type PreparedContext = { readonly usage?: SessionContextUsage; readonly compacted: boolean };
/** Maximum number of retries for retryable agent errors (transient provider failures). */
const MAX_AGENT_ERROR_RETRY_ATTEMPTS = 2;
/** Initial delay before retrying a failed agent error, backs off exponentially. */
const AGENT_ERROR_RETRY_INITIAL_MS = 1_000;
/** Maximum delay before retrying a failed agent error. */
const AGENT_ERROR_RETRY_MAX_MS = 10_000;

export type PersonaActorState = "idle" | "turn-running";

export type PersonaRestartDrainOutcome = "drained" | "timed_out" | "stopped";
export const PERSONA_RESTART_DRAIN_WAIT_MS = 120_000;
export const PERSONA_RESTART_DRAIN_MAX_WAIT_MS = 300_000;

/**
 * Server-owned chat behavior attached to one durable persona turn. The actor
 * owns session/recovery ordering; this lifecycle owns only presentation,
 * bootstrap, context/memory, and delivery side effects.
 */
export interface PersonaTurnLifecycle {
	readonly text: string;
	/**
	 * Stable persona preamble. The actor puts it into a session's context on the
	 * first send, after it changes, after the context shrank (compaction) or a
	 * failed turn, and every PERSONA_PREAMBLE_REFRESH_SENDS sends; other sends
	 * rely on the copy already in the context.
	 */
	readonly systemPreamble?: string;
	/** One-shot trusted context for this send only (the per-epoch session bootstrap). */
	readonly sessionBootstrap?: string;
	/** The selection applied by `model.set` before this session's first send. */
	readonly effectiveModel?: GjcModelSelection;
	/** GJC request tier; `priority` enables provider fast mode where supported. */
	readonly effectiveServiceTier?: GjcServiceTier;
	/** Legacy/send-time fallback only; persistent persona turns leave this unset. */
	readonly sendModelFallback?: GjcModelSelection;
	/**
	 * Message IDs that are included in this turn's unread context.
	 * Used to prevent double-delivery when a message in context is also steered.
	 */
	readonly contextMessageIds?: ReadonlySet<string>;
	/**
	 * Renders a message that arrives while this turn runs into the steer text.
	 * Owns the same speaker/place/reply header as the trigger so the model can
	 * tell who spoke; the actor wraps the result with the steer framing.
	 */
	renderSteer?(row: InboundMessageRow): string;
	/**
	 * The platform message a steer row carries, when the unread context window
	 * must be told it was read (undefined for loopback). Consumed in the SAME
	 * transaction as the steer acceptance, so a crash cannot separate them.
	 */
	steerContextMessageId?(row: InboundMessageRow): string | undefined;
	/** The steer landed in the session (durably, context consumed): release transient ownership. */
	onSteerAccepted?(input: PersonaSteerInput): void | Promise<void>;
	onFrame?(input: PersonaTailFrameInput): boolean | void | Promise<boolean | void>;
	onTerminal?(input: PersonaTerminalInput): void | Promise<void>;
	onFailure?(input: PersonaFailureInput): void | Promise<void>;
	/** Persists one safe notice for an authenticated prompt refusal after its trigger is requeued. */
	onModelRefusal?(input: PersonaFailureInput): void | Promise<void>;
	onSettled?(input: PersonaTurnSettledInput): void | Promise<void>;
	onRetired?(input: PersonaTurnIdentity): void | Promise<void>;
	/**
	 * The turn was dropped WITHOUT a terminal: its send provably never landed
	 * (or its session is provably dead) and the trigger went back to plain
	 * pending for a fresh dispatch. Nothing will ever call onTerminal/onFailure
	 * for this lifecycle; a heartbeat left running here outlives the turn.
	 */
	onReleased?(input: PersonaTurnIdentity): void | Promise<void>;
	onStall?(input: PersonaTurnIdentity & { elapsedMs: number }): void | Promise<void>;
}

export interface PersonaTurnIdentity {
	readonly originKey: string;
	readonly epoch: number;
	readonly sessionId: string;
	readonly turn: InboundTurn;
}

export interface PersonaTurnStartInput extends PersonaTurnIdentity {
	/** The trigger row; the one prompt body of this turn. */
	readonly trigger: InboundMessageRow;
	/**
	 * Present only for a settlement lifecycle of an already sent turn (adopted
	 * after a restart or escalation): the context its prompt durably claimed.
	 * No new context window is prepared or committed for it (#686).
	 */
	readonly sentContextIds?: readonly string[];
}

export interface PersonaTailFrameInput extends PersonaTurnIdentity {
	readonly frame: TailFrame;
}

export interface PersonaSteerInput extends PersonaTurnIdentity {
	readonly row: InboundMessageRow;
}

export interface PersonaTerminalInput extends PersonaTurnIdentity {
	readonly text: string;
	readonly status: StatusReport;
	/**
	 * `text` is this turn's answer but was already posted to the origin (under
	 * another turn's delivery): record it and settle presentation, never post it again.
	 */
	readonly alreadyPosted?: boolean;
}

export interface PersonaFailureInput extends PersonaTurnIdentity {
	readonly error: Error;
	readonly status?: StatusReport;
	/** The gateway must show the cutoff notice even when an earlier interim was delivered. */
	readonly forceFailureNotice?: boolean;
	/**
	 * The answer this turn wrote before it failed, read from the transcript
	 * because no relay showed it (#210). A written reply must not die with the
	 * turn that produced it.
	 */
	readonly recoveredText?: string;
}

export interface PersonaTurnSettledInput extends PersonaTurnIdentity {
	/** JSON terminal-slot claims after the trigger row reached `done`; NULL means no answer. */
	readonly terminalDeliveryId: string | null;
}

export interface PersonaBindHoldInput {
	readonly originKey: string;
	readonly trigger: InboundMessageRow;
	readonly reason: string;
	readonly notice: string;
	readonly verdict: BrokerLivenessVerdict | undefined;
}

/** Bind-hold reason for a turn whose unresolved hold was escalated to a retired hold (#686). */
export const UNRESOLVED_HOLD_ESCALATED = "unresolved_hold_escalated";
const UNRESOLVED_HOLD_NOTICE =
	"[turn held] I could not confirm whether my answer to an earlier message finished, so I will not run it again. Newer messages continue in a fresh session; if that earlier answer still arrives, it will be posted here.";

export const AGENT_RUN_GRACE_MS = 120_000;
export const AGENT_RUN_MAX_MS = 6 * 60 * 60_000;
const AGENT_RUN_NOTICE_DELAY_MS = 3_000;
const AGENT_RUN_NOTICE =
	"[Gateway notice] The runtime started one or more runs on its own (background job / subagent results) since your last reply that reached this conversation. Text you wrote in those runs was NOT delivered, except replies you gave to user messages. If anything the user should see is still undelivered, send it now in full; otherwise reply [SILENT].";

type AgentRunObserver = {
	readonly sessionId: string;
	readonly epoch: number;
	readonly generation: number;
	settledAt: number;
	until: number;
	tail?: TailHandle;
	firstEndAt?: number;
	batchId?: string;
	active?: boolean;
	lost?: boolean;
	noticeTimer?: unknown;
};

export interface PersonaSessionManagerOptions {
	readonly database: Store;
	readonly port: SessionPort;
	readonly instanceId: string;
	readonly repo: string;
	/** GJC agent directory, used to read broker exit information. */
	readonly brokerAgentDir?: string;
	/** Startup model/preset passed to session.create; conversation overrides may replace it later. */
	readonly sessionModel?: GjcModelSelection;
	readonly stallTimeoutMs?: number;
	readonly brokerGeneration?: () => number;
	/** Current broker health; an idle host cannot consume capacity while its broker is unavailable. */
	readonly brokerAvailable?: () => boolean;
	readonly now?: () => number;
	readonly setTimeout?: (work: () => void, delayMs: number) => unknown;
	readonly clearTimeout?: (timer: unknown) => void;
	/** Pause before the single re-send of a turn that failed in its submission phase. */
	readonly submissionRetryDelayMs?: number;
	/** Builds the server delivery/bootstrap lifecycle before an accepted SDK send. */
	readonly onTurnStart?: (input: PersonaTurnStartInput) => PersonaTurnLifecycle | Promise<PersonaTurnLifecycle>;
	/** Removes ephemeral request ownership after /new discarded not-yet-dispatched rows. */
	readonly onInboundDiscard?: (messageIds: readonly string[]) => void | Promise<void>;
	/** Compatibility observer for direct actor tests; product delivery belongs in onTurnStart. */
	readonly onAssistantText?: (input: {
		originKey: string;
		sessionId: string;
		eventId: string;
		deliveryId: string;
		text: string;
	}) => void | Promise<void>;
	readonly onSteerAccepted?: (input: { originKey: string; messageId: string; opRef: string }) => void | Promise<void>;
	/**
	 * Lifecycle-less counterpart of `steerContextMessageId` for a hold resolved
	 * after its turn ended or after a restart.
	 */
	readonly heldSteerContextMessageId?: (row: InboundMessageRow) => string | undefined;
	/**
	 * Lifecycle-less counterpart of `onSteerAccepted`: release transient
	 * ownership of a steer whose outcome was learnt after the turn's lifecycle
	 * was gone. Context is already consumed durably by then. `abandoned` marks a
	 * steer closed because its session is gone (the model may never have seen
	 * it), as opposed to one the runtime recorded as accepted.
	 */
	readonly onHeldSteerAccepted?: (input: {
		originKey: string;
		row: InboundMessageRow;
		opRef: string;
		abandoned?: boolean;
	}) => void | Promise<void>;
	/** Judges the SDK daemon from its discovery file after an identical bind-failure streak. */
	readonly brokerLiveness?: BrokerLivenessProbe;
	/** Emits a cause-bearing hold notice while the inbound trigger remains pending. */
	readonly onBindHold?: (input: PersonaBindHoldInput) => void | Promise<void>;
	/** Records a failed persona bind in the durable SLO journal. */
	readonly onSloEvent?: (code: "persona_bind_failed", at: number) => void;
	/** Readiness observers receive bind outcomes separately from the durable SLO event stream. */
	readonly onBindFailure?: (input: {
		readonly originKey: string;
		readonly detail: string;
		readonly at: number;
	}) => void;
	/** Reports a session failure before an inbound turn is accepted. */
	readonly onSessionCreateFailure?: (input: {
		readonly originKey: string;
		readonly code: string;
		readonly detail: string;
		readonly at: number;
	}) => void;
	/** Reports failures applying model or service-tier settings before a turn is sent. */
	readonly onPreSendFailure?: (input: {
		readonly originKey: string;
		readonly detail: string;
		readonly at: number;
	}) => void;
	/** Reports a session as ready after it accepts an inbound turn. */
	readonly onSessionReady?: (input: { readonly originKey: string; readonly at: number }) => void;
	/** Fires once when a restart drain id first takes the dispatch hold; repeated drain calls for it do not. */
	readonly onRestartDrainStarted?: (restartId: string) => void;
	/** Fires when a restart drain is cancelled and dispatch resumes without this process exiting for it. */
	readonly onRestartDrainCancelled?: (restartId: string) => void;
	/** Fires when a supervisor's dispatch hold is handed to an owner restart. */
	readonly onRestartDrainTransferred?: (restartId: string, nextRestartId: string) => void;
	/** Cap on concurrently live persona session hosts; default DEFAULT_SESSIONS_MAX_LIVE_HOSTS. */
	readonly maxLiveHosts?: number;
	/** Idle persona hosts older than this are ended by sweepIdleHosts; default DEFAULT_SESSIONS_IDLE_RETIRE_MS. */
	readonly hostIdleRetireMs?: number;
	/** Busy host without progress for this long is ended and rebound; default DEFAULT_SESSIONS_BUSY_STALL_MS (#687). */
	readonly busyStallMs?: number;
	/** Unknown-state turn on a dead host holds its origin at most this long; default DEFAULT_SESSIONS_UNRESOLVED_HOLD_MS (#686). */
	readonly unresolvedHoldMs?: number;
	/** Called when a reverse request from the SDK host arrives. */
	readonly onReverseRequest?: (input: {
		originKey: string;
		sessionId: string;
		triggerAuthorId?: string;
		tail: TailHandle;
		input: {
			id: string;
			connectionId: string;
			capability: string;
			leaseId: string;
			payload: { method: string; payload: unknown };
		};
	}) => void | Promise<void>;
	readonly log?: (line: string, level?: LogLevel) => void;
}

/**
 * One durable mailbox per origin. Every inbound admission, tail event, broker
 * generation change, and reset is ordered by one actor whose binding is fenced
 * by origin, epoch, session, and generation.
 */
export class PersonaSessionManager {
	readonly #database: Store;
	readonly #port: SessionPort;
	readonly #instanceId: string;
	readonly #repo: string;
	readonly #brokerAgentDir: string | undefined;
	readonly #sessionModel: GjcModelSelection | undefined;
	#stallTimeoutMs: number;
	readonly #brokerGeneration: () => number;
	readonly #brokerAvailable: (() => boolean) | undefined;
	readonly #now: () => number;
	readonly #setTimeout: (work: () => void, delayMs: number) => unknown;
	readonly #clearTimeout: (timer: unknown) => void;
	readonly #submissionRetryDelayMs: number;
	readonly #onTurnStart: PersonaSessionManagerOptions["onTurnStart"];
	readonly #onInboundDiscard: PersonaSessionManagerOptions["onInboundDiscard"];
	readonly #onAssistantText: PersonaSessionManagerOptions["onAssistantText"];
	readonly #onSteerAccepted: PersonaSessionManagerOptions["onSteerAccepted"];
	readonly #onHeldSteerAccepted: PersonaSessionManagerOptions["onHeldSteerAccepted"];
	readonly #heldSteerContextMessageId: PersonaSessionManagerOptions["heldSteerContextMessageId"];
	readonly #brokerLiveness: BrokerLivenessProbe | undefined;
	readonly #onBindHold: PersonaSessionManagerOptions["onBindHold"];
	readonly #onReverseRequest: PersonaSessionManagerOptions["onReverseRequest"];
	readonly #onSloEvent: PersonaSessionManagerOptions["onSloEvent"];
	readonly #onBindFailure: PersonaSessionManagerOptions["onBindFailure"];
	readonly #onSessionCreateFailure: PersonaSessionManagerOptions["onSessionCreateFailure"];
	readonly #onPreSendFailure: PersonaSessionManagerOptions["onPreSendFailure"];
	readonly #onSessionReady: PersonaSessionManagerOptions["onSessionReady"];
	readonly #onRestartDrainStarted: PersonaSessionManagerOptions["onRestartDrainStarted"];
	readonly #onRestartDrainCancelled: PersonaSessionManagerOptions["onRestartDrainCancelled"];
	readonly #onRestartDrainTransferred: PersonaSessionManagerOptions["onRestartDrainTransferred"];
	readonly #log: (line: string, level?: LogLevel) => void;
	readonly #actors = new Map<string, OriginActor>();
	/** Host slots claimed by bind attempts that have not yet become live actors. */
	readonly #hostAdmissionReservations = new Map<OriginActor, "free" | "replacement">();
	/** At most one reserved admission may concurrently retire an idle host to make room. */
	#hostReplacementAdmissionOwner: OriginActor | undefined;
	#maxLiveHosts: number;
	#hostIdleRetireMs: number;
	#busyStallMs: number;
	#unresolvedHoldMs: number;
	#draining = false;
	#restartDrainId: string | undefined;
	#stopped = false;

	constructor(options: PersonaSessionManagerOptions) {
		this.#database = options.database;
		this.#port = options.port;
		this.#instanceId = options.instanceId;
		this.#repo = options.repo;
		this.#brokerAgentDir = options.brokerAgentDir;
		this.#sessionModel = options.sessionModel;
		this.#stallTimeoutMs = positiveInteger(options.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS, "stallTimeoutMs");
		this.#brokerGeneration = options.brokerGeneration ?? (() => 0);
		this.#brokerAvailable = options.brokerAvailable;
		this.#now = options.now ?? (() => Date.now());
		this.#setTimeout = options.setTimeout ?? ((work: () => void, delayMs: number) => setTimeout(work, delayMs));
		this.#clearTimeout =
			options.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
		this.#submissionRetryDelayMs = options.submissionRetryDelayMs ?? SUBMISSION_RETRY_DELAY_MS;
		this.#onTurnStart = options.onTurnStart;
		this.#onInboundDiscard = options.onInboundDiscard;
		this.#onAssistantText = options.onAssistantText;
		this.#onSteerAccepted = options.onSteerAccepted;
		this.#onHeldSteerAccepted = options.onHeldSteerAccepted;
		this.#heldSteerContextMessageId = options.heldSteerContextMessageId;
		this.#brokerLiveness = options.brokerLiveness;
		this.#onBindHold = options.onBindHold;
		this.#onReverseRequest = options.onReverseRequest;
		this.#maxLiveHosts = positiveInteger(options.maxLiveHosts, DEFAULT_SESSIONS_MAX_LIVE_HOSTS, "maxLiveHosts");
		this.#hostIdleRetireMs = positiveInteger(
			options.hostIdleRetireMs,
			DEFAULT_SESSIONS_IDLE_RETIRE_MS,
			"hostIdleRetireMs",
		);
		this.#busyStallMs = positiveInteger(options.busyStallMs, DEFAULT_SESSIONS_BUSY_STALL_MS, "busyStallMs");
		this.#unresolvedHoldMs = positiveInteger(
			options.unresolvedHoldMs,
			DEFAULT_SESSIONS_UNRESOLVED_HOLD_MS,
			"unresolvedHoldMs",
		);
		this.#log = options.log ?? ((line: string, level?: LogLevel) => console[level ?? "info"](line));
		this.#onSloEvent = options.onSloEvent;
		this.#onBindFailure = options.onBindFailure;
		this.#onSessionCreateFailure = options.onSessionCreateFailure;
		this.#onPreSendFailure = options.onPreSendFailure;
		this.#onSessionReady = options.onSessionReady;
		this.#onRestartDrainStarted = options.onRestartDrainStarted;
		this.#onRestartDrainCancelled = options.onRestartDrainCancelled;
		this.#onRestartDrainTransferred = options.onRestartDrainTransferred;
	}

	#observeRestartDrain(event: string, notify: () => void): void {
		try {
			notify();
		} catch (error) {
			this.#log(`persona restart drain ${event} observer failed: ${safeDiagnostic(error)}`, "error");
		}
	}

	/** Call only after inboundEnqueue's durable acceptance boundary. */
	notifyInbound(originKey: string): Promise<void> {
		if (this.#stopped || this.#draining) return Promise.resolve();
		return this.#actor(originKey).enqueue(async () => await this.#actor(originKey).admit());
	}

	/** Current durable/in-memory admission hold for lane-report decisions. */
	admissionHold(originKey: string): string | undefined {
		return this.#actor(originKey).admissionHold();
	}

	/** Running-server heartbeat for tail-stall detection and bounded status reconciliation. */
	checkStalls(): void {
		if (this.#stopped) return;
		this.#port.checkStalls(this.#now());
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	get draining(): boolean {
		return this.#draining;
	}

	get restartDrainActive(): boolean {
		return this.#restartDrainId !== undefined;
	}

	get restartDrainId(): string | undefined {
		return this.#restartDrainId;
	}

	get onReverseRequest(): PersonaSessionManagerOptions["onReverseRequest"] {
		return this.#onReverseRequest;
	}

	/** Presentation/recovery tick; the port's stall check never sends an abort. */
	tick(originKey?: string): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		this.#port.checkStalls(this.#now());
		const actors = originKey ? [this.#actor(originKey)] : [...this.#actors.values()];
		return Promise.all(actors.map((actor) => actor.enqueue(async () => await actor.tick()))).then(() => undefined);
	}

	setStallTimeoutMs(timeoutMs: number | undefined): void {
		if (this.#stopped) return;
		this.#stallTimeoutMs = positiveInteger(timeoutMs, DEFAULT_STALL_TIMEOUT_MS, "stallTimeoutMs");
		this.#port.setStallTimeoutMs(this.#stallTimeoutMs);
	}

	/** Live-reloaded `sessions` policy; a lowered cap takes effect at the next bind and sweep, never by killing busy hosts. */
	setHostLimits(config: SessionHostConfig | undefined): void {
		if (this.#stopped) return;
		this.#maxLiveHosts = positiveInteger(config?.maxLiveHosts, DEFAULT_SESSIONS_MAX_LIVE_HOSTS, "maxLiveHosts");
		this.#hostIdleRetireMs = positiveInteger(config?.idleRetireMs, DEFAULT_SESSIONS_IDLE_RETIRE_MS, "hostIdleRetireMs");
		this.#busyStallMs = positiveInteger(config?.busyStallMs, DEFAULT_SESSIONS_BUSY_STALL_MS, "busyStallMs");
		this.#unresolvedHoldMs = positiveInteger(
			config?.unresolvedHoldMs,
			DEFAULT_SESSIONS_UNRESOLVED_HOLD_MS,
			"unresolvedHoldMs",
		);
	}

	get busyStallMs(): number {
		return this.#busyStallMs;
	}

	get unresolvedHoldMs(): number {
		return this.#unresolvedHoldMs;
	}

	get maxLiveHosts(): number {
		return this.#maxLiveHosts;
	}

	get hostIdleRetireMs(): number {
		return this.#hostIdleRetireMs;
	}

	/** Origins this gateway counts as holding a live session host; idle IDs do not count while the broker is unavailable. */
	liveHostCount(): number {
		let live = 0;
		for (const actor of this.#actors.values()) if (actor.hostLive) live++;
		return live;
	}

	/**
	 * Admission for an origin about to bind a host. Under the cap it proceeds;
	 * at the cap the least-recently-active idle host is retired first (its
	 * session resumes with history on its next turn); with every host busy the
	 * caller holds its trigger instead of spawning a process the machine
	 * cannot afford.
	 */
	async admitHost(requester: OriginActor): Promise<HostAdmission> {
		const reservation = this.#hostAdmissionReservations.get(requester);
		if (reservation === "free") return { admitted: true };
		const live = [...this.#actors.values()].filter((actor) => actor !== requester && actor.hostLive);
		const otherReservations = this.#hostAdmissionReservations.size - (this.#hostReplacementAdmissionOwner ? 1 : 0);
		if (reservation === undefined && live.length + otherReservations < this.#maxLiveHosts) {
			this.#hostAdmissionReservations.set(requester, "free");
			return { admitted: true };
		}
		if (this.#hostReplacementAdmissionOwner !== undefined && this.#hostReplacementAdmissionOwner !== requester)
			return { admitted: false, live: live.length };
		const idle = live.filter((actor) => actor.hostIdle).sort((a, b) => a.hostLastActiveAt - b.hostLastActiveAt);
		if (reservation === undefined && idle.length > 0) {
			this.#hostAdmissionReservations.set(requester, "replacement");
			this.#hostReplacementAdmissionOwner = requester;
		}
		if (this.#hostReplacementAdmissionOwner !== requester) return { admitted: false, live: live.length };
		for (const candidate of idle) {
			// Retirement runs on the candidate's own mailbox so it cannot race a
			// turn that is being dispatched there at the same moment. The waiter
			// already owns the freed slot, so do not wake a second actor here.
			const retired = await candidate.enqueue(async () => await candidate.retireIdleHost("host_capacity", false));
			if (retired) {
				this.#hostReplacementAdmissionOwner = undefined;
				this.#hostAdmissionReservations.set(requester, "free");
				return { admitted: true };
			}
		}
		this.releaseHostAdmission(requester, false);
		return { admitted: false, live: live.length };
	}

	/** A reserved bind either became a live host or failed before binding. */
	releaseHostAdmission(actor: OriginActor, wakeWaiter = true): void {
		if (!this.#hostAdmissionReservations.delete(actor)) return;
		if (this.#hostReplacementAdmissionOwner === actor) this.#hostReplacementAdmissionOwner = undefined;
		if (wakeWaiter) this.hostFreed();
	}

	/** A host slot opened: wake the longest-waiting capacity hold, if any. */
	hostFreed(): void {
		if (this.#stopped) return;
		let oldest: OriginActor | undefined;
		for (const actor of this.#actors.values()) {
			if (actor.hostHeldSince === undefined) continue;
			if (oldest === undefined || actor.hostHeldSince < (oldest.hostHeldSince ?? Number.POSITIVE_INFINITY))
				oldest = actor;
		}
		if (!oldest || this.#hostAdmissionReservations.has(oldest)) return;
		const reserved = this.#hostAdmissionReservations.size - (this.#hostReplacementAdmissionOwner ? 1 : 0);
		const reservation =
			this.liveHostCount() + reserved < this.#maxLiveHosts
				? "free"
				: this.#hostReplacementAdmissionOwner === undefined
					? "replacement"
					: undefined;
		if (!reservation) return;
		this.#hostAdmissionReservations.set(oldest, reservation);
		if (reservation === "replacement") this.#hostReplacementAdmissionOwner = oldest;
		if (!oldest.releaseHostHold()) this.releaseHostAdmission(oldest, false);
	}

	/** Ends hosts that have sat idle past `hostIdleRetireMs`; returns how many were ended. */
	async sweepIdleHosts(now = this.#now()): Promise<number> {
		if (this.#stopped) return 0;
		for (const actor of this.#actors.values()) await actor.enqueue(async () => await actor.sweepObserver(now));
		const stale = [...this.#actors.values()].filter(
			(actor) => actor.hostIdle && now - actor.hostLastActiveAt >= this.#hostIdleRetireMs,
		);
		let retired = 0;
		for (const actor of stale) {
			if (await actor.enqueue(async () => await actor.retireIdleHost("host_idle"))) retired++;
		}
		return retired;
	}

	/**
	 * `/new` is a mailbox transition: idle work bumps immediately; a running turn
	 * is first accepted, then retired and permanently fenced. The new epoch
	 * returns to idle while the old turn remains a terminal-only hold.
	 */
	reset(originKey: string, originRefJson: string, floorAt = new Date(this.#now()).toISOString()): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		return this.#actor(originKey).enqueue(async () => await this.#actor(originKey).reset(originRefJson, floorAt));
	}

	/**
	 * `/model` is serialized by this same mailbox. Idle binds and controls the
	 * existing epoch immediately; running waits behind its accepted send and never
	 * aborts, retires, or changes that in-flight operation.
	 */
	rebindModel(originKey: string, selection: GjcModelSelection): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		return this.#actor(originKey).enqueue(async () => await this.#actor(originKey).rebindModel(selection));
	}

	/**
	 * Recovers nonterminal turns, pending inputs, terminal turns' unresolved held
	 * steers and undelivered escalation notices after restart. A notice intent is
	 * its own discovery source: its turn may have settled and its binding been
	 * cleared, leaving nothing else that would ever visit the origin.
	 */
	recover(): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		const origins = new Set<string>([
			...escalationNoticeOrigins(this.#database),
			...this.#database.inbox.nonterminalOrigins(),
			...this.#database.inbox.pendingOrigins(),
			...this.#database.inbox.heldSteerOrigins(),
			...this.#database.bindings
				.sessionIdentityRows()
				.filter(
					(row) =>
						row.gjc_session_id &&
						row.origin_ref_json &&
						!row.origin_key.startsWith("work/") &&
						!row.origin_key.startsWith("monitor/"),
				)
				.map((row) => row.origin_key),
		]);
		return Promise.all(
			[...origins].map((originKey) =>
				this.#actor(originKey).enqueue(async () => {
					await this.#actor(originKey).recover();
					await this.#actor(originKey).reconcile();
					await this.#actor(originKey).recoverObserver();
					// Pending rows outside a turn (released before the restart, or
					// arrived while down) are dispatched now; nothing is expired.
					await this.#actor(originKey).admit();
				}),
			),
		).then(() => undefined);
	}

	/** Tail gaps and broker replacements reconcile status; tail is never terminal authority. */
	reconcile(originKey: string): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		return this.#actor(originKey).enqueue(async () => await this.#actor(originKey).reconcile());
	}

	onBrokerGeneration(generation: number): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		return Promise.all(
			[...this.#actors.values()].map((actor) => actor.enqueue(async () => await actor.onBrokerGeneration(generation))),
		).then(() => undefined);
	}

	state(originKey: string): PersonaActorState {
		return this.#actors.get(originKey)?.state ?? "idle";
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		await Promise.all([...this.#actors.values()].map((actor) => actor.stop()));
	}

	/** Block new persona triggers and steers before shutdown starts stopping their producers. */
	beginDrain(): void {
		if (!this.#stopped) this.#draining = true;
	}

	/**
	 * Stop admitting persona work and reconcile accepted turns for a bounded
	 * shutdown window. Unsettled operations stay durable rather than being
	 * aborted or replayed with potentially duplicated side effects.
	 */
	async drain(timeoutMs = PERSONA_SHUTDOWN_DRAIN_MS): Promise<void> {
		if (this.#stopped) return;
		this.beginDrain();
		const deadline = this.#now() + Math.max(0, timeoutMs);
		for (;;) {
			const unresolved = await Promise.all(
				[...this.#actors.values()].map((actor) => actor.enqueue(async () => await actor.drain())),
			);
			if (!unresolved.some(Boolean)) return;
			if (this.#now() >= deadline) {
				await Promise.all(
					[...this.#actors.values()].map((actor) => actor.enqueue(async () => await actor.logShutdownHold())),
				);
				return;
			}
			await Bun.sleep(10);
		}
	}

	/** Pause new dispatches and wait a bounded interval for accepted turns to deliver. */
	async drainForRestart(
		restartId: string,
		waitMs = PERSONA_RESTART_DRAIN_WAIT_MS,
	): Promise<PersonaRestartDrainOutcome> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(restartId)) throw new Error("invalid restart id");
		if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > PERSONA_RESTART_DRAIN_MAX_WAIT_MS)
			throw new Error("restart drain wait must be an integer within the allowed range");
		if (this.#stopped) return "stopped";
		if (this.#restartDrainId !== undefined && this.#restartDrainId !== restartId)
			throw new Error(`restart drain already owned by ${this.#restartDrainId}`);
		const firstEntry = this.#restartDrainId === undefined;
		this.#restartDrainId = restartId;
		const deadline = Date.now() + waitMs;
		this.#log(`persona_restart_drain_started id=${restartId} waitMs=${waitMs}`);
		if (firstEntry) this.#observeRestartDrain("start", () => this.#onRestartDrainStarted?.(restartId));
		for (;;) {
			if (this.#stopped || this.#restartDrainId !== restartId) return "stopped";
			const actors = [...this.#actors.values()];
			const checks = Promise.all(actors.map((actor) => actor.enqueue(async () => actor.hasUnsettledTurns())));
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = Symbol("restart drain timed out");
			let unsettled: (boolean | undefined)[] | typeof timedOut;
			try {
				unsettled = await Promise.race([
					checks,
					new Promise<typeof timedOut>((resolve) => {
						const remainingMs = Math.max(0, deadline - Date.now());
						timer = setTimeout(() => resolve(timedOut), remainingMs);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			if (this.#stopped || this.#restartDrainId !== restartId) return "stopped";
			if (unsettled === timedOut) {
				this.#log(`persona_restart_drain_timed_out id=${restartId} waitMs=${waitMs}`, "warn");
				return "timed_out";
			}
			if (!unsettled.some(Boolean)) {
				this.#log(`persona_restart_drain_ready id=${restartId}`);
				return "drained";
			}
			if (Date.now() >= deadline) {
				this.#log(`persona_restart_drain_timed_out id=${restartId} waitMs=${waitMs}`, "warn");
				return "timed_out";
			}
			await Bun.sleep(10);
		}
	}

	/** Resume pending admissions if the detached restart supervisor fails before restarting the gateway. */
	async cancelRestartDrain(restartId: string): Promise<boolean> {
		if (this.#restartDrainId !== restartId) return false;
		this.#restartDrainId = undefined;
		this.#log(`persona_restart_drain_cancelled id=${restartId}`);
		this.#observeRestartDrain("cancel", () => this.#onRestartDrainCancelled?.(restartId));
		for (const actor of this.#actors.values())
			void actor
				.enqueue(async () => await actor.admit())
				.catch((error: unknown) =>
					this.#log(`persona restart resume failed origin=${actor.originKey}: ${safeDiagnostic(error)}`, "error"),
				);
		return true;
	}

	/** Transfer a failed supervisor's dispatch hold to an accepted owner restart. */
	transferRestartDrain(restartId: string, nextRestartId: string): boolean {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(nextRestartId)) throw new Error("invalid restart id");
		if (this.#restartDrainId !== restartId) return false;
		this.#restartDrainId = nextRestartId;
		this.#log(`persona_restart_drain_transferred from=${restartId} to=${nextRestartId}`);
		this.#observeRestartDrain("transfer", () => this.#onRestartDrainTransferred?.(restartId, nextRestartId));
		return true;
	}

	recordBindFailure(originKey: string, detail: string): void {
		const at = this.#now();
		try {
			this.#onSloEvent?.("persona_bind_failed", at);
		} finally {
			try {
				this.#onBindFailure?.({ originKey, detail, at });
			} catch (error) {
				this.#log(`persona bind readiness observer failed: ${safeDiagnostic(error)}`, "error");
			}
		}
	}

	recordSessionReady(originKey: string): void {
		try {
			this.#onSessionReady?.({ originKey, at: this.#now() });
		} catch (error) {
			this.#log(`persona session-create readiness observer failed: ${safeDiagnostic(error)}`, "error");
		}
	}

	recordSessionCreateFailure(originKey: string, code: string, detail: string): void {
		try {
			this.#onSessionCreateFailure?.({ originKey, code, detail, at: this.#now() });
		} catch (error) {
			this.#log(`persona session-create readiness observer failed: ${safeDiagnostic(error)}`, "error");
		}
	}

	recordPreSendFailure(originKey: string, detail: string): void {
		try {
			this.#onPreSendFailure?.({ originKey, detail, at: this.#now() });
		} catch (error) {
			this.#log(`persona pre-send readiness observer failed: ${safeDiagnostic(error)}`, "error");
		}
	}

	#actor(originKey: string): OriginActor {
		let actor = this.#actors.get(originKey);
		if (!actor) {
			actor = new OriginActor(this, originKey);
			this.#actors.set(originKey, actor);
		}
		return actor;
	}

	get database(): Store {
		return this.#database;
	}

	get port(): SessionPort {
		return this.#port;
	}

	get instanceId(): string {
		return this.#instanceId;
	}

	get repo(): string {
		return this.#repo;
	}

	get stallTimeoutMs(): number {
		return this.#stallTimeoutMs;
	}

	get sessionModel(): GjcModelSelection | undefined {
		return this.#sessionModel;
	}

	get brokerGeneration(): number {
		return this.#brokerGeneration();
	}

	get brokerAvailable(): boolean {
		return this.#brokerAvailable?.() ?? true;
	}

	get brokerAgentDir(): string | undefined {
		return this.#brokerAgentDir;
	}

	now(): number {
		return this.#now();
	}

	get submissionRetryDelayMs(): number {
		return this.#submissionRetryDelayMs;
	}

	schedule(work: () => void, delayMs: number): unknown {
		return this.#setTimeout(work, delayMs);
	}

	cancel(timer: unknown): void {
		this.#clearTimeout(timer);
	}

	async startTurn(input: PersonaTurnStartInput): Promise<PersonaTurnLifecycle> {
		if (this.#onTurnStart) return await this.#onTurnStart(input);
		return { text: input.trigger.body };
	}

	async discardInbound(messageIds: readonly string[]): Promise<void> {
		await this.#onInboundDiscard?.(messageIds);
	}

	async emitAssistant(
		input: Parameters<NonNullable<PersonaSessionManagerOptions["onAssistantText"]>>[0],
	): Promise<void> {
		await this.#onAssistantText?.(input);
	}

	async emitSteer(input: Parameters<NonNullable<PersonaSessionManagerOptions["onSteerAccepted"]>>[0]): Promise<void> {
		await this.#onSteerAccepted?.(input);
	}

	heldSteerContextMessageId(row: InboundMessageRow): string | undefined {
		return this.#heldSteerContextMessageId?.(row);
	}

	async emitHeldSteerAccepted(
		input: Parameters<NonNullable<PersonaSessionManagerOptions["onHeldSteerAccepted"]>>[0],
	): Promise<void> {
		await this.#onHeldSteerAccepted?.(input);
	}

	/** False when the notice hook failed; a durable notice intent is then retried. */
	async emitBindHold(input: PersonaBindHoldInput): Promise<boolean> {
		try {
			await this.#onBindHold?.(input);
			return true;
		} catch (error) {
			this.#log(`persona_bind_hold_notice_failed origin=${input.originKey} detail=${safeDiagnostic(error)}`, "error");
			return false;
		}
	}

	get brokerLiveness(): BrokerLivenessProbe | undefined {
		return this.#brokerLiveness;
	}

	log(line: string, level: LogLevel = "info"): void {
		this.#log(line, level);
	}
}

type BoundTurn = PersonaTurnIdentity & {
	brokerGeneration: number;
	tail?: TailHandle;
	lifecycle: PersonaTurnLifecycle;
	retired: boolean;
	detached: boolean;
	/** The owned relay delivered this turn's agent_end/agent_failed. */
	tailTerminalObserved: boolean;
	/** A consumer-visible reply closed this turn's steer window, even if terminal settlement is still arriving. */
	replyVisible: boolean;
	/**
	 * A retired turn whose answer the user still wants: the session was replaced
	 * under it (steer failure), not reset by the user (`/new`). Its output is
	 * delivered and its terminal completes the turn like a current one.
	 */
	answerWanted: boolean;
	/**
	 * The relay that owned this turn is gone (died mid-turn, or the turn was
	 * adopted after a restart): its content will never arrive on a stream, so
	 * terminal settlement reads status and the original result instead of
	 * waiting on tail evidence.
	 */
	tailEvidenceUnavailable: boolean;
	/** Reconcile passes that saw decidable-terminal status while tail terminal evidence was still absent. */
	statusTerminalHolds: number;
	/** Status rechecks scheduled for a turn whose end no relay will announce (backoff ordinal). */
	statusRechecks: number;
	/** A live tail stalled; keep reconciling status until it emits another frame or reaches terminal state. */
	statusRecheckAfterStall: boolean;
	/** First live-tail stall timestamp; only a nonterminal operation can expire against this deadline. */
	stallStartedAtMs?: number;
	/** Tail activity version captured when the current stall began. */
	stallActivityVersion?: number;
	/** A refused/unavailable host termination has already been logged for this stall. */
	stallTerminationWarningLogged?: boolean;
	/** The host was stopped by the terminal-event cutoff; retry durable failure closure if needed. */
	stallHostTerminated?: boolean;
	/** SIGTERM was accepted, but the host process has not yet been confirmed exited. */
	stallHostTerminating?: boolean;
	/** Original authority captured before signalling; never refreshed into a new broker's proof. */
	stallExitOwner?: NonNullable<ReturnType<typeof stalledExitOwner>>;
	/** A stalled retired hold already attempted its one allowed host termination. */
	retiredHostTerminationAttempted?: boolean;
	/** Repeated output discarded from a retired turn is summarized once per discard interval. */
	staleOutput?: { count: number; firstAt: number; lastAt: number };
	/** Last assistant message the owned relay delivered for THIS turn (correlation-fenced by the handle). */
	lastAssistantText?: string;
	/** A tool ran during this turn; replaying its trigger could repeat external side effects. */
	hadToolActivity: boolean;
	/** A permission request may already have displayed an approval panel for this turn. */
	permissionRequestObserved: boolean;
	/** A tool the tail saw start and not end: the prime suspect when the turn then fails (#210). */
	openTool?: { readonly name: string; readonly startedAtMs: number };
	/** `dispatched_at` of the turn: stamped at bind, before the send. Absent only for a corrupt row. */
	dispatchedAtMs?: number;
	/** Number of provider-transport retries already used for this trigger, independent of other requeues. */
	providerRetryAttempt: number;
	/** A bounded provider retry is already scheduled for this failed turn. */
	agentErrorRetryScheduled: boolean;
};

class OriginActor {
	readonly #manager: PersonaSessionManager;
	readonly originKey: string;
	#queue: Promise<void> = Promise.resolve();
	#state: PersonaActorState = "idle";
	#current: BoundTurn | undefined;
	/** A rejected steer closes this turn's steer window, not its session. */
	#deferredSteerOpRef: string | undefined;
	/** A dispatch retry timer is armed; admissions wait for it instead of re-binding at once. */
	#dispatchRetry: unknown;
	readonly #retired = new Map<string, BoundTurn>();
	#observer: AgentRunObserver | undefined;
	readonly #retiredReattachTimers = new Map<string, unknown>();
	/** Updated before the frame's actor-mailbox callback so cutoff guards see concurrent activity. */
	readonly #tailActivityVersions = new WeakMap<TailHandle, { version: number }>();
	readonly #graceTimers = new Set<unknown>();
	readonly #appliedModel = new Map<string, string>();
	readonly #appliedServiceTier = new Map<string, GjcServiceTier>();
	/** Consecutive submission-phase failures for each session still bound to this origin. */
	readonly #submissionFailures = new Map<string, number>();
	/** Prevents repeating the capped-reset warning for the same bound session. */
	readonly #loggedCappedFailedTurnSessions = new Set<string>();
	readonly #personaPreamble = new Map<string, PersonaPreambleState>();
	#stopped = false;
	readonly #deliveredEvents = new Set<string>();
	#recoveryScanned = false;
	/** The session whose host this origin counts as holding; cleared when that host is ended. */
	#hostSessionId: string | undefined;
	/** A signalled host remains counted but cannot be reused until its process exits. */
	#hostTerminatingSessionId: string | undefined;
	#hostLastActiveAt = 0;
	/** Set while the oldest pending trigger waits for a host slot. */
	#hostHeldSince: number | undefined;
	/** A proven refusal waits for an explicit model change or /new; process restart clears it. */
	#modelRefusalPaused = false;

	constructor(manager: PersonaSessionManager, originKey: string) {
		this.#manager = manager;
		this.originKey = originKey;
	}

	/** Active turns count; idle session IDs count only while the broker can manage them. */
	get hostLive(): boolean {
		return (
			(this.#current !== undefined && !this.#current.stallHostTerminated) ||
			this.#retired.size > 0 ||
			this.#hostTerminatingSessionId !== undefined ||
			(this.#manager.brokerAvailable && this.#hostSessionId !== undefined)
		);
	}

	/** An available idle host with no turn in flight, nothing retired, and nothing about to dispatch. */
	get hostIdle(): boolean {
		return (
			this.#manager.brokerAvailable &&
			this.#hostSessionId !== undefined &&
			this.#hostTerminatingSessionId === undefined &&
			this.#state === "idle" &&
			this.#current === undefined &&
			this.#retired.size === 0 &&
			!this.#observer?.active &&
			this.#observer?.firstEndAt === undefined &&
			!this.#stopped
		);
	}

	get hostLastActiveAt(): number {
		return this.#hostLastActiveAt;
	}

	get hostHeldSince(): number | undefined {
		return this.#hostHeldSince;
	}

	#touchHost(sessionId?: string): void {
		if (sessionId !== undefined) this.#hostSessionId = sessionId;
		this.#hostLastActiveAt = this.#manager.now();
		if (this.hostLive) this.#manager.releaseHostAdmission(this);
	}

	/**
	 * Ends this origin's idle host process. The durable binding is kept: the
	 * next dispatch finds the session saved-but-dead and takes #ensureSession's
	 * `session.resume` branch, so conversation history survives. A host with
	 * background jobs is left alone; ending it would lose them.
	 */
	async retireIdleHost(reason: HostRetireReason, wakeWaiter = true): Promise<boolean> {
		if (!this.hostIdle || this.#manager.stopped) return false;
		const sessionId = this.#hostSessionId;
		if (sessionId === undefined) return false;
		if (this.#manager.database.inbox.pendingOldest(this.originKey)) return false;
		const port = this.#manager.port;
		if (!port.terminateHost) return false;
		if (port.runningJobs) {
			try {
				const running = await port.runningJobs({ sessionId, repo: this.#manager.repo });
				if (running.length > 0) {
					this.#manager.log(
						`persona_host_retire_skipped origin=${this.originKey} session=${sessionId} reason=${reason} jobs=${running.length}`,
					);
					return false;
				}
			} catch {
				// An unanswerable host is not proof of work in progress; terminateHost re-proves liveness itself.
			}
		}
		let result: TerminateHostOutcome;
		try {
			result = await port.terminateHost({ sessionId, repo: this.#manager.repo });
		} catch (error) {
			this.#manager.log(
				`persona_host_retired origin=${this.originKey} session=${sessionId} reason=${reason} outcome=error detail=${safeDiagnostic(error)}`,
				"error",
			);
			return false;
		}
		const ended = result.outcome === "terminated" || result.outcome === "already_gone";
		this.#manager.log(
			`persona_host_retired origin=${this.originKey} session=${sessionId} reason=${reason} outcome=${result.outcome}${
				"pid" in result ? ` pid=${result.pid}` : ""
			}${result.outcome === "refused" ? ` detail=${result.reason}` : ""}`,
			ended ? "info" : "warn",
		);
		if (!ended) {
			if (result.outcome === "terminating") {
				this.#hostTerminatingSessionId = sessionId;
				this.#manager.log(
					`persona_host_terminating origin=${this.originKey} session=${sessionId} reason=${reason} pid=${result.pid}`,
					"warn",
				);
				this.#scheduleHostTerminationRecheck(sessionId);
			}
			return false;
		}
		await this.#closeObserver("host_terminated");
		this.#hostSessionId = undefined;
		if (wakeWaiter) this.#manager.hostFreed();
		return true;
	}

	/** A slot opened while this origin's trigger was held: dispatch now instead of at the next retry tick. */
	releaseHostHold(): boolean {
		if (this.#hostHeldSince === undefined || this.#stopped || this.#manager.stopped) return false;
		this.#hostHeldSince = undefined;
		if (this.#dispatchRetry) {
			this.#manager.cancel(this.#dispatchRetry);
			this.#graceTimers.delete(this.#dispatchRetry);
			this.#dispatchRetry = undefined;
		}
		void this.enqueue(async () => await this.#dispatchNext()).catch(() => {});
		return true;
	}

	async #holdForHostCapacity(trigger: InboundMessageRow, epoch: number, live: number): Promise<void> {
		const max = this.#manager.maxLiveHosts;
		this.#manager.log(
			`persona_bind_hold origin=${this.originKey} epoch=${epoch} message=${trigger.message_id} reason=host_capacity live=${live} max=${max}`,
			"warn",
		);
		this.#hostHeldSince ??= this.#manager.now();
		if (this.#lastBindHoldReason !== "host_capacity") {
			this.#lastBindHoldReason = "host_capacity";
			await this.#manager.emitBindHold({
				originKey: this.originKey,
				trigger,
				reason: "host_capacity",
				notice: `[turn held] session hosts at capacity (${live}/${max} busy). Starting as soon as one frees.`,
				verdict: undefined,
			});
		}
		this.#scheduleDispatchRetry(HOST_CAPACITY_RETRY_MS);
	}

	admissionHold(): string | undefined {
		if (this.#bindWedged) return "broker_wedged";
		if (this.#lastBindHoldReason) return this.#lastBindHoldReason;
		if (this.#manager.database.inbox.hasQuarantinedNonterminalTurn(this.originKey)) return "quarantined_turn";
		return undefined;
	}

	get state(): PersonaActorState {
		return this.#state;
	}

	hasUnsettledTurns(): boolean {
		return this.#state !== "idle" || this.#current !== undefined || this.#retired.size > 0;
	}

	enqueue<T>(work: () => Promise<T>): Promise<T | undefined> {
		if (this.#stopped || this.#manager.stopped) return Promise.resolve(undefined);
		const task = this.#queue.then(() => {
			if (this.#stopped || this.#manager.stopped) return undefined;
			return work();
		});
		this.#queue = task.then(
			() => undefined,
			(error) => {
				this.#manager.log(`persona actor ${this.originKey} failed: ${safeDiagnostic(error)}`, "error");
			},
		);
		return task;
	}

	/**
	 * The canonical rule: a running turn takes the message as a steer; an idle
	 * origin sends it as the next turn. No window, no coalescing.
	 */
	async admit(): Promise<void> {
		if (this.#manager.draining || this.#manager.restartDrainActive) return;
		if (!this.#recoveryScanned) await this.recover();
		if (this.#state === "turn-running") {
			await this.#steerPending();
			return;
		}
		await this.#dispatchNext();
	}

	async tick(): Promise<void> {
		// A steer held on a turn that has already ended is only ever resolved
		// by a clientRef replay; the periodic tick is that retry when nothing
		// else is admitted.
		await this.#resolveStaleHolds();
		if (this.#current) await this.#reconcileBound(this.#current);
		for (const retired of [...this.#retired.values()]) await this.#reconcileBound(retired);
	}

	async reset(originRefJson: string, floorAt: string): Promise<void> {
		await this.#closeObserver("reset");
		const previous = this.#current;
		// The binding being rotated away from. Read before bumpEpoch clears it: if
		// no turn is in flight nothing will ever reconcile this session, so its host
		// would live on idle forever unless ended here.
		const previousSessionId =
			previous?.sessionId ?? this.#manager.database.bindings.getSessionRecord(this.originKey)?.sessionId;
		let nextEpoch = 0;
		let discarded: string[] = [];
		this.#manager.database.transaction((tx) => {
			nextEpoch = this.#manager.database.bindings.rotateEpoch(tx, this.originKey, originRefJson);
			setContextFloor(this.#manager.database, tx, this.originKey, floorAt);
			discarded = this.#manager.database.inbox.discardBefore(tx, this.originKey, floorAt);
			clearFailedTurnResetCap(this.#manager.database, tx, this.originKey);
		});
		this.#modelRefusalPaused = false;
		await this.#manager.discardInbound(discarded);
		if (previous) {
			previous.retired = true;
			this.#clearStallReconciliation(previous);
			previous.tail?.setTurnRunning(false);
			await previous.tail?.close();
			previous.detached = true;
			this.#retired.set(retiredKey(previous), previous);
			this.#current = undefined;
			await previous.lifecycle.onRetired?.(previous);
			this.#manager.log(
				`retired_hold originKey=${this.originKey} epoch=${previous.epoch} opRef=${previous.turn.opRef} reason=/new`,
				"warn",
			);
			this.#scheduleRetiredReattach(previous);
		}
		for (const turn of this.#manager.database.inbox.nonterminalTurns(this.originKey)) {
			if (turn.epoch < nextEpoch && !this.#retired.has(`${turn.epoch}:${turn.opRef}`)) {
				this.#manager.log(
					`retired_hold originKey=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=/new`,
					"warn",
				);
			}
		}
		this.#state = "idle";
		this.#manager.log(`persona_new origin=${this.originKey} epoch=${nextEpoch} discarded_pending=${discarded.length}`);
		// With a retired turn still pending, its reconcile ends the host once the
		// answer is settled; #terminateRetiredSession sees it in #retired and waits.
		// With nothing in flight, this is the only place that will ever do it.
		if (previousSessionId) await this.#terminateRetiredSession(previousSessionId, "reset");
		await this.#dispatchNext();
	}

	/** Mailbox-serialized live rebind. The caller supplies a verified concrete selection. */
	async rebindModel(selection: GjcModelSelection): Promise<void> {
		const binding = await this.#ensureSession(this.#epoch());
		this.#touchHost(binding.sessionId);
		const receipt = await this.#manager.port.setModel({
			sessionId: binding.sessionId,
			repo: this.#manager.repo,
			selection,
		});
		this.#appliedModel.set(binding.sessionId, describeModel(selection));
		this.#manager.log(
			`persona_model origin=${this.originKey} epoch=${binding.epoch} session=${binding.sessionId} effective=${describeModel(selection)} changed=${receipt.changed} source=/model`,
		);
		if (this.#modelRefusalPaused) {
			this.#modelRefusalPaused = false;
			await this.#dispatchNext();
		}
	}

	async reconcile(): Promise<void> {
		if (this.#current) await this.#reconcileBound(this.#current);
		for (const retired of [...this.#retired.values()]) await this.#reconcileBound(retired);
	}

	async recover(): Promise<void> {
		this.#recoveryScanned = true;
		await this.#emitEscalationNotices();
		const turns = this.#manager.database.inbox.nonterminalTurns(this.originKey);
		const open = new Set(turns.map((turn) => turn.opRef));
		for (const opRef of this.#recoveryHoldReasons.keys()) if (!open.has(opRef)) this.#recoveryHoldReasons.delete(opRef);
		for (const turn of turns) {
			if (this.#current?.turn.opRef === turn.opRef || this.#retired.has(retiredKey({ epoch: turn.epoch, turn })))
				continue;
			try {
				await this.#recoverTurn(turn);
			} catch (error) {
				// A lost ACK or unavailable tail does not prove non-admission.
				// Leave the durable operation/session/epoch intact for later recovery.
				// One unrecoverable turn must not abort recovery of the others.
				this.#manager.log(
					`recovery_turn_failed origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} detail=${safeDiagnostic(error)}`,
					"error",
				);
			}
		}
		if (!this.#current) await this.#dispatchNext();
	}

	#quarantinedTurn(opRef: string): boolean {
		const row = this.#manager.database.inbox.turnRow(opRef);
		if (!row || !this.#manager.database.bindings.isQuarantined("inbound", row.message_id)) return false;
		this.#manager.log(
			`recovery_hold origin=${this.originKey} opRef=${opRef} reason=broker_authority_quarantined`,
			"warn",
		);
		return true;
	}

	/**
	 * Why a bound trigger provably never reached the host (#685): no durable send
	 * intent was stamped before `port.send`, or the port holds an authenticated
	 * `busy` refusal for its op-ref. Undefined means the prompt may have landed.
	 */
	#unadmittedReason(opRef: string, sessionId: string | null): "send_not_attempted" | "prompt_busy_refused" | undefined {
		if (!this.#manager.database.inbox.sendAttempted(opRef)) return "send_not_attempted";
		if (!sessionId || !this.#manager.port.promptRefusal) return undefined;
		try {
			return this.#manager.port.promptRefusal({ sessionId, repo: this.#manager.repo, opRef }) === "busy"
				? "prompt_busy_refused"
				: undefined;
		} catch (error) {
			if (error instanceof BrokerAuthorityError) throw error;
			// No refusal evidence is readable: the turn keeps the conservative hold.
			this.#manager.log(
				`send_unadmitted_probe_failed origin=${this.originKey} session=${sessionId} opRef=${opRef} detail=${safeDiagnostic(error)}`,
				"warn",
			);
			return undefined;
		}
	}

	/**
	 * Returns a bound trigger that was provably never admitted to pending so it is
	 * answered by a fresh op-ref. A retired epoch's trigger is closed instead: the
	 * origin was reset after it, so it must not resurface in the new conversation.
	 * A turn whose prompt may have landed is left for reconcile; it is never resent.
	 */
	#releaseUnadmittedTurn(turn: InboundTurn, retired: boolean, source: "recovery" | "dispatch"): boolean {
		const reason = this.#unadmittedReason(turn.opRef, turn.sessionId);
		if (!reason) return false;
		const attempt = this.#manager.database.transaction((tx) => {
			if (!retired) return retryInboundTurn(this.#manager.database, tx, turn.opRef);
			completeInboundTurn(this.#manager.database, tx, turn.opRef, "retired");
			return undefined;
		});
		this.#manager.log(
			`recovery_requeue_unsent origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=${reason} source=${source} action=${retired ? "close_retired" : `requeue attempt=${attempt}`}`,
			"warn",
		);
		return true;
	}

	/**
	 * Bounds how long one unresolved turn may silence its origin (#686). Once its
	 * operation state has stayed unknown past `unresolvedHoldMs` since the send
	 * and its host is provably not live, the turn moves to a retired hold - the
	 * same hold `/new` leaves behind: it keeps reconciling, a late result is still
	 * delivered, and the op is never resent - the epoch rotates so pending
	 * messages continue on a fresh session, and the origin gets one notice.
	 * Pending messages are kept; nothing is discarded.
	 *
	 * A turn whose epoch was already retired (a restart or `/new` moved the origin
	 * on while it was unresolved) is bounded the same way (#705): it gets the same
	 * input fence, retired hold and one notice, without rotating an epoch the
	 * origin has already left. The escalation marker makes it exactly once.
	 */
	async #escalateUnresolvedHold(turn: InboundTurn, bound: BoundTurn | undefined): Promise<boolean> {
		if (this.#stopped || this.#manager.stopped || bound?.retired) return false;
		if (bound && this.#current !== bound) return false;
		const retiredEpoch = turn.epoch !== this.#epoch();
		// A live BoundTurn is always on the current epoch; only a recovered row can be retired.
		if (retiredEpoch && bound) return false;
		const database = this.#manager.database;
		if (database.core.metaGet(escalatedHoldKey(turn.opRef)) !== undefined) return false;
		// The hold starts at the send. A row stamped by the schema 39 backfill
		// ('pre-migration-39') or bound before dispatch was recorded falls back to
		// its bind and then its arrival, so an old stranded row is still bounded (#705).
		const sinceMs = [
			database.inbox.sendAttemptedAt(turn.opRef),
			database.inbox.turnDispatchedAt(turn.opRef),
			database.inbox.turnRow(turn.opRef)?.received_at,
		]
			// Only an ISO timestamp counts: Date.parse reads the marker as the year 2039.
			.map((at) => (typeof at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(at) ? Date.parse(at) : Number.NaN))
			.find((ms) => Number.isFinite(ms));
		if (sinceMs === undefined) return false;
		const heldMs = this.#manager.now() - sinceMs;
		if (heldMs < this.#manager.unresolvedHoldMs) return false;
		const sessionId = bound?.sessionId ?? turn.sessionId;
		if (!sessionId) return false;
		// Only a dead host is evidence the op will not settle by itself; an
		// unanswerable probe is not.
		const host = await this.#bindingState(sessionId);
		if (host.live !== false && host.disowned !== true) return false;
		// A turn recovery never adopted carries no status verdict yet.
		if (!bound && (await this.#statusForRecovery(sessionId, turn.opRef)).status.status !== "unknown") return false;
		const trigger = database.inbox.turnRow(turn.opRef);
		if (!trigger) return false;
		// One transaction: the fresh epoch, the held op's answer-wanted
		// disposition, its replayable notice, and a fence over every input its
		// prompt may have carried (trigger, claimed context, steers) so the fresh
		// session never sees the possibly accepted request as unread. Messages
		// that arrived after the send keep their unread context.
		const { nextEpoch, closedInputs } = database.transaction((tx) => {
			const epoch = retiredEpoch ? this.#epoch() : database.bindings.rotateEpoch(tx, this.originKey);
			database.core.metaSet(escalatedHoldKey(turn.opRef), "1");
			database.core.metaSet(escalationNoticeKey(this.originKey, turn.opRef), "1");
			const claimed = database.inbox.sentContextIds(turn.opRef);
			database.inbox.contextConsume(tx, claimed);
			// A queued message the held prompt already carried is that op's input,
			// never a fresh trigger: resending it could repeat its action.
			const closed = database.inbox.closeClaimedPending(tx, {
				originKey: this.originKey,
				epoch: turn.epoch,
				opRef: turn.opRef,
				messageIds: claimed,
			});
			return { nextEpoch: epoch, closedInputs: closed };
		});
		this.#holdSweeps.delete(turn.opRef);
		this.#recoveryHoldReasons.delete(turn.opRef);
		for (const row of closedInputs) {
			// Whether the model read it is unknown: release its ownership without a 👀.
			await this.#manager.emitHeldSteerAccepted({ originKey: this.originKey, row, opRef: turn.opRef, abandoned: true });
			this.#manager.log(
				`escalation_claimed_input_closed origin=${this.originKey} opRef=${turn.opRef} message=${row.message_id}`,
				"warn",
			);
		}
		this.#manager.log(
			`recovery_hold_escalated origin=${this.originKey} epoch=${turn.epoch} nextEpoch=${nextEpoch} opRef=${turn.opRef} session=${sessionId} heldMs=${heldMs} evidence="status=unknown live=${host.live ?? "unknown"} disowned=${host.disowned ?? false}"`,
			"warn",
		);
		if (bound) {
			bound.retired = true;
			bound.answerWanted = true;
			// The user was told; only the bounded retired-reattach schedule and the
			// periodic sweep read its status from here on (#715).
			bound.tailEvidenceUnavailable = false;
			bound.statusRecheckAfterStall = false;
			this.#clearStallReconciliation(bound);
			bound.tail?.setTurnRunning(false);
			await bound.tail?.close();
			bound.detached = true;
			this.#retired.set(retiredKey(bound), bound);
			this.#current = undefined;
			this.#state = "idle";
			await bound.lifecycle.onRetired?.(bound);
			this.#scheduleRetiredReattach(bound);
		} else {
			try {
				// Adopted without a relay: the host is gone. Periodic reconcile reads
				// its status; a reattach is tried on the bounded retired schedule.
				const adopted = await this.#adoptRecoveredTurn(turn, sessionId, true, true);
				// No bounded-cadence rechecks for an escalated hold: the sweep reads it (#715).
				adopted.tailEvidenceUnavailable = false;
				this.#clearStallReconciliation(adopted);
				adopted.detached = true;
				this.#scheduleRetiredReattach(adopted);
			} catch (error) {
				// Still durable: the next recovery scan treats it as a retired-epoch turn.
				this.#manager.log(
					`retired_hold_adopt_failed origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} detail=${safeDiagnostic(error)}`,
					"warn",
				);
			}
		}
		this.#manager.log(
			`retired_hold originKey=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=unresolved_hold_escalated`,
			"warn",
		);
		await this.#emitEscalationNotices();
		return true;
	}

	/**
	 * Posts every escalation notice whose intent is durable but not yet handed to
	 * the delivery ledger. Delivery ids are deterministic per trigger, so a notice
	 * replayed after a crash or a failed hook is posted once.
	 */
	async #emitEscalationNotices(): Promise<void> {
		const database = this.#manager.database;
		const prefix = escalationNoticeKey(this.originKey, "");
		for (const key of database.core.metaKeysInRange(prefix, `${prefix}\uffff`)) {
			const opRef = key.slice(prefix.length);
			const trigger = database.inbox.turnRow(opRef);
			if (!trigger) {
				// Kept as evidence: without its trigger the notice has no origin to post to.
				this.#manager.log(`escalation_notice_unresolvable origin=${this.originKey} opRef=${opRef}`, "error");
				continue;
			}
			const delivered = await this.#manager.emitBindHold({
				originKey: this.originKey,
				trigger,
				reason: UNRESOLVED_HOLD_ESCALATED,
				notice: UNRESOLVED_HOLD_NOTICE,
				verdict: undefined,
			});
			if (delivered) database.core.metaDelete(key);
		}
	}

	async #recoverTurn(turn: InboundTurn): Promise<void> {
		if (this.#quarantinedTurn(turn.opRef)) return;
		const currentEpoch = this.#epoch();
		const retired = turn.epoch < currentEpoch;
		if (turn.state === "bound" && this.#releaseUnadmittedTurn(turn, retired, "recovery")) return;
		const sessionId = turn.sessionId;
		if (!sessionId) {
			// A turn is bound with its session in one statement; a null session
			// can only be a hand-edited or corrupt row. Hold it for the operator.
			this.#manager.log(
				`recovery_hold origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=${retired ? "retired_session_binding_unavailable" : "session_binding_unavailable"}`,
				"warn",
			);
			return;
		}
		// Confirmed producer exit survives registry loss. Read the original native
		// operation first, without inspect/liveness/resume or opening a new relay.
		if (
			confirmedStalledExit(this.#manager.database, {
				opRef: turn.opRef,
				originKey: this.originKey,
				sessionId,
				epoch: turn.epoch,
				repo: this.#manager.repo,
			})
		) {
			const status = await this.#statusForRecovery(sessionId, turn.opRef);
			const bound = await this.#adoptRecoveredTurn(turn, sessionId, retired, true);
			bound.stallHostTerminated = true;
			await this.#reconcileBound(bound, status);
			return;
		}
		// The table's authority decision is deliberately inspect -> status -> inspect.
		// A broker replacement between either inspect is an authority shift, never a
		// reason to resend an accepted operation.
		const first = await this.#inspectForRecovery(sessionId);
		const status = await this.#statusForRecovery(sessionId, turn.opRef);
		const second = await this.#inspectForRecovery(sessionId);
		// Registry liveness describes broker ownership, not producer-process exit.
		// Unavailable status cannot close or replay an accepted operation.
		const raw = this.#manager.port.liveness
			? await this.#manager.port.liveness({ sessionId, repo: this.#manager.repo })
			: undefined;
		if (turn.state === "bound" && status.status.status === "unknown") {
			if (await this.#escalateUnresolvedHold(turn, undefined)) return;
			this.#logRecoveryHoldOnce(turn, "operation_state_unknown");
			return;
		}
		const authorityShifted =
			first.failed ||
			second.failed ||
			status.operationRef !== turn.opRef ||
			!sameRecoveryAuthority(first.session, second.session);
		const session = second.session;

		// Raw liveness remains independent evidence when inspect did not return
		// a normalizable record; a normalized locator also checks workspace identity.
		const rawLive = raw?.live;
		const knownById = rawLive !== undefined && raw?.disowned !== true;
		const recoveryInput = {
			session: {
				live: session?.live ?? rawLive ?? false,
				deleted: session?.deleted ?? false,
				...(authorityShifted ? { ambiguous: true } : {}),
				savedAuthorityValid:
					(session !== undefined &&
						session.sessionId === sessionId &&
						!session.deleted &&
						session.repo === this.#manager.repo) ||
					(session === undefined && knownById),
				locatorMatches: session?.repo === undefined || session.repo === this.#manager.repo,
				// The instance-scoped op-ref namespace and broker lock leave this actor as
				// the only mutation owner for a persona origin.
				duplicateOwner: false,
			},
			operation: {
				status: status.status.status,
				...(status.status.receiptState ? { receiptState: status.status.receiptState } : {}),
				supervisorState: projectOpState(status.status),
			},
			lane: {
				// Persona side effects are durable ledger deliveries keyed by tail event;
				// replay is idempotent, so completed operation evidence is safe to observe.
				sideEffectsVerified: true,
				// This actor owns one origin key; no independent worktree owner exists.
				ownershipUnchanged: true,
			},
		};
		const decision = decideRecovery(recoveryInput);
		const knownTerminal =
			!authorityShifted &&
			status.operationRef === turn.opRef &&
			(status.status.status === "terminal_ok" || status.status.status === "failed");
		switch (decision.action) {
			case "observe": {
				if (turn.state === "bound")
					this.#manager.database.transaction((tx) => this.#manager.database.inbox.turnAccept(tx, turn.opRef));
				const bound = await this.#adoptRecoveredTurn(turn, sessionId, retired, knownTerminal);
				await this.#reconcileBound(bound);
				if (!bound.retired && this.#current === bound) await this.#steerPending();
				return;
			}
			case "fresh_turn": {
				if (turn.state === "bound")
					this.#manager.database.transaction((tx) => this.#manager.database.inbox.turnAccept(tx, turn.opRef));
				const bound = await this.#adoptRecoveredTurn(turn, sessionId, retired, knownTerminal);
				// Recovered failures use the same exact evidence and reset-next cap.
				// The original trigger is completed, never dispatched again.
				await this.#reconcileBound(bound);
				return;
			}
			case "session_resume": {
				try {
					await this.#manager.port.resume({
						sessionId,
						repo: this.#manager.repo,
						originKey: this.originKey,
						epoch: turn.epoch,
					});
					await this.#recoverTurn(turn);
				} catch (error) {
					const afterResumeFailure = decideRecovery({
						...recoveryInput,
						lane: { ...recoveryInput.lane, resumeImpossible: true },
					});
					if (afterResumeFailure.action === "recreate") await this.#recreateAfterResumeFailure(turn, retired);
					else
						this.#manager.log(
							`recovery_hold origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=session_resume_failed detail=${safeDiagnostic(error)}`,
							"warn",
						);
				}
				return;
			}
			case "recreate":
				await this.#recreateAfterResumeFailure(turn, retired);
				return;
			case "operator_hold": {
				// Unknown status and an empty queue do not authenticate non-admission.
				if (status.status.status === "unknown" && (await this.#escalateUnresolvedHold(turn, undefined))) return;
				this.#logRecoveryHoldOnce(turn, decision.reason);
				return;
			}
		}
	}

	/**
	 * Recovery scans run every minute; an unchanged hold is logged once per
	 * (op-ref, reason) and again only when its reason changes (#705).
	 */
	/** Logs a hold once per reason change; `extra` (e.g. `detail=…`) describes the first occurrence. */
	#logRecoveryHoldOnce(turn: InboundTurn, reason: string, extra?: string): void {
		if (this.#recoveryHoldReasons.get(turn.opRef) === reason) return;
		this.#recoveryHoldReasons.set(turn.opRef, reason);
		this.#manager.log(
			`recovery_hold origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=${reason}${extra ? ` ${extra}` : ""}`,
			"warn",
		);
	}

	async #adoptRecoveredTurn(
		turn: InboundTurn,
		sessionId: string,
		retired: boolean,
		knownTerminal: boolean,
	): Promise<BoundTurn> {
		const trigger = this.#manager.database.inbox.turnRow(turn.opRef);
		if (!trigger) throw new Error(`turn ${turn.opRef} disappeared during recovery`);
		if (this.#quarantinedTurn(turn.opRef)) throw new Error("broker_authority_quarantined");
		const lifecycle = await this.#manager.startTurn({
			originKey: this.originKey,
			epoch: turn.epoch,
			sessionId,
			turn,
			trigger,
			sentContextIds: this.#manager.database.inbox.sentContextIds(turn.opRef),
		});
		let tail: TailHandle | undefined;
		let detached = false;
		try {
			// A recovered turn was submitted by a connection this process no longer
			// holds, so the host will not stream its content here. The relay is
			// opened for commands (status, steer) and for the stall alarm only;
			// terminal settlement reads status and the original result.
			if (!knownTerminal) tail = await this.#attachTail(sessionId, turn.epoch, retired);
		} catch (error) {
			if (!retired || !(error instanceof TailCapacityError)) throw error;
			detached = true;
			this.#manager.log(
				`retired_hold originKey=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=tail_capacity`,
				"warn",
			);
		}
		const dispatchedAtMs = this.#dispatchFloorMs(turn.opRef);
		const providerRetryAttempt = providerTransportRetryAttempt(
			this.#manager.database,
			this.originKey,
			turn.epoch,
			turn.triggerMessageId,
		);
		const bound: BoundTurn = {
			originKey: this.originKey,
			epoch: turn.epoch,
			sessionId,
			brokerGeneration: this.#manager.brokerGeneration,
			turn,
			...(tail ? { tail } : {}),
			lifecycle,
			retired,
			detached,
			tailTerminalObserved: false,
			replyVisible: false,
			hadToolActivity: true,
			permissionRequestObserved: false,
			agentErrorRetryScheduled: false,
			answerWanted: this.#manager.database.core.metaGet(escalatedHoldKey(turn.opRef)) !== undefined,
			tailEvidenceUnavailable: true,
			statusTerminalHolds: 0,
			statusRechecks: 0,
			statusRecheckAfterStall: false,
			stallStartedAtMs: undefined,
			providerRetryAttempt,
			...(dispatchedAtMs === undefined ? {} : { dispatchedAtMs }),
		};
		tail?.beginTurn(turn.opRef);
		tail?.setTurnRunning(true);
		if (retired) {
			this.#retired.set(retiredKey(bound), bound);
			if (detached) this.#scheduleRetiredReattach(bound);
		} else {
			this.#current = bound;
			this.#state = "turn-running";
		}
		return bound;
	}

	async #recreateAfterResumeFailure(turn: InboundTurn, retired: boolean): Promise<void> {
		const reason = retired ? "resume_impossible" : "tail_terminal_evidence_unavailable";
		this.#manager.log(
			`recovery_hold origin=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=${reason}`,
			"warn",
		);
		if (retired)
			this.#manager.log(
				`retired_hold originKey=${this.originKey} epoch=${turn.epoch} opRef=${turn.opRef} reason=resume_impossible`,
				"warn",
			);
	}

	/** A refused steer waits for terminal evidence; it never authorizes replacement. */
	async #recoverFromSteerFailure(current: BoundTurn): Promise<void> {
		if (this.#quarantinedTurn(current.turn.opRef)) return;
		await this.#reconcileBound(current);
	}

	readonly #holdSweeps = new Map<string, number>();
	/** Last logged recovery-scan hold reason per op-ref (#705). */
	readonly #recoveryHoldReasons = new Map<string, string>();

	/** Liveness of a binding from the raw broker envelope; the normalized inspect where the port has no raw read. */
	async #bindingState(sessionId: string): Promise<{
		readonly live: boolean | undefined;
		readonly deleted?: boolean;
		readonly workspace?: string;
		readonly disowned?: boolean;
	}> {
		const port = this.#manager.port;
		if (port.liveness) {
			try {
				return await port.liveness({ sessionId, repo: this.#manager.repo });
			} catch (error) {
				if (error instanceof BrokerAuthorityError) throw error;
				return { live: undefined };
			}
		}
		const { session } = await this.#inspectForRecovery(sessionId);
		return session === undefined
			? { live: undefined }
			: { live: session.live, deleted: session.deleted, workspace: session.repo };
	}

	async #inspectForRecovery(
		sessionId: string,
	): Promise<{ readonly session: BrokerSession | undefined; readonly failed: boolean }> {
		try {
			return { session: await this.#manager.port.inspect({ sessionId, repo: this.#manager.repo }), failed: false };
		} catch {
			return { session: undefined, failed: true };
		}
	}

	async #statusForRecovery(sessionId: string, opRef: string): Promise<StatusReport> {
		try {
			return await this.#manager.port.status({ sessionId, repo: this.#manager.repo, opRef });
		} catch {
			// Endpoint loss is unknown operation state, not producer-exit evidence.
			return {
				operationRef: opRef,
				status: { status: "unknown" },
				summaryCompleted: false,
			};
		}
	}

	async onBrokerGeneration(generation: number): Promise<void> {
		await this.#closeObserver("broker_generation");
		this.#recoveryScanned = false;
		for (const bound of [this.#current, ...this.#retired.values()]) {
			if (!bound || bound.brokerGeneration === generation) continue;
			await bound.tail?.close();
			if (this.#stopped || this.#manager.stopped) return;
			bound.detached = true;
			this.#manager.log(
				`broker_generation_fenced originKey=${this.originKey} epoch=${bound.epoch} oldGeneration=${bound.brokerGeneration} generation=${generation}`,
				"warn",
			);
			await this.#reconcileBound(bound);
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#manager.releaseHostAdmission(this, false);
		// Stop is called outside the mailbox: wait for admitted work, never enqueue
		// a shutdown task that would await its own queue entry.
		await this.#queue;
		await this.#closeObserver("shutdown");
		for (const timer of this.#retiredReattachTimers.values()) this.#manager.cancel(timer);
		this.#retiredReattachTimers.clear();
		for (const timer of this.#graceTimers) this.#manager.cancel(timer);
		this.#graceTimers.clear();
		this.#dispatchRetry = undefined;
		if (this.#current) this.#flushStaleOutput(this.#current, "shutdown");
		for (const retired of this.#retired.values()) this.#flushStaleOutput(retired, "shutdown");
		await Promise.all([
			...(this.#current?.tail ? [this.#current.tail.close()] : []),
			...[...this.#retired.values()].flatMap((bound) => (bound.tail ? [bound.tail.close()] : [])),
		]);
	}

	/** Shutdown reconciliation covers the current turn AND retired holds; both stay durable if unresolved. */
	async drain(): Promise<boolean> {
		if (this.#current) await this.#reconcileBound(this.#current);
		for (const retired of [...this.#retired.values()]) await this.#reconcileBound(retired);
		return this.#current !== undefined || this.#retired.size > 0;
	}

	async logShutdownHold(): Promise<void> {
		if (this.#current)
			this.#manager.log(
				`shutdown_hold origin=${this.originKey} epoch=${this.#current.epoch} opRef=${this.#current.turn.opRef}`,
				"warn",
			);
	}

	/**
	 * Sends the oldest pending row as the next turn, immediately. A dispatch
	 * that cannot even bind a session is retried with exponential backoff
	 * (bounded by DISPATCH_FAILURE_RETRY_MAX_MS, never abandoned); while a retry
	 * is armed, new admissions wait for it instead of hammering the broker. The
	 * row stays pending throughout and is never expired.
	 */
	/**
	 * A bound trigger failed after `bindTurn` but before `port.send` journaled a
	 * `turn.prompt` intent, so no prompt can have landed. Leaving it bound would
	 * fence the origin forever (recovery only proves state for issued prompts), so
	 * it always returns to pending. Positive proof that the session is gone
	 * rotates the epoch and rebinds inline; any other failure (a transient
	 * broker_unavailable, a queue timeout) keeps the session and retries with
	 * backoff, because a generic failure is no authority to replace it.
	 */
	async #requeuePreSend(
		stage: "start_turn" | "attach" | "prepare_context",
		sessionId: string,
		epoch: number,
		opRef: string,
		error: unknown,
	): Promise<void> {
		const sessionGone = await this.#sessionProvablyGone(sessionId, error);
		const { attempt, nextEpoch } = this.#manager.database.transaction((tx) => ({
			attempt: retryInboundTurn(this.#manager.database, tx, opRef),
			nextEpoch: sessionGone ? this.#manager.database.bindings.rotateEpoch(tx, this.originKey) : undefined,
		}));
		if (sessionGone) {
			this.#bindFailures += 1;
			const attempts = this.#bindFailures;
			this.#manager.log(
				`send_session_disowned action=inline_rebind stage=${stage} origin=${this.originKey} epoch=${epoch} nextEpoch=${nextEpoch} opRef=${opRef} session=${sessionId} attempt=${attempts} detail=${safeDiagnostic(error)}`,
				"warn",
			);
			await this.#terminateRetiredSession(sessionId, "session_gone");
			if (attempts < MAX_SEND_REBIND_ATTEMPTS) await this.#dispatchNext();
			else {
				this.#scheduleDispatchRetry(
					Math.min(DISPATCH_FAILURE_RETRY_MAX_MS, DISPATCH_FAILURE_RETRY_MS * 2 ** Math.min(attempts - 1, 10)),
				);
				this.#manager.releaseHostAdmission(this);
			}
			return;
		}
		this.#manager.releaseHostAdmission(this);
		this.#preSendFailures += 1;
		const failures = this.#preSendFailures;
		// The attach caller already degraded session-create readiness.
		if (stage !== "attach") this.#manager.recordPreSendFailure(this.originKey, safeDiagnostic(error));
		this.#manager.log(
			`send_pre_send_requeue stage=${stage} origin=${this.originKey} epoch=${epoch} opRef=${opRef} session=${sessionId} attempt=${attempt} failures=${failures} detail=${safeDiagnostic(error)}`,
			"warn",
		);
		this.#scheduleDispatchRetry(
			Math.min(DISPATCH_FAILURE_RETRY_MAX_MS, DISPATCH_FAILURE_RETRY_MS * 2 ** Math.min(failures - 1, 10)),
		);
	}

	/**
	 * `port.send` failed with positive proof the prompt was never admitted (a
	 * durable `busy` refusal), so the trigger returns to pending under a fresh
	 * op-ref. A busy wait that saw no host progress (#687) first ends the wedged
	 * host; the next dispatch then resumes the stored binding on a new host.
	 */
	async #releaseUnadmittedSend(current: BoundTurn, error: unknown, reason: string): Promise<void> {
		const { opRef } = current.turn;
		const attempt = this.#manager.database.transaction((tx) => retryInboundTurn(this.#manager.database, tx, opRef));
		this.#current = undefined;
		this.#state = "idle";
		try {
			await current.tail?.close();
		} catch (closeError) {
			this.#manager.log(
				`send_pre_send_tail_close_failed origin=${this.originKey} opRef=${opRef} detail=${safeDiagnostic(closeError)}`,
				"warn",
			);
		}
		await this.#notifyReleased(current);
		if (error instanceof SessionBusyStalledError) {
			this.#manager.log(
				`session_busy_stalled origin=${this.originKey} epoch=${current.epoch} session=${current.sessionId} opRef=${opRef} attempt=${attempt} silentMs=${error.silentMs} evidence="${error.evidence}"`,
				"warn",
			);
			if (await this.#endBusyStalledHost(current.sessionId)) {
				await this.#dispatchNext();
				return;
			}
		} else
			this.#manager.log(
				`send_unadmitted_requeue origin=${this.originKey} epoch=${current.epoch} session=${current.sessionId} opRef=${opRef} attempt=${attempt} reason=${reason} detail=${safeDiagnostic(error)}`,
				"warn",
			);
		this.#preSendFailures += 1;
		this.#scheduleDispatchRetry(
			Math.min(DISPATCH_FAILURE_RETRY_MAX_MS, DISPATCH_FAILURE_RETRY_MS * 2 ** Math.min(this.#preSendFailures - 1, 10)),
		);
	}

	/**
	 * Ends a host that refused prompts as busy without progress. No operation of
	 * this origin is admitted on it (the refusal is durable), so there is no
	 * accepted op whose exit must be proven; the stored binding is kept and the
	 * next dispatch takes the `session.resume` branch with history intact.
	 */
	async #endBusyStalledHost(sessionId: string): Promise<boolean> {
		const port = this.#manager.port;
		if (!port.terminateHost) return false;
		let result: TerminateHostOutcome;
		try {
			result = await port.terminateHost({ sessionId, repo: this.#manager.repo });
		} catch (error) {
			if (error instanceof BrokerAuthorityError) throw error;
			this.#manager.log(
				`session_busy_host_terminate_failed origin=${this.originKey} session=${sessionId} detail=${safeDiagnostic(error)}`,
				"error",
			);
			return false;
		}
		const ended = result.outcome === "terminated" || result.outcome === "already_gone";
		this.#manager.log(
			`session_busy_host_terminated origin=${this.originKey} session=${sessionId} outcome=${result.outcome}${
				"pid" in result ? ` pid=${result.pid}` : ""
			}${result.outcome === "refused" ? ` detail=${result.reason}` : ""}`,
			ended ? "warn" : "error",
		);
		if (!ended) {
			if (result.outcome === "terminating") {
				this.#hostTerminatingSessionId = sessionId;
				this.#scheduleHostTerminationRecheck(sessionId);
			}
			return false;
		}
		if (this.#observer?.sessionId === sessionId) await this.#closeObserver("host_terminated");
		if (this.#hostSessionId === sessionId) this.#hostSessionId = undefined;
		this.#manager.hostFreed();
		return true;
	}

	async #dispatchNext(): Promise<void> {
		if (
			this.#manager.draining ||
			this.#manager.restartDrainActive ||
			this.#state !== "idle" ||
			this.#current ||
			this.#dispatchRetry
		)
			return;
		if (this.#modelRefusalPaused) {
			const pending = this.#manager.database.inbox.pendingOldest(this.originKey);
			if (pending) {
				this.#manager.log(
					`persona_dispatch_blocked origin=${this.originKey} message=${pending.message_id} reason=model_not_selected`,
				);
			}
			return;
		}
		const epoch = this.#epoch();
		const unresolved = this.#manager.database.inbox
			.nonterminalTurns(this.originKey)
			.find((turn) => turn.epoch === epoch);
		if (
			unresolved &&
			!(
				unresolved.state === "bound" &&
				!this.#quarantinedTurn(unresolved.opRef) &&
				this.#releaseUnadmittedTurn(unresolved, false, "dispatch")
			)
		) {
			// Recovery may hold without adopting an actor-local current turn. Its
			// durable ownership still fences new admission and session mutation,
			// but only up to the unresolved-hold bound (#686).
			if (await this.#escalateUnresolvedHold(unresolved, undefined)) {
				await this.#dispatchNext();
				return;
			}
			this.#manager.log(
				`recovery_hold origin=${this.originKey} epoch=${epoch} opRef=${unresolved.opRef} reason=nonterminal_turn_owns_epoch`,
				"warn",
			);
			return;
		}
		await this.#resolveStaleHolds();
		const trigger = this.#manager.database.inbox.pendingOldest(this.originKey);
		if (!trigger) return;
		const turnAttempt = freshTurnAttempt(this.#manager.database, this.originKey, epoch, trigger.message_id);
		const providerRetryAttempt = providerTransportRetryAttempt(
			this.#manager.database,
			this.originKey,
			epoch,
			trigger.message_id,
		);
		const opRef = personaTurnOpRef(this.#manager.instanceId, this.originKey, epoch, trigger.message_id, turnAttempt);
		if (this.#hostTerminatingSessionId !== undefined) {
			await this.#holdForHostCapacity(trigger, epoch, this.#manager.liveHostCount());
			return;
		}
		if (!this.hostLive) {
			const admission = await this.#manager.admitHost(this);
			if (!admission.admitted) {
				await this.#holdForHostCapacity(trigger, epoch, admission.live);
				return;
			}
		}
		let binding: SessionBinding;
		// Outside the bind retry: the stored binding's liveness probe throws only
		// on lost broker authority, which fails closed as on the attach-failure probe.
		const stored = await this.#reuseStoredBinding(epoch);
		try {
			binding = stored ?? (await this.#bindSession(epoch));
			this.#clearBindWedgeProbe();
			this.#hostHeldSince = undefined;
			this.#touchHost(binding.sessionId);
		} catch (error) {
			try {
				await this.#noteBindFailure(trigger, epoch, error);
			} finally {
				this.#manager.releaseHostAdmission(this);
			}
			return;
		}
		let bound: InboundMessageRow;
		try {
			bound = this.#manager.database.transaction((tx) =>
				this.#manager.database.inbox.bindTurn(tx, {
					messageId: trigger.message_id,
					originKey: this.originKey,
					epoch,
					opRef,
					sessionId: binding.sessionId,
				}),
			);
		} catch (error) {
			this.#manager.releaseHostAdmission(this);
			throw error;
		}
		const turn: InboundTurn = {
			originKey: this.originKey,
			epoch,
			state: "bound",
			opRef,
			sessionId: binding.sessionId,
			triggerMessageId: trigger.message_id,
		};
		let lifecycle: PersonaTurnLifecycle;
		try {
			lifecycle = await this.#manager.startTurn({
				originKey: this.originKey,
				epoch,
				sessionId: binding.sessionId,
				turn,
				trigger: bound,
			});
		} catch (error) {
			await this.#requeuePreSend("start_turn", binding.sessionId, epoch, opRef, error);
			return;
		}
		let tail: TailHandle;
		try {
			tail = await this.#attachTail(binding.sessionId, epoch, false);
		} catch (error) {
			await this.#releaseLifecycle(lifecycle, {
				originKey: this.originKey,
				epoch,
				sessionId: binding.sessionId,
				turn,
			});
			this.#manager.recordSessionCreateFailure(this.originKey, "session_attach_failed", safeDiagnostic(error));
			await this.#requeuePreSend("attach", binding.sessionId, epoch, opRef, error);
			return;
		}
		// Before the turn starts: the stall clock is not running yet and the
		// actor queue holds every steer and later send until the context is ready.
		let context: PreparedContext;
		try {
			context = await this.#prepareContext(binding.sessionId, epoch, opRef, tail);
		} catch (error) {
			try {
				await tail.close();
			} catch (closeError) {
				this.#manager.log(
					`send_pre_send_tail_close_failed origin=${this.originKey} opRef=${opRef} detail=${safeDiagnostic(closeError)}`,
					"warn",
				);
			}
			await this.#releaseLifecycle(lifecycle, {
				originKey: this.originKey,
				epoch,
				sessionId: binding.sessionId,
				turn,
			});
			await this.#requeuePreSend("prepare_context", binding.sessionId, epoch, opRef, error);
			return;
		}
		const dispatchedAtMs = this.#dispatchFloorMs(opRef);
		const current: BoundTurn = {
			originKey: this.originKey,
			epoch,
			sessionId: binding.sessionId,
			brokerGeneration: this.#manager.brokerGeneration,
			turn,
			tail,
			lifecycle,
			retired: false,
			detached: false,
			tailTerminalObserved: false,
			replyVisible: false,
			hadToolActivity: false,
			permissionRequestObserved: false,
			answerWanted: false,
			tailEvidenceUnavailable: false,
			statusTerminalHolds: 0,
			statusRechecks: 0,
			statusRecheckAfterStall: false,
			stallStartedAtMs: undefined,
			providerRetryAttempt,
			agentErrorRetryScheduled: false,
			...(dispatchedAtMs === undefined ? {} : { dispatchedAtMs }),
		};
		tail.beginTurn(opRef);
		this.#current = current;
		this.#state = "turn-running";
		this.#manager.releaseHostAdmission(this);
		tail.setTurnRunning(true);
		// Session state, rather than a per-send selector, is authoritative for
		// persona turns. Model selection happens BEFORE send; if it fails, no
		// prompt can have landed, so holding the BOUND row as an ambiguous send
		// would brick the origin. Release it to plain pending and retry with
		// backoff instead.
		const modelKey = describeModel(lifecycle.effectiveModel);
		let modelReceipt: { readonly changed: boolean } | undefined;
		try {
			modelReceipt =
				lifecycle.effectiveModel && this.#appliedModel.get(binding.sessionId) !== modelKey
					? await this.#manager.port.setModel({
							sessionId: binding.sessionId,
							repo: this.#manager.repo,
							selection: lifecycle.effectiveModel,
							relay: tail,
						})
					: undefined;
			if (lifecycle.effectiveModel) this.#appliedModel.set(binding.sessionId, modelKey);
			if (
				lifecycle.effectiveServiceTier &&
				this.#appliedServiceTier.get(binding.sessionId) !== lifecycle.effectiveServiceTier
			) {
				await this.#manager.port.setServiceTier({
					sessionId: binding.sessionId,
					repo: this.#manager.repo,
					tier: lifecycle.effectiveServiceTier,
					relay: tail,
				});
				this.#appliedServiceTier.set(binding.sessionId, lifecycle.effectiveServiceTier);
			}
			this.#preSendFailures = 0;
			this.#manager.log(
				`persona_model origin=${this.originKey} epoch=${epoch} session=${binding.sessionId} effective=${modelKey} changed=${modelReceipt?.changed ?? false} source=turn`,
			);
			if (lifecycle.effectiveServiceTier)
				this.#manager.log(
					`persona_service_tier origin=${this.originKey} epoch=${epoch} session=${binding.sessionId} tier=${lifecycle.effectiveServiceTier} source=turn`,
				);
		} catch (error) {
			await tail.close();
			const sessionGone = sdkStatusErrorCode(error) === "session_unavailable";
			const { attempt, nextEpoch } = this.#manager.database.transaction((tx) => {
				const attempt = retryInboundTurn(this.#manager.database, tx, opRef);
				const nextEpoch = sessionGone ? this.#manager.database.bindings.rotateEpoch(tx, this.originKey) : undefined;
				return { attempt, nextEpoch };
			});
			this.#current = undefined;
			this.#state = "idle";
			await this.#notifyReleased(current);
			this.#preSendFailures += 1;
			const failures = this.#preSendFailures;
			this.#manager.recordPreSendFailure(this.originKey, safeDiagnostic(error));
			this.#manager.log(
				`persona_model_failed origin=${this.originKey} epoch=${epoch}${nextEpoch === undefined ? "" : ` nextEpoch=${nextEpoch}`} session=${binding.sessionId} message=${trigger.message_id} attempt=${attempt} failures=${failures} selection=${modelKey} detail=${safeDiagnostic(error)}`,
				"error",
			);
			if (sessionGone) this.#preSendFailures = 0;
			this.#scheduleDispatchRetry(
				sessionGone
					? DISPATCH_FAILURE_RETRY_MS
					: Math.min(DISPATCH_FAILURE_RETRY_MAX_MS, DISPATCH_FAILURE_RETRY_MS * 2 ** Math.min(failures - 1, 10)),
			);
			return;
		}
		const preamble = this.#preambleForSend(binding.sessionId, epoch, lifecycle, context);
		// Durable send intent (#685) and the context rows this prompt rendered
		// (#686): from here on the prompt may land, so recovery must reconcile
		// this turn instead of requeueing it, and its inputs belong to it.
		if (
			!this.#manager.database.transaction((tx) =>
				this.#manager.database.inbox.markSendAttempted(tx, opRef, [...(lifecycle.contextMessageIds ?? [])]),
			)
		) {
			// The row left `bound` underneath this actor; nothing was sent for it.
			this.#current = undefined;
			this.#state = "idle";
			await tail.close();
			await this.#notifyReleased(current);
			this.#manager.log(`persona_send_skipped origin=${this.originKey} opRef=${opRef} reason=turn_not_bound`, "warn");
			return;
		}
		try {
			const receipt = await this.#manager.port.send({
				sessionId: binding.sessionId,
				repo: this.#manager.repo,
				text: lifecycle.text,
				opRef,
				relay: tail,
				busyStallMs: this.#manager.busyStallMs,
				...(preamble.text ? { systemPreamble: preamble.text } : {}),
				...(lifecycle.sendModelFallback ? { model: lifecycle.sendModelFallback } : {}),
			});
			tail.correlate(opRef, receipt);
			this.#manager.database.transaction((tx) => this.#manager.database.inbox.turnAccept(tx, opRef));
			this.#manager.recordSessionReady(this.originKey);
			if (preamble.next) this.#personaPreamble.set(binding.sessionId, preamble.next);
			this.#bindFailures = 0;
			this.#bindEpochPoisoned = false;
			this.#clearBindWedgeProbe();
		} catch (error) {
			if (error instanceof ModelNotSelectedError && error.opRef === opRef) {
				const refusal = new GjcRuntimeError(
					"model_not_selected: request was not admitted because no model is selected",
					{
						code: "model_not_selected",
						message: "request was not admitted because no model is selected",
					},
				);
				const attempt = this.#manager.database.transaction((tx) => retryInboundTurn(this.#manager.database, tx, opRef));
				this.#modelRefusalPaused = true;
				this.#current = undefined;
				this.#state = "idle";
				let cleanupFailure: unknown;
				try {
					await tail.close();
				} catch (closeError) {
					cleanupFailure = closeError;
				}
				try {
					await current.lifecycle.onModelRefusal?.({ ...current, error: refusal });
				} catch (noticeError) {
					cleanupFailure ??= noticeError;
				}
				await this.#notifyReleased(current);
				this.#manager.log(
					`persona_send_refused origin=${this.originKey} epoch=${epoch} session=${binding.sessionId} opRef=${opRef} message=${trigger.message_id} attempt=${attempt} reason=model_not_selected`,
				);
				if (cleanupFailure) throw cleanupFailure;
				return;
			}
			const unadmitted = this.#unadmittedReason(opRef, binding.sessionId);
			if (unadmitted || error instanceof SessionBusyStalledError) {
				await this.#releaseUnadmittedSend(current, error, unadmitted ?? "prompt_busy_refused");
				return;
			}
			// A command failure can occur after broker acceptance. Reconcile its exact
			// durable op-ref; an unknown status is an operator hold that the periodic
			// reconcile keeps sweeping, and it is never resent.
			if ((error instanceof OpRefRejectedError && error.code === CLIENT_REF_CONFLICT_CODE) || isOpRefRejection(error))
				this.#manager.log(
					`recovery_client_ref_conflict origin=${this.originKey} epoch=${epoch} opRef=${opRef}`,
					"error",
				);
			else
				this.#manager.log(
					`persona_send_ambiguous origin=${this.originKey} opRef=${opRef} detail=${safeDiagnostic(error)}`,
					"error",
				);
			await this.#reconcileBound(current);
			return;
		}
		await this.#steerPending();
	}

	/**
	 * The ONE place a recorded steer acceptance is finalized: durable state
	 * (steer done AND its platform message consumed from the unread window, in
	 * one transaction - a crash cannot leave the message unread), then the
	 * lifecycle's ownership release - or, when the turn's lifecycle is gone
	 * (resolved after terminal or after a restart), the manager-level
	 * equivalent - then the external observer. Every path that learns of an
	 * acceptance (live, replay, terminal, stale hold) goes through here.
	 */
	async #finalizeSteerAcceptance(
		row: InboundMessageRow,
		epoch: number,
		opRef: string,
		bound: BoundTurn | undefined,
	): Promise<boolean> {
		const contextMessageId = bound
			? bound.lifecycle.steerContextMessageId?.(row)
			: this.#manager.heldSteerContextMessageId(row);
		const accepted = this.#manager.database.transaction((tx) =>
			this.#manager.database.inbox.steerAccepted(tx, { messageId: row.message_id, epoch, opRef, contextMessageId }),
		);
		if (!accepted) return false;
		if (bound) await bound.lifecycle.onSteerAccepted?.({ ...bound, row });
		else await this.#manager.emitHeldSteerAccepted({ originKey: this.originKey, row, opRef });
		await this.#manager.emitSteer({ originKey: this.originKey, messageId: row.message_id, opRef });
		this.#manager.log(`steer_delivered originKey=${this.originKey} opRef=${opRef} messageId=${row.message_id}`);
		return true;
	}

	/**
	 * Closes a held steer whose turn is over and whose session is gone: done input
	 * of that turn (never re-dispatched) with its platform message consumed from
	 * the unread window in the same transaction, then transient ownership
	 * released - the same shape as an accepted steer, minus the delivery claim.
	 */
	async #abandonHeldSteer(row: InboundMessageRow, opRef: string, bound: BoundTurn | undefined): Promise<void> {
		const contextMessageId = bound
			? bound.lifecycle.steerContextMessageId?.(row)
			: this.#manager.heldSteerContextMessageId(row);
		const closed = this.#manager.database.transaction((tx) =>
			this.#manager.database.inbox.steerAbandoned(tx, row.message_id, opRef, contextMessageId),
		);
		if (!closed) return;
		await this.#manager.emitHeldSteerAccepted({ originKey: this.originKey, row, opRef, abandoned: true });
		this.#manager.log(
			`steer_abandoned origin=${this.originKey} message=${row.message_id} opRef=${opRef} reason=session_gone`,
		);
	}

	/**
	 * A steer held on a turn that has since ended can only be resolved by
	 * replaying its clientRef: the runtime answers with the recorded outcome.
	 * Accepted -> done input of that old turn; refused -> an ordinary pending
	 * row that the dispatch below will send; still torn -> keeps waiting, and
	 * newer rows are NOT blocked behind it.
	 */
	async #resolveStaleHolds(): Promise<void> {
		for (const held of this.#manager.database.inbox.steersHeldAfterTerminal(this.originKey)) {
			const opRef = held.turn_op_ref;
			if (
				this.#manager.database.bindings.isQuarantined("inbound", held.message_id) ||
				(opRef && this.#quarantinedTurn(opRef))
			)
				continue;
			const epoch = held.turn_epoch;
			const sessionId = held.bound_session_id ?? this.#manager.database.inbox.turnRow(opRef ?? "")?.bound_session_id;
			if (!opRef || epoch === null || !sessionId) continue;
			const clientRef = steerClientRef(this.#manager.instanceId, this.originKey, epoch, held.message_id);
			try {
				await this.#manager.port.steer({
					sessionId,
					repo: this.#manager.repo,
					text: laneSteerText(held),
					clientRef,
				});
				await this.#finalizeSteerAcceptance(held, epoch, opRef, undefined);
			} catch (error) {
				if (isDefinitiveSteerRejection(error))
					this.#manager.database.transaction((tx) =>
						this.#manager.database.inbox.steerRefused(tx, held.message_id, opRef),
					);
				else if (await this.#sessionProvablyGone(sessionId, error)) {
					// The turn is over and its session is gone: nothing will ever answer
					// the clientRef replay. Whether the model saw the message is
					// unknowable, so it is closed with that turn, never re-dispatched (a
					// resend could answer it twice). Retrying it every sweep only logged
					// `host hello did not arrive` for an hour after a broker restart.
					await this.#abandonHeldSteer(held, opRef, undefined);
				} else
					this.#manager.log(
						`steer_hold origin=${this.originKey} message=${held.message_id} opRef=${opRef} reason=unresolved_after_terminal detail=${safeDiagnostic(error)}`,
						"warn",
					);
			}
		}
	}

	/**
	 * Positive evidence that a session can no longer run anything: the SDK
	 * reported `session_unavailable`, or the relay failed and the broker's own
	 * liveness reports it not live / disowned. An unanswerable probe is not
	 * evidence.
	 */
	async #sessionProvablyGone(sessionId: string, error: unknown): Promise<boolean> {
		if (error instanceof BrokerAuthorityError) throw error;
		if (sdkStatusErrorCode(error) === "session_unavailable") return true;
		if (!this.#manager.port.liveness) return false;
		try {
			const raw = await this.#manager.port.liveness({ sessionId, repo: this.#manager.repo });
			return raw.live === false || raw.disowned === true;
		} catch (probeError) {
			if (probeError instanceof BrokerAuthorityError) throw probeError;
			return false;
		}
	}

	#bindFailures = 0;
	#preSendFailures = 0;
	/** A terminal_uncertain bind poisons this epoch's idempotency key; retries cannot make that key decidable. */
	#bindEpochPoisoned = false;
	#sameDetailBindFailures = 0;
	#lastBindDetail: string | undefined;
	#bindHoldProbed = false;
	#bindWedged = false;
	#lastBindHoldReason: string | undefined;

	#clearBindWedgeProbe(): void {
		this.#sameDetailBindFailures = 0;
		this.#lastBindDetail = undefined;
		this.#bindHoldProbed = false;
		this.#bindWedged = false;
		this.#lastBindHoldReason = undefined;
	}

	/**
	 * A session could not be bound for the next turn (broker down, Router
	 * disowning every candidate). The message is never dropped; the retry backs
	 * off, and once MAX_SEND_REBIND_ATTEMPTS consecutive attempts have failed
	 * the condition is logged as unrecoverable so an operator sees it - retries
	 * continue at the ceiling because the broker may come back.
	 */
	async #noteBindFailure(trigger: InboundMessageRow, epoch: number, error: unknown): Promise<void> {
		this.#bindFailures += 1;
		const attempts = this.#bindFailures;
		const detail = safeDiagnostic(error);
		if (detail.includes("terminal_uncertain")) this.#bindEpochPoisoned = true;
		if (detail === this.#lastBindDetail) this.#sameDetailBindFailures += 1;
		else {
			this.#lastBindDetail = detail;
			this.#sameDetailBindFailures = 1;
			this.#bindHoldProbed = false;
			this.#bindWedged = false;
			this.#lastBindHoldReason = undefined;
		}
		this.#manager.log(
			`persona_bind_failed origin=${this.originKey} epoch=${epoch} message=${trigger.message_id} attempts=${attempts} detail=${detail}`,
			"error",
		);
		this.#manager.recordBindFailure(this.originKey, detail);
		if (attempts === MAX_SEND_REBIND_ATTEMPTS)
			this.#manager.log(
				`persona_send_unrecoverable origin=${this.originKey} message=${trigger.message_id} attempts=${attempts} reason=bind_failed`,
				"error",
			);
		if (this.#sameDetailBindFailures >= BIND_WEDGE_PROBE_STRIKES && !this.#bindHoldProbed) {
			const probe = this.#manager.brokerLiveness;
			if (probe) {
				this.#bindHoldProbed = true;
				let verdict: BrokerLivenessVerdict | undefined;
				try {
					verdict = await probe();
				} catch (probeError) {
					this.#manager.log(
						`persona_bind_liveness_failed origin=${this.originKey} detail=${safeDiagnostic(probeError)}`,
						"error",
					);
				}
				const hold = await describeBindHold(
					verdict,
					detail,
					this.#sameDetailBindFailures,
					this.#manager.brokerAgentDir,
				);
				this.#bindWedged = verdict?.state === "wedged";
				this.#manager.log(
					`persona_bind_hold origin=${this.originKey} epoch=${epoch} message=${trigger.message_id} attempts=${this.#sameDetailBindFailures} reason=${hold.reason} detail=${detail}`,
					"warn",
				);
				if (hold.reason !== this.#lastBindHoldReason) {
					this.#lastBindHoldReason = hold.reason;
					await this.#manager.emitBindHold({ originKey: this.originKey, trigger, ...hold, verdict });
				}
			}
		}
		if (this.#bindWedged) {
			// A dead/stale owner cannot be recovered by another poisoned epoch key.
			// Keep the pending trigger held and retry only at the bounded ceiling.
			this.#bindEpochPoisoned = false;
			this.#scheduleDispatchRetry(DISPATCH_FAILURE_RETRY_MAX_MS);
			return;
		}
		if (this.#bindEpochPoisoned && attempts >= MAX_SEND_REBIND_ATTEMPTS) {
			// bind() failed BEFORE inboundBindTurn, so no prompt was sent and no
			// operation belongs to this row. terminal_uncertain is attached to the
			// epoch-scoped session-create idempotency key; retrying that same key
			// forever cannot recover it (live: one channel repeated it 335 times).
			// Advance the epoch to derive a new key while leaving every inbound row
			// pending and intact, then retry with the normal base delay.
			const nextEpoch = this.#manager.database.transaction((tx) =>
				this.#manager.database.bindings.rotateEpoch(tx, this.originKey),
			);
			this.#manager.log(
				`persona_bind_epoch_rotated origin=${this.originKey} epoch=${epoch} nextEpoch=${nextEpoch} message=${trigger.message_id} attempts=${attempts} reason=terminal_uncertain`,
			);
			this.#bindFailures = 0;
			this.#bindEpochPoisoned = false;
			this.#scheduleDispatchRetry(DISPATCH_FAILURE_RETRY_MS);
			return;
		}
		const delay = Math.min(DISPATCH_FAILURE_RETRY_MAX_MS, DISPATCH_FAILURE_RETRY_MS * 2 ** Math.min(attempts - 1, 10));
		this.#scheduleDispatchRetry(delay);
	}

	#scheduleDispatchRetry(delayMs: number): void {
		if (this.#dispatchRetry) return;
		const timer = this.#manager.schedule(() => {
			this.#graceTimers.delete(timer);
			this.#dispatchRetry = undefined;
			if (this.#stopped || this.#manager.stopped) return;
			void this.enqueue(async () => await this.#dispatchNext()).catch(() => {});
		}, delayMs);
		this.#graceTimers.add(timer);
		this.#dispatchRetry = timer;
	}

	/** Schedules a bounded provider-transport retry after confirming the turn is safe to replay. */
	#scheduleAgentErrorRetry(bound: BoundTurn, delayMs: number): void {
		if (bound.agentErrorRetryScheduled) return;
		bound.agentErrorRetryScheduled = true;
		const timer = this.#manager.schedule(() => {
			this.#graceTimers.delete(timer);
			if (this.#stopped || this.#manager.stopped) {
				bound.agentErrorRetryScheduled = false;
				return;
			}
			if (this.#current !== bound) {
				bound.agentErrorRetryScheduled = false;
				return;
			}
			void this.enqueue(async () => {
				bound.agentErrorRetryScheduled = false;
				// A reset may have retired this turn while its timer was queued behind
				// the reset's asynchronous cleanup. Never requeue or clear a replacement.
				if (this.#stopped || this.#manager.stopped || this.#current !== bound || bound.retired) return;
				if (!this.#canRetryProviderTransport(bound)) {
					await this.#reconcileBound(bound);
					return;
				}
				const oldOpRef = bound.turn.opRef;
				try {
					await bound.tail?.close();
					// Increment the provider retry budget independently of other turn requeues.
					const nextProviderRetryAttempt = this.#manager.database.transaction((tx) =>
						retryProviderTransportTurn(this.#manager.database, tx, oldOpRef),
					);
					this.#manager.log(
						`agent_error_retry origin=${this.originKey} epoch=${bound.epoch} oldOpRef=${oldOpRef} attempt=${nextProviderRetryAttempt}/${MAX_AGENT_ERROR_RETRY_ATTEMPTS}`,
						"warn",
					);
					// Clear current turn only after the old tail is closed and the row is requeued.
					this.#current = undefined;
					this.#state = "idle";
					await this.#notifyReleased(bound);
					// Dispatch the turn again with a new opRef
					await this.#dispatchNext();
				} catch (error) {
					this.#manager.log(
						`agent_error_retry_failed origin=${this.originKey} opRef=${oldOpRef} detail=${safeDiagnostic(error)}`,
						"error",
					);
				}
			}).catch(() => {
				bound.agentErrorRetryScheduled = false;
			});
		}, delayMs);
		this.#graceTimers.add(timer);
	}

	#canRetryProviderTransport(bound: BoundTurn): boolean {
		if (
			this.#current !== bound ||
			bound.retired ||
			bound.replyVisible ||
			bound.lastAssistantText !== undefined ||
			bound.hadToolActivity ||
			bound.permissionRequestObserved ||
			bound.openTool ||
			bound.tailEvidenceUnavailable
		)
			return false;
		return !this.#manager.database.inbox.turnRows(bound.turn.opRef).some((row) => row.turn_role === "steer");
	}

	/**
	 * Every message the user sends goes into the live session, immediately.
	 *
	 * A `nonSteerable` flag used to gate this. It was set by seven reconcile
	 * paths that could not decide what happened to the OPERATION - a statement
	 * about completing the turn, never about whether the user may speak. Gating
	 * ingestion on it meant one undecidable turn silenced the conversation: the
	 * rows stayed unbatched, the stale floor deleted them ten minutes later, and
	 * the user's messages were gone without ever reaching the model (live: four
	 * DMs eaten behind an 85-minute wedge, 2026-09-03). A retired turn is still
	 * excluded - it no longer exists to steer into. If the session has in fact
	 * already finished the turn, the steer fails and #recoverFromSteerFailure
	 * turns the row into the next send.
	 */
	async #steerPending(): Promise<void> {
		const current = this.#current;
		if (
			this.#manager.draining ||
			this.#manager.restartDrainActive ||
			this.#modelRefusalPaused ||
			!current ||
			current.retired ||
			current.replyVisible ||
			this.#state !== "turn-running"
		)
			return;
		if (this.#deferredSteerOpRef === current.turn.opRef) return;
		// A turn in recovery_hold (operation_state_unknown or past stall threshold)
		// must not absorb new inbound as steers; new inbound must remain pending so it
		// can start a fresh trigger turn. This ensures mentions and other new messages
		// always get a reply, not silently absorbed into a dead op (fix for #405).
		if (this.#holdSweeps.has(current.turn.opRef)) return;
		// Steers whose transport tore before an answer are resolved first, on
		// the same clientRef, before any new row is issued behind them.
		for (const held of this.#manager.database.inbox.steersHeld(current.turn.opRef))
			if (!(await this.#steerRow(current, held))) return;
		for (;;) {
			const row = this.#manager.database.inbox.pendingOldest(this.originKey);
			if (!row) return;
			if (!(await this.#steerRow(current, row))) return;
		}
	}

	/**
	 * Issues one row into the running turn. Returns false when the loop must
	 * stop: the outcome is still unknown (row held, durably attributed to this
	 * turn) or the session refused and is being recovered.
	 */
	async #steerRow(current: BoundTurn, row: InboundMessageRow): Promise<boolean> {
		if (
			this.#manager.database.bindings.isQuarantined("inbound", row.message_id) ||
			this.#quarantinedTurn(current.turn.opRef)
		)
			return false;
		// The row's message was already rendered into this turn's unread context
		// (e.g. the row was requeued by recovery and the next turn's prompt picked
		// it up). Steering it too would make the model answer it twice. Close it as
		// done input of this turn WITHOUT sending: leaving it pending would make
		// the #steerPending loop re-read the same row forever.
		// Exact id only: an edit row carries new text for an old message and must
		// still be steered even when the original is in the context window.
		if (current.lifecycle.contextMessageIds?.has(row.message_id)) {
			const contextMessageId = current.lifecycle.steerContextMessageId?.(row);
			const closed = this.#manager.database.transaction((tx) =>
				this.#manager.database.inbox.steerAccepted(tx, {
					messageId: row.message_id,
					epoch: current.epoch,
					opRef: current.turn.opRef,
					contextMessageId,
				}),
			);
			if (!closed) return false;
			await current.lifecycle.onSteerAccepted?.({ ...current, row });
			this.#manager.log(
				`steer_skip origin=${this.originKey} message=${row.message_id} opRef=${current.turn.opRef} reason=already_in_context`,
			);
			return true;
		}
		{
			assertControlAllowed("turn.steer", { operatorApproval: true });
			const clientRef = steerClientRef(this.#manager.instanceId, this.originKey, current.epoch, row.message_id);
			// Durable BEFORE the first attempt: from here the row belongs to this
			// turn. A torn transport leaves it `steer/bound` - never dispatched as
			// a trigger, retried on this clientRef by the next admission, tick or
			// restart - until the runtime records acceptance or refuses.
			this.#manager.database.transaction((tx) =>
				this.#manager.database.inbox.steerIssued(tx, {
					messageId: row.message_id,
					epoch: current.epoch,
					opRef: current.turn.opRef,
				}),
			);
			const steer = {
				sessionId: current.sessionId,
				repo: this.#manager.repo,
				text: laneSteerText(row, current.lifecycle),
				clientRef,
				...(current.tail ? { relay: current.tail } : {}),
			};
			let outcome: "accepted" | "refused" | "ambiguous" = "accepted";
			let failure: unknown;
			// The transport can fail AFTER the request landed (CLI killed mid-print,
			// socket reset). The clientRef is durable on the gjc side, so replaying
			// it returns the recorded outcome instead of delivering twice. Only an
			// ok:false envelope is a decision; a torn transport is replayed a
			// bounded number of times and, if it stays torn, the row is HELD - the
			// message may already be inside the running turn, and sending it to a
			// replacement session would deliver it twice. The next admission or
			// reconcile retries the same clientRef.
			for (let attempt = 0; attempt <= STEER_REPLAY_ATTEMPTS; attempt++) {
				try {
					await this.#manager.port.steer(steer);
					outcome = "accepted";
					break;
				} catch (error) {
					failure = error;
					if (isDefinitiveSteerRejection(error)) {
						outcome = "refused";
						break;
					}
					outcome = "ambiguous";
					if (attempt < STEER_REPLAY_ATTEMPTS)
						this.#manager.log(
							`steer_ambiguous origin=${this.originKey} message=${row.message_id} action=replay attempt=${attempt + 1} detail=${safeDiagnostic(error)}`,
							"error",
						);
				}
			}
			if (outcome === "ambiguous") {
				this.#manager.log(
					`steer_hold origin=${this.originKey} message=${row.message_id} opRef=${current.turn.opRef} reason=transport_torn detail=${safeDiagnostic(failure)}`,
					"error",
				);
				return false;
			}
			if (outcome === "refused") {
				// Keep the row pending for the next turn in this session. Do not
				// repeatedly offer a refused row on each running-turn tick.
				this.#deferredSteerOpRef = current.turn.opRef;
				this.#manager.database.transaction((tx) =>
					this.#manager.database.inbox.steerRefused(tx, row.message_id, current.turn.opRef),
				);
				this.#manager.log(
					`steer_failed origin=${this.originKey} message=${row.message_id} action=recover detail=${safeDiagnostic(failure)}`,
					"error",
				);
				await this.#recoverFromSteerFailure(current);
				return false;
			}
			await this.#finalizeSteerAcceptance(row, current.epoch, current.turn.opRef, current);
		}
		return true;
	}

	async #ensureSession(epoch: number): Promise<SessionBinding> {
		return (await this.#reuseStoredBinding(epoch)) ?? (await this.#bindSession(epoch));
	}

	/** The stored binding when its session is live or was resumed; undefined when a bind must replace it. */
	async #reuseStoredBinding(epoch: number): Promise<SessionBinding | undefined> {
		const existing = this.#manager.database.bindings.getSessionRecord(this.originKey);
		if (existing?.epoch === epoch && existing.sessionId) {
			const binding = { sessionId: existing.sessionId, originKey: this.originKey, epoch, repo: this.#manager.repo };
			// An idle binding may point at a session the broker no longer hosts
			// (broker restart while idle, or a host that closed itself after 30
			// idle minutes). Dead + saved authority is resumed through the
			// unchanged decision table's `session.resume` branch BEFORE any send;
			// a dead binding is never handed to a send as if it were live. Read
			// from the raw envelope: the normalized inspect is undefined for every
			// session gjc >= 0.16.0 reports, which handed dead bindings to sends.
			const state = await this.#bindingState(existing.sessionId);
			if (state.live !== false) return binding;
			if (state.deleted !== true && (state.workspace === undefined || state.workspace === this.#manager.repo)) {
				try {
					await this.#manager.port.resume({
						sessionId: existing.sessionId,
						repo: this.#manager.repo,
						originKey: this.originKey,
						epoch,
					});
					this.#manager.log(
						`session_resumed origin=${this.originKey} epoch=${epoch} session=${existing.sessionId} reason=idle_dead_binding`,
					);
					return binding;
				} catch (error) {
					this.#manager.log(
						`session_resume_failed origin=${this.originKey} epoch=${epoch} session=${existing.sessionId} detail=${safeDiagnostic(error)}`,
						"error",
					);
				}
			}
			// Deleted or unresumable: the epoch-scoped idempotent bind replaces it,
			// whose rebind policy owns condemnation (SessionRebinder), not this actor.
		}
		return undefined;
	}

	async #bindSession(epoch: number): Promise<SessionBinding> {
		const binding = await this.#manager.port.bind({
			originKey: this.originKey,
			epoch,
			repo: this.#manager.repo,
			...(this.#manager.sessionModel ? { model: this.#manager.sessionModel } : {}),
		});
		if (binding.startupModelApplied && this.#manager.sessionModel)
			this.#appliedModel.set(binding.sessionId, describeModel(this.#manager.sessionModel));
		return binding;
	}

	async recoverObserver(): Promise<void> {
		if (this.#observer || this.#current) return;
		const binding = this.#manager.database.bindings.getSessionRecord(this.originKey);
		if (!binding?.sessionId || !this.#manager.port.liveness) return;
		try {
			const live = await this.#manager.port.liveness({ sessionId: binding.sessionId, repo: this.#manager.repo });
			if (live.live !== true || live.disowned) return;
			let jobs = false;
			try {
				jobs =
					(await this.#manager.port.runningJobs?.({ sessionId: binding.sessionId, repo: this.#manager.repo }))
						?.length !== 0;
			} catch {
				jobs = true;
			}
			const active = live.activity?.state !== undefined && live.activity.state !== "idle";
			if (!jobs && !active) return;
			this.#armObserver(binding.sessionId, binding.epoch, undefined, "recover");
			if (active) this.#observer!.active = true;
			await this.sweepObserver(this.#manager.now());
		} catch (error) {
			this.#manager.log(
				`agent_run_observer_lost origin=${this.originKey} session=${binding.sessionId} reason=recover detail=${safeDiagnostic(error)}`,
				"warn",
			);
		}
	}

	#armObserver(sessionId: string, epoch: number, tail: TailHandle | undefined, reason: string): void {
		const now = this.#manager.now();
		if (this.#observer?.sessionId === sessionId && this.#observer.epoch === epoch) {
			this.#observer.settledAt = now;
			this.#observer.until = now + AGENT_RUN_GRACE_MS;
			this.#observer.tail ??= tail;
		} else
			this.#observer = {
				sessionId,
				epoch,
				generation: this.#manager.brokerGeneration,
				tail,
				settledAt: now,
				until: now + AGENT_RUN_GRACE_MS,
			};
		this.#observer.tail?.setObserving(true);
		this.#touchHost(sessionId);
		this.#manager.log(`agent_run_observer_open origin=${this.originKey} session=${sessionId} reason=${reason}`);
	}

	async #closeObserver(reason: string): Promise<void> {
		const observer = this.#observer;
		if (!observer) return;
		this.#observer = undefined;
		if (observer.noticeTimer !== undefined) this.#manager.cancel(observer.noticeTimer);
		observer.tail?.setObserving(false);
		if (this.#current?.tail !== observer.tail) await observer.tail?.close();
		this.#manager.log(
			`agent_run_observer_closed origin=${this.originKey} session=${observer.sessionId} reason=${reason}`,
		);
	}

	#observerLost(reason: string, closed: boolean): void {
		const observer = this.#observer;
		if (!observer) return;
		observer.lost = true;
		this.#manager.log(
			`agent_run_observer_lost origin=${this.originKey} session=${observer.sessionId} reason=${reason}`,
			"warn",
		);
		if (closed) observer.tail = undefined;
	}

	#observerLifecycle(kind: "agent_start" | "agent_end" | "agent_failed", correlated = false): void {
		const observer = this.#observer;
		if (!observer) return;
		if (kind === "agent_start") {
			if (!correlated) {
				observer.active = true;
				observer.tail?.setObserving(true);
			}
			return;
		}
		if (!observer.active) {
			if (!correlated)
				this.#manager.log(`agent_run_unattributed_end origin=${this.originKey} session=${observer.sessionId}`);
			return;
		}
		observer.active = false;
		observer.lost = false;
		observer.tail?.setObserving(true);
		observer.firstEndAt ??= this.#manager.now();
		observer.batchId ??= randomUUID();
		this.#manager.log(`agent_run_autonomous_end origin=${this.originKey} session=${observer.sessionId}`);
		if (observer.noticeTimer !== undefined) this.#manager.cancel(observer.noticeTimer);
		observer.noticeTimer = this.#manager.schedule(() => {
			observer.noticeTimer = undefined;
			void this.enqueue(async () => {
				if (this.#observer === observer) await this.#noticeAgentRun(observer);
			}).catch((error: unknown) =>
				this.#manager.log(
					`agent_run_observer_lost origin=${this.originKey} session=${observer.sessionId} reason=notice_failed detail=${safeDiagnostic(error)}`,
					"warn",
				),
			);
		}, AGENT_RUN_NOTICE_DELAY_MS);
	}

	async #noticeAgentRun(observer: AgentRunObserver): Promise<void> {
		if (this.#hostStopping(observer.sessionId)) {
			await this.#closeObserver("host_terminated");
			return;
		}
		if (observer.firstEndAt === undefined || observer.active) return;
		const binding = this.#manager.database.bindings.getSessionRecord(this.originKey);
		if (binding?.sessionId !== observer.sessionId || binding.epoch !== observer.epoch) {
			await this.#closeObserver("binding_changed");
			return;
		}
		try {
			const jobs = await this.#manager.port.runningJobs?.({ sessionId: observer.sessionId, repo: this.#manager.repo });
			if (jobs?.length) {
				this.#manager.log(
					`agent_run_notice_deferred origin=${this.originKey} session=${observer.sessionId} jobs=${jobs.length}`,
				);
				return;
			}
		} catch {
			/* An unavailable job report must not indefinitely suppress the notice. */
		}
		const origin = this.#manager.database.bindings.getOriginByKey(this.originKey);
		if (!origin) throw new Error("agent run notice has no bound origin");
		const messageId = `agent-run/${observer.sessionId}/${observer.batchId}`;
		const coalesced = this.#manager.database.transaction((tx) => {
			if (this.#manager.database.inbox.hasPendingAgentRunNotice(this.originKey)) return true;
			const enqueued = this.#manager.database.inbox.enqueue(tx, {
				messageId,
				originKey: this.originKey,
				originRefJson: JSON.stringify(origin),
				body: AGENT_RUN_NOTICE,
				source: "lane_report",
				receivedAt: new Date(this.#manager.now()).toISOString(),
			});
			if (!enqueued) throw new Error("agent run notice was not enqueued");
			return false;
		});
		observer.firstEndAt = undefined;
		observer.batchId = undefined;
		this.#manager.log(
			`agent_run_notice_${coalesced ? "coalesced" : "enqueued"} origin=${this.originKey} session=${observer.sessionId}${coalesced ? "" : ` messageId=${messageId}`}`,
		);
		// Queue admission after this mailbox transition, like work-lane reports.
		void this.#manager.notifyInbound(this.originKey).catch(() => {});
	}

	async sweepObserver(now: number): Promise<void> {
		const observer = this.#observer;
		if (!observer) return;
		if (this.#hostStopping(observer.sessionId)) {
			await this.#closeObserver("host_terminated");
			return;
		}
		const binding = this.#manager.database.bindings.getSessionRecord(this.originKey);
		if (
			binding?.sessionId !== observer.sessionId ||
			binding.epoch !== observer.epoch ||
			observer.generation !== this.#manager.brokerGeneration
		) {
			await this.#closeObserver("binding_changed");
			return;
		}
		let running = true;
		try {
			running =
				!this.#manager.port.runningJobs ||
				(await this.#manager.port.runningJobs({ sessionId: observer.sessionId, repo: this.#manager.repo })).length > 0;
		} catch {
			/* Keep observing an unavailable job report, bounded by the hard cap. */
		}
		let active = true;
		try {
			const live = await this.#manager.port.liveness?.({ sessionId: observer.sessionId, repo: this.#manager.repo });
			if (live?.live === false || live?.disowned) {
				await this.#closeObserver("host_terminated");
				return;
			}
			active = live?.activity?.state !== "idle";
			if ((!observer.tail || observer.lost) && active && live?.activity && !this.#current) {
				// A start can fall in the disconnect gap. A working host with no
				// gateway owner is sufficient to infer autonomous work in progress.
				observer.active = true;
				observer.tail?.setObserving(true);
			}
			if ((!observer.tail || observer.lost) && observer.active && !active && !this.#current)
				this.#observerLifecycle("agent_end");
		} catch {
			/* Liveness unavailable: retain observation until the hard cap. */
		}
		if (running || active || observer.active)
			observer.until = Math.min(now + AGENT_RUN_GRACE_MS, observer.settledAt + AGENT_RUN_MAX_MS);
		if (observer.firstEndAt !== undefined && observer.noticeTimer === undefined) {
			try {
				await this.#noticeAgentRun(observer);
			} catch (error) {
				this.#manager.log(
					`agent_run_notice_failed origin=${this.originKey} session=${observer.sessionId} detail=${safeDiagnostic(error)}`,
					"warn",
				);
			}
		}
		if (now >= observer.until && (observer.noticeTimer === undefined || now >= observer.settledAt + AGENT_RUN_MAX_MS)) {
			await this.#closeObserver("grace_expired");
			return;
		}
		if (!observer.tail) {
			try {
				observer.tail = await this.#attachTail(observer.sessionId, observer.epoch, false, true);
				observer.tail.setObserving(true);
				this.#manager.log(
					`agent_run_observer_open origin=${this.originKey} session=${observer.sessionId} reason=reattach`,
				);
			} catch (error) {
				this.#manager.log(
					`agent_run_observer_lost origin=${this.originKey} session=${observer.sessionId} reason=attach detail=${safeDiagnostic(error)}`,
					"warn",
				);
			}
		}
	}

	#hostStopping(sessionId: string): boolean {
		return (
			this.#hostTerminatingSessionId === sessionId ||
			(this.#current?.sessionId === sessionId &&
				(this.#current.stallHostTerminated === true || this.#current.stallHostTerminating === true))
		);
	}

	async #attachTail(sessionId: string, epoch: number, retired: boolean, observing = false): Promise<TailHandle> {
		if (this.#observer && (this.#observer.sessionId !== sessionId || this.#observer.epoch !== epoch))
			await this.#closeObserver("binding_changed");
		// Reuse without awaiting another slot inside the origin mailbox.
		// Transport callbacks carry the turn identity captured at receipt.
		if (!retired && !observing && this.#observer?.tail) return this.#observer.tail;
		const generation = this.#manager.brokerGeneration;
		// Callbacks are fenced by the handle they came from: a late callback from
		// a handle this turn no longer holds (or a previous turn's handle on the
		// same session) must never act on the current binding.
		let self: TailHandle | undefined;
		const activity = { version: 0 };
		const owns = (bound: BoundTurn | undefined): bound is BoundTurn => bound !== undefined && bound.tail === self;
		const handle = await this.#manager.port.attachTail({
			sessionId,
			brokerGeneration: generation,
			repo: this.#manager.repo,
			originKey: this.originKey,
			priority: retired || observing ? "retired" : "current",
			onObserverLifecycle: retired
				? undefined
				: async (kind, correlated) => {
						const observer = this.#observer;
						// A gateway-owned boundary before observation was armed carries no
						// autonomous state and needs only the ordinary turn callback.
						if (!observer && correlated) return;
						await this.enqueue(async () => {
							if (
								(observer && this.#observer === observer) ||
								(!observer &&
									this.#observer?.sessionId === sessionId &&
									this.#observer.epoch === epoch &&
									this.#observer.generation === generation)
							)
								this.#observerLifecycle(kind, correlated);
							else
								this.#manager.log(
									`agent_run_observer_lost origin=${this.originKey} session=${sessionId} reason=lifecycle_discarded kind=${kind}`,
									"warn",
								);
						});
					},
			onClosed: () => {
				if (self && this.#observer?.tail === self) this.#observerLost("evicted", true);
			},
			// Awaited on purpose: the handle delivers frames in order, each one's
			// side effects (ledger, delivery, terminal) before the next. The handle
			// never calls back from inside a mailbox turn, so re-entrancy is safe.
			onFrame: async (frame) => {
				if (
					!frame.idle ||
					frame.assistantText !== undefined ||
					frame.payload.toolCallStarted === true ||
					frame.rawKind === "agent_end" ||
					frame.rawKind === "agent_failed"
				)
					activity.version += 1;
				await this.enqueue(async () => {
					const bound = this.#findBound(sessionId, epoch, generation);
					if (bound && (!owns(bound) || bound.detached || frame.receiptOpRef !== bound.turn.opRef)) return;
					await this.#onTailFrame(sessionId, epoch, generation, retired, frame);
				});
			},
			onRelayLost: ({ opRef }) => {
				void this.enqueue(async () => {
					const bound = this.#findBound(sessionId, epoch, generation);
					if (bound && bound.turn.opRef !== opRef) return;
					if (self && this.#observer?.tail === self) this.#observerLost("transport", false);
					if (!owns(bound) || bound.turn.opRef !== opRef) return;
					await this.#onRelayLost(sessionId, epoch, generation, retired, false);
				}).catch((error: unknown) =>
					this.#manager.log(
						`persona_relay_lost_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
						"error",
					),
				);
			},
			onRelayDead: ({ opRef }) => {
				void this.enqueue(async () => {
					const bound = this.#findBound(sessionId, epoch, generation);
					if (bound && bound.turn.opRef !== opRef) return;
					if (self && this.#observer?.tail === self) this.#observerLost("dead", true);
					if (!owns(bound) || bound.turn.opRef !== opRef) return;
					await this.#onRelayLost(sessionId, epoch, generation, retired, true);
				}).catch((error: unknown) =>
					this.#manager.log(
						`persona_relay_dead_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
						"error",
					),
				);
			},
			onStall: ({ elapsedMs }) => {
				void this.enqueue(async () => {
					if (!owns(this.#findBound(sessionId, epoch, generation))) return;
					await this.#onStall(sessionId, epoch, generation, retired, elapsedMs);
				}).catch(() => {});
			},
			onReverseRequest: async (input) => {
				await this.enqueue(async () => {
					if (!owns(this.#findBound(sessionId, epoch, generation)) && this.#observer?.tail !== self) return;
					await this.#onReverseRequest(sessionId, epoch, generation, retired, input, self!);
				}).catch((error: unknown) =>
					this.#manager.log(
						`persona_reverse_request_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
						"error",
					),
				);
			},
			onDiagnostic: (line, level) => this.#manager.log(line, level),
		});
		self = handle;
		this.#tailActivityVersions.set(handle, activity);
		return handle;
	}

	/**
	 * A turn can fail AFTER it wrote its answer: a tool call that times out
	 * ends the whole run (#210), and a relay that went dark mid-turn never
	 * showed the reply. When no assistant text reached the consumer, read the
	 * transcript for a row written since this turn dispatched. A reply already
	 * shown on the tail is not re-read: it was delivered (or deliberately not).
	 */
	async #recoverFailedTurnAnswer(bound: BoundTurn): Promise<string | undefined> {
		const port = this.#manager.port;
		if (bound.replyVisible || bound.lastAssistantText !== undefined) return undefined;
		if (!port.fetchAssistantSince || bound.dispatchedAtMs === undefined) return undefined;
		try {
			const found = await port.fetchAssistantSince({
				sessionId: bound.sessionId,
				repo: this.#manager.repo,
				notBeforeMs: bound.dispatchedAtMs,
				...this.#liveRelay(bound),
			});
			const text = found?.text?.trim();
			if (!text) return undefined;
			this.#manager.log(
				`failed_turn_answer_recovered origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} chars=${text.length}`,
			);
			return text;
		} catch (error) {
			this.#manager.log(
				`failed_turn_answer_probe_failed origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
			);
			return undefined;
		}
	}

	/** True while `bound` is still this actor's current or retired turn and the actor runs. */
	#stillTracked(bound: BoundTurn): boolean {
		return (
			!this.#stopped &&
			!this.#manager.stopped &&
			(this.#current === bound || this.#retired.get(retiredKey(bound)) === bound)
		);
	}

	/** Stops a current operation only after its live tail stayed silent and status remained nonterminal past the hard bound. */
	async #terminateStalledTurn(bound: BoundTurn): Promise<boolean> {
		if (!this.#stillTracked(bound) || this.#current !== bound || bound.retired || !bound.statusRecheckAfterStall)
			return false;
		const tail = bound.tail;
		const activityVersion = bound.stallActivityVersion;
		const canTerminate = () =>
			this.#stillTracked(bound) &&
			this.#current === bound &&
			!bound.retired &&
			bound.statusRecheckAfterStall &&
			tail !== undefined &&
			bound.tail === tail &&
			activityVersion !== undefined &&
			this.#tailActivityVersions.get(tail)?.version === activityVersion;
		if (!canTerminate()) {
			this.#clearStallReconciliation(bound);
			return false;
		}
		const port = this.#manager.port;
		if (!port.terminateHost) {
			if (!bound.stallTerminationWarningLogged) {
				this.#manager.log(
					`stalled_turn_cutoff_unavailable origin=${this.originKey} opRef=${bound.turn.opRef} reason=host_termination_unsupported`,
					"error",
				);
				bound.stallTerminationWarningLogged = true;
			}
			return false;
		}
		let jobs: string | undefined;
		if (port.runningJobs) {
			try {
				const running = await port.runningJobs({ sessionId: bound.sessionId, repo: this.#manager.repo });
				if (running.length > 0)
					jobs = `count=${running.length} jobs=${JSON.stringify(running.map((job) => `${job.type}:${job.id}:${job.label}`))}`;
			} catch (error) {
				jobs = `count=unknown detail=${safeDiagnostic(error)}`;
			}
		}
		if (!canTerminate()) {
			this.#clearStallReconciliation(bound);
			return false;
		}
		const authorizeTermination = async () => {
			if (!canTerminate()) return false;
			try {
				const latest = await this.#statusOf(bound);
				return canTerminate() && latest.status.status !== "unknown" && !isTerminalStatus(latest.status.status);
			} catch {
				// An unreadable final status is not proof that the accepted operation is gone.
				return false;
			}
		};
		const exitOwner = stalledExitOwner(this.#manager.database, {
			opRef: bound.turn.opRef,
			originKey: this.originKey,
			sessionId: bound.sessionId,
			epoch: bound.epoch,
			repo: this.#manager.repo,
		});
		if (!exitOwner) return false;
		let result: TerminateHostOutcome;
		try {
			result = await port.terminateHost({
				sessionId: bound.sessionId,
				repo: this.#manager.repo,
				shouldTerminate: authorizeTermination,
			});
		} catch (error) {
			if (!bound.stallTerminationWarningLogged) {
				this.#manager.log(
					`stalled_turn_cutoff_unavailable origin=${this.originKey} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
					"error",
				);
				bound.stallTerminationWarningLogged = true;
			}
			return false;
		}
		if (result.outcome === "terminating") {
			bound.stallExitOwner ??= exitOwner;
			bound.stallHostTerminating = true;
			if (this.#hostTerminatingSessionId !== bound.sessionId) {
				this.#hostTerminatingSessionId = bound.sessionId;
				this.#manager.log(
					`stalled_turn_host_terminating origin=${this.originKey} opRef=${bound.turn.opRef} session=${bound.sessionId} pid=${result.pid}`,
					"warn",
				);
			}
			this.#scheduleHostTerminationRecheck(bound.sessionId);
			let latest: StatusReport;
			try {
				latest = await this.#statusOf(bound);
			} catch (error) {
				if (!this.#stopped && !this.#manager.stopped) {
					this.#manager.log(
						`stalled_turn_shutdown_status_unavailable origin=${this.originKey} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
						"warn",
					);
					this.#scheduleStatusRecheck(bound);
				}
				return false;
			}
			if (isTerminalStatus(latest.status.status)) {
				await this.#reconcileBound(bound, latest);
				return true;
			}
			this.#scheduleStatusRecheck(bound);
			return false;
		}
		if (result.outcome === "refused" && result.reason === "termination_guard_rejected") {
			if (!canTerminate()) this.#clearStallReconciliation(bound);
			return false;
		}
		if (result.outcome !== "terminated" && result.outcome !== "already_gone") {
			if (!bound.stallTerminationWarningLogged) {
				this.#manager.log(
					`stalled_turn_cutoff_unavailable origin=${this.originKey} opRef=${bound.turn.opRef} outcome=${result.outcome}`,
					"error",
				);
				bound.stallTerminationWarningLogged = true;
			}
			return false;
		}
		// Persist before observer, tail, status or lifecycle cleanup can yield.
		if (!persistStalledExit(this.#manager.database, bound.stallExitOwner ?? exitOwner, result.outcome)) return false;
		const firstHostTermination = !bound.stallHostTerminated;
		bound.stallHostTerminated = true;
		if (this.#observer?.sessionId === bound.sessionId) await this.#closeObserver("host_terminated");
		if (this.#hostSessionId === bound.sessionId) this.#hostSessionId = undefined;
		if (firstHostTermination) {
			this.#manager.hostFreed();
			this.#manager.log(
				`stalled_turn_host_terminated origin=${this.originKey} opRef=${bound.turn.opRef} session=${bound.sessionId} outcome=${result.outcome}`,
				"warn",
			);
		}
		if (firstHostTermination && jobs && result.outcome === "terminated")
			this.#manager.log(
				`stalled_turn_jobs_lost origin=${this.originKey} opRef=${bound.turn.opRef} session=${bound.sessionId} ${jobs}`,
				"warn",
			);
		let latest: StatusReport;
		try {
			latest = await this.#statusOf(bound);
		} catch (error) {
			if (!this.#stopped && !this.#manager.stopped) {
				this.#manager.log(
					`stalled_turn_post_stop_status_unavailable origin=${this.originKey} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
					"warn",
				);
				this.#scheduleStatusRecheck(bound);
			}
			return false;
		}
		if (latest.operationRef !== bound.turn.opRef || isTerminalStatus(latest.status.status)) {
			await this.#reconcileBound(bound, latest);
			return true;
		}
		if (!canTerminate()) return false;
		this.#manager.log(
			`stalled_turn_cutoff origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} session=${bound.sessionId} elapsedMs=${this.#manager.now() - (bound.stallStartedAtMs ?? this.#manager.now())} outcome=${result.outcome} status=${latest.status.status}`,
			"warn",
		);
		await this.#closeTerminatedStalledTurn(bound);
		return true;
	}

	/**
	 * The relay that owned the running turn died. Whatever the host streamed
	 * while it was down is gone (content is best-effort by host contract), so
	 * the turn settles from status and the original result; the handle itself
	 * reopens for commands. A retired hold is left for the status reconcile.
	 */
	async #onRelayLost(
		sessionId: string,
		epoch: number,
		brokerGeneration: number,
		retired: boolean,
		dead: boolean,
	): Promise<void> {
		const bound = this.#findBound(sessionId, epoch, brokerGeneration);
		if (!bound) return;
		if (dead) {
			// The handle closed itself and will not reopen: every later status read
			// goes through the CLI, and a later reconcile may attach a fresh relay
			// for commands. Keeping a closed handle here made status throw forever.
			bound.tail = undefined;
			bound.detached = true;
		}
		if (!bound.tailEvidenceUnavailable) {
			bound.tailEvidenceUnavailable = true;
			this.#manager.log(
				`recovery_hold origin=${this.originKey} epoch=${epoch} opRef=${bound.turn.opRef} reason=${dead ? "relay_dead" : "relay_lost_mid_turn"}`,
				"warn",
			);
			if (retired || bound.retired)
				this.#manager.log(
					`retired_hold originKey=${this.originKey} epoch=${epoch} opRef=${bound.turn.opRef} reason=relay_lost`,
					"warn",
				);
		}
		await this.#reconcileBound(bound);
	}

	#recordStaleOutput(bound: BoundTurn): void {
		const now = this.#manager.now();
		if (bound.staleOutput) {
			bound.staleOutput.count++;
			bound.staleOutput.lastAt = now;
			return;
		}
		bound.staleOutput = { count: 1, firstAt: now, lastAt: now };
		this.#manager.log(
			`stale_output originKey=${this.originKey} epoch=${bound.epoch} session=${bound.sessionId} action=start count=1 first=${new Date(now).toISOString()}`,
			"warn",
		);
	}

	#flushStaleOutput(bound: BoundTurn, reason: string): void {
		const staleOutput = bound.staleOutput;
		if (!staleOutput) return;
		bound.staleOutput = undefined;
		this.#manager.log(
			`stale_output originKey=${this.originKey} epoch=${bound.epoch} session=${bound.sessionId} action=stop count=${staleOutput.count} first=${new Date(staleOutput.firstAt).toISOString()} last=${new Date(staleOutput.lastAt).toISOString()} reason=${reason}`,
			"warn",
		);
	}

	async #onTailFrame(
		sessionId: string,
		epoch: number,
		brokerGeneration: number,
		retired: boolean,
		frame: TailFrame,
	): Promise<void> {
		const bound = this.#findBound(sessionId, epoch, brokerGeneration);
		if (!bound) {
			if (frame.payload.toolCallStarted === true || frame.assistantText)
				this.#manager.log(
					`tail_frame_unbound origin=${this.originKey} epoch=${epoch} session=${sessionId} kind=${frame.rawKind} event=${frame.eventId ?? "unidentified"}`,
					"warn",
				);
			return;
		}
		if ((bound.retired || retired) && !bound.answerWanted) {
			if (frame.assistantText) this.#recordStaleOutput(bound);
		} else {
			// Tail activity after a stall resumes the ordinary live path. If it goes
			// quiet again, the tail will raise another stall and restart status checks.
			if (
				!bound.stallHostTerminated &&
				!bound.stallHostTerminating &&
				(!frame.idle || frame.rawKind === "agent_end" || frame.rawKind === "agent_failed")
			)
				this.#clearStallReconciliation(bound);
			if (frame.assistantText && !frame.steerEcho) bound.lastAssistantText = frame.assistantText;
			if (frame.rawKind === "tool_execution_start" || frame.payload.toolCallStarted === true)
				bound.hadToolActivity = true;
			if (frame.rawKind === "tool_execution_start")
				bound.openTool = {
					name: typeof frame.payload.toolName === "string" ? frame.payload.toolName : "tool",
					startedAtMs: this.#manager.now(),
				};
			else if (frame.rawKind === "tool_execution_end") bound.openTool = undefined;
			const replyVisible = await bound.lifecycle.onFrame?.({ ...bound, frame });
			if (replyVisible === true) bound.replyVisible = true;
			if (!bound.lifecycle.onFrame && frame.assistantText && frame.eventId && !frame.steerEcho) {
				const key = `${sessionId}:${frame.eventId}`;
				if (!this.#deliveredEvents.has(key)) {
					this.#deliveredEvents.add(key);
					await this.#manager.emitAssistant({
						originKey: this.originKey,
						sessionId,
						eventId: frame.eventId,
						deliveryId: deterministicInterimDeliveryId(
							this.originKey,
							bound.turn.triggerMessageId,
							frame.assistantText,
							0,
						),
						text: frame.assistantText,
					});
					bound.replyVisible = true;
				}
			}
		}
		// Only the owned relay's correlated agent_end/agent_failed proves the turn's
		// content stream is complete. The tail admits correlated frames only when
		// they match this turn, but it passes uncorrelated lifecycle ends through as
		// idle broadcasts: those reach every relay on the session, including one that
		// never saw the final message. Like an `idle` activity broadcast, such an end
		// only wakes a status reconcile. Treating it as tail evidence settled the turn
		// with its last mid-work line as the answer (#228).
		const ownedTerminal =
			(frame.rawKind === "agent_end" || frame.rawKind === "agent_failed") &&
			(frame.commandId !== undefined || frame.turnId !== undefined);
		if (ownedTerminal && !bound.tailEvidenceUnavailable) bound.tailTerminalObserved = true;
		if (ownedTerminal || frame.idle) await this.#reconcileBound(bound);
	}

	async #onStall(
		sessionId: string,
		epoch: number,
		brokerGeneration: number,
		retired: boolean,
		elapsedMs: number,
	): Promise<void> {
		const bound = this.#findBound(sessionId, epoch, brokerGeneration);
		if (!bound) return;
		this.#manager.log(`stall_alert originKey=${this.originKey} sessionId=${sessionId} silentMs=${elapsedMs}`, "warn");
		// Observation uncertainty does not retire a turn or revoke its tracking.
		// Keep the same owner on the guarded status/cancellation path.
		if (!bound.retired && !retired) {
			bound.statusRecheckAfterStall = true;
			bound.stallStartedAtMs ??= this.#manager.now();
			bound.stallActivityVersion ??= bound.tail ? this.#tailActivityVersions.get(bound.tail)?.version : undefined;
			try {
				await bound.lifecycle.onStall?.({ ...bound, elapsedMs });
			} catch (error) {
				this.#manager.log(
					`persona_stall_hook_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
					"error",
				);
			}
		}
		if (!bound.retired && !retired && this.#current === bound) {
			// A live tail stall is not proof that the accepted operation failed: the
			// host may still finish it. Reconcile status now, and keep polling while
			// the same silent tail reports it in flight. If that never happens, the
			// operation is cut off only after STALLED_TURN_TERMINAL_TIMEOUT_MS; a
			// resumed tail or terminal status takes the ordinary path instead.
			await this.#reconcileBound(bound);
		}
		if (retired || bound.retired) {
			this.#flushStaleOutput(bound, "stall");
			const tail = bound.tail;
			tail?.setTurnRunning(false);
			await tail?.close();
			bound.tail = undefined;
			bound.detached = true;
			// A reopened retired relay cannot own this turn's content. Keep the
			// accepted turn durable and reconcile it by status without reopening
			// the stream that produced the stale-output flood.
			bound.tailEvidenceUnavailable = true;
			// This discarded turn no longer needs a producer. Terminate its host,
			// but retain the accepted row and never infer terminal status from SIGTERM.
			if (!bound.answerWanted) await this.#terminateRetiredSession(sessionId, "stall", bound);
			this.#manager.log(
				`retired_hold originKey=${this.originKey} epoch=${epoch} opRef=${bound.turn.opRef} reason=stall`,
				"warn",
			);
			this.#holdSweeps.delete(bound.turn.opRef);
			await this.#reconcileBound(bound);
		}
	}

	async #onReverseRequest(
		sessionId: string,
		epoch: number,
		brokerGeneration: number,
		_retired: boolean,
		input: {
			id: string;
			connectionId: string;
			capability: string;
			leaseId: string;
			payload: { method: string; payload: unknown };
		},
		tail: TailHandle,
	): Promise<void> {
		const bound = this.#findBound(sessionId, epoch, brokerGeneration);
		if (!bound || bound.tail !== tail || !this.#manager.onReverseRequest) {
			// Nobody will ever answer this request; tell gjc now instead of leaving its tool call waiting.
			await tail
				.sendReverseResponse({
					id: input.id,
					connectionId: input.connectionId,
					leaseId: input.leaseId,
					error: { code: "unavailable", message: "no bound turn for this reverse request" },
				})
				.catch(() => {});
			return;
		}
		if (input.payload.method === "permission.request") bound.permissionRequestObserved = true;
		// Extract the trigger author ID from the bound turn
		const trigger = this.#manager.database.inbox.turnRow(bound.turn.opRef);
		const triggerAuthorId = trigger?.engagement_json
			? (JSON.parse(trigger.engagement_json) as { authorId?: string }).authorId
			: undefined;
		await this.#manager.onReverseRequest({
			originKey: this.originKey,
			sessionId,
			triggerAuthorId,
			tail,
			input,
		});
	}

	/**
	 * `turn.result` for a bound turn: on the owned relay when it is live, and
	 * on the CLI (the authoritative recovery transport) when the relay is gone,
	 * between reopens, or refuses the read. A transport failure on the relay is
	 * never a verdict about the operation.
	 */
	/** The bound turn's relay while it is attached; reads fall back to the CLI on their own when it tears. */
	#liveRelay(bound: BoundTurn): { relay?: TailHandle } {
		return bound.tail && !bound.detached ? { relay: bound.tail } : {};
	}

	async #statusOf(bound: BoundTurn): Promise<StatusReport> {
		const base = { sessionId: bound.sessionId, repo: this.#manager.repo, opRef: bound.turn.opRef };
		if (!bound.tail || bound.detached) return await this.#manager.port.status(base);
		try {
			return await this.#manager.port.status({ ...base, relay: bound.tail });
		} catch (error) {
			if (!isRelayTransportFailure(error)) throw error;
			this.#manager.log(
				`status_relay_unavailable origin=${this.originKey} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
				"error",
			);
			return await this.#manager.port.status(base);
		}
	}

	async #reconcileBound(bound: BoundTurn, knownReport?: StatusReport): Promise<void> {
		if (this.#stopped || this.#manager.stopped) return;
		if (this.#quarantinedTurn(bound.turn.opRef)) return;
		bound.stallHostTerminated = confirmedStalledExit(this.#manager.database, {
			opRef: bound.turn.opRef,
			originKey: this.originKey,
			sessionId: bound.sessionId,
			epoch: bound.epoch,
			repo: this.#manager.repo,
		});
		let report: StatusReport;
		try {
			report = knownReport ?? (await this.#statusOf(bound));
		} catch (error) {
			if (this.#stopped || this.#manager.stopped) return;
			// Endpoint/registry loss cannot prove producer exit. Only the separately
			// guarded stalled-host termination permits cutoff without native terminal.
			const state = this.#manager.database.inbox.turnRow(bound.turn.opRef)?.turn_state;
			if ((state === "accepted" || state === "bound") && bound.stallHostTerminated) {
				await this.#closeTerminatedStalledTurn(bound);
				return;
			}
			if (await this.#escalateUnresolvedHold(bound.turn, bound)) {
				await this.#dispatchNext();
				return;
			}
			this.#logRecoveryHoldOnce(bound.turn, "status_unavailable", `detail=${safeDiagnostic(error)}`);
			// A turn no relay will announce the end of must not wait for the 60 s
			// sweep after one unreadable status: keep rechecking at the bounded cadence.
			if (bound.tailEvidenceUnavailable || bound.statusRecheckAfterStall) this.#scheduleStatusRecheck(bound);
			return;
		}
		if (this.#stopped || this.#manager.stopped) return;
		if (bound.stallHostTerminated && report.operationRef !== bound.turn.opRef) {
			this.#logRecoveryHoldOnce(bound.turn, "operation_ref_mismatch");
			this.#scheduleStatusRecheck(bound);
			return;
		}
		if (report.status.status === "unknown") {
			const count = (this.#holdSweeps.get(bound.turn.opRef) ?? 0) + 1;
			this.#holdSweeps.set(bound.turn.opRef, count);
			const state = this.#manager.database.inbox.turnRow(bound.turn.opRef)?.turn_state;
			if ((state === "accepted" || state === "bound") && bound.stallHostTerminated) {
				await this.#closeTerminatedStalledTurn(bound);
				return;
			}
			// Neither a missing acknowledgement nor queue/session observations
			// establish non-admission or authorize a new operation identity.
			if (await this.#escalateUnresolvedHold(bound.turn, bound)) {
				await this.#dispatchNext();
				return;
			}
			this.#logRecoveryHoldOnce(bound.turn, "operation_state_unknown", `sweeps=${count}`);
			if (bound.tailEvidenceUnavailable || bound.statusRecheckAfterStall) this.#scheduleStatusRecheck(bound);
			return;
		}
		this.#holdSweeps.delete(bound.turn.opRef);
		if (this.#manager.database.inbox.turnRow(bound.turn.opRef)?.turn_state === "bound")
			this.#manager.database.transaction((tx) => this.#manager.database.inbox.turnAccept(tx, bound.turn.opRef));
		if (!isTerminalStatus(report.status.status)) {
			if (bound.stallHostTerminated) {
				await this.#closeTerminatedStalledTurn(bound);
				return;
			}
			if (
				bound.statusRecheckAfterStall &&
				bound.stallStartedAtMs !== undefined &&
				this.#manager.now() - bound.stallStartedAtMs >= STALLED_TURN_TERMINAL_TIMEOUT_MS &&
				(await this.#terminateStalledTurn(bound))
			)
				return;
			if (bound.detached && !bound.tailEvidenceUnavailable) {
				// A turn the user still wants answered is re-attached like the
				// current one; only a discarded (`/new`) hold is deferred.
				if (bound.retired && !bound.answerWanted) this.#scheduleRetiredReattach(bound);
				else await this.#reattachCurrentTail(bound);
			} else if (bound.tailEvidenceUnavailable || bound.statusRecheckAfterStall) {
				// A lost relay, recovered turn, or live tail stall may not deliver its
				// terminal frame. Poll status at a bounded cadence instead of waiting
				// for the 60 s recovery sweep; a resumed live tail clears the stall flag.
				this.#scheduleStatusRecheck(bound);
			}
			return;
		}
		this.#cancelStatusRecheck(bound);
		if (!bound.tailTerminalObserved && !bound.tailEvidenceUnavailable && bound.statusTerminalHolds < 1) {
			// Status is decidable-terminal but the tail has not shown its terminal
			// frame yet. Tail stays the live authority: hold ONCE and give the
			// attached tail a bounded grace to deliver the evidence. If it still
			// has not by the next reconcile, the tail evidence is genuinely
			// unavailable (post-crash ring loss) and status — the subsession
			// reconcile authority — completes the turn below, corroborated by an
			// explicit log line instead of a silent shortcut.
			bound.statusTerminalHolds += 1;
			this.#logRecoveryHoldOnce(bound.turn, "tail_terminal_evidence_unavailable");
			const timer = this.#manager.schedule(() => {
				this.#graceTimers.delete(timer);
				if (this.#stopped || this.#manager.stopped) return;
				void this.enqueue(async () => {
					if (this.#stopped || this.#manager.stopped || bound.tailTerminalObserved) return;
					// An earlier reconcile (e.g. a refused steer) may already have
					// completed this turn from status; it is no longer tracked then.
					if (this.#current !== bound && !this.#retired.has(retiredKey(bound))) return;
					bound.tailEvidenceUnavailable = true;
					await this.#reconcileBound(bound);
				}).catch((error: unknown) =>
					this.#manager.log(
						`persona_reconcile_grace_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
						"error",
					),
				);
			}, STATUS_TERMINAL_GRACE_MS);
			this.#graceTimers.add(timer);
			return;
		}
		if (!bound.tailTerminalObserved) {
			this.#manager.log(
				`terminal_status_reconciled origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} tail_evidence=unavailable`,
			);
		}
		let failedTurnEvidence: FailedTurnEvidence | undefined;
		let failedTurnEvidenceChecked = false;
		try {
			if ((!bound.retired || bound.answerWanted) && report.status.status === "terminal_ok") {
				// The owned relay is the live authority: its last assistant message
				// for this correlation is the answer. Original operation output is
				// recovery-only, for turns whose relay was lost or never owned.
				const startedAt = report.status.startedAt;
				const notBeforeMs =
					typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : bound.dispatchedAtMs;
				const port = this.#manager.port;
				let text = bound.tailTerminalObserved ? bound.lastAssistantText : undefined;
				if (text === undefined && notBeforeMs !== undefined) {
					const epoch = this.#epoch();
					const generation = this.#manager.brokerGeneration;
					const retired = bound.retired;
					const isCurrent = () =>
						!this.#stopped &&
						!this.#manager.stopped &&
						this.#manager.brokerGeneration === generation &&
						this.#epoch() === epoch &&
						bound.retired === retired &&
						(retired ? this.#retired.get(retiredKey(bound)) === bound : this.#current === bound) &&
						!this.#quarantinedTurn(bound.turn.opRef);
					try {
						const output = await port.fetchWorkerOutput({
							sessionId: bound.sessionId,
							repo: this.#manager.repo,
							opRef: bound.turn.opRef,
							notBeforeMs,
							terminalIdentity: report.status,
							isCurrent,
							...this.#liveRelay(bound),
						});
						if (!isCurrent()) return;
						if (output.status === "proven") text = output.text;
						else
							this.#manager.log(
								`terminal_text_unavailable origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} reason=${output.code}`,
								"warn",
							);
					} catch (error) {
						if (!isCurrent()) return;
						this.#manager.log(
							`terminal_text_unavailable origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} reason=original_result_read_failed detail=${safeDiagnostic(error)}`,
							"error",
						);
					}
				}
				if (text === undefined) {
					this.#logRecoveryHoldOnce(
						bound.turn,
						notBeforeMs === undefined ? "no_turn_floor" : "no_assistant_text_for_terminal",
					);
					if (bound.tailEvidenceUnavailable || bound.statusRecheckAfterStall) this.#scheduleStatusRecheck(bound);
					return;
				}
				await bound.lifecycle.onTerminal?.({ ...bound, text, status: report });
			} else if (!bound.retired || bound.answerWanted) {
				if (bound.agentErrorRetryScheduled) return;
				const openTool = bound.openTool && {
					name: toolLabel(bound.openTool.name),
					elapsedMs: Math.max(0, this.#manager.now() - bound.openTool.startedAtMs),
				};
				const retryEligible =
					isRetryableError(report, !!bound.openTool) &&
					bound.providerRetryAttempt < MAX_AGENT_ERROR_RETRY_ATTEMPTS &&
					this.#canRetryProviderTransport(bound);
				if (retryEligible) {
					failedTurnEvidence = await this.#classifyFailedTurn(bound, report);
					failedTurnEvidenceChecked = true;
				}
				// A saved 402 transcript is a billing/quota failure, not a transient
				// transport error, and a policy refusal answers the same way every time.
				if (
					retryEligible &&
					failedTurnEvidence?.reason !== "provider_quota_exhausted" &&
					failedTurnEvidence?.reason !== "provider_rate_limited" &&
					failedTurnEvidence?.reason !== "provider_refusal"
				) {
					const retryDelayMs = Math.min(
						AGENT_ERROR_RETRY_MAX_MS,
						AGENT_ERROR_RETRY_INITIAL_MS * 2 ** bound.providerRetryAttempt,
					);
					this.#manager.log(
						`agent_error_retry origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} attempt=${bound.providerRetryAttempt + 1}/${MAX_AGENT_ERROR_RETRY_ATTEMPTS} delayMs=${retryDelayMs} type=provider_transport error=${terminalFailureDiagnosis(report)}`,
						"warn",
					);
					// The failed call may not have committed its system preamble to context.
					this.#personaPreamble.delete(bound.sessionId);
					this.#scheduleAgentErrorRetry(bound, retryDelayMs);
					return;
				}
				// Not retryable or retries exhausted: deliver the failure
				this.#manager.log(
					`terminal_failure origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} status=${report.status.status} ${terminalFailureDiagnosis(report)}${openTool ? ` open_tool=${openTool.name} open_tool_elapsed_ms=${openTool.elapsedMs}` : ""}`,
					"error",
				);
				if (!failedTurnEvidenceChecked) failedTurnEvidence = await this.#classifyFailedTurn(bound, report);
				if (this.#submissionRetryable(bound, report, failedTurnEvidence)) {
					await this.#releaseForSubmissionRetry(bound);
					return;
				}
				const recoveredText = await this.#recoverFailedTurnAnswer(bound);
				await bound.lifecycle.onFailure?.({
					...bound,
					error: terminalError(report, openTool, failedTurnEvidence),
					status: report,
					...(recoveredText ? { recoveredText } : {}),
				});
			}
		} catch (error) {
			this.#manager.log(
				`persona_terminal_delivery_failed origin=${this.originKey} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
				"error",
			);
			throw error;
		}
		// Persist the failure notice before settling its trigger. If delivery fails,
		// recovery can retry the same deterministic notice without losing it. Reset
		// completion and its budget are then committed atomically below.
		// A failed turn may never have put its preamble into the context: the next
		// send on this session carries it again.
		if (report.status.status !== "terminal_ok") this.#personaPreamble.delete(bound.sessionId);
		const resetApplied = this.#resetFailedTurn(bound, report, failedTurnEvidence);
		const completed = resetApplied
			? 1
			: this.#manager.database.transaction((tx) => {
					const changed = completeInboundTurn(
						this.#manager.database,
						tx,
						bound.turn.opRef,
						bound.retired && !bound.answerWanted ? "retired" : "no_delivery",
					);
					if (
						changed === 1 &&
						!bound.retired &&
						this.#current === bound &&
						bound.epoch === this.#epoch() &&
						bound.brokerGeneration === this.#manager.brokerGeneration &&
						report.operationRef === bound.turn.opRef &&
						report.status.status === "terminal_ok" &&
						report.status.outcome?.reason === "end_turn" &&
						report.status.receiptState === "present" &&
						report.summaryCompleted &&
						typeof report.status.startedAt === "number" &&
						Number.isFinite(report.status.startedAt) &&
						report.status.startedAt > 0 &&
						typeof report.status.terminalAt === "number" &&
						Number.isFinite(report.status.terminalAt) &&
						report.status.terminalAt >= report.status.startedAt &&
						report.status.terminalAt <= this.#manager.now() &&
						this.#manager.database.bindings.getSessionRecord(this.originKey)?.sessionId === bound.sessionId
					) {
						clearFailedTurnResetCap(this.#manager.database, tx, this.originKey);
						this.#submissionFailures.delete(bound.sessionId);
					}
					return changed;
				});
		// Read the terminal slot from the durable trigger row AFTER completion. A
		// failure diagnostic may have been delivered under another turn identity;
		// only this row's claim satisfies the trigger's answer slot.
		await this.#notifySettled(bound);
		if (completed === 0) return;
		// A steer issued into this turn whose answer tore: try the clientRef one
		// more time now that the turn is over (the runtime still holds the
		// recorded outcome). What stays unresolved is held on this op-ref for
		// the operator - never dispatched as a new turn, never silently dropped.
		for (const held of this.#manager.database.inbox.steersHeld(bound.turn.opRef)) {
			const clientRef = steerClientRef(this.#manager.instanceId, this.originKey, bound.epoch, held.message_id);
			try {
				await this.#manager.port.steer({
					sessionId: bound.sessionId,
					repo: this.#manager.repo,
					text: laneSteerText(held, bound.lifecycle),
					clientRef,
				});
				await this.#finalizeSteerAcceptance(held, bound.epoch, bound.turn.opRef, bound);
			} catch (error) {
				if (isDefinitiveSteerRejection(error)) {
					// Never reached the turn: an ordinary pending message for the next one.
					this.#manager.database.transaction((tx) =>
						this.#manager.database.inbox.steerRefused(tx, held.message_id, bound.turn.opRef),
					);
				} else {
					this.#manager.log(
						`steer_hold origin=${this.originKey} message=${held.message_id} opRef=${bound.turn.opRef} reason=unresolved_at_terminal detail=${safeDiagnostic(error)}`,
						"warn",
					);
				}
			}
		}
		await this.#settleAfterTerminal(bound, resetApplied);
	}

	/**
	 * The last mile of a settled turn: settled hook, tail closed, and either the
	 * retired binding dropped (host ended) or the current binding freed for the
	 * next dispatch. Shared by ordinary terminal delivery and by the
	 * unobserved-answer path, so both settle a turn the same way.
	 */
	async #notifySettled(bound: BoundTurn): Promise<void> {
		const settledTrigger = this.#manager.database.inbox.turnRow(bound.turn.opRef);
		if (settledTrigger?.turn_state !== "done") return;
		try {
			await bound.lifecycle.onSettled?.({
				...bound,
				// A `{"none": reason}` sentinel is not an answer.
				terminalDeliveryId:
					terminalDeliveryIds(settledTrigger.terminal_delivery_id).length > 0
						? settledTrigger.terminal_delivery_id
						: null,
			});
		} catch (error) {
			this.#manager.log(
				`persona_turn_settled_hook_failed origin=${this.originKey} opRef=${bound.turn.opRef} detail=${safeDiagnostic(error)}`,
				"error",
			);
		}
	}

	/**
	 * Decides what trusted preamble one send carries. The persona preamble is
	 * resent only when the session's context may not hold its current text: no
	 * record for the session (first send, new session, gateway restart), changed
	 * text, compacted just now, usage unreadable, usage lower than at the previous
	 * send (compaction or pruning removed history), or the refresh bound reached.
	 * Resending it on every turn grew #회의실 by ~12K tokens per message until
	 * pre-prompt compaction wedged eight turns in a row (2026-09-30).
	 */
	#preambleForSend(
		sessionId: string,
		epoch: number,
		lifecycle: PersonaTurnLifecycle,
		context: PreparedContext,
	): { readonly text?: string; readonly next?: PersonaPreambleState } {
		const persona = lifecycle.systemPreamble;
		if (!persona) return lifecycle.sessionBootstrap ? { text: lifecycle.sessionBootstrap } : {};
		const signature = createHash("sha256").update(persona).digest("hex");
		const contextPercent = context.usage?.percent;
		const previous = this.#personaPreamble.get(sessionId);
		const reason = !previous
			? "first"
			: previous.signature !== signature
				? "changed"
				: context.compacted
					? "compacted"
					: contextPercent === undefined
						? "usage_unknown"
						: contextPercent < previous.contextPercent
							? "context_shrank"
							: previous.sendsSince + 1 >= PERSONA_PREAMBLE_REFRESH_SENDS
								? "refresh"
								: undefined;
		if (reason === undefined && previous && contextPercent !== undefined)
			return {
				...(lifecycle.sessionBootstrap ? { text: lifecycle.sessionBootstrap } : {}),
				next: { signature, contextPercent, sendsSince: previous.sendsSince + 1 },
			};
		this.#manager.log(
			`persona_preamble origin=${this.originKey} epoch=${epoch} session=${sessionId} reason=${reason} context_percent=${contextPercent ?? "unknown"}${previous ? ` previous_percent=${previous.contextPercent}` : ""}`,
		);
		return {
			text: lifecycle.sessionBootstrap ? `${persona}\n\n${lifecycle.sessionBootstrap}` : persona,
			next: { signature, contextPercent: contextPercent ?? 0, sendsSince: 0 },
		};
	}

	/**
	 * Reads the session's context usage on the turn's relay and, at
	 * PERSONA_COMPACTION_TOKENS or more, has gjc compact the session before the
	 * send, so no prompt ever lands on a session gjc would compact first. A
	 * compaction that fails or is unavailable is logged and the send goes ahead:
	 * gjc's own compaction and the wedged-submission reset stay the fallback.
	 */
	async #prepareContext(sessionId: string, epoch: number, opRef: string, tail: TailHandle): Promise<PreparedContext> {
		let usage: SessionContextUsage | undefined;
		try {
			usage = await this.#manager.port.contextUsage?.({ sessionId, repo: this.#manager.repo, relay: tail });
		} catch (error) {
			if (error instanceof BrokerAuthorityError) throw error;
			this.#manager.log(
				`persona_context_unreadable origin=${this.originKey} session=${sessionId} detail=${safeDiagnostic(error)}`,
			);
			return { compacted: false };
		}
		if (!usage || usage.tokens < PERSONA_COMPACTION_TOKENS) return { ...(usage ? { usage } : {}), compacted: false };
		const startedAt = this.#manager.now();
		const { status } = await this.#manager.port.runCompaction({
			sessionId,
			repo: this.#manager.repo,
			originKey: this.originKey,
		});
		this.#manager.log(
			`persona_compaction origin=${this.originKey} epoch=${epoch} session=${sessionId} opRef=${opRef} tokens=${usage.tokens} status=${status} elapsedMs=${this.#manager.now() - startedAt}`,
		);
		return status === "succeeded" ? { compacted: true } : { usage, compacted: false };
	}

	async #settleAfterTerminal(bound: BoundTurn, resetApplied = false): Promise<void> {
		if (this.#observer && this.#observer.epoch !== this.#epoch()) await this.#closeObserver("epoch_changed");
		if (this.#observer?.sessionId === bound.sessionId && (bound.stallHostTerminated || bound.stallHostTerminating))
			await this.#closeObserver("host_terminated");
		this.#clearStallReconciliation(bound);
		this.#cancelStatusRecheck(bound);
		bound.tail?.setTurnRunning(false);
		this.#flushStaleOutput(bound, "terminal");
		this.#clearRetiredReattach(bound);
		const observing =
			!bound.retired &&
			this.#current === bound &&
			bound.epoch === this.#epoch() &&
			!bound.stallHostTerminated &&
			!bound.stallHostTerminating;
		if (observing)
			this.#armObserver(
				bound.sessionId,
				bound.epoch,
				!bound.detached && bound.brokerGeneration === this.#manager.brokerGeneration ? bound.tail : undefined,
				"settled",
			);
		try {
			if (!observing) await bound.tail?.close();
		} catch (error) {
			if (!resetApplied) throw error;
			this.#manager.log(`failed_turn_tail_close_failed origin=${this.originKey} opRef=${bound.turn.opRef}`, "error");
		}
		if (bound.retired) {
			this.#retired.delete(retiredKey(bound));
			this.#clearRetiredReattach(bound);
			if (!bound.stallHostTerminated)
				await this.#terminateRetiredSession(bound.sessionId, "retired_turn_reconciled", bound);
			return;
		}
		if (this.#current === bound) {
			this.#current = undefined;
			this.#state = "idle";
			if (bound.stallHostTerminated) {
				if (this.#hostSessionId === bound.sessionId) this.#hostSessionId = undefined;
			} else if (!bound.stallHostTerminating) this.#touchHost(bound.sessionId);
			await this.#dispatchNext();
			if (!bound.stallHostTerminated && !bound.stallHostTerminating && this.hostIdle) this.#manager.hostFreed();
		}
	}

	/**
	 * A submission-phase failure means the host never started the prompt, so
	 * re-sending it cannot repeat any work. Only the first such failure of a
	 * live turn that showed nothing is retried; a second one is reported.
	 */
	#submissionRetryable(bound: BoundTurn, report: StatusReport, evidence: FailedTurnEvidence | undefined): boolean {
		return (
			report.status.outcome?.phase === "submission" &&
			evidence?.reason !== "provider_quota_exhausted" &&
			evidence?.reason !== "provider_rate_limited" &&
			!bound.retired &&
			this.#current === bound &&
			!bound.replyVisible &&
			bound.lastAssistantText === undefined &&
			!bound.openTool &&
			freshTurnAttempt(this.#manager.database, this.originKey, bound.epoch, bound.turn.triggerMessageId) === 0
		);
	}

	/** Requeues a submission-failed turn on the same session and re-sends it after a pause. */
	async #releaseForSubmissionRetry(bound: BoundTurn): Promise<void> {
		this.#holdSweeps.delete(bound.turn.opRef);
		bound.tail?.setTurnRunning(false);
		this.#flushStaleOutput(bound, "unlanded");
		await bound.tail?.close();
		const attempt = this.#manager.database.transaction((tx) =>
			retryInboundTurn(this.#manager.database, tx, bound.turn.opRef),
		);
		this.#current = undefined;
		this.#state = "idle";
		this.#manager.log(
			`submission_retry origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} session=${bound.sessionId} attempt=${attempt}`,
			"warn",
		);
		await this.#notifyReleased(bound);
		this.#scheduleDispatchRetry(this.#manager.submissionRetryDelayMs);
	}

	/**
	 * Closes a stalled turn only after guarded host termination positively
	 * confirmed producer exit. Registry absence alone never authorizes cutoff.
	 * The original trigger is completed without replay and the owner is notified.
	 */
	async #closeTerminatedStalledTurn(bound: BoundTurn): Promise<void> {
		if (!bound.stallHostTerminated) return;
		const database = this.#manager.database;
		const owner = {
			opRef: bound.turn.opRef,
			originKey: this.originKey,
			sessionId: bound.sessionId,
			epoch: bound.epoch,
			repo: this.#manager.repo,
		};
		// Only a still-open trigger is closed: a repeat call after completion (or
		// after a restart that already closed it) sends no second notice.
		const open = database.inbox.turnRow(bound.turn.opRef);
		if (!open || open.state !== "pending" || (open.turn_state !== "accepted" && open.turn_state !== "bound")) {
			await this.#forgetClosed(bound);
			return;
		}
		if (!confirmedStalledExit(database, owner)) return;
		this.#holdSweeps.delete(bound.turn.opRef);
		bound.tail?.setTurnRunning(false);
		this.#flushStaleOutput(bound, "session_gone");
		await bound.tail?.close();
		const discarded = bound.retired && !bound.answerWanted;
		// The notice is persisted BEFORE the trigger closes. If persisting it
		// throws, the trigger stays open and the next sweep retries the same
		// deterministic notice: a closed turn never silently loses it.
		if (!discarded) {
			const message =
				"the session running this turn produced no terminal event before the stall deadline; the request was not resent";
			try {
				await bound.lifecycle.onFailure?.({
					...bound,
					error: new GjcRuntimeError(`session_unavailable: ${message}`, { code: "session_unavailable", message }),
					forceFailureNotice: true,
				});
			} catch (error) {
				this.#scheduleStatusRecheck(bound);
				throw error;
			}
		}
		// Completion and the rotation away from the dead binding commit together, so
		// a crash between them cannot leave the next message aimed at the dead session.
		// Only the CURRENT turn of the CURRENT epoch rotates: a retired turn or a
		// turn a newer epoch already replaced never tears down the live binding.
		let completed: number;
		try {
			completed = database.transaction((tx) => {
				if (!confirmedStalledExit(database, owner)) throw new Error("stalled exit completion lost its fence");
				const session = database.bindings.getSessionRecord(this.originKey);
				const rotate =
					!bound.retired &&
					this.#current === bound &&
					session?.epoch === bound.epoch &&
					session.sessionId === bound.sessionId;
				const changed = completeInboundTurn(database, tx, bound.turn.opRef, discarded ? "retired" : "turn_failed");
				if (changed === 1 && rotate) database.bindings.rotateEpoch(tx, this.originKey);
				return changed;
			});
		} catch (error) {
			this.#scheduleStatusRecheck(bound);
			throw error;
		}
		for (const held of database.inbox.steersHeld(bound.turn.opRef))
			await this.#abandonHeldSteer(held, bound.turn.opRef, bound);
		this.#manager.log(
			`${discarded ? "retired_turn_closed" : "accepted_turn_closed"} origin=${this.originKey} epoch=${bound.epoch} opRef=${bound.turn.opRef} session=${bound.sessionId} reason=stalled_no_terminal_event`,
		);
		if (completed === 0) {
			await this.#forgetClosed(bound);
			return;
		}
		await this.#notifySettled(bound);
		await this.#settleAfterTerminal(bound);
	}

	/** Drops actor tracking for a turn that is already closed durably, then serves anything queued behind it. */
	async #forgetClosed(bound: BoundTurn): Promise<void> {
		this.#holdSweeps.delete(bound.turn.opRef);
		this.#clearStallReconciliation(bound);
		this.#cancelStatusRecheck(bound);
		if (bound.retired) {
			this.#retired.delete(retiredKey(bound));
			this.#clearRetiredReattach(bound);
		} else if (this.#current === bound) {
			this.#current = undefined;
			this.#state = "idle";
			if (bound.stallHostTerminated) {
				if (this.#hostSessionId === bound.sessionId) this.#hostSessionId = undefined;
			} else if (!bound.stallHostTerminating) this.#touchHost(bound.sessionId);
			await this.#dispatchNext();
			if (!bound.stallHostTerminated && !bound.stallHostTerminating && this.hostIdle) this.#manager.hostFreed();
		}
	}

	/** Best-effort: a presentation hook failing must never keep the origin from re-dispatching. */
	async #notifyReleased(bound: BoundTurn): Promise<void> {
		await this.#releaseLifecycle(bound.lifecycle, bound);
	}

	async #releaseLifecycle(lifecycle: PersonaTurnLifecycle, identity: PersonaTurnIdentity): Promise<void> {
		try {
			await lifecycle.onReleased?.(identity);
		} catch (error) {
			this.#manager.log(
				`persona_release_hook_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
				"error",
			);
		}
	}

	/**
	 * A reopened relay is a fresh connection: the host streams the running
	 * turn's content only to the connection that submitted it, so a reattached
	 * handle carries commands and the stall alarm, never this turn's content.
	 */
	async #reattachCurrentTail(bound: BoundTurn): Promise<void> {
		const tail = await this.#attachTail(bound.sessionId, bound.epoch, false);
		bound.tail = tail;
		bound.brokerGeneration = this.#manager.brokerGeneration;
		bound.detached = false;
		bound.tailEvidenceUnavailable = true;
		tail.beginTurn(bound.turn.opRef);
		tail.setTurnRunning(true);
		// Nothing on this handle will ever announce the turn's end: settle it from
		// status now and on every later sweep instead of waiting for content.
		await this.#reconcileBound(bound);
	}

	#scheduleRetiredReattach(bound: BoundTurn, attempt = 0): void {
		const key = retiredKey(bound);
		if (
			this.#retiredReattachTimers.has(key) ||
			attempt >= RETIRED_REATTACH_MAX_ATTEMPTS ||
			bound.tailEvidenceUnavailable
		)
			return;
		const timer = this.#manager.schedule(() => {
			this.#retiredReattachTimers.delete(key);
			void this.enqueue(async () => {
				if (this.#retired.get(key) !== bound || !bound.detached || bound.tailEvidenceUnavailable) return;
				if (this.#quarantinedTurn(bound.turn.opRef)) return;
				try {
					const tail = await this.#attachTail(bound.sessionId, bound.epoch, true);
					bound.tail = tail;
					bound.brokerGeneration = this.#manager.brokerGeneration;
					bound.detached = false;
					bound.tailEvidenceUnavailable = true;
					tail.beginTurn(bound.turn.opRef);
					tail.setTurnRunning(true);
				} catch (error) {
					if (error instanceof TailCapacityError) {
						this.#scheduleRetiredReattach(bound, attempt + 1);
						return;
					}
					this.#logRecoveryHoldOnce(bound.turn, "retired_tail_reattach_failed", `detail=${safeDiagnostic(error)}`);
					return;
				}
				// A reopened relay never carries the retired turn's content; its
				// terminal is read from status, starting now.
				await this.#reconcileBound(bound);
			}).catch(() => {});
		}, RETIRED_REATTACH_DELAY_MS);
		this.#retiredReattachTimers.set(key, timer);
	}

	#clearRetiredReattach(bound: BoundTurn): void {
		for (const key of [retiredKey(bound), `status:${retiredKey(bound)}`]) {
			const timer = this.#retiredReattachTimers.get(key);
			if (timer !== undefined) this.#manager.cancel(timer);
			this.#retiredReattachTimers.delete(key);
		}
	}

	#clearStallReconciliation(bound: BoundTurn): void {
		if (!bound.statusRecheckAfterStall) return;
		bound.statusRecheckAfterStall = false;
		bound.stallStartedAtMs = undefined;
		bound.stallActivityVersion = undefined;
		bound.stallTerminationWarningLogged = false;
		// Unknown-status sweeps are also the legacy recovery-hold signal checked
		// by the next stall. Resumed activity invalidates that hold as well.
		this.#holdSweeps.delete(bound.turn.opRef);
		if (!bound.tailEvidenceUnavailable) this.#cancelStatusRecheck(bound);
	}

	#cancelStatusRecheck(bound: BoundTurn): void {
		const key = `status:${retiredKey(bound)}`;
		const timer = this.#retiredReattachTimers.get(key);
		if (timer !== undefined) this.#manager.cancel(timer);
		this.#retiredReattachTimers.delete(key);
	}

	#scheduleHostTerminationRecheck(sessionId: string): void {
		const key = `host-termination:${sessionId}`;
		if (this.#retiredReattachTimers.has(key)) return;
		const timer = this.#manager.schedule(() => {
			this.#retiredReattachTimers.delete(key);
			if (this.#stopped || this.#manager.stopped) return;
			void this.enqueue(async () => await this.#reconcileTerminatingHost(sessionId)).catch((error: unknown) =>
				this.#manager.log(
					`persona_host_termination_recheck_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
					"warn",
				),
			);
		}, HOST_TERMINATION_RECHECK_MS);
		this.#retiredReattachTimers.set(key, timer);
	}

	async #reconcileTerminatingHost(sessionId: string): Promise<void> {
		if (this.#hostTerminatingSessionId !== sessionId) return;
		const port = this.#manager.port;
		if (!port.terminateHost) {
			this.#scheduleHostTerminationRecheck(sessionId);
			return;
		}
		// Reset may have retired the signalled turn while its confirmation timer
		// remained pending. Resolve only that captured original, never its successor.
		const bound = [this.#current, ...this.#retired.values()].find((candidate) => {
			const owner = candidate?.stallExitOwner;
			return (
				candidate !== undefined &&
				owner !== undefined &&
				candidate.sessionId === sessionId &&
				owner.sessionId === sessionId &&
				owner.opRef === candidate.turn.opRef &&
				owner.originKey === this.originKey &&
				owner.epoch === candidate.epoch &&
				owner.repo === this.#manager.repo
			);
		});
		const exitOwner = bound?.stallExitOwner;
		let result: TerminateHostOutcome;
		try {
			result = await port.terminateHost({ sessionId, repo: this.#manager.repo });
		} catch {
			this.#scheduleHostTerminationRecheck(sessionId);
			return;
		}
		if (result.outcome !== "terminated" && result.outcome !== "already_gone") {
			this.#scheduleHostTerminationRecheck(sessionId);
			return;
		}
		// No awaited cleanup may precede the durable confirmation.
		if (bound && !persistStalledExit(this.#manager.database, exitOwner, result.outcome)) return;
		if (this.#observer?.sessionId === sessionId) await this.#closeObserver("host_terminated");
		this.#hostTerminatingSessionId = undefined;
		if (this.#hostSessionId === sessionId) this.#hostSessionId = undefined;
		if (bound) {
			bound.stallHostTerminating = false;
			bound.stallHostTerminated = true;
		}
		this.#manager.log(
			`${bound ? "stalled_turn_host_exit_confirmed" : "persona_host_exit_confirmed"} origin=${this.originKey} session=${sessionId} outcome=${result.outcome}`,
			"warn",
		);
		this.#manager.hostFreed();
		if (bound) await this.#reconcileBound(bound);
	}

	/**
	 * Bounded status poll for a lost or stalled tail; one timer per turn, backing off.
	 * An escalated retired hold is never polled this way: its user was already
	 * told, so the periodic sweep alone reads it (#715: 5 s polls ran for hours).
	 */
	#scheduleStatusRecheck(bound: BoundTurn): void {
		const key = `status:${retiredKey(bound)}`;
		if (this.#retiredReattachTimers.has(key)) return;
		if (bound.retired && this.#manager.database.core.metaGet(escalatedHoldKey(bound.turn.opRef)) !== undefined) return;
		const delay = Math.min(STATUS_RECHECK_MAX_MS, STATUS_RECHECK_MIN_MS * 2 ** bound.statusRechecks);
		bound.statusRechecks += 1;
		const timer = this.#manager.schedule(() => {
			this.#retiredReattachTimers.delete(key);
			if (this.#stopped || this.#manager.stopped) return;
			void this.enqueue(async () => {
				if (this.#current !== bound && this.#retired.get(retiredKey(bound)) !== bound) return;
				await this.#reconcileBound(bound);
			}).catch((error: unknown) =>
				this.#manager.log(
					`persona_status_recheck_failed origin=${this.originKey} detail=${safeDiagnostic(error)}`,
					"error",
				),
			);
		}, delay);
		this.#retiredReattachTimers.set(key, timer);
	}

	/**
	 * End an obsolete session host after its final turn is settled, or after a
	 * stalled retired turn is discarded. The latter remains in `#retired` for
	 * status reconciliation, so callers may exclude that one hold while the
	 * same-session guard still protects every other live or retired turn.
	 */
	async #terminateRetiredSession(sessionId: string, reason: string, except?: BoundTurn): Promise<void> {
		const port = this.#manager.port;
		if (!port.terminateHost) return;
		if (except?.retiredHostTerminationAttempted) return;
		if (this.#current?.sessionId === sessionId) return;
		if (this.#manager.database.bindings.getSessionRecord(this.originKey)?.sessionId === sessionId) return;
		for (const other of this.#retired.values()) if (other !== except && other.sessionId === sessionId) return;
		if (except) except.retiredHostTerminationAttempted = true;
		if (this.#hostSessionId === sessionId) this.#hostSessionId = undefined;
		let jobs: string | undefined;
		if (port.runningJobs) {
			try {
				const running = await port.runningJobs({ sessionId, repo: this.#manager.repo });
				if (running.length > 0)
					jobs = `count=${running.length} jobs=${JSON.stringify(running.map((job) => `${job.type}:${job.id}:${job.label}`))}`;
			} catch (error) {
				jobs = `count=unknown detail=${safeDiagnostic(error)}`;
			}
		}
		try {
			const result = await port.terminateHost({ sessionId, repo: this.#manager.repo });
			this.#manager.log(
				`retired_session_host origin=${this.originKey} session=${sessionId} reason=${reason} outcome=${result.outcome}${
					"pid" in result ? ` pid=${result.pid}` : ""
				}${result.outcome === "refused" ? ` detail=${result.reason}` : ""}${
					result.outcome === "not_a_host" ? ` command=${JSON.stringify(result.command)}` : ""
				}`,
				result.outcome === "refused" ? "error" : result.outcome === "not_a_host" ? "warn" : "info",
			);
			if (jobs && result.outcome === "terminated")
				this.#manager.log(
					`retired_session_host_jobs_lost origin=${this.originKey} session=${sessionId} reason=${reason} ${jobs}`,
				);
		} catch (error) {
			this.#manager.log(
				`retired_session_host origin=${this.originKey} session=${sessionId} reason=${reason} outcome=error detail=${safeDiagnostic(error)}`,
				"error",
			);
		}
	}

	#dispatchFloorMs(opRef: string): number | undefined {
		const dispatchedAt = this.#manager.database.inbox.turnDispatchedAt(opRef);
		const at = dispatchedAt ? Date.parse(dispatchedAt) : Number.NaN;
		return Number.isFinite(at) ? at : undefined;
	}

	#findBound(sessionId: string, epoch: number, brokerGeneration: number): BoundTurn | undefined {
		if (
			this.#current?.sessionId === sessionId &&
			this.#current.epoch === epoch &&
			this.#current.brokerGeneration === brokerGeneration
		) {
			return this.#current;
		}
		return [...this.#retired.values()].find(
			(bound) => bound.sessionId === sessionId && bound.epoch === epoch && bound.brokerGeneration === brokerGeneration,
		);
	}

	#epoch(): number {
		return this.#manager.database.bindings.getSessionRecord(this.originKey)?.epoch ?? 0;
	}

	/** Reads only bounded saved-transcript evidence for a current failed turn. */
	async #classifyFailedTurn(bound: BoundTurn, report: StatusReport): Promise<FailedTurnEvidence | undefined> {
		const port = this.#manager.port;
		const startedAt = report.status.startedAt;
		const terminalAt = report.status.terminalAt;
		if (
			report.status.status !== "failed" ||
			report.operationRef !== bound.turn.opRef ||
			bound.retired ||
			this.#current !== bound ||
			bound.epoch !== this.#epoch() ||
			bound.brokerGeneration !== this.#manager.brokerGeneration ||
			!port.failedTurnEvidence ||
			typeof startedAt !== "number" ||
			!Number.isFinite(startedAt) ||
			startedAt <= 0 ||
			typeof terminalAt !== "number" ||
			!Number.isFinite(terminalAt) ||
			terminalAt < startedAt ||
			terminalAt > this.#manager.now() ||
			bound.dispatchedAtMs === undefined ||
			startedAt + TURN_FLOOR_SKEW_MS < bound.dispatchedAtMs
		)
			return undefined;
		try {
			return await port.failedTurnEvidence({
				sessionId: bound.sessionId,
				repo: this.#manager.repo,
				startedAtMs: startedAt,
				terminalAtMs: terminalAt,
			});
		} catch {
			this.#manager.log(`failed_turn_evidence_unavailable origin=${this.originKey} opRef=${bound.turn.opRef}`, "error");
			return undefined;
		}
	}

	/**
	 * Exact context/request failures, a wedged prompt submission and repeated
	 * submission failures reset only the next binding; the failed trigger is
	 * completed, never resent. Quota, rate-limit and policy-refusal failures
	 * never reset: the session is fine, the request (or the account) is not.
	 */
	#resetFailedTurn(bound: BoundTurn, report: StatusReport, evidence: FailedTurnEvidence | undefined): boolean {
		const wedged = isWedgedSubmission(report);
		const reason = wedged ? "submission_wedged" : evidence?.reason;
		if (reason !== undefined)
			this.#manager.log(`failed_turn_classified origin=${this.originKey} opRef=${bound.turn.opRef} reason=${reason}`);
		const { startedAt, terminalAt } = report.status;
		const isSubmissionPhaseFailure = report.status.outcome?.phase === "submission";
		// The SDK reports no startedAt for a prompt that never started (#477), so a
		// submission-phase failure is fenced by its terminalAt instead.
		const turnFloor =
			typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0
				? startedAt
				: isSubmissionPhaseFailure
					? terminalAt
					: undefined;
		if (
			report.status.status !== "failed" ||
			report.operationRef !== bound.turn.opRef ||
			this.#current !== bound ||
			bound.retired ||
			bound.epoch !== this.#epoch() ||
			bound.brokerGeneration !== this.#manager.brokerGeneration ||
			this.#stopped ||
			this.#manager.stopped ||
			typeof terminalAt !== "number" ||
			!Number.isFinite(terminalAt) ||
			typeof turnFloor !== "number" ||
			terminalAt < turnFloor ||
			terminalAt > this.#manager.now() ||
			bound.dispatchedAtMs === undefined ||
			turnFloor + TURN_FLOOR_SKEW_MS < bound.dispatchedAtMs
		)
			return false;
		// A wedged submission never started, so gjc reports no start time; only
		// transcript evidence is tied to the turn's own time window.
		if (
			!wedged &&
			(typeof report.status.startedAt !== "number" ||
				!Number.isFinite(report.status.startedAt) ||
				report.status.startedAt <= 0 ||
				typeof report.status.terminalAt !== "number" ||
				!Number.isFinite(report.status.terminalAt) ||
				report.status.terminalAt < report.status.startedAt ||
				report.status.terminalAt > this.#manager.now() ||
				bound.dispatchedAtMs === undefined ||
				report.status.startedAt + TURN_FLOOR_SKEW_MS < bound.dispatchedAtMs)
		)
			return false;
		if (reason === "provider_quota_exhausted" || reason === "provider_rate_limited" || reason === "provider_refusal") {
			this.#submissionFailures.delete(bound.sessionId);
			return false;
		}
		let repeatedSubmissionFailure = false;
		if (isSubmissionPhaseFailure) {
			const count = Math.min(2, (this.#submissionFailures.get(bound.sessionId) ?? 0) + 1);
			this.#submissionFailures.set(bound.sessionId, count);
			repeatedSubmissionFailure = count >= 2;
		} else this.#submissionFailures.delete(bound.sessionId);
		const resetReason = wedged
			? "submission_wedged"
			: evidence?.reason === "unsupported_input_status" || evidence?.reason === "context_exhausted"
				? evidence.reason
				: repeatedSubmissionFailure
					? "repeated_submission_failure"
					: undefined;
		if (!resetReason) return false;
		const nextEpoch = this.#manager.database.transaction((tx) =>
			resetFailedTurn(this.#manager.database, tx, {
				originKey: this.originKey,
				epoch: bound.epoch,
				sessionId: bound.sessionId,
				opRef: bound.turn.opRef,
				triggerMessageId: bound.turn.triggerMessageId,
				bypassCap: resetReason === "repeated_submission_failure",
			}),
		);
		if (nextEpoch === undefined) {
			if (
				failedTurnResetCapped(this.#manager.database, this.originKey) &&
				!this.#loggedCappedFailedTurnSessions.has(bound.sessionId)
			) {
				this.#loggedCappedFailedTurnSessions.add(bound.sessionId);
				this.#manager.log(
					`failed_turn_reset_capped origin=${this.originKey} epoch=${bound.epoch} session=${bound.sessionId} opRef=${bound.turn.opRef} reason=${resetReason}`,
				);
			}
			return false;
		}
		this.#submissionFailures.delete(bound.sessionId);
		this.#manager.log(
			`session_reset_after_failed_turn origin=${this.originKey} epoch=${bound.epoch} nextEpoch=${nextEpoch} opRef=${bound.turn.opRef} reason=${resetReason}`,
		);
		return true;
	}
}

/**
 * gajae-code reports a prompt the host accepted but never got into the agent as
 * `phase=submission` (no start, no activity). An agent-runtime cause there - e.g.
 * `Timed out waiting for prior agent run to finish before prompting.` while the
 * pre-prompt compaction of a session at gjc's 300K-token ceiling holds the agent -
 * repeats on every later prompt to the same session (2026-09-30: eight in a row
 * over 80 minutes, fixed only by the 3h idle reset). It earns the same one-shot
 * reset as an exhausted context. Provider/transport failures and cancellations
 * stay on their session.
 */
function isWedgedSubmission(report: StatusReport): boolean {
	const outcome = report.status.outcome;
	if (outcome?.phase !== "submission" || outcome.provenance !== "agent_failed" || outcome.category !== "agent_runtime")
		return false;
	return ![report.status.error?.code, outcome.code, outcome.providerCode].includes("aborted");
}

/**
 * A terminal failure carries the runtime's own code, so the delivered notice
 * reads `[turn failed] <code>: <message>` and a rebindable code still earns its
 * `/new` hint. gajae-code redacts the message of a post-start failure down to a
 * fixed sentence (`Agent run failed after execution started.`), so the code is
 * the ENTIRE diagnosis — dropping it here made six distinct lost turns deliver
 * six identical, untriageable lines (#244).
 */
function terminalError(
	status: StatusReport,
	openTool?: { readonly name: string; readonly elapsedMs: number },
	evidence?: FailedTurnEvidence,
): GjcRuntimeError {
	if (evidence?.reason === "provider_rate_limited") {
		// The reset instant rides the line so the owner is told when resending can work.
		const terminalAt = status.status.terminalAt;
		const retryAt =
			evidence.retryAfterMs !== undefined && typeof terminalAt === "number" && Number.isFinite(terminalAt)
				? new Date(terminalAt + evidence.retryAfterMs).toISOString()
				: undefined;
		const message = `model provider rate limit reached${retryAt ? `; retry after ${retryAt}` : ""}`;
		return new GjcRuntimeError(`provider_rate_limited: ${message}`, { code: "provider_rate_limited", message });
	}
	if (evidence?.reason === "provider_quota_exhausted") {
		const message = "model provider quota/billing is exhausted (HTTP 402); switch the model preset";
		return new GjcRuntimeError(`provider_quota_exhausted: ${message}`, {
			code: "provider_quota_exhausted",
			message,
		});
	}
	if (evidence?.reason === "provider_refusal") {
		// The category is the provider's own policy token; the request itself is
		// what was declined, so resending it unchanged would fail the same way.
		const category = evidence.refusalCategory ? ` (${evidence.refusalCategory})` : "";
		const message = `the model provider refused this request under its usage policy${category}; rephrase or narrow the request`;
		return new GjcRuntimeError(`provider_refusal: ${message}`, { code: "provider_refusal", message });
	}
	const failure = status.status.error;
	const outcome = status.status.outcome;
	const code = sanitizeDiagnostic(failure?.code ?? outcome?.code ?? "") || undefined;
	const reported =
		sanitizeDiagnostic(failure?.message ?? outcome?.message ?? "") ||
		// Never empty: a code-only failure still reports the code as its diagnosis,
		// and a failure with neither keeps the gateway's own framing (#14).
		code ||
		sanitizeDiagnostic(`session status ${status.status.status}`);
	// The redacted post-start sentence names no cause. A tool that started and
	// never finished is the one the reader needs (#210: a 300s `op whoami`).
	const message = openTool
		? `${reported} (a ${openTool.name} call had been running for ${Math.round(openTool.elapsedMs / 1000)}s without finishing)`
		: reported;
	return new GjcRuntimeError(`${code ? `${code}: ` : ""}${message}`, {
		...(code ? { code } : {}),
		message,
	});
}

/** The runtime's bounded failure classifiers, for the operator log only. */
function terminalFailureDiagnosis(status: StatusReport): string {
	const outcome = status.status.outcome;
	const failure = status.status.error;
	const fields: [string, string | undefined][] = [
		["code", failure?.code ?? outcome?.code],
		["provider_code", outcome?.providerCode ?? failure?.code],
		["phase", outcome?.phase],
		["category", outcome?.category],
		["provenance", outcome?.provenance],
		["cause", outcome?.failureCauseDiagnostic ?? failure?.message ?? outcome?.message],
	];
	// gajae-code keeps the real failure text only in its local log, keyed by
	// commandId/turnId (`SDK invocation failed`). Without them a redacted
	// `internal: Prompt submission failed.` cannot be joined to its cause.
	const correlation: [string, string | undefined][] = [
		["command", status.status.commandId],
		["turn", status.status.turnId],
	];
	return [
		...fields.map(([name, value]) => `${name}=${(value === undefined ? "" : sanitizeDiagnostic(value)) || "unknown"}`),
		...correlation.flatMap(([name, value]) => {
			const token = value?.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
			return token ? [`${name}=${token}`] : [];
		}),
	].join(" ");
}

/** A tool name bound for a log field and a chat notice: one token, bounded. */
function toolLabel(name: string): string {
	const label = name.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 48);
	return label || "tool";
}

function safeDiagnostic(error: unknown): string {
	return sanitizeDiagnostic(error instanceof Error ? error.message : String(error)) || "sdk_error";
}

/**
 * Whether the status is a post-start provider-transport failure eligible for consideration.
 * Replay safety is checked separately against visible output, tool activity, and accepted steers.
 */
function isRetryableError(status: StatusReport, openTool?: boolean): boolean {
	const outcome = status.status.outcome;
	const category = outcome?.category;

	// Don't retry if a hung tool was detected
	if (openTool) return false;

	// Replay only a transient provider failure; agent_runtime can follow completed side effects.
	return category === "provider_transport" && outcome?.phase === "post_start";
}

/**
 * A steer is injected into a turn that is already reasoning about the trigger.
 * Without framing the model treats the newest text as the whole task and drops
 * the original request (live: answered "답하셈", ignored the question).
 *
 * The header also has to keep the model from FOLDING the steered message into
 * the turn's single final answer: batched messages then all got one late reply
 * instead of an answer to each as it arrived. It therefore asks for the
 * steered message to be answered in its own (mid-work) reply first, and only
 * then to resume the original request. #167 still closes the steer window the
 * moment that reply is consumer-visible, so the next message starts its own
 * turn instead of piling onto this one.
 *
 * In a group room, though, every message of the conversation is steered into
 * the running turn, including people talking to each other. An unconditional
 * "answer this now" took the [SILENT] choice a fresh turn has away from the
 * model, and it answered a remark one human made to another (live, 2026-10-13).
 * A steer that did not address the persona (`directed: false`) is therefore
 * framed as conversation it may answer only when it is meant for it, with the
 * same [SILENT] convention as a normal turn; otherwise the model just continues.
 * The token is offered only as the WHOLE reply: delivery drops any part that
 * contains it, so [SILENT] next to real progress text would swallow that text.
 * The header stays one bracketed line followed by the body in both shapes.
 */
export function renderSteer(body: string, directed = true): string {
	if (!directed)
		return `[Another message in this conversation, received while you were still working on the previous request. It may not be meant for you: people here also talk to each other. If it is meant for you, answer it now in its own reply, then continue the previous request from where you left off; do not fold it into your final answer. If it is not meant for you (people talking among themselves, or addressed to someone else), do not answer it and do not mention it: just continue the previous request, and if you have nothing else to say, reply with exactly [SILENT] and nothing else. Do not restart or repeat what you already said.]\n${body}`;
	return `[Additional message from the user, received while you were still working on their previous request. Answer this message now, in its own reply, then continue the previous request from where you left off. Do not wait until the end and do not fold it into your final answer. Do not restart or repeat what you already said.]\n${body}`;
}

/**
 * Whether a steered chat message addressed the persona: a DM, an explicit
 * mention, or a reply to one of its own messages. A row without engagement
 * metadata (loopback, non-chat sources) is the operator talking to it.
 */
export function steerDirectedAtPersona(row: InboundMessageRow): boolean {
	if (!row.engagement_json) return true;
	const engagement = JSON.parse(row.engagement_json) as {
		readonly group?: boolean;
		readonly mentioned?: boolean;
		readonly replyTo?: { readonly fromSelf?: boolean };
	};
	return engagement.group !== true || engagement.mentioned === true || engagement.replyTo?.fromSelf === true;
}

function laneSteerText(row: InboundMessageRow, lifecycle?: PersonaTurnLifecycle): string {
	if (row.source === "lane_report" && row.message_id.startsWith("agent-run/")) return row.body;
	if (row.source === "lane_report")
		return `[Internal report that arrived while you were working. Absorb it; mention it to the conversation only if useful.]\n\n${row.body}`;
	return renderSteer(lifecycle?.renderSteer?.(row) ?? row.body, steerDirectedAtPersona(row));
}

/**
 * A `turn.steer` the runtime itself answered with `ok:false` (no running turn,
 * rejected text, unknown session) is a decision. A non-zero exit, a torn
 * envelope or a thrown transport error is not: the steer may or may not have
 * been recorded, and only a clientRef replay can tell.
 */
export function isDefinitiveSteerRejection(error: unknown): boolean {
	if (!(error instanceof GjcCliError) || error.exitCode !== 0) return false;
	const details = error.details as { code?: unknown; refused?: unknown } | undefined;
	return (
		details?.refused === true &&
		typeof details.code === "string" &&
		[
			"busy",
			"steer_refused",
			"invalid_params",
			"not_running",
			"no_active_turn",
			"client_ref_conflict",
			"session_not_found",
		].includes(details.code)
	);
}

/**
 * The SDK code carried by an error. gjc reports "the broker no longer serves
 * this session id" as `endpoint_stale` (0.17.x JSON envelopes, `GjcCliError`
 * details) or `not_found`; both mean exactly what the CLI calls
 * `session_unavailable`, so they are classified as that one code. Missing this
 * held every turn on a session a broker restart had dropped: status failed
 * with endpoint_stale forever and the turn was never released.
 */
function sdkStatusErrorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | undefined)?.code;
	const details = (error as { details?: unknown } | undefined)?.details;
	const detailCode = typeof details === "object" && details !== null ? (details as { code?: unknown }).code : undefined;
	const raw =
		typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code)
			? code
			: typeof detailCode === "string" && /^[a-z0-9_.-]{1,64}$/i.test(detailCode)
				? detailCode
				: undefined;
	if (isSessionGoneCode(raw)) return "session_unavailable";
	if (raw) return raw;
	const message = error instanceof Error ? error.message : "";
	return /session_unavailable|endpoint_stale/.test(message) ? "session_unavailable" : undefined;
}

/** Keeps raw platform identifiers in SQLite and derives a safe, fixed-length SDK client reference. */
export function personaTurnOpRef(
	instanceId: string,
	originKey: string,
	epoch: number,
	triggerMessageId: string,
	retryAttempt = 0,
): string {
	const digest = createHash("sha256")
		.update(`${instanceId}|${originKey}|${epoch}|${triggerMessageId}|${retryAttempt}`)
		.digest("hex")
		.slice(0, 32);
	const opRef = `gw-p-${digest}`;
	assertValidOpRef(opRef);
	return opRef;
}

function describeModel(selection: GjcModelSelection | undefined): string {
	return selection === undefined
		? "gjc-default"
		: typeof selection === "string"
			? selection
			: `preset:${selection.preset}`;
}

function sameRecoveryAuthority(left: BrokerSession | undefined, right: BrokerSession | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.sessionId === right.sessionId &&
		left.repo === right.repo &&
		left.stateRoot === right.stateRoot &&
		left.pid === right.pid &&
		left.live === right.live &&
		left.deleted === right.deleted
	);
}

function steerClientRef(instanceId: string, originKey: string, epoch: number, messageId: string): string {
	return `gw-s-${createHash("sha256").update(`${instanceId}|${originKey}|${epoch}|${messageId}`).digest("hex").slice(0, 32)}`;
}

function retiredKey(bound: Pick<BoundTurn, "epoch" | "turn">): string {
	return `${bound.epoch}:${bound.turn.opRef}`;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
	return result;
}
