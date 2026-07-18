/** File-backed worker lifecycle, heartbeat, stale-claim recovery, and shutdown state. */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	GjcTeamConfig,
	GjcTeamLivenessRecoveryReason,
	GjcTeamLivenessRecoveryResult,
	GjcTeamPhase,
	GjcTeamRecoveredClaim,
	GjcTeamShutdownMode,
	GjcTeamSnapshot,
	GjcTeamWorker,
	GjcTeamWorkerLifecycle,
	GjcTeamWorkerLifecycleState,
	GjcWorkerStatusState,
	WorkerHeartbeatFile,
	WorkerStatusFile,
} from "./team-runtime";
import type { GjcTeamTask, GjcTeamTaskClaim, GjcTeamTaskMutationCapability } from "./team-store";
import {
	getGjcTeamTaskCompletionEvidenceFailure,
	isCanonicalPersistedGjcTeamTask,
	isCanonicalPersistedGjcTeamTaskClaim,
	isGjcTeamTaskCompletionVerified,
	normalizeGjcTeamTask,
} from "./team-store";

export interface GjcTeamWorkerLifecycleContext {
	config: GjcTeamConfig;
	worker: GjcTeamWorker;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface GjcTeamWorkerRuntime {
	findTeamDir(teamName: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string>;
	readConfig(dir: string): Promise<GjcTeamConfig>;
	assertKnownWorker(config: GjcTeamConfig, worker: string): void;
	assertKnownParticipant(config: GjcTeamConfig, worker: string): void;
	findKnownWorker(config: GjcTeamConfig, worker: string): GjcTeamWorker;
	workerDir(dir: string, worker: string): string;
	readJson<T>(filePath: string): Promise<T | null>;
	writeJson(filePath: string, value: unknown): Promise<void>;
	appendEvent(
		dir: string,
		event: { type: string; worker?: string; task_id?: string; message: string; data?: Record<string, unknown> },
	): Promise<unknown>;
	now(): string;
	nowMs(): number;
	stableHash(value: string): string;
}

export interface GjcTeamWorkerOrchestrationRuntime extends GjcTeamWorkerRuntime {
	readTasks(dir: string): Promise<GjcTeamTask[]>;
	withTaskMutation<T>(dir: string, fn: (capability: GjcTeamTaskMutationCapability) => Promise<T>): Promise<T>;
	appendTelemetry(
		dir: string,
		event: { type: string; message: string; data?: Record<string, unknown> },
	): Promise<unknown>;
	paneBelongsToTeamTarget(config: GjcTeamConfig, paneId: string): boolean;
	parseDurationEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number;
	parseHeartbeatStaleMs(env: NodeJS.ProcessEnv): number;
	killWorkerPanes(config: GjcTeamConfig): void;
	removeCleanCreatedWorktrees(workers: GjcTeamWorker[]): Promise<void>;
	readMonitorSnapshot(dir: string): Promise<unknown>;
	hasPendingIntegration(dir: string, config: GjcTeamConfig, monitor: unknown): Promise<boolean>;
	writePhase(dir: string, phase: GjcTeamPhase): Promise<void>;
	readSnapshot(teamName: string, cwd: string, env: NodeJS.ProcessEnv): Promise<GjcTeamSnapshot>;
}

export function workerLifecycleContext(
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	cwd: string,
	env: NodeJS.ProcessEnv,
): GjcTeamWorkerLifecycleContext {
	return { config, worker, cwd, env };
}

const lifecyclePath = (runtime: GjcTeamWorkerRuntime, dir: string, worker: string) =>
	path.join(runtime.workerDir(dir, worker), "lifecycle.json");
const statusPath = (runtime: GjcTeamWorkerRuntime, dir: string, worker: string) =>
	path.join(runtime.workerDir(dir, worker), "status.json");
const heartbeatPath = (runtime: GjcTeamWorkerRuntime, dir: string, worker: string) =>
	path.join(runtime.workerDir(dir, worker), "heartbeat.json");

async function readRuntimeJson<T>(runtime: GjcTeamWorkerRuntime, filePath: string): Promise<T | null> {
	try {
		return await runtime.readJson<T>(filePath);
	} catch {
		// Mutable worker records are operator-visible state. Treat malformed records as absent
		// so continuation fails closed while liveness reconciliation can still recover claims.
		return null;
	}
}

export type GjcShutdownAuthority =
	| { state: "proven_absent" }
	| { state: "valid_present" }
	| { state: "invalid_or_unreadable" };

export function isGjcShutdownRequestRecord(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.worker === "string" &&
		record.worker.length > 0 &&
		typeof record.requested_by === "string" &&
		record.requested_by.length > 0 &&
		typeof record.request_id === "string" &&
		record.request_id.length > 0 &&
		(record.mode === "graceful" || record.mode === "force" || record.mode === "abort") &&
		typeof record.requested_at === "string" &&
		Number.isFinite(Date.parse(record.requested_at))
	);
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Distinguishes a missing shutdown record from a present JSON `null` or invalid record. */
export async function readGjcShutdownAuthority(
	runtime: GjcTeamWorkerRuntime,
	filePath: string,
): Promise<GjcShutdownAuthority> {
	try {
		await fs.access(filePath);
	} catch (error) {
		if (isEnoent(error)) return { state: "proven_absent" };
		return { state: "invalid_or_unreadable" };
	}
	try {
		const value = await runtime.readJson<unknown>(filePath);
		return isGjcShutdownRequestRecord(value) ? { state: "valid_present" } : { state: "invalid_or_unreadable" };
	} catch {
		return { state: "invalid_or_unreadable" };
	}
}

export function parseGjcWorkerStatusState(value: unknown): GjcWorkerStatusState {
	return typeof value === "string" &&
		["idle", "working", "blocked", "done", "failed", "draining", "unknown"].includes(value)
		? (value as GjcWorkerStatusState)
		: "unknown";
}

export function lifecycleStateForWorkerStatus(status: GjcWorkerStatusState): GjcTeamWorkerLifecycleState {
	switch (status) {
		case "working":
			return "working";
		case "draining":
			return "draining";
		case "failed":
			return "failed";
		case "unknown":
			return "unknown";
		case "idle":
		case "blocked":
		case "done":
			return "ready";
	}
}

export async function readWorkerStatusFile(
	runtime: GjcTeamWorkerRuntime,
	dir: string,
	worker: string,
): Promise<WorkerStatusFile> {
	return (
		(await readRuntimeJson<WorkerStatusFile>(runtime, statusPath(runtime, dir, worker))) ?? {
			state: "unknown",
			updated_at: runtime.now(),
		}
	);
}

export async function readWorkerLifecycleRecord(
	runtime: GjcTeamWorkerRuntime,
	dir: string,
	worker: GjcTeamWorker,
): Promise<GjcTeamWorkerLifecycle> {
	const workerStatus = await readWorkerStatusFile(runtime, dir, worker.id);
	const heartbeat = await readRuntimeJson<WorkerHeartbeatFile>(runtime, heartbeatPath(runtime, dir, worker.id));
	const raw = await readRuntimeJson<Partial<GjcTeamWorkerLifecycle>>(runtime, lifecyclePath(runtime, dir, worker.id));
	const shutdownAck = await readRuntimeJson<Record<string, unknown>>(
		runtime,
		path.join(runtime.workerDir(dir, worker.id), "shutdown-ack.json"),
	);

	const lifecycle: GjcTeamWorkerLifecycle = {
		worker: worker.id,
		lifecycle_state: parseLifecycleState(raw?.lifecycle_state),
		worker_status_state: parseGjcWorkerStatusState(workerStatus.state),
		pane_id: worker.pane_id ?? raw?.pane_id,
		updated_at: raw?.updated_at ?? workerStatus.updated_at ?? runtime.now(),
	};
	if (typeof raw?.pid === "number") lifecycle.pid = raw.pid;
	else if (typeof heartbeat?.pid === "number") lifecycle.pid = heartbeat.pid;
	if (raw?.started_at) lifecycle.started_at = raw.started_at;
	if (raw?.stopped_at) lifecycle.stopped_at = raw.stopped_at;
	if (raw?.stop_reason) lifecycle.stop_reason = raw.stop_reason;
	if (raw?.shutdown_request_id) lifecycle.shutdown_request_id = raw.shutdown_request_id;
	if (raw?.shutdown_requested_at) lifecycle.shutdown_requested_at = raw.shutdown_requested_at;
	if (raw?.shutdown_mode === "graceful" || raw?.shutdown_mode === "force" || raw?.shutdown_mode === "abort")
		lifecycle.shutdown_mode = raw.shutdown_mode;
	if (typeof shutdownAck?.acknowledged_at === "string")
		lifecycle.shutdown_acknowledged_at = shutdownAck.acknowledged_at;
	if (typeof shutdownAck?.status === "string") lifecycle.shutdown_ack_status = shutdownAck.status;
	return lifecycle;
}

const parseLifecycleState = (value: unknown): GjcTeamWorkerLifecycleState =>
	typeof value === "string" &&
	["starting", "ready", "working", "draining", "stopped", "failed", "unknown"].includes(value)
		? (value as GjcTeamWorkerLifecycleState)
		: "unknown";

export async function readWorkerLifecycleById(
	runtime: GjcTeamWorkerRuntime,
	dir: string,
	config: GjcTeamConfig,
): Promise<Record<string, GjcTeamWorkerLifecycle>> {
	const records = await Promise.all(config.workers.map(worker => readWorkerLifecycleRecord(runtime, dir, worker)));
	return Object.fromEntries(records.map(record => [record.worker, record]));
}

export async function writeWorkerLifecycleRecord(
	runtime: GjcTeamWorkerRuntime,
	dir: string,
	worker: GjcTeamWorker,
	lifecycleState: GjcTeamWorkerLifecycleState,
	updates: Partial<GjcTeamWorkerLifecycle> = {},
): Promise<GjcTeamWorkerLifecycle> {
	const current = await readWorkerLifecycleRecord(runtime, dir, worker);
	const next: GjcTeamWorkerLifecycle = {
		...current,
		...updates,
		worker: worker.id,
		lifecycle_state: lifecycleState,
		worker_status_state: current.worker_status_state,
		pane_id: updates.pane_id ?? worker.pane_id ?? current.pane_id,
		updated_at: runtime.now(),
	};
	await runtime.writeJson(lifecyclePath(runtime, dir, worker.id), next);
	return next;
}

export async function writeWorkerLifecycleForConfig(
	runtime: GjcTeamWorkerRuntime,
	dir: string,
	config: GjcTeamConfig,
	lifecycleState: GjcTeamWorkerLifecycleState,
	updatesFor: (worker: GjcTeamWorker) => Partial<GjcTeamWorkerLifecycle> = () => ({}),
): Promise<Record<string, GjcTeamWorkerLifecycle>> {
	const records = await Promise.all(
		config.workers.map(worker =>
			writeWorkerLifecycleRecord(runtime, dir, worker, lifecycleState, updatesFor(worker)),
		),
	);
	return Object.fromEntries(records.map(record => [record.worker, record]));
}

export async function readGjcWorkerStatus(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerStatusFile> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	runtime.assertKnownWorker(await runtime.readConfig(dir), worker);
	return readWorkerStatusFile(runtime, dir, worker);
}

export async function updateGjcWorkerStatus(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	status: GjcWorkerStatusState,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	currentTaskId?: string,
	reason?: string,
): Promise<WorkerStatusFile> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	const teamWorker = runtime.findKnownWorker(config, worker);
	const value: WorkerStatusFile = {
		state: status,
		...(currentTaskId ? { current_task_id: currentTaskId } : {}),
		...(reason?.trim() ? { reason: reason.trim() } : {}),
		updated_at: runtime.now(),
	};
	await runtime.writeJson(statusPath(runtime, dir, worker), value);
	const current = await readWorkerLifecycleRecord(runtime, dir, teamWorker);
	await writeWorkerLifecycleRecord(
		runtime,
		dir,
		teamWorker,
		current.lifecycle_state === "stopped" ? "stopped" : lifecycleStateForWorkerStatus(status),
	);
	await runtime.appendEvent(dir, {
		type: "worker_status_updated",
		worker,
		message: `Worker ${worker} reported ${status}`,
		data: { status, current_task_id: currentTaskId },
	});
	return value;
}

export async function readGjcWorkerHeartbeat(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile | null> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	runtime.assertKnownWorker(await runtime.readConfig(dir), worker);
	return readRuntimeJson<WorkerHeartbeatFile>(runtime, heartbeatPath(runtime, dir, worker));
}

export async function updateGjcWorkerHeartbeat(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	heartbeat: WorkerHeartbeatFile,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	runtime.assertKnownWorker(await runtime.readConfig(dir), worker);
	const value = { ...heartbeat, last_turn_at: heartbeat.last_turn_at || runtime.now() };
	await runtime.writeJson(heartbeatPath(runtime, dir, worker), value);
	return value;
}

export async function writeGjcWorkerStartupAck(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const teamWorker = runtime.findKnownWorker(await runtime.readConfig(dir), worker);
	const ack = {
		worker,
		pid: typeof input.pid === "number" ? input.pid : undefined,
		session: typeof input.session === "string" ? input.session : undefined,
		protocol_version: String(input.protocol_version ?? "1"),
		ack_at: runtime.now(),
	};
	await runtime.writeJson(path.join(runtime.workerDir(dir, worker), "startup-ack.json"), ack);
	await writeWorkerLifecycleRecord(runtime, dir, teamWorker, "ready", {
		pane_id: teamWorker.pane_id,
		pid: typeof input.pid === "number" ? input.pid : undefined,
		started_at: ack.ack_at,
	});
	await runtime.appendEvent(dir, {
		type: "worker_startup_ack",
		worker,
		message: `Worker ${worker} acknowledged startup`,
	});
	return ack;
}

export async function writeGjcShutdownRequest(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	requestedBy: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	requestId: string,
	mode: GjcTeamShutdownMode = "graceful",
	requestedAt = runtime.now(),
): Promise<Record<string, unknown>> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	const teamWorker = runtime.findKnownWorker(config, worker);
	runtime.assertKnownParticipant(config, requestedBy);
	const value = { worker, requested_by: requestedBy, request_id: requestId, mode, requested_at: requestedAt };
	await runtime.writeJson(path.join(runtime.workerDir(dir, worker), "shutdown-request.json"), value);
	await writeWorkerLifecycleRecord(runtime, dir, teamWorker, "draining", {
		shutdown_request_id: requestId,
		shutdown_requested_at: requestedAt,
		shutdown_mode: mode,
	});
	await runtime.appendEvent(dir, {
		type: "worker_shutdown_requested",
		worker,
		message: `Worker ${worker} shutdown requested`,
		data: { requested_by: requestedBy, request_id: requestId, mode },
	});
	return value;
}

export async function readGjcShutdownAck(
	runtime: GjcTeamWorkerRuntime,
	teamName: string,
	worker: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	runtime.assertKnownWorker(await runtime.readConfig(dir), worker);
	return runtime.readJson<Record<string, unknown>>(path.join(runtime.workerDir(dir, worker), "shutdown-ack.json"));
}

function addRecoveryReason(reasons: GjcTeamLivenessRecoveryReason[], reason: GjcTeamLivenessRecoveryReason): void {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function claimFromUnknown(value: unknown): GjcTeamTaskClaim | undefined {
	if (typeof value !== "object" || value == null) return undefined;
	const record = value as Record<string, unknown>;
	const owner = typeof record.owner === "string" ? record.owner : "";
	const token = typeof record.token === "string" ? record.token : "";
	const leasedUntil = typeof record.leased_until === "string" ? record.leased_until : "";
	return owner && token && leasedUntil ? { owner, token, leased_until: leasedUntil } : undefined;
}

async function hasCurrentContinuationClaimAuthority(
	runtime: GjcTeamWorkerOrchestrationRuntime,
	dir: string,
	worker: string,
	task: GjcTeamTask,
	claim: GjcTeamTaskClaim,
): Promise<boolean> {
	let canonicalClaim: unknown;
	let canonicalTask: unknown;
	try {
		canonicalClaim = await runtime.readJson<unknown>(path.join(dir, "claims", `${task.id}.json`));
		canonicalTask = await runtime.readJson<unknown>(path.join(dir, "tasks", `${task.id}.json`));
	} catch {
		return false;
	}
	if (!isCanonicalPersistedGjcTeamTaskClaim(canonicalClaim)) return false;
	if (
		canonicalClaim.owner !== claim.owner ||
		canonicalClaim.token !== claim.token ||
		canonicalClaim.leased_until !== claim.leased_until
	)
		return false;
	if (!isCanonicalPersistedGjcTeamTask(canonicalTask, task.id)) return false;
	return (
		canonicalTask.version === task.version &&
		canonicalTask.status === "in_progress" &&
		canonicalTask.owner === worker &&
		canonicalTask.assignee === worker &&
		canonicalTask.claim?.owner === canonicalClaim.owner &&
		canonicalTask.claim?.token === canonicalClaim.token &&
		canonicalTask.claim?.leased_until === canonicalClaim.leased_until
	);
}

function claimIsExpired(value: string | undefined, nowMs: number): boolean {
	if (!value) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp <= nowMs;
}

async function livenessReasons(
	runtime: GjcTeamWorkerOrchestrationRuntime,
	dir: string,
	config: GjcTeamConfig,
	worker: GjcTeamWorker,
	env: NodeJS.ProcessEnv,
): Promise<GjcTeamLivenessRecoveryReason[]> {
	const reasons: GjcTeamLivenessRecoveryReason[] = [];
	const lifecycle = await readWorkerLifecycleRecord(runtime, dir, worker);
	const heartbeat = await readRuntimeJson<WorkerHeartbeatFile>(runtime, heartbeatPath(runtime, dir, worker.id));

	if (lifecycle.lifecycle_state === "failed") addRecoveryReason(reasons, "worker_lifecycle_failed");
	if (lifecycle.lifecycle_state === "stopped") addRecoveryReason(reasons, "worker_lifecycle_stopped");
	const staleMs = runtime.parseHeartbeatStaleMs(env);
	const heartbeatAt = Date.parse(heartbeat?.last_turn_at ?? worker.last_heartbeat);
	if (staleMs > 0 && Number.isFinite(heartbeatAt) && runtime.nowMs() - heartbeatAt >= staleMs)
		addRecoveryReason(reasons, "stale_heartbeat");
	if (
		!config.dry_run &&
		(!worker.pane_id?.startsWith("%") || !runtime.paneBelongsToTeamTarget(config, worker.pane_id))
	)
		addRecoveryReason(reasons, "missing_pane");
	return reasons;
}

function isValidRecordedWorkerStatus(status: WorkerStatusFile): boolean {
	return (
		typeof status === "object" &&
		status !== null &&
		["idle", "working", "blocked", "done", "failed", "draining", "unknown"].includes(status.state) &&
		typeof status.updated_at === "string" &&
		Number.isFinite(Date.parse(status.updated_at))
	);
}

function isContinuationLifecycleEligible(lifecycle: GjcTeamWorkerLifecycle, status: WorkerStatusFile): boolean {
	return (
		isValidRecordedWorkerStatus(status) &&
		(lifecycle.lifecycle_state === "ready" || lifecycle.lifecycle_state === "working") &&
		status.state !== "draining" &&
		status.state !== "failed" &&
		status.state !== "unknown"
	);
}

export const GJC_TEAM_CONTINUATION_PROMPT =
	"Continue only your current claimed GJC team task. Re-read current GJC team state; do not replay prior output; report status.";

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function gjcContinuationReservationDigest(reservation: Record<string, unknown>): string {
	return createHash("sha256").update(canonicalJson(reservation)).digest("hex");
}

const reservationKeys = new Set([
	"schema_version",
	"incident_hash",
	"team_name",
	"worker",
	"task_id",
	"owner",
	"claim_token",
	"task_version",
	"leased_until",
	"heartbeat_at",
	"pane_id",
	"tmux_target",
	"attempt",
	"reserved_at",
	"hold_until",
	"prompt_version",
	"prompt_sha256",
	"dispatch_protocol",
]);

export function isValidGjcContinuationReservation(
	value: unknown,
	incident: string,
	attempt: number,
	config: GjcTeamConfig,
	worker: string,
	task: GjcTeamTask,
	claim: GjcTeamTaskClaim,
	heartbeatAt: string,
	paneId: string,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== reservationKeys.size ||
		Object.keys(record).some(key => !reservationKeys.has(key))
	)
		return false;
	const reservedAt = typeof record.reserved_at === "string" ? Date.parse(record.reserved_at) : Number.NaN;
	const holdUntil = typeof record.hold_until === "string" ? Date.parse(record.hold_until) : Number.NaN;
	const leaseUntil = Date.parse(claim.leased_until);
	return (
		record.schema_version === 1 &&
		record.incident_hash === incident &&
		record.team_name === config.team_name &&
		record.worker === worker &&
		record.task_id === task.id &&
		record.owner === claim.owner &&
		record.claim_token === claim.token &&
		record.task_version === task.version &&
		record.leased_until === claim.leased_until &&
		record.heartbeat_at === heartbeatAt &&
		record.pane_id === paneId &&
		record.tmux_target === config.tmux_target &&
		record.attempt === attempt &&
		record.prompt_version === 1 &&
		record.dispatch_protocol === "tmux_command_sequence_v1" &&
		record.prompt_sha256 === createHash("sha256").update(GJC_TEAM_CONTINUATION_PROMPT).digest("hex") &&
		Number.isFinite(reservedAt) &&
		Number.isFinite(holdUntil) &&
		Number.isFinite(leaseUntil) &&
		holdUntil - reservedAt === (attempt === 1 ? 30_000 : 120_000) &&
		leaseUntil >= holdUntil
	);
}

export function isValidGjcContinuationOutcome(
	value: unknown,
	reservation: Record<string, unknown>,
	incident: string,
	attempt: number,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const outcome = value as Record<string, unknown>;
	if (
		outcome.schema_version !== 1 ||
		outcome.incident_hash !== incident ||
		outcome.attempt !== attempt ||
		outcome.reservation_sha256 !== gjcContinuationReservationDigest(reservation) ||
		typeof outcome.recorded_at !== "string" ||
		!Number.isFinite(Date.parse(outcome.recorded_at)) ||
		typeof outcome.reason !== "string" ||
		outcome.reason.length === 0 ||
		outcome.reason.length > 160
	)
		return false;
	const exit = outcome.tmux_exit_code;
	const error = outcome.tmux_error;
	const validError =
		typeof error === "object" &&
		error !== null &&
		Object.keys(error).length >= 2 &&
		Object.keys(error).length <= 3 &&
		Object.keys(error).every(key => key === "name" || key === "code" || key === "message") &&
		typeof (error as Record<string, unknown>).name === "string" &&
		typeof (error as Record<string, unknown>).message === "string" &&
		String((error as Record<string, unknown>).name).length > 0 &&
		String((error as Record<string, unknown>).message).length > 0 &&
		String((error as Record<string, unknown>).name).length <= 120 &&
		String((error as Record<string, unknown>).message).length <= 400 &&
		((error as Record<string, unknown>).code === undefined ||
			(typeof (error as Record<string, unknown>).code === "string" &&
				String((error as Record<string, unknown>).code).length > 0 &&
				String((error as Record<string, unknown>).code).length <= 120));
	const baseKeys = [
		"schema_version",
		"incident_hash",
		"attempt",
		"reservation_sha256",
		"recorded_at",
		"result",
		"reason",
	];
	const hasExactKeys = (keys: readonly string[]) =>
		Object.keys(outcome).length === keys.length && Object.keys(outcome).every(key => keys.includes(key));
	if (outcome.result === "sent") {
		const dispatchedAt = Date.parse(String(outcome.dispatched_at));
		const holdUntil = Date.parse(String(outcome.hold_until));
		const leaseUntil = Date.parse(String(reservation.leased_until));
		return (
			hasExactKeys([...baseKeys, "tmux_exit_code", "dispatched_at", "hold_until"]) &&
			outcome.reason === "tmux_sent" &&
			exit === 0 &&
			Number.isFinite(dispatchedAt) &&
			Number.isFinite(holdUntil) &&
			Number.isFinite(leaseUntil) &&
			holdUntil - dispatchedAt === (attempt === 1 ? 30_000 : 120_000) &&
			leaseUntil >= holdUntil
		);
	}
	if (outcome.result === "skipped")
		return (
			hasExactKeys(baseKeys) &&
			[
				"invalid_or_absent_running_phase",
				"invalid_pane_authority",
				"shutdown_requested",
				"invalid_shutdown_authority",
				"heartbeat_changed",
				"invalid_worker_lifecycle_or_status",
				"claim_changed",
				"invalid_or_expired_lease",
				"invalid_authority_inventory",
				"lease_does_not_cover_hold",
				"unsupported_send_keys_transport",
			].includes(outcome.reason)
		);
	if (outcome.result !== "unknown") return false;
	return (
		(outcome.reason === "tmux_missing_exit_code" &&
			exit === undefined &&
			error === undefined &&
			hasExactKeys(baseKeys)) ||
		(outcome.reason === "tmux_nonzero_exit" &&
			typeof exit === "number" &&
			Number.isInteger(exit) &&
			exit !== 0 &&
			error === undefined &&
			hasExactKeys([...baseKeys, "tmux_exit_code"])) ||
		(outcome.reason === "tmux_dispatch_threw" &&
			exit === undefined &&
			validError &&
			hasExactKeys([...baseKeys, "tmux_error"]))
	);
}

async function hasActiveContinuationHold(
	runtime: GjcTeamWorkerOrchestrationRuntime,
	dir: string,
	worker: string,
	config: GjcTeamConfig,
	task: GjcTeamTask,
	claim: GjcTeamTaskClaim,
): Promise<boolean> {
	if (!(await hasCurrentContinuationClaimAuthority(runtime, dir, worker, task, claim))) return false;
	const heartbeat = await readRuntimeJson<WorkerHeartbeatFile>(runtime, heartbeatPath(runtime, dir, worker));

	const teamWorker = config.workers.find(candidate => candidate.id === worker);
	const paneId = teamWorker?.pane_id;
	const lifecycle = teamWorker ? await readWorkerLifecycleRecord(runtime, dir, teamWorker) : undefined;
	const status = await readWorkerStatusFile(runtime, dir, worker);
	const phase = await readRuntimeJson<Record<string, unknown>>(runtime, path.join(dir, "phase.json"));
	const shutdownAuthority = await readGjcShutdownAuthority(
		runtime,
		path.join(runtime.workerDir(dir, worker), "shutdown-request.json"),
	);

	if (
		!heartbeat?.last_turn_at ||
		!paneId ||
		!lifecycle ||
		!isContinuationLifecycleEligible(lifecycle, status) ||
		phase?.current_phase !== "running" ||
		shutdownAuthority.state !== "proven_absent"
	)
		return false;
	const incident = runtime.stableHash(
		[
			config.team_name,
			worker,
			task.id,
			claim.owner,
			claim.token,
			task.version,
			heartbeat.last_turn_at,
			paneId,
			config.tmux_target,
		].join(":"),
	);
	const continuations = path.join(runtime.workerDir(dir, worker), "continuations", incident);
	for (const attempt of [1, 2]) {
		const reservation = await readRuntimeJson<Record<string, unknown>>(
			runtime,
			path.join(continuations, `attempt-0${attempt}.reservation.json`),
		);

		if (
			!isValidGjcContinuationReservation(
				reservation,
				incident,
				attempt,
				config,
				worker,
				task,
				claim,
				heartbeat.last_turn_at,
				paneId,
			)
		)
			return false;
		const reservationHoldUntil = Date.parse(String(reservation.hold_until));
		if (!Number.isFinite(reservationHoldUntil)) return false;
		const outcomePath = path.join(continuations, `attempt-0${attempt}.outcome.json`);
		let outcome: Record<string, unknown> | null;
		try {
			outcome = await runtime.readJson<Record<string, unknown>>(outcomePath);
		} catch (error) {
			if (!isEnoent(error)) return false;
			outcome = null;
		}
		const nowMs = runtime.nowMs();
		// Only proven ENOENT is crash-ambiguous. Present JSON null, malformed, or unreadable
		// outcomes are invalid authority and must not retain a recovery hold.
		if (outcome === null) {
			try {
				await fs.access(outcomePath);
			} catch (error) {
				if (!isEnoent(error)) return false;
				if (reservationHoldUntil <= nowMs) continue;
				if (claimIsExpired(claim.leased_until, nowMs)) return false;
				return true;
			}
			return false;
		}
		if (!isValidGjcContinuationOutcome(outcome, reservation, incident, attempt)) return false;
		if (outcome.result === "skipped") continue;
		const holdUntil = outcome.result === "sent" ? Date.parse(String(outcome.hold_until)) : reservationHoldUntil;
		if (!Number.isFinite(holdUntil) || holdUntil <= nowMs) continue;
		if (claimIsExpired(claim.leased_until, nowMs)) return false;
		return true;
	}
	return false;
}

export async function reconcileGjcTeamStaleClaims(
	runtime: GjcTeamWorkerOrchestrationRuntime,
	teamName: string,
	dir: string,
	config: GjcTeamConfig,
	env: NodeJS.ProcessEnv,
): Promise<GjcTeamLivenessRecoveryResult> {
	return runtime.withTaskMutation(dir, capability =>
		reconcileGjcTeamStaleClaimsUnlocked(runtime, teamName, dir, config, env, capability),
	);
}

export async function reconcileGjcTeamStaleClaimsUnlocked(
	runtime: GjcTeamWorkerOrchestrationRuntime,
	teamName: string,
	dir: string,
	config: GjcTeamConfig,
	env: NodeJS.ProcessEnv,
	capability: GjcTeamTaskMutationCapability,
): Promise<GjcTeamLivenessRecoveryResult> {
	const staleWorkers: Record<string, GjcTeamLivenessRecoveryReason[]> = {};
	for (const worker of config.workers) {
		const reasons = await livenessReasons(runtime, dir, config, worker, env);
		if (reasons.length === 0) continue;
		staleWorkers[worker.id] = reasons;
		if (reasons.includes("missing_pane") && !reasons.includes("worker_lifecycle_stopped")) {
			try {
				await fs.access(runtime.workerDir(dir, worker.id));
				await writeWorkerLifecycleRecord(runtime, dir, worker, "failed", { stop_reason: "pane_missing" });
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}
	const recoveredClaims: GjcTeamRecoveredClaim[] = [];
	for (const task of await runtime.readTasks(dir)) {
		if (task.status === "completed" || task.status === "failed") continue;
		const claimPath = path.join(dir, "claims", `${task.id}.json`);
		const claim = task.claim ?? claimFromUnknown(await readRuntimeJson<unknown>(runtime, claimPath));
		if (!claim) continue;
		const reasons = [...(staleWorkers[claim.owner] ?? [])];
		if (claimIsExpired(claim.leased_until, runtime.nowMs())) addRecoveryReason(reasons, "claim_expired");
		if (reasons.length === 0) continue;
		if (
			reasons.length === 1 &&
			reasons[0] === "stale_heartbeat" &&
			(await hasActiveContinuationHold(runtime, dir, claim.owner, config, task, claim))
		)
			continue;
		await fs.rm(claimPath, { force: true });
		recoveredClaims.push({ task_id: task.id, worker: claim.owner, reasons });
		if (task.status === "in_progress")
			await capability.writeRecovered(
				normalizeGjcTeamTask({
					...task,
					status: "pending",
					assignee: undefined,
					claim: undefined,
					version: task.version + 1,
					updated_at: runtime.now(),
				}),
			);
		await runtime.appendEvent(dir, {
			type: "task_claim_recovered",
			task_id: task.id,
			worker: claim.owner,
			message:
				task.status === "in_progress" ? "Recovered task from stale worker claim" : "Removed stale task claim file",
			data: { reasons },
		});
	}
	if (recoveredClaims.length > 0)
		await runtime.appendTelemetry(dir, {
			type: "team_liveness_recovery",
			message: `Recovered ${recoveredClaims.length} stale team task claim(s)`,
			data: { team_name: teamName, recovered_claims: recoveredClaims },
		});
	return { recovered_claims: recoveredClaims, stale_workers: staleWorkers };
}

export async function shutdownGjcTeamWorkers(
	runtime: GjcTeamWorkerOrchestrationRuntime,
	teamName: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<GjcTeamSnapshot> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	const tasks = await runtime.readTasks(dir);
	const evidenceFailures = tasks.flatMap(task => {
		const reason = task.status === "completed" ? getGjcTeamTaskCompletionEvidenceFailure(task) : null;
		return reason ? [{ task_id: task.id, reason }] : [];
	});
	const requestId = `shutdown-${runtime.stableHash([config.team_name, runtime.now(), crypto.randomUUID()].join(":"))}`;
	const requestedAt = runtime.now();
	await Promise.all(
		config.workers.map(worker =>
			writeGjcShutdownRequest(
				runtime,
				teamName,
				worker.id,
				"leader-fixed",
				cwd,
				env,
				requestId,
				"graceful",
				requestedAt,
			),
		),
	);
	const completionVerified = tasks.length === 0 || tasks.every(isGjcTeamTaskCompletionVerified);
	const pendingIntegration = completionVerified
		? await runtime.hasPendingIntegration(dir, config, await runtime.readMonitorSnapshot(dir))
		: false;
	runtime.killWorkerPanes(config);
	await runtime.removeCleanCreatedWorktrees(config.workers);
	const stopped: GjcTeamConfig = {
		...config,
		workers: config.workers.map(worker => ({ ...worker, status: "stopped", last_heartbeat: runtime.now() })),
		updated_at: runtime.now(),
	};
	await runtime.writeJson(path.join(dir, "config.json"), stopped);
	await writeWorkerLifecycleForConfig(runtime, dir, stopped, "stopped", worker => ({
		pane_id: worker.pane_id,
		stopped_at: stopped.updated_at,
		stop_reason: "graceful_shutdown",
		shutdown_request_id: requestId,
		shutdown_requested_at: requestedAt,
		shutdown_mode: "graceful",
	}));
	const lifecycle = await readWorkerLifecycleById(runtime, dir, stopped);
	const graceful = stopped.workers.every(
		worker =>
			lifecycle[worker.id]?.lifecycle_state === "stopped" &&
			lifecycle[worker.id]?.shutdown_request_id === requestId &&
			lifecycle[worker.id]?.shutdown_mode === "graceful",
	);
	const phase: GjcTeamPhase =
		completionVerified && graceful
			? pendingIntegration
				? "awaiting_integration"
				: "complete"
			: evidenceFailures.length > 0 || tasks.some(task => task.status === "failed" || task.status === "blocked")
				? "failed"
				: "cancelled";
	await runtime.writePhase(dir, phase);
	const data: Record<string, unknown> = {
		phase,
		shutdown_request_id: requestId,
		graceful_shutdown_complete: graceful,
	};
	if (evidenceFailures.length > 0) data.evidence_failures = evidenceFailures;
	await runtime.appendEvent(dir, {
		type: "team_shutdown",
		message:
			phase === "complete"
				? "Shut down native gjc team runtime after completed tasks"
				: "Shut down native gjc team runtime with incomplete tasks",
		data,
	});
	await runtime.appendTelemetry(dir, {
		type: "team_shutdown",
		message: `Native gjc team runtime stopped with phase ${phase}`,
		data: { shutdown_request_id: requestId, graceful_shutdown_complete: graceful },
	});
	return runtime.readSnapshot(config.team_name, cwd, env);
}
