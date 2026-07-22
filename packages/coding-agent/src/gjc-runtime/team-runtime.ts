import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir } from "@gajae-code/utils/dirs";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import { buildTeamHudSummary as buildWorkflowTeamHudSummary } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import type { GcPidProbe, GcRecord } from "./gc-runtime";
import { applyGjcTmuxProfile } from "./launch-tmux";
import { modeStatePath, sessionIdFromDirName, sessionReportsDir, teamStateRoot } from "./session-layout";
import { resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import {
	AlreadyExistsError,
	appendJsonl as appendJsonlAudited,
	appendText,
	createJsonNoClobber,
	removeFileAudited,
	writeJsonAtomic,
	writeReport,
	writeWorkflowEnvelopeAtomic,
} from "./state-writer";
import { buildWorkerCommand, startGjcTeamLaunch } from "./team-launch";
import {
	listTeamMailbox,
	markTeamMailboxMessage,
	reconcileTeamNotifications,
	replayTeamNotifications,
	sendTeamMessage,
	summarizeTeamNotifications,
	type TeamNotificationRuntime,
} from "./team-notify";
import type {
	GjcTeamApiClaimResult,
	GjcTeamMailboxDeliveryTransport,
	GjcTeamNotification,
	GjcTeamNotificationDeliveryState,
	GjcTeamNotificationSummary,
	GjcTeamPaneAttemptResult,
	GjcTeamTask,
	GjcTeamTaskClaim,
	GjcTeamTaskMetadataInput,
	GjcTeamTaskMutationCapability,
	GjcTeamTaskStatus,
} from "./team-store";
import {
	GjcTeamTaskStore,
	isCanonicalPersistedGjcTeamTask,
	isCanonicalPersistedGjcTeamTaskClaim,
	isGjcTeamTaskCompletionVerified,
	readGjcTeamTasksFromDir as readTasks,
	taskMetadataFromInput,
	withGjcTeamMutationFence,
	withGjcTeamTaskMutation,
} from "./team-store";

import {
	GJC_TEAM_CONTINUATION_PROMPT,
	type GjcTeamWorkerOrchestrationRuntime,
	type GjcTeamWorkerRuntime,
	gjcContinuationReservationDigest,
	isValidGjcContinuationOutcome,
	isValidGjcContinuationReservation,
	readGjcShutdownAuthority,
	readWorkerLifecycleById as readLifecycleById,
	readGjcShutdownAck as readShutdownAck,
	readGjcWorkerHeartbeat as readWorkerHeartbeat,
	readGjcWorkerStatus as readWorkerStatus,
	reconcileGjcTeamStaleClaimsUnlocked,
	shutdownGjcTeamWorkers,
	updateGjcWorkerHeartbeat as updateWorkerHeartbeat,
	updateGjcWorkerStatus as updateWorkerStatus,
	writeWorkerLifecycleForConfig as writeLifecycleForConfig,
	writeGjcShutdownRequest as writeShutdownRequest,
	writeGjcWorkerStartupAck as writeWorkerStartupAck,
} from "./team-workers";

import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxUntaggedSessionHint,
	GJC_TMUX_ACTIVE_SESSION_ENV,
	GJC_TMUX_PROFILE_OPTION,
	GJC_TMUX_PROFILE_VALUE,
	resolveGjcTmuxBinary,
	resolveGjcTmuxCommand,
} from "./tmux-common";

export type {
	GjcTeamApiClaimResult,
	GjcTeamMailboxDeliveryInput,
	GjcTeamMailboxDeliveryResult,
	GjcTeamMailboxDeliveryTransport,
	GjcTeamMailboxDeliveryTransportKind,
	GjcTeamNotification,
	GjcTeamNotificationDeliveryState,
	GjcTeamNotificationSummary,
	GjcTeamPaneAttemptResult,
	GjcTeamTask,
	GjcTeamTaskClaim,
	GjcTeamTaskMetadataInput,
	GjcTeamTaskStatus,
} from "./team-store";

export const GJC_TEAM_DEFAULT_WORKERS = 3;
export const GJC_TEAM_MAX_WORKERS = 20;
const GJC_TEAM_WORKER_CLI_ENV = "GJC_TEAM_WORKER_CLI";
const GJC_TEAM_WORKER_CLI_MAP_ENV = "GJC_TEAM_WORKER_CLI_MAP";

export type GjcTeamWorkerCli = "gjc";
type GjcTeamWorkerCliMode = "auto" | GjcTeamWorkerCli;

export interface GjcTeamLeader {
	session_id: string;
	pane_id: string;
	cwd: string;
}

export interface GjcTeamWorker {
	id: string;
	name: string;
	index: number;
	agent_type: string;
	role: string;
	pane_id?: string;
	status: "starting" | "idle" | "busy" | "stopped";
	last_heartbeat: string;
	assigned_tasks: string[];
	worktree_repo_root?: string;
	worktree_path?: string;
	worktree_branch?: string | null;
	worktree_detached?: boolean;
	worktree_created?: boolean;
	worktree_base_ref?: string;
	team_state_root?: string;
}
export type GjcTeamPhase = "starting" | "running" | "awaiting_integration" | "complete" | "failed" | "cancelled";
export type GjcWorkerStatusState = "idle" | "working" | "blocked" | "done" | "failed" | "draining" | "unknown";
export type GjcTeamWorkerLifecycleState =
	| "starting"
	| "ready"
	| "working"
	| "draining"
	| "stopped"
	| "failed"
	| "unknown";
export type GjcTeamShutdownMode = "graceful" | "force" | "abort";

export type GjcTeamWorktreeMode =
	| { enabled: false }
	| { enabled: true; detached: true; name: null }
	| { enabled: true; detached: false; name: string };

export interface GjcTeamConfig {
	team_name: string;
	display_name: string;
	requested_name: string;
	task: string;
	agent_type: string;
	worker_count: number;
	max_workers: number;
	state_root: string;
	gjc_session_id?: string;
	worker_command: string;
	worker_cli_plan: GjcTeamWorkerCli[];
	tmux_command: string;
	tmux_session: string;
	tmux_session_name: string;
	tmux_target: string;
	workspace_mode: "direct" | "worktree";
	dry_run: boolean;
	leader: GjcTeamLeader;
	leader_cwd: string;
	team_state_root: string;
	workers: GjcTeamWorker[];
	created_at: string;
	updated_at: string;
}

export type GjcTeamIntegrationStatus =
	| "idle"
	| "integrated"
	| "integration_failed"
	| "merge_conflict"
	| "cherry_pick_conflict"
	| "rebase_conflict";

export interface GjcTeamWorkerIntegrationState {
	last_seen_head?: string;
	last_integrated_head?: string;
	last_leader_head?: string;
	last_rebased_leader_head?: string;
	status?: GjcTeamIntegrationStatus;
	conflict_commit?: string;
	conflict_files?: string[];
	updated_at?: string;
}

export interface GjcTeamMonitorSnapshot {
	integration_by_worker: Record<string, GjcTeamWorkerIntegrationState>;
	updated_at: string;
}
export interface GjcTeamWorkerLifecycle {
	worker: string;
	lifecycle_state: GjcTeamWorkerLifecycleState;
	worker_status_state: GjcWorkerStatusState;
	pane_id?: string;
	pid?: number;
	started_at?: string;
	updated_at: string;
	stopped_at?: string;
	stop_reason?: string;
	shutdown_request_id?: string;
	shutdown_requested_at?: string;
	shutdown_acknowledged_at?: string;
	shutdown_ack_status?: string;
	shutdown_mode?: GjcTeamShutdownMode;
}

export interface GjcTeamSnapshot {
	team_name: string;
	display_name: string;
	phase: GjcTeamPhase;
	state_dir: string;
	tmux_session: string;
	tmux_session_name: string;
	tmux_target: string;
	task_total: number;
	task_counts: Record<GjcTeamTaskStatus, number>;
	workers: GjcTeamWorker[];
	integration_by_worker?: Record<string, GjcTeamWorkerIntegrationState>;
	worker_lifecycle_by_id: Record<string, GjcTeamWorkerLifecycle>;
	notification_summary: GjcTeamNotificationSummary;
	updated_at: string;
}
export interface GjcTeamSnapshotOptions {
	reconcileNotifications?: boolean;
}

export interface GjcTeamStartOptions {
	workerCount: number;
	agentType: string;
	task: string;
	teamName?: string;
	worktreeMode?: GjcTeamWorktreeMode;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	dryRun?: boolean;
	platform?: NodeJS.Platform;
	mailboxDeliveryTransport?: GjcTeamMailboxDeliveryTransport;
}

export type GjcTeamLivenessRecoveryReason =
	| "claim_expired"
	| "stale_heartbeat"
	| "missing_pane"
	| "worker_lifecycle_failed"
	| "worker_lifecycle_stopped";

export interface GjcTeamRecoveredClaim {
	task_id: string;
	worker: string;
	reasons: GjcTeamLivenessRecoveryReason[];
}

export interface GjcTeamLivenessRecoveryResult {
	recovered_claims: GjcTeamRecoveredClaim[];
	stale_workers: Record<string, GjcTeamLivenessRecoveryReason[]>;
}

export interface GjcTeamMailboxMessage {
	message_id: string;
	from_worker: string;
	to_worker: string;
	body: string;
	created_at: string;
	delivered_at?: string;
	notified_at?: string;
	idempotency_key?: string;
}

function taskReceiptFields(teamName: string, task: GjcTeamTask): Record<string, unknown> {
	return {
		team_name: teamName,
		task_id: task.id,
		status: task.status,
		owner: task.owner,
		worker_id: task.claim?.owner ?? task.owner ?? task.assignee,
	};
}

function mailboxMessageReceiptFields(teamName: string, message: GjcTeamMailboxMessage): Record<string, unknown> {
	return {
		team_name: teamName,
		message_id: message.message_id,
		from_worker: message.from_worker,
		to_worker: message.to_worker,
		delivered: Boolean(message.delivered_at),
		notified: Boolean(message.notified_at),
		delivered_at: message.delivered_at,
		notified_at: message.notified_at,
	};
}

function notificationReceiptFields(notification: GjcTeamNotification): Record<string, unknown> {
	return {
		team_name: notification.team_name,
		notification_id: notification.id,
		recipient: notification.recipient,
		source_type: notification.source.type,
		source_id: notification.source.id,
		delivery_state: notification.delivery_state,
		pane_attempt_result: notification.pane_attempt_result,
		pane_attempt_reason: notification.pane_attempt_reason,
		replay_count: notification.replay_count,
	};
}

function notificationSummaryReceipt(
	teamName: string,
	result: {
		notifications: GjcTeamNotification[];
		summary: GjcTeamNotificationSummary;
	},
): Record<string, unknown> {
	return {
		team_name: teamName,
		notification_ids: result.notifications.map(notification => notification.id),
		delivery_states: result.notifications.map(notification => notification.delivery_state),
		summary: result.summary,
	};
}

interface FsError {
	code?: string;
}

function normalizeGjcTeamWorkerCliMode(
	raw: string | undefined,
	sourceEnv = GJC_TEAM_WORKER_CLI_ENV,
): GjcTeamWorkerCliMode {
	const normalized = String(raw ?? "auto")
		.trim()
		.toLowerCase();
	if (normalized === "" || normalized === "auto") return "auto";
	if (normalized === "gjc") return "gjc";
	if (normalized === "codex" || normalized === "claude" || normalized === "gemini") {
		throw new Error(`Unsupported ${sourceEnv} value "${raw}". GJC team launches GJC teammate sessions only.`);
	}
	throw new Error(`Invalid ${sourceEnv} value "${raw}". Expected: auto or gjc`);
}

export function resolveGjcTeamWorkerCli(env: NodeJS.ProcessEnv = process.env): GjcTeamWorkerCli {
	const mode = normalizeGjcTeamWorkerCliMode(env[GJC_TEAM_WORKER_CLI_ENV]);
	return mode === "auto" ? "gjc" : mode;
}

export function resolveGjcTeamWorkerCliPlan(
	workerCount: number,
	env: NodeJS.ProcessEnv = process.env,
): GjcTeamWorkerCli[] {
	if (!Number.isInteger(workerCount) || workerCount < 1) {
		throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
	}
	normalizeGjcTeamWorkerCliMode(env[GJC_TEAM_WORKER_CLI_ENV]);
	const rawMap = String(env[GJC_TEAM_WORKER_CLI_MAP_ENV] ?? "").trim();
	if (rawMap === "") {
		const cli = resolveGjcTeamWorkerCli(env);
		return Array.from({ length: workerCount }, () => cli);
	}
	const entries = rawMap.split(",").map(entry => entry.trim());
	if (entries.length === 0 || entries.every(entry => entry.length === 0)) {
		throw new Error(
			`Invalid ${GJC_TEAM_WORKER_CLI_MAP_ENV} value "${env[GJC_TEAM_WORKER_CLI_MAP_ENV]}". Expected: auto or gjc`,
		);
	}
	if (entries.some(entry => entry.length === 0)) {
		throw new Error(
			`Invalid ${GJC_TEAM_WORKER_CLI_MAP_ENV} value "${env[GJC_TEAM_WORKER_CLI_MAP_ENV]}". Empty entries are not allowed.`,
		);
	}
	if (entries.length !== 1 && entries.length !== workerCount) {
		throw new Error(
			`Invalid ${GJC_TEAM_WORKER_CLI_MAP_ENV} length ${entries.length}; expected 1 or ${workerCount} comma-separated values.`,
		);
	}
	const expanded = entries.length === 1 ? Array.from({ length: workerCount }, () => entries[0] ?? "") : entries;
	return expanded.map(entry => {
		const mode = normalizeGjcTeamWorkerCliMode(entry, GJC_TEAM_WORKER_CLI_MAP_ENV);
		return mode === "auto" ? "gjc" : mode;
	});
}

export function translateGjcWorkerLaunchArgsForCli(workerCli: GjcTeamWorkerCli, args: string[]): string[] {
	if (workerCli !== "gjc") {
		throw new Error(`Unsupported team worker CLI "${workerCli}". GJC team launches GJC teammate sessions only.`);
	}
	return [...args];
}

interface GjcTmuxLeaderContext {
	sessionName: string;
	windowIndex: string;
	leaderPaneId: string;
	target: string;
}
export interface GjcTeamEvent {
	event_id: string;
	ts: string;
	type: string;
	worker?: string;
	task_id?: string;
	message?: string;
	data?: Record<string, unknown>;
}
export interface GjcTeamTraceEvent {
	schema_version: 1;
	trace_id: string;
	span_id: string;
	source_event_id: string;
	event_type: string;
	ts: string;
	worker?: string;
	task_id?: string;
	message?: string;
	evidence_refs?: string[];
	data?: Record<string, unknown>;
}
export interface WorkerStatusFile {
	state: GjcWorkerStatusState;
	current_task_id?: string;
	reason?: string;
	updated_at: string;
}
export interface WorkerHeartbeatFile {
	pid: number;
	last_turn_at: string;
	turn_count: number;
	alive: boolean;
}
interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}
interface GjcTeamCommitHygieneEntry {
	recorded_at: string;
	operation:
		| "auto_checkpoint"
		| "leader_integration_attempt"
		| "integration_merge"
		| "integration_cherry_pick"
		| "cross_rebase";
	worker_name: string;
	task_id?: string;
	status: "applied" | "skipped" | "conflict" | "failed";
	operational_commit?: string | null;
	source_commit?: string;
	leader_head_before?: string;
	leader_head_after?: string | null;
	worker_head_before?: string | null;
	worker_head_after?: string | null;
	worktree_path?: string;
	detail: string;
}

interface GjcWorkerIntegrationDedupeState {
	last_requested_fingerprint?: string;
	last_requested_head?: string | null;
	last_requested_status?: GjcWorkerCheckpointClassification["kind"];
	last_requested_at?: string;
}

export interface GjcWorkerIntegrationAttemptRequestResult {
	requested: boolean;
	reason: "requested" | "not_worker" | "missing_worktree" | "no_changes" | "deduped" | "git_error";
	worker?: string;
	team_name?: string;
	fingerprint?: string;
	head?: string | null;
	status?: GjcWorkerCheckpointClassification["kind"];
}

export interface GjcWorkerIntegrationAttemptOptions {
	signal?: AbortSignal;
}

function isGjcTeamTaskStatus(value: string): value is GjcTeamTaskStatus {
	return ["pending", "blocked", "in_progress", "completed", "failed"].includes(value);
}

function parseGjcTeamTaskStatus(value: unknown, allowLegacyComplete = false): GjcTeamTaskStatus {
	const raw = typeof value === "string" ? value.trim() : "";
	if (allowLegacyComplete && raw === "complete") return "completed";
	if (isGjcTeamTaskStatus(raw)) return raw;
	throw new Error(`invalid_task_status:${raw}`);
}

export const GJC_TEAM_API_OPERATIONS = [
	"send-message",
	"broadcast",
	"mailbox-list",
	"mailbox-mark-delivered",
	"mailbox-mark-notified",
	"notification-list",
	"notification-read",
	"notification-replay",
	"notification-mark-pane-attempt",
	"worker-startup-ack",
	"create-task",
	"read-task",
	"list-tasks",
	"update-task",
	"claim-task",
	"transition-task-status",
	"transition-task",
	"release-task-claim",
	"read-config",
	"read-manifest",
	"read-worker-status",
	"update-worker-status",
	"read-worker-heartbeat",
	"recover-stale-claims",
	"update-worker-heartbeat",
	"write-worker-inbox",
	"write-worker-identity",
	"append-event",
	"read-events",
	"read-traces",
	"await-event",
	"write-shutdown-request",
	"read-shutdown-ack",
	"read-monitor-snapshot",
	"write-monitor-snapshot",
	"read-task-approval",
	"write-task-approval",
] as const;

function currentTimeMs(): number {
	return gjcTeamRuntimeTestSeams?.nowMs?.() ?? Date.now();
}

function now(): string {
	return new Date(currentTimeMs()).toISOString();
}

export interface GjcTeamRuntimeTestSeams {
	nowMs?: () => number;
	continuationTmuxDispatch?: (command: string, args: readonly string[]) => { exitCode?: number };

	continuationBeforeDispatch?: () => Promise<void>;
}

let gjcTeamRuntimeTestSeams: GjcTeamRuntimeTestSeams | undefined;

/** @internal Test-only seam; production code leaves the real clock and tmux dispatch intact. */
export function __setGjcTeamRuntimeTestSeamsForTests(seams: GjcTeamRuntimeTestSeams | undefined): void {
	gjcTeamRuntimeTestSeams = seams;
}

function isEnoent(error: unknown): error is FsError {
	return typeof error === "object" && error !== null && "code" in error && (error as FsError).code === "ENOENT";
}
function stateWriterOptions(filePath: string, category: "state" | "ledger" | "report" | "prune", verb: string) {
	const resolved = path.resolve(filePath);
	const marker = `${path.sep}.gjc${path.sep}`;
	const markerIndex = resolved.indexOf(marker);
	const cwd = markerIndex >= 0 ? resolved.slice(0, markerIndex) : process.cwd();
	const parts = resolved.split(path.sep);
	const sessionId =
		parts.map(part => sessionIdFromDirName(part)).find((value): value is string => Boolean(value)) ??
		process.env.GJC_SESSION_ID?.trim();
	// Session-scoped audit requires a GJC session. When an explicit env-root override
	// (e.g. GJC_TEAM_STATE_ROOT) is in effect with no resolvable session, omit the audit
	// context entirely so the override write does not fail on a session-scoped audit.
	return sessionId
		? {
				cwd,
				audit: { category, verb, owner: "gjc-runtime" as const, sessionId },
			}
		: { cwd };
}

function sanitizeName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");
	return sanitized || "team";
}
function shortHash(value: string): string {
	return Bun.hash(value).toString(16).slice(0, 8).padStart(8, "0");
}

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
function makeTeamName(task: string, env: NodeJS.ProcessEnv): string {
	const basis = [task, env.GJC_SESSION_ID, env.CODEX_SESSION_ID, env.TMUX_PANE, env.TMUX, now()]
		.filter(Boolean)
		.join(":");
	const prefix = sanitizeName(task).slice(0, 30).replace(/-$/, "") || "team";
	return `${prefix}-${shortHash(basis)}`;
}
function teamDir(stateRoot: string, teamName: string): string {
	return path.join(stateRoot, sanitizeName(teamName));
}
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * PowerShell-safe single-quote escape: doubles single quotes inside a
 * single-quoted PowerShell literal ('it''s ok') and uses the same
 * surrounding quotes. Used to build worker command strings that psmux
 * will hand to a Windows ConPTY pane running PowerShell.
 */
function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
function safePathSegment(kind: string, value: string): string {
	assertSafeId(kind, value);
	return value;
}
function mailboxPath(dir: string, worker: string): string {
	return path.join(dir, "mailbox", `${safePathSegment("worker_id", worker)}.json`);
}
function mailboxDirPath(dir: string, worker: string): string {
	return path.join(dir, "mailbox", safePathSegment("worker_id", worker));
}
function mailboxMessagePath(dir: string, worker: string, messageId: string): string {
	return path.join(mailboxDirPath(dir, worker), `${safePathSegment("message_id", messageId)}.json`);
}
function notificationPath(dir: string, notificationId: string): string {
	return path.join(dir, "notifications", `${safePathSegment("notification_id", notificationId)}.json`);
}
function workerDir(dir: string, worker: string): string {
	return path.join(dir, "workers", safePathSegment("worker_id", worker));
}
function workerLifecyclePath(dir: string, worker: string): string {
	return path.join(workerDir(dir, worker), "lifecycle.json");
}

function tracePath(dir: string): string {
	return path.join(dir, "trace.jsonl");
}

function traceErrorPath(dir: string): string {
	return path.join(dir, "trace-errors.jsonl");
}
function isSafeId(value: string): boolean {
	return (
		/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) &&
		!value.includes("..") &&
		!value.includes("/") &&
		!value.includes("\\")
	);
}
function assertSafeId(kind: string, value: string): void {
	if (!isSafeId(value)) throw new Error(`invalid_${kind}:${value}`);
}
function isLeaderRecipient(value: string): boolean {
	return value === "leader-fixed";
}
function assertKnownWorker(config: GjcTeamConfig, worker: string, allowLeader = false): void {
	assertSafeId("worker_id", worker);
	if (allowLeader && isLeaderRecipient(worker)) return;
	if (!config.workers.some(candidate => candidate.id === worker)) throw new Error(`unknown_worker:${worker}`);
}
function findKnownWorker(config: GjcTeamConfig, worker: string): GjcTeamWorker {
	assertKnownWorker(config, worker);
	const found = config.workers.find(candidate => candidate.id === worker);
	if (!found) throw new Error(`unknown_worker:${worker}`);
	return found;
}
function assertKnownParticipant(config: GjcTeamConfig, worker: string): void {
	assertKnownWorker(config, worker, true);
}
function messageNotificationId(teamName: string, recipient: string, messageId: string): string {
	return `ntf-${stableHash(["mailbox_message", teamName, recipient, messageId].join(":"))}`;
}
function messageIdFor(input: {
	teamName: string;
	fromWorker: string;
	toWorker: string;
	body: string;
	idempotencyKey?: string;
	createdKey: string;
}): string {
	return `msg-${stableHash([input.teamName, input.fromWorker, input.toWorker, input.idempotencyKey ?? input.body, input.createdKey].join(":"))}`;
}
function workerIntegrationDedupePath(dir: string, worker: string): string {
	return path.join(workerDir(dir, worker), "posttooluse-dedupe.json");
}

export function resolveGjcTeamStateRoot(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GJC_TEAM_STATE_ROOT?.trim();
	if (explicit) return path.resolve(cwd, explicit);
	const session = resolveGjcSessionForWrite(cwd, {
		envSessionId: env.GJC_SESSION_ID,
	});
	return teamStateRoot(cwd, session.gjcSessionId);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readContinuationJson<T>(filePath: string): Promise<T | null> {
	try {
		return await readJsonFile<T>(filePath);
	} catch {
		return null;
	}
}
type GjcContinuationAuthorityInventory =
	| { valid: true; tasks: GjcTeamTask[]; claims: Map<string, GjcTeamTaskClaim> }
	| { valid: false };

async function readGjcContinuationAuthorityInventory(dir: string): Promise<GjcContinuationAuthorityInventory> {
	let taskNames: string[];
	try {
		taskNames = (await fs.readdir(path.join(dir, "tasks"), { withFileTypes: true }))
			.filter(entry => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".evidence.json"))
			.map(entry => entry.name);
	} catch {
		return { valid: false };
	}
	const tasks: GjcTeamTask[] = [];
	const taskIds = new Set<string>();
	for (const name of taskNames) {
		const id = name.slice(0, -".json".length);
		try {
			const task = await Bun.file(path.join(dir, "tasks", name)).json();
			if (!isCanonicalPersistedGjcTeamTask(task, id) || taskIds.has(task.id)) return { valid: false };
			taskIds.add(task.id);
			tasks.push(task);
		} catch {
			return { valid: false };
		}
	}
	let claimNames: string[];
	try {
		claimNames = (await fs.readdir(path.join(dir, "claims"), { withFileTypes: true }))
			.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
			.map(entry => entry.name);
	} catch (error) {
		if (!isEnoent(error)) return { valid: false };
		claimNames = [];
	}
	const claims = new Map<string, GjcTeamTaskClaim>();
	for (const name of claimNames) {
		const id = name.slice(0, -".json".length);
		if (!taskIds.has(id) || claims.has(id)) return { valid: false };
		try {
			const claim = await Bun.file(path.join(dir, "claims", name)).json();
			if (!isCanonicalPersistedGjcTeamTaskClaim(claim)) return { valid: false };
			claims.set(id, claim);
		} catch {
			return { valid: false };
		}
	}
	for (const task of tasks) {
		const claim = claims.get(task.id);
		if ((task.claim === undefined) !== (claim === undefined)) return { valid: false };
		if (
			task.claim !== undefined &&
			(!claim ||
				claim.owner !== task.claim.owner ||
				claim.token !== task.claim.token ||
				claim.leased_until !== task.claim.leased_until)
		)
			return { valid: false };
	}
	return { valid: true, tasks, claims };
}

type GjcContinuationWorkerAuthority =
	| { valid: true; task: GjcTeamTask & { claim: GjcTeamTaskClaim }; claim: GjcTeamTaskClaim }
	| { valid: false; taskCount: number; claimCount: number };

function selectGjcContinuationWorkerAuthority(
	inventory: Extract<GjcContinuationAuthorityInventory, { valid: true }>,
	worker: string,
): GjcContinuationWorkerAuthority {
	const tasks = inventory.tasks.filter(
		task =>
			task.status === "in_progress" &&
			task.claim?.owner === worker &&
			task.assignee === worker &&
			task.owner === worker,
	);
	const claims = [...inventory.claims.entries()]
		.filter(([, claim]) => claim.owner === worker)
		.map(([taskId, claim]) => ({ taskId, claim }));
	if (tasks.length !== 1 || claims.length !== 1)
		return { valid: false, taskCount: tasks.length, claimCount: claims.length };
	const task = tasks[0];
	const stored = claims[0];
	if (
		!task?.claim ||
		!stored ||
		stored.taskId !== task.id ||
		stored.claim.owner !== task.claim.owner ||
		stored.claim.token !== task.claim.token ||
		stored.claim.leased_until !== task.claim.leased_until
	)
		return { valid: false, taskCount: tasks.length, claimCount: claims.length };
	return { valid: true, task: { ...task, claim: task.claim }, claim: stored.claim };
}

function isPositivePid(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function collectTeamGcWorkerPids(
	heartbeat: WorkerHeartbeatFile | null,
	lifecycle: GjcTeamWorkerLifecycle | null,
): number[] {
	const pids: number[] = [];
	if (isPositivePid(heartbeat?.pid)) pids.push(heartbeat.pid);
	if (isPositivePid(lifecycle?.pid) && !pids.includes(lifecycle.pid)) pids.push(lifecycle.pid);
	return pids;
}

interface TeamGcPidClassification {
	removable: boolean;
	pidStatus: "dead" | "alive" | "eperm" | "unknown" | "none";
	pid?: number;
}

/**
 * Liveness-only, fail-closed: a worker is removable ONLY when it has at least
 * one authoritative pid and EVERY candidate pid probes dead (ESRCH). Any alive,
 * EPERM, or unknown candidate (heartbeat OR lifecycle) keeps the worker, so a
 * dead heartbeat pid can never override a live lifecycle pid.
 */
function classifyTeamGcWorkerPids(pids: number[], probe: GcPidProbe): TeamGcPidClassification {
	if (pids.length === 0) return { removable: false, pidStatus: "none" };
	const statuses = pids.map(pid => ({
		pid,
		status: gcProbeStatus(probe, pid),
	}));
	const kept = statuses.find(entry => entry.status !== "dead");
	if (kept) return { removable: false, pidStatus: kept.status, pid: kept.pid };
	return { removable: true, pidStatus: "dead", pid: statuses[0]?.pid };
}

function gcProbeStatus(probe: GcPidProbe, pid: number): "dead" | "alive" | "eperm" | "unknown" {
	const result = probe(pid);
	if (result.status === "dead") return "dead";
	return result.reason ?? "unknown";
}

function teamGcRecordDetail(heartbeat: WorkerHeartbeatFile | null, lifecycle: GjcTeamWorkerLifecycle | null): string {
	return [
		`heartbeat=${heartbeat ? "present" : "missing"}`,
		...(heartbeat ? [`heartbeat_alive=${heartbeat.alive}`, `last_turn_at=${heartbeat.last_turn_at}`] : []),
		`lifecycle=${lifecycle?.lifecycle_state ?? "missing"}`,
		...(lifecycle?.pane_id ? [`pane_id=${lifecycle.pane_id}`] : []),
		...(lifecycle?.stop_reason ? [`stop_reason=${lifecycle.stop_reason}`] : []),
	].join(" ");
}

/** @internal */
export async function listTeamWorkerGcRecords(teamRoot: string, probe: GcPidProbe): Promise<GcRecord[]> {
	const teamEntries = await fs.readdir(teamRoot, { withFileTypes: true });
	const records: GcRecord[] = [];
	for (const teamEntry of teamEntries) {
		if (!teamEntry.isDirectory()) continue;
		const teamName = teamEntry.name;
		const teamDirPath = path.join(teamRoot, teamName);
		let workerEntries: import("node:fs").Dirent[];
		try {
			workerEntries = await fs.readdir(path.join(teamDirPath, "workers"), {
				withFileTypes: true,
			});
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}

		for (const workerEntry of workerEntries) {
			if (!workerEntry.isDirectory()) continue;
			const workerId = workerEntry.name;
			const dir = path.join(teamDirPath, "workers", workerId);
			let heartbeat: WorkerHeartbeatFile | null = null;
			let lifecycle: GjcTeamWorkerLifecycle | null = null;
			try {
				heartbeat = await readJsonFile<WorkerHeartbeatFile>(path.join(dir, "heartbeat.json"));
				lifecycle = await readJsonFile<GjcTeamWorkerLifecycle>(path.join(dir, "lifecycle.json"));
			} catch (error) {
				records.push({
					store: "team_workers",
					id: `${teamName}/${workerId}`,
					root: teamRoot,
					path: dir,
					pid_status: "none",
					status: "malformed",
					stale: false,
					removable: false,
					action: "none",
					reason: "worker_state_malformed_kept",
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const pids = collectTeamGcWorkerPids(heartbeat, lifecycle);
			const { removable, pidStatus, pid } = classifyTeamGcWorkerPids(pids, probe);
			const terminalLifecycle = lifecycle?.lifecycle_state === "failed" || lifecycle?.lifecycle_state === "stopped";
			const status = removable
				? "dead"
				: pidStatus === "none" && terminalLifecycle
					? "terminal_lifecycle"
					: pidStatus === "none"
						? "no_pid"
						: pidStatus;
			records.push({
				store: "team_workers",
				id: `${teamName}/${workerId}`,
				root: teamRoot,
				path: dir,
				pid,
				pid_status: pidStatus,
				status,
				stale: removable,
				removable,
				action: "none",
				reason: removable
					? "worker_all_pids_dead"
					: pidStatus === "none" && terminalLifecycle
						? "terminal_lifecycle_without_pid_kept"
						: pidStatus === "none"
							? "worker_pid_missing_kept"
							: `worker_pid_${pidStatus}_kept`,
				detail: teamGcRecordDetail(heartbeat, lifecycle),
			});
		}
	}
	return records;
}

/** @internal */
export async function pruneTeamWorkerGcRecord(record: GcRecord, probe: GcPidProbe): Promise<boolean> {
	if (!record.path || !record.id.includes("/")) return false;
	const teamDirPath = path.dirname(path.dirname(record.path));
	return withGjcTeamTaskMutation(taskStore(teamDirPath), capability =>
		pruneTeamWorkerGcRecordUnlocked(record, probe, capability),
	);
}

async function pruneTeamWorkerGcRecordUnlocked(
	record: GcRecord,
	probe: GcPidProbe,
	capability: GjcTeamTaskMutationCapability,
): Promise<boolean> {
	if (!record.path || !record.id.includes("/")) return false;
	const [teamName, workerId] = record.id.split("/", 2);
	if (!teamName || !workerId) return false;
	const teamDirPath = path.dirname(path.dirname(record.path));
	const heartbeat = await readJsonFile<WorkerHeartbeatFile>(path.join(record.path, "heartbeat.json"));
	const lifecycle = await readJsonFile<GjcTeamWorkerLifecycle>(path.join(record.path, "lifecycle.json"));
	const pids = collectTeamGcWorkerPids(heartbeat, lifecycle);
	if (!classifyTeamGcWorkerPids(pids, probe).removable) return false;

	const claimDir = path.join(teamDirPath, "claims");
	try {
		for (const entry of await fs.readdir(claimDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const claimPath = path.join(claimDir, entry.name);
			const claim = readClaimRecord(await readJsonFile<unknown>(claimPath));
			if (claim?.owner !== workerId) continue;
			await removeFileAudited(claimPath, stateWriterOptions(claimPath, "prune", "gc-team-worker"));
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	for (const task of await readTasks(teamDirPath)) {
		if (task.claim?.owner !== workerId && task.assignee !== workerId) continue;
		if (task.status === "completed" || task.status === "failed") continue;
		await capability.writeRecovered({
			...task,
			status: "pending",
			assignee: undefined,
			claim: undefined,
			version: task.version + 1,
			updated_at: now(),
		});
	}

	// Remove the stale worker record dir itself so a removable record always
	// results in an observable removal, even when it owns no claims/tasks.
	await fs.rm(record.path, { recursive: true, force: true });
	return true;
}
function stateCategoryForJsonPath(filePath: string): "state" | "ledger" {
	return filePath.endsWith(".jsonl") || filePath.includes(`${path.sep}telemetry${path.sep}`) ? "ledger" : "state";
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeJsonAtomic(filePath, value, stateWriterOptions(filePath, stateCategoryForJsonPath(filePath), "write"));
}
async function writeJsonFileNoClobber(filePath: string, value: unknown): Promise<boolean> {
	try {
		await createJsonNoClobber(
			filePath,
			value,
			stateWriterOptions(filePath, stateCategoryForJsonPath(filePath), "create"),
		);
		return true;
	} catch (error) {
		if (error instanceof AlreadyExistsError) return false;
		throw error;
	}
}
async function appendJsonl(filePath: string, value: unknown): Promise<void> {
	await appendJsonlAudited(filePath, value, stateWriterOptions(filePath, "ledger", "append"));
}
function traceIdForTeam(dir: string): string {
	return `trace-${stableHash(path.basename(dir))}`;
}

function evidenceRefsForEvent(event: GjcTeamEvent): string[] | undefined {
	const refs: string[] = [];
	if (event.task_id && event.type === "task_transitioned" && event.data && "completion_evidence" in event.data)
		refs.push(`task:${event.task_id}:completion_evidence`);
	if (event.task_id && event.type === "task_claim_recovered") refs.push(`task:${event.task_id}:claim_recovery`);
	if (event.worker && event.type.startsWith("worker_")) refs.push(`worker:${event.worker}`);
	return refs.length > 0 ? refs : undefined;
}
function pickString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function pickNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function pickBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
function pickStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}
function setIfDefined(record: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) record[key] = value;
}
function messageBodyTraceProjection(body: string | undefined): Record<string, unknown> {
	if (body === undefined) return {};
	return {
		body_byte_length: Buffer.byteLength(body, "utf8"),
		body_sha256: createHash("sha256").update(body).digest("hex"),
	};
}
function traceDataForEvent(event: GjcTeamEvent): Record<string, unknown> | undefined {
	const source = event.data ?? {};
	const data: Record<string, unknown> = {};
	switch (event.type) {
		case "message_sent": {
			setIfDefined(data, "to_worker", pickString(source.to_worker));
			setIfDefined(data, "message_id", pickString(source.message_id));
			Object.assign(data, messageBodyTraceProjection(pickString(event.message)));
			break;
		}
		case "message_acknowledged":
		case "message_notified": {
			setIfDefined(data, "message_id", pickString(event.message));
			break;
		}
		case "team_started": {
			setIfDefined(data, "worker_count", pickNumber(source.worker_count));
			setIfDefined(data, "agent_type", pickString(source.agent_type));
			setIfDefined(data, "workspace_mode", pickString(source.workspace_mode));
			setIfDefined(data, "dry_run", pickBoolean(source.dry_run));
			break;
		}
		case "task_claim_recovered": {
			setIfDefined(data, "reasons", pickStringArray(source.reasons));
			break;
		}
		case "task_transitioned": {
			setIfDefined(data, "status", pickString(source.status));
			const evidence = source.completion_evidence;
			if (typeof evidence === "object" && evidence !== null) {
				const evidenceRecord = evidence as Record<string, unknown>;
				data.completion_evidence = {
					recorded_by: pickString(evidenceRecord.recorded_by),
					item_count: pickNumber(evidenceRecord.item_count),
					verified_item_count: pickNumber(evidenceRecord.verified_item_count),
				};
			}
			break;
		}
		case "worker_integration_attempt_requested": {
			setIfDefined(data, "worker_name", pickString(source.worker_name));
			setIfDefined(data, "worker_head", pickString(source.worker_head));
			setIfDefined(data, "status", pickString(source.status));
			if (Array.isArray(source.files)) data.file_count = source.files.length;
			break;
		}
		case "worker_lifecycle_nudge": {
			setIfDefined(data, "condition", pickString(source.condition));
			setIfDefined(data, "severity", pickString(source.severity));
			setIfDefined(data, "fingerprint", pickString(source.fingerprint));
			setIfDefined(data, "auto_action_taken", pickBoolean(source.auto_action_taken));
			break;
		}
		case "team_shutdown": {
			setIfDefined(data, "phase", pickString(source.phase));
			setIfDefined(data, "shutdown_request_id", pickString(source.shutdown_request_id));
			setIfDefined(data, "graceful_shutdown_complete", pickBoolean(source.graceful_shutdown_complete));
			if (Array.isArray(source.evidence_failures)) data.evidence_failure_count = source.evidence_failures.length;
			break;
		}
		case "worker_status_updated": {
			setIfDefined(data, "status", pickString(source.status));
			setIfDefined(data, "current_task_id", pickString(source.current_task_id));
			break;
		}
		case "worker_shutdown_requested": {
			setIfDefined(data, "requested_by", pickString(source.requested_by));
			setIfDefined(data, "request_id", pickString(source.request_id));
			setIfDefined(data, "mode", pickString(source.mode));
			break;
		}
	}
	return Object.keys(data).length > 0 ? data : undefined;
}

async function appendTraceForEvent(dir: string, event: GjcTeamEvent): Promise<void> {
	const evidenceRefs = evidenceRefsForEvent(event);
	const traceData = traceDataForEvent(event);
	const trace: GjcTeamTraceEvent = {
		schema_version: 1,
		trace_id: traceIdForTeam(dir),
		span_id: `span-${stableHash(event.event_id)}`,
		source_event_id: event.event_id,
		event_type: event.type,
		ts: event.ts,
		...(event.worker ? { worker: event.worker } : {}),
		...(event.task_id ? { task_id: event.task_id } : {}),
		...(traceData ? { data: traceData } : {}),
		...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}),
	};
	try {
		await appendJsonl(tracePath(dir), trace);
	} catch (error) {
		try {
			await appendJsonl(traceErrorPath(dir), {
				ts: now(),
				source_event_id: event.event_id,
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// Trace append failure must not break legacy events.jsonl compatibility.
		}
	}
}
async function appendEvent(dir: string, event: Omit<GjcTeamEvent, "ts" | "event_id">): Promise<GjcTeamEvent> {
	const full = {
		event_id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		ts: now(),
		...event,
	};
	await appendJsonl(path.join(dir, "events.jsonl"), full);
	await appendTraceForEvent(dir, full);
	return full;
}
async function appendTelemetry(
	dir: string,
	event: { type: string; message: string; data?: Record<string, unknown> },
): Promise<void> {
	await appendJsonl(path.join(dir, "telemetry.jsonl"), { ts: now(), ...event });
}
async function readConfig(dir: string): Promise<GjcTeamConfig> {
	const config = await readJsonFile<GjcTeamConfig>(path.join(dir, "config.json"));
	if (!config) throw new Error(`team_config_not_found:${dir}`);
	const tmuxSessionName = config.tmux_session_name ?? config.tmux_session?.split(":")[0] ?? "";
	return {
		...config,
		max_workers: config.max_workers ?? GJC_TEAM_MAX_WORKERS,
		tmux_command: config.tmux_command ?? resolveGjcTmuxCommand(),
		tmux_session: tmuxSessionName,
		tmux_session_name: tmuxSessionName,
		tmux_target: config.tmux_target ?? config.tmux_session ?? tmuxSessionName,
		dry_run: config.dry_run ?? config.tmux_session_name === "dry-run",
		leader_cwd: config.leader_cwd ?? config.leader.cwd,
		team_state_root: config.team_state_root ?? config.state_root,
		worker_cli_plan: config.worker_cli_plan ?? Array.from({ length: config.worker_count }, () => "gjc"),
	};
}
const WORKER_INTEGRATION_CONFIG_CACHE_TTL_MS = 100;
type WorkerIntegrationConfigCacheEntry = {
	checkedAt: number;
	mtimeMs: number;
	config: GjcTeamConfig;
};
const workerIntegrationConfigCache = new Map<string, WorkerIntegrationConfigCacheEntry>();

async function readConfigForWorkerIntegration(dir: string): Promise<GjcTeamConfig> {
	const configPath = path.join(dir, "config.json");
	const nowMs = Date.now();
	const stat = await fs.stat(configPath);
	const cached = workerIntegrationConfigCache.get(configPath);
	if (cached && cached.mtimeMs === stat.mtimeMs && nowMs - cached.checkedAt <= WORKER_INTEGRATION_CONFIG_CACHE_TTL_MS)
		return cached.config;
	const config = await readConfig(dir);
	workerIntegrationConfigCache.set(configPath, {
		checkedAt: nowMs,
		mtimeMs: stat.mtimeMs,
		config,
	});

	return config;
}
async function readPhase(dir: string): Promise<GjcTeamPhase> {
	try {
		const phase = await readJsonFile<{ current_phase?: GjcTeamPhase }>(path.join(dir, "phase.json"));
		return phase?.current_phase ?? "running";
	} catch (error) {
		if (error instanceof SyntaxError) return "running";
		throw error;
	}
}
async function writePhase(dir: string, phase: GjcTeamPhase): Promise<void> {
	await writeJsonFile(path.join(dir, "phase.json"), {
		current_phase: phase,
		updated_at: now(),
	});
}
function isGjcWorkerStatusState(value: string): value is GjcWorkerStatusState {
	return ["idle", "working", "blocked", "done", "failed", "draining", "unknown"].includes(value);
}
function parseRequiredGjcWorkerStatusState(value: unknown): GjcWorkerStatusState {
	const raw = typeof value === "string" ? value.trim() : "";
	if (isGjcWorkerStatusState(raw)) return raw;
	throw new Error(`invalid_worker_status:${raw}`);
}
function parseGjcTeamShutdownMode(value: unknown): GjcTeamShutdownMode {
	const raw = typeof value === "string" ? value.trim() : "graceful";
	if (raw === "graceful" || raw === "force" || raw === "abort") return raw;
	throw new Error(`invalid_shutdown_mode:${raw}`);
}
const workerRuntime: GjcTeamWorkerRuntime = {
	findTeamDir,
	readConfig,
	assertKnownWorker,
	assertKnownParticipant,
	findKnownWorker,
	workerDir,
	readJson: readJsonFile,
	writeJson: writeJsonFile,
	appendEvent,
	now,
	nowMs: currentTimeMs,
	stableHash,
};

const readWorkerLifecycleById = (dir: string, config: GjcTeamConfig) => readLifecycleById(workerRuntime, dir, config);
const writeWorkerLifecycleForConfig = (
	dir: string,
	config: GjcTeamConfig,
	state: GjcTeamWorkerLifecycleState,
	updatesFor: (worker: GjcTeamWorker) => Partial<GjcTeamWorkerLifecycle> = () => ({}),
) => writeLifecycleForConfig(workerRuntime, dir, config, state, updatesFor);

const workerOrchestrationRuntime: GjcTeamWorkerOrchestrationRuntime = {
	...workerRuntime,
	readTasks,
	withTaskMutation: (dir, fn) => withGjcTeamTaskMutation(taskStore(dir), fn),
	appendTelemetry,
	paneBelongsToTeamTarget,
	parseDurationEnv,
	parseHeartbeatStaleMs,
	killWorkerPanes,
	removeCleanCreatedWorktrees,
	readMonitorSnapshot: dir => readJsonFile<GjcTeamMonitorSnapshot>(monitorSnapshotPath(dir)),
	hasPendingIntegration: hasPendingGjcTeamIntegration,
	writePhase,
	readSnapshot: readGjcTeamSnapshot,
};

function teamModeStatePath(cwd: string, sessionId: string): string {
	return modeStatePath(cwd, sessionId, "team");
}

export async function persistGjcTeamModeStateSummary(snapshot: GjcTeamSnapshot, cwd = process.cwd()): Promise<void> {
	const active = snapshot.phase !== "complete" && snapshot.phase !== "cancelled";
	const updatedAt = now();
	const sessionId = resolveGjcSessionForWrite(cwd, {
		envSessionId: process.env.GJC_SESSION_ID,
	}).gjcSessionId;
	const statePath = teamModeStatePath(cwd, sessionId);
	await writeWorkflowEnvelopeAtomic(
		statePath,
		{
			skill: "team",
			version: WORKFLOW_STATE_VERSION,
			active,
			current_phase: snapshot.phase,
			team_name: snapshot.team_name,
			task_counts: snapshot.task_counts,
			updated_at: updatedAt,
		},
		{
			cwd,
			receipt: {
				cwd,
				skill: "team",
				owner: "gjc-runtime",
				command: "gjc team sync-team-summary",
				sessionId,
				nowIso: updatedAt,
			},
			audit: {
				category: "state",
				verb: "sync-team-summary",
				owner: "gjc-runtime",
				skill: "team",
				sessionId,
			},
		},
	);
	await writeSessionActivityMarker(cwd, sessionId, {
		writer: "team-runtime",
		path: statePath,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}
function readClaimRecord(value: unknown): GjcTeamTaskClaim | undefined {
	if (!isRecord(value)) return undefined;
	const owner = typeof value.owner === "string" ? value.owner : "";
	const token = typeof value.token === "string" ? value.token : "";
	const leasedUntil = typeof value.leased_until === "string" ? value.leased_until : "";
	if (!owner || !token || !leasedUntil) return undefined;
	return { owner, token, leased_until: leasedUntil };
}

export async function recoverGjcTeamStaleClaims(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamLivenessRecoveryResult> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamTaskMutation(taskStore(dir), async capability => {
		const config = await readConfig(dir);
		return reconcileGjcTeamStaleClaimsUnlocked(workerOrchestrationRuntime, teamName, dir, config, env, capability);
	});
}
const GJC_TEAM_INTEGRATION_ATTENTION_STATUSES = new Set<GjcTeamIntegrationStatus>([
	"integration_failed",
	"merge_conflict",
	"cherry_pick_conflict",
	"rebase_conflict",
]);
const GJC_TEAM_INTEGRATION_SETTLED_STATUSES = new Set<GjcTeamIntegrationStatus>(["idle", "integrated"]);

async function hasPendingGjcTeamIntegration(
	dir: string,
	config: GjcTeamConfig,
	monitor: GjcTeamMonitorSnapshot | null,
): Promise<boolean> {
	for (const worker of config.workers) {
		const integration = monitor?.integration_by_worker?.[worker.id];
		if (integration?.status && GJC_TEAM_INTEGRATION_ATTENTION_STATUSES.has(integration.status)) return true;

		const request = await readJsonFile<GjcWorkerIntegrationDedupeState>(workerIntegrationDedupePath(dir, worker.id));
		if (!request?.last_requested_at) continue;
		if (!integration?.status || !integration.updated_at) return true;
		if (GJC_TEAM_INTEGRATION_ATTENTION_STATUSES.has(integration.status)) return true;
		if (
			GJC_TEAM_INTEGRATION_SETTLED_STATUSES.has(integration.status) &&
			integration.updated_at >= request.last_requested_at
		) {
			continue;
		}
		return true;
	}
	return false;
}

async function resolveGjcTeamSnapshotPhase(
	dir: string,
	config: GjcTeamConfig,
	storedPhase: GjcTeamPhase,
	tasks: GjcTeamTask[],
	monitor: GjcTeamMonitorSnapshot | null,
): Promise<GjcTeamPhase> {
	if (storedPhase !== "running") return storedPhase;
	if (tasks.length === 0 || !tasks.every(isGjcTeamTaskCompletionVerified)) return storedPhase;
	return (await hasPendingGjcTeamIntegration(dir, config, monitor)) ? "awaiting_integration" : storedPhase;
}

async function findTeamDir(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const root = resolveGjcTeamStateRoot(cwd, env);
	const exact = teamDir(root, teamName);
	if (await readJsonFile<GjcTeamConfig>(path.join(exact, "config.json"))) return exact;
	const candidates = await listGjcTeams(cwd, env);
	const input = sanitizeName(teamName);
	const matches = candidates.filter(
		candidate => candidate.team_name === input || sanitizeName(candidate.display_name) === input,
	);
	if (matches.length === 1) return matches[0].state_dir;
	if (matches.length > 1)
		throw new Error(`ambiguous_team_name:${teamName}:${matches.map(match => match.team_name).join(",")}`);
	throw new Error(`team_not_found:${teamName}`);
}
function buildWorkers(count: number, agentType: string, stateRoot?: string): GjcTeamWorker[] {
	return Array.from({ length: count }, (_, index) => {
		const id = `worker-${index + 1}`;
		return {
			id,
			name: id,
			index: index + 1,
			agent_type: agentType,
			role: agentType,
			status: "starting",
			last_heartbeat: now(),
			assigned_tasks: [],
			team_state_root: stateRoot,
		};
	});
}
function sanitizePathToken(value: string): string {
	return sanitizeName(value) || "default";
}
function runGitResult(cwd: string, args: string[]): GitResult {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}
async function runGitResultAsync(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
	const result = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const kill = () => {
		try {
			result.kill("SIGKILL");
		} catch {}
	};
	if (signal?.aborted) kill();
	else signal?.addEventListener("abort", kill, { once: true });
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			result.exited,
			new Response(result.stdout).text(),
			new Response(result.stderr).text(),
		]);
		return {
			ok: exitCode === 0 && !signal?.aborted,
			stdout: stdout.trim(),
			stderr: signal?.aborted ? "worker integration request aborted" : stderr.trim(),
		};
	} finally {
		signal?.removeEventListener("abort", kill);
	}
}
async function tryRunGitAsync(cwd: string, args: string[], signal?: AbortSignal): Promise<string | null> {
	const result = await runGitResultAsync(cwd, args, signal);
	return result.ok ? result.stdout : null;
}
function runGit(cwd: string, args: string[]): string {
	const result = runGitResult(cwd, args);
	if (result.ok) return result.stdout;
	throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}
function tryRunGit(cwd: string, args: string[]): string | null {
	const result = runGitResult(cwd, args);
	return result.ok ? result.stdout : null;
}
function isGitRepository(cwd: string): boolean {
	return tryRunGit(cwd, ["rev-parse", "--show-toplevel"]) != null;
}

function parseWorktreeMode(args: string[]): {
	mode: GjcTeamWorktreeMode;
	remainingArgs: string[];
} {
	let mode: GjcTeamWorktreeMode = { enabled: false };
	const remainingArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--worktree" || arg === "-w") {
			const next = args[index + 1];
			if (typeof next === "string" && next.length > 0 && !next.startsWith("-") && !next.includes(":")) {
				mode = { enabled: true, detached: false, name: next };
				index += 1;
			} else mode = { enabled: true, detached: true, name: null };
			continue;
		}
		if (arg.startsWith("--worktree=")) {
			const name = arg.slice("--worktree=".length).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		if (arg.startsWith("-w=") || (arg.startsWith("-w") && arg.length > 2)) {
			const name = arg.startsWith("-w=") ? arg.slice("-w=".length).trim() : arg.slice(2).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		remainingArgs.push(arg);
	}
	return { mode, remainingArgs };
}
function resolveDefaultWorktreeMode(mode?: GjcTeamWorktreeMode): GjcTeamWorktreeMode {
	return mode?.enabled ? mode : { enabled: true, detached: true, name: null };
}
function branchExists(repoRoot: string, branchName: string): boolean {
	return (
		Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "ignore",
		}).exitCode === 0
	);
}
function worktreeIsDirty(worktreePath: string): boolean {
	return runGit(worktreePath, ["status", "--porcelain"]).trim().length > 0;
}
function worktreeHead(worktreePath: string): string {
	return runGit(worktreePath, ["rev-parse", "HEAD"]);
}
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}
function findWorktreePath(repoRoot: string, worktreePath: string): string | null {
	const raw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	const resolved = path.resolve(worktreePath);
	for (const line of raw.split(/\r?\n/))
		if (line.startsWith("worktree ") && path.resolve(line.slice("worktree ".length)) === resolved) return resolved;
	return null;
}
export function resolveWorkerWorktreePath(input: {
	repoRoot: string;
	stateDir: string;
	teamName: string;
	workerId: string;
	platform: NodeJS.Platform;
	isPsmux: boolean;
}): string {
	if (input.platform === "win32" && input.isPsmux) {
		const slug = stableHash([input.repoRoot, input.stateDir, input.teamName].join("\0")).slice(0, 12);
		return path.join(getWorktreesDir(), `team-${slug}-${input.workerId}`);
	}
	return path.join(input.stateDir, "worktrees", input.workerId);
}
async function ensureWorkerWorktree(
	cwd: string,
	dir: string,
	teamName: string,
	worker: GjcTeamWorker,
	mode: GjcTeamWorktreeMode,
	platform: NodeJS.Platform,
	isPsmux: boolean,
): Promise<GjcTeamWorker> {
	if (!mode.enabled) return worker;
	if (!isGitRepository(cwd)) throw new Error(`team_worktree_requires_git_repo:${cwd}`);
	const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const baseRef = runGit(repoRoot, ["rev-parse", "HEAD"]);
	const worktreePath = resolveWorkerWorktreePath({
		repoRoot,
		stateDir: dir,
		teamName,
		workerId: worker.id,
		platform,
		isPsmux,
	});
	const existing = findWorktreePath(repoRoot, worktreePath);
	let created = false;
	const branchName = mode.detached
		? null
		: `${mode.name}/${sanitizePathToken(teamName)}/${sanitizePathToken(worker.id)}`;
	if (existing) {
		if (worktreeIsDirty(worktreePath)) throw new Error(`worktree_dirty:${worktreePath}`);
		if (mode.detached && worktreeHead(worktreePath) !== baseRef) throw new Error(`worktree_stale:${worktreePath}`);
	} else {
		if (await pathExists(worktreePath)) throw new Error(`worktree_path_conflict:${worktreePath}`);
		await fs.mkdir(path.dirname(worktreePath), { recursive: true });
		const args = mode.detached
			? ["worktree", "add", "--detach", worktreePath, baseRef]
			: branchExists(repoRoot, branchName ?? "")
				? ["worktree", "add", worktreePath, branchName ?? ""]
				: ["worktree", "add", "-b", branchName ?? "", worktreePath, baseRef];
		runGit(repoRoot, args);
		created = true;
	}
	return {
		...worker,
		worktree_repo_root: repoRoot,
		worktree_path: path.resolve(worktreePath),
		worktree_branch: branchName,
		worktree_detached: mode.detached,
		worktree_created: created,
		worktree_base_ref: baseRef,
	};
}

function buildTeamTmuxLeaderRequirementMessage(detail?: string): string {
	const suffix = detail?.trim() ? `:${detail.trim()}` : "";
	return `gjc_team_requires_tmux_leader: start a tmux session first (run \`gjc --tmux\`, or launch tmux yourself), then run \`gjc team ...\` inside it, or use \`gjc team --dry-run\` for state-only smoke tests${suffix}`;
}
function readGjcTmuxProfileValue(tmuxCommand: string, sessionName: string): string {
	const result = Bun.spawnSync(
		[tmuxCommand, "show-options", "-qv", "-t", buildGjcTmuxExactOptionTarget(sessionName), GJC_TMUX_PROFILE_OPTION],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode !== 0) return "";
	return result.stdout.toString().trim();
}

function tagTmuxSessionAsGjcLeader(tmuxCommand: string, sessionName: string): boolean {
	const result = Bun.spawnSync(
		[
			tmuxCommand,
			"set-option",
			"-t",
			buildGjcTmuxExactOptionTarget(sessionName),
			GJC_TMUX_PROFILE_OPTION,
			GJC_TMUX_PROFILE_VALUE,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return result.exitCode === 0;
}

function readCurrentTmuxLeaderContext(tmuxCommand: string, env: NodeJS.ProcessEnv): GjcTmuxLeaderContext {
	if (Bun.which(tmuxCommand) === null)
		throw new Error(buildTeamTmuxLeaderRequirementMessage(`tmux_not_installed:${tmuxCommand}`));
	// Prefer the explicit GJC-managed session name propagated by `gjc --tmux`
	// (GJC_TMUX_ACTIVE_SESSION). Under psmux on Windows the inherited TMUX_PANE
	// can resolve to the wrong/default session, so querying the tagged session
	// by name is authoritative for GJC-launched leaders. Fall back to TMUX_PANE,
	// then to the ambient session, to keep native tmux/WSL flows unchanged.
	const activeSession = env[GJC_TMUX_ACTIVE_SESSION_ENV]?.trim();
	const displayTarget = activeSession ? buildGjcTmuxExactOptionTarget(activeSession, { env }) : env.TMUX_PANE?.trim();
	const args = displayTarget
		? ["display-message", "-p", "-t", displayTarget, "#S:#I #{pane_id}"]
		: ["display-message", "-p", "#S:#I #{pane_id}"];
	const result = Bun.spawnSync([tmuxCommand, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		// Distinguish "you are not inside any tmux session" from a genuine tmux
		// query failure so the caller gets actionable guidance instead of raw
		// tmux stderr. `gjc team` needs a tmux leader; outside tmux there is none.
		const insideTmux = Boolean(env.TMUX?.trim() || env.TMUX_PANE?.trim() || activeSession);
		const stderr = result.stderr.toString().trim();
		throw new Error(
			buildTeamTmuxLeaderRequirementMessage(
				insideTmux ? `tmux_query_failed${stderr ? `:${stderr}` : ""}` : "not_inside_tmux",
			),
		);
	}
	const [sessionAndWindow = "", leaderPaneId = ""] = result.stdout.toString().trim().split(/\s+/);
	const [sessionName = "", windowIndex = ""] = sessionAndWindow.split(":");
	if (!sessionName || !windowIndex || !leaderPaneId.startsWith("%"))
		throw new Error(buildTeamTmuxLeaderRequirementMessage(`invalid_tmux_context:${result.stdout.toString().trim()}`));
	if (readGjcTmuxProfileValue(tmuxCommand, sessionName) !== GJC_TMUX_PROFILE_VALUE) {
		// Adopt any real tmux leader as a GJC team leader — including a session
		// the user created outside `gjc --tmux` — by writing GJC's @gjc-profile
		// ownership tag and reading it back. A provider that round-trips tmux
		// user options (real tmux) keeps the tag and is adopted; one that does
		// not (e.g. psmux on Windows) drops it, so the readback still fails and
		// the leader is rejected as unmanaged. This also self-heals a genuine
		// `gjc --tmux` pane that lost its @gjc-profile tag mid-startup.
		const tagged = tagTmuxSessionAsGjcLeader(tmuxCommand, sessionName);
		if (!tagged || readGjcTmuxProfileValue(tmuxCommand, sessionName) !== GJC_TMUX_PROFILE_VALUE)
			throw new Error(
				buildTeamTmuxLeaderRequirementMessage(
					`unmanaged_tmux_session:${sessionName} — ${buildGjcTmuxUntaggedSessionHint(tmuxCommand)}`,
				),
			);
	}
	return {
		sessionName,
		windowIndex,
		leaderPaneId,
		target: `${sessionName}:${windowIndex}`,
	};
}
function isBunVirtualPath(candidate: string | undefined): boolean {
	const normalized = candidate?.trim().replace(/\\/g, "/").toLowerCase();
	return (
		normalized === "/$bunfs" ||
		normalized?.startsWith("/$bunfs/") === true ||
		normalized === "b:/~bun" ||
		normalized?.startsWith("b:/~bun/") === true
	);
}

function isAbsoluteRealPath(candidate: string | undefined, pathModule: typeof path): candidate is string {
	const normalized = candidate?.trim();
	return Boolean(normalized && !isBunVirtualPath(normalized) && pathModule.isAbsolute(normalized));
}
function isGjcExecutablePath(candidate: string | undefined, pathModule: typeof path): candidate is string {
	return isAbsoluteRealPath(candidate, pathModule) && /^gjc(?:[._-]|$)/i.test(pathModule.basename(candidate.trim()));
}

function formatWorkerExecutable(platform: NodeJS.Platform, executable: string): string {
	return (platform === "win32" ? powershellQuote : shellQuote)(executable);
}

function unresolvedWorkerAuthorityError(): Error {
	return new Error(
		"Unable to determine the GJC worker executable from this invocation. Set GJC_TEAM_WORKER_COMMAND to the exact GJC command, or launch GJC from a real executable path instead of a Bun virtual path.",
	);
}

export function resolveGjcWorkerCommand(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	argv: string[] = process.argv,
	execPath = process.execPath,
): string {
	const explicit = env.GJC_TEAM_WORKER_COMMAND?.trim();
	if (explicit) {
		if (isBunVirtualPath(explicit)) throw unresolvedWorkerAuthorityError();
		return explicit;
	}

	const pathModule = platform === "win32" ? path.win32 : path.posix;
	const runtime = argv[0]?.trim();
	const entrypoint = argv[1]?.trim();
	const sourceEntrypoint = entrypoint && !isBunVirtualPath(entrypoint) && /\.(?:[cm]?[jt]s)$/i.test(entrypoint);

	if (sourceEntrypoint) {
		const sourceRuntime = isAbsoluteRealPath(runtime, pathModule)
			? runtime
			: isAbsoluteRealPath(execPath, pathModule)
				? execPath.trim()
				: undefined;
		if (!sourceRuntime) throw unresolvedWorkerAuthorityError();
		const absoluteEntrypoint = pathModule.isAbsolute(entrypoint) ? entrypoint : pathModule.resolve(cwd, entrypoint);
		if (!isAbsoluteRealPath(absoluteEntrypoint, pathModule)) throw unresolvedWorkerAuthorityError();
		return `${formatWorkerExecutable(platform, sourceRuntime)} ${formatWorkerExecutable(platform, absoluteEntrypoint)}`;
	}

	const executable =
		(isGjcExecutablePath(entrypoint, pathModule) ? entrypoint : undefined) ??
		(isGjcExecutablePath(execPath, pathModule) ? execPath.trim() : undefined) ??
		(isGjcExecutablePath(runtime, pathModule) ? runtime : undefined);
	if (!executable) throw unresolvedWorkerAuthorityError();
	return formatWorkerExecutable(platform, executable);
}
export { buildWorkerCommand } from "./team-launch";

function shouldDispatchWorkerWithSendKeys(tmuxCommand: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" || path.basename(tmuxCommand).toLowerCase() === "psmux";
}

interface GjcTeamInitialLane {
	label: string;
	title: string;
	body: string;
}

function normalizeLaneId(label: string): string {
	return `lane-${sanitizeName(label).toLowerCase() || stableHash(label).slice(0, 8)}`;
}

function parseExplicitTeamLanes(task: string): GjcTeamInitialLane[] {
	const lines = task.split(/\r?\n/);
	const lanes: GjcTeamInitialLane[] = [];
	let current: { label: string; title: string; body: string[] } | null = null;
	const laneHeading = /^#{2,6}\s+Lane\s+([A-Za-z0-9]+)\s*(?:[—–-]\s*(.+))?\s*$/;
	const boundaryHeading = /^#{1,6}\s+(?:Integration Owner|Verification Plan|ADR|Approval State)\b/i;

	for (const line of lines) {
		const match = line.match(laneHeading);
		if (match) {
			if (current) lanes.push({ ...current, body: current.body.join("\n").trim() });
			current = {
				label: match[1] ?? `${lanes.length + 1}`,
				title: (match[2] ?? `Lane ${match[1] ?? lanes.length + 1}`).trim(),
				body: [],
			};
			continue;
		}
		if (current && boundaryHeading.test(line)) {
			lanes.push({ ...current, body: current.body.join("\n").trim() });
			current = null;
			continue;
		}
		if (current) current.body.push(line);
	}
	if (current) lanes.push({ ...current, body: current.body.join("\n").trim() });
	return lanes.filter(lane => lane.body.length > 0 || lane.title.length > 0);
}

function hasAmbiguousLaneSplitIntent(task: string): boolean {
	return (
		/\bsplit\s+lanes?\s*:/i.test(task) || /\blanes?\s*:\s*[A-Z]\b/i.test(task) || /\bLane\s+[A-Z]\s*[—–-]/.test(task)
	);
}

function buildInitialTasks(task: string, workers: GjcTeamWorker[]): GjcTeamTask[] {
	const lanes = parseExplicitTeamLanes(task);
	if (lanes.length > 0)
		return lanes.map((lane, index) => {
			const worker = workers[index % workers.length];
			if (!worker) throw new Error("team_lane_requires_worker");
			const laneTitle = `Lane ${lane.label} — ${lane.title}`;
			const objective = [`${laneTitle}`, lane.body].filter(part => part.trim().length > 0).join("\n\n");
			return {
				id: `task-${index + 1}`,
				subject: laneTitle,
				description: objective,
				title: laneTitle,
				objective,
				status: "pending",
				owner: worker.id,
				lane: normalizeLaneId(lane.label),
				required_role: worker.role,
				version: 1,
				created_at: now(),
				updated_at: now(),
			};
		});

	if (workers.length > 1 && hasAmbiguousLaneSplitIntent(task))
		throw new Error(
			"ambiguous_team_lane_split: multi-worker team launch mentions lanes but does not provide explicit markdown lane sections such as `### Lane A — Title`",
		);

	return workers.map(worker => ({
		id: `task-${worker.index}`,
		subject: `Execute team brief (${worker.id})`,
		description: task,
		title: `Execute team brief (${worker.id})`,
		objective: task,
		status: "pending",
		owner: worker.id,
		version: 1,
		created_at: now(),
		updated_at: now(),
	}));
}

async function startTmuxSession(
	config: GjcTeamConfig,
	dir: string,
	dryRun: boolean,
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamWorker[]> {
	if (dryRun)
		return config.workers.map(worker => ({
			...worker,
			pane_id: `%dry-run-${worker.id}`,
		}));
	const rollbackPaneIds: string[] = [];
	try {
		const workers: GjcTeamWorker[] = [];
		let rightStackRootPaneId: string | null = null;
		for (const worker of config.workers) {
			const splitDirection: string = worker.index === 1 ? "-h" : "-v";
			const splitTarget: string =
				worker.index === 1 ? config.tmux_target : (rightStackRootPaneId ?? config.tmux_target);
			const workerCommand = buildWorkerCommand(config, worker);
			const workerCwd = worker.worktree_path ?? config.leader.cwd;
			const useSendKeysFallback = shouldDispatchWorkerWithSendKeys(config.tmux_command);
			const splitArgs = [
				config.tmux_command,
				"split-window",
				splitDirection,
				"-t",
				splitTarget,
				"-d",
				"-P",
				"-F",
				"#{pane_id}",
				"-c",
				workerCwd,
				...(useSendKeysFallback ? [] : [workerCommand]),
			];
			const split: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync(splitArgs, { stdout: "pipe", stderr: "pipe" });
			if (split.exitCode !== 0)
				throw new Error(split.stderr.toString().trim() || `tmux_split_failed:${config.tmux_target}:${worker.id}`);
			const paneId: string = split.stdout.toString().trim().split(/\r?\n/)[0]?.trim() ?? "";
			if (!paneId.startsWith("%")) throw new Error(`tmux_split_missing_pane:${config.tmux_target}:${worker.id}`);
			rollbackPaneIds.push(paneId);
			if (worker.index === 1) rightStackRootPaneId = paneId;
			workers.push({ ...worker, pane_id: paneId });
			if (useSendKeysFallback) {
				// On psmux/ConPTY (Windows pwsh default-shell) panes, tmux writes the
				// split-window command argv to the new pane's stdin but pwsh's readline
				// never receives an Enter, so the worker never starts. Create the pane
				// without a command, then dispatch the worker command through send-keys +
				// Enter so it actually executes.
				// Two-step dispatch because tmux's `-l` (literal mode) flag is global per
				// send-keys invocation, not per arg: passing `-l <body> Enter` would treat
				// "Enter" as literal text too. Sending the body in literal mode first and
				// the Enter keypress second keeps the body verbatim while still submitting
				// the prompt as a keystroke.
				Bun.spawnSync([config.tmux_command, "send-keys", "-l", "-t", paneId, workerCommand], {
					stdout: "ignore",
					stderr: "ignore",
				});
				const sendKeys = Bun.spawnSync([config.tmux_command, "send-keys", "-t", paneId, "Enter"], {
					stdout: "ignore",
					stderr: "ignore",
				});
				// void-cast the exit code so the linter does not flag an unused expression;
				// the value is intentionally discarded here because the actual spawn outcome
				// is recovered by the leader through the worker startup-ack watcher, not via
				// the spawn exit code.
				void sendKeys.exitCode;
			}
		}
		Bun.spawnSync([config.tmux_command, "select-layout", "-t", config.tmux_target, "main-vertical"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const widthResult = Bun.spawnSync(
			[config.tmux_command, "display-message", "-p", "-t", config.tmux_target, "#{window_width}"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const width = Number.parseInt(widthResult.stdout.toString().trim(), 10);
		if (Number.isFinite(width) && width >= 40) {
			Bun.spawnSync(
				[
					config.tmux_command,
					"set-window-option",
					"-t",
					config.tmux_target,
					"main-pane-width",
					String(Math.floor(width / 2)),
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			Bun.spawnSync([config.tmux_command, "select-layout", "-t", config.tmux_target, "main-vertical"], {
				stdout: "ignore",
				stderr: "ignore",
			});
		}
		const profileResult = applyGjcTmuxProfile({
			tmuxCommand: config.tmux_command,
			target: config.tmux_target,
			cwd: config.leader.cwd,
			env,
		});
		await appendTelemetry(dir, {
			type: "tmux_profile_applied",
			message: profileResult.skipped
				? "Skipped GJC scoped tmux profile"
				: "Applied GJC scoped tmux profile to team tmux target",
			data: {
				tmux_target: config.tmux_target,
				command_count: profileResult.commands.length,
				failure_count: profileResult.failures.length,
			},
		});
		await appendTelemetry(dir, {
			type: "tmux_started",
			message: "Started gjc team worker panes in current tmux window",
			data: {
				tmux_target: config.tmux_target,
				panes: workers.map(worker => worker.pane_id).filter(Boolean),
			},
		});
		return workers;
	} catch (error) {
		for (const paneId of rollbackPaneIds)
			Bun.spawnSync([config.tmux_command, "kill-pane", "-t", paneId], {
				stdout: "ignore",
				stderr: "ignore",
			});
		throw error;
	}
}
function paneBelongsToTeamTarget(config: GjcTeamConfig, paneId: string): boolean {
	if (paneId === config.leader.pane_id) return false;
	const result = Bun.spawnSync([config.tmux_command, "display-message", "-p", "-t", paneId, "#S:#I #{pane_id}"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return false;
	const [target = "", detectedPaneId = ""] = result.stdout.toString().trim().split(/\s+/);
	return target === config.tmux_target && detectedPaneId === paneId;
}
function killWorkerPanes(config: GjcTeamConfig): void {
	for (const worker of config.workers)
		if (worker.pane_id?.startsWith("%") && paneBelongsToTeamTarget(config, worker.pane_id))
			Bun.spawnSync([config.tmux_command, "kill-pane", "-t", worker.pane_id], {
				stdout: "ignore",
				stderr: "ignore",
			});
}
async function rollbackCreatedWorktrees(workers: GjcTeamWorker[]): Promise<void> {
	for (const worker of workers.filter(worker => worker.worktree_created).reverse())
		if (worker.worktree_repo_root && worker.worktree_path)
			Bun.spawnSync(["git", "worktree", "remove", "--force", worker.worktree_path], {
				cwd: worker.worktree_repo_root,
				stdout: "ignore",
				stderr: "ignore",
			});
}
async function removeCleanCreatedWorktrees(workers: GjcTeamWorker[]): Promise<void> {
	for (const worker of workers.filter(worker => worker.worktree_created).reverse())
		if (worker.worktree_repo_root && worker.worktree_path && !worktreeIsDirty(worker.worktree_path))
			Bun.spawnSync(["git", "worktree", "remove", worker.worktree_path], {
				cwd: worker.worktree_repo_root,
				stdout: "ignore",
				stderr: "ignore",
			});
}

function monitorSnapshotPath(dir: string): string {
	return path.join(dir, "monitor-snapshot.json");
}
function integrationReportPath(dir: string): string {
	return path.join(dir, "integration-report.md");
}
function commitHygieneLedgerPath(config: GjcTeamConfig): string {
	return path.join(
		sessionReportsDir(
			config.leader_cwd,
			resolveGjcSessionForWrite(config.leader_cwd, {
				envSessionId: process.env.GJC_SESSION_ID,
			}).gjcSessionId,
		),
		"team-commit-hygiene",
		`${config.team_name}.ledger.json`,
	);
}
function integrationNowState(
	status: GjcTeamIntegrationStatus,
): Pick<GjcTeamWorkerIntegrationState, "status" | "updated_at"> {
	return { status, updated_at: now() };
}
async function appendIntegrationReport(
	dir: string,
	entry: {
		worker: string;
		operation: "merge" | "cherry-pick" | "rebase";
		files: string[];
		detail: string;
	},
): Promise<void> {
	const line = `- [${now()}] ${entry.worker}: ${entry.operation}; files=${entry.files.join(",") || "unknown"}; ${entry.detail}\n`;
	if (await pathExists(integrationReportPath(dir)))
		await appendText(
			integrationReportPath(dir),
			line,
			stateWriterOptions(integrationReportPath(dir), "report", "append"),
		);
	else
		await writeReport(
			integrationReportPath(dir),
			`# Integration Report\n\n${line}`,
			stateWriterOptions(integrationReportPath(dir), "report", "write"),
		);
}
async function appendCommitHygieneEntries(config: GjcTeamConfig, entries: GjcTeamCommitHygieneEntry[]): Promise<void> {
	if (entries.length === 0) return;
	const ledgerPath = commitHygieneLedgerPath(config);
	const existing = (await readJsonFile<{
		version: number;
		entries: GjcTeamCommitHygieneEntry[];
	}>(ledgerPath)) ?? {
		version: 1,
		entries: [],
	};
	await writeJsonFile(ledgerPath, {
		version: 1,
		entries: [...existing.entries, ...entries],
	});
}
function resolveHead(cwd: string): string | null {
	return tryRunGit(cwd, ["rev-parse", "HEAD"]);
}
async function resolveHeadAsync(cwd: string, signal?: AbortSignal): Promise<string | null> {
	return tryRunGitAsync(cwd, ["rev-parse", "HEAD"], signal);
}
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
	return runGitResult(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}
function listCommitRange(cwd: string, baseRef: string, headRef: string): string[] {
	const result = runGitResult(cwd, ["rev-list", "--reverse", `${baseRef}..${headRef}`]);
	if (!result.ok || !result.stdout) return [];
	return result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
}
function listConflictFiles(cwd: string): string[] {
	const result = runGitResult(cwd, ["diff", "--name-only", "--diff-filter=U"]);
	if (!result.ok || !result.stdout) return [];
	return result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
}
async function listConflictFilesAsync(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const result = await runGitResultAsync(cwd, ["diff", "--name-only", "--diff-filter=U"], signal);
	if (!result.ok || !result.stdout) return [];
	return result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
}

export type GjcWorkerCheckpointClassification =
	| { kind: "clean"; files: string[] }
	| { kind: "eligible"; files: string[] }
	| { kind: "protected_only"; files: string[] }
	| { kind: "conflicted"; files: string[] }
	| { kind: "git_error"; files: string[]; detail: string };

const UNMERGED_GIT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
// Every generated/runtime artifact for a GJC session lives under
// `.gjc/_session-{id}/...` (see session-layout.ts), so worker auto-checkpoints
// exclude the whole session subtree instead of enumerating its subdirectories.
// The enumerated form drifted: subtrees outside the list (for example the
// extragoal gate receipts from docs/extragoal-skill-template.md, or the
// session-root `.session-activity.json` marker) were auto-committed and merged
// into the leader branch on projects that do not gitignore `.gjc/_session-*/`.
const PROTECTED_WORKER_CHECKPOINT_PREFIXES = [".gjc/_session-*/"];

function parsePorcelainStatusFiles(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.filter(Boolean)
		.map(line => line.slice(3).trim())
		.filter(Boolean);
}

function normalizeGitStatusPath(filePath: string): string {
	return (filePath.split(" -> ").at(-1) ?? filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function classifyGjcTeamCheckpointFiles(files: string[]): {
	eligible: string[];
	protected: string[];
} {
	const eligible: string[] = [];
	const protectedFiles: string[] = [];
	for (const file of files) {
		const normalized = normalizeGitStatusPath(file);
		const isProtected = PROTECTED_WORKER_CHECKPOINT_PREFIXES.some(prefix => {
			if (!prefix.includes("*")) return normalized === prefix.slice(0, -1) || normalized.startsWith(prefix);
			const [head, tail] = prefix.split("*");
			return Boolean(head && tail) && normalized.startsWith(head) && normalized.slice(head.length).includes(tail);
		});
		if (isProtected) protectedFiles.push(file);
		else eligible.push(file);
	}
	return { eligible, protected: protectedFiles };
}

export function classifyWorkerCheckpointStatus(cwd: string): GjcWorkerCheckpointClassification {
	const status = runGitResult(cwd, ["status", "--porcelain", "-uall"]);
	if (!status.ok) {
		return {
			kind: "git_error",
			files: [],
			detail: status.stderr || status.stdout || "git status failed",
		};
	}
	if (!status.stdout.trim()) return { kind: "clean", files: [] };
	const files = parsePorcelainStatusFiles(status.stdout);
	const hasUnmergedStatus = status.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.some(line => UNMERGED_GIT_STATUS_CODES.has(line.slice(0, 2)));
	const conflictFiles = listConflictFiles(cwd);
	if (hasUnmergedStatus || conflictFiles.length > 0) {
		return {
			kind: "conflicted",
			files: conflictFiles.length > 0 ? conflictFiles : files,
		};
	}
	const classified = classifyGjcTeamCheckpointFiles(files);
	if (classified.eligible.length === 0 && classified.protected.length > 0)
		return { kind: "protected_only", files: classified.protected };
	return { kind: "eligible", files: classified.eligible };
}
export async function classifyWorkerCheckpointStatusAsync(
	cwd: string,
	signal?: AbortSignal,
): Promise<GjcWorkerCheckpointClassification> {
	const status = await runGitResultAsync(cwd, ["status", "--porcelain", "-uall"], signal);
	if (!status.ok) {
		return {
			kind: "git_error",
			files: [],
			detail: status.stderr || status.stdout || "git status failed",
		};
	}
	if (!status.stdout.trim()) return { kind: "clean", files: [] };
	const files = parsePorcelainStatusFiles(status.stdout);
	const hasUnmergedStatus = status.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.some(line => UNMERGED_GIT_STATUS_CODES.has(line.slice(0, 2)));
	const conflictFiles = await listConflictFilesAsync(cwd, signal);
	if (hasUnmergedStatus || conflictFiles.length > 0) {
		return {
			kind: "conflicted",
			files: conflictFiles.length > 0 ? conflictFiles : files,
		};
	}
	const classified = classifyGjcTeamCheckpointFiles(files);
	if (classified.eligible.length === 0 && classified.protected.length > 0)
		return { kind: "protected_only", files: classified.protected };
	return { kind: "eligible", files: classified.eligible };
}
async function appendIntegrationEvent(
	dir: string,
	type: string,
	worker: GjcTeamWorker,
	data: Record<string, unknown>,
): Promise<void> {
	await appendEvent(dir, {
		type,
		worker: worker.id,
		task_id: worker.assigned_tasks[0],
		message: typeof data.summary === "string" ? data.summary : type,
		data,
	});
}
async function notifyLeader(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	body: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	await sendGjcTeamMessage(config.team_name, worker.id, "leader-fixed", body, cwd, env).catch(() => undefined);
}
async function notifyWorker(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	body: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	await sendGjcTeamMessage(config.team_name, "leader-fixed", worker.id, body, cwd, env).catch(() => undefined);
}
async function notifyIntegrationConflict(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	body: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	await Promise.all([notifyLeader(config, worker, body, cwd, env), notifyWorker(config, worker, body, cwd, env)]);
}
function autoCommitDirtyWorker(worker: GjcTeamWorker): {
	committed: boolean;
	commit: string | null;
	classification: GjcWorkerCheckpointClassification | null;
} {
	const empty = { committed: false, commit: null, classification: null };
	if (!worker.worktree_path) return empty;
	const classification = classifyWorkerCheckpointStatus(worker.worktree_path);
	if (classification.kind !== "eligible") return { ...empty, classification };
	if (!runGitResult(worker.worktree_path, ["add", "--", ...classification.files]).ok)
		return { ...empty, classification };
	const message = `gjc(team): auto-checkpoint ${worker.id} [${worker.assigned_tasks[0] ?? "unknown"}]`;
	if (!runGitResult(worker.worktree_path, ["commit", "--no-verify", "-m", message]).ok)
		return { ...empty, classification };
	return {
		committed: true,
		commit: resolveHead(worker.worktree_path),
		classification,
	};
}
function workerMergeRef(worker: GjcTeamWorker, workerHead: string): string {
	if (!worker.worktree_path) return workerHead;
	const branch = tryRunGit(worker.worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return !branch || branch === "HEAD" ? workerHead : branch;
}
async function integrateGjcWorkerCommits(
	config: GjcTeamConfig,
	dir: string,
	previous: GjcTeamMonitorSnapshot | null,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<Record<string, GjcTeamWorkerIntegrationState>> {
	const integrationByWorker: Record<string, GjcTeamWorkerIntegrationState> = {
		...(previous?.integration_by_worker ?? {}),
	};
	const hygieneEntries: GjcTeamCommitHygieneEntry[] = [];
	const leaderCwd = config.leader_cwd || cwd;
	const cycleLeaderHead = resolveHead(leaderCwd);
	for (const worker of config.workers) {
		if (!worker.worktree_path || !worker.worktree_repo_root || !(await pathExists(worker.worktree_path))) continue;
		const { committed, commit } = autoCommitDirtyWorker(worker);
		if (!committed) continue;
		await appendIntegrationEvent(dir, "worker_auto_commit", worker, {
			worker_name: worker.id,
			commit_hash: commit,
			worktree_path: worker.worktree_path,
			summary: `auto-committed dirty worktree for ${worker.id}`,
		});
		hygieneEntries.push({
			recorded_at: now(),
			operation: "auto_checkpoint",
			worker_name: worker.id,
			task_id: worker.assigned_tasks[0],
			status: "applied",
			operational_commit: commit,
			worktree_path: worker.worktree_path,
			detail: "Dirty worker worktree checkpointed before integration.",
		});
	}

	for (const worker of config.workers) {
		if (!worker.worktree_path || !worker.worktree_repo_root || !(await pathExists(worker.worktree_path))) continue;
		const leaderHead = resolveHead(leaderCwd);
		const workerHead = resolveHead(worker.worktree_path);
		const state: GjcTeamWorkerIntegrationState = {
			...(integrationByWorker[worker.id] ?? {}),
			last_leader_head: leaderHead ?? integrationByWorker[worker.id]?.last_leader_head,
		};
		if (!leaderHead || !workerHead) {
			integrationByWorker[worker.id] = state;
			continue;
		}
		state.last_seen_head = workerHead;
		if (isAncestor(leaderCwd, workerHead, "HEAD")) {
			integrationByWorker[worker.id] = {
				...state,
				last_integrated_head: workerHead,
				...integrationNowState("idle"),
			};
			continue;
		}
		if (isAncestor(worker.worktree_path, leaderHead, workerHead)) {
			const mergeRef = workerMergeRef(worker, workerHead);
			const merge = runGitResult(leaderCwd, ["merge", "--no-ff", "-m", `gjc(team): merge ${worker.id}`, mergeRef]);
			if (merge.ok) {
				const newLeaderHead = resolveHead(leaderCwd);
				if (newLeaderHead && newLeaderHead !== leaderHead && isAncestor(leaderCwd, workerHead, "HEAD")) {
					integrationByWorker[worker.id] = {
						...state,
						last_integrated_head: workerHead,
						last_leader_head: newLeaderHead,
						conflict_commit: undefined,
						conflict_files: undefined,
						...integrationNowState("integrated"),
					};
					await appendIntegrationEvent(dir, "worker_merge_applied", worker, {
						worker_name: worker.id,
						worker_head: workerHead,
						leader_head_before: leaderHead,
						leader_head_after: newLeaderHead,
						worktree_path: worker.worktree_path,
						summary: `merged ${worker.id} into leader`,
					});
					await notifyLeader(
						config,
						worker,
						`INTEGRATED: merged ${worker.id} ${workerHead.slice(0, 12)} into leader.`,
						cwd,
						env,
					);
					hygieneEntries.push({
						recorded_at: now(),
						operation: "integration_merge",
						worker_name: worker.id,
						task_id: worker.assigned_tasks[0],
						status: "applied",
						operational_commit: newLeaderHead,
						source_commit: workerHead,
						leader_head_before: leaderHead,
						leader_head_after: newLeaderHead,
						worktree_path: worker.worktree_path,
						detail: "Leader created a runtime merge commit to integrate worker history.",
					});
				} else {
					integrationByWorker[worker.id] = {
						...state,
						...integrationNowState("integration_failed"),
					};
					hygieneEntries.push({
						recorded_at: now(),
						operation: "integration_merge",
						worker_name: worker.id,
						task_id: worker.assigned_tasks[0],
						status: "failed",
						source_commit: workerHead,
						leader_head_before: leaderHead,
						leader_head_after: newLeaderHead,
						worktree_path: worker.worktree_path,
						detail: "Runtime merge succeeded but did not advance the leader head.",
					});
					await notifyLeader(
						config,
						worker,
						`INTEGRATION FAILED: merge for ${worker.id} did not advance leader HEAD.`,
						cwd,
						env,
					);
				}
			} else {
				const conflictFiles = listConflictFiles(leaderCwd);
				runGitResult(leaderCwd, ["merge", "--abort"]);
				integrationByWorker[worker.id] = {
					...state,
					conflict_commit: workerHead,
					conflict_files: conflictFiles,
					...integrationNowState("merge_conflict"),
				};
				await appendIntegrationEvent(dir, "worker_merge_conflict", worker, {
					worker_name: worker.id,
					worker_head: workerHead,
					conflict_files: conflictFiles,
					stderr: merge.stderr || merge.stdout,
					summary: `merge conflict for ${worker.id}`,
				});
				await appendIntegrationReport(dir, {
					worker: worker.id,
					operation: "merge",
					files: conflictFiles,
					detail: `merge --no-ff failed and was aborted: ${(merge.stderr || merge.stdout).slice(0, 200)}`,
				});
				await notifyIntegrationConflict(
					config,
					worker,
					`CONFLICT: merge failed for ${worker.id}; files: ${conflictFiles.join(",") || "unknown"}. Manual resolution required; runtime aborted the merge and did not auto-resolve.`,
					cwd,
					env,
				);
				hygieneEntries.push({
					recorded_at: now(),
					operation: "integration_merge",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "conflict",
					source_commit: workerHead,
					leader_head_before: leaderHead,
					leader_head_after: resolveHead(leaderCwd),
					worktree_path: worker.worktree_path,
					detail: `Runtime merge failed and was aborted: ${(merge.stderr || merge.stdout).slice(0, 200)}`,
				});
			}
			continue;
		}

		const baseline =
			state.last_integrated_head &&
			tryRunGit(worker.worktree_path, ["rev-parse", "--verify", state.last_integrated_head])
				? state.last_integrated_head
				: leaderHead;
		const commits = listCommitRange(worker.worktree_path, baseline, workerHead);
		for (const commit of commits) {
			const pick = runGitResult(leaderCwd, ["cherry-pick", "--allow-empty", commit]);
			if (!pick.ok) {
				const conflictFiles = listConflictFiles(leaderCwd);
				runGitResult(leaderCwd, ["cherry-pick", "--abort"]);
				integrationByWorker[worker.id] = {
					...state,
					conflict_commit: commit,
					conflict_files: conflictFiles,
					...integrationNowState("cherry_pick_conflict"),
				};
				await appendIntegrationEvent(dir, "worker_cherry_pick_conflict", worker, {
					worker_name: worker.id,
					commit,
					conflict_files: conflictFiles,
					stderr: pick.stderr || pick.stdout,
					summary: `cherry-pick conflict for ${worker.id}`,
				});
				await appendIntegrationReport(dir, {
					worker: worker.id,
					operation: "cherry-pick",
					files: conflictFiles,
					detail: `cherry-pick failed and was aborted: ${(pick.stderr || pick.stdout).slice(0, 200)}`,
				});
				await notifyIntegrationConflict(
					config,
					worker,
					`CONFLICT: cherry-pick failed for ${worker.id}; files: ${conflictFiles.join(",") || "unknown"}. Manual resolution required; runtime aborted the cherry-pick and did not auto-resolve.`,
					cwd,
					env,
				);
				hygieneEntries.push({
					recorded_at: now(),
					operation: "integration_cherry_pick",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "conflict",
					source_commit: commit,
					leader_head_before: leaderHead,
					leader_head_after: resolveHead(leaderCwd),
					worktree_path: worker.worktree_path,
					detail: `Runtime cherry-pick failed and was aborted: ${(pick.stderr || pick.stdout).slice(0, 200)}`,
				});
				break;
			}
			const newLeaderHead = resolveHead(leaderCwd);
			if (!newLeaderHead || newLeaderHead === leaderHead) {
				integrationByWorker[worker.id] = {
					...state,
					...integrationNowState("integration_failed"),
				};
				hygieneEntries.push({
					recorded_at: now(),
					operation: "integration_cherry_pick",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "failed",
					source_commit: commit,
					leader_head_before: leaderHead,
					leader_head_after: newLeaderHead,
					worktree_path: worker.worktree_path,
					detail: "Runtime cherry-pick did not advance the leader head.",
				});
				break;
			}
			integrationByWorker[worker.id] = {
				...state,
				last_integrated_head: commit,
				last_leader_head: newLeaderHead,
				conflict_commit: undefined,
				conflict_files: undefined,
				...integrationNowState("integrated"),
			};
			await appendIntegrationEvent(dir, "worker_cherry_pick_applied", worker, {
				worker_name: worker.id,
				commit,
				leader_head_before: leaderHead,
				leader_head_after: newLeaderHead,
				worktree_path: worker.worktree_path,
				summary: `cherry-picked ${commit.slice(0, 12)} from ${worker.id}`,
			});
			await notifyLeader(
				config,
				worker,
				`INTEGRATED: cherry-picked ${commit.slice(0, 12)} from ${worker.id}.`,
				cwd,
				env,
			);
			hygieneEntries.push({
				recorded_at: now(),
				operation: "integration_cherry_pick",
				worker_name: worker.id,
				task_id: worker.assigned_tasks[0],
				status: "applied",
				operational_commit: newLeaderHead,
				source_commit: commit,
				leader_head_before: leaderHead,
				leader_head_after: newLeaderHead,
				worktree_path: worker.worktree_path,
				detail: "Leader cherry-picked diverged worker history.",
			});
		}
	}

	const newLeaderHead = resolveHead(leaderCwd);
	if (cycleLeaderHead && newLeaderHead && cycleLeaderHead !== newLeaderHead) {
		for (const worker of config.workers) {
			if (!worker.worktree_path || !(await pathExists(worker.worktree_path))) continue;
			const status = await readGjcWorkerStatus(config.team_name, worker.id, cwd, env);
			if (!["idle", "done", "failed"].includes(status.state)) {
				await appendIntegrationEvent(dir, "worker_cross_rebase_skipped", worker, {
					worker_name: worker.id,
					worker_state: status.state,
					leader_head: newLeaderHead,
					summary: `skipped cross-rebase for ${worker.id}`,
				});
				hygieneEntries.push({
					recorded_at: now(),
					operation: "cross_rebase",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "skipped",
					leader_head_after: newLeaderHead,
					worktree_path: worker.worktree_path,
					detail: `Worker state ${status.state} is not eligible for automatic cross-rebase.`,
				});
				continue;
			}
			if (worktreeIsDirty(worker.worktree_path)) {
				hygieneEntries.push({
					recorded_at: now(),
					operation: "cross_rebase",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "skipped",
					leader_head_after: newLeaderHead,
					worktree_path: worker.worktree_path,
					detail: "Worker worktree is dirty after integration; automatic cross-rebase skipped.",
				});
				continue;
			}
			const before = resolveHead(worker.worktree_path);
			const rebase = runGitResult(worker.worktree_path, ["rebase", newLeaderHead]);
			if (rebase.ok) {
				const after = resolveHead(worker.worktree_path);
				integrationByWorker[worker.id] = {
					...(integrationByWorker[worker.id] ?? {}),
					last_rebased_leader_head: newLeaderHead,
					conflict_commit: undefined,
					conflict_files: undefined,
					...integrationNowState("idle"),
				};
				await appendIntegrationEvent(dir, "worker_cross_rebase_applied", worker, {
					worker_name: worker.id,
					leader_head: newLeaderHead,
					worktree_path: worker.worktree_path,
					summary: `cross-rebased ${worker.id}`,
				});
				hygieneEntries.push({
					recorded_at: now(),
					operation: "cross_rebase",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "applied",
					operational_commit: after,
					leader_head_after: newLeaderHead,
					worker_head_before: before,
					worker_head_after: after,
					worktree_path: worker.worktree_path,
					detail: "Runtime rebase moved worker history onto updated leader head.",
				});
			} else {
				const conflictFiles = listConflictFiles(worker.worktree_path);
				runGitResult(worker.worktree_path, ["rebase", "--abort"]);
				integrationByWorker[worker.id] = {
					...(integrationByWorker[worker.id] ?? {}),
					conflict_commit: before ?? newLeaderHead,
					conflict_files: conflictFiles,
					...integrationNowState("rebase_conflict"),
				};
				await appendIntegrationEvent(dir, "worker_cross_rebase_conflict", worker, {
					worker_name: worker.id,
					leader_head: newLeaderHead,
					conflict_files: conflictFiles,
					stderr: rebase.stderr || rebase.stdout,
					summary: `cross-rebase conflict for ${worker.id}`,
				});
				await appendIntegrationReport(dir, {
					worker: worker.id,
					operation: "rebase",
					files: conflictFiles,
					detail: `rebase failed and was aborted: ${(rebase.stderr || rebase.stdout).slice(0, 200)}`,
				});
				await notifyIntegrationConflict(
					config,
					worker,
					`CONFLICT: cross-rebase failed for ${worker.id}; files: ${conflictFiles.join(",") || "unknown"}. Manual resolution required; runtime aborted the rebase and did not auto-resolve.`,
					cwd,
					env,
				);
				hygieneEntries.push({
					recorded_at: now(),
					operation: "cross_rebase",
					worker_name: worker.id,
					task_id: worker.assigned_tasks[0],
					status: "conflict",
					leader_head_after: newLeaderHead,
					worker_head_before: before,
					worker_head_after: resolveHead(worker.worktree_path),
					worktree_path: worker.worktree_path,
					detail: `Runtime cross-rebase failed and was aborted: ${(rebase.stderr || rebase.stdout).slice(0, 200)}`,
				});
			}
		}
	}
	await appendCommitHygieneEntries(config, hygieneEntries);
	return integrationByWorker;
}

const writeInitialGjcTeamTask = (dir: string, task: GjcTeamTask) =>
	withGjcTeamTaskMutation(taskStore(dir), capability => capability.writeRecovered(task));

export async function startGjcTeam(options: GjcTeamStartOptions): Promise<GjcTeamSnapshot> {
	return startGjcTeamLaunch(
		{
			maxWorkers: GJC_TEAM_MAX_WORKERS,
			resolveWorkerCliPlan: resolveGjcTeamWorkerCliPlan,
			resolveStateRoot: resolveGjcTeamStateRoot,
			sanitizeName,
			makeTeamName,
			teamDir,
			resolveDefaultWorktreeMode,
			resolveTmuxBinary: resolveGjcTmuxBinary,
			readTmuxLeaderContext: readCurrentTmuxLeaderContext,
			buildWorkers,
			buildInitialTasks,
			ensureWorkerWorktree,
			rollbackCreatedWorktrees,
			resolveWorkerCommand: resolveGjcWorkerCommand,
			mailboxDirPath,
			mailboxPath,
			workerDir,
			workerLifecyclePath,
			writeJson: writeJsonFile,
			now,
			writePhase,
			writeTask: writeInitialGjcTeamTask,
			appendEvent,
			appendTelemetry,
			startTmuxSession,
			killWorkerPanes,
			writeWorkerLifecycleForConfig,
			readSnapshot: readGjcTeamSnapshot,
		},
		options,
	);
}

export async function readGjcTeamSnapshot(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	options: GjcTeamSnapshotOptions = {},
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const storedPhase = await readPhase(dir);
	const tasks = await readTasks(dir);
	const taskCounts: Record<GjcTeamTaskStatus, number> = {
		pending: 0,
		blocked: 0,
		in_progress: 0,
		completed: 0,
		failed: 0,
	};
	for (const task of tasks) taskCounts[task.status] += 1;
	const monitor = await readJsonFile<GjcTeamMonitorSnapshot>(monitorSnapshotPath(dir));
	const workerLifecycleById = await readWorkerLifecycleById(dir, config);
	const notificationSummary =
		options.reconcileNotifications === true
			? await reconcileTeamNotifications(teamNotificationRuntime, dir, config)
			: summarizeTeamNotifications(await listNotificationRecords(dir));
	const phase = await resolveGjcTeamSnapshotPhase(dir, config, storedPhase, tasks, monitor);
	return {
		team_name: config.team_name,
		display_name: config.display_name,
		phase,
		state_dir: dir,
		tmux_session: config.tmux_session,
		tmux_session_name: config.tmux_session_name,
		tmux_target: config.tmux_target,
		task_total: tasks.length,
		task_counts: taskCounts,
		workers: config.workers,
		integration_by_worker: monitor?.integration_by_worker,
		worker_lifecycle_by_id: workerLifecycleById,
		notification_summary: notificationSummary,
		updated_at: config.updated_at,
	};
}
export async function monitorGjcTeamSnapshot(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const snapshot = await monitorGjcTeam(teamName, cwd, env);
	return snapshot;
}
function workerIntegrationFingerprint(head: string | null, classification: GjcWorkerCheckpointClassification): string {
	return `${head ?? "no-head"}:${classification.kind}:${classification.files.join("\0")}`;
}

export async function requestGjcWorkerIntegrationAttempt(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	options: GjcWorkerIntegrationAttemptOptions = {},
): Promise<GjcWorkerIntegrationAttemptRequestResult> {
	const teamName = env.GJC_TEAM_NAME?.trim();
	const worker = env.GJC_TEAM_WORKER_ID?.trim() || env.GJC_TEAM_INTERNAL_WORKER?.split("/").pop()?.trim();
	if (!teamName || !worker) return { requested: false, reason: "not_worker" };
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfigForWorkerIntegration(dir);
	const configuredWorker = config.workers.find(candidate => candidate.id === worker);
	const worktreePath = env.GJC_TEAM_WORKTREE_PATH?.trim() || configuredWorker?.worktree_path;
	if (!worktreePath || !(await pathExists(worktreePath)))
		return {
			requested: false,
			reason: "missing_worktree",
			worker,
			team_name: teamName,
		};
	const [classification, head] = await Promise.all([
		classifyWorkerCheckpointStatusAsync(worktreePath, options.signal),
		resolveHeadAsync(worktreePath, options.signal),
	]);
	if (classification.kind === "git_error") {
		const reportWorker = configuredWorker ?? {
			id: worker,
			name: worker,
			index: 0,
			agent_type: "unknown",
			role: "unknown",
			status: "idle",
			last_heartbeat: now(),
			assigned_tasks: [],
		};
		const detail = classification.detail;
		await appendIntegrationEvent(dir, "worker_integration_attempt_failed", reportWorker, {
			worker_name: worker,
			worktree_path: worktreePath,
			detail,
			retryable: true,
			summary: `retryable worker integration request failure for ${worker}: ${detail}`,
		});
		await notifyLeader(
			config,
			reportWorker,
			`INTEGRATION RETRYABLE FAILURE: ${worker} git inspection failed (${detail}). A later turn can retry.`,
			cwd,
			env,
		);
		return { requested: false, reason: "git_error", worker, team_name: teamName, head, status: classification.kind };
	}
	if (classification.kind === "protected_only") {
		return {
			requested: false,
			reason: "no_changes",
			worker,
			team_name: teamName,
			head,
			status: classification.kind,
		};
	}
	if (classification.kind === "clean" && configuredWorker?.worktree_base_ref === head) {
		return {
			requested: false,
			reason: "no_changes",
			worker,
			team_name: teamName,
			head,
			status: classification.kind,
		};
	}
	const fingerprint = workerIntegrationFingerprint(head, classification);
	const dedupePath = workerIntegrationDedupePath(dir, worker);
	const dedupe = (await readJsonFile<GjcWorkerIntegrationDedupeState>(dedupePath)) ?? {};
	if (dedupe.last_requested_fingerprint === fingerprint) {
		return {
			requested: false,
			reason: "deduped",
			worker,
			team_name: teamName,
			fingerprint,
			head,
			status: classification.kind,
		};
	}
	await writeJsonFile(dedupePath, {
		last_requested_fingerprint: fingerprint,
		last_requested_head: head,
		last_requested_status: classification.kind,
		last_requested_at: now(),
	} satisfies GjcWorkerIntegrationDedupeState);
	await appendEvent(dir, {
		type: "worker_integration_attempt_requested",
		worker,
		message: `Worker ${worker} requested leader integration attempt`,
		data: {
			worker_name: worker,
			worker_head: head,
			status: classification.kind,
			files: classification.files,
		},
	});
	await sendGjcTeamMessage(
		teamName,
		worker,
		"leader-fixed",
		`INTEGRATION REQUESTED: ${worker} has ${classification.kind} git changes at ${head?.slice(0, 12) ?? "unknown-head"}.`,
		cwd,
		env,
	).catch(() => undefined);
	await appendCommitHygieneEntries(config, [
		{
			recorded_at: now(),
			operation: "leader_integration_attempt",
			worker_name: worker,
			task_id: configuredWorker?.assigned_tasks[0],
			status: "applied",
			source_commit: head ?? undefined,
			worker_head_after: head,
			worktree_path: worktreePath,
			detail: "Worker turn-end requested a leader integration attempt for semantic git changes.",
		},
	]);
	return {
		requested: true,
		reason: "requested",
		worker,
		team_name: teamName,
		fingerprint,
		head,
		status: classification.kind,
	};
}

export async function buildTeamHudSummary(
	snapshot: GjcTeamSnapshot,
	latestEvent?: GjcTeamEvent,
	latestMessage?: GjcTeamMailboxMessage,
): Promise<WorkflowHudSummary> {
	return buildWorkflowTeamHudSummary({
		phase: snapshot.phase,
		task_total: snapshot.task_total,
		task_counts: snapshot.task_counts,
		workers: snapshot.workers,
		updated_at: snapshot.updated_at,
		latestEvent,
		latestMessage,
	});
}

const GJC_TEAM_AUTO_CONTINUE_STALLED_WORKERS_ENV = "GJC_TEAM_AUTO_CONTINUE_STALLED_WORKERS";
const GJC_TEAM_CONTINUATION_DISPATCH_TIMEOUT_MS = 5_000;

async function validateGjcContinuationEligibility(
	dir: string,
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	task: GjcTeamTask,
	heartbeatAt: string,
	staleMs: number,
	env: NodeJS.ProcessEnv,
	reservedHoldUntil?: string,
): Promise<string | null> {
	const phase = await readContinuationJson<Record<string, unknown>>(path.join(dir, "phase.json"));
	if (
		phase?.current_phase !== "running" ||
		typeof phase.updated_at !== "string" ||
		!Number.isFinite(Date.parse(phase.updated_at))
	)
		return "invalid_or_absent_running_phase";
	if (
		!worker.pane_id ||
		!/^%\d+$/.test(worker.pane_id) ||
		worker.pane_id === config.leader.pane_id ||
		!paneBelongsToTeamTarget(config, worker.pane_id)
	)
		return "invalid_pane_authority";
	const shutdownAuthority = await readGjcShutdownAuthority(
		workerRuntime,
		path.join(workerDir(dir, worker.id), "shutdown-request.json"),
	);
	if (shutdownAuthority.state === "valid_present") return "shutdown_requested";
	if (shutdownAuthority.state === "invalid_or_unreadable") return "invalid_shutdown_authority";
	const heartbeat = await readWorkerHeartbeat(workerRuntime, config.team_name, worker.id, config.leader_cwd, env);
	if (!heartbeat || heartbeat.last_turn_at !== heartbeatAt || currentTimeMs() - Date.parse(heartbeatAt) < staleMs)
		return "heartbeat_changed";
	const lifecycle = (await readLifecycleById(workerRuntime, dir, config))[worker.id];
	const status = await readWorkerStatus(workerRuntime, config.team_name, worker.id, config.leader_cwd, env);
	if (
		(lifecycle?.lifecycle_state !== "ready" && lifecycle?.lifecycle_state !== "working") ||
		!["idle", "working", "blocked", "done"].includes(status.state) ||
		typeof status.updated_at !== "string" ||
		!Number.isFinite(Date.parse(status.updated_at))
	)
		return "invalid_worker_lifecycle_or_status";
	const inventory = await readGjcContinuationAuthorityInventory(dir);
	if (!inventory.valid) return "invalid_authority_inventory";
	const authority = selectGjcContinuationWorkerAuthority(inventory, worker.id);
	if (
		!authority.valid ||
		authority.task.id !== task.id ||
		authority.task.version !== task.version ||
		authority.task.claim?.owner !== task.claim?.owner ||
		authority.task.claim?.token !== task.claim?.token ||
		authority.task.claim?.leased_until !== task.claim?.leased_until
	)
		return "claim_changed";
	const leaseUntil = Date.parse(task.claim?.leased_until ?? "");
	const holdUntil = reservedHoldUntil === undefined ? undefined : Date.parse(reservedHoldUntil);
	if (!Number.isFinite(leaseUntil) || leaseUntil <= currentTimeMs()) return "invalid_or_expired_lease";
	if (holdUntil !== undefined && (!Number.isFinite(holdUntil) || leaseUntil < holdUntil))
		return "lease_does_not_cover_hold";
	if (reservedHoldUntil !== undefined && shouldDispatchWorkerWithSendKeys(config.tmux_command))
		return "unsupported_send_keys_transport";
	return null;
}
function normalizeGjcContinuationDispatchError(value: unknown, fallback: string, maxLength: number): string {
	try {
		const normalized = String(value ?? "")
			.replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
			.trim()
			.slice(0, maxLength);
		return normalized || fallback;
	} catch {
		return fallback;
	}
}

function readGjcContinuationDispatchErrorField(error: unknown, field: "name" | "code" | "message"): unknown {
	try {
		return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[field] : undefined;
	} catch {
		return undefined;
	}
}
async function continueStalledGjcTeamWorkers(
	dir: string,
	config: GjcTeamConfig,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (env[GJC_TEAM_AUTO_CONTINUE_STALLED_WORKERS_ENV] !== "1" || config.dry_run) return;
	const phase = await readContinuationJson<unknown>(path.join(dir, "phase.json"));

	if (
		typeof phase !== "object" ||
		phase === null ||
		Array.isArray(phase) ||
		(phase as Record<string, unknown>).current_phase !== "running" ||
		typeof (phase as Record<string, unknown>).updated_at !== "string" ||
		!Number.isFinite(Date.parse(String((phase as Record<string, unknown>).updated_at)))
	) {
		await appendEvent(dir, {
			type: "continuation_skipped",
			message: "Continuation requires a valid running team phase record",
			data: { reason: "invalid_or_absent_running_phase" },
		});
		return;
	}
	const staleMs = parseHeartbeatStaleMs(env);
	if (staleMs <= 0) return;
	const inventory = await readGjcContinuationAuthorityInventory(dir);
	if (!inventory.valid) {
		await appendEvent(dir, {
			type: "continuation_skipped",
			message: "Continuation requires a complete canonical task and claim authority inventory",
			data: { reason: "invalid_authority_inventory" },
		});
		return;
	}
	for (const worker of config.workers) {
		const heartbeat = await readWorkerHeartbeat(workerRuntime, config.team_name, worker.id, config.leader_cwd, env);
		const heartbeatAt = Date.parse(heartbeat?.last_turn_at ?? "");
		if (!heartbeat || !Number.isFinite(heartbeatAt) || currentTimeMs() - heartbeatAt < staleMs) continue;
		if (!worker.pane_id || !/^%\d+$/.test(worker.pane_id) || worker.pane_id === config.leader.pane_id) continue;
		if (!paneBelongsToTeamTarget(config, worker.pane_id)) continue;
		const shutdownAuthority = await readGjcShutdownAuthority(
			workerRuntime,
			path.join(workerDir(dir, worker.id), "shutdown-request.json"),
		);
		if (shutdownAuthority.state !== "proven_absent") {
			await appendEvent(dir, {
				type: "continuation_skipped",
				worker: worker.id,
				message: "Continuation requires a readable absent shutdown authority record",
				data: {
					reason:
						shutdownAuthority.state === "valid_present" ? "shutdown_requested" : "invalid_shutdown_authority",
				},
			});
			continue;
		}

		const lifecycle = (await readLifecycleById(workerRuntime, dir, config))[worker.id];
		const status = await readWorkerStatus(workerRuntime, config.team_name, worker.id, config.leader_cwd, env);
		if (
			(lifecycle?.lifecycle_state !== "ready" && lifecycle?.lifecycle_state !== "working") ||
			!["idle", "working", "blocked", "done"].includes(status.state) ||
			typeof status.updated_at !== "string" ||
			!Number.isFinite(Date.parse(status.updated_at))
		) {
			await appendEvent(dir, {
				type: "continuation_skipped",
				worker: worker.id,
				message: "Continuation requires valid worker lifecycle and status records",
				data: { reason: "invalid_worker_lifecycle_or_status" },
			});
			continue;
		}

		const authority = selectGjcContinuationWorkerAuthority(inventory, worker.id);
		if (!authority.valid) {
			await appendEvent(dir, {
				type: "continuation_skipped",
				worker: worker.id,
				message: "Continuation requires exactly one canonical current in-progress claim",
				data: { reason: "invalid_claim_count", task_count: authority.taskCount, claim_count: authority.claimCount },
			});
			continue;
		}
		const task = authority.task;
		const eligibilityReason = await validateGjcContinuationEligibility(
			dir,
			config,
			worker,
			task,
			heartbeat.last_turn_at,
			staleMs,
			env,
		);
		if (eligibilityReason) {
			await appendEvent(dir, {
				type: "continuation_skipped",
				worker: worker.id,
				message: "Continuation eligibility changed or contains an invalid mutable record",
				data: { reason: eligibilityReason },
			});
			continue;
		}

		const incident = stableHash(
			[
				config.team_name,
				worker.id,
				task.id,
				task.claim.owner,
				task.claim.token,
				task.version,
				heartbeat.last_turn_at,
				worker.pane_id,
				config.tmux_target,
			].join(":"),
		);
		const journalDir = path.join(workerDir(dir, worker.id), "continuations", incident);
		const firstReservationPath = path.join(journalDir, "attempt-01.reservation.json");
		const firstOutcomePath = path.join(journalDir, "attempt-01.outcome.json");
		const firstReservation = await readContinuationJson<Record<string, unknown>>(firstReservationPath);

		const firstOutcome = await readContinuationJson<Record<string, unknown>>(firstOutcomePath);

		let attempt = 1;
		if (firstReservation) {
			if (
				!isValidGjcContinuationReservation(
					firstReservation,
					incident,
					1,
					config,
					worker.id,
					task,
					task.claim,
					heartbeat.last_turn_at,
					worker.pane_id,
				)
			)
				continue;
			if (
				!isValidGjcContinuationOutcome(firstOutcome, firstReservation, incident, 1) ||
				firstOutcome.result !== "sent"
			)
				continue;
			const firstHold = Date.parse(String(firstOutcome.hold_until));
			const leaseUntil = Date.parse(task.claim.leased_until);
			if (
				!Number.isFinite(firstHold) ||
				!Number.isFinite(leaseUntil) ||
				leaseUntil < firstHold ||
				currentTimeMs() < firstHold
			)
				continue;
			if (await readContinuationJson(path.join(journalDir, "attempt-02.reservation.json"))) continue;

			attempt = 2;
		}
		const holdMs = attempt === 1 ? 30_000 : 120_000;
		const reservedAtMs = currentTimeMs();
		const reservedAt = new Date(reservedAtMs).toISOString();
		const holdUntil = new Date(reservedAtMs + holdMs).toISOString();
		const leaseUntil = Date.parse(task.claim.leased_until);
		if (!Number.isFinite(leaseUntil) || leaseUntil < Date.parse(holdUntil)) continue;
		const reservation = {
			schema_version: 1,
			incident_hash: incident,
			team_name: config.team_name,
			worker: worker.id,
			task_id: task.id,
			owner: task.claim.owner,
			claim_token: task.claim.token,
			task_version: task.version,
			leased_until: task.claim.leased_until,
			heartbeat_at: heartbeat.last_turn_at,
			pane_id: worker.pane_id,
			tmux_target: config.tmux_target,
			attempt,
			reserved_at: reservedAt,
			hold_until: holdUntil,
			prompt_version: 1,
			prompt_sha256: createHash("sha256").update(GJC_TEAM_CONTINUATION_PROMPT).digest("hex"),
			dispatch_protocol: "tmux_command_sequence_v1",
		};
		const reservationPath = path.join(journalDir, `attempt-0${attempt}.reservation.json`);
		try {
			await createJsonNoClobber(
				reservationPath,
				reservation,
				stateWriterOptions(reservationPath, "state", "continuation-reservation"),
			);
		} catch (error) {
			if (error instanceof AlreadyExistsError) continue;
			throw error;
		}
		let result: "sent" | "unknown" = "unknown";
		let outcomeReason = "tmux_missing_exit_code";
		let tmuxExitCode: number | undefined;
		let tmuxError: { name: string; code?: string; message: string } | undefined;
		let dispatchedAt: string | undefined;
		let dispatchHoldUntil: string | undefined;
		if (gjcTeamRuntimeTestSeams?.continuationBeforeDispatch)
			await gjcTeamRuntimeTestSeams.continuationBeforeDispatch();
		const revalidationReason = await validateGjcContinuationEligibility(
			dir,
			config,
			worker,
			task,
			heartbeat.last_turn_at,
			staleMs,
			env,
			new Date(currentTimeMs() + GJC_TEAM_CONTINUATION_DISPATCH_TIMEOUT_MS + holdMs).toISOString(),
		);
		if (revalidationReason) {
			const skippedPath = path.join(journalDir, `attempt-0${attempt}.outcome.json`);
			await createJsonNoClobber(
				skippedPath,
				{
					schema_version: 1,
					incident_hash: incident,
					attempt,
					reservation_sha256: gjcContinuationReservationDigest(reservation),
					recorded_at: now(),
					result: "skipped",
					reason: revalidationReason,
				},
				stateWriterOptions(skippedPath, "state", "continuation-outcome"),
			);
			return;
		}
		try {
			const args = Object.freeze([
				"send-keys",
				"-l",
				"-t",
				worker.pane_id,
				GJC_TEAM_CONTINUATION_PROMPT,
				";",
				"send-keys",
				"-t",
				worker.pane_id,
				"Enter",
			]);
			const dispatch = gjcTeamRuntimeTestSeams?.continuationTmuxDispatch
				? gjcTeamRuntimeTestSeams.continuationTmuxDispatch(config.tmux_command, args)
				: Bun.spawnSync([config.tmux_command, ...args], {
						stdout: "ignore",
						stderr: "ignore",
						timeout: GJC_TEAM_CONTINUATION_DISPATCH_TIMEOUT_MS,
					});
			const dispatchAtMs = currentTimeMs();
			tmuxExitCode = dispatch.exitCode;
			if (dispatch.exitCode === 0) {
				result = "sent";
				outcomeReason = "tmux_sent";
				dispatchedAt = new Date(dispatchAtMs).toISOString();
				dispatchHoldUntil = new Date(dispatchAtMs + holdMs).toISOString();
			} else if (typeof dispatch.exitCode === "number") {
				outcomeReason = "tmux_nonzero_exit";
			}
		} catch (error) {
			outcomeReason = "tmux_dispatch_threw";
			const name = normalizeGjcContinuationDispatchError(
				readGjcContinuationDispatchErrorField(error, "name"),
				"Error",
				120,
			);
			const code = normalizeGjcContinuationDispatchError(
				readGjcContinuationDispatchErrorField(error, "code"),
				"",
				120,
			);
			tmuxError = {
				name,
				...(code ? { code } : {}),
				message: normalizeGjcContinuationDispatchError(
					readGjcContinuationDispatchErrorField(error, "message") ?? error,
					"tmux_dispatch_error",
					400,
				),
			};
		}
		const outcomePath = path.join(journalDir, `attempt-0${attempt}.outcome.json`);
		try {
			await createJsonNoClobber(
				outcomePath,
				{
					schema_version: 1,
					incident_hash: incident,
					attempt,
					reservation_sha256: gjcContinuationReservationDigest(reservation),
					recorded_at: now(),
					result,
					reason: outcomeReason,
					...(tmuxExitCode === undefined ? {} : { tmux_exit_code: tmuxExitCode }),
					...(dispatchedAt === undefined || dispatchHoldUntil === undefined
						? {}
						: { dispatched_at: dispatchedAt, hold_until: dispatchHoldUntil }),
					...(tmuxError ? { tmux_error: tmuxError } : {}),
				},
				stateWriterOptions(outcomePath, "state", "continuation-outcome"),
			);
		} catch (error) {
			if (!(error instanceof AlreadyExistsError)) throw error;
			const existing = await readContinuationJson<Record<string, unknown>>(outcomePath);
			if (!isValidGjcContinuationOutcome(existing, reservation, incident, attempt))
				throw new Error(`invalid_continuation_outcome:${incident}:${attempt}`);
		}
		return;
	}
}

export async function monitorGjcTeam(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const previous = await readJsonFile<GjcTeamMonitorSnapshot>(monitorSnapshotPath(dir));
	await withGjcTeamTaskMutation(taskStore(dir), async capability => {
		const config = await readConfig(dir);
		await continueStalledGjcTeamWorkers(dir, config, env);
		await reconcileGjcTeamStaleClaimsUnlocked(workerOrchestrationRuntime, teamName, dir, config, env, capability);
		await computeLifecycleNudges(config, dir, cwd, env);
	});
	const integrationByWorker = await integrateGjcWorkerCommits(config, dir, previous, cwd, env);
	await writeJsonFile(monitorSnapshotPath(dir), {
		integration_by_worker: integrationByWorker,
		updated_at: now(),
	});
	await replayGjcTeamNotifications(teamName, cwd, env);
	return readGjcTeamSnapshot(teamName, cwd, env);
}
export async function listGjcTeams(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot[]> {
	const root = resolveGjcTeamStateRoot(cwd, env);
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const snapshots = await Promise.all(
			entries
				.filter(entry => entry.isDirectory())
				.map(entry => readGjcTeamSnapshot(entry.name, cwd, env).catch(() => null)),
		);
		return snapshots.filter((snapshot): snapshot is GjcTeamSnapshot => snapshot != null);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

function parsePaneAttemptResult(value: string): GjcTeamPaneAttemptResult {
	if (value === "sent" || value === "queued" || value === "deferred" || value === "failed") return value;
	throw new Error(`invalid_pane_attempt_result:${value}`);
}
async function writeGjcWorkerStartupAck(
	teamName: string,
	worker: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamMutationFence(dir, () => writeWorkerStartupAck(workerRuntime, teamName, worker, cwd, env, input));
}
function parseDurationEnv(env: NodeJS.ProcessEnv, name: string, fallbackMs: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallbackMs;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

function parseHeartbeatStaleMs(env: NodeJS.ProcessEnv): number {
	const raw = env.GJC_TEAM_HEARTBEAT_STALE_MS?.trim();
	if (!raw) return 120_000;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : 120_000;
}
async function writeLifecycleNudge(
	dir: string,
	worker: string,
	condition: string,
	severity: "warning" | "error",
	suggestedAction: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const fingerprint = `nudge-${stableHash([worker, condition].join(":"))}`;
	const nudgePath = path.join(workerDir(dir, worker), "nudges", `${fingerprint}.json`);
	const existing = await readJsonFile<Record<string, unknown>>(nudgePath);
	const nowMs = Date.now();
	const cooldownMs = parseDurationEnv(env, "GJC_TEAM_NUDGE_COOLDOWN_MS", 30_000);
	const cooldownUntil = typeof existing?.cooldown_until === "string" ? Date.parse(existing.cooldown_until) : 0;
	if (existing && Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) return;
	const firstSeen = typeof existing?.first_seen_at === "string" ? existing.first_seen_at : now();
	const count = typeof existing?.count === "number" ? existing.count + 1 : 1;
	const record = {
		fingerprint,
		worker,
		condition,
		severity,
		first_seen_at: firstSeen,
		last_seen_at: now(),
		cooldown_until: new Date(nowMs + cooldownMs).toISOString(),
		count,
		suggested_action: suggestedAction,
		auto_action_taken: false,
	};
	try {
		await writeJsonFile(nudgePath, record);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	await appendEvent(dir, {
		type: "worker_lifecycle_nudge",
		worker,
		message: suggestedAction,
		data: { condition, severity, fingerprint, auto_action_taken: false },
	});
	await writeNotificationRecord(dir, {
		id: `ntf-${stableHash(["worker_lifecycle", worker, condition].join(":"))}`,
		kind: "worker_lifecycle",
		team_name: path.basename(dir),
		recipient: "leader-fixed",
		source: { type: "worker", id: worker },
		delivery_state: "pending",
		created_at: firstSeen,
		updated_at: now(),
		replay_count: 0,
	});
}
async function computeLifecycleNudges(
	config: GjcTeamConfig,
	dir: string,
	_cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const startupGraceMs = parseDurationEnv(env, "GJC_TEAM_STARTUP_GRACE_MS", 30_000);
	const heartbeatStaleMs = parseHeartbeatStaleMs(env);
	const createdAt = Date.parse(config.created_at);
	const ageMs = Date.now() - (Number.isFinite(createdAt) ? createdAt : Date.now());
	for (const worker of config.workers) {
		try {
			await fs.access(workerDir(dir, worker.id));
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		const ack = await readJsonFile<Record<string, unknown>>(path.join(workerDir(dir, worker.id), "startup-ack.json"));
		if (!ack && ageMs >= startupGraceMs) {
			await writeLifecycleNudge(
				dir,
				worker.id,
				"missing_startup_ack",
				"warning",
				`Worker ${worker.id} has not sent startup ACK; leader may inspect or relaunch manually.`,
				env,
			);
		}
		const heartbeat = await readGjcWorkerHeartbeat(config.team_name, worker.id, config.leader.cwd, {
			...env,
			GJC_TEAM_STATE_ROOT: config.state_root,
		});
		const heartbeatAt = Date.parse(heartbeat?.last_turn_at ?? worker.last_heartbeat);
		if (heartbeatStaleMs > 0 && Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt >= heartbeatStaleMs) {
			await writeLifecycleNudge(
				dir,
				worker.id,
				"stale_heartbeat",
				"warning",
				`Worker ${worker.id} heartbeat is stale; leader may inspect or relaunch manually.`,
				env,
			);
		}
		if (worker.status === "stopped") {
			await writeLifecycleNudge(
				dir,
				worker.id,
				"worker_stopped",
				"error",
				`Worker ${worker.id} is stopped before team completion; leader action is required.`,
				env,
			);
		}
	}
}

export async function shutdownGjcTeam(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamMutationFence(dir, () => shutdownGjcTeamWorkers(workerOrchestrationRuntime, teamName, cwd, env));
}

function taskStore(dir: string): GjcTeamTaskStore {
	return new GjcTeamTaskStore(dir, async event => {
		await appendEvent(dir, event);
	});
}

export async function listGjcTeamTasks(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask[]> {
	return taskStore(await findTeamDir(teamName, cwd, env)).list();
}
export async function readGjcTeamTask(
	teamName: string,
	taskId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	return taskStore(await findTeamDir(teamName, cwd, env)).read(taskId);
}
export async function createGjcTeamTask(
	teamName: string,
	subject: string,
	description: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	taskOptions: GjcTeamTaskMetadataInput = {},
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamTaskMutation(taskStore(dir), async capability => {
		const config = await readConfig(dir);
		if (taskOptions.owner) assertKnownWorker(config, taskOptions.owner);
		const task = await capability.create(subject, description, taskOptions);
		config.updated_at = now();
		await writeJsonFile(path.join(dir, "config.json"), config);
		return task;
	});
}
export async function updateGjcTeamTask(
	teamName: string,
	taskId: string,
	updates: Partial<
		Pick<
			GjcTeamTask,
			"subject" | "description" | "blocked_by" | "depends_on" | "lane" | "required_role" | "allowed_roles"
		>
	>,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	return taskStore(dir).update(taskId, updates);
}
export async function claimGjcTeamTask(
	teamName: string,
	workerId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	taskId?: string,
): Promise<GjcTeamApiClaimResult> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamTaskMutation(taskStore(dir), async capability => {
		const config = await readConfig(dir);
		const worker = findKnownWorker(config, workerId);
		const recovered = await reconcileGjcTeamStaleClaimsUnlocked(
			workerOrchestrationRuntime,
			teamName,
			dir,
			config,
			env,
			capability,
		);
		const reasons = recovered.stale_workers[workerId];
		if (reasons?.length) return { ok: false, reason: `worker_not_live:${workerId}:${reasons.join(",")}` };
		const status = await readWorkerStatus(workerRuntime, teamName, workerId, cwd, env);
		if (
			!["idle", "working", "blocked", "done"].includes(status.state) ||
			typeof status.updated_at !== "string" ||
			!Number.isFinite(Date.parse(status.updated_at))
		)
			return { ok: false, reason: `worker_not_live:${workerId}:invalid_status` };
		return capability.claim(worker, taskId);
	});
}
export async function transitionGjcTeamTaskStatus(
	teamName: string,
	taskId: string,
	status: GjcTeamTaskStatus,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	claimToken?: string,
	workerId?: string,
	completionEvidenceInput?: unknown,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamTaskMutation(taskStore(dir), async capability => {
		if (workerId) assertKnownWorker(await readConfig(dir), workerId);
		return capability.transition(taskId, status, claimToken, workerId, completionEvidenceInput);
	});
}
export async function transitionGjcTeamTask(
	teamName: string,
	taskId: string,
	status: GjcTeamTaskStatus | "complete",
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	claimToken?: string,
	completionEvidenceInput?: unknown,
): Promise<GjcTeamTask> {
	return transitionGjcTeamTaskStatus(
		teamName,
		taskId,
		parseGjcTeamTaskStatus(status, true),
		cwd,
		env,
		claimToken,
		undefined,
		completionEvidenceInput,
	);
}
export async function releaseGjcTeamTaskClaim(
	teamName: string,
	taskId: string,
	claimToken: string,
	workerId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	return taskStore(dir).release(taskId, claimToken, workerId);
}

async function listNotificationRecords(dir: string): Promise<GjcTeamNotification[]> {
	const notificationsDir = path.join(dir, "notifications");
	try {
		const entries = await fs.readdir(notificationsDir, { withFileTypes: true });
		const records = await Promise.all(
			entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => readJsonFile<GjcTeamNotification>(path.join(notificationsDir, entry.name))),
		);
		return records
			.filter((record): record is GjcTeamNotification => record != null)
			.sort((a, b) => a.id.localeCompare(b.id));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
async function readNotificationRecord(dir: string, notificationId: string): Promise<GjcTeamNotification> {
	assertSafeId("notification_id", notificationId);
	const notification = await readJsonFile<GjcTeamNotification>(notificationPath(dir, notificationId));
	if (!notification) throw new Error(`notification_not_found:${notificationId}`);
	return notification;
}
function mergeNotificationState(
	current: GjcTeamNotificationDeliveryState,
	next: GjcTeamNotificationDeliveryState,
): GjcTeamNotificationDeliveryState {
	const rank: Record<GjcTeamNotificationDeliveryState, number> = {
		pending: 0,
		queued: 1,
		deferred: 1,
		failed: 1,
		sent: 2,
		delivered: 3,
		acknowledged: 4,
	};
	return rank[next] >= rank[current] ? next : current;
}
async function writeNotificationRecord(dir: string, notification: GjcTeamNotification): Promise<GjcTeamNotification> {
	const existing = await readJsonFile<GjcTeamNotification>(notificationPath(dir, notification.id));
	const merged: GjcTeamNotification = existing
		? {
				...existing,
				...notification,
				delivery_state: mergeNotificationState(existing.delivery_state, notification.delivery_state),
				created_at: existing.created_at,
				replay_count: Math.max(existing.replay_count ?? 0, notification.replay_count ?? 0),
				updated_at: now(),
			}
		: notification;
	await writeJsonFile(notificationPath(dir, merged.id), merged);
	return merged;
}
async function readLegacyMailbox(dir: string, worker: string): Promise<{ messages: GjcTeamMailboxMessage[] }> {
	return (await readJsonFile<{ messages: GjcTeamMailboxMessage[] }>(mailboxPath(dir, worker))) ?? { messages: [] };
}
async function readMailbox(dir: string, worker: string): Promise<{ messages: GjcTeamMailboxMessage[] }> {
	assertSafeId("worker_id", worker);
	const byId = new Map<string, GjcTeamMailboxMessage>();
	for (const message of (await readLegacyMailbox(dir, worker)).messages ?? []) byId.set(message.message_id, message);
	try {
		const entries = await fs.readdir(mailboxDirPath(dir, worker), {
			withFileTypes: true,
		});
		const records = await Promise.all(
			entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => readJsonFile<GjcTeamMailboxMessage>(path.join(mailboxDirPath(dir, worker), entry.name))),
		);
		for (const message of records) if (message) byId.set(message.message_id, message);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return {
		messages: [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
	};
}
async function writeLegacyMailboxView(dir: string, worker: string): Promise<void> {
	const current = await readMailbox(dir, worker);
	await writeJsonFile(mailboxPath(dir, worker), current);
}
async function writeMailboxMessage(
	dir: string,
	worker: string,
	message: GjcTeamMailboxMessage,
): Promise<GjcTeamMailboxMessage> {
	assertSafeId("message_id", message.message_id);
	const filePath = mailboxMessagePath(dir, worker, message.message_id);
	const existing = await readJsonFile<GjcTeamMailboxMessage>(filePath);
	if (existing) {
		if (
			existing.from_worker !== message.from_worker ||
			existing.to_worker !== message.to_worker ||
			existing.body !== message.body
		) {
			throw new Error(`message_id_conflict:${message.message_id}`);
		}
		const merged = {
			...existing,
			...message,
			notified_at: existing.notified_at ?? message.notified_at,
			delivered_at: existing.delivered_at ?? message.delivered_at,
		};
		await writeJsonFile(filePath, merged);
		await writeLegacyMailboxView(dir, worker);
		return merged;
	}
	const created = await writeJsonFileNoClobber(filePath, message);
	if (!created) return writeMailboxMessage(dir, worker, message);
	await writeLegacyMailboxView(dir, worker);
	return message;
}
const teamNotificationRuntime: TeamNotificationRuntime = {
	findTeamDir,
	readConfig,
	assertKnownParticipant,
	messageId: messageIdFor,
	messageNotificationId,
	now,
	randomId: randomUUID,
	appendEvent: async (dir, event) => {
		await appendEvent(dir, event);
	},
	readMailbox,
	writeMailboxMessage,
	listNotifications: listNotificationRecords,
	readNotification: readNotificationRecord,
	writeNotification: writeNotificationRecord,
};

export async function replayGjcTeamNotifications(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	transport?: GjcTeamMailboxDeliveryTransport,
): Promise<{
	notifications: GjcTeamNotification[];
	summary: GjcTeamNotificationSummary;
}> {
	return replayTeamNotifications(teamNotificationRuntime, teamName, cwd, env, transport);
}

export async function sendGjcTeamMessage(
	teamName: string,
	fromWorker: string,
	toWorker: string,
	body: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	idempotencyKey?: string,
	transport?: GjcTeamMailboxDeliveryTransport,
): Promise<GjcTeamMailboxMessage> {
	return sendTeamMessage(
		teamNotificationRuntime,
		teamName,
		fromWorker,
		toWorker,
		body,
		cwd,
		env,
		idempotencyKey,
		transport,
	);
}

export async function broadcastGjcTeamMessage(
	teamName: string,
	fromWorker: string,
	body: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	idempotencyKey?: string,
): Promise<GjcTeamMailboxMessage[]> {
	const config = await readConfig(await findTeamDir(teamName, cwd, env));
	return Promise.all(
		config.workers.map(worker =>
			sendGjcTeamMessage(
				teamName,
				fromWorker,
				worker.id,
				body,
				cwd,
				env,
				idempotencyKey ? `${idempotencyKey}:${worker.id}` : undefined,
			),
		),
	);
}

export async function listGjcTeamMailbox(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamMailboxMessage[]> {
	return listTeamMailbox(teamNotificationRuntime, teamName, worker, cwd, env);
}

export async function markGjcTeamMailboxMessage(
	teamName: string,
	worker: string,
	messageId: string,
	field: "delivered_at" | "notified_at",
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamMailboxMessage> {
	assertSafeId("message_id", messageId);
	return markTeamMailboxMessage(teamNotificationRuntime, teamName, worker, messageId, field, cwd, env);
}
export const readGjcWorkerStatus = (
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerStatusFile> => readWorkerStatus(workerRuntime, teamName, worker, cwd, env);
export async function updateGjcWorkerStatus(
	teamName: string,
	worker: string,
	status: GjcWorkerStatusState,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	currentTaskId?: string,
	reason?: string,
): Promise<WorkerStatusFile> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamMutationFence(dir, () =>
		updateWorkerStatus(workerRuntime, teamName, worker, status, cwd, env, currentTaskId, reason),
	);
}
export const readGjcWorkerHeartbeat = (
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile | null> => readWorkerHeartbeat(workerRuntime, teamName, worker, cwd, env);
export async function updateGjcWorkerHeartbeat(
	teamName: string,
	worker: string,
	heartbeat: WorkerHeartbeatFile,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamMutationFence(dir, () =>
		updateWorkerHeartbeat(workerRuntime, teamName, worker, heartbeat, cwd, env),
	);
}
export async function writeGjcWorkerInbox(
	teamName: string,
	worker: string,
	content: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string }> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	const filePath = path.join(workerDir(dir, worker), "inbox.md");
	await writeReport(filePath, content, stateWriterOptions(filePath, "report", "write"));
	return { path: filePath };
}
export async function writeGjcWorkerIdentity(
	teamName: string,
	worker: GjcTeamWorker,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamWorker> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker.id);
	await writeJsonFile(path.join(workerDir(dir, worker.id), "identity.json"), worker);
	return worker;
}
export async function readGjcTeamEvents(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamEvent[]> {
	const dir = await findTeamDir(teamName, cwd, env);
	try {
		const text = await Bun.file(path.join(dir, "events.jsonl")).text();
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map(line => JSON.parse(line) as GjcTeamEvent);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
export async function readGjcTeamTraces(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTraceEvent[]> {
	const dir = await findTeamDir(teamName, cwd, env);
	try {
		const text = await Bun.file(tracePath(dir)).text();
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map(line => JSON.parse(line) as GjcTeamTraceEvent);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
export async function appendGjcTeamEvent(
	teamName: string,
	type: string,
	worker = "leader-fixed",
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamEvent> {
	return appendEvent(await findTeamDir(teamName, cwd, env), { type, worker });
}
export async function awaitGjcTeamEvent(
	teamName: string,
	_timeoutMs = 0,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: "event" | "timeout"; event?: GjcTeamEvent }> {
	const events = await readGjcTeamEvents(teamName, cwd, env);
	const event = events.at(-1);
	return event ? { status: "event", event } : { status: "timeout" };
}
export async function writeGjcMonitorSnapshot(
	teamName: string,
	snapshot: unknown,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	await writeJsonFile(monitorSnapshotPath(await findTeamDir(teamName, cwd, env)), snapshot);
	return snapshot;
}
export async function readGjcMonitorSnapshot(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	return readJsonFile<unknown>(monitorSnapshotPath(await findTeamDir(teamName, cwd, env)));
}
export async function writeGjcTaskApproval(
	teamName: string,
	taskId: string,
	approval: Record<string, unknown>,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
	assertSafeId("task_id", taskId);
	await writeJsonFile(path.join(await findTeamDir(teamName, cwd, env), "approvals", `${taskId}.json`), approval);
	return approval;
}
export async function readGjcTaskApproval(
	teamName: string,
	taskId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
	assertSafeId("task_id", taskId);
	return readJsonFile<Record<string, unknown>>(
		path.join(await findTeamDir(teamName, cwd, env), "approvals", `${taskId}.json`),
	);
}
export async function writeGjcShutdownRequest(
	teamName: string,
	worker: string,
	requestedBy: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	requestId = `shutdown-${stableHash([teamName, worker, now(), randomUUID()].join(":"))}`,
	mode: GjcTeamShutdownMode = "graceful",
	requestedAt = now(),
): Promise<Record<string, unknown>> {
	const dir = await findTeamDir(teamName, cwd, env);
	return withGjcTeamMutationFence(dir, () =>
		writeShutdownRequest(workerRuntime, teamName, worker, requestedBy, cwd, env, requestId, mode, requestedAt),
	);
}
export const readGjcShutdownAck = (
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> => readShutdownAck(workerRuntime, teamName, worker, cwd, env);

export async function executeGjcTeamApiOperation(
	operation: string,
	input: Record<string, unknown>,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	const teamName = String(input.team_name ?? input.teamName ?? "").trim();
	if (!teamName) throw new Error("missing_team_name");
	const workerInput = input.worker ?? input.worker_id ?? input.workerId;
	const worker = String(workerInput ?? "worker-1");
	const explicitWorker = workerInput == null ? undefined : String(workerInput);
	switch (operation) {
		case "list-tasks":
			return { tasks: await listGjcTeamTasks(teamName, cwd, env) };
		case "read-task":
			return {
				task: await readGjcTeamTask(teamName, String(input.task_id ?? input.taskId), cwd, env),
			};
		case "create-task": {
			const task = await createGjcTeamTask(
				teamName,
				String(input.subject ?? "Task"),
				String(input.description ?? ""),
				cwd,
				env,
				taskMetadataFromInput(input, true),
			);
			return { ok: true, ...taskReceiptFields(teamName, task) };
		}
		case "update-task": {
			const task = await updateGjcTeamTask(
				teamName,
				String(input.task_id ?? input.taskId),
				{
					subject: typeof input.subject === "string" ? input.subject : undefined,
					description: typeof input.description === "string" ? input.description : undefined,
					...taskMetadataFromInput(input),
				},
				cwd,
				env,
			);
			return { ok: true, ...taskReceiptFields(teamName, task) };
		}
		case "claim-task": {
			const requestedTaskId = input.task_id ?? input.taskId;
			const result = await claimGjcTeamTask(
				teamName,
				worker,
				cwd,
				env,
				typeof requestedTaskId === "string" ? requestedTaskId : undefined,
			);
			return {
				ok: result.ok,
				reason: result.reason,
				team_name: teamName,
				worker_id: result.worker_id ?? worker,
				...(result.task ? taskReceiptFields(teamName, result.task) : {}),
				claim_token: result.claim_token,
			};
		}
		case "transition-task":
		case "transition-task-status": {
			const task = await transitionGjcTeamTaskStatus(
				teamName,
				String(input.task_id ?? input.taskId),
				parseGjcTeamTaskStatus(input.to ?? input.status),
				cwd,
				env,
				typeof input.claim_token === "string" ? input.claim_token : undefined,
				explicitWorker,
				input.completion_evidence ?? input.completionEvidence,
			);
			return {
				ok: true,
				...taskReceiptFields(teamName, task),
				worker_id: explicitWorker ?? task.owner ?? task.assignee,
			};
		}
		case "release-task-claim": {
			const task = await releaseGjcTeamTaskClaim(
				teamName,
				String(input.task_id),
				String(input.claim_token),
				worker,
				cwd,
				env,
			);
			return {
				ok: true,
				...taskReceiptFields(teamName, task),
				worker_id: worker,
			};
		}
		case "send-message": {
			const message = await sendGjcTeamMessage(
				teamName,
				String(input.from_worker),
				String(input.to_worker),
				String(input.body),
				cwd,
				env,
				typeof input.idempotency_key === "string" ? input.idempotency_key : undefined,
			);
			return { ok: true, ...mailboxMessageReceiptFields(teamName, message) };
		}
		case "broadcast": {
			const messages = await broadcastGjcTeamMessage(
				teamName,
				String(input.from_worker),
				String(input.body),
				cwd,
				env,
				typeof input.idempotency_key === "string" ? input.idempotency_key : undefined,
			);
			return {
				ok: true,
				team_name: teamName,
				message_ids: messages.map(message => message.message_id),
				delivery_states: messages.map(message => ({
					message_id: message.message_id,
					to_worker: message.to_worker,
					delivered: Boolean(message.delivered_at),
					notified: Boolean(message.notified_at),
				})),
			};
		}
		case "mailbox-list":
			return { messages: await listGjcTeamMailbox(teamName, worker, cwd, env) };
		case "mailbox-mark-delivered": {
			const message = await markGjcTeamMailboxMessage(
				teamName,
				worker,
				String(input.message_id),
				"delivered_at",
				cwd,
				env,
			);
			return { ok: true, ...mailboxMessageReceiptFields(teamName, message) };
		}
		case "mailbox-mark-notified": {
			const message = await markGjcTeamMailboxMessage(
				teamName,
				worker,
				String(input.message_id),
				"notified_at",
				cwd,
				env,
			);
			return { ok: true, ...mailboxMessageReceiptFields(teamName, message) };
		}
		case "notification-list": {
			const dir = await findTeamDir(teamName, cwd, env);
			const config = await readConfig(dir);
			await reconcileTeamNotifications(teamNotificationRuntime, dir, config);
			const notifications = await listNotificationRecords(dir);
			const result = {
				notifications,
				summary: summarizeTeamNotifications(notifications),
			};
			return notificationSummaryReceipt(teamName, result);
		}
		case "notification-read":
			return {
				notification: await readNotificationRecord(
					await findTeamDir(teamName, cwd, env),
					String(input.notification_id),
				),
			};
		case "notification-replay":
			return notificationSummaryReceipt(teamName, await replayGjcTeamNotifications(teamName, cwd, env));
		case "notification-mark-pane-attempt": {
			const dir = await findTeamDir(teamName, cwd, env);
			const notification = await readNotificationRecord(dir, String(input.notification_id));
			const updated = await writeNotificationRecord(dir, {
				...notification,
				delivery_state: parsePaneAttemptResult(String(input.result ?? "failed")),
				pane_attempt_result: parsePaneAttemptResult(String(input.result ?? "failed")),
				pane_attempt_reason: String(input.reason ?? "manual_api"),
				pane_attempt_at: now(),
				updated_at: now(),
			});
			return { ok: true, ...notificationReceiptFields(updated) };
		}
		case "worker-startup-ack":
			return writeGjcWorkerStartupAck(teamName, worker, cwd, env, input);
		case "read-config":
			return await readConfig(await findTeamDir(teamName, cwd, env));
		case "read-manifest":
			return readJsonFile(path.join(await findTeamDir(teamName, cwd, env), "manifest.v2.json"));
		case "read-worker-status":
			return readGjcWorkerStatus(teamName, worker, cwd, env);
		case "update-worker-status": {
			const currentTaskIdInput = input.current_task_id ?? input.currentTaskId;
			return updateGjcWorkerStatus(
				teamName,
				worker,
				parseRequiredGjcWorkerStatusState(input.status ?? input.state),
				cwd,
				env,
				typeof currentTaskIdInput === "string" ? currentTaskIdInput : undefined,
				typeof input.reason === "string" ? input.reason : undefined,
			);
		}
		case "read-worker-heartbeat":
			return readGjcWorkerHeartbeat(teamName, worker, cwd, env);
		case "recover-stale-claims":
			return recoverGjcTeamStaleClaims(teamName, cwd, env);
		case "update-worker-heartbeat":
			return updateGjcWorkerHeartbeat(
				teamName,
				worker,
				{
					pid: Number(input.pid ?? 0),
					last_turn_at: now(),
					turn_count: Number(input.turn_count ?? 0),
					alive: Boolean(input.alive ?? true),
				},
				cwd,
				env,
			);
		case "write-worker-inbox":
			return writeGjcWorkerInbox(teamName, worker, String(input.content ?? ""), cwd, env);
		case "write-worker-identity":
			return writeGjcWorkerIdentity(
				teamName,
				{
					id: worker,
					name: worker,
					index: Number(input.index ?? 1),
					agent_type: String(input.role ?? "executor"),
					role: String(input.role ?? "executor"),
					status: "idle",
					last_heartbeat: now(),
					assigned_tasks: Array.isArray(input.assigned_tasks) ? input.assigned_tasks.map(String) : [],
				},
				cwd,
				env,
			);
		case "append-event":
			return appendGjcTeamEvent(teamName, String(input.type ?? "event"), worker, cwd, env);
		case "read-events":
			return { events: await readGjcTeamEvents(teamName, cwd, env) };
		case "read-traces":
			return { traces: await readGjcTeamTraces(teamName, cwd, env) };
		case "await-event":
			return awaitGjcTeamEvent(teamName, Number(input.timeout_ms ?? 0), cwd, env);
		case "write-monitor-snapshot":
			return writeGjcMonitorSnapshot(teamName, input.snapshot ?? {}, cwd, env);
		case "read-monitor-snapshot":
			return readGjcMonitorSnapshot(teamName, cwd, env);
		case "write-task-approval":
			return writeGjcTaskApproval(teamName, String(input.task_id), input, cwd, env);
		case "read-task-approval":
			return readGjcTaskApproval(teamName, String(input.task_id), cwd, env);
		case "write-shutdown-request": {
			const shutdownRequestIdInput = input.request_id ?? input.requestId;
			return writeGjcShutdownRequest(
				teamName,
				worker,
				String(input.requested_by ?? input.requestedBy ?? "leader-fixed"),
				cwd,
				env,
				typeof shutdownRequestIdInput === "string" ? shutdownRequestIdInput : undefined,
				parseGjcTeamShutdownMode(input.mode),
			);
		}
		case "read-shutdown-ack":
			return readGjcShutdownAck(teamName, worker, cwd, env);
		default:
			throw new Error(`unknown_team_api_operation:${operation}`);
	}
}

export function parseTeamLaunchArgs(argv: string[]): GjcTeamStartOptions {
	const parsedWorktree = parseWorktreeMode(argv);
	const positionals = parsedWorktree.remainingArgs.filter(arg => !arg.startsWith("--"));
	const dryRun = argv.includes("--dry-run");
	let workerCount = GJC_TEAM_DEFAULT_WORKERS;
	let agentType = "executor";
	let taskStartIndex = 0;
	const first = positionals[0] ?? "";
	const countRole = first.match(/^(\d+):([a-zA-Z][a-zA-Z0-9_-]*)$/);
	const countOnly = first.match(/^(\d+)$/);
	const roleOnly = first.match(/^([a-zA-Z][a-zA-Z0-9_-]*)$/);
	if (countRole) {
		workerCount = Number.parseInt(countRole[1] ?? "", 10);
		agentType = countRole[2] ?? "executor";
		taskStartIndex = 1;
	} else if (countOnly) {
		workerCount = Number.parseInt(countOnly[1] ?? "", 10);
		taskStartIndex = 1;
	} else if (roleOnly && positionals.length > 1) {
		agentType = roleOnly[1] ?? "executor";
		taskStartIndex = 1;
	}
	const task = positionals.slice(taskStartIndex).join(" ").trim();
	if (!task) throw new Error("missing_team_task");
	if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > GJC_TEAM_MAX_WORKERS)
		throw new Error(`invalid_team_worker_count:${workerCount}:expected_1_${GJC_TEAM_MAX_WORKERS}`);
	return {
		workerCount,
		agentType,
		task,
		dryRun,
		worktreeMode: resolveDefaultWorktreeMode(parsedWorktree.mode),
	};
}
