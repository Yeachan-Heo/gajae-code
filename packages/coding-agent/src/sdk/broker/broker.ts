import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import type { ModelProfileErrorDetails } from "../../config/model-profile-contract";
import { SdkClient, SdkClientError } from "../client";
import { elevationAuthorityPath, signElevationCapability } from "../elevation/capability";
import { type ElevationOperation, elevationRequestDigest, isElevatableOperation } from "../elevation/digest";
import {
	type ElevationAnswerAuthority,
	type ElevationClaimIdentity,
	type ElevationDispatchOutcome,
	isElevationRequestId,
} from "../elevation/dispatch-receipt";
import {
	type ElevationAnswerValue,
	type ElevationGrantRecord,
	ElevationLedger,
	type ElevationRequester,
	type ElevationResult,
	type ElevationSessionIdentity,
} from "../elevation/grant-ledger";
import { type BrokerOwnerPrincipal, readBrokerOwnerPrincipal } from "../elevation/owner";
import { findOperation } from "../protocol/operation-registry";
import {
	type DirectoryMigrationPolicy,
	listManagedSessionCandidates,
	resolveManagedSessionScope,
} from "../session-directory";
import {
	BROKER_HEARTBEAT_TTL_MS,
	type BrokerDiscovery,
	type BrokerPublicationObservation,
	brokerDiscoveryPath,
	brokerProcessIncarnation,
	heartbeatBrokerDiscoveryRetained,
	isPidAlive,
	newBrokerToken,
	publishBrokerDiscovery,
	type RedactedBrokerDiscovery,
	type RetainedBrokerDiscovery,
	readBrokerDiscovery,
	redactBrokerDiscovery,
} from "./discovery";
import { deriveIdempotencyIdentity } from "./identity";
import { canonicalDeleteLocatorPath, executeLifecycle, isCanonicalSessionId } from "./lifecycle";
import {
	type LifecycleDurableEffectsReceipt,
	LifecycleLedger,
	type LifecycleStartupFailureReceipt,
	type LifecycleState,
} from "./lifecycle-ledger";
import { OperationReceiptLedger, operationReceiptDigest, operationReceiptKey } from "./operation-receipt-ledger";
import { type IndexedSession, SessionIndex, type SessionList } from "./session-index";
import { BrokerTransport } from "./transport";

export interface BrokerSettings {
	agentDir: string;
	packageGeneration?: string;
	port?: number;
	heartbeatTtlMs?: number;
	/** Broker-owned migration policy. Client lifecycle frames cannot select it. */
	resolveDirectoryMigration?: (_cwd: string) => Promise<DirectoryMigrationPolicy>;
}

type ResolvedBrokerSettings = {
	agentDir: string;
	packageGeneration: string;
	port: number;
	heartbeatTtlMs: number;
	resolveDirectoryMigration: (_cwd: string) => Promise<DirectoryMigrationPolicy>;
};

export type BrokerErrorCode =
	| "idempotency_conflict"
	| "terminal_uncertain"
	| "broker_restarting"
	| "unavailable"
	| "endpoint_stale"
	| "resource_gone"
	| "invalid_input"
	| "spawn_failed"
	| "startup_admission_timeout"
	| "startup_admission_refused"
	| "readiness_timeout"
	| "close_refused"
	| "not_found"
	| "live_session"
	| "cleanup_pending"
	| "ambiguous_session"
	| (string & {});

export type BrokerCleanupIdentity = {
	dev: string;
	ino: string;
	nlink?: string;
	size: number;
	mtimeNs: string;
	sha256: string;
};

/** Exact retry evidence; detached paths are managed-receipt references, never caller authority. */
export type BrokerLifecycleCleanupFile = {
	/** Original lifecycle-owned path, retained only for exact identity validation. */
	path: string;
	identity: BrokerCleanupIdentity;
	/** Monotonic append-only cleanup attempt. */
	attempt?: number;
	/** Immutable no-replace quarantine destination persisted before native detach. */
	plannedPath: string;
	/** Native-returned detached path, persisted after a failed post-detach cleanup. */
	detachedPath?: string;
	/** Append-only terminal proof for this exact artifact; completed entries are never retried. */
	completed?: true;
};

/** Durable root-tree authority for broker artifact cleanup. */
export type BrokerArtifactTree = {
	identity: BrokerCleanupIdentity;
	snapshot: NativeDirectoryTreeSnapshot;
	plannedPath: string;
	detachedPath?: string;
	completed?: true;
};

export type BrokerCleanupEvidence = {
	phase: "artifacts" | "transcript" | "metadata" | "lifecycle";
	cleanupReceiptVersion?: 1;
	/** Ledger-bound deletion target; never reconstructed from a retry request. */
	sessionsRoot?: string;
	transcriptPath?: string;
	cwd?: string;
	metadataRoot?: string;
	sessionId?: string;
	artifactsIdentity?: BrokerCleanupIdentity;
	transcriptIdentity?: BrokerCleanupIdentity;
	transcriptParentIdentity?: { dev: string; ino: string };
	/** Identity-bound lifecycle metadata marker retained when exact cleanup is deferred. */
	metadataIdentity?: BrokerCleanupIdentity;
	metadataPath?: string;
	/** Monotonic append-only cleanup attempt. */
	metadataAttempt?: number;
	/** No-replace quarantine destination persisted before lifecycle metadata detach. */
	plannedMetadataPath?: string;
	/** Native-returned metadata quarantine path retained until identity-bound reconciliation succeeds. */
	detachedMetadataPath?: string;
	/** Append-only terminal proof for lifecycle metadata cleanup. */
	metadataCompleted?: true;
	detachedArtifactsPath?: string;
	retainedArtifactsSuccessorPath?: string;
	retainedArtifactsPlaceholderPath?: string;
	retainedArtifactsUnknownPath?: string;
	retainedArtifactsSideAuthority?: "none" | "retained";
	detachedTranscriptPath?: string;
	retainedTranscriptSuccessorPath?: string;
	retainedTranscriptPlaceholderPath?: string;
	retainedTranscriptUnknownPath?: string;
	/** Durable proof that artifact cleanup completed before transcript mutation. */
	artifactsRemoved?: boolean;
	artifactsAbsentAtAuthorization?: true;
	/** Preauthorized no-replace artifact quarantine path persisted before detach. */
	plannedArtifactsPath?: string;
	/** Identity-bound artifact tree authority persisted before broker detach and replayed exactly. */
	artifactTree?: BrokerArtifactTree;
	/** Preauthorized no-replace transcript quarantine path persisted before detach. */
	plannedTranscriptPath?: string;
	/** Fully identity-bound startup-failure cleanup plan, persisted before any detach. */
	lifecycleFiles?: BrokerLifecycleCleanupFile[];
	lifecycleParentIdentity?: { dev: string; ino: string };
	/** Delete metadata receipts authorize only the canonical marker/ready sibling pair. */
	lifecycleDeleteMetadata?: true;
};
export type BrokerResponse =
	| { ok: true; result?: unknown; indexSeq?: number }
	| {
			ok: false;
			error: {
				code: BrokerErrorCode;
				message: string;
				details?: ModelProfileErrorDetails;
				endpoint?: "unavailable";
				cleanup?: BrokerCleanupEvidence;
			};
			indexSeq?: number;
			durableEffects?: LifecycleDurableEffectsReceipt;
			startupFailure?: LifecycleStartupFailureReceipt;
	  };
const error = (code: BrokerErrorCode, message: string): BrokerResponse => ({ ok: false, error: { code, message } });

function elevationResultToBroker<T>(result: ElevationResult<T>): BrokerResponse {
	if (result.ok) return { ok: true, result: result.value };
	return error(result.error.code as BrokerErrorCode, result.error.message);
}

function elevationAnswerToBroker(result: ElevationResult<ElevationAnswerValue>): BrokerResponse {
	if (!result.ok) return elevationResultToBroker(result);
	const { outcome, grant } = result.value;
	if (outcome === "granted")
		return { ok: true, result: { elevationRequestId: grant.elevationRequestId, state: grant.state, outcome, grant } };
	return error(outcome as BrokerErrorCode, `elevation ${outcome}: ${grant.elevationRequestId}`);
}

/**
 * Result of resolving the session behind an elevation grant/request. An
 * ambiguous session (C6) can never bind an exact endpoint identity.
 */
type ElevationSessionResolution =
	| { kind: "identity"; identity: ElevationSessionIdentity }
	| { kind: "ambiguous" }
	| { kind: "unavailable" };
function sameElevationSessionIdentity(left: ElevationSessionIdentity, right: ElevationSessionIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		path.resolve(left.endpointStateRoot) === path.resolve(right.endpointStateRoot) &&
		left.endpointGeneration === right.endpointGeneration &&
		left.endpointIncarnation === right.endpointIncarnation
	);
}
function isCleanupPending(response: BrokerResponse): boolean {
	return !response.ok && response.error.code === "cleanup_pending" && response.error.cleanup !== undefined;
}

function cleanupFromResponse(response: unknown): BrokerCleanupEvidence | undefined {
	return isBrokerResponse(response) && !response.ok ? response.error.cleanup : undefined;
}
function pendingCleanupSessionId(response: BrokerResponse): string | undefined {
	if (response.ok || response.error.code !== "cleanup_pending") return undefined;
	return typeof response.error.cleanup?.sessionId === "string" ? response.error.cleanup.sessionId : undefined;
}

function lifecycleResponseState(response: BrokerResponse): LifecycleState {
	if (response.ok) return "terminal_ok";
	if (isCleanupPending(response)) return "effect_started";
	return response.error.code === "terminal_uncertain" ? "terminal_uncertain" : "terminal_error";
}

type InputNormalization = { input: Record<string, unknown> } | BrokerResponse;

type SessionListCursor = {
	sessions: IndexedSession[];
	indexSeq: number;
	warnings: string[];
	limit: number;
	offset: number;
	expiresAt: number;
};

const SESSION_LIST_DEFAULT_LIMIT = 100;
const SESSION_LIST_MAX_LIMIT = 100;
const SESSION_LIST_CURSOR_TTL_MS = 15 * 60 * 1_000;
const SESSION_LIST_MAX_CURSORS = 32;

function sessionListLimit(input: Record<string, unknown>): number | BrokerResponse {
	const limit = input.limit;
	if (limit === undefined) return SESSION_LIST_DEFAULT_LIMIT;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_LIST_MAX_LIMIT)
		return error("invalid_input", `limit must be a safe integer from 1 to ${SESSION_LIST_MAX_LIMIT}`);
	return limit;
}

function isBrokerResponse(value: unknown): value is BrokerResponse {
	return typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";
}

function normalizeAliasedString(
	input: Record<string, unknown>,
	canonical: string,
	aliases: readonly string[],
	normalize = (value: string) => value,
): { value: string | undefined; error?: string } {
	const supplied = [canonical, ...aliases].filter(name => input[name] !== undefined).map(name => input[name]);
	if (supplied.length === 0) return { value: undefined };
	if (supplied.some(value => typeof value !== "string" || value.length === 0))
		return { value: undefined, error: `${canonical} must be a non-empty string` };
	const values = supplied.map(value => normalize(value as string));
	if (values.some(value => value !== values[0])) return { value: undefined, error: `${canonical} aliases conflict` };
	return { value: values[0] };
}

function normalizeBrokerInput(operation: string, input: Record<string, unknown>): InputNormalization {
	const normalized: Record<string, unknown> = { ...input };
	const session = normalizeAliasedString(input, "sessionId", ["id"]);
	if (session.error) return error("invalid_input", session.error);
	if (session.value !== undefined) {
		if (!isCanonicalSessionId(session.value))
			return error("invalid_input", "sessionId must be a canonical safe identifier");
		normalized.sessionId = session.value;
		delete normalized.id;
	}
	const source = normalizeAliasedString(input, "sourceSessionId", ["sourceId"]);
	if (source.error) return error("invalid_input", source.error);
	if (source.value !== undefined) {
		if (!isCanonicalSessionId(source.value))
			return error("invalid_input", "sourceSessionId must be a canonical safe identifier");
		normalized.sourceSessionId = source.value;
		delete normalized.sourceId;
	}
	if (input.directoryMigration !== undefined)
		return error("invalid_input", "directoryMigration is broker-managed and cannot be selected by clients.");

	if (operation === "session.list") {
		const resolved = input.resolveSessionId;
		if (resolved !== undefined && (typeof resolved !== "string" || !isCanonicalSessionId(resolved)))
			return error("invalid_input", "resolveSessionId must be a canonical safe identifier");
		if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length === 0))
			return error("invalid_input", "cursor must be a non-empty opaque string");
		const limit = sessionListLimit(input);
		if (isBrokerResponse(limit)) return limit;
		return { input: normalized };
	}
	if (
		operation !== "session.create" &&
		operation !== "session.fork" &&
		operation !== "session.resume" &&
		operation !== "session.close" &&
		operation !== "session.delete"
	)
		return { input: normalized };

	const target =
		typeof input.target === "object" && input.target !== null && !Array.isArray(input.target)
			? (input.target as Record<string, unknown>)
			: undefined;
	const normalizeLifecycleDirectory = operation === "session.delete" ? canonicalDeleteLocatorPath : path.resolve;
	const cwd = normalizeAliasedString(
		{ cwd: input.cwd, path: input.path, targetPath: target?.path },
		"cwd",
		["path", "targetPath"],
		normalizeLifecycleDirectory,
	);
	if (cwd.error) return error("invalid_input", cwd.error);
	if (cwd.value !== undefined) {
		normalized.cwd = cwd.value;
		delete normalized.path;
	}
	const stateRoot = normalizeAliasedString(
		{ stateRoot: input.stateRoot, targetStateRoot: target?.stateRoot },
		"stateRoot",
		["targetStateRoot"],
		normalizeLifecycleDirectory,
	);
	if (stateRoot.error) return error("invalid_input", stateRoot.error);
	if (stateRoot.value !== undefined && (!cwd.value || stateRoot.value !== path.join(cwd.value, ".gjc", "state")))
		return error("invalid_input", "stateRoot must be the default .gjc/state for cwd.");
	if (cwd.value !== undefined) normalized.stateRoot = path.join(cwd.value, ".gjc", "state");
	else if (stateRoot.value !== undefined) return error("invalid_input", "stateRoot requires cwd.");

	if (target) {
		const normalizedTarget = { ...target };
		delete normalizedTarget.path;
		delete normalizedTarget.stateRoot;
		if (Object.keys(normalizedTarget).length > 0) normalized.target = normalizedTarget;
		else delete normalized.target;
	}
	if (operation === "session.delete") {
		const sessionPath = normalizeAliasedString(input, "sessionPath", [], canonicalDeleteLocatorPath);
		if (sessionPath.error) return error("invalid_input", sessionPath.error);
		if (sessionPath.value !== undefined) normalized.sessionPath = sessionPath.value;
	}
	return { input: normalized };
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

type EndpointAuthority = { endpointGeneration?: number; endpointIncarnation?: string };
function endpointIncarnation(
	record: Pick<IndexedSession, "endpointGeneration" | "endpointMtimeMs" | "pid">,
	sessionId: string,
): string | undefined {
	if (
		!Number.isSafeInteger(record.endpointGeneration) ||
		record.endpointGeneration <= 0 ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.endpointMtimeMs !== "number" ||
		!Number.isFinite(record.endpointMtimeMs) ||
		record.endpointMtimeMs <= 0
	)
		return undefined;
	return createHash("sha256")
		.update(
			canonicalJson({
				endpointGeneration: record.endpointGeneration,
				endpointMtimeMs: record.endpointMtimeMs,
				pid: record.pid,
				sessionId,
			}),
		)
		.digest("hex");
}
function expectedEndpointAuthority(input: Record<string, unknown>): EndpointAuthority | BrokerResponse {
	const endpointGeneration = input.endpointGeneration;
	const endpointIncarnation = input.endpointIncarnation;
	if (
		endpointGeneration !== undefined &&
		(typeof endpointGeneration !== "number" || !Number.isSafeInteger(endpointGeneration) || endpointGeneration <= 0)
	)
		return error("invalid_input", "endpointGeneration must be a positive safe integer");
	if (
		endpointIncarnation !== undefined &&
		(typeof endpointIncarnation !== "string" || !/^[a-f0-9]{64}$/.test(endpointIncarnation))
	)
		return error("invalid_input", "endpointIncarnation must be a SHA-256 hash");
	if (endpointIncarnation !== undefined && endpointGeneration === undefined)
		return error("invalid_input", "endpointIncarnation requires endpointGeneration");
	return { endpointGeneration, endpointIncarnation };
}
function matchesEndpointAuthority(record: IndexedSession, authority: EndpointAuthority): boolean {
	return (
		(authority.endpointGeneration === undefined || authority.endpointGeneration === record.endpointGeneration) &&
		(authority.endpointIncarnation === undefined ||
			authority.endpointIncarnation === endpointIncarnation(record, record.sessionId))
	);
}
function sameEndpointRecord(expected: IndexedSession, current: IndexedSession): boolean {
	return (
		current.live &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		path.resolve(current.locator.repo) === path.resolve(expected.locator.repo) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

function lifecycleTarget(operation: string, input: Record<string, unknown>): unknown {
	const target = input.target as Record<string, unknown> | undefined;
	const string = (...values: unknown[]): string | undefined =>
		values.find((value): value is string => typeof value === "string" && value.length > 0);
	const explicitRoot = string(input.stateRoot, target?.stateRoot);
	const root =
		explicitRoot ??
		(() => {
			const cwd = string(input.cwd, input.path, target?.path);
			return cwd ? path.join(cwd, ".gjc", "state") : undefined;
		})();
	const id = string(input.sessionId, input.id);
	switch (operation) {
		case "session.create":
			return { root };
		case "session.fork":
			return {
				root,
				sourceSessionId: string(input.sourceSessionId, input.sourceId),
				sourceSessionPath: string(input.sourceSessionPath, input.sourcePath, input.sessionPath),
			};
		case "session.resume":
		case "session.close":
		case "session.delete":
			return { sessionId: id };
		default:
			return { operation, root, sessionId: id };
	}
}

const BROKER_LOCK_RECORD = "owner.json";
const BROKER_INDEX_COMPACT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const BROKER_LOCK_STARTUP_WAIT_MS = 1_000;
const BROKER_LOCK_RETRY_MS = 10;

type BrokerLockSnapshot = {
	ownerId?: string;
	pid: number;
	identity: string;
	lockIdentity: string;
};

/** Tombstone prefix used by {@link Broker.reclaimStaleLock} when a dead owner's lock is renamed aside. */
export const BROKER_LOCK_TOMBSTONE_PREFIX = ".broker.lock.stale-";

/**
 * Recovery directories left beside the lock by manual and older automated broker
 * restarts. Nothing writes them today, but installs that ever recovered by hand
 * still carry them, so the reaper owns them alongside its own tombstones.
 */
export const BROKER_LOCK_BACKUP_PREFIXES = ["broker-restart-backup-", "broker-stale-backup-"] as const;

/**
 * Age bound before a reclaimed lock artifact may be removed. Generous enough
 * that a broker still settling after a reclaim can never have its own successor
 * state deleted underneath it.
 */
export const BROKER_LOCK_ARTIFACT_GRACE_MS = 24 * 60 * 60 * 1_000;

/** Why a candidate lock artifact survived a reap pass. */
export type BrokerLockArtifactRetentionReason =
	| "within-grace"
	| "owner-alive"
	| "owner-record-unreadable"
	| "owner-record-missing"
	| "not-a-directory"
	| "removal-failed";

export interface BrokerLockArtifactRetention {
	path: string;
	reason: BrokerLockArtifactRetentionReason;
}

export interface BrokerLockArtifactReapResult {
	removed: string[];
	retained: BrokerLockArtifactRetention[];
}

function isBrokerLockArtifactName(name: string): boolean {
	return (
		name.startsWith(BROKER_LOCK_TOMBSTONE_PREFIX) ||
		BROKER_LOCK_BACKUP_PREFIXES.some(prefix => name.startsWith(prefix))
	);
}

/**
 * Decide whether one candidate directory is provably abandoned.
 *
 * Fail-closed by construction: every branch that cannot prove abandonment
 * returns a retention reason. A tombstone is only abandoned when its owner
 * record parses and names a dead PID — an unreadable, permission-denied, or
 * absent record keeps it forever. Backup directories carry no owner contract,
 * so an absent record there is not ambiguity and age alone governs.
 */
async function classifyBrokerLockArtifact(
	directory: string,
	name: string,
	now: number,
	graceMs: number,
	pidAlive: (pid: number) => boolean,
): Promise<BrokerLockArtifactRetentionReason | "abandoned"> {
	const target = path.join(directory, name);
	// lstat, never stat: a symlink pointing at live state must never be followed
	// into a recursive removal.
	const stat = await fs.lstat(target);
	if (!stat.isDirectory()) return "not-a-directory";
	if (!Number.isFinite(stat.mtimeMs) || now - stat.mtimeMs < graceMs) return "within-grace";
	let raw: string;
	try {
		raw = await fs.readFile(path.join(target, BROKER_LOCK_RECORD), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") return "owner-record-unreadable";
		return name.startsWith(BROKER_LOCK_TOMBSTONE_PREFIX) ? "owner-record-missing" : "abandoned";
	}
	let pid: unknown;
	try {
		pid = (JSON.parse(raw) as { pid?: unknown }).pid;
	} catch {
		return "owner-record-unreadable";
	}
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "owner-record-unreadable";
	return pidAlive(pid) ? "owner-alive" : "abandoned";
}

/**
 * Remove reclaimed broker lock tombstones and legacy restart backups older than
 * the grace window.
 *
 * `#reclaimStaleLock` renames a dead owner's lock to a tombstone named by a hash
 * of the lock's dev+ino, so a machine accrues one directory per dead owner and
 * nothing ever removed them (54 on the install in #3963). Reaping is
 * best-effort and fail-closed: anything live, unreadable, permission-denied, or
 * otherwise ambiguous is kept and the reason is logged.
 */
export async function reapStaleBrokerLockArtifacts(input: {
	agentDir: string;
	now?: number;
	graceMs?: number;
	pidAlive?: (pid: number) => boolean;
}): Promise<BrokerLockArtifactReapResult> {
	const directory = path.join(input.agentDir, "sdk");
	const now = input.now ?? Date.now();
	const graceMs = input.graceMs ?? BROKER_LOCK_ARTIFACT_GRACE_MS;
	const pidAlive = input.pidAlive ?? isPidAlive;
	const removed: string[] = [];
	const retained: BrokerLockArtifactRetention[] = [];
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { removed, retained };
		throw error;
	}
	for (const name of names) {
		if (!isBrokerLockArtifactName(name)) continue;
		const target = path.join(directory, name);
		let verdict: BrokerLockArtifactRetentionReason | "abandoned";
		try {
			verdict = await classifyBrokerLockArtifact(directory, name, now, graceMs, pidAlive);
		} catch (error) {
			// A vanished candidate needs no decision; anything else is ambiguous.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			verdict = "owner-record-unreadable";
		}
		if (verdict !== "abandoned") {
			retained.push({ path: target, reason: verdict });
			if (verdict !== "within-grace") logger.warn(`sdk broker: retained stale lock artifact ${name} (${verdict})`);
			continue;
		}
		try {
			await fs.rm(target, { recursive: true });
			removed.push(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			retained.push({ path: target, reason: "removal-failed" });
			logger.warn(`sdk broker: retained stale lock artifact ${name} (removal-failed)`);
		}
	}
	if (removed.length > 0) logger.info(`sdk broker: reaped ${removed.length} stale lock artifact(s)`);
	return { removed, retained };
}

const BROKER_PUBLICATION_CADENCE_MS = 5_000;
const BROKER_PUBLICATION_GRACE_MS = 15_000;
// A broker that cannot observe its own publication is not provably the root, but
// ambiguity is also not proof of replacement, so it must not be treated as a
// `lost-root` immediately. It must still be bounded: an indefinitely ambiguous
// broker stops heartbeating, so peers discover it as stale and spawn replacements
// while it keeps its port and memory forever. Ambiguity therefore accrues against
// its own deadline, generous enough to absorb transient filesystem faults and far
// longer than the loss grace.
const BROKER_AMBIGUITY_GRACE_MS = 120_000;
const BROKER_SETTLEMENT_MS = 2_000;

export interface StartupAdmissionTiming {
	now(): number;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type StartupAdmissionResult<T> =
	| { status: "completed"; admittedAt: number; value: T }
	| { status: "admission_timeout"; reason: "admission_timeout" }
	| { status: "admission_refused"; reason: "admission_refused" };

interface StartupAdmissionWaiter {
	state: "waiting" | "admitted" | "timed_out" | "refused";
	admissionEpoch?: number;
	ready: PromiseWithResolvers<void>;
}

// Host startup is CPU/IO bursty, so scale with the machine without allowing a full-core launch stampede.
export function sdkHostStartupConcurrency(availableParallelism = os.availableParallelism()): number {
	if (!Number.isSafeInteger(availableParallelism) || availableParallelism < 1)
		throw new Error("SDK host startup parallelism must be a positive safe integer.");
	return Math.max(1, Math.floor(Math.sqrt(availableParallelism)));
}

export class StartupAdmissionQueue {
	#inFlight = 0;
	#closed = false;
	#epoch = 0;
	#waiters: StartupAdmissionWaiter[] = [];

	constructor(readonly limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("SDK host startup concurrency must be a positive safe integer.");
	}

	async run<T>(
		queueWaitMs: number,
		timing: StartupAdmissionTiming,
		task: (admittedAt: number) => Promise<T>,
	): Promise<StartupAdmissionResult<T>> {
		if (!Number.isSafeInteger(queueWaitMs) || queueWaitMs < 1)
			throw new Error("SDK host startup queue wait must be a positive safe integer.");
		if (this.#closed) return { status: "admission_refused", reason: "admission_refused" };
		if (this.#inFlight < this.limit) return this.#runAdmitted(timing, task);

		const ready = Promise.withResolvers<void>();
		const waiter: StartupAdmissionWaiter = { state: "waiting", ready };
		this.#waiters.push(waiter);
		const cutoff = new AbortController();
		let outcome: "admitted" | "timed_out" | "refused";
		try {
			outcome = await Promise.race([
				ready.promise.then(() => (waiter.state === "refused" ? ("refused" as const) : ("admitted" as const))),
				timing.sleep(queueWaitMs, cutoff.signal).then(() => {
					if (waiter.state === "admitted") return "admitted" as const;
					if (waiter.state === "refused") return "refused" as const;
					if (waiter.state === "timed_out") return "timed_out" as const;
					waiter.state = "timed_out";
					const index = this.#waiters.indexOf(waiter);
					if (index >= 0) this.#waiters.splice(index, 1);
					return "timed_out" as const;
				}),
			]);
		} finally {
			cutoff.abort();
		}
		if (outcome === "timed_out") return { status: "admission_timeout", reason: "admission_timeout" };
		if (outcome === "refused") return { status: "admission_refused", reason: "admission_refused" };
		return this.#runGranted(waiter.admissionEpoch!, timing, task);
	}

	async #runAdmitted<T>(
		timing: StartupAdmissionTiming,
		task: (admittedAt: number) => Promise<T>,
	): Promise<StartupAdmissionResult<T>> {
		const admissionEpoch = this.#epoch;
		this.#inFlight += 1;
		return this.#runGranted(admissionEpoch, timing, task);
	}

	async #runGranted<T>(
		admissionEpoch: number,
		timing: StartupAdmissionTiming,
		task: (admittedAt: number) => Promise<T>,
	): Promise<StartupAdmissionResult<T>> {
		try {
			const admittedAt = timing.now();
			if (this.#closed || admissionEpoch !== this.#epoch)
				return { status: "admission_refused", reason: "admission_refused" };
			return { status: "completed", admittedAt, value: await task(admittedAt) };
		} finally {
			this.#inFlight -= 1;
			this.#grantNext();
		}
	}

	#grantNext(): void {
		if (this.#closed) return;
		while (this.#inFlight < this.limit) {
			const waiter = this.#waiters.shift();
			if (!waiter) return;
			if (waiter.state !== "waiting") continue;
			waiter.state = "admitted";
			waiter.admissionEpoch = this.#epoch;
			this.#inFlight += 1;
			waiter.ready.resolve();
		}
	}

	/**
	 * Refuse every queued startup and every later one. A broker that can no longer
	 * prove it owns the published root must not spawn children through slots that
	 * free up while it is fenced. The epoch also invalidates a waiter that was
	 * granted but has not crossed the task execution boundary yet.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#epoch += 1;
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.state !== "waiting") continue;
			waiter.state = "refused";
			waiter.ready.resolve();
		}
	}

	/** Accept later startups after fresh publication ownership has been proven. */
	reopen(): void {
		this.#closed = false;
		this.#grantNext();
	}
}
type BrokerPublicationState =
	| "healthy-owned"
	| "suspect-unpublished"
	| "observation-ambiguous"
	| "heartbeat-ambiguous"
	| "stopping";
type BrokerStopMode = "owned-root" | "lost-root";

const terminalPersistenceHooksForTest = new WeakMap<Broker, () => void>();
const ambiguityGraceOverridesForTest = new WeakMap<Broker, number>();
const publicationObservationOverridesForTest = new WeakMap<Broker, BrokerPublicationObservation>();
const lockArtifactGraceOverridesForTest = new WeakMap<Broker, number>();
function elevationLedgerEnabledForBroker(): boolean {
	const raw = (process.env.GJC_SDK_ELEVATION_ENABLED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true";
}

/** Recursive reserved-key rejection: the claim selector never travels inside approved input. */
function containsReservedKey(value: unknown, key: string, seen = new Set<object>()): boolean {
	if (!value || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsReservedKey(item, key, seen));
	return (
		Object.hasOwn(value, key) ||
		Object.values(value as Record<string, unknown>).some(nested => containsReservedKey(nested, key, seen))
	);
}

export class Broker {
	readonly settings: ResolvedBrokerSettings;
	readonly index: SessionIndex;
	readonly ledger: LifecycleLedger;
	readonly elevation: ElevationLedger;
	readonly operationReceipts: OperationReceiptLedger;
	discovery: BrokerDiscovery | null = null;
	#lock: string;
	#owner = randomBytes(12).toString("hex");
	#sessionListCursors = new Map<string, SessionListCursor>();
	#chains = new Map<string, Promise<void>>();
	#admitted = new Set<Promise<void>>();
	#startupAdmissions = new StartupAdmissionQueue(sdkHostStartupConcurrency());
	#publication: RetainedBrokerDiscovery | null = null;
	#publicationState: BrokerPublicationState = "healthy-owned";
	#lossAt: bigint | null = null;
	#ambiguousAt: bigint | null = null;
	#stopping = false;
	#transport: BrokerTransport | null = null;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#completionTask: Promise<void> | null = null;
	#completion!: Promise<void>;
	#resolveCompletion!: () => void;
	#rejectCompletion!: (error: unknown) => void;
	/** Broker tenure counter: increments per start so a restart is a new epoch. */
	#epoch = 0;
	#incarnation: string | null = null;
	#elevationEnforced: boolean;
	#compactTimer: NodeJS.Timeout | null = null;
	#operatorTimer: NodeJS.Timeout | null = null;
	constructor(settings: BrokerSettings) {
		this.settings = {
			agentDir: settings.agentDir,
			packageGeneration: settings.packageGeneration ?? "unknown",
			port: settings.port ?? 0,
			heartbeatTtlMs: settings.heartbeatTtlMs ?? BROKER_HEARTBEAT_TTL_MS,
			resolveDirectoryMigration: settings.resolveDirectoryMigration ?? (async () => "copy-retain"),
		};
		this.index = new SessionIndex(settings.agentDir);
		this.ledger = new LifecycleLedger(settings.agentDir);
		this.elevation = new ElevationLedger(settings.agentDir);
		this.operationReceipts = new OperationReceiptLedger(settings.agentDir);
		this.#lock = path.join(settings.agentDir, "sdk", "broker.lock");
		this.#elevationEnforced = elevationLedgerEnabledForBroker();
		const completion = Promise.withResolvers<void>();
		this.#completion = completion.promise;
		this.#resolveCompletion = completion.resolve;
		this.#rejectCompletion = completion.reject;
	}
	runStartup<T>(
		queueWaitMs: number,
		timing: StartupAdmissionTiming,
		task: (admittedAt: number) => Promise<T>,
	): Promise<StartupAdmissionResult<T>> {
		return this.#startupAdmissions.run(queueWaitMs, timing, task);
	}
	#lockRecordPath(): string {
		return path.join(this.#lock, BROKER_LOCK_RECORD);
	}
	async #lockSnapshot(raw: string, lockIdentity: string): Promise<BrokerLockSnapshot> {
		try {
			const lock = JSON.parse(raw) as { ownerId?: unknown; pid?: unknown };
			if (
				typeof lock.ownerId === "string" &&
				lock.ownerId.length > 0 &&
				typeof lock.pid === "number" &&
				Number.isInteger(lock.pid) &&
				lock.pid > 0
			)
				return { ownerId: lock.ownerId, pid: lock.pid, identity: `owner:${lock.ownerId}`, lockIdentity };
		} catch {}
		return { pid: 0, identity: `contents:${createHash("sha256").update(raw).digest("hex")}`, lockIdentity };
	}
	async #readLock(): Promise<BrokerLockSnapshot | null> {
		let lock: BigIntStats;
		try {
			lock = await fs.lstat(this.#lock, { bigint: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
		const lockIdentity = `${lock.dev}:${lock.ino}`;
		let raw: string;
		try {
			raw = lock.isDirectory()
				? await fs.readFile(path.join(this.#lock, BROKER_LOCK_RECORD), "utf8")
				: await fs.readFile(this.#lock, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			raw = "";
		}
		try {
			const current = await fs.lstat(this.#lock, { bigint: true });
			if (`${current.dev}:${current.ino}` !== lockIdentity || current.isDirectory() !== lock.isDirectory())
				return null;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
		return this.#lockSnapshot(raw, lockIdentity);
	}
	async #createLock(): Promise<void> {
		await fs.mkdir(this.#lock, { mode: 0o700 });
		try {
			await fs.writeFile(
				this.#lockRecordPath(),
				JSON.stringify({ version: 1, ownerId: this.#owner, pid: process.pid, acquiredAt: Date.now() }),
				{ flag: "wx", mode: 0o600 },
			);
		} catch (e) {
			try {
				await fs.rmdir(this.#lock);
			} catch {}
			throw e;
		}
	}
	async #waitForBrokerDiscovery(): Promise<BrokerDiscovery | null> {
		const deadline = Date.now() + BROKER_LOCK_STARTUP_WAIT_MS;
		while (Date.now() < deadline) {
			const live = await readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
			if (live) return live;
			await Bun.sleep(BROKER_LOCK_RETRY_MS);
		}
		return readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
	}
	async #reclaimStaleLock(snapshot: BrokerLockSnapshot): Promise<void> {
		const current = await this.#readLock();
		if (
			!current ||
			current.identity !== snapshot.identity ||
			current.lockIdentity !== snapshot.lockIdentity ||
			(current.pid > 0 && isPidAlive(current.pid))
		)
			return;

		// Snapshot validation and the deterministic instance suffix protect successor locks.
		const tombstone = path.join(
			path.dirname(this.#lock),
			`.broker.lock.stale-${createHash("sha256").update(snapshot.lockIdentity).digest("hex")}`,
		);
		try {
			await fs.rename(this.#lock, tombstone);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (["ENOENT", "EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"].includes(code ?? "")) return;
			if (code === "EPERM") {
				try {
					await fs.lstat(tombstone);
					return;
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				}
			}
			throw e;
		}
	}
	async #releaseOwnedLock(): Promise<void> {
		try {
			const lock = await this.#readLock();
			if (lock?.ownerId !== this.#owner) return;
			await fs.unlink(this.#lockRecordPath());
			await fs.rmdir(this.#lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	/**
	 * Best-effort startup reap of reclaimed lock tombstones and legacy restart
	 * backups. Cleanup debris must never fail an otherwise healthy startup, so a
	 * fault here is logged and swallowed.
	 */
	async #reapLockArtifacts(): Promise<void> {
		try {
			await reapStaleBrokerLockArtifacts({
				agentDir: this.settings.agentDir,
				graceMs: lockArtifactGraceOverridesForTest.get(this),
			});
		} catch (error) {
			logger.warn(`sdk broker: stale lock artifact reap failed: ${String(error)}`);
		}
	}

	async start(): Promise<BrokerDiscovery> {
		if (this.#completionTask) {
			await this.#completionTask;
			const completion = Promise.withResolvers<void>();
			this.#completion = completion.promise;
			this.#resolveCompletion = completion.resolve;
			this.#rejectCompletion = completion.reject;
			this.#completionTask = null;
			// A drained queue refuses every later startup by design, so a restarted broker
			// needs a new one or it would admit nothing for the rest of the process.
			this.#startupAdmissions = new StartupAdmissionQueue(sdkHostStartupConcurrency());
		}
		this.#stopping = false;
		this.#epoch += 1;
		this.#publicationState = "healthy-owned";
		this.#lossAt = null;
		this.#ambiguousAt = null;
		await Promise.all([
			this.ledger.assertSupportedStateVersions(),
			this.elevation.assertSupportedStateVersions(),
			readBrokerDiscovery(this.settings.agentDir),
		]);
		await fs.mkdir(path.dirname(this.#lock), { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				await this.#createLock();
				break;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}

			const live = await readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
			if (live) {
				// This process loses the ownership race and its caller only ever sees a
				// clean exit, so name the reason here (#3963).
				logger.info(
					`sdk broker: lock contention, yielding to the live broker owner (ownerId=${live.ownerId}, pid=${live.pid}); this process exits without owning discovery`,
				);
				this.discovery = live;
				return live;
			}
			const snapshot = await this.#readLock();
			if (!snapshot) continue;
			if (snapshot.pid > 0 && isPidAlive(snapshot.pid)) {
				const starting = await this.#waitForBrokerDiscovery();
				if (starting) {
					logger.info(
						`sdk broker: lock contention, yielding to the broker that just started (ownerId=${starting.ownerId}, pid=${starting.pid}); this process exits without owning discovery`,
					);
					this.discovery = starting;
					return starting;
				}
				const current = await this.#readLock();
				if (current && current.identity === snapshot.identity && current.pid > 0 && isPidAlive(current.pid)) {
					logger.warn(
						`sdk broker: lock contention, refusing to start because ${this.#lock} is held by live pid ${current.pid} that published no discovery record`,
					);
					throw new Error(`Broker lock is held by a live owner (pid ${current.pid})`);
				}
				continue;
			}
			await this.#reclaimStaleLock(snapshot);
		}
		// Only the lock holder reaps, so concurrent brokers cannot race the removal.
		await this.#reapLockArtifacts();
		try {
			await this.index.open();
			await this.ledger.open();
			await this.elevation.open();
			await this.operationReceipts.open();
			if (this.#elevationEnforced)
				await fs.mkdir(path.join(this.settings.agentDir, "sdk", "elevation", "operator"), {
					recursive: true,
					mode: 0o700,
				});
			// Broker-scheduled compaction (C3): apply the retention policy once at
			// startup and again every six hours, independently of log rotation.
			await this.#compactSessionIndex();
			const now = Date.now();
			const incarnation = brokerProcessIncarnation(process.pid);
			if (!incarnation) throw new Error("Broker process incarnation is unavailable.");
			this.#incarnation = incarnation;
			const token = newBrokerToken();
			this.#transport = new BrokerTransport(this, token, this.settings.port);
			const port = await this.#transport.start();
			this.discovery = {
				version: 1,
				protocolVersion: 3,
				packageGeneration: this.settings.packageGeneration,
				ownerId: this.#owner,
				pid: process.pid,
				incarnation,
				host: "127.0.0.1",
				port,
				url: `ws://127.0.0.1:${port}`,
				token,
				startedAt: now,
				heartbeatAt: now,
			};
			this.#publication = await publishBrokerDiscovery(this.settings.agentDir, this.discovery);
			this.#publicationState = "healthy-owned";
			const cadenceMs = Math.max(
				10,
				Math.min(BROKER_PUBLICATION_CADENCE_MS, Math.floor(this.settings.heartbeatTtlMs / 3)),
			);
			this.#heartbeatTimer = setInterval(() => void this.#watchPublication(), cadenceMs);
			this.#compactTimer = setInterval(() => void this.#compactSessionIndex(), BROKER_INDEX_COMPACT_INTERVAL_MS);
			if (this.#elevationEnforced) this.#operatorTimer = setInterval(() => void this.#pollOperatorDirectives(), 250);
			return this.discovery;
		} catch (error) {
			await this.#transport?.stop();
			this.#transport = null;
			this.#publication?.close();
			this.#publication = null;
			this.discovery = null;
			await this.#releaseOwnedLock();
			throw error;
		}
	}
	get ownsDiscovery(): boolean {
		return this.discovery?.ownerId === this.#owner;
	}
	get completion(): Promise<void> {
		return this.#completion;
	}
	status(): RedactedBrokerDiscovery | null {
		return this.discovery ? redactBrokerDiscovery(this.discovery) : null;
	}
	#fence(kind: "suspect-unpublished" | "observation-ambiguous" | "heartbeat-ambiguous"): void {
		if (this.#publicationState === "stopping") return;
		this.#publicationState = kind;
		this.#startupAdmissions.close();
		if (kind === "suspect-unpublished") {
			this.#lossAt ??= process.hrtime.bigint();
			this.#ambiguousAt = null;
		} else {
			this.#lossAt = null;
			this.#ambiguousAt ??= process.hrtime.bigint();
		}
	}
	/**
	 * Whether this broker has been unable to confirm it is the published root for
	 * longer than the deadline for its current fence. Replacement is proven quickly
	 * and ambiguity slowly, but neither may persist indefinitely: a permanently
	 * fenced broker never heartbeats, so it is unreachable through discovery while
	 * still holding its port and memory.
	 */
	#fencedBeyondDeadline(): boolean {
		const now = process.hrtime.bigint();
		if (this.#lossAt !== null && now - this.#lossAt >= BigInt(BROKER_PUBLICATION_GRACE_MS) * 1_000_000n) return true;
		const ambiguityGraceMs = ambiguityGraceOverridesForTest.get(this) ?? BROKER_AMBIGUITY_GRACE_MS;
		return this.#ambiguousAt !== null && now - this.#ambiguousAt >= BigInt(ambiguityGraceMs) * 1_000_000n;
	}
	async #watchPublication(writeHeartbeat = true): Promise<void> {
		if (!this.#publication || this.#publicationState === "stopping") return;
		let observation: ReturnType<RetainedBrokerDiscovery["observe"]>;
		try {
			observation = publicationObservationOverridesForTest.get(this) ?? this.#publication.observe();
		} catch {
			this.#fence("observation-ambiguous");
			if (this.#fencedBeyondDeadline()) void this.#complete("lost-root");
			return;
		}
		if (observation === "owned") {
			// Recover the cached publication state synchronously with the observation
			// so request admission does not lag behind the awaited heartbeat IO.
			// The heartbeat write that follows re-checks fresh publication authority
			// and fences (downgrading this optimistic recovery) if ownership changed
			// between the observation and the write.
			this.#publicationState = "healthy-owned";
			this.#startupAdmissions.reopen();
			this.#lossAt = null;
			this.#ambiguousAt = null;
			if (writeHeartbeat) await this.#writeHeartbeat();
			await this.#checkpointSessionHeartbeats();
			return;
		}
		this.#fence(observation === "ambiguous" ? "observation-ambiguous" : "suspect-unpublished");
		if (this.#fencedBeyondDeadline()) void this.#complete("lost-root");
	}
	async #writeHeartbeat(): Promise<void> {
		if (!this.discovery || !this.#publication || this.#publicationState === "stopping") return;
		const heartbeatAt = Date.now();
		try {
			if (!(await heartbeatBrokerDiscoveryRetained(this.#publication, heartbeatAt))) {
				this.#fence("heartbeat-ambiguous");
				return;
			}
		} catch {
			this.#fence("heartbeat-ambiguous");
			return;
		}
		const recovery = this.runSynchronousEffectWithFreshPublicationAuthority(() => {
			this.discovery = { ...this.discovery!, heartbeatAt };
		});
		if (!recovery.authorized) return;
	}
	async heartbeat(): Promise<void> {
		if (this.#publicationState !== "healthy-owned") return;
		await this.#writeHeartbeat();
	}

	/**
	 * Production coalesced heartbeat checkpoint seam (C2): delegates to the session
	 * index writer, which appends at most one `host_heartbeat` per session per
	 * {@link SESSION_HEARTBEAT_INTERVAL_MS} for hosts that are alive and, when recorded,
	 * still carry the same OS process incarnation. Returns the number of checkpoints
	 * written. Used by the periodic publication watch, by session reads so a fresh
	 * registration is observed as live, and by tests.
	 */
	async heartbeatSessions(now = Date.now()): Promise<number> {
		return await this.index.checkpointLiveHeartbeats(now);
	}

	async #checkpointSessionHeartbeats(): Promise<void> {
		try {
			await this.heartbeatSessions();
		} catch {
			// Best-effort observation; a failed checkpoint never fences the broker.
		}
	}
	async #compactSessionIndex(): Promise<void> {
		try {
			await this.index.compact();
		} catch {
			// Compaction is best-effort maintenance; the next scheduled pass retries.
		}
	}
	async #complete(mode: BrokerStopMode): Promise<void> {
		if (this.#completionTask) return this.#completionTask;
		this.#stopping = true;
		this.#publicationState = "stopping";
		// A lost-root broker has been fenced: it no longer owns the published root, and
		// its settlement is bounded, so any startup still queued behind it would be
		// granted after completion and spawn a child the broker has no authority over.
		// An owned-root stop keeps the queue open on purpose: the broker still owns
		// everything it admitted, and completion waits unbounded for those startups, so
		// draining would abandon work that is about to finish correctly.
		if (mode === "lost-root") this.#startupAdmissions.close();
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = null;
		if (this.#compactTimer) clearInterval(this.#compactTimer);
		this.#compactTimer = null;
		if (this.#operatorTimer) clearInterval(this.#operatorTimer);
		this.#operatorTimer = null;
		this.#completionTask = (async () => {
			await this.#transport?.stop();
			this.#transport = null;
			if (mode === "lost-root")
				await Promise.race([Promise.allSettled(this.#admitted), Bun.sleep(BROKER_SETTLEMENT_MS)]);
			else await Promise.allSettled(this.#admitted);
			this.#publication?.close();
			this.#publication = null;
			if (mode === "owned-root" && this.discovery?.ownerId === this.#owner) {
				try {
					const disk = JSON.parse(await fs.readFile(brokerDiscoveryPath(this.settings.agentDir), "utf8")) as {
						ownerId?: string;
					};
					if (disk.ownerId === this.#owner) await fs.unlink(brokerDiscoveryPath(this.settings.agentDir));
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
				}
				await this.#releaseOwnedLock();
			}
			this.discovery = null;
		})();
		void this.#completionTask.then(this.#resolveCompletion, this.#rejectCompletion);
		return this.#completionTask;
	}
	/**
	 * Fresh, uncached proof that this broker still publishes the discovery root.
	 * The cached state is not proof: the watchdog observes on a cadence, so a
	 * replacement can already be on disk without having been seen yet.
	 */
	#provenOwnedRoot(): boolean {
		if (!this.#publication || this.#publicationState !== "healthy-owned") return false;
		try {
			return (publicationObservationOverridesForTest.get(this) ?? this.#publication.observe()) === "owned";
		} catch {
			return false;
		}
	}
	/**
	 * Revalidate retained publication ownership and begin one synchronous effect in
	 * the same stack. The callback is the authority boundary: callers must perform
	 * the authorized effect inside it, so no awaited work can separate proof from
	 * the effect it authorizes.
	 */
	runSynchronousEffectWithFreshPublicationAuthority<T>(
		effect: () => T,
		..._synchronousOnly: T extends PromiseLike<unknown> ? [never] : []
	): { authorized: true; value: T } | { authorized: false } {
		if (!this.#publication || this.#publicationState === "stopping") return { authorized: false };
		let observation: BrokerPublicationObservation;
		try {
			observation = publicationObservationOverridesForTest.get(this) ?? this.#publication.observe();
		} catch {
			this.#fence("observation-ambiguous");
			if (this.#fencedBeyondDeadline()) void this.#complete("lost-root");
			return { authorized: false };
		}
		if (observation !== "owned") {
			this.#fence(observation === "ambiguous" ? "observation-ambiguous" : "suspect-unpublished");
			if (this.#fencedBeyondDeadline()) void this.#complete("lost-root");
			return { authorized: false };
		}
		return { authorized: true, value: effect() };
	}
	/**
	 * A stop may take the owning path only while it can prove it still owns the root.
	 * Claiming ownership it cannot prove keeps the admission queue open, so a startup
	 * queued behind this broker is granted a slot that frees after completion and
	 * spawns a child the broker has no authority over.
	 */
	async stop(): Promise<void> {
		await this.#complete(this.#provenOwnedRoot() ? "owned-root" : "lost-root");
	}
	async #endpoint(input: Record<string, unknown>): Promise<BrokerResponse> {
		const sessionId = input.sessionId;
		if (typeof sessionId !== "string" || !isCanonicalSessionId(sessionId))
			return error("invalid_input", "sessionId must be a canonical safe identifier");
		const authority = expectedEndpointAuthority(input);
		if ("ok" in authority) return authority;
		await this.index.refresh();
		await this.heartbeatSessions();
		const record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (!record) return error("resource_gone", "session is not indexed");
		// C6: a cross-repo duplicate cannot resolve an endpoint credential; require
		// disambiguation before any credential is minted.
		if (record.ambiguous) return error("ambiguous_session", "session id maps to more than one state root");
		if (!record.live || !matchesEndpointAuthority(record, authority))
			return error("endpoint_stale", "session endpoint is stale");
		return this.#readEndpoint(record, authority);
	}
	async #readEndpoint(record: IndexedSession, authority: EndpointAuthority): Promise<BrokerResponse> {
		if (!isCanonicalSessionId(record.sessionId))
			return error("invalid_input", "indexed sessionId is not a canonical safe identifier");

		try {
			const endpointPath = path.join(record.locator.stateRoot, "sdk", `${record.sessionId}.json`);
			const [source, metadata] = await Promise.all([fs.readFile(endpointPath, "utf8"), fs.stat(endpointPath)]);
			const endpoint = JSON.parse(source) as Record<string, unknown>;
			if (
				endpoint.sessionId !== record.sessionId ||
				endpoint.pid !== record.pid ||
				endpoint.stale === true ||
				record.endpointMtimeMs === undefined ||
				metadata.mtimeMs !== record.endpointMtimeMs
			)
				return error("endpoint_stale", "session endpoint is stale");
			await this.index.refresh();
			const current = this.index.listSessions().sessions.find(session => session.sessionId === record.sessionId);
			if (!current || !sameEndpointRecord(record, current) || !matchesEndpointAuthority(current, authority))
				return error("endpoint_stale", "session endpoint is stale");
			return { ok: true, result: endpoint };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT")
				return error("resource_gone", "session endpoint record is gone");
			throw e;
		}
	}
	#storeSessionListCursor(cursor: SessionListCursor, replacingToken?: string): string | BrokerResponse {
		const now = Date.now();
		for (const [token, stored] of this.#sessionListCursors) {
			if (stored.expiresAt <= now) this.#sessionListCursors.delete(token);
		}
		const replacing = replacingToken !== undefined && this.#sessionListCursors.has(replacingToken);
		if (!replacing && this.#sessionListCursors.size >= SESSION_LIST_MAX_CURSORS)
			return error("invalid_input", "session.list cursor capacity is exhausted");
		const token = randomBytes(24).toString("base64url");
		if (replacingToken !== undefined) this.#sessionListCursors.delete(replacingToken);
		this.#sessionListCursors.set(token, cursor);
		return token;
	}

	#sessionListPage(input: Record<string, unknown>, result: SessionList): BrokerResponse {
		const requestedLimit = input.limit === undefined ? undefined : sessionListLimit(input);
		if (isBrokerResponse(requestedLimit)) return requestedLimit;
		const cursor = input.cursor;
		const stored = typeof cursor === "string" ? this.#sessionListCursors.get(cursor) : undefined;
		if (cursor !== undefined && (!stored || stored.expiresAt <= Date.now())) {
			if (typeof cursor === "string") this.#sessionListCursors.delete(cursor);
			return error("invalid_input", "cursor is expired or invalid");
		}
		if (stored && requestedLimit !== undefined && stored.limit !== requestedLimit)
			return error("invalid_input", "limit must match the cursor page shape");
		const limit = stored?.limit ?? requestedLimit ?? SESSION_LIST_DEFAULT_LIMIT;
		const snapshot = stored ?? {
			sessions: [...result.sessions],
			indexSeq: result.indexSeq,
			warnings: [...result.warnings],
			limit,
			offset: 0,
			expiresAt: Date.now() + SESSION_LIST_CURSOR_TTL_MS,
		};
		const sessions = snapshot.sessions.slice(snapshot.offset, snapshot.offset + snapshot.limit);
		const offset = snapshot.offset + sessions.length;
		if (offset >= snapshot.sessions.length && typeof cursor === "string") this.#sessionListCursors.delete(cursor);
		const continuationCursor =
			offset >= snapshot.sessions.length
				? undefined
				: this.#storeSessionListCursor(
						{ ...snapshot, offset, expiresAt: Date.now() + SESSION_LIST_CURSOR_TTL_MS },
						typeof cursor === "string" ? cursor : undefined,
					);
		if (isBrokerResponse(continuationCursor)) return continuationCursor;
		return {
			ok: true,
			result: {
				indexSeq: snapshot.indexSeq,
				sessions,
				warnings: snapshot.warnings,
				...(continuationCursor ? { continuationCursor } : {}),
			},
			indexSeq: snapshot.indexSeq,
		};
	}
	handleRequest(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
		elevationRequestId?: string,
	): Promise<BrokerResponse> {
		if (this.#stopping || (this.#publication !== null && this.#publicationState !== "healthy-owned"))
			return Promise.resolve(error("unavailable", "broker publication is unavailable"));
		let release!: () => void;
		const admission = new Promise<void>(resolve => (release = resolve));
		this.#admitted.add(admission);
		return this.#handleRequest(operation, input, idempotencyKey, elevationRequestId).finally(() => {
			release();
			this.#admitted.delete(admission);
		});
	}
	async #handleRequest(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
		elevationRequestId?: string,
	): Promise<BrokerResponse> {
		if (this.#stopping) return error("broker_restarting", "broker is stopping");
		const normalization = normalizeBrokerInput(operation, input);
		if (isBrokerResponse(normalization)) return normalization;
		const approvedInput = input;
		input = normalization.input;
		if (operation === "session.list") {
			if (input.cursor === undefined) {
				await this.index.refresh();
				// Self-healing heartbeat checkpoint (C2): a host registered since the
				// broker's last pass is observed as live on this read, so a fresh
				// registration never reads as unknown (while a restart still does).
				await this.heartbeatSessions();
			}
			const page = this.#sessionListPage(input, this.index.listSessions());
			if (!page.ok) return page;
			const pageResult = page.result as Record<string, unknown>;
			const resolveSessionId = typeof input.resolveSessionId === "string" ? input.resolveSessionId : undefined;
			const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
			if (resolveSessionId && cwd) {
				const scope = await resolveManagedSessionScope({ cwd, agentDir: this.settings.agentDir });
				const listed =
					scope.kind === "resolved" ? await listManagedSessionCandidates({ scope: scope.scope }) : undefined;
				const matches =
					listed?.kind === "complete"
						? listed.owned.filter(candidate => candidate.sessionId === resolveSessionId)
						: [];
				const match = matches.length === 1 ? matches[0] : undefined;
				return {
					...page,
					result: {
						...pageResult,
						savedSession:
							match && match.sessionId === resolveSessionId
								? { id: match.sessionId, path: match.path }
								: undefined,
					},
				};
			}
			return page;
		}
		if (operation === "session.get_endpoint") return this.#endpoint(input);
		if (operation === "elevation.issue") return this.#elevationIssueRequest(input);
		if (operation === "elevation.status") return this.#elevationStatusRequest(input);
		if (operation === "session.control") return this.#sessionControlRequest(input);
		if (!idempotencyKey) return error("invalid_input", "idempotencyKey is required for lifecycle operations");
		// Elevation gate (F1.3): allowlisted raw operations execute only behind a
		// broker-owned single-use grant. Validation is fail-closed and happens
		// before any lifecycle ledger write; the claim itself is consumed right
		// before dispatch and the truthful outcome is recorded after it.
		const elevationGateKind = this.#elevationGateFor(operation);
		let elevationRequestIdForDispatch: string | undefined;
		if (elevationGateKind !== undefined) {
			if (elevationRequestId === undefined)
				return error("elevation_required", "an elevation grant claim is required for this operation");
			if (!isElevationRequestId(elevationRequestId))
				return error("invalid_input", "elevationRequestId must be an RFC4122 lowercase UUID v4");
			const resolved = await this.elevation.get(elevationRequestId);
			if (!resolved.ok) {
				if (resolved.error.code === "not_found")
					return error(
						"elevation_required",
						"elevation grant was not found; a grant is required for this operation",
					);
				return elevationResultToBroker(resolved);
			}
			const grant = resolved.value.grant;
			if (grant.operation.kind !== elevationGateKind || grant.operation.sdkId !== operation)
				return error("elevation_digest_mismatch", "elevation grant was issued for a different operation");
			const digest = elevationRequestDigest({ kind: elevationGateKind, sdkId: operation, input: approvedInput });
			if (!digest.ok || digest.digest !== grant.requestDigest)
				return error("elevation_digest_mismatch", "elevation grant digest does not match the dispatched input");
			// Bind the grant to the actual lifecycle target before any claim: the
			// approved input must resolve to the exact session identity the grant
			// was issued against (C10). session.delete may target a retained
			// stopped session; everything else requires a live endpoint.
			const targetSessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
			if (targetSessionId !== undefined) {
				const target = await this.#elevationSessionResolution(targetSessionId, {
					allowStopped: operation === "session.delete",
				});
				if (target.kind === "ambiguous")
					return error("ambiguous_session", "session id maps to more than one state root");
				if (target.kind !== "identity")
					return error("target_unavailable", "session endpoint is unreachable or its identity is not provable");
				if (grant.sessionIdentity.sessionId !== target.identity.sessionId)
					return error("elevation_digest_mismatch", "elevation grant was issued for a different session target");
				if (!sameElevationSessionIdentity(grant.sessionIdentity, target.identity))
					return error("endpoint_stale", "session endpoint identity no longer matches the elevation grant");
			}
			elevationRequestIdForDispatch = elevationRequestId;
		}
		const target = createHash("sha256")
			.update(canonicalJson(lifecycleTarget(operation, input)))
			.digest("hex");
		const identity = await deriveIdempotencyIdentity(this.settings.agentDir, operation, idempotencyKey, target);
		let reconstructedDeleteCleanup: BrokerCleanupEvidence | undefined;
		if (operation === "session.delete" && input.cwd === undefined && input.sessionPath === undefined) {
			const entry = this.ledger.get(identity);
			const cleanup = cleanupFromResponse(entry?.response) ?? cleanupFromResponse(entry?.unresolvedCleanupResponse);
			reconstructedDeleteCleanup = cleanup;
			const requestedSessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
			if (!cleanup) {
				if (requestedSessionId && this.ledger.hasUncertainCleanupForSession(requestedSessionId, identity))
					return error(
						"terminal_uncertain",
						"Session cleanup authority is uncertain and cannot be deleted safely",
					);
				const pending = requestedSessionId
					? this.ledger.findCleanupPendingBySessionId(requestedSessionId, identity)
					: undefined;
				if (pending) {
					const pendingResponse = cleanupFromResponse(pending.response)
						? pending.response
						: pending.unresolvedCleanupResponse;
					if (isBrokerResponse(pendingResponse)) return pendingResponse;
					return error(
						"terminal_uncertain",
						"Session cleanup authority is pending under another lifecycle identity",
					);
				}
				if (entry) {
					if (isBrokerResponse(entry.response)) return entry.response;
					return error("terminal_uncertain", "Existing session.delete ledger evidence lacks replayable authority");
				}
				if (requestedSessionId) {
					await this.index.refresh();
					if (this.index.listSessions().sessions.some(session => session.sessionId === requestedSessionId))
						return error(
							"terminal_uncertain",
							"Indexed session requires durable locator authority before deletion",
						);
				}
				return { ok: true, result: requestedSessionId ? { sessionId: requestedSessionId } : undefined };
			}
			if (
				cleanup &&
				cleanup.sessionId === requestedSessionId &&
				typeof cleanup.cwd === "string" &&
				typeof cleanup.transcriptPath === "string"
			)
				input = {
					sessionId: cleanup.sessionId,
					cwd: cleanup.cwd,
					stateRoot: path.join(cleanup.cwd, ".gjc", "state"),
					sessionPath: cleanup.transcriptPath,
				};
		}
		const storedRequestHash = reconstructedDeleteCleanup ? this.ledger.get(identity)?.requestHash : undefined;
		const requestHash =
			storedRequestHash ?? createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
		const prev = this.#chains.get(target) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => (release = resolve));
		this.#chains.set(
			target,
			prev.then(() => current),
		);
		await prev;
		try {
			const beforeBegin = this.ledger.get(identity);
			const begun = await this.ledger.begin(identity, requestHash);
			if (begun.kind === "replay") {
				const replay = begun.entry.response as BrokerResponse;
				const cleanup = cleanupFromResponse(replay) ?? reconstructedDeleteCleanup;
				if (!cleanup) return replay;
				const outcome = await executeLifecycle(this, operation, input, identity, cleanup);
				const response = outcome.response;
				await this.ledger.transition(identity, lifecycleResponseState(response), {
					response,
					responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return response;
			}
			if (begun.kind === "idempotency_conflict")
				return error("idempotency_conflict", "idempotency key was used with a different request");
			if (begun.kind === "terminal_uncertain") {
				const replay = (begun.entry.response ?? beforeBegin?.response) as BrokerResponse | undefined;
				const cleanup = (replay ? cleanupFromResponse(replay) : undefined) ?? reconstructedDeleteCleanup;
				if (!cleanup)
					return replay ?? error("terminal_uncertain", "prior lifecycle operation outcome is uncertain");
				const outcome = await executeLifecycle(this, operation, input, identity, cleanup);
				const response = outcome.response;
				await this.ledger.transition(identity, lifecycleResponseState(response), {
					...(pendingCleanupSessionId(response) ? { intendedSessionId: pendingCleanupSessionId(response) } : {}),
					response,
					responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return response;
			}
			if (begun.kind === "in_progress") return error("broker_restarting", "lifecycle operation is in progress");
			// Single-use grant claim (F1.3): consume the grant before any dispatch.
			// A claimed grant that crashes before outcome recording is replayed
			// truthfully as consumed/uncertain; retry requires a new grant.
			if (elevationRequestIdForDispatch !== undefined) {
				const claimed = await this.elevationClaim({ elevationRequestId: elevationRequestIdForDispatch });
				if (!claimed.ok) return claimed;
			}
			let outcome: Awaited<ReturnType<typeof executeLifecycle>>;
			try {
				outcome = await executeLifecycle(this, operation, input, identity);
			} catch (cause) {
				if (elevationRequestIdForDispatch !== undefined)
					await this.elevationDispatch({
						elevationRequestId: elevationRequestIdForDispatch,
						outcome: {
							status: "failed",
							code: "unavailable",
							message: cause instanceof Error ? cause.message : String(cause),
							dispatchedAt: Date.now(),
						},
					});
				throw cause;
			}
			const response = outcome.response;
			// Record the truthful dispatch outcome for the claimed grant.
			if (elevationRequestIdForDispatch !== undefined) {
				const dispatchedAt = Date.now();
				const recorded = await this.elevationDispatch({
					elevationRequestId: elevationRequestIdForDispatch,
					outcome: response.ok
						? { status: "ok", dispatchedAt }
						: {
								status: "failed",
								code: response.error.code,
								message: response.error.message,
								dispatchedAt,
							},
				});
				if (!recorded.ok) return recorded;
			}
			await this.ledger.transition(identity, lifecycleResponseState(response), {
				...(pendingCleanupSessionId(response) ? { intendedSessionId: pendingCleanupSessionId(response) } : {}),
				resultSessionId:
					response.ok && typeof (response.result as { sessionId?: unknown } | undefined)?.sessionId === "string"
						? (response.result as { sessionId: string }).sessionId
						: undefined,
				response,
				responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
				...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
				...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
			});
			if (isCleanupPending(response)) return response;
			const persisted = await this.ledger.readTerminal(identity, requestHash);
			const persistenceVerified =
				persisted !== undefined &&
				canonicalJson(persisted.response) === canonicalJson(response) &&
				canonicalJson(persisted.durableEffects) === canonicalJson(outcome.durableEffects) &&
				canonicalJson(persisted.startupFailure) === canonicalJson(outcome.startupFailure);
			if (!persistenceVerified) {
				const uncertain = error(
					"terminal_uncertain",
					"Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
				);
				await this.ledger.transition(identity, "terminal_uncertain", {
					response: uncertain,
					responseDigest: createHash("sha256").update(canonicalJson(uncertain)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return uncertain;
			}
			terminalPersistenceHooksForTest.get(this)?.();
			await outcome.deferredArtifactCleanup?.();
			return response;
		} finally {
			release();
			if (this.#chains.get(target) === current) this.#chains.delete(target);
		}
	}

	#elevationGateFor(operation: string): "global" | undefined {
		return this.#elevationEnforced && isElevatableOperation("global", operation) ? "global" : undefined;
	}

	async #elevationIssueRequest(input: Record<string, unknown>): Promise<BrokerResponse> {
		const sessionId = input.sessionId;
		if (typeof sessionId !== "string" || !isCanonicalSessionId(sessionId))
			return error("invalid_input", "sessionId must be a canonical safe identifier");
		const rawOperation = input.operation;
		if (typeof rawOperation !== "object" || rawOperation === null || Array.isArray(rawOperation))
			return error("invalid_input", "operation must be an object with kind and sdkId");
		const { kind, sdkId } = rawOperation as { kind?: unknown; sdkId?: unknown };
		if (
			typeof kind !== "string" ||
			(kind !== "control" && kind !== "query" && kind !== "global") ||
			typeof sdkId !== "string" ||
			!findOperation(kind, sdkId)
		)
			return error("invalid_request", `unknown elevation operation: ${String(kind)}:${String(sdkId)}`);
		if (!isElevatableOperation(kind, sdkId))
			return error("elevation_not_allowlisted", `${sdkId} does not require elevation`);
		const approved = input.input;
		if (typeof approved !== "object" || approved === null || Array.isArray(approved))
			return error("invalid_input", "input must be the approved operation arguments");
		if (containsReservedKey(approved, "elevationRequestId"))
			return error(
				"invalid_input",
				"elevationRequestId is reserved and cannot appear inside the approved operation input",
			);
		if (input.idempotencyKey !== undefined)
			return error(
				"invalid_input",
				"idempotencyKey is broker-frame metadata and cannot appear inside elevation.issue input",
			);
		const elevationRequestId = input.elevationRequestId;
		if (elevationRequestId !== undefined && !isElevationRequestId(elevationRequestId))
			return error("invalid_input", "elevationRequestId must be an RFC4122 lowercase UUID v4");
		const expiresInMs = input.expiresInMs;
		if (
			expiresInMs !== undefined &&
			(typeof expiresInMs !== "number" || !Number.isSafeInteger(expiresInMs) || expiresInMs <= 0)
		)
			return error("invalid_input", "expiresInMs must be a positive safe integer");
		let requester: ElevationRequester;
		if (input.requester === undefined) {
			requester = { source: "broker_connection", connectionId: `broker:${this.#owner}` };
		} else {
			const candidate = input.requester as { source?: unknown; connectionId?: unknown };
			if (
				candidate?.source !== "broker_connection" ||
				typeof candidate.connectionId !== "string" ||
				candidate.connectionId.length === 0
			)
				return error("invalid_input", "requester must be a broker_connection audit identity");
			requester = { source: "broker_connection", connectionId: candidate.connectionId };
		}
		return await this.elevationIssue({
			sessionId,
			operation: { kind, sdkId },
			input: approved as Record<string, unknown>,
			requester,
			...(elevationRequestId === undefined ? {} : { elevationRequestId }),
			...(expiresInMs === undefined ? {} : { expiresInMs }),
		});
	}

	async #elevationStatusRequest(input: Record<string, unknown>): Promise<BrokerResponse> {
		const elevationRequestId = input.elevationRequestId;
		if (typeof elevationRequestId !== "string" || !isElevationRequestId(elevationRequestId))
			return error("invalid_input", "elevationRequestId must be an RFC4122 lowercase UUID v4");
		return await this.elevationResolve(elevationRequestId);
	}

	#elevationClaimIdentity(): ElevationClaimIdentity {
		const incarnation = this.#incarnation;
		if (incarnation === null) throw new Error("Broker process incarnation is unavailable.");
		return { ownerId: this.#owner, epoch: this.#epoch, pid: process.pid, incarnation };
	}
	async #elevationPrincipal(): Promise<BrokerOwnerPrincipal> {
		const incarnation = this.#incarnation;
		if (incarnation === null) throw new Error("Broker process incarnation is unavailable.");
		return readBrokerOwnerPrincipal(this.settings.agentDir, process.pid, incarnation);
	}
	/**
	 * Resolves the exact elevation session identity (C6/C10). A cross-repo
	 * duplicate (`ambiguous`) is rejected before any endpoint credential or
	 * elevation grant can bind; an unreachable or unprovable session is
	 * `unavailable`. The heartbeat checkpoint pass runs first so a fresh
	 * registration is observable as live.
	 *
	 * `allowStopped` is the session.delete-only exemption: a retained stopped
	 * session keeps its exact endpoint identity tuple (generation/pid/mtime)
	 * in the index row, so a delete grant can still be bound and dispatched
	 * against it. Everything else fails closed unless the endpoint is live.
	 */
	async #elevationSessionResolution(
		sessionId: string,
		options?: { allowStopped?: boolean },
	): Promise<ElevationSessionResolution> {
		if (!isCanonicalSessionId(sessionId)) return { kind: "unavailable" };
		await this.index.refresh();
		await this.heartbeatSessions();
		const record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (!record) return { kind: "unavailable" };
		if (record.ambiguous) return { kind: "ambiguous" };
		if (!record.live && options?.allowStopped !== true) return { kind: "unavailable" };
		const incarnation = endpointIncarnation(record, sessionId);
		if (incarnation === undefined) return { kind: "unavailable" };
		return {
			kind: "identity",
			identity: {
				sessionId: record.sessionId,
				endpointStateRoot: record.locator.stateRoot,
				endpointGeneration: record.endpointGeneration,
				endpointIncarnation: incarnation,
			},
		};
	}

	async #pollOperatorDirectives(): Promise<void> {
		const directory = path.join(this.settings.agentDir, "sdk", "elevation", "operator");
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(directory, name);
			try {
				const stat = await fs.stat(file);
				if ((stat.mode & 0o077) !== 0) throw new Error("operator directive is not private");
				const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed operator directive");
				const directive = raw as Record<string, unknown>;
				if (
					typeof directive.elevationRequestId !== "string" ||
					(directive.answer !== "approve" && directive.answer !== "deny") ||
					typeof directive.presentedDigest !== "string"
				)
					throw new Error("malformed operator directive");
				const response = await this.elevationAnswer({
					elevationRequestId: directive.elevationRequestId,
					answer: directive.answer,
					presentedDigest: directive.presentedDigest,
					answerer: { source: "local_operator", attestedBy: "gjc-sdk-session-cli" },
				});
				if (!response.ok) throw new Error(response.error.message);
				await fs.rm(file, { force: true });
			} catch {
				await fs.rename(file, `${file}.rejected`).catch(() => undefined);
			}
		}
	}

	async #sessionControlRequest(input: Record<string, unknown>): Promise<BrokerResponse> {
		const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
		const operation = typeof input.operation === "string" ? input.operation : undefined;
		const rawInput = input.input;
		const controlInput =
			rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
				? (rawInput as Record<string, unknown>)
				: undefined;
		if (!sessionId || !operation || !controlInput || !findOperation("control", operation))
			return error(
				"invalid_input",
				"session.control requires a valid sessionId, control operation, and object input",
			);
		const elevationRequestId = typeof input.elevationRequestId === "string" ? input.elevationRequestId : undefined;
		const elevatable = this.#elevationEnforced && isElevatableOperation("control", operation);
		// Elevation preflight (F1.3) runs before any clientRef reservation so a
		// no-grant attempt can never poison a later granted retry with a stale
		// pending receipt.
		let grant: ElevationGrantRecord | undefined;
		if (elevatable) {
			if (!elevationRequestId) return error("elevation_required", "an elevation grant is required for this control");
			const resolved = await this.elevation.get(elevationRequestId);
			if (!resolved.ok) return elevationResultToBroker(resolved);
			grant = resolved.value.grant;
			const digest = elevationRequestDigest({ kind: "control", sdkId: operation, input: controlInput });
			if (
				grant.operation.kind !== "control" ||
				grant.operation.sdkId !== operation ||
				!digest.ok ||
				digest.digest !== grant.requestDigest
			)
				return error("elevation_digest_mismatch", "elevation grant does not match the requested control");
		}
		await this.index.refresh();
		const matches = this.index.listSessions().sessions.filter(session => session.sessionId === sessionId);
		if (matches.some(session => session.ambiguous) || matches.length > 1)
			return error("ambiguous_session", "session id maps to more than one state root");
		const record = matches[0];
		if (!record?.live) return error("target_unavailable", "session endpoint is unavailable");
		const incarnation = endpointIncarnation(record, sessionId);
		if (!incarnation) return error("endpoint_stale", "session endpoint incarnation is unavailable");
		// Bind the grant to the actual approved target session identity before
		// claim/capability minting: a grant issued for a different session can
		// never authorize this control, even with byte-identical input.
		if (grant !== undefined) {
			if (grant.sessionIdentity.sessionId !== record.sessionId)
				return error("elevation_digest_mismatch", "elevation grant was issued for a different session target");
			const targetIdentity: ElevationSessionIdentity = {
				sessionId: record.sessionId,
				endpointStateRoot: record.locator.stateRoot,
				endpointGeneration: record.endpointGeneration,
				endpointIncarnation: incarnation,
			};
			if (!sameElevationSessionIdentity(grant.sessionIdentity, targetIdentity))
				return error("endpoint_stale", "session endpoint identity no longer matches the elevation grant");
		}
		const clientRef =
			typeof controlInput.clientRef === "string" && controlInput.clientRef.length > 0
				? controlInput.clientRef
				: undefined;
		// clientRef idempotency is target-session scoped: identical refs and
		// input on different sessions never collide, conflict, or replay.
		const receiptKey = clientRef === undefined ? undefined : operationReceiptKey(sessionId, clientRef);
		const receiptDigest =
			clientRef === undefined ? undefined : operationReceiptDigest(operation, controlInput, sessionId);
		if (receiptKey !== undefined && receiptDigest !== undefined) {
			const reservation = await this.operationReceipts.reserve(receiptKey, receiptDigest);
			if (reservation.status === "replay") return reservation.response;
			if (reservation.status === "in_progress")
				return error("operation_in_progress", "operation receipt is pending");
			if (reservation.status === "conflict")
				return error("idempotency_conflict", "clientRef was reused with different operation input");
		}
		const settle = async (response: BrokerResponse): Promise<BrokerResponse> => {
			if (receiptKey !== undefined && receiptDigest !== undefined)
				await this.operationReceipts.complete(receiptKey, receiptDigest, response);
			return response;
		};
		const endpointResponse = await this.#endpoint({
			sessionId,
			endpointGeneration: record.endpointGeneration,
			endpointIncarnation: incarnation,
		});
		if (!endpointResponse.ok) return settle(endpointResponse);
		const endpoint = endpointResponse.result as { url?: unknown; token?: unknown };
		if (typeof endpoint.url !== "string" || typeof endpoint.token !== "string")
			return settle(error("unavailable", "session endpoint is malformed"));
		let elevationCapability: string | undefined;
		if (elevatable && elevationRequestId) {
			let authorityToken: string | undefined;
			try {
				const authority = JSON.parse(
					await fs.readFile(elevationAuthorityPath(record.locator.stateRoot, sessionId), "utf8"),
				) as { token?: unknown };
				authorityToken = typeof authority.token === "string" ? authority.token : undefined;
			} catch {
				return settle(error("unavailable", "session elevation authority is unavailable"));
			}
			if (!authorityToken) return settle(error("unavailable", "session elevation authority is malformed"));
			const claimed = await this.elevationClaim({ elevationRequestId });
			if (!claimed.ok) return settle(claimed);
			elevationCapability = signElevationCapability(authorityToken, elevationRequestId, operation, controlInput);
		}
		let client: SdkClient | undefined;
		try {
			client = await SdkClient.connect(endpoint.url, endpoint.token);
			const response = await client.control(operation, controlInput, {
				confirm: input.confirm === true,
				...(elevationCapability === undefined ? {} : { elevationRequestId: elevationCapability }),
			});
			const ok = (response as { ok?: unknown }).ok === true;
			if (elevatable && elevationRequestId) {
				await this.elevationDispatch({
					elevationRequestId,
					outcome: ok
						? { status: "ok", dispatchedAt: Date.now() }
						: {
								status: "failed",
								code: String((response as { error?: { code?: unknown } }).error?.code ?? "control_failed"),
								message: String(
									(response as { error?: { message?: unknown } }).error?.message ?? "control failed",
								),
								dispatchedAt: Date.now(),
							},
				});
			}
			const brokerResponse = ok
				? { ok: true as const, result: (response as { result?: unknown }).result }
				: error(
						String((response as { error?: { code?: unknown } }).error?.code ?? "unavailable"),
						String((response as { error?: { message?: unknown } }).error?.message ?? "control failed"),
					);
			return settle(brokerResponse);
		} catch (cause) {
			if (elevatable && elevationRequestId)
				await this.elevationDispatch({
					elevationRequestId,
					outcome: {
						status: "failed",
						code: "unavailable",
						message: cause instanceof Error ? cause.message : String(cause),
						dispatchedAt: Date.now(),
					},
				});
			return settle(
				cause instanceof SdkClientError
					? error(cause.code, cause.message)
					: error("unavailable", cause instanceof Error ? cause.message : String(cause)),
			);
		} finally {
			await client?.close();
		}
	}
	/**
	 * Elevation issuance (internal). Binds the exact endpoint identity
	 * (endpointStateRoot/generation/incarnation) from the live index record;
	 * the request digest is broker-computed from the full `{kind,sdkId,input}`
	 * triple with the top-level `elevationRequestId` excluded.
	 */
	async elevationIssue(params: {
		sessionId: string;
		operation: ElevationOperation;
		input: Record<string, unknown>;
		requester: ElevationRequester;
		elevationRequestId?: string;
		expiresInMs?: number;
	}): Promise<BrokerResponse> {
		if (!isCanonicalSessionId(params.sessionId))
			return error("invalid_input", "sessionId must be a canonical safe identifier");
		// Retained stopped sessions may only back an elevation request for the
		// exact global lifecycle operation that needs them (session.delete); all
		// other operations still require a live endpoint (fail closed otherwise).
		const allowStopped = params.operation.kind === "global" && params.operation.sdkId === "session.delete";
		const resolution = await this.#elevationSessionResolution(params.sessionId, { allowStopped });
		if (resolution.kind === "ambiguous")
			return error("ambiguous_session", "session id maps to more than one state root");
		if (resolution.kind === "unavailable")
			return error("target_unavailable", "session endpoint is unreachable or its identity is not provable");
		// Bind the grant to the actual approved target session: the approved
		// input for a global lifecycle operation must name the elevation session
		// itself, never a different session (C10).
		if (params.operation.kind === "global") {
			const approvedTarget = typeof params.input.sessionId === "string" ? params.input.sessionId : undefined;
			if (approvedTarget !== undefined && approvedTarget !== params.sessionId)
				return error("invalid_input", "approved input targets a different session than the elevation session");
		}
		const { identity: sessionIdentity } = resolution;
		let principal: BrokerOwnerPrincipal;
		try {
			principal = await this.#elevationPrincipal();
		} catch {
			return error("unavailable", "broker owner principal is unavailable");
		}
		const result = await this.elevation.issue({ ...params, sessionIdentity, principal });
		return elevationResultToBroker(result);
	}

	/**
	 * Elevation answer (internal, operator-only). There is no public
	 * `elevation.answer` operation: this entry point is reserved for the local
	 * operator approval surface and the separately authorized gate-answer
	 * source, and the ledger enforces the distinct-answer-source boundary.
	 */
	async elevationAnswer(params: {
		elevationRequestId: string;
		answer: "approve" | "deny";
		presentedDigest: string;
		answerer: ElevationAnswerAuthority;
	}): Promise<BrokerResponse> {
		const resolved = await this.elevation.get(params.elevationRequestId);
		if (!resolved.ok) return elevationResultToBroker(resolved);
		const sessionId = resolved.value.grant.sessionIdentity.sessionId;
		const grantOperation = resolved.value.grant.operation;
		const resolution = await this.#elevationSessionResolution(sessionId, {
			allowStopped: grantOperation.kind === "global" && grantOperation.sdkId === "session.delete",
		});
		if (resolution.kind === "ambiguous")
			return error("ambiguous_session", "session id maps to more than one state root");
		const currentSessionIdentity = resolution.kind === "identity" ? resolution.identity : undefined;
		let principal: BrokerOwnerPrincipal;
		try {
			principal = await this.#elevationPrincipal();
		} catch {
			return error("unavailable", "broker owner principal is unavailable");
		}
		const result = await this.elevation.answer({ ...params, principal, currentSessionIdentity });
		return elevationAnswerToBroker(result);
	}

	/** Single-use grant claim (internal): consumes the grant before dispatch. */
	async elevationClaim(params: { elevationRequestId: string }): Promise<BrokerResponse> {
		const resolved = await this.elevation.get(params.elevationRequestId);
		if (!resolved.ok) return elevationResultToBroker(resolved);
		const sessionId = resolved.value.grant.sessionIdentity.sessionId;
		const grantOperation = resolved.value.grant.operation;
		const resolution = await this.#elevationSessionResolution(sessionId, {
			allowStopped: grantOperation.kind === "global" && grantOperation.sdkId === "session.delete",
		});
		if (resolution.kind === "ambiguous")
			return error("ambiguous_session", "session id maps to more than one state root");
		const currentSessionIdentity = resolution.kind === "identity" ? resolution.identity : undefined;
		let claimIdentity: ElevationClaimIdentity;
		try {
			claimIdentity = this.#elevationClaimIdentity();
		} catch {
			return error("unavailable", "broker process incarnation is unavailable");
		}
		const result = await this.elevation.claim({
			elevationRequestId: params.elevationRequestId,
			claimIdentity,
			currentSessionIdentity,
		});
		return elevationResultToBroker(result);
	}

	/** Records the dispatch outcome for a claimed grant (internal). */
	async elevationDispatch(params: {
		elevationRequestId: string;
		outcome: ElevationDispatchOutcome;
	}): Promise<BrokerResponse> {
		let dispatchIdentity: ElevationClaimIdentity;
		try {
			dispatchIdentity = this.#elevationClaimIdentity();
		} catch {
			return error("unavailable", "broker process incarnation is unavailable");
		}
		const result = await this.elevation.dispatch({
			elevationRequestId: params.elevationRequestId,
			dispatchIdentity,
			outcome: params.outcome,
		});
		return elevationResultToBroker(result);
	}

	/** Truthful elevation status read (internal; reconciles expiry and crash state). */
	async elevationResolve(elevationRequestId: string): Promise<BrokerResponse> {
		let claimIdentity: ElevationClaimIdentity;
		try {
			claimIdentity = this.#elevationClaimIdentity();
		} catch {
			return error("unavailable", "broker process incarnation is unavailable");
		}
		const result = await this.elevation.resolve(elevationRequestId, claimIdentity);
		return elevationResultToBroker(result);
	}

	/** Truthful elevation listing (internal). */
	async elevationList(): Promise<BrokerResponse> {
		let claimIdentity: ElevationClaimIdentity;
		try {
			claimIdentity = this.#elevationClaimIdentity();
		} catch {
			return error("unavailable", "broker process incarnation is unavailable");
		}
		const result = await this.elevation.list(claimIdentity);
		return elevationResultToBroker(result);
	}
}

/** Test-only hook for simulating a process crash after terminal persistence verification. */
export function setTerminalPersistenceHookForTest(broker: Broker, hook: (() => void) | undefined): void {
	if (hook) terminalPersistenceHooksForTest.set(broker, hook);
	else terminalPersistenceHooksForTest.delete(broker);
}

/** Test-only hook for shortening the bounded ambiguity deadline. */
export function setAmbiguityGraceForTest(broker: Broker, graceMs: number | undefined): void {
	if (graceMs === undefined) ambiguityGraceOverridesForTest.delete(broker);
	else ambiguityGraceOverridesForTest.set(broker, graceMs);
}

/** Test-only hook for shortening the startup lock-artifact reap bound. */
export function setLockArtifactGraceForTest(broker: Broker, graceMs: number | undefined): void {
	if (graceMs === undefined) lockArtifactGraceOverridesForTest.delete(broker);
	else lockArtifactGraceOverridesForTest.set(broker, graceMs);
}

/** Test-only hook for forcing the observation the publication watchdog sees. */
export function setPublicationObservationForTest(
	broker: Broker,
	observation: BrokerPublicationObservation | undefined,
): void {
	if (observation === undefined) publicationObservationOverridesForTest.delete(broker);
	else publicationObservationOverridesForTest.set(broker, observation);
}
