import { createHash, createHmac, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import { logger, resolveEquivalentPath } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import type { ModelProfileErrorDetails } from "../../config/model-profile-contract";
import { planLaunchWorktree } from "../../gjc-runtime/launch-worktree";
import { SdkClient, SdkClientError } from "../client";
import {
	BROKER_RUNTIME_ABORT_CAPABILITY_FIELD,
	BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD,
} from "../host/control/runtime-gate";
import { createDefaultSdkHostModelResolver, type SdkHostModelResolver } from "../host/model-pin";
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
import { matchesIndexedEndpointFile, readEndpointFile } from "./endpoint-authority";
import { deriveIdempotencyIdentity, getBrokerIdentityKey } from "./identity";
import {
	canonicalDeleteLocatorPath,
	executeLifecycle,
	isCanonicalSessionId,
	prepareSpawnChildHostLaunch,
	validateBrokerModelPresetSync,
} from "./lifecycle";
import {
	type LifecycleDurableEffectsReceipt,
	LifecycleLedger,
	type LifecycleStartupFailureReceipt,
	type LifecycleState,
} from "./lifecycle-ledger";
import { createMasterCapabilityVerifier, readEndpoint } from "./master-capability";
import { type IndexedSession, isSessionAuthorityEligible, SessionIndex, type SessionList } from "./session-index";
import {
	type ResolvedScopeV1,
	resolveScopeRequest,
	ScopeRequestValidationError,
	scopeMatchesLocator,
	scopeRequestV1,
} from "./session-scope";
import {
	type MasterCapabilityVerifier,
	type SeedDeliveryV2,
	SpawnAuthorityStore,
	type SpawnAuthorityV1,
	type SpawnClaimDecision,
	type SpawnClaimV2,
	type SpawnSubstrateFailure,
	type SpawnSubstrateProof,
	type SpawnSubstrateProvider,
} from "./spawn-authority";
import { createSpawnSubstrateProvider } from "./spawn-substrate";
import { BrokerTransport } from "./transport";

export interface BrokerSettings {
	agentDir: string;
	packageGeneration?: string;
	port?: number;
	heartbeatTtlMs?: number;
	/** Broker-owned migration policy. Client lifecycle frames cannot select it. */
	resolveDirectoryMigration?: (_cwd: string) => Promise<DirectoryMigrationPolicy>;
	/** Exact managed-substrate authority. Tests inject an in-memory provider. */
	spawnSubstrateProvider?: SpawnSubstrateProvider;
	/** Ordered Q26 host control seam; production uses exact endpoint attachments. */
	spawnPromptLayer?: SpawnPromptLayer;
	/** Live-only, host-mediated capability verifier. It retains no request input. */
	masterCapabilityVerifier?: MasterCapabilityVerifier;
	/** Grace before an orphaned spawn child closes; schema-bounded in production. */
	masterOrphanGraceMs?: number;
	/** Host model resolver override for lifecycle tests and embedders. */
	resolveModelPin?: SdkHostModelResolver;
}

type ResolvedBrokerSettings = {
	agentDir: string;
	packageGeneration: string;
	port: number;
	heartbeatTtlMs: number;
	resolveDirectoryMigration: (_cwd: string) => Promise<DirectoryMigrationPolicy>;
	masterCapabilityVerifier?: MasterCapabilityVerifier;
	spawnSubstrateProvider?: SpawnSubstrateProvider;
	spawnPromptLayer?: SpawnPromptLayer;
	masterOrphanGraceMs: number;
};
export function resolveBrokerPackageGeneration(): string {
	const v = (packageJson as { version?: unknown }).version;
	return typeof v === "string" && v.length > 0 ? v : "unknown";
}

function modelResolutionCwd(input: Record<string, unknown>): string | undefined {
	const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
	if (!cwd) return undefined;
	const target = input.target;
	if (!target || typeof target !== "object" || Array.isArray(target)) return cwd;
	const worktree = (target as Record<string, unknown>).worktree;
	if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) return cwd;
	if ((worktree as Record<string, unknown>).enabled !== true) return cwd;
	const name = (worktree as Record<string, unknown>).name;
	const planned =
		typeof name === "string" && name.length > 0
			? planLaunchWorktree(cwd, { enabled: true, detached: false, name })
			: planLaunchWorktree(cwd, { enabled: true, detached: true, name: null });
	return planned.enabled ? path.resolve(planned.worktreePath) : cwd;
}

export type BrokerErrorCode =
	| "idempotency_conflict"
	| "terminal_uncertain"
	| "broker_restarting"
	| "unavailable"
	| "endpoint_stale"
	| "resource_gone"
	| "invalid_input"
	| "spawn_failed"
	| "ready_then_exited"
	| "endpoint_unreadable"
	| "startup_admission_timeout"
	| "startup_admission_refused"
	| "readiness_timeout"
	| "worktree_preparation_timeout"
	| "dependency_preparation_timeout"
	| "worktree_in_use"
	| "incarnation_unavailable"
	| "close_refused"
	| "not_found"
	| "live_session"
	| "cleanup_pending"
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
				details?: ModelProfileErrorDetails | SpawnSubstrateFailure;
				endpoint?: "unavailable";
				cleanup?: BrokerCleanupEvidence;
			};
			indexSeq?: number;
			durableEffects?: LifecycleDurableEffectsReceipt;
			startupFailure?: LifecycleStartupFailureReceipt;
	  };
const error = (code: BrokerErrorCode, message: string): BrokerResponse => ({ ok: false, error: { code, message } });
const spawnFailureError = (failure: SpawnSubstrateFailure): BrokerResponse => ({
	ok: false,
	error: {
		code: "spawn_failed",
		message: `session.spawn substrate could not be safely established: ${failure.message}`,
		details: failure,
	},
});

function isCleanupPending(response: BrokerResponse): boolean {
	if (response.ok) return false;
	const error = (response as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return false;
	const value = error as { code?: unknown; cleanup?: unknown };
	return value.code === "cleanup_pending" && value.cleanup !== undefined;
}

function cleanupFromResponse(response: unknown): BrokerCleanupEvidence | undefined {
	if (!isBrokerResponse(response) || response.ok) return undefined;
	const error = (response as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return undefined;
	const cleanup = (error as { cleanup?: unknown }).cleanup;
	return cleanup && typeof cleanup === "object" ? (cleanup as BrokerCleanupEvidence) : undefined;
}
function pendingCleanupSessionId(response: BrokerResponse): string | undefined {
	if (response.ok) return undefined;
	const error = (response as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return undefined;
	const value = error as { code?: unknown; cleanup?: { sessionId?: unknown } };
	if (value.code !== "cleanup_pending") return undefined;
	return typeof value.cleanup?.sessionId === "string" ? value.cleanup.sessionId : undefined;
}

const LIFECYCLE_OPERATIONS = new Set([
	"session.create",
	"session.fork",
	"session.resume",
	"session.close",
	"session.delete",
	"session.reconcile_uncertain",
]);

/** Bootstrap signing material and its public candidate id authorize a launch but are not lifecycle request identity. */
function lifecycleRequestIdentity(input: Record<string, unknown>): Record<string, unknown> {
	const identity = { ...input };
	delete identity.coordinatorSidecarSigningKey;
	delete identity.coordinatorSidecarKeyId;
	return identity;
}

function lifecycleFingerprint(operation: string, input: Record<string, unknown>): string {
	return createHash("sha256")
		.update(JSON.stringify({ operation, input: lifecycleRequestIdentity(input) }))
		.digest("hex");
}
function lifecycleResponseState(response: BrokerResponse): LifecycleState {
	if (response.ok) return "terminal_ok";
	if (isCleanupPending(response)) return "effect_started";
	const error = (response as { error?: unknown }).error;
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "terminal_uncertain"
		? "terminal_uncertain"
		: "terminal_error";
}

type InputNormalization = { input: Record<string, unknown> } | BrokerResponse;

type SessionListCursor = {
	sessions: IndexedSession[];
	indexSeq: number;
	warnings: string[];
	limit: number;
	offset: number;
	expiresAt: number;
	scope?: ResolvedScopeV1;
	observedAt?: string;
};

const SESSION_LIST_DEFAULT_LIMIT = 100;
const SESSION_LIST_MAX_LIMIT = 100;
const SESSION_LIST_CURSOR_TTL_MS = 15 * 60 * 1_000;
const SESSION_LIST_MAX_CURSORS = 32;
type SpawnInFlight = {
	completion: Promise<BrokerResponse>;
	resolve: (response: BrokerResponse) => void;
	claimId?: string;
	phase?: SpawnClaimV2["state"];
};

/** Complete five-leg child endpoint pin captured at registration. */
export type SpawnHostRegistration = {
	sessionId: string;
	endpointGeneration: number;
	pid: number;
	processIncarnation: string;
	/** Workspace the child was launched into; bound so a colliding pid elsewhere cannot pass. */
	cwd: string;
	stateRoot: string;
};

export type SpawnPromptDispatch =
	| { kind: "accepted"; commandId: string; turnId: string; acceptedAt: number }
	| { kind: "pre_send_rejected" }
	| { kind: "uncertain" };

export type SpawnQ26Reconciliation = {
	status: "accepted" | "in_flight" | "terminal_ok" | "failed" | "unknown";
	clientRef?: string;
	commandId?: string;
	turnId?: string;
	acceptedAt?: number;
};

/** Q26-only host control seam. It never receives or returns durable request material. */
export interface SpawnPromptLayer {
	awaitRegistration(input: {
		childId: string;
		cwd: string;
		stateRoot: string;
	}): Promise<{ ok: true; registration: SpawnHostRegistration } | { ok: false }>;
	dispatch(input: {
		sessionId: string;
		task: string;
		clientRef: string;
		/** Endpoint identity proven at registration; implementations must not talk to another endpoint. */
		pinned: SpawnHostRegistration;
	}): Promise<SpawnPromptDispatch>;
	reconcile(input: {
		sessionId: string;
		clientRef: string;
		pinned: SpawnHostRegistration;
	}): Promise<SpawnQ26Reconciliation>;
}

type SpawnAdmissionInput = {
	task: string;
	masterCapability: string;
	ownerSessionId: string;
	attestationEpoch: string;
	cwd: string;
	modelId?: string;
	modelPreset?: string;
};

function parseSpawnInput(
	input: Record<string, unknown>,
	idempotencyKey: string | undefined,
): SpawnAdmissionInput | BrokerResponse {
	if (!idempotencyKey || idempotencyKey.length > 512)
		return error("invalid_input", "idempotencyKey is required for session.spawn");
	const allowed = new Set([
		"task",
		"prompt",
		"masterCapability",
		"ownerSessionId",
		"attestationEpoch",
		"cwd",
		"modelId",
		"modelPreset",
	]);
	if (Object.keys(input).some(key => !allowed.has(key)))
		return error("invalid_input", "session.spawn input is invalid");
	const task = input.task ?? input.prompt;
	if (
		typeof task !== "string" ||
		task.length === 0 ||
		task.length > 1_000_000 ||
		(input.task !== undefined && input.prompt !== undefined && input.task !== input.prompt)
	)
		return error("invalid_input", "session.spawn task is invalid");
	if (
		typeof input.masterCapability !== "string" ||
		input.masterCapability.length === 0 ||
		input.masterCapability.length > 16_384
	)
		return error("invalid_input", "session.spawn capability is invalid");
	if (
		typeof input.ownerSessionId !== "string" ||
		!isCanonicalSessionId(input.ownerSessionId) ||
		typeof input.attestationEpoch !== "string" ||
		input.attestationEpoch.length === 0 ||
		input.attestationEpoch.length > 512 ||
		typeof input.cwd !== "string" ||
		input.cwd.length === 0 ||
		(input.modelId !== undefined && (typeof input.modelId !== "string" || input.modelId.trim().length === 0)) ||
		(input.modelPreset !== undefined && (typeof input.modelPreset !== "string" || input.modelPreset.length === 0))
	)
		return error("invalid_input", "session.spawn input is invalid");
	return {
		task,
		masterCapability: input.masterCapability,
		ownerSessionId: input.ownerSessionId,
		attestationEpoch: input.attestationEpoch,
		cwd: path.resolve(input.cwd),
		...(typeof input.modelId === "string" ? { modelId: input.modelId.trim() } : {}),
		...(typeof input.modelPreset === "string" ? { modelPreset: input.modelPreset } : {}),
	};
}

function spawnBindingMac(
	key: string,
	admission: Pick<SpawnAdmissionInput, "ownerSessionId" | "attestationEpoch" | "cwd">,
	modelId: string | null,
	modelPreset: string | null,
): string {
	return createHmac("sha256", Buffer.from(key, "hex"))
		.update(
			canonicalJson({
				version: 1,
				operation: "session.spawn",
				ownerSessionId: admission.ownerSessionId,
				attestationEpoch: admission.attestationEpoch,
				cwd: admission.cwd,
				modelId,
				modelPreset,
			}),
		)
		.digest("hex");
}

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

const SPAWN_HOST_REGISTRATION_TIMEOUT_MS = 10_000;
const SPAWN_HOST_REGISTRATION_POLL_MS = 50;
const SPAWN_PROMPT_EXCHANGE_TIMEOUT_MS = 10_000;
const MASTER_ORPHAN_GRACE_DEFAULT_MS = 120_000;

/** The five legs every usable pin must carry; a partial pin is missing authority. */
type CompleteSpawnPinAuthority = SpawnAuthorityV1 & {
	endpointGeneration: number;
	endpointPid: number;
	endpointIncarnation: string;
	endpointCwd: string;
	endpointStateRoot: string;
};

/**
 * A pin is COMPLETE or it is missing authority. The fields are optional in the
 * schema so older rows still reopen, but a partially populated pin carries
 * strictly weaker evidence than the exchange assumes: generation plus pid is
 * collidable across workspaces, so a partial pin must never be usable.
 */
function isCompleteSpawnPin(authority: SpawnAuthorityV1): authority is CompleteSpawnPinAuthority {
	return (
		authority.endpointGeneration !== undefined &&
		authority.endpointPid !== undefined &&
		authority.endpointIncarnation !== undefined &&
		authority.endpointCwd !== undefined &&
		authority.endpointStateRoot !== undefined
	);
}

/**
 * Rebuilds the proven child-endpoint pin from durable authority. Returns
 * undefined for a pre-pin or partially pinned row, which recovery must treat as
 * missing authority.
 */
function spawnPinFromAuthority(authority: SpawnAuthorityV1): SpawnHostRegistration | undefined {
	// A pin is COMPLETE or it is missing authority. The fields are optional in the
	// schema so older rows still reopen, but a partially populated pin carries
	// strictly weaker evidence than the exchange assumes: generation plus pid is
	// collidable across workspaces, so a partial pin must never be usable.
	if (!isCompleteSpawnPin(authority)) return undefined;
	return {
		sessionId: authority.childId,
		endpointGeneration: authority.endpointGeneration,
		pid: authority.endpointPid,
		processIncarnation: authority.endpointIncarnation,
		cwd: authority.endpointCwd,
		stateRoot: authority.endpointStateRoot,
	};
}

/** Exact match of a live index row against a complete endpoint pin. */
function matchesSpawnPin(candidate: IndexedSession, pinned: SpawnHostRegistration): boolean {
	return (
		candidate.endpointGeneration === pinned.endpointGeneration &&
		candidate.pid === pinned.pid &&
		(candidate.hostIncarnation ?? candidate.processIncarnation) === pinned.processIncarnation &&
		resolveEquivalentPath(candidate.locator.cwd) === resolveEquivalentPath(pinned.cwd) &&
		resolveEquivalentPath(candidate.locator.stateRoot) === resolveEquivalentPath(pinned.stateRoot)
	);
}

/** Rebuilds the provider proof from durable authority facts only. */
function spawnProofFromAuthority(authority: SpawnAuthorityV1): SpawnSubstrateProof {
	return {
		substrateKind: authority.substrateKind,
		providerIdentity: authority.providerIdentity,
		...(authority.nativeSessionId === undefined ? {} : { nativeSessionId: authority.nativeSessionId }),
		...(authority.pid === undefined ? {} : { pid: authority.pid }),
		...(authority.processIncarnation === undefined ? {} : { processIncarnation: authority.processIncarnation }),
		...(authority.ownerGeneration === undefined ? {} : { ownerGeneration: authority.ownerGeneration }),
		...(authority.stateFileProof === undefined ? {} : { stateFileProof: authority.stateFileProof }),
	};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeSpawnOpaque(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function q26FromResponse(value: unknown): SpawnQ26Reconciliation {
	const outer = objectRecord(value);
	const result = objectRecord(outer?.result) ?? outer;
	const rawStatus = result?.status;
	const status =
		rawStatus === "accepted" || rawStatus === "in_flight" || rawStatus === "terminal_ok" || rawStatus === "failed"
			? rawStatus
			: "unknown";
	return {
		status,
		...(safeSpawnOpaque(result?.clientRef) ? { clientRef: result.clientRef } : {}),
		...(safeSpawnOpaque(result?.commandId) ? { commandId: result.commandId } : {}),
		...(safeSpawnOpaque(result?.turnId) ? { turnId: result.turnId } : {}),
		...(typeof result?.acceptedAt === "number" && Number.isSafeInteger(result.acceptedAt) && result.acceptedAt >= 0
			? { acceptedAt: result.acceptedAt }
			: {}),
	};
}

function promptAcceptanceFromResponse(
	value: unknown,
	clientRef: string,
): { commandId: string; turnId: string } | undefined {
	const outer = objectRecord(value);
	const result = objectRecord(outer?.result) ?? outer;
	if (
		result?.accepted !== true ||
		!safeSpawnOpaque(result.commandId) ||
		!safeSpawnOpaque(result.turnId) ||
		(result.clientRef !== undefined && result.clientRef !== clientRef)
	)
		return undefined;
	return { commandId: result.commandId, turnId: result.turnId };
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
		if (input.scope !== undefined && !scopeRequestV1(input.scope) && input.cursor === undefined)
			return error("invalid_input", "scope must be a valid ScopeRequestV1");
		return { input: normalized };
	}
	if (
		operation !== "session.create" &&
		operation !== "session.fork" &&
		operation !== "session.resume" &&
		operation !== "session.close" &&
		operation !== "session.delete" &&
		operation !== "session.reconcile_uncertain"
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

function credentialFreeLifecycleResponse(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(credentialFreeLifecycleResponse);
	if (value === null || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (
			key === BROKER_RUNTIME_ABORT_CAPABILITY_FIELD ||
			key === BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD ||
			key === "token" ||
			key === "url" ||
			(key === "endpoint" && nested !== null && typeof nested === "object")
		)
			continue;
		output[key] = credentialFreeLifecycleResponse(nested);
	}
	return output;
}

type LifecycleReplayEndpoint = {
	endpoint: Record<string, unknown>;
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs: number;
};

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
		isSessionAuthorityEligible(current) &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		(expected.endpointFileId === undefined || current.endpointFileId === expected.endpointFileId) &&
		(expected.processIncarnation === undefined || current.processIncarnation === expected.processIncarnation) &&
		(expected.hostIncarnation === undefined || current.hostIncarnation === expected.hostIncarnation) &&
		path.resolve(current.locator.cwd) === path.resolve(expected.locator.cwd) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

const BROKER_SESSION_CONTROL_FIELDS = new Set(["sessionId", "operation", "input", "confirm"]);
const BROKER_SESSION_CONTROL_ABORT_FIELDS = new Set(["mode", "scope", "operator"]);
const BROKER_SESSION_CONTROL_TIMEOUT_MS = 10_000;

type BrokerSessionControlRequest = {
	sessionId: string;
	abortInput: { mode: "terminal"; scope: "turn" | "owned"; operator: true };
};

type BrokerSessionControlAuthority = {
	record: IndexedSession;
	endpoint: Record<string, unknown>;
	endpointIdentity: {
		dev: bigint;
		ino: bigint;
		size: bigint;
		mtimeNs: bigint;
		ctimeNs: bigint;
	};
};

function brokerSessionControlRequest(input: unknown): BrokerSessionControlRequest | BrokerResponse {
	const frame = objectRecord(input);
	if (!frame) return error("invalid_input", "session.control input must be an object");
	for (const key of Object.keys(frame))
		if (!BROKER_SESSION_CONTROL_FIELDS.has(key))
			return error("invalid_input", `Unknown session.control field: ${key}`);
	if (typeof frame.sessionId !== "string" || !isCanonicalSessionId(frame.sessionId))
		return error("invalid_input", "sessionId must be a canonical safe identifier");
	if (frame.operation !== "turn.abort") return error("invalid_input", "session.control only supports turn.abort");
	if (frame.confirm !== true) return error("invalid_input", "session.control requires confirm:true");
	const abortInput = objectRecord(frame.input);
	if (!abortInput) return error("invalid_input", "session.control input must be an object");
	for (const key of Object.keys(abortInput))
		if (!BROKER_SESSION_CONTROL_ABORT_FIELDS.has(key))
			return error("invalid_input", `Unknown turn.abort terminal field: ${key}`);
	if (abortInput.mode !== "terminal") return error("invalid_input", 'turn.abort mode must be "terminal"');
	const scope = abortInput.scope === undefined ? "turn" : abortInput.scope;
	if (scope !== "turn" && scope !== "owned")
		return error("invalid_input", 'turn.abort scope must be "turn" or "owned"');
	if (abortInput.operator !== true) return error("invalid_input", "session.control requires operator:true");
	return {
		sessionId: frame.sessionId,
		abortInput: { mode: "terminal", scope, operator: true },
	};
}

function brokerControlResponse(value: unknown): BrokerResponse {
	const response = objectRecord(value);
	if (!response || typeof response.ok !== "boolean")
		return error("unavailable", "session endpoint returned an invalid control response");
	if (response.ok)
		return response.result === undefined
			? { ok: true }
			: { ok: true, result: credentialFreeLifecycleResponse(response.result) };
	const failure = objectRecord(response.error);
	const code = typeof failure?.code === "string" ? failure.code : "unavailable";
	const message = typeof failure?.message === "string" ? failure.message : "session endpoint control failed";
	return { ok: false, error: { code, message } };
}

function sameSessionControlAuthority(
	left: BrokerSessionControlAuthority,
	right: BrokerSessionControlAuthority,
): boolean {
	return (
		sameEndpointRecord(left.record, right.record) &&
		left.record.processIncarnation === right.record.processIncarnation &&
		left.record.hostIncarnation === right.record.hostIncarnation &&
		left.record.lifecycleRequestId === right.record.lifecycleRequestId &&
		endpointIncarnation(left.record, left.record.sessionId) ===
			endpointIncarnation(right.record, right.record.sessionId) &&
		left.endpoint.sessionId === right.endpoint.sessionId &&
		left.endpoint.pid === right.endpoint.pid &&
		left.endpoint.url === right.endpoint.url &&
		left.endpoint.token === right.endpoint.token &&
		left.endpointIdentity.dev === right.endpointIdentity.dev &&
		left.endpointIdentity.ino === right.endpointIdentity.ino &&
		left.endpointIdentity.size === right.endpointIdentity.size &&
		left.endpointIdentity.mtimeNs === right.endpointIdentity.mtimeNs &&
		left.endpointIdentity.ctimeNs === right.endpointIdentity.ctimeNs
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
			return { root, worktree: lifecycleWorktreeTarget(input) };
		case "session.fork":
			return {
				root,
				worktree: lifecycleWorktreeTarget(input),
				sourceSessionId: string(input.sourceSessionId, input.sourceId),
				sourceSessionPath: string(input.sourceSessionPath, input.sourcePath, input.sessionPath),
			};
		case "session.resume":
		case "session.close":
		case "session.delete":
		case "session.reconcile_uncertain":
			return { sessionId: id };
		default:
			return { operation, root, sessionId: id };
	}
}

/**
 * A lifecycle request without a worktree remains serialized by its state root.
 * Worktree launches instead serialize on the source repository plus the
 * deterministic worktree selector, so concurrent requests cannot both observe
 * an empty session index and then prepare the same checkout.
 */
function lifecycleWorktreeTarget(input: Record<string, unknown>): { name: string | null } | undefined {
	const worktree = input.worktree;
	if (worktree === undefined || worktree === false) return undefined;
	if (worktree === true) return { name: null };
	if (typeof worktree !== "object" || worktree === null || Array.isArray(worktree)) return undefined;
	const name = (worktree as Record<string, unknown>).name;
	return typeof name === "string" && name.length > 0 ? { name } : { name: null };
}

/** Test seam for lifecycle serialization identity. */
export function lifecycleTargetForTest(operation: string, input: Record<string, unknown>): unknown {
	return lifecycleTarget(operation, input);
}

const BROKER_LOCK_RECORD = "owner.json";
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
// Both deadlines above are armed by a fence, and a fence is only reachable from an
// observation that returned or an error that was thrown. Every step of the
// publication tick is IO that can do neither: the session-index lock, the retained
// heartbeat write, the host checkpoint. A tick whose awaits never settle therefore
// fences nothing, and the process stays alive holding its port and its lock while
// its published heartbeat ages past the TTL peers read it with -- and peers refuse
// to reclaim a lock whose owner pid is alive, so the deadlock is permanent (#4704).
// Liveness is proven by publishing, not by being scheduled, so this deadline runs
// from the last *successful* publication and is the only bound that survives a
// stalled tick.
const BROKER_LIVENESS_GRACE_MS = 60_000;
// The floor must still be a multiple of the peer-visible TTL: with a longer TTL
// configured, a fixed floor would terminate a broker whose published heartbeat is
// still fresh to every reader.
const BROKER_LIVENESS_TTL_MULTIPLIER = 4;
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
const livenessGraceOverridesForTest = new WeakMap<Broker, number>();
const heartbeatStallOverridesForTest = new WeakMap<Broker, PromiseWithResolvers<void>>();

export class Broker {
	readonly settings: ResolvedBrokerSettings;
	readonly index: SessionIndex;
	readonly ledger: LifecycleLedger;
	discovery: BrokerDiscovery | null = null;
	#lock: string;
	#owner = randomBytes(12).toString("hex");
	#sessionListCursors = new Map<string, SessionListCursor>();
	#chains = new Map<string, Promise<void>>();
	#spawnInFlight = new Map<string, SpawnInFlight>();
	#spawnTasks = new WeakMap<SpawnInFlight, string>();
	#spawnAuthority: SpawnAuthorityStore | null = null;
	#spawnPromptLayer: SpawnPromptLayer;
	#spawnReapInFlight = false;
	#admitted = new Set<Promise<void>>();
	#startupAdmissions = new StartupAdmissionQueue(sdkHostStartupConcurrency());
	#publication: RetainedBrokerDiscovery | null = null;
	#publicationState: BrokerPublicationState = "healthy-owned";
	#lossAt: bigint | null = null;
	#ambiguousAt: bigint | null = null;
	#publishedAt: bigint | null = null;
	#watchInFlight = false;
	#stopping = false;
	#transport: BrokerTransport | null = null;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#completionTask: Promise<void> | null = null;
	#completion!: Promise<void>;
	#resolveCompletion!: () => void;
	#rejectCompletion!: (error: unknown) => void;
	#resolveModelPin: SdkHostModelResolver;
	#ownsResolveModelPin: boolean;
	constructor(settings: BrokerSettings) {
		this.settings = {
			agentDir: settings.agentDir,
			packageGeneration: settings.packageGeneration ?? resolveBrokerPackageGeneration(),
			port: settings.port ?? 0,
			heartbeatTtlMs: settings.heartbeatTtlMs ?? BROKER_HEARTBEAT_TTL_MS,
			resolveDirectoryMigration: settings.resolveDirectoryMigration ?? (async () => "copy-retain"),
			masterCapabilityVerifier: settings.masterCapabilityVerifier,
			spawnSubstrateProvider: settings.spawnSubstrateProvider,
			spawnPromptLayer: settings.spawnPromptLayer,
			masterOrphanGraceMs: settings.masterOrphanGraceMs ?? MASTER_ORPHAN_GRACE_DEFAULT_MS,
		};
		this.index = new SessionIndex(settings.agentDir);
		this.ledger = new LifecycleLedger(settings.agentDir);
		this.#ownsResolveModelPin = settings.resolveModelPin === undefined;
		this.#resolveModelPin = settings.resolveModelPin ?? createDefaultSdkHostModelResolver(this.settings.agentDir);
		if (!this.settings.masterCapabilityVerifier)
			this.settings.masterCapabilityVerifier = createMasterCapabilityVerifier(this.index);
		this.#spawnPromptLayer = settings.spawnPromptLayer ?? {
			awaitRegistration: async input => await this.#awaitSpawnHostRegistration(input),
			dispatch: async input => await this.#dispatchSpawnPrompt(input),
			reconcile: async input => await this.#reconcileSpawnPrompt(input),
		};
		this.#lock = path.join(settings.agentDir, "sdk", "broker.lock");
		const completion = Promise.withResolvers<void>();
		this.#completion = completion.promise;
		this.#resolveCompletion = completion.resolve;
		this.#rejectCompletion = completion.reject;
	}
	/** Host capability validation is live-only; no request material is retained. */
	async verifyMasterCapability(
		ownerSessionId: string,
		rawCapability: string,
		attestationEpoch: string,
	): Promise<{ allowed: boolean }> {
		const verifier = this.settings.masterCapabilityVerifier;
		return verifier
			? await verifier.verifyMasterCapability(ownerSessionId, rawCapability, attestationEpoch)
			: { allowed: false };
	}
	async #handleSpawn(input: Record<string, unknown>, idempotencyKey: string | undefined): Promise<BrokerResponse> {
		const admission = parseSpawnInput(input, idempotencyKey);
		if (isBrokerResponse(admission)) return admission;
		const lifecycleIdentity = await deriveIdempotencyIdentity(
			this.settings.agentDir,
			"session.spawn",
			idempotencyKey!,
		);
		const active = this.#spawnInFlight.get(lifecycleIdentity);
		if (active) {
			if (this.#spawnTasks.get(active) !== admission.task)
				return error("idempotency_conflict", "idempotency key conflicts with a live session.spawn request");
			return error("spawn_in_progress", `session.spawn is ${active.phase ?? "prepared"}`);
		}
		const completion = Promise.withResolvers<BrokerResponse>();
		const inFlight: SpawnInFlight = { completion: completion.promise, resolve: completion.resolve };
		// Installed before verification or a durable mutation. Task ownership is a
		// weak in-memory association and cannot reach durable generic code.
		this.#spawnInFlight.set(lifecycleIdentity, inFlight);
		this.#spawnTasks.set(inFlight, admission.task);
		let response: BrokerResponse | undefined;
		let becameOwner = false;
		const finish = (result: BrokerResponse): BrokerResponse => {
			response = result;
			return result;
		};
		try {
			let verified: { allowed: boolean };
			try {
				verified = await this.verifyMasterCapability(
					admission.ownerSessionId,
					admission.masterCapability,
					admission.attestationEpoch,
				);
			} finally {
				admission.masterCapability = "";
			}
			if (!verified.allowed) return finish(error("spawn_failed", "master capability verification was denied"));
			const key = await getBrokerIdentityKey(this.settings.agentDir);
			const authority = this.#spawnAuthority;
			if (!authority) return finish(error("unavailable", "spawn authority is unavailable"));
			const requestBindingMac = spawnBindingMac(
				key,
				admission,
				admission.modelId ?? null,
				admission.modelPreset ?? null,
			);
			const existing = authority.claim(lifecycleIdentity);
			const resolveModels = async (): Promise<BrokerResponse | undefined> => {
				// Validate the optional profile BEFORE any new durable claim or substrate
				// effect. Generic lifecycle create validates it; spawn must do the same.
				if (admission.modelPreset !== undefined) {
					const validated = validateBrokerModelPresetSync(this.settings.agentDir, admission.modelPreset);
					if (isBrokerResponse(validated)) return validated;
					admission.modelPreset = validated;
				}
				// Resolve the explicit model pin before a new durable claim. Raw
				// selectors must never reach a newly launched child.
				if (admission.modelId !== undefined) {
					const resolved = await this.#resolveModelPin(admission.modelId, { cwd: admission.cwd });
					if (!resolved.ok) return error("unknown_model", resolved.error);
					if (resolved.model === null)
						return error("unknown_model", "session.spawn modelId could not be resolved.");
					admission.modelId = resolved.model;
				}
				return undefined;
			};
			let decision: SpawnClaimDecision;
			if (existing !== undefined) {
				// An existing claim carries the raw-selector binding, so terminal and
				// replay responses do not depend on today's model/profile catalog.
				let existingBindingMac: string | undefined;
				if (existing.requestBindingMac === undefined) {
					// Claims written before raw-selector evidence was introduced only have
					// the canonical binding. Re-resolve that historical selector before
					// comparison; if the catalog no longer proves it, fail closed rather
					// than guessing or weakening idempotency conflict protection.
					const modelError = await resolveModels();
					if (modelError) return finish(modelError);
					existingBindingMac = spawnBindingMac(
						key,
						admission,
						admission.modelId ?? null,
						admission.modelPreset ?? null,
					);
				}
				decision = await authority.claimOrJoin(
					lifecycleIdentity,
					existingBindingMac,
					existingBindingMac ?? requestBindingMac,
				);
				if (decision.kind === "owner") {
					becameOwner = true;
					// A recovered pre-send claim may still need to launch. Preserve the
					// fail-closed model validation for that effectful path and reject a
					// catalog remap rather than launching a different model.
					const modelError = await resolveModels();
					if (modelError) return finish(modelError);
					const recoveredBindingMac = spawnBindingMac(
						key,
						admission,
						admission.modelId ?? null,
						admission.modelPreset ?? null,
					);
					if (recoveredBindingMac !== decision.claim.bindingMac)
						return finish(
							error("idempotency_conflict", "session.spawn model selection differs from its durable claim"),
						);
				}
			} else {
				const modelError = await resolveModels();
				if (modelError) {
					// A concurrent claimant may have durably established this exact raw
					// request while catalog loading was in flight. Re-check its opaque
					// binding before returning the validation failure.
					const raced = authority.claim(lifecycleIdentity);
					if (raced === undefined) return finish(modelError);
					decision = await authority.claimOrJoin(lifecycleIdentity, undefined, requestBindingMac);
					if (decision.kind === "owner") {
						becameOwner = true;
						return finish(modelError);
					}
				} else {
					const bindingMac = spawnBindingMac(
						key,
						admission,
						admission.modelId ?? null,
						admission.modelPreset ?? null,
					);
					decision = await authority.claimOrJoin(lifecycleIdentity, bindingMac, requestBindingMac);
				}
			}
			if (decision.kind === "idempotency_conflict")
				return finish(
					error("idempotency_conflict", "idempotency key conflicts with an existing session.spawn claim"),
				);
			if (decision.kind === "in_progress")
				return finish(error("spawn_in_progress", `session.spawn is ${decision.claim.state}`));
			if (decision.kind === "terminal_uncertain")
				return finish(error("terminal_uncertain", "session.spawn outcome is uncertain"));
			if (decision.kind === "terminal") return finish(this.#spawnTerminalResponse(decision.claim));
			if (decision.kind === "replay")
				return finish(await this.#reconcileSpawnReplay(lifecycleIdentity, decision.claim));
			becameOwner = true;
			inFlight.claimId = decision.claim.claimId;
			inFlight.phase = decision.claim.state;
			// Claim fsync precedes this audit mirror. Substrate work may start
			// only after the mirror succeeds; a startup reconciler rebuilds it claim-first.
			await this.ledger.begin(lifecycleIdentity, decision.claim.bindingMac);
			return finish(
				await this.#driveSpawn(lifecycleIdentity, decision.claim, admission, inFlight, decision.recovery),
			);
		} catch {
			return finish(error("spawn_failed", "session.spawn admission could not be durably established"));
		} finally {
			completion.resolve(response ?? error("spawn_failed", "session.spawn admission failed"));
			this.#spawnTasks.delete(inFlight);
			this.#spawnInFlight.delete(lifecycleIdentity);
			if (becameOwner) await this.#spawnAuthority?.releaseOwner(lifecycleIdentity);
		}
	}

	/** Safe, allowlisted spawn result projection; never carries request material. */
	#spawnResult(code: "spawn_accepted" | "spawn_replayed", claim: SpawnClaimV2): Record<string, unknown> {
		const authorityRecord = this.#spawnAuthority?.authority(claim.lifecycleIdentity);
		const seed = claim.seed;
		return {
			code,
			claimId: claim.claimId,
			...(claim.childId === undefined ? {} : { sessionId: claim.childId }),
			...(authorityRecord === undefined ? {} : { substrateKind: authorityRecord.substrateKind }),
			...(seed === undefined
				? {}
				: {
						seed: {
							phase: seed.phase,
							clientRef: seed.clientRef,
							...(seed.commandId === undefined ? {} : { commandId: seed.commandId }),
							...(seed.turnId === undefined ? {} : { turnId: seed.turnId }),
							...(seed.lastQ26Status === undefined ? {} : { status: seed.lastQ26Status }),
						},
					}),
		};
	}

	#spawnTerminalResponse(claim: SpawnClaimV2): BrokerResponse {
		if (claim.state === "accepted") return { ok: true, result: this.#spawnResult("spawn_replayed", claim) };
		if (claim.state === "pre_send_rejected")
			return claim.failure
				? spawnFailureError(claim.failure)
				: error("spawn_failed", "session.spawn was rejected before seed handoff");
		return error("resource_gone", "session.spawn claim is closed");
	}

	#spawnSubstrateProvider(): SpawnSubstrateProvider {
		if (this.settings.spawnSubstrateProvider) return this.settings.spawnSubstrateProvider;
		this.settings.spawnSubstrateProvider = createSpawnSubstrateProvider();
		return this.settings.spawnSubstrateProvider;
	}

	/**
	 * Drives one exclusively owned claim through the durable spawn state machine.
	 * Every effect is fenced by a prior fsynced transition: substrate_starting
	 * precedes launch, dispatching (lease consumption) precedes the prompt frame,
	 * and accepted precedes the success response.
	 */
	async #driveSpawn(
		lifecycleIdentity: string,
		claim: SpawnClaimV2,
		admission: SpawnAdmissionInput,
		inFlight: SpawnInFlight,
		recovered = false,
	): Promise<BrokerResponse> {
		const store = this.#spawnAuthority;
		if (!store) return error("unavailable", "spawn authority is unavailable");
		const provider = this.#spawnSubstrateProvider();
		let current = claim;
		let handedOff = false;
		// Set the moment a substrate exists. After this point a failure is
		// ambiguous, never an ordinary pre-effect failure.
		let launchedProof: SpawnSubstrateProof | undefined;
		let pinnedRegistration: SpawnHostRegistration | undefined;
		try {
			if (current.state === "prepared") {
				const prep = prepareSpawnChildHostLaunch(this, {
					cwd: admission.cwd,
					...(admission.modelId === undefined ? {} : { modelId: admission.modelId }),
					...(admission.modelPreset === undefined ? {} : { modelPreset: admission.modelPreset }),
				});
				current = (
					await store.persistTransition(lifecycleIdentity, {
						claimId: current.claimId,
						from: "prepared",
						to: "substrate_starting",
						childId: prep.childId,
					})
				).claim;
				inFlight.phase = current.state;
				const launched = await provider.launch({
					childSessionId: prep.childId,
					cwd: prep.cwd,
					argv: prep.argv,
					inheritedEnv: prep.inheritedEnv,
					env: prep.env,
				});
				if (launched.ok) launchedProof = launched.proof;
				if (!launched.ok) {
					const failure: SpawnSubstrateFailure = {
						substrateKind: launched.code === "substrate_unavailable" ? "headless" : "tmux",
						code: launched.code,
						message: launched.message,
					};
					current = (
						await store.persistTransition(lifecycleIdentity, {
							claimId: current.claimId,
							from: "substrate_starting",
							to: "pre_send_rejected",
							failure,
						})
					).claim;
					return spawnFailureError(failure);
				}
				const registration = await this.#spawnPromptLayer.awaitRegistration({
					childId: prep.childId,
					cwd: prep.cwd,
					stateRoot: prep.stateRoot,
				});
				if (!registration.ok) {
					await this.#releaseUnownedSubstrate(provider, launchedProof);
					launchedProof = undefined;
					current = (
						await store.persistTransition(lifecycleIdentity, {
							claimId: current.claimId,
							from: "substrate_starting",
							to: "uncertain",
						})
					).claim;
					return error("terminal_uncertain", "session.spawn child registration is uncertain");
				}
				pinnedRegistration = registration.registration;
				const now = Date.now();
				const proof = launched.proof;
				const authorityRecord: SpawnAuthorityV1 = {
					version: 1,
					authorityId: randomBytes(24).toString("base64url"),
					claimId: current.claimId,
					childId: prep.childId,
					ownerSessionId: admission.ownerSessionId,
					lifecycleIdentity,
					substrateKind: proof.substrateKind,
					providerIdentity: proof.providerIdentity,
					...(proof.nativeSessionId === undefined ? {} : { nativeSessionId: proof.nativeSessionId }),
					...(proof.pid === undefined ? {} : { pid: proof.pid }),
					...(proof.processIncarnation === undefined ? {} : { processIncarnation: proof.processIncarnation }),
					...(proof.ownerGeneration === undefined ? {} : { ownerGeneration: proof.ownerGeneration }),
					...(proof.stateFileProof === undefined ? {} : { stateFileProof: proof.stateFileProof }),
					endpointGeneration: registration.registration.endpointGeneration,
					endpointPid: registration.registration.pid,
					endpointIncarnation: registration.registration.processIncarnation,
					endpointCwd: registration.registration.cwd,
					endpointStateRoot: registration.registration.stateRoot,
					closeState: "active",
					createdAt: now,
					updatedAt: now,
				};
				current = (
					await store.persistTransition(lifecycleIdentity, {
						claimId: current.claimId,
						from: "substrate_starting",
						to: "authority_active",
						childId: prep.childId,
						authority: authorityRecord,
					})
				).claim;
				inFlight.phase = current.state;
			}
			if (current.state === "authority_active") {
				const seed: SeedDeliveryV2 = {
					version: 2,
					phase: "prepared",
					clientRef: randomBytes(24).toString("base64url"),
				};
				current = (
					await store.persistTransition(lifecycleIdentity, {
						claimId: current.claimId,
						from: "authority_active",
						to: "seed_prepared",
						seed,
					})
				).claim;
				inFlight.phase = current.state;
			}
			if (
				current.state !== "seed_prepared" ||
				current.preSendLease?.status !== "owned" ||
				!current.seed ||
				!current.childId
			)
				return error("terminal_uncertain", "session.spawn cannot proceed from its durable state");
			// A recovery owner resumes a claim whose substrate was launched by an
			// earlier process. Re-prove that exact substrate before handing off the
			// seed: a replaced or vanished substrate must never receive the prompt.
			if (recovered) {
				const recoveredAuthority = store.authority(lifecycleIdentity);
				if (!recoveredAuthority)
					return error("terminal_uncertain", "session.spawn authority is unavailable after restart");
				// A recovery owner has no in-process pin, so it must come from durable
				// authority. An absent pin is missing evidence, not permission to
				// match on session id alone.
				pinnedRegistration = spawnPinFromAuthority(recoveredAuthority);
				let verdict: "verified" | "mismatch" | "gone";
				try {
					verdict =
						pinnedRegistration === undefined
							? "gone"
							: await provider.verify(spawnProofFromAuthority(recoveredAuthority));
				} catch {
					verdict = "gone";
				}
				if (verdict !== "verified") {
					current = (
						await store.persistTransition(lifecycleIdentity, {
							claimId: current.claimId,
							from: current.state,
							to: "uncertain",
							seed: { ...current.seed, phase: "uncertain" },
						})
					).claim;
					inFlight.phase = current.state;
					return error("terminal_uncertain", "session.spawn substrate could not be re-proven after restart");
				}
			}
			const childId = current.childId;
			const preparedSeed = current.seed;
			// Dispatch without a complete pin must never consume the pre-send lease.
			if (pinnedRegistration === undefined)
				return error("terminal_uncertain", "session.spawn endpoint pin is unavailable before dispatch");
			current = (
				await store.persistTransition(lifecycleIdentity, {
					claimId: current.claimId,
					from: "seed_prepared",
					to: "dispatching",
					leaseEpoch: current.preSendLease.epoch,
					seed: { ...preparedSeed, phase: "dispatching" },
				})
			).claim;
			inFlight.phase = current.state;
			handedOff = true;
			const dispatched = await this.#spawnPromptLayer.dispatch({
				sessionId: childId,
				task: admission.task,
				clientRef: preparedSeed.clientRef,
				pinned: pinnedRegistration,
			});
			if (dispatched.kind === "accepted") {
				current = (
					await store.persistTransition(lifecycleIdentity, {
						claimId: current.claimId,
						from: "dispatching",
						to: "accepted",
						seed: {
							...preparedSeed,
							phase: "accepted",
							commandId: dispatched.commandId,
							turnId: dispatched.turnId,
							acceptedAt: dispatched.acceptedAt,
							lastQ26Status: "accepted",
							observedAt: Date.now(),
						},
					})
				).claim;
				inFlight.phase = current.state;
				return { ok: true, result: this.#spawnResult("spawn_accepted", current) };
			}
			if (dispatched.kind === "pre_send_rejected") {
				current = (
					await store.persistTransition(lifecycleIdentity, {
						claimId: current.claimId,
						from: "dispatching",
						to: "pre_send_rejected",
						provenNoHandoff: true,
						seed: { ...preparedSeed, phase: "pre_send_rejected" },
					})
				).claim;
				inFlight.phase = current.state;
				await this.#closeSpawnSubstrate(lifecycleIdentity);
				return error("spawn_failed", "session.spawn seed delivery was rejected before handoff");
			}
			current = (
				await store.persistTransition(lifecycleIdentity, {
					claimId: current.claimId,
					from: "dispatching",
					to: "uncertain",
					seed: { ...preparedSeed, phase: "uncertain" },
				})
			).claim;
			inFlight.phase = current.state;
			return error("terminal_uncertain", "session.spawn seed delivery outcome is uncertain");
		} catch {
			// Once a substrate exists the outcome is ambiguous even before handoff:
			// reporting an ordinary failure would downgrade retained uncertainty.
			const ambiguous = handedOff || launchedProof !== undefined;
			// A launched substrate with no persisted authority is invisible to the
			// reaper, so in-process cleanup is its only chance. This must run on
			// EVERY post-launch failure exit, not just a returned registration
			// failure: a throw from awaitRegistration, verify, close, or a durable
			// transition all land here.
			if (!handedOff) await this.#releaseUnownedSubstrate(provider, launchedProof);
			return ambiguous
				? error("terminal_uncertain", "session.spawn state could not be advanced durably")
				: error("spawn_failed", "session.spawn could not be advanced durably");
		}
	}

	/**
	 * Closes a substrate that was launched but never got a durable authority row.
	 * The orphan reaper iterates authorities, so such a substrate has no durable
	 * owner and would leak forever. `verify` and `close` are each contained: a
	 * throw or a falsy close result must not skip the remaining work or escape.
	 */
	async #releaseUnownedSubstrate(
		provider: SpawnSubstrateProvider,
		proof: SpawnSubstrateProof | undefined,
	): Promise<void> {
		if (!proof) return;
		let verdict: "verified" | "mismatch" | "gone";
		try {
			verdict = await provider.verify(proof);
		} catch {
			// An unprovable substrate is never mutated; uncertainty is retained by
			// the caller's durable transition instead.
			return;
		}
		if (verdict !== "verified") return;
		try {
			await provider.close(proof);
		} catch {
			// The substrate may survive. The caller still records uncertainty, which
			// is the honest durable outcome for an unclosed unowned substrate.
		}
	}

	/** Best-effort exact-close of a rejected claim's substrate; never name/PID-only. */
	async #closeSpawnSubstrate(lifecycleIdentity: string): Promise<void> {
		try {
			const authorityRecord = this.#spawnAuthority?.authority(lifecycleIdentity);
			if (authorityRecord?.closeState !== "active") return;
			const provider = this.#spawnSubstrateProvider();
			const proof = spawnProofFromAuthority(authorityRecord);
			if ((await provider.verify(proof)) !== "verified") return;
			await provider.close(proof);
		} catch {
			// Close is reconciled again by the reaper path; failure retains authority.
		}
	}

	/**
	 * Resolves a joined non-owner claim from stored facts only. dispatching+
	 * replays exclusively through the stored opaque Q26 clientRef; unknown
	 * outcomes stay retained-uncertain and never re-prompt.
	 */
	async #reconcileSpawnReplay(lifecycleIdentity: string, claim: SpawnClaimV2): Promise<BrokerResponse> {
		const store = this.#spawnAuthority;
		if (!store) return error("unavailable", "spawn authority is unavailable");
		if (claim.state === "dispatching") {
			const childId = claim.childId;
			const seed = claim.seed;
			if (!childId || !seed) return error("terminal_uncertain", "session.spawn dispatch facts are unavailable");
			// Q26 replay must talk to the proven endpoint, not any live row with this
			// session id: a foreign same-id host could otherwise answer and have its
			// command/turn facts persisted as this claim's acceptance.
			const replayAuthority = store.authority(lifecycleIdentity);
			const replayPin = replayAuthority ? spawnPinFromAuthority(replayAuthority) : undefined;
			if (!replayPin)
				return error("terminal_uncertain", "session.spawn endpoint authority is unavailable for replay");
			const q26 = await this.#spawnPromptLayer.reconcile({
				sessionId: childId,
				clientRef: seed.clientRef,
				pinned: replayPin,
			});
			// A present-but-unequal clientRef means the responder answered for another
			// correlation; binding its facts would falsify this claim's acceptance.
			const refMismatch = q26.clientRef !== undefined && q26.clientRef !== seed.clientRef;
			if (
				!refMismatch &&
				(q26.status === "accepted" || q26.status === "in_flight" || q26.status === "terminal_ok") &&
				q26.commandId !== undefined &&
				q26.turnId !== undefined
			) {
				try {
					const advanced = await store.persistTransition(lifecycleIdentity, {
						claimId: claim.claimId,
						from: "dispatching",
						to: "accepted",
						seed: {
							...seed,
							phase: "accepted",
							commandId: q26.commandId,
							turnId: q26.turnId,
							acceptedAt: q26.acceptedAt ?? Date.now(),
							lastQ26Status: q26.status,
							observedAt: Date.now(),
						},
					});
					return { ok: true, result: this.#spawnResult("spawn_replayed", advanced.claim) };
				} catch {
					return error("terminal_uncertain", "session.spawn replay could not be advanced durably");
				}
			}
			if (!refMismatch && q26.status === "failed") {
				try {
					await store.persistSeedObservation(lifecycleIdentity, {
						...seed,
						lastQ26Status: "failed",
						observedAt: Date.now(),
					});
				} catch {
					// The observation is best effort; the durable claim already proves dispatch.
				}
				return error("spawn_failed", "session.spawn seed turn failed after handoff");
			}
			try {
				await store.persistSeedObservation(lifecycleIdentity, {
					...seed,
					lastQ26Status: "unknown",
					observedAt: Date.now(),
				});
			} catch {
				// Retained uncertainty never blocks the typed response below.
			}
			return error("terminal_uncertain", "session.spawn outcome is unknown");
		}
		if (claim.state === "substrate_starting")
			return error("terminal_uncertain", "session.spawn substrate state requires reconciliation");
		return error("spawn_in_progress", `session.spawn is ${claim.state}`);
	}

	/**
	 * Startup reconciliation of non-terminal spawn claims. It never creates a
	 * replacement child or re-sends a prompt: substrate_starting without exact
	 * authority proof retains uncertainty, authority_active durably allocates the
	 * opaque clientRef so one recovery lease may retry, and dispatching resolves
	 * through Q26 only.
	 */
	async #recoverSpawnClaims(): Promise<void> {
		const store = this.#spawnAuthority;
		if (!store) return;
		for (const claim of store.claims()) {
			try {
				if (claim.state === "substrate_starting") {
					await store.persistTransition(claim.lifecycleIdentity, {
						claimId: claim.claimId,
						from: "substrate_starting",
						to: "uncertain",
					});
					continue;
				}
				if (claim.state === "authority_active") {
					// Only exact evidence that the original substrate is still active may
					// advance this claim; otherwise it retains uncertainty rather than
					// letting a later recovery owner prompt a replaced substrate.
					const authorityRecord = store.authority(claim.lifecycleIdentity);
					// A thrown verify is not evidence of a healthy substrate. Treat it
					// exactly like `gone`, so the claim retains uncertainty instead of
					// staying authority_active and later answering spawn_in_progress.
					let verdict: "verified" | "mismatch" | "gone" = "gone";
					// A row written before the endpoint pin existed carries no proof of
					// WHICH host answers on this session id. That is missing authority,
					// so the claim fails closed here rather than becoming eligible for a
					// recovery lease that would match by session id alone.
					if (authorityRecord && spawnPinFromAuthority(authorityRecord)) {
						try {
							verdict = await this.#spawnSubstrateProvider().verify(spawnProofFromAuthority(authorityRecord));
						} catch {
							verdict = "gone";
						}
					}
					if (verdict !== "verified") {
						await store.persistTransition(claim.lifecycleIdentity, {
							claimId: claim.claimId,
							from: "authority_active",
							to: "uncertain",
						});
						continue;
					}
					await store.persistTransition(claim.lifecycleIdentity, {
						claimId: claim.claimId,
						from: "authority_active",
						to: "seed_prepared",
						seed: { version: 2, phase: "prepared", clientRef: randomBytes(24).toString("base64url") },
					});
					continue;
				}
				if (claim.state === "dispatching") await this.#reconcileSpawnReplay(claim.lifecycleIdentity, claim);
			} catch {
				// Recovery is fail-closed: an unreconciled claim stays retained as-is.
			}
		}
	}

	async #awaitSpawnHostRegistration(input: {
		childId: string;
		cwd: string;
		stateRoot: string;
	}): Promise<{ ok: true; registration: SpawnHostRegistration } | { ok: false }> {
		const deadline = Date.now() + SPAWN_HOST_REGISTRATION_TIMEOUT_MS;
		for (;;) {
			try {
				await this.index.refresh();
				// The launch locator is authority: a same-id row registered by an
				// unrelated workspace must never be adopted as this spawn's child.
				const row = this.index.listSessionIdentities().find(
					candidate =>
						candidate.sessionId === input.childId &&
						candidate.endpointGeneration > 0 &&
						candidate.live &&
						!candidate.terminal &&
						!candidate.terminalUncertain &&
						// Path IDENTITY, not spelling. The child publishes a
						// realpath-canonicalized locator while the launch spec carries the
						// caller's lexical path, so `path.resolve` never reconciles a
						// symlinked workspace (macOS /var vs /private/var) and a
						// legitimate child would never match.
						resolveEquivalentPath(candidate.locator.cwd) === resolveEquivalentPath(input.cwd) &&
						resolveEquivalentPath(candidate.locator.stateRoot) === resolveEquivalentPath(input.stateRoot),
				);
				if (row) {
					const incarnation = row.hostIncarnation ?? row.processIncarnation;
					// An incarnation-less row is incomplete endpoint evidence; a partial pin
					// previously just failed later at dispatch, so failing at registration keeps one boundary.
					if (incarnation !== undefined) {
						return {
							ok: true,
							registration: {
								sessionId: row.sessionId,
								endpointGeneration: row.endpointGeneration,
								pid: row.pid,
								processIncarnation: incarnation,
								cwd: row.locator.cwd,
								stateRoot: row.locator.stateRoot,
							},
						};
					}
				}
			} catch {
				// A transient index read failure only delays the poll.
			}
			if (Date.now() > deadline) return { ok: false };
			await Bun.sleep(SPAWN_HOST_REGISTRATION_POLL_MS);
		}
	}

	/** One nonce-correlated frame exchange over a child host's authenticated endpoint. */
	async #spawnChildExchange(input: {
		sessionId: string;
		/** Endpoint identity captured at registration; the exchange refuses to talk to anything else. */
		pinned: SpawnHostRegistration;
		frame: (id: string) => Record<string, unknown>;
		responseType: string;
		timeoutMs: number;
	}): Promise<{ handedOff: boolean; frame?: Record<string, unknown> }> {
		let row: IndexedSession | undefined;
		try {
			await this.index.refresh();
			row = this.index.listSessionIdentities().find(
				candidate =>
					candidate.sessionId === input.sessionId &&
					candidate.endpointGeneration > 0 &&
					candidate.live &&
					!candidate.terminal &&
					!candidate.terminalUncertain &&
					// Bind to the exact endpoint proven at registration. Without this a
					// replaced host or an alternate endpoint for the same id could
					// receive the seed prompt or answer a Q26 reconciliation.
					// Every pin leg is required. Identity fields alone collide across
					// workspaces (pids are reused), so a complete pin is required evidence.
					matchesSpawnPin(candidate, input.pinned),
			);
		} catch {
			row = undefined;
		}
		if (!row) return { handedOff: false };
		const endpoint = await readEndpoint(row);
		if (!endpoint) return { handedOff: false };
		const id = randomBytes(16).toString("base64url");
		const settled = Promise.withResolvers<Record<string, unknown> | undefined>();
		let handedOff = false;
		let complete = false;
		const settle = (frame?: Record<string, unknown>): void => {
			if (complete) return;
			complete = true;
			settled.resolve(frame);
		};
		let socket: WebSocket | undefined;
		try {
			const url = new URL(endpoint.url);
			url.searchParams.set("token", endpoint.token);
			socket = new WebSocket(url);
			socket.addEventListener("error", () => settle(undefined));
			socket.addEventListener("close", () => settle(undefined));
			socket.addEventListener("message", event => {
				let frame: Record<string, unknown>;
				try {
					const parsed = JSON.parse(String(event.data));
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
					frame = parsed as Record<string, unknown>;
				} catch {
					return;
				}
				if (frame.type === "hello") {
					try {
						socket?.send(JSON.stringify(input.frame(id)));
						handedOff = true;
					} catch {
						settle(undefined);
					}
					return;
				}
				if (frame.type !== input.responseType || frame.id !== id) return;
				settle(frame);
			});
			const frame = await Promise.race([settled.promise, Bun.sleep(input.timeoutMs).then(() => undefined)]);
			return { handedOff, frame };
		} catch {
			return { handedOff };
		} finally {
			try {
				socket?.close();
			} catch {
				// Closing an already failed attachment is best effort.
			}
		}
	}

	async #dispatchSpawnPrompt(input: {
		sessionId: string;
		task: string;
		clientRef: string;
		pinned: SpawnHostRegistration;
	}): Promise<SpawnPromptDispatch> {
		const exchange = await this.#spawnChildExchange({
			sessionId: input.sessionId,
			pinned: input.pinned,
			frame: id => ({
				type: "control_request",
				id,
				operation: "turn.prompt",
				input: { text: input.task, clientRef: input.clientRef },
			}),
			responseType: "control_response",
			timeoutMs: SPAWN_PROMPT_EXCHANGE_TIMEOUT_MS,
		});
		if (!exchange.handedOff) return { kind: "pre_send_rejected" };
		const frame = exchange.frame;
		if (!frame) return { kind: "uncertain" };
		if (frame.ok === true) {
			const acceptance = promptAcceptanceFromResponse(frame, input.clientRef);
			return acceptance === undefined
				? { kind: "uncertain" }
				: { kind: "accepted", commandId: acceptance.commandId, turnId: acceptance.turnId, acceptedAt: Date.now() };
		}
		// An explicit rejection response proves the prompt never reached the turn loop.
		return frame.ok === false ? { kind: "pre_send_rejected" } : { kind: "uncertain" };
	}

	async #reconcileSpawnPrompt(input: {
		sessionId: string;
		clientRef: string;
		pinned: SpawnHostRegistration;
	}): Promise<SpawnQ26Reconciliation> {
		const exchange = await this.#spawnChildExchange({
			sessionId: input.sessionId,
			pinned: input.pinned,
			frame: id => ({
				type: "query_request",
				id,
				query: "turn.result",
				input: { kind: "prompt", clientRef: input.clientRef },
			}),
			responseType: "query_response",
			timeoutMs: SPAWN_PROMPT_EXCHANGE_TIMEOUT_MS,
		});
		const frame = exchange.frame;
		if (frame?.ok !== true) return { status: "unknown" };
		return q26FromResponse(frame);
	}

	/**
	 * Routes session.close for a spawn-created child through its claim/authority
	 * record. Non-spawn sessions fall through to the generic lifecycle path.
	 */
	async #maybeCloseSpawnChild(input: Record<string, unknown>): Promise<BrokerResponse | undefined> {
		const store = this.#spawnAuthority;
		// This runs BEFORE generic normalization, so it must resolve the same
		// `id` alias that normalizeBrokerInput accepts. Reading only `sessionId`
		// let `session.close {id}` fall through to the generic path, which can
		// signal the child PID without the provider's exact substrate proof.
		const alias = normalizeAliasedString(input, "sessionId", ["id"]);
		const sessionId = alias.error ? undefined : alias.value;
		if (!store || !sessionId) return undefined;
		const claim = store.claims().find(candidate => candidate.childId === sessionId);
		if (!claim) return undefined;
		const outcome = await this.#closeSpawnAuthority(claim.lifecycleIdentity);
		if (outcome === "closed") return { ok: true, result: { code: "spawn_child_closed", sessionId } };
		if (outcome === "uncertain")
			return error("terminal_uncertain", "session.close substrate identity could not be re-proven");
		return error("close_refused", "session.close could not complete for the spawned child");
	}

	/**
	 * Ordinary exact close for one spawn authority. It mutates only a re-proven
	 * substrate; identity mismatch retains durable uncertainty and never falls
	 * back to name-only or PID-only cleanup. Repeated close replays safely.
	 */
	async #closeSpawnAuthority(lifecycleIdentity: string): Promise<"closed" | "uncertain" | "retained"> {
		const store = this.#spawnAuthority;
		if (!store) return "retained";
		try {
			const claim = store.claim(lifecycleIdentity);
			let authority = store.authority(lifecycleIdentity);
			if (!claim || !authority) return "retained";
			if (claim.state === "closed" && authority.closeState === "closed") return "closed";
			if (authority.closeState === "closed") return "closed";
			const provider = this.#spawnSubstrateProvider();
			const proof = spawnProofFromAuthority(authority);
			const verdict = await provider.verify(proof);
			if (verdict === "mismatch") {
				if (authority.closeState !== "uncertain") {
					const at = Math.max(Date.now(), authority.updatedAt + 1);
					await store.persistAuthority(lifecycleIdentity, {
						...authority,
						closeState: "uncertain",
						updatedAt: at,
					});
				}
				return "uncertain";
			}
			if (authority.closeState === "active") {
				const at = Math.max(Date.now(), authority.updatedAt + 1);
				authority = (
					await store.persistAuthority(lifecycleIdentity, {
						...authority,
						closeState: "close_requested",
						closeRequestedAt: at,
						updatedAt: at,
					})
				).authority!;
			}
			if (verdict === "verified") {
				const closedSubstrate = await provider.close(proof);
				if (!closedSubstrate.ok) return "retained";
				// Signal delivery is not terminal evidence: only a second exact proof
				// that observes this substrate gone permits the durable close.
				if ((await provider.verify(proof)) !== "gone") return "retained";
			}
			const at = Math.max(Date.now(), authority.updatedAt + 1);
			const closedAuthority: SpawnAuthorityV1 = { ...authority, closeState: "closed", closedAt: at, updatedAt: at };
			const currentClaim = store.claim(lifecycleIdentity);
			if (!currentClaim) return "retained";
			if (currentClaim.state !== "closed")
				await store.persistTransition(lifecycleIdentity, {
					claimId: currentClaim.claimId,
					from: currentClaim.state,
					to: "closed",
					authority: closedAuthority,
				});
			return "closed";
		} catch {
			return "retained";
		}
	}

	/**
	 * Replays pending exact closes, then reaps children after confirmed master
	 * loss. Orphan clocks survive recovery and expiry converges through the same
	 * exact close path for only the matching owned child.
	 */
	/** Deterministic single reap pass; used by maintenance paths and tests. */
	async reapSpawnOrphansOnce(): Promise<void> {
		await this.#reapSpawnOrphans();
	}

	async #reapSpawnOrphans(): Promise<void> {
		if (this.#spawnReapInFlight || this.#stopping) return;
		this.#spawnReapInFlight = true;
		try {
			const store = this.#spawnAuthority;
			if (!store) return;
			const grace = this.settings.masterOrphanGraceMs;
			let rows: readonly IndexedSession[] | undefined;
			for (const claim of store.claims()) {
				const authority = store.authority(claim.lifecycleIdentity);
				if (!authority || (authority.closeState !== "active" && authority.closeState !== "close_requested"))
					continue;
				if (authority.closeState === "close_requested") {
					try {
						await this.#closeSpawnAuthority(claim.lifecycleIdentity);
					} catch {
						// One authority's reap failure never blocks the remaining scan.
					}
					continue;
				}
				if (rows === undefined) {
					try {
						await this.index.refresh();
					} catch {
						return;
					}
					rows = this.index.listSessionIdentities();
				}
				const masterAlive = rows.some(
					row =>
						row.endpointGeneration > 0 &&
						row.live &&
						!row.terminal &&
						!row.terminalUncertain &&
						row.masterRole?.role === "master" &&
						row.masterRole.ownerSessionId === authority.ownerSessionId,
				);
				const orphanPending =
					authority.orphanedAt !== undefined &&
					(authority.orphanRecoveredAt === undefined || authority.orphanRecoveredAt < authority.orphanedAt);
				const now = Date.now();
				try {
					if (masterAlive) {
						if (orphanPending) {
							const at = Math.max(now, authority.updatedAt + 1);
							await store.persistAuthority(claim.lifecycleIdentity, {
								...authority,
								orphanRecoveredAt: at,
								updatedAt: at,
							});
						}
						continue;
					}
					if (!orphanPending) {
						const at = Math.max(now, authority.updatedAt + 1);
						const { orphanRecoveredAt: _cleared, ...rest } = authority;
						await store.persistAuthority(claim.lifecycleIdentity, { ...rest, orphanedAt: at, updatedAt: at });
						continue;
					}
					if (authority.orphanedAt !== undefined && now - authority.orphanedAt >= grace)
						await this.#closeSpawnAuthority(claim.lifecycleIdentity);
				} catch {
					// One authority's reap failure never blocks the remaining scan.
				}
			}
		} finally {
			this.#spawnReapInFlight = false;
		}
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
			if (this.#ownsResolveModelPin)
				this.#resolveModelPin = createDefaultSdkHostModelResolver(this.settings.agentDir);
			// A drained queue refuses every later startup by design, so a restarted broker
			// needs a new one or it would admit nothing for the rest of the process.
			this.#startupAdmissions = new StartupAdmissionQueue(sdkHostStartupConcurrency());
		}
		this.#stopping = false;
		this.#publicationState = "healthy-owned";
		this.#lossAt = null;
		this.#ambiguousAt = null;
		this.#publishedAt = null;
		this.#watchInFlight = false;
		await Promise.all([this.ledger.assertSupportedStateVersions(), readBrokerDiscovery(this.settings.agentDir)]);
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
			const brokerIdentityKey = await getBrokerIdentityKey(this.settings.agentDir);
			this.#spawnAuthority = new SpawnAuthorityStore(this.settings.agentDir, brokerIdentityKey);
			await this.#spawnAuthority.open();
			for (const claim of this.#spawnAuthority.claims()) {
				const mirror = this.ledger.get(claim.lifecycleIdentity);
				if (!mirror) await this.ledger.begin(claim.lifecycleIdentity, claim.bindingMac);
				else if (mirror.requestHash !== claim.bindingMac)
					throw new Error("Spawn claim lifecycle mirror binding differs from durable authority.");
			}
			await this.#recoverSpawnClaims();
			const now = Date.now();
			const incarnation = brokerProcessIncarnation(process.pid);
			if (!incarnation) throw new Error("Broker process incarnation is unavailable.");
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
			this.#publishedAt = process.hrtime.bigint();
			const cadenceMs = Math.max(
				10,
				Math.min(BROKER_PUBLICATION_CADENCE_MS, Math.floor(this.settings.heartbeatTtlMs / 3)),
			);
			this.#heartbeatTimer = setInterval(() => {
				void this.#watchPublication();
				void this.#reapSpawnOrphans();
			}, cadenceMs);
			await this.#checkpointSessionHeartbeats();
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
	/**
	 * The wall-clock bound on unproven liveness, never shorter than the window peers
	 * use to judge the published heartbeat stale.
	 */
	#livenessGraceMs(): number {
		return (
			livenessGraceOverridesForTest.get(this) ??
			Math.max(BROKER_LIVENESS_GRACE_MS, this.settings.heartbeatTtlMs * BROKER_LIVENESS_TTL_MULTIPLIER)
		);
	}
	/**
	 * Whether no publication has succeeded within the liveness grace. Unlike the fence
	 * deadlines this needs no observation and no thrown error, so it still fires when
	 * the publication chain is stalled inside an await that never settles.
	 */
	#unprovenBeyondLivenessDeadline(): boolean {
		if (this.#publishedAt === null) return false;
		return process.hrtime.bigint() - this.#publishedAt >= BigInt(this.#livenessGraceMs()) * 1_000_000n;
	}
	async #watchPublication(writeHeartbeat = true): Promise<void> {
		const publication = this.#publication;
		if (!publication || this.#publicationState === "stopping") return;
		// Evaluated before any await, and on every tick even while an earlier tick is
		// still in flight, so a stalled chain cannot starve the only path that ends it.
		// The lock is deliberately left behind: this process is about to exit, and the
		// dead-owner reclaim (#3963) is what hands it to the successor.
		if (this.#unprovenBeyondLivenessDeadline()) {
			logger.error(
				`sdk broker: no publication has succeeded in ${this.#livenessGraceMs()}ms; terminating so peers can reclaim the lock (#4704)`,
			);
			void this.#complete("lost-root");
			return;
		}
		// Ticks must not stack behind a stalled one: each would add another pending
		// heartbeat write against the same retained handle for as long as the process
		// lives.
		if (this.#watchInFlight) return;
		this.#watchInFlight = true;
		try {
			await this.#observePublication(publication, writeHeartbeat);
		} finally {
			if (this.#publication === publication) this.#watchInFlight = false;
		}
	}
	async #observePublication(publication: RetainedBrokerDiscovery, writeHeartbeat: boolean): Promise<void> {
		if (this.#publication !== publication || this.#publicationState === "stopping") return;
		let observation: BrokerPublicationObservation;
		try {
			observation = publicationObservationOverridesForTest.get(this) ?? (await publication.observeAsync());
		} catch {
			if (this.#stopping || this.#publication !== publication) return;
			this.#fence("observation-ambiguous");
			if (this.#fencedBeyondDeadline()) void this.#complete("lost-root");
			return;
		}
		if (this.#stopping || this.#publication !== publication) return;
		if (observation === "owned") {
			// Recover the cached publication state from the observation, but keep
			// startup admission closed until the heartbeat write has revalidated fresh
			// authority. A replacement can win between this observation and that write;
			// reopening here would admit lifecycle work under stale authority.
			this.#publicationState = "healthy-owned";
			this.#lossAt = null;
			this.#ambiguousAt = null;
			if (writeHeartbeat) {
				await this.#writeHeartbeat(publication);
				if (this.#stopping || this.#publication !== publication || this.#publicationState !== "healthy-owned")
					return;
			}
			this.#startupAdmissions.reopen();
			if (this.#publicationState === "healthy-owned") await this.#checkpointSessionHeartbeats();
			return;
		}
		this.#fence(observation === "ambiguous" ? "observation-ambiguous" : "suspect-unpublished");
		if (this.#fencedBeyondDeadline()) void this.#complete("lost-root");
	}
	async #writeHeartbeat(publication: RetainedBrokerDiscovery): Promise<void> {
		if (!this.discovery || this.#publication !== publication || this.#publicationState === "stopping") return;
		const stall = heartbeatStallOverridesForTest.get(this);
		if (stall) await stall.promise;
		const heartbeatAt = Date.now();
		try {
			if (!(await heartbeatBrokerDiscoveryRetained(publication, heartbeatAt))) {
				if (this.#stopping || this.#publication !== publication) return;
				this.#fence("heartbeat-ambiguous");
				return;
			}
		} catch {
			if (this.#stopping || this.#publication !== publication) return;
			this.#fence("heartbeat-ambiguous");
			return;
		}
		if (this.#stopping || this.#publication !== publication) return;
		// The durable write landed, so liveness is proven for this cycle whatever the
		// authority re-check below decides about this broker's cached state.
		this.#publishedAt = process.hrtime.bigint();
		const recovery = this.runSynchronousEffectWithFreshPublicationAuthority(() => {
			this.discovery = { ...this.discovery!, heartbeatAt };
		});
		if (!recovery.authorized) return;
	}
	async heartbeat(): Promise<void> {
		if (this.#publicationState !== "healthy-owned") return;
		const publication = this.#publication;
		if (publication) await this.#writeHeartbeat(publication);
	}
	/** Re-observes provably live session hosts and checkpoints their liveness. */
	async heartbeatSessions(now = Date.now()): Promise<number> {
		return await this.index.checkpointLiveHeartbeats(now);
	}
	async #checkpointSessionHeartbeats(): Promise<void> {
		try {
			await this.heartbeatSessions();
		} catch (error) {
			logger.warn(`sdk broker: session heartbeat checkpoint failed: ${String(error)}`);
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
		this.#completionTask = (async () => {
			try {
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
			} finally {
				const disposeModelPin = this.#ownsResolveModelPin ? this.#resolveModelPin.dispose?.() : undefined;
				if (mode === "lost-root" && disposeModelPin !== undefined) {
					void disposeModelPin.catch(() => undefined);
					await Promise.race([disposeModelPin, Bun.sleep(BROKER_SETTLEMENT_MS)]);
				} else {
					await disposeModelPin;
				}
				this.discovery = null;
			}
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
		let record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (
			record &&
			!record.live &&
			!record.terminal &&
			!record.terminalUncertain &&
			isSessionAuthorityEligible(record)
		) {
			await this.heartbeatSessions();
			await this.index.refresh();
			record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		}
		if (!record) return error("resource_gone", "session is not indexed");
		if (!isSessionAuthorityEligible(record)) return error("resource_gone", "session endpoint record is gone");
		if (!matchesEndpointAuthority(record, authority)) return error("endpoint_stale", "session endpoint is stale");
		if (!record.live) return error("resource_gone", "session endpoint record is gone");
		return this.#readEndpoint(record, authority);
	}
	async #readLifecycleReplayEndpoint(sessionId: string): Promise<LifecycleReplayEndpoint | BrokerResponse> {
		await this.index.refresh();
		const record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (!record) return error("resource_gone", "session endpoint record is gone");
		if (record.terminalUncertain)
			return error("terminal_uncertain", "Session ownership is uncertain and cannot be replayed safely");
		if (!isSessionAuthorityEligible(record) || !record.live)
			return error("resource_gone", "session endpoint record is gone");
		const endpointMtimeMs = record.endpointMtimeMs;
		if (
			!Number.isSafeInteger(record.endpointGeneration) ||
			record.endpointGeneration <= 0 ||
			!Number.isSafeInteger(record.pid) ||
			record.pid <= 0 ||
			endpointMtimeMs === undefined ||
			!Number.isFinite(endpointMtimeMs) ||
			endpointMtimeMs <= 0
		)
			return error("endpoint_stale", "session endpoint authority is incomplete");
		const endpoint = await this.#readEndpoint(record, {});
		if (!endpoint.ok) return endpoint;
		if (endpoint.result === null || typeof endpoint.result !== "object" || Array.isArray(endpoint.result))
			return error("endpoint_stale", "session endpoint is malformed");
		return {
			endpoint: endpoint.result as Record<string, unknown>,
			endpointGeneration: record.endpointGeneration,
			pid: record.pid,
			endpointMtimeMs,
		};
	}
	async #readEndpoint(record: IndexedSession, authority: EndpointAuthority): Promise<BrokerResponse> {
		if (!isCanonicalSessionId(record.sessionId))
			return error("invalid_input", "indexed sessionId is not a canonical safe identifier");

		try {
			const endpointPath = path.join(record.locator.stateRoot, "sdk", `${record.sessionId}.json`);
			const file = await readEndpointFile(endpointPath);
			if (!file) {
				try {
					await fs.lstat(endpointPath);
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT")
						return error("resource_gone", "session endpoint record is gone");
				}
				return error("endpoint_stale", "session endpoint is stale");
			}
			const endpoint = JSON.parse(file.source) as Record<string, unknown>;
			if (
				endpoint.sessionId !== record.sessionId ||
				endpoint.pid !== record.pid ||
				endpoint.stale === true ||
				!matchesIndexedEndpointFile(file, record)
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
	async #sessionControlAuthority(sessionId: string): Promise<BrokerSessionControlAuthority | BrokerResponse> {
		await this.index.refresh();
		const indexed = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (
			!indexed ||
			!isSessionAuthorityEligible(indexed) ||
			!indexed.live ||
			indexed.terminal ||
			indexed.terminalUncertain
		)
			return error("resource_gone", "session endpoint record is gone");
		if (
			!Number.isSafeInteger(indexed.endpointGeneration) ||
			indexed.endpointGeneration <= 0 ||
			!Number.isSafeInteger(indexed.pid) ||
			indexed.pid <= 0 ||
			indexed.endpointMtimeMs === undefined ||
			!Number.isFinite(indexed.endpointMtimeMs) ||
			indexed.endpointMtimeMs <= 0 ||
			typeof indexed.lifecycleRequestId !== "string" ||
			indexed.lifecycleRequestId.length === 0 ||
			indexed.lifecycleRequestId.length > 128 ||
			!/^[A-Za-z0-9._-]+$/u.test(indexed.lifecycleRequestId) ||
			endpointIncarnation(indexed, indexed.sessionId) === undefined
		)
			return error("endpoint_stale", "session endpoint authority is incomplete");
		let endpointResponse: BrokerResponse;
		try {
			endpointResponse = await this.#readEndpoint(indexed, {});
		} catch {
			return error("endpoint_stale", "session endpoint is stale");
		}
		if (!endpointResponse.ok) return endpointResponse;
		const endpoint = objectRecord(endpointResponse.result);
		if (
			!endpoint ||
			endpoint.sessionId !== indexed.sessionId ||
			endpoint.pid !== indexed.pid ||
			typeof endpoint.url !== "string" ||
			endpoint.url.length === 0 ||
			typeof endpoint.token !== "string" ||
			endpoint.token.length === 0
		)
			return error("endpoint_stale", "session endpoint is malformed");
		try {
			const endpointIdentity = await fs.lstat(
				path.join(indexed.locator.stateRoot, "sdk", `${indexed.sessionId}.json`),
				{ bigint: true },
			);
			if (!endpointIdentity.isFile()) return error("endpoint_stale", "session endpoint is not a regular file");
			return {
				record: indexed,
				endpoint,
				endpointIdentity: {
					dev: endpointIdentity.dev,
					ino: endpointIdentity.ino,
					size: endpointIdentity.size,
					mtimeNs: endpointIdentity.mtimeNs,
					ctimeNs: endpointIdentity.ctimeNs,
				},
			};
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === "ENOENT")
				return error("resource_gone", "session endpoint record is gone");
			return error("endpoint_stale", "session endpoint is stale");
		}
	}
	async #sessionControl(input: Record<string, unknown>, idempotencyKey?: string): Promise<BrokerResponse> {
		if (
			typeof idempotencyKey !== "string" ||
			idempotencyKey.length === 0 ||
			/[\u0000-\u001f\u007f]/u.test(idempotencyKey) ||
			new TextEncoder().encode(idempotencyKey).length > 128
		)
			return error("invalid_input", "idempotencyKey must be a bounded non-empty string");
		const request = brokerSessionControlRequest(input);
		if (isBrokerResponse(request)) return request;
		const target = `session.control\u0000${request.sessionId}`;
		const previous = this.#chains.get(target) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => (release = resolve));
		const chain = previous.then(() => current);
		this.#chains.set(target, chain);
		await previous;
		try {
			const authority = await this.#sessionControlAuthority(request.sessionId);
			if (isBrokerResponse(authority)) return authority;
			let client: SdkClient;
			try {
				client = await SdkClient.connect(authority.endpoint.url as string, authority.endpoint.token as string, {
					timeoutMs: BROKER_SESSION_CONTROL_TIMEOUT_MS,
					reconnectAttempts: 0,
				});
			} catch (caught) {
				return caught instanceof SdkClientError
					? error(caught.code, caught.message)
					: error("unavailable", "session endpoint is unavailable");
			}
			try {
				const currentAuthority = await this.#sessionControlAuthority(request.sessionId);
				if (isBrokerResponse(currentAuthority)) return currentAuthority;
				if (!sameSessionControlAuthority(authority, currentAuthority))
					return error("endpoint_stale", "session endpoint changed before control dispatch");
				const response = await client.control(
					"turn.abort",
					{
						...request.abortInput,
						[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: authority.record.lifecycleRequestId,
					},
					{
						confirm: true,
						idempotencyKey,
						beforeDispatch: () => {
							if (!this.runSynchronousEffectWithFreshPublicationAuthority(() => undefined).authorized)
								throw new SdkClientError("unavailable", "broker publication is unavailable");
						},
					},
				);
				return brokerControlResponse(response);
			} catch (caught) {
				return caught instanceof SdkClientError
					? error(caught.code, caught.message)
					: error("unavailable", "session endpoint control is unavailable");
			} finally {
				await client.close().catch(() => undefined);
			}
		} catch {
			return error("unavailable", "session control is unavailable");
		} finally {
			release();
			if (this.#chains.get(target) === chain) this.#chains.delete(target);
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

	async #sessionListPage(input: Record<string, unknown>, result: SessionList): Promise<BrokerResponse> {
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
		let scope: ResolvedScopeV1 | undefined;
		if (stored?.scope !== undefined) {
			if (input.scope !== undefined) {
				const supplied = scopeRequestV1(input.scope);
				if (!supplied) return error("scope_cursor_mismatch", "scope must match the cursor snapshot");
				try {
					scope = await resolveScopeRequest(supplied);
				} catch (cause) {
					if (cause instanceof ScopeRequestValidationError)
						return error("scope_cursor_mismatch", "scope must match the cursor snapshot");
					throw cause;
				}
				if (JSON.stringify(scope) !== JSON.stringify(stored.scope))
					return error("scope_cursor_mismatch", "scope must match the cursor snapshot");
			}
			scope = stored.scope;
		} else if (input.scope !== undefined) {
			if (stored !== undefined) return error("scope_cursor_mismatch", "scope must match the cursor snapshot");
			const request = scopeRequestV1(input.scope);
			if (!request) return error("invalid_input", "scope must be a valid ScopeRequestV1");
			try {
				scope = await resolveScopeRequest(request);
			} catch (cause) {
				if (cause instanceof ScopeRequestValidationError) return error("invalid_input", cause.message);
				throw cause;
			}
		}
		const limit = stored?.limit ?? requestedLimit ?? SESSION_LIST_DEFAULT_LIMIT;
		const observedAt = stored?.observedAt ?? (scope === undefined ? undefined : new Date().toISOString());
		const resolveSessionId = typeof input.resolveSessionId === "string" ? input.resolveSessionId : undefined;
		const snapshot = stored ?? {
			sessions: (scope === undefined
				? [...result.sessions]
				: result.sessions.filter(session => scopeMatchesLocator(scope, session.locator))
			).filter(session => resolveSessionId === undefined || session.sessionId === resolveSessionId),
			indexSeq: result.indexSeq,
			warnings: [...result.warnings],
			limit,
			offset: 0,
			expiresAt: Date.now() + SESSION_LIST_CURSOR_TTL_MS,
			...(scope === undefined ? {} : { scope, observedAt: observedAt! }),
		};
		const sessions = snapshot.sessions.slice(snapshot.offset, snapshot.offset + snapshot.limit).map(session => {
			const { lifecycleRequestId: _lifecycleRequestId, ...publicSession } = session;
			return publicSession;
		});
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
				...(snapshot.scope === undefined ? {} : { scope: snapshot.scope, observedAt: snapshot.observedAt }),
				...(continuationCursor ? { continuationCursor } : {}),
			},
			indexSeq: snapshot.indexSeq,
		};
	}
	handleRequest(operation: string, input: Record<string, unknown>, idempotencyKey?: string): Promise<BrokerResponse> {
		if (this.#stopping || (this.#publication !== null && this.#publicationState !== "healthy-owned"))
			return Promise.resolve(error("unavailable", "broker publication is unavailable"));
		let release!: () => void;
		const admission = new Promise<void>(resolve => (release = resolve));
		this.#admitted.add(admission);
		return this.#handleRequest(operation, input, idempotencyKey).finally(() => {
			release();
			this.#admitted.delete(admission);
		});
	}
	async #handleRequest(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<BrokerResponse> {
		if (this.#stopping) return error("broker_restarting", "broker is stopping");
		// Spawn bypasses generic raw-input transforms. They must never observe task
		// or capability fields, even transiently.
		if (operation === "session.spawn") return this.#handleSpawn(input, idempotencyKey);
		if (operation === "session.close") {
			const spawnClose = await this.#maybeCloseSpawnChild(input);
			if (spawnClose) return spawnClose;
		}
		if (operation === "session.control") return this.#sessionControl(input, idempotencyKey);
		const fingerprint = lifecycleFingerprint(operation, input);
		const normalization = normalizeBrokerInput(operation, input);
		if (isBrokerResponse(normalization)) return normalization;
		input = normalization.input;
		if (operation === "session.list") {
			if (input.cursor === undefined) await this.index.refresh();
			const page = await this.#sessionListPage(input, this.index.listSessions());
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
				const savedSession =
					match &&
					match.sessionId === resolveSessionId &&
					match.identity.nlink !== undefined &&
					match.identity.ctimeNs !== undefined
						? {
								id: match.sessionId,
								path: match.path,
								identity: {
									dev: match.identity.dev.toString(),
									ino: match.identity.ino.toString(),
									nlink: match.identity.nlink.toString(),
									size: match.identity.size,
									mtimeMs: match.identity.mtimeMs,
									mtimeNs: match.identity.mtimeNs.toString(),
									ctimeNs: match.identity.ctimeNs.toString(),
									sha256: match.identity.sha256,
								},
							}
						: undefined;
				return {
					...page,
					result: {
						...pageResult,
						...(savedSession === undefined ? {} : { savedSession }),
					},
				};
			}
			return page;
		}
		if (operation === "session.get_endpoint") return this.#endpoint(input);
		if (operation === "model.resolve") {
			try {
				const cwd = modelResolutionCwd(input);
				return { ok: true, result: await this.#resolveModelPin(input.model, { cwd }) };
			} catch {
				return error("unavailable", "SDK host model resolution is unavailable.");
			}
		}
		if (operation === "broker.lookup_lifecycle") {
			const requestedOperation = typeof input.operation === "string" ? input.operation : undefined;
			const requestedFingerprint = typeof input.fingerprint === "string" ? input.fingerprint : undefined;
			if (!idempotencyKey || !requestedOperation || !requestedFingerprint)
				return error("invalid_input", "operation, idempotencyKey, and fingerprint are required");
			if (requestedOperation === "session.spawn")
				return error("invalid_input", "session.spawn does not support lifecycle lookup");
			if (!LIFECYCLE_OPERATIONS.has(requestedOperation))
				return error("not_found", "lifecycle operation was not found");
			const identity = await deriveIdempotencyIdentity(this.settings.agentDir, requestedOperation, idempotencyKey);
			const entry = this.ledger.get(identity);
			if (!entry) return error("not_found", "lifecycle operation was not found");
			if (entry.fingerprint !== requestedFingerprint)
				return error("idempotency_conflict", "lifecycle request fingerprint differs");
			if (entry.state === "terminal_uncertain")
				return error("terminal_uncertain", "lifecycle outcome is still uncertain");
			return isBrokerResponse(entry.response)
				? entry.response
				: error("terminal_uncertain", "lifecycle outcome has no recorded response");
		}

		if (!idempotencyKey) return error("invalid_input", "idempotencyKey is required for lifecycle operations");
		if (idempotencyKey.length > 256 || /[\u0000-\u001f\u007f]/u.test(idempotencyKey))
			return error("invalid_input", "idempotencyKey must be a bounded non-empty string");
		const target = createHash("sha256")
			.update(canonicalJson(lifecycleTarget(operation, input)))
			.digest("hex");
		const identity = await deriveIdempotencyIdentity(this.settings.agentDir, operation, idempotencyKey, target);
		const operationKey = `${operation}\0${idempotencyKey}`;

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
			storedRequestHash ??
			createHash("sha256")
				.update(canonicalJson({ operation, input: lifecycleRequestIdentity(input) }))
				.digest("hex");
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
			const begun = await this.ledger.begin(identity, requestHash, { operationKey, fingerprint });
			if (begun.kind === "replay") {
				const replay = begun.entry.response as BrokerResponse;
				const cleanup = cleanupFromResponse(replay) ?? reconstructedDeleteCleanup;
				if (!cleanup) {
					if (
						replay.ok &&
						(operation === "session.create" || operation === "session.fork" || operation === "session.resume") &&
						typeof (replay.result as { sessionId?: unknown } | undefined)?.sessionId === "string"
					) {
						const refreshed = await this.#readLifecycleReplayEndpoint(
							(replay.result as { sessionId: string }).sessionId,
						);
						if (isBrokerResponse(refreshed)) return refreshed;
						return {
							ok: true,
							result: {
								...(replay.result as Record<string, unknown>),
								endpointGeneration: refreshed.endpointGeneration,
								pid: refreshed.pid,
								endpointMtimeMs: refreshed.endpointMtimeMs,
								endpoint: refreshed.endpoint,
							},
						};
					}
					return replay;
				}
				const outcome = await executeLifecycle(this, operation, input, identity, cleanup);
				const response = outcome.response;
				const storedResponse = credentialFreeLifecycleResponse(response) as BrokerResponse;
				await this.ledger.transition(identity, lifecycleResponseState(response), {
					response: storedResponse,
					responseDigest: createHash("sha256").update(canonicalJson(storedResponse)).digest("hex"),
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
				const storedResponse = credentialFreeLifecycleResponse(response) as BrokerResponse;
				await this.ledger.transition(identity, lifecycleResponseState(response), {
					...(pendingCleanupSessionId(response) ? { intendedSessionId: pendingCleanupSessionId(response) } : {}),
					response: storedResponse,
					responseDigest: createHash("sha256").update(canonicalJson(storedResponse)).digest("hex"),
					...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
					...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
				});
				return response;
			}
			if (begun.kind === "in_progress") return error("broker_restarting", "lifecycle operation is in progress");
			const outcome = await executeLifecycle(this, operation, input, identity);
			const response = outcome.response;
			const storedResponse = credentialFreeLifecycleResponse(response) as BrokerResponse;
			await this.ledger.transition(identity, lifecycleResponseState(response), {
				...(pendingCleanupSessionId(response) ? { intendedSessionId: pendingCleanupSessionId(response) } : {}),
				resultSessionId:
					response.ok && typeof (response.result as { sessionId?: unknown } | undefined)?.sessionId === "string"
						? (response.result as { sessionId: string }).sessionId
						: undefined,
				response: storedResponse,
				responseDigest: createHash("sha256").update(canonicalJson(storedResponse)).digest("hex"),
				...(outcome.durableEffects ? { durableEffects: outcome.durableEffects } : {}),
				...(outcome.startupFailure ? { startupFailure: outcome.startupFailure } : {}),
			});
			if (isCleanupPending(response)) return response;
			const persisted = await this.ledger.readTerminal(identity, requestHash);
			const persistenceVerified =
				persisted !== undefined &&
				canonicalJson(persisted.response) === canonicalJson(storedResponse) &&
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

/** Test-only hook for shortening the bounded liveness deadline. */
export function setLivenessGraceForTest(broker: Broker, graceMs: number | undefined): void {
	if (graceMs === undefined) livenessGraceOverridesForTest.delete(broker);
	else livenessGraceOverridesForTest.set(broker, graceMs);
}

/**
 * Test-only hook for stalling the heartbeat write, reproducing a publication tick
 * whose awaited IO does not settle. Clearing it releases the stalled tick the way
 * recovered IO would, instead of abandoning it forever.
 */
export function setHeartbeatStallForTest(broker: Broker, stalled: boolean): void {
	const stall = heartbeatStallOverridesForTest.get(broker);
	if (stalled) {
		if (!stall) heartbeatStallOverridesForTest.set(broker, Promise.withResolvers<void>());
		return;
	}
	heartbeatStallOverridesForTest.delete(broker);
	stall?.resolve();
}

/** Test-only hook for forcing the observation the publication watchdog sees. */
export function setPublicationObservationForTest(
	broker: Broker,
	observation: BrokerPublicationObservation | undefined,
): void {
	if (observation === undefined) publicationObservationOverridesForTest.delete(broker);
	else publicationObservationOverridesForTest.set(broker, observation);
}
