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
} from "../gjc-runtime/session-state-sidecar";
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

interface CoordinatorServices {
	listSessions?: () => unknown[] | Promise<unknown[]>;
	startSession?: (input: SessionStartInput) => unknown | Promise<unknown>;
	commandRunner?: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
	prompt: { text: string; created_at: string; source: "mcp" | "question_answer" };
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
	| "session.state_changed"
	| "turn.queued"
	| "turn.delivering"
	| "turn.active"
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
				properties: { cwd, prompt: { type: "string" }, allow_mutation: allowMutation },
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
				properties: { session_id: sessionId, turn_id: { type: "string" }, lines: { type: "number" } },
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
			inputSchema: { type: "object", properties: { path: pathField }, required: ["path"] },
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
					await_completion: { type: "boolean", description: "If true, poll the turn until terminal or timeout." },
					timeout_ms: {
						type: "number",
						description:
							"Bounded await timeout in milliseconds, capped at 30 minutes like gjc_coordinator_await_turn.",
					},
					poll_interval_ms: { type: "number", description: "Bounded await polling interval." },
					lines: { type: "number", description: "Bounded advisory tail lines returned with await/read payloads." },
				},
				required: ["cwd", "allow_mutation"],
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
	return {
		session_id: session.sessionId ?? session.session_id ?? session.name ?? "unknown",
		...(session.tmuxSession ? { tmux_session: session.tmuxSession } : {}),
		...(session.cwd ? { cwd: session.cwd } : {}),
		...(session.createdAt ? { created_at: session.createdAt } : {}),
		...session,
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

function hasTmuxIdentity(session: Record<string, unknown>): boolean {
	return (
		(typeof session.tmux_session === "string" && session.tmux_session.length > 0) ||
		(typeof session.tmuxSession === "string" && session.tmuxSession.length > 0)
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
async function runCommand(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

type CommandRunner = (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function sendTmuxPromptKeys(
	target: string,
	prompt: string,
	runner: CommandRunner = runCommand,
): Promise<boolean> {
	const typed = await runner(["tmux", "send-keys", "-t", target, "-l", prompt]);
	if (typed.exitCode !== 0) return false;
	const submitted = await runner(["tmux", "send-keys", "-t", target, "-l", "\x1b[13;5u"]);
	return submitted.exitCode === 0;
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
): Promise<{ session: Record<string, unknown>; sessionState: CoordinatorSessionState }> {
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

async function startTmuxSession(
	config: CoordinatorMcpConfig,
	input: SessionStartInput,
	namespaceDir: string,
	runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
	if (!config.sessionCommand) throw new Error("coordinator_session_command_required");
	const sessionName = `gjc-coordinator-${randomUUID().slice(0, 8)}`;
	const runtimeStateFile = sessionStateFile(namespaceDir, sessionName);
	const sessionCommand = [
		"exec env",
		`${GJC_COORDINATOR_SESSION_STATE_FILE_ENV}=${shellQuote(runtimeStateFile)}`,
		`${GJC_COORDINATOR_SESSION_ID_ENV}=${shellQuote(sessionName)}`,
		config.sessionCommand,
	].join(" ");
	const started = await runner([
		"tmux",
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{session_name}:#{window_index}.#{pane_index} #{pane_id}",
		"-s",
		sessionName,
		"-c",
		input.cwd,
		sessionCommand,
	]);
	if (started.exitCode !== 0) throw new Error(`coordinator_tmux_start_failed:${started.stderr || started.stdout}`);
	const [tmuxTarget, paneId] = started.stdout.trim().split(/\s+/, 2);
	return {
		sessionId: sessionName,
		tmuxSession: sessionName,
		tmuxTarget: tmuxTarget || sessionName,
		paneId,
		cwd: input.cwd,
		createdAt: new Date().toISOString(),
		sessionCommand: config.sessionCommand,
		runtimeStateFile,
	};
}

async function captureTmuxTail(session: Record<string, unknown>, lines: number): Promise<string[]> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	if (typeof target !== "string" || target.length === 0) return [];
	const captured = await runCommand(["tmux", "capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
	if (captured.exitCode !== 0) return [];
	return captured.stdout.split("\n").slice(-lines);
}

async function sendTmuxPrompt(
	session: Record<string, unknown>,
	prompt: string,
	runner: CommandRunner = runCommand,
): Promise<boolean> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	if (typeof target !== "string" || target.length === 0) return false;
	return await sendTmuxPromptKeys(target, prompt, runner);
}

async function hasTmuxSession(
	session: Record<string, unknown>,
	runner: CommandRunner = runCommand,
): Promise<boolean | null> {
	const tmuxSession = typeof session.tmux_session === "string" ? session.tmux_session : session.tmuxSession;
	if (typeof tmuxSession !== "string" || tmuxSession.length === 0) return null;
	const checked = await runner(["tmux", "has-session", "-t", tmuxSession]);
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
	const tail = live ? await captureTmuxTail(session, lines) : [];
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
	await ensureDir(eventsDir(namespaceDir));
	try {
		const watcher = nodeFs.watch(eventsDir(namespaceDir), (_eventType, filename) => {
			if (filename === "event-journal.jsonl" || filename === "latest-seq.json") finish();
		});
		watchers.push(watcher);
	} catch {
		// Directory may not exist yet; the timeout remains a bounded fallback.
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
			liveness: { checked_at: timestamp, live, reason: live === false ? "tmux_session_missing" : null },
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

		const tmuxKeysSent = await sendTmuxPrompt(session, turn.prompt.text, commandRunner);
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
		const queuedTurns = (await listJsonFiles(turnsDir(namespaceDir)))
			.map(turn => asRecord(turn) as TurnRecord | null)
			.filter((turn): turn is TurnRecord => turn?.session_id === sessionId && turn.status === "queued")
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

	async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			if (name === "gjc_coordinator_list_sessions") return { ok: true, sessions: await listSessions() };
			if (name === "gjc_coordinator_register_session") {
				requireCoordinatorMutation(config, "sessions", args);
				const sessionId = safeExternalId("session", args.session_id);
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
					metadata: { source: optionalString(args.source) ?? "register_session", visible: args.visible !== false },
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
				return { ok: true, lines: session ? await captureTmuxTail(session, boundedLineCount(args.lines)) : [] };
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
					await waitForCoordinatorEvents(namespaceDir, timeoutMs);
					await reconcileActiveTurnAcknowledgements();
					events = await readCoordinatorEvents(namespaceDir);
					matched = filterCoordinatorEvents(events, args, limit);
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
					const existing = asRecord(await readJsonFile(sessionFile(sessionId)));
					if (!existing) return { ok: false, reason: "unknown_session", session_id: sessionId };
					const storedCwd = typeof existing.cwd === "string" ? existing.cwd : null;
					const canonicalStored = storedCwd ? await canonicalizePath(storedCwd) : null;
					const canonicalRequested = await canonicalizePath(canonicalCwd);
					if (!canonicalStored || canonicalStored !== canonicalRequested) {
						return { ok: false, reason: "session_cwd_mismatch", session_id: sessionId };
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
						: await startTmuxSession(config, input, namespaceDir, commandRunner);
					const startedRecord = asRecord(started);
					if (!startedRecord) throw new Error("coordinator_session_command_required");
					session = normalizeSession(startedRecord);
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
				const input = {
					cwd,
					prompt: typeof args.prompt === "string" ? args.prompt : undefined,
					namespace: config.namespace,
					worktree: true as const,
				};
				const started = services.startSession
					? await services.startSession(input)
					: await startTmuxSession(config, input, namespaceDir, commandRunner);
				const startedRecord = asRecord(started);
				if (!startedRecord) throw new Error("coordinator_session_command_required");
				const session = normalizeSession(startedRecord);
				await writeJsonFile(sessionFile(session.session_id), session);
				await appendCoordinatorEvent(namespaceDir, {
					kind: "session.started",
					sessionId: String(session.session_id),
					summary: `Session ${String(session.session_id)} started by coordinator`,
					payloadRef: path.relative(namespaceDir, sessionFile(session.session_id)),
					metadata: { prompted: typeof args.prompt === "string" && args.prompt.length > 0 },
				});
				const live = hasTmuxIdentity(session) ? await hasTmuxSession(session, commandRunner) : null;
				let sessionState = await writeSessionState(namespaceDir, String(session.session_id), "ready_for_input", {
					live,
					reason: null,
				});
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
				const session = asRecord(await readJsonFile(sessionFile(sessionId)));
				if (!session) return { ok: false, reason: "unknown_session", session_id: sessionId };
				if (typeof args.prompt !== "string" || args.prompt.length === 0)
					return { ok: false, reason: "prompt_required" };
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
			}
			if (name === "gjc_coordinator_read_turn") {
				return await readTurnPayload(args.turn_id, args.session_id, args.lines);
			}
			if (name === "gjc_coordinator_await_turn") {
				const timeoutMs = boundedAwaitTurnTimeoutMs(args.timeout_ms);
				const pollIntervalMs = boundedPollIntervalMs(args.poll_interval_ms);
				const deadline = Date.now() + timeoutMs;
				let payload = await readTurnPayload(args.turn_id, args.session_id, args.lines);
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
					payload = await readTurnPayload(args.turn_id, args.session_id, args.lines);
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
				const evidence = await validateEvidencePaths(args.evidence_paths);
				const sessionId = args.session_id == null ? null : safeExternalId("session", args.session_id);
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
					metadata: { status: typeof args.status === "string" ? args.status : null },
				});
				return {
					ok: true,
					report,
					...(turn ? { turn, session_state: await readSessionState(namespaceDir, turn.session_id) } : {}),
					...(promotedTurn ? { promoted_turn: promotedTurn } : {}),
				};
			}
			return { ok: false, reason: "unknown_tool", tool: name };
		} catch (error) {
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

	return { config, callTool, handleJsonRpc, handle: handleJsonRpc };
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

export async function runCoordinatorMcpStdio(options: CoordinatorMcpServerOptions = {}): Promise<void> {
	const server = createCoordinatorMcpServer(options);
	let buffer = "";
	for await (const chunk of process.stdin) {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				const request = JSON.parse(line) as JsonRpcRequest;
				if (request.id !== undefined && request.id !== null) {
					const response = await server.handleJsonRpc(request);
					process.stdout.write(`${JSON.stringify(response)}\n`);
				}
			}
			newline = buffer.indexOf("\n");
		}
	}
}
