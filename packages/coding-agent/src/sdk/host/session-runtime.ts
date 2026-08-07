import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@gajae-code/utils";
import { AsyncJobManager } from "../../async";
import { isModelProfileProviderAvailable, projectModelProfileCatalog } from "../../config/model-profile-contract";
import { isAuthenticated, kNoAuth } from "../../config/model-registry";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensibility/extensions";
import { projectQ10Models } from "../models.js";
import { OPERATIONS } from "../protocol/operation-registry";
import {
	boundCompletedTerminalScopeRows,
	collectEvictedTerminalKeys,
	findOwnedRegistrationsForTurn,
	isOwnedAttemptRegistrationIncomplete,
	settleOwnedWork,
} from "../../session/terminal-abort";
import { type ControlSurface, dispatchControl } from "./control";
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
}

export interface SdkOnlyInvocationRecord extends InvocationCorrelation {
	kind: InvocationKind | "terminal";
	clientRef?: string;
	status: InvocationStatus;
	acceptedAt: number;
	startedAt?: number;
	terminalAt?: number;
	error?: { code: string; message: string };
	outcome?: unknown;
	pendingOutcome?: unknown;
	skillName?: string;
}

export interface SdkOnlyTerminalScopeRecord {
	selection: "turn" | "owned";
	idempotencyKeyHash?: string;
	idempotencyInputHash?: string;
	turnDisposition: "pending" | "stopped" | "uncertain" | "no_effect";
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
	acceptedAt: number;
	terminalAt?: number;
}

export interface SdkOnlyEvictedTerminalKeyEntry {
	keyHash: string;
	inputHash: string;
	turnDisposition?: "stopped" | "uncertain" | "no_effect";
	ownedWorkDisposition?: "not_requested" | "left_running" | "stopped" | "uncertain";
	responseState?: "pending" | "sent" | "delivered" | "failed";
	responsePayloadHash?: string;
	terminalPublished?: boolean;
}

export interface SdkOnlyReconciliationStore {
	readonly path: string | null;
	load(): Promise<unknown[]>;
	transact(mutator: (records: SdkOnlyInvocationRecord[]) => SdkOnlyInvocationRecord[]): Promise<void>;
	snapshotTerminalScopes(): SdkOnlyTerminalScopeRecord[];
	snapshotTerminalKeys(): SdkOnlyEvictedTerminalKeyEntry[];
	transactTerminalScopes(mutator: (scopes: SdkOnlyTerminalScopeRecord[]) => SdkOnlyTerminalScopeRecord[]): Promise<void>;
	transactTerminalState(mutator: (state: {
		scopes: SdkOnlyTerminalScopeRecord[];
		keys: SdkOnlyEvictedTerminalKeyEntry[];
	}) => { scopes: SdkOnlyTerminalScopeRecord[]; keys: SdkOnlyEvictedTerminalKeyEntry[] }): Promise<void>;
}

export interface SdkOnlyTerminalAbortSeams {
	getReconciliationStore?: () => SdkOnlyReconciliationStore | undefined;
	getTerminalTurnEpoch: () => number | undefined;
	getActivePromptHandle: () => string | undefined;
	cancelPendingPreflightForTerminalAbort: () => void;
	abortPromptAndWaitWithTerminal: (
		handle: string,
		options: { graceMs: number; terminal?: { scope: "turn" | "owned" } },
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
	createTransport(input: {
		sessionId: string;
		stateRoot: string;
		token: string;
	}): SessionSdkTransport | Promise<SessionSdkTransport>;
	onSdkRequest?: SessionSdkHostOptions["onRequest"];
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

export type InvocationKind = "prompt" | "skill";
type InvocationStatus = "accepted" | "in_flight" | "terminal_ok" | "failed";
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
	hydrate(): Promise<void>;
}

function createInvocationReconciliation(
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
	]);
	const key = (kind: InvocationKind, correlation: InvocationCorrelation) =>
		`${kind}:${correlation.commandId}:${correlation.turnId}`;
	const ref = (kind: InvocationKind, clientRef: string) => `${kind}\\0${clientRef}`;
	if (options.sessionId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.sessionId))
		throw Object.assign(new Error("Unsafe SDK reconciliation session id."), { code: "invalid_input" });
	const store = options.store;
	const persist = async (): Promise<void> => {
		if (!store) return;
		await store.transact(() => [...records.values()]);
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
		if (!store) return;
		const loaded = (await store.load()) as SdkOnlyInvocationRecord[];
		for (const candidate of loaded) {
			if (candidate.kind !== "prompt" && candidate.kind !== "skill") continue;
			if (!candidate.commandId || !candidate.turnId || typeof candidate.acceptedAt !== "number") continue;
			const kind = candidate.kind as InvocationKind;
			records.set(key(kind, candidate), { ...candidate, kind });
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
			if (!record || record.terminalAt !== undefined) return;
			if (frame.type === "agent_start") {
				record.status = "in_flight";
				record.startedAt = Date.now();
			} else {
				record.status = frame.type === "agent_failed" ? "failed" : "terminal_ok";
				record.terminalAt = Date.now();
				if (frame.type === "agent_failed") record.error = { code: "prompt_failed", message: "Invocation failed." };
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
	promptStatusLookup?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
	skillStatusLookup?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
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
		promptStatusLookup?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
		skillStatusLookup?: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
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
		getModels: () =>
			projectQ10Models({
				models: ctx.modelRegistry.getAll(),
				currentModel: ctx.model,
				currentThinkingLevel: api.getThinkingLevel(),
			}),
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
			(options.promptStatusLookup ?? (value => reconciliation.lookup("prompt", value)))(selector),
		getSkillInvokeStatus: (selector: { commandId?: string; turnId?: string; clientRef?: string }) =>
			(options.skillStatusLookup ?? (value => reconciliation.lookup("skill", value)))(selector),
		getModelProfiles: () => {
			const profiles = ctx.modelRegistry.getModelProfiles();
			const providers = new Set([...profiles.values()].flatMap(profile => profile.requiredProviders));
			const authenticatedProviders = new Set<string>();
			return Promise.all(
				[...providers].map(async provider => {
					try {
						const credential = await ctx.modelRegistry.getApiKeyForProvider(provider, id);
						if (credential === kNoAuth || isAuthenticated(credential)) authenticatedProviders.add(provider);
					} catch {}
				}),
			).then(() => {
				return projectModelProfileCatalog(profiles, ctx.modelRegistry.getError()).map(item => ({
					...item,
					available: isModelProfileProviderAvailable(profiles.get(item.id)!, authenticatedProviders),
				})) as unknown[];
			});
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
		promptStatusLookup: options.promptStatusLookup,
		skillStatusLookup: options.skillStatusLookup,
		hostTools: options.hostTools,
	});
	return {
		policy,
		query,
		getCapabilities: () => query.getCapabilities() as SdkCapabilities,
	};
}

function createControlSurface(
	ctx: ExtensionContext,
	api: ExtensionAPI,
	reconciliation: InvocationReconciliation,
	onAccepted: (kind: InvocationKind, correlation: InvocationCorrelation) => void,
	policy?: SdkSurfacePolicy,
	terminalAbortSeams?: SdkOnlyTerminalAbortSeams,
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
	const newCorrelation = () => ({ commandId: crypto.randomUUID(), turnId: crypto.randomUUID() });
	const pendingPreflights = new Map<string, Set<() => void>>();
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
		}) => Promise<void>,
		acceptedFields?: () => Record<string, unknown>,
		allowCompletionFallback = false,
	): Promise<unknown> => {
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
			try {
				await reconciliation.noteAccepted(kind, correlation, retainedClientRef);
				accepted = true;
				settled = true;
				onAccepted(kind, correlation);
				preflight.resolve();
			} catch (error) {
				settled = true;
				preflight.reject(error);
				throw error;
			}
		};
		try {
			const submission = Promise.resolve(
				run({
					onPreflightAccepted: () => void accept().catch(() => undefined),
					onPreflightAcceptCommit: accept,
				}),
			);
			void submission.then(
				() => {
					if (settled) {
						if (kind === "skill") void reconciliation.noteTransition(kind, correlation, { type: "agent_end" });
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
						if (kind === "skill")
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
		const replay = (): unknown => {
			const scopes = store.snapshotTerminalScopes();
			const existing = keyHash
				? scopes.find(record => record.idempotencyKeyHash === keyHash)
				: undefined;
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
									: { ownedWork: "left_running", automaticDelivery: "enabled", resumeOnOwnedCompletion: true }),
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
		const writeNoEffect = async (): Promise<"ok" | "conflict"> => {
			try {
				await store.transactTerminalState(state => {
					// Atomic recheck: a concurrent request may have committed a
					// DIFFERENT input under this key after the earlier snapshot
					// check; appending a second same-key row would make later
					// replay's .find() by key hash ambiguous (review thread P2).
					const conflicting = state.scopes.find(record => keyHash && record.idempotencyKeyHash === keyHash);
					if (conflicting && conflicting.idempotencyInputHash !== inputHash)
						throw new SdkOnlyIdempotencyConflictError();
					const preBound: SdkOnlyTerminalScopeRecord[] = [
						...state.scopes.filter(record => !(keyHash && record.idempotencyKeyHash === keyHash)),
						{
							selection: scope,
							...(keyHash ? { idempotencyKeyHash: keyHash, idempotencyInputHash: inputHash } : {}),
							turnDisposition: "no_effect",
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
							responsePayloadHash: inputHash,
							acceptedAt: Date.now(),
						},
					];
					const bounded = boundCompletedTerminalScopeRows(
						preBound,
						SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS,
					);
					const evicted = collectEvictedTerminalKeys(preBound, bounded);
					const combined = [...state.keys, ...evicted];
					if (combined.length > SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES) {
						throw new Error("terminal key tombstone capacity reached");
					}
					return { scopes: bounded, keys: combined };
				});
				return "ok";
			} catch (error) {
				if (error instanceof SdkOnlyIdempotencyConflictError) return "conflict";
				throw error;
			}
		};
		const handle = terminalAbortSeams.getActivePromptHandle();
		const epoch = terminalAbortSeams.getTerminalTurnEpoch();
		const requesterPreflights = currentRequesterPreflights();
		const cancelRequesterPreflights = () => {
			if (requesterPreflights.size === 0) return;
			for (const cancel of [...requesterPreflights]) cancel();
			terminalAbortSeams.cancelPendingPreflightForTerminalAbort();
		};
		if (!handle || epoch === undefined) {
			if ((await writeNoEffect()) === "conflict") {
				throw Object.assign(new Error("Idempotency key was reused with different input."), {
					code: "idempotency_conflict",
				});
			}
			cancelRequesterPreflights();
			return {
				ok: true,
				selection: scope,
				turn: "no_active_turn",
				terminal: "terminal_no_effect",
			};
		}
		let pendingReplay: SdkOnlyTerminalScopeRecord | undefined;
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
					if (conflicting.idempotencyInputHash !== inputHash)
						throw new SdkOnlyIdempotencyConflictError();
					if (conflicting.turnDisposition === "pending") {
						pendingReplay = conflicting;
						return { scopes: state.scopes, keys: state.keys };
					}
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
				const bounded = boundCompletedTerminalScopeRows(
					preBound,
					SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS,
				);
				const evicted = collectEvictedTerminalKeys(preBound, bounded);
				const combined = [...state.keys, ...evicted];
				if (combined.length > SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES) {
					throw new Error("terminal key tombstone capacity reached");
				}
				return { scopes: bounded, keys: combined };
			});
		} catch (error) {
			if (error instanceof SdkOnlyIdempotencyConflictError) {
				throw Object.assign(new Error("Idempotency key was reused with different input."), {
					code: "idempotency_conflict",
				});
			}
			if ((await writeNoEffect()) === "conflict") {
				throw Object.assign(new Error("Idempotency key was reused with different input."), {
					code: "idempotency_conflict",
				});
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
		// A new prompt won the race while the marker was being persisted. Never
		// apply this request to that later handle; replay remains a safe uncertainty.
		if (
			terminalAbortSeams.getActivePromptHandle() !== handle ||
			terminalAbortSeams.getTerminalTurnEpoch() !== epoch
		) {
			await store.transactTerminalScopes(scopes =>
				scopes.map(record =>
					(keyHash ? record.idempotencyKeyHash === keyHash : record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
					record.turnDisposition === "pending"
						? { ...record, turnDisposition: "uncertain", terminalAt: Date.now() }
						: record,
				),
			);
			return {
				ok: true,
				selection: scope,
				turn: "uncertain",
				ownedWork: scope === "turn" ? "left_running" : "uncertain",
				automaticDelivery: scope === "turn" ? "enabled" : "none",
				resumeOnOwnedCompletion: scope === "turn",
				reason: "active_turn_changed",
			};
		}
		cancelRequesterPreflights();
		let proof: { status: string; terminalScope?: unknown };
		try {
			proof = await terminalAbortSeams.abortPromptAndWaitWithTerminal(handle, {
				graceMs: 10_000,
				terminal: { scope },
			});
		} catch {
			proof = { status: "unfenced" };
		}
		if (proof.status !== "settled" || proof.terminalScope === undefined) {
			await store.transactTerminalScopes(scopes =>
				scopes.map(record =>
					(keyHash ? record.idempotencyKeyHash === keyHash : record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
					record.turnDisposition === "pending"
						? { ...record, turnDisposition: "uncertain", ownedWorkDisposition: "uncertain", terminalAt: Date.now() }
						: record,
				),
			);
			return {
				ok: true,
				selection: scope,
				turn: "uncertain",
				ownedWork: scope === "turn" ? "left_running" : "uncertain",
				automaticDelivery: scope === "turn" ? "enabled" : "none",
				resumeOnOwnedCompletion: scope === "turn",
				reason: "worker_unsettled",
			};
		}
		// scope:"owned" must generation-verify and CANCEL the exact owned work
		// before reporting it stopped: abortPromptAndWaitWithTerminal only aborts
		// the foreground run and registers the disabled-delivery scope — a
		// background Bash/task/detached subagent would otherwise keep running
		// while the client receives stopped_owned (review thread P1).
		let ownedStopped = true;
		if (scope === "owned") {
			const terminalScope = proof.terminalScope as
				| { abortedAttemptEpoch?: number; lineageIdHash?: string }
				| undefined;
			const failOwnedUncertain = async (): Promise<unknown> => {
				await store.transactTerminalScopes(scopes =>
					scopes.map(record =>
						(keyHash ? record.idempotencyKeyHash === keyHash : record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
						record.turnDisposition === "pending"
							? { ...record, turnDisposition: "uncertain", ownedWorkDisposition: "uncertain", terminalAt: Date.now() }
							: record,
					),
				);
				return {
					ok: true,
					selection: scope,
					turn: "uncertain",
					ownedWork: "uncertain",
					automaticDelivery: "none",
					resumeOnOwnedCompletion: false,
					reason: "owned_unsettled",
				};
			};
			if (
				!terminalScope ||
				terminalScope.abortedAttemptEpoch === undefined ||
				!terminalScope.lineageIdHash ||
				isOwnedAttemptRegistrationIncomplete(
					terminalScope.lineageIdHash,
					terminalScope.abortedAttemptEpoch,
				)
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
		const result = {
			ok: true,
			selection: scope,
			turn: "stopped",
			...(scope === "turn"
				? { ownedWork: "left_running", automaticDelivery: "enabled", resumeOnOwnedCompletion: true }
				: { ownedWork: ownedStopped ? "stopped" : "uncertain", automaticDelivery: "none", resumeOnOwnedCompletion: false }),
		};
		const payloadHash = crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
		await store.transactTerminalScopes(scopes =>
			scopes.map(record =>
				(keyHash ? record.idempotencyKeyHash === keyHash : record.turnContinuationFence.abortedAttemptEpoch === epoch) &&
					record.turnDisposition === "pending"
					? {
							...record,
							turnDisposition: "stopped",
							terminalPublished: true,
							ownedWorkDisposition: scope === "turn" ? "left_running" : ownedStopped ? "stopped" : "uncertain",
							responsePayloadHash: payloadHash,
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
		steer: async text => {
			await api.sendUserMessage(text, { deliverAs: "steer" });
			return { commandId: crypto.randomUUID(), accepted: true };
		},
		followUp: async text =>
			submit("prompt", undefined, options => api.sendUserMessage(text, { ...options, deliverAs: "followUp" })),
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
		answerGate: unavailable("workflow.gate_answer"),
		approvePlan: unavailable("workflow.plan_approve"),
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
					}).then(() => undefined),
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
			const changed = await api.setModelTemporaryForControl(resolveModel(id));
			if (!changed) throw Object.assign(new Error("Model unavailable for this session."), { code: "unavailable" });
			if (thinkingLevel !== undefined) api.setThinkingLevel(thinkingLevel as never);
			return { changed: true };
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
		closeSession: () => typed("session.close"),
		switchSession: id => typed("session.switch", { id }),
		branchSession: entryId => typed("session.branch", { entryId }),
		renameSession: name => typed("session.rename", { name }),
		handoffSession: target => typed("session.handoff", { target }),
		exportHtml: () => typed("session.export_html"),
		patchConfig: patch => typed("config.patch", { patch }),
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
				pending: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
				activeInvocation?: { kind: InvocationKind; correlation: InvocationCorrelation };
				disposeGate?: () => void;
		  }
		| undefined;
	const emitLifecycle = async (type: "agent_start" | "agent_end", ctx: ExtensionContext): Promise<void> => {
		const current = active;
		if (!current) return;
		if (type === "agent_start") current.activeInvocation = current.pending.shift();
		await current.reconciliation.noteTransition(
			current.activeInvocation?.kind ?? "prompt",
			current.activeInvocation?.correlation,
			{ type },
		);
		current.runtime.emitEvent({ type, sessionId: ctx.sessionManager.getSessionId() });
		if (type === "agent_end") current.activeInvocation = undefined;
	};
	api.on("agent_start", async (_event, ctx) => await emitLifecycle("agent_start", ctx));
	api.on("agent_end", async (_event, ctx) => await emitLifecycle("agent_end", ctx));
	api.on("turn_start", (_event, ctx) =>
		active?.runtime.emitEvent({ type: "turn_start", sessionId: ctx.sessionManager.getSessionId() }),
	);
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
		const pending: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }> = [];
		const surfaceFactory = createSdkSurfaceFactory({
			ctx,
			id: sessionId,
			api,
			reconciliation,
			promptStatusLookup: selector => reconciliation.lookup("prompt", selector),
			skillStatusLookup: selector => reconciliation.lookup("skill", selector),
		});
		const queryHandlers = new QueryHandlers(surfaceFactory.query, sessionId, revisions, cursors);
		const controlSurface = createControlSurface(
			ctx,
			api,
			reconciliation,
			(kind, correlation) => {
				pending.push({ kind, correlation });
			},
			surfaceFactory.policy,
			options.terminalAbortSeams,
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
			control: async (_connectionId, frame) => {
				const request = frame as Record<string, unknown>;
				return dispatchControl(
					controlSurface,
					OPERATIONS.find(operation => operation.kind === "control" && operation.sdkId === request.operation),
					{
						id: typeof request.id === "string" ? request.id : "",
						operation: typeof request.operation === "string" ? request.operation : "",
						input: request.input,
						expectedRevision: typeof request.expectedRevision === "string" ? request.expectedRevision : undefined,
						idempotencyKey: typeof request.idempotencyKey === "string" ? request.idempotencyKey : undefined,
						confirm: request.confirm === true,
					},
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
			onControlResponseDelivery: async (_connectionId, request, _response, outcome) => {
				if (
					!reconciliationStore ||
					request.operation !== "turn.abort" ||
					!request.idempotencyKey ||
					typeof request.input !== "object" ||
					request.input === null ||
					(request.input as { mode?: unknown }).mode !== "terminal"
				)
					return;
				const input = request.input as { mode?: unknown; scope?: unknown };
				if (input.scope !== undefined && input.scope !== "turn" && input.scope !== "owned") return;
				const keyHash = crypto.createHash("sha256").update(String(request.idempotencyKey)).digest("hex");
				const inputHash = crypto
					.createHash("sha256")
					.update(JSON.stringify({ mode: "terminal", scope: input.scope === "owned" ? "owned" : "turn" }))
					.digest("hex");
				await reconciliationStore.transactTerminalState(state => ({
					scopes: state.scopes.map(record =>
						record.idempotencyKeyHash === keyHash &&
						record.idempotencyInputHash === inputHash &&
						record.responseState === "pending"
							? { ...record, responseState: outcome === "written" ? "sent" : "failed" }
							: record,
					),
					keys: state.keys.map(record =>
						record.keyHash === keyHash && record.inputHash === inputHash && record.responseState === "pending"
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
		active = { runtime, revisions, cursors, reconciliation, pending, disposeGate };
		try {
			await runtime.start();
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
				active = { runtime, revisions, cursors, reconciliation, pending, disposeGate };
				throw new AggregateError([error, cleanupError], "SDK runtime startup failed and cleanup failed.");
			}
			cursors.close();
			await revisions.close().catch(() => undefined);
			throw error;
		}
	};
	const stopActive = async (): Promise<void> => {
		const current = active;
		active = undefined;
		if (!current) return;
		current.disposeGate?.();
		try {
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
