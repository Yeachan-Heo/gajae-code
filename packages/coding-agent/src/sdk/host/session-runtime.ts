import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import { AsyncJobManager } from "../../async";
import { isModelProfileProviderAvailable, projectModelProfileCatalog } from "../../config/model-profile-contract";
import { type ModelProfileDefinition, resolveProfileBindings } from "../../config/model-profiles";
import { resolveModelChainWithAuth, splitSelectorThinkingSuffix } from "../../config/model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "../../config/model-selector-value";
import { type Settings, validateSettingPatch } from "../../config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensibility/extensions";
import {
	boundCompletedTerminalScopeRows,
	boundEvictedTerminalKeys,
	collectEvictedTerminalKeys,
	findOwnedRegistrationsForTurn,
	isOwnedAttemptRegistrationIncomplete,
	settleOwnedWork,
} from "../../session/terminal-abort";
import { parseThinkingLevel } from "../../thinking";
import { ensureBroker } from "../broker/ensure";
import { SessionIndex } from "../broker/session-index";
import {
	collectAuthenticatedProfileProviders,
	parseSyntheticModelId,
	resolveSyntheticModelSelection,
	SYNTHETIC_PROVIDER_ID,
	syntheticModelInputError,
	syntheticNamespaceCollision,
} from "../model-profile-model";
import { projectQ10Models } from "../models.js";
import { formatPromptFailureForLocalLog, sanitizePromptFailure } from "../prompt-failure";
import { OPERATIONS } from "../protocol/operation-registry";
import {
	createKindAwareReconciliation,
	createReconciliationStore,
	type KindAwareReconciliation,
	resolveReconciliationSessionFile,
} from "../reconciliation-extensions";
import { type ControlSurface, controlRequestFromFrame, dispatchControl } from "./control";
import { BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD } from "./control/runtime-gate";
import { SessionSdkHost, type SessionSdkHostOptions } from "./host";
import { CursorRegistry, QueryHandlers, RevisionStore, type SessionSurface } from "./query";
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

/** Bounded completed-row retention for the SDK-only terminal reconciliation
 *  document, mirroring the bus terminal-abort implementation (review thread
 *  P2): no-active/idle aborts with unique keys and repeated active-turn
 *  markers must not grow the document without limit. */
const SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS = 256;
const SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES = 4096;

/** Bounded wait for the correlated agent_end lifecycle publication after a
 *  terminal abort settles, before the durable row may claim
 *  `terminalPublished` (review thread P2). Mirrors the full-bus path's 1s
 *  publication wait. */
const SDK_ONLY_TERMINAL_PUBLICATION_WAIT_MS = 1_000;
/** Bounded wait for in-flight workflow gate resolutions to settle during SDK
 *  runtime shutdown before proceeding with cleanup. Unresolved resolutions
 *  after this bound are abandoned — their durable broker state is the recovery
 *  authority, and outcomes are inherently uncertain. */
const GATE_RESOLUTION_QUIESCENCE_MS = 5_000;

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
}

export interface SdkOnlyInvocationRecord extends InvocationCorrelation {
	kind: InvocationKind | "terminal" | "steer";
	clientRef?: string;
	status: InvocationStatus | "dispatching" | "rejected";
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	error?: { code: string; message: string };
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
	captureTerminalAbortSteeringSnapshot?: () => void;
	abortPromptAndWaitWithTerminal: (
		handle: string,
		options: { graceMs: number; terminal?: { scope: "turn" | "owned"; expectedEpoch?: number } },
	) => Promise<{ status: string; terminalScope?: unknown }>;
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
	createTransport(input: {
		sessionId: string;
		stateRoot: string;
		token: string;
	}): SessionSdkTransport | Promise<SessionSdkTransport>;
	onSdkRequest?: SessionSdkHostOptions["onRequest"];
	/** Session settings; enables `config.patch` application on this runtime. */
	settings?: Settings;
	/** Mutable shadow of patched config values merged into query readback. */
	configOverrides?: Map<string, unknown>;
	/** Private session-owned terminal-abort capabilities; never exposed on ExtensionContext. */
	terminalAbortSeams?: SdkOnlyTerminalAbortSeams;
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
interface InvocationRecord extends InvocationCorrelation {
	kind: InvocationKind;
	clientRef?: string;
	status: InvocationStatus;
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	error?: { code: string; message: string };
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
		frame: { type: "agent_start" | "agent_end" } | { type: "agent_failed"; error: unknown },
	): Promise<void>;
	lookup(kind: InvocationKind, selector: { commandId?: string; turnId?: string; clientRef?: string }): unknown;
	lookupResult(kind: InvocationKind, selector: { commandId?: string; turnId?: string; clientRef?: string }): unknown;
	hydrate(): Promise<void>;
}

export function createInvocationReconciliation(
	options: { stateRoot?: string; sessionId?: string; store?: SdkOnlyReconciliationStore } = {},
): InvocationReconciliation {
	const ACTIVE_CAPACITY = 256;
	const TERMINAL_CAPACITY = 512;
	const TERMINAL_TTL_MS = 15 * 60_000;
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
	const persist = async (): Promise<void> => {
		if (store) {
			await store.transact(() => [...records.values()]);
			return;
		}
		if (!reconciliationFile) return;
		const run = async (): Promise<void> => {
			const directory = path.dirname(reconciliationFile);
			const temporary = `${reconciliationFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			await fs.writeFile(
				temporary,
				JSON.stringify({ version: 1, sessionId: options.sessionId, records: [...records.values()] }),
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
	const cleanup = (): void => {
		const now = Date.now();
		for (const [recordKey, record] of records) {
			if (record.terminalAt !== undefined && record.terminalAt + TERMINAL_TTL_MS <= now) records.delete(recordKey);
		}
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
				const record: InvocationRecord = { ...candidate, kind } as InvocationRecord;
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
				if (record.terminalAt === undefined && (record.status === "accepted" || record.status === "in_flight")) {
					record.status = "failed";
					record.terminalAt = Date.now();
					record.error = { code: "process_restart", message: "Reconciliation incomplete after process restart." };
				}
				if (record.status === "failed") record.error = sanitizePromptFailure(record.error);
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
			records.set(key(kind, correlation), {
				...correlation,
				kind,
				...(clientRef === undefined ? {} : { clientRef }),
				status: "accepted",
				acceptedAt: Date.now(),
			});
			if (clientRef !== undefined) reservations.delete(ref(kind, clientRef));
			reservationCounts.set(kind, Math.max(0, (reservationCounts.get(kind) ?? 1) - 1));
			await persist();
		},
		async noteTransition(kind, correlation, frame) {
			if (!correlation) return;
			const record = records.get(key(kind, correlation));
			if (!record) return;
			if (record.terminalAt !== undefined) {
				// Same late agent_failed enrichment as the kind-aware bus reconciler: a
				// failure reason may arrive on a different delivery path than the one that
				// claimed the terminal. Enrich the settled record instead of dropping it;
				// never resurrect (status/terminalAt untouched), and first reason wins.
				if (frame.type === "agent_failed" && record.error === undefined) {
					logger.error("SDK invocation failed (late)", {
						kind,
						commandId: correlation.commandId,
						turnId: correlation.turnId,
						error: formatPromptFailureForLocalLog(frame.error),
					});
					record.error = sanitizePromptFailure(frame.error);
					await persist();
				}
				return;
			}
			if (frame.type === "agent_start") {
				record.status = "in_flight";
				record.startedAt = Date.now();
			} else {
				record.status = frame.type === "agent_failed" ? "failed" : "terminal_ok";
				record.terminalAt = Date.now();
				if (frame.type === "agent_failed") {
					logger.error("SDK invocation failed", {
						kind,
						commandId: correlation.commandId,
						turnId: correlation.turnId,
						error: formatPromptFailureForLocalLog(frame.error),
					});
					record.error = sanitizePromptFailure(frame.error);
				}
			}
			await persist();
		},
		lookup(kind, selector) {
			const record = find(kind, selector);
			if (!record) return { status: "unknown" };
			const identity = {
				commandId: record.commandId,
				turnId: record.turnId,
				...(record.clientRef === undefined ? {} : { clientRef: record.clientRef }),
				acceptedAt: record.acceptedAt,
			};
			if (record.status === "accepted") return { status: "accepted", ...identity };
			if (record.status === "in_flight") return { status: "in_flight", ...identity, startedAt: record.startedAt };
			return {
				status: record.status,
				...identity,
				...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
				terminalAt: record.terminalAt,
				...(record.error === undefined ? {} : { error: record.error }),
			};
		},
		lookupResult(kind, selector) {
			const result = this.lookup(kind, selector) as Record<string, unknown>;
			return result.status === "unknown" ? result : { kind, ...result };
		},
		hydrate,
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
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const content = entry.message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content))
				return content
					.filter(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					)
					.map(block => block.text)
					.join("");
		}
		return undefined;
	};
	const getProfileCredentialSessionId = () => ctx.credentialSessionId ?? id;
	const resolveProfileAvailability = async (
		profile: ModelProfileDefinition,
		authenticatedProviders: ReadonlySet<string>,
	): Promise<{ available: boolean; defaultModel?: Model<Api> }> => {
		const rewriteSelectorProvider = (selector: string): string => {
			const slash = selector.indexOf("/");
			if (slash < 0) return selector;
			const provider = selector.slice(0, slash);
			if (authenticatedProviders.has(provider)) return selector;
			const group = (profile.alternativeProviderGroups ?? []).find(candidates => candidates.includes(provider));
			if (!group) return selector;
			const replacement = group.find(candidate => authenticatedProviders.has(candidate));
			return replacement ? replacement + selector.slice(slash) : selector;
		};
		try {
			const bindings = resolveProfileBindings(profile);
			const assignments: Array<{ value: ModelSelectorValue; isDefault: boolean }> = [];
			if (bindings.defaultSelector !== undefined) {
				assignments.push({ value: bindings.defaultSelector, isDefault: true });
			}
			for (const value of Object.values(bindings.modelRoles)) assignments.push({ value, isDefault: false });
			for (const value of Object.values(bindings.agentModelOverrides)) assignments.push({ value, isDefault: false });
			let defaultModel: Model<Api> | undefined;
			for (const assignment of assignments) {
				const selectors = normalizeModelSelectorValue(assignment.value).map(rewriteSelectorProvider);
				const hasBareSelector = selectors.some(selector => {
					const suffix = splitSelectorThinkingSuffix(selector);
					const identity = suffix.thinkingLevel ? suffix.selector : selector;
					return !identity.includes("/");
				});
				if (!assignment.isDefault && !hasBareSelector) continue;
				const resolution = await resolveModelChainWithAuth(
					selectors,
					{
						...ctx.modelRegistry,
						getAvailable: () => ctx.modelRegistry.getAvailable(),
						getApiKey: (model: Model<Api>, sessionId?: string) =>
							ctx.modelRegistry.getApiKeyForProvider(model.provider, sessionId, model.baseUrl),
					},
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
	return {
		getTranscriptEntries: () =>
			typeof (ctx as Partial<ExtensionContext>).getTranscript === "function" ? ctx.getTranscript() : [],
		getContextSnapshot: () => ({
			usage: ctx.getContextUsage(),
			systemPrompt: ctx.getSystemPrompt(),
			...getLiveState(),
		}),
		getGoalState: () =>
			typeof (ctx as Partial<ExtensionContext>).getGoalState === "function" ? ctx.getGoalState() : undefined,
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
				authenticatedProviders = await collectAuthenticatedProfileProviders(profiles, provider =>
					ctx.modelRegistry.getApiKeyForProvider(provider, getProfileCredentialSessionId()),
				);
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
				if (!isModelProfileProviderAvailable(profile, authenticatedProviders)) continue;
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
		getSteerStatus: (selector: { commandId?: string; turnId?: string; clientRef?: string }) =>
			(options.steerStatusLookup ?? (value => reconciliation.lookup("steer", value)))(selector),
		getModelProfiles: async () => {
			const profiles = ctx.modelRegistry.getModelProfiles();
			const authenticatedProviders = await collectAuthenticatedProfileProviders(profiles, provider =>
				ctx.modelRegistry.getApiKeyForProvider(provider, getProfileCredentialSessionId()),
			);
			return (await Promise.all(
				projectModelProfileCatalog(profiles, ctx.modelRegistry.getError()).map(async item => ({
					...item,
					available:
						isModelProfileProviderAvailable(profiles.get(item.id)!, authenticatedProviders) &&
						(
							await resolveProfileAvailability(profiles.get(item.id)!, authenticatedProviders)
						).available,
				})),
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

function createControlSurface(
	ctx: ExtensionContext,
	api: ExtensionAPI,
	reconciliation: InvocationReconciliation,
	onAccepted: (
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		connectionId: string | undefined,
		startsOwnTurn: boolean,
	) => void,
	steerReconciliation: KindAwareReconciliation,
	onPromotedTurn?: (
		kind: InvocationKind,
		correlation: InvocationCorrelation,
		connectionId: string | undefined,
	) => void,
	policy?: SdkSurfacePolicy,
	settings?: Settings,
	configOverrides?: Map<string, unknown>,
	configRevision: { current: number } = { current: 0 },
	terminalAbortSeams?: SdkOnlyTerminalAbortSeams,
	terminalPublicationCapture?: { resolvers?: Array<(observed: boolean) => void> },
	activePromptOwnerHolder?: { connectionIds?: ReadonlySet<string> },
	retirePendingOwner?: (correlation: InvocationCorrelation) => void,
	canResolveGate: () => boolean = () => true,
	trackGateResolution: <T>(resolution: Promise<T>) => Promise<T> = async resolution => await resolution,
): ControlSurface {
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
	const activePromptOwner = activePromptOwnerHolder ?? { connectionIds: new Set<string>() };
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
			onPreflightAccepted: () => void;
			onPreflightAcceptCommit: () => Promise<void>;
			/** Fired when a queued submission (steering or follow-up) is promoted to its own run (SDK ownership correlation). */
			onQueuedPromoted: () => void;
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
				// The accepted submission does NOT own the active turn until its run
				// actually STARTS: the connection is carried on the pending entry and
				// associated at agent_start instead (review thread P1).
				onAccepted(kind, correlation, requesterConnectionId, startsOwnTurn);
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
		try {
			const submission = Promise.resolve(
				run({
					onPreflightAccepted: () => void accept().catch(() => undefined),
					onPreflightAcceptCommit: accept,
					// A queued submission (busy-accepted steering, or a follow-up) that
					// is later PROMOTED to its own run needs its pending ownership entry
					// created at promotion so the submitting connection can
					// terminal-abort that turn (review threads P1/P2).
					onQueuedPromoted: () => onPromotedTurn?.(kind, correlation, requesterConnectionId),
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
						if (!queuedAtDispatch)
							void reconciliation.noteTransition(kind, correlation, {
								type: "agent_end",
								...(typeof result === "string"
									? { content: { version: 1, type: "text", text: result, byteLength: 0, truncated: false } }
									: {}),
							});
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
						retirePendingOwner?.(correlation);
						void reconciliation.noteTransition(kind, correlation, { type: "agent_failed", error });
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
		input: { mode: "terminal"; scope?: "turn" | "owned" },
		idempotencyKey?: string,
	): Promise<unknown> => {
		const scope = input.scope === "owned" ? "owned" : "turn";
		// Capture the steering snapshot at ADMISSION (before any durable
		// transaction): client steering admitted while the abort is in flight
		// classifies as post-snapshot and is preserved at abortPromptAndWait
		// (review thread P1).
		terminalAbortSeams?.captureTerminalAbortSteeringSnapshot?.();
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
		const inputHash = crypto
			.createHash("sha256")
			.update(JSON.stringify({ mode: "terminal", scope }))
			.digest("hex");
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
					const bounded = boundCompletedTerminalScopeRows(preBound, SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS);
					const evicted = collectEvictedTerminalKeys(preBound, bounded);
					const combined = [...state.keys, ...evicted];
					// FIFO-expire the OLDEST tombstones past the cap instead of
					// throwing after the destructive stop already happened (review
					// thread P2).
					return {
						scopes: bounded,
						keys: boundEvictedTerminalKeys(combined, SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES),
					};
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
					const bounded = boundCompletedTerminalScopeRows(scopes, SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS);
					const evicted = collectEvictedTerminalKeys(scopes, bounded);
					const combined = [...state.keys, ...evicted];
					// FIFO-expire the OLDEST tombstones past the cap instead of
					// throwing after the destructive stop already happened (review
					// thread P2).
					return {
						scopes: bounded,
						keys: boundEvictedTerminalKeys(combined, SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES),
					};
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
				const scopes = mutate(state.scopes);
				const bounded = boundCompletedTerminalScopeRows(scopes, SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS);
				const evicted = collectEvictedTerminalKeys(scopes, bounded);
				const combined = [...state.keys, ...evicted];
				// FIFO-expire the OLDEST tombstones past the cap instead of
				// throwing after the destructive stop already happened (review
				// thread P2).
				return {
					scopes: bounded,
					keys: boundEvictedTerminalKeys(combined, SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES),
				};
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
		if (handle && (abortingConnectionId === undefined || !currentOwnerConnectionIds().has(abortingConnectionId))) {
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
				const bounded = boundCompletedTerminalScopeRows(preBound, SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS);
				const evicted = collectEvictedTerminalKeys(preBound, bounded);
				const combined = [...state.keys, ...evicted];
				// FIFO-expire the OLDEST tombstones past the cap instead of
				// throwing after the destructive stop already happened (review
				// thread P2).
				return {
					scopes: bounded,
					keys: boundEvictedTerminalKeys(combined, SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES),
				};
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
						: record.turnContinuationFence.abortedAttemptEpoch === epoch) && record.turnDisposition === "pending"
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
			const resolvers = terminalPublicationCapture?.resolvers;
			if (!resolvers) return;
			const index = resolvers.indexOf(terminalPublication.resolve);
			if (index >= 0) resolvers.splice(index, 1);
		};
		if (terminalPublicationCapture) {
			if (!terminalPublicationCapture.resolvers) terminalPublicationCapture.resolvers = [];
			terminalPublicationCapture.resolvers.push(terminalPublication.resolve);
		}
		let proof: { status: string; terminalScope?: unknown };
		try {
			proof = await terminalAbortSeams.abortPromptAndWaitWithTerminal(handle, {
				graceMs: 10_000,
				terminal: { scope, expectedEpoch: epoch },
			});
		} catch {
			proof = { status: "unfenced" };
		}
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
						: record.turnContinuationFence.abortedAttemptEpoch === epoch) && record.turnDisposition === "pending"
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
							ownedWorkDisposition: scope === "turn" ? "left_running" : ownedStopped ? "stopped" : "uncertain",
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
	};
	return {
		prompt: async (text, images, clientRef) =>
			submit("prompt", clientRef, options =>
				api.sendUserMessage(
					typeof images === "undefined" ? text : ([{ type: "text", text }, ...(images as never[])] as never),
					options,
				),
			),
		steer: async (text, clientRef) => {
			const retainedClientRef = normalizeClientRef(clientRef);
			if (retainedClientRef === undefined) {
				const correlation = newCorrelation();
				await api.sendUserMessage(text, { deliverAs: "steer" });
				return { accepted: true, ...correlation };
			}
			const durable = steerReconciliation;
			const reservation = await durable.reserveSteer(retainedClientRef, text);
			if (reservation.replay) return { accepted: reservation.result.status === "accepted", ...reservation.result };
			try {
				await api.sendUserMessage(text, { deliverAs: "steer" });
				return { accepted: true, ...(await durable.settleSteer(retainedClientRef, "accepted")) };
			} catch (error) {
				return { accepted: false, ...(await durable.settleSteer(retainedClientRef, "rejected", error)) };
			}
		},
		followUp: async text =>
			submit(
				"prompt",
				undefined,
				options => api.sendUserMessage(text, { ...options, deliverAs: "followUp" }),
				undefined,
				false,
				// Follow-ups never start inline; ownership correlates at promotion.
				true,
			),
		abort: () => {
			ctx.abort();
			return { aborted: true };
		},
		abortTerminal: terminalAbort,
		abortAndPrompt: async text => {
			ctx.abort();
			return await submit("prompt", undefined, options => api.sendUserMessage(text, options));
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
				options =>
					ctx.invokeSkill!(name, args, {
						...options,
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
				const entries = Object.entries(patch as Record<string, unknown>);
				for (const [key, value] of entries) settings.set(key as never, value as never);
				if (configOverrides) for (const [key, value] of entries) configOverrides.set(key, value);
				configRevision.current += 1;
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

/** Install a complete SDK host for a session when notifications are inactive. */
export function createSdkSessionRuntimeExtension(api: ExtensionAPI, options: CreateSdkSessionRuntimeOptions): void {
	let active:
		| {
				runtime: SessionSdkSessionRuntime;
				revisions: RevisionStore;
				cursors: CursorRegistry;
				reconciliation: InvocationReconciliation;
				steerReconciliation: KindAwareReconciliation;
				pending: Array<{
					kind: InvocationKind;
					correlation: InvocationCorrelation;
					connectionId: string | undefined;
				}>;
				registerBroker: () => Promise<void>;
				fenceGateResolutions: () => void;
				waitForGateResolutionQuiescence: () => Promise<void>;
				activeInvocation?: { kind: InvocationKind; correlation: InvocationCorrelation };
				drainedInvocations?: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
				disposeGate?: () => void;
		  }
		| undefined;
	// Shared with the control surface's terminal abort: the correlated
	// agent_end publication capture (AC 19). terminalAbort installs a fresh
	// resolver before settling the abort; emitLifecycle resolves it with the
	// OBSERVED publication result when the aborted run's lifecycle event
	// lands, so the durable stopped row never claims terminalPublished without
	// observing it (review thread P2). Single slot: only the abort that
	// reaches the stopped path awaits it; a concurrent abort for the same turn
	// is settled by the durable marker transaction instead.
	const terminalPublicationCapture: { resolvers?: Array<(observed: boolean) => void> } = {};
	// Shared with the control surface: the SDK connection owning the currently
	// active prompt/skill turn. Cleared at every agent_end (terminal lifecycle
	// boundary) so a stale owner never authorizes an abort against a later
	// turn it did not submit, and never set for agent-initiated turns (review
	// thread P1).
	const activePromptOwnerHolder: { connectionIds?: Set<string> } = {};
	const emitLifecycle = async (type: "agent_start" | "agent_end", ctx: ExtensionContext): Promise<void> => {
		const current = active;
		if (!current) return;
		if (type === "agent_start") {
			// Drain EVERY entry admitted for this run: a continuation may promote
			// several follow-ups (each with its own requester correlation) into one
			// run, and each submitting connection must be able to terminal-abort it.
			// Entries are only created for submissions that actually start their own
			// turn (queued-while-streaming submissions never push), so a mid-prompt
			// continuation agent_start with an empty queue leaves the current owner
			// untouched (review thread P1).
			const drained = current.pending.splice(0);
			current.activeInvocation = drained[0];
			if (drained.length > 0) {
				const owners = new Set<string>();
				for (const entry of drained) if (entry.connectionId !== undefined) owners.add(entry.connectionId);
				activePromptOwnerHolder.connectionIds = owners;
				// A single run may drain several follow-ups promoted together; each
				// has its own durable record that must reach terminal state, so keep
				// the full batch for the transition pass below (review thread P1).
				current.drainedInvocations = drained.map(({ kind, correlation }) => ({ kind, correlation }));
			}
		}
		// Observe whether the lifecycle publication actually landed: a terminal
		// abort awaits this result so its durable row only claims
		// terminalPublished when the correlated agent_end event reached the
		// ring/broadcast (review thread P2). Reconciliation or event failure is
		// recorded as observed=false, never rethrown into the api handler.
		let observed = true;
		try {
			const transitions =
				current.drainedInvocations && current.drainedInvocations.length > 0
					? current.drainedInvocations
					: current.activeInvocation
						? [current.activeInvocation]
						: [];
			for (const invocation of transitions)
				await current.reconciliation.noteTransition(invocation.kind, invocation.correlation, { type });
			current.runtime.emitEvent({ type, sessionId: ctx.sessionManager.getSessionId() });
		} catch {
			observed = false;
		}
		if (type === "agent_end") {
			current.activeInvocation = undefined;
			current.drainedInvocations = undefined;
			// The turn is over: no connection owns it anymore. Clearing here means
			// an abort against a later agent-initiated turn (monitor/cron
			// follow-up) finds no owner and fails closed, instead of letting the
			// previous prompt's owner stop a turn it did not submit (review
			// thread P1).
			activePromptOwnerHolder.connectionIds = undefined;
			// Resolve EVERY concurrent waiter for the aborted turn: the turn emits
			// exactly one agent_end, and each admitted abort of it must observe the
			// same publication result rather than a single latest-wins slot (review
			// thread P2).
			const resolvers = terminalPublicationCapture.resolvers;
			terminalPublicationCapture.resolvers = undefined;
			for (const resolve of resolvers ?? []) resolve(observed);
		}
	};
	api.on("agent_start", async (_event, ctx) => await emitLifecycle("agent_start", ctx));
	api.on("agent_end", async (_event, ctx) => await emitLifecycle("agent_end", ctx));
	api.on("turn_start", async (_event, ctx) => {
		const current = active;
		if (!current) return;
		await current.registerBroker();
		current.runtime.emitEvent({ type: "turn_start", sessionId: ctx.sessionManager.getSessionId() });
	});
	api.on("turn_end", (_event, ctx) =>
		active?.runtime.emitEvent({ type: "turn_end", sessionId: ctx.sessionManager.getSessionId() }),
	);
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
		const reconciliationStore = options.terminalAbortSeams?.getReconciliationStore?.();
		const reconciliation = createInvocationReconciliation({ store: reconciliationStore });
		await reconciliation.hydrate();
		const sessionFile =
			(typeof ctx.sessionManager.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined) ??
			resolveReconciliationSessionFile(undefined, stateRoot, sessionId);
		const steerReconciliation = createKindAwareReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId }),
		});
		await steerReconciliation.hydrateFromStore();
		const pending: Array<{
			kind: InvocationKind;
			correlation: InvocationCorrelation;
			connectionId: string | undefined;
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
		const surfaceFactory = createSdkSurfaceFactory({
			ctx,
			id: sessionId,
			api,
			reconciliation,
			turnResultLookup: selector => reconciliation.lookupResult(selector.kind, selector),
			steerStatusLookup: selector => steerReconciliation.lookupSteer(selector),
			configOverrides: options.configOverrides,
			settings: options.settings,
		});
		const queryHandlers = new QueryHandlers(surfaceFactory.query, sessionId, revisions, cursors);
		const controlSurface = createControlSurface(
			ctx,
			api,
			reconciliation,
			(kind, correlation, connectionId, startsOwnTurn) => {
				// Only submissions that start their OWN turn get a pending entry: a
				// steering-queued submission consumed inside the current run never
				// emits the agent_start that would consume the entry, so leaving it
				// queued would assign its stale connection as owner of a later
				// agent-initiated turn (review thread P1).
				if (startsOwnTurn) pending.push({ kind, correlation, connectionId });
			},
			steerReconciliation,
			(kind, correlation, connectionId) => {
				// A steering-queued submission PROMOTED to its own run (finished
				// prompt unwinding) starts with an empty pending queue at its
				// agent_start; create the entry at promotion so the submitting
				// connection owns that turn (review thread P2).
				pending.push({ kind, correlation, connectionId });
			},
			surfaceFactory.policy,
			options.settings,
			options.configOverrides,
			configRevision,
			options.terminalAbortSeams,
			terminalPublicationCapture,
			activePromptOwnerHolder,
			correlation => {
				// An accepted submission that settles WITHOUT starting (a rejection
				// after acceptance) must not leave its pending entry behind: remove
				// the matching correlation so a later agent-initiated turn never
				// inherits the failed submission's connection as owner (review
				// thread P1).
				const index = pending.findIndex(entry => entry.correlation === correlation);
				if (index >= 0) pending.splice(index, 1);
			},
			() => acceptingGateResolutions,
			trackGateResolution,
		);
		let runtime: SessionSdkSessionRuntime;
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
			control: async (connectionId, frame) => {
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
				const input = request.input as Record<string, unknown>;
				const mode = input.mode;
				const rawScope = input.scope;
				if (mode !== "terminal") return;
				if (rawScope !== undefined && rawScope !== "turn" && rawScope !== "owned") return;
				// A malformed retry (e.g. {mode:"terminal", scope:"turn", extra:true})
				// rejected by dispatch must never hash as the valid turn input and
				// advance the legitimate stored row (review thread P2).
				for (const key of Object.keys(input)) if (key !== "mode" && key !== "scope") return;
				const scopeInput = rawScope === "owned" ? "owned" : "turn";
				const keyHash = crypto.createHash("sha256").update(String(request.idempotencyKey)).digest("hex");
				const inputHash = crypto
					.createHash("sha256")
					.update(JSON.stringify({ mode: "terminal", scope: scopeInput }))
					.digest("hex");
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
		const disposeGate = ctx.workflowGate?.onGateEmitted?.(gate =>
			runtime.emitEvent({ kind: "workflow_gate", payload: gate }),
		);
		let brokerRegistered = false;
		const registerBroker = async (): Promise<void> => {
			if (brokerRegistered) return;
			try {
				await ensureBroker({ agentDir: options.agentDir });
				const index = await new SessionIndex(options.agentDir).open();
				const locator = { repo: path.resolve(ctx.cwd), stateRoot };
				await runtime.registerWithBroker({
					register: async input => {
						const endpointMtimeMs = (await fs.stat(path.join(input.stateRoot, "sdk", `${input.sessionId}.json`)))
							.mtimeMs;
						await index.append({ type: "host_registered", ...input, locator, pid: process.pid, endpointMtimeMs });
					},
					unregister: async input => {
						await index.append({ type: "host_unregistered", ...input, locator, pid: process.pid });
					},
				});
				brokerRegistered = true;
			} catch (error) {
				if (options.brokerRegistrationRequired) throw error;
				logger.warn(`sdk broker registration unavailable: ${String(error)}`);
			}
		};
		active = {
			runtime,
			revisions,
			cursors,
			reconciliation,
			steerReconciliation,
			pending,
			registerBroker,
			fenceGateResolutions: () => {
				acceptingGateResolutions = false;
			},
			waitForGateResolutionQuiescence,
			disposeGate,
		};
		try {
			await runtime.start();
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
				active = {
					runtime,
					revisions,
					cursors,
					reconciliation,
					steerReconciliation,
					pending,
					registerBroker,
					fenceGateResolutions: () => {
						acceptingGateResolutions = false;
					},
					waitForGateResolutionQuiescence,
					disposeGate,
				};
				throw new AggregateError([error, cleanupError], "SDK runtime startup failed and cleanup failed.");
			}
			cursors.close();
			await revisions.close().catch(() => undefined);
			throw error;
		}
	};
	const stopActive = async (): Promise<void> => {
		const current = active;
		if (!current) return;
		current.fenceGateResolutions();
		try {
			await current.waitForGateResolutionQuiescence();
			active = undefined;
			current.disposeGate?.();
			await current.runtime.stop();
		} catch (error) {
			logger.error("sdk runtime stop failed", { code: errorCode(error), error: String(error) });
			active = current;
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
		await stopActive();
	});
}
