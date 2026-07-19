import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const WorkType = {
	hotfix: "hotfix",
	fix: "fix",
	dev: "dev",
	refactor: "refactor",
	perf: "perf",
	test: "test",
	docs: "docs",
	chore: "chore",
	release: "release",
	spike: "spike",
} as const;

export type WorkType = (typeof WorkType)[keyof typeof WorkType];
export const LifecycleStates = [
	"planned",
	"active",
	"pushed",
	"pr_open",
	"verifying",
	"eligible",
	"merge_requested",
	"merged",
	"retention",
	"gc_eligible",
	"cleaned",
	"blocked",
	"stale",
	"conflicted",
	"closed_unmerged",
	"quarantined",
	"cleanup_blocked",
] as const;
export type LifecycleState = (typeof LifecycleStates)[number];
export type ExecutionRealm = "windows" | "wsl";

export interface LaneName {
	branch: string;
	worktreeToken: string;
	scope: string;
	purpose: string;
}

export interface LaneNameInput {
	type: WorkType;
	scope: string;
	purpose: string;
	agent: string;
	id: string;
	existingBranches?: readonly string[];
	existingWorktreeTokens?: readonly string[];
}

export interface LaneOwnership {
	repositoryId: string;
	realm: ExecutionRealm;
	branch: string;
	worktreeToken: string;
	worktreePath: string;
	agent: string;
	sessionId: string;
}

export interface CleanupEvidence {
	mergeCommit?: string;
	retentionApprovedAt?: string;
	explicitCleanupRequestedAt?: string;
	gcApprovedAt?: string;
	remoteDeleteIntent?: { headSha: string; at: string };
	remoteBranchDeletedAt?: string;
	worktreeRemoveIntent?: { path: string; at: string };
	worktreeRemovedAt?: string;
	localRefDeleteIntent?: { ref: string; headSha: string; at: string };
	localRefDeletedAt?: string;
	cleanupBlockedAt?: string;
	cleanupBlockedReason?: string;
}

export interface LaneRecord extends LaneOwnership {
	version: 1;
	laneId: string;
	state: LifecycleState;
	createdAt: string;
	updatedAt: string;
	cleanupEvidence?: CleanupEvidence;
	gitCommonDir?: string;
	remote?: string;
	base?: string;
	baseSha?: string;
	headSha?: string;
	worktreeGitDir?: string;
	worktreeOwnershipToken?: string;
	leaseOwner?: string;
	leaseExpiresAt?: string;
	leaseUpdatedAt?: string;
}

export interface LifecycleEvent {
	version: 1;
	laneId: string;
	at: string;
	type: string;
	state: LifecycleState;
	details?: Record<string, string | number | boolean | null>;
}

export class LifecycleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LifecycleError";
	}
}

const WINDOWS_RESERVED = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	"clock$",
	...Array.from({ length: 10 }, (_, index) => `com${index + 1}`),
	...Array.from({ length: 10 }, (_, index) => `lpt${index + 1}`),
]);
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BRANCH_LENGTH = 240;
const MAX_WORKTREE_TOKEN_LENGTH = 120;

function normalizePart(value: string, label: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	if (!SAFE_ID.test(normalized) || normalized.includes("--")) {
		throw new LifecycleError(`${label} must be lowercase alphanumeric words separated by single hyphens`);
	}
	if (normalized.split("-").some(part => WINDOWS_RESERVED.has(part))) {
		throw new LifecycleError(`${label} contains a Windows reserved filename`);
	}
	return normalized;
}

export function parseNormalizedPurpose(value: string): string {
	return normalizePart(value, "purpose");
}

function isWorkType(value: string): value is WorkType {
	return Object.values(WorkType).includes(value as WorkType);
}

function collides(value: string, existing: readonly string[] | undefined): boolean {
	return (
		existing?.some(candidate => candidate.toLocaleLowerCase("en-US") === value.toLocaleLowerCase("en-US")) ?? false
	);
}

export function createLaneName(input: LaneNameInput): LaneName {
	if (!isWorkType(input.type)) throw new LifecycleError("work type is not supported");
	const scope = normalizePart(input.scope, "scope");
	const purpose = parseNormalizedPurpose(input.purpose);
	const agent = normalizePart(input.agent, "agent");
	const id = normalizePart(input.id, "id");
	const scopePurpose = `${scope}-${purpose}`;
	const branch = `${input.type}/${scopePurpose}--${agent}-${id}`;
	const worktreeToken = `${input.type.toUpperCase()})${scopePurpose}__${agent}-${id}`;
	if (branch.length > MAX_BRANCH_LENGTH) throw new LifecycleError("branch name exceeds the supported length");
	if (worktreeToken.length > MAX_WORKTREE_TOKEN_LENGTH)
		throw new LifecycleError("worktree token exceeds the supported Windows length");
	if (collides(branch, input.existingBranches))
		throw new LifecycleError("branch collides case-insensitively with an existing branch");
	if (collides(worktreeToken, input.existingWorktreeTokens))
		throw new LifecycleError("worktree token collides case-insensitively with an existing worktree");
	return { branch, worktreeToken, scope, purpose };
}

function lifecycleRoot(gitCommonDir: string): string {
	return path.join(gitCommonDir, "gjc", "lifecycle", "v1");
}

function validateLaneId(laneId: string): string {
	return normalizePart(laneId, "lane id");
}

function recordPath(gitCommonDir: string, laneId: string): string {
	return path.join(lifecycleRoot(gitCommonDir), "records", `${validateLaneId(laneId)}.json`);
}

export async function writeLaneRecord(gitCommonDir: string, record: LaneRecord): Promise<void> {
	const destination = recordPath(gitCommonDir, record.laneId);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
		await fs.rename(temporary, destination);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export async function readLaneRecord(gitCommonDir: string, laneId: string): Promise<LaneRecord | undefined> {
	const normalizedLaneId = validateLaneId(laneId);
	try {
		const destination = recordPath(gitCommonDir, normalizedLaneId);
		const parsed: unknown = JSON.parse(await fs.readFile(destination, "utf8"));
		if (
			!isLaneRecord(parsed) ||
			parsed.laneId !== normalizedLaneId ||
			path.basename(destination) !== `${parsed.laneId}.json`
		)
			throw new LifecycleError("lane record has an invalid shape or identity");
		return parsed;
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw error;
	}
}
export async function listLaneRecords(gitCommonDir: string): Promise<LaneRecord[]> {
	const recordsDir = path.join(lifecycleRoot(gitCommonDir), "records");
	let entries: Dirent[];
	try {
		entries = await fs.readdir(recordsDir, { withFileTypes: true });
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) return [];
		throw error;
	}
	const records: LaneRecord[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(await fs.readFile(path.join(recordsDir, entry.name), "utf8"));
		} catch {
			throw new LifecycleError(`lane record is unreadable: ${entry.name}`);
		}
		try {
			validateLaneId(parsed && typeof parsed === "object" && "laneId" in parsed ? String(parsed.laneId) : "");
		} catch {
			throw new LifecycleError(`lane record has an invalid shape: ${entry.name}`);
		}
		if (!isLaneRecord(parsed) || entry.name !== `${parsed.laneId}.json`)
			throw new LifecycleError(`lane record has an invalid shape: ${entry.name}`);
		records.push(parsed);
	}
	return records;
}

export async function findLaneRecordByWorktreePath(
	gitCommonDir: string,
	worktreePath: string,
): Promise<LaneRecord | undefined> {
	const normalizedPath = path.resolve(worktreePath);
	const matches = (await listLaneRecords(gitCommonDir)).filter(
		record => path.resolve(record.worktreePath) === normalizedPath,
	);
	if (matches.length > 1) throw new LifecycleError(`multiple lane records match worktree path: ${normalizedPath}`);
	return matches[0];
}

export async function appendLifecycleEvent(gitCommonDir: string, event: LifecycleEvent): Promise<void> {
	validateLaneId(event.laneId);
	const eventsPath = path.join(lifecycleRoot(gitCommonDir), "events.jsonl");
	await fs.mkdir(path.dirname(eventsPath), { recursive: true });
	await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export interface LifecycleLock {
	readonly laneId: string;
	release(): Promise<void>;
}

export async function acquireLifecycleLock(gitCommonDir: string, laneId: string): Promise<LifecycleLock> {
	const normalizedLaneId = validateLaneId(laneId);
	const lockPath = path.join(lifecycleRoot(gitCommonDir), "locks", `${normalizedLaneId}.lock`);
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(lockPath, "wx");
	} catch (error: unknown) {
		if (isNodeError(error, "EEXIST")) throw new LifecycleError(`lane lock is already held: ${normalizedLaneId}`);
		throw error;
	}
	let released = false;
	return {
		laneId: normalizedLaneId,
		async release(): Promise<void> {
			if (released) return;
			released = true;
			await handle.close();
			await fs.rm(lockPath, { force: true });
		},
	};
}

export function ownershipMatches(record: LaneRecord, ownership: LaneOwnership): boolean {
	return (
		record.repositoryId === ownership.repositoryId &&
		record.realm === ownership.realm &&
		record.branch === ownership.branch &&
		record.worktreeToken === ownership.worktreeToken &&
		record.worktreePath === ownership.worktreePath &&
		record.agent === ownership.agent &&
		record.sessionId === ownership.sessionId
	);
}

export function isCleanupEligible(record: LaneRecord, ownership: LaneOwnership): boolean {
	const evidence = record.cleanupEvidence;
	return (
		record.state === "gc_eligible" &&
		ownershipMatches(record, ownership) &&
		record.realm === "windows" &&
		typeof evidence?.mergeCommit === "string" &&
		evidence.mergeCommit.length > 0 &&
		typeof evidence.retentionApprovedAt === "string" &&
		typeof evidence.explicitCleanupRequestedAt === "string" &&
		typeof evidence.gcApprovedAt === "string"
	);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code
	);
}

function isLaneRecord(value: unknown): value is LaneRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<LaneRecord>;
	const nonEmpty = (field: unknown): field is string => typeof field === "string" && field.length > 0;
	try {
		if (!nonEmpty(record.laneId) || validateLaneId(record.laneId) !== record.laneId) return false;
	} catch {
		return false;
	}
	return (
		record.version === 1 &&
		typeof record.state === "string" &&
		LifecycleStates.includes(record.state as LifecycleState) &&
		nonEmpty(record.repositoryId) &&
		(record.realm === "windows" || record.realm === "wsl") &&
		nonEmpty(record.branch) &&
		nonEmpty(record.worktreeToken) &&
		nonEmpty(record.worktreePath) &&
		(record.gitCommonDir === undefined || nonEmpty(record.gitCommonDir)) &&
		(record.remote === undefined || nonEmpty(record.remote)) &&
		(record.base === undefined || nonEmpty(record.base)) &&
		(record.baseSha === undefined || nonEmpty(record.baseSha)) &&
		(record.headSha === undefined || nonEmpty(record.headSha)) &&
		(record.leaseOwner === undefined || nonEmpty(record.leaseOwner)) &&
		(record.worktreeGitDir === undefined || nonEmpty(record.worktreeGitDir)) &&
		(record.worktreeOwnershipToken === undefined || nonEmpty(record.worktreeOwnershipToken)) &&
		(record.leaseExpiresAt === undefined ||
			(typeof record.leaseExpiresAt === "string" && Number.isFinite(Date.parse(record.leaseExpiresAt)))) &&
		(record.leaseUpdatedAt === undefined ||
			(typeof record.leaseUpdatedAt === "string" && Number.isFinite(Date.parse(record.leaseUpdatedAt)))) &&
		((record.leaseOwner === undefined &&
			record.leaseExpiresAt === undefined &&
			record.leaseUpdatedAt === undefined) ||
			(nonEmpty(record.leaseOwner) &&
				typeof record.leaseExpiresAt === "string" &&
				typeof record.leaseUpdatedAt === "string")) &&
		nonEmpty(record.agent) &&
		nonEmpty(record.sessionId) &&
		nonEmpty(record.createdAt) &&
		nonEmpty(record.updatedAt)
	);
}
