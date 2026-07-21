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
} from "@gajae-code/ai";
import * as native from "@gajae-code/natives";
import { getTerminalId } from "@gajae-code/tui";
import {
	getBlobsDir,
	getProjectDir,
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
	parseBlobRef,
	ResidentBlobMissingError,
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
	type ManagedDirectoryRoot,
	type ManagedFileSnapshot,
	ManagedSessionDescendantStore,
	type ManagedSessionSecurityPolicy,
	retainManagedDirectoryAuthority,
} from "./internal/managed-session-storage";

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
	publicMaterializerCallCount: number;
	getEntryMaterializerCallCount: number;
	getBranchMaterializerCallCount: number;
	getEntriesMaterializerCallCount: number;
	materializedEntriesCachePopulateCount: number;
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
	size: number;
	mtimeMs: number;
	mtimeNs: bigint;
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
	reason: "missing" | "malformed" | "unstable" | "read-failed" | "legacy_migration_disabled";
}

export type SessionDirectoryMigrationPolicy = ManagedMigrationPolicy;

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

export type ResumeTailInspection = ResumeTailResumable | ResumeTailTerminal | ResumeTailError;
export interface StrictSessionOpenSuccess {
	kind: "opened";
	manager: SessionManager;
}

export interface StrictSessionOpenFailure {
	kind: "error";
	reason: ResumeTailError["reason"] | "identity-mismatch" | "migration-required";
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

/** Resolve and prepare the default v2 session scope before any managed writer exists. */
function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	if (!(storage instanceof FileSessionStorage)) throw new SessionManagedStorageError();
	const resolved = resolveManagedScopeForWrite({ cwd, agentDir: path.resolve(sessionsRoot, ".."), sessionsRoot });
	if (resolved.kind === "error") throw new Error(`Could not resolve managed session scope: ${resolved.message}`);
	const prepared = prepareManagedSessionScopeForWriteSync(
		resolved.scope,
		process.platform === "win32" ? "windows-existing-verify-first" : "default",
	);
	if (prepared.kind === "error") throw new Error(`Could not prepare managed session scope: ${prepared.message}`);
	return prepared.scope.directoryPath;
}

/** A session directory's authority is distinct from its string path. */
export type SessionDestination =
	| { readonly kind: "managed"; readonly directory: string; readonly securityContext: ManagedSessionSecurityContext }
	| { readonly kind: "explicit"; readonly directory: string };
export type SessionDestinationInput = string | SessionDestination | undefined;

interface ForkArtifactPublication {
	readonly snapshot: native.NativeDirectoryTreeSnapshot;
	readonly store: ManagedSessionDescendantStore;
	readonly cleanupStore: ManagedSessionDescendantStore;
	readonly cleanupRelativePath: string;
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
				entry.size === other.size &&
				entry.mtimeNs === other.mtimeNs &&
				(entry.relativePath === "" || entry.ctimeNs === other.ctimeNs) &&
				entry.sha256 === other.sha256
			);
		})
	);
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
	return new ManagedSessionDescendantStore(
		securityContext.rootAuthority,
		directory,
		securityContext.retainedAuthority
			? { authority: securityContext.retainedAuthority, authorityBaseDir: directory }
			: undefined,
		managedSecurityPolicyForContext(securityContext),
	);
}

function freezeManagedDestination(scope: ManagedScope): SessionDestination {
	const rootAuthority = managedRootForScope(scope);
	const securityContext = createManagedSessionSecurityContext({
		agentDir: scope.agentDir,
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
	if (resolved.kind === "error") throw new Error(`Could not resolve managed session scope: ${resolved.message}`);
	const prepared = prepareManagedSessionScopeForWriteSync(
		resolved.scope,
		process.platform === "win32" ? "windows-existing-verify-first" : "default",
	);
	if (prepared.kind === "error") throw new Error(`Could not prepare managed session scope: ${prepared.message}`);
	return freezeManagedDestination(prepared.scope);
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
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

function sameResumeStat(left: SessionStorageStat, right: SessionStorageStat): boolean {
	return (
		left.isFile &&
		right.isFile &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mtimeNs === right.mtimeNs
	);
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
			size: snapshot.size,
			mtimeMs: snapshot.mtimeMs,
			mtimeNs: snapshot.mtimeNs,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
		};
		return { identity, content: Uint8Array.from(bytes), entries, context, migrationApplied };
	} catch {
		return { kind: "error", reason: "malformed" };
	}
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
 * Reads all session files from the directory and returns them sorted by mtime (newest first).
 * Uses low-level file I/O to efficiently read only the first 4KB of each file
 * to extract the JSON header and first user message without loading entire session logs into memory.
 */
async function getSortedSessions(sessionDir: string, storage: SessionStorage): Promise<RecentSessionInfo[]> {
	await recoverOrphanedBackups(sessionDir, storage);
	try {
		const files: string[] = storage.listFilesSync(sessionDir, "*.jsonl");
		const sessions: RecentSessionInfo[] = [];
		await Promise.all(
			files.map(async (path: string) => {
				try {
					const buffer = Buffer.allocUnsafe(SESSION_LIST_PREFIX_BYTES);
					const content = await readSessionListPrefix(path, storage, buffer);
					const entries = parseJsonlLenient<Record<string, unknown>>(content);
					if (entries.length === 0) return;
					const header = entries[0] as Record<string, unknown>;
					if (
						header.type !== "session" ||
						typeof header.id !== "string" ||
						!isSupportedSessionVersion(header.version)
					)
						return;
					if (typeof header.version === "number" && header.version >= 4) {
						for (const patch of await readSessionListTrailingPatches(path, storage, buffer)) {
							applySessionListHeaderPatch(header as unknown as SessionListHeader, patch);
						}
					}
					const mtime = storage.statSync(path).mtimeMs;
					const firstPrompt = header.title ? undefined : extractFirstUserPrompt(entries);
					sessions.push(new RecentSessionInfo(path, mtime, header, firstPrompt));
				} catch {}
			}),
		);
		return sessions.sort((a, b) => b.mtime - a.mtime);
	} catch {
		return [];
	}
}

/** Exported for testing */
export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await getSortedSessions(sessionDir, storage);
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

async function syncPathAndParent(filePath: string): Promise<void> {
	const file = await fs.promises.open(filePath, "r");
	try {
		await file.sync();
	} finally {
		await file.close();
	}
	if (process.platform !== "win32") {
		const parent = await fs.promises.open(path.dirname(filePath), "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	}
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

/** Durably flush every copied file and directory before an EXDEV source removal. */
async function syncCopiedTree(treePath: string): Promise<void> {
	const stat = await fs.promises.lstat(treePath);
	if (stat.isSymbolicLink()) throw new Error("Refusing to fsync a copied symbolic link during a cross-device move");
	if (stat.isFile()) {
		const file = await fs.promises.open(treePath, "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		return;
	}
	if (!stat.isDirectory()) throw new Error("Copied cross-device move contains an unsupported filesystem entry");
	const directory = await fs.promises.opendir(treePath);
	try {
		for (;;) {
			const entry = await directory.read();
			if (entry === null) break;
			await syncCopiedTree(path.join(treePath, entry.name));
		}
	} finally {
		await directory.close();
	}
	if (process.platform !== "win32") {
		const handle = await fs.promises.open(treePath, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
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

async function removeCrossDeviceSourceIfUnchanged(source: string, expected: CrossDeviceTreeIdentity): Promise<void> {
	if ((await captureCrossDeviceTreeIdentity(source)) !== expected)
		throw new Error("Cross-device move source changed before removal");
	const stat = await fs.promises.lstat(source);
	if (stat.isDirectory()) await fs.promises.rm(source, { recursive: true, force: false });
	else await fs.promises.unlink(source);
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

class PathMoveCompletedWithSyncFailure extends Error {
	constructor(readonly cause: unknown) {
		super("Path move completed but final source-directory sync failed.", { cause });
	}
}

async function movePathAcrossDevicesSafe(source: string, destination: string): Promise<void> {
	const sourceIdentity = await captureCrossDeviceTreeIdentity(source);
	const renamed = native.renameNoReplacePath(source, destination);
	if (renamed.ok) {
		try {
			if ((await captureCrossDeviceTreeIdentity(destination)) !== sourceIdentity)
				throw new Error("Atomic session rename did not preserve the captured source identity");
			await syncSessionMoveDirectory(path.dirname(destination));
			if (path.dirname(source) !== path.dirname(destination)) await syncSessionMoveDirectory(path.dirname(source));
		} catch (error) {
			throw new PathMoveCompletedWithSyncFailure(error);
		}
		return;
	}
	if (renamed.code === "quarantine_collision") {
		const error = new Error(`Session move destination already exists: ${destination}`) as NodeJS.ErrnoException;
		error.code = "EEXIST";
		throw error;
	}
	if (renamed.code !== "atomic_unavailable")
		throw new Error(`Atomic session rename failed: ${renamed.code ?? "unknown"}`);
	const sourceStat = await fs.promises.lstat(source);
	if (!sourceStat.isDirectory()) {
		let destinationCreated = false;
		let sourceRemoved = false;
		try {
			try {
				await fs.promises.link(source, destination);
				destinationCreated = true;
			} catch (error) {
				if (hasFsCode(error, "EXDEV")) throw new CrossDeviceMoveUnsupportedError(source, destination, error);
				if (
					!hasFsCode(error, "EPERM") &&
					!hasFsCode(error, "EACCES") &&
					!hasFsCode(error, "ENOTSUP") &&
					!hasFsCode(error, "EOPNOTSUPP")
				)
					throw error;
				await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
				destinationCreated = true;
			}
			await syncPathAndParent(destination);
			await removeCrossDeviceSourceIfUnchanged(source, sourceIdentity);
			sourceRemoved = true;
			await syncSessionMoveDirectory(path.dirname(source));
			return;
		} catch (error) {
			if (!sourceRemoved && destinationCreated) await fs.promises.unlink(destination).catch(() => undefined);
			if (sourceRemoved && !(error instanceof PathMoveCompletedWithSyncFailure))
				throw new PathMoveCompletedWithSyncFailure(error);
			throw error;
		}
	}

	const destinationParent = await fs.promises.lstat(path.dirname(destination));
	if (sourceStat.dev !== destinationParent.dev) throw new CrossDeviceMoveUnsupportedError(source, destination);

	try {
		await fs.promises.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
		await syncCopiedTree(destination);
		await removeCrossDeviceSourceIfUnchanged(source, sourceIdentity);
		try {
			await syncSessionMoveDirectory(path.dirname(source));
		} catch (error) {
			throw new PathMoveCompletedWithSyncFailure(error);
		}
	} catch (error) {
		if (!(error instanceof PathMoveCompletedWithSyncFailure))
			await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
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
	sessionId?: string;
	sessionFile?: string;
	onResidentBlobRead?: (kind: ResidentBlobKind) => void;
}

type ResidentBlobMissingPolicy = "throw" | "placeholder";

function residentBlobMissingPlaceholder(error: ResidentBlobMissingError): string {
	return `[Session resident ${error.kind} blob missing: sha256:${error.hash}; original content unavailable]`;
}

function externalizeResidentValueSync(obj: unknown, stores: ResidentBlobStores, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj) && obj.length >= BLOB_EXTERNALIZE_THRESHOLD)
			return residentBlobSentinel("imageUrl", externalizeImageDataUrlSync(stores.imageStore, obj));
		if (shouldExternalizeResidentString(key) && obj.length >= BLOB_EXTERNALIZE_THRESHOLD)
			return residentBlobSentinel("text", stores.textStore.putSync(Buffer.from(obj, "utf8")).ref);
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
			resolved =
				obj.kind === "imageUrl"
					? resolveResidentImageDataUrlSync(stores.imageStore, obj.ref, stores)
					: obj.kind === "imageData"
						? resolveResidentImageDataSync(stores.imageStore, obj.ref, stores)
						: resolveTextBlobSync(stores.textStore, obj.ref, stores);
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

function materializeResidentEntryForReadSync<T extends FileEntry | SessionEntry>(
	entry: T,
	stores: ResidentBlobStores,
	cache: Map<string, string>,
): T {
	return materializeResidentEntrySync(entry, stores, cache, "placeholder");
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

const DEFAULT_WELCOME_RECENT_SESSION_LIMIT = 20;

/** Get recent sessions for display in welcome screen */
export async function getRecentSessions(
	sessionDir: string,
	limit = DEFAULT_WELCOME_RECENT_SESSION_LIMIT,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<RecentSessionInfo[]> {
	const sessions = await getSortedSessions(sessionDir, storage);
	return sessions.slice(0, limit);
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

function extractTextFromContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

const SESSION_LIST_PREFIX_BYTES = 4096;
const SESSION_LIST_TRAILING_PATCH_BYTES = 4096;
// Hard cap on how many trailing bytes the listers may scan for header patches.
// moveTo folds cwd patches into line 1 via a full atomic rewrite, so only a
// recent title patch can live unfolded near EOF; anything buried deeper is
// folded on the next natural full rewrite. Keeping this bounded preserves the
// O(SESSION_LIST_PREFIX_BYTES) listing cost that SESSION_LIST_PREFIX_BYTES exists for.
const SESSION_LIST_TRAILING_PATCH_SCAN_CAP = SESSION_LIST_TRAILING_PATCH_BYTES * 4;
const SESSION_NAME_MAX_CHARS = 1_000;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;
const sessionListPrefixDecoder = new TextDecoder("utf-8", { fatal: false });
let residentCacheInstanceCounter = 0;

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
	const scanFloor = Math.max(0, size - SESSION_LIST_TRAILING_PATCH_SCAN_CAP);
	let trailingFragment = Buffer.alloc(0);
	const chunkSize = Math.min(buffer.byteLength, SESSION_LIST_TRAILING_PATCH_BYTES);
	const handle = await fs.promises.open(file, "r");
	try {
		while (position > scanFloor && (latest.cwd === undefined || latest.title === undefined)) {
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
			const lines = complete.toString("utf8").split("\n");
			for (let index = lines.length - 1; index >= 0; index--) {
				const line = lines[index];
				if (!line) continue;
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
}

export class SessionManager {
	#sessionId: string = "";
	/** True once a lifecycle pre-allocated id has been adopted (consume-once). */
	#lifecycleIdAdopted: boolean = false;
	#sessionName: string | undefined;
	#titleSource: "auto" | "user" | undefined;
	#sessionFile: string | undefined;
	#flushed: boolean = false;
	#needsFullRewriteOnNextPersist: boolean = false;
	#ensuredOnDisk: boolean = false;
	#recoveryHydrationContext: RecoveryHydrationContext | undefined;
	#fileEntries: FileEntry[] = [];
	#pendingStrictAdoption: { canonicalPath: string; identity: ResumeSessionIdentity } | undefined;
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

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#managedTranscriptStoreCache: { directory: string; store: ManagedSessionDescendantStore } | null = null;
	// When set, take precedence over the lazily-derived per-session manager.
	// Subagents adopt the parent's manager so artifact IDs are unique across the
	// whole agent tree and all files land in the parent's artifacts dir.
	#adoptedArtifactManager: ArtifactManager | null = null;
	// In-memory artifact fallback for non-persistent sessions (persist=false).
	// Keyed by sequential numeric ID string; mirrors the file-based ArtifactManager ID scheme.
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;
	readonly #blobStore: BlobStore;
	#residentTextBlobStore: BlobStore = new MemoryBlobStore();
	readonly #residentImageBlobStore: BlobStore;
	#entryRevision = 0;
	#leafRevision = 0;
	/** Export/header cache invalidation contract; consumers may arrive after the revision field. */
	#headerExportRevision = 0;
	/** Label-view cache invalidation contract; consumers may arrive after the revision field. */
	#labelRevision = 0;
	#replayMetadataRevision = 0;
	#materializedEntriesRevision = -1;
	#materializedEntriesCache: SessionEntry[] | undefined;
	#sessionContextCache: SessionContext | undefined;
	#sessionContextEntryRevision = -1;
	#sessionContextLeafRevision = -1;
	#sessionContextReplayMetadataRevision = -1;
	#coldSpillWriteCount = 0;
	#coldSpillReadCount = 0;
	#residentTextReadCount = 0;
	#residentImageReadCount = 0;
	#publicMaterializerCallCount = 0;
	#getEntryMaterializerCallCount = 0;
	#getBranchMaterializerCallCount = 0;
	#getEntriesMaterializerCallCount = 0;
	#materializedEntriesCachePopulateCount = 0;
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

	#residentCacheDir(sessionFile: string): string {
		const instance = ++residentCacheInstanceCounter;
		return path.join(
			sessionFile.slice(0, -6),
			"resident-cache",
			`${this.#sessionId || "pending"}-${process.pid}-${instance}`,
		);
	}

	#reexternalizeFileEntriesForResidentStore(): void {
		this.#fileEntries = this.#fileEntries.map(entry =>
			prepareEntryForResidentSync(entry, this.#residentBlobStores()),
		);
		this.#buildIndex();
	}

	#resetMaterializedCaches(): void {
		this.#materializedEntriesRevision = -1;
		this.#materializedEntriesCache = undefined;
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
	revisionSnapshot(): {
		entry: number;
		leaf: number;
		headerExport: number;
		label: number;
		replayMetadata: number;
	} {
		return {
			entry: this.#entryRevision,
			leaf: this.#leafRevision,
			headerExport: this.#headerExportRevision,
			label: this.#labelRevision,
			replayMetadata: this.#replayMetadataRevision,
		};
	}

	#disposeResidentTextBlobStore(): void {
		if (this.#residentTextBlobStore instanceof EphemeralBlobStore) {
			this.#residentTextBlobStore.dispose();
		}
		this.#residentTextBlobStore = new MemoryBlobStore();
		this.#resetMaterializedCaches();
	}

	#resetResidentTextBlobStore(): void {
		this.#disposeResidentTextBlobStore();
		if (
			this.destination.kind === "explicit" &&
			this.persist &&
			this.#sessionFile &&
			this.storage instanceof FileSessionStorage
		) {
			this.#residentTextBlobStore = new EphemeralBlobStore(this.#residentCacheDir(this.#sessionFile));
		}
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
		};
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		const restoredFileEntries = [...snapshot.materializedFileEntries];
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
		this.#fileEntries = restoredFileEntries;
		if (!retainsPersistWriter) {
			this.#persistWriter = undefined;
			this.#persistWriterPath = undefined;
		}
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#resetResidentTextBlobStore();
		this.#reexternalizeFileEntriesForResidentStore();
		this.#bumpAllRevisions();
		if (this.#sessionFile) {
			writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
		}
	}

	/** Initialize with a specific session file (used by factory methods) */
	async #initSessionFile(sessionFile: string): Promise<void> {
		await this.setSessionFile(sessionFile);
	}

	async #hydrateExistingSession(sessionFile: string, entries: FileEntry[], migrationApplied: boolean): Promise<void> {
		const ownedEntries = structuredClone(entries) as FileEntry[];
		const header = ownedEntries[0] as SessionHeader;
		this.#sessionFile = this.storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#needsFullRewriteOnNextPersist = migrationApplied;
		await resolveBlobRefsInEntries(ownedEntries, this.#blobStore);
		this.#fileEntries = ownedEntries;
		this.#resetResidentTextBlobStore();
		this.#fileEntries = this.#fileEntries.map(entry =>
			prepareEntryForResidentSync(entry, this.#residentBlobStores()),
		);
		this.#buildIndex();
		this.#bumpAllRevisions();
		this.#flushed = true;
		this.#ensuredOnDisk = true;
	}

	/** Initialize with a new session (used by factory methods) */
	#initNewSession(): void {
		this.#newSessionSync();
		this.#bumpAllRevisions();
	}

	/** Switch to a different session file (used for resume and branching) */
	async setSessionFile(sessionFile: string): Promise<void> {
		const resolvedSessionFile = this.storage instanceof FileSessionStorage ? path.resolve(sessionFile) : sessionFile;
		const strictAdoption = this.#pendingStrictAdoption;
		this.#pendingStrictAdoption = undefined;
		if (strictAdoption && resolvedSessionFile === strictAdoption.canonicalPath) {
			const inspected = inspectResumeSessionFile(resolvedSessionFile, this.storage);
			if ("kind" in inspected || !sameResumeIdentity(strictAdoption.identity, inspected.identity))
				throw new Error("Prepared managed session changed before strict adoption.");
		}
		await this.#closePersistWriter();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		this.#sessionFile = resolvedSessionFile;
		writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
		this.#fileEntries = await loadEntriesFromFile(this.#sessionFile, this.storage);
		if (strictAdoption) {
			const inspected = inspectResumeSessionFile(this.#sessionFile, this.storage);
			if ("kind" in inspected || !sameResumeIdentity(strictAdoption.identity, inspected.identity))
				throw new Error("Prepared managed session changed during strict adoption.");
		}
		if (this.#fileEntries.length > 0) {
			const header = this.#fileEntries.find(e => e.type === "session") as SessionHeader | undefined;
			this.#sessionId = header?.id ?? createSessionId();
			this.#sessionName = header?.title;
			this.#titleSource = header?.titleSource;

			this.#needsFullRewriteOnNextPersist = migrateToCurrentVersion(this.#fileEntries);
			await resolveBlobRefsInEntries(this.#fileEntries, this.#blobStore);
			this.#resetResidentTextBlobStore();

			this.#fileEntries = this.#fileEntries.map(entry =>
				prepareEntryForResidentSync(entry, this.#residentBlobStores()),
			);

			this.#buildIndex();
			this.#bumpAllRevisions();
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			await this.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
		} else {
			const explicitPath = this.#sessionFile;
			this.#newSessionSync();
			this.#sessionFile = explicitPath; // preserve explicit path from --session flag
			this.#resetResidentTextBlobStore();
			await this.#rewriteFile();
			this.#flushed = true;
			this.#ensuredOnDisk = true;
			this.#bumpAllRevisions();
			return;
		}
	}

	/** Start a new session. Closes any existing writer first. */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#closePersistWriter();
		const sessionFile = this.#newSessionSync(options);
		this.#bumpAllRevisions();
		return sessionFile;
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
				if (deleted.kind === "error") throw new Error(`Could not delete managed session: ${deleted.message}`);
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
	 * yet, so `dropSession` would refuse it and leak its resident-cache/artifact
	 * root. Bounded to this manager's configured session root and refuses to touch
	 * the active session; tolerates missing files.
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
		if (!this.persist || !this.#sessionFile) {
			return undefined;
		}

		const oldSessionFile = this.#sessionFile;
		const oldSessionId = this.#sessionId;
		const materializedEntries = materializeResidentEntriesForReadSync(this.#fileEntries, this.#residentBlobStores());
		const oldFileEntries = this.#fileEntries;
		const oldSessionName = this.#sessionName;
		const oldTitleSource = this.#titleSource;

		// Close the current writer
		await this.#closePersistWriter();
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;

		// Create new session ID and header
		this.#sessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		this.#sessionFile = path.join(this.getSessionDir(), `${fileTimestamp}_${this.#sessionId}.jsonl`);

		// Update the header with new ID but keep all entries
		const oldHeader = this.#fileEntries.find(e => e.type === "session") as SessionHeader | undefined;
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: oldHeader?.title ?? this.#sessionName,
			titleSource: oldHeader?.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.cwd,
			parentSession: oldSessionId,
		};
		this.#sessionName = newHeader.title;
		this.#titleSource = newHeader.titleSource;

		// Replace the header in fileEntries
		const entries = materializedEntries.filter((e): e is SessionEntry => e.type !== "session");
		this.#fileEntries = [newHeader, ...entries];
		this.#resetResidentTextBlobStore();
		this.#reexternalizeFileEntriesForResidentStore();
		this.#bumpAllRevisions();

		// Write the new session file, import artifacts, and adopt only after the
		// retained destination manifest is complete.
		this.#flushed = false;
		let forkArtifactPublication: ForkArtifactPublication | undefined;
		let forkTranscriptPublication: ManagedFileSnapshot | null = null;
		let forkTranscriptStore: ManagedSessionDescendantStore | undefined;
		try {
			forkArtifactPublication = await this.copyArtifactsForFork(oldSessionFile, this.#sessionFile);
			await this.#rewriteFile();
			if (this.destination.kind === "managed") {
				forkTranscriptStore = this.#managedTranscriptStore();
				forkTranscriptPublication = forkTranscriptStore.readExpected(path.basename(this.#sessionFile));
				if (!forkTranscriptPublication) throw new Error("managed_fork_transcript_publish_missing");
			}
			forkArtifactPublication?.store.verifyRootSecurity();
			forkArtifactPublication?.store.assertBound();
			if (forkArtifactPublication) {
				const adoptedSnapshot = forkArtifactPublication.store.fsyncTree();
				if (!retainedTreeSnapshotEquals(adoptedSnapshot, forkArtifactPublication.snapshot)) {
					throw new Error("artifact_destination_changed_during_transcript_publication");
				}
			}
			if (forkTranscriptStore && forkTranscriptPublication) {
				const terminalTranscript = forkTranscriptStore.readExpected(path.basename(this.#sessionFile));
				if (!managedFileSnapshotEquals(terminalTranscript, forkTranscriptPublication))
					throw new Error("managed_fork_transcript_changed");
			}
		} catch (error) {
			let failure = error;
			const failedSessionFile = this.#sessionFile;
			if (this.destination.kind === "managed") {
				try {
					if (forkTranscriptStore && forkTranscriptPublication)
						forkTranscriptStore.removeExpected(path.basename(failedSessionFile), forkTranscriptPublication);
					if (forkArtifactPublication)
						forkArtifactPublication.cleanupStore.removeTreeExpected(
							forkArtifactPublication.cleanupRelativePath,
							forkArtifactPublication.snapshot,
						);
				} catch (cleanupError) {
					failure = new Error(`Failed to clean up managed fork destination: ${toError(cleanupError).message}`, {
						cause: toError(error),
					});
				}
			} else {
				try {
					await this.storage.unlink(failedSessionFile);
				} catch {
					// Preserve ambiguous cleanup evidence while restoring the active manager.
				}
			}
			this.#sessionId = oldSessionId;
			this.#sessionFile = oldSessionFile;
			this.#fileEntries = oldFileEntries;
			this.#sessionName = oldSessionName;
			this.#titleSource = oldTitleSource;
			this.#persistChain = Promise.resolve();
			this.#persistError = undefined;
			this.#persistErrorReported = false;
			this.#resetResidentTextBlobStore();
			this.#reexternalizeFileEntriesForResidentStore();
			this.#bumpAllRevisions();
			throw failure;
		}

		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	async copyArtifactsForFork(
		oldSessionFile: string,
		newSessionFile: string,
	): Promise<ForkArtifactPublication | undefined> {
		const sourceDir = oldSessionFile.slice(0, -6);
		const finalDestinationDir = newSessionFile.slice(0, -6);
		if (this.destination.kind !== "managed") {
			try {
				const sourceStat = fs.lstatSync(sourceDir);
				if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("unsafe_artifacts");
			} catch (error) {
				if (isEnoent(error)) return;
				throw error;
			}
			await fs.promises.cp(sourceDir, finalDestinationDir, { recursive: true });
			return undefined;
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
		let stagingSnapshot: native.NativeDirectoryTreeSnapshot | undefined;
		let publishedSnapshot: native.NativeDirectoryTreeSnapshot | undefined;
		try {
			parentStore.ensureDirectory(stagingName);
			stagingSnapshot = parentStore.captureTree(stagingName);
			for (const entry of sourceSnapshot.entries) {
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
			parentStore.moveTreeNoReplace(stagingName, destinationName, stagingSnapshot);
			publishedSnapshot = parentStore.captureTree(destinationName);
			const comparable = (tree: native.NativeDirectoryTreeSnapshot) =>
				tree.entries.map(entry => ({
					relativePath: entry.relativePath,
					kind: entry.kind,
					size: entry.kind === "file" ? entry.size : undefined,
					sha256: entry.sha256,
				}));
			if (JSON.stringify(comparable(publishedSnapshot)) !== JSON.stringify(comparable(sourceSnapshot)))
				throw new Error("artifact_destination_terminal_mismatch");
			const publishedStore = parentStore.deriveSubtree(destinationName);
			publishedStore.verifyRootSecurity();
			const retainedPublishedSnapshot = publishedStore.captureTree("");
			if (!retainedTreeSnapshotEqualsAfterRename(retainedPublishedSnapshot, publishedSnapshot))
				throw new Error("artifact_destination_retained_identity_changed");
			publishedSnapshot = retainedPublishedSnapshot;
			return {
				snapshot: publishedSnapshot,
				store: publishedStore,
				cleanupStore: parentStore,
				cleanupRelativePath: destinationName,
			};
		} catch (error) {
			try {
				if (publishedSnapshot) parentStore.removeTreeExpected(destinationName, publishedSnapshot);
				else if (stagingSnapshot) parentStore.removeTreeExpected(stagingName, stagingSnapshot);
			} catch (cleanupError) {
				throw new Error(`Failed to clean up managed fork artifacts: ${toError(cleanupError).message}`, {
					cause: toError(error),
				});
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
		const previousArtifactDir = previousSessionFile?.slice(0, -6);

		const nextDestination = (() => {
			if (this.destination.kind === "managed") {
				return managedDestination(resolvedCwd, this.storage, this.destination.securityContext.agentDir);
			}
			return this.destination;
		})();
		const newSessionDir = nextDestination.directory;
		let hadSessionFile = false;
		const managedMove = this.destination.kind === "managed" && nextDestination.kind === "managed";
		let managedSourceStore: ManagedSessionDescendantStore | undefined;
		let managedDestinationStore: ManagedSessionDescendantStore | undefined;
		let rollbackManagedMove: (() => Promise<void>) | undefined;

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
			const restoreResidentStateAfterFailure = (): void => {
				this.#fileEntries = materializedEntries;
				this.#resetResidentTextBlobStore();
				this.#reexternalizeFileEntriesForResidentStore();
				this.#bumpAllRevisions();
			};
			const restoreResidentStateAndThrow = (error: unknown): never => {
				try {
					restoreResidentStateAfterFailure();
				} catch (restoreErr) {
					throw new Error(
						`Failed to restore live session resident state after move failure: ${toError(restoreErr).message}; original error: ${toError(error).message}`,
					);
				}
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
			this.#disposeResidentTextBlobStore();
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
						if (managedTranscript)
							await managedSourceStore.publishNoReplace(path.basename(oldSessionFile), managedTranscript.bytes);
						if (managedPublishedArtifacts)
							managedDestinationStore.removeTreeExpected(
								path.basename(newArtifactDir),
								managedPublishedArtifacts,
							);
						if (managedPublishedTranscript)
							managedDestinationStore.removeExpected(path.basename(newSessionFile), managedPublishedTranscript);
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
					if (managedArtifacts)
						managedSourceStore.removeTreeExpected(path.basename(oldArtifactDir), managedArtifacts);
					if (managedTranscript)
						managedSourceStore.removeExpected(path.basename(oldSessionFile), managedTranscript);
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
						if (managedPublishedArtifacts)
							managedDestinationStore.removeTreeExpected(
								path.basename(newArtifactDir),
								managedPublishedArtifacts,
							);
						if (managedPublishedTranscript)
							managedDestinationStore.removeExpected(path.basename(newSessionFile), managedPublishedTranscript);
					} catch (rollbackErr) {
						restoreResidentStateAndThrow(
							new Error(`Failed to rollback managed move: ${toError(rollbackErr).message}`, {
								cause: toError(err),
							}),
						);
					}
				} else {
					if (movedArtifactDir) await movePathAcrossDevicesSafe(newArtifactDir, oldArtifactDir);
					if (movedSessionFile) await movePathAcrossDevicesSafe(newSessionFile, oldSessionFile);
				}
				restoreResidentStateAndThrow(err);
			}
			this.#sessionFile = newSessionFile;
			this.#fileEntries = materializedEntries;
			this.#resetResidentTextBlobStore();
			this.#reexternalizeFileEntriesForResidentStore();
			this.#bumpAllRevisions();
		}

		// Update cwd and sessionDir after the physical move succeeds, but roll the move back if metadata persistence fails.
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
			const failedSessionFile = this.#sessionFile;
			const failedArtifactDir = failedSessionFile?.slice(0, -6);
			try {
				await this.#closePersistWriter().catch(() => {});
				this.#persistChain = Promise.resolve();
				this.#persistError = undefined;
				this.#persistErrorReported = false;
				if (rollbackManagedMove) {
					await rollbackManagedMove();
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
				if (
					this.storage instanceof FileSessionStorage &&
					failedArtifactDir &&
					previousArtifactDir &&
					failedArtifactDir !== previousArtifactDir &&
					fs.existsSync(failedArtifactDir)
				) {
					await movePathAcrossDevicesSafe(failedArtifactDir, previousArtifactDir);
				}
				if (
					this.storage instanceof FileSessionStorage &&
					failedSessionFile &&
					previousSessionFile &&
					failedSessionFile !== previousSessionFile &&
					fs.existsSync(failedSessionFile)
				) {
					await movePathAcrossDevicesSafe(failedSessionFile, previousSessionFile);
				}
				this.#sessionFile = previousSessionFile;
				this.cwd = previousCwd;
				this.sessionDir = previousSessionDir;
				this.destination = previousDestination;
				this.#managedTranscriptStoreCache = null;
				const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
				if (header) applyHeaderPatch(header, { cwd: previousCwd });
				this.#headerExportRevision++;
				if (previousSessionFile && this.storage.existsSync(previousSessionFile)) await this.#rewriteFile();
			} catch (rollbackError) {
				throw new Error(`Failed to rollback session move: ${toError(rollbackError).message}`, {
					cause: toError(error),
				});
			}
			throw error;
		}

		// Update terminal breadcrumb only after the durable cwd transition succeeds.
		if (this.#sessionFile) {
			writeTerminalBreadcrumb(resolvedCwd, this.#sessionFile);
		}
	}

	/** Sync version for initial creation (no existing writer to close) */
	#newSessionSync(options?: NewSessionOptions, writeBreadcrumb = true): string | undefined {
		this.#persistChain = Promise.resolve();
		this.#persistError = undefined;
		this.#persistErrorReported = false;
		// Adopt a lifecycle pre-allocated id exactly once (the initial session of a
		// /session_create child); later new-session paths (/new, fork, branch) get
		// fresh ids so they cannot reuse the original GJC_SESSION_ID.
		const preallocated = this.#lifecycleIdAdopted ? undefined : lifecyclePreallocatedSessionId();
		if (preallocated) this.#lifecycleIdAdopted = true;
		this.#sessionId = preallocated ?? createSessionId();
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.#fileEntries = [header];
		this.#byId.clear();
		this.#labelsById.clear();
		this.#leafId = null;
		this.#flushed = false;
		this.#needsFullRewriteOnNextPersist = false;
		this.#ensuredOnDisk = false;
		this.#usageStatistics = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.#sessionFile = path.join(this.getSessionDir(), `${fileTimestamp}_${this.#sessionId}.jsonl`);
			if (writeBreadcrumb) writeTerminalBreadcrumb(this.cwd, this.#sessionFile);
		}
		this.#resetResidentTextBlobStore();
		return this.#sessionFile;
	}

	#buildIndex(): void {
		this.#byId.clear();
		this.#labelsById.clear();
		this.#leafId = null;
		this.#usageStatistics = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
		for (const entry of this.#fileEntries) {
			if (entry.type === "session") continue;
			this.#byId.set(entry.id, entry);
			this.#leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.#labelsById.set(entry.targetId, entry.label);
				} else {
					this.#labelsById.delete(entry.targetId);
				}
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				const usage = entry.message.usage;
				this.#usageStatistics.input += usage.input;
				this.#usageStatistics.output += usage.output;
				this.#usageStatistics.cacheRead += usage.cacheRead;
				this.#usageStatistics.cacheWrite += usage.cacheWrite;
				this.#usageStatistics.premiumRequests += usage.premiumRequests ?? 0;
				this.#usageStatistics.cost += usage.cost.total;
			}

			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") {
				const usage = getTaskToolUsage(entry.message.details);
				if (usage) {
					this.#usageStatistics.input += usage.input;
					this.#usageStatistics.output += usage.output;
					this.#usageStatistics.cacheRead += usage.cacheRead;
					this.#usageStatistics.cacheWrite += usage.cacheWrite;
					this.#usageStatistics.premiumRequests += usage.premiumRequests ?? 0;
					this.#usageStatistics.cost += usage.cost.total;
				}
			}
		}
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
		if (stage.persistsToExistingFile) {
			if (!this.#sessionFile) return { kind: "unknown", error: new Error("Missing staged session replacement") };
			if (this.destination.kind === "managed") {
				try {
					const persistedEntries = materializeResidentEntriesForPersistenceSync(
						[...stage.entries],
						this.#residentBlobStores(),
					).map(entry => prepareEntryForPersistenceSync(entry, this.#blobStore));
					this.#writeEntriesAtomicallySync(persistedEntries);
				} catch (error) {
					return { kind: "unknown", error: toError(error) };
				}
			} else {
				if (!stage.tempPath) return { kind: "unknown", error: new Error("Missing staged session replacement") };
				try {
					this.#closePersistWriterInternalSync();
					const replacement = this.#replaceSessionFileSync(stage.tempPath, this.#sessionFile);
					if (replacement.kind === "restored_previous") {
						return { kind: "not_promoted", error: replacement.error };
					}
				} catch (error) {
					if (this.#persistWriter?.getCloseState() === "close_failed_retryable") {
						return { kind: "not_promoted", error: new Error("Session replacement could not be completed.") };
					}
					return { kind: "unknown", error: toError(error) };
				}
			}
		}
		this.#fileEntries = [...stage.entries];
		this.#resetResidentTextBlobStore();
		this.#reexternalizeFileEntriesForResidentStore();
		this.#needsFullRewriteOnNextPersist = false;
		this.#flushed = stage.persistsToExistingFile;
		this.#ensuredOnDisk = stage.persistsToExistingFile;
		this.#bumpAllRevisions();
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
		await this.#queuePersistTask(async () => {
			if (this.#persistWriter) {
				await this.#closePersistWriterInternal();
				this.#flushed = true;
			}
		});
		this.#disposeResidentTextBlobStore();
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
			this.#disposeResidentTextBlobStore();
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
		if (this.destination.kind !== "managed" || !this.#sessionFile || this.#adoptedArtifactManager) return null;
		const store = this.#managedTranscriptStore();
		const legacyArtifactsRoot = path.basename(this.#sessionFile.slice(0, -6));
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

	/**
	 * Returns the ArtifactManager this session writes through. Lazily creates
	 * one bound to the current session file unless an external manager was
	 * adopted via `adoptArtifactManager`. Returns null only for non-persistent
	 * sessions with no adopted manager.
	 */
	getArtifactManager(): ArtifactManager | null {
		return this.#getOrCreateArtifactManager();
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
	 * Returns an artifact ID for all sessions (file-backed for persistent, in-memory fallback otherwise).
	 */
	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#getOrCreateArtifactManager();
		if (manager) return manager.save(content, toolType);
		// Non-persistent session: store in memory so spill truncation can proceed.
		if (!this.#inMemoryArtifacts) this.#inMemoryArtifacts = new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	/**
	 * Resolve an artifact ID to an on-disk path for the current session.
	 * Returns null when missing or when the session is not persisted.
	 */
	async getArtifactPath(id: string): Promise<string | null> {
		const manager = this.#getOrCreateArtifactManager();
		if (!manager) return null;
		return manager.getPath(id);
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
	async setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
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

	#appendManagedRecordSync(record: FileEntry | SessionPatchRecord): void {
		if (!this.#sessionFile) throw new Error("Managed transcript path is unavailable");
		const store = this.#managedTranscriptStore();
		const relativePath = path.basename(this.#sessionFile);
		store.appendSync(relativePath, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
	}

	async #persistPatch(record: SessionPatchRecord): Promise<void> {
		if (!this.persist || !this.#sessionFile || !this.storage.existsSync(this.#sessionFile)) return;
		await this.#queuePersistTask(async () => {
			const header = this.#fileEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
			if (this.#needsFullRewriteOnNextPersist || !this.#flushed || (header?.version ?? 1) < CURRENT_SESSION_VERSION)
				return this.#rewriteFileContents();
			const persistedRecord =
				record.type === "entry_patch"
					? (prepareEntryForPersistenceSync(
							materializeResidentEntryForPersistenceSync(
								record as unknown as FileEntry,
								this.#residentBlobStores(),
								new Map(),
							),
							this.#blobStore,
						) as unknown as SessionPatchRecord)
					: record;
			if (this.destination.kind === "managed") {
				this.#appendManagedRecordSync(persistedRecord);
				return;
			}
			const writer = this.#ensurePersistWriter();
			if (!writer) return this.#rewriteFileContents();
			await writer.write(persistedRecord);
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
				this.#appendManagedRecordSync(persistedEntry);
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
		const normalizedEntry = normalizeSessionEntryForStorage(entry);
		const residentEntry = prepareEntryForResidentSync(normalizedEntry, this.#residentBlobStores()) as SessionEntry;
		this.#fileEntries.push(residentEntry);
		this.#byId.set(residentEntry.id, residentEntry);
		this.#leafId = residentEntry.id;
		this.#bumpEntryRevision();
		this.#leafRevision++;
		if (entry.type === "label") this.#labelRevision++;
		this._persist(residentEntry);
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			this.#usageStatistics.input += usage.input;
			this.#usageStatistics.output += usage.output;
			this.#usageStatistics.cacheRead += usage.cacheRead;
			this.#usageStatistics.cacheWrite += usage.cacheWrite;
			this.#usageStatistics.premiumRequests += usage.premiumRequests ?? 0;
			this.#usageStatistics.cost += usage.cost.total;
		}

		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") {
			const usage = getTaskToolUsage(entry.message.details);
			if (usage) {
				this.#usageStatistics.input += usage.input;
				this.#usageStatistics.output += usage.output;
				this.#usageStatistics.cacheRead += usage.cacheRead;
				this.#usageStatistics.cacheWrite += usage.cacheWrite;
				this.#usageStatistics.premiumRequests += usage.premiumRequests ?? 0;
				this.#usageStatistics.cost += usage.cost.total;
			}
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
		for (const updated of entries) {
			const canonical = this.#byId.get(updated.id);
			if (canonical?.type !== "message") continue;
			const residentEntry = prepareEntryForResidentSync(
				{ ...canonical, message: updated.message },
				this.#residentBlobStores(),
			) as SessionMessageEntry;
			canonical.message = residentEntry.message;
		}
		this.#needsFullRewriteOnNextPersist = true;
		this.#bumpEntryRevision();
		this.#replayMetadataRevision++;
	}

	/** Write mutated custom-message entries back into the canonical entry store by id. */
	applyCustomMessageEntryUpdates(entries: readonly CustomMessageEntry[]): void {
		for (const updated of entries) {
			const canonical = this.#byId.get(updated.id);
			if (canonical?.type !== "custom_message") continue;
			canonical.content = updated.content;
			canonical.details = updated.details;
			// Pruning replaces content permanently; retaining a cold-spill marker would
			// rehydrate the superseded payload on the next materialization.
			canonical.evictedContent = undefined;
		}
		this.#needsFullRewriteOnNextPersist = true;
		this.#bumpEntryRevision();
		this.#replayMetadataRevision++;
	}

	/**
	 * Rewrite the session file after in-place entry updates.
	 * Use sparingly (e.g., pruning old tool outputs).
	 */
	async rewriteEntries(): Promise<void> {
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
			publicMaterializerCallCount: this.#publicMaterializerCallCount,
			getEntryMaterializerCallCount: this.#getEntryMaterializerCallCount,
			getBranchMaterializerCallCount: this.#getBranchMaterializerCallCount,
			getEntriesMaterializerCallCount: this.#getEntriesMaterializerCallCount,
			materializedEntriesCachePopulateCount: this.#materializedEntriesCachePopulateCount,
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
						this.#blobStore,
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
						this.#blobStore,
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
						this.#blobStore,
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
	 * The strong reference avoids GC-driven rebuilds during a session.
	 */
	#getSessionContextForRead(): Readonly<SessionContext> {
		const cached = this.#sessionContextCache;
		if (
			cached &&
			this.#sessionContextEntryRevision === this.#entryRevision &&
			this.#sessionContextLeafRevision === this.#leafRevision &&
			this.#sessionContextReplayMetadataRevision === this.#replayMetadataRevision
		) {
			return cached;
		}
		this.#pathOnlyContextBuildCount++;
		const context = buildSessionContext(
			this.#getActivePathEntriesForProviderContext(),
			this.#leafId,
			undefined,
			this.#sessionId,
		);
		this.#sessionContextCache = freezeInternalReadSnapshot(context);
		transferSessionMessageIdentity(context.messages, this.#sessionContextCache.messages);
		this.#sessionContextEntryRevision = this.#entryRevision;
		this.#sessionContextLeafRevision = this.#leafRevision;
		this.#sessionContextReplayMetadataRevision = this.#replayMetadataRevision;
		return this.#sessionContextCache;
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
			this.#blobStore,
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
		return this.#sanitizeLoadedOpenAIResponsesReplayMetadata().length > 0;
	}

	async #sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist(): Promise<boolean> {
		const patches = this.#sanitizeLoadedOpenAIResponsesReplayMetadata();
		for (const patch of patches) {
			await this.#persistPatch(patch);
		}
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
		if (this.#materializedEntriesRevision === this.#entryRevision && this.#materializedEntriesCache) {
			return this.#materializedEntriesCache;
		}
		this.#materializedEntriesCachePopulateCount++;
		const resolvedTextBlobCache = new Map<string, string>();
		const sourceEntries = this.#fileEntries.filter((e): e is SessionEntry => e.type !== "session");
		const materializedEntries = sourceEntries.map(entry =>
			materializeResidentEntryForReadSync(entry, this.#residentBlobStores(), resolvedTextBlobCache),
		);
		if (!sourceEntries.some(entry => containsResidentImageSentinel(entry))) {
			this.#materializedEntriesCache = materializedEntries;
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
		this.#leafId = null;
		this.#leafRevision++;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
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
			if (this.destination.kind === "managed") {
				this.#managedTranscriptStore(newSessionFile).publishNoReplaceSync(
					path.basename(newSessionFile),
					Buffer.from(`${lines.join("\n")}\n`, "utf8"),
				);
			} else {
				this.storage.writeTextSync(newSessionFile, `${lines.join("\n")}\n`);
			}
			this.#sessionId = newSessionId;
			this.#sessionFile = newSessionFile;
			this.#resetResidentTextBlobStore();
			this.#fileEntries = [
				header,
				...materializedPathWithoutLabels.map(
					entry => prepareEntryForResidentSync(entry, this.#residentBlobStores()) as SessionEntry,
				),
				...labelEntries,
			];
			this.#flushed = true;
			this.#buildIndex();
			this.#bumpAllRevisions();
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
		this.#sessionId = newSessionId;
		this.#resetResidentTextBlobStore();
		this.#fileEntries = [
			header,
			...materializedPathWithoutLabels.map(
				entry => prepareEntryForResidentSync(entry, this.#residentBlobStores()) as SessionEntry,
			),
			...labelEntries,
		];
		this.#buildIndex();
		this.#bumpAllRevisions();
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
		const securityContext = createManagedSessionSecurityContext({
			agentDir: rootAuthority.canonicalPath,
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
			assertManagedDirectoryRoot(destination.securityContext.rootAuthority);
			managedDestinationStore.assertBound();
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
		const opened = await openManagedCandidateForWrite(
			resolved.scope,
			candidate,
			expectedIdentity ?? inspected.identity,
			migrationPolicy,
			authority,
		);
		assertManagedDestinationBound();
		if (opened.kind === "error") {
			if (opened.code === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
			throw new Error(`Could not open managed session: ${opened.message}`);
		}
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
		manager.#fileEntries = forkEntries;
		const sourceHeader = manager.#fileEntries.find(e => e.type === "session") as SessionHeader | undefined;
		const historyEntries = manager.#fileEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		manager.#newSessionSync({ parentSession: sourceHeader?.id });
		manager.#resetResidentTextBlobStore();
		const newHeader = manager.#fileEntries[0] as SessionHeader;
		newHeader.title = sourceHeader?.title;
		newHeader.titleSource = sourceHeader?.titleSource;
		manager.#fileEntries = [
			newHeader,
			...historyEntries.map(
				entry => prepareEntryForResidentSync(entry, manager.#residentBlobStores()) as SessionEntry,
			),
		];
		manager.#sessionName = newHeader.title;
		manager.#titleSource = newHeader.titleSource;
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#buildIndex();
		manager.#bumpAllRevisions();
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
			throw new Error(`Could not open session: ${inspected.reason}`);
		}
		const opened = await SessionManager.openExistingStrict(inspected.identity, destination, storage, migrationPolicy);
		if (opened.kind === "error") throw new Error(`Could not open session: ${opened.reason}`);
		return opened.manager;
	}

	static async openNestedManaged(
		filePath: string,
		destination: SessionDestination,
		store: ManagedSessionDescendantStore,
		storage: SessionStorage = new FileSessionStorage(),
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
		const manager = new SessionManager(
			header?.cwd ?? getProjectDir(),
			destination.directory,
			true,
			storage,
			destination,
		);
		manager.#sessionFile = resolved;
		writeTerminalBreadcrumb(manager.cwd, resolved);
		manager.#fileEntries = entries;
		if (entries.length > 0) {
			manager.#sessionId = header?.id ?? createSessionId();
			manager.#sessionName = header?.title;
			manager.#titleSource = header?.titleSource;
			manager.#needsFullRewriteOnNextPersist = migrateToCurrentVersion(manager.#fileEntries);
			await resolveBlobRefsInEntries(manager.#fileEntries, manager.#blobStore);
			manager.#resetResidentTextBlobStore();
			manager.#fileEntries = manager.#fileEntries.map(entry =>
				prepareEntryForResidentSync(entry, manager.#residentBlobStores()),
			);
			manager.#buildIndex();
			manager.#bumpAllRevisions();
			manager.#flushed = true;
			manager.#ensuredOnDisk = true;
			await manager.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
		} else {
			manager.#newSessionSync();
			manager.#sessionFile = resolved;
			manager.#resetResidentTextBlobStore();
			await manager.#rewriteFile();
			manager.#flushed = true;
			manager.#ensuredOnDisk = true;
			manager.#bumpAllRevisions();
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
		return await collectSessionsFromFiles(
			listing.owned.map(candidate => candidate.path),
			storage,
		);
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

	/** Tombstone and exact-delete a default-managed candidate. */
	static async deleteManagedCandidate(sessionPath: string): Promise<void> {
		const storage = new FileSessionStorage();
		const entries = await loadEntriesFromFile(sessionPath, storage);
		const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		if (!header?.cwd) throw new Error("Session has no valid managed workspace header.");
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
		if (deleted.kind === "error") throw new Error(`Could not delete managed session: ${deleted.message}`);
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
		const removeSessionDirOnFailure =
			destination.kind !== "managed" &&
			snapshot.storage instanceof FileSessionStorage &&
			!snapshot.storage.existsSync(dir);
		let managedForkStore: ManagedSessionDescendantStore | undefined;
		let managedForkTranscript: ManagedFileSnapshot | null = null;
		let manager: SessionManager | undefined;
		let authorityFailure: StrictSessionOpenFailure | undefined;
		try {
			manager = new SessionManager(cwd, dir, true, snapshot.storage, destination);
			await resolveBlobRefsInEntries(forkEntries, manager.#blobStore);
			manager.#fileEntries = forkEntries;
			const sourceHeader = manager.#fileEntries.find(e => e.type === "session") as SessionHeader | undefined;
			const historyEntries = manager.#fileEntries.filter(entry => entry.type !== "session") as SessionEntry[];
			manager.#newSessionSync({ parentSession: sourceHeader?.id }, false);
			manager.#resetResidentTextBlobStore();
			const newHeader = manager.#fileEntries[0] as SessionHeader;
			newHeader.title = sourceHeader?.title;
			newHeader.titleSource = sourceHeader?.titleSource;
			const residentBlobStores = manager.#residentBlobStores();
			manager.#fileEntries = [
				newHeader,
				...historyEntries.map(entry => prepareEntryForResidentSync(entry, residentBlobStores) as SessionEntry),
			];
			manager.#sessionName = newHeader.title;
			manager.#titleSource = newHeader.titleSource;
			manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
			manager.#buildIndex();
			manager.#bumpAllRevisions();
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
			if (manager.#sessionFile) writeTerminalBreadcrumb(manager.cwd, manager.#sessionFile);
			return { kind: "forked", manager };
		} catch (error) {
			if (manager) {
				const sessionFile = manager.#sessionFile;
				const cleanupErrors: Error[] = [];
				try {
					await manager.close();
				} catch (cleanupError) {
					cleanupErrors.push(toError(cleanupError));
				}
				if (sessionFile) {
					if (destination.kind === "managed") {
						try {
							if (managedForkStore && managedForkTranscript)
								managedForkStore.removeExpected(path.basename(sessionFile), managedForkTranscript);
						} catch (cleanupError) {
							cleanupErrors.push(toError(cleanupError));
						}
					} else {
						try {
							await manager.storage.unlink(sessionFile);
						} catch (cleanupError) {
							if (!isEnoent(cleanupError)) cleanupErrors.push(toError(cleanupError));
						}
						if (manager.storage instanceof FileSessionStorage) {
							try {
								await fs.promises.rm(sessionFile.slice(0, -6), { recursive: true, force: true });
							} catch (cleanupError) {
								cleanupErrors.push(toError(cleanupError));
							}
							try {
								const sessionFileName = path.basename(sessionFile);
								const transientPrefix = `.${sessionFileName}.`;
								const backupPrefix = `${sessionFileName}.`;
								for (const name of await fs.promises.readdir(path.dirname(sessionFile))) {
									if (
										(name.startsWith(transientPrefix) && name.endsWith(".tmp")) ||
										(name.startsWith(backupPrefix) && name.endsWith(".bak"))
									) {
										await fs.promises.rm(path.join(path.dirname(sessionFile), name), {
											recursive: true,
											force: true,
										});
									}
								}
							} catch (cleanupError) {
								if (!isEnoent(cleanupError)) cleanupErrors.push(toError(cleanupError));
							}
						}
					}
				}
				if (removeSessionDirOnFailure) {
					try {
						await fs.promises.rmdir(dir);
					} catch (cleanupError) {
						const code = (cleanupError as NodeJS.ErrnoException).code;
						if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
							cleanupErrors.push(toError(cleanupError));
					}
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
		await manager.#hydrateExistingSession(identity.canonicalPath, inspected.entries, false);
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
		await this.#sanitizeLoadedOpenAIResponsesReplayMetadataAndPersist();
		writeTerminalBreadcrumb(this.cwd, context.identity.canonicalPath);
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
		const ownershipInspection = inspectResumeSessionFile(sessionPath, storage);
		if ("kind" in ownershipInspection) {
			await manager.close();
			return ownershipInspection;
		}
		if (!sameResumeIdentity(inspected.identity, ownershipInspection.identity)) {
			await manager.close();
			return { kind: "error", reason: "identity-mismatch" };
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
			if (inspected.kind === "error") return undefined;
			const opened = await SessionManager.openExistingStrict(
				inspected.identity,
				destination,
				storage,
				migrationPolicy,
			);
			if (opened.kind === "error") {
				if (opened.reason === "legacy_migration_disabled") throw new SessionMigrationPolicyError();
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
