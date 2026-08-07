import { writeCheckpoint } from "./continuity/checkpoint";
import { readResumePacket } from "./continuity/resume";
import { runDoctor } from "./doctor/report";
import { formatMemoryUri as formatMemoryUriInternal, parseMemoryUri as parseMemoryUriInternal } from "./documents/uri";
import { type MemoryEnvironment, type MemoryScopeKind, validateMemoryEnvironment } from "./env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "./errors";
import { admitMemoryPolicy, enforceMemoryWritePolicy } from "./policy/policy-admission";
import { resolveReadableResource as resolveReadableResourceInternal } from "./resources/resolve-readable-resource";
import { resolveReadableResourceSync as resolveReadableResourceSyncInternal } from "./resources/resolve-readable-resource-sync";
import { SCHEMA_VERSIONS } from "./schemas";
import type { ProjectIdentityRegistry } from "./scope/project-identity";
import {
	type ScopeResolutionResult as InternalScopeResolutionResult,
	resolveScopes as resolveScopesInternal,
} from "./scope/scope-resolver";
import { recallMemory, searchMemory } from "./search/retrieval-pipeline";
import { createMemoryRootScaffold, MemoryBootstrapError } from "./storage/bootstrap-init";
import { admitPendingJournals } from "./storage/journal";
import { applyMemory } from "./writes/apply";
import { forgetMemory } from "./writes/forget";
import { proposeMemory } from "./writes/proposal";

export type {
	MemoryEnvironment,
	MemoryScopeKind,
	ProjectIdentity,
	RepositoryRemote,
	RepositorySnapshot,
} from "./env";
export {
	EXIT_CODES,
	MEMORY_ERROR_SCHEMA_VERSION,
	MEMORY_EXIT_CODES,
	type MemoryError,
	type MemoryErrorEnvelope,
	type MemoryExitCode,
	type MemoryResult,
	memoryErrorEnvelope,
} from "./errors";
export type {
	MemoryJsonSchema,
	MemorySchemaName,
	MemorySchemaVersion,
} from "./schemas";
export {
	applyReceiptSchema,
	auditSchema,
	capabilitiesSchema,
	checkpointSchema,
	errorSchema,
	forgetReceiptSchema,
	handoffSchema,
	initReceiptSchema,
	recallSchema,
	resourceSchema,
	retrievalLedgerEntrySchema,
	SCHEMA_REGISTRY,
	SCHEMA_VERSIONS,
	scopeResolutionSchema,
	searchResultSchema,
	writeProposalSchema,
} from "./schemas";

export type AuthorityTier =
	| "user-confirmed"
	| "repository-reviewed"
	| "project-config"
	| "tool-verified"
	| "session-observed"
	| "model-inferred"
	| "unverified";

export type Volatility = "stable" | "volatile" | "historical";

export type Sensitivity = "public-safe" | "private" | "restricted";

export type DocumentStatus = "active" | "proposed" | "superseded" | "archived" | "rejected";

export type MemoryDocumentType =
	| "preference"
	| "constraint"
	| "policy"
	| "convention"
	| "decision"
	| "fact"
	| "observation"
	| "hypothesis"
	| "task-state"
	| "handoff"
	| "checkpoint"
	| "note";

export type MemoryIntent =
	| "user-preference"
	| "project-convention"
	| "architecture-rationale"
	| "decision-history"
	| "current-task-status"
	| "resume-session"
	| "person-identity"
	| "environment"
	| "debugging-history"
	| "workflow-policy"
	| "generic-recall";

export type RetrievalStage = "map-route" | "metadata" | "heading" | "lexical" | "fuzzy";

export type WriteDestination =
	| "global-canonical"
	| "project-canonical"
	| "session"
	| "proposal"
	| "checkpoint"
	| "ledger"
	| "redact-output"
	| "export-output"
	| "explain-output"
	| "doctor-report";

export interface MemoryUri {
	readonly scheme: MemoryScopeKind;
	readonly path: readonly string[];
	readonly fragment: string | null;
	readonly href: string;
}

export interface SensitivityFinding {
	readonly kind: "secret-pattern" | "sensitivity-label";
	readonly patternId: string | null;
	readonly sensitivity: Sensitivity;
	readonly line: number;
	readonly excerptRedacted: string;
}

export interface MemoryCitation {
	readonly uri: string;
	readonly scope: MemoryScopeKind;
	readonly relPath: string;
	readonly heading: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly authority: AuthorityTier;
	readonly volatility: Volatility;
	readonly updatedAt: string;
	readonly digest: string;
}

/** A citation selected by retrieval, with deterministic ranking metadata. */
export interface RecallSource extends MemoryCitation {
	readonly score: number;
	readonly stage: RetrievalStage;
}

export type Citation = MemoryCitation;

export interface MemoryClaim {
	readonly claimKey: string;
	readonly text: string;
	readonly type: MemoryDocumentType;
	readonly authority: AuthorityTier;
	readonly freshness: string;
	readonly volatility: Volatility;
	readonly source: MemoryCitation;
}

export type Claim = MemoryClaim;

export interface VolatileClaim {
	readonly claim: string;
	readonly verificationRequired: boolean;
	readonly verificationHint: {
		readonly provider: string;
		readonly resource: string;
		readonly id: string;
	} | null;
}

export interface MemoryConflict {
	readonly claimKey: string;
	readonly conflict: boolean;
	readonly resolution: {
		readonly value: string;
		readonly source: string;
		readonly reason: string;
	} | null;
	readonly rejected: readonly {
		readonly value: string;
		readonly source: string;
		readonly reason: string;
	}[];
	readonly requiresUserConfirmation: boolean;
	readonly dimensions: {
		readonly authority: string;
		readonly specificity: string;
		readonly freshness: string;
		readonly volatility: string;
	};
}

export type Conflict = MemoryConflict;
export type ConflictResult = MemoryConflict;

export interface RecallResult {
	readonly schemaVersion: "gajae.memory.recall.v1";
	readonly queryId: string;
	readonly query: string;
	readonly intent: MemoryIntent;
	readonly projectKey: string;
	readonly status: "matched" | "no-match" | "conflict";
	readonly sources: readonly RecallSource[];
	readonly resolutions: readonly ConflictResult[];
	readonly conflicts: readonly ConflictResult[];
	readonly volatileClaims: readonly VolatileClaim[];
	readonly truncated: boolean;
	readonly ledgerId: string | null;
	readonly budget?: SearchBudgetState;
	readonly explain?: RetrievalExplain;
	readonly partial: boolean;
}

export interface InitMemoryRootResult {
	readonly schemaVersion: "gajae.memory.init-receipt.v1";
	readonly memoryRoot: string;
	readonly created: readonly string[];
	readonly alreadyPresent: readonly string[];
}

export interface ResolvedScope {
	readonly kind: MemoryScopeKind;
	/** Root-relative POSIX path, or null when the scope is unavailable. */
	readonly relPath: string | null;
	/** Absolute scope root, or null when the scope is unavailable. */
	readonly root: string | null;
	readonly writable: boolean;
	readonly available: boolean;
	readonly unavailableReason: string | null;
}

export interface ScopeResolution {
	readonly schemaVersion: "gajae.memory.scope-resolution.v1";
	/** Absolute canonical memory root used for path inspection. */
	readonly memoryRoot: string;
	readonly projectKey: string | null;
	readonly sessionId: string | null;
	readonly scopes: readonly ResolvedScope[];
}

export interface ResolveScopesInput {
	readonly registry?: unknown;
}

export interface ResolveReadableResourceInput {
	readonly uri: string;
}

export interface ResolveReadableResourceResult {
	readonly uri: string;
	readonly relPath: string;
	readonly contentType: "text/markdown" | "text/plain" | "application/json";
	readonly content: string;
	readonly size: number;
	readonly digest: string;
	readonly citation: MemoryCitation;
}

export interface ResolveReadableResourceSyncResult {
	readonly absolutePath: string;
}

export interface SearchInput {
	readonly query: string;
	readonly intent?: MemoryIntent;
	readonly scopes?: readonly MemoryScopeKind[];
	readonly limit?: number;
	readonly explain?: boolean;
	readonly complete?: boolean;
}

export type SearchBudgetDimension = "maps" | "files" | "sections" | "chars";

export interface SearchBudgetLimits {
	readonly maxMaps: number;
	readonly maxFiles: number;
	readonly maxSections: number;
	readonly maxChars: number;
}

export interface SearchBudgetUsage {
	readonly maps: number;
	readonly files: number;
	readonly sections: number;
	readonly chars: number;
}

export interface SearchBudgetDrop {
	readonly candidateId: string;
	readonly dimension: SearchBudgetDimension;
	readonly amount: number;
	readonly reason: "limit" | "invalid-amount";
}

export interface SearchBudgetState {
	readonly limits: SearchBudgetLimits;
	readonly usage: SearchBudgetUsage;
	readonly droppedCandidates: readonly string[];
	readonly drops: readonly SearchBudgetDrop[];
	readonly truncated: boolean;
}

export interface RetrievalStageCounts {
	readonly "map-route": number;
	readonly metadata: number;
	readonly heading: number;
	readonly lexical: number;
	readonly fuzzy: number;
}

export interface RetrievalRankingFactor {
	readonly uri: string;
	readonly score: number;
	readonly stage: RetrievalStage;
}

export interface RetrievalExclusionReason {
	readonly uri: string | null;
	readonly reason: string;
	readonly stage: RetrievalStage | null;
}

export interface RetrievalExplain {
	readonly scopes: readonly MemoryScopeKind[];
	readonly intent: MemoryIntent;
	readonly routesConsidered: readonly string[];
	readonly stageCounts: RetrievalStageCounts;
	readonly rankingFactors: readonly RetrievalRankingFactor[];
	readonly exclusionReasons: readonly RetrievalExclusionReason[];
	readonly mapsRead: number;
	readonly candidateCount: number;
	readonly selectedCount: number;
	readonly sourcesSelected: readonly RecallSource[];
	readonly rejectedCount: number;
	readonly budget: SearchBudgetState;
	readonly conflicts: readonly string[];
	readonly hints: readonly string[];
	readonly truncated: boolean;
	readonly timings?: Readonly<{ readonly totalMs: number }>;
}

export interface SearchResult {
	readonly schemaVersion: "gajae.memory.search-result.v1";
	readonly queryId: string;
	readonly query: string;
	readonly sources: readonly RecallSource[];
	readonly truncated: boolean;
	readonly budget?: SearchBudgetState;
	readonly explain?: RetrievalExplain;
	readonly partial: boolean;
	readonly ledgerId: string | null;
}

export interface GetInput {
	readonly uri: string;
	readonly heading?: string;
}

export interface GetResult extends ResolveReadableResourceResult {
	readonly uri: string;
}

export interface CheckpointInput {
	readonly goal: string;
	readonly task: string;
	/** At most three entries; the checkpoint document caps the section. */
	readonly nextSteps: readonly string[];
	readonly constraints?: readonly string[];
	readonly decisions?: readonly string[];
	readonly risks?: readonly string[];
}

export interface CheckpointResult {
	readonly schemaVersion: "gajae.memory.checkpoint.v1";
	readonly uri: string;
	readonly digest: string;
	readonly sessionId: string;
}

export interface ResumeInput {
	readonly sessionId?: string;
}

export interface ResumeResult {
	readonly schemaVersion: "gajae.memory.handoff.v1";
	readonly sessionId: string;
	readonly goal: string;
	readonly task: string;
	readonly nextSteps: readonly string[];
}

export interface ProposeInput {
	readonly type: MemoryDocumentType;
	readonly content: string;
	readonly targetScope?: MemoryScopeKind;
	readonly targetUri?: string;
	readonly sourceSession?: string | null;
	readonly supersedes?: readonly string[];
}

export interface WriteProposal {
	readonly schemaVersion: "gajae.memory.write-proposal.v1";
	readonly proposalId: string;
	readonly type: MemoryDocumentType;
	readonly recommendedScope: MemoryScopeKind;
	readonly recommendedUri: string;
	readonly recommendedRelPath: string;
	readonly requiresApproval: boolean;
	readonly sourceSession: string | null;
	readonly diff: string;
	/** CAS precondition captured at propose time. */
	readonly expectedDigest: string | null;
	readonly supersedes: readonly string[];
	readonly sensitivityFindings: readonly SensitivityFinding[];
	readonly conflicts: readonly ConflictResult[];
	readonly mapUpdates: readonly string[];
}

export interface ApplyInput {
	readonly proposalId: string;
}

export interface ApplyReceipt {
	readonly schemaVersion: "gajae.memory.apply-receipt.v1";
	readonly proposalId: string;
	readonly mutationId: string;
	readonly applied: boolean;
	readonly changed: readonly string[];
	readonly superseded: readonly string[];
}

export interface ForgetInput {
	readonly uri: string;
	readonly expectedDigest?: string | null;
	readonly reason?: string;
}

export interface ForgetReceipt {
	readonly schemaVersion: "gajae.memory.forget-receipt.v1";
	readonly uri: string;
	readonly forgotten: boolean;
	readonly superseded: boolean;
	readonly marker: string | null;
}

export type DoctorSeverity = "info" | "warning" | "error";

export interface DoctorFinding {
	readonly code: string;
	readonly severity: DoctorSeverity;
	/** Root-relative POSIX path, or null when the finding is store-wide. */
	readonly relPath: string | null;
	readonly detail: string;
}

export interface DoctorInput {
	readonly maxBytes?: number;
}

export interface DoctorResult {
	readonly schemaVersion: "gajae.memory.audit.v1";
	readonly healthy: boolean;
	readonly findings: readonly DoctorFinding[];
}

export interface RecallInput {
	readonly query: string;
	readonly intent?: MemoryIntent;
	readonly scopes?: readonly MemoryScopeKind[];
	readonly limit?: number;
	readonly explain?: boolean;
	readonly complete?: boolean;
	readonly requireResolved?: boolean;
}

export type MemoryCommand =
	| "init"
	| "capabilities"
	| "scopes"
	| "resolve"
	| "get"
	| "search"
	| "recall"
	| "checkpoint"
	| "resume"
	| "doctor"
	| "propose"
	| "apply"
	| "forget";
export type MemoryAgentTool = "memory_recall" | "memory_checkpoint" | "memory_propose_write" | "memory_forget";
export type MemoryOptionalFeature =
	| "answer"
	| "mcp"
	| "embeddings"
	| "graphrag"
	| "legacy-data-migration"
	| "remote-service";

export interface MemoryFeatureFlags {
	readonly deterministicRetrieval: true;
	readonly writes: true;
	readonly checkpointResume: true;
}

export interface MemorySchemaVersions {
	readonly capabilities: "gajae.memory.capabilities.v1";
	readonly initReceipt: "gajae.memory.init-receipt.v1";
	readonly scopeResolution: "gajae.memory.scope-resolution.v1";
	readonly searchResult: "gajae.memory.search-result.v1";
	readonly recall: "gajae.memory.recall.v1";
	readonly retrievalLedgerEntry: "gajae.memory.retrieval-ledger-entry.v1";
	readonly error: "gajae.memory.error.v1";
	readonly checkpoint: "gajae.memory.checkpoint.v1";
	readonly handoff: "gajae.memory.handoff.v1";
	readonly audit: "gajae.memory.audit.v1";
	readonly writeProposal: "gajae.memory.write-proposal.v1";
	readonly applyReceipt: "gajae.memory.apply-receipt.v1";
	readonly forgetReceipt: "gajae.memory.forget-receipt.v1";
	readonly resource: "gajae.memory.resource.v1";
}

export interface MemoryCapabilities {
	readonly schemaVersion: "gajae.memory.capabilities.v1";
	readonly packageVersion: "0.12.0";
	readonly milestone: "M6";
	readonly commands: readonly MemoryCommand[];
	readonly agentTools: readonly MemoryAgentTool[];
	readonly schemaVersions: MemorySchemaVersions;
	readonly features: MemoryFeatureFlags;
	readonly absentOptionalFeatures: readonly MemoryOptionalFeature[];
}

const MILESTONE_COMMANDS = Object.freeze([
	"init",
	"capabilities",
	"scopes",
	"resolve",
	"get",
	"search",
	"recall",
	"checkpoint",
	"resume",
	"doctor",
	"propose",
	"apply",
	"forget",
] as const);
const MILESTONE_AGENT_TOOLS = Object.freeze([
	"memory_recall",
	"memory_checkpoint",
	"memory_propose_write",
	"memory_forget",
] as const);
const MILESTONE_SCHEMA_VERSIONS = Object.freeze({
	capabilities: SCHEMA_VERSIONS.capabilities,
	initReceipt: SCHEMA_VERSIONS.initReceipt,
	scopeResolution: SCHEMA_VERSIONS.scopeResolution,
	searchResult: SCHEMA_VERSIONS.searchResult,
	recall: SCHEMA_VERSIONS.recall,
	retrievalLedgerEntry: SCHEMA_VERSIONS.retrievalLedgerEntry,
	error: SCHEMA_VERSIONS.error,
	checkpoint: SCHEMA_VERSIONS.checkpoint,
	handoff: SCHEMA_VERSIONS.handoff,
	audit: SCHEMA_VERSIONS.audit,
	writeProposal: SCHEMA_VERSIONS.writeProposal,
	applyReceipt: SCHEMA_VERSIONS.applyReceipt,
	forgetReceipt: SCHEMA_VERSIONS.forgetReceipt,
	resource: SCHEMA_VERSIONS.resource,
} as const);
const MILESTONE_FEATURES = Object.freeze({
	deterministicRetrieval: true,
	writes: true,
	checkpointResume: true,
} as const);
const MILESTONE_ABSENT_OPTIONAL_FEATURES = Object.freeze([
	"answer",
	"mcp",
	"embeddings",
	"graphrag",
	"legacy-data-migration",
	"remote-service",
] as const);
const MEMORY_CAPABILITIES = Object.freeze({
	schemaVersion: "gajae.memory.capabilities.v1",
	packageVersion: "0.12.0",
	milestone: "M6",
	commands: MILESTONE_COMMANDS,
	agentTools: MILESTONE_AGENT_TOOLS,
	schemaVersions: MILESTONE_SCHEMA_VERSIONS,
	features: MILESTONE_FEATURES,
	absentOptionalFeatures: MILESTONE_ABSENT_OPTIONAL_FEATURES,
} satisfies MemoryCapabilities);

export function memoryCapabilities(): MemoryCapabilities {
	return MEMORY_CAPABILITIES;
}

export function parseMemoryUri(raw: string): MemoryResult<MemoryUri> {
	return parseMemoryUriInternal(raw);
}

export function formatMemoryUri(uri: MemoryUri): MemoryResult<string> {
	return formatMemoryUriInternal(uri);
}

function publicScopePath(scope: MemoryScopeKind, projectKey: string | null, sessionId: string | null): string | null {
	switch (scope) {
		case "global":
			return "global";
		case "project":
			return projectKey === null ? null : `projects/${projectKey}`;
		case "session":
			return sessionId === null ? null : `sessions/${sessionId}`;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicDoctorInput(value: unknown): MemoryResult<DoctorInput> {
	try {
		if (value === undefined) return { ok: true, value: Object.freeze({}) };
		if (!isRecord(value)) return invalidInput("memory doctor input must be an object");
		if (Reflect.ownKeys(value).some(key => key !== "maxBytes")) {
			return invalidInput("memory doctor input contains unsupported fields");
		}
		if (!Object.hasOwn(value, "maxBytes") || value.maxBytes === undefined) {
			return { ok: true, value: Object.freeze({}) };
		}
		const maxBytes = value.maxBytes;
		if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			return invalidInput("memory doctor maxBytes must be a positive safe integer");
		}
		return { ok: true, value: Object.freeze({ maxBytes }) };
	} catch {
		return invalidInput("memory doctor input is invalid");
	}
}

function isProjectIdentityRegistryInput(value: unknown): value is ProjectIdentityRegistry {
	return value === undefined || value === null || typeof value === "string" || isRecord(value);
}

function publicScopeRegistry(input: unknown): MemoryResult<ProjectIdentityRegistry> {
	try {
		if (input === undefined || input === null || typeof input === "string") return { ok: true, value: input };
		if (!isRecord(input)) return invalidInput("scope resolver input must be a registry object or string");
		if (Object.hasOwn(input, "registry")) {
			const registry = input.registry;
			if (!isProjectIdentityRegistryInput(registry)) {
				return invalidInput("scope resolver registry must be an object, string, null, or undefined");
			}
			return { ok: true, value: registry };
		}
		return { ok: true, value: input };
	} catch {
		return invalidInput("scope resolver input is invalid");
	}
}

function publicScopeResolution(value: InternalScopeResolutionResult): ScopeResolution {
	const projectKey = value.project.encodedKey.length === 0 ? null : value.project.encodedKey;
	return Object.freeze({
		schemaVersion: "gajae.memory.scope-resolution.v1",
		memoryRoot: value.memoryRoot,
		projectKey,
		sessionId: value.sessionId,
		scopes: Object.freeze(
			value.scopes.map(scope =>
				Object.freeze({
					kind: scope.kind,
					relPath: scope.available ? publicScopePath(scope.kind, projectKey, value.sessionId) : null,
					root: scope.root,
					writable: scope.available ? scope.writable : false,
					available: scope.available,
					unavailableReason: scope.available ? null : scope.unavailableReason,
				}),
			),
		),
	});
}

export function resolveScopes(environment: MemoryEnvironment, input?: unknown): MemoryResult<ScopeResolution> {
	const registry = publicScopeRegistry(input);
	if (!registry.ok) return registry;
	const result = resolveScopesInternal(environment, registry.value);
	if (!result.ok) return result;
	return { ok: true, value: publicScopeResolution(result.value) };
}

export async function resolveReadableResource(
	environment: MemoryEnvironment,
	input: ResolveReadableResourceInput | string,
): Promise<MemoryResult<ResolveReadableResourceResult>> {
	const journal = await admitPendingJournals(environment, "read");
	if (!journal.ok) return journal;
	return typeof input === "string"
		? resolveReadableResourceInternal(environment, input)
		: resolveReadableResourceInternal(environment, input);
}

export function resolveReadableResourceSync(
	environment: MemoryEnvironment,
	input: ResolveReadableResourceInput | string,
): MemoryResult<ResolveReadableResourceSyncResult> {
	const journal = admitPendingJournals(environment, "read");
	if (!journal.ok) return journal;
	return typeof input === "string"
		? resolveReadableResourceSyncInternal(environment, input)
		: resolveReadableResourceSyncInternal(environment, input);
}

export async function search(environment: MemoryEnvironment, input: SearchInput): Promise<MemoryResult<SearchResult>> {
	const journal = await admitPendingJournals(environment, "read");
	if (!journal.ok) return journal;

	const policy = admitMemoryPolicy(environment);
	if (!policy.ok) return policy;
	return searchMemory(environment, input, { policy: policy.value });
}

export async function recall(environment: MemoryEnvironment, input: RecallInput): Promise<MemoryResult<RecallResult>> {
	const journal = await admitPendingJournals(environment, "read");
	if (!journal.ok) return journal;

	const policy = admitMemoryPolicy(environment);
	if (!policy.ok) return policy;
	const result = await recallMemory(environment, input, {
		policy: policy.value,
	});
	if (!result.ok) return result;
	if (input.requireResolved === true && result.value.conflicts.length > 0) {
		return {
			ok: false,
			error: {
				code: "conflict-requires-confirmation",
				exitCode: MEMORY_EXIT_CODES.conflictRequiresConfirmation,
				conflicts: result.value.conflicts,
			},
		};
	}
	return result;
}

export async function checkpoint(
	environment: MemoryEnvironment,
	input: CheckpointInput,
): Promise<MemoryResult<CheckpointResult>> {
	const sessionPath = environment.sessionId === null ? undefined : `sessions/${environment.sessionId}/checkpoint.md`;
	const journal = await admitPendingJournals(environment, "write", sessionPath === undefined ? [] : [sessionPath]);
	if (!journal.ok) return journal;

	// A checkpoint is a real store mutation, so it passes through the same admitted
	// in-store policy as every other write ingress.
	const policy = admitMemoryPolicy(environment);
	if (!policy.ok) return policy;
	const allowed = enforceMemoryWritePolicy(policy.value, "checkpoint", "checkpoint");
	if (!allowed.ok) return allowed;
	return writeCheckpoint(environment, input);
}

export async function resume(environment: MemoryEnvironment, input?: ResumeInput): Promise<MemoryResult<ResumeResult>> {
	const journal = await admitPendingJournals(environment, "read");
	if (!journal.ok) return journal;
	return readResumePacket(environment, input);
}

export async function doctor(environment: MemoryEnvironment, input?: DoctorInput): Promise<MemoryResult<DoctorResult>> {
	await admitPendingJournals(environment, "doctor");

	const checked = publicDoctorInput(input);
	if (!checked.ok) return checked;
	return runDoctor(environment, checked.value);
}

export async function propose(
	environment: MemoryEnvironment,
	input: ProposeInput,
): Promise<MemoryResult<WriteProposal>> {
	const journal = await admitPendingJournals(environment, "write");
	if (!journal.ok) return journal;

	const policy = admitMemoryPolicy(environment);
	if (!policy.ok) return policy;
	return proposeMemory(environment, input, policy.value);
}

export async function apply(environment: MemoryEnvironment, input: ApplyInput): Promise<MemoryResult<ApplyReceipt>> {
	const journal = await admitPendingJournals(environment, "write");
	if (!journal.ok) return journal;

	const policy = admitMemoryPolicy(environment);
	if (!policy.ok) return policy;
	return applyMemory(environment, input, policy.value);
}

export async function forget(environment: MemoryEnvironment, input: ForgetInput): Promise<MemoryResult<ForgetReceipt>> {
	const journal = await admitPendingJournals(environment, "write");
	if (!journal.ok) return journal;
	const policy = admitMemoryPolicy(environment);
	if (!policy.ok) return policy;
	return forgetMemory(environment, input, policy.value);
}

export async function initMemoryRoot(e: MemoryEnvironment): Promise<MemoryResult<InitMemoryRootResult>> {
	const validated = validateMemoryEnvironment(e);
	if (!validated.ok) return { ok: false, error: validated.error };
	try {
		const receipt = await createMemoryRootScaffold(e.memoryRoot);
		return { ok: true, value: receipt };
	} catch (error) {
		const code = error instanceof MemoryBootstrapError ? error.code : "bootstrap-failed";
		return {
			ok: false,
			error: {
				code: "policy-denied",
				exitCode: MEMORY_EXIT_CODES.policyDenied,
				destination: "global-canonical",
				reason: `memory initialization denied: ${code}`,
			},
		};
	}
}
