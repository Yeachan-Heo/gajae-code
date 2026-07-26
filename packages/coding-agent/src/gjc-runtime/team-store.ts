/** File-backed team task store, claims, leases, and completion evidence. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionIdFromDirName } from "./session-layout";
import {
	createJsonNoClobber,
	deleteIfOwned,
	removeFileAudited,
	withWorkflowStateLock,
	writeJsonAtomic,
} from "./state-writer";
import type { GjcTeamConfig, GjcTeamMailboxMessage } from "./team-runtime";

export type GjcTeamNotificationDeliveryState =
	| "pending"
	| "sent"
	| "queued"
	| "deferred"
	| "failed"
	| "delivered"
	| "acknowledged";
export type GjcTeamPaneAttemptResult = "sent" | "queued" | "deferred" | "failed";
export type GjcTeamMailboxDeliveryTransportKind = "sdk" | "pane";
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
export interface GjcTeamMailboxDeliveryInput {
	team_name: string;
	state_dir: string;
	config: GjcTeamConfig;
	notification: GjcTeamNotification;
	message: GjcTeamMailboxMessage;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
export type GjcTeamMailboxDeliveryResult =
	| {
			transport: "sdk";
			state: GjcTeamNotificationDeliveryState;
			reason?: string;
	  }
	| { transport: "pane"; state: GjcTeamPaneAttemptResult; reason?: string };
export interface GjcTeamMailboxDeliveryTransport {
	deliverMailboxMessage(input: GjcTeamMailboxDeliveryInput): Promise<GjcTeamMailboxDeliveryResult | null>;
}

export type GjcTeamTaskStatus = "pending" | "blocked" | "in_progress" | "completed" | "failed";
export interface GjcTeamTaskClaim {
	owner: string;
	token: string;
	leased_until: string;
}
export type GjcTeamTaskCompletionEvidenceKind = "command" | "inspection" | "artifact";
export type GjcTeamTaskCompletionEvidenceStatus = "passed" | "failed" | "not_run" | "verified" | "rejected";
export interface GjcTeamTaskCompletionEvidenceItem {
	kind: GjcTeamTaskCompletionEvidenceKind;
	status: GjcTeamTaskCompletionEvidenceStatus;
	summary: string;
	command?: string;
	artifact?: string;
	location?: string;
	output?: string;
}
export interface GjcTeamTaskCompletionEvidence {
	summary: string;
	items: GjcTeamTaskCompletionEvidenceItem[];
	files?: string[];
	notes?: string;
	recorded_by: string;
	recorded_at: string;
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
	completion_evidence?: GjcTeamTaskCompletionEvidence;
	error?: string;
	blocked_by?: string[];
	depends_on?: string[];
	lane?: string;
	required_role?: string;
	allowed_roles?: string[];
	version: number;
	claim?: GjcTeamTaskClaim;
	created_at: string;
	updated_at: string;
	completed_at?: string;
}
export type GjcTeamTaskMetadataInput = Partial<
	Pick<GjcTeamTask, "owner" | "lane" | "required_role" | "allowed_roles" | "depends_on" | "blocked_by">
>;
export interface GjcTeamTaskWorker {
	id: string;
	role: string;
	agent_type: string;
}
export interface GjcTeamApiClaimResult {
	ok: boolean;
	task?: GjcTeamTask;
	worker_id?: string;
	claim_token?: string;
	reason?: string;
}
export type GjcTeamWorkerClaimSelection =
	| { kind: "none" }
	| { kind: "exact"; task: GjcTeamTask; claim: GjcTeamTaskClaim }
	| { kind: "ambiguous"; tasks: GjcTeamTask[] };

export function selectCurrentClaimedTaskForWorker(
	tasks: readonly GjcTeamTask[],
	workerId: string,
): GjcTeamWorkerClaimSelection {
	const claimed = tasks.filter(
		task =>
			task.status === "in_progress" &&
			task.assignee === workerId &&
			task.claim?.owner === workerId &&
			task.owner === workerId,
	);
	if (claimed.length === 0) return { kind: "none" };
	if (claimed.length === 1) {
		const task = claimed[0]!;
		return { kind: "exact", task, claim: task.claim! };
	}
	return { kind: "ambiguous", tasks: claimed };
}
export function findGjcTeamClaimedTaskForWorker(
	tasks: readonly GjcTeamTask[],
	workerId: string,
): GjcTeamTask | undefined {
	const active = selectCurrentClaimedTaskForWorker(tasks, workerId);
	if (active.kind === "exact") return active.task;
	if (active.kind === "ambiguous") return undefined;
	return tasks.find(task => task.status === "blocked" && task.assignee === workerId && task.claim?.owner === workerId);
}

type EventAppender = (event: {
	type: string;
	task_id?: string;
	worker?: string;
	message: string;
	data?: Record<string, unknown>;
}) => Promise<void>;
const now = () => new Date().toISOString();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isEnoent = (error: unknown): error is { code: string } => isRecord(error) && error.code === "ENOENT";
const canonicalTaskKeys = new Set([
	"id",
	"subject",
	"description",
	"title",
	"objective",
	"status",
	"assignee",
	"owner",
	"result",
	"completion_evidence",
	"error",
	"blocked_by",
	"depends_on",
	"lane",
	"required_role",
	"allowed_roles",
	"version",
	"claim",
	"created_at",
	"updated_at",
	"completed_at",
]);
const canonicalClaimKeys = new Set(["owner", "token", "leased_until"]);
const canonicalEvidenceKeys = new Set(["summary", "items", "files", "notes", "recorded_by", "recorded_at"]);
const canonicalEvidenceItemKeys = new Set(["kind", "status", "summary", "command", "artifact", "location", "output"]);
const hasExactKeys = (value: Record<string, unknown>, keys: Set<string>) =>
	Object.keys(value).every(key => keys.has(key));
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isSafePersistedId = (value: unknown): value is string =>
	isNonEmptyString(value) && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) && !value.includes("..");
const isFiniteTimestamp = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

/** The sole strict schema gate for persisted task and claim authority records. */
export function isCanonicalPersistedGjcTeamTaskClaim(value: unknown): value is GjcTeamTaskClaim {
	if (!isRecord(value) || Array.isArray(value) || !hasExactKeys(value, canonicalClaimKeys)) return false;
	return isSafePersistedId(value.owner) && isNonEmptyString(value.token) && isFiniteTimestamp(value.leased_until);
}

function isCanonicalCompletionEvidence(value: unknown): value is GjcTeamTaskCompletionEvidence {
	if (!isRecord(value) || Array.isArray(value) || !hasExactKeys(value, canonicalEvidenceKeys)) return false;
	if (
		!isNonEmptyString(value.summary) ||
		!isSafePersistedId(value.recorded_by) ||
		!isFiniteTimestamp(value.recorded_at)
	)
		return false;
	if (!Array.isArray(value.items) || value.items.length === 0) return false;
	if (
		!value.items.every(item => {
			if (!isRecord(item) || Array.isArray(item) || !hasExactKeys(item, canonicalEvidenceItemKeys)) return false;
			if (!isNonEmptyString(item.summary) || !["command", "inspection", "artifact"].includes(String(item.kind)))
				return false;
			if (
				(item.kind === "command" && !["passed", "failed", "not_run"].includes(String(item.status))) ||
				(item.kind !== "command" && !["verified", "rejected"].includes(String(item.status)))
			)
				return false;
			if (item.command !== undefined && !isNonEmptyString(item.command)) return false;
			if (item.artifact !== undefined && !isNonEmptyString(item.artifact)) return false;
			if (item.location !== undefined && !isNonEmptyString(item.location)) return false;
			if (item.output !== undefined && typeof item.output !== "string") return false;
			return item.kind !== "command" || isNonEmptyString(item.command);
		})
	)
		return false;
	if (
		value.files !== undefined &&
		(!Array.isArray(value.files) || !value.files.every(file => typeof file === "string" && file.trim().length > 0))
	)
		return false;
	return value.notes === undefined || typeof value.notes === "string";
}

export function isCanonicalPersistedGjcTeamTask(value: unknown, fileId?: string): value is GjcTeamTask {
	if (!isRecord(value) || Array.isArray(value) || !hasExactKeys(value, canonicalTaskKeys)) return false;
	if (!isSafePersistedId(value.id) || (fileId !== undefined && value.id !== fileId)) return false;
	if (!["pending", "blocked", "in_progress", "completed", "failed"].includes(String(value.status))) return false;
	if (!["subject", "description", "title", "objective"].every(key => typeof value[key] === "string")) return false;
	if (!Number.isInteger(value.version) || (value.version as number) <= 0) return false;
	if (!isFiniteTimestamp(value.created_at) || !isFiniteTimestamp(value.updated_at)) return false;
	if (value.completed_at !== undefined && !isFiniteTimestamp(value.completed_at)) return false;
	if (value.owner !== undefined && !isSafePersistedId(value.owner)) return false;
	if (value.assignee !== undefined && !isSafePersistedId(value.assignee)) return false;
	if (value.result !== undefined && typeof value.result !== "string") return false;
	if (value.error !== undefined && typeof value.error !== "string") return false;
	if (value.lane !== undefined && !isNonEmptyString(value.lane)) return false;
	if (value.required_role !== undefined && !isNonEmptyString(value.required_role)) return false;
	if (
		value.allowed_roles !== undefined &&
		(!Array.isArray(value.allowed_roles) || !value.allowed_roles.every(isNonEmptyString))
	)
		return false;
	if (
		value.depends_on !== undefined &&
		(!Array.isArray(value.depends_on) || !value.depends_on.every(isSafePersistedId))
	)
		return false;
	if (
		value.blocked_by !== undefined &&
		(!Array.isArray(value.blocked_by) || !value.blocked_by.every(isSafePersistedId))
	)
		return false;
	if (value.completion_evidence !== undefined && !isCanonicalCompletionEvidence(value.completion_evidence))
		return false;
	if (value.claim !== undefined) {
		if (!isCanonicalPersistedGjcTeamTaskClaim(value.claim)) return false;
		if (value.status !== "in_progress" || value.owner !== value.claim.owner || value.assignee !== value.claim.owner)
			return false;
	}
	return true;
}
const safeId = (kind: string, value: string) => {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) ||
		value.includes("..") ||
		value.includes("/") ||
		value.includes("\\")
	)
		throw new Error(`invalid_${kind}:${value}`);
	return value;
};
const taskPath = (dir: string, id: string) => path.join(dir, "tasks", `${safeId("task_id", id)}.json`);
const claimPath = (dir: string, id: string) => path.join(dir, "claims", `${safeId("task_id", id)}.json`);
const writerOptions = (filePath: string, category: "state" | "prune", verb: string) => {
	const resolved = path.resolve(filePath);
	const marker = `${path.sep}.gjc${path.sep}`;
	const markerIndex = resolved.indexOf(marker);
	const cwd = markerIndex >= 0 ? resolved.slice(0, markerIndex) : process.cwd();
	const sessionId =
		resolved
			.split(path.sep)
			.map(segment => sessionIdFromDirName(segment))
			.find((value): value is string => Boolean(value)) ?? process.env.GJC_SESSION_ID?.trim();
	return sessionId
		? {
				cwd,
				audit: { category, verb, owner: "gjc-runtime" as const, sessionId },
			}
		: { cwd };
};
async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}
async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeJsonAtomic(filePath, value, writerOptions(filePath, "state", "write"));
}

/**
 * Serializes mutable team facts across processes. Callers must not re-enter this
 * fence; use unlocked helpers when composing operations under one transaction.
 */
export async function withGjcTeamMutationFence<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	return withWorkflowStateLock(
		path.join(dir, "operations", "team-mutation.json"),
		fn,
		writerOptions(path.join(dir, "operations", "team-mutation.json"), "state", "mutation-fence"),
	);
}
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = [...new Set(value.map(optionalString).filter((value): value is string => Boolean(value)))].sort();
	return values.length ? values : undefined;
}
export function taskMetadataFromInput(input: Record<string, unknown>, includeOwner = false): GjcTeamTaskMetadataInput {
	const result: GjcTeamTaskMetadataInput = {};
	const owner = optionalString(input.owner);
	if (includeOwner && owner) result.owner = owner;
	for (const [key, value] of [
		["lane", optionalString(input.lane)],
		["required_role", optionalString(input.required_role ?? input.requiredRole)],
		["allowed_roles", optionalStringArray(input.allowed_roles ?? input.allowedRoles)],
		["depends_on", optionalStringArray(input.depends_on ?? input.dependsOn)],
		["blocked_by", optionalStringArray(input.blocked_by ?? input.blockedBy)],
	] as const)
		if (value) Object.assign(result, { [key]: value });
	return result;
}
export function normalizeGjcTeamTask(raw: GjcTeamTask): GjcTeamTask {
	return {
		...raw,
		status: raw.status === ("complete" as GjcTeamTaskStatus) ? "completed" : raw.status,
		subject: raw.subject ?? raw.title,
		description: raw.description ?? raw.objective,
		title: raw.title ?? raw.subject,
		objective: raw.objective ?? raw.description,
		version: raw.version ?? 1,
		lane: optionalString(raw.lane),
		required_role: optionalString(raw.required_role),
		allowed_roles: optionalStringArray(raw.allowed_roles),
	};
}
function evidenceError(id: string, field: string) {
	return new Error(`invalid_completion_evidence:${id}:${field}`);
}
function required(id: string, field: string, value: unknown, max = 4000): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw evidenceError(id, field);
	return value.trim();
}
function optional(id: string, field: string, value: unknown, max = 8000): string | undefined {
	if (value == null) return undefined;
	if (typeof value !== "string" || value.trim().length > max) throw evidenceError(id, field);
	return value.trim() || undefined;
}
function verified(item: GjcTeamTaskCompletionEvidenceItem) {
	return (
		(item.kind === "command" && item.status === "passed") || (item.kind !== "command" && item.status === "verified")
	);
}
export function normalizeGjcTeamTaskCompletionEvidence(
	id: string,
	owner: string,
	input: unknown,
	recordedAt = now(),
): GjcTeamTaskCompletionEvidence {
	if (!isRecord(input) || Array.isArray(input)) throw new Error(`completion_evidence_required:${id}`);
	if (!Array.isArray(input.items) || !input.items.length) throw evidenceError(id, "items");
	const items = input.items.map(value => {
		if (!isRecord(value) || Array.isArray(value)) throw evidenceError(id, "items");
		const kind = required(id, "items.kind", value.kind);
		if (kind !== "command" && kind !== "inspection" && kind !== "artifact") throw evidenceError(id, "items.kind");
		const status = required(id, "items.status", value.status) as GjcTeamTaskCompletionEvidenceStatus;
		if (
			(kind === "command" && !["passed", "failed", "not_run"].includes(status)) ||
			(kind !== "command" && !["verified", "rejected"].includes(status))
		)
			throw evidenceError(id, "items.status");
		const item: GjcTeamTaskCompletionEvidenceItem = {
			kind,
			status,
			summary: required(id, "items.summary", value.summary),
		};
		for (const [key, entry] of [
			["command", optional(id, "items.command", value.command)],
			["artifact", optional(id, "items.artifact", value.artifact)],
			["location", optional(id, "items.location", value.location)],
			["output", optional(id, "items.output", value.output)],
		] as const)
			if (entry) Object.assign(item, { [key]: entry });
		if (kind === "command" && !item.command) throw evidenceError(id, "items.command");
		return item;
	});
	if (!items.some(verified)) throw new Error(`completion_evidence_no_verified_item:${id}`);
	let files: string[] | undefined;
	if (input.files != null) {
		if (!Array.isArray(input.files)) throw evidenceError(id, "files");
		files = [
			...new Set(
				input.files.map(file => {
					if (typeof file !== "string") throw evidenceError(id, "files");
					const normalized = file.trim().replace(/\\/g, "/");
					if (
						!normalized ||
						normalized.includes("\0") ||
						path.isAbsolute(normalized) ||
						normalized.split("/").includes("..")
					)
						throw evidenceError(id, "files");
					return normalized;
				}),
			),
		].sort();
		if (!files.length) files = undefined;
	}
	const evidence: GjcTeamTaskCompletionEvidence = {
		summary: required(id, "summary", input.summary),
		items,
		recorded_by: owner,
		recorded_at: recordedAt,
	};
	if (files) evidence.files = files;
	const notes = optional(id, "notes", input.notes);
	if (notes) evidence.notes = notes;
	return evidence;
}
export function getGjcTeamTaskCompletionEvidenceFailure(task: GjcTeamTask): string | null {
	if (task.status !== "completed") return `task_not_completed:${task.id}`;
	const evidence = task.completion_evidence;
	if (!isRecord(evidence) || Array.isArray(evidence)) return `completion_evidence_required:${task.id}`;
	if (typeof evidence.recorded_by !== "string" || !evidence.recorded_by.trim())
		return `invalid_completion_evidence:${task.id}:recorded_by`;
	if (typeof evidence.recorded_at !== "string" || !evidence.recorded_at.trim())
		return `invalid_completion_evidence:${task.id}:recorded_at`;
	try {
		normalizeGjcTeamTaskCompletionEvidence(task.id, evidence.recorded_by.trim(), evidence, evidence.recorded_at);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : `invalid_completion_evidence:${task.id}:unknown`;
	}
}
export const isGjcTeamTaskCompletionVerified = (task: GjcTeamTask) =>
	getGjcTeamTaskCompletionEvidenceFailure(task) === null;
function taskRecord(value: unknown): value is GjcTeamTask {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.status === "string" &&
		["pending", "blocked", "in_progress", "completed", "failed", "complete"].includes(value.status) &&
		(typeof value.subject === "string" || typeof value.title === "string") &&
		(typeof value.description === "string" || typeof value.objective === "string")
	);
}
export async function readGjcTeamTasksFromDir(dir: string): Promise<GjcTeamTask[]> {
	try {
		const entries = await fs.readdir(path.join(dir, "tasks"), {
			withFileTypes: true,
		});
		const records = await Promise.all(
			entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".evidence.json"))
				.map(entry => readJson<unknown>(path.join(dir, "tasks", entry.name))),
		);
		return records
			.filter(taskRecord)
			.map(normalizeGjcTeamTask)
			.sort((a, b) => a.id.localeCompare(b.id));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
async function writeGjcTeamTaskToDir(dir: string, task: GjcTeamTask): Promise<void> {
	await writeJson(taskPath(dir, task.id), normalizeGjcTeamTask(task));
}

function eligibility(task: GjcTeamTask, worker: GjcTeamTaskWorker, tasks: GjcTeamTask[]): string | null {
	if (task.status !== "pending") return `task_not_pending:${task.id}`;
	if (task.owner && task.owner !== worker.id) return `task_owner_mismatch:${task.id}:${task.owner}`;
	if (task.assignee && task.assignee !== worker.id) return `task_assignee_mismatch:${task.id}:${task.assignee}`;
	const roles = new Set([worker.role, worker.agent_type].map(value => value.trim()).filter(Boolean));
	if (task.required_role && !roles.has(task.required_role))
		return `task_role_mismatch:${task.id}:${task.required_role}`;
	if (task.allowed_roles?.length && !task.allowed_roles.some(role => roles.has(role)))
		return `task_role_mismatch:${task.id}:${task.allowed_roles.join(",")}`;
	if (task.blocked_by?.length) return `task_blocked:${task.id}:${task.blocked_by.join(",")}`;
	for (const dependency of task.depends_on ?? [])
		if (!tasks.find(candidate => candidate.id === dependency && isGjcTeamTaskCompletionVerified(candidate)))
			return `task_dependency_incomplete:${task.id}:${dependency}`;
	return null;
}
function claimRecord(value: unknown): GjcTeamTaskClaim | undefined {
	if (
		!isRecord(value) ||
		typeof value.owner !== "string" ||
		typeof value.token !== "string" ||
		typeof value.leased_until !== "string" ||
		!value.owner ||
		!value.token ||
		!value.leased_until
	)
		return undefined;
	return {
		owner: value.owner,
		token: value.token,
		leased_until: value.leased_until,
	};
}
const expired = (value: string | undefined) =>
	Boolean(value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now());

const teamTaskMutationCapability = Symbol("team-task-mutation-capability");

/**
 * This is intentionally structural only: callers can invoke methods supplied by
 * `withGjcTeamTaskMutation`, but cannot create an active capability. Each method
 * closes over a private brand and is revoked when that callback settles.
 */
export interface GjcTeamTaskMutationCapability {
	create(subject: string, description: string, options: GjcTeamTaskMetadataInput): Promise<GjcTeamTask>;
	update(
		id: string,
		updates: Partial<
			Pick<
				GjcTeamTask,
				"subject" | "description" | "blocked_by" | "depends_on" | "lane" | "required_role" | "allowed_roles"
			>
		>,
	): Promise<GjcTeamTask>;
	claim(worker: GjcTeamTaskWorker, id?: string): Promise<GjcTeamApiClaimResult>;
	transition(
		id: string,
		status: GjcTeamTaskStatus,
		token?: string,
		workerId?: string,
		evidenceInput?: unknown,
	): Promise<GjcTeamTask>;
	release(id: string, token: string, workerId: string): Promise<GjcTeamTask>;
	writeRecovered(task: GjcTeamTask): Promise<void>;
}

export async function withGjcTeamTaskMutation<T>(
	store: GjcTeamTaskStore,
	fn: (capability: GjcTeamTaskMutationCapability) => Promise<T>,
): Promise<T> {
	return withGjcTeamMutationFence(store.dir, () => store.withMutationCapability(teamTaskMutationCapability, fn));
}

export class GjcTeamTaskStore {
	constructor(
		readonly dir: string,
		readonly appendEvent: EventAppender,
	) {}
	async withMutationCapability<T>(
		capabilityBrand: typeof teamTaskMutationCapability,
		fn: (capability: GjcTeamTaskMutationCapability) => Promise<T>,
	): Promise<T> {
		if (capabilityBrand !== teamTaskMutationCapability) throw new Error("team_mutation_capability_required");
		const brand = Symbol("active-team-task-mutation");
		let active = true;
		const mutations: Promise<unknown>[] = [];
		const assertActive = () => {
			if (!active || brand.description !== "active-team-task-mutation")
				throw new Error("team_mutation_capability_revoked");
		};
		const track = <T>(mutation: () => Promise<T>): Promise<T> => {
			assertActive();
			const pending = mutation();
			mutations.push(pending);
			void pending.catch(() => undefined);
			return pending;
		};
		const capability = Object.freeze<GjcTeamTaskMutationCapability>({
			create: (subject, description, options) => track(() => this.#createUnlocked(subject, description, options)),
			update: (id, updates) => track(() => this.#updateUnlocked(id, updates)),
			claim: (worker, id) => track(() => this.#claimUnlocked(worker, id)),
			transition: (id, status, token, workerId, evidenceInput) =>
				track(() => this.#transitionUnlocked(id, status, token, workerId, evidenceInput)),
			release: (id, token, workerId) => track(() => this.#releaseUnlocked(id, token, workerId)),
			writeRecovered: task => track(() => writeGjcTeamTaskToDir(this.dir, task)),
		});
		let callbackResult: T | undefined;
		let callbackError: unknown;
		let callbackFailed = false;
		try {
			callbackResult = await fn(capability);
		} catch (error) {
			callbackFailed = true;
			callbackError = error;
		}
		// Callback settlement is the admission boundary. Drain only mutations that
		// were admitted before it; an escaped capability cannot add work while draining.
		active = false;
		const settled: PromiseSettledResult<unknown>[] = [];
		let drained = 0;
		while (drained < mutations.length) {
			const pending = mutations.slice(drained);
			drained = mutations.length;
			settled.push(...(await Promise.allSettled(pending)));
		}
		if (callbackFailed) throw callbackError;
		const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failed) throw failed.reason;
		return callbackResult as T;
	}
	async list() {
		return readGjcTeamTasksFromDir(this.dir);
	}
	async read(id: string) {
		const task = (await this.list()).find(candidate => candidate.id === id);
		if (!task) throw new Error(`task_not_found:${id}`);
		return task;
	}
	async create(subject: string, description: string, options: GjcTeamTaskMetadataInput) {
		return withGjcTeamMutationFence(this.dir, () => this.#createUnlocked(subject, description, options));
	}
	async #createUnlocked(subject: string, description: string, options: GjcTeamTaskMetadataInput) {
		const task: GjcTeamTask = {
			id: `task-${(await this.list()).length + 1}`,
			subject,
			description,
			title: subject,
			objective: description,
			status: "pending",
			...options,
			version: 1,
			created_at: now(),
			updated_at: now(),
		};
		await writeGjcTeamTaskToDir(this.dir, task);
		await this.appendEvent({
			type: "task_created",
			task_id: task.id,
			message: subject,
		});
		return task;
	}
	async update(
		id: string,
		updates: Partial<
			Pick<
				GjcTeamTask,
				"subject" | "description" | "blocked_by" | "depends_on" | "lane" | "required_role" | "allowed_roles"
			>
		>,
	) {
		return withGjcTeamMutationFence(this.dir, () => this.#updateUnlocked(id, updates));
	}
	async #updateUnlocked(
		id: string,
		updates: Partial<
			Pick<
				GjcTeamTask,
				"subject" | "description" | "blocked_by" | "depends_on" | "lane" | "required_role" | "allowed_roles"
			>
		>,
	) {
		const task = await this.read(id);
		const updated = normalizeGjcTeamTask({
			...task,
			...updates,
			title: updates.subject ?? task.title,
			objective: updates.description ?? task.objective,
			version: task.version + 1,
			updated_at: now(),
		});
		await writeGjcTeamTaskToDir(this.dir, updated);
		await this.appendEvent({
			type: "task_updated",
			task_id: id,
			message: updated.subject,
		});
		return updated;
	}
	async claim(worker: GjcTeamTaskWorker, id?: string): Promise<GjcTeamApiClaimResult> {
		return withGjcTeamMutationFence(this.dir, () => this.#claimUnlocked(worker, id));
	}
	async #claimUnlocked(worker: GjcTeamTaskWorker, id?: string): Promise<GjcTeamApiClaimResult> {
		const tasks = await this.list();
		const task = id
			? tasks.find(candidate => candidate.id === id)
			: tasks.find(candidate => eligibility(candidate, worker, tasks) === null);
		if (!task)
			return {
				ok: false,
				reason: id ? `task_not_found:${id}` : "no_pending_task",
			};
		const reason = eligibility(task, worker, tasks);
		if (reason) return { ok: false, reason };
		const existing = task.claim ?? claimRecord(await readJson<unknown>(claimPath(this.dir, task.id)));
		if (existing && !expired(existing.leased_until)) return { ok: false, reason: `task_already_claimed:${task.id}` };
		const claim: GjcTeamTaskClaim = {
			owner: worker.id,
			token: randomUUID(),
			leased_until: new Date(Date.now() + 30 * 60_000).toISOString(),
		};
		try {
			await createJsonNoClobber(
				claimPath(this.dir, task.id),
				claim,
				writerOptions(claimPath(this.dir, task.id), "state", "claim"),
			);
		} catch (error) {
			if (isRecord(error) && error.code === "EEXIST")
				return { ok: false, reason: `task_already_claimed:${task.id}` };
			throw error;
		}
		const current = await this.read(task.id);
		const currentReason = eligibility(current, worker, await this.list());
		if (currentReason || current.status !== "pending") {
			await deleteIfOwned(claimPath(this.dir, task.id), {
				...writerOptions(claimPath(this.dir, task.id), "prune", "rollback"),
				predicate: current => (current as GjcTeamTaskClaim).token === claim.token,
			});
			return {
				ok: false,
				reason: currentReason ?? `task_not_pending:${task.id}`,
			};
		}
		const updated = {
			...current,
			status: "in_progress" as const,
			assignee: worker.id,
			owner: worker.id,
			claim,
			version: current.version + 1,
			updated_at: now(),
		};
		try {
			await writeGjcTeamTaskToDir(this.dir, updated);
		} catch (error) {
			await deleteIfOwned(claimPath(this.dir, task.id), {
				...writerOptions(claimPath(this.dir, task.id), "prune", "rollback"),
				predicate: current => (current as GjcTeamTaskClaim).token === claim.token,
			});
			throw error;
		}
		await this.appendEvent({
			type: "task_claimed",
			task_id: updated.id,
			worker: worker.id,
			message: "Worker claimed task",
		});
		return {
			ok: true,
			task: updated,
			worker_id: worker.id,
			claim_token: claim.token,
		};
	}
	async transition(id: string, status: GjcTeamTaskStatus, token?: string, workerId?: string, evidenceInput?: unknown) {
		return withGjcTeamMutationFence(this.dir, () =>
			this.#transitionUnlocked(id, status, token, workerId, evidenceInput),
		);
	}
	async #transitionUnlocked(
		id: string,
		status: GjcTeamTaskStatus,
		token?: string,
		workerId?: string,
		evidenceInput?: unknown,
	) {
		const task = await this.read(id);
		if (status === "pending") throw new Error(`invalid_task_transition:${id}:pending_requires_release`);
		if (task.status === "completed" || task.status === "failed") throw new Error(`task_terminal:${id}`);
		if (!task.claim || !token) throw new Error(`claim_token_required:${id}`);
		if (task.claim.token !== token) throw new Error(`claim_token_mismatch:${id}`);
		if (workerId && task.claim.owner !== workerId) throw new Error(`claim_owner_mismatch:${id}`);
		const terminal = status === "completed" || status === "failed";
		const transitionedAt = now();
		const evidence =
			status === "completed"
				? normalizeGjcTeamTaskCompletionEvidence(id, task.claim.owner, evidenceInput, transitionedAt)
				: undefined;
		const updated: GjcTeamTask = {
			...task,
			status,
			claim: terminal ? undefined : task.claim,
			version: task.version + 1,
			updated_at: transitionedAt,
			...(terminal ? { completed_at: transitionedAt } : {}),
			...(evidence ? { completion_evidence: evidence } : {}),
		};
		await writeGjcTeamTaskToDir(this.dir, updated);
		if (terminal)
			await removeFileAudited(claimPath(this.dir, id), writerOptions(claimPath(this.dir, id), "prune", "terminal"));
		const data: Record<string, unknown> = { status };
		if (evidence)
			data.completion_evidence = {
				recorded_by: evidence.recorded_by,
				item_count: evidence.items.length,
				verified_item_count: evidence.items.filter(verified).length,
				files_count: evidence.files?.length ?? 0,
			};
		await this.appendEvent({
			type: "task_transitioned",
			task_id: id,
			message: "Task status changed",
			data,
		});
		return updated;
	}
	async release(id: string, token: string, workerId: string) {
		return withGjcTeamMutationFence(this.dir, () => this.#releaseUnlocked(id, token, workerId));
	}
	async #releaseUnlocked(id: string, token: string, workerId: string) {
		const task = await this.read(id);
		if (!task.claim || task.claim.token !== token || task.claim.owner !== workerId)
			throw new Error(`claim_token_mismatch:${id}`);
		const updated: GjcTeamTask = {
			...task,
			status: "pending",
			assignee: undefined,
			claim: undefined,
			version: task.version + 1,
			updated_at: now(),
		};
		await writeGjcTeamTaskToDir(this.dir, updated);
		await deleteIfOwned(claimPath(this.dir, id), {
			...writerOptions(claimPath(this.dir, id), "prune", "release"),
			predicate: current => (current as GjcTeamTaskClaim).token === token,
		});
		await this.appendEvent({
			type: "task_claim_released",
			task_id: id,
			worker: workerId,
			message: "Task claim released",
		});
		return updated;
	}
}
