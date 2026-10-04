import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";

import type { RecoveryFsRoot } from "@gajae-code/natives";

type NativeManagedScope = Pick<
	typeof import("@gajae-code/natives"),
	| "applyOwnerOnlyPathSecurity"
	| "canonicalExistingDirectoryIdentity"
	| "exactRestore"
	| "exactUnlink"
	| "snapshotDirectoryTree"
	| "verifyOwnerOnlyPathSecurity"
	| "verifyOwnerOnlyPathSecurityExpected"
>;

function nativeScope(): NativeManagedScope {
	return require("@gajae-code/natives") as NativeManagedScope;
}

import { hasFsCode, logger, pathIsWithin } from "@gajae-code/utils";
import type { ResumeSessionIdentity } from "../session-manager";
import {
	FileSessionStorage,
	type NativeDirectoryTreeSnapshot,
	type SessionStorageFileIdentity,
	type SessionStorageSnapshot,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../session-storage";
import { parseFirstJsonlLine } from "../session-transcript-header";
import {
	parseTaskArtifactOwnerDeletionEvidence,
	parseTaskArtifactOwnerRetirementOutcome,
	type TaskArtifactOwnerDeletionEvidence,
	type TaskArtifactOwnerStorageContext,
} from "../task-artifact-owner-codec";
import { verifyTaskArtifactOwnerPhysicalRetirement } from "../task-artifact-owner-retirement";
import {
	continuationExtendsPrevious,
	type ManagedGcSessionRetirementReceipt,
	type ManagedGcSessionRetirementState,
	type ManagedGcSessionRetirementTarget,
	managedGcRetirementIdentityRecord,
	managedGcRetirementIdentityValue,
	parseManagedGcRetirementReceipt,
	sameIdentity,
} from "./managed-gc-retirement-codec";
import {
	acquireManagedLock,
	assertManagedDirectoryRoot,
	captureManagedFileNoFollow,
	captureManagedFilePrefixNoFollow,
	copyManagedFileNoReplace,
	ensureManagedDirectory,
	fsyncManagedArtifactTree,
	inspectManagedFileNoFollow,
	isManagedLockQuarantineName,
	MANAGED_ARTIFACT_COPY_BATCH_SIZE,
	MANAGED_ARTIFACT_MAX_FILES,
	MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
	type ManagedDirectoryRoot,
	type ManagedFileSnapshot,
	ManagedPublishError,
	ManagedSessionDescendantStore,
	type ManagedSessionSecurityPolicy,
	type ManagedStorageLock,
	managedDirectoryRoot,
	managedSecurityFailureClassification,
	parseManagedLockRecord,
	prepareManagedDirectoryRoot,
	publishManagedFileNoReplace,
	publishManagedTombstone,
	reapScrubbedProtocolRemnantsSync,
	retainManagedDirectoryAuthority,
	validateManagedArtifactTree,
	validateNativeSecurityResult,
} from "./managed-session-storage";
import { captureTaskArtifactOwnerDeletionEvidence } from "./task-artifact-owner-access";
import { taskArtifactOwnerLocatorFromTranscriptBytes } from "./task-artifact-owner-transcript";

export const MANAGED_SESSION_LAYOUT_VERSION = 2 as const;
export const MANAGED_SESSION_IDENTITY_VERSION = 1 as const;
export const MANAGED_SESSION_BINDING_FILE = ".gjc-managed-session-scope.v2.json";

export interface ManagedScope {
	apiVersion: 1;
	layoutVersion: 2;
	identityVersion: 1;
	agentDir: string;
	sessionsRoot: string;
	canonicalCwd: string;
	legacyLexicalCwd: string;
	directoryName: string;
	directoryPath: string;
	platform: "posix" | "win32";
}

export interface ManagedGcProtocolPathIdentity {
	readonly path: string;
	readonly dev: string;
	readonly ino: string;
}

export interface ManagedGcProtocolFileSnapshot {
	readonly name: string;
	readonly dev: string;
	readonly ino: string;
	readonly nlink: string;
	readonly size: number;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly mode: number;
	readonly sha256: string;
}

export type ManagedGcProtocolRole = "locks" | "receipts" | "tombstones";

export interface ManagedGcProtocolDirectorySnapshot {
	readonly role: ManagedGcProtocolRole;
	readonly path: string;
	readonly dev: string;
	readonly ino: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly mode: number;
	readonly files: readonly ManagedGcProtocolFileSnapshot[];
}

/** Read-only protocol data; never a deletion capability. */
export interface ManagedGcProtocolScopeSnapshot {
	readonly configuredRoot: ManagedGcProtocolPathIdentity;
	readonly profile: ManagedGcProtocolPathIdentity;
	readonly sessionsRoot: ManagedGcProtocolPathIdentity;
	readonly scope: ManagedGcProtocolPathIdentity;
	readonly binding: ManagedGcProtocolFileSnapshot;
	readonly protocol: ManagedGcProtocolPathIdentity;
	readonly protocolMtimeNs: string;
	readonly protocolCtimeNs: string;
	readonly protocolMode: number;
	readonly directories: readonly ManagedGcProtocolDirectorySnapshot[];
}

export interface ManagedGcProtocolScopeInput {
	readonly scopePath: string;
	readonly scopeIdentity: ManagedGcProtocolPathIdentity;
	readonly bindingIdentity: ManagedGcProtocolFileSnapshot;
	readonly protocolIdentity: ManagedGcProtocolScopeSnapshot["protocol"] & {
		readonly mtimeNs: string;
		readonly ctimeNs: string;
		readonly mode: number;
	};
}

export type ManagedGcProtocolScopeInspector = (
	inputs: readonly ManagedGcProtocolScopeInput[],
) => Promise<readonly ManagedGcProtocolScopeSnapshot[]>;

/**
 * Opaque managed writer authority captured by a trusted destination. The open
 * transaction must use this authority rather than reacquiring its root from a
 * pathname after resume inspection.
 */
export interface ManagedCandidateWriteAuthority {
	readonly rootAuthority: ManagedDirectoryRoot;
	readonly retainedAuthority?: RecoveryFsRoot;
	readonly retainedDirectory?: string;
}

const managedRoots = new WeakMap<ManagedScope, ReturnType<typeof prepareManagedDirectoryRoot>>();
const managedScopeConfigurations = new WeakMap<
	ManagedScope,
	Readonly<
		Pick<ManagedScope, "agentDir" | "sessionsRoot" | "canonicalCwd" | "directoryName" | "directoryPath" | "platform">
	>
>();
const managedDirectoryIdentities = new WeakMap<ManagedScope, { dev: bigint; ino: bigint }>();
const managedDirectoryAuthorities = new WeakMap<ManagedScope, RecoveryFsRoot | undefined>();
const boundManagedWriteAuthorities = new WeakMap<ManagedScope, ManagedCandidateWriteAuthority>();
const readManagedGcScopeIdentities = new WeakMap<
	ManagedScope,
	{
		readonly configuredRoot: { readonly path: string; readonly dev: bigint; readonly ino: bigint };
		readonly profile: { readonly path: string; readonly dev: bigint; readonly ino: bigint };
		readonly sessions: { readonly path: string; readonly dev: bigint; readonly ino: bigint };
	}
>();

function bindManagedWriteAuthority(scope: ManagedScope, authority: ManagedCandidateWriteAuthority): void {
	if (
		authority.retainedAuthority &&
		authority.retainedDirectory !== undefined &&
		path.resolve(authority.retainedDirectory) === path.resolve(scope.directoryPath)
	) {
		new ManagedSessionDescendantStore(authority.rootAuthority, scope.directoryPath, {
			authority: authority.retainedAuthority,
			authorityBaseDir: scope.directoryPath,
		}).assertBound();
	} else {
		assertManagedDirectoryRoot(authority.rootAuthority);
	}
	managedRoots.set(scope, authority.rootAuthority);
	boundManagedWriteAuthorities.set(scope, authority);
}

/** A prepared scope is a retained authority boundary, not a path that may be re-adopted. */
function assertRetainedManagedDirectoryIdentity(scope: ManagedScope): void {
	const expected = managedDirectoryIdentities.get(scope);
	if (!expected) return;
	const current = fs.lstatSync(scope.directoryPath, { bigint: true });
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino
	)
		throw new Error("Managed session directory changed");
}

export function managedDirectoryAuthorityForScope(scope: ManagedScope): RecoveryFsRoot | undefined {
	if (!managedDirectoryAuthorities.has(scope)) throw new Error("Managed session directory authority was not prepared");
	return managedDirectoryAuthorities.get(scope);
}

export function managedDirectoryIdentityForScope(scope: ManagedScope): { dev: bigint; ino: bigint } {
	const identity = managedDirectoryIdentities.get(scope);
	if (!identity) throw new Error("Managed session directory identity was not prepared");
	return identity;
}

function configuredRootPath(scope: ManagedScope): string {
	let candidate = pathIsWithin(scope.agentDir, scope.sessionsRoot) ? scope.agentDir : path.dirname(scope.sessionsRoot);
	const suffix: string[] = [];
	for (;;) {
		try {
			const stat = fs.lstatSync(candidate);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe configured root: ${candidate}`);
			const canonical = fs.realpathSync.native(candidate);
			return suffix.length === 0 ? canonical : path.join(canonical, ...suffix);
		} catch (error) {
			if (!hasFsCode(error, "ENOENT")) throw error;
			const parent = path.dirname(candidate);
			if (parent === candidate) throw new Error("Configured managed root is unavailable.");
			suffix.unshift(path.basename(candidate));
			candidate = parent;
		}
	}
}

function scopeRoot(scope: ManagedScope, policy: ManagedSessionSecurityPolicy = "default") {
	const bound = boundManagedWriteAuthorities.get(scope);
	if (bound) {
		bindManagedWriteAuthority(scope, bound);
		return bound.rootAuthority;
	}
	const retained = managedRoots.get(scope);
	if (retained) return retained;
	const root = prepareManagedDirectoryRoot(configuredRootPath(scope), policy);
	managedRoots.set(scope, root);
	return root;
}

export function managedRootForScope(scope: ManagedScope) {
	return scopeRoot(scope);
}

export type ManagedMigrationPolicy = "copy-retain" | "disabled";

export type ManagedScopeErrorCode =
	| "cwd_missing"
	| "cwd_not_directory"
	| "identity_unavailable"
	| "network_unsupported"
	| "sessions_root_unavailable"
	| "binding_conflict"
	| "binding_invalid"
	| "migration_busy"
	| "atomic_unavailable"
	| "invalid_request"
	| "durability_failed"
	| "durability_not_provable"
	| "capacity_exceeded";

export type ManagedScopeResolution =
	| { kind: "resolved"; scope: ManagedScope }
	| {
			kind: "error";
			code: ManagedScopeErrorCode;
			message: string;
			cause?: { readonly classification: string; readonly diagnostic?: string };
	  };

/**
 * Fixed, path-free identity tokens thrown as plain errors by the managed
 * storage guards (`assertManagedPathIdentity`). They carry no pathname, so
 * propagating them keeps startup redaction intact while telling the operator
 * which invariant actually failed instead of a blanket `binding_invalid`.
 */
const managedScopeIdentityFailureCodes = new Set(["identity_mismatch", "reparse_point", "not_directory", "not_file"]);

/**
 * Fixed, path-free errno tokens. A managed scope that fails to prepare because
 * another process holds the object (AV scanners, indexers, cloud-sync agents)
 * is operationally distinct from a corrupted binding, and only the errno
 * distinguishes them. Node places the pathname in `.message`/`.path`, never in
 * `.code`, so the token alone is safe to surface.
 */
const managedScopeErrnoFailureCodes = new Set([
	"EACCES",
	"EPERM",
	"EBUSY",
	"EROFS",
	"ENOSPC",
	"EMFILE",
	"ENFILE",
	"ELOOP",
	"ENOTDIR",
]);

const managedScopeFailureCodes = new Set<ManagedScopeErrorCode>([
	"atomic_unavailable",
	"invalid_request",
	"durability_failed",
	"durability_not_provable",
	"migration_busy",
	"capacity_exceeded",
]);

/**
 * A scope whose directory outgrew a scan budget. The binding is untouched and
 * canonical; only the surrounding entry count is over budget, so this must not
 * be reported as binding corruption.
 */
function isManagedScopeCapacityMessage(message: string): boolean {
	return message === "artifact_capacity_exceeded" || message === "managed_replace_cleanup_receipt_limit_exceeded";
}

/**
 * Recover the path-free classification for a failure that carries no security
 * classification of its own.
 *
 * `managedScopeFailureCodes` deliberately stays out of this: those tokens are
 * already reported through `code`, and the `code`/`classification` split is
 * pinned behaviour. This only rescues the identity and errno failures that
 * otherwise reach the operator as an undifferentiated `binding_invalid`.
 */
function managedScopeResidualClassification(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	if (managedScopeIdentityFailureCodes.has(error.message)) return error.message;
	const errno = (error as NodeJS.ErrnoException).code;
	return errno !== undefined && managedScopeErrnoFailureCodes.has(errno) ? errno : undefined;
}

/**
 * Preserve a recognized native/publication failure as its own error code.
 *
 * Collapsing every unrecognized message into `binding_invalid` misreports
 * unrelated failures — a `content_too_large` tree snapshot, for example — as a
 * corrupt binding, which sends operators to delete a healthy binding file.
 */
function managedScopeErrorCode(message: string): ManagedScopeErrorCode {
	if (message === "content_too_large" || isManagedScopeCapacityMessage(message)) return "capacity_exceeded";
	return managedScopeFailureCodes.has(message as ManagedScopeErrorCode)
		? (message as ManagedScopeErrorCode)
		: "binding_invalid";
}

function managedScopeFailureCause(error: unknown): { readonly classification: string } {
	const security = managedSecurityFailureClassification(error);
	if (security) return { classification: security };
	const residual = managedScopeResidualClassification(error);
	if (residual) return { classification: residual };
	return {
		classification: managedScopeErrorCode(error instanceof Error ? error.message : ""),
	};
}

function managedScopeFailureMessage(error: unknown, fallback: string): string {
	const classification = managedSecurityFailureClassification(error);
	if (classification) return classification;
	if (!(error instanceof Error)) return fallback;
	if (error.message === "content_too_large" || isManagedScopeCapacityMessage(error.message)) return error.message;
	if (managedScopeFailureCodes.has(error.message as ManagedScopeErrorCode)) return error.message;
	return managedScopeResidualClassification(error) ?? fallback;
}

export interface ManagedCandidate {
	sessionId: string;
	path: string;
	cwd: string;
	provenance: "v2" | "legacy";
	identity: ResumeSessionIdentity;
	migrationState: "native_v2" | "legacy_unmigrated" | "migrated_v2";
}

export type ManagedCandidateListing =
	| {
			kind: "complete";
			scope: ManagedScope;
			owned: readonly ManagedCandidate[];
			foreignCount: number;
			invalid: readonly { code: string; sessionId?: string }[];
	  }
	| { kind: "error"; code: "scan_failed" | "unsafe_root" | "invalid_candidate"; message: string };

export type ManagedOpenFailure =
	| "migration_busy"
	| "binding_conflict"
	| "binding_invalid"
	| "destination_conflict"
	| "source_changed"
	| "unsafe_artifacts"
	| "artifact_capacity_exceeded"
	| "durability_failed"
	| "atomic_unavailable"
	| "invalid_request"
	| "durability_not_provable"
	| "migration_retired"
	| "legacy_migration_disabled"
	| "managed_storage_unsupported";

export type ManagedOpenCandidateResult =
	| { kind: "opened"; path: string; candidate: ManagedCandidate; migrated: boolean }
	| { kind: "error"; code: ManagedOpenFailure; message: string };

export type ManagedDeleteCandidateResult =
	| { kind: "deleted"; tombstonePath: string }
	| { kind: "already_deleted"; tombstonePath: string }
	| { kind: "cleanup_pending"; tombstonePath: string; phase: "artifacts" | "transcript"; message: string }
	| { kind: "error"; code: ManagedOpenFailure; message: string };

export interface ManagedVerifiedDeleteTestEvent {
	readonly flow: "direct" | "reconcile";
	readonly stage: "initial" | "artifact-finalization" | "transcript-after-artifacts-removed";
}

export interface ManagedLockReleaseTestEvent {
	readonly path: string;
	readonly attemptId: string;
}

/** Test-only ordering seams for verified deletion and managed-lock release. */
export const ManagedSessionScopeTestHooks: {
	beforeVerifiedDelete?: (event: ManagedVerifiedDeleteTestEvent) => void | Promise<void>;
	beforeManagedLockRelease?: (event: ManagedLockReleaseTestEvent) => void | Promise<void>;
	afterCandidatePreflight?: (event: { readonly sessionId?: string }) => void;
} = {};

async function deleteSessionVerifiedWithFence(
	flow: ManagedVerifiedDeleteTestEvent["flow"],
	stage: ManagedVerifiedDeleteTestEvent["stage"],
	lock: ManagedStorageLock,
	target: VerifiedSessionDeleteTarget,
	verifyAuthority?: () => void,
): Promise<VerifiedSessionDeleteResult> {
	lock.assertOwned();
	verifyAuthority?.();
	const hook = ManagedSessionScopeTestHooks.beforeVerifiedDelete;
	if (hook) await hook({ flow, stage });
	lock.assertOwned();
	verifyAuthority?.();
	assertLegacyOwnerFreeTranscript(target);
	return new FileSessionStorage().deleteSessionVerified(target);
}

type NativeIdentity =
	| { ok: true; platform: "posix" | "win32"; canonicalPath: string }
	| { ok: false; code: NativeIdentityFailureCode };
type CanonicalNativeIdentity = Extract<NativeIdentity, { ok: true }>;

type NativeIdentityFailureCode =
	| "not_found"
	| "not_directory"
	| "not_utf8"
	| "network_unsupported"
	| "identity_unavailable"
	| "io_error";

interface Binding {
	schemaVersion: 1;
	layoutVersion: 2;
	identityVersion: 1;
	platform: "posix" | "win32";
	canonicalPath: string;
	identityDigest: string;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const HEADER_MAX_BYTES = 64 * 1024;

function scopeDigest(platform: "posix" | "win32", canonicalPath: string): string {
	const bytes = createHash("sha256")
		.update("gjc-managed-session-scope\0identity-v1\0", "utf8")
		.update(platform, "utf8")
		.update("\0", "utf8")
		.update(canonicalPath, "utf8")
		.digest();
	let result = "";
	let accumulator = 0;
	let bits = 0;
	for (const byte of bytes) {
		accumulator = (accumulator << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += BASE32[(accumulator >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) result += BASE32[(accumulator << (5 - bits)) & 31];
	return result;
}
export const computeManagedScopeDigest = scopeDigest;

function identityFor(cwd: string): NativeIdentity {
	return nativeScope().canonicalExistingDirectoryIdentity(cwd) as NativeIdentity;
}

function verifyExistingManagedScopeDirectory(pathname: string) {
	if (process.platform !== "win32") return nativeScope().verifyOwnerOnlyPathSecurity(pathname, "directory");
	const expected = fs.lstatSync(pathname, { bigint: true });
	if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error("reparse_point");
	const verified = nativeScope().verifyOwnerOnlyPathSecurityExpected(
		pathname,
		"directory",
		expected.dev,
		expected.ino,
	);
	const current = fs.lstatSync(pathname, { bigint: true });
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino
	)
		throw new Error("identity_mismatch");
	return verified;
}

function canonicalExistingPathForIo(base: string, identity: CanonicalNativeIdentity): string {
	if (identity.platform !== "win32") return identity.canonicalPath;
	try {
		// Native identity uses a stable Volume GUID path on Windows. Bun 1.3.14
		// cannot reliably create/read files through that path, so retain the
		// symlink-resolved DOS path for JavaScript filesystem I/O.
		return fs.realpathSync.native(base);
	} catch {
		return path.resolve(base);
	}
}

/**
 * Resolve benign symlinks in the deepest existing ancestor of a trusted storage
 * root (e.g. macOS `/var -> /private/var`, or a symlinked `$HOME`) while keeping
 * any not-yet-created tail verbatim. The native owner-only primitive and the
 * session-storage reparse guard traverse with `O_NOFOLLOW` and reject every
 * symlink component, so the trusted root must be canonical before it reaches
 * them; canonicalizing only the existing prefix never follows an
 * attacker-plantable component below the root.
 */
export function canonicalizeTrustedPath(target: string): string {
	let base = path.resolve(target);
	const suffix: string[] = [];
	for (;;) {
		const identity = nativeScope().canonicalExistingDirectoryIdentity(base) as NativeIdentity;
		if (identity.ok) {
			const canonicalBase = canonicalExistingPathForIo(base, identity);
			return suffix.length === 0 ? canonicalBase : path.join(canonicalBase, ...suffix);
		}
		if (identity.code !== "not_found" && identity.code !== "not_directory") return path.resolve(target);
		const parent = path.dirname(base);
		if (parent === base) return path.resolve(target);
		suffix.unshift(path.basename(base));
		base = parent;
	}
}

function nativeFailure(code: NativeIdentityFailureCode): ManagedScopeResolution {
	if (code === "not_found")
		return { kind: "error", code: "cwd_missing", message: "The workspace directory does not exist." };
	if (code === "not_directory")
		return { kind: "error", code: "cwd_not_directory", message: "The workspace path is not a directory." };
	if (code === "network_unsupported") {
		return {
			kind: "error",
			code: "network_unsupported",
			message: "Network workspace directories are not supported.",
		};
	}
	return { kind: "error", code: "identity_unavailable", message: "Workspace directory identity is unavailable." };
}

function bindingFor(scope: ManagedScope): Binding {
	return {
		schemaVersion: 1,
		layoutVersion: 2,
		identityVersion: 1,
		platform: scope.platform,
		canonicalPath: scope.canonicalCwd,
		identityDigest: scope.directoryName.slice(3),
	};
}

function isBinding(value: unknown): value is Binding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const binding = value as Record<string, unknown>;
	return (
		binding.schemaVersion === 1 &&
		binding.layoutVersion === 2 &&
		binding.identityVersion === 1 &&
		(binding.platform === "posix" || binding.platform === "win32") &&
		typeof binding.canonicalPath === "string" &&
		typeof binding.identityDigest === "string" &&
		/^[a-z2-7]{52}$/.test(binding.identityDigest)
	);
}

function validateBindingRaw(scope: ManagedScope, raw: string): ManagedScopeResolution | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "error", code: "binding_invalid", message: "The managed scope binding is invalid JSON." };
	}
	if (!isBinding(parsed))
		return { kind: "error", code: "binding_invalid", message: "The managed scope binding is invalid." };
	const expected = bindingFor(scope);
	if (
		parsed.platform !== expected.platform ||
		parsed.canonicalPath !== expected.canonicalPath ||
		parsed.identityDigest !== expected.identityDigest
	) {
		return {
			kind: "error",
			code: "binding_conflict",
			message: "The managed scope binding belongs to another workspace.",
		};
	}
	if (raw !== `${JSON.stringify(expected)}\n`) {
		return {
			kind: "error",
			code: "binding_invalid",
			message: "The managed scope binding is not canonically encoded.",
		};
	}
	return undefined;
}

function validateExistingBinding(scope: ManagedScope): ManagedScopeResolution | undefined {
	const bindingPath = path.join(scope.directoryPath, MANAGED_SESSION_BINDING_FILE);
	let raw: string;
	try {
		raw = captureManagedFileNoFollow(bindingPath).bytes.toString("utf8");
	} catch (error) {
		if (hasFsCode(error, "ENOENT")) return undefined;
		const classification = hasFsCode(error, "EACCES")
			? "EACCES"
			: hasFsCode(error, "EPERM")
				? "EPERM"
				: "binding_invalid";
		return {
			kind: "error",
			code: "binding_invalid",
			message: "The managed scope binding is invalid JSON.",
			cause: { classification },
		};
	}
	return validateBindingRaw(scope, raw);
}

interface ManagedScopeInput {
	cwd: string;
	agentDir: string;
	sessionsRoot: string;
}

function resolveManagedScopeInternal(
	input: ManagedScopeInput,
	allowRepairableAclFailure: boolean,
): ManagedScopeResolution {
	const identity = identityFor(input.cwd);
	if (!identity.ok) return nativeFailure(identity.code);
	try {
		if (fs.lstatSync(input.sessionsRoot).isSymbolicLink()) {
			return {
				kind: "error",
				code: "sessions_root_unavailable",
				message: "The sessions root is not a safe directory.",
				cause: { classification: "reparse_point" },
			};
		}
	} catch (error) {
		if (!hasFsCode(error, "ENOENT")) {
			return {
				kind: "error",
				code: "sessions_root_unavailable",
				message: "The sessions root could not be inspected.",
			};
		}
	}
	const sessionsRoot = canonicalizeTrustedPath(input.sessionsRoot);
	const agentDir = canonicalizeTrustedPath(input.agentDir);
	const digest = scopeDigest(identity.platform, identity.canonicalPath);
	const scope: ManagedScope = {
		apiVersion: 1,
		layoutVersion: MANAGED_SESSION_LAYOUT_VERSION,
		identityVersion: MANAGED_SESSION_IDENTITY_VERSION,
		agentDir,
		sessionsRoot,
		canonicalCwd: identity.canonicalPath,
		legacyLexicalCwd: path.resolve(input.cwd),
		directoryName: `v2-${digest}`,
		directoryPath: path.join(sessionsRoot, `v2-${digest}`),
		platform: identity.platform,
	};
	managedScopeConfigurations.set(
		scope,
		Object.freeze({
			agentDir: scope.agentDir,
			sessionsRoot: scope.sessionsRoot,
			canonicalCwd: scope.canonicalCwd,
			directoryName: scope.directoryName,
			directoryPath: scope.directoryPath,
			platform: scope.platform,
		}),
	);
	try {
		const root = fs.lstatSync(sessionsRoot);
		if (!root.isDirectory() || root.isSymbolicLink()) {
			return {
				kind: "error",
				code: "sessions_root_unavailable",
				message: "The sessions root is not a safe directory.",
				cause: { classification: "reparse_point" },
			};
		}
	} catch (error) {
		if (!hasFsCode(error, "ENOENT")) {
			return {
				kind: "error",
				code: "sessions_root_unavailable",
				message: "The sessions root could not be inspected.",
			};
		}
	}
	try {
		const directory = fs.lstatSync(scope.directoryPath);
		if (!directory.isDirectory() || directory.isSymbolicLink()) {
			return {
				kind: "error",
				code: "binding_invalid",
				message: "The managed scope path is not a safe directory.",
				cause: { classification: "reparse_point" },
			};
		}
		const security = validateNativeSecurityResult(
			verifyExistingManagedScopeDirectory(scope.directoryPath),
			"verify",
			"directory",
		);
		if (!security.ok && (!allowRepairableAclFailure || security.code !== "acl_verify_failed")) {
			return {
				kind: "error",
				code: "binding_invalid",
				message: "The managed scope security could not be verified.",
			};
		}
	} catch (error) {
		if (!hasFsCode(error, "ENOENT")) {
			return {
				kind: "error",
				code: "binding_invalid",
				message: "The managed scope path could not be inspected.",
			};
		}
	}
	return validateExistingBinding(scope) ?? { kind: "resolved", scope };
}

export function resolveManagedScope(input: ManagedScopeInput): ManagedScopeResolution {
	return resolveManagedScopeInternal(input, false);
}

/** Resolve a scope for a synchronous write without mutating an existing ACL mismatch. */
export function resolveManagedScopeForWrite(input: ManagedScopeInput): ManagedScopeResolution {
	return resolveManagedScopeInternal(input, true);
}

/** Resolve only an existing, authenticated v2 scope; this path never initializes or repairs storage. */
export function resolveManagedGcScopeForRead(input: ManagedScopeInput): ManagedScopeResolution {
	const resolved = resolveManagedScope(input);
	if (resolved.kind === "error") return resolved;
	const scope = resolved.scope;
	try {
		const rootPath = configuredRootPath(scope);
		if (
			path.resolve(scope.agentDir) !== scope.agentDir ||
			path.resolve(scope.sessionsRoot) !== scope.sessionsRoot ||
			path.dirname(scope.directoryPath) !== scope.sessionsRoot ||
			scope.directoryName !== `v2-${scopeDigest(scope.platform, scope.canonicalCwd)}`
		)
			throw new Error("managed_gc_scope_authority_mismatch");
		const captureDirectory = (pathname: string) => {
			const stat = fs.lstatSync(pathname, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed_gc_scope_authority_mismatch");
			const security = validateNativeSecurityResult(
				verifyExistingManagedScopeDirectory(pathname),
				"verify",
				"directory",
			);
			if (!security.ok) throw new Error("managed_gc_scope_authority_mismatch");
			return { path: pathname, dev: stat.dev, ino: stat.ino };
		};
		const configuredRoot = captureDirectory(rootPath);
		const profile = captureDirectory(scope.agentDir);
		const sessions = captureDirectory(scope.sessionsRoot);
		const scopeDirectory = captureDirectory(scope.directoryPath);
		const rootAuthority = managedDirectoryRoot(rootPath);
		if (
			rootAuthority.canonicalPath !== rootPath ||
			rootAuthority.dev !== BigInt.asUintN(64, configuredRoot.dev) ||
			rootAuthority.ino !== BigInt.asUintN(64, configuredRoot.ino)
		)
			throw new Error("managed_gc_scope_authority_mismatch");
		const bindingPath = path.join(scope.directoryPath, MANAGED_SESSION_BINDING_FILE);
		const binding = captureManagedFileNoFollow(bindingPath);
		if (validateBindingRaw(scope, binding.bytes.toString("utf8")))
			throw new Error("managed_gc_scope_authority_mismatch");
		for (const expected of [configuredRoot, profile, sessions, scopeDirectory]) {
			const current = fs.lstatSync(expected.path, { bigint: true });
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				current.dev !== expected.dev ||
				current.ino !== expected.ino
			)
				throw new Error("managed_gc_scope_authority_mismatch");
		}
		managedRoots.set(scope, rootAuthority);
		managedDirectoryIdentities.set(scope, { dev: scopeDirectory.dev, ino: scopeDirectory.ino });
		managedDirectoryAuthorities.set(scope, undefined);
		readManagedGcScopeIdentities.set(scope, { configuredRoot, profile, sessions });
		return resolved;
	} catch (error) {
		return {
			kind: "error",
			code: "binding_invalid",
			message: "The existing managed GC read authority could not be verified.",
			cause: { classification: managedScopeResidualClassification(error) ?? "managed_gc_scope_authority_mismatch" },
		};
	}
}

function legacyDirectoryNames(
	platform: ManagedScope["platform"],
	canonicalCwd: string,
	lexicalCwd: string,
): readonly string[] {
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	const encodeAbsolute = (value: string): string => `--${value.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const encodeRelative = (value: string): string => value.replace(/[/\\:]/g, "-");
	const relativeTo = (root: string, target: string): string | undefined => {
		const relative = pathApi.relative(root, target);
		return relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)
			? undefined
			: relative;
	};
	const names = new Set<string>([encodeAbsolute(canonicalCwd), encodeAbsolute(lexicalCwd)]);
	const canonicalRoot = (root: string): string => {
		const identity = nativeScope().canonicalExistingDirectoryIdentity(root);
		return identity.ok ? identity.canonicalPath : pathApi.resolve(root);
	};
	const home = os.homedir();
	// Volume-GUID canonical identities cannot be relativized against normal drive paths.
	// Legacy directories were named from lexical drive/POSIX aliases in that case.
	const legacyRelativeCwd = (root: string): string | undefined =>
		relativeTo(canonicalRoot(root), canonicalCwd) ?? relativeTo(pathApi.resolve(root), lexicalCwd);
	const homeRelative = legacyRelativeCwd(home);
	if (homeRelative !== undefined) {
		const encodedHome = encodeRelative(home);
		const encodedRelative = encodeRelative(homeRelative);
		names.add(`-${encodedRelative}`);
		names.add(homeRelative === "" ? "----" : `---${encodedRelative}--`);
		if (homeRelative === "") names.add(`--${encodedHome}--`);
		else names.add(`--${encodedHome}-${encodedRelative}--`);
	}
	const tempRelative = legacyRelativeCwd(os.tmpdir());
	if (tempRelative !== undefined) {
		const encodedTempRelative = encodeRelative(tempRelative);
		names.add(`-tmp${tempRelative ? `-${encodedTempRelative}` : ""}`);
		names.add(`---tmp${tempRelative ? `-${encodedTempRelative}` : ""}--`);
	}
	return [...names];
}

function fsyncManagedParent(pathname: string): void {
	if (process.platform === "win32") return;
	let parent = path.dirname(pathname);
	for (;;) {
		let descriptor: number;
		try {
			descriptor = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		} catch (error) {
			if (hasFsCode(error, "ENOENT") && path.dirname(parent) !== parent) {
				parent = path.dirname(parent);
				continue;
			}
			throw new Error("durability_failed", { cause: error });
		}
		try {
			fs.fsyncSync(descriptor);
		} catch (error) {
			throw new Error("durability_failed", { cause: error });
		} finally {
			fs.closeSync(descriptor);
		}
		return;
	}
}

export function canonicalBindingOpenFlags(platform: NodeJS.Platform = process.platform): number {
	return (platform === "win32" ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW;
}

export function fsyncCanonicalBinding(bindingPath: string, expected: string): void {
	let captured: ManagedFileSnapshot;
	try {
		captured = captureManagedFileNoFollow(bindingPath);
	} catch {
		throw new Error("binding_invalid");
	}
	if (captured.bytes.toString("utf8") !== expected) throw new Error("binding_invalid");
	let descriptor: number | undefined;
	try {
		// Bun on Windows rejects fsync on a read-only file descriptor with EPERM.
		// The managed binding is owner-writable, so reopen it read/write only for the durability fence.
		descriptor = fs.openSync(bindingPath, canonicalBindingOpenFlags());
		const before = fs.fstatSync(descriptor, { bigint: true });
		if (
			before.dev !== captured.identity.dev ||
			before.ino !== captured.identity.ino ||
			before.size !== BigInt(captured.identity.size) ||
			before.mtimeNs !== captured.identity.mtimeNs
		)
			throw new Error("binding_invalid");
		fs.fsyncSync(descriptor);
		const after = fs.fstatSync(descriptor, { bigint: true });
		if (
			after.dev !== captured.identity.dev ||
			after.ino !== captured.identity.ino ||
			after.size !== BigInt(captured.identity.size) ||
			after.mtimeNs !== captured.identity.mtimeNs
		)
			throw new Error("binding_invalid");
	} catch (error) {
		if (error instanceof Error && error.message === "binding_invalid") throw error;
		throw new Error("durability_failed", { cause: error });
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
	fsyncManagedParent(bindingPath);
	let recaptured: ManagedFileSnapshot;
	try {
		recaptured = captureManagedFileNoFollow(bindingPath);
	} catch {
		throw new Error("binding_invalid");
	}
	if (
		recaptured.bytes.toString("utf8") !== expected ||
		recaptured.identity.dev !== captured.identity.dev ||
		recaptured.identity.ino !== captured.identity.ino ||
		recaptured.identity.size !== captured.identity.size ||
		recaptured.identity.mtimeNs !== captured.identity.mtimeNs
	)
		throw new Error("binding_invalid");
}

type CandidatePreflight =
	| {
			kind: "capture";
			sessionId: string;
			cwd: string;
			diagnosticSessionId?: string;
			identity: Pick<ManagedFileSnapshot["identity"], "dev" | "ino" | "nlink" | "size" | "mtimeNs" | "ctimeNs">;
	  }
	| {
			kind: "foreign";
	  }
	| {
			kind: "invalid";
			code: string;
			diagnosticSessionId?: string;
	  };

function safeManagedCandidateSessionId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

function invalidCandidatePreflight(filePath: string, code: string): CandidatePreflight {
	const diagnosticSessionId = safeManagedCandidateSessionId(path.basename(filePath, ".jsonl"));
	return {
		kind: "invalid",
		code,
		...(diagnosticSessionId === undefined ? {} : { diagnosticSessionId }),
	};
}

function preflightCandidate(filePath: string, scope: ManagedScope): CandidatePreflight {
	try {
		const snapshot = captureManagedFilePrefixNoFollow(filePath, HEADER_MAX_BYTES);
		const lineEnd = snapshot.bytes.indexOf(0x0a);
		if (lineEnd < 0) return invalidCandidatePreflight(filePath, "invalid_header");
		const value: unknown = JSON.parse(snapshot.bytes.subarray(0, lineEnd).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			return invalidCandidatePreflight(filePath, "invalid_header");
		const header = value as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
			return invalidCandidatePreflight(filePath, "invalid_header");
		const diagnosticSessionId = safeManagedCandidateSessionId(header.id);
		const candidateIdentity = identityFor(header.cwd);
		if (
			candidateIdentity.ok &&
			(candidateIdentity.platform !== scope.platform || candidateIdentity.canonicalPath !== scope.canonicalCwd)
		)
			return { kind: "foreign" };
		return {
			kind: "capture",
			sessionId: header.id,
			cwd: header.cwd,
			...(diagnosticSessionId === undefined ? {} : { diagnosticSessionId }),
			identity: snapshot.identity,
		};
	} catch (error) {
		return invalidCandidatePreflight(
			filePath,
			error instanceof Error && error.message === "source_changed" ? "source_changed" : "unreadable_candidate",
		);
	}
}

function matchesPreflightIdentity(candidate: ManagedCandidate, preflight: CandidatePreflight): boolean {
	return (
		preflight.kind === "capture" &&
		candidate.sessionId === preflight.sessionId &&
		candidate.cwd === preflight.cwd &&
		candidate.identity.dev === preflight.identity.dev &&
		candidate.identity.ino === preflight.identity.ino &&
		candidate.identity.nlink === preflight.identity.nlink &&
		candidate.identity.size === preflight.identity.size &&
		candidate.identity.mtimeNs === preflight.identity.mtimeNs &&
		candidate.identity.ctimeNs === preflight.identity.ctimeNs
	);
}

function inspectCandidate(
	filePath: string,
	provenance: "v2" | "legacy",
): ManagedCandidate | { code: string; sessionId?: string } {
	try {
		const snapshot = inspectManagedFileNoFollow(filePath, HEADER_MAX_BYTES);
		const lineEnd = snapshot.bytes.subarray(0, HEADER_MAX_BYTES).indexOf(0x0a);
		if (lineEnd < 0) return { code: "invalid_header" };
		const value: unknown = JSON.parse(snapshot.bytes.subarray(0, lineEnd).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "invalid_header" };
		const header = value as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
			return { code: "invalid_header" };
		const cwdIdentity = identityFor(header.cwd);
		if (!cwdIdentity.ok) return { code: `cwd_${cwdIdentity.code}` };
		const named = fs.lstatSync(filePath, { bigint: true });
		if (
			!named.isFile() ||
			named.isSymbolicLink() ||
			named.dev !== snapshot.identity.dev ||
			named.ino !== snapshot.identity.ino ||
			Number(named.size) !== snapshot.identity.size ||
			named.mtimeNs !== snapshot.identity.mtimeNs
		)
			return { code: "source_changed" };
		return {
			sessionId: header.id,
			path: filePath,
			cwd: header.cwd,
			provenance,
			migrationState: provenance === "v2" ? "native_v2" : "legacy_unmigrated",
			identity: {
				canonicalPath: path.resolve(filePath),
				sessionId: header.id,
				...snapshot.identity,
				nlink: snapshot.identity.nlink,
				mtimeMs: Number(named.mtimeMs),
				sha256: snapshot.identity.sha256,
			},
		};
	} catch (error) {
		return { code: (error as Error).message === "source_changed" ? "source_changed" : "unreadable_candidate" };
	}
}

const MAX_DISCOVERED_LEGACY_DIRECTORIES = 256;

function discoveredLegacyDirectoryNames(scope: ManagedScope): readonly string[] {
	const known = new Set(legacyDirectoryNames(scope.platform, scope.canonicalCwd, scope.legacyLexicalCwd));
	const discovered = fs
		.readdirSync(scope.sessionsRoot, { withFileTypes: true })
		.filter(
			entry =>
				entry.isDirectory() &&
				entry.name.startsWith("-") &&
				!entry.name.startsWith("v2-") &&
				entry.name !== MANAGED_INTERNAL_DIRECTORY,
		)
		.map(entry => entry.name)
		.sort()
		.filter(name => !known.has(name))
		.slice(0, MAX_DISCOVERED_LEGACY_DIRECTORIES);
	return [...known, ...discovered];
}

type CandidateInspection = ManagedCandidate | { code: string; sessionId?: string } | { foreign: true };

function listDirectoryCandidates(
	directory: string,
	provenance: "v2" | "legacy",
	scope: ManagedScope,
): readonly CandidateInspection[] {
	let directoryStat: fs.Stats;
	try {
		directoryStat = fs.lstatSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("unsafe directory");
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter(entry => entry.name.endsWith(".jsonl"))
		.map(entry => {
			const filePath = path.join(directory, entry.name);
			const preflight = preflightCandidate(filePath, scope);
			if (preflight.kind === "invalid")
				return {
					code: preflight.code,
					...(preflight.diagnosticSessionId === undefined ? {} : { sessionId: preflight.diagnosticSessionId }),
				};
			if (preflight.kind === "foreign") return { foreign: true };
			ManagedSessionScopeTestHooks.afterCandidatePreflight?.({
				...(preflight.diagnosticSessionId === undefined ? {} : { sessionId: preflight.diagnosticSessionId }),
			});
			const candidate = inspectCandidate(filePath, provenance);
			if ("code" in candidate)
				return {
					...candidate,
					...(candidate.sessionId === undefined && preflight.diagnosticSessionId !== undefined
						? { sessionId: preflight.diagnosticSessionId }
						: {}),
				};
			return matchesPreflightIdentity(candidate, preflight)
				? candidate
				: {
						code: "source_changed",
						...(preflight.diagnosticSessionId === undefined ? {} : { sessionId: preflight.diagnosticSessionId }),
					};
		});
}

export async function ensureManagedScope(
	scope: ManagedScope,
	policy: ManagedSessionSecurityPolicy = "default",
): Promise<ManagedScopeResolution> {
	try {
		assertRetainedManagedDirectoryIdentity(scope);
		const root = scopeRoot(scope, policy);
		ensureManagedDirectory(scope.sessionsRoot, root, policy);
		ensureManagedDirectory(scope.directoryPath, root, policy);
		const bindingPath = path.join(scope.directoryPath, MANAGED_SESSION_BINDING_FILE);
		const binding = `${JSON.stringify(bindingFor(scope))}\n`;
		let bindingCollision = false;
		try {
			await publishManagedFileNoReplace(bindingPath, new TextEncoder().encode(binding), undefined, root, policy);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "destination_conflict") throw error;
			bindingCollision = true;
		}
		const validated = validateExistingBinding(scope);
		if (validated) return validated;
		if (bindingCollision) fsyncCanonicalBinding(bindingPath, binding);

		const preparedDirectory = fs.lstatSync(scope.directoryPath, { bigint: true });
		if (!preparedDirectory.isDirectory() || preparedDirectory.isSymbolicLink()) throw new Error("reparse_point");
		managedDirectoryIdentities.set(scope, { dev: preparedDirectory.dev, ino: preparedDirectory.ino });
		return { kind: "resolved", scope };
	} catch (error) {
		const publication = error instanceof ManagedPublishError ? error : undefined;
		const message =
			publication?.classification ??
			managedScopeFailureMessage(error, "The managed scope could not be initialized.");
		const code = managedScopeErrorCode(message);
		return {
			kind: "error",
			code,
			message,
			cause: publication
				? { classification: publication.classification, diagnostic: publication.diagnostic }
				: managedScopeFailureCause(error),
		};
	}
}

/**
 * Re-apply owner-only security to every descendant of a managed scope directory.
 *
 * A managed scope can accumulate group/other-readable descendants when a
 * different code path writes into it without the secured managed-storage
 * helpers — notably the resident-cache `EphemeralBlobStore` created on the
 * explicit session path. The managed-tree snapshot fails closed on the first
 * such descendant (`mode_mismatch`), which would otherwise abort launch with an
 * uncaught exception. Re-securing the tree in place lets a drifted scope
 * recover on the next launch instead of trapping the user behind a fatal error.
 */
/** Re-secure owner-only modes under a managed directory (exported for legacy-local migration). */
export function resecureOwnerOnlyManagedTree(directory: string): void {
	reapplyOwnerOnlyManagedTree(directory);
}

function reapplyOwnerOnlyManagedTree(directory: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const child = path.join(directory, entry.name);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(child);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			reapplyOwnerOnlyManagedTree(child);
			assertOwnerOnlyApplied(child, "directory");
		} else if (stat.isFile()) {
			assertOwnerOnlyApplied(child, "file");
		}
	}
	assertOwnerOnlyApplied(directory, "directory");
}

/** Apply and verify owner-only mode/ACL; throw mode_mismatch (or native code) on failure. */
function assertOwnerOnlyApplied(pathname: string, kind: "directory" | "file"): void {
	const applied = nativeScope().applyOwnerOnlyPathSecurity(pathname, kind);
	if (!applied || typeof applied !== "object" || (applied as { ok?: unknown }).ok !== true) {
		const code =
			applied && typeof applied === "object" && typeof (applied as { code?: unknown }).code === "string"
				? (applied as { code: string }).code
				: "mode_mismatch";
		throw new Error(code);
	}
	const verified = nativeScope().verifyOwnerOnlyPathSecurity(pathname, kind);
	if (!verified || typeof verified !== "object" || (verified as { ok?: unknown }).ok !== true) {
		const code =
			verified && typeof verified === "object" && typeof (verified as { code?: unknown }).code === "string"
				? (verified as { code: string }).code
				: "mode_mismatch";
		throw new Error(code);
	}
}

/**
 * Bound the synchronous mode-only self-heal walk so `session/new` latency stays
 * independent of the on-disk size of a scope's `v2-<cwd>` tree. A heavily used
 * scope holds every past session's transcripts plus resident-cache blobs, and an
 * unbounded `lstat` walk on every prepare made `session/new` take ~16s on a 12 GB
 * `~/.gjc` (#5565). This is a defense-in-depth mode self-heal, not the primary
 * owner-only-on-write guarantee, so the *synchronous* detection is budgeted:
 * truncating it never blocks launch. Detection walks entries in `readdir` order
 * (freshest writes land near the top on most filesystems), so the common drift
 * source is caught in-budget. Anything past the budget is NOT assumed
 * owner-only — a bounded, streaming background self-heal
 * (`runDeferredOwnerOnlySelfHeal`) finishes the tail off the critical path.
 *
 * The owner-only *guarantee* for managed content is not this walk: it is enforced
 * per-write by the secured storage helpers (see `openManagedStore`). This walk is
 * best-effort repair of drift introduced by non-managed writers. Because the tail
 * repair is asynchronous, a truncated scan does not itself prove the tail is
 * owner-only; the contract it upholds is that the tail is eventually repaired and
 * that a *provable* failure of that repair — an unrepairable path
 * (`pendingDeferredOwnerOnlyRepairFailures`) or an aborted traversal
 * (`deferredOwnerOnlySelfHealTraversalFailures`) — fails the next prepare closed
 * rather than reporting success over an uninspected or still-drifted tail.
 */
export const OWNER_ONLY_SELF_HEAL_MAX_ENTRIES = 8192;
export const OWNER_ONLY_SELF_HEAL_MAX_DURATION_MS = 500;

interface OwnerOnlySelfHealBudget {
	deadline: number;
	remaining: number;
}

/** A managed directory queued for enumeration, tagged with the identity that classified it. */
interface OwnerOnlyDirRef {
	pathname: string;
	dev: bigint;
	ino: bigint;
}

type OwnerOnlyClassification = { kind: "descend"; dev: bigint; ino: bigint } | { kind: "leaf" } | { kind: "skip" };

/**
 * Classify a managed descendant, recording group/other-readable drift. For a
 * directory it also returns the (dev, ino) identity from the same `lstat`, so a
 * later no-follow re-open can prove the directory was not replaced out from under
 * the walk before it is enumerated (see `opendirIfUnchanged`).
 */
function classifyOwnerOnlyEntry(pathname: string, drifted: string[]): OwnerOnlyClassification {
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(pathname, { bigint: true });
	} catch {
		return { kind: "skip" };
	}
	if (stat.isSymbolicLink()) return { kind: "skip" };
	if ((stat.mode & 0o077n) !== 0n) drifted.push(pathname);
	return stat.isDirectory() ? { kind: "descend", dev: stat.dev, ino: stat.ino } : { kind: "leaf" };
}

/**
 * Open a queued managed directory for enumeration only if it is still the exact
 * directory the walk classified. A managed scope is same-user writable, so a
 * concurrent process can replace a queued directory with a symlink (or a
 * different directory) between the classifying `lstat` and this open — and both
 * walks pop/yield across that window.
 *
 * A bare `lstat(path)` check followed by `opendirSync(path)` is a check-then-use
 * race: `opendirSync` *follows* a symlink final component, so a pathname swapped
 * to a symlink after the check enumerates outside the retained scope. Instead,
 * bind the identity to the descriptor we actually open: `O_NOFOLLOW` refuses a
 * symlinked final component outright, `O_DIRECTORY` refuses a non-directory, and
 * the `fstat` on that descriptor (not on a pathname that may already have been
 * swapped) proves it is the exact directory the walk classified before any entry
 * is read. Returns `null` on any mismatch or error; the caller skips that
 * subtree. Windows lacks `O_NOFOLLOW`/`O_DIRECTORY` and reaches this walk only
 * under the fail-closed verify-first policy, so it keeps the pathname check.
 */
function opendirIfUnchanged(ref: OwnerOnlyDirRef): fs.Dir | null {
	if (process.platform === "win32") return opendirIfUnchangedByPath(ref);
	// Prove the opened descriptor's identity no-follow, so a symlink or
	// different-directory swap of the pathname cannot be opened or enumerated.
	let fd: number;
	try {
		fd = fs.openSync(ref.pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
	} catch {
		return null;
	}
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== ref.dev || stat.ino !== ref.ino) return null;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
	// The descriptor proved identity a moment ago; open the enumeration stream and
	// re-verify no-follow that the pathname still resolves to that same inode, so a
	// swap in the narrow reopen gap is caught before any entry is enumerated. Entry
	// names are always rejoined to `ref.pathname` (never a stream-resolved path) by
	// the caller, so even a transient swap cannot escape the classified directory.
	let dir: fs.Dir;
	try {
		dir = fs.opendirSync(ref.pathname);
	} catch {
		return null;
	}
	try {
		const recheck = fs.lstatSync(ref.pathname, { bigint: true });
		if (recheck.isSymbolicLink() || !recheck.isDirectory() || recheck.dev !== ref.dev || recheck.ino !== ref.ino) {
			dir.closeSync();
			return null;
		}
	} catch {
		dir.closeSync();
		return null;
	}
	return dir;
}

/** Windows check-then-open fallback (no `O_NOFOLLOW`/`O_DIRECTORY`); reached only under fail-closed verify-first. */
function opendirIfUnchangedByPath(ref: OwnerOnlyDirRef): fs.Dir | null {
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(ref.pathname, { bigint: true });
	} catch {
		return null;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== ref.dev || stat.ino !== ref.ino) return null;
	try {
		return fs.opendirSync(ref.pathname);
	} catch {
		return null;
	}
}

/**
 * Bounded, streaming mode-only walk for managed-scope prepare self-heal.
 *
 * Enumerates every directory with a streaming `opendir` iterator instead of
 * `readdirSync`, so a single flat directory with millions of children never
 * materializes at once (bounded synchronous latency and memory). Collects the
 * group/other-readable descendants seen within the entry/time budget rather than
 * throwing on the first, so the caller can repair exactly those paths.
 *
 * Avoids snapshotManagedTree("") which races concurrent session writers (#3906).
 *
 * `complete` is `false` when the budget was exhausted before the walk finished:
 * an empty `drifted` then means "none found within budget", not a proven
 * owner-only tree, and the caller must schedule the deferred tail repair.
 */
function collectOwnerOnlyModeDrift(
	root: string,
	budget: OwnerOnlySelfHealBudget,
): { drifted: string[]; complete: boolean } {
	const drifted: string[] = [];
	const rootClass = classifyOwnerOnlyEntry(root, drifted);
	if (rootClass.kind !== "descend") return { drifted, complete: true };
	// Explicit DFS stack of directory refs; only one directory iterator is open at
	// a time and it is closed before the next is opened. Each ref carries the
	// identity captured when the directory was classified so `opendirIfUnchanged`
	// can refuse to follow a concurrent replacement.
	const stack: OwnerOnlyDirRef[] = [{ pathname: root, dev: rootClass.dev, ino: rootClass.ino }];
	while (stack.length > 0) {
		const ref = stack.pop() as OwnerOnlyDirRef;
		const dir = opendirIfUnchanged(ref);
		// A null open means this queued directory was replaced, became a symlink, or
		// grew inaccessible between classification and open: its subtree was never
		// enumerated, so this scan did NOT cover the tree. Report incomplete — rather
		// than skipping it as if clean — so the caller schedules the deferred tail
		// walk and the descendants under `ref` stay unverified until a walk actually
		// reaches them.
		if (dir === null) return { drifted, complete: false };
		try {
			let entry = dir.readSync();
			while (entry !== null) {
				if (budget.remaining <= 0 || Date.now() >= budget.deadline) return { drifted, complete: false };
				budget.remaining -= 1;
				const child = path.join(ref.pathname, entry.name);
				const childClass = classifyOwnerOnlyEntry(child, drifted);
				if (childClass.kind === "descend")
					stack.push({ pathname: child, dev: childClass.dev, ino: childClass.ino });
				entry = dir.readSync();
			}
		} finally {
			dir.closeSync();
		}
	}
	return { drifted, complete: true };
}

/** Re-secure owner-only mode on a single drifted managed path (throws on failure). */
function resecureOwnerOnlyPath(pathname: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(pathname);
	} catch {
		return;
	}
	if (stat.isSymbolicLink()) return;
	assertOwnerOnlyApplied(pathname, stat.isDirectory() ? "directory" : "file");
}

/**
 * Best-effort variant for the background walk: a concurrent writer must not crash
 * it, but a genuine repair failure must not be silently dropped either. For a
 * descendant past the synchronous budget, this deferred tail is the ONLY
 * enforcement step, so a failed repair is recorded in `failures` — the next
 * prepare observes it, retries, and fails closed rather than reporting success
 * over a descendant that is still group/other-readable.
 */
function resecureOwnerOnlyPathQuietly(pathname: string, failures: string[]): void {
	try {
		resecureOwnerOnlyPath(pathname);
	} catch (error) {
		failures.push(pathname);
		logger.debug("Deferred managed-scope owner-only repair failed; will retry on next prepare", {
			pathname,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Entries inspected between event-loop yields in the deferred background walk. */
const OWNER_ONLY_DEFERRED_SELF_HEAL_SLICE = OWNER_ONLY_SELF_HEAL_MAX_ENTRIES;

/**
 * Finish the owner-only self-heal that the budgeted synchronous walk truncated.
 *
 * Walks the *entire* scope tree — again with streaming `opendir` enumeration so a
 * flat high-fan-out directory stays bounded — repairing each drifted descendant
 * as it is found, and yields to the event loop every slice so it never blocks
 * `session/new` or the ACP server the way the original unbounded walk did.
 */
async function runDeferredOwnerOnlySelfHeal(root: string, failures: string[]): Promise<void> {
	// Yield before touching the tree so scheduling never runs a walk slice on the
	// `session/new` tick — the whole tail repair stays off the critical path.
	await new Promise<void>(resolve => setImmediate(resolve));
	const rootDrift: string[] = [];
	const rootClass = classifyOwnerOnlyEntry(root, rootDrift);
	for (const pathname of rootDrift) resecureOwnerOnlyPathQuietly(pathname, failures);
	if (rootClass.kind !== "descend") return;
	const stack: OwnerOnlyDirRef[] = [{ pathname: root, dev: rootClass.dev, ino: rootClass.ino }];
	let sliceRemaining = OWNER_ONLY_DEFERRED_SELF_HEAL_SLICE;
	while (stack.length > 0) {
		const ref = stack.pop() as OwnerOnlyDirRef;
		const dir = opendirIfUnchanged(ref);
		// A null open leaves this directory's descendants unvisited, so the tail this
		// walk exists to enforce was not fully traversed. Throw — like a `Dir.readSync`
		// failure below — so the scheduler's `.catch` records a traversal failure
		// (`traversed = false`) instead of the walk finishing as if the tree were
		// fully covered.
		if (dir === null)
			throw Object.assign(
				new Error("opendir_null: directory identity changed or became inaccessible during traversal"),
				{ code: "ENOENT" },
			);
		try {
			let entry = dir.readSync();
			while (entry !== null) {
				const child = path.join(ref.pathname, entry.name);
				const childDrift: string[] = [];
				const childClass = classifyOwnerOnlyEntry(child, childDrift);
				for (const pathname of childDrift) resecureOwnerOnlyPathQuietly(pathname, failures);
				if (childClass.kind === "descend")
					stack.push({ pathname: child, dev: childClass.dev, ino: childClass.ino });
				if (--sliceRemaining <= 0) {
					await new Promise<void>(resolve => setImmediate(resolve));
					sliceRemaining = OWNER_ONLY_DEFERRED_SELF_HEAL_SLICE;
				}
				entry = dir.readSync();
			}
		} finally {
			dir.closeSync();
		}
	}
}

/** In-flight deferred self-heals, keyed by resolved scope directory to dedupe. */
const pendingDeferredOwnerOnlySelfHeals = new Map<string, Promise<void>>();

/**
 * Scopes whose most recent deferred self-heal left at least one descendant it
 * could not re-secure (resolved scope directory → the still-drifted paths). This
 * deferred tail is the sole enforcement for descendants past the synchronous
 * budget, so a failure here must not be discarded: the next prepare for the scope
 * retries these paths and fails closed if they still cannot be made owner-only.
 */
const pendingDeferredOwnerOnlyRepairFailures = new Map<string, string[]>();

/**
 * Scopes whose most recent deferred self-heal aborted on a *traversal*-level
 * filesystem failure — a `Dir.readSync`/iterator or close error, as opposed to
 * one path's repair, which `resecureOwnerOnlyPathQuietly` records separately. The
 * walk then stopped mid-tree, so the tail past the synchronous budget was never
 * inspected and the traversal must not be recorded as having completed. The scope
 * stays marked here until a later walk reaches the end of the tree (or a
 * synchronous scan covers it in full), which also keeps a partial walk from
 * clearing repair failures it never got far enough to re-examine.
 */
const deferredOwnerOnlySelfHealTraversalFailures = new Set<string>();

/**
 * Schedule (at most one per scope) a background self-heal of the tail the budget
 * skipped.
 *
 * Scheduling is deliberately NOT suppressed by a time-based cooldown on the last
 * completed walk. This is only reached when the synchronous scan truncated, and a
 * truncated scan is fresh evidence that the tail is unverified *now*: a managed
 * scope is same-user writable, so a new group/other-readable descendant can land
 * past the scan prefix moments after a walk completes. Suppressing on elapsed
 * time alone would let that prepare return success over a tree nobody inspected,
 * and there is no cheap unchanged-tree signal at the scan boundary that could
 * prove otherwise — verifying the tail *is* the walk. The in-flight dedupe above
 * still bounds this to one concurrent traversal per scope.
 */
function scheduleDeferredOwnerOnlySelfHeal(directory: string): void {
	const key = path.resolve(directory);
	if (pendingDeferredOwnerOnlySelfHeals.has(key)) return;
	const failures: string[] = [];
	let traversed = true;
	const task = runDeferredOwnerOnlySelfHeal(directory, failures).catch(error => {
		// The walk stopped mid-tree, so the tail it exists to enforce was never
		// inspected. Recording this as a completed traversal would both discard that
		// fact and let the empty `failures` list clear repair failures the aborted
		// walk never reached.
		traversed = false;
		logger.debug("Deferred managed-scope owner-only self-heal failed", {
			directory,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	pendingDeferredOwnerOnlySelfHeals.set(key, task);
	void task.finally(() => {
		// Preserve an unrepairable tail so the next prepare fails closed; clear any
		// prior failure only once a walk has actually traversed the whole scope.
		if (failures.length > 0) pendingDeferredOwnerOnlyRepairFailures.set(key, failures);
		else if (traversed) pendingDeferredOwnerOnlyRepairFailures.delete(key);
		if (traversed) deferredOwnerOnlySelfHealTraversalFailures.delete(key);
		else deferredOwnerOnlySelfHealTraversalFailures.add(key);
		if (pendingDeferredOwnerOnlySelfHeals.get(key) === task) pendingDeferredOwnerOnlySelfHeals.delete(key);
	});
}

/** Number of scopes with an in-flight deferred owner-only self-heal (test/shutdown observability). */
export function pendingDeferredOwnerOnlySelfHealCount(): number {
	return pendingDeferredOwnerOnlySelfHeals.size;
}

/** Number of scopes with a recorded deferred owner-only repair failure (test/shutdown observability). */
export function pendingDeferredOwnerOnlyRepairFailureCount(): number {
	return pendingDeferredOwnerOnlyRepairFailures.size;
}

/** Number of scopes whose deferred walk aborted before traversing the tree (test/shutdown observability). */
export function pendingDeferredOwnerOnlyTraversalFailureCount(): number {
	return deferredOwnerOnlySelfHealTraversalFailures.size;
}

/** Await every in-flight deferred owner-only self-heal (deterministic teardown/shutdown). */
export async function drainDeferredOwnerOnlySelfHeals(): Promise<void> {
	while (pendingDeferredOwnerOnlySelfHeals.size > 0) {
		await Promise.all([...pendingDeferredOwnerOnlySelfHeals.values()]);
	}
}

/**
 * Detect and repair owner-only mode drift under a prepared managed scope.
 *
 * Repair is targeted: only the specific descendants found group/other-readable
 * within the budget are re-secured — never the whole scope — so one early
 * readable blob cannot trigger an unbounded re-secure plus another full walk.
 * When the budget truncates the scan, a bounded background self-heal finishes the
 * remaining tail so a drifted file beyond the scan prefix is still repaired
 * rather than silently accepted as owner-only.
 */
export function selfHealOwnerOnlyModeDrift(directory: string, policy: ManagedSessionSecurityPolicy): void {
	const key = path.resolve(directory);
	// A prior deferred repair that could not restore owner-only mode is the only
	// enforcement for its descendants. Retry it before this writer proceeds and
	// fail closed if it still cannot be secured, so a discarded background repair
	// never surfaces as an apparently successful prepare (the base implementation
	// likewise failed closed rather than accepting a group/other-readable tree).
	const priorFailures = pendingDeferredOwnerOnlyRepairFailures.get(key);
	if (priorFailures !== undefined) {
		const stillDrifted: string[] = [];
		let firstError: unknown;
		for (const pathname of priorFailures) {
			try {
				resecureOwnerOnlyPath(pathname);
			} catch (error) {
				stillDrifted.push(pathname);
				firstError ??= error;
			}
		}
		if (stillDrifted.length > 0) {
			pendingDeferredOwnerOnlyRepairFailures.set(key, stillDrifted);
			throw firstError instanceof Error ? firstError : new Error("mode_mismatch");
		}
		pendingDeferredOwnerOnlyRepairFailures.delete(key);
	}
	// A prior deferred walk that aborted mid-traversal left the tail past the
	// synchronous budget uninspected — unverified state, not a proven owner-only
	// tree. Consult it alongside the repair-failure record above: if this prepare's
	// own synchronous scan also cannot reach the end of the tree (below), reporting
	// success would accept that uninspected tail. The marker is cleared only by a
	// walk — synchronous or deferred — that actually traverses to the end.
	const priorTraversalFailure = deferredOwnerOnlySelfHealTraversalFailures.has(key);
	const budget: OwnerOnlySelfHealBudget = {
		deadline: Date.now() + OWNER_ONLY_SELF_HEAL_MAX_DURATION_MS,
		remaining: OWNER_ONLY_SELF_HEAL_MAX_ENTRIES,
	};
	const startedAt = Date.now();
	const { drifted, complete } = collectOwnerOnlyModeDrift(directory, budget);
	// A verify-first policy demands proof before trust: it must not self-heal, and
	// an incomplete scan cannot furnish that proof — fail closed on either.
	const failClosed = process.platform === "win32" && policy === "windows-existing-verify-first";
	if (drifted.length > 0) {
		if (failClosed) throw new Error("mode_mismatch");
		for (const pathname of drifted) resecureOwnerOnlyPath(pathname);
	}
	if (!complete) {
		if (failClosed) throw new Error("mode_mismatch");
		scheduleDeferredOwnerOnlySelfHeal(directory);
		logger.debug("Managed scope owner-only self-heal walk truncated; deferred repair scheduled", {
			directory,
			elapsedMs: Date.now() - startedAt,
			maxDurationMs: OWNER_ONLY_SELF_HEAL_MAX_DURATION_MS,
			maxEntries: OWNER_ONLY_SELF_HEAL_MAX_ENTRIES,
		});
		// The tail is still unverified: a prior deferred walk aborted before reaching
		// it and this synchronous scan truncated short of it too. Fail closed rather
		// than report success over an uninspected tail; the deferred walk scheduled
		// just above will clear the traversal-failure marker once it completes, so a
		// later prepare recovers on its own.
		if (priorTraversalFailure) throw new Error("mode_mismatch");
		return;
	}
	// This scan reached the end of the tree, so the tail an earlier aborted deferred
	// walk left uninspected has now been inspected and repaired synchronously.
	deferredOwnerOnlySelfHealTraversalFailures.delete(key);
}

/**
 * True when a managed setup error reflects a fixable owner-only *mode* drift
 * (group/other permission bits) rather than an ownership or identity change.
 * Only mode drift can be self-healed by re-applying owner-only permissions.
 */
export function isRecoverableOwnerOnlyModeDrift(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return message === "mode_mismatch" || message.endsWith(": mode_mismatch");
}

type ManagedScopePrepareStage =
	| "retained_identity"
	| "root_authority"
	| "sessions_root"
	| "scope_directory"
	| "scope_identity"
	| "retained_authority"
	| "store"
	| "binding_publish"
	| "binding_read"
	| "binding_validate"
	| "scope_revalidate"
	| "internal_directory"
	| "locks_directory"
	| "receipts_directory"
	| "tombstones_directory";

/** Synchronously create and validate the v2 binding before a default session writer exists. */
export function prepareManagedSessionScopeForWriteSync(
	scope: ManagedScope,
	policy: ManagedSessionSecurityPolicy = "default",
	authority?: ManagedCandidateWriteAuthority,
): ManagedScopeResolution {
	let stage: ManagedScopePrepareStage = "retained_identity";
	try {
		assertRetainedManagedDirectoryIdentity(scope);
		stage = "root_authority";
		const root = authority?.rootAuthority ?? scopeRoot(scope, policy);
		if (authority) bindManagedWriteAuthority(scope, authority);
		stage = "sessions_root";
		ensureManagedDirectory(scope.sessionsRoot, root, policy);
		stage = "scope_directory";
		ensureManagedDirectory(scope.directoryPath, root, policy);
		stage = "scope_identity";
		const preparedDirectory = fs.lstatSync(scope.directoryPath, { bigint: true });
		if (!preparedDirectory.isDirectory() || preparedDirectory.isSymbolicLink())
			throw new Error("Managed session directory changed");
		stage = "retained_authority";
		const retainedAuthority =
			authority?.retainedAuthority &&
			authority.retainedDirectory !== undefined &&
			path.resolve(authority.retainedDirectory) === path.resolve(scope.directoryPath)
				? authority.retainedAuthority
				: retainManagedDirectoryAuthority(root, scope.directoryPath, {
						dev: preparedDirectory.dev,
						ino: preparedDirectory.ino,
					});
		const buildStore = () =>
			new ManagedSessionDescendantStore(
				root,
				scope.directoryPath,
				retainedAuthority ? { authority: retainedAuthority, authorityBaseDir: scope.directoryPath } : undefined,
				policy,
			);
		stage = "store";
		// This must precede the first managed-store mutation: binding publication
		// reconciles receipts with the normal 50k fail-closed bound, while an older
		// macOS scope can contain only proven, terminal zero-byte remnants above it.
		reapScrubbedProtocolRemnantsSync(scope.directoryPath);
		let store: ManagedSessionDescendantStore;
		const openManagedStore = (): ManagedSessionDescendantStore => {
			const next = buildStore();
			// #3951 root-store identity binding no longer walks the managed tree on
			// construct, so mode drift no longer surfaces as mode_mismatch there.
			// Detect and repair group/other-readable descendants with a bounded,
			// streaming mode-only walk — do NOT call snapshotManagedTree("") here:
			// that reintroduces concurrent-writer identity_mismatch races (#3906)
			// that break SessionManager.moveTo / move.
			//
			// This walk is bounded best-effort defense-in-depth, NOT the owner-only
			// guarantee itself: every managed write below goes through the secured
			// storage helpers (`ensureManagedDirectory`, `store.publish*`), which
			// apply and verify owner-only mode on each object they create, so managed
			// writes are owner-only at the write boundary regardless of the walk. The
			// walk only heals drift left by non-managed writers (e.g. the resident
			// cache) into the scope. A completed synchronous scan holds this prepare
			// until the whole tree is inspected; a truncated scan hands the tail to a
			// bounded background self-heal, and a *provable* failure of that deferred
			// enforcement (an unrepairable path or an aborted traversal) fails the
			// next prepare closed rather than silently accepting a drifted tail.
			if (retainedAuthority) selfHealOwnerOnlyModeDrift(scope.directoryPath, policy);
			return next;
		};
		store = openManagedStore();
		const binding = new TextEncoder().encode(`${JSON.stringify(bindingFor(scope))}\n`);
		stage = "binding_publish";
		try {
			store.publishNoReplaceSync(MANAGED_SESSION_BINDING_FILE, binding);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "destination_conflict") throw error;
		}
		stage = "binding_read";
		const capturedBinding = store.readExpected(MANAGED_SESSION_BINDING_FILE);
		if (!capturedBinding) throw new Error("Managed scope binding is unavailable");
		stage = "binding_validate";
		const validated = validateBindingRaw(scope, capturedBinding.bytes.toString("utf8"));
		managedDirectoryAuthorities.set(scope, retainedAuthority);
		stage = "scope_revalidate";
		const directoryStat = fs.lstatSync(scope.directoryPath, { bigint: true });
		if (
			!directoryStat.isDirectory() ||
			directoryStat.isSymbolicLink() ||
			directoryStat.dev !== preparedDirectory.dev ||
			directoryStat.ino !== preparedDirectory.ino
		)
			throw new Error("Managed session directory changed");
		managedDirectoryIdentities.set(scope, { dev: preparedDirectory.dev, ino: preparedDirectory.ino });
		if (validated) {
			if (validated.kind !== "error") throw new Error("Unexpected managed scope binding result");
			return {
				...validated,
				cause: { classification: validated.code, diagnostic: "prepare:binding_validate" },
			};
		}
		const internal = managedInternalDirectory(scope);
		stage = "internal_directory";
		ensureManagedDirectory(internal, root, policy);
		stage = "locks_directory";
		ensureManagedDirectory(path.join(internal, MANAGED_LOCKS_DIRECTORY), root, policy);
		stage = "receipts_directory";
		ensureManagedDirectory(path.join(internal, MANAGED_RECEIPTS_DIRECTORY), root, policy);
		stage = "tombstones_directory";
		ensureManagedDirectory(path.join(internal, MANAGED_TOMBSTONES_DIRECTORY), root, policy);
		reapScrubbedProtocolRemnantsSync(scope.directoryPath);
		return { kind: "resolved", scope };
	} catch (error) {
		const publication = error instanceof ManagedPublishError ? error : undefined;
		const message =
			publication?.classification ?? managedScopeFailureMessage(error, "Managed write protocol setup failed.");
		const code = managedScopeErrorCode(message);

		return {
			kind: "error",
			code,
			message,
			cause: publication
				? { classification: publication.classification, diagnostic: publication.diagnostic }
				: { ...managedScopeFailureCause(error), diagnostic: `prepare:${stage}` },
		};
	}
}

export function listManagedCandidates(scope: ManagedScope): ManagedCandidateListing {
	try {
		let root: fs.Stats;
		try {
			root = fs.lstatSync(scope.sessionsRoot);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { kind: "complete", scope, owned: [], foreignCount: 0, invalid: [] };
			throw error;
		}
		if (!root.isDirectory() || root.isSymbolicLink())
			return { kind: "error", code: "unsafe_root", message: "The sessions root is unsafe." };
		const owned: ManagedCandidate[] = [];
		const invalid: { code: string; sessionId?: string }[] = [];
		let foreignCount = 0;
		const directories: Array<{ path: string; provenance: "v2" | "legacy" }> = [
			{ path: scope.directoryPath, provenance: "v2" },
			...discoveredLegacyDirectoryNames(scope).map(directoryName => ({
				path: path.join(scope.sessionsRoot, directoryName),
				provenance: "legacy" as const,
			})),
		];
		const seen = new Set<string>();
		for (const directory of directories) {
			for (const candidate of listDirectoryCandidates(directory.path, directory.provenance, scope)) {
				if ("code" in candidate) {
					invalid.push({
						code: candidate.code,
						...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
					});
					continue;
				}
				if ("foreign" in candidate) {
					foreignCount++;
					continue;
				}
				const candidateIdentity = identityFor(candidate.cwd);
				if (!candidateIdentity.ok) {
					invalid.push({
						code: `cwd_${candidateIdentity.code}`,
						...(safeManagedCandidateSessionId(candidate.sessionId) === undefined
							? {}
							: { sessionId: candidate.sessionId }),
					});
					continue;
				}
				if (
					candidateIdentity.platform !== scope.platform ||
					candidateIdentity.canonicalPath !== scope.canonicalCwd
				) {
					foreignCount++;
					continue;
				}
				if (!seen.has(candidate.identity.canonicalPath)) {
					seen.add(candidate.identity.canonicalPath);
					owned.push(candidate);
				}
			}
		}
		const visible = owned.filter(candidate => !isRetired(scope, candidate));
		const active = visible.filter(
			candidate =>
				candidate.provenance === "v2" ||
				!visible.some(
					destination =>
						destination.provenance === "v2" &&
						receiptMatches(receiptPathFor(scope, candidate), candidate, destination, scope),
				),
		);
		return {
			kind: "complete",
			scope,
			owned: active.map(candidate => {
				if (candidate.provenance !== "v2") return candidate;
				const migrated = visible.some(
					source =>
						source.provenance === "legacy" &&
						receiptMatches(receiptPathFor(scope, source), source, candidate, scope),
				);
				return migrated ? { ...candidate, migrationState: "migrated_v2" as const } : candidate;
			}),
			foreignCount,
			invalid,
		};
	} catch (error) {
		return {
			kind: "error",
			code: "scan_failed",
			message: error instanceof Error ? error.message : "Session scan failed.",
		};
	}
}

const MANAGED_INTERNAL_DIRECTORY = ".gjc-managed-session-internal";
const MANAGED_RECEIPTS_DIRECTORY = "receipts";
const MANAGED_LOCKS_DIRECTORY = "locks";
const MANAGED_TOMBSTONES_DIRECTORY = "tombstones";

function managedInternalDirectory(scope: ManagedScope): string {
	return path.join(scope.directoryPath, MANAGED_INTERNAL_DIRECTORY);
}

function stableOperationName(candidate: ManagedCandidate): string {
	return createHash("sha256")
		.update(candidate.identity.canonicalPath)
		.update("\0")
		.update(candidate.identity.dev.toString())
		.update("\0")
		.update(candidate.identity.ino.toString())
		.update("\0")
		.update(candidate.identity.size.toString())
		.update("\0")
		.update(candidate.identity.mtimeNs.toString())
		.update("\0")
		.update(candidate.identity.sha256)
		.digest("hex");
}

function expectedFailure(error: unknown): ManagedOpenFailure {
	const message = error instanceof Error ? error.message : "";
	return message === "migration_busy" ||
		message === "binding_conflict" ||
		message === "binding_invalid" ||
		message === "destination_conflict" ||
		message === "source_changed" ||
		message === "unsafe_artifacts" ||
		message === "artifact_capacity_exceeded" ||
		message === "durability_failed" ||
		message === "atomic_unavailable" ||
		message === "invalid_request" ||
		message === "durability_not_provable" ||
		message === "migration_retired"
		? message
		: "managed_storage_unsupported";
}

function sameCandidate(left: ManagedCandidate, right: ManagedCandidate): boolean {
	return (
		left.path === right.path &&
		left.identity.dev === right.identity.dev &&
		left.identity.ino === right.identity.ino &&
		left.identity.size === right.identity.size &&
		left.identity.mtimeNs === right.identity.mtimeNs &&
		left.identity.sha256 === right.identity.sha256
	);
}

function matchesExpectedResumeIdentity(candidate: ManagedCandidate, expected: ResumeSessionIdentity): boolean {
	return (
		path.resolve(candidate.identity.canonicalPath) === path.resolve(expected.canonicalPath) &&
		candidate.identity.sessionId === expected.sessionId &&
		candidate.identity.dev === expected.dev &&
		candidate.identity.ino === expected.ino &&
		candidate.identity.size === expected.size &&
		candidate.identity.mtimeMs === expected.mtimeMs &&
		candidate.identity.mtimeNs === expected.mtimeNs &&
		candidate.identity.sha256 === expected.sha256
	);
}

function revalidatePickerConsent(
	scope: ManagedScope,
	candidate: ManagedCandidate,
	expectedIdentity: ResumeSessionIdentity,
): ManagedCandidate {
	const current = validateCandidateForScope(scope, candidate);
	if (!current || !matchesExpectedResumeIdentity(current, expectedIdentity)) throw new Error("source_changed");
	return current;
}

function receiptPathFor(
	scope: ManagedScope,
	source: ManagedCandidate,
	state: "prepared" | "detached" | "published" | "committed" = "committed",
): string {
	const suffix = state === "committed" ? "" : `.${state}`;
	return path.join(
		managedInternalDirectory(scope),
		MANAGED_RECEIPTS_DIRECTORY,
		`${stableOperationName(source)}${suffix}.json`,
	);
}

function receiptMatches(
	receiptPath: string,
	source: ManagedCandidate,
	destination: ManagedCandidate,
	scope: ManagedScope,
): boolean {
	try {
		const value: unknown = JSON.parse(captureManagedFileNoFollow(receiptPath).bytes.toString("utf8"));
		if (!value || typeof value !== "object") return false;
		const record = value as {
			schemaVersion?: unknown;
			state?: unknown;
			policy?: unknown;
			scope?: unknown;
			source?: {
				path?: unknown;
				sha256?: unknown;
				sessionId?: unknown;
				header?: { id?: unknown; cwd?: unknown };
				identity?: { dev?: unknown; ino?: unknown; size?: unknown; mtimeNs?: unknown };
			};
			destination?: {
				path?: unknown;
				sha256?: unknown;
				sessionId?: unknown;
				header?: { id?: unknown; cwd?: unknown };
				identity?: { dev?: unknown; ino?: unknown; size?: unknown; mtimeNs?: unknown };
			};
			artifactManifest?: unknown;
			sourceArtifactQuarantine?: { role?: unknown };
			sourceArtifactCleanup?: {
				state?: unknown;
				role?: unknown;
				retainedPath?: unknown;
				identity?: {
					dev?: unknown;
					ino?: unknown;
					size?: unknown;
					mtimeNs?: unknown;
					parentDev?: unknown;
					parentIno?: unknown;
				};
				tree?: unknown;
			};
		};
		// A receipt is keyed by its source and names exactly one destination. The
		// resume listing probes every (legacy source, v2 destination) pair, so reject
		// on these cheap receipt fields before hashing both transcripts and walking
		// the artifact manifest; the full conjunction below would be false anyway.
		if (
			record.destination?.path !== destination.path ||
			record.source?.path !== source.path ||
			record.source?.sha256 !== source.identity.sha256
		)
			return false;
		const exact = (
			recorded: { dev?: unknown; ino?: unknown; size?: unknown; mtimeNs?: unknown } | undefined,
			candidate: ManagedCandidate,
		): boolean =>
			recorded?.dev === String(candidate.identity.dev) &&
			recorded.ino === String(candidate.identity.ino) &&
			recorded.size === candidate.identity.size &&
			recorded.mtimeNs === String(candidate.identity.mtimeNs);
		const lineage = (recorded: { dev?: unknown; ino?: unknown } | undefined, candidate: ManagedCandidate): boolean =>
			recorded?.dev === String(candidate.identity.dev) && recorded.ino === String(candidate.identity.ino);
		const sourceSnapshot = captureManagedFileNoFollow(source.path);
		const destinationSnapshot = captureManagedFileNoFollow(destination.path);
		const appendLineage =
			sourceSnapshot.identity.dev === source.identity.dev &&
			sourceSnapshot.identity.ino === source.identity.ino &&
			sourceSnapshot.identity.size === source.identity.size &&
			sourceSnapshot.identity.mtimeNs === source.identity.mtimeNs &&
			destinationSnapshot.identity.dev === destination.identity.dev &&
			destinationSnapshot.identity.ino === destination.identity.ino &&
			destinationSnapshot.bytes.length >= sourceSnapshot.bytes.length &&
			destinationSnapshot.bytes.subarray(0, sourceSnapshot.bytes.length).equals(sourceSnapshot.bytes);
		const manifest = record.artifactManifest;
		const validManifest =
			Array.isArray(manifest) &&
			manifest.every(entry => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
				const item = entry as { kind?: unknown; path?: unknown; sha256?: unknown; size?: unknown };
				const safePath =
					typeof item.path === "string" && !path.isAbsolute(item.path) && !item.path.split(/[\\/]/).includes("..");
				if (!safePath) return false;
				if (item.kind === "directory") return true;
				return (
					item.kind === "file" &&
					/^[a-f0-9]{64}$/.test(String(item.sha256)) &&
					typeof item.size === "number" &&
					Number.isSafeInteger(item.size) &&
					item.size >= 0
				);
			});
		const quarantine = record.sourceArtifactQuarantine;
		const cleanup = record.sourceArtifactCleanup;
		const cleanupIdentity = cleanup?.identity;
		const cleanupTree = artifactTreeSnapshot(cleanup?.tree);
		const validCleanup =
			cleanup === undefined ||
			(quarantine?.role === "detached_artifact_root" &&
				cleanup.state === "cleanup_pending" &&
				cleanup.role === "exchange_placeholder" &&
				typeof cleanup.retainedPath === "string" &&
				cleanupIdentity?.dev !== undefined &&
				cleanupIdentity.ino !== undefined &&
				cleanupIdentity.size !== undefined &&
				cleanupIdentity.mtimeNs !== undefined &&
				cleanupIdentity.parentDev !== undefined &&
				cleanupIdentity.parentIno !== undefined &&
				!!cleanupTree &&
				cleanupAuthorityMatches(
					{
						state: "cleanup_pending",
						role: "exchange_placeholder",
						retainedPath: cleanup.retainedPath,
						identity: {
							dev: BigInt(String(cleanupIdentity.dev)),
							ino: BigInt(String(cleanupIdentity.ino)),
							size: BigInt(String(cleanupIdentity.size)),
							mtimeNs: BigInt(String(cleanupIdentity.mtimeNs)),
							parentDev: BigInt(String(cleanupIdentity.parentDev)),
							parentIno: BigInt(String(cleanupIdentity.parentIno)),
						},
						tree: cleanupTree,
					},
					path.dirname(source.path),
				));
		return (
			record.schemaVersion === 2 &&
			record.state === "committed" &&
			record.policy === "copy-retain" &&
			record.scope === scopeDigest(scope.platform, scope.canonicalCwd) &&
			validManifest &&
			validCleanup &&
			manifestContains(destination.path, manifest as readonly ArtifactManifestEntry[]) &&
			record.source?.path === source.path &&
			record.source?.sessionId === source.sessionId &&
			record.source?.header?.id === source.sessionId &&
			record.source?.header?.cwd === source.cwd &&
			record.source?.sha256 === source.identity.sha256 &&
			exact(record.source?.identity, source) &&
			record.destination?.path === destination.path &&
			record.destination?.sessionId === destination.sessionId &&
			record.destination?.header?.id === destination.sessionId &&
			record.destination?.header?.cwd === destination.cwd &&
			lineage(record.destination?.identity, destination) &&
			appendLineage
		);
	} catch {
		return false;
	}
}

function preparedReceiptMatches(
	receiptPath: string,
	scope: ManagedScope,
	source: ManagedCandidate,
	destination: { path: string; sessionId: string; cwd: string },
	artifactPlan: DetachedArtifactRoot | undefined,
): boolean {
	try {
		const record = JSON.parse(captureManagedFileNoFollow(receiptPath).bytes.toString("utf8")) as Record<
			string,
			unknown
		>;
		const recordedSource = record.source as Record<string, unknown> | undefined;
		const recordedDestination = record.destination as Record<string, unknown> | undefined;
		const quarantine = record.sourceArtifactQuarantine as Record<string, unknown> | undefined;
		const identity = quarantine?.identity as Record<string, unknown> | undefined;
		return (
			record.schemaVersion === 2 &&
			record.state === "prepared" &&
			record.policy === "copy-retain" &&
			record.scope === scopeDigest(scope.platform, scope.canonicalCwd) &&
			Array.isArray(record.artifactManifest) &&
			record.artifactManifest.length === 0 &&
			recordedSource?.path === source.path &&
			recordedSource.sessionId === source.sessionId &&
			recordedSource.sha256 === source.identity.sha256 &&
			(recordedSource.identity as Record<string, unknown> | undefined)?.dev === String(source.identity.dev) &&
			(recordedSource.identity as Record<string, unknown> | undefined)?.ino === String(source.identity.ino) &&
			(recordedSource.identity as Record<string, unknown> | undefined)?.size === source.identity.size &&
			(recordedSource.identity as Record<string, unknown> | undefined)?.mtimeNs ===
				String(source.identity.mtimeNs) &&
			recordedDestination?.path === destination.path &&
			recordedDestination.sessionId === destination.sessionId &&
			recordedDestination.header instanceof Object &&
			(recordedDestination.header as Record<string, unknown>).id === destination.sessionId &&
			(recordedDestination.header as Record<string, unknown>).cwd === destination.cwd &&
			(artifactPlan
				? quarantine?.path === artifactPlan.originalPath &&
					quarantine.detachedPath === artifactPlan.detachedPath &&
					identity?.dev === String(artifactPlan.identity.dev) &&
					identity.ino === String(artifactPlan.identity.ino) &&
					identity.size === String(artifactPlan.identity.size) &&
					identity.mtimeNs === String(artifactPlan.identity.mtimeNs) &&
					JSON.stringify(artifactTreeSnapshot(quarantine.tree)) === JSON.stringify(artifactPlan.tree)
				: quarantine === undefined)
		);
	} catch {
		return false;
	}
}

type RetiredTarget = ManagedCandidate & {
	readonly taskArtifactOwnerDeletionEvidence?: TaskArtifactOwnerDeletionEvidence;
};

const MANAGED_GC_RETIREMENT_PREFIX = "gc-retirement-";
const MANAGED_GC_RETIREMENT_RECEIPTS = `${MANAGED_INTERNAL_DIRECTORY}/${MANAGED_RECEIPTS_DIRECTORY}`;
const MANAGED_GC_RETIREMENT_LOCKS = `${MANAGED_INTERNAL_DIRECTORY}/${MANAGED_LOCKS_DIRECTORY}`;
interface ManagedGcTrustedScope {
	readonly root: ManagedDirectoryRoot;
	readonly retainedAuthority: RecoveryFsRoot | undefined;
	readonly identity: { readonly dev: bigint; readonly ino: bigint };
	readonly policy: ManagedSessionSecurityPolicy;
	readonly ownerContext: TaskArtifactOwnerStorageContext;
}
function managedGcTrustedScope(scope: ManagedScope): ManagedGcTrustedScope {
	const root = managedRoots.get(scope);
	const identity = managedDirectoryIdentities.get(scope);
	const configuration = managedScopeConfigurations.get(scope);
	if (!root || !identity || !configuration || !managedDirectoryAuthorities.has(scope))
		throw new Error("managed_gc_scope_authority_unavailable");
	if (
		scope.agentDir !== configuration.agentDir ||
		scope.sessionsRoot !== configuration.sessionsRoot ||
		scope.canonicalCwd !== configuration.canonicalCwd ||
		scope.directoryName !== configuration.directoryName ||
		scope.directoryPath !== configuration.directoryPath ||
		scope.platform !== configuration.platform ||
		scope.apiVersion !== 1 ||
		scope.layoutVersion !== MANAGED_SESSION_LAYOUT_VERSION ||
		scope.identityVersion !== MANAGED_SESSION_IDENTITY_VERSION
	)
		throw new Error("managed_gc_scope_authority_mismatch");
	const policy: ManagedSessionSecurityPolicy =
		scope.platform === "win32" ? "windows-existing-verify-first" : "default";
	assertManagedDirectoryRoot(root);
	managedDirectoryIdentityForScope(scope);
	assertRetainedManagedDirectoryIdentity(scope);
	const readIdentities = readManagedGcScopeIdentities.get(scope);
	if (readIdentities) {
		for (const expected of [readIdentities.configuredRoot, readIdentities.profile, readIdentities.sessions]) {
			const current = fs.lstatSync(expected.path, { bigint: true });
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				current.dev !== expected.dev ||
				current.ino !== expected.ino
			)
				throw new Error("managed_gc_scope_authority_mismatch");
		}
		for (const pathname of [
			readIdentities.configuredRoot.path,
			readIdentities.profile.path,
			readIdentities.sessions.path,
		]) {
			const verified = validateNativeSecurityResult(
				verifyExistingManagedScopeDirectory(pathname),
				"verify",
				"directory",
			);
			if (!verified.ok) throw new Error("managed_gc_scope_authority_mismatch");
		}
	}
	return {
		root,
		retainedAuthority: managedDirectoryAuthorities.get(scope),
		identity,
		policy,
		ownerContext: Object.freeze({
			rootAuthority: root,
			sessionsRoot: scope.sessionsRoot,
			securityPolicy: policy,
			profileAgentDir: scope.agentDir,
		}),
	};
}
/** Build owner-storage authority only from a previously prepared trusted managed scope. */
export function taskArtifactOwnerStorageContextForScope(scope: ManagedScope): TaskArtifactOwnerStorageContext {
	return managedGcTrustedScope(scope).ownerContext;
}
function managedGcScopeStore(scope: ManagedScope, trusted: ManagedGcTrustedScope): ManagedSessionDescendantStore {
	return new ManagedSessionDescendantStore(
		trusted.root,
		scope.directoryPath,
		trusted.retainedAuthority
			? { authority: trusted.retainedAuthority, authorityBaseDir: scope.directoryPath }
			: undefined,
		trusted.policy,
		scope.agentDir,
		{
			canonicalPath: scope.directoryPath,
			dev: BigInt.asUintN(64, trusted.identity.dev),
			ino: BigInt.asUintN(64, trusted.identity.ino),
		},
	);
}
function managedGcScopeReader(scope: ManagedScope, trusted: ManagedGcTrustedScope): ManagedSessionDescendantStore {
	return new ManagedSessionDescendantStore(
		trusted.root,
		scope.directoryPath,
		undefined,
		trusted.policy,
		scope.agentDir,
		{
			canonicalPath: scope.directoryPath,
			dev: BigInt.asUintN(64, trusted.identity.dev),
			ino: BigInt.asUintN(64, trusted.identity.ino),
		},
		"read-only",
	);
}
function managedGcRetirementTranscriptKey(transcriptPath: string): string {
	return createHash("sha256").update(path.resolve(transcriptPath), "utf8").digest("hex");
}
function managedGcRetirementReceiptRelativePath(
	transcriptPath: string,
	state: ManagedGcSessionRetirementState,
	attempt?: number,
): string {
	if (state === "owner_pending" && (!Number.isSafeInteger(attempt) || attempt === undefined || attempt < 1))
		throw new Error("task_artifact_owner_continuation_attempt_invalid");
	const suffix = state === "owner_pending" ? `${state}-${String(attempt).padStart(8, "0")}` : state;
	return `${MANAGED_GC_RETIREMENT_RECEIPTS}/${MANAGED_GC_RETIREMENT_PREFIX}${managedGcRetirementTranscriptKey(transcriptPath)}-${suffix}.json`;
}
function validateManagedGcTranscriptPath(scope: ManagedScope, transcriptPath: string): string {
	if (
		typeof transcriptPath !== "string" ||
		!path.isAbsolute(transcriptPath) ||
		path.resolve(transcriptPath) !== transcriptPath ||
		path.dirname(transcriptPath) !== scope.directoryPath ||
		path.extname(transcriptPath) !== ".jsonl" ||
		!pathIsWithin(scope.sessionsRoot, transcriptPath)
	)
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	return transcriptPath;
}
function managedGcTargetFromSnapshot(
	scope: ManagedScope,
	transcriptPath: string,
	snapshot: SessionStorageSnapshot,
): ManagedGcSessionRetirementTarget {
	if (
		!snapshot.stat.isFile ||
		snapshot.stat.nlink !== 1n ||
		snapshot.stat.size !== snapshot.bytes.byteLength ||
		!Number.isSafeInteger(snapshot.stat.size) ||
		snapshot.stat.size < 0
	)
		throw new Error("task_artifact_owner_continuation_identity_invalid");
	const header = parseFirstJsonlLine(snapshot.bytes);
	if (
		header?.type !== "session" ||
		typeof header.id !== "string" ||
		header.id.length === 0 ||
		typeof header.cwd !== "string" ||
		header.cwd.length === 0
	)
		throw new Error("task_artifact_owner_transcript_header_invalid");
	const cwdIdentity = identityFor(header.cwd);
	if (!cwdIdentity.ok || cwdIdentity.platform !== scope.platform || cwdIdentity.canonicalPath !== scope.canonicalCwd)
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	const locator = taskArtifactOwnerLocatorFromTranscriptBytes(snapshot.bytes, header.id);
	if (!locator) throw new Error("task_artifact_owner_locator_missing");
	return Object.freeze({
		transcriptPath,
		sessionId: header.id,
		cwd: header.cwd,
		transcriptIdentity: {
			dev: snapshot.stat.dev,
			ino: snapshot.stat.ino,
			nlink: snapshot.stat.nlink,
			size: snapshot.stat.size,
			mtimeNs: snapshot.stat.mtimeNs,
			sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
		},
		taskArtifactOwnerLocator: locator,
	});
}
/** Bind the first transcript header through FileSessionStorage's descriptor-bound, no-follow snapshot. */
export function bindManagedGcSessionRetirementTarget(
	scope: ManagedScope,
	transcriptPathValue: string,
): ManagedGcSessionRetirementTarget {
	const trusted = managedGcTrustedScope(scope);
	const transcriptPath = validateManagedGcTranscriptPath(scope, transcriptPathValue);
	const store = managedGcScopeReader(scope, trusted);
	try {
		store.verifyRootSecurity();
		store.assertBound();
		const snapshot = new FileSessionStorage().readSnapshotSync(transcriptPath);
		store.assertBound();
		return managedGcTargetFromSnapshot(scope, transcriptPath, snapshot);
	} finally {
		store.close();
	}
}
function sameManagedGcTarget(left: ManagedGcSessionRetirementTarget, right: ManagedGcSessionRetirementTarget): boolean {
	return (
		left.transcriptPath === right.transcriptPath &&
		left.sessionId === right.sessionId &&
		left.cwd === right.cwd &&
		sameIdentity(left.transcriptIdentity, right.transcriptIdentity) &&
		util.isDeepStrictEqual(left.taskArtifactOwnerLocator, right.taskArtifactOwnerLocator)
	);
}
function assertManagedGcTranscriptUnchangedOrAbsent(
	scope: ManagedScope,
	target: ManagedGcSessionRetirementTarget,
	allowAbsent: boolean,
): void {
	try {
		const current = bindManagedGcSessionRetirementTarget(scope, target.transcriptPath);
		if (!sameManagedGcTarget(current, target))
			throw new Error("task_artifact_owner_continuation_transcript_replaced");
	} catch (error) {
		if (allowAbsent && hasFsCode(error, "ENOENT")) return;
		throw error;
	}
}
function managedGcReceiptRecord(
	scope: ManagedScope,
	receipt: ManagedGcSessionRetirementReceipt,
	attempt?: number,
): Record<string, unknown> {
	const state = receipt.state;
	const common = {
		schemaVersion: 1,
		state,
		scope: scopeDigest(scope.platform, scope.canonicalCwd),
		transcriptPath: receipt.transcriptPath,
		sessionId: receipt.sessionId,
		cwd: receipt.cwd,
		transcriptIdentity: managedGcRetirementIdentityRecord(receipt.transcriptIdentity),
		taskArtifactOwnerDeletionEvidence: receipt.taskArtifactOwnerDeletionEvidence,
	};
	const hasOutcomeFields =
		receipt.ownerRetirementAttempt !== undefined ||
		receipt.taskArtifactOwnerRetirementOutcome !== undefined ||
		receipt.taskArtifactOwnerRetirementContinuation !== undefined ||
		receipt.taskArtifactOwnerPayloadRetired !== undefined ||
		receipt.taskArtifactOwnerNamespaceRetained !== undefined ||
		receipt.taskArtifactOwnerRetired !== undefined;
	if (state === "prepared" || state === "artifacts_removed") {
		if (
			hasOutcomeFields ||
			(state === "prepared" && receipt.artifactsRemoved !== undefined) ||
			(state === "artifacts_removed" && receipt.artifactsRemoved !== undefined && receipt.artifactsRemoved !== true)
		)
			throw new Error("task_artifact_owner_continuation_state_mismatch");
		return state === "prepared" ? common : { ...common, artifactsRemoved: true };
	}
	if (state === "owner_pending") {
		const outcome = receipt.taskArtifactOwnerRetirementOutcome;
		if (
			!outcome ||
			outcome.kind === "completed" ||
			(receipt.artifactsRemoved !== undefined && receipt.artifactsRemoved !== true) ||
			receipt.taskArtifactOwnerRetired !== undefined ||
			(attempt !== undefined &&
				receipt.ownerRetirementAttempt !== undefined &&
				receipt.ownerRetirementAttempt !== attempt) ||
			(receipt.taskArtifactOwnerRetirementContinuation !== undefined &&
				!util.isDeepStrictEqual(receipt.taskArtifactOwnerRetirementContinuation, outcome.continuation)) ||
			(receipt.taskArtifactOwnerPayloadRetired !== undefined &&
				receipt.taskArtifactOwnerPayloadRetired !== (outcome.kind === "payload_retired")) ||
			(receipt.taskArtifactOwnerNamespaceRetained !== undefined &&
				receipt.taskArtifactOwnerNamespaceRetained !== (outcome.kind === "payload_retired"))
		)
			throw new Error("task_artifact_owner_continuation_outcome_mismatch");
		if (!Number.isSafeInteger(attempt) || attempt === undefined || attempt < 1)
			throw new Error("task_artifact_owner_continuation_attempt_invalid");
		return {
			...common,
			ownerRetirementAttempt: attempt,
			artifactsRemoved: true,
			taskArtifactOwnerRetirementOutcome: outcome,
			taskArtifactOwnerRetirementContinuation: outcome.continuation,
			...(outcome.kind === "payload_retired"
				? { taskArtifactOwnerPayloadRetired: true, taskArtifactOwnerNamespaceRetained: true }
				: {}),
		};
	}
	if (
		(receipt.artifactsRemoved !== undefined && receipt.artifactsRemoved !== true) ||
		hasOutcomeFieldsExceptOutcome(receipt) ||
		(receipt.taskArtifactOwnerRetired !== undefined && receipt.taskArtifactOwnerRetired !== true) ||
		receipt.taskArtifactOwnerRetirementOutcome?.kind !== "completed"
	)
		throw new Error("task_artifact_owner_continuation_outcome_mismatch");
	return {
		...common,
		artifactsRemoved: true,
		taskArtifactOwnerRetired: true,
		taskArtifactOwnerRetirementOutcome: receipt.taskArtifactOwnerRetirementOutcome,
	};
}

function hasOutcomeFieldsExceptOutcome(receipt: ManagedGcSessionRetirementReceipt): boolean {
	return (
		receipt.ownerRetirementAttempt !== undefined ||
		receipt.taskArtifactOwnerRetirementContinuation !== undefined ||
		receipt.taskArtifactOwnerPayloadRetired !== undefined ||
		receipt.taskArtifactOwnerNamespaceRetained !== undefined
	);
}
function parseManagedGcReceiptFile(
	store: ManagedSessionDescendantStore,
	relativePath: string,
	scope: ManagedScope,
	ownerContext: TaskArtifactOwnerStorageContext,
	target: ManagedGcSessionRetirementTarget,
): ManagedGcSessionRetirementReceipt | undefined {
	const snapshot = store.readExpected(relativePath);
	if (!snapshot) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(snapshot.bytes.toString("utf8"));
	} catch {
		throw new Error("task_artifact_owner_continuation_corrupt");
	}
	return parseManagedGcRetirementReceipt(value, scopeDigest(scope.platform, scope.canonicalCwd), ownerContext, target);
}
function targetFromPreparedRecord(value: unknown, transcriptPath: string): ManagedGcSessionRetirementTarget {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("task_artifact_owner_continuation_corrupt");
	const record = value as Record<string, unknown>;
	if (
		record.state !== "prepared" ||
		record.transcriptPath !== transcriptPath ||
		typeof record.sessionId !== "string" ||
		typeof record.cwd !== "string"
	)
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	const evidence = parseTaskArtifactOwnerDeletionEvidence(record.taskArtifactOwnerDeletionEvidence);
	return {
		transcriptPath,
		sessionId: record.sessionId,
		cwd: record.cwd,
		transcriptIdentity: managedGcRetirementIdentityValue(record.transcriptIdentity),
		taskArtifactOwnerLocator: evidence.locator,
	};
}
function deepSame(left: unknown, right: unknown): boolean {
	return util.isDeepStrictEqual(left, right);
}
function readManagedGcPreparedAuthority(
	scope: ManagedScope,
	transcriptPath: string,
	ownerContext: TaskArtifactOwnerStorageContext,
	store: ManagedSessionDescendantStore,
): ManagedGcSessionRetirementReceipt | undefined {
	const snapshot = store.readExpected(managedGcRetirementReceiptRelativePath(transcriptPath, "prepared"));
	if (!snapshot) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(snapshot.bytes.toString("utf8"));
	} catch {
		throw new Error("task_artifact_owner_continuation_corrupt");
	}
	const target = targetFromPreparedRecord(value, transcriptPath);
	const prepared = parseManagedGcRetirementReceipt(
		value,
		scopeDigest(scope.platform, scope.canonicalCwd),
		ownerContext,
		target,
	);
	if (prepared.state !== "prepared") throw new Error("task_artifact_owner_continuation_state_missing");
	return prepared;
}
function assertSameManagedGcImmutableAuthority(
	prepared: ManagedGcSessionRetirementReceipt,
	next: ManagedGcSessionRetirementReceipt,
): void {
	if (
		!sameManagedGcTarget(prepared, next) ||
		!deepSame(prepared.taskArtifactOwnerDeletionEvidence, next.taskArtifactOwnerDeletionEvidence)
	)
		throw new Error("task_artifact_owner_continuation_evidence_mismatch");
}
function readManagedGcSessionRetirementReceiptUnlocked(
	scope: ManagedScope,
	transcriptPathValue: string,
	trusted: ManagedGcTrustedScope,
	store: ManagedSessionDescendantStore,
	lock?: ManagedStorageLock,
): ManagedGcSessionRetirementReceipt | undefined {
	const transcriptPath = validateManagedGcTranscriptPath(scope, transcriptPathValue);
	lock?.assertOwned();
	store.assertBound();
	const prepared = readManagedGcPreparedAuthority(scope, transcriptPath, trusted.ownerContext, store);
	if (!prepared) {
		if (managedGcReceiptNames(scope, transcriptPath, store).length > 0)
			throw new Error("task_artifact_owner_continuation_state_missing");
		return undefined;
	}
	const target = prepared;
	assertManagedGcTranscriptUnchangedOrAbsent(scope, target, true);
	const names = new Set(managedGcReceiptNames(scope, transcriptPath, store));
	if (!names.has(path.posix.basename(managedGcRetirementReceiptRelativePath(transcriptPath, "prepared"))))
		throw new Error("task_artifact_owner_continuation_state_missing");
	const readState = (state: ManagedGcSessionRetirementState, attempt?: number) =>
		parseManagedGcReceiptFile(
			store,
			managedGcRetirementReceiptRelativePath(transcriptPath, state, attempt),
			scope,
			trusted.ownerContext,
			target,
		);
	const artifactsName = path.posix.basename(
		managedGcRetirementReceiptRelativePath(transcriptPath, "artifacts_removed"),
	);
	const retiredName = path.posix.basename(managedGcRetirementReceiptRelativePath(transcriptPath, "owner_retired"));
	const artifactsRemoved = names.has(artifactsName) ? readState("artifacts_removed") : undefined;
	const ownerRetired = names.has(retiredName) ? readState("owner_retired") : undefined;
	if (
		(names.has(artifactsName) && artifactsRemoved?.state !== "artifacts_removed") ||
		(names.has(retiredName) && ownerRetired?.state !== "owner_retired")
	)
		throw new Error("task_artifact_owner_continuation_state_missing");
	const prefix = `${MANAGED_GC_RETIREMENT_PREFIX}${managedGcRetirementTranscriptKey(transcriptPath)}-owner_pending-`;
	const attempts = [...names]
		.filter(name => name.startsWith(prefix))
		.map(name => {
			const suffix = name.slice(prefix.length);
			if (!/^[0-9]{8,}\.json$/u.test(suffix)) throw new Error("task_artifact_owner_continuation_corrupt");
			const attempt = Number(suffix.slice(0, -5));
			if (!Number.isSafeInteger(attempt) || attempt < 1 || `${String(attempt).padStart(8, "0")}.json` !== suffix)
				throw new Error("task_artifact_owner_continuation_corrupt");
			return attempt;
		})
		.sort((left, right) => left - right);
	const pendingReceipts: ManagedGcSessionRetirementReceipt[] = [];
	for (let index = 0; index < attempts.length; index++) {
		const attempt = attempts[index]!;
		const pending = readState("owner_pending", attempt);
		if (
			attempt !== index + 1 ||
			!pending ||
			pending.state !== "owner_pending" ||
			pending.ownerRetirementAttempt !== attempt
		)
			throw new Error("task_artifact_owner_continuation_state_missing");
		pendingReceipts.push(pending);
	}
	if ((pendingReceipts.length || ownerRetired) && !artifactsRemoved)
		throw new Error("task_artifact_owner_continuation_state_missing");
	for (const receipt of [artifactsRemoved, ...pendingReceipts, ownerRetired])
		if (receipt) assertSameManagedGcImmutableAuthority(prepared, receipt);
	for (let index = 1; index < pendingReceipts.length; index++) {
		const previous = pendingReceipts[index - 1]!.taskArtifactOwnerRetirementOutcome;
		const next = pendingReceipts[index]!.taskArtifactOwnerRetirementOutcome;
		if (
			!previous ||
			previous.kind === "completed" ||
			!next ||
			next.kind === "completed" ||
			!continuationExtendsPrevious(previous.continuation, next.continuation)
		)
			throw new Error("task_artifact_owner_continuation_authority_mismatch");
	}
	if (ownerRetired) {
		const outcome = ownerRetired.taskArtifactOwnerRetirementOutcome;
		if (outcome?.kind !== "completed") throw new Error("task_artifact_owner_continuation_outcome_mismatch");
		verifyTaskArtifactOwnerPhysicalRetirement(
			trusted.ownerContext,
			ownerRetired.taskArtifactOwnerDeletionEvidence,
			outcome,
		);
	}
	return ownerRetired ?? pendingReceipts[pendingReceipts.length - 1] ?? artifactsRemoved ?? prepared;
}

function managedGcReceiptNames(
	scope: ManagedScope,
	transcriptPath: string,
	store: ManagedSessionDescendantStore,
): string[] {
	const prefix = `${MANAGED_GC_RETIREMENT_PREFIX}${managedGcRetirementTranscriptKey(transcriptPath)}-`;
	const receiptsDirectory = path.join(scope.directoryPath, MANAGED_GC_RETIREMENT_RECEIPTS);
	const before = store.captureDirectoryIdentity(MANAGED_GC_RETIREMENT_RECEIPTS);
	const entries = fs.readdirSync(receiptsDirectory, { withFileTypes: true });
	const after = store.captureDirectoryIdentity(MANAGED_GC_RETIREMENT_RECEIPTS);
	if (before.dev !== after.dev || before.ino !== after.ino)
		throw new Error("task_artifact_owner_continuation_authority_mismatch");
	store.assertBound();
	const matching = entries.filter(entry => entry.name.startsWith(prefix));
	if (matching.some(entry => !entry.isFile() || entry.isSymbolicLink()))
		throw new Error("task_artifact_owner_continuation_corrupt");
	const names = matching.map(entry => entry.name);
	const pendingPrefix = `${prefix}owner_pending-`;
	for (const name of names) {
		if (
			name !== `${prefix}prepared.json` &&
			name !== `${prefix}artifacts_removed.json` &&
			name !== `${prefix}owner_retired.json` &&
			!name.startsWith(pendingPrefix)
		)
			throw new Error("task_artifact_owner_continuation_corrupt");
	}
	return names;
}
async function withManagedGcRetirementJournal<T>(
	scope: ManagedScope,
	transcriptPath: string,
	operation: (
		trusted: ManagedGcTrustedScope,
		store: ManagedSessionDescendantStore,
		lock: ManagedStorageLock,
	) => Promise<T> | T,
): Promise<T> {
	const trusted = managedGcTrustedScope(scope);
	validateManagedGcTranscriptPath(scope, transcriptPath);
	const store = managedGcScopeStore(scope, trusted);
	let lock: ManagedStorageLock | undefined;
	let operationError: unknown;
	let result: T | undefined;
	let operationCompleted = false;
	try {
		store.verifyRootSecurity();
		store.ensureDirectory(MANAGED_GC_RETIREMENT_RECEIPTS);
		store.ensureDirectory(MANAGED_GC_RETIREMENT_LOCKS);
		lock = await acquireManagedLock(
			path.join(scope.directoryPath, MANAGED_GC_RETIREMENT_LOCKS),
			`${MANAGED_GC_RETIREMENT_PREFIX}${managedGcRetirementTranscriptKey(transcriptPath)}`,
			trusted.root,
			trusted.policy,
		);
		lock.assertOwned();
		store.assertBound();
		result = await operation(trusted, store, lock);
		operationCompleted = true;
	} catch (error) {
		operationError = error;
	}
	let releaseError: unknown;
	if (lock) {
		try {
			await lock.release();
		} catch (error) {
			releaseError = error;
		}
	}
	store.close();
	if (operationError !== undefined && releaseError !== undefined)
		throw new AggregateError(
			[operationError, releaseError],
			"managed_gc_retirement_operation_and_lock_release_failed",
		);
	if (operationError !== undefined) throw operationError;
	if (releaseError !== undefined) throw releaseError;
	if (!operationCompleted) throw new Error("managed_gc_retirement_result_missing");
	return result as T;
}

/** Read the prepared authority first, then strictly validate every later receipt against it. */
export async function readManagedGcSessionRetirementReceipt(
	scope: ManagedScope,
	transcriptPath: string,
): Promise<ManagedGcSessionRetirementReceipt | undefined> {
	return withManagedGcRetirementJournal(scope, transcriptPath, (trusted, store, lock) =>
		readManagedGcSessionRetirementReceiptUnlocked(scope, transcriptPath, trusted, store, lock),
	);
}

/** Read an authenticated journal without creating lock/receipt directories or repairing security state. */
export async function readManagedGcSessionRetirementReceiptReadOnly(
	scope: ManagedScope,
	transcriptPath: string,
): Promise<ManagedGcSessionRetirementReceipt | undefined> {
	const trusted = managedGcTrustedScope(scope);
	validateManagedGcTranscriptPath(scope, transcriptPath);
	const store = managedGcScopeReader(scope, trusted);
	try {
		store.verifyRootSecurity();
		store.assertBound();
		try {
			store.captureDirectoryIdentity(MANAGED_GC_RETIREMENT_RECEIPTS);
		} catch (error) {
			if (hasFsCode(error, "ENOENT")) return undefined;
			throw error;
		}
		return readManagedGcSessionRetirementReceiptUnlocked(scope, transcriptPath, trusted, store);
	} finally {
		store.close();
	}
}

/** Discover complete owner journals under authenticated existing v2 scopes without initializing storage. */
export async function discoverManagedGcSessionRetirementReceipts(input: {
	agentDir: string;
	sessionsRoot: string;
}): Promise<readonly { readonly scope: ManagedScope; readonly receipt: ManagedGcSessionRetirementReceipt }[]> {
	const agentDir = canonicalizeTrustedPath(input.agentDir);
	const sessionsRoot = canonicalizeTrustedPath(input.sessionsRoot);
	const profileStat = fs.lstatSync(agentDir, { bigint: true });
	const rootStat = fs.lstatSync(sessionsRoot, { bigint: true });
	for (const [pathname, stat] of [
		[agentDir, profileStat],
		[sessionsRoot, rootStat],
	] as const) {
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed_gc_scope_authority_mismatch");
		const verified = validateNativeSecurityResult(
			verifyExistingManagedScopeDirectory(pathname),
			"verify",
			"directory",
		);
		if (!verified.ok) throw new Error("managed_gc_scope_authority_mismatch");
	}
	const inventoryBefore = {
		dev: rootStat.dev,
		ino: rootStat.ino,
		profileDev: profileStat.dev,
		profileIno: profileStat.ino,
	};
	const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
	const result: Array<{ readonly scope: ManagedScope; readonly receipt: ManagedGcSessionRetirementReceipt }> = [];
	// Fail closed for the whole root: a partial inventory cannot prove live sibling absence.
	for (const entry of entries) {
		if (!/^v2-[a-z2-7]{52}$/u.test(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed_gc_scope_authority_mismatch");
		const scopePath = path.join(sessionsRoot, entry.name);
		const bindingPath = path.join(scopePath, MANAGED_SESSION_BINDING_FILE);
		const bindingBytes = captureManagedFileNoFollow(bindingPath).bytes;
		let bindingValue: unknown;
		try {
			bindingValue = JSON.parse(bindingBytes.toString("utf8"));
		} catch {
			throw new Error("managed_gc_scope_authority_mismatch");
		}
		if (!isBinding(bindingValue) || bindingValue.identityDigest !== entry.name.slice(3))
			throw new Error("managed_gc_scope_authority_mismatch");
		const resolved = resolveManagedGcScopeForRead({ cwd: bindingValue.canonicalPath, agentDir, sessionsRoot });
		if (resolved.kind !== "resolved" || resolved.scope.directoryPath !== scopePath)
			throw new Error("managed_gc_scope_authority_mismatch");
		const scope = resolved.scope;
		const trusted = managedGcTrustedScope(scope);
		const store = managedGcScopeReader(scope, trusted);
		try {
			let directoryIdentity: { dev: string; ino: string };
			try {
				directoryIdentity = store.captureDirectoryIdentity(MANAGED_GC_RETIREMENT_RECEIPTS);
			} catch (error) {
				if (hasFsCode(error, "ENOENT")) continue;
				throw error;
			}
			const receiptDir = path.join(scopePath, MANAGED_GC_RETIREMENT_RECEIPTS);
			const receiptEntries = fs.readdirSync(receiptDir, { withFileTypes: true });
			const after = store.captureDirectoryIdentity(MANAGED_GC_RETIREMENT_RECEIPTS);
			if (after.dev !== directoryIdentity.dev || after.ino !== directoryIdentity.ino)
				throw new Error("task_artifact_owner_continuation_authority_mismatch");
			const names = receiptEntries.filter(item => item.name.startsWith(MANAGED_GC_RETIREMENT_PREFIX));
			const groups = new Map<string, string[]>();
			for (const item of names) {
				if (
					!item.isFile() ||
					item.isSymbolicLink() ||
					!/^gc-retirement-[a-f0-9]{64}-(?:prepared|artifacts_removed|owner_retired|owner_pending-[0-9]{8,})\.json$/u.test(
						item.name,
					)
				)
					throw new Error("task_artifact_owner_continuation_corrupt");
				const key = item.name.slice(MANAGED_GC_RETIREMENT_PREFIX.length, MANAGED_GC_RETIREMENT_PREFIX.length + 64);
				groups.set(key, [...(groups.get(key) ?? []), item.name]);
			}
			for (const [key, group] of groups) {
				const preparedName = `${MANAGED_GC_RETIREMENT_PREFIX}${key}-prepared.json`;
				if (!group.includes(preparedName)) throw new Error("task_artifact_owner_continuation_state_missing");
				const preparedFile = store.readExpected(`${MANAGED_GC_RETIREMENT_RECEIPTS}/${preparedName}`);
				if (!preparedFile) throw new Error("task_artifact_owner_continuation_state_missing");
				let preparedValue: unknown;
				try {
					preparedValue = JSON.parse(preparedFile.bytes.toString("utf8"));
				} catch {
					throw new Error("task_artifact_owner_continuation_corrupt");
				}
				const transcriptPath =
					preparedValue && typeof preparedValue === "object"
						? (preparedValue as Record<string, unknown>).transcriptPath
						: undefined;
				if (typeof transcriptPath !== "string" || managedGcRetirementTranscriptKey(transcriptPath) !== key)
					throw new Error("task_artifact_owner_continuation_authority_mismatch");
				const receipt = await readManagedGcSessionRetirementReceiptReadOnly(scope, transcriptPath);
				if (!receipt) throw new Error("task_artifact_owner_continuation_state_missing");
				result.push({ scope, receipt });
			}
		} finally {
			store.close();
		}
	}
	const rootAfter = fs.lstatSync(sessionsRoot, { bigint: true });
	const profileAfter = fs.lstatSync(agentDir, { bigint: true });
	if (
		!rootAfter.isDirectory() ||
		rootAfter.isSymbolicLink() ||
		rootAfter.dev !== inventoryBefore.dev ||
		rootAfter.ino !== inventoryBefore.ino ||
		!profileAfter.isDirectory() ||
		profileAfter.isSymbolicLink() ||
		profileAfter.dev !== inventoryBefore.profileDev ||
		profileAfter.ino !== inventoryBefore.profileIno
	)
		throw new Error("managed_gc_scope_authority_mismatch");
	return result.sort((left, right) => left.receipt.transcriptPath.localeCompare(right.receipt.transcriptPath));
}

const MANAGED_GC_PROTOCOL_ROLES: readonly ManagedGcProtocolRole[] = [
	MANAGED_LOCKS_DIRECTORY,
	MANAGED_RECEIPTS_DIRECTORY,
	MANAGED_TOMBSTONES_DIRECTORY,
];
const MANAGED_GC_PROTOCOL_MAX_ENTRIES = MANAGED_ARTIFACT_MAX_FILES;

function managedGcProtocolDirectoryStat(pathname: string): fs.BigIntStats {
	const stat = fs.lstatSync(pathname, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed_gc_protocol_directory_invalid");
	const security = validateNativeSecurityResult(verifyExistingManagedScopeDirectory(pathname), "verify", "directory");
	if (!security.ok) throw new Error("managed_gc_protocol_directory_invalid");
	return stat;
}

function managedGcProtocolDirectorySnapshot(
	scope: ManagedScope,
	store: ManagedSessionDescendantStore,
	role: ManagedGcProtocolRole | typeof MANAGED_INTERNAL_DIRECTORY,
): { readonly path: string; readonly stat: fs.BigIntStats; readonly names: readonly string[] } {
	const relativePath = role === MANAGED_INTERNAL_DIRECTORY ? role : `${MANAGED_INTERNAL_DIRECTORY}/${role}`;
	const pathname = path.join(scope.directoryPath, relativePath);
	const before = managedGcProtocolDirectoryStat(pathname);
	const retained = store.captureDirectoryIdentity(relativePath);
	if (retained.dev !== before.dev.toString() || retained.ino !== before.ino.toString())
		throw new Error("managed_gc_protocol_directory_identity_mismatch");
	const names = fs.readdirSync(pathname).sort();
	const after = managedGcProtocolDirectoryStat(pathname);
	if (
		after.dev !== before.dev ||
		after.ino !== before.ino ||
		after.mtimeNs !== before.mtimeNs ||
		after.ctimeNs !== before.ctimeNs ||
		after.mode !== before.mode
	)
		throw new Error("managed_gc_protocol_directory_changed");
	store.assertBound();
	return { path: pathname, stat: before, names };
}

function managedGcProtocolFileSnapshot(
	scope: ManagedScope,
	store: ManagedSessionDescendantStore,
	relativePath: string,
): {
	readonly snapshot: ManagedFileSnapshot;
	readonly identity: ManagedGcProtocolFileSnapshot;
} {
	store.assertBound();
	const pathname = path.join(scope.directoryPath, relativePath);
	const before = fs.lstatSync(pathname, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
		throw new Error("managed_gc_protocol_file_invalid");
	const native = nativeScope();
	const security = validateNativeSecurityResult(
		process.platform === "win32"
			? native.verifyOwnerOnlyPathSecurityExpected(pathname, "file", before.dev, before.ino)
			: native.verifyOwnerOnlyPathSecurity(pathname, "file"),
		"verify",
		"file",
	);
	if (!security.ok) throw new Error("managed_gc_protocol_file_invalid");
	const snapshot = store.readExpected(relativePath);
	if (!snapshot) throw new Error("managed_gc_protocol_file_missing");
	const after = fs.lstatSync(pathname, { bigint: true });
	if (
		!after.isFile() ||
		after.isSymbolicLink() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.nlink !== after.nlink ||
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs ||
		before.mode !== after.mode ||
		snapshot.identity.dev !== before.dev ||
		snapshot.identity.ino !== before.ino ||
		snapshot.identity.nlink !== before.nlink ||
		snapshot.identity.size !== Number(before.size) ||
		snapshot.identity.mtimeNs !== before.mtimeNs ||
		snapshot.identity.ctimeNs !== before.ctimeNs
	)
		throw new Error("managed_gc_protocol_file_changed");
	store.assertBound();
	return {
		snapshot,
		identity: {
			name: path.basename(pathname),
			dev: snapshot.identity.dev.toString(),
			ino: snapshot.identity.ino.toString(),
			nlink: snapshot.identity.nlink.toString(),
			size: snapshot.identity.size,
			mtimeNs: snapshot.identity.mtimeNs.toString(),
			ctimeNs: snapshot.identity.ctimeNs.toString(),
			mode: Number(before.mode & 0o777n),
			sha256: snapshot.identity.sha256,
		},
	};
}

function managedGcProtocolRecord(
	bytes: Uint8Array,
	role: ManagedGcProtocolRole,
	name: string,
): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// A role-specific parser below supplies the bounded protocol location.
	}
	throw new Error(`managed_gc_protocol_record_invalid:${role}/${name}`);
}

function managedGcProtocolFileIdentityMatches(
	left: ManagedGcProtocolFileSnapshot,
	right: ManagedGcProtocolFileSnapshot,
): boolean {
	return (
		left.name === right.name &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.mode === right.mode &&
		left.sha256 === right.sha256
	);
}

function managedGcProtocolPathIdentity(pathname: string): ManagedGcProtocolPathIdentity {
	const stat = managedGcProtocolDirectoryStat(pathname);
	return { path: pathname, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function validateManagedGcProtocolMigrationReceipt(
	scope: ManagedScope,
	pathname: string,
	name: string,
	bytes: Uint8Array,
): void {
	const match = /^([a-f0-9]{64})(?:\.(prepared|detached|published))?\.json$/u.exec(name);
	if (!match || match[2] !== undefined) throw new Error("managed_gc_protocol_migration_incomplete");
	const record = managedGcProtocolRecord(bytes, MANAGED_RECEIPTS_DIRECTORY, name);
	if (record.state !== "committed") throw new Error("managed_gc_protocol_migration_incomplete");
	const source = record.source as { path?: unknown } | undefined;
	const destination = record.destination as { path?: unknown } | undefined;
	if (typeof source?.path !== "string" || typeof destination?.path !== "string")
		throw new Error("managed_gc_protocol_migration_invalid");
	const legacy = inspectCandidate(source.path, "legacy");
	const managed = inspectCandidate(destination.path, "v2");
	if ("code" in legacy || "code" in managed || !receiptMatches(pathname, legacy, managed, scope))
		throw new Error("managed_gc_protocol_migration_authority_mismatch");
}

function validateManagedGcProtocolTombstoneFile(
	scope: ManagedScope,
	pathname: string,
	name: string,
	bytes: Uint8Array,
	journals: readonly { readonly scope: ManagedScope; readonly receipt: ManagedGcSessionRetirementReceipt }[],
): void {
	if (/^[a-f0-9]{64}\.json$/u.test(name)) {
		const targets = retiredTargets(scope, pathname);
		if (!targets || targets.length === 0) throw new Error("managed_gc_protocol_tombstone_invalid");
		return;
	}
	const match =
		/^([a-f0-9]{64})\.([a-f0-9]{64})\.cleanup-(pending|artifacts_removed|completed)-([1-9][0-9]*)\.json$/u.exec(name);
	if (!match || (match[3] === "completed" && match[4] !== "1"))
		throw new Error("managed_gc_protocol_tombstone_role_invalid");
	const tombstone = path.join(path.dirname(pathname), `${match[1]}.json`);
	const targets = retiredTargets(scope, tombstone);
	if (!targets) throw new Error("managed_gc_protocol_tombstone_authority_missing");
	const target = targets.find(candidate => stableOperationName(candidate) === match[2]);
	if (!target) throw new Error("managed_gc_protocol_tombstone_target_missing");
	const attempt = Number(match[4]);
	if (match[3] === "pending") {
		const pending = pendingCleanupReceipt(scope, tombstone, target);
		if (!pending || pending.attempt < attempt) throw new Error("managed_gc_protocol_tombstone_history_invalid");
		return;
	}
	if (match[3] === "artifacts_removed") {
		if (!cleanupArtifactsRemovedEvidence(scope, tombstone, target, attempt))
			throw new Error("managed_gc_protocol_tombstone_artifacts_invalid");
		return;
	}
	const ownerReceipt = target.taskArtifactOwnerDeletionEvidence
		? journals.find(
				item => item.scope.directoryPath === scope.directoryPath && item.receipt.transcriptPath === target.path,
			)?.receipt
		: undefined;
	if (target.taskArtifactOwnerDeletionEvidence && !ownerReceipt)
		throw new Error("task_artifact_owner_continuation_state_missing");
	const record = managedGcProtocolRecord(bytes, MANAGED_TOMBSTONES_DIRECTORY, name);
	if (!cleanupCompletedRecordMatches(scope, tombstone, target, ownerReceipt, record))
		throw new Error("managed_gc_protocol_tombstone_completion_invalid");
}

/** Inspect under a live operation lease; returned snapshots never authorize effects. */
export function managedGcProtocolInspectorForLock(
	scope: ManagedScope,
	lock: ManagedStorageLock,
): ManagedGcProtocolScopeInspector {
	const inspect = managedGcProtocolScopeInspectorForScope(scope);
	return async inputs => {
		lock.assertOwned();
		managedGcTrustedScope(scope);
		const snapshots = await inspect(inputs);
		lock.assertOwned();
		managedGcTrustedScope(scope);
		return snapshots;
	};
}

/** Bind a read-only protocol inventory to an already prepared scope's root/profile/session identities. */
export function managedGcProtocolScopeInspectorForScope(scope: ManagedScope): ManagedGcProtocolScopeInspector {
	const trusted = managedGcTrustedScope(scope);
	const configuredRoot = managedGcProtocolPathIdentity(trusted.root.canonicalPath);
	const profile = managedGcProtocolPathIdentity(scope.agentDir);
	const sessionsRoot = managedGcProtocolPathIdentity(scope.sessionsRoot);
	const protocol = managedGcProtocolPathIdentity(path.join(scope.directoryPath, MANAGED_INTERNAL_DIRECTORY));
	const assertAuthority = (): void => {
		managedGcTrustedScope(scope);
		for (const expected of [configuredRoot, profile, sessionsRoot, protocol]) {
			const current = managedGcProtocolPathIdentity(expected.path);
			if (current.dev !== expected.dev || current.ino !== expected.ino)
				throw new Error("managed_gc_protocol_root_identity_mismatch");
		}
	};
	return async (inputs: readonly ManagedGcProtocolScopeInput[]) => {
		assertAuthority();
		const journals = await discoverManagedGcSessionRetirementReceipts({
			agentDir: scope.agentDir,
			sessionsRoot: scope.sessionsRoot,
		});
		assertAuthority();
		if (inputs.length > MANAGED_GC_PROTOCOL_MAX_ENTRIES) throw new Error("managed_gc_protocol_scope_limit_exceeded");
		const snapshots: ManagedGcProtocolScopeSnapshot[] = [];
		let totalFiles = 0;
		for (const input of inputs) {
			if (
				path.resolve(input.scopePath) !== input.scopePath ||
				path.dirname(input.scopePath) !== scope.sessionsRoot ||
				!/^v2-[a-z2-7]{52}$/u.test(path.basename(input.scopePath)) ||
				input.scopeIdentity.path !== input.scopePath ||
				input.protocolIdentity.path !== path.join(input.scopePath, MANAGED_INTERNAL_DIRECTORY)
			)
				throw new Error("managed_gc_protocol_scope_path_mismatch");
			const bindingPath = path.join(input.scopePath, MANAGED_SESSION_BINDING_FILE);
			const binding = captureManagedFileNoFollow(bindingPath);
			const bindingStat = fs.lstatSync(bindingPath, { bigint: true });
			const bindingIdentity: ManagedGcProtocolFileSnapshot = {
				name: MANAGED_SESSION_BINDING_FILE,
				dev: binding.identity.dev.toString(),
				ino: binding.identity.ino.toString(),
				nlink: binding.identity.nlink.toString(),
				size: binding.identity.size,
				mtimeNs: binding.identity.mtimeNs.toString(),
				ctimeNs: binding.identity.ctimeNs.toString(),
				mode: Number(bindingStat.mode & 0o777n),
				sha256: binding.identity.sha256,
			};
			if (!managedGcProtocolFileIdentityMatches(bindingIdentity, input.bindingIdentity))
				throw new Error("managed_gc_protocol_binding_identity_mismatch");
			const bindingValue: unknown = JSON.parse(binding.bytes.toString("utf8"));
			if (!isBinding(bindingValue)) throw new Error("managed_gc_scope_authority_mismatch");
			const resolved = resolveManagedGcScopeForRead({
				cwd: bindingValue.canonicalPath,
				agentDir: scope.agentDir,
				sessionsRoot: scope.sessionsRoot,
			});
			if (resolved.kind !== "resolved" || resolved.scope.directoryPath !== input.scopePath)
				throw new Error("managed_gc_protocol_scope_unrecognized");
			const candidateScope = resolved.scope;
			const candidateTrusted = managedGcTrustedScope(candidateScope);
			if (
				candidateTrusted.root.canonicalPath !== trusted.root.canonicalPath ||
				candidateTrusted.root.dev !== trusted.root.dev ||
				candidateTrusted.root.ino !== trusted.root.ino ||
				candidateScope.agentDir !== scope.agentDir ||
				candidateScope.sessionsRoot !== scope.sessionsRoot
			)
				throw new Error("managed_gc_protocol_root_mismatch");
			const scopeIdentity = managedGcProtocolPathIdentity(candidateScope.directoryPath);
			if (scopeIdentity.dev !== input.scopeIdentity.dev || scopeIdentity.ino !== input.scopeIdentity.ino)
				throw new Error("managed_gc_protocol_scope_identity_mismatch");
			const store = managedGcScopeReader(candidateScope, candidateTrusted);
			try {
				store.verifyRootSecurity();
				const checkedBinding = managedGcProtocolFileSnapshot(candidateScope, store, MANAGED_SESSION_BINDING_FILE);
				if (!managedGcProtocolFileIdentityMatches(checkedBinding.identity, input.bindingIdentity))
					throw new Error("managed_gc_protocol_binding_identity_mismatch");
				const protocolDirectory = managedGcProtocolDirectorySnapshot(
					candidateScope,
					store,
					MANAGED_INTERNAL_DIRECTORY,
				);
				if (
					protocolDirectory.path !== input.protocolIdentity.path ||
					protocolDirectory.stat.dev.toString() !== input.protocolIdentity.dev ||
					protocolDirectory.stat.ino.toString() !== input.protocolIdentity.ino ||
					protocolDirectory.stat.mtimeNs.toString() !== input.protocolIdentity.mtimeNs ||
					protocolDirectory.stat.ctimeNs.toString() !== input.protocolIdentity.ctimeNs ||
					Number(protocolDirectory.stat.mode & 0o777n) !== input.protocolIdentity.mode ||
					protocolDirectory.names.length !== MANAGED_GC_PROTOCOL_ROLES.length ||
					MANAGED_GC_PROTOCOL_ROLES.some(role => !protocolDirectory.names.includes(role))
				)
					throw new Error("managed_gc_protocol_roles_invalid");
				const directories: ManagedGcProtocolDirectorySnapshot[] = [];
				for (const role of MANAGED_GC_PROTOCOL_ROLES) {
					const directory = managedGcProtocolDirectorySnapshot(candidateScope, store, role);
					const files: ManagedGcProtocolFileSnapshot[] = [];
					for (const name of directory.names) {
						if (!name || path.basename(name) !== name || name.includes(".jsonl"))
							throw new Error(`managed_gc_protocol_entry_invalid:${role}/${name}`);
						const relative = `${MANAGED_INTERNAL_DIRECTORY}/${role}/${name}`;
						let captured: ReturnType<typeof managedGcProtocolFileSnapshot>;
						try {
							captured = managedGcProtocolFileSnapshot(candidateScope, store, relative);
							if (role === MANAGED_LOCKS_DIRECTORY) {
								if (isManagedLockQuarantineName(name)) {
									if (
										captured.snapshot.bytes.byteLength !== 0 ||
										captured.identity.size !== 0 ||
										captured.identity.sha256 !== createHash("sha256").digest("hex")
									)
										throw new Error("managed_gc_protocol_lock_quarantine_invalid");
								} else {
									if (!/^(?:[a-f0-9]{64}|gc-retirement-[a-f0-9]{64})\.lock$/u.test(name))
										throw new Error("managed_gc_protocol_lock_role_invalid");
									if (!parseManagedLockRecord(captured.snapshot.bytes))
										throw new Error("managed_gc_protocol_lock_invalid");
								}
							} else if (role === MANAGED_RECEIPTS_DIRECTORY) {
								if (
									/^gc-retirement-[a-f0-9]{64}-(?:prepared|artifacts_removed|owner_retired|owner_pending-[0-9]{8,})\.json$/u.test(
										name,
									)
								) {
									const key = name.slice(
										MANAGED_GC_RETIREMENT_PREFIX.length,
										MANAGED_GC_RETIREMENT_PREFIX.length + 64,
									);
									if (
										!journals.some(
											item =>
												item.scope.directoryPath === candidateScope.directoryPath &&
												managedGcRetirementTranscriptKey(item.receipt.transcriptPath) === key,
										)
									)
										throw new Error("task_artifact_owner_continuation_state_missing");
								} else {
									validateManagedGcProtocolMigrationReceipt(
										candidateScope,
										path.join(directory.path, name),
										name,
										captured.snapshot.bytes,
									);
								}
							} else {
								validateManagedGcProtocolTombstoneFile(
									candidateScope,
									path.join(directory.path, name),
									name,
									captured.snapshot.bytes,
									journals,
								);
							}
						} catch (error) {
							const detail = error instanceof Error ? error.message : "unknown";
							throw new Error(`${detail} [${role}/${name}]`);
						}
						files.push(captured.identity);
						totalFiles++;
						if (totalFiles > MANAGED_GC_PROTOCOL_MAX_ENTRIES)
							throw new Error("managed_gc_protocol_entry_limit_exceeded");
					}
					const finalDirectory = managedGcProtocolDirectorySnapshot(candidateScope, store, role);
					if (
						finalDirectory.stat.dev !== directory.stat.dev ||
						finalDirectory.stat.ino !== directory.stat.ino ||
						finalDirectory.stat.mtimeNs !== directory.stat.mtimeNs ||
						finalDirectory.stat.ctimeNs !== directory.stat.ctimeNs ||
						finalDirectory.stat.mode !== directory.stat.mode ||
						finalDirectory.names.length !== directory.names.length ||
						finalDirectory.names.some((name, index) => name !== directory.names[index])
					)
						throw new Error("managed_gc_protocol_directory_changed");
					directories.push({
						role,
						path: directory.path,
						dev: directory.stat.dev.toString(),
						ino: directory.stat.ino.toString(),
						mtimeNs: directory.stat.mtimeNs.toString(),
						ctimeNs: directory.stat.ctimeNs.toString(),
						mode: Number(directory.stat.mode & 0o777n),
						files,
					});
				}
				const finalProtocol = managedGcProtocolDirectorySnapshot(candidateScope, store, MANAGED_INTERNAL_DIRECTORY);
				if (
					finalProtocol.stat.dev !== protocolDirectory.stat.dev ||
					finalProtocol.stat.ino !== protocolDirectory.stat.ino ||
					finalProtocol.stat.mtimeNs !== protocolDirectory.stat.mtimeNs ||
					finalProtocol.stat.ctimeNs !== protocolDirectory.stat.ctimeNs ||
					finalProtocol.stat.mode !== protocolDirectory.stat.mode ||
					finalProtocol.names.length !== protocolDirectory.names.length ||
					finalProtocol.names.some((name, index) => name !== protocolDirectory.names[index])
				)
					throw new Error("managed_gc_protocol_tree_changed");
				for (const directory of directories) {
					const relative = `${MANAGED_INTERNAL_DIRECTORY}/${directory.role}`;
					const names = fs.readdirSync(directory.path).sort();
					if (
						names.length !== directory.files.length ||
						names.some((name, index) => name !== directory.files[index]?.name)
					)
						throw new Error("managed_gc_protocol_directory_changed");
					for (const expected of directory.files) {
						const actual = managedGcProtocolFileSnapshot(candidateScope, store, `${relative}/${expected.name}`);
						if (!managedGcProtocolFileIdentityMatches(actual.identity, expected))
							throw new Error("managed_gc_protocol_file_changed");
					}
					const current = managedGcProtocolDirectoryStat(directory.path);
					if (
						current.dev.toString() !== directory.dev ||
						current.ino.toString() !== directory.ino ||
						current.mtimeNs.toString() !== directory.mtimeNs ||
						current.ctimeNs.toString() !== directory.ctimeNs ||
						Number(current.mode & 0o777n) !== directory.mode
					)
						throw new Error("managed_gc_protocol_directory_changed");
				}
				const finalBinding = managedGcProtocolFileSnapshot(candidateScope, store, MANAGED_SESSION_BINDING_FILE);
				if (!managedGcProtocolFileIdentityMatches(finalBinding.identity, input.bindingIdentity))
					throw new Error("managed_gc_protocol_binding_changed");
				snapshots.push({
					configuredRoot,
					profile,
					sessionsRoot,
					scope: scopeIdentity,
					binding: bindingIdentity,
					protocol: {
						path: protocolDirectory.path,
						dev: protocolDirectory.stat.dev.toString(),
						ino: protocolDirectory.stat.ino.toString(),
					},
					protocolMtimeNs: protocolDirectory.stat.mtimeNs.toString(),
					protocolCtimeNs: protocolDirectory.stat.ctimeNs.toString(),
					protocolMode: Number(protocolDirectory.stat.mode & 0o777n),
					directories,
				});
			} finally {
				store.close();
			}
		}
		const latestJournals = await discoverManagedGcSessionRetirementReceipts({
			agentDir: scope.agentDir,
			sessionsRoot: scope.sessionsRoot,
		});
		if (!deepSame(latestJournals, journals)) throw new Error("managed_gc_protocol_journal_changed");
		assertAuthority();
		return snapshots;
	};
}

function managedGcReceiptForPublication(
	scope: ManagedScope,
	receipt: ManagedGcSessionRetirementReceipt,
	ownerContext: TaskArtifactOwnerStorageContext,
	attempt?: number,
): {
	readonly target: ManagedGcSessionRetirementTarget;
	readonly record: Record<string, unknown>;
	readonly parsed: ManagedGcSessionRetirementReceipt;
} {
	validateManagedGcTranscriptPath(scope, receipt.transcriptPath);
	const record = managedGcReceiptRecord(scope, receipt, attempt);
	const parsed = parseManagedGcRetirementReceipt(
		record,
		scopeDigest(scope.platform, scope.canonicalCwd),
		ownerContext,
		receipt,
	);
	return { target: receipt, record, parsed };
}

function publishManagedGcReceiptNoReplace(
	store: ManagedSessionDescendantStore,
	lock: ManagedStorageLock,
	relativePath: string,
	record: Record<string, unknown>,
): void {
	const bytes = Buffer.from(
		`${JSON.stringify(record, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
		"utf8",
	);
	lock.assertOwned();
	store.assertBound();
	try {
		store.publishNoReplaceSync(relativePath, bytes);
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "destination_conflict") throw error;
		const existing = store.readExpected(relativePath);
		if (!existing?.bytes.equals(bytes)) throw error;
	}
	lock.assertOwned();
	const persisted = store.readExpected(relativePath);
	if (!persisted?.bytes.equals(bytes)) throw new Error("durability_failed");
	store.assertBound();
}

/** Atomically publish one journal state under the managed scope lock; no GC effects are activated here. */
export async function publishManagedGcSessionRetirementReceipt(
	scope: ManagedScope,
	receipt: ManagedGcSessionRetirementReceipt,
): Promise<ManagedGcSessionRetirementReceipt> {
	validateManagedGcTranscriptPath(scope, receipt.transcriptPath);
	return withManagedGcRetirementJournal(scope, receipt.transcriptPath, (trusted, store, lock) => {
		const current = readManagedGcSessionRetirementReceiptUnlocked(
			scope,
			receipt.transcriptPath,
			trusted,
			store,
			lock,
		);
		const target = receipt;
		let attempt: number | undefined;
		if (!current) {
			if (receipt.state !== "prepared") throw new Error("task_artifact_owner_continuation_state_order_invalid");
			assertManagedGcTranscriptUnchangedOrAbsent(scope, target, false);
			const capturedEvidence = captureTaskArtifactOwnerDeletionEvidence(
				trusted.ownerContext,
				target.sessionId,
				target.taskArtifactOwnerLocator,
			);
			if (
				!capturedEvidence ||
				!deepSame(
					capturedEvidence,
					parseTaskArtifactOwnerDeletionEvidence(receipt.taskArtifactOwnerDeletionEvidence),
				)
			)
				throw new Error("task_artifact_owner_continuation_evidence_mismatch");
		} else {
			const prepared = readManagedGcPreparedAuthority(scope, receipt.transcriptPath, trusted.ownerContext, store);
			if (!prepared) throw new Error("task_artifact_owner_continuation_state_missing");
			assertSameManagedGcImmutableAuthority(prepared, receipt);
			assertManagedGcTranscriptUnchangedOrAbsent(scope, prepared, true);
			if (receipt.state === "prepared") {
				managedGcReceiptForPublication(scope, receipt, trusted.ownerContext);
				return current;
			}
			if (receipt.state === "artifacts_removed" && current.state !== "prepared") {
				managedGcReceiptForPublication(scope, receipt, trusted.ownerContext);
				return current;
			}
			if (receipt.state === "owner_pending") {
				if (current.state !== "artifacts_removed" && current.state !== "owner_pending")
					throw new Error("task_artifact_owner_continuation_state_order_invalid");
				attempt = current.state === "owner_pending" ? (current.ownerRetirementAttempt ?? 0) + 1 : 1;
				if (current.state === "owner_pending") {
					const previous = current.taskArtifactOwnerRetirementOutcome;
					const next = receipt.taskArtifactOwnerRetirementOutcome;
					if (
						!previous ||
						previous.kind === "completed" ||
						!next ||
						next.kind === "completed" ||
						!continuationExtendsPrevious(previous.continuation, next.continuation)
					)
						throw new Error("task_artifact_owner_continuation_authority_mismatch");
				}
			} else if (receipt.state === "owner_retired") {
				if (current.state === "owner_retired") {
					const existing = current.taskArtifactOwnerRetirementOutcome;
					const candidate = managedGcReceiptForPublication(scope, receipt, trusted.ownerContext).parsed;
					if (!existing || !deepSame(existing, candidate.taskArtifactOwnerRetirementOutcome))
						throw new Error("task_artifact_owner_continuation_outcome_mismatch");
					return current;
				}
				if (current.state !== "artifacts_removed" && current.state !== "owner_pending")
					throw new Error("task_artifact_owner_continuation_state_order_invalid");
			} else if (receipt.state !== "artifacts_removed") {
				throw new Error("task_artifact_owner_continuation_state_order_invalid");
			}
		}
		const { record, parsed } = managedGcReceiptForPublication(scope, receipt, trusted.ownerContext, attempt);
		if (receipt.state === "owner_retired") {
			const outcome = parsed.taskArtifactOwnerRetirementOutcome;
			if (outcome?.kind !== "completed") throw new Error("task_artifact_owner_continuation_outcome_mismatch");
			verifyTaskArtifactOwnerPhysicalRetirement(
				trusted.ownerContext,
				parsed.taskArtifactOwnerDeletionEvidence,
				outcome,
			);
		}
		const relativePath = managedGcRetirementReceiptRelativePath(receipt.transcriptPath, receipt.state, attempt);
		publishManagedGcReceiptNoReplace(store, lock, relativePath, record);
		const persisted = readManagedGcSessionRetirementReceiptUnlocked(
			scope,
			receipt.transcriptPath,
			trusted,
			store,
			lock,
		);
		if (!persisted) throw new Error("durability_failed");
		const expectedState = receipt.state;
		if (
			persisted.state !== expectedState ||
			(expectedState === "owner_pending" && persisted.ownerRetirementAttempt !== attempt) ||
			!deepSame(persisted.taskArtifactOwnerDeletionEvidence, parsed.taskArtifactOwnerDeletionEvidence)
		)
			throw new Error("durability_failed");
		return persisted;
	});
}
function retiredTargets(scope: ManagedScope, pathname: string): readonly RetiredTarget[] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(captureManagedFileNoFollow(pathname).bytes.toString("utf8"));
		const targets = parseRetiredTargetRecord(scope, value);
		if (!targets) assertLegacyOwnerFreeRecord(value);
		return targets;
	} catch (error) {
		assertLegacyOwnerFreeRecord(value);
		if (isOwnerBoundaryFailure(error)) throw error;
		if (error instanceof SyntaxError) throw new Error("durability_failed", { cause: error });
		return undefined;
	}
}

const OWNER_CONSUMER_UNAVAILABLE = "task_artifact_owner_legacy_scope_unsupported";

function isOwnerBoundaryFailure(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("task_artifact_owner_");
}

function hasOwnerClaims(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).some(key => key.startsWith("taskArtifactOwner")) ||
		(record.target !== undefined && hasOwnerClaims(record.target)) ||
		(Array.isArray(record.targets) && record.targets.some(hasOwnerClaims))
	);
}

function assertLegacyOwnerFreeRecord(value: unknown): void {
	if (hasOwnerClaims(value)) throw new Error(OWNER_CONSUMER_UNAVAILABLE);
}

function assertLegacyOwnerFreeTargets(targets: readonly RetiredTarget[]): void {
	for (const target of targets)
		if (target.taskArtifactOwnerDeletionEvidence) throw new Error(OWNER_CONSUMER_UNAVAILABLE);
}

function assertLegacyOwnerFreeTranscript(
	target: Pick<
		VerifiedSessionDeleteTarget,
		"transcriptPath" | "sessionId" | "transcriptIdentity" | "detachedTranscriptPath"
	>,
): void {
	const pathname = target.detachedTranscriptPath ?? target.transcriptPath;
	let snapshot: SessionStorageSnapshot;
	try {
		snapshot = new FileSessionStorage().readSnapshotSync(pathname);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	// Descriptor-bound owner classification is data, not authorization; storage retains its exact identity fence.
	if (taskArtifactOwnerLocatorFromTranscriptBytes(snapshot.bytes, target.sessionId))
		throw new Error(OWNER_CONSUMER_UNAVAILABLE);
}

function parseRetiredTargetRecord(scope: ManagedScope, value: unknown): readonly RetiredTarget[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Object.keys(value).some(key => key.startsWith("taskArtifactOwner"))) throw new Error(OWNER_CONSUMER_UNAVAILABLE);
	const record = value as { schemaVersion?: unknown; state?: unknown; scope?: unknown; targets?: unknown };
	if (
		record.schemaVersion !== 2 ||
		record.state !== "retired" ||
		record.scope !== scopeDigest(scope.platform, scope.canonicalCwd) ||
		!Array.isArray(record.targets)
	)
		return undefined;
	const targets: RetiredTarget[] = [];
	for (const target of record.targets) {
		if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
		const item = target as Record<string, unknown>;
		if (
			Object.keys(item).some(
				key => key.startsWith("taskArtifactOwner") && key !== "taskArtifactOwnerDeletionEvidence",
			)
		)
			throw new Error(OWNER_CONSUMER_UNAVAILABLE);
		const identity = item.identity;
		if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
		const fields = identity as Record<string, unknown>;
		if (
			typeof item.path !== "string" ||
			typeof item.sessionId !== "string" ||
			typeof item.cwd !== "string" ||
			!pathIsWithin(scope.sessionsRoot, item.path) ||
			(item.provenance !== undefined && item.provenance !== "v2" && item.provenance !== "legacy") ||
			typeof fields.canonicalPath !== "string" ||
			typeof fields.dev !== "string" ||
			typeof fields.ino !== "string" ||
			typeof fields.size !== "number" ||
			typeof fields.mtimeMs !== "number" ||
			typeof fields.mtimeNs !== "string" ||
			typeof fields.sha256 !== "string"
		)
			return undefined;
		const provenance =
			item.provenance === "v2" || item.provenance === "legacy"
				? item.provenance
				: path.dirname(item.path) === scope.directoryPath
					? "v2"
					: "legacy";
		let taskArtifactOwnerDeletionEvidence: TaskArtifactOwnerDeletionEvidence | undefined;
		if (Object.hasOwn(item, "taskArtifactOwnerDeletionEvidence")) {
			try {
				taskArtifactOwnerDeletionEvidence = parseTaskArtifactOwnerDeletionEvidence(
					item.taskArtifactOwnerDeletionEvidence,
				);
				if (taskArtifactOwnerDeletionEvidence.sessionId !== item.sessionId)
					throw new Error("owner_session_mismatch");
			} catch (cause) {
				throw new Error("task_artifact_owner_legacy_scope_unsupported", { cause });
			}
		}
		targets.push({
			...(taskArtifactOwnerDeletionEvidence ? { taskArtifactOwnerDeletionEvidence } : {}),
			path: item.path,
			sessionId: item.sessionId,
			cwd: item.cwd,
			provenance,
			migrationState: provenance === "v2" ? "native_v2" : "legacy_unmigrated",
			identity: {
				canonicalPath: fields.canonicalPath,
				dev: BigInt(fields.dev),
				ino: BigInt(fields.ino),
				size: fields.size,
				mtimeMs: fields.mtimeMs,
				mtimeNs: BigInt(fields.mtimeNs),
				sha256: fields.sha256,
				sessionId: item.sessionId,
			},
		});
	}
	return targets;
}

/**
 * Append-only cleanup state machine:
 * `pending(N)` durably authorizes only its planned quarantine names before detach;
 * a returned partial result appends `pending(N + 1)` with the observed detached
 * identity/path. Restart accepts only a contiguous, target-bound sequence.
 */
type RetainedArtifactsRootReceipt = {
	path: string;
	identity: SessionStorageFileIdentity;
	tree: NativeDirectoryTreeSnapshot;
};

function retainedArtifactsRootReceipt(receipt: CleanupReceipt): RetainedArtifactsRootReceipt | undefined {
	const pathname = receipt.detachedArtifactsPath ?? deterministicRemovalRoot(receipt.plannedArtifactsPath);
	if (!fs.existsSync(pathname)) return undefined;
	if (!isQuarantinePath(receipt.target, pathname) || !receipt.expectedArtifactsIdentity)
		throw new Error("durability_failed");
	const identity = artifactIdentityAt(pathname);
	if (
		!identity ||
		identity.dev !== receipt.expectedArtifactsIdentity.dev ||
		identity.ino !== receipt.expectedArtifactsIdentity.ino
	)
		throw new Error("durability_failed");
	const tree = snapshotArtifactTree(pathname);
	if (!artifactTreePayloadAbsent(tree)) throw new Error("durability_failed");
	return { path: pathname, identity, tree };
}

function retainedArtifactsRootMatches(record: Record<string, unknown>): boolean {
	if (record.retainedArtifactsRoot === undefined) return true;
	if (!record.retainedArtifactsRoot || typeof record.retainedArtifactsRoot !== "object")
		throw new Error("durability_failed");
	const retained = record.retainedArtifactsRoot as Record<string, unknown>;
	const identity = retained.identity;
	const tree = artifactTreeSnapshot(retained.tree);
	const expectedRetainedPath =
		typeof record.detachedArtifactsPath === "string"
			? record.detachedArtifactsPath
			: typeof record.plannedArtifactsPath === "string"
				? deterministicRemovalRoot(record.plannedArtifactsPath)
				: undefined;
	if (
		!expectedRetainedPath ||
		retained.path !== expectedRetainedPath ||
		record.artifactsPayloadDurable !== true ||
		!identity ||
		typeof identity !== "object" ||
		Array.isArray(identity) ||
		!tree ||
		!artifactTreePayloadAbsent(tree)
	)
		throw new Error("durability_failed");
	const artifactIdentity = identity as Record<string, unknown>;
	if (
		typeof artifactIdentity.dev !== "string" ||
		typeof artifactIdentity.ino !== "string" ||
		typeof artifactIdentity.size !== "number" ||
		typeof artifactIdentity.mtimeNs !== "string" ||
		typeof artifactIdentity.sha256 !== "string"
	)
		throw new Error("durability_failed");
	if (!fs.existsSync(retained.path)) return true;
	const observed = artifactIdentityAt(retained.path);
	if (
		!observed ||
		observed.dev !== BigInt(artifactIdentity.dev) ||
		observed.ino !== BigInt(artifactIdentity.ino) ||
		!artifactTreePayloadAbsent(snapshotArtifactTree(retained.path))
	)
		throw new Error("durability_failed");
	return true;
}

type CleanupReceipt = {
	taskArtifactOwnerTranscriptDeleted?: true;
	attempt: number;
	target: RetiredTarget;
	expectedArtifactsIdentity?: SessionStorageFileIdentity;
	expectedArtifactsTree?: NativeDirectoryTreeSnapshot;
	artifactsPayloadDurable?: true;
	artifactsRemovedAttempt?: number;
	detachedArtifactsPath?: string;
	detachedTranscriptPath?: string;
	transcriptPayloadDurable?: true;
	retainedArtifactsSuccessorPath?: string;
	retainedArtifactsPlaceholderPath?: string;
	retainedArtifactsUnknownPath?: string;
	retainedTranscriptSuccessorPath?: string;
	retainedTranscriptPlaceholderPath?: string;
	retainedTranscriptUnknownPath?: string;

	plannedArtifactsPath: string;
	plannedTranscriptPath: string;
};

function cleanupReceiptPath(
	tombstone: string,
	target: RetiredTarget,
	state: "pending" | "artifacts_removed" | "completed",
	attempt: number,
): string {
	return path.join(
		path.dirname(tombstone),
		`${path.basename(tombstone, ".json")}.${stableOperationName(target)}.cleanup-${state}-${attempt}.json`,
	);
}

function cleanupReceipt(scope: ManagedScope, tombstone: string, receipt: CleanupReceipt): Record<string, unknown> {
	return {
		schemaVersion: 2,
		state: "cleanup_pending",
		scope: scopeDigest(scope.platform, scope.canonicalCwd),
		tombstone,
		attempt: receipt.attempt,
		target: {
			path: receipt.target.path,
			sessionId: receipt.target.sessionId,
			cwd: receipt.target.cwd,
			identity: receipt.target.identity,
		},
		...(receipt.expectedArtifactsIdentity ? { expectedArtifactsIdentity: receipt.expectedArtifactsIdentity } : {}),
		...(receipt.expectedArtifactsTree ? { expectedArtifactsTree: receipt.expectedArtifactsTree } : {}),
		...(receipt.artifactsPayloadDurable === true ? { artifactsPayloadDurable: true } : {}),
		...(receipt.artifactsRemovedAttempt !== undefined
			? { artifactsRemovedAttempt: receipt.artifactsRemovedAttempt }
			: {}),
		...(receipt.detachedArtifactsPath ? { detachedArtifactsPath: receipt.detachedArtifactsPath } : {}),
		...(receipt.detachedTranscriptPath ? { detachedTranscriptPath: receipt.detachedTranscriptPath } : {}),
		...(receipt.transcriptPayloadDurable === true ? { transcriptPayloadDurable: true } : {}),
		...(receipt.retainedArtifactsSuccessorPath
			? { retainedArtifactsSuccessorPath: receipt.retainedArtifactsSuccessorPath }
			: {}),
		...(receipt.retainedArtifactsPlaceholderPath
			? { retainedArtifactsPlaceholderPath: receipt.retainedArtifactsPlaceholderPath }
			: {}),
		...(receipt.retainedArtifactsUnknownPath
			? { retainedArtifactsUnknownPath: receipt.retainedArtifactsUnknownPath }
			: {}),
		...(receipt.retainedTranscriptSuccessorPath
			? { retainedTranscriptSuccessorPath: receipt.retainedTranscriptSuccessorPath }
			: {}),
		...(receipt.retainedTranscriptPlaceholderPath
			? { retainedTranscriptPlaceholderPath: receipt.retainedTranscriptPlaceholderPath }
			: {}),
		...(receipt.retainedTranscriptUnknownPath
			? { retainedTranscriptUnknownPath: receipt.retainedTranscriptUnknownPath }
			: {}),
		plannedArtifactsPath: receipt.plannedArtifactsPath,
		plannedTranscriptPath: receipt.plannedTranscriptPath,
	};
}

type CleanupArtifactsRemovedEvidence = { retainedArtifactsRootPath?: string };

function cleanupArtifactsRemovedEvidence(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	attempt: number,
): CleanupArtifactsRemovedEvidence | undefined {
	try {
		const value: unknown = JSON.parse(
			captureManagedFileNoFollow(cleanupReceiptPath(tombstone, target, "artifacts_removed", attempt)).bytes.toString(
				"utf8",
			),
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		const recorded = record.target as Record<string, unknown> | undefined;
		const identity = recorded?.identity as Record<string, unknown> | undefined;
		if (
			record.schemaVersion !== 2 ||
			record.state !== "artifacts_removed" ||
			record.scope !== scopeDigest(scope.platform, scope.canonicalCwd) ||
			record.tombstone !== tombstone ||
			record.attempt !== attempt ||
			recorded?.path !== target.path ||
			recorded.sessionId !== target.sessionId ||
			recorded.cwd !== target.cwd ||
			identity?.canonicalPath !== target.identity.canonicalPath ||
			identity.dev !== String(target.identity.dev) ||
			identity.ino !== String(target.identity.ino) ||
			identity.size !== target.identity.size ||
			identity.mtimeNs !== String(target.identity.mtimeNs) ||
			identity.sha256 !== target.identity.sha256 ||
			!retainedArtifactsRootMatches(record)
		)
			return undefined;
		const retained = record.retainedArtifactsRoot as Record<string, unknown> | undefined;
		return { retainedArtifactsRootPath: typeof retained?.path === "string" ? retained.path : undefined };
	} catch (error) {
		if ((error as Error).message === "durability_failed") throw error;
		return undefined;
	}
}

function cleanupArtifactsRemovedReceipt(
	tombstone: string,
	target: RetiredTarget,
	attempt: number,
): RetainedArtifactsRootReceipt | undefined {
	const receiptPath = cleanupReceiptPath(tombstone, target, "artifacts_removed", attempt);
	if (!fs.existsSync(receiptPath)) return undefined;
	const record = JSON.parse(captureManagedFileNoFollow(receiptPath).bytes.toString("utf8")) as Record<string, unknown>;
	if (!retainedArtifactsRootMatches(record)) return undefined;
	const retained = record.retainedArtifactsRoot as Record<string, unknown> | undefined;
	const identity = retained?.identity;
	const tree = artifactTreeSnapshot(retained?.tree);
	if (
		!retained ||
		typeof retained.path !== "string" ||
		!identity ||
		typeof identity !== "object" ||
		Array.isArray(identity) ||
		!tree
	)
		return undefined;
	const typed = identity as Record<string, unknown>;
	if (
		typeof typed.dev !== "string" ||
		typeof typed.ino !== "string" ||
		typeof typed.size !== "number" ||
		typeof typed.mtimeNs !== "string" ||
		typeof typed.sha256 !== "string"
	)
		return undefined;
	return {
		path: retained.path,
		identity: {
			dev: BigInt(typed.dev),
			ino: BigInt(typed.ino),
			size: typed.size,
			mtimeNs: BigInt(typed.mtimeNs),
			sha256: typed.sha256,
		},
		tree,
	};
}

function cleanupArtifactsRemoved(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	attempt: number,
): boolean {
	return cleanupArtifactsRemovedEvidence(scope, tombstone, target, attempt) !== undefined;
}

async function publishCleanupArtifactsRemoved(
	scope: ManagedScope,
	tombstone: string,
	receipt: CleanupReceipt,
	lock: ManagedStorageLock,
): Promise<void> {
	const retainedArtifactsRoot = retainedArtifactsRootReceipt(receipt);
	await publishManagedTombstone(
		cleanupReceiptPath(tombstone, receipt.target, "artifacts_removed", receipt.attempt),
		{
			...cleanupReceipt(scope, tombstone, receipt),
			state: "artifacts_removed",
			...(retainedArtifactsRoot ? { retainedArtifactsRoot } : {}),
		},
		lock.assertOwned,
	).catch(error => {
		if ((error as Error).message !== "destination_conflict") throw error;
	});
	if (!cleanupArtifactsRemoved(scope, tombstone, receipt.target, receipt.attempt))
		throw new Error("durability_failed");
}

function isQuarantinePath(target: RetiredTarget, pathname: unknown): pathname is string {
	return (
		typeof pathname === "string" &&
		path.dirname(pathname) === path.dirname(target.path) &&
		path.basename(pathname).startsWith(".gjc-delete-")
	);
}

function isRetainedNativePath(target: RetiredTarget, pathname: unknown): pathname is string {
	return (
		typeof pathname === "string" &&
		path.dirname(pathname) === path.dirname(target.path) &&
		path.basename(pathname).startsWith(".gjc-")
	);
}

function deterministicRemovalRoot(plannedRoot: string): string {
	return `${plannedRoot}.removing`;
}

function isAuthorizedArtifactRoot(target: RetiredTarget, plannedRoot: string, pathname: unknown): pathname is string {
	return (
		isQuarantinePath(target, pathname) &&
		(pathname === plannedRoot || pathname === deterministicRemovalRoot(plannedRoot))
	);
}

function assertAuthorizedCleanupPending(
	target: RetiredTarget,
	active: CleanupReceipt,
	deletion: Extract<VerifiedSessionDeleteResult, { kind: "cleanup_pending" }>,
): void {
	if (
		(deletion.phase === "artifacts" &&
			!isAuthorizedArtifactRoot(
				target,
				active.detachedArtifactsPath ?? active.plannedArtifactsPath,
				deletion.detachedArtifactsPath,
			)) ||
		(deletion.phase === "transcript" && deletion.detachedTranscriptPath !== active.plannedTranscriptPath)
	)
		throw new Error("durability_failed");
}

function transcriptRootMatchesTarget(pathname: string, target: RetiredTarget): boolean {
	try {
		const observed = captureManagedFileNoFollow(pathname);
		const digest = createHash("sha256").update(observed.bytes).digest("hex");
		return (
			observed.identity.dev === target.identity.dev &&
			observed.identity.ino === target.identity.ino &&
			observed.identity.size === target.identity.size &&
			observed.identity.mtimeNs === target.identity.mtimeNs &&
			digest === target.identity.sha256
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error("durability_failed");
	}
}

function reconcileScrubbedTranscriptPlaceholder(pathname: string): boolean {
	try {
		const stat = fs.lstatSync(pathname);
		return !stat.isSymbolicLink() && stat.isFile() && stat.size === 0 && stat.nlink === 1;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function managedPathPresentNoFollow(pathname: string): boolean {
	try {
		fs.lstatSync(pathname);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error("durability_failed");
	}
}

function isScrubbedTranscriptPlaceholder(pathname: string): boolean {
	try {
		const stat = fs.lstatSync(pathname);
		if (stat.isSymbolicLink()) return false;
		return (
			(stat.isFile() && stat.size === 0 && stat.nlink === 1) ||
			(stat.isDirectory() && fs.readdirSync(pathname).length === 0)
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error("durability_failed");
	}
}

function cleanupRootsAbsent(
	tombstone: string,
	target: RetiredTarget,
	pending: CleanupReceipt,
	allowedRetainedArtifactsRoot?: string,
): boolean {
	const prefix = `${path.basename(tombstone, ".json")}.${stableOperationName(target)}.cleanup-pending-`;
	const activeTranscriptRoots = new Set(
		[pending.plannedTranscriptPath, pending.detachedTranscriptPath].filter((pathname): pathname is string =>
			isQuarantinePath(target, pathname),
		),
	);
	const roots = new Set<string>([
		target.path,
		target.path.slice(0, -6),
		pending.plannedArtifactsPath,
		deterministicRemovalRoot(pending.plannedArtifactsPath),
		...(pending.detachedArtifactsPath ? [pending.detachedArtifactsPath] : []),
		...[
			pending.retainedArtifactsSuccessorPath,
			pending.retainedArtifactsPlaceholderPath,
			pending.retainedArtifactsUnknownPath,
			pending.retainedTranscriptSuccessorPath,
			pending.retainedTranscriptPlaceholderPath,
			pending.retainedTranscriptUnknownPath,
		].filter((pathname): pathname is string => isRetainedNativePath(target, pathname)),
	]);
	for (const name of fs.readdirSync(path.dirname(tombstone))) {
		if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
		const record = JSON.parse(
			captureManagedFileNoFollow(path.join(path.dirname(tombstone), name)).bytes.toString("utf8"),
		) as {
			plannedArtifactsPath?: unknown;
			detachedArtifactsPath?: unknown;
			plannedTranscriptPath?: unknown;
			detachedTranscriptPath?: unknown;
			retainedArtifactsSuccessorPath?: unknown;
			retainedArtifactsPlaceholderPath?: unknown;
			retainedArtifactsUnknownPath?: unknown;
			retainedTranscriptSuccessorPath?: unknown;
			retainedTranscriptPlaceholderPath?: unknown;
			retainedTranscriptUnknownPath?: unknown;
			transcriptPayloadDurable?: unknown;
		};
		if (isQuarantinePath(target, record.plannedArtifactsPath)) {
			roots.add(record.plannedArtifactsPath);
			roots.add(deterministicRemovalRoot(record.plannedArtifactsPath));
		}
		if (isQuarantinePath(target, record.detachedArtifactsPath)) roots.add(record.detachedArtifactsPath);
		const historicalTranscriptDurable = record.transcriptPayloadDurable === true;
		for (const pathname of [record.plannedTranscriptPath, record.detachedTranscriptPath]) {
			if (!isQuarantinePath(target, pathname) || activeTranscriptRoots.has(pathname)) continue;
			if (historicalTranscriptDurable || pending.transcriptPayloadDurable === true) {
				if (!reconcileScrubbedTranscriptPlaceholder(pathname)) return false;
				roots.delete(pathname);
			} else roots.add(pathname);
		}
		for (const pathname of [record.retainedArtifactsSuccessorPath, record.retainedArtifactsUnknownPath]) {
			if (isRetainedNativePath(target, pathname)) roots.add(pathname);
		}
		if (isRetainedNativePath(target, record.retainedArtifactsPlaceholderPath)) {
			if (!reconcileScrubbedTranscriptPlaceholder(record.retainedArtifactsPlaceholderPath))
				roots.add(record.retainedArtifactsPlaceholderPath);
		}
		for (const pathname of [record.retainedTranscriptSuccessorPath, record.retainedTranscriptUnknownPath]) {
			if (isRetainedNativePath(target, pathname)) roots.add(pathname);
		}
		if (isRetainedNativePath(target, record.retainedTranscriptPlaceholderPath)) {
			if (historicalTranscriptDurable) {
				if (!reconcileScrubbedTranscriptPlaceholder(record.retainedTranscriptPlaceholderPath)) return false;
				roots.delete(record.retainedTranscriptPlaceholderPath);
			} else roots.add(record.retainedTranscriptPlaceholderPath);
		}
	}
	for (const blocker of [pending.retainedArtifactsSuccessorPath, pending.retainedArtifactsUnknownPath]) {
		if (!blocker) continue;
		try {
			fs.lstatSync(blocker);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (pending.retainedArtifactsPlaceholderPath) {
		if (!reconcileScrubbedTranscriptPlaceholder(pending.retainedArtifactsPlaceholderPath)) return false;
		roots.delete(pending.retainedArtifactsPlaceholderPath);
	}
	if (pending.transcriptPayloadDurable === true) {
		for (const blocker of [pending.retainedTranscriptSuccessorPath, pending.retainedTranscriptUnknownPath]) {
			if (!blocker) continue;
			try {
				fs.lstatSync(blocker);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		for (const placeholder of [
			target.path,
			pending.plannedTranscriptPath,
			pending.detachedTranscriptPath,
			pending.retainedTranscriptPlaceholderPath,
		].filter((pathname): pathname is string => typeof pathname === "string")) {
			if (!reconcileScrubbedTranscriptPlaceholder(placeholder)) return false;
			roots.delete(placeholder);
			activeTranscriptRoots.delete(placeholder);
		}
	}
	if (allowedRetainedArtifactsRoot) {
		if (
			pending.detachedArtifactsPath !== allowedRetainedArtifactsRoot ||
			!retainedArtifactPayloadAbsent(allowedRetainedArtifactsRoot)
		)
			return false;
		assertRetainedArtifactsAuthority(pending);
		roots.delete(allowedRetainedArtifactsRoot);
	}
	for (const pathname of roots) {
		try {
			fs.lstatSync(pathname);
			throw new Error("durability_failed");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
	for (const pathname of activeTranscriptRoots) {
		try {
			fs.lstatSync(pathname);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!transcriptRootMatchesTarget(pathname, target)) throw new Error("durability_failed");
		return false;
	}
	if (allowedRetainedArtifactsRoot) {
		assertRetainedArtifactsAuthority(pending);
		if (!retainedArtifactPayloadAbsent(allowedRetainedArtifactsRoot)) return false;
	}
	return true;
}

function sameArtifactRootIdentity(left: SessionStorageFileIdentity, right: SessionStorageFileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

type ManagedArtifactTreeEntry = NativeDirectoryTreeSnapshot["entries"][number];

function artifactTreeQuarantineName(entry: ManagedArtifactTreeEntry): string {
	const material = Buffer.concat([
		Buffer.from(entry.relativePath),
		Buffer.from([0]),
		Buffer.from(entry.dev),
		Buffer.from([0]),
		Buffer.from(entry.ino),
	]);
	return `.pi-tree-detached-${createHash("sha256").update(material).digest("hex")}`;
}

function artifactTreeReplayPathCompatible(
	observedPath: string,
	expectedPath: string,
	expectedByPath: ReadonlyMap<string, ManagedArtifactTreeEntry>,
): boolean {
	if (expectedPath === "") return observedPath === "";
	const observedParts = observedPath.split("/");
	const expectedParts = expectedPath.split("/");
	if (observedParts.length !== expectedParts.length) return false;
	for (let index = 0; index < expectedParts.length; index += 1) {
		const logicalPath = expectedParts.slice(0, index + 1).join("/");
		const logicalEntry = expectedByPath.get(logicalPath);
		if (!logicalEntry) return false;
		const observedPart = observedParts[index];
		if (observedPart !== expectedParts[index] && observedPart !== artifactTreeQuarantineName(logicalEntry))
			return false;
	}
	return true;
}

export function artifactTreeReplayCompatible(
	observed: NativeDirectoryTreeSnapshot,
	expected: NativeDirectoryTreeSnapshot,
): boolean {
	if (observed.rootDev !== expected.rootDev || observed.rootIno !== expected.rootIno) return false;
	const emptyDigest = createHash("sha256").update("").digest("hex");
	const expectedByIdentity = new Map(
		expected.entries.map(entry => [JSON.stringify([entry.kind, entry.dev, entry.ino]), entry] as const),
	);
	const expectedByPath = new Map(expected.entries.map(entry => [entry.relativePath, entry] as const));
	const seen = new Set<string>();
	let rootObserved = false;
	const compatible = observed.entries.every(entry => {
		const key = JSON.stringify([entry.kind, entry.dev, entry.ino]);
		if (seen.has(key)) return false;
		seen.add(key);
		const original = expectedByIdentity.get(key);
		if (!original || !artifactTreeReplayPathCompatible(entry.relativePath, original.relativePath, expectedByPath))
			return false;
		if (entry.relativePath === "" && entry.kind === "directory") rootObserved = true;
		if (entry.kind === "directory") return true;
		return (
			(entry.size === original.size && entry.mtimeNs === original.mtimeNs && entry.sha256 === original.sha256) ||
			(entry.size === "0" && entry.sha256 === emptyDigest)
		);
	});
	return compatible && rootObserved;
}

function artifactTreePayloadAbsent(snapshot: NativeDirectoryTreeSnapshot): boolean {
	const emptyDigest = createHash("sha256").update("").digest("hex");
	return snapshot.entries.every(
		entry =>
			entry.kind === "directory" || (entry.kind === "file" && entry.size === "0" && entry.sha256 === emptyDigest),
	);
}

function assertRetainedArtifactsAuthority(pending: CleanupReceipt): void {
	if (!pending.detachedArtifactsPath) return;
	if (!pending.expectedArtifactsIdentity || !pending.expectedArtifactsTree) throw new Error("durability_failed");
	try {
		fs.lstatSync(pending.detachedArtifactsPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new Error("durability_failed");
	}
	const observed = artifactIdentityAt(pending.detachedArtifactsPath);
	const observedTree = snapshotArtifactTree(pending.detachedArtifactsPath);
	if (
		!observed ||
		(pending.artifactsPayloadDurable === true
			? observed.dev !== pending.expectedArtifactsIdentity.dev ||
				observed.ino !== pending.expectedArtifactsIdentity.ino ||
				!artifactTreePayloadAbsent(observedTree)
			: !sameArtifactRootIdentity(observed, pending.expectedArtifactsIdentity) ||
				!artifactTreeReplayCompatible(observedTree, pending.expectedArtifactsTree))
	)
		throw new Error("binding_invalid");
}

function probePlannedCleanupDetach(target: RetiredTarget, pending: CleanupReceipt): CleanupReceipt {
	assertRetainedArtifactsAuthority(pending);

	let detachedArtifactsPath = pending.detachedArtifactsPath;
	let detachedTranscriptPath = pending.detachedTranscriptPath;
	const detachedCandidates = new Set<string>([
		pending.plannedArtifactsPath,
		deterministicRemovalRoot(pending.plannedArtifactsPath),
		...(pending.detachedArtifactsPath ? [deterministicRemovalRoot(pending.detachedArtifactsPath)] : []),
	]);
	for (const pathname of detachedCandidates) {
		if (!fs.existsSync(pathname)) continue;
		if (!pending.expectedArtifactsIdentity || !pending.expectedArtifactsTree) throw new Error("durability_failed");
		const observed = artifactIdentityAt(pathname);
		const observedTree = snapshotArtifactTree(pathname);
		if (
			!observed ||
			(pending.artifactsPayloadDurable === true
				? observed.dev !== pending.expectedArtifactsIdentity.dev ||
					observed.ino !== pending.expectedArtifactsIdentity.ino ||
					!artifactTreePayloadAbsent(observedTree)
				: !sameArtifactRootIdentity(observed, pending.expectedArtifactsIdentity) ||
					!artifactTreeReplayCompatible(observedTree, pending.expectedArtifactsTree))
		)
			throw new Error("durability_failed");
		if (detachedArtifactsPath && detachedArtifactsPath !== pathname && fs.existsSync(detachedArtifactsPath))
			throw new Error("durability_failed");
		detachedArtifactsPath = pathname;
	}
	if (pending.transcriptPayloadDurable === true) {
		for (const blocker of [pending.retainedTranscriptSuccessorPath, pending.retainedTranscriptUnknownPath]) {
			if (!blocker) continue;
			try {
				fs.lstatSync(blocker);
				throw new Error("durability_failed");
			} catch (error) {
				if ((error as Error).message === "durability_failed") throw error;
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("durability_failed");
			}
		}
		for (const placeholder of [
			target.path,
			pending.plannedTranscriptPath,
			pending.detachedTranscriptPath,
			pending.retainedTranscriptPlaceholderPath,
		].filter((pathname): pathname is string => typeof pathname === "string"))
			if (!reconcileScrubbedTranscriptPlaceholder(placeholder)) throw new Error("durability_failed");
		return { ...pending, detachedArtifactsPath, detachedTranscriptPath: undefined };
	}
	const retainedBlockers = [pending.retainedTranscriptSuccessorPath, pending.retainedTranscriptUnknownPath].filter(
		(pathname): pathname is string => typeof pathname === "string" && managedPathPresentNoFollow(pathname),
	);
	if (retainedBlockers.length > 0) throw new Error("durability_failed");
	const transcriptCandidates = [
		target.path,
		pending.plannedTranscriptPath,
		pending.detachedTranscriptPath,
		pending.retainedTranscriptPlaceholderPath,
	].filter(
		(pathname, index, values): pathname is string =>
			typeof pathname === "string" && managedPathPresentNoFollow(pathname) && values.indexOf(pathname) === index,
	);
	const boundCandidates = transcriptCandidates.filter(pathname => transcriptRootMatchesTarget(pathname, target));
	if (boundCandidates.length > 1) throw new Error("durability_failed");
	if (boundCandidates.length === 1) {
		detachedTranscriptPath = boundCandidates[0] === target.path ? undefined : boundCandidates[0];
	} else if (transcriptCandidates.length > 0) {
		if (!transcriptCandidates.every(isScrubbedTranscriptPlaceholder)) throw new Error("durability_failed");
		for (const pathname of transcriptCandidates)
			if (!reconcileScrubbedTranscriptPlaceholder(pathname)) throw new Error("durability_failed");
		return {
			...pending,
			detachedArtifactsPath,
			detachedTranscriptPath: undefined,
			transcriptPayloadDurable: true,
		};
	}
	return { ...pending, detachedArtifactsPath, detachedTranscriptPath };
}

function artifactIdentityAt(pathname: string): SessionStorageFileIdentity | undefined {
	try {
		const stat = fs.lstatSync(pathname, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
		return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, sha256: "" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function artifactTreeSnapshot(value: unknown): NativeDirectoryTreeSnapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const snapshot = value as Record<string, unknown>;
	if (typeof snapshot.rootDev !== "string" || typeof snapshot.rootIno !== "string" || !Array.isArray(snapshot.entries))
		return undefined;
	if (
		snapshot.entries.length === 0 ||
		!snapshot.entries.every(entry => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
			const item = entry as Record<string, unknown>;
			return (
				typeof item.relativePath === "string" &&
				!path.isAbsolute(item.relativePath) &&
				!item.relativePath.split(/[\\/]/).includes("..") &&
				(item.kind === "file" || item.kind === "directory") &&
				typeof item.dev === "string" &&
				typeof item.ino === "string" &&
				typeof item.size === "string" &&
				typeof item.mtimeNs === "string" &&
				typeof item.ctimeNs === "string" &&
				(item.sha256 === undefined || typeof item.sha256 === "string")
			);
		})
	)
		return undefined;
	const roots = snapshot.entries.filter(entry => {
		const item = entry as Record<string, unknown>;
		return (
			item.relativePath === "" &&
			item.kind === "directory" &&
			item.dev === snapshot.rootDev &&
			item.ino === snapshot.rootIno
		);
	});
	if (roots.length !== 1) return undefined;
	return snapshot as unknown as NativeDirectoryTreeSnapshot;
}

function pendingCleanupReceipt(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
): CleanupReceipt | undefined {
	try {
		const prefix = `${path.basename(tombstone, ".json")}.${stableOperationName(target)}.cleanup-pending-`;
		const records = fs
			.readdirSync(path.dirname(tombstone))
			.filter(name => name.startsWith(prefix) && name.endsWith(".json"))
			.map(
				name =>
					JSON.parse(
						captureManagedFileNoFollow(path.join(path.dirname(tombstone), name)).bytes.toString("utf8"),
					) as unknown,
			)
			.filter(
				(value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
			)
			.sort((left, right) => Number(left.attempt) - Number(right.attempt));
		let latest: CleanupReceipt | undefined;
		const plannedPaths = new Set<string>();
		for (const record of records)
			latest = parseCleanupReceiptRecord(scope, tombstone, target, record, latest, plannedPaths);
		return latest;
	} catch (error) {
		if ((error as Error).message === "durability_failed" || isOwnerBoundaryFailure(error)) throw error;
		return undefined;
	}
}

function parseCleanupReceiptRecord(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	record: Record<string, unknown>,
	latest: CleanupReceipt | undefined,
	plannedPaths: Set<string>,
): CleanupReceipt {
	if (
		Object.keys(record).some(
			key => key.startsWith("taskArtifactOwner") && key !== "taskArtifactOwnerTranscriptDeleted",
		)
	)
		throw new Error(OWNER_CONSUMER_UNAVAILABLE);
	const attempt = record.attempt;
	const recorded = record.target as Record<string, unknown> | undefined;
	const identity = recorded?.identity as Record<string, unknown> | undefined;
	if (
		record.schemaVersion !== 2 ||
		record.state !== "cleanup_pending" ||
		record.scope !== scopeDigest(scope.platform, scope.canonicalCwd) ||
		record.tombstone !== tombstone ||
		typeof attempt !== "number" ||
		!Number.isSafeInteger(attempt) ||
		attempt !== (latest?.attempt ?? 0) + 1 ||
		recorded?.path !== target.path ||
		recorded.sessionId !== target.sessionId ||
		recorded.cwd !== target.cwd ||
		identity?.dev !== String(target.identity.dev) ||
		identity.ino !== String(target.identity.ino) ||
		identity.size !== target.identity.size ||
		identity.mtimeNs !== String(target.identity.mtimeNs) ||
		identity.sha256 !== target.identity.sha256 ||
		!isQuarantinePath(target, record.plannedArtifactsPath) ||
		!isQuarantinePath(target, record.plannedTranscriptPath) ||
		record.plannedArtifactsPath === record.plannedTranscriptPath ||
		plannedPaths.has(record.plannedArtifactsPath as string) ||
		plannedPaths.has(record.plannedTranscriptPath as string) ||
		(record.detachedArtifactsPath !== undefined && !isQuarantinePath(target, record.detachedArtifactsPath)) ||
		(record.detachedTranscriptPath !== undefined && !isQuarantinePath(target, record.detachedTranscriptPath)) ||
		(record.retainedArtifactsSuccessorPath !== undefined &&
			!isRetainedNativePath(target, record.retainedArtifactsSuccessorPath)) ||
		(record.retainedArtifactsPlaceholderPath !== undefined &&
			!isRetainedNativePath(target, record.retainedArtifactsPlaceholderPath)) ||
		(record.retainedArtifactsUnknownPath !== undefined &&
			!isRetainedNativePath(target, record.retainedArtifactsUnknownPath)) ||
		(record.retainedTranscriptSuccessorPath !== undefined &&
			!isRetainedNativePath(target, record.retainedTranscriptSuccessorPath)) ||
		(record.retainedTranscriptPlaceholderPath !== undefined &&
			!isRetainedNativePath(target, record.retainedTranscriptPlaceholderPath)) ||
		(record.retainedTranscriptUnknownPath !== undefined &&
			!isRetainedNativePath(target, record.retainedTranscriptUnknownPath)) ||
		(record.artifactsPayloadDurable !== undefined && record.artifactsPayloadDurable !== true) ||
		(record.artifactsRemovedAttempt !== undefined &&
			(typeof record.artifactsRemovedAttempt !== "number" ||
				!Number.isSafeInteger(record.artifactsRemovedAttempt) ||
				record.artifactsRemovedAttempt < 1 ||
				record.artifactsRemovedAttempt > (attempt as number))) ||
		(record.transcriptPayloadDurable !== undefined && record.transcriptPayloadDurable !== true) ||
		(record.taskArtifactOwnerTranscriptDeleted !== undefined &&
			(record.taskArtifactOwnerTranscriptDeleted !== true || !target.taskArtifactOwnerDeletionEvidence))
	)
		throw new Error("durability_failed");
	const artifact = record.expectedArtifactsIdentity as Record<string, unknown> | undefined;
	const expectedArtifactsIdentity = artifact
		? typeof artifact.dev === "string" &&
			typeof artifact.ino === "string" &&
			typeof artifact.size === "number" &&
			typeof artifact.mtimeNs === "string" &&
			typeof artifact.sha256 === "string"
			? {
					dev: BigInt(artifact.dev),
					ino: BigInt(artifact.ino),
					size: artifact.size,
					mtimeNs: BigInt(artifact.mtimeNs),
					sha256: artifact.sha256,
				}
			: undefined
		: undefined;
	if (artifact && !expectedArtifactsIdentity) throw new Error("durability_failed");
	const expectedArtifactsTree =
		record.expectedArtifactsTree === undefined ? undefined : artifactTreeSnapshot(record.expectedArtifactsTree);
	if (record.expectedArtifactsTree !== undefined && !expectedArtifactsTree) throw new Error("durability_failed");

	if (
		latest &&
		((record.detachedArtifactsPath !== undefined &&
			![...plannedPaths].some(planned => isAuthorizedArtifactRoot(target, planned, record.detachedArtifactsPath))) ||
			(record.detachedTranscriptPath !== undefined && !plannedPaths.has(record.detachedTranscriptPath)))
	)
		throw new Error("durability_failed");
	plannedPaths.add(record.plannedArtifactsPath as string);
	plannedPaths.add(record.plannedTranscriptPath as string);
	return {
		taskArtifactOwnerTranscriptDeleted: record.taskArtifactOwnerTranscriptDeleted === true ? true : undefined,
		attempt,
		target,
		expectedArtifactsIdentity,
		expectedArtifactsTree,
		artifactsPayloadDurable: record.artifactsPayloadDurable === true ? true : undefined,
		artifactsRemovedAttempt: record.artifactsRemovedAttempt as number | undefined,
		detachedArtifactsPath: record.detachedArtifactsPath as string | undefined,
		detachedTranscriptPath: record.detachedTranscriptPath as string | undefined,
		transcriptPayloadDurable: record.transcriptPayloadDurable === true ? true : undefined,
		retainedArtifactsSuccessorPath: record.retainedArtifactsSuccessorPath as string | undefined,
		retainedArtifactsPlaceholderPath: record.retainedArtifactsPlaceholderPath as string | undefined,
		retainedArtifactsUnknownPath: record.retainedArtifactsUnknownPath as string | undefined,
		retainedTranscriptSuccessorPath: record.retainedTranscriptSuccessorPath as string | undefined,
		retainedTranscriptPlaceholderPath: record.retainedTranscriptPlaceholderPath as string | undefined,
		retainedTranscriptUnknownPath: record.retainedTranscriptUnknownPath as string | undefined,
		plannedArtifactsPath: record.plannedArtifactsPath as string,
		plannedTranscriptPath: record.plannedTranscriptPath as string,
	};
}

function artifactIdentityForCleanup(target: RetiredTarget): SessionStorageFileIdentity | undefined {
	try {
		const stat = fs.lstatSync(target.path.slice(0, -6), { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe_artifacts");
		return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, sha256: "" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function snapshotArtifactTree(pathname: string): NativeDirectoryTreeSnapshot {
	validateManagedArtifactTree(pathname);
	const result = nativeScope().snapshotDirectoryTree(pathname);
	if (!result.ok || !result.snapshot) throw new Error(result.ok ? "unsafe_artifacts" : result.code);
	return result.snapshot;
}

function retainedArtifactPayloadAbsent(pathname: string): boolean {
	try {
		return artifactTreePayloadAbsent(snapshotArtifactTree(pathname));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

function nextCleanupReceipt(target: RetiredTarget, pending: CleanupReceipt | undefined): CleanupReceipt {
	const attempt = (pending?.attempt ?? 0) + 1;
	const directory = path.dirname(target.path);
	const operation = stableOperationName(target);
	const expectedArtifactsIdentity = pending?.expectedArtifactsIdentity ?? artifactIdentityForCleanup(target);
	const expectedArtifactsTree =
		pending?.expectedArtifactsTree ??
		(expectedArtifactsIdentity ? snapshotArtifactTree(target.path.slice(0, -6)) : undefined);
	if (pending?.expectedArtifactsIdentity && !expectedArtifactsTree) throw new Error("durability_failed");
	return {
		attempt,
		target,
		expectedArtifactsIdentity,
		expectedArtifactsTree,
		artifactsPayloadDurable: pending?.artifactsPayloadDurable,
		artifactsRemovedAttempt: pending?.artifactsRemovedAttempt,
		detachedArtifactsPath: pending?.detachedArtifactsPath,
		retainedArtifactsSuccessorPath: pending?.retainedArtifactsSuccessorPath,
		retainedArtifactsPlaceholderPath: pending?.retainedArtifactsPlaceholderPath,
		retainedArtifactsUnknownPath: pending?.retainedArtifactsUnknownPath,
		detachedTranscriptPath: pending?.detachedTranscriptPath,
		transcriptPayloadDurable: pending?.transcriptPayloadDurable,
		retainedTranscriptSuccessorPath: pending?.retainedTranscriptSuccessorPath,
		retainedTranscriptPlaceholderPath: pending?.retainedTranscriptPlaceholderPath,
		retainedTranscriptUnknownPath: pending?.retainedTranscriptUnknownPath,
		plannedArtifactsPath: path.join(directory, `.gjc-delete-${operation}-artifacts-${attempt}`),
		plannedTranscriptPath: path.join(directory, `.gjc-delete-${operation}-transcript-${attempt}`),
	};
}

function requiresFreshCleanupPlan(pending: CleanupReceipt): boolean {
	return (
		(pending.detachedArtifactsPath !== undefined && pending.detachedArtifactsPath === pending.plannedArtifactsPath) ||
		(pending.detachedTranscriptPath !== undefined && pending.detachedTranscriptPath === pending.plannedTranscriptPath)
	);
}

/** Evidence-carrier for a verified `cleanup_pending` deletion, bound to the active plan. */
function cleanupPendingEvidence(
	retry: CleanupReceipt,
	active: CleanupReceipt,
	deletion: Extract<VerifiedSessionDeleteResult, { kind: "cleanup_pending" }>,
): CleanupReceipt {
	return {
		...retry,
		expectedArtifactsIdentity:
			deletion.phase === "artifacts" ? deletion.artifactsIdentity : active.expectedArtifactsIdentity,
		expectedArtifactsTree: deletion.phase === "artifacts" ? deletion.artifactsTree : active.expectedArtifactsTree,
		artifactsPayloadDurable:
			deletion.phase === "artifacts"
				? deletion.artifactsPayloadDurable
					? true
					: undefined
				: active.artifactsPayloadDurable,
		detachedArtifactsPath:
			deletion.phase === "artifacts" ? deletion.detachedArtifactsPath : active.detachedArtifactsPath,
		detachedTranscriptPath:
			deletion.phase === "transcript" ? deletion.detachedTranscriptPath : active.detachedTranscriptPath,
		transcriptPayloadDurable:
			deletion.phase === "transcript"
				? deletion.transcriptPayloadDurable
					? true
					: undefined
				: active.transcriptPayloadDurable,
		retainedArtifactsSuccessorPath:
			deletion.phase === "artifacts" ? deletion.retainedSuccessorPath : active.retainedArtifactsSuccessorPath,
		retainedArtifactsPlaceholderPath:
			deletion.phase === "artifacts" ? deletion.retainedPlaceholderPath : active.retainedArtifactsPlaceholderPath,
		retainedArtifactsUnknownPath:
			deletion.phase === "artifacts" ? deletion.retainedUnknownPath : active.retainedArtifactsUnknownPath,
		retainedTranscriptSuccessorPath:
			deletion.phase === "transcript" ? deletion.retainedSuccessorPath : active.retainedTranscriptSuccessorPath,
		retainedTranscriptPlaceholderPath:
			deletion.phase === "transcript" ? deletion.retainedPlaceholderPath : active.retainedTranscriptPlaceholderPath,
		retainedTranscriptUnknownPath:
			deletion.phase === "transcript" ? deletion.retainedUnknownPath : active.retainedTranscriptUnknownPath,
	};
}

async function continueDetachedArtifactCleanup(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	pendingEvidence: CleanupReceipt,
	fallbackDetachedTranscriptPath: string | undefined,
	lock: ManagedStorageLock,
	flow: ManagedVerifiedDeleteTestEvent["flow"],
): Promise<{ deletion: VerifiedSessionDeleteResult; pendingEvidence: CleanupReceipt }> {
	const deletion = await deleteSessionVerifiedWithFence(flow, "artifact-finalization", lock, {
		sessionsRoot: scope.sessionsRoot,
		transcriptPath: target.path,
		sessionId: target.sessionId,
		cwd: target.cwd,
		transcriptIdentity: target.identity,
		transcriptParentIdentity: (() => {
			const parent = fs.lstatSync(path.dirname(target.path), { bigint: true });
			return { dev: parent.dev, ino: parent.ino };
		})(),
		expectedArtifactsIdentity: pendingEvidence.expectedArtifactsIdentity,
		expectedArtifactsTree: pendingEvidence.expectedArtifactsTree,
		detachedArtifactsPath: pendingEvidence.detachedArtifactsPath,
		retainedArtifactsSuccessorPath: pendingEvidence.retainedArtifactsSuccessorPath,
		retainedArtifactsPlaceholderPath: pendingEvidence.retainedArtifactsPlaceholderPath,
		retainedArtifactsUnknownPath: pendingEvidence.retainedArtifactsUnknownPath,
		detachedTranscriptPath: pendingEvidence.detachedTranscriptPath ?? fallbackDetachedTranscriptPath,
		retainedTranscriptSuccessorPath: pendingEvidence.retainedTranscriptSuccessorPath,
		retainedTranscriptPlaceholderPath: pendingEvidence.retainedTranscriptPlaceholderPath,
		retainedTranscriptUnknownPath: pendingEvidence.retainedTranscriptUnknownPath,
		plannedArtifactsPath: pendingEvidence.plannedArtifactsPath,
		plannedTranscriptPath: pendingEvidence.plannedTranscriptPath,
	});
	if (deletion.kind === "cleanup_pending") {
		if (
			deletion.phase !== "artifacts" ||
			!isAuthorizedArtifactRoot(
				target,
				pendingEvidence.detachedArtifactsPath ?? pendingEvidence.plannedArtifactsPath,
				deletion.detachedArtifactsPath,
			)
		)
			throw new Error("durability_failed");
		const followup = nextCleanupReceipt(target, pendingEvidence);
		pendingEvidence = cleanupPendingEvidence(followup, pendingEvidence, deletion);
		await publishCleanupPending(scope, tombstone, pendingEvidence, lock);
	} else if (deletion.kind !== "artifacts_removed") {
		throw new Error("durability_failed");
	}
	return { deletion, pendingEvidence };
}

async function publishCleanupPending(
	scope: ManagedScope,
	tombstone: string,
	receipt: CleanupReceipt,
	lock: ManagedStorageLock,
): Promise<void> {
	try {
		await publishManagedTombstone(
			cleanupReceiptPath(tombstone, receipt.target, "pending", receipt.attempt),
			cleanupReceipt(scope, tombstone, receipt),
			lock.assertOwned,
		);
	} catch (error) {
		if ((error as Error).message !== "destination_conflict") throw error;
	}
	const persisted = pendingCleanupReceipt(scope, tombstone, receipt.target);
	if (!persisted || persisted.attempt !== receipt.attempt) throw new Error("durability_failed");
}

function cleanupCompleted(scope: ManagedScope, tombstone: string, target: RetiredTarget): boolean {
	assertLegacyOwnerFreeTargets([target]);
	try {
		const value: unknown = JSON.parse(
			captureManagedFileNoFollow(cleanupReceiptPath(tombstone, target, "completed", 1)).bytes.toString("utf8"),
		);
		assertLegacyOwnerFreeRecord(value);
		return cleanupCompletedRecordMatches(scope, tombstone, target, undefined, value);
	} catch (error) {
		if (isOwnerBoundaryFailure(error)) throw error;
		return false;
	}
}

function cleanupCompletedRecordMatches(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	ownerReceipt: ManagedGcSessionRetirementReceipt | undefined,
	value: unknown,
): boolean {
	if (
		target.taskArtifactOwnerDeletionEvidence &&
		(ownerReceipt?.state !== "owner_retired" ||
			!deepSame(ownerReceipt.taskArtifactOwnerDeletionEvidence, target.taskArtifactOwnerDeletionEvidence))
	)
		return false;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const recorded = record.target as Record<string, unknown> | undefined;
	const identity = recorded?.identity as Record<string, unknown> | undefined;
	const expectedKeys = ownerReceipt
		? [
				"schemaVersion",
				"state",
				"scope",
				"tombstone",
				"attempt",
				"target",
				"taskArtifactOwnerDeletionEvidence",
				"taskArtifactOwnerRetirementOutcome",
				"taskArtifactOwnerRetired",
				"taskArtifactOwnerTranscriptDeleted",
			]
		: ["schemaVersion", "state", "scope", "tombstone", "attempt", "target"];
	if (Object.keys(record).length !== expectedKeys.length || !expectedKeys.every(key => key in record)) return false;
	if (ownerReceipt) {
		const pending = pendingCleanupReceipt(scope, tombstone, target);
		if (record.taskArtifactOwnerTranscriptDeleted !== true || !pending?.taskArtifactOwnerTranscriptDeleted)
			return false;
		const evidence = parseTaskArtifactOwnerDeletionEvidence(record.taskArtifactOwnerDeletionEvidence);
		const outcome = parseTaskArtifactOwnerRetirementOutcome(
			taskArtifactOwnerStorageContextForScope(scope),
			evidence,
			record.taskArtifactOwnerRetirementOutcome,
		);
		if (
			record.taskArtifactOwnerRetired !== true ||
			outcome.kind !== "completed" ||
			!deepSame(evidence, ownerReceipt.taskArtifactOwnerDeletionEvidence) ||
			!deepSame(outcome, ownerReceipt.taskArtifactOwnerRetirementOutcome)
		)
			return false;
	}
	return (
		record.schemaVersion === 1 &&
		record.state === "cleanup_completed" &&
		record.scope === scopeDigest(scope.platform, scope.canonicalCwd) &&
		record.tombstone === tombstone &&
		record.attempt === 1 &&
		recorded?.path === target.path &&
		recorded.sessionId === target.sessionId &&
		recorded.cwd === target.cwd &&
		identity?.dev === String(target.identity.dev) &&
		identity.ino === String(target.identity.ino) &&
		identity.size === target.identity.size &&
		identity.mtimeNs === String(target.identity.mtimeNs) &&
		identity.sha256 === target.identity.sha256
	);
}

async function publishCleanupCompleted(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	lock: ManagedStorageLock,
): Promise<void> {
	assertLegacyOwnerFreeTargets([target]);
	try {
		await publishManagedTombstone(
			cleanupReceiptPath(tombstone, target, "completed", 1),
			{
				schemaVersion: 1,
				state: "cleanup_completed",
				scope: scopeDigest(scope.platform, scope.canonicalCwd),
				tombstone,
				attempt: 1,
				target: { path: target.path, sessionId: target.sessionId, cwd: target.cwd, identity: target.identity },
			},
			lock.assertOwned,
		);
	} catch (error) {
		if ((error as Error).message !== "destination_conflict") throw error;
	}
}

function tombstonePathContaining(scope: ManagedScope, candidate: ManagedCandidate): string | undefined {
	const directory = path.join(managedInternalDirectory(scope), MANAGED_TOMBSTONES_DIRECTORY);
	try {
		for (const name of fs.readdirSync(directory)) {
			const pathname = path.join(directory, name);
			if (retiredTargets(scope, pathname)?.some(target => sameCandidate(target, candidate))) return pathname;
		}
	} catch (error) {
		if (isOwnerBoundaryFailure(error) || (error as Error).message === "durability_failed") throw error;
		return undefined;
	}
	return undefined;
}

function isRetired(scope: ManagedScope, candidate: ManagedCandidate): boolean {
	const directory = path.join(managedInternalDirectory(scope), MANAGED_TOMBSTONES_DIRECTORY);
	try {
		for (const name of fs.readdirSync(directory)) {
			const pathname = path.join(directory, name);
			const value: unknown = JSON.parse(captureManagedFileNoFollow(pathname).bytes.toString("utf8"));
			if (!value || typeof value !== "object") continue;
			const record = value as { schemaVersion?: unknown; state?: unknown; scope?: unknown; targets?: unknown };
			if (
				record.schemaVersion !== 2 ||
				record.state !== "retired" ||
				record.scope !== scopeDigest(scope.platform, scope.canonicalCwd) ||
				!Array.isArray(record.targets)
			)
				continue;
			if (
				record.targets.some(target => {
					if (!target || typeof target !== "object") return false;
					const value = target as {
						path?: unknown;
						sessionId?: unknown;
						cwd?: unknown;
						identity?: {
							canonicalPath?: unknown;
							dev?: unknown;
							ino?: unknown;
							size?: unknown;
							mtimeNs?: unknown;
							sha256?: unknown;
						};
					};
					const identity = value.identity;
					if (!identity) return false;
					return (
						value.path === candidate.path &&
						value.sessionId === candidate.sessionId &&
						value.cwd === candidate.cwd &&
						identity.canonicalPath === candidate.identity.canonicalPath &&
						identity.dev === String(candidate.identity.dev) &&
						identity.ino === String(candidate.identity.ino) &&
						identity.size === candidate.identity.size &&
						identity.mtimeNs === String(candidate.identity.mtimeNs) &&
						identity.sha256 === candidate.identity.sha256
					);
				})
			)
				return true;
		}
	} catch {
		/* a missing/malformed tombstone grants no retirement authority */
	}
	return false;
}

type ArtifactManifestEntry =
	| { kind: "directory"; path: string }
	| { kind: "file"; path: string; sha256: string; size: number };

function artifactManifestFromSnapshot(snapshot: NativeDirectoryTreeSnapshot): readonly ArtifactManifestEntry[] {
	return snapshot.entries
		.map(entry => {
			if (entry.kind === "directory") return { kind: "directory" as const, path: entry.relativePath };
			const size = Number(entry.size);
			if (
				entry.kind !== "file" ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				typeof entry.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(entry.sha256)
			)
				throw new Error("unsafe_artifacts");
			return { kind: "file" as const, path: entry.relativePath, size, sha256: entry.sha256 };
		})
		.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

function artifactManifest(transcriptPath: string, rootOverride?: string): readonly ArtifactManifestEntry[] {
	const root = rootOverride ?? transcriptPath.slice(0, -6);
	try {
		validateManagedArtifactTree(root);
		const entries: ArtifactManifestEntry[] = [{ kind: "directory", path: "" }];
		const walk = (directory: string): void => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				const pathname = path.join(directory, entry.name);
				const relative = path.relative(root, pathname).split(path.sep).join("/");
				if (entry.isDirectory()) {
					entries.push({ kind: "directory", path: relative });
					walk(pathname);
				} else {
					const snapshot = captureManagedFileNoFollow(pathname);
					entries.push({
						kind: "file",
						path: relative,
						size: snapshot.bytes.byteLength,
						sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
					});
				}
			}
		};
		walk(root);
		return entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function manifestMatches(
	transcriptPath: string,
	manifest: readonly ArtifactManifestEntry[],
	rootOverride?: string,
): boolean {
	try {
		const actual = artifactManifest(transcriptPath, rootOverride);
		return (
			actual.length === manifest.length &&
			actual.every((entry, index) => {
				const expected = manifest[index];
				return entry.kind === "directory"
					? expected?.kind === "directory" && entry.path === expected.path
					: expected?.kind === "file" &&
							entry.path === expected.path &&
							entry.sha256 === expected.sha256 &&
							entry.size === expected.size;
			})
		);
	} catch {
		return false;
	}
}

function manifestContains(transcriptPath: string, manifest: readonly ArtifactManifestEntry[]): boolean {
	try {
		const actual = artifactManifest(transcriptPath);
		return manifest.every(expected =>
			actual.some(entry =>
				entry.kind === "directory"
					? expected.kind === "directory" && entry.path === expected.path
					: expected.kind === "file" &&
						entry.path === expected.path &&
						entry.sha256 === expected.sha256 &&
						entry.size === expected.size,
			),
		);
	} catch {
		return false;
	}
}

type DetachedArtifactRoot = {
	originalPath: string;
	detachedPath: string;
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; parentDev: bigint; parentIno: bigint };
	tree: NativeDirectoryTreeSnapshot;
};

function planArtifactRootForMigration(sourceTranscript: string, operation: string): DetachedArtifactRoot | undefined {
	const originalPath = sourceTranscript.slice(0, -6);
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(originalPath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_artifacts");
	const tree = snapshotArtifactTree(originalPath);
	const root = tree.entries.find(entry => entry.relativePath === "" && entry.kind === "directory");
	if (!root) throw new Error("unsafe_artifacts");
	const parent = fs.lstatSync(path.dirname(originalPath), { bigint: true });
	return {
		originalPath,
		detachedPath: path.join(path.dirname(originalPath), `.gjc-migrate-${operation}-artifacts`),
		identity: {
			dev: stat.dev,
			ino: stat.ino,
			size: process.platform === "win32" ? BigInt(root.size) : stat.size,
			mtimeNs: process.platform === "win32" ? BigInt(root.mtimeNs) : stat.mtimeNs,
			parentDev: parent.dev,
			parentIno: parent.ino,
		},
		tree,
	};
}

function sameDirectoryObject(leftPath: string, rightPath: string): boolean {
	try {
		const left = fs.lstatSync(leftPath, { bigint: true });
		const right = fs.lstatSync(rightPath, { bigint: true });
		return (
			left.isDirectory() &&
			right.isDirectory() &&
			!left.isSymbolicLink() &&
			!right.isSymbolicLink() &&
			left.dev === right.dev &&
			left.ino === right.ino
		);
	} catch {
		return false;
	}
}

export function matchesMigrationArtifactRoot(
	pathname: string,
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
	expectedTree: NativeDirectoryTreeSnapshot,
	platform: NodeJS.Platform = process.platform,
): boolean {
	try {
		const stat = fs.lstatSync(pathname, { bigint: true });
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino)
			return false;
		const observed = nativeScope().snapshotDirectoryTree(pathname);
		const expectedRoot = expectedTree.entries.find(entry => entry.relativePath === "" && entry.kind === "directory");
		const observedRoot = observed.snapshot?.entries.find(
			entry => entry.relativePath === "" && entry.kind === "directory",
		);
		if (
			!observed.ok ||
			!observed.snapshot ||
			!expectedRoot ||
			!observedRoot ||
			(platform === "win32" &&
				(observedRoot.dev !== identity.dev.toString() ||
					observedRoot.ino !== identity.ino.toString() ||
					BigInt(observedRoot.size) !== identity.size ||
					BigInt(observedRoot.mtimeNs) !== identity.mtimeNs)) ||
			(platform !== "win32" && (stat.size !== identity.size || stat.mtimeNs !== identity.mtimeNs))
		)
			return false;
		return sameArtifactTree(expectedTree, observed.snapshot, { platform, phase: "migration" });
	} catch {
		return false;
	}
}

type ArtifactTreeComparisonPolicy = {
	platform?: NodeJS.Platform;
	phase?: "migration" | "strict";
};

function sameArtifactTree(
	left: NativeDirectoryTreeSnapshot,
	right: NativeDirectoryTreeSnapshot,
	policy: ArtifactTreeComparisonPolicy = {},
): boolean {
	const { platform = process.platform, phase = "strict" } = policy;
	const entryKey = (entry: NativeDirectoryTreeSnapshot["entries"][number]): string => {
		// Detaching the root directory changes its ctime without changing the preserved artifact tree;
		// root identity and mtime are checked above. pi-iso also accepts Windows plain directories by
		// stable file id and kind only because NTFS can lazily update their metadata while enumeration
		// trails an open handle. All other platforms and nested directories compare every captured field.
		if (phase === "migration" && entry.kind === "directory" && (entry.relativePath === "" || platform === "win32"))
			return JSON.stringify([entry.relativePath, entry.kind, entry.dev, entry.ino]);
		return JSON.stringify([
			entry.relativePath,
			entry.kind,
			entry.dev,
			entry.ino,
			entry.size,
			entry.mtimeNs,
			entry.ctimeNs,
			entry.sha256,
		]);
	};
	const leftEntries = left.entries.map(entryKey).sort();
	const rightEntries = right.entries.map(entryKey).sort();
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		leftEntries.length === rightEntries.length &&
		leftEntries.every((entry, index) => entry === rightEntries[index])
	);
}

function matchesDetachedArtifactRoot(pathname: string, plan: DetachedArtifactRoot): boolean {
	return (
		matchesMigrationArtifactRoot(pathname, plan.identity, plan.tree) &&
		sameDirectoryObject(path.dirname(pathname), path.dirname(plan.detachedPath))
	);
}

type SourceArtifactCleanup = {
	state: "cleanup_pending";
	role: "exchange_placeholder";
	retainedPath: string;
	identity: DetachedArtifactRoot["identity"];
	tree: NativeDirectoryTreeSnapshot;
};

export function cleanupAuthorityMatches(
	cleanup: SourceArtifactCleanup,
	parent: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	try {
		const stat = fs.lstatSync(cleanup.retainedPath, { bigint: true });
		const parentStat = fs.lstatSync(parent, { bigint: true });
		if (
			path.dirname(cleanup.retainedPath) !== parent ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== cleanup.identity.dev ||
			stat.ino !== cleanup.identity.ino ||
			parentStat.dev !== cleanup.identity.parentDev ||
			parentStat.ino !== cleanup.identity.parentIno
		)
			return false;
		const snapshot = nativeScope().snapshotDirectoryTree(cleanup.retainedPath);
		const observedRoot = snapshot.snapshot?.entries.find(
			entry => entry.relativePath === "" && entry.kind === "directory",
		);
		if (
			!snapshot.ok ||
			!snapshot.snapshot ||
			!observedRoot ||
			(platform === "win32"
				? observedRoot.dev !== cleanup.identity.dev.toString() ||
					observedRoot.ino !== cleanup.identity.ino.toString() ||
					BigInt(observedRoot.size) !== cleanup.identity.size ||
					BigInt(observedRoot.mtimeNs) !== cleanup.identity.mtimeNs
				: stat.size !== cleanup.identity.size || stat.mtimeNs !== cleanup.identity.mtimeNs)
		)
			return false;
		return (
			sameArtifactTree(snapshot.snapshot, cleanup.tree) &&
			cleanup.tree.entries.length === 1 &&
			cleanup.tree.entries[0]?.relativePath === "" &&
			cleanup.tree.entries[0]?.kind === "directory"
		);
	} catch {
		return false;
	}
}

export function detachArtifactRootForMigration(
	plan: DetachedArtifactRoot,
	platform: NodeJS.Platform = process.platform,
):
	| { detached: DetachedArtifactRoot; detachOutcome: "clean" }
	| { detached: DetachedArtifactRoot; detachOutcome: "cleanup_pending"; cleanup: SourceArtifactCleanup } {
	const result = nativeScope().exactUnlink(plan.originalPath, {
		...plan.identity,
		directory: true,
		detachOnly: true,
		quarantineName: path.basename(plan.detachedPath),
	});
	const cleanSuccess =
		result.ok && !result.retainedSuccessorPath && !result.retainedPlaceholderPath && !result.retainedUnknownPath;
	const cleanupPending =
		!result.ok &&
		result.code === "cleanup_pending" &&
		!!result.detachedPath &&
		!!result.retainedPlaceholderPath &&
		!result.retainedSuccessorPath &&
		!result.retainedUnknownPath;
	if (
		(!cleanSuccess && !cleanupPending) ||
		!result.detachedPath ||
		!matchesDetachedArtifactRoot(result.detachedPath, plan)
	)
		throw new Error("durability_failed");

	const detachedPath =
		process.platform === "win32" ? fs.realpathSync.native(result.detachedPath) : result.detachedPath;
	if (!matchesDetachedArtifactRoot(detachedPath, plan)) throw new Error("durability_failed");
	const detached = { ...plan, detachedPath };
	if (!cleanupPending) return { detached, detachOutcome: "clean" };
	const placeholder = result.retainedPlaceholderPath!;
	const stat = fs.lstatSync(placeholder, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(placeholder) !== path.dirname(plan.originalPath))
		throw new Error("durability_failed");
	const snapshot = nativeScope().snapshotDirectoryTree(placeholder);
	if (!snapshot.ok || !snapshot.snapshot) throw new Error("durability_failed");
	// Windows directory size/mtime authority is the native tree root, never Bun's
	// zero-valued directory lstat. Capturing Bun values here would guarantee a
	// mismatch against the native-authoritative check below.
	const placeholderRoot = snapshot.snapshot.entries.find(
		entry => entry.relativePath === "" && entry.kind === "directory",
	);
	if (!placeholderRoot) throw new Error("durability_failed");
	const parent = fs.lstatSync(path.dirname(placeholder), { bigint: true });
	const cleanup: SourceArtifactCleanup = {
		state: "cleanup_pending",
		role: "exchange_placeholder",
		retainedPath: placeholder,
		identity: {
			dev: stat.dev,
			ino: stat.ino,
			size: platform === "win32" ? BigInt(placeholderRoot.size) : stat.size,
			mtimeNs: platform === "win32" ? BigInt(placeholderRoot.mtimeNs) : stat.mtimeNs,
			parentDev: parent.dev,
			parentIno: parent.ino,
		},
		tree: snapshot.snapshot,
	};
	if (!cleanupAuthorityMatches(cleanup, path.dirname(plan.originalPath), platform))
		throw new Error("durability_failed");
	return { detached, detachOutcome: "cleanup_pending", cleanup };
}

export function restorePreparedArtifactRoot(
	scope: ManagedScope,
	source: ManagedCandidate,
	lock?: ManagedStorageLock,
): void {
	const preparedReceipt = receiptPathFor(scope, source, "prepared");
	const detachedReceipt = receiptPathFor(scope, source, "detached");
	const receipt = fs.existsSync(detachedReceipt) ? detachedReceipt : preparedReceipt;
	let record: {
		sourceArtifactQuarantine?: {
			path?: unknown;
			detachedPath?: unknown;
			identity?: Record<string, unknown>;
			tree?: unknown;
			role?: unknown;
		};
		sourceArtifactCleanup?: {
			state?: unknown;
			role?: unknown;
			retainedPath?: unknown;
			identity?: Record<string, unknown>;
			tree?: unknown;
		};
		detachOutcome?: unknown;
	};
	try {
		record = JSON.parse(captureManagedFileNoFollow(receipt).bytes.toString("utf8")) as typeof record;
	} catch {
		if (!fs.existsSync(receipt)) return;
		throw new Error("durability_failed");
	}
	const quarantine = record.sourceArtifactQuarantine;
	if (!quarantine) return;
	const identity = quarantine.identity;
	if (
		quarantine.path !== source.path.slice(0, -6) ||
		typeof quarantine.detachedPath !== "string" ||
		path.dirname(quarantine.detachedPath) !== path.dirname(source.path) ||
		!path.basename(quarantine.detachedPath).startsWith(".gjc-migrate-") ||
		!artifactTreeSnapshot(quarantine.tree) ||
		!identity ||
		typeof identity.dev !== "string" ||
		typeof identity.ino !== "string" ||
		typeof identity.size !== "string" ||
		typeof identity.mtimeNs !== "string" ||
		typeof identity.parentDev !== "string" ||
		typeof identity.parentIno !== "string"
	)
		throw new Error("durability_failed");
	const artifactIdentity = {
		dev: BigInt(identity.dev),
		ino: BigInt(identity.ino),
		size: BigInt(identity.size),
		mtimeNs: BigInt(identity.mtimeNs),
		parentDev: BigInt(identity.parentDev),
		parentIno: BigInt(identity.parentIno),
	};
	const expectedTree = artifactTreeSnapshot(quarantine.tree)!;
	const assertPreparedTree = (pathname: string): void => {
		if (
			!matchesMigrationArtifactRoot(
				pathname,
				{
					...artifactIdentity,
				},
				expectedTree,
			)
		)
			throw new Error("durability_failed");
	};
	if (receipt === detachedReceipt) {
		if (quarantine.role !== "detached_artifact_root") throw new Error("durability_failed");
		if (record.detachOutcome === "clean") {
			if (record.sourceArtifactCleanup !== undefined) throw new Error("durability_failed");
			const originalExists = fs.existsSync(quarantine.path);
			const detachedExists = fs.existsSync(quarantine.detachedPath);
			if (originalExists) {
				if (detachedExists) throw new Error("durability_failed");
				assertPreparedTree(quarantine.path);
				if (lock) {
					lock.assertOwned();
					fs.unlinkSync(receipt);
					fsyncManagedParent(receipt);
				}
				return;
			}
		} else if (record.detachOutcome === "cleanup_pending") {
			const cleanup = record.sourceArtifactCleanup;
			if (!cleanup) throw new Error("durability_failed");
			const cleanupIdentity = cleanup.identity;
			const cleanupTree = artifactTreeSnapshot(cleanup.tree);
			if (
				cleanup.state !== "cleanup_pending" ||
				cleanup.role !== "exchange_placeholder" ||
				typeof cleanup.retainedPath !== "string" ||
				!cleanupIdentity ||
				typeof cleanupIdentity.dev !== "string" ||
				typeof cleanupIdentity.ino !== "string" ||
				typeof cleanupIdentity.size !== "string" ||
				typeof cleanupIdentity.mtimeNs !== "string" ||
				typeof cleanupIdentity.parentDev !== "string" ||
				typeof cleanupIdentity.parentIno !== "string" ||
				!cleanupTree ||
				!cleanupAuthorityMatches(
					{
						state: "cleanup_pending",
						role: "exchange_placeholder",
						retainedPath: cleanup.retainedPath,
						identity: {
							dev: BigInt(cleanupIdentity.dev),
							ino: BigInt(cleanupIdentity.ino),
							size: BigInt(cleanupIdentity.size),
							mtimeNs: BigInt(cleanupIdentity.mtimeNs),
							parentDev: BigInt(cleanupIdentity.parentDev),
							parentIno: BigInt(cleanupIdentity.parentIno),
						},
						tree: cleanupTree,
					},
					path.dirname(source.path),
				)
			)
				throw new Error("durability_failed");
		} else {
			throw new Error("durability_failed");
		}
	}

	if (fs.existsSync(quarantine.path)) {
		if (
			matchesMigrationArtifactRoot(
				quarantine.path,
				{
					...artifactIdentity,
				},
				expectedTree,
			)
		) {
			assertPreparedTree(quarantine.path);
		}
		// A changed source pathname is independent retained authority. Do not replace
		// it with the detached original; retain both roots for recovery.
		return;
	}
	assertPreparedTree(quarantine.detachedPath);
	const result = nativeScope().exactRestore(quarantine.detachedPath, quarantine.path, {
		...artifactIdentity,
		directory: true,
	});
	if (!result.ok && result.code !== "cleanup_pending") throw new Error("durability_failed");
}

function restoreDetachedArtifactRoot(detached: DetachedArtifactRoot, cleanup?: SourceArtifactCleanup): void {
	if (cleanup && !cleanupAuthorityMatches(cleanup, path.dirname(detached.originalPath)))
		throw new Error("durability_failed");
	const result = nativeScope().exactRestore(detached.detachedPath, detached.originalPath, {
		...detached.identity,
		directory: true,
	});
	if (!result.ok && result.code !== "cleanup_pending") throw new Error("durability_failed");
}

async function copyArtifacts(
	scope: ManagedScope,
	sourceTranscript: string,
	destinationTranscript: string,
	manifest: readonly ArtifactManifestEntry[],
	lock: ManagedStorageLock,
	expectedCandidate: ManagedCandidate,
	expectedIdentity: ResumeSessionIdentity,
	sourceRootOverride?: string,
): Promise<void> {
	const root = scopeRoot(scope);
	if (manifest.length === 0) return;
	const sourceRoot = sourceRootOverride ?? sourceTranscript.slice(0, -6);
	if (!manifestMatches(sourceTranscript, manifest, sourceRoot)) throw new Error("source_changed");
	const destinationRoot = destinationTranscript.slice(0, -6);
	for (let start = 0; start < manifest.length; start += MANAGED_ARTIFACT_COPY_BATCH_SIZE) {
		const batch = manifest.slice(start, start + MANAGED_ARTIFACT_COPY_BATCH_SIZE);
		revalidatePickerConsent(scope, expectedCandidate, expectedIdentity);
		lock.assertOwned();
		for (const entry of batch) {
			const source = path.join(sourceRoot, entry.path);
			const destination = path.join(destinationRoot, entry.path);
			if (entry.kind === "directory") {
				if (entry.path === "") {
					ensureManagedDirectory(destinationRoot, root);
				} else {
					ensureManagedDirectory(destination, root);
				}
				continue;
			}
			const snapshot = captureManagedFileNoFollow(source);
			if (
				snapshot.bytes.byteLength !== entry.size ||
				createHash("sha256").update(snapshot.bytes).digest("hex") !== entry.sha256
			)
				throw new Error("source_changed");
			try {
				await copyManagedFileNoReplace(source, destination, snapshot, root);
			} catch (error) {
				if ((error as Error).message !== "destination_conflict") throw error;
			}
			lock.assertOwned();
			const copied = captureManagedFileNoFollow(destination);
			if (
				copied.bytes.byteLength !== entry.size ||
				createHash("sha256").update(copied.bytes).digest("hex") !== entry.sha256
			)
				throw new Error("durability_failed");
		}
		if (start + batch.length < manifest.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	if (!manifestMatches(sourceTranscript, manifest, sourceRoot) || !manifestMatches(destinationTranscript, manifest))
		throw new Error("durability_failed");
}

function migrationReceipt(
	scope: ManagedScope,
	lock: ManagedStorageLock,
	state: "prepared" | "artifact_detached" | "published" | "committed",
	source: ManagedCandidate,
	destination: ManagedCandidate | { path: string; sessionId: string; cwd: string },
	manifest: readonly ArtifactManifestEntry[],
	sourceArtifactQuarantine?: {
		path: string;
		detachedPath: string;
		identity: DetachedArtifactRoot["identity"];
		tree: NativeDirectoryTreeSnapshot;
		role?: "detached_artifact_root";
	},
	sourceArtifactCleanup?: SourceArtifactCleanup,
	detachOutcome?: "clean" | "cleanup_pending",
): Uint8Array {
	lock.assertOwned();
	const destinationRecord =
		"identity" in destination
			? {
					path: destination.path,
					sessionId: destination.sessionId,
					header: { id: destination.sessionId, cwd: destination.cwd },
					identity: destination.identity,
					sha256: destination.identity.sha256,
				}
			: {
					path: destination.path,
					sessionId: destination.sessionId,
					header: { id: destination.sessionId, cwd: destination.cwd },
				};
	return new TextEncoder().encode(
		`${JSON.stringify({ schemaVersion: 2, state, policy: "copy-retain", attemptId: lock.attemptId, scope: scopeDigest(scope.platform, scope.canonicalCwd), source: { path: source.path, sessionId: source.sessionId, header: { id: source.sessionId, cwd: source.cwd }, identity: source.identity, sha256: source.identity.sha256 }, destination: destinationRecord, artifactManifest: manifest, ...(sourceArtifactQuarantine ? { sourceArtifactQuarantine } : {}), ...(sourceArtifactCleanup ? { sourceArtifactCleanup } : {}), ...(detachOutcome ? { detachOutcome } : {}) }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
	);
}

function detachedReceiptMatches(receipt: string, expected: Uint8Array): boolean {
	try {
		return captureManagedFileNoFollow(receipt).bytes.equals(expected);
	} catch {
		return false;
	}
}

async function removeStagedReceipts(scope: ManagedScope, candidate: ManagedCandidate): Promise<void> {
	const authority = boundManagedWriteAuthorities.get(scope);
	const rootAuthority = authority?.rootAuthority ?? scopeRoot(scope);
	const store = authority?.retainedAuthority
		? new ManagedSessionDescendantStore(rootAuthority, scope.directoryPath, {
				authority: authority.retainedAuthority,
				authorityBaseDir: scope.directoryPath,
			})
		: new ManagedSessionDescendantStore(rootAuthority, scope.directoryPath);
	for (const state of ["prepared", "detached", "published"] as const) {
		const pathname = receiptPathFor(scope, candidate, state);
		try {
			const snapshot = captureManagedFileNoFollow(pathname);
			store.removeExpected(path.relative(scope.directoryPath, pathname), snapshot);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function receiptPair(scope: ManagedScope, candidate: ManagedCandidate): ManagedCandidate | undefined {
	const directory = path.join(managedInternalDirectory(scope), MANAGED_RECEIPTS_DIRECTORY);
	try {
		for (const name of fs.readdirSync(directory)) {
			try {
				const pathname = path.join(directory, name);
				const value: unknown = JSON.parse(captureManagedFileNoFollow(pathname).bytes.toString("utf8"));
				if (!value || typeof value !== "object") continue;
				const record = value as { source?: { path?: unknown }; destination?: { path?: unknown } };
				const otherPath =
					record.source?.path === candidate.path
						? record.destination?.path
						: record.destination?.path === candidate.path
							? record.source?.path
							: undefined;
				if (typeof otherPath !== "string") continue;
				const other = inspectCandidate(otherPath, candidate.provenance === "v2" ? "legacy" : "v2");
				if (
					"code" in other ||
					!receiptMatches(
						pathname,
						candidate.provenance === "legacy" ? candidate : other,
						candidate.provenance === "v2" ? candidate : other,
						scope,
					)
				)
					continue;
				return other;
			} catch {
				// Native cleanup residues, symlinks, and malformed files grant no authority;
				// continue to the deterministic committed receipt instead of aborting the scan.
			}
		}
	} catch {
		/* a missing receipts directory grants no shadow authority */
	}
	return undefined;
}

function validateCandidateForScope(scope: ManagedScope, candidate: ManagedCandidate): ManagedCandidate | undefined {
	scopeRoot(scope);
	const inspected = inspectCandidate(candidate.path, candidate.provenance);
	if ("code" in inspected || !sameCandidate(inspected, candidate)) return undefined;
	const identity = identityFor(inspected.cwd);
	if (!identity.ok || identity.platform !== scope.platform || identity.canonicalPath !== scope.canonicalCwd)
		return undefined;
	return inspected;
}

/** Resume tombstoned cleanup under its original operation lease without restoring retired candidates. */
export async function reconcileManagedTombstones(
	scope: ManagedScope,
	expectedCandidate?: ManagedCandidate,
): Promise<void> {
	const directory = path.join(managedInternalDirectory(scope), MANAGED_TOMBSTONES_DIRECTORY);
	for (const name of fs.readdirSync(directory)) {
		const tombstone = path.join(directory, name);
		const targets = retiredTargets(scope, tombstone);
		if (!targets) continue;
		assertLegacyOwnerFreeTargets(targets);
		if (targets.every(target => cleanupCompleted(scope, tombstone, target))) continue;
		for (const target of targets)
			if (!cleanupCompleted(scope, tombstone, target))
				assertLegacyOwnerFreeTranscript({
					transcriptPath: target.path,
					sessionId: target.sessionId,
					transcriptIdentity: target.identity,
				});
		let lock: ManagedStorageLock | undefined;
		try {
			lock = await acquireManagedLock(
				path.join(managedInternalDirectory(scope), MANAGED_LOCKS_DIRECTORY),
				path.basename(tombstone, ".json"),
				scopeRoot(scope),
			);
			const lockedTargets = retiredTargets(scope, tombstone);
			if (!lockedTargets) continue;
			assertLegacyOwnerFreeTargets(lockedTargets);
			for (const target of lockedTargets)
				if (!cleanupCompleted(scope, tombstone, target))
					assertLegacyOwnerFreeTranscript({
						transcriptPath: target.path,
						sessionId: target.sessionId,
						transcriptIdentity: target.identity,
					});
			for (const target of lockedTargets) {
				lock.assertOwned();
				if (cleanupCompleted(scope, tombstone, target)) continue;
				try {
					const pending = pendingCleanupReceipt(scope, tombstone, target);
					const observedPending = pending ? probePlannedCleanupDetach(target, pending) : undefined;
					try {
						fs.lstatSync(target.path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							const replayReceipt = observedPending ?? nextCleanupReceipt(target, pending);
							const artifactsEvidence = cleanupArtifactsRemovedEvidence(
								scope,
								tombstone,
								target,
								pending?.artifactsRemovedAttempt ??
									replayReceipt.artifactsRemovedAttempt ??
									pending?.attempt ??
									replayReceipt.attempt,
							);
							if (
								artifactsEvidence &&
								cleanupRootsAbsent(
									tombstone,
									target,
									replayReceipt,
									artifactsEvidence.retainedArtifactsRootPath,
								)
							) {
								fsyncManagedParent(target.path);
								await publishCleanupCompleted(scope, tombstone, target, lock);
								continue;
							}
							if (!observedPending) continue;
							if (!observedPending.detachedTranscriptPath) continue;
						} else throw error;
					}
					const verified = observedPending ? target : validateCandidateForScope(scope, target);
					if (!verified || !sameCandidate(verified, target)) throw new Error("source_changed");
					const discoveredDetach =
						!!observedPending &&
						(observedPending.detachedArtifactsPath !== pending?.detachedArtifactsPath ||
							observedPending.detachedTranscriptPath !== pending?.detachedTranscriptPath);
					let active =
						discoveredDetach || (observedPending && requiresFreshCleanupPlan(observedPending))
							? nextCleanupReceipt(target, observedPending)
							: (observedPending ?? nextCleanupReceipt(target, undefined));
					if (!observedPending || discoveredDetach || requiresFreshCleanupPlan(observedPending))
						await publishCleanupPending(scope, tombstone, active, lock);
					const initialTarget = observedPending?.detachedTranscriptPath
						? target
						: validateCandidateForScope(scope, target);
					if (!initialTarget) throw new Error("source_changed");
					let deletion = await deleteSessionVerifiedWithFence("reconcile", "initial", lock, {
						sessionsRoot: scope.sessionsRoot,
						transcriptPath: target.path,
						sessionId: target.sessionId,
						cwd: target.cwd,
						transcriptIdentity: {
							...initialTarget.identity,
							nlink: fs.lstatSync(observedPending?.detachedTranscriptPath ?? target.path, { bigint: true })
								.nlink,
						},
						expectedArtifactsIdentity: active.expectedArtifactsIdentity,
						expectedArtifactsTree: active.expectedArtifactsTree,
						detachedArtifactsPath:
							active.detachedArtifactsPath ??
							observedPending?.detachedArtifactsPath ??
							(fs.existsSync(active.plannedArtifactsPath) ? active.plannedArtifactsPath : undefined),
						detachedTranscriptPath:
							active.detachedTranscriptPath ??
							observedPending?.detachedTranscriptPath ??
							(pending && fs.existsSync(pending.plannedTranscriptPath)
								? pending.plannedTranscriptPath
								: undefined) ??
							(fs.existsSync(active.plannedTranscriptPath) ? active.plannedTranscriptPath : undefined),
						retainedArtifactsSuccessorPath: active.retainedArtifactsSuccessorPath,
						retainedArtifactsPlaceholderPath: active.retainedArtifactsPlaceholderPath,
						retainedArtifactsUnknownPath: active.retainedArtifactsUnknownPath,
						retainedTranscriptSuccessorPath: active.retainedTranscriptSuccessorPath,
						retainedTranscriptPlaceholderPath: active.retainedTranscriptPlaceholderPath,
						retainedTranscriptUnknownPath: active.retainedTranscriptUnknownPath,
						plannedArtifactsPath: active.plannedArtifactsPath,
						plannedTranscriptPath: active.plannedTranscriptPath,
						...(cleanupArtifactsRemoved(
							scope,
							tombstone,
							target,
							pending?.artifactsRemovedAttempt ??
								active.artifactsRemovedAttempt ??
								pending?.attempt ??
								active.attempt,
						)
							? { artifactsRemoved: true as const }
							: {}),
					});
					if (deletion.kind === "artifacts_removed") {
						await publishCleanupArtifactsRemoved(scope, tombstone, active, lock);
						active = { ...active, artifactsRemovedAttempt: active.attempt };
						const refreshedTarget = validateCandidateForScope(scope, target);
						if (!refreshedTarget) throw new Error("source_changed");
						deletion = await deleteSessionVerifiedWithFence(
							"reconcile",
							"transcript-after-artifacts-removed",
							lock,
							{
								sessionsRoot: scope.sessionsRoot,
								transcriptPath: target.path,
								sessionId: target.sessionId,
								cwd: target.cwd,
								transcriptIdentity: refreshedTarget.identity,
								plannedArtifactsPath: active.plannedArtifactsPath,
								plannedTranscriptPath: active.plannedTranscriptPath,
								detachedTranscriptPath:
									active.detachedTranscriptPath ?? observedPending?.detachedTranscriptPath,

								retainedArtifactsSuccessorPath: active.retainedArtifactsSuccessorPath,
								retainedArtifactsPlaceholderPath: active.retainedArtifactsPlaceholderPath,
								retainedArtifactsUnknownPath: active.retainedArtifactsUnknownPath,
								retainedTranscriptSuccessorPath: active.retainedTranscriptSuccessorPath,
								retainedTranscriptPlaceholderPath: active.retainedTranscriptPlaceholderPath,
								retainedTranscriptUnknownPath: active.retainedTranscriptUnknownPath,
								artifactsRemoved: true,
							},
						);
					}
					if (deletion.kind === "cleanup_pending") {
						assertAuthorizedCleanupPending(target, active, deletion);
						const retry = nextCleanupReceipt(target, active);
						let pendingEvidence = cleanupPendingEvidence(retry, active, deletion);
						await publishCleanupPending(scope, tombstone, pendingEvidence, lock);
						if (deletion.phase === "artifacts") {
							if (
								deletion.detachedArtifactsPath === active.plannedArtifactsPath &&
								!retainedArtifactPayloadAbsent(deletion.detachedArtifactsPath)
							) {
								({ deletion, pendingEvidence } = await continueDetachedArtifactCleanup(
									scope,
									tombstone,
									target,
									pendingEvidence,
									observedPending?.detachedTranscriptPath,
									lock,
									"reconcile",
								));
							}
							if (
								deletion.kind === "cleanup_pending" &&
								deletion.phase === "artifacts" &&
								(deletion.artifactsPayloadDurable !== true ||
									!retainedArtifactPayloadAbsent(deletion.detachedArtifactsPath))
							)
								continue;
							await publishCleanupArtifactsRemoved(scope, tombstone, pendingEvidence, lock);
							pendingEvidence = { ...pendingEvidence, artifactsRemovedAttempt: pendingEvidence.attempt };
							const retainedProof = cleanupArtifactsRemovedReceipt(
								tombstone,
								target,
								pendingEvidence.artifactsRemovedAttempt ?? pendingEvidence.attempt,
							);
							if (!retainedProof) throw new Error("durability_failed");
							deletion = await deleteSessionVerifiedWithFence(
								"reconcile",
								"transcript-after-artifacts-removed",
								lock,
								{
									sessionsRoot: scope.sessionsRoot,
									transcriptPath: target.path,
									sessionId: target.sessionId,
									cwd: target.cwd,
									transcriptIdentity: {
										...target.identity,
										nlink: fs.lstatSync(target.path, { bigint: true }).nlink,
									},
									plannedArtifactsPath: pendingEvidence.plannedArtifactsPath,
									plannedTranscriptPath: pendingEvidence.plannedTranscriptPath,
									detachedTranscriptPath:
										pendingEvidence.detachedTranscriptPath ?? observedPending?.detachedTranscriptPath,
									expectedArtifactsIdentity: retainedProof.identity,
									expectedArtifactsTree: retainedProof.tree,
									detachedArtifactsPath: retainedProof.path,
									retainedArtifactsSuccessorPath: pendingEvidence.retainedArtifactsSuccessorPath,
									retainedArtifactsPlaceholderPath: pendingEvidence.retainedArtifactsPlaceholderPath,
									retainedArtifactsUnknownPath: pendingEvidence.retainedArtifactsUnknownPath,
									retainedTranscriptSuccessorPath: pendingEvidence.retainedTranscriptSuccessorPath,
									retainedTranscriptPlaceholderPath: pendingEvidence.retainedTranscriptPlaceholderPath,
									retainedTranscriptUnknownPath: pendingEvidence.retainedTranscriptUnknownPath,
									artifactsRemoved: true,
								},
								() => {
									if (
										!cleanupArtifactsRemoved(
											scope,
											tombstone,
											target,
											pendingEvidence.artifactsRemovedAttempt ?? pendingEvidence.attempt,
										)
									)
										throw new Error("durability_failed");
								},
							);
							if (deletion.kind === "cleanup_pending") {
								if (
									deletion.phase !== "transcript" ||
									(deletion.detachedTranscriptPath !== pendingEvidence.plannedTranscriptPath &&
										deletion.transcriptPayloadDurable !== true)
								)
									throw new Error("durability_failed");
								const followup = nextCleanupReceipt(target, pendingEvidence);
								pendingEvidence = cleanupPendingEvidence(followup, pendingEvidence, deletion);
								await publishCleanupPending(scope, tombstone, pendingEvidence, lock);
							}
							if (deletion.kind === "deleted" && fs.existsSync(pendingEvidence.plannedTranscriptPath)) {
								if (!reconcileScrubbedTranscriptPlaceholder(pendingEvidence.plannedTranscriptPath))
									throw new Error("durability_failed");
							}
						}
						if (
							deletion.kind === "cleanup_pending" &&
							(deletion.phase !== "transcript" ||
								deletion.transcriptPayloadDurable !== true ||
								!cleanupRootsAbsent(
									tombstone,
									target,
									pendingEvidence,
									pendingEvidence.artifactsPayloadDurable === true &&
										pendingEvidence.detachedArtifactsPath &&
										retainedArtifactPayloadAbsent(pendingEvidence.detachedArtifactsPath)
										? pendingEvidence.detachedArtifactsPath
										: undefined,
								))
						)
							continue;
					}
					fsyncManagedParent(target.path);
					await publishCleanupCompleted(scope, tombstone, target, lock);
				} catch (error) {
					if (!expectedCandidate || target.sessionId === expectedCandidate.sessionId) throw error;
					logger.warn("Tombstone reconciliation failed for one target; will retry on a future scope open", {
						tombstone,
						sessionId: target.sessionId,
						error: String(error),
					});
				}
			}
		} finally {
			if (lock) await lock.release();
		}
	}
}

/** Create the v2 binding and private write protocol directories before managed writes. */
export async function prepareManagedSessionScopeForWrite(
	scope: ManagedScope,
	policy: ManagedSessionSecurityPolicy = "default",
	authority?: ManagedCandidateWriteAuthority,
	expectedCandidate?: ManagedCandidate,
	expectedIdentity?: ResumeSessionIdentity,
): Promise<ManagedScopeResolution> {
	if (expectedCandidate && expectedIdentity) revalidatePickerConsent(scope, expectedCandidate, expectedIdentity);
	if (authority) bindManagedWriteAuthority(scope, authority);
	const prepared = await ensureManagedScope(scope, policy);
	if (prepared.kind === "error") return prepared;
	try {
		const internal = managedInternalDirectory(scope);
		const root = scopeRoot(scope);
		ensureManagedDirectory(internal, root, policy);
		ensureManagedDirectory(path.join(internal, MANAGED_LOCKS_DIRECTORY), root, policy);
		ensureManagedDirectory(path.join(internal, MANAGED_RECEIPTS_DIRECTORY), root, policy);
		ensureManagedDirectory(path.join(internal, MANAGED_TOMBSTONES_DIRECTORY), root, policy);
		await reconcileManagedTombstones(scope, expectedCandidate);
		reapScrubbedProtocolRemnantsSync(scope.directoryPath);
		return { kind: "resolved", scope };
	} catch (error) {
		const publication = error instanceof ManagedPublishError ? error : undefined;
		const message =
			publication?.classification ?? managedScopeFailureMessage(error, "Managed write protocol setup failed.");
		const code = managedScopeErrorCode(message);
		return {
			kind: "error",
			code,
			message,
			cause: publication
				? { classification: publication.classification, diagnostic: publication.diagnostic }
				: managedScopeFailureCause(error),
		};
	}
}

async function openManagedCandidateForWriteInternal(
	scope: ManagedScope,
	candidate: ManagedCandidate,
	expectedIdentityOrMigrationPolicy: ResumeSessionIdentity | ManagedMigrationPolicy = "copy-retain",
	migrationPolicy: ManagedMigrationPolicy = typeof expectedIdentityOrMigrationPolicy === "string"
		? expectedIdentityOrMigrationPolicy
		: "copy-retain",
	authority?: ManagedCandidateWriteAuthority,
): Promise<ManagedOpenCandidateResult> {
	const expectedIdentity =
		typeof expectedIdentityOrMigrationPolicy === "string" ? candidate.identity : expectedIdentityOrMigrationPolicy;
	if (migrationPolicy === "disabled" && candidate.provenance === "legacy")
		return {
			kind: "error",
			code: "legacy_migration_disabled",
			message: "Legacy session migration is disabled for this workspace.",
		};
	let prepared: ManagedScopeResolution;
	let current: ManagedCandidate;
	try {
		prepared = await prepareManagedSessionScopeForWrite(
			scope,
			scope.platform === "win32" ? "windows-existing-verify-first" : "default",
			authority,
			candidate,
			expectedIdentity,
		);
		if (prepared.kind === "error")
			return {
				kind: "error",
				code: expectedFailure(new Error(prepared.code)),

				message: prepared.message,
			};
		current = revalidatePickerConsent(scope, candidate, expectedIdentity);
	} catch (error) {
		return {
			kind: "error",
			code: expectedFailure(error),
			message: error instanceof Error ? error.message : "Managed migration failed.",
		};
	}
	if (isRetired(scope, current))
		return { kind: "error", code: "migration_retired", message: "The managed session has been retired." };
	if (current.provenance === "v2") return { kind: "opened", path: current.path, candidate: current, migrated: false };

	const operation = stableOperationName(current);
	const internal = managedInternalDirectory(scope);
	let lock: ManagedStorageLock | undefined;
	let detachedArtifacts: DetachedArtifactRoot | undefined;
	let sourceArtifactCleanup: SourceArtifactCleanup | undefined;

	try {
		revalidatePickerConsent(scope, current, expectedIdentity);
		lock = await acquireManagedLock(path.join(internal, MANAGED_LOCKS_DIRECTORY), operation, scopeRoot(scope));
		const heldLock = lock;

		const afterLock = revalidatePickerConsent(scope, current, expectedIdentity);

		const listing = listManagedCandidates(scope);
		if (listing.kind === "error") return { kind: "error", code: "binding_invalid", message: listing.message };
		const destination = path.join(scope.directoryPath, path.basename(afterLock.path));
		const sameId = listing.owned.filter(item => item.provenance === "v2" && item.sessionId === afterLock.sessionId);
		const existing = sameId.find(item => path.resolve(item.path) === path.resolve(destination));
		if (sameId.some(item => item !== existing))
			return {
				kind: "error",
				code: "destination_conflict",
				message: "A distinct v2 transcript already owns this session id.",
			};

		scopeRoot(scope);
		revalidatePickerConsent(scope, afterLock, expectedIdentity);
		restorePreparedArtifactRoot(scope, afterLock, heldLock);
		scopeRoot(scope);

		let sourceSnapshot = captureManagedFileNoFollow(afterLock.path);
		if (
			sourceSnapshot.identity.dev !== afterLock.identity.dev ||
			sourceSnapshot.identity.ino !== afterLock.identity.ino ||
			sourceSnapshot.identity.size !== afterLock.identity.size ||
			sourceSnapshot.identity.mtimeNs !== afterLock.identity.mtimeNs ||
			sourceSnapshot.identity.sha256 !== afterLock.identity.sha256 ||
			sourceSnapshot.bytes.byteLength !== afterLock.identity.size
		)
			throw new Error("source_changed");
		let manifest: readonly ArtifactManifestEntry[] = [];
		const artifactPlan = planArtifactRootForMigration(afterLock.path, operation);
		const intendedDestination = { path: destination, sessionId: afterLock.sessionId, cwd: afterLock.cwd };
		const assertPublicationConsent = (): void => {
			heldLock.assertOwned();
			revalidatePickerConsent(scope, afterLock, expectedIdentity);
		};
		if (existing && existing.identity.sha256 !== afterLock.identity.sha256) {
			return {
				kind: "error",
				code: "destination_conflict",
				message: "A different v2 transcript already occupies the migration destination.",
			};
		}
		if (!existing && fs.existsSync(destination)) {
			return {
				kind: "error",
				code: "destination_conflict",
				message: "The migration destination already exists without validated ownership.",
			};
		}

		const preparedReceipt = receiptPathFor(scope, afterLock, "prepared");
		try {
			revalidatePickerConsent(scope, afterLock, expectedIdentity);
			lock.assertOwned();
			await publishManagedFileNoReplace(
				preparedReceipt,
				migrationReceipt(
					scope,
					lock,
					"prepared",
					afterLock,
					intendedDestination,
					manifest,
					artifactPlan
						? {
								path: artifactPlan.originalPath,
								detachedPath: artifactPlan.detachedPath,
								identity: artifactPlan.identity,
								tree: artifactPlan.tree,
							}
						: undefined,
				),
				assertPublicationConsent,
				scopeRoot(scope),
			);
			assertPublicationConsent();
		} catch (error) {
			if ((error as Error).message !== "destination_conflict") {
				await removeStagedReceipts(scope, afterLock);
				throw error;
			}
		}

		revalidatePickerConsent(scope, afterLock, expectedIdentity);
		lock.assertOwned();
		if (!preparedReceiptMatches(preparedReceipt, scope, afterLock, intendedDestination, artifactPlan))
			throw new Error("durability_failed");
		if (artifactPlan && fs.existsSync(artifactPlan.detachedPath)) throw new Error("destination_conflict");

		revalidatePickerConsent(scope, afterLock, expectedIdentity);

		scopeRoot(scope);

		if (artifactPlan) {
			const detached = detachArtifactRootForMigration(artifactPlan);
			detachedArtifacts = detached.detached;
			sourceArtifactCleanup = detached.detachOutcome === "cleanup_pending" ? detached.cleanup : undefined;
			const detachedReceipt = receiptPathFor(scope, afterLock, "detached");
			const detachedRecord = migrationReceipt(
				scope,
				lock,
				"artifact_detached",
				afterLock,
				intendedDestination,
				[],
				{
					path: detachedArtifacts.originalPath,
					detachedPath: detachedArtifacts.detachedPath,
					identity: detachedArtifacts.identity,
					tree: detachedArtifacts.tree,
					role: "detached_artifact_root",
				},
				sourceArtifactCleanup,
				detached.detachOutcome,
			);
			try {
				await publishManagedFileNoReplace(
					detachedReceipt,
					detachedRecord,
					assertPublicationConsent,
					scopeRoot(scope),
				);
			} catch (error) {
				if ((error as Error).message !== "destination_conflict") throw error;
			}
			if (!detachedReceiptMatches(detachedReceipt, detachedRecord)) throw new Error("durability_failed");
		}
		manifest = detachedArtifacts ? artifactManifestFromSnapshot(detachedArtifacts.tree) : [];

		await copyArtifacts(
			scope,
			afterLock.path,
			destination,
			manifest,
			lock,
			afterLock,
			expectedIdentity,
			detachedArtifacts?.detachedPath,
		);

		if (!existing) {
			revalidatePickerConsent(scope, afterLock, expectedIdentity);
			lock.assertOwned();
			sourceSnapshot = captureManagedFileNoFollow(afterLock.path);
			if (
				sourceSnapshot.identity.dev !== afterLock.identity.dev ||
				sourceSnapshot.identity.ino !== afterLock.identity.ino ||
				sourceSnapshot.identity.size !== afterLock.identity.size ||
				sourceSnapshot.identity.mtimeNs !== afterLock.identity.mtimeNs ||
				sourceSnapshot.identity.sha256 !== afterLock.identity.sha256 ||
				sourceSnapshot.bytes.byteLength !== afterLock.identity.size
			)
				throw new Error("source_changed");
		}

		if (!existing) {
			try {
				revalidatePickerConsent(scope, afterLock, expectedIdentity);
				lock.assertOwned();
				await copyManagedFileNoReplace(afterLock.path, destination, sourceSnapshot, scopeRoot(scope));
			} catch (error) {
				if ((error as Error).message !== "destination_conflict") throw error;
			}
		}

		// Artifact files, directories, and the transcript must be durable before a receipt can grant shadow authority.
		scopeRoot(scope);
		if (manifest.length > 0) fsyncManagedArtifactTree(destination.slice(0, -6));
		lock.assertOwned();
		const migrated = inspectCandidate(destination, "v2");
		if (
			"code" in migrated ||
			migrated.sessionId !== afterLock.sessionId ||
			migrated.cwd !== afterLock.cwd ||
			migrated.identity.sha256 !== afterLock.identity.sha256 ||
			!manifestMatches(destination, manifest)
		)
			throw new Error("durability_failed");

		if (detachedArtifacts) {
			revalidatePickerConsent(scope, afterLock, expectedIdentity);
			scopeRoot(scope);
			restoreDetachedArtifactRoot(detachedArtifacts, sourceArtifactCleanup);
			detachedArtifacts = undefined;
		}

		const latest = validateCandidateForScope(scope, afterLock);
		if (!latest || !sameCandidate(latest, afterLock) || !manifestMatches(afterLock.path, manifest))
			return {
				kind: "error",
				code: "source_changed",
				message: "The legacy candidate or its artifacts changed before migration commit.",
			};

		for (const state of ["published", "committed"] as const) {
			const receipt = receiptPathFor(scope, afterLock, state);
			try {
				revalidatePickerConsent(scope, afterLock, expectedIdentity);
				lock.assertOwned();
				await publishManagedFileNoReplace(
					receipt,
					migrationReceipt(
						scope,
						lock,
						state,
						afterLock,
						migrated,
						manifest,
						artifactPlan
							? {
									path: artifactPlan.originalPath,
									detachedPath: artifactPlan.detachedPath,
									identity: artifactPlan.identity,
									tree: artifactPlan.tree,
									role: "detached_artifact_root",
								}
							: undefined,
						sourceArtifactCleanup,
					),
					assertPublicationConsent,
					scopeRoot(scope),
				);
			} catch (error) {
				if ((error as Error).message !== "destination_conflict") throw error;
			}
		}

		const receipt = receiptPathFor(scope, afterLock);
		lock.assertOwned();
		if (!receiptMatches(receipt, afterLock, migrated, scope))
			return {
				kind: "error",
				code: "durability_failed",
				message: "The migration receipt does not bind the copied v2 transcript and artifacts.",
			};

		revalidatePickerConsent(scope, afterLock, expectedIdentity);
		scopeRoot(scope);
		await removeStagedReceipts(scope, afterLock);
		return {
			kind: "opened",
			path: migrated.path,
			candidate: { ...migrated, migrationState: "migrated_v2" },
			migrated: true,
		};
	} catch (error) {
		try {
			if (detachedArtifacts) restoreDetachedArtifactRoot(detachedArtifacts, sourceArtifactCleanup);
		} catch {
			return {
				kind: "error",
				code: "durability_failed",
				message: "The detached legacy artifacts could not be restored without replacing a collision.",
			};
		}
		const code = expectedFailure(error);
		return {
			kind: "error",
			code,
			message:
				code === "artifact_capacity_exceeded"
					? `Legacy session artifacts exceed the migration capacity (${MANAGED_ARTIFACT_MAX_FILES.toLocaleString()} files or ${MANAGED_ARTIFACT_MAX_TOTAL_BYTES / 1024 / 1024} MiB).`
					: error instanceof Error
						? error.message
						: "Managed migration failed.",
		};
	} finally {
		if (lock) {
			await ManagedSessionScopeTestHooks.beforeManagedLockRelease?.({ path: lock.path, attemptId: lock.attemptId });
			await lock.release();
		}
	}
}

/**
 * Open a validated candidate for mutation. Legacy transcripts are copied exactly once
 * into v2 and retained at their original location; no transcript data is merged.
 */
export async function openManagedCandidateForWrite(
	scope: ManagedScope,
	candidate: ManagedCandidate,
	expectedIdentityOrMigrationPolicy: ResumeSessionIdentity | ManagedMigrationPolicy = "copy-retain",
	migrationPolicy: ManagedMigrationPolicy = typeof expectedIdentityOrMigrationPolicy === "string"
		? expectedIdentityOrMigrationPolicy
		: "copy-retain",
	authority?: ManagedCandidateWriteAuthority,
): Promise<ManagedOpenCandidateResult> {
	try {
		return await openManagedCandidateForWriteInternal(
			scope,
			candidate,
			expectedIdentityOrMigrationPolicy,
			migrationPolicy,
			authority,
		);
	} catch (error) {
		const code = expectedFailure(error);
		if (code === "migration_busy")
			return { kind: "error", code, message: error instanceof Error ? error.message : "migration_busy" };
		throw error;
	}
}

async function deleteManagedSessionCandidateInternal(
	scope: ManagedScope,
	candidate: ManagedCandidate,
): Promise<ManagedDeleteCandidateResult> {
	try {
		assertLegacyOwnerFreeTranscript({
			transcriptPath: candidate.path,
			sessionId: candidate.sessionId,
			transcriptIdentity: candidate.identity,
		});
	} catch (error) {
		return { kind: "error", code: expectedFailure(error), message: (error as Error).message };
	}
	const prepared = await prepareManagedSessionScopeForWrite(scope);
	if (prepared.kind === "error")
		return {
			kind: "error",
			code: expectedFailure(new Error(prepared.code)),
			message: prepared.message,
		};
	const current = validateCandidateForScope(scope, candidate);
	const paired = current ? receiptPair(scope, current) : undefined;
	if (paired)
		assertLegacyOwnerFreeTranscript({
			transcriptPath: paired.path,
			sessionId: paired.sessionId,
			transcriptIdentity: paired.identity,
		});
	const logical = paired?.provenance === "legacy" ? paired : (current ?? candidate);
	const existingTombstone = tombstonePathContaining(scope, candidate);
	const tombstone =
		existingTombstone ??
		path.join(managedInternalDirectory(scope), MANAGED_TOMBSTONES_DIRECTORY, `${stableOperationName(logical)}.json`);
	if (!current && !existingTombstone)
		return { kind: "error", code: "source_changed", message: "The managed candidate changed before deletion." };
	const operation = path.basename(tombstone, ".json");
	let lock: ManagedStorageLock | undefined;
	try {
		lock = await acquireManagedLock(
			path.join(managedInternalDirectory(scope), MANAGED_LOCKS_DIRECTORY),
			operation,
			scopeRoot(scope),
		);
		let targets = retiredTargets(scope, tombstone);
		if (!targets) {
			if (!current) throw new Error("source_changed");
			targets = [current, ...(paired ? [paired] : [])];
			lock.assertOwned();
			try {
				await publishManagedTombstone(
					tombstone,
					{
						schemaVersion: 2,
						state: "retired",
						scope: scopeDigest(scope.platform, scope.canonicalCwd),
						targets: targets.map(target => ({
							path: target.path,
							sessionId: target.sessionId,
							cwd: target.cwd,
							provenance: target.provenance,
							identity: target.identity,
						})),
					},
					lock.assertOwned,
				);
			} catch (error) {
				if ((error as Error).message !== "destination_conflict") throw error;
			}
			targets = retiredTargets(scope, tombstone);
			if (!targets) throw new Error("durability_failed");
		}
		assertLegacyOwnerFreeTargets(targets);
		for (const target of targets)
			if (!cleanupCompleted(scope, tombstone, target))
				assertLegacyOwnerFreeTranscript({
					transcriptPath: target.path,
					sessionId: target.sessionId,
					transcriptIdentity: target.identity,
				});
		let deletedAny = false;
		for (const target of targets) {
			lock.assertOwned();
			const pending = pendingCleanupReceipt(scope, tombstone, target);
			const observedPending = pending ? probePlannedCleanupDetach(target, pending) : undefined;
			try {
				fs.lstatSync(target.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					if (!observedPending) continue;
					const artifactsEvidence = cleanupArtifactsRemovedEvidence(
						scope,
						tombstone,
						target,
						observedPending.artifactsRemovedAttempt ?? observedPending.attempt,
					);
					if (
						artifactsEvidence &&
						cleanupRootsAbsent(tombstone, target, observedPending, artifactsEvidence.retainedArtifactsRootPath)
					) {
						fsyncManagedParent(target.path);
						await publishCleanupCompleted(scope, tombstone, target, lock);
						continue;
					}
				} else throw error;
			}
			if (cleanupCompleted(scope, tombstone, target)) continue;
			deletedAny = true;
			const verified = observedPending ? target : validateCandidateForScope(scope, target);
			if (!verified || !sameCandidate(verified, target)) throw new Error("source_changed");
			const discoveredDetach =
				!!observedPending &&
				(observedPending.detachedArtifactsPath !== pending?.detachedArtifactsPath ||
					observedPending.detachedTranscriptPath !== pending?.detachedTranscriptPath);
			let active =
				discoveredDetach || (observedPending && requiresFreshCleanupPlan(observedPending))
					? nextCleanupReceipt(target, observedPending)
					: (observedPending ?? nextCleanupReceipt(target, undefined));
			if (!observedPending || discoveredDetach || requiresFreshCleanupPlan(observedPending))
				await publishCleanupPending(scope, tombstone, active, lock);
			const initialTarget = validateCandidateForScope(scope, target);
			if (!initialTarget) throw new Error("source_changed");
			let deletion = await deleteSessionVerifiedWithFence("direct", "initial", lock, {
				sessionsRoot: scope.sessionsRoot,
				transcriptPath: target.path,
				sessionId: target.sessionId,
				cwd: target.cwd,
				transcriptIdentity: initialTarget.identity,
				transcriptParentIdentity: (() => {
					const parent = fs.lstatSync(path.dirname(target.path), { bigint: true });
					return { dev: parent.dev, ino: parent.ino };
				})(),
				expectedArtifactsIdentity: active.expectedArtifactsIdentity,
				expectedArtifactsTree: active.expectedArtifactsTree,
				detachedArtifactsPath: active.detachedArtifactsPath ?? observedPending?.detachedArtifactsPath,
				detachedTranscriptPath:
					active.detachedTranscriptPath ??
					observedPending?.detachedTranscriptPath ??
					(pending && fs.existsSync(pending.plannedTranscriptPath) ? pending.plannedTranscriptPath : undefined),
				retainedArtifactsSuccessorPath: active.retainedArtifactsSuccessorPath,
				retainedArtifactsPlaceholderPath: active.retainedArtifactsPlaceholderPath,
				retainedArtifactsUnknownPath: active.retainedArtifactsUnknownPath,
				retainedTranscriptSuccessorPath: active.retainedTranscriptSuccessorPath,
				retainedTranscriptPlaceholderPath: active.retainedTranscriptPlaceholderPath,
				retainedTranscriptUnknownPath: active.retainedTranscriptUnknownPath,
				plannedArtifactsPath: active.plannedArtifactsPath,
				plannedTranscriptPath: active.plannedTranscriptPath,
				...(cleanupArtifactsRemoved(
					scope,
					tombstone,
					target,
					pending?.artifactsRemovedAttempt ?? active.artifactsRemovedAttempt ?? pending?.attempt ?? active.attempt,
				)
					? { artifactsRemoved: true as const }
					: {}),
			});
			if (deletion.kind === "artifacts_removed") {
				await publishCleanupArtifactsRemoved(scope, tombstone, active, lock);
				active = { ...active, artifactsRemovedAttempt: active.attempt };
				const refreshedTarget = validateCandidateForScope(scope, target);
				if (!refreshedTarget) throw new Error("source_changed");
				deletion = await deleteSessionVerifiedWithFence("direct", "transcript-after-artifacts-removed", lock, {
					sessionsRoot: scope.sessionsRoot,
					transcriptPath: target.path,
					sessionId: target.sessionId,
					cwd: target.cwd,
					transcriptIdentity: refreshedTarget.identity,
					plannedArtifactsPath: active.plannedArtifactsPath,
					plannedTranscriptPath: active.plannedTranscriptPath,
					detachedTranscriptPath: active.detachedTranscriptPath ?? observedPending?.detachedTranscriptPath,
					retainedArtifactsSuccessorPath: active.retainedArtifactsSuccessorPath,
					retainedArtifactsPlaceholderPath: active.retainedArtifactsPlaceholderPath,
					retainedArtifactsUnknownPath: active.retainedArtifactsUnknownPath,
					retainedTranscriptSuccessorPath: active.retainedTranscriptSuccessorPath,
					retainedTranscriptPlaceholderPath: active.retainedTranscriptPlaceholderPath,
					retainedTranscriptUnknownPath: active.retainedTranscriptUnknownPath,
					artifactsRemoved: true,
				});
			}
			if (deletion.kind === "cleanup_pending") {
				assertAuthorizedCleanupPending(target, active, deletion);
				const retry = nextCleanupReceipt(target, active);
				let pendingEvidence = cleanupPendingEvidence(retry, active, deletion);
				await publishCleanupPending(scope, tombstone, pendingEvidence, lock);
				if (deletion.phase === "artifacts") {
					if (
						(deletion.artifactsPayloadDurable === true &&
							retainedArtifactPayloadAbsent(deletion.detachedArtifactsPath)) ||
						(deletion.detachedArtifactsPath === active.plannedArtifactsPath &&
							!retainedArtifactPayloadAbsent(deletion.detachedArtifactsPath))
					) {
						({ deletion, pendingEvidence } = await continueDetachedArtifactCleanup(
							scope,
							tombstone,
							target,
							pendingEvidence,
							observedPending?.detachedTranscriptPath,
							lock,
							"direct",
						));
					}
					if (
						deletion.kind === "cleanup_pending" &&
						deletion.phase === "artifacts" &&
						(deletion.artifactsPayloadDurable !== true ||
							!retainedArtifactPayloadAbsent(deletion.detachedArtifactsPath))
					)
						return {
							kind: "cleanup_pending",
							tombstonePath: tombstone,
							phase: deletion.phase,
							message: "Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
						};
					await publishCleanupArtifactsRemoved(scope, tombstone, pendingEvidence, lock);
					pendingEvidence = { ...pendingEvidence, artifactsRemovedAttempt: pendingEvidence.attempt };
					const retainedProof = cleanupArtifactsRemovedReceipt(
						tombstone,
						target,
						pendingEvidence.artifactsRemovedAttempt ?? pendingEvidence.attempt,
					);
					if (!retainedProof) throw new Error("durability_failed");
					deletion = await deleteSessionVerifiedWithFence(
						"direct",
						"transcript-after-artifacts-removed",
						lock,
						{
							sessionsRoot: scope.sessionsRoot,
							transcriptPath: target.path,
							sessionId: target.sessionId,
							cwd: target.cwd,
							transcriptIdentity: {
								...target.identity,
								nlink: fs.lstatSync(target.path, { bigint: true }).nlink,
							},
							plannedArtifactsPath: pendingEvidence.plannedArtifactsPath,
							plannedTranscriptPath: pendingEvidence.plannedTranscriptPath,
							detachedTranscriptPath:
								pendingEvidence.detachedTranscriptPath ?? observedPending?.detachedTranscriptPath,
							expectedArtifactsIdentity: retainedProof.identity,
							expectedArtifactsTree: retainedProof.tree,
							detachedArtifactsPath: retainedProof.path,
							retainedArtifactsSuccessorPath: pendingEvidence.retainedArtifactsSuccessorPath,
							retainedArtifactsPlaceholderPath: pendingEvidence.retainedArtifactsPlaceholderPath,
							retainedArtifactsUnknownPath: pendingEvidence.retainedArtifactsUnknownPath,
							retainedTranscriptSuccessorPath: pendingEvidence.retainedTranscriptSuccessorPath,
							retainedTranscriptPlaceholderPath: pendingEvidence.retainedTranscriptPlaceholderPath,
							retainedTranscriptUnknownPath: pendingEvidence.retainedTranscriptUnknownPath,
							artifactsRemoved: true,
						},
						() => {
							if (
								!cleanupArtifactsRemoved(
									scope,
									tombstone,
									target,
									pendingEvidence.artifactsRemovedAttempt ?? pendingEvidence.attempt,
								)
							)
								throw new Error("durability_failed");
						},
					);
					if (deletion.kind === "cleanup_pending") {
						if (
							deletion.phase !== "transcript" ||
							(deletion.detachedTranscriptPath !== pendingEvidence.plannedTranscriptPath &&
								deletion.transcriptPayloadDurable !== true)
						)
							throw new Error("durability_failed");
						const followup = nextCleanupReceipt(target, pendingEvidence);
						pendingEvidence = cleanupPendingEvidence(followup, pendingEvidence, deletion);
						await publishCleanupPending(scope, tombstone, pendingEvidence, lock);
					}
				}
				if (
					deletion.kind === "cleanup_pending" &&
					(deletion.phase !== "transcript" ||
						deletion.transcriptPayloadDurable !== true ||
						!cleanupRootsAbsent(
							tombstone,
							target,
							pendingEvidence,
							pendingEvidence.artifactsPayloadDurable === true &&
								pendingEvidence.detachedArtifactsPath &&
								retainedArtifactPayloadAbsent(pendingEvidence.detachedArtifactsPath)
								? pendingEvidence.detachedArtifactsPath
								: undefined,
						))
				)
					return {
						kind: "cleanup_pending",
						tombstonePath: tombstone,
						phase: deletion.phase,
						message: deletion.error.message,
					};
				// A retained transcript quarantine proves canonical absence and remains
				// identity-bound in the durable pending receipt.
			}
			fsyncManagedParent(target.path);
			await publishCleanupCompleted(scope, tombstone, target, lock);
		}
		return { kind: deletedAny ? "deleted" : "already_deleted", tombstonePath: tombstone };
	} catch (error) {
		const code = expectedFailure(error);
		return { kind: "error", code, message: error instanceof Error ? error.message : "Managed deletion failed." };
	} finally {
		if (lock) {
			await ManagedSessionScopeTestHooks.beforeManagedLockRelease?.({ path: lock.path, attemptId: lock.attemptId });
			await lock.release();
		}
	}
}

/** Tombstone a verified managed candidate before exact-identity deletion. */
export async function deleteManagedSessionCandidate(
	scope: ManagedScope,
	candidate: ManagedCandidate,
): Promise<ManagedDeleteCandidateResult> {
	try {
		return await deleteManagedSessionCandidateInternal(scope, candidate);
	} catch (error) {
		const code = expectedFailure(error);
		if (code === "migration_busy")
			return { kind: "error", code, message: error instanceof Error ? error.message : "migration_busy" };
		throw error;
	}
}
