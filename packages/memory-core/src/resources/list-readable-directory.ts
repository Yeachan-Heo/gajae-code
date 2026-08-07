import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryEnvironment, MemoryScopeKind } from "../env";
import { validateMemoryEnvironment } from "../env";
import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";
import { checkInitializedRoot } from "../policy/initialized";
import { containPath, pinMemoryRoot, type RootPin, validateSafePathComponent } from "../policy/path-safety";
import type { CandidateDirectoryEntry } from "../search/candidate-universe";
import { openVerifiedDir, VerifiedStorageError } from "../storage/verified-open";

export interface ReadableDirectoryScope {
	readonly kind: string;
	readonly root: string;
}

export interface ListReadableDirectoryInput {
	readonly environment: MemoryEnvironment;
	readonly scope: ReadableDirectoryScope;
	readonly relPath?: string;
}

interface AdmittedDirectory {
	readonly root: RootPin;
	readonly relativePath: string;
	readonly absolutePath: string;
	readonly identity: DirectoryIdentity;
}

interface DirectoryIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
}

interface AdmittedEntry {
	readonly name: string;
	readonly kind: CandidateDirectoryEntry["kind"];
	readonly relativePath: string;
	readonly dev: bigint;
	readonly ino: bigint;
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

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isMemoryScopeKind(value: unknown): value is MemoryScopeKind {
	return value === "global" || value === "project" || value === "session";
}

function sameIdentity(
	left: { readonly dev: bigint; readonly ino: bigint },
	right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink;
}

function directoryIdentity(stat: fs.BigIntStats): DirectoryIdentity {
	return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink });
}

function rootRelative(root: RootPin, configuredRoot: string, scopeRoot: string): MemoryResult<string> {
	if (typeof scopeRoot !== "string" || !path.isAbsolute(scopeRoot) || scopeRoot.includes("\u0000")) {
		return invalidInput("readable directory scope root must be an absolute path");
	}
	const absolute = path.resolve(scopeRoot);
	// The caller's scope root may be expressed against a configured alias of the
	// pinned canonical root (for example `/var` versus `/private/var`). Lazy
	// scopes do not exist yet, so realpath cannot canonicalize them; compare the
	// canonical and configured roots as bases instead. Neither base may yield a
	// path that leaves the pinned root.
	for (const base of [root.canonicalPath, path.resolve(configuredRoot)]) {
		const relative = path.relative(base, absolute).split(path.sep).join("/");
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) continue;
		return { ok: true, value: relative };
	}
	return policyDenied("readable directory scope escaped the memory root");
}

function expectedScopeRoot(scope: ReadableDirectoryScope, relative: string): boolean {
	const pieces = relative.length === 0 ? [] : relative.split("/");
	if (scope.kind === "global") return pieces.length === 1 && pieces[0] === "global";
	if (scope.kind === "project") return pieces.length === 2 && pieces[0] === "projects";
	return pieces.length === 2 && pieces[0] === "sessions";
}

function admittedDirectory(
	environment: MemoryEnvironment,
	scope: ReadableDirectoryScope,
	relPath: string,
): MemoryResult<AdmittedDirectory | null> {
	if (!isMemoryScopeKind(scope?.kind)) return invalidInput("readable directory scope kind is invalid");
	if (typeof relPath !== "string") return invalidInput("readable directory relative path must be a string");
	if (relPath.includes("\\") || relPath.includes("\u0000")) {
		return policyDenied("readable directory relative path contains an unsafe separator");
	}
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	const initialized = checkInitializedRoot(validatedEnvironment.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const root = pinMemoryRoot(validatedEnvironment.value.memoryRoot);
	if (!root.ok) return root;
	const relativeScopeRoot = rootRelative(root.value, validatedEnvironment.value.memoryRoot, scope.root);
	if (!relativeScopeRoot.ok) return relativeScopeRoot;
	if (!expectedScopeRoot(scope, relativeScopeRoot.value)) {
		return policyDenied("readable directory scope root is not an admitted memory component");
	}
	const scopePath = relativeScopeRoot.value;
	const combined = scopePath.length === 0 ? relPath : relPath.length === 0 ? scopePath : `${scopePath}/${relPath}`;
	const contained = containPath(root.value, combined);
	if (!contained.ok) return contained;
	if (contained.value.leafIdentity === null) return { ok: true, value: null };
	try {
		const stat = fs.lstatSync(contained.value.absolutePath, { bigint: true });
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.value.dev) {
			return policyDenied("readable directory is not a trusted directory");
		}
		return {
			ok: true,
			value: Object.freeze({
				root: root.value,
				relativePath: contained.value.relativePath,
				absolutePath: contained.value.absolutePath,
				identity: directoryIdentity(stat),
			}),
		};
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { ok: true, value: null };
		return policyDenied("readable directory could not be inspected");
	}
}

function listEntries(admitted: AdmittedDirectory): MemoryResult<readonly CandidateDirectoryEntry[]> {
	let fd: number | undefined;
	try {
		fd = openVerifiedDir(admitted.root, admitted.relativePath);
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!sameDirectoryIdentity(admitted.identity, directoryIdentity(opened))) {
			return policyDenied("readable directory identity changed before listing");
		}
		let entries: readonly fs.Dirent[];
		try {
			entries = fs.readdirSync(admitted.absolutePath, { withFileTypes: true });
		} catch (error) {
			return policyDenied(`readable directory listing failed: ${errorCode(error) ?? "readdir-failed"}`);
		}
		const admittedEntries: AdmittedEntry[] = [];
		for (const entry of entries) {
			const safeName = validateSafePathComponent(entry.name);
			if (!safeName.ok || safeName.value !== entry.name) {
				return policyDenied("readable directory contained an unsafe entry name");
			}
			const childRelativePath = `${admitted.relativePath}/${safeName.value}`;
			const child = containPath(admitted.root, childRelativePath);
			if (!child.ok) return child;
			if (child.value.leafIdentity === null)
				return policyDenied("readable directory entry disappeared during listing");
			const stat = fs.lstatSync(child.value.absolutePath, { bigint: true });
			if (stat.isSymbolicLink() || stat.dev !== admitted.root.dev) {
				return policyDenied("readable directory contained a symlink or escaped entry");
			}
			const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
			if (kind === null) continue;
			if (
				entry.isSymbolicLink() ||
				(entry.isDirectory() && kind !== "directory") ||
				(entry.isFile() && kind !== "file")
			) {
				return policyDenied("readable directory entry type changed during listing");
			}
			admittedEntries.push({
				name: safeName.value,
				kind,
				relativePath: child.value.relativePath,
				dev: stat.dev,
				ino: stat.ino,
			});
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameDirectoryIdentity(admitted.identity, directoryIdentity(after))) {
			return policyDenied("readable directory binding changed after listing");
		}
		const rebound = containPath(admitted.root, admitted.relativePath);
		if (!rebound.ok) return rebound;
		if (
			rebound.value.leafIdentity === null ||
			!sameIdentity(rebound.value.leafIdentity, admitted.identity) ||
			rebound.value.absolutePath !== admitted.absolutePath
		) {
			return policyDenied("readable directory binding changed after listing");
		}
		for (const entry of admittedEntries) {
			const current = fs.lstatSync(
				entry.relativePath.length === 0
					? admitted.root.canonicalPath
					: path.join(admitted.root.canonicalPath, ...entry.relativePath.split("/")),
				{
					bigint: true,
				},
			);
			if (
				current.isSymbolicLink() ||
				current.dev !== entry.dev ||
				current.ino !== entry.ino ||
				(current.isDirectory() ? "directory" : current.isFile() ? "file" : null) !== entry.kind
			) {
				return policyDenied("readable directory entry binding changed after listing");
			}
		}
		admittedEntries.sort((left, right) =>
			Buffer.compare(
				Buffer.from(left.name.normalize("NFC"), "utf8"),
				Buffer.from(right.name.normalize("NFC"), "utf8"),
			),
		);
		return {
			ok: true,
			value: Object.freeze(admittedEntries.map(entry => Object.freeze({ name: entry.name, kind: entry.kind }))),
		};
	} catch (error) {
		if (error instanceof VerifiedStorageError) return policyDenied(error.reason);
		return policyDenied(`readable directory policy failed: ${errorCode(error) ?? "unknown"}`);
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Preserve the original listing result.
			}
		}
	}
}

/**
 * Enumerate one admitted memory directory. The directory descriptor is opened
 * and identity-checked before the list, then rebound after it. This detects
 * observable same-UID swaps but intentionally does not claim rooted/openat
 * prevention for the pathname interval.
 */
export function listReadableDirectory(
	input: ListReadableDirectoryInput,
): MemoryResult<readonly CandidateDirectoryEntry[]>;
export function listReadableDirectory(
	environment: MemoryEnvironment,
	scope: ReadableDirectoryScope,
	relPath?: string,
): MemoryResult<readonly CandidateDirectoryEntry[]>;
export function listReadableDirectory(
	first: ListReadableDirectoryInput | MemoryEnvironment,
	second?: ReadableDirectoryScope,
	third?: string,
): MemoryResult<readonly CandidateDirectoryEntry[]> {
	const input =
		second === undefined
			? first
			: {
					environment: first as MemoryEnvironment,
					scope: second,
					relPath: third,
				};
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("environment" in input) ||
		!("scope" in input)
	) {
		return invalidInput("readable directory input is invalid");
	}
	const candidate = input as ListReadableDirectoryInput;
	const admitted = admittedDirectory(candidate.environment, candidate.scope, candidate.relPath ?? "");
	if (!admitted.ok) return admitted;
	if (admitted.value === null) return { ok: true, value: Object.freeze([]) };
	return listEntries(admitted.value);
}
