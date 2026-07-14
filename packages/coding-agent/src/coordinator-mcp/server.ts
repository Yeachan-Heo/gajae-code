import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isKnownSinkPeerClosedError } from "@gajae-code/utils";
import { normalizePathForComparison, VERSION } from "@gajae-code/utils/dirs";

import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
	type CoordinatorToolName,
} from "../coordinator/contract";
import { SdkClient, SdkClientError } from "../sdk/client/client";
import { readSdkBrokerDiscovery } from "../sdk/client/discovery";
import {
	type CoordinatorModelProfileLoader,
	loadCoordinatorModelProfiles,
	resolveCoordinatorMpreset,
} from "./model-preset";
import {
	assertCoordinatorArtifactPath,
	assertCoordinatorWorkdir,
	buildCoordinatorMcpConfig,
	type CoordinatorMcpConfig,
	coordinatorNamespacePath,
	requireCoordinatorMutation,
} from "./policy";
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

function sinkErrorCode(error: unknown): string | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
	try {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
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

interface CoordinatorServices {
	connectSdk?: (url: string, token: string) => Promise<SdkClient>;
	getAgentDir?: () => string;
	resolveModelProfiles?: CoordinatorModelProfileLoader;
	canonicalizePath?: (value: string) => Promise<string>;
}

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
	source: "coordinator" | "agent_session_event";
	live: boolean | null;
	reason: string | null;
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

	const common = { type: "object", properties: {} as Record<string, unknown> };
	const idempotencyKey = {
		type: "string",
		description: "Caller-provided idempotency key for durable coordinator mutation replay.",
	};

	if (name === "gjc_coordinator_register_session") {
		return {
			name,
			description:
				"Register an existing broker-indexed GJC session; tmux identifiers are advisory process metadata only.",
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
			description: "Start a broker-managed GJC session through canonical SDK lifecycle control.",
			inputSchema: {
				type: "object",
				properties: {
					cwd,
					prompt: { type: "string" },
					mpreset,
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: ["cwd", "idempotency_key", "allow_mutation"],
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
					answer: {},
					idempotency_key: idempotencyKey,
					allow_mutation: allowMutation,
				},
				required: ["session_id", "question_id", "answer", "idempotency_key", "allow_mutation"],
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
			description: "Read one bounded artifact from configured safe roots.",
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
			inputSchema: { type: "object", properties: { session_id: sessionId, status: { type: "string" } } },
		};
	}
	if (name === "gjc_coordinator_list_artifacts") {
		return { name, description: "List known safe artifact roots for coordinator coordination.", inputSchema: common };
	}
	if (name === "gjc_coordinator_read_coordination_status") {
		return { name, description: "Read coordinator coordination reports.", inputSchema: common };
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
					prompt: { type: "string", description: "Alias for task; accepted when task is absent." },
					allow_mutation: allowMutation,
					idempotency_key: idempotencyKey,
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
					mpreset,

					model: {
						type: "string",
						description: "Optional model hint passed in prompt metadata; no provider default is implied.",
					},
					await_completion: { type: "boolean", description: "If true, poll the turn until terminal or timeout." },
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
	return { name, description: "List known scoped GJC coordinator bridge sessions.", inputSchema: common };
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
	return normalized;
}

function coordinatorLifecycleTarget(sessionCommand: string | null, cwd: string): Record<string, unknown> {
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
	return {
		path: cwd,
		worktree: { enabled: true, ...(args[1] ? { name: args[1] } : {}) },
	};
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function readJsonFile(file: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return null;
	}
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP = 64 * 1024;
const COORDINATOR_IDEMPOTENCY_STRING_BYTE_CAP = 8 * 1024;

interface CoordinatorToolIdempotencyRecord {
	schema_version: 1;
	tool: string;
	key_digest: string;
	request_digest: string;
	state: "in_progress" | "completed";
	response?: Record<string, unknown>;
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
	await ensureDir(path.dirname(file));
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, file);
		const directory = await fs.open(path.dirname(file), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
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
		output[key] = sensitivePublicField(key)
			? "[redacted]"
			: boundedPublicValue((value as Record<string, unknown>)[key], budget, depth + 1);
	}
	if (Object.keys(value as Record<string, unknown>).length > 128) output.truncated = true;
	return output;
}

function boundedPublicResponse(response: Record<string, unknown>): Record<string, unknown> {
	const value = boundedPublicValue(response, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP });
	return asRecord(value) ?? { ok: false, error: { code: "unavailable", message: "Invalid coordinator response." } };
}

interface RuntimePromptAcknowledgement {
	accepted: true;
	command_id: string;
	turn_id: string;
}

function acknowledgementPayload(result: unknown): Record<string, unknown> | null {
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
	const acknowledgement = acknowledgementPayload(result);
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

function publicSdkAccepted(result: unknown): Record<string, unknown> {
	return acknowledgementPayload(result)?.accepted === true ? { accepted: true } : {};
}

async function listJsonFiles(dir: string): Promise<unknown[]> {
	try {
		const entries = await fs.readdir(dir);
		const values = await Promise.all(
			entries.filter(entry => entry.endsWith(".json")).map(entry => readJsonFile(path.join(dir, entry))),
		);
		return values.filter(value => value !== null);
	} catch {
		return [];
	}
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
	return firstString(asRecord(record.locator) ?? {}, ["repo"]);
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
	for (const key of ["cwd", "created_at", "mpreset"]) {
		const value = session[key];
		if (typeof value === "string") result[key] = value;
	}
	if (typeof session.ephemeral === "boolean") result.ephemeral = session.ephemeral;
	if (typeof session.visible === "boolean") result.visible = session.visible;
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
	return {
		session_id: state.session_id,
		state: state.state,
		ready_for_input: state.ready_for_input,
		current_turn_id: state.current_turn_id,
		last_turn_id: state.last_turn_id,
		updated_at: state.updated_at,
		...(typeof state.live === "boolean" ? { live: state.live } : {}),
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

function boundSummary(value: string): string {
	const normalized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

async function readLatestEventSeq(namespaceDir: string): Promise<number> {
	const sequence = asRecord(await readJsonFile(eventSequenceFile(namespaceDir)));
	const seq = sequence?.seq;
	if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) return seq;
	let latestSeq = 0;
	for (const event of await readCoordinatorEvents(namespaceDir)) latestSeq = Math.max(latestSeq, event.seq);
	return latestSeq;
}

const eventAppendQueues = new Map<string, Promise<unknown>>();

async function appendCoordinatorEvent(namespaceDir: string, input: CoordinatorEventInput): Promise<CoordinatorEvent> {
	const previous = eventAppendQueues.get(namespaceDir) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => {
		release = resolve;
	});
	const queued = previous.then(
		() => current,
		() => current,
	);
	eventAppendQueues.set(namespaceDir, queued);

	await previous.catch(() => undefined);
	try {
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
		await writeJsonFile(eventSequenceFile(namespaceDir), { seq, updated_at: timestamp });
		return event;
	} finally {
		release();
		if (eventAppendQueues.get(namespaceDir) === queued) eventAppendQueues.delete(namespaceDir);
	}
}

function parseCoordinatorEvent(line: string): CoordinatorEvent | null {
	try {
		const event = JSON.parse(line) as CoordinatorEvent;
		if (typeof event.seq !== "number" || typeof event.kind !== "string") return null;
		return event;
	} catch {
		return null;
	}
}

async function readCoordinatorEvents(namespaceDir: string): Promise<CoordinatorEvent[]> {
	try {
		const content = await fs.readFile(eventJournalFile(namespaceDir), "utf8");
		return content
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean)
			.map(parseCoordinatorEvent)
			.filter((event): event is CoordinatorEvent => event !== null)
			.sort((left, right) => left.seq - right.seq);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
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
	const previous = (await readJsonFile(turnFile(namespaceDir, turn.turn_id))) as TurnRecord | null;
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

async function clearActiveTurn(namespaceDir: string, turn: TurnRecord): Promise<void> {
	const active = asRecord(await readJsonFile(activeTurnFile(namespaceDir, turn.session_id)));
	if (active?.turn_id === turn.turn_id) await fs.rm(activeTurnFile(namespaceDir, turn.session_id), { force: true });
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
	} = {},
): Promise<CoordinatorSessionState> {
	const previous = await readSessionState(namespaceDir, sessionId);
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
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("coordinator_state_unreadable");

			await reclaimStaleSessionStateLock(lockFile);
			await Bun.sleep(5);
		}
	}
	throw new Error("coordinator_state_unreadable");
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

async function markTurnFailedForUnavailableSession(
	namespaceDir: string,
	turn: TurnRecord,
	reason: string,
): Promise<TurnRecord> {
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
	await writeTurnRecord(namespaceDir, failed);
	await clearActiveTurn(namespaceDir, failed);
	await writeSessionState(namespaceDir, failed.session_id, "stale", {
		lastTurnId: failed.turn_id,
		live: false,
		reason,
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
		liveness: { checked_at: timestamp, live: turn.liveness.live, reason: PROMPT_ACK_TIMEOUT_REASON },
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
	if (sessionState && runtimeStateAcknowledgesTurn(turn, sessionState)) {
		return await markTurnAcknowledgedFromRuntimeState(namespaceDir, turn, sessionState);
	}
	if (options.failOnTimeout && turnAwaitingRuntimeAckExpired(turn, Date.now(), ackTimeoutMs)) {
		return await markTurnFailedForUnacknowledgedDelivery(namespaceDir, turn, ackTimeoutMs);
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
	return Math.min(parsePositiveIntegerMs(value, 1000), COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS);
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
			reason: (error instanceof Error ? error.message.split(":")[0] : String(error)).replace(/^coordinator_/, ""),
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
	const platform = options.platform ?? process.platform;
	const loadModelProfiles = services.resolveModelProfiles ?? loadCoordinatorModelProfiles;
	const namespaceDir = coordinatorNamespacePath(config);
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

	async function controlSession(
		session: Record<string, unknown>,
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey: string,
	): Promise<unknown> {
		const endpoint = await resolveSessionEndpoint(session, idempotencyKey);
		const client = await (services.connectSdk ?? ((url, token) => SdkClient.connect(url, token)))(
			endpoint.url,
			endpoint.token,
		);
		const isPromptOperation =
			operation === "turn.prompt" || operation === "turn.follow_up" || operation === "turn.abort_and_prompt";
		try {
			return await client.control(operation, input, {
				idempotencyKey,
				...(isPromptOperation ? { timeoutMs: promptAckTimeoutMs } : {}),
			});
		} finally {
			await client.close();
		}
	}

	async function querySession(session: Record<string, unknown>, query: string): Promise<Record<string, unknown>> {
		const endpoint = await resolveSessionEndpoint(session);
		const client = await (services.connectSdk ?? ((url, token) => SdkClient.connect(url, token)))(
			endpoint.url,
			endpoint.token,
		);
		try {
			const response = asRecord(await client.query(query));
			if (response?.ok !== true) {
				const error = asRecord(response?.error);
				throw new SdkClientError(
					typeof error?.code === "string" ? error.code : "unavailable",
					typeof error?.message === "string" ? error.message : `SDK ${query} query failed.`,
				);
			}
			return response;
		} finally {
			await client.close();
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

	function sdkError(error: unknown): Record<string, unknown> {
		if (error instanceof SdkClientError) return { ok: false, error: { code: error.code, message: error.message } };
		return {
			ok: false,
			error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) },
		};
	}

	function requiredIdempotencyKey(args: Record<string, unknown>): string {
		const key = optionalString(args.idempotency_key);
		if (!key) throw new SdkClientError("invalid_request", "idempotency_key is required.");
		return key;
	}

	function idempotencyFile(idempotencyKey: string): string {
		const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
		return path.join(namespaceDir, "idempotency", `${keyDigest}.json`);
	}

	async function withToolIdempotency(
		tool: string,
		idempotencyKey: string,
		canonicalArgs: Record<string, unknown>,
		operation: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		const keyDigest = createHash("sha256").update(idempotencyKey).digest("hex");
		const requestDigest = createHash("sha256")
			.update(canonicalJson({ tool, args: canonicalArgs }))
			.digest("hex");
		const file = idempotencyFile(idempotencyKey);
		return await withSessionStateLock(file, async () => {
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
					if (replay) return replay;
					return {
						ok: false,
						error: {
							code: "terminal_uncertain",
							message: "completed coordinator idempotency record is corrupt; mutation outcome is uncertain",
						},
					};
				}
				if (existing.state === "in_progress")
					return {
						ok: false,
						error: {
							code: "idempotency_in_progress",
							message: "prior coordinator mutation outcome is not replayable",
						},
					};
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
			const response = boundedPublicResponse(await operation().catch(error => sdkError(error)));
			await writeCoordinatorIdempotencyFile(file, {
				...started,
				state: "completed",
				response,
				completed_at: new Date().toISOString(),
			});
			return response;
		});
	}

	async function brokerSession(
		_cwd: string,
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<unknown> {
		const discovery = await readSdkBrokerDiscovery(services.getAgentDir?.() ?? getAgentDir());
		if (!discovery) throw new SdkClientError("not_found", "SDK broker discovery is unavailable.");
		const client = await (services.connectSdk ?? ((url, token) => SdkClient.connect(url, token)))(
			discovery.url,
			discovery.token,
		);
		try {
			return await client.global(operation, input, { ...(idempotencyKey ? { idempotencyKey } : {}) });
		} finally {
			await client.close();
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

	async function canonicalBrokerWorkspace(cwd: string): Promise<string> {
		try {
			return await (services.canonicalizePath ?? (value => fs.realpath(value)))(cwd);
		} catch {
			throw new SdkClientError("not_found", "Coordinator workspace cannot be resolved.");
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
		const listing = brokerResult(await brokerSession(workspace, "session.list", { cwd: workspace }));
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

	async function exactBrokerSessionBinding(
		sessionId: string,
		workspace: string,
		idempotencyKey?: string,
	): Promise<BrokerSessionAuthority & { endpoint: { url: string; token: string } }> {
		const authority = await exactBrokerSessionAuthority(sessionId, workspace);
		const endpointRecord = brokerResult(
			await brokerSession(
				workspace,
				"session.get_endpoint",
				{
					sessionId,
					endpointGeneration: authority.endpointGeneration,
					endpointIncarnation: authority.endpointIncarnation,
				},
				idempotencyKey,
			),
		);
		const url = optionalString(endpointRecord.url);
		const token = optionalString(endpointRecord.token);
		if (!url || !token)
			throw new SdkClientError("endpoint_stale", "Broker returned an invalid incarnation-bound endpoint.");
		return { ...authority, endpoint: { url, token } };
	}

	async function resolveSessionEndpoint(
		session: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<{ url: string; token: string }> {
		const sessionId = optionalString(session.session_id) ?? optionalString(session.sessionId);
		const cwd = optionalString(session.cwd);
		const persistedWorkspace = optionalString(session.broker_workspace);
		const persistedGeneration =
			typeof session.endpoint_generation === "number" &&
			Number.isSafeInteger(session.endpoint_generation) &&
			session.endpoint_generation > 0
				? session.endpoint_generation
				: null;
		const persistedIncarnation = optionalString(session.endpoint_incarnation);
		if (!sessionId || !cwd || !persistedWorkspace || persistedGeneration === null || !persistedIncarnation)
			throw new SdkClientError("not_found", "Coordinator session has no incarnation-bound broker identity.");
		const workspace = await canonicalBrokerWorkspace(cwd);
		if (!sameCanonicalPath(workspace, persistedWorkspace, platform))
			throw new SdkClientError("endpoint_stale", "Coordinator session workspace binding is stale.");
		const binding = await exactBrokerSessionBinding(sessionId, workspace, idempotencyKey);
		if (binding.endpointGeneration !== persistedGeneration || binding.endpointIncarnation !== persistedIncarnation)
			throw new SdkClientError("endpoint_stale", "Coordinator session endpoint incarnation is stale.");
		return binding.endpoint;
	}

	async function listSessions(cwd?: string): Promise<Array<Record<string, unknown>>> {
		const roots = cwd ? [cwd] : config.allowedRoots;
		const listings = await Promise.all(
			roots.map(async root => {
				const listing = brokerResult(await brokerSession(root, "session.list", { cwd: root }));
				return scopedBrokerSessions(Array.isArray(listing.sessions) ? listing.sessions : [], root, platform);
			}),
		);
		return listings.flat();
	}
	function sessionFile(sessionId: unknown): string {
		return path.join(namespaceDir, "sessions", `${safeExternalId("session", sessionId)}.json`);
	}
	async function reapSession(
		rawId: unknown,
		opts: { force?: boolean; reason?: string } = {},
	): Promise<{ ok: boolean; reason?: string; closed: boolean; active_turn_id?: string; detail?: string }> {
		const id = safeExternalId("session", rawId);
		return await withSessionTransition(id, async () => {
			const session = asRecord(await readJsonFile(sessionFile(id)));
			if (!session) return { ok: false, reason: "unknown_session", closed: false };
			if (session.ephemeral !== true && opts.force !== true)
				return { ok: false, reason: "not_ephemeral", closed: false };
			const activeTurn = await readActiveTurn(namespaceDir, id);
			if (activeTurn) return { ok: false, reason: "active_turn", closed: false, active_turn_id: activeTurn.turn_id };
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
			let workspace = "";
			try {
				workspace = await canonicalBrokerWorkspace(cwd);
				const authority = await exactBrokerSessionAuthority(id, workspace);
				if (
					!sameCanonicalPath(authority.workspace, persistedWorkspace, platform) ||
					authority.endpointGeneration !== persistedGeneration ||
					authority.endpointIncarnation !== persistedIncarnation
				)
					return { ok: false, reason: "endpoint_stale", closed: false };
				brokerResult(
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
				);
			} catch (error) {
				return {
					ok: false,
					reason: "close_failed",
					detail: error instanceof SdkClientError ? error.code : "unavailable",
					closed: false,
				};
			}
			try {
				await exactBrokerSessionAuthority(id, workspace);
				return { ok: false, reason: "endpoint_stale", closed: false };
			} catch (error) {
				if (!(error instanceof SdkClientError) || error.code !== "not_found")
					return {
						ok: false,
						reason: "close_failed",
						detail: error instanceof SdkClientError ? error.code : "unavailable",
						closed: false,
					};
			}
			await fs.rm(sessionFile(id), { force: true });
			await fs.rm(sessionStateFile(namespaceDir, id), { force: true });
			await fs.rm(activeTurnFile(namespaceDir, id), { force: true });
			await appendCoordinatorEvent(namespaceDir, {
				kind: "session.reaped",
				sessionId: id,
				summary: `Session ${id} closed and reaped${opts.reason ? ` (${opts.reason})` : ""}`,
				metadata: { reason: opts.reason ?? null, force: opts.force === true, closed: true },
			});
			return { ok: true, closed: true };
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
					const state = await readSessionState(namespaceDir, sessionId);
					const stamp = optionalString(state?.updated_at) ?? optionalString(session.created_at);
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

	async function readTurnPayload(turnId: unknown, sessionId: unknown): Promise<Record<string, unknown>> {
		const turn = await readTurnRecord(namespaceDir, turnId);
		if (!turn) return { ok: false, reason: "unknown_turn" };
		if (sessionId != null && turn.session_id !== safeExternalId("session", sessionId)) {
			return { ok: false, reason: "turn_session_mismatch" };
		}
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
					reason: error instanceof SdkClientError ? error.code : "unavailable",
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
			{ failOnTimeout: false },
		);
		if (resolvedTurn !== turn) sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		if (
			sessionState?.state === "needs_user_input" &&
			sessionState.current_turn_id === resolvedTurn.turn_id &&
			ACTIVE_TURN_STATUSES.has(resolvedTurn.status) &&
			resolvedTurn.status !== "waiting_for_answer"
		) {
			const timestamp = new Date().toISOString();
			resolvedTurn = { ...resolvedTurn, status: "waiting_for_answer", updated_at: timestamp };
			await writeTurnRecord(namespaceDir, resolvedTurn);
			await writeActiveTurn(namespaceDir, resolvedTurn);
		}
		if (
			sessionState &&
			ACTIVE_TURN_STATUSES.has(resolvedTurn.status) &&
			(sessionState.current_turn_id === resolvedTurn.turn_id ||
				(sessionState.state === "errored" &&
					sessionState.source === "agent_session_event" &&
					sessionState.current_turn_id == null)) &&
			(sessionState.state === "completed" || sessionState.state === "errored")
		) {
			resolvedTurn = await markTurnTerminalFromSessionState(namespaceDir, resolvedTurn, sessionState);
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (!session && ACTIVE_TURN_STATUSES.has(resolvedTurn.status)) {
			resolvedTurn = await markTurnFailedForUnavailableSession(namespaceDir, resolvedTurn, "session_record_missing");
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
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

	async function recordAcceptedPrompt(
		sessionId: string,
		prompt: string,
		operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt",
		previousActiveTurn: TurnRecord | null,
		acknowledgement: RuntimePromptAcknowledgement,
	): Promise<TurnRecord> {
		const timestamp = new Date().toISOString();
		if (operation === "turn.abort_and_prompt" && previousActiveTurn) {
			const superseded: TurnRecord = {
				...previousActiveTurn,
				status: "superseded",
				updated_at: timestamp,
				completed_at: timestamp,
			};
			await writeTurnRecord(namespaceDir, superseded);
			await clearActiveTurn(namespaceDir, superseded);
		}
		const queued = operation === "turn.follow_up";
		const turn = makeTurnRecord(config, sessionId, prompt, queued ? "queued" : "active");
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
		await writeTurnRecord(namespaceDir, turn);
		if (!queued) {
			await writeActiveTurn(namespaceDir, turn);
			await writeSessionState(namespaceDir, sessionId, "running", {
				currentTurnId: turn.turn_id,
				live: null,
				reason: null,
			});
		}
		return turn;
	}

	async function promoteNextQueuedTurn(sessionId: string): Promise<TurnRecord | null> {
		const queuedTurns = (await listJsonFiles(turnsDir(namespaceDir)))
			.map(turn => asRecord(turn) as TurnRecord | null)
			.filter(
				(turn): turn is TurnRecord => turn !== null && turn.session_id === sessionId && turn.status === "queued",
			)
			.sort((left, right) => left.created_at.localeCompare(right.created_at));
		const next = queuedTurns[0];
		if (!next) return null;
		const timestamp = new Date().toISOString();
		const active: TurnRecord = { ...next, status: "active", started_at: timestamp, updated_at: timestamp };
		await writeTurnRecord(namespaceDir, active);
		await writeActiveTurn(namespaceDir, active);
		await writeSessionState(namespaceDir, sessionId, "running", {
			currentTurnId: active.turn_id,
			live: null,
			reason: null,
		});
		return active;
	}

	async function reconcileActiveTurnAcknowledgements(): Promise<void> {
		const turns = (await listJsonFiles(turnsDir(namespaceDir)))
			.map(turn => asRecord(turn) as TurnRecord | null)
			.filter((turn): turn is TurnRecord => turn !== null && ACTIVE_TURN_STATUSES.has(turn.status));
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
			if (!session) {
				await markTurnFailedForUnavailableSession(namespaceDir, resolvedTurn, "session_record_missing");
				continue;
			}
			await reconcileRuntimeAcknowledgement(namespaceDir, resolvedTurn, sessionState, promptAckTimeoutMs);
		}
	}

	async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			if (name === "gjc_coordinator_list_sessions")
				return { ok: true, sessions: (await listSessions()).map(publicBrokerSession) };
			if (name === "gjc_coordinator_register_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				const cwd = await canonicalBrokerWorkspace(await assertCoordinatorWorkdir(config, args.cwd));
				const tmuxSession = optionalString(args.tmux_session) ? safeTmuxSessionName(args.tmux_session) : undefined;
				const tmuxTarget = optionalString(args.tmux_target) ? safeTmuxTarget(args.tmux_target) : undefined;
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						session_id: sessionId,
						cwd,
						...(tmuxSession ? { tmux_session: tmuxSession } : {}),
						...(tmuxTarget ? { tmux_target: tmuxTarget } : {}),
						visible: args.visible !== false,
						source: optionalString(args.source) ?? "register_session",
						model: optionalString(args.model),
						allow_mutation: true,
					},
					async () => {
						const binding = await exactBrokerSessionBinding(sessionId, cwd, idempotencyKey);
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
						});
						await writeJsonFile(sessionFile(sessionId), session);
						const sessionState = await writeSessionState(namespaceDir, sessionId, "ready_for_input", {
							live: null,
							reason: null,
						});
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
							session: publicCoordinatorSession(session),
							session_state: publicCoordinatorSessionState(sessionState),
							registered: true,
						};
					},
				);
			}
			if (name === "gjc_coordinator_read_status") {
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
					try {
						const indexedSession = (await listSessions(cwd)).find(
							candidate => brokerSessionId(candidate) === canonicalSessionId,
						);
						return {
							ok: true,
							session: publicCoordinatorSession(session),
							status: brokerLiveness(indexedSession ?? null),
							session_state: publicCoordinatorSessionState(
								await readSessionState(namespaceDir, canonicalSessionId),
							),
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
			if (name === "gjc_coordinator_list_questions") return { ok: true, questions: await listQuestions(args) };
			if (name === "gjc_coordinator_list_artifacts") return { ok: true, roots: config.allowedRoots };
			if (name === "gjc_coordinator_read_artifact")
				return await readCoordinatorArtifact(config, { path: args.path });
			if (name === "gjc_coordinator_read_coordination_status") {
				await reconcileActiveTurnAcknowledgements();
				const brokerSessions = await listSessions();
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
						sessions: brokerSessions.length,
						active_sessions: activeSessionStates(sessionStates).length,
						turns: turns.length,
						active_turns: turns.filter(turn => ACTIVE_TURN_STATUSES.has(turn.status as TurnStatus)).length,
						queued_turns: turns.filter(turn => turn.status === "queued").length,
						terminal_turns: turns.filter(turn => TERMINAL_TURN_STATUSES.has(turn.status as TurnStatus)).length,
						open_questions: questions.filter(question => question.status === "open").length,
						reports: reports.length,
					},
					sessions: brokerSessions.map(publicBrokerSession),
					session_states: sessionStates.map(state =>
						publicCoordinatorSessionState(state as unknown as CoordinatorSessionState),
					),
					turns: turns.map(turn =>
						boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					questions: questions.map(question =>
						boundedPublicValue(question, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					reports: reports.map(report =>
						boundedPublicValue(report, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
					),
					events: buildCanonicalCoordinatorEvents({ sessionStates, turns, questions, reports }),
					latest_event_seq: await readLatestEventSeq(namespaceDir),
					recent_events: eventSummaries(events.slice(-10)),
				};
			}
			if (name === "gjc_coordinator_watch_events") {
				await reconcileActiveTurnAcknowledgements();
				const limit = boundedEventLimit(args.limit);
				const timeoutMs = boundedEventWatchTimeoutMs(args.timeout_ms);
				let events = await readCoordinatorEvents(namespaceDir);
				let matched = filterCoordinatorEvents(events, args, limit);
				let timedOut = false;
				if (matched.length === 0 && timeoutMs > 0) {
					const deadline = Date.now() + timeoutMs;
					while (matched.length === 0 && Date.now() < deadline) {
						await waitForCoordinatorEvents(namespaceDir, Math.min(50, Math.max(1, deadline - Date.now())));
						await reconcileActiveTurnAcknowledgements();
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
				const hasTask = typeof args.task === "string" && args.task.trim().length > 0;
				const hasPrompt = typeof args.prompt === "string" && args.prompt.trim().length > 0;
				const task = hasTask ? String(args.task) : hasPrompt ? String(args.prompt) : null;
				if (!task) return { ok: false, reason: "task_required" };
				const taggedPrompt = workflowPrompt(delegateWorkflow, name, canonicalCwd, task, {
					mutationRequested: args.allow_mutation === true,
					model: typeof args.model === "string" ? args.model : null,
				});
				const reusedSessionId = args.session_id == null ? undefined : safeExternalId("session", args.session_id);
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						cwd: canonicalCwd,
						task,
						...(reusedSessionId ? { session_id: reusedSessionId } : {}),
						queue: args.queue === true,
						force: args.force === true,
						mpreset: mpresetResolution.mpreset,
						model: typeof args.model === "string" ? args.model : null,
						await_completion: args.await_completion === true,
						...(args.await_completion === true
							? { timeout_ms: args.timeout_ms, poll_interval_ms: args.poll_interval_ms }
							: {}),
						prompt_alias_ignored: hasTask && hasPrompt,
						allow_mutation: true,
					},
					async () => {
						const delegate = async () => {
							let sessionId: string;
							let session: Record<string, unknown>;
							let reusedSession = false;
							if (reusedSessionId) {
								sessionId = reusedSessionId;
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
								const binding = await exactBrokerSessionBinding(sessionId, canonicalCwd, idempotencyKey);
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
								});
								reusedSession = true;
							} else {
								const created = brokerResult(
									await brokerSession(
										canonicalCwd,
										"session.create",
										{
											cwd: canonicalCwd,
											target: coordinatorLifecycleTarget(config.sessionCommand, canonicalCwd),
											...(mpresetResolution.mpreset ? { modelPreset: mpresetResolution.mpreset } : {}),
										},
										idempotencyKey,
									),
								);
								sessionId = safeExternalId("session", created.sessionId ?? created.session_id);
								const createdCwd = await canonicalBrokerWorkspace(optionalString(created.cwd) ?? canonicalCwd);
								const binding = await exactBrokerSessionBinding(sessionId, createdCwd, idempotencyKey);
								session = normalizeSession({
									session_id: sessionId,
									cwd: createdCwd,
									ephemeral: true,
									created_at: new Date().toISOString(),
									...(mpresetResolution.mpreset ? { mpreset: mpresetResolution.mpreset } : {}),
									broker_workspace: binding.workspace,
									endpoint_generation: binding.endpointGeneration,
									endpoint_incarnation: binding.endpointIncarnation,
								});
							}
							await writeJsonFile(sessionFile(sessionId), session);
							const previousActiveTurn = await readActiveTurn(namespaceDir, sessionId);
							if (previousActiveTurn && args.queue !== true && args.force !== true) {
								return {
									ok: false,
									error: {
										code: "active_turn_exists",
										message: `Session ${sessionId} already has active turn ${previousActiveTurn.turn_id}.`,
									},
									turn_id: previousActiveTurn.turn_id,
								};
							}
							const operation =
								args.force === true
									? "turn.abort_and_prompt"
									: args.queue === true
										? "turn.follow_up"
										: "turn.prompt";
							const result = await controlSession(session, operation, { text: taggedPrompt }, idempotencyKey);
							const acknowledgement = requirePromptAcknowledgement(result);
							const turn = await recordAcceptedPrompt(
								sessionId,
								taggedPrompt,
								operation,
								previousActiveTurn,
								acknowledgement,
							);
							await appendCoordinatorEvent(namespaceDir, {
								kind: "delegation.started",
								sessionId,
								turnId: turn.turn_id,
								summary: `Delegated ${delegateWorkflow} via ${name} on session ${sessionId}`,
								metadata: {
									workflow: delegateWorkflow,
									tool_name: name,
									reused_session: reusedSession,
									sdk_operation: operation,
								},
							});
							const response = {
								ok: true,
								workflow: delegateWorkflow,
								tool_name: name,
								session_id: sessionId,
								turn_id: turn.turn_id,
								active_turn_id: turn.delivery.queued ? (previousActiveTurn?.turn_id ?? null) : turn.turn_id,
								status: turn.status,
								queued: turn.delivery.queued,
								delivered: turn.delivery.delivered,
								delivery: turn.delivery,
								session: publicCoordinatorSession(session),
								session_state: publicCoordinatorSessionState(await readSessionState(namespaceDir, sessionId)),
								turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
								result: publicSdkAcknowledgement(acknowledgement),
								...(hasTask && hasPrompt ? { prompt_alias_ignored: true } : {}),
							};
							return args.await_completion === true
								? {
										...response,
										completion: await awaitTurnPayload(
											turn.turn_id,
											sessionId,
											args.timeout_ms,
											args.poll_interval_ms,
										),
									}
								: response;
						};
						return reusedSessionId ? await withSessionTransition(reusedSessionId, delegate) : await delegate();
					},
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
				const prompt = typeof args.prompt === "string" && args.prompt.length > 0 ? args.prompt : null;
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						cwd,
						mpreset: mpresetResolution.mpreset,
						...(prompt ? { prompt } : {}),
						allow_mutation: true,
					},
					async () => {
						const created = brokerResult(
							await brokerSession(
								cwd,
								"session.create",
								{
									cwd,
									target: coordinatorLifecycleTarget(config.sessionCommand, cwd),
									...(mpresetResolution.mpreset ? { modelPreset: mpresetResolution.mpreset } : {}),
								},
								idempotencyKey,
							),
						);
						const sessionId = safeExternalId("session", created.sessionId ?? created.session_id);
						const sessionCwd = await canonicalBrokerWorkspace(optionalString(created.cwd) ?? cwd);
						const binding = await exactBrokerSessionBinding(sessionId, sessionCwd, idempotencyKey);
						const session = normalizeSession({
							session_id: sessionId,
							cwd: sessionCwd,
							...(mpresetResolution.mpreset ? { mpreset: mpresetResolution.mpreset } : {}),
							broker_workspace: binding.workspace,
							endpoint_generation: binding.endpointGeneration,
							endpoint_incarnation: binding.endpointIncarnation,
						});
						await writeJsonFile(sessionFile(sessionId), session);
						const lifecycle = publicLifecycleReceipt(created, sessionId);
						if (prompt) {
							const result = await controlSession(session, "turn.prompt", { text: prompt }, idempotencyKey);
							const acknowledgement = requirePromptAcknowledgement(result);
							const turn = await recordAcceptedPrompt(sessionId, prompt, "turn.prompt", null, acknowledgement);
							return {
								ok: true,
								session: publicCoordinatorSession(session),
								session_id: sessionId,
								lifecycle,
								turn_id: turn.turn_id,
								active_turn_id: turn.turn_id,
								status: turn.status,
								queued: turn.delivery.queued,
								delivered: turn.delivery.delivered,
								operation: "turn.prompt",
								turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
								result: publicSdkAcknowledgement(acknowledgement),
								session_state: publicCoordinatorSessionState(await readSessionState(namespaceDir, sessionId)),
							};
						}
						const sessionState = await writeSessionState(namespaceDir, sessionId, "ready_for_input", {
							live: null,
							reason: null,
						});
						await appendCoordinatorEvent(namespaceDir, {
							kind: "session.started",
							sessionId,
							summary: `Session ${sessionId} started through SDK lifecycle control`,
							payloadRef: path.relative(namespaceDir, sessionFile(sessionId)),
						});
						return {
							ok: true,
							session: publicCoordinatorSession(session),
							session_state: publicCoordinatorSessionState(sessionState),
							lifecycle,
						};
					},
				);
			}
			if (name === "gjc_coordinator_send_prompt") {
				requireCoordinatorMutation(config, "sessions", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const sessionId = safeExternalId("session", args.session_id);
				if (typeof args.prompt !== "string" || args.prompt.length === 0)
					return { ok: false, error: { code: "invalid_input", message: "prompt is required" } };
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
							const previousActiveTurn = await readActiveTurn(namespaceDir, sessionId);
							if (previousActiveTurn && args.queue !== true && args.force !== true) {
								return {
									ok: false,
									error: {
										code: "active_turn_exists",
										message: `Session ${sessionId} already has active turn ${previousActiveTurn.turn_id}.`,
									},
									turn_id: previousActiveTurn.turn_id,
								};
							}
							const operation =
								args.force === true
									? "turn.abort_and_prompt"
									: args.queue === true
										? "turn.follow_up"
										: "turn.prompt";
							const result = await controlSession(currentSession, operation, { text: prompt }, idempotencyKey);
							const acknowledgement = requirePromptAcknowledgement(result);
							const turn = await recordAcceptedPrompt(
								sessionId,
								prompt,
								operation,
								previousActiveTurn,
								acknowledgement,
							);
							return {
								ok: true,
								session_id: sessionId,
								turn_id: turn.turn_id,
								active_turn_id: turn.delivery.queued ? (previousActiveTurn?.turn_id ?? null) : turn.turn_id,
								status: turn.status,
								queued: turn.delivery.queued,
								delivered: turn.delivery.delivered,
								operation,
								result: publicSdkAcknowledgement(acknowledgement),
								turn: boundedPublicValue(turn, { remaining: COORDINATOR_IDEMPOTENCY_RESPONSE_BYTE_CAP }),
								session_state: publicCoordinatorSessionState(await readSessionState(namespaceDir, sessionId)),
							};
						}),
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
				const questionId = safeExternalId("question", args.question_id);
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						session_id: sessionId,
						question_id: questionId,
						answer: args.answer,
						...(args.turn_id == null ? {} : { turn_id: args.turn_id }),
						allow_mutation: true,
					},
					async () => {
						const session = asRecord(await readJsonFile(sessionFile(sessionId)));
						if (!session)
							return {
								ok: false,
								error: { code: "not_found", message: `Coordinator session not found: ${sessionId}` },
							};
						const result = await controlSession(
							session,
							"ask.answer",
							{ id: questionId, answer: args.answer },
							idempotencyKey,
						);
						return {
							ok: true,
							session_id: sessionId,
							operation: "ask.answer",
							result: publicSdkAccepted(result),
						};
					},
				);
			}
			if (name === "gjc_coordinator_report_status") {
				requireCoordinatorMutation(config, "reports", args);
				const idempotencyKey = requiredIdempotencyKey(args);
				const evidence = await validateEvidencePaths(args.evidence_paths);
				const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
				return await withToolIdempotency(
					name,
					idempotencyKey,
					{
						session_id: sessionId,
						turn_id: args.turn_id ?? null,
						status: args.status,
						summary: args.summary,
						blocker: args.blocker,
						pr_url: args.pr_url,
						evidence_paths: evidence.map(item => item.path),
						allow_mutation: true,
					},
					async () => {
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
						if (args.turn_id != null) {
							turn = await readTurnRecord(namespaceDir, args.turn_id);
							if (!turn) return { ok: false, reason: "unknown_turn" };
							if (sessionId != null && turn.session_id !== sessionId)
								return { ok: false, reason: "turn_session_mismatch" };
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
														typeof args.blocker === "string"
															? args.blocker
															: String(args.summary ?? "failed"),
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
								await promoteNextQueuedTurn(turn.session_id);
							}
						}
						const reportId = `report-${randomUUID()}`;
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
							metadata: { status: typeof args.status === "string" ? args.status : null },
						});
						return {
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
						};
					},
				);
			}
			return { ok: false, reason: "unknown_tool", tool: name };
		} catch (error) {
			if (error instanceof SdkClientError) return sdkError(error);
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
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

	return { config, callTool, handleJsonRpc, handle: handleJsonRpc, reapSession, sessionReaper };
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
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"timed_out">(resolve => {
			timer = setTimeout(() => resolve("timed_out"), drainTimeoutMs);
			(timer as { unref?: () => void }).unref?.();
		});
		const drain = async (): Promise<"drained"> => {
			while (true) {
				if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
				const writes = writeChain;
				await writes;
				if (inFlight.size === 0 && writes === writeChain) return "drained";
			}
		};
		try {
			if ((await Promise.race([drain(), timeout])) === "timed_out") {
				writerState = "closed";
				draining = true;
				dataQueue.length = 0;
				detachInput();
			}
		} finally {
			if (timer) clearTimeout(timer);
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
		server.sessionReaper.stop();
	}
}
