import { createHash } from "node:crypto";

import { type ParsedMemoryDocument, parseMemoryDocument } from "../documents/document-parser";
import {
	type MemoryDocumentMetadata,
	normalizeDocumentText,
	parseFrontmatter,
	serializeFrontmatter,
} from "../documents/frontmatter";

import { parseMemoryUri } from "../documents/uri";

import { type MemoryEnvironment, validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryError, type MemoryResult } from "../errors";
import type {
	AuthorityTier,
	ConflictResult,
	MemoryClaim,
	MemoryDocumentType,
	MemoryIntent,
	MemoryScopeKind,
	MemoryUri,
	ProposeInput,
	Sensitivity,
	WriteProposal,
} from "../index";
import { parseMemoryMap } from "../maps/map-parser";
import { type MapRebuildRoute, rebuildMemoryMap } from "../maps/map-rebuilder";
import { authorizeAccess } from "../policy/access-policy";
import type { MemoryPolicyConfig } from "../policy/config-merge";
import { containPath, pinMemoryRoot, validateSafePathComponent } from "../policy/path-safety";
import {
	admitMemoryPolicy,
	enforceMemorySensitivity,
	enforceMemoryWritePolicy,
	writeDestinationForScope,
} from "../policy/policy-admission";
import { scanSecretContent } from "../policy/secret-scan";
import { enforceSensitivity } from "../policy/sensitivity";
import { extractClaims } from "../resolution/claim-extractor";
import { resolveConflicts } from "../resolution/conflicts";
import { listReadableDirectory } from "../resources/list-readable-directory";
import { readControlResource } from "../resources/read-control-resource";
import { resolveScopes, type ScopeResolutionResult } from "../scope/scope-resolver";
import { atomicWrite } from "../storage/atomic-write";
import { openVerifiedFile } from "../storage/verified-open";
import { type InternalLifecycleDocument, readInternalLifecycleDocument } from "./internal-document-reader";
import {
	buildSupersessionMutations,
	type SupersededDocumentMutation,
	type SupersessionCandidate,
	supersessionCandidateFromDocument,
} from "./supersession";

export const STAGED_PROPOSAL_SCHEMA_VERSION = "gajae.memory.staged-write-proposal.v1" as const;

export interface StagedProposalRecord {
	readonly schemaVersion: typeof STAGED_PROPOSAL_SCHEMA_VERSION;
	readonly proposal: WriteProposal;
	readonly documentRelPath: string;
	readonly documentContent: string;
	readonly superseded: readonly SupersededDocumentMutation[];
	readonly mapRelPath: "MEMORY.md";
	readonly mapExpectedDigest: string;
	readonly mapContent: string;
	readonly mapRoutes: readonly MapRebuildRoute[];
	readonly operation: "apply" | "forget";
	readonly forgetMarker: string | null;
}

export interface StageProposalInput {
	readonly proposal: WriteProposal;
	readonly documentRelPath: string;
	readonly documentContent: string;
	readonly superseded?: readonly SupersededDocumentMutation[];
	readonly mapContent: string;
	readonly mapExpectedDigest: string;
	readonly mapRoutes: readonly MapRebuildRoute[];
	readonly operation?: "apply" | "forget";
	readonly forgetMarker?: string | null;
}

interface TargetDocument {
	readonly uri: string;
	readonly mapUri: string;
	readonly scope: MemoryScopeKind;
	readonly relPath: string;
	readonly id: string;
}

interface ExistingDocument {
	readonly parsed: ParsedMemoryDocument;
	readonly content: string;
	readonly identity: InternalLifecycleDocument["identity"];
}

const DOCUMENT_TYPES: readonly MemoryDocumentType[] = Object.freeze([
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
]);
const SCOPES: readonly MemoryScopeKind[] = Object.freeze(["global", "project", "session"]);
const AUTHORITIES: readonly AuthorityTier[] = Object.freeze([
	"user-confirmed",
	"repository-reviewed",
	"project-config",
	"tool-verified",
	"session-observed",
	"model-inferred",
	"unverified",
]);
const SENSITIVITIES: readonly Sensitivity[] = Object.freeze(["public-safe", "private", "restricted"]);
const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function normalize(value: string): string {
	return value.normalize("NFC").trim();
}

function digest(content: string): string {
	return createHash("sha256")
		.update(Buffer.from(normalizeDocumentText(content), "utf8"))
		.digest("hex");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value);
}

function typedNotFound(uri: string): MemoryResult<never> {
	return { ok: false, error: { code: "not-found", exitCode: MEMORY_EXIT_CODES.notFound, uri } };
}

function proposalFailure(): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "proposal",
			reason: "proposal construction failed closed",
		},
	};
}

function isDocumentType(value: unknown): value is MemoryDocumentType {
	return typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

function isScope(value: unknown): value is MemoryScopeKind {
	return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

function isAuthority(value: unknown): value is AuthorityTier {
	return typeof value === "string" && (AUTHORITIES as readonly string[]).includes(value);
}

function isSensitivity(value: unknown): value is Sensitivity {
	return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value);
}

function strictTimestamp(value: string): boolean {
	return STRICT_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function timestamp(environment: MemoryEnvironment): MemoryResult<string> {
	const candidate = environment.asOf ?? environment.now.toISOString();
	if (!strictTimestamp(candidate)) return invalidInput("proposal timestamp must be strict UTC");
	return { ok: true, value: candidate };
}

function safeId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !value.includes("..") && !value.includes("/");
}

function canonicalUri(raw: string): MemoryResult<MemoryUri> {
	if (typeof raw !== "string") return invalidInput("proposal target URI must be a string");
	if (raw.startsWith("memory://")) {
		const rest = raw.slice("memory://".length);
		const hash = rest.indexOf("#");
		const pathPart = hash < 0 ? rest : rest.slice(0, hash);
		const fragment = hash < 0 ? null : rest.slice(hash + 1);
		const pieces = pathPart.split("/");
		if (pieces.length < 2 || (pieces[0] !== "global" && pieces[0] !== "project" && pieces[0] !== "session")) {
			return invalidInput("proposal target URI is invalid");
		}
		const candidate = `${pieces[0]}://${pieces.slice(1).join("/")}${fragment === null ? "" : `#${fragment}`}`;
		return parseMemoryUri(candidate);
	}
	return parseMemoryUri(raw);
}

function targetRelPath(scope: MemoryScopeKind, uriPath: readonly string[]): string {
	const prefix = scope === "global" ? "global" : scope === "project" ? "projects" : "sessions";
	return `${prefix}/${uriPath.join("/")}`;
}

function routeCategory(type: MemoryDocumentType): string {
	if (type === "preference") return "profile";
	if (type === "constraint" || type === "policy") return "constraints";
	if (type === "convention") return "conventions";
	return "";
}

function defaultAuthority(scope: MemoryScopeKind, sourceSession: string | null): AuthorityTier {
	if (scope === "session" && sourceSession !== null) return "session-observed";
	return scope === "global" ? "model-inferred" : "project-config";
}

function defaultIntents(type: MemoryDocumentType): readonly MemoryIntent[] {
	if (type === "preference") return ["user-preference"];
	if (type === "convention") return ["project-convention"];
	if (type === "decision") return ["decision-history"];
	if (type === "task-state" || type === "handoff" || type === "checkpoint") return ["current-task-status"];
	if (type === "policy" || type === "constraint") return ["workflow-policy"];
	return ["generic-recall"];
}

function idFromTarget(target: TargetDocument, content: string): string {
	const basename = target.uri.split("#", 1)[0]?.split("/").at(-1)?.replace(/\.md$/iu, "") ?? "";
	if (safeId(basename)) return normalize(basename);
	return `memory-${digest(content).slice(0, 24)}`;
}

function generatedTarget(
	environment: MemoryEnvironment,
	input: ProposeInput,
	time: string,
): MemoryResult<TargetDocument> {
	const requestedUri = input.targetUri;
	if (requestedUri !== undefined) {
		const parsed = canonicalUri(requestedUri);
		if (!parsed.ok) return parsed;
		if (input.targetScope !== undefined && input.targetScope !== parsed.value.scheme) {
			return invalidInput("proposal targetScope does not match targetUri");
		}
		if (parsed.value.scheme === "project" || parsed.value.scheme === "session") {
			const scopes = resolveScopes(environment);
			if (!scopes.ok) return scopes;
			const expectedKey =
				parsed.value.scheme === "project" ? scopes.value.project.encodedKey : scopes.value.sessionId;
			if (expectedKey === null || expectedKey.length === 0) {
				return {
					ok: false,
					error: {
						code: "scope-unresolved",
						exitCode: MEMORY_EXIT_CODES.scopeUnresolved,
						detail: `${parsed.value.scheme} scope is unavailable`,
					},
				};
			}
			if (parsed.value.path[0] !== expectedKey) {
				return {
					ok: false,
					error: {
						code: "policy-denied",
						exitCode: MEMORY_EXIT_CODES.policyDenied,
						destination: parsed.value.scheme === "project" ? "project-canonical" : "session",
						reason: "proposal URI scope key does not match the environment",
					},
				};
			}
		}

		const relPath = targetRelPath(parsed.value.scheme, parsed.value.path);
		if (!relPath.toLowerCase().endsWith(".md"))
			return invalidInput("proposal target URI must name a Markdown document");
		return {
			ok: true,
			value: Object.freeze({
				uri: parsed.value.href,
				mapUri: `memory://${parsed.value.scheme}/${parsed.value.path.join("/")}${parsed.value.fragment === null ? "" : `#${parsed.value.fragment}`}`,
				scope: parsed.value.scheme,
				relPath,
				id: idFromTarget(
					{
						uri: parsed.value.href,
						mapUri: "",
						scope: parsed.value.scheme,
						relPath,
						id: "",
					},
					`${input.type}\n${time}`,
				),
			}),
		};
	}
	const sourceSession = input.sourceSession ?? environment.sessionId;
	let scope: MemoryScopeKind = input.targetScope ?? (sourceSession !== null ? "session" : "project");
	if (!isScope(scope)) return invalidInput("proposal target scope is invalid");
	const scopes = resolveScopes(environment);
	if (!scopes.ok) return scopes;
	if (scope === "project" && scopes.value.project.encodedKey.length === 0) scope = "global";
	if (scope === "session" && sourceSession === null) return invalidInput("session proposal requires a session id");
	const key = scope === "project" ? scopes.value.project.encodedKey : scope === "session" ? sourceSession : null;
	if (scope === "project" && (key === null || key.length === 0)) {
		return invalidInput("project proposal requires a resolved project identity");
	}
	if (scope === "session" && (key === null || key.length === 0)) {
		return invalidInput("session proposal requires a session id");
	}

	const id = `memory-${digest(`${input.type}\n${scope}\n${key}\n${time}\n${input.content}`).slice(0, 24)}`;
	const category = routeCategory(input.type);
	const filename = `${id}.md`;

	if (scope === "global") {
		const globalPath = category.length === 0 ? [filename] : [category, filename];
		return {
			ok: true,
			value: Object.freeze({
				uri: `global://${globalPath.join("/")}`,
				mapUri: `memory://global/${globalPath.join("/")}`,
				scope,
				relPath: `global/${globalPath.join("/")}`,
				id,
			}),
		};
	}
	const scopeKey = key;
	if (scopeKey === null || scopeKey.length === 0) return invalidInput("proposal scope key is missing");
	const uriPath = category.length === 0 ? [scopeKey, filename] : [scopeKey, category, filename];
	return {
		ok: true,
		value: Object.freeze({
			uri: `${scope}://${uriPath.join("/")}`,
			mapUri: `memory://${scope}/${uriPath.join("/")}`,
			scope,
			relPath: targetRelPath(scope, uriPath),
			id,
		}),
	};
}

function metadataFromContent(
	content: string,
	target: TargetDocument,
	input: ProposeInput,
	time: string,
): MemoryResult<{ readonly metadata: MemoryDocumentMetadata; readonly body: string }> {
	const parsed = parseFrontmatter(content, target.relPath);
	if (!parsed.ok && content.trimStart().startsWith("---")) return parsed;
	if (parsed.ok) {
		if (parsed.value.metadata.type !== input.type)
			return invalidInput("document frontmatter type does not match proposal type");
		if (parsed.value.metadata.scope !== target.scope)
			return invalidInput("document frontmatter scope does not match target");
		if (!isAuthority(parsed.value.metadata.authority) || !isSensitivity(parsed.value.metadata.sensitivity)) {
			return invalidInput("document frontmatter policy fields are invalid");
		}
		return {
			ok: true,
			value: Object.freeze({
				metadata: Object.freeze({
					...parsed.value.metadata,
					id: target.id,
					status: "active",
					updated: time,
					supersedes: Object.freeze([...(input.supersedes ?? parsed.value.metadata.supersedes)]),
				}),
				body: normalizeDocumentText(parsed.value.body),
			}),
		};
	}
	const sourceSession = input.sourceSession ?? null;
	const metadata: MemoryDocumentMetadata = Object.freeze({
		schemaVersion: "gajae.memory.document.v1",
		id: target.id,
		type: input.type,
		scope: target.scope,
		authority: defaultAuthority(target.scope, sourceSession),
		volatility: "stable",
		sensitivity: "public-safe",
		status: "active",
		created: time,
		updated: time,
		aliases: Object.freeze([]),
		supersedes: Object.freeze([...(input.supersedes ?? [])]),
		verification: null,
	});
	return { ok: true, value: Object.freeze({ metadata, body: normalizeDocumentText(content) }) };
}

function renderDocument(metadata: MemoryDocumentMetadata, body: string): string {
	const normalizedBody = normalizeDocumentText(body);
	return `${serializeFrontmatter(metadata)}\n${normalizedBody}`.normalize("NFC");
}

function diffLines(content: string): readonly string[] {
	const normalized = normalizeDocumentText(content).replace(/\n$/u, "");
	return normalized.length === 0 ? [] : normalized.split("\n");
}

function unifiedDiff(oldContent: string, nextContent: string, relPath: string): string {
	const oldLines = diffLines(oldContent);
	const newLines = diffLines(nextContent);
	const lines = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`];
	for (const line of oldLines) lines.push(`-${line}`);
	for (const line of newLines) lines.push(`+${line}`);
	return `${lines.join("\n")}\n`;
}

function proposalId(
	type: MemoryDocumentType,
	target: TargetDocument,
	documentContent: string,
	expectedDigest: string | null,
	supersedes: readonly string[],
	sourceSession: string | null,
): string {
	const canonical = canonicalJson({
		type,
		uri: target.uri,
		relPath: target.relPath,
		documentContent: normalizeDocumentText(documentContent),
		expectedDigest,
		supersedes: [...supersedes].map(normalize).sort(compareUtf8),
		sourceSession,
	});
	return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
}

function artifactRelPath(proposalIdValue: string): string {
	return `global/proposals-${proposalIdValue}.json`;
}

function canonicalStage(record: StagedProposalRecord): string {
	const payload = JSON.stringify({
		schemaVersion: record.schemaVersion,
		proposal: record.proposal,
		documentRelPath: record.documentRelPath,
		documentContent: record.documentContent,
		superseded: record.superseded,
		mapRelPath: record.mapRelPath,
		mapExpectedDigest: record.mapExpectedDigest,
		mapContent: record.mapContent,
		mapRoutes: record.mapRoutes,
		operation: record.operation,
		forgetMarker: record.forgetMarker,
	});
	// Do NOT normalize the serialized payload: it embeds the MAP content, whose
	// bytes outside the AUTO markers must survive byte-for-byte. Each field is
	// already normalized at construction where the contract requires it.
	return `${payload}\n`;
}

function stageRecord(input: StageProposalInput): MemoryResult<StagedProposalRecord> {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		return invalidInput("stage proposal input is malformed");
	if (typeof input.documentRelPath !== "string" || input.documentRelPath.length === 0)
		return invalidInput("stage document path is required");
	if (typeof input.documentContent !== "string" || typeof input.mapContent !== "string")
		return invalidInput("stage content is invalid");
	if (typeof input.mapExpectedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(input.mapExpectedDigest)) {
		return invalidInput("stage MAP digest is invalid");
	}
	const operation = input.operation ?? "apply";
	const record: StagedProposalRecord = Object.freeze({
		schemaVersion: STAGED_PROPOSAL_SCHEMA_VERSION,
		proposal: input.proposal,
		documentRelPath: normalize(input.documentRelPath),
		documentContent: normalizeDocumentText(input.documentContent),
		superseded: Object.freeze([...(input.superseded ?? [])]),
		mapRelPath: "MEMORY.md",
		mapExpectedDigest: input.mapExpectedDigest,
		// The MAP is not a memory document: bytes outside the AUTO markers must
		// survive byte-for-byte, so never normalize it.
		mapContent: input.mapContent,
		mapRoutes: Object.freeze([...(input.mapRoutes ?? [])]),
		operation,
		forgetMarker: input.forgetMarker ?? null,
	});
	return { ok: true, value: record };
}

/** Persist one reviewable proposal artifact; canonical documents are untouched. */
export async function stageProposal(
	environment: MemoryEnvironment,
	input: StageProposalInput,
	policy?: MemoryPolicyConfig,
): Promise<MemoryResult<StagedProposalRecord>> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	const admitted: MemoryResult<MemoryPolicyConfig> =
		policy === undefined ? admitMemoryPolicy(validated.value) : { ok: true, value: policy };
	if (!admitted.ok) return admitted;
	const writeGate = enforceMemoryWritePolicy(admitted.value, "proposal", "proposal staging");
	if (!writeGate.ok) return writeGate;
	const staged = stageRecord(input);
	if (!staged.ok) return staged;
	const proposalIdValue = staged.value.proposal.proposalId;
	if (!safeId(proposalIdValue)) return invalidInput("proposal id is invalid");
	const content = canonicalStage(staged.value);
	try {
		const scanned = scanSecretContent(content);
		if (!scanned.ok) return scanned;
		const gate = enforceSensitivity("proposal", "public-safe", scanned.value.findings);
		if (!gate.ok) return gate;
		const relPath = artifactRelPath(proposalIdValue);
		const grant = authorizeAccess({
			environment: validated.value,
			destination: "proposal",
			sensitivity: "private",
			relPath,
			content,
		});
		if (!grant.ok) return grant;
		await atomicWrite({ grant: grant.value, relPath, content });
		return { ok: true, value: staged.value };
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error) {
			const code = (error as { readonly code?: unknown }).code;
			if (code === "policy-denied" || code === "sensitivity-violation" || code === "lock-conflict") {
				return { ok: false, error: error as MemoryError };
			}
		}
		return {
			ok: false,
			error: {
				code: "policy-denied",
				exitCode: MEMORY_EXIT_CODES.policyDenied,
				destination: "proposal",
				reason: "proposal staging failed closed",
			},
		};
	}
}

function parseStaged(value: unknown, proposalIdValue: string): MemoryResult<StagedProposalRecord> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return invalidInput("staged proposal is malformed");
	const candidate = value as Readonly<Record<string, unknown>>;
	if (candidate.schemaVersion !== STAGED_PROPOSAL_SCHEMA_VERSION)
		return invalidInput("staged proposal schema is unsupported");
	if (candidate.proposal === null || typeof candidate.proposal !== "object" || Array.isArray(candidate.proposal)) {
		return invalidInput("staged proposal payload is malformed");
	}
	const proposal = candidate.proposal as WriteProposal;
	if (proposal.proposalId !== proposalIdValue || proposal.schemaVersion !== "gajae.memory.write-proposal.v1") {
		return invalidInput("staged proposal id does not match its path");
	}
	if (typeof candidate.documentRelPath !== "string" || typeof candidate.documentContent !== "string") {
		return invalidInput("staged document payload is malformed");
	}
	if (typeof candidate.mapExpectedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.mapExpectedDigest)) {
		return invalidInput("staged MAP digest is malformed");
	}
	if (
		typeof candidate.mapContent !== "string" ||
		!Array.isArray(candidate.superseded) ||
		!Array.isArray(candidate.mapRoutes)
	) {
		return invalidInput("staged mutation set is malformed");
	}
	const operation = candidate.operation === "forget" ? "forget" : candidate.operation === "apply" ? "apply" : null;
	if (operation === null) return invalidInput("staged operation is invalid");
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: STAGED_PROPOSAL_SCHEMA_VERSION,
			proposal,
			documentRelPath: candidate.documentRelPath,
			documentContent: normalizeDocumentText(candidate.documentContent),
			superseded: Object.freeze(candidate.superseded as readonly SupersededDocumentMutation[]),
			mapRelPath: "MEMORY.md",
			mapExpectedDigest: candidate.mapExpectedDigest,
			mapContent: candidate.mapContent,
			mapRoutes: Object.freeze(candidate.mapRoutes as readonly MapRebuildRoute[]),
			operation,
			forgetMarker: typeof candidate.forgetMarker === "string" ? candidate.forgetMarker : null,
		}),
	};
}

/** Read one staged proposal artifact through the verified storage boundary. */
export function readStagedProposal(
	environment: MemoryEnvironment,
	proposalIdValue: string,
): MemoryResult<StagedProposalRecord> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	if (!safeId(proposalIdValue)) return invalidInput("proposal id is invalid");
	const relPath = artifactRelPath(proposalIdValue);
	const root = pinMemoryRoot(validated.value.memoryRoot);
	if (!root.ok) return root;
	const contained = containPath(root.value, relPath);
	if (!contained.ok) return contained;
	if (contained.value.leafIdentity === null) return typedNotFound(`proposal://${proposalIdValue}`);
	let content: string;
	try {
		content = openVerifiedFile(root.value, relPath, "utf8");
	} catch {
		return {
			ok: false,
			error: {
				code: "policy-denied",
				exitCode: MEMORY_EXIT_CODES.policyDenied,
				destination: "proposal",
				reason: "staged proposal read failed closed",
			},
		};
	}
	try {
		const parsed: unknown = JSON.parse(content);
		return parseStaged(parsed, proposalIdValue);
	} catch {
		return invalidInput("staged proposal JSON is malformed");
	}
}

function documentUriForRelPath(relPath: string): MemoryResult<MemoryUri> {
	const parts = relPath.normalize("NFC").split("/");
	if (parts.length < 2) return invalidInput("document relative path is invalid");
	if (parts[0] === "global") return parseMemoryUri(`global://${parts.slice(1).join("/")}`);
	if (parts[0] === "projects" && parts.length >= 3) return parseMemoryUri(`project://${parts.slice(1).join("/")}`);
	if (parts[0] === "sessions" && parts.length >= 3) return parseMemoryUri(`session://${parts.slice(1).join("/")}`);
	return invalidInput("document relative path has an unknown scope");
}

async function existingDocument(
	environment: MemoryEnvironment,
	target: TargetDocument,
): Promise<MemoryResult<ExistingDocument | null>> {
	const result = await readInternalLifecycleDocument(environment, target.uri);
	if (!result.ok) {
		if (result.error.code === "not-found") return { ok: true, value: null };
		return result;
	}
	return {
		ok: true,
		value: Object.freeze({
			parsed: result.value.parsed,
			content: result.value.content,
			identity: result.value.identity,
		}),
	};
}

async function walkDocuments(
	environment: MemoryEnvironment,
	resolution: ScopeResolutionResult,
): Promise<MemoryResult<readonly ExistingDocument[]>> {
	const documents: ExistingDocument[] = [];
	for (const scope of resolution.scopes) {
		if (!scope.available || scope.root === null) continue;
		const prefix = scope.kind === "global" ? "global" : scope.kind === "project" ? "projects" : "sessions";
		const root = scope.root;
		const visit = async (relative: string): Promise<MemoryResult<true>> => {
			const listed = listReadableDirectory(environment, { kind: scope.kind, root }, relative);

			if (!listed.ok) return { ok: false, error: listed.error };
			for (const entry of listed.value) {
				const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
				if (entry.kind === "directory") {
					if (entry.name === "archive" || entry.name === "proposals") continue;
					const nested = await visit(child);
					if (!nested.ok) return nested;
					continue;
				}
				if (!entry.name.toLowerCase().endsWith(".md")) continue;
				const relPath = `${prefix}/${child}`;
				const uri = documentUriForRelPath(relPath);
				if (!uri.ok) return uri;
				const read = await readInternalLifecycleDocument(environment, uri.value.href);
				if (!read.ok) return read;
				documents.push(
					Object.freeze({ parsed: read.value.parsed, content: read.value.content, identity: read.value.identity }),
				);
			}
			return { ok: true, value: true };
		};
		const walked = await visit("");
		if (!walked.ok) return walked;
	}
	documents.sort((left, right) => compareUtf8(left.parsed.uri.href, right.parsed.uri.href));
	return { ok: true, value: Object.freeze(documents) };
}

function conflictClaims(
	newDocument: ParsedMemoryDocument,
	existing: readonly ExistingDocument[],
): MemoryResult<readonly ConflictResult[]> {
	const newClaims = extractClaims(newDocument);
	if (!newClaims.ok) return newClaims;
	const claims: MemoryClaim[] = [...newClaims.value];
	for (const document of existing) {
		if (document.parsed.metadata.status !== "active") continue;
		const extracted = extractClaims(document.parsed);
		if (!extracted.ok) return extracted;
		claims.push(...extracted.value);
	}
	if (claims.length === 0) return { ok: true, value: Object.freeze([]) };
	const asOf = newDocument.metadata.updated;
	const resolved = resolveConflicts(claims, { asOf });
	if (!resolved.ok) return resolved;
	return resolved;
}

function mapRoutesFromContent(
	mapContent: string,
	newDocument: ParsedMemoryDocument,
	newUri: string,
	supersededUris: readonly string[],
): MemoryResult<readonly MapRebuildRoute[]> {
	const parsed = parseMemoryMap(mapContent, "memory://global/MEMORY.md");
	if (!parsed.ok) return parsed;
	const removed = new Set(
		[newUri, ...supersededUris].map(value => {
			const canonical = canonicalUri(value);
			if (!canonical.ok) return normalize(value);
			return `memory://${canonical.value.scheme}/${canonical.value.path.join("/")}${canonical.value.fragment === null ? "" : `#${canonical.value.fragment}`}`;
		}),
	);

	const routes: MapRebuildRoute[] = [];
	for (const route of parsed.value.routes) {
		if (removed.has(normalize(route.uri))) continue;
		routes.push(
			Object.freeze({
				uri: route.uri,
				label: route.label,
				aliases: route.aliases,
				intents: route.intents,
				active: true,
			}),
		);
	}
	routes.push(
		Object.freeze({
			uri: newUri,
			label: newDocument.metadata.id,
			aliases: newDocument.metadata.aliases,
			intents: defaultIntents(newDocument.metadata.type),
			active: true,
		}),
	);
	return { ok: true, value: Object.freeze(routes) };
}

function proposalInput(input: ProposeInput): MemoryResult<ProposeInput> {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		return invalidInput("proposal input must be an object");
	if (!isDocumentType(input.type)) return invalidInput("proposal document type is invalid");
	if (typeof input.content !== "string" || input.content.length === 0)
		return invalidInput("proposal content is required");
	if (input.targetScope !== undefined && !isScope(input.targetScope))
		return invalidInput("proposal target scope is invalid");
	if (input.targetUri !== undefined && typeof input.targetUri !== "string")
		return invalidInput("proposal target URI is invalid");
	if (input.sourceSession !== undefined && input.sourceSession !== null) {
		if (typeof input.sourceSession !== "string") return invalidInput("proposal source session is invalid");
		const session = validateSafePathComponent(input.sourceSession.normalize("NFC"));
		if (!session.ok || session.value !== input.sourceSession.normalize("NFC")) {
			return invalidInput("proposal source session is invalid");
		}
	}
	if (
		input.supersedes !== undefined &&
		(!Array.isArray(input.supersedes) || input.supersedes.some(value => typeof value !== "string"))
	) {
		return invalidInput("proposal supersedes must be a string array");
	}
	return { ok: true, value: input };
}

/** Build and stage a deterministic WriteProposal without mutating canonical documents. */
export async function proposeMemory(
	environment: MemoryEnvironment,
	input: ProposeInput,
	policy?: MemoryPolicyConfig,
): Promise<MemoryResult<WriteProposal>> {
	try {
		const validatedEnvironment = validateMemoryEnvironment(environment);
		if (!validatedEnvironment.ok) return validatedEnvironment;
		const admitted: MemoryResult<MemoryPolicyConfig> =
			policy === undefined ? admitMemoryPolicy(validatedEnvironment.value) : { ok: true, value: policy };
		if (!admitted.ok) return admitted;
		const writeAllowed = enforceMemoryWritePolicy(admitted.value, "proposal", "proposal");
		if (!writeAllowed.ok) return writeAllowed;
		const checkedInput = proposalInput(input);
		if (!checkedInput.ok) return checkedInput;
		const time = timestamp(validatedEnvironment.value);
		if (!time.ok) return time;
		const target = generatedTarget(validatedEnvironment.value, checkedInput.value, time.value);
		if (!target.ok) return target;
		const destination = writeDestinationForScope(target.value.scope);
		const destinationGate = enforceMemoryWritePolicy(admitted.value, destination, "proposal");
		if (!destinationGate.ok) return destinationGate;
		const artifactGate = enforceMemoryWritePolicy(admitted.value, "proposal", "proposal artifact");
		if (!artifactGate.ok) return artifactGate;
		const metadataBody = metadataFromContent(
			checkedInput.value.content,
			target.value,
			checkedInput.value,
			time.value,
		);
		if (!metadataBody.ok) return metadataBody;
		const documentContent = renderDocument(metadataBody.value.metadata, metadataBody.value.body);
		const scanned = scanSecretContent(documentContent);
		if (!scanned.ok) return scanned;
		const sensitivity = enforceSensitivity(
			"proposal",
			metadataBody.value.metadata.sensitivity,
			scanned.value.findings,
		);
		if (!sensitivity.ok) return sensitivity;
		const policySensitivity = enforceMemorySensitivity(
			admitted.value,
			destination,
			metadataBody.value.metadata.sensitivity,
		);
		if (!policySensitivity.ok) return policySensitivity;
		const existingTarget = await existingDocument(validatedEnvironment.value, target.value);
		if (!existingTarget.ok) return existingTarget;
		const expectedDigest = existingTarget.value?.parsed.digest ?? null;
		const supersedes = Object.freeze(
			[...(checkedInput.value.supersedes ?? metadataBody.value.metadata.supersedes ?? [])]
				.map(normalize)
				.sort(compareUtf8),
		);
		const proposalIdValue = proposalId(
			checkedInput.value.type,
			target.value,
			documentContent,
			expectedDigest,
			supersedes,
			checkedInput.value.sourceSession ?? validatedEnvironment.value.sessionId,
		);
		const resolution = resolveScopes(validatedEnvironment.value);
		if (!resolution.ok) return resolution;
		const allDocuments = await walkDocuments(validatedEnvironment.value, resolution.value);
		if (!allDocuments.ok) return allDocuments;
		const newParsed = parseMemoryDocument({
			content: documentContent,
			relPath: target.value.relPath,
			uri: target.value.uri,
		});
		if (!newParsed.ok) return newParsed;
		const conflicts = conflictClaims(newParsed.value, allDocuments.value);
		if (!conflicts.ok) return conflicts;
		const conflictList = Object.freeze(
			conflicts.value.filter(conflict => conflict.conflict || conflict.requiresUserConfirmation),
		);
		const supersessionCandidates: SupersessionCandidate[] = allDocuments.value.map(document =>
			supersessionCandidateFromDocument(
				document.parsed,
				document.content,
				document.identity.id,
				document.identity.supersedes,
			),
		);
		const supersession = buildSupersessionMutations({
			newUri: target.value.uri,
			newDocument: newParsed.value,
			supersedes,
			candidates: supersessionCandidates,
			updatedAt: time.value,
		});
		if (!supersession.ok) return supersession;
		const mapResource = readControlResource(validatedEnvironment.value, "MEMORY.md");
		if (!mapResource.ok) return mapResource;
		const mapRoutes = mapRoutesFromContent(
			mapResource.value.content,
			newParsed.value,
			target.value.mapUri,
			supersession.value.map(item => item.uri),
		);
		if (!mapRoutes.ok) return mapRoutes;
		const rebuiltMap = rebuildMemoryMap({ content: mapResource.value.content, routes: mapRoutes.value });
		if (!rebuiltMap.ok) return rebuiltMap;
		const publicProposal: WriteProposal = Object.freeze({
			schemaVersion: "gajae.memory.write-proposal.v1",
			proposalId: proposalIdValue,
			type: checkedInput.value.type,
			recommendedScope: target.value.scope,
			recommendedUri: target.value.uri,
			recommendedRelPath: target.value.relPath,
			requiresApproval: admitted.value.write.requireApproval || conflictList.length > 0,
			sourceSession: checkedInput.value.sourceSession ?? validatedEnvironment.value.sessionId,
			diff: unifiedDiff(existingTarget.value?.content ?? "", documentContent, target.value.relPath),
			expectedDigest,
			supersedes,
			sensitivityFindings: Object.freeze(scanned.value.findings),
			conflicts: conflictList,
			mapUpdates: Object.freeze(
				[...new Set([target.value.mapUri, ...supersession.value.map(item => item.uri)])].sort(compareUtf8),
			),
		});
		const staged = await stageProposal(
			validatedEnvironment.value,
			{
				proposal: publicProposal,
				documentRelPath: target.value.relPath,
				documentContent,
				superseded: supersession.value,
				mapContent: rebuiltMap.value,
				mapExpectedDigest: mapResource.value.digest,
				mapRoutes: mapRoutes.value,
				operation: "apply",
			},
			admitted.value,
		);
		if (!staged.ok) return staged;
		return { ok: true, value: publicProposal };
	} catch {
		return proposalFailure();
	}
}
