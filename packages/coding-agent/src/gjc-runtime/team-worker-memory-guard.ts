import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendJsonl, type StateWriterOptions } from "./state-writer";

export type GjcTeamWorkerMemoryGuardState = "idle" | "advisory" | "retrying" | "checkpointed" | "replaced" | "blocked";

export type GjcTeamWorkerMemoryGuardCheckpointKind =
	| "clean"
	| "eligible"
	| "protected_only"
	| "conflicted"
	| "git_error";

export type GjcTeamWorkerMemoryGuardPidProbe =
	| { kind: "live"; start_time: string }
	| { kind: "absent" }
	| { kind: "unverifiable"; reason: string };

export interface GjcTeamWorkerMemoryGuardCheckpoint {
	kind: GjcTeamWorkerMemoryGuardCheckpointKind;
	files: string[];
	head?: string | null;
	commit?: string | null;
	recorded_at: string;
}

export interface GjcTeamWorkerMemoryGuardReplacement {
	old_pane_id?: string;
	new_pane_id?: string;
	recorded_at: string;
}

export interface GjcTeamWorkerMemoryGuardLedger {
	schema_version: 1;
	worker_id: string;
	platform: string;
	state: GjcTeamWorkerMemoryGuardState;
	automatic_action_allowed: boolean;
	retry_count: number;
	retry_limit: number;
	current_task_id?: string;
	last_incident_id?: string;
	last_reason?: string;
	last_pid_probe?: GjcTeamWorkerMemoryGuardPidProbe;
	last_checkpoint?: GjcTeamWorkerMemoryGuardCheckpoint;
	last_replacement?: GjcTeamWorkerMemoryGuardReplacement;
	updated_at: string;
}

export interface GjcTeamWorkerMemoryGuardSelectionCandidate {
	worker_id: string;
	platform: string;
	excess_bytes: number;
	retry_count: number;
	retry_limit: number;
	blocked?: boolean;
	current_task_id?: string;
}

export interface GjcTeamWorkerMemoryGuardSelection {
	worker_id: string;
	excess_bytes: number;
	retry_count: number;
	current_task_id?: string;
}

const ledgerKeys = new Set([
	"schema_version",
	"worker_id",
	"platform",
	"state",
	"automatic_action_allowed",
	"retry_count",
	"retry_limit",
	"current_task_id",
	"last_incident_id",
	"last_reason",
	"last_pid_probe",
	"last_checkpoint",
	"last_replacement",
	"updated_at",
]);
const checkpointKeys = new Set(["kind", "files", "head", "commit", "recorded_at"]);
const replacementKeys = new Set(["old_pane_id", "new_pane_id", "recorded_at"]);
const absentPidProbeKeys = new Set(["kind"]);
const livePidProbeKeys = new Set(["kind", "start_time"]);
const unverifiablePidProbeKeys = new Set(["kind", "reason"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(value).every(key => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRetryCount(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isWorkerMemoryGuardState(value: unknown): value is GjcTeamWorkerMemoryGuardState {
	return ["idle", "advisory", "retrying", "checkpointed", "replaced", "blocked"].includes(String(value));
}

function isCheckpointKind(value: unknown): value is GjcTeamWorkerMemoryGuardCheckpointKind {
	return ["clean", "eligible", "protected_only", "conflicted", "git_error"].includes(String(value));
}

export function workerMemoryGuardLedgerPath(dir: string, workerId: string): string {
	return path.join(dir, "workers", workerId, "memory-guard.json");
}

export function normalizeGjcTeamWorkerMemoryGuardPidProbe(
	value: unknown,
): GjcTeamWorkerMemoryGuardPidProbe | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("invalid_worker_memory_guard_pid_probe");
	const kind = typeof value.kind === "string" ? value.kind : "";
	if (kind === "absent") {
		if (!hasExactKeys(value, absentPidProbeKeys)) throw new Error("invalid_worker_memory_guard_pid_probe:absent");
		return { kind: "absent" };
	}
	if (kind === "live") {
		if (!hasExactKeys(value, livePidProbeKeys) || !isNonEmptyString(value.start_time))
			throw new Error("invalid_worker_memory_guard_pid_probe:live");
		return { kind: "live", start_time: value.start_time.trim() };
	}
	if (kind === "unverifiable") {
		if (!hasExactKeys(value, unverifiablePidProbeKeys) || !isNonEmptyString(value.reason))
			throw new Error("invalid_worker_memory_guard_pid_probe:unverifiable");
		return { kind: "unverifiable", reason: value.reason.trim() };
	}
	throw new Error("invalid_worker_memory_guard_pid_probe");
}

export function isCanonicalGjcTeamWorkerMemoryGuardCheckpoint(
	value: unknown,
): value is GjcTeamWorkerMemoryGuardCheckpoint {
	return (
		isRecord(value) &&
		hasExactKeys(value, checkpointKeys) &&
		isCheckpointKind(value.kind) &&
		Array.isArray(value.files) &&
		value.files.every(file => isNonEmptyString(file)) &&
		(value.head === undefined || value.head === null || isNonEmptyString(value.head)) &&
		(value.commit === undefined || value.commit === null || isNonEmptyString(value.commit)) &&
		isTimestamp(value.recorded_at)
	);
}

export function isCanonicalGjcTeamWorkerMemoryGuardReplacement(
	value: unknown,
): value is GjcTeamWorkerMemoryGuardReplacement {
	return (
		isRecord(value) &&
		hasExactKeys(value, replacementKeys) &&
		(value.old_pane_id === undefined || isNonEmptyString(value.old_pane_id)) &&
		(value.new_pane_id === undefined || isNonEmptyString(value.new_pane_id)) &&
		isTimestamp(value.recorded_at)
	);
}

export function isCanonicalGjcTeamWorkerMemoryGuardPidProbe(value: unknown): value is GjcTeamWorkerMemoryGuardPidProbe {
	try {
		return normalizeGjcTeamWorkerMemoryGuardPidProbe(value) !== undefined;
	} catch {
		return false;
	}
}

export function isCanonicalGjcTeamWorkerMemoryGuardLedger(value: unknown): value is GjcTeamWorkerMemoryGuardLedger {
	return (
		isRecord(value) &&
		hasExactKeys(value, ledgerKeys) &&
		value.schema_version === 1 &&
		isNonEmptyString(value.worker_id) &&
		isNonEmptyString(value.platform) &&
		isWorkerMemoryGuardState(value.state) &&
		typeof value.automatic_action_allowed === "boolean" &&
		isRetryCount(value.retry_count) &&
		isRetryCount(value.retry_limit) &&
		(value.current_task_id === undefined || isNonEmptyString(value.current_task_id)) &&
		(value.last_incident_id === undefined || isNonEmptyString(value.last_incident_id)) &&
		(value.last_reason === undefined || isNonEmptyString(value.last_reason)) &&
		(value.last_pid_probe === undefined || isCanonicalGjcTeamWorkerMemoryGuardPidProbe(value.last_pid_probe)) &&
		(value.last_checkpoint === undefined || isCanonicalGjcTeamWorkerMemoryGuardCheckpoint(value.last_checkpoint)) &&
		(value.last_replacement === undefined ||
			isCanonicalGjcTeamWorkerMemoryGuardReplacement(value.last_replacement)) &&
		isTimestamp(value.updated_at)
	);
}

export function createInitialGjcTeamWorkerMemoryGuardLedger(input: {
	workerId: string;
	platform: string;
	now: string;
	retryLimit?: number;
}): GjcTeamWorkerMemoryGuardLedger {
	const retryLimit = Number.isInteger(input.retryLimit) && (input.retryLimit ?? 0) > 0 ? input.retryLimit! : 2;
	return {
		schema_version: 1,
		worker_id: input.workerId,
		platform: input.platform.trim() || "unknown",
		state: "idle",
		automatic_action_allowed: false,
		retry_count: 0,
		retry_limit: retryLimit,
		updated_at: input.now,
	};
}

function workerIndex(workerId: string): number {
	const match = /(?:^|[^0-9])(\d+)$/.exec(workerId);
	return match ? Number.parseInt(match[1]!, 10) : Number.MAX_SAFE_INTEGER;
}

export function selectGjcTeamWorkerMemoryGuardCandidate(
	candidates: readonly GjcTeamWorkerMemoryGuardSelectionCandidate[],
): GjcTeamWorkerMemoryGuardSelection | undefined {
	const eligible = candidates
		.filter(candidate => candidate.platform === "linux")
		.filter(candidate => Number.isFinite(candidate.excess_bytes) && candidate.excess_bytes > 0)
		.filter(candidate => !candidate.blocked)
		.filter(candidate => candidate.retry_count < candidate.retry_limit)
		.sort((left, right) => {
			if (right.excess_bytes !== left.excess_bytes) return right.excess_bytes - left.excess_bytes;
			if (left.retry_count !== right.retry_count) return left.retry_count - right.retry_count;
			const leftIndex = workerIndex(left.worker_id);
			const rightIndex = workerIndex(right.worker_id);
			if (leftIndex !== rightIndex) return leftIndex - rightIndex;
			return left.worker_id.localeCompare(right.worker_id);
		});
	const first = eligible[0];
	return first
		? {
				worker_id: first.worker_id,
				excess_bytes: first.excess_bytes,
				retry_count: first.retry_count,
				current_task_id: first.current_task_id,
			}
		: undefined;
}

export type TeamWorkerMemoryGuardAction = "advisory" | "replace" | "blocked";
export type TeamWorkerMemoryGuardResult = "noop" | "scheduled" | "succeeded" | "failed" | "blocked";

export interface TeamWorkerMemoryGuardLedgerEntry {
	schema_version: 1;
	recorded_at: string;
	incident_id: string;
	team_name: string;
	worker_id: string;
	task_id: string;
	claim_token: string;
	attempt: number;
	platform: NodeJS.Platform;
	action: TeamWorkerMemoryGuardAction;
	result: TeamWorkerMemoryGuardResult;
	reason: string;
}

const teamWorkerMemoryGuardActions = new Set<TeamWorkerMemoryGuardAction>(["advisory", "replace", "blocked"]);
const teamWorkerMemoryGuardResults = new Set<TeamWorkerMemoryGuardResult>([
	"noop",
	"scheduled",
	"succeeded",
	"failed",
	"blocked",
]);

export function isCanonicalTeamWorkerMemoryGuardLedgerEntry(value: unknown): value is TeamWorkerMemoryGuardLedgerEntry {
	if (!isRecord(value)) return false;
	const requiredKeys = [
		"schema_version",
		"recorded_at",
		"incident_id",
		"team_name",
		"worker_id",
		"task_id",
		"claim_token",
		"attempt",
		"platform",
		"action",
		"result",
		"reason",
	];
	return (
		Object.keys(value).length === requiredKeys.length &&
		requiredKeys.every(key => Object.hasOwn(value, key)) &&
		value.schema_version === 1 &&
		isTimestamp(value.recorded_at) &&
		isNonEmptyString(value.incident_id) &&
		isNonEmptyString(value.team_name) &&
		isNonEmptyString(value.worker_id) &&
		isNonEmptyString(value.task_id) &&
		isNonEmptyString(value.claim_token) &&
		Number.isInteger(value.attempt) &&
		(value.attempt as number) > 0 &&
		isNonEmptyString(value.platform) &&
		teamWorkerMemoryGuardActions.has(value.action as TeamWorkerMemoryGuardAction) &&
		teamWorkerMemoryGuardResults.has(value.result as TeamWorkerMemoryGuardResult) &&
		isNonEmptyString(value.reason)
	);
}

export function teamWorkerMemoryGuardDir(workerDirPath: string): string {
	return path.join(workerDirPath, "memory-guard");
}

export function teamWorkerMemoryGuardLedgerPath(workerDirPath: string): string {
	return path.join(teamWorkerMemoryGuardDir(workerDirPath), "ledger.jsonl");
}

export function canMutateTeamWorkerMemoryGuard(platform: NodeJS.Platform): boolean {
	return platform === "linux";
}

export function advisoryReasonForTeamWorkerMemoryGuard(platform: NodeJS.Platform): string | undefined {
	return canMutateTeamWorkerMemoryGuard(platform) ? undefined : `unsupported_platform:${platform}`;
}

export async function appendTeamWorkerMemoryGuardLedgerEntry(
	workerDirPath: string,
	entry: TeamWorkerMemoryGuardLedgerEntry,
	options?: StateWriterOptions,
): Promise<string> {
	await fs.mkdir(teamWorkerMemoryGuardDir(workerDirPath), { recursive: true });
	return appendJsonl(teamWorkerMemoryGuardLedgerPath(workerDirPath), entry, options);
}

export async function readTeamWorkerMemoryGuardLedger(
	workerDirPath: string,
): Promise<TeamWorkerMemoryGuardLedgerEntry[]> {
	const ledgerPath = teamWorkerMemoryGuardLedgerPath(workerDirPath);
	if (!(await Bun.file(ledgerPath).exists())) return [];
	const entries: TeamWorkerMemoryGuardLedgerEntry[] = [];
	for (const [index, line] of (await Bun.file(ledgerPath).text()).split(/\r?\n/).filter(Boolean).entries()) {
		const parsed = JSON.parse(line) as unknown;
		if (!isCanonicalTeamWorkerMemoryGuardLedgerEntry(parsed))
			throw new Error(`invalid_team_worker_memory_guard_ledger:${ledgerPath}:${index + 1}`);
		entries.push(parsed);
	}
	return entries;
}

export function nextTeamWorkerMemoryGuardAttempt(
	entries: readonly TeamWorkerMemoryGuardLedgerEntry[],
	incidentId: string,
): number {
	let attempt = 0;
	for (const entry of entries) {
		if (entry.incident_id === incidentId && entry.attempt > attempt) attempt = entry.attempt;
	}
	return attempt + 1;
}
