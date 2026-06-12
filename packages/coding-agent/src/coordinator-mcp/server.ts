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
		state?: "queued" | "tmux_keys_sent" | "acknowledged" | "unavailable";
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

const MISSING_FINAL_RESPONSE_ADVISORY = "completion_missing_final_response";
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
					timeout_ms: { type: "number" },
					poll_interval_ms: { type: "number" },
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
	return { name, description: "List known scoped GJC coordinator bridge sessions.", inputSchema: common };
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

async function writeTurnRecord(namespaceDir: string, turn: TurnRecord): Promise<void> {
	await writeJsonFile(turnFile(namespaceDir, turn.turn_id), turn);
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

function boundedTimeoutMs(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 1000;
	return Math.min(parsed, 30_000);
}

function boundedPollIntervalMs(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 100;
	return Math.min(Math.max(parsed, 10), 1000);
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
	const sent = await runner(["tmux", "send-keys", "-t", target, prompt, "C-m", "C-m"]);
	return sent.exitCode === 0;
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
	const config = buildCoordinatorMcpConfig(options.env ?? process.env);
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
		const runtimeStateAlreadySettled =
			sessionState?.current_turn_id === activeTurn.turn_id &&
			(sessionState.state === "completed" || sessionState.state === "errored");
		if (!runtimeStateAlreadySettled) {
			await writeSessionState(namespaceDir, activeTurn.session_id, tmuxKeysSent ? "running" : "stale", {
				currentTurnId: activeTurn.turn_id,
				live,
				reason: tmuxKeysSent ? null : "tmux_delivery_unavailable",
			});
		}
		return activeTurn;
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
		if (
			sessionState &&
			ACTIVE_TURN_STATUSES.has(turn.status) &&
			sessionState.current_turn_id === turn.turn_id &&
			(sessionState.state === "completed" || sessionState.state === "errored")
		) {
			resolvedTurn = await markTurnTerminalFromSessionState(namespaceDir, turn, sessionState);
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (
			sessionState &&
			ACTIVE_TURN_STATUSES.has(turn.status) &&
			sessionState.current_turn_id === turn.turn_id &&
			sessionState.state === "stale" &&
			sessionState.reason === "tmux_delivery_unavailable" &&
			turn.delivery.state === "unavailable" &&
			session &&
			hasTmuxIdentity(session)
		) {
			resolvedTurn = await markTurnFailedForUnavailableSession(namespaceDir, turn, "tmux_delivery_unavailable");
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (!session && ACTIVE_TURN_STATUSES.has(turn.status)) {
			resolvedTurn = await markTurnFailedForUnavailableSession(namespaceDir, turn, "session_record_missing");
			sessionState = await readSessionState(namespaceDir, resolvedTurn.session_id);
		} else if (session) {
			advisoryStatus = await inspectTmuxSession(session, boundedLineCount(lines), commandRunner);
			if (ACTIVE_TURN_STATUSES.has(turn.status) && hasTmuxIdentity(session) && advisoryStatus.live === false) {
				resolvedTurn = await markTurnFailedForUnavailableSession(namespaceDir, turn, "tmux_session_missing");
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
				return {
					ok: true,
					session: registered.session,
					session_state: registered.sessionState,
					registered: true,
				};
			}
			if (name === "gjc_coordinator_read_status") {
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
			if (name === "gjc_coordinator_read_coordination_status")
				return { ok: true, reports: await listJsonFiles(path.join(namespaceDir, "reports")) };
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
				const timeoutMs = boundedTimeoutMs(args.timeout_ms);
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
				await writeJsonFile(path.join(namespaceDir, "reports", `${Date.now()}.json`), report);
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
