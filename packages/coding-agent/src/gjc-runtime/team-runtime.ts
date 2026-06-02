import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowHudSummary } from "../skill-state/active-state";
import { buildTeamHudSummary as buildWorkflowTeamHudSummary } from "../skill-state/workflow-hud";
import { applyGjcTmuxProfile } from "./launch-tmux";
import {
	AlreadyExistsError,
	appendJsonl as appendJsonlAudited,
	appendText,
	createJsonNoClobber,
	deleteIfOwned,
	removeFileAudited,
	writeJsonAtomic,
	writeReport,
} from "./state-writer";

export type GjcTeamPhase = "starting" | "running" | "awaiting_integration" | "complete" | "failed" | "cancelled";
export type GjcTeamTaskStatus = "pending" | "blocked" | "in_progress" | "completed" | "failed";
export type GjcWorkerStatusState = "idle" | "working" | "blocked" | "done" | "failed" | "draining" | "unknown";

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

export interface GjcTeamTaskClaim {
	owner: string;
	token: string;
	leased_until: string;
}

export interface GjcTeamTask {
	id: string;
	subject: string;
	description: string;
	title: string;
	objective: string;
	status: GjcTeamTaskStatus;
	assignee?: string;
	owner?: string;
	result?: string;
	error?: string;
	blocked_by?: string[];
	depends_on?: string[];
	version: number;
	claim?: GjcTeamTaskClaim;
	created_at: string;
	updated_at: string;
	completed_at?: string;
}

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

export type GjcTeamNotificationDeliveryState =
	| "pending"
	| "sent"
	| "queued"
	| "deferred"
	| "failed"
	| "delivered"
	| "acknowledged";

export type GjcTeamPaneAttemptResult = "sent" | "queued" | "deferred" | "failed";

export interface GjcTeamNotification {
	id: string;
	kind: "mailbox_message" | "worker_lifecycle" | "invalid_attempt";
	team_name: string;
	recipient: string;
	source: { type: "message" | "task" | "worker" | "event"; id: string };
	idempotency_key?: string;
	delivery_state: GjcTeamNotificationDeliveryState;
	pane_attempt_result?: GjcTeamPaneAttemptResult;
	pane_attempt_reason?: string;
	pane_attempt_at?: string;
	created_at: string;
	updated_at: string;
	replay_count: number;
}

export interface GjcTeamNotificationSummary {
	total: number;
	replay_eligible: number;
	by_state: Record<GjcTeamNotificationDeliveryState, number>;
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
	notification_summary: GjcTeamNotificationSummary;
	updated_at: string;
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
}

export interface GjcTeamApiClaimResult {
	ok: boolean;
	task?: GjcTeamTask;
	worker_id?: string;
	claim_token?: string;
	reason?: string;
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
interface WorkerStatusFile {
	state: GjcWorkerStatusState;
	current_task_id?: string;
	reason?: string;
	updated_at: string;
}
interface WorkerHeartbeatFile {
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
	"read-worker-heartbeat",
	"update-worker-heartbeat",
	"write-worker-inbox",
	"write-worker-identity",
	"append-event",
	"read-events",
	"await-event",
	"write-shutdown-request",
	"read-shutdown-ack",
	"read-monitor-snapshot",
	"write-monitor-snapshot",
	"read-task-approval",
	"write-task-approval",
] as const;

function now(): string {
	return new Date().toISOString();
}
function isEnoent(error: unknown): error is FsError {
	return typeof error === "object" && error !== null && "code" in error && (error as FsError).code === "ENOENT";
}
function stateWriterOptions(filePath: string, category: "state" | "ledger" | "report" | "prune", verb: string) {
	const resolved = path.resolve(filePath);
	const marker = `${path.sep}.gjc${path.sep}`;
	const markerIndex = resolved.indexOf(marker);
	const cwd = markerIndex >= 0 ? resolved.slice(0, markerIndex) : process.cwd();
	return { cwd, audit: { category, verb, owner: "gjc-runtime" as const } };
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
function safePathSegment(kind: string, value: string): string {
	assertSafeId(kind, value);
	return value;
}
function taskPath(dir: string, taskId: string): string {
	return path.join(dir, "tasks", `${safePathSegment("task_id", taskId)}.json`);
}
function taskEvidencePath(dir: string, taskId: string): string {
	return path.join(dir, "evidence", "tasks", `${safePathSegment("task_id", taskId)}.json`);
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
	return path.join(cwd, ".gjc", "state", "team");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
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
async function appendEvent(dir: string, event: Omit<GjcTeamEvent, "ts" | "event_id">): Promise<GjcTeamEvent> {
	const full = { event_id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`, ts: now(), ...event };
	await appendJsonl(path.join(dir, "events.jsonl"), full);
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
async function readPhase(dir: string): Promise<GjcTeamPhase> {
	const phase = await readJsonFile<{ current_phase?: GjcTeamPhase }>(path.join(dir, "phase.json"));
	return phase?.current_phase ?? "running";
}
async function writePhase(dir: string, phase: GjcTeamPhase): Promise<void> {
	await writeJsonFile(path.join(dir, "phase.json"), { current_phase: phase, updated_at: now() });
}

function teamModeStatePath(): string {
	return path.join(".gjc", "state", "team-state.json");
}

export async function persistGjcTeamModeStateSummary(snapshot: GjcTeamSnapshot, cwd = process.cwd()): Promise<void> {
	const active = snapshot.phase !== "complete" && snapshot.phase !== "cancelled";
	const updatedAt = now();
	await writeJsonAtomic(
		teamModeStatePath(),
		{
			skill: "team",
			version: 1,
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
				nowIso: updatedAt,
			},
			audit: { category: "state", verb: "sync-team-summary", owner: "gjc-runtime", skill: "team" },
		},
	);
}

function normalizeTask(raw: GjcTeamTask): GjcTeamTask {
	const status = raw.status === ("complete" as GjcTeamTaskStatus) ? "completed" : raw.status;
	return {
		...raw,
		status,
		subject: raw.subject ?? raw.title,
		description: raw.description ?? raw.objective,
		title: raw.title ?? raw.subject,
		objective: raw.objective ?? raw.description,
		version: raw.version ?? 1,
	};
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
	if (tasks.length === 0 || !tasks.every(task => task.status === "completed")) return storedPhase;
	return (await hasPendingGjcTeamIntegration(dir, config, monitor)) ? "awaiting_integration" : storedPhase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null;
}
function isGjcTeamTaskRecord(value: unknown): value is GjcTeamTask {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.status === "string" &&
		(isGjcTeamTaskStatus(value.status) || value.status === "complete") &&
		(typeof value.subject === "string" || typeof value.title === "string") &&
		(typeof value.description === "string" || typeof value.objective === "string")
	);
}
function isGjcTeamTaskFile(entry: { isFile(): boolean; name: string }): boolean {
	return entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".evidence.json");
}

async function readTasks(dir: string): Promise<GjcTeamTask[]> {
	try {
		const entries = await fs.readdir(path.join(dir, "tasks"), { withFileTypes: true });
		const tasks = await Promise.all(
			entries.filter(isGjcTeamTaskFile).map(entry => readJsonFile<unknown>(path.join(dir, "tasks", entry.name))),
		);
		return tasks
			.filter(isGjcTeamTaskRecord)
			.map(normalizeTask)
			.sort((a, b) => a.id.localeCompare(b.id));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
async function writeTask(dir: string, task: GjcTeamTask): Promise<void> {
	await writeJsonFile(taskPath(dir, task.id), normalizeTask(task));
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
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
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

function parseWorktreeMode(args: string[]): { mode: GjcTeamWorktreeMode; remainingArgs: string[] } {
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
async function ensureWorkerWorktree(
	cwd: string,
	dir: string,
	teamName: string,
	worker: GjcTeamWorker,
	mode: GjcTeamWorktreeMode,
): Promise<GjcTeamWorker> {
	if (!mode.enabled) return worker;
	if (!isGitRepository(cwd)) throw new Error(`team_worktree_requires_git_repo:${cwd}`);
	const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const baseRef = runGit(repoRoot, ["rev-parse", "HEAD"]);
	const worktreePath = path.join(dir, "worktrees", worker.id);
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

export function resolveGjcTmuxCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env.GJC_TEAM_TMUX_COMMAND?.trim() || "tmux";
}
function readCurrentTmuxLeaderContext(tmuxCommand: string, env: NodeJS.ProcessEnv): GjcTmuxLeaderContext {
	const paneTarget = env.TMUX_PANE?.trim();
	const args = paneTarget
		? ["display-message", "-p", "-t", paneTarget, "#S:#I #{pane_id}"]
		: ["display-message", "-p", "#S:#I #{pane_id}"];
	const result = Bun.spawnSync([tmuxCommand, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "team_requires_current_tmux_context");
	const [sessionAndWindow = "", leaderPaneId = ""] = result.stdout.toString().trim().split(/\s+/);
	const [sessionName = "", windowIndex = ""] = sessionAndWindow.split(":");
	if (!sessionName || !windowIndex || !leaderPaneId.startsWith("%"))
		throw new Error(`invalid_tmux_context:${result.stdout.toString().trim()}`);
	return { sessionName, windowIndex, leaderPaneId, target: `${sessionName}:${windowIndex}` };
}
export function resolveGjcWorkerCommand(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GJC_TEAM_WORKER_COMMAND?.trim();
	if (explicit) return explicit;
	const entrypoint = process.argv[1];
	if (entrypoint?.endsWith(".ts"))
		return `${shellQuote(process.execPath)} ${shellQuote(path.resolve(cwd, entrypoint))}`;
	if (entrypoint && path.basename(entrypoint).startsWith("gjc")) return shellQuote(path.resolve(cwd, entrypoint));
	return "gjc";
}
function buildWorkerCommand(config: GjcTeamConfig, worker: GjcTeamWorker): string {
	const workspace = worker.worktree_path
		? `Worker worktree: ${worker.worktree_path}.`
		: `Worker cwd: ${config.leader.cwd}.`;
	const prompt = [
		`You are ${worker.id} in gjc team ${config.team_name}.`,
		`Team state root: ${config.state_root}.`,
		workspace,
		`Task: ${config.task}`,
		`Before claiming work, send startup ACK: gjc team api worker-startup-ack --input '{"team_name":"${config.team_name}","worker_id":"${worker.id}","protocol_version":"1"}' --json.`,
		`Use gjc team api claim-task/transition-task-status with this worker id, record evidence, and do not mutate leader-owned goal state.`,
	].join("\n");
	const env = [
		`GJC_TEAM_WORKER=${shellQuote(`${config.team_name}/${worker.id}`)}`,
		`GJC_TEAM_INTERNAL_WORKER=${shellQuote(`${config.team_name}/${worker.id}`)}`,
		`GJC_TEAM_NAME=${shellQuote(config.team_name)}`,
		`GJC_TEAM_WORKER_ID=${shellQuote(worker.id)}`,
		`GJC_TEAM_STATE_ROOT=${shellQuote(config.state_root)}`,
		`GJC_TEAM_LEADER_CWD=${shellQuote(config.leader.cwd)}`,
		`GJC_TEAM_DISPLAY_NAME=${shellQuote(config.display_name)}`,
		...(worker.worktree_path ? [`GJC_TEAM_WORKTREE_PATH=${shellQuote(worker.worktree_path)}`] : []),
	];
	return `${env.join(" ")} ${config.worker_command} ${shellQuote(prompt)}`;
}
function buildInitialTasks(task: string, workers: GjcTeamWorker[]): GjcTeamTask[] {
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
	if (dryRun) return config.workers.map(worker => ({ ...worker, pane_id: `%dry-run-${worker.id}` }));
	const rollbackPaneIds: string[] = [];
	try {
		const workers: GjcTeamWorker[] = [];
		let rightStackRootPaneId: string | null = null;
		for (const worker of config.workers) {
			const splitDirection: string = worker.index === 1 ? "-h" : "-v";
			const splitTarget: string =
				worker.index === 1 ? config.leader.pane_id : (rightStackRootPaneId ?? config.leader.pane_id);
			const split: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync(
				[
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
					worker.worktree_path ?? config.leader.cwd,
					buildWorkerCommand(config, worker),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (split.exitCode !== 0)
				throw new Error(split.stderr.toString().trim() || `tmux_split_failed:${config.tmux_target}:${worker.id}`);
			const paneId: string = split.stdout.toString().trim().split(/\r?\n/)[0]?.trim() ?? "";
			if (!paneId.startsWith("%")) throw new Error(`tmux_split_missing_pane:${config.tmux_target}:${worker.id}`);
			rollbackPaneIds.push(paneId);
			if (worker.index === 1) rightStackRootPaneId = paneId;
			workers.push({ ...worker, pane_id: paneId });
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
			data: { tmux_target: config.tmux_target, panes: workers.map(worker => worker.pane_id).filter(Boolean) },
		});
		return workers;
	} catch (error) {
		for (const paneId of rollbackPaneIds)
			Bun.spawnSync([config.tmux_command, "kill-pane", "-t", paneId], { stdout: "ignore", stderr: "ignore" });
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
	return path.join(config.leader_cwd, ".gjc", "reports", "team-commit-hygiene", `${config.team_name}.ledger.json`);
}
function integrationNowState(
	status: GjcTeamIntegrationStatus,
): Pick<GjcTeamWorkerIntegrationState, "status" | "updated_at"> {
	return { status, updated_at: now() };
}
async function appendIntegrationReport(
	dir: string,
	entry: { worker: string; operation: "merge" | "cherry-pick" | "rebase"; files: string[]; detail: string },
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
	const existing = (await readJsonFile<{ version: number; entries: GjcTeamCommitHygieneEntry[] }>(ledgerPath)) ?? {
		version: 1,
		entries: [],
	};
	await writeJsonFile(ledgerPath, { version: 1, entries: [...existing.entries, ...entries] });
}
function resolveHead(cwd: string): string | null {
	return tryRunGit(cwd, ["rev-parse", "HEAD"]);
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

export type GjcWorkerCheckpointClassification =
	| { kind: "clean"; files: string[] }
	| { kind: "eligible"; files: string[] }
	| { kind: "protected_only"; files: string[] }
	| { kind: "conflicted"; files: string[] }
	| { kind: "git_error"; files: string[]; detail: string };

const UNMERGED_GIT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const PROTECTED_WORKER_CHECKPOINT_PREFIXES = [
	".gjc/state/",
	".gjc/logs/",
	".gjc/reports/",
	".gjc/tmp/",
	".gjc/ultragoal/",
];

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

export function classifyGjcTeamCheckpointFiles(files: string[]): { eligible: string[]; protected: string[] } {
	const eligible: string[] = [];
	const protectedFiles: string[] = [];
	for (const file of files) {
		const normalized = normalizeGitStatusPath(file);
		if (
			PROTECTED_WORKER_CHECKPOINT_PREFIXES.some(
				prefix => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
			)
		)
			protectedFiles.push(file);
		else eligible.push(file);
	}
	return { eligible, protected: protectedFiles };
}

export function classifyWorkerCheckpointStatus(cwd: string): GjcWorkerCheckpointClassification {
	const status = runGitResult(cwd, ["status", "--porcelain", "-uall"]);
	if (!status.ok) {
		return { kind: "git_error", files: [], detail: status.stderr || status.stdout || "git status failed" };
	}
	if (!status.stdout.trim()) return { kind: "clean", files: [] };
	const files = parsePorcelainStatusFiles(status.stdout);
	const hasUnmergedStatus = status.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.some(line => UNMERGED_GIT_STATUS_CODES.has(line.slice(0, 2)));
	const conflictFiles = listConflictFiles(cwd);
	if (hasUnmergedStatus || conflictFiles.length > 0) {
		return { kind: "conflicted", files: conflictFiles.length > 0 ? conflictFiles : files };
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
	return { committed: true, commit: resolveHead(worker.worktree_path), classification };
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
					integrationByWorker[worker.id] = { ...state, ...integrationNowState("integration_failed") };
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
				integrationByWorker[worker.id] = { ...state, ...integrationNowState("integration_failed") };
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

async function initializeStateDirs(dir: string, workers: GjcTeamWorker[]): Promise<void> {
	// Empty mailbox directories are runtime state, so they must exist before messages arrive.
	await fs.mkdir(path.join(dir, "mailbox"), { recursive: true });
	for (const worker of workers) {
		await fs.mkdir(mailboxDirPath(dir, worker.id), { recursive: true });
		await writeJsonFile(mailboxPath(dir, worker.id), { messages: [] });
		await writeJsonFile(path.join(workerDir(dir, worker.id), "status.json"), { state: "idle", updated_at: now() });
		await writeJsonFile(path.join(workerDir(dir, worker.id), "heartbeat.json"), {
			pid: 0,
			last_turn_at: now(),
			turn_count: 0,
			alive: true,
		});
	}
	// Empty leader mailbox directory is runtime state, so it must exist before messages arrive.
	await fs.mkdir(mailboxDirPath(dir, "leader-fixed"), { recursive: true });
	await writeJsonFile(mailboxPath(dir, "leader-fixed"), { messages: [] });
}

export async function startGjcTeam(options: GjcTeamStartOptions): Promise<GjcTeamSnapshot> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	if (!Number.isInteger(options.workerCount) || options.workerCount < 1 || options.workerCount > GJC_TEAM_MAX_WORKERS)
		throw new Error(`invalid_team_worker_count:${options.workerCount}:expected_1_${GJC_TEAM_MAX_WORKERS}`);
	const workerCliPlan = resolveGjcTeamWorkerCliPlan(options.workerCount, env);
	const stateRoot = resolveGjcTeamStateRoot(cwd, env);
	const teamName = sanitizeName(options.teamName ?? makeTeamName(options.task, env));
	const displayName = sanitizeName(options.teamName ?? options.task).slice(0, 30) || teamName;
	const dir = teamDir(stateRoot, teamName);
	const createdAt = now();
	const worktreeMode = resolveDefaultWorktreeMode(options.worktreeMode);
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const tmuxContext = options.dryRun
		? { sessionName: "dry-run", windowIndex: "0", leaderPaneId: "%dry-run-leader", target: "dry-run:0" }
		: readCurrentTmuxLeaderContext(tmuxCommand, env);
	const initialWorkers = buildWorkers(options.workerCount, options.agentType, stateRoot);
	const workers: GjcTeamWorker[] = [];
	try {
		for (const worker of initialWorkers)
			workers.push(options.dryRun ? worker : await ensureWorkerWorktree(cwd, dir, teamName, worker, worktreeMode));
	} catch (error) {
		await rollbackCreatedWorktrees(workers);
		throw error;
	}
	const config: GjcTeamConfig = {
		team_name: teamName,
		display_name: displayName,
		requested_name: options.teamName ?? displayName,
		task: options.task,
		agent_type: options.agentType,
		worker_count: options.workerCount,
		max_workers: GJC_TEAM_MAX_WORKERS,
		state_root: stateRoot,
		worker_command: resolveGjcWorkerCommand(cwd, env),
		worker_cli_plan: workerCliPlan,
		tmux_command: tmuxCommand,
		tmux_session: tmuxContext.sessionName,
		tmux_session_name: tmuxContext.sessionName,
		tmux_target: tmuxContext.target,
		workspace_mode: worktreeMode.enabled ? "worktree" : "direct",
		dry_run: options.dryRun ?? false,
		leader: { session_id: env.GJC_SESSION_ID ?? env.CODEX_SESSION_ID ?? "", pane_id: tmuxContext.leaderPaneId, cwd },
		leader_cwd: cwd,
		team_state_root: stateRoot,
		workers,
		created_at: createdAt,
		updated_at: createdAt,
	};
	await initializeStateDirs(dir, config.workers);
	await writeJsonFile(path.join(dir, "config.json"), config);
	await writeJsonFile(path.join(dir, "manifest.v2.json"), {
		version: 2,
		team_name: config.team_name,
		display_name: config.display_name,
		requested_name: config.requested_name,
		tmux_session: config.tmux_session,
		tmux_session_name: config.tmux_session_name,
		tmux_target: config.tmux_target,
		worker_command: config.worker_command,
		worker_cli_plan: config.worker_cli_plan,
		tmux_command: config.tmux_command,
		leader: config.leader,
		workers: config.workers,
		workspace_mode: config.workspace_mode,
		dry_run: config.dry_run,
		created_at: createdAt,
		updated_at: createdAt,
	});
	await writePhase(dir, "starting");
	for (const task of buildInitialTasks(options.task, config.workers)) await writeTask(dir, task);
	await appendEvent(dir, {
		type: "team_started",
		message: options.dryRun
			? "Created native gjc team dry-run state without starting tmux workers"
			: "Started native gjc team runtime",
		data: {
			worker_count: options.workerCount,
			agent_type: options.agentType,
			workspace_mode: config.workspace_mode,
			dry_run: config.dry_run,
		},
	});
	await appendTelemetry(dir, {
		type: "team_runtime",
		message: options.dryRun ? "Native gjc team dry-run state initialized" : "Native gjc team runtime initialized",
		data: {
			state_root: stateRoot,
			worker_command: config.worker_command,
			worker_cli_plan: workerCliPlan,
			workspace_mode: config.workspace_mode,
			dry_run: config.dry_run,
		},
	});
	let tmuxWorkers: GjcTeamWorker[];
	try {
		tmuxWorkers = await startTmuxSession(config, dir, options.dryRun ?? false, env);
	} catch (error) {
		await writePhase(dir, "failed");
		await appendEvent(dir, {
			type: "team_start_failed",
			message: error instanceof Error ? error.message : String(error),
		});
		killWorkerPanes(config);
		await rollbackCreatedWorktrees(config.workers);
		throw error;
	}
	const runningConfig = {
		...config,
		workers: tmuxWorkers.map(worker => ({ ...worker, status: "idle" as const, last_heartbeat: now() })),
		updated_at: now(),
	};
	await writeJsonFile(path.join(dir, "config.json"), runningConfig);
	await writePhase(dir, "running");
	return readGjcTeamSnapshot(teamName, cwd, env);
}

export async function readGjcTeamSnapshot(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
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
	const notificationSummary = await reconcileTeamNotifications(dir, config);
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
		notification_summary: notificationSummary,
		updated_at: config.updated_at,
	};
}
function workerIntegrationFingerprint(head: string | null, classification: GjcWorkerCheckpointClassification): string {
	return `${head ?? "no-head"}:${classification.kind}:${classification.files.join("\0")}`;
}

export async function requestGjcWorkerIntegrationAttempt(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcWorkerIntegrationAttemptRequestResult> {
	const teamName = env.GJC_TEAM_NAME?.trim();
	const worker = env.GJC_TEAM_WORKER_ID?.trim() || env.GJC_TEAM_INTERNAL_WORKER?.split("/").pop()?.trim();
	if (!teamName || !worker) return { requested: false, reason: "not_worker" };
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const configuredWorker = config.workers.find(candidate => candidate.id === worker);
	const worktreePath = env.GJC_TEAM_WORKTREE_PATH?.trim() || configuredWorker?.worktree_path;
	if (!worktreePath || !(await pathExists(worktreePath)))
		return { requested: false, reason: "missing_worktree", worker, team_name: teamName };
	const classification = classifyWorkerCheckpointStatus(worktreePath);
	const head = resolveHead(worktreePath);
	if (classification.kind === "git_error") {
		return { requested: false, reason: "git_error", worker, team_name: teamName, head, status: classification.kind };
	}
	if (classification.kind === "protected_only") {
		return { requested: false, reason: "no_changes", worker, team_name: teamName, head, status: classification.kind };
	}
	if (classification.kind === "clean" && configuredWorker?.worktree_base_ref === head) {
		return { requested: false, reason: "no_changes", worker, team_name: teamName, head, status: classification.kind };
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
		data: { worker_name: worker, worker_head: head, status: classification.kind, files: classification.files },
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

export async function monitorGjcTeam(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const previous = await readJsonFile<GjcTeamMonitorSnapshot>(monitorSnapshotPath(dir));
	const integrationByWorker = await integrateGjcWorkerCommits(config, dir, previous, cwd, env);
	await writeJsonFile(monitorSnapshotPath(dir), { integration_by_worker: integrationByWorker, updated_at: now() });
	await replayGjcTeamNotifications(teamName, cwd, env);
	await computeLifecycleNudges(config, dir, cwd, env);
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
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	const ack = {
		worker,
		pid: typeof input.pid === "number" ? input.pid : undefined,
		session: typeof input.session === "string" ? input.session : undefined,
		protocol_version: String(input.protocol_version ?? "1"),
		ack_at: now(),
	};
	await writeJsonFile(path.join(workerDir(dir, worker), "startup-ack.json"), ack);
	await appendEvent(dir, { type: "worker_startup_ack", worker, message: `Worker ${worker} acknowledged startup` });
	return ack;
}
function parseDurationEnv(env: NodeJS.ProcessEnv, name: string, fallbackMs: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallbackMs;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
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
	await writeJsonFile(nudgePath, record);
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
	const heartbeatStaleMs = parseDurationEnv(env, "GJC_TEAM_HEARTBEAT_STALE_MS", 120_000);
	const createdAt = Date.parse(config.created_at);
	const ageMs = Date.now() - (Number.isFinite(createdAt) ? createdAt : Date.now());
	for (const worker of config.workers) {
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
		if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt >= heartbeatStaleMs) {
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
	const config = await readConfig(dir);
	const tasks = await readTasks(dir);
	const shutdownPhase: GjcTeamPhase =
		tasks.length === 0 || tasks.every(task => task.status === "completed")
			? "complete"
			: tasks.some(task => task.status === "failed" || task.status === "blocked")
				? "failed"
				: "cancelled";
	killWorkerPanes(config);
	await removeCleanCreatedWorktrees(config.workers);
	const stopped = {
		...config,
		workers: config.workers.map(worker => ({ ...worker, status: "stopped" as const, last_heartbeat: now() })),
		updated_at: now(),
	};
	await writeJsonFile(path.join(dir, "config.json"), stopped);
	await writePhase(dir, shutdownPhase);
	await appendEvent(dir, {
		type: "team_shutdown",
		message:
			shutdownPhase === "complete"
				? "Shut down native gjc team runtime after completed tasks"
				: "Shut down native gjc team runtime with incomplete tasks",
		data: { phase: shutdownPhase },
	});
	await appendTelemetry(dir, {
		type: "team_shutdown",
		message: `Native gjc team runtime stopped with phase ${shutdownPhase}`,
	});
	return readGjcTeamSnapshot(config.team_name, cwd, env);
}

export async function listGjcTeamTasks(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask[]> {
	return readTasks(await findTeamDir(teamName, cwd, env));
}
export async function readGjcTeamTask(
	teamName: string,
	taskId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	const task = (await listGjcTeamTasks(teamName, cwd, env)).find(candidate => candidate.id === taskId);
	if (!task) throw new Error(`task_not_found:${taskId}`);
	return task;
}
export async function createGjcTeamTask(
	teamName: string,
	subject: string,
	description: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const tasks = await readTasks(dir);
	const next = tasks.length + 1;
	const task: GjcTeamTask = {
		id: `task-${next}`,
		subject,
		description,
		title: subject,
		objective: description,
		status: "pending",
		version: 1,
		created_at: now(),
		updated_at: now(),
	};
	await writeTask(dir, task);
	config.updated_at = now();
	await writeJsonFile(path.join(dir, "config.json"), config);
	await appendEvent(dir, { type: "task_created", task_id: task.id, message: subject });
	return task;
}
export async function updateGjcTeamTask(
	teamName: string,
	taskId: string,
	updates: Partial<Pick<GjcTeamTask, "subject" | "description" | "blocked_by" | "depends_on">>,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	const task = await readGjcTeamTask(teamName, taskId, cwd, env);
	const updated = normalizeTask({
		...task,
		...updates,
		title: updates.subject ?? task.title,
		objective: updates.description ?? task.objective,
		version: task.version + 1,
		updated_at: now(),
	});
	await writeTask(dir, updated);
	await appendEvent(dir, { type: "task_updated", task_id: taskId, message: updated.subject });
	return updated;
}
export async function claimGjcTeamTask(
	teamName: string,
	workerId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	taskId?: string,
): Promise<GjcTeamApiClaimResult> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, workerId);
	const tasks = await readTasks(dir);
	const task = taskId
		? tasks.find(candidate => candidate.id === taskId)
		: tasks.find(candidate => candidate.status === "pending" && (!candidate.owner || candidate.owner === workerId));
	if (!task) return { ok: false, reason: "no_pending_task" };
	if (task.status !== "pending") return { ok: false, reason: `task_not_pending:${task.id}` };
	const token = randomUUID();
	const claim: GjcTeamTaskClaim = {
		owner: workerId,
		token,
		leased_until: new Date(Date.now() + 30 * 60_000).toISOString(),
	};
	const claimPath = path.join(dir, "claims", `${task.id}.json`);
	const created = await writeJsonFileNoClobber(claimPath, claim);
	if (!created) return { ok: false, reason: `task_already_claimed:${task.id}` };
	const current = await readGjcTeamTask(teamName, task.id, cwd, env);
	if (current.status !== "pending") {
		await deleteIfOwned(claimPath, {
			...stateWriterOptions(claimPath, "prune", "rollback"),
			predicate: current => (current as GjcTeamTaskClaim).token === token,
		});
		return { ok: false, reason: `task_not_pending:${task.id}` };
	}
	const updated: GjcTeamTask = {
		...current,
		status: "in_progress",
		assignee: workerId,
		owner: workerId,
		claim,
		version: current.version + 1,
		updated_at: now(),
	};
	try {
		await writeTask(dir, updated);
	} catch (error) {
		await deleteIfOwned(claimPath, {
			...stateWriterOptions(claimPath, "prune", "rollback"),
			predicate: current => (current as GjcTeamTaskClaim).token === token,
		});
		throw error;
	}
	await appendEvent(dir, {
		type: "task_claimed",
		task_id: updated.id,
		worker: workerId,
		message: "Worker claimed task",
	});
	return { ok: true, task: updated, worker_id: workerId, claim_token: token };
}
export async function transitionGjcTeamTaskStatus(
	teamName: string,
	taskId: string,
	status: GjcTeamTaskStatus,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	claimToken?: string,
	workerId?: string,
	evidence?: string,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const task = await readGjcTeamTask(teamName, taskId, cwd, env);
	if (workerId) assertKnownWorker(config, workerId);
	if (status === "pending") throw new Error(`invalid_task_transition:${taskId}:pending_requires_release`);
	if (task.status === "completed" || task.status === "failed") throw new Error(`task_terminal:${taskId}`);
	if (!task.claim) throw new Error(`claim_token_required:${taskId}`);
	if (!claimToken) throw new Error(`claim_token_required:${taskId}`);
	if (task.claim.token !== claimToken) throw new Error(`claim_token_mismatch:${taskId}`);
	if (workerId && task.claim.owner !== workerId) throw new Error(`claim_owner_mismatch:${taskId}`);
	const terminal = status === "completed" || status === "failed";
	if (status === "completed" && evidence !== undefined && evidence.trim().length === 0)
		throw new Error(`task_evidence_required:${taskId}`);
	const updated: GjcTeamTask = {
		...task,
		status,
		claim: terminal ? undefined : task.claim,
		version: task.version + 1,
		updated_at: now(),
		...(terminal ? { completed_at: now() } : {}),
	};
	await writeTask(dir, updated);
	if (terminal && evidence)
		await writeJsonFile(taskEvidencePath(dir, taskId), {
			task_id: taskId,
			worker: workerId ?? task.claim.owner,
			evidence,
			recorded_at: now(),
		});
	if (terminal) {
		const claimPath = path.join(dir, "claims", `${taskId}.json`);
		await removeFileAudited(claimPath, stateWriterOptions(claimPath, "prune", "terminal"));
	}
	await appendEvent(dir, {
		type: "task_transitioned",
		task_id: taskId,
		message: "Task status changed",
		data: { status },
	});
	return updated;
}
export async function transitionGjcTeamTask(
	teamName: string,
	taskId: string,
	status: GjcTeamTaskStatus | "complete",
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	claimToken?: string,
): Promise<GjcTeamTask> {
	return transitionGjcTeamTaskStatus(teamName, taskId, parseGjcTeamTaskStatus(status, true), cwd, env, claimToken);
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
	const task = await readGjcTeamTask(teamName, taskId, cwd, env);
	if (!task.claim || task.claim.token !== claimToken || task.claim.owner !== workerId)
		throw new Error(`claim_token_mismatch:${taskId}`);
	const updated: GjcTeamTask = {
		...task,
		status: "pending",
		assignee: undefined,
		claim: undefined,
		version: task.version + 1,
		updated_at: now(),
	};
	await writeTask(dir, updated);
	const claimPath = path.join(dir, "claims", `${taskId}.json`);
	await deleteIfOwned(claimPath, {
		...stateWriterOptions(claimPath, "prune", "release"),
		predicate: current => (current as GjcTeamTaskClaim).token === claimToken,
	});
	await appendEvent(dir, {
		type: "task_claim_released",
		task_id: taskId,
		worker: workerId,
		message: "Task claim released",
	});
	return updated;
}

function emptyNotificationSummary(): GjcTeamNotificationSummary {
	return {
		total: 0,
		replay_eligible: 0,
		by_state: {
			pending: 0,
			sent: 0,
			queued: 0,
			deferred: 0,
			failed: 0,
			delivered: 0,
			acknowledged: 0,
		},
	};
}
function isReplayEligibleNotification(state: GjcTeamNotificationDeliveryState): boolean {
	return state === "pending" || state === "queued" || state === "deferred" || state === "failed";
}
function summarizeNotifications(notifications: GjcTeamNotification[]): GjcTeamNotificationSummary {
	const summary = emptyNotificationSummary();
	for (const notification of notifications) {
		summary.total += 1;
		summary.by_state[notification.delivery_state] += 1;
		if (isReplayEligibleNotification(notification.delivery_state)) summary.replay_eligible += 1;
	}
	return summary;
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
async function createMessageNotification(
	dir: string,
	teamName: string,
	message: GjcTeamMailboxMessage,
	state: GjcTeamNotificationDeliveryState = "pending",
): Promise<GjcTeamNotification> {
	const id = messageNotificationId(teamName, message.to_worker, message.message_id);
	return writeNotificationRecord(dir, {
		id,
		kind: "mailbox_message",
		team_name: teamName,
		recipient: message.to_worker,
		source: { type: "message", id: message.message_id },
		idempotency_key: message.idempotency_key,
		delivery_state: state,
		created_at: message.created_at,
		updated_at: now(),
		replay_count: 0,
	});
}
async function readLegacyMailbox(dir: string, worker: string): Promise<{ messages: GjcTeamMailboxMessage[] }> {
	return (await readJsonFile<{ messages: GjcTeamMailboxMessage[] }>(mailboxPath(dir, worker))) ?? { messages: [] };
}
async function readMailbox(dir: string, worker: string): Promise<{ messages: GjcTeamMailboxMessage[] }> {
	assertSafeId("worker_id", worker);
	const byId = new Map<string, GjcTeamMailboxMessage>();
	for (const message of (await readLegacyMailbox(dir, worker)).messages ?? []) byId.set(message.message_id, message);
	try {
		const entries = await fs.readdir(mailboxDirPath(dir, worker), { withFileTypes: true });
		const records = await Promise.all(
			entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => readJsonFile<GjcTeamMailboxMessage>(path.join(mailboxDirPath(dir, worker), entry.name))),
		);
		for (const message of records) if (message) byId.set(message.message_id, message);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return { messages: [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
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
async function reconcileTeamNotifications(dir: string, config: GjcTeamConfig): Promise<GjcTeamNotificationSummary> {
	for (const recipient of ["leader-fixed", ...config.workers.map(worker => worker.id)]) {
		const mailbox = await readMailbox(dir, recipient);
		for (const message of mailbox.messages) {
			const state = message.delivered_at ? "acknowledged" : message.notified_at ? "delivered" : "pending";
			await createMessageNotification(dir, config.team_name, message, state);
		}
	}
	return summarizeNotifications(await listNotificationRecords(dir));
}
async function attemptPaneNotification(
	dir: string,
	config: GjcTeamConfig,
	notification: GjcTeamNotification,
	env: NodeJS.ProcessEnv,
): Promise<GjcTeamNotification> {
	const paneId =
		notification.recipient === "leader-fixed"
			? config.leader.pane_id
			: config.workers.find(worker => worker.id === notification.recipient)?.pane_id;
	let result: GjcTeamPaneAttemptResult = "deferred";
	let reason = "pane_missing";
	if (paneId) {
		if (config.tmux_session === "dry-run" || env.GJC_TEAM_FAKE_PANE_ATTEMPT === "sent") {
			result = "sent";
			reason = "dry_run_or_fake_tmux";
		} else {
			result = "queued";
			reason = "tmux_delivery_recorded_without_injection";
		}
	}
	return writeNotificationRecord(dir, {
		...notification,
		delivery_state: result,
		pane_attempt_result: result,
		pane_attempt_reason: reason,
		pane_attempt_at: now(),
		updated_at: now(),
	});
}
export async function replayGjcTeamNotifications(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ notifications: GjcTeamNotification[]; summary: GjcTeamNotificationSummary }> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	await reconcileTeamNotifications(dir, config);
	const next: GjcTeamNotification[] = [];
	for (const notification of await listNotificationRecords(dir)) {
		if (!isReplayEligibleNotification(notification.delivery_state)) {
			next.push(notification);
			continue;
		}
		const attempted = await attemptPaneNotification(
			dir,
			config,
			{
				...notification,
				replay_count: (notification.replay_count ?? 0) + 1,
			},
			env,
		);
		next.push(attempted);
	}
	return { notifications: next, summary: summarizeNotifications(next) };
}
export async function sendGjcTeamMessage(
	teamName: string,
	fromWorker: string,
	toWorker: string,
	body: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	idempotencyKey?: string,
): Promise<GjcTeamMailboxMessage> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownParticipant(config, fromWorker);
	assertKnownParticipant(config, toWorker);
	const createdKey = idempotencyKey ?? randomUUID();
	const message: GjcTeamMailboxMessage = {
		message_id: messageIdFor({ teamName: config.team_name, fromWorker, toWorker, body, idempotencyKey, createdKey }),
		from_worker: fromWorker,
		to_worker: toWorker,
		body,
		created_at: now(),
		...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
	};
	const written = await writeMailboxMessage(dir, toWorker, message);
	const notification = await createMessageNotification(dir, config.team_name, written);
	await attemptPaneNotification(dir, config, notification, env);
	await appendEvent(dir, {
		type: "message_sent",
		worker: fromWorker,
		message: body,
		data: { to_worker: toWorker, message_id: written.message_id },
	});
	return written;
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
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownParticipant(config, worker);
	return (await readMailbox(dir, worker)).messages;
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
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownParticipant(config, worker);
	const mailbox = await readMailbox(dir, worker);
	const message = mailbox.messages.find(candidate => candidate.message_id === messageId);
	if (!message) throw new Error(`message_not_found:${messageId}`);
	const updated = { ...message, [field]: message[field] ?? now() };
	const written = await writeMailboxMessage(dir, worker, updated);
	const notificationId = messageNotificationId(config.team_name, worker, messageId);
	const existing =
		(await readJsonFile<GjcTeamNotification>(notificationPath(dir, notificationId))) ??
		(await createMessageNotification(dir, config.team_name, written));
	const nextState: GjcTeamNotificationDeliveryState = field === "delivered_at" ? "acknowledged" : "delivered";
	const before = existing.delivery_state;
	await writeNotificationRecord(dir, { ...existing, delivery_state: nextState, updated_at: now() });
	if (mergeNotificationState(before, nextState) !== before)
		await appendEvent(dir, {
			type: `message_${field === "delivered_at" ? "acknowledged" : "notified"}`,
			worker,
			message: messageId,
		});
	return written;
}
export async function readGjcWorkerStatus(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerStatusFile> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	return (
		(await readJsonFile<WorkerStatusFile>(path.join(workerDir(dir, worker), "status.json"))) ?? {
			state: "unknown",
			updated_at: now(),
		}
	);
}
export async function readGjcWorkerHeartbeat(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile | null> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	return readJsonFile<WorkerHeartbeatFile>(path.join(workerDir(dir, worker), "heartbeat.json"));
}
export async function updateGjcWorkerHeartbeat(
	teamName: string,
	worker: string,
	heartbeat: WorkerHeartbeatFile,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	const value = { ...heartbeat, last_turn_at: heartbeat.last_turn_at || now() };
	await writeJsonFile(path.join(workerDir(dir, worker), "heartbeat.json"), value);
	return value;
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
): Promise<Record<string, unknown>> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	assertKnownParticipant(config, requestedBy);
	const value = { worker, requested_by: requestedBy, requested_at: now() };
	await writeJsonFile(path.join(workerDir(dir, worker), "shutdown-request.json"), value);
	return value;
}
export async function readGjcShutdownAck(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	assertKnownWorker(config, worker);
	return readJsonFile<Record<string, unknown>>(path.join(workerDir(dir, worker), "shutdown-ack.json"));
}

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
			return { task: await readGjcTeamTask(teamName, String(input.task_id ?? input.taskId), cwd, env) };
		case "create-task":
			return {
				task: await createGjcTeamTask(
					teamName,
					String(input.subject ?? "Task"),
					String(input.description ?? ""),
					cwd,
					env,
				),
			};
		case "update-task":
			return {
				task: await updateGjcTeamTask(
					teamName,
					String(input.task_id ?? input.taskId),
					{
						subject: typeof input.subject === "string" ? input.subject : undefined,
						description: typeof input.description === "string" ? input.description : undefined,
					},
					cwd,
					env,
				),
			};
		case "claim-task":
			return claimGjcTeamTask(
				teamName,
				worker,
				cwd,
				env,
				typeof input.task_id === "string" ? input.task_id : undefined,
			);
		case "transition-task":
		case "transition-task-status":
			return {
				ok: true,
				task: await transitionGjcTeamTaskStatus(
					teamName,
					String(input.task_id ?? input.taskId),
					parseGjcTeamTaskStatus(input.to ?? input.status),
					cwd,
					env,
					typeof input.claim_token === "string" ? input.claim_token : undefined,
					explicitWorker,
					typeof input.evidence === "string"
						? input.evidence
						: typeof input.result === "string"
							? input.result
							: undefined,
				),
			};
		case "release-task-claim":
			return {
				ok: true,
				task: await releaseGjcTeamTaskClaim(
					teamName,
					String(input.task_id),
					String(input.claim_token),
					worker,
					cwd,
					env,
				),
			};
		case "send-message":
			return {
				message: await sendGjcTeamMessage(
					teamName,
					String(input.from_worker),
					String(input.to_worker),
					String(input.body),
					cwd,
					env,
					typeof input.idempotency_key === "string" ? input.idempotency_key : undefined,
				),
			};
		case "broadcast":
			return {
				messages: await broadcastGjcTeamMessage(
					teamName,
					String(input.from_worker),
					String(input.body),
					cwd,
					env,
					typeof input.idempotency_key === "string" ? input.idempotency_key : undefined,
				),
			};
		case "mailbox-list":
			return { messages: await listGjcTeamMailbox(teamName, worker, cwd, env) };
		case "mailbox-mark-delivered":
			return {
				message: await markGjcTeamMailboxMessage(
					teamName,
					worker,
					String(input.message_id),
					"delivered_at",
					cwd,
					env,
				),
			};
		case "mailbox-mark-notified":
			return {
				message: await markGjcTeamMailboxMessage(
					teamName,
					worker,
					String(input.message_id),
					"notified_at",
					cwd,
					env,
				),
			};
		case "notification-list": {
			const dir = await findTeamDir(teamName, cwd, env);
			const config = await readConfig(dir);
			await reconcileTeamNotifications(dir, config);
			const notifications = await listNotificationRecords(dir);
			return { notifications, summary: summarizeNotifications(notifications) };
		}
		case "notification-read":
			return {
				notification: await readNotificationRecord(
					await findTeamDir(teamName, cwd, env),
					String(input.notification_id),
				),
			};
		case "notification-replay":
			return replayGjcTeamNotifications(teamName, cwd, env);
		case "notification-mark-pane-attempt": {
			const dir = await findTeamDir(teamName, cwd, env);
			const notification = await readNotificationRecord(dir, String(input.notification_id));
			return {
				notification: await writeNotificationRecord(dir, {
					...notification,
					delivery_state: parsePaneAttemptResult(String(input.result ?? "failed")),
					pane_attempt_result: parsePaneAttemptResult(String(input.result ?? "failed")),
					pane_attempt_reason: String(input.reason ?? "manual_api"),
					pane_attempt_at: now(),
					updated_at: now(),
				}),
			};
		}
		case "worker-startup-ack":
			return writeGjcWorkerStartupAck(teamName, worker, cwd, env, input);
		case "read-config":
			return await readConfig(await findTeamDir(teamName, cwd, env));
		case "read-manifest":
			return readJsonFile(path.join(await findTeamDir(teamName, cwd, env), "manifest.v2.json"));
		case "read-worker-status":
			return readGjcWorkerStatus(teamName, worker, cwd, env);
		case "read-worker-heartbeat":
			return readGjcWorkerHeartbeat(teamName, worker, cwd, env);
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
		case "write-shutdown-request":
			return writeGjcShutdownRequest(teamName, worker, String(input.requested_by ?? "leader-fixed"), cwd, env);
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
	return { workerCount, agentType, task, dryRun, worktreeMode: resolveDefaultWorktreeMode(parsedWorktree.mode) };
}
