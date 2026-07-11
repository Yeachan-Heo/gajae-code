import * as path from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type AvailableCommand,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type CreateElicitationResponse,
	type DeleteSessionRequest,
	type DeleteSessionResponse,
	type ElicitationContentValue,
	type ElicitationPropertySchema,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModeState,
	type SessionNotification,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type Usage,
} from "@agentclientprotocol/sdk";
import type { AssistantMessage, Model } from "@gajae-code/ai";
import { logger } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import { disableProvider, enableProvider, reset as resetCapabilities } from "../../capability";
import { Settings } from "../../config/settings";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../extensibility/extensions";
import { runExtensionCompact } from "../../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { resolveSubskillActivationForSkillInvocation } from "../../extensibility/gjc-plugins";
import {
	buildSkillPromptMessage,
	getSkillSlashCommandNames,
	isNamespacedSkillSlashCommandName,
	isSkillSlashCommandName,
	parseSkillInvocations,
} from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { loadAllExtensions } from "../../modes/components/extensions/state-manager";
import { theme } from "../../modes/theme/theme";
import { MCPManager } from "../../runtime-mcp/manager";
import type { MCPServerConfig } from "../../runtime-mcp/types";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { isSilentAbort, SKILL_PROMPT_MESSAGE_TYPE } from "../../session/messages";
import {
	SessionManager,
	type SessionInfo as StoredSessionInfo,
	type StrictInventoryCandidate,
	type UsageStatistics,
} from "../../session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageFileIdentity,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../../session/session-storage";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { parseThinkingLevel } from "../../thinking";
import { toAgentWireEventPayload } from "../shared/agent-wire/event-envelope";
import { createAcpClientBridge } from "./acp-client-bridge";
import {
	buildToolCallStartUpdate,
	mapAgentWireEventPayloadToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "./acp-event-mapper";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const THINKING_OFF = "off";
const SESSION_PAGE_SIZE = 50;

/**
 * One immutable authorization snapshot built from a complete strict scoped inventory.
 * `entries` maps every discovered session id to either the single exact-identity
 * candidate (authoritative) or a conflict tombstone (duplicate/unsafe). The snapshot
 * is built once, before pagination, so a duplicate beyond page 1 is known before the
 * first page response. Lifecycle changes bump {@link #authorityGeneration} and
 * invalidate the snapshot.
 */
type AcpAuthorityEntry =
	| { kind: "candidate"; candidate: StrictInventoryCandidate }
	| { kind: "conflict"; reason: string };
/**
 * Phase-aware same-connection retry evidence for an incomplete verified delete.
 * The transcript identity is always recorded and re-verified on retry; the
 * artifacts identity is recorded only when the failure occurred at the
 * artifacts phase (the artifact directory still existed at failure time).
 */
type PendingDeleteEvidence = {
	transcriptIdentity: SessionStorageFileIdentity;
	artifactsIdentity?: SessionStorageFileIdentity;
};

type AcpAuthoritySnapshot = {
	scope: string;
	entries: Map<string, AcpAuthorityEntry>;
	/** Ordered unique session ids (conflicts appear once at first sight) for paging. */
	orderedIds: string[];
	generation: number;
};
/**
 * Delay between `session/new` (or `session/load` / `session/resume` /
 * `unstable_session/fork`) returning and the agent firing the first
 * notifications against the new session id. Mitigates Zed's
 * `Received session notification for unknown session` race — see
 * `#scheduleBootstrapUpdates`. Exported so the ACP test harness can
 * wait past this guard without hard-coding the literal.
 */
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
const CODING_AGENT_VERSION: string = packageJson.version;
const ACP_CANCEL_CLEANUP_TIMEOUT_MS = 5_000;
const ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS = 250;
const ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES = 3;

type AgentImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

type PromptQueueState = {
	promise: Promise<void>;
	release: (() => void) | undefined;
};

type PromptTurnState = {
	userMessageId: string;
	cancelRequested: boolean;
	settled: boolean;
	/**
	 * `abort()` is in-flight (or its bounded-timeout race). `undefined` while the turn is
	 * running normally and after cleanup completes. The turn occupies `record.promptTurn`
	 * for as long as either `!settled` or `cleanup` is set — that combined window is the
	 * "turn in flight" predicate (`isPromptTurnInFlight`) every consumer gates on.
	 */
	cleanup: Promise<void> | undefined;
	usageBaseline: UsageStatistics;
	unsubscribe: (() => void) | undefined;
	resolve: (value: PromptResponse) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<PromptResponse>;
};

/**
 * A turn is "in flight" from the moment `prompt()` reserves the slot until `settled` is
 * true AND any cancel cleanup has completed. Fork/queue/event gating all depend on this
 * combined window — a settled-but-still-aborting turn is not safe to fork from, queue
 * onto, or forward late events for.
 */
function isPromptTurnInFlight(turn: PromptTurnState | undefined): turn is PromptTurnState {
	return turn !== undefined && (!turn.settled || turn.cleanup !== undefined);
}

/**
 * Per-record terminal state machine for session deletion.
 * - `active`: normal operation; all lifecycle methods allowed.
 * - `deleting`: a terminal delete has reserved the record; prompt/config/close/
 *   load/resume/fork reject, concurrent deletes join the terminal promise.
 * - `pre_dispatch_retryable`: close_failed_retryable before verified-delete
 *   dispatch; normal ops rejected but a subsequent delete may retry.
 * - `cleanup_pending`: verified delete returned cleanup_pending with identity
 *   evidence; normal ops rejected but a subsequent delete may retry.
 * - `terminal_failure`: close_unknown or quiescence failure (or any unexpected
 *   failure); normal ops rejected and delete NEVER reopens — subsequent deletes
 *   share the settled terminal failure error.
 * - `deleted`: verified delete succeeded; record removed from the active map.
 */
type AcpSessionTerminalState =
	| "active"
	| "deleting"
	| "pre_dispatch_retryable"
	| "cleanup_pending"
	| "terminal_failure"
	| "deleted";

type ManagedSessionRecord = {
	session: AgentSession;
	mcpManager: MCPManager | undefined;
	promptTurn: PromptTurnState | undefined;
	promptQueue: PromptQueueState;
	liveMessageId: string | undefined;
	liveMessageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	toolArgsById: Map<string, unknown>;
	extensionsConfigured: boolean;
	// Installed after the bootstrap race guard or eagerly when the client starts a prompt;
	// released in `#disposeSessionRecord`. Lives independent of any prompt turn.
	lifetimeUnsubscribe: (() => void) | undefined;
	// Per-record terminal state machine (see AcpSessionTerminalState). After ANY
	// delete failure the record stays non-`active` so prompt/config/close/load/
	// resume/fork remain rejected. Only `pre_dispatch_retryable` and
	// `cleanup_pending` permit a retry delete; `terminal_failure` never reopens.
	terminalState: AcpSessionTerminalState;
	// The settled terminal failure error, shared with subsequent delete callers
	// so a terminal_failure is observable without re-running the terminal op.
	terminalFailure: Error | undefined;
	// Resolves when an in-progress terminal delete settles. Concurrent delete
	// callers and abort/shutdown join this promise.
	terminalPromise: Promise<DeleteSessionResponse> | undefined;
};

type ReplayableMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};

type ReplayableToolItem = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
};

type MCPConfigMap = {
	[name: string]: MCPServerConfig;
};

type MCPSource = {
	provider: string;
	providerName: string;
	path: string;
	level: "project";
};

type MCPSourceMap = {
	[name: string]: MCPSource;
};

type CreateAcpSession = (cwd: string) => Promise<AgentSession>;

/**
 * Bridge a single ExtensionUIContext call to the ACP `unstable_createElicitation`
 * surface. Skills/extensions ask for one value at a time (a chosen option, a
 * confirmation, a piece of text), so every elicitation here uses a one-property
 * `value` schema; the caller narrows the resulting `ElicitationContentValue`
 * back to its concrete primitive type.
 *
 * `dialogOptions.signal` short-circuits the elicitation if it is already
 * aborted and races the in-flight request against the abort event. The SDK
 * exposes no `cancel_elicitation` surface for form-mode elicitations
 * (`unstable_completeElicitation` is URL-mode only), so the ACP request itself
 * keeps running on the client side until the user dismisses it — but
 * resolving the local promise unblocks the caller (matches the RPC mode
 * pattern in `requestRpcEditor`). The abort listener is removed once the
 * elicitation settles so that callers which reuse the same signal across many
 * elicitations (e.g. `ask` multi-select loops) don't accumulate listeners and
 * trip Node's `MaxListeners` warning.
 *
 * `dialogOptions.timeout` mirrors `RpcExtensionUIContext.#createDialogPromise`:
 * when the timer fires before the client responds, `onTimeout` is invoked and
 * the caller's promise resolves to the stub fallback. Late SDK responses that
 * arrive after abort/timeout — both rejections and successful `accept`s —
 * are dropped silently (no `logger.warn`) to keep operator logs clean.
 */
async function elicitFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: "select" | "confirm" | "input",
	message: string,
	property: ElicitationPropertySchema,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<ElicitationContentValue | undefined> {
	const signal = dialogOptions?.signal;
	if (signal?.aborted) {
		return undefined;
	}
	const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse | undefined>();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;
	const finish = (value: CreateElicitationResponse | undefined) => {
		if (settled) return;
		settled = true;
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		resolve(value);
	};
	const onAbort = () => finish(undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (dialogOptions?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			if (settled) return;
			try {
				dialogOptions.onTimeout?.();
			} catch (error) {
				// A throwing `onTimeout` must not leave the elicitation promise
				// pending — settle it via `finish` below regardless.
				logger.warn("ACP elicitation onTimeout threw", { sessionId, method, error });
			}
			finish(undefined);
		}, dialogOptions.timeout);
		// A long pending timeout alone shouldn't keep the event loop alive when
		// the rest of the agent has shut down — matches `job-manager.ts` /
		// `executor.ts` timer hygiene. Connection + session lifetimes keep the
		// loop alive on the happy path.
		timeoutId.unref();
	}
	connection
		.unstable_createElicitation({
			mode: "form",
			sessionId,
			message,
			requestedSchema: {
				type: "object",
				properties: { value: property },
				required: ["value"],
			},
		})
		.then(finish, error => {
			// Caller may already have moved on via abort/timeout; suppress noise.
			if (settled) return;
			logger.warn("ACP elicitation failed", { sessionId, method, error });
			finish(undefined);
		});
	const response = await promise;
	if (
		response?.action !== "accept" ||
		typeof response.content !== "object" ||
		response.content === null ||
		!("value" in response.content)
	) {
		return undefined;
	}
	const value = response.content.value;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		(Array.isArray(value) && value.every(item => typeof item === "string"))
	) {
		return value;
	}
	return undefined;
}

/**
 * Build an {@link ExtensionUIContext} that translates skill/extension UI
 * requests into ACP elicitations against `connection` for the session
 * returned by `getSessionId()`. The id is read lazily at each elicitation
 * because `AgentSession.sessionId` is a getter over `sessionManager` state
 * that mutates when an extension command calls `ctx.newSession` /
 * `ctx.switchSession` — snapshotting it once at factory time would route
 * later elicitations to the pre-switch id. Live reads keep the bridge
 * symmetric with every other `sessionUpdate` call in this file
 * (`record.session.sessionId` is always evaluated at emit time).
 *
 * The non-elicitation surface (custom components, editor, theming,
 * terminal input) remains stubbed — ACP clients render those themselves
 * or not at all. Capability gating respects the client's `initialize`
 * advertisement.
 */
export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	clientCapabilities: ClientCapabilities | undefined,
): ExtensionUIContext {
	const supportsForm = clientCapabilities?.elicitation?.form != null;
	return {
		select: async (title, options, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"select",
				title,
				{ type: "string", enum: options },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		confirm: async (title, message, dialogOptions) => {
			if (!supportsForm) return false;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"confirm",
				message.trim().length > 0 ? `${title}\n\n${message}` : title,
				{ type: "boolean" },
				dialogOptions,
			);
			return typeof value === "boolean" ? value : false;
		},
		input: async (title, placeholder, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"input",
				title,
				// ACP's `StringPropertySchema` has no `placeholder` field, so we
				// surface the placeholder text as `description` — the closest
				// semantic field a client can render alongside the input.
				// Empty / whitespace-only placeholders are treated as absent.
				{ type: "string", ...(placeholder?.trim() ? { description: placeholder } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		notify: (message, type) => {
			logger.debug("ACP extension notification", { message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setEditorComponent: () => {},
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export class AcpAgent implements Agent {
	#connection: AgentSideConnection;
	#initialSession: AgentSession | undefined;
	#createSession: CreateAcpSession;
	#sessions = new Map<string, ManagedSessionRecord>();
	#disposePromise: Promise<void> | undefined;
	#cleanupRegistered = false;
	#clientCapabilities: ClientCapabilities | undefined;
	#cancelCleanupTimeoutMs = ACP_CANCEL_CLEANUP_TIMEOUT_MS;
	/** Immutable canonical cwd locked by the first successful explicit-cwd lifecycle/list call. */
	#canonicalCwdScope: string | undefined;
	/** Authority snapshot from the last complete strict scoped inventory. Invalidation bumps this. */
	#authorityGeneration = 0;
	#authoritySnapshot: AcpAuthoritySnapshot | undefined;
	/**
	 * Same-connection retry evidence for an incomplete verified delete. Keyed by
	 * session id. Phase-aware: every cleanup_pending carries the transcript
	 * identity at failure time, which is re-verified against the fresh candidate
	 * on retry so a replaced transcript cannot authorize a replacement; the
	 * artifacts-phase result additionally carries the artifact directory
	 * identity to re-accept. Cleared once a delete reaches `kind: "deleted"`.
	 */
	#pendingDeleteEvidence = new Map<string, PendingDeleteEvidence>();
	#shutdownPromise: Promise<void> | undefined;
	#lifecycleOperations = new Set<Promise<unknown>>();
	#shuttingDown = false;

	constructor(connection: AgentSideConnection, createSession: CreateAcpSession, initialSession?: AgentSession) {
		this.#connection = connection;
		this.#initialSession = initialSession;
		this.#createSession = createSession;
	}

	setCancelCleanupTimeoutForTesting(timeoutMs: number): void {
		this.#cancelCleanupTimeoutMs = Math.max(1, timeoutMs);
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#registerConnectionCleanup();
		this.#clientCapabilities = params.clientCapabilities;
		const authMethods: AuthMethod[] = [
			{
				id: "agent",
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.gjc.",
			},
		];
		if (params.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				type: "terminal",
				id: "terminal",
				name: "Set up Gajae Code in terminal",
				description: "Launch the gjc TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: {
				name: "gajae-code",
				title: "Gajae Code",
				version: CODING_AGENT_VERSION,
			},
			authMethods,
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: {
					http: true,
					sse: true,
				},
				promptCapabilities: {
					embeddedContext: true,
					image: true,
				},
				sessionCapabilities: {
					list: {},
					fork: {},
					resume: {},
					close: {},
					delete: {},
				},
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		// ACP spec: `methodId` must be one of the methods advertised by `initialize`.
		// Reject anything else so malformed clients fail fast rather than appearing
		// authenticated and surfacing a downstream model failure later.
		const supportsTerminalAuth = this.#clientCapabilities?.auth?.terminal === true;
		const validMethods = supportsTerminalAuth ? ["agent", "terminal"] : ["agent"];
		if (!validMethods.includes(params.methodId)) {
			throw new Error(`Unknown ACP auth method: ${params.methodId}`);
		}
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#rejectIfShuttingDown();
		// Stage scope before the lifecycle op; commit only after it succeeds so a
		// failed first call does not pin the connection to a cwd it never served.
		const canonical = this.#stageCanonicalScope(params.cwd);
		const record = await this.#trackLifecycle(() => this.#createNewSessionRecord(params.cwd, params.mcpServers));
		this.#rejectIfShuttingDown();
		this.#commitCanonicalScope(canonical);
		this.#invalidateAuthority();
		const response: NewSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#rejectIfShuttingDown();
		const canonical = this.#stageCanonicalScope(params.cwd);
		const existingRecord = this.#sessions.get(params.sessionId);
		const record = await this.#trackLifecycle(() =>
			this.#loadManagedSession(params.sessionId, params.cwd, params.mcpServers),
		);
		try {
			this.#rejectIfShuttingDown();
			await this.#replaySessionHistory(record);
			this.#rejectIfShuttingDown();
			// Construct every fallible response/bootstrap value inside the
			// transaction so a build/schedule failure rolls back the prepared
			// record and never pins the connection.
			const response: LoadSessionResponse = {
				configOptions: this.#buildConfigOptions(record.session),
				modes: this.#buildModeState(record.session),
			};
			this.#scheduleBootstrapUpdates(record.session.sessionId);
			// Commit the cwd scope only after replay, response construction, and
			// bootstrap scheduling all succeed — a failed first load leaves no
			// half-loaded session and does not pin the connection.
			this.#commitCanonicalScope(canonical);
			this.#invalidateAuthority();
			return response;
		} catch (error) {
			// Any pre-return failure: roll back the prepared record so a failed
			// first load leaves no half-loaded session and does not pin the
			// connection, and commit no cwd scope.
			if (record !== existingRecord) {
				this.#sessions.delete(record.session.sessionId);
				await this.#disposeSessionRecord(record);
			}
			throw error;
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		this.#rejectIfShuttingDown();
		const scope = params.cwd ? this.#stageCanonicalScope(params.cwd) : undefined;
		for (const record of this.#sessions.values()) {
			await record.session.sessionManager.flush();
		}
		this.#rejectIfShuttingDown();
		// Cwd-less / global listing stays display-only and non-authorizing.
		if (!scope) {
			const sessions = await this.#listStoredSessions(undefined);
			const offset = this.#parseCursor(params.cursor ?? undefined);
			const paged = sessions.slice(offset, offset + SESSION_PAGE_SIZE);
			const nextOffset = offset + paged.length;
			return {
				sessions: paged.map(session => this.#toSessionInfo(session)),
				nextCursor: nextOffset < sessions.length ? String(nextOffset) : undefined,
			};
		}
		// Explicit scoped list: stage scope, strict raw inventory, build the full
		// authorization/conflict snapshot BEFORE page slicing so duplicate ids
		// beyond page 1 are known before the first page response. Scope commits
		// only after cursor validation, stored-session read, and full response
		// construction succeed — a failed first list never pins the connection.
		if (params.cursor === undefined) {
			// A new first-page request is a new issuance event. Refresh the complete
			// snapshot and invalidate cursors minted by the previous issuance.
			this.#invalidateAuthority();
		}
		const snapshot = this.#buildAuthoritySnapshot(scope);
		// Scoped cursors carry the authority generation at which they were minted
		// (form `${generation}:${offset}`). A lifecycle change between page 1 and
		// page 2 bumps the generation, so the old cursor is rejected instead of
		// silently rebuilding at the new generation. The cwd-less display cursor
		// stays a plain offset (see #parseCursor).
		const offset = this.#parseScopedCursor(params.cursor ?? undefined, snapshot.generation);
		const stored = await this.#listStoredSessions(scope);
		const storedById = new Map(stored.map(s => [s.id, s] as const));
		const pageIds = snapshot.orderedIds.slice(offset, offset + SESSION_PAGE_SIZE);
		const nextOffset = offset + pageIds.length;
		const pageSessions = pageIds.map(id => storedById.get(id)).filter((s): s is StoredSessionInfo => s !== undefined);
		const response: ListSessionsResponse = {
			sessions: pageSessions.map(session => this.#toSessionInfo(session)),
			nextCursor: nextOffset < snapshot.orderedIds.length ? `${snapshot.generation}:${nextOffset}` : undefined,
		};
		// Commit the scope only after cursor validation, stored-session read, and
		// full response construction succeed.
		this.#commitCanonicalScope(scope);
		return response;
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#rejectIfShuttingDown();
		const canonical = this.#stageCanonicalScope(params.cwd);
		const record = await this.#trackLifecycle(() =>
			this.#resumeManagedSession(params.sessionId, params.cwd, params.mcpServers ?? []),
		);
		this.#rejectIfShuttingDown();
		this.#commitCanonicalScope(canonical);
		this.#invalidateAuthority();
		const response: ResumeSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#rejectIfShuttingDown();
		const canonical = this.#stageCanonicalScope(params.cwd);
		const record = await this.#trackLifecycle(() => this.#forkManagedSession(params));
		this.#rejectIfShuttingDown();
		this.#commitCanonicalScope(canonical);
		this.#invalidateAuthority();
		const response: ForkSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) {
			return {};
		}
		this.#rejectIfTerminal(record);
		await this.#closeManagedSession(params.sessionId, record);
		this.#invalidateAuthority();
		return {};
	}

	/**
	 * Hard delete an ACP session. `DeleteSessionRequest` carries only `sessionId`;
	 * the server owns authorization through the immutable canonical cwd scope and
	 * the complete strict scoped inventory snapshot.
	 *
	 * - No scope / unknown / already-deleted id → lookup-free `{}`.
	 * - Duplicate/conflict id → visible error; neither transcript nor artifacts change.
	 * - Active session → reserve `deleting`, drain/cancel prompt, flush, strict
	 *   dispose/close, recheck identity/state, then verified artifact-first deletion.
	 * - Concurrent delete callers join the terminal promise.
	 */
	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		// Before scope: return {} without scanning/listing storage.
		if (this.#canonicalCwdScope === undefined) {
			return {};
		}
		if (this.#shuttingDown) {
			throw new Error("ACP session delete is unavailable during shutdown");
		}
		const record = this.#sessions.get(params.sessionId);
		if (record) {
			return await this.#deleteActiveSession(params.sessionId, record);
		}
		// Inactive: read authority from the strict inventory snapshot.
		return await this.#deleteInactiveSession(params.sessionId);
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		this.#rejectIfTerminal(record);
		this.#applyModeChange(record.session, params.modeId);
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: this.#buildCurrentModeUpdate(record.session),
		});
		await this.#pushConfigOptionUpdate(record);
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		this.#rejectIfTerminal(record);
		if (typeof params.value === "boolean") {
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		}

		switch (params.configId) {
			case MODE_CONFIG_ID:
				this.#applyModeChange(record.session, params.value);
				break;
			case MODEL_CONFIG_ID:
				await this.#setModelById(record.session, params.value);
				break;
			case THINKING_CONFIG_ID:
				this.#setThinkingLevelById(record.session, params.value);
				break;
			default:
				throw new Error(`Unknown ACP config option: ${params.configId}`);
		}

		// When mode is changed via the generic config-option API, mirror the
		// `current_mode_update` notification that `setSessionMode` emits so
		// ACP clients tracking session-mode state see a consistent transition.
		if (params.configId === MODE_CONFIG_ID) {
			await this.#connection.sessionUpdate({
				sessionId: record.session.sessionId,
				update: this.#buildCurrentModeUpdate(record.session),
			});
		}

		// For `thinking` the lifetime subscription pushes post-bootstrap; only
		// push here when it's not yet installed so pre-bootstrap callers still
		// see the change without a post-bootstrap duplicate.
		const thinkingHandledBySubscription =
			params.configId === THINKING_CONFIG_ID && record.lifetimeUnsubscribe !== undefined;
		if (!thinkingHandledBySubscription) {
			await this.#pushConfigOptionUpdate(record);
		}
		return { configOptions: this.#buildConfigOptions(record.session) };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		this.#rejectIfTerminal(record);
		const activeTurn = record.promptTurn;
		if (activeTurn && !activeTurn.settled && record.session.isStreaming) {
			throw new Error("ACP prompt already in progress for this session");
		}
		return await this.#queuePrompt(record, async () => {
			const previousTurn = record.promptTurn;
			if (previousTurn) {
				// Wait for any prompt that's still settling or whose cancel cleanup is
				// still in flight. We deliberately swallow the prompt rejection (the
				// owning caller already received it) but let cleanup rejections
				// propagate — a timed-out cancel must fail this queued prompt instead
				// of letting it run on a session that is about to be closed.
				await previousTurn.promise.catch(() => undefined);
				await previousTurn.cleanup;
			}

			const converted = this.#convertPromptBlocks(params.prompt);
			const pendingPrompt = Promise.withResolvers<PromptResponse>();
			const metaUserMessageId = params._meta?.userMessageId;
			record.promptTurn = {
				userMessageId: typeof metaUserMessageId === "string" ? metaUserMessageId : crypto.randomUUID(),
				cancelRequested: false,
				settled: false,
				cleanup: undefined,
				usageBaseline: this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
				unsubscribe: undefined,
				resolve: pendingPrompt.resolve,
				reject: pendingPrompt.reject,
				promise: pendingPrompt.promise,
			};

			this.#ensureLifetimeSubscription(record);
			record.promptTurn.unsubscribe = record.session.subscribe(event => {
				void this.#handlePromptEvent(record, event);
			});

			this.#runPromptOrCommand(record, converted.text, converted.images).catch((error: unknown) => {
				this.#finishPrompt(record, undefined, error);
			});

			return await pendingPrompt.promise;
		});
	}

	async #queuePrompt(record: ManagedSessionRecord, run: () => Promise<PromptResponse>): Promise<PromptResponse> {
		const nextQueue = Promise.withResolvers<void>();
		const releaseQueue = nextQueue.resolve;
		const previousQueue = record.promptQueue;
		record.promptQueue = {
			promise: nextQueue.promise,
			release: releaseQueue,
		};
		await previousQueue.promise;
		try {
			return await run();
		} finally {
			releaseQueue();
			if (record.promptQueue.release === releaseQueue) {
				record.promptQueue.release = undefined;
			}
		}
	}

	async #runPromptOrCommand(record: ManagedSessionRecord, text: string, images: AgentImageContent[]): Promise<void> {
		// Namespaced skill commands cannot collide with ACP builtins; handle
		// them before builtin dispatch. Bare `/name` aliases are intentionally
		// not skill commands.
		if (text.startsWith("/skill:") && (await this.#tryRunSkillCommand(record, text))) {
			return;
		}

		const builtinResult = await executeAcpBuiltinSlashCommand(text, {
			session: record.session,
			sessionManager: record.session.sessionManager,
			settings: record.session.settings,
			cwd: record.session.sessionManager.getCwd(),
			output: output => this.#emitCommandOutput(record, output),
			refreshCommands: () => this.#emitAvailableCommandsUpdate(record),
			reloadPlugins: () => this.#reloadPluginState(record),
			notifyTitleChanged: async () => {
				await this.#connection.sessionUpdate({
					sessionId: record.session.sessionId,
					update: {
						sessionUpdate: "session_info_update",
						title: record.session.sessionName,
						updatedAt: new Date().toISOString(),
					},
				});
			},
			notifyConfigChanged: async () => {
				await this.#pushConfigOptionUpdate(record);
			},
		});
		if (builtinResult !== false) {
			if ("prompt" in builtinResult) {
				await record.session.prompt(builtinResult.prompt, { images });
				return;
			}
			const promptTurn = record.promptTurn;
			this.#finishPrompt(record, {
				stopReason: "end_turn",
				usage: this.#buildTurnUsage(
					promptTurn?.usageBaseline ??
						this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
					record.session.sessionManager.getUsageStatistics(),
				),
				_meta: promptTurn ? { userMessageId: promptTurn.userMessageId } : undefined,
			});
			return;
		}

		if (await this.#tryRunSkillCommand(record, text, { directAliasMayCollide: false })) {
			return;
		}

		await record.session.prompt(text, { images });
	}

	async #tryRunSkillCommand(
		record: ManagedSessionRecord,
		text: string,
		options: { directAliasMayCollide?: boolean } = {},
	): Promise<boolean> {
		if (!record.session.skillsSettings?.enableSkillCommands) {
			return false;
		}
		const skillsByCommandName = new Map(
			record.session.skills
				.filter(skill => skill.hide !== true)
				.flatMap(skill => getSkillSlashCommandNames(skill).map(commandName => [commandName, skill] as const)),
		);
		const invocations = parseSkillInvocations(text, skillsByCommandName);
		if (invocations.length > 0) {
			for (let index = 0; index < invocations.length; index += 1) {
				const invocation = invocations[index];
				if (!invocation) continue;
				const activationResult = await resolveSubskillActivationForSkillInvocation({
					cwd: record.session.sessionManager.getCwd(),
					sessionId: record.session.sessionId,
					skillName: invocation.skill.name,
					args: invocation.args,
				});
				const built = await buildSkillPromptMessage(invocation.skill, activationResult.cleanedArgs, {
					subskillActivation: activationResult.activation,
					subskillActivationSet: activationResult.activeSubskillsToPersist,
					cwd: record.session.sessionManager.getCwd(),
					sessionId: record.session.sessionId,
				});
				if (index === invocations.length - 1) {
					await record.session.promptCustomMessage({
						customType: SKILL_PROMPT_MESSAGE_TYPE,
						content: built.message,
						display: true,
						details: built.details,
						attribution: "user",
					});
				} else {
					await record.session.sendCustomMessage({
						customType: SKILL_PROMPT_MESSAGE_TYPE,
						content: built.message,
						display: true,
						details: built.details,
						attribution: "user",
					});
				}
			}
			return true;
		}
		const slashText = text.trimStart();
		if (!slashText.startsWith("/")) {
			return false;
		}
		const spaceIndex = slashText.indexOf(" ");
		const commandName = spaceIndex === -1 ? slashText.slice(1) : slashText.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : slashText.slice(spaceIndex + 1).trim();
		if (
			!isNamespacedSkillSlashCommandName(commandName) &&
			options.directAliasMayCollide !== true &&
			(await this.#directSkillAliasCollides(record, commandName))
		) {
			return false;
		}
		const skill = record.session.skills.find(candidate => isSkillSlashCommandName(commandName, candidate));
		if (!skill || skill.hide === true) {
			return false;
		}
		const activationResult = await resolveSubskillActivationForSkillInvocation({
			cwd: record.session.sessionManager.getCwd(),
			sessionId: record.session.sessionId,
			skillName: skill.name,
			args,
		});
		const built = await buildSkillPromptMessage(skill, activationResult.cleanedArgs, {
			subskillActivation: activationResult.activation,
			subskillActivationSet: activationResult.activeSubskillsToPersist,
			cwd: record.session.sessionManager.getCwd(),
			sessionId: record.session.sessionId,
		});
		await record.session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		});
		return true;
	}

	async #directSkillAliasCollides(record: ManagedSessionRecord, commandName: string): Promise<boolean> {
		if (record.session.customCommands.some(command => command.command.name === commandName)) {
			return true;
		}
		const fileCommands = await loadSlashCommands({ cwd: record.session.sessionManager.getCwd() });
		return fileCommands.some(command => command.name === commandName);
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		const record = this.#getSessionRecord(params.sessionId);
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		const cleanup = this.#beginCancelCleanup(record, promptTurn);
		try {
			await cleanup;
		} catch (error: unknown) {
			// A terminal delete owns the record; let the delete handle the failure
			// rather than racing it with an independent close.
			if (record.terminalState !== "active") {
				return;
			}
			logger.warn("ACP cancel cleanup timed out; closing session", { sessionId: record.session.sessionId, error });
			await this.#closeManagedSession(record.session.sessionId, record);
		}
	}

	/**
	 * Transition a still-running turn into cancellation: mark intent, drop the live-event
	 * subscription, start the bounded `abort()` race, and resolve the ACP prompt response
	 * with `stopReason: "cancelled"` so the client sees acceptance immediately. The
	 * returned promise is the cleanup barrier — it resolves when `abort()` completes and
	 * rejects when the timeout fires. Idempotent: a second call returns the same barrier.
	 */
	#beginCancelCleanup(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		if (promptTurn.cleanup) {
			return promptTurn.cleanup;
		}
		promptTurn.cancelRequested = true;
		promptTurn.unsubscribe?.();
		void this.#emitCancelledPromptIdleUpdate(record);
		const cleanup = this.#runCancelCleanup(record, promptTurn);
		promptTurn.cleanup = cleanup;
		this.#finishPrompt(record, {
			stopReason: "cancelled",
			usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
			_meta: { userMessageId: promptTurn.userMessageId },
		});
		return cleanup;
	}

	async #runCancelCleanup(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("ACP cancel cleanup timed out")), this.#cancelCleanupTimeoutMs);
		});
		try {
			await Promise.race([record.session.abort(), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
			// Order matters: clear `cleanup` before evicting the slot so the slot-eviction
			// branch matches what `#finishPrompt` saw if it ran first.
			promptTurn.cleanup = undefined;
			if (promptTurn.settled && record.promptTurn === promptTurn) {
				record.promptTurn = undefined;
			}
		}
	}

	async extMethod(method: string, params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		switch (method) {
			case "_gjc/sessions/listAll": {
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(5000, params.limit as number)) : 1000;
				const sessions = await SessionManager.listAll();
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return {
					sessions: sorted.map(s => this.#toSessionInfo(s)),
					total: sessions.length,
				};
			}
			case "_gjc/projects/list": {
				const sessions = await SessionManager.listAll();
				const buckets = new Map<
					string,
					{ cwd: string; sessionCount: number; lastActivityAt: number; lastTitle: string }
				>();
				for (const s of sessions) {
					if (!s.cwd) continue;
					const ts = s.modified.getTime();
					const existing = buckets.get(s.cwd);
					if (existing) {
						existing.sessionCount += 1;
						if (ts > existing.lastActivityAt) {
							existing.lastActivityAt = ts;
							existing.lastTitle = s.title ?? "";
						}
					} else {
						buckets.set(s.cwd, {
							cwd: s.cwd,
							sessionCount: 1,
							lastActivityAt: ts,
							lastTitle: s.title ?? "",
						});
					}
				}
				const projects = Array.from(buckets.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
				return { projects, totalSessions: sessions.length };
			}
			case "_gjc/chats/byCwd": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				if (!cwd) throw new Error("cwd required");
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(500, params.limit as number)) : 100;
				const sessions = await SessionManager.list(cwd);
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return { sessions: sorted.map(s => this.#toSessionInfo(s)) };
			}
			case "_gjc/usage": {
				const [firstRecord] = this.#sessions.values();
				const target = firstRecord?.session ?? this.#initialSession;
				if (!target) {
					return { reports: [] };
				}
				const reports = await target.fetchUsageReports();
				return { reports: reports ?? [] };
			}
			case "_gjc/extensions": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				const sm = await Settings.init();
				const disabledIds = (sm.get("disabledExtensions") as string[] | undefined) ?? [];
				const extensions = await loadAllExtensions(cwd, disabledIds);
				return { extensions: extensions as unknown as Array<{ [key: string]: unknown }> };
			}
			case "_gjc/extensions/toggle": {
				const providerId = params.providerId;
				if (typeof providerId !== "string") throw new Error("providerId required");
				if (params.enabled === false) {
					disableProvider(providerId);
					return { enabled: false };
				}
				enableProvider(providerId);
				return { enabled: true };
			}
			default:
				throw new Error(`Unknown ACP ext method: ${method}`);
		}
	}

	async extNotification(_method: string, _params: { [key: string]: unknown }): Promise<void> {}

	get signal(): AbortSignal {
		return this.#connection.signal;
	}

	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#registerConnectionCleanup(): void {
		if (this.#cleanupRegistered) {
			return;
		}
		this.#cleanupRegistered = true;
		this.#connection.signal.addEventListener(
			"abort",
			() => {
				this.#shuttingDown = true;
				// Mark shutdown under mutex (no actual mutex needed — single-threaded),
				// reject new scope/inventory/lifecycle work, then await terminal work.
				this.#shutdownPromise = (async () => {
					// Join lifecycle preparation that has not registered yet. Each tracked
					// operation rechecks shutdown and disposes its prepared session before settling.
					await Promise.allSettled(Array.from(this.#lifecycleOperations));
					const terminalPromises = Array.from(this.#sessions.values())
						.map(r => r.terminalPromise)
						.filter((p): p is Promise<DeleteSessionResponse> => p !== undefined);
					await Promise.allSettled(terminalPromises);
					await this.#disposeAllSessions();
					// Clear connection-local authority.
					this.#authoritySnapshot = undefined;
					this.#canonicalCwdScope = undefined;
				})();
			},
			{ once: true },
		);
	}

	/**
	 * Connection-local shutdown promise. Resolves once all terminal work (dispose,
	 * active deletes, abort cleanup) has settled. `acp-mode.ts` awaits this after
	 * transport closure so `process.exit` never kills in-flight deletion/disposal.
	 */
	get shutdownPromise(): Promise<void> {
		return this.#shutdownPromise ?? Promise.resolve();
	}

	async #trackLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		this.#rejectIfShuttingDown();
		const start = Promise.withResolvers<void>();
		const promise = start.promise.then(operation);
		this.#lifecycleOperations.add(promise);
		start.resolve();
		try {
			return await promise;
		} finally {
			this.#lifecycleOperations.delete(promise);
		}
	}

	async #createNewSessionRecord(cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const session = await this.#createSession(path.resolve(cwd));
		try {
			await session.sessionManager.ensureOnDisk();
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers);
	}

	async #loadManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#rejectIfTerminal(existing);
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const candidate = this.#resolveStrictLifecycleCandidate(sessionId, cwd);
		return await this.#openStoredSession(candidate, cwd, mcpServers, sessionId);
	}

	async #resumeManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#rejectIfTerminal(existing);
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const candidate = this.#resolveStrictLifecycleCandidate(sessionId, cwd);
		return await this.#openStoredSession(candidate, cwd, mcpServers, sessionId);
	}

	/**
	 * Resolve a single exact-one scoped candidate via a fresh strict inventory.
	 * Rejects duplicates and inventory failures — never falls back to a forgiving
	 * first-match lookup. Used by load/resume so authoritative lifecycle paths bind
	 * exact identity before opening a stored session.
	 */
	#resolveStrictLifecycleCandidate(sessionId: string, scope: string): StrictInventoryCandidate {
		const snapshot = this.#buildFreshAuthoritySnapshot(scope);
		const entry = snapshot.entries.get(sessionId);
		if (!entry) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		if (entry.kind !== "candidate") {
			throw new Error(`ACP session ${sessionId} load failed: ${entry.reason}`);
		}
		return entry.candidate;
	}

	async #forkManagedSession(params: ForkSessionRequest): Promise<ManagedSessionRecord> {
		const sourcePath = await this.#resolveForkSourceSessionPath(params.sessionId);
		const session = await this.#createSession(path.resolve(params.cwd));
		try {
			const success = await session.switchSession(sourcePath);
			if (!success) {
				throw new Error(`ACP session fork was cancelled: ${params.sessionId}`);
			}
			const forked = await session.fork();
			if (!forked) {
				throw new Error(`ACP session fork failed: ${params.sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, params.mcpServers ?? []);
	}

	async #openStoredSession(
		issued: StrictInventoryCandidate,
		cwd: string,
		mcpServers: McpServer[],
		sessionId: string,
	): Promise<ManagedSessionRecord> {
		const session = await this.#createSession(path.resolve(cwd));
		try {
			const current = this.#resolveStrictLifecycleCandidate(sessionId, cwd);
			if (
				current.path !== issued.path ||
				current.cwd !== issued.cwd ||
				current.identity.dev !== issued.identity.dev ||
				current.identity.ino !== issued.identity.ino
			) {
				throw new Error(`ACP session ${sessionId} changed while opening`);
			}
			const success = await session.switchSession(current.path);
			if (!success) {
				throw new Error(`ACP session load was cancelled: ${sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers);
	}

	async #registerPreparedSession(session: AgentSession, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const record = this.#createManagedSessionRecord(session);
		session.setClientBridge(createAcpClientBridge(this.#connection, session.sessionId, this.#clientCapabilities));
		// The lifetime subscription normally follows the bootstrap race guard, but
		// prompt() installs it eagerly once the client has demonstrated session ownership.
		try {
			await this.#configureExtensions(record);
			await this.#configureMcpServers(record, mcpServers);
			if (this.#shuttingDown) {
				await this.#disposeSessionRecord(record);
				throw new Error("ACP session lifecycle is unavailable during shutdown");
			}
			this.#sessions.set(session.sessionId, record);
			return record;
		} catch (error) {
			await this.#disposeSessionRecord(record);
			throw error;
		}
	}

	#createManagedSessionRecord(session: AgentSession): ManagedSessionRecord {
		return {
			session,
			mcpManager: undefined,
			promptTurn: undefined,
			promptQueue: { promise: Promise.resolve(), release: undefined },
			liveMessageId: undefined,
			liveMessageProgress: undefined,
			toolArgsById: new Map(),
			extensionsConfigured: false,
			lifetimeUnsubscribe: undefined,
			terminalState: "active",
			terminalFailure: undefined,
			terminalPromise: undefined,
		};
	}

	#ensureLifetimeSubscription(record: ManagedSessionRecord): void {
		if (record.lifetimeUnsubscribe) {
			return;
		}
		record.lifetimeUnsubscribe = record.session.subscribe(event => {
			void this.#handleLifetimeEvent(record, event);
		});
	}

	async #handleLifetimeEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") {
			// Prompt-bound compaction is normally forwarded by #handlePromptEvent. The lifetime
			// subscription covers idle maintenance and the end event after prompt cancellation.
			const promptTurn = record.promptTurn;
			if (
				isPromptTurnInFlight(promptTurn) &&
				(!promptTurn.cancelRequested || event.type === "auto_compaction_start")
			) {
				return;
			}
			for (const notification of mapAgentWireEventPayloadToAcpSessionUpdates(
				toAgentWireEventPayload(event),
				record.session.sessionId,
				{
					cwd: record.session.sessionManager.getCwd(),
					compactionEndPhase: "idle",
				},
			)) {
				await this.#connection.sessionUpdate(notification);
			}
			return;
		}
		if (event.type !== "thinking_level_changed") {
			return;
		}
		try {
			await this.#pushConfigOptionUpdate(record);
		} catch (error) {
			logger.warn("Failed to push thinking-level config_option_update", {
				sessionId: record.session.sessionId,
				error,
			});
		}
	}

	#getSessionRecord(sessionId: string): ManagedSessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record) {
			throw new Error(`Unsupported ACP session: ${sessionId}`);
		}
		return record;
	}

	#assertMatchingCwd(session: AgentSession, cwd: string): void {
		const expected = path.resolve(cwd);
		const actual = path.resolve(session.sessionManager.getCwd());
		if (actual !== expected) {
			throw new Error(`ACP session ${session.sessionId} is already loaded for ${actual}, not ${expected}`);
		}
	}

	async #resolveForkSourceSessionPath(sessionId: string): Promise<string> {
		const loaded = this.#sessions.get(sessionId);
		if (loaded) {
			if (loaded.terminalState !== "active") {
				throw new Error(`ACP session fork is unavailable while it is in terminal state: ${sessionId}`);
			}
			if (isPromptTurnInFlight(loaded.promptTurn)) {
				throw new Error(`ACP session fork is unavailable while a prompt is in progress: ${sessionId}`);
			}
			await loaded.session.sessionManager.flush();
			const sessionPath = loaded.session.sessionManager.getSessionFile();
			if (!sessionPath) {
				throw new Error(`ACP session cannot be forked before it is persisted: ${sessionId}`);
			}
			return sessionPath;
		}

		// Inactive fork source: exact-one scoped lookup only. Never use global
		// listAll/first-match — that was the P1 data-loss path.
		const scope = this.#canonicalCwdScope;
		if (!scope) {
			throw new Error(`ACP session not found (no scope established): ${sessionId}`);
		}
		const snapshot = this.#buildFreshAuthoritySnapshot(scope);
		const entry = snapshot.entries.get(sessionId);
		if (!entry) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		if (entry.kind !== "candidate") {
			throw new Error(`ACP session fork failed: ${entry.reason}`);
		}
		return entry.candidate.path;
	}

	async #handlePromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled || promptTurn.cancelRequested) {
			return;
		}

		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			record.toolArgsById.set(event.toolCallId, event.args);
		}

		this.#prepareLiveAssistantMessage(record, event);
		for (const notification of mapAgentWireEventPayloadToAcpSessionUpdates(
			toAgentWireEventPayload(event),
			record.session.sessionId,
			{
				getMessageId: message => this.#getLiveMessageId(record, message),
				getMessageProgress: message => this.#getLiveMessageProgress(record, message),
				getToolArgs: toolCallId => record.toolArgsById.get(toolCallId),
				cwd: record.session.sessionManager.getCwd(),
				compactionEndPhase: "responding",
			},
		)) {
			await this.#connection.sessionUpdate(notification);
		}
		if (event.type === "tool_execution_end") {
			record.toolArgsById.delete(event.toolCallId);
		}
		this.#clearLiveAssistantMessageAfterEvent(record, event);

		if (event.type === "agent_end") {
			await this.#emitEndOfTurnUpdates(record);
			await this.#waitForAcpPromptIdle(record);
			this.#finishPrompt(record, {
				stopReason: this.#resolveStopReason(event, promptTurn.cancelRequested),
				usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
				_meta: { userMessageId: promptTurn.userMessageId },
			});
		}
	}

	async #waitForAcpPromptIdle(record: ManagedSessionRecord): Promise<void> {
		for (let pass = 0; pass < ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES; pass++) {
			await record.session.waitForIdle();
			const delivered = await record.session.drainAsyncJobDeliveriesForAcp({
				timeoutMs: ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS,
			});
			if (!delivered) {
				return;
			}
		}

		await record.session.waitForIdle();
	}

	#prepareLiveAssistantMessage(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			(event.type === "message_start" || !record.liveMessageId || !record.liveMessageProgress)
		) {
			record.liveMessageId = crypto.randomUUID();
			record.liveMessageProgress = { textEmitted: false, thoughtEmitted: false };
		}
	}

	#clearLiveAssistantMessageAfterEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "agent_end") {
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
		}
	}

	#getLiveMessageId(record: ManagedSessionRecord, message: unknown): string | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageId ??= crypto.randomUUID();
		return record.liveMessageId;
	}

	#getLiveMessageProgress(
		record: ManagedSessionRecord,
		message: unknown,
	): { textEmitted: boolean; thoughtEmitted: boolean } | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageProgress ??= { textEmitted: false, thoughtEmitted: false };
		return record.liveMessageProgress;
	}

	#finishPrompt(record: ManagedSessionRecord, response?: PromptResponse, error?: unknown): void {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		promptTurn.settled = true;
		promptTurn.unsubscribe?.();
		// Keep the slot occupied until cancel cleanup finishes — `#runCancelCleanup`
		// evicts the slot in its finally block once both flags say it's safe.
		if (!promptTurn.cleanup && record.promptTurn === promptTurn) {
			record.promptTurn = undefined;
		}
		if (error !== undefined) {
			promptTurn.reject(error);
			return;
		}
		promptTurn.resolve(response ?? { stopReason: "end_turn" });
	}

	#resolveStopReason(
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
		cancelRequested: boolean,
	): PromptResponse["stopReason"] {
		if (cancelRequested) {
			return "cancelled";
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		const reason = lastAssistant?.stopReason;
		switch (reason) {
			case "aborted":
				return "cancelled";
			case "length":
				return "max_tokens";
			case "error": {
				const errorMessage = lastAssistant?.errorMessage ?? "";
				if (/content[_ ]?filter|refus(al|ed)/i.test(errorMessage)) {
					return "refusal";
				}
				return "end_turn";
			}
			default:
				return "end_turn";
		}
	}

	async #emitCommandOutput(record: ManagedSessionRecord, text: string): Promise<void> {
		if (!text) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: crypto.randomUUID(),
			},
		});
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) {
			throw new Error(`ACP cwd must be absolute: ${cwd}`);
		}
	}

	/**
	 * Validate the cwd and reject cross-cwd calls against an already-committed scope,
	 * WITHOUT committing. Returns the canonical (resolved) cwd. Pair with
	 * {@link #commitCanonicalScope} after the lifecycle operation succeeds so a failed
	 * first new/load/resume/fork/list never pins the connection to a cwd it never served.
	 */
	#stageCanonicalScope(cwd: string): string {
		this.#assertAbsoluteCwd(cwd);
		const canonical = path.resolve(cwd);
		if (this.#canonicalCwdScope !== undefined && this.#canonicalCwdScope !== canonical) {
			throw new Error(`ACP connection is scoped to ${this.#canonicalCwdScope}, not ${canonical}`);
		}
		return canonical;
	}

	/** Commit the canonical cwd scope on the first successful explicit-cwd call. */
	#commitCanonicalScope(canonical: string): void {
		if (this.#canonicalCwdScope === undefined) {
			this.#canonicalCwdScope = canonical;
		}
	}

	/** Bump the generation and discard the authority snapshot on lifecycle changes. */
	#invalidateAuthority(): void {
		this.#authorityGeneration += 1;
		this.#authoritySnapshot = undefined;
	}

	#rejectIfTerminal(record: ManagedSessionRecord): void {
		if (record.terminalState !== "active") {
			throw new Error(`ACP session ${record.session.sessionId} is in terminal state: ${record.terminalState}`);
		}
	}

	#rejectIfShuttingDown(): void {
		if (this.#shuttingDown) {
			throw new Error("ACP session lifecycle is unavailable during shutdown");
		}
	}

	/**
	 * Build (or reuse) the complete authorization snapshot from a strict raw scoped
	 * inventory. The cached pagination snapshot is reused for display/list paging.
	 * Any inventory failure throws a sanitized error — it grants zero authority.
	 * The snapshot binds every discovered id to its exact-identity candidate or a
	 * conflict tombstone BEFORE pagination, so duplicates beyond page 1 are known
	 * before the first page response.
	 */
	#buildAuthoritySnapshot(scope: string): AcpAuthoritySnapshot {
		if (this.#authoritySnapshot?.scope === scope) {
			return this.#authoritySnapshot;
		}
		return this.#rebuildAuthoritySnapshot(scope, true);
	}

	/**
	 * Build a FRESH authorization snapshot, ignoring the cached pagination snapshot.
	 * Destructive authority (delete, inactive fork) must read storage at mutation
	 * time so an external create/remove/replace/duplicate between list and delete
	 * cannot yield a stale no-op or wrong mutation. The result is NOT cached: it
	 * must not poison the generation-aware pagination cursor contract.
	 */
	#buildFreshAuthoritySnapshot(scope: string): AcpAuthoritySnapshot {
		return this.#rebuildAuthoritySnapshot(scope, false);
	}

	#rebuildAuthoritySnapshot(scope: string, cache: boolean): AcpAuthoritySnapshot {
		const inventory = SessionManager.inventorySessionsStrict(scope);
		if (inventory.kind === "failure") {
			const messages = inventory.failures.map(f => `${f.kind}: ${f.message}`);
			throw new Error(`ACP scoped session inventory is incomplete: ${messages.join("; ")}`);
		}
		const entries = new Map<string, AcpAuthorityEntry>();
		const orderedIds: string[] = [];
		for (const candidate of inventory.candidates) {
			const existing = entries.get(candidate.id);
			if (existing) {
				entries.set(candidate.id, { kind: "conflict", reason: "Duplicate session id in scoped inventory" });
			} else {
				entries.set(candidate.id, { kind: "candidate", candidate });
				orderedIds.push(candidate.id);
			}
		}
		const snapshot: AcpAuthoritySnapshot = {
			scope,
			entries,
			orderedIds,
			generation: this.#authorityGeneration,
		};
		if (cache) {
			this.#authoritySnapshot = snapshot;
		}
		return snapshot;
	}

	/**
	 * Delete an active (loaded) session via the per-record terminal state machine.
	 * Reserves `deleting` before the first await; concurrent deletes join the
	 * terminal promise. On failure the state transitions to `pre_dispatch_retryable`
	 * (close_failed_retryable), `cleanup_pending` (verified-delete partial), or
	 * `terminal_failure` (close_unknown / quiescence / unexpected) — all non-`active`
	 * states reject prompt/config/close/load/resume/fork. Only `pre_dispatch_retryable`
	 * and `cleanup_pending` permit a retry delete; `terminal_failure` never reopens.
	 */
	async #deleteActiveSession(sessionId: string, record: ManagedSessionRecord): Promise<DeleteSessionResponse> {
		// Concurrent delete joins the in-progress terminal promise.
		if (record.terminalPromise) {
			return await record.terminalPromise;
		}
		// terminal_failure: never reopen — share the settled error.
		if (record.terminalState === "terminal_failure") {
			throw record.terminalFailure ?? new Error(`ACP session ${sessionId} has a settled terminal failure`);
		}
		// Only active / pre_dispatch_retryable / cleanup_pending may start a delete.
		if (record.terminalState === "deleting") {
			throw new Error(`ACP session ${sessionId} is being deleted`);
		}
		record.terminalState = "deleting";
		const scope = this.#canonicalCwdScope!;
		const terminalPromise = (async (): Promise<DeleteSessionResponse> => {
			try {
				// Quiesce — failure is terminal (never swallow).
				try {
					await this.#quiesceForDelete(sessionId, record);
				} catch (quiesceError) {
					record.terminalState = "terminal_failure";
					record.terminalFailure = quiesceError instanceof Error ? quiesceError : new Error(String(quiesceError));
					throw quiesceError;
				}
				const manager = record.session.sessionManager;
				// Strict close — outcome determines retryability.
				const closeOutcome = await record.session.closeWriterStrict();
				if (closeOutcome.kind !== "closed") {
					if (closeOutcome.kind === "close_failed_retryable") {
						record.terminalState = "pre_dispatch_retryable";
					} else {
						record.terminalState = "terminal_failure";
						record.terminalFailure = closeOutcome.error;
					}
					const reason =
						closeOutcome.kind === "close_unknown"
							? "writer close outcome is unknown"
							: "writer close failed before dispatch";
					throw new Error(`ACP session ${sessionId} cannot be deleted: ${reason}`);
				}
				// Recheck: the record must still own this exact session.
				if (this.#sessions.get(sessionId) !== record || record.terminalState !== "deleting") {
					record.terminalState = "terminal_failure";
					record.terminalFailure = new Error(`ACP session ${sessionId} state changed during deletion`);
					throw new Error(`ACP session ${sessionId} state changed during deletion`);
				}
				const sessionFile = manager.getSessionFile();
				const sessionDir = manager.getSessionDir();
				if (!sessionFile) {
					record.terminalState = "terminal_failure";
					record.terminalFailure = new Error(`ACP session ${sessionId} is not persisted and cannot be deleted`);
					throw new Error(`ACP session ${sessionId} is not persisted and cannot be deleted`);
				}
				const snapshot = this.#buildFreshAuthoritySnapshot(scope);
				const entry = snapshot.entries.get(sessionId);
				if (entry?.kind !== "candidate") {
					record.terminalState = "terminal_failure";
					record.terminalFailure = new Error(`ACP session ${sessionId} is not an exact-one scoped candidate`);
					throw new Error(`ACP session ${sessionId} is not an exact-one scoped candidate`);
				}
				if (entry.candidate.path !== sessionFile) {
					record.terminalState = "terminal_failure";
					record.terminalFailure = new Error(`ACP session ${sessionId} transcript path changed during deletion`);
					throw new Error(`ACP session ${sessionId} transcript path changed during deletion`);
				}
				this.#assertPendingTranscriptIdentity(sessionId, entry.candidate.identity);
				const sessionsRoot = path.dirname(sessionDir);
				const target: VerifiedSessionDeleteTarget = {
					sessionsRoot,
					transcriptPath: sessionFile,
					sessionId,
					cwd: manager.getCwd(),
					transcriptIdentity: {
						dev: entry.candidate.identity.dev,
						ino: entry.candidate.identity.ino,
					},
					...this.#pendingArtifactsIdentity(sessionId),
				};
				const outcome = await manager.deleteSessionVerified(target);
				if (outcome.kind !== "deleted") {
					record.terminalState = "cleanup_pending";
					this.#recordPendingDeleteEvidence(sessionId, outcome);
					throw new Error(
						`ACP session ${sessionId} delete is incomplete: ${outcome.phase} cleanup pending (${outcome.error.message})`,
					);
				}
				// Fully deleted: clear retry evidence, remove from active map, dispose.
				record.terminalState = "deleted";
				this.#pendingDeleteEvidence.delete(sessionId);
				this.#sessions.delete(sessionId);
				this.#invalidateAuthority();
				await this.#disposeSessionRecord(record);
				return {};
			} catch (error) {
				// terminalState was set at the failure point above. For any
				// unexpected error that left the state as `deleting`, treat it
				// as terminal_failure so the record never silently reopens.
				if (record.terminalState === "deleting") {
					record.terminalState = "terminal_failure";
					record.terminalFailure = error instanceof Error ? error : new Error(String(error));
				}
				record.terminalPromise = undefined;
				this.#invalidateAuthority();
				throw error;
			}
		})();
		record.terminalPromise = terminalPromise;
		return await terminalPromise;
	}

	/**
	 * Delete an inactive (not currently loaded) session. The ID must have been
	 * issued by the last complete scoped authority snapshot; an absent/unissued ID
	 * returns lookup-free `{}` with NO inventory scan. Only after issuance may a
	 * fresh strict inventory revalidate the same exact candidate before mutation.
	 * A repeat-unknown (issued but gone from the fresh inventory) is also lookup-free `{}`.
	 */
	async #deleteInactiveSession(sessionId: string): Promise<DeleteSessionResponse> {
		const scope = this.#canonicalCwdScope!;
		// Gate: only IDs issued by the last complete scoped authority snapshot
		// may trigger a fresh inventory scan. Absent/unissued → lookup-free {}.
		const issued = this.#authoritySnapshot?.entries.get(sessionId);
		if (!issued) {
			return {};
		}
		if (issued.kind === "conflict") {
			throw new Error(`ACP session delete failed: ${issued.reason}`);
		}
		// Fresh strict inventory to revalidate the same exact candidate.
		const snapshot = this.#buildFreshAuthoritySnapshot(scope);
		const entry = snapshot.entries.get(sessionId);
		if (!entry) {
			// Repeat unknown: issued but no longer present in the fresh inventory.
			return {};
		}
		if (entry.kind === "conflict") {
			throw new Error(`ACP session delete failed: ${entry.reason}`);
		}
		const candidate = entry.candidate;
		if (
			candidate.path !== issued.candidate.path ||
			candidate.cwd !== issued.candidate.cwd ||
			candidate.identity.dev !== issued.candidate.identity.dev ||
			candidate.identity.ino !== issued.candidate.identity.ino
		) {
			throw new Error(`ACP session ${sessionId} changed since authority was issued`);
		}
		this.#assertPendingTranscriptIdentity(sessionId, candidate.identity);
		const sessionsRoot = path.dirname(candidate.path);
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot,
			transcriptPath: candidate.path,
			sessionId,
			cwd: candidate.cwd,
			transcriptIdentity: { dev: candidate.identity.dev, ino: candidate.identity.ino },
			...this.#pendingArtifactsIdentity(sessionId),
		};
		const storage = new FileSessionStorage();
		const outcome = await storage.deleteSessionVerified(target);
		if (outcome.kind !== "deleted") {
			this.#recordPendingDeleteEvidence(sessionId, outcome);
			throw new Error(
				`ACP session ${sessionId} delete is incomplete: ${outcome.phase} cleanup pending (${outcome.error.message})`,
			);
		}
		this.#pendingDeleteEvidence.delete(sessionId);
		this.#invalidateAuthority();
		return {};
	}

	#convertPromptBlocks(blocks: PromptRequest["prompt"]): { text: string; images: AgentImageContent[] } {
		const textParts: string[] = [];
		const images: AgentImageContent[] = [];
		for (const block of blocks) {
			switch (block.type) {
				case "text":
					textParts.push(block.text);
					break;
				case "image":
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
					break;
				case "resource":
					if ("text" in block.resource) {
						textParts.push(block.resource.text);
					} else if (typeof block.resource.mimeType === "string" && block.resource.mimeType.startsWith("image/")) {
						// `embeddedContext: true` covers both text and blob resources, but
						// blobs aren't directly consumable by the LLM. Route image blobs
						// to the images array so the user's intent survives; everything
						// else falls back to the URI placeholder below.
						images.push({ type: "image", data: block.resource.blob, mimeType: block.resource.mimeType });
					} else {
						textParts.push(`[embedded resource: ${block.resource.uri}]`);
					}
					break;
				case "resource_link":
					textParts.push(block.title ?? block.name ?? block.uri);
					break;
				case "audio":
					textParts.push("[audio omitted]");
					break;
			}
		}
		return {
			text: textParts.join("\n\n").trim(),
			images,
		};
	}

	async #pushConfigOptionUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: this.#buildConfigOptions(record.session),
			},
		});
	}

	#buildConfigOptions(session: AgentSession): SessionConfigOption[] {
		const currentModeId = this.#getCurrentModeId(session);
		const modeOptions = this.#getAvailableModes(session).map(mode => ({
			value: mode.id,
			name: mode.name,
			description: mode.description,
		}));
		const configOptions: SessionConfigOption[] = [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: currentModeId,
				options: modeOptions,
			},
		];

		const models = session.getAvailableModels();
		const currentModel = session.model;
		if (models.length > 0) {
			configOptions.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel ? this.#toModelId(currentModel) : this.#toModelId(models[0]),
				options: models.map(model => ({
					value: this.#toModelId(model),
					name: model.name,
					description: `${model.provider}/${model.id}`,
				})),
			});
		}

		configOptions.push({
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: this.#toThinkingConfigValue(session.thinkingLevel),
			options: this.#buildThinkingOptions(session),
		});
		return configOptions;
	}

	#buildThinkingOptions(session: AgentSession): Array<{ value: string; name: string; description?: string }> {
		return [
			{ value: THINKING_OFF, name: "Off" },
			...session.getAvailableThinkingLevels().map(level => ({
				value: level,
				name: level,
			})),
		];
	}

	#toThinkingConfigValue(value: string | undefined): string {
		return value && value !== "inherit" ? value : THINKING_OFF;
	}

	async #setModelById(session: AgentSession, modelId: string): Promise<void> {
		const model = session.getAvailableModels().find(candidate => this.#toModelId(candidate) === modelId);
		if (!model) {
			throw new Error(`Unknown ACP model: ${modelId}`);
		}
		await session.setModel(model);
	}

	#setThinkingLevelById(session: AgentSession, value: string): void {
		const thinkingLevel = parseThinkingLevel(value);
		if (!thinkingLevel) {
			throw new Error(`Unknown ACP thinking level: ${value}`);
		}
		session.setThinkingLevel(thinkingLevel);
	}

	#toModelId(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#getAvailableModes(session: AgentSession): Array<{ id: string; name: string; description: string }> {
		const modes = [{ id: ACP_DEFAULT_MODE_ID, name: "Default", description: "Standard ACP headless mode" }];
		if (session.settings.get("plan.enabled")) {
			modes.push({
				id: ACP_PLAN_MODE_ID,
				name: "Plan",
				description: "Read-only planning mode that drafts a plan to a markdown file before any code changes",
			});
		}
		void session;
		return modes;
	}

	#getCurrentModeId(session: AgentSession): string {
		return session.getPlanModeState()?.enabled ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
	}

	#applyModeChange(session: AgentSession, modeId: string): void {
		const availableModes = this.#getAvailableModes(session);
		if (!availableModes.some(mode => mode.id === modeId)) {
			throw new Error(`Unsupported ACP mode: ${modeId}`);
		}
		if (modeId === ACP_PLAN_MODE_ID) {
			const previous = session.getPlanModeState();
			session.setPlanModeState({
				enabled: true,
				planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
				workflow: previous?.workflow ?? "parallel",
				reentry: previous !== undefined,
			});
		} else {
			session.setPlanModeState(undefined);
		}
	}

	#buildModeState(session: AgentSession): SessionModeState {
		return {
			availableModes: this.#getAvailableModes(session),
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	#buildCurrentModeUpdate(session: AgentSession): SessionUpdate {
		return {
			sessionUpdate: "current_mode_update",
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	async #buildAvailableCommands(session: AgentSession): Promise<AvailableCommand[]> {
		const commands: AvailableCommand[] = [];
		const seenNames = new Set<string>();
		const appendCommand = (command: AvailableCommand): void => {
			if (seenNames.has(command.name)) {
				return;
			}
			seenNames.add(command.name);
			commands.push(command);
		};

		// Advertise builtins first, then custom/user commands, then file-based
		// slash commands, then namespaced `/skill:<name>` skills.
		for (const command of ACP_BUILTIN_SLASH_COMMANDS) {
			appendCommand(command);
		}

		for (const command of session.customCommands) {
			appendCommand({
				name: command.command.name,
				description: command.command.description,
				input: { hint: "arguments" },
			});
		}

		for (const command of await loadSlashCommands({ cwd: session.sessionManager.getCwd() })) {
			appendCommand({
				name: command.name,
				description: command.description,
			});
		}

		if (session.skillsSettings?.enableSkillCommands) {
			for (const skill of session.skills) {
				if (skill.hide === true) continue;
				for (const name of getSkillSlashCommandNames(skill)) {
					appendCommand({
						name,
						description: skill.description || `Run ${skill.name} skill`,
						input: { hint: "arguments" },
					});
				}
			}
		}

		return commands;
	}

	#toSessionInfo(session: StoredSessionInfo): SessionInfo {
		return {
			sessionId: session.id,
			cwd: session.cwd,
			title: session.title,
			updatedAt: session.modified.toISOString(),
			_meta: {
				messageCount: session.messageCount,
				size: session.size,
			},
		};
	}

	#scheduleBootstrapUpdates(sessionId: string): void {
		// Defer first notifications until the response has reached the client.
		// Zed's agent-client-protocol reader dispatches responses and
		// notifications to different async tasks; sending the first
		// `available_commands_update` from `setTimeout(0)` reliably loses the
		// race against the response handler and Zed logs `Received session
		// notification for unknown session` then drops the update — leaving
		// the slash-command palette empty (#1015 follow-up; see
		// zed-industries/zed#55965 for the same race biting other ACP agents).
		// `ACP_BOOTSTRAP_RACE_GUARD_MS` is invisible to the operator and large
		// enough that the response future has scheduled before our timer fires
		// on stdio-only transports.
		//
		// The session-lifetime subscription normally shares this guard so extension
		// work cannot notify an unknown session id. prompt() may install it earlier:
		// receipt of a prompt proves the client already owns the returned session id,
		// and closes the cancellation window before this timer fires.
		setTimeout(() => {
			if (this.#connection.signal.aborted) {
				return;
			}
			const record = this.#sessions.get(sessionId);
			if (!record) {
				return;
			}
			this.#ensureLifetimeSubscription(record);
			void this.#emitBootstrapUpdates(sessionId, record);
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	async #emitBootstrapUpdates(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		if (this.#sessions.get(sessionId) !== record) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: record.session.sessionManager.getHeader()?.timestamp,
			},
		});
	}

	async #emitAvailableCommandsUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
	}

	/** Ensure cancellation clears a previously emitted busy/compacting phase even if abort never produces an end event. */
	async #emitCancelledPromptIdleUpdate(record: ManagedSessionRecord): Promise<void> {
		if (this.#connection.signal.aborted) {
			return;
		}
		try {
			await this.#connection.sessionUpdate({
				sessionId: record.session.sessionId,
				update: {
					sessionUpdate: "session_info_update",
					title: record.session.sessionName,
					updatedAt: new Date().toISOString(),
					_meta: {
						gjcPhase: "idle",
						running: false,
						gjcRunning: false,
					},
				},
			});
		} catch (error) {
			logger.warn("Failed to emit cancelled ACP prompt idle update", { error });
		}
	}

	/**
	 * Reload plugin/registry state for an ACP session. Mirrors the interactive
	 * `/reload-plugins` and `/move` flows: invalidates the plugin-roots cache,
	 * resets the capability cache, refreshes the session's slash-command state,
	 * then re-advertises commands so the client sees newly installed/disabled
	 * plugins.
	 */
	async #reloadPluginState(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		const fileCommands = await loadSlashCommands({ cwd });
		record.session.setSlashCommands(fileCommands);
		await record.session.refreshSshTool({ activateIfAvailable: true });
		await this.#emitAvailableCommandsUpdate(record);
	}

	async #emitEndOfTurnUpdates(record: ManagedSessionRecord): Promise<void> {
		const sessionId = record.session.sessionId;

		const contextUsage = record.session.getContextUsage();
		if (contextUsage) {
			const usageStats = record.session.sessionManager.getUsageStatistics();
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "usage_update",
					size: contextUsage.contextWindow,
					used: contextUsage.tokens ?? 0,
					cost: usageStats.cost > 0 ? { amount: usageStats.cost, currency: "USD" } : undefined,
				},
			});
		}

		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: new Date().toISOString(),
				_meta: {
					gjcPhase: "idle",
					running: false,
					gjcRunning: false,
				},
			},
		});
	}

	#cloneUsageStatistics(usage: UsageStatistics): UsageStatistics {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			premiumRequests: usage.premiumRequests,
			cost: usage.cost,
		};
	}

	#buildTurnUsage(previous: UsageStatistics, current: UsageStatistics): Usage | undefined {
		const inputTokens = Math.max(0, current.input - previous.input);
		const outputTokens = Math.max(0, current.output - previous.output);
		const cachedReadTokens = Math.max(0, current.cacheRead - previous.cacheRead);
		const cachedWriteTokens = Math.max(0, current.cacheWrite - previous.cacheWrite);
		const totalTokens = inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens;

		if (totalTokens === 0) {
			return undefined;
		}

		const usage: Usage = {
			inputTokens,
			outputTokens,
			totalTokens,
		};
		if (cachedReadTokens > 0) {
			usage.cachedReadTokens = cachedReadTokens;
		}
		if (cachedWriteTokens > 0) {
			usage.cachedWriteTokens = cachedWriteTokens;
		}
		return usage;
	}

	async #listStoredSessions(cwd?: string): Promise<StoredSessionInfo[]> {
		const sessions = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
		return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	#parseCursor(cursor: string | undefined): number {
		if (!cursor) {
			return 0;
		}
		const parsed = Number.parseInt(cursor, 10);
		if (!Number.isFinite(parsed) || parsed < 0) {
			throw new Error(`Invalid ACP session cursor: ${cursor}`);
		}
		return parsed;
	}

	/**
	 * Parse a scoped cursor of the form `${generation}:${offset}` and reject it when
	 * its embedded generation no longer matches the current authority generation.
	 * Unlike the cwd-less display cursor, the scoped cursor binds the page offset to
	 * the exact authority snapshot that produced it, so a lifecycle invalidation
	 * between pages is observable instead of silently rebuilt.
	 */
	#parseScopedCursor(cursor: string | undefined, currentGeneration: number): number {
		if (!cursor) {
			return 0;
		}
		const separator = cursor.indexOf(":");
		if (separator <= 0) {
			throw new Error(`Invalid ACP session cursor: ${cursor}`);
		}
		const generation = Number.parseInt(cursor.slice(0, separator), 10);
		const offset = Number.parseInt(cursor.slice(separator + 1), 10);
		if (!Number.isFinite(generation) || generation < 0 || !Number.isFinite(offset) || offset < 0) {
			throw new Error(`Invalid ACP session cursor: ${cursor}`);
		}
		if (generation !== currentGeneration) {
			throw new Error("ACP session list cursor is stale; the scoped session inventory changed");
		}
		return offset;
	}

	async #replaySessionHistory(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		const replayedToolCallIds = new Set<string>();
		const replayedToolCallArgs = new Map<string, unknown>();
		for (const message of record.session.sessionManager.buildSessionContext().messages as ReplayableMessage[]) {
			for (const notification of this.#messageToReplayNotifications(
				record.session.sessionId,
				message,
				cwd,
				replayedToolCallIds,
				replayedToolCallArgs,
			)) {
				await this.#connection.sessionUpdate(notification);
			}
		}
	}

	#messageToReplayNotifications(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		if (message.role === "assistant") {
			return this.#replayAssistantMessage(sessionId, message, cwd, replayedToolCallIds, replayedToolCallArgs);
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "custom" ||
			message.role === "hookMessage"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string"
		) {
			return this.#replayToolResult(
				sessionId,
				cwd,
				{
					...message,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				},
				{
					includeStart: !replayedToolCallIds.has(message.toolCallId),
					toolArgs: replayedToolCallArgs.get(message.toolCallId),
				},
			);
		}
		if (
			message.role === "bashExecution" ||
			message.role === "pythonExecution" ||
			message.role === "compactionSummary"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		return [];
	}

	#replayAssistantMessage(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		const messageId = crypto.randomUUID();
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: item.text },
							messageId,
						},
					});
					continue;
				}
				if (
					item.type === "thinking" &&
					"thinking" in item &&
					typeof item.thinking === "string" &&
					item.thinking.length > 0
				) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: item.thinking },
							messageId,
						},
					});
					continue;
				}
				const toolItem = item as ReplayableToolItem;
				if (
					(toolItem.type === "toolCall" || toolItem.type === "tool_use") &&
					typeof toolItem.id === "string" &&
					typeof toolItem.name === "string"
				) {
					const args = this.#buildReplayAssistantToolArgs(toolItem);
					const update = buildToolCallStartUpdate({
						toolCallId: toolItem.id,
						toolName: toolItem.name,
						args,
						status: "completed",
						cwd,
					});
					notifications.push({ sessionId, update });
					replayedToolCallIds.add(toolItem.id);
					replayedToolCallArgs.set(toolItem.id, args);
				}
			}
		}
		if (notifications.length === 0 && message.errorMessage && !isSilentAbort(message.errorMessage)) {
			notifications.push({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.errorMessage },
					messageId,
				},
			});
		}
		return notifications;
	}

	#buildReplayAssistantToolArgs(item: ReplayableToolItem): unknown {
		if ("arguments" in item) {
			return normalizeReplayToolArguments(item.arguments).args;
		}
		if (item.type === "tool_use" && "input" in item) {
			return item.input;
		}
		return {};
	}

	#replayToolResult(
		sessionId: string,
		cwd: string,
		message: Required<Pick<ReplayableMessage, "toolCallId" | "toolName">> & ReplayableMessage,
		options: { includeStart?: boolean; toolArgs?: unknown } = {},
	): SessionNotification[] {
		const args = this.#buildReplayToolArgs(message.details);
		const startEvent: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			args,
		};
		const endEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError === true,
			result: {
				content: message.content,
				details: message.details,
				errorMessage: message.errorMessage,
			},
		};
		const notifications = mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(endEvent), sessionId, {
			cwd,
			getToolArgs: toolCallId => (toolCallId === message.toolCallId ? options.toolArgs : undefined),
		});
		if (options.includeStart === false) {
			return notifications;
		}
		return [
			...mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(startEvent), sessionId, { cwd }),
			...notifications,
		];
	}

	#buildReplayToolArgs(details: unknown): { path?: string } {
		if (typeof details !== "object" || details === null || !("path" in details)) {
			return {};
		}
		const value = (details as { path?: unknown }).path;
		return typeof value === "string" && value.length > 0 ? { path: value } : {};
	}

	#wrapReplayContent(
		sessionId: string,
		content: PromptRequest["prompt"],
		kind: "agent_message_chunk" | "user_message_chunk",
		messageId: string,
	): SessionNotification[] {
		return content.map(block => ({
			sessionId,
			update: {
				sessionUpdate: kind,
				content: block,
				messageId,
			},
		}));
	}

	#extractReplayContent(content: unknown, errorMessage: string | undefined): PromptRequest["prompt"] {
		const replay: PromptRequest["prompt"] = [];
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					replay.push({ type: "text", text: item.text });
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					"mimeType" in item &&
					typeof item.data === "string" &&
					typeof item.mimeType === "string"
				) {
					replay.push({ type: "image", data: item.data, mimeType: item.mimeType });
				}
			}
		}
		if (replay.length === 0 && errorMessage) {
			replay.push({ type: "text", text: errorMessage });
		}
		return replay;
	}

	async #configureExtensions(record: ManagedSessionRecord): Promise<void> {
		if (record.extensionsConfigured) {
			return;
		}

		const extensionRunner = record.session.extensionRunner;
		if (!extensionRunner) {
			record.extensionsConfigured = true;
			return;
		}

		extensionRunner.initialize(
			{
				sendMessage: (message, options) => {
					record.session.sendCustomMessage(message, options).catch((error: unknown) => {
						logger.warn("ACP extension sendMessage failed", { error });
					});
				},
				sendUserMessage: (content, options) => {
					record.session.sendUserMessage(content, options).catch((error: unknown) => {
						logger.warn("ACP extension sendUserMessage failed", { error });
					});
				},
				appendEntry: (customType, data) => {
					record.session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					record.session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => record.session.getActiveToolNames(),
				getAllTools: () => record.session.getAllToolNames(),
				setActiveTools: toolNames => record.session.setActiveToolsByName(toolNames),
				getCommands: () => getSessionSlashCommands(record.session),
				setModel: async model => {
					const apiKey = await record.session.modelRegistry.getApiKey(model);
					if (!apiKey) {
						return false;
					}
					await record.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => record.session.thinkingLevel,
				setThinkingLevel: level => record.session.setThinkingLevel(level),
				getSessionName: () => record.session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await record.session.sessionManager.setSessionName(name, "user");
				},
			},
			{
				getModel: () => record.session.model,
				isIdle: () => !record.session.isStreaming,
				abort: () => {
					void record.session.abort();
				},
				hasPendingMessages: () => record.session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => record.session.getContextUsage(),
				getSystemPrompt: () => record.session.systemPrompt,
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			{
				getContextUsage: () => record.session.getContextUsage(),
				waitForIdle: () => record.session.agent.waitForIdle(),
				newSession: async options => {
					const success = await record.session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(record.session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await record.session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await record.session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await record.session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await record.session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			// Per-session getter: `record.session.sessionId` reads through to
			// `sessionManager.getSessionId()` (it's a getter, not a field), so an
			// extension command that calls `ctx.newSession` / `ctx.switchSession`
			// — both exposed in the block just above — mutates the underlying id
			// mid-flight. Reading lazily on each elicitation matches every other
			// `sessionUpdate` call in this file. Hoisting the factory to an
			// `AcpAgent` field would still be wrong because it would also lose
			// the per-`record` binding.
			createAcpExtensionUiContext(this.#connection, () => record.session.sessionId, this.#clientCapabilities),
		);
		await extensionRunner.emit({ type: "session_start" });
		record.extensionsConfigured = true;
	}

	async #configureMcpServers(record: ManagedSessionRecord, servers: McpServer[]): Promise<void> {
		if (record.mcpManager) {
			await record.mcpManager.disconnectAll();
		}
		if (servers.length === 0) {
			record.mcpManager = undefined;
			await record.session.refreshMCPTools([]);
			return;
		}

		const manager = new MCPManager(record.session.sessionManager.getCwd());
		const configs: MCPConfigMap = {};
		const sources: MCPSourceMap = {};
		for (const server of servers) {
			configs[server.name] = this.#toMcpConfig(server);
			sources[server.name] = {
				provider: "acp",
				providerName: "ACP Client",
				path: `acp://${server.name}`,
				level: "project",
			};
		}

		const result = await manager.connectServers(configs, sources);
		if (result.errors.size > 0) {
			throw new Error(
				Array.from(result.errors.entries())
					.map(([name, message]) => `${name}: ${message}`)
					.join("; "),
			);
		}

		record.mcpManager = manager;
		await record.session.refreshMCPTools(result.tools);
	}

	#toMcpConfig(server: McpServer): MCPServerConfig {
		if ("command" in server) {
			return {
				type: "stdio",
				command: server.command,
				args: server.args,
				env: this.#toNameValueMap(server.env),
			};
		}
		if (server.type === "http") {
			return {
				type: "http",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		if (server.type === "sse") {
			return {
				type: "sse",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		throw new Error(`Unsupported ACP MCP transport: ${server.type}`);
	}

	#toNameValueMap(values: Array<{ name: string; value: string }>): { [name: string]: string } {
		const mapped: { [name: string]: string } = {};
		for (const value of values) {
			mapped[value.name] = value.value;
		}
		return mapped;
	}

	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		this.#sessions.delete(sessionId);
		await this.#cancelPromptForClose(record);
		await this.#disposeSessionRecord(record);
	}

	async #cancelPromptForClose(record: ManagedSessionRecord): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!isPromptTurnInFlight(promptTurn)) {
			return;
		}
		const cleanup = promptTurn.cleanup ?? this.#beginCancelCleanup(record, promptTurn);
		try {
			await cleanup;
		} catch (error) {
			logger.warn("Failed to abort ACP prompt during session close", { error });
		}
	}
	/**
	 * Delete-specific strict prompt quiescence barrier. Mirrors the cancel setup of
	 * {@link #cancelPromptForClose} but NEVER swallows abort/timeout failures, then
	 * waits for full idle + async-delivery drain. A quiescence failure blocks the
	 * destructive mutation that follows — it is not catch-and-logged. The best-effort
	 * close path is preserved separately for nondestructive shutdown.
	 */
	async #quiesceForDelete(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		const promptTurn = record.promptTurn;
		if (isPromptTurnInFlight(promptTurn)) {
			const cleanup = promptTurn.cleanup ?? this.#beginCancelCleanup(record, promptTurn);
			await cleanup;
		}
		await this.#waitForAcpPromptIdle(record);
		// Explicit post-drain status check: the drain loop's boolean return is
		// not trusted as proof. Treat a drain false/timeout/no-progress/max-pass
		// as unproven and verify the owner-scoped delivery state directly. Any
		// remaining queued/delivering work blocks the destructive mutation.
		const delivery = record.session.getAsyncDeliveryStateForAcp();
		if (delivery.queued > 0 || delivery.delivering) {
			throw new Error(`ACP session ${sessionId} cannot be deleted: async delivery is not quiesced`);
		}
	}

	/**
	 * Record phase-aware same-connection retry evidence for an incomplete verified
	 * delete. The transcript identity (carried by every cleanup_pending) is always
	 * recorded so a retry can reject a replaced transcript; the artifacts identity
	 * is recorded only at the artifacts phase.
	 */
	#recordPendingDeleteEvidence(sessionId: string, result: VerifiedSessionDeleteResult): void {
		if (result.kind !== "cleanup_pending") {
			return;
		}
		if (result.phase === "artifacts") {
			this.#pendingDeleteEvidence.set(sessionId, {
				transcriptIdentity: result.transcriptIdentity,
				artifactsIdentity: result.artifactsIdentity,
			});
		} else {
			// Transcript phase: artifacts were already removed successfully, so only
			// the transcript identity remains for retry binding.
			this.#pendingDeleteEvidence.set(sessionId, {
				transcriptIdentity: result.transcriptIdentity,
			});
		}
	}

	/** Build the optional `expectedArtifactsIdentity` field for a retry target. */
	#pendingArtifactsIdentity(sessionId: string): { expectedArtifactsIdentity?: SessionStorageFileIdentity } {
		const pending = this.#pendingDeleteEvidence.get(sessionId);
		return pending?.artifactsIdentity ? { expectedArtifactsIdentity: pending.artifactsIdentity } : {};
	}

	/**
	 * Phase-aware retry gate: a preserved transcript identity must match the fresh
	 * candidate's transcript identity before that candidate can authorize a
	 * replacement. A mismatch (the transcript was externally replaced between the
	 * cleanup_pending failure and the retry) fails closed — it never authorizes a
	 * wrong mutation.
	 */
	#assertPendingTranscriptIdentity(sessionId: string, candidateIdentity: { dev: bigint; ino: bigint }): void {
		const pending = this.#pendingDeleteEvidence.get(sessionId);
		if (
			pending &&
			(pending.transcriptIdentity.dev !== candidateIdentity.dev ||
				pending.transcriptIdentity.ino !== candidateIdentity.ino)
		) {
			throw new Error(
				`ACP session ${sessionId} transcript identity changed since pending cleanup; replacement rejected`,
			);
		}
	}

	async #disposeSessionRecord(record: ManagedSessionRecord): Promise<void> {
		record.lifetimeUnsubscribe?.();
		if (record.mcpManager) {
			try {
				await record.mcpManager.disconnectAll();
			} catch (error) {
				logger.warn("Failed to disconnect ACP MCP servers", { error });
			}
			record.mcpManager = undefined;
		}
		try {
			await record.session.dispose();
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeStandaloneSession(session: AgentSession): Promise<void> {
		try {
			await session.dispose();
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeAllSessions(): Promise<void> {
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}

		this.#disposePromise = (async () => {
			const records = Array.from(this.#sessions.entries());
			this.#sessions.clear();
			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						await this.#cancelPromptForClose(record);
						await this.#disposeSessionRecord(record);
					} catch (error) {
						logger.warn("Failed to clean up ACP session", { sessionId, error });
					}
				}),
			);

			const initialSession = this.#initialSession;
			this.#initialSession = undefined;
			if (initialSession) {
				await this.#disposeStandaloneSession(initialSession);
			}
		})();

		await this.#disposePromise;
	}
}
