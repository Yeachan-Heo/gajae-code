import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	canonicalExistingDirectoryIdentity,
	verifyOwnerOnlyPathSecurity,
	verifyOwnerOnlyPathSecurityExpected,
} from "@gajae-code/natives";
import { pathIsWithin } from "@gajae-code/utils";
import type { ResumeSessionIdentity } from "../session-manager";
import {
	FileSessionStorage,
	type NativeDirectoryTreeSnapshot,
	type SessionStorageFileIdentity,
	type VerifiedSessionDeleteResult,
} from "../session-storage";
import {
	acquireManagedLock,
	assertManagedDirectoryRoot,
	captureManagedFileNoFollow,
	captureManagedFilePrefixNoFollow,
	copyManagedFileNoReplace,
	ensureManagedDirectory,
	fsyncManagedArtifactTree,
	type ManagedDirectoryRoot,
	type ManagedFileSnapshot,
	ManagedPublishError,
	ManagedSessionDescendantStore,
	type ManagedSessionSecurityPolicy,
	type ManagedStorageLock,
	prepareManagedDirectoryRoot,
	publishManagedFileNoReplace,
	publishManagedTombstone,
	retainManagedDirectoryAuthority,
	validateManagedArtifactTree,
	validateNativeSecurityResult,
} from "./managed-session-storage";

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

/**
 * Opaque managed writer authority captured by a trusted destination. The open
 * transaction must use this authority rather than reacquiring its root from a
 * pathname after resume inspection.
 */
export interface ManagedCandidateWriteAuthority {
	readonly rootAuthority: ManagedDirectoryRoot;
	readonly retainedAuthority?: native.RecoveryFsRoot;
	readonly retainedDirectory?: string;
}

const managedRoots = new WeakMap<ManagedScope, ReturnType<typeof prepareManagedDirectoryRoot>>();
const managedDirectoryIdentities = new WeakMap<ManagedScope, { dev: bigint; ino: bigint }>();
const managedDirectoryAuthorities = new WeakMap<ManagedScope, native.RecoveryFsRoot | undefined>();
const boundManagedWriteAuthorities = new WeakMap<ManagedScope, ManagedCandidateWriteAuthority>();

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

export function managedDirectoryAuthorityForScope(scope: ManagedScope): native.RecoveryFsRoot | undefined {
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
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
	| "atomic_unavailable"
	| "invalid_request"
	| "durability_failed"
	| "durability_not_provable";

export type ManagedScopeResolution =
	| { kind: "resolved"; scope: ManagedScope }
	| {
			kind: "error";
			code: ManagedScopeErrorCode;
			message: string;
			cause?: { readonly classification: string; readonly diagnostic?: string };
	  };

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
			invalid: readonly { code: string }[];
	  }
	| { kind: "error"; code: "scan_failed" | "unsafe_root" | "invalid_candidate"; message: string };

export type ManagedOpenFailure =
	| "migration_busy"
	| "binding_conflict"
	| "binding_invalid"
	| "destination_conflict"
	| "source_changed"
	| "unsafe_artifacts"
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
	return canonicalExistingDirectoryIdentity(cwd) as NativeIdentity;
}

function verifyExistingManagedScopeDirectory(pathname: string) {
	if (process.platform !== "win32") return verifyOwnerOnlyPathSecurity(pathname, "directory");
	const expected = fs.lstatSync(pathname, { bigint: true });
	if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error("Unsafe managed directory");
	const verified = verifyOwnerOnlyPathSecurityExpected(pathname, "directory", expected.dev, expected.ino);
	const current = fs.lstatSync(pathname, { bigint: true });
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== expected.dev ||
		current.ino !== expected.ino
	)
		throw new Error("Managed session directory changed");
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
		const identity = canonicalExistingDirectoryIdentity(base) as NativeIdentity;
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
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { kind: "error", code: "binding_invalid", message: "The managed scope binding is invalid JSON." };
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
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
	try {
		const root = fs.lstatSync(sessionsRoot);
		if (!root.isDirectory() || root.isSymbolicLink()) {
			return {
				kind: "error",
				code: "sessions_root_unavailable",
				message: "The sessions root is not a safe directory.",
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
			return { kind: "error", code: "binding_invalid", message: "The managed scope path is not a safe directory." };
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
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { kind: "error", code: "binding_invalid", message: "The managed scope path could not be inspected." };
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
		const identity = canonicalExistingDirectoryIdentity(root);
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
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && path.dirname(parent) !== parent) {
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

function fsyncCanonicalBinding(bindingPath: string, expected: string): void {
	let captured: ManagedFileSnapshot;
	try {
		captured = captureManagedFileNoFollow(bindingPath);
	} catch {
		throw new Error("binding_invalid");
	}
	if (captured.bytes.toString("utf8") !== expected) throw new Error("binding_invalid");
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(bindingPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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
	| { kind: "capture"; identity: { dev: bigint; ino: bigint; size: number; mtimeNs: bigint } }
	| {
			kind: "foreign";
	  }
	| {
			kind: "invalid";
			code: string;
	  };

function preflightCandidate(filePath: string, scope: ManagedScope): CandidatePreflight {
	try {
		const snapshot = captureManagedFilePrefixNoFollow(filePath, HEADER_MAX_BYTES);
		const lineEnd = snapshot.bytes.indexOf(0x0a);
		if (lineEnd < 0) return { kind: "invalid", code: "invalid_header" };
		const value: unknown = JSON.parse(snapshot.bytes.subarray(0, lineEnd).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			return { kind: "invalid", code: "invalid_header" };
		const header = value as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
			return { kind: "invalid", code: "invalid_header" };
		const candidateIdentity = identityFor(header.cwd);
		if (
			candidateIdentity.ok &&
			(candidateIdentity.platform !== scope.platform || candidateIdentity.canonicalPath !== scope.canonicalCwd)
		)
			return { kind: "foreign" };
		return { kind: "capture", identity: snapshot.identity };
	} catch {
		return { kind: "invalid", code: "unreadable_candidate" };
	}
}

function matchesPreflightIdentity(candidate: ManagedCandidate, preflight: CandidatePreflight): boolean {
	return (
		preflight.kind === "capture" &&
		candidate.identity.dev === preflight.identity.dev &&
		candidate.identity.ino === preflight.identity.ino &&
		candidate.identity.size === preflight.identity.size &&
		candidate.identity.mtimeNs === preflight.identity.mtimeNs
	);
}

function inspectCandidate(filePath: string, provenance: "v2" | "legacy"): ManagedCandidate | { code: string } {
	try {
		const snapshot = captureManagedFileNoFollow(filePath);
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
				mtimeMs: Number(named.mtimeMs),
				sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
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

type CandidateInspection = ManagedCandidate | { code: string } | { foreign: true };

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
			if (preflight.kind === "invalid") return { code: preflight.code };
			if (preflight.kind === "foreign") return { foreign: true };
			const candidate = inspectCandidate(filePath, provenance);
			if ("code" in candidate) return candidate;
			return matchesPreflightIdentity(candidate, preflight) ? candidate : { code: "source_changed" };
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
			if ((error as Error).message !== "destination_conflict") throw error;
			bindingCollision = true;
		}
		const validated = validateExistingBinding(scope);
		if (validated) return validated;
		if (bindingCollision) fsyncCanonicalBinding(bindingPath, binding);

		const preparedDirectory = fs.lstatSync(scope.directoryPath, { bigint: true });
		if (!preparedDirectory.isDirectory() || preparedDirectory.isSymbolicLink())
			throw new Error("Managed session directory changed");
		managedDirectoryIdentities.set(scope, { dev: preparedDirectory.dev, ino: preparedDirectory.ino });
		return { kind: "resolved", scope };
	} catch (error) {
		const publication = error instanceof ManagedPublishError ? error : undefined;
		const message =
			publication?.classification ??
			(error instanceof Error ? error.message : "The managed scope could not be initialized.");
		const code =
			message === "atomic_unavailable" ||
			message === "invalid_request" ||
			message === "durability_failed" ||
			message === "durability_not_provable"
				? message
				: "binding_invalid";

		return {
			kind: "error",
			code,
			message,
			...(publication
				? { cause: { classification: publication.classification, diagnostic: publication.diagnostic } }
				: { cause: { classification: code } }),
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
			try {
				native.applyOwnerOnlyPathSecurity(child, "directory");
			} catch {
				// Best-effort: the managed-tree snapshot re-verifies and reports genuine failures.
			}
		} else if (stat.isFile()) {
			try {
				native.applyOwnerOnlyPathSecurity(child, "file");
			} catch {
				// Best-effort, as above.
			}
		}
	}
	try {
		native.applyOwnerOnlyPathSecurity(directory, "directory");
	} catch {
		// Best-effort, as above.
	}
}

/**
 * True when a managed setup error reflects a fixable owner-only *mode* drift
 * (group/other permission bits) rather than an ownership or identity change.
 * Only mode drift can be self-healed by re-applying owner-only permissions.
 */
function isRecoverableOwnerOnlyModeDrift(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return message === "mode_mismatch" || message.endsWith(": mode_mismatch");
}

/** Synchronously create and validate the v2 binding before a default session writer exists. */
export function prepareManagedSessionScopeForWriteSync(
	scope: ManagedScope,
	policy: ManagedSessionSecurityPolicy = "default",
	authority?: ManagedCandidateWriteAuthority,
): ManagedScopeResolution {
	try {
		assertRetainedManagedDirectoryIdentity(scope);
		const root = authority?.rootAuthority ?? scopeRoot(scope, policy);
		if (authority) bindManagedWriteAuthority(scope, authority);
		ensureManagedDirectory(scope.sessionsRoot, root, policy);
		ensureManagedDirectory(scope.directoryPath, root, policy);
		const preparedDirectory = fs.lstatSync(scope.directoryPath, { bigint: true });
		if (!preparedDirectory.isDirectory() || preparedDirectory.isSymbolicLink())
			throw new Error("Managed session directory changed");
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
		let store: ManagedSessionDescendantStore;
		try {
			store = buildStore();
		} catch (error) {
			if (process.platform === "win32" && policy === "windows-existing-verify-first") throw error;
			if (!isRecoverableOwnerOnlyModeDrift(error)) throw error;
			// A prior writer left group/other-readable descendants under the scope
			// (e.g. resident-cache blobs written on the explicit session path).
			// Re-secure the tree in place and retry once before failing closed.
			reapplyOwnerOnlyManagedTree(scope.directoryPath);
			store = buildStore();
		}
		const binding = new TextEncoder().encode(`${JSON.stringify(bindingFor(scope))}\n`);
		try {
			store.publishNoReplaceSync(MANAGED_SESSION_BINDING_FILE, binding);
		} catch (error) {
			if ((error as Error).message !== "destination_conflict") throw error;
		}
		const capturedBinding = store.readExpected(MANAGED_SESSION_BINDING_FILE);
		if (!capturedBinding) throw new Error("Managed scope binding is unavailable");
		const validated = validateBindingRaw(scope, capturedBinding.bytes.toString("utf8"));
		managedDirectoryAuthorities.set(scope, retainedAuthority);
		const directoryStat = fs.lstatSync(scope.directoryPath, { bigint: true });
		if (
			!directoryStat.isDirectory() ||
			directoryStat.isSymbolicLink() ||
			directoryStat.dev !== preparedDirectory.dev ||
			directoryStat.ino !== preparedDirectory.ino
		)
			throw new Error("Managed session directory changed");
		managedDirectoryIdentities.set(scope, { dev: preparedDirectory.dev, ino: preparedDirectory.ino });
		if (validated) return validated;
		const internal = managedInternalDirectory(scope);
		ensureManagedDirectory(internal, root, policy);
		ensureManagedDirectory(path.join(internal, MANAGED_LOCKS_DIRECTORY), root, policy);
		ensureManagedDirectory(path.join(internal, MANAGED_RECEIPTS_DIRECTORY), root, policy);
		ensureManagedDirectory(path.join(internal, MANAGED_TOMBSTONES_DIRECTORY), root, policy);
		return { kind: "resolved", scope };
	} catch (error) {
		const publication = error instanceof ManagedPublishError ? error : undefined;
		const message =
			publication?.classification ??
			(error instanceof Error ? error.message : "Managed write protocol setup failed.");
		const code =
			message === "atomic_unavailable" ||
			message === "invalid_request" ||
			message === "durability_failed" ||
			message === "durability_not_provable"
				? message
				: "binding_invalid";
		return {
			kind: "error",
			code,
			message,
			...(publication
				? { cause: { classification: publication.classification, diagnostic: publication.diagnostic } }
				: code === "binding_invalid"
					? {}
					: { cause: { classification: code } }),
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
		const invalid: { code: string }[] = [];
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
					invalid.push({ code: candidate.code });
					continue;
				}
				if ("foreign" in candidate) {
					foreignCount++;
					continue;
				}
				const candidateIdentity = identityFor(candidate.cwd);
				if (!candidateIdentity.ok) {
					invalid.push({ code: `cwd_${candidateIdentity.code}` });
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
				identity?: { dev?: unknown; ino?: unknown; size?: unknown; mtimeNs?: unknown };
				tree?: unknown;
			};
		};
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

type RetiredTarget = ManagedCandidate;

function retiredTargets(scope: ManagedScope, pathname: string): readonly RetiredTarget[] | undefined {
	try {
		const value: unknown = JSON.parse(captureManagedFileNoFollow(pathname).bytes.toString("utf8"));
		if (!value || typeof value !== "object") return undefined;
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
			targets.push({
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
	} catch {
		return undefined;
	}
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
	const pathname = deterministicRemovalRoot(receipt.plannedArtifactsPath);
	if (!fs.existsSync(pathname)) return undefined;
	if (!receipt.expectedArtifactsIdentity) throw new Error("durability_failed");
	const identity = artifactIdentityAt(pathname);
	if (!identity || !sameArtifactRootIdentity(identity, receipt.expectedArtifactsIdentity))
		throw new Error("durability_failed");
	const tree = snapshotArtifactTree(pathname);
	return { path: pathname, identity, tree };
}

function retainedArtifactsRootMatches(record: Record<string, unknown>): boolean {
	if (record.retainedArtifactsRoot === undefined) return true;
	if (!record.retainedArtifactsRoot || typeof record.retainedArtifactsRoot !== "object")
		throw new Error("durability_failed");
	const retained = record.retainedArtifactsRoot as Record<string, unknown>;
	const identity = retained.identity;
	const tree = artifactTreeSnapshot(retained.tree);
	if (
		typeof record.plannedArtifactsPath !== "string" ||
		retained.path !== deterministicRemovalRoot(record.plannedArtifactsPath) ||
		!identity ||
		typeof identity !== "object" ||
		Array.isArray(identity) ||
		!tree
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
		!sameArtifactRootIdentity(observed, {
			dev: BigInt(artifactIdentity.dev),
			ino: BigInt(artifactIdentity.ino),
			size: artifactIdentity.size,
			mtimeNs: BigInt(artifactIdentity.mtimeNs),
			sha256: artifactIdentity.sha256,
		}) ||
		JSON.stringify(snapshotArtifactTree(retained.path)) !== JSON.stringify(tree)
	)
		throw new Error("durability_failed");
	return true;
}

type CleanupReceipt = {
	attempt: number;
	target: RetiredTarget;
	expectedArtifactsIdentity?: SessionStorageFileIdentity;
	expectedArtifactsTree?: NativeDirectoryTreeSnapshot;
	detachedArtifactsPath?: string;
	detachedTranscriptPath?: string;
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
		...(receipt.detachedArtifactsPath ? { detachedArtifactsPath: receipt.detachedArtifactsPath } : {}),
		...(receipt.detachedTranscriptPath ? { detachedTranscriptPath: receipt.detachedTranscriptPath } : {}),
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

function cleanupArtifactsRemoved(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	attempt: number,
): boolean {
	try {
		const value: unknown = JSON.parse(
			captureManagedFileNoFollow(cleanupReceiptPath(tombstone, target, "artifacts_removed", attempt)).bytes.toString(
				"utf8",
			),
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		const recorded = record.target as Record<string, unknown> | undefined;
		const identity = recorded?.identity as Record<string, unknown> | undefined;
		return (
			record.schemaVersion === 2 &&
			record.state === "artifacts_removed" &&
			record.scope === scopeDigest(scope.platform, scope.canonicalCwd) &&
			record.tombstone === tombstone &&
			record.attempt === attempt &&
			recorded?.path === target.path &&
			recorded.sessionId === target.sessionId &&
			recorded.cwd === target.cwd &&
			identity?.canonicalPath === target.identity.canonicalPath &&
			identity.dev === String(target.identity.dev) &&
			identity.ino === String(target.identity.ino) &&
			identity.size === target.identity.size &&
			identity.mtimeNs === String(target.identity.mtimeNs) &&
			identity.sha256 === target.identity.sha256 &&
			retainedArtifactsRootMatches(record)
		);
	} catch (error) {
		if ((error as Error).message === "durability_failed") throw error;
		return false;
	}
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

function cleanupRootsAbsent(tombstone: string, target: RetiredTarget, pending: CleanupReceipt): boolean {
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
		};
		if (isQuarantinePath(target, record.plannedArtifactsPath)) {
			roots.add(record.plannedArtifactsPath);
			roots.add(deterministicRemovalRoot(record.plannedArtifactsPath));
		}
		if (isQuarantinePath(target, record.detachedArtifactsPath)) roots.add(record.detachedArtifactsPath);
		for (const pathname of [record.plannedTranscriptPath, record.detachedTranscriptPath]) {
			if (isQuarantinePath(target, pathname) && !activeTranscriptRoots.has(pathname)) roots.add(pathname);
		}
		for (const pathname of [
			record.retainedArtifactsSuccessorPath,
			record.retainedArtifactsPlaceholderPath,
			record.retainedArtifactsUnknownPath,
			record.retainedTranscriptSuccessorPath,
			record.retainedTranscriptPlaceholderPath,
			record.retainedTranscriptUnknownPath,
		]) {
			if (isRetainedNativePath(target, pathname)) roots.add(pathname);
		}
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
	return true;
}

function sameArtifactRootIdentity(left: SessionStorageFileIdentity, right: SessionStorageFileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameArtifactTreeSnapshot(left: NativeDirectoryTreeSnapshot, right: NativeDirectoryTreeSnapshot): boolean {
	if (left.rootDev !== right.rootDev || left.rootIno !== right.rootIno || left.entries.length !== right.entries.length)
		return false;
	const entryKey = (entry: NativeDirectoryTreeSnapshot["entries"][number]): string =>
		JSON.stringify([entry.relativePath, entry.kind, entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.sha256]);
	const leftEntries = left.entries.map(entryKey).sort();
	const rightEntries = right.entries.map(entryKey).sort();
	return leftEntries.every((entry, index) => entry === rightEntries[index]);
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
	if (
		!observed ||
		!sameArtifactRootIdentity(observed, pending.expectedArtifactsIdentity) ||
		!sameArtifactTreeSnapshot(snapshotArtifactTree(pending.detachedArtifactsPath), pending.expectedArtifactsTree)
	)
		throw new Error("binding_invalid");
}

function probePlannedCleanupDetach(target: RetiredTarget, pending: CleanupReceipt): CleanupReceipt {
	assertRetainedArtifactsAuthority(pending);

	let detachedArtifactsPath = pending.detachedArtifactsPath;
	let detachedTranscriptPath = pending.detachedTranscriptPath;
	for (const pathname of [pending.plannedArtifactsPath, deterministicRemovalRoot(pending.plannedArtifactsPath)]) {
		if (!fs.existsSync(pathname)) continue;
		if (!pending.expectedArtifactsIdentity) throw new Error("durability_failed");
		const observed = artifactIdentityAt(pathname);
		if (!observed || !sameArtifactRootIdentity(observed, pending.expectedArtifactsIdentity))
			throw new Error("durability_failed");
		if (detachedArtifactsPath && detachedArtifactsPath !== pathname) throw new Error("durability_failed");
		detachedArtifactsPath = pathname;
	}
	if (fs.existsSync(pending.plannedTranscriptPath)) {
		const observed = captureManagedFileNoFollow(pending.plannedTranscriptPath);
		const digest = createHash("sha256").update(observed.bytes).digest("hex");
		if (
			observed.identity.dev !== target.identity.dev ||
			observed.identity.ino !== target.identity.ino ||
			observed.identity.size !== target.identity.size ||
			observed.identity.mtimeNs !== target.identity.mtimeNs ||
			digest !== target.identity.sha256
		)
			throw new Error("durability_failed");
		detachedTranscriptPath = pending.plannedTranscriptPath;
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
		for (const record of records) {
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
					!isRetainedNativePath(target, record.retainedTranscriptUnknownPath))
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
					![...plannedPaths].some(planned =>
						isAuthorizedArtifactRoot(target, planned, record.detachedArtifactsPath),
					)) ||
					(record.detachedTranscriptPath !== undefined && !plannedPaths.has(record.detachedTranscriptPath)))
			)
				throw new Error("durability_failed");
			plannedPaths.add(record.plannedArtifactsPath as string);
			plannedPaths.add(record.plannedTranscriptPath as string);
			latest = {
				attempt,
				target,
				expectedArtifactsIdentity,
				expectedArtifactsTree,
				detachedArtifactsPath: record.detachedArtifactsPath as string | undefined,
				detachedTranscriptPath: record.detachedTranscriptPath as string | undefined,
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
		return latest;
	} catch (error) {
		if ((error as Error).message === "durability_failed") throw error;
		return undefined;
	}
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

type NativeDirectorySnapshotApi = {
	snapshotDirectoryTree(
		pathname: string,
	): { ok: true; snapshot: NativeDirectoryTreeSnapshot } | { ok: false; code: string; snapshot?: undefined };
};
function snapshotArtifactTree(pathname: string): NativeDirectoryTreeSnapshot {
	validateManagedArtifactTree(pathname);
	const result = (native as unknown as NativeDirectorySnapshotApi).snapshotDirectoryTree(pathname);
	if (!result.ok || !result.snapshot) throw new Error(result.ok ? "unsafe_artifacts" : result.code);
	return result.snapshot;
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
		detachedArtifactsPath: pending?.detachedArtifactsPath,
		retainedArtifactsSuccessorPath: pending?.retainedArtifactsSuccessorPath,
		retainedArtifactsPlaceholderPath: pending?.retainedArtifactsPlaceholderPath,
		retainedArtifactsUnknownPath: pending?.retainedArtifactsUnknownPath,
		detachedTranscriptPath: pending?.detachedTranscriptPath,
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
		detachedArtifactsPath:
			deletion.phase === "artifacts" ? deletion.detachedArtifactsPath : active.detachedArtifactsPath,
		detachedTranscriptPath:
			deletion.phase === "transcript" ? deletion.detachedTranscriptPath : active.detachedTranscriptPath,
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
	try {
		const value: unknown = JSON.parse(
			captureManagedFileNoFollow(cleanupReceiptPath(tombstone, target, "completed", 1)).bytes.toString("utf8"),
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		const recorded = record.target as Record<string, unknown> | undefined;
		const identity = recorded?.identity as Record<string, unknown> | undefined;
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
	} catch {
		return false;
	}
}

async function publishCleanupCompleted(
	scope: ManagedScope,
	tombstone: string,
	target: RetiredTarget,
	lock: ManagedStorageLock,
): Promise<void> {
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
	} catch {
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
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };
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
	return {
		originalPath,
		detachedPath: path.join(path.dirname(originalPath), `.gjc-migrate-${operation}-artifacts`),
		identity: {
			dev: stat.dev,
			ino: stat.ino,
			size: process.platform === "win32" ? BigInt(root.size) : stat.size,
			mtimeNs: stat.mtimeNs,
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

function matchesDetachedArtifactRoot(pathname: string, plan: DetachedArtifactRoot): boolean {
	try {
		const stat = fs.lstatSync(pathname, { bigint: true });
		const snapshot = native.snapshotDirectoryTree(pathname);
		const root = snapshot.snapshot?.entries.find(entry => entry.relativePath === "" && entry.kind === "directory");
		return (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			stat.dev === plan.identity.dev &&
			stat.ino === plan.identity.ino &&
			stat.mtimeNs === plan.identity.mtimeNs &&
			(process.platform === "win32"
				? snapshot.ok && !!root && BigInt(root.size) === plan.identity.size
				: stat.size === plan.identity.size) &&
			sameDirectoryObject(path.dirname(pathname), path.dirname(plan.detachedPath))
		);
	} catch {
		return false;
	}
}

function sameArtifactTree(left: NativeDirectoryTreeSnapshot, right: NativeDirectoryTreeSnapshot): boolean {
	const entryKey = (entry: NativeDirectoryTreeSnapshot["entries"][number]): string =>
		JSON.stringify([
			entry.relativePath,
			entry.kind,
			entry.dev,
			entry.ino,
			entry.size,
			entry.mtimeNs,
			entry.ctimeNs,
			entry.sha256,
		]);
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		left.entries.length === right.entries.length &&
		left.entries
			.map(entryKey)
			.sort()
			.every((entry, index) => entry === right.entries.map(entryKey).sort()[index])
	);
}

type SourceArtifactCleanup = {
	state: "cleanup_pending";
	role: "exchange_placeholder";
	retainedPath: string;
	identity: DetachedArtifactRoot["identity"];
	tree: NativeDirectoryTreeSnapshot;
};

function cleanupAuthorityMatches(cleanup: SourceArtifactCleanup, parent: string): boolean {
	try {
		const stat = fs.lstatSync(cleanup.retainedPath, { bigint: true });
		if (
			path.dirname(cleanup.retainedPath) !== parent ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== cleanup.identity.dev ||
			stat.ino !== cleanup.identity.ino ||
			stat.size !== cleanup.identity.size ||
			stat.mtimeNs !== cleanup.identity.mtimeNs
		)
			return false;
		const snapshot = native.snapshotDirectoryTree(cleanup.retainedPath);
		return (
			!!snapshot.ok &&
			!!snapshot.snapshot &&
			sameArtifactTree(snapshot.snapshot, cleanup.tree) &&
			cleanup.tree.entries.length === 1 &&
			cleanup.tree.entries[0]?.relativePath === "" &&
			cleanup.tree.entries[0]?.kind === "directory"
		);
	} catch {
		return false;
	}
}

function detachArtifactRootForMigration(plan: DetachedArtifactRoot): {
	detached: DetachedArtifactRoot;
	cleanup?: SourceArtifactCleanup;
} {
	const result = native.exactUnlink(plan.originalPath, {
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
	if (!cleanupPending) return { detached };
	const placeholder = result.retainedPlaceholderPath!;
	const stat = fs.lstatSync(placeholder, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(placeholder) !== path.dirname(plan.originalPath))
		throw new Error("durability_failed");
	const snapshot = native.snapshotDirectoryTree(placeholder);
	const cleanup: SourceArtifactCleanup = {
		state: "cleanup_pending",
		role: "exchange_placeholder",
		retainedPath: placeholder,
		identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
		tree: snapshot.snapshot!,
	};
	if (!snapshot.ok || !snapshot.snapshot || !cleanupAuthorityMatches(cleanup, path.dirname(plan.originalPath)))
		throw new Error("durability_failed");
	return { detached, cleanup };
}

function restorePreparedArtifactRoot(scope: ManagedScope, source: ManagedCandidate): void {
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
		typeof identity.mtimeNs !== "string"
	)
		throw new Error("durability_failed");
	if (receipt === detachedReceipt && quarantine.role !== "detached_artifact_root")
		throw new Error("durability_failed");
	if (receipt === detachedReceipt) {
		const cleanup = record.sourceArtifactCleanup;
		const cleanupIdentity = cleanup?.identity;
		const cleanupTree = artifactTreeSnapshot(cleanup?.tree);
		if (
			cleanup?.state !== "cleanup_pending" ||
			cleanup.role !== "exchange_placeholder" ||
			typeof cleanup.retainedPath !== "string" ||
			!cleanupIdentity ||
			typeof cleanupIdentity.dev !== "string" ||
			typeof cleanupIdentity.ino !== "string" ||
			typeof cleanupIdentity.size !== "string" ||
			typeof cleanupIdentity.mtimeNs !== "string" ||
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
					},
					tree: cleanupTree,
				},
				path.dirname(source.path),
			)
		)
			throw new Error("durability_failed");
	}

	const expectedTree = artifactTreeSnapshot(quarantine.tree)!;
	const assertPreparedTree = (pathname: string): void => {
		validateManagedArtifactTree(pathname);
		const observed = native.snapshotDirectoryTree(pathname);
		if (!observed.ok || !observed.snapshot || !sameArtifactTree(observed.snapshot, expectedTree))
			throw new Error("durability_failed");
	};
	if (fs.existsSync(quarantine.path)) {
		const existing = fs.lstatSync(quarantine.path, { bigint: true });
		if (
			!existing.isSymbolicLink() &&
			existing.isDirectory() &&
			existing.dev === BigInt(identity.dev) &&
			existing.ino === BigInt(identity.ino) &&
			existing.size === BigInt(identity.size) &&
			existing.mtimeNs === BigInt(identity.mtimeNs)
		) {
			assertPreparedTree(quarantine.path);
		}
		// A changed source pathname is independent retained authority. Do not replace
		// it with the detached original; retain both roots for recovery.
		return;
	}
	assertPreparedTree(quarantine.detachedPath);
	const result = native.exactRestore(quarantine.detachedPath, quarantine.path, {
		dev: BigInt(identity.dev),
		ino: BigInt(identity.ino),
		size: BigInt(identity.size),
		mtimeNs: BigInt(identity.mtimeNs),
		directory: true,
	});
	if (!result.ok) throw new Error("durability_failed");
}

function restoreDetachedArtifactRoot(detached: DetachedArtifactRoot, cleanup?: SourceArtifactCleanup): void {
	if (cleanup && !cleanupAuthorityMatches(cleanup, path.dirname(detached.originalPath)))
		throw new Error("durability_failed");
	const result = native.exactRestore(detached.detachedPath, detached.originalPath, {
		...detached.identity,
		directory: true,
	});
	if (!result.ok) throw new Error("durability_failed");
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
	for (const entry of manifest) {
		revalidatePickerConsent(scope, expectedCandidate, expectedIdentity);
		lock.assertOwned();
		const source = path.join(sourceRoot, entry.path);
		const destination = path.join(destinationRoot, entry.path);
		if (entry.kind === "directory") {
			if (entry.path === "") {
				revalidatePickerConsent(scope, expectedCandidate, expectedIdentity);
				ensureManagedDirectory(destinationRoot, root);
			} else {
				revalidatePickerConsent(scope, expectedCandidate, expectedIdentity);
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
			revalidatePickerConsent(scope, expectedCandidate, expectedIdentity);
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
		`${JSON.stringify({ schemaVersion: 2, state, policy: "copy-retain", attemptId: lock.attemptId, scope: scopeDigest(scope.platform, scope.canonicalCwd), source: { path: source.path, sessionId: source.sessionId, header: { id: source.sessionId, cwd: source.cwd }, identity: source.identity, sha256: source.identity.sha256 }, destination: destinationRecord, artifactManifest: manifest, ...(sourceArtifactQuarantine ? { sourceArtifactQuarantine } : {}), ...(sourceArtifactCleanup ? { sourceArtifactCleanup } : {}) }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
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
	for (const state of ["prepared", "detached", "published"] as const) {
		const pathname = receiptPathFor(scope, candidate, state);
		try {
			const stat = fs.lstatSync(pathname);
			if (stat.isFile() || stat.isSymbolicLink()) await fs.promises.unlink(pathname);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function receiptPair(scope: ManagedScope, candidate: ManagedCandidate): ManagedCandidate | undefined {
	const directory = path.join(managedInternalDirectory(scope), MANAGED_RECEIPTS_DIRECTORY);
	try {
		for (const name of fs.readdirSync(directory)) {
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
		}
	} catch {
		/* no committed pair grants no shadow authority */
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
export async function reconcileManagedTombstones(scope: ManagedScope): Promise<void> {
	const directory = path.join(managedInternalDirectory(scope), MANAGED_TOMBSTONES_DIRECTORY);
	for (const name of fs.readdirSync(directory)) {
		const tombstone = path.join(directory, name);
		const targets = retiredTargets(scope, tombstone);
		if (!targets) continue;
		let lock: ManagedStorageLock | undefined;
		try {
			lock = await acquireManagedLock(
				path.join(managedInternalDirectory(scope), MANAGED_LOCKS_DIRECTORY),
				path.basename(tombstone, ".json"),
				scopeRoot(scope),
			);
			const lockedTargets = retiredTargets(scope, tombstone);
			if (!lockedTargets) continue;
			for (const target of lockedTargets) {
				lock.assertOwned();
				if (cleanupCompleted(scope, tombstone, target)) continue;
				const pending = pendingCleanupReceipt(scope, tombstone, target);
				const observedPending = pending ? probePlannedCleanupDetach(target, pending) : undefined;
				try {
					fs.lstatSync(target.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						if (!observedPending) continue;
						if (
							cleanupArtifactsRemoved(scope, tombstone, target, observedPending.attempt) &&
							cleanupRootsAbsent(tombstone, target, observedPending)
						) {
							fsyncManagedParent(target.path);
							await publishCleanupCompleted(scope, tombstone, target, lock);
							continue;
						}
					} else throw error;
				}
				const verified = observedPending ? target : validateCandidateForScope(scope, target);
				if (!verified || !sameCandidate(verified, target)) throw new Error("source_changed");
				const discoveredDetach =
					!!observedPending &&
					(observedPending.detachedArtifactsPath !== pending?.detachedArtifactsPath ||
						observedPending.detachedTranscriptPath !== pending?.detachedTranscriptPath);
				const active =
					discoveredDetach || (observedPending && requiresFreshCleanupPlan(observedPending))
						? nextCleanupReceipt(target, observedPending)
						: (observedPending ?? nextCleanupReceipt(target, undefined));
				if (!observedPending || discoveredDetach || requiresFreshCleanupPlan(observedPending))
					await publishCleanupPending(scope, tombstone, active, lock);
				let deletion = await new FileSessionStorage().deleteSessionVerified({
					sessionsRoot: scope.sessionsRoot,
					transcriptPath: target.path,
					sessionId: target.sessionId,
					cwd: target.cwd,
					transcriptIdentity: target.identity,
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
					...(cleanupArtifactsRemoved(scope, tombstone, target, pending?.attempt ?? active.attempt)
						? { artifactsRemoved: true as const }
						: {}),
				});
				if (deletion.kind === "artifacts_removed") {
					await publishCleanupArtifactsRemoved(scope, tombstone, active, lock);
					deletion = await new FileSessionStorage().deleteSessionVerified({
						sessionsRoot: scope.sessionsRoot,
						transcriptPath: target.path,
						sessionId: target.sessionId,
						cwd: target.cwd,
						transcriptIdentity: target.identity,
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
					const retry = nextCleanupReceipt(target, active);
					await publishCleanupPending(
						scope,
						tombstone,
						{
							...retry,
							expectedArtifactsIdentity:
								deletion.phase === "artifacts" ? deletion.artifactsIdentity : active.expectedArtifactsIdentity,
							expectedArtifactsTree:
								deletion.phase === "artifacts" ? deletion.artifactsTree : active.expectedArtifactsTree,
							detachedArtifactsPath:
								deletion.phase === "artifacts" ? deletion.detachedArtifactsPath : active.detachedArtifactsPath,
							detachedTranscriptPath:
								deletion.phase === "transcript"
									? deletion.detachedTranscriptPath
									: active.detachedTranscriptPath,
							retainedArtifactsSuccessorPath:
								deletion.phase === "artifacts"
									? deletion.retainedSuccessorPath
									: active.retainedArtifactsSuccessorPath,
							retainedArtifactsPlaceholderPath:
								deletion.phase === "artifacts"
									? deletion.retainedPlaceholderPath
									: active.retainedArtifactsPlaceholderPath,
							retainedArtifactsUnknownPath:
								deletion.phase === "artifacts"
									? deletion.retainedUnknownPath
									: active.retainedArtifactsUnknownPath,
							retainedTranscriptSuccessorPath:
								deletion.phase === "transcript"
									? deletion.retainedSuccessorPath
									: active.retainedTranscriptSuccessorPath,
							retainedTranscriptPlaceholderPath:
								deletion.phase === "transcript"
									? deletion.retainedPlaceholderPath
									: active.retainedTranscriptPlaceholderPath,
							retainedTranscriptUnknownPath:
								deletion.phase === "transcript"
									? deletion.retainedUnknownPath
									: active.retainedTranscriptUnknownPath,
						},
						lock,
					);
					continue;
				}
				fsyncManagedParent(target.path);
				await publishCleanupCompleted(scope, tombstone, target, lock);
			}
		} finally {
			if (lock) await lock.release().catch(() => undefined);
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
		await reconcileManagedTombstones(scope);
		return { kind: "resolved", scope };
	} catch (error) {
		const publication = error instanceof ManagedPublishError ? error : undefined;
		const message =
			publication?.classification ??
			(error instanceof Error ? error.message : "Managed write protocol setup failed.");
		const code =
			message === "atomic_unavailable" ||
			message === "invalid_request" ||
			message === "durability_failed" ||
			message === "durability_not_provable"
				? message
				: "binding_invalid";
		return {
			kind: "error",
			code,
			message,
			...(publication
				? { cause: { classification: publication.classification, diagnostic: publication.diagnostic } }
				: { cause: { classification: code } }),
		};
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
		restorePreparedArtifactRoot(scope, afterLock);
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
		} catch (error) {
			if ((error as Error).message !== "destination_conflict") throw error;
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
			sourceArtifactCleanup = detached.cleanup;
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
		return { kind: "error", code, message: error instanceof Error ? error.message : "Managed migration failed." };
	} finally {
		if (lock) await lock.release().catch(() => undefined);
	}
}

/** Tombstone a verified managed candidate before exact-identity deletion. */
export async function deleteManagedSessionCandidate(
	scope: ManagedScope,
	candidate: ManagedCandidate,
): Promise<ManagedDeleteCandidateResult> {
	const prepared = await prepareManagedSessionScopeForWrite(scope);
	if (prepared.kind === "error")
		return {
			kind: "error",
			code: expectedFailure(new Error(prepared.code)),
			message: prepared.message,
		};
	const current = validateCandidateForScope(scope, candidate);
	const paired = current ? receiptPair(scope, current) : undefined;
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
					if (
						cleanupArtifactsRemoved(scope, tombstone, target, observedPending.attempt) &&
						cleanupRootsAbsent(tombstone, target, observedPending)
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
			const active =
				discoveredDetach || (observedPending && requiresFreshCleanupPlan(observedPending))
					? nextCleanupReceipt(target, observedPending)
					: (observedPending ?? nextCleanupReceipt(target, undefined));
			if (!observedPending || discoveredDetach || requiresFreshCleanupPlan(observedPending))
				await publishCleanupPending(scope, tombstone, active, lock);
			let deletion = await new FileSessionStorage().deleteSessionVerified({
				sessionsRoot: scope.sessionsRoot,
				transcriptPath: target.path,
				sessionId: target.sessionId,
				cwd: target.cwd,
				transcriptIdentity: target.identity,
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
				...(cleanupArtifactsRemoved(scope, tombstone, target, pending?.attempt ?? active.attempt)
					? { artifactsRemoved: true as const }
					: {}),
			});
			if (deletion.kind === "artifacts_removed") {
				await publishCleanupArtifactsRemoved(scope, tombstone, active, lock);
				deletion = await new FileSessionStorage().deleteSessionVerified({
					sessionsRoot: scope.sessionsRoot,
					transcriptPath: target.path,
					sessionId: target.sessionId,
					cwd: target.cwd,
					transcriptIdentity: target.identity,
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
				const retry = nextCleanupReceipt(target, active);
				await publishCleanupPending(scope, tombstone, cleanupPendingEvidence(retry, active, deletion), lock);
				if (deletion.phase === "artifacts") {
					// A typed retained artifact root proves durable canonical absence; advance
					// to the transcript phase instead of stalling on the retained evidence.
					await publishCleanupArtifactsRemoved(scope, tombstone, active, lock);
					deletion = await new FileSessionStorage().deleteSessionVerified({
						sessionsRoot: scope.sessionsRoot,
						transcriptPath: target.path,
						sessionId: target.sessionId,
						cwd: target.cwd,
						transcriptIdentity: target.identity,
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
					if (deletion.kind === "cleanup_pending") {
						const followup = nextCleanupReceipt(target, active);
						await publishCleanupPending(
							scope,
							tombstone,
							cleanupPendingEvidence(followup, active, deletion),
							lock,
						);
						if (
							deletion.phase !== "transcript" ||
							deletion.detachedTranscriptPath !== active.plannedTranscriptPath
						)
							return {
								kind: "cleanup_pending",
								tombstonePath: tombstone,
								phase: deletion.phase,
								message:
									"Exact cleanup remains pending because descriptor-bound final deletion is unavailable.",
							};
					}
				}
				// A typed retained transcript quarantine is durable canonical-absence
				// evidence — never a terminal byte-deletion claim; complete the receipt.
			}
			fsyncManagedParent(target.path);
			await publishCleanupCompleted(scope, tombstone, target, lock);
		}
		return { kind: deletedAny ? "deleted" : "already_deleted", tombstonePath: tombstone };
	} catch (error) {
		const code = expectedFailure(error);
		return { kind: "error", code, message: error instanceof Error ? error.message : "Managed deletion failed." };
	} finally {
		if (lock) await lock.release().catch(() => undefined);
	}
}
