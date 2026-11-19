import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as natives from "@gajae-code/natives";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import { hasFsCode } from "@gajae-code/utils";
import type { ManagedFileSnapshot } from "./inspection";
import {
	captureManagedFileNoFollow,
	captureManagedFilePrefixNoFollow,
	inspectManagedFileNoFollow,
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	MANAGED_ARTIFACT_MAX_FILES,
	MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
	MANAGED_SESSION_READ_RANGE_MAX_BYTES,
	validateManagedArtifactTree,
	validateNativeSecurityResult,
} from "./inspection";
import type { ResumeSessionIdentity } from "./storage";

type NativeReadonlyScope = Pick<
	typeof natives,
	| "canonicalExistingDirectoryIdentity"
	| "verifyOwnerOnlyPathSecurity"
	| "verifyOwnerOnlyPathSecurityExpected"
	| "snapshotEmptyDirectory"
>;

function nativeScope(): NativeReadonlyScope {
	return require("@gajae-code/natives") as NativeReadonlyScope;
}

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

const managedScopeConfigurations = new WeakMap<
	ManagedScope,
	Readonly<
		Pick<ManagedScope, "agentDir" | "sessionsRoot" | "canonicalCwd" | "directoryName" | "directoryPath" | "platform">
	>
>();

export type ManagedScopeErrorCode =
	| "cwd_missing"
	| "cwd_not_directory"
	| "identity_unavailable"
	| "network_unsupported"
	| "sessions_root_unavailable"
	| "binding_conflict"
	| "binding_invalid"
	| "migration_busy"
	| "managed_gc_journal_capacity_exceeded"
	| "atomic_unavailable"
	| "invalid_request"
	| "permission_denied"
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

type NativeIdentity =
	| { ok: true; platform: "posix" | "win32"; canonicalPath: string }
	| { ok: false; code: NativeIdentityFailureCode };

type CanonicalNativeIdentity = Extract<NativeIdentity, { ok: true }>;

type NativeIdentityFailureCode =
	| "access_denied"
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

export function scopeDigest(platform: "posix" | "win32", canonicalPath: string): string {
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

export function identityFor(cwd: string): NativeIdentity {
	return nativeScope().canonicalExistingDirectoryIdentity(cwd) as NativeIdentity;
}

export function verifyExistingManagedScopeDirectory(pathname: string) {
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
	if (code === "access_denied")
		return {
			kind: "error",
			code: "permission_denied",
			message: "Permission was denied while identifying the workspace directory.",
		};
	if (code === "network_unsupported") {
		return {
			kind: "error",
			code: "network_unsupported",
			message: "Network workspace directories are not supported.",
		};
	}
	return { kind: "error", code: "identity_unavailable", message: "Workspace directory identity is unavailable." };
}

function nativeIdentityDiagnosticCode(code: NativeIdentityFailureCode): string {
	return code === "access_denied" ? "permission_denied" : `cwd_${code}`;
}

export function bindingFor(scope: ManagedScope): Binding {
	return {
		schemaVersion: 1,
		layoutVersion: 2,
		identityVersion: 1,
		platform: scope.platform,
		canonicalPath: scope.canonicalCwd,
		identityDigest: scope.directoryName.slice(3),
	};
}

export function isBinding(value: unknown): value is Binding {
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

export function validateBindingRaw(scope: ManagedScope, raw: string): ManagedScopeResolution | undefined {
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

export function validateExistingBinding(scope: ManagedScope): ManagedScopeResolution | undefined {
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

export interface ManagedScopeInput {
	cwd: string;
	agentDir: string;
	sessionsRoot: string;
}

export function resolveManagedScopeInternal(
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
		if (
			!security.ok &&
			(!allowRepairableAclFailure || (security.code !== "acl_verify_failed" && security.code !== "owner_mismatch"))
		) {
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

export function inspectCandidate(
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
		if (!cwdIdentity.ok) return { code: nativeIdentityDiagnosticCode(cwdIdentity.code) };
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
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || (provenance === "legacy" && code === "ENAMETOOLONG")) return [];
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
						code: nativeIdentityDiagnosticCode(candidateIdentity.code),
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
		const retired = owned.length > 0 ? retiredTargetKeys(scope) : new Set<string>();
		const visible = owned.filter(candidate => !isRetiredIn(retired, candidate));
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

export const MANAGED_INTERNAL_DIRECTORY = ".gjc-managed-session-internal";

export const MANAGED_RECEIPTS_DIRECTORY = "receipts";

export const MANAGED_TOMBSTONES_DIRECTORY = "tombstones";

export function managedInternalDirectory(scope: ManagedScope): string {
	return path.join(scope.directoryPath, MANAGED_INTERNAL_DIRECTORY);
}

export function stableOperationName(candidate: ManagedCandidate): string {
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

export function receiptPathFor(
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

export function receiptMatches(
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

export function artifactTreeSnapshot(value: unknown): NativeDirectoryTreeSnapshot | undefined {
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

export const CLEANUP_RECEIPT_REPLAY_MAX_BYTES = Math.min(
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	MANAGED_SESSION_READ_RANGE_MAX_BYTES,
);

const CLEANUP_RECEIPT_REPLAY_MAX_WORK = MANAGED_ARTIFACT_MAX_FILES * 2;

const CLEANUP_RECEIPT_REPLAY_CHUNK_BYTES = 64 * 1024;

export interface CleanupReceiptReplayBudget {
	workUnits: number;
	directoryEntries: number;
	receiptReads: number;
	readBytes: number;
}

export function cleanupReceiptReplayCapacity(): never {
	throw new Error("managed_gc_journal_capacity_exceeded");
}

export function chargeCleanupReceiptReplayWork(budget: CleanupReceiptReplayBudget, amount = 1): void {
	if (!Number.isSafeInteger(amount) || amount < 0 || budget.workUnits > CLEANUP_RECEIPT_REPLAY_MAX_WORK - amount)
		cleanupReceiptReplayCapacity();
	budget.workUnits += amount;
}

export function admitCleanupReceiptReplayRead(budget: CleanupReceiptReplayBudget, size: number): void {
	if (
		!Number.isSafeInteger(size) ||
		size < 0 ||
		size > CLEANUP_RECEIPT_REPLAY_MAX_BYTES ||
		budget.receiptReads >= MANAGED_ARTIFACT_MAX_FILES ||
		budget.readBytes > MANAGED_ARTIFACT_MAX_TOTAL_BYTES - size
	)
		cleanupReceiptReplayCapacity();
	chargeCleanupReceiptReplayWork(budget, Math.max(1, Math.ceil(size / CLEANUP_RECEIPT_REPLAY_CHUNK_BYTES)));
	budget.receiptReads++;
	budget.readBytes += size;
}

/**
 * Identity fields a retired tombstone target must match exactly for a candidate
 * to be hidden. `dev`, `ino`, and `mtimeNs` are persisted as decimal strings.
 */
type RetiredTargetIdentity = readonly [
	path: string,
	sessionId: string,
	cwd: string,
	canonicalPath: string,
	dev: string,
	ino: string,
	size: number,
	mtimeNs: string,
	sha256: string,
];

function candidateRetiredIdentity(candidate: ManagedCandidate): RetiredTargetIdentity {
	return [
		candidate.path,
		candidate.sessionId,
		candidate.cwd,
		candidate.identity.canonicalPath,
		String(candidate.identity.dev),
		String(candidate.identity.ino),
		candidate.identity.size,
		String(candidate.identity.mtimeNs),
		candidate.identity.sha256,
	];
}

/** Returns the target's identity only when every field has the type a candidate can carry. */
function parseRetiredTargetIdentity(target: unknown): RetiredTargetIdentity | undefined {
	if (!target || typeof target !== "object") return undefined;
	const value = target as { path?: unknown; sessionId?: unknown; cwd?: unknown; identity?: unknown };
	if (!value.identity || typeof value.identity !== "object") return undefined;
	const identity = value.identity as {
		canonicalPath?: unknown;
		dev?: unknown;
		ino?: unknown;
		size?: unknown;
		mtimeNs?: unknown;
		sha256?: unknown;
	};
	if (
		typeof value.path !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.cwd !== "string" ||
		typeof identity.canonicalPath !== "string" ||
		typeof identity.dev !== "string" ||
		typeof identity.ino !== "string" ||
		typeof identity.size !== "number" ||
		typeof identity.mtimeNs !== "string" ||
		typeof identity.sha256 !== "string"
	)
		return undefined;
	return [
		value.path,
		value.sessionId,
		value.cwd,
		identity.canonicalPath,
		identity.dev,
		identity.ino,
		identity.size,
		identity.mtimeNs,
		identity.sha256,
	];
}

/**
 * Key equality matches strict equality of every member: strings and finite
 * numbers encode distinctly. A non-finite tombstone `size` encodes as `null`,
 * which no candidate produces.
 */
function retiredIdentityKey(identity: RetiredTargetIdentity): string {
	return JSON.stringify(identity);
}

/**
 * Snapshot of the identities retired by a scope's tombstones.
 *
 * Tombstones are visited in directory order and the walk stops at the first
 * unreadable or malformed one: it grants no retirement authority, and neither do
 * the tombstones after it. Listing builds this once and checks every candidate
 * against it, so its cost is linear in tombstones rather than in
 * candidates x tombstones.
 */
export function retiredTargetKeys(scope: ManagedScope): ReadonlySet<string> {
	const keys = new Set<string>();
	const directory = path.join(managedInternalDirectory(scope), MANAGED_TOMBSTONES_DIRECTORY);
	const digest = scopeDigest(scope.platform, scope.canonicalCwd);
	try {
		for (const name of fs.readdirSync(directory)) {
			const pathname = path.join(directory, name);
			const value: unknown = JSON.parse(captureManagedFileNoFollow(pathname).bytes.toString("utf8"));
			if (!value || typeof value !== "object") continue;
			const record = value as { schemaVersion?: unknown; state?: unknown; scope?: unknown; targets?: unknown };
			if (
				record.schemaVersion !== 2 ||
				record.state !== "retired" ||
				record.scope !== digest ||
				!Array.isArray(record.targets)
			)
				continue;
			for (const target of record.targets) {
				const identity = parseRetiredTargetIdentity(target);
				if (identity) keys.add(retiredIdentityKey(identity));
			}
		}
	} catch {
		/* a missing/malformed tombstone grants no retirement authority */
	}
	return keys;
}

export function isRetiredIn(retired: ReadonlySet<string>, candidate: ManagedCandidate): boolean {
	return retired.has(retiredIdentityKey(candidateRetiredIdentity(candidate)));
}

export type ArtifactManifestEntry =
	| { kind: "directory"; path: string }
	| { kind: "file"; path: string; sha256: string; size: number };

export function artifactManifest(transcriptPath: string, rootOverride?: string): readonly ArtifactManifestEntry[] {
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

export type DetachedArtifactRoot = {
	originalPath: string;
	detachedPath: string;
	identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; parentDev: bigint; parentIno: bigint };
	tree: NativeDirectoryTreeSnapshot;
};

type ArtifactTreeComparisonPolicy = {
	platform?: NodeJS.Platform;
	phase?: "migration" | "strict";
};

export function sameArtifactTree(
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

export type SourceArtifactCleanup = {
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
		const snapshot = nativeScope().snapshotEmptyDirectory(cleanup.retainedPath);
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

export function managedScopeConfiguration(
	scope: ManagedScope,
):
	| Readonly<
			Pick<
				ManagedScope,
				"agentDir" | "sessionsRoot" | "canonicalCwd" | "directoryName" | "directoryPath" | "platform"
			>
	  >
	| undefined {
	return managedScopeConfigurations.get(scope);
}
