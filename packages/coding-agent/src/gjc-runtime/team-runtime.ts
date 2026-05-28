import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type GjcTeamPhase = "starting" | "running" | "complete" | "failed" | "cancelled";
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
interface GjcTeamEvent {
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
	operation: "auto_checkpoint" | "integration_merge" | "integration_cherry_pick" | "cross_rebase";
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
function isEexist(error: unknown): error is FsError {
	return typeof error === "object" && error !== null && "code" in error && (error as FsError).code === "EEXIST";
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
function taskPath(dir: string, taskId: string): string {
	return path.join(dir, "tasks", `${taskId}.json`);
}
function mailboxPath(dir: string, worker: string): string {
	return path.join(dir, "mailbox", `${worker}.json`);
}
function workerDir(dir: string, worker: string): string {
	return path.join(dir, "workers", worker);
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
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
async function appendJsonl(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
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
async function readTasks(dir: string): Promise<GjcTeamTask[]> {
	try {
		const entries = await fs.readdir(path.join(dir, "tasks"), { withFileTypes: true });
		const tasks = await Promise.all(
			entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => readJsonFile<GjcTeamTask>(path.join(dir, "tasks", entry.name))),
		);
		return tasks
			.filter((task): task is GjcTeamTask => task != null)
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

async function startTmuxSession(config: GjcTeamConfig, dir: string, dryRun: boolean): Promise<GjcTeamWorker[]> {
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
	await fs.mkdir(path.dirname(integrationReportPath(dir)), { recursive: true });
	if (await pathExists(integrationReportPath(dir))) await fs.appendFile(integrationReportPath(dir), line, "utf-8");
	else await Bun.write(integrationReportPath(dir), `# Integration Report\n\n${line}`);
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
function autoCommitDirtyWorker(worker: GjcTeamWorker): { committed: boolean; commit: string | null } {
	if (!worker.worktree_path) return { committed: false, commit: null };
	const status = runGitResult(worker.worktree_path, ["status", "--porcelain"]);
	if (!status.ok || !status.stdout.trim()) return { committed: false, commit: null };
	if (!runGitResult(worker.worktree_path, ["add", "-A"]).ok) return { committed: false, commit: null };
	const message = `gjc(team): auto-checkpoint ${worker.id} [${worker.assigned_tasks[0] ?? "unknown"}]`;
	if (!runGitResult(worker.worktree_path, ["commit", "--no-verify", "-m", message]).ok)
		return { committed: false, commit: null };
	return { committed: true, commit: resolveHead(worker.worktree_path) };
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
			const merge = runGitResult(leaderCwd, [
				"merge",
				"--no-ff",
				"-X",
				"theirs",
				"-m",
				`gjc(team): merge ${worker.id}`,
				mergeRef,
			]);
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
					detail: `merge --no-ff -X theirs failed and was aborted: ${(merge.stderr || merge.stdout).slice(0, 200)}`,
				});
				await notifyLeader(
					config,
					worker,
					`CONFLICT: merge failed for ${worker.id}; files: ${conflictFiles.join(",") || "unknown"}.`,
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
			const pick = runGitResult(leaderCwd, ["cherry-pick", "--allow-empty", "-X", "theirs", commit]);
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
					detail: `cherry-pick -X theirs failed and was aborted: ${(pick.stderr || pick.stdout).slice(0, 200)}`,
				});
				await notifyLeader(
					config,
					worker,
					`CONFLICT: cherry-pick failed for ${worker.id}; files: ${conflictFiles.join(",") || "unknown"}.`,
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
			const rebase = runGitResult(worker.worktree_path, ["rebase", "-X", "ours", newLeaderHead]);
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
					detail: `rebase -X ours failed and was aborted: ${(rebase.stderr || rebase.stdout).slice(0, 200)}`,
				});
				await notifyLeader(
					config,
					worker,
					`CONFLICT: cross-rebase failed for ${worker.id}; files: ${conflictFiles.join(",") || "unknown"}.`,
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
	for (const folder of ["tasks", "claims", "mailbox", "dispatch", "approvals", "workers"])
		await fs.mkdir(path.join(dir, folder), { recursive: true });
	for (const worker of workers) {
		await fs.mkdir(workerDir(dir, worker.id), { recursive: true });
		await writeJsonFile(mailboxPath(dir, worker.id), { messages: [] });
		await writeJsonFile(path.join(workerDir(dir, worker.id), "status.json"), { state: "idle", updated_at: now() });
		await writeJsonFile(path.join(workerDir(dir, worker.id), "heartbeat.json"), {
			pid: 0,
			last_turn_at: now(),
			turn_count: 0,
			alive: true,
		});
	}
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
		created_at: createdAt,
		updated_at: createdAt,
	});
	await writePhase(dir, "starting");
	for (const task of buildInitialTasks(options.task, config.workers)) await writeTask(dir, task);
	await appendEvent(dir, {
		type: "team_started",
		message: "Started native gjc team runtime",
		data: { worker_count: options.workerCount, agent_type: options.agentType, workspace_mode: config.workspace_mode },
	});
	await appendTelemetry(dir, {
		type: "team_runtime",
		message: "Native gjc team runtime initialized",
		data: {
			state_root: stateRoot,
			worker_command: config.worker_command,
			worker_cli_plan: workerCliPlan,
			workspace_mode: config.workspace_mode,
		},
	});
	let tmuxWorkers: GjcTeamWorker[];
	try {
		tmuxWorkers = await startTmuxSession(config, dir, options.dryRun ?? false);
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
	const phase = await readPhase(dir);
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
		updated_at: config.updated_at,
	};
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
export async function shutdownGjcTeam(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	killWorkerPanes(config);
	await removeCleanCreatedWorktrees(config.workers);
	const stopped = {
		...config,
		workers: config.workers.map(worker => ({ ...worker, status: "stopped" as const, last_heartbeat: now() })),
		updated_at: now(),
	};
	await writeJsonFile(path.join(dir, "config.json"), stopped);
	await writePhase(dir, "complete");
	await appendEvent(dir, { type: "team_shutdown", message: "Shut down native gjc team runtime" });
	await appendTelemetry(dir, { type: "team_shutdown", message: "Native gjc team runtime stopped" });
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
	await fs.mkdir(path.dirname(claimPath), { recursive: true });
	let claimFile: fs.FileHandle | undefined;
	try {
		claimFile = await fs.open(claimPath, "wx");
		await claimFile.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf-8");
	} catch (error) {
		if (isEexist(error)) return { ok: false, reason: `task_already_claimed:${task.id}` };
		throw error;
	} finally {
		await claimFile?.close();
	}
	const current = await readGjcTeamTask(teamName, task.id, cwd, env);
	if (current.status !== "pending") {
		await fs.rm(claimPath, { force: true });
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
		await fs.rm(claimPath, { force: true });
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
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	const task = await readGjcTeamTask(teamName, taskId, cwd, env);
	if (status === "pending") throw new Error(`invalid_task_transition:${taskId}:pending_requires_release`);
	if (task.status === "completed" || task.status === "failed") throw new Error(`task_terminal:${taskId}`);
	if (!task.claim) throw new Error(`claim_token_required:${taskId}`);
	if (!claimToken) throw new Error(`claim_token_required:${taskId}`);
	if (task.claim.token !== claimToken) throw new Error(`claim_token_mismatch:${taskId}`);
	const terminal = status === "completed" || status === "failed";
	const updated: GjcTeamTask = {
		...task,
		status,
		claim: terminal ? undefined : task.claim,
		version: task.version + 1,
		updated_at: now(),
		...(terminal ? { completed_at: now() } : {}),
	};
	await writeTask(dir, updated);
	if (terminal) await fs.rm(path.join(dir, "claims", `${taskId}.json`), { force: true });
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
	await fs.rm(path.join(dir, "claims", `${taskId}.json`), { force: true });
	await appendEvent(dir, {
		type: "task_claim_released",
		task_id: taskId,
		worker: workerId,
		message: "Task claim released",
	});
	return updated;
}

async function readMailbox(dir: string, worker: string): Promise<{ messages: GjcTeamMailboxMessage[] }> {
	return (await readJsonFile<{ messages: GjcTeamMailboxMessage[] }>(mailboxPath(dir, worker))) ?? { messages: [] };
}
async function writeMailbox(
	dir: string,
	worker: string,
	mailbox: { messages: GjcTeamMailboxMessage[] },
): Promise<void> {
	await writeJsonFile(mailboxPath(dir, worker), mailbox);
}
export async function sendGjcTeamMessage(
	teamName: string,
	fromWorker: string,
	toWorker: string,
	body: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamMailboxMessage> {
	const dir = await findTeamDir(teamName, cwd, env);
	const message = {
		message_id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		from_worker: fromWorker,
		to_worker: toWorker,
		body,
		created_at: now(),
	};
	const mailbox = await readMailbox(dir, toWorker);
	mailbox.messages.push(message);
	await writeMailbox(dir, toWorker, mailbox);
	await appendEvent(dir, { type: "message_sent", worker: fromWorker, message: body });
	return message;
}
export async function broadcastGjcTeamMessage(
	teamName: string,
	fromWorker: string,
	body: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamMailboxMessage[]> {
	const config = await readConfig(await findTeamDir(teamName, cwd, env));
	return Promise.all(
		config.workers.map(worker => sendGjcTeamMessage(teamName, fromWorker, worker.id, body, cwd, env)),
	);
}
export async function listGjcTeamMailbox(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamMailboxMessage[]> {
	return (await readMailbox(await findTeamDir(teamName, cwd, env), worker)).messages;
}
export async function markGjcTeamMailboxMessage(
	teamName: string,
	worker: string,
	messageId: string,
	field: "delivered_at" | "notified_at",
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamMailboxMessage> {
	const dir = await findTeamDir(teamName, cwd, env);
	const mailbox = await readMailbox(dir, worker);
	const index = mailbox.messages.findIndex(message => message.message_id === messageId);
	if (index < 0) throw new Error(`message_not_found:${messageId}`);
	mailbox.messages[index] = { ...mailbox.messages[index], [field]: now() };
	await writeMailbox(dir, worker, mailbox);
	return mailbox.messages[index];
}
export async function readGjcWorkerStatus(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerStatusFile> {
	return (
		(await readJsonFile<WorkerStatusFile>(
			path.join(workerDir(await findTeamDir(teamName, cwd, env), worker), "status.json"),
		)) ?? { state: "unknown", updated_at: now() }
	);
}
export async function readGjcWorkerHeartbeat(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile | null> {
	return readJsonFile<WorkerHeartbeatFile>(
		path.join(workerDir(await findTeamDir(teamName, cwd, env), worker), "heartbeat.json"),
	);
}
export async function updateGjcWorkerHeartbeat(
	teamName: string,
	worker: string,
	heartbeat: WorkerHeartbeatFile,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile> {
	const value = { ...heartbeat, last_turn_at: heartbeat.last_turn_at || now() };
	await writeJsonFile(path.join(workerDir(await findTeamDir(teamName, cwd, env), worker), "heartbeat.json"), value);
	return value;
}
export async function writeGjcWorkerInbox(
	teamName: string,
	worker: string,
	content: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string }> {
	const filePath = path.join(workerDir(await findTeamDir(teamName, cwd, env), worker), "inbox.md");
	await Bun.write(filePath, content);
	return { path: filePath };
}
export async function writeGjcWorkerIdentity(
	teamName: string,
	worker: GjcTeamWorker,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamWorker> {
	await writeJsonFile(path.join(workerDir(await findTeamDir(teamName, cwd, env), worker.id), "identity.json"), worker);
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
	await writeJsonFile(path.join(await findTeamDir(teamName, cwd, env), "approvals", `${taskId}.json`), approval);
	return approval;
}
export async function readGjcTaskApproval(
	teamName: string,
	taskId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
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
	const value = { worker, requested_by: requestedBy, requested_at: now() };
	await writeJsonFile(
		path.join(workerDir(await findTeamDir(teamName, cwd, env), worker), "shutdown-request.json"),
		value,
	);
	return value;
}
export async function readGjcShutdownAck(
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
	return readJsonFile<Record<string, unknown>>(
		path.join(workerDir(await findTeamDir(teamName, cwd, env), worker), "shutdown-ack.json"),
	);
}

export async function executeGjcTeamApiOperation(
	operation: string,
	input: Record<string, unknown>,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	const teamName = String(input.team_name ?? input.teamName ?? "").trim();
	if (!teamName) throw new Error("missing_team_name");
	const worker = String(input.worker ?? input.worker_id ?? input.workerId ?? "worker-1");
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
				),
			};
		case "broadcast":
			return {
				messages: await broadcastGjcTeamMessage(teamName, String(input.from_worker), String(input.body), cwd, env),
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
