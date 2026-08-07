import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { validateMemoryEnvironment } from "../env";
import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";
import type { MemoryEnvironment, MemoryScopeKind, Sensitivity, WriteDestination } from "../index";
import { checkInitializedRoot } from "./initialized";
import {
	assertRootBinding,
	type ComponentPin,
	type ContainedPath,
	containPath,
	type PathIdentity,
	pinMemoryRoot,
	type RootPin,
	validateSafePathComponent,
} from "./path-safety";

import { type SecretFinding, scanSecretContent } from "./secret-scan";
import { enforceSensitivity, SENSITIVITY_LEVELS, WRITE_DESTINATIONS } from "./sensitivity";

const AccessGrantBrand: unique symbol = Symbol("gajae.memory.access-grant");

interface SessionParentAuthorization {
	readonly kind: "create" | "pinned";
	readonly relPath: string;
	readonly target: string;
	readonly rootPath: string;
	readonly rootDev: bigint;
	readonly rootIno: bigint;
	readonly destination: WriteDestination;
	readonly parentPath: string;
	readonly parentDev: bigint | null;
	readonly parentIno: bigint | null;
	readonly sessionsPath: string;
	readonly sessionsDev: bigint;
	readonly sessionsIno: bigint;
}

/** Internal opaque capability. The brand is intentionally not exported. */
export interface AccessGrant {
	readonly [AccessGrantBrand]: true;
	readonly target: string;
	readonly relativePath: string;
	readonly destination: WriteDestination;
	readonly root: RootPin;
	readonly contentDigest: string;
	readonly parentCreation?: SessionParentAuthorization;
}

const ReadAccessGrantBrand: unique symbol = Symbol("gajae.memory.read-access-grant");

/** Internal opaque capability for one policy-approved readable document. */
export interface ReadAccessGrant {
	readonly [ReadAccessGrantBrand]: true;
	readonly target: string;
	readonly relativePath: string;
	readonly scope: MemoryScopeKind;
	readonly root: RootPin;
	readonly leafIdentity: PathIdentity;
}

export interface ReadAccessRequest {
	readonly [key: string]: unknown;
	readonly environment: unknown;
	readonly scope: unknown;
	readonly relPath?: unknown;
	readonly target?: unknown;
	readonly kind?: unknown;
}

export interface AccessRequest {
	readonly [key: string]: unknown;
	readonly environment: unknown;
	readonly destination: unknown;
	readonly sensitivity: unknown;
	readonly relPath?: unknown;
	readonly target?: unknown;
	readonly content?: unknown;
	readonly override?: unknown;
}

function policyDenied(destination: WriteDestination, reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination,
			reason,
		},
	};
}

function isWriteDestination(value: unknown): value is WriteDestination {
	return typeof value === "string" && (WRITE_DESTINATIONS as readonly string[]).includes(value);
}

function isSensitivity(value: unknown): value is Sensitivity {
	return typeof value === "string" && (SENSITIVITY_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAccessRequest(value: { readonly [key: string]: unknown }): value is AccessRequest {
	return (
		Object.hasOwn(value, "environment") && Object.hasOwn(value, "destination") && Object.hasOwn(value, "sensitivity")
	);
}

function withDestination<T>(result: MemoryResult<T>, destination: WriteDestination): MemoryResult<T> {
	if (result.ok) return result;
	const error = result.error;
	if (error.code === "policy-denied") {
		return { ok: false, error: { ...error, destination } };
	}
	if (error.code === "sensitivity-violation") {
		return { ok: false, error: { ...error, destination } };
	}
	return result;
}

function requestValue(request: { readonly [key: string]: unknown }, key: string): unknown {
	return Object.hasOwn(request, key) ? request[key] : undefined;
}

function rejectOverrides(request: { readonly [key: string]: unknown }): MemoryResult<never> | undefined {
	const forbidden = ["override", "allowSensitive", "allowSecrets", "force", "parentCreation"] as const;
	for (const key of forbidden) {
		if (Object.hasOwn(request, key)) {
			return policyDenied("global-canonical", "access policy overrides are not supported");
		}
	}
	return undefined;
}

function isMemoryScopeKind(value: unknown): value is MemoryScopeKind {
	return value === "global" || value === "project" || value === "session";
}

function extractRequest(first: unknown, rest: readonly unknown[]): MemoryResult<AccessRequest> {
	if (rest.length > 0) {
		if (rest.length !== 4 && rest.length !== 5) {
			return invalidInput("access authorization requires environment, destination, sensitivity, path, and content");
		}
		return {
			ok: true,
			value: {
				environment: first,
				destination: rest[0],
				sensitivity: rest[1],
				relPath: rest[2],
				content: rest[3],
				...(rest.length === 5 ? { override: rest[4] } : {}),
			},
		};
	}
	if (!isRecord(first)) return invalidInput("access authorization input must be an object");
	try {
		if (!isAccessRequest(first)) return invalidInput("access authorization request is missing required fields");
		return { ok: true, value: first };
	} catch {
		return policyDenied("global-canonical", "access policy failed closed");
	}
}

function grantFrom(
	root: RootPin,
	contained: ContainedPath,
	destination: WriteDestination,
	contentDigest: string,
	parentCreation?: SessionParentAuthorization,
): AccessGrant {
	return Object.freeze({
		[AccessGrantBrand]: true as const,
		target: contained.absolutePath,
		relativePath: contained.relativePath,
		destination,
		root,
		contentDigest,
		...(parentCreation === undefined ? {} : { parentCreation }),
	});
}

function mintGrantUnchecked(request: AccessRequest): MemoryResult<AccessGrant> {
	if (!isRecord(request)) return invalidInput("access authorization input must be an object");
	const override = rejectOverrides(request);
	if (override) return override;
	const destinationValue = requestValue(request, "destination");
	if (!isWriteDestination(destinationValue)) return invalidInput("write destination is invalid");
	const destination = destinationValue;
	const sensitivityValue = requestValue(request, "sensitivity");
	if (!isSensitivity(sensitivityValue)) return invalidInput("sensitivity is invalid");
	const contentValue = requestValue(request, "content");
	if (typeof contentValue !== "string") return invalidInput("access authorization content must be a string");
	const environmentValue = requestValue(request, "environment");
	const environmentValidation = validateMemoryEnvironment(environmentValue as MemoryEnvironment);
	if (!environmentValidation.ok) return environmentValidation;
	const initialized = checkInitializedRoot(environmentValidation.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const rootResult = withDestination(pinMemoryRoot(environmentValidation.value.memoryRoot), destination);
	if (!rootResult.ok) return rootResult;
	const requestedRelPath = requestValue(request, "relPath");
	const requestedTarget = requestValue(request, "target");
	if (requestedRelPath !== undefined && requestedTarget !== undefined && requestedRelPath !== requestedTarget) {
		return policyDenied(destination, "access target aliases disagree");
	}
	const relPathValue = requestedRelPath === undefined ? requestedTarget : requestedRelPath;
	if (typeof relPathValue !== "string") return invalidInput("access authorization target must be a relative path");
	const containedResult = withDestination(containPath(rootResult.value, relPathValue), destination);
	if (!containedResult.ok) return containedResult;
	if (containedResult.value.relativePath.length === 0)
		return policyDenied(destination, "access target must name a file");
	const scanned = withDestination(scanSecretContent(contentValue), destination);
	if (!scanned.ok) return scanned;
	const sensitivity = enforceSensitivity(destination, sensitivityValue, scanned.value.findings);
	if (!sensitivity.ok) return sensitivity;
	const contentDigest = crypto.createHash("sha256").update(Buffer.from(contentValue, "utf8")).digest("hex");

	return { ok: true, value: grantFrom(rootResult.value, containedResult.value, destination, contentDigest) };
}

function mintGrant(request: AccessRequest): MemoryResult<AccessGrant> {
	let destination: WriteDestination = "global-canonical";
	try {
		if (isRecord(request) && isWriteDestination(request.destination)) destination = request.destination;
		return mintGrantUnchecked(request);
	} catch {
		return policyDenied(destination, "access policy failed closed");
	}
}

function isPathIdentity(value: unknown): value is PathIdentity {
	if (!isRecord(value)) return false;
	return (
		typeof value.dev === "bigint" &&
		typeof value.ino === "bigint" &&
		typeof value.mode === "bigint" &&
		typeof value.nlink === "bigint" &&
		typeof value.size === "bigint" &&
		typeof value.mtimeNs === "bigint"
	);
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}
function sameStatIdentity(stat: fs.BigIntStats, expected: PathIdentity): boolean {
	return (
		stat.dev === expected.dev &&
		stat.ino === expected.ino &&
		stat.mode === expected.mode &&
		stat.nlink === expected.nlink &&
		stat.size === expected.size &&
		stat.mtimeNs === expected.mtimeNs
	);
}
function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function hasExpectedOwner(stat: fs.BigIntStats): boolean {
	if (process.platform === "win32") return true;
	const getuid = process.getuid;
	if (typeof getuid !== "function") return false;
	const owner = stat.uid;
	return (typeof owner === "bigint" || typeof owner === "number") && BigInt(owner) === BigInt(getuid());
}

function isTrustedDirectory(stat: fs.BigIntStats, rootDev: bigint): boolean {
	return (
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		stat.dev === rootDev &&
		hasExpectedOwner(stat) &&
		(stat.mode & 0o7777n) === 0o700n
	);
}

function isSessionDestination(value: unknown): value is "ledger" | "checkpoint" {
	return value === "ledger" || value === "checkpoint";
}

function sessionTargetParts(
	relativePath: string,
	destination: WriteDestination,
): { readonly sessionId: string; readonly parentPath: string } | null {
	const parts = relativePath.split("/");
	const filename =
		destination === "ledger" ? "retrieval-ledger.jsonl" : destination === "checkpoint" ? "checkpoint.md" : null;
	if (filename === null || parts.length !== 3 || parts[0] !== "sessions" || parts[2] !== filename) return null;
	const session = validateSafePathComponent(parts[1]);
	if (!session.ok || session.value !== parts[1]) return null;
	return { sessionId: parts[1], parentPath: `sessions/${parts[1]}` };
}

function parentAuthorizationValid(grant: AccessGrant): MemoryResult<SessionParentAuthorization> {
	const authorization = grant.parentCreation;
	const label = grant.destination === "ledger" ? "ledger" : "checkpoint";
	if (authorization === undefined) return policyDenied(grant.destination, `${label} parent authorization is missing`);
	const target = sessionTargetParts(grant.relativePath, grant.destination);
	if (target === null) return policyDenied(grant.destination, `${label} target is not exact`);
	const expectedParentPath = path.join(grant.root.canonicalPath, ...target.parentPath.split("/"));
	const expectedSessionsPath = path.join(grant.root.canonicalPath, "sessions");
	const expectedTarget = path.join(grant.root.canonicalPath, ...grant.relativePath.split("/"));
	if (
		authorization.relPath !== grant.relativePath ||
		authorization.target !== grant.target ||
		authorization.destination !== grant.destination ||
		authorization.rootPath !== grant.root.canonicalPath ||
		authorization.rootDev !== grant.root.dev ||
		authorization.rootIno !== grant.root.ino ||
		authorization.parentPath !== expectedParentPath ||
		authorization.sessionsPath !== expectedSessionsPath ||
		grant.target !== expectedTarget ||
		(authorization.kind === "pinned" && (authorization.parentDev === null || authorization.parentIno === null)) ||
		(authorization.kind === "create" && (authorization.parentDev !== null || authorization.parentIno !== null))
	) {
		return policyDenied(grant.destination, `${label} parent authorization binding changed`);
	}
	if (authorization.kind !== "create" && authorization.kind !== "pinned") {
		return policyDenied(grant.destination, `${label} parent authorization kind is invalid`);
	}
	return { ok: true, value: authorization };
}

function syntheticMissingParent(
	root: RootPin,
	relativePath: string,
	target: string,
	parentPath: string,
	sessionsStat: fs.BigIntStats,
): ContainedPath {
	const sessionsComponent: ComponentPin = Object.freeze({
		name: "sessions",
		absolutePath: path.join(root.canonicalPath, "sessions"),
		dev: sessionsStat.dev,
		ino: sessionsStat.ino,
	});
	return Object.freeze({
		root,
		relativePath,
		absolutePath: target,
		parentPath,
		components: Object.freeze([sessionsComponent]),
		leafIdentity: null,
	});
}

function ledgerLine(content: unknown): MemoryResult<{ readonly bytes: Buffer; readonly digest: string }> {
	if (typeof content !== "string") return invalidInput("ledger content must be a string");
	const bytes = Buffer.from(content, "utf8");
	if (
		bytes.byteLength === 0 ||
		bytes[bytes.byteLength - 1] !== 0x0a ||
		bytes.subarray(0, -1).includes(0x0a) ||
		bytes.subarray(0, -1).includes(0x0d)
	) {
		return policyDenied("ledger", "ledger content must be exactly one newline-terminated JSON line");
	}
	const body = bytes.subarray(0, -1).toString("utf8");
	try {
		const parsed: unknown = JSON.parse(body);
		if (!isRecord(parsed) || JSON.stringify(parsed) !== body) {
			return policyDenied("ledger", "ledger content is not canonical JSONL");
		}
	} catch {
		return policyDenied("ledger", "ledger content is not canonical JSONL");
	}
	if (bytes.byteLength > 64 * 1024) {
		return policyDenied("ledger", "ledger content exceeds the single-write append limit");
	}
	const digest = crypto.createHash("sha256").update(bytes).digest("hex");
	return { ok: true, value: Object.freeze({ bytes, digest }) };
}

export interface LedgerAccessRequest {
	readonly environment: unknown;
	readonly content: unknown;
}

interface SessionAccessRequest {
	readonly environment: unknown;
	readonly destination: unknown;
	readonly content: unknown;
}

function mintSessionGrantUnchecked(request: SessionAccessRequest): MemoryResult<AccessGrant> {
	if (!isRecord(request)) return invalidInput("session access authorization input must be an object");
	const destinationValue = request.destination;
	if (!isSessionDestination(destinationValue)) return invalidInput("session access destination is invalid");
	const destination = destinationValue;
	const label = destination === "ledger" ? "ledger" : "checkpoint";
	const environmentValidation = validateMemoryEnvironment(request.environment as MemoryEnvironment);
	if (!environmentValidation.ok) return environmentValidation;
	const environment = environmentValidation.value;
	if (environment.sessionId === null) return policyDenied(destination, `${label} authorization requires a session`);
	const sessionIdResult = validateSafePathComponent(environment.sessionId.normalize("NFC"));
	if (!sessionIdResult.ok) return sessionIdResult;
	const sessionId = sessionIdResult.value;
	const content = request.content;
	if (typeof content !== "string") return invalidInput(`${destination} content must be a string`);
	let contentDigest: string;
	if (destination === "ledger") {
		const contentResult = ledgerLine(content);
		if (!contentResult.ok) return contentResult;
		contentDigest = contentResult.value.digest;
	} else {
		contentDigest = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
	}
	const initialized = checkInitializedRoot(environment.memoryRoot);
	if (!initialized.ok) return initialized;
	const rootResult = withDestination(pinMemoryRoot(environment.memoryRoot), destination);
	if (!rootResult.ok) return rootResult;
	const root = rootResult.value;
	const sessionsPath = path.join(root.canonicalPath, "sessions");
	let sessionsStat: fs.BigIntStats;
	try {
		sessionsStat = fs.lstatSync(sessionsPath, { bigint: true });
	} catch (error) {
		return policyDenied(
			destination,
			`sessions directory could not be inspected: ${errorCode(error) ?? "lstat-failed"}`,
		);
	}
	if (!isTrustedDirectory(sessionsStat, root.dev)) {
		return policyDenied(destination, "sessions directory is not trusted");
	}
	const filename = destination === "ledger" ? "retrieval-ledger.jsonl" : "checkpoint.md";
	const relativePath = `sessions/${sessionId}/${filename}`;
	const target = path.join(root.canonicalPath, ...relativePath.split("/"));
	const scanned = withDestination(scanSecretContent(content), destination);
	if (!scanned.ok) return scanned;
	const sensitivity = enforceSensitivity(destination, "public-safe", scanned.value.findings);
	if (!sensitivity.ok) return sensitivity;
	const parentPath = path.join(root.canonicalPath, "sessions", sessionId);
	const sessionResult = withDestination(containPath(root, relativePath, true), destination);
	if (!sessionResult.ok) return sessionResult;
	let sessionStat: fs.BigIntStats | null = null;
	try {
		sessionStat = fs.lstatSync(parentPath, { bigint: true });
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			return policyDenied(destination, `${label} session directory could not be inspected`);
		}
	}
	if (sessionStat !== null) {
		if (!isTrustedDirectory(sessionStat, root.dev)) {
			return policyDenied(destination, `${label} session directory is not trusted`);
		}
		const rebound = withDestination(containPath(root, relativePath), destination);
		if (!rebound.ok || rebound.value.absolutePath !== target || rebound.value.parentPath !== parentPath) {
			return policyDenied(destination, `${label} session directory containment could not be verified`);
		}
		const sessionComponent = rebound.value.components.at(-1);
		if (
			sessionComponent === undefined ||
			sessionComponent.name !== sessionId ||
			sessionComponent.dev !== sessionStat.dev ||
			sessionComponent.ino !== sessionStat.ino
		) {
			return policyDenied(destination, `${label} session directory identity changed`);
		}
		const parentCreation: SessionParentAuthorization = Object.freeze({
			kind: "pinned",
			relPath: relativePath,
			target,
			rootPath: root.canonicalPath,
			rootDev: root.dev,
			rootIno: root.ino,
			destination,
			parentPath,
			parentDev: sessionStat.dev,
			parentIno: sessionStat.ino,
			sessionsPath,
			sessionsDev: sessionsStat.dev,
			sessionsIno: sessionsStat.ino,
		});
		return {
			ok: true,
			value: grantFrom(root, rebound.value, destination, contentDigest, parentCreation),
		};
	}
	if (
		sessionResult.value.absolutePath !== target ||
		sessionResult.value.parentPath !== parentPath ||
		sessionResult.value.components.length !== 1
	) {
		return policyDenied(destination, `${label} session directory containment could not be verified`);
	}
	const parentCreation: SessionParentAuthorization = Object.freeze({
		kind: "create",
		relPath: relativePath,
		target,
		rootPath: root.canonicalPath,
		rootDev: root.dev,
		rootIno: root.ino,
		destination,
		parentPath,
		parentDev: null,
		parentIno: null,
		sessionsPath,
		sessionsDev: sessionsStat.dev,
		sessionsIno: sessionsStat.ino,
	});
	const contained = syntheticMissingParent(root, relativePath, target, parentPath, sessionsStat);
	return { ok: true, value: grantFrom(root, contained, destination, contentDigest, parentCreation) };
}

function mintLedgerGrantUnchecked(request: LedgerAccessRequest): MemoryResult<AccessGrant> {
	return mintSessionGrantUnchecked({
		environment: request.environment,
		destination: "ledger",
		content: request.content,
	});
}

/** Internal-only session grant minting. The target and destination are fixed by policy. */
export function authorizeSessionAccess(request: unknown): MemoryResult<AccessGrant> {
	if (
		!isRecord(request) ||
		!Object.hasOwn(request, "environment") ||
		!Object.hasOwn(request, "destination") ||
		!Object.hasOwn(request, "content")
	) {
		return invalidInput("session access authorization request is missing required fields");
	}
	for (const key of [
		"sensitivity",
		"relPath",
		"target",
		"sessionId",
		"parentCreation",
		"override",
		"allowSensitive",
		"allowSecrets",
		"force",
	] as const) {
		if (Object.hasOwn(request, key))
			return policyDenied(
				isWriteDestination(request.destination) ? request.destination : "global-canonical",
				"session access target overrides are not supported",
			);
	}
	try {
		return mintSessionGrantUnchecked({
			environment: request.environment,
			destination: request.destination,
			content: request.content,
		});
	} catch {
		return policyDenied(
			isWriteDestination(request.destination) ? request.destination : "global-canonical",
			"session access policy failed closed",
		);
	}
}

/** Internal-only ledger grant minting. The target and destination are fixed by policy. */
export function authorizeLedgerAccess(request: unknown): MemoryResult<AccessGrant> {
	if (!isRecord(request) || !Object.hasOwn(request, "environment") || !Object.hasOwn(request, "content")) {
		return invalidInput("ledger access authorization request is missing required fields");
	}
	for (const key of [
		"destination",
		"sensitivity",
		"relPath",
		"target",
		"sessionId",
		"parentCreation",
		"override",
		"allowSensitive",
		"allowSecrets",
		"force",
	] as const) {
		if (Object.hasOwn(request, key))
			return policyDenied("ledger", "ledger access target overrides are not supported");
	}
	try {
		return mintLedgerGrantUnchecked({ environment: request.environment, content: request.content });
	} catch {
		return policyDenied("ledger", "ledger access policy failed closed");
	}
}

function mintReadGrantUnchecked(request: ReadAccessRequest): MemoryResult<ReadAccessGrant> {
	if (!isRecord(request)) return invalidInput("read access authorization input must be an object");
	const override = rejectOverrides(request);
	if (override) return override;
	const scopeValue = requestValue(request, "scope");
	if (!isMemoryScopeKind(scopeValue)) return invalidInput("read access scope is invalid");
	const requestedRelPath = requestValue(request, "relPath");
	const requestedTarget = requestValue(request, "target");
	if (requestedRelPath !== undefined && typeof requestedRelPath !== "string") {
		return invalidInput("read access target must be a relative path");
	}
	if (requestedTarget !== undefined && typeof requestedTarget !== "string") {
		return invalidInput("read access target must be a canonical path");
	}
	if (requestedRelPath === undefined && requestedTarget === undefined) {
		return invalidInput("read access target must be supplied");
	}
	if (requestedTarget !== undefined && (!path.isAbsolute(requestedTarget) || requestedTarget.includes("\u0000"))) {
		return invalidInput("read access target must be absolute");
	}
	const environmentValue = requestValue(request, "environment");
	const environmentValidation = validateMemoryEnvironment(environmentValue as MemoryEnvironment);
	if (!environmentValidation.ok) return environmentValidation;
	const initialized = checkInitializedRoot(environmentValidation.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const rootResult = pinMemoryRoot(environmentValidation.value.memoryRoot);
	if (!rootResult.ok) return rootResult;
	const relativePath =
		typeof requestedRelPath === "string"
			? requestedRelPath
			: path
					.relative(rootResult.value.canonicalPath, requestedTarget as string)
					.split(path.sep)
					.join("/");
	const containedResult = containPath(rootResult.value, relativePath);
	if (!containedResult.ok) return containedResult;
	if (containedResult.value.relativePath.length === 0) {
		return policyDenied("global-canonical", "read access target must name a file");
	}
	const scopePrefix = scopeValue === "global" ? "global/" : scopeValue === "project" ? "projects/" : "sessions/";
	if (!containedResult.value.relativePath.startsWith(scopePrefix)) {
		return policyDenied("global-canonical", "read access scope does not contain the target");
	}
	const leafIdentity = containedResult.value.leafIdentity;
	if (leafIdentity === null) {
		return policyDenied("global-canonical", "read access target does not exist");
	}
	try {
		const leaf = fs.lstatSync(containedResult.value.absolutePath, { bigint: true });
		if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1n || !sameStatIdentity(leaf, leafIdentity)) {
			return policyDenied("global-canonical", "read access target is not a regular single-link file");
		}
	} catch {
		return policyDenied("global-canonical", "read access target could not be inspected");
	}
	if (requestedTarget !== undefined && requestedTarget !== containedResult.value.absolutePath) {
		return policyDenied("global-canonical", "read access target is not canonical");
	}
	return {
		ok: true,
		value: Object.freeze({
			[ReadAccessGrantBrand]: true as const,
			target: containedResult.value.absolutePath,
			relativePath: containedResult.value.relativePath,
			scope: scopeValue,
			root: rootResult.value,
			leafIdentity,
		}),
	};
}

/** Sole read-grant minting entry point. */
export function authorizeReadAccess(request: unknown): MemoryResult<ReadAccessGrant> {
	if (!isRecord(request) || !Object.hasOwn(request, "environment") || !Object.hasOwn(request, "scope")) {
		return invalidInput("read access authorization request is missing required fields");
	}
	try {
		return mintReadGrantUnchecked(request as ReadAccessRequest);
	} catch {
		return policyDenied("global-canonical", "read access policy failed closed");
	}
}

/** Sole grant minting entry point. */
export function authorizeAccess(request: ReadAccessRequest & { readonly kind: "read" }): MemoryResult<ReadAccessGrant>;
export function authorizeAccess(request: unknown): MemoryResult<AccessGrant>;
export function authorizeAccess(
	environment: unknown,
	destination: unknown,
	sensitivity: unknown,
	relPath: unknown,
	content: unknown,
): MemoryResult<AccessGrant>;
export function authorizeAccess(
	environment: unknown,
	destination: unknown,
	sensitivity: unknown,
	relPath: unknown,
	content: unknown,
	override: unknown,
): MemoryResult<AccessGrant>;
export function authorizeAccess(
	first: unknown,
	...rest: readonly unknown[]
): MemoryResult<AccessGrant | ReadAccessGrant> {
	if (rest.length === 0 && isRecord(first) && first.kind === "read") return authorizeReadAccess(first);
	const request = extractRequest(first, rest);
	if (!request.ok) return request;
	return mintGrant(request.value);
}

function isSessionParentAuthorization(value: unknown): value is SessionParentAuthorization {
	if (!isRecord(value)) return false;
	return (
		(value.kind === "create" || value.kind === "pinned") &&
		typeof value.relPath === "string" &&
		typeof value.target === "string" &&
		typeof value.rootPath === "string" &&
		typeof value.rootDev === "bigint" &&
		typeof value.rootIno === "bigint" &&
		isWriteDestination(value.destination) &&
		typeof value.parentPath === "string" &&
		(value.parentDev === null || typeof value.parentDev === "bigint") &&
		(value.parentIno === null || typeof value.parentIno === "bigint") &&
		typeof value.sessionsPath === "string" &&
		typeof value.sessionsDev === "bigint" &&
		typeof value.sessionsIno === "bigint"
	);
}

function isAccessGrant(value: unknown): value is AccessGrant {
	if (!isRecord(value)) return false;
	const candidate = value as Partial<AccessGrant>;
	return (
		candidate[AccessGrantBrand] === true &&
		typeof candidate.target === "string" &&
		typeof candidate.relativePath === "string" &&
		isWriteDestination(candidate.destination) &&
		typeof candidate.contentDigest === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.contentDigest) &&
		candidate.root !== undefined &&
		(candidate.parentCreation === undefined || isSessionParentAuthorization(candidate.parentCreation))
	);
}
function verifySessionParentState(grant: AccessGrant, authorization: SessionParentAuthorization): MemoryResult<true> {
	const label = grant.destination === "ledger" ? "ledger" : "checkpoint";
	try {
		const rootBinding = assertRootBinding(grant.root);
		if (!rootBinding.ok) return withDestination(rootBinding, grant.destination);
		const sessionsStat = fs.lstatSync(authorization.sessionsPath, { bigint: true });
		if (
			!isTrustedDirectory(sessionsStat, grant.root.dev) ||
			sessionsStat.dev !== authorization.sessionsDev ||
			sessionsStat.ino !== authorization.sessionsIno
		) {
			return policyDenied(grant.destination, `${label} sessions directory binding changed`);
		}
		let parentStat: fs.BigIntStats;
		try {
			parentStat = fs.lstatSync(authorization.parentPath, { bigint: true });
		} catch (error) {
			if (errorCode(error) === "ENOENT" && authorization.kind === "create") return { ok: true, value: true };
			return policyDenied(grant.destination, `${label} session directory binding changed`);
		}
		if (!isTrustedDirectory(parentStat, grant.root.dev)) {
			return policyDenied(grant.destination, `${label} session directory is not trusted`);
		}
		if (
			authorization.kind === "pinned" &&
			(parentStat.dev !== authorization.parentDev || parentStat.ino !== authorization.parentIno)
		) {
			return policyDenied(grant.destination, `${label} session directory identity changed`);
		}
		return { ok: true, value: true };
	} catch {
		return policyDenied(grant.destination, `${label} session directory binding could not be verified`);
	}
}

/** Internal storage check: a grant is bound to exactly one target, destination, root, and byte digest. */

export function verifyAccessGrant(
	grant: unknown,
	target: unknown,
	destination: unknown,
	contentDigest: unknown,
): MemoryResult<AccessGrant> {
	const verifierDestination = isWriteDestination(destination) ? destination : "global-canonical";
	try {
		if (!isAccessGrant(grant)) return policyDenied(verifierDestination, "access grant is invalid");
		if (typeof target !== "string" || !isWriteDestination(destination) || typeof contentDigest !== "string") {
			return invalidInput("access grant verification arguments are invalid");
		}
		if (grant.destination !== destination || grant.target !== target) {
			return policyDenied(destination, "access grant target binding changed");
		}
		if (grant.contentDigest !== contentDigest) {
			return policyDenied(destination, "access grant content binding changed");
		}
		const rootBinding = pinMemoryRoot(grant.root.canonicalPath);
		if (!rootBinding.ok) return withDestination(rootBinding, grant.destination);
		if (rootBinding.value.dev !== grant.root.dev || rootBinding.value.ino !== grant.root.ino) {
			return policyDenied(destination, "access grant root binding changed");
		}
		const authorization = grant.parentCreation;
		if (authorization !== undefined) {
			const authorizationCheck = parentAuthorizationValid(grant);
			if (!authorizationCheck.ok) return authorizationCheck;
			const parentState = verifySessionParentState(grant, authorizationCheck.value);
			if (!parentState.ok) return parentState;
		}
		let contained = containPath(grant.root, grant.relativePath);
		if (!contained.ok) {
			if (authorization === undefined || authorization.kind !== "create") {
				return withDestination(contained, grant.destination);
			}
			const rootRecheck = assertRootBinding(grant.root);
			if (!rootRecheck.ok) return withDestination(rootRecheck, grant.destination);
			let parentStat: fs.BigIntStats;
			try {
				parentStat = fs.lstatSync(authorization.parentPath, { bigint: true });
			} catch (error) {
				if (errorCode(error) === "ENOENT") return { ok: true, value: grant };
				return withDestination(contained, grant.destination);
			}
			if (!isTrustedDirectory(parentStat, grant.root.dev)) return withDestination(contained, grant.destination);
			const rebound = containPath(grant.root, grant.relativePath, true);
			if (!rebound.ok) return withDestination(contained, grant.destination);
			if (rebound.value.components.length === 1) return { ok: true, value: grant };
			if (rebound.value.absolutePath !== grant.target || rebound.value.parentPath !== authorization.parentPath) {
				return withDestination(contained, grant.destination);
			}
			const parentComponent = rebound.value.components.at(-1);
			if (
				parentComponent === undefined ||
				parentComponent.name !== path.basename(authorization.parentPath) ||
				// A `ComponentPin` carries only the device/inode pair, which is the
				// identity that must not change across the authorized parent creation.
				parentComponent.dev !== parentStat.dev ||
				parentComponent.ino !== parentStat.ino
			) {
				return withDestination(contained, grant.destination);
			}
			contained = rebound;
		}
		if (contained.ok && contained.value.absolutePath !== grant.target) {
			return policyDenied(destination, "access grant containment changed");
		}
		return { ok: true, value: grant };
	} catch {
		return policyDenied(verifierDestination, "access grant verification failed closed");
	}
}

function isReadAccessGrant(value: unknown): value is ReadAccessGrant {
	if (!isRecord(value)) return false;
	const candidate = value as Partial<ReadAccessGrant>;
	return (
		candidate[ReadAccessGrantBrand] === true &&
		typeof candidate.target === "string" &&
		typeof candidate.relativePath === "string" &&
		isMemoryScopeKind(candidate.scope) &&
		candidate.root !== undefined &&
		isPathIdentity(candidate.leafIdentity)
	);
}

/** Re-check a read grant's canonical target, scope, and root binding before disclosure. */
export function verifyReadAccessGrant(grant: unknown, target: unknown, scope: unknown): MemoryResult<ReadAccessGrant> {
	try {
		if (!isReadAccessGrant(grant)) return policyDenied("global-canonical", "read access grant is invalid");
		if (typeof target !== "string" || !isMemoryScopeKind(scope)) {
			return invalidInput("read access grant verification arguments are invalid");
		}
		if (grant.target !== target || grant.scope !== scope) {
			return policyDenied("global-canonical", "read access grant target binding changed");
		}
		const rootBinding = pinMemoryRoot(grant.root.canonicalPath);
		if (!rootBinding.ok) return rootBinding;
		if (rootBinding.value.dev !== grant.root.dev || rootBinding.value.ino !== grant.root.ino) {
			return policyDenied("global-canonical", "read access grant root binding changed");
		}
		const contained = containPath(grant.root, grant.relativePath);
		if (!contained.ok) return contained;
		const scopePrefix = grant.scope === "global" ? "global/" : grant.scope === "project" ? "projects/" : "sessions/";
		if (!contained.value.relativePath.startsWith(scopePrefix)) {
			return policyDenied("global-canonical", "read access scope does not contain the target");
		}
		if (contained.value.absolutePath !== grant.target || contained.value.leafIdentity === null) {
			return policyDenied("global-canonical", "read access grant containment changed");
		}
		if (!samePathIdentity(contained.value.leafIdentity, grant.leafIdentity)) {
			return policyDenied("global-canonical", "read access grant leaf identity changed");
		}
		const leaf = fs.lstatSync(contained.value.absolutePath, { bigint: true });
		if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1n || !sameStatIdentity(leaf, grant.leafIdentity)) {
			return policyDenied("global-canonical", "read access grant target is not a regular single-link file");
		}
		return { ok: true, value: grant };
	} catch {
		return policyDenied("global-canonical", "read access grant verification failed closed");
	}
}
export type { SecretFinding };
