import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils/dirs";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
	type CoordinatorToolName,
} from "../coordinator/contract";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "../gjc-runtime/session-state-sidecar";
import {
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	isExactScopedBootstrapSuccessReceipt,
	type OwnerIsolationProbe,
	ownerProcessStartTime,
	planTmuxOwnerIsolation,
	replaceOwnerGenerationSync,
	type TmuxServerProof,
} from "../gjc-runtime/tmux-owner-isolation";

import {
	assertCoordinatorArtifactPath,
	assertCoordinatorWorkdir,
	buildCoordinatorMcpConfig,
	type CoordinatorMcpConfig,
	coordinatorNamespacePath,
	requireCoordinatorMutation,
} from "./policy";

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

interface SessionStartInput {
	cwd: string;
	prompt?: string;
	namespace: { profile: string | null; repo: string | null };
	worktree: true;
}

interface SessionRegisterInput {
	sessionId: string;
	cwd: string;
	tmuxSession: string;
	tmuxTarget: string;
	visible: boolean;
	warpAttached: boolean | null;
	source: string;
	model: string | null;
}

interface CoordinatorFinalResponse {
	text: string | null;
	format: "markdown";
	source: string | null;
	artifact_path: string | null;
	truncated: boolean;
}

function reportableFinalResponse(response: CoordinatorFinalResponse): boolean {
	return (
		(typeof response.text === "string" && response.text.trim().length > 0) ||
		(typeof response.artifact_path === "string" && response.artifact_path.trim().length > 0)
	);
}

interface RuntimeSessionStatePayload extends CoordinatorSessionState {
	final_response?: CoordinatorFinalResponse;
	error?: { code: string; message: string; recoverable: boolean } | null;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

type CommandRunner = (command: string[], stdinLine?: string) => Promise<CommandResult>;

interface CoordinatorServices {
	listSessions?: () => unknown[] | Promise<unknown[]>;
	startSession?: (input: SessionStartInput) => unknown | Promise<unknown>;
	commandRunner?: CommandRunner;
	ownerIsolationProbe?: OwnerIsolationProbe;
}

interface CoordinatorMcpServerOptions {
	env?: NodeJS.ProcessEnv;
	services?: CoordinatorServices;
}

interface LegacyHandlerOptions {
	env?: NodeJS.ProcessEnv;
	createSession?: () => unknown;
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
	prompt: {
		text: string;
		created_at: string;
		source: "mcp" | "question_answer";
	};
	delivery: {
		delivered: boolean;
		queued: boolean;
		target: string | null;
		tmux_keys_sent?: boolean;
		prompt_acknowledged?: boolean;
		state?: "queued" | "tmux_keys_sent" | "acknowledged" | "unavailable" | "unacknowledged";
		attempts: Array<{
			delivered: boolean;
			created_at: string;
			reason: string | null;
			channel?: "tmux_keys" | "runtime_ack";
			tmux_keys_sent?: boolean;
		}>;
	};
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
	liveness: {
		checked_at: string | null;
		live: boolean | null;
		reason: string | null;
	};
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
}

type CoordinatorSessionStateValue =
	| "booting"
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
	source: "coordinator" | "agent_session_event" | "process_postmortem";

	live: boolean | null;
	reason: string | null;
	cwd?: string;
	workdir?: string;
	session_file?: string | null;
	owner_generation?: string;
	event?: string;
	owner_terminal?: {
		generation: string;
		socket_key: string;
		classification: string;
		observer: string;
		observed_at: string;
	};
}

type CoordinatorEventKind =
	| "session.registered"
	| "session.started"
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
	metadata?: Record<string, string | number | boolean | null>;
}

interface CoordinatorEventInput {
	kind: CoordinatorEventKind;
	sessionId?: string | null;
	turnId?: string | null;
	questionId?: string | null;
	reportId?: string | null;
	summary: string;
	payloadRef?: string | null;
	metadata?: Record<string, string | number | boolean | null>;
}

const MISSING_FINAL_RESPONSE_ADVISORY = "completion_missing_final_response";
const PROMPT_ACK_TIMEOUT_REASON = "runtime_prompt_ack_timeout";
const DEFAULT_RUNTIME_PROMPT_ACK_TIMEOUT_MS = 10_000;
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
		content: [
			{
				type: "text",
				text: typeof payload === "string" ? payload : JSON.stringify(payload),
			},
		],
		isError,
	};
}

function toolSchema(name: CoordinatorToolName): {
	name: CoordinatorToolName;
	description: string;
	inputSchema: Record<string, unknown>;
} {
	const allowMutation = {
		type: "boolean",
		description: "Required and must be true for mutating tools.",
	};
	const cwd = {
		type: "string",
		description: "Canonicalized GJC worktree or project directory inside configured roots.",
	};
	const sessionId = {
		type: "string",
		description: "GJC coordinator bridge session id.",
	};
	const pathField = {
		type: "string",
		description: "Artifact path inside configured safe roots.",
	};
	const common = { type: "object", properties: {} as Record<string, unknown> };
	if (name === "gjc_coordinator_register_session") {
		return {
			name,
			description: "Register an existing visible tmux GJC session as a coordinator-authoritative session.",
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
				},
				required: ["session_id", "cwd", "tmux_session", "tmux_target", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_start_session") {
		return {
			name,
			description: "Start a GJC worktree/tmux oriented session through the coordinator bridge.",
			inputSchema: {
				type: "object",
				properties: {
					cwd,
					prompt: { type: "string" },
					allow_mutation: allowMutation,
				},
				required: ["cwd", "allow_mutation"],
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
					allow_mutation: allowMutation,
				},
				required: ["session_id", "prompt", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_read_turn") {
		return {
			name,
			description: "Read authoritative durable turn state plus bounded advisory tmux status.",
			inputSchema: {
				type: "object",
				properties: {
					session_id: sessionId,
					turn_id: { type: "string" },
					lines: { type: "number" },
				},
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
					lines: { type: "number" },
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
					answer: {},
					allow_mutation: allowMutation,
				},
				required: ["question_id", "answer", "allow_mutation"],
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
					allow_mutation: allowMutation,
				},
				required: ["status", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_coordinator_read_artifact") {
		return {
			name,
			description: "Read one bounded artifact from configured safe roots.",
			inputSchema: {
				type: "object",
				properties: { path: pathField },
				required: ["path"],
			},
		};
	}
	if (name === "gjc_coordinator_read_status") {
		return {
			name,
			description: "Read selected coordinator bridge session status.",
			inputSchema: { type: "object", properties: { session_id: sessionId } },
		};
	}
	if (name === "gjc_coordinator_read_tail") {
		return {
			name,
			description: "Read a bounded structured session tail, not tmux scrollback.",
			inputSchema: {
				type: "object",
				properties: { session_id: sessionId, lines: { type: "number" } },
			},
		};
	}
	if (name === "gjc_coordinator_list_questions") {
		return {
			name,
			description: "List bounded structured questions for coordinator coordination.",
			inputSchema: {
				type: "object",
				properties: { session_id: sessionId, status: { type: "string" } },
			},
		};
	}
	if (name === "gjc_coordinator_list_artifacts") {
		return {
			name,
			description: "List known safe artifact roots for coordinator coordination.",
			inputSchema: common,
		};
	}
	if (name === "gjc_coordinator_read_coordination_status") {
		return {
			name,
			description: "Read coordinator coordination reports.",
			inputSchema: common,
		};
	}
	if (name === "gjc_coordinator_watch_events") {
		return {
			name,
			description: "Long-poll the durable coordinator event journal for new bounded event records.",
			inputSchema: {
				type: "object",
				properties: {
					after_seq: { type: "number" },
					session_id: sessionId,
					event_types: { type: "array", items: { type: "string" } },
					timeout_ms: {
						type: "number",
						description: "Bounded event long-poll timeout in milliseconds, capped at 30 seconds.",
					},
					limit: { type: "number" },
				},
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
					prompt: {
						type: "string",
						description: "Alias for task; accepted when task is absent.",
					},
					allow_mutation: allowMutation,
					session_id: {
						type: "string",
						description:
							"Optional existing GJC coordinator bridge session id to reuse; omitted starts a fresh session.",
					},
					queue: {
						type: "boolean",
						description: "When reusing a session with an active turn, queue instead of failing.",
					},
					force: {
						type: "boolean",
						description: "When reusing a session with an active turn, supersede it before sending.",
					},
					model: {
						type: "string",
						description: "Optional model hint passed in prompt metadata; no provider default is implied.",
					},
					await_completion: {
						type: "boolean",
						description: "If true, poll the turn until terminal or timeout.",
					},
					timeout_ms: {
						type: "number",
						description:
							"Bounded await timeout in milliseconds, capped at 30 minutes like gjc_coordinator_await_turn.",
					},
					poll_interval_ms: {
						type: "number",
						description: "Bounded await polling interval.",
					},
					lines: {
						type: "number",
						description: "Bounded advisory tail lines returned with await/read payloads.",
					},
				},
				required: ["cwd", "allow_mutation"],
			},
		};
	}
	return {
		name,
		description: "List known scoped GJC coordinator bridge sessions.",
		inputSchema: common,
	};
}

type DelegateWorkflow = "plan" | "execute" | "team";

function workflowForDelegateTool(name: string): DelegateWorkflow | null {
	switch (name) {
		case "gjc_delegate_plan":
			return "plan";
		case "gjc_delegate_execute":
			return "execute";
		case "gjc_delegate_team":
			return "team";
		default:
			return null;
	}
}

function workflowSkill(workflow: DelegateWorkflow): "ralplan" | "ultragoal" | "team" {
	switch (workflow) {
		case "plan":
			return "ralplan";
		case "execute":
			return "ultragoal";
		case "team":
			return "team";
	}
}

function delegateToolDescription(workflow: DelegateWorkflow): string {
	switch (workflow) {
		case "plan":
			return "Delegate consensus planning to GJC: start a session and run /skill:ralplan to completion, returning durable turn status and artifact references.";
		case "execute":
			return "Delegate execution to GJC: start a session and run /skill:ultragoal to completion, returning durable turn status and artifact references.";
		case "team":
			return "Delegate parallel team execution to GJC: start a session and run /skill:team to completion, returning durable turn status and artifact references.";
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

const PRIVATE_SESSION_CONTROL_FIELDS = new Set([
	"tmux_socket_key",
	"tmuxSocketKey",
	"tmux_owner_generation",
	"tmuxOwnerGeneration",
	"tmux_owner_state_dir",
	"tmuxOwnerStateDir",
	"tmux_owner_server_key",
	"tmuxOwnerServerKey",
	"tmux_owner_server_pid",
	"tmuxOwnerServerPid",
	"tmux_owner_server_start_time",
	"tmuxOwnerServerStartTime",
	"tmux_native_session_id",
	"tmuxNativeSessionId",
	"pane_id",
	"paneId",
	"socket_key",
	"socketKey",
	"owner_generation",
	"ownerGeneration",
	"state_dir",
	"ownerStateDir",
	"owner_server_key",
	"ownerServerKey",
	"owner_server_pid",
	"ownerServerPid",
	"owner_server_start_time",
	"ownerServerStartTime",
	"owner_terminal",
	"ownerTerminal",
	"generation",
	"server_key",
	"intent_id",
	"dedupe_key",
	"__coordinatorOwnerTransaction",
]);

function publicSessionProjection(session: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(session).filter(([key]) => !PRIVATE_SESSION_CONTROL_FIELDS.has(key)));
}

function publicCoordinatorResponse(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(publicCoordinatorResponse);
	const record = asRecord(value);
	if (!record) return value;
	return Object.fromEntries(
		Object.entries(publicSessionProjection(record)).map(([key, item]) => [key, publicCoordinatorResponse(item)]),
	);
}

function normalizeSession(session: Record<string, unknown>): Record<string, unknown> {
	const suppliedIds = [session.session_id, session.sessionId, session.name].filter(
		(value): value is string => typeof value === "string",
	);
	if (suppliedIds.length === 0) throw new Error("invalid_session_id");
	const sessionId = safeExternalId("session", suppliedIds[0]);
	if (suppliedIds.some(value => value !== sessionId)) throw new Error("session_id_conflict");
	return {
		...(session.tmuxSession ? { tmux_session: session.tmuxSession } : {}),
		...(session.tmuxTarget ? { tmux_target: session.tmuxTarget } : {}),
		...(session.tmuxSocketKey ? { tmux_socket_key: session.tmuxSocketKey } : {}),
		...(session.tmuxOwnerGeneration ? { tmux_owner_generation: session.tmuxOwnerGeneration } : {}),
		...(session.tmuxOwnerStateDir ? { tmux_owner_state_dir: session.tmuxOwnerStateDir } : {}),
		...(session.tmuxOwnerServerKey ? { tmux_owner_server_key: session.tmuxOwnerServerKey } : {}),
		...(session.tmuxOwnerServerPid ? { tmux_owner_server_pid: session.tmuxOwnerServerPid } : {}),
		...(session.tmuxOwnerServerStartTime ? { tmux_owner_server_start_time: session.tmuxOwnerServerStartTime } : {}),
		...(session.tmuxNativeSessionId ? { tmux_native_session_id: session.tmuxNativeSessionId } : {}),
		...(session.paneId ? { pane_id: session.paneId } : {}),
		...(session.cwd ? { cwd: session.cwd } : {}),
		...(session.createdAt ? { created_at: session.createdAt } : {}),
		...session,
		session_id: sessionId,
		sessionId,
	};
}

async function canonicalizePath(value: string): Promise<string> {
	try {
		return await fs.realpath(value);
	} catch {
		return path.resolve(value);
	}
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

class CoordinatorStateError extends Error {
	constructor(readonly reason: "invalid" | "unreadable") {
		super(`coordinator_state_${reason}`);
	}
}

const COORDINATOR_SESSION_STATES = new Set<CoordinatorSessionStateValue>([
	"booting",
	"ready_for_input",
	"running",
	"needs_user_input",
	"completed",
	"errored",
	"stale",
	"unknown",
]);
const COORDINATOR_EVENT_KINDS = new Set<CoordinatorEventKind>([
	"session.registered",
	"session.started",
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

function coordinatorStateError(reason: "invalid" | "unreadable"): CoordinatorStateError {
	return new CoordinatorStateError(reason);
}

function isValidCoordinatorSessionState(value: unknown, sessionId: string): value is CoordinatorSessionState {
	const record = asRecord(value);
	return (
		record?.schema_version === 1 &&
		record.session_id === sessionId &&
		typeof record.state === "string" &&
		COORDINATOR_SESSION_STATES.has(record.state as CoordinatorSessionStateValue) &&
		typeof record.ready_for_input === "boolean" &&
		record.ready_for_input === (record.state === "ready_for_input" || record.state === "completed") &&
		(record.current_turn_id === null ||
			(typeof record.current_turn_id === "string" && TURN_ID_PATTERN.test(record.current_turn_id))) &&
		(record.last_turn_id === null ||
			(typeof record.last_turn_id === "string" && TURN_ID_PATTERN.test(record.last_turn_id))) &&
		typeof record.updated_at === "string" &&
		Number.isFinite(Date.parse(record.updated_at)) &&
		(record.source === "coordinator" ||
			record.source === "agent_session_event" ||
			record.source === "process_postmortem") &&
		(record.live === null || typeof record.live === "boolean") &&
		(record.reason === null || typeof record.reason === "string")
	);
}

const MAX_RUNTIME_FINAL_RESPONSE_TEXT_LENGTH = 16_384;
const MAX_RUNTIME_FINAL_RESPONSE_SOURCE_LENGTH = 256;
const MAX_RUNTIME_FINAL_RESPONSE_ARTIFACT_PATH_LENGTH = 1_024;
const MAX_RUNTIME_ERROR_CODE_LENGTH = 128;
const MAX_RUNTIME_ERROR_MESSAGE_LENGTH = 4_096;

function isBoundedNullableString(value: unknown, maxLength: number): value is string | null {
	return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isValidRuntimeFinalResponse(value: unknown): value is CoordinatorFinalResponse {
	const record = asRecord(value);
	return (
		record !== null &&
		Object.keys(record).every(key => ["text", "format", "source", "artifact_path", "truncated"].includes(key)) &&
		isBoundedNullableString(record.text, MAX_RUNTIME_FINAL_RESPONSE_TEXT_LENGTH) &&
		record.format === "markdown" &&
		(record.source === null ||
			(typeof record.source === "string" &&
				record.source.length > 0 &&
				record.source.length <= MAX_RUNTIME_FINAL_RESPONSE_SOURCE_LENGTH)) &&
		(record.artifact_path === null ||
			(typeof record.artifact_path === "string" &&
				record.artifact_path.length > 0 &&
				record.artifact_path.length <= MAX_RUNTIME_FINAL_RESPONSE_ARTIFACT_PATH_LENGTH &&
				!path.isAbsolute(record.artifact_path) &&
				!record.artifact_path.split(/[\\/]/).includes(".."))) &&
		typeof record.truncated === "boolean"
	);
}

function isValidRuntimeError(value: unknown): value is NonNullable<RuntimeSessionStatePayload["error"]> {
	const record = asRecord(value);
	return (
		record !== null &&
		Object.keys(record).every(key => ["code", "message", "recoverable"].includes(key)) &&
		typeof record.code === "string" &&
		record.code.length > 0 &&
		record.code.length <= MAX_RUNTIME_ERROR_CODE_LENGTH &&
		typeof record.message === "string" &&
		record.message.length > 0 &&
		record.message.length <= MAX_RUNTIME_ERROR_MESSAGE_LENGTH &&
		typeof record.recoverable === "boolean"
	);
}

function isValidOwnerTerminalRuntimeReceipt(value: unknown, sessionId: string): boolean {
	const record = asRecord(value);
	if (!record) return false;
	const baseKeys = [
		"generation",
		"socket_key",
		"signal",
		"result",
		"classification",
		"observer",
		"observed_at",
		"dedupe_key",
	];
	const keys = Object.keys(record);
	if (!keys.every(key => [...baseKeys, "intent_id"].includes(key)) || baseKeys.some(key => !keys.includes(key)))
		return false;
	if (
		!validRuntimeOwnerGeneration(record.generation) ||
		!validRuntimeOwnerGeneration(record.socket_key) ||
		typeof record.signal !== "string" ||
		!["SIGTERM", "SIGHUP", "SIGINT", "SIGKILL", "EXIT", "MANUAL", "UNKNOWN"].includes(record.signal) ||
		typeof record.result !== "string" ||
		!record.result ||
		record.result.length > 64 ||
		!["expected_operator_shutdown", "unexpected_owner_loss", "non_operator_cleanup"].includes(
			String(record.classification),
		) ||
		!["sidecar", "raw_monitor"].includes(String(record.observer)) ||
		typeof record.observed_at !== "string" ||
		!Number.isFinite(Date.parse(record.observed_at)) ||
		record.dedupe_key !== `owner-loss:${sessionId}:${record.generation}`
	)
		return false;
	if (record.classification === "expected_operator_shutdown")
		return (
			record.signal === "SIGTERM" &&
			record.result === "owner_term_then_session_cleanup" &&
			typeof record.intent_id === "string" &&
			record.intent_id.length > 0
		);
	if (record.intent_id !== undefined) return false;
	if (record.classification === "non_operator_cleanup") return record.result === "cleanup";
	return ["owner_lost", "cleanup", "process_postmortem", "exit", "unknown_terminal"].includes(record.result);
}

function isValidRuntimeSessionState(value: unknown, sessionId: string): value is RuntimeSessionStatePayload {
	if (!isValidCoordinatorSessionState(value, sessionId)) return false;
	const record = asRecord(value);
	if (!record) return false;
	const finalResponse = record.final_response;
	const error = record.error;
	if (finalResponse !== undefined && !isValidRuntimeFinalResponse(finalResponse)) return false;
	if (record.source !== "coordinator" && record.live !== (record.state === "running")) return false;
	if (error !== undefined && error !== null && !isValidRuntimeError(error)) return false;
	if (record.owner_generation !== undefined && !validRuntimeOwnerGeneration(record.owner_generation)) return false;
	if (record.source === "coordinator") return finalResponse === undefined && (error === undefined || error === null);
	if (record.source === "process_postmortem") {
		if (record.state !== "completed" && record.state !== "errored") return false;
		if (record.event === "owner_terminal") {
			if (!isValidOwnerTerminalRuntimeReceipt(record.owner_terminal, sessionId)) return false;
			const ownerTerminal = asRecord(record.owner_terminal)!;
			const expected = ownerTerminal.classification === "expected_operator_shutdown";
			if (
				record.reason !== ownerTerminal.classification ||
				record.state !== (expected ? "completed" : "errored") ||
				(expected
					? error !== undefined && error !== null
					: error === undefined ||
						error === null ||
						error.code !== ownerTerminal.classification ||
						error.recoverable !== true)
			)
				return false;
		} else if (record.event === "process_exit") {
			if (
				record.owner_terminal !== undefined ||
				typeof record.exit_kind !== "string" ||
				record.exit_kind.length === 0 ||
				record.exit_kind.length > 128 ||
				(record.exit_code !== null &&
					(typeof record.exit_code !== "number" || !Number.isSafeInteger(record.exit_code))) ||
				(record.signal !== null &&
					record.signal !== "SIGINT" &&
					record.signal !== "SIGTERM" &&
					record.signal !== "SIGHUP") ||
				typeof record.prompt_accepted !== "boolean" ||
				typeof record.observed_recoverable_worktree_changes !== "boolean" ||
				(record.worktree_baseline_dirty !== null && typeof record.worktree_baseline_dirty !== "boolean") ||
				typeof record.worktree_changed_since_baseline !== "boolean"
			)
				return false;
		} else {
			return false;
		}
	}
	if (record.state === "completed") return error === undefined || error === null;
	if (record.state === "errored") return error !== undefined && error !== null;
	return finalResponse === undefined && (error === undefined || error === null);
}

const PUBLIC_COORDINATOR_ERRORS = new Set([
	"coordinator_workdir_required",
	"coordinator_workdir_roots_required",
	"coordinator_workdir_outside_allowed_roots",
	"coordinator_artifact_path_required",
	"coordinator_artifact_roots_required",
	"coordinator_artifact_outside_allowed_roots",
	"coordinator_mutation_class_disabled",
	"coordinator_mutation_call_not_allowed",
	"invalid_session_id",
	"invalid_tmux_session",
	"invalid_tmux_target",
	"invalid_turn_id",
	"invalid_question_id",
	"session_id_conflict",
	"tmux_session_unavailable",
	"tmux_target_unavailable",
	"coordinator_session_command_required",
	"coordinator_prompt_buffer_privacy_unverified",
	"coordinator_tmux_start_failed",
	"coordinator_tmux_owner_server_unsafe",
	"coordinator_tmux_owner_server_unverifiable",
	"coordinator_tmux_owner_server_race",
	"coordinator_evidence_paths_must_be_array",
]);

class CoordinatorStartError extends Error {
	constructor(
		message: string,
		readonly cleanupStatus: "cleaned" | "failed" | "unverifiable",
	) {
		super(message);
	}
}

function publicCleanupStatus(error: unknown): "cleaned" | "failed" | "unverifiable" | undefined {
	return error instanceof CoordinatorStartError ? error.cleanupStatus : undefined;
}

function publicCoordinatorError(error: unknown): string {
	if (error instanceof CoordinatorStateError) return `coordinator_state_${error.reason}`;
	const message = error instanceof Error ? error.message : "";
	const normalized = message
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const code = normalized.split(":", 1)[0];
	return PUBLIC_COORDINATOR_ERRORS.has(code) ? code : "coordinator_request_failed";
}

function isExpectedStateAbsence(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readJsonFile(file: string): Promise<unknown | null> {
	let content: string;
	try {
		content = await fs.readFile(file, "utf8");
	} catch (error) {
		if (isExpectedStateAbsence(error)) return null;
		throw coordinatorStateError("unreadable");
	}
	try {
		return JSON.parse(content);
	} catch {
		throw coordinatorStateError("invalid");
	}
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function listJsonFiles(dir: string): Promise<unknown[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (isExpectedStateAbsence(error)) return [];
		throw coordinatorStateError("unreadable");
	}
	return await Promise.all(
		entries.filter(entry => entry.endsWith(".json")).map(entry => readJsonFile(path.join(dir, entry))),
	);
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
		reason: firstString(record, ["reason"]),
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

function boundSummary(value: string): string {
	const normalized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

async function readLatestEventSeq(namespaceDir: string): Promise<number> {
	const rawSequence = await readJsonFile(eventSequenceFile(namespaceDir));
	const events = await readCoordinatorEvents(namespaceDir);
	const journalLatestSeq = events.at(-1)?.seq ?? 0;
	if (rawSequence === null) return journalLatestSeq;
	const sequence = asRecord(rawSequence);
	if (
		!sequence ||
		Object.keys(sequence).some(key => key !== "seq" && key !== "updated_at") ||
		typeof sequence.seq !== "number" ||
		!Number.isSafeInteger(sequence.seq) ||
		sequence.seq < 0 ||
		typeof sequence.updated_at !== "string" ||
		!Number.isFinite(Date.parse(sequence.updated_at)) ||
		sequence.seq > journalLatestSeq
	)
		throw coordinatorStateError("invalid");
	return journalLatestSeq;
}

const eventAppendQueues = new Map<string, Promise<unknown>>();

/** Lock order: namespace transaction lock, then event journal lock. */
function coordinatorTransactionLockFile(namespaceDir: string): string {
	return path.join(namespaceDir, "locks", "mutation.lock");
}

async function withCoordinatorTransaction<T>(namespaceDir: string, operation: () => Promise<T>): Promise<T> {
	return await withSessionStateLock(coordinatorTransactionLockFile(namespaceDir), operation);
}

async function appendCoordinatorEvent(namespaceDir: string, input: CoordinatorEventInput): Promise<CoordinatorEvent> {
	const previous = eventAppendQueues.get(namespaceDir) ?? Promise.resolve();
	const { promise: current, resolve: release } = Promise.withResolvers<void>();
	const queued = previous.then(
		() => current,
		() => current,
	);
	eventAppendQueues.set(namespaceDir, queued);

	await previous.catch(() => undefined);
	try {
		return await withSessionStateLock(eventJournalFile(namespaceDir), async () => {
			const latestSeq = await readLatestEventSeq(namespaceDir);
			const seq = latestSeq + 1;
			const timestamp = new Date().toISOString();
			const event: CoordinatorEvent = {
				schema_version: 1,
				seq,
				id: `event-${seq.toString().padStart(12, "0")}`,
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
			await ensureDir(eventsDir(namespaceDir));
			await fs.appendFile(eventJournalFile(namespaceDir), `${JSON.stringify(event)}\n`);
			await writeJsonFile(eventSequenceFile(namespaceDir), {
				seq,
				updated_at: timestamp,
			});
			return event;
		});
	} finally {
		release();
		if (eventAppendQueues.get(namespaceDir) === queued) eventAppendQueues.delete(namespaceDir);
	}
}

// Per-session mutation lock. Concurrent stdio dispatch (see pumpCoordinatorMcpStream) makes
// same-session read-modify-write tool calls (notably send_prompt: read active turn → decide →
// write new turn) interleave, which could persist two "active" turns while only one active-turn
// pointer survives. Serializing per session — same promise-chain shape as eventAppendQueues —
// restores the atomicity the former serial read loop provided, without serializing across
// sessions or blocking long read-only polls (await_turn/watch_events). This is an in-process
// lock distinct from the file-based withSessionStateLock/withCoordinatorTransaction, so it can
// never deadlock by nesting inside them.
const sessionMutationQueues = new Map<string, Promise<unknown>>();

async function withSessionMutation<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = sessionMutationQueues.get(key) ?? Promise.resolve();
	const { promise: current, resolve: release } = Promise.withResolvers<void>();
	const queued = previous.then(
		() => current,
		() => current,
	);
	sessionMutationQueues.set(key, queued);
	await previous.catch(() => undefined);
	try {
		return await fn();
	} finally {
		release();
		if (sessionMutationQueues.get(key) === queued) sessionMutationQueues.delete(key);
	}
}

function parseCoordinatorEvent(line: string): CoordinatorEvent {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		throw coordinatorStateError("invalid");
	}
	const record = asRecord(event);
	const allowed = new Set([
		"schema_version",
		"seq",
		"id",
		"timestamp",
		"kind",
		"session_id",
		"turn_id",
		"question_id",
		"report_id",
		"summary",
		"payload_ref",
		"metadata",
	]);
	const metadata = asRecord(record?.metadata);
	const validMetadata =
		record?.metadata === undefined && metadata === null
			? true
			: metadata !== null &&
				Object.values(metadata).every(
					value => value === null || ["string", "number", "boolean"].includes(typeof value),
				);
	const validOptionalExternalId = (value: unknown) =>
		value === undefined || (typeof value === "string" && SAFE_EXTERNAL_ID_PATTERN.test(value));
	const validPayloadRef =
		record?.payload_ref === undefined ||
		(typeof record.payload_ref === "string" &&
			record.payload_ref.length > 0 &&
			!path.isAbsolute(record.payload_ref) &&
			!record.payload_ref.split(/[\\/]/).includes(".."));
	if (
		!record ||
		Object.keys(record).some(key => !allowed.has(key)) ||
		record.schema_version !== 1 ||
		typeof record.seq !== "number" ||
		!Number.isSafeInteger(record.seq) ||
		record.seq <= 0 ||
		record.id !== `event-${record.seq.toString().padStart(12, "0")}` ||
		typeof record.timestamp !== "string" ||
		!Number.isFinite(Date.parse(record.timestamp)) ||
		typeof record.kind !== "string" ||
		!COORDINATOR_EVENT_KINDS.has(record.kind as CoordinatorEventKind) ||
		typeof record.summary !== "string" ||
		record.summary.length > 240 ||
		!validOptionalExternalId(record.session_id) ||
		(record.turn_id !== undefined && (typeof record.turn_id !== "string" || !TURN_ID_PATTERN.test(record.turn_id))) ||
		!validOptionalExternalId(record.question_id) ||
		!validOptionalExternalId(record.report_id) ||
		!validPayloadRef ||
		!validMetadata
	) {
		throw coordinatorStateError("invalid");
	}
	return record as unknown as CoordinatorEvent;
}

async function readCoordinatorEvents(namespaceDir: string): Promise<CoordinatorEvent[]> {
	const journalFile = eventJournalFile(namespaceDir);
	let content: string;
	try {
		content = await fs.readFile(journalFile, "utf8");
	} catch (error) {
		if (isExpectedStateAbsence(error)) return [];
		throw coordinatorStateError("unreadable");
	}
	const events = content
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(parseCoordinatorEvent);
	for (let index = 1; index < events.length; index++) {
		if (events[index].seq !== events[index - 1].seq + 1) throw coordinatorStateError("invalid");
	}

	return events;
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

function filterCoordinatorEvents(
	events: CoordinatorEvent[],
	args: Record<string, unknown>,
	limit: number,
): CoordinatorEvent[] {
	const afterSeq =
		typeof args.after_seq === "number" ? args.after_seq : Number.parseInt(String(args.after_seq ?? "0"), 10);
	const safeAfterSeq = Number.isFinite(afterSeq) && afterSeq > 0 ? afterSeq : 0;
	const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
	const eventTypes = eventTypeFilter(args.event_types);
	return events
		.filter(event => event.seq > safeAfterSeq)
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
	return events.map(event => ({
		seq: event.seq,
		id: event.id,
		timestamp: event.timestamp,
		kind: event.kind,
		...(event.session_id ? { session_id: event.session_id } : {}),
		...(event.turn_id ? { turn_id: event.turn_id } : {}),
		...(event.question_id ? { question_id: event.question_id } : {}),
		...(event.report_id ? { report_id: event.report_id } : {}),
		summary: event.summary,
	}));
}

function safeExternalId(kind: "session" | "question", value: unknown): string {
	if (typeof value !== "string" || !SAFE_EXTERNAL_ID_PATTERN.test(value)) throw new Error(`invalid_${kind}_id`);
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

function safeTmuxRuntimeIdentity(value: string): boolean {
	return value.length > 0 && value.length <= 160 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function coordinatorCleanupPredicate(expectedPid: number, nativeSessionId: string, attemptSession: string): string {
	return `#{&&:#{==:#{pid},${expectedPid}},#{&&:#{==:#{session_id},${nativeSessionId}},#{==:#{session_name},${attemptSession}}}}`;
}

function parseTmuxNewSessionRecord(
	stdout: string,
	sessionName: string,
): { tmuxTarget: string; paneId: string; nativeSessionId: string } | undefined {
	const match = /^(\S+) (%\d+) (\$\d+)\n?$/.exec(stdout);
	if (!match) return undefined;
	const [tmuxTarget, paneId, nativeSessionId] = match.slice(1);
	const targetSuffix = tmuxTarget!.slice(`${sessionName}:`.length);
	if (
		!tmuxTarget!.startsWith(`${sessionName}:`) ||
		!/^\d+\.\d+$/.test(targetSuffix) ||
		!safeTmuxRuntimeIdentity(tmuxTarget!) ||
		!safeTmuxRuntimeIdentity(paneId!) ||
		!safeTmuxRuntimeIdentity(nativeSessionId!)
	)
		return undefined;
	return { tmuxTarget: tmuxTarget!, paneId: paneId!, nativeSessionId: nativeSessionId! };
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
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

function questionFile(namespaceDir: string, questionId: string): string {
	return path.join(namespaceDir, "questions", `${safeExternalId("question", questionId)}.json`);
}

function sessionStateFile(namespaceDir: string, sessionId: string): string {
	return path.join(namespaceDir, "session-states", `${safeExternalId("session", sessionId)}.json`);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidTurnRecord(value: unknown): value is TurnRecord {
	const turn = asRecord(value);
	const delivery = asRecord(turn?.delivery);
	const prompt = asRecord(turn?.prompt);
	const response = asRecord(turn?.final_response);
	const liveness = asRecord(turn?.liveness);
	const namespace = asRecord(turn?.namespace);
	const statuses: readonly TurnStatus[] = [
		"queued",
		"delivering",
		"active",
		"waiting_for_answer",
		"completing",
		"completed",
		"failed",
		"cancelled",
		"superseded",
	];
	if (
		turn?.schema_version !== 1 ||
		typeof turn.turn_id !== "string" ||
		!TURN_ID_PATTERN.test(turn.turn_id) ||
		typeof turn.session_id !== "string" ||
		!SAFE_EXTERNAL_ID_PATTERN.test(turn.session_id) ||
		!namespace ||
		(namespace.profile !== null && typeof namespace.profile !== "string") ||
		(namespace.repo !== null && typeof namespace.repo !== "string") ||
		!statuses.includes(turn.status as TurnStatus)
	)
		return false;
	if (
		!prompt ||
		typeof prompt.text !== "string" ||
		!isTimestamp(prompt.created_at) ||
		(prompt.source !== "mcp" && prompt.source !== "question_answer")
	)
		return false;
	if (
		!delivery ||
		typeof delivery.delivered !== "boolean" ||
		typeof delivery.queued !== "boolean" ||
		(delivery.target !== null && typeof delivery.target !== "string") ||
		(delivery.tmux_keys_sent !== undefined && typeof delivery.tmux_keys_sent !== "boolean") ||
		(delivery.prompt_acknowledged !== undefined && typeof delivery.prompt_acknowledged !== "boolean") ||
		(delivery.state !== undefined &&
			!["queued", "tmux_keys_sent", "acknowledged", "unavailable", "unacknowledged"].includes(
				delivery.state as string,
			)) ||
		!Array.isArray(delivery.attempts) ||
		!delivery.attempts.every(attempt => {
			const item = asRecord(attempt);
			return (
				item !== null &&
				typeof item.delivered === "boolean" &&
				isTimestamp(item.created_at) &&
				(item.reason === null || typeof item.reason === "string") &&
				(item.channel === undefined || item.channel === "tmux_keys" || item.channel === "runtime_ack") &&
				(item.tmux_keys_sent === undefined || typeof item.tmux_keys_sent === "boolean")
			);
		})
	)
		return false;
	if (
		!Array.isArray(turn.question_ids) ||
		!turn.question_ids.every(id => typeof id === "string" && SAFE_EXTERNAL_ID_PATTERN.test(id)) ||
		!isValidRuntimeFinalResponse(response) ||
		!Array.isArray(turn.evidence) ||
		!turn.evidence.every(item => asRecord(item) !== null) ||
		(turn.error !== null && !isValidRuntimeError(turn.error))
	)
		return false;
	if (
		!liveness ||
		(liveness.checked_at !== null && !isTimestamp(liveness.checked_at)) ||
		(liveness.live !== null && typeof liveness.live !== "boolean") ||
		(liveness.reason !== null && typeof liveness.reason !== "string") ||
		!isTimestamp(turn.created_at) ||
		!isTimestamp(turn.updated_at) ||
		(turn.started_at !== null && !isTimestamp(turn.started_at)) ||
		(turn.completed_at !== null && !isTimestamp(turn.completed_at))
	)
		return false;
	return TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus)
		? turn.completed_at !== null && (turn.status === "failed" ? turn.error !== null : turn.error === null)
		: turn.completed_at === null && turn.error === null;
}

function isValidActiveTurnRecord(
	value: unknown,
	sessionId: string,
): value is {
	session_id: string;
	turn_id: string;
	status: TurnStatus;
	updated_at: string;
} {
	const active = asRecord(value);
	return (
		active !== null &&
		Object.keys(active).every(key => ["session_id", "turn_id", "status", "updated_at"].includes(key)) &&
		active.session_id === sessionId &&
		typeof active.turn_id === "string" &&
		TURN_ID_PATTERN.test(active.turn_id) &&
		ACTIVE_TURN_STATUSES.has(active.status as TurnStatus) &&
		isTimestamp(active.updated_at)
	);
}

async function readTurnRecord(namespaceDir: string, turnId: unknown): Promise<TurnRecord | null> {
	const requestedTurnId = safeTurnId(turnId);
	const value = await readJsonFile(turnFile(namespaceDir, requestedTurnId));
	if (value === null) return null;
	if (!isValidTurnRecord(value) || value.turn_id !== requestedTurnId) throw coordinatorStateError("invalid");
	return value;
}

async function listTurnRecords(namespaceDir: string): Promise<TurnRecord[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(turnsDir(namespaceDir));
	} catch (error) {
		if (isExpectedStateAbsence(error)) return [];
		throw coordinatorStateError("unreadable");
	}
	const records = await Promise.all(
		entries
			.filter(entry => entry.endsWith(".json"))
			.map(async entry => {
				const turnId = entry.slice(0, -".json".length);
				if (!TURN_ID_PATTERN.test(turnId)) throw coordinatorStateError("invalid");
				return await readTurnRecord(namespaceDir, turnId);
			}),
	);
	return records.filter((record): record is TurnRecord => record !== null);
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
	if (!isValidTurnRecord(turn)) throw coordinatorStateError("invalid");
	const previous = await readTurnRecord(namespaceDir, turn.turn_id);
	await writeJsonFile(turnFile(namespaceDir, turn.turn_id), turn);
	const kind = previous?.status === turn.status ? null : turnEventKind(turn.status);
	if (kind) {
		await appendCoordinatorEvent(namespaceDir, {
			kind,
			sessionId: turn.session_id,
			turnId: turn.turn_id,
			summary: `Turn ${turn.turn_id} is ${turn.status}`,
			payloadRef: path.relative(namespaceDir, turnFile(namespaceDir, turn.turn_id)),
			metadata: {
				status: turn.status,
				queued: turn.delivery.queued,
				tmux_keys_sent: turn.delivery.tmux_keys_sent ?? null,
			},
		});
	}
}

async function readActiveTurn(namespaceDir: string, sessionId: string): Promise<TurnRecord | null> {
	const value = await readJsonFile(activeTurnFile(namespaceDir, sessionId));
	if (value === null) return null;
	if (!isValidActiveTurnRecord(value, sessionId)) throw coordinatorStateError("invalid");
	const turn = await readTurnRecord(namespaceDir, value.turn_id);
	if (!turn || turn.session_id !== sessionId || turn.status !== value.status || !ACTIVE_TURN_STATUSES.has(turn.status))
		throw coordinatorStateError("invalid");
	return turn;
}

async function writeActiveTurn(namespaceDir: string, turn: TurnRecord): Promise<void> {
	if (!ACTIVE_TURN_STATUSES.has(turn.status)) throw coordinatorStateError("invalid");
	await writeJsonFile(activeTurnFile(namespaceDir, turn.session_id), {
		session_id: turn.session_id,
		turn_id: turn.turn_id,
		status: turn.status,
		updated_at: turn.updated_at,
	});
}

async function clearActiveTurn(namespaceDir: string, turn: TurnRecord): Promise<void> {
	const value = await readJsonFile(activeTurnFile(namespaceDir, turn.session_id));
	if (value === null) return;
	if (!isValidActiveTurnRecord(value, turn.session_id)) throw coordinatorStateError("invalid");
	if (value.turn_id === turn.turn_id) await fs.rm(activeTurnFile(namespaceDir, turn.session_id), { force: true });
}

async function readSessionState(namespaceDir: string, sessionId: string): Promise<CoordinatorSessionState | null> {
	const value = await readJsonFile(sessionStateFile(namespaceDir, sessionId));
	if (value === null) return null;
	if (!isValidRuntimeSessionState(value, sessionId)) throw coordinatorStateError("invalid");
	return value;
}

function validRuntimeOwnerGeneration(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value)
	);
}

function runtimeStateMatchesPrivateOwnerGeneration(
	sessionState: CoordinatorSessionState,
	session: Record<string, unknown> | null,
): boolean {
	const expectedGeneration = session?.tmux_owner_generation ?? session?.tmuxOwnerGeneration;
	if (expectedGeneration === undefined)
		return !(sessionState.source === "process_postmortem" && sessionState.event === "owner_terminal");
	if (!validRuntimeOwnerGeneration(expectedGeneration) || sessionState.owner_generation !== expectedGeneration)
		return false;
	if (sessionState.source !== "process_postmortem") return true;
	if (sessionState.event !== "owner_terminal") return false;
	const expectedSocketKey = session?.tmux_owner_server_key ?? session?.tmuxOwnerServerKey;
	return (
		typeof expectedSocketKey === "string" &&
		sessionState.owner_terminal?.generation === expectedGeneration &&
		sessionState.owner_terminal.socket_key === expectedSocketKey
	);
}

async function reconcileTerminalRuntimeEvidence(namespaceDir: string, sessionId: string): Promise<boolean> {
	const sessionState = await readSessionState(namespaceDir, sessionId);
	if (
		!sessionState ||
		sessionState.source === "coordinator" ||
		(sessionState.state !== "completed" && sessionState.state !== "errored")
	)
		return false;
	const session = asRecord(await readJsonFile(path.join(namespaceDir, "sessions", `${sessionId}.json`)));
	if (!runtimeStateMatchesPrivateOwnerGeneration(sessionState, session)) return false;

	const activeTurn = await readActiveTurn(namespaceDir, sessionId);
	if (activeTurn && (sessionState.current_turn_id === null || sessionState.current_turn_id === activeTurn.turn_id)) {
		await markTurnTerminalFromSessionState(namespaceDir, activeTurn, sessionState);
	}
	return true;
}

async function preflightCoordinatorMutation(
	namespaceDir: string,
	sessionId?: string,
	options: { rejectTerminalRuntimeEvidence?: boolean } = {},
): Promise<void> {
	await readLatestEventSeq(namespaceDir);
	if (!sessionId) return;
	const [sessionState, session] = await Promise.all([
		readSessionState(namespaceDir, sessionId),
		readJsonFile(path.join(namespaceDir, "sessions", `${sessionId}.json`)),
	]);
	const sessionRecord = asRecord(session);
	if (sessionRecord && normalizeSession(sessionRecord).session_id !== sessionId)
		throw coordinatorStateError("invalid");
	if (sessionState && sessionState.session_id !== sessionId) throw coordinatorStateError("invalid");
	await readActiveTurn(namespaceDir, sessionId);
	const terminalRuntimeEvidence = await reconcileTerminalRuntimeEvidence(namespaceDir, sessionId);
	if (terminalRuntimeEvidence && options.rejectTerminalRuntimeEvidence !== false)
		throw coordinatorStateError("invalid");
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
	} = {},
): Promise<CoordinatorSessionState> {
	const previous = await readSessionState(namespaceDir, sessionId);
	if (previous && previous.source !== "coordinator") return previous;
	const session = asRecord(await readJsonFile(path.join(namespaceDir, "sessions", `${sessionId}.json`)));
	const previousCwd = typeof previous?.cwd === "string" && previous.cwd.trim() ? previous.cwd : null;
	const cwd =
		typeof session?.cwd === "string" && session.cwd.trim()
			? path.resolve(session.cwd)
			: previousCwd
				? path.resolve(previousCwd)
				: null;
	if (!cwd) throw coordinatorStateError("invalid");
	const sessionFile =
		typeof session?.session_file === "string" && session.session_file.trim()
			? path.resolve(session.session_file)
			: null;
	const payload: CoordinatorSessionState = {
		schema_version: 1,
		session_id: sessionId,
		state,
		ready_for_input: state === "ready_for_input" || state === "completed",
		current_turn_id: options.currentTurnId ?? (state === "running" ? (previous?.current_turn_id ?? null) : null),
		last_turn_id: options.lastTurnId ?? previous?.last_turn_id ?? null,
		updated_at: new Date().toISOString(),
		source: options.source ?? "coordinator",
		live: options.live ?? previous?.live ?? null,
		reason: options.reason ?? null,
		cwd,
		workdir: cwd,
		session_file: sessionFile,
	};
	await writeJsonFile(sessionStateFile(namespaceDir, sessionId), payload);
	if (
		!previous ||
		previous.state !== payload.state ||
		previous.current_turn_id !== payload.current_turn_id ||
		previous.last_turn_id !== payload.last_turn_id ||
		previous.live !== payload.live ||
		previous.reason !== payload.reason
	) {
		await appendCoordinatorEvent(namespaceDir, {
			kind: "session.state_changed",
			sessionId,
			turnId: payload.current_turn_id ?? payload.last_turn_id,
			summary: `Session ${sessionId} state changed to ${payload.state}`,
			payloadRef: path.relative(namespaceDir, sessionStateFile(namespaceDir, sessionId)),
			metadata: {
				state: payload.state,
				ready_for_input: payload.ready_for_input,
				live: payload.live,
				reason: payload.reason,
			},
		});
	}
	return payload;
}

interface SessionStateLockOwner {
	pid: number;
	start_time: string;
	token: string;
}

function processStartTime(pid: number): string | null {
	try {
		const stat = nodeFs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat
			.slice(close + 1)
			.trim()
			.split(/\s+/);
		return fields[19] ?? null;
	} catch {
		return null;
	}
}

function validLockOwner(value: unknown): value is SessionStateLockOwner {
	if (!value || typeof value !== "object") return false;
	const owner = value as Partial<SessionStateLockOwner>;
	return (
		typeof owner.pid === "number" &&
		Number.isSafeInteger(owner.pid) &&
		owner.pid > 0 &&
		typeof owner.start_time === "string" &&
		typeof owner.token === "string" &&
		owner.token.length > 0
	);
}

function lockOwnerIsAlive(value: unknown): boolean {
	if (!validLockOwner(value)) return false;
	const owner = value;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		return true;
	}
	const currentStartTime = processStartTime(owner.pid);
	return currentStartTime === null || currentStartTime === owner.start_time;
}

async function reclaimStaleSessionStateLock(lockFile: string): Promise<void> {
	let raw: string;
	try {
		raw = await fs.readFile(lockFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let owner: unknown;
	try {
		owner = JSON.parse(raw);
	} catch {
		owner = null;
	}
	if (!validLockOwner(owner)) {
		const stat = await fs.stat(lockFile);
		if (Date.now() - stat.mtimeMs < 30_000) return;
	} else if (lockOwnerIsAlive(owner)) return;
	try {
		if ((await fs.readFile(lockFile, "utf8")) === raw) await fs.rm(lockFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function withSessionStateLock<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
	const lockFile = `${stateFile}.lock`;
	const owner: SessionStateLockOwner = {
		pid: process.pid,
		start_time: processStartTime(process.pid) ?? "unknown",
		token: randomUUID(),
	};
	await ensureDir(path.dirname(stateFile));
	for (let attempt = 0; attempt < 12_000; attempt++) {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(lockFile, "wx");
			try {
				await handle.writeFile(JSON.stringify(owner));
			} catch (error) {
				await handle.close().catch(() => undefined);
				handle = undefined;
				await fs.rm(lockFile, { force: true }).catch(() => undefined);
				throw error;
			}
			const outcome = await operation().then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
			await handle.close();
			try {
				if ((await fs.readFile(lockFile, "utf8")) === JSON.stringify(owner)) await fs.rm(lockFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		} catch (error) {
			if (handle) throw error;
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw coordinatorStateError("unreadable");
			await reclaimStaleSessionStateLock(lockFile);
			await Bun.sleep(5);
		}
	}
	throw coordinatorStateError("unreadable");
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
	} = {},
): Promise<CoordinatorSessionState> {
	const file = sessionStateFile(namespaceDir, sessionId);
	return await withSessionStateLock(
		file,
		async () => await writeSessionStateUnlocked(namespaceDir, sessionId, state, options),
	);
}

function hasTmuxIdentity(session: Record<string, unknown>): boolean {
	return (
		(typeof session.tmux_session === "string" && session.tmux_session.length > 0) ||
		(typeof session.tmuxSession === "string" && session.tmuxSession.length > 0)
	);
}

function unavailableSessionReason(turn: TurnRecord, reason: string): string {
	if (
		reason === "tmux_session_missing" &&
		turn.delivery.tmux_keys_sent === true &&
		turn.delivery.prompt_acknowledged === true
	) {
		return "tmux_session_missing_after_prompt_acknowledgement";
	}
	return reason;
}

function unavailableSessionEvidence(turn: TurnRecord, reason: string, timestamp: string): Record<string, unknown>[] {
	if (reason !== "tmux_session_missing_after_prompt_acknowledgement") return turn.evidence;
	return [
		...turn.evidence,
		{
			type: reason,
			message:
				"The tmux session disappeared after GJC runtime acknowledged the prompt, before any terminal final_response or error was recorded. Treat this as an in-flight vanished session and inspect/restart with recovery evidence rather than resubmitting blindly.",
			tmux_keys_sent: true,
			prompt_acknowledged: true,
			prior_status: turn.status,
			created_at: timestamp,
		},
	];
}

async function markTurnFailedForUnavailableSession(
	namespaceDir: string,
	turn: TurnRecord,
	reason: string,
): Promise<TurnRecord> {
	const timestamp = new Date().toISOString();
	const durableReason = unavailableSessionReason(turn, reason);
	const failed: TurnRecord = {
		...turn,
		status: "failed",
		final_response: {
			text: `Coordinator session unavailable: ${durableReason}`,
			format: "markdown",
			source: "coordinator_liveness",
			artifact_path: null,
			truncated: false,
		},
		evidence: unavailableSessionEvidence(turn, durableReason, timestamp),
		error: {
			code: "session_unavailable",
			message: durableReason,
			recoverable: true,
		},
		liveness: { checked_at: timestamp, live: false, reason: durableReason },
		updated_at: timestamp,
		completed_at: timestamp,
	};
	await writeTurnRecord(namespaceDir, failed);
	await clearActiveTurn(namespaceDir, failed);
	await writeSessionState(namespaceDir, failed.session_id, "stale", {
		lastTurnId: failed.turn_id,
		live: false,
		reason: durableReason,
	});
	return failed;
}

async function markTurnTerminalFromSessionState(
	namespaceDir: string,
	turn: TurnRecord,
	sessionState: CoordinatorSessionState,
): Promise<TurnRecord> {
	const terminalStatus: TurnStatus = sessionState.state === "errored" ? "failed" : "completed";
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
		evidence: reportableFinalResponse(finalResponse)
			? turn.evidence
			: [
					...turn.evidence,
					{
						type: MISSING_FINAL_RESPONSE_ADVISORY,
						message: "Runtime completed without reportable final_response text or artifact_path.",
						created_at: timestamp,
					},
				],
		error:
			terminalStatus === "failed"
				? (runtimeState.error ?? {
						code: "runtime_errored",
						message: sessionState.reason ?? "runtime_errored",
						recoverable: true,
					})
				: null,
		updated_at: timestamp,
		completed_at: timestamp,
	};
	await writeTurnRecord(namespaceDir, resolved);
	await clearActiveTurn(namespaceDir, resolved);
	await writeSessionState(namespaceDir, resolved.session_id, sessionState.state, {
		lastTurnId: resolved.turn_id,
		live: sessionState.live,
		reason: sessionState.reason,
	});
	return resolved;
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
	await appendCoordinatorEvent(namespaceDir, {
		kind: "turn.acknowledged",
		sessionId: acknowledged.session_id,
		turnId: acknowledged.turn_id,
		summary: `Turn ${acknowledged.turn_id} was acknowledged by the GJC runtime`,
		payloadRef: path.relative(namespaceDir, turnFile(namespaceDir, acknowledged.turn_id)),
		metadata: {
			status: acknowledged.status,
			tmux_keys_sent: acknowledged.delivery.tmux_keys_sent ?? null,
			prompt_acknowledged: true,
		},
	});
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

async function markTurnFailedForUnacknowledgedDelivery(
	namespaceDir: string,
	turn: TurnRecord,
	ackTimeoutMs: number,
): Promise<TurnRecord> {
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
		liveness: {
			checked_at: timestamp,
			live: turn.liveness.live,
			reason: PROMPT_ACK_TIMEOUT_REASON,
		},
		updated_at: timestamp,
		completed_at: timestamp,
	};
	await writeTurnRecord(namespaceDir, failed);
	await clearActiveTurn(namespaceDir, failed);
	await writeSessionState(namespaceDir, failed.session_id, "stale", {
		lastTurnId: failed.turn_id,
		live: failed.liveness.live,
		reason: PROMPT_ACK_TIMEOUT_REASON,
	});
	return failed;
}

async function reconcileRuntimeAcknowledgement(
	namespaceDir: string,
	turn: TurnRecord,
	sessionState: CoordinatorSessionState | null,
	ackTimeoutMs: number,
	options: { failOnTimeout: boolean } = { failOnTimeout: true },
): Promise<TurnRecord> {
	const session = asRecord(await readJsonFile(path.join(namespaceDir, "sessions", `${turn.session_id}.json`)));
	if (
		sessionState &&
		runtimeStateMatchesPrivateOwnerGeneration(sessionState, session) &&
		sessionState.source !== "coordinator" &&
		(sessionState.state === "completed" || sessionState.state === "errored") &&
		(sessionState.current_turn_id === null || sessionState.current_turn_id === turn.turn_id)
	) {
		return await markTurnTerminalFromSessionState(namespaceDir, turn, sessionState);
	}
	if (sessionState && runtimeStateAcknowledgesTurn(turn, sessionState)) {
		return await markTurnAcknowledgedFromRuntimeState(namespaceDir, turn, sessionState);
	}
	if (options.failOnTimeout && turnAwaitingRuntimeAckExpired(turn, Date.now(), ackTimeoutMs)) {
		return await markTurnFailedForUnacknowledgedDelivery(namespaceDir, turn, ackTimeoutMs);
	}
	return turn;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
		final_response: {
			text: null,
			format: "markdown",
			source: null,
			artifact_path: null,
			truncated: false,
		},
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
	return Math.min(parsePositiveIntegerMs(value, 1000), COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS);
}

export function boundedPollIntervalMs(value: unknown): number {
	return Math.min(Math.max(parsePositiveIntegerMs(value, 100), 10), COORDINATOR_POLL_INTERVAL_MAX_MS);
}
async function runCommand(
	command: string[],
	stdinLine?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		stdin: stdinLine === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdinLine !== undefined) {
		const stdin = proc.stdin;
		if (!stdin) throw new Error("coordinator_command_stdin_unavailable");
		stdin.write(`${stdinLine}\n`);
		stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function sendTmuxPromptKeys(
	target: string,
	prompt: string,
	runner: CommandRunner,
	socketKey: string,
	proveCurrentServer: () => Promise<boolean>,
): Promise<boolean> {
	const runMutation = async (argv: string[]): Promise<CommandResult | null> => {
		if (!(await proveCurrentServer())) return null;
		return await runner(argv);
	};
	const bufferName = `gjc-coordinator-prompt-${randomUUID()}`;
	const tmux = ["tmux", "-L", socketKey];
	const zeroize = async (): Promise<boolean> => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const cleared = await runMutation([...tmux, "set-buffer", "-b", bufferName, "--", ""]);
			const deleted =
				cleared?.exitCode === 0 ? await runMutation([...tmux, "delete-buffer", "-b", bufferName]) : null;
			if (cleared?.exitCode === 0 && deleted?.exitCode === 0) return true;
		}
		return false;
	};
	const buffered = await runMutation([...tmux, "set-buffer", "-b", bufferName, "--", prompt]);
	if (buffered?.exitCode !== 0) return false;
	const pasted = await runMutation([...tmux, "paste-buffer", "-d", "-b", bufferName, "-t", target]);
	if (pasted?.exitCode !== 0) {
		if (!(await zeroize())) throw new Error("coordinator_prompt_buffer_privacy_unverified");
		return false;
	}
	const dismissedAutocomplete = await runMutation([...tmux, "send-keys", "-t", target, "Escape"]);
	if (dismissedAutocomplete?.exitCode !== 0) return false;
	const submitted = await runMutation([...tmux, "send-keys", "-t", target, "Enter"]);
	return submitted?.exitCode === 0;
}

function boundedLineCount(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 80;
	return Math.min(parsed, 400);
}

async function assertTmuxTargetAvailable(
	tmuxSession: string,
	tmuxTarget: string,
	runner: CommandRunner = runCommand,
): Promise<void> {
	const session = await runner(["tmux", "has-session", "-t", tmuxSession]);
	if (session.exitCode !== 0) throw new Error("tmux_session_unavailable");
	const pane = await runner(["tmux", "display-message", "-p", "-t", tmuxTarget, "#{pane_id}"]);
	if (pane.exitCode !== 0 || pane.stdout.trim().length === 0) throw new Error("tmux_target_unavailable");
}

async function registerExistingTmuxSession(
	input: SessionRegisterInput,
	namespaceDir: string,
	sessionFilePath: string,
	runner: CommandRunner = runCommand,
): Promise<{
	session: Record<string, unknown>;
	sessionState: CoordinatorSessionState;
}> {
	await assertTmuxTargetAvailable(input.tmuxSession, input.tmuxTarget, runner);
	const existing = asRecord(await readJsonFile(sessionFilePath));
	if (existing) {
		const existingSession = typeof existing.tmux_session === "string" ? existing.tmux_session : existing.tmuxSession;
		const existingTarget = typeof existing.tmux_target === "string" ? existing.tmux_target : existing.tmuxTarget;
		if (existingSession && existingSession !== input.tmuxSession) throw new Error("session_id_conflict");
		if (existingTarget && existingTarget !== input.tmuxTarget) throw new Error("session_id_conflict");
	}
	const timestamp = new Date().toISOString();
	const session = {
		...(existing ?? {}),
		session_id: input.sessionId,
		sessionId: input.sessionId,
		tmux_session: input.tmuxSession,
		tmuxSession: input.tmuxSession,
		tmux_target: input.tmuxTarget,
		tmuxTarget: input.tmuxTarget,
		cwd: input.cwd,
		created_at: typeof existing?.created_at === "string" ? existing.created_at : timestamp,
		createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : timestamp,
		registered_at: timestamp,
		visible: input.visible,
		authoritative: true,
		warp_attached: input.warpAttached,
		source: input.source,
		model: input.model,
	};
	await writeJsonFile(sessionFilePath, session);
	const state = await writeSessionState(namespaceDir, input.sessionId, "ready_for_input", {
		live: true,
		reason: null,
	});
	return { session, sessionState: state };
}

async function portableProcessStartTime(pid: number, runner: CommandRunner): Promise<string | null> {
	const result = await runner(["ps", "-o", "lstart=", "-p", String(pid)]);
	const startTime = result.stdout.trim();
	return result.exitCode === 0 &&
		startTime.length > 0 &&
		startTime.length <= 160 &&
		!/[\r\n\u0000-\u001f\u007f]/.test(startTime)
		? startTime
		: null;
}

export async function coordinatorOwnerIsolationProbe(runner: CommandRunner): Promise<OwnerIsolationProbe> {
	return {
		readCallerCgroup: async () => await fs.readFile("/proc/self/cgroup", "utf8").catch(() => null),
		probeServer: async (socketKey): Promise<TmuxServerProof> => {
			try {
				const result = await runner(["tmux", "-L", socketKey, "list-sessions", "-F", "#{pid} #{session_name}"]);
				if (result.exitCode !== 0) {
					const diagnostic = `${result.stdout}\n${result.stderr}`.slice(0, 512);
					return /(?:no server running|failed to connect to server|no sessions|error connecting to)/i.test(
						diagnostic,
					)
						? { state: "absent" }
						: { state: "unverifiable" };
				}
				const rows = result.stdout
					.split("\n")
					.map(line => line.trim().split(/\s+/, 2))
					.filter(([pid, name]) => Boolean(pid && name));
				const pid = Number(rows[0]?.[0]);
				const sessionNames = rows.map(([, name]) => name as string);
				if (!Number.isSafeInteger(pid) || pid <= 0 || rows.some(([rowPid]) => Number(rowPid) !== pid))
					return { state: "unverifiable" };
				const stat =
					process.platform === "linux" ? await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null) : null;
				const startTime =
					process.platform === "linux"
						? ownerProcessStartTime(process.platform, stat)
						: await portableProcessStartTime(pid, runner);
				if (!startTime) return { state: "unverifiable", pid, sessionNames };
				if (process.platform !== "linux")
					return {
						state: "safe",
						pid,
						startTime,
						sessionNames,
						cgroup: { classification: "not_applicable" },
					};
				const cgroupText = await fs.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => null);
				const cgroup = classifyCgroup({ platform: process.platform, cgroupText });
				return {
					state:
						cgroup.classification === "safe"
							? "safe"
							: cgroup.classification === "unsafe_service"
								? "unsafe"
								: "unverifiable",
					pid,
					startTime,
					sessionNames,
					cgroup,
				};
			} catch {
				// A transient spawn failure (e.g. EAGAIN under load, or a momentary tmux/ps hiccup)
				// must not fatally abort the owner-server proof. Surfacing it as an unverifiable state
				// lets proveCoordinatorOwnerServer's bounded retry loop re-probe once the transient
				// clears, instead of propagating the throw and failing the entire delegate outright.
				return { state: "unverifiable" };
			}
		},
	};
}

async function proveCoordinatorOwnerServer(probe: OwnerIsolationProbe, socketKey: string): Promise<TmuxServerProof> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const proof = await probe.probeServer(socketKey);
		if (proof.state === "unsafe" || (proof.state === "safe" && proof.pid && proof.startTime)) return proof;
		if (attempt < 49) await Bun.sleep(10);
	}
	return { state: "unverifiable" };
}

async function startTmuxSession(
	config: CoordinatorMcpConfig,
	input: SessionStartInput,
	namespaceDir: string,
	runner: CommandRunner = runCommand,
	ownerIsolationProbe?: OwnerIsolationProbe,
): Promise<Record<string, unknown>> {
	if (!config.sessionCommand) throw new Error("coordinator_session_command_required");
	const sessionName = `gjc-coordinator-${randomUUID().slice(0, 8)}`;
	const socketKey = `gjc-coordinator-${randomUUID().slice(0, 8)}`;
	const ownerStateDir = namespaceDir;
	const ownerGeneration = randomUUID();
	const generationBaseline = captureOwnerGenerationBaselineSync(ownerStateDir, sessionName);
	const runtimeStateFile = sessionStateFile(namespaceDir, sessionName);
	const sessionCommand = [
		"exec env",
		`${GJC_COORDINATOR_SESSION_STATE_FILE_ENV}=${shellQuote(runtimeStateFile)}`,
		`${GJC_COORDINATOR_SESSION_ID_ENV}=${shellQuote(sessionName)}`,
		`${GJC_TMUX_OWNER_GENERATION_ENV}=${shellQuote(ownerGeneration)}`,
		`${GJC_TMUX_OWNER_STATE_DIR_ENV}=${shellQuote(ownerStateDir)}`,
		`${GJC_TMUX_OWNER_SERVER_KEY_ENV}=${shellQuote(socketKey)}`,
		config.sessionCommand,
	].join(" ");
	const tmuxArgv = [
		"tmux",
		"-L",
		socketKey,
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{session_id}",
		"-s",
		sessionName,
		"-c",
		input.cwd,
		sessionCommand,
	];
	const probe = ownerIsolationProbe ?? (await coordinatorOwnerIsolationProbe(runner));
	let plan = await planTmuxOwnerIsolation(
		{
			schema_version: 1,
			op: "plan",
			platform: process.platform,
			session_id: sessionName,
			owner_generation: ownerGeneration,
			baseline: generationBaseline,
			cwd: input.cwd,
			state_dir: ownerStateDir,
			socket_key: socketKey,
			tmux_argv: tmuxArgv,
		},
		probe,
	);
	if (!plan.ok) throw new Error(`coordinator_tmux_owner_${plan.code}`);
	if (plan.execution.mode === "direct" && plan.execution.server_absent_before) {
		plan = await planTmuxOwnerIsolation(
			{
				schema_version: 1,
				op: "plan",
				platform: process.platform,
				session_id: sessionName,
				owner_generation: ownerGeneration,
				baseline: generationBaseline,
				cwd: input.cwd,
				state_dir: ownerStateDir,
				socket_key: socketKey,
				tmux_argv: tmuxArgv,
			},
			{
				...probe,
				readCallerCgroup: async () => "0::/gjc-coordinator-bootstrap.service",
			},
		);
		if (!plan.ok) throw new Error(`coordinator_tmux_owner_${plan.code}`);
	}
	const preSpawnProof =
		plan.execution.mode === "direct" && plan.server_state === "safe"
			? await proveCoordinatorOwnerServer(probe, socketKey)
			: null;
	if (
		preSpawnProof &&
		(preSpawnProof.state !== "safe" ||
			!preSpawnProof.pid ||
			!preSpawnProof.startTime ||
			(process.platform === "linux" && preSpawnProof.cgroup?.classification !== "safe"))
	)
		throw new Error("coordinator_tmux_owner_server_unverifiable");
	const started = await runner(
		plan.execution.argv,
		plan.execution.mode === "scoped" ? plan.execution.stdin_line : undefined,
	);

	const rawScopedReceipt =
		plan.execution.mode === "scoped" && isExactScopedBootstrapSuccessReceipt(started.stdout)
			? (JSON.parse(started.stdout.trim()) as {
					native_session_id: string;
					server_pid: number;
					server_start_time: string;
					session_name: string;
				})
			: undefined;
	const scopedReceipt =
		rawScopedReceipt?.session_name === plan.execution.attempt_session ? rawScopedReceipt : undefined;
	const directReceipt =
		plan.execution.mode === "direct"
			? parseTmuxNewSessionRecord(started.stdout, plan.execution.attempt_session)
			: undefined;
	const directNativeSessionId = directReceipt?.nativeSessionId;
	const spawnedNativeSessionId = scopedReceipt?.native_session_id ?? directNativeSessionId;
	let expectedServer = scopedReceipt
		? {
				pid: scopedReceipt.server_pid,
				startTime: scopedReceipt.server_start_time,
			}
		: preSpawnProof && preSpawnProof.state === "safe" && preSpawnProof.pid && preSpawnProof.startTime
			? { pid: preSpawnProof.pid, startTime: preSpawnProof.startTime }
			: undefined;
	const cleanupFailedAttempt = async (): Promise<"cleaned" | "failed" | "unverifiable"> => {
		if (!spawnedNativeSessionId || !expectedServer) return "unverifiable";
		try {
			const result = await runner([
				"tmux",
				"-L",
				socketKey,
				"if-shell",
				"-t",
				spawnedNativeSessionId,
				"-F",
				coordinatorCleanupPredicate(expectedServer.pid, spawnedNativeSessionId, plan.execution.attempt_session),
				`kill-session -t '${spawnedNativeSessionId}' ; display-message -p __gjc_coordinator_cleanup_ok__`,
				"display-message -p __gjc_coordinator_cleanup_refused__",
			]);
			if (result.exitCode !== 0) return "failed";
			return result.stdout.trim() === "__gjc_coordinator_cleanup_ok__" ? "cleaned" : "unverifiable";
		} catch {
			return "unverifiable";
		}
	};
	const failAfterCleanup = async (reason: string): Promise<never> => {
		throw new CoordinatorStartError(reason, await cleanupFailedAttempt());
	};
	if (started.exitCode !== 0) return await failAfterCleanup("coordinator_tmux_start_failed");
	const bootstrapReceiptValid = plan.execution.mode !== "scoped" || scopedReceipt !== undefined;
	const initialProof = await proveCoordinatorOwnerServer(probe, socketKey).catch(error =>
		failAfterCleanup(error instanceof Error ? error.message : "coordinator_tmux_owner_server_unverifiable"),
	);
	if (
		initialProof.state !== "safe" ||
		!initialProof.pid ||
		!initialProof.startTime ||
		(process.platform === "linux" && initialProof.cgroup?.classification !== "safe")
	) {
		return await failAfterCleanup("coordinator_tmux_owner_server_unverifiable");
	}
	if (
		scopedReceipt &&
		(initialProof.pid !== scopedReceipt.server_pid || initialProof.startTime !== scopedReceipt.server_start_time)
	) {
		return await failAfterCleanup("coordinator_tmux_owner_server_race");
	}
	if (
		preSpawnProof &&
		(initialProof.pid !== preSpawnProof.pid || initialProof.startTime !== preSpawnProof.startTime)
	) {
		return await failAfterCleanup("coordinator_tmux_owner_server_race");
	}
	if (!expectedServer)
		expectedServer = {
			pid: initialProof.pid,
			startTime: initialProof.startTime,
		};
	if (!bootstrapReceiptValid) {
		return await failAfterCleanup("coordinator_tmux_start_failed");
	}

	const startRecord = await (async () => {
		const queried = await runner([
			"tmux",
			"-L",
			socketKey,
			"display-message",
			"-p",
			"-t",
			sessionName,
			"#{session_name}:#{window_index}.#{pane_index} #{pane_id} #{session_id}",
		]);
		if (queried.exitCode !== 0) throw new Error("coordinator_tmux_start_failed");
		return queried.stdout.trim();
	})().catch(error => failAfterCleanup(error instanceof Error ? error.message : "coordinator_tmux_start_failed"));
	const postLaunchProof = await probe.probeServer(socketKey);
	if (
		postLaunchProof.state !== "safe" ||
		postLaunchProof.pid !== initialProof.pid ||
		postLaunchProof.startTime !== initialProof.startTime
	) {
		return await failAfterCleanup("coordinator_tmux_owner_server_race");
	}
	const parsedStartRecord = parseTmuxNewSessionRecord(startRecord, plan.execution.attempt_session);
	if (!parsedStartRecord) {
		return await failAfterCleanup("coordinator_tmux_start_failed");
	}
	const { tmuxTarget, paneId, nativeSessionId } = parsedStartRecord;
	if (
		(scopedReceipt && nativeSessionId !== scopedReceipt.native_session_id) ||
		(plan.execution.mode === "direct" && nativeSessionId !== directNativeSessionId)
	) {
		return await failAfterCleanup("coordinator_tmux_owner_server_race");
	}
	const ownerTransaction = {
		commit: () => replaceOwnerGenerationSync(ownerStateDir, sessionName, ownerGeneration, generationBaseline),
		rollback: cleanupFailedAttempt,
	};
	return {
		sessionId: sessionName,
		tmuxSession: sessionName,
		tmuxTarget,
		paneId,
		tmuxNativeSessionId: nativeSessionId,
		tmuxSocketKey: socketKey,
		tmuxOwnerGeneration: ownerGeneration,
		tmuxOwnerStateDir: ownerStateDir,
		tmuxOwnerServerKey: socketKey,
		tmuxOwnerServerPid: initialProof.pid,
		tmuxOwnerServerStartTime: initialProof.startTime,

		cwd: input.cwd,
		createdAt: new Date().toISOString(),
		sessionCommand: config.sessionCommand,
		runtimeStateFile,
		__coordinatorOwnerTransaction: ownerTransaction,
	};
}

function hasPrivateTmuxOwnerIdentity(session: Record<string, unknown>): boolean {
	const socketKey = typeof session.tmux_socket_key === "string" ? session.tmux_socket_key : session.tmuxSocketKey;
	const serverKey =
		typeof session.tmux_owner_server_key === "string" ? session.tmux_owner_server_key : session.tmuxOwnerServerKey;
	const pid = session.tmux_owner_server_pid ?? session.tmuxOwnerServerPid;
	const startTime = session.tmux_owner_server_start_time ?? session.tmuxOwnerServerStartTime;
	const nativeSessionId = session.tmux_native_session_id ?? session.tmuxNativeSessionId;
	const paneId = session.pane_id ?? session.paneId;
	return (
		typeof socketKey === "string" &&
		socketKey.length > 0 &&
		socketKey === serverKey &&
		Number.isSafeInteger(pid) &&
		typeof startTime === "string" &&
		startTime.length > 0 &&
		typeof nativeSessionId === "string" &&
		nativeSessionId.length > 0 &&
		typeof paneId === "string" &&
		paneId.length > 0
	);
}

async function proveImmutableTmuxTarget(session: Record<string, unknown>, runner: CommandRunner): Promise<boolean> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	const socketKey = typeof session.tmux_socket_key === "string" ? session.tmux_socket_key : session.tmuxSocketKey;
	const expectedSessionId = session.tmux_native_session_id ?? session.tmuxNativeSessionId;
	const expectedPaneId = session.pane_id ?? session.paneId;
	if (
		typeof target !== "string" ||
		typeof socketKey !== "string" ||
		typeof expectedSessionId !== "string" ||
		typeof expectedPaneId !== "string"
	)
		return false;
	const identity = await runner([
		"tmux",
		"-L",
		socketKey,
		"display-message",
		"-p",
		"-t",
		target,
		"#{session_id} #{pane_id}",
	]);
	const parts = identity.stdout.trim().split(/\s+/);
	if (identity.exitCode !== 0) return false;
	return parts.length === 2 && parts[0] === expectedSessionId && parts[1] === expectedPaneId;
}
async function captureTmuxTail(
	session: Record<string, unknown>,
	lines: number,
	runner: CommandRunner = runCommand,
): Promise<string[]> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	const socketKey = typeof session.tmux_socket_key === "string" ? session.tmux_socket_key : session.tmuxSocketKey;
	if (
		!hasPrivateTmuxOwnerIdentity(session) ||
		typeof socketKey !== "string" ||
		socketKey.length === 0 ||
		typeof target !== "string" ||
		target.length === 0
	)
		return [];
	const pid = session.tmux_owner_server_pid ?? session.tmuxOwnerServerPid;
	const startTime = session.tmux_owner_server_start_time ?? session.tmuxOwnerServerStartTime;
	const probe = await coordinatorOwnerIsolationProbe(runner);
	const proof = await probe.probeServer(socketKey);
	if (
		proof.state !== "safe" ||
		proof.pid !== pid ||
		proof.startTime !== startTime ||
		(process.platform === "linux" && proof.cgroup?.classification !== "safe") ||
		!(await proveImmutableTmuxTarget(session, runner))
	)
		return [];
	const captured = await runner(["tmux", "-L", socketKey, "capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
	if (captured.exitCode !== 0) return [];
	return captured.stdout.split("\n").slice(-lines);
}

async function sendTmuxPrompt(
	session: Record<string, unknown>,
	prompt: string,
	runner: CommandRunner = runCommand,
	ownerIsolationProbe?: OwnerIsolationProbe,
): Promise<boolean> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	const socketKey = typeof session.tmux_socket_key === "string" ? session.tmux_socket_key : session.tmuxSocketKey;
	const serverKey =
		typeof session.tmux_owner_server_key === "string" ? session.tmux_owner_server_key : session.tmuxOwnerServerKey;
	const pid = session.tmux_owner_server_pid ?? session.tmuxOwnerServerPid;
	const startTime = session.tmux_owner_server_start_time ?? session.tmuxOwnerServerStartTime;
	if (
		typeof target !== "string" ||
		target.length === 0 ||
		typeof socketKey !== "string" ||
		socketKey.length === 0 ||
		socketKey !== serverKey ||
		!Number.isSafeInteger(pid) ||
		typeof startTime !== "string" ||
		startTime.length === 0
	)
		return false;
	const paneId = session.pane_id ?? session.paneId;
	if (typeof paneId !== "string" || !(await proveImmutableTmuxTarget(session, runner))) return false;
	const probe = ownerIsolationProbe ?? (await coordinatorOwnerIsolationProbe(runner));
	const proveCurrentServer = async (): Promise<boolean> => {
		const proof = await probe.probeServer(socketKey);
		return (
			proof.state === "safe" &&
			proof.pid === pid &&
			proof.startTime === startTime &&
			(process.platform !== "linux" || proof.cgroup?.classification === "safe")
		);
	};
	return await sendTmuxPromptKeys(paneId, prompt, runner, socketKey, proveCurrentServer);
}

async function hasTmuxSession(
	session: Record<string, unknown>,
	runner: CommandRunner = runCommand,
): Promise<boolean | null> {
	const tmuxSession = typeof session.tmux_session === "string" ? session.tmux_session : session.tmuxSession;
	const socketKey = typeof session.tmux_socket_key === "string" ? session.tmux_socket_key : session.tmuxSocketKey;
	if (
		!hasPrivateTmuxOwnerIdentity(session) ||
		typeof socketKey !== "string" ||
		socketKey.length === 0 ||
		typeof tmuxSession !== "string" ||
		tmuxSession.length === 0
	)
		return null;
	const checked = await runner(["tmux", "-L", socketKey, "has-session", "-t", tmuxSession]);
	return checked.exitCode === 0;
}

function lastMatchingLine(lines: string[], pattern: RegExp): string | null {
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]?.trim();
		if (line && pattern.test(line)) return line;
	}
	return null;
}

function summarizePaneTail(lines: string[]): Record<string, unknown> {
	const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
	const spinnerLine = lastMatchingLine(nonEmpty, /^[⠁-⣿]\s+/u);
	const hudLine = lastMatchingLine(nonEmpty, /\/ 📁 | PR \d+|Status Review|Tracking/i);
	const errorLine = lastMatchingLine(nonEmpty, /\b(error|failed|exception|404|not_found)\b/i);
	const assistantLine = lastMatchingLine(nonEmpty, /^(gajae|assistant)\b/i);
	const lastContent = nonEmpty.at(-1) ?? null;
	return {
		state: spinnerLine ? "working" : errorLine ? "error_or_warning" : "idle_or_unknown",
		activity: spinnerLine ?? hudLine ?? lastContent,
		hud: hudLine,
		last_error: errorLine,
		last_speaker: assistantLine,
		last_content: lastContent,
	};
}

async function inspectTmuxSession(
	session: Record<string, unknown>,
	lines = 80,
	runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
	const live = await hasTmuxSession(session, runner);
	const tail = live ? await captureTmuxTail(session, lines, runner) : [];

	return {
		live,
		...summarizePaneTail(tail),
		tail_preview: tail.slice(-20),
	};
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
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let end = Math.min(bytes.length, byteCap); end >= 0; end--) {
		try {
			const text = decoder.decode(bytes.subarray(0, end));
			if (Buffer.byteLength(text) <= byteCap) return text;
		} catch {
			// Keep trimming until the byte slice ends on a valid UTF-8 boundary.
		}
	}
	return "";
}

export async function readCoordinatorArtifact(
	config: CoordinatorMcpConfig,
	args: { path: unknown },
): Promise<Record<string, unknown>> {
	let handle: fs.FileHandle | null = null;
	try {
		const resolved = await assertCoordinatorArtifactPath(config, args.path);
		handle = await fs.open(resolved.path, "r");
		const readLimit = resolved.byteCap + 1;
		const buffer = Buffer.alloc(readLimit);
		const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
		const boundedBytes = buffer.subarray(0, Math.min(bytesRead, resolved.byteCap));
		const text = decodeUtf8WithinByteCap(boundedBytes, resolved.byteCap);
		return {
			ok: true,
			path: resolved.path,
			text,
			bytes: Buffer.byteLength(text),
			truncated: bytesRead > resolved.byteCap,
		};
	} catch (error) {
		return {
			ok: false,
			reason: publicCoordinatorError(error),
		};
	} finally {
		await handle?.close();
	}
}

export function createCoordinatorMcpServer(options: CoordinatorMcpServerOptions = {}) {
	const env = options.env ?? process.env;
	const config = buildCoordinatorMcpConfig(env);
	const promptAckTimeoutMs = boundedRuntimePromptAckTimeoutMs(env.GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS);
	const services = options.services ?? {};
	const namespaceDir = coordinatorNamespacePath(config);
	const commandRunner = services.commandRunner ?? runCommand;

	async function listSessions(): Promise<unknown[]> {
		if (!config.namespace.profile || !config.namespace.repo) return [];
		if (services.listSessions) return await services.listSessions();
		return await listJsonFiles(path.join(namespaceDir, "sessions"));
	}
	function sessionFile(sessionId: unknown): string {
		return path.join(namespaceDir, "sessions", `${safeExternalId("session", sessionId)}.json`);
	}
	async function compensateFailedOwnerStart(
		session: Record<string, unknown>,
		ownerTransaction: {
			rollback?: () => Promise<"cleaned" | "failed" | "unverifiable">;
		} | null,
	): Promise<"cleaned" | "failed" | "unverifiable"> {
		let cleanupStatus: "cleaned" | "failed" | "unverifiable" = "unverifiable";
		try {
			cleanupStatus = (await ownerTransaction?.rollback?.()) ?? "unverifiable";
		} catch {
			cleanupStatus = "unverifiable";
		}
		try {
			const sessionId = String(session.session_id);
			const cwd = typeof session.cwd === "string" ? path.resolve(session.cwd) : null;
			if (!cwd) throw coordinatorStateError("invalid");
			const state: CoordinatorSessionState = {
				schema_version: 1,
				session_id: sessionId,
				state: "errored",
				ready_for_input: false,
				current_turn_id: null,
				last_turn_id: null,
				updated_at: new Date().toISOString(),
				source: "coordinator",
				live: false,
				reason: "coordinator_start_rolled_back",
				cwd,
				workdir: cwd,
				session_file: null,
			};
			await writeJsonFile(sessionStateFile(namespaceDir, sessionId), state);
			await fs.rm(sessionFile(sessionId), { force: true });
			await appendCoordinatorEvent(namespaceDir, {
				kind: "session.state_changed",
				sessionId,
				summary: `Session ${sessionId} start rolled back`,
				payloadRef: path.relative(namespaceDir, sessionStateFile(namespaceDir, sessionId)),
				metadata: {
					state: "errored",
					ready_for_input: false,
					live: false,
					reason: "coordinator_start_rolled_back",
				},
			});
		} catch {
			return "failed";
		}
		return cleanupStatus;
	}

	async function listQuestions(args: Record<string, unknown>): Promise<unknown[]> {
		const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
		const status = typeof args.status === "string" && args.status.length > 0 ? args.status : null;
		return (await listJsonFiles(path.join(namespaceDir, "questions"))).filter(question => {
			const record = asRecord(question);
			if (!record) return false;
			if (sessionId && record.session_id !== sessionId) return false;
			if (status && record.status !== status) return false;
			return true;
		});
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

	async function activateTurn(session: Record<string, unknown>, turn: TurnRecord): Promise<TurnRecord> {
		const timestamp = new Date().toISOString();
		const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
		const live = hasTmuxIdentity(session) ? await hasTmuxSession(session, commandRunner) : null;
		const pendingTurn: TurnRecord = {
			...turn,
			status: "active",
			delivery: {
				delivered: false,
				queued: true,
				target: typeof target === "string" ? target : null,
				tmux_keys_sent: false,
				prompt_acknowledged: false,
				state: "queued",
				attempts: [
					{
						delivered: false,
						tmux_keys_sent: false,
						channel: "tmux_keys",
						created_at: timestamp,
						reason: "awaiting_tmux_delivery",
					},
				],
			},
			liveness: {
				checked_at: timestamp,
				live,
				reason: live === false ? "tmux_session_missing" : null,
			},
			started_at: turn.started_at ?? timestamp,
			updated_at: timestamp,
		};
		await writeTurnRecord(namespaceDir, pendingTurn);
		await writeActiveTurn(namespaceDir, pendingTurn);
		await writeSessionState(namespaceDir, pendingTurn.session_id, "running", {
			currentTurnId: pendingTurn.turn_id,
			live,
			reason: null,
		});

		const tmuxKeysSent = await sendTmuxPrompt(session, turn.prompt.text, commandRunner, services.ownerIsolationProbe);
		const deliveredAt = new Date().toISOString();
		const activeTurn: TurnRecord = {
			...pendingTurn,
			delivery: {
				delivered: false,
				queued: !tmuxKeysSent,
				target: typeof target === "string" ? target : null,
				tmux_keys_sent: tmuxKeysSent,
				prompt_acknowledged: false,
				state: tmuxKeysSent ? "tmux_keys_sent" : "unavailable",
				attempts: [
					{
						delivered: false,
						tmux_keys_sent: tmuxKeysSent,
						channel: "tmux_keys",
						created_at: deliveredAt,
						reason: tmuxKeysSent ? "awaiting_runtime_ack" : "tmux_delivery_unavailable",
					},
				],
			},
			updated_at: deliveredAt,
		};
		await writeTurnRecord(namespaceDir, activeTurn);
		await writeActiveTurn(namespaceDir, activeTurn);
		const sessionState = await readSessionState(namespaceDir, activeTurn.session_id);
		const runtimeStateAlreadyAcknowledged =
			sessionState !== null && runtimeStateAcknowledgesTurn(activeTurn, sessionState);
		const resolvedTurn =
			runtimeStateAlreadyAcknowledged && sessionState
				? await markTurnAcknowledgedFromRuntimeState(namespaceDir, activeTurn, sessionState)
				: activeTurn;
		if (!runtimeStateAlreadyAcknowledged && !tmuxKeysSent) {
			await writeSessionState(namespaceDir, activeTurn.session_id, "stale", {
				currentTurnId: activeTurn.turn_id,
				live,
				reason: "tmux_delivery_unavailable",
			});
		}
		await appendCoordinatorEvent(namespaceDir, {
			kind: tmuxKeysSent ? "tmux.delivery_succeeded" : "tmux.delivery_failed",
			sessionId: activeTurn.session_id,
			turnId: activeTurn.turn_id,
			summary: tmuxKeysSent
				? `Tmux delivery succeeded for turn ${activeTurn.turn_id}`
				: `Tmux delivery failed for turn ${activeTurn.turn_id}`,
			payloadRef: path.relative(namespaceDir, turnFile(namespaceDir, activeTurn.turn_id)),
			metadata: { target: typeof target === "string" ? target : null, live },
		});
		return resolvedTurn;
	}

	async function promoteNextQueuedTurn(sessionId: string): Promise<TurnRecord | null> {
		const session = asRecord(await readJsonFile(sessionFile(sessionId)));
		if (!session) return null;
		const queuedTurns = (await listTurnRecords(namespaceDir))
			.filter(turn => turn.session_id === sessionId && turn.status === "queued")
			.sort((left, right) => left.created_at.localeCompare(right.created_at));
		const nextTurn = queuedTurns[0];
		return nextTurn ? await activateTurn(session, nextTurn) : null;
	}

	async function readTurnPayload(
		turnId: unknown,
		sessionId: unknown,
		lines: unknown,
	): Promise<Record<string, unknown>> {
		const turn = await readTurnRecord(namespaceDir, turnId);
		if (!turn) return { ok: false, reason: "unknown_turn" };
		if (sessionId != null && turn.session_id !== safeExternalId("session", sessionId)) {
			return { ok: false, reason: "turn_session_mismatch" };
		}
		const session = asRecord(await readJsonFile(sessionFile(turn.session_id)));
		let resolvedTurn = turn;
		let advisoryStatus: Record<string, unknown> = { live: false };
		let sessionState = await readSessionState(namespaceDir, turn.session_id);
		resolvedTurn = await reconcileRuntimeAcknowledgement(
			namespaceDir,
			resolvedTurn,
			sessionState,
			promptAckTimeoutMs,
			{ failOnTimeout: false },
		);
		if (resolvedTurn !== turn) sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		if (
			sessionState &&
			ACTIVE_TURN_STATUSES.has(resolvedTurn.status) &&
			runtimeStateMatchesPrivateOwnerGeneration(sessionState, session) &&
			(sessionState.current_turn_id === resolvedTurn.turn_id ||
				(sessionState.state === "errored" &&
					sessionState.source === "agent_session_event" &&
					sessionState.current_turn_id == null)) &&
			(sessionState.state === "completed" || sessionState.state === "errored")
		) {
			resolvedTurn = await markTurnTerminalFromSessionState(namespaceDir, resolvedTurn, sessionState);
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (
			sessionState &&
			ACTIVE_TURN_STATUSES.has(resolvedTurn.status) &&
			sessionState.current_turn_id === resolvedTurn.turn_id &&
			sessionState.state === "stale" &&
			sessionState.reason === "tmux_delivery_unavailable" &&
			resolvedTurn.delivery.state === "unavailable" &&
			session &&
			hasTmuxIdentity(session)
		) {
			resolvedTurn = await markTurnFailedForUnavailableSession(
				namespaceDir,
				resolvedTurn,
				"tmux_delivery_unavailable",
			);
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (!session && ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
			resolvedTurn = await markTurnFailedForUnavailableSession(namespaceDir, resolvedTurn, "session_record_missing");
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (session) {
			advisoryStatus = await inspectTmuxSession(session, boundedLineCount(lines), commandRunner);
			if (
				ACTIVE_TURN_STATUSES.has(resolvedTurn.status) &&
				hasTmuxIdentity(session) &&
				advisoryStatus.live === false
			) {
				resolvedTurn = await markTurnFailedForUnavailableSession(
					namespaceDir,
					resolvedTurn,
					"tmux_session_missing",
				);
				sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
			}
		}
		if (ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
			resolvedTurn = await reconcileRuntimeAcknowledgement(
				namespaceDir,
				resolvedTurn,
				sessionState,
				promptAckTimeoutMs,
			);
			if (!ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
				sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
			}
		}
		const missingFinalResponse =
			resolvedTurn.status === "completed" && !reportableFinalResponse(resolvedTurn.final_response);
		return {
			ok: true,
			turn: resolvedTurn,
			advisory_status: advisoryStatus,
			session_state: sessionState,
			...(missingFinalResponse
				? {
						completion_missing_final_response: true,
						advisory: MISSING_FINAL_RESPONSE_ADVISORY,
					}
				: {}),
		};
	}

	async function reconcileActiveTurnAcknowledgements(): Promise<void> {
		await preflightCoordinatorMutation(namespaceDir, undefined, {
			rejectTerminalRuntimeEvidence: false,
		});

		const turns = (await listTurnRecords(namespaceDir)).filter(turn => ACTIVE_TURN_STATUSES.has(turn.status));
		for (const turn of turns) {
			let sessionState = await readSessionState(namespaceDir, turn.session_id);
			const resolvedTurn = await reconcileRuntimeAcknowledgement(
				namespaceDir,
				turn,
				sessionState,
				promptAckTimeoutMs,
				{ failOnTimeout: false },
			);
			if (!ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) continue;
			if (resolvedTurn !== turn) sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
			const session = asRecord(await readJsonFile(sessionFile(resolvedTurn.session_id)));
			if (
				sessionState &&
				sessionState.current_turn_id === resolvedTurn.turn_id &&
				sessionState.state === "stale" &&
				sessionState.reason === "tmux_delivery_unavailable" &&
				resolvedTurn.delivery.state === "unavailable" &&
				session &&
				hasTmuxIdentity(session)
			) {
				await markTurnFailedForUnavailableSession(namespaceDir, resolvedTurn, "tmux_delivery_unavailable");
				continue;
			}
			if (!session) {
				await markTurnFailedForUnavailableSession(namespaceDir, resolvedTurn, "session_record_missing");
				continue;
			}
			if (hasTmuxIdentity(session) && (await hasTmuxSession(session, commandRunner)) === false) {
				await markTurnFailedForUnavailableSession(namespaceDir, resolvedTurn, "tmux_session_missing");
				continue;
			}
			await reconcileRuntimeAcknowledgement(namespaceDir, resolvedTurn, sessionState, promptAckTimeoutMs);
		}
	}

	async function callToolUnlocked(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			if (name === "gjc_coordinator_list_sessions") return { ok: true, sessions: await listSessions() };
			if (name === "gjc_coordinator_register_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const sessionId = safeExternalId("session", args.session_id);
				await preflightCoordinatorMutation(namespaceDir, sessionId);
				const cwd = await assertCoordinatorWorkdir(config, args.cwd);
				const tmuxSession = safeTmuxSessionName(args.tmux_session);
				const tmuxTarget = safeTmuxTarget(args.tmux_target);
				const registered = await registerExistingTmuxSession(
					{
						sessionId,
						cwd,
						tmuxSession,
						tmuxTarget,
						visible: args.visible !== false,
						warpAttached: optionalBoolean(args.warp_attached),
						source: optionalString(args.source) ?? "register_session",
						model: optionalString(args.model),
					},
					namespaceDir,
					sessionFile(sessionId),
					commandRunner,
				);
				await appendCoordinatorEvent(namespaceDir, {
					kind: "session.registered",
					sessionId,
					summary: `Session ${sessionId} registered for coordinator control`,
					payloadRef: path.relative(namespaceDir, sessionFile(sessionId)),
					metadata: {
						source: optionalString(args.source) ?? "register_session",
						visible: args.visible !== false,
					},
				});

				return {
					ok: true,
					session: registered.session,
					session_state: registered.sessionState,
					registered: true,
				};
			}
			if (name === "gjc_coordinator_read_status") {
				await reconcileActiveTurnAcknowledgements();
				const sessionId = args.session_id;
				if (sessionId) {
					const session = asRecord(await readJsonFile(sessionFile(sessionId)));
					return {
						ok: true,
						session,
						status: session ? await inspectTmuxSession(session, 80, commandRunner) : { live: false },
						session_state: await readSessionState(namespaceDir, safeExternalId("session", sessionId)),
					};
				}
				const sessions = await listSessions();
				const statuses = await Promise.all(
					sessions.map(async session =>
						typeof session === "object" && session !== null
							? {
									session,
									status: await inspectTmuxSession(session as Record<string, unknown>, 40, commandRunner),
								}
							: { session, status: { live: null } },
					),
				);
				return { ok: true, sessions, statuses };
			}
			if (name === "gjc_coordinator_read_tail") {
				const session = asRecord(await readJsonFile(sessionFile(args.session_id)));
				return {
					ok: true,
					lines: session ? await captureTmuxTail(session, boundedLineCount(args.lines), commandRunner) : [],
				};
			}
			if (name === "gjc_coordinator_list_questions") return { ok: true, questions: await listQuestions(args) };
			if (name === "gjc_coordinator_list_artifacts") return { ok: true, roots: config.allowedRoots };
			if (name === "gjc_coordinator_read_artifact")
				return await readCoordinatorArtifact(config, { path: args.path });
			if (name === "gjc_coordinator_read_coordination_status") {
				await reconcileActiveTurnAcknowledgements();
				const sessions = jsonRecords(await listSessions());
				const sessionStates = jsonRecords(await listJsonFiles(path.join(namespaceDir, "session-states")));
				const turns = jsonRecords(await listJsonFiles(turnsDir(namespaceDir)));
				const questions = jsonRecords(await listQuestions(args));
				const reports = jsonRecords(await listJsonFiles(path.join(namespaceDir, "reports")));
				const events = await readCoordinatorEvents(namespaceDir);
				return {
					ok: true,
					schema_version: 1,
					namespace: config.namespace,
					state_root: namespaceDir,
					transport: { mcp: "polling", push_subscriptions: false },
					summary: {
						sessions: sessions.length,
						active_sessions: activeSessionStates(sessionStates).length,
						turns: turns.length,
						active_turns: turns.filter(turn => ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus)).length,
						queued_turns: turns.filter(turn => turn.status === "queued").length,
						terminal_turns: turns.filter(turn => TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus)).length,
						open_questions: questions.filter(question => question.status === "open").length,
						reports: reports.length,
					},
					sessions,
					session_states: sessionStates,
					turns,
					questions,
					reports,
					events: buildCanonicalCoordinatorEvents({
						sessionStates,
						turns,
						questions,
						reports,
					}),
					latest_event_seq: await readLatestEventSeq(namespaceDir),
					recent_events: eventSummaries(events.slice(-10)),
				};
			}
			if (name === "gjc_coordinator_watch_events") {
				await withCoordinatorTransaction(namespaceDir, reconcileActiveTurnAcknowledgements);
				const limit = boundedEventLimit(args.limit);
				const timeoutMs = boundedEventWatchTimeoutMs(args.timeout_ms);
				let events = await readCoordinatorEvents(namespaceDir);
				let matched = filterCoordinatorEvents(events, args, limit);
				let timedOut = false;
				if (matched.length === 0 && timeoutMs > 0) {
					const deadline = Date.now() + timeoutMs;
					while (matched.length === 0 && Date.now() < deadline) {
						await waitForCoordinatorEvents(namespaceDir, Math.min(50, Math.max(1, deadline - Date.now())));
						await withCoordinatorTransaction(namespaceDir, reconcileActiveTurnAcknowledgements);
						events = await readCoordinatorEvents(namespaceDir);
						matched = filterCoordinatorEvents(events, args, limit);
					}
					timedOut = matched.length === 0;
				}
				return {
					ok: true,
					events: matched,
					latest_seq: await readLatestEventSeq(namespaceDir),
					timed_out: timedOut,
					transport: { mcp: "long_poll", push_subscriptions: false },
				};
			}
			const delegateWorkflow = workflowForDelegateTool(name);
			if (delegateWorkflow) {
				requireCoordinatorMutation(config, "sessions", args);
				const canonicalCwd = await assertCoordinatorWorkdir(config, args.cwd);
				const hasTask = typeof args.task === "string" && args.task.trim().length > 0;
				const hasPrompt = typeof args.prompt === "string" && args.prompt.trim().length > 0;
				const task = hasTask ? String(args.task) : hasPrompt ? String(args.prompt) : null;
				if (!task) return { ok: false, reason: "task_required" };
				await preflightCoordinatorMutation(namespaceDir);
				const promptAliasIgnored = hasTask && hasPrompt;
				const mutationRequested = args.allow_mutation === true;
				const taggedPrompt = workflowPrompt(delegateWorkflow, name, canonicalCwd, task, {
					mutationRequested,
					model: typeof args.model === "string" ? args.model : null,
				});

				let session: Record<string, unknown>;
				let reusedSession = false;
				if (args.session_id != null) {
					const sessionId = safeExternalId("session", args.session_id);
					await preflightCoordinatorMutation(namespaceDir, sessionId);
					const existing = asRecord(await readJsonFile(sessionFile(sessionId)));
					if (!existing)
						return {
							ok: false,
							reason: "unknown_session",
							session_id: sessionId,
						};
					const storedCwd = typeof existing.cwd === "string" ? existing.cwd : null;
					const canonicalStored = storedCwd ? await canonicalizePath(storedCwd) : null;
					const canonicalRequested = await canonicalizePath(canonicalCwd);
					if (!canonicalStored || canonicalStored !== canonicalRequested) {
						return {
							ok: false,
							reason: "session_cwd_mismatch",
							session_id: sessionId,
						};
					}
					session = existing;
					reusedSession = true;
				} else {
					const input = {
						cwd: canonicalCwd,
						prompt: undefined,
						namespace: config.namespace,
						worktree: true as const,
					};
					const started = services.startSession
						? await services.startSession(input)
						: await startTmuxSession(config, input, namespaceDir, commandRunner, services.ownerIsolationProbe);
					const startedRecord = asRecord(started);
					if (!startedRecord) throw new Error("coordinator_session_command_required");
					const ownerTransaction = asRecord(startedRecord.__coordinatorOwnerTransaction) as {
						commit?: () => void;
						rollback?: () => Promise<"cleaned" | "failed" | "unverifiable">;
					} | null;
					session = normalizeSession(startedRecord);
					try {
						await writeJsonFile(sessionFile(session.session_id), session);
						await appendCoordinatorEvent(namespaceDir, {
							kind: "session.started",
							sessionId: String(session.session_id),
							summary: `Session ${String(session.session_id)} started by coordinator delegate`,
							payloadRef: path.relative(namespaceDir, sessionFile(session.session_id)),
							metadata: { delegate: true, workflow: delegateWorkflow },
						});
						const live = hasTmuxIdentity(session) ? await hasTmuxSession(session, commandRunner) : null;
						await writeSessionState(namespaceDir, String(session.session_id), "ready_for_input", {
							live,
							reason: null,
						});
						ownerTransaction?.commit?.();
					} catch (error) {
						if (ownerTransaction)
							throw new CoordinatorStartError(
								"coordinator_tmux_start_failed",
								await compensateFailedOwnerStart(session, ownerTransaction),
							);
						throw error;
					}
				}

				const sessionId = String(session.session_id);
				const activeTurn = reusedSession ? await readActiveTurn(namespaceDir, sessionId) : null;
				if (activeTurn && args.force !== true && args.queue !== true) {
					return {
						ok: false,
						reason: "active_turn_exists",
						session_id: sessionId,
						active_turn_id: activeTurn.turn_id,
					};
				}
				if (activeTurn && args.force === true) {
					const timestamp = new Date().toISOString();
					const superseded = {
						...activeTurn,
						status: "superseded" as const,
						updated_at: timestamp,
						completed_at: timestamp,
					};
					await writeTurnRecord(namespaceDir, superseded);
					await clearActiveTurn(namespaceDir, superseded);
				}
				const shouldQueue = args.queue === true && args.force !== true && !!activeTurn;
				const turn = shouldQueue
					? makeTurnRecord(config, sessionId, taggedPrompt, "queued")
					: await activateTurn(session, makeTurnRecord(config, sessionId, taggedPrompt, "active"));
				if (shouldQueue) await writeTurnRecord(namespaceDir, turn);
				await appendCoordinatorEvent(namespaceDir, {
					kind: "delegation.started",
					sessionId,
					turnId: turn.turn_id,
					summary: `Delegated ${delegateWorkflow} via ${name} on session ${sessionId}`,
					metadata: {
						workflow: delegateWorkflow,
						tool_name: name,
						reused_session: reusedSession,
						queued: shouldQueue,
						allow_mutation: args.allow_mutation === true,
					},
				});
				const sessionState = await readSessionState(namespaceDir, sessionId);
				const base: Record<string, unknown> = {
					ok: true,
					workflow: delegateWorkflow,
					tool_name: name,
					session_id: sessionId,
					turn_id: turn.turn_id,
					active_turn_id: shouldQueue ? activeTurn?.turn_id : turn.turn_id,
					status: turn.status,
					queued: turn.delivery.queued,
					delivered: turn.delivery.delivered,
					delivery: turn.delivery,
					session,
					session_state: sessionState,
					turn,
					awaited: false,
					artifacts: [],
				};
				if (promptAliasIgnored) base.prompt_alias_ignored = true;
				if (args.await_completion === true && !shouldQueue) {
					const timeoutMs = boundedAwaitTurnTimeoutMs(args.timeout_ms);
					const pollIntervalMs = boundedPollIntervalMs(args.poll_interval_ms);
					const deadline = Date.now() + timeoutMs;
					let payload = await readTurnPayload(turn.turn_id, sessionId, args.lines);
					while (
						payload.ok === true &&
						!TERMINAL_TURN_STATUSES.has((payload.turn as TurnRecord).status) &&
						Date.now() < deadline
					) {
						const remainingMs = deadline - Date.now();
						await waitForTurnStateChange(
							namespaceDir,
							payload.turn as TurnRecord,
							Math.min(pollIntervalMs, remainingMs),
						);
						payload = await readTurnPayload(turn.turn_id, sessionId, args.lines);
					}
					const awaitedTurn = (payload.ok === true ? payload.turn : turn) as TurnRecord;
					base.awaited = true;
					base.status = awaitedTurn.status;
					base.turn = awaitedTurn;
					base.final_response = (awaitedTurn as unknown as Record<string, unknown>).final_response ?? null;
					base.evidence = (awaitedTurn as unknown as Record<string, unknown>).evidence ?? [];
					if (payload.ok === true) {
						base.session_state = payload.session_state;
						base.advisory_status = payload.advisory_status;
					}
					// Mirror gjc_coordinator_await_turn timeout semantics: a still-active
					// turn at the deadline is a bounded timeout, not a completion.
					if (!TERMINAL_TURN_STATUSES.has(awaitedTurn.status)) {
						base.timed_out = true;
						base.reason = "timeout";
						base.ok = false;
					}
				}
				return base;
			}
			if (name === "gjc_coordinator_start_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const cwd = await assertCoordinatorWorkdir(config, args.cwd);
				await preflightCoordinatorMutation(namespaceDir);
				const input = {
					cwd,
					prompt: typeof args.prompt === "string" ? args.prompt : undefined,
					namespace: config.namespace,
					worktree: true as const,
				};
				const started = services.startSession
					? await services.startSession(input)
					: await startTmuxSession(config, input, namespaceDir, commandRunner, services.ownerIsolationProbe);
				const startedRecord = asRecord(started);
				if (!startedRecord) throw new Error("coordinator_session_command_required");
				const ownerTransaction = asRecord(startedRecord.__coordinatorOwnerTransaction) as {
					commit?: () => void;
					rollback?: () => Promise<"cleaned" | "failed" | "unverifiable">;
				} | null;
				const session = normalizeSession(startedRecord);
				let sessionState: CoordinatorSessionState;
				try {
					await writeJsonFile(sessionFile(session.session_id), session);
					await appendCoordinatorEvent(namespaceDir, {
						kind: "session.started",
						sessionId: String(session.session_id),
						summary: `Session ${String(session.session_id)} started by coordinator`,
						payloadRef: path.relative(namespaceDir, sessionFile(session.session_id)),
						metadata: {
							prompted: typeof args.prompt === "string" && args.prompt.length > 0,
						},
					});
					const live = hasTmuxIdentity(session) ? await hasTmuxSession(session, commandRunner) : null;
					sessionState = await writeSessionState(namespaceDir, String(session.session_id), "ready_for_input", {
						live,
						reason: null,
					});
					ownerTransaction?.commit?.();
				} catch (error) {
					if (ownerTransaction)
						throw new CoordinatorStartError(
							"coordinator_tmux_start_failed",
							await compensateFailedOwnerStart(session, ownerTransaction),
						);
					throw error;
				}
				if (typeof args.prompt === "string" && args.prompt.length > 0) {
					const turn = await activateTurn(
						session,
						makeTurnRecord(config, String(session.session_id), args.prompt, "active"),
					);
					sessionState = (await readSessionState(namespaceDir, turn.session_id)) ?? sessionState;
					const prompt = {
						session_id: session.session_id,
						turn_id: turn.turn_id,
						prompt: args.prompt,
						queued: turn.delivery.queued,
						delivered: turn.delivery.delivered,
						tmux_keys_sent: turn.delivery.tmux_keys_sent ?? false,
						prompt_acknowledged: turn.delivery.prompt_acknowledged ?? false,
						created_at: turn.created_at,
					};
					await writeJsonFile(path.join(namespaceDir, "prompts", `${Date.now()}.json`), prompt);
					return {
						ok: true,
						session,
						session_state: sessionState,
						turn,
						turn_id: turn.turn_id,
						active_turn_id: turn.turn_id,
						status: turn.status,
						queued: turn.delivery.queued,
						delivered: turn.delivery.delivered,
						delivery: turn.delivery,
					};
				}
				return { ok: true, session, session_state: sessionState };
			}
			if (name === "gjc_coordinator_send_prompt") {
				requireCoordinatorMutation(config, "sessions", args);
				const sessionId = safeExternalId("session", args.session_id);
				return await withSessionMutation(`${namespaceDir}::${sessionId}`, async () => {
					await preflightCoordinatorMutation(namespaceDir, sessionId);
					const session = asRecord(await readJsonFile(sessionFile(sessionId)));
					if (!session) return { ok: false, reason: "unknown_session", session_id: sessionId };
					if (typeof args.prompt !== "string" || args.prompt.length === 0)
						return { ok: false, reason: "prompt_required" };
					await readSessionState(namespaceDir, sessionId);
					await readLatestEventSeq(namespaceDir);
					const activeTurn = await readActiveTurn(namespaceDir, sessionId);
					if (activeTurn && args.force !== true && args.queue !== true) {
						return {
							ok: false,
							reason: "active_turn_exists",
							session_id: sessionId,
							active_turn_id: activeTurn.turn_id,
						};
					}
					if (activeTurn && args.force === true) {
						const timestamp = new Date().toISOString();
						const superseded = {
							...activeTurn,
							status: "superseded" as const,
							updated_at: timestamp,
							completed_at: timestamp,
						};
						await writeTurnRecord(namespaceDir, superseded);
						await clearActiveTurn(namespaceDir, superseded);
					}
					const shouldQueue = args.queue === true && args.force !== true;
					const turn = shouldQueue
						? makeTurnRecord(config, sessionId, args.prompt, "queued")
						: await activateTurn(session, makeTurnRecord(config, sessionId, args.prompt, "active"));
					if (shouldQueue) await writeTurnRecord(namespaceDir, turn);
					const recordedTurn = turn;
					const prompt = {
						session_id: sessionId,
						turn_id: recordedTurn.turn_id,
						prompt: args.prompt,
						queued: recordedTurn.delivery.queued,
						delivered: recordedTurn.delivery.delivered,
						tmux_keys_sent: recordedTurn.delivery.tmux_keys_sent ?? false,
						prompt_acknowledged: recordedTurn.delivery.prompt_acknowledged ?? false,
						created_at: recordedTurn.created_at,
					};
					await writeJsonFile(path.join(namespaceDir, "prompts", `${Date.now()}.json`), prompt);
					return {
						ok: true,
						session_id: sessionId,
						turn_id: recordedTurn.turn_id,
						active_turn_id: shouldQueue ? activeTurn?.turn_id : recordedTurn.turn_id,
						status: recordedTurn.status,
						queued: recordedTurn.delivery.queued,
						delivered: recordedTurn.delivery.delivered,
						delivery: recordedTurn.delivery,
						prompt,
						tmux_keys_sent: recordedTurn.delivery.tmux_keys_sent ?? false,
						prompt_acknowledged: recordedTurn.delivery.prompt_acknowledged ?? false,
						session_state: await readSessionState(namespaceDir, sessionId),
					};
				});
			}
			if (name === "gjc_coordinator_read_turn") {
				return await readTurnPayload(args.turn_id, args.session_id, args.lines);
			}
			if (name === "gjc_coordinator_await_turn") {
				const timeoutMs = boundedAwaitTurnTimeoutMs(args.timeout_ms);
				const pollIntervalMs = boundedPollIntervalMs(args.poll_interval_ms);
				const deadline = Date.now() + timeoutMs;
				let payload = await withCoordinatorTransaction(
					namespaceDir,
					async () => await readTurnPayload(args.turn_id, args.session_id, args.lines),
				);
				while (
					payload.ok === true &&
					!TERMINAL_TURN_STATUSES.has((payload.turn as TurnRecord).status) &&
					Date.now() < deadline
				) {
					const remainingMs = deadline - Date.now();
					await waitForTurnStateChange(
						namespaceDir,
						payload.turn as TurnRecord,
						Math.min(pollIntervalMs, remainingMs),
					);
					payload = await withCoordinatorTransaction(
						namespaceDir,
						async () => await readTurnPayload(args.turn_id, args.session_id, args.lines),
					);
				}
				if (payload.ok === true && !TERMINAL_TURN_STATUSES.has((payload.turn as TurnRecord).status)) {
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
			if (name === "gjc_coordinator_submit_question_answer") {
				requireCoordinatorMutation(config, "questions", args);
				const questionId = safeExternalId("question", args.question_id);
				const questionPath = questionFile(namespaceDir, questionId);
				const question = asRecord(await readJsonFile(questionPath));
				if (!question) return { ok: false, reason: "unknown_question" };
				if (args.session_id != null && question.session_id !== safeExternalId("session", args.session_id)) {
					return { ok: false, reason: "question_session_mismatch" };
				}
				if (args.turn_id != null && question.turn_id !== safeTurnId(args.turn_id)) {
					return { ok: false, reason: "question_turn_mismatch" };
				}
				await preflightCoordinatorMutation(namespaceDir);
				const questionSessionId =
					typeof question.session_id === "string" ? safeExternalId("session", question.session_id) : null;
				if (!questionSessionId) throw coordinatorStateError("invalid");
				await preflightCoordinatorMutation(namespaceDir, questionSessionId);
				if (typeof question.turn_id === "string") {
					const referencedTurn = await readTurnRecord(namespaceDir, question.turn_id);
					if (!referencedTurn || referencedTurn.session_id !== questionSessionId)
						throw coordinatorStateError("invalid");
				}
				const answeredTurnId = typeof question.turn_id === "string" ? question.turn_id : null;
				const answered = {
					...question,
					status: "answered",
					answer: args.answer,
					answered_at: new Date().toISOString(),
				};
				await writeJsonFile(questionPath, answered);
				if (question.status === "open") {
					await appendCoordinatorEvent(namespaceDir, {
						kind: "question.opened",
						sessionId: typeof question.session_id === "string" ? question.session_id : null,
						turnId: typeof question.turn_id === "string" ? question.turn_id : null,
						questionId,
						summary: `Question ${questionId} opened`,
						payloadRef: path.relative(namespaceDir, questionPath),
					});
				}
				await appendCoordinatorEvent(namespaceDir, {
					kind: "question.answered",
					sessionId: typeof question.session_id === "string" ? question.session_id : null,
					turnId: typeof question.turn_id === "string" ? question.turn_id : null,
					questionId,
					summary: `Question ${questionId} answered`,
					payloadRef: path.relative(namespaceDir, questionPath),
				});

				let turn: TurnRecord | null = null;
				if (answeredTurnId) {
					turn = await readTurnRecord(namespaceDir, answeredTurnId);
					if (turn) {
						const timestamp = new Date().toISOString();
						turn = {
							...turn,
							status: "active",
							question_ids: [...new Set([...turn.question_ids, questionId])],
							updated_at: timestamp,
						};
						await writeTurnRecord(namespaceDir, turn);
						await writeActiveTurn(namespaceDir, turn);
						await writeSessionState(namespaceDir, turn.session_id, "running", {
							currentTurnId: turn.turn_id,
							live: null,
							reason: null,
						});
						const session = asRecord(await readJsonFile(sessionFile(turn.session_id)));
						if (session && typeof args.answer === "string")
							await sendTmuxPrompt(session, args.answer, commandRunner);
					}
				}
				return { ok: true, question: answered, ...(turn ? { turn } : {}) };
			}
			if (name === "gjc_coordinator_report_status") {
				requireCoordinatorMutation(config, "reports", args);
				await preflightCoordinatorMutation(namespaceDir);

				const evidence = await validateEvidencePaths(args.evidence_paths);
				const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
				if (sessionId) await preflightCoordinatorMutation(namespaceDir, sessionId);

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
				let turn: TurnRecord | null = null;
				let promotedTurn: TurnRecord | null = null;
				if (args.turn_id != null) {
					turn = await readTurnRecord(namespaceDir, args.turn_id);
					if (!turn) return { ok: false, reason: "unknown_turn" };
					if (sessionId != null && turn.session_id !== sessionId) {
						return { ok: false, reason: "turn_session_mismatch" };
					}
					await preflightCoordinatorMutation(namespaceDir, turn.session_id);
					const terminalStatus = asTerminalTurnStatus(args.status);
					if (terminalStatus) {
						const timestamp = new Date().toISOString();
						turn = {
							...turn,
							status: terminalStatus,
							delivery: {
								...turn.delivery,
								prompt_acknowledged: true,
								state: "acknowledged",
							},
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
												typeof args.blocker === "string" ? args.blocker : String(args.summary ?? "failed"),
											recoverable: true,
										}
									: null,
							updated_at: timestamp,
							completed_at: timestamp,
						};
						await writeTurnRecord(namespaceDir, turn);
						await clearActiveTurn(namespaceDir, turn);
						await writeSessionState(
							namespaceDir,
							turn.session_id,
							terminalStatus === "failed" ? "errored" : "completed",
							{
								lastTurnId: turn.turn_id,
								live: null,
								reason: terminalStatus === "failed" ? "reported_failure" : null,
							},
						);
						promotedTurn = await promoteNextQueuedTurn(turn.session_id);
					}
				}
				const reportId = `report-${Date.now()}`;
				const reportPath = path.join(namespaceDir, "reports", `${reportId}.json`);
				await writeJsonFile(reportPath, report);
				await appendCoordinatorEvent(namespaceDir, {
					kind: "report.written",
					sessionId,
					turnId: typeof args.turn_id === "string" ? args.turn_id : null,
					reportId,
					summary:
						typeof args.summary === "string"
							? args.summary
							: `Report ${String(args.status ?? "unknown")} written`,
					payloadRef: path.relative(namespaceDir, reportPath),
					metadata: {
						status: typeof args.status === "string" ? args.status : null,
					},
				});
				return {
					ok: true,
					report,
					...(turn
						? {
								turn,
								session_state: await readSessionState(namespaceDir, turn.session_id),
							}
						: {}),
					...(promotedTurn ? { promoted_turn: promotedTurn } : {}),
				};
			}
			return { ok: false, reason: "unknown_tool", tool: name };
		} catch (error) {
			return {
				ok: false,
				reason: publicCoordinatorError(error),
				...(publicCleanupStatus(error) ? { cleanup_status: publicCleanupStatus(error) } : {}),
			};
		}
	}

	async function callToolInternal(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			if (name === "gjc_coordinator_await_turn" || name === "gjc_coordinator_watch_events") {
				return await callToolUnlocked(name, args);
			}
			return await withCoordinatorTransaction(namespaceDir, async () => await callToolUnlocked(name, args));
		} catch (error) {
			return {
				ok: false,
				reason: publicCoordinatorError(error),
				...(publicCleanupStatus(error) ? { cleanup_status: publicCleanupStatus(error) } : {}),
			};
		}
	}

	async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return publicCoordinatorResponse(await callToolInternal(name, args)) as Record<string, unknown>;
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
			return {
				jsonrpc: "2.0",
				id,
				result: { tools: COORDINATOR_MCP_TOOL_NAMES.map(toolSchema) },
			};
		}
		if (request.method === "prompts/list") {
			return { jsonrpc: "2.0", id, result: { prompts: [] } };
		}
		if (request.method === "resources/list") {
			return { jsonrpc: "2.0", id, result: { resources: [] } };
		}
		if (request.method === "tools/call") {
			const params = (request.params ?? {}) as {
				name?: string;
				arguments?: Record<string, unknown>;
			};
			const payload = await callTool(params.name ?? "", params.arguments ?? {});
			return {
				jsonrpc: "2.0",
				id,
				result: textResult(payload, payload.ok === false),
			};
		}
		return {
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `unknown_method:${request.method}` },
		};
	}

	return { config, callTool, handleJsonRpc, handle: handleJsonRpc };
}

function legacyToolResult(payload: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
} {
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
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			result: { tools: COORDINATOR_MCP_TOOL_NAMES.map(toolSchema) },
		};
	}
	if (request.method === "prompts/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { prompts: [] } };
	}
	if (request.method === "resources/list") {
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			result: { resources: [] },
		};
	}
	if (request.method !== "tools/call")
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			error: { code: -32601, message: `unknown_method:${request.method}` },
		};
	const params = (request.params ?? {}) as {
		name?: string;
		arguments?: Record<string, unknown>;
	};
	const args = params.arguments ?? {};
	const server = createCoordinatorMcpServer({
		env: options.env ?? process.env,
		services: options.createSession ? { startSession: () => options.createSession?.() } : undefined,
	});
	return {
		jsonrpc: "2.0",
		id: request.id ?? null,
		result: legacyToolResult(await server.callTool(params.name ?? "", args)),
	};
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
 *  - `writeLine` failures move the writer to a terminal closed state instead of
 *    poisoning the serialized write chain or escaping as an unhandled rejection;
 *    no writes happen after close.
 *  - On EOF the pump drains in-flight handlers (bounded by `drainTimeoutMs`) and
 *    flushes queued writes before returning, so shutdown never races live work.
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
	const drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? 30_000);

	let writeClosed = false;
	let draining = false;
	let writeChain: Promise<void> = Promise.resolve();
	const inFlight = new Set<Promise<void>>();
	let activeData = 0;
	const dataQueue: JsonRpcRequest[] = [];

	const emit = (response: JsonRpcResponse): void => {
		writeChain = writeChain.then(async () => {
			if (writeClosed) return;
			try {
				await writeLine(`${JSON.stringify(response)}\n`);
			} catch {
				writeClosed = true; // terminal writer error: stop, but never poison the chain
			}
		});
	};

	const launch = (request: JsonRpcRequest, control: boolean): void => {
		const task = (async () => {
			try {
				emit(await handleJsonRpc(request));
			} catch (err) {
				emit({
					jsonrpc: "2.0",
					id: request.id ?? null,
					error: { code: -32603, message: publicCoordinatorError(err) },
				});
			} finally {
				if (!control) {
					activeData -= 1;
					if (!draining) {
						const next = dataQueue.shift();
						if (next) {
							activeData += 1;
							launch(next, false);
						}
					}
				}
			}
		})();
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	};

	const dispatch = (request: JsonRpcRequest): void => {
		// Notifications (no id) get no response; the coordinator has no side-effecting ones.
		if (request.id === undefined || request.id === null) return;
		if (request.method === "ping") {
			launch(request, true); // control frame: bypass the data cap
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
		emit({
			jsonrpc: "2.0",
			id: request.id,
			error: { code: -32000, message: "server_busy: coordinator request queue is full" },
		});
	};

	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of input) {
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
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

	// EOF: stop promoting queued work, then drain in-flight handlers under a bound.
	draining = true;
	if (inFlight.size > 0) {
		const drain = Promise.allSettled(Array.from(inFlight)).then(() => undefined);
		if (drainTimeoutMs > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>(resolve => {
				timer = setTimeout(resolve, drainTimeoutMs);
				(timer as { unref?: () => void }).unref?.();
			});
			await Promise.race([drain, timeout]);
			if (timer) clearTimeout(timer);
		} else {
			await drain;
		}
	}
	await writeChain;
}

export async function runCoordinatorMcpStdio(options: CoordinatorMcpServerOptions = {}): Promise<void> {
	const server = createCoordinatorMcpServer(options);
	await pumpCoordinatorMcpStream(
		request => server.handleJsonRpc(request),
		process.stdin,
		line =>
			new Promise<void>((resolve, reject) => {
				process.stdout.write(line, err => (err ? reject(err) : resolve()));
			}),
	);
}
