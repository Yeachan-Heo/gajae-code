import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import { isModelProfileProviderAvailable, projectModelProfileCatalog } from "../../config/model-profile-contract";
import { type ModelProfileDefinition, resolveProfileBindings } from "../../config/model-profiles";
import { resolveModelChainWithAuth, splitSelectorThinkingSuffix } from "../../config/model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "../../config/model-selector-value";
import { type Settings, validateSettingPatch } from "../../config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensibility/extensions";
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
import { type ControlSurface, dispatchControl } from "./control";
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
	sendFrame(connectionId: string, frame: SdkFrame): void | Promise<void>;
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
			sendFrame: options.transport.sendFrame,
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
	options: { stateRoot?: string; sessionId?: string } = {},
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
	const reconciliationFile =
		options.stateRoot && options.sessionId
			? path.join(options.stateRoot, ".sdk-reconciliation", `${options.sessionId}.json`)
			: undefined;
	let persistenceChain: Promise<void> = Promise.resolve();
	const persist = async (): Promise<void> => {
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
		await workflowGate.recoverAcceptedGates();
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
	onAccepted: (kind: InvocationKind, correlation: InvocationCorrelation) => void,
	steerReconciliation: KindAwareReconciliation,
	policy?: SdkSurfacePolicy,
	settings?: Settings,
	configOverrides?: Map<string, unknown>,
	configRevision: { current: number } = { current: 0 },
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
		}) => Promise<unknown>,
		acceptedFields?: () => Record<string, unknown>,
		allowCompletionFallback = false,
		alwaysQueued = false,
	): Promise<unknown> => {
		const retainedClientRef = normalizeClientRef(clientRef);
		reconciliation.admit(kind, retainedClientRef);
		const correlation = newCorrelation();
		const preflight = Promise.withResolvers<void>();
		let accepted = false;
		let settled = false;
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
		// Snapshot before run(): if the session is streaming when the submission starts,
		// sendUserMessage will divert to steer-queue and resolve before the turn runs.
		// Re-reading ctx.isIdle() after run() would race — accept() does async fs I/O that
		// yields, so isStreaming can flip during the persist window.
		const queuedAtDispatch = alwaysQueued || !ctx.isIdle();
		try {
			const submission = Promise.resolve(
				run({
					onPreflightAccepted: () => void accept().catch(() => undefined),
					onPreflightAcceptCommit: accept,
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
						// Every kind must terminalize here or the record stays non-terminal
						// forever; `noteTransition` ignores an already-terminal record.
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
		}
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
				true,
			),
		abort: () => {
			ctx.abort();
			return { aborted: true };
		},
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
				pending: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }>;
				registerBroker: () => Promise<void>;
				fenceGateResolutions: () => void;
				waitForGateResolutionQuiescence: () => Promise<void>;
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
		const reconciliation = createInvocationReconciliation({ stateRoot, sessionId });
		await reconciliation.hydrate();
		const sessionFile =
			(typeof ctx.sessionManager.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined) ??
			resolveReconciliationSessionFile(undefined, stateRoot, sessionId);
		const steerReconciliation = createKindAwareReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId }),
		});
		await steerReconciliation.hydrateFromStore();
		const pending: Array<{ kind: InvocationKind; correlation: InvocationCorrelation }> = [];
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
			const timeout = Bun.sleep(5_000).then(() => {
				throw new Error("Timed out waiting for SDK workflow gate resolutions to settle.");
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
			(kind, correlation) => {
				pending.push({ kind, correlation });
			},
			steerReconciliation,
			surfaceFactory.policy,
			options.settings,
			options.configOverrides,
			configRevision,
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
