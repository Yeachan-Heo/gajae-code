import * as fs from "node:fs";
import * as path from "node:path";
import { type ParsedMemoryDocument, parseMemoryDocument } from "../documents/document-parser";
import { type MemoryUri, parseMemoryUri } from "../documents/uri";
import { validateMemoryEnvironment } from "../env";
import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";
import type { MemoryCitation, MemoryEnvironment, MemoryScopeKind, Sensitivity } from "../index";
import { authorizeAccess, type ReadAccessGrant, verifyReadAccessGrant } from "../policy/access-policy";
import { checkInitializedRoot } from "../policy/initialized";
import { containPath, pinMemoryRoot } from "../policy/path-safety";
import { scanSecretContent } from "../policy/secret-scan";
import { resolveScopes, type ScopeResolutionResult, scopeByKind } from "../scope/scope-resolver";
import { openVerifiedFile, VerifiedStorageError } from "../storage/verified-open";

const CONTENT_TYPE = "text/markdown" as const;
const EXCLUDED_COMPONENTS = new Set(["archive", "proposals", ".journal", ".locks", "transcripts", "unverified"]);

export interface ResolveReadableResourceInput {
	readonly uri: string;
}

export interface ResolveReadableResourceResult {
	readonly uri: string;
	readonly relPath: string;
	readonly contentType: typeof CONTENT_TYPE;
	readonly content: string;
	readonly size: number;
	readonly digest: string;
	readonly citation: MemoryCitation;
}

export interface ResolveReadableResourceSyncResult {
	readonly absolutePath: string;
}

export interface PreparedReadableResource {
	readonly grant: ReadAccessGrant;
	readonly uri: MemoryUri;
	readonly scope: MemoryScopeKind;
	readonly relPath: string;
	readonly absolutePath: string;
}

interface ScopeTarget {
	readonly scopeRoot: string;
	readonly scopeRelativePath: string;
	readonly memoryRelativePath: string;
}

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
}

function scopeUnresolved(detail: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "scope-unresolved",
			exitCode: MEMORY_EXIT_CODES.scopeUnresolved,
			detail,
		},
	};
}

function notFound(uri: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "not-found",
			exitCode: MEMORY_EXIT_CODES.notFound,
			uri,
		},
	};
}

function sensitivityViolation(sensitivity: Sensitivity): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "sensitivity-violation",
			exitCode: MEMORY_EXIT_CODES.sensitivityViolation,
			destination: "global-canonical",
			findings: [
				Object.freeze({
					kind: "sensitivity-label",
					patternId: null,
					sensitivity,
					line: 0,
					excerptRedacted: "[REDACTED]",
				}),
			],
		},
	};
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
function storageFailure(error: unknown): MemoryResult<never> {
	if (error instanceof VerifiedStorageError) return policyDenied(error.reason);
	return policyDenied("verified resource read failed");
}

function parsedDocumentFailure(result: MemoryResult<ParsedMemoryDocument>): MemoryResult<never> {
	if (result.ok) return policyDenied("resource document validation failed");
	return result;
}

function normalizedEnvironment(environment: MemoryEnvironment): MemoryResult<MemoryEnvironment> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	const initialized = checkInitializedRoot(validated.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const pinned = pinMemoryRoot(validated.value.memoryRoot);
	if (!pinned.ok) return pinned;
	if (pinned.value.canonicalPath === validated.value.memoryRoot) return validated;
	return {
		ok: true,
		value: Object.freeze({ ...validated.value, memoryRoot: pinned.value.canonicalPath }),
	};
}

function scopeRootRelative(memoryRoot: string, scopeRoot: string): string {
	const relative = path.relative(memoryRoot, scopeRoot);
	return relative
		.split(path.sep)
		.filter(component => component.length > 0)
		.join("/");
}

function targetForScope(resolution: ScopeResolutionResult, uri: MemoryUri): MemoryResult<ScopeTarget> {
	const descriptor = scopeByKind(resolution, uri.scheme);
	if (descriptor === null || !descriptor.available || descriptor.root === null) {
		return scopeUnresolved(descriptor?.unavailableReason ?? `${uri.scheme} scope is unavailable`);
	}

	let relativeComponents = uri.path;
	if (uri.scheme === "project" || uri.scheme === "session") {
		const scopeKey = uri.path[0];
		const expectedKey = uri.scheme === "project" ? resolution.project.encodedKey : resolution.sessionId;
		if (expectedKey === null || expectedKey.length === 0) {
			return scopeUnresolved(`${uri.scheme} scope is unavailable`);
		}
		if (scopeKey !== expectedKey) return policyDenied(`${uri.scheme} URI scope key does not match the environment`);
		relativeComponents = uri.path.slice(1);
	}
	if (relativeComponents.length === 0) return policyDenied("resource URI must name a markdown document");
	const scopeRelativePath = relativeComponents.join("/");
	const memoryRootRelative = scopeRootRelative(resolution.memoryRoot, descriptor.root);
	const memoryRelativePath =
		memoryRootRelative.length === 0 ? scopeRelativePath : `${memoryRootRelative}/${scopeRelativePath}`;
	return {
		ok: true,
		value: Object.freeze({
			scopeRoot: descriptor.root,
			scopeRelativePath,
			memoryRelativePath,
		}),
	};
}

function excludedResource(scopeTarget: ScopeTarget): MemoryResult<true> {
	const components = scopeTarget.scopeRelativePath.split("/");
	if (
		components.some(component => {
			const lower = component.toLowerCase();
			return (
				EXCLUDED_COMPONENTS.has(lower) ||
				lower.endsWith(".jsonl") ||
				lower === "unverified.md" ||
				lower.includes("transcript") ||
				lower.includes("unverified") ||
				lower.endsWith(".transcript.md") ||
				lower.endsWith(".unverified.md")
			);
		})
	) {
		return policyDenied("resource path is excluded by the canonical memory read policy");
	}
	if (!scopeTarget.scopeRelativePath.endsWith(".md")) {
		return policyDenied("only markdown resources are readable");
	}
	if (scopeTarget.scopeRelativePath.endsWith(".jsonl")) {
		return policyDenied("jsonl resources are not readable");
	}
	return { ok: true, value: true };
}

function ensureParentChain(scopeTarget: ScopeTarget, uri: string): MemoryResult<true> {
	const components = scopeTarget.scopeRelativePath.split("/");
	let current = scopeTarget.scopeRoot;
	const parents = ["", ...components.slice(0, -1)];
	for (const component of parents) {
		if (component.length > 0) current = path.join(current, component);
		try {
			const stat = fs.lstatSync(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				return policyDenied("resource parent is not bound to the resolved scope");
			}
		} catch (error) {
			if (errorCode(error) === "ENOENT") return notFound(uri);
			return policyDenied("resource parent could not be inspected");
		}
	}
	return { ok: true, value: true };
}

function sameUriPath(left: MemoryUri, right: MemoryUri): boolean {
	return (
		left.scheme === right.scheme &&
		left.path.length === right.path.length &&
		left.path.every((part, index) => part === right.path[index])
	);
}

function prepareReadableResourceUnchecked(
	environment: MemoryEnvironment,
	rawUri: string,
): MemoryResult<PreparedReadableResource> {
	const canonicalEnvironment = normalizedEnvironment(environment);
	if (!canonicalEnvironment.ok) return canonicalEnvironment;
	const scopes = resolveScopes(canonicalEnvironment.value);
	if (!scopes.ok) return scopes;
	const parsed = parseMemoryUri(rawUri);
	if (!parsed.ok) return parsed;
	const target = targetForScope(scopes.value, parsed.value);
	if (!target.ok) return target;
	const excluded = excludedResource(target.value);
	if (!excluded.ok) return excluded;

	const root = pinMemoryRoot(canonicalEnvironment.value.memoryRoot);
	if (!root.ok) return root;
	const parents = ensureParentChain(target.value, parsed.value.href);
	if (!parents.ok) return parents;
	const contained = containPath(root.value, target.value.memoryRelativePath);
	if (!contained.ok) return contained;
	if (contained.value.leafIdentity === null) return notFound(parsed.value.href);
	if (!contained.value.absolutePath.startsWith(`${target.value.scopeRoot}${path.sep}`)) {
		return policyDenied("resource target escaped its resolved scope");
	}

	try {
		const leaf = fs.lstatSync(contained.value.absolutePath);
		if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) {
			return policyDenied("resource target is not a regular single-link file");
		}
	} catch {
		return policyDenied("resource target could not be inspected");
	}

	const grant = authorizeAccess({
		environment: canonicalEnvironment.value,
		kind: "read",
		scope: parsed.value.scheme,
		relPath: contained.value.relativePath,
	});
	if (!grant.ok) return grant;
	const verified = verifyReadAccessGrant(grant.value, contained.value.absolutePath, parsed.value.scheme);

	if (!verified.ok) return verified;
	return {
		ok: true,
		value: Object.freeze({
			grant: verified.value,
			uri: parsed.value,
			scope: parsed.value.scheme,
			relPath: contained.value.relativePath,
			absolutePath: contained.value.absolutePath,
		}),
	};
}

function resourceUri(input: unknown): MemoryResult<string> {
	if (typeof input === "string") return { ok: true, value: input };
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalidInput("readable resource input must contain a URI");
	}
	const uri = (input as { readonly uri?: unknown }).uri;
	if (typeof uri !== "string") return invalidInput("readable resource URI must be a string");
	return { ok: true, value: uri };
}

/** Shared pre-disclosure admission used by both the async reader and hyperlink resolver. */
export function prepareReadableResource(
	environment: MemoryEnvironment,
	input: string | ResolveReadableResourceInput,
): MemoryResult<PreparedReadableResource> {
	try {
		const uri = resourceUri(input);
		if (!uri.ok) return uri;
		return prepareReadableResourceUnchecked(environment, uri.value);
	} catch {
		return policyDenied("readable resource policy failed closed");
	}
}

function decodeUtf8(bytes: Buffer, relPath: string): MemoryResult<string> {
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return { ok: true, value: decoder.decode(bytes) };
	} catch {
		return {
			ok: false,
			error: {
				code: "malformed-document",
				exitCode: MEMORY_EXIT_CODES.malformedDocument,
				relPath,
				detail: "document is not valid UTF-8",
			},
		};
	}
}

function documentResult(
	prepared: PreparedReadableResource,
	content: string,
): MemoryResult<ResolveReadableResourceResult> {
	const parsed = parseMemoryDocument({ content, relPath: prepared.relPath, uri: prepared.uri.href });
	if (!parsed.ok) return parsedDocumentFailure(parsed);
	if (!sameUriPath(parsed.value.uri, prepared.uri)) {
		return {
			ok: false,
			error: {
				code: "malformed-document",
				exitCode: MEMORY_EXIT_CODES.malformedDocument,
				relPath: prepared.relPath,
				detail: "document URI does not match the requested resource",
			},
		};
	}
	if (parsed.value.metadata.status !== "active") return policyDenied("resource document is excluded");
	if (parsed.value.metadata.sensitivity !== "public-safe") {
		return sensitivityViolation(parsed.value.metadata.sensitivity);
	}
	const scanned = scanSecretContent(parsed.value.content);
	if (!scanned.ok) return scanned;
	if (scanned.value.findings.length > 0) {
		return {
			ok: false,
			error: {
				code: "sensitivity-violation",
				exitCode: MEMORY_EXIT_CODES.sensitivityViolation,
				destination: "global-canonical",
				findings: scanned.value.findings,
			},
		};
	}
	return {
		ok: true,
		value: Object.freeze({
			uri: parsed.value.uri.href,
			relPath: prepared.relPath,
			contentType: CONTENT_TYPE,
			content: parsed.value.content,
			size: Buffer.byteLength(parsed.value.content, "utf8"),
			digest: parsed.value.digest,
			citation: parsed.value.citation,
		}),
	};
}

/** Read one active, public-safe markdown document through the verified descriptor boundary. */
export function readPreparedReadableResource(
	prepared: PreparedReadableResource,
): MemoryResult<ResolveReadableResourceResult> {
	const verified = verifyReadAccessGrant(prepared.grant, prepared.absolutePath, prepared.scope);
	if (!verified.ok) return verified;
	let bytes: Buffer;
	try {
		bytes = openVerifiedFile(verified.value.root, verified.value.relativePath);
	} catch (error) {
		return storageFailure(error);
	}
	const decoded = decodeUtf8(bytes, prepared.relPath);
	if (!decoded.ok) return decoded;
	return documentResult(prepared, decoded.value);
}

export function resolveReadableResource(
	environment: MemoryEnvironment,
	input: string,
): Promise<MemoryResult<ResolveReadableResourceResult>>;
export function resolveReadableResource(
	environment: MemoryEnvironment,
	input: ResolveReadableResourceInput,
): Promise<MemoryResult<ResolveReadableResourceResult>>;
export async function resolveReadableResource(
	environment: MemoryEnvironment,
	input: string | ResolveReadableResourceInput,
): Promise<MemoryResult<ResolveReadableResourceResult>> {
	const prepared = prepareReadableResource(environment, input);
	if (!prepared.ok) return prepared;
	return readPreparedReadableResource(prepared.value);
}
