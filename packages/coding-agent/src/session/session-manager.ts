import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import * as fs from "node:fs";

import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import { type AgentMessage, canContinuePersistedHistory } from "@gajae-code/agent-core";
import type { ConfiguredModelChainEntry as SharedConfiguredModelChainEntry } from "@gajae-code/agent-core/compaction";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	ServiceTier,
	TextContent,
	Usage,
} from "@gajae-code/ai/core";
import { hasAdjacentPrivateThinkingBlocks } from "@gajae-code/ai/core";
import type * as native from "@gajae-code/natives";

function nativeSessionManager(): typeof import("@gajae-code/natives") {
	return require("@gajae-code/natives") as typeof import("@gajae-code/natives");
}
const cwdTransitionAls = new AsyncLocalStorage<symbol>();
type CwdReadLeaseContext = { active: boolean; owner: symbol };
const cwdReadLeaseAls = new AsyncLocalStorage<CwdReadLeaseContext>();
const CWD_NOFOLLOW_OPEN_FLAGS =
	fs.constants.O_RDONLY |
	(typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0) |
	(process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0));

import { getTerminalId } from "@gajae-code/tui";
import {
	getAgentDir,
	getBlobsDir,
	getProjectDir,
	getResidentCacheRootDir,
	getSessionsDir,
	getSidecarCacheRootDir,
	getTerminalSessionsDir,
	hasFsCode,
	isEnoent,
	isFsError,
	logger,
	parseJsonlLenient,
	pathIsWithin,
	resolveEquivalentPath,
	Snowflake,
	toError,
} from "@gajae-code/utils";
import { EDIT_SNAPSHOT_EXTERNALIZED_NOTICE, editSnapshotReceipt } from "../edit/renderer";
import type { TtsrInjectionRecord } from "../export/ttsr";
import { assertSafePathComponent } from "../gjc-runtime/session-layout";
import { writeTextAtomic } from "../gjc-runtime/state-writer";
import type { ManagedLegacyLocalMigrationSource } from "../internal-urls/local-protocol";
import * as git from "../utils/git";
import { ArtifactManager } from "./artifacts";
import {
	type BlobPutResult,
	BlobStore,
	disposeVerifiedResidentCacheInstanceDir,
	EphemeralBlobStore,
	externalizeImageData,
	externalizeImageDataSync,
	externalizeImageDataUrl,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
	MemoryBlobStore,
	openVerifiedResidentCacheInstanceDir,
	openVerifiedSidecarCacheInstanceDir,
	parseBlobRef,
	ResidentBlobMissingError,
	ResidentCacheTrustError,
	resolveResidentImageDataSync,
	resolveResidentImageDataUrlSync,
	resolveTextBlobSync,
	sweepResidentCacheRoot,
} from "./blob-store";
import {
	canonicalizeTrustedPath,
	deleteManagedSessionCandidate,
	isRecoverableOwnerOnlyModeDrift,
	listManagedCandidates,
	type ManagedCandidateWriteAuthority,
	type ManagedMigrationPolicy,
	type ManagedOpenCandidateResult,
	type ManagedScope,
	managedDirectoryAuthorityForScope,
	managedRootForScope,
	openManagedCandidateForWrite,
	prepareManagedSessionScopeForWriteSync,
	resecureOwnerOnlyManagedTree,
	resolveManagedScope,
	resolveManagedScopeForWrite,
} from "./internal/managed-session-scope";
import {
	assertManagedDirectoryRoot,
	captureManagedFileNoFollow,
	fsyncManagedArtifactTree,
	isDescriptorBoundManagedIdentity,
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	type ManagedAppendReceipt,
	type ManagedBoundedAppendExpectation,
	ManagedCommittedMutationError,
	type ManagedDirectoryRoot,
	type ManagedFileIdentity,
	type ManagedFileSnapshot,
	ManagedPublishError,
	ManagedSessionDescendantStore,
	type ManagedSessionSecurityPolicy,
	managedDirectoryRoot,
	mayCleanManagedTreeStaging,
	retainManagedDirectoryAuthority,
} from "./internal/managed-session-storage";
import { classifyNativePublishOutcome, formatNativePublishDiagnostic } from "./internal/native-publish-outcome";
import {
	applyReducerDelta,
	type BaseAnchor,
	BoundedDictionaryArtifactBuilder,
	BoundedDictionaryIdSet,
	BoundedLabelsPinsStore,
	BoundedParentArtifactBuilder,
	BoundedParentChildrenIndex,
	type CommitMarkerContents,
	type CommittedTail,
	classifyReopen,
	coldBranchOrdinalRunWithinPrefetchBounds,
	computeLineDigest,
	computeTailRecordChecksum,
	type DescriptorSnapshot,
	DICTIONARY_PARTITION_BUFFER_BYTES,
	DICTIONARY_PARTITION_COUNT,
	type DictionaryArtifactBuildResult,
	type DictionaryArtifactCommit,
	type DictionaryArtifactFlushTarget,
	type DictionaryPartitionCommit,
	dictionaryArtifactRuntimeBytes,
	dictionaryPartitionForId,
	FixedCacheAccount,
	finalizeDictionaryArtifactCommit,
	getLastModelChangeRole as getReducerLastModelChangeRole,
	isDerivedSessionMemoryFile,
	isValidMetadataDeltaCommit,
	LABELS_PINS_BUDGET_BYTES,
	MAX_REDUCER_INLINE_BYTES,
	type MetadataDeltaArtifactCommit,
	type MetadataDeltaValue,
	metadataDeltaDescriptorResidentBytes,
	PARENT_CHILDREN_BUCKET_COUNT,
	PARENT_CHILDREN_BUDGET_BYTES,
	PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT,
	type ParentArtifactCommit,
	type ParentBucketCommit,
	parentArtifactRuntimeBytes,
	parentBucketForId,
	parseDictionaryPartitionRecord,
	parseParentBucketRecord,
	REDUCER_BUDGET_BYTES,
	type ReducerState,
	type ReopenClassification,
	RollingTailChainBuilder,
	residentRecordBytes,
	residentStringBytes,
	SessionMemoryAccountant,
	sameDescriptor,
	serializeDictionaryPartitionRecord,
	serializeParentBucketRecord,
	type TailRecord,
	type TailRecordKind,
	tailRecordResidentBytes,
	validateCommit,
	validateTailChain,
} from "./internal/session-memory-sidecar";
import { SessionMigrationBusyError } from "./internal/session-open-errors";
import {
	hasOnlyKeys as hasOnlyMemoryGuardKeys,
	isMemoryGuardDecimalString,
	isMemoryGuardRelativePath,
	isMemoryGuardSha256Hex,
	type MemoryGuardCheckpointBlobAuthorityV1,
	type MemoryGuardCheckpointBlobManifestEntryV1,
	type MemoryGuardCheckpointBlobManifestV1,
	type MemoryGuardCreateCheckpointInput,
	type MemoryGuardParticipantDescriptorV1,
	type MemoryGuardParticipantIngressLease,
	type MemoryGuardRestoreInput,
	type MemoryGuardRestoreResult,
	type MemoryGuardSessionManagerCheckpointV1,
	memoryGuardCanonicalJson,
	memoryGuardSha256Hex,
} from "./memory-guard-checkpoint-participant";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import { type SessionManagerReadAccess, sessionManagerReadCapability } from "./session-manager-internal";
import { isStagedSessionPath, SESSION_STAGING_DIRNAME } from "./session-staging-paths";
import type {
	ManagedSessionSecurityContext,
	SessionStorage,
	SessionStorageBufferedWriter,
	SessionStorageExclusiveLock,
	SessionStorageRangeSnapshot,
	SessionStorageSecurityContext,
	SessionStorageSnapshot,
	SessionStorageStat,
	SessionStorageWriter,
	SessionStorageWriterCloseState,
	SessionStorageWriterOpenOptions,
	StagedStreamingWriter,
	VerifiedSessionDeleteResult,
	VerifiedSessionDeleteTarget,
} from "./session-storage";
import {
	createManagedSessionSecurityContext,
	createSessionCommitMarkerCheckedSync,
	FileSessionStorage,
	MemorySessionStorage,
	replaceSessionCommitMarkerCheckedSync,
	SESSION_RANGE_READ_MAX_BYTES,
} from "./session-storage";

export const CURRENT_SESSION_VERSION = 5;

/**
 * Version 5 separates persisted MCP and discovered-built-in selection authority.
 * Version 4 patch records remain readable; older writers must not edit v5 sessions.
 */

function isUnderProjectGjc(cwd: string, targetPath: string): boolean {
	const relative = path.relative(path.join(path.resolve(cwd), ".gjc"), path.resolve(targetPath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	title?: string; // Auto-generated title from first message
	titleSource?: "auto" | "user";
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	parentSession?: string;
	/** Skip flushing the current session and delete it instead of saving. */
	drop?: boolean;
}

/** Internal successor prepared without changing the manager's visible identity. */
export interface PreparedNewSession {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly artifactsDir: string | null;
	readonly managedLegacyLocalMigrationSource: ManagedLegacyLocalMigrationSource | null;
}

interface PreparedSessionIndex {
	readonly byId: Map<string, SessionEntry>;
	readonly labelsById: Map<string, string>;
	readonly leafId: string | null;
	readonly usageStatistics: UsageStatistics;
}

interface PreparedNewSessionState extends PreparedNewSession {
	readonly header: SessionHeader;
	readonly fileEntries: FileEntry[];
	readonly sessionName: string | undefined;
	readonly titleSource: "auto" | "user" | undefined;
	residentFileEntries?: FileEntry[];
	residentTextBlobStore?: BlobStore;
	index?: PreparedSessionIndex;
	flushed: boolean;
	committed: boolean;
	discarded: boolean;
	persistenceWriter?: NdjsonFileWriter;
	persistenceTempPath?: string;
}

type ResidentTransitionFailurePolicy = "install-staged" | "memory-fallback" | "retain-and-throw" | "memory-only";
type ResidentBlobMissingPolicy = "throw" | "placeholder";

const MAX_STAGED_ATTEMPT_ID_LENGTH = 128;

function assertSafeStagedAttemptId(attemptId: string): void {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) || attemptId.length > MAX_STAGED_ATTEMPT_ID_LENGTH)
		throw new Error("Unsafe artifact attempt id");
}

const ATTEMPT_REMAP_STRUCTURAL_KEYS = new Set(["id", "parentId", "timestamp"]);
const ARTIFACT_REFERENCE_KEYS = new Set([
	"artifactId",
	"artifactIds",
	"artifactRef",
	"artifactRefs",
	"agentId",
	"agentIds",
	"agentRef",
	"agentRefs",
]);
/**
 * Trailing-selector grammar mirrored from `splitPathAndSel` / `splitInternalUrlSel` in
 * `src/tools/path-utils.ts`. It is duplicated rather than imported because `path-utils` pulls in
 * `internal-urls`, which reaches back into the session layer and would create an import cycle.
 * The boundary red-team suite cross-checks these against the real parser so drift fails a test.
 */
const SELECTOR_RANGE_RE = /^L?\d+(?:[-+]L?\d+|-)?(?:,L?\d+(?:[-+]L?\d+|-)?)*$/i;
const SELECTOR_TAIL_RE = /^(?:L?\d+(?:[-+]L?\d+|-)?(?:,L?\d+(?:[-+]L?\d+|-)?)*|raw|conflicts)$/i;

/**
 * Decide whether a `:` directly after `<scheme>://<id>` terminates the id (so the id is a remappable
 * reference and the tail is an opaque selector) or is part of an opaque authority (so the id must be
 * left alone). `artifact://` splits unconditionally at the first colon; every other scheme requires a
 * strict selector tail, so `agent://3:bogus` keeps `3:bogus` as the authority and must NOT be remapped.
 */
function colonTerminatesUriId(scheme: string, tail: string): boolean {
	if (scheme.toLowerCase() === "artifact") return true;
	if (SELECTOR_TAIL_RE.test(tail)) return true;
	const innerColon = tail.lastIndexOf(":");
	if (innerColon <= 0) return false;
	const head = tail.slice(0, innerColon);
	const last = tail.slice(innerColon + 1);
	const headIsRaw = /^raw$/i.test(head);
	const lastIsRaw = /^raw$/i.test(last);
	return (headIsRaw && SELECTOR_RANGE_RE.test(last)) || (SELECTOR_RANGE_RE.test(head) && lastIsRaw);
}

function remapArtifactReferenceString(value: string, idMap: ReadonlyMap<string, string>, exactId = false): string {
	const exact = exactId ? idMap.get(value) : undefined;
	if (exact !== undefined) return exact;
	// Only re-key when the ENTIRE value is a single URI reference token. A string carrying prose or
	// multiple tokens is opaque content we do not own, and rewriting inside it caused real corruption
	// in earlier revisions. Everything after the id (selector, query, fragment) is likewise opaque and
	// is preserved verbatim, so nested ids inside those payloads are never re-keyed.
	if (/[\s"'<>]/.test(value)) return value;
	const head = value.match(/^(artifact|agent):\/\/([0-9]+)/i);
	if (!head) return value;
	const protocol = head[1];
	const mapped = idMap.get(head[2]);
	if (mapped === undefined) return value;
	const rest = value.slice(head[0].length);
	if (rest !== "" && !/^[:/?#]/.test(rest)) return value;
	if (rest.startsWith(":") && !colonTerminatesUriId(protocol, rest.slice(1))) return value;
	return `${protocol}://${mapped}${rest}`;
}

function remapAttemptReferencesInEntries(entries: readonly FileEntry[], idMap: ReadonlyMap<string, string>): void {
	if (idMap.size === 0) return;
	const seen = new WeakSet<object>();
	const visit = (value: unknown, key?: string): unknown => {
		if (
			typeof value === "number" &&
			key !== undefined &&
			ARTIFACT_REFERENCE_KEYS.has(key) &&
			Number.isSafeInteger(value)
		) {
			const mapped = idMap.get(String(value));
			return mapped === undefined ? value : Number(mapped);
		}
		if (typeof value === "string") {
			return remapArtifactReferenceString(value, idMap, key !== undefined && ARTIFACT_REFERENCE_KEYS.has(key));
		}
		if (!value || typeof value !== "object" || seen.has(value)) return value;
		seen.add(value);
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) value[index] = visit(value[index], key);
			return value;
		}
		const record = value as Record<string, unknown>;
		for (const [childKey, child] of Object.entries(record)) {
			if (ATTEMPT_REMAP_STRUCTURAL_KEYS.has(childKey)) continue;
			const next = visit(child, childKey);
			if (next !== child) record[childKey] = next;
		}
		return value;
	};
	for (const entry of entries) visit(entry);
}

type ResidentTransitionSource =
	| {
			mode: "materialize";
			sourceEntries: FileEntry[];
			sourceStores: {
				textStore: BlobStore | null;
				imageStore: BlobStore;
				textFallback?: (hash: string) => Buffer | null;
				onResidentBlobMissing?: (kind: ResidentBlobKind, hash: string) => void;
			};
			missingPolicy?: ResidentBlobMissingPolicy;
	  }
	| {
			mode: "adopt-staged";
			stagedEntries: FileEntry[];
			stagedStore: BlobStore;
			stagedIndex?: PreparedSessionIndex;
	  };

interface ResidentTransitionInput {
	readonly target: { sessionId: string; sessionFile: string };
	readonly primary: ResidentTransitionSource;
	/** A read-only load may demote an unavailable disposable resident cache to memory. */
	readonly allowUnwritableResidentCacheFallback?: boolean;

	readonly fallback?: Extract<ResidentTransitionSource, { mode: "adopt-staged" }>;
}

class PreparedResidentStoreTransition {
	#active = true;
	#entries: FileEntry[] | undefined;
	#store: BlobStore | undefined;
	#index: PreparedSessionIndex | undefined;

	constructor(
		entries: FileEntry[],
		store: BlobStore,
		index: PreparedSessionIndex,
		private readonly ownsStore: boolean,
	) {
		this.#entries = entries;
		this.#store = store;
		this.#index = index;
	}

	get entries(): FileEntry[] {
		if (!this.#entries) throw new Error("resident_transition_released");
		return this.#entries;
	}

	get store(): BlobStore {
		if (!this.#store) throw new Error("resident_transition_released");
		return this.#store;
	}

	get index(): PreparedSessionIndex {
		if (!this.#index) throw new Error("resident_transition_released");
		return this.#index;
	}

	releaseReferences(): void {
		if (this.#active) throw new Error("resident_transition_still_active");
		this.#entries = undefined;
		this.#store = undefined;
		this.#index = undefined;
	}

	dispose(): void {
		if (!this.#active) return;
		this.#active = false;
		if (!this.ownsStore || !(this.store instanceof EphemeralBlobStore)) return;
		try {
			this.store.dispose();
		} catch (error) {
			logger.warn("Failed to dispose an uncommitted resident cache candidate", {
				error: toError(error).message,
			});
		}
	}

	adopt(): void {
		this.#active = false;
	}
}

interface FreshSessionState {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly header: SessionHeader;
	readonly adoptsLifecycleId: boolean;
}

type ResidentCacheDegradedStore = BlobStore & { degradedReason?: string; degradedCauseCode?: string };

const RESIDENT_CACHE_WRITE_FAILURE_REASONS = new Set([
	"root_create_failed",
	"instance_create_failed",
	"owner_write_failed",
	"owner_close_failed",
	"blob_create_failed",
	"blob_write_failed",
	"blob_close_failed",
]);
const RESIDENT_CACHE_UNWRITABLE_CODES = ["EACCES", "EPERM", "EROFS"] as const;

function hasUnwritableResidentCacheFsCause(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		if (RESIDENT_CACHE_UNWRITABLE_CODES.some(code => hasFsCode(current, code))) return true;
		if (typeof current !== "object" || current === null || !("cause" in current)) return false;
		current = current.cause;
	}
	return false;
}

function isResidentCacheProvisioningFailure(error: unknown): boolean {
	return error instanceof ResidentCacheTrustError || hasUnwritableResidentCacheFsCause(error);
}

function isUnwritableResidentCacheFailure(error: unknown): boolean {
	return (
		hasUnwritableResidentCacheFsCause(error) &&
		(!(error instanceof ResidentCacheTrustError) || RESIDENT_CACHE_WRITE_FAILURE_REASONS.has(error.reason))
	);
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface ColdSpillRef {
	kind: "cold_spill";
	ref: string;
	encoding: "utf8" | "json";
	originalChars: number;
	sha256: string;
	bytes: number;
}

export interface EvictedContentMarker {
	evictedAt: number;
	reason: "compacted_history";
	compactionEntryId: string;
	firstKeptEntryId: string;
	payloads: Record<string, ColdSpillRef>;
}

export interface EvictCompactedContentResult {
	evictedEntries: number;
	hotCharsRemoved: number;
	coldBlobBytes: number;
	payloadRefs: number;
	alreadyEvictedEntries: number;
	coldSpillWriteCount: number;
	coldSpillReadCount: number;
	residentTextReadCount: number;
	residentImageReadCount: number;
}

export interface SessionManagerObservabilityStats {
	coldSpillWriteCount: number;
	coldSpillReadCount: number;
	residentTextReadCount: number;
	residentImageReadCount: number;
	residentCacheAdoptFallbackCount: number;
	residentCacheTrustRejectCount: number;
	residentCacheWin32FallbackCount: number;
	residentCacheDegradedReason?: string;
	residentCacheDegradedCauseCode?: string;
	residentBlobPlaceholderCount: number;
	publicMaterializerCallCount: number;
	getEntryMaterializerCallCount: number;
	getBranchMaterializerCallCount: number;
	getEntriesMaterializerCallCount: number;
	materializedEntriesCachePopulateCount: number;
	materializedCacheDemotedCount: number;
	pathOnlyContextBuildCount: number;
}

export type SessionMemoryMode = "off" | "shadow" | "enabled" | "auto";

export type SessionMemoryGcStrategy = "current" | "none" | "async" | "pressure";
export type SessionMemorySecondaryArtifactMode = "auto" | "enabled" | "disabled";

export interface SessionMemoryPhaseTelemetry {
	wallMs: number;
	cpuMs: number | null;
}

export interface SessionMemoryFirstOpenTelemetry {
	/** True when a bounded first-open attempt was started for this manager. */
	attempted: boolean;
	/** True only after the bounded sidecar set and context were committed. */
	succeeded: boolean;
	strategy: SessionMemoryGcStrategy;
	secondaryArtifactMode: SessionMemorySecondaryArtifactMode;
	wallMs: number;
	cpuMs: number;
	gcRequests: number;
	gcRequestCount: number;
	gcElapsedMs: number;
	bytesRead: number;
	transcriptBytesRead: number;
	bytesWritten: number;
	sidecarBytesWritten: number;
	sidecarFileBytes: number;
	recordsParsed: number;
	semanticRecordsParsed: number;
	suffixRecordsParsed: number;
	lineAssemblyCopyCount: number;
	lineCopyCount: number;
	lineAssemblyCopyBytes: number;
	indexWriteCalls: number;
	indexWriteBytes: number;
	fsyncCount: number;
	fsyncElapsedMs: number;
	/** Phase names are stable internal keys; missing phases remain zero-valued. */
	phaseTelemetry: Record<string, SessionMemoryPhaseTelemetry>;
	/** Alias retained for benchmark/report consumers. */
	phaseEvidence: Readonly<Record<string, SessionMemoryPhaseTelemetry>>;
	/** Alias retained for benchmark/report consumers. */
	phaseTimings: Readonly<Record<string, SessionMemoryPhaseTelemetry>>;
	/** Internal pressure-mode baseline; not persisted. */
	pressureBaselineBytes?: number;
	dictionaryArtifactEnabled: boolean;
	parentArtifactEnabled: boolean;
	dictionaryBuildElapsedMs: number;
	parentBuildElapsedMs: number;
	flatIndexElapsedMs: number;
}

export interface SessionMemoryStats {
	sidecarEnabled: boolean;
	coldRetirementActive: boolean;
	sidecarIneligible: boolean;
	hotRegionBytes: number;
	metaDescriptorBytes: number;
	totalAccountedBytes: number;
	/** Fixed cache/reducer reservation charged for enforcement, distinct from live residency. */
	reservedBudgetBytes: number;
	/** Bytes currently allocated in bounded block/entry/tail caches. */
	allocatedCacheBytes: number;
	/** Resident hot suffix object bytes, excluding reserved budgets. */
	hotResidentBytes: number;
	/** Resident reducer/labels/metadata-delta descriptor bytes. */
	metadataResidentBytes: number;
	/** Bytes currently present in disposable sidecar files. */
	sidecarFileBytes: number;
	/** Latest bounded first-open telemetry; zero-valued when no attempt ran. */
	firstOpen: SessionMemoryFirstOpenTelemetry;
	lastReopenTransition: ReopenClassification | undefined;
	currentCommitTransition: ReopenClassification | undefined;
	lazyReopenAttempted: boolean;
	lazyReopenSucceeded: boolean;
	lazyReopenFallbackReason: string | undefined;
	retirementFallbackReason: string | undefined;
	autoDisabledReason: string | undefined;
	consecutiveBuildFailures: number;
	/** Persistent bounded parent→children artifact is adopted and usable. */
	parentArtifactEnabled: boolean;
	/** Persistent bounded dictionary artifact is adopted and usable. */
	dictionaryArtifactEnabled: boolean;
	/** Reducer-bucket bytes retained by metadata-delta descriptors (fixed accounting). */
	metadataDeltaDescriptorBytes: number;
	/** Live cold index bytes (descriptor size when proven, else 0). */
	coldIndexBytes: number;
	/** Live cold block-cache allocated bytes. */
	coldIndexBlockCacheBytes: number;
	/** Live cold entry-cache allocated bytes. */
	coldEntryCacheBytes: number;
	/** Live observability counters (P7 contract). */
	coldEntriesRetired: number;
	coldEntriesReloaded: number;
	rangeReadCount: number;
	rangeReadGenerationMismatchCount: number;
	sidecarRebuildCount: number;
	coldMutationPromotions: number;
	hotOverflowTransitions: number;
	labelDiskFallbackCount: number;
	/** Shadow-mode eager-vs-sidecar parity mismatches observed at build time (AC10 telemetry). */
	shadowParityMismatchCount: number;
	/** Shadow-mode parity comparisons performed at build time (AC10 telemetry). */
	shadowParityCheckCount: number;
	transcriptGeneration: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
	/** Cold-spill marker: when present, heavy message content was moved to durable
	 *  content-addressed blobs after compaction. The marker is entry-level session
	 *  metadata (not a message field) so strict message types stay intact. */
	evictedContent?: EvictedContentMarker;
}

const sessionMessageEntryIds = new WeakMap<object, string>();
const sessionMessageViewportAnchorIds = new WeakMap<object, string>();
const sessionMessageObservationIds = new WeakMap<object, string>();

export function associateSessionMessageEntryId(message: AgentMessage, entryId: string): void {
	sessionMessageEntryIds.set(message, entryId);
}

export function getSessionMessageEntryId(message: AgentMessage): string | undefined {
	return sessionMessageEntryIds.get(message);
}

export function associateSessionMessageObservationId(message: AgentMessage, observationId: string): string {
	const existing = sessionMessageObservationIds.get(message);
	if (existing) return existing;
	sessionMessageObservationIds.set(message, observationId);
	return observationId;
}

export function getSessionMessageObservationId(message: AgentMessage): string | undefined {
	return sessionMessageObservationIds.get(message);
}

export function associateSessionMessageViewportAnchorId(message: AgentMessage, anchorId: string): void {
	sessionMessageViewportAnchorIds.set(message, anchorId);
}

export function getSessionMessageViewportAnchorId(message: AgentMessage): string | undefined {
	return sessionMessageViewportAnchorIds.get(message);
}

/** Returns registered viewport anchors for durable user messages in session order. */
export function getUserMessageViewportAnchorIds(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user" || message.synthetic) return [];
		const anchorId = getSessionMessageViewportAnchorId(message);
		return anchorId ? [anchorId] : [];
	});
}

export function transferSessionMessageIdentity(source: AgentMessage[], target: AgentMessage[]): void {
	if (source.length !== target.length) {
		throw new Error(
			`Cannot transfer session message identity across ${source.length} source and ${target.length} target messages`,
		);
	}
	for (let index = 0; index < source.length; index++) {
		const entryId = getSessionMessageEntryId(source[index]);
		if (entryId) associateSessionMessageEntryId(target[index], entryId);
		const observationId = getSessionMessageObservationId(source[index]);
		if (observationId) associateSessionMessageObservationId(target[index], observationId);
		const anchorId = getSessionMessageViewportAnchorId(source[index]);
		if (anchorId) associateSessionMessageViewportAnchorId(target[index], anchorId);
	}
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
	/**
	 * True only when an operator effort surface (`setThinkingLevelForControl`,
	 * Shift+Tab `cycleThinkingLevel`) recorded this entry. Model-driven appends
	 * (model-switch `defaultLevel`, temporary model switches, context clears,
	 * re-applies after model cycling) leave it unset so `getThinkingScopeForControl`
	 * never mints session scope without operator effort intent (issue #4695).
	 */
	operatorIntent?: boolean;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format */
	model: string;
	/** Role: "default" or an agent role. Undefined treated as "default" */
	role?: string;
	/** Clears the role's previously recorded model when replaying session context. */
	cleared?: boolean;
	/** Requested model before a runtime substitution/fallback, in "provider/modelId" format. */
	previousModel?: string;
	/** Machine-readable reason for runtime model substitution/fallback. */
	reason?: string;
	/** Effective thinking level when the change was recorded. */
	thinkingLevel?: string | null;
}

/** Persisted configured fallback chain for one model role. */
export type ConfiguredModelChainEntry = SharedConfiguredModelChainEntry;

export type ConfiguredModelChain = Pick<
	ConfiguredModelChainEntry,
	"role" | "entries" | "origin" | "identity" | "explicitHead" | "cleared"
>;

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTier | null;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist across compaction */
	preserveData?: Record<string, unknown>;
	/** True if generated by an extension, undefined/false if pi-generated (backward compatible) */
	fromExtension?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** True if generated by an extension, false if pi-generated */
	fromExtension?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** TTSR injection entry - tracks which time-traveling rules have been injected this session. */
export interface TtsrInjectionEntry extends SessionEntryBase {
	type: "ttsr_injection";
	/** Names of rules that were injected */
	injectedRules: string[];
	/** Rich rule injection records with repeat state. */
	injectedRuleRecords?: TtsrInjectionRecord[];
	/** TTSR manager message count when this injection was recorded. */
	ttsrMessageCount?: number;
}

/** Persisted MCP discovery selection state for a session branch. */
export interface MCPToolSelectionEntry extends SessionEntryBase {
	type: "mcp_tool_selection";
	/** MCP tool names selected for visibility in discovery mode. */
	selectedToolNames: string[];
	/** Legacy v4 combined built-in authority, retained for read compatibility. */
	selectedDiscoveredBuiltinToolNames?: string[];
	/** Correlates the ordered MCP and built-in entries emitted by one combined activation. */
	mutationCorrelationId?: string;
}

/** Persisted discovered-built-in selection state, independent of MCP authority. */
export interface DiscoveredBuiltinToolSelectionEntry extends SessionEntryBase {
	type: "discovered_builtin_tool_selection";
	selectedToolNames: string[];
	/** Correlates the ordered MCP and built-in entries emitted by one combined activation. */
	mutationCorrelationId?: string;
}

/** Session init entry - captures initial context for subagent sessions (debugging/replay). */
export interface SessionInitEntry extends SessionEntryBase {
	type: "session_init";
	/** Full system prompt sent to the model */
	systemPrompt: string;
	/** Initial task/user message */
	task: string;
	/** Tools available to the agent */
	tools: string[];
	/** Output schema if structured output was requested */
	outputSchema?: unknown;
	/** Fork-context seed metadata for subagent debugging/replay. */
	forkContext?: unknown;
}

/** Mode change entry - tracks agent mode transitions (e.g. plan mode). */
export interface ModeChangeEntry extends SessionEntryBase {
	type: "mode_change";
	/** Current mode name, or "none" when exiting a mode */
	mode: string;
	/** Optional mode-specific data (e.g. plan file path) */
	data?: Record<string, unknown>;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content participates in LLM context through convertToLlm().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Cold-spill marker for custom-message content evicted after compaction. */
	evictedContent?: EvictedContentMarker;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ServiceTierChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| TtsrInjectionEntry
	| MCPToolSelectionEntry
	| DiscoveredBuiltinToolSelectionEntry
	| SessionInitEntry
	| ModeChangeEntry
	| ConfiguredModelChainEntry;

/** Append-only replacement for mutable fields on the session header. */
export interface HeaderPatchRecord {
	type: "header_patch";
	patch: Partial<Pick<SessionHeader, "title" | "titleSource" | "cwd">>;
}

/** Append-only replacement for replay metadata on one existing session entry. */
export interface EntryPatchRecord {
	type: "entry_patch";
	entryId: string;
	patch: Partial<Pick<SessionMessageEntry, "message">>;
}

export type SessionPatchRecord = HeaderPatchRecord | EntryPatchRecord;

/** Resolved file entries; patch records are applied by parseSessionEntries(). */
export type FileEntry = SessionHeader | SessionEntry;
/**
 * Cold-region placeholder envelope for a retired entry. The heavy payload was moved
 * out of RAM into the disposable `.spill.idx`/`.spill.tail` cold region; the exact
 * transcript byte range is recorded so the entry can be lazily resolved by
 * `ordinal`/`id`. Never persisted; used only while a cold sidecar region is active.
 */
export interface SessionColdRefEntry extends SessionEntryBase {
	type: "session_cold_ref";
	ordinal: number;
	seq: number;
	byteOffset: number;
	byteLength: number;
}

/** One cold entry's transcript location, keyed by entry id. */
export interface ColdEntryIndex {
	ordinal: number;
	seq: number;
	byteOffset: number;
	byteLength: number;
	recordDigest: string;
	parentId?: string | null;
	entryType?: string;
}

export interface SessionMemorySidecarRuntime {
	/** Transcript v5 remains authoritative; sidecars are disposable/rebuildable. */
	enabled: boolean;
	/** Set when duplicate record IDs were detected; session stays eager. */
	sidecarIneligible: boolean;
	base: BaseAnchor;
	tail: CommittedTail;
	/** Next non-header ordinal, proven while building or validating the flat index. */
	nextOrdinal: number;
	/** Bounded hot index cache; authoritative lookup falls back to the disk index. */
	coldEntries: Map<string, ColdEntryIndex>;
	indexPath: string;
	tailPath: string;
	commitPath: string;
	/** Directory prefix of the persistent `.spill.parent-<bucket>` bucket files. */
	parentPathPrefix: string;
	/** Directory prefix of the persistent `.spill.dict-part-<partition>` partition files. */
	dictionaryPathPrefix: string;
	/** Path of the persistent `.spill.dict-meta` finalization file. */
	dictionaryMetaPath: string;
	/** Path of the persistent `.spill.metadata-delta` section. */
	metadataDeltaPath: string;
	retirementFirstKeptEntryId: string | undefined;
	/** Hot-suffix byte total (accountant-bounded to ≤ 16 MiB). */
	hotSuffixBytes: number;
	/** Resident hot suffix object bytes charged separately from the raw hot-region byte count. */
	hotResidentBytes: number;
	/** Fixed reservation used for accounting split telemetry. */
	reservedBudgetBytes: number;
	/** Disposable sidecar file byte total captured after first-open publication. */
	sidecarFileBytes: number;
	accountant: SessionMemoryAccountant;
	reducer: ReducerState;
	/** Resident inline provider-affecting entries (merged order minus demoted slots). */
	providerStateEntries: SessionEntry[];
	/** Merged provider-list order as keys (inline + demoted); reopened/appended slots stay exact. */
	providerStateOrder: string[];
	blockCache: FixedCacheAccount;
	parentChildrenCache: Map<
		string,
		{
			ids: readonly string[];
			bytes: number;
			descriptor: SessionStorageStat;
			bucketDescriptor?: SessionStorageStat;
			bucketIndex?: number;
		}
	>;
	entryCache: FixedCacheAccount;
	tailCache: FixedCacheAccount;
	labelsPins: BoundedLabelsPinsStore;
	terminalTransition: ReopenClassification | undefined;
	reopenTransition: ReopenClassification | undefined;
	/** SHA-256 over the exact `.spill.idx` bytes this runtime has written/adopted ("" until proven). */
	indexDigest: string;
	/** Descriptor of the exact index bytes whose digest was validated for cache use. */
	validatedIndexDescriptor?: SessionStorageStat;
	/** Live running hash of the index bytes; updated on every index append. */
	indexHash: crypto.Hash;
	/** Persistent bounded parent→children artifact state; absent = parent lookups fail closed. */
	parentArtifact?: ParentArtifactRuntimeState;
	/** Persistent bounded dictionary artifact state; absent = dictionary lookups fail closed to the cold scan. */
	dictionary?: DictionaryArtifactRuntimeState;
	/** Persistent metadata-delta section state; absent = no demoted provider values. */
	metadataDelta?: MetadataDeltaArtifactRuntimeState;
	/** Fixed-size false-positive-only cache used solely for generated-ID collision avoidance. */
	coldIdHashes?: BoundedColdIdHashSet;
	coldIdHashesDescriptor?: SessionStorageStat;
	/** Live observability counters (P7 live-only contract). */
	coldEntriesRetired: number;
	coldEntriesReloaded: number;
	rangeReadCount: number;
	rangeReadGenerationMismatchCount: number;
	sidecarRebuildCount: number;
	coldMutationPromotions: number;
	hotOverflowTransitions: number;
	labelDiskFallbackCount: number;
	/** Shadow-mode eager-vs-sidecar parity mismatches observed at build time (AC10 telemetry). */
	shadowParityMismatchCount: number;
	/** Shadow-mode parity comparisons performed at build time (AC10 telemetry). */
	shadowParityCheckCount: number;
	transcriptGeneration: number;
}

/** Retained runtime state of the disposable parent→children artifact (block-cache charged). */
interface ParentArtifactRuntimeState {
	/** Exact `.spill.idx` digest the artifact covers; artifact lookups require `indexDigest === runtime.indexDigest`. */
	indexDigest: string;
	/** Committed per-bucket exact-byte size + sha256, updated incrementally on append. */
	buckets: ParentBucketCommit[];
	/** Total artifact bytes (sum of bucket sizes). */
	totalBytes: number;
	/** Block-cache bytes charged for this retained state; released on invalidation/wholesale release. */
	chargedBytes: number;
	/** On-disk byte cap enforced on append; fixed at `PARENT_CHILDREN_BUDGET_BYTES` unless a test shrinks it. */
	budgetBytes: number;
}

/** Retained runtime state of the disposable dictionary artifact (block-cache charged). */
interface DictionaryArtifactRuntimeState {
	/** Exact `.spill.idx` digest the artifact covers; lookups require `indexDigest === runtime.indexDigest`. */
	indexDigest: string;
	/** Committed per-partition exact-byte size + sha256, updated incrementally on append. */
	partitions: DictionaryPartitionCommit[];
	/** Exact `.spill.dict-meta` bytes (size + digest). */
	metaSize: number;
	metaDigest: string;
	recordCount: number;
	uniqueTerms: number;
	totalBytes: number;
	/** Bounded duplicate-id diagnostics; non-empty ⇒ the artifact is never adopted. */
	duplicateIds: readonly string[];
	sidecarIneligible: boolean;
	/** Block-cache bytes charged for this retained state; released on invalidation. */
	chargedBytes: number;
	/** On-disk byte cap for a single partition append; fixed unless a test shrinks it. */
	budgetBytes: number;
	/** Running per-partition hashes/sizes/records for append-time rebinding. */
	partitionHashes: crypto.Hash[];
	partitionSizes: number[];
	partitionRecords: number[];
	/** Descriptor of the exact meta bytes whose digest was validated for artifact use. */
	validatedDescriptor?: SessionStorageStat;
}

/** Retained runtime state of the disposable metadata-delta section (reducer-bucket accounting). */
interface MetadataDeltaArtifactRuntimeState {
	/** Exact `.spill.idx` digest the sidecar set was built with. */
	indexDigest: string;
	/** Exact bytes of the `.spill.metadata-delta` file. */
	size: number;
	sha256: string;
	/** Live running hash of the delta bytes; updated on every value append. */
	hash: crypto.Hash;
	/** Demoted value descriptors keyed by provider key (positions derived at marker time). */
	byKey: Map<string, Omit<MetadataDeltaValue, "key" | "position">>;
	/** Reducer-bucket bytes retained by the descriptors (fixed accounting, reported in stats). */
	descriptorBytes: number;
	/** Fixed on-disk byte cap for the section. */
	budgetBytes: number;
	/** Descriptor of the exact delta bytes whose digest was validated. */
	validatedDescriptor?: SessionStorageStat;
}

/** Bucket file paths for the disposable parent artifact derived from an index path. */
function parentBucketPaths(indexPath: string, bucketCount = PARENT_CHILDREN_BUCKET_COUNT): string[] {
	const prefix = indexPath.replace(/\.spill\.idx$/, ".spill.parent-");
	return Array.from({ length: bucketCount }, (_, bucket) => `${prefix}${bucket.toString().padStart(4, "0")}`);
}

/** Partition file paths for the disposable dictionary artifact derived from an index path. */
function dictionaryPartitionPaths(indexPath: string, partitionCount = DICTIONARY_PARTITION_COUNT): string[] {
	const prefix = indexPath.replace(/\.spill\.idx$/, ".spill.dict-part-");
	return Array.from({ length: partitionCount }, (_, partition) => `${prefix}${partition.toString().padStart(4, "0")}`);
}

/** Path of the disposable dictionary meta file derived from an index path. */
function dictionaryMetaPathFor(indexPath: string): string {
	return indexPath.replace(/\.spill\.idx$/, ".spill.dict-meta");
}

/** Path of the disposable metadata-delta section derived from an index path. */
function metadataDeltaPathFor(indexPath: string): string {
	return indexPath.replace(/\.spill\.idx$/, ".spill.metadata-delta");
}

/** Count one parent's records inside a verified bucket byte range. */
function countParentBucketRecords(bytes: Uint8Array, parentId: string): number {
	let count = 0;
	const text = new TextDecoder("utf-8").decode(bytes);
	for (const line of text.split("\n")) {
		if (!line) continue;
		const record = parseParentBucketRecord(line);
		if (record?.parentId === parentId) count++;
	}
	return count;
}

interface SessionMemoryCommitContents extends CommitMarkerContents {
	retirementFirstKeptEntryId?: string;
	leafId?: string;
	reducer?: ReducerState;
	/** Resident inline provider-affecting entries only; oversized values live in `metadataDelta`. */
	providerStateEntries?: SessionEntry[];
	labels?: Array<[string, string]>;
	usageStatistics?: UsageStatistics;

	/** SHA-256 over the exact `.spill.idx` bytes the marker's sidecar set was built with. */
	indexDigest?: string;
	/** Bounded parent→children artifact binding; absent when no artifact was published for this marker. */
	parentIndex?: ParentArtifactCommit;
	/** Bounded dictionary artifact binding; absent when no dictionary was published for this marker. */
	dictionary?: DictionaryArtifactCommit;
	/** Metadata-delta section binding; absent when no provider value was demoted. */
	metadataDelta?: MetadataDeltaArtifactCommit;
}

function isValidPersistedReducerState(value: ReducerState): boolean {
	const latest = value.modelChange?.latest;
	return (
		(latest === undefined ||
			(Number.isSafeInteger(latest.ordinal) && (latest.role === undefined || typeof latest.role === "string"))) &&
		[value.ttsr?.count, value.ttsr?.rulesCount, value.ttsr?.recordsCount, value.ttsr?.largestOrdinal].every(
			item => typeof item === "number" && Number.isSafeInteger(item),
		)
	);
}

function isProviderStateEntry(entry: SessionEntry): boolean {
	return [
		"thinking_level_change",
		"model_change",
		"configured_model_chain",
		"service_tier_change",
		"mcp_tool_selection",
		"discovered_builtin_tool_selection",
		"mode_change",
		"ttsr_injection",
	].includes(entry.type);
}

function providerStateEntryKey(entry: SessionEntry): string | undefined {
	if (!isProviderStateEntry(entry)) return undefined;
	return entry.type === "configured_model_chain" ? `${entry.type}:${entry.role}` : entry.type;
}
/** Map a session entry to its rolling-tail record kind. */
function tailRecordKindForEntry(entry: SessionEntry): TailRecordKind {
	switch (entry.type) {
		case "message":
			return entry.message.role === "user" ? "user" : entry.message.role === "assistant" ? "assistant" : "tool";
		case "custom_message":
			return entry.display ? "other" : "internal";
		case "model_change":
			return "model_change";
		case "ttsr_injection":
			return "ttsr_injection";
		default:
			return "other";
	}
}

/**
 * Bounded first-open transcript scan limits. The eager authoritative path handles
 * anything outside these bounds; the bounded path only ever fails closed to it.
 */
export const BOUNDED_FIRST_OPEN_MAX_LINE_BYTES = 8 * 1024 * 1024;
const FORK_PATCH_OVERLAY_BUDGET_BYTES = 8 * 1024 * 1024;
const COLD_ID_HASH_CAPACITY = 1_250_003;
const COLD_ID_HASH_BYTES = COLD_ID_HASH_CAPACITY * 3;

/** Fixed-size collision cache for generated IDs. False positives only cause regeneration. */
class BoundedColdIdHashSet {
	readonly #high = new Uint8Array(COLD_ID_HASH_CAPACITY);
	readonly #low = new Uint16Array(COLD_ID_HASH_CAPACITY);
	#size = 0;
	readonly #maxEntries: number;

	constructor(maxEntries = coldIdHashMaxEntries()) {
		this.#maxEntries = maxEntries;
	}

	get atCapacity(): boolean {
		return this.#size >= this.#maxEntries;
	}

	#hash(value: string, seed: number): number {
		let hash = seed >>> 0;
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash;
	}

	#fingerprint(value: string): [number, number] {
		let fingerprint = this.#hash(value, 0x811c9dc5) & 0xffffff;
		if (fingerprint === 0) fingerprint = 1;
		return [(fingerprint >>> 16) & 0xff, fingerprint & 0xffff];
	}

	has(value: string): boolean {
		const [high, low] = this.#fingerprint(value);
		let slot = this.#hash(value, 0x9e3779b9) % COLD_ID_HASH_CAPACITY;
		for (let probes = 0; probes < COLD_ID_HASH_CAPACITY; probes++) {
			const existingHigh = this.#high[slot];
			const existingLow = this.#low[slot];
			if (existingHigh === 0 && existingLow === 0) return false;
			if (existingHigh === high && existingLow === low) return true;
			slot++;
			if (slot === COLD_ID_HASH_CAPACITY) slot = 0;
		}
		return true;
	}

	add(value: string): boolean {
		if (this.atCapacity) return false;
		const [high, low] = this.#fingerprint(value);
		let slot = this.#hash(value, 0x9e3779b9) % COLD_ID_HASH_CAPACITY;
		for (let probes = 0; probes < COLD_ID_HASH_CAPACITY; probes++) {
			const existingHigh = this.#high[slot];
			const existingLow = this.#low[slot];
			if (existingHigh === high && existingLow === low) return true;
			if (existingHigh === 0 && existingLow === 0) {
				this.#high[slot] = high;
				this.#low[slot] = low;
				this.#size++;
				return true;
			}
			slot++;
			if (slot === COLD_ID_HASH_CAPACITY) slot = 0;
		}
		return false;
	}
}

class DiskBackedIdUniquenessCheck {
	static readonly BUCKETS = 64;
	static readonly BUFFER_BYTES = 4096;
	readonly #buffers = Array.from({ length: DiskBackedIdUniquenessCheck.BUCKETS }, () =>
		Buffer.allocUnsafe(DiskBackedIdUniquenessCheck.BUFFER_BYTES),
	);
	readonly #positions = new Uint16Array(DiskBackedIdUniquenessCheck.BUCKETS);
	readonly #fds = new Map<number, number>();
	#failed = false;

	constructor() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-index-ids-"));
		try {
			for (let bucket = 0; bucket < DiskBackedIdUniquenessCheck.BUCKETS; bucket++) {
				const bucketPath = path.join(root, bucket.toString(16).padStart(2, "0"));
				const fd = fs.openSync(bucketPath, "w+", 0o600);
				fs.unlinkSync(bucketPath);
				this.#fds.set(bucket, fd);
			}
			fs.rmdirSync(root);
		} catch (error) {
			for (const fd of this.#fds.values()) {
				try {
					fs.closeSync(fd);
				} catch {
					// Preserve the constructor failure.
				}
			}
			this.#fds.clear();
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		}
	}

	#hash(value: string, seed: number): number {
		let hash = seed >>> 0;
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash;
	}

	#flush(bucket: number): void {
		const length = this.#positions[bucket]!;
		if (length === 0) return;
		fs.writeSync(this.#fds.get(bucket)!, this.#buffers[bucket]!, 0, length);
		this.#positions[bucket] = 0;
	}

	add(value: string): boolean {
		if (this.#failed) return false;
		try {
			const high = this.#hash(value, 0x811c9dc5);
			const low = this.#hash(value, 0x9e3779b9);
			const bucket = low & (DiskBackedIdUniquenessCheck.BUCKETS - 1);
			if (this.#positions[bucket]! + 8 > DiskBackedIdUniquenessCheck.BUFFER_BYTES) this.#flush(bucket);
			const offset = this.#positions[bucket]!;
			this.#buffers[bucket]!.writeUInt32LE(high, offset);
			this.#buffers[bucket]!.writeUInt32LE(low, offset + 4);
			this.#positions[bucket] = offset + 8;
			return true;
		} catch {
			this.#failed = true;
			return false;
		}
	}

	#hasDuplicate(bytes: Buffer): boolean {
		const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
		const count = words.length / 2;
		const greater = (left: number, right: number): boolean => {
			const leftHigh = words[left * 2]!;
			const rightHigh = words[right * 2]!;
			return leftHigh === rightHigh ? words[left * 2 + 1]! > words[right * 2 + 1]! : leftHigh > rightHigh;
		};
		const swap = (left: number, right: number): void => {
			const leftOffset = left * 2;
			const rightOffset = right * 2;
			const high = words[leftOffset]!;
			const low = words[leftOffset + 1]!;
			words[leftOffset] = words[rightOffset]!;
			words[leftOffset + 1] = words[rightOffset + 1]!;
			words[rightOffset] = high;
			words[rightOffset + 1] = low;
		};
		const siftDown = (start: number, end: number): void => {
			let root = start;
			for (;;) {
				const child = root * 2 + 1;
				if (child > end) return;
				let candidate = root;
				if (greater(child, candidate)) candidate = child;
				if (child + 1 <= end && greater(child + 1, candidate)) candidate = child + 1;
				if (candidate === root) return;
				swap(root, candidate);
				root = candidate;
			}
		};
		for (let start = Math.floor((count - 2) / 2); start >= 0; start--) siftDown(start, count - 1);
		for (let end = count - 1; end > 0; end--) {
			swap(0, end);
			siftDown(0, end - 1);
		}
		for (let index = 1; index < count; index++) {
			const offset = index * 2;
			const previous = offset - 2;
			if (words[offset] === words[previous] && words[offset + 1] === words[previous + 1]) return true;
		}
		return false;
	}

	finish(): boolean {
		try {
			for (let bucket = 0; bucket < DiskBackedIdUniquenessCheck.BUCKETS; bucket++) this.#flush(bucket);
			if (this.#failed) return false;
			for (const fd of this.#fds.values()) {
				const size = fs.fstatSync(fd).size;
				if (size % 8 !== 0) return false;
				const bytes = Buffer.allocUnsafe(size);
				let offset = 0;
				while (offset < size) {
					const read = fs.readSync(fd, bytes, offset, size - offset, offset);
					if (read === 0) return false;
					offset += read;
				}
				if (this.#hasDuplicate(bytes)) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	dispose(): void {
		for (const fd of this.#fds.values()) {
			try {
				fs.closeSync(fd);
			} catch {
				// Best-effort scratch cleanup.
			}
		}
		this.#fds.clear();
	}
}
/** Persistent secondary artifacts stay optional beyond this fixed build envelope. */
const PERSISTENT_SECONDARY_ARTIFACT_MAX_RECORDS = 64 * 1024;
const PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const residentHotEntryBytes = (serializedBytes: number): number => residentRecordBytes(serializedBytes * 2 + 256);

interface BoundedFirstOpenHashCheckpoint {
	offset: number;
	hash: crypto.Hash;
}

const BOUNDED_FIRST_OPEN_HASH_CHECKPOINT_INTERVAL_BYTES = 64 * 1024 * 1024;

/** State the bounded first-open scan derives without building an entry graph. */
interface BoundedFirstOpenDiscovery {
	/** Exactly one current-version header on the first line. */
	header: SessionHeader;
	/** Id of the last session entry (leaf of the strictly linear chain). */
	leafId: string;
	/** First entry retained by the latest reachable compaction (retirement boundary). */
	retirementFirstKeptEntryId: string;
	/** Ordinal of the compaction entry that selected the retained boundary. */
	retirementCompactionOrdinal: number;
	/** Latest model-change / TTSR reducer state over the linear chain. */
	reducer: ReducerState;
	/** Aggregated assistant/task usage totals over the linear chain. */
	usageStatistics: UsageStatistics;
	/** Number of non-header transcript records proven by the semantic pass. */
	recordCount: number;
	/** Current label state derived from `label` entries in chain order. */
	labels: Array<[string, string]>;
	/** Latest provider-affecting entries with exact ordinals, bounded by the reducer reservation. */
	providerState: Array<{ ordinal: number; entry: SessionEntry }>;
	/** SHA-256 prefix states at bounded transcript offsets. */
	hashCheckpoints: BoundedFirstOpenHashCheckpoint[];
	/** Exact digest of the private flat index written by the semantic pass. */
	indexDigest: string;
}

type BoundedLineScanFailure = "read_failed" | "oversized_line" | "unterminated" | "aborted";

/**
 * Stream a JSONL transcript in bounded 64 KiB range reads without materializing
 * the whole file or building an entry graph. `visit(lineStart, lineBytes)` is
 * invoked for every newline-terminated line with its exact absolute byte offset
 * and exact bytes including the trailing "\n"; returning `false` aborts with
 * `"aborted"`. Returns a failure reason when the file is not exactly
 * newline-terminated, any line exceeds `BOUNDED_FIRST_OPEN_MAX_LINE_BYTES`, or a
 * range read fails — the caller then fails closed to the eager authoritative
 * path. Returns `undefined` only after every byte was consumed as a complete
 * newline-terminated line.
 */
const boundedJsonLineDecoder = new TextDecoder("utf-8", { fatal: true });
function decodeBoundedJsonLine(lineBytes: Uint8Array): string {
	const length = lineBytes.at(-1) === 0x0a ? lineBytes.byteLength - 1 : lineBytes.byteLength;
	return boundedJsonLineDecoder.decode(lineBytes.subarray(0, length));
}

function bytesStartWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
	if (bytes.byteLength < prefix.byteLength) return false;
	for (let index = 0; index < prefix.byteLength; index++) if (bytes[index] !== prefix[index]) return false;
	return true;
}

function updateBoundedTranscriptHash(
	hash: crypto.Hash,
	lineStart: number,
	lineBytes: Uint8Array,
	state: { nextCheckpointOffset: number; hashedOffset: number },
	checkpoints: BoundedFirstOpenHashCheckpoint[],
): boolean {
	if (lineStart !== state.hashedOffset) return false;
	let offset = 0;
	while (offset < lineBytes.byteLength) {
		const absolute = lineStart + offset;
		if (absolute >= state.nextCheckpointOffset) {
			checkpoints.push({ offset: state.nextCheckpointOffset, hash: hash.copy() });
			state.nextCheckpointOffset += BOUNDED_FIRST_OPEN_HASH_CHECKPOINT_INTERVAL_BYTES;
			continue;
		}
		const end = Math.min(lineBytes.byteLength, offset + Math.max(1, state.nextCheckpointOffset - absolute));
		hash.update(lineBytes.subarray(offset, end));
		offset = end;
		state.hashedOffset = lineStart + offset;
		if (state.hashedOffset === state.nextCheckpointOffset) {
			checkpoints.push({ offset: state.nextCheckpointOffset, hash: hash.copy() });
			state.nextCheckpointOffset += BOUNDED_FIRST_OPEN_HASH_CHECKPOINT_INTERVAL_BYTES;
		}
	}
	state.hashedOffset = lineStart + lineBytes.byteLength;
	return true;
}

function createBoundedLineChunkConsumer(visit: (lineStart: number, lineBytes: Uint8Array) => boolean | undefined): {
	consume(chunk: Buffer, chunkStart: number): BoundedLineScanFailure | undefined;
	hasLargePendingLine(): boolean;
	finish(includeUnterminated?: boolean): BoundedLineScanFailure | undefined;
} {
	let pendingChunks: Buffer[] = [];
	let pendingBytes = 0;
	let pendingStart = 0;
	return {
		consume(chunk, chunkStart) {
			let consumed = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, consumed);
				if (newline < 0) break;
				const segment = chunk.subarray(consumed, newline + 1);
				const lineStart = pendingChunks.length === 0 ? chunkStart + consumed : pendingStart;
				const lineBytes = pendingBytes + segment.byteLength;
				if (lineBytes > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) return "oversized_line";
				let line = segment;
				if (pendingChunks.length > 0) {
					pendingChunks.push(segment);
					line = Buffer.concat(pendingChunks, lineBytes);
				}
				pendingChunks = [];
				pendingBytes = 0;
				if (visit(lineStart, line) === false) return "aborted";
				consumed = newline + 1;
			}
			if (consumed < chunk.byteLength) {
				if (pendingChunks.length === 0) pendingStart = chunkStart + consumed;
				const remainder = chunk.subarray(consumed);
				pendingBytes += remainder.byteLength;
				if (pendingBytes > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) return "oversized_line";
				pendingChunks.push(remainder);
			}
			return undefined;
		},
		hasLargePendingLine() {
			return pendingBytes >= 256 * 1024;
		},
		finish(includeUnterminated = false) {
			if (pendingBytes === 0) return undefined;
			if (!includeUnterminated) return "unterminated";
			const line = Buffer.concat(pendingChunks, pendingBytes);
			pendingChunks = [];
			pendingBytes = 0;
			return visit(pendingStart, line) === false ? "aborted" : undefined;
		},
	};
}

function createReusableBoundedLineChunkConsumer(
	visit: (lineStart: number, lineBytes: Uint8Array) => boolean | undefined,
	onCopy?: (bytes: number) => void,
): {
	consume(chunk: Buffer, chunkStart: number): BoundedLineScanFailure | undefined;
	hasLargePendingLine(): boolean;
	finish(includeUnterminated?: boolean): BoundedLineScanFailure | undefined;
} {
	let pendingBuffer: Buffer | undefined;
	let pendingBytes = 0;
	let pendingStart = 0;
	const ensureCapacity = (required: number): Buffer => {
		if (pendingBuffer && pendingBuffer.byteLength >= required) return pendingBuffer;
		let capacity = pendingBuffer?.byteLength ?? 64 * 1024;
		while (capacity < required) capacity = Math.min(BOUNDED_FIRST_OPEN_MAX_LINE_BYTES, capacity * 2);
		const grown = Buffer.allocUnsafe(capacity);
		if (pendingBuffer && pendingBytes > 0) onCopy?.(pendingBytes);
		if (pendingBuffer && pendingBytes > 0) pendingBuffer.copy(grown, 0, 0, pendingBytes);
		pendingBuffer = grown;
		return grown;
	};
	return {
		consume(chunk, chunkStart) {
			let consumed = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, consumed);
				if (newline < 0) break;
				const segment = chunk.subarray(consumed, newline + 1);
				const lineStart = pendingBytes === 0 ? chunkStart + consumed : pendingStart;
				const lineBytes = pendingBytes + segment.byteLength;
				if (lineBytes > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) return "oversized_line";
				let line = segment;
				if (pendingBytes > 0) {
					const assembled = ensureCapacity(lineBytes);
					onCopy?.(segment.byteLength);
					segment.copy(assembled, pendingBytes);
					line = assembled.subarray(0, lineBytes);
				}
				pendingBytes = 0;
				if (visit(lineStart, line) === false) return "aborted";
				consumed = newline + 1;
			}
			if (consumed < chunk.byteLength) {
				if (pendingBytes === 0) pendingStart = chunkStart + consumed;
				const remainder = chunk.subarray(consumed);
				const nextBytes = pendingBytes + remainder.byteLength;
				if (nextBytes > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) return "oversized_line";
				const assembled = ensureCapacity(nextBytes);
				onCopy?.(remainder.byteLength);
				remainder.copy(assembled, pendingBytes);
				pendingBytes = nextBytes;
			}
			return undefined;
		},
		hasLargePendingLine: () => pendingBytes >= 256 * 1024,
		finish(includeUnterminated = false) {
			if (pendingBytes === 0) return undefined;
			if (!includeUnterminated) return "unterminated";
			const line = pendingBuffer!.subarray(0, pendingBytes);
			pendingBytes = 0;
			return visit(pendingStart, line) === false ? "aborted" : undefined;
		},
	};
}

function scanTranscriptLinesBounded(
	storage: SessionStorage,
	filePath: string,
	size: number,
	visit: (lineStart: number, lineBytes: Uint8Array) => boolean | undefined,
	result?: { stat?: SessionStorageStat },
	allowUnterminated = false,
	reuseLineAssembly = false,
	firstOpenTelemetry?: SessionMemoryFirstOpenTelemetry,
	countAsTranscriptBytes = true,
): BoundedLineScanFailure | undefined {
	const chunkBytes =
		size > PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES
			? reuseLineAssembly
				? 320 * 1024
				: 256 * 1024
			: TRANSCRIPT_CAPTURE_CHUNK_BYTES;
	if (storage instanceof FileSessionStorage) {
		const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
		let fd: number | undefined;
		try {
			fd = fs.openSync(filePath, flags);
			const before = fs.fstatSync(fd, { bigint: true });
			if (!before.isFile() || before.nlink > 1 || Number(before.size) < size) return "read_failed";
			const consumer = reuseLineAssembly
				? createReusableBoundedLineChunkConsumer(visit, bytes => recordFirstOpenLineCopy(firstOpenTelemetry, bytes))
				: createBoundedLineChunkConsumer(visit);
			let pos = 0;
			let useLargeRecordCadence = false;
			let bytesSinceGc = 0;
			const reusableReadBuffer = reuseLineAssembly ? Buffer.allocUnsafe(chunkBytes) : undefined;

			while (pos < size) {
				const length = Math.min(chunkBytes, size - pos);
				const chunk = reusableReadBuffer?.subarray(0, length) ?? Buffer.allocUnsafe(length);
				let offset = 0;
				while (offset < length) {
					const count = fs.readSync(fd, chunk, offset, length - offset, pos + offset);
					if (count === 0) return "read_failed";
					offset += count;
				}
				const failure = consumer.consume(chunk, pos);
				if (failure) return failure;
				pos += length;
				if (firstOpenTelemetry) {
					firstOpenTelemetry.bytesRead += length;
					if (countAsTranscriptBytes) firstOpenTelemetry.transcriptBytesRead += length;
				}
				useLargeRecordCadence ||= consumer.hasLargePendingLine();
				const gcIntervalBytes = useLargeRecordCadence
					? size > PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES
						? reuseLineAssembly
							? 60 * 1024 * 1024
							: 32 * 1024 * 1024
						: 23 * 1024 * 1024
					: 4 * 1024 * 1024;
				bytesSinceGc += length;
				if (bytesSinceGc >= gcIntervalBytes) {
					if (firstOpenTelemetry) recordFirstOpenGcRequest(firstOpenTelemetry);
					else Bun.gc(true);
					bytesSinceGc = 0;
				}
			}
			const after = fs.fstatSync(fd, { bigint: true });
			const named = fs.lstatSync(filePath, { bigint: true });
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.nlink !== before.nlink ||
				!named.isFile() ||
				named.isSymbolicLink() ||
				named.dev !== before.dev ||
				named.ino !== before.ino
			)
				return "read_failed";
			if (result) {
				result.stat = {
					dev: after.dev,
					ino: after.ino,
					nlink: after.nlink,
					size: Number(after.size),
					mtimeNs: after.mtimeNs,
					ctimeNs: after.ctimeNs,
					mtimeMs: Number(after.mtimeMs),
					mtime: new Date(Number(after.mtimeMs)),
					isFile: after.isFile(),
				};
			}
			return consumer.finish(allowUnterminated);
		} catch {
			return "read_failed";
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	const consumer = reuseLineAssembly
		? createReusableBoundedLineChunkConsumer(visit, bytes => recordFirstOpenLineCopy(firstOpenTelemetry, bytes))
		: createBoundedLineChunkConsumer(visit);
	let pos = 0;
	let useLargeRecordCadence = false;
	let bytesSinceGc = 0;
	while (pos < size) {
		const length = Math.min(chunkBytes, size - pos);
		let chunk: Uint8Array;
		try {
			chunk = storage.readRangeSync!(filePath, pos, length).bytes;
		} catch {
			return "read_failed";
		}
		const failure = consumer.consume(Buffer.from(chunk), pos);
		if (failure) return failure;
		pos += length;
		if (firstOpenTelemetry) {
			firstOpenTelemetry.bytesRead += length;
			if (countAsTranscriptBytes) firstOpenTelemetry.transcriptBytesRead += length;
		}
		useLargeRecordCadence ||= consumer.hasLargePendingLine();
		const gcIntervalBytes = useLargeRecordCadence
			? size > PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES
				? 32 * 1024 * 1024
				: 23 * 1024 * 1024
			: 4 * 1024 * 1024;
		bytesSinceGc += length;
		if (bytesSinceGc >= gcIntervalBytes) {
			if (firstOpenTelemetry) recordFirstOpenGcRequest(firstOpenTelemetry);
			else Bun.gc(true);
			bytesSinceGc = 0;
		}
	}
	return consumer.finish(allowUnterminated);
}

export type DefaultModelSelectionStage = {
	readonly entryRevision: number;
	readonly leafRevision: number;
	readonly headerExportRevision: number;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entries: readonly FileEntry[];
	readonly tempPath: string | undefined;
	readonly persistsToExistingFile: boolean;
	readonly boundedCold: boolean;
	readonly appendEntries: readonly SessionEntry[];
	readonly sourceDescriptor: DescriptorSnapshot | undefined;
	readonly sourceStat: SessionStorageStat | undefined;
	readonly sourceSha256: string | undefined;
	readonly managedAppendExpectation: ManagedBoundedAppendExpectation | undefined;
};
export interface SessionManagerRevisionSnapshot {
	entry: number;
	leaf: number;
	headerExport: number;
	label: number;
	replayMetadata: number;
}

export interface SessionManagerCheckpointRevisionStrings {
	entry: string;
	leaf: string;
	headerExport: string;
	label: string;
	replayMetadata: string;
}

function assertMemoryGuardSessionId(sessionId: string): void {
	assertSafePathComponent(sessionId, "memory guard checkpoint session id");
}

function memoryGuardParticipantRoot(checkpointRoot: string, sessionId: string): string {
	assertMemoryGuardSessionId(sessionId);
	return path.join(checkpointRoot, "participants", sessionId);
}

function memoryGuardParticipantRelativePath(sessionId: string, suffix: string): string {
	assertMemoryGuardSessionId(sessionId);
	return `participants/${sessionId}/${suffix}`;
}

async function fsyncDirectoryPath(directoryPath: string): Promise<void> {
	const directory = await fs.promises.open(directoryPath, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function ensureOwnerOnlyDirectory(directoryPath: string): Promise<void> {
	await fs.promises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(directoryPath, 0o700).catch(() => undefined);
	await fsyncDirectoryPath(directoryPath);
}
interface CreatedDirectoryIdentity {
	dev: bigint;
	ino: bigint;
}

async function ensureOwnerOnlyDirectoryTracked(directoryPath: string): Promise<CreatedDirectoryIdentity | undefined> {
	const createdPath = await fs.promises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(directoryPath, 0o700).catch(() => undefined);
	await fsyncDirectoryPath(directoryPath);
	if (createdPath === undefined) return undefined;
	const stat = await fs.promises.lstat(directoryPath, { bigint: true });
	return { dev: stat.dev, ino: stat.ino };
}

async function removeCreatedDirectoryIfEmpty(
	directoryPath: string,
	created: CreatedDirectoryIdentity | undefined,
): Promise<void> {
	if (!created) return;
	const stat = await fs.promises.lstat(directoryPath, { bigint: true }).catch(() => undefined);
	if (!stat || stat.dev !== created.dev || stat.ino !== created.ino) return;
	await fs.promises.rmdir(directoryPath).catch(() => undefined);
	await fsyncDirectoryPath(path.dirname(directoryPath)).catch(() => undefined);
}

async function writeOwnerOnlyFileNoReplace(filePath: string, content: Uint8Array | string): Promise<void> {
	await ensureOwnerOnlyDirectory(path.dirname(filePath));
	const handle = await fs.promises.open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
	await fsyncDirectoryPath(path.dirname(filePath));
}

const MEMORY_GUARD_CHECKPOINT_FILE_MAX_BYTES = 128 * 1024 * 1024;
const MEMORY_GUARD_CHECKPOINT_BLOB_MAX_ENTRIES = 4096;
const MEMORY_GUARD_CHECKPOINT_BLOB_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

function collectCheckpointBlobRefs(value: unknown, refs: Set<string> = new Set(), key?: string): Set<string> {
	const addRef = (candidate: unknown): void => {
		if (typeof candidate === "string" && parseBlobRef(candidate)) refs.add(candidate);
	};
	if (Array.isArray(value)) {
		for (const item of value) collectCheckpointBlobRefs(item, refs, key);
		return refs;
	}
	if (!value || typeof value !== "object") return refs;
	if (isRecord(value) && value.kind === "cold_spill" && typeof value.ref === "string" && parseBlobRef(value.ref))
		refs.add(value.ref);
	if (isImageBlock(value) && key === TEXT_CONTENT_KEY) addRef(value.data);
	if (hasImageUrl(value)) {
		if (typeof value.image_url === "string") addRef(value.image_url);
		else addRef(value.image_url.url);
	}
	for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
		if (childKey === "data" && key !== TEXT_CONTENT_KEY) addRef(item);
		collectCheckpointBlobRefs(item, refs, childKey);
	}
	return refs;
}

const FORK_BLOB_VERIFY_MAX_BYTES = 16 * 1024 * 1024;

function verifyForkBlobRefsBounded(value: unknown): boolean {
	for (const ref of collectCheckpointBlobRefs(value)) {
		const hash = parseBlobRef(ref);
		if (!hash) return false;
		const blobPath = path.join(getBlobsDir(), hash);
		let fd: number | undefined;
		try {
			fd = fs.openSync(blobPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || stat.size > FORK_BLOB_VERIFY_MAX_BYTES) return false;
			const digest = crypto.createHash("sha256");
			const chunk = Buffer.allocUnsafe(64 * 1024);
			let offset = 0;
			while (offset < stat.size) {
				const read = fs.readSync(fd, chunk, 0, Math.min(chunk.byteLength, stat.size - offset), offset);
				if (read <= 0) return false;
				digest.update(chunk.subarray(0, read));
				offset += read;
			}
			if (digest.digest("hex") !== hash) return false;
		} catch {
			return false;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	return true;
}

function decodeCheckpointUtf8(data: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return null;
	}
}

function validateMemoryGuardBlobAuthority(value: unknown): value is MemoryGuardCheckpointBlobAuthorityV1 {
	if (
		!isRecord(value) ||
		!hasOnlyMemoryGuardKeys(value, ["kind", "manifest_relative_path", "manifest_sha256", "root_relative_path"])
	)
		return false;
	return (
		value.kind === "checkpoint_blob_tree_v1" &&
		isMemoryGuardRelativePath(value.manifest_relative_path) &&
		isMemoryGuardSha256Hex(value.manifest_sha256) &&
		isMemoryGuardRelativePath(value.root_relative_path)
	);
}

function validateMemoryGuardTranscriptDescriptor(
	value: unknown,
): value is MemoryGuardSessionManagerCheckpointV1["transcript"] {
	if (!isRecord(value) || !hasOnlyMemoryGuardKeys(value, ["bytes", "relative_path", "sha256"])) return false;
	return (
		isMemoryGuardDecimalString(value.bytes) &&
		isMemoryGuardRelativePath(value.relative_path) &&
		isMemoryGuardSha256Hex(value.sha256)
	);
}

function validateMemoryGuardRevisions(value: unknown): value is SessionManagerCheckpointRevisionStrings {
	if (!isRecord(value) || !hasOnlyMemoryGuardKeys(value, ["entry", "leaf", "headerExport", "label", "replayMetadata"]))
		return false;
	return (
		isMemoryGuardDecimalString(value.entry) &&
		isMemoryGuardDecimalString(value.leaf) &&
		isMemoryGuardDecimalString(value.headerExport) &&
		isMemoryGuardDecimalString(value.label) &&
		isMemoryGuardDecimalString(value.replayMetadata)
	);
}

function validateMemoryGuardCheckpoint(value: unknown): value is MemoryGuardSessionManagerCheckpointV1 {
	if (
		!isRecord(value) ||
		!hasOnlyMemoryGuardKeys(value, [
			"blob_authority",
			"revisions",
			"schema_version",
			"session_id",
			"session_name",
			"transcript",
		])
	)
		return false;
	return (
		value.schema_version === 1 &&
		typeof value.session_id === "string" &&
		value.session_id.length > 0 &&
		(value.session_name === null || typeof value.session_name === "string") &&
		validateMemoryGuardBlobAuthority(value.blob_authority) &&
		validateMemoryGuardRevisions(value.revisions) &&
		validateMemoryGuardTranscriptDescriptor(value.transcript)
	);
}

function validateMemoryGuardBlobManifestEntry(value: unknown): value is MemoryGuardCheckpointBlobManifestEntryV1 {
	if (!isRecord(value) || !hasOnlyMemoryGuardKeys(value, ["bytes", "relative_path", "sha256"])) return false;
	return (
		isMemoryGuardDecimalString(value.bytes) &&
		isMemoryGuardRelativePath(value.relative_path) &&
		isMemoryGuardSha256Hex(value.sha256)
	);
}

function validateMemoryGuardBlobManifest(value: unknown): value is MemoryGuardCheckpointBlobManifestV1 {
	if (!isRecord(value) || !hasOnlyMemoryGuardKeys(value, ["entries", "schema_version"])) return false;
	if (value.schema_version !== 1 || !Array.isArray(value.entries)) return false;
	return value.entries.every(validateMemoryGuardBlobManifestEntry);
}

function memoryGuardParticipantMatchesCheckpoint(
	participant: MemoryGuardParticipantDescriptorV1,
	checkpoint: MemoryGuardSessionManagerCheckpointV1,
): boolean {
	return (
		participant.session_id === checkpoint.session_id &&
		participant.session_name === checkpoint.session_name &&
		JSON.stringify(participant.checkpoint) === JSON.stringify(checkpoint.blob_authority) &&
		JSON.stringify(participant.revisions) === JSON.stringify(checkpoint.revisions) &&
		JSON.stringify(participant.transcript) === JSON.stringify(checkpoint.transcript)
	);
}

function readCheckpointAuthorityFile(
	authority: native.RecoveryFsRoot,
	relativePath: string,
	maxBytes: number,
): Uint8Array | null {
	const result = authority.readManaged(relativePath);
	if (!result.ok || !result.data || result.data.byteLength > maxBytes) return null;
	return result.data;
}

function toCanonicalRevisionString(name: keyof SessionManagerRevisionSnapshot, value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_session_manager_revision:${name}`);
	return String(value);
}

export function toSessionManagerCheckpointRevisionStrings(
	snapshot: SessionManagerRevisionSnapshot,
): SessionManagerCheckpointRevisionStrings {
	return {
		entry: toCanonicalRevisionString("entry", snapshot.entry),
		leaf: toCanonicalRevisionString("leaf", snapshot.leaf),
		headerExport: toCanonicalRevisionString("headerExport", snapshot.headerExport),
		label: toCanonicalRevisionString("label", snapshot.label),
		replayMetadata: toCanonicalRevisionString("replayMetadata", snapshot.replayMetadata),
	};
}

export type DefaultModelSelectionPromotion =
	| { readonly kind: "promoted" }
	| { readonly kind: "not_promoted"; readonly error?: Error }
	| { readonly kind: "unknown"; readonly error: Error };

type SessionFileReplacementSyncOutcome =
	| { readonly kind: "replaced" }
	| { readonly kind: "restored_previous"; readonly error: Error };

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel?: string;
	serviceTier?: ServiceTier;
	/** Model roles: { default: "provider/modelId", small: "provider/modelId", ... } */
	models: Record<string, string>;
	/** Configured fallback chains for model roles on the active branch. */
	configuredModelChains: Record<string, ConfiguredModelChain>;

	/** Names of TTSR rules that have been injected this session */
	injectedTtsrRules: string[];
	/** Rich TTSR rule injection records for repeat resume. */
	injectedTtsrRuleRecords?: TtsrInjectionRecord[];
	/** TTSR manager message count for repeat resume. */
	ttsrMessageCount?: number;

	/** MCP tool names selected through discovery for this session branch. */
	selectedMCPToolNames: string[];
	/** Built-in discoverable tool names activated through discovery, when explicitly persisted. */
	selectedDiscoveredBuiltinToolNames?: string[];
	/** Whether this branch contains an explicit persisted MCP selection entry. */
	hasPersistedMCPToolSelection: boolean;
	/** Whether this branch contains an explicit persisted discovered-built-in selection entry. */
	hasPersistedDiscoveredBuiltinToolSelection?: boolean;
	/** Active mode (e.g. "plan") or "none" if no special mode is active */
	mode: string;
	/** Mode-specific data from the last mode_change entry */
	modeData?: Record<string, unknown>;
}

/** Immutable fingerprint captured during read-only resume inspection. */
export interface ResumeSessionIdentity {
	canonicalPath: string;
	sessionId: string;
	dev: bigint;
	ino: bigint;
	nlink?: bigint;
	size: number;
	mtimeMs: number;
	mtimeNs: bigint;
	ctimeNs?: bigint;
	sha256: string;
}

export interface ResumeTailResumable {
	kind: "resumable";
	identity: ResumeSessionIdentity;
}

export interface ResumeTailTerminal {
	kind: "terminal";
	identity: ResumeSessionIdentity;
}

export interface ResumeTailError {
	kind: "error";
	reason:
		| "missing"
		| "malformed"
		| "unstable"
		| "read-failed"
		| "legacy_migration_disabled"
		| "oversized"
		| "context_too_large";
	size?: number;
}

export type SessionDirectoryMigrationPolicy = ManagedMigrationPolicy;
export type SessionAppendPersistenceFailurePhase = "current_append" | "prior_failure";

/** Safety bound for eager resume compatibility and managed per-file artifacts. */
export const RESUME_TRANSCRIPT_MAX_BYTES = MANAGED_ARTIFACT_MAX_FILE_BYTES;
/**
 * Explicit cold-session admission limit. Two-GiB transcripts remain streamable;
 * the extra MiB covers bounded fork header replacement without rejecting a
 * source exactly at the advertised limit.
 */
export const BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024 * 1024 + 1024 * 1024;
const EAGER_RESUME_TRANSCRIPT_MAX_BYTES = MANAGED_ARTIFACT_MAX_FILE_BYTES;

export const SESSION_OVERSIZED_RECOVERY_MESSAGE =
	"The selected session transcript is too large to resume safely. Use `gjc export <session-file>` to export its content into a new session, or remove/archive it after confirming its content is no longer needed.";

export class SessionAppendPersistenceError extends Error {
	readonly phase: SessionAppendPersistenceFailurePhase;
	readonly entryId: string;
	readonly persistenceError: Error;

	constructor(phase: SessionAppendPersistenceFailurePhase, entryId: string, persistenceError: Error) {
		super(persistenceError.message, { cause: persistenceError });
		this.name = "SessionAppendPersistenceError";
		this.phase = phase;
		this.entryId = entryId;
		this.persistenceError = persistenceError;
	}
}

/**
 * Typed near-limit append outcome (#4566).
 *
 * A live managed append that would cross the per-file transcript cap is now
 * preflighted: when the append alone cannot fit even after a full rewrite of
 * the live entries, this deterministic error replaces the generic
 * `SessionAppendPersistenceError: content_too_large` abort. It states whether
 * the in-memory entry was kept (so the just-committed source mutation keeps
 * its receipt on the next successful persist) and how to continue.
 */
export class SessionNearLimitAppendError extends Error {
	readonly code = "near_limit_append" as const;
	/** Serialized size (bytes) of the entry that could not fit. */
	readonly entryBytes: number;
	/** Live-entry rewrite size (bytes) the recovery already attempted. */
	readonly liveBytes: number;
	/** Managed per-file cap in force when the append was rejected. */
	readonly capBytes: number;
	/** True when the entry remains in the resident list awaiting the next persist. */
	readonly entryRetained: boolean;

	constructor(details: {
		entryBytes: number;
		liveBytes: number;
		capBytes: number;
		entryRetained: boolean;
	}) {
		super(
			[
				`near_limit_append: entry (${details.entryBytes} B) plus live transcript (${details.liveBytes} B) exceeds the managed per-file limit (${details.capBytes} B).`,
				details.entryRetained
					? "The appended entry is retained in memory; its effect (including any committed source edit) is recorded and will persist on the next successful write. Compact the session (`/compact`) or export to a fresh session (`gjc export <session-file>`) before continuing."
					: "The appended entry was rolled back from memory; re-issue it after compacting the session (`/compact`) or exporting to a fresh session (`gjc export <session-file>`).",
			].join(" "),
		);
		this.name = "SessionNearLimitAppendError";
		this.entryBytes = details.entryBytes;
		this.liveBytes = details.liveBytes;
		this.capBytes = details.capBytes;
		this.entryRetained = details.entryRetained;
	}
}

export class SessionManagedStorageError extends Error {
	readonly code = "managed_storage_unsupported";

	constructor() {
		super(
			"Default managed session storage requires FileSessionStorage; provide an explicit session directory for custom storage.",
		);
		this.name = "SessionManagedStorageError";
	}
}

export class SessionMigrationPolicyError extends Error {
	readonly code = "legacy_migration_disabled";

	constructor() {
		super("Legacy session migration is disabled for this workspace.");
		this.name = "SessionMigrationPolicyError";
	}
}

export class SessionArtifactCapacityError extends Error {
	readonly code = "artifact_capacity_exceeded";

	constructor(message: string) {
		super(message);
		this.name = "SessionArtifactCapacityError";
	}
}

export class SessionTranscriptOversizedError extends Error {
	readonly code = "oversized";
	readonly size: number;

	constructor(size: number) {
		super(SESSION_OVERSIZED_RECOVERY_MESSAGE);
		this.name = "SessionTranscriptOversizedError";
		this.size = size;
	}
}
/** Default synchronous session-context materialization budget (512 MiB). */
export const SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT = 512 * 1024 * 1024;
/** Ceiling for a `GJC_SESSION_CONTEXT_BUDGET_BYTES` override (8 GiB) so the memory guard stays meaningful. */
export const SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_MAX = 8 * 1024 * 1024 * 1024;

/**
 * Resolve the operation-peak session-context materialization budget from the
 * `GJC_SESSION_CONTEXT_BUDGET_BYTES` override. Parsing is fail-closed: only a
 * canonical positive-integer decimal value is honored; anything else (empty,
 * non-numeric, negative, zero, overflowing a safe integer, or above the
 * documented ceiling) falls back to the 512 MiB default and is surfaced as a
 * warning so a dropped override is never silent.
 */
export function resolveSessionContextBudgetBytes(override: string | undefined): number {
	if (override === undefined) return SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT;
	if (override === "" || !/^[0-9]+$/.test(override)) {
		logger.warn("GJC_SESSION_CONTEXT_BUDGET_BYTES ignored: expected a positive integer", { override });
		return SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT;
	}
	const parsed = Number(override);
	if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_MAX) {
		logger.warn("GJC_SESSION_CONTEXT_BUDGET_BYTES ignored: must be a positive integer ≤ 8 GiB", {
			override,
			max: SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_MAX,
		});
		return SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT;
	}
	return parsed;
}

/** Operation-peak budget for one synchronous session-context materialization. */
export const SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES = resolveSessionContextBudgetBytes(
	process.env.GJC_SESSION_CONTEXT_BUDGET_BYTES,
);

/**
 * Thrown by the synchronous session-context builders when the materialized graph
 * exceeds the operation budget. `instanceof`-stable across module boundaries:
 * consumers map with `error instanceof SessionContextTooLargeError`, never by name
 * string. The over-budget graph is never retained — the builder releases scratch
 * before throwing and public synchronous signatures are unchanged.
 */
export class SessionContextTooLargeError extends Error {
	readonly code = "context_too_large" as const;
	readonly measuredBytes: number;
	readonly budgetBytes: number;

	constructor(
		measuredBytes: number,
		budgetBytes: number = SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES,
		options?: ErrorOptions,
	) {
		super(`Session context exceeds the materialization budget (${measuredBytes} > ${budgetBytes} bytes)`, options);
		this.name = "SessionContextTooLargeError";
		this.measuredBytes = measuredBytes;
		this.budgetBytes = budgetBytes;
	}
}

export type ResumeTailInspection = ResumeTailResumable | ResumeTailTerminal | ResumeTailError;
export interface StrictSessionOpenSuccess {
	kind: "opened";
	manager: SessionManager;
}

export interface StrictSessionOpenFailure {
	kind: "error";
	reason:
		| ResumeTailError["reason"]
		| "identity-mismatch"
		| "migration-required"
		| "artifact_capacity_exceeded"
		| "migration_busy";
	message?: string;
	size?: number;
}

/**
 * Descriptor-bound strict-capture handle. Bounded recorded-length range reads
 * revalidate the live source against the captured identity on every pass; no
 * whole-transcript buffer is ever materialized by capture or fork.
 */
export interface TranscriptSnapshotHandle {
	readonly sourcePath: string;
	readonly identity: ResumeSessionIdentity;
	readonly storage: SessionStorage;
	/**
	 * Iterate every transcript line in bounded recorded-length reads. Each line
	 * is delivered without its trailing newline; returning `false` aborts the
	 * pass. A completed pass re-validates the running content hash against the
	 * captured identity and throws `identity-mismatch` on divergence.
	 */
	forEachLine(callback: (line: Uint8Array) => boolean | undefined): boolean;
	/** Descriptor captured after the most recent complete line pass, when supported. */
	getLastReadStat(): SessionStorageStat | undefined;
	/** Revalidate the live source against the captured identity (bounded). */
	revalidate(): { kind: "valid" } | StrictSessionOpenFailure;
	/** Idempotent close; subsequent reads throw. */
	close(): void;
	/**
	 * Rehydrate the full transcript bytes for bounded-full-return consumers.
	 * This is an explicit compatibility escape hatch, never used by fork/capture
	 * publication itself.
	 */
	materialize(): Uint8Array;
}

/** @deprecated Use {@link TranscriptSnapshotHandle}; retained for call-site compatibility. */
export type CapturedSessionTranscriptSnapshot = TranscriptSnapshotHandle;

export type StrictSessionCaptureResult = { kind: "captured"; snapshot: TranscriptSnapshotHandle } | ResumeTailError;

export type StrictSessionForkResult = { kind: "forked"; manager: SessionManager } | StrictSessionOpenFailure;

/** Result of opening an inspected session without create-or-rewrite fallback. */
export type StrictSessionOpenResult = StrictSessionOpenSuccess | StrictSessionOpenFailure;

/**
 * Capability returned only by a strict recovery hydration open. It represents
 * immutable transcript authority and is consumed by the promotion seam.
 */
export interface RecoveryHydrationContext {
	readonly identity: ResumeSessionIdentity;
}

export interface RecoveryHydrationOpenSuccess {
	readonly kind: "hydrated";
	readonly manager: SessionManager;
	readonly context: RecoveryHydrationContext;
}

export type RecoveryHydrationOpenResult = RecoveryHydrationOpenSuccess | StrictSessionOpenFailure;

export interface RecoveryHydrationPromotionFence {
	/** The caller has durably published ownership and acquired its writer lease. */
	readonly ownershipReady: true;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	title?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/** True when messageCount was counted from only the bounded list prefix. */
	messageCountIsEstimate?: boolean;
	/** File size in bytes on disk; used for compact list rendering. */
	size: number;
	firstMessage: string;
	allMessagesText: string;
}
// =============================================================================
// Strict ACP authorization inventory (fail-closed, never partial authority)
// =============================================================================

/** Kind of failure surfaced by strict scoped inventory. Any failure grants zero authority. */
export type StrictInventoryFailureKind =
	| "root"
	| "scan"
	| "lstat"
	| "read"
	| "parse"
	| "stat"
	| "header"
	| "cwd"
	| "containment"
	| "identity";

/** Sanitized strict-inventory failure. Never carries raw file content. */
export interface StrictInventoryFailure {
	kind: StrictInventoryFailureKind;
	message: string;
	path?: string;
}

/** One exact-identity candidate suitable for ACP authorization binding. */
export interface StrictInventoryCandidate {
	/** Canonical absolute transcript path. */
	path: string;
	/** Session id parsed from the header. */
	id: string;
	/** Canonical cwd parsed from the header. */
	cwd: string;
	/** Descriptor-bound transcript identity (dev, ino, ...). */
	identity: SessionStorageStat;
}

/**
 * Strict inventory result. `complete` carries the full validated candidate set;
 * `failure` carries every sanitized failure and grants zero page/cursor/authority.
 * A failure result is never reduced to a partial candidate set.
 */
export type StrictInventoryResult =
	| { kind: "complete"; candidates: StrictInventoryCandidate[] }
	| { kind: "failure"; failures: StrictInventoryFailure[] };

/** Certainty-aware close outcome for strict ACP disposal. */
export type SessionManagerCloseOutcome =
	| { kind: "closed" }
	| { kind: "close_failed_retryable"; error: Error }
	| { kind: "close_unknown"; error: Error };

/** Read-only session state made available to extensions and custom tools. */
/** Frozen read-only session facade made available to extensions and custom tools. */
export interface ReadonlySessionManager {
	getCwd(): string;
	getSessionDir(): string;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionName(): string | undefined;
	getArtifactsDir(): string | null;
	getArtifactPath(id: string): Promise<string | null>;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getLabel(id: string): string | undefined;
	getBranch(fromId?: string): SessionEntry[];
	getHeader(): SessionHeader | null;
	getEntries(): SessionEntry[];
	getTree(): SessionTreeNode[];
	getUsageStatistics(): UsageStatistics;
}

function cloneAndFreezeSnapshot<T>(value: T): T {
	const cloned = cloneJsonSemantic(value);
	const freeze = (candidate: unknown, seen = new WeakSet<object>()): void => {
		if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
		seen.add(candidate);
		for (const child of Object.values(candidate)) freeze(child, seen);
		Object.freeze(candidate);
	};
	freeze(cloned);
	return cloned;
}

/** Creates an immutable facade that never exposes SessionManager mutation authority. */
export function createReadonlySessionManager(manager: SessionManager): ReadonlySessionManager {
	const facade = Object.freeze({
		getCwd: () => manager.getCwd(),
		getSessionDir: () => manager.getSessionDir(),
		getSessionId: () => manager.getSessionId(),
		getSessionFile: () => manager.getSessionFile(),
		getSessionName: () => manager.getSessionName(),
		getArtifactsDir: () => manager.getArtifactsDir(),
		getArtifactPath: (id: string) => manager.getArtifactPath(id),
		getLeafId: () => manager.getLeafId(),
		getLeafEntry: () => {
			const entry = manager.getLeafEntry();
			return entry === undefined ? undefined : cloneAndFreezeSnapshot(entry);
		},
		getEntry: (id: string) => {
			const entry = manager.getEntry(id);
			return entry === undefined ? undefined : cloneAndFreezeSnapshot(entry);
		},
		getLabel: (id: string) => manager.getLabel(id),
		getBranch: (fromId?: string) => cloneAndFreezeSnapshot(manager.getBranch(fromId)),
		getHeader: () => {
			const header = manager.getHeader();
			return header === null ? null : cloneAndFreezeSnapshot(header);
		},
		getEntries: () => cloneAndFreezeSnapshot(manager.getEntries()),
		getTree: () => cloneAndFreezeSnapshot(manager.getTree()),
		getUsageStatistics: () => cloneAndFreezeSnapshot(manager.getUsageStatistics()),
	});
	readonlySessionArtifactCapabilities.set(facade, sessionArtifactCapability(manager)!);
	return facade;
}

/** Internal artifact-writing capability. Read-only facades expose it only through a private weak-map lookup. */
export type SessionArtifactCapability = Readonly<
	Pick<SessionManager, "allocateArtifactPath" | "saveArtifact" | "putBlob">
>;

const sessionArtifactCapabilities = new WeakMap<SessionManager, SessionArtifactCapability>();
const readonlySessionArtifactCapabilities = new WeakMap<ReadonlySessionManager, SessionArtifactCapability>();

/**
 * Returns the artifact capability for a concrete persistence owner or one of its
 * immutable read-only facades. Structural lookalikes remain unauthorized.
 */
export function sessionArtifactCapability(value: unknown): SessionArtifactCapability | undefined {
	if (value instanceof SessionManager) {
		let capability = sessionArtifactCapabilities.get(value);
		if (!capability) {
			capability = Object.freeze({
				allocateArtifactPath: value.allocateArtifactPath.bind(value),
				saveArtifact: value.saveArtifact.bind(value),
				putBlob: value.putBlob.bind(value),
			});
			sessionArtifactCapabilities.set(value, capability);
		}
		return capability;
	}
	if (value === null || typeof value !== "object") return undefined;
	return readonlySessionArtifactCapabilities.get(value as ReadonlySessionManager);
}
function createSessionId(): string {
	return Bun.randomUUIDv7();
}

/**
 * A session id pre-allocated by the notifications lifecycle subsystem, when this
 * process was spawned by `/session_create`. Gated by `GJC_LIFECYCLE_REQUEST_ID`
 * so it ONLY applies to lifecycle-launched sessions (never normal launches): the
 * daemon tags the tmux session, endpoint discovery, and its `/session_recent`
 * id with this value, so the agent MUST adopt it as its header id or those ids
 * diverge (breaking close/resume-by-id after the session is gone).
 */
function lifecyclePreallocatedSessionId(): string | undefined {
	if (!process.env.GJC_LIFECYCLE_REQUEST_ID) return undefined;
	const id = process.env.GJC_SESSION_ID?.trim();
	if (!id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) return undefined;
	return id;
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	for (let i = 0; i < 100; i++) {
		const id = Snowflake.next();
		if (!byId.has(id)) return id;
	}
	throw new Error("Unable to generate a unique session entry id");
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message as { role?: string };
			if (msg.role === "hookMessage") {
				(entry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Run all necessary migrations to bring entries to the current semantic version.
 * Version 4 adds trailing patch records, so v3 transcripts must be atomically upgraded before they can receive one.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;
	if (version >= CURRENT_SESSION_VERSION) return false;
	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	const migratedHeader = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
	if (migratedHeader) migratedHeader.version = CURRENT_SESSION_VERSION;
	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const sessionsRoot = path.dirname(sessionDir);
	const resolved = resolveManagedScope({ cwd, agentDir: path.resolve(sessionsRoot, ".."), sessionsRoot });
	if (resolved.kind === "error") return undefined;
	return path.resolve(sessionDir) === path.resolve(resolved.scope.directoryPath) ? sessionsRoot : undefined;
}

/**
 * Resolve `target` through the real path of its nearest existing ancestor,
 * re-appending any not-yet-created trailing segments. Symlink/reparse components
 * in the existing prefix are canonicalized (so aliases cannot escape a containment
 * check or alias another file), while a missing leaf (e.g. an uncommitted session
 * transcript) is still resolved deterministically. Non-ENOENT errors (ELOOP,
 * EACCES, ...) surface rather than silently falling back to the lexical path.
 */
function canonicalizeThroughExistingAncestor(target: string): string {
	const resolved = path.resolve(target);
	const tail: string[] = [];
	let current = resolved;
	while (true) {
		try {
			const real = fs.realpathSync(current);
			return tail.length === 0 ? real : path.join(real, ...tail.reverse());
		} catch (err) {
			if (!isEnoent(err)) throw err;
			const parent = path.dirname(current);
			if (parent === current) return resolved;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

function isSupportedSessionVersion(version: unknown): boolean {
	return (
		version === undefined ||
		(typeof version === "number" && Number.isInteger(version) && version <= CURRENT_SESSION_VERSION)
	);
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const records = parseJsonlLenient<FileEntry | SessionPatchRecord>(content);
	return buildFileEntriesFromRecords(records);
}

function isHeaderPatchRecord(record: SessionPatchRecord): record is HeaderPatchRecord {
	if (
		record.type !== "header_patch" ||
		!isRecord(record.patch) ||
		!Object.keys(record).every(key => key === "type" || key === "patch")
	)
		return false;
	const keys = Object.keys(record.patch);
	if (!keys.every(key => key === "cwd" || key === "title" || key === "titleSource")) return false;
	const { cwd, title, titleSource } = record.patch;
	return (
		(cwd === undefined || typeof cwd === "string") &&
		(title === undefined || typeof title === "string") &&
		(titleSource === undefined || titleSource === "auto" || titleSource === "user")
	);
}

function applyHeaderPatch(header: SessionHeader, patch: HeaderPatchRecord["patch"]): void {
	if (patch.cwd !== undefined) header.cwd = patch.cwd;
	if (patch.title !== undefined) header.title = patch.title;
	if (patch.titleSource !== undefined) header.titleSource = patch.titleSource;
}

function isEntryPatchRecord(record: SessionPatchRecord): record is EntryPatchRecord {
	return (
		record.type === "entry_patch" &&
		typeof record.entryId === "string" &&
		isRecord(record.patch) &&
		Object.keys(record).every(key => key === "type" || key === "entryId" || key === "patch") &&
		Object.keys(record.patch).every(key => key === "message") &&
		(record.patch.message === undefined || isRecord(record.patch.message))
	);
}

function normalizeConfiguredModelChainEntry(entry: unknown): ConfiguredModelChain | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as Partial<ConfiguredModelChainEntry>;
	if (typeof candidate.role !== "string" || candidate.role.length === 0) return undefined;
	if (candidate.cleared === true) {
		return {
			role: candidate.role,
			entries: [],
			origin: typeof candidate.origin === "string" ? candidate.origin : "session",
			explicitHead: candidate.explicitHead === true,
			cleared: true,
		};
	}
	if (!Array.isArray(candidate.entries)) return undefined;
	const entries = candidate.entries.filter((model): model is string => typeof model === "string" && model.length > 0);
	if (entries.length === 0) return undefined;
	return {
		role: candidate.role,
		entries,
		origin: typeof candidate.origin === "string" ? candidate.origin : "session",
		...(typeof candidate.identity === "string" ? { identity: candidate.identity } : {}),
		explicitHead: candidate.explicitHead === true,
	};
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
/**
 * Retained-byte estimate for one JSON-like value, matching the accountant's
 * resident formula (string = 2 × chars + 16 B; array = 8 B/slot + elements;
 * record = 48 B overhead + fields; scalars = 8 B). Shared/cyclic references are
 * counted once via a visited set so the estimate reflects the materialized graph,
 * not an unbounded expansion.
 */
function measureJsonLikeBytes(value: unknown, visited = new Set<object>()): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "string") return 2 * value.length + 16;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return 8;
	if (typeof value !== "object") return 0;
	if (visited.has(value)) return 0;
	visited.add(value);
	if (Array.isArray(value)) {
		let bytes = value.length * 8;
		for (const item of value) bytes += measureJsonLikeBytes(item, visited);
		return bytes;
	}
	let bytes = 48;
	for (const key of Object.keys(value)) {
		bytes += 2 * key.length + 16;
		bytes += measureJsonLikeBytes((value as Record<string, unknown>)[key], visited);
	}
	return bytes;
}

/** Measure one materialized {@link SessionContext} and throw when over the budget. */
function assertSessionContextWithinBudget(context: SessionContext): SessionContext {
	const budgetBytes = effectiveSessionContextBudgetBytes();
	const measuredBytes = measureJsonLikeBytes(context);
	if (measuredBytes > budgetBytes) {
		throw new SessionContextTooLargeError(measuredBytes, budgetBytes);
	}
	return context;
}
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	sessionIdentityNamespace = "legacy-session",
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			configuredModelChains: {},

			injectedTtsrRules: [],
			injectedTtsrRuleRecords: [],
			ttsrMessageCount: 0,

			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			hasPersistedDiscoveredBuiltinToolSelection: false,
			mode: "none",
		};
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			configuredModelChains: {},

			injectedTtsrRules: [],
			injectedTtsrRuleRecords: [],
			ttsrMessageCount: 0,
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			hasPersistedDiscoveredBuiltinToolSelection: false,
			mode: "none",
		};
	}

	// Walk from leaf to root, then reverse once to avoid repeated front insertions on long branches.
	const path: SessionEntry[] = [];
	const visited = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current) {
		if (visited.has(current.id)) break;
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	// Extract settings and find compaction
	let thinkingLevel: string | undefined = "off";
	let serviceTier: ServiceTier | undefined;
	const models: Record<string, string> = {};
	const configuredModelChains: Record<string, ConfiguredModelChain> = {};

	let compaction: CompactionEntry | null = null;
	const injectedTtsrRulesSet = new Set<string>();
	const injectedTtsrRuleRecords = new Map<string, TtsrInjectionRecord>();
	let ttsrMessageCount = 0;

	let selectedMCPToolNames: string[] = [];
	let hasPersistedMCPToolSelection = false;
	let selectedDiscoveredBuiltinToolNames: string[] | undefined;
	let hasPersistedDiscoveredBuiltinToolSelection = false;
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;
	// Track whether an explicit `model_change` with role="default" has been
	// seen on this path. Once a user (or the agent itself) records an
	// explicit default, later assistant-message inference must NOT overwrite
	// it: temporary fallbacks (retry fallback, context promotion) and
	// server-side model downgrades both produce assistant messages tagged
	// with the wrong model id, which previously clobbered the user's pick on
	// resume (issue #849).
	// Legacy assistant-inference gate ONLY (see `getLastModelChangeRole` below): an
	// explicit `model_change` with role="default" blocks later assistant-message
	// inference into `models.default`. This flag never feeds `getLastModelChangeRole`,
	// which is keyed solely on the nearest `model_change` entry (R1).
	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
		} else if (entry.type === "model_change") {
			const role = entry.role ?? "default";
			if (entry.cleared) {
				delete models[role];
				if (role === "default") hasExplicitDefaultModel = true;
			} else if (entry.model) {
				models[role] = entry.model;
				if (role === "default") hasExplicitDefaultModel = true;
			}
		} else if (entry.type === "configured_model_chain") {
			const configuredChain = normalizeConfiguredModelChainEntry(entry);
			if (configuredChain?.cleared) {
				delete configuredModelChains[configuredChain.role];
			} else if (configuredChain) {
				configuredModelChains[configuredChain.role] = configuredChain;
			}
		} else if (entry.type === "service_tier_change") {
			serviceTier = entry.serviceTier ?? undefined;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// Legacy fallback: infer default model from assistant messages only
			// when no explicit `model_change` (role=default) entry has been
			// recorded yet. Newer sessions always record an explicit default
			// model_change at the start of the conversation, so this branch is
			// only used to keep pre-model_change sessions working.
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction") {
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
			// Collect injected TTSR rule names and richer records when present.
			for (const ruleName of entry.injectedRules) {
				injectedTtsrRulesSet.add(ruleName);
				if (!injectedTtsrRuleRecords.has(ruleName)) {
					injectedTtsrRuleRecords.set(ruleName, { name: ruleName, lastInjectedAt: 0 });
				}
			}
			for (const record of entry.injectedRuleRecords ?? []) {
				injectedTtsrRulesSet.add(record.name);
				injectedTtsrRuleRecords.set(record.name, record);
			}
			if (typeof entry.ttsrMessageCount === "number" && Number.isFinite(entry.ttsrMessageCount)) {
				ttsrMessageCount = entry.ttsrMessageCount;
			}
		} else if (entry.type === "mcp_tool_selection") {
			selectedMCPToolNames = [...entry.selectedToolNames];
			if (entry.selectedDiscoveredBuiltinToolNames !== undefined) {
				selectedDiscoveredBuiltinToolNames = [...entry.selectedDiscoveredBuiltinToolNames];
				hasPersistedDiscoveredBuiltinToolSelection = true;
			}
			hasPersistedMCPToolSelection = true;
		} else if (entry.type === "discovered_builtin_tool_selection") {
			selectedDiscoveredBuiltinToolNames = [...entry.selectedToolNames];
			hasPersistedDiscoveredBuiltinToolSelection = true;
		} else if (entry.type === "mode_change") {
			mode = entry.mode;
			modeData = entry.data;
		}
	}

	const injectedTtsrRules = Array.from(injectedTtsrRulesSet);
	for (const [role, model] of Object.entries(models)) {
		if (role in configuredModelChains) continue;
		configuredModelChains[role] = {
			role,
			entries: [model],
			origin: "legacy_session",
			explicitHead: true,
		};
	}

	const injectedTtsrRuleRecordsArray = Array.from(injectedTtsrRuleRecords.values());

	// Build messages and collect corresponding entries
	// When there's a compaction, we need to:
	// 1. Emit summary first (entry = compaction)
	// 2. Emit kept messages (from firstKeptEntryId up to compaction)
	// 3. Emit messages after compaction
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			associateSessionMessageEntryId(entry.message, entry.id);
			messages.push(entry.message);
		} else if (entry.type === "custom_message") {
			const message = createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.attribution,
			);
			associateSessionMessageEntryId(message, entry.id);
			const persistedObservationId =
				entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)
					? (entry.details as Record<string, unknown>).observationId
					: undefined;
			associateSessionMessageObservationId(
				message,
				typeof persistedObservationId === "string"
					? persistedObservationId
					: `session:${sessionIdentityNamespace}:entry:${entry.id}`,
			);
			messages.push(message);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (compaction) {
		const providerPayload: ProviderPayload | undefined = (() => {
			const candidate = compaction.preserveData?.openaiRemoteCompaction;
			if (!candidate || typeof candidate !== "object") return undefined;
			const remote = candidate as { provider?: unknown; replacementHistory?: unknown };
			if (typeof remote.provider !== "string" || remote.provider.length === 0) return undefined;
			if (!Array.isArray(remote.replacementHistory)) return undefined;
			return {
				type: "openaiResponsesHistory",
				provider: remote.provider,
				items: remote.replacementHistory as Array<Record<string, unknown>>,
			};
		})();
		const remoteReplacementHistory = providerPayload?.items;

		// Emit summary first
		messages.push(
			createCompactionSummaryMessage(
				compaction.summary,
				compaction.tokensBefore,
				compaction.timestamp,
				compaction.shortSummary,
				providerPayload,
			),
		);

		// Find compaction index in path
		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

		if (!remoteReplacementHistory) {
			// Emit kept messages (before compaction, starting from firstKeptEntryId)
			let foundFirstKept = false;
			for (let i = 0; i < compactionIdx; i++) {
				const entry = path[i];
				if (entry.id === compaction.firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (foundFirstKept) {
					appendMessage(entry);
				}
			}
		}

		// Emit messages after compaction
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// No compaction - emit all messages, handle branch summaries and custom messages
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	return assertSessionContextWithinBudget({
		messages,
		thinkingLevel,
		serviceTier,
		models,
		configuredModelChains,

		injectedTtsrRules,
		injectedTtsrRuleRecords: injectedTtsrRuleRecordsArray,
		ttsrMessageCount,

		selectedMCPToolNames,
		selectedDiscoveredBuiltinToolNames,
		hasPersistedMCPToolSelection,
		hasPersistedDiscoveredBuiltinToolSelection,
		mode,
		modeData,
	});
}

function cloneSessionContext(context: SessionContext): SessionContext {
	const messages = cloneJsonSemantic(context.messages);
	transferSessionMessageIdentity(context.messages, messages);
	return {
		...context,
		messages,
		models: { ...context.models },
		configuredModelChains: Object.fromEntries(
			Object.entries(context.configuredModelChains ?? {}).map(([role, chain]) => [
				role,
				{ ...chain, entries: [...chain.entries] },
			]),
		),

		injectedTtsrRules: [...context.injectedTtsrRules],
		injectedTtsrRuleRecords: context.injectedTtsrRuleRecords?.map(record => ({ ...record })),
		ttsrMessageCount: context.ttsrMessageCount,

		selectedMCPToolNames: [...context.selectedMCPToolNames],
		selectedDiscoveredBuiltinToolNames: context.selectedDiscoveredBuiltinToolNames
			? [...context.selectedDiscoveredBuiltinToolNames]
			: undefined,
		modeData: cloneJsonSemantic(context.modeData),
	};
}

function freezeInternalReadSnapshot<T>(value: T): T {
	if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") return value;
	const copy = cloneJsonSemantic(value);
	const freeze = (item: unknown): void => {
		if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
		for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
		Object.freeze(item);
	};
	freeze(copy);
	return copy;
}

function managedScopeStartupError(
	action: "resolve" | "prepare",
	failure: Extract<ReturnType<typeof resolveManagedScopeForWrite>, { kind: "error" }>,
): Error {
	const classification = failure.cause?.classification ?? failure.code;
	const diagnostic = failure.cause?.diagnostic;
	const detail = diagnostic === undefined ? classification : `${classification}: ${diagnostic}`;
	const message =
		action === "prepare"
			? `Could not prepare managed session scope (${detail}).`
			: "Could not resolve managed session scope.";
	return new Error(message, {
		cause: {
			classification,
			...(diagnostic === undefined ? {} : { diagnostic }),
		},
	});
}

/** Resolve and prepare the default v2 session scope before any managed writer exists. */
function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	if (!(storage instanceof FileSessionStorage)) throw new SessionManagedStorageError();
	const resolved = resolveManagedScopeForWrite({ cwd, agentDir: path.resolve(sessionsRoot, ".."), sessionsRoot });
	if (resolved.kind === "error") throw managedScopeStartupError("resolve", resolved);
	const prepared = prepareManagedSessionScopeForWriteSync(
		resolved.scope,
		process.platform === "win32" ? "windows-existing-verify-first" : "default",
	);
	if (prepared.kind === "error") throw managedScopeStartupError("prepare", prepared);
	return prepared.scope.directoryPath;
}

/** A session directory's authority is distinct from its string path. */
export type SessionDestination =
	| { readonly kind: "managed"; readonly directory: string; readonly securityContext: ManagedSessionSecurityContext }
	| { readonly kind: "explicit"; readonly directory: string };
export type SessionDestinationInput = string | SessionDestination | undefined;

type ForkArtifactPublication =
	| {
			readonly kind: "managed";
			readonly snapshot: native.NativeDirectoryTreeSnapshot;
			readonly store: ManagedSessionDescendantStore;
			readonly cleanupStore: ManagedSessionDescendantStore;
			readonly cleanupRelativePath: string;
	  }
	| {
			readonly kind: "explicit";
			readonly artifactsDir: string;
			readonly snapshot: native.NativeDirectoryTreeSnapshot;
	  };

type ForkTranscriptPublication =
	| {
			readonly kind: "managed";
			readonly store: ManagedSessionDescendantStore;
			readonly relativePath: string;
			readonly sessionFile: string;
			/** SHA-256 of the bytes installed by no-replace publication. */
			readonly publishedSha256: string;
	  }
	| {
			readonly kind: "explicit-file";
			readonly sessionFile: string;
			/** SHA-256 of the bytes installed by no-replace publication. */
			readonly publishedSha256: string;
	  }
	| {
			readonly kind: "explicit-storage";
			readonly sessionFile: string;
			/** SHA-256 of the bytes installed by transcript publication. */
			readonly publishedSha256: string;
	  };

function pruneResidentCacheEntries(snapshot: native.NativeDirectoryTreeSnapshot): native.NativeDirectoryTreeSnapshot {
	return {
		...snapshot,
		entries: snapshot.entries.filter(
			entry =>
				entry.relativePath !== "resident-cache" &&
				!entry.relativePath.startsWith("resident-cache/") &&
				!isDerivedSessionMemoryFile(entry.relativePath),
		),
	};
}

function retainedTreeSnapshotEquals(
	left: native.NativeDirectoryTreeSnapshot,
	right: native.NativeDirectoryTreeSnapshot,
): boolean {
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		left.entries.length === right.entries.length &&
		left.entries.every((entry, index) => {
			const other = right.entries[index];
			return (
				other !== undefined &&
				entry.relativePath === other.relativePath &&
				entry.kind === other.kind &&
				entry.dev === other.dev &&
				entry.ino === other.ino &&
				entry.nlink === other.nlink &&
				entry.size === other.size &&
				entry.mtimeNs === other.mtimeNs &&
				entry.ctimeNs === other.ctimeNs &&
				entry.sha256 === other.sha256
			);
		})
	);
}

function retainedTreeSnapshotEqualsAfterRename(
	left: native.NativeDirectoryTreeSnapshot,
	right: native.NativeDirectoryTreeSnapshot,
): boolean {
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		left.entries.length === right.entries.length &&
		left.entries.every((entry, index) => {
			const other = right.entries[index];
			return (
				other !== undefined &&
				entry.relativePath === other.relativePath &&
				entry.kind === other.kind &&
				entry.dev === other.dev &&
				entry.ino === other.ino &&
				entry.nlink === other.nlink &&
				entry.size === other.size &&
				entry.mtimeNs === other.mtimeNs &&
				(entry.relativePath === "" || entry.ctimeNs === other.ctimeNs) &&
				entry.sha256 === other.sha256
			);
		})
	);
}

/**
 * True when a cleanup error only reports the authorized POSIX quarantine.
 *
 * `exact_remove_directory_tree` and `removeManagedTree` cannot bind the final
 * unlink to the verified root descriptor on POSIX, so they detach the tree to a
 * no-replace `<name>.removing` name and report `cleanup_pending`. No live
 * artifact survives that outcome, so it is a SUCCESSFUL cleanup and must never
 * supersede the primary failure that triggered it.
 */
function isAuthorizedPendingCleanup(cleanupError: Error): boolean {
	return cleanupError.message === "cleanup_pending";
}

/**
 * Remove a fork-staging root this process created, re-proving ownership first.
 * Returns undefined when the root is gone or authorized-pending; otherwise returns
 * a stable cleanup code the caller wraps with the original failure as `cause`.
 */
function removeOwnedForkStaging(stagingDir: string, ownedRoot: native.NativeDirectoryTreeSnapshot): string | undefined {
	let current: native.NativeDirectoryTreeResult;
	try {
		current = nativeSessionManager().snapshotDirectoryTree(stagingDir);
	} catch (snapshotError) {
		return `staging_snapshot_threw:${toError(snapshotError).message}`;
	}
	if (!current.ok || !current.snapshot) {
		// Only VERIFIED ABSENCE means there is nothing to clean.
		return current.code === "not_found" ? undefined : (current.code ?? "staging_snapshot_failed");
	}
	// Rule R: identity, not pathname, authorizes the delete. Entries may be enumerated
	// now because they live inside a root we created; the ROOT must be the one we made.
	if (current.snapshot.rootDev !== ownedRoot.rootDev || current.snapshot.rootIno !== ownedRoot.rootIno)
		return "staging_identity_mismatch";
	const removed = nativeSessionManager().exactRemoveDirectoryTree(stagingDir, current.snapshot);
	if (removed.ok) return undefined;
	if (removed.code === "not_found") return undefined;
	const cleanupPending =
		removed.code === "cleanup_pending" &&
		(removed.detachedPath ??
			removed.retainedSuccessorPath ??
			removed.retainedPlaceholderPath ??
			removed.retainedUnknownPath) !== undefined;
	return cleanupPending ? undefined : (removed.code ?? "staging_remove_failed");
}

function managedFileSnapshotEquals(left: ManagedFileSnapshot | null, right: ManagedFileSnapshot | null): boolean {
	return (
		left !== null &&
		right !== null &&
		left.identity.dev === right.identity.dev &&
		left.identity.ino === right.identity.ino &&
		left.identity.size === right.identity.size &&
		left.identity.mtimeNs === right.identity.mtimeNs &&
		left.identity.ctimeNs === right.identity.ctimeNs &&
		left.identity.sha256 === right.identity.sha256 &&
		left.bytes.equals(right.bytes)
	);
}

function managedFileSnapshotMatchesDescriptor(snapshot: ManagedFileSnapshot, descriptor: DescriptorSnapshot): boolean {
	return (
		snapshot.identity.dev === descriptor.dev &&
		snapshot.identity.ino === descriptor.ino &&
		snapshot.identity.nlink === descriptor.nlink &&
		snapshot.identity.size === descriptor.size &&
		snapshot.identity.mtimeNs === descriptor.mtimeNs &&
		snapshot.identity.ctimeNs === descriptor.ctimeNs
	);
}

function unrefDelay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return promise;
}
const trustedSessionDestinations = new WeakSet<SessionDestination>();
const explicitProfileAgentDirs = new WeakMap<SessionDestination, string>();
const managedSecurityPolicies = new WeakMap<ManagedSessionSecurityContext, ManagedSessionSecurityPolicy>();

function managedSecurityPolicyForContext(securityContext: ManagedSessionSecurityContext): ManagedSessionSecurityPolicy {
	const policy = managedSecurityPolicies.get(securityContext);
	if (!policy) throw new Error("Managed session security policy unavailable");
	return policy;
}

function managedStoreFromContext(
	securityContext: ManagedSessionSecurityContext,
	directory: string,
): ManagedSessionDescendantStore {
	// A retained fd authority is bound to the exact directory it was retained for.
	// For any other directory the store must re-derive its own authority from the
	// shared root instead of inheriting a binding that describes a different inode.
	const ownsRetainedAuthority = path.resolve(directory) === path.resolve(securityContext.sessionDir);
	return new ManagedSessionDescendantStore(
		securityContext.rootAuthority,
		directory,
		securityContext.retainedAuthority && ownsRetainedAuthority
			? { authority: securityContext.retainedAuthority, authorityBaseDir: directory }
			: undefined,
		managedSecurityPolicyForContext(securityContext),
		securityContext.profileAgentDir,
	);
}

function freezeManagedDestination(scope: ManagedScope, profileAgentDir: string): SessionDestination {
	const rootAuthority = managedRootForScope(scope);
	const securityContext = createManagedSessionSecurityContext({
		agentDir: scope.agentDir,
		profileAgentDir,
		sessionsRoot: scope.sessionsRoot,
		sessionDir: scope.directoryPath,
		rootAuthority,
		retainedAuthority: managedDirectoryAuthorityForScope(scope),
	});
	managedSecurityPolicies.set(
		securityContext,
		scope.platform === "win32" ? "windows-existing-verify-first" : "default",
	);
	const destination = Object.freeze({ kind: "managed" as const, directory: scope.directoryPath, securityContext });
	trustedSessionDestinations.add(destination);
	return destination;
}

function explicitDestination(directory: string): SessionDestination {
	const destination = Object.freeze({ kind: "explicit" as const, directory });
	trustedSessionDestinations.add(destination);
	explicitProfileAgentDirs.set(destination, getAgentDir());
	return destination;
}

function managedDestination(cwd: string, storage: SessionStorage, agentDir?: string): SessionDestination {
	if (!(storage instanceof FileSessionStorage)) throw new SessionManagedStorageError();
	const sessionsRoot = getSessionsDir(agentDir);
	const resolved = resolveManagedScopeForWrite({
		cwd,
		agentDir: agentDir ?? path.resolve(sessionsRoot, ".."),
		sessionsRoot,
	});
	if (resolved.kind === "error") throw managedScopeStartupError("resolve", resolved);
	const prepared = prepareManagedSessionScopeForWriteSync(
		resolved.scope,
		process.platform === "win32" ? "windows-existing-verify-first" : "default",
	);
	if (prepared.kind === "error") throw managedScopeStartupError("prepare", prepared);
	return freezeManagedDestination(prepared.scope, agentDir ?? getAgentDir());
}

function destinationFor(
	cwd: string,
	input: SessionDestinationInput,
	storage: SessionStorage,
	agentDir?: string,
): SessionDestination {
	if (typeof input === "object") {
		if (!trustedSessionDestinations.has(input)) throw new Error("Untrusted session destination authority");
		return input;
	}
	return input === undefined ? managedDestination(cwd, storage, agentDir) : explicitDestination(input);
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 */
function writeTerminalBreadcrumb(cwd: string, sessionFile: string): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const content = `${cwd}\n${sessionFile}\n`;
	// Best-effort — don't break session creation if breadcrumb fails
	const write = isUnderProjectGjc(cwd, breadcrumbFile)
		? writeTextAtomic(breadcrumbFile, content, {
				cwd,
				audit: { category: "artifact", verb: "write", owner: "gjc-runtime" },
			})
		: Bun.write(breadcrumbFile, content);
	write.catch(() => {});
}

/**
 * Two paths belong to linked worktrees of the same repository when they share a
 * git common dir but resolve to different git dirs (i.e. one is a `git worktree`
 * of the other). `--worktree` sessions run from such a linked worktree, so a
 * `--continue` from the main checkout should still resolve their breadcrumb.
 */
function isLinkedWorktreePeer(a: string, b: string): boolean {
	const ra = git.repo.resolveSync(a);
	const rb = git.repo.resolveSync(b);
	if (ra === null || rb === null) return false;
	// Canonicalize: a worktree's commondir is stored as an absolute path that may
	// differ from the main checkout only by a symlink prefix (e.g. macOS
	// /tmp -> /private/tmp), so compare resolved-equivalent paths.
	return (
		resolveEquivalentPath(ra.commonDir) === resolveEquivalentPath(rb.commonDir) &&
		resolveEquivalentPath(ra.gitDir) !== resolveEquivalentPath(rb.gitDir)
	);
}

/**
 * Read the terminal breadcrumb for the current terminal, scoped to a cwd.
 * Returns the session file path if it exists and matches the cwd, null otherwise.
 */
async function readTerminalBreadcrumb(cwd: string): Promise<string | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];

		// Honor the breadcrumb when the cwd matches, or when it points to a linked
		// worktree of the same repository (e.g. a `--worktree` session resumed from
		// the main checkout). A genuinely different project is still ignored.
		if (path.resolve(breadcrumbCwd) !== path.resolve(cwd) && !isLinkedWorktreePeer(breadcrumbCwd, cwd)) {
			return null;
		}

		if (isStagedSessionPath(sessionFile)) return null;
		const inspected = inspectResumeSessionFile(sessionFile, new FileSessionStorage());
		if ("kind" in inspected) {
			if (inspected.reason !== "missing") return null;
			const sessionsRoot = getSessionsDir();
			const resolved = resolveManagedScope({
				cwd: breadcrumbCwd,
				agentDir: path.resolve(sessionsRoot, ".."),
				sessionsRoot,
			});
			if (resolved.kind !== "resolved") return null;
			const listing = listManagedCandidates(resolved.scope);
			if (listing.kind !== "complete") return null;
			const migrated = listing.owned.filter(
				candidate =>
					!isStagedSessionPath(candidate.path) && path.basename(candidate.path) === path.basename(sessionFile),
			);
			return migrated.length === 1 ? migrated[0]!.path : null;
		}
		const header = inspected.entries[0] as SessionHeader;
		if (resolveEquivalentPath(header.cwd) !== resolveEquivalentPath(breadcrumbCwd)) return null;
		const sessionsRoot = getSessionsDir();
		const resolved = resolveManagedScope({
			cwd: header.cwd,
			agentDir: path.resolve(sessionsRoot, ".."),
			sessionsRoot,
		});
		if (resolved.kind !== "resolved") return null;
		const listing = listManagedCandidates(resolved.scope);
		if (listing.kind !== "complete") return null;
		const exact = listing.owned.find(
			candidate =>
				!isStagedSessionPath(candidate.path) && path.resolve(candidate.path) === path.resolve(sessionFile),
		);
		if (exact) return exact.path;
		const byIdentity = listing.owned.find(
			candidate => !isStagedSessionPath(candidate.path) && candidate.sessionId === header.id,
		);
		if (byIdentity) return byIdentity.path;
		return pathIsWithin(sessionsRoot, path.resolve(sessionFile)) ? null : path.resolve(sessionFile);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}

/** Exported for testing */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<FileEntry[]> {
	let content: string;
	try {
		content = await storage.readText(filePath);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries = parseSessionEntries(content);

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") {
		return [];
	}

	return entries;
}

function sameResumeIdentity(left: ResumeSessionIdentity, right: ResumeSessionIdentity): boolean {
	return (
		left.canonicalPath === right.canonicalPath &&
		left.sessionId === right.sessionId &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mtimeNs === right.mtimeNs &&
		(left.ctimeNs === undefined || right.ctimeNs === undefined || left.ctimeNs === right.ctimeNs) &&
		left.sha256 === right.sha256
	);
}

function sameResumeStat(left: SessionStorageStat, right: SessionStorageStat): boolean {
	return (
		left.isFile &&
		right.isFile &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function resumeIdentityMatchesDescriptor(identity: ResumeSessionIdentity, descriptor: DescriptorSnapshot): boolean {
	return (
		identity.dev === descriptor.dev &&
		identity.ino === descriptor.ino &&
		identity.nlink === descriptor.nlink &&
		identity.size === descriptor.size &&
		identity.mtimeNs === descriptor.mtimeNs &&
		(identity.ctimeNs === undefined || identity.ctimeNs === descriptor.ctimeNs)
	);
}

function descriptorSnapshotAsStorageStat(descriptor: DescriptorSnapshot): SessionStorageStat {
	const mtimeMs = Number(descriptor.mtimeNs) / 1_000_000;
	return { ...descriptor, mtimeMs, mtime: new Date(mtimeMs), isFile: true };
}

function managedIdentityFromDescriptor(descriptor: DescriptorSnapshot): ManagedFileIdentity {
	if (descriptor.nlink === undefined) throw new Error("managed_identity_nlink_unavailable");
	return {
		dev: descriptor.dev,
		ino: descriptor.ino,
		nlink: descriptor.nlink,
		size: descriptor.size,
		mtimeNs: descriptor.mtimeNs,
		ctimeNs: descriptor.ctimeNs,
	};
}

function retainedManagedInspectionStorage(
	storage: SessionStorage,
	store: ManagedSessionDescendantStore,
	filePath: string,
): SessionStorage {
	const resolved = path.resolve(filePath);
	const relative = path.basename(resolved);
	const statExpected = (): SessionStorageStat => {
		store.assertBound();
		const descriptor = store.descriptorExpected(relative);
		if (!descriptor) throw Object.assign(new Error("Managed file not found"), { code: "ENOENT" });
		return descriptorSnapshotAsStorageStat(descriptor);
	};
	return new Proxy(storage, {
		get: (target, property) => {
			if (property === "statSync")
				return (candidate: string) =>
					path.resolve(candidate) === resolved ? statExpected() : target.statSync(candidate);
			if (property === "existsSync")
				return (candidate: string) =>
					path.resolve(candidate) === resolved
						? store.descriptorExpected(relative) !== null
						: target.existsSync(candidate);
			if (property === "readSnapshotSync")
				return (candidate: string) => {
					if (path.resolve(candidate) !== resolved) return target.readSnapshotSync!(candidate);
					const before = statExpected();
					const snapshot = store.readExpected(relative);
					if (!snapshot) throw Object.assign(new Error("Managed file not found"), { code: "ENOENT" });
					const after = statExpected();
					if (!sameResumeStat(before, after)) throw new Error("source_changed");
					return { bytes: snapshot.bytes, stat: before };
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

interface ResumeInspectionSnapshot {
	identity: ResumeSessionIdentity;
	content: Uint8Array;
	entries: FileEntry[];
	context: SessionContext;
	migrationApplied: boolean;
}

function resumeReadFailure(error: unknown, storage: SessionStorage, path: string): ResumeTailError {
	let missing = isEnoent(error);
	if (!missing) {
		try {
			missing = !storage.existsSync(path);
		} catch {
			// Preserve the primary read/stat failure when existence cannot be checked.
		}
	}
	return { kind: "error", reason: missing ? "missing" : "read-failed" };
}

function hasStrictSessionSchema(entries: readonly FileEntry[]): boolean {
	for (const entry of entries) {
		const value = entry as unknown as Record<string, unknown>;
		if (typeof value.type !== "string") return false;
		if (value.type === "session") {
			if (typeof value.id !== "string" || typeof value.cwd !== "string" || typeof value.timestamp !== "string")
				return false;
			continue;
		}
		if (
			typeof value.id !== "string" ||
			(value.parentId !== null && typeof value.parentId !== "string") ||
			typeof value.timestamp !== "string"
		) {
			return false;
		}
		switch (value.type) {
			case "message": {
				if (typeof value.message !== "object" || value.message === null) return false;
				const message = value.message as Record<string, unknown>;
				if (typeof message.role !== "string") return false;
				break;
			}
			case "model_change":
				if (
					typeof value.model !== "string" &&
					!(typeof value.provider === "string" && typeof value.modelId === "string")
				)
					return false;
				break;
			case "configured_model_chain":
				if (!normalizeConfiguredModelChainEntry(value)) return false;
				break;
			case "compaction":
				if (
					typeof value.summary !== "string" ||
					typeof value.firstKeptEntryId !== "string" ||
					typeof value.tokensBefore !== "number"
				)
					return false;
				break;
			case "branch_summary":
				if (typeof value.fromId !== "string" || typeof value.summary !== "string") return false;
				break;
			case "custom":
				if (typeof value.customType !== "string") return false;
				break;
			case "custom_message":
				if (
					typeof value.customType !== "string" ||
					(typeof value.content !== "string" && !Array.isArray(value.content)) ||
					typeof value.display !== "boolean"
				)
					return false;
				break;
			case "label":
				if (typeof value.targetId !== "string" || (value.label !== undefined && typeof value.label !== "string"))
					return false;
				break;
			case "ttsr_injection":
				if (!Array.isArray(value.injectedRules) || !value.injectedRules.every(rule => typeof rule === "string"))
					return false;
				break;
			case "mcp_tool_selection":
				if (
					!Array.isArray(value.selectedToolNames) ||
					!value.selectedToolNames.every(name => typeof name === "string") ||
					(value.selectedDiscoveredBuiltinToolNames !== undefined &&
						(!Array.isArray(value.selectedDiscoveredBuiltinToolNames) ||
							!value.selectedDiscoveredBuiltinToolNames.every(name => typeof name === "string"))) ||
					(value.mutationCorrelationId !== undefined && typeof value.mutationCorrelationId !== "string")
				)
					return false;
				break;
			case "discovered_builtin_tool_selection":
				if (
					!Array.isArray(value.selectedToolNames) ||
					!value.selectedToolNames.every(name => typeof name === "string") ||
					(value.mutationCorrelationId !== undefined && typeof value.mutationCorrelationId !== "string")
				)
					return false;
				break;
			case "session_init":
				if (
					typeof value.systemPrompt !== "string" ||
					typeof value.task !== "string" ||
					!Array.isArray(value.tools) ||
					!value.tools.every(tool => typeof tool === "string")
				)
					return false;
				break;
			case "mode_change":
				if (typeof value.mode !== "string") return false;
				break;
			case "thinking_level_change":
				if (
					value.thinkingLevel !== undefined &&
					value.thinkingLevel !== null &&
					typeof value.thinkingLevel !== "string"
				)
					return false;
				if (value.operatorIntent !== undefined && typeof value.operatorIntent !== "boolean") return false;
				break;
			case "service_tier_change":
				if (value.serviceTier !== null && typeof value.serviceTier !== "string") return false;
				break;
			default:
				return false;
		}
	}
	return true;
}

function inspectResumeSessionFile(
	filePath: string,
	storage: SessionStorage,
): ResumeInspectionSnapshot | ResumeTailError {
	const canonicalPath = resolveEquivalentPath(path.resolve(filePath));
	let before: SessionStorageStat;
	try {
		before = storage.statSync(canonicalPath);
	} catch (error) {
		return resumeReadFailure(error, storage, canonicalPath);
	}
	if (!before.isFile || !storage.readSnapshotSync) {
		return { kind: "error", reason: "read-failed" };
	}
	// Fail closed on oversized transcripts before the full read/decode/parse
	// path that would otherwise OOM or stall the process (#3851). The stat is
	// already in hand; this bound matches the managed-storage per-file limit.
	if (before.size > RESUME_TRANSCRIPT_MAX_BYTES) {
		return { kind: "error", reason: "oversized", size: before.size };
	}

	let bytes: Uint8Array;
	let snapshot: SessionStorageStat;
	let after: SessionStorageStat;
	try {
		const readSnapshot = storage.readSnapshotSync(canonicalPath);
		bytes = readSnapshot.bytes;
		snapshot = readSnapshot.stat;
		after = storage.statSync(canonicalPath);
	} catch (error) {
		return resumeReadFailure(error, storage, canonicalPath);
	}
	if (!sameResumeStat(before, snapshot) || !sameResumeStat(snapshot, after)) {
		return { kind: "error", reason: "unstable" };
	}

	try {
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		for (const line of content.split(/\r?\n/)) {
			if (line.length === 0) continue;
			JSON.parse(line);
		}
		const entries = parseSessionEntries(content);
		const header = entries[0] as SessionHeader | undefined;
		if (header?.type !== "session" || typeof header.id !== "string") {
			return { kind: "error", reason: "malformed" };
		}
		const migrationApplied = migrateToCurrentVersion(entries);
		if (!hasStrictSessionSchema(entries)) return { kind: "error", reason: "malformed" };
		const context = buildSessionContext(
			entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
			undefined,
			undefined,
			header.id,
		);
		const identity: ResumeSessionIdentity = {
			canonicalPath,
			sessionId: header.id,
			dev: snapshot.dev,
			ino: snapshot.ino,
			nlink: snapshot.nlink,
			size: snapshot.size,
			mtimeMs: snapshot.mtimeMs,
			mtimeNs: snapshot.mtimeNs,
			ctimeNs: snapshot.ctimeNs,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
		};
		return { identity, content: bytes, entries, context, migrationApplied };
	} catch (error) {
		// A synchronous builder overflow is a typed, non-malformed result: the
		// transcript parsed and migrated cleanly but its materialized context
		// exceeds the operation budget. Startup must fail closed with the typed
		// reason and never misreport it as a corrupt transcript.
		if (error instanceof SessionContextTooLargeError) {
			return { kind: "error", reason: "context_too_large", size: error.measuredBytes };
		}
		return { kind: "error", reason: "malformed" };
	}
}
export const TRANSCRIPT_CAPTURE_CHUNK_BYTES = 64 * 1024;
const TRANSCRIPT_LINE_TERMINATOR = Buffer.from("\n", "utf8");

interface BoundedTranscriptInspection {
	identity: ResumeSessionIdentity;
	cwd: string | undefined;
}

function inspectTranscriptHeaderBounded(
	filePath: string,
	storage: SessionStorage,
	maxBytes: number,
): { ok: true; inspection: { cwd: string | undefined } } | { ok: false; error: ResumeTailError } {
	const canonicalPath = resolveEquivalentPath(path.resolve(filePath));
	let before: SessionStorageStat;
	try {
		before = storage.statSync(canonicalPath);
	} catch (error) {
		return { ok: false, error: resumeReadFailure(error, storage, canonicalPath) };
	}
	if (!before.isFile || typeof storage.readRangeSync !== "function")
		return { ok: false, error: { kind: "error", reason: "read-failed" } };
	if (before.size > maxBytes) return { ok: false, error: { kind: "error", reason: "oversized", size: before.size } };
	if (before.size === 0) return { ok: false, error: { kind: "error", reason: "malformed" } };
	try {
		const length = Math.min(before.size, BOUNDED_FIRST_OPEN_MAX_LINE_BYTES + 1);
		const range = storage.readRangeSync(canonicalPath, 0, length);
		if (!sameResumeStat(before, range.stat)) return { ok: false, error: { kind: "error", reason: "unstable" } };
		const newline = range.bytes.indexOf(0x0a);
		if (newline < 0 || newline > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES)
			return { ok: false, error: { kind: "error", reason: "malformed" } };
		const text = new TextDecoder("utf-8", { fatal: true }).decode(range.bytes.subarray(0, newline));
		const header = JSON.parse(text) as Partial<SessionHeader>;
		if (header.type !== "session" || typeof header.id !== "string")
			return { ok: false, error: { kind: "error", reason: "malformed" } };
		const after = storage.statSync(canonicalPath);
		if (!sameResumeStat(before, after)) return { ok: false, error: { kind: "error", reason: "unstable" } };
		return { ok: true, inspection: { cwd: typeof header.cwd === "string" ? header.cwd : undefined } };
	} catch {
		return { ok: false, error: { kind: "error", reason: "malformed" } };
	}
}

/**
 * Bounded strict transcript inspection that never materializes the whole file.
 * Header and identity are derived from descriptor-validated range reads; the
 * running content hash covers the exact captured bytes.
 */
function inspectTranscriptBounded(
	filePath: string,
	storage: SessionStorage,
	maxBytes = RESUME_TRANSCRIPT_MAX_BYTES,
): { ok: true; inspection: BoundedTranscriptInspection } | { ok: false; error: ResumeTailError } {
	const canonicalPath = resolveEquivalentPath(path.resolve(filePath));
	let before: SessionStorageStat;
	try {
		before = storage.statSync(canonicalPath);
	} catch (error) {
		return { ok: false, error: resumeReadFailure(error, storage, canonicalPath) };
	}
	if (!before.isFile || typeof storage.readRangeSync !== "function") {
		return { ok: false, error: { kind: "error", reason: "read-failed" } };
	}
	if (before.size > maxBytes) {
		return { ok: false, error: { kind: "error", reason: "oversized", size: before.size } };
	}

	const hash = crypto.createHash("sha256");
	let sessionId: string | undefined;
	let cwd: string | undefined;
	const scanResult: { stat?: SessionStorageStat } = {};
	const scanFailure = scanTranscriptLinesBounded(
		storage,
		canonicalPath,
		before.size,
		(_lineStart, lineBytes) => {
			hash.update(lineBytes);
			if (lineBytes.byteLength === 1 && lineBytes[0] === 0x0a) return;
			try {
				const parsed = JSON.parse(decodeBoundedJsonLine(lineBytes)) as SessionHeader;
				if (sessionId === undefined) {
					if (parsed.type !== "session" || typeof parsed.id !== "string") return false;
					sessionId = parsed.id;
					cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
				}
				return;
			} catch {
				return false;
			}
		},
		scanResult,
		true,
		true,
	);
	if (scanFailure) {
		return {
			ok: false,
			error: { kind: "error", reason: scanFailure === "read_failed" ? "read-failed" : "malformed" },
		};
	}
	if (scanResult.stat && !sameResumeStat(before, scanResult.stat))
		return { ok: false, error: { kind: "error", reason: "unstable" } };
	if (sessionId === undefined) return { ok: false, error: { kind: "error", reason: "malformed" } };

	let after: SessionStorageStat;
	try {
		after = storage.statSync(canonicalPath);
	} catch (error) {
		return { ok: false, error: resumeReadFailure(error, storage, canonicalPath) };
	}
	if (!sameResumeStat(before, after)) return { ok: false, error: { kind: "error", reason: "unstable" } };

	const identity: ResumeSessionIdentity = {
		canonicalPath,
		sessionId,
		dev: before.dev,
		ino: before.ino,
		nlink: before.nlink,
		size: before.size,
		mtimeMs: before.mtimeMs,
		mtimeNs: before.mtimeNs,
		ctimeNs: before.ctimeNs,
		sha256: hash.digest("hex"),
	};
	return { ok: true, inspection: { identity, cwd } };
}

/** Bounded source revalidation comparing the live file to a captured identity. */
function revalidateTranscriptIdentityBounded(
	filePath: string,
	storage: SessionStorage,
	expected: ResumeSessionIdentity,
): { kind: "valid" } | StrictSessionOpenFailure {
	const canonicalPath = resolveEquivalentPath(path.resolve(filePath));
	if (storage instanceof FileSessionStorage) {
		const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
		let fd: number | undefined;
		try {
			fd = fs.openSync(canonicalPath, flags);
			const before = fs.fstatSync(fd, { bigint: true });
			if (
				!before.isFile() ||
				before.dev !== expected.dev ||
				before.ino !== expected.ino ||
				(expected.nlink !== undefined && before.nlink !== expected.nlink) ||
				Number(before.size) !== expected.size ||
				before.mtimeNs !== expected.mtimeNs ||
				(expected.ctimeNs !== undefined && before.ctimeNs !== expected.ctimeNs)
			)
				return { kind: "error", reason: "identity-mismatch" };
			const hash = crypto.createHash("sha256");
			const chunk = Buffer.allocUnsafe(1024 * 1024);
			let offset = 0;
			while (offset < expected.size) {
				const length = Math.min(chunk.byteLength, expected.size - offset);
				const count = fs.readSync(fd, chunk, 0, length, offset);
				if (count !== length) return { kind: "error", reason: "read-failed" };
				hash.update(chunk.subarray(0, count));
				offset += count;
			}
			const after = fs.fstatSync(fd, { bigint: true });
			const named = fs.lstatSync(canonicalPath, { bigint: true });
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.nlink !== before.nlink ||
				after.size !== before.size ||
				after.mtimeNs !== before.mtimeNs ||
				after.ctimeNs !== before.ctimeNs ||
				!named.isFile() ||
				named.isSymbolicLink() ||
				named.dev !== before.dev ||
				named.ino !== before.ino ||
				hash.digest("hex") !== expected.sha256
			)
				return { kind: "error", reason: "identity-mismatch" };
			return { kind: "valid" };
		} catch (error) {
			return resumeReadFailure(error, storage, canonicalPath);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	let before: SessionStorageStat;
	try {
		before = storage.statSync(canonicalPath);
	} catch (error) {
		return resumeReadFailure(error, storage, canonicalPath);
	}
	if (!before.isFile || typeof storage.readRangeSync !== "function") {
		return { kind: "error", reason: "read-failed" };
	}
	if (before.size !== expected.size) return { kind: "error", reason: "identity-mismatch" };
	const hash = crypto.createHash("sha256");
	try {
		for (let offset = 0; offset < before.size; offset += TRANSCRIPT_CAPTURE_CHUNK_BYTES) {
			const length = Math.min(TRANSCRIPT_CAPTURE_CHUNK_BYTES, before.size - offset);
			hash.update(storage.readRangeSync(canonicalPath, offset, length).bytes);
			if (((offset + length) & (8 * 1024 * 1024 - 1)) === 0) Bun.gc(true);
		}
	} catch (error) {
		return resumeReadFailure(error, storage, canonicalPath);
	}
	let after: SessionStorageStat;
	try {
		after = storage.statSync(canonicalPath);
	} catch (error) {
		return resumeReadFailure(error, storage, canonicalPath);
	}
	if (!sameResumeStat(before, after)) return { kind: "error", reason: "unstable" };
	const observed: ResumeSessionIdentity = {
		canonicalPath,
		sessionId: expected.sessionId,
		dev: before.dev,
		ino: before.ino,
		nlink: before.nlink,
		size: before.size,
		mtimeMs: before.mtimeMs,
		mtimeNs: before.mtimeNs,
		ctimeNs: before.ctimeNs,
		sha256: hash.digest("hex"),
	};
	return sameResumeIdentity(expected, observed) ? { kind: "valid" } : { kind: "error", reason: "identity-mismatch" };
}

function revalidateStrictResumeInspection(
	filePath: string,
	storage: SessionStorage,
	inspection: ResumeInspectionSnapshot,
): boolean {
	if (!storage.readRangeSync) {
		const inspected = inspectResumeSessionFile(filePath, storage);
		return !("kind" in inspected) && sameResumeIdentity(inspection.identity, inspected.identity);
	}
	return revalidateTranscriptIdentityBounded(filePath, storage, inspection.identity).kind === "valid";
}

function createTranscriptSnapshotHandle(
	inspection: BoundedTranscriptInspection,
	filePath: string,
	storage: SessionStorage,
): TranscriptSnapshotHandle {
	const canonicalPath = inspection.identity.canonicalPath;
	const size = inspection.identity.size;
	const readRangeSync = storage.readRangeSync?.bind(storage);
	if (!readRangeSync) throw new Error("bounded_range_read_unavailable");
	let closed = false;
	let lastReadStat: SessionStorageStat | undefined;

	const readAllLines = (callback: (line: Uint8Array) => boolean | undefined): boolean => {
		if (closed) throw new Error("transcript_handle_closed");
		const hash = crypto.createHash("sha256");
		let aborted = false;
		const scanResult: { stat?: SessionStorageStat } = {};
		const failure = scanTranscriptLinesBounded(
			storage,
			canonicalPath,
			size,
			(_offset, line) => {
				hash.update(line);
				const body = line[line.byteLength - 1] === 0x0a ? line.subarray(0, line.byteLength - 1) : line;
				if (body.byteLength === 0) return;
				if (callback(body) === false) {
					aborted = true;
					return false;
				}
			},
			scanResult,
			true,
			true,
		);
		if (failure && !(failure === "aborted" && aborted)) throw new Error(`transcript_scan_${failure}`);
		if (aborted) return false;
		if (
			scanResult.stat &&
			(scanResult.stat.dev !== inspection.identity.dev ||
				scanResult.stat.ino !== inspection.identity.ino ||
				(inspection.identity.nlink !== undefined && scanResult.stat.nlink !== inspection.identity.nlink) ||
				scanResult.stat.size !== inspection.identity.size ||
				scanResult.stat.mtimeNs !== inspection.identity.mtimeNs ||
				(inspection.identity.ctimeNs !== undefined && scanResult.stat.ctimeNs !== inspection.identity.ctimeNs))
		)
			throw new Error("identity-mismatch");
		lastReadStat = scanResult.stat;
		if (hash.digest("hex") !== inspection.identity.sha256) throw new Error("identity-mismatch");
		return true;
	};

	return {
		sourcePath: path.resolve(filePath),
		identity: inspection.identity,
		storage,
		forEachLine: readAllLines,
		getLastReadStat: () => lastReadStat,
		revalidate(): { kind: "valid" } | StrictSessionOpenFailure {
			if (closed) throw new Error("transcript_handle_closed");
			return revalidateTranscriptIdentityBounded(canonicalPath, storage, inspection.identity);
		},
		close(): void {
			closed = true;
		},
		materialize(): Uint8Array {
			if (closed) throw new Error("transcript_handle_closed");
			const budgetBytes = effectiveSessionContextBudgetBytes();
			if (size > budgetBytes - TRANSCRIPT_CAPTURE_CHUNK_BYTES) {
				throw new SessionContextTooLargeError(size, budgetBytes);
			}
			const output = Buffer.allocUnsafe(size);
			for (let offset = 0; offset < size; offset += TRANSCRIPT_CAPTURE_CHUNK_BYTES) {
				const length = Math.min(TRANSCRIPT_CAPTURE_CHUNK_BYTES, size - offset);
				Buffer.from(readRangeSync(canonicalPath, offset, length).bytes).copy(output, offset);
			}
			return output;
		},
	};
}

/**
 * Apply header/entry patch records to a parsed record array. Mirrors the
 * record-processing tail of {@link parseSessionEntries} so bounded fork parsing
 * never needs to reconstruct a whole-transcript string.
 */
function buildFileEntriesFromRecords(records: Array<FileEntry | SessionPatchRecord>): FileEntry[] {
	const rawHeader = records.find((record): record is SessionHeader => record.type === "session");
	if (!isSupportedSessionVersion(rawHeader?.version)) {
		throw new Error(`Unsupported session version: ${String(rawHeader?.version)}`);
	}
	const entries: FileEntry[] = [];
	const entriesById = new Map<string, SessionEntry>();
	let header: SessionHeader | undefined;
	for (const record of records) {
		if (record.type === "header_patch") {
			if (header?.version !== undefined && header.version >= 4 && isHeaderPatchRecord(record))
				applyHeaderPatch(header, record.patch);
			continue;
		}
		if (record.type === "entry_patch") {
			if (header?.version !== undefined && header.version >= 4 && isEntryPatchRecord(record)) {
				const entry = entriesById.get(record.entryId);
				if (entry?.type === "message" && record.patch.message) entry.message = record.patch.message;
			}
			continue;
		}
		entries.push(record);
		if (record.type === "session") header ??= record;
		else entriesById.set(record.id, record);
	}
	return entries;
}

/**
 * Publish a fork transcript through the storage staged writer in bounded
 * passes. Each entry is serialized independently (no whole-transcript
 * string/Buffer) and installed with no-replace publication. Returns the
 * SHA-256 of the exact bytes published for post-publication verification.
 */
function publishForkTranscriptStreaming(
	storage: SessionStorage,
	sessionFile: string,
	destination: SessionDestination,
	entries: readonly FileEntry[],
	persist: (entry: FileEntry) => FileEntry,
): string {
	if (typeof storage.openStagedWriter !== "function") throw new Error("fork_publication_storage_unsupported");
	const staged: StagedStreamingWriter = storage.openStagedWriter(sessionFile, {
		securityContext: destination.kind === "managed" ? destination.securityContext : undefined,
	});
	const hash = crypto.createHash("sha256");
	try {
		for (const entry of entries) {
			const persisted = persist(entry);
			const line = Buffer.from(JSON.stringify(persisted), "utf8");
			staged.writeLine(line);
			hash.update(line);
			hash.update(TRANSCRIPT_LINE_TERMINATOR);
		}
		staged.fsync();
		staged.closeSync();
		staged.publishNoReplace();
	} catch (error) {
		try {
			staged.closeSync();
		} catch {
			// Preserve the primary publication failure.
		}
		throw error;
	}
	return hash.digest("hex");
}

/** Bounded read-back verification that an installed fork transcript matches the intended bytes. */
function verifyForkTranscriptPublishedBounded(
	storage: SessionStorage,
	sessionFile: string,
	expectedSha256: string,
): void {
	const readRangeSync = storage.readRangeSync?.bind(storage);
	if (!readRangeSync) throw new Error("bounded_range_read_unavailable");
	let size: number;
	try {
		size = storage.statSync(sessionFile).size;
	} catch {
		throw new Error("fork_transcript_changed");
	}
	const hash = crypto.createHash("sha256");
	try {
		for (let offset = 0; offset < size; offset += TRANSCRIPT_CAPTURE_CHUNK_BYTES) {
			const length = Math.min(TRANSCRIPT_CAPTURE_CHUNK_BYTES, size - offset);
			hash.update(readRangeSync(sessionFile, offset, length).bytes);
		}
	} catch {
		throw new Error("fork_transcript_changed");
	}
	if (hash.digest("hex") !== expectedSha256) throw new Error("fork_transcript_changed");
}

function fsyncResumeSessionIdentity(expected: ResumeSessionIdentity): void {
	const fd = fs.openSync(expected.canonicalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (
			before.dev !== expected.dev ||
			before.ino !== expected.ino ||
			(expected.nlink !== undefined && before.nlink !== expected.nlink) ||
			Number(before.size) !== expected.size ||
			before.mtimeNs !== expected.mtimeNs ||
			(expected.ctimeNs !== undefined && before.ctimeNs !== expected.ctimeNs)
		) {
			throw new Error("session_persistence_recovery_identity_mismatch");
		}
		fs.fsyncSync(fd);
		const after = fs.fstatSync(fd, { bigint: true });
		const named = fs.lstatSync(expected.canonicalPath, { bigint: true });
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.nlink !== before.nlink ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs ||
			named.dev !== after.dev ||
			named.ino !== after.ino ||
			named.nlink !== after.nlink
		) {
			throw new Error("session_persistence_recovery_identity_mismatch");
		}
	} finally {
		fs.closeSync(fd);
	}
	const parentFd = fs.openSync(path.dirname(expected.canonicalPath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		fs.fsyncSync(parentFd);
	} finally {
		fs.closeSync(parentFd);
	}
}
/** Revalidate previously parsed authority without another decode, parse, migration, or context build. */
function revalidateResumeSessionIdentity(
	filePath: string,
	storage: SessionStorage,
	expected: ResumeSessionIdentity,
): StrictSessionOpenFailure | { kind: "valid" } {
	const canonicalPath = resolveEquivalentPath(path.resolve(filePath));
	let before: SessionStorageStat;
	let snapshot: SessionStorageSnapshot;
	let after: SessionStorageStat;
	try {
		before = storage.statSync(canonicalPath);
		if (!before.isFile || !storage.readSnapshotSync) return { kind: "error", reason: "read-failed" };
		snapshot = storage.readSnapshotSync(canonicalPath);
		after = storage.statSync(canonicalPath);
	} catch (error) {
		return resumeReadFailure(error, storage, canonicalPath);
	}
	if (!sameResumeStat(before, snapshot.stat) || !sameResumeStat(snapshot.stat, after)) {
		return { kind: "error", reason: "unstable" };
	}
	const observed: ResumeSessionIdentity = {
		canonicalPath,
		sessionId: expected.sessionId,
		dev: snapshot.stat.dev,
		ino: snapshot.stat.ino,
		nlink: snapshot.stat.nlink,
		size: snapshot.stat.size,
		mtimeMs: snapshot.stat.mtimeMs,
		mtimeNs: snapshot.stat.mtimeNs,
		ctimeNs: snapshot.stat.ctimeNs,
		sha256: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
	};
	return sameResumeIdentity(expected, observed) ? { kind: "valid" } : { kind: "error", reason: "identity-mismatch" };
}

/**
 * Convert legacy persisted blob references in loaded entries into resident sentinels.
 * Images then materialize lazily at provider/display/export chokepoints instead of
 * pinning every historical base64 string for the lifetime of a resumed session.
 */
function hasImageUrl(value: unknown): value is { image_url: string | { url?: string } } {
	return typeof value === "object" && value !== null && "image_url" in value;
}

function residentizePersistedBlobRefs(value: unknown, key?: string): void {
	if (Array.isArray(value)) {
		for (const item of value) residentizePersistedBlobRefs(item, key);
		return;
	}

	if (typeof value !== "object" || value === null) return;

	if (isImageBlock(value) && isBlobRef(value.data)) {
		value.data = residentBlobSentinel("imageData", value.data) as unknown as string;
	}

	if (hasImageUrl(value)) {
		if (typeof value.image_url === "string" && isBlobRef(value.image_url)) {
			value.image_url = residentBlobSentinel("imageUrl", value.image_url) as unknown as string;
		} else if (
			typeof value.image_url === "object" &&
			value.image_url !== null &&
			typeof value.image_url.url === "string" &&
			isBlobRef(value.image_url.url)
		) {
			value.image_url.url = residentBlobSentinel("imageUrl", value.image_url.url) as unknown as string;
		}
	}

	for (const [childKey, item] of Object.entries(value)) {
		if (childKey === "data" && typeof item === "string" && isBlobRef(item) && key !== TEXT_CONTENT_KEY) {
			(value as Record<string, unknown>)[childKey] = residentBlobSentinel("imageUrl", item);
			continue;
		}
		residentizePersistedBlobRefs(item, childKey);
	}
}

/**
 * Run async tasks with bounded concurrency so an image-heavy resume never materializes
 * every blob's base64 simultaneously (F8: avoids the transient OOM spike of an unbounded
 * Promise.all over all historical images).
 */
const BLOB_RESOLVE_CONCURRENCY = 8;
async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < tasks.length) {
			const index = next;
			next += 1;
			await tasks[index]!();
		}
	};
	const workerCount = Math.max(1, Math.min(limit, tasks.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function resolveBlobRefsInEntries(entries: FileEntry[], _blobStore: BlobStore): Promise<void> {
	const tasks: Array<() => Promise<void>> = [];

	for (const entry of entries) {
		if (entry.type === "session") continue;
		tasks.push(async () => {
			residentizePersistedBlobRefs(entry);
		});
	}

	await runWithConcurrency(tasks, BLOB_RESOLVE_CONCURRENCY);
}

/**
 * Lightweight metadata for a session file, used in session picker UI.
 * Uses lazy getters to defer string formatting until actually displayed.
 */
function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

class RecentSessionInfo {
	#fullName: string | undefined;
	#timeAgo: string | undefined;
	readonly #headerTimestamp: string | undefined;

	constructor(
		readonly path: string,
		readonly mtime: number,
		header: Record<string, unknown>,
		firstPrompt?: string,
	) {
		// Prefer an explicit title, then the first user prompt. The raw UUID `id` is
		// intentionally not used as a fallback: showing it as a "name" is unfriendly and
		// indistinguishable from neighboring sessions in the UI. The friendly fallback is
		// derived lazily in `fullName` from the session timestamp.
		const trystr = (v: unknown) => (typeof v === "string" ? v : undefined);
		this.#fullName = sanitizeSessionName(trystr(header.title)) ?? sanitizeSessionName(firstPrompt);
		this.#headerTimestamp = trystr(header.timestamp);
	}

	/** Display name. Falls back to a timestamp-based label, never the raw UUID. */
	get fullName(): string {
		if (this.#fullName) return this.#fullName;
		const ts = this.#headerTimestamp ? Date.parse(this.#headerTimestamp) : Number.NaN;
		const date = new Date(Number.isFinite(ts) ? ts : this.mtime);
		const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		this.#fullName = `Untitled · ${time}`;
		return this.#fullName;
	}

	/**
	 * Display name without an arbitrary length cap. The renderer is responsible for
	 * width-aware truncation so adjacent fields (e.g. the relative time) stay visible.
	 */
	get name(): string {
		return this.fullName;
	}

	/** Human-readable relative time (e.g., "2 hours ago") */
	get timeAgo(): string {
		if (this.#timeAgo) return this.#timeAgo;
		this.#timeAgo = formatTimeAgo(new Date(this.mtime));
		return this.#timeAgo;
	}
}

/**
 * Extracts the text content from a user message entry.
 * Returns undefined if the entry is not a user message or has no text.
 */
function extractFirstUserPrompt(entries: Array<Record<string, unknown>>): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && "text" in block) {
					const text = (block as { text: unknown }).text;
					if (typeof text === "string") return text;
				}
			}
		}
	}
	return undefined;
}

/**
 * Promote orphaned `<basename>.jsonl.<snowflake>.bak` backups created by
 * `#replaceSessionFileAfterEperm` back to their primary path when the primary
 * is missing. This runs once per session-dir scan, before the main `*.jsonl`
 * glob, so a crash between the two renames in the EPERM-rewrite path does not
 * leave the user's last good state stranded outside the loader's view.
 *
 * Exported for testing.
 */
export async function recoverOrphanedBackups(sessionDir: string, storage: SessionStorage): Promise<void> {
	let backups: string[];
	try {
		backups = storage.listFilesSync(sessionDir, "*.bak");
	} catch {
		return;
	}
	if (backups.length === 0) return;
	// For each primary path, pick the newest backup (highest mtime) as the recovery source.
	const candidates = new Map<string, { backup: string; mtimeMs: number }>();
	for (const backup of backups) {
		const name = path.basename(backup);
		// Expect "<primary>.<snowflake>.bak" where <primary> ends in ".jsonl".
		if (!name.endsWith(".bak")) continue;
		const trimmed = name.slice(0, -".bak".length);
		const dotIdx = trimmed.lastIndexOf(".");
		if (dotIdx <= 0) continue;
		const primaryName = trimmed.slice(0, dotIdx);
		if (!primaryName.endsWith(".jsonl")) continue;
		const primaryPath = path.join(sessionDir, primaryName);
		let mtimeMs = 0;
		try {
			mtimeMs = storage.statSync(backup).mtimeMs;
		} catch {
			continue;
		}
		const existing = candidates.get(primaryPath);
		if (!existing || mtimeMs > existing.mtimeMs) {
			candidates.set(primaryPath, { backup, mtimeMs });
		}
	}
	for (const [primaryPath, { backup }] of candidates) {
		if (storage.existsSync(primaryPath)) continue;
		try {
			await storage.rename(backup, primaryPath);
			logger.warn("Recovered orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
			});
		} catch (err) {
			logger.warn("Failed to recover orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
				error: toError(err).message,
			});
		}
	}
}

/**
 * Returns session metadata sorted by mtime (newest first).
 *
 * Directory entries are cheap to stat, but opening every transcript before applying a
 * small caller limit makes welcome-screen startup scale with the entire session history.
 * Rank paths first, then read bounded batches until the requested number of valid
 * sessions has been found. Invalid or future-version files do not prevent older valid
 * sessions from filling the result.
 */
async function getSortedSessions(
	sessionDir: string,
	storage: SessionStorage,
	limit?: number,
): Promise<RecentSessionInfo[]> {
	await recoverOrphanedBackups(sessionDir, storage);
	try {
		let candidates: Array<{ path: string; mtime: number }> | undefined;
		if (storage.listFilesByMtime) {
			try {
				candidates = (await storage.listFilesByMtime(sessionDir, "*.jsonl")).map(candidate => ({
					path: candidate.path,
					mtime: candidate.mtimeMs,
				}));
			} catch (error) {
				logger.warn("Native session mtime listing failed; using JavaScript fallback", {
					sessionDir,
					error: toError(error).message,
				});
			}
		} else {
			logger.debug("Native session mtime listing unavailable; using JavaScript fallback", { sessionDir });
		}
		candidates ??= storage.listFilesSync(sessionDir, "*.jsonl").flatMap(path => {
			try {
				return [{ path, mtime: storage.statSync(path).mtimeMs }];
			} catch {
				return [];
			}
		});
		candidates.sort((left, right) => {
			if (left.mtime !== right.mtime) return right.mtime - left.mtime;
			return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
		});

		const sessions: RecentSessionInfo[] = [];
		const batchSize = Math.max(32, limit ?? 0);

		for (
			let offset = 0;
			offset < candidates.length && (limit === undefined || sessions.length < limit);
			offset += batchSize
		) {
			const batch = candidates.slice(offset, offset + batchSize);
			const parsed = await Promise.all(
				batch.map(async candidate => {
					try {
						const buffer = Buffer.allocUnsafe(SESSION_LIST_PREFIX_BYTES);
						const content = await readSessionListPrefix(candidate.path, storage, buffer);
						const entries = parseJsonlLenient<Record<string, unknown>>(content);
						if (entries.length === 0) return undefined;
						const header = entries[0] as Record<string, unknown>;
						if (
							header.type !== "session" ||
							typeof header.id !== "string" ||
							!isSupportedSessionVersion(header.version)
						)
							return undefined;
						if (typeof header.version === "number" && header.version >= 4) {
							for (const patch of await readSessionListTrailingPatches(candidate.path, storage)) {
								applySessionListHeaderPatch(header as unknown as SessionListHeader, patch);
							}
						}
						const firstPrompt = header.title ? undefined : extractFirstUserPrompt(entries);
						return new RecentSessionInfo(candidate.path, candidate.mtime, header, firstPrompt);
					} catch {
						return undefined;
					}
				}),
			);
			for (const session of parsed) {
				if (session) sessions.push(session);
				if (limit !== undefined && sessions.length >= limit) break;
			}
		}
		return sessions;
	} catch {
		return [];
	}
}

/** Exported for testing */
export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await getSortedSessions(sessionDir, storage, 1);
	return sessions[0]?.path || null;
}

/** Format a time difference as a human-readable string */
function formatTimeAgo(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

interface SessionMoveDirectoryHandle {
	sync(): Promise<void>;
	close(): Promise<void>;
}

export async function syncSessionMoveDirectory(
	directory: string,
	platform: NodeJS.Platform = process.platform,
	openDirectory: (directory: string) => Promise<SessionMoveDirectoryHandle> = value => fs.promises.open(value, "r"),
): Promise<void> {
	if (platform === "win32") return;
	const handle = await openDirectory(directory);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

type CrossDeviceTreeIdentity = string;

/** Captures content plus topology; a later capture must match before source removal. */
async function captureCrossDeviceTreeIdentity(treePath: string): Promise<CrossDeviceTreeIdentity> {
	const before = await fs.promises.lstat(treePath, { bigint: true });
	if (before.isSymbolicLink()) throw new Error("Refusing to move a symbolic link across devices");
	if (before.isFile()) {
		const bytes = await fs.promises.readFile(treePath);
		const after = await fs.promises.lstat(treePath, { bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs
		)
			throw new Error("Cross-device move source changed while its identity was captured");
		return `file:${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
	}
	if (!before.isDirectory()) throw new Error("Cross-device move contains an unsupported filesystem entry");
	const directory = await fs.promises.opendir(treePath);
	const entries: string[] = [];
	try {
		for (;;) {
			const entry = await directory.read();
			if (entry === null) break;
			entries.push(entry.name);
		}
	} finally {
		await directory.close();
	}
	entries.sort();
	const children = await Promise.all(
		entries.map(
			async name => `${JSON.stringify(name)}=${await captureCrossDeviceTreeIdentity(path.join(treePath, name))}`,
		),
	);
	const after = await fs.promises.lstat(treePath, { bigint: true });
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs
	)
		throw new Error("Cross-device move source topology changed while its identity was captured");
	return `directory:${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:[${children.join(",")}]`;
}

/**
 * An EXDEV retirement must be driven by a native descriptor/handle-bound
 * snapshot-copy-verify transaction.  Do not fall back to pathname copy/remove:
 * that can retire a replacement after a crash or concurrent rename.
 */
class CrossDeviceMoveUnsupportedError extends Error {
	constructor(source: string, destination: string, cause?: unknown) {
		super(
			`Cross-device session move is unavailable for ${source} -> ${destination}: native atomic detach/copy/verify support is required.`,
			{ cause },
		);
		this.name = "CrossDeviceMoveUnsupportedError";
	}
}

async function movePathAcrossDevicesSafe(source: string, destination: string): Promise<void> {
	const sourceIdentity = await captureCrossDeviceTreeIdentity(source);
	const outcome = classifyNativePublishOutcome(nativeSessionManager().renameNoReplacePath(source, destination));
	if (outcome.ok) {
		if ((await captureCrossDeviceTreeIdentity(destination)) !== sourceIdentity)
			throw new Error("Atomic session rename did not preserve the captured source identity");
		await syncSessionMoveDirectory(path.dirname(destination));
		if (path.dirname(source) !== path.dirname(destination)) await syncSessionMoveDirectory(path.dirname(source));
		return;
	}
	if (outcome.reason === "destination_exists") {
		const error = new Error(`Session move destination already exists: ${destination}`) as NodeJS.ErrnoException;
		error.code = "EEXIST";
		throw error;
	}
	if (outcome.reason === "atomic_unavailable")
		throw new CrossDeviceMoveUnsupportedError(source, destination, new Error(formatNativePublishDiagnostic(outcome)));
	const message = `Atomic session rename failed: ${outcome.code ?? outcome.reason}`;
	throw new Error(message, { cause: new Error(formatNativePublishDiagnostic(outcome)) });
}

const MAX_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
/**
 * Inline cap for edit-result snapshot bodies (`EditToolDetails.oldText` /
 * `.newText` and per-file copies). Bodies up to this size persist verbatim;
 * larger ones persist as a digest receipt (#4566).
 */
const EDIT_SNAPSHOT_INLINE_MAX_CHARS = 16 * 1024;
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";
const RESIDENT_BLOB_SENTINEL_KEY = "__gjcResidentBlob";
type ResidentBlobKind = "text" | "imageUrl" | "imageData";
interface ResidentBlobSentinel {
	[RESIDENT_BLOB_SENTINEL_KEY]: true;
	kind: ResidentBlobKind;
	ref: string;
}

function residentBlobSentinel(kind: ResidentBlobKind, ref: string): ResidentBlobSentinel {
	return { [RESIDENT_BLOB_SENTINEL_KEY]: true, kind, ref };
}

function isResidentBlobSentinel(value: unknown): value is ResidentBlobSentinel {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [RESIDENT_BLOB_SENTINEL_KEY]?: unknown })[RESIDENT_BLOB_SENTINEL_KEY] === true &&
		((value as { kind?: unknown }).kind === "text" ||
			(value as { kind?: unknown }).kind === "imageUrl" ||
			(value as { kind?: unknown }).kind === "imageData") &&
		typeof (value as { ref?: unknown }).ref === "string" &&
		isBlobRef((value as { ref: string }).ref)
	);
}
function containsResidentSentinel(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || value === undefined || typeof value !== "object") return false;
	if ((value as { [RESIDENT_BLOB_SENTINEL_KEY]?: unknown })[RESIDENT_BLOB_SENTINEL_KEY] === true) return true;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsResidentSentinel(item, seen));
	for (const child of Object.values(value)) {
		if (containsResidentSentinel(child, seen)) return true;
	}
	return false;
}

function containsResidentImageSentinel(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || value === undefined || typeof value !== "object") return false;
	if (isResidentBlobSentinel(value)) return value.kind === "imageUrl" || value.kind === "imageData";
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsResidentImageSentinel(item, seen));
	for (const child of Object.values(value)) {
		if (containsResidentImageSentinel(child, seen)) return true;
	}
	return false;
}

function collectResidentImageRefs(value: unknown, refs: Set<string>, seen = new WeakSet<object>()): void {
	if (value === null || value === undefined || typeof value !== "object") return;
	if (isResidentBlobSentinel(value)) {
		if (value.kind === "imageUrl" || value.kind === "imageData") refs.add(value.ref);
		return;
	}
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectResidentImageRefs(item, refs, seen);
		return;
	}
	for (const child of Object.values(value)) collectResidentImageRefs(child, refs, seen);
}

function collectResidentTextBlobHashes(value: unknown, hashes: Set<string>, seen = new WeakSet<object>()): void {
	if (value === null || value === undefined || typeof value !== "object") return;
	if (isResidentBlobSentinel(value)) {
		if (value.kind === "text") {
			const hash = parseBlobRef(value.ref);
			if (hash) hashes.add(hash);
		}
		return;
	}
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectResidentTextBlobHashes(item, hashes, seen);
		return;
	}
	for (const child of Object.values(value)) collectResidentTextBlobHashes(child, hashes, seen);
}

function recoverPersistedResidentTextBuffers(
	value: unknown,
	requested: ReadonlySet<string>,
	recovered: Map<string, Buffer>,
	key?: string,
	seen = new WeakSet<object>(),
): void {
	if (typeof value === "string") {
		if (value.length < BLOB_EXTERNALIZE_THRESHOLD || !shouldExternalizeResidentString(key)) return;
		const hash = crypto.createHash("sha256").update(value, "utf8").digest("hex");
		if (requested.has(hash)) recovered.set(hash, Buffer.from(value, "utf8"));
		return;
	}
	if (value === null || value === undefined || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) recoverPersistedResidentTextBuffers(item, requested, recovered, key, seen);
		return;
	}
	for (const [childKey, child] of Object.entries(value)) {
		recoverPersistedResidentTextBuffers(child, requested, recovered, childKey, seen);
	}
}

/**
 * Recursively truncate large strings in an object for session persistence.
 * - Truncates any oversized string fields (key-agnostic)
 * - Replaces oversized image blocks with text notices
 * - Updates lineCount when content is truncated
 * - Returns original object if no changes needed (structural sharing)
 */
function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	let truncated = value.slice(0, maxLength);
	if (truncated.length > 0) {
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			truncated = truncated.slice(0, -1);
		}
	}
	return truncated;
}

/**
 * Bound durable edit-result snapshot bodies (#4566).
 *
 * A tiny edit to a large file used to persist the complete pre- and post-edit
 * file bodies in `EditToolDetails.oldText`/`newText` (and each
 * `perFileResults[]` copy), so every patch added ~2x file size to the managed
 * transcript and long sessions hit the 64 MiB per-file append limit mid-turn.
 *
 * Persisted edit results keep full bodies only under the inline cap; larger
 * bodies are replaced by a fixed-size receipt (`oldTextDigest`/`newTextDigest`
 * = byte length + SHA-256) plus a marker, so rendering, diagnostics, diffs,
 * paths, and source-change accounting stay intact while the durable cost per
 * edit is bounded independently of file size. Live in-process results are
 * untouched — ACP `diff` ToolCallContent still receives full bodies.
 */
function boundEditSnapshotFields(value: unknown, visited: WeakSet<object>): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (visited.has(value)) return value;
	visited.add(value);

	const boundOne = (entry: Record<string, unknown>): Record<string, unknown> => {
		let changed = false;
		const next: Record<string, unknown> = { ...entry };
		const pairs: Array<["oldText", "oldTextDigest"] | ["newText", "newTextDigest"]> = [
			["oldText", "oldTextDigest"],
			["newText", "newTextDigest"],
		];
		for (const [bodyKey, digestKey] of pairs) {
			const body = entry[bodyKey];
			if (typeof body !== "string" || body.length <= EDIT_SNAPSHOT_INLINE_MAX_CHARS) continue;
			const receipt = editSnapshotReceipt(body);
			if (receipt === undefined) continue;
			next[digestKey] = receipt;
			next[bodyKey] = EDIT_SNAPSHOT_EXTERNALIZED_NOTICE;
			changed = true;
		}
		return changed ? next : entry;
	};

	if (Array.isArray(value)) {
		let changed = false;
		const result: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			const bounded =
				typeof item === "object" && item !== null && !Array.isArray(item)
					? boundOne(item as Record<string, unknown>)
					: item;
			result[i] = bounded === item ? boundEditSnapshotFields(item, visited) : bounded;
			if (result[i] !== item) changed = true;
		}
		return changed ? result : value;
	}

	for (const [key, child] of Object.entries(value)) {
		if (child !== null && typeof child === "object" && !Array.isArray(child)) {
			const boundedChild = boundOne(child as Record<string, unknown>);
			if (boundedChild !== child) {
				return { ...value, [key]: boundedChild };
			}
		}
	}
	for (const [key, child] of Object.entries(value)) {
		const bounded = boundEditSnapshotFields(child, visited);
		if (bounded !== child) {
			return { ...(value as Record<string, unknown>), [key]: bounded };
		}
	}
	return boundOne(value as Record<string, unknown>);
}

function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type?: string }).type === "image" &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string"
	);
}

function stripUndefinedPlainObjectFields(value: unknown, path = "entry"): unknown {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		let changed = false;
		const result: unknown[] = new Array(value.length);
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (item === undefined) {
				throw new Error(`Session entry contains undefined array item at ${path}[${index}]`);
			}
			const next = stripUndefinedPlainObjectFields(item, `${path}[${index}]`);
			if (next !== item) changed = true;
			result[index] = next;
		}
		return changed ? result : value;
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;

	let changed = false;
	const entries: Array<readonly [string, unknown]> = [];
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) {
			changed = true;
			continue;
		}
		const next = stripUndefinedPlainObjectFields(item, `${path}.${key}`);
		if (next !== item) changed = true;
		entries.push([key, next]);
	}
	return changed ? Object.fromEntries(entries) : value;
}

function normalizeSessionEntryForStorage(entry: SessionEntry): SessionEntry {
	return stripUndefinedPlainObjectFields(entry) as SessionEntry;
}

const RESIDENT_EXTERNALIZE_STRING_EXCLUDED_KEYS = new Set([
	"id",
	"type",
	"parentId",
	"timestamp",
	"role",
	"provider",
	"model",
	"api",
	"customType",
	"mode",
	"mimeType",
	"stopReason",
	"toolName",
	"targetId",
	"firstKeptEntryId",
	"encrypted_content",
	"reasoning_encrypted_content",
]);

function shouldExternalizeResidentString(key: string | undefined): boolean {
	return !key || !RESIDENT_EXTERNALIZE_STRING_EXCLUDED_KEYS.has(key);
}

interface ResidentBlobStores {
	textStore: BlobStore;
	imageStore: BlobStore;
	/** Trusted alternate bytes used only while demoting an invalidated resident store. */
	textFallback?: (hash: string) => Buffer | null;
	sessionId?: string;
	sessionFile?: string;
	onResidentBlobRead?: (kind: ResidentBlobKind) => void;
	/** Fired when `missingPolicy: "placeholder"` substitutes for content that is gone for good. */
	onResidentBlobMissing?: (kind: ResidentBlobKind, hash: string) => void;
}

/**
 * Record one bounded line where a missing resident blob is fatal.
 *
 * The degrading legacy resolvers each warn on a miss and the demotion salvage
 * reports its placeholders, so the recoverable cases were observable in the log
 * while the turn-killing ones were not: a fail-closed abort left no record
 * naming the blob, its kind, or its session. Placeholder substitution stays
 * silent here because it is self-evidencing in the transcript and already has
 * its own callback.
 */
function reportResidentBlobMissing(
	error: ResidentBlobMissingError,
	phase: "materialize" | "stage-verify" | "cold-spill",
): ResidentBlobMissingError {
	logger.error("Resident blob missing on a fail-closed path", {
		phase,
		kind: error.kind,
		hash: error.hash,
		sessionId: error.sessionId,
		sessionFile: error.sessionFile,
	});
	return error;
}

/**
 * Record one bounded line where a corrupted resident reference is fatal.
 *
 * The missing-blob lanes above report through `reportResidentBlobMissing`;
 * a staged sentinel whose ref does not even parse failed closed with a bare
 * `Error` that named no ref, kind, or session and left no record at all —
 * the same observability gap one boundary over. The ref is bounded because a
 * corrupted boundary is exactly where unbounded input appears.
 */
function reportInvalidResidentBlobRef(ref: string, kind: string, stores: ResidentBlobStores): Error {
	const boundedRef = ref.length > 96 ? `${ref.slice(0, 96)}…` : ref;
	logger.error("Resident blob reference invalid on a fail-closed path", {
		phase: "stage-verify",
		kind,
		ref: boundedRef,
		sessionId: stores.sessionId,
		sessionFile: stores.sessionFile,
	});
	return new Error(
		`Staged resident entry has an invalid blob reference: ${boundedRef}` +
			(stores.sessionId ? ` (session ${stores.sessionId})` : "") +
			(stores.sessionFile ? ` [${stores.sessionFile}]` : ""),
	);
}

/** Coerce a corrupted sentinel's ref to text without letting a hostile toString through. */
function safeResidentRefText(ref: unknown): string {
	if (typeof ref === "string") return ref;
	try {
		return String(ref);
	} catch {
		return "<unprintable ref>";
	}
}

function residentBlobMissingPlaceholder(error: ResidentBlobMissingError): string {
	return `[Session resident ${error.kind} blob missing: sha256:${error.hash}; original content unavailable]`;
}

function externalizeResidentValueSync(obj: unknown, stores: ResidentBlobStores, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj) && obj.length >= BLOB_EXTERNALIZE_THRESHOLD)
			return residentBlobSentinel("imageUrl", externalizeImageDataUrlSync(stores.imageStore, obj));
		if (shouldExternalizeResidentString(key) && obj.length >= BLOB_EXTERNALIZE_THRESHOLD)
			return residentBlobSentinel("text", stores.textStore.putOwnedSync(Buffer.from(obj, "utf8")).ref);
		return obj;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			if (
				key === TEXT_CONTENT_KEY &&
				isImageBlock(item) &&
				!isBlobRef(item.data) &&
				item.data.length >= BLOB_EXTERNALIZE_THRESHOLD
			) {
				changed = true;
				result[i] = {
					...item,
					data: residentBlobSentinel("imageData", externalizeImageDataSync(stores.imageStore, item.data)),
				};
				continue;
			}
			const newItem = externalizeResidentValueSync(item, stores, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}
	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const [childKey, value] of Object.entries(obj)) {
			const newValue = externalizeResidentValueSync(value, stores, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		return changed ? Object.fromEntries(entries) : obj;
	}
	return obj;
}

function prepareEntryForResidentSync(entry: FileEntry, stores: ResidentBlobStores): FileEntry {
	return externalizeResidentValueSync(entry, stores) as FileEntry;
}

function materializeResidentValueSync(
	obj: unknown,
	stores: ResidentBlobStores,
	key?: string,
	cache = new Map<string, string>(),
	missingPolicy: ResidentBlobMissingPolicy = "throw",
): unknown {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj === "string") return obj;
	if (isResidentBlobSentinel(obj)) {
		const cacheKey = `${obj.kind}:${obj.ref}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;
		let resolved: string;
		try {
			if (obj.kind === "text") {
				const hash = parseBlobRef(obj.ref);
				const buffered = hash ? stores.textFallback?.(hash) : null;
				resolved = buffered ? buffered.toString("utf8") : resolveTextBlobSync(stores.textStore, obj.ref, stores);
			} else {
				resolved =
					obj.kind === "imageUrl"
						? resolveResidentImageDataUrlSync(stores.imageStore, obj.ref, stores)
						: resolveResidentImageDataSync(stores.imageStore, obj.ref, stores);
			}
		} catch (err) {
			if (missingPolicy === "placeholder" && err instanceof ResidentBlobMissingError) {
				resolved = residentBlobMissingPlaceholder(err);
				stores.onResidentBlobMissing?.(err.kind, err.hash);
			} else {
				if (err instanceof ResidentBlobMissingError) reportResidentBlobMissing(err, "materialize");
				throw err;
			}
		}

		cache.set(cacheKey, resolved);
		stores.onResidentBlobRead?.(obj.kind);
		return resolved;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result = obj.map(item => {
			const newItem = materializeResidentValueSync(item, stores, key, cache, missingPolicy);
			if (newItem !== item) changed = true;
			return newItem;
		});
		return changed ? result : obj;
	}
	if (typeof obj === "object") {
		let changed = false;
		const entries = Object.entries(obj).map(([childKey, value]) => {
			const newValue = materializeResidentValueSync(value, stores, childKey, cache, missingPolicy);
			if (newValue !== value) changed = true;
			return [childKey, newValue] as const;
		});
		return changed ? Object.fromEntries(entries) : obj;
	}
	return obj;
}

function materializeResidentEntrySync<T extends FileEntry | SessionEntry>(
	entry: T,
	stores: ResidentBlobStores,
	cache: Map<string, string>,
	missingPolicy: ResidentBlobMissingPolicy = "throw",
): T {
	return materializeResidentValueSync(entry, stores, undefined, cache, missingPolicy) as T;
}

function materializeResidentEntriesSync<T extends FileEntry | SessionEntry>(
	entries: T[],
	stores: ResidentBlobStores,
	missingPolicy: ResidentBlobMissingPolicy = "throw",
): T[] {
	const cache = new Map<string, string>();
	return entries.map(entry => materializeResidentEntrySync(entry, stores, cache, missingPolicy));
}

/** Verify staged references without materializing their full strings before commit. */
function assertResidentReferencesResolvableSync(entries: readonly FileEntry[], stores: ResidentBlobStores): void {
	const seen = new WeakSet<object>();
	const resolved = new Set<string>();
	const visit = (value: unknown): void => {
		if (value === null || value === undefined || typeof value !== "object") return;
		if (isResidentBlobSentinel(value)) {
			const key = `${value.kind}:${value.ref}`;
			if (resolved.has(key)) return;
			resolved.add(key);
			// The strict sentinel gate above already required isBlobRef(value.ref), so
			// the parse cannot fail here; non-parsing refs are the corrupted lane below.
			const hash = parseBlobRef(value.ref) as string;
			const store = value.kind === "text" ? stores.textStore : stores.imageStore;
			if (store.getSync(hash) === null) {
				throw reportResidentBlobMissing(
					new ResidentBlobMissingError(hash, value.kind, stores.sessionId, stores.sessionFile),
					"stage-verify",
				);
			}
			return;
		}
		// A key-marked sentinel that failed the strict shape check is a corrupted
		// boundary, not plain data: `containsResidentSentinel` already treats the
		// key alone as a sentinel, so walking past it here would verify nothing and
		// let the raw sentinel — internal key and all — persist into the transcript.
		if ((value as { [RESIDENT_BLOB_SENTINEL_KEY]?: unknown })[RESIDENT_BLOB_SENTINEL_KEY] === true) {
			const record = value as { kind?: unknown; ref?: unknown };
			throw reportInvalidResidentBlobRef(
				safeResidentRefText(record.ref),
				typeof record.kind === "string" ? record.kind : "unknown",
				stores,
			);
		}
		if (ArrayBuffer.isView(value) || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		for (const item of Object.values(value)) visit(item);
	};
	for (const entry of entries) visit(entry);
}

function materializeResidentEntryForReadSync<T extends FileEntry | SessionEntry>(
	entry: T,
	stores: ResidentBlobStores,
	cache: Map<string, string>,
): T {
	return materializeResidentEntrySync(entry, stores, cache, "placeholder");
}

/**
 * Approximate the UTF-8 footprint of a JSON-like snapshot without allocating a
 * serialized copy. The cap check can stop as soon as it is known to exceed it.
 */
function jsonLikeValueExceedsCacheLimit(value: unknown, limit: number): boolean {
	let bytes = 0;
	const seen = new WeakSet<object>();
	const add = (amount: number): void => {
		bytes += amount;
	};
	const visit = (value: unknown): void => {
		if (bytes > limit || value === null || value === undefined) return;
		if (typeof value === "string") {
			add(Buffer.byteLength(value, "utf8"));
			return;
		}
		if (typeof value === "number" || typeof value === "bigint") {
			add(8);
			return;
		}
		if (typeof value === "boolean") {
			add(4);
			return;
		}
		if (typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (ArrayBuffer.isView(value)) {
			add(value.byteLength);
			return;
		}
		if (value instanceof ArrayBuffer) {
			add(value.byteLength);
			return;
		}
		if (Array.isArray(value)) {
			add(8);
			for (const item of value) visit(item);
			return;
		}
		add(16);
		for (const [key, child] of Object.entries(value)) {
			add(Buffer.byteLength(key, "utf8"));
			visit(child);
		}
	};
	visit(value);
	return bytes > limit;
}

type MaterializedCacheReference<T extends object> = T | WeakRef<T>;

function dereferenceMaterializedCache<T extends object>(
	cache: MaterializedCacheReference<T> | undefined,
): T | undefined {
	return cache instanceof WeakRef ? cache.deref() : cache;
}

function materializeResidentEntriesForReadSync<T extends FileEntry | SessionEntry>(
	entries: T[],
	stores: ResidentBlobStores,
): T[] {
	return materializeResidentEntriesSync(entries, stores, "placeholder");
}

function materializeResidentEntryForPersistenceSync<T extends FileEntry | SessionEntry>(
	entry: T,
	stores: ResidentBlobStores,
	cache: Map<string, string>,
): T {
	return materializeResidentEntrySync(entry, stores, cache, "placeholder");
}

function materializeResidentEntriesForPersistenceSync<T extends FileEntry | SessionEntry>(
	entries: T[],
	stores: ResidentBlobStores,
): T[] {
	const cache = new Map<string, string>();
	return entries.map(entry => materializeResidentEntryForPersistenceSync(entry, stores, cache));
}

export function residentBlobSentinelForTests(kind: ResidentBlobKind, ref: string): ResidentBlobSentinel {
	return residentBlobSentinel(kind, ref);
}

export function assertResidentReferencesResolvableForTests(
	entries: readonly FileEntry[],
	textStore: BlobStore,
	imageStore: BlobStore = textStore,
	binding: { sessionId?: string; sessionFile?: string } = {},
): void {
	assertResidentReferencesResolvableSync(entries, { textStore, imageStore, ...binding });
}

export function materializeResidentEntriesThrowingForTests<T>(
	entries: T[],
	textStore: BlobStore,
	imageStore: BlobStore = textStore,
	binding: { sessionId?: string; sessionFile?: string } = {},
): T[] {
	return materializeResidentEntriesSync(entries as Array<T & FileEntry>, {
		textStore,
		imageStore,
		...binding,
	}) as T[];
}

export function materializeResidentEntriesForPersistenceForTests<T>(
	entries: T[],
	textStore: BlobStore,
	imageStore: BlobStore = textStore,
): T[] {
	return materializeResidentEntriesForPersistenceSync(entries as Array<T & FileEntry>, {
		textStore,
		imageStore,
	}) as T[];
}
function cloneJsonSemantic<T>(value: T): T {
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(item => cloneJsonSemantic(item)) as T;
	const cloned: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) cloned[key] = cloneJsonSemantic(child);
	return cloned as T;
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
	const cloned = cloneJsonSemantic(entry);
	if (entry.type === "message" && cloned.type === "message") {
		transferSessionMessageIdentity([entry.message], [cloned.message]);
	}
	return cloned;
}

/** Match eager-resume replay sanitation whenever an entry is loaded from a bounded sidecar path. */
function sanitizeLoadedSessionEntryReplayMetadata(entry: SessionEntry): SessionEntry {
	if (entry.type === "message" && entry.message.role === "assistant") {
		entry.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
	}
	return entry;
}

function materializeProviderVisibleEntrySync(entry: SessionEntry, stores: ResidentBlobStores): SessionEntry {
	if (entry.type === "compaction") {
		const cache = new Map<string, string>();
		const summary = materializeResidentValueSync(entry.summary, stores, "summary", cache, "placeholder");
		const shortSummary = materializeResidentValueSync(
			entry.shortSummary,
			stores,
			"shortSummary",
			cache,
			"placeholder",
		);
		const remote = entry.preserveData?.openaiRemoteCompaction;
		const remoteRecord = isRecord(remote) ? remote : undefined;
		const replacementHistory = remoteRecord
			? materializeResidentValueSync(
					remoteRecord.replacementHistory,
					stores,
					"replacementHistory",
					cache,
					"placeholder",
				)
			: undefined;
		const preserveData =
			remoteRecord && replacementHistory !== undefined && replacementHistory !== remoteRecord.replacementHistory
				? {
						...entry.preserveData,
						openaiRemoteCompaction: {
							...remoteRecord,
							replacementHistory,
						},
					}
				: entry.preserveData;
		return {
			...entry,
			summary: typeof summary === "string" ? summary : entry.summary,
			shortSummary: typeof shortSummary === "string" ? shortSummary : entry.shortSummary,
			preserveData,
		};
	}
	if (entry.type === "branch_summary") {
		const summary = materializeResidentValueSync(
			entry.summary,
			stores,
			"summary",
			new Map<string, string>(),
			"placeholder",
		);
		return typeof summary === "string" ? { ...entry, summary } : { ...entry };
	}
	return cloneSessionEntry(entry);
}

const COLD_SPILL_NOTICE = "[Compacted history content evicted to durable cold storage]";
const COLD_SPILL_ARGUMENTS_SENTINEL_KEY = "__gjcColdSpillArguments";
const COLD_SPILL_MIN_CHARS = 1024;

type ColdSpillWrite = {
	path: string;
	encoding: "utf8" | "json";
	data: Buffer;
	originalChars: number;
};

type ColdSpillResidentPromotion = {
	stores: ResidentBlobStores;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isColdSpillArgumentsSentinel(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && value[COLD_SPILL_ARGUMENTS_SENTINEL_KEY] === true;
}

function residentBlobBytesForColdSpill(value: ResidentBlobSentinel, promotion: ColdSpillResidentPromotion): Buffer {
	const hash = parseBlobRef(value.ref);
	if (!hash)
		throw reportResidentBlobMissing(
			new ResidentBlobMissingError(value.ref, value.kind, promotion.stores.sessionId, promotion.stores.sessionFile),
			"cold-spill",
		);
	const store = value.kind === "text" ? promotion.stores.textStore : promotion.stores.imageStore;
	const data = store.getSync(hash);
	if (!data)
		throw reportResidentBlobMissing(
			new ResidentBlobMissingError(hash, value.kind, promotion.stores.sessionId, promotion.stores.sessionFile),
			"cold-spill",
		);
	promotion.stores.onResidentBlobRead?.(value.kind);
	if (value.kind === "imageData") return Buffer.from(data.toString("base64"), "utf8");
	return Buffer.from(data);
}

function coldSpillResidentValue(
	value: ResidentBlobSentinel,
	basePath: string,
	writes: ColdSpillWrite[],
	promotion: ColdSpillResidentPromotion,
): string {
	const data = residentBlobBytesForColdSpill(value, promotion);
	writes.push({ path: basePath, encoding: "utf8", data, originalChars: data.byteLength });
	return COLD_SPILL_NOTICE;
}

function coldSpillTextValue(value: string, basePath: string, writes: ColdSpillWrite[]): string {
	writes.push({ path: basePath, encoding: "utf8", data: Buffer.from(value, "utf8"), originalChars: value.length });
	return COLD_SPILL_NOTICE;
}

function coldSpillJsonValue(value: unknown, basePath: string, writes: ColdSpillWrite[]): Record<string, unknown> {
	const json = JSON.stringify(value);
	writes.push({ path: basePath, encoding: "json", data: Buffer.from(json, "utf8"), originalChars: json.length });
	return {
		[COLD_SPILL_ARGUMENTS_SENTINEL_KEY]: true,
		refPath: basePath,
		notice: COLD_SPILL_NOTICE,
	};
}

function coldSpillSubtreeValue(
	value: unknown,
	basePath: string,
	writes: ColdSpillWrite[],
	promotion: ColdSpillResidentPromotion,
): unknown {
	if (isResidentBlobSentinel(value)) return coldSpillResidentValue(value, basePath, writes, promotion);
	if (isColdSpillArgumentsSentinel(value)) return value;
	if (typeof value === "string") {
		return value.length >= COLD_SPILL_MIN_CHARS ? coldSpillTextValue(value, basePath, writes) : value;
	}
	if (Array.isArray(value)) {
		if (!containsResidentSentinel(value)) {
			const json = JSON.stringify(value);
			return json.length >= COLD_SPILL_MIN_CHARS ? coldSpillJsonValue(value, basePath, writes) : value;
		}
		let changed = false;
		const next = value.map((child, index) => {
			const replaced = coldSpillSubtreeValue(child, `${basePath}.${index}`, writes, promotion);
			if (replaced !== child) changed = true;
			return replaced;
		});
		return changed ? next : value;
	}
	if (!isRecord(value)) return value;
	if (!containsResidentSentinel(value)) {
		const json = JSON.stringify(value);
		return json.length >= COLD_SPILL_MIN_CHARS ? coldSpillJsonValue(value, basePath, writes) : value;
	}
	let changed = false;
	const entries = Object.entries(value).map(([key, child]) => {
		const replaced = coldSpillSubtreeValue(child, `${basePath}.${key}`, writes, promotion);
		if (replaced !== child) changed = true;
		return [key, replaced] as const;
	});
	return changed ? Object.fromEntries(entries) : value;
}

function coldSpillArgumentsValue(
	value: unknown,
	basePath: string,
	writes: ColdSpillWrite[],
	promotion: ColdSpillResidentPromotion,
): unknown {
	return coldSpillSubtreeValue(value, basePath, writes, promotion);
}

function coldSpillContentBlock(
	block: unknown,
	basePath: string,
	writes: ColdSpillWrite[],
	promotion: ColdSpillResidentPromotion,
): unknown {
	if (!isRecord(block) || typeof block.type !== "string") return block;
	if (isResidentBlobSentinel(block)) return coldSpillResidentValue(block, basePath, writes, promotion);
	if (block.type === "image") return block;
	if (block.type === "text") {
		const text = block.text;
		if (isResidentBlobSentinel(text))
			return { ...block, text: coldSpillResidentValue(text, `${basePath}.text`, writes, promotion) };
		if (typeof text !== "string" || text.length < COLD_SPILL_MIN_CHARS) return block;
		return { ...block, text: coldSpillTextValue(text, `${basePath}.text`, writes) };
	}
	if (block.type === "thinking") {
		const thinking = block.thinking;
		if (typeof thinking !== "string" || thinking.length < COLD_SPILL_MIN_CHARS) return block;
		return { ...block, thinking: coldSpillTextValue(thinking, `${basePath}.thinking`, writes) };
	}
	if (block.type === "redactedThinking") {
		const data = block.data;
		if (typeof data !== "string" || data.length < COLD_SPILL_MIN_CHARS) return block;
		return { ...block, data: coldSpillTextValue(data, `${basePath}.data`, writes) };
	}
	if (block.type === "toolCall") {
		const args = block.arguments;
		if (isColdSpillArgumentsSentinel(args)) return block;
		const json = JSON.stringify(args);
		if (json.length < COLD_SPILL_MIN_CHARS && !containsResidentSentinel(args)) return block;
		const nextArgs = coldSpillArgumentsValue(args, `${basePath}.arguments`, writes, promotion);
		return nextArgs === args ? block : { ...block, arguments: nextArgs };
	}
	let changed = false;
	const entries = Object.entries(block).map(([key, child]) => {
		const replaced = key === "type" ? child : coldSpillSubtreeValue(child, `${basePath}.${key}`, writes, promotion);
		if (replaced !== child) changed = true;
		return [key, replaced] as const;
	});
	return changed ? Object.fromEntries(entries) : block;
}

function coldSpillContentBlocks(
	value: unknown[],
	basePath: string,
	writes: ColdSpillWrite[],
	promotion: ColdSpillResidentPromotion,
): unknown {
	if (!containsResidentSentinel(value)) {
		let changedRuns = false;
		const merged: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const block = value[index];
			if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
				const start = index;
				const texts: string[] = [];
				while (index < value.length) {
					const runBlock = value[index];
					if (!isRecord(runBlock) || runBlock.type !== "text" || typeof runBlock.text !== "string") break;
					texts.push(runBlock.text);
					index++;
				}
				index--;
				const text = texts.join("");
				if (text.length >= COLD_SPILL_MIN_CHARS) {
					changedRuns = true;
					merged.push({ ...block, text: coldSpillTextValue(text, `${basePath}.${start}.text`, writes) });
				} else {
					merged.push(...value.slice(start, index + 1));
				}
				continue;
			}
			const replaced = coldSpillContentBlock(block, `${basePath}.${index}`, writes, promotion);
			if (replaced !== block) changedRuns = true;
			merged.push(replaced);
		}
		if (changedRuns) return merged;
	}
	let changed = false;
	const next = value.map((block, index) => {
		const replaced = coldSpillContentBlock(block, `${basePath}.${index}`, writes, promotion);
		if (replaced !== block) changed = true;
		return replaced;
	});
	return changed ? next : value;
}

function coldSpillCustomMessageContent(
	content: CustomMessageEntry["content"],
	writes: ColdSpillWrite[],
	promotion: ColdSpillResidentPromotion,
): CustomMessageEntry["content"] {
	if (typeof content === "string") {
		return content.length >= COLD_SPILL_MIN_CHARS
			? coldSpillTextValue(content, "custom_message.content", writes)
			: content;
	}
	if (Array.isArray(content))
		return coldSpillContentBlocks(
			content,
			"custom_message.content",
			writes,
			promotion,
		) as CustomMessageEntry["content"];
	return content;
}

function coldSpillUnavailable(ref: ColdSpillRef): string {
	return `[Cold-spill blob unavailable: ${ref.ref}; original ${ref.originalChars} chars unavailable]`;
}

function rehydrateColdSpillRef(ref: ColdSpillRef, blobStore: BlobStore, residentStores?: ResidentBlobStores): unknown {
	const hash = ref.ref.startsWith("blob:sha256:") ? ref.ref.slice("blob:sha256:".length) : ref.sha256;
	const data = blobStore.getCheckedSync(hash);
	if (!data || hash !== ref.sha256) return coldSpillUnavailable(ref);
	const text = data.toString("utf8");
	if (ref.encoding === "json") {
		try {
			const parsed = JSON.parse(text) as unknown;
			return residentStores ? materializeResidentValueSync(parsed, residentStores) : parsed;
		} catch {
			return coldSpillUnavailable(ref);
		}
	}
	return text;
}

function rehydrateColdSpillValue(
	value: unknown,
	marker: EvictedContentMarker | undefined,
	blobStore: BlobStore,
	basePath: string,
	residentStores?: ResidentBlobStores,
): unknown {
	const directRef = marker?.payloads[basePath];
	if (directRef) return rehydrateColdSpillRef(directRef, blobStore, residentStores);
	if (isColdSpillArgumentsSentinel(value) && typeof value.refPath === "string") {
		const ref = marker?.payloads[value.refPath];
		return ref ? rehydrateColdSpillRef(ref, blobStore, residentStores) : value;
	}
	if (Array.isArray(value))
		return value.map((item, index) =>
			rehydrateColdSpillValue(item, marker, blobStore, `${basePath}.${index}`, residentStores),
		);
	if (!isRecord(value)) return value;
	const entries = Object.entries(value).map(([key, child]) => {
		if (key === "evictedContent") return [key, child] as const;
		return [key, rehydrateColdSpillValue(child, marker, blobStore, `${basePath}.${key}`, residentStores)] as const;
	});
	return Object.fromEntries(entries);
}

/**
 * Enforce the provider-facing invariant that a tool call's `arguments` is an
 * object, after cold-spill rehydration has had its say.
 *
 * `rehydrateColdSpillRef` reports an unrecoverable payload by returning the
 * human-readable `coldSpillUnavailable(...)` sentence, and a blob holding a
 * non-object JSON value rehydrates as that value. Either outcome lands a
 * non-object on `toolCall.arguments`, which every provider then forwards
 * verbatim — Anthropic serializes it straight into `tool_use.input` and the
 * request fails with `tool_use.input: Input should be a valid dictionary`.
 * That rejection is fatal for the whole transcript, so one missing blob makes
 * a session permanently unresumable with no actionable diagnostic.
 *
 * Degrade to the existing malformed-arguments contract instead: the recovered
 * text is preserved under `recoveryNotice` for the reader, and the agent loop
 * rejects just that call with reason-specific, retryable guidance rather than
 * letting the provider reject the entire request.
 */
function enforceToolCallArgumentObjects(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "toolCall" || isRecord(block.arguments)) return block;
		changed = true;
		const recovered = block.arguments;
		return {
			...block,
			arguments: {
				recoveryNotice:
					typeof recovered === "string"
						? recovered
						: `[Cold-spill payload for this tool call rehydrated as ${
								recovered === null ? "null" : typeof recovered
							}, not an object]`,
			},
			incompleteArguments: true,
			incompleteArgumentsReason: "malformed" as const,
		};
	});
	return changed ? ({ ...message, content } as AgentMessage) : message;
}

function rehydrateColdSpillEntry(
	entry: SessionEntry,
	blobStore: BlobStore,
	residentStores?: ResidentBlobStores,
): SessionEntry {
	if (entry.type === "message") {
		const marker = entry.evictedContent;
		const message = enforceToolCallArgumentObjects(
			rehydrateColdSpillValue(entry.message, marker, blobStore, "message", residentStores) as AgentMessage,
		);
		return { ...entry, message };
	}
	if (entry.type === "custom_message") {
		const marker = entry.evictedContent;
		return rehydrateColdSpillValue(entry, marker, blobStore, "custom_message", residentStores) as CustomMessageEntry;
	}
	return cloneSessionEntry(entry);
}

async function truncateForPersistence(obj: FileEntry, blobStore: BlobStore, key?: string): Promise<FileEntry>;
async function truncateForPersistence(obj: string, blobStore: BlobStore, key?: string): Promise<string>;
async function truncateForPersistence(obj: unknown[], blobStore: BlobStore, key?: string): Promise<unknown[]>;
async function truncateForPersistence(obj: object, blobStore: BlobStore, key?: string): Promise<object>;
async function truncateForPersistence(obj: unknown, blobStore: BlobStore, key?: string): Promise<unknown>;
async function truncateForPersistence(
	obj: null | undefined,
	blobStore: BlobStore,
	key?: string,
): Promise<null | undefined>;
async function truncateForPersistence(obj: unknown, blobStore: BlobStore, key?: string): Promise<unknown> {
	if (obj === null || obj === undefined) return obj;

	if (typeof obj === "string") {
		if ((key === "image_url" || key === "image_url.url") && isImageDataUrl(obj)) {
			return externalizeImageDataUrl(blobStore, obj);
		}

		if (obj.length > MAX_PERSIST_CHARS) {
			// Cryptographic signatures must be preserved exactly or cleared entirely — never truncated.
			// Truncation would produce an invalid signature that the API rejects.
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
				return "";
			}

			const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
			return `${truncateString(obj, limit)}${TRUNCATION_NOTICE}`;
		}

		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		const result = await Promise.all(
			obj.map(async item => {
				// Keep durable JSONL bounded and lossless for large images. Resident
				// sentinels are materialized before this serializer runs, so persistence
				// still owns the existing blob-ref-on-disk contract.
				if (key === TEXT_CONTENT_KEY && isImageBlock(item)) {
					if (!isBlobRef(item.data) && item.data.length >= BLOB_EXTERNALIZE_THRESHOLD) {
						changed = true;
						const blobRef = await externalizeImageData(blobStore, item.data);
						return { ...item, data: blobRef };
					}
				}
				const newItem = await truncateForPersistence(item, blobStore, key);
				if (newItem !== item) changed = true;
				return newItem;
			}),
		);
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = await Promise.all(
			Object.entries(obj).flatMap(([childKey, value]) => {
				// Strip transient/redundant properties that shouldn't be persisted.
				// - partialJson: streaming accumulator for tool call JSON parsing
				// - jsonlEvents: raw subprocess streaming events (already saved to artifact files)
				if (childKey === "partialJson" || childKey === "jsonlEvents") {
					changed = true;
					return [];
				}

				return [
					(async () => {
						if (
							childKey === "image_url" &&
							typeof value === "object" &&
							value !== null &&
							typeof (value as { url?: unknown }).url === "string"
						) {
							let imageUrlChanged = false;
							const imageUrlEntries = await Promise.all(
								Object.entries(value).map(async ([imageUrlKey, imageUrlValue]) => {
									const persistenceKey = imageUrlKey === "url" ? "image_url.url" : imageUrlKey;
									const newImageUrlValue = await truncateForPersistence(
										imageUrlValue,
										blobStore,
										persistenceKey,
									);
									if (newImageUrlValue !== imageUrlValue) imageUrlChanged = true;
									return [imageUrlKey, newImageUrlValue] as const;
								}),
							);
							if (imageUrlChanged) {
								changed = true;
								return [childKey, Object.fromEntries(imageUrlEntries)] as const;
							}
						}
						const newValue = await truncateForPersistence(value, blobStore, childKey);
						if (newValue !== value) changed = true;
						return [childKey, newValue] as const;
					})(),
				];
			}),
		);

		if (!changed) return obj;

		const contentEntry = entries.find(([childKey]) => childKey === "content");
		const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
		if (
			contentEntry &&
			typeof contentEntry[1] === "string" &&
			lineCountEntry &&
			typeof lineCountEntry[1] === "number"
		) {
			const content = contentEntry[1];
			const updatedEntries = entries.map(([childKey, value]) =>
				childKey === "lineCount" ? ([childKey, content.split("\n").length] as const) : ([childKey, value] as const),
			);
			return Object.fromEntries(updatedEntries);
		}
		return Object.fromEntries(entries);
	}

	return obj;
}

async function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): Promise<FileEntry> {
	// Bound edit snapshots before the generic 500k string truncation so the
	// receipt hashes/lengths identify the exact source bodies, not truncated
	// prefixes of files larger than MAX_PERSIST_CHARS (#4566).
	return (await truncateForPersistence(boundEditSnapshotFieldsForEntry(entry), blobStore)) as FileEntry;
}

/**
 * Synchronous variant of {@link truncateForPersistence}.
 *
 * The async version's overhead — `Promise.all` over `Object.entries`/`Array.prototype.map`,
 * one microtask hop per nested node — is pure waste for entries without image blobs
 * (the vast majority). The fast path runs in one synchronous tick so an OOM/SIGKILL
 * landing right after `_persist` returns cannot lose the entry. Image externalization
 * still happens, but via the synchronous blob-store path (`fs.writeFileSync`), so the
 * blob bytes are in the kernel page cache before the JSONL line referencing them is
 * written.
 */
function truncateForPersistenceSync(obj: unknown, blobStore: BlobStore, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;

	if (typeof obj === "string") {
		if ((key === "image_url" || key === "image_url.url") && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		if (obj.length > MAX_PERSIST_CHARS) {
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
				return "";
			}
			const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
			return `${truncateString(obj, limit)}${TRUNCATION_NOTICE}`;
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			if (key === TEXT_CONTENT_KEY && isImageBlock(item)) {
				if (!isBlobRef(item.data) && item.data.length >= BLOB_EXTERNALIZE_THRESHOLD) {
					changed = true;
					const blobRef = externalizeImageDataSync(blobStore, item.data);
					result[i] = { ...item, data: blobRef };
					continue;
				}
			}
			const newItem = truncateForPersistenceSync(item, blobStore, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const [childKey, value] of Object.entries(obj)) {
			if (childKey === "partialJson" || childKey === "jsonlEvents") {
				changed = true;
				continue;
			}
			if (
				childKey === "image_url" &&
				typeof value === "object" &&
				value !== null &&
				typeof (value as { url?: unknown }).url === "string"
			) {
				let imageUrlChanged = false;
				const imageUrlEntries = Object.entries(value).map(([imageUrlKey, imageUrlValue]) => {
					const persistenceKey = imageUrlKey === "url" ? "image_url.url" : imageUrlKey;
					const newImageUrlValue = truncateForPersistenceSync(imageUrlValue, blobStore, persistenceKey);
					if (newImageUrlValue !== imageUrlValue) imageUrlChanged = true;
					return [imageUrlKey, newImageUrlValue] as const;
				});
				if (imageUrlChanged) {
					changed = true;
					entries.push([childKey, Object.fromEntries(imageUrlEntries)]);
					continue;
				}
			}
			const newValue = truncateForPersistenceSync(value, blobStore, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		if (!changed) return obj;

		const contentEntry = entries.find(([childKey]) => childKey === "content");
		const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
		if (
			contentEntry &&
			typeof contentEntry[1] === "string" &&
			lineCountEntry &&
			typeof lineCountEntry[1] === "number"
		) {
			const content = contentEntry[1];
			const updatedEntries = entries.map(([childKey, value]) =>
				childKey === "lineCount" ? ([childKey, content.split("\n").length] as const) : ([childKey, value] as const),
			);
			return Object.fromEntries(updatedEntries);
		}
		return Object.fromEntries(entries);
	}

	return obj;
}

function prepareEntryForPersistenceSync(entry: FileEntry, blobStore: BlobStore): FileEntry {
	// Keep this ordering identical to the async path: snapshot receipts must be
	// computed from the complete body before generic persistence truncation.
	return truncateForPersistenceSync(boundEditSnapshotFieldsForEntry(entry), blobStore) as FileEntry;
}

/**
 * Apply {@link boundEditSnapshotFields} to a persisted entry's edit-result
 * details. Only `message` entries with `role === "toolResult"` and a `details`
 * object can carry edit snapshots; everything else returns unchanged, so the
 * walk never touches unrelated entries (#4566).
 */
function boundEditSnapshotFieldsForEntry(entry: FileEntry): FileEntry {
	if (entry.type !== "message") return entry;
	const message = entry.message;
	if (message === null || typeof message !== "object" || (message as { role?: unknown }).role !== "toolResult")
		return entry;
	const details = (message as { details?: unknown }).details;
	if (details === null || typeof details !== "object" || Array.isArray(details)) return entry;
	const bounded = boundEditSnapshotFields(details, new WeakSet());
	if (bounded === details) return entry;
	return { ...entry, message: { ...(message as object), details: bounded } } as FileEntry;
}

class NdjsonFileWriter {
	#writer: SessionStorageWriter;
	#closed = false;
	#closing = false;
	#error: Error | undefined;
	#pendingWrites: Promise<void> = Promise.resolve();
	#onError: ((err: Error) => void) | undefined;
	#closeDrained = false;

	constructor(
		storage: SessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void; securityContext?: ManagedSessionSecurityContext },
	) {
		this.#onError = options?.onError;
		this.#writer = storage.openWriter(path, {
			flags: options?.flags ?? "a",
			onError: (err: Error) => this.#recordError(err),
			securityContext: options?.securityContext,
		});
	}

	#recordError(err: unknown): Error {
		const writeErr = toError(err);
		if (!this.#error) this.#error = writeErr;
		this.#onError?.(writeErr);
		return writeErr;
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const run = async () => {
			if (this.#error) throw this.#error;
			await task();
		};
		const next = this.#pendingWrites.then(run);
		void next.catch((err: unknown) => {
			if (!this.#error) this.#error = toError(err);
		});
		this.#pendingWrites = next;
		return next;
	}

	async #writeLine(line: string): Promise<void> {
		if (this.#error) throw this.#error;
		try {
			await this.#writer.writeLine(line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	/** Queue a write. Returns a promise so callers can await if needed. */
	write(entry: FileEntry | SessionPatchRecord): Promise<void> {
		if (this.#closed || this.#closing) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const line = `${JSON.stringify(entry)}\n`;
		return this.#enqueue(() => this.#writeLine(line));
	}

	/**
	 * Synchronously serialize and append the entry. Returns once `fs.writeSync` has handed
	 * the bytes to the kernel page cache — durable across OOM/SIGKILL even before fsync.
	 *
	 * Callers MUST NOT mix this with pending async `write()` calls on the same writer:
	 * the async path is queued through `#pendingWrites`, but this method bypasses the
	 * queue. Use only when no concurrent async write is in flight (the session-manager
	 * persist path enforces this via `#flushed`/`#needsFullRewriteOnNextPersist`).
	 */
	writeSync(entry: FileEntry | SessionPatchRecord): void {
		if (this.#closed || this.#closing) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const line = `${JSON.stringify(entry)}\n`;
		try {
			this.#writer.writeLineSync(line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}
	fsyncSync(): void {
		if (this.#closed || this.#closing) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		if (!this.#writer.fsyncSync) throw new Error("Synchronous session writer fsync is unavailable");
		try {
			this.#writer.fsyncSync();
		} catch (err) {
			throw this.#recordError(err);
		}
	}
	statSync(): SessionStorageStat {
		if (this.#closed || this.#closing) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		if (!this.#writer.statSync) throw new Error("Synchronous session writer descriptor capture is unavailable");
		try {
			return this.#writer.statSync();
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	/** Flush all buffered data to disk. Waits for all queued writes. */
	async flush(): Promise<void> {
		if (this.#closed) return;
		if (this.#error) throw this.#error;

		await this.#enqueue(async () => {});

		if (this.#error) throw this.#error;

		try {
			await this.#writer.flush();
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	/** Sync data to persistent storage. */
	async fsync(): Promise<void> {
		if (this.#closed) return;
		if (this.#error) throw this.#error;
		try {
			await this.#writer.fsync();
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	/** Close the writer, flushing all data. Retryable across certified pre-dispatch failures. */
	async close(): Promise<void> {
		// Terminal (confirmed closed or quarantined close_unknown): no further attempts.
		if (this.#closed) return;
		// Re-entry guard: once a fresh attempt has started draining, block concurrent
		// close() calls. A retry after a certified pre-dispatch failure has #closing
		// reset and #closeDrained set, so it re-enters to actually re-dispatch the
		// underlying OS close — the wrapper must NOT mark itself closed on a retryable
		// failure, and must allow a genuine later retry.
		if (this.#closing) return;

		this.#closing = true;

		let drainError: Error | undefined;
		// Only drain once: a retry after a pre-dispatch failure has already flushed
		// pending writes, and the underlying writer rejects further flushes while in
		// the retryable state. Re-draining would mask the close retry with that error.
		if (!this.#closeDrained) {
			try {
				await this.flush();
			} catch (err) {
				drainError = toError(err);
			}
			try {
				await this.#pendingWrites;
			} catch (err) {
				if (!drainError) drainError = toError(err);
			}
			this.#closeDrained = true;
		}

		try {
			await this.#writer.close();
		} catch (err) {
			if (this.#writer.getCloseState() === "close_failed_retryable") {
				// Certified pre-dispatch failure: the numeric fd is still owned and a
				// later retry is safe. Do NOT mark the wrapper closed, do NOT poison
				// #error (the retry must still be able to flush/close), and reset
				// #closing so the retry can actually re-dispatch. Surface the failure —
				// a partial close is never reported as success.
				this.#closing = false;
				throw toError(err);
			}
			// close_unknown (quarantined) or other dispatched failure: terminal. Record
			// the error and mark the wrapper closed so no retry/finalizer touches the
			// uncertain fd again.
			this.#closed = true;
			throw this.#recordError(err);
		}

		// Confirmed closed (underlying close succeeded).
		this.#closed = true;

		if (drainError) throw drainError;
		if (this.#error) throw this.#error;
	}

	/** Check if there's a stored error. */
	getError(): Error | undefined {
		return this.#error;
	}

	/**
	 * True only while the writer accepts new writes. A retryable close failure
	 * leaves the wrapper non-terminal but the underlying fd rejects writes, so
	 * callers route appends around it rather than through it.
	 */
	isOpen(): boolean {
		if (this.#closed || this.#closing) return false;
		return this.#writer.getCloseState() === "open";
	}

	/**
	 * Truthful synchronous close used by the atomic-rewrite path: dispatches the
	 * underlying close synchronously and throws on failure so a close failure is
	 * observable BEFORE the rename step. No fire-and-forget: the old suppression
	 * (`close().catch(() => {})`) let a rename proceed on an unclosed file.
	 */
	closeSync(): void {
		if (this.#closed) return;
		if (this.#closing) return;
		// The sync path's writeSync bypasses the async queue, so #pendingWrites is
		// not applicable; the caller has already issued every writeSync before this.
		try {
			this.#writer.closeSync();
		} catch (err) {
			if (this.#writer.getCloseState() === "close_failed_retryable") {
				// Retryable: keep the wrapper open for the cleanup retry in the caller's
				// catch block; surface the failure so the rename is skipped.
				throw toError(err);
			}
			this.#closed = true;
			throw this.#recordError(err);
		}
		this.#closed = true;
	}

	/** Certainty-aware close state of the underlying storage writer. */
	getCloseState(): SessionStorageWriterCloseState {
		return this.#writer.getCloseState();
	}

	/** Stored error for a non-success underlying close state. */
	getCloseError(): Error | undefined {
		return this.#writer.getCloseError();
	}
}

const PROJECT_SESSION_SCAN_MAX_DIRECTORIES = 4096;
const PROJECT_SESSION_SCAN_MAX_FILES = 1000;

function isProjectSessionTranscriptPath(projectGjcDir: string, filePath: string): boolean {
	if (isStagedSessionPath(filePath)) return false;
	const relative = path.relative(projectGjcDir, filePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	const segments = relative.split(path.sep);
	if (segments.includes(SESSION_STAGING_DIRNAME)) return false;
	if (segments.length === 1) return true;
	const parent = segments.at(-2);
	return parent === "agent-session" || segments.includes("sessions");
}

/**
 * Discover resumable transcripts intentionally stored inside a project's `.gjc`.
 * Runtime token/audit JSONL files are excluded by requiring a known transcript
 * container (`agent-session` or `sessions`).
 */
export function listProjectSessionTranscriptFiles(cwd: string): string[] {
	const projectGjcDir = path.join(path.resolve(cwd), ".gjc");
	let rootStat: fs.Stats;
	try {
		rootStat = fs.lstatSync(projectGjcDir);
	} catch {
		return [];
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];

	const directories = [projectGjcDir];
	const files: string[] = [];
	let scannedDirectories = 0;
	while (directories.length > 0 && scannedDirectories < PROJECT_SESSION_SCAN_MAX_DIRECTORIES) {
		const directory = directories.pop()!;
		scannedDirectories++;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === SESSION_STAGING_DIRNAME) continue;
				directories.push(entryPath);
				continue;
			}
			if (
				entry.isFile() &&
				!entry.name.startsWith(".") &&
				entry.name.endsWith(".jsonl") &&
				isProjectSessionTranscriptPath(projectGjcDir, entryPath)
			) {
				files.push(entryPath);
				if (files.length >= PROJECT_SESSION_SCAN_MAX_FILES) return files;
			}
		}
	}
	return files;
}

async function collectProjectSessions(cwd: string, storage: FileSessionStorage): Promise<SessionInfo[]> {
	return await collectSessionsFromFiles(listProjectSessionTranscriptFiles(cwd), storage);
}

function mergeSessionInventories(...inventories: SessionInfo[][]): SessionInfo[] {
	const sessions = new Map<string, SessionInfo>();
	for (const inventory of inventories) {
		for (const session of inventory) {
			const current = sessions.get(session.id);
			if (!current || session.modified.getTime() > current.modified.getTime()) sessions.set(session.id, session);
		}
	}
	return [...sessions.values()].sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

const DEFAULT_WELCOME_RECENT_SESSION_LIMIT = 20;

/** Get recent sessions for display in welcome screen */
export async function getRecentSessions(
	sessionDir: string,
	limit = DEFAULT_WELCOME_RECENT_SESSION_LIMIT,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<RecentSessionInfo[]> {
	return getSortedSessions(sessionDir, storage, limit);
}

export function getRecentSessionDisplay(
	sessions: readonly SessionInfo[],
	limit = DEFAULT_WELCOME_RECENT_SESSION_LIMIT,
): Array<{ name: string; timeAgo: string }> {
	return sessions.slice(0, limit).map(session => {
		const recent = new RecentSessionInfo(
			session.path,
			session.modified.getTime(),
			{ title: session.title, timestamp: session.created.toISOString() },
			session.firstMessage,
		);
		return { name: recent.name, timeAgo: recent.timeAgo };
	});
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export interface UsageStatistics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	premiumRequests: number;
	cost: number;
}

function getTaskToolUsage(details: unknown): Usage | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	const usage = record.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage as Usage;
}

interface ValidatedUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	premiumRequests: number;
	cost: number;
}

/** Max malformed-usage entry ids sampled for a single resume-time report. */
const MALFORMED_USAGE_SAMPLE_LIMIT = 8;

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validate an untrusted persisted `usage` record before it is aggregated into
 * session usage statistics. `parseSessionEntries` accepts any parseable JSON, so a
 * torn/corrupt record can carry a `usage` that is still valid JSON yet malformed:
 * absent (`{}` yields NaN), numeric strings (`"10"` coerces sums into strings), or
 * negative buckets that silently reduce totals. Returns the validated finite
 * non-negative totals, or null when any bucket or `cost.total` is malformed — the
 * caller then skips and reports that record rather than poisoning every
 * getUsageStatistics() consumer. Absent `premiumRequests`/`cost` default to 0
 * (backward-compatible with older transcripts); a present-but-invalid field is
 * rejected.
 */
function validatePersistedUsageTotals(usage: unknown): ValidatedUsageTotals | null {
	if (typeof usage !== "object" || usage === null) return null;
	const record = usage as Record<string, unknown>;
	const input = record.input;
	const output = record.output;
	const cacheRead = record.cacheRead;
	const cacheWrite = record.cacheWrite;
	if (
		!isFiniteNonNegativeNumber(input) ||
		!isFiniteNonNegativeNumber(output) ||
		!isFiniteNonNegativeNumber(cacheRead) ||
		!isFiniteNonNegativeNumber(cacheWrite)
	)
		return null;
	// Default only on truly absent (=== undefined) properties; a present-but-null/invalid
	// premiumRequests is malformed, not zero.
	const premiumRequests = record.premiumRequests === undefined ? 0 : record.premiumRequests;
	if (!isFiniteNonNegativeNumber(premiumRequests)) return null;
	const rawCost = record.cost;
	let cost: unknown = 0;
	if (rawCost !== undefined) {
		// A present `cost` must be a non-array record carrying a finite non-negative `total`;
		// null, arrays, and an absent/invalid `total` are malformed — never silently zero.
		if (typeof rawCost !== "object" || rawCost === null || Array.isArray(rawCost)) return null;
		cost = (rawCost as Record<string, unknown>).total;
	}
	if (!isFiniteNonNegativeNumber(cost)) return null;
	return { input, output, cacheRead, cacheWrite, premiumRequests, cost };
}

function extractTextFromContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

const SESSION_LIST_PREFIX_BYTES = 4096;
// Reverse-scan chunk for trailing header patches. Sized independently of the
// 4 KiB prefix buffer: the scan walks back to BOF whenever a field stays
// unresolved (#3633), which is the common case because most transcripts carry
// no header_patch at all. A 4 KiB chunk turned that walk into one read syscall
// per 4 KiB of transcript and defeated OS readahead, so listing cost scaled
// with total transcript bytes on every resume.
const SESSION_LIST_TRAILING_PATCH_BYTES = 64 * 1024;
const SESSION_NAME_MAX_CHARS = 1_000;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;
const sessionListPrefixDecoder = new TextDecoder("utf-8", { fatal: false });

async function readSessionListPrefix(file: string, storage: SessionStorage, buffer: Buffer): Promise<string> {
	if (!(storage instanceof FileSessionStorage)) {
		return storage.readTextPrefix(file, buffer.byteLength);
	}

	const handle = await fs.promises.open(file, "r");
	try {
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		return sessionListPrefixDecoder.decode(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

async function readSessionListTrailingPatches(
	file: string,
	storage: SessionStorage,
): Promise<HeaderPatchRecord["patch"][]> {
	if (!(storage instanceof FileSessionStorage)) {
		const content = await storage.readText(file);
		const entries = parseSessionEntries(content);
		const header = entries[0] as SessionHeader | undefined;
		return header?.type === "session" ? [{ cwd: header.cwd, title: header.title }] : [];
	}

	const size = storage.statSync(file).size;
	if (size <= SESSION_LIST_PREFIX_BYTES) return [];
	const latest: HeaderPatchRecord["patch"] = {};
	let position = size;
	// Reverse-scan from EOF in fixed chunks. Stop once both cwd and title
	// resolve so recent patches stay cheap. Continue past the historical 16 KiB
	// window when a field is still missing so a buried but canonically valid
	// header_patch remains listable without a full sequential JSONL parse (#3633).
	// Chunks that cannot contain a header_patch marker skip JSON parsing.
	//
	// The scan owns its buffer instead of borrowing the caller's 4 KiB prefix
	// buffer. A transcript with no header_patch at all — the common case, since
	// only /rename and workspace moves emit one — cannot be recognized without
	// reaching BOF, so the chunk size sets how many read syscalls a resume costs
	// per transcript byte.
	let trailingFragment = Buffer.alloc(0);
	const chunkSize = Math.min(size, SESSION_LIST_TRAILING_PATCH_BYTES);
	const buffer = Buffer.allocUnsafe(chunkSize);
	const headerPatchMarker = Buffer.from("header_patch");
	const handle = await fs.promises.open(file, "r");
	try {
		while (position > 0 && (latest.cwd === undefined || latest.title === undefined)) {
			const start = Math.max(0, position - chunkSize);
			const length = position - start;
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			const combined = Buffer.concat([buffer.subarray(0, bytesRead), trailingFragment]);
			let complete = combined;
			if (start > 0) {
				const firstNewline = combined.indexOf(0x0a);
				if (firstNewline === -1) {
					trailingFragment = combined;
					position = start;
					continue;
				}
				trailingFragment = combined.subarray(0, firstNewline);
				complete = combined.subarray(firstNewline + 1);
			}
			// Marker may straddle the discarded partial first line; still parse when
			// the raw chunk or carried fragment could hold a header_patch record.
			const mayContainPatch =
				complete.includes(headerPatchMarker) ||
				buffer.subarray(0, bytesRead).includes(headerPatchMarker) ||
				trailingFragment.includes(headerPatchMarker);
			if (mayContainPatch) {
				const lines = complete.toString("utf8").split("\n");
				for (let index = lines.length - 1; index >= 0; index--) {
					const line = lines[index];
					if (!line?.includes("header_patch")) continue;
					try {
						const record = JSON.parse(line) as SessionPatchRecord;
						if (!isHeaderPatchRecord(record)) continue;
						if (latest.cwd === undefined && typeof record.patch.cwd === "string") latest.cwd = record.patch.cwd;
						if (latest.title === undefined && typeof record.patch.title === "string")
							latest.title = record.patch.title;
					} catch {
						// Ignore malformed or partial records exactly as the canonical loader does.
					}
				}
			}
			position = start;
		}
		return latest.cwd === undefined && latest.title === undefined ? [] : [latest];
	} finally {
		await handle.close();
	}
}

function applySessionListHeaderPatch(header: SessionListHeader, patch: HeaderPatchRecord["patch"]): void {
	if (typeof patch.cwd === "string") header.cwd = patch.cwd;
	if (typeof patch.title === "string") header.title = patch.title;
}
function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;

	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;

	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;

	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) {
			return decodeJsonStringFragment(source.slice(valueStart, i));
		}
	}

	return decodeJsonStringFragment(source.slice(valueStart));
}

function countMessageMarkers(content: string): number {
	let count = 0;
	let index = 0;
	while (index < content.length) {
		const typeIndex = content.indexOf('"type"', index);
		if (typeIndex === -1) break;
		const colonIndex = content.indexOf(":", typeIndex + 6);
		if (colonIndex === -1) break;
		const type = extractStringProperty(content, "type", typeIndex);
		if (type === "message") count++;
		index = colonIndex + 1;
	}
	return count;
}

function extractFirstUserMessageFromPrefix(content: string): string | undefined {
	const roleIndex = content.indexOf('"role"');
	if (roleIndex === -1) return undefined;

	let index = roleIndex;
	while (index !== -1) {
		const role = extractStringProperty(content, "role", index);
		if (role === "user") {
			return extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
		}
		index = content.indexOf('"role"', index + 6);
	}

	return undefined;
}

interface SessionListHeader {
	type: "session";
	id: string;
	version?: number;

	cwd?: string;
	title?: string;
	parentSession?: string;
	timestamp?: string;
}

function parseSessionListHeader(
	content: string,
	entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
	const parsedHeader = entries[0];
	if (parsedHeader?.type === "session" && typeof parsedHeader.id === "string") {
		return {
			type: "session",
			id: parsedHeader.id,
			version: typeof parsedHeader.version === "number" ? parsedHeader.version : undefined,
			cwd: typeof parsedHeader.cwd === "string" ? parsedHeader.cwd : undefined,
			title: typeof parsedHeader.title === "string" ? parsedHeader.title : undefined,
			parentSession: typeof parsedHeader.parentSession === "string" ? parsedHeader.parentSession : undefined,
			timestamp: typeof parsedHeader.timestamp === "string" ? parsedHeader.timestamp : undefined,
		};
	}

	const firstLineEnd = content.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
	if (extractStringProperty(firstLine, "type") !== "session") return undefined;

	const id = extractStringProperty(firstLine, "id");
	if (!id) return undefined;

	return {
		type: "session",
		id,
		version: Number(extractStringProperty(firstLine, "version")) || undefined,
		cwd: extractStringProperty(firstLine, "cwd"),
		title: extractStringProperty(firstLine, "title"),
		parentSession: extractStringProperty(firstLine, "parentSession"),
		timestamp: extractStringProperty(firstLine, "timestamp"),
	};
}

function getSessionListWorkerCount(fileCount: number): number {
	if (fileCount <= SESSION_LIST_PARALLEL_THRESHOLD) return 1;
	return Math.min(
		SESSION_LIST_MAX_WORKERS,
		os.availableParallelism(),
		Math.ceil(fileCount / SESSION_LIST_PARALLEL_THRESHOLD),
	);
}

async function collectSessionFromFile(
	file: string,
	storage: SessionStorage,
	buffer: Buffer,
): Promise<SessionInfo | undefined> {
	try {
		const content = await readSessionListPrefix(file, storage, buffer);
		const entries = parseSessionEntries(content).map(entry => entry as unknown as Record<string, unknown>);
		const header = parseSessionListHeader(content, entries);
		if (!header) return undefined;
		if (typeof header.version === "number" && header.version >= 4 && header.version <= CURRENT_SESSION_VERSION) {
			for (const patch of await readSessionListTrailingPatches(file, storage)) {
				applySessionListHeaderPatch(header, patch);
			}
		}

		let parsedMessageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let shortSummary: string | undefined;

		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i] as { type?: string; message?: Message; shortSummary?: string };

			if (entry.type === "compaction" && typeof entry.shortSummary === "string") {
				shortSummary = entry.shortSummary;
			}

			if (entry.type === "message" && entry.message) {
				parsedMessageCount++;

				if (entry.message.role === "user" || entry.message.role === "assistant") {
					const textContent = extractTextFromContent(entry.message.content);

					if (textContent) {
						allMessages.push(textContent);

						if (!firstMessage && entry.message.role === "user") {
							firstMessage = textContent;
						}
					}
				}
			}
		}

		firstMessage ||= extractFirstUserMessageFromPrefix(content) ?? "";
		const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
		const stats = storage.statSync(file);
		return {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? shortSummary,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp ?? ""),
			modified: stats.mtime,
			messageCount,
			messageCountIsEstimate: stats.size > SESSION_LIST_PREFIX_BYTES,
			size: stats.size,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.length > 0 ? allMessages.join(" ") : firstMessage,
		};
	} catch {
		return undefined;
	}
}

async function collectSessionsFromFileStride(
	files: string[],
	storage: SessionStorage,
	startIndex: number,
	stride: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	const buffer = Buffer.allocUnsafe(SESSION_LIST_PREFIX_BYTES);

	for (let i = startIndex; i < files.length; i += stride) {
		const session = await collectSessionFromFile(files[i], storage, buffer);
		if (session) sessions.push(session);
	}

	return sessions;
}

async function collectSessionsFromFiles(files: string[], storage: SessionStorage): Promise<SessionInfo[]> {
	const workerCount = getSessionListWorkerCount(files.length);
	const sessions =
		workerCount === 1
			? await collectSessionsFromFileStride(files, storage, 0, 1)
			: (
					await Promise.all(
						Array.from({ length: workerCount }, (_, workerIndex) =>
							collectSessionsFromFileStride(files, storage, workerIndex, workerCount),
						),
					)
				).flat();

	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

export interface ResolvedSessionMatch {
	session: SessionInfo;
	scope: "local" | "global";
}

function sessionMatchesResumeArg(session: SessionInfo, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	const normalizedId = session.id.toLowerCase();
	if (normalizedId.startsWith(normalizedArg)) {
		return true;
	}

	const fileName = path.basename(session.path, ".jsonl").toLowerCase();
	if (fileName.startsWith(normalizedArg)) {
		return true;
	}

	const separator = fileName.lastIndexOf("_");
	if (separator < 0) {
		return false;
	}

	const fileSessionId = fileName.slice(separator + 1);
	return fileSessionId.startsWith(normalizedArg);
}

export async function resolveResumableSession(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	storage: SessionStorage = new FileSessionStorage(),
	managedAgentDir?: string,
): Promise<ResolvedSessionMatch | undefined> {
	const localSessions = sessionDir
		? await SessionManager.list(cwd, sessionDir, storage)
		: await SessionManager.listManagedForResumePickerReadOnly(cwd, managedAgentDir, storage);
	const localMatch = localSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (localMatch) {
		return { session: localMatch, scope: "local" };
	}

	if (sessionDir) {
		return undefined;
	}

	const globalSessions = await SessionManager.listAll(storage, managedAgentDir);
	const globalMatch = globalSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (!globalMatch) {
		return undefined;
	}

	return { session: globalMatch, scope: "global" };
}
interface SessionManagerStateSnapshot {
	sessionId: string;
	sessionName: string | undefined;
	titleSource: "auto" | "user" | undefined;
	sessionFile: string | undefined;
	managedPersistExpectedIdentity: ManagedFileIdentity | undefined;
	flushed: boolean;
	ensuredOnDisk: boolean;
	needsFullRewriteOnNextPersist: boolean;
	fileEntries: FileEntry[];
	materializedFileEntries: FileEntry[];
	adoptedArtifactManager: ArtifactManager | null;
	coldRestoreFile?: string;
}

/** Benchmark-derived cap for strong materialized session snapshots. */
export const MATERIALIZED_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Test-only cache retention and transition seams; these are intentionally not user settings. */
export const SessionManagerTestHooks: {
	materializedCacheMaxBytesOverride?: number;
	beforeResidentTransitionIndexBuild?: () => void;
	afterForkSnapshot?: () => void | Promise<void>;
	afterForkTranscriptPublished?: () => void | Promise<void>;
	beforeEphemeralArtifactManagerInstall?: (dir: string) => void | Promise<void>;
	beforePersistPatchFence?: (attempt: number) => void;
	beforeStrictMissingCheck?: (filePath: string, storage: SessionStorage) => void;
	beforeManagedResumeAcceptance?: (filePath: string, storage: SessionStorage) => void;
	beforeManagedResumeReturn?: (filePath: string, storage: SessionStorage) => void;
	beforeManagedSourceStat?: (filePath: string, storage: SessionStorage) => void | Promise<void>;
	beforeManagedMissingInit?: (filePath: string, storage: SessionStorage) => void | Promise<void>;
	beforeManagedMissingPublish?: (filePath: string, storage: SessionStorage) => void | Promise<void>;
	beforeManagedMissingReturn?: (filePath: string, storage: SessionStorage) => void | Promise<void>;
	afterManagedMissingAssertion?: (filePath: string, storage: SessionStorage) => void | Promise<void>;
	beforeManagedSwitchIdentity?: (filePath: string, storage: SessionStorage) => void | Promise<void>;
	/** Internal first-open GC strategy override; omitted means current. */
	firstOpenGcStrategy?: SessionMemoryGcStrategy;
	/** Internal first-open secondary-artifact mode override; omitted means auto. */
	secondaryArtifactMode?: SessionMemorySecondaryArtifactMode;
	/** Test-only transcript threshold override for automatic routing. */
	autoModeMinTranscriptBytesOverride?: number;
	/** Test-only eager hydration ceiling override. */
	eagerHydrationMaxBytesOverride?: number;
	/** Test-only rolling-tail buffer override for tail-overflow coverage. */
	sidecarTailBufferBytesOverride?: number;
	/** Test-only counter proving complete-index allocation was not used. */
	readAllColdEntryIndexesCalls?: number;
	/** Test-only exact-reopen exception diagnostic. */
	lastSidecarInitError?: string;
	/** Test-only generated-ID cache capacity override. */
	coldIdHashMaxEntriesOverride?: number;
	/** Test-only session-context budget override (in-process; does not leak to subprocesses). */
	sessionContextBudgetBytesOverride?: number;
} = {};

function materializedCacheMaxBytes(): number {
	const override = SessionManagerTestHooks.materializedCacheMaxBytesOverride;
	if (override === undefined) return MATERIALIZED_CACHE_MAX_BYTES;
	if (!Number.isSafeInteger(override) || override < 0)
		throw new RangeError("materializedCacheMaxBytesOverride must be a non-negative safe integer.");
	return override;
}

function autoModeMinTranscriptBytes(): number {
	const override = SessionManagerTestHooks.autoModeMinTranscriptBytesOverride;
	if (override === undefined) return EAGER_RESUME_TRANSCRIPT_MAX_BYTES + 1;
	if (!Number.isSafeInteger(override) || override < 1)
		throw new RangeError("autoModeMinTranscriptBytesOverride must be a positive safe integer.");
	return override;
}

function eagerHydrationMaxBytes(): number {
	const override = SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
	if (override === undefined) return EAGER_RESUME_TRANSCRIPT_MAX_BYTES;
	if (!Number.isSafeInteger(override) || override < 1)
		throw new RangeError("eagerHydrationMaxBytesOverride must be a positive safe integer.");
	return override;
}

function sidecarTailBufferBytes(): number {
	const override = SessionManagerTestHooks.sidecarTailBufferBytesOverride;
	if (override === undefined) return 4 * 1024 * 1024;
	if (!Number.isSafeInteger(override) || override < 1)
		throw new RangeError("sidecarTailBufferBytesOverride must be a positive safe integer.");
	return override;
}

function coldIdHashMaxEntries(): number {
	const override = SessionManagerTestHooks.coldIdHashMaxEntriesOverride;
	if (override === undefined) return 1_000_000;
	if (!Number.isSafeInteger(override) || override < 1 || override > COLD_ID_HASH_CAPACITY)
		throw new RangeError(`coldIdHashMaxEntriesOverride must be between 1 and ${COLD_ID_HASH_CAPACITY}.`);
	return override;
}
function effectiveSessionContextBudgetBytes(): number {
	const override = SessionManagerTestHooks.sessionContextBudgetBytesOverride;
	if (override === undefined) return SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES;
	if (!Number.isSafeInteger(override) || override < 1)
		throw new RangeError("sessionContextBudgetBytesOverride must be a positive safe integer.");
	return override;
}

function emptyFirstOpenTelemetry(
	strategy: SessionMemoryGcStrategy = "pressure",
	secondaryArtifactMode: SessionMemorySecondaryArtifactMode = "disabled",
): SessionMemoryFirstOpenTelemetry {
	const phases: Record<string, SessionMemoryPhaseTelemetry> = {};
	return {
		attempted: false,
		succeeded: false,
		strategy,
		secondaryArtifactMode,
		wallMs: 0,
		cpuMs: 0,
		gcRequests: 0,
		gcRequestCount: 0,
		gcElapsedMs: 0,
		bytesRead: 0,
		transcriptBytesRead: 0,
		bytesWritten: 0,
		sidecarBytesWritten: 0,
		sidecarFileBytes: 0,
		recordsParsed: 0,
		semanticRecordsParsed: 0,
		suffixRecordsParsed: 0,
		lineAssemblyCopyCount: 0,
		lineCopyCount: 0,
		lineAssemblyCopyBytes: 0,
		indexWriteCalls: 0,
		indexWriteBytes: 0,
		fsyncCount: 0,
		fsyncElapsedMs: 0,
		phaseTelemetry: phases,
		phaseEvidence: phases,
		phaseTimings: phases,
		dictionaryArtifactEnabled: false,
		parentArtifactEnabled: false,
		dictionaryBuildElapsedMs: 0,
		parentBuildElapsedMs: 0,
		flatIndexElapsedMs: 0,
	};
}

function firstOpenGcStrategy(): SessionMemoryGcStrategy {
	const candidate =
		SessionManagerTestHooks.firstOpenGcStrategy ?? process.env.GJC_SESSION_MEMORY_GC_STRATEGY?.trim().toLowerCase();
	return candidate === "none" || candidate === "async" || candidate === "pressure" || candidate === "current"
		? candidate
		: "pressure";
}

function firstOpenSecondaryArtifactMode(): SessionMemorySecondaryArtifactMode {
	const candidate =
		SessionManagerTestHooks.secondaryArtifactMode ??
		process.env.GJC_SESSION_MEMORY_SECONDARY_ARTIFACT_MODE?.trim().toLowerCase();
	return candidate === "enabled" || candidate === "disabled" || candidate === "auto" ? candidate : "disabled";
}

function residentProcessBytes(): number {
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external + usage.arrayBuffers;
}

function recordFirstOpenPhase(
	telemetry: SessionMemoryFirstOpenTelemetry,
	name: string,
	startedAt: { wall: bigint; cpu: NodeJS.CpuUsage },
): void {
	const wallMs = Number(process.hrtime.bigint() - startedAt.wall) / 1_000_000;
	const cpu = process.cpuUsage(startedAt.cpu);
	const cpuMs = (cpu.user + cpu.system) / 1_000;
	const existing = telemetry.phaseTelemetry[name];
	telemetry.phaseTelemetry[name] = {
		wallMs: (existing?.wallMs ?? 0) + wallMs,
		cpuMs: (existing?.cpuMs ?? 0) + cpuMs,
	};
}

function startFirstOpenPhase(): { wall: bigint; cpu: NodeJS.CpuUsage } {
	return { wall: process.hrtime.bigint(), cpu: process.cpuUsage() };
}

function recordFirstOpenGcRequest(telemetry: SessionMemoryFirstOpenTelemetry, force = false): boolean {
	if (telemetry.strategy === "none") return false;
	if (telemetry.strategy === "pressure" && !force) {
		const current = residentProcessBytes();
		const baseline = telemetry.pressureBaselineBytes ?? current;
		if (current - baseline < 4 * 1024 * 1024) return false;
		telemetry.pressureBaselineBytes = current;
	}
	const started = process.hrtime.bigint();
	if (telemetry.strategy === "async") Bun.gc(false);
	else Bun.gc(true);
	telemetry.gcRequests += 1;
	telemetry.gcRequestCount = telemetry.gcRequests;
	telemetry.gcElapsedMs += Number(process.hrtime.bigint() - started) / 1_000_000;
	telemetry.pressureBaselineBytes = residentProcessBytes();
	return true;
}

function recordFirstOpenLineCopy(telemetry: SessionMemoryFirstOpenTelemetry | undefined, bytes: number): void {
	if (!telemetry || bytes <= 0) return;
	telemetry.lineAssemblyCopyCount += 1;
	telemetry.lineCopyCount = telemetry.lineAssemblyCopyCount;
	telemetry.lineAssemblyCopyBytes += bytes;
}

function asBufferedSidecarWriter(writer: SessionStorageWriter): SessionStorageBufferedWriter | undefined {
	return typeof (writer as Partial<SessionStorageBufferedWriter>).writeBytesSync === "function"
		? (writer as SessionStorageBufferedWriter)
		: undefined;
}

function openFirstOpenSidecarWriter(storage: SessionStorage, filePath: string): SessionStorageWriter {
	return storage.openBufferedWriter?.(filePath, { flags: "w" }) ?? storage.openWriter(filePath, { flags: "w" });
}

function writeFirstOpenSidecarBytes(
	writer: SessionStorageWriter,
	bytes: Buffer,
	telemetry: SessionMemoryFirstOpenTelemetry,
	kind: "index" | "tail",
): void {
	const buffered = asBufferedSidecarWriter(writer);
	if (buffered) buffered.writeBytesSync(bytes);
	else writer.writeLineSync(bytes.toString("utf8"));
	telemetry.bytesWritten += bytes.byteLength;
	telemetry.sidecarBytesWritten += bytes.byteLength;
	if (kind === "index") {
		telemetry.indexWriteBytes += bytes.byteLength;
		if (!buffered) telemetry.indexWriteCalls += 1;
	}
}

function fsyncFirstOpenSidecarWriter(writer: SessionStorageWriter, telemetry: SessionMemoryFirstOpenTelemetry): void {
	if (!writer.fsyncSync) throw new Error("Synchronous sidecar fsync is unavailable");
	const started = startFirstOpenPhase();
	writer.fsyncSync();
	telemetry.fsyncCount += 1;
	telemetry.fsyncElapsedMs += Number(process.hrtime.bigint() - started.wall) / 1_000_000;
	recordFirstOpenPhase(telemetry, "fsync", started);
}

type ManagedDestinationTransition = {
	readonly directory: string;
	readonly destination: SessionDestination;
	readonly store: ManagedSessionDescendantStore;
	adopt(): void;
	/** Release the superseded authority once rollback is no longer possible. */
	settle(): void;
	rollback(): void;
	dispose(): void;
};
/**
 * Freshness snapshot captured with every async whole-session persistence
 * preparation. Immediately before the synchronous persistence transaction, the
 * live values are compared: a `sessionFile`/`lifecycleId` change aborts (lifecycle
 * switch); a revision change discards the prepared bytes and re-prepares (bounded),
 * so a stale snapshot is never published.
 */
export interface PersistenceInputToken {
	/** Canonical session file path the prepared bytes target. */
	sessionFile: string;
	/** Per-manager lifecycle identity (`sessionId@sessionFile`); changes on switch/open/reset. */
	lifecycleId: string;
	/** Revision of #fileEntries affecting persisted bytes. */
	entryRevision: number;
	/** Header/version revision affecting persisted bytes. */
	headerRevision: number;
	/** Resident/blob store revision affecting persisted bytes. */
	residentBlobRevision: number;
}

type EvictedToolOutputHandle = import("../tools/output-meta").EvictedToolOutputHandle;

class EvictedArtifactValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EvictedArtifactValidationError";
		this.code = code;
	}
}

function validateEvictedToolOutputHandle(
	value: unknown,
): { ok: true; handle: EvictedToolOutputHandle } | { ok: false; diagnostic: string; code: string } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { ok: false, code: "invalid_shape", diagnostic: "eviction handle must be an object" };
	const handle = value as Record<string, unknown>;
	if (handle.v !== 1) {
		return {
			ok: false,
			code: "unsupported_version",
			diagnostic: `unsupported eviction handle version ${String(handle.v)}; only v1 is readable`,
		};
	}
	if (handle.complete !== true)
		return { ok: false, code: "incomplete", diagnostic: "eviction artifact is not complete" };
	if (
		typeof handle.artifactId !== "string" ||
		!/^[0-9]+$/.test(handle.artifactId) ||
		typeof handle.uri !== "string" ||
		handle.uri !== `artifact://${handle.artifactId}` ||
		handle.encoding !== "utf-8" ||
		!Number.isSafeInteger(handle.bytes) ||
		(handle.bytes as number) < 0 ||
		typeof handle.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(handle.sha256)
	) {
		return { ok: false, code: "invalid_shape", diagnostic: "eviction handle shape is invalid" };
	}
	return { ok: true, handle: value as EvictedToolOutputHandle };
}
export class SessionManager {
	#sessionId: string = "";
	/** True once a lifecycle pre-allocated id has been adopted (consume-once). */
	#lifecycleIdAdopted: boolean = false;
	#preparedNewSessions = new Set<PreparedNewSessionState>();
	#sessionName: string | undefined;
	#titleSource: "auto" | "user" | undefined;
	#sessionFile: string | undefined;
	#flushed: boolean = false;
	#needsFullRewriteOnNextPersist: boolean = false;
	#readOnlyResume = false;
	#resumedDraftConsumed = false;
	#ensuredOnDisk: boolean = false;
	#recoveryHydrationContext: RecoveryHydrationContext | undefined;
	#recoveryPromotionTranscriptPath: string | undefined;
	#memoryGuardParticipantIngressToken: symbol | undefined;
	#fileEntries: FileEntry[] = [];
	#pendingStrictAdoption:
		| { canonicalPath: string; identity: ResumeSessionIdentity; inspection?: ResumeInspectionSnapshot }
		| undefined;
	#byId: Map<string, SessionEntry> = new Map();
	#labelsById: Map<string, string> = new Map();
	#leafId: string | null = null;
	#usageStatistics = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		premiumRequests: 0,
		cost: 0,
	} satisfies UsageStatistics;
	#persistWriter: NdjsonFileWriter | undefined;
	#persistWriterPath: string | undefined;
	#persistChain: Promise<void> = Promise.resolve();
	#persistError: Error | undefined;
	#persistErrorReported = false;
	/** Defense-in-depth (#4443): one-shot warn for adjacent private thinking blocks in persisted assistant transcripts. */
	#warnedAdjacentThinkingPersist = false;
	#closeRetryPending = false;
	/** Serializes model, SDK, and ACP cwd transitions; dispose joins this tail. */
	#cwdTransitionTail: Promise<void> = Promise.resolve();
	#cwdTransitionOwner: symbol | undefined;
	#cwdReadLeaseOwner = Symbol("cwd-read-lease-owner");
	#cwdGeneration = 0;
	/** Number of tool executions currently holding a shared read lease on `cwd`. */
	#cwdReaderCount = 0;
	/** Resolved when the last outstanding read lease is released. */
	#cwdReadersDrained: (() => void) | undefined;
	#cwdReadersIdle: Promise<void> = Promise.resolve();
	/** Set while a writer is queued or running so new readers do not starve it. */
	#cwdWriterPending = 0;
	/** Depth of the non-yielding same-session persistence fence (reentrancy counter). */
	#persistenceFenceDepth = 0;
	/** Publication fence counter carried by the mutable `.spill.commit` marker. */
	#commitGen = 0;
	/** Failed staged persistence retains its exact writer and temporary pathname for retryable cleanup. */
	/** Candidate-owned session publication state; set only by staged factories. */
	#stagedPublication:
		| {
				finalSessionFile: string;
				stagedSessionFile: string;
				finalDestination: SessionDestination;
				managedParentStore?: ManagedSessionDescendantStore;
				/** Subtree store bound to the staging directory; basename reads stay authority-safe. */
				managedStagingStore?: ManagedSessionDescendantStore;
				attemptId: string;
				committed: boolean;
				discarded: boolean;
				publishedFinalSnapshot?: ManagedFileSnapshot;
				publishedFinalBytes?: Buffer;
				deferArtifactFinalize?: boolean;
				/**
				 * A publish that native code could neither prove nor disprove. The transcript may
				 * already be visible at the destination, so no later cleanup may reclaim the
				 * staging or artifacts it references.
				 */
				preservedUnproven?: boolean;
		  }
		| undefined;
	#stagedArtifactParent: ArtifactManager | null = null;
	#stagedCommitArtifactParent: ArtifactManager | null = null;
	#preparedNewSessionCleanupInProgress = false;
	/** Active cold-sidecar runtime (retirement + lazy resolution). Undefined when disabled. */
	#sidecarRuntime: SessionMemorySidecarRuntime | undefined = undefined;
	#consecutiveSidecarBuildFailures = 0;
	#firstOpenTelemetry: SessionMemoryFirstOpenTelemetry = emptyFirstOpenTelemetry();
	#sessionMemoryAutoDisabledReason: string | undefined;
	#sessionMemoryMode: SessionMemoryMode = "shadow";
	#lazyReopenAttempted = false;
	#lazyReopenSucceeded = false;
	#lazyReopenFallbackReason: string | undefined;
	#boundedFirstOpenBuildSuppressed = false;
	#retirementFallbackReason: string | undefined;
	#sidecarBranchActivationDirty = false;
	/** Hot-suffix maintenance budget: 16 MiB steady-state (provider-invisible overrides allowed). */
	#sidecarHotSuffixBudgetBytes = 16 * 1024 * 1024;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#managedTranscriptStoreCache: { directory: string; store: ManagedSessionDescendantStore } | null = null;
	#ownedManagedAuthority: ManagedSessionDescendantStore | undefined;
	#managedSidecarCacheStore: EphemeralBlobStore | undefined;
	readonly #managedSidecarCleanupStores = new Set<EphemeralBlobStore>();
	#managedSidecarAuthorityStore: ManagedSessionDescendantStore | undefined;
	#managedSidecarSecurityContext: ManagedSessionSecurityContext | undefined;
	#managedSidecarCacheSessionFile: string | undefined;
	#managedRangeExpectedDescriptor: DescriptorSnapshot | undefined;
	#managedPersistExpectedIdentity: ManagedFileIdentity | undefined;
	#boundedReadStorageProxy: SessionStorage | undefined;
	#boundedManagedSource:
		| { path: string; store: ManagedSessionDescendantStore; descriptor: DescriptorSnapshot; owned: boolean }
		| undefined;
	// When set, take precedence over the lazily-derived per-session manager.
	// Subagents adopt the parent's manager so artifact IDs are unique across the
	// whole agent tree and all files land in the parent's artifacts dir.
	#adoptedArtifactManager: ArtifactManager | null = null;
	// Filesystem-backed artifact fallback for non-persistent sessions (persist=false).
	// The directory is created lazily on first save so artifact content is read back
	// from disk on demand instead of being retained in memory for the session lifetime.
	#ephemeralArtifactManager: ArtifactManager | null = null;
	#ephemeralArtifactDir: string | null = null;
	#ephemeralArtifactInit: Promise<ArtifactManager | null> | null = null;
	#ephemeralArtifactCleanups = new Set<Promise<void>>();
	readonly #blobStore: BlobStore;
	#residentTextBlobStore: BlobStore = new MemoryBlobStore();
	#residentImageBlobStore: BlobStore;
	#memoryGuardCheckpointBlobs: Map<string, Buffer> | undefined;
	#entryRevision = 0;
	#leafRevision = 0;
	/** Export/header cache invalidation contract; consumers may arrive after the revision field. */
	#headerExportRevision = 0;
	/** Label-view cache invalidation contract; consumers may arrive after the revision field. */
	#labelRevision = 0;
	#replayMetadataRevision = 0;
	/** Resident/blob store revision affecting persisted bytes; bumped when the store identity changes. */
	#residentBlobRevision = 0;
	#materializedEntriesRevision = -1;
	#materializedEntriesCache: MaterializedCacheReference<SessionEntry[]> | undefined;
	#sessionContextCache: MaterializedCacheReference<SessionContext> | undefined;
	#sessionContextCacheOversized = false;
	#materializedCachesWeaklyHeld = false;
	#sessionContextEntryRevision = -1;
	#sessionContextLeafRevision = -1;
	#sessionContextReplayMetadataRevision = -1;
	#coldSpillWriteCount = 0;
	#coldSpillReadCount = 0;
	#residentTextReadCount = 0;
	#residentImageReadCount = 0;
	#residentCacheAdoptFallbackCount = 0;
	#residentCacheTrustRejectCount = 0;
	#residentBlobPlaceholderCount = 0;
	#residentCacheWin32FallbackCount = 0;
	#publicMaterializerCallCount = 0;
	#getEntryMaterializerCallCount = 0;
	#getBranchMaterializerCallCount = 0;
	#getEntriesMaterializerCallCount = 0;
	#materializedEntriesCachePopulateCount = 0;
	#materializedCacheDemotedCount = 0;
	#pathOnlyContextBuildCount = 0;
	#internalReadAccess: SessionManagerReadAccess = {
		getEntries: () => freezeInternalReadSnapshot(this.#getMaterializedEntriesInternal()),
		getSessionContext: () => this.#getSessionContextForRead(),
		getTree: () => this.#getTree(freezeInternalReadSnapshot(this.#getMaterializedEntriesInternal())),
	};

	readonly #storage: SessionStorage;
	readonly #managedSidecarFileStorage = new FileSessionStorage();
	private constructor(
		private cwd: string,
		private sessionDir: string,
		private readonly persist: boolean,
		storage: SessionStorage,
		private destination: SessionDestination = explicitDestination(sessionDir),
		skipEnsureSessionDir = false,
	) {
		this.#storage = new Proxy(storage, {
			get: (target, property, receiver) => {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const first = args[0];
					if (typeof first !== "string" || !this.#isManagedSidecarPath(first))
						return Reflect.apply(value, target, args);
					const authority = this.#managedSidecarAuthorityStore;
					if (!authority) throw new Error("Managed sidecar authority is unavailable");
					authority.assertBound();
					const relative = path.relative(authority.dir, first);
					switch (property) {
						case "existsSync":
							return authority.descriptorExpected(relative) !== null;
						case "exists":
							return Promise.resolve(authority.descriptorExpected(relative) !== null);
						case "statSync": {
							const descriptor = authority.descriptorExpected(relative);
							if (!descriptor) throw Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" });
							return descriptor;
						}
						case "readSnapshotSync": {
							const snapshot = authority.readExpected(relative);
							if (!snapshot) throw Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" });
							return { bytes: snapshot.bytes, stat: authority.descriptorExpected(relative)! };
						}
						case "readBytesSync": {
							const snapshot = authority.readExpected(relative);
							if (!snapshot) throw Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" });
							return snapshot.bytes;
						}
						case "readTextSync": {
							const snapshot = authority.readExpected(relative);
							if (!snapshot) throw Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" });
							return snapshot.bytes.toString("utf8");
						}
						case "readText": {
							const snapshot = authority.readExpected(relative);
							if (!snapshot)
								return Promise.reject(
									Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" }),
								);
							return Promise.resolve(snapshot.bytes.toString("utf8"));
						}
						case "readRangeSync":
							return authority.readRangeExpectedSync(relative, args[1] as number, args[2] as number);
						case "readRange":
							return Promise.resolve(
								authority.readRangeExpectedSync(relative, args[1] as number, args[2] as number),
							);
						case "writeTextSync": {
							const bytes = Buffer.from(args[1] as string, "utf8");
							if (authority.descriptorExpected(relative)) authority.replaceSync(relative, bytes);
							else authority.publishNoReplaceSync(relative, bytes);
							return;
						}
						case "writeText": {
							const bytes = Buffer.from(args[1] as string, "utf8");
							return authority.descriptorExpected(relative)
								? authority.replace(relative, bytes)
								: authority.publishNoReplace(relative, bytes);
						}
						case "unlinkSync":
							if (!authority.removeIfExistsDescriptor(relative))
								throw Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" });
							return;
						case "unlink":
							return authority.removeIfExistsDescriptor(relative)
								? Promise.resolve()
								: Promise.reject(Object.assign(new Error("Managed sidecar not found"), { code: "ENOENT" }));
						case "acquireExclusiveLockSync":
							args[1] = {
								...(args[1] as { securityContext?: SessionStorageSecurityContext } | undefined),
								securityContext: this.#managedSidecarSecurityContext,
							};
							break;
						case "openWriter":
						case "openBufferedWriter":
						case "openStagedWriter":
							args[1] = {
								...(args[1] as SessionStorageWriterOpenOptions | undefined),
								securityContext: this.#managedSidecarSecurityContext,
							};
							break;
					}
					const operation = Reflect.get(
						this.#managedSidecarFileStorage,
						property,
						this.#managedSidecarFileStorage,
					);
					if (typeof operation !== "function") return operation;
					const result = Reflect.apply(operation, this.#managedSidecarFileStorage, args);
					authority.assertBound();
					return result;
				};
			},
		});
		this.#blobStore = persist ? new BlobStore(getBlobsDir()) : this.#residentTextBlobStore;
		this.#residentImageBlobStore = this.#blobStore;
		if (persist && sessionDir) {
			if (!skipEnsureSessionDir) this.#storage.ensureDirSync(sessionDir);
			// Canonicalize the trusted session directory (single choke point for every
			// creation path: create/open/moveTo/fork/SDK) so benign ancestor symlinks
			// (e.g. macOS `/var -> /private/var`, a symlinked `$HOME`) are resolved to a
			// symlink-free root before the strict owner-only and reparse guards run.
			if (this.#storage instanceof FileSessionStorage) {
				this.sessionDir = canonicalizeTrustedPath(sessionDir);
			}
		}
		// Note: call _initSession() or _initSessionFile() after construction
	}

	#residentBlobStores(): ResidentBlobStores {
		return {
			textStore: this.#residentTextBlobStore,
			imageStore: this.#residentImageBlobStore,
			sessionId: this.#sessionId || undefined,
			sessionFile: this.#sessionFile,
		};
	}

	/**
	 * Build a one-shot fallback from the materialized transcript. Resident sentinels
	 * are expanded before persistence, so a persisted value is accepted only when its
	 * hash matches a currently referenced resident text blob.
	 */
	#createPersistedResidentTextFallback(): ((hash: string) => Buffer | null) | undefined {
		if (!this.#sessionFile || !(this.#storage instanceof FileSessionStorage)) return undefined;
		const requested = new Set<string>();
		for (const entry of this.#fileEntries) collectResidentTextBlobHashes(entry, requested);
		if (requested.size === 0) return undefined;

		let recovered: Map<string, Buffer> | undefined;
		return hash => {
			if (!requested.has(hash)) return null;
			if (!recovered) {
				recovered = new Map<string, Buffer>();
				try {
					const bytes =
						this.destination.kind === "managed"
							? this.#managedTranscriptStore().readExpected(path.basename(this.#sessionFile!))?.bytes
							: captureManagedFileNoFollow(this.#sessionFile!).bytes;
					if (!bytes) return null;
					const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					for (const entry of parseSessionEntries(content)) {
						recoverPersistedResidentTextBuffers(entry, requested, recovered);
					}
				} catch {
					// The normal source lookup reports a missing resident blob if the canonical
					// transcript cannot be captured safely or does not contain the full value.
				}
			}
			return recovered.get(hash) ?? null;
		};
	}

	#residentBlobStoresForColdRehydrate(): ResidentBlobStores {
		return {
			...this.#residentBlobStores(),
			onResidentBlobRead: kind => {
				if (kind === "text") {
					this.#residentTextReadCount++;
				} else {
					this.#residentImageReadCount++;
				}
			},
		};
	}
	#coldSpillReadStore(): BlobStore {
		return this.#memoryGuardCheckpointBlobs ? this.#residentImageBlobStore : this.#blobStore;
	}

	#residentCacheProfileAgentDir(): string {
		return this.destination.kind === "managed"
			? this.destination.securityContext.profileAgentDir
			: (explicitProfileAgentDirs.get(this.destination) ?? getAgentDir());
	}

	#newCanonicalResidentTextStore(): MemoryBlobStore {
		return new MemoryBlobStore({ ownership: "canonical" });
	}

	#newResidentTextStoreCandidate(target: ResidentTransitionInput["target"]): { store: BlobStore; ownsStore: boolean } {
		if (!this.persist || !target.sessionFile || !(this.#storage instanceof FileSessionStorage)) {
			return { store: this.#newCanonicalResidentTextStore(), ownsStore: false };
		}
		if (process.platform === "win32") {
			this.#residentCacheWin32FallbackCount++;
			return { store: this.#newCanonicalResidentTextStore(), ownsStore: false };
		}
		const instanceDir = openVerifiedResidentCacheInstanceDir(
			getResidentCacheRootDir(this.#residentCacheProfileAgentDir()),
		);
		return { store: EphemeralBlobStore.adoptVerifiedDir(instanceDir), ownsStore: true };
	}

	#preparedResidentTransitionFromSource(
		source: ResidentTransitionSource,
		target: ResidentTransitionInput["target"],
		store: BlobStore,
		ownsStore: boolean,
	): PreparedResidentStoreTransition {
		if (source.mode === "adopt-staged") {
			assertResidentReferencesResolvableSync(source.stagedEntries, {
				textStore: source.stagedStore,
				imageStore: this.#residentImageBlobStore,
				sessionId: target.sessionId,
				sessionFile: target.sessionFile || undefined,
			});
			return new PreparedResidentStoreTransition(
				source.stagedEntries,
				source.stagedStore,
				source.stagedIndex ?? this.#buildIndexForEntries(source.stagedEntries, target.sessionFile),
				false,
			);
		}
		const sourceTextStore = source.sourceStores.textStore ?? new MemoryBlobStore();
		const materializedEntries = materializeResidentEntriesSync(
			source.sourceEntries,
			{
				textStore: sourceTextStore,
				imageStore: source.sourceStores.imageStore,
				textFallback: source.sourceStores.textFallback,
				sessionId: target.sessionId,
				sessionFile: target.sessionFile || undefined,
				onResidentBlobMissing: source.sourceStores.onResidentBlobMissing,
			},

			source.missingPolicy,
		);
		const entries = materializedEntries.map(entry =>
			prepareEntryForResidentSync(entry, {
				textStore: store,
				imageStore: source.sourceStores.imageStore,
				sessionId: target.sessionId,
				sessionFile: target.sessionFile || undefined,
			}),
		);
		SessionManagerTestHooks.beforeResidentTransitionIndexBuild?.();
		return new PreparedResidentStoreTransition(
			entries,
			store,
			this.#buildIndexForEntries(entries, target.sessionFile || undefined),
			ownsStore,
		);
	}

	#prepareResidentTextStoreTransition(
		input: ResidentTransitionInput,
		policy: ResidentTransitionFailurePolicy,
	): PreparedResidentStoreTransition {
		if (policy === "install-staged" && !input.fallback)
			throw new Error("install-staged resident transition requires a staged fallback.");
		if (input.primary.mode === "adopt-staged") {
			return this.#preparedResidentTransitionFromSource(
				input.primary,
				input.target,
				input.primary.stagedStore,
				false,
			);
		}
		if (policy === "memory-only") {
			return this.#preparedResidentTransitionFromSource(
				input.primary,
				input.target,
				this.#newCanonicalResidentTextStore(),
				false,
			);
		}
		let candidate: { store: BlobStore; ownsStore: boolean } | undefined;
		try {
			candidate = this.#newResidentTextStoreCandidate(input.target);
			return this.#preparedResidentTransitionFromSource(
				input.primary,
				input.target,
				candidate.store,
				candidate.ownsStore,
			);
		} catch (error) {
			if (candidate?.ownsStore && candidate.store instanceof EphemeralBlobStore) {
				try {
					candidate.store.dispose();
				} catch (disposeError) {
					logger.warn("Failed to dispose a rejected resident cache candidate", {
						error: toError(disposeError).message,
					});
				}
			}
			if (error instanceof ResidentCacheTrustError) this.#residentCacheTrustRejectCount++;
			if (input.allowUnwritableResidentCacheFallback && isUnwritableResidentCacheFailure(error)) {
				this.#residentCacheAdoptFallbackCount++;
				return this.#preparedResidentTransitionFromSource(
					input.primary,
					input.target,
					this.#newCanonicalResidentTextStore(),
					false,
				);
			}
			if (policy === "retain-and-throw" || !isResidentCacheProvisioningFailure(error)) throw error;
			if (policy === "install-staged") {
				const fallback = input.fallback;
				if (!fallback) throw new Error("install-staged resident transition requires a staged fallback.");
				this.#residentCacheAdoptFallbackCount++;
				return this.#preparedResidentTransitionFromSource(fallback, input.target, fallback.stagedStore, false);
			}
			if (policy === "memory-fallback") {
				this.#residentCacheAdoptFallbackCount++;
				return this.#preparedResidentTransitionFromSource(
					input.primary,
					input.target,
					this.#newCanonicalResidentTextStore(),
					false,
				);
			}
			throw error;
		}
	}

	#preparePreparedNewSessionForCommit(stage: PreparedNewSessionState): void {
		const residentTextBlobStore = this.#newCanonicalResidentTextStore();
		const residentFileEntries = stage.fileEntries.map(entry =>
			prepareEntryForResidentSync(entry, {
				textStore: residentTextBlobStore,
				imageStore: this.#residentImageBlobStore,
				sessionId: stage.sessionId,
				sessionFile: stage.sessionFile,
			}),
		);
		stage.residentTextBlobStore = residentTextBlobStore;
		stage.residentFileEntries = residentFileEntries;
		stage.index = this.#buildIndexForEntries(residentFileEntries, stage.sessionFile);
	}

	#resetMaterializedCaches(): void {
		this.#materializedEntriesRevision = -1;
		this.#materializedEntriesCache = undefined;
		this.#materializedCachesWeaklyHeld = false;
		this.#sessionContextCache = undefined;
		this.#sessionContextCacheOversized = false;
		this.#sessionContextEntryRevision = -1;
		this.#sessionContextLeafRevision = -1;
		this.#sessionContextReplayMetadataRevision = -1;
	}

	#holdMaterializedCachesWeakly(): void {
		if (this.#materializedCachesWeaklyHeld) return;
		this.#materializedCachesWeaklyHeld = true;
		this.#materializedCacheDemotedCount++;
		const entries = dereferenceMaterializedCache(this.#materializedEntriesCache);
		if (entries) this.#materializedEntriesCache = new WeakRef(entries);
		const context = dereferenceMaterializedCache(this.#sessionContextCache);
		if (context) this.#sessionContextCache = new WeakRef(context);
	}

	#bumpEntryRevision(): void {
		this.#entryRevision++;
		this.#resetMaterializedCaches();
	}

	#bumpAllRevisions(): void {
		this.#entryRevision++;
		this.#leafRevision++;
		this.#headerExportRevision++;
		this.#labelRevision++;
		this.#replayMetadataRevision++;
		this.#resetMaterializedCaches();
	}

	/**
	 * Snapshot of the five cache-invalidation revision domains (plan: Lane 1
	 * revision contract). Tests assert the invalidation mapping through this;
	 * future export/label-view caches key off their respective domains.
	 */
	revisionSnapshot(): SessionManagerRevisionSnapshot {
		return {
			entry: this.#entryRevision,
			leaf: this.#leafRevision,
			headerExport: this.#headerExportRevision,
			label: this.#labelRevision,
			replayMetadata: this.#replayMetadataRevision,
		};
	}

	#disposeResidentTextStore(store: BlobStore): void {
		if (!(store instanceof EphemeralBlobStore)) return;
		try {
			store.dispose();
		} catch (error) {
			logger.warn("Failed to dispose a replaced resident cache store", {
				error: toError(error).message,
			});
		}
	}

	async #cleanupForkTranscriptPublication(publication: ForkTranscriptPublication): Promise<void> {
		if (publication.kind === "managed") {
			const snapshot = publication.store.readExpected(publication.relativePath);
			if (!snapshot) return;
			if (snapshot.identity.sha256 !== publication.publishedSha256) throw new Error("fork_transcript_changed");
			publication.store.removeExpected(publication.relativePath, snapshot);
			return;
		}
		if (publication.kind === "explicit-storage") {
			if (!this.#storage.existsSync(publication.sessionFile)) return;
			verifyForkTranscriptPublishedBounded(this.#storage, publication.sessionFile, publication.publishedSha256);
			await this.#storage.unlink(publication.sessionFile);
			return;
		}
		if (!this.#storage.existsSync(publication.sessionFile)) return;
		verifyForkTranscriptPublishedBounded(this.#storage, publication.sessionFile, publication.publishedSha256);
		const named = fs.lstatSync(publication.sessionFile, { bigint: true });
		const removed = nativeSessionManager().exactUnlink(publication.sessionFile, {
			dev: named.dev,
			ino: named.ino,
			size: BigInt(named.size),
			mtimeNs: named.mtimeNs,
			sha256: publication.publishedSha256,
			quarantineName: `.gjc-fork-${process.pid}-${crypto.randomUUID()}`,
		});
		if (
			!removed.ok &&
			!(
				removed.code === "cleanup_pending" &&
				(removed.detachedPath ??
					removed.retainedSuccessorPath ??
					removed.retainedPlaceholderPath ??
					removed.retainedUnknownPath) !== undefined
			)
		) {
			throw new Error(removed.code ?? "fork_transcript_cleanup_failed");
		}
	}

	#cleanupForkArtifactPublication(publication: ForkArtifactPublication): void {
		if (publication.kind === "managed") {
			publication.cleanupStore.removeTreeExpected(publication.cleanupRelativePath, publication.snapshot);
			return;
		}
		const removed = nativeSessionManager().exactRemoveDirectoryTree(publication.artifactsDir, publication.snapshot);
		if (
			!removed.ok &&
			!(
				removed.code === "cleanup_pending" &&
				(removed.detachedPath ??
					removed.retainedSuccessorPath ??
					removed.retainedPlaceholderPath ??
					removed.retainedUnknownPath) !== undefined
			)
		) {
			throw new Error(removed.code ?? "fork_artifact_cleanup_failed");
		}
	}

	#commitResidentTextStoreTransition(prepared: PreparedResidentStoreTransition, rebuildSidecars = true): void {
		const predecessor = this.#residentTextBlobStore;
		const successor = prepared.store;
		this.#fileEntries = prepared.entries;
		this.#residentTextBlobStore = successor;
		this.#byId = prepared.index.byId;
		this.#labelsById = prepared.index.labelsById;
		this.#leafId = prepared.index.leafId;
		this.#usageStatistics = prepared.index.usageStatistics;
		this.#bumpAllRevisions();
		this.#residentBlobRevision++;
		prepared.adopt();
		if (rebuildSidecars && this.persist && this.#sessionFile) {
			this.#buildDisposableSidecars(this.#fileEntries);
			if (this.#effectiveSessionMemoryMode() === "enabled") this.#retireColdEntries();
		}
		if (predecessor !== successor) this.#disposeResidentTextStore(predecessor);
		prepared.releaseReferences();
	}

	#releaseResidentTextStore(): void {
		const predecessor = this.#residentTextBlobStore;
		this.#residentTextBlobStore = new MemoryBlobStore();
		this.#resetMaterializedCaches();
		this.#disposeResidentTextStore(predecessor);
		this.#residentBlobRevision++;
	}

	#demoteResidentTextStoreAfterTrustReject(error: ResidentCacheTrustError): void {
		const predecessor = this.#residentTextBlobStore;
		(predecessor as ResidentCacheDegradedStore).degradedReason = error.reason;
		(predecessor as ResidentCacheDegradedStore).degradedCauseCode = error.causeCode;
		this.#residentCacheTrustRejectCount++;
		logger.warn("Resident cache trust rejection; demoting resident text store", {
			sessionId: this.#sessionId,
			sessionFile: this.#sessionFile,
			reason: error.reason,
			causeCode: error.causeCode,
			cause: error.causeSummary,
		});
		const persistedTextFallback =
			predecessor instanceof EphemeralBlobStore ? this.#createPersistedResidentTextFallback() : undefined;
		const prepared = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: this.#sessionId || "pending", sessionFile: this.#sessionFile ?? "" },
				primary: {
					mode: "materialize",
					sourceEntries: this.#fileEntries,
					sourceStores: {
						textStore: predecessor,
						imageStore: this.#residentImageBlobStore,
						// Read buffered bytes before EphemeralBlobStore revalidates a root that may have been swapped.
						// Persisted JSONL is a canonical fallback for resident entries evicted from the LRU.
						textFallback:
							predecessor instanceof EphemeralBlobStore
								? hash => predecessor.getBufferedSync(hash) ?? persistedTextFallback?.(hash) ?? null
								: undefined,
						onResidentBlobMissing: (kind, hash) => {
							this.#residentBlobPlaceholderCount++;
							logger.warn("Resident blob unrecoverable; substituted a placeholder", {
								sessionId: this.#sessionId,
								kind,
								hash,
								reason: error.reason,
								causeCode: error.causeCode,
							});
						},
					},
					// This transition IS the salvage after the cache already failed, so it runs
					// against a store that is by definition missing blobs. Inheriting the default
					// fail-closed policy makes the recovery throw on the very entry it exists to
					// rescue, which leaves the demotion uncommitted and repeats it every turn.
					// The placeholder never emits a `blob:sha256:` ref, so the fail-closed
					// invariant that policy protects is preserved.
					missingPolicy: "placeholder",
				},
			},
			"memory-only",
		);
		(prepared.store as ResidentCacheDegradedStore).degradedReason = error.reason;
		(prepared.store as ResidentCacheDegradedStore).degradedCauseCode = error.causeCode;
		this.#commitResidentTextStoreTransition(prepared);
	}

	#retryResidentPutAfterTrustReject<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			if (!(error instanceof ResidentCacheTrustError)) throw error;
			this.#demoteResidentTextStoreAfterTrustReject(error);
			return operation();
		}
	}

	#prepareEntryForCurrentResidentStore(entry: FileEntry): FileEntry {
		return this.#retryResidentPutAfterTrustReject(() =>
			prepareEntryForResidentSync(entry, this.#residentBlobStores()),
		);
	}

	#putResidentTextBlobSync(data: Buffer): BlobPutResult {
		return this.#retryResidentPutAfterTrustReject(() => this.#residentTextBlobStore.putSync(data));
	}

	/** Puts a binary blob into the blob store and returns the blob reference */
	async putBlob(data: Buffer): Promise<BlobPutResult> {
		return this.#blobStore.put(data);
	}

	/** Capture rollback authority without materializing an active cold transcript. @internal */
	async captureRollbackState(): Promise<SessionManagerStateSnapshot> {
		if (this.#coldSidecarActive() && this.#sessionFile) {
			return {
				sessionId: this.#sessionId,
				sessionName: this.#sessionName,
				titleSource: this.#titleSource,
				sessionFile: this.#sessionFile,
				flushed: this.#flushed,
				ensuredOnDisk: this.#ensuredOnDisk,
				needsFullRewriteOnNextPersist: this.#needsFullRewriteOnNextPersist,
				managedPersistExpectedIdentity: this.#managedPersistExpectedIdentity,
				fileEntries: [],
				materializedFileEntries: [],
				adoptedArtifactManager: this.#adoptedArtifactManager,
				coldRestoreFile: this.#sessionFile,
			};
		}
		return this.captureState();
	}

	/** Restore a rollback snapshot, reopening cold authority instead of hydrating it. @internal */
	async restoreRollbackState(snapshot: SessionManagerStateSnapshot): Promise<void> {
		if (!snapshot.coldRestoreFile) {
			this.restoreState(snapshot);
			return;
		}
		await this.#closePersistWriter();
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		const managedTransition =
			this.destination.kind === "managed"
				? this.#prepareManagedDestinationTransition(path.resolve(path.dirname(snapshot.coldRestoreFile)))
				: undefined;
		try {
			managedTransition?.adopt();
			await this.#initSessionFile(snapshot.coldRestoreFile);
			managedTransition?.settle();
		} catch (error) {
			managedTransition?.rollback();
			throw error;
		}
		this.#flushed = snapshot.flushed;
		this.#ensuredOnDisk = snapshot.ensuredOnDisk;
		this.#needsFullRewriteOnNextPersist = snapshot.needsFullRewriteOnNextPersist;
		this.#managedPersistExpectedIdentity = snapshot.managedPersistExpectedIdentity;
		this.#adoptedArtifactManager = snapshot.adoptedArtifactManager;
	}
	captureState(): SessionManagerStateSnapshot {
		this.#ensureFullHotView();
		const materializedFileEntries = materializeResidentEntriesForReadSync(
			this.#fileEntries,
			this.#residentBlobStores(),
		);
		return {
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			sessionFile: this.#sessionFile,
			flushed: this.#flushed,
			ensuredOnDisk: this.#ensuredOnDisk,
			needsFullRewriteOnNextPersist: this.#needsFullRewriteOnNextPersist,
			managedPersistExpectedIdentity: this.#managedPersistExpectedIdentity,
			// Snapshot entry objects by reference: switch/reload replaces the active entry array,
			// so rollback does not need structured cloning of extension/custom details.
			fileEntries: [...this.#fileEntries],
			// Rollback snapshots must own resident data before another session reset disposes
			// the ephemeral store backing the resident sentinels above.
			materializedFileEntries,
			adoptedArtifactManager: this.#adoptedArtifactManager,
		};
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		const restoredFileEntries = [...snapshot.materializedFileEntries];
		const prepared = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile ?? "" },
				primary: {
					mode: "materialize",
					sourceEntries: restoredFileEntries,
					sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
				},
			},
			"retain-and-throw",
		);
		const retainsPersistWriter =
			this.#persistWriter?.isOpen() === true &&
			this.#sessionId === snapshot.sessionId &&
			this.#sessionFile === snapshot.sessionFile &&
			this.#persistWriterPath === snapshot.sessionFile;
		this.#sessionId = snapshot.sessionId;
		this.#sessionName = snapshot.sessionName;
		this.#titleSource = snapshot.titleSource;
		this.#sessionFile = snapshot.sessionFile;
		this.#flushed = snapshot.flushed;
		this.#ensuredOnDisk = snapshot.ensuredOnDisk;
		this.#needsFullRewriteOnNextPersist = snapshot.needsFullRewriteOnNextPersist;
		this.#managedPersistExpectedIdentity = snapshot.managedPersistExpectedIdentity;
		if (!retainsPersistWriter) {
			this.#persistWriter = undefined;
			this.#persistWriterPath = undefined;
		}
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = snapshot.adoptedArtifactManager;
		this.#commitResidentTextStoreTransition(prepared);
		if (this.#sessionFile) writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
	}

	#freshSessionState(options?: NewSessionOptions, sessionFileOverride?: string): FreshSessionState {
		const preallocated = this.#lifecycleIdAdopted ? undefined : lifecyclePreallocatedSessionId();
		const sessionId = preallocated ?? createSessionId();
		const timestamp = new Date().toISOString();
		const sessionFile =
			sessionFileOverride ??
			(this.persist
				? path.join(this.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
				: undefined);
		return {
			sessionId,
			sessionFile,
			header: {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: sessionId,
				timestamp,
				cwd: this.cwd,
				parentSession: options?.parentSession,
			},
			adoptsLifecycleId: preallocated !== undefined,
		};
	}

	#applyFreshSessionMetadata(state: FreshSessionState): void {
		if (state.adoptsLifecycleId) this.#lifecycleIdAdopted = true;
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		this.#sessionId = state.sessionId;
		this.#sessionName = state.header.title;
		this.#titleSource = state.header.titleSource;
		this.#sessionFile = state.sessionFile;
		this.#managedRangeExpectedDescriptor = undefined;
		this.#managedPersistExpectedIdentity = undefined;
		this.#clearBoundedManagedSource();
		this.#flushed = false;
		this.#needsFullRewriteOnNextPersist = false;
		this.#ensuredOnDisk = false;

		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
	}

	#prepareFreshSessionTransition(
		state: FreshSessionState,
		policy: Exclude<ResidentTransitionFailurePolicy, "install-staged">,
	): PreparedResidentStoreTransition {
		return this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: state.sessionId, sessionFile: state.sessionFile ?? "" },
				primary: {
					mode: "materialize",
					sourceEntries: [state.header],
					sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
				},
			},
			policy,
		);
	}

	async #tryInitSessionFileFromSidecar(sessionFile: string): Promise<boolean> {
		SessionManagerTestHooks.lastSidecarInitError = undefined;
		if (
			(this.#sessionMemoryMode !== "enabled" && this.#sessionMemoryMode !== "auto") ||
			(this.destination.kind === "managed" && process.platform === "win32") ||
			typeof this.#storage.readRangeSync !== "function"
		)
			return false;
		if (this.#sessionMemoryMode === "auto") {
			try {
				if (this.#effectiveSessionMemoryMode(this.#storage.statSync(sessionFile).size) !== "enabled") return false;
			} catch {
				return false;
			}
		}
		this.#lazyReopenAttempted = true;
		this.#lazyReopenSucceeded = false;
		this.#lazyReopenFallbackReason = "proof_invalid";
		this.#sessionFile = sessionFile;
		const runtime = this.#resetSidecarRuntime();
		runtime.enabled = true;
		let initialized = false;
		try {
			const commit = this.#readSessionCommitContents();
			const descriptor = this.#managedDescriptorSnapshotOrNull();
			if (this.destination.kind === "managed") this.#managedRangeExpectedDescriptor = descriptor ?? undefined;
			if (
				!commit ||
				!descriptor ||
				!commit.retirementFirstKeptEntryId ||
				!commit.leafId ||
				!commit.reducer ||
				!Array.isArray(commit.providerStateEntries) ||
				!commit.usageStatistics ||
				!Array.isArray(commit.labels) ||
				typeof commit.indexDigest !== "string" ||
				!sameDescriptor(commit.descriptor, descriptor) ||
				!this.#validateColdBase(commit.base)
			)
				return false;
			const tailSize = this.#storage.statSync(runtime.tailPath).size;
			if (tailSize > runtime.tailCache.budgetBytes) return false;
			const tailText = Buffer.from(this.#storage.readRangeSync(runtime.tailPath, 0, tailSize).bytes).toString(
				"utf8",
			);
			const records = tailText
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as TailRecord);
			const validation = validateCommit(commit, records, {
				descriptor,
				baseValid: true,
				tailValid: validateTailChain(commit.base, records).valid,
				terminalMarkerValid: true,
			});
			if (validation.kind !== "valid") return false;
			const fullBaseEmptyTail =
				records.length === 0 &&
				commit.base.baseEndOffset === descriptor.size &&
				commit.transcriptSize === descriptor.size;
			if (
				(!fullBaseEmptyTail &&
					(records.length === 0 ||
						commit.leafId !== records.at(-1)?.id ||
						commit.retirementFirstKeptEntryId !== records[0]?.id)) ||
				!commit.labels.every(
					entry => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string"),
				) ||
				!isValidPersistedReducerState(commit.reducer) ||
				commit.providerStateEntries.length > 256 ||
				Buffer.byteLength(JSON.stringify(commit.providerStateEntries), "utf8") > 4 * 1024 * 1024 ||
				!commit.providerStateEntries.every(isProviderStateEntry) ||
				![
					commit.usageStatistics.input,
					commit.usageStatistics.output,
					commit.usageStatistics.cacheRead,
					commit.usageStatistics.cacheWrite,
					commit.usageStatistics.premiumRequests,
					commit.usageStatistics.cost,
				].every(isFiniteNonNegativeNumber)
			)
				return false;

			// The commit authenticates base + tail but not the index; prove the exact
			// `.spill.idx` bytes before any cold lookup may trust it. Absent or
			// mismatched digests fail closed to the eager authoritative path.
			let indexDescriptor: SessionStorageStat;
			try {
				indexDescriptor = this.#storage.statSync(runtime.indexPath);
			} catch {
				return false;
			}
			if (!this.#validateColdIndexCoverage(sessionFile, descriptor.size, commit.indexDigest)) {
				if (this.#lazyReopenFallbackReason !== "index_digest_mismatch")
					this.#lazyReopenFallbackReason = "index_coverage_invalid";
				return false;
			}
			Bun.gc(true);
			if (fullBaseEmptyTail) {
				let leafOrdinal: number | undefined;
				let boundaryOrdinal: number | undefined;
				const indexSize = this.#storage.statSync(runtime.indexPath).size;
				const scanFailure = scanTranscriptLinesBounded(
					this.#storage,
					runtime.indexPath,
					indexSize,
					(_offset, lineBytes) => {
						try {
							const record = JSON.parse(decodeBoundedJsonLine(lineBytes)) as { id?: unknown; ordinal?: unknown };
							if (typeof record.id !== "string" || !Number.isSafeInteger(record.ordinal)) return false;
							if (record.id === commit.leafId) leafOrdinal = record.ordinal as number;
							if (record.id === commit.retirementFirstKeptEntryId) boundaryOrdinal = record.ordinal as number;
						} catch {
							return false;
						}
					},
				);
				if (
					scanFailure ||
					leafOrdinal === undefined ||
					boundaryOrdinal === undefined ||
					boundaryOrdinal > leafOrdinal
				)
					return false;
				runtime.nextOrdinal = leafOrdinal + 1;
			}
			if (!fullBaseEmptyTail) {
				const terminalRecord = records.at(-1);
				if (!terminalRecord) return false;
				runtime.nextOrdinal = terminalRecord.ordinal + 1;
			}
			runtime.indexDigest = commit.indexDigest;
			runtime.validatedIndexDescriptor = indexDescriptor;
			// Secondary artifacts are disposable acceleration. Parse the authoritative
			// transcript header before adoption so every artifact is bound to its exact session.
			const headerWindow = this.#readRangeSync(sessionFile, 0, Math.min(descriptor.size, 64 * 1024)).bytes;
			const headerEnd = headerWindow.indexOf(10);
			if (headerEnd < 0) return false;
			const header = JSON.parse(Buffer.from(headerWindow.subarray(0, headerEnd)).toString("utf8")) as SessionHeader;
			if (header.type !== "session" || header.version !== CURRENT_SESSION_VERSION) return false;
			this.#adoptCommittedDictionary(commit.dictionary, header.id);
			this.#adoptCommittedParentArtifact(commit.parentIndex);
			const hotEntries: SessionEntry[] = [];
			for (const record of records) {
				const line = this.#readRangeSync(sessionFile, record.byteOffset, record.byteLength).bytes;
				if (computeLineDigest(line) !== record.recordDigest) return false;
				const entry = JSON.parse(Buffer.from(line).toString("utf8")) as SessionEntry;
				if (entry.id !== record.id || entry.type !== record.type) return false;
				if (entry.parentId !== record.parentId) return false;
				hotEntries.push(sanitizeLoadedSessionEntryReplayMetadata(entry));
			}
			const entries: FileEntry[] = [header, ...hotEntries];
			await resolveBlobRefsInEntries(entries, this.#blobStore);
			const tailResidentBytes = records.reduce((total, record) => total + tailRecordResidentBytes(record), 0);
			if (!runtime.tailCache.tryAllocate(tailResidentBytes)) return false;
			const hotSuffixBytes = records.reduce((total, record) => total + record.byteLength, 0);
			const hotResidentBytes = records.reduce(
				(total, record) => total + residentHotEntryBytes(record.byteLength),
				0,
			);
			const fixedReservedBytes =
				runtime.blockCache.budgetBytes +
				runtime.entryCache.budgetBytes +
				runtime.tailCache.budgetBytes +
				REDUCER_BUDGET_BYTES +
				LABELS_PINS_BUDGET_BYTES +
				1024 * 1024;
			if (!runtime.accountant.tryCharge(fixedReservedBytes + hotResidentBytes)) return false;
			for (const [id, label] of commit.labels) if (!runtime.labelsPins.setLabel(id, label)) return false;
			const prepared = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: header.id, sessionFile },
					primary: {
						mode: "materialize",
						sourceEntries: entries,
						sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
						missingPolicy: "placeholder",
					},
				},
				"memory-fallback",
			);
			const terminalDescriptor = this.#managedDescriptorSnapshotOrNull();
			if (!terminalDescriptor || !sameDescriptor(descriptor, terminalDescriptor)) {
				prepared.dispose();
				return false;
			}
			this.#sessionId = header.id;
			this.#sessionName = header.title;
			this.#titleSource = header.titleSource;
			this.#needsFullRewriteOnNextPersist = false;
			runtime.base = commit.base;
			runtime.tail = {
				base: commit.base,
				records,
				terminalChecksum: commit.terminalChecksum,
				terminalSeq: commit.terminalSeq,
				transcriptSize: commit.transcriptSize,
			};
			runtime.retirementFirstKeptEntryId = commit.retirementFirstKeptEntryId;
			runtime.reducer = commit.reducer;
			runtime.providerStateEntries = commit.providerStateEntries ?? [];
			// Metadata-delta adoption is authoritative for provider state: any
			// ambiguity in the binding or rehydration fails closed to the eager path.
			if (!this.#adoptCommittedMetadataDelta(commit.metadataDelta)) return false;
			runtime.hotSuffixBytes = hotSuffixBytes;
			runtime.hotResidentBytes = hotResidentBytes;
			runtime.reservedBudgetBytes = fixedReservedBytes;
			runtime.reopenTransition = { kind: "exact", reason: "descriptor_and_proof_match" };
			runtime.terminalTransition = runtime.reopenTransition;
			this.#commitResidentTextStoreTransition(prepared, false);
			this.#commitGen = commit.gen;
			this.#usageStatistics = commit.usageStatistics;
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			this.#managedPersistExpectedIdentity =
				this.destination.kind === "managed"
					? this.#captureManagedPersistIdentity(sessionFile, managedIdentityFromDescriptor(descriptor))
					: undefined;
			this.#lazyReopenSucceeded = true;
			this.#lazyReopenFallbackReason = undefined;
			initialized = true;
			return true;
		} catch (error) {
			SessionManagerTestHooks.lastSidecarInitError = toError(error).message;
			return false;
		} finally {
			if (!initialized) {
				this.#sidecarRuntime = undefined;
				this.#sessionFile = undefined;
			}
		}
	}

	/**
	 * Bounded first-open startup for `sessionMemoryMode: "enabled"` when no valid
	 * reusable commit marker exists. Limited to ordinary current-version linear
	 * transcript-v5 JSONL with no patch records, duplicate ids, branches,
	 * migrations, or unsupported storage authority. Scans the transcript in
	 * bounded 64 KiB ranges with one full semantic/index pass plus bounded private
	 * index and hash-proof reads, without `loadEntriesFromFile`, `readText*`,
	 * `readBytesSync`, or a full entry graph, builds the disposable sidecar set from
	 * exact raw bytes, and materializes only header + hot suffix. Any malformed line,
	 * patch record, unsupported shape, invalid compaction boundary, oversized
	 * line, descriptor change, budget failure, or schema uncertainty cleans
	 * partial sidecars/state and returns `false` so the caller falls back to the
	 * existing eager authoritative path.
	 */
	#releaseExclusiveLockWithRetry(lock: SessionStorageExclusiveLock): void {
		let firstError: Error | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				lock.releaseSync();
				return;
			} catch (error) {
				firstError ??= toError(error);
			}
		}
		throw firstError ?? new Error("exclusive_lock_release_failed");
	}

	async #acquireBoundedFirstOpenLock(
		sessionFile: string,
	): Promise<SessionStorageExclusiveLock | "published" | undefined> {
		if (!this.#storage.acquireExclusiveLockSync) return undefined;
		const sidecarRoot =
			this.destination.kind === "managed"
				? this.#managedSidecarRoot(sessionFile)
				: sessionFile.endsWith(".jsonl")
					? sessionFile.slice(0, -6)
					: sessionFile;
		if (!sidecarRoot) return undefined;
		const lockPath = `${sidecarRoot}/.session-memory.spill.build-lock`;
		const commitPath = `${sidecarRoot}/.session-memory.spill.commit`;
		let contended = false;
		for (let attempt = 0; attempt < 3000; attempt++) {
			const lock = this.#storage.acquireExclusiveLockSync(lockPath);
			if (lock) {
				try {
					if (contended && this.#storage.existsSync(commitPath)) {
						this.#releaseExclusiveLockWithRetry(lock);
						return "published";
					}
				} catch (error) {
					this.#releaseExclusiveLockWithRetry(lock);
					throw error;
				}
				return lock;
			}
			contended = true;
			if (this.#storage.existsSync(commitPath)) return "published";
			await Bun.sleep(10);
		}
		return undefined;
	}

	async #tryBoundedFirstOpen(sessionFile: string): Promise<boolean> {
		if (
			(this.#sessionMemoryMode !== "enabled" && this.#sessionMemoryMode !== "auto") ||
			(this.destination.kind === "managed" && process.platform === "win32") ||
			typeof this.#storage.readRangeSync !== "function"
		)
			return false;
		if (this.#sessionMemoryMode === "auto") {
			try {
				if (this.#effectiveSessionMemoryMode(this.#storage.statSync(sessionFile).size) !== "enabled") return false;
			} catch {
				return false;
			}
		}
		this.#boundedFirstOpenBuildSuppressed = false;
		this.#lazyReopenAttempted = true;
		this.#lazyReopenSucceeded = false;
		const strategy = firstOpenGcStrategy();
		const secondaryArtifactMode = firstOpenSecondaryArtifactMode();
		const telemetry = emptyFirstOpenTelemetry(strategy, secondaryArtifactMode);
		telemetry.attempted = true;
		telemetry.pressureBaselineBytes = residentProcessBytes();
		this.#firstOpenTelemetry = telemetry;
		const buildLock = await this.#acquireBoundedFirstOpenLock(sessionFile);
		if (buildLock === "published") return this.#tryInitSessionFileFromSidecar(sessionFile);
		if (!buildLock) {
			this.#lazyReopenFallbackReason = "bounded_first_open_lock_unavailable";
			this.#boundedFirstOpenBuildSuppressed = true;
			return false;
		}
		const overallStarted = startFirstOpenPhase();
		let initialized = false;
		try {
			this.#sessionFile = sessionFile;
			const runtime = this.#resetSidecarRuntime();
			if (this.#storage.existsSync(runtime.commitPath)) {
				for (const sidecarPath of this.#disposableSidecarPaths()) {
					if (!sidecarPath) continue;
					try {
						this.#storage.unlinkSync(sidecarPath);
					} catch (error) {
						if (!isEnoent(error)) {
							this.#lazyReopenFallbackReason = "bounded_first_open_stale_cleanup_failed";
							this.#sidecarRuntime = undefined;
							this.#sessionFile = undefined;
							return false;
						}
					}
				}
			}
			this.#lazyReopenFallbackReason = "bounded_first_open_failed";
			const preflightStarted = startFirstOpenPhase();
			const before = this.#managedDescriptorSnapshotOrNull();
			if (this.destination.kind === "managed") this.#managedRangeExpectedDescriptor = before ?? undefined;
			recordFirstOpenPhase(telemetry, "descriptorSecurityPreflight", preflightStarted);
			if (!before || before.size === 0 || before.size > BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES) {
				this.#lazyReopenFallbackReason = "bounded_first_open_unreadable";
				return false;
			}
			const semanticStarted = startFirstOpenPhase();
			const discovery = this.#scanBoundedTranscriptForFirstOpen(sessionFile, before);
			recordFirstOpenPhase(telemetry, "semanticScan", semanticStarted);
			if (!discovery) return false;
			// The semantic pass's fixed duplicate table is no longer needed. Collect it
			// before allocating publication buffers for ordinary-size transcripts; the
			// one-GiB fork lane skips this pause to preserve its latency gate.
			if (before.size < 512 * 1024 * 1024) recordFirstOpenGcRequest(telemetry, true);
			const buildStarted = startFirstOpenPhase();
			const built = this.#buildBoundedFirstOpenSidecars(sessionFile, before, discovery, secondaryArtifactMode);
			recordFirstOpenPhase(telemetry, "indexTailWork", buildStarted);
			if (!built) return false;
			runtime.enabled = true;
			runtime.nextOrdinal = discovery.recordCount;
			this.#leafId = discovery.leafId;
			this.#usageStatistics = discovery.usageStatistics;
			const commitStarted = startFirstOpenPhase();
			const published = this.#publishCommitMarkerFromCurrentTranscriptSync(discovery.header.id);
			const terminalDescriptor = this.#managedDescriptorSnapshotOrNull();
			recordFirstOpenPhase(telemetry, "commitClassification", commitStarted);
			if (!published) {
				this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
				return false;
			}
			if (!terminalDescriptor || !sameDescriptor(before, terminalDescriptor)) {
				this.#lazyReopenFallbackReason = "bounded_first_open_descriptor_changed";
				return false;
			}
			const hotContextStarted = startFirstOpenPhase();
			const entries: FileEntry[] = [discovery.header, ...built.hotEntries];
			await resolveBlobRefsInEntries(entries, this.#blobStore);
			const prepared = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: discovery.header.id, sessionFile },
					primary: {
						mode: "materialize",
						sourceEntries: entries,
						sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
						missingPolicy: "placeholder",
					},
				},
				"memory-fallback",
			);
			recordFirstOpenPhase(telemetry, "hotSuffixContext", hotContextStarted);
			const finalDescriptor = this.#managedDescriptorSnapshotOrNull();
			if (!finalDescriptor || !sameDescriptor(before, finalDescriptor)) {
				prepared.dispose();
				this.#lazyReopenFallbackReason = "bounded_first_open_descriptor_changed";
				return false;
			}
			this.#managedPersistExpectedIdentity =
				this.destination.kind === "managed"
					? this.#captureManagedPersistIdentity(sessionFile, managedIdentityFromDescriptor(before))
					: undefined;
			this.#sessionId = discovery.header.id;
			this.#sessionName = discovery.header.title;
			this.#titleSource = discovery.header.titleSource;
			this.#needsFullRewriteOnNextPersist = false;
			this.#commitResidentTextStoreTransition(prepared, false);
			this.#usageStatistics = discovery.usageStatistics;
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			runtime.reopenTransition = { kind: "rebuild", reason: "bounded_first_open" };
			runtime.terminalTransition = { kind: "exact", reason: "descriptor_and_proof_match" };
			this.#lazyReopenSucceeded = true;
			telemetry.succeeded = true;
			this.#lazyReopenFallbackReason = undefined;
			initialized = true;
			return true;
		} catch {
			return false;
		} finally {
			telemetry.wallMs = Number(process.hrtime.bigint() - overallStarted.wall) / 1_000_000;
			const overallCpu = process.cpuUsage(overallStarted.cpu);
			telemetry.cpuMs = (overallCpu.user + overallCpu.system) / 1_000;
			if (!initialized) {
				this.#boundedFirstOpenBuildSuppressed =
					this.#lazyReopenFallbackReason === "bounded_scan_unterminated" ||
					this.#lazyReopenFallbackReason === "bounded_scan_oversized_line" ||
					this.#lazyReopenFallbackReason === "bounded_scan_missing_parent" ||
					this.#lazyReopenFallbackReason === "bounded_first_open_descriptor_changed";
				for (const sidecarPath of this.#disposableSidecarPaths()) {
					if (!sidecarPath) continue;
					try {
						this.#storage.unlinkSync(sidecarPath);
					} catch {
						// Disposable sidecar cleanup is best-effort; the transcript remains authoritative.
					}
				}
				this.#sidecarRuntime = undefined;
				this.#sessionFile = undefined;
			}
			this.#releaseExclusiveLockWithRetry(buildLock);
		}
	}

	/**
	 * Bounded first-open validation pass: verify an ordinary current-version
	 * linear v5 transcript and derive the sidecar-relevant state (reducer, usage
	 * totals, labels, retirement boundary) without materializing the file or
	 * building an entry graph. Every malformed line, duplicate id, patch record,
	 * unsupported shape, invalid compaction boundary, oversized line, budget
	 * failure, or schema uncertainty sets the lazy fallback reason and returns
	 * `undefined`.
	 */
	#scanBoundedTranscriptForFirstOpen(
		sessionFile: string,
		descriptor: DescriptorSnapshot,
	): BoundedFirstOpenDiscovery | undefined {
		const telemetry = this.#firstOpenTelemetry;
		const seenIds = new BoundedDictionaryIdSet();
		const labelsById = new Map<string, string>();
		let labelsBytes = 0;
		const providerState = new Map<string, { ordinal: number; entry: SessionEntry; bytes: number }>();
		let providerStateBytes = 0;
		const usageStatistics: UsageStatistics = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const addUsage = (totals: ValidatedUsageTotals | null): boolean => {
			if (!totals) return false;
			const next = {
				input: usageStatistics.input + totals.input,
				output: usageStatistics.output + totals.output,
				cacheRead: usageStatistics.cacheRead + totals.cacheRead,
				cacheWrite: usageStatistics.cacheWrite + totals.cacheWrite,
				premiumRequests: usageStatistics.premiumRequests + totals.premiumRequests,
				cost: usageStatistics.cost + totals.cost,
			};
			if (Object.values(next).some(value => !Number.isFinite(value))) return false;
			Object.assign(usageStatistics, next);
			return true;
		};
		const fail = (reason: string): false => {
			this.#lazyReopenFallbackReason = reason;
			return false;
		};
		let header: SessionHeader | undefined;
		let ordinal = -1;
		let lastId: string | undefined;
		let latestModelChange: { ordinal: number; role: string | undefined } | undefined;
		let latestTtsr: { ordinal: number; rulesCount: number; recordsCount: number; count: number } | undefined;
		let latestCompactionBoundary: { firstKeptEntryId: string; ordinal: number } | undefined;
		let scannedBytes = 0;
		let indexSerializationWriteNs = 0n;
		let indexSerializationBuffer = Buffer.allocUnsafe(64 * 1024);
		const runtime = this.#sidecarRuntime;
		if (!runtime?.indexPath) return undefined;
		let indexWriter: SessionStorageWriter | undefined;
		const transcriptHash = crypto.createHash("sha256");
		const hashCheckpoints: BoundedFirstOpenHashCheckpoint[] = [{ offset: 0, hash: transcriptHash.copy() }];
		const hashState = {
			nextCheckpointOffset: BOUNDED_FIRST_OPEN_HASH_CHECKPOINT_INTERVAL_BYTES,
			hashedOffset: 0,
		};
		try {
			indexWriter = openFirstOpenSidecarWriter(this.#storage, runtime.indexPath);
			const scanFailure = scanTranscriptLinesBounded(
				this.#boundedReadStorage(),
				sessionFile,
				descriptor.size,
				(lineStart, lineBytes) => {
					scannedBytes = lineStart + lineBytes.byteLength;
					if (!updateBoundedTranscriptHash(transcriptHash, lineStart, lineBytes, hashState, hashCheckpoints))
						return fail("bounded_scan_malformed");
					let parsed: unknown;
					try {
						parsed = JSON.parse(decodeBoundedJsonLine(lineBytes));
					} catch {
						return fail("bounded_scan_malformed");
					}
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
						return fail("bounded_scan_malformed");
					const record = parsed as Record<string, unknown>;
					if (typeof record.type !== "string" || typeof record.id !== "string")
						return fail("bounded_scan_malformed");
					if (!hasStrictSessionSchema([record as unknown as FileEntry])) return fail("bounded_scan_unsupported");
					telemetry.recordsParsed += 1;
					telemetry.semanticRecordsParsed += 1;
					if (lineStart === 0) {
						if (
							record.type !== "session" ||
							record.version !== CURRENT_SESSION_VERSION ||
							typeof record.timestamp !== "string" ||
							typeof record.cwd !== "string"
						)
							return fail("bounded_scan_unsupported");
						header = record as unknown as SessionHeader;
						return;
					}
					if (record.type === "session") return fail("bounded_scan_unsupported");
					if (record.type === "header_patch" || record.type === "entry_patch")
						return fail("bounded_scan_unsupported");
					if (typeof record.timestamp !== "string") return fail("bounded_scan_malformed");
					const parentId = record.parentId;
					if (parentId !== null && typeof parentId !== "string") return fail("bounded_scan_malformed");
					ordinal++;
					if (ordinal === 0 ? parentId !== null : parentId !== lastId)
						return fail(
							ordinal > 0 && typeof parentId === "string" && !seenIds.has(parentId)
								? "bounded_scan_missing_parent"
								: "bounded_scan_branch",
						);
					const idAdd = seenIds.add(record.id);
					if (idAdd === "duplicate") return fail("bounded_scan_duplicate");
					if (idAdd === "full") return fail("bounded_scan_budget");
					const recordDigest = computeLineDigest(lineBytes);
					const byteLength = lineBytes.byteLength;
					const indexStarted = process.hrtime.bigint();
					const indexLine = `${JSON.stringify({
						id: record.id,
						ordinal,
						seq: ordinal,
						byteOffset: lineStart,
						byteLength,
						recordDigest,
						parentId,
						entryType: record.type,
					})}\n`;
					const indexByteLength = Buffer.byteLength(indexLine, "utf8");
					if (indexByteLength > indexSerializationBuffer.byteLength) {
						let capacity = indexSerializationBuffer.byteLength;
						while (capacity < indexByteLength) capacity *= 2;
						indexSerializationBuffer = Buffer.allocUnsafe(capacity);
					}
					const written = indexSerializationBuffer.write(indexLine, 0, indexByteLength, "utf8");
					if (written !== indexByteLength) return fail("bounded_scan_build_failed");
					const indexBytes = indexSerializationBuffer.subarray(0, written);
					writeFirstOpenSidecarBytes(indexWriter!, indexBytes, telemetry, "index");
					runtime.indexHash.update(indexBytes);
					indexSerializationWriteNs += process.hrtime.bigint() - indexStarted;
					if (record.type === "compaction") {
						if (
							typeof record.firstKeptEntryId !== "string" ||
							record.firstKeptEntryId === record.id ||
							!seenIds.has(record.firstKeptEntryId)
						)
							return fail("bounded_scan_invalid_compaction");
						latestCompactionBoundary = { firstKeptEntryId: record.firstKeptEntryId, ordinal };
					} else if (record.type === "model_change") {
						latestModelChange = { ordinal, role: typeof record.role === "string" ? record.role : undefined };
					} else if (record.type === "ttsr_injection") {
						if (!Array.isArray(record.injectedRules)) return fail("bounded_scan_unsupported");
						const injectedRuleRecords = record.injectedRuleRecords;
						if (injectedRuleRecords !== undefined && !Array.isArray(injectedRuleRecords))
							return fail("bounded_scan_unsupported");
						const ttsrMessageCount = record.ttsrMessageCount;
						if (ttsrMessageCount !== undefined && typeof ttsrMessageCount !== "number")
							return fail("bounded_scan_unsupported");
						latestTtsr = {
							ordinal,
							rulesCount: record.injectedRules.length,
							recordsCount: injectedRuleRecords === undefined ? 0 : injectedRuleRecords.length,
							count: ttsrMessageCount ?? 0,
						};
					} else if (record.type === "label") {
						if (typeof record.targetId !== "string") return fail("bounded_scan_unsupported");
						const label = record.label;
						if (label !== undefined && typeof label !== "string") return fail("bounded_scan_unsupported");
						if (label) {
							const existing = labelsById.get(record.targetId);
							const existingBytes =
								existing === undefined
									? 0
									: residentStringBytes(record.targetId) + residentStringBytes(existing) + 48;
							const nextBytes = residentStringBytes(record.targetId) + residentStringBytes(label) + 48;
							if (labelsBytes - existingBytes + nextBytes > LABELS_PINS_BUDGET_BYTES)
								return fail("bounded_scan_budget");
							labelsBytes += nextBytes - existingBytes;
							labelsById.set(record.targetId, label);
						} else {
							const existing = labelsById.get(record.targetId);
							if (existing !== undefined)
								labelsBytes -= residentStringBytes(record.targetId) + residentStringBytes(existing) + 48;
							labelsById.delete(record.targetId);
						}
					} else if (record.type === "message") {
						if (record.message === null || typeof record.message !== "object")
							return fail("bounded_scan_unsupported");
						const message = record.message as Record<string, unknown>;
						let usage: unknown;
						if (message.role === "assistant") {
							usage = message.usage;
						} else if (message.role === "toolResult" && message.toolName === "task") {
							usage = getTaskToolUsage(message.details);
						}
						if (usage !== undefined && !addUsage(validatePersistedUsageTotals(usage)))
							return fail("bounded_scan_unsupported");
					}
					const providerEntry = record as unknown as SessionEntry;
					const providerKey = providerStateEntryKey(providerEntry);
					if (providerKey) {
						const bytes = lineBytes.byteLength + 64;
						const previous = providerState.get(providerKey);
						const nextBytes = providerStateBytes - (previous?.bytes ?? 0) + bytes;
						if (providerState.size >= 256 && !previous) return fail("bounded_scan_budget");
						if (nextBytes > REDUCER_BUDGET_BYTES) return fail("bounded_scan_budget");
						providerStateBytes = nextBytes;
						providerState.set(providerKey, { ordinal, entry: providerEntry, bytes });
					}
					if ((ordinal & 1023) === 0) recordFirstOpenGcRequest(telemetry, true);
					lastId = record.id;
				},
				undefined,
				false,
				true,
				telemetry,
			);
			if (scanFailure) {
				if (scanFailure === "oversized_line") this.#lazyReopenFallbackReason = "bounded_scan_oversized_line";
				else if (scanFailure === "unterminated") this.#lazyReopenFallbackReason = "bounded_scan_unterminated";
				else if (scanFailure === "read_failed")
					this.#lazyReopenFallbackReason = "bounded_first_open_descriptor_changed";
				// "aborted": the callback already recorded a specific reason.
				return undefined;
			}
			if (!header || ordinal < 0) {
				this.#lazyReopenFallbackReason = "bounded_scan_malformed";
				return undefined;
			}
			if (scannedBytes !== descriptor.size) {
				this.#lazyReopenFallbackReason = "bounded_scan_malformed";
				return undefined;
			}
			if (!latestCompactionBoundary) {
				this.#lazyReopenFallbackReason = "bounded_scan_invalid_compaction";
				return undefined;
			}
			const reducer: ReducerState = {
				modelChange: { latest: latestModelChange },
				ttsr: {
					count: latestTtsr?.count ?? 0,
					rulesCount: latestTtsr?.rulesCount ?? 0,
					recordsCount: latestTtsr?.recordsCount ?? 0,
					largestOrdinal: latestTtsr?.ordinal ?? -1,
				},
			};
			if (!isValidPersistedReducerState(reducer)) {
				this.#lazyReopenFallbackReason = "bounded_scan_unsupported";
				return undefined;
			}
			fsyncFirstOpenSidecarWriter(indexWriter!, telemetry);
			const bufferedIndexWriter = asBufferedSidecarWriter(indexWriter!);
			if (bufferedIndexWriter) {
				const instrumentation = bufferedIndexWriter.getInstrumentation();
				telemetry.indexWriteCalls = instrumentation.writeCalls;
				telemetry.bytesWritten = Math.max(telemetry.bytesWritten, instrumentation.bytesWritten);
			}
			const indexSerializationWriteMs = Number(indexSerializationWriteNs) / 1_000_000;
			telemetry.phaseTelemetry.indexSerializationWrite = {
				wallMs: indexSerializationWriteMs,
				cpuMs: null,
			};
			runtime.indexDigest = runtime.indexHash.copy().digest("hex");
			telemetry.flatIndexElapsedMs = indexSerializationWriteMs;
			try {
				runtime.validatedIndexDescriptor = this.#storage.statSync(runtime.indexPath);
			} catch {
				return undefined;
			}
			return {
				header,
				leafId: lastId!,
				recordCount: ordinal + 1,
				retirementFirstKeptEntryId: latestCompactionBoundary.firstKeptEntryId,
				retirementCompactionOrdinal: latestCompactionBoundary.ordinal,
				reducer,
				usageStatistics,
				labels: [...labelsById],
				providerState: [...providerState.values()]
					.sort((left, right) => left.ordinal - right.ordinal)
					.map(item => ({ ordinal: item.ordinal, entry: item.entry })),
				hashCheckpoints,
				indexDigest: runtime.indexDigest,
			};
		} catch {
			this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
			return undefined;
		} finally {
			try {
				indexWriter?.closeSync();
			} catch {
				// biome-ignore lint/correctness/noUnsafeFinally: fail-closed — partial sidecar publication must never be silently swallowed.
				throw new Error("bounded_index_close_failed");
			}
		}
	}

	/**
	 * Bounded first-open materialization from the semantic/index pass. The transcript
	 * receives one full semantic parse; this stage resolves the private flat-index boundary,
	 * proves the base digest from a bounded hash checkpoint read, then parses the authenticated
	 * hot suffix through one bounded transcript range read.
	 */
	#buildBoundedFirstOpenSidecars(
		sessionFile: string,
		descriptor: DescriptorSnapshot,
		discovery: BoundedFirstOpenDiscovery,
		secondaryArtifactMode: SessionMemorySecondaryArtifactMode = "disabled",
	): { hotEntries: SessionEntry[]; hotSuffixBytes: number } | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.indexPath || !runtime.tailPath) return undefined;
		const telemetry = this.#firstOpenTelemetry;
		const boundedReadStorage = this.#boundedReadStorage();
		let tailWriter: SessionStorageWriter | undefined;
		let buildFailed = false;
		const secondaryArtifactsEligible =
			secondaryArtifactMode !== "disabled" &&
			discovery.recordCount <= PERSISTENT_SECONDARY_ARTIFACT_MAX_RECORDS &&
			(secondaryArtifactMode === "enabled" || descriptor.size <= PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES);
		const parentBuilder = new BoundedParentArtifactBuilder();
		const partitionHashes = Array.from({ length: DICTIONARY_PARTITION_COUNT }, () => crypto.createHash("sha256"));
		const partitionSizes = new Array<number>(DICTIONARY_PARTITION_COUNT).fill(0);
		const partitionRecords = new Array<number>(DICTIONARY_PARTITION_COUNT).fill(0);
		const dictionaryBuilder = new BoundedDictionaryArtifactBuilder({
			detector: new BoundedDictionaryIdSet(),
			target: this.#createDictionaryFlushTarget(partitionHashes, partitionSizes, partitionRecords),
		});
		const metadataDeltaState = this.#createMetadataDeltaRuntimeState();
		runtime.metadataDelta = metadataDeltaState;
		try {
			this.#truncateDerivedArtifactFiles(secondaryArtifactsEligible);
			const indexSize = this.#storage.statSync(runtime.indexPath).size;
			const boundaryPrefix = Buffer.from(`{"id":${JSON.stringify(discovery.retirementFirstKeptEntryId)},`, "utf8");
			let boundaryIndex: ({ id: string } & ColdEntryIndex) | undefined;
			let indexBuildFailed = false;
			const indexFailure = scanTranscriptLinesBounded(
				this.#boundedReadStorage(),
				runtime.indexPath,
				indexSize,
				(_offset, lineBytes) => {
					if (!secondaryArtifactsEligible && !bytesStartWith(lineBytes, boundaryPrefix)) return true;
					let parsed: unknown;
					try {
						parsed = JSON.parse(decodeBoundedJsonLine(lineBytes));
					} catch {
						return false;
					}
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
					const value = parsed as Partial<ColdEntryIndex> & { id?: unknown };
					if (
						typeof value.id !== "string" ||
						!Number.isSafeInteger(value.ordinal) ||
						!Number.isSafeInteger(value.seq) ||
						!Number.isSafeInteger(value.byteOffset) ||
						!Number.isSafeInteger(value.byteLength) ||
						typeof value.recordDigest !== "string" ||
						(value.parentId !== null && typeof value.parentId !== "string") ||
						typeof value.entryType !== "string"
					) {
						indexBuildFailed = true;
						return false;
					}
					const indexEntry = value as { id: string } & ColdEntryIndex;
					if (secondaryArtifactsEligible) {
						const dictionaryAdd = dictionaryBuilder.add({
							id: indexEntry.id,
							ordinal: indexEntry.ordinal,
							seq: indexEntry.seq,
							byteOffset: indexEntry.byteOffset,
							byteLength: indexEntry.byteLength,
							recordDigest: indexEntry.recordDigest,
							parentId: indexEntry.parentId ?? null,
							entryType: indexEntry.entryType!,
						});
						if (dictionaryAdd.kind !== "ok") {
							indexBuildFailed = true;
							return false;
						}
						if (typeof indexEntry.parentId === "string") {
							parentBuilder.add({
								parentId: indexEntry.parentId,
								childId: indexEntry.id,
								ordinal: indexEntry.ordinal,
								seq: indexEntry.seq,
								byteOffset: indexEntry.byteOffset,
								byteLength: indexEntry.byteLength,
								recordDigest: indexEntry.recordDigest,
								entryType: indexEntry.entryType!,
							});
						}
					}
					if (indexEntry.id === discovery.retirementFirstKeptEntryId) boundaryIndex = indexEntry;
					return true;
				},
				undefined,
				false,
				true,
				telemetry,
				false,
			);
			if (
				indexFailure ||
				indexBuildFailed ||
				!boundaryIndex ||
				boundaryIndex.ordinal >= discovery.retirementCompactionOrdinal
			) {
				this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
				return undefined;
			}
			const baseEndOffset = boundaryIndex.byteOffset;
			const checkpoint = [...discovery.hashCheckpoints]
				.reverse()
				.find(candidate => candidate.offset <= baseEndOffset);
			if (
				!checkpoint ||
				baseEndOffset < checkpoint.offset ||
				baseEndOffset - checkpoint.offset > SESSION_RANGE_READ_MAX_BYTES
			) {
				this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
				return undefined;
			}
			const baseHash = checkpoint.hash.copy();
			let hashOffset = checkpoint.offset;
			while (hashOffset < baseEndOffset) {
				const length = Math.min(SESSION_RANGE_READ_MAX_BYTES, baseEndOffset - hashOffset);
				const baseSnapshot = boundedReadStorage.readRangeSync!(sessionFile, hashOffset, length);
				if (!sameDescriptor(descriptor, baseSnapshot.stat) || baseSnapshot.bytes.byteLength !== length) {
					this.#lazyReopenFallbackReason = !sameDescriptor(descriptor, baseSnapshot.stat)
						? "bounded_first_open_descriptor_changed"
						: "bounded_scan_build_failed";
					return undefined;
				}
				const bytes = baseSnapshot.bytes;
				baseHash.update(bytes);
				telemetry.bytesRead += length;
				telemetry.transcriptBytesRead += length;
				hashOffset += length;
			}
			const baseDigest = baseHash.digest("hex");
			const suffixLength = descriptor.size - baseEndOffset;
			if (suffixLength <= 0 || suffixLength > this.#sidecarHotSuffixBudgetBytes) {
				this.#lazyReopenFallbackReason = "bounded_scan_budget";
				return undefined;
			}
			const suffixSnapshot = boundedReadStorage.readRangeSync!(sessionFile, baseEndOffset, suffixLength);
			if (!sameDescriptor(descriptor, suffixSnapshot.stat) || suffixSnapshot.bytes.byteLength !== suffixLength) {
				this.#lazyReopenFallbackReason = "bounded_first_open_descriptor_changed";
				return undefined;
			}
			telemetry.bytesRead += suffixLength;
			telemetry.transcriptBytesRead += suffixLength;
			const suffixBytes = Buffer.from(
				suffixSnapshot.bytes.buffer,
				suffixSnapshot.bytes.byteOffset,
				suffixSnapshot.bytes.byteLength,
			);
			tailWriter = openFirstOpenSidecarWriter(this.#storage, runtime.tailPath);
			const tailBuilder = new RollingTailChainBuilder(
				{ baseDigest, baseEndOffset },
				{ tailBufferBytes: sidecarTailBufferBytes() },
			);
			let tailSeq = 0;
			let hotSuffixBytes = 0;
			let hotResidentBytes = 0;
			let tailResidentBytes = 0;
			let previousId: string | undefined;
			const hotEntries: SessionEntry[] = [];
			for (let cursor = 0; cursor < suffixBytes.byteLength; ) {
				const newline = suffixBytes.indexOf(0x0a, cursor);
				if (newline < 0) {
					buildFailed = true;
					break;
				}
				const byteLength = newline - cursor + 1;
				if (byteLength > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) {
					buildFailed = true;
					break;
				}
				const lineBytes = suffixBytes.subarray(cursor, newline + 1);
				let parsed: unknown;
				try {
					parsed = JSON.parse(decodeBoundedJsonLine(lineBytes));
				} catch {
					buildFailed = true;
					break;
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					buildFailed = true;
					break;
				}
				const record = parsed as Record<string, unknown>;
				const parentId = record.parentId;
				if (
					typeof record.id !== "string" ||
					typeof record.type !== "string" ||
					(parentId !== null && typeof parentId !== "string") ||
					(tailSeq === 0 ? record.id !== boundaryIndex.id : parentId !== previousId)
				) {
					buildFailed = true;
					break;
				}
				const recordDigest = computeLineDigest(lineBytes);
				telemetry.recordsParsed += 1;
				telemetry.suffixRecordsParsed += 1;
				const entry = sanitizeLoadedSessionEntryReplayMetadata(record as unknown as SessionEntry);
				const tailRecord = tailBuilder.append({
					seq: tailSeq,
					kind: tailRecordKindForEntry(entry),
					ordinal: boundaryIndex.ordinal + tailSeq,
					id: record.id,
					parentId,
					type: record.type,
					byteOffset: baseEndOffset + cursor,
					byteLength,
					recordDigest,
				});
				if (!tailRecord) {
					buildFailed = true;
					break;
				}
				const tailBytes = Buffer.from(`${JSON.stringify(tailRecord)}\n`, "utf8");
				writeFirstOpenSidecarBytes(tailWriter, tailBytes, telemetry, "tail");
				tailSeq++;
				previousId = record.id;
				tailResidentBytes += tailRecordResidentBytes(tailRecord);
				hotSuffixBytes += byteLength;
				hotResidentBytes += residentHotEntryBytes(byteLength);
				hotEntries.push(entry);
				cursor = newline + 1;
			}
			if (buildFailed) {
				this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
				return undefined;
			}
			const tail = tailBuilder.build();
			if (tail.transcriptSize !== descriptor.size || tail.records.length === 0) {
				this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
				return undefined;
			}
			fsyncFirstOpenSidecarWriter(tailWriter, telemetry);
			if (!runtime.tailCache.tryAllocate(tailResidentBytes)) {
				this.#lazyReopenFallbackReason = "bounded_scan_budget";
				return undefined;
			}
			const fixedReservedBytes =
				runtime.blockCache.budgetBytes +
				runtime.entryCache.budgetBytes +
				runtime.tailCache.budgetBytes +
				REDUCER_BUDGET_BYTES +
				LABELS_PINS_BUDGET_BYTES +
				1024 * 1024;
			if (!runtime.accountant.tryCharge(fixedReservedBytes + hotResidentBytes)) {
				this.#lazyReopenFallbackReason = "bounded_scan_budget";
				return undefined;
			}
			runtime.hotResidentBytes = hotResidentBytes;
			runtime.reservedBudgetBytes = fixedReservedBytes;
			runtime.base = { baseDigest, baseEndOffset };
			runtime.tail = tail;
			runtime.retirementFirstKeptEntryId = discovery.retirementFirstKeptEntryId;
			runtime.reducer = discovery.reducer;
			runtime.hotSuffixBytes = hotSuffixBytes;
			runtime.indexDigest = discovery.indexDigest;
			metadataDeltaState.indexDigest = runtime.indexDigest;
			const dictionaryStarted = startFirstOpenPhase();
			if (secondaryArtifactsEligible) {
				const dictionaryResult = dictionaryBuilder.finish(discovery.header.id, runtime.indexDigest);
				if (dictionaryResult.kind !== "ok" || dictionaryResult.commit.sidecarIneligible) {
					this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
					return undefined;
				}
				if (
					!this.#adoptBuiltDictionaryArtifact(dictionaryResult, partitionHashes, partitionSizes, partitionRecords)
				) {
					this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
					return undefined;
				}
			} else {
				runtime.dictionary = undefined;
			}
			recordFirstOpenPhase(telemetry, "dictionary", dictionaryStarted);
			telemetry.dictionaryBuildElapsedMs = telemetry.phaseTelemetry.dictionary?.wallMs ?? 0;
			telemetry.dictionaryArtifactEnabled = runtime.dictionary !== undefined;
			const metadataStarted = startFirstOpenPhase();
			runtime.providerStateEntries = [];
			runtime.providerStateOrder = [];
			for (const provider of discovery.providerState) {
				const providerKey = providerStateEntryKey(provider.entry);
				if (!providerKey) continue;
				runtime.providerStateOrder.push(providerKey);
				const persistedLine = Buffer.from(`${JSON.stringify(provider.entry)}\n`, "utf8");
				if (persistedLine.byteLength > MAX_REDUCER_INLINE_BYTES) {
					const stored = this.#appendMetadataDeltaValue(persistedLine);
					if (stored) {
						metadataDeltaState.byKey.set(providerKey, {
							kind: provider.entry.type,
							ordinal: provider.ordinal,
							...stored,
						});
					} else {
						metadataDeltaState.byKey.delete(providerKey);
						runtime.providerStateEntries.push(cloneSessionEntry(provider.entry));
					}
				} else {
					runtime.providerStateEntries.push(cloneSessionEntry(provider.entry));
				}
			}
			this.#syncMetadataDeltaDescriptorBytes();
			recordFirstOpenPhase(telemetry, "metadataDelta", metadataStarted);
			const parentStarted = startFirstOpenPhase();
			if (secondaryArtifactsEligible) this.#publishParentArtifact(parentBuilder, runtime.indexDigest);
			else runtime.parentArtifact = undefined;
			try {
				const validated = this.#storage.statSync(runtime.indexPath);
				runtime.validatedIndexDescriptor = validated;
			} catch {
				// A missing index falls back to the authoritative digest re-verification path.
			}
			recordFirstOpenPhase(telemetry, "parent", parentStarted);
			telemetry.parentBuildElapsedMs = telemetry.phaseTelemetry.parent?.wallMs ?? 0;
			telemetry.parentArtifactEnabled = runtime.parentArtifact !== undefined;
			for (const [id, label] of discovery.labels) {
				if (!runtime.labelsPins.setLabel(id, label)) {
					this.#lazyReopenFallbackReason = "bounded_scan_budget";
					return undefined;
				}
			}
			return { hotEntries, hotSuffixBytes };
		} catch {
			this.#lazyReopenFallbackReason = "bounded_scan_build_failed";
			return undefined;
		} finally {
			try {
				tailWriter?.closeSync();
			} catch {
				// biome-ignore lint/correctness/noUnsafeFinally: fail-closed — partial tail publication must never be silently swallowed.
				throw new Error("bounded_tail_close_failed");
			}
		}
	}

	/** Initialize with a specific session file (used by factory methods). */
	async #initSessionFile(
		sessionFile: string,
		initializeMissing = false,
		strictResume?: { inspection: ResumeInspectionSnapshot; storage: SessionStorage; reuseEntries?: boolean },
		requireExisting = false,
		deferPersistenceUntilAccepted = false,
	): Promise<void> {
		let strictManagedFallbackEntries: FileEntry[] | undefined;
		let strictManagedFallbackMigrationApplied = false;
		const resolvedSessionFile = this.#storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
		const revalidateStrictResume = (): void => {
			if (
				strictResume &&
				!revalidateStrictResumeInspection(resolvedSessionFile, strictResume.storage, strictResume.inspection)
			)
				throw new Error("Could not open session: unstable");
		};
		revalidateStrictResume();
		const sidecarRoot =
			this.destination.kind === "managed"
				? this.#managedSidecarRoot(resolvedSessionFile)
				: resolvedSessionFile.endsWith(".jsonl")
					? resolvedSessionFile.slice(0, -6)
					: resolvedSessionFile;
		let transcriptSize: number | undefined;
		try {
			transcriptSize = this.#statSync(resolvedSessionFile).size;
		} catch {
			// Missing/unreadable transcripts continue through the existing initialization path.
		}
		const boundedTranscriptAdmitted =
			transcriptSize !== undefined && transcriptSize > 0 && transcriptSize <= BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES;
		const publishedSidecarWasPresent =
			sidecarRoot !== undefined &&
			boundedTranscriptAdmitted &&
			this.#effectiveSessionMemoryMode(transcriptSize) === "enabled" &&
			this.#storage.existsSync(`${sidecarRoot}/.session-memory.spill.commit`);
		if (boundedTranscriptAdmitted && (await this.#tryInitSessionFileFromSidecar(resolvedSessionFile))) {
			this.#writeTerminalBreadcrumb(resolvedSessionFile);
			revalidateStrictResume();
			return;
		}

		if (boundedTranscriptAdmitted && (await this.#tryBoundedFirstOpen(resolvedSessionFile))) {
			if (publishedSidecarWasPresent && this.#lazyReopenAttempted && !this.#lazyReopenSucceeded) {
				this.#sessionMemoryMode = "shadow";
				this.#sessionMemoryAutoDisabledReason = "sidecar_reload_failures";
			}
			this.#writeTerminalBreadcrumb(resolvedSessionFile);
			revalidateStrictResume();
			return;
		}
		revalidateStrictResume();
		SessionManagerTestHooks.beforeStrictMissingCheck?.(resolvedSessionFile, this.#storage);
		const transcriptMissing =
			(initializeMissing || strictResume !== undefined || requireExisting) &&
			!this.#storage.existsSync(resolvedSessionFile);
		if ((strictResume || requireExisting) && transcriptMissing) throw new Error("Could not open session: unstable");
		if (initializeMissing && transcriptMissing) {
			const fresh = this.#freshSessionState(undefined, resolvedSessionFile);
			const prepared = this.#prepareFreshSessionTransition(fresh, "memory-fallback");
			this.#applyFreshSessionMetadata(fresh);
			this.#commitResidentTextStoreTransition(prepared);
			this.#retireEphemeralArtifacts();
			this.#writeTerminalBreadcrumb(resolvedSessionFile);
			await this.#rewriteFile();
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			return;
		}
		if (strictResume?.reuseEntries !== false) strictManagedFallbackEntries = strictResume?.inspection.entries;
		if (
			!strictResume &&
			this.destination.kind === "managed" &&
			this.#sessionMemoryMode === "enabled" &&
			process.platform !== "win32"
		) {
			const inspected = inspectResumeSessionFile(resolvedSessionFile, this.#storage);
			if ("kind" in inspected) throw new Error(`Could not open session: ${inspected.reason}`);
			strictManagedFallbackEntries = inspected.entries;
			strictManagedFallbackMigrationApplied = inspected.migrationApplied;
		}
		const eagerStat = this.#statSync(resolvedSessionFile);
		if (eagerStat.size > EAGER_RESUME_TRANSCRIPT_MAX_BYTES) throw new SessionTranscriptOversizedError(eagerStat.size);
		const entries = strictManagedFallbackEntries ?? (await loadEntriesFromFile(resolvedSessionFile, this.#storage));
		revalidateStrictResume();
		if (entries.length === 0) {
			const fresh = this.#freshSessionState(undefined, resolvedSessionFile);
			const prepared = this.#prepareFreshSessionTransition(fresh, "memory-fallback");
			this.#applyFreshSessionMetadata(fresh);
			this.#commitResidentTextStoreTransition(prepared);
			this.#retireEphemeralArtifacts();
			this.#writeTerminalBreadcrumb(resolvedSessionFile);
			await this.#rewriteFile();
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			return;
		}
		const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const sessionId = header?.id ?? createSessionId();
		const migrationApplied =
			strictResume && strictResume.reuseEntries !== false
				? strictResume.inspection.migrationApplied
				: strictManagedFallbackEntries
					? strictManagedFallbackMigrationApplied
					: migrateToCurrentVersion(entries);
		await resolveBlobRefsInEntries(entries, this.#blobStore);
		const prepared = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId, sessionFile: resolvedSessionFile },
				primary: {
					mode: "materialize",
					sourceEntries: entries,
					sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
					missingPolicy: "placeholder",
				},
			},
			"memory-fallback",
		);
		this.#sessionFile = resolvedSessionFile;
		this.#sessionId = sessionId;
		this.#sessionName = header?.title;
		this.#titleSource = header?.titleSource;
		this.#needsFullRewriteOnNextPersist = migrationApplied;
		this.#commitResidentTextStoreTransition(prepared);
		this.#writeTerminalBreadcrumb(resolvedSessionFile);
		this.#flushed = true;
		this.#ensuredOnDisk = true;
		this.#adoptManagedPersistIdentity(resolvedSessionFile);
		if (!strictResume && !deferPersistenceUntilAccepted)
			await this.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
		if (publishedSidecarWasPresent && this.#lazyReopenAttempted && !this.#lazyReopenSucceeded) {
			this.#sessionMemoryMode = "shadow";
			this.#sessionMemoryAutoDisabledReason = "sidecar_reload_failures";
		}
	}

	#writeTerminalBreadcrumb(sessionFile: string): void {
		if (this.#stagedPublication && !this.#stagedPublication.committed) return;
		writeTerminalBreadcrumb(this.cwd, sessionFile);
	}

	async #hydrateExistingSession(
		sessionFile: string,
		entries: FileEntry[],
		migrationApplied: boolean,
		policy: Exclude<ResidentTransitionFailurePolicy, "install-staged"> = "memory-fallback",
	): Promise<void> {
		// Strict inspection creates these entries solely for this hydration path. Adopt that
		// final, validated representation instead of cloning the complete transcript again.
		const header = entries[0] as SessionHeader;
		const resolvedSessionFile = this.#storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
		await resolveBlobRefsInEntries(entries, this.#blobStore);
		const prepared = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: header.id, sessionFile: resolvedSessionFile },
				primary: {
					mode: "materialize",
					sourceEntries: entries,
					sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
					missingPolicy: "placeholder",
				},
			},
			policy,
		);
		this.#sessionFile = resolvedSessionFile;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#needsFullRewriteOnNextPersist = migrationApplied;
		this.#commitResidentTextStoreTransition(prepared);
		this.#flushed = true;
		this.#ensuredOnDisk = true;
		this.#adoptManagedPersistIdentity(resolvedSessionFile);
	}

	/** Initialize with a new session (used by factory methods). */
	#initNewSession(): void {
		this.#newSessionSync();
	}

	/** Switch to a different session file (used for resume and branching). */
	async setSessionFile(sessionFile: string, options?: { deferEphemeralArtifactRetirement?: boolean }): Promise<void> {
		this.#assertRecoveryHydrationWritable();
		const resolvedSessionFile = this.#storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
		const strictAdoption = this.#pendingStrictAdoption;
		let managedTransition: ManagedDestinationTransition | undefined;
		if (this.destination.kind === "managed") {
			const candidateDirectory = path.resolve(path.dirname(resolvedSessionFile));
			if (candidateDirectory === path.resolve(this.destination.directory)) {
				const candidateStore = this.#managedTranscriptStore(resolvedSessionFile);
				candidateStore.verifyRootSecurity();
				candidateStore.assertBound();
			} else {
				managedTransition = this.#prepareManagedDestinationTransition(candidateDirectory);
			}
		}
		try {
			if (strictAdoption && resolvedSessionFile === strictAdoption.canonicalPath) {
				const inspected = inspectResumeSessionFile(resolvedSessionFile, this.#storage);
				if ("kind" in inspected || !sameResumeIdentity(strictAdoption.identity, inspected.identity))
					throw new Error("Prepared session changed before strict adoption.");
			}
			if (!strictAdoption && this.#storage.existsSync(resolvedSessionFile)) {
				let targetSize: number | undefined;
				try {
					targetSize = this.#storage.statSync(resolvedSessionFile).size;
				} catch {
					// Strict eager inspection below handles unreadable targets.
				}
				const boundedTarget =
					targetSize !== undefined &&
					targetSize > 0 &&
					targetSize > eagerHydrationMaxBytes() &&
					targetSize <= BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES &&
					this.#effectiveSessionMemoryMode(targetSize) === "enabled";
				if (boundedTarget) {
					const previous = await this.captureRollbackState();
					try {
						await this.#closePersistWriter();
						managedTransition?.adopt();
						await this.#initSessionFile(resolvedSessionFile);
						if (!options?.deferEphemeralArtifactRetirement) this.#retireEphemeralArtifacts();
						managedTransition?.settle();
						this.#pendingStrictAdoption = undefined;
						return;
					} catch (error) {
						managedTransition?.rollback();
						await this.restoreRollbackState(previous);
						throw error;
					}
				}
			}
			let entries: FileEntry[];
			let candidateMigrationApplied = false;
			if (strictAdoption?.inspection && resolvedSessionFile === strictAdoption.canonicalPath) {
				entries = strictAdoption.inspection.entries;
				candidateMigrationApplied = strictAdoption.inspection.migrationApplied;
			} else if (this.#storage.existsSync(resolvedSessionFile)) {
				const inspected = inspectResumeSessionFile(resolvedSessionFile, this.#storage);
				if ("kind" in inspected) throw new Error(`Could not switch session: ${inspected.reason}`);
				entries = inspected.entries;
				candidateMigrationApplied = inspected.migrationApplied;
			} else {
				entries = await loadEntriesFromFile(resolvedSessionFile, this.#storage);
			}
			if (strictAdoption) {
				const inspected = inspectResumeSessionFile(resolvedSessionFile, this.#storage);
				if ("kind" in inspected || !sameResumeIdentity(strictAdoption.identity, inspected.identity))
					throw new Error("Prepared session changed during strict adoption.");
			}
			if (entries.length > 0) {
				const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
				const sessionId = header?.id ?? createSessionId();
				const migrationApplied = candidateMigrationApplied || migrateToCurrentVersion(entries);
				await resolveBlobRefsInEntries(entries, this.#blobStore);
				const prepared = this.#prepareResidentTextStoreTransition(
					{
						target: { sessionId, sessionFile: resolvedSessionFile },
						allowUnwritableResidentCacheFallback: true,
						primary: {
							mode: "materialize",
							sourceEntries: entries,
							sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
						},
					},
					"retain-and-throw",
				);
				try {
					await this.#closePersistWriter();
				} catch (error) {
					prepared.dispose();
					throw error;
				}
				if (strictAdoption) {
					const inspected = inspectResumeSessionFile(resolvedSessionFile, this.#storage);
					if ("kind" in inspected || !sameResumeIdentity(strictAdoption.identity, inspected.identity)) {
						prepared.dispose();
						throw new Error("Prepared session changed before strict adoption commit.");
					}
				}
				const previous = {
					sessionId: this.#sessionId,
					sessionName: this.#sessionName,
					titleSource: this.#titleSource,
					sessionFile: this.#sessionFile,
					needsFullRewriteOnNextPersist: this.#needsFullRewriteOnNextPersist,
					managedPersistExpectedIdentity: this.#managedPersistExpectedIdentity,
				};
				this.#persistError = undefined;
				this.#persistErrorReported = false;
				this.#sessionFile = resolvedSessionFile;
				this.#sessionId = sessionId;
				this.#sessionName = header?.title;
				this.#titleSource = header?.titleSource;
				this.#needsFullRewriteOnNextPersist = migrationApplied;
				try {
					managedTransition?.adopt();
					writeTerminalBreadcrumb(this.cwd, resolvedSessionFile);
					await SessionManagerTestHooks.beforeManagedSwitchIdentity?.(resolvedSessionFile, this.#storage);
					this.#adoptManagedPersistIdentity(resolvedSessionFile);
					this.#commitResidentTextStoreTransition(prepared);
				} catch (error) {
					managedTransition?.rollback();
					this.#sessionId = previous.sessionId;
					this.#sessionName = previous.sessionName;
					this.#titleSource = previous.titleSource;
					this.#sessionFile = previous.sessionFile;
					this.#needsFullRewriteOnNextPersist = previous.needsFullRewriteOnNextPersist;
					this.#managedPersistExpectedIdentity = previous.managedPersistExpectedIdentity;
					prepared.dispose();
					throw error;
				}
				entries.length = 0;
				if (!options?.deferEphemeralArtifactRetirement) this.#retireEphemeralArtifacts();
				managedTransition?.settle();
				this.#pendingStrictAdoption = undefined;
				this.#flushed = true;
				this.#ensuredOnDisk = true;
				await this.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
				return;
			}
			const fresh = this.#freshSessionState(undefined, resolvedSessionFile);
			const prepared = this.#prepareFreshSessionTransition(fresh, "retain-and-throw");
			try {
				await this.#closePersistWriter();
			} catch (error) {
				prepared.dispose();
				throw error;
			}
			const previous = {
				lifecycleIdAdopted: this.#lifecycleIdAdopted,
				persistChain: this.#persistChain,
				persistError: this.#persistError,
				persistErrorReported: this.#persistErrorReported,
				sessionId: this.#sessionId,
				sessionName: this.#sessionName,
				titleSource: this.#titleSource,
				sessionFile: this.#sessionFile,
				flushed: this.#flushed,
				needsFullRewriteOnNextPersist: this.#needsFullRewriteOnNextPersist,
				ensuredOnDisk: this.#ensuredOnDisk,
				managedPersistExpectedIdentity: this.#managedPersistExpectedIdentity,
				artifactManager: this.#artifactManager,
				artifactManagerSessionFile: this.#artifactManagerSessionFile,
				adoptedArtifactManager: this.#adoptedArtifactManager,
			};
			this.#applyFreshSessionMetadata(fresh);
			try {
				managedTransition?.adopt();
				writeTerminalBreadcrumb(this.cwd, resolvedSessionFile);
				this.#commitResidentTextStoreTransition(prepared);
				if (!options?.deferEphemeralArtifactRetirement) this.#retireEphemeralArtifacts();
			} catch (error) {
				managedTransition?.rollback();
				this.#lifecycleIdAdopted = previous.lifecycleIdAdopted;
				this.#persistChain = previous.persistChain;
				this.#persistError = previous.persistError;
				this.#persistErrorReported = previous.persistErrorReported;
				this.#sessionId = previous.sessionId;
				this.#sessionName = previous.sessionName;
				this.#titleSource = previous.titleSource;
				this.#sessionFile = previous.sessionFile;
				this.#flushed = previous.flushed;
				this.#needsFullRewriteOnNextPersist = previous.needsFullRewriteOnNextPersist;
				this.#ensuredOnDisk = previous.ensuredOnDisk;
				this.#managedPersistExpectedIdentity = previous.managedPersistExpectedIdentity;
				this.#artifactManager = previous.artifactManager;
				this.#artifactManagerSessionFile = previous.artifactManagerSessionFile;
				this.#adoptedArtifactManager = previous.adoptedArtifactManager;
				prepared.dispose();
				throw error;
			}
			managedTransition?.settle();
			this.#pendingStrictAdoption = undefined;
			await this.#rewriteFile();
			this.#flushed = true;
			this.#ensuredOnDisk = true;
		} catch (error) {
			managedTransition?.dispose();
			throw error;
		}
	}

	/** Start a new session. Closes any existing writer first. */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		this.#assertRecoveryHydrationWritable();
		const prepared = await this.prepareNewSession(options);
		try {
			this.commitPreparedNewSession(prepared);
		} catch (error) {
			try {
				await this.discardPreparedNewSession(prepared);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"New session adoption and staged session cleanup both failed.",
				);
			}
			throw error;
		}
		return prepared.sessionFile;
	}

	/**
	 * Allocate a fresh successor without publishing it through the manager's public
	 * getters. The returned authority is deliberately immutable so readiness work
	 * can resolve local:// against the successor while the predecessor stays live.
	 * @internal
	 */
	async prepareNewSession(options?: NewSessionOptions): Promise<PreparedNewSession> {
		this.#assertRecoveryHydrationWritable();
		await this.#retryPreparedNewSessionCleanups();
		await this.#closePersistWriter();
		const preallocated = this.#lifecycleIdAdopted ? undefined : lifecyclePreallocatedSessionId();
		const sessionId = preallocated ?? createSessionId();
		const timestamp = new Date().toISOString();
		const sessionFile = this.persist
			? path.join(this.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
			: undefined;
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		const stage: PreparedNewSessionState = {
			sessionId,
			sessionFile,
			artifactsDir: sessionFile ? sessionFile.slice(0, -6) : null,
			managedLegacyLocalMigrationSource: this.#managedLegacyLocalMigrationSourceFor(sessionFile),
			header,
			fileEntries: [header],
			sessionName: undefined,
			titleSource: undefined,
			flushed: false,
			committed: false,
			discarded: false,
		};
		this.#preparedNewSessions.add(stage);
		this.#freezePreparedNewSessionIdentity(stage);
		return stage;
	}

	/** Append a model selection to an unpublished successor. @internal */
	appendPreparedModelChange(prepared: PreparedNewSession, model: string): string {
		const stage = this.#getPreparedNewSessionStage(prepared);
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: this.#nextPreparedNewSessionEntryId(stage),
			parentId: this.#preparedNewSessionLeafId(stage),
			timestamp: new Date().toISOString(),
			model,
		};
		stage.fileEntries.push(entry);
		return entry.id;
	}

	/** Append a thinking-level selection to an unpublished successor. @internal */
	appendPreparedThinkingLevelChange(prepared: PreparedNewSession, thinkingLevel?: string): string {
		const stage = this.#getPreparedNewSessionStage(prepared);
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: this.#nextPreparedNewSessionEntryId(stage),
			parentId: this.#preparedNewSessionLeafId(stage),
			timestamp: new Date().toISOString(),
			thinkingLevel: thinkingLevel ?? null,
		};
		stage.fileEntries.push(entry);
		return entry.id;
	}

	/** Append a service-tier selection to an unpublished successor. @internal */
	appendPreparedServiceTierChange(prepared: PreparedNewSession, serviceTier: ServiceTier | null): string {
		const stage = this.#getPreparedNewSessionStage(prepared);
		const entry: ServiceTierChangeEntry = {
			type: "service_tier_change",
			id: this.#nextPreparedNewSessionEntryId(stage),
			parentId: this.#preparedNewSessionLeafId(stage),
			timestamp: new Date().toISOString(),
			serviceTier,
		};
		stage.fileEntries.push(entry);
		return entry.id;
	}

	/** Append a displayable custom message to an unpublished successor. @internal */
	appendPreparedCustomMessageEntry<T = unknown>(
		prepared: PreparedNewSession,
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		attribution: MessageAttribution = "agent",
	): string {
		const stage = this.#getPreparedNewSessionStage(prepared);
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details: stripInternalDetailsFields(details),
			attribution,
			id: this.#nextPreparedNewSessionEntryId(stage),
			parentId: this.#preparedNewSessionLeafId(stage),
			timestamp: new Date().toISOString(),
		};
		stage.fileEntries.push(entry);
		return entry.id;
	}

	/** Persist an unpublished successor without adopting it. @internal */
	async ensurePreparedNewSessionOnDisk(prepared: PreparedNewSession): Promise<void> {
		const stage = this.#getPreparedNewSessionStage(prepared);
		if (!this.persist || !stage.sessionFile || stage.flushed) return;
		const entries = await Promise.all(
			stage.fileEntries.map(entry => prepareEntryForPersistence(entry, this.#blobStore)),
		);
		if (this.destination.kind === "managed") {
			const bytes = Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
			await this.#managedTranscriptStore(stage.sessionFile).publishNoReplace(
				path.basename(stage.sessionFile),
				bytes,
			);
		} else {
			const staleCleanupError = await this.#cleanupPreparedNewSessionPersistence(stage);
			if (staleCleanupError) throw staleCleanupError;
			const dir = path.resolve(stage.sessionFile, "..");
			const tempPath = path.join(dir, `.${path.basename(stage.sessionFile)}.${Snowflake.next()}.tmp`);
			const writer = new NdjsonFileWriter(this.#storage, tempPath, { flags: "w" });
			stage.persistenceTempPath = tempPath;
			stage.persistenceWriter = writer;
			try {
				for (const entry of entries) await writer.write(entry);
				await writer.flush();
				await writer.fsync();
				await writer.close();
				stage.persistenceWriter = undefined;
				await this.#replaceSessionFile(tempPath, stage.sessionFile);
				stage.persistenceTempPath = undefined;
			} catch (error) {
				const cleanupError = await this.#cleanupPreparedNewSessionPersistence(stage);
				if (cleanupError)
					throw new AggregateError(
						[toError(error), cleanupError],
						"Prepared session persistence and temporary-file cleanup both failed.",
					);
				throw toError(error);
			}
		}
		stage.flushed = true;
	}

	/** Build context from an unpublished successor without reading active manager state. @internal */
	buildPreparedNewSessionContext(prepared: PreparedNewSession): SessionContext {
		const stage = this.#getPreparedNewSessionStage(prepared);
		return buildSessionContext(
			stage.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session"),
			undefined,
			undefined,
			stage.sessionId,
		);
	}

	#freezePreparedNewSessionIdentity(stage: PreparedNewSessionState): void {
		// Prevent identity ABA: callers must not rebind staged sessionId/file after prepare.
		Object.defineProperty(stage, "sessionId", {
			value: stage.sessionId,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		Object.defineProperty(stage, "sessionFile", {
			value: stage.sessionFile,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		Object.defineProperty(stage, "artifactsDir", {
			value: stage.artifactsDir,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		Object.defineProperty(stage, "managedLegacyLocalMigrationSource", {
			value: stage.managedLegacyLocalMigrationSource,
			writable: false,
			enumerable: true,
			configurable: false,
		});
	}

	#getPreparedNewSessionStage(prepared: PreparedNewSession): PreparedNewSessionState {
		const stage = prepared as PreparedNewSessionState;
		if (!this.#preparedNewSessions.has(stage) || stage.committed || stage.discarded)
			throw new Error("Prepared session is no longer available.");
		return stage;
	}

	#preparedNewSessionLeafId(stage: PreparedNewSessionState): string | null {
		for (let index = stage.fileEntries.length - 1; index >= 0; index--) {
			const entry = stage.fileEntries[index];
			if (entry.type !== "session") return entry.id;
		}
		return null;
	}

	#nextPreparedNewSessionEntryId(stage: PreparedNewSessionState): string {
		const ids = new Map<string, SessionEntry>();
		for (const entry of stage.fileEntries) {
			if (entry.type !== "session") ids.set(entry.id, entry);
		}
		return generateId(ids);
	}

	/** Prepare a forked successor without publishing it through public manager state. @internal */
	async prepareFork(): Promise<PreparedNewSession | undefined> {
		await this.#retryPreparedNewSessionCleanups();
		if (!this.persist || !this.#sessionFile) return undefined;
		await this.#closePersistWriter();
		this.#ensureFullHotView();
		const sourceFile = this.#sessionFile;
		const sourceId = this.#sessionId;
		const timestamp = new Date().toISOString();
		const sessionId = createSessionId();
		const sessionFile = path.join(this.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			timestamp,
			cwd: this.cwd,
			parentSession: sourceId,
		};
		const entries: FileEntry[] = [
			header,
			...materializeResidentEntriesForReadSync(this.#fileEntries, this.#residentBlobStores()).filter(
				(entry): entry is SessionEntry => entry.type !== "session",
			),
		];
		const stage: PreparedNewSessionState = {
			sessionId,
			sessionFile,
			artifactsDir: sessionFile.slice(0, -6),
			managedLegacyLocalMigrationSource: this.#managedLegacyLocalMigrationSourceFor(sessionFile),
			header,
			fileEntries: entries,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			flushed: true,
			committed: false,
			discarded: false,
		};
		this.#preparedNewSessions.add(stage);
		this.#freezePreparedNewSessionIdentity(stage);
		try {
			await this.copyArtifactsForFork(sourceFile, sessionFile);
			const content = `${entries.map(entry => JSON.stringify(prepareEntryForPersistenceSync(entry, this.#blobStore))).join("\n")}\n`;
			if (this.destination.kind === "managed") {
				this.#managedTranscriptStore(sessionFile).publishNoReplaceSync(
					path.basename(sessionFile),
					Buffer.from(content, "utf8"),
				);
			} else {
				this.#storage.writeTextSync(sessionFile, content);
			}
		} catch (error) {
			try {
				await this.discardPreparedNewSession(stage);
			} catch (cleanupError) {
				throw new AggregateError(
					[toError(error), toError(cleanupError)],
					"Fork preparation and staged session cleanup both failed.",
				);
			}
			throw toError(error);
		}
		return stage;
	}

	/** Prepare a path-only branch successor without publishing it through public manager state. @internal */
	async prepareBranchedSession(leafId: string): Promise<PreparedNewSession> {
		this.#assertRecoveryHydrationWritable();
		await this.#retryPreparedNewSessionCleanups();
		const branchPath = this.#getCanonicalBranchClones(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);
		await this.#closePersistWriter();
		const timestamp = new Date().toISOString();
		const sessionId = createSessionId();
		const sessionFile = this.persist
			? path.join(this.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
			: undefined;
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? this.#sessionFile : undefined,
		};
		const pathWithoutLabels = branchPath.filter(entry => entry.type !== "label");
		const pathEntryIds = new Set(pathWithoutLabels.map(entry => entry.id));
		const labelEntries: LabelEntry[] = [];
		let labelParentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id ?? null;
		for (const [targetId, label] of this.#labelsById) {
			if (!pathEntryIds.has(targetId)) continue;
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId({ has: id => pathEntryIds.has(id) }),
				parentId: labelParentId,
				timestamp: new Date().toISOString(),
				targetId,
				label,
			};
			pathEntryIds.add(labelEntry.id);
			labelEntries.push(labelEntry);
			labelParentId = labelEntry.id;
		}
		const entries: FileEntry[] = [
			header,
			...materializeResidentEntriesForReadSync(pathWithoutLabels, this.#residentBlobStores()),
			...labelEntries,
		];
		const stage: PreparedNewSessionState = {
			sessionId,
			sessionFile,
			artifactsDir: sessionFile ? sessionFile.slice(0, -6) : null,
			managedLegacyLocalMigrationSource: this.#managedLegacyLocalMigrationSourceFor(sessionFile),
			header,
			fileEntries: entries,
			sessionName: undefined,
			titleSource: undefined,
			flushed: this.persist,
			committed: false,
			discarded: false,
		};
		this.#preparedNewSessions.add(stage);
		this.#freezePreparedNewSessionIdentity(stage);
		try {
			if (sessionFile) {
				const content = `${entries.map(entry => JSON.stringify(prepareEntryForPersistenceSync(entry, this.#blobStore))).join("\n")}\n`;
				if (this.destination.kind === "managed") {
					this.#managedTranscriptStore(sessionFile).publishNoReplaceSync(
						path.basename(sessionFile),
						Buffer.from(content, "utf8"),
					);
				} else {
					this.#storage.writeTextSync(sessionFile, content);
				}
			}
			return stage;
		} catch (error) {
			try {
				await this.discardPreparedNewSession(stage);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Branch preparation and staged session cleanup both failed.",
				);
			}
			throw error;
		}
	}

	/** Publish a prepared successor synchronously after all readiness awaits succeed. @internal */
	commitPreparedNewSession(prepared: PreparedNewSession): void {
		this.#assertRecoveryHydrationWritable();
		const stage = prepared as PreparedNewSessionState;
		if (!this.#preparedNewSessions.has(stage) || stage.committed || stage.discarded) {
			throw new Error("Prepared session is no longer available.");
		}
		this.#preparePreparedNewSessionForCommit(stage);
		const residentFileEntries = stage.residentFileEntries;
		const residentTextBlobStore = stage.residentTextBlobStore;
		const index = stage.index;
		if (!residentFileEntries || !residentTextBlobStore || !index)
			throw new Error("Prepared session adoption is incomplete.");
		const transition = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: stage.sessionId, sessionFile: stage.sessionFile ?? "" },
				primary: {
					mode: "materialize",
					sourceEntries: stage.fileEntries,
					sourceStores: { textStore: residentTextBlobStore, imageStore: this.#residentImageBlobStore },
				},
				fallback: {
					mode: "adopt-staged",
					stagedEntries: residentFileEntries,
					stagedStore: residentTextBlobStore,
					stagedIndex: index,
				},
			},
			"install-staged",
		);
		try {
			if (stage.sessionFile) writeTerminalBreadcrumb(this.cwd, stage.sessionFile);
		} catch (error) {
			transition.dispose();
			throw error;
		}
		const predecessorRuntime = this.#sidecarRuntime;
		if (predecessorRuntime) this.#clearColdRuntimeAfterHydration(predecessorRuntime);
		this.#sidecarRuntime = undefined;
		this.#releaseManagedSidecarCache();
		this.#boundedReadStorageProxy = undefined;
		this.#clearBoundedManagedSource();
		if (!this.#lifecycleIdAdopted && stage.sessionId === lifecyclePreallocatedSessionId())
			this.#lifecycleIdAdopted = true;
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		this.#sessionId = stage.sessionId;
		this.#sessionName = stage.sessionName;
		this.#titleSource = stage.titleSource;
		this.#sessionFile = stage.sessionFile;
		this.#flushed = stage.flushed;
		this.#needsFullRewriteOnNextPersist = false;
		this.#ensuredOnDisk = stage.flushed;
		this.#readOnlyResume = false;
		this.#resumedDraftConsumed = false;

		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#commitResidentTextStoreTransition(transition);
		if (stage.flushed) this.#adoptManagedPersistIdentity(stage.sessionFile);
		this.#retireEphemeralArtifacts();
		stage.committed = true;
		this.#preparedNewSessions.delete(stage);
	}

	/** Exact-discard only an uncommitted successor prepared by this manager. @internal */
	async discardPreparedNewSession(prepared: PreparedNewSession): Promise<void> {
		const stage = prepared as PreparedNewSessionState;
		if (!this.#preparedNewSessions.has(stage) || stage.committed || stage.discarded) return;
		const persistenceCleanupError = await this.#cleanupPreparedNewSessionPersistence(stage);
		let sessionCleanupError: Error | undefined;
		if (stage.sessionFile) {
			try {
				await this.discardUncommittedSession(stage.sessionFile);
			} catch (error) {
				sessionCleanupError = toError(error);
			}
		}
		if (persistenceCleanupError || sessionCleanupError) {
			const errors = [persistenceCleanupError, sessionCleanupError].filter(
				(error): error is Error => error !== undefined,
			);
			throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Prepared session cleanup failed.");
		}
		this.#preparedNewSessions.delete(stage);
		stage.discarded = true;
		if (this.#preparedNewSessions.size === 0 && this.#fileEntries.length === 0) this.#releaseOwnedManagedAuthority();
	}

	async #retryPreparedNewSessionCleanups(): Promise<void> {
		if (this.#preparedNewSessionCleanupInProgress) return;
		this.#preparedNewSessionCleanupInProgress = true;
		try {
			const errors: Error[] = [];
			for (const stage of [...this.#preparedNewSessions]) {
				if (stage.committed || stage.discarded) continue;
				try {
					await this.discardPreparedNewSession(stage);
				} catch (error) {
					errors.push(toError(error));
				}
			}
			if (errors.length > 0)
				throw errors.length === 1
					? errors[0]
					: new AggregateError(errors, "Prepared session cleanup retry failed.");
		} finally {
			this.#preparedNewSessionCleanupInProgress = false;
		}
	}

	async #cleanupPreparedNewSessionPersistence(stage: PreparedNewSessionState): Promise<Error | undefined> {
		const errors: Error[] = [];
		if (stage.persistenceWriter) {
			try {
				await stage.persistenceWriter.close();
				stage.persistenceWriter = undefined;
			} catch (error) {
				errors.push(toError(error));
			}
		}
		if (stage.persistenceTempPath && !stage.persistenceWriter) {
			try {
				await this.#storage.unlink(stage.persistenceTempPath);
				stage.persistenceTempPath = undefined;
			} catch (error) {
				if (!isEnoent(error)) errors.push(toError(error));
				else stage.persistenceTempPath = undefined;
			}
		}
		return errors.length === 0
			? undefined
			: errors.length === 1
				? errors[0]
				: new AggregateError(errors, "Prepared session temporary-file cleanup failed.");
	}

	/** Tombstone and exact-delete managed transcripts, detaching the active transcript first. */
	async dropSession(sessionPath: string): Promise<void> {
		const requestedPath = path.resolve(sessionPath);
		if (this.#sessionFile && path.resolve(this.#sessionFile) === requestedPath) {
			await this.newSession();
		}
		await this.#closePersistWriter();
		const managedRoot = resolveManagedSessionRoot(this.sessionDir, this.cwd);
		try {
			if (managedRoot) {
				if (!pathIsWithin(managedRoot, requestedPath))
					throw new Error("Managed session deletion is limited to this manager's configured session root.");
				const resolved = resolveManagedScope({
					cwd: this.cwd,
					agentDir: path.resolve(managedRoot, ".."),
					sessionsRoot: managedRoot,
				});
				if (resolved.kind !== "resolved")
					throw new Error("Managed session storage could not be resolved for this manager.");
				const listing = listManagedCandidates(resolved.scope);
				if (listing.kind !== "complete")
					throw new Error("Managed session storage could not be verified; refusing deletion.");
				const candidate = listing.owned.find(candidate => path.resolve(candidate.path) === requestedPath);
				if (!candidate) throw new Error("Managed session deletion requires exact logical authorization.");
				const deleted = await deleteManagedSessionCandidate(resolved.scope, candidate);
				if (deleted.kind === "error" && deleted.code === "migration_busy") throw new SessionMigrationBusyError();
				if (deleted.kind !== "deleted" && deleted.kind !== "already_deleted")
					throw new Error(`Could not delete managed session: ${deleted.message}`);
			} else {
				await this.#storage.deleteSessionWithArtifacts(sessionPath);
			}
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
	}

	/**
	 * Exact-delete a session transcript and its artifacts by path WITHOUT requiring
	 * managed logical authorization. This is only for discarding an UNCOMMITTED
	 * successor that a transaction (e.g. handoff) created via `newSession()` but
	 * never durably authorized — such a session has no managed candidate listing
	 * yet, so `dropSession` would refuse it and leak its artifact root. Bounded to
	 * this manager's configured session root and refuses to touch the active session;
	 * tolerates missing files.
	 */
	async discardUncommittedSession(sessionPath: string): Promise<void> {
		// Close the writer FIRST so the canonical checks and the delete run with no
		// intervening await, eliminating the check/use window in which a parent
		// directory could be swapped for a symlink between authorization and deletion.
		await this.#closePersistWriter();
		// Canonicalize the candidate (and the active file / configured dir) through
		// their nearest existing ancestor so symlink/reparse components cannot alias
		// the active session or escape the configured session directory, even when
		// the successor transcript itself does not yet exist.
		const canonicalCandidate = canonicalizeThroughExistingAncestor(path.resolve(sessionPath));
		if (this.#sessionFile) {
			const canonicalActive = canonicalizeThroughExistingAncestor(path.resolve(this.#sessionFile));
			if (canonicalActive === canonicalCandidate) {
				throw new Error("Refusing to discard the active session as uncommitted.");
			}
		}
		// Least-authority containment: only within this manager's configured session
		// directory (canonical), where newSession() allocates the successor. The
		// broader managed root (parent of sessionDir) is deliberately NOT accepted.
		const canonicalSessionDir = canonicalizeThroughExistingAncestor(path.resolve(this.sessionDir));
		if (!pathIsWithin(canonicalSessionDir, canonicalCandidate)) {
			throw new Error("Uncommitted session discard is limited to this manager's configured session directory.");
		}
		try {
			if (this.destination.kind === "managed") {
				const store = this.#managedTranscriptStore(canonicalCandidate);
				const transcriptName = path.basename(canonicalCandidate);
				const artifactName = path.basename(canonicalCandidate.slice(0, -6));
				const transcript = store.readExpected(transcriptName);
				let artifacts: native.NativeDirectoryTreeSnapshot | undefined;
				try {
					artifacts = store.captureTree(artifactName);
				} catch (error) {
					if (!(error instanceof Error) || error.message !== "not_found") throw error;
				}
				if (artifacts) store.removeTreeExpected(artifactName, artifacts);
				if (transcript) store.removeExpected(transcriptName, transcript);
				return;
			}
			await this.#storage.deleteSessionWithArtifacts(canonicalCandidate);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
	}

	/**
	 * Fork the current session, creating a new session file with the same entries.
	 * Returns both the old and new session file paths for artifact copying.
	 * @returns { oldSessionFile, newSessionFile } or undefined if not persisting
	 */
	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.persist || !this.#sessionFile) return undefined;
		this.#ensureFullHotView();

		const oldSessionFile = this.#sessionFile;
		const oldSessionId = this.#sessionId;
		const materializedEntries = materializeResidentEntriesForReadSync(this.#fileEntries, this.#residentBlobStores());
		const timestamp = new Date().toISOString();
		const newSessionId = createSessionId();
		const newSessionFile = path.join(
			this.getSessionDir(),
			`${timestamp.replace(/[:.]/g, "-")}_${newSessionId}.jsonl`,
		);
		const oldHeader = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			title: oldHeader?.title ?? this.#sessionName,
			titleSource: oldHeader?.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.cwd,
			parentSession: oldSessionId,
		};
		const entries: FileEntry[] = [
			newHeader,
			...materializedEntries.filter((entry): entry is SessionEntry => entry.type !== "session"),
		];
		const forkSnapshotHook = SessionManagerTestHooks.afterForkSnapshot;
		if (forkSnapshotHook) await forkSnapshotHook();

		await this.#closePersistWriter();
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		let forkArtifactPublication: ForkArtifactPublication | undefined;
		let forkTranscriptPublication: ForkTranscriptPublication | undefined;
		let transition: PreparedResidentStoreTransition | undefined;
		try {
			forkArtifactPublication = await this.copyArtifactsForFork(oldSessionFile, newSessionFile);
			// Publish each already-materialized entry through the staged writer without
			// joining the transcript into another whole-file string/Buffer. Retired cold
			// history was rehydrated above and is therefore not omitted.
			const publishedSha256 = publishForkTranscriptStreaming(
				this.#storage,
				newSessionFile,
				this.destination,
				entries,
				entry => prepareEntryForPersistenceSync(entry, this.#blobStore),
			);
			if (this.destination.kind === "managed") {
				const store = this.#managedTranscriptStore(newSessionFile);
				const relativePath = path.basename(newSessionFile);
				const snapshot = store.readExpected(relativePath);
				if (!snapshot) throw new Error("managed_fork_transcript_publish_missing");
				forkTranscriptPublication = {
					kind: "managed",
					store,
					relativePath,
					sessionFile: newSessionFile,
					publishedSha256: snapshot.identity.sha256,
				};
			} else if (this.#storage instanceof FileSessionStorage) {
				forkTranscriptPublication = {
					kind: "explicit-file",
					sessionFile: newSessionFile,
					publishedSha256,
				};
			} else {
				forkTranscriptPublication = {
					kind: "explicit-storage",
					sessionFile: newSessionFile,
					publishedSha256,
				};
			}
			await SessionManagerTestHooks.afterForkTranscriptPublished?.();
			if (forkArtifactPublication?.kind === "managed") {
				forkArtifactPublication.store.verifyRootSecurity();
				forkArtifactPublication.store.assertBound();
				const adoptedSnapshot = forkArtifactPublication.store.fsyncTree();
				if (!retainedTreeSnapshotEquals(adoptedSnapshot, forkArtifactPublication.snapshot))
					throw new Error("artifact_destination_changed_during_transcript_publication");
			} else if (forkArtifactPublication) {
				const terminalArtifacts = nativeSessionManager().snapshotDirectoryTree(
					forkArtifactPublication.artifactsDir,
				);
				if (
					!terminalArtifacts.ok ||
					!terminalArtifacts.snapshot ||
					!retainedTreeSnapshotEquals(terminalArtifacts.snapshot, forkArtifactPublication.snapshot)
				) {
					throw new Error("artifact_destination_changed_during_transcript_publication");
				}
			}

			if (forkTranscriptPublication?.kind === "managed") {
				const terminalTranscript = forkTranscriptPublication.store.readExpected(
					forkTranscriptPublication.relativePath,
				);
				if (
					!terminalTranscript ||
					terminalTranscript.identity.sha256 !== forkTranscriptPublication.publishedSha256
				) {
					throw new Error("managed_fork_transcript_changed");
				}
			}
			transition = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: newSessionId, sessionFile: newSessionFile },
					primary: {
						mode: "materialize",
						sourceEntries: entries,
						sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
					},
				},
				"retain-and-throw",
			);
		} catch (error) {
			transition?.dispose();
			const failure = toError(error);
			const cleanupErrors: Error[] = [];
			if (forkTranscriptPublication) {
				try {
					await this.#cleanupForkTranscriptPublication(forkTranscriptPublication);
				} catch (cleanupError) {
					cleanupErrors.push(toError(cleanupError));
				}
			}
			if (forkArtifactPublication) {
				try {
					this.#cleanupForkArtifactPublication(forkArtifactPublication);
				} catch (cleanupError) {
					cleanupErrors.push(toError(cleanupError));
				}
			}
			// A POSIX quarantine (`cleanup_pending` with a retained recovery path) IS a
			// successful cleanup: the tree was detached to `<name>.removing` and no live
			// artifact survives. Only an independently real cleanup failure may supersede
			// the primary error; otherwise the original failure must reach the caller.
			const realCleanupErrors = cleanupErrors.filter(cleanupError => !isAuthorizedPendingCleanup(cleanupError));
			if (realCleanupErrors.length > 0) {
				throw new Error(`Failed to clean up fork publication: ${realCleanupErrors[0]!.message}`, {
					cause: failure,
				});
			}
			throw failure;
		}
		this.#sessionId = newSessionId;
		this.#sessionFile = newSessionFile;
		this.#sessionName = newHeader.title;
		this.#titleSource = newHeader.titleSource;
		this.#flushed = true;
		this.#needsFullRewriteOnNextPersist = false;
		this.#ensuredOnDisk = true;
		this.#commitResidentTextStoreTransition(transition);
		this.#adoptManagedPersistIdentity(newSessionFile);
		return { oldSessionFile, newSessionFile };
	}

	async copyArtifactsForFork(
		oldSessionFile: string,
		newSessionFile: string,
	): Promise<ForkArtifactPublication | undefined> {
		const sourceDir = oldSessionFile.slice(0, -6);
		const finalDestinationDir = newSessionFile.slice(0, -6);
		if (this.destination.kind !== "managed") {
			let sourceSnapshot: native.NativeDirectoryTreeSnapshot;
			try {
				const sourceStat = fs.lstatSync(sourceDir);
				if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("unsafe_artifacts");
				const captured = nativeSessionManager().snapshotDirectoryTree(sourceDir);
				if (!captured.ok || !captured.snapshot) throw new Error(captured.code ?? "unsafe_artifacts");
				sourceSnapshot = captured.snapshot;
			} catch (error) {
				if (isEnoent(error)) return;
				throw error;
			}
			try {
				fs.lstatSync(finalDestinationDir);
				throw new Error("destination_conflict");
			} catch (error) {
				if (error instanceof Error && error.message === "destination_conflict") throw error;
				if (!isEnoent(error)) throw error;
			}
			const expectedManifest = pruneResidentCacheEntries(sourceSnapshot);
			const parentDir = path.dirname(finalDestinationDir);
			const stagingDir = path.join(
				parentDir,
				`.${path.basename(finalDestinationDir)}.${crypto.randomUUID()}.fork-staging`,
			);
			// Establish deletion authority BEFORE any content exists: we create this root
			// ourselves under an unguessable name and capture its identity while empty.
			// Only a root whose identity still matches this capture may ever be removed.
			fs.mkdirSync(stagingDir, { mode: 0o700 });
			const ownedStaging = nativeSessionManager().snapshotDirectoryTree(stagingDir);
			if (!ownedStaging.ok || !ownedStaging.snapshot) {
				throw new Error(ownedStaging.code ?? "artifact_staging_snapshot_failed");
			}
			const ownedStagingRoot = ownedStaging.snapshot;
			let published = false;
			try {
				await fs.promises.cp(sourceDir, stagingDir, {
					recursive: true,
					filter: source => {
						const relativePath = path.relative(sourceDir, source);
						return (
							relativePath !== "resident-cache" &&
							!relativePath.startsWith(`resident-cache${path.sep}`) &&
							!isDerivedSessionMemoryFile(relativePath)
						);
					},
				});
				const capturedStaging = nativeSessionManager().snapshotDirectoryTree(stagingDir);
				if (!capturedStaging.ok || !capturedStaging.snapshot)
					throw new Error(capturedStaging.code ?? "artifact_destination_snapshot_failed");
				const stagedSnapshot = capturedStaging.snapshot;
				if (
					stagedSnapshot.rootDev !== ownedStagingRoot.rootDev ||
					stagedSnapshot.rootIno !== ownedStagingRoot.rootIno
				)
					throw new Error("artifact_staging_identity_changed");
				const terminalSource = nativeSessionManager().snapshotDirectoryTree(sourceDir);
				if (!terminalSource.ok || !terminalSource.snapshot)
					throw new Error(terminalSource.code ?? "artifact_source_changed");
				if (JSON.stringify(terminalSource.snapshot) !== JSON.stringify(sourceSnapshot))
					throw new Error("artifact_source_changed");
				const comparable = (tree: native.NativeDirectoryTreeSnapshot) =>
					tree.entries.map(entry => ({
						relativePath: entry.relativePath,
						kind: entry.kind,
						size: entry.kind === "file" ? entry.size : undefined,
						sha256: entry.sha256,
					}));
				if (JSON.stringify(comparable(stagedSnapshot)) !== JSON.stringify(comparable(expectedManifest)))
					throw new Error("artifact_destination_terminal_mismatch");
				// No-replace publication: a directory that appeared at the final name after the
				// preflight is never replaced and never touched.
				const outcome = classifyNativePublishOutcome(
					nativeSessionManager().renameNoReplacePath(stagingDir, finalDestinationDir),
				);
				if (!outcome.ok) {
					if (outcome.reason === "destination_exists") throw new Error("destination_conflict");
					throw new Error(outcome.code ?? "artifact_destination_publish_failed");
				}
				published = true;
				const terminal = nativeSessionManager().snapshotDirectoryTree(finalDestinationDir);
				if (
					!terminal.ok ||
					!terminal.snapshot ||
					!retainedTreeSnapshotEqualsAfterRename(terminal.snapshot, stagedSnapshot)
				)
					throw new Error("artifact_destination_terminal_mismatch");
				return { kind: "explicit", artifactsDir: finalDestinationDir, snapshot: terminal.snapshot };
			} catch (error) {
				if (!published) {
					const cleanupError = removeOwnedForkStaging(stagingDir, ownedStagingRoot);
					if (cleanupError) {
						throw new Error(`Failed to clean up explicit fork artifacts: ${cleanupError}`, {
							cause: toError(error),
						});
					}
				}
				throw error;
			}
		}

		const sourceName = path.basename(sourceDir);
		const destinationName = path.basename(finalDestinationDir);
		const stagingName = `.${destinationName}.${crypto.randomUUID()}.fork-staging`;
		const parentStore = this.#managedTranscriptStore(oldSessionFile);
		let sourceSnapshot: native.NativeDirectoryTreeSnapshot;
		try {
			sourceSnapshot = parentStore.captureTree(sourceName);
		} catch (error) {
			if (error instanceof Error && error.message === "not_found") return;
			throw error;
		}
		const expectedManifest = pruneResidentCacheEntries(sourceSnapshot);
		let stagingSnapshot: native.NativeDirectoryTreeSnapshot | undefined;
		let publishedSnapshot: native.NativeDirectoryTreeSnapshot | undefined;
		try {
			parentStore.ensureDirectory(stagingName);
			stagingSnapshot = parentStore.captureTree(stagingName);
			for (const entry of expectedManifest.entries) {
				if (entry.relativePath === "") continue;
				const destinationRelativePath = path.posix.join(stagingName, entry.relativePath);
				if (entry.kind === "directory") {
					parentStore.ensureDirectory(destinationRelativePath);
				} else if (entry.kind === "file") {
					const sourceFile = parentStore.readExpected(path.posix.join(sourceName, entry.relativePath));
					if (
						!sourceFile ||
						sourceFile.identity.dev.toString() !== entry.dev ||
						sourceFile.identity.ino.toString() !== entry.ino ||
						sourceFile.identity.size.toString() !== entry.size ||
						sourceFile.identity.mtimeNs.toString() !== entry.mtimeNs ||
						crypto.createHash("sha256").update(sourceFile.bytes).digest("hex") !== entry.sha256
					) {
						throw new Error("artifact_source_changed");
					}
					await parentStore.publishNoReplace(destinationRelativePath, sourceFile.bytes);
				} else {
					throw new Error("unsafe_artifacts");
				}
				stagingSnapshot = parentStore.captureTree(stagingName);
			}
			if (JSON.stringify(parentStore.captureTree(sourceName)) !== JSON.stringify(sourceSnapshot))
				throw new Error("artifact_source_changed");
			publishedSnapshot = parentStore.moveTreeNoReplace(stagingName, destinationName, stagingSnapshot);
			const comparable = (tree: native.NativeDirectoryTreeSnapshot) =>
				tree.entries.map(entry => ({
					relativePath: entry.relativePath,
					kind: entry.kind,
					size: entry.kind === "file" ? entry.size : undefined,
					sha256: entry.sha256,
				}));
			if (JSON.stringify(comparable(publishedSnapshot)) !== JSON.stringify(comparable(expectedManifest)))
				throw new Error("artifact_destination_terminal_mismatch");
			const publishedStore = parentStore.deriveSubtree(destinationName);
			publishedStore.verifyRootSecurity();
			const retainedPublishedSnapshot = publishedStore.captureTree("");
			if (!retainedTreeSnapshotEqualsAfterRename(retainedPublishedSnapshot, publishedSnapshot))
				throw new Error("artifact_destination_retained_identity_changed");
			publishedSnapshot = retainedPublishedSnapshot;
			return {
				kind: "managed",
				snapshot: publishedSnapshot,
				store: publishedStore,
				cleanupStore: parentStore,
				cleanupRelativePath: destinationName,
			};
		} catch (error) {
			try {
				if (stagingSnapshot && mayCleanManagedTreeStaging(error))
					parentStore.removeTreeExpected(stagingName, stagingSnapshot);
			} catch (cleanupError) {
				const cleanupMessage = toError(cleanupError).message;
				if (cleanupMessage !== "cleanup_pending" && cleanupMessage !== "not_found") {
					throw new Error(`Failed to clean up managed fork artifacts: ${cleanupMessage}`, {
						cause: toError(error),
					});
				}
			}
			throw error;
		}
	}

	async #assertCwdTargetIdentity(
		resolvedCwd: string,
		options: {
			expectedIdentity?: { dev: bigint; ino: bigint };
			targetHandle?: { stat: (opts: { bigint: true }) => Promise<fs.BigIntStats> };
		},
	): Promise<void> {
		let opened: fs.BigIntStats | undefined;
		if (options.targetHandle) {
			opened = await options.targetHandle.stat({ bigint: true });
			if (!opened.isDirectory()) {
				throw new Error(
					`Refusing to move through a replaced path: ${resolvedCwd} is no longer the validated directory.`,
				);
			}
		}
		let observed: fs.BigIntStats;
		try {
			observed = await fs.promises.lstat(resolvedCwd, { bigint: true });
		} catch {
			throw new Error(`Directory identity unavailable at state-changing boundary: ${resolvedCwd}`);
		}
		if (observed.isSymbolicLink() || !observed.isDirectory()) {
			throw new Error(
				`Refusing to move through a replaced path: ${resolvedCwd} is no longer the validated directory.`,
			);
		}
		if (opened && (observed.dev !== opened.dev || observed.ino !== opened.ino)) {
			throw new Error(`Refusing to move: target identity changed at ${resolvedCwd}.`);
		}
		const expected = options.expectedIdentity;
		const pinned = opened ?? observed;
		if (expected && (pinned.dev !== expected.dev || pinned.ino !== expected.ino)) {
			throw new Error(`Refusing to move: target identity changed at ${resolvedCwd}.`);
		}
	}

	/**
	 * Serialize every cwd transition (model, TUI, SDK/ACP). Re-entry is allowed
	 * only for the async context that already owns the lock — unrelated callers
	 * queue on the tail instead of skipping it.
	 */
	async runExclusiveCwdTransition<T>(fn: () => Promise<T>): Promise<T> {
		const owner = this.#cwdTransitionOwner;
		if (owner !== undefined && cwdTransitionAls.getStore() === owner) {
			return fn();
		}
		const previous = this.#cwdTransitionTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#cwdTransitionTail = previous.then(
			() => promise,
			() => promise,
		);
		// Announce the writer BEFORE awaiting the queue so readers arriving during
		// the wait queue behind it rather than starving it indefinitely.
		this.#cwdWriterPending += 1;
		const token = Symbol("cwd-transition");
		try {
			await previous.catch(() => {});
			// A reader that entered before this writer was announced still holds the
			// old cwd; the transition may not commit until every such lease is
			// released, otherwise an in-flight tool resolves paths across the move.
			while (this.#cwdReaderCount > 0) await this.#cwdReadersIdle;
			this.#cwdTransitionOwner = token;
			return await cwdTransitionAls.run(token, fn);
		} finally {
			if (this.#cwdTransitionOwner === token) this.#cwdTransitionOwner = undefined;
			this.#cwdWriterPending -= 1;
			resolve();
		}
	}

	/**
	 * Run `fn` under a shared read lease on `cwd`.
	 *
	 * Tools that resolve relative paths against the session cwd must hold this
	 * lease across their WHOLE execution, not merely re-check a generation before
	 * they start: the check-then-yield shape lets a move commit inside the tool's
	 * first `await`, so a command admitted for root A would execute in root B.
	 * Writers wait for outstanding leases to drain, so the cwd observed at lease
	 * acquisition stays authoritative until the lease is released.
	 */
	async runWithCwdReadLease<T>(fn: () => Promise<T>): Promise<T> {
		const activeReadLease = cwdReadLeaseAls.getStore();
		// Nested tool dispatch (for example eval -> tool bridge) inherits the
		// outer lease's async context. Re-entering that lease must not wait behind
		// a writer that is already queued: the writer is waiting for the outer
		// lease, and waiting here would deadlock the session permanently.
		if (activeReadLease?.active && activeReadLease.owner === this.#cwdReadLeaseOwner) return fn();
		const owner = this.#cwdTransitionOwner;
		// The writer's own async context already holds exclusive access; taking a
		// read lease there would wait on itself.
		if (owner !== undefined && cwdTransitionAls.getStore() === owner) return fn();
		while (this.#cwdWriterPending > 0) await this.#cwdTransitionTail.catch(() => {});
		if (this.#cwdReaderCount === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#cwdReadersIdle = promise;
			this.#cwdReadersDrained = resolve;
		}
		this.#cwdReaderCount += 1;
		const readLease: CwdReadLeaseContext = { active: true, owner: this.#cwdReadLeaseOwner };
		return cwdReadLeaseAls.run(readLease, async () => {
			try {
				return await fn();
			} finally {
				readLease.active = false;
				this.#cwdReaderCount -= 1;
				if (this.#cwdReaderCount === 0) {
					const drained = this.#cwdReadersDrained;
					this.#cwdReadersDrained = undefined;
					drained?.();
				}
			}
		});
	}

	/** Wait for any in-flight exclusive cwd transition to settle. */
	async joinCwdTransition(): Promise<void> {
		await this.#cwdTransitionTail;
	}
	getCwdGeneration(): number {
		return this.#cwdGeneration;
	}

	#ownsCwdTransition(): boolean {
		const owner = this.#cwdTransitionOwner;
		return owner !== undefined && cwdTransitionAls.getStore() === owner;
	}
	static async openNoFollowDirectory(dir: string): Promise<fs.promises.FileHandle> {
		return fs.promises.open(dir, CWD_NOFOLLOW_OPEN_FLAGS);
	}

	/**
	 * Owner of this process's cwd, or undefined when no session has claimed it.
	 *
	 * `process.chdir` and the caches keyed off it are process-global, so only one
	 * session may drive them. Ownership is an explicit claim rather than an
	 * inference from `process.cwd() === session.cwd`: two sessions launched at the
	 * same root both satisfy that comparison, and letting either one act on it
	 * lets a move in one session chdir the process under its sibling.
	 */
	static #processCwdOwner: WeakRef<SessionManager> | undefined;

	/**
	 * Claim process-cwd authority for `manager` when it is unowned or the prior
	 * owner has been collected. Returns whether `manager` holds the claim.
	 */
	static claimProcessCwdOwnership(manager: SessionManager): boolean {
		const current = SessionManager.#processCwdOwner?.deref();
		if (current === manager) return true;
		if (current !== undefined) return false;
		SessionManager.#processCwdOwner = new WeakRef(manager);
		return true;
	}

	static isProcessCwdOwner(manager: SessionManager): boolean {
		return SessionManager.#processCwdOwner?.deref() === manager;
	}

	static releaseProcessCwdOwnership(manager: SessionManager): void {
		if (SessionManager.#processCwdOwner?.deref() === manager) SessionManager.#processCwdOwner = undefined;
	}

	/**
	 * Verify that `process.cwd()` is the directory pinned by `expectedIdentity`.
	 *
	 * `process.chdir` resolves a NAME, so a path replaced after the last
	 * name-based comparison lands the process outside the validated directory —
	 * the exact confinement `move_session` exists to enforce. Node exposes no
	 * `fchdir`, so the handle cannot be the chdir authority directly; comparing
	 * the resulting cwd's identity to the pinned handle closes the same gap.
	 */
	static async assertProcessCwdIdentity(expectedIdentity: { dev: bigint; ino: bigint }): Promise<void> {
		const observed = await fs.promises.stat(process.cwd(), { bigint: true });
		if (observed.dev !== expectedIdentity.dev || observed.ino !== expectedIdentity.ino) {
			throw new Error(
				`Refusing to rescope: process cwd ${process.cwd()} is not the validated target directory (identity changed).`,
			);
		}
	}

	/**
	 * Move the session to a new working directory.
	 * Moves session files and artifacts on disk, updates all internal references,
	 * and rewrites the session header with the new cwd.
	 *
	 * All callers (model `move_session`, TUI `/move`, SDK/ACP `session.cwd.move`)
	 * share this exclusive transition so concurrent moves cannot interleave.
	 */
	async moveTo(
		newCwd: string,
		options?: {
			expectedIdentity?: { dev: bigint; ino: bigint };
			targetHandle?: { stat: (opts: { bigint: true }) => Promise<fs.BigIntStats> };
		},
	): Promise<void> {
		if (!this.#ownsCwdTransition()) {
			return this.runExclusiveCwdTransition(() => this.moveTo(newCwd, options));
		}
		const resolvedCwd = path.resolve(newCwd);
		if (options?.expectedIdentity || options?.targetHandle) {
			await this.#assertCwdTargetIdentity(resolvedCwd, options);
		}
		if (resolvedCwd === this.cwd) return;
		const previousCwd = this.cwd;
		const previousSessionDir = this.sessionDir;
		const previousSessionFile = this.#sessionFile;
		const previousDestination = this.destination;

		const nextDestination =
			this.#storage instanceof FileSessionStorage
				? managedDestination(
						resolvedCwd,
						this.#storage,
						this.destination.kind === "managed" ? this.destination.securityContext.profileAgentDir : undefined,
					)
				: this.destination;
		const newSessionDir = nextDestination.directory;
		let hadSessionFile = false;
		const managedMove = this.destination.kind === "managed" && nextDestination.kind === "managed";
		let managedSourceStore: ManagedSessionDescendantStore | undefined;
		let managedDestinationStore: ManagedSessionDescendantStore | undefined;
		let rollbackManagedMove: (() => Promise<void>) | undefined;
		let residentTransition: PreparedResidentStoreTransition | undefined;
		const hadPersistedSession = this.#ensuredOnDisk;

		if (this.persist && this.#sessionFile) {
			// Close the persist writer before moving files
			await this.#closePersistWriter();
			this.#persistChain = Promise.resolve();
			this.#persistError = undefined;
			this.#persistErrorReported = false;

			const oldSessionFile = this.#sessionFile;
			const newSessionFile = path.join(newSessionDir, path.basename(oldSessionFile));
			const oldArtifactDir = oldSessionFile.slice(0, -6); // strip .jsonl
			const newArtifactDir = newSessionFile.slice(0, -6);
			let managedTranscript!: ReturnType<ManagedSessionDescendantStore["readExpected"]>;
			let managedArtifacts: native.NativeDirectoryTreeSnapshot | undefined;
			let managedPublishedTranscript!: ReturnType<ManagedSessionDescendantStore["readExpected"]>;
			let managedPublishedArtifacts: native.NativeDirectoryTreeSnapshot | undefined;
			hadSessionFile = managedMove ? false : this.#storage.existsSync(oldSessionFile);
			let movedSessionFile = false;
			let movedArtifactDir = false;
			const materializedEntries = materializeResidentEntriesForReadSync(
				this.#fileEntries,
				this.#residentBlobStores(),
			);
			const transitionEntries: FileEntry[] = materializedEntries.map(entry =>
				entry.type === "session" ? { ...entry, cwd: resolvedCwd } : entry,
			);
			residentTransition = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: this.#sessionId, sessionFile: newSessionFile },
					primary: {
						mode: "materialize",
						sourceEntries: transitionEntries,
						sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
					},
				},
				"retain-and-throw",
			);
			const discardResidentTransitionAndThrow = (error: unknown): never => {
				residentTransition?.dispose();
				throw error;
			};
			const copyManagedTree = async (
				source: ManagedSessionDescendantStore,
				sourceRelative: string,
				destination: ManagedSessionDescendantStore,
				destinationRelative: string,
				snapshot: native.NativeDirectoryTreeSnapshot,
			): Promise<void> => {
				destination.ensureDirectory(destinationRelative);
				for (const entry of snapshot.entries) {
					if (entry.relativePath === "") continue;
					const target = path.posix.join(destinationRelative, entry.relativePath);
					if (entry.kind === "directory") destination.ensureDirectory(target);
					else {
						const file = source.readExpected(path.posix.join(sourceRelative, entry.relativePath));
						if (
							!file ||
							file.identity.dev.toString() !== entry.dev ||
							file.identity.ino.toString() !== entry.ino ||
							file.identity.size.toString() !== entry.size ||
							file.identity.mtimeNs.toString() !== entry.mtimeNs ||
							crypto.createHash("sha256").update(file.bytes).digest("hex") !== entry.sha256
						)
							throw new Error("artifact_source_changed");
						await destination.publishNoReplace(target, file.bytes);
					}
				}
				const imported = destination.captureTree(destinationRelative);
				const comparable = (tree: native.NativeDirectoryTreeSnapshot) =>
					tree.entries.map(entry => ({
						relativePath: entry.relativePath,
						kind: entry.kind,
						size: entry.size,
						sha256: entry.sha256,
					}));
				if (JSON.stringify(comparable(imported)) !== JSON.stringify(comparable(snapshot)))
					throw new Error("artifact_destination_mismatch");
				destination.fsyncTree();
			};
			try {
				if (managedMove) {
					if (previousDestination.kind !== "managed" || nextDestination.kind !== "managed")
						throw new Error("managed_move_destination_unavailable");
					managedSourceStore = this.#managedTranscriptStore(oldSessionFile);
					managedDestinationStore = managedStoreFromContext(nextDestination.securityContext, newSessionDir);
					rollbackManagedMove = async () => {
						if (!managedSourceStore || !managedDestinationStore)
							throw new Error("managed_move_authority_unavailable");
						if (managedArtifacts && managedPublishedArtifacts) {
							await copyManagedTree(
								managedDestinationStore,
								path.basename(newArtifactDir),
								managedSourceStore,
								path.basename(oldArtifactDir),
								managedPublishedArtifacts,
							);
						}
						if (managedTranscript && !managedSourceStore.readExpected(path.basename(oldSessionFile)))
							await managedSourceStore.publishNoReplace(path.basename(oldSessionFile), managedTranscript.bytes);
					};
					managedTranscript = managedSourceStore.readExpected(path.basename(oldSessionFile));
					hadSessionFile = managedTranscript !== null;
					if (managedTranscript) {
						await managedDestinationStore.publishNoReplace(
							path.basename(newSessionFile),
							managedTranscript.bytes,
						);
						managedPublishedTranscript = managedDestinationStore.readExpected(path.basename(newSessionFile));
						if (!managedPublishedTranscript) throw new Error("managed_transcript_publish_missing");
						movedSessionFile = true;
					}
					try {
						managedArtifacts = managedSourceStore.captureTree(path.basename(oldArtifactDir));
						await copyManagedTree(
							managedSourceStore,
							path.basename(oldArtifactDir),
							managedDestinationStore,
							path.basename(newArtifactDir),
							managedArtifacts,
						);
						managedPublishedArtifacts = managedDestinationStore.captureTree(path.basename(newArtifactDir));
						movedArtifactDir = true;
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "not_found") throw error;
					}
					if (managedPublishedTranscript) {
						const terminalTranscript = managedDestinationStore.readExpected(path.basename(newSessionFile));
						if (!managedFileSnapshotEquals(terminalTranscript, managedPublishedTranscript))
							throw new Error("managed_move_destination_transcript_changed");
					}
					if (managedPublishedArtifacts) {
						const terminalArtifacts = managedDestinationStore.captureTree(path.basename(newArtifactDir));
						if (!retainedTreeSnapshotEquals(terminalArtifacts, managedPublishedArtifacts))
							throw new Error("managed_move_destination_artifacts_changed");
					}
					if (managedArtifacts) {
						try {
							managedSourceStore.removeTreeExpected(path.basename(oldArtifactDir), managedArtifacts);
						} catch (cleanupError) {
							if (toError(cleanupError).message !== "cleanup_pending") throw cleanupError;
						}
					}
					if (managedTranscript) {
						try {
							managedSourceStore.removeExpected(path.basename(oldSessionFile), managedTranscript);
						} catch (cleanupError) {
							if (toError(cleanupError).message !== "cleanup_pending") throw cleanupError;
						}
					}
				} else {
					if (hadSessionFile && oldSessionFile !== newSessionFile) {
						await movePathAcrossDevicesSafe(oldSessionFile, newSessionFile);
						movedSessionFile = true;
					}
					try {
						const stat = await fs.promises.stat(oldArtifactDir);
						if (stat.isDirectory() && oldArtifactDir !== newArtifactDir) {
							await movePathAcrossDevicesSafe(oldArtifactDir, newArtifactDir);
							movedArtifactDir = true;
						}
					} catch (err) {
						if (!isEnoent(err)) throw err;
					}
				}
			} catch (err) {
				if (managedMove && managedDestinationStore) {
					try {
						if (managedArtifacts && !managedPublishedArtifacts) {
							try {
								managedPublishedArtifacts = managedDestinationStore.captureTree(path.basename(newArtifactDir));
							} catch (captureError) {
								if (!(captureError instanceof Error) || captureError.message !== "not_found")
									throw captureError;
							}
						}
						if (managedSourceStore && managedArtifacts && managedPublishedArtifacts) {
							let sourceArtifacts: native.NativeDirectoryTreeSnapshot | undefined;
							try {
								sourceArtifacts = managedSourceStore.captureTree(path.basename(oldArtifactDir));
							} catch (captureError) {
								if (!(captureError instanceof Error) || captureError.message !== "not_found")
									throw captureError;
							}
							if (!sourceArtifacts || !retainedTreeSnapshotEquals(sourceArtifacts, managedArtifacts)) {
								if (sourceArtifacts)
									managedSourceStore.removeTreeExpected(path.basename(oldArtifactDir), sourceArtifacts);
								await copyManagedTree(
									managedDestinationStore,
									path.basename(newArtifactDir),
									managedSourceStore,
									path.basename(oldArtifactDir),
									managedPublishedArtifacts,
								);
								const restored = managedSourceStore.captureTree(path.basename(oldArtifactDir));
								if (!retainedTreeSnapshotEqualsAfterRename(restored, managedArtifacts))
									throw new Error("managed_move_source_restore_mismatch");
							}
						}
						if (
							managedSourceStore &&
							managedTranscript &&
							!managedSourceStore.readExpected(path.basename(oldSessionFile))
						)
							await managedSourceStore.publishNoReplace(path.basename(oldSessionFile), managedTranscript.bytes);
					} catch (rollbackErr) {
						discardResidentTransitionAndThrow(
							new Error(`Failed to rollback managed move: ${toError(rollbackErr).message}`, {
								cause: toError(err),
							}),
						);
					}
				} else {
					if (movedArtifactDir) await movePathAcrossDevicesSafe(newArtifactDir, oldArtifactDir);
					if (movedSessionFile) await movePathAcrossDevicesSafe(newSessionFile, oldSessionFile);
				}
				discardResidentTransitionAndThrow(err);
			}
			this.#sessionFile = newSessionFile;
		}

		// Update cwd and sessionDir after physical publication succeeds. Metadata failures restore the source
		// authority but deliberately retain any destination publication evidence rather than deleting it.
		if (options?.expectedIdentity || options?.targetHandle) {
			await this.#assertCwdTargetIdentity(resolvedCwd, options);
		}
		this.#cwdGeneration += 1;
		this.cwd = resolvedCwd;
		this.sessionDir = newSessionDir;
		this.destination = nextDestination;
		this.#managedTranscriptStoreCache =
			managedMove && managedDestinationStore
				? { directory: path.resolve(newSessionDir), store: managedDestinationStore }
				: null;
		// A transcript is only guaranteed to exist at the destination when the old file was
		// actually present and moved (hadSessionFile). Absent/fresh/deleted-source sessions
		// have no destination transcript yet, so adopting a strict expected identity here
		// would invent identity for a nonexistent file; defer adoption until the first real
		// publication (#writeEntriesAtomicallySync / #appendManagedRecordsSync) instead.
		if (hadSessionFile) this.#adoptManagedPersistIdentity(this.#sessionFile);
		else this.#managedPersistExpectedIdentity = undefined;

		const hasAssistant = this.#fileEntries.some(e => e.type === "message" && e.message.role === "assistant");
		try {
			if (this.persist && this.#sessionFile && hadSessionFile) {
				await this.#appendHeaderPatch({ cwd: resolvedCwd });
				await this.#rewriteFile();
			} else if (this.persist && this.#sessionFile && (hasAssistant || (!hadSessionFile && hadPersistedSession))) {
				await this.#appendHeaderPatch({ cwd: resolvedCwd });
				await this.#rewriteFile();
			} else {
				await this.#appendHeaderPatch({ cwd: resolvedCwd });
			}
		} catch (error) {
			residentTransition?.dispose();
			await this.#closePersistWriter().catch(() => {});
			this.#persistChain = Promise.resolve();
			this.#persistError = undefined;
			this.#persistErrorReported = false;
			if (rollbackManagedMove) {
				try {
					await rollbackManagedMove();
				} catch (rollbackError) {
					if (toError(rollbackError).message !== "cleanup_pending") {
						throw new Error(`Failed to rollback managed move: ${toError(rollbackError).message}`, {
							cause: toError(error),
						});
					}
				}
				this.#sessionFile = previousSessionFile;
				this.cwd = previousCwd;
				this.sessionDir = previousSessionDir;
				this.destination = previousDestination;
				this.#managedTranscriptStoreCache =
					managedMove && managedSourceStore
						? { directory: path.resolve(previousSessionDir), store: managedSourceStore }
						: null;
				// Same rationale as the forward path: only adopt strict identity when the source
				// transcript actually existed (and was thus restorable) before the failed move.
				if (hadSessionFile) this.#adoptManagedPersistIdentity(previousSessionFile);
				else this.#managedPersistExpectedIdentity = undefined;
				const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
				if (header) applyHeaderPatch(header, { cwd: previousCwd });
				this.#headerExportRevision++;
				throw error;
			}
			// The destination has already been published. Retain it rather than moving it
			// back over the source after a metadata failure.
			this.#managedTranscriptStoreCache = null;
			this.#headerExportRevision++;
			throw error;
		}
		if (residentTransition) this.#commitResidentTextStoreTransition(residentTransition);

		// Update terminal breadcrumb only after the durable cwd transition succeeds.
		if (this.#sessionFile) {
			writeTerminalBreadcrumb(resolvedCwd, this.#sessionFile);
		}
	}

	/** Sync version for initial creation (no existing writer to close). */
	#newSessionSync(options?: NewSessionOptions, writeBreadcrumb = true): string | undefined {
		const fresh = this.#freshSessionState(options);
		const prepared = this.#prepareFreshSessionTransition(fresh, "memory-fallback");
		this.#applyFreshSessionMetadata(fresh);
		this.#commitResidentTextStoreTransition(prepared);
		this.#retireEphemeralArtifacts();
		if (writeBreadcrumb && fresh.sessionFile) writeTerminalBreadcrumb(this.cwd, fresh.sessionFile);
		return fresh.sessionFile;
	}

	#buildIndexForEntries(fileEntries: FileEntry[], sessionFile: string | undefined): PreparedSessionIndex {
		const byId = new Map<string, SessionEntry>();
		const labelsById = new Map<string, string>();
		let leafId: string | null = null;
		const usageStatistics: UsageStatistics = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const addUsage = (totals: ValidatedUsageTotals): boolean => {
			const next = {
				input: usageStatistics.input + totals.input,
				output: usageStatistics.output + totals.output,
				cacheRead: usageStatistics.cacheRead + totals.cacheRead,
				cacheWrite: usageStatistics.cacheWrite + totals.cacheWrite,
				premiumRequests: usageStatistics.premiumRequests + totals.premiumRequests,
				cost: usageStatistics.cost + totals.cost,
			};
			if (Object.values(next).some(value => !Number.isFinite(value))) return false;
			Object.assign(usageStatistics, next);
			return true;
		};
		const accumulateUsage = (entry: SessionEntry): boolean => {
			if (entry.type !== "message") return false;
			const usage =
				entry.message.role === "assistant"
					? entry.message.usage
					: entry.message.role === "toolResult" && entry.message.toolName === "task"
						? getTaskToolUsage(entry.message.details)
						: undefined;
			if (usage === undefined) return false;
			const totals = validatePersistedUsageTotals(usage);
			return !(totals && addUsage(totals));
		};
		let malformedUsageRecords = 0;
		const malformedUsageSample: string[] = [];
		for (const entry of fileEntries) {
			if (entry.type === "session") continue;
			if (entry.parentId !== null) {
				const canonicalParent = byId.get(entry.parentId);
				if (canonicalParent) entry.parentId = canonicalParent.id;
			}
			byId.set(entry.id, entry);
			leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) labelsById.set(entry.targetId, entry.label);
				else labelsById.delete(entry.targetId);
			}
			if (accumulateUsage(entry)) {
				malformedUsageRecords++;
				if (malformedUsageSample.length < MALFORMED_USAGE_SAMPLE_LIMIT) malformedUsageSample.push(entry.id);
			}
		}
		if (malformedUsageRecords > 0) {
			logger.warn("Skipped malformed or overflowing persisted usage records during resume aggregation", {
				sessionFile,
				count: malformedUsageRecords,
				sampleEntryIds: malformedUsageSample,
			});
		}
		return { byId, labelsById, leafId, usageStatistics };
	}

	/**
	 * Commit a validated record's totals only if every cumulative sum stays finite.
	 * Individually-finite buckets can still overflow to Infinity in aggregate (e.g. two
	 * Number.MAX_VALUE records), which would poison getUsageStatistics(); such a record is
	 * rejected atomically (no partial commit). Returns true when committed, false when
	 * rejected for cumulative overflow.
	 */
	#addValidatedUsage(totals: ValidatedUsageTotals): boolean {
		const next = {
			input: this.#usageStatistics.input + totals.input,
			output: this.#usageStatistics.output + totals.output,
			cacheRead: this.#usageStatistics.cacheRead + totals.cacheRead,
			cacheWrite: this.#usageStatistics.cacheWrite + totals.cacheWrite,
			premiumRequests: this.#usageStatistics.premiumRequests + totals.premiumRequests,
			cost: this.#usageStatistics.cost + totals.cost,
		};
		if (
			!Number.isFinite(next.input) ||
			!Number.isFinite(next.output) ||
			!Number.isFinite(next.cacheRead) ||
			!Number.isFinite(next.cacheWrite) ||
			!Number.isFinite(next.premiumRequests) ||
			!Number.isFinite(next.cost)
		)
			return false;
		this.#usageStatistics.input = next.input;
		this.#usageStatistics.output = next.output;
		this.#usageStatistics.cacheRead = next.cacheRead;
		this.#usageStatistics.cacheWrite = next.cacheWrite;
		this.#usageStatistics.premiumRequests = next.premiumRequests;
		this.#usageStatistics.cost = next.cost;
		return true;
	}

	/**
	 * Validate and accumulate one entry's persisted usage through the single shared,
	 * overflow-guarded aggregation path used by both #buildIndex (resume) and #appendEntry
	 * (runtime), covering the assistant and `task` tool-result shapes. Returns true when a
	 * present usage record was skipped as malformed or overflowing (so the caller can report
	 * it); false when the entry has no usage or was aggregated cleanly.
	 */
	#accumulateEntryUsage(entry: SessionEntry): boolean {
		if (entry.type !== "message") return false;
		if (entry.message.role === "assistant") {
			const totals = validatePersistedUsageTotals(entry.message.usage);
			return !(totals && this.#addValidatedUsage(totals));
		}
		if (entry.message.role === "toolResult" && entry.message.toolName === "task") {
			const rawTaskUsage = getTaskToolUsage(entry.message.details);
			if (rawTaskUsage === undefined) return false;
			const totals = validatePersistedUsageTotals(rawTaskUsage);
			return !(totals && this.#addValidatedUsage(totals));
		}
		return false;
	}

	#recordPersistError(err: unknown): Error {
		const normalized = toError(err);
		if (
			normalized instanceof ManagedCommittedMutationError &&
			isDescriptorBoundManagedIdentity(normalized.identity)
		) {
			// A managed rewrite can publish the complete resident transcript and then
			// lose its post-publication receipt. A descriptor-bound terminal identity
			// makes the successor authoritative, so later entries may retry through a
			// complete rewrite without recapturing the pathname. Identity-less committed
			// outcomes deliberately fall through and become sticky below: retrying the
			// stale predecessor could overwrite an exchanged-out successor.
			this.#needsFullRewriteOnNextPersist = true;
			return normalized;
		}
		if (!this.#persistError) this.#persistError = normalized;
		if (!this.#persistErrorReported) {
			this.#persistErrorReported = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: normalized.message,
				stack: normalized.stack,
			});
		}
		return normalized;
	}

	#queuePersistTask(task: () => Promise<void>, options?: { ignoreError?: boolean }): Promise<void> {
		const next = this.#persistChain.then(async () => {
			if (this.#persistError && !options?.ignoreError) throw this.#persistError;
			await task();
		});
		this.#persistChain = next.catch(err => {
			this.#recordPersistError(err);
		});
		return next;
	}
	/**
	 * Non-yielding same-session persistence fence. One owner serializes the critical
	 * mutation transaction (transcript append/rewrite, descriptor capture, commit
	 * expected-state check/publication). Async work may await BEFORE entering; once
	 * entered the transaction is fully synchronous with no intermediate await.
	 * Reentrant nested calls use a depth counter; the guard is never held across an
	 * await; no cross-fence acquisition. External/cross-process protection stays with
	 * the managed authority (RecoveryFsRoot, identity checks, exactReplacePath).
	 */
	#withSessionPersistenceFenceSync<T>(operation: () => T): T {
		if (this.#persistenceFenceDepth > 0) return operation();
		this.#persistenceFenceDepth = 1;
		try {
			return operation();
		} finally {
			this.#persistenceFenceDepth = 0;
		}
	}

	/** Freshness snapshot for the current whole-session persistence input. */
	#capturePersistenceInputToken(): PersistenceInputToken {
		return {
			sessionFile: this.#sessionFile ?? "",
			lifecycleId: `${this.#sessionId}@${this.#sessionFile ?? ""}`,
			entryRevision: this.#entryRevision,
			headerRevision: this.#headerExportRevision,
			residentBlobRevision: this.#residentBlobRevision,
		};
	}

	/**
	 * Compares a captured preparation snapshot against live state. A lifecycle/session
	 * switch aborts (throws); a revision change returns false so the caller discards
	 * the prepared bytes and re-prepares. A stale snapshot is never published.
	 */
	#persistenceInputTokenMatches(token: PersistenceInputToken): boolean {
		const live = this.#capturePersistenceInputToken();
		if (live.sessionFile !== token.sessionFile || live.lifecycleId !== token.lifecycleId) {
			throw new Error("session_persistence_lifecycle_changed");
		}
		return (
			live.entryRevision === token.entryRevision &&
			live.headerRevision === token.headerRevision &&
			live.residentBlobRevision === token.residentBlobRevision
		);
	}

	#ensurePersistWriter(): NdjsonFileWriter | undefined {
		if (!this.persist || !this.#sessionFile) return undefined;
		if (this.#persistError) throw this.#persistError;
		if (this.destination.kind === "managed") {
			this.#managedTranscriptStore();
			return undefined;
		}
		if (this.#persistWriter && this.#persistWriterPath === this.#sessionFile) {
			if (this.#persistWriter.isOpen()) return this.#persistWriter;
			// Cached writer for the current file is mid-close (queued
			// `#closePersistWriterInternal` has flipped `#closing` but not yet
			// cleared `#persistWriter`). Returning it would make `writeSync`
			// throw "Writer closed". Defer to the caller — `_persist` routes
			// the entry through the async rewrite path so it still lands on disk.
			return undefined;
		}
		// Note: caller must await _closePersistWriter() before calling this if switching files
		this.#persistWriter = new NdjsonFileWriter(this.#storage, this.#sessionFile, {
			onError: err => {
				this.#recordPersistError(err);
			},
		});
		this.#persistWriterPath = this.#sessionFile;
		return this.#persistWriter;
	}

	async #closePersistWriterInternal(): Promise<void> {
		if (this.#persistWriter) {
			await this.#persistWriter.close();
			this.#persistWriter = undefined;
		}
		this.#persistWriterPath = undefined;
	}

	#closePersistWriterInternalSync(): void {
		if (this.#persistWriter) {
			this.#persistWriter.closeSync();
			this.#persistWriter = undefined;
		}
		this.#persistWriterPath = undefined;
	}

	async #closePersistWriter(): Promise<void> {
		await this.#queuePersistTask(
			async () => {
				await this.#closePersistWriterInternal();
			},
			{ ignoreError: true },
		);
	}
	// Windows can reject overwrite-style rename with EPERM even after our own writer is closed.
	// Move the old session file aside first so a failed retry can roll back to the last good file.
	// The backup uses a plain `<basename>.<snowflake>.bak` name (no leading dot) so that if the
	// process crashes between the two renames, `recoverOrphanedBackups` can find it via the
	// shared `*.bak` glob on both real and in-memory storage backends and promote it back to
	// the primary on the next session-dir scan.

	#replaceSessionFileAfterEpermSync(
		tempPath: string,
		targetPath: string,
		renameError: unknown,
	): SessionFileReplacementSyncOutcome {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, `${path.basename(targetPath)}.${Snowflake.next()}.bak`);
		try {
			this.#storage.renameSync(targetPath, backupPath);
		} catch (err) {
			if (isEnoent(err)) {
				this.#storage.renameSync(tempPath, targetPath);
				return { kind: "replaced" };
			}
			throw toError(renameError);
		}

		try {
			this.#storage.renameSync(tempPath, targetPath);
		} catch (err) {
			const replaceError = toError(err);
			const originalError = toError(renameError);
			try {
				this.#storage.renameSync(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${originalError.message}; retry: ${replaceError.message}); rollback from ${backupPath} also failed: ${rollbackError.message}`,
					{ cause: originalError },
				);
			}
			return { kind: "restored_previous", error: replaceError };
		}

		try {
			this.#storage.unlinkSync(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
		return { kind: "replaced" };
	}

	async #replaceSessionFileAfterEperm(tempPath: string, targetPath: string, renameError: unknown): Promise<void> {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, `${path.basename(targetPath)}.${Snowflake.next()}.bak`);
		try {
			await this.#storage.rename(targetPath, backupPath);
		} catch (err) {
			if (isEnoent(err)) {
				await this.#storage.rename(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}

		try {
			await this.#storage.rename(tempPath, targetPath);
		} catch (err) {
			const replaceError = toError(err);
			const originalError = toError(renameError);
			try {
				await this.#storage.rename(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${originalError.message}; retry: ${replaceError.message}); rollback from ${backupPath} also failed: ${rollbackError.message}`,
					{ cause: originalError },
				);
			}
			throw replaceError;
		}

		try {
			await this.#storage.unlink(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async #replaceSessionFile(tempPath: string, targetPath: string): Promise<void> {
		try {
			await this.#storage.rename(tempPath, targetPath);
		} catch (err) {
			if (!hasFsCode(err, "EPERM")) throw toError(err);
			await this.#replaceSessionFileAfterEperm(tempPath, targetPath, err);
		}
	}

	#replaceSessionFileSync(tempPath: string, targetPath: string): SessionFileReplacementSyncOutcome {
		try {
			this.#storage.renameSync(tempPath, targetPath);
			return { kind: "replaced" };
		} catch (err) {
			if (hasFsCode(err, "EPERM")) {
				return this.#replaceSessionFileAfterEpermSync(tempPath, targetPath, err);
			}

			throw toError(err);
		}
	}

	/**
	 * Verify a foreign managed candidate directory under this manager's own root and
	 * prepare an owned destination rebind for it. Returns undefined when the candidate
	 * is this manager's current managed directory (nothing to rebind).
	 */
	#prepareManagedDestinationTransition(candidateDirectory: string): ManagedDestinationTransition | undefined {
		if (this.destination.kind !== "managed") throw new Error("Managed transcript authority is unavailable");
		const current = this.destination;
		if (path.resolve(candidateDirectory) === path.resolve(current.directory)) return undefined;
		// Independent verification: the non-retained constructor applies managedRelativePath
		// containment, assertManagedDirectoryRoot, full-chain ensureManagedDirectory owner-only
		// ACL verification, and a fresh fd identity binding on linux.
		const store = managedStoreFromContext(current.securityContext, candidateDirectory);
		let adopted = false;
		try {
			store.verifyRootSecurity();
			store.assertBound();
		} catch (error) {
			store.close();
			throw error;
		}
		const securityContext = createManagedSessionSecurityContext({
			agentDir: current.securityContext.agentDir,
			profileAgentDir: current.securityContext.profileAgentDir,
			sessionsRoot: current.securityContext.sessionsRoot,
			sessionDir: candidateDirectory,
			rootAuthority: current.securityContext.rootAuthority,
			// The candidate store owns its own authority; the context must not hand out a
			// borrowed retained fd for a directory it was not retained for.
			retainedAuthority: undefined,
		});
		managedSecurityPolicies.set(securityContext, managedSecurityPolicyForContext(current.securityContext));
		const destination = Object.freeze({ kind: "managed" as const, directory: candidateDirectory, securityContext });
		trustedSessionDestinations.add(destination);
		const previousDestination = current;
		const previousCache = this.#managedTranscriptStoreCache;
		const previousOwned = this.#ownedManagedAuthority;
		return {
			directory: candidateDirectory,
			destination,
			store,
			adopt: () => {
				adopted = true;
				this.destination = destination;
				this.#managedTranscriptStoreCache = { directory: path.resolve(candidateDirectory), store };
				this.#ownedManagedAuthority = store;
				// A superseded authority is NOT closed here: rollback() may still have to
				// restore it. Closing at adoption time would hand a closed store back to
				// the manager when a later cross-workspace switch fails after adoption.
			},
			settle: () => {
				if (!adopted) return;
				// The transition can no longer be rolled back, so the superseded authority
				// is now unreachable. Release it to keep exactly one owned fd per manager.
				if (previousOwned && previousOwned !== store) previousOwned.close();
			},
			rollback: () => {
				if (!adopted) return;
				adopted = false;
				this.destination = previousDestination;
				this.#managedTranscriptStoreCache = previousCache;
				this.#ownedManagedAuthority = previousOwned;
				store.close();
			},
			dispose: () => {
				if (adopted) return;
				store.close();
			},
		};
	}

	#releaseOwnedManagedAuthority(): void {
		this.#ownedManagedAuthority?.close();
		this.#ownedManagedAuthority = undefined;
	}

	#managedTranscriptStore(sessionFile = this.#sessionFile): ManagedSessionDescendantStore {
		if (this.destination.kind !== "managed" || !sessionFile) {
			throw new Error("Managed transcript authority is unavailable");
		}
		const sessionDir = path.resolve(path.dirname(sessionFile));
		if (sessionDir !== path.resolve(this.destination.directory)) {
			throw new Error("Managed transcript escaped its session directory");
		}
		if (this.#managedTranscriptStoreCache) {
			if (this.#managedTranscriptStoreCache.directory !== sessionDir)
				throw new Error("Managed transcript store transition was not verified");
			return this.#managedTranscriptStoreCache.store;
		}
		const store = managedStoreFromContext(this.destination.securityContext, sessionDir);
		this.#managedTranscriptStoreCache = { directory: sessionDir, store };
		return store;
	}
	#releaseManagedSidecarCache(): void {
		this.#managedSidecarAuthorityStore?.close();
		this.#managedSidecarSecurityContext?.retainedAuthority?.close();
		const store = this.#managedSidecarCacheStore;
		this.#managedSidecarAuthorityStore = undefined;
		this.#managedSidecarSecurityContext = undefined;
		this.#managedSidecarCacheStore = undefined;
		this.#managedSidecarCacheSessionFile = undefined;
		this.#managedRangeExpectedDescriptor = undefined;
		if (store) this.#managedSidecarCleanupStores.add(store);
		for (const pending of this.#managedSidecarCleanupStores) {
			try {
				pending.dispose();
				this.#managedSidecarCleanupStores.delete(pending);
			} catch (error) {
				const trustError = error instanceof ResidentCacheTrustError ? error : undefined;
				const candidate = trustError?.reason ?? "";
				const reason = /^[a-z0-9_]{1,64}$/.test(candidate) ? candidate : "cleanup_failed";
				// An errno is path-free, so it can join `reason` here; the cause *summary*
				// cannot, because fs messages embed the sidecar cache path this record withholds.
				const causeCode = trustError?.causeCode ?? (isFsError(error) ? error.code : undefined);
				logger.warn("Failed to dispose the managed sidecar resident cache; retained for retry", {
					reason,
					...(causeCode === undefined ? {} : { causeCode }),
				});
			}
		}
	}

	#isManagedSidecarPath(candidate: string): boolean {
		const root = this.#managedSidecarCacheStore?.dir;
		if (!root) return false;
		const resolvedRoot = path.resolve(root);
		const resolvedCandidate = path.resolve(candidate);
		return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
	}
	#managedSidecarRoot(sessionFile = this.#sessionFile): string | undefined {
		if (this.destination.kind !== "managed" || !sessionFile || process.platform === "win32") return undefined;
		if (this.#managedSidecarCacheStore && this.#managedSidecarCacheSessionFile === sessionFile)
			return this.#managedSidecarCacheStore.dir;
		this.#releaseManagedSidecarCache();
		// Sweep abandoned pre-namespace sidecars from the resident root. The sweep
		// only reaps stale owner leases, so the canonical resident store is untouched.
		void sweepResidentCacheRoot(getResidentCacheRootDir(this.#residentCacheProfileAgentDir()));
		const sessionHash = crypto.createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
		const instanceDir = openVerifiedSidecarCacheInstanceDir(
			getSidecarCacheRootDir(this.#residentCacheProfileAgentDir()),
			sessionHash,
		);
		const cacheParent = path.dirname(instanceDir);
		let retainedAuthority: native.RecoveryFsRoot | undefined;
		try {
			const cacheRoot = managedDirectoryRoot(instanceDir);
			retainedAuthority = retainManagedDirectoryAuthority(cacheRoot, instanceDir);
			this.#managedSidecarAuthorityStore = new ManagedSessionDescendantStore(
				cacheRoot,
				instanceDir,
				retainedAuthority ? { authority: retainedAuthority, authorityBaseDir: instanceDir } : undefined,
				undefined,
				cacheParent,
			);
			this.#managedSidecarSecurityContext = createManagedSessionSecurityContext({
				agentDir: instanceDir,
				profileAgentDir: cacheParent,
				sessionsRoot: instanceDir,
				sessionDir: instanceDir,
				rootAuthority: cacheRoot,
				retainedAuthority,
			});
			this.#managedSidecarCacheStore = EphemeralBlobStore.adoptVerifiedDir(instanceDir);
			this.#managedSidecarCacheSessionFile = sessionFile;
		} catch (error) {
			this.#managedSidecarAuthorityStore?.close();
			retainedAuthority?.close();
			this.#managedSidecarAuthorityStore = undefined;
			this.#managedSidecarSecurityContext = undefined;
			disposeVerifiedResidentCacheInstanceDir(instanceDir);
			throw error;
		}
		return instanceDir;
	}

	#clearBoundedManagedSource(): void {
		const source = this.#boundedManagedSource;
		this.#boundedManagedSource = undefined;
		if (source?.owned) source.store.close();
	}
	#readRangeSync(filePath: string, start: number, length: number): SessionStorageRangeSnapshot {
		const boundedManagedSource = this.#boundedManagedSource;
		if (
			this.destination.kind === "managed" &&
			boundedManagedSource &&
			path.resolve(filePath) === path.resolve(boundedManagedSource.path)
		) {
			return boundedManagedSource.store.readRangeExpectedSync(
				path.basename(filePath),
				start,
				length,
				boundedManagedSource.descriptor,
			);
		}
		if (
			this.destination.kind === "managed" &&
			this.#sessionFile &&
			path.resolve(filePath) === path.resolve(this.#sessionFile)
		) {
			try {
				return this.#managedTranscriptStore(filePath).readRangeExpectedSync(
					path.basename(filePath),
					start,
					length,
					this.#managedRangeExpectedDescriptor,
				);
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message === "managed_range_generation_mismatch" || error.message === "source_changed") &&
					this.#sidecarRuntime
				)
					this.#sidecarRuntime.rangeReadGenerationMismatchCount++;
				throw error;
			}
		}
		if (!this.#storage.readRangeSync) throw new Error("Session range reads are unavailable");
		return this.#storage.readRangeSync(filePath, start, length);
	}

	#statSync(filePath: string): SessionStorageStat {
		const boundedManagedSource = this.#boundedManagedSource;
		if (
			this.destination.kind === "managed" &&
			boundedManagedSource &&
			path.resolve(filePath) === path.resolve(boundedManagedSource.path)
		) {
			const descriptor = boundedManagedSource.store.descriptorExpected(path.basename(filePath));
			if (!descriptor || !sameDescriptor(boundedManagedSource.descriptor, descriptor))
				throw new Error("source_changed");
			return descriptor;
		}
		if (
			this.destination.kind === "managed" &&
			this.#sessionFile &&
			path.resolve(filePath) === path.resolve(this.#sessionFile)
		) {
			const descriptor = this.#managedTranscriptStore(filePath).descriptorExpected(path.basename(filePath));
			if (!descriptor) throw Object.assign(new Error("Managed file not found"), { code: "ENOENT" });
			return descriptor;
		}
		return this.#storage.statSync(filePath);
	}

	#boundedReadStorage(): SessionStorage {
		if (this.destination.kind !== "managed") return this.#storage;
		this.#boundedReadStorageProxy ??= new Proxy({} as SessionStorage, {
			get: (_target, property) => {
				if (property === "readRangeSync") return this.#readRangeSync.bind(this);
				if (property === "readRange")
					return async (filePath: string, start: number, length: number) =>
						this.#readRangeSync(filePath, start, length);
				if (property === "statSync") return this.#statSync.bind(this);
				const value = Reflect.get(this.#storage, property, this.#storage);
				return typeof value === "function" ? value.bind(this.#storage) : value;
			},
		});
		return this.#boundedReadStorageProxy;
	}
	/**
	 * Publish the mutable disposable commit marker inside the persistence fence.
	 * Managed sessions use a private verified per-process cache, so an fsynced
	 * overwrite cannot race another process. Explicit destinations retain checked
	 * create/replace publication with raw-hash and descriptor identity validation.
	 * The transcript remains authoritative in both cases.
	 */
	#publishSessionCommitMarkerSync(descriptor: SessionStorageStat, sessionIdOverride?: string): boolean {
		if (this.#sidecarBranchActivationDirty) return false;
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return false;
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || runtime.tail.transcriptSize !== descriptor.size) return false;
		return this.#withSessionPersistenceFenceSync(() => {
			const markerPath = runtime.commitPath;
			const gen = this.#commitGen + 1;
			const metadataDeltaCommit = this.#buildMetadataDeltaCommit();
			const record = {
				gen,
				descriptor: {
					dev: descriptor.dev.toString(),
					ino: descriptor.ino.toString(),
					...(descriptor.nlink !== undefined ? { nlink: descriptor.nlink.toString() } : {}),
					size: descriptor.size,
					mtimeNs: descriptor.mtimeNs.toString(),
					ctimeNs: descriptor.ctimeNs.toString(),
				},
				base: runtime.base,
				terminalChecksum: runtime.tail.terminalChecksum,
				terminalSeq: runtime.tail.terminalSeq,
				transcriptSize: runtime.tail.transcriptSize,
				retirementFirstKeptEntryId: runtime.retirementFirstKeptEntryId,
				leafId: this.#leafId,
				reducer: runtime.reducer,
				providerStateEntries: this.#markerProviderStateEntries(),
				labels: [...runtime.labelsPins.labelsEntries()],
				usageStatistics: this.#usageStatistics,

				indexDigest: runtime.indexDigest,
				...(runtime.parentArtifact
					? {
							parentIndex: {
								bucketCount: runtime.parentArtifact.buckets.length,
								indexDigest: runtime.parentArtifact.indexDigest,
								buckets: runtime.parentArtifact.buckets.map(bucket => ({
									size: bucket.size,
									digest: bucket.digest,
									complete: bucket.complete,
								})),
							},
						}
					: {}),
				...(runtime.dictionary
					? {
							dictionary: {
								header: {
									version: 2,
									sessionId: sessionIdOverride ?? this.#sessionId ?? "",
									sidecarIneligible: runtime.dictionary.sidecarIneligible,
								},
								indexDigest: runtime.dictionary.indexDigest,
								partitions: runtime.dictionary.partitions.map(partition => ({
									size: partition.size,
									digest: partition.digest,
									records: partition.records,
									complete: partition.complete,
								})),
								metaSize: runtime.dictionary.metaSize,
								metaDigest: runtime.dictionary.metaDigest,
								recordCount: runtime.dictionary.recordCount,
								uniqueTerms: runtime.dictionary.uniqueTerms,
								totalBytes: runtime.dictionary.totalBytes,
								duplicateIds: [...runtime.dictionary.duplicateIds],
								sidecarIneligible: runtime.dictionary.sidecarIneligible,
							},
						}
					: {}),
				...(metadataDeltaCommit ? { metadataDelta: metadataDeltaCommit } : {}),
			};
			const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
			try {
				if (this.destination.kind === "managed") {
					const writer = this.#storage.openWriter(markerPath, { flags: "w" });
					try {
						writer.writeLineSync(bytes.toString("utf8"));
						if (!writer.fsyncSync) throw new Error("Synchronous commit marker fsync is unavailable");
						writer.fsyncSync();
					} finally {
						writer.closeSync();
					}
					this.#managedRangeExpectedDescriptor = descriptor;
					this.#commitGen = gen;
					return true;
				}
				const current = !this.#storage.existsSync(markerPath)
					? ({ kind: "missing" } as const)
					: (() => {
							if (!this.#storage.readRangeSync) throw new Error("commit_marker_range_read_unavailable");
							const stat = this.#storage.statSync(markerPath);
							if (stat.size > 8 * 1024 * 1024) throw new Error("commit_marker_oversized");
							const markerBytes = this.#storage.readRangeSync(markerPath, 0, stat.size).bytes;
							return {
								kind: "present" as const,
								rawBytesSha256: crypto.createHash("sha256").update(markerBytes).digest("hex"),
								stat,
							};
						})();
				if (current.kind === "missing") {
					createSessionCommitMarkerCheckedSync(this.#storage, markerPath, bytes);
				} else {
					replaceSessionCommitMarkerCheckedSync(this.#storage, markerPath, bytes, {
						rawBytesSha256: current.rawBytesSha256,
						descriptorIdentity: current.stat,
					});
				}
				this.#commitGen = gen;
				return true;
			} catch {
				// A diverging sidecar never fails the authoritative transcript write.
				return false;
			}
		});
	}

	/** Capture the current transcript descriptor after a rewrite and publish the commit. */
	#publishCommitMarkerFromCurrentTranscriptSync(sessionIdOverride?: string): boolean {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return false;
		const descriptor =
			this.destination.kind === "managed"
				? this.#managedTranscriptStore(sessionFile).descriptorExpected(path.basename(sessionFile))
				: (() => {
						try {
							return this.#storage.statSync(sessionFile);
						} catch {
							return null;
						}
					})();
		if (!descriptor) return false;
		return this.#publishSessionCommitMarkerSync(descriptor, sessionIdOverride);
	}
	// =========================================================================
	// Cold-sidecar runtime (P2/P3/P4 primitives integration)
	// =========================================================================

	/** Create (or reset) the sidecar runtime for the current lifecycle. */
	#resetSidecarRuntime(ineligible = false): SessionMemorySidecarRuntime {
		this.#sidecarBranchActivationDirty = false;
		if (this.#sessionFile && this.destination.kind !== "managed") {
			for (const legacyPath of [
				`${this.#sessionFile}.spill.idx`,
				`${this.#sessionFile}.spill.tail`,
				`${this.#sessionFile}.spill.commit`,
				...parentBucketPaths(`${this.#sessionFile}.spill.idx`),
				...dictionaryPartitionPaths(`${this.#sessionFile}.spill.idx`),
				dictionaryMetaPathFor(`${this.#sessionFile}.spill.idx`),
				metadataDeltaPathFor(`${this.#sessionFile}.spill.idx`),
			]) {
				try {
					this.#storage.unlinkSync(legacyPath);
				} catch {
					// Legacy sidecars are disposable and may be absent.
				}
			}
		}
		const sidecarRoot =
			this.destination.kind === "managed"
				? this.#managedSidecarRoot()
				: this.#sessionFile?.endsWith(".jsonl")
					? this.#sessionFile.slice(0, -6)
					: this.#sessionFile;
		this.#managedRangeExpectedDescriptor =
			this.destination.kind === "managed" && this.#sessionFile
				? (this.#managedDescriptorSnapshotOrNull() ?? undefined)
				: undefined;
		const parentPathPrefix = sidecarRoot ? `${sidecarRoot}/.session-memory.spill.parent-` : "";
		const dictionaryPathPrefix = sidecarRoot ? `${sidecarRoot}/.session-memory.spill.dict-part-` : "";
		const dictionaryMetaPath = sidecarRoot ? `${sidecarRoot}/.session-memory.spill.dict-meta` : "";
		const metadataDeltaPath = sidecarRoot ? `${sidecarRoot}/.session-memory.spill.metadata-delta` : "";
		if (sidecarRoot) {
			for (const candidate of this.#storage.listFilesSync(sidecarRoot, ".*")) {
				const name = path.basename(candidate);
				const orphaned =
					name.endsWith(".tmp") ||
					name.includes(".spill.capture-") ||
					name.includes(".spill.fork-") ||
					name.includes(".spill.overlay-");
				if (!orphaned || !isDerivedSessionMemoryFile(candidate)) continue;
				try {
					this.#storage.unlinkSync(candidate);
				} catch {
					// Derived crash debris is best-effort cleanup; authoritative startup continues.
				}
			}
		}
		const runtime: SessionMemorySidecarRuntime = {
			enabled: false,
			sidecarIneligible: ineligible,
			base: { baseDigest: "", baseEndOffset: 0 },
			tail: {
				base: { baseDigest: "", baseEndOffset: 0 },
				records: [],
				terminalChecksum: "",
				terminalSeq: -1,
				transcriptSize: 0,
			},

			indexDigest: "",
			indexHash: crypto.createHash("sha256"),
			coldEntries: new Map(),
			indexPath: sidecarRoot ? `${sidecarRoot}/.session-memory.spill.idx` : "",
			tailPath: sidecarRoot ? `${sidecarRoot}/.session-memory.spill.tail` : "",
			commitPath: sidecarRoot ? `${sidecarRoot}/.session-memory.spill.commit` : "",
			parentPathPrefix,
			dictionaryPathPrefix,
			dictionaryMetaPath,
			metadataDeltaPath,
			retirementFirstKeptEntryId: undefined,
			nextOrdinal: 0,
			hotSuffixBytes: 0,
			hotResidentBytes: 0,
			reservedBudgetBytes: 0,
			sidecarFileBytes: 0,
			accountant: new SessionMemoryAccountant(),
			reducer: {
				modelChange: { latest: undefined },
				ttsr: { count: 0, rulesCount: 0, recordsCount: 0, largestOrdinal: -1 },
			},
			providerStateEntries: [],
			providerStateOrder: [],
			blockCache: new FixedCacheAccount(8 * 1024 * 1024),
			parentChildrenCache: new Map(),
			entryCache: new FixedCacheAccount(28 * 1024 * 1024),
			tailCache: new FixedCacheAccount(4 * 1024 * 1024),
			labelsPins: new BoundedLabelsPinsStore(),
			reopenTransition: undefined,
			terminalTransition: undefined,
			coldEntriesRetired: 0,
			coldEntriesReloaded: 0,
			rangeReadCount: 0,
			rangeReadGenerationMismatchCount: 0,
			sidecarRebuildCount: 0,
			coldMutationPromotions: 0,
			hotOverflowTransitions: 0,
			labelDiskFallbackCount: 0,
			shadowParityMismatchCount: 0,
			shadowParityCheckCount: 0,
			transcriptGeneration: 0,
		};
		this.#sidecarRuntime = runtime;
		return runtime;
	}

	/** Serialize side-effect-free candidate bytes for one header/session entry. */
	#serializeEntryLine(entry: FileEntry): Buffer {
		const materialized = materializeResidentEntryForPersistenceSync(entry, this.#residentBlobStores(), new Map());
		return Buffer.from(JSON.stringify(materialized), "utf8");
	}

	#transcriptContainsPatchRecords(): boolean {
		if (!this.#sessionFile || typeof this.#storage.readRangeSync !== "function") return true;
		const readRangeSync = this.#readRangeSync.bind(this);
		let size: number;
		try {
			size = this.#statSync(this.#sessionFile).size;
		} catch {
			return true;
		}
		let carry = "";
		for (let offset = 0; offset < size; offset += 64 * 1024) {
			const length = Math.min(64 * 1024, size - offset);
			const text = carry + Buffer.from(readRangeSync(this.#sessionFile, offset, length).bytes).toString("utf8");
			if (/"type"\s*:\s*"(?:header|entry)_patch"/.test(text)) return true;
			carry = text.slice(-128);
		}
		return false;
	}

	/** Build a fresh disposable `.spill.idx`/`.spill.tail`/`.spill.commit` set from the transcript. */
	#buildDisposableSidecars(entries: readonly FileEntry[]): void {
		if (this.#boundedFirstOpenBuildSuppressed) {
			this.#sidecarRuntime = undefined;
			return;
		}
		if (this.destination.kind === "managed" && process.platform === "win32") {
			this.#sidecarRuntime = undefined;
			return;
		}
		if (this.#effectiveSessionMemoryMode() === "off") {
			this.#sidecarRuntime = undefined;
			return;
		}
		try {
			this.#buildDisposableSidecarsUnsafe(entries);
			const runtime = this.#sidecarRuntime;
			if (this.#effectiveSessionMemoryMode() === "shadow" && runtime?.parentArtifact) {
				runtime.blockCache.release(runtime.parentArtifact.chargedBytes);
				runtime.parentArtifact = undefined;
			}
			if (this.#effectiveSessionMemoryMode() === "shadow" && runtime?.enabled && !runtime.sidecarIneligible) {
				this.#compareShadowParity(runtime, entries);
			}
			if (runtime?.enabled && !runtime.sidecarIneligible) this.#consecutiveSidecarBuildFailures = 0;
		} catch (error) {
			this.#consecutiveSidecarBuildFailures++;
			if (this.#consecutiveSidecarBuildFailures >= 2) {
				this.#sessionMemoryAutoDisabledReason = "sidecar_build_failures";
				this.#sessionMemoryMode = "shadow";
			}
			const runtime = this.#sidecarRuntime;
			if (runtime) {
				runtime.enabled = false;
				runtime.sidecarIneligible = true;
				runtime.hotSuffixBytes = 0;
				for (const sidecarPath of this.#disposableSidecarPaths()) {
					if (!sidecarPath) continue;
					try {
						this.#storage.unlinkSync(sidecarPath);
					} catch {
						// Disposable cleanup is best-effort; the transcript remains authoritative.
					}
				}
			}
			logger.warn("Session memory sidecar build failed; preserving eager transcript state", {
				sessionFile: this.#sessionFile,
				error: toError(error).message,
				consecutiveBuildFailures: this.#consecutiveSidecarBuildFailures,
				autoDisabled: this.#sessionMemoryAutoDisabledReason !== undefined,
			});
		}
	}

	/**
	 * Shadow-mode parity telemetry (AC10). After a successful shadow sidecar build,
	 * materialize the provider context through both authoritative eager traversal and
	 * the exact sidecar reducer/provider-state + hot-suffix path used after retirement.
	 * Any mismatch increments the live counter and warns; the eager transcript remains
	 * authoritative and no sidecar result is returned to the caller.
	 */
	#compareShadowParity(runtime: SessionMemorySidecarRuntime, entries: readonly FileEntry[]): void {
		const eagerEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const eagerContext = buildSessionContext(
			eagerEntries.map(cloneSessionEntry),
			this.#leafId,
			undefined,
			this.#sessionId,
		);
		const resolvedProviderState = this.#resolvedProviderStateEntries();
		let sidecarContext: SessionContext | undefined;
		if (resolvedProviderState) {
			const providerEntries = this.#getActivePathEntriesForProviderContext(undefined, true).map(cloneSessionEntry);
			const providerStateEntries = resolvedProviderState.map(cloneSessionEntry);
			let syntheticParentId: string | null = null;
			for (const entry of providerStateEntries) {
				entry.parentId = syntheticParentId;
				syntheticParentId = entry.id;
			}
			if (providerEntries[0] && syntheticParentId) providerEntries[0].parentId = syntheticParentId;
			sidecarContext = buildSessionContext(
				[...providerStateEntries, ...providerEntries],
				this.#leafId,
				undefined,
				this.#sessionId,
			);
		}
		runtime.shadowParityCheckCount++;
		const eagerRole = this.getLastModelChangeRole();
		const reducerRole = getReducerLastModelChangeRole(runtime.reducer);
		if (!sidecarContext || reducerRole !== eagerRole || !util.isDeepStrictEqual(sidecarContext, eagerContext)) {
			runtime.shadowParityMismatchCount++;
			logger.warn("Session memory shadow parity mismatch", {
				sessionFile: this.#sessionFile,
				reducerRole,
				eagerRole,
				sidecarContextAvailable: sidecarContext !== undefined,
			});
		}
	}

	#buildDisposableSidecarsUnsafe(entries: readonly FileEntry[]): void {
		const runtime = this.#resetSidecarRuntime();
		if (
			!this.#sessionFile ||
			!runtime.indexPath ||
			!runtime.tailPath ||
			typeof this.#storage.readRangeSync !== "function"
		)
			return;
		const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		if (!hasStrictSessionSchema(entries)) {
			runtime.sidecarIneligible = true;
			return;
		}
		if (this.#transcriptContainsPatchRecords()) {
			runtime.sidecarIneligible = true;
			return;
		}
		let activeCompaction: CompactionEntry | undefined;
		let active = this.#leafId ? this.#byId.get(this.#leafId) : undefined;
		let activeSteps = 0;
		const providerState = new Map<string, { order: number; ordinal: number; entry: SessionEntry }>();
		let providerStateBytes = 0;
		while (active && activeSteps <= sessionEntries.length) {
			const ordinal = sessionEntries.length - activeSteps - 1;
			if (!activeCompaction && active.type === "compaction") activeCompaction = active;
			const providerKey = providerStateEntryKey(active);
			if (providerKey && !providerState.has(providerKey)) {
				const bytes = Buffer.byteLength(JSON.stringify(active), "utf8") + 64;
				if (providerStateBytes + bytes > REDUCER_BUDGET_BYTES) {
					runtime.sidecarIneligible = true;
					return;
				}
				providerStateBytes += bytes;
				providerState.set(providerKey, { order: activeSteps, ordinal, entry: cloneSessionEntry(active) });
			}
			if (active.type === "model_change" && runtime.reducer.modelChange.latest === undefined) {
				runtime.reducer = applyReducerDelta(runtime.reducer, {
					kind: "latest_model_change",
					ordinal,
					role: active.role,
				});
			} else if (active.type === "ttsr_injection" && runtime.reducer.ttsr.largestOrdinal < 0) {
				runtime.reducer = applyReducerDelta(runtime.reducer, {
					kind: "ttsr_injection",
					ordinal,
					rulesCount: active.injectedRules.length,
					recordsCount: active.injectedRuleRecords?.length ?? 0,
					count: active.ttsrMessageCount ?? 0,
				});
			}
			active = active.parentId ? this.#byId.get(active.parentId) : undefined;
			activeSteps++;
		}
		const sortedProviderState = [...providerState.values()].sort((left, right) => right.order - left.order);
		runtime.providerStateOrder = sortedProviderState.map(item => providerStateEntryKey(item.entry)!);
		runtime.providerStateEntries = [];
		// Inline entries are added after the delta decision below (demoted
		// values stay resident only as descriptors).
		if (!activeCompaction) return;
		const tailStartOrdinal = sessionEntries.findIndex(entry => entry.id === activeCompaction.firstKeptEntryId);
		if (tailStartOrdinal < 0) return;
		runtime.retirementFirstKeptEntryId = activeCompaction.firstKeptEntryId;
		const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
		const headerBytes = header
			? Buffer.concat([this.#serializeEntryLine(header), Buffer.from("\n")])
			: Buffer.alloc(0);
		const baseHash = crypto.createHash("sha256");
		baseHash.update(headerBytes);
		const fullHash = crypto.createHash("sha256");
		fullHash.update(headerBytes);
		let baseEndOffset = headerBytes.byteLength;
		for (let ordinal = 0; ordinal < tailStartOrdinal; ordinal++) {
			const persistedLine = Buffer.concat([this.#serializeEntryLine(sessionEntries[ordinal]), Buffer.from("\n")]);
			baseHash.update(persistedLine);
			baseEndOffset += persistedLine.byteLength;
		}
		const baseDigest = baseHash.digest("hex");
		const hasDuplicateIds = sessionEntries.some(entry => this.#byId.get(entry.id) !== entry);
		if (hasDuplicateIds) {
			runtime.sidecarIneligible = true;
			return;
		}
		const tailBuilder = new RollingTailChainBuilder(
			{ baseDigest, baseEndOffset },
			{ tailBufferBytes: sidecarTailBufferBytes() },
		);
		const fsyncWriter = (writer: SessionStorageWriter | undefined): void => {
			if (!writer) return;
			if (!writer.fsyncSync) throw new Error("Synchronous sidecar fsync is unavailable");
			writer.fsyncSync();
		};
		let indexWriter: SessionStorageWriter | undefined;
		let tailWriter: SessionStorageWriter | undefined;
		let runningOffset = headerBytes.byteLength;
		let tailSeq = 0;
		let buildFailed = false;
		let tailOverflow = false;
		let operationError: unknown;
		let closeError: unknown;
		const parentBuilder = new BoundedParentArtifactBuilder();
		const enabledBuild = this.#effectiveSessionMemoryMode() === "enabled";
		const secondaryArtifactsEligible =
			firstOpenSecondaryArtifactMode() !== "disabled" &&
			enabledBuild &&
			sessionEntries.length <= PERSISTENT_SECONDARY_ARTIFACT_MAX_RECORDS &&
			this.#statSync(this.#sessionFile).size <= PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES;
		const partitionHashes = Array.from({ length: DICTIONARY_PARTITION_COUNT }, () => crypto.createHash("sha256"));
		const partitionSizes = new Array<number>(DICTIONARY_PARTITION_COUNT).fill(0);
		const partitionRecords = new Array<number>(DICTIONARY_PARTITION_COUNT).fill(0);
		const dictionaryBuilder = new BoundedDictionaryArtifactBuilder({
			detector: new BoundedDictionaryIdSet(),
			target: this.#createDictionaryFlushTarget(partitionHashes, partitionSizes, partitionRecords),
		});
		try {
			indexWriter = this.#storage.openWriter(runtime.indexPath, { flags: "w" });
			tailWriter = this.#storage.openWriter(runtime.tailPath, { flags: "w" });
			this.#truncateDerivedArtifactFiles(secondaryArtifactsEligible);
			runtime.metadataDelta = this.#createMetadataDeltaRuntimeState();
			for (const item of sortedProviderState) {
				const key = providerStateEntryKey(item.entry)!;
				const persistedLine = Buffer.from(`${JSON.stringify(item.entry)}\n`, "utf8");
				if (persistedLine.byteLength > MAX_REDUCER_INLINE_BYTES) {
					const stored = this.#appendMetadataDeltaValue(persistedLine);
					if (stored) {
						runtime.metadataDelta.byKey.set(key, {
							kind: item.entry.type,
							ordinal: item.ordinal,
							...stored,
						});
					} else {
						runtime.metadataDelta.byKey.delete(key);
						runtime.providerStateEntries.push(cloneSessionEntry(item.entry));
					}
				} else {
					runtime.providerStateEntries.push(cloneSessionEntry(item.entry));
				}
			}
			this.#syncMetadataDeltaDescriptorBytes();
			for (let ordinal = 0; ordinal < sessionEntries.length; ordinal++) {
				const entry = sessionEntries[ordinal];
				const persistedLine = Buffer.concat([this.#serializeEntryLine(entry), Buffer.from("\n")]);
				fullHash.update(persistedLine);
				const recordDigest = computeLineDigest(persistedLine);
				const indexLine = `${JSON.stringify({
					id: entry.id,
					ordinal,
					seq: ordinal,
					byteOffset: runningOffset,
					byteLength: persistedLine.byteLength,
					recordDigest,
					parentId: entry.parentId,
					entryType: entry.type,
				})}\n`;
				indexWriter!.writeLineSync(indexLine);
				runtime.indexHash.update(Buffer.from(indexLine, "utf8"));
				if (secondaryArtifactsEligible) {
					const dictionaryAdd = dictionaryBuilder.add({
						id: entry.id,
						ordinal,
						seq: ordinal,
						byteOffset: runningOffset,
						byteLength: persistedLine.byteLength,
						recordDigest,
						parentId: entry.parentId,
						entryType: entry.type,
					});
					if (dictionaryAdd.kind !== "ok") {
						buildFailed = true;
						throw new Error("dictionary_artifact_build_failed");
					}
				}
				if (secondaryArtifactsEligible && typeof entry.parentId === "string") {
					parentBuilder.add({
						parentId: entry.parentId,
						childId: entry.id,
						ordinal,
						seq: ordinal,
						byteOffset: runningOffset,
						byteLength: persistedLine.byteLength,
						recordDigest,
						entryType: entry.type,
					});
				}
				if (ordinal >= tailStartOrdinal && !tailOverflow) {
					const record = tailBuilder.append({
						seq: tailSeq,
						kind: tailRecordKindForEntry(entry),
						ordinal,
						id: entry.id,
						parentId: entry.parentId,
						type: entry.type,
						byteOffset: runningOffset,
						byteLength: persistedLine.byteLength,
						recordDigest,
					});
					if (!record) {
						tailOverflow = true;
					} else {
						tailWriter!.writeLineSync(`${JSON.stringify(record)}\n`);
						tailSeq++;
					}
				}
				runningOffset += persistedLine.byteLength;
			}
		} catch (error) {
			operationError = error;
		} finally {
			try {
				fsyncWriter(indexWriter);
			} catch (error) {
				closeError = error;
			}
			try {
				indexWriter?.closeSync();
			} catch (error) {
				closeError ??= error;
			}
			try {
				fsyncWriter(tailWriter);
			} catch (error) {
				closeError ??= error;
			}
			try {
				tailWriter?.closeSync();
			} catch (error) {
				closeError ??= error;
			}
		}
		if (operationError ?? closeError) throw operationError ?? closeError;
		if (tailOverflow) {
			const truncateTail = this.#storage.openWriter(runtime.tailPath, { flags: "w" });
			let durabilityError: unknown;
			try {
				if (!truncateTail.fsyncSync) throw new Error("Synchronous sidecar fsync is unavailable");
				truncateTail.fsyncSync();
			} catch (error) {
				durabilityError = error;
			}
			try {
				truncateTail.closeSync();
			} catch (error) {
				durabilityError ??= error;
			}
			if (durabilityError) throw durabilityError;
		}
		for (const [id, label] of this.#labelsById) {
			if (!runtime.labelsPins.setLabel(id, label)) {
				buildFailed = true;
				break;
			}
		}
		if (buildFailed) {
			for (const sidecarPath of [
				runtime.indexPath,
				runtime.tailPath,
				runtime.dictionaryMetaPath,
				runtime.metadataDeltaPath,
				...dictionaryPartitionPaths(runtime.indexPath),
			]) {
				try {
					this.#storage.unlinkSync(sidecarPath);
				} catch {
					// Disposable sidecar cleanup is best-effort; eager transcript state remains authoritative.
				}
			}
			runtime.dictionary = undefined;
			runtime.metadataDelta = undefined;
			return;
		}
		runtime.enabled = true;
		runtime.nextOrdinal = sessionEntries.length;
		if (tailOverflow) {
			runtime.base = { baseDigest: fullHash.digest("hex"), baseEndOffset: runningOffset };
			runtime.tail = new RollingTailChainBuilder(runtime.base).build();
		} else {
			runtime.base = { baseDigest, baseEndOffset };
			runtime.tail = tailBuilder.build();
		}

		runtime.indexDigest = runtime.indexHash.copy().digest("hex");
		if (runtime.metadataDelta) runtime.metadataDelta.indexDigest = runtime.indexDigest;
		if (enabledBuild) {
			if (secondaryArtifactsEligible) {
				const dictionaryResult = dictionaryBuilder.finish(this.#sessionId ?? "", runtime.indexDigest);
				if (dictionaryResult.kind === "ok" && !dictionaryResult.commit.sidecarIneligible) {
					this.#adoptBuiltDictionaryArtifact(dictionaryResult, partitionHashes, partitionSizes, partitionRecords);
				}
				this.#publishParentArtifact(parentBuilder, runtime.indexDigest);
			} else {
				this.#cleanupParentArtifactFiles();
				this.#cleanupDictionaryArtifactFiles();
				runtime.parentArtifact = undefined;
				runtime.dictionary = undefined;
			}
			this.#syncMetadataDeltaDescriptorBytes();
		} else {
			this.#cleanupParentArtifactFiles();
			this.#cleanupDictionaryArtifactFiles();
			runtime.parentArtifact = undefined;
			runtime.dictionary = undefined;
			// Keep the bounded metadata delta live through the shadow parity comparison;
			// parent/dictionary artifacts remain disabled because shadow never retires.
		}
		try {
			const validated = this.#storage.statSync(runtime.indexPath);
			runtime.validatedIndexDescriptor = validated;
		} catch {
			// A missing index falls back to the authoritative digest re-verification path.
		}
		runtime.reopenTransition = this.#classifySidecarReopen();
		this.#publishCommitMarkerFromCurrentTranscriptSync();
		runtime.terminalTransition = this.#classifySidecarReopen();
	}

	// =========================================================================
	// Persistent bounded parent→children artifact
	// =========================================================================

	/** Path of one parent bucket file (`.spill.parent-<bucket>`). */
	#parentBucketPath(bucket: number): string {
		const runtime = this.#sidecarRuntime;
		return runtime ? `${runtime.parentPathPrefix}${bucket.toString().padStart(4, "0")}` : "";
	}

	/** Best-effort unlink of every derived parent bucket file. */
	#cleanupParentArtifactFiles(): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.parentPathPrefix) return;
		for (const path of parentBucketPaths(runtime.indexPath)) {
			try {
				this.#storage.unlinkSync(path);
			} catch {
				// Disposable buckets are best-effort cleanup; transcript authority is unaffected.
			}
		}
	}

	/**
	 * Write the built parent artifact bucket files (fsync before any marker
	 * publication), then adopt the committed metadata into the runtime. Any
	 * build/write failure or block-cache rejection disables the artifact (parent
	 * lookups then fail closed to the authoritative cold scan); the session's
	 * index/tail sidecars remain fully usable.
	 */
	#publishParentArtifact(builder: BoundedParentArtifactBuilder, indexDigest: string): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return;
		const cleanup = (): void => {
			this.#cleanupParentArtifactFiles();
			runtime.parentArtifact = undefined;
		};
		if (builder.distinctParents === 0) {
			cleanup();
			return;
		}
		const result = builder.finish(indexDigest);
		try {
			for (let bucket = 0; bucket < result.buckets.length; bucket++) {
				const records = result.buckets[bucket];
				if (records.length === 0) {
					try {
						this.#storage.unlinkSync(this.#parentBucketPath(bucket));
					} catch {
						// An absent bucket is fine; an unlink failure is best-effort.
					}
					continue;
				}
				const writer = this.#storage.openWriter(this.#parentBucketPath(bucket), { flags: "w" });
				try {
					for (const line of records) writer.writeLineSync(line);
					if (!writer.fsyncSync) throw new Error("Synchronous parent bucket fsync is unavailable");
					writer.fsyncSync();
				} finally {
					writer.closeSync();
				}
			}
		} catch {
			cleanup();
			return;
		}
		const charged = parentArtifactRuntimeBytes(result.metadata.bucketCount);
		if (!runtime.blockCache.tryAllocate(charged)) {
			cleanup();
			return;
		}
		const totalBytes = result.metadata.buckets.reduce((total, bucket) => total + bucket.size, 0);
		runtime.parentArtifact = {
			indexDigest: result.metadata.indexDigest,
			buckets: result.metadata.buckets.map(bucket => ({
				size: bucket.size,
				digest: bucket.digest,
				complete: bucket.complete,
			})),
			totalBytes,
			chargedBytes: charged,
			budgetBytes: PARENT_CHILDREN_BUDGET_BYTES,
		};
	}

	/**
	 * Fail closed: delete the bucket files and drop the retained artifact state.
	 * A marker published after this call binds no parent metadata, so lookups
	 * never trust a stale/partial artifact and fall back to the authoritative
	 * cold scan.
	 */
	#invalidateParentArtifact(): void {
		const runtime = this.#sidecarRuntime;
		const artifact = runtime?.parentArtifact;
		if (!artifact) return;
		this.#cleanupParentArtifactFiles();
		runtime.parentArtifact = undefined;
		if (artifact.chargedBytes > 0) runtime.blockCache.release(artifact.chargedBytes);
	}

	/**
	 * Adopt the parent artifact binding from a validated commit marker. Bucket
	 * bytes are verified lazily (one bounded bucket read per lookup); any
	 * structural, binding, or budget inconsistency disables the artifact and the
	 * session still reopens exactly on index/tail proof.
	 */
	#adoptCommittedParentArtifact(parentIndex: ParentArtifactCommit | undefined): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return;
		const reject = (): void => {
			runtime.parentArtifact = undefined;
		};
		if (!parentIndex) return reject();
		if (
			parentIndex.bucketCount !== PARENT_CHILDREN_BUCKET_COUNT ||
			parentIndex.indexDigest !== runtime.indexDigest ||
			parentIndex.buckets.length !== PARENT_CHILDREN_BUCKET_COUNT
		)
			return reject();
		let totalBytes = 0;
		for (const bucket of parentIndex.buckets) {
			if (!Number.isSafeInteger(bucket.size) || bucket.size < 0) return reject();
			if (typeof bucket.digest !== "string" || !/^[0-9a-f]{64}$/.test(bucket.digest)) return reject();
			if (typeof bucket.complete !== "boolean") return reject();
			totalBytes += bucket.size;
		}
		if (totalBytes > PARENT_CHILDREN_BUDGET_BYTES) return reject();
		const charged = parentArtifactRuntimeBytes(parentIndex.bucketCount);
		if (!runtime.blockCache.tryAllocate(charged)) return reject();
		runtime.parentArtifact = {
			indexDigest: parentIndex.indexDigest,
			buckets: parentIndex.buckets.map(bucket => ({
				size: bucket.size,
				digest: bucket.digest,
				complete: bucket.complete,
			})),
			totalBytes,
			chargedBytes: charged,
			budgetBytes: PARENT_CHILDREN_BUDGET_BYTES,
		};
	}

	/** Strictly parse the marker's parent-artifact binding; invalid → absent (fail closed). */
	#parseParentIndexValue(value: unknown): ParentArtifactCommit | undefined {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const parentIndex = value as Record<string, unknown>;
		if (typeof parentIndex.bucketCount !== "number" || !Number.isSafeInteger(parentIndex.bucketCount))
			return undefined;
		if (typeof parentIndex.indexDigest !== "string" || parentIndex.indexDigest.length !== 64) return undefined;
		if (!Array.isArray(parentIndex.buckets)) return undefined;
		const buckets: ParentBucketCommit[] = [];
		for (const candidate of parentIndex.buckets) {
			if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
			const bucket = candidate as Record<string, unknown>;
			if (typeof bucket.size !== "number" || !Number.isSafeInteger(bucket.size) || bucket.size < 0) return undefined;
			if (typeof bucket.digest !== "string" || !/^[0-9a-f]{64}$/.test(bucket.digest)) return undefined;
			if (typeof bucket.complete !== "boolean") return undefined;
			buckets.push({ size: bucket.size, digest: bucket.digest, complete: bucket.complete });
		}
		return { bucketCount: parentIndex.bucketCount, indexDigest: parentIndex.indexDigest, buckets };
	}

	// =========================================================================
	// Persistent bounded dictionary artifact (hash-partitioned flat index)
	// =========================================================================

	/** Path of one dictionary partition file (`.spill.dict-part-<partition>`). */
	#dictionaryPartitionPath(partition: number): string {
		const runtime = this.#sidecarRuntime;
		return runtime ? `${runtime.dictionaryPathPrefix}${partition.toString().padStart(4, "0")}` : "";
	}

	/** Best-effort unlink of every dictionary partition + meta file. */
	#cleanupDictionaryArtifactFiles(): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return;
		for (const path of [runtime.dictionaryMetaPath, ...dictionaryPartitionPaths(runtime.indexPath)]) {
			try {
				this.#storage.unlinkSync(path);
			} catch {
				// Disposable dictionary files are best-effort cleanup; transcript authority is unaffected.
			}
		}
	}

	/** Truncate dictionary files for an eligible fresh secondary-artifact build. */
	#truncateDerivedArtifactFiles(includeDictionary: boolean): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime || !includeDictionary) return;
		const paths = [runtime.dictionaryMetaPath, ...dictionaryPartitionPaths(runtime.indexPath)];
		for (const path of paths) {
			try {
				const writer = this.#storage.openWriter(path, { flags: "w" });
				try {
					if (!writer.fsyncSync) throw new Error("Synchronous sidecar fsync is unavailable");
					writer.fsyncSync();
				} finally {
					writer.closeSync();
				}
			} catch {
				// Truncation failures surface at the first write; disposable artifacts remain best-effort.
			}
		}
	}

	/** Persist one flushed batch of dictionary partition lines (append + fsync). */
	#writeDictionaryPartitionLines(partition: number, lines: readonly string[]): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return false;
		try {
			const writer = this.#storage.openWriter(this.#dictionaryPartitionPath(partition), { flags: "a" });
			try {
				for (const line of lines) writer.writeLineSync(line);
				if (!writer.fsyncSync) throw new Error("Synchronous dictionary partition fsync is unavailable");
				writer.fsyncSync();
			} finally {
				writer.closeSync();
			}
			return true;
		} catch {
			return false;
		}
	}

	/** Flush target for the streaming dictionary build (owns exact bytes + running digests). */
	#createDictionaryFlushTarget(
		hashes: crypto.Hash[],
		sizes: number[],
		records: number[],
	): DictionaryArtifactFlushTarget {
		return {
			writePartitionLines: (partition, lines) => {
				if (!this.#writeDictionaryPartitionLines(partition, lines)) return false;
				for (const line of lines) {
					const bytes = Buffer.from(line, "utf8");
					hashes[partition]!.update(bytes);
					sizes[partition]! += bytes.byteLength;
					records[partition]! += 1;
				}
				return true;
			},
			getPartitionCommit: partition => ({
				size: sizes[partition]!,
				digest: hashes[partition]!.copy().digest("hex"),
				records: records[partition]!,
				complete: true,
			}),
		};
	}

	/**
	 * Persist the finalized dictionary meta file (fsynced before any marker
	 * publication) and adopt the artifact into the runtime. Any write or
	 * block-cache rejection disables the artifact (lookups fail closed to the
	 * authoritative cold scan); the session's index/tail sidecars remain fully
	 * usable.
	 */
	#adoptBuiltDictionaryArtifact(
		result: Extract<DictionaryArtifactBuildResult, { kind: "ok" }>,
		partitionHashes: crypto.Hash[],
		partitionSizes: number[],
		partitionRecords: number[],
	): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return false;
		const meta = finalizeDictionaryArtifactCommit(result.commit);
		try {
			const writer = this.#storage.openWriter(runtime.dictionaryMetaPath, { flags: "w" });
			try {
				writer.writeLineSync(meta.bytes);
				if (!writer.fsyncSync) throw new Error("Synchronous dictionary meta fsync is unavailable");
				writer.fsyncSync();
			} finally {
				writer.closeSync();
			}
		} catch {
			return false;
		}
		const charged = dictionaryArtifactRuntimeBytes(result.commit.partitions.length);
		if (!runtime.blockCache.tryAllocate(charged)) return false;
		runtime.dictionary = {
			indexDigest: result.commit.indexDigest,
			partitions: result.commit.partitions.map(partition => ({ ...partition })),
			metaSize: meta.commit.metaSize,
			metaDigest: meta.commit.metaDigest,
			recordCount: result.commit.recordCount,
			uniqueTerms: result.commit.uniqueTerms,
			totalBytes: result.commit.totalBytes,
			duplicateIds: [...result.commit.duplicateIds],
			sidecarIneligible: result.commit.sidecarIneligible,
			chargedBytes: charged,
			budgetBytes: DICTIONARY_PARTITION_BUFFER_BYTES,
			partitionHashes,
			partitionSizes,
			partitionRecords,
		};
		try {
			runtime.dictionary.validatedDescriptor = this.#storage.statSync(runtime.dictionaryMetaPath);
		} catch {
			// A missing meta falls back to the authoritative digest re-verification path.
		}
		return true;
	}

	/** Strictly parse the marker's dictionary-artifact binding; invalid → absent (fail closed). */
	#parseDictionaryCommitValue(value: unknown): DictionaryArtifactCommit | undefined {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		const header = record.header;
		if (header === null || typeof header !== "object" || Array.isArray(header)) return undefined;
		const headerRecord = header as Record<string, unknown>;
		if (headerRecord.version !== 2) return undefined;
		if (typeof headerRecord.sessionId !== "string") return undefined;
		if (typeof headerRecord.sidecarIneligible !== "boolean") return undefined;
		if (typeof record.indexDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.indexDigest)) return undefined;
		if (!Array.isArray(record.partitions) || record.partitions.length !== DICTIONARY_PARTITION_COUNT)
			return undefined;
		const partitions: DictionaryPartitionCommit[] = [];
		for (const candidate of record.partitions) {
			if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
			const partition = candidate as Record<string, unknown>;
			if (!Number.isSafeInteger(partition.size) || (partition.size as number) < 0) return undefined;
			if (typeof partition.digest !== "string" || !/^[0-9a-f]{64}$/.test(partition.digest)) return undefined;
			if (!Number.isSafeInteger(partition.records) || (partition.records as number) < 0) return undefined;
			if (typeof partition.complete !== "boolean") return undefined;
			partitions.push({
				size: partition.size as number,
				digest: partition.digest,
				records: partition.records as number,
				complete: partition.complete,
			});
		}
		if (!Number.isSafeInteger(record.recordCount) || (record.recordCount as number) < 0) return undefined;
		if (!Number.isSafeInteger(record.uniqueTerms) || (record.uniqueTerms as number) < 0) return undefined;
		if (!Number.isSafeInteger(record.totalBytes) || (record.totalBytes as number) < 0) return undefined;
		if (!Array.isArray(record.duplicateIds) || record.duplicateIds.some(candidate => typeof candidate !== "string"))
			return undefined;
		if (typeof record.sidecarIneligible !== "boolean") return undefined;
		const candidate: Omit<DictionaryArtifactCommit, "metaSize" | "metaDigest"> = {
			header: {
				version: 2,
				sessionId: headerRecord.sessionId,
				sidecarIneligible: headerRecord.sidecarIneligible,
			},
			indexDigest: record.indexDigest,
			partitions,
			recordCount: record.recordCount as number,
			uniqueTerms: record.uniqueTerms as number,
			totalBytes: record.totalBytes as number,
			duplicateIds: record.duplicateIds as string[],
			sidecarIneligible: record.sidecarIneligible,
		};
		return finalizeDictionaryArtifactCommit(candidate).commit;
	}

	/**
	 * Adopt the dictionary artifact binding from a validated commit marker. The
	 * exact meta bytes and every partition byte range are re-hashed once (bounded
	 * 64 KiB chunk reads); any structural, binding, digest, or budget
	 * inconsistency disables the dictionary and the session still reopens
	 * exactly on index/tail proof.
	 */
	#adoptCommittedDictionary(dictionary: DictionaryArtifactCommit | undefined, expectedSessionId: string): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return;
		const reject = (): void => {
			runtime.dictionary = undefined;
		};
		const parsed = this.#parseDictionaryCommitValue(dictionary);
		if (!parsed) return reject();
		if (parsed.header.sessionId !== expectedSessionId) return reject();
		if (parsed.indexDigest !== runtime.indexDigest) return reject();
		if (parsed.sidecarIneligible || parsed.duplicateIds.length > 0) return reject();
		if (parsed.partitions.some(partition => !partition.complete)) return reject();
		if (typeof this.#storage.readRangeSync !== "function") return reject();
		try {
			const metaStat = this.#storage.statSync(runtime.dictionaryMetaPath);
			if (metaStat.size !== parsed.metaSize) return reject();
			const metaHash = crypto.createHash("sha256");
			for (let offset = 0; offset < parsed.metaSize; offset += 64 * 1024) {
				const length = Math.min(64 * 1024, parsed.metaSize - offset);
				metaHash.update(this.#storage.readRangeSync(runtime.dictionaryMetaPath, offset, length).bytes);
			}
			if (metaHash.digest("hex") !== parsed.metaDigest) return reject();
		} catch {
			return reject();
		}
		const adoptedHashes: crypto.Hash[] = [];
		const adoptedSizes: number[] = [];
		const adoptedRecords: number[] = [];
		for (let partition = 0; partition < parsed.partitions.length; partition++) {
			const committed = parsed.partitions[partition]!;
			try {
				const stat = this.#storage.statSync(this.#dictionaryPartitionPath(partition));
				if (stat.size !== committed.size) return reject();
				// The verification hash keeps the full partition byte state so it
				// doubles as the append-time running hash (seeded with exact bytes).
				const hash = crypto.createHash("sha256");
				for (let offset = 0; offset < committed.size; offset += 64 * 1024) {
					const length = Math.min(64 * 1024, committed.size - offset);
					hash.update(this.#storage.readRangeSync(this.#dictionaryPartitionPath(partition), offset, length).bytes);
					if ((offset & (4 * 1024 * 1024 - 1)) === 0) Bun.gc(true);
				}
				if (hash.copy().digest("hex") !== committed.digest) return reject();
				adoptedHashes.push(hash);
				adoptedSizes.push(committed.size);
				adoptedRecords.push(committed.records);
			} catch {
				return reject();
			}
		}
		const charged = dictionaryArtifactRuntimeBytes(parsed.partitions.length);
		if (!runtime.blockCache.tryAllocate(charged)) return reject();
		runtime.dictionary = {
			indexDigest: parsed.indexDigest,
			partitions: parsed.partitions.map(partition => ({ ...partition })),
			metaSize: parsed.metaSize,
			metaDigest: parsed.metaDigest,
			recordCount: parsed.recordCount,
			uniqueTerms: parsed.uniqueTerms,
			totalBytes: parsed.totalBytes,
			duplicateIds: [...parsed.duplicateIds],
			sidecarIneligible: parsed.sidecarIneligible,
			chargedBytes: charged,
			budgetBytes: DICTIONARY_PARTITION_BUFFER_BYTES,
			partitionHashes: adoptedHashes,
			partitionSizes: adoptedSizes,
			partitionRecords: adoptedRecords,
		};
		try {
			runtime.dictionary.validatedDescriptor = this.#storage.statSync(runtime.dictionaryMetaPath);
		} catch {
			// Re-verification happens on first use.
		}
	}

	/**
	 * Incrementally maintain the dictionary artifact for one appended entry:
	 * append the partition line (fsync), rewrite the meta (fsync), and rebind
	 * the running digests before the commit marker is published. Any failure
	 * invalidates the whole artifact; the marker is then published without
	 * dictionary metadata and lookups fall back to the authoritative cold scan.
	 */
	#appendDictionaryRecord(index: {
		id: string;
		ordinal: number;
		seq: number;
		byteOffset: number;
		byteLength: number;
		recordDigest: string;
		parentId: string | null;
		entryType: string;
	}): boolean {
		const runtime = this.#sidecarRuntime;
		const dictionary = runtime?.dictionary;
		if (!dictionary) return true;
		const partition = dictionaryPartitionForId(index.id, dictionary.partitions.length);
		const partitionState = dictionary.partitions[partition];
		if (!partitionState) return false;
		const recordLine = serializeDictionaryPartitionRecord({
			term: index.id,
			dictId: dictionary.uniqueTerms,
			ordinal: index.ordinal,
			seq: index.seq,
			byteOffset: index.byteOffset,
			byteLength: index.byteLength,
			recordDigest: index.recordDigest,
			parentId: index.parentId,
			entryType: index.entryType,
		});
		const recordBytes = Buffer.byteLength(recordLine, "utf8");
		if (recordBytes > dictionary.budgetBytes) return false;
		try {
			const writer = this.#storage.openWriter(this.#dictionaryPartitionPath(partition), { flags: "a" });
			try {
				writer.writeLineSync(recordLine);
				if (!writer.fsyncSync) throw new Error("Synchronous dictionary partition fsync is unavailable");
				writer.fsyncSync();
			} finally {
				writer.closeSync();
			}
		} catch {
			return false;
		}
		dictionary.partitionHashes[partition]!.update(Buffer.from(recordLine, "utf8"));
		dictionary.partitionSizes[partition]! += recordBytes;
		dictionary.partitionRecords[partition]! += 1;
		partitionState.size = dictionary.partitionSizes[partition]!;
		partitionState.digest = dictionary.partitionHashes[partition]!.copy().digest("hex");
		partitionState.records = dictionary.partitionRecords[partition]!;
		dictionary.recordCount += 1;
		dictionary.uniqueTerms += 1;
		dictionary.totalBytes += Buffer.byteLength(index.id, "utf8");
		dictionary.indexDigest = runtime.indexDigest;
		const commit: Omit<DictionaryArtifactCommit, "metaSize" | "metaDigest"> = {
			header: {
				version: 2,
				sessionId: this.#sessionId ?? "",
				sidecarIneligible: dictionary.sidecarIneligible,
			},
			indexDigest: runtime.indexDigest,
			partitions: dictionary.partitions.map(partition => ({
				size: partition.size,
				digest: partition.digest,
				records: partition.records,
				complete: partition.complete,
			})),
			recordCount: dictionary.recordCount,
			uniqueTerms: dictionary.uniqueTerms,
			totalBytes: dictionary.totalBytes,
			duplicateIds: [...dictionary.duplicateIds],
			sidecarIneligible: dictionary.sidecarIneligible,
		};
		const meta = finalizeDictionaryArtifactCommit(commit);
		try {
			const metaWriter = this.#storage.openWriter(runtime.dictionaryMetaPath, { flags: "w" });
			try {
				metaWriter.writeLineSync(meta.bytes);
				if (!metaWriter.fsyncSync) throw new Error("Synchronous dictionary meta fsync is unavailable");
				metaWriter.fsyncSync();
			} finally {
				metaWriter.closeSync();
			}
		} catch {
			return false;
		}
		dictionary.metaSize = meta.commit.metaSize;
		dictionary.metaDigest = meta.commit.metaDigest;
		try {
			dictionary.validatedDescriptor = this.#storage.statSync(runtime.dictionaryMetaPath);
		} catch {
			// Re-verification happens on first use.
		}
		return true;
	}

	/** Fail closed: drop the retained dictionary state (files stay disposable; lookups use the idx scan). */
	#invalidateDictionaryArtifact(): void {
		const runtime = this.#sidecarRuntime;
		const dictionary = runtime?.dictionary;
		if (!dictionary) return;
		runtime.dictionary = undefined;
		if (dictionary.chargedBytes > 0) runtime.blockCache.release(dictionary.chargedBytes);
	}

	/** Serve one cold entry index from the persistent dictionary artifact (bounded partition read). */
	#findColdEntryIndexFromDictionary(id: string): ColdEntryIndex | undefined {
		const runtime = this.#sidecarRuntime;
		const dictionary = runtime?.dictionary;
		if (!dictionary || typeof this.#storage.readRangeSync !== "function") return undefined;
		if (dictionary.indexDigest !== runtime.indexDigest) return undefined;
		let indexStat: SessionStorageStat;
		try {
			indexStat = this.#storage.statSync(runtime.indexPath);
		} catch {
			return undefined;
		}
		if (!runtime.validatedIndexDescriptor || !sameDescriptor(runtime.validatedIndexDescriptor, indexStat))
			return undefined;
		const partition = dictionaryPartitionForId(id, dictionary.partitions.length);
		const committed = dictionary.partitions[partition];
		if (!committed?.complete || committed.size === 0) return undefined;
		let partitionStat: SessionStorageStat;
		try {
			partitionStat = this.#storage.statSync(this.#dictionaryPartitionPath(partition));
		} catch {
			return undefined;
		}
		if (partitionStat.size !== committed.size) return undefined;
		// One bounded chunked pass: incrementally hash the exact bytes while
		// locating the lossless term; the record is trusted only after the whole
		// partition verifies against the committed digest.
		const hash = crypto.createHash("sha256");
		const decoder = new TextDecoder("utf-8");
		let carry = "";
		let carryBytes: Uint8Array | undefined;
		let found: ColdEntryIndex | undefined;
		const targetPrefix = `{"t":${JSON.stringify(id)},`;
		let residentBytes = 0;
		for (let offset = 0; offset < committed.size; offset += 64 * 1024) {
			const length = Math.min(64 * 1024, committed.size - offset);
			let bytes: Uint8Array;
			try {
				bytes = this.#storage.readRangeSync(this.#dictionaryPartitionPath(partition), offset, length).bytes;
			} catch {
				return undefined;
			}
			hash.update(bytes);
			const text = decoder.decode(bytes, { stream: offset + length < committed.size });
			let lineStart = 0;
			let newline = text.indexOf("\n");
			const dispatchLine = (line: string): boolean => {
				// The committed digest authenticates every byte in this immutable partition;
				// parse only the exact target term instead of JSON-decoding every unrelated
				// record in the partition's bounded verification pass.
				if (!line.startsWith(targetPrefix)) return true;
				const record = parseDictionaryPartitionRecord(line);
				if (!record || record.term !== id) return false;
				if (record.dictId < 0) return false;
				found = {
					ordinal: record.ordinal,
					seq: record.seq,
					byteOffset: record.byteOffset,
					byteLength: record.byteLength,
					recordDigest: record.recordDigest,
					parentId: record.parentId,
					...(record.entryType.length > 0 ? { entryType: record.entryType } : {}),
				};
				residentBytes = line.length * 2 + 48;
				return true;
			};
			while (newline >= 0) {
				const line =
					carry === "" && carryBytes === undefined
						? text.slice(lineStart, newline)
						: `${carry}${text.slice(lineStart, newline)}`;
				carry = "";
				carryBytes = undefined;
				if (!dispatchLine(line)) return undefined;
				lineStart = newline + 1;
				newline = text.indexOf("\n", lineStart);
			}
			carry = `${carry}${text.slice(lineStart)}`;
		}
		if (carry !== "") return undefined;
		if (hash.digest("hex") !== committed.digest) return undefined;
		if (!found) return undefined;
		if (!runtime.coldEntries.has(id) && runtime.blockCache.tryAllocate(residentBytes))
			runtime.coldEntries.set(id, found);
		return found;
	}

	// =========================================================================
	// Persistent metadata-delta section (demoted reducer/provider values)
	// =========================================================================

	/** Fresh metadata-delta runtime state for a build or adoption. */
	#createMetadataDeltaRuntimeState(): MetadataDeltaArtifactRuntimeState {
		return {
			indexDigest: "",
			size: 0,
			sha256: "",
			hash: crypto.createHash("sha256"),
			byKey: new Map(),
			descriptorBytes: 0,
			budgetBytes: REDUCER_BUDGET_BYTES,
		};
	}

	/** Resident bytes of one retained delta descriptor (key + kind + sha256 + object + descriptor). */
	#metadataDeltaDescriptorCharge(key: string, kind: string): number {
		return metadataDeltaDescriptorResidentBytes(key) + residentStringBytes(kind) + 2 * 64 + 16 + 8;
	}

	/** Reconcile the reducer-bucket descriptor accounting with the current byKey set. */
	#syncMetadataDeltaDescriptorBytes(): void {
		const delta = this.#sidecarRuntime?.metadataDelta;
		if (!delta) return;
		let total = 0;
		for (const [key, value] of delta.byKey) total += this.#metadataDeltaDescriptorCharge(key, value.kind);
		delta.descriptorBytes = total;
	}

	/**
	 * Append one provider value's exact line bytes to the metadata-delta section
	 * (fsync before returning). Returns the exact value location + digest, or
	 * `undefined` when the fixed 4 MiB reducer budget would be exceeded or the
	 * write fails — the caller then keeps the value inline (fail closed to the
	 * pre-demotion eager marker semantics).
	 */
	#appendMetadataDeltaValue(lineBytes: Uint8Array): { offset: number; length: number; sha256: string } | undefined {
		const runtime = this.#sidecarRuntime;
		const delta = runtime?.metadataDelta;
		if (!delta) return undefined;
		if (delta.size + lineBytes.byteLength > delta.budgetBytes) return undefined;
		try {
			const writer = this.#storage.openWriter(runtime.metadataDeltaPath, { flags: delta.size === 0 ? "w" : "a" });
			try {
				writer.writeLineSync(Buffer.from(lineBytes).toString("utf8"));
				if (!writer.fsyncSync) throw new Error("Synchronous metadata-delta fsync is unavailable");
				writer.fsyncSync();
			} finally {
				writer.closeSync();
			}
		} catch {
			return undefined;
		}
		const offset = delta.size;
		delta.hash.update(Buffer.from(lineBytes));
		delta.size += lineBytes.byteLength;
		delta.sha256 = delta.hash.copy().digest("hex");
		return { offset, length: lineBytes.byteLength, sha256: computeLineDigest(Buffer.from(lineBytes)) };
	}

	/**
	 * Derive the marker's metadata-delta binding from the current runtime state.
	 * Positions are the merged provider-list indices, so reopen reproduces the
	 * exact ordered provider list. Absent when no value is demoted.
	 */
	#buildMetadataDeltaCommit(): MetadataDeltaArtifactCommit | undefined {
		const runtime = this.#sidecarRuntime;
		const delta = runtime?.metadataDelta;
		if (!delta || delta.byKey.size === 0) return undefined;
		const values: MetadataDeltaValue[] = [];
		runtime.providerStateOrder.forEach((key, position) => {
			const stored = delta.byKey.get(key);
			if (!stored) return;
			values.push({ key, ...stored, position });
		});
		if (values.length === 0) return undefined;
		return { indexDigest: delta.indexDigest, size: delta.size, sha256: delta.sha256, values };
	}

	/**
	 * The marker's inline provider list: the merged provider order minus the
	 * demoted entries (those are carried as metadata-delta descriptors with
	 * their exact merged positions, so reopen reproduces the merged order).
	 */
	#markerProviderStateEntries(): SessionEntry[] {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return [];
		const delta = runtime.metadataDelta;
		if (!delta || delta.byKey.size === 0) return runtime.providerStateEntries.map(cloneSessionEntry);
		const inlineByKey = new Map<string, SessionEntry>();
		for (const entry of runtime.providerStateEntries) {
			const key = providerStateEntryKey(entry);
			if (key) inlineByKey.set(key, entry);
		}
		const inline: SessionEntry[] = [];
		for (const key of runtime.providerStateOrder) {
			const entry = inlineByKey.get(key);
			if (entry) inline.push(cloneSessionEntry(entry));
		}
		return inline;
	}

	/** Read one demoted value's exact bytes, verify its digest, and parse it strictly. */
	#rehydrateMetadataDeltaValue(fileBytes: Uint8Array, value: MetadataDeltaValue): SessionEntry | undefined {
		if (value.offset + value.length > fileBytes.byteLength) return undefined;
		const bytes = fileBytes.subarray(value.offset, value.offset + value.length);
		if (computeLineDigest(bytes) !== value.sha256) return undefined;
		let entry: unknown;
		try {
			entry = JSON.parse(Buffer.from(bytes).toString("utf8"));
		} catch {
			return undefined;
		}
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const candidate = entry as SessionEntry;
		if (candidate.type !== value.kind) return undefined;
		if (!isProviderStateEntry(candidate)) return undefined;
		if (providerStateEntryKey(candidate) !== value.key) return undefined;
		return candidate;
	}

	/**
	 * Verify the committed metadata-delta binding (exact size + SHA-256 over the
	 * file bytes + covered index digest), validate every demoted value's bytes
	 * (transient rehydration), and rebuild the exact merged provider order as
	 * keys. Demoted values are NOT retained resident — only their descriptors
	 * are kept, and the provider context rehydrates them on demand. Any
	 * ambiguity fails closed (returns false → the caller falls back to the
	 * eager authoritative path).
	 */
	#adoptCommittedMetadataDelta(commit: MetadataDeltaArtifactCommit | undefined): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime) {
			return false;
		}
		if (commit === undefined) {
			const providerKeys = new Set<string>();
			for (const entry of runtime.providerStateEntries) {
				const key = providerStateEntryKey(entry);
				if (!key || providerKeys.has(key)) return false;
				providerKeys.add(key);
			}
			runtime.metadataDelta = undefined;
			runtime.providerStateOrder = runtime.providerStateEntries
				.map(providerStateEntryKey)
				.filter((key): key is string => key !== undefined);
			return true;
		}
		if (!isValidMetadataDeltaCommit(commit)) return false;
		if (commit.indexDigest !== runtime.indexDigest) return false;
		if (commit.size > REDUCER_BUDGET_BYTES) return false;
		if (commit.values.length + runtime.providerStateEntries.length > 256) return false;
		if (Buffer.byteLength(JSON.stringify(runtime.providerStateEntries), "utf8") + commit.size > REDUCER_BUDGET_BYTES)
			return false;
		const providerKeys = new Set<string>();
		for (const entry of runtime.providerStateEntries) {
			const key = providerStateEntryKey(entry);
			if (!key || providerKeys.has(key)) return false;
			providerKeys.add(key);
		}
		for (const value of commit.values) {
			if (providerKeys.has(value.key)) return false;
			providerKeys.add(value.key);
		}
		if (typeof this.#storage.readRangeSync !== "function") return false;
		let fileBytes: Uint8Array;
		try {
			const stat = this.#storage.statSync(runtime.metadataDeltaPath);
			if (stat.size !== commit.size) return false;
			fileBytes = this.#storage.readRangeSync(runtime.metadataDeltaPath, 0, commit.size).bytes;
		} catch {
			return false;
		}
		if (computeLineDigest(fileBytes) !== commit.sha256) return false;
		// Transient validation: every demoted value's exact bytes must parse to a
		// matching provider entry. The parsed entries are not retained.
		for (const value of commit.values) {
			if (!this.#rehydrateMetadataDeltaValue(fileBytes, value)) return false;
		}
		// Merge the exact slot sequence: demoted keys occupy their positions;
		// inline keys (marker order) fill the remaining slots in order.
		const slots: Array<string | undefined> = new Array(
			runtime.providerStateEntries.length + commit.values.length,
		).fill(undefined);
		for (const value of commit.values) {
			if (value.position < 0 || value.position >= slots.length || slots[value.position] !== undefined) return false;
			slots[value.position] = value.key;
		}
		let inlineIndex = 0;
		for (let slot = 0; slot < slots.length; slot++) {
			if (slots[slot] !== undefined) continue;
			if (inlineIndex >= runtime.providerStateEntries.length) return false;
			const key = providerStateEntryKey(runtime.providerStateEntries[inlineIndex++]!);
			if (!key) return false;
			slots[slot] = key;
		}
		if (inlineIndex !== runtime.providerStateEntries.length) return false;
		const delta = this.#createMetadataDeltaRuntimeState();
		delta.indexDigest = commit.indexDigest;
		delta.size = commit.size;
		delta.sha256 = commit.sha256;
		delta.hash = crypto.createHash("sha256").update(fileBytes);
		for (const value of commit.values) {
			delta.byKey.set(value.key, {
				kind: value.kind,
				ordinal: value.ordinal,
				offset: value.offset,
				length: value.length,
				sha256: value.sha256,
			});
		}
		runtime.metadataDelta = delta;
		this.#syncMetadataDeltaDescriptorBytes();
		try {
			delta.validatedDescriptor = this.#storage.statSync(runtime.metadataDeltaPath);
		} catch {
			// Re-verification happens on first use.
		}
		runtime.providerStateOrder = slots as string[];
		return true;
	}

	/**
	 * The merged provider list for the provider-context builder: inline entries
	 * in merged order plus on-demand bounded rehydration of demoted values from
	 * the authenticated metadata-delta section. Returns `undefined` on any
	 * inconsistency (callers fall back to the authoritative eager path).
	 */
	#resolvedProviderStateEntries(): SessionEntry[] | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return undefined;
		const delta = runtime.metadataDelta;
		const inlineByKey = new Map<string, SessionEntry>();
		for (const entry of runtime.providerStateEntries) {
			const key = providerStateEntryKey(entry);
			if (key) inlineByKey.set(key, entry);
		}
		if (!delta || delta.byKey.size === 0) {
			// No demoted values: the merged order equals the inline list.
			return runtime.providerStateOrder
				.map(key => inlineByKey.get(key))
				.filter((entry): entry is SessionEntry => entry !== undefined);
		}
		if (typeof this.#storage.readRangeSync !== "function") return undefined;
		let fileBytes: Uint8Array;
		try {
			const stat = this.#storage.statSync(runtime.metadataDeltaPath);
			if (stat.size !== delta.size) return undefined;
			fileBytes = this.#storage.readRangeSync(runtime.metadataDeltaPath, 0, delta.size).bytes;
		} catch {
			return undefined;
		}
		if (computeLineDigest(fileBytes) !== delta.sha256) return undefined;
		const resolved: SessionEntry[] = [];
		for (const key of runtime.providerStateOrder) {
			const inline = inlineByKey.get(key);
			if (inline) {
				resolved.push(inline);
				continue;
			}
			const stored = delta.byKey.get(key);
			if (!stored) return undefined;
			const value: MetadataDeltaValue = { key, ...stored, position: -1 };
			const entry = this.#rehydrateMetadataDeltaValue(fileBytes, value);
			if (!entry) return undefined;
			resolved.push(entry);
		}
		return resolved;
	}

	/**
	 * Incrementally maintain the parent artifact for one appended entry. The
	 * bucket record is appended and fsynced BEFORE the commit marker is
	 * published, so a marker never claims parent metadata that lacks the new
	 * edge. Returns false when the artifact cannot safely cover the append
	 * (bound exceeded, external bucket mutation, or I/O failure); the caller
	 * then invalidates the whole artifact and the marker is published without
	 * parent metadata.
	 */
	#appendParentArtifactRecord(
		parentId: string,
		index: {
			childId: string;
			ordinal: number;
			seq: number;
			byteOffset: number;
			byteLength: number;
			recordDigest: string;
			entryType?: string;
		},
	): boolean {
		const runtime = this.#sidecarRuntime;
		const artifact = runtime?.parentArtifact;
		if (!artifact) return true;
		const bucket = parentBucketForId(parentId, artifact.buckets.length);
		const bucketState = artifact.buckets[bucket];
		if (!bucketState) return false;
		if (!bucketState.complete) return false;
		const recordLine = serializeParentBucketRecord({
			parentId,
			childId: index.childId,
			ordinal: index.ordinal,
			seq: index.seq,
			byteOffset: index.byteOffset,
			byteLength: index.byteLength,
			recordDigest: index.recordDigest,
			entryType: index.entryType,
		});
		const recordBytes = Buffer.byteLength(recordLine, "utf8");
		try {
			if (typeof this.#storage.readRangeSync !== "function") return false;
			let currentBytes: Uint8Array;
			try {
				const current = this.#storage.statSync(this.#parentBucketPath(bucket));
				if (current.size !== bucketState.size || current.size > PARENT_CHILDREN_BUDGET_BYTES) return false;
				currentBytes = this.#storage.readRangeSync(this.#parentBucketPath(bucket), 0, current.size).bytes;
			} catch {
				if (bucketState.size !== 0) return false;
				currentBytes = Buffer.alloc(0);
			}
			const digest = crypto.createHash("sha256").update(currentBytes).digest("hex");
			if (digest !== bucketState.digest || currentBytes.byteLength !== bucketState.size) return false;
			const childCount = countParentBucketRecords(currentBytes, parentId);
			if (childCount >= PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT) return false;
			if (artifact.totalBytes + recordBytes > artifact.budgetBytes) return false;
			const writer = this.#storage.openWriter(this.#parentBucketPath(bucket), { flags: "a" });
			try {
				writer.writeLineSync(recordLine);
				if (!writer.fsyncSync) throw new Error("Synchronous parent bucket fsync is unavailable");
				writer.fsyncSync();
			} finally {
				writer.closeSync();
			}
			const after = this.#storage.statSync(this.#parentBucketPath(bucket));
			const afterBytes = this.#storage.readRangeSync(this.#parentBucketPath(bucket), 0, after.size).bytes;
			bucketState.size = after.size;
			bucketState.digest = crypto.createHash("sha256").update(afterBytes).digest("hex");
			artifact.totalBytes = artifact.buckets.reduce((total, bucket) => total + bucket.size, 0);
			// The artifact now covers the exact index bytes (including the appended
			// line); rebind so the next marker's parentIndex matches its indexDigest.
			artifact.indexDigest = runtime.indexDigest;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Serve one parent's direct children from the persistent artifact: read a
	 * single bucket (bounded), verify its exact bytes against the committed
	 * digest, filter hash collisions by parent id, then resolve every child
	 * from the transcript. Any malformed/corrupt/missing/stale evidence returns
	 * undefined so the caller falls back to the authoritative cold scan.
	 */
	#readParentChildrenFromArtifact(parentId: string, indexStat: SessionStorageStat): SessionEntry[] | undefined {
		const runtime = this.#sidecarRuntime;
		const artifact = runtime?.parentArtifact;
		if (!artifact) return undefined;
		const fail = (): undefined => {
			this.#invalidateParentArtifact();
			return undefined;
		};
		if (typeof this.#storage.readRangeSync !== "function") return undefined;
		const bucket = parentBucketForId(parentId, artifact.buckets.length);
		const committed = artifact.buckets[bucket];
		if (!committed) return undefined;
		if (!committed.complete) return fail();

		let bucketStat: SessionStorageStat;
		let bytes: Uint8Array;
		try {
			bucketStat = this.#storage.statSync(this.#parentBucketPath(bucket));
			if (bucketStat.size !== committed.size || bucketStat.size > PARENT_CHILDREN_BUDGET_BYTES) return fail();
			bytes = this.#storage.readRangeSync(this.#parentBucketPath(bucket), 0, bucketStat.size).bytes;
		} catch {
			return fail();
		}
		const digest = crypto.createHash("sha256").update(bytes).digest("hex");
		if (digest !== committed.digest) return fail();
		const records: Array<{ childId: string; index: ColdEntryIndex; residentBytes: number }> = [];
		const decoder = new TextDecoder("utf-8");
		let carry = "";
		let malformed = false;
		for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
			const length = Math.min(64 * 1024, bytes.byteLength - offset);
			const text =
				carry +
				decoder.decode(bytes.subarray(offset, offset + length), {
					stream: offset + length < bytes.byteLength,
				});
			const lines = text.split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) {
					malformed = true;
					break;
				}
				const record = parseParentBucketRecord(line);
				if (!record) {
					malformed = true;
					break;
				}
				if (record.parentId !== parentId) continue;
				records.push({
					childId: record.childId,
					index: {
						ordinal: record.ordinal,
						seq: record.seq,
						byteOffset: record.byteOffset,
						byteLength: record.byteLength,
						recordDigest: record.recordDigest,
						parentId,
						...(record.entryType !== undefined ? { entryType: record.entryType } : {}),
					},
					residentBytes: line.length * 2 + 48,
				});
			}
			if (malformed) break;
		}
		if (carry.length > 0) malformed = true;
		if (malformed || records.length > PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT) return fail();
		for (const record of records) {
			if (!runtime.coldEntries.has(record.childId) && runtime.blockCache.tryAllocate(record.residentBytes))
				runtime.coldEntries.set(record.childId, record.index);
		}
		const cache = new Map<string, string>();
		const children: SessionEntry[] = [];
		for (const record of records) {
			const entry = this.#resolveColdChild(record.childId, record.index, parentId);
			if (!entry) return fail();
			children.push(
				cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), cache)),
			);
		}
		const cacheBytes =
			residentStringBytes(parentId) +
			48 +
			records.reduce((total, record) => total + residentStringBytes(record.childId) + 8, 0);
		if (runtime.blockCache.tryAllocate(cacheBytes)) {
			runtime.parentChildrenCache.set(parentId, {
				ids: records.map(record => record.childId),
				bytes: cacheBytes,
				descriptor: indexStat,
				bucketDescriptor: bucketStat,
				bucketIndex: bucket,
			});
		}
		return children;
	}

	/** Resolve one artifact-referenced child from the transcript, verifying parent identity. */
	#resolveColdChild(id: string, index: ColdEntryIndex, parentId: string): SessionEntry | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return undefined;
		const bytes = this.#readColdEntryRange(index);
		if (!bytes || computeLineDigest(bytes) !== index.recordDigest) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
		} catch {
			return undefined;
		}
		if (parsed === null || typeof parsed !== "object") return undefined;
		const entry = parsed as SessionEntry;
		if (
			entry.id !== id ||
			entry.parentId !== parentId ||
			(typeof index.entryType === "string" && entry.type !== index.entryType)
		)
			return undefined;
		residentizePersistedBlobRefs(entry);
		if (!runtime.entryCache.tryAllocate(bytes.byteLength)) return entry;
		this.#byId.set(id, entry);
		return entry;
	}

	/** True when the bucket backing an artifact-seeded cache entry still matches its validated descriptor. */
	#parentBucketDescriptorMatches(descriptor: SessionStorageStat, bucketIndex: number | undefined): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.parentPathPrefix || bucketIndex === undefined) return false;
		try {
			const current = this.#storage.statSync(this.#parentBucketPath(bucketIndex));
			return sameDescriptor(current, descriptor);
		} catch {
			return false;
		}
	}

	/** Every disposable sidecar path, including persistent dictionary/metadata artifacts. */
	#disposableSidecarPaths(): string[] {
		const runtime = this.#sidecarRuntime;
		if (!runtime) return [];
		return [
			runtime.indexPath,
			runtime.tailPath,
			runtime.commitPath,
			runtime.dictionaryMetaPath,
			runtime.metadataDeltaPath,
			...dictionaryPartitionPaths(runtime.indexPath),
			...parentBucketPaths(runtime.indexPath),
		];
	}
	#validateColdBase(base = this.#sidecarRuntime?.base): boolean {
		const runtime = this.#sidecarRuntime;
		const sessionFile = this.#sessionFile;
		if (!runtime?.enabled || !base || !sessionFile || typeof this.#storage.readRangeSync !== "function") return false;
		const hash = crypto.createHash("sha256");
		try {
			for (let offset = 0; offset < base.baseEndOffset; offset += 64 * 1024) {
				const length = Math.min(64 * 1024, base.baseEndOffset - offset);
				hash.update(this.#readRangeSync(sessionFile, offset, length).bytes);
				if (((offset + length) & (8 * 1024 * 1024 - 1)) === 0) Bun.gc(true);
			}
		} catch {
			return false;
		}
		return hash.digest("hex") === base.baseDigest;
	}

	/**
	 * Retire the provider-invisible prefix of `#fileEntries`/`#byId` into the cold
	 * region, keeping a bounded hot suffix (≤ 16 MiB / post-compaction boundary).
	 * Returns the count of retired entries. Fails closed (retires nothing) when the
	 * sidecar is unavailable or ineligible.
	 */
	#retireColdEntries(hotSuffixBytes = this.#sidecarHotSuffixBudgetBytes): number {
		const runtime = this.#sidecarRuntime;
		const fail = (reason: string): 0 => {
			this.#retirementFallbackReason = reason;
			return 0;
		};
		if (!runtime?.enabled || runtime.sidecarIneligible || this.#fileEntries.length === 0)
			return fail("sidecar_unavailable");
		const retirementFirstKeptEntryId = runtime.retirementFirstKeptEntryId;
		if (!retirementFirstKeptEntryId) return fail("boundary_unavailable");
		const firstKeptIndex = this.#fileEntries.findIndex(
			entry => entry.type !== "session" && entry.id === retirementFirstKeptEntryId,
		);
		if (firstKeptIndex <= 0) return fail("boundary_not_retirable");
		if (!this.#fileEntries.slice(0, firstKeptIndex).some(entry => entry.type !== "session"))
			return fail("no_cold_entries");
		if (!this.#validateColdBase()) return fail("base_invalid");
		const activeHotIds = new Set<string>();
		let active = this.#leafId ? this.#byId.get(this.#leafId) : undefined;
		let reachedBoundary = false;
		while (active) {
			activeHotIds.add(active.id);
			if (active.id === retirementFirstKeptEntryId) {
				reachedBoundary = true;
				break;
			}
			active = active.parentId ? this.#byId.get(active.parentId) : undefined;
		}
		if (!reachedBoundary) return fail("boundary_not_active");
		let retainedBytes = 0;
		let retainedAccountedBytes = 0;
		for (const entry of this.#fileEntries) {
			if (entry.type === "session" || !activeHotIds.has(entry.id)) continue;
			const serializedBytes = this.#serializeEntryLine(entry).byteLength;
			retainedBytes += serializedBytes;
			retainedAccountedBytes += residentHotEntryBytes(serializedBytes);
			if (retainedBytes > hotSuffixBytes) return fail("hot_suffix_budget");
		}
		const fixedReservedBytes =
			runtime.blockCache.budgetBytes +
			runtime.entryCache.budgetBytes +
			runtime.tailCache.budgetBytes +
			REDUCER_BUDGET_BYTES +
			LABELS_PINS_BUDGET_BYTES +
			1024 * 1024;
		const targetAccountedBytes = fixedReservedBytes + retainedAccountedBytes;
		const accountedDelta = targetAccountedBytes - runtime.accountant.totalBytes;
		if (accountedDelta > 0 && !runtime.accountant.tryCharge(accountedDelta)) return fail("accounting_budget");
		if (accountedDelta < 0) runtime.accountant.release(-accountedDelta);
		let retired = 0;
		for (const entry of this.#fileEntries) {
			if (entry.type !== "session" && !activeHotIds.has(entry.id)) retired++;
		}
		runtime.coldEntriesRetired += retired;
		runtime.transcriptGeneration++;
		runtime.sidecarRebuildCount++;
		this.#fileEntries = this.#fileEntries.filter(entry => entry.type === "session" || activeHotIds.has(entry.id));
		this.#byId = new Map(
			this.#fileEntries
				.filter((entry): entry is SessionEntry => entry.type !== "session")
				.map(entry => [entry.id, entry]),
		);
		this.#resetMaterializedCaches();
		const aggregateUsageStatistics = this.#usageStatistics;
		const transition = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: this.#sessionId, sessionFile: this.#sessionFile ?? "" },
				primary: {
					mode: "materialize",
					sourceEntries: this.#fileEntries,
					sourceStores: {
						textStore: this.#residentTextBlobStore,
						imageStore: this.#residentImageBlobStore,
					},
				},
			},
			"memory-fallback",
		);
		this.#commitResidentTextStoreTransition(transition, false);
		this.#usageStatistics = aggregateUsageStatistics;
		runtime.hotSuffixBytes = retainedBytes;
		this.#retirementFallbackReason = undefined;
		return retired;
	}

	#coldIndexDigestValid(): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || !runtime.indexPath || typeof this.#storage.readRangeSync !== "function") return false;
		let descriptor: SessionStorageStat;
		try {
			descriptor = this.#storage.statSync(runtime.indexPath);
			const hash = crypto.createHash("sha256");
			for (let offset = 0; offset < descriptor.size; offset += 64 * 1024) {
				const length = Math.min(64 * 1024, descriptor.size - offset);
				hash.update(this.#storage.readRangeSync(runtime.indexPath, offset, length).bytes);
			}
			const valid = hash.digest("hex") === runtime.indexDigest;
			if (valid) runtime.validatedIndexDescriptor = descriptor;
			return valid;
		} catch {
			return false;
		}
	}

	#coldTailMatchesDisk(): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || !runtime.tailPath || typeof this.#storage.readRangeSync !== "function") return false;
		let size: number;
		try {
			size = this.#storage.statSync(runtime.tailPath).size;
		} catch {
			return false;
		}
		if (size > runtime.tailCache.budgetBytes) return false;
		let ordinal = 0;
		const failure = scanTranscriptLinesBounded(this.#storage, runtime.tailPath, size, (_offset, lineBytes) => {
			const expected = runtime.tail.records[ordinal++];
			if (!expected) return false;
			try {
				const actual = JSON.parse(decodeBoundedJsonLine(lineBytes));
				if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
			} catch {
				return false;
			}
		});
		return failure === undefined && ordinal === runtime.tail.records.length;
	}

	#findColdEntryIndex(id: string, cacheLocality = true): ColdEntryIndex | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || !runtime.indexPath || typeof this.#storage.readRangeSync !== "function")
			return undefined;
		const cached = runtime.coldEntries.get(id);
		if (cached) {
			try {
				const current = this.#storage.statSync(runtime.indexPath);
				if (runtime.validatedIndexDescriptor && sameDescriptor(runtime.validatedIndexDescriptor, current))
					return cached;
			} catch {
				return undefined;
			}
			runtime.coldEntries.clear();
			runtime.parentChildrenCache.clear();
			runtime.parentArtifact = undefined;
			runtime.blockCache.release(runtime.blockCache.allocatedBytes);
			runtime.validatedIndexDescriptor = undefined;
		}
		const dictionaryIndex = this.#findColdEntryIndexFromDictionary(id);
		if (dictionaryIndex) return dictionaryIndex;
		if (!this.#coldIndexDigestValid()) return undefined;
		let size: number;
		try {
			size = this.#storage.statSync(runtime.indexPath).size;
		} catch {
			return undefined;
		}
		const decoder = new TextDecoder("utf-8");
		let carry = "";
		const recent = new Map<string, { index: ColdEntryIndex; bytes: number }>();
		let recentBytes = 0;
		for (let offset = 0; offset < size; offset += 64 * 1024) {
			const length = Math.min(64 * 1024, size - offset);
			let bytes: Uint8Array;
			try {
				bytes = this.#storage.readRangeSync(runtime.indexPath, offset, length).bytes;
			} catch {
				return undefined;
			}
			const text = carry + decoder.decode(bytes, { stream: offset + length < size });
			const lines = text.split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				try {
					const value = JSON.parse(line) as Partial<ColdEntryIndex> & { id?: unknown };
					if (
						typeof value.id === "string" &&
						typeof value.ordinal === "number" &&
						typeof value.seq === "number" &&
						typeof value.byteOffset === "number" &&
						typeof value.byteLength === "number" &&
						typeof value.recordDigest === "string"
					) {
						const found: ColdEntryIndex = {
							ordinal: value.ordinal,
							seq: value.seq,
							byteOffset: value.byteOffset,
							byteLength: value.byteLength,
							recordDigest: value.recordDigest,
							...(value.parentId === null || typeof value.parentId === "string"
								? { parentId: value.parentId }
								: {}),
							...(typeof value.entryType === "string" ? { entryType: value.entryType } : {}),
						};
						if (cacheLocality) {
							const residentBytes = line.length * 2 + 48;
							recent.set(value.id, { index: found, bytes: residentBytes });
							recentBytes += residentBytes;
							while (recentBytes > runtime.blockCache.budgetBytes && recent.size > 1) {
								const oldestId = recent.keys().next().value;
								if (typeof oldestId !== "string") break;
								const removed = recent.get(oldestId);
								recent.delete(oldestId);
								if (removed) recentBytes -= removed.bytes;
							}
						}
						if (value.id === id) {
							if (cacheLocality)
								for (const [candidateId, candidate] of recent) {
									if (!runtime.coldEntries.has(candidateId) && runtime.blockCache.tryAllocate(candidate.bytes))
										runtime.coldEntries.set(candidateId, candidate.index);
								}
							return found;
						}
					}
				} catch {
					// A corrupt disposable index line is ignored; transcript remains authoritative.
				}
			}
		}
		return undefined;
	}

	#validateColdIndexCoverage(sessionFile: string, transcriptSize: number, expectedDigest: string): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.indexPath || typeof this.#storage.readRangeSync !== "function") return false;
		let diskIds: DiskBackedIdUniquenessCheck;
		try {
			diskIds = new DiskBackedIdUniquenessCheck();
		} catch {
			return false;
		}
		let ordinal = 0;
		let expectedOffset: number | undefined;
		let firstOffset: number | undefined;
		let valid = true;
		const indexHash = crypto.createHash("sha256");
		let size: number;
		try {
			size = this.#storage.statSync(runtime.indexPath).size;
		} catch {
			diskIds.dispose();
			return false;
		}
		const failure = scanTranscriptLinesBounded(this.#storage, runtime.indexPath, size, (_offset, lineBytes) => {
			indexHash.update(lineBytes);
			try {
				const value = JSON.parse(decodeBoundedJsonLine(lineBytes)) as Partial<ColdEntryIndex> & { id?: unknown };
				if (
					typeof value.id !== "string" ||
					typeof value.ordinal !== "number" ||
					!Number.isSafeInteger(value.ordinal) ||
					typeof value.seq !== "number" ||
					!Number.isSafeInteger(value.seq) ||
					typeof value.byteOffset !== "number" ||
					!Number.isSafeInteger(value.byteOffset) ||
					typeof value.byteLength !== "number" ||
					!Number.isSafeInteger(value.byteLength) ||
					typeof value.recordDigest !== "string" ||
					!/^[0-9a-f]{64}$/.test(value.recordDigest) ||
					(value.parentId !== null && typeof value.parentId !== "string") ||
					typeof value.entryType !== "string" ||
					value.ordinal !== ordinal ||
					value.byteLength <= 0 ||
					(expectedOffset === undefined ? value.byteOffset <= 0 : value.byteOffset !== expectedOffset) ||
					!diskIds.add(value.id)
				) {
					valid = false;
					return false;
				}
				firstOffset ??= value.byteOffset;
				expectedOffset = value.byteOffset + value.byteLength;
				ordinal++;
			} catch {
				valid = false;
				return false;
			}
		});
		const idsUnique = diskIds.finish();
		const digestValid = indexHash.copy().digest("hex") === expectedDigest;
		if (!digestValid) this.#lazyReopenFallbackReason = "index_digest_mismatch";
		diskIds.dispose();
		if (
			failure ||
			!valid ||
			!idsUnique ||
			!digestValid ||
			ordinal === 0 ||
			expectedOffset !== transcriptSize ||
			firstOffset === undefined
		)
			return false;
		if (firstOffset > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES) return false;
		try {
			const headerBytes = this.#readRangeSync(sessionFile, 0, firstOffset).bytes;
			const headerValid =
				headerBytes.byteLength === firstOffset &&
				headerBytes.at(-1) === 0x0a &&
				Buffer.from(headerBytes).indexOf(0x0a) === headerBytes.byteLength - 1;
			if (headerValid) runtime.indexHash = indexHash;
			return headerValid;
		} catch {
			return false;
		}
	}

	#readAllColdEntryIndexes(): Array<ColdEntryIndex & { id: string }> {
		SessionManagerTestHooks.readAllColdEntryIndexesCalls =
			(SessionManagerTestHooks.readAllColdEntryIndexesCalls ?? 0) + 1;
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || !runtime.indexPath || typeof this.#storage.readRangeSync !== "function")
			throw new Error("cold_index_unavailable");
		if (!this.#coldIndexDigestValid()) throw new Error("cold_index_invalid");
		let size: number;
		try {
			size = this.#storage.statSync(runtime.indexPath).size;
		} catch {
			throw new Error("cold_index_unavailable");
		}
		const result: Array<ColdEntryIndex & { id: string }> = [];
		const ids = new Set<string>();
		const decoder = new TextDecoder("utf-8");
		let carry = "";
		for (let offset = 0; offset < size; offset += 64 * 1024) {
			const length = Math.min(64 * 1024, size - offset);
			const bytes = this.#storage.readRangeSync(runtime.indexPath, offset, length).bytes;
			const lines = (carry + decoder.decode(bytes, { stream: offset + length < size })).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) throw new Error("cold_index_malformed");
				try {
					const value = JSON.parse(line) as Partial<ColdEntryIndex> & { id?: unknown };
					if (
						typeof value.id !== "string" ||
						typeof value.ordinal !== "number" ||
						!Number.isSafeInteger(value.ordinal) ||
						typeof value.seq !== "number" ||
						!Number.isSafeInteger(value.seq) ||
						typeof value.byteOffset !== "number" ||
						!Number.isSafeInteger(value.byteOffset) ||
						typeof value.byteLength !== "number" ||
						!Number.isSafeInteger(value.byteLength) ||
						typeof value.recordDigest !== "string" ||
						!/^[0-9a-f]{64}$/.test(value.recordDigest) ||
						(value.parentId !== null && typeof value.parentId !== "string") ||
						typeof value.entryType !== "string"
					)
						throw new Error("cold_index_malformed");
					const previous = result.at(-1);
					if (
						value.ordinal !== result.length ||
						value.byteOffset < 0 ||
						value.byteLength <= 0 ||
						(previous ? previous.byteOffset + previous.byteLength !== value.byteOffset : value.byteOffset <= 0) ||
						ids.has(value.id)
					)
						throw new Error("cold_index_incomplete");
					ids.add(value.id);
					result.push(value as ColdEntryIndex & { id: string });
				} catch {
					throw new Error("cold_index_malformed");
				}
			}
		}
		if (carry.length > 0) throw new Error("cold_index_unterminated");
		const first = result[0];
		if (!first || first.byteOffset > BOUNDED_FIRST_OPEN_MAX_LINE_BYTES || !this.#sessionFile)
			throw new Error("cold_index_incomplete");
		const headerBytes = this.#readRangeSync(this.#sessionFile, 0, first.byteOffset).bytes;
		if (
			headerBytes.byteLength !== first.byteOffset ||
			headerBytes.at(-1) !== 0x0a ||
			Buffer.from(headerBytes).indexOf(0x0a) !== headerBytes.byteLength - 1
		)
			throw new Error("cold_index_incomplete");
		const last = result.at(-1);
		if (!last || last.byteOffset + last.byteLength !== runtime.tail.transcriptSize)
			throw new Error("cold_index_incomplete");
		return result;
	}

	/** Lazily resolve a possibly-cold entry by its full transcript byte range. */
	#readColdEntryRange(index: ColdEntryIndex): Uint8Array | undefined {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return undefined;
		try {
			const runtime = this.#sidecarRuntime;
			if (runtime) runtime.rangeReadCount++;
			return this.#readRangeSync(sessionFile, index.byteOffset, index.byteLength).bytes;
		} catch {
			return undefined;
		}
	}

	/** Rehydrate one cold entry back into the hot map (bounded by the entry cache). */
	#resolveEntry(id: string): SessionEntry | undefined {
		const hot = this.#byId.get(id);
		if (hot) return hot;
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled) return undefined;
		const fail = (): SessionEntry | undefined => {
			this.#hydrateAuthoritativeTranscriptSync(runtime);
			return this.#byId.get(id);
		};
		const index = this.#findColdEntryIndex(id);
		if (!index) return fail();
		const bytes = this.#readColdEntryRange(index);
		if (!bytes) return fail();
		if (computeLineDigest(bytes) !== index.recordDigest) return fail();
		let parsed: unknown;
		try {
			const text = new TextDecoder("utf-8").decode(bytes);
			parsed = JSON.parse(text);
		} catch {
			return fail();
		}
		if (parsed === null || typeof parsed !== "object" || typeof (parsed as { id?: unknown }).id !== "string") {
			return fail();
		}
		if (
			(parsed as { id?: unknown }).id !== id ||
			(typeof index.entryType === "string" && (parsed as SessionEntry).type !== index.entryType) ||
			("parentId" in index && (parsed as SessionEntry).parentId !== index.parentId)
		)
			return fail();
		const entry = sanitizeLoadedSessionEntryReplayMetadata(parsed as SessionEntry);
		residentizePersistedBlobRefs(entry);
		// Bound the entry cache; a full cache rejects the rehydration (still correct via rebuild).
		if (!runtime.entryCache.tryAllocate(bytes.byteLength)) return entry;
		this.#byId.set(id, entry);
		runtime.coldEntriesReloaded++;
		return entry;
	}

	#parseColdBranchEntry(
		id: string,
		index: ColdEntryIndex,
		recordBytes?: Uint8Array,
	): { entry: SessionEntry; index: ColdEntryIndex } | undefined {
		if (!("parentId" in index) || typeof index.entryType !== "string") return undefined;
		const bytes = recordBytes ?? this.#readColdEntryRange(index);
		if (!bytes || computeLineDigest(bytes) !== index.recordDigest) return undefined;
		try {
			const parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as SessionEntry;
			if (
				!parsed ||
				typeof parsed !== "object" ||
				parsed.id !== id ||
				parsed.type !== index.entryType ||
				parsed.parentId !== index.parentId
			)
				return undefined;
			const entry = sanitizeLoadedSessionEntryReplayMetadata(parsed);
			residentizePersistedBlobRefs(entry);
			return { entry, index };
		} catch {
			return undefined;
		}
	}

	#readColdBranchEntry(id: string): { entry: SessionEntry; index: ColdEntryIndex } | undefined {
		const index = this.#findColdEntryIndex(id);
		return index ? this.#parseColdBranchEntry(id, index) : undefined;
	}

	/**
	 * Prefetch one compacted cold branch by ordinal run. The index is ordered one
	 * line per transcript ordinal, so the scan skips JSON parsing outside the
	 * boundary..leaf interval and retains only that bounded interval. This avoids
	 * one persistent-dictionary partition scan per ancestor on 10k-entry switches.
	 */
	#prefetchColdBranchOrdinalRun(
		leafId: string,
	): Map<string, { entry: SessionEntry; index: ColdEntryIndex }> | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.indexPath || typeof this.#storage.readRangeSync !== "function") return undefined;
		const leaf = this.#readColdBranchEntry(leafId);
		if (leaf?.entry.type !== "compaction") return undefined;
		const boundaryIndex = this.#findColdEntryIndex(leaf.entry.firstKeptEntryId);
		if (!boundaryIndex || boundaryIndex.ordinal > leaf.index.ordinal) return undefined;
		const transcriptStart = boundaryIndex.byteOffset;
		const transcriptEnd = leaf.index.byteOffset + leaf.index.byteLength;
		const transcriptLength = transcriptEnd - transcriptStart;
		if (
			!coldBranchOrdinalRunWithinPrefetchBounds({
				boundaryOrdinal: boundaryIndex.ordinal,
				leafOrdinal: leaf.index.ordinal,
				transcriptStart,
				transcriptEnd,
				maxTranscriptBytes: SESSION_RANGE_READ_MAX_BYTES,
			})
		)
			return undefined;
		let indexSize: number;
		try {
			indexSize = this.#storage.statSync(runtime.indexPath).size;
		} catch {
			return undefined;
		}
		const indexes = new Map<string, ColdEntryIndex>();
		let ordinal = 0;
		let valid = true;
		const failure = scanTranscriptLinesBounded(this.#storage, runtime.indexPath, indexSize, (_offset, lineBytes) => {
			const currentOrdinal = ordinal++;
			if (currentOrdinal < boundaryIndex.ordinal || currentOrdinal > leaf.index.ordinal) return;
			try {
				const value = JSON.parse(decodeBoundedJsonLine(lineBytes)) as Partial<ColdEntryIndex> & { id?: unknown };
				if (
					typeof value.id !== "string" ||
					value.ordinal !== currentOrdinal ||
					typeof value.seq !== "number" ||
					typeof value.byteOffset !== "number" ||
					typeof value.byteLength !== "number" ||
					typeof value.recordDigest !== "string" ||
					(value.parentId !== null && typeof value.parentId !== "string") ||
					typeof value.entryType !== "string"
				) {
					valid = false;
					return false;
				}
				indexes.set(value.id, value as ColdEntryIndex);
			} catch {
				valid = false;
				return false;
			}
		});
		if (failure || !valid) return undefined;
		if (!this.#sessionFile) return undefined;
		let transcriptBytes: Uint8Array;
		try {
			runtime.rangeReadCount++;
			transcriptBytes = this.#readRangeSync(this.#sessionFile, transcriptStart, transcriptLength).bytes;
			if (transcriptBytes.byteLength !== transcriptLength) return undefined;
		} catch {
			return undefined;
		}
		const prefetched = new Map<string, { entry: SessionEntry; index: ColdEntryIndex }>();
		let currentId: string | null = leafId;
		let priorOrdinal = Number.POSITIVE_INFINITY;
		while (currentId !== null) {
			const index = indexes.get(currentId);
			if (!index || index.ordinal >= priorOrdinal) return undefined;
			priorOrdinal = index.ordinal;
			const recordBytes = transcriptBytes?.subarray(
				index.byteOffset - transcriptStart,
				index.byteOffset - transcriptStart + index.byteLength,
			);
			const resolved = this.#parseColdBranchEntry(currentId, index, recordBytes);
			if (!resolved) return undefined;
			prefetched.set(currentId, resolved);
			if (currentId === leaf.entry.firstKeptEntryId) return prefetched;
			currentId = resolved.entry.parentId;
		}
		return undefined;
	}

	#activateColdBranch(leafId: string): boolean {
		const runtime = this.#sidecarRuntime;
		if (
			!this.#coldSidecarActive() ||
			!runtime ||
			!this.#coldIndexDigestValid() ||
			!this.#coldTailMatchesDisk() ||
			!this.#validateColdBase(runtime.base)
		)
			return false;
		const retainedLeafToBoundary: SessionEntry[] = [];
		let retainedBytes = 0;
		let retainedAccountedBytes = 0;
		const prefetched = this.#prefetchColdBranchOrdinalRun(leafId);
		let currentId: string | null = leafId;
		let priorOrdinal = Number.POSITIVE_INFINITY;
		let boundaryId: string | undefined;
		let boundaryReached = false;
		const reducer: ReducerState = {
			modelChange: { latest: undefined },
			ttsr: { count: 0, rulesCount: 0, recordsCount: 0, largestOrdinal: -1 },
		};
		const providerState = new Map<string, { order: number; entry: SessionEntry }>();
		let providerStateBytes = 0;
		while (currentId !== null) {
			const resolved: { entry: SessionEntry; index: ColdEntryIndex } | undefined =
				prefetched?.get(currentId) ?? this.#readColdBranchEntry(currentId);
			if (!resolved || resolved.index.ordinal >= priorOrdinal) return false;
			priorOrdinal = resolved.index.ordinal;
			const entry: SessionEntry = resolved.entry;
			const index: ColdEntryIndex = resolved.index;
			const providerKey = providerStateEntryKey(entry);
			if (providerKey && !providerState.has(providerKey)) {
				if (providerState.size >= 256) return false;
				const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 64;
				if (providerStateBytes + entryBytes > REDUCER_BUDGET_BYTES) return false;
				providerStateBytes += entryBytes;
				providerState.set(providerKey, { order: index.ordinal, entry: cloneSessionEntry(entry) });
			}
			if (!boundaryReached) {
				retainedLeafToBoundary.push(entry);
				retainedBytes += index.byteLength;
				retainedAccountedBytes += residentHotEntryBytes(index.byteLength);
				if (retainedBytes > this.#sidecarHotSuffixBudgetBytes) return false;
			}
			if (entry.type === "model_change" && reducer.modelChange.latest === undefined) {
				reducer.modelChange.latest = { ordinal: index.ordinal, role: entry.role };
			} else if (entry.type === "ttsr_injection" && reducer.ttsr.largestOrdinal < 0) {
				reducer.ttsr = {
					count: entry.ttsrMessageCount ?? 0,
					rulesCount: entry.injectedRules.length,
					recordsCount: entry.injectedRuleRecords?.length ?? 0,
					largestOrdinal: index.ordinal,
				};
			}
			if (!boundaryId && entry.type === "compaction") boundaryId = entry.firstKeptEntryId;
			if (boundaryId && entry.id === boundaryId) boundaryReached = true;
			currentId = entry.parentId;
		}
		if (!boundaryId || !boundaryReached) return false;
		const header = this.#fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
		if (!header) return false;
		const fixedReservedBytes =
			runtime.blockCache.budgetBytes +
			runtime.entryCache.budgetBytes +
			runtime.tailCache.budgetBytes +
			REDUCER_BUDGET_BYTES +
			LABELS_PINS_BUDGET_BYTES +
			1024 * 1024;
		const targetAccountedBytes = fixedReservedBytes + retainedAccountedBytes;
		if (targetAccountedBytes > runtime.accountant.snapshot().budgetBytes) return false;
		const nextEntries: FileEntry[] = [header, ...retainedLeafToBoundary.reverse()];
		let transition: PreparedResidentStoreTransition;
		try {
			transition = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: this.#sessionId, sessionFile: this.#sessionFile ?? "" },
					primary: {
						mode: "materialize",
						sourceEntries: nextEntries,
						sourceStores: {
							textStore: this.#residentTextBlobStore,
							imageStore: this.#residentImageBlobStore,
						},
					},
				},
				"memory-fallback",
			);
		} catch {
			return false;
		}
		const accountedDelta = targetAccountedBytes - runtime.accountant.totalBytes;
		if (accountedDelta > 0 && !runtime.accountant.tryCharge(accountedDelta)) {
			transition.dispose();
			return false;
		}
		if (accountedDelta < 0) runtime.accountant.release(-accountedDelta);
		const aggregateUsageStatistics = this.#usageStatistics;
		this.#fileEntries = nextEntries;
		this.#byId = new Map(
			nextEntries.filter((entry): entry is SessionEntry => entry.type !== "session").map(entry => [entry.id, entry]),
		);
		this.#commitResidentTextStoreTransition(transition, false);
		this.#usageStatistics = aggregateUsageStatistics;
		this.#leafId = leafId;
		runtime.reducer = reducer;
		const sortedBranchProvider = [...providerState.values()].sort((left, right) => left.order - right.order);
		runtime.providerStateOrder = sortedBranchProvider.map(item => providerStateEntryKey(item.entry)!);
		runtime.providerStateEntries = sortedBranchProvider.map(item => cloneSessionEntry(item.entry));
		// Branch provider state is not republished (marker publication is fenced
		// while the branch is dirty), so the metadata-delta binding must stay
		// exactly as published: drop the in-memory delta state and keep every
		// branch provider value resident inline.
		runtime.metadataDelta = undefined;
		runtime.hotSuffixBytes = retainedBytes;
		runtime.retirementFirstKeptEntryId = boundaryId;
		runtime.terminalTransition = { kind: "rebuild", reason: "branch_activation_unpublished" };
		this.#sidecarBranchActivationDirty = true;
		this.#retirementFallbackReason = undefined;
		return true;
	}

	#clearColdRuntimeAfterHydration(runtime: SessionMemorySidecarRuntime): void {
		runtime.enabled = false;
		runtime.accountant.release(runtime.accountant.totalBytes);
		runtime.coldEntries.clear();
		runtime.tail = { ...runtime.tail, records: [] };
		runtime.labelsPins.clear();
		runtime.parentChildrenCache.clear();
		runtime.parentArtifact = undefined;
		runtime.dictionary = undefined;
		runtime.metadataDelta = undefined;
		runtime.coldIdHashes = undefined;
		runtime.coldIdHashesDescriptor = undefined;
		runtime.providerStateEntries = [];
		runtime.providerStateOrder = [];
		runtime.reducer = {
			modelChange: { latest: undefined },
			ttsr: { count: 0, rulesCount: 0, recordsCount: 0, largestOrdinal: -1 },
		};
		runtime.hotSuffixBytes = 0;
		runtime.blockCache.release(runtime.blockCache.allocatedBytes);
		runtime.entryCache.release(runtime.entryCache.allocatedBytes);
		runtime.tailCache.release(runtime.tailCache.allocatedBytes);
		for (const sidecarPath of this.#disposableSidecarPaths()) {
			if (!sidecarPath) continue;
			try {
				this.#storage.unlinkSync(sidecarPath);
			} catch {
				// Derived sidecars are disposable after authoritative hydration.
			}
		}
		this.#sidecarBranchActivationDirty = false;
		this.#managedRangeExpectedDescriptor =
			this.destination.kind === "managed" ? (this.#managedDescriptorSnapshotOrNull() ?? undefined) : undefined;
	}

	#hydrateAuthoritativeTranscriptSync(runtime: SessionMemorySidecarRuntime): void {
		if (!this.#sessionFile) throw new Error("cold_transcript_unavailable");
		const transcriptSize = this.#storage.statSync(this.#sessionFile).size;
		if (transcriptSize > eagerHydrationMaxBytes())
			throw new Error("cold_sidecar_rebuild_required_for_bounded_transcript");
		const transcriptText =
			this.destination.kind === "managed"
				? (() => {
						const snapshot = this.#managedTranscriptStore().readExpected(path.basename(this.#sessionFile!));
						if (!snapshot) throw new Error("cold_transcript_unavailable");
						return Buffer.from(snapshot.bytes).toString("utf8");
					})()
				: this.#storage.readTextSync(this.#sessionFile);
		const entries = parseSessionEntries(transcriptText);
		const header = entries[0];
		if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION) {
			throw new Error("cold_transcript_header_invalid");
		}
		if (!hasStrictSessionSchema(entries)) throw new Error("cold_transcript_schema_invalid");
		const migrationApplied = migrateToCurrentVersion(entries);
		for (const entry of entries) {
			if (entry.type !== "session") sanitizeLoadedSessionEntryReplayMetadata(entry);
			residentizePersistedBlobRefs(entry);
		}
		const transition = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: header.id, sessionFile: this.#sessionFile },
				primary: {
					mode: "materialize",
					sourceEntries: entries,
					sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
					missingPolicy: "placeholder",
				},
			},
			"memory-fallback",
		);
		this.#commitResidentTextStoreTransition(transition, false);
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		if (migrationApplied) this.#needsFullRewriteOnNextPersist = true;
		this.#clearColdRuntimeAfterHydration(runtime);
	}

	/** Rehydrate the full hot view (for persistence/materialization paths). */
	#ensureFullHotView(): void {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled) return;
		if (this.#sessionFile && this.#storage.statSync(this.#sessionFile).size > eagerHydrationMaxBytes())
			throw new Error("cold_sidecar_rebuild_required_for_bounded_transcript");
		if (!this.#validateColdBase(runtime.base) || !this.#coldTailMatchesDisk()) {
			this.#hydrateAuthoritativeTranscriptSync(runtime);
			return;
		}
		if (this.#sessionFile && this.#statSync(this.#sessionFile).size !== runtime.tail.transcriptSize) {
			this.#hydrateAuthoritativeTranscriptSync(runtime);
			return;
		}
		let records: Array<ColdEntryIndex & { id: string }>;
		try {
			records = this.#readAllColdEntryIndexes();
		} catch {
			this.#hydrateAuthoritativeTranscriptSync(runtime);
			return;
		}
		const header = this.#fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
		if (!header) {
			this.#hydrateAuthoritativeTranscriptSync(runtime);
			return;
		}
		try {
			const rebuilt: FileEntry[] = [header];
			for (const record of records) {
				const bytes = this.#readColdEntryRange(record);
				if (!bytes || computeLineDigest(bytes) !== record.recordDigest)
					throw new Error("cold_index_digest_mismatch");
				const entry = JSON.parse(Buffer.from(bytes).toString("utf8")) as SessionEntry;
				if (
					!entry ||
					typeof entry !== "object" ||
					entry.id !== record.id ||
					(typeof record.entryType === "string" && entry.type !== record.entryType) ||
					("parentId" in record && entry.parentId !== record.parentId)
				)
					throw new Error("cold_index_identity_mismatch");
				residentizePersistedBlobRefs(sanitizeLoadedSessionEntryReplayMetadata(entry));
				rebuilt.push(entry);
			}
			const transition = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: this.#sessionId, sessionFile: this.#sessionFile ?? "" },
					primary: {
						mode: "materialize",
						sourceEntries: rebuilt,
						sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
						missingPolicy: "placeholder",
					},
				},
				"memory-fallback",
			);
			this.#commitResidentTextStoreTransition(transition, false);
			this.#clearColdRuntimeAfterHydration(runtime);
		} catch {
			this.#hydrateAuthoritativeTranscriptSync(runtime);
		}
	}

	/** True when the cold sidecar region is active and usable. */
	#coldSidecarActive(): boolean {
		const runtime = this.#sidecarRuntime;
		return Boolean(
			runtime?.enabled &&
				!runtime.sidecarIneligible &&
				(runtime.hotSuffixBytes > 0 ||
					(runtime.tail.records.length === 0 && runtime.base.baseEndOffset === runtime.tail.transcriptSize)),
		);
	}

	#deactivateColdForBranchMutation(): void {
		if (!this.#coldSidecarActive()) return;
		this.#ensureFullHotView();
		this.#sidecarRuntime && this.#sidecarRuntime.coldMutationPromotions++;
		const runtime = this.#sidecarRuntime;
		if (!runtime) return;
		runtime.enabled = false;
		runtime.sidecarIneligible = true;
		runtime.hotSuffixBytes = 0;
		runtime.accountant = new SessionMemoryAccountant();
		runtime.dictionary = undefined;
		runtime.metadataDelta = undefined;
		runtime.coldIdHashes = undefined;
		runtime.coldIdHashesDescriptor = undefined;
		for (const sidecarPath of this.#disposableSidecarPaths()) {
			if (!sidecarPath) continue;
			try {
				this.#storage.unlinkSync(sidecarPath);
			} catch {
				// Derived sidecars are disposable; the fully hydrated transcript is authoritative.
			}
		}
	}

	#nextColdOrdinal(): number {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled) throw new Error("cold_sidecar_unavailable");
		return runtime.nextOrdinal;
	}

	#ensureColdIdHashes(): BoundedColdIdHashSet | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || !runtime.indexPath) return undefined;
		if (runtime.coldIdHashes) {
			try {
				if (
					runtime.coldIdHashesDescriptor &&
					sameDescriptor(this.#storage.statSync(runtime.indexPath), runtime.coldIdHashesDescriptor)
				) {
					if (!runtime.coldIdHashes.atCapacity) return runtime.coldIdHashes;
					runtime.coldIdHashes = undefined;
					runtime.coldIdHashesDescriptor = undefined;
					runtime.accountant.release(COLD_ID_HASH_BYTES);
					return undefined;
				}
			} catch {
				// Fall through to a bounded rebuild.
			}
			runtime.coldIdHashes = undefined;
			runtime.coldIdHashesDescriptor = undefined;
			runtime.accountant.release(COLD_ID_HASH_BYTES);
		}
		if (!this.#coldIndexDigestValid()) return undefined;
		if (!runtime.accountant.tryCharge(COLD_ID_HASH_BYTES)) return undefined;
		const hashes = new BoundedColdIdHashSet();
		let complete = true;
		try {
			const size = this.#storage.statSync(runtime.indexPath).size;
			const failure = scanTranscriptLinesBounded(this.#storage, runtime.indexPath, size, (_offset, lineBytes) => {
				try {
					const value = JSON.parse(decodeBoundedJsonLine(lineBytes)) as { id?: unknown };
					if (typeof value.id !== "string" || !hashes.add(value.id)) {
						complete = false;
						return false;
					}
				} catch {
					complete = false;
					return false;
				}
			});
			if (failure || !complete || hashes.atCapacity) return undefined;
			runtime.coldIdHashes = hashes;
			runtime.coldIdHashesDescriptor = this.#storage.statSync(runtime.indexPath);
			return hashes;
		} finally {
			if (!runtime.coldIdHashes) runtime.accountant.release(COLD_ID_HASH_BYTES);
		}
	}

	#generateEntryId(): string {
		const runtime = this.#sidecarRuntime;
		if (!this.#coldSidecarActive() || !runtime) return generateId(this.#byId);
		if (runtime.dictionary && this.#coldIndexDigestValid())
			return generateId({ has: id => this.#byId.has(id) || this.#findColdEntryIndex(id, false) !== undefined });
		const hashes = this.#ensureColdIdHashes();
		if (hashes) return generateId({ has: id => this.#byId.has(id) || hashes.has(id) });
		if (!this.#coldIndexDigestValid()) {
			this.#ensureFullHotView();
			return generateId(this.#byId);
		}
		return generateId({ has: id => this.#byId.has(id) || this.#findColdEntryIndex(id, false) !== undefined });
	}

	/** Wire reducer deltas for one appended entry (R1 latest-model-change + TTSR latest-wins). */
	#applySidecarReducerDelta(entry: SessionEntry, ordinal: number): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled) return false;
		const providerKey = providerStateEntryKey(entry);
		if (providerKey) {
			const existed = runtime.providerStateOrder.includes(providerKey);
			if (!existed && runtime.providerStateOrder.length >= 256) return false;
			const demoted = this.#persistProviderStateValue(entry, ordinal);
			const nextProviderEntries = [
				...runtime.providerStateEntries.filter(candidate => providerStateEntryKey(candidate) !== providerKey),
				...(demoted ? [] : [cloneSessionEntry(entry)]),
			];
			const providerBytes =
				Buffer.byteLength(JSON.stringify(nextProviderEntries), "utf8") + (runtime.metadataDelta?.size ?? 0);
			if (providerBytes > REDUCER_BUDGET_BYTES) return false;
			runtime.providerStateOrder = [...runtime.providerStateOrder.filter(key => key !== providerKey), providerKey];
			runtime.providerStateEntries = nextProviderEntries;
		}
		if (entry.type === "model_change") {
			runtime.reducer = applyReducerDelta(runtime.reducer, {
				kind: "latest_model_change",
				ordinal,
				role: entry.role,
			});
		} else if (entry.type === "ttsr_injection") {
			runtime.reducer = applyReducerDelta(runtime.reducer, {
				kind: "ttsr_injection",
				ordinal,
				rulesCount: entry.injectedRules.length,
				recordsCount: entry.injectedRuleRecords?.length ?? 0,
				count: entry.ttsrMessageCount ?? 0,
			});
		}
		return true;
	}

	/**
	 * Persist one provider-state entry's value into the metadata-delta section
	 * when it exceeds `MAX_REDUCER_INLINE_BYTES`; otherwise keep it inline. The
	 * value bytes are fsynced before the descriptor is retained, so the marker
	 * only ever binds descriptors pointing at durable authenticated bytes. When
	 * the fixed 4 MiB reducer budget or the write fails, the value stays inline
	 * (fail closed to the pre-demotion eager marker semantics). Returns whether
	 * the value was demoted (the caller then keeps only the 24 B descriptor
	 * resident instead of the full entry).
	 */
	#persistProviderStateValue(entry: SessionEntry, ordinal: number): boolean {
		const runtime = this.#sidecarRuntime;
		const delta = runtime?.metadataDelta;
		if (!delta) return false;
		const key = providerStateEntryKey(entry);
		if (!key) return false;
		const persistedLine = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
		if (persistedLine.byteLength > MAX_REDUCER_INLINE_BYTES) {
			const stored = this.#appendMetadataDeltaValue(persistedLine);
			if (stored) {
				delta.byKey.set(key, { kind: entry.type, ordinal, ...stored });
				this.#syncMetadataDeltaDescriptorBytes();
				return true;
			}
			delta.byKey.delete(key);
		} else {
			delta.byKey.delete(key);
		}
		this.#syncMetadataDeltaDescriptorBytes();
		return false;
	}

	#advanceColdTailBoundary(firstKeptEntryId: string): boolean {
		const runtime = this.#sidecarRuntime;
		const sessionFile = this.#sessionFile;
		if (!runtime?.enabled || !sessionFile || !runtime.tailPath || !this.#storage.readRangeSync) return false;
		const firstIndex = runtime.tail.records.findIndex(record => record.id === firstKeptEntryId);
		if (firstIndex < 0) return false;
		const firstRecord = runtime.tail.records[firstIndex];
		const baseHash = crypto.createHash("sha256");
		try {
			for (let offset = 0; offset < firstRecord.byteOffset; offset += 64 * 1024) {
				const length = Math.min(64 * 1024, firstRecord.byteOffset - offset);
				baseHash.update(this.#readRangeSync(sessionFile, offset, length).bytes);
			}
			const base: BaseAnchor = { baseDigest: baseHash.digest("hex"), baseEndOffset: firstRecord.byteOffset };
			const builder = new RollingTailChainBuilder(base);
			for (let index = firstIndex; index < runtime.tail.records.length; index++) {
				const prior = runtime.tail.records[index];
				const appended = builder.append({
					gen: prior.gen,
					seq: index - firstIndex,
					kind: prior.kind,
					ordinal: prior.ordinal,
					id: prior.id,
					parentId: prior.parentId,
					type: prior.type,
					byteOffset: prior.byteOffset,
					byteLength: prior.byteLength,
					recordDigest: prior.recordDigest,
				});
				if (!appended) return false;
			}
			const tail = builder.build();
			const writer = this.#storage.openWriter(runtime.tailPath, { flags: "w" });
			try {
				for (const record of tail.records) writer.writeLineSync(`${JSON.stringify(record)}\n`);
				if (!writer.fsyncSync) return false;
				writer.fsyncSync();
			} finally {
				writer.closeSync();
			}
			runtime.base = base;
			runtime.tail = tail;
			runtime.tailCache.release(runtime.tailCache.allocatedBytes);
			for (const record of tail.records) {
				if (!runtime.tailCache.tryAllocate(tailRecordResidentBytes(record))) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	#appendColdSidecarRecord(
		entry: SessionEntry,
		persistedLine: Buffer,
		transcriptDescriptor?: SessionStorageStat,
		ordinal = this.#nextColdOrdinal(),
	): boolean {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || runtime.sidecarIneligible) return false;
		if (runtime.coldIdHashes && !runtime.coldIdHashes.add(entry.id)) {
			runtime.coldIdHashes = undefined;
			runtime.coldIdHashesDescriptor = undefined;
			runtime.accountant.release(COLD_ID_HASH_BYTES);
		}
		const cachedChildren = entry.parentId ? runtime.parentChildrenCache.get(entry.parentId) : undefined;
		if (entry.parentId && cachedChildren) {
			runtime.parentChildrenCache.delete(entry.parentId);
			runtime.blockCache.release(cachedChildren.bytes);
		}
		const previous = runtime.tail.records.at(-1);
		const seq = previous ? previous.seq + 1 : 0;
		const byteOffset = runtime.tail.transcriptSize;
		const byteLength = persistedLine.byteLength;
		const recordDigest = computeLineDigest(persistedLine);
		const recordWithoutChecksum = {
			gen: this.#commitGen + 1,
			seq,
			kind: tailRecordKindForEntry(entry),
			ordinal,
			id: entry.id,
			parentId: entry.parentId,
			type: entry.type,
			byteOffset,
			byteLength,
			recordDigest,
		};
		const checksum = computeTailRecordChecksum(runtime.base, previous?.checksum, recordWithoutChecksum);
		const record: TailRecord = { ...recordWithoutChecksum, checksum };
		try {
			const indexWriter = this.#storage.openWriter(runtime.indexPath, { flags: "a" });
			try {
				const indexLine = `${JSON.stringify({ id: entry.id, ordinal: record.ordinal, seq, byteOffset, byteLength, recordDigest, parentId: entry.parentId, entryType: entry.type })}\n`;
				indexWriter.writeLineSync(indexLine);
				if (!indexWriter.fsyncSync) throw new Error("Synchronous sidecar fsync is unavailable");
				indexWriter.fsyncSync();
				runtime.indexHash.update(Buffer.from(indexLine, "utf8"));
				runtime.indexDigest = runtime.indexHash.copy().digest("hex");
				if (runtime.metadataDelta) runtime.metadataDelta.indexDigest = runtime.indexDigest;
			} finally {
				indexWriter.closeSync();
			}
			const tailWriter = this.#storage.openWriter(runtime.tailPath, { flags: "a" });
			try {
				tailWriter.writeLineSync(`${JSON.stringify(record)}\n`);
				if (!tailWriter.fsyncSync) throw new Error("Synchronous sidecar fsync is unavailable");
				tailWriter.fsyncSync();
			} finally {
				tailWriter.closeSync();
			}
		} catch {
			this.#deactivateColdForBranchMutation();
			return false;
		}
		const secondaryArtifactsEligible =
			record.ordinal < PERSISTENT_SECONDARY_ARTIFACT_MAX_RECORDS &&
			byteOffset + byteLength <= PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES;
		if (!secondaryArtifactsEligible) {
			this.#invalidateParentArtifact();
			this.#invalidateDictionaryArtifact();
		} else {
			if (typeof entry.parentId === "string") {
				if (
					!this.#appendParentArtifactRecord(entry.parentId, {
						childId: entry.id,
						ordinal: record.ordinal,
						seq,
						byteOffset,
						byteLength,
						recordDigest,
						entryType: entry.type,
					})
				)
					this.#invalidateParentArtifact();
			}
			if (entry.parentId === null && runtime.parentArtifact) this.#invalidateParentArtifact();
			if (
				!this.#appendDictionaryRecord({
					id: entry.id,
					ordinal: record.ordinal,
					seq,
					byteOffset,
					byteLength,
					recordDigest,
					parentId: entry.parentId,
					entryType: entry.type,
				})
			)
				this.#invalidateDictionaryArtifact();
		}
		try {
			const refreshed = this.#storage.statSync(runtime.indexPath);
			runtime.validatedIndexDescriptor = refreshed;
			runtime.coldIdHashesDescriptor = runtime.coldIdHashes ? refreshed : undefined;
		} catch {
			// The next cold lookup re-verifies the index digest before trusting caches.
		}
		const records = runtime.tail.records as TailRecord[];
		records.push(record);
		runtime.nextOrdinal = ordinal + 1;
		runtime.tail = {
			base: runtime.base,
			records,
			terminalChecksum: checksum,
			terminalSeq: seq,
			transcriptSize: byteOffset + byteLength,
		};
		if (
			transcriptDescriptor
				? this.#publishSessionCommitMarkerSync(transcriptDescriptor)
				: this.#publishCommitMarkerFromCurrentTranscriptSync()
		) {
			runtime.terminalTransition = { kind: "exact", reason: "descriptor_and_proof_match" };
		} else {
			runtime.terminalTransition = { kind: "rebuild", reason: "commit_marker_publication_failed" };
		}
		return true;
	}

	#readSessionCommitContents(): SessionMemoryCommitContents | undefined {
		const markerPath = this.#sidecarRuntime?.commitPath;
		if (!markerPath || !this.#storage.readRangeSync) return undefined;
		try {
			const markerSize = this.#storage.statSync(markerPath).size;
			if (markerSize > 8 * 1024 * 1024) return undefined;
			const value = JSON.parse(
				Buffer.from(this.#storage.readRangeSync(markerPath, 0, markerSize).bytes).toString("utf8"),
			) as {
				gen?: unknown;
				descriptor?: Record<string, unknown>;
				base?: Record<string, unknown>;
				terminalChecksum?: unknown;
				terminalSeq?: unknown;
				transcriptSize?: unknown;
				retirementFirstKeptEntryId?: unknown;
				leafId?: unknown;
				reducer?: unknown;
				providerStateEntries?: unknown;
				labels?: unknown;
				usageStatistics?: unknown;
				indexDigest?: unknown;
				parentIndex?: unknown;
				dictionary?: unknown;
				metadataDelta?: unknown;
			};
			const descriptor = value.descriptor;
			const base = value.base;
			if (
				typeof value.gen !== "number" ||
				!descriptor ||
				typeof descriptor.dev !== "string" ||
				typeof descriptor.ino !== "string" ||
				typeof descriptor.size !== "number" ||
				typeof descriptor.mtimeNs !== "string" ||
				typeof descriptor.ctimeNs !== "string" ||
				!base ||
				typeof base.baseDigest !== "string" ||
				typeof base.baseEndOffset !== "number" ||
				typeof value.terminalChecksum !== "string" ||
				typeof value.terminalSeq !== "number" ||
				typeof value.transcriptSize !== "number" ||
				typeof value.indexDigest !== "string"
			)
				return undefined;
			if (Object.hasOwn(value, "metadataDelta") && !isValidMetadataDeltaCommit(value.metadataDelta))
				return undefined;
			return {
				gen: value.gen,
				descriptor: {
					dev: BigInt(descriptor.dev),
					ino: BigInt(descriptor.ino),
					...(typeof descriptor.nlink === "string" ? { nlink: BigInt(descriptor.nlink) } : {}),
					size: descriptor.size,
					mtimeNs: BigInt(descriptor.mtimeNs),
					ctimeNs: BigInt(descriptor.ctimeNs),
				},
				base: { baseDigest: base.baseDigest, baseEndOffset: base.baseEndOffset },
				terminalChecksum: value.terminalChecksum,
				terminalSeq: value.terminalSeq,
				transcriptSize: value.transcriptSize,
				...(typeof value.retirementFirstKeptEntryId === "string"
					? { retirementFirstKeptEntryId: value.retirementFirstKeptEntryId }
					: {}),
				...(typeof value.leafId === "string" ? { leafId: value.leafId } : {}),
				...(value.reducer && typeof value.reducer === "object" ? { reducer: value.reducer as ReducerState } : {}),
				...(Array.isArray(value.providerStateEntries)
					? { providerStateEntries: value.providerStateEntries as SessionEntry[] }
					: {}),
				...(Array.isArray(value.labels) ? { labels: value.labels as Array<[string, string]> } : {}),
				...(value.usageStatistics && typeof value.usageStatistics === "object"
					? { usageStatistics: value.usageStatistics as UsageStatistics }
					: {}),

				indexDigest: value.indexDigest,
				...(this.#parseParentIndexValue(value.parentIndex) !== undefined
					? { parentIndex: this.#parseParentIndexValue(value.parentIndex) }
					: {}),
				...(this.#parseDictionaryCommitValue(value.dictionary) !== undefined
					? { dictionary: this.#parseDictionaryCommitValue(value.dictionary) }
					: {}),
				...(isValidMetadataDeltaCommit(value.metadataDelta) ? { metadataDelta: value.metadataDelta } : {}),
			};
		} catch {
			return undefined;
		}
	}

	/** Classify the current reopen state against the committed `.spill.commit` marker. */
	#classifySidecarReopen(): ReopenClassification {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || runtime.sidecarIneligible) return { kind: "rebuild", reason: "sidecar_unavailable" };
		let markerPresent = false;
		try {
			markerPresent = this.#storage.existsSync(runtime.commitPath);
		} catch {
			return { kind: "rebuild", reason: "commit_marker_read_failed" };
		}
		if (!markerPresent) return { kind: "stale_commit", reason: "no_commit_marker" };
		const commit = this.#readSessionCommitContents();
		if (!commit) return { kind: "rebuild", reason: "commit_marker_invalid" };
		const descriptor = this.#managedDescriptorSnapshotOrNull();
		if (!descriptor) return { kind: "rebuild", reason: "descriptor_unavailable" };
		const baseValid = this.#validateColdBase(commit.base);
		const tailValid = validateTailChain(commit.base, runtime.tail.records).valid;
		const terminalMarkerValid =
			commit.terminalChecksum === runtime.tail.terminalChecksum &&
			commit.terminalSeq === runtime.tail.terminalSeq &&
			commit.transcriptSize === runtime.tail.transcriptSize;
		const descriptorExact = sameDescriptor(commit.descriptor, descriptor);
		const sameObject =
			commit.descriptor.dev === descriptor.dev &&
			commit.descriptor.ino === descriptor.ino &&
			(commit.descriptor.nlink ?? 0n) === (descriptor.nlink ?? 0n);
		const sameSize = commit.descriptor.size === descriptor.size;
		const timesChanged =
			commit.descriptor.mtimeNs !== descriptor.mtimeNs || commit.descriptor.ctimeNs !== descriptor.ctimeNs;
		const timesAdvanced =
			descriptor.mtimeNs >= commit.descriptor.mtimeNs && descriptor.ctimeNs >= commit.descriptor.ctimeNs;
		const classification = classifyReopen({
			markerPresent,
			descriptorExact,
			sameObject,
			sameSize,
			sizeGrew: sameObject && descriptor.size > commit.descriptor.size,
			sizeShrank: sameObject && descriptor.size < commit.descriptor.size,
			withinScanWindow: Math.abs(descriptor.size - commit.descriptor.size) <= 4 * 1024 * 1024,
			timesAdvanced,
			timesChanged,
			baseValid,
			tailValid,
			terminalMarkerValid,
		});
		if (descriptorExact) {
			const validation = validateCommit(commit, runtime.tail.records, {
				descriptor,
				baseValid,
				tailValid,
				terminalMarkerValid,
			});
			if (validation.kind === "invalid") return { kind: "rebuild", reason: validation.reason };
		}
		runtime.terminalTransition = classification;
		return classification;
	}

	#adoptManagedPersistIdentity(sessionFile = this.#sessionFile): void {
		if (this.destination.kind !== "managed" || !sessionFile) {
			this.#managedPersistExpectedIdentity = undefined;
			return;
		}
		const sessionDir = path.resolve(path.dirname(sessionFile));
		if (sessionDir !== path.resolve(this.destination.directory)) {
			this.#managedPersistExpectedIdentity = undefined;
			return;
		}
		this.#managedPersistExpectedIdentity = this.#captureManagedPersistIdentity(sessionFile);
	}

	/** Capture one descriptor-bound digest for a future metadata-drift comparison. */
	#captureManagedPersistIdentity(
		sessionFile: string,
		expected?: ManagedFileIdentity,
		expectedBytes?: Uint8Array,
	): ManagedFileIdentity {
		const store = this.#managedTranscriptStore(sessionFile);
		const relativePath = path.basename(sessionFile);
		const descriptor = store.descriptorExpected(relativePath);
		if (!descriptor) throw new Error("managed_persist_identity_unavailable");
		const identity = managedIdentityFromDescriptor(descriptor);
		const bounded = store.captureBoundedAppendExpectation(relativePath);
		if (
			!bounded ||
			bounded.dev !== identity.dev.toString() ||
			bounded.ino !== identity.ino.toString() ||
			bounded.nlink !== identity.nlink.toString() ||
			bounded.size !== String(identity.size) ||
			bounded.mtimeNs !== identity.mtimeNs.toString() ||
			bounded.ctimeNs !== identity.ctimeNs.toString()
		)
			throw new Error("managed_persist_identity_unavailable");
		const captured = bounded ? { ...identity, sha256: bounded.sha256 } : identity;
		if (expectedBytes && captured.sha256 !== crypto.createHash("sha256").update(expectedBytes).digest("hex"))
			throw new Error("managed_persist_identity_unavailable");
		if (
			expected &&
			(captured.dev !== expected.dev ||
				captured.ino !== expected.ino ||
				captured.nlink !== expected.nlink ||
				captured.size !== expected.size ||
				captured.mtimeNs !== expected.mtimeNs ||
				captured.ctimeNs !== expected.ctimeNs ||
				(expected.sha256 !== undefined && captured.sha256 !== expected.sha256))
		)
			throw new Error("managed_persist_identity_unavailable");
		return captured;
	}
	/** Current transcript descriptor, or null when unavailable. */
	#managedDescriptorSnapshotOrNull(): DescriptorSnapshot | null {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return null;
		try {
			const descriptor =
				this.destination.kind === "managed"
					? this.#managedTranscriptStore(sessionFile).descriptorExpected(path.basename(sessionFile))
					: this.#storage.statSync(sessionFile);
			if (!descriptor) return null;
			return {
				dev: descriptor.dev,
				ino: descriptor.ino,
				nlink: descriptor.nlink,
				size: descriptor.size,
				mtimeNs: descriptor.mtimeNs,
				ctimeNs: descriptor.ctimeNs,
			};
		} catch {
			return null;
		}
	}

	#writeEntriesAtomicallySync(entries: FileEntry[]): void {
		// A full rewrite must see the complete transcript; rehydrate retired cold
		// entries into the hot view before materializing the persisted bytes.
		this.#ensureFullHotView();
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return;
		this.#withSessionPersistenceFenceSync(() => {
			if (this.destination.kind === "managed") {
				const bytes = Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
				const store = this.#managedTranscriptStore(sessionFile);
				const relativePath = path.basename(sessionFile);
				let noReplacePublication: ManagedFileIdentity | undefined;
				let noReplacePublicationAttempted = false;
				let replacementPublicationCommitted = false;
				let replacementPublication: ManagedFileIdentity | undefined;
				try {
					if (this.#managedPersistExpectedIdentity) {
						try {
							replacementPublication = store.replaceExpectedIdentitySync(
								relativePath,
								bytes,
								this.#managedPersistExpectedIdentity,
							);
							replacementPublicationCommitted = true;
						} catch (err) {
							// A confirmed missing predecessor can be recreated from the complete
							// resident transcript. Any present-but-different identity still fails
							// closed so a concurrent successor is never overwritten.
							if (!isEnoent(err)) throw err;
							this.#managedPersistExpectedIdentity = undefined;
							noReplacePublicationAttempted = true;
							noReplacePublication = store.publishNoReplaceSync(relativePath, bytes);
						}
					} else {
						noReplacePublicationAttempted = true;
						noReplacePublication = store.publishNoReplaceSync(relativePath, bytes);
					}
					if (!noReplacePublication && !replacementPublication)
						throw new Error("managed_replace_identity_unavailable");
					this.#managedPersistExpectedIdentity = this.#captureManagedPersistIdentity(
						sessionFile,
						noReplacePublication ?? replacementPublication,
					);
					this.#publishCommitMarkerFromCurrentTranscriptSync();
				} catch (error) {
					if (error instanceof ManagedCommittedMutationError && error.identity) {
						replacementPublication = error.identity;
						replacementPublicationCommitted = true;
					}
					let recaptureObserved = false;
					if (noReplacePublicationAttempted && !noReplacePublication) {
						try {
							// A pathname recapture is only evidence that the bytes are present; it
							// cannot identify which inode survived an unknown no-replace outcome.
							this.#captureManagedPersistIdentity(sessionFile, undefined, bytes);
							recaptureObserved = true;
						} catch {
							// A failed recapture leaves the managed persistence identity
							// unresolved; preserve the original committed/uncertain
							// classification below.
						}
					}
					// A no-replace publication may have committed before the subsequent
					// descriptor/digest recapture. Preserve the resident entry in that
					// case: rolling it back would create a durable ghost transcript row.
					if (noReplacePublication) {
						// The publication receipt is independently bound to the exact bytes;
						// keep it as the next replace precondition even when post-publication
						// recapture failed. This prevents a retry from publishing a second
						// successor and keeps any divergent occupant fail-closed.
						this.#managedPersistExpectedIdentity = noReplacePublication;
						try {
							this.#managedPersistExpectedIdentity = this.#captureManagedPersistIdentity(
								sessionFile,
								noReplacePublication,
								bytes,
							);
						} catch {
							// Keep the publication receipt when the retry descriptor cannot yet
							// be recaptured; it remains the only safe precondition.
						}
					}
					if (replacementPublication) {
						// A successful expected-identity replacement gives us a descriptor-bound
						// receipt even when the subsequent recapture is interrupted. Retain that
						// exact inode as the next precondition; pathname-only adoption could
						// overwrite a successor that appeared during the failed recapture.
						this.#managedPersistExpectedIdentity = replacementPublication;
						try {
							this.#managedPersistExpectedIdentity = this.#captureManagedPersistIdentity(
								sessionFile,
								replacementPublication,
								bytes,
							);
						} catch {
							// Keep the publication receipt when the retry descriptor cannot yet
							// be recaptured; it remains the only safe precondition.
						}
					}
					if (error instanceof ManagedCommittedMutationError) throw error;
					if (noReplacePublication)
						throw new ManagedCommittedMutationError("replace", error, noReplacePublication);
					if (replacementPublicationCommitted)
						throw new ManagedCommittedMutationError("replace", error, replacementPublication);
					if (
						recaptureObserved &&
						!(error instanceof ManagedPublishError && error.mutationState === "not_committed")
					)
						throw new ManagedCommittedMutationError("replace", error);
					throw error;
				}
				return;
			}
			const dir = path.resolve(sessionFile, "..");
			const tempPath = path.join(dir, `.${path.basename(sessionFile)}.${Snowflake.next()}.tmp`);
			const writer = new NdjsonFileWriter(this.#storage, tempPath, { flags: "w" });
			try {
				for (const entry of entries) {
					writer.writeSync(entry);
				}
				writer.fsyncSync();
				writer.closeSync();
				const replacement = this.#replaceSessionFileSync(tempPath, sessionFile);
				if (replacement.kind === "restored_previous") throw replacement.error;
			} catch (err) {
				// closeSync is now truthful and may throw; wrap the best-effort cleanup so
				// the original error (write/close failure) is the one surfaced, not the
				// cleanup failure. The rename above was already skipped because closeSync
				// threw before it.
				try {
					writer.closeSync();
				} catch {
					// Best-effort cleanup of the temp writer's descriptor.
				}
				void this.#storage.unlink(tempPath).catch(() => {});
				throw toError(err);
			}
		});
	}

	async #writeBoundedDefaultModelSelection(
		appendEntries: readonly SessionEntry[],
		sessionFile: string,
		sourceDescriptor: DescriptorSnapshot,
	): Promise<{ tempPath: string; sourceSha256: string }> {
		if (this.destination.kind === "managed" || typeof this.#storage.openStagedWriter !== "function")
			throw new Error("bounded_default_selection_unsupported");
		const dir = path.resolve(sessionFile, "..");
		const tempPath = path.join(dir, `.${path.basename(sessionFile)}.${Snowflake.next()}.default-selection.tmp`);
		const staged = this.#storage.openStagedWriter(tempPath);
		const sourceHash = crypto.createHash("sha256");
		try {
			const scanFailure = scanTranscriptLinesBounded(
				this.#storage,
				sessionFile,
				sourceDescriptor.size,
				(_offset, lineBytes) => {
					staged.writeLine(lineBytes.subarray(0, lineBytes.byteLength - 1));
					sourceHash.update(lineBytes);
				},
			);
			if (scanFailure) throw new Error(`bounded_default_selection_${scanFailure}`);
			for (const entry of appendEntries) {
				const persisted = prepareEntryForPersistenceSync(entry, this.#blobStore);
				staged.writeLine(Buffer.from(JSON.stringify(persisted), "utf8"));
			}
			staged.fsync();
			staged.closeSync();
			staged.publishNoReplace();
			const after = this.#managedDescriptorSnapshotOrNull();
			if (!after || !sameDescriptor(sourceDescriptor, after))
				throw new Error("bounded_default_selection_source_changed");
			return { tempPath, sourceSha256: sourceHash.digest("hex") };
		} catch (error) {
			try {
				staged.closeSync();
			} catch {
				// Preserve the staging failure.
			}
			try {
				this.#storage.unlinkSync(tempPath);
			} catch {
				// A successfully published temp may already have been removed by cleanup.
			}
			throw toError(error);
		}
	}

	async #writeStagedDefaultModelSelection(
		entries: readonly FileEntry[],
		sessionFile: string,
	): Promise<string | undefined> {
		if (this.destination.kind === "managed") return undefined;
		if (!this.#storage.existsSync(sessionFile)) return undefined;
		const dir = path.resolve(sessionFile, "..");
		const tempPath = path.join(dir, `.${path.basename(sessionFile)}.${Snowflake.next()}.default-selection.tmp`);
		const writer = new NdjsonFileWriter(this.#storage, tempPath, {
			flags: "w",
		});
		try {
			const persistedEntries = await Promise.all(
				materializeResidentEntriesForPersistenceSync([...entries], this.#residentBlobStores()).map(entry =>
					prepareEntryForPersistence(entry, this.#blobStore),
				),
			);
			for (const entry of persistedEntries) {
				await writer.write(entry);
			}
			await writer.flush();
			await writer.fsync();
			await writer.close();
			return tempPath;
		} catch (error) {
			try {
				await writer.close();
			} catch {}
			try {
				await this.#storage.unlink(tempPath);
			} catch {}
			throw toError(error);
		}
	}

	async #rewriteFileContents(): Promise<void> {
		if (!this.persist || !this.#sessionFile) return;
		// Bounded freshness loop: prepare whole-session bytes, then enter the
		// non-yielding fence with a live-token check. A revision change discards the
		// prepared bytes and re-prepares (≤ 2 re-preparations); a lifecycle switch
		// aborts. A stale snapshot is never published.
		let written = false;
		for (let attempt = 0; attempt <= 2 && !written; attempt++) {
			this.#ensureFullHotView();
			const token = this.#capturePersistenceInputToken();
			await this.#closePersistWriterInternal();
			const entries = await Promise.all(
				materializeResidentEntriesForPersistenceSync(this.#fileEntries, this.#residentBlobStores()).map(entry =>
					prepareEntryForPersistence(entry, this.#blobStore),
				),
			);
			written = this.#withSessionPersistenceFenceSync(() => {
				if (!this.#persistenceInputTokenMatches(token)) return false;
				this.#writeEntriesAtomicallySync(entries);
				return true;
			});
		}
		if (!written) throw new Error("session_persistence_input_stale");
		this.#needsFullRewriteOnNextPersist = false;
		this.#flushed = true;
		this.#ensuredOnDisk = true;
		if (this.#effectiveSessionMemoryMode() !== "off") {
			this.#buildDisposableSidecars(this.#fileEntries);
			if (this.#effectiveSessionMemoryMode() === "enabled") this.#retireColdEntries();
		}
	}

	async #rewriteFile(): Promise<void> {
		await this.#queuePersistTask(async () => {
			await this.#rewriteFileContents();
		});
	}

	#rewriteFileSync(): void {
		if (!this.persist || !this.#sessionFile) return;
		this.#withSessionPersistenceFenceSync(() => {
			this.#ensureFullHotView();
			// Sync lane: capture and check the token immediately (always fresh absent
			// a reentrant mutation); a lifecycle switch aborts before any write.
			if (!this.#persistenceInputTokenMatches(this.#capturePersistenceInputToken()))
				throw new Error("session_persistence_input_stale");
			this.#closePersistWriterInternalSync();
			const entries = materializeResidentEntriesForPersistenceSync(
				this.#fileEntries,
				this.#residentBlobStores(),
			).map(entry => prepareEntryForPersistenceSync(entry, this.#blobStore));
			this.#writeEntriesAtomicallySync(entries);
			this.#needsFullRewriteOnNextPersist = false;
			this.#flushed = true;
			this.#ensuredOnDisk = true;
		});
		if (this.#effectiveSessionMemoryMode() !== "off") {
			this.#buildDisposableSidecars(this.#fileEntries);
			if (this.#effectiveSessionMemoryMode() === "enabled") this.#retireColdEntries();
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	async stageDefaultModelSelection(
		model: string,
		thinkingLevel: string | undefined,
		options?: { readonly appendThinkingLevel: boolean },
	): Promise<DefaultModelSelectionStage> {
		const sessionFile = this.#sessionFile;
		const persistsToExistingFile = this.persist && sessionFile !== undefined && this.#storage.existsSync(sessionFile);
		const managedAppendExpectation =
			persistsToExistingFile && this.#coldSidecarActive() && this.destination.kind === "managed"
				? this.#managedTranscriptStore(sessionFile).captureBoundedAppendExpectation(path.basename(sessionFile))
				: undefined;
		const boundedExplicit =
			this.destination.kind !== "managed" &&
			typeof this.#storage.openStagedWriter === "function" &&
			typeof this.#storage.readRangeSync === "function";
		const boundedCold =
			persistsToExistingFile &&
			this.#coldSidecarActive() &&
			!this.#sidecarBranchActivationDirty &&
			(boundedExplicit || managedAppendExpectation !== undefined);
		if (!boundedCold) this.#ensureFullHotView();
		const entryRevision = this.#entryRevision;
		const leafRevision = this.#leafRevision;
		const headerExportRevision = this.#headerExportRevision;
		const sessionId = this.#sessionId;
		const generatedIds = new Set<string>();
		const entryIds = {
			has: (id: string): boolean =>
				generatedIds.has(id) ||
				this.#byId.has(id) ||
				(boundedCold && this.#findColdEntryIndex(id, false) !== undefined),
			set: (id: string, _entry?: SessionEntry): void => {
				generatedIds.add(id);
			},
		};
		let parentId = this.#leafId;
		const entries = [...this.#fileEntries];
		const temporaryEntry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(entryIds),
			parentId,
			timestamp: new Date().toISOString(),
			model,
			role: "temporary",
		};
		entryIds.set(temporaryEntry.id, temporaryEntry);
		entries.push(temporaryEntry);
		parentId = temporaryEntry.id;
		if (options?.appendThinkingLevel) {
			const thinkingEntry: ThinkingLevelChangeEntry = {
				type: "thinking_level_change",
				id: generateId(entryIds),
				parentId,
				timestamp: new Date().toISOString(),
				thinkingLevel: thinkingLevel ?? null,
			};
			entryIds.set(thinkingEntry.id, thinkingEntry);
			entries.push(thinkingEntry);
			parentId = thinkingEntry.id;
		}
		const modelEntry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(entryIds),
			parentId,
			timestamp: new Date().toISOString(),
			model,
			role: "default",
		};
		entries.push(modelEntry);
		const sourceDescriptor = boundedCold ? (this.#managedDescriptorSnapshotOrNull() ?? undefined) : undefined;
		if (boundedCold && !sourceDescriptor) throw new Error("bounded_default_selection_source_unavailable");
		if (boundedCold && (!this.#coldIndexDigestValid() || !this.#coldTailMatchesDisk()))
			throw new Error("bounded_default_selection_sidecar_changed");
		const appendEntries = entries.slice(this.#fileEntries.length) as SessionEntry[];
		const sourceStat =
			boundedCold && this.destination.kind !== "managed" ? this.#storage.statSync(sessionFile) : undefined;
		const boundedStage =
			boundedCold && this.destination.kind !== "managed"
				? await this.#writeBoundedDefaultModelSelection(appendEntries, sessionFile, sourceDescriptor!)
				: undefined;
		const tempPath =
			persistsToExistingFile && this.destination.kind !== "managed"
				? (boundedStage?.tempPath ?? (await this.#writeStagedDefaultModelSelection(entries, sessionFile)))
				: undefined;
		const sourceSha256 = boundedStage?.sourceSha256;
		return {
			entryRevision,
			leafRevision,
			headerExportRevision,
			sessionId,
			sessionFile,
			entries,
			tempPath,
			persistsToExistingFile,
			boundedCold,
			appendEntries,
			sourceDescriptor,
			sourceStat,
			sourceSha256,
			managedAppendExpectation,
		};
	}

	promoteDefaultModelSelection(stage: DefaultModelSelectionStage): DefaultModelSelectionPromotion {
		if (
			stage.entryRevision !== this.#entryRevision ||
			stage.leafRevision !== this.#leafRevision ||
			stage.headerExportRevision !== this.#headerExportRevision ||
			stage.sessionId !== this.#sessionId ||
			stage.sessionFile !== this.#sessionFile
		) {
			return { kind: "not_promoted" };
		}
		if (stage.boundedCold) {
			const currentDescriptor = this.#managedDescriptorSnapshotOrNull();
			if (
				!stage.sourceDescriptor ||
				!currentDescriptor ||
				!sameDescriptor(stage.sourceDescriptor, currentDescriptor) ||
				!this.#coldIndexDigestValid() ||
				!this.#coldTailMatchesDisk()
			)
				return { kind: "not_promoted" };
		}
		let transition: PreparedResidentStoreTransition;
		try {
			transition = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: this.#sessionId, sessionFile: this.#sessionFile ?? "" },
					primary: {
						mode: "materialize",
						sourceEntries: [...stage.entries],
						sourceStores: { textStore: this.#residentTextBlobStore, imageStore: this.#residentImageBlobStore },
					},
				},
				"retain-and-throw",
			);
		} catch (error) {
			return { kind: "unknown", error: toError(error) };
		}
		if (stage.persistsToExistingFile) {
			if (!this.#sessionFile) {
				transition.dispose();
				return { kind: "unknown", error: new Error("Missing staged session replacement") };
			}
			if (this.destination.kind === "managed") {
				try {
					if (stage.boundedCold) {
						if (!stage.managedAppendExpectation) throw new Error("Managed bounded append expectation is missing");
						const bytes = Buffer.concat(
							stage.appendEntries.map(entry =>
								Buffer.from(
									`${JSON.stringify(prepareEntryForPersistenceSync(entry, this.#blobStore))}\n`,
									"utf8",
								),
							),
						);
						const receipt = this.#managedTranscriptStore(this.#sessionFile).appendExpectedSync(
							path.basename(this.#sessionFile),
							bytes,
							stage.managedAppendExpectation,
						);
						this.#managedPersistExpectedIdentity = receipt.identity;
					} else {
						const persistedEntries = materializeResidentEntriesForPersistenceSync(
							[...stage.entries],
							this.#residentBlobStores(),
						).map(entry => prepareEntryForPersistenceSync(entry, this.#blobStore));
						this.#writeEntriesAtomicallySync(persistedEntries);
					}
				} catch (error) {
					transition.dispose();
					return { kind: "unknown", error: toError(error) };
				}
			} else {
				if (!stage.tempPath) {
					transition.dispose();
					return { kind: "unknown", error: new Error("Missing staged session replacement") };
				}
				try {
					this.#closePersistWriterInternalSync();
					if (stage.boundedCold) {
						if (!this.#storage.replaceExactSync || !stage.sourceStat || !stage.sourceSha256) {
							transition.dispose();
							return { kind: "unknown", error: new Error("Exact staged replacement is unavailable") };
						}
						if (
							!this.#storage.replaceExactSync(stage.tempPath, this.#sessionFile, {
								stat: stage.sourceStat,
								sha256: stage.sourceSha256,
							})
						) {
							transition.dispose();
							return { kind: "not_promoted" };
						}
					} else {
						const replacement = this.#replaceSessionFileSync(stage.tempPath, this.#sessionFile);
						if (replacement.kind === "restored_previous") {
							transition.dispose();
							return { kind: "not_promoted", error: replacement.error };
						}
					}
				} catch (error) {
					transition.dispose();
					if (this.#persistWriter?.getCloseState() === "close_failed_retryable") {
						return { kind: "not_promoted", error: new Error("Session replacement could not be completed.") };
					}
					return { kind: "unknown", error: toError(error) };
				}
			}
		}
		this.#needsFullRewriteOnNextPersist = false;
		this.#flushed = stage.persistsToExistingFile;
		this.#ensuredOnDisk = stage.persistsToExistingFile;
		if (stage.persistsToExistingFile && this.#readOnlyResume && this.#sessionFile) {
			writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
			this.#readOnlyResume = false;
		}
		if (!stage.boundedCold) {
			this.#commitResidentTextStoreTransition(transition);
			return { kind: "promoted" };
		}
		const aggregateUsage = this.#usageStatistics;
		this.#commitResidentTextStoreTransition(transition, false);
		this.#usageStatistics = aggregateUsage;
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled) return { kind: "promoted" };
		const persisted = stage.appendEntries.map(entry => ({
			entry,
			line: Buffer.from(`${JSON.stringify(prepareEntryForPersistenceSync(entry, this.#blobStore))}\n`, "utf8"),
		}));
		const appendBytes = persisted.reduce((total, item) => total + item.line.byteLength, 0);
		const accountedBytes = persisted.reduce((total, item) => total + residentHotEntryBytes(item.line.byteLength), 0);
		const tailBytes = persisted.reduce(
			(total, item) =>
				total +
				tailRecordResidentBytes({
					seq: 0,
					kind: tailRecordKindForEntry(item.entry),
					ordinal: 0,
					id: item.entry.id,
					parentId: item.entry.parentId,
					type: item.entry.type,
					byteOffset: 0,
					byteLength: item.line.byteLength,
					recordDigest: "0".repeat(64),
				}),
			0,
		);
		if (
			runtime.hotSuffixBytes + appendBytes > this.#sidecarHotSuffixBudgetBytes ||
			!runtime.accountant.tryCharge(accountedBytes) ||
			!runtime.tailCache.tryAllocate(tailBytes)
		) {
			runtime.hotOverflowTransitions++;
			this.#ensureFullHotView();
			return { kind: "promoted" };
		}
		for (const item of persisted) {
			const ordinal = this.#nextColdOrdinal();
			if (!this.#applySidecarReducerDelta(item.entry, ordinal)) {
				this.#ensureFullHotView();
				return { kind: "promoted" };
			}
			if (!this.#appendColdSidecarRecord(item.entry, item.line, undefined, ordinal)) {
				this.#ensureFullHotView();
				return { kind: "promoted" };
			}
			runtime.hotSuffixBytes += item.line.byteLength;
		}
		this.#publishCommitMarkerFromCurrentTranscriptSync();
		runtime.terminalTransition = this.#classifySidecarReopen();
		return { kind: "promoted" };
	}

	async discardDefaultModelSelectionStage(stage: DefaultModelSelectionStage): Promise<void> {
		if (!stage.tempPath) return;
		try {
			await this.#storage.unlink(stage.tempPath);
		} catch (error) {
			if (!isEnoent(error)) throw toError(error);
		}
	}

	/**
	 * Force-persist all current entries to disk, even when no assistant message exists yet.
	 * Used by ACP mode where session/new must create a discoverable session immediately.
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.persist || !this.#sessionFile) return;
		if (this.#readOnlyResume) return;
		if (this.#flushed && !this.#needsFullRewriteOnNextPersist) return;
		await this.#rewriteFile();
		this.#ensuredOnDisk = true;
	}

	/** Flush pending writes to disk. Call before switching sessions or on shutdown. */
	async flush(): Promise<void> {
		await this.#queuePersistTask(async () => {
			if (this.#persistWriter) {
				await this.#persistWriter.flush();
				await this.#persistWriter.fsync();
			}
			if (this.#needsFullRewriteOnNextPersist && !this.#readOnlyResume) await this.#rewriteFileContents();
		});
		if (this.#persistError) throw this.#persistError;
	}

	#releaseClosedSessionState(): void {
		const runtime = this.#sidecarRuntime;
		if (runtime) {
			runtime.enabled = false;
			runtime.accountant.release(runtime.accountant.totalBytes);
			runtime.coldEntries.clear();
			runtime.tail = { ...runtime.tail, records: [] };
			runtime.labelsPins.clear();
			runtime.blockCache.release(runtime.blockCache.allocatedBytes);
			runtime.entryCache.release(runtime.entryCache.allocatedBytes);
			runtime.tailCache.release(runtime.tailCache.allocatedBytes);
			this.#sidecarRuntime = undefined;
		}
		this.#fileEntries = [];
		this.#byId.clear();
		this.#labelsById.clear();
		this.#resetMaterializedCaches();
		this.#releaseManagedSidecarCache();
		this.#clearBoundedManagedSource();
	}

	#releaseRejectedOpenResources(): void {
		this.#releaseResidentTextStore();
		if (this.#preparedNewSessions.size === 0) this.#releaseOwnedManagedAuthority();
		this.#releaseClosedSessionState();
	}

	async #retryRejectedOpenWriterCleanup(): Promise<void> {
		for (let attempt = 0; this.#persistWriter?.getCloseState() === "close_failed_retryable"; attempt++) {
			await unrefDelay(Math.min(100 * 2 ** Math.min(attempt, 6), 5_000));
			try {
				await this.#closePersistWriterInternal();
			} catch (error) {
				logger.warn("Retained rejected-open writer close retry failed", { error: toError(error).message });
			}
		}
		// The loop only exits once the writer is terminal (`closed` or the quarantined
		// `close_unknown`) or was already cleared by a successful close, so ownership of
		// the descriptor and of the rejected session's resident state always ends here.
		if (this.#persistWriter) {
			this.#persistWriter = undefined;
			this.#persistWriterPath = undefined;
		}
		this.#releaseRejectedOpenResources();
	}

	async #discardRejectedOpenState(): Promise<void> {
		let closeError: Error | undefined;
		for (let attempt = 0; this.#persistWriter && attempt < 2; attempt++) {
			try {
				await this.#closePersistWriterInternal();
			} catch (error) {
				closeError = toError(error);
				if (this.#persistWriter?.getCloseState() !== "close_failed_retryable") break;
			}
		}
		const state = this.#persistWriter?.getCloseState();
		if (state === "closed") {
			// The OS close was dispatched and confirmed, so cleanup succeeded even though
			// `close()` rethrew a queued write/flush drain failure. Reporting that drain
			// error as a cleanup failure would mask the real resume rejection, so record
			// it and let the caller surface the resume error alone.
			this.#persistWriter = undefined;
			this.#persistWriterPath = undefined;
			this.#releaseRejectedOpenResources();
			if (closeError)
				logger.warn("Rejected-open writer drained with errors before a confirmed close", {
					error: closeError.message,
				});
			return;
		}
		if (state === "close_unknown") {
			this.#persistWriter = undefined;
			this.#persistWriterPath = undefined;
			this.#releaseRejectedOpenResources();
			throw closeError ?? new Error("Rejected open writer close outcome is unknown");
		}
		if (this.#persistWriter) {
			// Certified pre-dispatch failure: the descriptor is still owned, so the writer
			// and the resident state it guards are retained until a retry reaches a
			// terminal close. The retry loop keeps this manager reachable on its own.
			void this.#retryRejectedOpenWriterCleanup().catch(error => {
				logger.warn("Rejected-open writer cleanup retry loop failed", { error: toError(error).message });
			});
			throw closeError ?? new Error("Rejected open writer close remains retryable");
		}
		this.#releaseRejectedOpenResources();
	}

	/** Close the persistent writer after flushing all pending data. */
	async close(): Promise<void> {
		await this.joinCwdTransition();
		SessionManager.releaseProcessCwdOwnership(this);
		// Drain any uncommitted prepared successors before releasing resources so
		// dispose/shutdown retains exact cleanup authority (#3138).
		try {
			await this.#retryPreparedNewSessionCleanups();
		} catch (error) {
			logger.warn("Prepared session cleanup during close failed; retained for retry", {
				error: toError(error).message,
			});
		}
		let closeError: unknown;
		let taskStarted = false;
		try {
			await this.#queuePersistTask(
				async () => {
					taskStarted = true;
					if (this.#persistWriter) {
						await this.#closePersistWriterInternal();
						this.#flushed = true;
					}
					if (this.#needsFullRewriteOnNextPersist && !this.#readOnlyResume) await this.#rewriteFileContents();
				},
				{ ignoreError: this.#closeRetryPending },
			);
			this.#persistError = undefined;
			this.#persistErrorReported = false;
			this.#closeRetryPending = false;
			this.#retireEphemeralArtifacts();
			await this.#drainEphemeralArtifactCleanups();
		} catch (error) {
			closeError = error;
			if (taskStarted) this.#closeRetryPending = true;
		}
		const terminalError = closeError ?? this.#persistError;
		if (terminalError) throw terminalError;
		this.#releaseResidentTextStore();
		if (this.#preparedNewSessions.size === 0) this.#releaseOwnedManagedAuthority();
		this.#releaseClosedSessionState();
	}
	/** Flush while open, then strictly close; retryable close skips the invalid second flush. */
	async flushAndCloseStrict(): Promise<SessionManagerCloseOutcome> {
		if (this.#persistWriter?.getCloseState() !== "close_failed_retryable") {
			await this.flush();
		}
		return this.closeStrict();
	}

	/**
	 * Strictly flush and close the persist writer, returning the certainty-aware close
	 * outcome without manufacturing success. The existing {@link close} path is
	 * preserved for best-effort callers; this seam lets strict ACP disposal prove
	 * writer closure before any destructive operation.
	 */
	async closeStrict(): Promise<SessionManagerCloseOutcome> {
		// Drain staged successors on the strict ACP dispose path as well as best-effort close (#3138).
		try {
			await this.#retryPreparedNewSessionCleanups();
		} catch (error) {
			logger.warn("Prepared session cleanup during closeStrict failed; retained for retry", {
				error: toError(error).message,
			});
		}
		let outcome: SessionManagerCloseOutcome = { kind: "closed" };
		await this.#queuePersistTask(async () => {
			const writer = this.#persistWriter;
			if (!writer) {
				this.#flushed = true;
				return;
			}
			try {
				await writer.close();
			} catch {
				// Outcome is captured from the underlying writer's close state below.
			}
			outcome = this.#closeOutcomeFromWriter(writer);
			if (outcome.kind === "closed") {
				this.#flushed = true;
				// Confirmed closed: release writer ownership.
				this.#persistWriter = undefined;
				this.#persistWriterPath = undefined;
			} else if (outcome.kind === "close_unknown") {
				// Quarantined (terminal): release ownership so no retry/finalizer
				// touches the uncertain fd again.
				this.#persistWriter = undefined;
				this.#persistWriterPath = undefined;
			}
			// close_failed_retryable: RETAIN the writer so a later closeStrict() call
			// can actually re-dispatch the OS close (ownership stays proven). The
			// wrapper must not manufacture success or surrender a retryable fd.
		});
		// Only tear down the resident blob store on a terminal outcome; a retryable
		// close leaves the session live for a genuine retry.
		if (!this.#persistWriter) {
			this.#releaseResidentTextStore();
			this.#retireEphemeralArtifacts();
			try {
				await this.#drainEphemeralArtifactCleanups();
			} catch (error) {
				outcome = { kind: "close_unknown", error: toError(error) };
			}
			if (this.#preparedNewSessions.size === 0) this.#releaseOwnedManagedAuthority();
			this.#releaseClosedSessionState();
		}
		return outcome;
	}

	#closeOutcomeFromWriter(writer: NdjsonFileWriter): SessionManagerCloseOutcome {
		const state = writer.getCloseState();
		const error = writer.getCloseError();
		switch (state) {
			case "closed":
				return { kind: "closed" };
			case "close_failed_retryable":
				return { kind: "close_failed_retryable", error: error ?? new Error("Writer close failed before dispatch") };
			case "close_unknown":
				return { kind: "close_unknown", error: error ?? new Error("Writer close outcome is unknown") };
			default:
				// "open" should not occur after close() returned, but treat defensively as
				// a non-quiescent terminal state rather than confirmed closed.
				return { kind: "close_unknown", error: error ?? new Error("Writer close did not dispatch") };
		}
	}

	getCwd(): string {
		return this.cwd;
	}

	/** Get usage statistics across all assistant messages in the session. */
	getUsageStatistics(): UsageStatistics {
		return this.#usageStatistics;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	/** Lists picker candidates within this manager's captured destination authority. */
	async listForResumePickerReadOnly(): Promise<SessionInfo[]> {
		return this.destination.kind === "managed"
			? await SessionManager.listManagedForResumePickerReadOnly(
					this.cwd,
					this.destination.securityContext.agentDir,
					this.#storage,
				)
			: await SessionManager.listForResumePickerReadOnly(this.cwd, this.destination.directory, this.#storage);
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}
	/**
	 * On-disk transcript file size in bytes. Returns 0 when the file is
	 * unavailable, unreadable, or no session file is set. The managed-storage
	 * path reads through the descriptor (no full-file scan); the plain-file
	 * path uses statSync.
	 */
	getTranscriptFileBytes(): number {
		if (!this.#sessionFile) return 0;
		try {
			return this.#statSync(this.#sessionFile).size;
		} catch {
			return 0;
		}
	}

	getSessionMemoryStats(): SessionMemoryStats {
		const runtime = this.#sidecarRuntime;
		if (!runtime) {
			return {
				sidecarEnabled: false,
				coldRetirementActive: false,
				sidecarIneligible: false,
				hotRegionBytes: 0,
				metaDescriptorBytes: 0,
				totalAccountedBytes: 0,
				reservedBudgetBytes: 0,
				allocatedCacheBytes: 0,
				hotResidentBytes: 0,
				metadataResidentBytes: 0,
				sidecarFileBytes: 0,
				firstOpen: this.#firstOpenTelemetry,
				lastReopenTransition: undefined,
				currentCommitTransition: undefined,
				lazyReopenAttempted: this.#lazyReopenAttempted,
				lazyReopenSucceeded: this.#lazyReopenSucceeded,
				lazyReopenFallbackReason: this.#lazyReopenFallbackReason,
				retirementFallbackReason: this.#retirementFallbackReason,
				autoDisabledReason: this.#sessionMemoryAutoDisabledReason,
				consecutiveBuildFailures: this.#consecutiveSidecarBuildFailures,
				parentArtifactEnabled: false,
				dictionaryArtifactEnabled: false,
				metadataDeltaDescriptorBytes: 0,
				coldIndexBytes: 0,
				coldIndexBlockCacheBytes: 0,
				coldEntryCacheBytes: 0,
				coldEntriesRetired: 0,
				coldEntriesReloaded: 0,
				rangeReadCount: 0,
				rangeReadGenerationMismatchCount: 0,
				sidecarRebuildCount: 0,
				coldMutationPromotions: 0,
				hotOverflowTransitions: 0,
				labelDiskFallbackCount: 0,
				shadowParityMismatchCount: 0,
				shadowParityCheckCount: 0,
				transcriptGeneration: 0,
			};
		}
		const reducerBytes = JSON.stringify(runtime.reducer).length * 2 + 48;
		const metaDescriptorBytes =
			runtime.blockCache.allocatedBytes +
			runtime.entryCache.allocatedBytes +
			runtime.tailCache.allocatedBytes +
			runtime.labelsPins.totalBytes +
			reducerBytes +
			(runtime.metadataDelta?.descriptorBytes ?? 0);
		const reservedBudgetBytes = runtime.enabled
			? runtime.blockCache.budgetBytes +
				runtime.entryCache.budgetBytes +
				runtime.tailCache.budgetBytes +
				REDUCER_BUDGET_BYTES +
				LABELS_PINS_BUDGET_BYTES +
				1024 * 1024
			: 0;
		const hotResidentBytes = runtime.enabled
			? runtime.tail.records.reduce((total, record) => total + residentHotEntryBytes(record.byteLength), 0)
			: 0;
		const providerStateResidentBytes = runtime.providerStateEntries.reduce(
			(total, entry) => total + residentHotEntryBytes(Buffer.byteLength(JSON.stringify(entry), "utf8")),
			0,
		);
		runtime.reservedBudgetBytes = reservedBudgetBytes;
		runtime.hotResidentBytes = hotResidentBytes;
		let sidecarFileBytes = 0;
		for (const sidecarPath of this.#disposableSidecarPaths()) {
			if (!sidecarPath) continue;
			try {
				sidecarFileBytes += this.#storage.statSync(sidecarPath).size;
			} catch {
				// Missing disposable artifacts contribute no live file bytes.
			}
		}
		runtime.sidecarFileBytes = sidecarFileBytes;
		this.#firstOpenTelemetry.sidecarFileBytes = sidecarFileBytes;
		return {
			sidecarEnabled: runtime.enabled,
			coldRetirementActive: this.#coldSidecarActive(),
			sidecarIneligible: runtime.sidecarIneligible,
			hotRegionBytes: runtime.hotSuffixBytes,
			metaDescriptorBytes,
			totalAccountedBytes: runtime.accountant.totalBytes,
			reservedBudgetBytes,
			allocatedCacheBytes:
				runtime.blockCache.allocatedBytes + runtime.entryCache.allocatedBytes + runtime.tailCache.allocatedBytes,
			hotResidentBytes,
			metadataResidentBytes:
				runtime.labelsPins.totalBytes +
				reducerBytes +
				providerStateResidentBytes +
				(runtime.metadataDelta?.descriptorBytes ?? 0),
			sidecarFileBytes,
			firstOpen: this.#firstOpenTelemetry,
			lastReopenTransition: runtime.reopenTransition,
			currentCommitTransition: runtime.terminalTransition,
			lazyReopenAttempted: this.#lazyReopenAttempted,
			lazyReopenSucceeded: this.#lazyReopenSucceeded,
			lazyReopenFallbackReason: this.#lazyReopenFallbackReason,
			retirementFallbackReason: this.#retirementFallbackReason,
			autoDisabledReason: this.#sessionMemoryAutoDisabledReason,
			consecutiveBuildFailures: this.#consecutiveSidecarBuildFailures,
			parentArtifactEnabled: runtime.parentArtifact !== undefined,
			dictionaryArtifactEnabled: runtime.dictionary !== undefined,
			metadataDeltaDescriptorBytes: runtime.metadataDelta?.descriptorBytes ?? 0,
			coldIndexBytes: runtime.validatedIndexDescriptor?.size ?? 0,
			coldIndexBlockCacheBytes: runtime.blockCache.allocatedBytes,
			coldEntryCacheBytes: runtime.entryCache.allocatedBytes,
			coldEntriesRetired: runtime.coldEntriesRetired,
			coldEntriesReloaded: runtime.coldEntriesReloaded,
			rangeReadCount: runtime.rangeReadCount,
			rangeReadGenerationMismatchCount: runtime.rangeReadGenerationMismatchCount,
			sidecarRebuildCount: runtime.sidecarRebuildCount,
			coldMutationPromotions: runtime.coldMutationPromotions,
			hotOverflowTransitions: runtime.hotOverflowTransitions,
			labelDiskFallbackCount: runtime.labelDiskFallbackCount,
			shadowParityMismatchCount: runtime.shadowParityMismatchCount,
			shadowParityCheckCount: runtime.shadowParityCheckCount,
			transcriptGeneration: runtime.transcriptGeneration,
		};
	}

	#effectiveSessionMemoryMode(size?: number): Exclude<SessionMemoryMode, "auto"> {
		if (this.#sessionMemoryMode !== "auto") return this.#sessionMemoryMode;
		if (process.platform === "win32") return "off";
		let transcriptBytes = size;
		if (transcriptBytes === undefined && this.#sessionFile && this.#storage.existsSync(this.#sessionFile)) {
			try {
				transcriptBytes = this.#storage.statSync(this.#sessionFile).size;
			} catch {
				return "off";
			}
		}
		return transcriptBytes !== undefined && transcriptBytes >= autoModeMinTranscriptBytes() ? "enabled" : "off";
	}

	setSessionMemoryMode(mode: SessionMemoryMode): void {
		const retainedColdRuntime = this.#coldSidecarActive();
		this.#sessionMemoryMode = mode;
		if (mode === "off") {
			this.#consecutiveSidecarBuildFailures = 0;
			this.#sessionMemoryAutoDisabledReason = undefined;
			// Rollback is non-materializing: already-retired entries remain lazily readable
			// from the proven sidecar for this process. A subsequent off-mode process open
			// ignores derived state and restores the ordinary eager path.
			if (retainedColdRuntime) return;
			const runtime = this.#sidecarRuntime;
			if (runtime) {
				for (const sidecarPath of this.#disposableSidecarPaths()) {
					if (!sidecarPath) continue;
					try {
						this.#storage.unlinkSync(sidecarPath);
					} catch {
						// Sidecars are disposable; off mode remains eager even if best-effort cleanup fails.
					}
				}
			}
			this.#sidecarRuntime = undefined;
			this.#releaseManagedSidecarCache();
			return;
		}
		if (mode === "shadow" && retainedColdRuntime) return;
		if (
			(!this.#sidecarRuntime?.enabled ||
				this.#sidecarRuntime.sidecarIneligible ||
				(mode === "enabled" && !this.#sidecarRuntime.dictionary)) &&
			this.persist &&
			this.#sessionFile
		) {
			this.#buildDisposableSidecars(this.#fileEntries);
		}
		if (mode === "enabled") this.#retireColdEntries();
	}

	acquireMemoryGuardParticipantIngressLease(): MemoryGuardParticipantIngressLease {
		if (this.#memoryGuardParticipantIngressToken)
			throw new Error("memory_guard_participant_ingress_lease_already_held");
		const token = Symbol("memory_guard_participant_ingress_lease");
		this.#memoryGuardParticipantIngressToken = token;
		let released = false;
		return Object.freeze({
			token,
			release: () => {
				if (released) return;
				released = true;
				if (this.#memoryGuardParticipantIngressToken === token)
					this.#memoryGuardParticipantIngressToken = undefined;
			},
		});
	}

	#assertMemoryGuardParticipantIngressLease(lease: MemoryGuardParticipantIngressLease): void {
		if (this.#memoryGuardParticipantIngressToken !== lease.token) {
			throw new Error("memory_guard_participant_ingress_lease_invalid");
		}
	}

	#stageMemoryGuardCheckpointBlobs(blobs: Map<string, Buffer>): void {
		const stagedImageStore = new MemoryBlobStore();
		for (const blob of blobs.values()) {
			this.#putResidentTextBlobSync(blob);
			stagedImageStore.putSync(blob);
		}
		this.#residentImageBlobStore = stagedImageStore;
		this.#memoryGuardCheckpointBlobs = blobs;
		this.#residentBlobRevision++;
	}

	async createMemoryGuardCheckpoint(
		input: MemoryGuardCreateCheckpointInput,
	): Promise<MemoryGuardSessionManagerCheckpointV1> {
		this.#assertMemoryGuardParticipantIngressLease(input.ingressLease);
		if (!this.#sessionFile) throw new Error("memory_guard_checkpoint_session_file_unavailable");
		await this.flush();
		const captured = SessionManager.captureTranscriptStrict(this.#sessionFile, this.#storage);
		if (captured.kind !== "captured") {
			throw new Error(`memory_guard_checkpoint_capture_failed:${captured.reason}`);
		}
		const capturedBytes = captured.snapshot.materialize();
		if (capturedBytes.byteLength > MEMORY_GUARD_CHECKPOINT_FILE_MAX_BYTES)
			throw new Error("memory_guard_checkpoint_transcript_capacity_exceeded");
		const transcriptText = decodeCheckpointUtf8(capturedBytes);
		if (transcriptText === null) throw new Error("memory_guard_checkpoint_transcript_unreadable");
		const entries = parseSessionEntries(transcriptText);
		const sessionId = this.getSessionId();
		assertMemoryGuardSessionId(sessionId);
		const sessionName = this.getSessionName() ?? null;
		const revisions = this.revisionSnapshot();
		const participantRoot = memoryGuardParticipantRoot(input.checkpointRoot, sessionId);
		const transcriptRelativePath = memoryGuardParticipantRelativePath(sessionId, "transcript.jsonl");
		const blobRootRelativePath = memoryGuardParticipantRelativePath(sessionId, "blobs");
		const blobManifestRelativePath = memoryGuardParticipantRelativePath(sessionId, "blob-manifest.json");
		const refs = [...collectCheckpointBlobRefs(entries)].sort();
		if (refs.length > MEMORY_GUARD_CHECKPOINT_BLOB_MAX_ENTRIES)
			throw new Error("memory_guard_checkpoint_blob_count_exceeded");
		const blobManifestEntries: MemoryGuardCheckpointBlobManifestEntryV1[] = [];
		const blobWrites: Array<{ data: Buffer; relativePath: string }> = [];
		let aggregateBlobBytes = 0;
		for (const ref of refs) {
			const hash = parseBlobRef(ref);
			if (!hash) continue;
			const data =
				this.#residentTextBlobStore.getCheckedSync(hash) ??
				this.#residentImageBlobStore.getCheckedSync(hash) ??
				this.#blobStore.getCheckedSync(hash);
			if (!data) throw new Error(`memory_guard_checkpoint_blob_missing:${hash}`);
			if (data.byteLength > MEMORY_GUARD_CHECKPOINT_FILE_MAX_BYTES)
				throw new Error(`memory_guard_checkpoint_blob_capacity_exceeded:${hash}`);
			aggregateBlobBytes += data.byteLength;
			if (aggregateBlobBytes > MEMORY_GUARD_CHECKPOINT_BLOB_TOTAL_MAX_BYTES)
				throw new Error("memory_guard_checkpoint_blob_total_capacity_exceeded");
			const relativePath = hash;
			blobWrites.push({ data, relativePath });
			blobManifestEntries.push({
				bytes: String(data.byteLength),
				relative_path: relativePath,
				sha256: memoryGuardSha256Hex(data),
			});
		}
		const publishedCheckpointPaths: string[] = [];
		const cleanupPublishedCheckpointPaths = async (): Promise<void> => {
			for (const publishedPath of publishedCheckpointPaths.reverse())
				await fs.promises.rm(publishedPath, { force: true }).catch(() => undefined);
			await fs.promises.rmdir(path.join(input.checkpointRoot, blobRootRelativePath)).catch(() => undefined);
			await fs.promises.rmdir(participantRoot).catch(() => undefined);
		};
		const publishCheckpointFile = async (filePath: string, data: Uint8Array | string): Promise<void> => {
			try {
				await writeOwnerOnlyFileNoReplace(filePath, data);
				publishedCheckpointPaths.push(filePath);
			} catch (error) {
				await cleanupPublishedCheckpointPaths();
				throw error;
			}
		};
		await ensureOwnerOnlyDirectory(participantRoot);
		await publishCheckpointFile(path.join(input.checkpointRoot, transcriptRelativePath), capturedBytes);
		for (const write of blobWrites)
			await publishCheckpointFile(
				path.join(input.checkpointRoot, blobRootRelativePath, write.relativePath),
				write.data,
			);
		blobManifestEntries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
		const blobManifest: MemoryGuardCheckpointBlobManifestV1 = {
			entries: blobManifestEntries,
			schema_version: 1,
		};
		const blobManifestText = memoryGuardCanonicalJson(blobManifest);
		await publishCheckpointFile(path.join(input.checkpointRoot, blobManifestRelativePath), blobManifestText);
		const checkpoint: MemoryGuardSessionManagerCheckpointV1 = {
			blob_authority: {
				kind: "checkpoint_blob_tree_v1",
				manifest_relative_path: blobManifestRelativePath,
				manifest_sha256: memoryGuardSha256Hex(blobManifestText),
				root_relative_path: blobRootRelativePath,
			},
			revisions: toSessionManagerCheckpointRevisionStrings(revisions),
			schema_version: 1,
			session_id: sessionId,
			session_name: sessionName,
			transcript: {
				bytes: String(capturedBytes.byteLength),
				relative_path: transcriptRelativePath,
				sha256: captured.snapshot.identity.sha256,
			},
		};
		const checkpointPath = path.join(
			input.checkpointRoot,
			memoryGuardParticipantRelativePath(sessionId, "session-manager.json"),
		);
		await publishCheckpointFile(checkpointPath, memoryGuardCanonicalJson(checkpoint));
		const currentRevisions = this.revisionSnapshot();
		const recaptured = SessionManager.captureTranscriptStrict(this.#sessionFile, this.#storage);
		if (
			this.getSessionId() !== sessionId ||
			(this.getSessionName() ?? null) !== sessionName ||
			Object.keys(revisions).some(
				key =>
					currentRevisions[key as keyof SessionManagerRevisionSnapshot] !==
					revisions[key as keyof SessionManagerRevisionSnapshot],
			) ||
			recaptured.kind !== "captured" ||
			!sameResumeIdentity(captured.snapshot.identity, recaptured.snapshot.identity)
		) {
			await cleanupPublishedCheckpointPaths();
			throw new Error("memory_guard_checkpoint_state_changed_during_capture");
		}
		return checkpoint;
	}

	/**
	 * Returns the session artifacts directory path (session file path without .jsonl).
	 * Returns null when the session is not persisted to a file.
	 * When this session has adopted an external ArtifactManager (subagent case),
	 * never exposes that managed directory as a pathname. Reads and writes use the
	 * adopted manager capability directly.
	 */
	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return null;
		const sessionFile = this.#sessionFile;
		return sessionFile ? sessionFile.slice(0, -6) : null;
	}

	isManagedDestination(): boolean {
		return this.destination.kind === "managed";
	}

	/** Retain the verified destination contract for bounded forks. @internal */
	getDestinationForFork(): SessionDestination {
		return this.destination;
	}

	/** Supplies opaque retained authority for mandatory managed legacy local migration. */
	getManagedLegacyLocalMigrationSource(): ManagedLegacyLocalMigrationSource | null {
		return this.#managedLegacyLocalMigrationSourceFor(this.#sessionFile);
	}

	#managedLegacyLocalMigrationSourceFor(sessionFile: string | undefined): ManagedLegacyLocalMigrationSource | null {
		if (this.destination.kind !== "managed" || !sessionFile || this.#adoptedArtifactManager) return null;
		const store = this.#managedTranscriptStore(sessionFile);
		const legacyArtifactsRoot = path.basename(sessionFile.slice(0, -6));
		const legacyLocalRoot = path.posix.join(legacyArtifactsRoot, "local");
		return {
			capture: async () => {
				let snapshot: native.NativeDirectoryTreeSnapshot;
				const captureLegacyLocal = (): native.NativeDirectoryTreeSnapshot => store.captureTree(legacyLocalRoot);
				try {
					snapshot = captureLegacyLocal();
				} catch (error) {
					if (error instanceof Error && error.message === "not_found") return null;
					// Prior writers (and some fixtures) can leave group/other-readable
					// descendants under artifacts/<id>/local. Managed captureTree fails
					// closed on mode_mismatch; re-secure owner-only modes once — same
					// class of recovery as prepareManagedSessionScopeForWriteSync.
					if (isRecoverableOwnerOnlyModeDrift(error)) {
						resecureOwnerOnlyManagedTree(path.join(sessionFile.slice(0, -6), "local"));
						try {
							snapshot = captureLegacyLocal();
						} catch (retryError) {
							if (retryError instanceof Error && retryError.message === "not_found") return null;
							throw retryError;
						}
					} else if (error instanceof Error && error.message === "reparse_point") {
						try {
							store.captureTree(legacyArtifactsRoot);
						} catch (artifactsError) {
							if (artifactsError instanceof Error && artifactsError.message === "not_found") return null;
						}
						throw error;
					} else {
						throw error;
					}
				}
				let totalBytes = 0;
				for (const entry of snapshot.entries) if (entry.kind === "file") totalBytes += Number(entry.size);
				if (totalBytes > 64 * 1024 * 1024) throw new Error("Legacy local:// migration exceeds the safe size limit");
				const entries = snapshot.entries.map(entry => {
					if (entry.kind === "directory") return { relativePath: entry.relativePath, kind: "directory" as const };
					const captured = store.readExpected(path.posix.join(legacyLocalRoot, entry.relativePath));
					if (
						!captured ||
						captured.identity.dev.toString() !== entry.dev ||
						captured.identity.ino.toString() !== entry.ino ||
						captured.identity.size.toString() !== entry.size ||
						crypto.createHash("sha256").update(captured.bytes).digest("hex") !== entry.sha256
					)
						throw new Error("Legacy local:// migration source changed during capture");
					return {
						relativePath: entry.relativePath,
						kind: "file" as const,
						bytes: captured.bytes,
						sha256: entry.sha256,
					};
				});
				const verified = store.captureTree(legacyLocalRoot);
				if (JSON.stringify(verified) !== JSON.stringify(snapshot))
					throw new Error("Legacy local:// migration source changed during capture");
				return { snapshot, entries };
			},
			retire: snapshot => store.removeTreeExpected(legacyLocalRoot, snapshot),
		};
	}

	/**
	 * Adopt an externally-owned ArtifactManager. Used by subagents to share
	 * the parent session's artifact directory and ID counter.
	 */
	adoptArtifactManager(manager: ArtifactManager, parent?: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
		if (parent) this.#stagedArtifactParent = parent;
	}

	/** Release only the matching externally adopted manager. */
	releaseArtifactManager(manager: ArtifactManager): void {
		if (this.#adoptedArtifactManager === manager) this.#adoptedArtifactManager = null;
	}

	/** Temporarily release adopted authority while an outer transition validates its successor. */
	stageAdoptedArtifactManagerForTransition(): void {
		this.#adoptedArtifactManager = null;
	}

	/** Prove manager authority by exact object identity, never by pathname shape. */
	isArtifactManagerAuthorized(manager: ArtifactManager): boolean {
		return (
			manager === this.#adoptedArtifactManager ||
			manager === this.#artifactManager ||
			manager === this.#ephemeralArtifactManager
		);
	}

	/**
	 * Returns the ArtifactManager this session writes through. Lazily creates
	 * one bound to the current session file unless an external manager was
	 * adopted via `adoptArtifactManager`. Falls back to the lazily created
	 * ephemeral filesystem store once a non-persistent session has saved an
	 * artifact, so `artifact://` stays resolvable. Returns null only when no
	 * store has been established yet.
	 */
	getArtifactManager(): ArtifactManager | null {
		return this.#getOrCreateArtifactManager() ?? this.#ephemeralArtifactManager;
	}

	/** Linearizably establish this session's persistent or ephemeral artifact manager. */
	async ensureArtifactManager(): Promise<ArtifactManager | null> {
		return this.#getOrCreateArtifactManager() ?? (await this.#ensureEphemeralArtifactManager());
	}

	/**
	 * Returns an artifact manager bound to the current session file.
	 * Recreates the manager when the active session file changes.
	 */
	#getOrCreateArtifactManager(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;
		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) {
			return this.#artifactManager;
		}

		const artifactDir = sessionFile.slice(0, -6);
		let artifactStorage: string | ManagedSessionDescendantStore = artifactDir;
		if (this.destination.kind === "managed") {
			artifactStorage = this.#managedTranscriptStore(sessionFile).deriveSubtree(path.basename(artifactDir));
		}
		const manager = new ArtifactManager(artifactStorage);
		this.#artifactManager = manager;
		this.#artifactManagerSessionFile = sessionFile;
		return manager;
	}

	/**
	 * Allocate a new artifact path and ID for the current session.
	 * Returns an empty object when the session is not persisted.
	 */
	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		const manager = this.#getOrCreateArtifactManager();
		if (!manager) return {};
		return manager.allocatePath(toolType);
	}

	/**
	 * Save artifact content under the current session and return artifact ID.
	 * Persistent sessions write into the session artifact directory; non-persistent
	 * sessions write into a lazily created temporary directory so the content is
	 * read back from the filesystem instead of being retained in memory.
	 */
	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#getOrCreateArtifactManager() ?? (await this.#ensureEphemeralArtifactManager());
		return manager ? manager.save(content, toolType) : undefined;
	}

	async #validatedEvictedToolOutputHandle(
		handle: unknown,
	): Promise<{ manager: ArtifactManager; handle: EvictedToolOutputHandle }> {
		const validation = validateEvictedToolOutputHandle(handle);
		if (!validation.ok) throw new EvictedArtifactValidationError(validation.code, validation.diagnostic);
		const manager = this.#getOrCreateArtifactManager();
		if (!manager) throw new EvictedArtifactValidationError("unavailable", "artifact persistence unavailable");
		return { manager, handle: validation.handle };
	}

	async #verifyEvictedToolOutputDigest(manager: ArtifactManager, handle: EvictedToolOutputHandle): Promise<void> {
		const stream = await manager.openReadStream(handle.artifactId);
		const reader = stream.getReader();
		const digest = crypto.createHash("sha256");
		let bytes = 0;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				if (!(next.value instanceof Uint8Array))
					throw new EvictedArtifactValidationError(
						"invalid_artifact_stream",
						"eviction artifact stream is invalid",
					);
				bytes += next.value.byteLength;
				digest.update(next.value);
			}
		} finally {
			reader.releaseLock();
		}
		if (bytes !== handle.bytes) {
			throw new EvictedArtifactValidationError(
				"byte_length_mismatch",
				`evicted artifact byte length mismatch: expected ${handle.bytes}, read ${bytes}`,
			);
		}
		if (digest.digest("hex") !== handle.sha256)
			throw new EvictedArtifactValidationError("sha256_mismatch", "evicted artifact sha256 mismatch");
	}

	async #readValidatedEvictedToolOutput(
		handle: unknown,
	): Promise<{ manager: ArtifactManager; handle: EvictedToolOutputHandle; text: string }> {
		const validated = await this.#validatedEvictedToolOutputHandle(handle);
		const text = await validated.manager.readRange(validated.handle.artifactId);
		const bytes = Buffer.from(text, "utf8");
		if (bytes.byteLength !== validated.handle.bytes) {
			throw new EvictedArtifactValidationError(
				"byte_length_mismatch",
				`evicted artifact byte length mismatch: expected ${validated.handle.bytes}, read ${bytes.byteLength}`,
			);
		}
		const digest = crypto.createHash("sha256").update(bytes).digest("hex");
		if (digest !== validated.handle.sha256)
			throw new EvictedArtifactValidationError("sha256_mismatch", "evicted artifact sha256 mismatch");
		return { ...validated, text };
	}

	/** Inspect an evicted artifact using a bounded range read; never rehydrates by default. */
	async inspectEvictedToolOutput(
		handle: unknown,
		range?: { start?: number; endExclusive?: number },
	): Promise<{ outcome: "saved" | "unavailable" | "failed"; text?: string; diagnostic?: string }> {
		if (
			range &&
			((range.start !== undefined && (!Number.isSafeInteger(range.start) || range.start < 0)) ||
				(range.endExclusive !== undefined &&
					(!Number.isSafeInteger(range.endExclusive) || range.endExclusive < 0)) ||
				(range.start !== undefined && range.endExclusive !== undefined && range.start > range.endExclusive))
		) {
			return { outcome: "unavailable", diagnostic: "invalid artifact byte range" };
		}
		try {
			const validated = await this.#validatedEvictedToolOutputHandle(handle);
			await this.#verifyEvictedToolOutputDigest(validated.manager, validated.handle);
			const boundedRange = range ?? {
				start: 0,
				endExclusive: Math.min(validated.handle.bytes, 16 * 1024 * 1024),
			};
			const text = await validated.manager.readRange(validated.handle.artifactId, boundedRange);
			return { outcome: "saved", text };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const diagnostic = error instanceof EvictedArtifactValidationError ? `${error.code}: ${message}` : message;
			if (
				error instanceof EvictedArtifactValidationError ||
				/not found|ENOENT|no such file|unavailable|unsupported eviction|invalid|incomplete/i.test(message)
			) {
				return { outcome: "unavailable", diagnostic };
			}
			return { outcome: "failed", diagnostic };
		}
	}

	/** Explicit full rehydration operation; callers must opt into materialization. */
	async rehydrateToolResultMessage(handle: unknown): Promise<string> {
		const validated = await this.#readValidatedEvictedToolOutput(handle);
		return validated.text;
	}

	/**
	 * Resolve an artifact ID to an on-disk path for the current session.
	 * Returns null when the artifact is missing.
	 */
	async getArtifactPath(id: string): Promise<string | null> {
		const manager = this.getArtifactManager();
		if (!manager) return null;
		return manager.getPath(id);
	}

	/**
	 * Create the non-persistent session's temporary artifact directory on first use.
	 * Returns null when the directory cannot be created; callers then report no artifact.
	 */
	async #ensureEphemeralArtifactManager(): Promise<ArtifactManager | null> {
		if (!this.#ephemeralArtifactInit) {
			let init: Promise<ArtifactManager | null>;
			init = fs.promises
				.mkdtemp(path.join(os.tmpdir(), "gjc-session-artifacts-"))
				.then(async dir => {
					try {
						await SessionManagerTestHooks.beforeEphemeralArtifactManagerInstall?.(dir);
					} catch (error) {
						await fs.promises.rm(dir, { recursive: true, force: true });
						throw error;
					}
					const manager = new ArtifactManager(dir);
					if (this.#ephemeralArtifactInit !== init) {
						await fs.promises.rm(dir, { recursive: true, force: true });
						return null;
					}
					this.#ephemeralArtifactDir = dir;
					this.#ephemeralArtifactManager = manager;
					return manager;
				})
				.catch(() => null);
			this.#ephemeralArtifactInit = init;
		}
		const init = this.#ephemeralArtifactInit;
		const manager = await init;
		if (!manager && this.#ephemeralArtifactInit === init) this.#ephemeralArtifactInit = null;
		return manager;
	}

	/** Unbind the active ephemeral root only after a successor transition commits. */
	#retireEphemeralArtifacts(): void {
		const dir = this.#ephemeralArtifactDir;
		const init = this.#ephemeralArtifactInit;
		if (!dir && !init) return;
		this.#ephemeralArtifactManager = null;
		this.#ephemeralArtifactDir = null;
		this.#ephemeralArtifactInit = null;
		const cleanup = (async () => {
			const initialized = await init;
			const cleanupDir = dir ?? initialized?.dir;
			if (cleanupDir) await fs.promises.rm(cleanupDir, { recursive: true, force: true });
		})();
		void cleanup.catch(() => {});
		this.#ephemeralArtifactCleanups.add(cleanup);
	}

	/** Retire predecessor ephemeral artifacts after an outer logical transition commits. */
	retireEphemeralArtifactsAfterTransition(): void {
		this.#retireEphemeralArtifacts();
	}

	async #drainEphemeralArtifactCleanups(): Promise<void> {
		while (this.#ephemeralArtifactCleanups.size > 0) {
			const pending = Array.from(this.#ephemeralArtifactCleanups);
			this.#ephemeralArtifactCleanups.clear();
			await Promise.all(pending);
		}
	}

	/**
	 * Path to the unsent-input draft sidecar for an explicit session. It lives
	 * inside the artifacts directory so `dropSession` removes it with its owner.
	 * Managed drafts use a retained descendant-store capability instead.
	 */
	#getDraftPath(): string | null {
		if (this.destination.kind === "managed") return null;
		const dir = this.getArtifactsDir();
		return dir ? path.join(dir, "draft.txt") : null;
	}

	/** Retained authority for this managed session's private draft sidecar. */
	#getManagedDraftStore(): ManagedSessionDescendantStore | null {
		if (this.destination.kind !== "managed" || !this.#sessionFile) return null;
		return this.#managedTranscriptStore().deriveSubtree(path.basename(this.#sessionFile.slice(0, -6)));
	}

	/**
	 * Persist (or clear) the current editor draft so the next resume of this
	 * session can restore it. Empty text deletes any stale draft. No-op when the
	 * session is not persisted.
	 */
	async saveDraft(text: string): Promise<void> {
		if (this.destination.kind === "managed") {
			if (text.length === 0) {
				const store = this.#getManagedDraftStore();
				if (!store) return;
				const removedDraft = await store.consume("draft.txt");
				if (this.#readOnlyResume && this.#sessionFile && (removedDraft !== null || this.#resumedDraftConsumed)) {
					writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
					this.#readOnlyResume = false;
					this.#resumedDraftConsumed = false;
				}
				return;
			}
			// Force the session header onto disk so resume can find the file we are
			// attaching this draft to. Without this, a session whose first message
			// never produced an assistant reply would persist a draft next to a
			// session file that does not exist on disk.
			await this.ensureOnDisk();
			const store = this.#getManagedDraftStore();
			if (!store) return;
			await store.replace("draft.txt", Buffer.from(text, "utf8"));
			if (this.#readOnlyResume && this.#sessionFile) {
				writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
				this.#readOnlyResume = false;
			}
			return;
		}
		const draftPath = this.#getDraftPath();
		if (!draftPath || !this.persist) return;
		if (text.length === 0) {
			let removedDraft = false;
			try {
				await this.#storage.unlink(draftPath);
				removedDraft = true;
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			if (this.#readOnlyResume && this.#sessionFile && (removedDraft || this.#resumedDraftConsumed)) {
				writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
				this.#readOnlyResume = false;
				this.#resumedDraftConsumed = false;
			}
			return;
		}
		// Force the session header onto disk so resume can find the file we are
		// attaching this draft to. Without this, a session whose first message
		// never produced an assistant reply would persist a draft next to a
		// session file that does not exist on disk.
		await this.ensureOnDisk();
		const artifactManager = this.#getOrCreateArtifactManager();
		if (!artifactManager) return;
		await artifactManager.replaceNamed("draft.txt", text);
		if (this.#readOnlyResume && this.#sessionFile) {
			writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
			this.#readOnlyResume = false;
		}
	}

	/**
	 * Read and remove the saved draft. Returns the previously-saved text, or
	 * null when no draft is pending. Single-shot: a successful read removes the
	 * sidecar so a subsequent resume does not re-restore the same text.
	 */
	async consumeDraft(): Promise<string | null> {
		if (this.destination.kind === "managed") {
			const draft = await this.#getManagedDraftStore()?.consume("draft.txt");
			if (draft && this.#readOnlyResume) this.#resumedDraftConsumed = true;
			return draft ? Buffer.from(draft).toString("utf8") : null;
		}
		const draftPath = this.#getDraftPath();
		if (!draftPath) return null;
		let text: string;
		try {
			text = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#readOnlyResume) this.#resumedDraftConsumed = true;
		return text;
	}

	/** The source that set the session name: "user" (manual /rename or RPC) or "auto" (generated title). */
	get titleSource(): "auto" | "user" | undefined {
		return this.#titleSource;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	/** Strip C0/C1 control characters (includes ESC, so removes ANSI sequences) and collapse whitespace. */
	static #sanitizeName(name: string): string {
		return name
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim()
			.slice(0, SESSION_NAME_MAX_CHARS);
	}

	/**
	 * Set the session display name.
	 * @param source - "user" for explicit renames (/rename command, RPC); "auto" for generated titles.
	 *   Auto-generated titles are silently ignored when the user has already set a name.
	 */
	#assertRecoveryHydrationWritable(): void {
		if (this.#recoveryHydrationContext) throw new Error("recovery_hydration_not_promoted");
	}
	/**
	 * Identity-less committed managed mutations are sticky: the canonical file may
	 * already contain bytes that cannot be bound to a descriptor. Do not alter the
	 * resident graph while that outcome is unresolved, because a later rewrite
	 * could make the stale predecessor authoritative again.
	 */
	#assertResidentMutationWritable(): void {
		this.#assertRecoveryHydrationWritable();
		if (this.#persistError) throw this.#persistError;
	}
	async setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		this.#assertRecoveryHydrationWritable();
		if (this.#persistError) throw this.#persistError;
		// User-set names take permanent precedence over auto-generated ones.
		if (this.#titleSource === "user" && source === "auto") return false;

		const sanitized = SessionManager.#sanitizeName(name);
		if (!sanitized) return false;

		this.#sessionName = sanitized;
		this.#titleSource = source;
		await this.#appendHeaderPatch({ title: sanitized, titleSource: source });
		return true;
	}

	async #appendHeaderPatch(patch: HeaderPatchRecord["patch"]): Promise<void> {
		if (this.#persistError) throw this.#persistError;
		const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		if (!header) return;
		applyHeaderPatch(header, patch);
		this.#headerExportRevision++;
		await this.#persistPatch({ type: "header_patch", patch });
	}

	#appendManagedRecordsSync(records: readonly (FileEntry | SessionPatchRecord)[]): void {
		if (!this.#sessionFile) throw new Error("Managed transcript path is unavailable");
		this.#withSessionPersistenceFenceSync(() => {
			const sessionFile = this.#sessionFile!;
			const store = this.#managedTranscriptStore(sessionFile);
			const relativePath = path.basename(sessionFile);
			const bytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
			let receipt: ManagedAppendReceipt;
			if (this.#managedPersistExpectedIdentity) {
				try {
					receipt = store.appendExpectedIdentitySync(relativePath, bytes, this.#managedPersistExpectedIdentity);
				} catch (err) {
					if (err instanceof ManagedCommittedMutationError && err.operation === "append") {
						// The append may have committed before the native receipt failed. Keep
						// the exact descriptor-bound successor when available and force the next
						// queued persistence task through a complete rewrite; never recapture a
						// pathname and adopt a racing successor.
						this.#managedPersistExpectedIdentity = err.identity;
						this.#needsFullRewriteOnNextPersist = true;
						throw err;
					}
					const predecessorMissing = store.descriptorExpected(relativePath) === null;
					if (
						!isEnoent(err) &&
						(!(err instanceof Error) || err.message !== "managed_append_identity_mismatch" || !predecessorMissing)
					)
						throw err;
					// Appending only the new records would create a truncated transcript.
					// Recreate the missing file from the complete resident entry set instead.
					this.#managedPersistExpectedIdentity = undefined;
					this.#rewriteFileSync();
					return;
				}
			} else {
				try {
					receipt = store.appendSync(relativePath, bytes);
				} catch (err) {
					if (err instanceof ManagedCommittedMutationError && err.operation === "append") {
						this.#managedPersistExpectedIdentity = err.identity;
						this.#needsFullRewriteOnNextPersist = true;
					}
					throw err;
				}
			}
			this.#managedPersistExpectedIdentity = receipt.identity;
			try {
				this.#publishSessionCommitMarkerSync(receipt.descriptor);
			} catch (error) {
				this.#managedPersistExpectedIdentity = receipt.identity;
				this.#needsFullRewriteOnNextPersist = true;
				throw new ManagedCommittedMutationError("append", error, receipt.identity);
			}
		});
	}

	async #persistPatch(record: SessionPatchRecord): Promise<void> {
		await this.#persistPatches([record]);
	}

	async #persistPatches(records: readonly SessionPatchRecord[]): Promise<void> {
		if (records.length === 0) return;
		if (this.#coldSidecarActive()) this.#deactivateColdForBranchMutation();
		if (!this.persist || !this.#sessionFile || !this.#storage.existsSync(this.#sessionFile)) return;
		const sessionFile = this.#sessionFile;
		const publishResumeBreadcrumb = this.#readOnlyResume;
		await this.#queuePersistTask(async () => {
			for (let attempt = 0; attempt <= 2; attempt++) {
				const token = this.#capturePersistenceInputToken();
				const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
				if (
					this.#needsFullRewriteOnNextPersist ||
					!this.#flushed ||
					(header?.version ?? 1) < CURRENT_SESSION_VERSION
				) {
					await this.#rewriteFileContents();
					if (publishResumeBreadcrumb) writeTerminalBreadcrumb(this.cwd, sessionFile);
					this.#readOnlyResume = false;
					return;
				}
				const persistedRecords = records.map(record =>
					record.type === "entry_patch"
						? (prepareEntryForPersistenceSync(
								materializeResidentEntryForPersistenceSync(
									record as unknown as FileEntry,
									this.#residentBlobStores(),
									new Map(),
								),
								this.#blobStore,
							) as unknown as SessionPatchRecord)
						: record,
				);
				SessionManagerTestHooks.beforePersistPatchFence?.(attempt);
				let persisted = false;
				const written = this.#withSessionPersistenceFenceSync(() => {
					if (!this.#persistenceInputTokenMatches(token)) return false;
					if (this.destination.kind === "managed") {
						this.#appendManagedRecordsSync(persistedRecords);
						persisted = true;
						return true;
					}
					const writer = this.#ensurePersistWriter();
					if (!writer) {
						void this.#rewriteFile()
							.then(() => {
								if (publishResumeBreadcrumb) writeTerminalBreadcrumb(this.cwd, sessionFile);
								this.#readOnlyResume = false;
							})
							.catch(() => {});
						return true;
					}
					for (const persistedRecord of persistedRecords) writer.writeSync(persistedRecord);
					persisted = true;
					return true;
				});
				if (written) {
					if (publishResumeBreadcrumb && persisted) writeTerminalBreadcrumb(this.cwd, sessionFile);
					if (persisted) this.#readOnlyResume = false;
					return;
				}
			}
			throw new Error("session_persistence_input_stale");
		});
	}
	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.#sessionFile) return;
		const publishResumeBreadcrumb = this.#readOnlyResume;
		if (this.#persistError) throw this.#persistError;

		// Normally we wait for the first assistant message before persisting to avoid
		// creating files for sessions that never produce output. Once ensureOnDisk() has
		// been called, the session is already on disk and every entry must be flushed.
		if (!this.#ensuredOnDisk) {
			const hasAssistant = this.#fileEntries.some(e => e.type === "message" && e.message.role === "assistant");
			if (!hasAssistant) {
				// Mark as not flushed so when assistant arrives, all entries get written.
				this.#flushed = false;

				this.#ensuredOnDisk = false;
				return;
			}
		}

		if (this.#needsFullRewriteOnNextPersist || !this.#flushed) {
			// Cold path: rewrite the whole file atomically. Async — the writer is
			// closed/reopened and every entry is re-prepared. Errors flow through
			// `#persistChain` → `#recordPersistError`; we swallow the rejection
			// here to avoid an unhandled rejection when the persist dir races with
			// test-level tempDir cleanup.
			try {
				this.#rewriteFileSync();
				if (publishResumeBreadcrumb) writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
				this.#readOnlyResume = false;
			} catch (err) {
				// Existing-destination rewrites are intentionally disabled in the retained
				// authority. A destination conflict is pre-mutation and recoverable; do not
				// turn it into a sticky committed-outcome error or authorize a pathname retry.
				if (err instanceof Error && err.message === "destination_conflict") throw err;
				this.#recordPersistError(err);
				throw this.#persistError ?? toError(err);
			}
			return;
		}

		// Hot path: synchronously truncate + append. `fs.writeSync` returns once the
		// bytes are in the kernel page cache, so the entry survives an OOM/SIGKILL
		// landing immediately after this call. Image externalization (rare) runs via
		// the synchronous blob-store path so blob bytes are durable before the JSONL
		// line referencing them is written.
		let persisted = false;
		try {
			this.#withSessionPersistenceFenceSync(() => {
				if (this.destination.kind === "managed") {
					const materializedEntry = materializeResidentEntryForPersistenceSync(
						entry,
						this.#residentBlobStores(),
						new Map(),
					);
					const persistedEntry = prepareEntryForPersistenceSync(materializedEntry, this.#blobStore);
					this.#appendManagedRecordsSync([persistedEntry]);
					persisted = true;
					return;
				}
				const writer = this.#ensurePersistWriter();
				if (!writer) {
					// The cached writer is closing. Preserve the appended in-memory entry for
					// a full rewrite after close drains instead of queueing a rewrite that the
					// concurrent close could release before it runs.
					this.#needsFullRewriteOnNextPersist = true;
					this.#flushed = false;
					return;
				}
				const materializedEntry = materializeResidentEntryForPersistenceSync(
					entry,
					this.#residentBlobStores(),
					new Map(),
				);
				const persistedEntry = prepareEntryForPersistenceSync(materializedEntry, this.#blobStore);
				writer.writeSync(persistedEntry);
				persisted = true;
			});
			if (publishResumeBreadcrumb && persisted) writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
			if (persisted) this.#readOnlyResume = false;
		} catch (err) {
			// content_too_large on the managed append hot path means the append-only
			// transcript file has reached the per-file storage limit (64 MiB). The
			// on-disk file is append-only and grew past the limit even though the
			// in-memory entry list may be much smaller (compaction evicts old
			// content but the append-only file never shrinks until a full rewrite).
			// Fall back to a full rewrite (replaceSync) which writes only the live
			// in-memory entries, shrinking the file below the limit. The entry has
			// already been added to #fileEntries by #appendEntryWithinPersistenceFence.
			if (err instanceof Error && err.message === "content_too_large") {
				// Typed near-limit contract (#4566): recover by rewriting only the
				// live in-memory entries, then verify the recovered file actually
				// holds the just-appended entry. When even the rewrite cannot fit
				// the entry (live content alone is at the cap), surface the typed
				// near-limit outcome instead of silently succeeding without the
				// receipt for an effect that already committed (e.g. a source edit).
				const entryBytes = (() => {
					try {
						const materialized = materializeResidentEntryForPersistenceSync(
							entry,
							this.#residentBlobStores(),
							new Map(),
						);
						return Buffer.byteLength(
							`${JSON.stringify(prepareEntryForPersistenceSync(materialized, this.#blobStore))}\n`,
							"utf8",
						);
					} catch {
						return 0;
					}
				})();
				const liveBytesBefore = this.getTranscriptFileBytes();
				try {
					this.#rewriteFileSync();
				} catch (rewriteError) {
					// The recovery rewrite itself failed. The appended entry stays in
					// the resident list (its effect, including any committed source
					// edit, is not lost), but the receipt is not durable yet: report
					// the typed near-limit outcome instead of an unclassified abort.
					if (rewriteError instanceof Error && rewriteError.message === "content_too_large") {
						this.#needsFullRewriteOnNextPersist = true;
						throw new SessionNearLimitAppendError({
							entryBytes,
							liveBytes: liveBytesBefore,
							capBytes: MANAGED_ARTIFACT_MAX_FILE_BYTES,
							entryRetained: this.#byId.has(entry.id),
						});
					}
					throw rewriteError;
				}
				if (publishResumeBreadcrumb) writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
				this.#readOnlyResume = false;
				// Post-rewrite verification: a rewrite that still cannot fit the
				// entry leaves an effect/receipt gap and must be reported, never
				// silently swallowed as a successful append.
				const liveBytesAfter = this.getTranscriptFileBytes();
				const entryRetained = liveBytesAfter <= MANAGED_ARTIFACT_MAX_FILE_BYTES && this.#byId.has(entry.id);
				if (!entryRetained) {
					this.#needsFullRewriteOnNextPersist = true;
					throw new SessionNearLimitAppendError({
						entryBytes,
						liveBytes: liveBytesAfter || liveBytesBefore,
						capBytes: MANAGED_ARTIFACT_MAX_FILE_BYTES,
						entryRetained: this.#byId.has(entry.id),
					});
				}
				return;
			}
			if (err instanceof ManagedCommittedMutationError) {
				// The durable mutation is authoritative only when its receipt carries a
				// descriptor-bound terminal successor. An identity-less committed outcome
				// cannot authorize a pathname retry: make it sticky before any later
				// resident mutation can proceed.
				this.#needsFullRewriteOnNextPersist = true;
				if (!isDescriptorBoundManagedIdentity(err.identity)) {
					this.#recordPersistError(err);
					throw this.#persistError ?? err;
				}
				throw err;
			}
			// A retained existing-destination rewrite is fail-closed before mutation.
			// Keep the conflict recoverable rather than recording it as a sticky
			// persistence failure or treating it as a committed rewrite.
			if (err instanceof Error && err.message === "destination_conflict") throw err;
			this.#recordPersistError(err);
			throw this.#persistError ?? toError(err);
		}
	}

	/**
	 * Defense-in-depth (#4443): detect directly adjacent thinking/redacted_thinking
	 * blocks in a persisted assistant transcript message. Non-mutating read-only
	 * diagnostic that fires at most once per session manager instance. Bounded to
	 * development/test builds only via an explicit environment gate so normal
	 * production never emits the diagnostic or transcript-path metadata.
	 *
	 * Only Anthropic-origin assistant messages are inspected: the adjacency class
	 * is specific to the Anthropic wire contract (#4416), and a provider-neutral
	 * check would false-positive on OpenAI Responses assemblies that emit one
	 * internal `thinking` block per reasoning output item.
	 *
	 * Names only the envelope shape (content block count), never raw thinking
	 * text, signatures, or redacted payloads.
	 */
	#warnAdjacentPrivateThinking(message: Parameters<typeof this.appendMessage>[0]): void {
		if (this.#warnedAdjacentThinkingPersist) return;
		// Explicit environment gate: production builds must not emit this
		// diagnostic or transcript-path metadata. `NODE_ENV` is the canonical
		// build-mode signal; the gate is robust to undefined (default: silent).
		if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") return;
		// Only assistant messages carry content block arrays with thinking blocks.
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
		// Restrict to Anthropic-origin: the adjacency rejection is specific to the
		// Anthropic replay wire contract. Other providers tolerate adjacent
		// reasoning blocks, so a provider-neutral check would be a false positive.
		if (message.api !== "anthropic-messages") return;
		if (!hasAdjacentPrivateThinkingBlocks(message.content)) return;
		this.#warnedAdjacentThinkingPersist = true;
		logger.warn("Session transcript: persisted assistant message has adjacent thinking blocks", {
			role: "assistant",
			provider: message.provider,
			contentBlockCount: message.content.length,
			hasAdjacentPrivateBlocks: true,
		});
	}

	#appendEntry(entry: SessionEntry): void {
		this.#withSessionPersistenceFenceSync(() => {
			// A committed managed mutation without a descriptor-bound terminal
			// successor is not retryable. Stop before touching resident state so a
			// later append cannot make the stale predecessor canonical by accident.
			if (this.#persistError) {
				throw new SessionAppendPersistenceError("prior_failure", entry.id, this.#persistError);
			}
			this.#appendEntryWithinPersistenceFence(entry);
		});
	}

	#appendEntryWithinPersistenceFence(entry: SessionEntry): void {
		this.#assertRecoveryHydrationWritable();
		if (this.#sidecarBranchActivationDirty) this.#deactivateColdForBranchMutation();
		const normalizedEntry = normalizeSessionEntryForStorage(entry);
		const residentEntry = this.#prepareEntryForCurrentResidentStore(normalizedEntry) as SessionEntry;
		let sidecarAppendCharge = 0;
		let sidecarTailCharge = 0;
		const activeRuntime = this.#sidecarRuntime;
		let transcriptDurableForSidecar = this.destination.kind === "managed";
		let transcriptDescriptor: SessionStorageStat | undefined;
		if (activeRuntime && this.#coldSidecarActive()) {
			const appendedBytes = this.#serializeEntryLine(residentEntry).byteLength + 1;
			const appendedAccountedBytes = residentHotEntryBytes(appendedBytes);
			const tailBytes = tailRecordResidentBytes({
				seq: 0,
				kind: tailRecordKindForEntry(residentEntry),
				ordinal: 0,
				id: residentEntry.id,
				parentId: residentEntry.parentId,
				type: residentEntry.type,
				byteOffset: 0,
				byteLength: appendedBytes,
				recordDigest: "0".repeat(64),
			});
			if (activeRuntime.hotSuffixBytes + appendedBytes > this.#sidecarHotSuffixBudgetBytes) {
				activeRuntime.hotOverflowTransitions++;
				this.#deactivateColdForBranchMutation();
			} else if (!activeRuntime.accountant.tryCharge(appendedAccountedBytes)) {
				this.#deactivateColdForBranchMutation();
			} else if (!activeRuntime.tailCache.tryAllocate(tailBytes)) {
				activeRuntime.accountant.release(appendedAccountedBytes);
				this.#deactivateColdForBranchMutation();
			} else {
				sidecarAppendCharge = appendedAccountedBytes;
				sidecarTailCharge = tailBytes;
			}
		}
		const previousLeafId = this.#leafId;
		const priorPersistenceError = this.#persistError;
		this.#fileEntries.push(residentEntry);
		this.#byId.set(residentEntry.id, residentEntry);
		this.#leafId = residentEntry.id;
		this.#bumpEntryRevision();
		this.#leafRevision++;
		if (entry.type === "label") this.#labelRevision++;
		try {
			this._persist(residentEntry);
		} catch (error) {
			if (error instanceof ManagedCommittedMutationError) {
				if (sidecarAppendCharge > 0) activeRuntime?.accountant.release(sidecarAppendCharge);
				if (sidecarTailCharge > 0) activeRuntime?.tailCache.release(sidecarTailCharge);
				this.#needsFullRewriteOnNextPersist = true;
				throw new SessionAppendPersistenceError("current_append", residentEntry.id, this.#persistError ?? error);
			}
			// Typed near-limit recovery (#4566) already ran its deterministic
			// rewrite inside _persist and deliberately kept the entry resident so
			// the committed effect keeps its receipt. Do not roll it back or wrap
			// it into a generic SessionAppendPersistenceError: propagate the typed
			// outcome with its structured fields intact.
			if (error instanceof SessionNearLimitAppendError) {
				if (sidecarAppendCharge > 0) activeRuntime?.accountant.release(sidecarAppendCharge);
				if (sidecarTailCharge > 0) activeRuntime?.tailCache.release(sidecarTailCharge);
				throw error;
			}
			const removed = this.#fileEntries.pop();
			if (removed !== residentEntry)
				throw new Error("Session append rollback lost resident ordering.", { cause: error });
			this.#byId.delete(residentEntry.id);
			this.#leafId = previousLeafId;
			this.#bumpEntryRevision();
			this.#leafRevision++;
			if (entry.type === "label") this.#labelRevision++;
			if (sidecarAppendCharge > 0) activeRuntime?.accountant.release(sidecarAppendCharge);
			if (sidecarTailCharge > 0) activeRuntime?.tailCache.release(sidecarTailCharge);
			throw new SessionAppendPersistenceError(
				priorPersistenceError ? "prior_failure" : "current_append",
				residentEntry.id,
				this.#persistError ?? toError(error),
			);
		}
		const activateColdAfterAppend =
			!this.#coldSidecarActive() &&
			this.#sessionMemoryMode === "auto" &&
			this.#effectiveSessionMemoryMode() === "enabled";
		if (
			this.destination.kind !== "managed" &&
			(sidecarAppendCharge > 0 ||
				activateColdAfterAppend ||
				(residentEntry.type === "compaction" && this.#effectiveSessionMemoryMode() === "enabled"))
		) {
			const writer = this.#persistWriter;
			if (writer?.isOpen()) {
				try {
					writer.fsyncSync();
					transcriptDurableForSidecar = true;
					transcriptDescriptor = writer.statSync();
				} catch {
					if (this.#coldSidecarActive()) this.#deactivateColdForBranchMutation();
				}
			} else if (this.#coldSidecarActive()) {
				this.#deactivateColdForBranchMutation();
			}
		}

		// Aggregate usage before the sidecar append publishes its commit marker so an
		// exact reopen observes the same totals as the live manager.
		if (this.#accumulateEntryUsage(entry)) {
			logger.warn("Skipped malformed or overflowing usage on appended entry", {
				sessionFile: this.#sessionFile,
				entryId: entry.id,
			});
		}
		if (residentEntry.type === "label" && activeRuntime?.enabled) {
			if (residentEntry.label) {
				if (!activeRuntime.labelsPins.setLabel(residentEntry.targetId, residentEntry.label))
					this.#deactivateColdForBranchMutation();
			} else {
				activeRuntime.labelsPins.deleteLabel(residentEntry.targetId);
			}
		}
		if (transcriptDurableForSidecar && sidecarAppendCharge > 0 && activeRuntime && this.#coldSidecarActive()) {
			const materialized = materializeResidentEntryForPersistenceSync(
				residentEntry,
				this.#residentBlobStores(),
				new Map(),
			);
			const persisted = prepareEntryForPersistenceSync(materialized, this.#blobStore);
			const persistedLine = Buffer.from(`${JSON.stringify(persisted)}\n`, "utf8");
			const persistedAccountedBytes = residentHotEntryBytes(persistedLine.byteLength);
			const delta = persistedAccountedBytes - sidecarAppendCharge;
			if (
				delta > 0 &&
				(activeRuntime.hotSuffixBytes + persistedLine.byteLength > this.#sidecarHotSuffixBudgetBytes ||
					!activeRuntime.accountant.tryCharge(delta))
			) {
				this.#deactivateColdForBranchMutation();
			} else {
				if (delta < 0) activeRuntime.accountant.release(-delta);
				const ordinal = this.#nextColdOrdinal();
				if (!this.#applySidecarReducerDelta(residentEntry, ordinal)) {
					this.#ensureFullHotView();
					activeRuntime.coldMutationPromotions++;
				} else if (this.#appendColdSidecarRecord(residentEntry, persistedLine, transcriptDescriptor, ordinal)) {
					activeRuntime.hotSuffixBytes += persistedLine.byteLength;
				}
			}
		}
		if (
			activateColdAfterAppend &&
			transcriptDurableForSidecar &&
			this.#sessionFile &&
			this.#storage.existsSync(this.#sessionFile)
		) {
			this.#buildDisposableSidecars(this.#fileEntries);
			if (this.#coldSidecarActive()) this.#retireColdEntries();
		}
		if (
			entry.type === "compaction" &&
			transcriptDurableForSidecar &&
			this.#effectiveSessionMemoryMode() === "enabled" &&
			this.#sessionFile &&
			this.#storage.existsSync(this.#sessionFile)
		) {
			if (this.#coldSidecarActive() && this.#sidecarRuntime) {
				if (!this.#advanceColdTailBoundary(entry.firstKeptEntryId)) {
					this.#deactivateColdForBranchMutation();
				} else {
					this.#sidecarRuntime.retirementFirstKeptEntryId = entry.firstKeptEntryId;
					this.#retireColdEntries();
					this.#publishCommitMarkerFromCurrentTranscriptSync();
					this.#sidecarRuntime.terminalTransition = this.#classifySidecarReopen();
				}
			} else {
				this.#ensureFullHotView();
				this.#buildDisposableSidecars(this.#fileEntries);
				this.#retireColdEntries();
			}
		}
	}

	/** Append a configured fallback chain as child of current leaf, then advance leaf. Returns entry id. */
	appendConfiguredModelChain(chain: ConfiguredModelChain): string {
		const entry: ConfiguredModelChainEntry = {
			type: "configured_model_chain",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			role: chain.role,
			entries: [...chain.entries],
			origin: chain.origin,
			identity: chain.identity,
			explicitHead: chain.explicitHead,
			cleared: chain.cleared,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		associateSessionMessageEntryId(message, entry.id);
		// Defense-in-depth (#4443): detect directly adjacent thinking/redacted_thinking
		// blocks in a persisted assistant transcript message and warn once per session.
		// This is a read-only observation — storage is NEVER mutated. The diagnostic is
		// bounded to development/test to avoid production noise, and names only the
		// envelope shape (block count), never raw thinking text, signatures, or payloads.
		this.#warnAdjacentPrivateThinking(message);
		this.#appendEntry(entry);
		const residentEntry = this.#byId.get(entry.id);
		if (residentEntry?.type === "message") transferSessionMessageIdentity([message], [residentEntry.message]);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, operatorIntent = false): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel: thinkingLevel ?? null,
			operatorIntent: operatorIntent || undefined,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTier | null): string {
		const entry: ServiceTierChangeEntry = {
			type: "service_tier_change",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			serviceTier,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append a mode change as child of current leaf, then advance leaf. Returns entry id. */
	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = {
			type: "mode_change",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			mode,
			data,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as child of current leaf, then advance leaf. Returns entry id.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 */
	appendModelChange(
		model: string,
		role?: string,
		metadata?: { previousModel?: string; reason?: string; thinkingLevel?: string | null },
	): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			model,
			role,
			previousModel: metadata?.previousModel,
			reason: metadata?.reason,
			thinkingLevel: metadata?.thinkingLevel,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append an explicit role-model clear marker, preserving absence during replay. */
	clearModelRole(role: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			model: "",
			role,
			cleared: true,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append session init metadata (for subagent debugging/replay). Returns entry id. */
	appendSessionInit(init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		outputSchema?: unknown;
		forkContext?: unknown;
	}): string {
		const entry: SessionInitEntry = {
			type: "session_init",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			...init,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromExtension?: boolean,
		preserveData?: Record<string, unknown>,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromExtension,
			preserveData,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a root marker that starts a fresh active branch without changing the
	 * session id or deleting earlier durable entries. Subsequent messages descend
	 * from this marker, so provider context is clear while history remains
	 * available for diagnostics/export.
	 */
	appendContextClearEntry(data?: Record<string, unknown>): string {
		const entry: CustomEntry = {
			type: "custom",
			customType: "context_clear",
			data,
			id: this.#generateEntryId(),
			parentId: null,
			timestamp: new Date().toISOString(),
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/**
	 * Write mutated message entries back into the canonical entry store by id.
	 *
	 * `getBranch()` materializes resident-blob entries into copies, so in-place
	 * mutation of returned entries (e.g. pruning tool outputs) does not affect
	 * the canonical store. This applies such mutations for real.
	 */
	applyEntryMessageUpdates(entries: readonly SessionMessageEntry[]): void {
		this.#assertResidentMutationWritable();
		this.#deactivateColdForBranchMutation();
		for (const updated of entries) {
			const canonical = this.#byId.get(updated.id);
			if (canonical?.type !== "message") continue;
			const residentEntry = this.#prepareEntryForCurrentResidentStore({
				...canonical,
				message: updated.message,
			}) as SessionMessageEntry;
			canonical.message = residentEntry.message;
		}
		this.#needsFullRewriteOnNextPersist = true;
		this.#bumpEntryRevision();
		this.#replayMetadataRevision++;
	}

	/** Write mutated custom-message entries back into the canonical entry store by id. */
	applyCustomMessageEntryUpdates(
		entries: readonly CustomMessageEntry[],
		options: { preserveEvictedContent?: boolean } = {},
	): void {
		this.#assertResidentMutationWritable();
		this.#deactivateColdForBranchMutation();
		for (const updated of entries) {
			const canonical = this.#byId.get(updated.id);
			if (canonical?.type !== "custom_message") continue;
			canonical.content = updated.content;
			canonical.details = updated.details;
			if (options.preserveEvictedContent) canonical.evictedContent = updated.evictedContent;
			else {
				// Pruning replaces content permanently; retaining a cold-spill marker would
				// rehydrate the superseded payload on the next materialization.
				canonical.evictedContent = undefined;
			}
		}
		this.#needsFullRewriteOnNextPersist = true;
		this.#bumpEntryRevision();
		this.#replayMetadataRevision++;
	}

	/**
	 * Rehydrate the canonical transcript after a synchronous persistence failure.
	 *
	 * The failed append may have committed before reporting an uncertain outcome,
	 * so callers must not clear the sticky error or retry against the resident
	 * branch. Reloading the exact session file is the only supported recovery
	 * boundary for both managed and explicit persistent destinations.
	 */
	async recoverPersistenceFailure(): Promise<void> {
		const persistenceError = this.#persistError;
		if (!persistenceError) return;
		if (!this.#sessionFile) throw persistenceError;
		const sessionFile = this.#sessionFile;
		try {
			await this.#closePersistWriter();
		} catch {
			// A writer reports its prior write failure after a confirmed close. A
			// second close clears that terminal writer; retryable close failures are
			// genuinely re-dispatched and still fail if the descriptor cannot settle.
		}
		await this.#closePersistWriter();
		const inspected = inspectResumeSessionFile(sessionFile, this.#storage);
		if ("kind" in inspected) throw persistenceError;
		try {
			fsyncResumeSessionIdentity(inspected.identity);
		} catch {
			throw persistenceError;
		}
		const durable = inspectResumeSessionFile(sessionFile, this.#storage);
		if ("kind" in durable || !sameResumeIdentity(inspected.identity, durable.identity)) {
			throw persistenceError;
		}
		const adoption = {
			canonicalPath: durable.identity.canonicalPath,
			identity: durable.identity,
			inspection: durable,
		};
		this.#pendingStrictAdoption = adoption;
		try {
			await this.setSessionFile(durable.identity.canonicalPath);
		} finally {
			if (this.#pendingStrictAdoption === adoption) this.#pendingStrictAdoption = undefined;
		}
	}
	/**
	 * Rewrite the session file after in-place entry updates.
	 * Use sparingly (e.g., pruning old tool outputs).
	 */
	async rewriteEntries(): Promise<void> {
		this.#assertRecoveryHydrationWritable();
		if (!this.persist || !this.#sessionFile) return;
		await this.#rewriteFile();
		if (this.#readOnlyResume) {
			writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
			this.#readOnlyResume = false;
		}
	}

	/** Remap artifact references in an unpublished candidate before its publication fence. */
	async remapStagedArtifactReferences(idMap: ReadonlyMap<string, string>): Promise<void> {
		const staged = this.#stagedPublication;
		if (!staged || staged.committed || staged.discarded) throw new Error("Staged session is unavailable");
		remapAttemptReferencesInEntries(this.#fileEntries, idMap);
		this.#needsFullRewriteOnNextPersist = true;
		await this.#rewriteFileContents();
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		attribution: MessageAttribution = "agent",
		observationId?: string,
	): string {
		const entryId = this.#generateEntryId();
		const stableObservationId =
			observationId ?? (customType.startsWith("irc:") ? `session:${this.#sessionId}:entry:${entryId}` : undefined);
		const persistedDetails =
			stableObservationId && details && typeof details === "object" && !Array.isArray(details)
				? ({ ...details, observationId: stableObservationId } as T)
				: details;
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			// Drop AgentSession-internal transient fields (allowlist in
			// `INTERNAL_DETAILS_FIELDS`) before disk persistence. Single
			// chokepoint covers every CustomMessage write path.
			details: stripInternalDetailsFields(persistedDetails),
			attribution,
			id: entryId,
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// TTSR (Time Traveling Stream Rules)
	// =========================================================================

	/** Append MCP discovery selection authority without altering discovered built-in authority. */
	appendMCPToolSelection(selectedToolNames: string[], mutationCorrelationId?: string): string {
		const entry: MCPToolSelectionEntry = {
			type: "mcp_tool_selection",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			selectedToolNames: [...selectedToolNames],
			mutationCorrelationId,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/** Append discovered built-in selection authority without altering MCP authority. */
	appendDiscoveredBuiltinToolSelection(selectedToolNames: string[], mutationCorrelationId?: string): string {
		const entry: DiscoveredBuiltinToolSelectionEntry = {
			type: "discovered_builtin_tool_selection",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			selectedToolNames: [...selectedToolNames],
			mutationCorrelationId,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a TTSR injection entry recording which rules were injected.
	 * @param ruleNames Names of rules that were injected
	 * @returns Entry id
	 */
	appendTtsrInjection(ruleNames: string[], records?: TtsrInjectionRecord[], ttsrMessageCount?: number): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			injectedRules: ruleNames,
			injectedRuleRecords: records,
			ttsrMessageCount,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/**
	 * Get all unique TTSR rule names that have been injected in the current branch.
	 * Scans from root to current leaf for ttsr_injection entries.
	 */
	getInjectedTtsrRules(): string[] {
		const path = this.getBranch();
		const ruleNames = new Set<string>();
		for (const entry of path) {
			if (entry.type === "ttsr_injection") {
				for (const name of entry.injectedRules) {
					ruleNames.add(name);
				}
			}
		}
		return Array.from(ruleNames);
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.#leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		if (!this.#leafId) return undefined;
		const entry = this.#resolveEntry(this.#leafId);
		return entry
			? cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), new Map()))
			: undefined;
	}

	getResidentImageBytes(): number {
		const refs = new Set<string>();
		for (const entry of this.#fileEntries) collectResidentImageRefs(entry, refs);
		let bytes = 0;
		for (const ref of refs) {
			const hash = parseBlobRef(ref);
			if (!hash) continue;
			try {
				bytes += fs.statSync(path.join(this.#residentImageBlobStore.dir, hash)).size;
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}
		return bytes;
	}

	/**
	 * Get the most recent model role from the current session path.
	 * Returns undefined if no model change has been recorded.
	 *
	 * R1: keyed ONLY on the nearest `model_change` on the leaf→root path — never on
	 * `hasExplicitDefaultModel`, which gates only legacy assistant inference into
	 * `models.default` inside `buildSessionContext`. Six parity cases (D1): reviewer-
	 * only → "reviewer"; temporary-only → "temporary"; interleaved → nearest;
	 * no model_change → undefined; legacy-only inference → undefined; explicit
	 * default then legacy inference → "default".
	 */
	getLastModelChangeRole(): string | undefined {
		// R1: when a cold sidecar region is active, consult the reducer's nearest
		// model-change delta (bounded, latest-wins) instead of a full parent walk.
		if (this.#coldSidecarActive() && this.#sidecarRuntime) {
			return getReducerLastModelChangeRole(this.#sidecarRuntime.reducer);
		}
		const visited = new Set<string>();
		let current = this.getLeafEntry();
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			if (current.type === "model_change") {
				return current.role ?? "default";
			}
			current = current.parentId ? this.#resolveEntry(current.parentId) : undefined;
		}
		return undefined;
	}

	evictCompactedContent(firstKeptEntryId: string, compactionEntryId: string): EvictCompactedContentResult {
		this.#assertResidentMutationWritable();
		if (this.#coldSidecarActive()) this.#deactivateColdForBranchMutation();
		const firstKept = this.#byId.get(firstKeptEntryId);
		const compaction = this.#byId.get(compactionEntryId);
		if (!firstKept) throw new Error(`Entry ${firstKeptEntryId} not found`);
		if (compaction?.type !== "compaction") throw new Error(`Compaction entry ${compactionEntryId} not found`);
		const ids: string[] = [];
		const visited = new Set<string>();
		let current: SessionEntry | undefined = compaction;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			ids.push(current.id);
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
		}
		ids.reverse();
		let evictedEntries = 0;
		let hotCharsRemoved = 0;
		let coldBlobBytes = 0;
		let payloadRefs = 0;
		let alreadyEvictedEntries = 0;
		let mutated = false;
		try {
			for (const id of ids) {
				if (id === firstKeptEntryId) break;
				const entry = this.#byId.get(id);
				if (!entry || entry.type === "compaction") continue;
				if (entry.type !== "message" && entry.type !== "custom_message") continue;
				if (entry.evictedContent?.reason === "compacted_history") {
					alreadyEvictedEntries++;
					continue;
				}
				const beforeChars = JSON.stringify(entry).length;
				const writes: ColdSpillWrite[] = [];
				const nextEntry = this.#coldSpillClone(entry, writes);
				if (writes.length === 0 || nextEntry === entry) continue;
				const payloads: Record<string, ColdSpillRef> = {};
				for (const write of writes) {
					const put = this.#blobStore.putImmutableSync(write.data);
					this.#coldSpillWriteCount++;
					payloads[write.path] = {
						kind: "cold_spill",
						ref: put.ref,
						encoding: write.encoding,
						originalChars: write.originalChars,
						sha256: put.hash,
						bytes: put.bytes,
					};
					coldBlobBytes += put.bytes;
				}
				const marker: EvictedContentMarker = {
					evictedAt: Date.now(),
					reason: "compacted_history",
					compactionEntryId,
					firstKeptEntryId,
					payloads,
				};
				// Store the marker at the ENTRY level (session metadata), not on the
				// strict message type, so message shapes stay type-clean.
				if (nextEntry.type === "message" || nextEntry.type === "custom_message") {
					nextEntry.evictedContent = marker;
				}
				this.#replaceCanonicalEntry(nextEntry);
				mutated = true;
				evictedEntries++;
				payloadRefs += writes.length;
				hotCharsRemoved += Math.max(0, beforeChars - JSON.stringify(nextEntry).length);
			}
		} finally {
			if (mutated) {
				this.#needsFullRewriteOnNextPersist = true;
				this.#bumpEntryRevision();
				this.#replayMetadataRevision++;
				this.#materializedEntriesCache = undefined;
				this.#materializedEntriesRevision = -1;
				this.#sessionContextCache = undefined;
			}
		}
		return {
			evictedEntries,
			hotCharsRemoved,
			coldBlobBytes,
			payloadRefs,
			alreadyEvictedEntries,
			coldSpillWriteCount: this.#coldSpillWriteCount,
			coldSpillReadCount: this.#coldSpillReadCount,
			residentTextReadCount: this.#residentTextReadCount,
			residentImageReadCount: this.#residentImageReadCount,
		};
	}

	#coldSpillClone(entry: SessionEntry, writes: ColdSpillWrite[]): SessionEntry {
		if (entry.type === "message") {
			const content = "content" in entry.message ? entry.message.content : undefined;
			if (!Array.isArray(content)) return entry;
			const nextContent = coldSpillContentBlocks(content, "message.content", writes, {
				stores: this.#residentBlobStoresForColdRehydrate(),
			});
			return nextContent === content
				? entry
				: { ...entry, message: { ...entry.message, content: nextContent } as AgentMessage };
		}
		if (entry.type === "custom_message") {
			const content = coldSpillCustomMessageContent(entry.content, writes, {
				stores: this.#residentBlobStoresForColdRehydrate(),
			});
			return content === entry.content ? entry : { ...entry, content };
		}
		return entry;
	}

	#replaceCanonicalEntry(entry: SessionEntry): void {
		this.#byId.set(entry.id, entry);
		const index = this.#fileEntries.findIndex(candidate => candidate.type !== "session" && candidate.id === entry.id);
		if (index >= 0) this.#fileEntries[index] = entry;
	}

	getObservabilityStatsForTests(): SessionManagerObservabilityStats {
		return {
			coldSpillWriteCount: this.#coldSpillWriteCount,
			coldSpillReadCount: this.#coldSpillReadCount,
			residentTextReadCount: this.#residentTextReadCount,
			residentImageReadCount: this.#residentImageReadCount,
			residentCacheAdoptFallbackCount: this.#residentCacheAdoptFallbackCount,
			residentCacheTrustRejectCount: this.#residentCacheTrustRejectCount,
			residentCacheWin32FallbackCount: this.#residentCacheWin32FallbackCount,
			residentCacheDegradedReason: (this.#residentTextBlobStore as ResidentCacheDegradedStore).degradedReason,
			residentCacheDegradedCauseCode: (this.#residentTextBlobStore as ResidentCacheDegradedStore).degradedCauseCode,
			residentBlobPlaceholderCount: this.#residentBlobPlaceholderCount,
			publicMaterializerCallCount: this.#publicMaterializerCallCount,
			getEntryMaterializerCallCount: this.#getEntryMaterializerCallCount,
			getBranchMaterializerCallCount: this.#getBranchMaterializerCallCount,
			getEntriesMaterializerCallCount: this.#getEntriesMaterializerCallCount,
			materializedEntriesCachePopulateCount: this.#materializedEntriesCachePopulateCount,
			materializedCacheDemotedCount: this.#materializedCacheDemotedCount,
			pathOnlyContextBuildCount: this.#pathOnlyContextBuildCount,
		};
	}

	/**
	 * Directory backing the resident *text* blob store, or undefined when the
	 * store is in-memory. The resident-cache root also holds the managed sidecar
	 * cache instance, so callers must not infer the text store from directory
	 * counts.
	 */
	residentTextCacheDirForTests(): string | undefined {
		return this.#residentTextBlobStore instanceof EphemeralBlobStore ? this.#residentTextBlobStore.dir : undefined;
	}

	setSidecarHotSuffixBudgetForTests(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_sidecar_hot_suffix_budget");
		this.#sidecarHotSuffixBudgetBytes = bytes;
	}
	parentChildrenCacheKeysForTests(): string[] {
		return [...(this.#sidecarRuntime?.parentChildrenCache.keys() ?? [])];
	}
	parentArtifactEnabledForTests(): boolean {
		return this.#sidecarRuntime?.parentArtifact !== undefined;
	}
	setParentArtifactBudgetForTests(bytes: number): void {
		const artifact = this.#sidecarRuntime?.parentArtifact;
		if (!artifact) throw new Error("parent_artifact_unavailable");
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_parent_artifact_budget");
		artifact.budgetBytes = bytes;
	}
	hotRetainedMessageCharsForTests(): number {
		let total = 0;
		for (const entry of this.#fileEntries) {
			if (entry.type !== "message" && entry.type !== "custom_message") continue;
			total += JSON.stringify(entry).length;
		}
		return total;
	}

	getCanonicalEntryForTests(id: string): SessionEntry | undefined {
		const entry = this.#resolveEntry(id);
		return entry ? cloneSessionEntry(entry) : undefined;
	}

	getEntryForFidelity(id: string): SessionEntry | undefined {
		const entry = this.#resolveEntry(id);
		return entry
			? cloneSessionEntry(
					rehydrateColdSpillEntry(
						materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), new Map()),
						this.#coldSpillReadStore(),
						this.#residentBlobStoresForColdRehydrate(),
					),
				)
			: undefined;
	}

	getBranchForFidelity(fromId?: string): SessionEntry[] {
		const cache = new Map<string, string>();
		const path: SessionEntry[] = [];
		const visited = new Set<string>();
		let current = (fromId ?? this.#leafId) ? this.#resolveEntry(fromId ?? this.#leafId ?? "") : undefined;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			path.push(
				cloneSessionEntry(
					rehydrateColdSpillEntry(
						materializeResidentEntryForReadSync(current, this.#residentBlobStores(), cache),
						this.#coldSpillReadStore(),
						this.#residentBlobStoresForColdRehydrate(),
					),
				),
			);
			current = current.parentId ? this.#resolveEntry(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	#getCanonicalBranchClones(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const visited = new Set<string>();
		let current = (fromId ?? this.#leafId) ? this.#resolveEntry(fromId ?? this.#leafId ?? "") : undefined;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			path.push(cloneSessionEntry(current));
			current = current.parentId ? this.#resolveEntry(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * Walk the active branch without materializing resident blobs or rehydrating
	 * cold-spill payloads. Intended for metadata-only scans such as todo-phase
	 * sync; callers must not mutate returned entries.
	 */
	getActivePathEntriesCanonical(fromId?: string): SessionEntry[] {
		return this.#getCanonicalBranchClones(fromId);
	}

	visitEntriesForExport(visitor: (entry: SessionEntry) => void): void {
		if (this.#coldSidecarActive() && this.#sessionFile) {
			const size = this.#statSync(this.#sessionFile).size;
			const failure = scanTranscriptLinesBounded(
				this.#boundedReadStorage(),
				this.#sessionFile,
				size,
				(_offset, lineBytes) => {
					try {
						const record = JSON.parse(decodeBoundedJsonLine(lineBytes)) as FileEntry | SessionPatchRecord;
						if (record.type === "session") return;
						if (record.type === "header_patch" || record.type === "entry_patch") return false;
						if (typeof record.id !== "string") return false;
						const coldEntry = sanitizeLoadedSessionEntryReplayMetadata(record);
						residentizePersistedBlobRefs(coldEntry);
						const entry = materializeResidentEntryForReadSync(coldEntry, this.#residentBlobStores(), new Map());
						visitor(
							cloneSessionEntry(
								rehydrateColdSpillEntry(
									entry,
									this.#coldSpillReadStore(),
									this.#residentBlobStoresForColdRehydrate(),
								),
							),
						);
					} catch {
						return false;
					}
				},
			);
			if (failure) throw new Error(`export_transcript_scan_failed:${failure}`);
			return;
		}
		const cache = new Map<string, string>();
		for (const entry of this.#fileEntries) {
			if (entry.type === "session") continue;
			visitor(
				cloneSessionEntry(
					rehydrateColdSpillEntry(
						materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), cache),
						this.#coldSpillReadStore(),
						this.#residentBlobStoresForColdRehydrate(),
					),
				),
			);
		}
	}
	getEntriesForExport(): SessionEntry[] {
		this.#ensureFullHotView();
		const cache = new Map<string, string>();
		return this.#fileEntries
			.filter((entry): entry is SessionEntry => entry.type !== "session")
			.map(entry =>
				cloneSessionEntry(
					rehydrateColdSpillEntry(
						materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), cache),
						this.#coldSpillReadStore(),
						this.#residentBlobStoresForColdRehydrate(),
					),
				),
			);
	}

	getEntry(id: string): SessionEntry | undefined {
		this.#publicMaterializerCallCount++;
		this.#getEntryMaterializerCallCount++;
		const entry = this.#resolveEntry(id);
		return entry
			? cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), new Map()))
			: undefined;
	}

	#readColdChildren(parentId: string): SessionEntry[] | undefined {
		const runtime = this.#sidecarRuntime;
		if (!runtime?.enabled || !runtime.indexPath || typeof this.#storage.readRangeSync !== "function")
			return undefined;
		let indexStat: SessionStorageStat;
		try {
			indexStat = this.#storage.statSync(runtime.indexPath);
		} catch {
			return undefined;
		}
		const size = indexStat.size;
		const cached = runtime.parentChildrenCache.get(parentId);
		if (
			cached &&
			runtime.validatedIndexDescriptor &&
			sameDescriptor(cached.descriptor, indexStat) &&
			sameDescriptor(runtime.validatedIndexDescriptor, indexStat) &&
			(cached.bucketDescriptor === undefined ||
				this.#parentBucketDescriptorMatches(cached.bucketDescriptor, cached.bucketIndex))
		) {
			const cache = new Map<string, string>();
			const children: SessionEntry[] = [];
			for (const id of cached.ids) {
				const entry = this.#resolveEntry(id);
				if (!entry || entry.parentId !== parentId) return undefined;
				children.push(
					cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), cache)),
				);
			}
			return children;
		}
		if (cached) {
			runtime.parentChildrenCache.delete(parentId);
			runtime.blockCache.release(cached.bytes);
		}
		// Persistent artifact fast path: one bounded bucket read, never a complete
		// `.spill.idx` digest+scan. The artifact is disposable derived proof bound
		// to the exact index digest; any miss falls through to the authoritative
		// cold scan below.
		if (
			runtime.parentArtifact &&
			runtime.parentArtifact.indexDigest === runtime.indexDigest &&
			runtime.validatedIndexDescriptor &&
			sameDescriptor(runtime.validatedIndexDescriptor, indexStat)
		) {
			const artifactChildren = this.#readParentChildrenFromArtifact(parentId, indexStat);
			if (artifactChildren) return artifactChildren;
		}
		if (!this.#coldIndexDigestValid()) return undefined;
		const childIds: string[] = [];
		let malformed = false;
		const neighboringParents = new BoundedParentChildrenIndex();
		let collectNeighboringParents = false;
		const neighboringIndexes = new Map<string, { index: ColdEntryIndex; bytes: number }>();
		let neighboringParentsComplete = true;
		const failure = scanTranscriptLinesBounded(this.#storage, runtime.indexPath, size, (_offset, lineBytes) => {
			try {
				const value = JSON.parse(decodeBoundedJsonLine(lineBytes)) as {
					id?: unknown;
					parentId?: unknown;
					ordinal?: unknown;
					seq?: unknown;
					byteOffset?: unknown;
					byteLength?: unknown;
					recordDigest?: unknown;
					entryType?: unknown;
				};
				if (typeof value.id !== "string" || (value.parentId !== null && typeof value.parentId !== "string")) {
					malformed = true;
					return false;
				}
				if (value.parentId === parentId) {
					collectNeighboringParents = true;
					if (childIds.length >= PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT) return false;
					childIds.push(value.id);
				} else if (collectNeighboringParents && value.parentId !== null) {
					if (!neighboringParents.add(value.parentId, value.id)) {
						neighboringParentsComplete = false;
						collectNeighboringParents = false;
					}
					if (
						typeof value.ordinal === "number" &&
						typeof value.seq === "number" &&
						typeof value.byteOffset === "number" &&
						typeof value.byteLength === "number" &&
						typeof value.recordDigest === "string"
					) {
						neighboringIndexes.set(value.id, {
							index: {
								ordinal: value.ordinal,
								seq: value.seq,
								byteOffset: value.byteOffset,
								byteLength: value.byteLength,
								recordDigest: value.recordDigest,
								parentId: value.parentId,
								...(typeof value.entryType === "string" ? { entryType: value.entryType } : {}),
							},
							bytes: lineBytes.byteLength * 2 + 48,
						});
					}
				}
			} catch {
				malformed = true;
				return false;
			}
		});
		if (failure || malformed) return undefined;
		const cache = new Map<string, string>();
		const children: SessionEntry[] = [];
		for (const id of childIds) {
			const entry = this.#resolveEntry(id);
			if (!entry || entry.parentId !== parentId) return undefined;
			children.push(
				cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), cache)),
			);
		}
		const cacheBytes =
			residentStringBytes(parentId) + 48 + childIds.reduce((total, id) => total + residentStringBytes(id) + 8, 0);
		if (runtime.blockCache.tryAllocate(cacheBytes)) {
			runtime.parentChildrenCache.set(parentId, { ids: [...childIds], bytes: cacheBytes, descriptor: indexStat });
		}
		if (neighboringParentsComplete)
			for (const neighbor of neighboringParents.entries()) {
				if (runtime.parentChildrenCache.has(neighbor.parentId)) continue;
				const neighborBytes =
					residentStringBytes(neighbor.parentId) +
					48 +
					neighbor.children.reduce((total, id) => total + residentStringBytes(id) + 8, 0);
				for (const childId of neighbor.children) {
					const childIndex = neighboringIndexes.get(childId);
					if (childIndex && !runtime.coldEntries.has(childId) && runtime.blockCache.tryAllocate(childIndex.bytes))
						runtime.coldEntries.set(childId, childIndex.index);
				}
				if (!runtime.blockCache.tryAllocate(neighborBytes)) break;
				runtime.parentChildrenCache.set(neighbor.parentId, {
					ids: neighbor.children,
					bytes: neighborBytes,
					descriptor: indexStat,
				});
			}
		return children;
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		if (this.#coldSidecarActive()) {
			const coldChildren = this.#readColdChildren(parentId);
			if (coldChildren) return coldChildren;
		}
		const cache = new Map<string, string>();
		this.#ensureFullHotView();
		const children: SessionEntry[] = [];
		for (const entry of this.#byId.values()) {
			if (entry.parentId === parentId) {
				children.push(
					cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), cache)),
				);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.#resolveLabelForRead(id);
	}

	/** Resolve a label from the resident map or the cold labels/pins store (live counter). */
	#resolveLabelForRead(id: string): string | undefined {
		const hot = this.#labelsById.get(id);
		if (hot !== undefined) return hot;
		const runtime = this.#sidecarRuntime;
		if (!runtime) return undefined;
		runtime.labelDiskFallbackCount++;
		return runtime.labelsPins.getLabel(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#resolveEntry(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: this.#generateEntryId(),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this.#appendEntry(entry);
		if (label) {
			this.#labelsById.set(targetId, label);
		} else {
			this.#labelsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		this.#publicMaterializerCallCount++;
		this.#getBranchMaterializerCallCount++;
		const cache = new Map<string, string>();
		const path: SessionEntry[] = [];
		const visited = new Set<string>();
		const startId = fromId ?? this.#leafId;
		let current = startId ? this.#resolveEntry(startId) : undefined;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			path.push(cloneSessionEntry(materializeResidentEntryForReadSync(current, this.#residentBlobStores(), cache)));
			current = current.parentId ? this.#resolveEntry(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	/**
	 * Return a defensive context snapshot for public consumers.
	 */
	buildSessionContext(): SessionContext {
		const context = this.#getSessionContextForRead();
		if (!this.#sessionContextCacheOversized) return cloneSessionContext(context);
		// Large contexts are built from detached entry clones below. Transfer the
		// one-shot snapshot to the caller instead of retaining and deep-cloning a
		// second full graph; invalidate the cache so caller mutation cannot affect
		// a later read.
		this.#sessionContextCache = undefined;
		this.#sessionContextCacheOversized = false;
		this.#sessionContextEntryRevision = -1;
		this.#sessionContextLeafRevision = -1;
		this.#sessionContextReplayMetadataRevision = -1;
		return process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development"
			? cloneSessionContext(context)
			: (context as SessionContext);
	}

	/**
	 * Return the revision-keyed context cache for internal read-only consumers.
	 * Normal snapshots remain strongly held; snapshots over the materialized cache
	 * cap are weakly held so a GC cycle can reclaim them between reads.
	 */
	#getSessionContextForRead(): Readonly<SessionContext> {
		const hasResidentSentinel = this.#fileEntries.some(entry => containsResidentSentinel(entry));
		const cached = dereferenceMaterializedCache(this.#sessionContextCache);
		if (
			!hasResidentSentinel &&
			cached &&
			this.#sessionContextEntryRevision === this.#entryRevision &&
			this.#sessionContextLeafRevision === this.#leafRevision &&
			this.#sessionContextReplayMetadataRevision === this.#replayMetadataRevision
		) {
			return cached;
		}
		this.#pathOnlyContextBuildCount++;
		let resolvedProviderState: SessionEntry[] = [];
		if (this.#coldSidecarActive() && this.#sidecarRuntime) {
			const resolved = this.#resolvedProviderStateEntries();
			if (!resolved) {
				this.#ensureFullHotView();
				return this.#getSessionContextForRead();
			}
			resolvedProviderState = resolved;
		}
		const providerEntries = this.#getActivePathEntriesForProviderContext().map(cloneSessionEntry);
		const providerStateEntries = resolvedProviderState.map(cloneSessionEntry);
		let syntheticParentId: string | null = null;
		for (const entry of providerStateEntries) {
			entry.parentId = syntheticParentId;
			syntheticParentId = entry.id;
		}
		if (providerEntries[0] && syntheticParentId) providerEntries[0].parentId = syntheticParentId;
		const detachedEntries = [...providerStateEntries, ...providerEntries];
		const builtContext = buildSessionContext(detachedEntries, this.#leafId, undefined, this.#sessionId);
		this.#sessionContextCacheOversized = jsonLikeValueExceedsCacheLimit(builtContext, materializedCacheMaxBytes());
		if (this.#sessionContextCacheOversized) {
			this.#holdMaterializedCachesWeakly();
		}
		const context = freezeInternalReadSnapshot(builtContext);
		this.#sessionContextCache = hasResidentSentinel
			? undefined
			: this.#materializedCachesWeaklyHeld
				? new WeakRef(context)
				: context;
		transferSessionMessageIdentity(builtContext.messages, context.messages);
		this.#sessionContextEntryRevision = this.#entryRevision;
		this.#sessionContextLeafRevision = this.#leafRevision;
		this.#sessionContextReplayMetadataRevision = this.#replayMetadataRevision;
		return context;
	}

	#getActivePathEntriesForProviderContext(fromId?: string | null, forceColdSidecar = false): SessionEntry[] {
		if (fromId === null || (fromId === undefined && this.#leafId === null)) return [];
		const ids: string[] = [];
		const visited = new Set<string>();
		let current = this.#resolveEntry(fromId ?? this.#leafId ?? "");
		let activeCompaction: CompactionEntry | undefined;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			ids.push(current.id);
			if (!activeCompaction && current.type === "compaction") activeCompaction = current;
			if (
				(forceColdSidecar || this.#coldSidecarActive()) &&
				activeCompaction &&
				current.id === activeCompaction.firstKeptEntryId
			)
				break;
			current = current.parentId ? this.#resolveEntry(current.parentId) : undefined;
		}
		ids.reverse();
		const pathEntries = ids
			.map(id => this.#resolveEntry(id))
			.filter((entry): entry is SessionEntry => entry !== undefined);
		let compaction: CompactionEntry | undefined;
		for (const entry of pathEntries) if (entry.type === "compaction") compaction = entry;
		if (!compaction) return pathEntries.map(entry => this.#entryForProviderContext(entry, undefined));
		const compactionIndex = pathEntries.findIndex(entry => entry.id === compaction.id);
		const firstKeptIndex = pathEntries.findIndex(entry => entry.id === compaction.firstKeptEntryId);
		const remote = compaction.preserveData?.openaiRemoteCompaction;
		const hasRemoteReplacement = isRecord(remote) && Array.isArray(remote.replacementHistory);
		return pathEntries.map((entry, index) => {
			const covered =
				index < compactionIndex && (hasRemoteReplacement || (firstKeptIndex >= 0 && index < firstKeptIndex));
			return this.#entryForProviderContext(entry, covered ? "covered" : undefined);
		});
	}

	#entryForProviderContext(entry: SessionEntry, coldSpillPolicy: "covered" | undefined): SessionEntry {
		if (coldSpillPolicy === "covered" && (entry.type === "message" || entry.type === "custom_message")) {
			return cloneSessionEntry(entry);
		}
		if (entry.type !== "message" && entry.type !== "custom_message")
			return materializeProviderVisibleEntrySync(entry, this.#residentBlobStores());
		const materialized = materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), new Map());
		const rehydrated = rehydrateColdSpillEntry(
			materialized,
			this.#coldSpillReadStore(),
			this.#residentBlobStoresForColdRehydrate(),
		);
		if (rehydrated !== materialized) this.#coldSpillReadCount += this.#countColdSpillPayloads(entry);
		if (entry.type === "message" && rehydrated.type === "message") {
			transferSessionMessageIdentity([entry.message], [rehydrated.message]);
		}
		return rehydrated;
	}

	#countColdSpillPayloads(entry: SessionEntry): number {
		const marker = entry.type === "message" || entry.type === "custom_message" ? entry.evictedContent : undefined;
		return marker ? Object.keys(marker.payloads ?? {}).length : 0;
	}
	/** Strip stale OpenAI Responses assistant replay metadata from loaded in-memory entries without persisting it. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		this.#assertRecoveryHydrationWritable();
		return this.#sanitizeLoadedOpenAIResponsesReplayMetadata().length > 0;
	}

	async #sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist(): Promise<boolean> {
		const patches = this.#sanitizeLoadedOpenAIResponsesReplayMetadata();
		if (!this.isManagedDestination()) await this.#persistPatches(patches);
		return patches.length > 0;
	}

	#sanitizeLoadedOpenAIResponsesReplayMetadata(): EntryPatchRecord[] {
		const patches: EntryPatchRecord[] = [];
		for (const entry of this.#fileEntries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const sanitizedMessage = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitizedMessage === entry.message) continue;
			entry.message = sanitizedMessage;
			patches.push({ type: "entry_patch", entryId: entry.id, patch: { message: sanitizedMessage } });
		}
		if (patches.length > 0) {
			this.#bumpEntryRevision();
			this.#replayMetadataRevision++;
		}
		return patches;
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.#fileEntries.find(e => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Internal materialized entry cache. Public getters clone this snapshot before returning it.
	 */
	#getMaterializedEntriesInternal(): SessionEntry[] {
		this.#ensureFullHotView();
		const cached = dereferenceMaterializedCache(this.#materializedEntriesCache);
		if (this.#materializedEntriesRevision === this.#entryRevision && cached) return cached;
		this.#materializedEntriesCachePopulateCount++;
		const resolvedTextBlobCache = new Map<string, string>();
		const sourceEntries = this.#fileEntries.filter((e): e is SessionEntry => e.type !== "session");
		const materializedEntries = sourceEntries.map(entry =>
			materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), resolvedTextBlobCache),
		);
		if (jsonLikeValueExceedsCacheLimit(materializedEntries, materializedCacheMaxBytes())) {
			this.#holdMaterializedCachesWeakly();
		}
		if (!sourceEntries.some(entry => containsResidentImageSentinel(entry))) {
			this.#materializedEntriesCache = this.#materializedCachesWeaklyHeld
				? new WeakRef(materializedEntries)
				: materializedEntries;
			this.#materializedEntriesRevision = this.#entryRevision;
		}
		return materializedEntries;
	}

	/** Whether this manager contains persisted history without forcing cold hydration. */
	hasHistoryEntries(): boolean {
		if (this.#coldSidecarActive()) return true;
		return this.#fileEntries.some(entry => entry.type !== "session");
	}
	getEntries(): SessionEntry[] {
		this.#publicMaterializerCallCount++;
		this.#getEntriesMaterializerCallCount++;
		return this.#getMaterializedEntriesInternal().map(entry => cloneSessionEntry(entry));
	}

	/**
	 * Get the session as a tree structure. Returns defensive copies of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		return this.#getTree(this.getEntries());
	}
	#getTree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			nodeMap.set(entry.id, { entry, children: [], label: this.#resolveLabelForRead(entry.id) });
		}

		const addRoot = (node: SessionTreeNode): void => {
			if (!roots.includes(node)) {
				roots.push(node);
			}
		};
		const removeRoot = (node: SessionTreeNode): void => {
			const index = roots.indexOf(node);
			if (index !== -1) {
				roots.splice(index, 1);
			}
		};
		const wouldCreateChildCycle = (parent: SessionTreeNode, child: SessionTreeNode): boolean => {
			const stack: SessionTreeNode[] = [child];
			const visited = new Set<SessionTreeNode>();
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (current === parent) {
					return true;
				}
				if (visited.has(current)) {
					continue;
				}
				visited.add(current);
				stack.push(...current.children);
			}
			return false;
		};

		// Build tree. Corrupt session files can contain duplicate IDs or parentId
		// cycles; reject only the edge that would make the returned tree cyclic.
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				addRoot(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent && !wouldCreateChildCycle(parent, node)) {
					parent.children.push(node);
					removeRoot(node);
				} else {
					// Orphan or cycle-closing edge - treat as root
					addRoot(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		const sorted = new Set<SessionTreeNode>();
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (sorted.has(node)) {
				continue;
			}
			sorted.add(node);
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}
	[sessionManagerReadCapability](): SessionManagerReadAccess {
		return this.#internalReadAccess;
	}
	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		this.#assertRecoveryHydrationWritable();
		if (this.#activateColdBranch(branchFromId)) {
			this.#leafRevision++;
			return;
		}
		this.#deactivateColdForBranchMutation();
		if (!this.#resolveEntry(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#leafId = branchFromId;
		this.#leafRevision++;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.#assertRecoveryHydrationWritable();
		this.#deactivateColdForBranchMutation();
		this.#leafId = null;
		this.#leafRevision++;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		this.#assertRecoveryHydrationWritable();
		this.#deactivateColdForBranchMutation();
		if (branchFromId !== null && !this.#byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.#leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: this.#generateEntryId(),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		this.#assertRecoveryHydrationWritable();
		this.#ensureFullHotView();
		const previousSessionFile = this.#sessionFile;
		const branchPath = this.#getCanonicalBranchClones(leafId);
		if (branchPath.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map
		const pathWithoutLabels = branchPath.filter(e => e.type !== "label");
		const materializedPathWithoutLabels = materializeResidentEntriesForReadSync(
			pathWithoutLabels,
			this.#residentBlobStores(),
		);
		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = path.join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map(e => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label });
			}
		}

		if (this.persist) {
			const lines: string[] = [];
			lines.push(JSON.stringify(header));
			for (const entry of materializedPathWithoutLabels) {
				lines.push(JSON.stringify(prepareEntryForPersistenceSync(entry, this.#blobStore)));
			}
			// Write fresh label entries at the end
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: new Date().toISOString(),
					targetId,
					label,
				};
				lines.push(JSON.stringify(prepareEntryForPersistenceSync(labelEntry, this.#blobStore)));
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}
			const transitionEntries: FileEntry[] = [header, ...materializedPathWithoutLabels, ...labelEntries];
			const transition = this.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: newSessionId, sessionFile: newSessionFile },
					primary: {
						mode: "materialize",
						sourceEntries: transitionEntries,
						sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
					},
				},
				"retain-and-throw",
			);
			try {
				if (this.destination.kind === "managed") {
					this.#managedTranscriptStore(newSessionFile).publishNoReplaceSync(
						path.basename(newSessionFile),
						Buffer.from(`${lines.join("\n")}\n`, "utf8"),
					);
				} else {
					this.#storage.writeTextSync(newSessionFile, `${lines.join("\n")}\n`);
				}
			} catch (error) {
				transition.dispose();
				throw error;
			}
			this.#sessionId = newSessionId;
			this.#sessionFile = newSessionFile;
			this.#flushed = true;
			this.#commitResidentTextStoreTransition(transition);
			this.#adoptManagedPersistIdentity(newSessionFile);
			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map(e => e.id)])),
				parentId,
				timestamp: new Date().toISOString(),
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		const transitionEntries: FileEntry[] = [header, ...materializedPathWithoutLabels, ...labelEntries];
		const transition = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: newSessionId, sessionFile: newSessionFile },
				primary: {
					mode: "materialize",
					sourceEntries: transitionEntries,
					sourceStores: { textStore: null, imageStore: this.#residentImageBlobStore },
				},
			},
			"retain-and-throw",
		);
		this.#sessionId = newSessionId;
		this.#commitResidentTextStoreTransition(transition);
		return undefined;
	}

	/**
	 * Resolve the canonical default session directory for a cwd.
	 */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/** Resolve the default session directory without creating or migrating storage. */
	static getDefaultSessionDirReadOnly(cwd: string, agentDir?: string): string {
		const sessionsRoot = getSessionsDir(agentDir);
		const resolved = resolveManagedScope({
			cwd,
			agentDir: agentDir ?? path.resolve(sessionsRoot, ".."),
			sessionsRoot,
		});
		if (resolved.kind === "error") throw new Error(`Could not resolve managed session scope: ${resolved.message}`);
		return resolved.scope.directoryPath;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.gjc/agent/sessions/<encoded-cwd>/).
	 */
	static nestedManagedDestination(
		authority: ManagedDirectoryRoot | ManagedSessionDescendantStore,
		directory: string,
	): SessionDestination {
		const rootAuthority =
			authority instanceof ManagedSessionDescendantStore ? authority.subtreeRootAuthority : authority;
		const retainedAuthority =
			authority instanceof ManagedSessionDescendantStore
				? authority.retainAuthority()
				: retainManagedDirectoryAuthority(rootAuthority, directory);
		const policy =
			authority instanceof ManagedSessionDescendantStore
				? authority.securityPolicy
				: process.platform === "win32"
					? "windows-existing-verify-first"
					: "default";
		const profileAgentDir =
			authority instanceof ManagedSessionDescendantStore ? authority.profileAgentDir : getAgentDir();
		const securityContext = createManagedSessionSecurityContext({
			agentDir: rootAuthority.canonicalPath,
			profileAgentDir,
			sessionsRoot: rootAuthority.canonicalPath,
			sessionDir: directory,
			rootAuthority,
			retainedAuthority,
		});
		managedSecurityPolicies.set(securityContext, policy);
		const destination = Object.freeze({ kind: "managed" as const, directory, securityContext });
		trustedSessionDestinations.add(destination);
		return destination;
	}

	static managedDestination(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): SessionDestination {
		return managedDestination(cwd, storage, agentDir);
	}

	static explicitDestination(directory: string): SessionDestination {
		return explicitDestination(directory);
	}

	static create(
		cwd: string,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
	): SessionManager {
		const destination = destinationFor(cwd, destinationInput, storage);
		const manager = new SessionManager(cwd, destination.directory, true, storage, destination);
		manager.#initNewSession();
		return manager;
	}

	/** Prepare a selected candidate using this manager's captured managed destination authority. */
	async prepareManagedCandidateForWrite(
		filePath: string,
		migrationPolicy: SessionDirectoryMigrationPolicy,
		expectedIdentity?: ResumeSessionIdentity,
	): Promise<string> {
		return SessionManager.prepareManagedCandidateForWrite(
			filePath,
			migrationPolicy,
			this.destination,
			expectedIdentity,
		);
	}

	/** Prepare a managed candidate and retain its exact post-preparation identity for the next adoption. */
	async prepareManagedCandidateForStrictAdoption(
		filePath: string,
		migrationPolicy: SessionDirectoryMigrationPolicy,
		expectedIdentity: ResumeSessionIdentity,
	): Promise<string> {
		const preparedPath = await this.prepareManagedCandidateForWrite(filePath, migrationPolicy, expectedIdentity);
		const inspected = inspectResumeSessionFile(preparedPath, this.#storage);
		if ("kind" in inspected) throw new Error(`Could not inspect prepared managed session: ${inspected.reason}`);
		this.#pendingStrictAdoption = { canonicalPath: inspected.identity.canonicalPath, identity: inspected.identity };
		return preparedPath;
	}

	/** Resolve a default-managed candidate through binding validation and copy-retain migration before mutation. */
	static async prepareManagedCandidateForWrite(
		filePath: string,
		migrationPolicy: SessionDirectoryMigrationPolicy,
		destination: SessionDestination,
		expectedIdentity?: ResumeSessionIdentity,
	): Promise<string> {
		if (!trustedSessionDestinations.has(destination) || destination.kind !== "managed")
			throw new Error("Managed candidate preparation requires a trusted managed destination authority");
		const storage = new FileSessionStorage();
		const managedDestinationStore = managedStoreFromContext(destination.securityContext, destination.directory);
		const assertManagedDestinationBound = (): void => {
			managedDestinationStore.assertBound();
			if (!destination.securityContext.retainedAuthority)
				assertManagedDirectoryRoot(destination.securityContext.rootAuthority);
		};

		assertManagedDestinationBound();
		const inspectedResult = inspectTranscriptBounded(filePath, storage);
		if (!inspectedResult.ok) {
			if (inspectedResult.error.reason === "missing") return filePath;
			throw new Error(`Could not inspect managed session: ${inspectedResult.error.reason}`);
		}
		const inspected = inspectedResult.inspection;
		if (expectedIdentity && !sameResumeIdentity(expectedIdentity, inspected.identity))
			throw new Error("Managed session changed before migration authority was adopted.");
		if (!inspected.cwd) return filePath;
		const sessionsRoot = destination.securityContext.sessionsRoot;
		const resolvedPath = path.resolve(filePath);
		const relativeToManagedRoot = path.relative(sessionsRoot, resolvedPath);
		const isManagedPath =
			relativeToManagedRoot === "" ||
			(!relativeToManagedRoot.startsWith("..") && !path.isAbsolute(relativeToManagedRoot));

		if (!isManagedPath) return filePath;
		assertManagedDestinationBound();
		const resolved = resolveManagedScope({
			cwd: inspected.cwd,
			agentDir: destination.securityContext.agentDir,
			sessionsRoot,
		});
		if (resolved.kind === "error") throw new Error(`Could not resolve managed session scope: ${resolved.message}`);

		assertManagedDestinationBound();
		const listing = listManagedCandidates(resolved.scope);
		assertManagedDestinationBound();
		if (listing.kind !== "complete") throw new Error(`Managed session scan failed: ${listing.message}`);

		const candidate = listing.owned.find(item => path.resolve(item.path) === resolvedPath);
		if (!candidate) throw new Error("Session is inside managed storage but is not an authorized managed candidate.");
		const revalidated = inspectTranscriptBounded(filePath, storage);
		if (
			!revalidated.ok ||
			!sameResumeIdentity(inspected.identity, revalidated.inspection.identity) ||
			candidate.identity.dev !== inspected.identity.dev ||
			candidate.identity.ino !== inspected.identity.ino ||
			candidate.identity.size !== inspected.identity.size ||
			candidate.identity.mtimeNs !== inspected.identity.mtimeNs ||
			candidate.identity.mtimeMs !== inspected.identity.mtimeMs ||
			candidate.identity.sha256 !== inspected.identity.sha256
		)
			throw new Error("Managed session changed before migration authority was adopted.");
		assertManagedDestinationBound();
		const authority: ManagedCandidateWriteAuthority = {
			rootAuthority: destination.securityContext.rootAuthority,
			...(path.resolve(destination.directory) === path.resolve(resolved.scope.directoryPath)
				? {
						retainedAuthority: destination.securityContext.retainedAuthority,
						retainedDirectory: destination.directory,
					}
				: {}),
		};
		let opened: ManagedOpenCandidateResult;
		try {
			opened = await openManagedCandidateForWrite(
				resolved.scope,
				candidate,
				expectedIdentity ?? inspected.identity,
				migrationPolicy,
				authority,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "migration_busy") throw new SessionMigrationBusyError();
			if (error instanceof Error && error.message.startsWith("Managed root authority changed"))
				managedDestinationStore.assertBound();
			throw error;
		}
		if (opened.kind === "error") {
			managedDestinationStore.assertBound();
			if (opened.code === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
			if (opened.code === "artifact_capacity_exceeded") throw new SessionArtifactCapacityError(opened.message);
			if (opened.code === "migration_busy") throw new SessionMigrationBusyError();
			throw new Error(`Could not open managed session: ${opened.message}`);
		}
		assertManagedDestinationBound();
		return opened.path;
	}

	async #cleanupFailedForkDestination(
		sessionFile: string,
		expectedTranscript?: ManagedFileSnapshot,
		expectedArtifacts?: native.NativeDirectoryTreeSnapshot,
	): Promise<void> {
		this.#releaseManagedSidecarCache();
		if (this.destination.kind !== "managed") {
			await this.#storage.deleteSessionWithArtifacts(sessionFile);
			return;
		}
		const store = this.#managedTranscriptStore(sessionFile);
		const transcriptName = path.basename(sessionFile);
		const artifactName = path.basename(sessionFile.slice(0, -6));
		if (expectedArtifacts) store.removeTreeExpected(artifactName, expectedArtifacts);
		if (expectedTranscript) store.removeExpected(transcriptName, expectedTranscript);
	}

	async #tryForkFromBoundedSource(sourcePath: string, expectedIdentity?: ResumeSessionIdentity): Promise<boolean> {
		const boundedReadStorage = this.#boundedReadStorage();
		const sourceSize = expectedIdentity?.size ?? boundedReadStorage.statSync(sourcePath).size;
		if (
			this.#effectiveSessionMemoryMode(sourceSize) !== "enabled" ||
			typeof boundedReadStorage.readRangeSync !== "function" ||
			typeof this.#storage.openStagedWriter !== "function"
		)
			return false;
		let sourceHeader: SessionHeader | undefined;
		let previousId: string | null = null;
		let ordinal = 0;
		let sawCompaction = false;
		let preflightRejected = false;
		const headerPatch: HeaderPatchRecord["patch"] = {};
		const entryPatches = new Map<string, EntryPatchRecord["patch"]>();
		let overlayBytes = 0;
		let requiresRecordTransforms = false;
		const preflightHash = crypto.createHash("sha256");
		const preflightResult: { stat?: SessionStorageStat } = {};
		const preflightFailure = scanTranscriptLinesBounded(
			boundedReadStorage,
			sourcePath,
			sourceSize,
			(_offset, lineBytes) => {
				preflightHash.update(lineBytes);
				try {
					const record = JSON.parse(decodeBoundedJsonLine(lineBytes)) as FileEntry | SessionPatchRecord;
					if (ordinal++ === 0) {
						if (
							record.type !== "session" ||
							record.version !== CURRENT_SESSION_VERSION ||
							(expectedIdentity !== undefined && record.id !== expectedIdentity.sessionId)
						)
							preflightRejected = true;
						else sourceHeader = record;
						return !preflightRejected;
					}
					if (record.type === "header_patch" || record.type === "entry_patch") {
						requiresRecordTransforms = true;
						overlayBytes += lineBytes.byteLength;
						if (overlayBytes > FORK_PATCH_OVERLAY_BUDGET_BYTES) {
							preflightRejected = true;
							return false;
						}
						if (record.type === "header_patch" && isHeaderPatchRecord(record))
							Object.assign(headerPatch, record.patch);
						else if (record.type === "entry_patch" && isEntryPatchRecord(record)) {
							if (!verifyForkBlobRefsBounded(record.patch)) {
								preflightRejected = true;
								return false;
							}
							entryPatches.set(record.entryId, record.patch);
						} else {
							preflightRejected = true;
							return false;
						}
						return;
					}
					if (
						record.type === "session" ||
						typeof record.id !== "string" ||
						record.id === previousId ||
						record.parentId !== previousId ||
						!verifyForkBlobRefsBounded(record)
					) {
						preflightRejected = true;
						return false;
					}
					previousId = record.id;
					if (record.type === "message" && record.message.role === "assistant") requiresRecordTransforms = true;
					if (record.type === "compaction") sawCompaction = true;
				} catch {
					preflightRejected = true;
					return false;
				}
			},
			preflightResult,
			false,
			true,
		);
		if (preflightFailure || preflightRejected || !sourceHeader || !sawCompaction) return false;
		const preflightDigest = preflightHash.digest("hex");
		if (expectedIdentity && preflightDigest !== expectedIdentity.sha256)
			throw new Error("fork_source_identity_changed");
		const identity =
			expectedIdentity ??
			(preflightResult.stat
				? {
						canonicalPath: path.resolve(sourcePath),
						sessionId: sourceHeader.id,
						dev: preflightResult.stat.dev,
						ino: preflightResult.stat.ino,
						nlink: preflightResult.stat.nlink,
						size: preflightResult.stat.size,
						mtimeMs: preflightResult.stat.mtimeMs,
						mtimeNs: preflightResult.stat.mtimeNs,
						ctimeNs: preflightResult.stat.ctimeNs,
						sha256: preflightDigest,
					}
				: undefined);
		if (!identity) return false;
		applyHeaderPatch(sourceHeader, headerPatch);
		const fresh = this.#freshSessionState({ parentSession: sourceHeader.id });
		fresh.header.title = sourceHeader.title;
		fresh.header.titleSource = sourceHeader.titleSource;
		if (!fresh.sessionFile) return false;
		const staged = this.#storage.openStagedWriter(fresh.sessionFile, {
			securityContext: this.destination.kind === "managed" ? this.destination.securityContext : undefined,
		});
		let published = false;
		let managedPublishedTranscript: ManagedFileSnapshot | undefined;
		let managedPublishedArtifacts: native.NativeDirectoryTreeSnapshot | undefined;
		try {
			let ordinal = 0;
			const copyHash = crypto.createHash("sha256");
			const copyResult: { stat?: SessionStorageStat } = {};
			const copyFailure = scanTranscriptLinesBounded(
				boundedReadStorage,
				sourcePath,
				identity.size,
				(_offset, lineBytes) => {
					copyHash.update(lineBytes);
					if (ordinal++ === 0) {
						staged.writeLine(Buffer.from(JSON.stringify(fresh.header), "utf8"));
						return;
					}
					if (!requiresRecordTransforms) {
						staged.writeLine(lineBytes.subarray(0, lineBytes.byteLength - 1));
						return;
					}
					const record = JSON.parse(decodeBoundedJsonLine(lineBytes)) as SessionEntry | SessionPatchRecord;
					if (record.type === "header_patch" || record.type === "entry_patch") return;
					if (record.type === "message") {
						const patch = entryPatches.get(record.id);
						if (patch?.message) record.message = patch.message;
						if (record.message.role === "assistant")
							record.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(record.message);
					}
					staged.writeLine(Buffer.from(JSON.stringify(record), "utf8"));
				},
				copyResult,
				false,
				true,
			);
			if (copyFailure) throw new Error(`fork_bounded_copy_${copyFailure}`);
			if (copyHash.digest("hex") !== identity.sha256) throw new Error("fork_source_identity_changed");
			if (
				copyResult.stat &&
				(copyResult.stat.dev !== identity.dev ||
					copyResult.stat.ino !== identity.ino ||
					(identity.nlink !== undefined && copyResult.stat.nlink !== identity.nlink) ||
					copyResult.stat.size !== identity.size ||
					copyResult.stat.mtimeNs !== identity.mtimeNs ||
					(identity.ctimeNs !== undefined && copyResult.stat.ctimeNs !== identity.ctimeNs))
			)
				throw new Error("fork_source_identity_changed");
			staged.fsync();
			staged.closeSync();
			if (this.destination.kind === "managed") this.#managedTranscriptStore(fresh.sessionFile).assertBound();
			staged.publishNoReplace();
			published = true;
			if (this.destination.kind === "managed") {
				managedPublishedTranscript =
					this.#managedTranscriptStore(fresh.sessionFile).readExpected(path.basename(fresh.sessionFile)) ??
					undefined;
				if (!managedPublishedTranscript) throw new Error("managed_fork_transcript_publish_missing");
			}
			if (copyResult.stat) {
				const current = boundedReadStorage.statSync(sourcePath);
				if (!sameDescriptor(copyResult.stat, current)) throw new Error("fork_source_identity_changed");
			} else if (revalidateTranscriptIdentityBounded(sourcePath, boundedReadStorage, identity).kind !== "valid") {
				throw new Error("fork_source_identity_changed");
			}
			await this.copyArtifactsForFork(sourcePath, fresh.sessionFile);
			if (this.destination.kind === "managed") {
				const store = this.#managedTranscriptStore(fresh.sessionFile);
				try {
					managedPublishedArtifacts = store.captureTree(path.basename(fresh.sessionFile.slice(0, -6)));
				} catch (error) {
					if (!(error instanceof Error) || error.message !== "not_found") throw error;
				}
			}
			await this.#initSessionFile(fresh.sessionFile);
			writeTerminalBreadcrumb(this.cwd, fresh.sessionFile);
			return true;
		} catch (error) {
			try {
				staged.closeSync();
			} catch {
				// Preserve the fork failure.
			}
			if (published)
				await this.#cleanupFailedForkDestination(
					fresh.sessionFile,
					managedPublishedTranscript,
					managedPublishedArtifacts,
				);
			throw error;
		}
	}

	async #tryForkFromCapturedBounded(
		snapshot: CapturedSessionTranscriptSnapshot,
	): Promise<StrictSessionForkResult | undefined> {
		if (
			this.#effectiveSessionMemoryMode(snapshot.identity.size) !== "enabled" ||
			typeof snapshot.storage.openStagedWriter !== "function" ||
			(snapshot.storage instanceof FileSessionStorage && !snapshot.storage.existsSync(this.destination.directory))
		)
			return undefined;
		let sourceHeader: SessionHeader | undefined;
		let previousId: string | null = null;
		let ordinal = 0;
		let sawCompaction = false;
		let rejected = false;
		const headerPatch: HeaderPatchRecord["patch"] = {};
		const entryPatches = new Map<string, EntryPatchRecord["patch"]>();
		let overlayBytes = 0;
		let requiresRecordTransforms = false;
		const managedSourceStorage = this.#boundedManagedSource ? this.#boundedReadStorage() : undefined;
		const forEachSourceLine = (visit: (line: Uint8Array) => boolean | undefined): void => {
			if (!managedSourceStorage) {
				snapshot.forEachLine(visit);
				return;
			}
			const hash = crypto.createHash("sha256");
			const scanResult: { stat?: SessionStorageStat } = {};
			let aborted = false;
			const failure = scanTranscriptLinesBounded(
				managedSourceStorage,
				snapshot.sourcePath,
				snapshot.identity.size,
				(_offset, line) => {
					hash.update(line);
					const body = line[line.byteLength - 1] === 0x0a ? line.subarray(0, line.byteLength - 1) : line;
					if (body.byteLength === 0) return;
					if (visit(body) === false) {
						aborted = true;
						return false;
					}
				},
				scanResult,
				true,
				true,
			);
			if (failure && !(failure === "aborted" && aborted)) throw new Error(`transcript_scan_${failure}`);
			if (aborted) return;
			const terminalStat = scanResult.stat ?? managedSourceStorage.statSync(snapshot.sourcePath);
			if (!resumeIdentityMatchesDescriptor(snapshot.identity, terminalStat)) throw new Error("identity-mismatch");
			if (hash.digest("hex") !== snapshot.identity.sha256) throw new Error("identity-mismatch");
		};
		try {
			forEachSourceLine(line => {
				if (rejected || line.byteLength === 0) return;
				const record = JSON.parse(decodeBoundedJsonLine(line)) as FileEntry | SessionPatchRecord;
				if (ordinal++ === 0) {
					if (
						record.type !== "session" ||
						record.version !== CURRENT_SESSION_VERSION ||
						record.id !== snapshot.identity.sessionId
					)
						rejected = true;
					else sourceHeader = record;
					return;
				}
				if (record.type === "header_patch" || record.type === "entry_patch") {
					requiresRecordTransforms = true;
					overlayBytes += line.byteLength;
					if (overlayBytes > FORK_PATCH_OVERLAY_BUDGET_BYTES) {
						rejected = true;
						return;
					}
					if (record.type === "header_patch" && isHeaderPatchRecord(record))
						Object.assign(headerPatch, record.patch);
					else if (record.type === "entry_patch" && isEntryPatchRecord(record)) {
						if (!verifyForkBlobRefsBounded(record.patch)) {
							rejected = true;
							return;
						}
						entryPatches.set(record.entryId, record.patch);
					} else rejected = true;
					return;
				}
				if (
					record.type === "session" ||
					typeof record.id !== "string" ||
					record.id === previousId ||
					record.parentId !== previousId ||
					!verifyForkBlobRefsBounded(record)
				) {
					rejected = true;
					return;
				}
				previousId = record.id;
				if (record.type === "message" && record.message.role === "assistant") requiresRecordTransforms = true;
				if (record.type === "compaction") sawCompaction = true;
			});
		} catch {
			return undefined;
		}
		if (rejected || !sourceHeader || !sawCompaction) return undefined;
		applyHeaderPatch(sourceHeader, headerPatch);
		const fresh = this.#freshSessionState({ parentSession: sourceHeader.id });
		fresh.header.title = sourceHeader.title;
		fresh.header.titleSource = sourceHeader.titleSource;
		if (!fresh.sessionFile) return undefined;
		const staged = snapshot.storage.openStagedWriter(fresh.sessionFile, {
			securityContext: this.destination.kind === "managed" ? this.destination.securityContext : undefined,
		});
		let published = false;
		let managedPublishedTranscript: ManagedFileSnapshot | undefined;
		try {
			let writeOrdinal = 0;
			forEachSourceLine(line => {
				if (line.byteLength === 0) return;
				if (writeOrdinal++ === 0) {
					staged.writeLine(Buffer.from(JSON.stringify(fresh.header), "utf8"));
					return;
				}
				if (!requiresRecordTransforms) {
					staged.writeLine(line);
					return;
				}
				const record = JSON.parse(decodeBoundedJsonLine(line)) as SessionEntry | SessionPatchRecord;
				if (record.type === "header_patch" || record.type === "entry_patch") return;
				if (record.type === "message") {
					const patch = entryPatches.get(record.id);
					if (patch?.message) record.message = patch.message;
					if (record.message.role === "assistant")
						record.message = sanitizeRehydratedOpenAIResponsesAssistantMessage(record.message);
				}
				staged.writeLine(Buffer.from(JSON.stringify(record), "utf8"));
			});
			staged.fsync();
			staged.closeSync();
			if (this.destination.kind === "managed") this.#managedTranscriptStore(fresh.sessionFile).assertBound();
			staged.publishNoReplace();
			published = true;
			if (this.destination.kind === "managed") {
				managedPublishedTranscript =
					this.#managedTranscriptStore(fresh.sessionFile).readExpected(path.basename(fresh.sessionFile)) ??
					undefined;
				if (!managedPublishedTranscript) throw new Error("managed_fork_transcript_publish_missing");
			}
			const copyDescriptor = managedSourceStorage
				? managedSourceStorage.statSync(snapshot.sourcePath)
				: snapshot.getLastReadStat();
			if (copyDescriptor) {
				const current = managedSourceStorage
					? managedSourceStorage.statSync(snapshot.sourcePath)
					: snapshot.storage.statSync(snapshot.sourcePath);
				if (!sameDescriptor(copyDescriptor, current)) {
					await this.#cleanupFailedForkDestination(fresh.sessionFile, managedPublishedTranscript);
					return { kind: "error", reason: "identity-mismatch" };
				}
			} else {
				const afterWrite = snapshot.revalidate();
				if (afterWrite.kind !== "valid") {
					await this.#cleanupFailedForkDestination(fresh.sessionFile, managedPublishedTranscript);
					return afterWrite;
				}
			}
			await this.#initSessionFile(fresh.sessionFile);
			writeTerminalBreadcrumb(this.cwd, fresh.sessionFile);
			return { kind: "forked", manager: this };
		} catch (error) {
			try {
				staged.closeSync();
			} catch {
				// Preserve the captured-fork failure.
			}
			if (published) await this.#cleanupFailedForkDestination(fresh.sessionFile, managedPublishedTranscript);
			throw error;
		}
	}

	/**
	 * Fork a session into the current project directory.
	 * Copies history from another session file while creating a new session file in the current sessionDir.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
		migrationPolicy: SessionDirectoryMigrationPolicy = "copy-retain",
		sessionMemoryMode: SessionMemoryMode = "shadow",
	): Promise<SessionManager> {
		const destination = destinationFor(cwd, destinationInput, storage);
		const dir = destination.directory;
		const manager = new SessionManager(cwd, dir, true, storage, destination);
		manager.#sessionMemoryMode = sessionMemoryMode;
		let managedSourcePath = sourcePath;
		if (destination.kind === "managed" && storage instanceof FileSessionStorage) {
			const resolvedSource = path.resolve(sourcePath);
			const sessionsRoot = path.resolve(destination.securityContext.sessionsRoot);
			if (
				pathIsWithin(sessionsRoot, resolvedSource) &&
				path.dirname(resolvedSource) !== path.resolve(destination.directory)
			) {
				managedSourcePath = await SessionManager.prepareManagedCandidateForWrite(
					sourcePath,
					migrationPolicy,
					destination,
				);
			}
		}
		let boundedStorage: SessionStorage = storage;
		if (
			destination.kind === "managed" &&
			storage instanceof FileSessionStorage &&
			pathIsWithin(path.resolve(destination.securityContext.sessionsRoot), path.resolve(managedSourcePath))
		) {
			const sourceDirectory = path.dirname(path.resolve(managedSourcePath));
			const destinationDirectory = path.resolve(destination.directory);
			const sourceStore =
				sourceDirectory === destinationDirectory
					? manager.#managedTranscriptStore(managedSourcePath)
					: managedStoreFromContext(destination.securityContext, sourceDirectory);
			try {
				sourceStore.assertBound();
				const descriptor = sourceStore.descriptorExpected(path.basename(managedSourcePath));
				if (!descriptor) throw Object.assign(new Error("Managed file not found"), { code: "ENOENT" });
				manager.#boundedManagedSource = {
					path: managedSourcePath,
					store: sourceStore,
					descriptor,
					owned: sourceDirectory !== destinationDirectory,
				};
				boundedStorage = manager.#boundedReadStorage();
			} catch (error) {
				sourceStore.close();
				throw error;
			}
		}
		let retainedFallbackSnapshot: ManagedFileSnapshot | undefined;
		let sourceSize: number | undefined;
		try {
			sourceSize = boundedStorage.statSync(managedSourcePath).size;
			if (manager.#effectiveSessionMemoryMode(sourceSize) === "enabled") {
				const inspected = inspectTranscriptBounded(
					managedSourcePath,
					boundedStorage,
					BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES,
				);
				if (
					inspected.ok &&
					(await manager.#tryForkFromBoundedSource(managedSourcePath, inspected.inspection.identity))
				)
					return manager;
			}
			if (manager.#boundedManagedSource && sourceSize <= eagerHydrationMaxBytes()) {
				const boundedSource = manager.#boundedManagedSource;
				retainedFallbackSnapshot = boundedSource.store.readExpected(path.basename(managedSourcePath)) ?? undefined;
				const terminalDescriptor = boundedSource.store.descriptorExpected(path.basename(managedSourcePath));
				if (
					!retainedFallbackSnapshot ||
					!terminalDescriptor ||
					!sameDescriptor(boundedSource.descriptor, terminalDescriptor) ||
					!managedFileSnapshotMatchesDescriptor(retainedFallbackSnapshot, boundedSource.descriptor)
				)
					throw new Error("source_changed");
			}
		} finally {
			manager.#clearBoundedManagedSource();
		}
		if (sourceSize === undefined) throw new Error("Managed source size unavailable");
		if (sourceSize > eagerHydrationMaxBytes()) throw new SessionTranscriptOversizedError(sourceSize);
		const forkEntries = retainedFallbackSnapshot
			? (() => {
					const entries = parseSessionEntries(
						new TextDecoder("utf-8", { fatal: true }).decode(retainedFallbackSnapshot.bytes),
					);
					const header = entries[0] as SessionHeader | undefined;
					return header?.type === "session" && typeof header.id === "string" ? entries : [];
				})()
			: await loadEntriesFromFile(managedSourcePath, storage);
		migrateToCurrentVersion(forkEntries);
		await resolveBlobRefsInEntries(forkEntries, manager.#blobStore);
		const sourceHeader = forkEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const historyEntries = forkEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		const fresh = manager.#freshSessionState({ parentSession: sourceHeader?.id });
		fresh.header.title = sourceHeader?.title;
		fresh.header.titleSource = sourceHeader?.titleSource;
		const transition = manager.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: fresh.sessionId, sessionFile: fresh.sessionFile ?? "" },
				primary: {
					mode: "materialize",
					sourceEntries: [fresh.header, ...historyEntries],
					sourceStores: { textStore: null, imageStore: manager.#residentImageBlobStore },
				},
			},
			"memory-fallback",
		);
		manager.#applyFreshSessionMetadata(fresh);
		manager.#commitResidentTextStoreTransition(transition);
		manager.#retireEphemeralArtifacts();
		if (fresh.sessionFile) writeTerminalBreadcrumb(manager.cwd, fresh.sessionFile);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		await manager.#rewriteFile();
		return manager;
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 */
	/** Open an unpublished candidate transcript below the reserved staging directory. */
	static async openStaged(
		finalSessionFile: string,
		storage: SessionStorage = new FileSessionStorage(),
		attemptId: string = crypto.randomUUID(),
	): Promise<SessionManager> {
		assertSafeStagedAttemptId(attemptId);

		if (isStagedSessionPath(finalSessionFile)) throw new Error("Final session path cannot be staged");
		const finalPath =
			storage instanceof FileSessionStorage ? canonicalizeTrustedPath(finalSessionFile) : finalSessionFile;
		const finalDestination = explicitDestination(path.dirname(finalPath));
		const stagingDir = path.join(path.dirname(finalPath), SESSION_STAGING_DIRNAME);
		await fs.promises.mkdir(stagingDir, { recursive: true, mode: 0o700 });
		const stagedSessionFile = path.join(stagingDir, `${attemptId}.jsonl`);
		if (path.resolve(stagedSessionFile) === path.resolve(finalPath))
			throw new Error("Staged session path collides with final transcript");

		const manager = new SessionManager(getProjectDir(), stagingDir, true, storage, finalDestination);
		manager.#stagedPublication = {
			finalSessionFile: finalPath,
			stagedSessionFile,
			finalDestination,
			attemptId,
			committed: false,
			discarded: false,
		};
		if (fs.existsSync(stagedSessionFile)) throw new Error("Staged session attempt already exists");
		try {
			await manager.#initSessionFile(stagedSessionFile, true);
			const parentArtifacts = new ArtifactManager(finalPath.endsWith(".jsonl") ? finalPath.slice(0, -6) : finalPath);
			manager.adoptArtifactManager(parentArtifacts.createAttemptStaging(attemptId), parentArtifacts);
			return manager;
		} catch (error) {
			try {
				await manager.discardStaged();
			} catch (cleanupError) {
				throw new AggregateError(
					[toError(error), toError(cleanupError)],
					"Staged session open and cleanup both failed.",
				);
			}
			throw error;
		}
	}

	/** Managed-authority variant of {@link openStaged}. */
	static async stagedNestedManaged(
		finalSessionFile: string,
		destination: SessionDestination,
		store: ManagedSessionDescendantStore,
		storage: SessionStorage = new FileSessionStorage(),
		attemptId: string = crypto.randomUUID(),
	): Promise<SessionManager> {
		assertSafeStagedAttemptId(attemptId);

		if (destination.kind !== "managed" || !trustedSessionDestinations.has(destination))
			throw new Error("Nested managed session authority is unavailable");
		if (isStagedSessionPath(finalSessionFile)) throw new Error("Final session path cannot be staged");
		store.assertBound();
		const finalPath = path.resolve(finalSessionFile);
		if (path.dirname(finalPath) !== path.resolve(destination.directory))
			throw new Error("Nested managed session escaped retained authority");
		const stagingStore = store.deriveSubtree(SESSION_STAGING_DIRNAME);
		const stagedDir = stagingStore.dir;
		const stagedSessionFile = path.join(stagedDir, `${attemptId}.jsonl`);
		if (path.resolve(stagedSessionFile) === path.resolve(finalPath))
			throw new Error("Staged session path collides with final transcript");
		const stagedDestination = SessionManager.nestedManagedDestination(stagingStore, stagedDir);
		const manager = new SessionManager(getProjectDir(), stagedDir, true, storage, stagedDestination);
		manager.#stagedPublication = {
			finalSessionFile: finalPath,
			stagedSessionFile,
			finalDestination: destination,
			managedParentStore: store,
			managedStagingStore: stagingStore,
			attemptId,
			committed: false,
			discarded: false,
		};
		if (fs.existsSync(stagedSessionFile)) throw new Error("Staged session attempt already exists");
		try {
			await manager.#initSessionFile(stagedSessionFile, true);
			const parentArtifacts = new ArtifactManager(store);
			manager.adoptArtifactManager(parentArtifacts.createAttemptStaging(attemptId), parentArtifacts);
			store.assertBound();
			return manager;
		} catch (error) {
			try {
				await manager.discardStaged();
			} catch (cleanupError) {
				throw new AggregateError(
					[toError(error), toError(cleanupError)],
					"Staged session open and cleanup both failed.",
				);
			}
			throw error;
		}
	}
	/** Publish the candidate-owned staged transcript and artifacts at the real accept fence. */
	static async openStagedNestedManaged(
		finalSessionFile: string,
		destination: SessionDestination,
		store: ManagedSessionDescendantStore,
		storage: SessionStorage = new FileSessionStorage(),
		attemptId: string = crypto.randomUUID(),
	): Promise<SessionManager> {
		return SessionManager.stagedNestedManaged(finalSessionFile, destination, store, storage, attemptId);
	}

	async commitStaged(options?: { deferArtifactFinalize?: boolean }): Promise<void> {
		const staged = this.#stagedPublication;
		if (!staged || staged.discarded) throw new Error("Staged session is unavailable");
		if (staged.committed) return;
		staged.deferArtifactFinalize = options?.deferArtifactFinalize === true;
		await this.flush();
		await this.#closePersistWriter();
		const stagedManager = this.#adoptedArtifactManager ?? this.#artifactManager;
		// Lifecycle invariant: while a staged publication is uncommitted, the session must
		// carry exactly the attempt-rooted staging manager it opened with. openStaged,
		// stagedNestedManaged, and openStagedSession all pre-adopt an attempt-rooted
		// manager, so an adopted manager that is absent or foreign means a second root
		// replaced the first — orphaning the original from commit/discard cleanup.
		if (this.#adoptedArtifactManager?.getAttemptId() !== staged.attemptId)
			throw new Error("Staged session artifact root does not match the staged attempt.");
		const parentArtifacts =
			this.#stagedArtifactParent ??
			new ArtifactManager(
				staged.finalSessionFile.endsWith(".jsonl") ? staged.finalSessionFile.slice(0, -6) : staged.finalSessionFile,
			);
		this.#stagedCommitArtifactParent = parentArtifacts;
		let published = false;
		try {
			if (stagedManager?.getAttemptId() === staged.attemptId) {
				const stagedArtifactFiles = await stagedManager.listFiles();
				if (stagedArtifactFiles.length > 0 || stagedManager.getAllocatedIds().length > 0) {
					await parentArtifacts.commitAttemptStaging(stagedManager, staged.attemptId, {
						beforePublish: idMap => this.remapStagedArtifactReferences(idMap),
					});
				} else await stagedManager.discardAttemptStaging();
			}
			if (staged.managedParentStore && staged.managedStagingStore) {
				const stagedName = path.basename(staged.stagedSessionFile);
				const relative = path.posix.join(SESSION_STAGING_DIRNAME, stagedName);
				const expected = staged.managedStagingStore.readExpected(stagedName);
				if (!expected) throw new Error("staged_session_missing");
				staged.managedParentStore.moveFileNoReplace(relative, path.basename(staged.finalSessionFile), expected, {
					sourceStore: staged.managedStagingStore,
					sourceStoreRelativePath: stagedName,
				});
			} else {
				const outcome = classifyNativePublishOutcome(
					nativeSessionManager().renameNoReplacePath(staged.stagedSessionFile, staged.finalSessionFile),
				);
				if (!outcome.ok) throw new Error(outcome.code ?? "staged_session_publish_failed");
			}
			published = true;
			if (staged.managedParentStore) {
				staged.publishedFinalSnapshot =
					staged.managedParentStore.readExpected(path.basename(staged.finalSessionFile)) ?? undefined;
				if (!staged.publishedFinalSnapshot) throw new Error("staged_session_publish_missing");
			} else staged.publishedFinalBytes = await fs.promises.readFile(staged.finalSessionFile);

			const finalStat = fs.lstatSync(staged.finalSessionFile, { bigint: true });
			if (!finalStat.isFile() || finalStat.isSymbolicLink()) throw new Error("staged_session_identity_changed");
			this.sessionDir = path.dirname(staged.finalSessionFile);
			this.destination = staged.finalDestination;
			this.#managedTranscriptStoreCache = staged.managedParentStore
				? { directory: path.dirname(staged.finalSessionFile), store: staged.managedParentStore }
				: null;
			this.#sessionFile = staged.finalSessionFile;
			this.#artifactManager = parentArtifacts;
			this.#artifactManagerSessionFile = staged.finalSessionFile;
			this.#adoptedArtifactManager = parentArtifacts;
			staged.committed = true;
			if (!staged.deferArtifactFinalize) {
				writeTerminalBreadcrumb(this.cwd, staged.finalSessionFile);
				parentArtifacts.finalizeLastAttemptCommit(staged.attemptId);
			}
		} catch (error) {
			const cleanupErrors: Error[] = [];
			// A managed move can commit and still report failure when native code cannot
			// prove durability or terminal identity. Treating that as unpublished would
			// roll the artifacts back underneath a transcript that is already visible at
			// the destination, so probe the destination first and preserve every owned
			// artifact when the mutation may have landed.
			if (!published && staged.managedParentStore && !mayCleanManagedTreeStaging(error)) {
				const probeErrors: Error[] = [];
				let destination: ManagedFileSnapshot | null = null;
				try {
					destination = staged.managedParentStore.readExpected(path.basename(staged.finalSessionFile));
				} catch (probeError) {
					probeErrors.push(toError(probeError));
				}
				// Absence must be proven; an unreadable destination stays fail-closed.
				if (destination || probeErrors.length > 0) {
					staged.publishedFinalSnapshot = destination ?? undefined;
					// Latch the uncertainty so no later compensation reclaims what a possibly
					// published transcript references.
					staged.preservedUnproven = true;
					throw new AggregateError(
						[toError(error), ...probeErrors],
						"Staged publication may have committed without proof; artifacts and staging were preserved for recovery.",
					);
				}
			}
			if (published) {
				try {
					if (staged.managedParentStore) {
						const finalSnapshot = staged.managedParentStore.readExpected(path.basename(staged.finalSessionFile));
						if (finalSnapshot)
							staged.managedParentStore.removeExpected(path.basename(staged.finalSessionFile), finalSnapshot);
					} else await fs.promises.rm(staged.finalSessionFile, { force: true });
				} catch (cleanupError) {
					cleanupErrors.push(toError(cleanupError));
				}
			}
			try {
				await parentArtifacts.rollbackLastAttemptCommit(staged.attemptId);
			} catch (cleanupError) {
				cleanupErrors.push(toError(cleanupError));
			}
			try {
				await this.discardStaged();
			} catch (cleanupError) {
				cleanupErrors.push(toError(cleanupError));
			}
			if (cleanupErrors.length > 0)
				throw new AggregateError([toError(error), ...cleanupErrors], "Staged publication and cleanup both failed.");
			throw error;
		}
	}

	/** Finalize a staged publication whose post-fence publisher completed successfully. */
	finalizeStagedCommit(): void {
		const staged = this.#stagedPublication;
		if (!staged?.committed || !staged.deferArtifactFinalize) return;
		this.#stagedCommitArtifactParent?.finalizeLastAttemptCommit(staged.attemptId);
		writeTerminalBreadcrumb(this.cwd, staged.finalSessionFile);
		staged.deferArtifactFinalize = false;
	}

	/** Roll back a staged publication when post-fence visibility setup fails. */
	async rollbackCommittedStaged(): Promise<void> {
		const staged = this.#stagedPublication;
		if (!staged?.committed) return;
		if (staged.managedParentStore) {
			const current = staged.managedParentStore.readExpected(path.basename(staged.finalSessionFile));
			if (
				current &&
				staged.publishedFinalSnapshot &&
				current.identity.dev === staged.publishedFinalSnapshot.identity.dev &&
				current.identity.ino === staged.publishedFinalSnapshot.identity.ino
			) {
				if (this.#stagedCommitArtifactParent) {
					const removed = await this.#stagedCommitArtifactParent.removeNamedBestEffort(
						path.basename(staged.finalSessionFile),
					);
					if (!removed) throw new Error("staged_final_cleanup_failed");
				} else staged.managedParentStore.removeExpected(path.basename(staged.finalSessionFile), current);
			}
		} else if (staged.publishedFinalBytes) {
			const current = await fs.promises.readFile(staged.finalSessionFile).catch(() => undefined);
			if (current?.equals(staged.publishedFinalBytes))
				await fs.promises.rm(staged.finalSessionFile, { force: true });
		}
		await this.#stagedCommitArtifactParent?.rollbackLastAttemptCommit(staged.attemptId);
		staged.committed = false;
		staged.discarded = true;
		staged.deferArtifactFinalize = false;
	}

	/** Refresh the owned final snapshot after post-fence session metadata is appended. */
	async refreshStagedCommitSnapshot(): Promise<void> {
		const staged = this.#stagedPublication;
		if (!staged?.committed) return;
		if (staged.managedParentStore) {
			staged.publishedFinalSnapshot =
				staged.managedParentStore.readExpected(path.basename(staged.finalSessionFile)) ?? undefined;
			if (!staged.publishedFinalSnapshot) throw new Error("staged_session_publish_missing");
		} else staged.publishedFinalBytes = await fs.promises.readFile(staged.finalSessionFile);
	}

	/** Idempotently remove an unpublished staged transcript and its owned artifacts. */
	async discardStaged(): Promise<void> {
		const staged = this.#stagedPublication;
		if (!staged || staged.committed || staged.discarded) return;
		// An unproven publish may already be visible at the destination; reclaiming its
		// staging or artifacts would strand that transcript with dangling references.
		if (staged.preservedUnproven) return;
		const cleanupErrors: Error[] = [];
		// Same strict single-root invariant as commitStaged: an absent or foreign adopted
		// manager means the publication's own attempt root was replaced or released.
		if (this.#adoptedArtifactManager?.getAttemptId() !== staged.attemptId) {
			cleanupErrors.push(new Error("Staged session artifact root does not match the staged attempt."));
		}
		const captureCleanupError = (error: unknown): void => {
			const normalized = toError(error);
			if (normalized.message !== "not_found" && !isAuthorizedPendingCleanup(normalized))
				cleanupErrors.push(normalized);
		};
		try {
			await this.#closePersistWriter();
		} catch (error) {
			captureCleanupError(error);
		}
		let managedStagingBefore: ReturnType<ManagedSessionDescendantStore["captureTree"]> | undefined;
		if (staged.managedParentStore) {
			try {
				managedStagingBefore = staged.managedParentStore.captureTree(SESSION_STAGING_DIRNAME);
			} catch (error) {
				captureCleanupError(error);
			}
		}

		const stagedManager = this.#adoptedArtifactManager ?? this.#artifactManager;
		if (stagedManager?.getAttemptId() === staged.attemptId) {
			try {
				await stagedManager.discardAttemptStaging();
			} catch (error) {
				captureCleanupError(error);
			}
		}
		if (staged.managedParentStore) {
			const stagedName = path.basename(staged.stagedSessionFile);
			try {
				const stagingStore = staged.managedStagingStore;
				if (stagingStore) {
					const expected = stagingStore.readExpected(stagedName);
					if (expected) stagingStore.removeExpected(stagedName, expected);
				}
			} catch (error) {
				captureCleanupError(error);
			}
			if (managedStagingBefore) {
				try {
					const after = staged.managedParentStore.captureTree(SESSION_STAGING_DIRNAME);
					const beforePaths = new Set(managedStagingBefore.entries.map(entry => entry.relativePath));
					for (const entry of after.entries) {
						if (
							entry.relativePath.length === 0 ||
							beforePaths.has(entry.relativePath) ||
							(!/^\.gjc-/u.test(path.posix.basename(entry.relativePath)) &&
								!/\.removing$/u.test(path.posix.basename(entry.relativePath)))
						)
							continue;
						try {
							await fs.promises.rm(
								path.join(staged.managedParentStore.dir, SESSION_STAGING_DIRNAME, entry.relativePath),
								{ recursive: entry.kind === "directory", force: true },
							);
						} catch (error) {
							captureCleanupError(error);
						}
					}
				} catch (error) {
					captureCleanupError(error);
				}
			}
		} else {
			try {
				await fs.promises.rm(staged.stagedSessionFile, { force: true });
			} catch (error) {
				captureCleanupError(error);
			}
		}
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Staged session cleanup failed.");
		staged.discarded = true;
	}
	async commitStagedNestedManaged(): Promise<void> {
		return this.commitStaged();
	}

	async discardStagedNestedManaged(): Promise<void> {
		return this.discardStaged();
	}

	static async open(
		filePath: string,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
		migrationPolicy: SessionDirectoryMigrationPolicy = "copy-retain",
		sessionMemoryMode: SessionMemoryMode = "shadow",
	): Promise<SessionManager> {
		if (isStagedSessionPath(filePath)) throw new Error("Staged session paths are not resumable");
		const destination =
			destinationInput === undefined
				? explicitDestination(path.dirname(filePath))
				: destinationFor(getProjectDir(), destinationInput, storage);
		// Canonicalize benign ancestor symlinks in the caller-supplied path (e.g.
		// macOS `/var -> /private/var`, a symlinked `$HOME`/project) so explicit
		// session files land under a symlink-free trusted root that the strict
		// owner-only and reparse guards accept.
		if (storage instanceof FileSessionStorage) filePath = canonicalizeTrustedPath(filePath);
		if (destination.kind === "explicit" || !(storage instanceof FileSessionStorage)) {
			let sourceSize: number | undefined;
			try {
				sourceSize = storage.statSync(filePath).size;
			} catch {
				// Missing files continue through strict inspection and initialization.
			}
			const boundedAdmission =
				sessionMemoryMode === "enabled" ||
				(sessionMemoryMode === "auto" &&
					process.platform !== "win32" &&
					sourceSize !== undefined &&
					sourceSize >= autoModeMinTranscriptBytes());
			let strictSmallInspection: ResumeInspectionSnapshot | undefined;
			if (boundedAdmission && sourceSize !== undefined && sourceSize <= eagerHydrationMaxBytes()) {
				const strict = inspectResumeSessionFile(filePath, storage);
				if ("kind" in strict) throw new Error(`Could not open session: ${strict.reason}`);
				strictSmallInspection = strict;
			}
			if (!boundedAdmission) {
				const inspected = inspectResumeSessionFile(filePath, storage);
				if ("kind" in inspected) {
					if (inspected.reason === "missing") {
						const manager = new SessionManager(
							getProjectDir(),
							destination.directory,
							true,
							storage,
							destination,
						);
						manager.#sessionMemoryMode = sessionMemoryMode;
						await manager.#initSessionFile(filePath, true);
						return manager;
					}
					if (inspected.reason === "oversized") throw new SessionTranscriptOversizedError(inspected.size ?? 0);
					throw new Error(`Could not open session: ${inspected.reason}`);
				}
				const header = inspected.entries[0] as SessionHeader;
				const manager = new SessionManager(
					header.cwd || getProjectDir(),
					destination.directory,
					true,
					storage,
					destination,
				);
				manager.#sessionMemoryMode = sessionMemoryMode;
				await manager.#hydrateExistingSession(filePath, inspected.entries, inspected.migrationApplied);
				await manager.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
				manager.buildSessionContext();
				return manager;
			}
			const inspected = strictSmallInspection
				? { ok: true as const, inspection: { cwd: (strictSmallInspection.entries[0] as SessionHeader).cwd } }
				: inspectTranscriptHeaderBounded(filePath, storage, BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES);
			if (!inspected.ok) {
				if (inspected.error.reason === "missing") {
					const manager = new SessionManager(getProjectDir(), destination.directory, true, storage, destination);
					manager.#sessionMemoryMode = sessionMemoryMode;
					await manager.#initSessionFile(filePath, true);
					return manager;
				}
				if (inspected.error.reason === "oversized")
					throw new SessionTranscriptOversizedError(inspected.error.size ?? 0);
				throw new Error(`Could not open session: ${inspected.error.reason}`);
			}
			const manager = new SessionManager(
				inspected.inspection.cwd ?? getProjectDir(),
				destination.directory,
				true,
				storage,
				destination,
			);
			manager.#sessionMemoryMode = sessionMemoryMode;
			try {
				await manager.#initSessionFile(
					filePath,
					false,
					strictSmallInspection ? { inspection: strictSmallInspection, storage, reuseEntries: false } : undefined,
				);
				if (strictSmallInspection) {
					if (
						!revalidateStrictResumeInspection(filePath, storage, strictSmallInspection) ||
						manager.#sessionId !== strictSmallInspection.identity.sessionId
					)
						throw new Error("Could not open session: unstable");
					await manager.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
				}
				manager.buildSessionContext();
				return manager;
			} catch (error) {
				manager.setSessionMemoryMode("off");
				for (const sidecarPath of manager.#disposableSidecarPaths()) {
					if (!sidecarPath) continue;
					try {
						manager.#storage.unlinkSync(sidecarPath);
					} catch (cleanupError) {
						if (!isEnoent(cleanupError))
							logger.warn("Rejected explicit resume sidecar cleanup failed", {
								error: toError(cleanupError).message,
							});
					}
				}
				manager.#sidecarRuntime = undefined;
				try {
					await manager.#discardRejectedOpenState();
				} catch (cleanupError) {
					throw new AggregateError(
						[toError(error), toError(cleanupError)],
						"Rejected explicit resume cleanup failed",
					);
				}
				throw error;
			}
		}
		const sameManagedDirectory = path.dirname(path.resolve(filePath)) === path.resolve(destination.directory);
		let managedInspectionStore: ManagedSessionDescendantStore | undefined;
		let managedInspectionStorage: SessionStorage = storage;
		if (sameManagedDirectory) {
			managedInspectionStore = managedStoreFromContext(destination.securityContext, destination.directory);
			managedInspectionStorage = retainedManagedInspectionStorage(storage, managedInspectionStore, filePath);
		}
		let managedSourceSize: number | undefined;
		try {
			await SessionManagerTestHooks.beforeManagedSourceStat?.(filePath, managedInspectionStorage);
			managedSourceSize = managedInspectionStorage.statSync(filePath).size;
		} catch (error) {
			if (!isEnoent(error)) {
				managedInspectionStore?.close();
				throw error;
			}
			if (managedInspectionStore) {
				managedInspectionStore.assertBound();
				await SessionManagerTestHooks.beforeManagedMissingInit?.(filePath, managedInspectionStorage);
				managedInspectionStore.assertBound();
				const manager = new SessionManager(
					getProjectDir(),
					destination.directory,
					true,
					storage,
					destination,
					true,
				);
				manager.#sessionMemoryMode = sessionMemoryMode;
				try {
					await SessionManagerTestHooks.beforeManagedMissingPublish?.(filePath, managedInspectionStorage);
					managedInspectionStore.assertBound();
					await SessionManagerTestHooks.afterManagedMissingAssertion?.(filePath, managedInspectionStorage);
					const fresh = manager.#freshSessionState(undefined, filePath);
					const prepared = manager.#prepareFreshSessionTransition(fresh, "memory-fallback");
					manager.#applyFreshSessionMetadata(fresh);
					manager.#commitResidentTextStoreTransition(prepared, false);
					manager.#retireEphemeralArtifacts();
					const content = `${JSON.stringify(prepareEntryForPersistenceSync(fresh.header, manager.#blobStore))}\n`;
					managedInspectionStore.publishNoReplaceSync(path.basename(filePath), Buffer.from(content, "utf8"));
					const publishedTranscript = managedInspectionStore.readExpected(path.basename(filePath));
					if (publishedTranscript?.bytes?.equals(Buffer.from(content, "utf8")) !== true)
						throw new Error("Could not open session: unstable");
					if (manager.#effectiveSessionMemoryMode() !== "off") {
						manager.#buildDisposableSidecars(manager.#fileEntries);
						if (manager.#coldSidecarActive()) manager.#retireColdEntries();
					}
					manager.#flushed = true;
					manager.#ensuredOnDisk = true;
					await SessionManagerTestHooks.beforeManagedMissingReturn?.(filePath, managedInspectionStorage);
					const returnTranscript = managedInspectionStore.readExpected(path.basename(filePath));
					if (!returnTranscript || !managedFileSnapshotEquals(returnTranscript, publishedTranscript))
						throw new Error("Could not open session: unstable");
					manager.#managedPersistExpectedIdentity = returnTranscript.identity;
					writeTerminalBreadcrumb(manager.cwd, filePath);
					return manager;
				} catch (createError) {
					await manager.#discardRejectedOpenState();
					throw createError;
				} finally {
					managedInspectionStore.close();
				}
			}
			// Cross-directory missing candidates continue through the migration path below.
		}
		const managedResumeBounded =
			managedSourceSize !== undefined &&
			(sessionMemoryMode === "enabled" ||
				(sessionMemoryMode === "auto" &&
					process.platform !== "win32" &&
					managedSourceSize >= autoModeMinTranscriptBytes()));
		let strictManagedSmallInspection: ResumeInspectionSnapshot | undefined;
		if (
			managedResumeBounded &&
			managedSourceSize !== undefined &&
			managedSourceSize <= eagerHydrationMaxBytes() &&
			sameManagedDirectory
		) {
			try {
				const strict = inspectResumeSessionFile(filePath, managedInspectionStorage);
				if ("kind" in strict) throw new Error(`Could not open session: ${strict.reason}`);
				strictManagedSmallInspection = strict;
			} catch (error) {
				managedInspectionStore?.close();
				throw error;
			}
		}
		const managedBoundedDescriptor =
			managedResumeBounded && sameManagedDirectory
				? managedInspectionStore?.descriptorExpected(path.basename(filePath))
				: undefined;
		if (managedResumeBounded && sameManagedDirectory && !managedBoundedDescriptor) {
			managedInspectionStore?.close();
			throw new Error("Could not open session: unstable");
		}

		if (managedResumeBounded && sameManagedDirectory) {
			const manager = new SessionManager(getProjectDir(), destination.directory, true, storage, destination);
			manager.#sessionMemoryMode = sessionMemoryMode;
			try {
				await manager.#initSessionFile(
					filePath,
					true,
					strictManagedSmallInspection
						? { inspection: strictManagedSmallInspection, storage: managedInspectionStorage }
						: undefined,
					true,
					true,
				);
				SessionManagerTestHooks.beforeManagedResumeAcceptance?.(filePath, managedInspectionStorage);
				const terminalManagedDescriptor = managedInspectionStore?.descriptorExpected(path.basename(filePath));
				if (
					!managedBoundedDescriptor ||
					!terminalManagedDescriptor ||
					!sameDescriptor(managedBoundedDescriptor, terminalManagedDescriptor)
				)
					throw new Error("Could not open session: unstable");
				if (strictManagedSmallInspection) {
					if (
						!revalidateStrictResumeInspection(filePath, managedInspectionStorage, strictManagedSmallInspection) ||
						manager.#sessionId !== strictManagedSmallInspection.identity.sessionId
					) {
						manager.setSessionMemoryMode("off");
						throw new Error("Could not open session: unstable");
					}
				}
				if (manager.#sanitizeLoadedOpenAIResponsesReplayMetadata().length > 0)
					manager.#needsFullRewriteOnNextPersist = true;
				SessionManagerTestHooks.beforeManagedResumeReturn?.(filePath, managedInspectionStorage);
				const returnManagedDescriptor = managedInspectionStore?.descriptorExpected(path.basename(filePath));
				if (!returnManagedDescriptor || !sameDescriptor(managedBoundedDescriptor, returnManagedDescriptor))
					throw new Error("Could not open session: unstable");
				manager.#managedPersistExpectedIdentity =
					manager.destination.kind === "managed"
						? manager.#captureManagedPersistIdentity(
								filePath,
								managedIdentityFromDescriptor(managedBoundedDescriptor),
							)
						: undefined;
				const header = manager.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
				if (header?.cwd) manager.cwd = header.cwd;
				manager.buildSessionContext();
				return manager;
			} catch (error) {
				manager.setSessionMemoryMode("off");
				for (const sidecarPath of manager.#disposableSidecarPaths()) {
					if (!sidecarPath) continue;
					try {
						manager.#storage.unlinkSync(sidecarPath);
					} catch (cleanupError) {
						if (!isEnoent(cleanupError))
							logger.warn("Rejected managed resume sidecar cleanup failed", {
								error: toError(cleanupError).message,
							});
					}
				}
				manager.#sidecarRuntime = undefined;
				try {
					await manager.#discardRejectedOpenState();
				} catch (cleanupError) {
					throw new AggregateError(
						[toError(error), toError(cleanupError)],
						"Rejected managed resume cleanup failed",
					);
				}
				throw error;
			} finally {
				managedInspectionStore?.close();
			}
		}
		managedInspectionStore?.close();
		managedInspectionStore = undefined;
		const inspected = inspectResumeSessionFile(filePath, storage);
		if ("kind" in inspected) {
			if (inspected.reason === "missing") {
				const manager = new SessionManager(getProjectDir(), destination.directory, true, storage, destination);
				manager.#sessionMemoryMode = sessionMemoryMode;
				await manager.#initSessionFile(filePath, true);
				return manager;
			}
			if (inspected.reason === "oversized") throw new SessionTranscriptOversizedError(inspected.size ?? 0);
			if (inspected.reason === "context_too_large") throw new SessionContextTooLargeError(inspected.size ?? 0);
			throw new Error(`Could not open session: ${inspected.reason}`);
		}
		const opened = await SessionManager.openExistingStrict(
			inspected.identity,
			destination,
			storage,
			migrationPolicy,
			sessionMemoryMode,
		);
		if (opened.kind === "error") {
			if (opened.reason === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
			if (opened.reason === "artifact_capacity_exceeded")
				throw new SessionArtifactCapacityError(
					opened.message ?? "Session artifacts exceed the migration capacity.",
				);
			if (opened.reason === "oversized") throw new SessionTranscriptOversizedError(opened.size ?? 0);
			if (opened.reason === "context_too_large") throw new SessionContextTooLargeError(opened.size ?? 0);
			if (opened.reason === "migration_busy") throw new SessionMigrationBusyError();
			throw new Error(`Could not open session: ${opened.reason}`);
		}
		return opened.manager;
	}

	static async openNestedManaged(
		filePath: string,
		destination: SessionDestination,
		store: ManagedSessionDescendantStore,
		storage: SessionStorage = new FileSessionStorage(),
		cwdOverride?: string,
		sessionMemoryMode: SessionMemoryMode = "shadow",
	): Promise<SessionManager> {
		if (destination.kind !== "managed" || !trustedSessionDestinations.has(destination))
			throw new Error("Nested managed session authority is unavailable");
		const resolved = path.resolve(filePath);
		if (
			path.dirname(resolved) !== path.resolve(store.dir) ||
			path.dirname(resolved) !== path.resolve(destination.directory)
		)
			throw new Error("Nested managed session escaped retained authority");
		store.assertBound();
		const capturedDescriptor = store.descriptorExpected(path.basename(resolved));
		if (capturedDescriptor && capturedDescriptor.size > BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES)
			throw new SessionTranscriptOversizedError(capturedDescriptor.size);
		const boundedAdmission =
			sessionMemoryMode === "enabled" ||
			(sessionMemoryMode === "auto" &&
				process.platform !== "win32" &&
				capturedDescriptor !== null &&
				capturedDescriptor.size >= autoModeMinTranscriptBytes());
		if (boundedAdmission && capturedDescriptor && capturedDescriptor.size > 0) {
			const boundedManager = new SessionManager(
				cwdOverride ? path.resolve(cwdOverride) : getProjectDir(),
				destination.directory,
				true,
				storage,
				destination,
			);
			boundedManager.#sessionMemoryMode = sessionMemoryMode;
			try {
				const openedFromSidecar = await boundedManager.#tryInitSessionFileFromSidecar(resolved);
				const openedBounded = openedFromSidecar || (await boundedManager.#tryBoundedFirstOpen(resolved));
				if (openedBounded) {
					const header = boundedManager.#fileEntries.find(entry => entry.type === "session") as
						| SessionHeader
						| undefined;
					if (!header) throw new Error("source_changed");
					const sessionCwd = cwdOverride ? path.resolve(cwdOverride) : header.cwd || getProjectDir();
					if (cwdOverride && resolveEquivalentPath(header.cwd) !== resolveEquivalentPath(sessionCwd))
						throw new Error("nested_managed_bounded_rewrite_required");
					boundedManager.cwd = sessionCwd;
					store.assertBound();
					const finalDescriptor = store.descriptorExpected(path.basename(resolved));
					if (!finalDescriptor || !sameDescriptor(capturedDescriptor, finalDescriptor))
						throw new Error("source_changed");
					boundedManager.#managedPersistExpectedIdentity =
						boundedManager.destination.kind === "managed"
							? boundedManager.#captureManagedPersistIdentity(
									resolved,
									managedIdentityFromDescriptor(capturedDescriptor),
								)
							: undefined;
					boundedManager.buildSessionContext();
					return boundedManager;
				}
				if (boundedManager.#lazyReopenFallbackReason === "bounded_first_open_descriptor_changed")
					throw new Error("source_changed");
				await boundedManager.close().catch(() => {});
			} catch (error) {
				await boundedManager.close().catch(() => {});
				if (!(error instanceof Error) || error.message !== "nested_managed_bounded_rewrite_required") throw error;
			}
		}
		if (boundedAdmission && capturedDescriptor) {
			const failedDescriptor = store.descriptorExpected(path.basename(resolved));
			if (!failedDescriptor || !sameDescriptor(capturedDescriptor, failedDescriptor))
				throw new Error("source_changed");
		}
		const captured = store.readExpected(path.basename(resolved));
		if (
			Boolean(captured) !== Boolean(capturedDescriptor) ||
			(captured &&
				capturedDescriptor &&
				(captured.identity.dev !== capturedDescriptor.dev ||
					captured.identity.ino !== capturedDescriptor.ino ||
					captured.identity.nlink !== capturedDescriptor.nlink ||
					captured.identity.size !== capturedDescriptor.size ||
					captured.identity.mtimeNs !== capturedDescriptor.mtimeNs ||
					captured.identity.ctimeNs !== capturedDescriptor.ctimeNs))
		)
			throw new Error("source_changed");
		let entries: FileEntry[] = [];
		let capturedMigrationApplied = false;
		if (captured) {
			try {
				const content = new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes);
				for (const line of content.split(/\r?\n/)) {
					if (line.length > 0) JSON.parse(line);
				}
				entries = parseSessionEntries(content);
				const strictHeader = entries[0] as SessionHeader | undefined;
				if (strictHeader?.type !== "session" || typeof strictHeader.id !== "string") throw new Error("malformed");
				capturedMigrationApplied = migrateToCurrentVersion(entries);
				if (!hasStrictSessionSchema(entries)) throw new Error("malformed");
			} catch {
				throw new Error("Could not open nested managed session: malformed");
			}
		}
		const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const sessionCwd = cwdOverride ? path.resolve(cwdOverride) : (header?.cwd ?? getProjectDir());
		const cwdChanged = Boolean(
			header && cwdOverride && resolveEquivalentPath(header.cwd) !== resolveEquivalentPath(sessionCwd),
		);
		if (header && cwdChanged) header.cwd = sessionCwd;
		const manager = new SessionManager(sessionCwd, destination.directory, true, storage, destination);
		manager.#sessionMemoryMode = sessionMemoryMode;
		try {
			let transcriptChanged = false;
			if (entries.length > 0) {
				const migrationApplied = capturedMigrationApplied || cwdChanged;
				transcriptChanged = migrationApplied;
				await manager.#hydrateExistingSession(resolved, entries, migrationApplied, "memory-fallback");
				if (cwdChanged) {
					await manager.#rewriteFile();
					manager.#flushed = true;
					manager.#ensuredOnDisk = true;
				}
				if (cwdChanged) transcriptChanged = true;
				writeTerminalBreadcrumb(manager.cwd, resolved);
				if (await manager.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist()) transcriptChanged = true;
			} else {
				const fresh = manager.#freshSessionState(undefined, resolved);
				const transition = manager.#prepareFreshSessionTransition(fresh, "memory-fallback");
				manager.#applyFreshSessionMetadata(fresh);
				manager.#commitResidentTextStoreTransition(transition);
				manager.#retireEphemeralArtifacts();
				writeTerminalBreadcrumb(manager.cwd, resolved);
				await manager.#rewriteFile();
				manager.#flushed = true;
				manager.#ensuredOnDisk = true;
				transcriptChanged = true;
			}
			store.assertBound();
			if (!transcriptChanged) {
				const finalDescriptor = store.descriptorExpected(path.basename(resolved));
				if (!capturedDescriptor || !finalDescriptor || !sameDescriptor(capturedDescriptor, finalDescriptor))
					throw new Error("source_changed");
			}
			manager.buildSessionContext();
			return manager;
		} catch (error) {
			await manager.close().catch(() => {});
			throw error;
		}
	}
	/**
	 * List default-managed sessions for the resume picker without recovery or other
	 * maintenance writes. This is the only picker inventory that includes legacy
	 * sibling directories.
	 */
	static async listManagedForResumePickerReadOnly(
		cwd: string,
		managedAgentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		if (!(storage instanceof FileSessionStorage)) return [];
		const sessionsRoot = getSessionsDir(managedAgentDir);
		const resolved = resolveManagedScope({
			cwd,
			agentDir: managedAgentDir ?? path.resolve(sessionsRoot, ".."),
			sessionsRoot,
		});
		if (resolved.kind === "error") return [];
		const listing = listManagedCandidates(resolved.scope);
		if (listing.kind === "error") return [];
		const managed = await collectSessionsFromFiles(
			listing.owned.filter(candidate => !isStagedSessionPath(candidate.path)).map(candidate => candidate.path),
			storage,
		);
		return mergeSessionInventories(managed, await collectProjectSessions(cwd, storage));
	}

	/**
	 * List sessions from an explicitly supplied picker directory without recovery
	 * or other maintenance writes. Unlike managed inventory, this never scans
	 * legacy sibling directories.
	 */
	static async listForResumePickerReadOnly(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		if (!sessionDir) return await SessionManager.listManagedForResumePickerReadOnly(cwd, undefined, storage);
		try {
			return await collectSessionsFromFiles(
				storage.listFilesSync(sessionDir, "*.jsonl").filter(file => !isStagedSessionPath(file)),
				storage,
			);
		} catch {
			return [];
		}
	}

	/** Delete an authorized managed or project-local picker candidate. */
	static async deleteManagedCandidate(sessionPath: string): Promise<void> {
		const storage = new FileSessionStorage();
		const inspected = inspectTranscriptHeaderBounded(sessionPath, storage, BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES);
		if (!inspected.ok || !inspected.inspection.cwd) throw new Error("Session has no valid workspace header.");
		const headerCwd = inspected.inspection.cwd;
		const projectGjcDir = path.join(path.resolve(headerCwd), ".gjc");
		if (isProjectSessionTranscriptPath(projectGjcDir, sessionPath)) {
			const relativePath = path.relative(projectGjcDir, path.resolve(sessionPath)).split(path.sep).join("/");
			const authority = nativeSessionManager().openRecoveryFsRoot(projectGjcDir);
			try {
				const observed = authority.stat(relativePath);
				if (!observed.ok || !observed.identity?.sha256)
					throw new Error("Project session is no longer an authorized candidate.");
				const removed = authority.removeManaged(
					relativePath,
					observed.identity.dev,
					observed.identity.ino,
					observed.identity.size,
					observed.identity.mtimeNs,
					observed.identity.ctimeNs,
					observed.identity.sha256,
				);
				if (!removed.ok) throw new Error(removed.code ?? "Could not delete project session.");
				return;
			} finally {
				authority.close();
			}
		}
		const sessionsRoot = path.resolve(sessionPath, "../..");
		const resolved = resolveManagedScope({
			cwd: headerCwd,
			agentDir: path.resolve(sessionsRoot, ".."),
			sessionsRoot,
		});
		if (resolved.kind === "error") throw new Error(`Could not resolve managed session scope: ${resolved.message}`);
		const listing = listManagedCandidates(resolved.scope);
		if (listing.kind !== "complete") throw new Error("Managed session scan did not grant deletion authority.");
		const candidate = listing.owned.find(item => path.resolve(item.path) === path.resolve(sessionPath));
		if (!candidate) throw new Error("Session is not an authorized managed candidate.");
		const deleted = await deleteManagedSessionCandidate(resolved.scope, candidate);
		if (deleted.kind === "error" && deleted.code === "migration_busy") throw new SessionMigrationBusyError();
		if (deleted.kind !== "deleted" && deleted.kind !== "already_deleted")
			throw new Error(`Could not delete managed session: ${deleted.message}`);
	}

	/** Capture exact source content for a strict fork without granting write ownership. */
	static captureTranscriptStrict(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): StrictSessionCaptureResult {
		const inspected = inspectTranscriptBounded(filePath, storage, BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES);
		if (!inspected.ok) return inspected.error;
		return {
			kind: "captured",
			snapshot: createTranscriptSnapshotHandle(inspected.inspection, path.resolve(filePath), storage),
		};
	}

	/**
	 * Fork strictly from captured source bytes. The source pathname is used only to
	 * revalidate captured authority before destination initialization and transcript
	 * persistence; destination history always comes from the captured bytes.
	 */
	static async forkFromCaptured(
		snapshot: CapturedSessionTranscriptSnapshot,
		cwd: string,
		destinationInput?: SessionDestinationInput,
		_migrationPolicy: SessionDirectoryMigrationPolicy = "copy-retain",
		sessionMemoryMode: SessionMemoryMode = "shadow",
	): Promise<StrictSessionForkResult> {
		const destination = destinationFor(cwd, destinationInput, snapshot.storage);
		if (
			sessionMemoryMode === "enabled" ||
			(sessionMemoryMode === "auto" && snapshot.identity.size > eagerHydrationMaxBytes())
		) {
			const boundedManager = new SessionManager(cwd, destination.directory, true, snapshot.storage, destination);
			boundedManager.#sessionMemoryMode = sessionMemoryMode;
			if (
				destination.kind === "managed" &&
				snapshot.storage instanceof FileSessionStorage &&
				pathIsWithin(path.resolve(destination.securityContext.sessionsRoot), path.resolve(snapshot.sourcePath))
			) {
				const sourceDirectory = path.dirname(path.resolve(snapshot.sourcePath));
				const destinationDirectory = path.resolve(destination.directory);
				const sourceStore =
					sourceDirectory === destinationDirectory
						? boundedManager.#managedTranscriptStore(snapshot.sourcePath)
						: managedStoreFromContext(destination.securityContext, sourceDirectory);
				try {
					sourceStore.assertBound();
					const sourceDescriptor = sourceStore.descriptorExpected(path.basename(snapshot.sourcePath));
					if (!sourceDescriptor || !resumeIdentityMatchesDescriptor(snapshot.identity, sourceDescriptor))
						throw new Error("identity-mismatch");
					boundedManager.#boundedManagedSource = {
						path: snapshot.sourcePath,
						store: sourceStore,
						descriptor: sourceDescriptor,
						owned: sourceDirectory !== destinationDirectory,
					};
				} catch (error) {
					sourceStore.close();
					await boundedManager.close().catch(() => {});
					if (toError(error).message === "identity-mismatch")
						return { kind: "error", reason: "identity-mismatch" };
					throw error;
				}
			}
			let bounded: StrictSessionForkResult | undefined;
			try {
				bounded = await boundedManager.#tryForkFromCapturedBounded(snapshot);
			} catch (error) {
				boundedManager.#clearBoundedManagedSource();
				await boundedManager.close().catch(() => {});
				throw error;
			}
			if (bounded) {
				boundedManager.#clearBoundedManagedSource();
				return bounded;
			}
			await boundedManager.close();
		}
		if (snapshot.identity.size > eagerHydrationMaxBytes())
			return { kind: "error", reason: "oversized", size: snapshot.identity.size };

		// Bounded parse: iterate the captured transcript line-by-line (no
		// whole-file string/Buffer) while re-validating the running content hash
		// against the captured identity.
		let forkEntries: FileEntry[] = [];
		try {
			const directEntries: FileEntry[] = [];
			let patchRecords: Array<FileEntry | SessionPatchRecord> | undefined;
			snapshot.forEachLine(line => {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
				if (text.length === 0) return;
				const record = JSON.parse(text) as FileEntry | SessionPatchRecord;
				if (record.type === "header_patch" || record.type === "entry_patch") {
					patchRecords ??= [...directEntries];
					patchRecords.push(record);
				} else if (patchRecords) {
					patchRecords.push(record);
				} else {
					directEntries.push(record);
				}
			});
			if (patchRecords) {
				forkEntries = buildFileEntriesFromRecords(patchRecords);
				patchRecords.length = 0;
				directEntries.length = 0;
			} else {
				forkEntries = directEntries;
			}
			const sourceHeader = forkEntries[0] as SessionHeader | undefined;
			if (sourceHeader?.type !== "session" || sourceHeader.id !== snapshot.identity.sessionId)
				return { kind: "error", reason: "identity-mismatch" };
			migrateToCurrentVersion(forkEntries);
			if (!hasStrictSessionSchema(forkEntries)) return { kind: "error", reason: "malformed" };
		} catch (error) {
			if (toError(error).message === "identity-mismatch") return { kind: "error", reason: "identity-mismatch" };
			return { kind: "error", reason: "malformed" };
		}

		const revalidated = snapshot.revalidate();
		if (revalidated.kind !== "valid") return revalidated;

		const dir = destination.directory;
		const privateStagingDir =
			destination.kind !== "managed" &&
			snapshot.storage instanceof FileSessionStorage &&
			!snapshot.storage.existsSync(dir)
				? fs.mkdtempSync(path.join(path.dirname(dir), `.${path.basename(dir)}.fork-staging-`))
				: undefined;
		const forkDestination = privateStagingDir ? explicitDestination(privateStagingDir) : destination;
		let managedForkStore: ManagedSessionDescendantStore | undefined;
		let managedForkTranscript: ManagedFileSnapshot | null = null;
		let manager: SessionManager | undefined;
		let authorityFailure: StrictSessionOpenFailure | undefined;
		let privateStagingSnapshot: native.NativeDirectoryTreeSnapshot | undefined;
		let privateStagingPublished = false;

		try {
			manager = new SessionManager(cwd, privateStagingDir ?? dir, true, snapshot.storage, forkDestination);
			manager.#sessionMemoryMode = sessionMemoryMode;
			await resolveBlobRefsInEntries(forkEntries, manager.#blobStore);
			const sourceHeader = forkEntries[0] as SessionHeader | undefined;
			const fresh = manager.#freshSessionState({ parentSession: sourceHeader?.id });
			fresh.header.title = sourceHeader?.title;
			fresh.header.titleSource = sourceHeader?.titleSource;
			forkEntries[0] = fresh.header;
			const transition = manager.#prepareResidentTextStoreTransition(
				{
					target: { sessionId: fresh.sessionId, sessionFile: fresh.sessionFile ?? "" },
					primary: {
						mode: "materialize",
						sourceEntries: forkEntries,
						sourceStores: { textStore: null, imageStore: manager.#residentImageBlobStore },
					},
				},
				"memory-fallback",
			);
			manager.#applyFreshSessionMetadata(fresh);
			manager.#commitResidentTextStoreTransition(transition);
			manager.#retireEphemeralArtifacts();
			manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
			const beforeWrite = snapshot.revalidate();
			if (beforeWrite.kind !== "valid") {
				authorityFailure = beforeWrite;
				throw new Error("Captured fork source authority changed before destination write.");
			}
			const sessionFile = manager.#sessionFile;
			if (!sessionFile) throw new Error("fork_transcript_session_file_unavailable");
			const activeManager = manager;
			// Publish each already-parsed entry through the staged writer without joining
			// another whole-file string/Buffer. The parse/resident graph is still the
			// compatibility path; retired cold history is never omitted.
			publishForkTranscriptStreaming(snapshot.storage, sessionFile, forkDestination, manager.#fileEntries, entry =>
				prepareEntryForPersistenceSync(
					materializeResidentEntryForPersistenceSync(entry, activeManager.#residentBlobStores(), new Map()),
					activeManager.#blobStore,
				),
			);
			if (privateStagingDir) {
				const capturedStaging = nativeSessionManager().snapshotDirectoryTree(privateStagingDir);
				if (!capturedStaging.ok || !capturedStaging.snapshot)
					throw new Error(capturedStaging.code ?? "fork_staging_snapshot_failed");
				privateStagingSnapshot = capturedStaging.snapshot;
			}

			if (destination.kind === "managed" && manager.#sessionFile) {
				managedForkStore = manager.#managedTranscriptStore();
				managedForkTranscript = managedForkStore.readExpected(path.basename(manager.#sessionFile));
				if (!managedForkTranscript) throw new Error("managed_fork_transcript_publish_missing");
			}
			const afterWrite = snapshot.revalidate();
			if (afterWrite.kind !== "valid") {
				authorityFailure = afterWrite;
				throw new Error("Captured fork source authority changed during destination write.");
			}
			if (managedForkStore && managedForkTranscript && manager.#sessionFile) {
				const terminalTranscript = managedForkStore.readExpected(path.basename(manager.#sessionFile));
				if (!managedFileSnapshotEquals(terminalTranscript, managedForkTranscript))
					throw new Error("managed_fork_transcript_changed");
			}
			if (privateStagingDir && manager.#sessionFile) {
				const stagedSessionFile = manager.#sessionFile;
				const finalSessionFile = path.join(dir, path.basename(stagedSessionFile));
				const finalTransition = manager.#prepareResidentTextStoreTransition(
					{
						target: { sessionId: manager.#sessionId, sessionFile: finalSessionFile },
						primary: {
							mode: "materialize",
							sourceEntries: manager.#fileEntries,
							sourceStores: {
								textStore: manager.#residentTextBlobStore,
								imageStore: manager.#residentImageBlobStore,
							},
						},
					},
					"retain-and-throw",
				);
				// The staged store is no longer needed once the final candidate has copied its entries.
				// Dispose it before the staging tree becomes published evidence.
				manager.#disposeResidentTextStore(manager.#residentTextBlobStore);
				try {
					const capturedStaging = nativeSessionManager().snapshotDirectoryTree(privateStagingDir);
					if (!capturedStaging.ok || !capturedStaging.snapshot)
						throw new Error(capturedStaging.code ?? "fork_staging_snapshot_failed");
					privateStagingSnapshot = capturedStaging.snapshot;
					fsyncManagedArtifactTree(privateStagingDir);
					const outcome = classifyNativePublishOutcome(
						nativeSessionManager().renameNoReplacePath(privateStagingDir, dir),
					);
					if (!outcome.ok) {
						if (outcome.code === "quarantine_collision") {
							authorityFailure = { kind: "error", reason: "identity-mismatch" };
							throw new Error("fork_destination_authority_changed");
						}
						if (outcome.code === "destination_identity_changed")
							throw new Error("fork_destination_terminal_identity_changed");
						throw new Error(outcome.code ?? "fork_destination_publish_failed");
					}
					privateStagingPublished = true;
					const terminal = nativeSessionManager().snapshotDirectoryTree(dir);
					if (
						!terminal.ok ||
						!terminal.snapshot ||
						!retainedTreeSnapshotEqualsAfterRename(terminal.snapshot, privateStagingSnapshot)
					)
						throw new Error("fork_destination_terminal_identity_changed");
					await syncSessionMoveDirectory(path.dirname(dir));
					const durableTerminal = nativeSessionManager().snapshotDirectoryTree(dir);
					if (
						!durableTerminal.ok ||
						!durableTerminal.snapshot ||
						!retainedTreeSnapshotEqualsAfterRename(durableTerminal.snapshot, privateStagingSnapshot)
					)
						throw new Error("fork_destination_durability_identity_changed");
					manager.sessionDir = dir;
					manager.destination = destination;
					manager.#sessionFile = finalSessionFile;
					manager.#commitResidentTextStoreTransition(finalTransition);
					manager.#adoptManagedPersistIdentity(finalSessionFile);
				} catch (error) {
					finalTransition.dispose();
					throw error;
				}
			}
			// The transcript was published and verified above. Mark the captured fork as
			// durable before handing it to the lifecycle host; otherwise ensureOnDisk()
			// will attempt a second no-replace publication and fail on the already-live
			// destination. Re-adopt the exact managed identity only after the final
			// destination path is settled.
			manager.#flushed = true;
			manager.#ensuredOnDisk = true;
			manager.#needsFullRewriteOnNextPersist = false;
			if (manager.#sessionFile) manager.#adoptManagedPersistIdentity(manager.#sessionFile);
			const finalSource = snapshot.revalidate();
			if (finalSource.kind !== "valid") {
				authorityFailure = finalSource;
				throw new Error("Captured fork source authority changed after destination publication.");
			}
			if (manager.#effectiveSessionMemoryMode() !== "off" && manager.#sessionFile) {
				const runtime = manager.#sidecarRuntime;
				const transcriptSize = manager.#storage.statSync(manager.#sessionFile).size;
				if (!runtime?.enabled || runtime.tail.transcriptSize !== transcriptSize)
					manager.#buildDisposableSidecars(manager.#fileEntries);
				if (manager.#effectiveSessionMemoryMode() === "enabled") manager.#retireColdEntries();
			}
			if (manager.#sessionFile) writeTerminalBreadcrumb(manager.cwd, manager.#sessionFile);
			return { kind: "forked", manager };
		} catch (error) {
			if (manager) {
				const cleanupErrors: Error[] = [];
				try {
					await manager.close();
				} catch (cleanupError) {
					if (toError(cleanupError).message !== "cleanup_pending") cleanupErrors.push(toError(cleanupError));
				}
				if (!privateStagingPublished && privateStagingDir && privateStagingSnapshot) {
					const removed = nativeSessionManager().exactRemoveDirectoryTree(
						privateStagingDir,
						privateStagingSnapshot,
					);
					if (!removed.ok && removed.code !== "not_found" && removed.code !== "cleanup_pending")
						cleanupErrors.push(new Error(removed.code ?? "fork_staging_cleanup_failed"));
				}
				if (cleanupErrors.length > 0) {
					throw new Error(`Failed to clean up fork destination: ${cleanupErrors[0]!.message}`, {
						cause: toError(error),
					});
				}
				if (authorityFailure) return authorityFailure;
			}
			throw error;
		}
	}

	static async restoreMemoryGuardCheckpoint(input: MemoryGuardRestoreInput): Promise<MemoryGuardRestoreResult> {
		try {
			assertMemoryGuardSessionId(input.checkpoint.session_id);
		} catch {
			return { kind: "blocked", reason: "checkpoint-mismatch" };
		}
		if (!validateMemoryGuardCheckpoint(input.checkpoint)) return { kind: "blocked", reason: "checkpoint-mismatch" };
		if (!memoryGuardParticipantMatchesCheckpoint(input.participant, input.checkpoint)) {
			return { kind: "blocked", reason: "participant-mismatch" };
		}
		const checkpointText = readCheckpointAuthorityFile(
			input.incidentAuthority,
			memoryGuardParticipantRelativePath(input.checkpoint.session_id, "session-manager.json"),
			256 * 1024,
		);
		if (!checkpointText) return { kind: "blocked", reason: "checkpoint-mismatch" };
		const checkpointCanonical = memoryGuardCanonicalJson(input.checkpoint);
		if (decodeCheckpointUtf8(checkpointText) !== checkpointCanonical) {
			return { kind: "blocked", reason: "checkpoint-mismatch" };
		}
		const transcriptBytes = Number(input.checkpoint.transcript.bytes);
		if (!Number.isSafeInteger(transcriptBytes) || transcriptBytes < 0) {
			return { kind: "blocked", reason: "transcript-mismatch" };
		}
		const transcriptData = readCheckpointAuthorityFile(
			input.incidentAuthority,
			input.checkpoint.transcript.relative_path,
			transcriptBytes + 1,
		);
		if (!transcriptData || transcriptData.byteLength !== transcriptBytes) {
			return { kind: "blocked", reason: "transcript-mismatch" };
		}
		if (memoryGuardSha256Hex(transcriptData) !== input.checkpoint.transcript.sha256) {
			return { kind: "blocked", reason: "transcript-mismatch" };
		}
		const transcriptText = decodeCheckpointUtf8(transcriptData);
		if (transcriptText === null) return { kind: "blocked", reason: "transcript-mismatch" };
		let transcriptEntries: FileEntry[];
		try {
			transcriptEntries = parseSessionEntries(transcriptText);
		} catch {
			return { kind: "blocked", reason: "malformed" };
		}
		const transcriptHeader = transcriptEntries[0] as SessionHeader | undefined;
		if (
			transcriptHeader?.type !== "session" ||
			transcriptHeader.id !== input.checkpoint.session_id ||
			(transcriptHeader.title ?? null) !== input.checkpoint.session_name
		) {
			return { kind: "blocked", reason: "transcript-mismatch" };
		}
		const manifestData = readCheckpointAuthorityFile(
			input.incidentAuthority,
			input.checkpoint.blob_authority.manifest_relative_path,
			8 * 1024 * 1024,
		);
		if (!manifestData) return { kind: "blocked", reason: "blob-authority-mismatch" };
		if (memoryGuardSha256Hex(manifestData) !== input.checkpoint.blob_authority.manifest_sha256) {
			return { kind: "blocked", reason: "blob-authority-mismatch" };
		}
		const manifestText = decodeCheckpointUtf8(manifestData);
		if (manifestText === null) return { kind: "blocked", reason: "blob-manifest-mismatch" };
		let blobManifest: unknown;
		try {
			blobManifest = JSON.parse(manifestText);
		} catch {
			return { kind: "blocked", reason: "blob-manifest-mismatch" };
		}
		if (!validateMemoryGuardBlobManifest(blobManifest)) return { kind: "blocked", reason: "blob-manifest-mismatch" };
		if (memoryGuardCanonicalJson(blobManifest) !== manifestText)
			return { kind: "blocked", reason: "blob-manifest-mismatch" };
		if (blobManifest.entries.length > MEMORY_GUARD_CHECKPOINT_BLOB_MAX_ENTRIES)
			return { kind: "blocked", reason: "blob-manifest-mismatch" };
		let checkpointBlobBytes = 0;
		const seenBlobPaths = new Set<string>();
		const checkpointBlobs = new Map<string, Buffer>();
		for (const entry of blobManifest.entries) {
			if (
				entry.relative_path !== entry.sha256 ||
				seenBlobPaths.has(entry.relative_path) ||
				checkpointBlobs.has(entry.sha256)
			)
				return { kind: "blocked", reason: "blob-manifest-mismatch" };
			seenBlobPaths.add(entry.relative_path);
			const blobBytes = Number(entry.bytes);
			if (!Number.isSafeInteger(blobBytes) || blobBytes < 0)
				return { kind: "blocked", reason: "blob-manifest-mismatch" };
			checkpointBlobBytes += blobBytes;
			if (checkpointBlobBytes > MEMORY_GUARD_CHECKPOINT_BLOB_TOTAL_MAX_BYTES)
				return { kind: "blocked", reason: "blob-manifest-mismatch" };
			const blobPath = `${input.checkpoint.blob_authority.root_relative_path}/${entry.relative_path}`;
			const blobData = readCheckpointAuthorityFile(input.incidentAuthority, blobPath, blobBytes + 1);
			if (!blobData || blobData.byteLength !== blobBytes) return { kind: "blocked", reason: "blob-missing" };
			if (memoryGuardSha256Hex(blobData) !== entry.sha256) return { kind: "blocked", reason: "blob-hash-mismatch" };
			checkpointBlobs.set(entry.sha256, Buffer.from(blobData));
		}
		for (const ref of collectCheckpointBlobRefs(transcriptEntries)) {
			const hash = parseBlobRef(ref);
			if (!hash || !checkpointBlobs.has(hash)) return { kind: "blocked", reason: "blob-manifest-mismatch" };
		}
		const storage = new FileSessionStorage();
		let destination: SessionDestination;
		try {
			destination =
				input.destination === undefined
					? explicitDestination(path.join(os.tmpdir(), `gjc-memory-guard-${input.checkpoint.session_id}`))
					: destinationFor(getProjectDir(), input.destination, storage);
		} catch {
			return { kind: "blocked", reason: "destination-unavailable" };
		}
		const transcriptPath = path.join(
			destination.directory,
			`.${input.checkpoint.session_id}.memory-guard.${crypto.randomUUID()}.jsonl`,
		);
		const transcriptName = path.basename(transcriptPath);
		const managedStagingStore =
			destination.kind === "managed"
				? managedStoreFromContext(destination.securityContext, destination.directory)
				: undefined;
		const cleanupTranscript = async (): Promise<void> => {
			if (managedStagingStore) {
				await managedStagingStore.remove(transcriptName);
				return;
			}
			await fs.promises.rm(transcriptPath, { force: true });
		};
		let opened: RecoveryHydrationOpenResult;
		let transcriptIdentity: ResumeSessionIdentity;
		let createdDestination: CreatedDirectoryIdentity | undefined;
		try {
			if (managedStagingStore) await managedStagingStore.publishNoReplace(transcriptName, transcriptData);
			else {
				createdDestination = await ensureOwnerOnlyDirectoryTracked(destination.directory);
				await writeOwnerOnlyFileNoReplace(transcriptPath, transcriptData);
			}
			const captured = SessionManager.captureTranscriptStrict(transcriptPath, storage);
			if (captured.kind !== "captured") {
				await cleanupTranscript();
				await removeCreatedDirectoryIfEmpty(destination.directory, createdDestination);
				return { kind: "blocked", reason: captured.reason };
			}
			transcriptIdentity = captured.snapshot.identity;
			opened = await SessionManager.openExistingForRecoveryHydrationStrict(
				transcriptIdentity,
				input.destination,
				storage,
			);
		} catch {
			await cleanupTranscript();
			await removeCreatedDirectoryIfEmpty(destination.directory, createdDestination);
			return { kind: "blocked", reason: "destination-unavailable" };
		}
		if (opened.kind === "error") {
			await cleanupTranscript();
			await removeCreatedDirectoryIfEmpty(destination.directory, createdDestination);
			return { kind: "blocked", reason: opened.reason };
		}
		if (
			opened.manager.getSessionId() !== input.checkpoint.session_id ||
			(opened.manager.getSessionName() ?? null) !== input.checkpoint.session_name
		) {
			await opened.manager.close();
			await cleanupTranscript();
			await removeCreatedDirectoryIfEmpty(destination.directory, createdDestination);
			return { kind: "blocked", reason: "transcript-mismatch" };
		}
		opened.manager.#stageMemoryGuardCheckpointBlobs(checkpointBlobs);
		opened.manager.#recoveryPromotionTranscriptPath = path.join(
			destination.directory,
			`${new Date().toISOString().replace(/[:.]/g, "-")}_${input.checkpoint.session_id}.jsonl`,
		);
		let cleanupConsumed = false;
		const cleanup = async (): Promise<void> => {
			if (cleanupConsumed) return;
			await opened.manager.close();
			await cleanupTranscript();
			await removeCreatedDirectoryIfEmpty(destination.directory, createdDestination);
			cleanupConsumed = true;
		};
		return {
			kind: "staged",
			manager: opened.manager,
			hydrationContext: opened.context,
			transcriptIdentity,
			cleanup,
		};
	}

	/** Inspect a selected session without acquiring write-capable ownership. */
	static async inspectSessionTailReadOnly(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<ResumeTailInspection> {
		const inspected = inspectResumeSessionFile(filePath, storage);
		if ("kind" in inspected) return inspected;
		return canContinuePersistedHistory(inspected.context.messages)
			? { kind: "resumable", identity: inspected.identity }
			: { kind: "terminal", identity: inspected.identity };
	}

	/**
	 * Hydrate an existing predecessor transcript for recovery without taking any
	 * write-capable action. The caller must retain the returned context and use
	 * the explicit promotion seam only after its ownership-ready fence and writer
	 * lease are durable.
	 */
	static async openExistingForRecoveryHydrationStrict(
		identity: ResumeSessionIdentity,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<RecoveryHydrationOpenResult> {
		const destination =
			destinationInput === undefined
				? explicitDestination(path.dirname(identity.canonicalPath))
				: destinationFor(getProjectDir(), destinationInput, storage);
		const inspected = inspectResumeSessionFile(identity.canonicalPath, storage);
		if ("kind" in inspected) return inspected;
		if (!sameResumeIdentity(identity, inspected.identity)) return { kind: "error", reason: "identity-mismatch" };
		if (inspected.migrationApplied) return { kind: "error", reason: "migration-required" };

		const header = inspected.entries[0] as SessionHeader;
		const manager = new SessionManager(
			header.cwd || getProjectDir(),
			destination.directory,
			true,
			storage,
			destination,
		);
		await manager.#hydrateExistingSession(identity.canonicalPath, inspected.entries, false, "memory-only");
		const revalidated = inspectResumeSessionFile(identity.canonicalPath, storage);
		if ("kind" in revalidated || !sameResumeIdentity(identity, revalidated.identity)) {
			await manager.close();
			return "kind" in revalidated ? revalidated : { kind: "error", reason: "identity-mismatch" };
		}
		const context: RecoveryHydrationContext = Object.freeze({
			identity: Object.freeze({ ...identity }),
		});
		manager.#recoveryHydrationContext = context;
		return { kind: "hydrated", manager, context };
	}

	/**
	 * Allows the normal post-open metadata sanitation only after the caller has
	 * fsynced its external ownership-ready fence and acquired the writer lease.
	 */
	async promoteRecoveryHydrationAfterOwnershipReadyFence(
		context: RecoveryHydrationContext,
		fence: RecoveryHydrationPromotionFence,
	): Promise<void> {
		if (fence.ownershipReady !== true || this.#recoveryHydrationContext !== context) {
			throw new Error("Recovery hydration promotion requires the original ownership-ready context.");
		}
		const inspected = inspectResumeSessionFile(context.identity.canonicalPath, this.#storage);
		if ("kind" in inspected || !sameResumeIdentity(context.identity, inspected.identity)) {
			throw new Error("Recovery transcript authority changed before promotion.");
		}
		if (this.#memoryGuardCheckpointBlobs) {
			for (const blob of this.#memoryGuardCheckpointBlobs.values()) this.#blobStore.putImmutableSync(blob);
			this.#residentImageBlobStore = this.#blobStore;
			this.#memoryGuardCheckpointBlobs = undefined;
		}
		await this.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
		const promotionPath = this.#recoveryPromotionTranscriptPath;
		if (!promotionPath) throw new Error("Recovery transcript promotion path is unavailable.");
		const promotedSource = inspectResumeSessionFile(context.identity.canonicalPath, this.#storage);
		if ("kind" in promotedSource) throw new Error("Recovery transcript became unavailable before publication.");
		const transition = this.#prepareResidentTextStoreTransition(
			{
				target: { sessionId: this.#sessionId, sessionFile: promotionPath },
				primary: {
					mode: "materialize",
					sourceEntries: this.#fileEntries,
					sourceStores: {
						textStore: this.#residentTextBlobStore,
						imageStore: this.#residentImageBlobStore,
					},
				},
			},
			"retain-and-throw",
		);
		try {
			if (this.destination.kind === "managed") {
				const store = this.#managedTranscriptStore();
				const sourceName = path.basename(context.identity.canonicalPath);
				const sourceSnapshot = store.readExpected(sourceName);
				if (!sourceSnapshot) throw new Error("Recovery transcript authority changed before publication.");
				await store.publishNoReplace(path.basename(promotionPath), promotedSource.content);
				store.removeExpected(sourceName, sourceSnapshot);
			} else {
				await writeOwnerOnlyFileNoReplace(promotionPath, promotedSource.content);
				await fs.promises.rm(context.identity.canonicalPath, { force: true });
				await fsyncDirectoryPath(path.dirname(context.identity.canonicalPath));
			}
		} catch (error) {
			transition.dispose();
			this.#sidecarRuntime = undefined;
			this.#releaseManagedSidecarCache();
			this.#boundedReadStorageProxy = undefined;
			this.#clearBoundedManagedSource();
			throw error;
		}
		this.#sessionFile = promotionPath;
		this.#recoveryPromotionTranscriptPath = undefined;
		this.#commitResidentTextStoreTransition(transition);
		this.#adoptManagedPersistIdentity(promotionPath);
		writeTerminalBreadcrumb(this.cwd, promotionPath);
		this.#recoveryHydrationContext = undefined;
	}

	/**
	 * Main startup code MUST retain the consented inspection identity and branch on
	 * the returned discriminant; an error result never creates, rewrites, or adopts
	 * the selected path. Breadcrumb ownership begins only after `kind: "opened"`.
	 */
	static async openExistingStrict(
		identity: ResumeSessionIdentity,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
		migrationPolicy: SessionDirectoryMigrationPolicy = "copy-retain",
		sessionMemoryMode: SessionMemoryMode = "shadow",
	): Promise<StrictSessionOpenResult> {
		const destination =
			destinationInput === undefined
				? explicitDestination(path.dirname(identity.canonicalPath))
				: destinationFor(getProjectDir(), destinationInput, storage);
		let sessionPath = identity.canonicalPath;
		if (destination.kind === "managed" && storage instanceof FileSessionStorage) {
			try {
				sessionPath = await SessionManager.prepareManagedCandidateForWrite(
					sessionPath,
					migrationPolicy,
					destination,
					identity,
				);
			} catch (error) {
				if (error instanceof SessionMigrationPolicyError)
					return { kind: "error", reason: "legacy_migration_disabled" };
				if (error instanceof SessionArtifactCapacityError)
					return { kind: "error", reason: "artifact_capacity_exceeded", message: error.message };
				if (error instanceof SessionMigrationBusyError) return { kind: "error", reason: "migration_busy" };
				if (
					error instanceof Error &&
					(error.message.includes("source_changed") || error.message.includes("changed before migration"))
				)
					return { kind: "error", reason: "identity-mismatch" };
				throw error;
			}
		}
		const inspected = inspectResumeSessionFile(sessionPath, storage);
		if ("kind" in inspected) return inspected;
		if (sessionPath === identity.canonicalPath && !sameResumeIdentity(identity, inspected.identity)) {
			return { kind: "error", reason: "identity-mismatch" };
		}

		const entries = inspected.entries;
		const header = entries[0] as SessionHeader;
		const dir = destination.directory;
		const manager = new SessionManager(header.cwd || getProjectDir(), dir, true, storage, destination);
		manager.#sessionMemoryMode = sessionMemoryMode;
		await manager.#hydrateExistingSession(sessionPath, entries, inspected.migrationApplied);
		manager.#readOnlyResume = true;
		const ownershipInspection = revalidateResumeSessionIdentity(sessionPath, storage, inspected.identity);
		if (ownershipInspection.kind === "error") {
			await manager.close();
			return ownershipInspection;
		}
		try {
			await manager.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
			writeTerminalBreadcrumb(manager.cwd, sessionPath);
		} catch (error) {
			await manager.close();
			throw error;
		}
		return { kind: "opened", manager };
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.gjc/agent/sessions/<encoded-cwd>/).
	 */
	static async continueRecent(
		cwd: string,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
		migrationPolicy: SessionDirectoryMigrationPolicy = "copy-retain",
		sessionMemoryMode: SessionMemoryMode = "shadow",
	): Promise<SessionManager> {
		const destination = destinationFor(cwd, destinationInput, storage);
		const dir = destination.directory;
		const openSelectedStrictly = async (selectedPath: string): Promise<SessionManager | undefined> => {
			let selectedSize: number | undefined;
			try {
				selectedSize = storage.statSync(selectedPath).size;
			} catch {
				// The strict read-only inspection below reports the stable failure.
			}
			let openPath = selectedPath;
			if (
				destination.kind === "managed" &&
				storage instanceof FileSessionStorage &&
				selectedSize !== undefined &&
				selectedSize > eagerHydrationMaxBytes() &&
				path.dirname(path.resolve(selectedPath)) !== path.resolve(destination.directory) &&
				pathIsWithin(path.resolve(destination.securityContext.sessionsRoot), path.resolve(selectedPath))
			) {
				openPath = await SessionManager.prepareManagedCandidateForWrite(selectedPath, migrationPolicy, destination);
			}
			const boundedSelected =
				selectedSize !== undefined &&
				selectedSize > eagerHydrationMaxBytes() &&
				selectedSize <= BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES &&
				(sessionMemoryMode === "enabled" ||
					(sessionMemoryMode === "auto" &&
						process.platform !== "win32" &&
						selectedSize >= autoModeMinTranscriptBytes()));
			if (boundedSelected) {
				const manager = await SessionManager.open(
					openPath,
					destination,
					storage,
					migrationPolicy,
					sessionMemoryMode,
				);
				if (canContinuePersistedHistory(manager.buildSessionContext().messages)) return manager;
				await manager.close();
				return undefined;
			}
			const inspected = await SessionManager.inspectSessionTailReadOnly(openPath, storage);
			if (inspected.kind === "error") {
				if (inspected.reason === "oversized") throw new SessionTranscriptOversizedError(inspected.size ?? 0);
				if (inspected.reason === "context_too_large") throw new SessionContextTooLargeError(inspected.size ?? 0);
				return undefined;
			}
			const opened = await SessionManager.openExistingStrict(
				inspected.identity,
				destination,
				storage,
				migrationPolicy,
				sessionMemoryMode,
			);
			if (opened.kind === "error") {
				if (opened.reason === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
				if (opened.reason === "artifact_capacity_exceeded")
					throw new SessionArtifactCapacityError(
						opened.message ?? "Session artifacts exceed the migration capacity.",
					);
				if (opened.reason === "oversized") throw new SessionTranscriptOversizedError(opened.size ?? 0);
				if (opened.reason === "context_too_large") throw new SessionContextTooLargeError(opened.size ?? 0);
				if (opened.reason === "migration_busy") throw new SessionMigrationBusyError();
				return undefined;
			}
			return opened.manager;
		};
		// Legacy paths are candidates only: the managed scan validates each transcript
		// header cwd before it can affect default resume authority.
		const managedCandidates =
			destination.kind === "explicit"
				? []
				: await SessionManager.listManagedForResumePickerReadOnly(
						cwd,
						destination.securityContext.agentDir,
						storage,
					);

		const terminalSession = await readTerminalBreadcrumb(cwd);
		const terminalSessionIsInExplicitRoot = (() => {
			if (destination.kind === "managed" || !terminalSession) return destination.kind === "managed";
			const canonicalRoot = canonicalizeTrustedPath(destination.directory);
			const canonicalSessionPath = canonicalizeTrustedPath(terminalSession);
			return pathIsWithin(canonicalRoot, canonicalSessionPath);
		})();
		if (terminalSession && terminalSessionIsInExplicitRoot) {
			const opened = await openSelectedStrictly(terminalSession);
			if (opened) return opened;
		}
		for (const candidate of managedCandidates) {
			const opened = await openSelectedStrictly(candidate.path);
			if (opened) return opened;
		}
		const mostRecent = await findMostRecentSession(dir, storage);
		if (mostRecent) {
			const opened = await openSelectedStrictly(mostRecent);
			if (opened) return opened;
		}
		const manager = new SessionManager(cwd, dir, true, storage, destination);
		manager.#initNewSession();
		return manager;
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#initNewSession();
		return manager;
	}

	/**
	 * List all sessions.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.gjc/agent/sessions/<encoded-cwd>/).
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		if (!sessionDir) return await SessionManager.listManagedForResumePickerReadOnly(cwd, undefined, storage);
		try {
			await recoverOrphanedBackups(sessionDir, storage);
			return await collectSessionsFromFiles(storage.listFilesSync(sessionDir, "*.jsonl"), storage);
		} catch {
			return [];
		}
	}

	/**
	 * List all sessions across all project directories.
	 */
	static async listAll(
		storage: SessionStorage = new FileSessionStorage(),
		managedAgentDir?: string,
	): Promise<SessionInfo[]> {
		if (!(storage instanceof FileSessionStorage)) return [];
		const sessionsRoot = getSessionsDir(managedAgentDir);
		try {
			const directories = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
			const seedFiles = directories
				.filter(entry => entry.isDirectory())
				.flatMap(entry => storage.listFilesSync(path.join(sessionsRoot, entry.name), "*.jsonl"));
			const seedSessions = await collectSessionsFromFiles(seedFiles, storage);
			const logicalFiles = new Set<string>();
			for (const cwd of new Set(seedSessions.map(session => session.cwd).filter(Boolean))) {
				const scope = resolveManagedScope({
					cwd,
					agentDir: path.resolve(sessionsRoot, ".."),
					sessionsRoot,
				});
				if (scope.kind !== "resolved") {
					logger.warn("Skipped invalid managed session scope during global listing", { message: scope.message });
					continue;
				}
				const listing = listManagedCandidates(scope.scope);
				if (listing.kind !== "complete") {
					logger.warn("Skipped unreadable managed session scope during global listing", {
						message: listing.message,
					});
					continue;
				}
				if (listing.invalid.length > 0)
					logger.warn("Ignored invalid managed session candidates during global listing", {
						count: listing.invalid.length,
					});
				for (const candidate of listing.owned)
					if (!isStagedSessionPath(candidate.path)) logicalFiles.add(candidate.path);
			}
			return await collectSessionsFromFiles([...logicalFiles], storage);
		} catch {
			return [];
		}
	}
	/**
	 * Strict inventory bound to this manager's captured session authority. Managed
	 * managers include authorized legacy and current candidates; explicit managers
	 * authorize only their exact directory.
	 */
	inventorySessionsStrict(): StrictInventoryResult {
		return SessionManager.inventorySessionsStrict(this.cwd, {
			sessionDir: this.destination.kind === "explicit" ? this.destination.directory : undefined,
			storage: this.#storage,
			destination: this.destination,
		});
	}

	/**
	 * Strict raw scoped inventory for ACP authorization. Enumerates the scoped
	 * session directory without suppressing any root/scan/lstat/read/parse/stat/
	 * header/cwd/containment/identity failure. A failure result carries every
	 * sanitized failure and grants zero authority — it is never reduced to a
	 * partial candidate set. Display/global {@link list} behavior is unaffected.
	 */
	static inventorySessionsStrict(
		cwd: string,
		options?: { sessionDir?: string; storage?: SessionStorage; destination?: SessionDestination },
	): StrictInventoryResult {
		const storage = options?.storage ?? new FileSessionStorage();
		const destination = options?.destination;
		const dir =
			options?.sessionDir ?? destination?.directory ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		if (destination?.kind === "managed") {
			if (!trustedSessionDestinations.has(destination) || !(storage instanceof FileSessionStorage)) {
				return {
					kind: "failure",
					failures: [{ kind: "scan", message: "Managed strict inventory authority is unavailable", path: dir }],
				};
			}
			try {
				const store = managedStoreFromContext(destination.securityContext, destination.directory);
				assertManagedDirectoryRoot(destination.securityContext.rootAuthority);
				store.assertBound();
				const resolved = resolveManagedScope({
					cwd,
					agentDir: destination.securityContext.agentDir,
					sessionsRoot: destination.securityContext.sessionsRoot,
				});
				if (resolved.kind === "error")
					return { kind: "failure", failures: [{ kind: "root", message: resolved.message, path: dir }] };
				const listing = listManagedCandidates(resolved.scope);
				if (listing.kind === "error")
					return { kind: "failure", failures: [{ kind: "scan", message: listing.message, path: dir }] };
				const failures: StrictInventoryFailure[] = [];
				const candidates: StrictInventoryCandidate[] = [];
				for (const managedCandidate of listing.owned) {
					if (isStagedSessionPath(managedCandidate.path)) continue;
					const candidate = inventoryReadCandidate(
						storage,
						managedCandidate.path,
						cwd,
						path.dirname(managedCandidate.path),
					);
					if ("failures" in candidate) failures.push(...candidate.failures);
					else candidates.push(candidate.candidate);
				}
				assertManagedDirectoryRoot(destination.securityContext.rootAuthority);
				store.assertBound();
				return failures.length > 0 ? { kind: "failure", failures } : { kind: "complete", candidates };
			} catch {
				return {
					kind: "failure",
					failures: [{ kind: "root", message: "Managed strict inventory authority changed", path: dir }],
				};
			}
		}
		if (!storage.listFilesStrictSync) {
			return {
				kind: "failure",
				failures: [{ kind: "scan", message: "Strict scoped session scan is unavailable", path: dir }],
			};
		}
		const strictScan = storage.listFilesStrictSync.bind(storage);

		let files: string[];
		try {
			files = strictScan(dir, "*.jsonl");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			// Only a confirmed ENOENT proves the scoped root is genuinely absent,
			// which is a complete (zero-candidate) inventory. Any other root/scan
			// error (EACCES/EIO/EPERM/ENOTDIR/...) is fail-closed: it must never
			// reduce to authoritative absence and grants zero authority. The
			// forgiving existsSync preflight is intentionally absent — fs.existsSync
			// collapses EACCES/EIO/EPERM onto a false return and would let a
			// permission-denied root masquerade as a confirmed-empty directory.
			if (code === "ENOENT") {
				return { kind: "complete", candidates: [] };
			}
			void err;
			const failureKind: StrictInventoryFailureKind =
				code === "EACCES" || code === "EPERM" || code === "ENOTDIR" ? "root" : "scan";
			return {
				kind: "failure",
				failures: [
					{
						kind: failureKind,
						message:
							failureKind === "root"
								? "Scoped session root could not be inspected"
								: "Scoped session directory scan failed",
						path: dir,
					},
				],
			};
		}

		const failures: StrictInventoryFailure[] = [];
		const candidates: StrictInventoryCandidate[] = [];
		for (const file of files) {
			const candidate = inventoryReadCandidate(storage, file, cwd, dir);
			if ("failures" in candidate) {
				failures.push(...candidate.failures);
				continue;
			}
			candidates.push(candidate.candidate);
		}
		if (failures.length > 0) {
			return { kind: "failure", failures };
		}
		return { kind: "complete", candidates };
	}

	/**
	 * Propagate the storage-layer verified hard delete bound to exact identity evidence.
	 * Never performs ID lookup or first-match selection; the caller supplies the exact
	 * authorization target captured from a complete strict inventory.
	 */
	async deleteSessionVerified(target: VerifiedSessionDeleteTarget): Promise<VerifiedSessionDeleteResult> {
		if (!this.#storage.deleteSessionVerified) {
			throw new Error("Storage backend does not support verified session deletion");
		}
		return this.#storage.deleteSessionVerified(target);
	}
}
const strictInventoryDecoder = new TextDecoder("utf-8", { fatal: false });

/** Strictly read + validate one scoped session candidate. Never suppresses a failure. */
function inventoryReadCandidate(
	storage: SessionStorage,
	file: string,
	expectedCwd: string,
	sessionDir: string,
): { candidate: StrictInventoryCandidate } | { failures: StrictInventoryFailure[] } {
	const failures: StrictInventoryFailure[] = [];
	const resolvedFile = path.resolve(file);
	if (!pathIsWithin(path.resolve(sessionDir), resolvedFile)) {
		return {
			failures: [{ kind: "containment", message: "Candidate is outside the scoped session directory", path: file }],
		};
	}
	if (!storage.readSnapshotSync) {
		return { failures: [{ kind: "read", message: "Storage backend cannot read exact bytes", path: file }] };
	}
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = storage.readSnapshotSync(file);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ELOOP" || code === "SYMLINK") {
			failures.push({ kind: "lstat", message: "Candidate is a symlink", path: file });
		} else {
			failures.push({ kind: "read", message: "Candidate could not be read", path: file });
		}
		return { failures };
	}
	if (!snapshot.stat.isFile) {
		failures.push({ kind: "lstat", message: "Candidate is not a regular file", path: file });
		return { failures };
	}
	const newline = snapshot.bytes.indexOf(0x0a);
	const headerBytes = newline === -1 ? snapshot.bytes : snapshot.bytes.subarray(0, newline);
	let header: Record<string, unknown> | undefined;
	try {
		const text = strictInventoryDecoder.decode(headerBytes).trim();
		const value: unknown = text ? JSON.parse(text) : undefined;
		header = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		header = undefined;
	}
	if (!header) {
		failures.push({ kind: "parse", message: "Candidate header is not valid JSON", path: file });
		return { failures };
	}
	if (header.type !== "session") {
		failures.push({ kind: "header", message: "Candidate header is not a session header", path: file });
		return { failures };
	}
	if (typeof header.id !== "string" || header.id.length === 0) {
		failures.push({ kind: "identity", message: "Candidate header is missing a session id", path: file });
		return { failures };
	}
	if (typeof header.cwd !== "string") {
		failures.push({ kind: "cwd", message: "Candidate header is missing a cwd", path: file });
		return { failures };
	}
	const canonicalHeaderCwd = resolveEquivalentPath(header.cwd);
	if (canonicalHeaderCwd !== resolveEquivalentPath(expectedCwd)) {
		failures.push({ kind: "cwd", message: "Candidate cwd does not match the scoped workspace", path: file });
		return { failures };
	}
	return { candidate: { path: resolvedFile, id: header.id, cwd: header.cwd, identity: snapshot.stat } };
}
