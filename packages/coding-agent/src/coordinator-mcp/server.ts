import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isKnownSinkPeerClosedError, logger } from "@gajae-code/utils";
import { normalizePathForComparison, VERSION } from "@gajae-code/utils/dirs";
import { withFileLock } from "../config/file-lock";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
	type CoordinatorToolName,
} from "../coordinator/contract";
import {
	SessionStateLockUnavailableError,
	tryWithSessionStateFileLock,
	withSessionStateFileLock,
} from "../gjc-runtime/session-state-lock";
import {
	canonicalCoordinatorSidecarPayload,
	classifyRuntimeToolActivity,
	publicRuntimeToolActivity,
	terminallySettledRuntimeToolActivity,
} from "../gjc-runtime/session-state-sidecar";
import { listMcpDelegateHostContexts } from "../hooks/mcp-delegate-host-context";
import type { WorkflowGate, WorkflowGateQueryRecord } from "../modes/shared/agent-wire/workflow-gate-types";
import type { BrokerDiscovery } from "../sdk/broker/discovery";
import { type EnsureBrokerSettings, ensureBroker } from "../sdk/broker/ensure";
import { lifecycleRequestTimeoutMs } from "../sdk/broker/startup-budget";
import { UnsupportedStateVersionError } from "../sdk/broker/state-version";
import { SdkClient, SdkClientError } from "../sdk/client/client";
import { readSdkBrokerDiscovery } from "../sdk/client/discovery";
import { reduceTerminalReceiptState } from "../sdk/receipt-state";
import { type SessionAttachment, SessionRouter, type SessionRouterDeps, SessionRouterError } from "../sdk/router";
import {
	type ActivatedPreparedSession,
	requestPreparedSessionActivation,
	SessionActivationError,
} from "../sdk/session-activation";
import { SessionListTraversalError, sessionListPageFromResponse, traverseSessionList } from "../sdk/session-list";
import {
	ackCodexWakeEvent,
	bindDelegateCodexHandoff,
	type CodexHandoffRegistrationV1,
	type CodexWakeEventV1,
	codexWakeLifecycle,
	isCodexWakeEventKind,
	listCodexHandoffs,
	listCodexWakeEvents,
	listPendingCodexWakeEvents,
	readCodexHandoff,
	recordCodexWakeEvent,
	registerCodexHandoff,
	updateCodexWakeEvent,
} from "./codex-handoff";
import {
	type CodexTransportFactory,
	createDefaultCodexTransportFactory,
	publishCodexWake,
} from "./codex-wake-publisher";
import {
	appendCoordinatorFile,
	ensureCoordinatorDirectory,
	syncCoordinatorDirectory,
	writeCoordinatorAtomic,
} from "./durability";
import {
	createDefaultEventWebhookDelivery,
	deliverEventWebhook,
	type EventWebhookConfig,
	parseEventWebhookConfig,
	type WebhookDelivery,
} from "./event-webhook";
import {
	type CoordinatorModelProfileLoader,
	createCoordinatorModelProfileLoader,
	resolveCoordinatorMpreset,
} from "./model-preset";
import {
	assertCoordinatorArtifactPath,
	assertCoordinatorSessionLocations,
	assertCoordinatorWorkdir,
	buildCoordinatorMcpConfig,
	type CoordinatorMcpConfig,
	coordinatorArtifactCapability,
	coordinatorNamespacePath,
	requireCoordinatorMutation,
	safeOpenCoordinatorArtifact,
} from "./policy";
import { listCoordinatorJsonFilesWithRetry } from "./projection-scan";
import {
	answerBindingMatches,
	buildCoordinatorAskAnswerSchema,
	type CoordinatorQuestionDiagnosticPublicV1,
	type CoordinatorQuestionPublicV1,
	createAnswerBinding,
	decodeAskGateV1,
	type ListQuestionsSuccessV1,
	type PublicReason,
	projectAskGateQuestion,
	translateCoordinatorAskAnswer,
	validateCoordinatorAskAnswer,
} from "./question-gate-codec";
import {
	acknowledgePublicDelivery,
	admitSessionClose,
	advanceCreationReceipt,
	advanceDeletion,
	advanceDeliveryDiscoveryCursor,
	advanceSchedulerCursor,
	assertCreationRetirementIdentity,
	bindCreationRequest,
	type CanonicalCreateIntentV1,
	type CanonicalReportSnapshotV1,
	type CanonicalSessionSnapshotV1,
	COORDINATOR_REPORT_ID_PATTERN,
	COORDINATOR_SESSION_ID_PATTERN,
	type CoordinatorSessionTransactionV1,
	type CreationRetirementBrokerProofV1,
	type CreationRetirementProofV1,
	claimCreationRequest,
	claimPublicDelivery,
	commitCreationWal,
	coordinatorStatePaths,
	createSessionTransaction,
	deterministicOutboxId,
	ensureSchedulerRoster,
	enumeratePublicDeliveries,
	initializeCoordinatorNamespace,
	type LegacyProjectionImportV1,
	listCanonicalActiveSessions,
	type NamespaceDeletionEntryV1,
	type OperationRequestV1,
	type PublicDeliveryClaimV1,
	type RuntimeProvenanceTokenV1,
	readDeliveryDiscoveryCursor,
	readSchedulerRoster,
	readSessionTransaction,
	reconcileCreationRemoteVerifier,
	recordCreationRetirementBrokerProof,
	recordCreationRetirementIntent,
	recoverExpiredPublicDelivery,
	releasePublicDeliveryClaim,
	removeSessionTransaction,
	repairProjections,
	replaceCreationRetirementIntent,
	rotateClaimedCreationVerifier,
	startCreationRemote,
	withAdmittedSessionTransaction,
	withNamespaceRegistry,
	withSessionTransaction,
} from "./question-state";
import { createSessionReaper, type ReapableSession, type SessionReaper } from "./session-reaper";

export type { CoordinatorToolName };
export { COORDINATOR_MCP_PROTOCOL_VERSION, COORDINATOR_MCP_SERVER_NAME, COORDINATOR_MCP_TOOL_NAMES };

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

type JsonRpcResult = any;

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: JsonRpcResult;
	error?: { code: number; message: string; data?: unknown };
}

export interface CoordinatorMcpServer {
	config: CoordinatorMcpConfig;
	callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
	handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse>;
	handle(request: JsonRpcRequest): Promise<JsonRpcResponse>;
	reapSession(
		rawId: unknown,
		opts?: { force?: boolean; reason?: string },
	): Promise<{ ok: boolean; reason?: string; closed: boolean; active_turn_id?: string; detail?: string }>;
	signRuntimeSidecarPayloadForTest(
		sessionId: string,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	mintSidecarSigningAuthorityForTest(): { key_id: string; public_key: string };
	sessionReaper: SessionReaper;
	router: SessionRouter;
	close(): Promise<void>;
}

function sinkErrorCode(error: unknown): string | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
	try {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}

type CoordinatorBrokerStage = "ensure" | "read" | "connect" | "request" | "close";

function toCoordinatorBrokerError(stage: CoordinatorBrokerStage, error: unknown): SdkClientError {
	if (stage === "request" && error instanceof SdkClientError) return error;
	if (stage === "ensure") {
		if (error instanceof AggregateError)
			return new SdkClientError(
				"broker_cleanup_unverified",
				"SDK broker bootstrap failed and cleanup was not verified.",
			);
		if (error instanceof UnsupportedStateVersionError)
			return new SdkClientError(
				"broker_discovery_unsupported",
				"SDK broker discovery state version is unsupported.",
			);
		if (sinkErrorCode(error) === "EACCES" || sinkErrorCode(error) === "EPERM")
			return new SdkClientError("broker_discovery_access_denied", "SDK broker discovery cannot be accessed.");
		return new SdkClientError("broker_bootstrap_failed", "SDK broker bootstrap failed.");
	}
	if (stage === "read") {
		if (error instanceof UnsupportedStateVersionError)
			return new SdkClientError(
				"broker_discovery_unsupported",
				"SDK broker discovery state version is unsupported.",
			);
		if (sinkErrorCode(error) === "EACCES" || sinkErrorCode(error) === "EPERM")
			return new SdkClientError("broker_discovery_access_denied", "SDK broker discovery cannot be accessed.");
		return new SdkClientError("broker_discovery_unavailable", "SDK broker discovery cannot be read.");
	}
	return new SdkClientError(
		stage === "request" ? "broker_request_unavailable" : "broker_transport_unavailable",
		stage === "request" ? "SDK broker request is unavailable." : "SDK broker transport is unavailable.",
	);
}
interface CoordinatorFinalResponse {
	text: string | null;
	format: "markdown";
	source: string | null;
	artifact_path: string | null;
	truncated: boolean;
}

function reportableFinalResponse(response: CoordinatorFinalResponse | undefined): boolean {
	return Boolean(
		response &&
			((typeof response.text === "string" && response.text.trim().length > 0) ||
				(typeof response.artifact_path === "string" && response.artifact_path.trim().length > 0)),
	);
}

interface RuntimeSessionStatePayload extends CoordinatorSessionState {
	final_response?: CoordinatorFinalResponse;
	error?: { code: string; message: string; recoverable: boolean } | null;
}

function isStrictRuntimeFinalResponse(value: unknown): value is CoordinatorFinalResponse {
	const response = asRecord(value);
	return Boolean(
		response &&
			(response.text === null || typeof response.text === "string") &&
			response.format === "markdown" &&
			(response.source === null || typeof response.source === "string") &&
			(response.artifact_path === null || typeof response.artifact_path === "string") &&
			typeof response.truncated === "boolean",
	);
}

function hasExactRuntimeWriterIdentity(
	state: CoordinatorSessionState | null | undefined,
	broker: { sidecar_verifier: { key_id: string; public_key: string } },
): boolean {
	if (!state || state.sidecar_key_id !== broker.sidecar_verifier.key_id || typeof state.sidecar_signature !== "string")
		return false;
	const { sidecar_signature: _signature, ...unsigned } = state;
	try {
		return verify(
			null,
			Buffer.from(canonicalCoordinatorSidecarPayload(unsigned)),
			{ key: Buffer.from(broker.sidecar_verifier.public_key, "base64"), format: "der", type: "spki" },
			Buffer.from(state.sidecar_signature, "base64"),
		);
	} catch {
		return false;
	}
}

function isStrictTerminalRuntimeState(
	state: CoordinatorSessionState | null | undefined,
): state is RuntimeSessionStatePayload {
	if (!state || (state.state !== "completed" && state.state !== "errored")) return false;
	const runtime = state as RuntimeSessionStatePayload;
	return runtime.final_response === undefined || isStrictRuntimeFinalResponse(runtime.final_response);
}

interface CoordinatorServices {
	connectBroker?: (url: string, token: string) => Promise<SdkClient>;
	routerDeps?: SessionRouterDeps;
	ensureBroker?: (settings: EnsureBrokerSettings) => Promise<BrokerDiscovery>;
	readSdkBrokerDiscovery?: (agentDir: string) => Promise<BrokerDiscovery | null>;
	getAgentDir?: () => string;
	resolveModelProfiles?: CoordinatorModelProfileLoader;
	resolveModelPin?: (raw: unknown, cwd?: string) => Promise<CoordinatorModelResolution>;
	canonicalizePath?: (value: string) => Promise<string>;
	codexTransportFactory?: CodexTransportFactory;
	eventWebhookDelivery?: WebhookDelivery;
	/** Test barrier invoked after an accepted prompt receipt is durable and before turn finalization. */
	afterPromptReceiptPersisted?: (sessionId: string) => void | Promise<void>;
	/** Test barrier invoked after an answer dispatch is claimed and before its final admission check. */
	afterAnswerRemoteStarted?: (sessionId: string) => void | Promise<void>;
	/** Test barrier invoked after accepted canonical finalization and before projection. */
	afterCanonicalTurnCommit?: (sessionId: string) => void | Promise<void>;
	/** Test barrier invoked after a canonical report commit and before projection repair. */
	afterCanonicalReportCommit?: (sessionId: string) => void | Promise<void>;
	/** Test barrier invoked after a canonical report safe response is durable and before outer idempotency completion. */
	afterCanonicalReportSafeResponse?: (sessionId: string, response: Record<string, unknown>) => void | Promise<void>;
	/** Test barriers around delegate admission and outer response durability. */
	afterDelegateAdmission?: (sessionId: string) => void | Promise<void>;
	afterDelegateCreationWalCommitted?: (sessionId: string) => void | Promise<void>;
	afterDelegateCreationCompleted?: () => void | Promise<void>;
	beforeDelegateResponseCommit?: () => void | Promise<void>;
	afterDelegateResponseCommit?: () => void | Promise<void>;
	readCoordinatorSessionEntries?: (directory: string) => Promise<string[]>;
}

type CoordinatorModelResolution =
	| { ok: true; model: string | null }
	| { ok: false; reason: "unknown_model"; model: string; error: string };

interface CoordinatorMcpServerOptions {
	env?: NodeJS.ProcessEnv;
	services?: CoordinatorServices;
	platform?: NodeJS.Platform;
}

interface LegacyHandlerOptions {
	env?: NodeJS.ProcessEnv;
}

type TurnStatus =
	| "queued"
	| "delivering"
	| "active"
	| "waiting_for_answer"
	| "completing"
	| "completed"
	| "failed"
	| "cancelled"
	| "superseded";

interface TurnRecord {
	schema_version: 1;
	turn_id: string;
	session_id: string;
	namespace: { profile: string | null; repo: string | null };
	status: TurnStatus;
	prompt: { text: string; created_at: string; source: "mcp" | "question_answer" };
	delivery: {
		delivered: boolean;
		queued: boolean;
		target: string | null;
		tmux_keys_sent?: boolean;
		prompt_acknowledged?: boolean;
		runtime_command_id?: string;
		runtime_turn_id?: string;
		state?: "queued" | "tmux_keys_sent" | "acknowledged" | "unavailable" | "unacknowledged";
		attempts: Array<{
			delivered: boolean;
			created_at: string;
			reason: string | null;
			channel?: "tmux_keys" | "runtime_ack";
			tmux_keys_sent?: boolean;
		}>;
	};
	runtime_provenance?: RuntimeProvenanceTokenV1 | null;
	question_ids: string[];
	final_response: {
		text: string | null;
		format: "markdown";
		source: string | null;
		artifact_path: string | null;
		truncated: boolean;
	};
	evidence: Array<Record<string, unknown>>;
	error: { code: string; message: string; recoverable: boolean } | null;
	liveness: { checked_at: string | null; live: boolean | null; reason: string | null };
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
}

type CoordinatorSessionStateValue =
	| "booting"
	/** Live and endpoint-addressable, but withholding readiness until activation. */
	| "prepared"
	| "ready_for_input"
	| "running"
	| "needs_user_input"
	| "completed"
	| "errored"
	| "stale"
	| "unknown";

interface CoordinatorSessionState {
	schema_version: 1;
	session_id: string;
	state: CoordinatorSessionStateValue;
	ready_for_input: boolean;
	current_turn_id: string | null;
	last_turn_id: string | null;
	updated_at: string;
	ended_at?: string;
	source: "coordinator" | "agent_session_event";
	live: boolean | null;
	reason: string | null;
	/** Coordinator verifier id and detached Ed25519 signature over this payload. */
	sidecar_key_id?: string;
	sidecar_signature?: string;
	/**
	 * Tool-activity snapshot owned by the runtime sidecar; never lifecycle state. It is
	 * carried opaquely because only the sidecar's validator decides what is publishable.
	 */
	activity?: unknown;
}

type CoordinatorEventKind =
	| "session.registered"
	| "session.started"
	| "session.reaped"
	| "session.state_changed"
	| "turn.queued"
	| "turn.delivering"
	| "turn.active"
	| "turn.acknowledged"
	| "turn.waiting_for_answer"
	| "turn.completed"
	| "turn.failed"
	| "turn.cancelled"
	| "turn.superseded"
	| "question.opened"
	| "question.answered"
	| "report.written"
	| "tmux.delivery_succeeded"
	| "tmux.delivery_failed"
	| "delegation.started";

const COORDINATOR_EVENT_KINDS: ReadonlySet<string> = new Set<CoordinatorEventKind>([
	"session.registered",
	"session.started",
	"session.reaped",
	"session.state_changed",
	"turn.queued",
	"turn.delivering",
	"turn.active",
	"turn.acknowledged",
	"turn.waiting_for_answer",
	"turn.completed",
	"turn.failed",
	"turn.cancelled",
	"turn.superseded",
	"question.opened",
	"question.answered",
	"report.written",
	"tmux.delivery_succeeded",
	"tmux.delivery_failed",
	"delegation.started",
]);

interface CoordinatorEvent {
	schema_version: 1;
	seq: number;
	id: string;
	timestamp: string;
	kind: CoordinatorEventKind;
	session_id?: string;
	turn_id?: string;
	question_id?: string;
	report_id?: string;
	summary: string;
	payload_ref?: string;
	metadata?: Record<string, unknown>;
}

interface CoordinatorEventInput {
	kind: CoordinatorEventKind;
	sessionId?: string | null;
	turnId?: string | null;
	questionId?: string | null;
	reportId?: string | null;
	summary: string;
	payloadRef?: string | null;
	metadata?: Record<string, unknown>;
}

const UNOBSERVED_COMPENSATION_CODE = "broker_compensation_unobserved";
const OBSERVED_BROKER_FAILURE_CODES = new Set([
	"worktree_preparation_timeout",
	"dependency_preparation_timeout",
	"readiness_timeout",
	"spawn_failed",
	"worktree_in_use",
	"startup_admission_timeout",
	"startup_admission_refused",
	"incarnation_unavailable",
	"invalid_input",
	"broker_request_unavailable",
]);

const MISSING_FINAL_RESPONSE_ADVISORY = "completion_missing_final_response";
const PROMPT_ACK_TIMEOUT_REASON = "runtime_prompt_ack_timeout";
const DEFAULT_RUNTIME_PROMPT_ACK_TIMEOUT_MS = 10_000;
/**
 * Pagination window for `readCompleteQ12Snapshot`: it stops starting pages once
 * this much time has passed and gives each page only the remainder as its reply
 * budget. It bounds pagination, not the whole call — attachment resolution runs
 * before the window opens, and a page's budget is a post-connect reply deadline,
 * so transport reconnect time sits outside it.
 */
const Q12_SNAPSHOT_BUDGET_MS = 5_000;
const MAX_RUNTIME_SESSIONS_PER_WATCH_PASS = 4;
const MAX_Q12_ATTEMPTS_PER_WATCH_PASS = 2;
const MAX_RUNTIME_PROMPT_ACK_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVE_TURN_STATUSES = new Set<TurnStatus>(["delivering", "active", "waiting_for_answer", "completing"]);
const TERMINAL_TURN_STATUSES = new Set<TurnStatus>(["completed", "failed", "cancelled", "superseded"]);
const TURN_ID_PATTERN = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_EXTERNAL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function textResult(
	payload: unknown,
	isError = false,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	return {
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
		isError,
	};
}

function toolSchema(name: CoordinatorToolName): {
	name: CoordinatorToolName;
	description: string;
	inputSchema: Record<string, unknown>;
} {
	const allowMutation = { type: "boolean", description: "Required and must be true for mutating tools." };
	const cwd = {
		type: "string",
		description: "Canonicalized GJC worktree or project directory inside configured roots.",
	};
	const sessionId = { type: "string", description: "GJC coordinator bridge session id." };
	const pathField = { type: "string", description: "Artifact path inside configured safe roots." };
	const mpreset = {
		type: "string",
		description:
			"Optional GJC model profile (`gjc --mpreset <profile>`). Unknown names are rejected with the available-profile listing.",
	};
	const modelPin = {
		type: "string",
		description:
			"Optional explicit model pin (`gjc --model <provider/model>`, e.g. cursor/claude-fable-5-xhigh). Unknown ids are rejected with the same not-found error as the CLI; when both model and mpreset are given, the explicit model wins exactly like `gjc --mpreset <p> --model <m>`.",
	};

	const worktree = {
		type: "string",
		description:
			"Name this session's git worktree and branch instead of the configured default, so concurrent sessions in one repository get isolated checkouts. Requires GJC_COORDINATOR_MCP_SESSION_COMMAND to select worktree mode. Without it every session in a repository shares one worktree derived from the repository's current branch.",
	};
	const common = { type: "object", properties: {} as Record<string, unknown> };
	const idempotencyKey = {
		type: "string",
		description: "Caller-provided idempotency key for durable coordinator mutation replay.",
	};

	if (name === "gjc_coordinator_register_session") {
		return {
			name,
			description:
				"Re-register a broker-indexed GJC session with an established sidecar authority; use start_session for a new runtime. Tmux identifiers are advisory process metadata only.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					cwd,
					tmux_session: { type: "string" },
					tmux_target: { type: "string" },
					visible: { type: "boolean" },
					warp_attached: { type: "boolean" },
					source: { type: "string" },
					model: { type: "string" },
					allow_mutation: allowMutation,
					idempotency_key: idempotencyKey,
				},
				required: ["session_id", "cwd", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_start_session") {
		return {
			name,
			description:
				"Start a broker-managed GJC session through canonical SDK lifecycle control. Set prepare_existing_thread to hold the session at prepared (endpoint-addressable, readiness withheld) so an existing chat thread can be bound before activation.",
			inputSchema: {
				type: "object",
				properties: {
					cwd,
					prompt: { type: "string" },
					prepare_existing_thread: {
						type: "boolean",
						description:
							"Create the session prepared instead of ready: no readiness is published and no initial prompt is accepted until gjc_coordinator_activate_session proves activation.",
					},
					mpreset,
					model: modelPin,
					worktree,
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: ["cwd", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_retire_start_session") {
		return {
			name,
			description:
				"Retire a stranded start_session idempotency intent only after the exact indexed terminal-uncertain session identity has been proven exited and its endpoint is absent. This never signals or deletes a live process.",
			inputSchema: {
				type: "object",
				properties: {
					cwd,
					session_id: sessionId,
					state_root: { type: "string", description: "Exact indexed SDK state root." },
					endpoint_generation: { type: "number" },
					endpoint_mtime_ms: { type: "number" },
					process_incarnation: { type: "string" },
					host_incarnation: { type: "string" },
					lifecycle_request_id: { type: "string" },
					remote_create_key: { type: "string" },
					creation_idempotency_key: { type: "string" },
					request_digest: { type: "string", description: "SHA-256 of the original canonical start request." },
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: [
					"cwd",
					"session_id",
					"state_root",
					"endpoint_generation",
					"endpoint_mtime_ms",
					"process_incarnation",
					"host_incarnation",
					"lifecycle_request_id",
					"remote_create_key",
					"creation_idempotency_key",
					"request_digest",
					"idempotency_key",
					"allow_mutation",
				],
			},
		};
	}
	if (name === "gjc_coordinator_activate_session") {
		return {
			name,
			description:
				"Activate a prepared session so it publishes the readiness it withheld. Requires the session's own proof at the exact endpoint generation, so it fails closed while no existing-thread binding has been applied.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: ["session_id", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_stop_session") {
		return {
			name,
			description:
				"Close and reap a coordinator delegate-created (ephemeral) SDK session through broker lifecycle control. Non-ephemeral user-registered sessions require both force and the force-stop capability.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					force: {
						type: "boolean",
						description: "Close a non-ephemeral session; requires the GJC_COORDINATOR_MCP_FORCE_STOP capability.",
					},
					reason: { type: "string", description: "Optional audit reason recorded on the session.reaped event." },
					allow_mutation: allowMutation,
				},
				required: ["session_id", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_send_prompt") {
		return {
			name,
			description:
				"Create a durable turn and deliver a bounded follow-up prompt for a selected coordinator bridge session.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					prompt: { type: "string" },
					queue: { type: "boolean" },
					force: { type: "boolean" },
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: ["session_id", "prompt", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_read_turn") {
		return {
			name,
			description: "Read authoritative durable turn state without terminal-pane inspection.",
			inputSchema: {
				type: "object",
				properties: { session_id: sessionId, turn_id: { type: "string" } },
				required: ["turn_id"],
			},
		};
	}
	if (name === "gjc_coordinator_await_turn") {
		return {
			name,
			description: "Poll a durable turn for a bounded time and return the same shape as read_turn.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					turn_id: { type: "string" },
					timeout_ms: {
						type: "number",
						description: "Bounded await timeout in milliseconds, capped at 30 minutes.",
					},
					poll_interval_ms: {
						type: "number",
						description: "Bounded polling interval in milliseconds, capped at 10 seconds.",
					},
				},
				required: ["turn_id"],
			},
		};
	}
	if (name === "gjc_coordinator_submit_question_answer") {
		return {
			name,
			description: "Submit a bounded structured answer by question id.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					turn_id: { type: "string" },
					question_id: { type: "string" },
					answer_binding: { type: "string" },
					answer: buildCoordinatorAskAnswerSchema(),
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: [
					"session_id",
					"turn_id",
					"question_id",
					"answer_binding",
					"answer",
					"idempotency_key",
					"allow_mutation",
				],
			},
		};
	}
	if (name === "gjc_coordinator_report_status") {
		return {
			name,
			description: "Write a bounded coordinator coordination status report.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					turn_id: { type: "string" },
					status: { type: "string" },
					summary: { type: "string" },
					blocker: { type: "string" },
					pr_url: { type: "string" },
					evidence_paths: { type: "array", items: { type: "string" } },
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: ["status", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_read_artifact") {
		return {
			name,
			description: coordinatorArtifactCapability().available
				? "Read one bounded artifact from configured safe roots."
				: "Unavailable on this platform: artifact reads require Linux identity-bound handle authorization.",
			inputSchema: { type: "object", properties: { path: pathField }, required: ["path"] },
		};
	}
	if (name === "gjc_coordinator_read_status") {
		return {
			name,
			description: "Read selected broker-indexed GJC session status from SDK discovery.",
			inputSchema: { type: "object", properties: { session_id: sessionId } },
		};
	}
	if (name === "gjc_coordinator_read_tail") {
		return {
			name,
			description: "Read bounded last-assistant output through the session SDK, never terminal scrollback.",
			inputSchema: { type: "object", properties: { session_id: sessionId, lines: { type: "number" } } },
		};
	}
	if (name === "gjc_coordinator_list_questions") {
		return {
			name,
			description: "List bounded structured questions for coordinator coordination.",
			inputSchema: {
				type: "object",
				properties: { session_id: sessionId, turn_id: { type: "string" }, status: { type: "string" } },

				required: ["session_id"],
			},
		};
	}
	if (name === "gjc_coordinator_list_artifacts") {
		return { name, description: "List known safe artifact roots for coordinator coordination.", inputSchema: common };
	}
	if (name === "gjc_coordinator_read_coordination_status") {
		return {
			name,
			description:
				"Read coordinator coordination status. Omit session_id for an all-session namespace snapshot, or provide it to scope sessions, turns, questions, reports, and event summaries.",
			inputSchema: {
				type: "object",
				properties: { session_id: sessionId },
			},
		};
	}
	if (name === "gjc_coordinator_watch_events") {
		return {
			name,
			description: "Long-poll the durable coordinator event journal for new bounded event records.",
			inputSchema: {
				type: "object",
				properties: {
					after_seq: { type: "integer", minimum: 0 },
					session_id: sessionId,
					event_types: { type: "array", items: { type: "string", enum: [...COORDINATOR_EVENT_KINDS] } },
					timeout_ms: {
						type: "number",
						description: "Bounded event long-poll timeout in milliseconds, capped at 30 seconds.",
					},
					limit: { type: "number" },
				},
			},
		};
	}
	if (name === "gjc_coordinator_register_codex_handoff") {
		return {
			name,
			description: "Register a Codex app-server resume handoff using only unix or loopback TCP endpoints.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					thread_id: { type: "string" },
					endpoint: {
						type: "object",
						description: "Codex app-server unix socket path or loopback TCP endpoint only.",
					},
					token_file: {
						type: "string",
						description:
							"Token file under the configured Codex token root only; it must be an owner-only regular file of 1–4096 bytes with no CR or LF. Raw tokens are rejected and never persisted.",
					},
					allow_mutation: allowMutation,
					idempotency_key: idempotencyKey,
				},
				required: ["session_id", "thread_id", "endpoint", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_read_codex_handoff") {
		return {
			name,
			description: "Read a Codex app-server resume handoff and durable wake events.",
			inputSchema: { type: "object", properties: { session_id: sessionId }, required: ["session_id"] },
		};
	}
	if (name === "gjc_coordinator_ack_codex_handoff") {
		return {
			name,
			description: "Acknowledge a durable Codex app-server resume wake event.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					wake_key: { type: "string" },
					allow_mutation: allowMutation,
					idempotency_key: idempotencyKey,
				},
				required: ["session_id", "wake_key", "idempotency_key", "allow_mutation"],
			},
		};
	}
	const delegateWorkflow = workflowForDelegateTool(name);
	if (delegateWorkflow) {
		return {
			name,
			description: delegateToolDescription(delegateWorkflow),
			inputSchema: {
				type: "object",
				properties: {
					cwd,
					task: {
						type: "string",
						description: "Delegated task or objective to run through the selected GJC workflow.",
					},
					prompt: { type: "string", description: "Alias for task; accepted when task is absent." },
					allow_mutation: allowMutation,
					idempotency_key: idempotencyKey,
					session_id: {
						type: "string",
						description:
							"Optional existing GJC coordinator bridge session id to reuse; omitted starts a fresh session.",
					},
					codex_host_session_id: {
						type: "string",
						description:
							"Optional Codex resume-bridge correlation: the session_id previously passed to gjc_coordinator_register_codex_handoff. When set, the new delegate session auto-binds to that registration's Codex thread; ambient host-context inference is skipped.",
					},
					queue: {
						type: "boolean",
						description: "When reusing a session with an active turn, queue instead of failing.",
					},
					force: {
						type: "boolean",
						description: "When reusing a session with an active turn, supersede it before sending.",
					},
					mpreset,
					model: modelPin,
					worktree,
					await_completion: {
						type: "boolean",
						description:
							"Defaults to false: return after durable admission without completion observation. If true, observe until terminal, waiting_for_answer, or timeout. Once a complete response is committed, an identical admitted retry replays it instead of observing again.",
					},
					timeout_ms: {
						type: "number",
						description:
							"Bounded await timeout in milliseconds, capped at 30 minutes like gjc_coordinator_await_turn.",
					},
					poll_interval_ms: { type: "number", description: "Bounded await polling interval." },
				},
				required: ["cwd", "idempotency_key", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_list_sessions") {
		return {
			name,
			description:
				"Enumerate GJC sessions discovered on the broker under the allowed roots. Each entry reports " +
				"`registered`: only sessions with `registered: true` can be used with the other coordinator " +
				"tools. Calling read_status, read_tail, or send_prompt on an entry with `registered: false` " +
				"returns not_found, and stop_session reports unknown_session; register it with " +
				"gjc_coordinator_register_session first. The marker is a hint at listing time and can change " +
				"between listing and use.",
			inputSchema: common,
		};
	}
	return { name, description: "List known scoped GJC coordinator bridge sessions.", inputSchema: common };
}

type DelegateWorkflow = "plan" | "execute";

function workflowForDelegateTool(name: string): DelegateWorkflow | null {
	switch (name) {
		case "gjc_delegate_plan":
			return "plan";
		case "gjc_delegate_execute":
			return "execute";
		default:
			return null;
	}
}

function workflowSkill(workflow: DelegateWorkflow): "ralplan" | "ultragoal" {
	switch (workflow) {
		case "plan":
			return "ralplan";
		case "execute":
			return "ultragoal";
	}
}

function delegateToolDescription(workflow: DelegateWorkflow): string {
	switch (workflow) {
		case "plan":
			return "Delegate consensus planning to GJC: start or reuse a session and submit /skill:ralplan. Return durable admission by default; await_completion=true additionally returns bounded completion observation, stopping at terminal, waiting_for_answer, or timeout. Replay remains subject to current authorization, path, model, mpreset, and worktree validation.";
		case "execute":
			return "Delegate execution to GJC: start or reuse a session and submit /skill:ultragoal. Return durable admission by default; await_completion=true additionally returns bounded completion observation, stopping at terminal, waiting_for_answer, or timeout. Replay remains subject to current authorization, path, model, mpreset, and worktree validation.";
	}
}

function workflowPrompt(
	workflow: DelegateWorkflow,
	toolName: string,
	canonicalCwd: string,
	task: string,
	options: { mutationRequested: boolean; model?: string | null },
): string {
	const skill = workflowSkill(workflow);
	const model = options.model && options.model.trim().length > 0 ? options.model.trim() : "none";
	const mutationIntent = options.mutationRequested ? "mutation requested" : "read-only";
	return [
		`/skill:${skill}`,
		"",
		`Delegated by coordinator MCP tool: ${toolName}`,
		`Workflow: ${workflow}`,
		`CWD: ${canonicalCwd}`,
		`Mutation intent: ${mutationIntent}; coordinator startup policy remains authoritative.`,
		`Optional model hint: ${model}`,
		"",
		"Task:",
		task,
		"",
		"Return durable status and artifact references through GJC runtime/coordinator state. Do not expose host-facing tmux controls.",
	].join("\n");
}

function normalizeSession(session: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {
		session_id: firstString(session, ["sessionId", "session_id", "name"]) ?? "unknown",
	};
	const strings: Array<[string, string[]]> = [
		["cwd", ["cwd"]],
		["created_at", ["created_at", "createdAt"]],
		["mpreset", ["mpreset"]],
		["source", ["source"]],
		["model", ["model"]],
		["tmux_session", ["tmux_session", "tmuxSession"]],
		["tmux_target", ["tmux_target", "tmuxTarget"]],
		["broker_workspace", ["broker_workspace"]],
		["endpoint_incarnation", ["endpoint_incarnation"]],
		["sidecar_key_id", ["sidecar_key_id"]],
		["sidecar_signature", ["sidecar_signature"]],
	];
	for (const [output, keys] of strings) {
		const value = firstString(session, keys);
		if (value !== null) normalized[output] = value;
	}
	for (const key of ["ephemeral", "visible"]) {
		if (typeof session[key] === "boolean") normalized[key] = session[key];
	}
	if (
		typeof session.endpoint_generation === "number" &&
		Number.isSafeInteger(session.endpoint_generation) &&
		session.endpoint_generation > 0
	)
		normalized.endpoint_generation = session.endpoint_generation;
	const sidecarVerifier = asRecord(session.sidecar_verifier);
	if (sidecarVerifier && typeof sidecarVerifier.key_id === "string" && typeof sidecarVerifier.public_key === "string")
		normalized.sidecar_verifier = {
			key_id: sidecarVerifier.key_id,
			public_key: sidecarVerifier.public_key,
		};
	return normalized;
}

/** Whether the configured selector puts sessions in a GJC-managed worktree. */
function coordinatorWorktreeEnabled(sessionCommand: string | null): boolean {
	if (!sessionCommand) return false;
	const [executable, ...args] = sessionCommand.trim().split(/\s+/);
	return executable === "gjc" && args[0] === "--worktree";
}

type CoordinatorWorktreeResolution = { ok: true; name?: string } | { ok: false; reason: string };

/**
 * Resolves the worktree name for one session creation.
 *
 * The configured selector stays the capability gate: it decides whether GJC manages
 * a worktree at all, so a request cannot turn worktree mode on for a coordinator
 * deliberately configured to run in place. Within worktree mode the request names
 * this session's worktree, which is what lets concurrent sessions in one repository
 * get isolated checkouts instead of sharing the slug derived from its current branch.
 *
 * Refusals are typed rather than thrown: the bridge redacts error messages, so a
 * thrown error would reach the controller as an undiagnosable `invalid_input`.
 */
function resolveCoordinatorWorktree(
	sessionCommand: string | null,
	requested: unknown,
	required = false,
): CoordinatorWorktreeResolution {
	if (requested !== undefined && typeof requested !== "string") return { ok: false, reason: "invalid_worktree_name" };
	const name = optionalString(requested);
	if (required && !coordinatorWorktreeEnabled(sessionCommand)) {
		return { ok: false, reason: "worktree_required_without_worktree_mode" };
	}
	if (required && name === null) return { ok: false, reason: "worktree_required" };
	if (name === null) return { ok: true };
	if (!coordinatorWorktreeEnabled(sessionCommand)) return { ok: false, reason: "worktree_not_enabled" };
	// The selector is whitespace-split, so a name containing whitespace has no
	// representation, and a leading `-` would parse as another flag.
	if (name.startsWith("-") || /\s/.test(name)) return { ok: false, reason: "invalid_worktree_name" };
	// Named worktrees create local branches. Validate the exact branch grammar at
	// the coordinator boundary so malformed requests receive the typed refusal
	// rather than a redacted lifecycle error. The argv array prevents the name
	// from becoming shell syntax or another git option.
	const validation = Bun.spawnSync(["git", "check-ref-format", "--branch", name], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (validation.exitCode !== 0) return { ok: false, reason: "invalid_worktree_name" };
	return { ok: true, name };
}

/**
 * Builds the SDK lifecycle target for one session creation. `requestedWorktree`
 * comes from a resolved {@link resolveCoordinatorWorktree} and overrides the name
 * carried by the configured selector.
 */
function coordinatorLifecycleTarget(
	sessionCommand: string | null,
	cwd: string,
	requestedWorktree?: string,
): Record<string, unknown> {
	if (!sessionCommand) return { path: cwd };
	const [executable, ...args] = sessionCommand.trim().split(/\s+/);
	if (executable !== "gjc")
		throw new SdkClientError(
			"invalid_input",
			"GJC_COORDINATOR_MCP_SESSION_COMMAND must be exactly gjc with an optional --worktree [name] selector.",
		);
	if (args.length === 0) return { path: cwd };
	if (
		args[0] !== "--worktree" ||
		args.length > 2 ||
		(args[1] !== undefined && (args[1].length === 0 || args[1].startsWith("-")))
	)
		throw new SdkClientError(
			"invalid_input",
			"GJC_COORDINATOR_MCP_SESSION_COMMAND supports only gjc or gjc --worktree [name] under SDK lifecycle control.",
		);
	const name = requestedWorktree ?? args[1];
	return {
		path: cwd,
		worktree: { enabled: true, ...(name ? { name } : {}) },
	};
}

async function ensureDir(dir: string): Promise<void> {
	await ensureCoordinatorDirectory(dir);
}

async function readJsonFile(file: string): Promise<unknown | null> {
	let source: string;
	try {
		source = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	}
	try {
		return JSON.parse(source);
	} catch (error) {
		throw new Error(
			`invalid coordinator projection ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function removeCoordinatorFile(file: string): Promise<void> {
	try {
		await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			await fs.stat(path.dirname(file));
		} catch (parentError) {
			if ((parentError as NodeJS.ErrnoException).code === "ENOENT") return;
			throw parentError;
		}
		await syncCoordinatorDirectory(path.dirname(file));
		return;
	}
	await fs.rm(file, { force: true });
	await syncCoordinatorDirectory(path.dirname(file));
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await writeCoordinatorAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

const COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP = 64 * 1024;
const COORDINATOR_IDEMPOTENCY_STRING_BYTE_CAP = 8 * 1024;
const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
	invalid_input: "Coordinator request input is invalid.",
	invalid_request: "Coordinator request is invalid.",
	invalid_session_id: "Coordinator session id is invalid.",
	unknown_operation: "Coordinator operation is unsupported.",
	not_found: "Coordinator resource was not found.",
	resource_gone: "Coordinator resource is no longer available.",
	unavailable: "Coordinator service is unavailable.",
	timeout: "Coordinator request timed out.",
	connection_closed: "Coordinator connection closed before completion.",
	uncertain_after_send: "Coordinator request outcome is uncertain.",
	endpoint_credential_forbidden: "Coordinator endpoint credentials are not public.",
	codex_token_file_reregistration_required:
		"Codex token file identity must be re-registered before this handoff can be used.",
	codex_authenticated_handoff_unavailable_windows:
		"Authenticated Codex token-file handoff is unavailable on native Windows.",
	endpoint_stale: "Coordinator session endpoint is stale.",
	retirement_proof_stale: "Coordinator retirement proof is stale before effect start.",
	ambiguous: "Coordinator request outcome is ambiguous.",
	terminal_uncertain: "Coordinator state is uncertain.",
	retired: "The coordinator intent was retired after exact identity proof.",
	retire_not_allowed: "The coordinator intent is not eligible for retirement.",
	idempotency_conflict: "Idempotency key conflicts with a different request.",
	idempotency_in_progress: "A previous coordinator mutation is still in progress.",
	protocol_error: "Coordinator protocol response is invalid.",
	broker_unavailable: "SDK broker is unavailable.",
	broker_bootstrap_failed: "SDK broker bootstrap failed.",
	broker_cleanup_unverified: "SDK broker cleanup could not be verified.",
	broker_compensation_unobserved: "SDK broker session cleanup could not be verified.",
	broker_discovery_unsupported: "SDK broker discovery state is unsupported.",
	broker_discovery_access_denied: "SDK broker discovery cannot be accessed.",
	broker_discovery_unavailable: "SDK broker discovery is unavailable.",
	broker_request_unavailable: "SDK broker request is unavailable.",
	broker_transport_unavailable: "SDK broker transport is unavailable.",
	startup_admission_timeout: "SDK host startup was not admitted before the queue wait cutoff.",
	startup_admission_refused: "SDK host startup was refused because the broker no longer owns the session root.",
	worktree_in_use: "The requested worktree is already held by another live session.",
	worktree_preparation_timeout: "Worktree preparation exceeded its deadline before the session host was spawned.",
	dependency_preparation_timeout: "Dependency preparation exceeded its deadline before the session host was spawned.",
	spawn_failed: "Session host could not be spawned.",
	readiness_timeout: "Session did not become ready before the SDK readiness deadline.",
	incarnation_unavailable: "OS process incarnation authority is unavailable.",
	session_closing: "Coordinator session is closing.",
	session_unavailable: "Coordinator session is unavailable.",
	session_not_activatable: "Coordinator session cannot be activated.",
	session_not_live: "Coordinator session is not live.",
	not_prepared: "Coordinator session is not prepared for activation.",
	not_bound: "Coordinator session has no existing-thread binding.",
	activation_unavailable: "Coordinator activation authority is unavailable.",
	activation_outcome_unknown: "Coordinator activation outcome is uncertain.",
	workspace_mismatch: "Coordinator session is bound to another workspace.",
	active_turn_exists: "Coordinator session already has an active turn.",
	artifact_unavailable: "Coordinator artifact could not be read.",
	event_snapshot_unavailable: "Coordinator event snapshot is unavailable.",
	unsupported_gate: "Coordinator question gate is unsupported.",
	query_unavailable: "Coordinator question state is unavailable.",
	pagination_malformed: "Coordinator question pagination is malformed.",
	row_unrepresentable: "Coordinator question row cannot be represented safely.",
	missing_runtime_turn: "Coordinator question has no runtime turn owner.",
	invalid_runtime_turn: "Coordinator question runtime turn is invalid.",
	invalid_gate_row: "Coordinator question row is invalid.",
	wrong_session: "Coordinator question belongs to another session.",
	ownership_unavailable: "Coordinator question ownership is unavailable.",
	ownership_conflict: "Coordinator question ownership conflicts.",
	gate_provenance_changed: "Coordinator question provenance changed.",
	turn_terminal: "Coordinator turn is terminal.",
	endpoint_changed: "Coordinator session endpoint changed.",
	terminal_race: "Coordinator turn changed terminal state concurrently.",
	reported_failure: "Coordinator reported a turn failure.",
	validation_rejected: "Coordinator answer failed workflow validation.",
	ownership_mismatch: "Coordinator ownership does not match the request.",
};

interface DelegateAdmissionCheckpoint {
	kind: "delegate_admission";
	session_id: string;
	turn_id: string;
	response: Record<string, unknown>;
}

interface DelegateResponsePinV1 {
	session_id: string;
	coordinator_turn_id: string;
	prompt_key_digest: string;
	runtime_command_id: string;
	runtime_turn_id: string;
}

interface CoordinatorToolIdempotencyRecord {
	schema_version: 1;
	tool: string;
	key_digest: string;
	request_digest: string;
	state: "in_progress" | "completed";
	response?: Record<string, unknown>;
	admission?: DelegateAdmissionCheckpoint;
	delegate_response_pin?: DelegateResponsePinV1;
	created_at: string;
	completed_at?: string;
}

type CoordinatorIdempotencyFile =
	| { kind: "missing" }
	| { kind: "record"; value: Record<string, unknown> }
	| { kind: "corrupt" };

async function readCoordinatorIdempotencyFile(file: string): Promise<CoordinatorIdempotencyFile> {
	let source: string;
	try {
		source = await fs.readFile(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "corrupt" };
	}
	try {
		const value = asRecord(JSON.parse(source));
		return value ? { kind: "record", value } : { kind: "corrupt" };
	} catch {
		return { kind: "corrupt" };
	}
}

async function writeCoordinatorIdempotencyFile(file: string, value: CoordinatorToolIdempotencyRecord): Promise<void> {
	await writeCoordinatorAtomic(file, `${JSON.stringify(value)}\n`);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function sensitivePublicField(key: string): boolean {
	return /^(?:token|secret|credential(?:s)?|authorization|password|api[_-]?key|endpoint|url|uri)$/i.test(key);
}

function boundedPublicValue(value: unknown, budget: { remaining: number }, depth = 0): unknown {
	if (depth > 12 || budget.remaining <= 0) return "[truncated]";
	if (value === null || typeof value === "boolean") {
		budget.remaining -= 8;
		return value;
	}
	if (typeof value === "number") {
		budget.remaining -= 24;
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const cap = Math.max(0, Math.min(COORDINATOR_IDEMPOTENCY_STRING_BYTE_CAP, budget.remaining));
		let end = value.length;
		while (end > 0 && Buffer.byteLength(value.slice(0, end)) > cap) end -= 1;
		const text = value.slice(0, end);
		budget.remaining -= Buffer.byteLength(text);
		return end === value.length ? text : `${text}[truncated]`;
	}
	if (Array.isArray(value)) {
		const items: unknown[] = [];
		for (const item of value.slice(0, 128)) items.push(boundedPublicValue(item, budget, depth + 1));
		if (value.length > 128) items.push("[truncated]");
		return items;
	}
	if (typeof value !== "object") return null;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).slice(0, 128)) {
		const field = (value as Record<string, unknown>)[key];
		if (key === "error") {
			const rawCode =
				field && typeof field === "object" && !Array.isArray(field)
					? (field as Record<string, unknown>).code
					: undefined;
			const code =
				typeof rawCode === "string" && Object.hasOwn(PUBLIC_ERROR_MESSAGES, rawCode) ? rawCode : "unavailable";
			output[key] = { code, message: PUBLIC_ERROR_MESSAGES[code] };
		} else {
			output[key] = sensitivePublicField(key) ? "[redacted]" : boundedPublicValue(field, budget, depth + 1);
		}
	}
	if (Object.keys(value as Record<string, unknown>).length > 128) output.truncated = true;
	return output;
}

function boundedPublicResponse(response: Record<string, unknown>): Record<string, unknown> {
	const value = boundedPublicValue(response, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP });
	return asRecord(value) ?? { ok: false, error: { code: "unavailable", message: "Invalid coordinator response." } };
}
const CODEX_HANDOFF_RESPONSE_STRING_CAP = 4096;

function boundedCodexHandoffString(value: unknown): string | null {
	return typeof value === "string" ? value.slice(0, CODEX_HANDOFF_RESPONSE_STRING_CAP) : null;
}

function boundedCodexHandoff(response: unknown): Record<string, unknown> | null {
	const handoff = asRecord(response);
	if (!handoff) return null;
	const workUnit = boundedCodexHandoffString(handoff.work_unit);
	const threadId = boundedCodexHandoffString(handoff.thread_id);
	const registeredAt = boundedCodexHandoffString(handoff.registered_at);
	const updatedAt = boundedCodexHandoffString(handoff.updated_at);
	const endpoint = asRecord(handoff.endpoint);
	if (
		handoff.schema_version !== 1 ||
		workUnit === null ||
		threadId === null ||
		registeredAt === null ||
		updatedAt === null ||
		!endpoint
	)
		return null;
	let boundedEndpoint: Record<string, unknown> | null = null;
	if (endpoint.kind === "unix") {
		const socketPath = boundedCodexHandoffString(endpoint.path);
		if (socketPath !== null) boundedEndpoint = { kind: "unix", path: socketPath };
	} else if (endpoint.kind === "tcp") {
		const host = boundedCodexHandoffString(endpoint.host);
		if (host !== null && typeof endpoint.port === "number")
			boundedEndpoint = { kind: "tcp", host, port: endpoint.port };
	}
	if (!boundedEndpoint) return null;
	return {
		schema_version: 1,
		work_unit: workUnit,
		thread_id: threadId,
		endpoint: boundedEndpoint,
		token_configured: handoff.token_file !== null,
		registered_at: registeredAt,
		updated_at: updatedAt,
	};
}

function boundedCodexHandoffResponse(response: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	if (typeof response.ok === "boolean") output.ok = response.ok;
	const error = asRecord(response.error);
	if (error) {
		const boundedError: Record<string, unknown> = {};
		const code = boundedCodexHandoffString(error.code);
		const message = boundedCodexHandoffString(error.message);
		if (code !== null) boundedError.code = code;
		if (message !== null) boundedError.message = message;
		if (Object.keys(boundedError).length > 0) output.error = boundedError;
	}
	const handoff = boundedCodexHandoff(response.handoff);
	if (handoff) output.handoff = handoff;
	const heartbeat = asRecord(response.heartbeat);
	if (heartbeat?.supported === false && heartbeat.reason === "automation_update_unavailable")
		output.heartbeat = { supported: false, reason: "automation_update_unavailable" };
	return output;
}

function boundedToolResponse(tool: string, response: Record<string, unknown>): Record<string, unknown> {
	if (tool === "gjc_coordinator_register_codex_handoff") return boundedCodexHandoffResponse(response);
	return boundedPublicResponse(response);
}

/**
 * `activation_outcome_unknown` states only that the activation's outcome could
 * not be observed: the session may already have published the readiness the
 * request asked for. It is the one activation answer that proves nothing, so it
 * is returned to the caller without being sealed as a settled receipt.
 */
function isUnknownActivationOutcome(response: Record<string, unknown>): boolean {
	if (response.ok !== false) return false;
	return asRecord(response.error)?.code === "activation_outcome_unknown";
}

/**
 * Which durable states may reach the activation proof, and which of them is
 * already settled.
 *
 * Durable state is a record of what was proved, never a proof on its own. Only
 * a `prepared` session (readiness still withheld) and a `ready_for_input` one
 * (readiness already proved once) are activatable, and both are answered by the
 * live session at the exact endpoint, generation, incarnation, and binding.
 * Every other observed state — stale, booting, running, needs_user_input,
 * completed, errored, unknown, or a missing state file — is not activatable and
 * fails closed before any frame is sent.
 */
function classifyCoordinatorActivation(
	state: CoordinatorSessionState | null,
): { activatable: true; settled: boolean; observed: string } | { activatable: false; observed: string } {
	const observed = state?.state ?? "unknown";
	if (observed === "prepared") return { activatable: true, settled: false, observed };
	if (observed === "ready_for_input") return { activatable: true, settled: true, observed };
	return { activatable: false, observed };
}

interface RuntimePromptAcknowledgement {
	accepted: true;
	command_id: string;
	turn_id: string;
}

function sdkResultPayload(result: unknown): Record<string, unknown> | null {
	const response = asRecord(result);
	if (!response) return null;
	const envelope = ["ok", "result", "error"].some(key => Object.hasOwn(response, key));
	if (!envelope) return response;
	if (response.ok !== true || !Object.hasOwn(response, "result") || Object.hasOwn(response, "error")) return null;
	return asRecord(response.result);
}

function runtimeAcknowledgementIdentity(
	acknowledgement: Record<string, unknown>,
	camelCaseKey: "commandId" | "turnId",
	snakeCaseKey: "command_id" | "turn_id",
): string {
	const values = [camelCaseKey, snakeCaseKey]
		.filter(key => Object.hasOwn(acknowledgement, key))
		.map(key => acknowledgement[key]);
	if (values.length === 0)
		throw new SdkClientError("unavailable", `SDK prompt acknowledgement omitted ${snakeCaseKey}.`);
	if (
		values.some(value => typeof value !== "string" || !SAFE_EXTERNAL_ID_PATTERN.test(value)) ||
		new Set(values).size !== 1
	)
		throw new SdkClientError("unavailable", `SDK prompt acknowledgement has invalid ${snakeCaseKey}.`);
	return values[0] as string;
}

function normalizeRuntimePromptAcknowledgement(result: unknown): RuntimePromptAcknowledgement {
	const acknowledgement = sdkResultPayload(result);
	if (acknowledgement?.accepted !== true)
		throw new SdkClientError("unavailable", "SDK did not acknowledge prompt delivery.");
	return {
		accepted: true,
		command_id: runtimeAcknowledgementIdentity(acknowledgement, "commandId", "command_id"),
		turn_id: runtimeAcknowledgementIdentity(acknowledgement, "turnId", "turn_id"),
	};
}

function publicSdkAcknowledgement(result: RuntimePromptAcknowledgement): Record<string, unknown> {
	return {
		accepted: true,
		command_id: result.command_id,
		turn_id: result.turn_id,
	};
}

async function listJsonFiles(dir: string): Promise<unknown[]> {
	const scan = await listCoordinatorJsonFilesWithRetry(dir);
	if (scan.capped) throw new Error("coordinator_projection_scan_incomplete");
	if (scan.skippedEmpty > 0 || scan.skippedDebris > 0) {
		logger.warn("Coordinator projection scan skipped debris", {
			dir,
			parsed: scan.parsed,
			skippedDebris: scan.skippedDebris,
			skippedEmpty: scan.skippedEmpty,
		});
	}
	return scan.values;
}

const COORDINATOR_STATUS_EVENT_LIMIT = 100;

function jsonRecords(values: unknown[]): Array<Record<string, unknown>> {
	return values.map(value => asRecord(value)).filter((value): value is Record<string, unknown> => value !== null);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function brokerSessionId(record: Record<string, unknown>): string | null {
	return firstString(record, ["sessionId", "session_id"]);
}

function brokerSessionScope(record: Record<string, unknown>): string | null {
	// Locator v2 records the canonical workspace directory as `cwd`; the removed
	// `repo` field is never translated, so reading it here silently dropped every
	// broker row and failed open with an empty scoped listing.
	return firstString(asRecord(record.locator) ?? {}, ["cwd"]);
}

function sameCanonicalPath(left: string, right: string, platform: NodeJS.Platform): boolean {
	return normalizePathForComparison(left, platform) === normalizePathForComparison(right, platform);
}

function scopedBrokerSessions(
	values: unknown[],
	cwd: string,
	platform: NodeJS.Platform,
): Array<Record<string, unknown>> {
	const pathApi = platform === "win32" ? path.win32 : path;
	const scope = pathApi.resolve(cwd);
	return jsonRecords(values).filter(session => {
		const sessionScope = brokerSessionScope(session);
		return sessionScope !== null && sameCanonicalPath(pathApi.resolve(sessionScope), scope, platform);
	});
}

function brokerLiveness(session: Record<string, unknown> | null): Record<string, unknown> {
	if (!session) return { authority: "sdk_broker", live: false, reason: "not_indexed" };
	if (typeof session.live === "boolean") return { authority: "sdk_broker", live: session.live };
	return { authority: "sdk_broker", reason: "liveness_unreported" };
}

function publicBrokerSession(session: Record<string, unknown>): Record<string, unknown> {
	const sessionId = brokerSessionId(session);
	return {
		...(sessionId ? { session_id: sessionId } : {}),
		...(typeof session.live === "boolean" ? { live: session.live } : {}),
		...(session.terminalUncertain === true || session.terminal_uncertain === true
			? { terminal_uncertain: true }
			: {}),
	};
}

function publicCoordinatorSession(session: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {
		session_id: firstString(session, ["session_id", "sessionId"]) ?? "unknown",
	};
	for (const key of ["cwd", "created_at", "mpreset", "model"]) {
		const value = session[key];
		if (typeof value === "string") result[key] = value;
	}
	if (typeof session.ephemeral === "boolean") result.ephemeral = session.ephemeral;
	if (typeof session.visible === "boolean") result.visible = session.visible;
	return result;
}

function publicCoordinatorStatusSession(session: Record<string, unknown>): Record<string, unknown> {
	const { cwd: _cwd, ...safe } = publicCoordinatorSession(session);
	return safe;
}

function capabilityFreeStatusValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(capabilityFreeStatusValue);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (/^(?:answer_binding|cwd|path|payload_ref|state_root)$/i.test(key)) continue;
		result[key] = capabilityFreeStatusValue(child);
	}
	return result;
}

function publicLifecycleReceipt(result: Record<string, unknown>, sessionId: string): Record<string, unknown> {
	const receipt: Record<string, unknown> = { session_id: sessionId };
	const worktree = asRecord(result.worktree);
	if (worktree?.enabled !== true) return receipt;
	const publicWorktree: Record<string, unknown> = { enabled: true };
	for (const key of ["cwd", "branch"]) {
		if (typeof worktree[key] === "string") publicWorktree[key] = worktree[key];
	}
	for (const key of ["created", "reused"]) {
		if (typeof worktree[key] === "boolean") publicWorktree[key] = worktree[key];
	}
	receipt.worktree = publicWorktree;
	return receipt;
}

function publicCoordinatorSessionState(state: CoordinatorSessionState | null): Record<string, unknown> | null {
	if (!state) return null;
	// The sidecar owns the one projection that strips its private correlation state and
	// withholds any snapshot that contradicts the lifecycle state published beside it.
	const activity = publicRuntimeToolActivity(state.activity, state.state);
	return {
		session_id: state.session_id,
		state: state.state,
		ready_for_input: state.ready_for_input,
		current_turn_id: state.current_turn_id,
		last_turn_id: state.last_turn_id,
		updated_at: state.updated_at,
		...(typeof state.live === "boolean" ? { live: state.live } : {}),
		...(activity ? { activity } : {}),
		...(typeof state.ended_at === "string" && Number.isFinite(Date.parse(state.ended_at))
			? { ended_at: state.ended_at }
			: {}),
	};
}

function eventTimestamp(record: Record<string, unknown>): string | null {
	return firstString(record, ["updated_at", "completed_at", "answered_at", "created_at", "registered_at"]);
}

function canonicalCoordinatorEvent(
	event_type: "session_state" | "turn_state" | "question_state" | "coordination_report",
	record: Record<string, unknown>,
): Record<string, unknown> {
	return {
		schema_version: 1,
		event_type,
		session_id: firstString(record, ["session_id", "sessionId"]),
		turn_id: firstString(record, ["turn_id", "turnId", "current_turn_id", "last_turn_id"]),
		question_id: event_type === "question_state" ? firstString(record, ["id", "question_id"]) : null,
		status: firstString(record, ["status", "state"]),
		source: firstString(record, ["source"]),
		updated_at: eventTimestamp(record),
	};
}

function sortNewestFirst(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return [...records].sort((left, right) => {
		const leftTime = eventTimestamp(left) ?? "";
		const rightTime = eventTimestamp(right) ?? "";
		return rightTime.localeCompare(leftTime);
	});
}

function buildCanonicalCoordinatorEvents(input: {
	sessionStates: Array<Record<string, unknown>>;
	turns: Array<Record<string, unknown>>;
	questions: Array<Record<string, unknown>>;
	reports: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
	return sortNewestFirst([
		...input.sessionStates.map(record => canonicalCoordinatorEvent("session_state", record)),
		...input.turns.map(record => canonicalCoordinatorEvent("turn_state", record)),
		...input.questions.map(record => canonicalCoordinatorEvent("question_state", record)),
		...input.reports.map(record => canonicalCoordinatorEvent("coordination_report", record)),
	]).slice(0, COORDINATOR_STATUS_EVENT_LIMIT);
}

function activeSessionStates(sessionStates: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return sessionStates.filter(record => {
		const state = record.state;
		return state === "booting" || state === "running" || state === "needs_user_input" || state === "stale";
	});
}

function eventsDir(namespaceDir: string): string {
	return path.join(namespaceDir, "events");
}

function eventJournalFile(namespaceDir: string): string {
	return path.join(eventsDir(namespaceDir), "event-journal.jsonl");
}

function eventSequenceFile(namespaceDir: string): string {
	return path.join(eventsDir(namespaceDir), "latest-seq.json");
}

function eventJournalIndexFile(namespaceDir: string): string {
	return path.join(eventsDir(namespaceDir), "event-journal-index.v1.json");
}

function eventJournalIndexMigrationFile(namespaceDir: string): string {
	return path.join(eventsDir(namespaceDir), "event-journal-index.v1.migrated.json");
}

function eventStableIndexFile(namespaceDir: string, eventId: string): string {
	const key = createHash("sha256").update(eventId).digest("hex");
	return path.join(eventsDir(namespaceDir), "event-index", `${key}.json`);
}

function fixedEventSummary(kind: CoordinatorEventKind): string {
	if (kind.startsWith("session.")) return "Coordinator session lifecycle changed.";
	if (kind.startsWith("turn.")) return "Coordinator turn lifecycle changed.";
	if (kind === "question.opened") return "A coordinator question is awaiting an answer.";
	if (kind === "question.answered") return "A coordinator question was answered.";
	if (kind === "report.written") return "A coordination report was recorded.";
	if (kind.startsWith("delegation.")) return "A coordinator delegation was admitted.";
	return "Coordinator event recorded.";
}

function publicCoordinatorEvent(event: CoordinatorEvent): CoordinatorEvent {
	return {
		schema_version: 1,
		seq: event.seq,
		id: event.id,
		timestamp: event.timestamp,
		kind: event.kind,
		...(event.session_id ? { session_id: event.session_id } : {}),
		...(event.turn_id ? { turn_id: event.turn_id } : {}),
		...(event.question_id ? { question_id: event.question_id } : {}),
		...(event.report_id ? { report_id: event.report_id } : {}),
		summary: fixedEventSummary(event.kind),
	};
}

function boundSummary(value: string): string {
	const normalized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

type EventJournalSnapshot = { events: CoordinatorEvent[]; watermark: number; offsets: number[] };

function normalizedEventWatermark(snapshot: unknown): number | null {
	if (!snapshot || typeof snapshot !== "object") return null;
	const watermark = (snapshot as { watermark?: unknown }).watermark;
	if (
		typeof watermark !== "number" ||
		!Number.isFinite(watermark) ||
		!Number.isSafeInteger(watermark) ||
		watermark < 0
	)
		return null;
	return Math.trunc(watermark);
}

function publicWatchWatermark(
	snapshot: unknown,
	afterSeq: number,
): { latest_seq: number; next_after_seq: number } | null {
	const latestSeq = normalizedEventWatermark(snapshot);
	if (latestSeq === null || !Number.isSafeInteger(afterSeq) || afterSeq < 0) return null;
	const nextAfterSeq = Math.max(afterSeq, latestSeq);
	return Number.isSafeInteger(nextAfterSeq) && nextAfterSeq >= latestSeq
		? { latest_seq: latestSeq, next_after_seq: nextAfterSeq }
		: null;
}

function publicWatchSuccess(
	events: CoordinatorEvent[],
	watermark: unknown,
	nextAfterSeq: unknown,
	timedOut: boolean,
): Record<string, unknown> {
	if (
		typeof watermark !== "number" ||
		!Number.isFinite(watermark) ||
		!Number.isSafeInteger(watermark) ||
		watermark < 0 ||
		typeof nextAfterSeq !== "number" ||
		!Number.isFinite(nextAfterSeq) ||
		!Number.isSafeInteger(nextAfterSeq) ||
		nextAfterSeq < 0 ||
		nextAfterSeq > watermark
	)
		return {
			ok: false,
			error: { code: "event_snapshot_unavailable", message: "Coordinator event snapshot is unavailable." },
		};
	return {
		ok: true,
		events,
		latest_seq: Number(watermark),
		next_after_seq: Number(nextAfterSeq),
		timed_out: Boolean(timedOut),
		transport: { mcp: "long_poll", push_subscriptions: false },
	};
}

type EventJournalIndex = { schema_version: 1; by_id: Record<string, { seq: number; offset: number }> };
type EventJournalIndexMigration = { schema_version: 1; migrated_at: string };

async function writeJournalJsonAtomic(file: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, file);
	await syncCoordinatorDirectory(path.dirname(file), { platform: process.platform });
}

function parseJournalLines(raw: string): { events: CoordinatorEvent[]; offsets: number[]; tornTail: boolean } {
	// A journal without a trailing newline is an interrupted append. Parse only
	// complete newline-terminated rows, then let the locked caller truncate the
	// incomplete final fragment. Complete malformed rows still fail closed.
	const events: CoordinatorEvent[] = [];
	const offsets: number[] = [];
	let offset = 0;
	let previousSeq = 0;
	const lines = raw.split("\n");
	const tornTail = raw.length > 0 && !raw.endsWith("\n");
	const completeLines = tornTail ? lines.slice(0, -1) : lines;
	for (const line of completeLines) {
		const bytes = Buffer.byteLength(line) + 1;
		if (!line.trim()) {
			offset += bytes;
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("event_journal_corrupt");
		}
		const event = asRecord(value);
		if (event?.schema_version !== 1 || typeof event.seq !== "number" || !Number.isSafeInteger(event.seq))
			throw new Error("state_corrupt");
		if (
			event.seq <= previousSeq ||
			typeof event.id !== "string" ||
			event.id.length === 0 ||
			typeof event.kind !== "string" ||
			typeof event.timestamp !== "string" ||
			!Number.isFinite(Date.parse(String(event.timestamp))) ||
			typeof event.summary !== "string"
		)
			throw new Error("event_journal_corrupt");
		previousSeq = event.seq;
		events.push(event as unknown as CoordinatorEvent);
		offsets.push(offset);
		offset += bytes;
	}
	return { events, offsets, tornTail };
}

async function migrateLegacyJournalIndexLocked(
	namespaceDir: string,
	parsed: { events: CoordinatorEvent[]; offsets: number[] },
): Promise<void> {
	const migrationFile = eventJournalIndexMigrationFile(namespaceDir);
	const migrated = asRecord(await readJsonFile(migrationFile));
	if (migrated?.schema_version === 1) return;

	const legacy = asRecord(await readJsonFile(eventJournalIndexFile(namespaceDir)));
	const legacyById =
		legacy?.schema_version === 1 && legacy.by_id && typeof legacy.by_id === "object"
			? (legacy.by_id as EventJournalIndex["by_id"])
			: null;
	const entries = legacyById
		? Object.entries(legacyById).filter(
				([eventId, entry]) =>
					typeof eventId === "string" &&
					entry &&
					typeof entry.seq === "number" &&
					Number.isSafeInteger(entry.seq) &&
					typeof entry.offset === "number" &&
					Number.isSafeInteger(entry.offset) &&
					entry.offset >= 0,
			)
		: parsed.events.flatMap((event, index) => {
				const offset = parsed.offsets[index];
				return typeof offset === "number" ? [[event.id, { seq: event.seq, offset }] as const] : [];
			});
	for (const [eventId, entry] of entries) {
		const sidecar = eventStableIndexFile(namespaceDir, eventId);
		const existing = asRecord(await readJsonFile(sidecar));
		if (existing?.seq === entry.seq && existing.offset === entry.offset) continue;
		await writeJournalJsonAtomic(sidecar, { seq: entry.seq, offset: entry.offset });
	}
	await writeJournalJsonAtomic(migrationFile, {
		schema_version: 1,
		migrated_at: new Date().toISOString(),
	} satisfies EventJournalIndexMigration);
}

async function readJournalStableId(
	namespaceDir: string,
	eventId: string,
): Promise<{ event: CoordinatorEvent; offset: number } | null> {
	// A missing sidecar can follow a crash after journal fsync. Search the full,
	// validated journal so a later burst cannot make the stable row invisible.
	const snapshot = await readJournalSnapshotLocked(namespaceDir);
	const index = snapshot.events.findIndex(event => event.id === eventId);
	if (index < 0) return null;
	const offset = snapshot.offsets[index];
	return typeof offset === "number" ? { event: snapshot.events[index]!, offset } : null;
}

async function readJournalSnapshotLocked(namespaceDir: string, repairTail = true): Promise<EventJournalSnapshot> {
	const file = eventJournalFile(namespaceDir);
	let raw = "";
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], watermark: 0, offsets: [] };
		throw error;
	}
	const parsed = parseJournalLines(raw);
	if (parsed.tornTail && repairTail) {
		const lastNewline = raw.lastIndexOf("\n");
		const handle = await fs.open(file, "r+");
		try {
			await handle.truncate(Math.max(0, Buffer.byteLength(raw.slice(0, lastNewline + 1))));
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	const byId: Record<string, { seq: number; offset: number }> = {};
	for (const [index, event] of parsed.events.entries()) {
		if (byId[event.id]) throw new Error("event_journal_corrupt");
		byId[event.id] = { seq: event.seq, offset: parsed.offsets[index] ?? 0 };
	}
	await migrateLegacyJournalIndexLocked(namespaceDir, parsed);
	// A crash after journal fsync and before the per-id sidecar leaves only the
	// newest event unindexed. Repair that bounded window without rebuilding the
	// historical index on every snapshot.
	const latest = parsed.events.at(-1);
	const latestOffset = parsed.offsets.at(-1);
	if (
		latest &&
		typeof latestOffset === "number" &&
		!(await readJsonFile(eventStableIndexFile(namespaceDir, latest.id)))
	)
		await writeJournalJsonAtomic(eventStableIndexFile(namespaceDir, latest.id), {
			seq: latest.seq,
			offset: latestOffset,
		});
	const watermark = parsed.events.at(-1)?.seq ?? 0;
	if (!Number.isSafeInteger(watermark) || watermark < 0) throw new Error("event_journal_corrupt");
	const cachedSeq = asRecord(await readJsonFile(eventSequenceFile(namespaceDir)));
	if (cachedSeq?.seq !== watermark)
		await writeJournalJsonAtomic(eventSequenceFile(namespaceDir), {
			seq: watermark,
			updated_at: new Date().toISOString(),
		});
	return { events: parsed.events, watermark, offsets: parsed.offsets };
}

async function readJournalEventAtOffset(namespaceDir: string, offset: number): Promise<CoordinatorEvent | null> {
	const file = eventJournalFile(namespaceDir);
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat();
		if (offset < 0 || offset >= stat.size) return null;
		const length = Math.min(256 * 1024, stat.size - offset);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
		if (newline < 0) return null;
		const value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
		const event = asRecord(value);
		return event?.schema_version === 1 && typeof event.seq === "number" && typeof event.id === "string"
			? (event as unknown as CoordinatorEvent)
			: null;
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

async function readJournalTail(namespaceDir: string): Promise<CoordinatorEvent | null> {
	const file = eventJournalFile(namespaceDir);
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat();
		if (stat.size === 0) return null;
		const length = Math.min(256 * 1024, stat.size);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
		const raw = buffer.subarray(0, bytesRead).toString("utf8");
		const lines = raw.split("\n");
		const last = lines.at(-1) === "" ? lines.at(-2) : lines.at(-1);
		if (!last) return null;
		const value = JSON.parse(last);
		const event = asRecord(value);
		return event?.schema_version === 1 && typeof event.seq === "number" && typeof event.id === "string"
			? (event as unknown as CoordinatorEvent)
			: null;
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

async function readJournalSnapshot(namespaceDir: string, signal?: AbortSignal): Promise<EventJournalSnapshot> {
	await ensureDir(eventsDir(namespaceDir));
	return await withFileLock(
		path.join(eventsDir(namespaceDir), "event-journal.lock"),
		async () => await readJournalSnapshotLocked(namespaceDir),
		signal ? { signal } : undefined,
	);
}

const eventAppendQueues = new Map<string, Promise<unknown>>();
const codexWakeTransportFactories = new Map<string, CodexTransportFactory>();
const codexWakePublishTails = new Map<string, Promise<void>>();
const eventWebhookConfigs = new Map<string, EventWebhookConfig | null>();
const eventWebhookDeliveries = new Map<string, WebhookDelivery>();
const eventWebhookTails = new Map<string, Promise<void>>();
const eventWebhookStartupTails = new Map<string, Promise<void>>();
const EVENT_WEBHOOK_ERROR_CAP = 240;

async function appendEventWebhookDiagnostic(namespaceDir: string, eventId: string, error: unknown): Promise<void> {
	const code =
		error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
			? error.message.slice(0, EVENT_WEBHOOK_ERROR_CAP)
			: "event_webhook_delivery_failed";
	const line = `${new Date().toISOString()} event=${eventId} error=${code}\n`;
	try {
		await fs.appendFile(path.join(namespaceDir, "event-webhook-errors.log"), line.slice(0, 512), { mode: 0o600 });
	} catch {
		// Diagnostics are best-effort; sink problems must never propagate upward.
	}
}

function enqueueEventWebhook(namespaceDir: string, event: CoordinatorEvent): void {
	const config = eventWebhookConfigs.get(namespaceDir);
	if (config === null || config === undefined) return;
	const delivery = eventWebhookDeliveries.get(namespaceDir);
	if (!delivery) return;
	const previous = eventWebhookTails.get(namespaceDir) ?? Promise.resolve();
	const next = previous
		.then(async () => {
			await deliverEventWebhook(namespaceDir, config, event, () => JSON.stringify(event), delivery);
		})
		.catch(async error => {
			await appendEventWebhookDiagnostic(namespaceDir, event.id, error);
		});
	eventWebhookTails.set(namespaceDir, next);
	void next.finally(() => {
		if (eventWebhookTails.get(namespaceDir) === next) eventWebhookTails.delete(namespaceDir);
	});
}

async function awaitEventWebhookDeliveries(namespaceDir: string): Promise<void> {
	await Promise.all([...eventWebhookTails.entries()].filter(([key]) => key === namespaceDir).map(([, tail]) => tail));
}

/** Test-only helper that waits for startup replay and queued deliveries in a namespace. */
export async function awaitEventWebhookDeliveriesForTest(namespaceDir: string): Promise<void> {
	await eventWebhookStartupTails.get(namespaceDir);
	await awaitEventWebhookDeliveries(namespaceDir);
}

const CODEX_WAKE_ERROR_CAP = 240;
const CODEX_WAKE_DIAGNOSTIC_CAP = 512;
const CODEX_HANDOFF_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function codexWakeErrorCode(error: unknown): string {
	if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message))
		return error.message.slice(0, CODEX_WAKE_ERROR_CAP);
	return "codex_wake_publish_failed";
}

async function appendCodexWakeDiagnostic(
	namespaceDir: string,
	event: Pick<CoordinatorEvent, "id">,
	error: unknown,
): Promise<void> {
	const line = `${new Date().toISOString()} event=${event.id} error=${codexWakeErrorCode(error)}\n`;
	try {
		await appendCoordinatorFile(
			path.join(namespaceDir, "codex-wake-errors.log"),
			line.slice(0, CODEX_WAKE_DIAGNOSTIC_CAP),
		);
	} catch (diagnosticError) {
		logger.warn("Coordinator Codex wake diagnostic persistence failed", {
			eventId: event.id,
			error: String(diagnosticError),
		});
	}
}

async function appendCodexWakePublishDiagnostic(
	namespaceDir: string,
	event: CodexWakeEventV1,
	error: unknown,
): Promise<unknown | null> {
	const line = `${new Date().toISOString()} wake=${event.key} error=${codexWakeErrorCode(error)}\n`;
	try {
		await appendCoordinatorFile(
			path.join(namespaceDir, "codex-wake-errors.log"),
			line.slice(0, CODEX_WAKE_DIAGNOSTIC_CAP),
		);
	} catch (diagnosticError) {
		logger.warn("Coordinator Codex wake publish diagnostic persistence failed", {
			wakeKey: event.key,
			error: String(diagnosticError),
		});
		return diagnosticError;
	}
	return null;
}

async function autoBindDelegateCodexHandoff(
	namespaceDir: string,
	cwd: string,
	workUnit: string,
	delegationId: string,
	workflow: string,
	explicitHostWorkUnit: string | null,
): Promise<{ auto_bound: boolean; thread_id?: string }> {
	const diagnosticEvent = { id: `delegate-handoff-${delegationId}` };
	if (explicitHostWorkUnit !== null) {
		if (!SAFE_EXTERNAL_ID_PATTERN.test(explicitHostWorkUnit)) {
			await appendCodexWakeDiagnostic(
				namespaceDir,
				diagnosticEvent,
				new Error("codex_handoff_explicit_source_missing"),
			);
			return { auto_bound: false };
		}
		let source: CodexHandoffRegistrationV1 | null;
		try {
			source = await readCodexHandoff(namespaceDir, explicitHostWorkUnit);
		} catch (error) {
			await appendCodexWakeDiagnostic(
				namespaceDir,
				diagnosticEvent,
				error instanceof Error && error.message === "codex_token_file_reregistration_required"
					? error
					: new Error("codex_handoff_explicit_source_missing"),
			);
			throw error;
		}
		if (!source) {
			await appendCodexWakeDiagnostic(
				namespaceDir,
				diagnosticEvent,
				new Error("codex_handoff_explicit_source_missing"),
			);
			return { auto_bound: false };
		}
		try {
			const binding = await bindDelegateCodexHandoff(namespaceDir, {
				work_unit: workUnit,
				source,
				origin: {
					gjc_session_id: workUnit,
					gjc_turn_id: delegationId,
					codex_thread_id: source.thread_id,
					codex_turn_id: null,
					codex_host_session_id: explicitHostWorkUnit,
					delegation_id: delegationId,
					workflow,
					bound_at: new Date().toISOString(),
				},
			});
			return { auto_bound: true, thread_id: binding.handoff.thread_id };
		} catch (error) {
			await appendCodexWakeDiagnostic(namespaceDir, diagnosticEvent, error);
			throw error;
		}
	}
	try {
		const hostContexts = await listMcpDelegateHostContexts(cwd);
		if (hostContexts.failures > 0)
			await appendCodexWakeDiagnostic(namespaceDir, diagnosticEvent, new Error("codex_handoff_context_unreadable"));
		if (hostContexts.contexts.length === 0) return { auto_bound: false };
		const handoffs = await listCodexHandoffs(namespaceDir);
		const freshHostHandoffs = handoffs
			.filter(handoff => {
				if (handoff.origin !== undefined) return false;
				const updatedAt = Date.parse(handoff.updated_at);
				return Number.isFinite(updatedAt) && updatedAt >= Date.now() - CODEX_HANDOFF_FRESHNESS_MS;
			})
			.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
		const freshThreads = new Set(freshHostHandoffs.map(handoff => handoff.thread_id));
		const fallbackSource = freshThreads.size === 1 ? freshHostHandoffs[0] : undefined;
		const resolved = hostContexts.contexts.flatMap(context => {
			const source = handoffs.find(handoff => handoff.work_unit === context.session_id) ?? fallbackSource;
			return source ? [{ context, source }] : [];
		});
		if (resolved.length === 0) {
			const hasHostHandoffs = handoffs.some(handoff => handoff.origin === undefined);
			await appendCodexWakeDiagnostic(
				namespaceDir,
				diagnosticEvent,
				new Error(
					hasHostHandoffs && freshHostHandoffs.length === 0
						? "codex_handoff_source_stale"
						: "codex_handoff_source_ambiguous",
				),
			);
			return { auto_bound: false };
		}
		if (new Set(resolved.map(({ source }) => source.thread_id)).size !== 1) {
			await appendCodexWakeDiagnostic(namespaceDir, diagnosticEvent, new Error("codex_handoff_context_ambiguous"));
			return { auto_bound: false };
		}
		const { context, source } = resolved[0]!;
		const binding = await bindDelegateCodexHandoff(namespaceDir, {
			work_unit: workUnit,
			source,
			origin: {
				gjc_session_id: workUnit,
				gjc_turn_id: delegationId,
				codex_thread_id: source.thread_id,
				codex_turn_id: context.turn_id,
				codex_host_session_id: context.session_id,
				delegation_id: delegationId,
				workflow,
				bound_at: new Date().toISOString(),
			},
		});
		return { auto_bound: true, thread_id: binding.handoff.thread_id };
	} catch (error) {
		await appendCodexWakeDiagnostic(namespaceDir, diagnosticEvent, error);
		throw error;
	}
}

async function maybeRecordCodexWake(
	namespaceDir: string,
	event: CoordinatorEvent,
): Promise<{ handoff: CodexHandoffRegistrationV1; event: CodexWakeEventV1 | null } | null> {
	if (!event.session_id || !isCodexWakeEventKind(event.kind)) return null;
	const handoff = await readCodexHandoff(namespaceDir, event.session_id);
	if (!handoff) return null;
	const recorded = await recordCodexWakeEvent(namespaceDir, {
		work_unit: event.session_id,
		event_seq: event.seq,
		event_kind: event.kind,
		turn_id: event.turn_id ?? null,
		question_id: event.question_id ?? null,
		summary: event.summary,
	});
	return {
		handoff,
		event: recorded.event.status === "pending" || recorded.event.status === "failed" ? recorded.event : null,
	};
}

type CodexWakePublishOutcome = "published" | "thread_active_pending" | "failed" | "skipped";

async function publishRecordedCodexWake(
	namespaceDir: string,
	handoff: CodexHandoffRegistrationV1,
	event: CodexWakeEventV1,
): Promise<CodexWakePublishOutcome> {
	if (event.status !== "pending" && event.status !== "failed") return "skipped";
	const transportFactory = codexWakeTransportFactories.get(namespaceDir);
	if (!transportFactory) return "skipped";
	let published: { published: boolean };
	try {
		published = await publishCodexWake({ handoff, event, transportFactory });
	} catch (error) {
		const diagnosticError = await appendCodexWakePublishDiagnostic(namespaceDir, event, error);
		try {
			await updateCodexWakeEvent(namespaceDir, event.key, {
				status: "failed",
				attempts_delta: 1,
				last_error: codexWakeErrorCode(error),
			});
		} catch (stateError) {
			throw new AggregateError(
				[error, stateError, ...(diagnosticError ? [diagnosticError] : [])],
				"Codex wake publication and failure-state persistence failed",
			);
		}
		return "failed";
	}
	await updateCodexWakeEvent(namespaceDir, event.key, {
		...(published.published ? { status: "published" as const } : {}),
		attempts_delta: 1,
		last_error: null,
	});
	return published.published ? "published" : "thread_active_pending";
}

async function publishPendingCodexWakes(namespaceDir: string, threadId: string): Promise<void> {
	const handoffs = (await listCodexHandoffs(namespaceDir)).filter(handoff => handoff.thread_id === threadId);
	if (handoffs.length === 0) return;
	const byWorkUnit = new Map(handoffs.map(handoff => [handoff.work_unit, handoff]));
	const pending: CodexWakeEventV1[] = [];
	for (const handoff of handoffs) pending.push(...(await listPendingCodexWakeEvents(namespaceDir, handoff.work_unit)));
	pending.sort((left, right) => left.event_seq - right.event_seq);
	for (const event of pending) {
		const handoff = byWorkUnit.get(event.work_unit);
		if (!handoff) continue;
		const outcome = await publishRecordedCodexWake(namespaceDir, handoff, event);
		if (outcome === "thread_active_pending" || outcome === "failed") return;
	}
}

function codexWakeTailKey(namespaceDir: string, threadId: string): string {
	return `${namespaceDir}\0${threadId}`;
}

function enqueueCodexWakePublish(namespaceDir: string, handoff: CodexHandoffRegistrationV1): void {
	const tailKey = codexWakeTailKey(namespaceDir, handoff.thread_id);
	const previous = codexWakePublishTails.get(tailKey) ?? Promise.resolve();
	const next = previous
		.catch(async error => {
			await appendCodexWakeDiagnostic(
				namespaceDir,
				{ id: `wake-queue:${handoff.thread_id}` } as CoordinatorEvent,
				error,
			);
		})
		.then(() => publishPendingCodexWakes(namespaceDir, handoff.thread_id));
	codexWakePublishTails.set(tailKey, next);
	void next
		.catch(() => undefined)
		.finally(() => {
			if (codexWakePublishTails.get(tailKey) === next) codexWakePublishTails.delete(tailKey);
		});
}

/** Test-only helper that waits for queued Codex wake publishes in a namespace. */
export async function awaitCodexWakePublishesForTest(namespaceDir: string): Promise<void> {
	await Promise.all(
		[...codexWakePublishTails.entries()]
			.filter(([key]) => key.startsWith(`${namespaceDir}\0`))
			.map(([, tail]) => tail),
	);
}

async function appendCoordinatorEvent(
	namespaceDir: string,
	input: CoordinatorEventInput & { stableId?: string },
	options: { signal?: AbortSignal } = {},
): Promise<CoordinatorEvent> {
	const previous = eventAppendQueues.get(namespaceDir) ?? Promise.resolve();
	const current = Promise.withResolvers<void>();
	const queued = previous.then(
		() => current.promise,
		() => current.promise,
	);
	eventAppendQueues.set(namespaceDir, queued);
	await previous.catch(() => undefined);
	let event: CoordinatorEvent | null = null;
	try {
		await ensureDir(eventsDir(namespaceDir));
		await withFileLock(
			path.join(eventsDir(namespaceDir), "event-journal.lock"),
			async () => {
				const cachedSeq = asRecord(await readJsonFile(eventSequenceFile(namespaceDir)));
				let watermark =
					cachedSeq &&
					typeof cachedSeq.seq === "number" &&
					Number.isSafeInteger(cachedSeq.seq) &&
					cachedSeq.seq >= 0
						? cachedSeq.seq
						: null;
				const stat = await fs.stat(eventJournalFile(namespaceDir)).catch(() => null);
				if (
					watermark === null ||
					(stat &&
						((stat.size === 0 && watermark > 0) ||
							(stat.size > 0 && (await readJournalTail(namespaceDir))?.seq !== watermark)))
				) {
					const snapshot = await readJournalSnapshotLocked(namespaceDir);
					watermark = snapshot.watermark;
				}
				if (watermark === null) throw new Error("event_journal_corrupt");
				if (input.stableId) {
					let stableIndex = asRecord(await readJsonFile(eventStableIndexFile(namespaceDir, input.stableId)));
					let priorOffset =
						stableIndex && typeof stableIndex.offset === "number" && Number.isSafeInteger(stableIndex.offset)
							? stableIndex.offset
							: null;
					if (priorOffset !== null) {
						const prior = await readJournalEventAtOffset(namespaceDir, priorOffset);
						if (prior?.id === input.stableId) {
							event = prior;
							return;
						}
					}
					// The legacy map is consulted only during its one-time migration. Once
					// retired, a missing sidecar is recovered from the complete journal.
					const migration = asRecord(await readJsonFile(eventJournalIndexMigrationFile(namespaceDir)));
					if (migration?.schema_version !== 1) {
						await readJournalSnapshotLocked(namespaceDir);
						stableIndex = asRecord(await readJsonFile(eventStableIndexFile(namespaceDir, input.stableId)));
						priorOffset =
							stableIndex && typeof stableIndex.offset === "number" && Number.isSafeInteger(stableIndex.offset)
								? stableIndex.offset
								: null;
						if (priorOffset !== null) {
							const prior = await readJournalEventAtOffset(namespaceDir, priorOffset);
							if (prior?.id === input.stableId) {
								event = prior;
								return;
							}
						}
					}
					const recovered = await readJournalStableId(namespaceDir, input.stableId);
					if (recovered) {
						await writeJournalJsonAtomic(eventStableIndexFile(namespaceDir, input.stableId), {
							seq: recovered.event.seq,
							offset: recovered.offset,
						});
						event = recovered.event;
						return;
					}
				}
				const seq = watermark + 1;
				const timestamp = new Date().toISOString();
				event = {
					schema_version: 1,
					seq,
					id: input.stableId ?? `event-${seq.toString().padStart(12, "0")}`,
					timestamp,
					kind: input.kind,
					summary: boundSummary(input.summary),
					...(input.sessionId ? { session_id: input.sessionId } : {}),
					...(input.turnId ? { turn_id: input.turnId } : {}),
					...(input.questionId ? { question_id: input.questionId } : {}),
					...(input.reportId ? { report_id: input.reportId } : {}),
					...(input.payloadRef ? { payload_ref: input.payloadRef } : {}),
					...(input.metadata ? { metadata: input.metadata } : {}),
				};
				const currentSize = await fs
					.stat(eventJournalFile(namespaceDir))
					.then(value => value.size)
					.catch(() => 0);
				const handle = await fs.open(eventJournalFile(namespaceDir), "a", 0o600);
				try {
					await handle.writeFile(`${JSON.stringify(event)}\n`);
					await handle.sync();
				} finally {
					await handle.close();
				}
				if (input.stableId)
					await writeJournalJsonAtomic(eventStableIndexFile(namespaceDir, input.stableId), {
						seq,
						offset: currentSize,
					});
				await writeJournalJsonAtomic(eventSequenceFile(namespaceDir), { seq, updated_at: timestamp });
			},
			options.signal ? { signal: options.signal } : undefined,
		);
		if (!event) throw new Error("event_journal_corrupt");
		const persistedEvent = event as CoordinatorEvent;
		let codexWake: { handoff: CodexHandoffRegistrationV1; event: CodexWakeEventV1 | null } | null;
		try {
			codexWake = await maybeRecordCodexWake(namespaceDir, persistedEvent);
		} catch (error) {
			try {
				await appendCodexWakeDiagnostic(namespaceDir, persistedEvent, error);
			} catch (diagnosticError) {
				// The canonical event is already durable. Preserve that committed
				// result even when the optional diagnostic cannot be persisted.
				logger.warn("Coordinator Codex wake diagnostic persistence failed", {
					eventId: persistedEvent.id,
					error: String(diagnosticError),
				});
			}
			codexWake = null;
		}
		if (codexWake) enqueueCodexWakePublish(namespaceDir, codexWake.handoff);
		if (eventWebhookConfigs.has(namespaceDir)) enqueueEventWebhook(namespaceDir, persistedEvent);
		return persistedEvent;
	} finally {
		current.resolve();
		if (eventAppendQueues.get(namespaceDir) === queued) eventAppendQueues.delete(namespaceDir);
	}
}
/** Test-only event injection for coordinator wake-pipeline coverage. */
export async function appendCoordinatorEventForTest(
	namespaceDir: string,
	input: CoordinatorEventInput & { stableId?: string },
): Promise<CoordinatorEvent> {
	return appendCoordinatorEvent(namespaceDir, input);
}

function boundedEventLimit(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 100;
	return Math.min(parsed, 100);
}

function eventTypeFilter(value: unknown): Set<string> | null {
	if (!Array.isArray(value)) return null;
	const types = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return types.length > 0 ? new Set(types) : null;
}

function eventCursor(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new SdkClientError("invalid_input", "after_seq must be a non-negative integer.");
	return value;
}

function filterCoordinatorEvents(
	events: CoordinatorEvent[],
	afterSeq: number,
	args: Record<string, unknown>,
	limit: number,
): CoordinatorEvent[] {
	const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
	const eventTypes = eventTypeFilter(args.event_types);
	return events
		.filter(event => event.seq > afterSeq)
		.filter(event => !sessionId || event.session_id === sessionId)
		.filter(event => !eventTypes || eventTypes.has(event.kind))
		.slice(0, limit);
}

function eventSummaries(
	events: CoordinatorEvent[],
): Array<
	Pick<
		CoordinatorEvent,
		"seq" | "id" | "timestamp" | "kind" | "session_id" | "turn_id" | "question_id" | "report_id" | "summary"
	>
> {
	return events.map(event => {
		const publicEvent = publicCoordinatorEvent(event);
		return {
			seq: publicEvent.seq,
			id: publicEvent.id,
			timestamp: publicEvent.timestamp,
			kind: publicEvent.kind,
			...(publicEvent.session_id ? { session_id: publicEvent.session_id } : {}),
			...(publicEvent.turn_id ? { turn_id: publicEvent.turn_id } : {}),
			...(publicEvent.question_id ? { question_id: publicEvent.question_id } : {}),
			...(publicEvent.report_id ? { report_id: publicEvent.report_id } : {}),
			summary: publicEvent.summary,
		};
	});
}

function safeExternalId(kind: "session" | "question", value: unknown): string {
	const pattern = kind === "session" ? COORDINATOR_SESSION_ID_PATTERN : SAFE_EXTERNAL_ID_PATTERN;
	if (typeof value !== "string" || !pattern.test(value)) throw new Error(`invalid_${kind}_id`);
	return value;
}

function safeTurnId(value: unknown): string {
	if (typeof value !== "string" || !TURN_ID_PATTERN.test(value)) throw new Error("invalid_turn_id");
	return value;
}

function safeTmuxSessionName(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
		throw new Error("invalid_tmux_session");
	}
	return value;
}

function safeTmuxTarget(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,160}$/.test(value)) {
		throw new Error("invalid_tmux_target");
	}
	return value;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function turnsDir(namespaceDir: string): string {
	return path.join(namespaceDir, "turns");
}

function activeTurnFile(namespaceDir: string, sessionId: string): string {
	return path.join(namespaceDir, "active-turns", `${safeExternalId("session", sessionId)}.json`);
}

function turnFile(namespaceDir: string, turnId: string): string {
	return path.join(turnsDir(namespaceDir), `${safeTurnId(turnId)}.json`);
}

function sessionStateFile(namespaceDir: string, sessionId: string): string {
	return path.join(namespaceDir, "session-states", `${safeExternalId("session", sessionId)}.json`);
}

async function readTurnRecord(namespaceDir: string, turnId: unknown): Promise<TurnRecord | null> {
	return (await readJsonFile(turnFile(namespaceDir, safeTurnId(turnId)))) as TurnRecord | null;
}

function turnEventKind(status: TurnStatus): CoordinatorEventKind | null {
	if (status === "queued") return "turn.queued";
	if (status === "delivering") return "turn.delivering";
	if (status === "active") return "turn.active";
	if (status === "waiting_for_answer") return "turn.waiting_for_answer";
	if (status === "completed") return "turn.completed";
	if (status === "failed") return "turn.failed";
	if (status === "cancelled") return "turn.cancelled";
	if (status === "superseded") return "turn.superseded";
	return null;
}

async function writeTurnRecord(namespaceDir: string, turn: TurnRecord): Promise<void> {
	await writeJsonFile(turnFile(namespaceDir, turn.turn_id), turn);
	// Public lifecycle rows are emitted from canonical outbox intents only. Legacy
	// projection writes must never allocate a second journal sequence.
}

async function readActiveTurn(namespaceDir: string, sessionId: string): Promise<TurnRecord | null> {
	const active = asRecord(await readJsonFile(activeTurnFile(namespaceDir, sessionId)));
	if (!active || typeof active.turn_id !== "string") return null;
	const turn = await readTurnRecord(namespaceDir, active.turn_id);
	if (!turn || turn.session_id !== sessionId || !ACTIVE_TURN_STATUSES.has(turn.status)) return null;
	return turn;
}

async function writeActiveTurn(namespaceDir: string, turn: TurnRecord): Promise<void> {
	await writeJsonFile(activeTurnFile(namespaceDir, turn.session_id), {
		session_id: turn.session_id,
		turn_id: turn.turn_id,
		status: turn.status,
		updated_at: turn.updated_at,
	});
}

async function readSessionState(namespaceDir: string, sessionId: string): Promise<CoordinatorSessionState | null> {
	return (await readJsonFile(sessionStateFile(namespaceDir, sessionId))) as CoordinatorSessionState | null;
}

async function writeSessionStateUnlocked(
	namespaceDir: string,
	sessionId: string,
	state: CoordinatorSessionStateValue,
	options: {
		currentTurnId?: string | null;
		lastTurnId?: string | null;
		live?: boolean | null;
		reason?: string | null;
		source?: CoordinatorSessionState["source"];
		/** Rebuild the lifecycle fields from canonical state instead of the previous projection. */
		overwrite?: boolean;
	} = {},
): Promise<CoordinatorSessionState> {
	const persisted = await readSessionState(namespaceDir, sessionId);
	// An overwrite is a canonical lifecycle repair, not proof that tool activity ended.
	const previous = options.overwrite ? null : persisted;
	const hasCurrentTurn = Object.hasOwn(options, "currentTurnId");
	const hasLastTurn = Object.hasOwn(options, "lastTurnId");
	const hasLive = Object.hasOwn(options, "live");
	if (
		previous?.source === "agent_session_event" &&
		typeof previous.sidecar_signature === "string" &&
		options.source === "agent_session_event" &&
		state === previous.state &&
		(!hasCurrentTurn || (options.currentTurnId ?? null) === previous.current_turn_id) &&
		(!hasLastTurn || (options.lastTurnId ?? null) === previous.last_turn_id) &&
		(!hasLive || (options.live ?? null) === previous.live) &&
		(options.reason ?? null) === (previous.reason ?? null)
	)
		return previous;
	const updatedAt = new Date().toISOString();
	// A coordinator write says nothing about tool activity, so every lifecycle path —
	// including canonical repair — carries the sidecar's snapshot and its sequence
	// forward. A TERMINAL lifecycle state is the one exception: it is authority that
	// nothing can still be running, so it settles orphaned in-flight calls through the
	// exact helper the runtime uses. A malformed snapshot is preserved verbatim rather
	// than reset to a lower sequence; the public projection refuses to publish it either way.
	const terminal = state === "completed" || state === "errored";
	const activity = terminal
		? terminallySettledRuntimeToolActivity(persisted?.activity, updatedAt)
		: classifyRuntimeToolActivity(persisted?.activity);
	const isTerminalState = state === "completed" || state === "errored" || state === "stale";
	const endedAt = isTerminalState
		? updatedAt
		: typeof persisted?.ended_at === "string" && Number.isFinite(Date.parse(persisted.ended_at))
			? persisted.ended_at
			: undefined;
	// A terminal sidecar carries the runtime's completion receipt alongside the
	// lifecycle marker. Projection repair rewrites the shared state file through
	// this coordinator helper, so retain those sidecar-owned fields until the
	// canonical terminal fence consumes them. Dropping final_response here turns a
	// valid completed receipt into the indistinguishable "receipt missing" case.
	const persistedRuntime = persisted as RuntimeSessionStatePayload | null;
	const persistedRuntimeFields = (persistedRuntime ?? {}) as Record<string, unknown>;
	const preserveTerminalSidecar = Boolean(
		persistedRuntime?.source === "agent_session_event" &&
			(persistedRuntime.state === "completed" || persistedRuntime.state === "errored") &&
			(state === "completed" || state === "errored"),
	);
	const terminalSidecarFields = preserveTerminalSidecar
		? {
				...(Object.hasOwn(persistedRuntimeFields, "final_response")
					? { final_response: persistedRuntimeFields.final_response }
					: {}),
				...(Object.hasOwn(persistedRuntimeFields, "error") ? { error: persistedRuntimeFields.error } : {}),
				...(Object.hasOwn(persistedRuntimeFields, "execution_state")
					? { execution_state: persistedRuntimeFields.execution_state }
					: {}),
				...(Object.hasOwn(persistedRuntimeFields, "receipt_state")
					? { receipt_state: persistedRuntimeFields.receipt_state }
					: {}),
			}
		: {};
	const payload = {
		schema_version: 1,
		session_id: sessionId,
		state,
		ready_for_input: state === "ready_for_input",
		current_turn_id: hasCurrentTurn
			? (options.currentTurnId ?? null)
			: state === "running"
				? (previous?.current_turn_id ?? null)
				: null,
		last_turn_id: hasLastTurn ? (options.lastTurnId ?? null) : (previous?.last_turn_id ?? null),
		updated_at: updatedAt,
		source: options.source ?? "coordinator",
		live: hasLive ? (options.live ?? null) : (previous?.live ?? null),
		reason: options.reason ?? null,

		...(endedAt !== undefined ? { ended_at: endedAt } : {}),
		...(activity.kind === "absent"
			? {}
			: { activity: activity.kind === "valid" ? activity.activity : persisted?.activity }),
		...terminalSidecarFields,
	};
	await writeJsonFile(sessionStateFile(namespaceDir, sessionId), payload);
	return payload as CoordinatorSessionState;
}

/**
 * Serialize a coordinator state mutation on the same lock the runtime sidecar takes.
 *
 * Both writers contend for `<file>.lock`, so they must use one implementation and one
 * on-disk owner format. That format is the base Coordinator's regular-file owner JSON,
 * now shared: a directory-style lock here would make a base-version `<file>.lock` regular
 * file permanently unusable (`ENOTDIR` on `<file>.lock/info`), stranding the session. The
 * base runtime did use a directory at this path, so the shared implementation reclaims
 * that shape too. Live owners are waited for; dead and malformed ones are reclaimed by
 * that implementation's own liveness and staleness checks.
 */
async function withSessionStateLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await withSessionStateFileLock(stateFile, operation);
	} catch (error) {
		if (error instanceof SessionStateLockUnavailableError) throw new Error("coordinator_state_unreadable");
		throw error;
	}
}

async function writeSessionState(
	namespaceDir: string,
	sessionId: string,
	state: CoordinatorSessionStateValue,
	options: {
		currentTurnId?: string | null;
		lastTurnId?: string | null;
		live?: boolean | null;
		reason?: string | null;
		source?: CoordinatorSessionState["source"];
		overwrite?: boolean;
		emitEvent?: boolean;
		endpointIncarnation?: string;
	} = {},
): Promise<CoordinatorSessionState> {
	const file = sessionStateFile(namespaceDir, sessionId);
	let changed = false;
	const payload = await withSessionStateLock(file, async () => {
		const previous = await readSessionState(namespaceDir, sessionId);
		const next = await writeSessionStateUnlocked(namespaceDir, sessionId, state, options);
		changed =
			!previous ||
			previous.state !== next.state ||
			previous.current_turn_id !== next.current_turn_id ||
			previous.last_turn_id !== next.last_turn_id ||
			previous.live !== next.live ||
			previous.reason !== next.reason;
		return next;
	});
	if (options.emitEvent !== false && changed) {
		await appendCoordinatorEvent(namespaceDir, {
			kind: "session.state_changed",
			sessionId,
			turnId: payload.current_turn_id ?? payload.last_turn_id,
			summary: `Session ${sessionId} state changed to ${payload.state}`,
			metadata: {
				state: payload.state,
				ready_for_input: payload.ready_for_input,
				live: payload.live,
				reason: payload.reason,
				...(options.endpointIncarnation ? { endpoint_incarnation: options.endpointIncarnation } : {}),
			},
		});
	}
	return payload;
}

async function markTurnFailedForUnavailableSession(turn: TurnRecord, reason: string): Promise<TurnRecord> {
	const timestamp = new Date().toISOString();
	const failed: TurnRecord = {
		...turn,
		status: "failed",
		final_response: {
			text: `Coordinator session unavailable: ${reason}`,
			format: "markdown",
			source: "coordinator_liveness",
			artifact_path: null,
			truncated: false,
		},
		evidence: turn.evidence,
		error: { code: "session_unavailable", message: reason, recoverable: true },
		liveness: { checked_at: timestamp, live: false, reason },
		updated_at: timestamp,
		completed_at: timestamp,
	};
	return failed;
}

async function markTurnTerminalFromSessionState(
	turn: TurnRecord,
	sessionState: CoordinatorSessionState,
): Promise<TurnRecord> {
	const receiptState = reduceTerminalReceiptState({
		execution: sessionState.state === "errored" ? "failed" : "completed",
		reportable: reportableFinalResponse((sessionState as RuntimeSessionStatePayload).final_response),
	});
	const terminalStatus: TurnStatus =
		receiptState.receipt === "missing" ? "failed" : sessionState.state === "errored" ? "failed" : "completed";
	const runtimeState = sessionState as RuntimeSessionStatePayload;
	const finalResponse = runtimeState.final_response ?? {
		text: null,
		format: "markdown" as const,
		source: "runtime_state",
		artifact_path: null,
		truncated: false,
	};
	const timestamp = new Date().toISOString();
	const resolved: TurnRecord = {
		...turn,
		status: terminalStatus,
		delivery: {
			...turn.delivery,
			prompt_acknowledged: true,
			state: "acknowledged",
		},
		final_response: finalResponse,
		evidence: turn.evidence,
		error:
			receiptState.receipt === "missing"
				? {
						code: "receipt_missing",
						message: "Runtime completed without reportable final_response text or artifact_path.",
						recoverable: true,
					}
				: terminalStatus === "failed"
					? {
							code: "runtime_errored",
							message: "Runtime turn failed.",
							recoverable: true,
						}
					: null,
		updated_at: timestamp,
		completed_at: timestamp,
	};
	return resolved;
}

function hasAcceptedRuntimeReceipt(turn: { delivery?: unknown } | null | undefined): boolean {
	const delivery = asRecord(turn?.delivery);
	const commandId = delivery?.runtime_command_id;
	const runtimeTurnId = delivery?.runtime_turn_id;
	return (
		delivery?.prompt_acknowledged === true &&
		delivery.state === "acknowledged" &&
		typeof commandId === "string" &&
		SAFE_EXTERNAL_ID_PATTERN.test(commandId) &&
		typeof runtimeTurnId === "string" &&
		SAFE_EXTERNAL_ID_PATTERN.test(runtimeTurnId)
	);
}

function runtimeStateAcknowledgesTurn(turn: TurnRecord, sessionState: CoordinatorSessionState | null): boolean {
	return (
		sessionState?.source === "agent_session_event" &&
		sessionState.current_turn_id === turn.turn_id &&
		(sessionState.state === "running" ||
			sessionState.state === "needs_user_input" ||
			sessionState.state === "completed" ||
			sessionState.state === "errored")
	);
}

async function markTurnAcknowledgedFromRuntimeState(
	namespaceDir: string,
	turn: TurnRecord,
	sessionState: CoordinatorSessionState,
): Promise<TurnRecord> {
	if (turn.delivery.prompt_acknowledged === true && turn.delivery.state === "acknowledged") return turn;
	const timestamp = new Date().toISOString();
	const acknowledged: TurnRecord = {
		...turn,
		delivery: {
			...turn.delivery,
			delivered: true,
			prompt_acknowledged: true,
			state: "acknowledged",
			attempts: [
				...turn.delivery.attempts,
				{
					delivered: true,
					created_at: sessionState.updated_at,
					reason: "runtime_prompt_acknowledged",
					channel: "runtime_ack",
					tmux_keys_sent: turn.delivery.tmux_keys_sent,
				},
			],
		},
		updated_at: timestamp,
	};
	await writeTurnRecord(namespaceDir, acknowledged);
	await writeActiveTurn(namespaceDir, acknowledged);
	return acknowledged;
}

function turnAwaitingRuntimeAckExpired(turn: TurnRecord, nowMs: number, ackTimeoutMs: number): boolean {
	if (!ACTIVE_TURN_STATUSES.has(turn.status)) return false;
	if (turn.delivery.tmux_keys_sent !== true) return false;
	if (turn.delivery.prompt_acknowledged === true) return false;
	if (turn.delivery.state !== "tmux_keys_sent") return false;
	const deliveredAt =
		turn.delivery.attempts.findLast(attempt => attempt.channel === "tmux_keys")?.created_at ?? turn.updated_at;
	const deliveredMs = Date.parse(deliveredAt);
	return Number.isFinite(deliveredMs) && nowMs - deliveredMs >= ackTimeoutMs;
}

async function markTurnFailedForUnacknowledgedDelivery(turn: TurnRecord, ackTimeoutMs: number): Promise<TurnRecord> {
	const timestamp = new Date().toISOString();
	const message = `Tmux key delivery succeeded, but the GJC runtime did not acknowledge the prompt or emit turn_start within ${ackTimeoutMs}ms. The turn never started; stop waiting and inspect/retry the coordinator session.`;
	const failed: TurnRecord = {
		...turn,
		status: "failed",
		delivery: {
			...turn.delivery,
			delivered: false,
			queued: false,
			prompt_acknowledged: false,
			state: "unacknowledged",
			attempts: [
				...turn.delivery.attempts,
				{
					delivered: false,
					created_at: timestamp,
					reason: PROMPT_ACK_TIMEOUT_REASON,
					channel: "runtime_ack",
					tmux_keys_sent: true,
				},
			],
		},
		final_response: {
			text: message,
			format: "markdown",
			source: "coordinator_delivery_ack_timeout",
			artifact_path: null,
			truncated: false,
		},
		error: { code: PROMPT_ACK_TIMEOUT_REASON, message, recoverable: true },
		evidence: [
			...turn.evidence,
			{
				type: PROMPT_ACK_TIMEOUT_REASON,
				message,
				tmux_keys_sent: true,
				prompt_acknowledged: false,
				created_at: timestamp,
			},
		],
		liveness: { checked_at: timestamp, live: turn.liveness.live, reason: PROMPT_ACK_TIMEOUT_REASON },
		updated_at: timestamp,
		completed_at: timestamp,
	};
	return failed;
}

async function reconcileRuntimeAcknowledgement(
	namespaceDir: string,
	turn: TurnRecord,
	sessionState: CoordinatorSessionState | null,
	ackTimeoutMs: number,
	options: {
		failOnTimeout: boolean;
		onAcknowledged?: (turn: TurnRecord) => Promise<void>;
	} = { failOnTimeout: true },
): Promise<TurnRecord> {
	if (sessionState && hasAcceptedRuntimeReceipt(turn) && runtimeStateAcknowledgesTurn(turn, sessionState)) {
		const acknowledged = await markTurnAcknowledgedFromRuntimeState(namespaceDir, turn, sessionState);
		await options.onAcknowledged?.(acknowledged);
		return acknowledged;
	}
	if (options.failOnTimeout && turnAwaitingRuntimeAckExpired(turn, Date.now(), ackTimeoutMs)) {
		return await markTurnFailedForUnacknowledgedDelivery(turn, ackTimeoutMs);
	}
	return turn;
}

function makeTurnRecord(
	config: CoordinatorMcpConfig,
	sessionId: string,
	prompt: string,
	status: TurnStatus,
): TurnRecord {
	const timestamp = new Date().toISOString();
	return {
		schema_version: 1,
		turn_id: `turn-${randomUUID()}`,
		session_id: sessionId,
		namespace: config.namespace,
		status,
		prompt: { text: prompt, created_at: timestamp, source: "mcp" },
		delivery: {
			delivered: false,
			queued: true,
			target: null,
			tmux_keys_sent: false,
			prompt_acknowledged: false,
			state: "queued",
			attempts: [],
		},
		question_ids: [],
		final_response: { text: null, format: "markdown", source: null, artifact_path: null, truncated: false },
		evidence: [],
		error: null,
		liveness: { checked_at: null, live: null, reason: null },
		created_at: timestamp,
		updated_at: timestamp,
		started_at: status === "queued" ? null : timestamp,
		completed_at: null,
	};
}

function asTerminalTurnStatus(status: unknown): TurnStatus | null {
	const normalized = String(status ?? "")
		.trim()
		.toLowerCase();
	if (TERMINAL_TURN_STATUSES.has(normalized as TurnStatus)) return normalized as TurnStatus;
	if (normalized === "blocked") return "failed";
	return null;
}

export const COORDINATOR_AWAIT_TURN_TIMEOUT_MAX_MS = 30 * 60 * 1000;
export const COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS = MAX_RUNTIME_PROMPT_ACK_TIMEOUT_MS;
export const COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS = 30_000;
export const COORDINATOR_POLL_INTERVAL_MAX_MS = 10_000;

function parsePositiveIntegerMs(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function boundedAwaitTurnTimeoutMs(value: unknown): number {
	return Math.min(parsePositiveIntegerMs(value, 1000), COORDINATOR_AWAIT_TURN_TIMEOUT_MAX_MS);
}

export function boundedRuntimePromptAckTimeoutMs(value: unknown): number {
	return Math.min(
		parsePositiveIntegerMs(value, DEFAULT_RUNTIME_PROMPT_ACK_TIMEOUT_MS),
		COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS,
	);
}

export function boundedEventWatchTimeoutMs(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (parsed === 0) return 0;
	return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 1000, COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS);
}

export function boundedPollIntervalMs(value: unknown): number {
	return Math.min(Math.max(parsePositiveIntegerMs(value, 100), 10), COORDINATOR_POLL_INTERVAL_MAX_MS);
}

function boundedLineCount(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 80;
	return Math.min(parsed, 400);
}

function waitForTurnStateChange(namespaceDir: string, turn: TurnRecord, timeoutMs: number): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	const watchers: nodeFs.FSWatcher[] = [];
	const watchedFiles = new Map<string, Set<string>>([
		[turnsDir(namespaceDir), new Set([`${turn.turn_id}.json`])],
		[path.join(namespaceDir, "active-turns"), new Set([`${turn.session_id}.json`])],
		[path.join(namespaceDir, "session-states"), new Set([`${turn.session_id}.json`])],
	]);
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		for (const watcher of watchers) watcher.close();
		clearTimeout(timer);
		deferred.resolve();
	};
	const timer = setTimeout(finish, Math.max(timeoutMs, 0));
	timer.unref?.();

	for (const [dir, filenames] of watchedFiles) {
		try {
			const watcher = nodeFs.watch(dir, (_eventType, filename) => {
				if (typeof filename === "string" && filenames.has(filename)) finish();
			});
			watchers.push(watcher);
		} catch {
			// Directory may not exist yet; the timeout remains a bounded fallback.
		}
	}

	return deferred.promise;
}

async function waitForCoordinatorEvents(namespaceDir: string, timeoutMs: number): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	const watchers: nodeFs.FSWatcher[] = [];
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		for (const watcher of watchers) watcher.close();
		clearTimeout(timer);
		deferred.resolve();
	};
	const timer = setTimeout(finish, Math.max(timeoutMs, 0));
	timer.unref?.();
	const eventDir = eventsDir(namespaceDir);
	const watchedDirs = [
		eventDir,
		turnsDir(namespaceDir),
		path.join(namespaceDir, "active-turns"),
		path.join(namespaceDir, "session-states"),
	];
	for (const dir of watchedDirs) {
		await ensureDir(dir);
		try {
			const watcher = nodeFs.watch(dir, (_eventType, filename) => {
				if (dir === eventDir) {
					if (filename === "event-journal.jsonl" || filename === "latest-seq.json") finish();
					return;
				}
				if (typeof filename === "string" && filename.endsWith(".json")) finish();
			});
			watchers.push(watcher);
		} catch {
			// Directory may not be watchable on this platform; the timeout remains a bounded fallback.
		}
	}
	return deferred.promise;
}

function decodeUtf8WithinByteCap(bytes: Buffer, byteCap: number): string {
	const limit = Math.min(bytes.length, Math.max(0, byteCap));
	let index = 0;
	let validEnd = 0;
	while (index < limit) {
		const lead = bytes[index]!;
		let width = 1;
		if (lead >= 0xc2 && lead <= 0xdf) width = 2;
		else if (lead >= 0xe0 && lead <= 0xef) width = 3;
		else if (lead >= 0xf0 && lead <= 0xf4) width = 4;
		else if (lead > 0x7f) break;
		if (index + width > limit) break;
		if (width > 1) {
			const second = bytes[index + 1]!;
			if (
				second < 0x80 ||
				second > 0xbf ||
				(width === 3 && ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second > 0x9f))) ||
				(width === 4 && ((lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second > 0x8f)))
			)
				break;
			for (let offset = 2; offset < width; offset++) {
				const continuation = bytes[index + offset]!;
				if (continuation < 0x80 || continuation > 0xbf)
					return new TextDecoder().decode(bytes.subarray(0, validEnd));
			}
		}
		index += width;
		validEnd = index;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, validEnd));
}

export async function readCoordinatorArtifact(
	config: CoordinatorMcpConfig,
	args: { path: unknown },
): Promise<Record<string, unknown>> {
	let handle: fs.FileHandle | null = null;
	try {
		handle = await safeOpenCoordinatorArtifact(config, args.path);
		const readLimit = config.artifactByteCap + 1;
		const buffer = Buffer.alloc(readLimit);
		const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
		const boundedBytes = buffer.subarray(0, Math.min(bytesRead, config.artifactByteCap));
		const text = decodeUtf8WithinByteCap(boundedBytes, config.artifactByteCap);
		return {
			ok: true,
			path: typeof args.path === "string" ? path.resolve(args.path) : "",
			text,
			bytes: Buffer.byteLength(text),
			truncated: bytesRead > config.artifactByteCap,
		};
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("coordinator_artifact_outside_allowed_roots:"))
			return { ok: false, reason: "artifact_outside_allowed_roots" };
		return {
			ok: false,
			error: { code: "artifact_unavailable", message: "Coordinator artifact could not be read." },
		};
	} finally {
		await handle?.close();
	}
}

export function createCoordinatorMcpServer(options: CoordinatorMcpServerOptions = {}): CoordinatorMcpServer {
	const env = options.env ?? process.env;
	const config = buildCoordinatorMcpConfig(env);
	const promptAckTimeoutMs = boundedRuntimePromptAckTimeoutMs(env.GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS);
	const services = options.services ?? {};
	const routerAgentDir = services.getAgentDir?.() ?? getAgentDir();
	const router = new SessionRouter({ agentDir: routerAgentDir, deps: services.routerDeps });
	let routerReady: Promise<void> | null = null;
	async function ensureRouterReady(): Promise<void> {
		routerReady ??= router.start().catch(error => {
			routerReady = null;
			throw error;
		});
		await routerReady;
	}
	const platform = options.platform ?? process.platform;
	const loadModelProfiles = services.resolveModelProfiles ?? createCoordinatorModelProfileLoader(routerAgentDir);
	// Every authoritative projection is scoped by the collision-resistant namespace identity.
	const namespaceDir = coordinatorNamespacePath(config);
	// The prior human-readable directory is migration input only; it is never authority.
	const legacyNamespaceDir = path.join(
		config.stateRoot,
		config.namespace.profile ?? "unscoped-profile",
		config.namespace.repo ?? "unscoped-repo",
	);
	const questionPaths = coordinatorStatePaths(config.stateRoot, config.namespace.identity);
	codexWakeTransportFactories.set(
		namespaceDir,
		services.codexTransportFactory ?? createDefaultCodexTransportFactory(),
	);
	let eventWebhookConfig: EventWebhookConfig | null;
	try {
		// `env` here may be the merged process environment, which Bun has
		// already loaded the cwd `.env` overlay into; that is not a trusted
		// source for an egress destination. Only an explicitly provided
		// operator env (rendered hermes block, tests) may select it.
		eventWebhookConfig = parseEventWebhookConfig(options.env);
	} catch (error) {
		// Fail closed: an invalid webhook config disables delivery rather than
		// crashing the whole coordinator bridge. `gjc coordinator doctor`
		// surfaces the same error as a failing check.
		eventWebhookConfig = null;
		const reason = error instanceof Error ? error.message : "coordinator_event_webhook_invalid";
		const diagnostic = (async () => {
			try {
				await fs.mkdir(namespaceDir, { recursive: true });
				await fs.appendFile(
					path.join(namespaceDir, "event-webhook-errors.log"),
					`${new Date().toISOString()} config_error=${reason}\n`,
					{ mode: 0o600 },
				);
			} catch {
				// Diagnostics are best-effort; delivery stays disabled either way.
			}
		})();
		eventWebhookTails.set(namespaceDir, diagnostic);
	}
	eventWebhookConfigs.set(namespaceDir, eventWebhookConfig);
	eventWebhookDeliveries.set(namespaceDir, services.eventWebhookDelivery ?? createDefaultEventWebhookDelivery());
	const startupEventWebhookReplay = (async () => {
		if (eventWebhookConfig === null) return;
		try {
			for (const event of (await readJournalSnapshot(namespaceDir)).events) enqueueEventWebhook(namespaceDir, event);
			await awaitEventWebhookDeliveries(namespaceDir);
		} catch (error) {
			await appendEventWebhookDiagnostic(namespaceDir, "startup-replay", error);
		}
	})();
	eventWebhookStartupTails.set(namespaceDir, startupEventWebhookReplay);
	void startupEventWebhookReplay.finally(() => {
		if (eventWebhookStartupTails.get(namespaceDir) === startupEventWebhookReplay)
			eventWebhookStartupTails.delete(namespaceDir);
	});
	const startupCodexWakeReplay = (async () => {
		try {
			for (const handoff of await listCodexHandoffs(namespaceDir)) {
				enqueueCodexWakePublish(namespaceDir, handoff);
				await awaitCodexWakePublishesForTest(namespaceDir);
			}
		} catch (error) {
			await appendCodexWakeDiagnostic(namespaceDir, { id: "startup-drain" }, error);
			throw error;
		}
	})();
	// Startup replay is optional. Keep its rejection observable to callers that
	// explicitly await the replay, but never let an unhandled replay rejection
	// gate canonical question-state initialization.
	void startupCodexWakeReplay.catch(() => undefined);
	let questionStateReady: Promise<void> | null = null;
	let delegatePinRecovery: Promise<void> | null = null;
	let delegatePinCursor: { sessionId: string; promptKey: string | null } | null = null;

	async function ensureQuestionStateReady(): Promise<void> {
		questionStateReady ??= initializeCoordinatorNamespace(questionPaths);
		await questionStateReady;
		delegatePinRecovery ??= reconcileCompletedDelegateResponsePins().finally(() => {
			delegatePinRecovery = null;
		});
		try {
			await delegatePinRecovery;
		} catch (error) {
			// Pin cleanup is maintenance after a durable response commit. Keep the
			// server available, but leave recovery incomplete so the next call retries.
			logger.warn("Coordinator delegate response pin recovery failed", { error: String(error) });
		}
	}

	let retainedDeliveryRecovery: Promise<void> | null = null;
	async function exportRetainedDeliveries(limit = 32, signal?: AbortSignal): Promise<void> {
		// Recovery is lazy and single-flight. Do not start a detached startup pass:
		// callers must observe the current registry under the same lock, and a detached
		// pass can outlive a server/test namespace and touch a removed root.
		if (retainedDeliveryRecovery) return await retainedDeliveryRecovery;
		const operation = (async () => {
			await ensureQuestionStateReady();
			// Delivery discovery is a bounded registry round-robin, not a global
			// lexical high-water cursor: new intents can appear in earlier sessions.
			const storedDiscoveryCursor = await readDeliveryDiscoveryCursor(questionPaths, { signal });
			const discoveryCursor = storedDiscoveryCursor.startsWith("@session:") ? storedDiscoveryCursor : "@session:";
			const discovered = await enumeratePublicDeliveries(questionPaths, discoveryCursor, limit, { signal });
			for (const [claimIndex, claim] of discovered.claims.entries()) {
				try {
					if (signal?.aborted) throw signal.reason ?? new Error("aborted");
					const payload = claim.event.payload;
					const kind = claim.event.kind as CoordinatorEventKind;
					const event = await appendCoordinatorEvent(
						namespaceDir,
						{
							stableId: claim.event.public_event_id,
							kind,
							sessionId: typeof payload.session_id === "string" ? payload.session_id : claim.session_id,
							turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
							questionId: typeof payload.question_id === "string" ? payload.question_id : null,
							reportId: typeof payload.report_id === "string" ? payload.report_id : null,
							summary: "Coordinator event recorded.",
							metadata: claim.endpoint_incarnation
								? { endpoint_incarnation: claim.endpoint_incarnation }
								: undefined,
						},
						{ signal },
					);
					await acknowledgePublicDelivery(
						questionPaths,
						claim.session_id,
						{
							public_event_id: claim.event.public_event_id,
							claim_fence: claim.claim_fence,
							journal_seq: event.seq,
						},
						{ signal },
					);
				} catch (error) {
					await releasePublicDeliveryClaim(questionPaths, claim.session_id, {
						public_event_id: claim.event.public_event_id,
						claim_fence: claim.claim_fence,
					});
					for (const pending of discovered.claims.slice(claimIndex + 1))
						await releasePublicDeliveryClaim(questionPaths, pending.session_id, {
							public_event_id: pending.event.public_event_id,
							claim_fence: pending.claim_fence,
						});
					throw error;
				}
			}
			// Advance once for every successful bounded sweep, including an empty page,
			// so inactive sessions cannot pin discovery ahead of later retained work.
			if (discovered.next_cursor)
				await advanceDeliveryDiscoveryCursor(questionPaths, discovered.next_cursor, { signal });
		})();
		const current = operation.finally(() => {
			retainedDeliveryRecovery = null;
		});
		retainedDeliveryRecovery = current;
		return await current;
	}

	function creationDigests(
		tool: string,
		idempotencyKey: string,
		canonicalArgs: Record<string, unknown>,
	): {
		keyDigest: string;
		requestDigest: string;
	} {
		return {
			keyDigest: createHash("sha256").update(`${tool}\0${idempotencyKey}`).digest("hex"),
			requestDigest: createHash("sha256")
				.update(canonicalJson({ tool, args: canonicalArgs }))
				.digest("hex"),
		};
	}

	const sidecarSigningKeys = new Map<string, string>();
	function mintSidecarVerifier(): { key_id: string; public_key: string } {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const public_key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const key_id = createHash("sha256").update(public_key).digest("hex");
		const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
		sidecarSigningKeys.set(key_id, privateKeyDer);
		return { key_id, public_key };
	}
	/** Test-only: mints a sidecar verifier whose private key stays in this server's signing map. */
	function mintSidecarSigningAuthorityForTest(): { key_id: string; public_key: string } {
		return mintSidecarVerifier();
	}

	/** Test-only: signs a runtime-sidecar payload with this server's session authority. */
	async function signRuntimeSidecarPayloadForTest(
		sessionId: string,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const session = await readJsonFile(
			path.join(namespaceDir, "sessions", `${safeExternalId("session", sessionId)}.json`),
		);
		const verifier = asRecord(asRecord(session)?.sidecar_verifier);
		const keyId = optionalString(verifier?.key_id);
		const privateKey = keyId ? sidecarSigningKeys.get(keyId) : undefined;
		if (!keyId || !privateKey) throw new Error("missing_test_sidecar_signing_authority");
		const { sidecar_signature: _signature, sidecar_key_id: _keyId, ...unsignedPayload } = payload;
		const unsigned = { ...unsignedPayload, sidecar_key_id: keyId };
		return {
			...unsigned,
			sidecar_signature: sign(null, Buffer.from(canonicalCoordinatorSidecarPayload(unsigned)), {
				key: Buffer.from(privateKey, "base64"),
				format: "der",
				type: "pkcs8",
			}).toString("base64"),
		};
	}

	function canonicalCreationSnapshot(session: Record<string, unknown>): CanonicalSessionSnapshotV1 {
		const now = new Date().toISOString();
		const sessionId = safeExternalId("session", session.session_id ?? session.sessionId);
		const cwd = optionalString(session.cwd);
		const brokerWorkspace = optionalString(session.broker_workspace);
		const incarnation = optionalString(session.endpoint_incarnation);
		if (!cwd || !brokerWorkspace || !incarnation) throw new Error("state_corrupt");
		return {
			schema_version: 1,
			namespace_id: config.namespace.identity,
			session_id: sessionId,
			// Creation flows already canonicalize cwd and bind it to this exact broker
			// workspace. Do not pass it through the host path implementation: that
			// corrupts canonical Windows paths when a cross-platform broker provides them.
			cwd,
			created_at: optionalString(session.created_at) ?? now,
			updated_at: now,
			mpreset: optionalString(session.mpreset),
			source: optionalString(session.source),
			model: optionalString(session.model),
			tmux: {
				session: optionalString(session.tmux_session),
				window: null,
				pane: optionalString(session.tmux_target),
			},
			broker: {
				workspace: brokerWorkspace,
				endpoint_url: "",
				endpoint_generation: typeof session.endpoint_generation === "number" ? session.endpoint_generation : 0,
				endpoint_incarnation: incarnation,
				sidecar_verifier:
					session.sidecar_verifier && typeof session.sidecar_verifier === "object"
						? (session.sidecar_verifier as { key_id: string; public_key: string })
						: (() => {
								throw new Error("state_corrupt");
							})(),
			},
			ephemeral: session.ephemeral === true,
			visible: session.visible !== false,
		};
	}

	function sessionFromCreationSnapshot(snapshot: CanonicalSessionSnapshotV1): Record<string, unknown> {
		return normalizeSession({
			session_id: snapshot.session_id,
			cwd: snapshot.cwd,
			created_at: snapshot.created_at,
			...(snapshot.mpreset ? { mpreset: snapshot.mpreset } : {}),
			...(snapshot.source ? { source: snapshot.source } : {}),
			...(snapshot.model ? { model: snapshot.model } : {}),
			tmux_session: snapshot.tmux.session,
			tmux_target: snapshot.tmux.pane,
			ephemeral: snapshot.ephemeral,
			visible: snapshot.visible,
			broker_workspace: snapshot.broker.workspace,
			endpoint_generation: snapshot.broker.endpoint_generation,
			endpoint_incarnation: snapshot.broker.endpoint_incarnation,
			sidecar_verifier: snapshot.broker.sidecar_verifier,
		});
	}

	async function claimProductionCreation(
		tool: string,
		idempotencyKey: string,
		canonicalArgs: Record<string, unknown>,
	) {
		await ensureQuestionStateReady();
		const { keyDigest, requestDigest } = creationDigests(tool, idempotencyKey, canonicalArgs);
		let request = await claimCreationRequest(questionPaths, {
			key_digest: keyDigest,
			request_digest: requestDigest,
			tool,
			sidecar_verifier: mintSidecarVerifier(),
		});
		const claimedKeyId = request.sidecar_verifier?.key_id;
		if (request.phase === "claimed" && (!claimedKeyId || !sidecarSigningKeys.has(claimedKeyId))) {
			const verifier = mintSidecarVerifier();
			request = await rotateClaimedCreationVerifier(questionPaths, keyDigest, claimedKeyId ?? "", verifier);
		}
		return { keyDigest, request };
	}

	/**
	 * Fence broker creation before admission. Retries deliberately present a new
	 * candidate key under the same broker idempotency key; the broker's retained
	 * response decides whether that candidate actually became runtime authority.
	 */
	async function prepareCreationBrokerCall(creation: {
		keyDigest: string;
		request: { phase: string; sidecar_verifier: { key_id: string; public_key: string } | null };
	}) {
		if (!creation.request.sidecar_verifier) throw new Error("state_corrupt");
		const retry = creation.request.phase === "remote_started";
		const persisted = await startCreationRemote(questionPaths, creation.keyDigest, creation.request.sidecar_verifier);
		if (!persisted.sidecar_verifier) throw new Error("state_corrupt");
		return { request: persisted, candidate: retry ? mintSidecarVerifier() : persisted.sidecar_verifier };
	}

	async function reconcileCreationBrokerCall(
		keyDigest: string,
		candidate: { key_id: string; public_key: string },
		created: Record<string, unknown>,
	) {
		const usedKeyId = optionalString(created.coordinatorSidecarKeyId);
		if (!usedKeyId) throw new Error("terminal_uncertain");
		return await reconcileCreationRemoteVerifier(questionPaths, keyDigest, candidate, usedKeyId);
	}

	async function readCanonicalActiveTurn(sessionId: string): Promise<TurnRecord | null> {
		const transaction = await readSessionTransaction(questionPaths, sessionId);
		if (!transaction) return null;
		const activeId = transaction.canonical.queue.active_turn_id;
		const active = activeId ? transaction.canonical.turns[activeId] : undefined;
		if (active && ACTIVE_TURN_STATUSES.has(active.status as TurnStatus)) return turnFromCanonical(active);
		const fallback = Object.values(transaction.canonical.turns).find(turn =>
			ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
		);
		return fallback ? turnFromCanonical(fallback) : null;
	}

	function legacyScopeOwned(value: Record<string, unknown>): boolean {
		const namespace = asRecord(value.namespace);
		return (
			namespace?.identity === config.namespace.identity || value.namespace_identity === config.namespace.identity
		);
	}

	function reportProjectionFile(directory: string, reportId: string): string {
		if (!COORDINATOR_REPORT_ID_PATTERN.test(reportId)) throw new Error("state_corrupt");
		const reportsDir = path.join(directory, "reports");
		const file = path.resolve(reportsDir, `${reportId}.json`);
		if (path.dirname(file) !== path.resolve(reportsDir)) throw new Error("state_corrupt");
		return file;
	}

	async function readLegacyProjectionImport(sessionId: string): Promise<LegacyProjectionImportV1> {
		const legacySession = asRecord(
			await readJsonFile(path.join(legacyNamespaceDir, "sessions", `${sessionId}.json`)),
		);
		if (!legacySession || !legacyScopeOwned(legacySession)) throw new Error("legacy_projection_quarantined");
		const turns = await listJsonFiles(turnsDir(legacyNamespaceDir));
		const importedTurns: LegacyProjectionImportV1["turns"] = {};
		for (const value of turns) {
			const turn = asRecord(value);
			if (turn?.session_id !== sessionId) continue;
			if (
				!legacyScopeOwned(turn) ||
				turn.schema_version !== 1 ||
				typeof turn.turn_id !== "string" ||
				!TURN_ID_PATTERN.test(turn.turn_id) ||
				(!ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus) &&
					turn.status !== "queued" &&
					!TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus)) ||
				!asRecord(turn.prompt) ||
				!asRecord(turn.delivery) ||
				!Array.isArray(turn.question_ids) ||
				!asRecord(turn.final_response) ||
				!Array.isArray(turn.evidence) ||
				!asRecord(turn.liveness) ||
				typeof turn.created_at !== "string" ||
				typeof turn.updated_at !== "string"
			)
				throw new Error("legacy_projection_quarantined");
			// A legacy directory can contain multiple projections for the same turn;
			// never let filename iteration choose an authority implicitly.
			if (importedTurns[turn.turn_id]) throw new Error("legacy_projection_quarantined");
			importedTurns[turn.turn_id] = {
				...(turn as unknown as LegacyProjectionImportV1["turns"][string]),
				namespace_id: config.namespace.identity,
				terminal_fence: TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus)
					? { epoch: 1, status: String(turn.status), reason: null, at: String(turn.updated_at) }
					: null,
			};
		}
		const active = asRecord(await readJsonFile(activeTurnFile(legacyNamespaceDir, sessionId)));
		if (active && !legacyScopeOwned(active)) throw new Error("legacy_projection_quarantined");
		const activeId = active?.turn_id;
		if (activeId !== undefined && (typeof activeId !== "string" || !importedTurns[activeId]))
			throw new Error("legacy_projection_quarantined");
		const activeTurn = typeof activeId === "string" ? importedTurns[activeId] : undefined;
		if (activeTurn && !ACTIVE_TURN_STATUSES.has(activeTurn.status as TurnStatus))
			throw new Error("legacy_projection_quarantined");
		const activeCandidates = Object.values(importedTurns).filter(turn =>
			ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
		);
		if (activeCandidates.length > 1 || (activeCandidates.length === 1 && activeCandidates[0] !== activeTurn))
			throw new Error("legacy_projection_quarantined");
		const state = await readSessionState(legacyNamespaceDir, sessionId);
		if (state && (state.session_id !== sessionId || !legacyScopeOwned(state as unknown as Record<string, unknown>)))
			throw new Error("legacy_projection_quarantined");
		const provenance = activeTurn ? asRecord(activeTurn.runtime_provenance) : null;
		const runtimeCommandId = activeTurn?.delivery.runtime_command_id;
		const runtimeTurnId = activeTurn?.delivery.runtime_turn_id;
		const validatedWaitingImport =
			activeTurn?.status === "active" &&
			state?.schema_version === 1 &&
			state.source === "agent_session_event" &&
			state.live === true &&
			state.state === "needs_user_input" &&
			state.current_turn_id === activeTurn.turn_id &&
			Number.isFinite(Date.parse(state.updated_at)) &&
			hasAcceptedRuntimeReceipt(activeTurn) &&
			typeof runtimeTurnId === "string" &&
			activeTurn.question_ids.length > 0 &&
			activeTurn.question_ids.every(questionId => typeof questionId === "string" && questionId.length > 0) &&
			provenance?.namespace_id === config.namespace.identity &&
			provenance.session_id === sessionId &&
			provenance.coordinator_turn_id === activeTurn.turn_id &&
			provenance.runtime_turn_id === runtimeTurnId &&
			typeof provenance.endpoint_incarnation === "string" &&
			provenance.endpoint_incarnation.length > 0 &&
			typeof provenance.gate_created_at === "string" &&
			Number.isFinite(Date.parse(provenance.gate_created_at)) &&
			typeof provenance.schema_hash === "string" &&
			provenance.schema_hash.length > 0 &&
			typeof provenance.stage === "string" &&
			provenance.stage.length > 0 &&
			typeof provenance.kind === "string" &&
			provenance.kind.length > 0;
		const importedPromptRequests: LegacyProjectionImportV1["requests"]["prompts"] = {};
		if (validatedWaitingImport) {
			activeTurn.status = "waiting_for_answer";
			activeTurn.updated_at = state.updated_at;
			// Pre-WAL projections did not retain a prompt request ledger. Admit this
			// legacy active turn only by materializing the receipt that exactly binds
			// its durable delivery identities; later runtime admission uses the same
			// correlated receipt requirement as newly-created canonical turns.
			const receiptKey = createHash("sha256").update(`legacy-prompt\0${activeTurn.turn_id}`).digest("hex");
			importedPromptRequests[receiptKey] = {
				request_id: `prompt:${receiptKey}`,
				key_digest: receiptKey,
				request_digest: receiptKey,
				operation: "turn.prompt",
				canonical_prompt: { text: activeTurn.prompt.text },
				sdk_idempotency_key: `legacy:${receiptKey}`,
				phase: "completed",
				runtime_receipt: {
					accepted: true,
					command_id: runtimeCommandId as string,
					turn_id: runtimeTurnId,
				},
				coordinator_turn_id: activeTurn.turn_id,
				created_at: activeTurn.created_at,
				updated_at: activeTurn.updated_at,
			};
		}
		const legacyReportsDir = path.join(legacyNamespaceDir, "reports");
		const reportNames = await fs.readdir(legacyReportsDir).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
			throw error;
		});
		const importedReports: LegacyProjectionImportV1["reports"] = {};
		for (const reportName of reportNames) {
			if (!reportName.endsWith(".json")) continue;
			const reportId = reportName.slice(0, -".json".length);
			if (!COORDINATOR_REPORT_ID_PATTERN.test(reportId)) throw new Error("legacy_projection_quarantined");
			const report = asRecord(await readJsonFile(reportProjectionFile(legacyNamespaceDir, reportId)));
			if (report?.session_id !== sessionId) continue;
			if (
				!legacyScopeOwned(report) ||
				typeof report.report_id !== "string" ||
				!COORDINATOR_REPORT_ID_PATTERN.test(report.report_id) ||
				report.report_id !== reportId ||
				report.schema_version !== 1 ||
				typeof report.operation_id !== "string" ||
				typeof report.turn_id !== "string" ||
				typeof report.status !== "string" ||
				typeof report.summary !== "string" ||
				(report.blocker !== null && typeof report.blocker !== "string") ||
				(report.pr_url !== null && typeof report.pr_url !== "string") ||
				!Array.isArray(report.evidence_paths) ||
				typeof report.created_at !== "string"
			)
				throw new Error("legacy_projection_quarantined");
			importedReports[report.report_id] = report as unknown as LegacyProjectionImportV1["reports"][string];
		}
		return {
			turns: importedTurns,
			queue: {
				ordered_turn_ids: Object.values(importedTurns)
					.filter(turn => turn.status === "queued")
					.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.turn_id.localeCompare(b.turn_id))
					.map(turn => turn.turn_id),
				active_turn_id: activeTurn?.turn_id ?? null,
				selected_promotion: null,
			},
			desired_session_state: validatedWaitingImport
				? "needs_user_input"
				: (state?.state ??
					(activeTurn?.status === "waiting_for_answer"
						? "needs_user_input"
						: activeTurn
							? "running"
							: "ready_for_input")),
			reports: importedReports,
			gate_authorities: {},
			questions: {},
			// Legacy projections never persisted an answer claim. A fresh, explicit
			// ledger lets the first admitted answer create the sole durable claim.
			requests: { prompts: importedPromptRequests, answers: {}, operations: {} },
		};
	}

	async function assertPersistedSessionAuthority(session: CanonicalSessionSnapshotV1): Promise<void> {
		if (!session.broker.workspace) throw new Error("coordinator_workspace_required");
		await assertCoordinatorSessionLocations(config, session.cwd, session.broker.workspace, {
			canonicalizePath: services.canonicalizePath,
			platform,
		});
	}

	/** Every Codex handoff is scoped by the canonical WAL, never a retained projection. */
	async function assertCanonicalHandoffAuthority(sessionId: string): Promise<void> {
		const transaction = await readSessionTransaction(questionPaths, sessionId);
		if (!transaction) throw new Error("resource_gone");
		await assertPersistedSessionAuthority(transaction.canonical.session);
	}

	async function authorizedCanonicalSessionIds(
		sessionIds: Iterable<string>,
		scopedSessionId: string | null = null,
		allowMissingSessionIds: ReadonlySet<string> = new Set(),
	): Promise<Map<string, string>> {
		const authorized = new Map<string, string>();
		for (const sessionId of new Set(sessionIds)) {
			const transaction = await readSessionTransaction(questionPaths, sessionId);
			if (!transaction) {
				if (scopedSessionId === sessionId && !allowMissingSessionIds.has(sessionId))
					throw new Error("resource_gone");
				continue;
			}
			try {
				await assertPersistedSessionAuthority(transaction.canonical.session);
				authorized.set(sessionId, transaction.canonical.session.broker.endpoint_incarnation);
			} catch (error) {
				if (scopedSessionId === sessionId) throw error;
			}
		}
		return authorized;
	}

	function isSessionAuthorityError(error: unknown): boolean {
		return (
			error instanceof Error &&
			(error.message === "coordinator_workdir_outside_allowed_roots" ||
				error.message === "coordinator_workdir_roots_required" ||
				error.message === "coordinator_workspace_required")
		);
	}

	async function authorizedCoordinatorEvents(
		events: CoordinatorEvent[],
		scopedSessionId: string | null = null,
	): Promise<CoordinatorEvent[]> {
		const deletions = await withNamespaceRegistry(questionPaths, async registry => Object.values(registry.deletions));
		const reapedDeletionByEventId = new Map<string, NamespaceDeletionEntryV1>(
			deletions.map(entry => [`reap:${entry.deletion_id}`, entry] as const),
		);
		const reapedSessionIds = new Set(
			deletions.filter(entry => entry.cleanup.events || entry.phase === "completed").map(entry => entry.session_id),
		);
		const deletionSessionIds = new Set(deletions.map(entry => entry.session_id));
		const isReapedEvent = (event: CoordinatorEvent): boolean => {
			if (event.kind !== "session.reaped" || typeof event.session_id !== "string") return false;
			const deletion = reapedDeletionByEventId.get(event.id);
			const incarnation = event.metadata?.endpoint_incarnation;
			return (
				deletion !== undefined &&
				deletion.session_id === event.session_id &&
				typeof incarnation === "string" &&
				incarnation === deletion.endpoint_incarnation
			);
		};
		const isAuthorizedEvent = (event: CoordinatorEvent): boolean => {
			if (typeof event.session_id !== "string") return scopedSessionId === null;
			const authorizedIncarnation = authorized.get(event.session_id);
			if (!authorizedIncarnation) return false;
			const eventIncarnation =
				event.metadata && typeof event.metadata.endpoint_incarnation === "string"
					? event.metadata.endpoint_incarnation
					: null;
			return eventIncarnation === null
				? !reapedSessionIds.has(event.session_id)
				: eventIncarnation === authorizedIncarnation;
		};
		const authorized = await authorizedCanonicalSessionIds(
			[
				...events
					.filter(event => event.kind !== "session.reaped" && !isReapedEvent(event))
					.map(event => event.session_id)
					.filter((sessionId): sessionId is string => typeof sessionId === "string"),
				...(scopedSessionId ? [scopedSessionId] : []),
			],
			scopedSessionId,
			deletionSessionIds,
		);
		return events.filter(event =>
			typeof event.session_id === "string"
				? isAuthorizedEvent(event) ||
					(event.kind === "session.reaped" &&
						isReapedEvent(event) &&
						(scopedSessionId === null ||
							(scopedSessionId === event.session_id && !authorized.has(event.session_id))))
				: scopedSessionId === null,
		);
	}

	async function ensureQuestionTransaction(sessionId: string): Promise<void> {
		await ensureQuestionStateReady();
		try {
			const transaction = await readSessionTransaction(questionPaths, sessionId);
			if (!transaction) throw new Error("resource_gone");
			await assertPersistedSessionAuthority(transaction.canonical.session);
			await ensureSchedulerRoster(questionPaths, sessionId);
			return;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
		}
		const session = asRecord(await readJsonFile(path.join(legacyNamespaceDir, "sessions", `${sessionId}.json`)));
		if (!session) throw new Error("resource_gone");
		const incarnation = optionalString(session.endpoint_incarnation);
		const cwd = optionalString(session.cwd);
		const brokerWorkspace = optionalString(session.broker_workspace);
		if (!incarnation || !cwd || !brokerWorkspace || !legacyScopeOwned(session)) throw new Error("resource_gone");
		await assertCoordinatorSessionLocations(config, cwd, brokerWorkspace, {
			canonicalizePath: services.canonicalizePath,
			platform,
		});
		const canonicalCwd = await canonicalBrokerWorkspace(cwd);
		const canonicalWorkspace = await canonicalBrokerWorkspace(brokerWorkspace);
		const now = new Date().toISOString();
		const legacyProjection = await readLegacyProjectionImport(sessionId);
		const projectedVerifier = asRecord(session.sidecar_verifier);
		const verifierKeyId = optionalString(projectedVerifier?.key_id);
		const verifierPublicKey = optionalString(projectedVerifier?.public_key);
		if (!verifierKeyId || !verifierPublicKey) throw new Error("legacy_projection_quarantined");
		await createSessionTransaction(
			questionPaths,
			{
				kind: "register",
				session: {
					schema_version: 1,
					namespace_id: config.namespace.identity,
					session_id: sessionId,
					cwd: canonicalCwd,
					created_at: optionalString(session.created_at) ?? now,
					updated_at: now,
					mpreset: optionalString(session.mpreset),
					source: optionalString(session.source),
					model: optionalString(session.model),
					tmux: {
						session: optionalString(session.tmux_session),
						window: null,
						pane: optionalString(session.tmux_target),
					},
					broker: {
						workspace: canonicalWorkspace,
						endpoint_url: "",
						endpoint_generation:
							typeof session.endpoint_generation === "number" ? session.endpoint_generation : 0,
						endpoint_incarnation: incarnation,
						sidecar_verifier: { key_id: verifierKeyId, public_key: verifierPublicKey },
					},
					ephemeral: session.ephemeral === true,
					visible: session.visible !== false,
				},
				initial_state: "ready_for_input",
				initial_events: [{ kind: "session.registered", entity: "session", entity_id: sessionId, created_at: now }],
			},
			legacyProjection,
		);
	}

	type RuntimeAdmissionToken = {
		session_id: string;
		coordinator_turn_id: string;
		runtime_turn_id: string;
		transaction_revision: number;
		sidecar_schema_version: 1;
		sidecar_session_id: string;
		sidecar_observed_at: string;
		accepted_delivery: true;
	};

	type RuntimeReconciliationResult = {
		session_id: string;
		session_state: CoordinatorSessionState | null;
		terminal: boolean;
		active_turn_id: string | null;
		waiting_token: RuntimeAdmissionToken | null;
	};

	/**
	 * Sole lifecycle admission gateway. It reads sidecar state, then rechecks the
	 * canonical WAL before admitting any waiting/Q12/read/answer work. A terminal
	 * observation is projected first; roster/index state is never used as authority.
	 */
	async function reconcileSessionRuntime(
		sessionId: string,
		_options: {
			absoluteDeadline?: number;
			signal?: AbortSignal;
			source?: string;
			observeQuestions?: boolean;
		} = {},
	): Promise<RuntimeReconciliationResult> {
		await ensureQuestionTransaction(sessionId);
		let sessionState = await readSessionState(namespaceDir, sessionId);
		const transaction = await withSessionTransaction(questionPaths, sessionId, async tx => tx, {
			signal: _options.signal,
		});
		const active = Object.values(transaction.canonical.turns).filter(turn =>
			ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
		);
		if (
			_options.signal?.aborted ||
			(_options.absoluteDeadline !== undefined && Date.now() >= _options.absoluteDeadline)
		)
			return {
				session_id: sessionId,
				session_state: sessionState,
				terminal:
					transaction.canonical.desired_session_state === "completed" ||
					transaction.canonical.desired_session_state === "errored",
				active_turn_id: active[0]?.turn_id ?? null,
				waiting_token: null,
			};
		const current = sessionState?.current_turn_id;
		const candidate = current
			? transaction.canonical.turns[current]
			: sessionState?.state === "errored" && sessionState.last_turn_id
				? transaction.canonical.turns[sessionState.last_turn_id]
				: active.length === 1
					? active[0]
					: undefined;
		const terminalObservation =
			sessionState?.schema_version === 1 &&
			sessionState.source === "agent_session_event" &&
			sessionState.session_id === sessionId &&
			Number.isFinite(Date.parse(sessionState.updated_at)) &&
			(sessionState.state === "completed" || sessionState.state === "errored") &&
			isStrictTerminalRuntimeState(sessionState) &&
			hasExactRuntimeWriterIdentity(sessionState, transaction.canonical.session.broker) &&
			candidate &&
			candidate.terminal_fence === null &&
			(!current || candidate.turn_id === current) &&
			hasAcceptedRuntimeReceipt(turnFromCanonical(candidate));
		if (
			terminalObservation &&
			candidate &&
			sessionState &&
			!_options.signal?.aborted &&
			(_options.absoluteDeadline === undefined || Date.now() < _options.absoluteDeadline)
		) {
			const terminalTurn = await markTurnTerminalFromSessionState(turnFromCanonical(candidate), sessionState);
			await projectTerminalTransition(terminalTurn, {
				desiredState: sessionState.state,
				reason: sessionState.reason ? "terminal_uncertain" : null,
				live: sessionState.live,
				signal: _options.signal,
			});
			sessionState = await readSessionState(namespaceDir, sessionId);
		}
		let waitingTransitioned = false;
		if (
			!_options.signal?.aborted &&
			(_options.absoluteDeadline === undefined || Date.now() < _options.absoluteDeadline) &&
			sessionState?.schema_version === 1 &&
			sessionState.session_id === sessionId &&
			sessionState.source === "agent_session_event" &&
			hasExactRuntimeWriterIdentity(sessionState, transaction.canonical.session.broker) &&
			sessionState.live === true &&
			Number.isFinite(Date.parse(sessionState.updated_at)) &&
			sessionState.state === "needs_user_input" &&
			sessionState.current_turn_id
		) {
			await withAdmittedSessionTransaction(questionPaths, sessionId, async tx => {
				const waitingTurn = tx.canonical.turns[sessionState!.current_turn_id!];
				if (
					!waitingTurn ||
					!hasAcceptedRuntimeReceipt(waitingTurn) ||
					waitingTurn.terminal_fence ||
					!ACTIVE_TURN_STATUSES.has(waitingTurn.status as TurnStatus) ||
					waitingTurn.status === "waiting_for_answer"
				)
					return;
				waitingTurn.status = "waiting_for_answer";
				waitingTurn.updated_at = sessionState!.updated_at;
				tx.canonical.desired_session_state = "needs_user_input";
				const waitingEventId = deterministicOutboxId(
					sessionId,
					tx.revision + 1,
					"turn.waiting_for_answer",
					"turn",
					waitingTurn.turn_id,
					tx.canonical.session.broker.endpoint_incarnation,
				);
				tx.outbox[waitingEventId] ??= {
					id: waitingEventId,
					transaction_revision: tx.revision + 1,
					kind: "turn.waiting_for_answer",
					entity: "turn",
					entity_id: waitingTurn.turn_id,
					payload: {
						session_id: sessionId,
						turn_id: waitingTurn.turn_id,
						status: "waiting_for_answer",
						created_at: waitingTurn.updated_at,
					},
					emitted: false,
					public_event_id: waitingEventId,
					public_delivery: {
						public_event_id: waitingEventId,
						state: "pending",
						claim_fence: null,
						claim_expires_at: null,
						journal_seq: null,
						acknowledged_at: null,
					},
				};
				waitingTransitioned = true;
			});
			if (waitingTransitioned) {
				// Repair from the latest canonical snapshot under its lock. A terminal
				// transition that wins after the waiting commit must never be overwritten
				// by a stale legacy projection write.
				await repairCanonicalProjections(sessionId, { signal: _options.signal });
				sessionState = await readSessionState(namespaceDir, sessionId);
			}
		}
		const refreshed = await withSessionTransaction(questionPaths, sessionId, async tx => tx, {
			signal: _options.signal,
		});
		const activeTurn = Object.values(refreshed.canonical.turns).find(turn =>
			ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
		);
		const waitingTurnId = sessionState?.state === "needs_user_input" ? sessionState.current_turn_id : null;
		const waitingTurn = waitingTurnId ? refreshed.canonical.turns[waitingTurnId] : null;
		const runtimeTurnId = waitingTurn?.delivery.runtime_turn_id;
		const waitingToken =
			sessionState?.schema_version === 1 &&
			sessionState.live === true &&
			sessionState.source === "agent_session_event" &&
			hasExactRuntimeWriterIdentity(sessionState, refreshed.canonical.session.broker) &&
			sessionState.state === "needs_user_input" &&
			sessionState.current_turn_id === waitingTurnId &&
			typeof sessionState.session_id === "string" &&
			sessionState.session_id === sessionId &&
			Number.isFinite(Date.parse(sessionState.updated_at)) &&
			waitingTurn?.status === "waiting_for_answer" &&
			typeof runtimeTurnId === "string" &&
			runtimeTurnId.length > 0 &&
			hasAcceptedRuntimeReceipt(waitingTurn)
				? {
						session_id: sessionId,
						coordinator_turn_id: waitingTurn.turn_id,
						runtime_turn_id: runtimeTurnId,
						transaction_revision: refreshed.revision,
						sidecar_schema_version: 1 as const,
						sidecar_session_id: sessionState.session_id,
						sidecar_observed_at: sessionState.updated_at,
						accepted_delivery: true as const,
					}
				: null;
		return {
			session_id: sessionId,
			session_state: sessionState,
			terminal:
				refreshed.canonical.desired_session_state === "completed" ||
				refreshed.canonical.desired_session_state === "errored",
			active_turn_id: activeTurn?.turn_id ?? null,
			waiting_token: waitingToken,
		};
	}

	async function publishAcknowledgedTurnIntent(turn: TurnRecord): Promise<void> {
		await publishCanonicalLifecycleIntent(turn.session_id, {
			kind: "turn.acknowledged",
			entity: "turn",
			entityId: turn.turn_id,
			payload: {
				session_id: turn.session_id,
				turn_id: turn.turn_id,
				status: turn.status,
				created_at: turn.updated_at,
			},
		});
	}

	function runtimeProvenanceToken(
		sessionId: string,
		transaction: CoordinatorSessionTransactionV1,
		turn: CoordinatorSessionTransactionV1["canonical"]["turns"][string] | null,
		gate: WorkflowGate,
	): RuntimeProvenanceTokenV1 {
		return {
			namespace_id: config.namespace.identity,
			session_id: sessionId,
			endpoint_incarnation: transaction.canonical.session.broker.endpoint_incarnation,
			coordinator_turn_id: turn?.turn_id ?? "",
			runtime_turn_id: gate.runtime_turn_id ?? "",
			gate_created_at: gate.created_at,
			schema_hash: gate.schema_hash,
			stage: gate.stage,
			kind: gate.kind,
		};
	}

	async function publishCanonicalLifecycleIntent(
		sessionId: string,
		input: {
			kind: CoordinatorEventKind;
			entity: "turn" | "question" | "report" | "session" | "deletion";
			entityId: string;
			payload: Record<string, string | number | boolean | null>;
		},
	): Promise<void> {
		await ensureQuestionTransaction(sessionId);
		await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
			const existingEdge = Object.values(transaction.outbox).find(
				event => event.kind === input.kind && event.entity === input.entity && event.entity_id === input.entityId,
			);
			if (input.kind === "turn.acknowledged") {
				const turn = transaction.canonical.turns[input.entityId];
				const delivery = turn?.delivery as Record<string, unknown> | undefined;
				const intentId =
					typeof delivery?.acknowledgement_intent_id === "string" ? delivery.acknowledgement_intent_id : null;
				if (intentId) return;
				const eventId =
					existingEdge?.public_event_id ??
					deterministicOutboxId(
						sessionId,
						transaction.revision + 1,
						input.kind,
						input.entity,
						input.entityId,
						transaction.canonical.session.broker.endpoint_incarnation,
					);
				if (delivery) delivery.acknowledgement_intent_id = eventId;
				if (existingEdge) return;
				transaction.outbox[eventId] = {
					id: eventId,
					transaction_revision: transaction.revision + 1,
					kind: input.kind,
					entity: input.entity,
					entity_id: input.entityId,
					payload: input.payload,
					emitted: false,
					public_event_id: eventId,
					public_delivery: {
						public_event_id: eventId,
						state: "pending",
						claim_fence: null,
						claim_expires_at: null,
						journal_seq: null,
						acknowledged_at: null,
					},
				};
				return;
			}
			const eventId = deterministicOutboxId(
				sessionId,
				transaction.revision + 1,
				input.kind,
				input.entity,
				input.entityId,
				transaction.canonical.session.broker.endpoint_incarnation,
			);
			transaction.outbox[eventId] ??= {
				id: eventId,
				transaction_revision: transaction.revision + 1,
				kind: input.kind,
				entity: input.entity,
				entity_id: input.entityId,
				payload: input.payload,
				emitted: false,
				public_event_id: eventId,
				public_delivery: {
					public_event_id: eventId,
					state: "pending",
					claim_fence: null,
					claim_expires_at: null,
					journal_seq: null,
					acknowledged_at: null,
				},
			};
		});
		await exportRetainedDeliveries();
	}

	function publicQuestions(
		transaction: CoordinatorSessionTransactionV1,
		status: string | null,
	): CoordinatorQuestionPublicV1[] {
		return Object.values(transaction.canonical.questions)
			.filter(
				question => !status || question.status === status || (status === "open" && question.status === "pending"),
			)
			.map(question =>
				projectAskGateQuestion({
					question_id: question.question_id,
					session_id: question.session_id,
					turn_id: question.turn_id,
					status: question.status === "resolving" ? "pending" : question.status,
					stage: question.stage,
					kind: question.kind,
					prompt: question.prompt,
					codec: question.codec,
					created_at: question.created_at,
					updated_at: question.updated_at,
					answered_at: question.answered_at,
					reason: question.history.at(-1)?.reason ?? null,
					...(question.status === "pending" ? { answer_binding: question.binding_plaintext } : {}),
				}),
			);
	}

	async function reconcileQuestions(
		sessionId: string,
		options: { absoluteDeadline?: number; signal?: AbortSignal } = {},
	): Promise<ListQuestionsSuccessV1> {
		const observedAt = new Date().toISOString();
		const diagnostics: CoordinatorQuestionDiagnosticPublicV1[] = [];
		const diagnostic = (
			reason: CoordinatorQuestionDiagnosticPublicV1["reason"],
			turnId: string | null = null,
			gateId: string | null = null,
		) => {
			if (diagnostics.length < 64)
				diagnostics.push({
					schema_version: 1,
					session_id: sessionId,
					turn_id: turnId,
					gate_id: gateId,
					reason,
					observed_at: observedAt,
				});
		};
		try {
			await ensureQuestionTransaction(sessionId);
			if (
				options.signal?.aborted ||
				(options.absoluteDeadline !== undefined && Date.now() >= options.absoluteDeadline)
			) {
				diagnostic("query_unavailable");
				return {
					ok: true,
					schema_version: 1,
					questions: await withSessionTransaction(questionPaths, sessionId, async tx => publicQuestions(tx, null)),
					diagnostics,
					reconciliation: {
						attempted: false,
						complete: false,
						revision: null,
						observed_at: observedAt,
						reason: "query_unavailable",
					},
				};
			}
			const admission = await reconcileSessionRuntime(sessionId, {
				observeQuestions: true,
				...options,
			});
			const admissionToken = admission.waiting_token;
			if (
				admission.session_state?.source === "agent_session_event" &&
				admission.session_state.live === true &&
				admission.session_state.state === "needs_user_input" &&
				!admission.waiting_token
			)
				return {
					ok: true,
					schema_version: 1,
					questions: [],
					diagnostics,
					reconciliation: {
						attempted: false,
						complete: false,
						revision: null,
						observed_at: observedAt,
						reason: "terminal_uncertain",
					},
				};
			if (admission.terminal) {
				return {
					ok: true,
					schema_version: 1,
					questions: await withSessionTransaction(questionPaths, sessionId, async tx => publicQuestions(tx, null)),
					diagnostics,
					reconciliation: {
						attempted: false,
						complete: true,
						revision: null,
						observed_at: observedAt,
						reason: null,
					},
				};
			}
			const session = asRecord(await readJsonFile(sessionFile(sessionId)));
			if (!session) throw new Error("resource_gone");
			const snapshot = await readCompleteQ12Snapshot(session, options);
			const { items, complete, revision } = snapshot;
			if (!complete) {
				diagnostic(snapshot.reason ?? "query_unavailable");
				return {
					ok: true,
					schema_version: 1,
					questions: await withSessionTransaction(questionPaths, sessionId, async tx => publicQuestions(tx, null)),
					diagnostics,
					reconciliation: {
						attempted: true,
						complete: false,
						revision,
						observed_at: observedAt,
						reason: snapshot.reason ?? "query_unavailable",
					},
				};
			}
			const projectedTurnQuestions = new Map<string, string[]>();
			const openedQuestions: Array<{
				turnId: string;
				questionId: string;
				eventId: string;
			}> = [];
			let q12Admitted = true;
			await withAdmittedSessionTransaction(
				questionPaths,
				sessionId,
				async transaction => {
					const liveState = await readSessionState(namespaceDir, sessionId);
					const waitingToken = admissionToken;
					const waitingTurn = waitingToken ? transaction.canonical.turns[waitingToken.coordinator_turn_id] : null;
					if (
						waitingToken &&
						(!liveState ||
							liveState.schema_version !== waitingToken.sidecar_schema_version ||
							liveState.session_id !== waitingToken.sidecar_session_id ||
							liveState.source !== "agent_session_event" ||
							liveState.state !== "needs_user_input" ||
							liveState.current_turn_id !== waitingToken.coordinator_turn_id ||
							liveState.updated_at !== waitingToken.sidecar_observed_at ||
							!waitingTurn ||
							waitingTurn.status !== "waiting_for_answer" ||
							!hasAcceptedRuntimeReceipt(waitingTurn) ||
							waitingTurn.delivery.runtime_turn_id !== waitingToken.runtime_turn_id ||
							!hasExactRuntimeWriterIdentity(liveState, transaction.canonical.session.broker) ||
							transaction.revision < waitingToken.transaction_revision)
					) {
						q12Admitted = false;
						return;
					}
					if (
						liveState?.source === "agent_session_event" &&
						liveState.live === true &&
						(liveState.state !== "needs_user_input" || liveState.current_turn_id !== admission.active_turn_id)
					) {
						q12Admitted = false;
						return;
					}
					const seen = new Set<string>();
					const byRuntimeTurn = new Map<string, Array<(typeof transaction.canonical.turns)[string]>>();
					for (const turn of Object.values(transaction.canonical.turns)) {
						const runtimeTurnId = turn.delivery.runtime_turn_id;
						if (typeof runtimeTurnId !== "string") continue;
						const owners = byRuntimeTurn.get(runtimeTurnId) ?? [];
						owners.push(turn);
						byRuntimeTurn.set(runtimeTurnId, owners);
					}
					for (const row of items as WorkflowGateQueryRecord[]) {
						if (!row || typeof row !== "object" || row.tag !== "pending" || typeof row.gate_id !== "string") {
							diagnostic("invalid_gate_row");
							continue;
						}
						const gate = row as WorkflowGateQueryRecord & WorkflowGate;
						const authorityId = createHash("sha256")
							.update(
								`${config.namespace.identity}\0${sessionId}\0${transaction.canonical.session.broker.endpoint_incarnation}\0${gate.gate_id}`,
							)
							.digest("hex");
						seen.add(authorityId);
						const runtimeTurnId = gate.runtime_turn_id;
						const existing = transaction.canonical.gate_authorities[authorityId];
						const authority = existing ?? {
							authority: {
								namespace_id: config.namespace.identity,
								session_id: sessionId,
								endpoint_incarnation: transaction.canonical.session.broker.endpoint_incarnation,
								gate_id: gate.gate_id,
							},
							observation:
								typeof runtimeTurnId === "string" && runtimeTurnId
									? {
											kind: "valid" as const,
											first_provenance: runtimeProvenanceToken(
												sessionId,
												transaction,
												byRuntimeTurn.get(runtimeTurnId)?.[0] ?? null,
												gate,
											),
										}
									: {
											kind: "malformed" as const,
											immutable_observation_digest: createHash("sha256")
												.update(canonicalJson(row))
												.digest("hex"),
											malformed: "missing_runtime_turn" as const,
										},
							outcome: { state: "deferred_link" as const, first_seen_at: observedAt },
							first_seen_at: observedAt,
							updated_at: observedAt,
						};
						transaction.canonical.gate_authorities[authorityId] = authority;
						if (typeof runtimeTurnId !== "string" || !runtimeTurnId) {
							authority.outcome = { state: "stale", reason: "missing_runtime_turn" };
							authority.updated_at = observedAt;
							diagnostic("missing_runtime_turn", null, gate.gate_id);
							continue;
						}
						const owners = byRuntimeTurn.get(runtimeTurnId) ?? [];
						if (
							admissionToken &&
							(owners.length !== 1 ||
								owners[0]?.turn_id !== admissionToken.coordinator_turn_id ||
								runtimeTurnId !== admissionToken.runtime_turn_id ||
								transaction.revision < admissionToken.transaction_revision)
						) {
							q12Admitted = false;
							return;
						}
						const expectedProvenance = runtimeProvenanceToken(
							sessionId,
							transaction,
							owners.length === 1 ? owners[0]! : null,
							gate,
						);
						if (
							existing?.observation.kind === "malformed" ||
							(existing?.observation.kind === "valid" &&
								owners.length === 1 &&
								canonicalJson(existing.observation.first_provenance) !== canonicalJson(expectedProvenance))
						) {
							authority.outcome = { state: "stale", reason: "gate_provenance_changed" };
							authority.updated_at = observedAt;
							diagnostic("gate_provenance_changed", null, gate.gate_id);
							continue;
						}
						if (owners.length !== 1) {
							if (admissionToken) {
								q12Admitted = false;
								return;
							}
							const watermarkAt = transaction.recovery.prompt_watermark_at;
							const gateCreatedAt = Date.parse(gate.created_at);
							const watermarkBeyondGate =
								watermarkAt !== null &&
								Number.isFinite(gateCreatedAt) &&
								Date.parse(watermarkAt) > gateCreatedAt;
							const boundedAbsenceProved =
								watermarkBeyondGate &&
								Number.isFinite(gateCreatedAt) &&
								Date.now() - gateCreatedAt >= 5 * 60 * 1000;
							if (owners.length === 0 && !boundedAbsenceProved) {
								authority.observation = {
									kind: "valid",
									first_provenance: runtimeProvenanceToken(sessionId, transaction, null, gate),
								};
								authority.outcome = { state: "deferred_link", first_seen_at: authority.first_seen_at };
								authority.updated_at = observedAt;
								continue;
							}
							authority.outcome =
								owners.length === 0
									? { state: "ownership_unavailable", reason: "ownership_unavailable" }
									: { state: "ownership_conflict", reason: "ownership_conflict" };
							authority.updated_at = observedAt;
							diagnostic(
								owners.length === 0 ? "ownership_unavailable" : "ownership_conflict",
								null,
								gate.gate_id,
							);
							continue;
						}
						const turn = owners[0]!;
						const provenance = runtimeProvenanceToken(sessionId, transaction, turn, gate);
						if (!turn.runtime_provenance || canonicalJson(turn.runtime_provenance) !== canonicalJson(provenance))
							turn.runtime_provenance = provenance;
						if (TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus)) {
							authority.outcome = { state: "stale", reason: "turn_terminal", turn_id: turn.turn_id };
							authority.updated_at = observedAt;
							diagnostic("turn_terminal", turn.turn_id, gate.gate_id);
							continue;
						}
						const codec = decodeAskGateV1(gate);
						if (!codec) {
							authority.outcome = { state: "stale", reason: "unsupported_gate", turn_id: turn.turn_id };
							authority.updated_at = observedAt;
							diagnostic("unsupported_gate", turn.turn_id, gate.gate_id);
							continue;
						}
						if (
							existing &&
							existing.outcome.state !== "pending" &&
							existing.outcome.state !== "answered" &&
							existing.outcome.state !== "deferred_link"
						)
							continue;
						const questionId =
							existing?.outcome.state === "pending" || existing?.outcome.state === "answered"
								? existing.outcome.question_id
								: gate.gate_id;
						if (!existing || authority.outcome.state === "deferred_link") {
							const provenance = runtimeProvenanceToken(sessionId, transaction, turn, gate);
							authority.observation = {
								kind: "valid",
								first_provenance: provenance,
							};
							turn.runtime_provenance = provenance;
							authority.outcome = { state: "pending", turn_id: turn.turn_id, question_id: questionId };
						}
						authority.updated_at = observedAt;
						transaction.canonical.gate_authorities[authorityId] = authority;
						if (!transaction.canonical.questions[questionId]) {
							const binding = createAnswerBinding();
							transaction.canonical.questions[questionId] = {
								question_id: questionId,
								authority_id: authorityId,
								session_id: sessionId,
								turn_id: turn.turn_id,
								endpoint_incarnation: transaction.canonical.session.broker.endpoint_incarnation,
								stage: gate.stage,
								kind: gate.kind,
								prompt: typeof gate.context.prompt === "string" ? gate.context.prompt : "",
								status: "pending",
								binding_plaintext: binding,
								binding_sha256: createHash("sha256").update(binding).digest("hex"),
								codec,
								claim_fence_epoch: null,
								answer_request_id: null,
								created_at: observedAt,
								updated_at: observedAt,
								answered_at: null,
								history: [{ at: observedAt, status: "pending", reason: null }],
							};
							turn.question_ids = [...new Set([...turn.question_ids, questionId])];
							projectedTurnQuestions.set(turn.turn_id, turn.question_ids);
							const questionEventId = deterministicOutboxId(
								sessionId,
								transaction.revision + 1,
								"question.opened",
								"question",
								questionId,
								transaction.canonical.session.broker.endpoint_incarnation,
							);
							openedQuestions.push({ turnId: turn.turn_id, questionId, eventId: questionEventId });
							transaction.outbox[questionEventId] ??= {
								id: questionEventId,
								transaction_revision: transaction.revision + 1,
								kind: "question.opened",
								entity: "question",
								entity_id: questionId,
								payload: {
									session_id: sessionId,
									turn_id: turn.turn_id,
									question_id: questionId,
									created_at: observedAt,
								},
								emitted: false,
								public_event_id: questionEventId,
								public_delivery: {
									public_event_id: questionEventId,
									state: "pending",
									claim_fence: null,
									claim_expires_at: null,
									journal_seq: null,
									acknowledged_at: null,
								},
							};
						}
					}
					if (complete)
						for (const [authorityId, authority] of Object.entries(transaction.canonical.gate_authorities))
							if (!seen.has(authorityId) && authority.outcome.state === "pending") {
								const question = transaction.canonical.questions[authority.outcome.question_id];
								if (question?.status === "pending") {
									question.status = "stale";
									question.updated_at = observedAt;
									question.history.push({ at: observedAt, status: "stale", reason: "terminal_uncertain" });
									authority.outcome = {
										state: "stale",
										reason: "terminal_uncertain",
										turn_id: question.turn_id,
										question_id: question.question_id,
									};
									authority.updated_at = observedAt;
								}
							}
				},
				options,
			);
			if (!q12Admitted)
				return {
					ok: true,
					schema_version: 1,
					questions: await withSessionTransaction(questionPaths, sessionId, async tx => publicQuestions(tx, null)),
					diagnostics,
					reconciliation: {
						attempted: false,
						complete: false,
						revision,
						observed_at: observedAt,
						reason: "terminal_uncertain",
					},
				};
			// The Q12 commit is canonical authority. Rebuild every legacy projection
			// through the same repair lock instead of writing a stale partial turn after
			// a concurrent terminal reconciliation.
			await repairCanonicalProjections(sessionId, options.signal ? { signal: options.signal } : undefined);
			await exportRetainedDeliveries(32, options.signal);
			for (const opened of openedQuestions) {
				if (options.signal?.aborted) break;
				await appendCoordinatorEvent(
					namespaceDir,
					{
						stableId: opened.eventId,
						kind: "question.opened",
						sessionId,
						turnId: opened.turnId,
						questionId: opened.questionId,
						summary: "A coordinator question is awaiting an answer.",
					},
					options.signal ? { signal: options.signal } : undefined,
				);
			}
			return {
				ok: true,
				schema_version: 1,
				questions: await withSessionTransaction(questionPaths, sessionId, async tx => publicQuestions(tx, null)),
				diagnostics,
				reconciliation: {
					attempted: true,
					complete,
					revision,
					observed_at: observedAt,
					reason: complete ? null : "query_unavailable",
				},
			};
		} catch (error) {
			if (error instanceof Error && (error.message === "state_corrupt" || error.message === "resource_gone"))
				throw error;
			diagnostic("query_unavailable");
			await ensureQuestionTransaction(sessionId);
			return {
				ok: true,
				schema_version: 1,
				questions: await withSessionTransaction(questionPaths, sessionId, async tx => publicQuestions(tx, null)),
				diagnostics,
				reconciliation: {
					attempted: true,
					complete: false,
					revision: null,
					observed_at: observedAt,
					reason: "query_unavailable",
				},
			};
		}
	}
	const sessionTransitionTails = new Map<string, Promise<void>>();

	async function withSessionTransition<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const prior = sessionTransitionTails.get(sessionId) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const tail = prior.then(() => release.promise);
		sessionTransitionTails.set(sessionId, tail);
		await prior;
		try {
			return await operation();
		} finally {
			release.resolve();
			if (sessionTransitionTails.get(sessionId) === tail) sessionTransitionTails.delete(sessionId);
		}
	}

	type CoordinatorSessionAttachment = {
		sessionId: string;
		generation: number;
		attachment: SessionAttachment;
	};

	async function resolveSessionAttachment(session: Record<string, unknown>): Promise<CoordinatorSessionAttachment> {
		const sessionId = optionalString(session.session_id) ?? optionalString(session.sessionId);
		const generation =
			typeof session.endpoint_generation === "number" &&
			Number.isSafeInteger(session.endpoint_generation) &&
			session.endpoint_generation > 0
				? session.endpoint_generation
				: null;
		const workspace = optionalString(session.broker_workspace);
		const incarnation = optionalString(session.endpoint_incarnation);
		if (!sessionId || generation === null)
			throw new SdkClientError("not_found", "Coordinator session has no usable endpoint generation.");
		if (!workspace || !incarnation)
			throw new SdkClientError("endpoint_stale", "Coordinator session has no exact endpoint authority.");
		let persistedWorkspace: string;
		try {
			persistedWorkspace = await canonicalBrokerWorkspace(workspace);
		} catch {
			throw new SdkClientError("endpoint_stale", "Coordinator session workspace authority is unavailable.");
		}
		await ensureRouterReady();
		await router.reconcile();
		const attachment = router.attachment(sessionId, generation);
		if (!attachment?.isCurrent())
			throw new SdkClientError("endpoint_stale", "Coordinator session attachment is unavailable or stale.");
		let authority: BrokerSessionAuthority;
		try {
			authority = await exactBrokerSessionAuthority(sessionId, persistedWorkspace);
		} catch (error) {
			if (error instanceof SdkClientError && (error.code === "not_found" || error.code === "endpoint_stale"))
				throw new SdkClientError(
					"endpoint_stale",
					"Coordinator session endpoint authority is unavailable or stale.",
				);
			throw error;
		}
		if (
			!sameCanonicalPath(authority.workspace, persistedWorkspace, platform) ||
			authority.endpointGeneration !== generation ||
			authority.endpointIncarnation !== incarnation
		)
			throw new SdkClientError("endpoint_stale", "Coordinator session endpoint authority changed.");
		return { sessionId, generation, attachment };
	}

	function sdkResponse(response: Record<string, unknown>, operation: string): Record<string, unknown> {
		if (response.ok !== true) {
			const error = asRecord(response.error);
			throw new SdkClientError(
				typeof error?.code === "string" ? error.code : "unavailable",
				typeof error?.message === "string" ? error.message : `SDK ${operation} request failed.`,
			);
		}
		return response;
	}

	async function requestSessionFrame(
		target: CoordinatorSessionAttachment,
		frame: Record<string, unknown>,
		options?: { timeoutMs?: number },
	): Promise<Record<string, unknown>> {
		try {
			return await router.request(target.sessionId, frame, target.generation, target.attachment, options);
		} catch (error) {
			if (error instanceof SessionRouterError)
				throw new SdkClientError(
					error.phase === "ambiguous" ? "ambiguous" : "endpoint_stale",
					error.phase === "ambiguous"
						? "Coordinator session request may have been accepted before attachment changed."
						: "Coordinator session attachment changed before request dispatch.",
					error,
				);
			throw error;
		}
	}

	async function controlSession(
		session: Record<string, unknown>,
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey: string,
	): Promise<unknown> {
		const target = await resolveSessionAttachment(session);
		const promptOperation =
			operation === "turn.prompt" || operation === "turn.follow_up" || operation === "turn.abort_and_prompt";
		const response = asRecord(
			await requestSessionFrame(
				target,
				{
					type: "control_request",
					operation,
					input,
					idempotencyKey,
				},
				promptOperation ? { timeoutMs: promptAckTimeoutMs } : undefined,
			),
		);
		if (response?.ok === false) sdkResponse(response, operation);
		return response;
	}

	async function querySession(
		session: Record<string, unknown>,
		query: string,
		input: Record<string, unknown> = {},
		cursor?: string,
	): Promise<Record<string, unknown>> {
		const target = await resolveSessionAttachment(session);
		const response = asRecord(
			await requestSessionFrame(target, {
				type: "query_request",
				query,
				input,
				...(cursor === undefined ? {} : { cursor }),
			}),
		);
		if (!response) throw new SdkClientError("unavailable", `SDK ${query} query returned an invalid response.`);
		return sdkResponse(response, query);
	}

	async function readCompleteQ12Snapshot(
		session: Record<string, unknown>,
		options: { absoluteDeadline?: number; signal?: AbortSignal } = {},
	): Promise<{
		items: unknown[];
		revision: string | null;
		complete: boolean;
		reason: "pagination_malformed" | "query_unavailable" | null;
	}> {
		const deadline = Math.min(
			Date.now() + Q12_SNAPSHOT_BUDGET_MS,
			options.absoluteDeadline ?? Number.POSITIVE_INFINITY,
		);
		const items: unknown[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		let revision: string | null = null;
		let bytes = 0;
		let target: CoordinatorSessionAttachment;
		try {
			target = await resolveSessionAttachment(session);
		} catch {
			return { items: [], revision, complete: false, reason: "query_unavailable" };
		}
		try {
			for (
				let pageCount = 0;
				pageCount < MAX_Q12_ATTEMPTS_PER_WATCH_PASS * 4 && Date.now() <= deadline;
				pageCount++
			) {
				if (options.signal?.aborted) return { items: [], revision, complete: false, reason: "query_unavailable" };
				// The snapshot deadline is only checked between pages, so each page has to
				// carry what is left of it. Without that budget the page inherits the
				// Router's session reply budget and one wedged page outlives the whole
				// snapshot bound this function promises its callers.
				const response = asRecord(
					await requestSessionFrame(
						target,
						{
							type: "query_request",
							query: "Q12",
							input: {},
							...(cursor === undefined ? {} : { cursor }),
						},
						{ timeoutMs: Math.max(1, deadline - Date.now()) },
					),
				);
				if (response?.ok !== true) return { items: [], revision, complete: false, reason: "query_unavailable" };
				const page = asRecord(response.page);
				const pageItems = page?.items;
				const pageRevision = typeof page?.revision === "string" ? page.revision : null;
				const complete = page?.complete === true;
				const preview = page?.preview;
				const nextCursor = page?.continuationCursor;
				if (
					!Array.isArray(pageItems) ||
					typeof page?.complete !== "boolean" ||
					!pageRevision ||
					(complete && (preview === true || (nextCursor !== undefined && nextCursor !== null))) ||
					(!complete && (preview !== true || typeof nextCursor !== "string" || nextCursor.length === 0))
				)
					return { items: [], revision: pageRevision, complete: false, reason: "pagination_malformed" };
				const validatedCursor = typeof nextCursor === "string" ? nextCursor : undefined;
				if (revision !== null && revision !== pageRevision)
					return { items: [], revision: pageRevision, complete: false, reason: "pagination_malformed" };
				revision = pageRevision;
				bytes += Buffer.byteLength(JSON.stringify(pageItems));
				if (items.length + pageItems.length > 64 || bytes > 256 * 1024)
					return { items: [], revision, complete: false, reason: "pagination_malformed" };
				items.push(...pageItems);
				if (complete) {
					const valid = items.every(item => {
						const encoded = JSON.stringify(item);
						return typeof encoded === "string" && Buffer.byteLength(encoded) <= 16 * 1024;
					});
					return valid
						? { items, revision, complete: true, reason: null }
						: { items: [], revision, complete: false, reason: "pagination_malformed" };
				}
				if (!validatedCursor || cursors.has(validatedCursor))
					return { items: [], revision, complete: false, reason: "pagination_malformed" };
				cursors.add(validatedCursor);
				cursor = validatedCursor;
			}
			return { items: [], revision, complete: false, reason: "pagination_malformed" };
		} catch {
			return { items: [], revision, complete: false, reason: "query_unavailable" };
		}
	}

	function sdkQueryPageItem(response: Record<string, unknown>, query: string): unknown {
		const items = asRecord(response.page)?.items;
		if (!Array.isArray(items) || items.length !== 1)
			throw new SdkClientError("unavailable", `SDK ${query} query returned an invalid page.`);
		return items[0];
	}

	async function queryLastAssistant(session: Record<string, unknown>): Promise<string | null> {
		const item = sdkQueryPageItem(await querySession(session, "session.last_assistant"), "session.last_assistant");
		if (typeof item === "string") return item;
		const message = asRecord(item);
		return typeof message?.text === "string"
			? message.text
			: typeof message?.content === "string"
				? message.content
				: null;
	}

	async function queryContextStatus(session: Record<string, unknown>): Promise<Record<string, unknown>> {
		const context = asRecord(sdkQueryPageItem(await querySession(session, "context.get"), "context.get"));
		return {
			authority: "sdk",
			live: true,
			...(typeof context?.isStreaming === "boolean" ? { is_streaming: context.isStreaming } : {}),
		};
	}

	function requirePromptAcknowledgement(result: unknown): RuntimePromptAcknowledgement {
		return normalizeRuntimePromptAcknowledgement(result);
	}

	/**
	 * The outcome of a failed compensating close is unobserved, not decided: the
	 * session may still be running. Sealing it under the idempotency key would
	 * answer that uncertainty forever, so the key stays open for a real retry.
	 */
	function isUnobservedCompensation(response: Record<string, unknown>): boolean {
		const error = asRecord(response.error);
		return error?.code === UNOBSERVED_COMPENSATION_CODE;
	}

	function isRouterRequestAmbiguous(response: Record<string, unknown>): boolean {
		if (response.ok !== false) return false;
		return asRecord(response.error)?.code === "ambiguous";
	}

	function publicErrorCode(code: unknown): string {
		return typeof code === "string" && Object.hasOwn(PUBLIC_ERROR_MESSAGES, code) ? code : "unavailable";
	}
	function publicError(error: unknown): Record<string, unknown> {
		if (error instanceof Error && error.message.startsWith("coordinator_mutation_call_not_allowed:"))
			return { ok: false, reason: error.message };
		const directCode = error instanceof SdkClientError ? error.code : sinkErrorCode(error);
		const messageCode =
			error instanceof Error && Object.hasOwn(PUBLIC_ERROR_MESSAGES, error.message) ? error.message : undefined;
		const code = publicErrorCode(directCode ?? messageCode);
		return { ok: false, error: { code, message: PUBLIC_ERROR_MESSAGES[code] } };
	}
	function sdkError(error: unknown): Record<string, unknown> {
		return publicError(error);
	}

	function requiredIdempotencyKey(args: Record<string, unknown>): string {
		const key = optionalString(args.idempotency_key);
		if (!key) throw new SdkClientError("invalid_request", "idempotency_key is required.");
		return key;
	}

	function requiredString(value: unknown, field: string): string {
		if (typeof value !== "string" || value.length === 0)
			throw new SdkClientError("invalid_request", `${field} is required.`);
		return value;
	}

	/**
	 * Path for the lock owner file that serializes idempotency mutations.
	 *
	 * Lock artifacts (owner records, transition markers, quarantine placeholders) are
	 * created as siblings of the locked path by {@link withSessionStateFileLock}.
	 * The record directory must enumerate as parseable records only, so the lock
	 * path lives in a sibling `idempotency-locks` directory: its artifacts can never
	 * appear inside `idempotency/`, which would surface as
	 * `JSON Parse error: Unexpected EOF` during replay or enumeration.
	 */
	function idempotencyLockFile(idempotencyKey: string): string {
		const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
		return path.join(namespaceDir, "idempotency-locks", `${keyDigest}.json`);
	}
	function idempotencyFile(idempotencyKey: string): string {
		const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
		return path.join(namespaceDir, "idempotency", `${keyDigest}.json`);
	}
	const idempotencyFlights = new Map<string, { requestDigest: string; promise: Promise<Record<string, unknown>> }>();
	type IdempotencyFlightAdmission =
		| { kind: "conflict"; response: Record<string, unknown> }
		| { kind: "joined"; promise: Promise<Record<string, unknown>> }
		| { kind: "owner"; run: (operation: Promise<Record<string, unknown>>) => Promise<Record<string, unknown>> };
	function admitIdempotencyFlight(
		tool: string,
		idempotencyKey: string,
		canonicalArgs: Record<string, unknown>,
	): IdempotencyFlightAdmission {
		const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
		const requestDigest = createHash("sha256")
			.update(canonicalJson({ tool, args: canonicalArgs }))
			.digest("hex");
		const existingFlight = idempotencyFlights.get(keyDigest);
		if (existingFlight) {
			if (existingFlight.requestDigest !== requestDigest)
				return {
					kind: "conflict",
					response: {
						ok: false,
						error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
					},
				};
			return { kind: "joined", promise: existingFlight.promise };
		}
		const result = Promise.withResolvers<Record<string, unknown>>();
		const flight = { requestDigest, promise: result.promise };
		idempotencyFlights.set(keyDigest, flight);
		return {
			kind: "owner",
			run: async operation => {
				void operation.then(result.resolve, result.reject);
				try {
					return await result.promise;
				} finally {
					if (idempotencyFlights.get(keyDigest) === flight) idempotencyFlights.delete(keyDigest);
				}
			},
		};
	}
	async function withIdempotencyFlight(
		tool: string,
		idempotencyKey: string,
		canonicalArgs: Record<string, unknown>,
		operation: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		const admission = admitIdempotencyFlight(tool, idempotencyKey, canonicalArgs);
		if (admission.kind === "conflict") return admission.response;
		if (admission.kind === "joined") return await admission.promise;
		return await admission.run(operation());
	}
	async function withOrderedSessionStateLocks<T>(
		lockFiles: readonly string[],
		operation: () => Promise<T>,
	): Promise<T> {
		const ordered = [...new Set(lockFiles)].sort();
		const acquire = async (index: number): Promise<T> =>
			index === ordered.length ? operation() : withSessionStateLock(ordered[index]!, () => acquire(index + 1));
		return acquire(0);
	}

	/**
	 * Run one mutation under its idempotency key, then seal its response as the
	 * key's terminal replay.
	 *
	 * `isNonterminal` is the one exception. Sealing is correct for a decided
	 * outcome, and wrong for a response that states only that the outcome could
	 * not be observed: the key would answer that uncertainty forever, even once
	 * the remote effect settled. A tool may declare such a response nonterminal,
	 * which returns it to this caller while the receipt stays `in_progress`, so
	 * an exact same-key retry re-runs the observation under the same request
	 * digest. Router post-send ambiguity is nonterminal by default; every other
	 * tool-specific exception is supplied by its handler.
	 */
	async function withToolIdempotency(
		tool: string,
		idempotencyKey: string,
		canonicalArgs: Record<string, unknown>,
		operation: (recovering: boolean) => Promise<Record<string, unknown>>,
		recoverInProgress = false,
		isNonterminal: (response: Record<string, unknown>) => boolean = isRouterRequestAmbiguous,
		lockAlreadyHeld = false,
		flightAlreadyOwned = false,
	): Promise<Record<string, unknown>> {
		const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
		const requestDigest = createHash("sha256")
			.update(canonicalJson({ tool, args: canonicalArgs }))
			.digest("hex");
		const file = idempotencyFile(idempotencyKey);
		const lockFile = idempotencyLockFile(idempotencyKey);
		const releaseResponsePin = async (record: Partial<CoordinatorToolIdempotencyRecord>): Promise<void> => {
			if (!workflowForDelegateTool(tool) || record.delegate_response_pin === undefined) return;
			try {
				if (!(await releaseDelegateResponsePin(record.delegate_response_pin, idempotencyKey)))
					throw new Error("delegate_response_pin_mismatch");
			} catch (error) {
				// Cleanup cannot invalidate an already committed snapshot. Keep the
				// pin on failure and retry cleanup during readiness or replay.
				logger.warn("Coordinator delegate response pin cleanup failed", {
					sessionId: record.delegate_response_pin?.session_id,
					error: String(error),
				});
			}
		};
		const commitResponse = async (record: CoordinatorToolIdempotencyRecord): Promise<void> => {
			if (workflowForDelegateTool(tool)) await services.beforeDelegateResponseCommit?.();
			let durableRecord = record;
			if (workflowForDelegateTool(tool)) {
				const latestFile = await readCoordinatorIdempotencyFile(file);
				if (latestFile.kind !== "record") throw new Error("terminal_uncertain");
				const latest = latestFile.value;
				const pin = delegateResponsePin(latest.delegate_response_pin);
				if (
					latest.schema_version !== 1 ||
					latest.tool !== tool ||
					latest.key_digest !== keyDigest ||
					latest.request_digest !== requestDigest ||
					latest.state !== "in_progress"
				)
					throw new Error("terminal_uncertain");
				if (record.response?.ok === true && !pin) throw new Error("terminal_uncertain");
				durableRecord = pin
					? {
							...record,
							...(latest.admission ? { admission: latest.admission as DelegateAdmissionCheckpoint } : {}),
							delegate_response_pin: pin,
						}
					: record;
			}
			await writeCoordinatorIdempotencyFile(file, durableRecord);
			if (workflowForDelegateTool(tool)) await services.afterDelegateResponseCommit?.();
			await releaseResponsePin(durableRecord);
		};
		const execute = async (): Promise<Record<string, unknown>> => {
			const existingFile = await readCoordinatorIdempotencyFile(file);
			if (existingFile.kind === "corrupt")
				return {
					ok: false,
					error: {
						code: "terminal_uncertain",
						message: "coordinator idempotency ledger is corrupt; mutation outcome is uncertain",
					},
				};
			const existing =
				existingFile.kind === "record" ? (existingFile.value as Partial<CoordinatorToolIdempotencyRecord>) : null;
			if (existing) {
				if (
					existing.schema_version !== 1 ||
					existing.key_digest !== keyDigest ||
					existing.tool !== tool ||
					existing.request_digest !== requestDigest
				)
					return {
						ok: false,
						error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
					};
				if (existing.state === "completed") {
					const replay = asRecord(existing.response);
					if (replay) {
						await releaseResponsePin(existing);
						return boundedToolResponse(tool, replay);
					}
					return {
						ok: false,
						error: {
							code: "terminal_uncertain",
							message: "completed coordinator idempotency record is corrupt; mutation outcome is uncertain",
						},
					};
				}
				if (existing.state === "in_progress" && !recoverInProgress)
					return {
						ok: false,
						error: {
							code: "idempotency_in_progress",
							message: "prior coordinator mutation outcome is not replayable",
						},
					};
				if (existing.state === "in_progress") {
					// A crash can leave the receipt phase behind a fully materialized
					// response. Replaying that response is safer than re-running the
					// operation and changing volatile projection timestamps.
					const persistedResponse = asRecord(existing.response);
					if (persistedResponse && !isNonterminal(persistedResponse)) {
						await commitResponse({
							...existing,
							state: "completed",
							response: persistedResponse,
							completed_at: new Date().toISOString(),
						} as CoordinatorToolIdempotencyRecord);
						return boundedToolResponse(tool, persistedResponse);
					}
					const rawResponse = await operation(true).catch(error => sdkError(error));
					const response = boundedToolResponse(tool, rawResponse);
					// The receipt keeps its original key and request digests, so a
					// reused key still conflicts and a later settled answer still seals.
					if (isNonterminal(rawResponse)) return response;
					await commitResponse({
						...existing,
						state: "completed",
						response,
						completed_at: new Date().toISOString(),
					} as CoordinatorToolIdempotencyRecord);
					return response;
				}
				return {
					ok: false,
					error: {
						code: "terminal_uncertain",
						message: "coordinator idempotency record is corrupt; mutation outcome is uncertain",
					},
				};
			}
			const started: CoordinatorToolIdempotencyRecord = {
				schema_version: 1,
				tool,
				key_digest: keyDigest,
				request_digest: requestDigest,
				state: "in_progress",
				created_at: new Date().toISOString(),
			};
			await writeCoordinatorIdempotencyFile(file, started);
			const rawResponse = await operation(false).catch(error => sdkError(error));
			const response = boundedToolResponse(tool, rawResponse);
			if (isNonterminal(rawResponse)) return response;
			await commitResponse({
				...started,
				state: "completed",
				response,
				completed_at: new Date().toISOString(),
			});
			return response;
		};
		const executeWithLock = async (): Promise<Record<string, unknown>> =>
			lockAlreadyHeld ? await execute() : await withSessionStateLock(lockFile, execute);
		return flightAlreadyOwned
			? await executeWithLock()
			: await withIdempotencyFlight(tool, idempotencyKey, canonicalArgs, executeWithLock);
	}

	async function brokerSession(
		_cwd: string,
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<unknown> {
		const agentDir = services.getAgentDir?.() ?? getAgentDir();
		try {
			await (services.ensureBroker ?? ensureBroker)({ agentDir });
		} catch (error) {
			throw toCoordinatorBrokerError("ensure", error);
		}

		let discovery: BrokerDiscovery | null;
		try {
			discovery = await (services.readSdkBrokerDiscovery ?? readSdkBrokerDiscovery)(agentDir);
		} catch (error) {
			throw toCoordinatorBrokerError("read", error);
		}
		if (!discovery) throw new SdkClientError("broker_unavailable", "SDK broker is unavailable after bootstrap.");

		let client: SdkClient;
		try {
			client = await (services.connectBroker ?? ((url, token) => SdkClient.connect(url, token)))(
				discovery.url,
				discovery.token,
			);
		} catch (error) {
			throw toCoordinatorBrokerError("connect", error);
		}

		let requestError: SdkClientError | undefined;
		let result: unknown;
		try {
			const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
			result = await client.global(operation, input, {
				...(idempotencyKey ? { idempotencyKey } : {}),
				...(timeoutMs === undefined ? {} : { timeoutMs }),
			});
		} catch (error) {
			requestError = toCoordinatorBrokerError("request", error);
		}
		try {
			await client.close();
		} catch (error) {
			if (!requestError) throw toCoordinatorBrokerError("close", error);
		}
		if (requestError) throw requestError;
		return result;
	}

	const resolveModelPin =
		services.resolveModelPin ??
		(async (raw: unknown, cwd?: string): Promise<CoordinatorModelResolution> => {
			if (raw === undefined || raw === null) return { ok: true, model: null };
			const result = brokerResult(
				await brokerSession("", "model.resolve", {
					model: raw,
					cwd,
					target: coordinatorLifecycleTarget(config.sessionCommand, cwd ?? ""),
				}),
			);
			if (result) {
				if (result.ok === true && (result.model === null || typeof result.model === "string"))
					return { ok: true, model: result.model };
				if (
					result.ok === false &&
					result.reason === "unknown_model" &&
					typeof result.model === "string" &&
					typeof result.error === "string"
				)
					return { ok: false, reason: "unknown_model", model: result.model, error: result.error };
			}
			throw new SdkClientError("unavailable", "SDK host returned an invalid model resolution.");
		});

	async function withRemoteSessionCompensation<T>(
		cwd: string,
		remoteSession: { value: string | null },
		operation: () => Promise<T>,
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			const sessionId = remoteSession.value;
			if (!sessionId) {
				if (error instanceof SdkClientError && OBSERVED_BROKER_FAILURE_CODES.has(error.code)) throw error;
				throw new SdkClientError(
					UNOBSERVED_COMPENSATION_CODE,
					"Coordinator creation outcome could not be identified for cleanup.",
					{ primary: error },
				);
			}
			try {
				strictBrokerSessionClose(
					await brokerSession(cwd, "session.close", { sessionId }, `${sessionId}:compensate-create`),
					sessionId,
				);
			} catch (closeError) {
				let listed: Record<string, unknown>;
				try {
					listed = await paginatedBrokerSessionList(cwd, { cwd });
				} catch (listError) {
					throw new SdkClientError(
						UNOBSERVED_COMPENSATION_CODE,
						`Coordinator creation failed after remote session ${sessionId} was created, and compensation failed.`,
						{ primary: error, compensation: closeError, list: listError, session_id: sessionId },
					);
				}
				const rows = jsonRecords(Array.isArray(listed.sessions) ? listed.sessions : []);
				const row = rows.find(candidate => brokerSessionId(candidate) === sessionId);
				const deadUncertain =
					row !== undefined &&
					row.live !== true &&
					(row.terminalUncertain === true || (row as Record<string, unknown>).terminal_uncertain === true);
				if (!deadUncertain)
					throw new SdkClientError(
						UNOBSERVED_COMPENSATION_CODE,
						`Coordinator creation failed after remote session ${sessionId} was created, and compensation failed.`,
						{ primary: error, compensation: closeError, session_id: sessionId },
					);
			}
			throw error;
		}
	}

	function brokerResult(value: unknown): Record<string, unknown> {
		const response = asRecord(value);
		if (response?.ok === false) {
			const error = asRecord(response.error);
			throw new SdkClientError(
				typeof error?.code === "string" ? error.code : "unavailable",
				typeof error?.message === "string" ? error.message : "SDK broker request failed.",
			);
		}
		return asRecord(response?.result) ?? response ?? {};
	}

	function strictBrokerResult(value: unknown, operation: string): Record<string, unknown> {
		const response = asRecord(value);
		if (response?.ok === false) brokerResult(response);
		if (response?.ok !== true || !Object.hasOwn(response, "result"))
			throw new SdkClientError(
				UNOBSERVED_COMPENSATION_CODE,
				`SDK broker returned a malformed ${operation} response; the lifecycle outcome is unobserved.`,
				{ response },
			);
		const result = asRecord(response.result);
		if (!result)
			throw new SdkClientError(
				UNOBSERVED_COMPENSATION_CODE,
				`SDK broker returned a malformed ${operation} result; the lifecycle outcome is unobserved.`,
				{ response },
			);
		return result;
	}

	function strictBrokerRetirementProof(
		value: unknown,
		expected: CreationRetirementProofV1,
	): { broker: CreationRetirementBrokerProofV1; public: Record<string, unknown> } {
		const response = asRecord(value);
		if (response?.ok === false) brokerResult(response);
		const result = response?.ok === true ? asRecord(response.result) : null;
		if (!result)
			throw new SdkClientError("protocol_error", "SDK broker returned a malformed retirement acknowledgement.");
		const broker = {
			session_id: typeof result.sessionId === "string" ? result.sessionId : "",
			retired: result.retired,
			ledger_state: result.ledgerState,
			index_type: result.indexType,
			state_root: typeof result.stateRoot === "string" ? result.stateRoot : "",
			endpoint_generation: typeof result.endpointGeneration === "number" ? result.endpointGeneration : Number.NaN,
			endpoint_mtime_ms: typeof result.endpointMtimeMs === "number" ? result.endpointMtimeMs : Number.NaN,
			process_incarnation: typeof result.processIncarnation === "string" ? result.processIncarnation : "",
			host_incarnation: typeof result.hostIncarnation === "string" ? result.hostIncarnation : "",
			lifecycle_request_id: typeof result.lifecycleRequestId === "string" ? result.lifecycleRequestId : "",
			remote_create_key: typeof result.remoteCreateKey === "string" ? result.remoteCreateKey : "",
		} as unknown as CreationRetirementBrokerProofV1;
		if (
			broker.session_id !== expected.session_id ||
			broker.retired !== true ||
			broker.ledger_state !== "terminal_error" ||
			broker.index_type !== "session_closed" ||
			broker.state_root !== expected.state_root ||
			broker.endpoint_generation !== expected.endpoint_generation ||
			broker.endpoint_mtime_ms !== expected.endpoint_mtime_ms ||
			broker.process_incarnation !== expected.process_incarnation ||
			broker.host_incarnation !== expected.host_incarnation ||
			broker.lifecycle_request_id !== expected.lifecycle_request_id ||
			broker.remote_create_key !== expected.remote_create_key
		)
			throw new SdkClientError("protocol_error", "SDK broker returned an unbound retirement proof.");
		return {
			broker,
			public: publicRetirementProof(broker),
		};
	}

	function coordinatorRetiredResponse(sessionId: string, lifecycle: Record<string, unknown>): Record<string, unknown> {
		return { ok: true, session_id: sessionId, retired: true, lifecycle };
	}

	function publicRetirementProof(proof: CreationRetirementBrokerProofV1): Record<string, unknown> {
		return {
			sessionId: proof.session_id,
			retired: true,
			ledgerState: proof.ledger_state,
			indexType: proof.index_type,
		};
	}

	function strictBrokerSessionClose(value: unknown, expectedSessionId: string): Record<string, unknown> {
		const result = strictBrokerResult(value, "session.close");
		const sessionId = optionalString(result.sessionId ?? result.session_id);
		if (sessionId !== expectedSessionId)
			throw new SdkClientError(
				UNOBSERVED_COMPENSATION_CODE,
				"SDK broker returned no proof that the expected session was closed.",
				{ expected_session_id: expectedSessionId, result },
			);
		return result;
	}

	async function paginatedBrokerSessionList(
		cwd: string,
		input: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		try {
			const pages = await traverseSessionList(
				input,
				async pageInput => {
					const response = await brokerSession(cwd, "session.list", pageInput);
					if (asRecord(response)?.ok === false) brokerResult(response);
					return response;
				},
				response => sessionListPageFromResponse(response),
			);
			const aggregate: Record<string, unknown> = {};
			const sessions: unknown[] = [];
			for (const { page } of pages) {
				for (const [key, value] of Object.entries(page)) {
					if (key !== "sessions" && key !== "continuationCursor") aggregate[key] = value;
				}
				sessions.push(...page.sessions);
			}
			return { ...aggregate, sessions };
		} catch (error) {
			if (error instanceof SessionListTraversalError) throw new SdkClientError("protocol_error", error.message);
			throw error;
		}
	}

	async function canonicalBrokerWorkspace(cwd: string): Promise<string> {
		try {
			return await (services.canonicalizePath ?? (value => fs.realpath(value)))(cwd);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new SdkClientError("not_found", "Coordinator workspace cannot be resolved.");
			throw error;
		}
	}

	function brokerEndpointGeneration(session: Record<string, unknown>): number | null {
		return typeof session.endpointGeneration === "number" &&
			Number.isSafeInteger(session.endpointGeneration) &&
			session.endpointGeneration > 0
			? session.endpointGeneration
			: typeof session.endpoint_generation === "number" &&
					Number.isSafeInteger(session.endpoint_generation) &&
					session.endpoint_generation > 0
				? session.endpoint_generation
				: null;
	}

	function brokerEndpointIncarnation(session: Record<string, unknown>, sessionId: string): string | null {
		const endpointGeneration = brokerEndpointGeneration(session);
		const pid = session.pid;
		const endpointMtimeMs = session.endpointMtimeMs;
		if (
			endpointGeneration === null ||
			typeof pid !== "number" ||
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			typeof endpointMtimeMs !== "number" ||
			!Number.isFinite(endpointMtimeMs) ||
			endpointMtimeMs <= 0
		)
			return null;
		return createHash("sha256")
			.update(canonicalJson({ endpointGeneration, endpointMtimeMs, pid, sessionId }))
			.digest("hex");
	}

	type BrokerSessionAuthority = {
		workspace: string;
		endpointGeneration: number;
		endpointIncarnation: string;
	};

	async function exactBrokerSessionAuthority(sessionId: string, workspace: string): Promise<BrokerSessionAuthority> {
		const listing = await paginatedBrokerSessionList(workspace, { cwd: workspace });

		const matches: Array<{ session: Record<string, unknown>; workspace: string }> = [];
		for (const session of jsonRecords(Array.isArray(listing.sessions) ? listing.sessions : [])) {
			if (brokerSessionId(session) !== sessionId) continue;
			const declaredWorkspace = brokerSessionScope(session);
			if (!declaredWorkspace) continue;
			let canonicalWorkspace: string;
			try {
				canonicalWorkspace = await canonicalBrokerWorkspace(declaredWorkspace);
			} catch {
				continue;
			}
			if (sameCanonicalPath(canonicalWorkspace, workspace, platform))
				matches.push({ session, workspace: canonicalWorkspace });
		}
		if (matches.length !== 1)
			throw new SdkClientError(
				"not_found",
				"Session is not uniquely indexed in the requested coordinator workspace.",
			);
		const match = matches[0]!;
		const endpointGeneration = brokerEndpointGeneration(match.session);
		const endpointIncarnation = brokerEndpointIncarnation(match.session, sessionId);
		if (endpointGeneration === null || endpointIncarnation === null)
			throw new SdkClientError("endpoint_stale", "Broker session has no usable endpoint incarnation.");
		return { workspace: match.workspace, endpointGeneration, endpointIncarnation };
	}

	async function exactBrokerSessionBinding(sessionId: string, workspace: string): Promise<BrokerSessionAuthority> {
		return await exactBrokerSessionAuthority(sessionId, workspace);
	}

	/**
	 * Ask a prepared session to publish its withheld readiness through the
	 * Router-owned attachment. Endpoint credentials and SDK clients never leave
	 * SessionRouter.
	 */
	async function activatePreparedCoordinatorSession(
		session: Record<string, unknown>,
		sessionId: string,
		_idempotencyKey: string,
	): Promise<ActivatedPreparedSession> {
		const target = await resolveSessionAttachment(session);
		return await requestPreparedSessionActivation(
			{
				request: async frame => await requestSessionFrame(target, frame),
				close: async () => {},
			},
			sessionId,
			target.generation,
		);
	}

	async function listSessions(cwd?: string): Promise<Array<Record<string, unknown>>> {
		const roots = cwd ? [cwd] : config.allowedRoots;
		const listings = await Promise.all(
			roots.map(async root => {
				const listing = await paginatedBrokerSessionList(root, { cwd: root });
				return scopedBrokerSessions(Array.isArray(listing.sessions) ? listing.sessions : [], root, platform);
			}),
		);
		return listings.flat();
	}
	function sessionFile(sessionId: unknown): string {
		return path.join(namespaceDir, "sessions", `${safeExternalId("session", sessionId)}.json`);
	}
	/**
	 * Session ids that have a durable coordinator projection usable by the
	 * session-scoped tools, i.e. that `gjc_coordinator_read_status` can resolve.
	 * One directory scan answers every listed broker row, so a listing over
	 * hundreds of sessions costs one readdir plus one read per projected row
	 * instead of one read per broker row; unregistered broker sessions are free.
	 * `registered: true` keeps predicting the other tools' outcome only when the
	 * row is non-null — a projection row without a usable `cwd` string answers
	 * false, mirroring `read_status`'s own gate, so a foreign or damaged row
	 * cannot make the marker overpromise. A projection may also be created or
	 * reaped after this snapshot; the session-scoped tools stay the authority.
	 */
	async function registeredSessionIds(): Promise<Set<string>> {
		const registered = new Set<string>();
		const entries = await fs.readdir(path.join(namespaceDir, "sessions"), { withFileTypes: true }).catch(() => []);
		await Promise.all(
			entries.map(async entry => {
				if (!entry.isFile() || !entry.name.endsWith(".json")) return;
				const sessionId = entry.name.slice(0, -".json".length);
				if (!COORDINATOR_SESSION_ID_PATTERN.test(sessionId)) return;
				const session = asRecord(await readJsonFile(sessionFile(sessionId)).catch(() => null));
				if (optionalString(session?.cwd) !== null) registered.add(sessionId);
			}),
		);
		return registered;
	}
	function registeredSessionMarker(registered: ReadonlySet<string>, session: Record<string, unknown>): boolean {
		const sessionId = brokerSessionId(session);
		return sessionId !== null && registered.has(sessionId);
	}
	async function removeReapedProjection(
		sessionId: string,
		turnIds: readonly string[],
		reportIds: readonly string[],
	): Promise<void> {
		for (const turnId of turnIds) await fs.rm(turnFile(namespaceDir, turnId), { force: true });
		for (const reportId of reportIds) await fs.rm(reportProjectionFile(namespaceDir, reportId), { force: true });
		await fs.rm(sessionFile(sessionId), { force: true });
		await fs.rm(sessionStateFile(namespaceDir, sessionId), { force: true });
		await fs.rm(activeTurnFile(namespaceDir, sessionId), { force: true });
	}
	async function drainSessionRetainedDeliveries(sessionId: string, endpointIncarnation?: string): Promise<boolean> {
		for (;;) {
			let claims: PublicDeliveryClaimV1[];
			try {
				claims = await claimPublicDelivery(questionPaths, sessionId, { limit: 128 });
			} catch (error) {
				// The WAL unlink and deletion-progress update are separate durable
				// boundaries. A retry after a crash in that gap has already drained
				// the retained deliveries by definition.
				if (error instanceof Error && error.message === "resource_gone") return true;
				throw error;
			}
			if (claims.length === 0) {
				let recovered = 0;
				try {
					recovered = await recoverExpiredPublicDelivery(questionPaths, sessionId);
				} catch (error) {
					if (error instanceof Error && error.message === "resource_gone") return true;
					throw error;
				}
				if (recovered > 0) continue;
				const transaction = await readSessionTransaction(questionPaths, sessionId);
				return (
					!transaction ||
					Object.values(transaction.outbox).every(event => event.public_delivery.state === "acknowledged")
				);
			}
			for (const claim of claims) {
				const payload = claim.event.payload;
				const event = await appendCoordinatorEvent(namespaceDir, {
					stableId: claim.event.public_event_id,
					kind: claim.event.kind as CoordinatorEventKind,
					sessionId,
					turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
					questionId: typeof payload.question_id === "string" ? payload.question_id : null,
					reportId: typeof payload.report_id === "string" ? payload.report_id : null,
					summary: "Coordinator event recorded.",
					metadata: endpointIncarnation ? { endpoint_incarnation: endpointIncarnation } : undefined,
				});
				await acknowledgePublicDelivery(questionPaths, sessionId, {
					public_event_id: claim.event.public_event_id,
					claim_fence: claim.claim_fence,
					journal_seq: event.seq,
				});
			}
		}
	}
	async function completeDeletionCleanup(
		entry: NamespaceDeletionEntryV1,
		reason?: string,
		force = false,
	): Promise<boolean> {
		if (!entry.cleanup.wal) {
			if (!(await drainSessionRetainedDeliveries(entry.session_id, entry.endpoint_incarnation))) return false;
			const removed = await removeSessionTransaction(questionPaths, entry.session_id, entry.endpoint_incarnation);
			if (!removed && (await readSessionTransaction(questionPaths, entry.session_id))) return false;
			entry.cleanup.wal = true;
			await advanceDeletion(questionPaths, entry.deletion_id, "cleanup_pending", { wal: true });
		}
		if (!entry.cleanup.turns || !entry.cleanup.reports || !entry.cleanup.session) {
			await removeReapedProjection(entry.session_id, entry.cleanup.turn_ids ?? [], entry.cleanup.report_ids ?? []);
			entry.cleanup.turns = true;
			entry.cleanup.reports = true;
			entry.cleanup.session = true;
			await advanceDeletion(questionPaths, entry.deletion_id, "cleanup_pending", {
				turns: true,
				reports: true,
				session: true,
			});
		}
		if (!entry.cleanup.events) {
			await appendCoordinatorEvent(namespaceDir, {
				stableId: `reap:${entry.deletion_id}`,
				kind: "session.reaped",
				sessionId: entry.session_id,
				summary: `Session ${entry.session_id} closed and reaped${reason ? ` (${reason})` : ""}`,
				metadata: {
					reason: reason ?? null,
					force,
					closed: true,
					endpoint_incarnation: entry.endpoint_incarnation,
				},
			});
			entry.cleanup.events = true;
			await advanceDeletion(questionPaths, entry.deletion_id, "cleanup_pending", { events: true });
		}
		await advanceDeletion(
			questionPaths,
			entry.deletion_id,
			"completed",
			{ wal: true, turns: true, reports: true, session: true, events: true },
			{ ok: true, closed: true },
		);
		return true;
	}
	async function recoverIntentDeletion(entry: NamespaceDeletionEntryV1): Promise<void> {
		const session = asRecord(await readJsonFile(sessionFile(entry.session_id)));
		if (!session) throw new SdkClientError("state_corrupt", "Close intent has no session authority record.");
		const cwd = optionalString(session.cwd);
		const endpointGeneration =
			typeof session.endpoint_generation === "number" &&
			Number.isSafeInteger(session.endpoint_generation) &&
			session.endpoint_generation > 0
				? session.endpoint_generation
				: null;
		if (!cwd || endpointGeneration === null)
			throw new SdkClientError("state_corrupt", "Close intent authority is incomplete.");
		strictBrokerSessionClose(
			await brokerSession(
				cwd,
				"session.close",
				{
					sessionId: entry.session_id,
					endpointGeneration,
					endpointIncarnation: entry.endpoint_incarnation,
				},
				`coordinator-reap:${entry.session_id}:${entry.endpoint_incarnation}`,
			),
			entry.session_id,
		);
		await advanceDeletion(questionPaths, entry.deletion_id, "broker_closed", undefined, {
			ok: true,
			closed: true,
			session_id: entry.session_id,
		});
	}
	async function reapSession(
		rawId: unknown,
		opts: { force?: boolean; reason?: string } = {},
	): Promise<{ ok: boolean; reason?: string; closed: boolean; active_turn_id?: string; detail?: string }> {
		const id = safeExternalId("session", rawId);
		return await withSessionTransition(id, async () => {
			// A successful broker close is durable before projection cleanup. Resume that
			// manifest first, even while the session projection remains readable, so a
			// verification-uncertain retry never reaches broker close again.
			await ensureQuestionStateReady();
			let pendingDeletion = await withNamespaceRegistry(
				questionPaths,
				async registry =>
					Object.values(registry.deletions)
						.filter(
							entry =>
								entry.session_id === id &&
								(entry.phase === "intent" ||
									entry.phase === "broker_closed" ||
									entry.phase === "cleanup_pending"),
						)
						.sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null,
			);
			if (pendingDeletion?.phase === "intent") {
				try {
					await recoverIntentDeletion(pendingDeletion);
				} catch (error) {
					return {
						ok: false,
						reason: "close_failed",
						closed: false,
						detail: publicErrorCode(error instanceof SdkClientError ? error.code : sinkErrorCode(error)),
					};
				}
				const recoveredDeletionId = pendingDeletion.deletion_id;
				pendingDeletion = await withNamespaceRegistry(
					questionPaths,
					async registry => registry.deletions[recoveredDeletionId] ?? null,
				);
			}
			if (pendingDeletion) {
				const complete = await completeDeletionCleanup(pendingDeletion, opts.reason, opts.force === true);
				return complete ? { ok: true, closed: true } : { ok: false, reason: "delivery_pending", closed: false };
			}
			const session = asRecord(await readJsonFile(sessionFile(id)));
			if (!session) {
				await ensureQuestionStateReady();
				const deletion = await withNamespaceRegistry(questionPaths, async registry => {
					const matching = Object.values(registry.deletions).filter(entry => entry.session_id === id);
					return (
						matching.find(entry => entry.phase !== "completed") ??
						matching.find(entry => entry.safe_response !== undefined) ??
						null
					);
				});
				if (deletion?.phase === "completed" && deletion.safe_response)
					return deletion.safe_response as { ok: boolean; closed: boolean };
				if (deletion?.phase === "broker_closed" || deletion?.phase === "cleanup_pending") {
					const complete = await completeDeletionCleanup(deletion);
					return complete ? { ok: true, closed: true } : { ok: false, reason: "delivery_pending", closed: false };
				}
				if (deletion?.safe_response) {
					const safeResponse = asRecord(deletion.safe_response);
					const safeSessionId = optionalString(safeResponse?.session_id ?? safeResponse?.sessionId);
					if (
						safeResponse?.ok === true &&
						safeResponse.closed === true &&
						(safeSessionId === null || safeSessionId === id)
					)
						return deletion.safe_response as { ok: boolean; closed: boolean };
					throw new SdkClientError("state_corrupt", "Persisted reap response does not prove completed cleanup.");
				}
				return { ok: false, reason: "unknown_session", closed: false };
			}

			await ensureQuestionTransaction(id);
			// Rebuild legacy projections before reaper eligibility checks. A crash after
			// canonical terminal commit must not leave a stale active-turn file blocking reap.
			await recoverCanonicalSessionProjection(id);
			const cwd = optionalString(session.cwd);
			const persistedWorkspace = optionalString(session.broker_workspace);
			const persistedGeneration =
				typeof session.endpoint_generation === "number" &&
				Number.isSafeInteger(session.endpoint_generation) &&
				session.endpoint_generation > 0
					? session.endpoint_generation
					: null;
			const persistedIncarnation = optionalString(session.endpoint_incarnation);
			if (!cwd || !persistedWorkspace || persistedGeneration === null || !persistedIncarnation)
				return { ok: false, reason: "endpoint_stale", closed: false };
			// Endpoint identity is the authority for any lifecycle mutation. Check it
			// before consulting a possibly stale active-turn projection so a successor
			// incarnation cannot be blocked by old local state.
			let preflightWorkspace: string;
			try {
				preflightWorkspace = await canonicalBrokerWorkspace(cwd);
				const authority = await exactBrokerSessionAuthority(id, preflightWorkspace);
				if (
					!sameCanonicalPath(authority.workspace, persistedWorkspace, platform) ||
					authority.endpointGeneration !== persistedGeneration ||
					authority.endpointIncarnation !== persistedIncarnation
				)
					return { ok: false, reason: "endpoint_stale", closed: false };
			} catch (error) {
				if (error instanceof SdkClientError && (error.code === "not_found" || error.code === "endpoint_stale"))
					return { ok: false, reason: "endpoint_stale", closed: false };
				throw error;
			}
			if (session.ephemeral !== true && opts.force !== true)
				return { ok: false, reason: "not_ephemeral", closed: false };
			let canonicalTransaction = await readSessionTransaction(questionPaths, id);
			const canonicalActiveTurn = (canonicalTransaction
				? Object.values(canonicalTransaction.canonical.turns).find(turn =>
						ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
					)
				: undefined) as unknown as { turn_id: string } | undefined;
			const activeTurn = await readActiveTurn(namespaceDir, id);
			if (activeTurn || canonicalActiveTurn)
				return {
					ok: false,
					reason: "active_turn",
					closed: false,
					active_turn_id: activeTurn?.turn_id ?? canonicalActiveTurn?.turn_id,
				};
			// `listSessions` selects an idle candidate before this transition acquires
			// its per-session lock. A turn may finish in that interval, leaving no
			// active-turn marker but advancing the canonical activity watermark. Re-read
			// the durable authority immediately before admitting the irreversible close.
			if (opts.reason === "idle_reaper") {
				canonicalTransaction = await readSessionTransaction(questionPaths, id);
				const latestActiveTurn = canonicalTransaction
					? Object.values(canonicalTransaction.canonical.turns).find(turn =>
							ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
						)
					: undefined;
				if (latestActiveTurn)
					return {
						ok: false,
						reason: "active_turn",
						closed: false,
						active_turn_id: latestActiveTurn.turn_id,
					};
				const latestStamp =
					optionalString(canonicalTransaction?.recovery.prompt_watermark_at) ??
					optionalString(canonicalTransaction?.canonical.session.updated_at) ??
					optionalString(session.created_at);
				const latestActivityMs = latestStamp ? Date.parse(latestStamp) : Number.NaN;
				if (!Number.isFinite(latestActivityMs) || Date.now() - latestActivityMs < config.sessionIdleTtlMs)
					return { ok: false, reason: "not_idle", closed: false };
			}
			const deletionId = `delete:${id}:${persistedIncarnation}`;
			const deletionKey = createHash("sha256").update(deletionId).digest("hex");
			const deletionEntry = {
				deletion_id: deletionId,
				session_id: id,
				endpoint_incarnation: persistedIncarnation,
				operation_id: deletionId,
				key_digest: deletionKey,
				request_digest: deletionKey,
				close_key: deletionId,
				phase: "intent" as const,
				cleanup: {
					wal: false,
					turns: false,
					reports: false,
					session: false,
					events: false,
					turn_ids: canonicalTransaction ? Object.keys(canonicalTransaction.canonical.turns) : [],
					report_ids: canonicalTransaction ? Object.keys(canonicalTransaction.canonical.reports) : [],
				},
				authority_digest: deletionKey,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			let admitted: CoordinatorSessionTransactionV1;
			try {
				admitted = await admitSessionClose(questionPaths, deletionEntry, {
					...(opts.reason === "idle_reaper" ? { idleBeforeMs: Date.now() - config.sessionIdleTtlMs } : {}),
				});
			} catch (error) {
				if (error instanceof Error && error.message === "active_turn_exists") {
					return { ok: false, reason: "active_turn", closed: false };
				}
				if (error instanceof Error && error.message === "session_not_idle")
					return { ok: false, reason: "not_idle", closed: false };
				throw error;
			}
			const projectionIds = {
				turnIds: Object.keys(admitted.canonical.turns),
				reportIds: Object.keys(admitted.canonical.reports),
			};
			await ensureQuestionStateReady();
			const deletionPhase = await withNamespaceRegistry(
				questionPaths,
				async registry => registry.deletions[deletionId]?.phase,
			);
			const closeAlreadyProven = deletionPhase === "broker_closed" || deletionPhase === "cleanup_pending";
			let workspace = "";
			try {
				workspace = await canonicalBrokerWorkspace(cwd);
				let authority: BrokerSessionAuthority | null = null;
				if (!closeAlreadyProven) {
					authority = await exactBrokerSessionAuthority(id, workspace);
					if (
						!sameCanonicalPath(authority.workspace, persistedWorkspace, platform) ||
						authority.endpointGeneration !== persistedGeneration ||
						authority.endpointIncarnation !== persistedIncarnation
					)
						return { ok: false, reason: "endpoint_stale", closed: false };
				}
				await ensureQuestionStateReady();
				await ensureQuestionTransaction(id);
				await withSessionTransaction(questionPaths, id, async transaction => {
					const now = new Date().toISOString();
					transaction.requests.operations[deletionId] = {
						operation_id: deletionId,
						tool: "gjc_coordinator_stop_session",
						key_digest: deletionKey,
						request_digest: deletionKey,
						local_id: id,
						phase: "remote_started",
						intent: { kind: "reap", endpoint_incarnation: persistedIncarnation },
						created_at: now,
						updated_at: now,
					};
				});
				if (!closeAlreadyProven) {
					if (!authority) throw new Error("state_corrupt");
					strictBrokerSessionClose(
						await brokerSession(
							cwd,
							"session.close",
							{
								sessionId: id,
								endpointGeneration: authority.endpointGeneration,
								endpointIncarnation: authority.endpointIncarnation,
							},
							`coordinator-reap:${id}:${authority.endpointIncarnation}`,
						),
						id,
					);
					await advanceDeletion(questionPaths, deletionId, "broker_closed", undefined, {
						ok: true,
						closed: true,
						session_id: id,
					});
				}
			} catch (error) {
				return {
					ok: false,
					reason: "close_failed",
					detail: publicErrorCode(error instanceof SdkClientError ? error.code : sinkErrorCode(error)),
					closed: false,
				};
			}
			await advanceDeletion(questionPaths, deletionId, "broker_closed", {
				turn_ids: projectionIds.turnIds,
				report_ids: projectionIds.reportIds,
			});
			try {
				const listing = await paginatedBrokerSessionList(workspace, { cwd: workspace });
				const rows = jsonRecords(
					Array.isArray((listing as Record<string, unknown>).sessions)
						? ((listing as Record<string, unknown>).sessions as unknown[])
						: [],
				);
				const candidates: Array<Record<string, unknown>> = [];
				for (const row of rows) {
					if (brokerSessionId(row) !== id) continue;
					const declaredWorkspace = brokerSessionScope(row);
					if (!declaredWorkspace) continue;
					let canonicalDeclared: string;
					try {
						canonicalDeclared = await canonicalBrokerWorkspace(declaredWorkspace);
					} catch {
						continue;
					}
					if (sameCanonicalPath(canonicalDeclared, workspace, platform)) candidates.push(row);
				}
				if (candidates.length === 0) {
					// No retained row: proven deletion (session_deleted) after successful close.
				} else if (candidates.length !== 1) {
					return { ok: false, reason: "close_failed", detail: "endpoint_stale", closed: false };
				} else {
					const row = candidates[0]!;
					const gen = brokerEndpointGeneration(row);
					const inc = brokerEndpointIncarnation(row, id);
					const genMatches = gen === persistedGeneration;
					const incMatches = inc === persistedIncarnation;
					if (!genMatches || !incMatches) return { ok: false, reason: "endpoint_stale", closed: false };
					const isAmbiguous = row.ambiguous === true;
					const isTerminalUncertain =
						row.terminalUncertain === true || (row as Record<string, unknown>).terminal_uncertain === true;
					const isTerminal = row.terminal === true;
					const isLive = row.live === true;
					if (isAmbiguous || isTerminalUncertain)
						return { ok: false, reason: "close_failed", detail: "endpoint_stale", closed: false };
					if (!isTerminal || isLive) return { ok: false, reason: "endpoint_stale", closed: false };
				}
			} catch (error) {
				return {
					ok: false,
					reason: "close_failed",
					detail: publicErrorCode(error instanceof SdkClientError ? error.code : sinkErrorCode(error)),
					closed: false,
				};
			}
			await advanceDeletion(questionPaths, deletionId, "cleanup_pending", {
				turn_ids: projectionIds.turnIds,
				report_ids: projectionIds.reportIds,
			});
			const complete = await completeDeletionCleanup(
				{
					...deletionEntry,
					phase: "cleanup_pending",
					cleanup: {
						wal: false,
						turns: false,
						reports: false,
						session: false,
						events: false,
						turn_ids: projectionIds.turnIds,
						report_ids: projectionIds.reportIds,
					},
				},
				opts.reason,
				opts.force === true,
			);
			return complete ? { ok: true, closed: true } : { ok: false, reason: "delivery_pending", closed: false };
		});
	}

	const sessionReaper: SessionReaper = createSessionReaper(
		{
			listSessions: async (): Promise<ReapableSession[]> => {
				const sessions = await listJsonFiles(path.join(namespaceDir, "sessions"));
				const out: ReapableSession[] = [];
				for (const raw of sessions) {
					const session = asRecord(raw);
					const sessionId = optionalString(session?.session_id);
					if (session?.ephemeral !== true || !sessionId) continue;
					try {
						await ensureQuestionTransaction(sessionId);
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
					}
					try {
						await recoverCanonicalSessionProjection(sessionId);
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
					}
					// Idle eligibility is judged against the durable WAL, not the
					// projection state file: projection repair refreshes that stamp
					// (writeSessionState stamps `now`), which would reset the idle clock
					// after every failed close and defer the reaper's retry by a whole
					// TTL. The truthful WAL activity authority is the turn watermark
					// (recovery.prompt_watermark_at, advanced on every canonical turn
					// commit) — canonical.session.updated_at is creation-only and would
					// degenerate the idle TTL into an age-since-creation check that reaps
					// in-use sessions between turns. Turn-less sessions fall back to their
					// creation stamp; the projection state remains the fallback only when
					// the WAL itself cannot be read.
					const walSession = await readSessionTransaction(questionPaths, sessionId);
					const walStamp =
						optionalString(walSession?.recovery.prompt_watermark_at) ??
						optionalString(walSession?.canonical.session.updated_at);
					const state = await readSessionState(namespaceDir, sessionId);
					const stamp = walStamp ?? optionalString(state?.updated_at) ?? optionalString(session.created_at);
					const lastActivityMs = stamp ? Date.parse(stamp) : Number.NaN;
					out.push({
						sessionId,
						ephemeral: true,
						hasActiveTurn: (await readActiveTurn(namespaceDir, sessionId)) !== null,
						lastActivityMs: Number.isFinite(lastActivityMs) ? lastActivityMs : Date.now(),
					});
				}
				return out;
			},
			reapSession: async (sessionId: string): Promise<void> => {
				const result = await reapSession(sessionId, { reason: "idle_reaper" });
				if (!result.ok) throw new Error(result.reason ?? "session_reap_failed");
			},
			now: () => Date.now(),
		},
		{ idleTtlMs: config.sessionIdleTtlMs, sweepIntervalMs: config.sessionSweepIntervalMs },
	);
	async function listQuestions(args: Record<string, unknown>): Promise<ListQuestionsSuccessV1> {
		const sessionId = safeExternalId("session", args.session_id);
		const reconciled = await reconcileQuestions(sessionId);
		const status = typeof args.status === "string" && args.status.length > 0 ? args.status : "pending";
		const turnId = args.turn_id == null ? null : safeTurnId(args.turn_id);
		return {
			...reconciled,
			questions: reconciled.questions
				.filter(
					question =>
						status === "all" ||
						question.status === status ||
						(status === "open" && question.status === "pending"),
				)
				.filter(question => turnId === null || question.turn_id === turnId),
		};
	}

	function canonicalReportEvidencePaths(value: unknown): unknown {
		if (value == null) return [];
		if (!Array.isArray(value)) return value;
		return value.map(item => (typeof item === "string" ? path.resolve(item) : item));
	}

	async function validateEvidencePaths(value: unknown): Promise<Array<{ path: string }>> {
		if (value == null) return [];
		if (!Array.isArray(value)) throw new Error("coordinator_evidence_paths_must_be_array");
		const evidence: Array<{ path: string }> = [];
		for (const item of value) {
			const resolved = await assertCoordinatorArtifactPath(config, item);
			evidence.push({ path: resolved.path });
		}
		return evidence;
	}

	async function readTurnPayload(turnId: unknown, sessionId: unknown): Promise<Record<string, unknown>> {
		const requestedSession = sessionId == null ? null : safeExternalId("session", sessionId);
		if (requestedSession) {
			await reconcileSessionRuntime(requestedSession, { observeQuestions: true }).catch(error => {
				if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
			});
			await recoverCanonicalSessionProjection(requestedSession);
		}
		let turn = await readTurnRecord(namespaceDir, turnId);
		if (!turn) return { ok: false, reason: "unknown_turn" };
		if (!requestedSession) {
			await reconcileSessionRuntime(turn.session_id, { observeQuestions: true });
			await recoverCanonicalSessionProjection(turn.session_id);
			turn = (await readTurnRecord(namespaceDir, turnId)) ?? turn;
		}
		if (sessionId != null && turn.session_id !== safeExternalId("session", sessionId)) {
			return { ok: false, reason: "turn_session_mismatch" };
		}
		await reconcileQuestions(turn.session_id);
		const session = asRecord(await readJsonFile(sessionFile(turn.session_id)));
		let resolvedTurn = turn;
		let advisoryStatus: Record<string, unknown> = {
			authority: "sdk",
			live: null,
			reason: "session_endpoint_unobserved",
		};
		let sessionState = await readSessionState(namespaceDir, turn.session_id);
		if (session) {
			try {
				advisoryStatus = await queryContextStatus(session);
			} catch (error) {
				advisoryStatus = {
					authority: "sdk",
					live: null,
					reason: publicErrorCode(error instanceof SdkClientError ? error.code : sinkErrorCode(error)),
				};
			}
		} else {
			advisoryStatus = { authority: "sdk", live: null, reason: "session_record_missing" };
		}
		resolvedTurn = await reconcileRuntimeAcknowledgement(
			namespaceDir,
			resolvedTurn,
			sessionState,
			promptAckTimeoutMs,
			{ failOnTimeout: false, onAcknowledged: publishAcknowledgedTurnIntent },
		);
		if (resolvedTurn !== turn) sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		if (!session && ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
			resolvedTurn = await markTurnFailedForUnavailableSession(resolvedTurn, "session_record_missing");
			await projectTerminalTransition(resolvedTurn, {
				desiredState: "stale",
				reason: "session_unavailable",
				live: false,
			});
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		}
		if (ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
			resolvedTurn = await reconcileRuntimeAcknowledgement(
				namespaceDir,
				resolvedTurn,
				sessionState,
				promptAckTimeoutMs,
				{ failOnTimeout: true, onAcknowledged: publishAcknowledgedTurnIntent },
			);
			if (!ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
				await projectTerminalTransition(resolvedTurn, {
					desiredState: "stale",
					reason: "terminal_uncertain",
					live: resolvedTurn.liveness.live,
				});
				sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
			}
		}
		const missingFinalResponse =
			resolvedTurn.status === "completed" && !reportableFinalResponse(resolvedTurn.final_response);
		return {
			ok: true,
			turn: boundedPublicValue(resolvedTurn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
			advisory_status: advisoryStatus,
			session_state: publicCoordinatorSessionState(sessionState),
			...(missingFinalResponse
				? {
						completion_missing_final_response: true,
						advisory: MISSING_FINAL_RESPONSE_ADVISORY,
					}
				: {}),
		};
	}

	async function awaitTurnPayload(
		turnId: unknown,
		sessionId: unknown,
		timeoutMs: unknown,
		pollIntervalMs: unknown,
	): Promise<Record<string, unknown>> {
		const timeout = boundedAwaitTurnTimeoutMs(timeoutMs);
		const pollInterval = boundedPollIntervalMs(pollIntervalMs);
		const deadline = Date.now() + timeout;
		let payload = await readTurnPayload(turnId, sessionId);
		while (
			payload.ok === true &&
			!TERMINAL_TURN_STATUSES.has((payload.turn as TurnRecord).status) &&
			(payload.turn as TurnRecord).status !== "waiting_for_answer" &&
			Date.now() < deadline
		) {
			const remainingMs = deadline - Date.now();
			await waitForTurnStateChange(namespaceDir, payload.turn as TurnRecord, Math.min(pollInterval, remainingMs));
			payload = await readTurnPayload(turnId, sessionId);
		}
		if (
			payload.ok === true &&
			!TERMINAL_TURN_STATUSES.has((payload.turn as TurnRecord).status) &&
			(payload.turn as TurnRecord).status !== "waiting_for_answer"
		) {
			return {
				ok: false,
				reason: "timeout",
				turn: payload.turn,
				advisory_status: payload.advisory_status,
				session_state: payload.session_state,
			};
		}
		return payload;
	}

	function delegateResponsePin(value: unknown): DelegateResponsePinV1 | null {
		const pin = asRecord(value);
		if (
			!pin ||
			typeof pin.session_id !== "string" ||
			!SAFE_EXTERNAL_ID_PATTERN.test(pin.session_id) ||
			typeof pin.coordinator_turn_id !== "string" ||
			!TURN_ID_PATTERN.test(pin.coordinator_turn_id) ||
			typeof pin.prompt_key_digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(pin.prompt_key_digest) ||
			typeof pin.runtime_command_id !== "string" ||
			!SAFE_EXTERNAL_ID_PATTERN.test(pin.runtime_command_id) ||
			typeof pin.runtime_turn_id !== "string" ||
			!SAFE_EXTERNAL_ID_PATTERN.test(pin.runtime_turn_id)
		)
			return null;
		return pin as unknown as DelegateResponsePinV1;
	}

	/** A persisted final response, never admission alone, permits source compaction. */
	async function releaseDelegateResponsePin(rawPin: unknown, idempotencyKey: string): Promise<boolean> {
		const pin = delegateResponsePin(rawPin);
		if (!pin) return false;
		if (!(await readSessionTransaction(questionPaths, pin.session_id))) return true;
		let released = false;
		await withSessionTransaction(questionPaths, pin.session_id, async transaction => {
			const request = transaction.requests.prompts[pin.prompt_key_digest];
			if (request?.delegate_response_pending !== true) {
				released = true;
				return;
			}
			if (
				request.sdk_idempotency_key === idempotencyKey &&
				request.coordinator_turn_id === pin.coordinator_turn_id &&
				request.runtime_receipt?.accepted === true &&
				request.runtime_receipt.command_id === pin.runtime_command_id &&
				request.runtime_receipt.turn_id === pin.runtime_turn_id
			) {
				delete request.delegate_response_pending;
				released = true;
			}
		}).catch(error => {
			if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
			released = true;
		});
		return released;
	}

	async function reconcileCompletedDelegateResponsePins(): Promise<void> {
		const roster = await readSchedulerRoster(questionPaths);
		let persisted: string[];
		try {
			persisted = await (services.readCoordinatorSessionEntries ?? fs.readdir)(questionPaths.sessions);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			persisted = [];
		}
		const sessionIds = [
			...new Set([
				...roster.roster.map(entry => entry.session_id),
				...persisted.filter(entry => COORDINATOR_SESSION_ID_PATTERN.test(entry)),
			]),
		].sort();
		// Readiness recurs even after a clean scan: another coordinator may create
		// a pin later. Bound WAL reads and receipt inspections per pass, and resume
		// within a session when its pins exhaust the shared budget.
		const cursor = delegatePinCursor;
		const nextIndex = sessionIds.findIndex(
			id => cursor === null || (cursor.promptKey !== null ? id >= cursor.sessionId : id > cursor.sessionId),
		);
		const start = nextIndex < 0 ? 0 : nextIndex;
		let remainingPins = 32;
		const failures: unknown[] = [];
		for (let offset = 0; offset < Math.min(sessionIds.length, 32) && remainingPins > 0; offset++) {
			const sessionId = sessionIds[(start + offset) % sessionIds.length]!;
			const afterPrompt = offset === 0 && sessionId === cursor?.sessionId ? cursor.promptKey : null;
			delegatePinCursor = { sessionId, promptKey: null };
			let transaction: CoordinatorSessionTransactionV1 | null;
			try {
				transaction = await readSessionTransaction(questionPaths, sessionId);
			} catch (error) {
				failures.push(error);
				continue;
			}
			if (!transaction) continue;
			for (const promptKey of Object.keys(transaction.requests.prompts).sort()) {
				if (afterPrompt !== null && promptKey <= afterPrompt) continue;
				const request = transaction.requests.prompts[promptKey]!;
				if (request.delegate_response_pending !== true) continue;
				if (remainingPins === 0) break;
				remainingPins--;
				delegatePinCursor = { sessionId, promptKey };
				const keyDigest = createHash("sha256").update(request.sdk_idempotency_key).digest("hex");
				const file = path.join(namespaceDir, "idempotency", `${keyDigest}.json`);
				try {
					// Receipts are atomically replaced. An in-progress delegate may own
					// its caller-key lock throughout observation; maintenance must not wait
					// for it. Completed candidates still need a locked authoritative read.
					const candidate = await readCoordinatorIdempotencyFile(file);
					if (candidate.kind === "corrupt") throw new Error("delegate_response_receipt_corrupt");
					if (candidate.kind !== "record" || candidate.value.state !== "completed") continue;
					// A completed receipt can still have a live writer finishing cleanup.
					// Busy candidates remain pinned until a later round-robin pass.
					await tryWithSessionStateFileLock(
						path.join(namespaceDir, "idempotency-locks", `${keyDigest}.json`),
						async () => {
							const current = await readCoordinatorIdempotencyFile(file);
							if (current.kind === "missing") return;
							if (current.kind === "corrupt") throw new Error("delegate_response_receipt_corrupt");
							if (current.value.state !== "completed") return;
							// Match replay's response requirement before relinquishing canonical
							// recovery evidence. Public response subfields may be truncated.
							if (!asRecord(current.value.response)) throw new Error("delegate_response_receipt_corrupt");
							const pin = delegateResponsePin(current.value.delegate_response_pin);
							if (
								current.value.key_digest !== keyDigest ||
								pin?.session_id !== sessionId ||
								pin.prompt_key_digest !== promptKey ||
								!(await releaseDelegateResponsePin(pin, request.sdk_idempotency_key))
							)
								throw new Error("delegate_response_pin_mismatch");
						},
					);
				} catch (error) {
					failures.push(error);
				}
			}
			if (remainingPins > 0) delegatePinCursor = { sessionId, promptKey: null };
		}
		if (failures.length > 0) throw new AggregateError(failures, "delegate_response_pin_recovery_incomplete");
	}

	function hasInitialDelegatePromptAuthority(
		transaction: CoordinatorSessionTransactionV1 | null,
		request: CoordinatorSessionTransactionV1["recovery"]["initial_delegate_request"],
	): boolean {
		const pending = transaction?.recovery.initial_delegate_request;
		return (
			pending !== undefined &&
			request !== undefined &&
			pending.key_digest === request.key_digest &&
			pending.request_digest === request.request_digest
		);
	}

	async function claimCanonicalPrompt(
		sessionId: string,
		prompt: string,
		operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt",
		idempotencyKey: string,
		retainDelegateResponse = false,
		requireExisting = false,
		initialDelegateRequest?: CoordinatorSessionTransactionV1["recovery"]["initial_delegate_request"],
	): Promise<string> {
		await ensureQuestionTransaction(sessionId);
		const keyDigest = createHash("sha256").update(`${idempotencyKey}\0${operation}`).digest("hex");
		const requestDigest = createHash("sha256").update(`${operation}\0${prompt}`).digest("hex");
		await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
			const existing = transaction.requests.prompts[keyDigest];
			if (existing) {
				if (existing.request_digest !== requestDigest) throw new Error("idempotency_conflict");
				if (existing.phase === "uncertain") throw new Error("terminal_uncertain");
				if (retainDelegateResponse) existing.delegate_response_pending = true;
				// An accepted receipt is durable authority. It is recovered below instead
				// of sending the same remote idempotency key a second time.
				if (existing.phase === "accepted" || existing.phase === "completed" || existing.phase === "claimed") return;
				if (existing.phase === "remote_started") {
					existing.updated_at = new Date().toISOString();
					return;
				}
			}
			// Check under the WAL lock as well as at the delegate boundary: an
			// unpinned historical receipt could compact between those two reads.
			const initialAuthority = hasInitialDelegatePromptAuthority(transaction, initialDelegateRequest);
			if (requireExisting && !initialAuthority) throw new Error("terminal_uncertain");
			const activeTurnId = transaction.canonical.queue.active_turn_id;
			const anotherActiveTurn = Object.values(transaction.canonical.turns).some(turn =>
				ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus),
			);
			const reservedPrompt = Object.values(transaction.requests.prompts).some(
				request =>
					request.operation !== "turn.follow_up" &&
					["claimed", "remote_started", "accepted"].includes(request.phase),
			);
			if (operation === "turn.prompt" && (activeTurnId !== null || anotherActiveTurn || reservedPrompt))
				throw new Error("active_turn_exists");
			if (operation === "turn.abort_and_prompt" && reservedPrompt) throw new Error("active_turn_exists");
			const now = new Date().toISOString();
			const reserved = makeTurnRecord(
				config,
				sessionId,
				prompt,
				operation === "turn.follow_up" ? "queued" : "delivering",
			);
			reserved.delivery.state = "queued";
			reserved.delivery.queued = operation === "turn.follow_up";
			transaction.canonical.turns[reserved.turn_id] = {
				schema_version: 1,
				turn_id: reserved.turn_id,
				session_id: sessionId,
				namespace_id: config.namespace.identity,
				status: reserved.status,
				prompt: reserved.prompt,
				delivery: { ...reserved.delivery },
				runtime_provenance: null,
				question_ids: [],
				final_response: { ...reserved.final_response },
				evidence: [],
				error: null,
				liveness: { ...reserved.liveness },
				created_at: reserved.created_at,
				updated_at: reserved.updated_at,
				started_at: reserved.started_at,
				completed_at: null,
				terminal_fence: null,
			};
			transaction.canonical.queue.ordered_turn_ids = [
				...transaction.canonical.queue.ordered_turn_ids,
				...(operation === "turn.follow_up" ? [reserved.turn_id] : []),
			];
			if (operation !== "turn.follow_up") transaction.canonical.queue.active_turn_id = reserved.turn_id;
			transaction.requests.prompts[keyDigest] = {
				request_id: `prompt:${keyDigest}`,
				key_digest: keyDigest,
				request_digest: requestDigest,
				operation,
				canonical_prompt: { text: prompt },
				sdk_idempotency_key: idempotencyKey,
				phase: "claimed",
				coordinator_turn_id: reserved.turn_id,
				...(retainDelegateResponse ? { delegate_response_pending: true } : {}),
				created_at: now,
				updated_at: now,
			};
			// This transaction replaces pre-dispatch authority with the pinned prompt
			// reservation. Missing historical requests can never reuse that authority.
			if (initialAuthority) delete transaction.recovery.initial_delegate_request;
		});
		return keyDigest;
	}

	/** Remove a reservation when the remote endpoint returned a decided, malformed
	 * acknowledgement. Ambiguous transport outcomes retain the reservation so an
	 * exact-key retry can reconcile the same remote command instead. */
	async function discardUnacceptedPromptReservation(sessionId: string, promptKey: string): Promise<void> {
		await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
			const request = transaction.requests.prompts[promptKey];
			if (!request || request.phase === "accepted" || request.phase === "completed") return;
			const turnId = request.coordinator_turn_id;
			const restoreActiveTurnId =
				turnId && transaction.canonical.queue.active_turn_id === turnId
					? (Object.values(transaction.canonical.turns).find(
							candidate =>
								candidate.turn_id !== turnId && ACTIVE_TURN_STATUSES.has(candidate.status as TurnStatus),
						)?.turn_id ?? null)
					: transaction.canonical.queue.active_turn_id;
			if (turnId) {
				delete transaction.canonical.turns[turnId];
				transaction.canonical.queue.ordered_turn_ids = transaction.canonical.queue.ordered_turn_ids.filter(
					candidate => candidate !== turnId,
				);
				if (transaction.canonical.queue.active_turn_id === turnId)
					transaction.canonical.queue.active_turn_id = restoreActiveTurnId;
				if (
					transaction.canonical.queue.selected_promotion &&
					(transaction.canonical.queue.selected_promotion.from_turn_id === turnId ||
						transaction.canonical.queue.selected_promotion.to_turn_id === turnId)
				)
					transaction.canonical.queue.selected_promotion = null;
			}
			delete transaction.requests.prompts[promptKey];
		});
		// The pre-dispatch correlation is a legacy sidecar projection, not
		// canonical authority. Rebuild it after discarding a decided failure so a
		// failed prompt cannot leave the session reporting phantom running work.
		await repairCanonicalProjections(sessionId);
	}

	async function promptReceipt(sessionId: string, promptKey: string): Promise<RuntimePromptAcknowledgement | null> {
		return await withSessionTransaction(questionPaths, sessionId, async transaction => {
			const request = transaction.requests.prompts[promptKey];
			if (
				!request ||
				(request.phase !== "accepted" && request.phase !== "completed") ||
				request.runtime_receipt?.accepted !== true
			)
				return null;
			const receipt = request.runtime_receipt;
			if (!SAFE_EXTERNAL_ID_PATTERN.test(receipt.command_id) || !SAFE_EXTERNAL_ID_PATTERN.test(receipt.turn_id))
				throw new Error("terminal_uncertain");
			if (request.phase === "completed") {
				const turn = request.coordinator_turn_id ? transaction.canonical.turns[request.coordinator_turn_id] : null;
				if (
					!turn ||
					turn.delivery.runtime_command_id !== receipt.command_id ||
					turn.delivery.runtime_turn_id !== receipt.turn_id
				)
					throw new Error("terminal_uncertain");
			}
			return { accepted: true, command_id: receipt.command_id, turn_id: receipt.turn_id };
		});
	}

	async function persistPromptReceipt(
		sessionId: string,
		promptKey: string,
		acknowledgement: RuntimePromptAcknowledgement,
	): Promise<void> {
		await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
			const request = transaction.requests.prompts[promptKey];
			if (!request) throw new Error("state_corrupt");
			if (request.phase === "completed" && request.runtime_receipt) return;
			if (request.phase !== "remote_started" && request.phase !== "accepted") throw new Error("terminal_uncertain");
			request.phase = "accepted";
			request.runtime_receipt = {
				accepted: true,
				command_id: acknowledgement.command_id,
				turn_id: acknowledgement.turn_id,
			};
			request.updated_at = new Date().toISOString();
		});
	}

	async function dispatchOrRecoverPrompt(
		session: Record<string, unknown>,
		sessionId: string,
		operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt",
		prompt: string,
		idempotencyKey: string,
		promptKey: string,
	): Promise<RuntimePromptAcknowledgement> {
		const recovered = await promptReceipt(sessionId, promptKey);
		if (recovered) return recovered;
		let coordinatorTurnId: string | null = null;
		await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
			const request = transaction.requests.prompts[promptKey];
			if (!request) throw new Error("state_corrupt");
			if (request.phase === "claimed") request.phase = "remote_started";
			if (request.phase !== "remote_started") throw new Error("terminal_uncertain");
			coordinatorTurnId = request.coordinator_turn_id ?? null;
			request.updated_at = new Date().toISOString();
		});
		// Seed a non-authorizing coordinator correlation before the remote request.
		// Runtime terminal events can then retain this turn identity even when they
		// arrive before the broker acknowledgement; admission still requires that
		// durable acknowledgement below.
		if (coordinatorTurnId && operation !== "turn.follow_up")
			await writeSessionState(namespaceDir, sessionId, "running", {
				currentTurnId: coordinatorTurnId,
				lastTurnId: coordinatorTurnId,
				live: null,
				reason: "prompt_reserved",
				source: "coordinator",
				emitEvent: false,
			});
		let acknowledgement: RuntimePromptAcknowledgement;
		try {
			acknowledgement = requirePromptAcknowledgement(
				await controlSession(session, operation, { text: prompt }, idempotencyKey),
			);
		} catch (error) {
			// A malformed or explicitly failed acknowledgement is a decided local
			// failure, not a remote outcome to replay. Leave only ambiguous Router
			// responses retryable under the same prompt idempotency key.
			if (!(error instanceof SdkClientError) || error.code !== "ambiguous")
				await discardUnacceptedPromptReservation(sessionId, promptKey);
			throw error;
		}
		// Persist the receipt before touching projections. A crash after the SDK
		// accepts the command can then rebuild the turn without dispatching again.
		await persistPromptReceipt(sessionId, promptKey, acknowledgement);
		// Test-only barrier for the accepted-receipt/terminal-sidecar interleaving.
		// The production ordering remains receipt first, then canonical finalization.
		await services.afterPromptReceiptPersisted?.(sessionId);
		return acknowledgement;
	}

	type TerminalTransitionInput = {
		desiredState: CoordinatorSessionStateValue;
		reason: PublicReason | null;
		report?: CanonicalReportSnapshotV1;
		promoteQueuedTurn?: boolean;
	};
	type TerminalTransitionResult = {
		promotedTurnId: string | null;
		desiredState: CoordinatorSessionStateValue;
		transitioned: boolean;
	};

	/** Commits terminal fencing, question revocation, report, and promotion together before legacy projection. */
	async function commitTerminalTransition(
		turn: TurnRecord,
		input: TerminalTransitionInput,
	): Promise<TerminalTransitionResult> {
		await ensureQuestionTransaction(turn.session_id);
		return await withAdmittedSessionTransaction(questionPaths, turn.session_id, async transaction => {
			const existing = transaction.canonical.turns[turn.turn_id];
			if (existing?.terminal_fence) {
				/* First terminal, including cancellation, owns the fence. A later report
				 * is retained as evidence but cannot overwrite canonical receipt/state. */
				if (input.report) {
					transaction.canonical.reports[input.report.report_id] = input.report;
					const reportEventId = deterministicOutboxId(
						turn.session_id,
						transaction.revision + 1,
						"report.written",
						"report",
						input.report.report_id,
						transaction.canonical.session.broker.endpoint_incarnation,
					);
					transaction.outbox[reportEventId] ??= {
						id: reportEventId,
						transaction_revision: transaction.revision + 1,
						kind: "report.written",
						entity: "report",
						entity_id: input.report.report_id,
						payload: {
							session_id: turn.session_id,
							turn_id: turn.turn_id,
							report_id: input.report.report_id,
							status: input.report.status,
							created_at: input.report.created_at,
						},
						emitted: false,
						public_event_id: reportEventId,
						public_delivery: {
							public_event_id: reportEventId,
							state: "pending",
							claim_fence: null,
							claim_expires_at: null,
							journal_seq: null,
							acknowledged_at: null,
						},
					};
				}
				return {
					promotedTurnId: transaction.canonical.queue.active_turn_id,
					desiredState: transaction.canonical.desired_session_state,
					transitioned: false,
				};
			}
			const terminalEpoch = transaction.revision + 1;
			const activeTurnId = transaction.canonical.queue.active_turn_id;
			const isActiveTurn = activeTurnId === turn.turn_id;
			transaction.canonical.turns[turn.turn_id] = {
				schema_version: 1,
				turn_id: turn.turn_id,
				session_id: turn.session_id,
				namespace_id: config.namespace.identity,
				status: turn.status,
				prompt: turn.prompt,
				delivery: { ...turn.delivery },
				runtime_provenance: null,
				question_ids: Object.values(transaction.canonical.questions)
					.filter(question => question.turn_id === turn.turn_id)
					.map(question => question.question_id),
				final_response: { ...turn.final_response },
				evidence: turn.evidence,
				error: turn.error ? { ...turn.error } : null,
				liveness: { ...turn.liveness },
				created_at: turn.created_at,
				updated_at: turn.updated_at,
				started_at: turn.started_at,
				completed_at: turn.completed_at,
				terminal_fence: {
					epoch: terminalEpoch,
					status: turn.status,
					reason: input.reason,
					at: turn.completed_at ?? turn.updated_at,
				},
			};
			for (const question of Object.values(transaction.canonical.questions)) {
				if (question.turn_id !== turn.turn_id || question.status === "answered") continue;
				question.status = "stale";
				question.claim_fence_epoch = terminalEpoch;
				question.updated_at = turn.updated_at;
				question.history.push({
					at: turn.updated_at,
					status: "stale",
					reason: input.reason ?? "terminal_uncertain",
				});
			}
			if (input.report) transaction.canonical.reports[input.report.report_id] = input.report;
			const next =
				isActiveTurn && input.promoteQueuedTurn !== false
					? (Object.values(transaction.canonical.turns)
							.filter(candidate => candidate.status === "queued")
							.sort((left, right) => left.created_at.localeCompare(right.created_at))[0] ?? null)
					: null;
			if (next) {
				const timestamp = new Date().toISOString();
				next.status = "active";
				next.started_at = timestamp;
				next.updated_at = timestamp;
			}
			transaction.canonical.queue.ordered_turn_ids = Object.values(transaction.canonical.turns)
				.filter(candidate => candidate.status === "queued")
				.map(candidate => candidate.turn_id);
			transaction.canonical.queue.active_turn_id = isActiveTurn ? (next?.turn_id ?? null) : activeTurnId;
			transaction.canonical.queue.selected_promotion =
				isActiveTurn && next
					? { from_turn_id: turn.turn_id, to_turn_id: next.turn_id, revision: terminalEpoch }
					: null;
			transaction.canonical.desired_session_state = isActiveTurn
				? next
					? "running"
					: input.desiredState
				: transaction.canonical.desired_session_state;
			const eventKind = turnEventKind(turn.status) ?? "turn.terminal";
			const eventId = deterministicOutboxId(
				turn.session_id,
				terminalEpoch,
				eventKind,
				"turn",
				turn.turn_id,
				transaction.canonical.session.broker.endpoint_incarnation,
			);
			transaction.outbox[eventId] ??= {
				id: eventId,
				transaction_revision: terminalEpoch,
				kind: eventKind,
				entity: "turn",
				entity_id: turn.turn_id,
				payload: {
					session_id: turn.session_id,
					turn_id: turn.turn_id,
					status: turn.status,
					created_at: turn.updated_at,
				},
				emitted: false,
				public_event_id: eventId,
				public_delivery: {
					public_event_id: eventId,
					state: "pending",
					claim_fence: null,
					claim_expires_at: null,
					journal_seq: null,
					acknowledged_at: null,
				},
			};
			if (input.report) {
				const reportEventId = deterministicOutboxId(
					turn.session_id,
					terminalEpoch,
					"report.written",
					"report",
					input.report.report_id,
					transaction.canonical.session.broker.endpoint_incarnation,
				);
				transaction.outbox[reportEventId] ??= {
					id: reportEventId,
					transaction_revision: terminalEpoch,
					kind: "report.written",
					entity: "report",
					entity_id: input.report.report_id,
					payload: {
						session_id: turn.session_id,
						turn_id: turn.turn_id,
						report_id: input.report.report_id,
						status: input.report.status,
						created_at: input.report.created_at,
					},
					emitted: false,
					public_event_id: reportEventId,
					public_delivery: {
						public_event_id: reportEventId,
						state: "pending",
						claim_fence: null,
						claim_expires_at: null,
						journal_seq: null,
						acknowledged_at: null,
					},
				};
			}
			return {
				promotedTurnId: next?.turn_id ?? null,
				desiredState: isActiveTurn && next ? "running" : transaction.canonical.desired_session_state,
				transitioned: true,
			};
		});
	}

	function turnFromCanonical(turn: CoordinatorSessionTransactionV1["canonical"]["turns"][string]): TurnRecord {
		return {
			schema_version: 1,
			turn_id: turn.turn_id,
			session_id: turn.session_id,
			namespace: config.namespace,
			status: turn.status as TurnStatus,
			prompt: turn.prompt as TurnRecord["prompt"],
			delivery: turn.delivery as TurnRecord["delivery"],
			runtime_provenance: turn.runtime_provenance,
			question_ids: [...turn.question_ids],
			final_response: turn.final_response as TurnRecord["final_response"],
			evidence: [...turn.evidence],
			error: turn.error as TurnRecord["error"],
			liveness: turn.liveness as TurnRecord["liveness"],
			created_at: turn.created_at,
			updated_at: turn.updated_at,
			started_at: turn.started_at,
			completed_at: turn.completed_at,
		};
	}

	/** Rebuild every legacy projection from the committed canonical snapshot. */
	async function repairCanonicalProjections(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		await repairProjections(
			questionPaths,
			sessionId,
			async canonical => {
				await writeJsonFile(sessionFile(sessionId), sessionFromCreationSnapshot(canonical.session));
				for (const turn of Object.values(canonical.turns))
					await writeTurnRecord(namespaceDir, turnFromCanonical(turn));
				for (const report of Object.values(canonical.reports))
					await writeJsonFile(reportProjectionFile(namespaceDir, report.report_id), report);
				const activeId = canonical.queue.selected_promotion?.to_turn_id ?? canonical.queue.active_turn_id;
				const active = activeId ? canonical.turns[activeId] : null;
				if (active) await writeActiveTurn(namespaceDir, turnFromCanonical(active));
				else {
					// The canonical queue is authoritative under this repair lock. Remove
					// any stale pointer directly: once the turn projection is rewritten
					// terminal, readActiveTurn() intentionally rejects it and cannot
					// discover the legacy active-turn file to clear.
					await removeCoordinatorFile(activeTurnFile(namespaceDir, sessionId));
				}
				// A runtime sidecar can advance a live session while the canonical WAL still
				// needs projection repair. Preserve that observed lifecycle state (and its
				// activity snapshot) instead of letting a repair briefly roll it back to the
				// WAL's older desired state, unless the WAL already proves a terminal state.
				const runtimeState = await readSessionState(namespaceDir, sessionId);
				const canonicalTerminal =
					canonical.desired_session_state === "completed" || canonical.desired_session_state === "errored";
				const runtimeTurnId = runtimeState?.current_turn_id ?? runtimeState?.last_turn_id;
				const runtimeTurn = runtimeTurnId ? canonical.turns[runtimeTurnId] : undefined;
				// A terminal sidecar is authoritative only after the broker receipt is
				// durable. Preserve that observation across a lagging projection repair so
				// the next admission pass can install the canonical terminal fence; a
				// pre-ack terminal observation is intentionally rolled back to canonical
				// state and cannot become a public terminal event.
				const terminalRuntimeReceipt = Boolean(
					runtimeState?.source === "agent_session_event" &&
						(runtimeState.live === true || runtimeState.live === false) &&
						(runtimeState.state === "completed" || runtimeState.state === "errored") &&
						runtimeTurn &&
						hasAcceptedRuntimeReceipt({ delivery: runtimeTurn.delivery }),
				);
				const terminalRuntimeState = Boolean(
					terminalRuntimeReceipt && ACTIVE_TURN_STATUSES.has(runtimeTurn!.status as TurnStatus),
				);
				const terminalRuntimeProjection = Boolean(
					terminalRuntimeReceipt &&
						canonicalTerminal &&
						runtimeTurn!.terminal_fence &&
						runtimeState!.state === canonical.desired_session_state,
				);
				const runtimeStateToPreserve =
					!canonicalTerminal &&
					runtimeState &&
					runtimeState.source === "agent_session_event" &&
					((runtimeState.live === true &&
						(runtimeState.state === "ready_for_input" ||
							runtimeState.state === "running" ||
							runtimeState.state === "needs_user_input")) ||
						terminalRuntimeState)
						? runtimeState
						: null;
				await writeSessionState(
					namespaceDir,
					sessionId,
					runtimeStateToPreserve?.state ?? canonical.desired_session_state,
					{
						currentTurnId: runtimeStateToPreserve
							? runtimeStateToPreserve.current_turn_id
							: (active?.turn_id ?? null),
						lastTurnId: runtimeStateToPreserve
							? runtimeStateToPreserve.last_turn_id
							: terminalRuntimeProjection
								? runtimeState?.last_turn_id
								: (canonical.queue.selected_promotion?.from_turn_id ?? null),
						live: runtimeStateToPreserve ? runtimeStateToPreserve.live : null,
						reason: runtimeStateToPreserve ? runtimeStateToPreserve.reason : null,
						source:
							runtimeStateToPreserve?.source ?? (terminalRuntimeProjection ? runtimeState?.source : undefined),
						overwrite: runtimeStateToPreserve === null,
						emitEvent: false,
					},
				);
			},
			options,
		);
		await exportRetainedDeliveries(32, options.signal);
	}

	async function recoverCanonicalSessionProjection(sessionId: string): Promise<void> {
		const transaction = await readSessionTransaction(questionPaths, sessionId);
		if (!transaction) return;
		const applied = Math.min(
			transaction.projection.applied_turns_revision,
			transaction.projection.applied_reports_revision,
			transaction.projection.applied_session_revision,
			transaction.projection.applied_active_revision,
			transaction.projection.applied_events_revision,
		);
		if (applied < transaction.revision) await repairCanonicalProjections(sessionId);
	}

	async function recoverCanonicalNamespaceProjections(scopedSessionId: string | null = null): Promise<void> {
		await ensureQuestionStateReady();
		const roster = await readSchedulerRoster(questionPaths);
		const persisted = await fs.readdir(questionPaths.sessions).catch(() => []);
		const sessions = [
			...new Set([
				...roster.roster.map(entry => entry.session_id),
				...persisted.filter(entry => COORDINATOR_SESSION_ID_PATTERN.test(entry)),
			]),
		].filter(sessionId => scopedSessionId === null || sessionId === scopedSessionId);
		for (const sessionId of sessions) {
			try {
				const transaction = await readSessionTransaction(questionPaths, sessionId);
				if (!transaction) continue;
				await assertPersistedSessionAuthority(transaction.canonical.session);
				await recoverCanonicalSessionProjection(sessionId);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					(error.message !== "state_corrupt" && (scopedSessionId !== null || !isSessionAuthorityError(error)))
				)
					throw error;
			}
		}
	}

	async function projectTerminalTransition(
		turn: TurnRecord,
		input: TerminalTransitionInput & {
			live?: boolean | null;
			signal?: AbortSignal;
		},
	): Promise<TerminalTransitionResult> {
		const result = await commitTerminalTransition(turn, input);
		if (input.report) await services.afterCanonicalReportCommit?.(turn.session_id);
		await repairCanonicalProjections(turn.session_id, { signal: input.signal });
		return result;
	}

	async function commitCanonicalTurn(
		sessionId: string,
		turn: TurnRecord,
		promptKey: string | null = null,
	): Promise<{ turn: TurnRecord; acknowledgementLinked: boolean }> {
		await ensureQuestionTransaction(sessionId);
		return await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
			const existing = transaction.canonical.turns[turn.turn_id];
			if (existing?.terminal_fence) {
				/* A sidecar terminal observation owns this turn. Finalization may only
				 * link the accepted receipt when the reservation and runtime identities
				 * still correlate; it must never rebuild status, fencing, or queue state. */
				let acknowledgementLinked = false;
				if (promptKey) {
					const request = transaction.requests.prompts[promptKey];
					const commandId = turn.delivery.runtime_command_id;
					const runtimeTurnId = turn.delivery.runtime_turn_id;
					const receipt = request?.runtime_receipt;
					const requestOwnsTurn = request?.coordinator_turn_id === existing.turn_id;
					const receiptMatches =
						!receipt || (receipt.command_id === commandId && receipt.turn_id === runtimeTurnId);
					const existingCommandId =
						typeof existing.delivery.runtime_command_id === "string"
							? existing.delivery.runtime_command_id
							: null;
					const existingRuntimeTurnId =
						typeof existing.delivery.runtime_turn_id === "string" ? existing.delivery.runtime_turn_id : null;
					const deliveryMatches =
						(existingCommandId === null || existingCommandId === commandId) &&
						(existingRuntimeTurnId === null || existingRuntimeTurnId === runtimeTurnId);
					if (request && requestOwnsTurn && receiptMatches && deliveryMatches && commandId && runtimeTurnId) {
						const attempts = Array.isArray(existing.delivery.attempts) ? existing.delivery.attempts : [];
						const hasRuntimeAcknowledgement = attempts.some(candidate => {
							const attempt = asRecord(candidate);
							return attempt?.channel === "runtime_ack" && attempt.reason === "runtime_acknowledged";
						});
						existing.delivery = {
							...existing.delivery,
							delivered: true,
							prompt_acknowledged: true,
							runtime_command_id: commandId,
							runtime_turn_id: runtimeTurnId,
							state: "acknowledged",
							attempts: hasRuntimeAcknowledgement
								? attempts
								: [
										...attempts,
										{
											delivered: true,
											created_at: turn.updated_at,
											channel: "runtime_ack",
											reason: "runtime_acknowledged",
										},
									],
						};
						request.phase = "completed";
						request.runtime_receipt = {
							accepted: true,
							command_id: commandId,
							turn_id: runtimeTurnId,
						};
						request.updated_at = turn.updated_at;
						acknowledgementLinked = true;
					}
				}
				return { turn: turnFromCanonical(existing), acknowledgementLinked };
			}
			const terminal = TERMINAL_TURN_STATUSES.has(turn.status);
			transaction.canonical.turns[turn.turn_id] = {
				schema_version: 1,
				turn_id: turn.turn_id,
				session_id: sessionId,
				namespace_id: config.namespace.identity,
				status: turn.status,
				prompt: turn.prompt,
				delivery: { ...turn.delivery },
				runtime_provenance: null,
				question_ids: Object.values(transaction.canonical.questions)
					.filter(question => question.turn_id === turn.turn_id)
					.map(question => question.question_id),
				final_response: { ...turn.final_response },
				evidence: turn.evidence,
				error: turn.error ? { ...turn.error } : null,
				liveness: { ...turn.liveness },
				created_at: turn.created_at,
				updated_at: turn.updated_at,
				started_at: turn.started_at,
				completed_at: turn.completed_at,
				terminal_fence: terminal
					? {
							epoch: transaction.revision + 1,
							status: turn.status,
							reason: null,
							at: turn.completed_at ?? turn.updated_at,
						}
					: null,
			};
			transaction.canonical.queue.ordered_turn_ids = Object.values(transaction.canonical.turns)
				.filter(candidate => candidate.status === "queued")
				.map(candidate => candidate.turn_id);
			transaction.canonical.queue.active_turn_id = terminal
				? null
				: turn.delivery.queued
					? transaction.canonical.queue.active_turn_id
					: turn.turn_id;
			if (!terminal && !turn.delivery.queued) transaction.canonical.desired_session_state = "running";
			transaction.recovery.prompt_watermark_at = turn.updated_at;
			const lifecycleKind = turnEventKind(turn.status);
			if (lifecycleKind) {
				const lifecycleEventId = deterministicOutboxId(
					sessionId,
					transaction.revision + 1,
					lifecycleKind,
					"turn",
					turn.turn_id,
					transaction.canonical.session.broker.endpoint_incarnation,
				);
				transaction.outbox[lifecycleEventId] ??= {
					id: lifecycleEventId,
					transaction_revision: transaction.revision + 1,
					kind: lifecycleKind,
					entity: "turn",
					entity_id: turn.turn_id,
					payload: {
						session_id: sessionId,
						turn_id: turn.turn_id,
						status: turn.status,
						created_at: turn.updated_at,
					},
					emitted: false,
					public_event_id: lifecycleEventId,
					public_delivery: {
						public_event_id: lifecycleEventId,
						state: "pending",
						claim_fence: null,
						claim_expires_at: null,
						journal_seq: null,
						acknowledged_at: null,
					},
				};
			}
			if (terminal)
				for (const question of Object.values(transaction.canonical.questions)) {
					if (question.turn_id !== turn.turn_id || question.status === "answered") continue;
					question.status = "stale";
					question.claim_fence_epoch = transaction.revision + 1;
					question.updated_at = turn.updated_at;
					question.history.push({ at: turn.updated_at, status: "stale", reason: "terminal_uncertain" });
				}
			if (promptKey) {
				const request = transaction.requests.prompts[promptKey];
				if (!request) throw new Error("state_corrupt");
				request.phase = "completed";
				request.coordinator_turn_id = turn.turn_id;
				request.runtime_receipt = {
					accepted: true,
					command_id: String(turn.delivery.runtime_command_id),
					turn_id: String(turn.delivery.runtime_turn_id),
				};
				request.updated_at = turn.updated_at;
			}
			return {
				turn: turnFromCanonical(transaction.canonical.turns[turn.turn_id]),
				acknowledgementLinked: true,
			};
		});
	}

	async function recordAcceptedPrompt(
		sessionId: string,
		prompt: string,
		operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt",
		previousActiveTurn: TurnRecord | null,
		acknowledgement: RuntimePromptAcknowledgement,
		promptKey: string | null = null,
	): Promise<TurnRecord> {
		if (promptKey) {
			const recovered = await withSessionTransaction(questionPaths, sessionId, async transaction => {
				const request = transaction.requests.prompts[promptKey];
				const turnId = request?.coordinator_turn_id;
				const canonical = turnId ? transaction.canonical.turns[turnId] : undefined;
				return request?.phase === "completed" && canonical ? canonical : null;
			});
			if (recovered) {
				await repairCanonicalProjections(sessionId);
				return turnFromCanonical(recovered);
			}
		}
		const timestamp = new Date().toISOString();
		if (operation === "turn.abort_and_prompt" && previousActiveTurn) {
			const superseded: TurnRecord = {
				...previousActiveTurn,
				status: "superseded",
				updated_at: timestamp,
				completed_at: timestamp,
			};
			await projectTerminalTransition(superseded, {
				desiredState: "running",
				reason: null,
				promoteQueuedTurn: false,
			});
		}
		const queued = operation === "turn.follow_up";
		let turn: TurnRecord | null = null;
		if (promptKey) {
			const reservation = await withSessionTransaction(questionPaths, sessionId, async transaction => {
				const request = transaction.requests.prompts[promptKey];
				const canonical = request?.coordinator_turn_id
					? transaction.canonical.turns[request.coordinator_turn_id]
					: undefined;
				return request?.phase === "accepted" && canonical ? turnFromCanonical(canonical) : null;
			});
			if (reservation) turn = reservation;
		}
		turn ??= makeTurnRecord(config, sessionId, prompt, queued ? "queued" : "active");
		turn.status = queued ? "queued" : "active";
		turn.started_at ??= queued ? null : timestamp;
		turn.updated_at = timestamp;
		turn.delivery = {
			delivered: true,
			queued,
			target: null,
			prompt_acknowledged: true,
			runtime_command_id: acknowledgement.command_id,
			runtime_turn_id: acknowledgement.turn_id,
			state: "acknowledged",
			attempts: [{ delivered: true, channel: "runtime_ack", created_at: timestamp, reason: null }],
		};
		const committed = await commitCanonicalTurn(sessionId, turn, promptKey);
		turn = committed.turn;
		if (TERMINAL_TURN_STATUSES.has(turn.status)) {
			// The sidecar terminal fence won while the prompt was in flight. Keep the
			// canonical terminal outcome and rebuild every legacy projection from it;
			// never restore the reserved turn as active or running.
			if (committed.acknowledgementLinked) await publishAcknowledgedTurnIntent(turn);
			await repairCanonicalProjections(sessionId);
			await exportRetainedDeliveries();
			return turn;
		}
		const acceptedTurnId = turn?.turn_id;
		if (!acceptedTurnId) throw new Error("accepted_turn_missing");
		// Test-only barrier for the terminal-after-finalization interleaving. The
		// projection repair below still re-reads canonical state under the WAL lock.
		await services.afterCanonicalTurnCommit?.(sessionId);
		// Re-read canonical state while holding the WAL transaction lock before every
		// legacy projection. A terminal reconciliation that commits after the accepted
		// turn cannot be followed by stale active/running writes.
		await repairCanonicalProjections(sessionId);
		// A terminal reconciliation may have won at the barrier; return the current
		// canonical turn and publish the acknowledgement against that durable state.
		const projectedCanonical = await withSessionTransaction(
			questionPaths,
			sessionId,
			async transaction => transaction.canonical.turns[acceptedTurnId] ?? null,
		);
		if (projectedCanonical) turn = turnFromCanonical(projectedCanonical);
		// The broker acknowledgement is a logical lifecycle edge, not a projection
		// observation. Persist its outbox intent after the accepted receipt so a
		// prompt that was acknowledged before any runtime sidecar event still has
		// exactly one durable `turn.acknowledged` event.
		await publishAcknowledgedTurnIntent(turn);
		await exportRetainedDeliveries();
		return turn;
	}

	async function reconcileWatchAdmissions(
		prioritySessionId: string | undefined,
		options: { absoluteDeadline?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const rosterState = await readSchedulerRoster(questionPaths, { signal: options.signal });
		const canonicalActiveIds = await listCanonicalActiveSessions(questionPaths, {
			signal: options.signal,
		});
		const rosterById = new Map(rosterState.roster.map(entry => [entry.session_id, entry]));
		for (const sessionId of canonicalActiveIds)
			if (!rosterById.has(sessionId))
				rosterById.set(sessionId, {
					session_id: sessionId,
					revision: 0,
					digest: "",
					active: true,
					dirty: true,
					updated_at: "",
				});
		const all = [...rosterById.values()].sort((left, right) => left.session_id.localeCompare(right.session_id));
		const prioritized = prioritySessionId
			? [
					...all.filter(entry => entry.session_id === prioritySessionId),
					...all.filter(entry => entry.session_id !== prioritySessionId),
				]
			: all;
		const start = prioritized.findIndex(entry => entry.session_id > rosterState.cursor);
		const ordered = [...prioritized.slice(start < 0 ? 0 : start), ...prioritized.slice(0, start < 0 ? 0 : start)];
		let processedCursor: string | null = null;
		for (const entry of ordered.slice(0, MAX_RUNTIME_SESSIONS_PER_WATCH_PASS)) {
			if (
				options.signal?.aborted ||
				(options.absoluteDeadline !== undefined && Date.now() >= options.absoluteDeadline)
			)
				break;
			processedCursor = entry.session_id;
			try {
				await reconcileSessionRuntime(entry.session_id, options);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					(error.message !== "resource_gone" &&
						(prioritySessionId !== undefined || !isSessionAuthorityError(error)))
				)
					throw error;
			}
		}
		if (processedCursor && !options.signal?.aborted)
			await advanceSchedulerCursor(questionPaths, processedCursor, { signal: options.signal });
	}

	async function reconcileWatchEventSessions(
		snapshot: EventJournalSnapshot,
		afterSeq: number,
		options: { absoluteDeadline?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const sessionIds = [
			...new Set(
				snapshot.events
					.filter(event => event.seq > afterSeq && typeof event.session_id === "string")
					.map(event => event.session_id as string),
			),
		].slice(0, MAX_RUNTIME_SESSIONS_PER_WATCH_PASS);
		for (const sessionId of sessionIds) {
			if (
				options.signal?.aborted ||
				(options.absoluteDeadline !== undefined && Date.now() >= options.absoluteDeadline)
			)
				break;
			try {
				await reconcileSessionRuntime(sessionId, options);
				await reconcileQuestions(sessionId, options);
			} catch (error) {
				if (!(error instanceof Error) || (error.message !== "resource_gone" && !isSessionAuthorityError(error)))
					throw error;
			}
		}
	}

	/** Reconcile a bounded, persisted round-robin slice of Q12 sessions. */
	async function reconcileWatchQuestions(
		prioritySessionId: string | undefined,
		options: { absoluteDeadline?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const rosterState = await readSchedulerRoster(questionPaths, { signal: options.signal });
		const eligible = [...rosterState.roster].sort((left, right) => left.session_id.localeCompare(right.session_id));
		const priority = prioritySessionId ? eligible.filter(entry => entry.session_id === prioritySessionId) : [];
		const roundRobinPool = prioritySessionId
			? eligible.filter(entry => entry.session_id !== prioritySessionId)
			: eligible;
		const start = roundRobinPool.findIndex(entry => entry.session_id > rosterState.cursor);
		const rotated = [
			...roundRobinPool.slice(start < 0 ? 0 : start),
			...roundRobinPool.slice(0, start < 0 ? 0 : start),
		];
		const ordered = [...priority, ...rotated];
		let processedCursor: string | null = null;
		for (const entry of ordered.slice(0, MAX_Q12_ATTEMPTS_PER_WATCH_PASS)) {
			if (
				options.signal?.aborted ||
				(options.absoluteDeadline !== undefined && Date.now() >= options.absoluteDeadline)
			)
				break;
			processedCursor = entry.session_id;
			try {
				await reconcileQuestions(entry.session_id, options);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					(error.message !== "resource_gone" &&
						(prioritySessionId !== undefined || !isSessionAuthorityError(error)))
				)
					throw error;
			}
		}
		if (processedCursor && !options.signal?.aborted)
			await advanceSchedulerCursor(questionPaths, processedCursor, { signal: options.signal });
	}

	async function reconcileActiveTurnAcknowledgements(
		maxSessions = MAX_RUNTIME_SESSIONS_PER_WATCH_PASS,
		prioritySessionId?: string,
		options: { absoluteDeadline?: number; signal?: AbortSignal } = {},
	): Promise<void> {
		const rosterState = await readSchedulerRoster(questionPaths, { signal: options.signal });
		const eligible = rosterState.roster.sort((left, right) => left.session_id.localeCompare(right.session_id));
		const prioritized = prioritySessionId
			? [
					...eligible.filter(entry => entry.session_id === prioritySessionId),
					...eligible.filter(entry => entry.session_id !== prioritySessionId),
				]
			: eligible;
		const start = prioritized.findIndex(entry => entry.session_id > rosterState.cursor);
		const ordered = [...prioritized.slice(start < 0 ? 0 : start), ...prioritized.slice(0, start < 0 ? 0 : start)];
		const entries = ordered.slice(0, Math.max(1, maxSessions));
		let processedCursor: string | null = null;
		for (const entry of entries) {
			if (
				options.signal?.aborted ||
				(options.absoluteDeadline !== undefined && Date.now() >= options.absoluteDeadline)
			)
				break;
			let turn: TurnRecord | null = null;
			try {
				const transaction = await readSessionTransaction(questionPaths, entry.session_id);
				if (!transaction) {
					processedCursor = entry.session_id;
					continue;
				}
				await assertPersistedSessionAuthority(transaction.canonical.session);
				turn = await readActiveTurn(namespaceDir, entry.session_id);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					(error.message !== "resource_gone" &&
						error.message !== "coordinator_workdir_outside_allowed_roots" &&
						error.message !== "coordinator_workdir_roots_required" &&
						error.message !== "coordinator_workspace_required")
				)
					throw error;
			}
			processedCursor = entry.session_id;
			if (!turn) continue;
			let sessionState = await readSessionState(namespaceDir, turn.session_id);
			let resolvedTurn = await reconcileRuntimeAcknowledgement(
				namespaceDir,
				turn,
				sessionState,
				promptAckTimeoutMs,
				{ failOnTimeout: false, onAcknowledged: publishAcknowledgedTurnIntent },
			);
			if (!ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
				await projectTerminalTransition(resolvedTurn, {
					desiredState: "stale",
					reason: "terminal_uncertain",
					live: resolvedTurn.liveness.live,
				});
				continue;
			}
			if (resolvedTurn !== turn) sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
			const session = asRecord(await readJsonFile(sessionFile(resolvedTurn.session_id)));
			if (!session) {
				resolvedTurn = await markTurnFailedForUnavailableSession(resolvedTurn, "session_record_missing");
				await projectTerminalTransition(resolvedTurn, {
					desiredState: "stale",
					reason: "session_unavailable",
					live: false,
				});
				continue;
			}
			resolvedTurn = await reconcileRuntimeAcknowledgement(
				namespaceDir,
				resolvedTurn,
				sessionState,
				promptAckTimeoutMs,
				{ failOnTimeout: true, onAcknowledged: publishAcknowledgedTurnIntent },
			);
			if (!ACTIVE_TURN_STATUSES.has(resolvedTurn.status))
				await projectTerminalTransition(resolvedTurn, {
					desiredState: "stale",
					reason: "terminal_uncertain",
					live: resolvedTurn.liveness.live,
				});
		}
		if (processedCursor && !options.signal?.aborted)
			await advanceSchedulerCursor(questionPaths, processedCursor, { signal: options.signal });
	}

	async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			// Run startup maintenance before any tool-specific idempotency/session
			// lock is acquired. Nested state initialization must never invert those locks.
			await ensureQuestionStateReady();
			if (name === "gjc_coordinator_list_sessions") {
				// listSessions() enumerates the broker across allowed roots, but every other
				// coordinator tool resolves a session through its durable projection. Without
				// an explicit marker a controller cannot tell the two apart and burns a
				// not_found round-trip per unregistered session, which trips client-side
				// consecutive-failure breakers. Publish registration as first-class state.
				// The marker is a point-in-time hint: a projection can be created or reaped
				// between this listing and the caller's next tool call, and the session-scoped
				// tools remain the authority for that moment.
				const registered = await registeredSessionIds();
				const sessions = (await listSessions()).map(session => ({
					...publicBrokerSession(session),
					registered: registeredSessionMarker(registered, session),
				}));
				return { ok: true, sessions };
			}
			if (name === "gjc_coordinator_register_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				const cwd = await canonicalBrokerWorkspace(await assertCoordinatorWorkdir(config, args.cwd));
				const tmuxSession = optionalString(args.tmux_session) ? safeTmuxSessionName(args.tmux_session) : undefined;
				const tmuxTarget = optionalString(args.tmux_target) ? safeTmuxTarget(args.tmux_target) : undefined;
				const canonicalArgs = {
					session_id: sessionId,
					cwd,
					...(tmuxSession ? { tmux_session: tmuxSession } : {}),
					...(tmuxTarget ? { tmux_target: tmuxTarget } : {}),
					visible: args.visible !== false,
					source: optionalString(args.source) ?? "register_session",
					model: optionalString(args.model),
					allow_mutation: true,
				};
				const binding = await exactBrokerSessionBinding(sessionId, cwd);
				const priorSession = asRecord(await readJsonFile(sessionFile(sessionId)));
				const priorAuthority =
					priorSession &&
					priorSession.broker_workspace === binding.workspace &&
					priorSession.endpoint_generation === binding.endpointGeneration &&
					optionalString(priorSession.endpoint_incarnation) === binding.endpointIncarnation
						? (priorSession.sidecar_verifier as { key_id: string; public_key: string } | undefined)
						: undefined;
				// An already-running SDK process cannot receive a newly minted private
				// key. Register only a runtime that has already proven the authority it
				// will use for sidecar updates; use start_session for a fresh runtime.
				if (!priorAuthority)
					return {
						ok: false,
						error: {
							code: "runtime_authority_unavailable",
							message:
								"The running session has no established sidecar authority. Start a new coordinator session.",
						},
					};
				return await withToolIdempotency(
					name,
					idempotencyKey,
					canonicalArgs,
					async () => {
						const creation = await claimProductionCreation(name, idempotencyKey, canonicalArgs);
						if (creation.request.phase === "completed" && creation.request.safe_response)
							return creation.request.safe_response;
						const session = normalizeSession({
							session_id: sessionId,
							cwd,
							...(tmuxSession ? { tmux_session: tmuxSession } : {}),
							...(tmuxTarget ? { tmux_target: tmuxTarget } : {}),
							visible: args.visible !== false,
							source: optionalString(args.source) ?? "register_session",
							model: optionalString(args.model),
							broker_workspace: binding.workspace,
							endpoint_generation: binding.endpointGeneration,
							endpoint_incarnation: binding.endpointIncarnation,
							sidecar_verifier: priorAuthority,
						});
						const intent: CanonicalCreateIntentV1 = {
							kind: "register",
							session: canonicalCreationSnapshot(session),
							initial_state: "ready_for_input",
							initial_events: [
								{
									kind: "session.registered",
									entity: "session",
									entity_id: sessionId,
									created_at: new Date().toISOString(),
								},
							],
						};
						await bindCreationRequest(questionPaths, creation.keyDigest, intent);
						await commitCreationWal(questionPaths, creation.keyDigest, intent);
						await writeJsonFile(sessionFile(sessionId), session);
						const sessionState = await writeSessionState(namespaceDir, sessionId, "ready_for_input", {
							live: null,
							reason: null,
							endpointIncarnation: optionalString(session.endpoint_incarnation) ?? undefined,
						});
						await appendCoordinatorEvent(namespaceDir, {
							stableId: deterministicOutboxId(
								sessionId,
								1,
								"session.registered",
								"session",
								sessionId,
								optionalString(session.endpoint_incarnation) ?? undefined,
							),
							kind: "session.registered",
							sessionId,
							summary: `Session ${sessionId} registered for coordinator control`,
							payloadRef: path.relative(namespaceDir, sessionFile(sessionId)),
							metadata: {
								source: optionalString(args.source) ?? "register_session",
								visible: args.visible !== false,
								endpoint_incarnation: session.endpoint_incarnation,
							},
						});
						const response = {
							ok: true,
							session: publicCoordinatorSession(session),
							session_state: publicCoordinatorSessionState(sessionState),
							registered: true,
						};
						await advanceCreationReceipt(questionPaths, creation.keyDigest, "projected", response);
						await advanceCreationReceipt(questionPaths, creation.keyDigest, "completed", response);
						return response;
					},
					true,
					isUnobservedCompensation,
				);
			}
			if (name === "gjc_coordinator_register_codex_handoff") {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				try {
					await assertCanonicalHandoffAuthority(sessionId);
				} catch (error) {
					if (error instanceof Error && error.message === "resource_gone")
						return {
							ok: false,
							error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
						};
					throw error;
				}
				if (Object.hasOwn(args, "token")) return { ok: false, error: { code: "token_material_not_allowed" } };
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						session_id: sessionId,
						thread_id: args.thread_id,
						endpoint: args.endpoint,
						token_file: args.token_file ?? null,
						allow_mutation: true,
					},
					async () => {
						try {
							await fs.mkdir(config.codexTokenRoot, { recursive: true, mode: 0o700 });
							const handoff = await registerCodexHandoff(namespaceDir, {
								work_unit: sessionId,
								thread_id: typeof args.thread_id === "string" ? args.thread_id : "",
								endpoint: args.endpoint as
									| { kind: "unix"; path: string }
									| { kind: "tcp"; host: string; port: number },
								token_file: args.token_file as string | null | undefined,
								token_root: config.codexTokenRoot,
							});
							return {
								ok: true,
								handoff,
								heartbeat: { supported: false, reason: "automation_update_unavailable" },
							};
						} catch (error) {
							const code = error instanceof Error ? error.message : "invalid_codex_endpoint";
							if (
								code === "invalid_codex_endpoint" ||
								code === "codex_endpoint_not_loopback" ||
								code === "token_material_not_allowed" ||
								code === "codex_token_file_not_authorized" ||
								code === "invalid_thread_id"
							)
								return { ok: false, error: { code } };
							throw error;
						}
					},
				);
			}
			if (name === "gjc_coordinator_read_codex_handoff") {
				const sessionId = safeExternalId("session", args.session_id);
				try {
					await assertCanonicalHandoffAuthority(sessionId);
				} catch (error) {
					if (error instanceof Error && error.message === "resource_gone")
						return {
							ok: false,
							error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
						};
					throw error;
				}
				const wakeEvents = (await listCodexWakeEvents(namespaceDir, sessionId))
					.slice(-100)
					.map(event => ({ ...event, lifecycle: codexWakeLifecycle(event.status) }));
				const pendingWakeEvents = (await listPendingCodexWakeEvents(namespaceDir, sessionId))
					.slice(-100)
					.map(event => ({ ...event, lifecycle: codexWakeLifecycle(event.status) }));
				const handoff = boundedCodexHandoff(await readCodexHandoff(namespaceDir, sessionId));
				return {
					ok: true,
					...(handoff ? { handoff } : {}),
					heartbeat: { supported: false, reason: "automation_update_unavailable" },
					lifecycle_schema: {
						version: 1,
						mapping: {
							pending: "requested",
							published: "delivered",
							acked: "acknowledged",
							failed: "failed",
						},
					},
					wake_events: wakeEvents,
					pending_wake_events: pendingWakeEvents,
				};
			}
			if (name === "gjc_coordinator_ack_codex_handoff") {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				await assertCanonicalHandoffAuthority(sessionId);
				const wakeKey = typeof args.wake_key === "string" ? args.wake_key : "";
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{ session_id: sessionId, wake_key: wakeKey, allow_mutation: true },
					async () => {
						const wakeEvent = (await listCodexWakeEvents(namespaceDir, sessionId)).find(
							event => event.key === wakeKey,
						);
						if (!wakeEvent)
							return {
								ok: false,
								error: { code: "not_found", message: `Codex wake event not found: ${wakeKey}` },
							};
						try {
							const acknowledgedWakeEvent = await ackCodexWakeEvent(namespaceDir, wakeKey);
							return {
								ok: true,
								wake_event: {
									...acknowledgedWakeEvent,
									lifecycle: codexWakeLifecycle(acknowledgedWakeEvent.status),
								},
							};
						} catch (error) {
							if (error instanceof Error && error.message === "resource_gone")
								return {
									ok: false,
									error: { code: "not_found", message: `Codex wake event not found: ${wakeKey}` },
								};
							throw error;
						}
					},
				);
			}
			if (name === "gjc_coordinator_read_status") {
				await recoverCanonicalNamespaceProjections();
				const sessionId = args.session_id;
				if (sessionId) {
					const canonicalSessionId = safeExternalId("session", sessionId);
					const session = asRecord(await readJsonFile(sessionFile(canonicalSessionId)));
					const cwd = optionalString(session?.cwd);
					if (!session || !cwd)
						return {
							ok: false,
							error: { code: "not_found", message: `Coordinator session not found: ${String(sessionId)}` },
						};
					await reconcileSessionRuntime(canonicalSessionId, { observeQuestions: false });
					try {
						let indexedSession = (await listSessions(cwd)).find(
							candidate => brokerSessionId(candidate) === canonicalSessionId,
						);
						// Windows broker locators may differ in drive-letter casing or separator
						// spelling even after the injected canonical workspace seam has resolved
						// the coordinator path. The scoped listing request is still authoritative;
						// only its local path filter is relaxed for the exact requested session.
						if (!indexedSession && platform === "win32") {
							const listing = await paginatedBrokerSessionList(cwd, { cwd });
							indexedSession = jsonRecords(Array.isArray(listing.sessions) ? listing.sessions : []).find(
								candidate => brokerSessionId(candidate) === canonicalSessionId,
							);
						}
						const sessionState = publicCoordinatorSessionState(
							await readSessionState(namespaceDir, canonicalSessionId),
						);
						return {
							ok: true,
							session: publicCoordinatorStatusSession(session),
							status: { ...brokerLiveness(indexedSession ?? null), ...(sessionState ?? {}) },
							session_state: sessionState,
						};
					} catch (error) {
						return sdkError(error);
					}
				}
				try {
					const sessions = await listSessions();
					const publicSessions = sessions.map(publicBrokerSession);
					return {
						ok: true,
						sessions: publicSessions,
						statuses: sessions.map((session, index) => ({
							session: publicSessions[index],
							status: brokerLiveness(session),
						})),
					};
				} catch (error) {
					return sdkError(error);
				}
			}
			if (name === "gjc_coordinator_read_tail") {
				const sessionId = safeExternalId("session", args.session_id);
				const session = asRecord(await readJsonFile(sessionFile(sessionId)));
				if (!session)
					return {
						ok: false,
						error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
					};
				await reconcileSessionRuntime(sessionId, { observeQuestions: false });
				try {
					const text = await queryLastAssistant(session);
					return {
						ok: true,
						source: "sdk",
						lines: text === null ? [] : text.split("\n").slice(-boundedLineCount(args.lines)),
					};
				} catch (error) {
					return sdkError(error);
				}
			}
			if (name === "gjc_coordinator_list_questions") return await listQuestions(args);
			if (name === "gjc_coordinator_list_artifacts") return { ok: true, roots: config.allowedRoots };
			if (name === "gjc_coordinator_read_artifact")
				return await readCoordinatorArtifact(config, { path: args.path });
			if (name === "gjc_coordinator_read_coordination_status") {
				const scopedSessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
				if (scopedSessionId) await ensureQuestionTransaction(scopedSessionId);
				await recoverCanonicalNamespaceProjections(scopedSessionId);
				await reconcileActiveTurnAcknowledgements();
				const allBrokerSessions = await listSessions();
				const brokerSessions = scopedSessionId
					? allBrokerSessions.filter(session => brokerSessionId(session) === scopedSessionId)
					: allBrokerSessions;
				const sessionStates = jsonRecords(await listJsonFiles(path.join(namespaceDir, "session-states"))).filter(
					state => scopedSessionId === null || state.session_id === scopedSessionId,
				);
				const turns = jsonRecords(await listJsonFiles(turnsDir(namespaceDir))).filter(
					turn => scopedSessionId === null || turn.session_id === scopedSessionId,
				);
				const reportRecords = jsonRecords(await listJsonFiles(path.join(namespaceDir, "reports"))).filter(
					report => scopedSessionId === null || report.session_id === scopedSessionId,
				);
				const persistedSessionIds = (await fs.readdir(questionPaths.sessions).catch(() => [])).filter(entry =>
					COORDINATOR_SESSION_ID_PATTERN.test(entry),
				);
				const representedSessionIds = [
					...persistedSessionIds,
					...allBrokerSessions.map(brokerSessionId),
					...sessionStates.map(state => optionalString(state.session_id)),
					...turns.map(turn => optionalString(turn.session_id)),
					...reportRecords.map(report => optionalString(report.session_id)),
				];
				const authorizedSessionIds = await authorizedCanonicalSessionIds(
					representedSessionIds.filter((value): value is string => value !== null && value.length > 0),
					scopedSessionId,
				);
				const authorizedBrokerSessions = brokerSessions.filter(session => {
					const sessionId = brokerSessionId(session);
					return sessionId !== null && authorizedSessionIds.has(sessionId);
				});
				const authorizedSessionStates = sessionStates.filter(state =>
					authorizedSessionIds.has(String(state.session_id)),
				);
				const authorizedTurns = turns.filter(turn => authorizedSessionIds.has(String(turn.session_id)));
				const questionSessionIds = [...authorizedSessionIds.keys()];
				const questionResults = await Promise.all(
					questionSessionIds.map(async session_id => {
						try {
							const result = await listQuestions({ session_id, status: "all" });
							return { session_id, ...result };
						} catch {
							return {
								session_id,
								ok: true as const,
								schema_version: 1 as const,
								questions: [] as CoordinatorQuestionPublicV1[],
								diagnostics: [
									{
										schema_version: 1 as const,
										session_id,
										turn_id: null,
										gate_id: null,
										reason: "query_unavailable" as const,
										observed_at: new Date().toISOString(),
									},
								],
								reconciliation: {
									attempted: true,
									complete: false,
									revision: null,
									observed_at: new Date().toISOString(),
									reason: "query_unavailable" as const,
								},
							};
						}
					}),
				);
				const questionSnapshots = questionResults.map(result => ({
					session_id: result.session_id,
					questions: result.questions.map(({ answer_binding: _answerBinding, ...question }) => question),
					diagnostics: result.diagnostics,
					reconciliation: result.reconciliation,
				}));
				const questions = questionResults
					.flatMap(result => result.questions)
					.map(({ answer_binding: _answerBinding, ...question }) => question);
				const questionSnapshotComplete = questionResults.every(result => result.reconciliation.complete);
				const questionDiagnostics = questionResults.flatMap(result => result.diagnostics);
				const reports = reportRecords.filter(
					report =>
						authorizedSessionIds.has(String(report.session_id)) ||
						(scopedSessionId === null && report.session_id === null),
				);
				await exportRetainedDeliveries();
				const journalSnapshot = await readJournalSnapshot(namespaceDir);
				const scopedJournalEvents = (
					await authorizedCoordinatorEvents(journalSnapshot.events, scopedSessionId)
				).filter(event => scopedSessionId === null || event.session_id === scopedSessionId);
				return capabilityFreeStatusValue({
					ok: true,
					schema_version: 1,
					namespace: config.namespace,
					scope: scopedSessionId ? { session_id: scopedSessionId } : { session_id: null },
					transport: { mcp: "long_poll", push_subscriptions: false },
					summary: {
						sessions: authorizedBrokerSessions.length,
						active_sessions: activeSessionStates(authorizedSessionStates).length,
						turns: authorizedTurns.length,
						active_turns: authorizedTurns.filter(turn => ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus))
							.length,
						queued_turns: authorizedTurns.filter(turn => turn.status === "queued").length,
						terminal_turns: authorizedTurns.filter(turn => TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus))
							.length,
						questions: questionSnapshotComplete ? questions.length : null,
						open_questions: questionSnapshotComplete
							? questions.filter(question => question.status === "pending").length
							: null,
						reports: reports.length,
						questions_complete: questionSnapshotComplete,
						question_diagnostics: questionDiagnostics,
					},
					sessions: authorizedBrokerSessions.map(publicBrokerSession),
					session_states: authorizedSessionStates.map(state =>
						publicCoordinatorSessionState(state as unknown as CoordinatorSessionState),
					),
					turns: authorizedTurns.map(turn =>
						boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					questions: questions.map(question =>
						boundedPublicValue(question, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					question_snapshots: questionSnapshots.map(snapshot =>
						boundedPublicValue(snapshot, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					reports: reports.map(report =>
						boundedPublicValue(report, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					events: buildCanonicalCoordinatorEvents({
						sessionStates: authorizedSessionStates,
						turns: authorizedTurns,
						questions,
						reports,
					}),
					latest_event_seq: journalSnapshot.watermark,
					recent_events: eventSummaries(scopedJournalEvents.slice(-10)),
				}) as Record<string, unknown>;
			}
			if (name === "gjc_coordinator_watch_events") {
				const timeoutMs = boundedEventWatchTimeoutMs(args.timeout_ms);
				const absoluteDeadline = Date.now() + timeoutMs;
				const limit = boundedEventLimit(args.limit);
				const afterSeq = eventCursor(args.after_seq);
				const watchController = new AbortController();
				const deadlineTimer = setTimeout(() => watchController.abort(new Error("deadline_exceeded")), timeoutMs);
				deadlineTimer.unref?.();
				const prioritySessionId = args.session_id == null ? undefined : safeExternalId("session", args.session_id);
				if (prioritySessionId) {
					try {
						await ensureQuestionTransaction(prioritySessionId);
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
						const reaped = await withNamespaceRegistry(questionPaths, async registry =>
							Object.values(registry.deletions).some(
								entry => entry.session_id === prioritySessionId && entry.phase === "completed",
							),
						);
						if (!reaped) throw error;
					}
				}
				const reconcileOptions = timeoutMs > 0 ? { absoluteDeadline, signal: watchController.signal } : {};
				if (timeoutMs === 0) {
					try {
						await reconcileWatchAdmissions(prioritySessionId, reconcileOptions);
						await reconcileActiveTurnAcknowledgements(
							MAX_RUNTIME_SESSIONS_PER_WATCH_PASS,
							prioritySessionId,
							reconcileOptions,
						);
						if (args.session_id != null)
							await reconcileQuestions(safeExternalId("session", args.session_id), reconcileOptions);
						else await reconcileWatchQuestions(undefined, reconcileOptions);
						// Runtime admission must observe the sidecar before canonical projection
						// repair. The fresh journal snapshot below is the first public read after
						// that repair/export sequence, so events are visible after the caller's
						// cursor without allowing recovery to erase a terminal observation.
						await recoverCanonicalNamespaceProjections(prioritySessionId ?? null);
						await exportRetainedDeliveries(32);
					} catch (error) {
						if (!(error instanceof Error && error.message === "resource_gone")) throw error;
					}
				} else if (!watchController.signal.aborted && Date.now() < absoluteDeadline) {
					await recoverCanonicalNamespaceProjections(prioritySessionId ?? null);
					try {
						await exportRetainedDeliveries(32, watchController.signal);
						await reconcileWatchAdmissions(prioritySessionId, reconcileOptions);
						await reconcileActiveTurnAcknowledgements(
							MAX_RUNTIME_SESSIONS_PER_WATCH_PASS,
							prioritySessionId,
							reconcileOptions,
						);
						await exportRetainedDeliveries(32, watchController.signal);
						if (args.session_id != null)
							await reconcileQuestions(safeExternalId("session", args.session_id), reconcileOptions);
						else await reconcileWatchQuestions(undefined, reconcileOptions);
					} catch (error) {
						if (!watchController.signal.aborted && !(error instanceof Error && error.message === "resource_gone"))
							throw error;
					}
				}
				let snapshot: EventJournalSnapshot;
				try {
					snapshot = await readJournalSnapshot(namespaceDir);
				} catch {
					clearTimeout(deadlineTimer);
					return {
						ok: false,
						error: { code: "event_snapshot_unavailable", message: "Coordinator event snapshot is unavailable." },
					};
				}
				const initialCursor = publicWatchWatermark(snapshot, afterSeq);
				if (initialCursor === null) {
					clearTimeout(deadlineTimer);
					return {
						ok: false,
						error: { code: "event_snapshot_unavailable", message: "Coordinator event snapshot is unavailable." },
					};
				}
				const initialWatermark = initialCursor.latest_seq;
				if (afterSeq > initialWatermark) {
					clearTimeout(deadlineTimer);
					return {
						ok: false,
						reason: "cursor_ahead",
						snapshot_watermark: initialWatermark,
						transport: { mcp: "long_poll", push_subscriptions: false },
					};
				}
				if (watchController.signal.aborted || Date.now() >= absoluteDeadline) {
					const publicEvents = filterCoordinatorEvents(
						await authorizedCoordinatorEvents(snapshot.events, prioritySessionId ?? null),
						afterSeq,
						args,
						limit,
					).map(publicCoordinatorEvent);
					const lastMatching = publicEvents.at(-1)?.seq;
					clearTimeout(deadlineTimer);
					return publicWatchSuccess(
						publicEvents,
						initialCursor.latest_seq,
						lastMatching ?? initialCursor.next_after_seq,
						timeoutMs > 0,
					);
				}
				if (afterSeq <= initialWatermark && args.session_id == null) {
					try {
						await reconcileWatchEventSessions(snapshot, afterSeq, {
							absoluteDeadline,
							signal: watchController.signal,
						});
						await exportRetainedDeliveries(32, watchController.signal);
						snapshot = await readJournalSnapshot(namespaceDir, watchController.signal);
					} catch (error) {
						if (!watchController.signal.aborted && !(error instanceof Error && error.message === "resource_gone"))
							throw error;
					}
				}
				const reconciledWatermark = normalizedEventWatermark(snapshot);
				if (reconciledWatermark === null) {
					clearTimeout(deadlineTimer);
					return {
						ok: false,
						error: { code: "event_snapshot_unavailable", message: "Coordinator event snapshot is unavailable." },
					};
				}
				if (afterSeq > reconciledWatermark) {
					clearTimeout(deadlineTimer);
					return {
						ok: false,
						reason: "cursor_ahead",
						snapshot_watermark: reconciledWatermark,
						transport: { mcp: "long_poll", push_subscriptions: false },
					};
				}
				let matched = filterCoordinatorEvents(
					await authorizedCoordinatorEvents(snapshot.events, prioritySessionId ?? null),
					afterSeq,
					args,
					limit,
				);
				let timedOut = false;
				if (matched.length === 0 && timeoutMs > 0) {
					const deadline = absoluteDeadline;
					while (matched.length === 0 && Date.now() < deadline && !watchController.signal.aborted) {
						await waitForCoordinatorEvents(namespaceDir, Math.min(50, Math.max(1, deadline - Date.now())));
						if (Date.now() >= deadline || watchController.signal.aborted) break;
						try {
							await exportRetainedDeliveries(32, watchController.signal);
						} catch (error) {
							if (
								!watchController.signal.aborted &&
								!(error instanceof Error && error.message === "resource_gone")
							)
								throw error;
						}
						try {
							await reconcileWatchAdmissions(prioritySessionId, {
								absoluteDeadline,
								signal: watchController.signal,
							});
							await reconcileActiveTurnAcknowledgements(MAX_RUNTIME_SESSIONS_PER_WATCH_PASS, prioritySessionId, {
								absoluteDeadline,
								signal: watchController.signal,
							});
							if (prioritySessionId)
								await reconcileQuestions(prioritySessionId, {
									absoluteDeadline,
									signal: watchController.signal,
								});
						} catch (error) {
							if (
								!watchController.signal.aborted &&
								!(error instanceof Error && error.message === "resource_gone")
							)
								throw error;
						}
						try {
							await exportRetainedDeliveries(32, watchController.signal);
						} catch (error) {
							if (
								!watchController.signal.aborted &&
								!(error instanceof Error && error.message === "resource_gone")
							)
								throw error;
						}
						if (watchController.signal.aborted) break;
						try {
							snapshot = await readJournalSnapshot(namespaceDir, watchController.signal);
						} catch (error) {
							if (
								!watchController.signal.aborted &&
								!(error instanceof Error && error.message === "resource_gone")
							)
								throw error;
						}
						if (!Number.isSafeInteger(snapshot.watermark) || snapshot.watermark < 0) break;
						if (afterSeq > snapshot.watermark) break;
						if (args.session_id == null) {
							try {
								await reconcileWatchEventSessions(snapshot, afterSeq, {
									absoluteDeadline,
									signal: watchController.signal,
								});
								await exportRetainedDeliveries(32, watchController.signal);
								snapshot = await readJournalSnapshot(namespaceDir, watchController.signal);
							} catch (error) {
								if (
									!watchController.signal.aborted &&
									!(error instanceof Error && error.message === "resource_gone")
								)
									throw error;
							}
						}
						if (args.session_id == null)
							await reconcileWatchQuestions(undefined, {
								absoluteDeadline,
								signal: watchController.signal,
							});
						matched = filterCoordinatorEvents(
							await authorizedCoordinatorEvents(snapshot.events, prioritySessionId ?? null),
							afterSeq,
							args,
							limit,
						);
					}
					timedOut = matched.length === 0;
				}
				const finalCursor = publicWatchWatermark(snapshot, afterSeq);
				if (finalCursor === null) {
					clearTimeout(deadlineTimer);
					return {
						ok: false,
						error: { code: "event_snapshot_unavailable", message: "Coordinator event snapshot is unavailable." },
					};
				}
				clearTimeout(deadlineTimer);
				const publicEvents = matched.map(publicCoordinatorEvent);
				const lastMatching = publicEvents.at(-1)?.seq;
				return publicWatchSuccess(
					publicEvents,
					finalCursor.latest_seq,
					lastMatching ?? finalCursor.next_after_seq,
					timedOut,
				);
			}
			const delegateWorkflow = workflowForDelegateTool(name);
			if (delegateWorkflow) {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const canonicalCwd = await canonicalBrokerWorkspace(await assertCoordinatorWorkdir(config, args.cwd));
				const mpresetResolution = await resolveCoordinatorMpreset(args.mpreset, loadModelProfiles);
				if (!mpresetResolution.ok) {
					return {
						ok: false,
						reason: mpresetResolution.reason,
						mpreset: mpresetResolution.mpreset,
						available_profiles: mpresetResolution.available_profiles,
					};
				}
				// Explicit model pin (#4707) is resolved by the SDK host. The
				// coordinator remains a transport/controller boundary and never loads
				// session, settings, discovery, or MCP-manager authority.
				const modelResolution = await resolveModelPin(args.model, canonicalCwd);
				if (!modelResolution.ok) {
					return {
						ok: false,
						reason: modelResolution.reason,
						model: modelResolution.model,
						error: { code: "unknown_model", message: modelResolution.error },
					};
				}
				const hasTask = typeof args.task === "string" && args.task.trim().length > 0;
				const hasPrompt = typeof args.prompt === "string" && args.prompt.trim().length > 0;
				const task = hasTask ? String(args.task) : hasPrompt ? String(args.prompt) : null;
				if (!task) return { ok: false, reason: "task_required" };
				const taggedPrompt = workflowPrompt(delegateWorkflow, name, canonicalCwd, task, {
					mutationRequested: args.allow_mutation === true,
					model: modelResolution.model,
				});
				const reusedSessionId = args.session_id == null ? undefined : safeExternalId("session", args.session_id);
				const explicitHostWorkUnit =
					args.codex_host_session_id === undefined
						? null
						: typeof args.codex_host_session_id === "string" &&
								SAFE_EXTERNAL_ID_PATTERN.test(args.codex_host_session_id)
							? args.codex_host_session_id
							: "";
				const delegateWorktree = resolveCoordinatorWorktree(
					config.sessionCommand,
					args.worktree,
					config.requireWorktree && !reusedSessionId,
				);
				if (!delegateWorktree.ok) return { ok: false, reason: delegateWorktree.reason };
				const canonicalArgs = {
					cwd: canonicalCwd,
					task,
					...(reusedSessionId ? { session_id: reusedSessionId } : {}),
					queue: args.queue === true,
					force: args.force === true,
					mpreset: mpresetResolution.mpreset,
					model: modelResolution.model,
					await_completion: args.await_completion === true,
					...(args.await_completion === true
						? { timeout_ms: args.timeout_ms, poll_interval_ms: args.poll_interval_ms }
						: {}),
					prompt_alias_ignored: hasTask && hasPrompt,
					...(explicitHostWorkUnit !== null ? { codex_host_session_id: explicitHostWorkUnit } : {}),
					// Two delegations that differ only by worktree land in different checkouts,
					// so the name has to bind the idempotency key like every other creation input.
					...(delegateWorktree.name ? { worktree: delegateWorktree.name } : {}),
					allow_mutation: true,
				};
				const operation =
					args.force === true ? "turn.abort_and_prompt" : args.queue === true ? "turn.follow_up" : "turn.prompt";
				const requestKey = createHash("sha256").update(`${idempotencyKey}\0${operation}`).digest("hex");
				let creationRemoteStarted = false;
				let delegateEffectStarted = false;
				let delegateResponseComplete = false;
				return await withToolIdempotency(
					name,
					idempotencyKey,
					canonicalArgs,
					async recovering => {
						// An older in-progress request can have archived authority. Missing
						// live state is not proof that this key never dispatched a prompt.
						delegateEffectStarted = recovering;
						const delegate = async (): Promise<Record<string, unknown>> => {
							// The outer key lock validates identity before entering here. Admission
							// is not a final response: an interrupted await must still be observed.
							const outer = await readCoordinatorIdempotencyFile(idempotencyFile(idempotencyKey));
							if (outer.kind !== "record") throw new Error("terminal_uncertain");
							const checkpoint = asRecord(outer.value.admission);
							if (checkpoint) {
								delegateEffectStarted = true;
								const response = asRecord(checkpoint.response);
								if (
									checkpoint.kind !== "delegate_admission" ||
									typeof checkpoint.session_id !== "string" ||
									!SAFE_EXTERNAL_ID_PATTERN.test(checkpoint.session_id) ||
									typeof checkpoint.turn_id !== "string" ||
									!TURN_ID_PATTERN.test(checkpoint.turn_id) ||
									!response ||
									response.ok !== true ||
									response.tool_name !== name ||
									response.workflow !== delegateWorkflow ||
									response.session_id !== checkpoint.session_id ||
									response.turn_id !== checkpoint.turn_id
								)
									throw new Error("terminal_uncertain");
								return response;
							}
							let sessionId: string;
							let session: Record<string, unknown>;
							let creationKey: string | null = null;
							let initialDelegateRequest: CoordinatorSessionTransactionV1["recovery"]["initial_delegate_request"];
							if (reusedSessionId) {
								sessionId = reusedSessionId;
								const prior = await readSessionTransaction(questionPaths, sessionId);
								const prompt = prior?.requests.prompts[requestKey];
								delegateEffectStarted ||= Boolean(prompt && prompt.phase !== "claimed");
								const existing = asRecord(await readJsonFile(sessionFile(sessionId)));
								if (!existing)
									return {
										ok: false,
										error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
									};
								const sessionMpreset = optionalString(existing.mpreset);
								if (mpresetResolution.mpreset !== null && sessionMpreset !== mpresetResolution.mpreset) {
									return {
										ok: false,
										reason: "mpreset_conflict",
										session_id: sessionId,
										session_mpreset: sessionMpreset,
										requested_mpreset: mpresetResolution.mpreset,
									};
								}
								const existingCwd = optionalString(existing.cwd);
								if (
									!existingCwd ||
									!sameCanonicalPath(await canonicalBrokerWorkspace(existingCwd), canonicalCwd, platform)
								)
									return {
										ok: false,
										error: {
											code: "workspace_mismatch",
											message: "Coordinator session is bound to another workspace.",
										},
									};
								const binding = await exactBrokerSessionBinding(sessionId, canonicalCwd);
								if (
									!sameCanonicalPath(
										optionalString(existing.broker_workspace) ?? "",
										canonicalCwd,
										platform,
									) ||
									existing.endpoint_generation !== binding.endpointGeneration ||
									optionalString(existing.endpoint_incarnation) !== binding.endpointIncarnation
								)
									return {
										ok: false,
										error: {
											code: "endpoint_stale",
											message: "Coordinator session endpoint incarnation binding is stale.",
										},
									};
								session = normalizeSession({
									...existing,
									session_id: sessionId,
									cwd: canonicalCwd,
									broker_workspace: binding.workspace,
									endpoint_generation: binding.endpointGeneration,
									endpoint_incarnation: binding.endpointIncarnation,
									sidecar_verifier: existing.sidecar_verifier as { key_id: string; public_key: string },
								});
							} else {
								const creation = await claimProductionCreation(name, idempotencyKey, canonicalArgs);
								creationRemoteStarted = creation.request.phase !== "claimed";
								if (creation.request.phase === "completed" && creation.request.safe_response) {
									delegateEffectStarted = true;
									return creation.request.safe_response;
								}
								creationKey = creation.keyDigest;
								// claimProductionCreation has validated the caller key and all
								// canonical arguments, including the prompt mode and workflow.
								initialDelegateRequest = {
									key_digest: creation.keyDigest,
									request_digest: creation.request.request_digest,
								};
								if (creation.request.canonical_create_intent) {
									delegateEffectStarted = true;
									session = sessionFromCreationSnapshot(creation.request.canonical_create_intent.session);
									await bindCreationRequest(
										questionPaths,
										creation.keyDigest,
										creation.request.canonical_create_intent,
									);
									await commitCreationWal(
										questionPaths,
										creation.keyDigest,
										creation.request.canonical_create_intent,
									);
									sessionId = creation.request.canonical_create_intent.session.session_id;
								} else {
									const remote = await prepareCreationBrokerCall(creation);
									creationRemoteStarted = true;
									const created = brokerResult(
										await brokerSession(
											canonicalCwd,
											"session.create",
											{
												cwd: canonicalCwd,
												target: coordinatorLifecycleTarget(
													config.sessionCommand,
													canonicalCwd,
													delegateWorktree.name,
												),
												...(mpresetResolution.mpreset ? { modelPreset: mpresetResolution.mpreset } : {}),
												...(modelResolution.model ? { modelId: modelResolution.model } : {}),
												// Thread the coordinator state dir so the broker-spawned runtime
												// writes terminal state to the coordinator-shared file (#2549).
												coordinatorStateDir: namespaceDir,
												coordinatorSidecarSigningKey:
													sidecarSigningKeys.get(remote.candidate.key_id) ??
													(() => {
														throw new Error("sidecar_signing_key_unavailable");
													})(),
												coordinatorSidecarKeyId: remote.candidate.key_id,
											},
											remote.request.remote_create_key,
										),
									);
									const reconciled = await reconcileCreationBrokerCall(
										creation.keyDigest,
										remote.candidate,
										created,
									);
									sessionId = safeExternalId("session", created.sessionId ?? created.session_id);
									const createdCwd = await canonicalBrokerWorkspace(
										optionalString(created.cwd) ?? canonicalCwd,
									);
									const binding = await exactBrokerSessionBinding(sessionId, createdCwd);
									session = normalizeSession({
										session_id: sessionId,
										cwd: canonicalCwd,
										ephemeral: true,
										created_at: new Date().toISOString(),
										...(mpresetResolution.mpreset ? { mpreset: mpresetResolution.mpreset } : {}),
										...(modelResolution.model ? { model: modelResolution.model } : {}),
										broker_workspace: binding.workspace,
										endpoint_generation: binding.endpointGeneration,
										endpoint_incarnation: binding.endpointIncarnation,
										sidecar_verifier: reconciled.sidecar_verifier,
									});
									const intent: CanonicalCreateIntentV1 = {
										kind: "delegate",
										workflow: delegateWorkflow,
										session: canonicalCreationSnapshot(session),
										remote_create_key: creation.request.remote_create_key,
										initial_state: "running",
										initial_prompt: {
											text: taggedPrompt,
											caller_key_digest: createHash("sha256").update(idempotencyKey).digest("hex"),
										},
										initial_events: [
											{
												kind: "session.started",
												entity: "session",
												entity_id: sessionId,
												created_at: new Date().toISOString(),
											},
										],
									};
									await bindCreationRequest(questionPaths, creation.keyDigest, intent);
									await commitCreationWal(questionPaths, creation.keyDigest, intent);
								}
								await services.afterDelegateCreationWalCommitted?.(sessionId);
							}
							const admit = async (): Promise<Record<string, unknown>> => {
								await writeJsonFile(sessionFile(sessionId), session);
								const previousActiveTurn =
									(await readActiveTurn(namespaceDir, sessionId)) ??
									(await readCanonicalActiveTurn(sessionId));
								const priorTransaction = await readSessionTransaction(questionPaths, sessionId);
								const priorPrompt = priorTransaction?.requests.prompts[requestKey];
								if (
									recovering &&
									!priorPrompt &&
									!hasInitialDelegatePromptAuthority(priorTransaction, initialDelegateRequest)
								)
									throw new Error("terminal_uncertain");
								if (priorPrompt && ["remote_started", "accepted", "completed"].includes(priorPrompt.phase))
									delegateEffectStarted = true;
								const reserved = priorPrompt?.coordinator_turn_id
									? priorTransaction?.canonical.turns[priorPrompt.coordinator_turn_id]
									: null;
								if (priorPrompt && !reserved) throw new Error("terminal_uncertain");
								if (
									priorPrompt &&
									priorPrompt.phase !== "completed" &&
									operation !== "turn.follow_up" &&
									!reserved?.terminal_fence &&
									priorTransaction?.canonical.queue.active_turn_id !== reserved?.turn_id
								)
									throw new Error("terminal_uncertain");
								// Recover this key's reservation before rejecting a busy session.
								if (!priorPrompt && previousActiveTurn && args.queue !== true && args.force !== true) {
									return {
										ok: false,
										error: {
											code: "active_turn_exists",
											message: `Session ${sessionId} already has active turn ${previousActiveTurn.turn_id}.`,
										},
										turn_id: previousActiveTurn.turn_id,
									};
								}
								const promptKey = await claimCanonicalPrompt(
									sessionId,
									taggedPrompt,
									operation,
									idempotencyKey,
									true,
									recovering,
									initialDelegateRequest,
								);
								if (reserved?.terminal_fence && !(await promptReceipt(sessionId, promptKey))) {
									delegateEffectStarted = true;
									throw new Error("terminal_uncertain");
								}
								let acknowledgement: RuntimePromptAcknowledgement;
								try {
									acknowledgement = await dispatchOrRecoverPrompt(
										session,
										sessionId,
										operation,
										taggedPrompt,
										idempotencyKey,
										promptKey,
									);
								} catch (error) {
									// Receipt-first failures on reused sessions must remain recoverable.
									delegateEffectStarted ||= !(error instanceof SdkClientError);
									delegateEffectStarted ||= (await promptReceipt(sessionId, promptKey)) !== null;
									throw error;
								}
								delegateEffectStarted = true;
								const turn = await recordAcceptedPrompt(
									sessionId,
									taggedPrompt,
									operation,
									reserved?.terminal_fence || previousActiveTurn?.turn_id === reserved?.turn_id
										? null
										: previousActiveTurn,
									acknowledgement,
									promptKey,
								);
								const codexHandoff = await autoBindDelegateCodexHandoff(
									namespaceDir,
									canonicalCwd,
									sessionId,
									turn.turn_id,
									delegateWorkflow,
									explicitHostWorkUnit,
								);
								await appendCoordinatorEvent(namespaceDir, {
									stableId: `delegation:${sessionId}:${turn.turn_id}`,
									kind: "delegation.started",
									sessionId,
									turnId: turn.turn_id,
									summary: `Delegated ${delegateWorkflow} via ${name} on session ${sessionId}`,
									metadata: {
										workflow: delegateWorkflow,
										tool_name: name,
										session_id: sessionId,
										turn_id: turn.turn_id,
										active_turn_id: turn.delivery.queued
											? (previousActiveTurn?.turn_id ?? null)
											: turn.turn_id,
										status: turn.status,
										queued: turn.delivery.queued,
										delivered: turn.delivery.delivered,
										delivery: turn.delivery,
										session: publicCoordinatorSession(session),
										session_state: publicCoordinatorSessionState(
											await readSessionState(namespaceDir, sessionId),
										),
										turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
										result: publicSdkAcknowledgement(acknowledgement),
										codex_handoff: codexHandoff,
										endpoint_incarnation: session.endpoint_incarnation,
										...(hasTask && hasPrompt ? { prompt_alias_ignored: true } : {}),
									},
								});
								const response = {
									ok: true,
									workflow: delegateWorkflow,
									tool_name: name,
									session_id: sessionId,
									turn_id: turn.turn_id,
									active_turn_id: turn.delivery.queued
										? (previousActiveTurn?.turn_id ?? null)
										: TERMINAL_TURN_STATUSES.has(turn.status)
											? null
											: turn.turn_id,
									status: turn.status,
									queued: turn.delivery.queued,
									delivered: turn.delivery.delivered,
									delivery: turn.delivery,
									session: publicCoordinatorSession(session),
									session_state: publicCoordinatorSessionState(
										await readSessionState(namespaceDir, sessionId),
									),
									turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
									result: publicSdkAcknowledgement(acknowledgement),
									codex_handoff: codexHandoff,
									...(hasTask && hasPrompt ? { prompt_alias_ignored: true } : {}),
								};
								const admission: DelegateAdmissionCheckpoint = {
									kind: "delegate_admission",
									session_id: sessionId,
									turn_id: turn.turn_id,
									response: boundedToolResponse(name, response),
								};
								const delegateResponsePin: DelegateResponsePinV1 = {
									session_id: sessionId,
									coordinator_turn_id: turn.turn_id,
									prompt_key_digest: promptKey,
									runtime_command_id: acknowledgement.command_id,
									runtime_turn_id: acknowledgement.turn_id,
								};
								await writeCoordinatorIdempotencyFile(idempotencyFile(idempotencyKey), {
									...(outer.value as unknown as CoordinatorToolIdempotencyRecord),
									admission,
									delegate_response_pin: delegateResponsePin,
								});
								// A completed creation must never outlive the outer recovery identity.
								if (creationKey) {
									await advanceCreationReceipt(questionPaths, creationKey, "projected", response);
									await advanceCreationReceipt(questionPaths, creationKey, "completed", response);
									await services.afterDelegateCreationCompleted?.();
								}
								await services.afterDelegateAdmission?.(sessionId);
								return admission.response;
							};
							return reusedSessionId ? await admit() : await withSessionTransition(sessionId, admit);
						};
						const response = reusedSessionId
							? await withSessionTransition(reusedSessionId, delegate)
							: await delegate();
						// Observation owns the same key flight, not SESSION: force/queue may
						// now dispatch while the full response awaits its durable commit.
						const complete =
							response.ok === true && args.await_completion === true
								? {
										...response,
										completion: await awaitTurnPayload(
											response.turn_id,
											response.session_id,
											args.timeout_ms,
											args.poll_interval_ms,
										),
									}
								: response;
						delegateResponseComplete = response.ok === true;
						return complete;
					},
					true,
					response =>
						(!delegateResponseComplete && (creationRemoteStarted || delegateEffectStarted)) ||
						isRouterRequestAmbiguous(response),
				);
			}
			if (name === "gjc_coordinator_stop_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const sessionId = safeExternalId("session", args.session_id);
				const forceRequested = args.force === true;
				// force is a capability distinct from allow_mutation: closing a non-ephemeral
				// user-registered session requires GJC_COORDINATOR_MCP_FORCE_STOP to be enabled.
				if (forceRequested && !config.forceStopEnabled) {
					return { ok: false, reason: "force_not_authorized", session_id: sessionId, closed: false };
				}
				const result = await reapSession(sessionId, {
					force: forceRequested,
					reason: optionalString(args.reason) ?? "stop_session",
				});
				return {
					ok: result.ok,
					session_id: sessionId,
					closed: result.closed,
					...(result.reason ? { reason: result.reason } : {}),
					...(result.active_turn_id ? { active_turn_id: result.active_turn_id } : {}),
					...(result.detail ? { detail: result.detail } : {}),
				};
			}
			if (name === "gjc_coordinator_start_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const suppliedPrompt = Object.hasOwn(args, "prompt");
				if (suppliedPrompt && (typeof args.prompt !== "string" || args.prompt.trim().length === 0))
					return { ok: false, error: { code: "invalid_input", message: "Prompt must not be empty." } };
				const idempotencyKey = requiredIdempotencyKey(args);
				const cwd = await canonicalBrokerWorkspace(await assertCoordinatorWorkdir(config, args.cwd));
				const mpresetResolution = await resolveCoordinatorMpreset(args.mpreset, loadModelProfiles);
				if (!mpresetResolution.ok) {
					return {
						ok: false,
						reason: mpresetResolution.reason,
						mpreset: mpresetResolution.mpreset,
						available_profiles: mpresetResolution.available_profiles,
					};
				}
				// Explicit model pin (#4707): resolve with CLI grammar at the SDK host
				// boundary before any coordinator mutation or lifecycle request.
				const modelResolution = await resolveModelPin(args.model, cwd);
				if (!modelResolution.ok) {
					return {
						ok: false,
						reason: modelResolution.reason,
						model: modelResolution.model,
						error: { code: "unknown_model", message: modelResolution.error },
					};
				}
				const prompt = suppliedPrompt ? (args.prompt as string) : null;
				/**
				 * A prepared session is deliberately not ready for input: its readiness
				 * is withheld until an operator-supplied thread is bound and activation
				 * is proven. Accepting an initial prompt here would either be silently
				 * dropped or delivered to a session no consumer has been told is live,
				 * so it is refused before any broker mutation or idempotency record.
				 */
				// Runtime dispatch hands `params.arguments` through unvalidated, so a
				// client sending the string "true" would coerce to false here and start
				// an ordinary ready session that accepts the prompt — the opposite of
				// what the schema promises. Reject a non-boolean before any mutation.
				const requestedPrepare = (args as Record<string, unknown>).prepare_existing_thread;
				if (requestedPrepare !== undefined && typeof requestedPrepare !== "boolean")
					return {
						ok: false,
						error: {
							code: "invalid_input",
							message: `prepare_existing_thread must be a boolean; received ${typeof requestedPrepare}.`,
						},
					};
				const preparesExistingThread = requestedPrepare === true;
				if (preparesExistingThread && prompt)
					return {
						ok: false,
						error: {
							code: "invalid_input",
							message:
								"prepare_existing_thread cannot carry an initial prompt; activate the session first, then send_prompt.",
						},
					};
				let creationRemoteStarted = false;
				const worktreeResolution = resolveCoordinatorWorktree(
					config.sessionCommand,
					args.worktree,
					config.requireWorktree,
				);
				if (!worktreeResolution.ok) return { ok: false, reason: worktreeResolution.reason };
				const canonicalArgs = {
					cwd,
					mpreset: mpresetResolution.mpreset,
					model: modelResolution.model,
					...(prompt ? { prompt } : {}),
					...(preparesExistingThread ? { prepare_existing_thread: true } : {}),
					// Two sessions that differ only by worktree are different sessions, so the
					// name has to bind the idempotency key like every other creation input.
					...(worktreeResolution.name ? { worktree: worktreeResolution.name } : {}),
					allow_mutation: true,
				};
				const lifecycleTarget = coordinatorLifecycleTarget(config.sessionCommand, cwd, worktreeResolution.name);
				const remoteSession = { value: null as string | null };
				return await withToolIdempotency(
					name,
					idempotencyKey,
					canonicalArgs,
					async () =>
						await withRemoteSessionCompensation(cwd, remoteSession, async () => {
							const creation = await claimProductionCreation(name, idempotencyKey, canonicalArgs);
							if (creation.request.phase === "completed" && creation.request.safe_response)
								return creation.request.safe_response;
							let created: Record<string, unknown>;
							let session: Record<string, unknown>;
							let sessionId: string;
							if (creation.request.canonical_create_intent) {
								session = sessionFromCreationSnapshot(creation.request.canonical_create_intent.session);
								sessionId = creation.request.canonical_create_intent.session.session_id;
								created = { session_id: sessionId };
							} else {
								const remote = await prepareCreationBrokerCall(creation);
								creationRemoteStarted = true;
								created = brokerResult(
									await brokerSession(
										cwd,
										"session.create",
										{
											cwd,
											target: lifecycleTarget,
											...(mpresetResolution.mpreset ? { modelPreset: mpresetResolution.mpreset } : {}),
											...(modelResolution.model ? { modelId: modelResolution.model } : {}),
											...(preparesExistingThread ? { readiness: "deferred" } : {}),
											// Thread the coordinator state dir so the broker-spawned runtime
											// writes terminal state to the coordinator-shared file (#2549).
											coordinatorStateDir: namespaceDir,
											coordinatorSidecarSigningKey:
												sidecarSigningKeys.get(remote.candidate.key_id) ??
												(() => {
													throw new Error("sidecar_signing_key_unavailable");
												})(),
											coordinatorSidecarKeyId: remote.candidate.key_id,
										},
										remote.request.remote_create_key,
									),
								);
								remoteSession.value = optionalString(created.sessionId ?? created.session_id);
								/**
								 * Preparation is only real when the broker proves it. A create that
								 * silently published readiness would leave a live session whose root
								 * is already claimed, so the session is closed rather than reported
								 * as prepared.
								 */
								if (preparesExistingThread && created.readiness !== "prepared") {
									const unpreparedId = optionalString(created.sessionId ?? created.session_id);
									let compensated = true;
									if (unpreparedId) {
										compensated = await Promise.resolve(
											strictBrokerSessionClose(
												await brokerSession(
													cwd,
													"session.close",
													{ sessionId: unpreparedId },
													`${idempotencyKey}:unprepared-close`,
												),
												unpreparedId,
											),
										).then(
											() => true,
											() => false,
										);
									}
									if (!unpreparedId)
										throw new SdkClientError(
											UNOBSERVED_COMPENSATION_CODE,
											"SDK broker created a session but returned no usable session identity; the outcome is unobserved.",
											{ creation_response: created },
										);
									if (!compensated)
										throw new SdkClientError(
											UNOBSERVED_COMPENSATION_CODE,
											`SDK broker did not prepare the requested session, and closing the unprepared session ${unpreparedId} failed; it may still be running.`,
										);
									remoteSession.value = null;
									throw new SdkClientError(
										"broker_request_unavailable",
										"SDK broker did not prepare the requested session.",
									);
								}
								const reconciled = await reconcileCreationBrokerCall(
									creation.keyDigest,
									remote.candidate,
									created,
								);
								sessionId = safeExternalId("session", created.sessionId ?? created.session_id);
								const sessionCwd = await canonicalBrokerWorkspace(optionalString(created.cwd) ?? cwd);
								const binding = await exactBrokerSessionBinding(sessionId, sessionCwd);
								session = normalizeSession({
									session_id: sessionId,
									cwd: sessionCwd,
									...(mpresetResolution.mpreset ? { mpreset: mpresetResolution.mpreset } : {}),
									...(modelResolution.model ? { model: modelResolution.model } : {}),
									broker_workspace: binding.workspace,
									endpoint_generation: binding.endpointGeneration,
									endpoint_incarnation: binding.endpointIncarnation,
									sidecar_verifier: reconciled.sidecar_verifier,
								});
							}
							const intent: CanonicalCreateIntentV1 = {
								kind: "start",
								session: canonicalCreationSnapshot(session),
								remote_create_key: creation.request.remote_create_key,
								initial_state: prompt ? "running" : preparesExistingThread ? "prepared" : "ready_for_input",
								initial_prompt: prompt
									? {
											text: prompt,
											caller_key_digest: createHash("sha256").update(idempotencyKey).digest("hex"),
										}
									: null,
								initial_events: [
									{
										kind: "session.started",
										entity: "session",
										entity_id: sessionId,
										created_at: new Date().toISOString(),
									},
								],
							};
							await bindCreationRequest(questionPaths, creation.keyDigest, intent);
							await commitCreationWal(questionPaths, creation.keyDigest, intent);
							await writeJsonFile(sessionFile(sessionId), session);
							const lifecycle = publicLifecycleReceipt(created, sessionId);
							if (prompt) {
								const promptKey = await claimCanonicalPrompt(sessionId, prompt, "turn.prompt", idempotencyKey);
								const acknowledgement = await dispatchOrRecoverPrompt(
									session,
									sessionId,
									"turn.prompt",
									prompt,
									idempotencyKey,
									promptKey,
								);
								const turn = await recordAcceptedPrompt(
									sessionId,
									prompt,
									"turn.prompt",
									null,
									acknowledgement,
									promptKey,
								);
								const response = {
									ok: true,
									session: publicCoordinatorSession(session),
									lifecycle,
									turn_id: turn.turn_id,
									active_turn_id: TERMINAL_TURN_STATUSES.has(turn.status) ? null : turn.turn_id,
									status: turn.status,
									queued: turn.delivery.queued,
									delivered: turn.delivery.delivered,
									operation: "turn.prompt",
									turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
									result: publicSdkAcknowledgement(acknowledgement),
									session_state: publicCoordinatorSessionState(
										await readSessionState(namespaceDir, sessionId),
									),
								};
								await advanceCreationReceipt(questionPaths, creation.keyDigest, "projected", response);
								await advanceCreationReceipt(questionPaths, creation.keyDigest, "completed", response);
								return response;
							}
							const sessionState = await writeSessionState(
								namespaceDir,
								sessionId,
								preparesExistingThread ? "prepared" : "ready_for_input",
								{
									live: null,
									reason: null,
									endpointIncarnation: optionalString(session.endpoint_incarnation) ?? undefined,
								},
							);
							await appendCoordinatorEvent(namespaceDir, {
								stableId: deterministicOutboxId(
									sessionId,
									1,
									"session.started",
									"session",
									sessionId,
									optionalString(session.endpoint_incarnation) ?? undefined,
								),
								kind: "session.started",
								sessionId,
								summary: preparesExistingThread
									? `Session ${sessionId} prepared through SDK lifecycle control`
									: `Session ${sessionId} started through SDK lifecycle control`,
								payloadRef: path.relative(namespaceDir, sessionFile(sessionId)),
								metadata: { endpoint_incarnation: session.endpoint_incarnation },
							});
							const response = {
								ok: true,
								session: publicCoordinatorSession(session),
								session_state: publicCoordinatorSessionState(sessionState),
								lifecycle,
							};
							await advanceCreationReceipt(questionPaths, creation.keyDigest, "projected", response);
							await advanceCreationReceipt(questionPaths, creation.keyDigest, "completed", response);
							return response;
						}),
					true,
					response =>
						isUnobservedCompensation(response) || creationRemoteStarted || isRouterRequestAmbiguous(response),
				);
			}
			if (name === "gjc_coordinator_retire_start_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const retirementKey = requiredIdempotencyKey(args);
				const creationKey = requiredString(args.creation_idempotency_key, "creation_idempotency_key");
				const requestDigest = requiredString(args.request_digest, "request_digest");
				if (!/^[a-f0-9]{64}$/.test(requestDigest))
					return {
						ok: false,
						error: { code: "invalid_input", message: "request_digest must be a SHA-256 hash." },
					};
				if (typeof args.session_id !== "string" || !COORDINATOR_SESSION_ID_PATTERN.test(args.session_id))
					return {
						ok: false,
						error: { code: "invalid_input", message: "session_id must be a canonical safe identifier." },
					};
				const sessionId = safeExternalId("session", args.session_id);
				const cwd = await canonicalBrokerWorkspace(await assertCoordinatorWorkdir(config, args.cwd));
				const proofString = (value: unknown, maxLength: number): string | null =>
					typeof value === "string" &&
					value.length > 0 &&
					value.length <= maxLength &&
					value.trim() === value &&
					![...value].some(character => character <= "\u001f" || character === "\u007f")
						? value
						: null;
				const stateRootInput = proofString(args.state_root, 4096);
				const stateRoot = stateRootInput === null ? null : path.resolve(stateRootInput);
				const remoteCreateKey = proofString(args.remote_create_key, 256);
				const lifecycleRequestId = proofString(args.lifecycle_request_id, 128);
				const processIncarnation = proofString(args.process_incarnation, 256);
				const hostIncarnation = proofString(args.host_incarnation, 256);
				const endpointGeneration = args.endpoint_generation;
				const endpointMtimeMs = args.endpoint_mtime_ms;
				if (
					stateRoot === null ||
					remoteCreateKey === null ||
					lifecycleRequestId === null ||
					!/^[A-Za-z0-9._-]+$/u.test(lifecycleRequestId) ||
					processIncarnation === null ||
					hostIncarnation === null ||
					!path.isAbsolute(stateRoot) ||
					typeof endpointGeneration !== "number" ||
					!Number.isSafeInteger(endpointGeneration) ||
					endpointGeneration <= 0 ||
					typeof endpointMtimeMs !== "number" ||
					!Number.isFinite(endpointMtimeMs) ||
					endpointMtimeMs <= 0 ||
					path.resolve(stateRoot) !== path.join(cwd, ".gjc", "state")
				)
					return {
						ok: false,
						error: { code: "invalid_input", message: "Retirement proof fields are invalid or out of scope." },
					};
				const canonicalArgs = {
					cwd,
					session_id: sessionId,
					creation_idempotency_key: creationKey,
					request_digest: requestDigest,
					allow_mutation: true,
				};
				const proof: CreationRetirementProofV1 = {
					session_id: sessionId,
					cwd,
					state_root: stateRoot,
					endpoint_generation: endpointGeneration,
					endpoint_mtime_ms: endpointMtimeMs,
					process_incarnation: processIncarnation,
					host_incarnation: hostIncarnation,
					lifecycle_request_id: lifecycleRequestId,
					remote_create_key: remoteCreateKey,
				};
				const creationKeyDigest = creationDigests("gjc_coordinator_start_session", creationKey, {}).keyDigest;
				const brokerRequestKey = `coordinator-retire:${creationKeyDigest}:${createHash("sha256")
					.update(JSON.stringify(proof))
					.digest("hex")}`;
				const retirementKeyDigest = createHash("sha256").update(retirementKey).digest("hex");
				const isRetirementRetryable = (response: Record<string, unknown>): boolean => {
					const code = asRecord(response.error)?.code;
					return (
						code === "protocol_error" ||
						code === "terminal_uncertain" ||
						code === "state_corrupt" ||
						code === "unavailable" ||
						code === "broker_unavailable" ||
						code === "broker_request_unavailable" ||
						code === "broker_transport_unavailable" ||
						code === "endpoint_stale" ||
						code === "retirement_proof_stale" ||
						code === "not_found" ||
						code === "live_session"
					);
				};
				const flight = admitIdempotencyFlight(name, retirementKey, canonicalArgs);
				if (flight.kind === "conflict") return flight.response;
				if (flight.kind === "joined") return await flight.promise;
				const retirementOperation = withOrderedSessionStateLocks(
					[idempotencyLockFile(creationKey), idempotencyLockFile(retirementKey)],
					async () =>
						await withToolIdempotency(
							name,
							retirementKey,
							canonicalArgs,
							async () => {
								const originalFile = idempotencyFile(creationKey);
								const originalFileState = await readCoordinatorIdempotencyFile(originalFile);
								if (originalFileState.kind !== "record")
									return {
										ok: false,
										error: {
											code: "not_found",
											message: "The stranded coordinator start intent was not found.",
										},
									};
								const original = originalFileState.value;
								if (
									original.schema_version !== 1 ||
									original.tool !== "gjc_coordinator_start_session" ||
									original.key_digest !== createHash("sha256").update(creationKey).digest("hex") ||
									original.request_digest !== requestDigest
								)
									return {
										ok: false,
										error: {
											code: "idempotency_conflict",
											message: "The start intent identity does not match.",
										},
									};
								const originalAlreadyRetired =
									original.state === "completed" &&
									asRecord(asRecord(original.response)?.error)?.code === "retired";
								if (original.state !== "in_progress" && !originalAlreadyRetired)
									return {
										ok: false,
										error: {
											code: "retire_not_allowed",
											message: "The coordinator start intent is not stranded in progress.",
										},
									};
								const creation = await assertCreationRetirementIdentity(
									questionPaths,
									creationKeyDigest,
									proof,
								);
								if (originalAlreadyRetired && creation.retirement_intent?.phase !== "broker_retired")
									throw new SdkClientError(
										"state_corrupt",
										"A completed retired start intent lacks its durable broker retirement proof.",
									);
								if (
									originalAlreadyRetired &&
									creation.retirement_intent?.retirement_key_digest !== retirementKeyDigest
								)
									return {
										ok: false,
										error: {
											code: "retire_not_allowed",
											message: "The completed retired start intent is bound to a different retirement key.",
										},
									};
								if (
									creation.retirement_intent &&
									creation.retirement_intent.retirement_key_digest !== retirementKeyDigest
								)
									return {
										ok: false,
										error: {
											code: "retire_not_allowed",
											message:
												"The coordinator start intent was already retired by another retirement request.",
										},
									};
								let lifecycle: Record<string, unknown>;
								if (creation.retirement_intent?.phase === "broker_retired") {
									const staged = creation.retirement_intent.broker_proof;
									if (!staged)
										throw new SdkClientError(
											"terminal_uncertain",
											"Retirement intent is staged without a bounded broker proof.",
										);
									if (
										staged.session_id !== proof.session_id ||
										staged.state_root !== proof.state_root ||
										staged.endpoint_generation !== proof.endpoint_generation ||
										staged.endpoint_mtime_ms !== proof.endpoint_mtime_ms ||
										staged.process_incarnation !== proof.process_incarnation ||
										staged.host_incarnation !== proof.host_incarnation ||
										staged.lifecycle_request_id !== proof.lifecycle_request_id ||
										staged.remote_create_key !== proof.remote_create_key ||
										staged.retired !== true ||
										staged.ledger_state !== "terminal_error" ||
										staged.index_type !== "session_closed"
									)
										throw new SdkClientError(
											"state_corrupt",
											"Retirement intent proof does not match its creation identity.",
										);
									lifecycle = publicRetirementProof(staged);
								} else {
									await recordCreationRetirementIntent(
										questionPaths,
										creationKeyDigest,
										proof,
										retirementKeyDigest,
									);
									const acknowledgement = await brokerSession(
										cwd,
										"session.reconcile_uncertain",
										{
											sessionId,
											cwd,
											stateRoot,
											endpointGeneration,
											endpointMtimeMs,
											processIncarnation,
											hostIncarnation,
											lifecycleRequestId,
											remoteCreateKey,
										},
										brokerRequestKey,
									);
									const brokerResponse = asRecord(acknowledgement);
									if (brokerResponse?.ok === false) {
										const brokerError = asRecord(brokerResponse.error);
										if (brokerError?.code === "retirement_proof_stale" && brokerError.cleanup === undefined)
											await replaceCreationRetirementIntent(
												questionPaths,
												creationKeyDigest,
												proof,
												retirementKeyDigest,
											);
									}
									const parsed = strictBrokerRetirementProof(acknowledgement, proof);
									await recordCreationRetirementBrokerProof(
										questionPaths,
										creationKeyDigest,
										proof,
										parsed.broker,
									);
									lifecycle = parsed.public;
								}
								const retiredResponse = {
									ok: false,
									error: {
										code: "retired",
										message:
											"The stranded coordinator start intent was retired after exact session identity proof.",
									},
								};
								await advanceCreationReceipt(
									questionPaths,
									creationKeyDigest,
									"retired",
									retiredResponse,
									proof,
								);
								const latestOriginal = await readCoordinatorIdempotencyFile(originalFile);
								if (latestOriginal.kind !== "record")
									throw new SdkClientError("state_corrupt", "Start intent disappeared during retirement.");
								if (latestOriginal.value.state === "completed") {
									if (asRecord(asRecord(latestOriginal.value.response)?.error)?.code !== "retired")
										throw new SdkClientError(
											"idempotency_conflict",
											"Start intent changed during retirement.",
										);
								} else if (latestOriginal.value.state !== "in_progress") {
									throw new SdkClientError("idempotency_conflict", "Start intent changed during retirement.");
								} else {
									await writeCoordinatorIdempotencyFile(originalFile, {
										...(latestOriginal.value as unknown as CoordinatorToolIdempotencyRecord),
										state: "completed",
										response: retiredResponse,
										completed_at: new Date().toISOString(),
									});
								}
								return coordinatorRetiredResponse(sessionId, lifecycle);
							},
							true,
							isRetirementRetryable,
							true,
							true,
						),
				);
				return await flight.run(retirementOperation);
			}
			if (name === "gjc_coordinator_activate_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{ session_id: sessionId, allow_mutation: true },
					async () =>
						await withSessionTransition(sessionId, async () => {
							const currentSession = asRecord(await readJsonFile(sessionFile(sessionId)));
							if (!currentSession)
								return {
									ok: false,
									error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
								};
							const before = await readSessionState(namespaceDir, sessionId);
							/**
							 * A settled activation is not reported from durable state alone: a
							 * session that went stale, errored, completed, or never recorded a
							 * state cannot be answered `already`, and even a recorded
							 * `ready_for_input` has to be re-proved against the live session
							 * below before it may be.
							 */
							const eligibility = classifyCoordinatorActivation(before);
							if (!eligibility.activatable)
								return {
									ok: false,
									session_id: sessionId,
									state: eligibility.observed,
									session_state: publicCoordinatorSessionState(before),
									error: {
										code: "session_not_activatable",
										message: `Coordinator session is not activatable in state ${eligibility.observed}.`,
									},
								};
							let activated: ActivatedPreparedSession;
							try {
								activated = await activatePreparedCoordinatorSession(currentSession, sessionId, idempotencyKey);
							} catch (error) {
								if (!(error instanceof SessionActivationError)) throw error;
								return {
									ok: false,
									session_id: sessionId,
									state: before?.state ?? "unknown",
									session_state: publicCoordinatorSessionState(before),
									error: {
										code: publicErrorCode(error.code),
										message: PUBLIC_ERROR_MESSAGES[publicErrorCode(error.code)],
									},
								};
							}
							/**
							 * An already-ready session transitions nothing: the answer above is
							 * the live session's own, proved at the exact endpoint generation
							 * this call resolved, so durable state is neither rewritten nor
							 * given a second readiness event.
							 */
							if (eligibility.settled)
								return {
									ok: true,
									session_id: sessionId,
									status: activated.status,
									state: "ready_for_input" as const,
									endpoint_generation: activated.endpointGeneration,
									session_state: publicCoordinatorSessionState(before),
								};
							// Only a proven `activated`/`already` moves durable state to ready.
							const sessionState = await writeSessionState(namespaceDir, sessionId, "ready_for_input", {
								live: true,
								reason: null,
								endpointIncarnation: optionalString(currentSession.endpoint_incarnation) ?? undefined,
							});
							await appendCoordinatorEvent(namespaceDir, {
								stableId: `activation:${sessionId}:${optionalString(currentSession.endpoint_incarnation) ?? "unknown"}:${activated.endpointGeneration}`,
								kind: "session.started",
								sessionId,
								summary: `Session ${sessionId} activated its withheld readiness`,
								payloadRef: path.relative(namespaceDir, sessionFile(sessionId)),
								metadata: {
									status: activated.status,
									endpoint_generation: activated.endpointGeneration,
									endpoint_incarnation: currentSession.endpoint_incarnation,
								},
							});
							return {
								ok: true,
								session_id: sessionId,
								status: activated.status,
								state: "ready_for_input" as const,
								endpoint_generation: activated.endpointGeneration,
								session_state: publicCoordinatorSessionState(sessionState),
							};
						}),
					/**
					 * A crash between writing the receipt and settling it leaves an
					 * in-progress activation. Recovering it is safe because every retry
					 * re-proves the workspace, generation, and incarnation before it
					 * sends anything, and the session answers a repeated activation
					 * `already` rather than publishing readiness twice.
					 */
					true,
					response => isUnknownActivationOutcome(response) || isRouterRequestAmbiguous(response),
				);
			}
			if (name === "gjc_coordinator_send_prompt") {
				requireCoordinatorMutation(config, "sessions", args);
				if (typeof args.prompt !== "string" || args.prompt.trim().length === 0)
					return { ok: false, error: { code: "invalid_input", message: "Prompt must not be empty." } };
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				const prompt = args.prompt;
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						session_id: sessionId,
						prompt,
						queue: args.queue === true,
						force: args.force === true,
						allow_mutation: true,
					},
					async () =>
						await withSessionTransition(sessionId, async () => {
							const currentSession = asRecord(await readJsonFile(sessionFile(sessionId)));
							if (!currentSession) {
								return {
									ok: false,
									error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
								};
							}
							/**
							 * A prepared session is not ready for input. Its readiness is still
							 * withheld, so a prompt here would be delivered to a session no
							 * consumer has been told is live, and (for an existing-thread
							 * preparation) before its root binding could be applied.
							 */
							const preparedState = await readSessionState(namespaceDir, sessionId);
							if (preparedState?.state === "prepared") {
								return {
									ok: false,
									session_id: sessionId,
									state: "prepared" as const,
									error: {
										code: "session_not_activated",
										message: `Session ${sessionId} is prepared; activate it before sending a prompt.`,
									},
									session_state: publicCoordinatorSessionState(preparedState),
								};
							}
							const operation =
								args.force === true
									? "turn.abort_and_prompt"
									: args.queue === true
										? "turn.follow_up"
										: "turn.prompt";
							const promptKeyDigest = createHash("sha256")
								.update(`${idempotencyKey}\0${operation}`)
								.digest("hex");
							const existingPromptTurnId = await withSessionTransaction(
								questionPaths,
								sessionId,
								async transaction => transaction.requests.prompts[promptKeyDigest]?.coordinator_turn_id ?? null,
							);
							const previousActiveTurn =
								(await readActiveTurn(namespaceDir, sessionId)) ?? (await readCanonicalActiveTurn(sessionId));
							// A retry of an in-progress Router request owns its reservation. Do
							// not mistake that reservation for an unrelated active turn before
							// dispatchOrRecoverPrompt gets a chance to reconcile it.
							if (
								previousActiveTurn &&
								args.queue !== true &&
								args.force !== true &&
								existingPromptTurnId !== previousActiveTurn.turn_id
							) {
								return {
									ok: false,
									error: {
										code: "active_turn_exists",
										message: `Session ${sessionId} already has active turn ${previousActiveTurn.turn_id}.`,
									},
									turn_id: previousActiveTurn.turn_id,
								};
							}
							const promptKey = await claimCanonicalPrompt(sessionId, prompt, operation, idempotencyKey);
							const acknowledgement = await dispatchOrRecoverPrompt(
								currentSession,
								sessionId,
								operation,
								prompt,
								idempotencyKey,
								promptKey,
							);
							const turn = await recordAcceptedPrompt(
								sessionId,
								prompt,
								operation,
								previousActiveTurn,
								acknowledgement,
								promptKey,
							);
							return {
								ok: true,
								session_id: sessionId,
								turn_id: turn.turn_id,
								active_turn_id: turn.delivery.queued
									? (previousActiveTurn?.turn_id ?? null)
									: TERMINAL_TURN_STATUSES.has(turn.status)
										? null
										: turn.turn_id,
								status: turn.status,
								queued: turn.delivery.queued,
								delivered: turn.delivery.delivered,
								operation,
								result: publicSdkAcknowledgement(acknowledgement),
								turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
								session_state: publicCoordinatorSessionState(await readSessionState(namespaceDir, sessionId)),
							};
						}),
					true,
				);
			}
			if (name === "gjc_coordinator_read_turn") {
				return await readTurnPayload(args.turn_id, args.session_id);
			}
			if (name === "gjc_coordinator_await_turn") {
				return await awaitTurnPayload(args.turn_id, args.session_id, args.timeout_ms, args.poll_interval_ms);
			}
			if (name === "gjc_coordinator_submit_question_answer") {
				requireCoordinatorMutation(config, "questions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				const turnId = safeTurnId(args.turn_id);
				const questionId = typeof args.question_id === "string" ? args.question_id : "";
				const answerBinding = typeof args.answer_binding === "string" ? args.answer_binding : "";
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						session_id: sessionId,
						turn_id: turnId,
						question_id: questionId,
						answer_binding: answerBinding,
						answer: args.answer,
						allow_mutation: true,
					},
					async () => {
						const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
						const requestDigest = createHash("sha256")
							.update(
								canonicalJson({
									session_id: sessionId,
									turn_id: turnId,
									question_id: questionId,
									answer_binding: answerBinding,
									answer: args.answer,
								}),
							)
							.digest("hex");
						await ensureQuestionTransaction(sessionId);
						const replay = await withSessionTransaction(questionPaths, sessionId, async transaction => {
							const request = transaction.requests.answers[keyDigest];
							if (!request) return null;
							if (request.request_digest !== requestDigest)
								return {
									ok: false,
									error: {
										code: "idempotency_conflict",
										message: "Idempotency key was reused with a different answer request.",
									},
								};
							if (request.phase === "completed" && request.safe_receipt) {
								const receipt = request.safe_receipt;
								if (
									receipt.answer_hash !== request.answer_hash ||
									receipt.answer_binding_sha256 !== request.answer_binding_sha256 ||
									receipt.authority_id !== request.authority_id ||
									receipt.turn_id !== request.turn_id ||
									receipt.endpoint_incarnation !== request.endpoint_incarnation ||
									receipt.claim_fence_epoch !== request.claim_fence_epoch
								)
									return {
										ok: false,
										error: {
											code: "terminal_uncertain",
											message: "The stored answer receipt is incomplete.",
										},
									};
								return {
									ok: true,
									schema_version: 1,
									session_id: sessionId,
									turn_id: turnId,
									question_id: questionId,
									operation: "workflow.gate_answer",
									status: receipt.status,
									replayed: true,
									resolved_at: receipt.resolved_at,
								};
							}
							if (request.phase === "uncertain")
								return {
									ok: false,
									error: { code: "terminal_uncertain", message: "The previous answer outcome is uncertain." },
								};
							if (request.phase === "rejected" && request.safe_receipt)
								return {
									ok: false,
									schema_version: 1,
									session_id: sessionId,
									turn_id: turnId,
									question_id: questionId,
									error: { code: "validation_rejected", message: "Answer was rejected by the workflow gate." },
									question_status: "pending",
								};
							return null;
						});
						if (replay) return replay;

						const admission = await reconcileSessionRuntime(sessionId, { observeQuestions: true });
						const admissionToken = admission.waiting_token;
						const liveAdmissionRequired =
							admission.session_state?.source === "agent_session_event" &&
							admission.session_state.live === true &&
							admission.session_state.state === "needs_user_input";
						if (liveAdmissionRequired && !admissionToken)
							return {
								ok: false,
								error: {
									code: "terminal_uncertain",
									message: "Runtime waiting provenance is not admitted.",
								},
							};
						const reconciliation = await reconcileQuestions(sessionId);
						if (!reconciliation.reconciliation.complete)
							return {
								ok: false,
								error: { code: "terminal_uncertain", message: "Workflow gate snapshot is incomplete." },
							};
						let translated: unknown;
						let session: Record<string, unknown> | null = null;
						const claimed = await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
							const liveState = await readSessionState(namespaceDir, sessionId);
							const question = transaction.canonical.questions[questionId];
							if (!question)
								return {
									response: { ok: false, error: { code: "not_found", message: "Question was not found." } },
								};
							if (
								question.session_id !== sessionId ||
								question.turn_id !== turnId ||
								question.endpoint_incarnation !== transaction.canonical.session.broker.endpoint_incarnation
							)
								return {
									response: {
										ok: false,
										error: {
											code: "ownership_mismatch",
											message: "Question ownership does not match this answer.",
										},
									},
								};
							const existingRequest = transaction.requests.answers[keyDigest];
							const recovering =
								(existingRequest?.phase === "remote_started" || existingRequest?.phase === "accepted") &&
								existingRequest.request_digest === requestDigest &&
								existingRequest.question_id === question.question_id &&
								existingRequest.authority_id === question.authority_id &&
								existingRequest.turn_id === question.turn_id &&
								existingRequest.endpoint_incarnation === question.endpoint_incarnation &&
								existingRequest.answer_binding_sha256 === question.binding_sha256 &&
								existingRequest.claim_fence_epoch === question.claim_fence_epoch &&
								question.answer_request_id === existingRequest.request_id;
							if (question.status === "answered" && !recovering)
								return {
									response: {
										ok: false,
										error: {
											code: "idempotency_conflict",
											message: "Question has already been answered by a different request.",
										},
									},
								};

							if (question.status !== "pending" && !recovering)
								return {
									response: {
										ok: false,
										error: { code: "resource_gone", message: "Question is no longer answerable." },
									},
								};
							if (!answerBindingMatches(answerBinding, question.binding_plaintext))
								return {
									response: {
										ok: false,
										error: { code: "ownership_mismatch", message: "Question binding does not match." },
									},
								};
							const answer = validateCoordinatorAskAnswer(question.codec, args.answer);
							if (!answer)
								return {
									response: {
										ok: false,
										schema_version: 1,
										session_id: sessionId,
										turn_id: turnId,
										question_id: questionId,
										error: {
											code: "validation_rejected",
											message: "Answer does not match the question schema.",
										},
										question_status: "pending",
									},
								};
							const turn = await readTurnRecord(namespaceDir, turnId);
							const canonicalTurn = transaction.canonical.turns[turnId];
							const authority = transaction.canonical.gate_authorities[question.authority_id];
							const runtimeTurnId =
								authority?.observation.kind === "valid"
									? authority.observation.first_provenance.runtime_turn_id
									: null;
							const liveWaitingOwned =
								liveState?.source !== "agent_session_event" ||
								liveState.live !== true ||
								(liveState.state === "needs_user_input" && liveState.current_turn_id === turnId);
							const provenanceMatches =
								admissionToken === null ||
								(Boolean(canonicalTurn?.runtime_provenance) &&
									transaction.revision >= admissionToken.transaction_revision &&
									canonicalJson(
										authority?.observation.kind === "valid" ? authority.observation.first_provenance : null,
									) === canonicalJson(canonicalTurn.runtime_provenance));
							if (
								!liveWaitingOwned ||
								(liveState?.source === "agent_session_event" &&
									liveState.live === true &&
									canonicalTurn?.status !== "waiting_for_answer") ||
								!authority ||
								authority.observation.kind !== "valid" ||
								!canonicalTurn ||
								!provenanceMatches ||
								(admissionToken !== null &&
									canonicalJson(canonicalTurn.runtime_provenance) !==
										canonicalJson({
											namespace_id: admissionToken.session_id === sessionId ? config.namespace.identity : "",
											session_id: admissionToken.session_id,
											endpoint_incarnation: transaction.canonical.session.broker.endpoint_incarnation,
											coordinator_turn_id: admissionToken.coordinator_turn_id,
											runtime_turn_id: admissionToken.runtime_turn_id,
											gate_created_at: authority.observation.first_provenance.gate_created_at,
											schema_hash: authority.observation.first_provenance.schema_hash,
											stage: authority.observation.first_provenance.stage,
											kind: authority.observation.first_provenance.kind,
										})) ||
								!turn ||
								canonicalTurn?.terminal_fence ||
								TERMINAL_TURN_STATUSES.has(canonicalTurn?.status as TurnStatus) ||
								TERMINAL_TURN_STATUSES.has(turn.status) ||
								turn.delivery.runtime_turn_id !== runtimeTurnId
							) {
								if (recovering && existingRequest) {
									existingRequest.phase = "uncertain";
									existingRequest.error_code = "terminal_uncertain";
									existingRequest.updated_at = new Date().toISOString();
								}
								return {
									response: {
										ok: false,
										error: {
											code: recovering ? "terminal_uncertain" : "resource_gone",
											message: recovering
												? "The previous answer outcome is uncertain."
												: "Turn is no longer answerable.",
										},
									},
								};
							}
							translated = translateCoordinatorAskAnswer(question.codec, answer);
							session = asRecord(await readJsonFile(sessionFile(sessionId)));
							if (!session)
								return {
									response: {
										ok: false,
										error: { code: "not_found", message: "Coordinator session was not found." },
									},
								};
							if (recovering) {
								return {
									response: null,
									fence: existingRequest.claim_fence_epoch,
									gateId: authority.authority.gate_id,
									requestId: existingRequest.sdk_idempotency_key,
								};
							}
							const requestId = `c07:${createHash("sha256")
								.update(`coordinator-question-v1${question.authority_id}${keyDigest}${requestDigest}`)
								.digest("hex")}`;
							question.status = "resolving";
							question.claim_fence_epoch = transaction.revision + 1;
							question.answer_request_id = requestId;
							question.updated_at = new Date().toISOString();
							transaction.requests.answers[keyDigest] = {
								request_id: requestId,
								key_digest: keyDigest,
								request_digest: requestDigest,
								answer_hash: createHash("sha256").update(canonicalJson(args.answer)).digest("hex"),
								answer_binding_sha256: question.binding_sha256,
								authority_id: question.authority_id,
								question_id: question.question_id,
								turn_id: question.turn_id,
								endpoint_incarnation: question.endpoint_incarnation,
								sdk_idempotency_key: requestId,
								claim_fence_epoch: question.claim_fence_epoch,
								phase: "claimed",
								created_at: question.updated_at,
								updated_at: question.updated_at,
							};
							return {
								response: null,
								fence: question.claim_fence_epoch,
								gateId: authority.authority.gate_id,
								requestId,
							};
						});
						if (claimed.response) return claimed.response;
						const gateId = (claimed as { gateId: string }).gateId;
						await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
							const request = transaction.requests.answers[keyDigest];
							const guardedQuestion = transaction.canonical.questions[questionId];
							const guardedTurn = transaction.canonical.turns[turnId];
							if (
								!request ||
								request.claim_fence_epoch !== (claimed as { fence: number }).fence ||
								!guardedQuestion ||
								guardedQuestion.status !== "resolving" ||
								guardedQuestion.claim_fence_epoch !== (claimed as { fence: number }).fence ||
								guardedTurn?.terminal_fence
							)
								throw new Error("terminal_uncertain");
							if (request.phase === "claimed") request.phase = "remote_started";
							if (request.phase !== "remote_started" && request.phase !== "accepted")
								throw new Error("terminal_uncertain");
							request.updated_at = new Date().toISOString();
						});
						await services.afterAnswerRemoteStarted?.(sessionId);
						const latestAdmission = await reconcileSessionRuntime(sessionId, { observeQuestions: true });
						const latestState = latestAdmission.session_state;
						const latestToken = latestAdmission.waiting_token;
						const latestLiveRequired =
							latestState?.source === "agent_session_event" &&
							latestState.live === true &&
							latestState.state === "needs_user_input";
						if (
							latestAdmission.terminal ||
							(latestLiveRequired && (!latestToken || latestToken.coordinator_turn_id !== turnId)) ||
							(latestState?.source === "agent_session_event" &&
								latestState.live === true &&
								(latestState.state !== "needs_user_input" || latestState.current_turn_id !== turnId))
						) {
							// No remote call has occurred. Undo the durable dispatch claim so this
							// outer request remains retryable rather than stranding the question in
							// remote_started/resolving.
							await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
								const request = transaction.requests.answers[keyDigest];
								const pendingQuestion = transaction.canonical.questions[questionId];
								if (
									request?.claim_fence_epoch === (claimed as { fence: number }).fence &&
									request.phase === "remote_started" &&
									pendingQuestion?.status === "resolving" &&
									pendingQuestion.claim_fence_epoch === (claimed as { fence: number }).fence
								) {
									pendingQuestion.status = "pending";
									pendingQuestion.claim_fence_epoch = null;
									pendingQuestion.answer_request_id = null;
									pendingQuestion.updated_at = new Date().toISOString();
									pendingQuestion.history.push({
										at: pendingQuestion.updated_at,
										status: "pending",
										reason: "dispatch_admission_lost",
									});
									delete transaction.requests.answers[keyDigest];
								}
							});
							return {
								ok: false,
								error: {
									code: "terminal_uncertain",
									message: "Turn became non-answerable before answer dispatch.",
								},
							};
						}

						try {
							const result = await controlSession(
								session!,
								"workflow.gate_answer",
								{ id: gateId, response: translated, expectedSessionId: sessionId },
								(claimed as { requestId: string }).requestId,
							);
							const resolution = sdkResultPayload(result);
							const status = resolution?.status;
							if (status === "rejected") {
								await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
									const question = transaction.canonical.questions[questionId];
									if (
										question?.status === "resolving" &&
										question.claim_fence_epoch === (claimed as { fence: number }).fence
									) {
										question.status = "pending";
										question.claim_fence_epoch = null;
										question.answer_request_id = null;
										question.updated_at = new Date().toISOString();
										question.history.push({
											at: question.updated_at,
											status: "pending",
											reason: "validation_rejected",
										});
									}
									const request = transaction.requests.answers[keyDigest];
									if (request && question) {
										request.phase = "rejected";
										request.safe_receipt = {
											status: "rejected",
											answer_hash: request.answer_hash,
											answer_binding_sha256: request.answer_binding_sha256,
											authority_id: request.authority_id,
											turn_id: request.turn_id,
											endpoint_incarnation: request.endpoint_incarnation,
											claim_fence_epoch: request.claim_fence_epoch,
											resolved_at: question.updated_at,
										};
										request.updated_at = question.updated_at;
									}
								});
								return {
									ok: false,
									schema_version: 1,
									session_id: sessionId,
									turn_id: turnId,
									question_id: questionId,
									error: { code: "validation_rejected", message: "Answer was rejected by the workflow gate." },
									question_status: "pending",
								};
							}
							if (status !== "accepted")
								throw new SdkClientError("terminal_uncertain", "Workflow gate answer was not accepted.");
							const resolvedAt =
								typeof resolution?.resolved_at === "string" ? resolution.resolved_at : new Date().toISOString();
							await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
								const question = transaction.canonical.questions[questionId];
								if (!question || question.claim_fence_epoch !== (claimed as { fence: number }).fence)
									throw new Error("terminal_uncertain");
								question.status = "answered";
								question.answered_at = resolvedAt;
								question.updated_at = resolvedAt;
								question.history.push({ at: resolvedAt, status: "answered", reason: null });
								const authority = transaction.canonical.gate_authorities[question.authority_id];
								if (authority)
									authority.outcome = { state: "answered", turn_id: turnId, question_id: questionId };
								const request = transaction.requests.answers[keyDigest];
								if (!request) throw new Error("terminal_uncertain");
								request.phase = "accepted";
								request.safe_receipt = {
									status: "accepted",
									answer_hash: request.answer_hash,
									answer_binding_sha256: request.answer_binding_sha256,
									authority_id: request.authority_id,
									turn_id: request.turn_id,
									endpoint_incarnation: request.endpoint_incarnation,
									claim_fence_epoch: request.claim_fence_epoch,
									resolved_at: resolvedAt,
								};
								request.phase = "completed";
								request.updated_at = resolvedAt;
							});
							return {
								ok: true,
								schema_version: 1,
								session_id: sessionId,
								turn_id: turnId,
								question_id: questionId,
								operation: "workflow.gate_answer",
								status: "accepted",
								replayed: false,
								resolved_at: resolvedAt,
							};
						} catch (error) {
							await withAdmittedSessionTransaction(questionPaths, sessionId, async transaction => {
								const question = transaction.canonical.questions[questionId];
								if (
									question?.status === "resolving" &&
									question.claim_fence_epoch === (claimed as { fence: number }).fence
								) {
									question.status = "uncertain";
									question.updated_at = new Date().toISOString();
									question.history.push({
										at: question.updated_at,
										status: "uncertain",
										reason: "terminal_uncertain",
									});
								}
								const request = transaction.requests.answers[keyDigest];
								if (request && question) {
									request.phase = "uncertain";
									request.error_code = "terminal_uncertain";
									request.updated_at = question.updated_at;
								}
							});
							return sdkError(error);
						}
					},
					true,
					response => {
						if (isRouterRequestAmbiguous(response)) return true;
						const error = asRecord(response.error);
						return (
							error?.code === "terminal_uncertain" &&
							error.message === "Turn became non-answerable before answer dispatch."
						);
					},
				);
			}
			if (name === "gjc_coordinator_report_status") {
				requireCoordinatorMutation(config, "reports", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
				const canonicalEvidencePaths = canonicalReportEvidencePaths(args.evidence_paths);
				const canonicalArgs = {
					session_id: sessionId,
					turn_id: args.turn_id ?? null,
					status: args.status,
					summary: args.summary,
					blocker: args.blocker,
					pr_url: args.pr_url,
					evidence_paths: canonicalEvidencePaths,
				};
				const reportRequestDigest = createHash("sha256").update(canonicalJson(canonicalArgs)).digest("hex");
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{ ...canonicalArgs, allow_mutation: true },
					async () => {
						const reportKeyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
						const operationId = `report:${reportKeyDigest}`;
						const publicOperationId = `report:${idempotencyKey}`;
						const requestDigest = reportRequestDigest;
						let reportId = `report-${createHash("sha256").update(`report\\0${idempotencyKey}`).digest("hex")}`;
						const reportFromCanonical = (canonical: CanonicalReportSnapshotV1) => ({
							session_id: canonical.session_id,
							turn_id: canonical.turn_id || undefined,
							status: canonical.status,
							summary: canonical.summary,
							blocker: canonical.blocker,
							pr_url: canonical.pr_url,
							evidence_paths: canonical.evidence_paths.map(path => ({ path })),
							created_at: canonical.created_at,
						});
						const responseFor = async (
							report: Record<string, unknown>,
							turn: TurnRecord | null,
						): Promise<Record<string, unknown>> => ({
							ok: true,
							report: boundedPublicValue(report, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
							...(turn
								? {
										turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
										session_state: publicCoordinatorSessionState(
											await readSessionState(namespaceDir, turn.session_id),
										),
									}
								: {}),
						});
						let turn: TurnRecord | null = null;
						if (args.turn_id != null) {
							turn = await readTurnRecord(namespaceDir, args.turn_id);
							if (!turn) return { ok: false, reason: "unknown_turn" };
							if (sessionId != null && turn.session_id !== sessionId)
								return { ok: false, reason: "turn_session_mismatch" };
						}
						const ledgerSessionId = sessionId ?? turn?.session_id ?? null;
						const recoveredCanonicalReport: {
							value: { report: CanonicalReportSnapshotV1; turn: TurnRecord | null } | null;
						} = { value: null };
						let completedResponse: Record<string, unknown> | null = null;
						if (ledgerSessionId) {
							await ensureQuestionTransaction(ledgerSessionId);
							const recovered = await withAdmittedSessionTransaction(
								questionPaths,
								ledgerSessionId,
								async transaction => {
									let operation: OperationRequestV1 | undefined = transaction.requests.operations[operationId];
									if (!operation)
										operation = Object.values(transaction.requests.operations).find(
											candidate => candidate.tool === name && candidate.key_digest === reportKeyDigest,
										);
									if (operation && operation.request_digest !== requestDigest)
										throw new Error("idempotency_conflict");
									if (operation) reportId = operation.local_id;
									completedResponse =
										operation?.phase === "completed" ? asRecord(operation.safe_response) : null;
									const candidateReport =
										(operation ? transaction.canonical.reports[operation.local_id] : undefined) ??
										transaction.canonical.reports[reportId] ??
										Object.values(transaction.canonical.reports).find(
											candidate =>
												candidate.operation_id === operationId ||
												candidate.operation_id === `report:${idempotencyKey}`,
										);
									if (candidateReport) {
										reportId = candidateReport.report_id;
										const recoveredTurn = transaction.canonical.turns[candidateReport.turn_id];
										recoveredCanonicalReport.value = {
											report: candidateReport,
											turn: recoveredTurn ? turnFromCanonical(recoveredTurn) : null,
										};
										if (!operation) {
											const now = new Date().toISOString();
											transaction.requests.operations[operationId] = {
												operation_id: operationId,
												tool: name,
												key_digest: reportKeyDigest,
												request_digest: requestDigest,
												local_id: reportId,
												phase: "claimed",
												intent: canonicalArgs,
												created_at: now,
												updated_at: now,
											};
										}
										return { report_id: reportId };
									}
									if (completedResponse) return completedResponse;
									if (!operation) {
										const now = new Date().toISOString();
										const request: OperationRequestV1 = {
											operation_id: operationId,
											tool: name,
											key_digest: reportKeyDigest,
											request_digest: requestDigest,
											local_id: reportId,
											phase: "claimed",
											intent: canonicalArgs,
											created_at: now,
											updated_at: now,
										};
										transaction.requests.operations[operationId] = request;
									}
									return null;
								},
							);
							if (recoveredCanonicalReport.value) {
								// Canonical state is authoritative for repair, but a completed safe response is
								// the exact public replay and must never be reconstructed or overwritten.
								await repairCanonicalProjections(ledgerSessionId);
								if (completedResponse) return completedResponse;
								const repairedTurn = recoveredCanonicalReport.value.report.turn_id
									? ((await readTurnRecord(namespaceDir, recoveredCanonicalReport.value.report.turn_id)) ??
										recoveredCanonicalReport.value.turn)
									: recoveredCanonicalReport.value.turn;
								const repairedResponse = await responseFor(
									reportFromCanonical(recoveredCanonicalReport.value.report),
									repairedTurn,
								);
								await withAdmittedSessionTransaction(questionPaths, ledgerSessionId, async transaction => {
									const operation =
										transaction.requests.operations[operationId] ??
										Object.values(transaction.requests.operations).find(
											candidate => candidate.tool === name && candidate.key_digest === reportKeyDigest,
										);
									if (!operation || operation.request_digest !== requestDigest)
										throw new Error("terminal_uncertain");
									operation.phase = "completed";
									operation.local_id = recoveredCanonicalReport.value!.report.report_id;
									operation.safe_response = repairedResponse;
									operation.updated_at = new Date().toISOString();
								});
								return repairedResponse;
							}
							if (recovered) return recovered;
						} else {
							const persisted = asRecord(await readJsonFile(reportProjectionFile(namespaceDir, reportId)));
							if (persisted) {
								await appendCoordinatorEvent(namespaceDir, {
									stableId: `report-written:${reportId}`,
									kind: "report.written",
									reportId,
									summary:
										typeof persisted.summary === "string"
											? persisted.summary
											: `Report ${String(persisted.status ?? "unknown")} written`,
									payloadRef: path.relative(namespaceDir, reportProjectionFile(namespaceDir, reportId)),
									metadata: { status: typeof persisted.status === "string" ? persisted.status : null },
								});
								return responseFor(persisted, turn);
							}
						}
						const evidence = await validateEvidencePaths(args.evidence_paths);
						const report = {
							session_id: sessionId,
							turn_id: args.turn_id,
							status: args.status,
							summary: args.summary,
							blocker: args.blocker,
							pr_url: args.pr_url,
							evidence_paths: evidence.map(item => item.path),
							created_at: new Date().toISOString(),
						};
						if (turn) {
							report.session_id = turn.session_id;
							const terminalStatus = asTerminalTurnStatus(args.status);
							if (terminalStatus) {
								const timestamp = new Date().toISOString();
								turn = {
									...turn,
									status: terminalStatus,
									delivery: { ...turn.delivery, prompt_acknowledged: true, state: "acknowledged" },
									final_response: {
										text:
											typeof args.summary === "string"
												? args.summary
												: typeof args.blocker === "string"
													? args.blocker
													: null,
										format: "markdown",
										source: "report_status",
										artifact_path: null,
										truncated: false,
									},
									evidence,
									error:
										terminalStatus === "failed"
											? {
													code: "reported_failure",
													message:
														typeof args.blocker === "string"
															? args.blocker
															: String(args.summary ?? "failed"),
													recoverable: true,
												}
											: null,
									updated_at: timestamp,
									completed_at: timestamp,
								};
								await projectTerminalTransition(turn, {
									desiredState: terminalStatus === "failed" ? "errored" : "completed",
									reason: terminalStatus === "failed" ? "reported_failure" : null,
									report: {
										schema_version: 1,
										report_id: reportId,
										operation_id: publicOperationId,
										session_id: turn.session_id,
										turn_id: turn.turn_id,
										status: String(args.status ?? "unknown"),
										summary: typeof args.summary === "string" ? args.summary : "",
										blocker: optionalString(args.blocker),
										pr_url: optionalString(args.pr_url),
										evidence_paths: evidence.map(item => item.path),
										created_at: report.created_at,
									},
								});
								turn = (await readTurnRecord(namespaceDir, turn.turn_id)) ?? turn;
							}
						}
						if (ledgerSessionId && (!args.turn_id || !asTerminalTurnStatus(args.status))) {
							await withAdmittedSessionTransaction(questionPaths, ledgerSessionId, async transaction => {
								transaction.canonical.reports[reportId] = {
									schema_version: 1,
									report_id: reportId,
									operation_id: publicOperationId,
									session_id: ledgerSessionId,
									turn_id: typeof args.turn_id === "string" ? args.turn_id : "",
									status: String(args.status ?? "unknown"),
									summary: typeof args.summary === "string" ? args.summary : "",
									blocker: optionalString(args.blocker),
									pr_url: optionalString(args.pr_url),
									evidence_paths: evidence.map(item => item.path),
									created_at: report.created_at,
								};
								const reportEventId = deterministicOutboxId(
									ledgerSessionId,
									transaction.revision + 1,
									"report.written",
									"report",
									reportId,
									transaction.canonical.session.broker.endpoint_incarnation,
								);
								transaction.outbox[reportEventId] ??= {
									id: reportEventId,
									transaction_revision: transaction.revision + 1,
									kind: "report.written",
									entity: "report",
									entity_id: reportId,
									payload: {
										session_id: ledgerSessionId,
										turn_id: typeof args.turn_id === "string" ? args.turn_id : null,
										report_id: reportId,
										status: String(args.status ?? "unknown"),
										created_at: report.created_at,
									},
									emitted: false,
									public_event_id: reportEventId,
									public_delivery: {
										public_event_id: reportEventId,
										state: "pending",
										claim_fence: null,
										claim_expires_at: null,
										journal_seq: null,
										acknowledged_at: null,
									},
								};
							});
						}
						const response = await responseFor(report, turn);
						if (ledgerSessionId) {
							await withAdmittedSessionTransaction(questionPaths, ledgerSessionId, async transaction => {
								const operation =
									transaction.requests.operations[operationId] ??
									Object.values(transaction.requests.operations).find(
										candidate => candidate.tool === name && candidate.key_digest === reportKeyDigest,
									);
								if (!operation || operation.request_digest !== requestDigest)
									throw new Error("terminal_uncertain");
								operation.phase = "completed";
								operation.safe_response = response;
								operation.updated_at = new Date().toISOString();
							});
							await services.afterCanonicalReportSafeResponse?.(ledgerSessionId, response);
						}
						const reportPath = reportProjectionFile(namespaceDir, reportId);
						await writeJsonFile(reportPath, report);
						if (ledgerSessionId) {
							await exportRetainedDeliveries();
						} else {
							await appendCoordinatorEvent(namespaceDir, {
								stableId: `report-written:${reportId}`,
								kind: "report.written",
								reportId,
								summary:
									typeof args.summary === "string"
										? args.summary
										: `Report ${String(args.status ?? "unknown")} written`,
								payloadRef: path.relative(namespaceDir, reportPath),
								metadata: { status: typeof args.status === "string" ? args.status : null },
							});
						}
						return response;
					},
					true,
				);
			}
			return { ok: false, reason: "unknown_tool", tool: name };
		} catch (error) {
			return publicError(error);
		}
	}

	async function handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const id = request.id ?? null;
		if (request.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
					capabilities: { tools: {}, prompts: {}, resources: {} },
					serverInfo: { name: COORDINATOR_MCP_SERVER_NAME, version: VERSION },
				},
			};
		}
		if (request.method === "ping") {
			return { jsonrpc: "2.0", id, result: {} };
		}
		if (request.method === "tools/list") {
			return { jsonrpc: "2.0", id, result: { tools: COORDINATOR_MCP_TOOL_NAMES.map(toolSchema) } };
		}
		if (request.method === "prompts/list") {
			return { jsonrpc: "2.0", id, result: { prompts: [] } };
		}
		if (request.method === "resources/list") {
			return { jsonrpc: "2.0", id, result: { resources: [] } };
		}
		if (request.method === "tools/call") {
			const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const payload = await callTool(params.name ?? "", params.arguments ?? {});
			return { jsonrpc: "2.0", id, result: textResult(payload, payload.ok === false) };
		}
		return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown_method:${request.method}` } };
	}

	return {
		config,
		callTool,
		handleJsonRpc,
		handle: handleJsonRpc,
		reapSession,
		signRuntimeSidecarPayloadForTest,
		mintSidecarSigningAuthorityForTest,
		sessionReaper,
		router,
		close: async () => {
			sessionReaper.stop();
			await router.stop();
		},
	};
}

function legacyToolResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	const failed = typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === false;
	return textResult(payload, failed);
}

export async function handleCoordinatorMcpRequest(
	request: JsonRpcRequest,
	options: LegacyHandlerOptions = {},
): Promise<JsonRpcResponse> {
	if (request.method === "initialize") {
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			result: {
				protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
				capabilities: { tools: {}, prompts: {}, resources: {} },
				serverInfo: { name: COORDINATOR_MCP_SERVER_NAME, version: VERSION },
			},
		};
	}
	if (request.method === "tools/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: COORDINATOR_MCP_TOOL_NAMES.map(toolSchema) } };
	}
	if (request.method === "prompts/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { prompts: [] } };
	}
	if (request.method === "resources/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { resources: [] } };
	}
	if (request.method !== "tools/call")
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			error: { code: -32601, message: `unknown_method:${request.method}` },
		};
	const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
	const args = params.arguments ?? {};
	const server = createCoordinatorMcpServer({ env: options.env ?? process.env });
	try {
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			result: legacyToolResult(await server.callTool(params.name ?? "", args)),
		};
	} finally {
		await server.close();
	}
}

export interface PumpCoordinatorOptions {
	/** Max concurrent in-flight *data* (non-control) handlers. Control frames (ping) bypass this. */
	maxDataConcurrency?: number;
	/** Max data requests queued waiting for a slot before overflow is rejected as server_busy. */
	maxQueueDepth?: number;
	/** Bounded wait for in-flight handlers/writes to settle after input ends. */
	drainTimeoutMs?: number;
}

/**
 * Pump a newline-delimited JSON-RPC stream with BOUNDED concurrent dispatch.
 *
 * A long-running tool call (e.g. gjc_coordinator_await_turn, which polls for
 * minutes) must not block the read loop from answering keepalive pings on the
 * same stdio channel. But naive unbounded concurrency reintroduces its own
 * hazards, so this pump enforces the safety envelope the coordinator needs:
 *
 *  - Control frames (ping) bypass the data-concurrency cap → keepalive is always
 *    answerable even while data handlers saturate.
 *  - Data handlers are capped at `maxDataConcurrency`; excess is queued up to
 *    `maxQueueDepth`, then rejected as `server_busy` (bounded memory / fanout).
 *  - A coded local `EPIPE` terminalizes writer and dispatch together; other
 *    writer faults reject the pump without poisoning the serialized write chain.
 *  - On EOF or a closed peer the pump drains already-running handlers (bounded
 *    by `drainTimeoutMs`) and never promotes queued work.
 *  - Byte chunks are decoded with a streaming decoder so multibyte characters
 *    split across chunks are not corrupted.
 */
export async function pumpCoordinatorMcpStream(
	handleJsonRpc: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
	input: AsyncIterable<string | Uint8Array>,
	writeLine: (line: string) => void | Promise<void>,
	options: PumpCoordinatorOptions = {},
): Promise<void> {
	const maxDataConcurrency = Math.max(1, options.maxDataConcurrency ?? 32);
	const maxQueueDepth = Math.max(0, options.maxQueueDepth ?? 256);
	const drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? 30_000);

	let writerState: "open" | "terminalizing" | "closed" = "open";
	let draining = false;
	let writeChain: Promise<void> = Promise.resolve();
	const inFlight = new Set<Promise<void>>();
	let activeData = 0;
	const dataQueue: JsonRpcRequest[] = [];
	const peerClosed = Promise.withResolvers<void>();
	const writerFailure = Promise.withResolvers<never>();
	void writerFailure.promise.catch(() => {});
	const inputIterator = input[Symbol.asyncIterator]();
	let inputDetached = false;
	let fatalWriterFailure: { value: unknown } | undefined;

	const detachInput = (): void => {
		if (inputDetached) return;
		inputDetached = true;
		const detached = inputIterator.return?.();
		if (detached) void detached.catch(() => {});
	};
	const terminalizePeer = (): void => {
		if (writerState !== "open") return;
		writerState = "terminalizing";
		draining = true;
		dataQueue.length = 0;
		detachInput();
		peerClosed.resolve();
	};
	const failWriter = (failure: unknown): void => {
		if (writerState === "closed") return;
		writerState = "closed";
		draining = true;
		dataQueue.length = 0;
		detachInput();
		fatalWriterFailure = { value: failure };

		writerFailure.reject(failure);
	};
	const isExpectedPeerClosure = (failure: unknown): boolean =>
		isKnownSinkPeerClosedError(failure) && sinkErrorCode(failure) === "EPIPE";

	const emit = (response: JsonRpcResponse): Promise<void> => {
		writeChain = writeChain.then(async () => {
			if (writerState !== "open") return;
			try {
				await writeLine(`${JSON.stringify(response)}\n`);
			} catch (failure) {
				if (isExpectedPeerClosure(failure)) terminalizePeer();
				else failWriter(failure);
			}
		});
		return writeChain;
	};

	const launch = (request: JsonRpcRequest, control: boolean): void => {
		const task = (async () => {
			let response: JsonRpcResponse;
			try {
				response = await handleJsonRpc(request);
			} catch {
				response = {
					jsonrpc: "2.0",
					id: request.id ?? null,
					error: { code: -32603, message: "coordinator_request_failed" },
				};
			}
			await emit(response);
			if (!control) {
				activeData -= 1;
				if (!draining && writerState === "open") {
					const next = dataQueue.shift();
					if (next) {
						activeData += 1;
						launch(next, false);
					}
				}
			}
		})();
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	};

	const dispatch = (request: JsonRpcRequest): void => {
		if (writerState !== "open") return;
		// Notifications (no id) get no response; the coordinator has no side-effecting ones.
		if (request.id === undefined || request.id === null) return;
		if (request.method === "ping") {
			launch(request, true);
			return;
		}
		if (activeData < maxDataConcurrency) {
			activeData += 1;
			launch(request, false);
			return;
		}
		if (dataQueue.length < maxQueueDepth) {
			dataQueue.push(request);
			return;
		}
		void emit({
			jsonrpc: "2.0",
			id: request.id,
			error: { code: -32000, message: "server_busy: coordinator request queue is full" },
		});
	};

	const drainInFlightAndWrites = async (): Promise<void> => {
		const timeout = Promise.withResolvers<"timed_out">();
		const timer = setTimeout(() => timeout.resolve("timed_out"), drainTimeoutMs);
		(timer as { unref?: () => void }).unref?.();
		const drain = async (): Promise<"drained"> => {
			while (true) {
				if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
				const writes = writeChain;
				await writes;
				if (inFlight.size === 0 && writes === writeChain) return "drained";
			}
		};
		try {
			if ((await Promise.race([drain(), timeout.promise])) === "timed_out") {
				writerState = "closed";
				draining = true;
				dataQueue.length = 0;
				detachInput();
			}
		} finally {
			clearTimeout(timer);
		}
	};

	const decoder = new TextDecoder();
	let buffer = "";
	let inputFailure: unknown;
	try {
		while (writerState === "open") {
			const next = await Promise.race([inputIterator.next(), peerClosed.promise, writerFailure.promise]);
			if (!next || next.done) break;
			buffer += typeof next.value === "string" ? next.value : decoder.decode(next.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0 && writerState === "open") {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) {
					let request: JsonRpcRequest | null = null;
					try {
						request = JSON.parse(line) as JsonRpcRequest;
					} catch {
						request = null; // ignore malformed frames rather than crashing the loop
					}
					if (request) dispatch(request);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} catch (failure) {
		inputFailure = failure;
	}

	// Input EOF or a closed peer stops promotion. One deadline bounds both the
	// active handlers and the serialized writes they have already queued.
	draining = true;
	dataQueue.length = 0;
	await drainInFlightAndWrites();
	if (fatalWriterFailure) throw fatalWriterFailure.value;
	if (inputFailure !== undefined) throw inputFailure;
	writerState = "closed";
}

export async function runCoordinatorMcpStdio(options: CoordinatorMcpServerOptions = {}): Promise<void> {
	const server = createCoordinatorMcpServer(options);
	server.sessionReaper.start();
	try {
		await pumpCoordinatorMcpStream(
			request => server.handleJsonRpc(request),
			process.stdin,
			line => {
				const write = Promise.withResolvers<void>();
				process.stdout.write(line, error => (error ? write.reject(error) : write.resolve()));
				return write.promise;
			},
		);
	} finally {
		await server.close();
	}
}
