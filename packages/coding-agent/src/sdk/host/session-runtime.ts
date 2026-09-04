import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { isContinuingMidRunMaintenanceOutcome, ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, ImageContent, Model } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import { AsyncJobManager } from "../../async";
import {
	getProxyRoutableProviders,
	inspectProxyProviderId,
	requiresQualifiedModelProfileRoleResolution,
	resolveProxyMode,
	rewriteSelectorForProxy,
	tryResolveProxyProviderId,
} from "../../config/model-profile-activation";
import { isModelProfileProviderAvailable, projectModelProfileCatalog } from "../../config/model-profile-contract";
import {
	deriveModelProfileMappedProviders,
	type ModelProfileDefinition,
	resolveProfileBindings,
} from "../../config/model-profiles";
import { isAuthenticated, kNoAuth } from "../../config/model-registry";
import { resolveModelChainWithAuth, splitSelectorThinkingSuffix } from "../../config/model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "../../config/model-selector-value";
import { type Settings, validateSettingPatch } from "../../config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensibility/extensions";
import { normalizeGoal } from "../../goals/state";
import type { SdkRunCapability } from "../../session/sdk-run-capability";
import {
	boundTerminalRetentionState,
	findOwnedRegistrationsForTurn,
	isOwnedAttemptRegistrationIncomplete,
	MAX_DURABLE_TERMINAL_RESERVATIONS,
	settleOwnedWork,
} from "../../session/terminal-abort";
import { parseThinkingLevel } from "../../thinking";
import { readEndpointFile } from "../broker/endpoint-authority";
import { ensureBroker } from "../broker/ensure";
import { processIncarnation } from "../broker/process-incarnation";
import {
	type MasterRoleAttestationV2,
	resolveSessionLocator,
	SessionIndex,
	type SessionLocatorV2,
} from "../broker/session-index";
import {
	parseSyntheticModelId,
	resolveSyntheticModelSelection,
	SYNTHETIC_PROVIDER_ID,
	syntheticModelInputError,
	syntheticNamespaceCollision,
} from "../model-profile-model";
import { projectQ10Models } from "../models.js";
import { PromptDeadlineManager, type PromptTerminalTransitionEvidence } from "../prompt-deadline-manager";
import { formatPromptFailureForLocalLog, sanitizePromptFailure } from "../prompt-failure";
import type { SdkPromptTerminalOutcome } from "../prompt-status";
import { validateRequiredPromptText } from "../protocol/adapter-validation";
import { OPERATIONS } from "../protocol/operation-registry";
import { type ReceiptState, reduceReceiptState } from "../receipt-state";
import {
	createKindAwareReconciliation,
	createReconciliationStore,
	type KindAwareReconciliation,
	resolveReconciliationSessionFile,
} from "../reconciliation-extensions";
import {
	reduceTurnResultContent,
	reportableTurnResultContent,
	sanitizeTurnResultContent,
	type TurnResultContent,
} from "../turn-result";
import { type ControlSurface, controlRequestFromFrame, dispatchControl, terminalAbortIdentity } from "./control";
import {
	BROKER_RUNTIME_ABORT_CAPABILITY_FIELD,
	BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD,
	hasBrokerRuntimeAbortCapability,
} from "./control/runtime-gate";
import { SessionSdkHost, type SessionSdkHostOptions } from "./host";
import { clearAutoroutingInactive, isAutoroutingInactive, markAutoroutingInactive } from "./internal-autorouting-state";
import { CursorRegistry, QueryHandlers, RevisionStore, type SessionSurface } from "./query";
import { createSdkRunCapability } from "./sdk-run-capability";
import {
	createSdkCapabilities,
	createSdkSurfacePolicyForContext,
	hasSdkWorkflowGateCapability,
	type SdkCapabilities,
	type SdkSurfacePolicy,
} from "./surface-policy";

import type { BrokerIndexWriter, SdkFrame } from "./types";

const execFileAsync = promisify(execFile);
const sdkControlRequesterContext = new AsyncLocalStorage<string>();

/**
 * Thrown from a serialized durable terminal-scope transaction when the
 * idempotency key is already owned by a DIFFERENT input (scope). After the
 * dispatch cache evicts an in-flight entry, two concurrent requests can both
 * pass the earlier snapshot check; the atomic recheck inside the transaction
 * must reject the second instead of appending a duplicate-key row (review
 * thread P2).
 */
class SdkOnlyIdempotencyConflictError extends Error {
	constructor() {
		super("Idempotency key was reused with different input.");
	}
}

/** Bounded wait for the correlated agent_end lifecycle publication after a
 *  terminal abort settles, before the durable row may claim
 *  `terminalPublished` (review thread P2). The bus runtime needs no such wait:
 *  it publishes the correlated event inline during terminalization and records
 *  the outcome synchronously on its capture slot, while this runtime observes
 *  the publication from the separate `agent_end` handler. */
const SDK_ONLY_TERMINAL_PUBLICATION_WAIT_MS = 1_000;
/** Bounded wait for in-flight workflow gate resolutions to settle during SDK
 *  runtime shutdown before proceeding with cleanup. Unresolved resolutions
 *  after this bound are abandoned — their durable broker state is the recovery
 *  authority, and outcomes are inherently uncertain. */
const GATE_RESOLUTION_QUIESCENCE_MS = 5_000;
/** Master verification fields are ephemeral protocol values, not unbounded input. */
const MASTER_AUTH_VALUE_MAX_LENGTH = 512;
const MASTER_AUTH_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/u;
/** Keep replay protection finite even when an authenticated client floods nonces. */
const MASTER_NONCE_REPLAY_MAX_ENTRIES = 1_024;
/** Verification exchanges complete in seconds; retain replay evidence for a bounded window. */
const MASTER_NONCE_REPLAY_TTL_MS = 5 * 60_000;

export type MasterCapabilityReplayState = Map<string, number>;

export function verifyMasterCapabilityFrame(input: {
	frame: { nonce: unknown; attestationEpoch: unknown; capability: unknown };
	expectedCapability: string | undefined;
	expectedEpoch: string | undefined;
	replay: MasterCapabilityReplayState;
	now?: number;
}): { ok: boolean; nonce: string; attestationEpoch: string } {
	const now = input.now ?? Date.now();
	for (const [consumedNonce, expiresAt] of input.replay) {
		if (expiresAt <= now) input.replay.delete(consumedNonce);
	}
	const bounded = (value: unknown): value is string =>
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MASTER_AUTH_VALUE_MAX_LENGTH &&
		MASTER_AUTH_VALUE_PATTERN.test(value);
	const nonce = bounded(input.frame.nonce) ? input.frame.nonce : "";
	const epoch = bounded(input.frame.attestationEpoch) ? input.frame.attestationEpoch : "";
	const capability = bounded(input.frame.capability) ? input.frame.capability : "";
	const expectedCapability = bounded(input.expectedCapability) ? input.expectedCapability : "";
	const expectedEpoch = bounded(input.expectedEpoch) ? input.expectedEpoch : "";
	const authenticatedFields =
		bounded(input.frame.nonce) &&
		bounded(input.frame.attestationEpoch) &&
		bounded(input.frame.capability) &&
		bounded(input.expectedCapability) &&
		bounded(input.expectedEpoch) &&
		epoch === expectedEpoch;
	const expectedBytes = Buffer.from(expectedCapability);
	const capabilityBytes = Buffer.from(capability);
	const capabilityMatches =
		authenticatedFields &&
		expectedBytes.length === capabilityBytes.length &&
		crypto.timingSafeEqual(expectedBytes, capabilityBytes);
	const reusable = capabilityMatches && !input.replay.has(nonce);
	if (reusable) {
		if (input.replay.size >= MASTER_NONCE_REPLAY_MAX_ENTRIES) {
			const oldest = input.replay.keys().next().value;
			if (typeof oldest === "string") input.replay.delete(oldest);
		}
		input.replay.set(nonce, now + MASTER_NONCE_REPLAY_TTL_MS);
	}
	return {
		ok: reusable,
		nonce,
		attestationEpoch: authenticatedFields ? epoch : "",
	};
}

/** Maximum time a replaced runtime may retain a lifecycle persistence task. */
const LIFECYCLE_QUIESCENCE_MS = 1_000;

class DiffQueryError extends Error {
	constructor(
		readonly code: "not_git_repository" | "diff_too_large",
		message: string,
	) {
		super(message);
	}
}

/** Transport-neutral endpoint contract consumed by the SDK session runtime. */
export interface SessionSdkTransport {
	readonly sessionId: string;
	readonly stateRoot: string;
	readonly token: string;
	sendFrame(
		connectionId: string,
		frame: SdkFrame,
	): void | "written" | "dropped" | Promise<void> | Promise<"written" | "dropped">;
	onFrame(handler: (connectionId: string, frame: SdkFrame) => void): undefined | (() => void);
	onMalformedFrame?(handler: (connectionId: string, message: string) => void): undefined | (() => void);
	start(): Promise<{ url: string }>;
	stop(): Promise<void>;
	broadcastFrame?(frame: SdkFrame): void;
	onConnectionClose?(handler: (connectionId: string) => void): undefined | (() => void);
	onNegotiatedCapabilities?(
		handler: (connectionId: string, capabilities: readonly string[]) => void,
	): undefined | (() => void);
}

export interface SessionSdkRuntimeOptions
	extends Omit<SessionSdkHostOptions, "sessionId" | "stateRoot" | "token" | "sendFrame" | "onFrame"> {
	transport: SessionSdkTransport;
	/** Session settings; enables `config.patch` application on this runtime. */
	settings?: Settings;
	/** Mutable shadow of patched config values merged into query readback. */
	configOverrides?: Map<string, unknown>;
	/** Stable master lineage identity retained across session switches/branches. */
	masterOwnerSessionId?: string;
}

export interface SdkOnlyInvocationRecord extends InvocationCorrelation {
	kind: InvocationKind | "terminal" | "steer";
	clientRef?: string;
	status: InvocationStatus | "dispatching" | "rejected";
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	error?: { code: string; message: string };
	content?: TurnResultContent;
	receiptState?: Exclude<ReceiptState, "absent">;
	outcome?: unknown;
	pendingOutcome?: unknown;
	skillName?: string;
	/** Steer records (origin/dev) carry their own dispatching lifecycle. */
	textDigest?: string;
	createdAt?: number;
	settledAt?: number;
}

export interface SdkOnlyTerminalScopeRecord {
	selection: "turn" | "owned";
	idempotencyKeyHash?: string;
	idempotencyInputHash?: string;
	turnDisposition:
		| "pending"
		| "stopped"
		| "uncertain"
		| "no_effect"
		| "no_effect_reserved"
		| "no_effect_marker_failure";
	terminalPublished?: boolean;
	ownedWorkDisposition: "not_requested" | "left_running" | "stopped" | "uncertain";
	automaticDeliveryDisposition: "enabled" | "none";
	resumeOnOwnedCompletion: boolean;
	turnContinuationFence: {
		state: "retained" | "released";
		abortedAttemptEpoch: number;
		blockedContinuationIds: string[];
		predecessorTombstones: string[];
		ownedCompletionPolicy: "enabled" | "disabled";
	};
	responseState: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash: string;
	replayPayloadHash?: string;
	acceptedAt: number;
	terminalAt?: number;
}

export interface SdkOnlyEvictedTerminalKeyEntry {
	keyHash: string;
	inputHash: string;
	turnDisposition?: "stopped" | "uncertain" | "no_effect" | "no_effect_reserved" | "no_effect_marker_failure";
	ownedWorkDisposition?: "not_requested" | "left_running" | "stopped" | "uncertain";
	responseState?: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash?: string;
	replayPayloadHash?: string;
	terminalPublished?: boolean;
}

export interface SdkOnlyReconciliationStore {
	readonly path: string | null;
	load(): Promise<unknown[]>;
	transact(mutator: (records: SdkOnlyInvocationRecord[]) => SdkOnlyInvocationRecord[]): Promise<void>;
	snapshotTerminalScopes(): SdkOnlyTerminalScopeRecord[];
	snapshotTerminalKeys(): SdkOnlyEvictedTerminalKeyEntry[];
	transactTerminalScopes(
		mutator: (scopes: SdkOnlyTerminalScopeRecord[]) => SdkOnlyTerminalScopeRecord[],
	): Promise<void>;
	transactTerminalState(
		mutator: (state: { scopes: SdkOnlyTerminalScopeRecord[]; keys: SdkOnlyEvictedTerminalKeyEntry[] }) => {
			scopes: SdkOnlyTerminalScopeRecord[];
			keys: SdkOnlyEvictedTerminalKeyEntry[];
		},
	): Promise<void>;
}

export interface SdkOnlyTerminalAbortSeams {
	getReconciliationStore?: () => SdkOnlyReconciliationStore | undefined;
	getTerminalTurnEpoch: () => number | undefined;
	getActivePromptHandle: () => string | undefined;
	/** Re-read the active prompt's owning SDK connection for the owner-mismatch
	 *  recheck; falls back to the runtime-tracked owner when absent (review
	 *  thread P1). */
	getActivePromptOwnerConnectionId?: () => string | undefined;
	cancelPendingPreflightForTerminalAbort: () => void;
	/** Capture the steering admission snapshot at abort ADMISSION (before any
	 *  durable transaction), so steers admitted while the abort is in flight
	 *  classify as post-snapshot (review thread P1). */
	captureTerminalAbortSteeringSnapshot?: () => number | undefined;
	/** Discard the steering snapshot when a replay-only abort never settles
	 *  (review thread P1). */
	discardTerminalAbortSteeringSnapshot?: (token: number) => void;
	/** Rebind the snapshot to the current turn when the requester's turn
	 *  wins the race (review thread P1). */
	rebindTerminalAbortSteeringSnapshot?: (token: number) => void;
	abortPromptAndWaitWithTerminal: (
		handle: string,
		options: {
			graceMs: number;
			terminal?: { scope: "turn" | "owned"; expectedEpoch?: number; steeringSnapshotToken?: number };
		},
	) => Promise<{ status: string; terminalScope?: unknown }>;
	/** Test override for the maximum durable terminal reservation rows. */
	maxDurableTerminalReservationsForTests?: number;
}

/**
 * The transport-neutral SDK session runtime.
 *
 * Concrete transports (including the optional notification/native transport) are
 * injected by the caller. This module owns host construction, control/query
 * dispatch, replay/event publication, and reverse-provider lifecycle without
 * importing any notification adapter or native notification class.
 */
export class SessionSdkSessionRuntime {
	readonly host: SessionSdkHost;
	readonly transport: SessionSdkTransport;
	readonly #connectionDisposer?: () => void;
	readonly #malformedDisposer?: () => void;
	readonly #capabilitiesDisposer?: () => void;
	#transportStarted = false;
	#transportStartPromise?: Promise<{ url: string }>;

	constructor(options: SessionSdkRuntimeOptions) {
		this.transport = options.transport;
		const capabilities = new Map<string, ReadonlySet<string>>();
		this.host = new SessionSdkHost({
			...options,
			connectionCapabilities: options.connectionCapabilities ?? (connectionId => capabilities.get(connectionId)),
			sessionId: options.transport.sessionId,
			stateRoot: options.transport.stateRoot,
			token: options.transport.token,
			sendFrame: (connectionId, frame) => {
				const result = options.transport.sendFrame(connectionId, frame);
				if (result instanceof Promise) return result.then(outcome => outcome ?? "written");
				return result ?? "written";
			},
			onFrame: options.transport.onFrame,
		});
		this.#connectionDisposer = options.transport.onConnectionClose?.(connectionId => {
			capabilities.delete(connectionId);
			this.host.handleDisconnect(connectionId);
		});
		this.#capabilitiesDisposer = options.transport.onNegotiatedCapabilities?.((connectionId, negotiated) => {
			capabilities.set(connectionId, new Set(negotiated));
		});
		this.#malformedDisposer = options.transport.onMalformedFrame?.((connectionId, message) => {
			this.host.handleMalformedFrame(connectionId, message);
		});
	}

	get started(): boolean {
		return this.host.started;
	}

	get generation(): number {
		return this.host.generation;
	}

	getProviderDefinitions(capability: string): unknown | undefined {
		return this.host.getProviderDefinitions(capability);
	}

	emitEvent(frame: SdkFrame): void {
		const eventInput =
			typeof frame.kind === "string"
				? frame
				: { kind: typeof frame.type === "string" ? frame.type : "event", payload: frame };
		const event = this.host.emitEvent(eventInput);
		this.transport.broadcastFrame?.(event);
	}

	publish(frame: SdkFrame): void {
		this.emitEvent(frame);
	}

	async startHost(): Promise<"started" | "already"> {
		return await this.host.start();
	}

	async startTransport(): Promise<{ url: string }> {
		if (this.#transportStarted) throw new Error("SDK transport is already started.");
		if (this.#transportStartPromise) return await this.#transportStartPromise;
		const startPromise = (async () => {
			try {
				const endpoint = await this.transport.start();
				this.#transportStarted = true;
				return endpoint;
			} catch (error) {
				this.#transportStarted = false;
				try {
					await this.transport.stop();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "SDK transport startup failed and cleanup failed.");
				}
				throw error;
			}
		})();
		this.#transportStartPromise = startPromise;
		try {
			return await startPromise;
		} finally {
			if (this.#transportStartPromise === startPromise) this.#transportStartPromise = undefined;
		}
	}

	async start(): Promise<{ url: string }> {
		await this.startHost();
		try {
			return await this.startTransport();
		} catch (error) {
			let hostError: unknown;
			try {
				await this.host.stop();
			} catch (cleanupError) {
				hostError = cleanupError;
			}
			this.host.reverse.dispose();
			this.#transportStarted = false;
			if (hostError !== undefined)
				throw new AggregateError([error, hostError], "SDK runtime startup cleanup failed.");
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.#connectionDisposer?.();
		this.#capabilitiesDisposer?.();
		this.#malformedDisposer?.();
		let hostError: unknown;
		try {
			await this.host.stop();
		} catch (error) {
			hostError = error;
		} finally {
			this.host.reverse.dispose();
		}
		this.#transportStarted = false;
		try {
			await this.transport.stop();
		} catch (error) {
			if (hostError !== undefined) throw new AggregateError([hostError, error], "SDK runtime shutdown failed.");
			throw error;
		}
		if (hostError !== undefined) throw hostError;
	}

	async registerWithBroker(writer: BrokerIndexWriter): Promise<void> {
		await this.host.registerWithBroker(writer);
	}
}

/** Narrow extension-facing factory for the SDK-only session path. */
export interface CreateSdkSessionRuntimeOptions {
	/** Authoritative broker state root for this session's endpoint lifecycle. */
	agentDir: string;
	/** Lifecycle-owned sessions require broker publication before they become usable. */
	brokerRegistrationRequired?: boolean;
	/** Trusted broker-issued lifecycle marker bound to lifecycle host index events. */
	lifecycleRequestId?: string;
	createTransport(input: {
		sessionId: string;
		stateRoot: string;
		token: string;
	}): SessionSdkTransport | Promise<SessionSdkTransport>;
	/** Session settings; enables `config.patch` application on this runtime. */
	settings?: Settings;
	/** Callback for diagnostics and lifecycle request observation. */
	onSdkRequest?: SessionSdkHostOptions["onRequest"];
	/** Mutable shadow of patched config values merged into query readback. */
	configOverrides?: Map<string, unknown>;
	/** In-memory master capability for private broker verification only. */
	masterCapability?: string;
	/** Opaque direct-role epoch this effective host may adopt. */
	masterAttestationEpoch?: string;
	/** Stable master lineage identity retained across session switches/branches. */
	masterOwnerSessionId?: string;
	/** Private session-owned terminal-abort capabilities; never exposed on ExtensionContext. */
	terminalAbortSeams?: SdkOnlyTerminalAbortSeams;
	/** Callback when a frame is admitted to the runtime (test harness). */
	onFrameAdmitted?: () => void;
	/** Test-only observation of a genuinely timed-out lifecycle drain. */
	onLifecycleDrainTimeoutForTests?: () => void;
	/** Test-only observation of bounded failure-diagnostic deduplication state. */
	onFailureDiagnosticKeyCountForTests?: (count: number) => void;
	/** Test-only observation after a resolved invocation completion is reconciled. */
	onInvocationCompletionReconciledForTests?: (kind: InvocationKind, correlation: InvocationCorrelation) => void;
}

function unavailable(operation: string): () => never {
	return () => {
		throw Object.assign(new Error(`${operation} is unavailable without an installed session seam.`), {
			code: "unavailable",
		});
	};
}

export interface InvocationCorrelation {
	commandId: string;
	turnId: string;
}

export type InvocationKind = "prompt" | "skill" | "steer";
type InvocationStatus = "accepted" | "in_flight" | "terminal_ok" | "failed" | "uncertain";
type InvocationOutcome = SdkPromptTerminalOutcome;
type InvocationOutcomeInput = {
	kind: string;
	reason?: unknown;
	code?: unknown;
	message?: unknown;
	provenance?: unknown;
};
const EMPTY_PROMPT_FAILURE = { code: "prompt_failed", message: "Prompt submission failed." } as const;
const PRESERVED_PROVIDER_FAILURE_CODES = new Set([
	"provider_down",
	"provider_unavailable",
	"provider_rejected",
	"upstream_stream_interrupted",
	"argument_validation",
	"execution",
	"upstream_error",
	"transport_reset",
]);
const isPreservedProviderFailure = (code: string | undefined): boolean =>
	code !== undefined && (PRESERVED_PROVIDER_FAILURE_CODES.has(code) || code.startsWith("provider_http_"));

/**
 * Durable reconciliation accepts only the bounded outcome vocabulary from
 * reconciliation-store.ts. Provider diagnostics keep their specific safe code
 * in `error`, while the durable outcome is normalized to the public failure
 * classifier so a failed terminal can never be quarantined on reload.
 */
function canonicalFailedOutcome(
	failure?: { code?: unknown; message?: unknown },
	provenance: "agent_failed" | "deadline" = "agent_failed",
): InvocationOutcome {
	const deadline = provenance === "deadline" || failure?.code === "prompt_deadline_exceeded";
	return {
		kind: "failed",
		code: deadline ? "prompt_deadline_exceeded" : "prompt_failed",
		message: deadline ? "Prompt deadline exceeded." : EMPTY_PROMPT_FAILURE.message,
		provenance: deadline ? "deadline" : "agent_failed",
	};
}

function canonicalTerminalOutcome(
	outcome: unknown,
	failure?: { code?: unknown; message?: unknown },
): InvocationOutcome | undefined {
	if (outcome && typeof outcome === "object") {
		const candidate = outcome as { kind?: unknown; reason?: unknown; provenance?: unknown; code?: unknown };
		if (candidate.kind === "stopped") {
			if (candidate.reason === "cancelled" && candidate.provenance === "client_cancel")
				return { kind: "stopped", reason: "cancelled", provenance: "client_cancel" };
			return undefined;
		}
		if (candidate.kind === "failed")
			return canonicalFailedOutcome(
				{ code: candidate.code, message: (outcome as { message?: unknown }).message },
				candidate.provenance === "deadline" ? "deadline" : "agent_failed",
			);
	}
	if (failure !== undefined) return canonicalFailedOutcome(failure);
	return undefined;
}
interface InvocationRecord extends InvocationCorrelation {
	kind: InvocationKind;
	revision: number;
	clientRef?: string;
	status: InvocationStatus;
	acceptedAt: number;
	deadlineRecoveryPending?: boolean;
	startedAt?: number;
	terminalAt?: number;
	error?: { code: string; message: string };
	content?: TurnResultContent;
	receiptState?: Exclude<ReceiptState, "absent">;
	outcome?: unknown;
}
export interface InvocationReconciliation {
	/** Shared v2 reconciliation owner; present for durable terminal admission. */
	readonly store?: SdkOnlyReconciliationStore;
	admit(kind: InvocationKind, clientRef?: string): void;
	release(kind: InvocationKind, clientRef?: string): void;
	noteAccepted(kind: InvocationKind, correlation: InvocationCorrelation, clientRef?: string): Promise<void>;
	noteTransition(
		kind: InvocationKind,
		correlation: InvocationCorrelation | undefined,
		frame:
			| {
					type: "agent_start" | "agent_end";
					content?: TurnResultContent;
					hasActivity?: boolean;
					outcome?: InvocationOutcome;
			  }
			| { type: "agent_failed"; error: unknown; content?: TurnResultContent; hasActivity?: boolean },
	): Promise<void>;
	lookup(kind: InvocationKind, selector: { commandId?: string; turnId?: string; clientRef?: string }): unknown;
	lookupResult(kind: InvocationKind, selector: { commandId?: string; turnId?: string; clientRef?: string }): unknown;
	listDeadlineRecoveryPendingPrompts(): Array<{
		correlation: InvocationCorrelation;
		acceptedAt: number;
		deadlineMaxAt?: number;
	}>;
	hydrate(): Promise<void>;
	claimPendingOutcome(
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		outcome: InvocationOutcomeInput,
	): Promise<InvocationOutcome>;
	// Positional compatibility (exact-head review P1): the 4th argument is either
	// the generation-fence isCurrent callback or the legacy recordError object;
	// both shapes are normalized in the implementation so a legacy object can
	// never be invoked as a function.
	finalizeOutcome(
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		outcome?: InvocationOutcomeInput,
		arg4?: (() => boolean) | { code: string; message: string },
		// Terminal evidence accepted by finalizeOutcome (exact-head review P1/P2):
		// when an explicit outcome is absent, a content-bearing, activity-bearing,
		// or explicitly stopped finalization is still a successful terminal; only a
		// genuinely empty, no-activity completion fails closed with the sanitized
		// empty-prompt failure. Mirrors the noteTransition evidence predicate.
		arg5?: unknown,
		arg6?: { content?: TurnResultContent; hasActivity?: boolean; outcomeKind?: string },
	): Promise<void>;
	markUncertain(
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		isCurrent?: () => boolean,
		deadlineMaxAt?: number,
	): Promise<void>;
}

export function createInvocationReconciliation(
	options: { stateRoot?: string; sessionId?: string; store?: SdkOnlyReconciliationStore } = {},
): InvocationReconciliation {
	const ACTIVE_CAPACITY = 256;
	const TERMINAL_CAPACITY = 512;
	const records = new Map<string, InvocationRecord>();
	const reservations = new Map<string, InvocationKind>();
	const reservationCounts = new Map<InvocationKind, number>([
		["prompt", 0],
		["skill", 0],
		["steer", 0],
	]);
	const key = (kind: InvocationKind, correlation: InvocationCorrelation) =>
		`${kind}:${correlation.commandId}:${correlation.turnId}`;
	const ref = (kind: InvocationKind, clientRef: string) => `${kind}\\0${clientRef}`;
	if (options.sessionId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.sessionId))
		throw Object.assign(new Error("Unsafe SDK reconciliation session id."), { code: "invalid_input" });
	const store = options.store;
	// Legacy fs-backed path retained for callers that pass stateRoot/sessionId
	// without a store (origin/dev behavior); the store path is authoritative
	// when present (shared v2 reconciliation owner).
	const reconciliationFile =
		options.stateRoot && options.sessionId && !store
			? path.join(options.stateRoot, ".sdk-reconciliation", `${options.sessionId}.json`)
			: undefined;
	let persistenceChain: Promise<void> = Promise.resolve();
	let mutationRevision = 0;
	const pendingFinalizations = new Map<
		string,
		{
			finalizedRecord: InvocationRecord;
			commit: PromiseWithResolvers<void>;
			upgrades: Set<PromiseWithResolvers<void>>;
			errors: unknown[];
		}
	>();
	const persist = async (): Promise<void> => {
		const run = async (): Promise<void> => {
			// Construct the candidate only when this serialized write starts. A
			// pre-await full snapshot lets a later agent_start/agent_end transition
			// be overwritten on disk by an older queued write even though the live
			// map has already converged.
			const snapshot = [...records.values()].map(record => ({ ...record }));
			if (store) {
				await store.transact(current => [
					...current.filter(record => record.kind !== "prompt" && record.kind !== "skill"),
					...snapshot.map(record => ({ ...record })),
				]);
				return;
			}
			if (!reconciliationFile) return;
			const directory = path.dirname(reconciliationFile);
			const temporary = `${reconciliationFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			await fs.writeFile(
				temporary,
				JSON.stringify({ version: 1, sessionId: options.sessionId, records: [...snapshot] }),
				{ encoding: "utf8", mode: 0o600 },
			);
			await fs.chmod(temporary, 0o600);
			await fs.rename(temporary, reconciliationFile);
		};
		const pending = persistenceChain.then(run, run);
		persistenceChain = pending.then(
			() => undefined,
			() => undefined,
		);
		await pending;
	};
	// Retention contract (#4547): terminal records are never age-evicted; only
	// the per-kind oldest-terminal-first capacity trim removes them, so a
	// fire-and-wake consumer can still query the canonical terminal outcome
	// until capacity eviction honestly reports `unknown`.
	const cleanup = (): void => {
		for (const kind of ["prompt", "skill"] as const) {
			const terminal = [...records.entries()]
				.filter(([, record]) => record.kind === kind && record.terminalAt !== undefined)
				.sort(([, left], [, right]) => (left.terminalAt as number) - (right.terminalAt as number));
			for (const [recordKey] of terminal.slice(0, Math.max(0, terminal.length - TERMINAL_CAPACITY)))
				records.delete(recordKey);
		}
	};
	const find = (kind: InvocationKind, selector: { commandId?: string; turnId?: string; clientRef?: string }) => {
		cleanup();
		if (selector.clientRef !== undefined) {
			const reserved = reservations.get(ref(kind, selector.clientRef));
			if (reserved) return undefined;
			return [...records.values()].find(record => record.kind === kind && record.clientRef === selector.clientRef);
		}
		if (selector.commandId === undefined || selector.turnId === undefined) return undefined;
		return records.get(key(kind, { commandId: selector.commandId, turnId: selector.turnId }));
	};
	const hydrate = async (): Promise<void> => {
		if (store) {
			const loaded = (await store.load()) as SdkOnlyInvocationRecord[];
			for (const candidate of loaded) {
				if (candidate.kind !== "prompt" && candidate.kind !== "skill") continue;
				if (!candidate.commandId || !candidate.turnId || typeof candidate.acceptedAt !== "number") continue;
				const kind = candidate.kind as InvocationKind;
				const persistedRevision = (candidate as SdkOnlyInvocationRecord & { revision?: unknown }).revision;
				const record: InvocationRecord = {
					...candidate,
					kind,
					revision: typeof persistedRevision === "number" ? persistedRevision : ++mutationRevision,
				} as InvocationRecord;
				mutationRevision = Math.max(mutationRevision, record.revision);
				// Never re-hydrate a failure reason that could contain provider secrets
				// into a fresh process (origin/dev sanitization preserved).
				if (record.status === "failed") record.error = sanitizePromptFailure(record.error);
				records.set(key(kind, candidate), record);
			}
			cleanup();
			return;
		}
		if (!reconciliationFile) return;
		let raw: string;
		try {
			raw = await fs.readFile(reconciliationFile, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const parsed = JSON.parse(raw) as { version?: unknown; sessionId?: unknown; records?: unknown };
		if (parsed.version !== 1 || parsed.sessionId !== options.sessionId || !Array.isArray(parsed.records))
			throw new Error("Invalid SDK reconciliation store.");
		for (const candidate of parsed.records) {
			if (!candidate || typeof candidate !== "object") continue;
			const record = candidate as InvocationRecord;
			if (
				(record.kind === "prompt" || record.kind === "skill") &&
				typeof record.commandId === "string" &&
				typeof record.turnId === "string" &&
				typeof record.acceptedAt === "number" &&
				(record.status === "accepted" ||
					record.status === "in_flight" ||
					record.status === "terminal_ok" ||
					record.status === "failed")
			) {
				if (
					record.terminalAt === undefined &&
					(record.status === "accepted" || record.status === "in_flight") &&
					!(record as unknown as { deadlineRecoveryPending?: boolean }).deadlineRecoveryPending
				) {
					record.status = "failed";
					record.terminalAt = Date.now();
					record.error = { code: "process_restart", message: "Reconciliation incomplete after process restart." };
				}
				if (record.status === "failed") record.error = sanitizePromptFailure(record.error);
				record.revision = typeof record.revision === "number" ? record.revision : ++mutationRevision;
				mutationRevision = Math.max(mutationRevision, record.revision);
				records.set(key(record.kind, record), { ...record });
			}
		}
		cleanup();
	};
	return {
		store,
		admit(kind, clientRef) {
			cleanup();
			const active = [...records.values()].filter(
				record => record.kind === kind && record.terminalAt === undefined,
			).length;
			const reservedCount = reservationCounts.get(kind) ?? 0;
			if (active + reservedCount >= ACTIVE_CAPACITY)
				throw Object.assign(new Error("Too many active submissions; reconcile or await terminal state."), {
					code: "reconciliation_capacity",
				});
			if (clientRef !== undefined) {
				if (
					reservations.has(ref(kind, clientRef)) ||
					[...records.values()].some(record => record.kind === kind && record.clientRef === clientRef)
				)
					throw Object.assign(
						new Error("A submission with this clientRef is already retained; never reuse a clientRef for retry."),
						{ code: "client_ref_conflict" },
					);
				reservations.set(ref(kind, clientRef), kind);
			}
			reservationCounts.set(kind, reservedCount + 1);
		},
		release(kind, clientRef) {
			if (clientRef !== undefined) reservations.delete(ref(kind, clientRef));
			reservationCounts.set(kind, Math.max(0, (reservationCounts.get(kind) ?? 1) - 1));
		},
		async noteAccepted(kind, correlation, clientRef) {
			const recordKey = key(kind, correlation);
			const acceptedRecord: InvocationRecord = {
				...correlation,
				kind,
				revision: ++mutationRevision,
				...(clientRef === undefined ? {} : { clientRef }),
				status: "accepted",
				acceptedAt: Date.now(),
			};
			records.set(recordKey, acceptedRecord);
			try {
				await persist();
			} catch (error) {
				// Admission is not accepted until its durable record publishes. Roll the
				// provisional in-memory row back so the caller's release() can discharge
				// the still-live reservation without leaving a conflicting clientRef.
				if (records.get(recordKey) === acceptedRecord) records.delete(recordKey);
				throw error;
			}
			if (clientRef !== undefined) reservations.delete(ref(kind, clientRef));
			reservationCounts.set(kind, Math.max(0, (reservationCounts.get(kind) ?? 1) - 1));
		},
		async noteTransition(kind, correlation, frame) {
			if (!correlation) return;
			const recordKey = key(kind, correlation);
			let record = records.get(recordKey);
			if (!record) return;
			const pending = pendingFinalizations.get(recordKey);
			if (pending?.finalizedRecord === record) {
				const upgrade = Promise.withResolvers<void>();
				pending.upgrades.add(upgrade);
				let upgradeError: unknown;
				try {
					try {
						await pending.commit.promise;
					} catch {
						// The deadline write failed; continue against the restored record
						// so a real lifecycle event is never swallowed.
					}
					const current = records.get(recordKey);
					const incomingOutcome = frame.type === "agent_end" ? canonicalTerminalOutcome(frame.outcome) : undefined;
					const providerFailure =
						current?.error !== undefined && current.error.code !== "prompt_deadline_exceeded";
					if (
						current !== undefined &&
						frame.type === "agent_end" &&
						incomingOutcome?.kind === "failed" &&
						incomingOutcome.provenance !== "deadline"
					) {
						const content = reduceTurnResultContent(current.content, frame.content);
						const failed = {
							...current,
							revision: ++mutationRevision,
							status: "failed" as const,
							outcome: incomingOutcome,
							error:
								current.error?.code !== "prompt_deadline_exceeded" && current.error !== undefined
									? current.error
									: { code: incomingOutcome.code, message: incomingOutcome.message },
							content,
							receiptState: reduceReceiptState(
								current.receiptState,
								reportableTurnResultContent(content) ? "present" : undefined,
							),
						};
						delete (failed as unknown as { pendingOutcome?: unknown }).pendingOutcome;
						delete (failed as unknown as { pendingReceiptState?: unknown }).pendingReceiptState;
						records.set(recordKey, failed);
						try {
							await persist();
						} catch (error) {
							if (records.get(recordKey) === failed) records.set(recordKey, current);
							throw error;
						}
						return;
					}
					if (
						frame.type === "agent_end" &&
						current === pending.finalizedRecord &&
						incomingOutcome?.kind !== "failed" &&
						!providerFailure &&
						(kind !== "prompt" ||
							incomingOutcome?.kind === "stopped" ||
							frame.hasActivity === true ||
							frame.content?.text.trim())
					) {
						// A real lifecycle end that arrived during deadline finalization is
						// stronger evidence than the synthetic deadline outcome. Upgrade the
						// durable terminal instead of treating it as a duplicate.
						const content = reduceTurnResultContent(current.content, frame.content);
						const upgraded = {
							...current,
							revision: ++mutationRevision,
							status: "terminal_ok" as const,
							content,
							...(incomingOutcome?.kind === "stopped" ? { outcome: incomingOutcome } : {}),
							receiptState: reduceReceiptState(
								current.receiptState,
								reportableTurnResultContent(content) ? "present" : undefined,
							),
						};
						// Drop the superseded synthetic deadline error so the surfaced payload is
						// not the contradictory {status: terminal_ok, error: prompt_deadline_exceeded}.
						delete (upgraded as Partial<InvocationRecord>).error;
						if (incomingOutcome?.kind !== "stopped") delete (upgraded as Partial<InvocationRecord>).outcome;
						records.set(recordKey, upgraded);
						try {
							await persist();
						} catch (error) {
							// Restore the durable deadline record identity so the lifecycle
							// caller retains ownership and retries instead of clearing the
							// lease after a contradictory in-memory success.
							if (records.get(recordKey) === upgraded) records.set(recordKey, current);
							upgradeError = error;
							pending.errors.push(error);
							throw error;
						}
						return;
					}
					record = current;
					if (!record) return;
				} finally {
					pending.upgrades.delete(upgrade);
					if (upgradeError === undefined) upgrade.resolve();
					else upgrade.reject(upgradeError);
				}
			}
			if (record.terminalAt !== undefined) {
				if (frame.type === "agent_end") {
					const incomingOutcome = canonicalTerminalOutcome(frame.outcome);
					if (incomingOutcome?.kind === "failed" && incomingOutcome.provenance !== "deadline") {
						const content = reduceTurnResultContent(record.content, frame.content);
						const failed = {
							...record,
							revision: ++mutationRevision,
							status: "failed" as const,
							outcome: incomingOutcome,
							error:
								record.error?.code !== "prompt_deadline_exceeded" && record.error !== undefined
									? record.error
									: { code: incomingOutcome.code, message: incomingOutcome.message },
							content,
							receiptState: reduceReceiptState(
								record.receiptState,
								reportableTurnResultContent(content) ? "present" : undefined,
							),
						};
						delete (failed as unknown as { pendingOutcome?: unknown }).pendingOutcome;
						delete (failed as unknown as { pendingReceiptState?: unknown }).pendingReceiptState;
						records.set(recordKey, failed);
						try {
							await persist();
						} catch (error) {
							if (records.get(recordKey) === failed) records.set(recordKey, record);
							throw error;
						}
						return;
					}
				}
				if (frame.type === "agent_failed" && record.error?.code === "prompt_deadline_exceeded") {
					const failure = sanitizePromptFailure(frame.error);
					const next = {
						...record,
						revision: ++mutationRevision,
						status: "failed" as const,
						error: failure,
						outcome: canonicalFailedOutcome(failure),
					};
					delete (next as unknown as { pendingOutcome?: unknown }).pendingOutcome;
					delete (next as unknown as { pendingReceiptState?: unknown }).pendingReceiptState;
					records.set(recordKey, next);
					try {
						await persist();
					} catch (error) {
						if (records.get(recordKey) === next) records.set(recordKey, record);
						throw error;
					}
					return;
				}
				if (frame.type === "agent_end" && record.error?.code !== "prompt_deadline_exceeded") {
					const content = reduceTurnResultContent(record.content, frame.content);
					const receiptState = reduceReceiptState(
						record.receiptState,
						reportableTurnResultContent(content) ? "present" : undefined,
					);
					let outcome = record.outcome;
					const incomingOutcome = canonicalTerminalOutcome(frame.outcome);
					if (outcome === undefined) {
						if (record.status === "failed" && record.error !== undefined)
							outcome = canonicalFailedOutcome(record.error);
						else if (record.status === "terminal_ok" && incomingOutcome?.kind === "stopped")
							outcome = incomingOutcome;
					}
					if (content !== record.content || receiptState !== record.receiptState || outcome !== record.outcome) {
						const enriched = {
							...record,
							revision: ++mutationRevision,
							content,
							receiptState,
							...(outcome === undefined ? {} : { outcome }),
						};
						records.set(recordKey, enriched);
						try {
							await persist();
						} catch (error) {
							if (records.get(recordKey) === enriched) records.set(recordKey, record);
							throw error;
						}
					}
					return;
				}
				if (
					frame.type === "agent_end" &&
					record.error?.code === "prompt_deadline_exceeded" &&
					canonicalTerminalOutcome(frame.outcome)?.kind !== "failed" &&
					(kind !== "prompt" ||
						canonicalTerminalOutcome(frame.outcome)?.kind === "stopped" ||
						frame.hasActivity === true ||
						frame.content?.text.trim())
				) {
					const content = reduceTurnResultContent(record.content, frame.content);
					const incomingOutcome = canonicalTerminalOutcome(frame.outcome);
					const upgraded = {
						...record,
						revision: ++mutationRevision,
						status: "terminal_ok" as const,
						content,
						...(incomingOutcome?.kind === "stopped" ? { outcome: incomingOutcome } : {}),
						receiptState: reduceReceiptState(
							record.receiptState,
							reportableTurnResultContent(content) ? "present" : undefined,
						),
					};
					// The synthetic deadline error is superseded evidence; terminal_ok must not
					// surface a deadline failure for a prompt that actually completed.
					delete (upgraded as Partial<InvocationRecord>).error;
					if (incomingOutcome?.kind !== "stopped") delete (upgraded as Partial<InvocationRecord>).outcome;
					records.set(recordKey, upgraded);
					try {
						await persist();
					} catch (error) {
						if (records.get(recordKey) === upgraded) records.set(recordKey, record);
						throw error;
					}
					return;
				}
				// Same late agent_failed enrichment as the kind-aware bus reconciler: a
				// failure reason may arrive on a different delivery path than the one that
				// claimed the terminal. Enrich the settled record instead of dropping it;
				// never resurrect (status/terminalAt untouched), and first reason wins.
				if (frame.type === "agent_failed") {
					const failure = sanitizePromptFailure(frame.error);
					if (
						record.error !== undefined &&
						!(record.error.code === "agent_failed" && failure.code !== "agent_failed")
					)
						return;
					const next = { ...record, revision: ++mutationRevision };
					logger.error("SDK invocation failed (late)", {
						kind,
						commandId: correlation.commandId,
						turnId: correlation.turnId,
						error: formatPromptFailureForLocalLog(frame.error),
					});
					next.error = failure;
					records.set(recordKey, next);
					try {
						await persist();
					} catch (error) {
						if (records.get(recordKey) === next) records.set(recordKey, record);
						throw error;
					}
				}
				return;
			}
			const next = { ...record, revision: ++mutationRevision };
			delete (next as unknown as { deadlineRecoveryPending?: boolean }).deadlineRecoveryPending;
			delete (next as unknown as { deadlineMaxAt?: number }).deadlineMaxAt;
			if (frame.type === "agent_start") {
				next.status = "in_flight";
				next.startedAt = Date.now();
			} else if (frame.type === "agent_failed") {
				// Failure is diagnostic only; agent_end remains the terminal boundary.
				logger.error("SDK invocation failed", {
					kind,
					commandId: correlation.commandId,
					turnId: correlation.turnId,
					error: formatPromptFailureForLocalLog(frame.error),
				});
				const failure = sanitizePromptFailure(frame.error);
				if (next.error === undefined || (next.error.code === "agent_failed" && failure.code !== "agent_failed"))
					next.error = failure;
			} else {
				const pendingOutcome = (next as unknown as { pendingOutcome?: unknown }).pendingOutcome;
				delete (next as unknown as { pendingOutcome?: unknown }).pendingOutcome;
				delete (next as unknown as { pendingReceiptState?: unknown }).pendingReceiptState;
				next.content = reduceTurnResultContent(next.content, frame.content);
				const incomingOutcome = canonicalTerminalOutcome(frame.outcome) ?? canonicalTerminalOutcome(pendingOutcome);
				if (
					incomingOutcome?.kind === "stopped" &&
					(next.error === undefined || next.error.code === "prompt_deadline_exceeded")
				) {
					next.outcome = incomingOutcome;
					if (next.error?.code === "prompt_deadline_exceeded") delete next.error;
					next.status = "terminal_ok";
				} else if (incomingOutcome?.kind === "failed") {
					next.outcome = incomingOutcome;
					if (next.error === undefined)
						next.error = { code: incomingOutcome.code, message: incomingOutcome.message };
					next.status = "failed";
				} else if (next.error !== undefined) {
					next.outcome = canonicalFailedOutcome(next.error);
					next.status = "failed";
				} else if (
					kind === "prompt" &&
					frame.type === "agent_end" &&
					!frame.content?.text.trim() &&
					!frame.hasActivity
				) {
					next.status = "failed";
					next.error = EMPTY_PROMPT_FAILURE;
					next.outcome = canonicalFailedOutcome(EMPTY_PROMPT_FAILURE);
				} else next.status = "terminal_ok";
				next.receiptState = reduceReceiptState(
					next.receiptState,
					reportableTurnResultContent(next.content) ? "present" : "missing",
				);
				next.terminalAt = Date.now();
			}

			records.set(recordKey, next);
			try {
				await persist();
			} catch (error) {
				if (records.get(recordKey) === next) records.set(recordKey, record);
				throw error;
			}
		},
		lookup(kind, selector) {
			const record = find(kind, selector);
			if (!record) return { status: "unknown", receiptState: "unknown" };
			const identity = {
				commandId: record.commandId,
				turnId: record.turnId,
				...(record.clientRef === undefined ? {} : { clientRef: record.clientRef }),
				acceptedAt: record.acceptedAt,
			};
			if (record.status === "accepted") return { status: "accepted", receiptState: "absent", ...identity };
			if (record.status === "in_flight")
				return { status: "in_flight", receiptState: "absent", ...identity, startedAt: record.startedAt };
			return {
				status: record.status,
				...identity,
				...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
				terminalAt: record.terminalAt,
				receiptState: record.receiptState ?? "unknown",
				...(record.outcome === undefined ? {} : { outcome: record.outcome }),
				...(reportableTurnResultContent(record.content) ? { content: record.content } : {}),
				...(record.error === undefined ? {} : { error: record.error }),
			};
		},
		lookupResult(kind, selector) {
			const result = this.lookup(kind, selector) as Record<string, unknown>;
			return result.status === "unknown" ? result : { kind, ...result };
		},
		listDeadlineRecoveryPendingPrompts() {
			return [...records.values()]
				.filter(
					record =>
						record.kind === "prompt" &&
						record.deadlineRecoveryPending === true &&
						record.terminalAt === undefined,
				)
				.map(record => ({
					correlation: { commandId: record.commandId, turnId: record.turnId },
					acceptedAt: record.acceptedAt,
					...((record as unknown as { deadlineMaxAt?: number }).deadlineMaxAt === undefined
						? {}
						: { deadlineMaxAt: (record as unknown as { deadlineMaxAt: number }).deadlineMaxAt }),
				}));
		},
		hydrate,
		async claimPendingOutcome(kind, correlation, outcome) {
			const record = records.get(key(kind, correlation));
			const normalized = canonicalTerminalOutcome(outcome);
			if (normalized === undefined) throw new Error("Invalid terminal outcome.");
			if (!record || record.terminalAt !== undefined || record.kind !== kind) return normalized;
			const pending = (record as unknown as { pendingOutcome?: unknown }).pendingOutcome;
			if (pending !== undefined) return canonicalTerminalOutcome(pending) ?? normalized;
			const next = { ...record, revision: ++mutationRevision } as InvocationRecord & { pendingOutcome?: unknown };
			next.pendingOutcome = normalized;
			records.set(key(kind, correlation), next);
			try {
				await persist();
			} catch (error) {
				if (records.get(key(kind, correlation)) === next) records.set(key(kind, correlation), record);
				throw error;
			}
			return normalized;
		},
		async finalizeOutcome(
			kind,
			correlation,
			outcome,
			arg4?: (() => boolean) | { code: string; message: string },
			arg5?: unknown,
			arg6?: { content?: TurnResultContent; hasActivity?: boolean; outcomeKind?: string },
		) {
			// Normalize every supported positional form (exact-head review P1):
			//   (…, isCurrent) | (…, recordError) | (…, undefined, recordError) |
			//   (…, isCurrent, recordError)
			const isCurrent = typeof arg4 === "function" ? arg4 : undefined;
			const recordErrorCandidate =
				typeof arg4 === "object" && arg4 !== null && "code" in arg4
					? arg4
					: typeof arg5 === "object" && arg5 !== null && "code" in arg5
						? (arg5 as { code: string; message: string })
						: undefined;
			const recordError = recordErrorCandidate;
			// Terminal evidence may also arrive positionally through arg5 (legacy
			// callers) when it does not carry a recordError shape; normalize it so
			// the empty predicate below sees every evidence channel consistently.
			const legacyEvidenceCandidate =
				typeof arg5 === "object" && arg5 !== null && !("code" in arg5)
					? (arg5 as { content?: TurnResultContent; hasActivity?: boolean; outcomeKind?: string })
					: undefined;
			const evidence = arg6 ?? legacyEvidenceCandidate;
			const recordKey = key(kind, correlation);
			const record = records.get(recordKey);
			if (!record || record.terminalAt !== undefined || record.kind !== kind) return;
			const requestedOutcome = canonicalTerminalOutcome(
				outcome ?? (record as unknown as { pendingOutcome?: unknown }).pendingOutcome,
			);
			const priorFailure = record.error;
			// A provider diagnostic recorded before a deadline finalization is stronger
			// than the synthetic deadline claim. Preserve it as the terminal failure
			// intent instead of allowing a later agent_end to look successful.
			const finalOutcome =
				priorFailure !== undefined && priorFailure.code !== "prompt_deadline_exceeded"
					? canonicalFailedOutcome(priorFailure)
					: requestedOutcome?.kind === "stopped"
						? requestedOutcome
						: priorFailure !== undefined &&
								(requestedOutcome === undefined ||
									(requestedOutcome.kind === "failed" &&
										(requestedOutcome.code === "prompt_deadline_exceeded" ||
											priorFailure.code !== "prompt_deadline_exceeded")))
							? canonicalFailedOutcome(priorFailure)
							: requestedOutcome;
			const previousRecord = { ...record };
			const finalizedRecord: InvocationRecord = { ...record, revision: ++mutationRevision, terminalAt: Date.now() };
			finalizedRecord.content = reduceTurnResultContent(finalizedRecord.content, evidence?.content);
			let resolvedOutcome = finalOutcome;
			if (resolvedOutcome?.kind === "stopped") {
				// Stopped is a successful terminal boundary: it must never coexist with
				// an earlier diagnostic failure.
				finalizedRecord.status = "terminal_ok";
				delete finalizedRecord.error;
			} else if (resolvedOutcome?.kind === "failed") {
				finalizedRecord.status = "failed";
				finalizedRecord.error =
					recordError !== undefined
						? { code: recordError.code, message: recordError.message }
						: priorFailure !== undefined &&
								(resolvedOutcome.code === "prompt_deadline_exceeded" ||
									priorFailure.code !== "prompt_deadline_exceeded")
							? priorFailure
							: { code: resolvedOutcome.code, message: resolvedOutcome.message };
			} else if (kind === "prompt") {
				// Evidence-based empty predicate (exact-head review P1/P2): the same
				// semantics as the noteTransition agent_end classifier. A
				// content-bearing or activity-bearing finalization is successful;
				// only a genuinely empty, no-activity completion fails closed.
				const terminalText = evidence?.content?.text.trim() ?? "";
				if (terminalText === "" && !evidence?.hasActivity && evidence?.outcomeKind !== "stopped") {
					resolvedOutcome = canonicalFailedOutcome(EMPTY_PROMPT_FAILURE);
					finalizedRecord.status = "failed";
					finalizedRecord.error = EMPTY_PROMPT_FAILURE;
				} else finalizedRecord.status = "terminal_ok";
			} else finalizedRecord.status = "terminal_ok";
			finalizedRecord.receiptState = reduceReceiptState(
				finalizedRecord.receiptState,
				reportableTurnResultContent(finalizedRecord.content) ? "present" : "unknown",
			);
			if (resolvedOutcome === undefined) delete finalizedRecord.outcome;
			else finalizedRecord.outcome = resolvedOutcome;
			delete (finalizedRecord as unknown as Record<string, unknown>).pendingOutcome;
			delete (finalizedRecord as unknown as Record<string, unknown>).pendingReceiptState;
			if (isCurrent !== undefined && !isCurrent()) return;
			const commit = Promise.withResolvers<void>();
			// This promise is an internal coordination signal for lifecycle transitions
			// that race finalization. A failed durable commit must still reject racing
			// waiters, but a finalization with no waiter must not create an unhandled
			// rejection in the host process.
			void commit.promise.catch(() => undefined);
			const pending = {
				finalizedRecord,
				commit,
				upgrades: new Set<PromiseWithResolvers<void>>(),
				errors: [] as unknown[],
			};
			pendingFinalizations.set(recordKey, pending);
			records.set(recordKey, finalizedRecord);
			try {
				await persist();
				commit.resolve();
				await Promise.allSettled([...pending.upgrades].map(upgrade => upgrade.promise));
				if (pending.errors.length > 0) throw pending.errors[0];
				if (isCurrent !== undefined && !isCurrent()) {
					const current = records.get(recordKey);
					if (current === finalizedRecord) {
						records.set(recordKey, previousRecord);
						await persist();
					}
				}
			} catch (error) {
				const current = records.get(recordKey);
				if (current === finalizedRecord) records.set(recordKey, previousRecord);
				commit.reject(error);
				throw error;
			} finally {
				if (pendingFinalizations.get(recordKey) === pending) pendingFinalizations.delete(recordKey);
			}
		},
		async markUncertain(kind, correlation, isCurrent, deadlineMaxAt) {
			if (isCurrent !== undefined && !isCurrent()) return;
			const recordKey = key(kind, correlation);
			const record = records.get(recordKey);
			if (!record || record.kind !== kind) return;
			if (record.terminalAt !== undefined && record.error?.code !== "prompt_deadline_exceeded") return;
			const next: InvocationRecord = {
				...record,
				status: record.startedAt === undefined ? "accepted" : "in_flight",
				revision: ++mutationRevision,
			};
			if (isCurrent !== undefined && !isCurrent()) return;
			delete next.terminalAt;
			if (next.error?.code === "prompt_deadline_exceeded" || !isPreservedProviderFailure(next.error?.code))
				delete next.error;
			delete next.receiptState;
			delete (next as unknown as { outcome?: unknown; pendingOutcome?: unknown; pendingReceiptState?: unknown })
				.outcome;
			delete (next as unknown as { pendingOutcome?: unknown }).pendingOutcome;
			delete (next as unknown as { pendingReceiptState?: unknown }).pendingReceiptState;
			(next as unknown as { deadlineRecoveryPending?: boolean }).deadlineRecoveryPending = true;
			if (deadlineMaxAt !== undefined) (next as unknown as { deadlineMaxAt?: number }).deadlineMaxAt = deadlineMaxAt;
			records.set(recordKey, next);
			try {
				await persist();
				if (isCurrent !== undefined && !isCurrent()) {
					const current = records.get(recordKey);
					if (current === next) {
						records.set(recordKey, record);
						await persist();
					}
				}
			} catch (error) {
				if (records.get(recordKey) === next) records.set(recordKey, record);
				throw error;
			}
		},
	};
}

export interface SdkSurfaceFactoryOptions {
	ctx: ExtensionContext;
	id: string;
	api: ExtensionAPI;
	policy?: SdkSurfacePolicy;
	getInstalledDefinitions?: (capability: string) => unknown | undefined;
	getLiveState?: () => { isStreaming: boolean; steeringQueueDepth: number; followupQueueDepth: number };
	configOverrides?: ReadonlyMap<string, unknown>;
	/** Session settings; used for model-usage preferences in profile-limit resolution. */
	settings?: Settings;
	turnResultLookup?: (selector: {
		kind: "prompt" | "skill";
		commandId?: string;
		turnId?: string;
		clientRef?: string;
	}) => unknown;
	steerStatusLookup?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
	hostTools?: boolean | (() => boolean);
	getRuntimeHost?: () => SessionSdkHost | undefined;
}

/** Shared policy, capability, and query-surface factory for every SDK transport. */
export interface SdkSurfaceFactory {
	readonly policy: SdkSurfacePolicy;
	readonly query: SessionSurface;
	getCapabilities(): SdkCapabilities;
}

function createQuerySurface(
	ctx: ExtensionContext,
	id: string,
	api: ExtensionAPI,
	reconciliation: InvocationReconciliation,
	options: {
		policy?: SdkSurfacePolicy;
		getInstalledDefinitions?: (capability: string) => unknown | undefined;
		getLiveState?: () => { isStreaming: boolean; steeringQueueDepth: number; followupQueueDepth: number };
		configOverrides?: ReadonlyMap<string, unknown>;
		/** Session settings; used for model-usage preferences in profile-limit resolution. */
		settings?: Settings;
		turnResultLookup?: (selector: {
			kind: "prompt" | "skill";
			commandId?: string;
			turnId?: string;
			clientRef?: string;
		}) => unknown;
		steerStatusLookup?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
		hostTools?: boolean | (() => boolean);
		getRuntimeHost?: () => SessionSdkHost | undefined;
	} = {},
): SessionSurface {
	const policy =
		options.policy ?? createSdkSurfacePolicyForContext(ctx, hasSdkWorkflowGateCapability(ctx.workflowGate));
	const hasHostTools = (): boolean =>
		typeof options.hostTools === "function" ? options.hostTools() : options.hostTools === true;
	const getLiveState =
		options.getLiveState ??
		(() => {
			const counts = ctx.getPendingMessageCounts();
			return {
				isStreaming: !ctx.isIdle(),
				steeringQueueDepth: counts.steering,
				followupQueueDepth: counts.followUp,
			};
		});
	const metadata = () => ({
		sessionId: id,
		name: ctx.sessionManager.getSessionName(),
		cwd: ctx.cwd,
		kind: ctx.sessionMetadata?.kind ?? "main",
	});
	const lastAssistant = () => {
		const transcript =
			typeof (ctx as Partial<ExtensionContext>).getTranscript === "function" ? ctx.getTranscript() : [];
		for (const entry of transcript.toReversed()) {
			if (entry.role !== "assistant") continue;
			const text =
				typeof entry.body === "string"
					? entry.body
					: entry.content?.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
			if (text !== undefined && text.trim().length > 0) return text;
		}
		return undefined;
	};
	const getProfileCredentialSessionId = () => ctx.credentialSessionId ?? id;
	const profileSettings = (options.settings ?? ctx.settings) as Pick<Settings, "get"> | undefined;
	const getProfileAvailableModels = (): Model<Api>[] => {
		const getAvailableForProfileActivation = ctx.modelRegistry.getAvailableForProfileActivation;
		return typeof getAvailableForProfileActivation === "function"
			? getAvailableForProfileActivation.call(ctx.modelRegistry)
			: ctx.modelRegistry.getAvailable();
	};
	const resolveProfileAvailability = async (
		profile: ModelProfileDefinition,
		authenticatedProviders: ReadonlySet<string>,
	): Promise<{ available: boolean; defaultModel?: Model<Api> }> => {
		if (profile.source !== "user" && inspectProxyProviderId(profileSettings).status === "invalid")
			return { available: false };
		const proxyProvider = profile.source === "user" ? undefined : tryResolveProxyProviderId(profileSettings);
		const proxyAuthenticated = proxyProvider !== undefined && authenticatedProviders.has(proxyProvider);
		const profileAuthenticated = new Set(authenticatedProviders);
		if (proxyAuthenticated) {
			for (const provider of getProxyRoutableProviders(profile)) profileAuthenticated.add(provider);
		}
		const rewriteSelectorProvider = (selector: string): string => {
			const slash = selector.indexOf("/");
			if (slash < 0) return selector;
			const provider = selector.slice(0, slash);
			if (profileAuthenticated.has(provider)) return selector;
			const group = (profile.alternativeProviderGroups ?? []).find(candidates => candidates.includes(provider));
			if (!group) return selector;
			const replacement = group.find(candidate => profileAuthenticated.has(candidate));
			return replacement ? replacement + selector.slice(slash) : selector;
		};
		try {
			const proxyMode = profile.source === "user" ? "fallback" : resolveProxyMode(profileSettings);
			if (profile.source !== "user") {
				const configuredProviders = ctx.modelRegistry.getConfiguredProviderIds?.() ?? [];
				if (proxyProvider !== undefined && !configuredProviders.includes(proxyProvider))
					return { available: false };
			}
			if (profile.source !== "user" && proxyMode === "always") {
				if (
					proxyProvider === undefined ||
					!proxyAuthenticated ||
					!(ctx.modelRegistry.getConfiguredProviderIds?.() ?? []).includes(proxyProvider)
				)
					return { available: false };
			}
			const bindings = resolveProfileBindings(profile);
			const assignments: Array<{ value: ModelSelectorValue; isDefault: boolean }> = [];
			if (bindings.defaultSelector !== undefined) {
				assignments.push({ value: bindings.defaultSelector, isDefault: true });
			}
			for (const value of Object.values(bindings.modelRoles)) assignments.push({ value, isDefault: false });
			for (const value of Object.values(bindings.agentModelOverrides)) assignments.push({ value, isDefault: false });
			const availableModels = getProfileAvailableModels();
			const resolutionRegistry = {
				...ctx.modelRegistry,
				getAvailable: () => availableModels,
				getApiKey: (model: Model<Api>, sessionId?: string) =>
					ctx.modelRegistry.getApiKeyForProvider(model.provider, sessionId, model.baseUrl),
				resolveCanonicalModel: ctx.modelRegistry.resolveCanonicalModel?.bind(ctx.modelRegistry),
				getCanonicalVariants: ctx.modelRegistry.getCanonicalVariants?.bind(ctx.modelRegistry),
				getCanonicalId: ctx.modelRegistry.getCanonicalId?.bind(ctx.modelRegistry),
				resolveModelByLookupAlias: ctx.modelRegistry.resolveModelByLookupAlias?.bind(ctx.modelRegistry),
				lookupAliasExists: ctx.modelRegistry.lookupAliasExists?.bind(ctx.modelRegistry),
				clearCanonicalVariant: ctx.modelRegistry.clearCanonicalVariant?.bind(ctx.modelRegistry),
			};
			let defaultModel: Model<Api> | undefined;
			for (const assignment of assignments) {
				let selectors = normalizeModelSelectorValue(assignment.value).map(rewriteSelectorProvider);
				if (proxyProvider !== undefined && proxyAuthenticated && profile.source !== "user") {
					selectors = selectors.map(selector =>
						rewriteSelectorForProxy(
							selector,
							proxyProvider,
							proxyMode,
							availableModels,
							new Set(authenticatedProviders),
							getProxyRoutableProviders(profile),
						),
					);
				}
				const hasBareSelector = selectors.some(selector => {
					const suffix = splitSelectorThinkingSuffix(selector);
					const identity = suffix.thinkingLevel ? suffix.selector : selector;
					return !identity.includes("/");
				});
				if (!assignment.isDefault && !requiresQualifiedModelProfileRoleResolution(profile) && !hasBareSelector)
					continue;
				const resolution = await resolveModelChainWithAuth(
					selectors,
					resolutionRegistry,
					options.settings,
					getProfileCredentialSessionId(),
					{
						managedFallback: true,
						aliasIntent: "preset-equivalent",
						canonicalSessionId: null,
						credentialSessionId: getProfileCredentialSessionId(),
					},
				);
				if (!resolution.model) return { available: false };
				if (assignment.isDefault) defaultModel = resolution.model;
			}
			return { available: true, defaultModel };
		} catch {
			return { available: false };
		}
	};
	const collectProfileAuthentication = async (
		profiles: ReadonlyMap<string, ModelProfileDefinition>,
	): Promise<Set<string>> => {
		const providers = new Set<string>();
		for (const profile of profiles.values()) {
			for (const provider of profile.requiredProviders) providers.add(provider);
			for (const group of profile.alternativeProviderGroups ?? []) {
				for (const provider of group) providers.add(provider);
			}
			for (const provider of deriveModelProfileMappedProviders(profile)) providers.add(provider);
		}
		const authenticated = new Set<string>();
		await Promise.all(
			[...providers].map(async provider => {
				try {
					const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider, getProfileCredentialSessionId());
					if (apiKey === kNoAuth || isAuthenticated(apiKey)) authenticated.add(provider);
				} catch {
					// A provider whose credential state cannot be read is not currently configurable.
				}
			}),
		);
		const proxyProviders = new Set<string>();
		for (const profile of profiles.values()) {
			if (profile.source === "user") continue;
			const proxyProvider = tryResolveProxyProviderId(profileSettings);
			if (proxyProvider !== undefined) proxyProviders.add(proxyProvider);
		}
		for (const proxyProvider of proxyProviders) {
			try {
				const apiKey = await ctx.modelRegistry.getApiKeyForProvider(proxyProvider, getProfileCredentialSessionId());
				if (apiKey === kNoAuth || isAuthenticated(apiKey)) authenticated.add(proxyProvider);
			} catch {
				// Passive availability must degrade to unavailable when proxy credential
				// refresh/storage fails; explicit activation retains its diagnostics.
			}
		}
		return authenticated;
	};
	const getDiff = async () => {
		try {
			const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff"], {
				cwd: ctx.cwd,
				maxBuffer: 1024 * 1024,
			});
			return stdout
				.split(/^diff --git /m)
				.filter(Boolean)
				.map(section => {
					const header = section.split("\n", 1)[0] ?? "";
					const match = /a\/(.+?) b\/(.+)$/.exec(header);
					return { id: match?.[2] ?? header, path: match?.[2] ?? header, body: `diff --git ${section}` };
				});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
			if (/not a git repository/i.test(`${detail}\n${stderr}`))
				throw new DiffQueryError("not_git_repository", "diff queries require a Git working tree");
			if (/maxbuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/i.test(detail))
				throw new DiffQueryError("diff_too_large", "diff exceeds the 1 MiB query limit");
			throw error;
		}
	};
	const getDurableGoalState = (): { kind: "state"; state: unknown } | { kind: "empty" } | { kind: "unavailable" } => {
		// A recreated SDK host can observe the session before its in-memory goal
		// projection is hydrated. The latest mode_change is the durable authority;
		// never borrow a goal from another session or an older branch.
		let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return { kind: "unavailable" };
		}
		for (const entry of branch.toReversed()) {
			if (entry.type !== "mode_change") continue;
			if (entry.mode !== "goal" && entry.mode !== "goal_paused") return { kind: "empty" };
			const goal = normalizeGoal(entry.data?.goal);
			if (!goal) return { kind: "unavailable" };
			return { kind: "state", state: { enabled: entry.mode === "goal", mode: "active", goal } };
		}
		return { kind: "empty" };
	};
	const getGoalState = (): unknown => {
		const liveState =
			typeof (ctx as Partial<ExtensionContext>).getGoalState === "function" ? ctx.getGoalState() : undefined;
		if (liveState !== undefined) return liveState;
		const durableState = getDurableGoalState();
		if (durableState.kind === "state") return durableState.state;
		if (durableState.kind === "unavailable")
			return {
				enabled: false,
				goal: null,
				reason: "goal_state_unavailable",
				recoverable: true,
				message:
					"The authoritative goal state could not be recovered from this session. Reconnect or resume the session before retrying.",
			};
		return {
			enabled: false,
			goal: null,
			reason: "no_active_goal",
			message:
				"No goal is active in this session: goal mode has not created or resumed a goal, so no goal snapshot exists yet.",
		};
	};
	return {
		getTranscriptEntries: () =>
			typeof (ctx as Partial<ExtensionContext>).getTranscript === "function" ? ctx.getTranscript() : [],
		getContextSnapshot: () => ({
			usage: ctx.getContextUsage(),
			systemPrompt: ctx.getSystemPrompt(),
			...getLiveState(),
		}),
		getGoalState,
		getTodoState: () =>
			typeof (ctx as Partial<ExtensionContext>).getTodoState === "function" ? ctx.getTodoState() : [],
		getDiff,
		getUsage: () => ctx.sessionManager.getUsageStatistics(),
		getModels: async () => {
			const models = ctx.modelRegistry.getAll();
			const currentModel = ctx.model;
			const currentThinkingLevel = api.getThinkingLevel();
			const activeProfile =
				typeof ctx.getActiveModelProfile === "function" ? ctx.getActiveModelProfile() : undefined;
			// A user-defined provider under the reserved logical namespace makes
			// `gajae-code/*` ids ambiguous: selection is rejected, so Q10 must
			// NOT advertise any rows from that namespace (neither the colliding
			// provider's concrete models nor synthetic profiles). The collided
			// provider's rows are filtered out of every degraded projection too,
			// making the documented fail-closed behavior effective.
			const collision = syntheticNamespaceCollision(models, ctx.modelRegistry.getConfiguredProviderIds?.() ?? []);
			const concreteRows = collision ? models.filter(model => model.provider !== SYNTHETIC_PROVIDER_ID) : models;
			// Degraded projection: concrete rows always (minus a collided
			// gajae-code provider), plus a bounded synthetic current readback
			// when a profile marker is active — unless the namespace is collided,
			// in which case no synthetic row (including the active fallback) may
			// appear because selection is rejected.
			const degraded = () =>
				projectQ10Models(
					activeProfile !== undefined && !collision
						? {
								models: concreteRows,
								currentModel,
								currentThinkingLevel,
								profiles: new Map<string, ModelProfileDefinition>(),
								activeProfile,
							}
						: { models: concreteRows, currentModel, currentThinkingLevel },
				);
			let profiles: ReadonlyMap<string, ModelProfileDefinition>;
			try {
				const registryWithProfiles = ctx.modelRegistry as {
					getModelProfiles?: () => ReadonlyMap<string, ModelProfileDefinition>;
				};
				profiles =
					typeof registryWithProfiles.getModelProfiles === "function"
						? registryWithProfiles.getModelProfiles()
						: new Map<string, ModelProfileDefinition>();
			} catch {
				// The profile registry is unreadable: keep the concrete catalog
				// and the active marker readback; never fail the whole Q10 query.
				return degraded();
			}
			if (profiles.size === 0) return degraded();
			// An invalid models configuration must not advertise synthetic rows:
			// the same registry error rejects selection, so Q10 fails closed to
			// the concrete catalog (plus the active-marker readback).
			if (ctx.modelRegistry.getError?.() !== undefined) return degraded();
			if (collision) return degraded();
			let authenticatedProviders: ReadonlySet<string>;
			try {
				authenticatedProviders = await collectProfileAuthentication(profiles);
			} catch {
				// Availability join failed: degrade only the synthetic facade,
				// retain concrete rows and the active marker readback.
				return degraded();
			}
			const resolvedDefaultModels = new Map<string, Model<Api>>();
			const fullyResolvedProfiles = new Set<string>();
			await Promise.all(
				[...profiles.entries()].map(async ([name, profile]) => {
					const result = await resolveProfileAvailability(profile, authenticatedProviders);
					if (!result.available) return;
					fullyResolvedProfiles.add(name);
					if (result.defaultModel) resolvedDefaultModels.set(name, result.defaultModel);
				}),
			);
			const availableProfileIds = new Set<string>();
			for (const [name, profile] of profiles) {
				if (profile.source !== "user" && inspectProxyProviderId(profileSettings).status === "invalid") continue;
				const profileAuthenticated = new Set(authenticatedProviders);
				const proxyProvider = profile.source === "user" ? undefined : tryResolveProxyProviderId(profileSettings);
				if (proxyProvider !== undefined && profileAuthenticated.has(proxyProvider))
					for (const provider of getProxyRoutableProviders(profile)) profileAuthenticated.add(provider);
				if (!isModelProfileProviderAvailable(profile, profileAuthenticated)) continue;
				if (!fullyResolvedProfiles.has(name)) continue;
				// A profile with a default mapping is selectable only when its
				// default chain actually resolves to an authenticated model:
				// activation rejects unresolvable defaults even when the
				// required providers are authenticated. Role-only profiles
				// (no default) remain selectable.
				if (profile.modelMapping.default !== undefined && !resolvedDefaultModels.has(name)) continue;
				availableProfileIds.add(name);
			}
			const resolveProfileDefaultModel = (profile: ModelProfileDefinition) =>
				resolvedDefaultModels.get(profile.name);
			return projectQ10Models({
				models,
				currentModel,
				currentThinkingLevel,
				profiles,
				availableProfileIds,
				activeProfile,
				resolveProfileDefaultModel,
			});
		},
		getSkillState: () => ctx.getSkillState(),
		getGates: () => {
			const workflowGate = ctx.workflowGate;
			if (!workflowGate) return [];
			return (
				workflowGate.listWorkflowGateQueryRecords?.() ??
				workflowGate.listPendingGates?.().map(gate => ({
					...gate,
					id: `pending:${gate.gate_id}`,
					tag: "pending" as const,
				})) ??
				[]
			);
		},
		getConfigItems: () => {
			const items = ctx.getConfigItems();
			return items && typeof items === "object" && !Array.isArray(items)
				? { ...(items as Record<string, unknown>), ...Object.fromEntries(options.configOverrides ?? []) }
				: items;
		},
		getSessionMetadata: metadata,
		getStats: () => ctx.sessionManager.getUsageStatistics(),
		getBranchCandidates: () => ctx.getBranchCandidates(),
		getLastAssistant: lastAssistant,
		getCapabilities: () => createSdkCapabilities(policy, hasHostTools()),
		getAuthProviders: () => [...new Set(ctx.modelRegistry.getAll().map(model => model.provider))],
		getActiveProviders: () => ctx.modelRegistry.getActiveProviders(),
		getTools: () => {
			const tools = typeof (ctx as Partial<ExtensionContext>).getAllTools === "function" ? ctx.getAllTools() : [];
			return tools.length > 0 ? tools : (options.getInstalledDefinitions?.("host_tools") ?? []);
		},
		getQueueMessages: () => ctx.getQueuedMessages(),
		getExtensions: () => ctx.getExtensions(),
		getArtifactRange: (artifactId, offset, length) => ctx.getArtifactRange?.(artifactId, offset, length),
		getJobs: () => ctx.getJobs(),
		getPromptStatus: (selector: { commandId?: string; turnId?: string; clientRef?: string }) =>
			reconciliation.lookup("prompt", selector),
		getSkillInvokeStatus: (selector: { commandId?: string; turnId?: string; clientRef?: string }) =>
			reconciliation.lookup("skill", selector),
		getTurnResult: (selector: {
			kind: "prompt" | "skill";
			commandId?: string;
			turnId?: string;
			clientRef?: string;
		}) => (options.turnResultLookup ?? (value => reconciliation.lookupResult(value.kind, value)))(selector),
		getCheckpointSnapshot: () => {
			const host = options.getRuntimeHost?.();
			if (!host)
				throw Object.assign(new Error("Atomic session checkpoint capture is unavailable."), {
					code: "unavailable",
				});
			const entries =
				typeof (ctx as Partial<ExtensionContext>).getTranscript === "function" ? ctx.getTranscript() : undefined;
			if (!Array.isArray(entries))
				throw Object.assign(new Error("Atomic session checkpoint capture is unavailable."), {
					code: "unavailable",
				});
			return {
				entries,
				watermark: {
					revision: entries.length,
					generation: host.events.generation,
					seq: host.events.sequence,
					idle: ctx.isIdle(),
				},
			};
		},
		getSteerStatus: (selector: { commandId?: string; turnId?: string; clientRef?: string }) =>
			(options.steerStatusLookup ?? (value => reconciliation.lookup("steer", value)))(selector),
		getModelProfiles: async () => {
			const profiles = ctx.modelRegistry.getModelProfiles();
			const authenticatedProviders = await collectProfileAuthentication(profiles);
			return (await Promise.all(
				projectModelProfileCatalog(profiles, ctx.modelRegistry.getError()).map(async item => {
					const profile = profiles.get(item.id)!;
					const profileAuthenticated = new Set(authenticatedProviders);
					const proxyProvider = profile.source === "user" ? undefined : tryResolveProxyProviderId(profileSettings);
					if (proxyProvider !== undefined && profileAuthenticated.has(proxyProvider))
						for (const provider of getProxyRoutableProviders(profile)) profileAuthenticated.add(provider);
					const available =
						isModelProfileProviderAvailable(profile, profileAuthenticated) &&
						(await resolveProfileAvailability(profile, authenticatedProviders)).available;
					return { ...item, available };
				}),
			)) as unknown[];
		},
		installedQueries: policy.installedQueries,
	};
}

/**
 * Build the transport-neutral SDK policy/capability/query bundle. Native and
 * loopback transports must use this entry point so their advertised surface,
 * query handlers, and error behavior cannot drift.
 */
export function createSdkSurfaceFactory(
	options: SdkSurfaceFactoryOptions & { reconciliation?: InvocationReconciliation },
): SdkSurfaceFactory {
	const policy =
		options.policy ??
		createSdkSurfacePolicyForContext(options.ctx, hasSdkWorkflowGateCapability(options.ctx.workflowGate));
	const reconciliation =
		options.reconciliation ??
		createInvocationReconciliation({
			stateRoot: undefined,
			sessionId: undefined,
		});
	const query = createQuerySurface(options.ctx, options.id, options.api, reconciliation, {
		policy,
		getInstalledDefinitions: options.getInstalledDefinitions,
		getLiveState: options.getLiveState,
		configOverrides: options.configOverrides,
		settings: options.settings,
		turnResultLookup: options.turnResultLookup,
		steerStatusLookup: options.steerStatusLookup,
		hostTools: options.hostTools,
		getRuntimeHost: options.getRuntimeHost,
	});
	return {
		policy,
		query,
		getCapabilities: () => query.getCapabilities() as SdkCapabilities,
	};
}

function captureConfigOverridesShadow(settings: Settings, configOverrides: Map<string, unknown>): Map<string, unknown> {
	const before = new Map<string, unknown>();
	for (const key of configOverrides.keys()) {
		try {
			before.set(key, settings.get(key as never));
		} catch {
			before.set(key, undefined);
		}
	}
	return before;
}

function reconcileConfigOverridesShadow(
	settings: Settings,
	configOverrides: Map<string, unknown>,
	before: ReadonlyMap<string, unknown>,
): void {
	for (const [key, prior] of before) {
		let current: unknown;
		try {
			current = settings.get(key as never);
		} catch {
			current = undefined;
		}
		if (!deepStructuralEqual(current, prior)) configOverrides.delete(key);
	}
}

function deepStructuralEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((value, index) => deepStructuralEqual(value, right[index]));
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(key => deepStructuralEqual(leftRecord[key], rightRecord[key]))
	);
}

/** True when a patch contains any secret-shaped key, recursively. */
function containsSecretConfigKey(value: unknown, seen = new Set<object>()): boolean {
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsSecretConfigKey(item, seen));
	return Object.entries(value as Record<string, unknown>).some(
		([key, nested]) =>
			/(?:token|secret|password|api[_-]?key|credential|authorization)/i.test(key) ||
			containsSecretConfigKey(nested, seen),
	);
}
async function resolveSdkWorkflowGate(
	ctx: ExtensionContext,
	operation: "workflow.gate_answer" | "workflow.plan_approve",
	id: string,
	answer: unknown,
	expectedSessionId: string | undefined,
	idempotencyKey: string,
	canResolve: () => boolean,
): Promise<unknown> {
	if (!canResolve())
		throw Object.assign(new Error("Workflow gate is no longer answerable."), { code: "resource_gone" });
	if (expectedSessionId !== undefined && expectedSessionId !== ctx.sessionManager.getSessionId())
		throw Object.assign(new Error("Workflow gate session does not match this endpoint."), { code: "resource_gone" });
	if (expectedSessionId === undefined) logger.warn("workflow_control_missing_expected_session_id", { operation });
	const workflowGate = ctx.workflowGate;
	if (
		typeof workflowGate?.resolveGate !== "function" ||
		typeof workflowGate.recoverAcceptedGates !== "function" ||
		typeof workflowGate.lookupCompletedResolution !== "function" ||
		typeof workflowGate.prepareTerminalization !== "function" ||
		typeof workflowGate.clearPreparedTerminalization !== "function"
	)
		throw Object.assign(new Error("Workflow gates are unavailable for this session."), { code: "resource_gone" });
	const response = { gate_id: id, answer, idempotency_key: idempotencyKey };
	const completed = workflowGate.lookupCompletedResolution(response);
	if (completed.kind === "completed") return completed.resolution;
	if (completed.kind === "accepted_incomplete") {
		try {
			await workflowGate.recoverAcceptedGates();
		} catch {
			throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
				code: "terminal_uncertain",
			});
		}
		const recovered = workflowGate.lookupCompletedResolution(response);
		if (recovered.kind === "completed") return recovered.resolution;
		throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), { code: "terminal_uncertain" });
	}
	if (!workflowGate.prepareTerminalization(id, "not_published"))
		throw Object.assign(new Error("Workflow gate is no longer answerable."), { code: "resource_gone" });
	try {
		const resolution = await workflowGate.resolveGate(response);
		if ((resolution as { status?: unknown }).status === "rejected") workflowGate.clearPreparedTerminalization(id);
		return resolution;
	} catch (error) {
		const completedAfterFailure = workflowGate.lookupCompletedResolution(response);
		if (completedAfterFailure.kind === "completed") return completedAfterFailure.resolution;
		if (completedAfterFailure.kind === "accepted_incomplete") {
			try {
				await workflowGate.recoverAcceptedGates();
			} catch {
				throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
					code: "terminal_uncertain",
				});
			}
			const recovered = workflowGate.lookupCompletedResolution(response);
			if (recovered.kind === "completed") return recovered.resolution;
			throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
				code: "terminal_uncertain",
			});
		}
		const stillPending = workflowGate.listPendingGates?.().some(gate => gate.gate_id === id) === true;
		if (stillPending) workflowGate.clearPreparedTerminalization(id);
		else workflowGate.quarantineGate?.(id);
		throw error;
	}
}

/** Compound failure-plus-terminal recovery intent for a rejected submission:
 * the deadline manager's replay re-records this cause before agent_end so the
 * abandoned prompt terminalizes failed, never terminal_ok (exact-head review). */
function rejectionRecoveryIntent(error: unknown): { code: string; message: string } {
	// The recovery intent is persisted and surfaced through prompt status, so it
	// carries the sanitized classifier only — never a raw provider message
	// (exact-head review P1).
	return sanitizePromptFailure(error);
}

/**
 * A provider can finish a stream with an assistant error message rather than
 * rejecting the prompt promise. The SDK extension receives the final agent_end
 * after retry/fallback policy has settled, so this is the safe boundary at which
 * to publish the additive failure diagnostic before terminal reconciliation.
 */
function providerFailureFromAgentEnd(event: unknown): { code: string; message: string } | undefined {
	try {
		if (!event || typeof event !== "object") return undefined;
		const messages = (event as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return undefined;
		const lastAssistant = [...messages]
			.reverse()
			.find(
				message => message && typeof message === "object" && (message as { role?: unknown }).role === "assistant",
			);
		if (!lastAssistant || typeof lastAssistant !== "object") return undefined;
		const assistant = lastAssistant as {
			stopReason?: unknown;
			errorMessage?: unknown;
			errorKind?: unknown;
			errorStatus?: unknown;
			transportFailure?: { status?: unknown };
		};
		let stopReason: unknown;
		try {
			stopReason = assistant.stopReason;
		} catch {
			return undefined;
		}
		if (stopReason !== "error") return undefined;
		let errorKind: unknown;
		try {
			errorKind = assistant.errorKind;
		} catch {
			return undefined;
		}
		if (errorKind === "local_snapshot_failure" || errorKind === "local_buffer_overflow") return undefined;
		let errorMessage: unknown;
		try {
			errorMessage = assistant.errorMessage;
		} catch {
			return undefined;
		}
		// Agent-local malformed-tool and composer policy circuit breakers also use
		// stopReason=error, but they are not provider failures and must not be
		// reported as provider_rejected to SDK callers.
		if (
			typeof errorMessage === "string" &&
			(errorMessage.includes("Composer bash policy blocked repository file I/O again") ||
				errorMessage.includes("consecutive turns of malformed tool calls"))
		)
			return undefined;
		let status: number | undefined;
		try {
			const errorStatus = assistant.errorStatus;
			if (typeof errorStatus === "number" && Number.isSafeInteger(errorStatus)) status = errorStatus;
		} catch {
			// A malformed errorStatus is equivalent to a statusless provider error.
		}
		if (status === undefined) {
			try {
				const transportStatus = assistant.transportFailure?.status;
				if (typeof transportStatus === "number" && Number.isSafeInteger(transportStatus)) status = transportStatus;
			} catch {
				// A throwing transport metadata accessor is also statusless.
			}
		}
		if (status === 402 || status === 429)
			return { code: `provider_http_${status}`, message: "Prompt submission failed." };
		if (status !== undefined) return { code: "provider_rejected", message: "Prompt submission failed." };
		return { code: "provider_rejected", message: "Prompt submission failed." };
	} catch {
		// Provider metadata is untrusted: an SDK/provider adapter may expose a
		// throwing getter while the lifecycle boundary still needs to terminalize.
		return undefined;
	}
}

interface PromptTerminalEvidence {
	content?: TurnResultContent;
	hasActivity: boolean;
}

function promptTerminalEvidenceFromAgentEnd(event: unknown): PromptTerminalEvidence {
	try {
		if (!event || typeof event !== "object") return { hasActivity: false };
		const messages = (event as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return { hasActivity: false };
		const assistant = [...messages]
			.reverse()
			.find(
				message => message && typeof message === "object" && (message as { role?: unknown }).role === "assistant",
			);
		if (!assistant || typeof assistant !== "object") return { hasActivity: false };
		const content = (assistant as { content?: unknown }).content;
		if (typeof content === "string") {
			const bounded = sanitizeTurnResultContent(content);
			return { content: bounded, hasActivity: content.trim().length > 0 };
		}
		if (Array.isArray(content)) {
			const hasActivity = content.some(block => {
				if (block === null || typeof block !== "object") return false;
				const type = (block as { type?: unknown }).type;
				if (type === "text") {
					const text = (block as { text?: unknown }).text;
					return typeof text === "string" && text.trim().length > 0;
				}
				return typeof type === "string" && type.length > 0;
			});
			const text = content
				.filter(
					(block): block is { type: "text"; text: string } =>
						block !== null &&
						typeof block === "object" &&
						(block as { type?: unknown }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string",
				)
				.map(block => block.text)
				.join("");
			return { content: sanitizeTurnResultContent(text), hasActivity };
		}
		return { content: sanitizeTurnResultContent(""), hasActivity: false };
	} catch {
		return { hasActivity: false };
	}
}

function createControlSurface(
	ctx: ExtensionContext,
	api: ExtensionAPI,
	reconciliation: InvocationReconciliation,
	onAccepted: (
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		connectionId: string | undefined,
		startsOwnTurn: boolean,
		sdkRunToken: string,
	) => void,
	armPromptDeadline: (correlation: InvocationCorrelation) => void,
	steerReconciliation: KindAwareReconciliation,
	onPromotedTurn?: (
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		connectionId: string | undefined,
		sdkRunToken: string,
		promotion?: { startsOwnRun?: boolean; removed?: boolean },
	) => void,
	policy?: SdkSurfacePolicy,
	settings?: Settings,
	configOverrides?: Map<string, unknown>,
	configRevision: { current: number } = { current: 0 },
	getRuntimeHost: () => SessionSdkHost | undefined = () => undefined,
	terminalAbortSeams?: SdkOnlyTerminalAbortSeams,
	terminalPublicationCapture?: {
		waiters?: Array<{ epoch: number; resolve: (observed: boolean) => void }>;
	},
	activePromptOwnerHolder?: { connectionIds?: ReadonlySet<string>; lifecycleEpoch?: number },
	retirePendingOwner?: (
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		leaseRelease?: "always" | "recover-failure" | "recover-terminal",
		failureIntent?: { code: string; message: string },
	) => void,
	canResolveGate: () => boolean = () => true,
	trackGateResolution: <T>(resolution: Promise<T>) => Promise<T> = async resolution => await resolution,
	onInvocationCompletionReconciledForTests?: (kind: InvocationKind, correlation: InvocationCorrelation) => void,
): ControlSurface {
	const normalizePromptImages = (value: unknown): ImageContent[] => {
		if (!Array.isArray(value)) return [];
		const normalized: ImageContent[] = [];
		for (const candidate of value) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
			const image = candidate as Record<string, unknown>;
			if (typeof image.data !== "string" || image.data.trim().length === 0) continue;
			if (image.mimeType !== undefined && typeof image.mimeType !== "string") continue;
			normalized.push({
				type: "image",
				data: image.data,
				mimeType: typeof image.mimeType === "string" && image.mimeType.length > 0 ? image.mimeType : "image/png",
			});
		}
		return normalized;
	};
	type InternalSendOptions = NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]> & {
		sdkRunCapability?: SdkRunCapability;
	};
	type InternalSdkApi = Omit<ExtensionAPI, "sendUserMessage"> & {
		sendUserMessage: (
			content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
			options?: InternalSendOptions,
		) => Promise<void>;
	};
	const internalApi = api as InternalSdkApi;
	const sendSdkUserMessage = (
		content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
		options?: Record<string, unknown>,
	): Promise<void> => internalApi.sendUserMessage(content, options);
	const surfacePolicy =
		policy ?? createSdkSurfacePolicyForContext(ctx, hasSdkWorkflowGateCapability(ctx.workflowGate));
	const typed = (operation: string, input: Record<string, unknown> = {}) =>
		ctx.sdkControl ? ctx.sdkControl(operation, input) : unavailable(operation)();
	const resolveModel = (id: string) => {
		const [provider, ...modelId] = id.split("/");
		const model =
			modelId.length > 0
				? ctx.modelRegistry.find(provider, modelId.join("/"))
				: ctx.modelRegistry.getAll().find(candidate => candidate.id === id);
		if (!model) throw Object.assign(new Error(`Model ${id} was not found.`), { code: "invalid_input" });
		return model;
	};
	/**
	 * Route a synthetic `gajae-code/<profile>` model selection into the
	 * session-scoped activation transaction. ACP model selection never writes a
	 * global profile default; persistence remains an explicit TUI choice. Only
	 * an absent or `off` thinking level is forwarded (synthetic rows advertise
	 * `validLevels: ["off"]`); any other level is rejected before admission.
	 * A user-defined provider under the reserved namespace fails closed rather
	 * than being shadowed. With a thinking level the typed host surface returns
	 * the pinned `DefaultModelSelectionResult`-shaped result.
	 */
	const setSyntheticModel = async (id: string, requestedThinkingLevel: unknown) => {
		const hasLevel = requestedThinkingLevel !== undefined;
		const thinkingLevel =
			typeof requestedThinkingLevel === "string" ? parseThinkingLevel(requestedThinkingLevel) : undefined;
		if (
			hasLevel &&
			(!thinkingLevel || thinkingLevel === ThinkingLevel.Inherit || thinkingLevel !== ThinkingLevel.Off)
		)
			throw syntheticModelInputError('model.set thinkingLevel for a synthetic profile must be "off".');
		const profiles = ctx.modelRegistry.getModelProfiles();
		const resolved = resolveSyntheticModelSelection(id, profiles, ctx.modelRegistry.getError?.());
		if (syntheticNamespaceCollision(ctx.modelRegistry.getAll(), ctx.modelRegistry.getConfiguredProviderIds?.() ?? []))
			throw syntheticModelInputError(
				`The ${SYNTHETIC_PROVIDER_ID} namespace is reserved; synthetic preset selection is disabled while a provider of the same name is configured.`,
			);
		const setDefaultModelProfile = ctx.setDefaultModelProfile;
		if (!setDefaultModelProfile) return unavailable("model.set")();
		await setDefaultModelProfile(resolved.canonicalName, {
			persistDefault: false,
			...(hasLevel ? { thinkingLevelOverride: ThinkingLevel.Off } : {}),
		});
		return hasLevel
			? {
					provider: SYNTHETIC_PROVIDER_ID,
					modelId: resolved.canonicalName,
					thinkingLevel: ThinkingLevel.Off,
				}
			: { changed: true };
	};
	const newCorrelation = () => ({ commandId: crypto.randomUUID(), turnId: crypto.randomUUID() });
	const pendingPreflights = new Map<string, Set<() => void>>();
	// The SDK connection that accepted the currently active prompt/skill, if
	// any: terminal aborts are requester-scoped, so another connection must
	// never stop it, and an agent-initiated turn (monitor/cron follow-up) has
	// no owner — every client is refused (review thread P1). Shared with the
	// runtime extension so agent_end clears it: a stale owner must not
	// authorize its old client against a later turn it did not submit (review
	// thread P1).
	const activePromptOwner = activePromptOwnerHolder ?? { connectionIds: new Set<string>(), lifecycleEpoch: 0 };
	const currentRequesterPreflights = (): Set<() => void> => {
		const key = sdkControlRequesterContext.getStore() ?? "";
		let pending = pendingPreflights.get(key);
		if (!pending) {
			pending = new Set();
			pendingPreflights.set(key, pending);
		}
		return pending;
	};
	const normalizeClientRef = (clientRef: string | undefined): string | undefined => {
		if (clientRef === undefined) return undefined;
		const trimmed = clientRef.trim();
		if (!trimmed || trimmed.length > 128)
			throw Object.assign(new Error("clientRef must be a non-empty string of at most 128 characters."), {
				code: "invalid_input",
			});
		return trimmed;
	};
	const submit = async (
		kind: InvocationKind,
		clientRef: string | undefined,
		run: (options: {
			sdkRunCapability: SdkRunCapability;
			onPreflightAccepted: () => void;
			onPreflightAcceptCommit: () => Promise<void>;
			/** Internal disposition before a queued submission is actually consumed. */
			onDispatchDisposition: (promotion: { startsOwnRun: boolean }) => void;
			/** Fired when a queued submission (steering or follow-up) is promoted to its own run (SDK ownership correlation). */
			onQueuedPromoted: (promotion?: { startsOwnRun?: boolean; removed?: boolean }) => void;
			queuedAtDispatch: boolean;
		}) => Promise<unknown>,
		acceptedFields?: () => Record<string, unknown>,
		allowCompletionFallback = false,
		alwaysQueued = false,
	): Promise<unknown> => {
		// Capture the REQUESTING connection at admission: a terminal abort from
		// another SDK connection must never stop the prompt this one accepts
		// (review thread P1).
		const requesterConnectionId = sdkControlRequesterContext.getStore();
		const retainedClientRef = normalizeClientRef(clientRef);
		reconciliation.admit(kind, retainedClientRef);
		const correlation = newCorrelation();
		const sdkRunToken = `${correlation.commandId}:${correlation.turnId}`;
		const sdkRunCapability = createSdkRunCapability(sdkRunToken);
		const preflight = Promise.withResolvers<void>();
		let accepted = false;
		let settled = false;
		const cancelPreflight = () => {
			if (settled) return;
			settled = true;
			preflight.reject(
				Object.assign(new Error("Prompt preflight was cancelled before execution."), { code: "busy" }),
			);
		};
		const requesterPreflights = currentRequesterPreflights();
		requesterPreflights.add(cancelPreflight);
		const accept = async (): Promise<void> => {
			if (settled) return;
			// startsOwnTurn is captured from the pre-dispatch idle snapshot (see
			// below): re-reading ctx.isIdle() here would observe the session as
			// already streaming, because the production AgentSession begins its
			// in-flight bookkeeping before the preflight acceptance callback
			// (review thread P1).
			try {
				await reconciliation.noteAccepted(kind, correlation, retainedClientRef);
				accepted = true;
				settled = true;
				if (kind === "prompt" && startsOwnTurn) armPromptDeadline(correlation);
				// The accepted submission does NOT own the active turn until its run
				// actually STARTS: the connection is carried on the pending entry and
				// associated at agent_start instead (review thread P1).
				onAccepted(kind, correlation, requesterConnectionId, startsOwnTurn, sdkRunToken);
				preflight.resolve();
			} catch (error) {
				settled = true;
				preflight.reject(error);
				throw error;
			}
		};
		// Snapshot before run(): if the session is streaming when the submission starts,
		// sendUserMessage will divert to steer-queue and resolve before the turn runs.
		// Re-reading ctx.isIdle() after run() would race — accept() does async fs I/O that
		// yields, so isStreaming can flip during the persist window.
		// Queued when the submission is always-queued or the session is NOT idle; the
		// optional chaining keeps harness contexts without isIdle working (the branch
		// model treats an absent isIdle as idle).
		const queuedAtDispatch = alwaysQueued || ctx.isIdle?.() === false;
		// Decide whether this submission ever starts its OWN turn from the SAME
		// pre-dispatch snapshot: a plain prompt accepted while another turn
		// streams is queued as STEERING and consumed inside the current run — it
		// emits no agent_start, so its pending entry would be wrongly consumed
		// (and its connection associated as owner) by a later agent-initiated
		// monitor/cron turn (review thread P1). A follow-up is ALWAYS queued
		// (never started inline): its ownership entry is created only when the
		// queued follow-up is actually promoted to a run (review thread P1).
		// Skills always start their own invocation; a plain prompt starts one
		// only when idle at dispatch time.
		const startsOwnTurn = kind === "skill" || (kind === "prompt" && !alwaysQueued && !queuedAtDispatch);
		let promotionStartsOwnRun: boolean | undefined;
		try {
			const submission = Promise.resolve(
				run({
					onPreflightAccepted: () => void accept().catch(() => undefined),
					sdkRunCapability,
					onPreflightAcceptCommit: accept,
					onDispatchDisposition: promotion => {
						promotionStartsOwnRun = promotion.startsOwnRun;
						if (promotion.startsOwnRun === false) {
							// Dispatch-race diversion (#4668 review P1): the idle snapshot leased
							// this prompt at acceptance, but it was actually diverted into the
							// in-flight run's steering queue. While it sits queued — legitimately
							// waiting behind a long turn — nothing renews that lease, so it would
							// false-fire prompt_deadline_exceeded before consumption. Drop the
							// acceptance-anchored lease and pending entry now; the real
							// consumption boundary (onQueuedPromoted) re-leases and re-owns it.
							retirePendingOwner?.(kind, correlation, "always");
						}
					},
					// A queued submission (busy-accepted steering, or a follow-up) that
					// is later PROMOTED to its own run needs its pending ownership entry
					// created at promotion so the submitting connection can
					// terminal-abort that turn (review threads P1/P2).
					onQueuedPromoted: (promotion?: { startsOwnRun?: boolean; removed?: boolean }) => {
						promotionStartsOwnRun = promotion?.startsOwnRun;
						onPromotedTurn?.(kind, correlation, requesterConnectionId, sdkRunToken, promotion);
					},
					queuedAtDispatch,
				}),
			);
			void submission.then(
				result => {
					if (settled) {
						// A resolved submission after preflight acceptance means the work is over
						// for every kind. `noteTransition` ignores an already-terminal record, so
						// terminalizing here is safe — unless the submission resolved at queue time
						// (followUp, or a prompt diverted to steer while streaming), in which case
						// the turn's own lifecycle events drive terminalization.
						// Dispatch-race P1: queuedAtDispatch is the pre-dispatch snapshot;
						// a delayed preflight diverted to steering fires onQueuedPromoted
						// with startsOwnRun:false and is now attached to the in-flight run.
						// Do not terminalize from the stale snapshot — the run will.
						if (!queuedAtDispatch && promotionStartsOwnRun !== false) {
							// The accepted work settled without its own run still pending:
							// retire the pending ownership entry (and with it the
							// acceptance-anchored deadline lease, #4668 review) BEFORE
							// terminalizing. A stale entry would otherwise be drained by
							// a later agent_start and hand this connection ownership of
							// a turn it did not start. No-op when agent_start already
							// drained the entry.
							retirePendingOwner?.(kind, correlation);
							const attemptTerminalization = async (remaining: number): Promise<void> => {
								try {
									await reconciliation.noteTransition(kind, correlation, {
										type: "agent_end",
										...(typeof result === "string" ? { content: sanitizeTurnResultContent(result) } : {}),
									});
									onInvocationCompletionReconciledForTests?.(kind, correlation);
									retirePendingOwner?.(kind, correlation, "always");
								} catch (transitionError) {
									if (kind === "prompt" || kind === "skill") {
										retirePendingOwner?.(kind, correlation, "recover-terminal");
										return;
									}
									if (remaining <= 1) {
										logger.error(
											"SDK skill completion exhausted terminal retries; continuing scheduled recovery",
											{
												kind,
												commandId: correlation.commandId,
												turnId: correlation.turnId,
												error: sanitizePromptFailure(transitionError),
											},
										);
										await Bun.sleep(1_000);
										return attemptTerminalization(remaining);
									}
									await Bun.sleep(1_000);
									return attemptTerminalization(remaining - 1);
								}
							};
							void attemptTerminalization(3);
						}
						return;
					}
					if (allowCompletionFallback) {
						void accept().catch(() => undefined);
						return;
					}
					settled = true;
					preflight.reject(
						Object.assign(new Error("Prompt submission completed without preflight acceptance."), {
							code: "busy",
						}),
					);
				},
				error => {
					if (settled) {
						// The submission promise rejects after preflight acceptance only when the
						// work itself is over (provider stream interrupt, abort, queue failure).
						// The accepted run never started (agent_start never fired), so its pending
						// entry must be retired — otherwise a later agent-initiated
						// monitor/cron turn's agent_start would shift the stale entry and
						// associate the failed submission's connection as owner (review
						// thread P1).
						retirePendingOwner?.(kind, correlation);
						// agent_failed alone is diagnostic-only (agent_end is the
						// terminal boundary), so the failure reason is recorded first
						// and the same submission is then terminalized as failed.
						// Terminalizing only with agent_failed would leave the record
						// accepted forever — exactly the #4668 zero-activity strand.
						void (async () => {
							// Compound failure+terminal recovery, kind-aware (exact-head review P1):
							// the reason must be durable BEFORE the boundary or the rejection reads
							// terminal_ok. Prompts hand the compound intent to the deadline manager
							// (which also retires pending ownership at expiry). Skills have NO lease,
							// so their recovery owner is this bounded in-place retry loop: the same
							// order, retried, until both writes land or the budget is spent.
							const attemptRejectionTerminalization = async (remaining: number): Promise<void> => {
								try {
									await reconciliation.noteTransition(kind, correlation, { type: "agent_failed", error });
								} catch {
									if (kind === "prompt" || kind === "skill") {
										retirePendingOwner?.(
											kind,
											correlation,
											"recover-failure",
											rejectionRecoveryIntent(error),
										);
										return;
									}
									if (remaining <= 1) {
										// Budget exhausted but NEVER park inert (exact-head review P1): a
										// skill has no deadline lease, so this loop is its only recovery
										// owner. Log the sanitized classifier and keep a live scheduled retry
										// so the accepted record terminalizes eventually instead of stranding
										// accepted forever.
										logger.error(
											"SDK skill rejection exhausted its failure-reason retries; continuing scheduled recovery",
											{
												kind,
												commandId: correlation.commandId,
												turnId: correlation.turnId,
												error: sanitizePromptFailure(error),
											},
										);
										await Bun.sleep(1_000);
										return attemptRejectionTerminalization(remaining);
									}
									await Bun.sleep(1_000);
									return attemptRejectionTerminalization(remaining - 1);
								}
								try {
									await reconciliation.noteTransition(kind, correlation, { type: "agent_end" });
								} catch (transitionError) {
									if (kind === "prompt" || kind === "skill") {
										retirePendingOwner?.(
											kind,
											correlation,
											"recover-failure",
											rejectionRecoveryIntent(error),
										);
									} else if (remaining > 1) {
										await Bun.sleep(1_000);
										return attemptRejectionTerminalization(remaining - 1);
									} else {
										logger.error(
											"SDK skill rejection exhausted its terminal retries; continuing scheduled recovery",
											{
												kind,
												commandId: correlation.commandId,
												turnId: correlation.turnId,
												error: sanitizePromptFailure(transitionError),
											},
										);
										await Bun.sleep(1_000);
										return attemptRejectionTerminalization(remaining);
									}
									logger.error("SDK accepted submission failed to terminalize after rejection", {
										kind,
										commandId: correlation.commandId,
										turnId: correlation.turnId,
										// Sanitized representation only: the raw transition error may
										// carry transport or filesystem detail (exact-head review P2).
										error: sanitizePromptFailure(transitionError),
									});
								}
							};
							void attemptRejectionTerminalization(3);
						})();
						return;
					}
					settled = true;
					preflight.reject(error);
				},
			);
			await preflight.promise;
			return {
				accepted: true,
				...correlation,
				...(retainedClientRef === undefined ? {} : { clientRef: retainedClientRef }),
				...(acceptedFields?.() ?? {}),
			};
		} catch (error) {
			if (!accepted) reconciliation.release(kind, retainedClientRef);
			throw error;
		} finally {
			requesterPreflights.delete(cancelPreflight);
			if (requesterPreflights.size === 0) pendingPreflights.delete(sdkControlRequesterContext.getStore() ?? "");
		}
	};
	const terminalAbort = async (
		input: { mode: "terminal"; scope?: "turn" | "owned"; operator?: boolean },
		idempotencyKey?: string,
	): Promise<unknown> => {
		const scope = input.scope === "owned" ? "owned" : "turn";
		// Capture the steering snapshot at ADMISSION (before any durable
		// transaction): client steering admitted while the abort is in flight
		// classifies as post-snapshot and is preserved at abortPromptAndWait
		// (review thread P1).
		const steeringSnapshotToken = terminalAbortSeams?.captureTerminalAbortSteeringSnapshot?.();
		let steeringSnapshotConsumed = false;
		const terminalReservationLimit =
			terminalAbortSeams?.maxDurableTerminalReservationsForTests ?? MAX_DURABLE_TERMINAL_RESERVATIONS;
		try {
			// Hash the EXACT response payload this abort will return: the durable row
			// stores it at finalization so the response-state advance requires
			// equality instead of trusting a non-pending placeholder (review thread P2).
			const hashResult = (value: unknown): string =>
				crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
			const store = reconciliation.store;
			if (!store?.path || !terminalAbortSeams) {
				return {
					ok: true,
					selection: scope,
					turn: "no_store",
					terminal: "terminal_no_effect",
				};
			}
			const keyHash =
				typeof idempotencyKey === "string"
					? crypto.createHash("sha256").update(idempotencyKey).digest("hex")
					: undefined;
			const abortIdentity = terminalAbortIdentity(
				{ mode: "terminal", scope, ...(input.operator === true ? { operator: true } : {}) },
				input.operator === true,
			);
			if (!abortIdentity) throw new Error("Terminal abort identity is invalid after dispatch validation.");
			const inputHash = abortIdentity.inputHash;
			const stored = (record: SdkOnlyTerminalScopeRecord | SdkOnlyEvictedTerminalKeyEntry) => ({
				responseState: record.responseState ?? "pending",
				responsePayloadHash: record.responsePayloadHash ?? inputHash,
				terminalPublished: record.terminalPublished === true,
			});
			// The exact response a same-key retry delivers appends the replay envelope
			// (and, for uncertainty, the replay reason). The delivery hash check
			// requires exact equality, so the durable row must store BOTH the original
			// response hash (first write) and the replay-shaped hash (retry write) or a
			// successfully written replay could never advance a pending row to sent
			// (review thread P2).
			const replayShapedHash = (
				record: SdkOnlyTerminalScopeRecord,
				result: Record<string, unknown>,
				payloadHash: string,
			): string =>
				crypto
					.createHash("sha256")
					.update(
						JSON.stringify({
							...result,
							...(result.turn === "uncertain" && typeof result.reason === "string"
								? { reason: "replay_uncertain" }
								: {}),
							replay: {
								responseState: record.responseState ?? "pending",
								responsePayloadHash: payloadHash,
								terminalPublished: record.terminalPublished === true,
							},
						}),
					)
					.digest("hex");
			const replay = (): unknown => {
				const scopes = store.snapshotTerminalScopes();
				const existing = keyHash ? scopes.find(record => record.idempotencyKeyHash === keyHash) : undefined;
				if (existing) {
					if (existing.idempotencyInputHash !== inputHash)
						throw Object.assign(new Error("Idempotency key was reused with different input."), {
							code: "idempotency_conflict",
						});
					const persisted = stored(existing);
					if (existing.turnDisposition === "stopped")
						return {
							ok: true,
							selection: scope,
							turn: "stopped",
							...(scope === "owned"
								? {
										ownedWork: existing.ownedWorkDisposition === "stopped" ? "stopped" : "uncertain",
										automaticDelivery: "none",
										resumeOnOwnedCompletion: false,
									}
								: { ownedWork: "left_running", automaticDelivery: "enabled", resumeOnOwnedCompletion: true }),
							replay: persisted,
						};
					if (existing.turnDisposition === "no_effect")
						return {
							ok: true,
							selection: scope,
							turn: "no_active_turn",
							terminal: "terminal_no_effect",
							replay: persisted,
						};
					if (existing.turnDisposition === "no_effect_marker_failure")
						// The initial marker write failed before any destructive work;
						// replay the SAME no_effect result the request returned, never
						// a no_active_turn fabrication (review thread P2).
						return {
							ok: true,
							selection: scope,
							turn: "no_effect",
							terminal: "terminal_no_effect",
							replay: persisted,
						};
					if (existing.turnDisposition === "no_effect_reserved")
						// A no-effect reservation that may still transition to active: a
						// duplicate must never claim no_active_turn over a provisional row
						// (review thread P2).
						return {
							ok: true,
							selection: scope,
							turn: "uncertain",
							ownedWork: scope === "turn" ? "left_running" : "uncertain",
							automaticDelivery: scope === "turn" ? "enabled" : "none",
							resumeOnOwnedCompletion: scope === "turn",
							reason: "reservation_in_flight",
							replay: persisted,
						};
					return {
						ok: true,
						selection: scope,
						turn: "uncertain",
						ownedWork: scope === "turn" ? "left_running" : "uncertain",
						automaticDelivery: scope === "turn" ? "enabled" : "none",
						resumeOnOwnedCompletion: scope === "turn",
						reason: existing.turnDisposition === "pending" ? "replay_pending" : "replay_uncertain",
						replay: persisted,
					};
				}
				if (keyHash) {
					const tombstone = store.snapshotTerminalKeys().find(record => record.keyHash === keyHash);
					if (tombstone) {
						if (tombstone.inputHash !== inputHash)
							throw Object.assign(new Error("Idempotency key was reused with different input."), {
								code: "idempotency_conflict",
							});
						return tombstone.turnDisposition === "stopped"
							? {
									ok: true,
									selection: scope,
									turn: "stopped",
									...(scope === "owned"
										? {
												ownedWork: tombstone.ownedWorkDisposition === "stopped" ? "stopped" : "uncertain",
												automaticDelivery: "none",
												resumeOnOwnedCompletion: false,
											}
										: {
												ownedWork: "left_running",
												automaticDelivery: "enabled",
												resumeOnOwnedCompletion: true,
											}),
									replay: stored(tombstone),
								}
							: tombstone.turnDisposition === "no_effect"
								? {
										ok: true,
										selection: scope,
										turn: "no_active_turn",
										terminal: "terminal_no_effect",
										replay: stored(tombstone),
									}
								: tombstone.turnDisposition === "no_effect_marker_failure"
									? {
											ok: true,
											selection: scope,
											turn: "no_effect",
											terminal: "terminal_no_effect",
											replay: stored(tombstone),
										}
									: {
											ok: true,
											selection: scope,
											turn: "uncertain",
											ownedWork: scope === "turn" ? "left_running" : "uncertain",
											automaticDelivery: scope === "turn" ? "enabled" : "none",
											resumeOnOwnedCompletion: scope === "turn",
											replay: stored(tombstone),
										};
					}
				}
				return undefined;
			};
			const prior = replay();
			if (prior !== undefined) return prior;
			const writeNoEffect = async (markerFailure = false): Promise<"ok" | "conflict"> => {
				try {
					await store.transactTerminalState(state => {
						// Atomic recheck: a concurrent request may have committed a
						// DIFFERENT input under this key after the earlier snapshot
						// check; appending a second same-key row would make later
						// replay's .find() by key hash ambiguous (review thread P2).
						const conflicting = state.scopes.find(record => keyHash && record.idempotencyKeyHash === keyHash);
						if (conflicting && conflicting.idempotencyInputHash !== inputHash)
							throw new SdkOnlyIdempotencyConflictError();
						// A SAME-input live row is durable replay authority (the original
						// in-flight abort's marker): never replace it with a no-effect
						// reservation, or the successful abort would replay later as
						// no_active_turn. Leave the store unchanged and let the caller
						// re-run the replay snapshot (review thread P2).
						if (conflicting) {
							existingReplay = conflicting;
							return { scopes: state.scopes, keys: state.keys };
						}
						// A concurrent admission may ALSO have evicted a same-key row into
						// the tombstone collection after this request's snapshot; recheck
						// keys so a different input can never install a fresh marker over
						// existing durable replay authority (review thread P2). A
						// same-input tombstone already carries the reservation: leave the
						// store unchanged and replay it.
						const tombstone = state.keys.find(record => keyHash && record.keyHash === keyHash);
						if (tombstone) {
							if (tombstone.inputHash !== inputHash) throw new SdkOnlyIdempotencyConflictError();
							existingReplay = tombstone;
							return { scopes: state.scopes, keys: state.keys };
						}
						const preBound: SdkOnlyTerminalScopeRecord[] = [
							...state.scopes.filter(record => !(keyHash && record.idempotencyKeyHash === keyHash)),
							{
								selection: scope,
								...(keyHash ? { idempotencyKeyHash: keyHash, idempotencyInputHash: inputHash } : {}),
								// A marker-failure reservation must replay as the SAME
								// no_effect result it was returned with, so one idempotency
								// key can never produce no_effect first and no_active_turn
								// after eviction/restart (review thread P2). The idle-abort
								// path writes a TRANSITIONAL reserved disposition: the
								// requester's prompt may become active while the reservation
								// is awaited, and a duplicate must never claim no_active_turn
								// over a provisional row — the reserved row is finalized to
								// plain no_effect only when the recheck confirms no active
								// turn (review thread P2).
								turnDisposition: markerFailure
									? "no_effect_marker_failure"
									: keyHash
										? "no_effect_reserved"
										: "no_effect",
								ownedWorkDisposition: "not_requested",
								automaticDeliveryDisposition: scope === "turn" ? "enabled" : "none",
								resumeOnOwnedCompletion: scope === "turn",
								turnContinuationFence: {
									state: "retained",
									abortedAttemptEpoch: 0,
									blockedContinuationIds: [],
									predecessorTombstones: [],
									ownedCompletionPolicy: scope === "turn" ? "enabled" : "disabled",
								},
								responseState: "pending",
								// marker_failure rows are FINAL as written (the abort returns the
								// public no_effect disposition immediately, no later
								// finalization), so store the public payload hash; idle
								// reservations are finalized by finalizeNoEffectReservation
								// (review thread P2). The replay-shaped hash is stored too so a
								// same-key retry's metadata-bearing replay can still advance the
								// row on delivery (review thread P2).
								responsePayloadHash: markerFailure
									? hashResult({
											ok: true,
											selection: scope,
											turn: "no_effect",
											terminal: "terminal_no_effect",
										})
									: inputHash,
								replayPayloadHash: markerFailure
									? hashResult({
											ok: true,
											selection: scope,
											turn: "no_effect",
											terminal: "terminal_no_effect",
											replay: {
												responseState: "pending",
												responsePayloadHash: hashResult({
													ok: true,
													selection: scope,
													turn: "no_effect",
													terminal: "terminal_no_effect",
												}),
												terminalPublished: false,
											},
										})
									: undefined,
								acceptedAt: Date.now(),
							},
						];
						return boundTerminalRetentionState(state.keys, preBound, terminalReservationLimit);
					});
					return "ok";
				} catch (error) {
					if (error instanceof SdkOnlyIdempotencyConflictError) return "conflict";
					throw error;
				}
			};
			// Finalize THIS abort's transitional no_effect_reserved reservation to
			// plain no_effect once the recheck confirms there is no active turn to
			// stop: a later same-key retry then replays the deterministic
			// no_active_turn result instead of reservation_in_flight uncertainty
			// (review thread P2). Only OUR row (exact key+input, still reserved) is
			// touched — a concurrent transition that already replaced it is left
			// alone. The EXACT final response payload hash is stored so the
			// response-state advance can require equality instead of trusting a
			// non-pending placeholder (review thread P2).
			const finalizeNoEffectReservation = async (result: {
				ok: boolean;
				selection: string;
				turn: string;
				terminal: string;
			}): Promise<void> => {
				if (!keyHash) return;
				const payloadHash = hashResult(result);
				// The same-key retry delivers the metadata-bearing replay envelope;
				// store its hash too so the retry's written response can advance the
				// finalized row (review thread P2).
				const replayPayloadHash = hashResult({
					...result,
					replay: { responseState: "pending", responsePayloadHash: payloadHash, terminalPublished: false },
				});
				try {
					await store.transactTerminalState(state => {
						const scopes: SdkOnlyTerminalScopeRecord[] = state.scopes.map(record =>
							record.idempotencyKeyHash === keyHash &&
							record.idempotencyInputHash === inputHash &&
							record.turnDisposition === "no_effect_reserved"
								? {
										...record,
										turnDisposition: "no_effect",
										responsePayloadHash: payloadHash,
										replayPayloadHash,
									}
								: record,
						);
						// Finalized reservations become evictable completed rows: apply
						// the SAME bounded retention as writeNoEffect so a burst of idle
						// aborts cannot grow the document (review thread P2).
						return boundTerminalRetentionState(state.keys, scopes, terminalReservationLimit);
					});
				} catch {
					// Best-effort: the row stays reserved (replays as uncertainty)
					// rather than failing the abort (review thread P2).
				}
			};
			// Finalize pending markers through the SAME bounded retention as the
			// admission writes: mapping pending rows to completed dispositions
			// (uncertain/stopped) must evict the oldest completed rows and retain
			// tombstones, or a burst of concurrent distinct-key aborts of one slow
			// turn leaves an arbitrarily large reconciliation document (review
			// thread P2).
			const transactBoundedTerminalScopes = async (
				mutate: (scopes: SdkOnlyTerminalScopeRecord[]) => SdkOnlyTerminalScopeRecord[],
			): Promise<void> => {
				await store.transactTerminalState(state => {
					return boundTerminalRetentionState(state.keys, mutate(state.scopes), terminalReservationLimit);
				});
			};
			let handle = terminalAbortSeams.getActivePromptHandle();
			let epoch = terminalAbortSeams.getTerminalTurnEpoch();
			// Set when the no-effect reservation found an existing SAME-input row or
			// tombstone: the caller re-runs the replay snapshot instead of returning
			// a no-active result over the original row's replay authority (review
			// thread P2).
			let existingReplay: SdkOnlyTerminalScopeRecord | SdkOnlyEvictedTerminalKeyEntry | undefined;
			// Read the requester's preflight bucket WITHOUT creating one: an
			// abort-only request that returns via an early replay/marker path (which
			// never runs the bucket cleanup) must not leave an empty per-connection
			// entry behind — reconnecting clients would otherwise accumulate buckets
			// indefinitely (review thread P2).
			const requesterBucketKey = sdkControlRequesterContext.getStore() ?? "";
			const requesterPreflights = pendingPreflights.get(requesterBucketKey);
			// Snapshot the requester's preflight callbacks AT ADMISSION: a successor
			// turn.prompt pipelined by the same connection while the abort awaits
			// (e.g. the reconciliation transaction) must never be cancelled as part
			// of this abort — only the callbacks present when it was admitted are
			// its to cancel, mirroring the full-bus capture (review thread P1).
			const admittedRequesterPreflights = new Set(requesterPreflights ?? []);
			const cancelRequesterPreflights = () => {
				for (const cancel of [...admittedRequesterPreflights]) cancel();
				if (admittedRequesterPreflights.size > 0) {
					// Remove the admitted callbacks from the live set so a preflight
					// added by a LATER submission is untouched by this abort (and the
					// bucket cleanup below reflects what actually remains).
					for (const cancel of admittedRequesterPreflights) requesterPreflights?.delete(cancel);
					// The seam cancels the SESSION-WIDE preflight controller, so only
					// invoke it when NO OTHER connection has a pending admission: a
					// queued requester's abort must reject its own wrapper callback
					// (above) without cancelling another connection's active
					// preflight — the aborting requester's admission is already
					// rejected, so the session-wide abort is never required for it
					// (review thread P1).
					const otherConnectionPreflights = [...pendingPreflights.entries()].some(
						([bucket, callbacks]) => bucket !== requesterBucketKey && callbacks.size > 0,
					);
					if (!otherConnectionPreflights) terminalAbortSeams.cancelPendingPreflightForTerminalAbort();
				}
				if (requesterPreflights && requesterPreflights.size === 0) {
					// Abort-only lookups must not retain an empty per-connection bucket:
					// connections are ephemeral UUIDs and nothing else removes the
					// bucket when no prompt submission ever registered on it, so a
					// long-lived runtime handling aborts from reconnecting clients
					// would accumulate one entry per connection forever (review
					// thread P2).
					if (pendingPreflights.get(requesterBucketKey) === requesterPreflights)
						pendingPreflights.delete(requesterBucketKey);
				}
			};
			const returnNoActiveTurn = async () => {
				const result = {
					ok: true,
					selection: scope,
					turn: "no_active_turn",
					terminal: "terminal_no_effect",
				};
				await finalizeNoEffectReservation(result);
				return result;
			};
			if (!handle || epoch === undefined) {
				if ((await writeNoEffect()) === "conflict") {
					throw Object.assign(new Error("Idempotency key was reused with different input."), {
						code: "idempotency_conflict",
					});
				}
				// A SAME-input row or tombstone existed while the reservation
				// awaited the store: it is durable replay authority, so replay its
				// stored result (stopped/pending/uncertain/no_effect) instead of
				// returning no_active_turn over it (review thread P2).
				if (existingReplay) {
					const replayed = replay();
					if (replayed !== undefined) return replayed;
				}
				cancelRequesterPreflights();
				// Operator authority overrides connection ownership only for a turn
				// observed at admission. It must never adopt a successor that starts
				// while the durable no-effect reservation is being written.
				if (input.operator === true) return await returnNoActiveTurn();
				// A prompt for this requester may have become ACTIVE while the
				// reservation awaited the filesystem transaction: its submit()
				// cleanup already removed the preflight callback, so cancelling here
				// saw an empty set and never reached the session cancellation seam —
				// and the durable no-effect row would prevent a same-key retry from
				// ever stopping the now-running prompt. Re-read the active prompt and
				// fall through to ACTIVE terminalization when it won the race
				// (review thread P1); the active-turn marker write replaces the
				// no-effect reservation.
				const recheckedHandle = terminalAbortSeams.getActivePromptHandle();
				const recheckedEpoch = terminalAbortSeams.getTerminalTurnEpoch();
				if (!recheckedHandle || recheckedEpoch === undefined) {
					// No prompt won the race: finalize the reserved row so a later
					// same-key retry replays this deterministic no_active_turn result
					// (review thread P2).
					return await returnNoActiveTurn();
				}
				handle = recheckedHandle;
				epoch = recheckedEpoch;
				// The requester's OWN prompt won the race: rebind the snapshot
				// to the current turn so the settlement classifies steering
				// admitted since admission as post-snapshot (review thread P1).
				if (steeringSnapshotToken !== undefined) {
					terminalAbortSeams?.rebindTerminalAbortSteeringSnapshot?.(steeringSnapshotToken);
				}
			}
			// Requester ownership: the active prompt belongs to the SDK connection
			// that accepted it. Another connection's terminal abort must not stop it
			// (review thread P1) — no-op with an idle reservation, mirroring the
			// per-connection selection of the full bus path. The owner is re-read
			// through the seam when provided (deterministic tests) and otherwise
			// from the runtime-tracked accepting connection.
			const abortingConnectionId = sdkControlRequesterContext.getStore();
			const currentOwnerConnectionIds = (): ReadonlySet<string> => {
				const seam = terminalAbortSeams.getActivePromptOwnerConnectionId?.();
				// The seam reports a single deterministic owner (test harnesses); the
				// runtime holder may carry every connection whose follow-up was
				// promoted into the current run (review thread P2).
				return seam === undefined ? (activePromptOwner.connectionIds ?? new Set<string>()) : new Set([seam]);
			};
			// FAIL CLOSED unless the active handle is POSITIVELY associated with the
			// requester: an undefined owner (agent-initiated monitor/cron turn, or
			// cleared after a terminal lifecycle boundary) authorizes no client, and
			// a stale prior owner authorizes only that old client — never a later
			// turn it did not submit (review thread P1).
			if (
				input.operator !== true &&
				handle &&
				(abortingConnectionId === undefined || !currentOwnerConnectionIds().has(abortingConnectionId))
			) {
				if ((await writeNoEffect()) === "conflict") {
					throw Object.assign(new Error("Idempotency key was reused with different input."), {
						code: "idempotency_conflict",
					});
				}
				if (existingReplay) {
					const replayed = replay();
					if (replayed !== undefined) return replayed;
				}
				cancelRequesterPreflights();
				// A prompt for this requester may have become ACTIVE while the
				// no-effect reservation awaited the filesystem transaction: the
				// owner-mismatch decision was taken against the OLD owner, and the
				// newly active submission already removed its preflight callback, so
				// cancelling here saw an empty set and never reached the session
				// cancellation seam — and the durable no-effect row would prevent a
				// same-key retry from ever stopping the now-running prompt. Re-read
				// the active prompt, its epoch, and its owner; when the ABORTING
				// connection now owns the turn, fall through to ACTIVE
				// terminalization (the active-turn marker write replaces the
				// no-effect reservation) (review thread P1).
				const recheckedHandle = terminalAbortSeams.getActivePromptHandle();
				const recheckedEpoch = terminalAbortSeams.getTerminalTurnEpoch();
				const recheckedOwners = currentOwnerConnectionIds();
				if (
					!recheckedHandle ||
					recheckedEpoch === undefined ||
					abortingConnectionId === undefined ||
					!recheckedOwners.has(abortingConnectionId)
				) {
					// The turn is still not the aborting connection's: finalize the
					// reserved row so a later same-key retry replays no_active_turn
					// deterministically (review thread P2).
					const noActiveTurnResult = {
						ok: true,
						selection: scope,
						turn: "no_active_turn",
						terminal: "terminal_no_effect",
					};
					await finalizeNoEffectReservation(noActiveTurnResult);
					return noActiveTurnResult;
				}
				handle = recheckedHandle;
				epoch = recheckedEpoch;
				// The requester's OWN prompt won the race: rebind the snapshot
				// to the current turn so the settlement classifies steering
				// admitted since admission as post-snapshot (review thread P1).
				if (steeringSnapshotToken !== undefined) {
					terminalAbortSeams?.rebindTerminalAbortSteeringSnapshot?.(steeringSnapshotToken);
				}
			}
			let pendingReplay: SdkOnlyTerminalScopeRecord | undefined;
			let tombstoneReplay: SdkOnlyEvictedTerminalKeyEntry | undefined;
			try {
				await store.transactTerminalState(state => {
					// Atomic recheck (same rationale as writeNoEffect): never wipe a
					// row a concurrent request committed under this key (review thread
					// P2). A same-input PENDING row is an in-flight duplicate admitted
					// past the snapshot (dispatch-cache eviction): replay it instead of
					// replacing the marker, so the duplicate cannot race terminalization
					// and flip the row to uncertain while the original returns stopped
					// (or execute the abort twice).
					const conflicting = state.scopes.find(record => keyHash && record.idempotencyKeyHash === keyHash);
					if (conflicting) {
						if (conflicting.idempotencyInputHash !== inputHash) throw new SdkOnlyIdempotencyConflictError();
						if (conflicting.turnDisposition === "pending") {
							pendingReplay = conflicting;
							return { scopes: state.scopes, keys: state.keys };
						}
					}
					// A concurrent admission may ALSO have evicted a same-key row into
					// the tombstone collection after this request's snapshot. Recheck
					// keys so a different input can never install a fresh marker over
					// existing durable replay authority; a same-input tombstone already
					// carries replay authority, so never install a second marker here
					// (review thread P2).
					const tombstone = state.keys.find(record => keyHash && record.keyHash === keyHash);
					if (tombstone) {
						if (tombstone.inputHash !== inputHash) throw new SdkOnlyIdempotencyConflictError();
						tombstoneReplay = tombstone;
						return { scopes: state.scopes, keys: state.keys };
					}
					const preBound: SdkOnlyTerminalScopeRecord[] = [
						...state.scopes.filter(record => !(keyHash && record.idempotencyKeyHash === keyHash)),
						{
							selection: scope,
							...(keyHash ? { idempotencyKeyHash: keyHash, idempotencyInputHash: inputHash } : {}),
							turnDisposition: "pending",
							terminalPublished: false,
							ownedWorkDisposition: "not_requested",
							automaticDeliveryDisposition: scope === "turn" ? "enabled" : "none",
							resumeOnOwnedCompletion: scope === "turn",
							turnContinuationFence: {
								state: "retained",
								abortedAttemptEpoch: epoch,
								blockedContinuationIds: [],
								predecessorTombstones: [],
								ownedCompletionPolicy: scope === "turn" ? "enabled" : "disabled",
							},
							responseState: "pending",
							responsePayloadHash: inputHash,
							acceptedAt: Date.now(),
						},
					];
					return boundTerminalRetentionState(state.keys, preBound, terminalReservationLimit);
				});
			} catch (error) {
				if (error instanceof SdkOnlyIdempotencyConflictError) {
					throw Object.assign(new Error("Idempotency key was reused with different input."), {
						code: "idempotency_conflict",
					});
				}
				// Marker persistence failed before any destructive work: reserve a
				// distinct marker-failure disposition so replay returns the same
				// no_effect result (review thread P2).
				if ((await writeNoEffect(true)) === "conflict") {
					throw Object.assign(new Error("Idempotency key was reused with different input."), {
						code: "idempotency_conflict",
					});
				}
				if (existingReplay) {
					const replayed = replay();
					if (replayed !== undefined) return replayed;
				}
				return {
					ok: true,
					selection: scope,
					turn: "no_effect",
					terminal: "terminal_no_effect",
				};
			}
			if (pendingReplay) {
				// An in-flight duplicate of this exact key+input was already admitted;
				// replay its pending row WITHOUT touching the seam, so the duplicate
				// cannot abort the run a second time or race the terminalization.
				return {
					ok: true,
					selection: scope,
					turn: "uncertain",
					ownedWork: scope === "turn" ? "left_running" : "uncertain",
					automaticDelivery: scope === "turn" ? "enabled" : "none",
					resumeOnOwnedCompletion: scope === "turn",
					reason: "replay_pending",
					replay: {
						responseState: pendingReplay.responseState,
						responsePayloadHash: pendingReplay.responsePayloadHash,
						terminalPublished: pendingReplay.terminalPublished === true,
					},
				};
			}
			if (tombstoneReplay) {
				// The key gained durable replay authority via an eviction tombstone
				// while this request was in flight; never install a second marker or
				// run the abort. Re-run the replay snapshot (the tombstone is now
				// visible) so the STORED result is returned (review thread P2).
				const replayed = replay();
				if (replayed !== undefined) return replayed;
			}
			// A new prompt won the race while the marker was being persisted. Never
			// apply this request to that later handle; replay remains a safe uncertainty.
			if (
				terminalAbortSeams.getActivePromptHandle() !== handle ||
				terminalAbortSeams.getTerminalTurnEpoch() !== epoch
			) {
				const result = {
					ok: true,
					selection: scope,
					turn: "uncertain",
					ownedWork: scope === "turn" ? "left_running" : "uncertain",
					automaticDelivery: scope === "turn" ? "enabled" : "none",
					resumeOnOwnedCompletion: scope === "turn",
					reason: "active_turn_changed",
				};
				const activeTurnPayloadHash = hashResult(result);
				await transactBoundedTerminalScopes(scopes =>
					scopes.map(record =>
						(keyHash
							? record.idempotencyKeyHash === keyHash
							: record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
						record.turnDisposition === "pending"
							? {
									...record,
									turnDisposition: "uncertain",
									responsePayloadHash: activeTurnPayloadHash,
									replayPayloadHash: replayShapedHash(record, result, activeTurnPayloadHash),
									terminalAt: Date.now(),
								}
							: record,
					),
				);
				return result;
			}
			cancelRequesterPreflights();
			// Observe the correlated agent_end publication (AC 19) instead of
			// assuming it: the aborted run's lifecycle event is published
			// independently by emitLifecycle, so the durable stopped row must only
			// claim terminalPublished when the publication was actually observed
			// (review thread P2). Multiple concurrent aborts of the SAME turn (distinct
			// idempotency keys, same scope) are all admitted and all await the ONE
			// agent_end the turn emits, so every waiter is registered — a single slot
			// would resolve only the latest and leave the earlier abort to record a
			// false negative (review thread P2).
			const terminalPublication = Promise.withResolvers<boolean>();
			const removeTerminalPublicationWaiter = () => {
				const waiters = terminalPublicationCapture?.waiters;
				if (!waiters) return;
				const index = waiters.findIndex(waiter => waiter.resolve === terminalPublication.resolve);
				if (index >= 0) waiters.splice(index, 1);
			};
			if (terminalPublicationCapture) {
				if (!terminalPublicationCapture.waiters) terminalPublicationCapture.waiters = [];
				terminalPublicationCapture.waiters.push({
					epoch: activePromptOwner.lifecycleEpoch ?? 0,
					resolve: terminalPublication.resolve,
				});
			}
			let proof: { status: string; terminalScope?: unknown };
			try {
				proof = await terminalAbortSeams.abortPromptAndWaitWithTerminal(handle, {
					graceMs: 10_000,
					terminal: {
						scope,
						expectedEpoch: epoch,
						...(steeringSnapshotToken !== undefined ? { steeringSnapshotToken } : {}),
					},
				});
			} catch {
				proof = { status: "unfenced" };
			}
			steeringSnapshotConsumed = proof.status === "settled";
			if (proof.status !== "settled" || proof.terminalScope === undefined) {
				removeTerminalPublicationWaiter();
				const result = {
					ok: true,
					selection: scope,
					turn: "uncertain",
					ownedWork: scope === "turn" ? "left_running" : "uncertain",
					automaticDelivery: scope === "turn" ? "enabled" : "none",
					resumeOnOwnedCompletion: scope === "turn",
					reason: "worker_unsettled",
				};
				const workerUnsettledPayloadHash = hashResult(result);
				await transactBoundedTerminalScopes(scopes =>
					scopes.map(record =>
						(keyHash
							? record.idempotencyKeyHash === keyHash
							: record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
						record.turnDisposition === "pending"
							? {
									...record,
									turnDisposition: "uncertain",
									ownedWorkDisposition: "uncertain",
									responsePayloadHash: workerUnsettledPayloadHash,
									replayPayloadHash: replayShapedHash(record, result, workerUnsettledPayloadHash),
									terminalAt: Date.now(),
								}
							: record,
					),
				);
				return result;
			}
			// scope:"owned" must generation-verify and CANCEL the exact owned work
			// before reporting it stopped: abortPromptAndWaitWithTerminal only aborts
			// the foreground run and registers the disabled-delivery scope — a
			// background Bash/task/detached subagent would otherwise keep running
			// while the client receives stopped_owned (review thread P1).
			const ownedStopped = true;
			if (scope === "owned") {
				const terminalScope = proof.terminalScope as
					| { abortedAttemptEpoch?: number; lineageIdHash?: string }
					| undefined;
				const failOwnedUncertain = async (): Promise<unknown> => {
					removeTerminalPublicationWaiter();
					const result = {
						ok: true,
						selection: scope,
						turn: "uncertain",
						ownedWork: "uncertain",
						automaticDelivery: "none",
						resumeOnOwnedCompletion: false,
						reason: "owned_unsettled",
					};
					const ownedUnsettledPayloadHash = hashResult(result);
					await transactBoundedTerminalScopes(scopes =>
						scopes.map(record =>
							(keyHash
								? record.idempotencyKeyHash === keyHash
								: record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
							record.turnDisposition === "pending"
								? {
										...record,
										turnDisposition: "uncertain",
										ownedWorkDisposition: "uncertain",
										responsePayloadHash: ownedUnsettledPayloadHash,
										replayPayloadHash: replayShapedHash(record, result, ownedUnsettledPayloadHash),
										terminalAt: Date.now(),
									}
								: record,
						),
					);
					return result;
				};
				if (
					!terminalScope ||
					terminalScope.abortedAttemptEpoch === undefined ||
					!terminalScope.lineageIdHash ||
					isOwnedAttemptRegistrationIncomplete(terminalScope.lineageIdHash, terminalScope.abortedAttemptEpoch)
				) {
					// The attempt's registration set may be KNOWN incomplete (registry
					// saturation or an evicted in-flight binding): never claim
					// stopped_owned over an incomplete causal set.
					return await failOwnedUncertain();
				}
				const exactJobs = findOwnedRegistrationsForTurn(
					terminalScope.lineageIdHash,
					terminalScope.abortedAttemptEpoch,
				);
				if (exactJobs.length > 0) {
					// Resolve the manager from the ABORTING ENDPOINT captured on the
					// registrations — never the process-global last-created session,
					// which could cancel a foreign same-id job and report stopped_owned
					// while the aborting session's job keeps running (review thread P1).
					const endpointId = exactJobs[0]?.endpointId;
					const manager = AsyncJobManager.forEndpoint(endpointId) ?? AsyncJobManager.instance();
					if (!manager || (await settleOwnedWork(manager, exactJobs, 500)) !== "stopped") {
						return await failOwnedUncertain();
					}
				}
			}
			// The worker settled; await the correlated agent_end publication for a
			// bounded window and persist the OBSERVED result (review thread P2). A
			// publication that never lands (lifecycle listener absent, still
			// pending, or failed) yields observed=false — the durable row never
			// claims a terminal event reached clients unless it was actually
			// published.
			const observed = await Promise.race([
				terminalPublication.promise,
				Bun.sleep(SDK_ONLY_TERMINAL_PUBLICATION_WAIT_MS).then(() => false as const),
			]);
			removeTerminalPublicationWaiter();
			const terminalPublished = observed === true;
			const result = {
				ok: true,
				selection: scope,
				turn: "stopped",
				...(scope === "turn"
					? { ownedWork: "left_running", automaticDelivery: "enabled", resumeOnOwnedCompletion: true }
					: {
							ownedWork: ownedStopped ? "stopped" : "uncertain",
							automaticDelivery: "none",
							resumeOnOwnedCompletion: false,
						}),
			};
			const payloadHash = crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
			await transactBoundedTerminalScopes(scopes =>
				scopes.map(record =>
					(keyHash
						? record.idempotencyKeyHash === keyHash
						: record.turnContinuationFence.abortedAttemptEpoch === epoch) && record.turnDisposition === "pending"
						? {
								...record,
								turnDisposition: "stopped",
								terminalPublished,
								ownedWorkDisposition:
									scope === "turn" ? "left_running" : ownedStopped ? "stopped" : "uncertain",
								responsePayloadHash: payloadHash,
								// The replay envelope carries the POST-CAS publication
								// flag; the replay-shaped hash must be computed from the
								// updated row or a written replay could never match it
								// (review thread P2).
								replayPayloadHash: replayShapedHash({ ...record, terminalPublished }, result, payloadHash),
								terminalAt: Date.now(),
							}
						: record,
				),
			);
			return result;
		} finally {
			// A replay-only abort (or any pre-settlement failure) never consumed its
			// snapshot: discard it so a later real abort cannot consume the stale
			// entry and treat steering admitted since the replay as post-abort
			// (review thread P1).
			if (steeringSnapshotToken !== undefined && !steeringSnapshotConsumed) {
				terminalAbortSeams?.discardTerminalAbortSteeringSnapshot?.(steeringSnapshotToken);
			}
		}
	};
	return {
		prompt: async (text, images, clientRef) => {
			const invalid = validateRequiredPromptText("turn.prompt", { text, images });
			if (invalid) throw Object.assign(new Error(invalid.message), { code: invalid.code });
			return await submit("prompt", clientRef, ({ queuedAtDispatch, sdkRunCapability, ...options }) =>
				sendSdkUserMessage(
					typeof images === "undefined"
						? text
						: ([{ type: "text", text }, ...normalizePromptImages(images)] as [
								{ type: "text"; text: string },
								...ImageContent[],
							]),
					{
						...options,
						sdkRunCapability,
						// ACP terminal settlement is owned by the correlated agent_end
						// publication. Post-prompt recovery may include independent
						// subagent work and must not hold that client-facing boundary.
						...(queuedAtDispatch ? { queuedAtDispatch: true } : {}),
					},
				),
			);
		},
		steer: async (text, clientRef) => {
			const invalid = validateRequiredPromptText("turn.steer", { text });
			if (invalid) throw Object.assign(new Error(invalid.message), { code: invalid.code });
			const retainedClientRef = normalizeClientRef(clientRef);
			if (retainedClientRef === undefined) {
				const correlation = newCorrelation();
				await sendSdkUserMessage(text, { deliverAs: "steer" });
				return { accepted: true, ...correlation };
			}
			const durable = steerReconciliation;
			const reservation = await durable.reserveSteer(retainedClientRef, text);
			if (reservation.replay) return { accepted: reservation.result.status === "accepted", ...reservation.result };
			try {
				await sendSdkUserMessage(text, { deliverAs: "steer" });
				return { accepted: true, ...(await durable.settleSteer(retainedClientRef, "accepted")) };
			} catch (error) {
				return { accepted: false, ...(await durable.settleSteer(retainedClientRef, "rejected", error)) };
			}
		},
		followUp: async text => {
			const invalid = validateRequiredPromptText("turn.follow_up", { text });
			if (invalid) throw Object.assign(new Error(invalid.message), { code: invalid.code });
			return await submit(
				"prompt",
				undefined,
				({ sdkRunCapability, ...options }) =>
					sendSdkUserMessage(text, {
						...options,
						sdkRunCapability,
						deliverAs: "followUp",
					}),
				undefined,
				false,
				// Follow-ups never start inline; ownership correlates at promotion.
				true,
			);
		},
		abort: async () => {
			await Promise.resolve(ctx.abort()).catch(() => undefined);
			return { aborted: true };
		},
		abortTerminal: terminalAbort,
		abortAndPrompt: async text => {
			const invalid = validateRequiredPromptText("turn.abort_and_prompt", { text });
			if (invalid) throw Object.assign(new Error(invalid.message), { code: invalid.code });
			await ctx.abort();
			return await submit("prompt", undefined, ({ sdkRunCapability, ...options }) =>
				sendSdkUserMessage(text, { ...options, sdkRunCapability }),
			);
		},
		answerAsk: unavailable("ask.answer"),
		answerGate: async (id, response, expectedSessionId, idempotencyKey) =>
			await trackGateResolution(
				resolveSdkWorkflowGate(
					ctx,
					"workflow.gate_answer",
					id,
					response,
					expectedSessionId,
					idempotencyKey ?? id,
					canResolveGate,
				),
			),
		approvePlan: async (id, choice, expectedSessionId) =>
			await trackGateResolution(
				resolveSdkWorkflowGate(ctx, "workflow.plan_approve", id, choice, expectedSessionId, id, canResolveGate),
			),
		invokeSkill: async (name, args, clientRef) => {
			if (!ctx.invokeSkill) return unavailable("skill.invoke")();
			if (args !== undefined && typeof args !== "string")
				throw Object.assign(new Error("skill.invoke args must be a string."), { code: "invalid_input" });
			let prepared: { name: string; path: string; lineCount?: number; cleanedArgs?: string } | undefined;
			return await submit(
				"skill",
				clientRef,
				({ sdkRunCapability, ...options }) =>
					ctx.invokeSkill!(name, args, {
						...options,
						sdkRunCapability,
						onSkillPrepared: meta => {
							prepared = meta;
						},
					}).then(result => result),
				() => ({
					name: prepared?.name ?? String(name),
					path: prepared?.path ?? "",
					...(prepared?.lineCount === undefined ? {} : { lineCount: prepared.lineCount }),
					...(prepared?.cleanedArgs === undefined ? {} : { args: prepared.cleanedArgs }),
				}),
				true,
			);
		},
		setPlanMode: on => (ctx.setPlanMode ? ctx.setPlanMode(on) : unavailable("mode.plan.set")()),
		operateGoal: (op, objective) =>
			ctx.operateGoal ? ctx.operateGoal(op as never, objective) : unavailable("mode.goal.operate")(),
		replaceTodo: items => typed("todo.replace", { items }),
		setModel: async (id, thinkingLevel) => {
			if (parseSyntheticModelId(id) !== undefined) return setSyntheticModel(id, thinkingLevel);
			// Serialize the concrete selection (and the Q13 shadow capture/reconcile)
			// against config.patch through the session admission boundary so a
			// concurrent patch cannot race the snapshot.
			const run = async () => {
				const shadowBefore =
					settings && configOverrides ? captureConfigOverridesShadow(settings, configOverrides) : undefined;
				const changed = await api.setModelTemporaryForControl(
					resolveModel(id),
					undefined,
					thinkingLevel as ThinkingLevel | undefined,
				);
				if (!changed)
					throw Object.assign(new Error("Model unavailable for this session."), { code: "unavailable" });
				if (settings && configOverrides && shadowBefore)
					reconcileConfigOverridesShadow(settings, configOverrides, shadowBefore);
				return { changed: true };
			};
			return typeof (ctx as Partial<ExtensionContext>).withSdkControlMutation === "function"
				? ctx.withSdkControlMutation!(run)
				: run();
		},
		setModelProfile: id => (ctx.setModelProfile ? ctx.setModelProfile(id) : unavailable("model.profile.set")()),
		cycleModel: () => (ctx.cycleModel ? ctx.cycleModel() : unavailable("model.cycle")()),
		setThinking: level => {
			api.setThinkingLevel(level as never);
			return { changed: true };
		},
		cycleThinking: () =>
			ctx.cycleThinkingLevel ? { level: ctx.cycleThinkingLevel() } : unavailable("thinking.cycle")(),
		setPermissionMode: mode => typed("permission_mode.set", { mode }),
		setQueueMode: (kind, mode) =>
			ctx.setQueueMode(kind as never, mode) ? { changed: true } : unavailable(`queue.${kind}_mode.set`)(),
		runCompaction: async () => {
			await ctx.compact();
			return { started: true };
		},
		setAutoCompaction: on => typed("compaction.auto.set", { on }),
		setAutoRetry: on => typed("retry.auto.set", { on }),
		abortRetry: () => typed("retry.abort"),
		executeBash: cmd => typed("bash.execute", { cmd }),
		abortBash: () => typed("bash.abort"),
		newSession: () => typed("session.new"),
		forkSession: () => typed("session.fork"),
		resumeSession: id => typed("session.resume", { id }),
		closeSession: capability =>
			typed(
				"session.close",
				capability === undefined ? {} : { [BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD]: capability },
			),
		switchSession: id => typed("session.switch", { id }),
		branchSession: entryId => typed("session.branch", { entryId }),
		renameSession: name => typed("session.rename", { name }),
		handoffSession: target => typed("session.handoff", { target }),
		exportHtml: () => typed("session.export_html"),
		patchConfig: patch => {
			if (!patch || typeof patch !== "object" || Array.isArray(patch))
				throw Object.assign(new Error("config.patch requires an object."), { code: "invalid_input" });
			if (containsSecretConfigKey(patch))
				throw Object.assign(new Error("config.patch rejects secret fields at the SDK host."), {
					code: "invalid_input",
				});
			const patchIssues = validateSettingPatch(patch as Record<string, unknown>);
			if (patchIssues.length > 0) {
				const detail = patchIssues.map(issue => `${issue.path} (${issue.detail})`).join("; ");
				throw Object.assign(new Error(`config.patch rejects invalid settings: ${detail}`), {
					code: "invalid_input",
				});
			}
			if (!settings) return unavailable("config.patch")();
			const applyPatch = async () => {
				const wasAutoroutingInactive =
					settings.get("task.autorouting.enabled") === true && !settings.getEffectiveAutorouting().active;
				const entries = Object.entries(patch as Record<string, unknown>);
				for (const [key, value] of entries) settings.set(key as never, value as never);
				if (configOverrides) for (const [key, value] of entries) configOverrides.set(key, value);
				configRevision.current += 1;
				const isAutoroutingInactiveNow =
					settings.get("task.autorouting.enabled") === true && !settings.getEffectiveAutorouting().active;
				if (isAutoroutingInactiveNow && !wasAutoroutingInactive) {
					const host = getRuntimeHost();
					if (host) {
						markAutoroutingInactive(host);
						if (host.started) host.emitAutoroutingInactiveNotice();
					}
				} else if (!isAutoroutingInactiveNow && wasAutoroutingInactive) {
					const host = getRuntimeHost();
					if (host) clearAutoroutingInactive(host);
				}
				return { patched: entries.map(([key]) => key), revision: String(configRevision.current) };
			};
			// Serialize config mutations against synthetic profile activation and
			// default-model selection so an interleaved patch can never be lost or
			// clobbered by an activation rollback. The patch itself authoritatively
			// updates the shadow, so it must NOT be wrapped in the shadow refresh
			// (that would delete the entry it just wrote on the second patch).
			if (typeof (ctx as Partial<ExtensionContext>).withSdkControlMutation === "function") {
				return ctx.withSdkControlMutation!(applyPatch);
			}
			return applyPatch();
		},
		reloadRuntime: components => typed("runtime.reload", { components }),
		login: provider => typed("auth.login", { provider }),
		registerHostTools: defs => typed("host_tools.register", { defs }),
		registerHostUri: defs => typed("host_uri.register", { defs }),
		setServiceTier: tier => typed("service_tier.set", { tier }),
		setActiveTools: async names => {
			await api.setActiveTools(
				Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [],
			);
			return { changed: true };
		},
		removeQueueMessage: id => typed("queue.message.remove", { id }),
		moveQueueMessage: (id, position) => typed("queue.message.move", { id, ...position }),
		updateQueueMessage: (id, patch) => typed("queue.message.update", { id, patch }),
		setExtensionEnabled: (id, on) => typed("extension.set_enabled", { id, on }),
		clearContext: async confirm => {
			if (!confirm)
				throw Object.assign(new Error("context.clear requires confirmation."), { code: "confirmation_required" });
			return { cleared: await ctx.clearContext() };
		},
		deleteSession: (id, confirm) => {
			if (!confirm)
				throw Object.assign(new Error("session.delete requires confirmation."), { code: "confirmation_required" });
			return typed("session.delete", { id });
		},
		moveCwd: path => typed("session.cwd.move", { path }),
		retryLast: () => typed("retry.last"),
		retryNow: () => typed("retry.now"),
		backgroundBash: () => typed("bash.background"),
		installedOperations: surfacePolicy.installedControls,
		revisionProvider: resource => (resource === "config" ? String(configRevision.current) : undefined),
	};
}

/** Register the default-session notification command without loading notification adapters. */
export function registerSdkOnlyNotificationCommand(api: ExtensionAPI): void {
	api.registerCommand("notify", {
		description: "Control notifications for this session (on, off, status).",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const command = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "status";
			if (command === "status") {
				ctx.ui.notify("Notifications are disabled for this SDK session.", "info");
				return;
			}
			if (command === "on") {
				ctx.ui.notify(
					"Notifications are unavailable in this session; start a new session with notifications configured.",
					"warning",
				);
				return;
			}
			if (command === "off") {
				ctx.ui.notify("Notifications are already disabled for this session.", "info");
				return;
			}
			ctx.ui.notify("Usage: /notify status | /notify on | /notify off", "warning");
		},
	});
}

export function masterAttestationForEffectiveHost(input: {
	masterCapability: string | undefined;
	attestationEpoch: string | undefined;
	ownerSessionId?: string;
	sessionId: string;
	pid: number;
	processIncarnation: string | undefined;
	direct: MasterRoleAttestationV2 | undefined;
}): MasterRoleAttestationV2 | undefined {
	const direct = input.direct;
	if (
		input.masterCapability === undefined ||
		input.attestationEpoch === undefined ||
		direct === undefined ||
		direct.ownerSessionId !== (input.ownerSessionId ?? input.sessionId) ||
		direct.launchPid !== input.pid ||
		direct.launchProcessIncarnation !== input.processIncarnation ||
		direct.attestationEpoch !== input.attestationEpoch
	)
		return undefined;
	return direct;
}

function masterDirectAttestation(input: {
	masterCapability: string | undefined;
	attestationEpoch: string | undefined;
	ownerSessionId?: string;
	sessionId: string;
	pid: number;
	processIncarnation: string | undefined;
}): MasterRoleAttestationV2 | undefined {
	if (
		input.masterCapability === undefined ||
		input.attestationEpoch === undefined ||
		input.processIncarnation === undefined
	)
		return undefined;
	return {
		version: 2,
		ownerSessionId: input.ownerSessionId ?? input.sessionId,
		launchPid: input.pid,
		launchProcessIncarnation: input.processIncarnation,
		role: "master",
		attestationEpoch: input.attestationEpoch,
	};
}

function sameMasterAttestation(left: MasterRoleAttestationV2, right: MasterRoleAttestationV2): boolean {
	return (
		left.version === right.version &&
		left.ownerSessionId === right.ownerSessionId &&
		left.launchPid === right.launchPid &&
		left.launchProcessIncarnation === right.launchProcessIncarnation &&
		left.role === right.role &&
		left.attestationEpoch === right.attestationEpoch
	);
}

/**
 * Establish direct master authority for the session currently hosted by this
 * process. Session identity transitions retain the master capability and epoch
 * but require a new direct attestation before their effective endpoint can
 * adopt that authority.
 */
export async function reattestMasterSessionIdentity(input: {
	index: SessionIndex;
	locator: SessionLocatorV2;
	masterCapability: string | undefined;
	attestationEpoch: string | undefined;
	ownerSessionId?: string;
	sessionId: string;
	pid: number;
	processIncarnation: string | undefined;
}): Promise<MasterRoleAttestationV2 | undefined> {
	const masterRole = masterDirectAttestation(input);
	if (!masterRole) return undefined;
	const directExists = input.index.listSessionIdentities().some(row => {
		const processIdentity = row.hostIncarnation ?? row.processIncarnation;
		return (
			row.sessionId === input.sessionId &&
			row.endpointGeneration === 0 &&
			row.pid === input.pid &&
			processIdentity === input.processIncarnation &&
			row.masterRole !== undefined &&
			sameMasterAttestation(row.masterRole, masterRole)
		);
	});
	if (!directExists) {
		await input.index.append({
			type: "host_registered",
			sessionId: input.sessionId,
			locator: input.locator,
			endpointGeneration: 0,
			pid: input.pid,
			processIncarnation: input.processIncarnation,
			masterRole,
		});
	}
	return masterRole;
}

function quiescingFrame(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	const error = { code: "session_quiescing", message: "The session endpoint is being replaced." };
	const id = typeof frame.id === "string" ? frame.id : "";
	if (frame.type === "control_request") return { type: "control_response", id, ok: false, error };
	if (frame.type === "query_request") return { type: "query_response", id, ok: false, error };
	if (frame.type === "event_replay") return { type: "event_replay_result", id, ok: false, error };
	if (frame.type === "session_activate")
		return { type: "session_activate_result", id, ok: false, status: "authority_unavailable", error };
	if (frame.type === "register_provider") return { type: "register_provider_result", id, ok: false, error };
	if (frame.type === "reverse_response")
		return { type: "transport_error", id, code: error.code, message: error.message };
	if (frame.type === "provider_heartbeat" || frame.type === "lease_release")
		return { type: "transport_error", code: "session_quiescing", message: error.message };
	return undefined;
}

/** Install a complete SDK host for a session when notifications are inactive. */
export function createSdkSessionRuntimeExtension(api: ExtensionAPI, options: CreateSdkSessionRuntimeOptions): void {
	let active:
		| {
				sessionId: string;
				sessionIdentity: string;
				runtime: SessionSdkSessionRuntime;
				revisions: RevisionStore;
				cursors: CursorRegistry;
				reconciliation: InvocationReconciliation;
				steerReconciliation: KindAwareReconciliation;
				deadlineManager: PromptDeadlineManager;
				pending: Array<{
					kind: InvocationKind;
					correlation: InvocationCorrelation;
					connectionId: string | undefined;
					sdkRunToken: string;
				}>;
				registerBroker: () => Promise<void>;
				quiesceInput: () => void;
				fenceGateResolutions: () => void;
				waitForGateResolutionQuiescence: () => Promise<void>;
				activeInvocation?: { kind: InvocationKind; correlation: InvocationCorrelation };
				drainedInvocations?: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
				attachedInvocations?: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
				openLifecycleBatches: Array<{
					epoch: number;
					invocations: Array<{
						kind: InvocationKind;
						correlation: InvocationCorrelation;
						connectionId: string | undefined;
						sdkRunToken: string;
					}>;
					attachedInvocations: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
				}>;
				disposeGate?: () => void;
				lifecycleActive: boolean;
				lifecycleEpoch: number;
				failureDiagnosticKeys: Set<string>;
				failureDiagnosticCodes: Map<string, string>;
				lifecycleTasks: Set<Promise<void>>;
				/** Failure reasons whose durable agent_failed write failed; the
				 * subsequent agent_end must re-record them before terminalizing or
				 * the record classifies terminal_ok (exact-head review P1). */
				unrecordedFailureReasons?: Map<string, { code: string; message: string }>;
		  }
		| undefined;
	type RuntimeState = NonNullable<typeof active>;
	type LifecycleBatch = RuntimeState["openLifecycleBatches"][number];
	type LifecycleOwner = { state: RuntimeState; sessionId: string; batch?: LifecycleBatch };
	const retiredLifecycleOwners = new Map<string, RuntimeState[]>();
	const retiredLifecycleOwnerTimers = new Map<RuntimeState, ReturnType<typeof setTimeout>>();
	const skillRecoveryControllers = new Map<string, AbortController>();
	const skillTerminalRecoveryControllers = new Map<string, AbortController>();
	const ambiguousLifecycleIdentities = new Set<string>();
	const lifecycleRunOwners = new Map<
		string,
		{ state: RuntimeState; batch?: LifecycleBatch; correlationKey?: string }
	>();
	const lifecycleCorrelationKey = (correlation: InvocationCorrelation): string =>
		`${correlation.commandId}:${correlation.turnId}`;
	const sessionIdentityForContext = (ctx: ExtensionContext): string | undefined => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile) return `${sessionId}\u0000${sessionFile}`;
		const stateRoot = path.join(ctx.cwd, ".gjc", "state");
		return `${sessionId}\u0000${resolveReconciliationSessionFile(undefined, stateRoot, sessionId)}`;
	};
	const lifecycleStateForContext = (
		ctx: ExtensionContext,
		type: "agent_start" | "agent_end" | "agent_failed" = "agent_start",
	): RuntimeState | undefined => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionIdentity = sessionIdentityForContext(ctx);
		if (!sessionIdentity) return undefined;
		const retired = (retiredLifecycleOwners.get(sessionId) ?? []).filter(
			owner => owner.sessionIdentity === sessionIdentity,
		);
		if (type !== "agent_start") {
			if (ambiguousLifecycleIdentities.has(sessionIdentity)) return undefined;
			if (retired.length > 1) {
				ambiguousLifecycleIdentities.add(sessionIdentity);
				return undefined;
			}
			const delayedOwner = retired.find(owner => owner.openLifecycleBatches.length > 0);
			if (delayedOwner) {
				if (active?.sessionIdentity === sessionIdentity && active.lifecycleActive) {
					ambiguousLifecycleIdentities.add(sessionIdentity);
					return undefined;
				}
				return delayedOwner;
			}
		}
		if (active?.sessionIdentity === sessionIdentity) return active;
		return retired[0];
	};
	const lifecycleStateForEvent = (
		ctx: ExtensionContext,
		type: "agent_start" | "agent_end" | "agent_failed",
		sdkRunToken: unknown,
	): RuntimeState | undefined =>
		typeof sdkRunToken === "string" && sdkRunToken.length > 0
			? lifecycleRunOwners.get(sdkRunToken)?.state
			: lifecycleStateForContext(ctx, type);
	const removeRetiredLifecycleOwner = (owner: RuntimeState): void => {
		const timer = retiredLifecycleOwnerTimers.get(owner);
		if (timer !== undefined) {
			clearTimeout(timer);
			retiredLifecycleOwnerTimers.delete(owner);
		}
		const owners = retiredLifecycleOwners.get(owner.sessionId);
		if (!owners) {
			ambiguousLifecycleIdentities.delete(owner.sessionIdentity);
			return;
		}
		const remaining = owners.filter(candidate => candidate !== owner);
		if (remaining.length === 0) retiredLifecycleOwners.delete(owner.sessionId);
		else retiredLifecycleOwners.set(owner.sessionId, remaining);
		const remainingSameIdentity = remaining.filter(candidate => candidate.sessionIdentity === owner.sessionIdentity);
		if (remainingSameIdentity.length < 2) ambiguousLifecycleIdentities.delete(owner.sessionIdentity);
		// Expiry is the final lifecycle-reference boundary. Do not retain
		// diagnostic suppression or failed-write recovery state after the owner is
		// no longer eligible to receive a delayed event.
		owner.failureDiagnosticKeys.clear();
		owner.failureDiagnosticCodes.clear();
		owner.unrecordedFailureReasons?.clear();
		for (const [token, binding] of lifecycleRunOwners) if (binding.state === owner) lifecycleRunOwners.delete(token);
	};
	const maybeRetireLifecycleOwner = (owner: RuntimeState): void => {
		if (
			owner.pending.length > 0 ||
			owner.openLifecycleBatches.length > 0 ||
			(owner.attachedInvocations?.length ?? 0) > 0 ||
			(owner.drainedInvocations?.length ?? 0) > 0 ||
			owner.lifecycleTasks.size > 0
		)
			return;
		removeRetiredLifecycleOwner(owner);
	};
	const removeLifecycleTokenAliases = (owner: RuntimeState, correlation: InvocationCorrelation): void => {
		const target = lifecycleCorrelationKey(correlation);
		for (const [token, binding] of lifecycleRunOwners) {
			if (binding.state === owner && binding.correlationKey === target) lifecycleRunOwners.delete(token);
		}
	};
	const removeLifecycleReferences = (owner: RuntimeState, correlation: InvocationCorrelation): void => {
		const target = lifecycleCorrelationKey(correlation);
		const retainedPending = owner.pending.filter(entry => lifecycleCorrelationKey(entry.correlation) !== target);
		owner.pending.splice(0, owner.pending.length, ...retainedPending);
		for (const batch of owner.openLifecycleBatches) {
			batch.invocations = batch.invocations.filter(entry => lifecycleCorrelationKey(entry.correlation) !== target);
			batch.attachedInvocations = batch.attachedInvocations.filter(
				entry => lifecycleCorrelationKey(entry.correlation) !== target,
			);
		}
		owner.openLifecycleBatches = owner.openLifecycleBatches.filter(
			batch => batch.invocations.length > 0 || batch.attachedInvocations.length > 0,
		);
		owner.drainedInvocations = owner.drainedInvocations?.filter(
			entry => lifecycleCorrelationKey(entry.correlation) !== target,
		);
		owner.attachedInvocations = owner.attachedInvocations?.filter(
			entry => lifecycleCorrelationKey(entry.correlation) !== target,
		);
		if (owner.activeInvocation && lifecycleCorrelationKey(owner.activeInvocation.correlation) === target) {
			const replacement =
				owner.openLifecycleBatches.flatMap(batch => batch.invocations)[0] ?? owner.attachedInvocations?.[0];
			owner.activeInvocation = replacement
				? { kind: replacement.kind, correlation: replacement.correlation }
				: undefined;
		}
		removeLifecycleTokenAliases(owner, correlation);
		if (owner === active) {
			const owners = new Set<string>();
			const activeBatch = owner.activeInvocation
				? owner.openLifecycleBatches.find(batch =>
						batch.invocations.some(
							entry =>
								lifecycleCorrelationKey(entry.correlation) ===
								lifecycleCorrelationKey(owner.activeInvocation!.correlation),
						),
					)
				: undefined;
			for (const entry of activeBatch?.invocations ?? [])
				if (entry.connectionId !== undefined) owners.add(entry.connectionId);
			activePromptOwnerHolder.connectionIds = owners.size > 0 ? owners : undefined;
		}
	};
	// Shared with the control surface's terminal abort: the correlated
	// agent_end publication capture (AC 19). terminalAbort installs a fresh
	// resolver before settling the abort; emitLifecycle resolves it with the
	// OBSERVED publication result when the aborted run's lifecycle event
	// lands, so the durable stopped row never claims terminalPublished without
	// observing it (review thread P2). Single slot: only the abort that
	// reaches the stopped path awaits it; a concurrent abort for the same turn
	// is settled by the durable marker transaction instead.
	const terminalPublicationCapture: {
		waiters?: Array<{ epoch: number; resolve: (observed: boolean) => void }>;
	} = {};
	// Shared with the control surface: the SDK connection owning the currently
	// active prompt/skill turn. Cleared at every agent_end (terminal lifecycle
	// boundary) so a stale owner never authorizes an abort against a later
	// turn it did not submit, and never set for agent-initiated turns (review
	// thread P1).
	const activePromptOwnerHolder: { connectionIds?: Set<string>; lifecycleEpoch?: number } = {};
	let nextLifecycleEpoch = 0;
	const skillTerminalRecoveryKeys = new Set<string>();
	const trackLifecycle = (handler: () => Promise<void>, owner: RuntimeState | undefined): Promise<void> => {
		if (!owner) return Promise.resolve();
		let task: Promise<void>;
		task = handler().finally(() => {
			owner.lifecycleTasks.delete(task);
			maybeRetireLifecycleOwner(owner);
		});
		owner.lifecycleTasks.add(task);
		return task;
	};
	const emitLifecycle = async (
		type: "agent_start" | "agent_end" | "agent_failed",
		ctx: ExtensionContext,
		failureCause?: unknown,
		maintenanceOutcome?: string,
		lifecycleOwner?: LifecycleOwner,
		terminalContent?: TurnResultContent,
		terminalHasActivity = false,
		terminalOutcome?: InvocationOutcome,
	): Promise<void> => {
		const current = lifecycleOwner?.state ?? active;
		if (!current) return;
		const failureBatch = lifecycleOwner?.batch;
		const adoptLifecycleBatch = (
			batch:
				| Array<{
						kind: InvocationKind;
						correlation: InvocationCorrelation;
						connectionId: string | undefined;
				  }>
				| undefined,
		): void => {
			if (!batch || batch.length === 0) {
				current.activeInvocation = undefined;
				current.drainedInvocations = undefined;
				current.attachedInvocations = undefined;
				if (current === active) activePromptOwnerHolder.connectionIds = undefined;
				return;
			}
			current.activeInvocation = batch[0];
			current.drainedInvocations = batch.map(({ kind, correlation }) => ({ kind, correlation }));
			current.attachedInvocations = undefined;
			const owners = new Set<string>();
			for (const entry of batch) if (entry.connectionId !== undefined) owners.add(entry.connectionId);
			if (current === active) activePromptOwnerHolder.connectionIds = owners;
		};
		let transitions: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }> = [];
		if (type === "agent_failed") {
			const activeInvocation = failureBatch?.invocations[0] ?? current.activeInvocation;
			const activeBatch = activeInvocation
				? (failureBatch ??
					current.openLifecycleBatches.find(batch =>
						batch.invocations.some(
							entry =>
								entry.correlation.commandId === activeInvocation.correlation.commandId &&
								entry.correlation.turnId === activeInvocation.correlation.turnId,
						),
					))
				: undefined;
			const fallback =
				activeBatch?.invocations ??
				current.drainedInvocations ??
				(activeInvocation ? [activeInvocation] : current.pending);
			// In-run ATTACHED correlations share the failing run: without their
			// agent_failed diagnostic the later agent_end marks them terminal_ok
			// after a failed shared run (exact-head review P1). Deduplicate by
			// correlation against the fallback set.
			const seen = new Set(fallback.map(({ correlation }) => `${correlation.commandId}:${correlation.turnId}`));
			const attached = (activeBatch?.attachedInvocations ?? current.attachedInvocations ?? []).filter(
				({ correlation }) => {
					const id = `${correlation.commandId}:${correlation.turnId}`;
					if (seen.has(id)) return false;
					seen.add(id);
					return true;
				},
			);
			transitions = [...fallback, ...attached].map(({ kind, correlation }) => ({ kind, correlation }));
		} else if (type === "agent_start") {
			current.lifecycleEpoch = ++nextLifecycleEpoch;
			if (current === active) activePromptOwnerHolder.lifecycleEpoch = current.lifecycleEpoch;
			// Mark lifecycle active even when the drain is empty: a monitor/cron
			// run started by the session has no SDK pending entry but is still a
			// real active run that later in-run promotions must attach to instead
			// of falling back to pending (review P1). Empty drains leave the
			// previous SDK owner untouched.
			current.lifecycleActive = true;
			// Drain EVERY entry admitted for this run: a continuation may promote
			// several follow-ups (each with its own requester correlation) into one
			// run, and each submitting connection must be able to terminal-abort it.
			// Entries are only created for submissions that actually start their own
			// turn (queued-while-streaming submissions never push), so a mid-prompt
			// continuation agent_start with an empty queue leaves the current owner
			// untouched (review thread P1).
			const drained = current.pending
				.splice(0)
				.filter(entry => entry.kind !== "prompt" || !current.deadlineManager.isExpiring(entry.correlation));
			if (drained.length > 0) {
				current.openLifecycleBatches.push({
					epoch: current.lifecycleEpoch,
					invocations: drained,
					attachedInvocations: [],
				});
				adoptLifecycleBatch(drained);
				if (current.activeInvocation?.kind === "prompt") {
					current.deadlineManager.onAccepted(current.activeInvocation.correlation);
				}
			} else {
				// An empty drain is an agent-initiated successor run. Clear the
				// predecessor's SDK owner and active invocation so abort ownership and
				// tool-progress renewal cannot leak into the successor.
				adoptLifecycleBatch(undefined);
			}
			transitions = drained.map(({ kind, correlation }) => ({ kind, correlation }));
		} else {
			// Pair this agent_end with the oldest unmatched start. A delayed
			// aborted-turn end that lands after a successor agent_start must
			// terminalize the aborted invocation, never the successor.
			const ended = current.openLifecycleBatches[0];
			const baseTransitions = ended
				? ended.invocations.map(({ kind, correlation }) => ({ kind, correlation }))
				: current.activeInvocation
					? [current.activeInvocation]
					: [];
			const attached = ended?.attachedInvocations ?? current.attachedInvocations ?? [];
			const seen = new Set(
				baseTransitions.map(({ correlation }) => `${correlation.commandId}:${correlation.turnId}`),
			);
			transitions = [
				...baseTransitions,
				...attached.filter(({ correlation }) => {
					const id = `${correlation.commandId}:${correlation.turnId}`;
					if (seen.has(id)) return false;
					seen.add(id);
					return true;
				}),
			];
		}
		// A delayed end belongs to the immutable epoch of the oldest unmatched
		// lifecycle batch, not the mutable session-global epoch a successor start
		// may already have advanced to. Publication proof and race retirement must
		// use the same batch identity as reconciliation.
		const eventLifecycleEpoch =
			(type === "agent_failed" || type === "agent_end") && failureBatch
				? failureBatch.epoch
				: current.lifecycleEpoch;
		const resolveTerminalPublicationWaiters = (observed: boolean): void => {
			const waiters = terminalPublicationCapture.waiters;
			if (!waiters) return;
			const matched = waiters.filter(waiter => waiter.epoch === eventLifecycleEpoch);
			const remaining = waiters.filter(waiter => waiter.epoch !== eventLifecycleEpoch);
			terminalPublicationCapture.waiters = remaining.length === 0 ? undefined : remaining;
			for (const waiter of matched) waiter.resolve(observed);
		};
		const retireEndedLifecycleBatch = (): void => {
			const ended = failureBatch ?? current.openLifecycleBatches[0];
			if (!ended) return;
			const transitionKeys = new Set(
				transitions.map(({ correlation }) => `${correlation.commandId}:${correlation.turnId}`),
			);
			if (
				!ended.invocations.some(({ correlation }) =>
					transitionKeys.has(`${correlation.commandId}:${correlation.turnId}`),
				)
			)
				return;
			const index = current.openLifecycleBatches.indexOf(ended);
			if (index >= 0) current.openLifecycleBatches.splice(index, 1);
		};
		const scheduleSkillTerminalRecovery = (invocation: {
			kind: InvocationKind;
			correlation: InvocationCorrelation;
		}): void => {
			if (invocation.kind !== "skill") return;
			const recoveryKey = `${invocation.correlation.commandId}:${invocation.correlation.turnId}`;
			if (skillTerminalRecoveryKeys.has(recoveryKey)) return;
			skillTerminalRecoveryKeys.add(recoveryKey);
			const controller = new AbortController();
			skillTerminalRecoveryControllers.set(recoveryKey, controller);
			const attempt = async (): Promise<void> => {
				try {
					const unrecorded = current.unrecordedFailureReasons?.get(recoveryKey);
					if (unrecorded !== undefined) {
						await current.reconciliation.noteTransition("skill", invocation.correlation, {
							type: "agent_failed",
							error: Object.assign(new Error(unrecorded.message), { code: unrecorded.code }),
						} as never);
						current.unrecordedFailureReasons?.delete(recoveryKey);
					}
					await current.reconciliation.noteTransition("skill", invocation.correlation, { type: "agent_end" });
					skillTerminalRecoveryKeys.delete(recoveryKey);
					current.failureDiagnosticKeys.delete(recoveryKey);
					for (const batch of current.openLifecycleBatches) {
						batch.invocations = batch.invocations.filter(
							entry =>
								entry.correlation.commandId !== invocation.correlation.commandId ||
								entry.correlation.turnId !== invocation.correlation.turnId,
						);
					}
					current.openLifecycleBatches = current.openLifecycleBatches.filter(
						batch => batch.invocations.length > 0,
					);
					current.drainedInvocations = current.drainedInvocations?.filter(
						entry =>
							entry.correlation.commandId !== invocation.correlation.commandId ||
							entry.correlation.turnId !== invocation.correlation.turnId,
					);
					if (
						current.activeInvocation?.correlation.commandId === invocation.correlation.commandId &&
						current.activeInvocation.correlation.turnId === invocation.correlation.turnId
					)
						adoptLifecycleBatch(current.openLifecycleBatches[0]?.invocations);
					if (current.openLifecycleBatches.length === 0) current.lifecycleActive = false;
				} catch (error) {
					if (controller.signal.aborted) {
						skillTerminalRecoveryKeys.delete(recoveryKey);
						return;
					}
					logger.error("SDK skill lifecycle terminal recovery retrying", {
						commandId: invocation.correlation.commandId,
						turnId: invocation.correlation.turnId,
						error: sanitizePromptFailure(error),
					});
					const wait = Promise.withResolvers<void>();
					const timer = setTimeout(wait.resolve, 1_000);
					timer.unref();
					const onAbort = () => {
						clearTimeout(timer);
						wait.resolve();
					};
					controller.signal.addEventListener("abort", onAbort, { once: true });
					await wait.promise;
					controller.signal.removeEventListener("abort", onAbort);
					if (controller.signal.aborted) {
						skillTerminalRecoveryKeys.delete(recoveryKey);
						return;
					}
					return attempt();
				}
			};
			void attempt().finally(() => skillTerminalRecoveryControllers.delete(recoveryKey));
		};
		if (type === "agent_end" && isContinuingMidRunMaintenanceOutcome(maintenanceOutcome)) {
			try {
				current.runtime.emitEvent({ type, sessionId: ctx.sessionManager.getSessionId() });
			} catch {
				// Maintenance checkpoints are non-terminal lifecycle observations.
			}
			return;
		}
		const correlationKey = (correlation: InvocationCorrelation): string =>
			`${correlation.commandId}:${correlation.turnId}`;
		if (type === "agent_failed") {
			transitions = transitions.filter(
				invocation => !current.failureDiagnosticKeys.has(correlationKey(invocation.correlation)),
			);
			const diagnosticCode = sanitizePromptFailure(
				failureCause ?? Object.assign(new Error("agent run failed"), { code: "agent_failed" }),
			).code;
			for (const invocation of transitions)
				current.failureDiagnosticKeys.add(correlationKey(invocation.correlation));
			for (const invocation of transitions)
				current.failureDiagnosticCodes.set(correlationKey(invocation.correlation), diagnosticCode);
		}
		// Observe whether the lifecycle publication actually landed: a terminal
		// abort awaits this result so its durable row only claims
		// terminalPublished when the correlated agent_end event reached the
		// ring/broadcast (review thread P2). Reconciliation or event failure is
		// recorded as observed=false, never rethrown into the api handler.
		let observed = true;
		const failedTransitions: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }> = [];
		try {
			for (const invocation of transitions) {
				try {
					const reasonKey = `${invocation.correlation.commandId}:${invocation.correlation.turnId}`;
					const unrecorded = type === "agent_end" ? current.unrecordedFailureReasons?.get(reasonKey) : undefined;
					if (type === "agent_end" && invocation.kind === "prompt")
						current.deadlineManager.noteTerminalTransition(
							invocation.correlation,
							unrecorded,
							terminalContent !== undefined || terminalHasActivity || terminalOutcome !== undefined
								? ({
										content: terminalContent,
										hasActivity: terminalHasActivity,
										...(terminalOutcome?.kind === "stopped" ? { outcome: terminalOutcome } : {}),
									} satisfies PromptTerminalTransitionEvidence)
								: undefined,
						);
					if (type === "agent_end") {
						// Compound recovery (exact-head review P1): if this run's
						// agent_failed write failed, re-record the sanitized reason
						// durably BEFORE the boundary so the terminal classification is
						// failed, never terminal_ok. A failed re-record throws into the
						// catch below and retains recovery ownership.
						if (unrecorded !== undefined) {
							await current.reconciliation.noteTransition(invocation.kind, invocation.correlation, {
								type: "agent_failed",
								error: Object.assign(new Error(unrecorded.message), { code: unrecorded.code }),
							} as never);
							current.unrecordedFailureReasons?.delete(reasonKey);
						}
					}
					// agent_failed is additive diagnostic state; agent_end remains the
					// lifecycle boundary that terminalizes ownership and deadlines.
					const frame =
						type === "agent_failed"
							? {
									type,
									error:
										failureCause ?? Object.assign(new Error("agent run failed"), { code: "agent_failed" }),
								}
							: {
									type,
									...(type === "agent_end" && terminalContent !== undefined
										? { content: terminalContent }
										: {}),
									...(type === "agent_end" && terminalHasActivity ? { hasActivity: true } : {}),
									...(type === "agent_end" && terminalOutcome !== undefined
										? { outcome: terminalOutcome }
										: {}),
								};
					await current.reconciliation.noteTransition(invocation.kind, invocation.correlation, frame as never);
					if ((type as string) === "agent_end") {
						if (invocation.kind === "prompt") current.deadlineManager.clear(invocation.correlation);
					}
				} catch {
					// One broken durable transition must not strand the rest of a
					// shared-run batch. The failed record remains leased/repairable
					// and the publication is marked unobserved for terminal callers.
					observed = false;
					failedTransitions.push(invocation);
					if (type === "agent_failed") {
						// Keep the sanitized reason: the later agent_end must re-record
						// it before terminalizing, or a successful boundary write
						// classifies the failed run terminal_ok (exact-head review P1).
						if (current.unrecordedFailureReasons === undefined) current.unrecordedFailureReasons = new Map();
						current.unrecordedFailureReasons.set(
							`${invocation.correlation.commandId}:${invocation.correlation.turnId}`,
							sanitizePromptFailure(failureCause),
						);
					}
				}
			}
			const sessionId = lifecycleOwner?.sessionId ?? ctx.sessionManager.getSessionId();
			if (type === "agent_failed") {
				// Failure is a correlated diagnostic, not the terminal lifecycle boundary.
				// Publish one safe frame per invocation so clients can attribute a shared
				// run's failure without receiving provider text or an uncorrelated signal.
				const error = sanitizePromptFailure(
					failureCause ?? Object.assign(new Error("agent run failed"), { code: "agent_failed" }),
				);
				for (const invocation of transitions) {
					try {
						current.runtime.emitEvent({
							type,
							sessionId,
							...invocation.correlation,
							error,
						});
					} catch {
						observed = false;
					}
				}
			} else {
				try {
					current.runtime.emitEvent({ type, sessionId });
				} catch {
					observed = false;
				}
			}
		} catch {
			observed = false;
		}
		if (type === "agent_end" && isContinuingMidRunMaintenanceOutcome(maintenanceOutcome)) return;
		if (type === "agent_end") {
			if (current.lifecycleEpoch !== eventLifecycleEpoch) {
				// A successor agent_start won the lifecycle race while this event's
				// durable transitions were awaiting persistence. Retire the ended
				// batch before returning; otherwise it remains ahead of the successor
				// and the next agent_end is paired with stale ownership.
				for (const invocation of failedTransitions) scheduleSkillTerminalRecovery(invocation);
				retireEndedLifecycleBatch();
				const failedKeys = new Set(failedTransitions.map(({ correlation }) => correlationKey(correlation)));
				for (const invocation of transitions) {
					if (!failedKeys.has(correlationKey(invocation.correlation)))
						removeLifecycleReferences(current, invocation.correlation);
					if (!failedKeys.has(correlationKey(invocation.correlation)))
						current.failureDiagnosticKeys.delete(correlationKey(invocation.correlation));
					if (!failedKeys.has(correlationKey(invocation.correlation)))
						current.failureDiagnosticCodes.delete(correlationKey(invocation.correlation));
				}
				options.onFailureDiagnosticKeyCountForTests?.(current.failureDiagnosticKeys.size);
				resolveTerminalPublicationWaiters(observed);
				return;
			}
			if (failedTransitions.length > 0) {
				// Durable terminalization failed. Keep the recovery-owned batch and
				// its deadline leases alive so the deadline manager can replay a real
				// agent_end instead of clearing into a stale synthetic failure.
				retireEndedLifecycleBatch();
				current.lifecycleActive = false;
				current.activeInvocation = failedTransitions[0];
				current.drainedInvocations = failedTransitions;
				for (const invocation of failedTransitions) scheduleSkillTerminalRecovery(invocation);
				resolveTerminalPublicationWaiters(observed);
				return;
			}
			const ended = failureBatch ?? current.openLifecycleBatches[0];
			if (ended) {
				const index = current.openLifecycleBatches.indexOf(ended);
				if (index >= 0) current.openLifecycleBatches.splice(index, 1);
			}
			for (const invocation of transitions) removeLifecycleReferences(current, invocation.correlation);
			for (const invocation of transitions)
				current.failureDiagnosticKeys.delete(correlationKey(invocation.correlation));
			for (const invocation of transitions)
				current.failureDiagnosticCodes.delete(correlationKey(invocation.correlation));
			options.onFailureDiagnosticKeyCountForTests?.(current.failureDiagnosticKeys.size);
			for (const invocation of transitions)
				if (invocation.kind === "prompt") current.deadlineManager.clear(invocation.correlation);
			adoptLifecycleBatch(current.openLifecycleBatches[0]?.invocations);
			if (current.openLifecycleBatches.length === 0) current.lifecycleActive = false;
			// Resolve EVERY concurrent waiter for the aborted turn: the turn emits
			// exactly one agent_end, and each admitted abort of it must observe the
			// same publication result rather than a single latest-wins slot (review
			// thread P2).
			resolveTerminalPublicationWaiters(observed);
		}
	};
	api.on("agent_start", (event, ctx) => {
		const owner = lifecycleStateForEvent(ctx, "agent_start", event.sdkRunToken);
		return trackLifecycle(async () => {
			await emitLifecycle(
				"agent_start",
				ctx,
				undefined,
				undefined,
				owner ? { state: owner, sessionId: owner.sessionId } : undefined,
			);
			if (owner && typeof event.sdkRunToken === "string" && event.sdkRunToken.length > 0) {
				const batch = owner.openLifecycleBatches.at(-1);
				const entry = batch?.invocations.find(item => item.sdkRunToken === event.sdkRunToken);
				const previous = lifecycleRunOwners.get(event.sdkRunToken);
				lifecycleRunOwners.set(event.sdkRunToken, {
					state: owner,
					batch,
					...(previous?.correlationKey !== undefined
						? { correlationKey: previous.correlationKey }
						: entry
							? { correlationKey: lifecycleCorrelationKey(entry.correlation) }
							: {}),
				});
			}
		}, owner);
	});
	api.on("agent_end", (event, ctx) => {
		const tokenBinding =
			typeof event.sdkRunToken === "string" ? lifecycleRunOwners.get(event.sdkRunToken) : undefined;
		const owner = tokenBinding?.state ?? lifecycleStateForEvent(ctx, "agent_end", event.sdkRunToken);
		// Capture the oldest unmatched batch synchronously. A successor may start
		// while the failed diagnostic persists; that must not retarget the
		// predecessor's reason or terminal boundary to the successor invocation.
		const endedBatch = tokenBinding?.batch ?? owner?.openLifecycleBatches[0];
		const lifecycleOwner = owner
			? {
					state: owner,
					sessionId: owner.sessionId,
					...(endedBatch ? { batch: endedBatch } : {}),
				}
			: undefined;
		const currentInvocation = endedBatch?.invocations[0] ?? owner?.activeInvocation;
		const failure = providerFailureFromAgentEnd(event);
		const failureCandidates = endedBatch
			? [...endedBatch.invocations, ...endedBatch.attachedInvocations]
			: currentInvocation
				? [currentInvocation]
				: [];
		const genericFailureKeys = failureCandidates
			.map(({ correlation }) => lifecycleCorrelationKey(correlation))
			.filter(key => owner?.failureDiagnosticCodes.get(key) === "agent_failed");
		const hasExistingFailure = failureCandidates.some(({ correlation }) =>
			owner?.failureDiagnosticKeys.has(lifecycleCorrelationKey(correlation)),
		);
		const failureAlreadyPublished = failure === undefined || (hasExistingFailure && genericFailureKeys.length === 0);
		const terminalEvidence = promptTerminalEvidenceFromAgentEnd(event);
		const terminalOutcome =
			event.stopReason === "cancelled"
				? ({ kind: "stopped", reason: "cancelled", provenance: "client_cancel" } as const)
				: failure === undefined
					? undefined
					: canonicalFailedOutcome(failure);
		return trackLifecycle(async () => {
			if (failure && !failureAlreadyPublished) {
				for (const key of genericFailureKeys) owner?.failureDiagnosticKeys.delete(key);
				await emitLifecycle("agent_failed", ctx, failure, undefined, lifecycleOwner);
			}
			await emitLifecycle(
				"agent_end",
				ctx,
				undefined,
				event.stopReason === "maintenance" ? event.maintenanceOutcome : undefined,
				lifecycleOwner,
				terminalEvidence.content,
				terminalEvidence.hasActivity,
				terminalOutcome,
			);
		}, owner).finally(() => {
			if (typeof event.sdkRunToken === "string" && lifecycleRunOwners.get(event.sdkRunToken)?.state === owner)
				lifecycleRunOwners.delete(event.sdkRunToken);
		});
	});
	api.on("agent_failed", (event, ctx) => {
		const tokenBinding =
			typeof event.sdkRunToken === "string" ? lifecycleRunOwners.get(event.sdkRunToken) : undefined;
		const owner = tokenBinding?.state ?? lifecycleStateForEvent(ctx, "agent_failed", event.sdkRunToken);
		const failedBatch = tokenBinding?.batch ?? owner?.openLifecycleBatches[0];
		return trackLifecycle(
			async () =>
				emitLifecycle(
					"agent_failed",
					ctx,
					event.error,
					undefined,
					owner
						? {
								state: owner,
								sessionId: owner.sessionId,
								...(failedBatch ? { batch: failedBatch } : {}),
							}
						: undefined,
				),
			owner,
		);
	});
	api.on("turn_start", async (_event, ctx) => {
		const current = lifecycleStateForContext(ctx, "agent_start");
		if (!current) return;
		await current.registerBroker();
		current.runtime.emitEvent({ type: "turn_start", sessionId: ctx.sessionManager.getSessionId() });
	});
	const consumedMasterNonces = new Map<string, number>();
	api.on("turn_end", (_event, ctx) =>
		lifecycleStateForContext(ctx, "agent_end")?.runtime.emitEvent({
			type: "turn_end",
			sessionId: ctx.sessionManager.getSessionId(),
		}),
	);
	// Tool activity renews the deadline of EVERY prompt correlation attached to
	// the active run — the root invocation plus any in-run consumed follow-ups
	// sharing it — not only the head, or an attached correlation would
	// false-fire prompt_deadline_exceeded during a long shared run.
	const renewAttributableProgress = (eventType: string, ctx: ExtensionContext): void => {
		// Tool events do not carry an SDK run token. Prefer the lifecycle-active
		// runtime for the current session so a retained predecessor cannot make a
		// live replacement look ambiguous and suppress its lease renewal.
		const current = lifecycleStateForContext(ctx, "agent_start");
		if (!current) return;
		// Renew only invocations adopted by the CURRENT run: the live lifecycle
		// batch plus in-run attachments. drainedInvocations may still hold
		// invocations retained only by the failedTransitions recovery path (their
		// run already ended), whose leases must NOT be renewed by an unrelated
		// successor run's tool activity (#4668 review P3) — renewal there
		// postpones the bounded terminal replay up to maxMs while durable writes
		// keep failing. In-run attachments are not in any batch yet (no
		// agent_start follows for them), so they renew through
		// attachedInvocations instead.
		const activeInvocation = current.activeInvocation;
		const activeBatch = activeInvocation
			? current.openLifecycleBatches.find(batch =>
					batch.invocations.some(
						entry =>
							entry.correlation.commandId === activeInvocation.correlation.commandId &&
							entry.correlation.turnId === activeInvocation.correlation.turnId,
					),
				)
			: undefined;
		// A delayed predecessor end may leave its batch at index zero after a
		// successor start. Renew the batch containing the active invocation, never
		// the oldest unmatched batch. An agent-initiated run has no SDK root batch;
		// only its explicitly attached in-run correlations are attributable.
		const liveRenewalSet = activeBatch
			? [...activeBatch.invocations, ...activeBatch.attachedInvocations]
			: current.lifecycleActive && activeInvocation === undefined
				? (current.attachedInvocations ?? [])
				: [];
		const seen = new Set<string>();
		for (const invocation of liveRenewalSet) {
			const correlationKey = `${invocation.correlation.commandId}:${invocation.correlation.turnId}`;
			if (seen.has(correlationKey)) continue;
			seen.add(correlationKey);
			if (invocation.kind === "prompt")
				current.deadlineManager.onAttributableEvent(invocation.correlation, eventType);
		}
	};
	api.on("tool_execution_start", async (_event, ctx) => {
		renewAttributableProgress("tool_execution_start", ctx);
	});
	api.on("tool_execution_end", async (_event, ctx) => {
		renewAttributableProgress("tool_execution_end", ctx);
	});
	const errorCode = (error: unknown): string | undefined =>
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: undefined;
	const startRuntime = async (ctx: ExtensionContext): Promise<void> => {
		if (active) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const stateRoot = path.join(ctx.cwd, ".gjc", "state");
		const token = crypto.randomBytes(24).toString("base64url");
		const transport = await options.createTransport({ sessionId, stateRoot, token });
		const revisions = new RevisionStore(sessionId, Date.now, { storageDir: stateRoot });
		const cursors = new CursorRegistry(token, revisions);
		const sessionFile =
			(typeof ctx.sessionManager.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined) ??
			resolveReconciliationSessionFile(undefined, stateRoot, sessionId);
		const sessionIdentity = `${sessionId}\u0000${sessionFile}`;
		const reconciliationStore =
			options.terminalAbortSeams?.getReconciliationStore?.() ??
			createReconciliationStore({ sessionFile, sessionId });
		const reconciliation = createInvocationReconciliation({ store: reconciliationStore });
		await reconciliation.hydrate();
		const steerReconciliation = createKindAwareReconciliation({
			store: reconciliationStore as never,
			ownedKinds: ["steer"],
		});
		await steerReconciliation.hydrateFromStore();
		const deadlineManager = new PromptDeadlineManager({
			reconciliation,
			getLeaseMs: () => {
				const v = options.settings?.get("sdk.promptDeadlineMs" as never) as number | undefined;
				return typeof v === "number" && Number.isFinite(v) ? v : 1_800_000;
			},
			getMaxMs: () => {
				const v = options.settings?.get("sdk.promptMaxRuntimeMs" as never) as number | undefined;
				return typeof v === "number" && Number.isFinite(v) ? v : 21_600_000;
			},
			onExpired: correlation => {
				const owner = lifecycleOwnerHolder.state;
				if (!owner) return;
				removeLifecycleReferences(owner, correlation);
				maybeRetireLifecycleOwner(owner);
			},
		});
		const pending: Array<{
			kind: InvocationKind;
			correlation: InvocationCorrelation;
			connectionId: string | undefined;
			sdkRunToken: string;
		}> = [];
		for (const { correlation, acceptedAt, deadlineMaxAt } of reconciliation.listDeadlineRecoveryPendingPrompts())
			deadlineManager.recoverPending(correlation, acceptedAt, deadlineMaxAt);
		const openLifecycleBatches: Array<{
			epoch: number;
			invocations: Array<{
				kind: InvocationKind;
				correlation: InvocationCorrelation;
				connectionId: string | undefined;
				sdkRunToken: string;
			}>;
			attachedInvocations: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
		}> = [];
		const configRevision = { current: 0 };
		let acceptingGateResolutions = true;
		const inFlightGateResolutions = new Set<Promise<unknown>>();
		const trackGateResolution = <T>(resolution: Promise<T>): Promise<T> => {
			const tracked = resolution.finally(() => inFlightGateResolutions.delete(tracked));
			inFlightGateResolutions.add(tracked);
			return tracked;
		};
		const waitForGateResolutionQuiescence = async (): Promise<void> => {
			const settled = Promise.allSettled(inFlightGateResolutions);
			const timeout = Bun.sleep(GATE_RESOLUTION_QUIESCENCE_MS).then(() => {
				logger.warn("SDK workflow gate resolution drain timed out; proceeding with uncertain outcomes.");
			});
			await Promise.race([settled, timeout]);
		};
		let runtime: SessionSdkSessionRuntime;
		const surfaceFactory = createSdkSurfaceFactory({
			ctx,
			id: sessionId,
			api,
			reconciliation,
			turnResultLookup: selector => reconciliation.lookupResult(selector.kind, selector),
			steerStatusLookup: selector => steerReconciliation.lookupSteer(selector),
			configOverrides: options.configOverrides,
			settings: options.settings,
			getRuntimeHost: () => runtime?.host,
		});
		const queryHandlers = new QueryHandlers(surfaceFactory.query, sessionId, revisions, cursors);
		const inputGate = { quiescing: false };
		const lifecycleOwnerHolder: { state?: RuntimeState; quiescing: boolean } = { quiescing: false };
		const skillRecoveryTasks = new Map<string, Promise<void>>();
		const scheduleSkillRecovery = (
			correlation: InvocationCorrelation,
			failureIntent?: { code: string; message: string },
		): void => {
			const key = lifecycleCorrelationKey(correlation);
			if (skillRecoveryTasks.has(key)) return;
			const controller = new AbortController();
			skillRecoveryControllers.set(key, controller);
			const intent = failureIntent;
			const task = (async (): Promise<void> => {
				let failureRecorded = intent === undefined;
				for (;;) {
					if (controller.signal.aborted) return;
					try {
						if (!failureRecorded) {
							await reconciliation.noteTransition("skill", correlation, {
								type: "agent_failed",
								error: Object.assign(new Error(intent?.message ?? "skill invocation failed"), {
									code: intent?.code ?? "skill_failed",
								}),
							} as never);
							failureRecorded = true;
						}
						await reconciliation.noteTransition("skill", correlation, { type: "agent_end" });
						return;
					} catch (error) {
						if (controller.signal.aborted) return;
						logger.error("SDK skill lifecycle recovery retrying", {
							commandId: correlation.commandId,
							turnId: correlation.turnId,
							error: sanitizePromptFailure(error),
						});
						const wait = Promise.withResolvers<void>();
						const timer = setTimeout(wait.resolve, 1_000);
						timer.unref();
						const onAbort = () => {
							clearTimeout(timer);
							wait.resolve();
						};
						controller.signal.addEventListener("abort", onAbort, { once: true });
						await wait.promise;
						controller.signal.removeEventListener("abort", onAbort);
					}
				}
			})();
			skillRecoveryTasks.set(key, task);
			void task.finally(() => {
				skillRecoveryTasks.delete(key);
				skillRecoveryControllers.delete(key);
			});
		};
		// Durable-first bounded terminalization for accepted submissions that leave
		// their queue or race a run WITHOUT consumption (exact-head review: clearing
		// the lease before the durable writes strands the row accepted with no
		// recovery owner when persistence fails, and an agent_failed write that
		// silently fails lets the following agent_end terminalize the cancellation
		// as terminal_ok). The reason MUST be durable before the terminal boundary
		// lands, and the lease is only released after durable terminalization.
		const terminalizeAbandonedSubmission = (
			kind: InvocationKind,
			correlation: InvocationCorrelation,
			error: { code: string; message: string },
		): void => {
			if (lifecycleOwnerHolder.state) removeLifecycleTokenAliases(lifecycleOwnerHolder.state, correlation);
			const attempt = async (remaining: number): Promise<void> => {
				try {
					// 1. Record the failure reason durably FIRST. If this write fails,
					// never fall through to agent_end: the record still has no error,
					// so the terminal boundary would classify it terminal_ok.
					await reconciliation.noteTransition(kind, correlation, {
						type: "agent_failed",
						error: Object.assign(new Error(error.message), { code: error.code }),
					} as never);
				} catch (reasonError) {
					if (remaining <= 1) {
						// Prompts use the deadline lease; skills have no prompt lease and
						// must use their kind-aware durable retry owner instead.
						if (kind === "skill")
							scheduleSkillRecovery(correlation, { code: error.code, message: error.message });
						else
							deadlineManager.noteTerminalTransition(correlation, { code: error.code, message: error.message });
						logger.error("SDK abandoned submission failed to record its failure reason", {
							kind,
							commandId: correlation.commandId,
							turnId: correlation.turnId,
							error: sanitizePromptFailure(reasonError),
						});
						return;
					}
					await Bun.sleep(1_000);
					return attempt(remaining - 1);
				}
				try {
					// 2. Terminal boundary. The durable error from step 1 makes this
					// classify as failed, never terminal_ok.
					await reconciliation.noteTransition(kind, correlation, { type: "agent_end" });
					// 3. Release recovery ownership ONLY after durable terminalization.
					deadlineManager.clear(correlation);
				} catch (transitionError) {
					// Keep prompt recovery leased; skill recovery has no prompt lease.
					if (kind === "skill") scheduleSkillRecovery(correlation);
					else deadlineManager.noteTerminalTransition(correlation, { code: error.code, message: error.message });
					logger.error("SDK abandoned submission failed to terminalize", {
						kind,
						commandId: correlation.commandId,
						turnId: correlation.turnId,
						error: sanitizePromptFailure(transitionError),
					});
				}
			};
			void attempt(3);
		};

		const controlSurface = createControlSurface(
			ctx,
			api,
			reconciliation,
			(kind, correlation, connectionId, startsOwnTurn, sdkRunToken) => {
				const owner = lifecycleOwnerHolder.state;
				if (lifecycleOwnerHolder.quiescing) {
					terminalizeAbandonedSubmission(kind, correlation, {
						code: "session_quiescing",
						message: "Session endpoint was replaced before the invocation started.",
					});
					return;
				}
				if (sdkRunToken && owner)
					lifecycleRunOwners.set(sdkRunToken, {
						state: owner,
						correlationKey: lifecycleCorrelationKey(correlation),
					});
				// Only submissions that start their OWN turn get a pending entry: a
				// steering-queued submission consumed inside the current run never
				// emits the agent_start that would consume the entry, so leaving it
				// queued would assign its stale connection as owner of a later
				// agent-initiated turn (review thread P1).
				if (startsOwnTurn) pending.push({ kind, correlation, connectionId, sdkRunToken });
				// Anchor the zero-progress deadline at durable acceptance, not at
				// agent_start (#4668): an accepted own-turn prompt that wedges
				// between acceptance and run start (provider/credential/compaction
				// preflight) never emits agent_start, so a lease created only at
				// agent_start would leave it accepted with zero activity forever.
				// Queued submissions (startsOwnTurn === false) are leased at
				// promotion/agent_start instead, so a prompt waiting behind a
				// legitimately long turn never false-fires. The agent_start
				// re-entry in emitLifecycle is a no-op for an existing lease.
			},
			correlation => deadlineManager.onAccepted(correlation),
			steerReconciliation,
			(kind, correlation, connectionId, sdkRunToken, promotion) => {
				const bindPromotedToken = (batch?: LifecycleBatch): void => {
					const owner = lifecycleOwnerHolder.state;
					if (sdkRunToken && owner)
						lifecycleRunOwners.set(sdkRunToken, {
							state: owner,
							batch,
							correlationKey: lifecycleCorrelationKey(correlation),
						});
				};
				if (lifecycleOwnerHolder.quiescing) {
					terminalizeAbandonedSubmission(kind, correlation, {
						code: "session_quiescing",
						message: "Session endpoint was replaced before the invocation started.",
					});
					return;
				}
				// Lease at the ACTUAL promotion boundary (#4668 review): a promoted
				// submission that wedges before its run's agent_start must still
				// terminalize boundedly instead of remaining accepted forever.
				if (kind === "prompt") deadlineManager.onAccepted(correlation);
				if (promotion?.removed) {
					// The queued submission was REMOVED from its queue before
					// consumption (queue.message.remove, queue editing, clearQueue, or
					// the terminal-abort purge). No run will ever adopt it, so retire
					// any pending ownership entry, drop the lease, and terminalize as a
					// bounded client-visible failure — never accepted forever (#4668
					// review P1). agent_failed records the reason; agent_end is the
					// terminal boundary.
					const pendingIdx = pending.findIndex(
						entry =>
							entry.correlation.commandId === correlation.commandId &&
							entry.correlation.turnId === correlation.turnId,
					);
					if (pendingIdx >= 0) pending.splice(pendingIdx, 1);
					terminalizeAbandonedSubmission(kind, correlation, {
						code: "cancelled",
						message: "Queued prompt was removed before consumption.",
					});
					return;
				}
				if (promotion?.startsOwnRun !== false) {
					// A submission PROMOTED to its own run (finished prompt unwinding)
					// starts with an empty pending queue at its agent_start; create the
					// entry at promotion so the submitting connection owns that turn
					// (review thread P2).
					pending.push({ kind, correlation, connectionId, sdkRunToken });
					return;
				}
				// Consumed INSIDE the currently running turn: no new agent_start
				// follows for it, so a pending entry would be drained by an
				// UNRELATED later agent_start and hand the connection ownership of
				// a turn it did not start, plus a false prompt_deadline_exceeded
				// (#4668 review). Attach the submitter to the in-flight run
				// immediately: it shares that run's ownership and terminalizes
				// with it.
				const current = active;
				if (current?.lifecycleActive) {
					// If this correlation was already admitted as own-run via the
					// idle snapshot (onAccepted -> pending) but later diverted to
					// steering and consumed in-run, move it from pending to the
					// active run so a later unrelated agent_start cannot re-drain it
					// (dispatch-race P1).
					const pendingIdx = pending.findIndex(
						entry =>
							entry.correlation.commandId === correlation.commandId &&
							entry.correlation.turnId === correlation.turnId,
					);
					if (pendingIdx >= 0) pending.splice(pendingIdx, 1);
					// In-run consumed steering tracks deadline but must NOT gain
					// root turn.abort authority (review P1). The same correlation can
					// be reported twice — once by the synchronous dispatch-race
					// disposition at queue time and again when the steering batch is
					// actually consumed — so attach idempotently (#4668 review P1).
					if (current.drainedInvocations === undefined)
						current.drainedInvocations = current.activeInvocation ? [current.activeInvocation] : [];
					if (current.attachedInvocations === undefined) current.attachedInvocations = [];
					const activeBatch = current.activeInvocation
						? current.openLifecycleBatches.find(batch =>
								batch.invocations.some(
									entry =>
										entry.correlation.commandId === current.activeInvocation?.correlation.commandId &&
										entry.correlation.turnId === current.activeInvocation?.correlation.turnId,
								),
							)
						: undefined;
					const alreadyAttached = current.drainedInvocations.some(
						entry =>
							entry.correlation.commandId === correlation.commandId &&
							entry.correlation.turnId === correlation.turnId,
					);
					if (!alreadyAttached) current.drainedInvocations.push({ kind, correlation });
					if (
						!current.attachedInvocations.some(
							entry =>
								entry.correlation.commandId === correlation.commandId &&
								entry.correlation.turnId === correlation.turnId,
						)
					)
						current.attachedInvocations.push({ kind, correlation });
					if (
						activeBatch &&
						!activeBatch.attachedInvocations.some(
							entry =>
								entry.correlation.commandId === correlation.commandId &&
								entry.correlation.turnId === correlation.turnId,
						)
					)
						activeBatch.attachedInvocations.push({ kind, correlation });
					bindPromotedToken(activeBatch);
					return;
				}
				// No in-flight run visible and this is an in-run consumption
				// racing agent_end (review P1): do not park in pending for the
				// next unrelated run. Drop and terminalize boundedly.
				const pendingIdx = pending.findIndex(
					entry =>
						entry.correlation.commandId === correlation.commandId &&
						entry.correlation.turnId === correlation.turnId,
				);
				if (pendingIdx >= 0) pending.splice(pendingIdx, 1);
				terminalizeAbandonedSubmission(kind, correlation, {
					code: "busy",
					message: "in-run promotion raced turn end",
				});
			},
			surfaceFactory.policy,
			options.settings,
			options.configOverrides,
			configRevision,
			() => runtime?.host,
			options.terminalAbortSeams,
			terminalPublicationCapture,
			activePromptOwnerHolder,
			(
				kind: InvocationKind,
				correlation: InvocationCorrelation,
				leaseRelease?: "always" | "recover-failure" | "recover-terminal",
				failureIntent?: { code: string; message: string },
			) => {
				// An accepted submission that settles WITHOUT starting (a rejection
				// after acceptance) must not leave its pending entry behind: remove
				// the matching correlation so a later agent-initiated turn never
				// inherits the failed submission's connection as owner (review
				// thread P1).
				if (!lifecycleOwnerHolder.quiescing) {
					const index = pending.findIndex(entry => entry.correlation === correlation);
					if (index >= 0) {
						const [removed] = pending.splice(index, 1);
						if (removed && lifecycleRunOwners.get(removed.sdkRunToken)?.state === lifecycleOwnerHolder.state)
							lifecycleRunOwners.delete(removed.sdkRunToken);
					}
				}
				// Release the acceptance-anchored lease ONLY when the durable row is
				// already terminal (exact-head review #4): clearing it before the
				// settlement writes land strands the row accepted with no recovery
				// owner if persistence fails. When the row is not terminal yet, the
				// lease stays armed as the bounded recovery owner, and the deadline
				// manager self-clears it at expiry once the durable row IS terminal —
				// no phantom prompt_deadline_exceeded over the real outcome.
				if (leaseRelease === "always") {
					deadlineManager.clear(correlation);
					return;
				}
				if (leaseRelease === "recover-failure" && failureIntent !== undefined) {
					if (kind === "skill") {
						scheduleSkillRecovery(correlation, failureIntent);
						return;
					}
					// Compound failure-plus-terminal recovery: the settlement's durable
					// writes failed, so the lease stays armed as the recovery owner and its
					// replay re-records the failure reason before agent_end (exact-head
					// review HIGH: a bare terminal replay made rejections terminal_ok).
					deadlineManager.noteTerminalTransition(correlation, failureIntent);
					return;
				}
				if (leaseRelease === "recover-terminal") {
					if (kind === "skill") {
						scheduleSkillRecovery(correlation);
						return;
					}
					deadlineManager.noteTerminalTransition(correlation);
					return;
				}
				const settledRow = reconciliation.lookup(kind, correlation) as { status?: string };
				if (settledRow.status === "terminal_ok" || settledRow.status === "failed")
					deadlineManager.clear(correlation);
			},
			() => acceptingGateResolutions,
			trackGateResolution,
			options.onInvocationCompletionReconciledForTests,
		);
		const installProviderDefinitions = (capability: string, definitions: unknown): void => {
			if (capability === "permission") {
				ctx.setSdkPermissionProvider?.(async (toolCall, permissionOptions, signal) => {
					const result = await runtime.host.reverse.request(
						"permission",
						"request",
						{ toolCall, options: permissionOptions },
						signal,
					);
					if (!result || typeof result !== "object")
						throw new Error("permission provider returned an invalid response");
					const response = result as { outcome?: unknown; optionId?: unknown; kind?: unknown };
					if (response.outcome === "cancelled") return { outcome: "cancelled" };
					if (response.outcome === "selected" && typeof response.optionId === "string")
						return {
							outcome: "selected",
							optionId: response.optionId,
							...(typeof response.kind === "string" ? { kind: response.kind as never } : {}),
						};
					throw new Error("permission provider returned an invalid response");
				});
				return;
			}
			if (capability !== "fs") return;
			const names = new Set(
				(Array.isArray(definitions) ? definitions : [])
					.map(definition =>
						definition && typeof definition === "object" ? (definition as { name?: unknown }).name : undefined,
					)
					.filter((name): name is string => typeof name === "string"),
			);
			const canRead = names.size === 0 || names.has("fs.readTextFile");
			const canWrite = names.size === 0 || names.has("fs.writeTextFile");
			const bridge = {
				capabilities: { readTextFile: canRead, writeTextFile: canWrite },
				deferAgentInitiatedTurns: true,
				...(canRead
					? {
							readTextFile: async (params: unknown) => {
								const result = await runtime.host.reverse.request("fs", "fs.readTextFile", params);
								if (
									!result ||
									typeof result !== "object" ||
									typeof (result as { content?: unknown }).content !== "string"
								)
									throw new Error("fs provider returned an invalid read response");
								return (result as { content: string }).content;
							},
						}
					: {}),
				...(canWrite
					? {
							writeTextFile: async (params: unknown) => {
								await runtime.host.reverse.request("fs", "fs.writeTextFile", params);
							},
						}
					: {}),
			};
			ctx.setSdkClientBridge?.(bridge);
		};
		const removeProviderDefinitions = (capability: string): void => {
			if (capability === "permission") ctx.setSdkPermissionProvider?.(undefined);
			if (capability === "fs") ctx.setSdkClientBridge?.(undefined);
		};
		runtime = new SessionSdkSessionRuntime({
			transport,
			eventRevision: () =>
				typeof (ctx as Partial<ExtensionContext>).getTranscript === "function"
					? ctx.getTranscript().length
					: undefined,
			masterCapabilityVerify: frame =>
				verifyMasterCapabilityFrame({
					frame,
					expectedCapability: options.masterCapability,
					expectedEpoch: options.masterAttestationEpoch,
					replay: consumedMasterNonces,
				}),
			onFrameAdmission: (_connectionId, frame) =>
				inputGate.quiescing ? quiescingFrame(frame as Record<string, unknown>) : undefined,
			control: async (connectionId, frame) => {
				options.onFrameAdmitted?.();
				const request = controlRequestFromFrame(frame as Record<string, unknown>);
				// Scope preflight cancellation to the REQUESTING SDK connection: the
				// requester preflight buckets are keyed by this context, so a
				// terminal abort from one client must never cancel another client's
				// pending preflight (review thread P1).
				return sdkControlRequesterContext.run(connectionId, () =>
					dispatchControl(
						controlSurface,
						OPERATIONS.find(operation => operation.kind === "control" && operation.sdkId === request.operation),
						request,
					),
				);
			},
			query: async (connectionId, frame) => {
				const request = frame as Record<string, unknown>;
				return queryHandlers.dispatch({
					id: typeof request.id === "string" ? request.id : undefined,
					query: typeof request.query === "string" ? request.query : "",
					input:
						request.input && typeof request.input === "object" && !Array.isArray(request.input)
							? (request.input as Record<string, unknown>)
							: undefined,
					cursor: typeof request.cursor === "string" ? request.cursor : undefined,
					connectionId,
				});
			},
			onRequest: options.onSdkRequest,
			onControlResponseDelivery: async (_connectionId, request, response, outcome) => {
				// Strict key validation: a malformed retry (e.g. numeric
				// idempotencyKey) rejected by dispatch must NEVER hash to the same
				// key as a legitimate stored string and advance its response state
				// (review thread P2).
				if (
					!reconciliationStore ||
					request.operation !== "turn.abort" ||
					typeof request.idempotencyKey !== "string" ||
					typeof request.input !== "object" ||
					request.input === null ||
					(request.input as { mode?: unknown }).mode !== "terminal"
				)
					return;
				const rawInput = request.input as Record<string, unknown>;
				const operatorAuthorized = hasBrokerRuntimeAbortCapability(rawInput);
				const { [BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: _capability, ...publicInput } = rawInput;
				const abortIdentity = terminalAbortIdentity(publicInput, operatorAuthorized);
				if (!abortIdentity) return;
				const keyHash = crypto.createHash("sha256").update(String(request.idempotencyKey)).digest("hex");
				const inputHash = abortIdentity.inputHash;
				// Hash the ACTUAL written response payload: the durable state may only
				// advance when the written response corresponds to the row's payload.
				// When more than 256 concurrent requests evict an in-flight abort from
				// the dispatch cache, a same-key retry can return pending_replay while
				// the original is still terminalizing — matching only key+input would
				// mark the original marker sent for the retry's uncertainty response,
				// and the original's later stopped CAS would replace the payload hash
				// without resetting the state, making durable replay claim the stopped
				// payload was sent when only the pending response was written (review
				// thread P2). A final non-pending row whose stored hash is the input
				// placeholder (no_effect/uncertain) still advances: its own response is
				// the only one written for it.
				const responsePayloadHash =
					response && typeof response === "object" && "result" in response
						? crypto
								.createHash("sha256")
								.update(JSON.stringify((response as { result: unknown }).result))
								.digest("hex")
						: undefined;
				// Require EXACT payload equality: finalization now stores the precise
				// final response hash for every disposition (including uncertainty and
				// no-effect), so a pending_replay retry whose payload differs can never
				// mark the durable row sent (review thread P2).
				const payloadMatches = (record: { responsePayloadHash?: string; replayPayloadHash?: string }) =>
					responsePayloadHash !== undefined &&
					(record.responsePayloadHash === responsePayloadHash || record.replayPayloadHash === responsePayloadHash);
				await reconciliationStore.transactTerminalState(state => ({
					scopes: state.scopes.map(record =>
						record.idempotencyKeyHash === keyHash &&
						record.idempotencyInputHash === inputHash &&
						record.responseState === "pending" &&
						payloadMatches(record)
							? { ...record, responseState: outcome === "written" ? "sent" : "failed" }
							: record,
					),
					keys: state.keys.map(record =>
						record.keyHash === keyHash &&
						record.inputHash === inputHash &&
						record.responseState === "pending" &&
						payloadMatches(record)
							? { ...record, responseState: outcome === "written" ? "sent" : "failed" }
							: record,
					),
				}));
			},
			installProviderDefinitions,
			onProviderDefinitionsRemoved: removeProviderDefinitions,
			afterControlResponse: async (_connectionId, request, response) => {
				if (request.operation === "session.close" && response.ok === true) ctx.shutdown();
			},
		});
		if (isAutoroutingInactive(api)) markAutoroutingInactive(runtime.host);
		const disposeWorkflowGate = ctx.workflowGate?.onGateEmitted?.(gate =>
			runtime.emitEvent({ kind: "workflow_gate", payload: gate }),
		);
		// Every fold (steer, chord, auto-background timer, `bash.background`)
		// publishes one replayable `bash_folded` frame; `runtime.jobs.list`
		// `foldReason` remains the source of truth clients reconcile against after
		// a replay, since a replayed frame may describe a job that has since ended.
		const disposeFold = ctx.onJobFold?.(event => {
			try {
				runtime.emitEvent({
					type: "bash_folded",
					sessionId,
					jobId: event.jobId,
					generation: event.generation,
					reason: event.reason,
				});
			} catch (error) {
				// The fold already happened; publication failure must not affect it,
				// but it must leave evidence because a client relying on the event
				// instead of runtime.jobs.list would otherwise never learn of the fold.
				logger.warn("sdk: bash_folded publication failed", {
					jobId: event.jobId,
					reason: event.reason,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		const disposeGate = (): void => {
			disposeWorkflowGate?.();
			disposeFold?.();
		};
		let publishedEndpointUrl: string | undefined;
		let brokerRegistered = false;
		const registerBroker = async (): Promise<void> => {
			if (brokerRegistered) return;
			try {
				if (options.brokerRegistrationRequired && !options.lifecycleRequestId)
					throw new Error("Lifecycle broker registration requires a request identity.");
				await ensureBroker({ agentDir: options.agentDir });
				const index = await new SessionIndex(options.agentDir).open();
				const locator = await resolveSessionLocator(ctx.cwd, stateRoot);
				const effectiveIncarnation = processIncarnation(process.pid);
				const direct = await reattestMasterSessionIdentity({
					index,
					locator,
					masterCapability: options.masterCapability,
					attestationEpoch: options.masterAttestationEpoch,
					ownerSessionId: options.masterOwnerSessionId,
					sessionId,
					pid: process.pid,
					processIncarnation: effectiveIncarnation,
				});
				await runtime.registerWithBroker({
					register: async input => {
						if (publishedEndpointUrl === undefined)
							throw new Error("SDK transport endpoint was not published before broker registration.");
						const endpointPath = path.join(input.stateRoot, "sdk", `${input.sessionId}.json`);
						const file = await readEndpointFile(endpointPath);
						if (!file) throw new Error("SDK endpoint could not be read as a stable regular file.");
						const endpoint = JSON.parse(file.source) as Record<string, unknown>;
						if (
							endpoint.sessionId !== input.sessionId ||
							endpoint.pid !== process.pid ||
							endpoint.url !== publishedEndpointUrl ||
							endpoint.token !== transport.token
						)
							throw new Error("SDK endpoint did not match the published transport authority.");
						const endpointMtimeMs = file.mtimeMs;
						const endpointFileId = `${file.dev}:${file.ino}`;
						const masterRole = masterAttestationForEffectiveHost({
							masterCapability: options.masterCapability,
							attestationEpoch: options.masterAttestationEpoch,
							ownerSessionId: options.masterOwnerSessionId,
							sessionId: input.sessionId,
							pid: process.pid,
							processIncarnation: effectiveIncarnation,
							direct,
						});
						await index.append({
							type: "host_registered",
							...input,
							locator,
							pid: process.pid,
							endpointMtimeMs,
							endpointFileId,
							...(options.lifecycleRequestId ? { lifecycleRequestId: options.lifecycleRequestId } : {}),
							...(masterRole ? { masterRole } : {}),
						});
					},
					unregister: async input => {
						await index.append({
							type: "host_unregistered",
							...input,
							locator,
							pid: process.pid,
							...(options.lifecycleRequestId ? { lifecycleRequestId: options.lifecycleRequestId } : {}),
						});
					},
				});
				brokerRegistered = true;
			} catch (error) {
				if (options.brokerRegistrationRequired) throw error;
				logger.warn(`sdk broker registration unavailable: ${String(error)}`);
			}
		};
		const runtimeOwner: RuntimeState = {
			sessionId,
			sessionIdentity,
			runtime,
			revisions,
			cursors,
			reconciliation,
			steerReconciliation,
			deadlineManager,
			pending,
			openLifecycleBatches,
			registerBroker,
			quiesceInput: () => {
				inputGate.quiescing = true;
				lifecycleOwnerHolder.quiescing = true;
			},
			fenceGateResolutions: () => {
				acceptingGateResolutions = false;
			},
			waitForGateResolutionQuiescence,
			disposeGate,
			lifecycleActive: false,
			lifecycleEpoch: 0,
			failureDiagnosticKeys: new Set(),
			failureDiagnosticCodes: new Map(),
			lifecycleTasks: new Set(),
		};
		lifecycleOwnerHolder.state = runtimeOwner;
		active = runtimeOwner;
		try {
			publishedEndpointUrl = (await runtime.start()).url;
			await registerBroker();
		} catch (error) {
			active = undefined;
			disposeGate?.();
			try {
				await runtime.stop();
			} catch (cleanupError) {
				logger.error("sdk runtime startup cleanup failed", {
					code: errorCode(cleanupError),
					error: String(cleanupError),
				});
				const failedRuntimeOwner: RuntimeState = {
					sessionId,
					sessionIdentity,
					runtime,
					revisions,
					cursors,
					reconciliation,
					steerReconciliation,
					deadlineManager,
					pending,
					openLifecycleBatches,
					registerBroker,
					quiesceInput: () => {
						inputGate.quiescing = true;
						lifecycleOwnerHolder.quiescing = true;
					},
					fenceGateResolutions: () => {
						acceptingGateResolutions = false;
					},
					waitForGateResolutionQuiescence,
					disposeGate,
					lifecycleActive: false,
					lifecycleEpoch: 0,
					failureDiagnosticKeys: new Set(),
					failureDiagnosticCodes: new Map(),
					lifecycleTasks: new Set(),
				};
				lifecycleOwnerHolder.state = failedRuntimeOwner;
				active = failedRuntimeOwner;
				throw new AggregateError([error, cleanupError], "SDK runtime startup failed and cleanup failed.");
			}
			cursors.close();
			await revisions.close().catch(() => undefined);
			throw error;
		}
	};
	const stopActive = async (cancelSkillRecovery = false): Promise<void> => {
		const current = active;
		if (!current) return;
		if (cancelSkillRecovery) {
			for (const controller of skillRecoveryControllers.values()) controller.abort();
			for (const controller of skillTerminalRecoveryControllers.values()) controller.abort();
		}
		activePromptOwnerHolder.connectionIds = undefined;
		activePromptOwnerHolder.lifecycleEpoch = undefined;
		current.quiesceInput();
		current.fenceGateResolutions();
		try {
			await current.waitForGateResolutionQuiescence();
			if (current.lifecycleTasks.size > 0) {
				const lifecycleDrain = Promise.all([...current.lifecycleTasks]);
				const timeout = Promise.withResolvers<void>();
				const timer = setTimeout(timeout.resolve, LIFECYCLE_QUIESCENCE_MS);
				const drained = Promise.race([lifecycleDrain, timeout.promise]);
				await drained;
				clearTimeout(timer);
				if (current.lifecycleTasks.size > 0) {
					logger.warn("SDK runtime lifecycle drain timed out; durable lifecycle recovery remains authoritative.");
					options.onLifecycleDrainTimeoutForTests?.();
				}
			}
			active = undefined;
			const retainsLifecycleWork =
				current.pending.length > 0 ||
				current.openLifecycleBatches.length > 0 ||
				(current.attachedInvocations?.length ?? 0) > 0 ||
				(current.drainedInvocations?.length ?? 0) > 0 ||
				current.lifecycleTasks.size > 0;
			if (retainsLifecycleWork) {
				const owners = retiredLifecycleOwners.get(current.sessionId) ?? [];
				if (!owners.includes(current)) owners.push(current);
				retiredLifecycleOwners.set(current.sessionId, owners);
				const retryCleanup = (): void => {
					retiredLifecycleOwnerTimers.delete(current);
					if (
						current.pending.length > 0 ||
						current.openLifecycleBatches.length > 0 ||
						(current.attachedInvocations?.length ?? 0) > 0 ||
						(current.drainedInvocations?.length ?? 0) > 0 ||
						current.lifecycleTasks.size > 0
					) {
						const retry = setTimeout(retryCleanup, LIFECYCLE_QUIESCENCE_MS);
						retry.unref();
						retiredLifecycleOwnerTimers.set(current, retry);
						return;
					}
					removeRetiredLifecycleOwner(current);
				};
				const timer = setTimeout(retryCleanup, LIFECYCLE_QUIESCENCE_MS);
				timer.unref();
				retiredLifecycleOwnerTimers.set(current, timer);
			} else current.deadlineManager.clearAll();
			current.disposeGate?.();
			await current.runtime.stop();
		} catch (error) {
			// Keep the immutable owner available for a retry when transport teardown
			// fails after quiescing. Clearing `active` before stop prevents a second
			// shutdown from retrying the failed endpoint removal.
			if (active === undefined) active = current;
			logger.error("sdk runtime stop failed", { code: errorCode(error), error: String(error) });
			throw error;
		}
		current.cursors.close();
		await current.revisions.close();
	};
	api.on("session_start", async (_event, ctx) => {
		await startRuntime(ctx);
	});
	api.on("session_switch", async (_event, ctx) => {
		await stopActive();
		await startRuntime(ctx);
	});
	api.on("session_branch", async (_event, ctx) => {
		await stopActive();
		await startRuntime(ctx);
	});
	api.on("session_shutdown", async () => {
		await stopActive(true);
	});
}
