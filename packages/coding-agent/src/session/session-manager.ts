import * as crypto from "node:crypto";
import * as fs from "node:fs";

import * as os from "node:os";
import * as path from "node:path";

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
import type * as native from "@gajae-code/natives";

function nativeSessionManager(): typeof import("@gajae-code/natives") {
	return require("@gajae-code/natives") as typeof import("@gajae-code/natives");
}

import { getTerminalId } from "@gajae-code/tui";
import {
	getAgentDir,
	getBlobsDir,
	getProjectDir,
	getResidentCacheRootDir,
	getSessionsDir,
	getTerminalSessionsDir,
	hasFsCode,
	isEnoent,
	logger,
	parseJsonlLenient,
	pathIsWithin,
	resolveEquivalentPath,
	Snowflake,
	toError,
} from "@gajae-code/utils";
import type { TtsrInjectionRecord } from "../export/ttsr";
import { assertSafePathComponent } from "../gjc-runtime/session-layout";
import { writeTextAtomic } from "../gjc-runtime/state-writer";
import type { ManagedLegacyLocalMigrationSource } from "../internal-urls/local-protocol";
import * as git from "../utils/git";
import { ArtifactManager } from "./artifacts";
import {
	type BlobPutResult,
	BlobStore,
	EphemeralBlobStore,
	externalizeImageData,
	externalizeImageDataSync,
	externalizeImageDataUrl,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
	MemoryBlobStore,
	openVerifiedResidentCacheInstanceDir,
	parseBlobRef,
	ResidentBlobMissingError,
	ResidentCacheTrustError,
	resolveResidentImageDataSync,
	resolveResidentImageDataUrlSync,
	resolveTextBlobSync,
} from "./blob-store";
import {
	canonicalizeTrustedPath,
	deleteManagedSessionCandidate,
	listManagedCandidates,
	type ManagedCandidateWriteAuthority,
	type ManagedMigrationPolicy,
	type ManagedOpenCandidateResult,
	type ManagedScope,
	managedDirectoryAuthorityForScope,
	managedRootForScope,
	openManagedCandidateForWrite,
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
	resolveManagedScopeForWrite,
} from "./internal/managed-session-scope";
import {
	assertManagedDirectoryRoot,
	captureManagedFileNoFollow,
	fsyncManagedArtifactTree,
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	type ManagedDirectoryRoot,
	type ManagedFileSnapshot,
	ManagedSessionDescendantStore,
	type ManagedSessionSecurityPolicy,
	mayCleanManagedTreeStaging,
	retainManagedDirectoryAuthority,
} from "./internal/managed-session-storage";
import { classifyNativePublishOutcome, formatNativePublishDiagnostic } from "./internal/native-publish-outcome";
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
import type {
	ManagedSessionSecurityContext,
	SessionStorage,
	SessionStorageSnapshot,
	SessionStorageStat,
	SessionStorageWriter,
	SessionStorageWriterCloseState,
	VerifiedSessionDeleteResult,
	VerifiedSessionDeleteTarget,
} from "./session-storage";
import { createManagedSessionSecurityContext, FileSessionStorage, MemorySessionStorage } from "./session-storage";

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

type ResidentTransitionSource =
	| {
			mode: "materialize";
			sourceEntries: FileEntry[];
			sourceStores: {
				textStore: BlobStore | null;
				imageStore: BlobStore;
				textFallback?: (hash: string) => Buffer | null;
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

	constructor(
		readonly entries: FileEntry[],
		readonly store: BlobStore,
		readonly index: PreparedSessionIndex,
		private readonly ownsStore: boolean,
	) {}

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

type ResidentCacheDegradedStore = BlobStore & { degradedReason?: string };

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
	publicMaterializerCallCount: number;
	getEntryMaterializerCallCount: number;
	getBranchMaterializerCallCount: number;
	getEntriesMaterializerCallCount: number;
	materializedEntriesCachePopulateCount: number;
	materializedCacheDemotedCount: number;
	pathOnlyContextBuildCount: number;
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
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format */
	model: string;
	/** Role: "default" or an agent role. Undefined treated as "default" */
	role?: string;
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

export type DefaultModelSelectionStage = {
	readonly entryRevision: number;
	readonly headerExportRevision: number;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entries: readonly FileEntry[];
	readonly tempPath: string | undefined;
	readonly persistsToExistingFile: boolean;
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

const MEMORY_GUARD_CHECKPOINT_FILE_MAX_BYTES = 64 * 1024 * 1024;
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
	reason: "missing" | "malformed" | "unstable" | "read-failed" | "legacy_migration_disabled" | "oversized";
	size?: number;
}

export type SessionDirectoryMigrationPolicy = ManagedMigrationPolicy;
export type SessionAppendPersistenceFailurePhase = "current_append" | "prior_failure";

/**
 * Safety bound for resuming a single transcript file. Matches the managed-storage
 * per-file artifact limit (`MANAGED_ARTIFACT_MAX_FILE_BYTES`): transcripts at or above
 * this size are not loaded into memory wholesale because the decode + per-line JSON
 * parse + identity hash would OOM or stall the process (#3851). The bound is a
 * load-time guard only; it does not raise the on-disk managed-storage limit.
 */
export const RESUME_TRANSCRIPT_MAX_BYTES = MANAGED_ARTIFACT_MAX_FILE_BYTES;

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

/** Exact transcript bytes and authority captured from one descriptor-bound read. */
export interface CapturedSessionTranscriptSnapshot {
	sourcePath: string;
	identity: ResumeSessionIdentity;
	content: Uint8Array;
	storage: SessionStorage;
}

export type StrictSessionCaptureResult =
	| { kind: "captured"; snapshot: CapturedSessionTranscriptSnapshot }
	| ResumeTailError;

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
	return Snowflake.next(); // fallback to full snowflake id
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
	const rawHeader = records.find((record): record is SessionHeader => record.type === "session");
	if (!isSupportedSessionVersion(rawHeader?.version)) {
		throw new Error(`Unsupported session version: ${String(rawHeader?.version)}`);
	}
	const entries: FileEntry[] = [];
	const entriesById = new Map<string, SessionEntry>();
	let header: SessionHeader | undefined;

	for (const record of records) {
		// Patch records are valid in v4 and v5 only. Ignore patches before a valid
		// header so malformed prefixes cannot affect later records.
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
	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
		} else if (entry.type === "model_change") {
			// New format: { model: "provider/id", role?: string }
			if (entry.model) {
				const role = entry.role ?? "default";
				models[role] = entry.model;
				if (role === "default") {
					hasExplicitDefaultModel = true;
				}
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

	return {
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
	};
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
			/** Bytes successfully installed by no-replace publication. */
			readonly publishedBytes: Buffer;
			/** Absent only while post-publication identity capture is failing. */
			readonly snapshot?: ManagedFileSnapshot;
	  }
	| {
			readonly kind: "explicit-file";
			readonly sessionFile: string;
			/** Bytes successfully installed by no-replace publication. */
			readonly publishedBytes: Buffer;
			/** Absent only while post-publication identity capture is failing. */
			readonly snapshot?: ManagedFileSnapshot;
	  }
	| {
			readonly kind: "explicit-storage";
			readonly sessionFile: string;
			/** Bytes successfully installed by transcript publication. */
			readonly publishedBytes: Buffer;
			/** Absent only while post-publication identity capture is failing. */
			readonly snapshot?: SessionStorageSnapshot;
	  };

function pruneResidentCacheEntries(snapshot: native.NativeDirectoryTreeSnapshot): native.NativeDirectoryTreeSnapshot {
	return {
		...snapshot,
		entries: snapshot.entries.filter(
			entry => entry.relativePath !== "resident-cache" && !entry.relativePath.startsWith("resident-cache/"),
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
				candidate => path.basename(candidate.path) === path.basename(sessionFile),
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
		const exact = listing.owned.find(candidate => path.resolve(candidate.path) === path.resolve(sessionFile));
		if (exact) return exact.path;
		const byIdentity = listing.owned.find(candidate => candidate.sessionId === header.id);
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

function sameSessionStorageSnapshot(left: SessionStorageSnapshot, right: SessionStorageSnapshot): boolean {
	return sameResumeStat(left.stat, right.stat) && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
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

function hasStrictSessionSchema(entries: FileEntry[]): boolean {
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
	} catch {
		return { kind: "error", reason: "malformed" };
	}
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
							for (const patch of await readSessionListTrailingPatches(candidate.path, storage, buffer)) {
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
			} else {
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
			const hash = parseBlobRef(value.ref);
			if (hash === null) throw new Error("Staged resident entry has an invalid blob reference.");
			const store = value.kind === "text" ? stores.textStore : stores.imageStore;
			if (store.getSync(hash) === null) {
				throw new ResidentBlobMissingError(hash, value.kind, stores.sessionId, stores.sessionFile);
			}
			return;
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
		throw new ResidentBlobMissingError(
			value.ref,
			value.kind,
			promotion.stores.sessionId,
			promotion.stores.sessionFile,
		);
	const store = value.kind === "text" ? promotion.stores.textStore : promotion.stores.imageStore;
	const data = store.getSync(hash);
	if (!data)
		throw new ResidentBlobMissingError(hash, value.kind, promotion.stores.sessionId, promotion.stores.sessionFile);
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

function rehydrateColdSpillEntry(
	entry: SessionEntry,
	blobStore: BlobStore,
	residentStores?: ResidentBlobStores,
): SessionEntry {
	if (entry.type === "message") {
		const marker = entry.evictedContent;
		const message = rehydrateColdSpillValue(
			entry.message,
			marker,
			blobStore,
			"message",
			residentStores,
		) as AgentMessage;
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
	return truncateForPersistence(entry, blobStore);
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
	return truncateForPersistenceSync(entry, blobStore) as FileEntry;
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
	const relative = path.relative(projectGjcDir, filePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	const segments = relative.split(path.sep);
	if (segments.length === 1) return true;
	const parent = segments.at(-2);
	return parent === "agent-session" || segments.includes("sessions");
}

/**
 * Discover resumable transcripts intentionally stored inside a project's `.gjc`.
 * Runtime token/audit JSONL files are excluded by requiring a known transcript
 * container (`agent-session` or `sessions`).
 */
function listProjectSessionTranscriptFiles(cwd: string): string[] {
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
const SESSION_LIST_TRAILING_PATCH_BYTES = 4096;
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
	buffer: Buffer,
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
	let trailingFragment = Buffer.alloc(0);
	const chunkSize = Math.min(buffer.byteLength, SESSION_LIST_TRAILING_PATCH_BYTES);
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
			for (const patch of await readSessionListTrailingPatches(file, storage, buffer)) {
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
	flushed: boolean;
	ensuredOnDisk: boolean;
	needsFullRewriteOnNextPersist: boolean;
	fileEntries: FileEntry[];
	materializedFileEntries: FileEntry[];
	adoptedArtifactManager: ArtifactManager | null;
}

/** Benchmark-derived cap for strong materialized session snapshots. */
export const MATERIALIZED_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Test-only cache retention and transition seams; these are intentionally not user settings. */
export const SessionManagerTestHooks: {
	materializedCacheMaxBytesOverride?: number;
	beforeResidentTransitionIndexBuild?: () => void;
	afterForkSnapshot?: () => void | Promise<void>;
	beforeEphemeralArtifactManagerInstall?: (dir: string) => void | Promise<void>;
} = {};

function materializedCacheMaxBytes(): number {
	const override = SessionManagerTestHooks.materializedCacheMaxBytesOverride;
	if (override === undefined) return MATERIALIZED_CACHE_MAX_BYTES;
	if (!Number.isSafeInteger(override) || override < 0)
		throw new RangeError("materializedCacheMaxBytesOverride must be a non-negative safe integer.");
	return override;
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
	/** Failed staged persistence retains its exact writer and temporary pathname for retryable cleanup. */
	#preparedNewSessionCleanupInProgress = false;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#managedTranscriptStoreCache: { directory: string; store: ManagedSessionDescendantStore } | null = null;
	#ownedManagedAuthority: ManagedSessionDescendantStore | undefined;
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
	#materializedEntriesRevision = -1;
	#materializedEntriesCache: MaterializedCacheReference<SessionEntry[]> | undefined;
	#sessionContextCache: MaterializedCacheReference<SessionContext> | undefined;
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

	private constructor(
		private cwd: string,
		private sessionDir: string,
		private readonly persist: boolean,
		private readonly storage: SessionStorage,
		private destination: SessionDestination = explicitDestination(sessionDir),
	) {
		this.#blobStore = persist ? new BlobStore(getBlobsDir()) : this.#residentTextBlobStore;
		this.#residentImageBlobStore = this.#blobStore;
		if (persist && sessionDir) {
			this.storage.ensureDirSync(sessionDir);
			// Canonicalize the trusted session directory (single choke point for every
			// creation path: create/open/moveTo/fork/SDK) so benign ancestor symlinks
			// (e.g. macOS `/var -> /private/var`, a symlinked `$HOME`) are resolved to a
			// symlink-free root before the strict owner-only and reparse guards run.
			if (this.storage instanceof FileSessionStorage) {
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
		if (!this.#sessionFile || !(this.storage instanceof FileSessionStorage)) return undefined;
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
		if (!this.persist || !target.sessionFile || !(this.storage instanceof FileSessionStorage)) {
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
			const snapshot = publication.snapshot ?? publication.store.readExpected(publication.relativePath);
			if (!snapshot) return;
			if (!snapshot.bytes.equals(publication.publishedBytes)) throw new Error("fork_transcript_changed");
			publication.store.removeExpected(publication.relativePath, snapshot);
			return;
		}
		if (publication.kind === "explicit-storage") {
			if (publication.snapshot) {
				const current = this.storage.readSnapshotSync?.(publication.sessionFile);
				if (
					!current ||
					!sameSessionStorageSnapshot(current, publication.snapshot) ||
					!Buffer.from(current.bytes).equals(publication.publishedBytes)
				) {
					throw new Error("fork_transcript_changed");
				}
			} else {
				if (!this.storage.existsSync(publication.sessionFile)) return;
				const current = Buffer.from(this.storage.readTextSync(publication.sessionFile), "utf8");
				if (!current.equals(publication.publishedBytes)) throw new Error("fork_transcript_changed");
			}
			await this.storage.unlink(publication.sessionFile);
			return;
		}
		let snapshot = publication.snapshot;
		if (!snapshot) {
			try {
				snapshot = captureManagedFileNoFollow(publication.sessionFile);
			} catch (error) {
				if (isEnoent(error)) return;
				throw error;
			}
		}
		if (!snapshot.bytes.equals(publication.publishedBytes)) throw new Error("fork_transcript_changed");
		const removed = nativeSessionManager().exactUnlink(publication.sessionFile, {
			dev: snapshot.identity.dev,
			ino: snapshot.identity.ino,
			size: BigInt(snapshot.identity.size),
			mtimeNs: snapshot.identity.mtimeNs,
			sha256: snapshot.identity.sha256,
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

	#commitResidentTextStoreTransition(prepared: PreparedResidentStoreTransition): void {
		const predecessor = this.#residentTextBlobStore;
		this.#fileEntries = prepared.entries;
		this.#residentTextBlobStore = prepared.store;
		this.#byId = prepared.index.byId;
		this.#labelsById = prepared.index.labelsById;
		this.#leafId = prepared.index.leafId;
		this.#usageStatistics = prepared.index.usageStatistics;
		this.#bumpAllRevisions();
		prepared.adopt();
		if (predecessor !== prepared.store) this.#disposeResidentTextStore(predecessor);
	}

	#releaseResidentTextStore(): void {
		const predecessor = this.#residentTextBlobStore;
		this.#residentTextBlobStore = new MemoryBlobStore();
		this.#resetMaterializedCaches();
		this.#disposeResidentTextStore(predecessor);
	}

	#demoteResidentTextStoreAfterTrustReject(error: ResidentCacheTrustError): void {
		const predecessor = this.#residentTextBlobStore;
		(predecessor as ResidentCacheDegradedStore).degradedReason = error.reason;
		this.#residentCacheTrustRejectCount++;
		logger.warn("Resident cache trust rejection; demoting resident text store", {
			sessionId: this.#sessionId,
			sessionFile: this.#sessionFile,
			reason: error.reason,
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
					},
				},
			},
			"memory-only",
		);
		(prepared.store as ResidentCacheDegradedStore).degradedReason = error.reason;
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

	captureState(): SessionManagerStateSnapshot {
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

	/** Initialize with a specific session file (used by factory methods). */
	async #initSessionFile(sessionFile: string): Promise<void> {
		const resolvedSessionFile = this.storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
		const entries = await loadEntriesFromFile(resolvedSessionFile, this.storage);
		if (entries.length === 0) {
			const fresh = this.#freshSessionState(undefined, resolvedSessionFile);
			const prepared = this.#prepareFreshSessionTransition(fresh, "memory-fallback");
			this.#applyFreshSessionMetadata(fresh);
			this.#commitResidentTextStoreTransition(prepared);
			this.#retireEphemeralArtifacts();
			writeTerminalBreadcrumb(this.cwd, resolvedSessionFile);
			await this.#rewriteFile();
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			return;
		}
		const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const sessionId = header?.id ?? createSessionId();
		const migrationApplied = migrateToCurrentVersion(entries);
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
		writeTerminalBreadcrumb(this.cwd, resolvedSessionFile);
		this.#flushed = true;
		this.#ensuredOnDisk = true;
		await this.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
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
		const resolvedSessionFile = this.storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
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
	}

	/** Initialize with a new session (used by factory methods). */
	#initNewSession(): void {
		this.#newSessionSync();
	}

	/** Switch to a different session file (used for resume and branching). */
	async setSessionFile(sessionFile: string, options?: { deferEphemeralArtifactRetirement?: boolean }): Promise<void> {
		this.#assertRecoveryHydrationWritable();
		const resolvedSessionFile = this.storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
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
				const inspected = inspectResumeSessionFile(resolvedSessionFile, this.storage);
				if ("kind" in inspected || !sameResumeIdentity(strictAdoption.identity, inspected.identity))
					throw new Error("Prepared session changed before strict adoption.");
			}
			let entries: FileEntry[];
			let candidateMigrationApplied = false;
			if (strictAdoption?.inspection && resolvedSessionFile === strictAdoption.canonicalPath) {
				entries = strictAdoption.inspection.entries;
				candidateMigrationApplied = strictAdoption.inspection.migrationApplied;
			} else if (this.storage.existsSync(resolvedSessionFile)) {
				const inspected = inspectResumeSessionFile(resolvedSessionFile, this.storage);
				if ("kind" in inspected) throw new Error(`Could not switch session: ${inspected.reason}`);
				entries = inspected.entries;
				candidateMigrationApplied = inspected.migrationApplied;
			} else {
				entries = await loadEntriesFromFile(resolvedSessionFile, this.storage);
			}
			if (strictAdoption) {
				const inspected = inspectResumeSessionFile(resolvedSessionFile, this.storage);
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
					const inspected = inspectResumeSessionFile(resolvedSessionFile, this.storage);
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
					this.#commitResidentTextStoreTransition(prepared);
				} catch (error) {
					managedTransition?.rollback();
					this.#sessionId = previous.sessionId;
					this.#sessionName = previous.sessionName;
					this.#titleSource = previous.titleSource;
					this.#sessionFile = previous.sessionFile;
					this.#needsFullRewriteOnNextPersist = previous.needsFullRewriteOnNextPersist;
					prepared.dispose();
					throw error;
				}
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
			await this.#managedTranscriptStore(stage.sessionFile).replace(path.basename(stage.sessionFile), bytes);
		} else {
			const staleCleanupError = await this.#cleanupPreparedNewSessionPersistence(stage);
			if (staleCleanupError) throw staleCleanupError;
			const dir = path.resolve(stage.sessionFile, "..");
			const tempPath = path.join(dir, `.${path.basename(stage.sessionFile)}.${Snowflake.next()}.tmp`);
			const writer = new NdjsonFileWriter(this.storage, tempPath, { flags: "w" });
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
				this.storage.writeTextSync(sessionFile, content);
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
					this.storage.writeTextSync(sessionFile, content);
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

		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#commitResidentTextStoreTransition(transition);
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
				await this.storage.unlink(stage.persistenceTempPath);
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
				await this.storage.deleteSessionWithArtifacts(sessionPath);
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
			await this.storage.deleteSessionWithArtifacts(canonicalCandidate);
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
			const content = `${entries.map(entry => JSON.stringify(prepareEntryForPersistenceSync(entry, this.#blobStore))).join("\n")}\n`;
			const contentBytes = Buffer.from(content, "utf8");
			if (this.destination.kind === "managed") {
				const store = this.#managedTranscriptStore(newSessionFile);
				const relativePath = path.basename(newSessionFile);
				await store.publishNoReplace(relativePath, contentBytes);
				const publication = { kind: "managed" as const, store, relativePath, publishedBytes: contentBytes };
				forkTranscriptPublication = publication;
				const snapshot = store.readExpected(relativePath);
				if (!snapshot) throw new Error("managed_fork_transcript_publish_missing");
				forkTranscriptPublication = { ...publication, snapshot };
			} else if (this.storage instanceof FileSessionStorage) {
				await writeOwnerOnlyFileNoReplace(newSessionFile, content);
				const publication = {
					kind: "explicit-file" as const,
					sessionFile: newSessionFile,
					publishedBytes: contentBytes,
				};
				forkTranscriptPublication = publication;
				forkTranscriptPublication = { ...publication, snapshot: captureManagedFileNoFollow(newSessionFile) };
			} else {
				if (this.storage.existsSync(newSessionFile)) throw new Error("destination_conflict");
				await this.storage.writeText(newSessionFile, content);
				const publication = {
					kind: "explicit-storage" as const,
					sessionFile: newSessionFile,
					publishedBytes: contentBytes,
				};
				forkTranscriptPublication = publication;
				const snapshot = this.storage.readSnapshotSync?.(newSessionFile);
				if (!snapshot) throw new Error("fork_transcript_identity_unavailable");
				forkTranscriptPublication = { ...publication, snapshot };
			}
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
				const snapshot = forkTranscriptPublication.snapshot;
				const terminalTranscript = forkTranscriptPublication.store.readExpected(
					forkTranscriptPublication.relativePath,
				);
				if (
					!snapshot?.bytes.equals(forkTranscriptPublication.publishedBytes) ||
					!managedFileSnapshotEquals(terminalTranscript, snapshot ?? null)
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
						return relativePath !== "resident-cache" && !relativePath.startsWith(`resident-cache${path.sep}`);
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
				if (cleanupMessage !== "cleanup_pending") {
					throw new Error(`Failed to clean up managed fork artifacts: ${cleanupMessage}`, {
						cause: toError(error),
					});
				}
			}
			throw error;
		}
	}

	/**
	 * Move the session to a new working directory.
	 * Moves session files and artifacts on disk, updates all internal references,
	 * and rewrites the session header with the new cwd.
	 */
	async moveTo(newCwd: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		if (resolvedCwd === this.cwd) return;
		const previousCwd = this.cwd;
		const previousSessionDir = this.sessionDir;
		const previousSessionFile = this.#sessionFile;
		const previousDestination = this.destination;

		const nextDestination =
			this.storage instanceof FileSessionStorage
				? managedDestination(
						resolvedCwd,
						this.storage,
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
			hadSessionFile = managedMove ? false : this.storage.existsSync(oldSessionFile);
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
		this.cwd = resolvedCwd;
		this.sessionDir = newSessionDir;
		this.destination = nextDestination;
		this.#managedTranscriptStoreCache =
			managedMove && managedDestinationStore
				? { directory: path.resolve(newSessionDir), store: managedDestinationStore }
				: null;

		const hasAssistant = this.#fileEntries.some(e => e.type === "message" && e.message.role === "assistant");
		try {
			if (this.persist && this.#sessionFile && hadSessionFile) {
				await this.#appendHeaderPatch({ cwd: resolvedCwd });
				await this.#rewriteFile();
			} else if (this.persist && this.#sessionFile && hasAssistant) {
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
		this.#persistWriter = new NdjsonFileWriter(this.storage, this.#sessionFile, {
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
			this.storage.renameSync(targetPath, backupPath);
		} catch (err) {
			if (isEnoent(err)) {
				this.storage.renameSync(tempPath, targetPath);
				return { kind: "replaced" };
			}
			throw toError(renameError);
		}

		try {
			this.storage.renameSync(tempPath, targetPath);
		} catch (err) {
			const replaceError = toError(err);
			const originalError = toError(renameError);
			try {
				this.storage.renameSync(backupPath, targetPath);
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
			this.storage.unlinkSync(backupPath);
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
			await this.storage.rename(targetPath, backupPath);
		} catch (err) {
			if (isEnoent(err)) {
				await this.storage.rename(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}

		try {
			await this.storage.rename(tempPath, targetPath);
		} catch (err) {
			const replaceError = toError(err);
			const originalError = toError(renameError);
			try {
				await this.storage.rename(backupPath, targetPath);
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
			await this.storage.unlink(backupPath);
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
			await this.storage.rename(tempPath, targetPath);
		} catch (err) {
			if (!hasFsCode(err, "EPERM")) throw toError(err);
			await this.#replaceSessionFileAfterEperm(tempPath, targetPath, err);
		}
	}

	#replaceSessionFileSync(tempPath: string, targetPath: string): SessionFileReplacementSyncOutcome {
		try {
			this.storage.renameSync(tempPath, targetPath);
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

	#writeEntriesAtomicallySync(entries: FileEntry[]): void {
		if (!this.#sessionFile) return;
		if (this.destination.kind === "managed") {
			const bytes = Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
			this.#managedTranscriptStore().replaceSync(path.basename(this.#sessionFile), bytes);
			return;
		}
		const dir = path.resolve(this.#sessionFile, "..");
		const tempPath = path.join(dir, `.${path.basename(this.#sessionFile)}.${Snowflake.next()}.tmp`);
		const writer = new NdjsonFileWriter(this.storage, tempPath, { flags: "w" });
		try {
			for (const entry of entries) {
				writer.writeSync(entry);
			}
			writer.closeSync();
			const replacement = this.#replaceSessionFileSync(tempPath, this.#sessionFile);
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
			void this.storage.unlink(tempPath).catch(() => {});
			throw toError(err);
		}
	}
	async #writeEntriesAtomically(entries: FileEntry[]): Promise<void> {
		if (!this.#sessionFile) return;
		if (this.destination.kind === "managed") {
			const bytes = Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
			await this.#managedTranscriptStore().replace(path.basename(this.#sessionFile), bytes);
			return;
		}
		const dir = path.resolve(this.#sessionFile, "..");
		const tempPath = path.join(dir, `.${path.basename(this.#sessionFile)}.${Snowflake.next()}.tmp`);
		const writer = new NdjsonFileWriter(this.storage, tempPath, { flags: "w" });
		try {
			for (const entry of entries) {
				await writer.write(entry);
			}
			await writer.flush();
			await writer.fsync();
			await writer.close();
			await this.#replaceSessionFile(tempPath, this.#sessionFile);
		} catch (err) {
			try {
				await writer.close();
			} catch {
				// Ignore cleanup errors
			}
			try {
				await this.storage.unlink(tempPath);
			} catch {
				// Ignore cleanup errors
			}
			throw toError(err);
		}
	}

	async #writeStagedDefaultModelSelection(
		entries: readonly FileEntry[],
		sessionFile: string,
	): Promise<string | undefined> {
		if (this.destination.kind === "managed") return undefined;
		if (!this.storage.existsSync(sessionFile)) return undefined;
		const dir = path.resolve(sessionFile, "..");
		const tempPath = path.join(dir, `.${path.basename(sessionFile)}.${Snowflake.next()}.default-selection.tmp`);
		const writer = new NdjsonFileWriter(this.storage, tempPath, {
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
				await this.storage.unlink(tempPath);
			} catch {}
			throw toError(error);
		}
	}

	async #rewriteFileContents(): Promise<void> {
		if (!this.persist || !this.#sessionFile) return;
		await this.#closePersistWriterInternal();
		const entries = await Promise.all(
			materializeResidentEntriesForPersistenceSync(this.#fileEntries, this.#residentBlobStores()).map(entry =>
				prepareEntryForPersistence(entry, this.#blobStore),
			),
		);
		await this.#writeEntriesAtomically(entries);
		this.#needsFullRewriteOnNextPersist = false;
		this.#flushed = true;
		this.#ensuredOnDisk = true;
	}

	async #rewriteFile(): Promise<void> {
		await this.#queuePersistTask(async () => {
			await this.#rewriteFileContents();
		});
	}

	#rewriteFileSync(): void {
		if (!this.persist || !this.#sessionFile) return;
		this.#closePersistWriterInternalSync();
		const entries = materializeResidentEntriesForPersistenceSync(this.#fileEntries, this.#residentBlobStores()).map(
			entry => prepareEntryForPersistenceSync(entry, this.#blobStore),
		);
		this.#writeEntriesAtomicallySync(entries);
		this.#needsFullRewriteOnNextPersist = false;
		this.#flushed = true;
		this.#ensuredOnDisk = true;
	}

	isPersisted(): boolean {
		return this.persist;
	}

	async stageDefaultModelSelection(
		model: string,
		thinkingLevel: string | undefined,
		options?: { readonly appendThinkingLevel: boolean },
	): Promise<DefaultModelSelectionStage> {
		const entryRevision = this.#entryRevision;
		const headerExportRevision = this.#headerExportRevision;
		const sessionId = this.#sessionId;
		const sessionFile = this.#sessionFile;
		const entryIds = new Map(this.#byId);
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
		const persistsToExistingFile = this.persist && sessionFile !== undefined && this.storage.existsSync(sessionFile);
		const tempPath = persistsToExistingFile
			? await this.#writeStagedDefaultModelSelection(entries, sessionFile)
			: undefined;
		return {
			entryRevision,
			headerExportRevision,
			sessionId,
			sessionFile,
			entries,
			tempPath,
			persistsToExistingFile,
		};
	}

	promoteDefaultModelSelection(stage: DefaultModelSelectionStage): DefaultModelSelectionPromotion {
		if (
			stage.entryRevision !== this.#entryRevision ||
			stage.headerExportRevision !== this.#headerExportRevision ||
			stage.sessionId !== this.#sessionId ||
			stage.sessionFile !== this.#sessionFile
		) {
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
					const persistedEntries = materializeResidentEntriesForPersistenceSync(
						[...stage.entries],
						this.#residentBlobStores(),
					).map(entry => prepareEntryForPersistenceSync(entry, this.#blobStore));
					this.#writeEntriesAtomicallySync(persistedEntries);
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
					const replacement = this.#replaceSessionFileSync(stage.tempPath, this.#sessionFile);
					if (replacement.kind === "restored_previous") {
						transition.dispose();
						return { kind: "not_promoted", error: replacement.error };
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
		this.#commitResidentTextStoreTransition(transition);
		return { kind: "promoted" };
	}

	async discardDefaultModelSelectionStage(stage: DefaultModelSelectionStage): Promise<void> {
		if (!stage.tempPath) return;
		try {
			await this.storage.unlink(stage.tempPath);
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
		});
		if (this.#persistError) throw this.#persistError;
	}

	/** Close the persistent writer after flushing all pending data. */
	async close(): Promise<void> {
		// Drain any uncommitted prepared successors before releasing resources so
		// dispose/shutdown retains exact cleanup authority (#3138).
		try {
			await this.#retryPreparedNewSessionCleanups();
		} catch (error) {
			logger.warn("Prepared session cleanup during close failed; retained for retry", {
				error: toError(error).message,
			});
		}
		await this.#queuePersistTask(async () => {
			if (this.#persistWriter) {
				await this.#closePersistWriterInternal();
				this.#flushed = true;
			}
		});
		this.#retireEphemeralArtifacts();
		await this.#drainEphemeralArtifactCleanups();
		this.#releaseResidentTextStore();
		this.#releaseOwnedManagedAuthority();
		if (this.#persistError) throw this.#persistError;
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
					this.storage,
				)
			: await SessionManager.listForResumePickerReadOnly(this.cwd, this.destination.directory, this.storage);
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
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
	}

	async createMemoryGuardCheckpoint(
		input: MemoryGuardCreateCheckpointInput,
	): Promise<MemoryGuardSessionManagerCheckpointV1> {
		this.#assertMemoryGuardParticipantIngressLease(input.ingressLease);
		if (!this.#sessionFile) throw new Error("memory_guard_checkpoint_session_file_unavailable");
		await this.flush();
		const captured = SessionManager.captureTranscriptStrict(this.#sessionFile, this.storage);
		if (captured.kind !== "captured") {
			throw new Error(`memory_guard_checkpoint_capture_failed:${captured.reason}`);
		}
		if (captured.snapshot.content.byteLength > MEMORY_GUARD_CHECKPOINT_FILE_MAX_BYTES)
			throw new Error("memory_guard_checkpoint_transcript_capacity_exceeded");
		const transcriptText = decodeCheckpointUtf8(captured.snapshot.content);
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
		await publishCheckpointFile(path.join(input.checkpointRoot, transcriptRelativePath), captured.snapshot.content);
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
				bytes: String(captured.snapshot.content.byteLength),
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
		const recaptured = SessionManager.captureTranscriptStrict(this.#sessionFile, this.storage);
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
				try {
					snapshot = store.captureTree(legacyLocalRoot);
				} catch (error) {
					if (error instanceof Error && error.message === "not_found") return null;
					if (error instanceof Error && error.message === "reparse_point") {
						try {
							store.captureTree(legacyArtifactsRoot);
						} catch (artifactsError) {
							if (artifactsError instanceof Error && artifactsError.message === "not_found") return null;
						}
					}
					throw error;
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
	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
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
				await this.#getManagedDraftStore()?.remove("draft.txt");
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
			return;
		}
		const draftPath = this.#getDraftPath();
		if (!draftPath || !this.persist) return;
		if (text.length === 0) {
			try {
				await this.storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
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
	}

	/**
	 * Read and remove the saved draft. Returns the previously-saved text, or
	 * null when no draft is pending. Single-shot: a successful read removes the
	 * sidecar so a subsequent resume does not re-restore the same text.
	 */
	async consumeDraft(): Promise<string | null> {
		if (this.destination.kind === "managed") {
			const draft = await this.#getManagedDraftStore()?.consume("draft.txt");
			return draft ? Buffer.from(draft).toString("utf8") : null;
		}
		const draftPath = this.#getDraftPath();
		if (!draftPath) return null;
		let text: string;
		try {
			text = await this.storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
		try {
			await this.storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
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
	async setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		this.#assertRecoveryHydrationWritable();
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
		const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		if (!header) return;
		applyHeaderPatch(header, patch);
		this.#headerExportRevision++;
		await this.#persistPatch({ type: "header_patch", patch });
	}

	#appendManagedRecordsSync(records: readonly (FileEntry | SessionPatchRecord)[]): void {
		if (!this.#sessionFile) throw new Error("Managed transcript path is unavailable");
		const store = this.#managedTranscriptStore();
		const relativePath = path.basename(this.#sessionFile);
		const bytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
		store.appendSync(relativePath, bytes);
	}

	async #persistPatch(record: SessionPatchRecord): Promise<void> {
		await this.#persistPatches([record]);
	}

	async #persistPatches(records: readonly SessionPatchRecord[]): Promise<void> {
		if (records.length === 0 || !this.persist || !this.#sessionFile || !this.storage.existsSync(this.#sessionFile))
			return;
		await this.#queuePersistTask(async () => {
			const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
			if (this.#needsFullRewriteOnNextPersist || !this.#flushed || (header?.version ?? 1) < CURRENT_SESSION_VERSION)
				return this.#rewriteFileContents();
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
			if (this.destination.kind === "managed") {
				this.#appendManagedRecordsSync(persistedRecords);
				return;
			}
			const writer = this.#ensurePersistWriter();
			if (!writer) return this.#rewriteFileContents();
			for (const persistedRecord of persistedRecords) {
				await writer.write(persistedRecord);
			}
		});
	}
	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.#sessionFile) return;
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
			} catch (err) {
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
		try {
			if (this.destination.kind === "managed") {
				const materializedEntry = materializeResidentEntryForPersistenceSync(
					entry,
					this.#residentBlobStores(),
					new Map(),
				);
				const persistedEntry = prepareEntryForPersistenceSync(materializedEntry, this.#blobStore);
				this.#appendManagedRecordsSync([persistedEntry]);
				return;
			}
			const writer = this.#ensurePersistWriter();
			if (!writer) {
				// `#ensurePersistWriter` returns undefined here only when the cached
				// writer is mid-close (the `!persist`/`!sessionFile` cases are
				// rejected above). Route through `#rewriteFile` so the entry — which
				// is already in `#fileEntries` — persists once the close drains.
				this.#rewriteFile().catch(() => {});
				return;
			}
			const materializedEntry = materializeResidentEntryForPersistenceSync(
				entry,
				this.#residentBlobStores(),
				new Map(),
			);
			const persistedEntry = prepareEntryForPersistenceSync(materializedEntry, this.#blobStore);
			writer.writeSync(persistedEntry);
		} catch (err) {
			this.#recordPersistError(err);
			throw this.#persistError ?? toError(err);
		}
	}

	#appendEntry(entry: SessionEntry): void {
		this.#assertRecoveryHydrationWritable();
		const normalizedEntry = normalizeSessionEntryForStorage(entry);
		const residentEntry = this.#prepareEntryForCurrentResidentStore(normalizedEntry) as SessionEntry;
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
			const removed = this.#fileEntries.pop();
			if (removed !== residentEntry)
				throw new Error("Session append rollback lost resident ordering.", { cause: error });
			this.#byId.delete(residentEntry.id);
			this.#leafId = previousLeafId;
			this.#bumpEntryRevision();
			this.#leafRevision++;
			if (entry.type === "label") this.#labelRevision++;
			throw new SessionAppendPersistenceError(
				priorPersistenceError ? "prior_failure" : "current_append",
				residentEntry.id,
				this.#persistError ?? toError(error),
			);
		}
		// Same validated, overflow-guarded aggregation as the resume path (#buildIndex): a
		// malformed task-result or assistant usage shape reaching the append path must not
		// crash or poison getUsageStatistics() either.
		if (this.#accumulateEntryUsage(entry)) {
			logger.warn("Skipped malformed or overflowing usage on appended entry", {
				sessionFile: this.#sessionFile,
				entryId: entry.id,
			});
		}
	}

	/** Append a configured fallback chain as child of current leaf, then advance leaf. Returns entry id. */
	appendConfiguredModelChain(chain: ConfiguredModelChain): string {
		const entry: ConfiguredModelChainEntry = {
			type: "configured_model_chain",
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		associateSessionMessageEntryId(message, entry.id);
		this.#appendEntry(entry);
		const residentEntry = this.#byId.get(entry.id);
		if (residentEntry?.type === "message") transferSessionMessageIdentity([message], [residentEntry.message]);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.#byId),
			parentId: this.#leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel: thinkingLevel ?? null,
		};
		this.#appendEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTier | null): string {
		const entry: ServiceTierChangeEntry = {
			type: "service_tier_change",
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
		this.#assertRecoveryHydrationWritable();
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
		this.#assertRecoveryHydrationWritable();
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
		const inspected = inspectResumeSessionFile(sessionFile, this.storage);
		if ("kind" in inspected) throw persistenceError;
		try {
			fsyncResumeSessionIdentity(inspected.identity);
		} catch {
			throw persistenceError;
		}
		const durable = inspectResumeSessionFile(sessionFile, this.storage);
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
		const entryId = generateId(this.#byId);
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
			id: generateId(this.#byId),
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
		const entry = this.#byId.get(this.#leafId);
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
	 */
	getLastModelChangeRole(): string | undefined {
		const visited = new Set<string>();
		let current = this.getLeafEntry();
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			if (current.type === "model_change") {
				return current.role ?? "default";
			}
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
		}
		return undefined;
	}

	evictCompactedContent(firstKeptEntryId: string, compactionEntryId: string): EvictCompactedContentResult {
		this.#assertRecoveryHydrationWritable();
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
			publicMaterializerCallCount: this.#publicMaterializerCallCount,
			getEntryMaterializerCallCount: this.#getEntryMaterializerCallCount,
			getBranchMaterializerCallCount: this.#getBranchMaterializerCallCount,
			getEntriesMaterializerCallCount: this.#getEntriesMaterializerCallCount,
			materializedEntriesCachePopulateCount: this.#materializedEntriesCachePopulateCount,
			materializedCacheDemotedCount: this.#materializedCacheDemotedCount,
			pathOnlyContextBuildCount: this.#pathOnlyContextBuildCount,
		};
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
		const entry = this.#byId.get(id);
		return entry ? cloneSessionEntry(entry) : undefined;
	}

	getEntryForFidelity(id: string): SessionEntry | undefined {
		const entry = this.#byId.get(id);
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
		let current = (fromId ?? this.#leafId) ? this.#byId.get(fromId ?? this.#leafId ?? "") : undefined;
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
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	#getCanonicalBranchClones(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const visited = new Set<string>();
		let current = (fromId ?? this.#leafId) ? this.#byId.get(fromId ?? this.#leafId ?? "") : undefined;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			path.push(cloneSessionEntry(current));
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
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

	getEntriesForExport(): SessionEntry[] {
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
		const entry = this.#byId.get(id);
		return entry
			? cloneSessionEntry(materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), new Map()))
			: undefined;
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const cache = new Map<string, string>();
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
		return this.#labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.#byId),
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
		let current = startId ? this.#byId.get(startId) : undefined;
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			path.push(cloneSessionEntry(materializeResidentEntryForReadSync(current, this.#residentBlobStores(), cache)));
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
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
		return cloneSessionContext(this.#getSessionContextForRead());
	}

	/**
	 * Return the revision-keyed context cache for internal read-only consumers.
	 * Normal snapshots remain strongly held; snapshots over the materialized cache
	 * cap are weakly held so a GC cycle can reclaim them between reads.
	 */
	#getSessionContextForRead(): Readonly<SessionContext> {
		const cached = dereferenceMaterializedCache(this.#sessionContextCache);
		if (
			cached &&
			this.#sessionContextEntryRevision === this.#entryRevision &&
			this.#sessionContextLeafRevision === this.#leafRevision &&
			this.#sessionContextReplayMetadataRevision === this.#replayMetadataRevision
		) {
			return cached;
		}
		this.#pathOnlyContextBuildCount++;
		const builtContext = buildSessionContext(
			this.#getActivePathEntriesForProviderContext(),
			this.#leafId,
			undefined,
			this.#sessionId,
		);
		if (jsonLikeValueExceedsCacheLimit(builtContext, materializedCacheMaxBytes())) {
			this.#holdMaterializedCachesWeakly();
		}
		const context = freezeInternalReadSnapshot(builtContext);
		this.#sessionContextCache = this.#materializedCachesWeaklyHeld ? new WeakRef(context) : context;
		transferSessionMessageIdentity(builtContext.messages, context.messages);
		this.#sessionContextEntryRevision = this.#entryRevision;
		this.#sessionContextLeafRevision = this.#leafRevision;
		this.#sessionContextReplayMetadataRevision = this.#replayMetadataRevision;
		return context;
	}

	#getActivePathEntriesForProviderContext(fromId?: string | null): SessionEntry[] {
		if (fromId === null || (fromId === undefined && this.#leafId === null)) return [];
		const ids: string[] = [];
		const visited = new Set<string>();
		let current = this.#byId.get(fromId ?? this.#leafId ?? "");
		while (current) {
			if (visited.has(current.id)) break;
			visited.add(current.id);
			ids.push(current.id);
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
		}
		ids.reverse();
		const pathEntries = ids
			.map(id => this.#byId.get(id))
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
		await this.#persistPatches(patches);
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
			const label = this.#labelsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label });
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
		if (!this.#byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
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
		if (branchFromId !== null && !this.#byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.#leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#byId),
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
					this.storage.writeTextSync(newSessionFile, `${lines.join("\n")}\n`);
				}
			} catch (error) {
				transition.dispose();
				throw error;
			}
			this.#sessionId = newSessionId;
			this.#sessionFile = newSessionFile;
			this.#flushed = true;
			this.#commitResidentTextStoreTransition(transition);
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
		const inspected = inspectResumeSessionFile(preparedPath, this.storage);
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
		const inspected = inspectResumeSessionFile(filePath, storage);
		if ("kind" in inspected) {
			if (inspected.reason === "missing") return filePath;
			throw new Error(`Could not inspect managed session: ${inspected.reason}`);
		}
		if (expectedIdentity && !sameResumeIdentity(expectedIdentity, inspected.identity))
			throw new Error("Managed session changed before migration authority was adopted.");
		const header = inspected.entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		if (!header?.cwd) return filePath;
		const sessionsRoot = destination.securityContext.sessionsRoot;
		const resolvedPath = path.resolve(filePath);
		const relativeToManagedRoot = path.relative(sessionsRoot, resolvedPath);
		const isManagedPath =
			relativeToManagedRoot === "" ||
			(!relativeToManagedRoot.startsWith("..") && !path.isAbsolute(relativeToManagedRoot));

		if (!isManagedPath) return filePath;
		assertManagedDestinationBound();
		const resolved = resolveManagedScope({
			cwd: header.cwd,
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
		const revalidated = inspectResumeSessionFile(filePath, storage);
		if (
			"kind" in revalidated ||
			!sameResumeIdentity(inspected.identity, revalidated.identity) ||
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
	): Promise<SessionManager> {
		const destination = destinationFor(cwd, destinationInput, storage);
		const managedSourcePath =
			destination.kind === "managed" && storage instanceof FileSessionStorage
				? await SessionManager.prepareManagedCandidateForWrite(sourcePath, migrationPolicy, destination)
				: sourcePath;
		const dir = destination.directory;
		const manager = new SessionManager(cwd, dir, true, storage, destination);
		const forkEntries = structuredClone(await loadEntriesFromFile(managedSourcePath, storage)) as FileEntry[];
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
	static async open(
		filePath: string,
		destinationInput?: SessionDestinationInput,
		storage: SessionStorage = new FileSessionStorage(),
		migrationPolicy: SessionDirectoryMigrationPolicy = "copy-retain",
	): Promise<SessionManager> {
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
			// Fail closed on oversized transcripts before the full read in the explicit path too (#3851).
			// A missing file falls through to loadEntriesFromFile, which returns [] and creates
			// a fresh session — matching the pre-existing behavior.
			try {
				const preStat = storage.statSync(filePath);
				if (preStat.size > RESUME_TRANSCRIPT_MAX_BYTES) throw new SessionTranscriptOversizedError(preStat.size);
			} catch (error) {
				if (error instanceof SessionTranscriptOversizedError) throw error;
				if (!isEnoent(error)) throw error;
			}
			const entries = await loadEntriesFromFile(filePath, storage);
			const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
			const manager = new SessionManager(
				header?.cwd ?? getProjectDir(),
				destination.directory,
				true,
				storage,
				destination,
			);
			await manager.#initSessionFile(filePath);
			return manager;
		}

		const inspected = inspectResumeSessionFile(filePath, storage);
		if ("kind" in inspected) {
			if (inspected.reason === "missing") {
				const manager = new SessionManager(getProjectDir(), destination.directory, true, storage, destination);
				await manager.#initSessionFile(filePath);
				return manager;
			}
			if (inspected.reason === "oversized") throw new SessionTranscriptOversizedError(inspected.size ?? 0);
			throw new Error(`Could not open session: ${inspected.reason}`);
		}
		const opened = await SessionManager.openExistingStrict(inspected.identity, destination, storage, migrationPolicy);
		if (opened.kind === "error") {
			if (opened.reason === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
			if (opened.reason === "artifact_capacity_exceeded")
				throw new SessionArtifactCapacityError(
					opened.message ?? "Session artifacts exceed the migration capacity.",
				);
			if (opened.reason === "oversized") throw new SessionTranscriptOversizedError(opened.size ?? 0);
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
		const captured = store.readExpected(path.basename(resolved));
		const entries = captured ? parseSessionEntries(captured.bytes.toString("utf8")) : [];
		const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const sessionCwd = cwdOverride ? path.resolve(cwdOverride) : (header?.cwd ?? getProjectDir());
		const cwdChanged = Boolean(
			header && cwdOverride && resolveEquivalentPath(header.cwd) !== resolveEquivalentPath(sessionCwd),
		);
		if (header && cwdChanged) header.cwd = sessionCwd;
		const manager = new SessionManager(sessionCwd, destination.directory, true, storage, destination);
		if (entries.length > 0) {
			const migrationApplied = migrateToCurrentVersion(entries) || cwdChanged;
			await manager.#hydrateExistingSession(resolved, entries, migrationApplied, "memory-fallback");
			if (cwdChanged) {
				await manager.#rewriteFile();
				manager.#flushed = true;
				manager.#ensuredOnDisk = true;
			}
			writeTerminalBreadcrumb(manager.cwd, resolved);
			await manager.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
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
		}
		store.assertBound();
		return manager;
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
			listing.owned.map(candidate => candidate.path),
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
			return await collectSessionsFromFiles(storage.listFilesSync(sessionDir, "*.jsonl"), storage);
		} catch {
			return [];
		}
	}

	/** Delete an authorized managed or project-local picker candidate. */
	static async deleteManagedCandidate(sessionPath: string): Promise<void> {
		const storage = new FileSessionStorage();
		const entries = await loadEntriesFromFile(sessionPath, storage);
		const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		if (!header?.cwd) throw new Error("Session has no valid workspace header.");
		const projectGjcDir = path.join(path.resolve(header.cwd), ".gjc");
		if (isProjectSessionTranscriptPath(projectGjcDir, sessionPath)) {
			const relativePath = path.relative(projectGjcDir, path.resolve(sessionPath)).split(path.sep).join("/");
			const authority = nativeSessionManager().openRecoveryFsRoot(projectGjcDir);
			try {
				const captured = authority.readManaged(relativePath);
				if (!captured.ok || !captured.identity || !captured.data || !captured.identity.sha256)
					throw new Error("Project session is no longer an authorized candidate.");
				const removed = authority.removeManaged(
					relativePath,
					captured.identity.dev,
					captured.identity.ino,
					captured.identity.size,
					captured.identity.mtimeNs,
					captured.identity.ctimeNs,
					captured.identity.sha256,
				);
				if (!removed.ok) throw new Error(removed.code ?? "Could not delete project session.");
				return;
			} finally {
				authority.close();
			}
		}
		const sessionsRoot = path.resolve(sessionPath, "../..");
		const resolved = resolveManagedScope({
			cwd: header.cwd,
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
		const inspected = inspectResumeSessionFile(filePath, storage);
		if ("kind" in inspected) return inspected;
		return {
			kind: "captured",
			snapshot: {
				sourcePath: path.resolve(filePath),
				identity: inspected.identity,
				content: Uint8Array.from(inspected.content),
				storage,
			},
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
	): Promise<StrictSessionForkResult> {
		const destination = destinationFor(cwd, destinationInput, snapshot.storage);
		if (crypto.createHash("sha256").update(snapshot.content).digest("hex") !== snapshot.identity.sha256) {
			return { kind: "error", reason: "identity-mismatch" };
		}

		let forkEntries: FileEntry[] = [];
		try {
			const content = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.content);
			for (const line of content.split(/\r?\n/)) {
				if (line.length > 0) JSON.parse(line);
			}
			forkEntries = parseSessionEntries(content);
			const sourceHeader = forkEntries[0] as SessionHeader | undefined;
			if (sourceHeader?.type !== "session" || sourceHeader.id !== snapshot.identity.sessionId)
				return { kind: "error", reason: "identity-mismatch" };
			migrateToCurrentVersion(forkEntries);
			if (!hasStrictSessionSchema(forkEntries)) return { kind: "error", reason: "malformed" };
		} catch {
			return { kind: "error", reason: "malformed" };
		}

		const revalidated = inspectResumeSessionFile(snapshot.sourcePath, snapshot.storage);
		if ("kind" in revalidated) return revalidated;
		if (!sameResumeIdentity(snapshot.identity, revalidated.identity)) {
			return { kind: "error", reason: "identity-mismatch" };
		}

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
			manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
			const beforeWrite = inspectResumeSessionFile(snapshot.sourcePath, snapshot.storage);
			if ("kind" in beforeWrite) {
				authorityFailure = beforeWrite;
				throw new Error("Captured fork source authority changed before destination write.");
			}
			if (!sameResumeIdentity(snapshot.identity, beforeWrite.identity)) {
				authorityFailure = { kind: "error", reason: "identity-mismatch" };
				throw new Error("Captured fork source authority changed before destination write.");
			}
			await manager.#rewriteFile();
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
			const afterWrite = inspectResumeSessionFile(snapshot.sourcePath, snapshot.storage);
			if ("kind" in afterWrite) {
				authorityFailure = afterWrite;
				throw new Error("Captured fork source authority changed during destination write.");
			}
			if (!sameResumeIdentity(snapshot.identity, afterWrite.identity)) {
				authorityFailure = { kind: "error", reason: "identity-mismatch" };
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
					if (!outcome.ok) throw new Error(outcome.code ?? "fork_destination_publish_failed");
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
				} catch (error) {
					finalTransition.dispose();
					throw error;
				}
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
		const inspected = inspectResumeSessionFile(context.identity.canonicalPath, this.storage);
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
		const promotedSource = inspectResumeSessionFile(context.identity.canonicalPath, this.storage);
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
			throw error;
		}
		this.#sessionFile = promotionPath;
		this.#recoveryPromotionTranscriptPath = undefined;
		this.#commitResidentTextStoreTransition(transition);
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
		await manager.#hydrateExistingSession(sessionPath, entries, inspected.migrationApplied);
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
	): Promise<SessionManager> {
		const destination = destinationFor(cwd, destinationInput, storage);
		const dir = destination.directory;
		const openSelectedStrictly = async (selectedPath: string): Promise<SessionManager | undefined> => {
			const inspected = await SessionManager.inspectSessionTailReadOnly(selectedPath, storage);
			if (inspected.kind === "error") {
				if (inspected.reason === "oversized") throw new SessionTranscriptOversizedError(inspected.size ?? 0);
				return undefined;
			}
			const opened = await SessionManager.openExistingStrict(
				inspected.identity,
				destination,
				storage,
				migrationPolicy,
			);
			if (opened.kind === "error") {
				if (opened.reason === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
				if (opened.reason === "artifact_capacity_exceeded")
					throw new SessionArtifactCapacityError(
						opened.message ?? "Session artifacts exceed the migration capacity.",
					);
				if (opened.reason === "oversized") throw new SessionTranscriptOversizedError(opened.size ?? 0);
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
				for (const candidate of listing.owned) logicalFiles.add(candidate.path);
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
			storage: this.storage,
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
		if (!this.storage.deleteSessionVerified) {
			throw new Error("Storage backend does not support verified session deletion");
		}
		return this.storage.deleteSessionVerified(target);
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
