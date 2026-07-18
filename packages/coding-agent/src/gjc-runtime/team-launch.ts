import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SPAWN_PROVENANCE_ENV } from "../sdk/bus/config";
import { resolveSessionIdFromSources } from "./session-resolution";
import type {
	GjcTeamConfig,
	GjcTeamSnapshot,
	GjcTeamStartOptions,
	GjcTeamTask,
	GjcTeamWorker,
	GjcTeamWorkerCli,
	GjcTeamWorkerLifecycle,
	GjcTeamWorktreeMode,
} from "./team-runtime";

/** Launch-specific option wiring kept separate from runtime dispatch. */
export function withTeamLaunchTransport(
	options: GjcTeamStartOptions,
	mailboxDeliveryTransport: GjcTeamStartOptions["mailboxDeliveryTransport"],
): GjcTeamStartOptions {
	return { ...options, mailboxDeliveryTransport };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** @internal Exported for unit tests. */
export function buildWorkerCommand(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	platform: NodeJS.Platform = process.platform,
): string {
	const quote = platform === "win32" ? powershellQuote : shellQuote;
	const envAssignment = (key: string, value: string): string =>
		platform === "win32" ? `$env:${key} = ${quote(value)};` : `${key}=${quote(value)}`;
	const workspace = worker.worktree_path
		? `Worker worktree: ${worker.worktree_path}.`
		: `Worker cwd: ${config.leader.cwd}.`;
	const prompt =
		[
			`You are ${worker.id} in gjc team ${config.team_name}.`,
			`Team state root: ${config.state_root}.`,
			workspace,
			`Team brief (context only): ${config.task}`,
			"Before implementation, claim your worker-owned task and treat the claimed task record as the source of truth. Do not implement directly from the broad team brief.",
			`Before claiming work, send startup ACK: gjc team api worker-startup-ack --input '{"team_name":"${config.team_name}","worker_id":"${worker.id}","protocol_version":"1"}' --json.`,
			"Use gjc team api update-worker-status to report task-local activity, then claim-task/transition-task-status with this worker id; keep heartbeat current during long work, record completion_evidence (summary plus a passed command or verified inspection/artifact item) before completed, and do not mutate leader-owned goal state.",
		]
			.join("\n")
			.replace(/[\uFEFF\u200B]/g, "")
			.replace(/\r?\n+/g, " ")
			.trim() || `Worker ${worker.id} ready.`;
	const envLines = [
		envAssignment("GJC_TEAM_WORKER", `${config.team_name}/${worker.id}`),
		envAssignment("GJC_TEAM_INTERNAL_WORKER", `${config.team_name}/${worker.id}`),
		envAssignment("GJC_TEAM_NAME", config.team_name),
		envAssignment("GJC_TEAM_WORKER_ID", worker.id),
		envAssignment("GJC_TEAM_STATE_ROOT", config.state_root),
		...(config.gjc_session_id ? [envAssignment("GJC_SESSION_ID", config.gjc_session_id)] : []),
		envAssignment("GJC_TEAM_LEADER_CWD", config.leader.cwd),
		envAssignment("GJC_TEAM_DISPLAY_NAME", config.display_name),
		envAssignment(SPAWN_PROVENANCE_ENV, config.leader.session_id.trim() || config.team_name),
		...(worker.worktree_path ? [envAssignment("GJC_TEAM_WORKTREE_PATH", worker.worktree_path)] : []),
	];
	const joined = envLines.join(" ");
	const clearInheritedSession = config.gjc_session_id
		? ""
		: platform === "win32"
			? "$env:GJC_SESSION_ID = $null; "
			: "unset GJC_SESSION_ID; ";
	if (platform === "win32")
		return `& { ${clearInheritedSession}${joined} & ${config.worker_command} ${quote(prompt)} }`;
	return `${clearInheritedSession}${joined} ${config.worker_command} ${quote(prompt)}`;
}

interface GjcTmuxBinary {
	command: string;
	isPsmux: boolean;
}

interface GjcTmuxLeaderContext {
	sessionName: string;
	windowIndex: string;
	leaderPaneId: string;
	target: string;
}

export interface GjcTeamLaunchRuntime {
	maxWorkers: number;
	resolveWorkerCliPlan(workerCount: number, env: NodeJS.ProcessEnv): GjcTeamWorkerCli[];
	resolveStateRoot(cwd: string, env: NodeJS.ProcessEnv): string;
	sanitizeName(value: string): string;
	makeTeamName(task: string, env: NodeJS.ProcessEnv): string;
	teamDir(stateRoot: string, teamName: string): string;
	resolveDefaultWorktreeMode(mode?: GjcTeamWorktreeMode): GjcTeamWorktreeMode;
	resolveTmuxBinary(input: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }): GjcTmuxBinary;
	readTmuxLeaderContext(tmuxCommand: string, env: NodeJS.ProcessEnv): GjcTmuxLeaderContext;
	buildWorkers(workerCount: number, agentType: string, stateRoot: string): GjcTeamWorker[];
	buildInitialTasks(task: string, workers: GjcTeamWorker[]): GjcTeamTask[];
	ensureWorkerWorktree(
		cwd: string,
		dir: string,
		teamName: string,
		worker: GjcTeamWorker,
		mode: GjcTeamWorktreeMode,
		platform: NodeJS.Platform,
		isPsmux: boolean,
	): Promise<GjcTeamWorker>;
	rollbackCreatedWorktrees(workers: GjcTeamWorker[]): Promise<void>;
	resolveWorkerCommand(cwd: string, env: NodeJS.ProcessEnv): string;
	mailboxDirPath(dir: string, worker: string): string;
	mailboxPath(dir: string, worker: string): string;
	workerDir(dir: string, worker: string): string;
	workerLifecyclePath(dir: string, worker: string): string;
	writeJson(filePath: string, value: unknown): Promise<void>;
	now(): string;
	writePhase(dir: string, phase: "starting" | "running" | "failed"): Promise<void>;
	writeTask(dir: string, task: GjcTeamTask): Promise<void>;
	appendEvent(dir: string, event: { type: string; message: string; data?: Record<string, unknown> }): Promise<unknown>;
	appendTelemetry(
		dir: string,
		event: { type: string; message: string; data?: Record<string, unknown> },
	): Promise<unknown>;
	startTmuxSession(
		config: GjcTeamConfig,
		dir: string,
		dryRun: boolean,
		env: NodeJS.ProcessEnv,
	): Promise<GjcTeamWorker[]>;
	killWorkerPanes(config: GjcTeamConfig): void;
	writeWorkerLifecycleForConfig(
		dir: string,
		config: GjcTeamConfig,
		state: "starting",
		updates: (worker: GjcTeamWorker) => Partial<GjcTeamWorkerLifecycle>,
	): Promise<unknown>;
	readSnapshot(teamName: string, cwd: string, env: NodeJS.ProcessEnv): Promise<GjcTeamSnapshot>;
}

async function initializeStateDirs(
	runtime: GjcTeamLaunchRuntime,
	dir: string,
	workers: GjcTeamWorker[],
): Promise<void> {
	await fs.mkdir(path.join(dir, "mailbox"), { recursive: true });
	for (const worker of workers) {
		await fs.mkdir(runtime.mailboxDirPath(dir, worker.id), { recursive: true });
		await runtime.writeJson(runtime.mailboxPath(dir, worker.id), { messages: [] });
		await runtime.writeJson(path.join(runtime.workerDir(dir, worker.id), "status.json"), {
			state: "idle",
			updated_at: runtime.now(),
		});
		await runtime.writeJson(runtime.workerLifecyclePath(dir, worker.id), {
			worker: worker.id,
			lifecycle_state: "starting",
			worker_status_state: "idle",
			updated_at: runtime.now(),
		} satisfies GjcTeamWorkerLifecycle);
		await runtime.writeJson(path.join(runtime.workerDir(dir, worker.id), "heartbeat.json"), {
			pid: 0,
			last_turn_at: runtime.now(),
			turn_count: 0,
			alive: true,
		});
	}
	await fs.mkdir(runtime.mailboxDirPath(dir, "leader-fixed"), { recursive: true });
	await runtime.writeJson(runtime.mailboxPath(dir, "leader-fixed"), { messages: [] });
}

/** Creates persistent team state, worktrees, and tmux worker panes. */
export async function startGjcTeamLaunch(
	runtime: GjcTeamLaunchRuntime,
	options: GjcTeamStartOptions,
): Promise<GjcTeamSnapshot> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const gjcSessionId = resolveSessionIdFromSources({ envSessionId: env.GJC_SESSION_ID })?.gjcSessionId;
	if (!Number.isInteger(options.workerCount) || options.workerCount < 1 || options.workerCount > runtime.maxWorkers)
		throw new Error(`invalid_team_worker_count:${options.workerCount}:expected_1_${runtime.maxWorkers}`);
	const workerCliPlan = runtime.resolveWorkerCliPlan(options.workerCount, env);
	const stateRoot = runtime.resolveStateRoot(cwd, env);
	const teamName = runtime.sanitizeName(options.teamName ?? runtime.makeTeamName(options.task, env));
	const displayName = runtime.sanitizeName(options.teamName ?? options.task).slice(0, 30) || teamName;
	const dir = runtime.teamDir(stateRoot, teamName);
	const createdAt = runtime.now();
	const worktreeMode = runtime.resolveDefaultWorktreeMode(options.worktreeMode);
	const platform = options.platform ?? process.platform;
	const tmuxBinary = runtime.resolveTmuxBinary({ env, platform });
	const tmuxCommand = tmuxBinary.command;
	const tmuxContext = options.dryRun
		? { sessionName: "dry-run", windowIndex: "0", leaderPaneId: "%dry-run-leader", target: "dry-run:0" }
		: runtime.readTmuxLeaderContext(tmuxCommand, env);
	const initialWorkers = runtime.buildWorkers(options.workerCount, options.agentType, stateRoot);
	const initialTasks = runtime.buildInitialTasks(options.task, initialWorkers);
	const workers: GjcTeamWorker[] = [];
	try {
		for (const worker of initialWorkers)
			workers.push(
				options.dryRun
					? worker
					: await runtime.ensureWorkerWorktree(
							cwd,
							dir,
							teamName,
							worker,
							worktreeMode,
							platform,
							tmuxBinary.isPsmux,
						),
			);
	} catch (error) {
		await runtime.rollbackCreatedWorktrees(workers);
		throw error;
	}
	const config: GjcTeamConfig = {
		team_name: teamName,
		display_name: displayName,
		requested_name: options.teamName ?? displayName,
		task: options.task,
		agent_type: options.agentType,
		worker_count: options.workerCount,
		max_workers: runtime.maxWorkers,
		state_root: stateRoot,
		worker_command: runtime.resolveWorkerCommand(cwd, env),
		...(gjcSessionId ? { gjc_session_id: gjcSessionId } : {}),
		worker_cli_plan: workerCliPlan,
		tmux_command: tmuxCommand,
		tmux_session: tmuxContext.sessionName,
		tmux_session_name: tmuxContext.sessionName,
		tmux_target: tmuxContext.target,
		workspace_mode: worktreeMode.enabled ? "worktree" : "direct",
		dry_run: options.dryRun ?? false,
		leader: {
			session_id: env.GJC_SESSION_ID ?? env.CODEX_SESSION_ID ?? "",
			pane_id: tmuxContext.leaderPaneId,
			cwd,
		},
		leader_cwd: cwd,
		team_state_root: stateRoot,
		workers,
		created_at: createdAt,
		updated_at: createdAt,
	};
	await initializeStateDirs(runtime, dir, config.workers);
	await runtime.writeJson(path.join(dir, "config.json"), config);
	await runtime.writeJson(path.join(dir, "manifest.v2.json"), {
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
	await runtime.writePhase(dir, "starting");
	for (const task of initialTasks) await runtime.writeTask(dir, task);
	await runtime.appendEvent(dir, {
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
	await runtime.appendTelemetry(dir, {
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
		tmuxWorkers = await runtime.startTmuxSession(config, dir, options.dryRun ?? false, env);
	} catch (error) {
		await runtime.writePhase(dir, "failed");
		await runtime.appendEvent(dir, {
			type: "team_start_failed",
			message: error instanceof Error ? error.message : String(error),
		});
		runtime.killWorkerPanes(config);
		await runtime.rollbackCreatedWorktrees(config.workers);
		throw error;
	}
	const runningConfig = {
		...config,
		workers: tmuxWorkers.map(worker => ({ ...worker, status: "idle" as const, last_heartbeat: runtime.now() })),
		updated_at: runtime.now(),
	};
	await runtime.writeJson(path.join(dir, "config.json"), runningConfig);
	await runtime.writeWorkerLifecycleForConfig(dir, runningConfig, "starting", worker => ({
		pane_id: worker.pane_id,
		started_at: runningConfig.created_at,
	}));
	await runtime.writePhase(dir, "running");
	return runtime.readSnapshot(teamName, cwd, env);
}
