import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	applyOwnerOnlyFdSecurity,
	applyOwnerOnlyPathSecurity,
	exactRemoveDirectoryTree,
	exactUnlink,
	type NativeDirectoryTreeSnapshot,
	type NativeOwnerOnlySecurityResult,
	openRecoveryFsRoot,
	type RecoveryFsRoot,
	renameNoReplacePath,
	repairOwnerOnlyPathSecurityExpected,
	snapshotDirectoryTree,
	verifyOwnerOnlyFdSecurity,
	verifyOwnerOnlyPathSecurity,
	verifyOwnerOnlyPathSecurityExpected,
} from "@gajae-code/natives";

export const MANAGED_ARTIFACT_MAX_DEPTH = 32;
export const MANAGED_ARTIFACT_MAX_FILES = 10_000;
export const MANAGED_ARTIFACT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MANAGED_ARTIFACT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const LOCK_LEASE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

const LOCK_STALE_RECHECK_MS = 100;

export type ManagedSessionSecurityPolicy = "default" | "windows-existing-verify-first";

export type ManagedStorageFailure =
	| "migration_busy"
	| "binding_conflict"
	| "binding_invalid"
	| "destination_conflict"
	| "source_changed"
	| "unsafe_artifacts"
	| "durability_failed"
	| "migration_retired"
	| "managed_storage_unsupported";

export interface ManagedStorageLock {
	path: string;
	attemptId: string;
	assertOwned(): void;
	release(): Promise<void>;
}

export interface ManagedFileSnapshot {
	bytes: Buffer;
	identity: { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint; sha256: string };
}

const ACL_FAILURE_CODES = new Set(["acl_denied", "acl_io_error", "acl_present", "acl_malformed", "acl_unknown"]);
const ACL_CLEAR_EVIDENCE = new Set(["cleared", "already_absent", "unsupported", "not_run"]);
const GENERAL_FAILURE_CODES = new Set([
	"acl_unavailable",
	"acl_apply_failed",
	"acl_verify_failed",
	"not_found",
	"not_directory",
	"network_unsupported",
	"reparse_point",
	"identity_unavailable",
	"identity_mismatch",
	"owner_mismatch",
	"mode_mismatch",
	"io_error",
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}
const ACL_QUERY_EVIDENCE = new Set(["absent", "unsupported"]);

export function validateNativeSecurityResult(
	value: unknown,
	operation: "apply" | "verify",
	kind: "directory" | "file",
): NativeOwnerOnlySecurityResult {
	if (!value || typeof value !== "object" || typeof (value as { ok?: unknown }).ok !== "boolean") {
		throw new Error("Malformed owner-only security result");
	}
	const result = value as Record<string, unknown>;
	if (result.ok === false) {
		if (typeof result.code !== "string") throw new Error("Malformed owner-only security failure");
		if (!ACL_FAILURE_CODES.has(result.code) && !GENERAL_FAILURE_CODES.has(result.code)) {
			throw new Error("Unknown owner-only security failure code");
		}
		if (ACL_FAILURE_CODES.has(result.code)) {
			if (
				(result.operation !== "clear" && result.operation !== "query") ||
				(result.attribute !== "access" && result.attribute !== "default")
			) {
				throw new Error("Malformed ACL security failure evidence");
			}
		} else if (result.operation !== undefined || result.attribute !== undefined) {
			throw new Error("Unexpected ACL fields on owner-only security failure");
		}
		if (!hasOnlyKeys(result, ["ok", "code", "operation", "attribute"])) {
			throw new Error("Unexpected owner-only security failure fields");
		}
		return value as NativeOwnerOnlySecurityResult;
	}
	if (process.platform !== "linux") {
		if (!hasOnlyKeys(result, ["ok"])) throw new Error("Malformed non-Linux security success");
		return value as NativeOwnerOnlySecurityResult;
	}
	if (result.platform !== "linux" || result.kind !== kind || result.protocol !== operation) {
		throw new Error("Malformed Linux security success envelope");
	}
	if (result.code !== undefined || result.operation !== undefined || result.attribute !== undefined) {
		throw new Error("Unexpected failure fields on Linux security success");
	}
	if (!hasOnlyKeys(result, ["ok", "platform", "kind", "protocol", "aclEvidence"])) {
		throw new Error("Unexpected Linux security success fields");
	}
	const evidence = result.aclEvidence;
	if (!evidence || typeof evidence !== "object") throw new Error("Missing Linux ACL evidence");
	const record = evidence as Record<string, unknown>;
	const validateAttribute = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") throw new Error("Malformed Linux ACL attribute evidence");
		const attribute = candidate as Record<string, unknown>;
		if (!hasOnlyKeys(attribute, ["clear", "query"])) throw new Error("Unexpected Linux ACL evidence fields");
		if (!ACL_CLEAR_EVIDENCE.has(String(attribute.clear)) || !ACL_QUERY_EVIDENCE.has(String(attribute.query))) {
			throw new Error("Unknown Linux ACL attribute evidence");
		}
		if (operation === "verify" && attribute.clear !== "not_run") {
			throw new Error("Verify result unexpectedly reports ACL mutation");
		}
		if (operation === "apply" && attribute.clear === "not_run") {
			throw new Error("Apply result omitted ACL mutation evidence");
		}
	};
	validateAttribute(record.access);
	if (kind === "directory") validateAttribute(record.default);
	else if (record.default !== undefined) throw new Error("File result unexpectedly carries default ACL evidence");
	if (!hasOnlyKeys(record, kind === "directory" ? ["access", "default"] : ["access"])) {
		throw new Error("Unexpected Linux ACL evidence attributes");
	}
	return value as NativeOwnerOnlySecurityResult;
}

type NativeSecurity = NativeOwnerOnlySecurityResult;
type RetainedManagedReplacer = {
	replaceManaged(
		relativePath: string,
		bytes: Uint8Array,
		expectedDev: string,
		expectedIno: string,
		expectedSize: string,
		expectedMtimeNs: string,
		expectedCtimeNs: string,
		expectedSha256: string,
	): { ok: boolean; code?: string };
	removeManaged(
		relativePath: string,
		expectedDev: string,
		expectedIno: string,
		expectedSize: string,
		expectedMtimeNs: string,
		expectedCtimeNs: string,
		expectedSha256: string,
	): { ok: boolean; code?: string };
};
type LockRecord = {
	attemptId: string;
	pid: number;
	bootId?: string;
	processStartId: string;
	createdAt: number;
	heartbeatAt: number;
	leaseExpiresAt: number;
};

/** Captured configured-root authority for managed paths only. */
export interface ManagedDirectoryRoot {
	readonly canonicalPath: string;
	readonly dev: bigint;
	readonly ino: bigint;
}

export function managedDirectoryRoot(configuredRoot: string): ManagedDirectoryRoot {
	const canonicalPath = fs.realpathSync.native(configuredRoot);
	const stat = fs.lstatSync(canonicalPath, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed root: ${configuredRoot}`);
	return Object.freeze({ canonicalPath, dev: stat.dev, ino: stat.ino });
}

export function retainManagedDirectoryAuthority(
	root: ManagedDirectoryRoot,
	directory: string,
	expected?: { dev: bigint; ino: bigint },
): RecoveryFsRoot | undefined {
	assertManagedDirectoryRoot(root);
	managedRelativePath(root, directory);
	const resolved = path.resolve(directory);
	if (process.platform !== "linux") return undefined;
	const named = fs.lstatSync(resolved, { bigint: true });
	if (!named.isDirectory() || named.isSymbolicLink()) throw new Error("Managed directory authority is unavailable");
	if (expected && (named.dev !== expected.dev || named.ino !== expected.ino))
		throw new Error("Managed directory identity changed before retention");
	const rootAuthority = openRecoveryFsRoot(root.canonicalPath);
	try {
		const retainedRoot = rootAuthority.identity();
		if (
			!retainedRoot.ok ||
			!retainedRoot.identity ||
			retainedRoot.identity.dev !== root.dev.toString() ||
			retainedRoot.identity.ino !== root.ino.toString()
		)
			throw new Error("Managed root authority changed");
		const relative = path.relative(root.canonicalPath, resolved).split(path.sep).join("/");
		return rootAuthority.retainManagedDirectory(relative, named.dev.toString(), named.ino.toString());
	} finally {
		rootAuthority.close();
	}
}

function ensureDirectoryComponent(pathname: string): boolean {
	let created = false;
	try {
		fs.mkdirSync(pathname, { mode: 0o700 });
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	assertSafeDirectory(pathname);
	return created;
}

export function assertManagedDirectoryRoot(root: ManagedDirectoryRoot): void {
	const named = fs.lstatSync(root.canonicalPath, { bigint: true });
	if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== root.dev || named.ino !== root.ino) {
		throw new Error(`Managed root authority changed: ${root.canonicalPath}`);
	}
}

/** Verify the configured root without rewriting its ownership, mode, or ACLs. */
function ensureManagedRoot(root: ManagedDirectoryRoot): void {
	assertManagedDirectoryRoot(root);
}

function managedRelativePath(root: ManagedDirectoryRoot, pathname: string): readonly string[] {
	const relative = path.relative(root.canonicalPath, path.resolve(pathname));
	if (relative === "") return [];
	if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
		throw new Error(`Managed path escapes configured root: ${pathname}`);
	return relative.split(path.sep);
}

const PROCESS_START_ID = randomUUID();

function securityError(pathname: string, result: NativeSecurity): Error {
	return new Error(
		result.ok
			? `Unexpected security state for ${pathname}`
			: `Owner-only security rejected ${pathname}: ${result.code}`,
	);
}

function secure(pathname: string, kind: "directory" | "file"): void {
	const applied = validateNativeSecurityResult(applyOwnerOnlyPathSecurity(pathname, kind), "apply", kind);
	if (!applied.ok) throw securityError(pathname, applied);
	const verified = validateNativeSecurityResult(verifyOwnerOnlyPathSecurity(pathname, kind), "verify", kind);
	if (!verified.ok) throw securityError(pathname, verified);
}

function windowsExistingVerifyFirst(policy: ManagedSessionSecurityPolicy): boolean {
	return process.platform === "win32" && policy === "windows-existing-verify-first";
}

function assertManagedPathIdentity(pathname: string, kind: "directory" | "file", expected: fs.BigIntStats): void {
	const current = fs.lstatSync(pathname, { bigint: true });
	if (current.isSymbolicLink()) throw new Error("reparse_point");
	const expectedKind = kind === "directory" ? current.isDirectory() : current.isFile();
	if (!expectedKind) throw new Error(kind === "directory" ? "not_directory" : "not_file");
	if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("identity_mismatch");
}

function verifyExistingManagedPathSecurity(
	pathname: string,
	kind: "directory" | "file",
	expected: fs.BigIntStats,
): void {
	const verified = validateNativeSecurityResult(
		verifyOwnerOnlyPathSecurityExpected(pathname, kind, expected.dev, expected.ino),
		"verify",
		kind,
	);
	assertManagedPathIdentity(pathname, kind, expected);
	if (!verified.ok) throw securityError(pathname, verified);
}

function secureExistingManagedDirectory(pathname: string, kind: "directory" | "file"): void {
	const named = fs.lstatSync(pathname, { bigint: true });
	const safeKind = kind === "directory" ? named.isDirectory() : named.isFile();
	if (!safeKind || named.isSymbolicLink()) throw new Error(`Unsafe managed ${kind}: ${pathname}`);
	const verified = validateNativeSecurityResult(
		verifyOwnerOnlyPathSecurityExpected(pathname, kind, named.dev, named.ino),
		"verify",
		kind,
	);
	assertManagedPathIdentity(pathname, kind, named);
	if (verified.ok) return;
	if (verified.code !== "acl_verify_failed") throw securityError(pathname, verified);
	const repaired = validateNativeSecurityResult(
		repairOwnerOnlyPathSecurityExpected(pathname, kind, named.dev, named.ino),
		"verify",
		kind,
	);
	if (!repaired.ok) throw securityError(pathname, repaired);
	assertManagedPathIdentity(pathname, kind, named);
}

function secureManagedDirectory(pathname: string, created: boolean, policy: ManagedSessionSecurityPolicy): void {
	if (!created && windowsExistingVerifyFirst(policy)) {
		secureExistingManagedDirectory(pathname, "directory");
		return;
	}
	secure(pathname, "directory");
}

/** Internal retained-root capability for one managed descendant subtree. */
export class ManagedSessionDescendantStore {
	readonly #root: ManagedDirectoryRoot;
	readonly #baseDir: string;
	readonly #policy: ManagedSessionSecurityPolicy;
	readonly #authority: RecoveryFsRoot | undefined;
	readonly #authorityBaseDir: string;
	readonly #subtreeRoot: ManagedDirectoryRoot;

	constructor(
		root: ManagedDirectoryRoot,
		baseDir: string,
		retained?: { authority: RecoveryFsRoot; authorityBaseDir: string },
		policy?: ManagedSessionSecurityPolicy,
	) {
		assertManagedDirectoryRoot(root);
		managedRelativePath(root, baseDir);
		this.#root = root;
		this.#baseDir = path.resolve(baseDir);
		this.#policy = policy ?? "default";
		this.#authorityBaseDir = retained?.authorityBaseDir ?? this.#baseDir;
		if (retained) {
			const relative = path.relative(retained.authorityBaseDir, this.#baseDir).split(path.sep).join("/");
			const captured = retained.authority.snapshotManagedTree(relative);
			if (!captured.ok || !captured.snapshot)
				throw new Error(captured.code ?? "Managed subtree identity unavailable");
			const subtreeStat = fs.lstatSync(this.#baseDir, { bigint: true });
			if (
				captured.snapshot.rootDev !== subtreeStat.dev.toString() ||
				captured.snapshot.rootIno !== subtreeStat.ino.toString()
			)
				throw new Error("Managed descendant root identity changed");
			this.#subtreeRoot = Object.freeze({
				canonicalPath: this.#baseDir,
				dev: subtreeStat.dev,
				ino: subtreeStat.ino,
			});
			this.#authority = retained.authority;
			return;
		}
		ensureManagedDirectory(this.#baseDir, root, this.#policy);
		const subtreeStat = fs.lstatSync(this.#baseDir, { bigint: true });
		this.#subtreeRoot = Object.freeze({ canonicalPath: this.#baseDir, dev: subtreeStat.dev, ino: subtreeStat.ino });
		if (process.platform === "linux") {
			const before = fs.lstatSync(this.#baseDir, { bigint: true });
			const authority = openRecoveryFsRoot(this.#baseDir);
			const retained = authority.identity();
			if (
				!retained.ok ||
				!retained.identity ||
				retained.identity.dev !== before.dev.toString() ||
				retained.identity.ino !== before.ino.toString()
			) {
				authority.close();
				throw new Error("Managed descendant root identity changed");
			}
			this.#authority = authority;
		}
	}

	get dir(): string {
		return this.#baseDir;
	}

	get rootAuthority(): ManagedDirectoryRoot {
		return this.#root;
	}

	get subtreeRootAuthority(): ManagedDirectoryRoot {
		return this.#subtreeRoot;
	}

	get securityPolicy(): ManagedSessionSecurityPolicy {
		return this.#policy;
	}

	deriveSubtree(relativePath: string): ManagedSessionDescendantStore {
		const child = this.ensureDirectory(relativePath);
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) return new ManagedSessionDescendantStore(this.#root, resolved, undefined, this.#policy);
		const retainedChild = this.#authority.retainManagedDirectory(
			this.#relative(resolved),
			child.dev.toString(),
			child.ino.toString(),
		);
		return new ManagedSessionDescendantStore(
			this.#root,
			resolved,
			{
				authority: retainedChild,
				authorityBaseDir: resolved,
			},
			this.#policy,
		);
	}

	retainAuthority(): RecoveryFsRoot | undefined {
		if (!this.#authority) return undefined;
		return this.#authority.retainManagedDirectory(
			"",
			this.#subtreeRoot.dev.toString(),
			this.#subtreeRoot.ino.toString(),
		);
	}

	assertBound(): void {
		this.#assertBound();
	}

	verifyRootSecurity(): void {
		this.#assertBound();
		if (this.#authority) {
			if (this.#authorityBaseDir === this.#baseDir) {
				const verified = this.#authority.verifyOwnerOnlyDirectory();
				if (!verified.ok) throw new Error(verified.code ?? "acl_verify_failed");
			} else {
				this.#assertBound();
				return;
			}
		} else {
			const named = fs.lstatSync(this.#baseDir, { bigint: true });
			if (!named.isDirectory() || named.isSymbolicLink())
				throw new Error(`Unsafe managed directory: ${this.#baseDir}`);
			if (windowsExistingVerifyFirst(this.#policy))
				verifyExistingManagedPathSecurity(this.#baseDir, "directory", named);
			else {
				const verified = validateNativeSecurityResult(
					verifyOwnerOnlyPathSecurity(this.#baseDir, "directory"),
					"verify",
					"directory",
				);
				if (!verified.ok) throw securityError(this.#baseDir, verified);
			}
		}
		this.#assertBound();
	}
	#assertBound(): void {
		if (!this.#authority) return;
		const named = fs.lstatSync(this.#baseDir, { bigint: true });
		const retained =
			this.#authorityBaseDir === this.#baseDir
				? this.#authority.identity()
				: (() => {
						const relative = path.relative(this.#authorityBaseDir, this.#baseDir).split(path.sep).join("/");
						const captured = this.#authority?.snapshotManagedTree(relative);
						return captured?.ok && captured.snapshot
							? { ok: true, identity: { dev: captured.snapshot.rootDev, ino: captured.snapshot.rootIno } }
							: { ok: false, identity: undefined };
					})();
		if (
			!retained.ok ||
			!retained.identity ||
			!named.isDirectory() ||
			named.isSymbolicLink() ||
			retained.identity.dev !== named.dev.toString() ||
			retained.identity.dev !== this.#subtreeRoot.dev.toString() ||
			retained.identity.ino !== this.#subtreeRoot.ino.toString() ||
			retained.identity.ino !== named.ino.toString()
		) {
			throw new Error("Managed descendant root binding changed");
		}
	}

	ensureDirectory(relativePath = ""): ManagedDirectoryRoot {
		this.#assertBound();
		if (this.#authority) {
			const relative = this.#relative(this.#resolve(relativePath));
			if (relative === "") return this.#subtreeRoot;
			const ensured = this.#authority.ensureManagedDirectory(relative);
			if (!ensured.ok || !ensured.identity) throw new Error(ensured.code ?? "managed_directory_create_failed");
			this.#assertBound();
			return Object.freeze({
				canonicalPath: this.#resolve(relativePath),
				dev: BigInt(ensured.identity.dev),
				ino: BigInt(ensured.identity.ino),
			});
		}
		ensureManagedDirectory(this.#resolve(relativePath), this.#root, this.#policy);
		const named = fs.lstatSync(this.#resolve(relativePath), { bigint: true });
		return Object.freeze({ canonicalPath: this.#resolve(relativePath), dev: named.dev, ino: named.ino });
	}

	async publishNoReplace(relativePath: string, bytes: Uint8Array): Promise<void> {
		const resolved = this.#resolve(relativePath);
		if (this.#authority) {
			this.#assertBound();
			this.#publishRetainedNoReplace(this.#relative(resolved), bytes);
			this.#assertBound();
			return;
		}
		await publishManagedFileNoReplace(resolved, bytes, undefined, this.#root, this.#policy);
	}

	publishNoReplaceSync(relativePath: string, bytes: Uint8Array): void {
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			publishManagedFileNoReplaceSync(resolved, bytes, this.#root, this.#policy);
			this.#assertBound();
			return;
		}
		this.#assertBound();
		this.#publishRetainedNoReplace(this.#relative(resolved), bytes);
		this.#assertBound();
	}

	async replace(relativePath: string, bytes: Uint8Array): Promise<void> {
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			await replaceManagedFile(resolved, bytes, this.#subtreeRoot, this.#policy);
			this.#assertBound();
			return;
		}
		const relative = this.#relative(resolved);
		this.#replaceRetained(relative, bytes);
		this.#assertBound();
	}

	replaceSync(relativePath: string, bytes: Uint8Array): void {
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			replaceManagedFileSync(resolved, bytes, this.#subtreeRoot, this.#policy);
			this.#assertBound();
			return;
		}
		this.#replaceRetained(this.#relative(resolved), bytes);
		this.#assertBound();
	}

	appendSync(relativePath: string, bytes: Uint8Array): void {
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		const existing = this.readExpected(relativePath);
		if (!existing) throw new Error("managed_append_missing");
		if (this.#authority) {
			const appended = this.#authority.appendManaged(
				this.#relative(resolved),
				bytes,
				existing.identity.dev.toString(),
				existing.identity.ino.toString(),
				existing.identity.size.toString(),
				existing.identity.mtimeNs.toString(),
				existing.identity.ctimeNs.toString(),
				existing.identity.sha256,
			);
			if (!appended.ok) throw new Error(appended.code ?? "managed_append_failed");
			this.#assertBound();
			return;
		}
		let fd: number | undefined;
		try {
			fd = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
			const before = identity(fs.fstatSync(fd, { bigint: true }));
			if (!sameIdentity(before, existing.identity)) throw new Error("identity_mismatch");
			secureFileDescriptor(resolved, fd, "verify");
			let offset = 0;
			while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
			fs.fsyncSync(fd);
			secureFileDescriptor(resolved, fd, "verify");
			const after = identity(fs.fstatSync(fd, { bigint: true }));
			const named = identity(fs.lstatSync(resolved, { bigint: true }));
			if (!sameIdentity(after, named) || after.dev !== before.dev || after.ino !== before.ino)
				throw new Error("identity_mismatch");
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		this.#assertBound();
	}

	#relative(resolved: string): string {
		return path.relative(this.#authorityBaseDir, resolved).split(path.sep).join("/");
	}

	#publishRetainedNoReplace(relative: string, bytes: Uint8Array): void {
		if (!this.#authority) throw new Error("Managed descendant authority is unavailable");
		const separator = relative.lastIndexOf("/");
		const parent = separator < 0 ? "" : relative.slice(0, separator);
		const temporaryName = `.gjc-publish-${process.pid}-${randomUUID()}`;
		const temporary = parent ? `${parent}/${temporaryName}` : temporaryName;
		const created = this.#authority.createManaged(temporary, bytes);
		if (!created.ok) throw new Error(created.code ?? "managed_publish_failed");
		if (!created.identity) throw new Error("managed_publish_identity_unavailable");
		let captured: ReturnType<RecoveryFsRoot["readManaged"]> | undefined;
		try {
			captured = this.#authority.readManaged(temporary);
			if (!captured.ok || !captured.identity || !captured.data)
				throw new Error(captured.code ?? "managed_publish_identity_unavailable");
			const expectedDigest = createHash("sha256").update(bytes).digest("hex");
			const digest = captured.identity.sha256 ?? createHash("sha256").update(captured.data).digest("hex");
			if (
				captured.identity.dev !== created.identity.dev ||
				captured.identity.ino !== created.identity.ino ||
				captured.identity.size !== created.identity.size ||
				captured.identity.mtimeNs !== created.identity.mtimeNs ||
				captured.identity.ctimeNs !== created.identity.ctimeNs ||
				digest !== expectedDigest
			)
				throw new Error("managed_publish_identity_mismatch");
			const synced = this.#authority.fsyncExpected(
				temporary,
				false,
				captured.identity.dev,
				captured.identity.ino,
				captured.identity.size,
				captured.identity.mtimeNs,
				digest,
			);
			if (!synced.ok) throw new Error(synced.code ?? "managed_publish_fsync_failed");
			const published = this.#authority.renameManagedFileNoReplace(
				temporary,
				relative,
				captured.identity.dev,
				captured.identity.ino,
				captured.identity.size,
				captured.identity.mtimeNs,
				captured.identity.ctimeNs,
				digest,
			);
			if (!published.ok)
				throw new Error(
					published.code === "already_exists"
						? "destination_conflict"
						: (published.code ?? "managed_publish_failed"),
				);
		} catch (error) {
			if (captured?.ok && captured.identity && captured.data) {
				const digest = captured.identity.sha256 ?? createHash("sha256").update(captured.data).digest("hex");
				const installed = this.#authority.readManaged(relative);
				if (
					installed.ok &&
					installed.identity &&
					installed.data &&
					installed.identity.dev === captured.identity.dev &&
					installed.identity.ino === captured.identity.ino &&
					(installed.identity.sha256 ?? createHash("sha256").update(installed.data).digest("hex")) === digest
				) {
					const removed = this.#authority.removeManaged(
						relative,
						installed.identity.dev,
						installed.identity.ino,
						installed.identity.size,
						installed.identity.mtimeNs,
						installed.identity.ctimeNs,
						digest,
					);
					if (!removed.ok) throw new Error(removed.code ?? "managed_publish_reconcile_failed");
				}
				const staged = this.#authority.readManaged(temporary);
				if (
					staged.ok &&
					staged.identity &&
					staged.data &&
					staged.identity.dev === captured.identity.dev &&
					staged.identity.ino === captured.identity.ino
				) {
					const removed = this.#authority.removeManaged(
						temporary,
						staged.identity.dev,
						staged.identity.ino,
						staged.identity.size,
						staged.identity.mtimeNs,
						staged.identity.ctimeNs,
						staged.identity.sha256 ?? createHash("sha256").update(staged.data).digest("hex"),
					);
					if (!removed.ok) throw new Error(removed.code ?? "managed_publish_reconcile_failed");
				}
			}
			throw error;
		}
	}

	#replaceRetained(relative: string, bytes: Uint8Array): void {
		if (!this.#authority) throw new Error("Managed descendant authority is unavailable");
		this.#assertBound();
		const existing = this.#authority.readManaged(relative);
		if (!existing.ok) {
			if (existing.code !== "not_found") throw new Error(existing.code ?? "managed_replace_failed");
			this.#publishRetainedNoReplace(relative, bytes);
			return;
		}
		if (!existing.identity || !existing.data) throw new Error("Managed descendant identity is unavailable");
		const replaced = (this.#authority as RecoveryFsRoot & RetainedManagedReplacer).replaceManaged(
			relative,
			bytes,
			existing.identity.dev,
			existing.identity.ino,
			existing.identity.size,
			existing.identity.mtimeNs,
			existing.identity.ctimeNs,
			existing.identity.sha256 ?? createHash("sha256").update(existing.data).digest("hex"),
		);
		if (!replaced.ok) throw new Error(replaced.code ?? "managed_replace_failed");
	}

	/** Read an exact managed file without exposing its pathname as authority. */
	readExpected(relativePath: string): ManagedFileSnapshot | null {
		this.#assertBound();
		const relative = this.#relative(this.#resolve(relativePath));
		if (!this.#authority) {
			try {
				return captureManagedFileNoFollow(this.#resolve(relativePath));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		}
		const read = this.#authority.readManaged(relative);
		if (!read.ok) {
			if (read.code === "not_found") return null;
			throw new Error(read.code ?? "managed_read_failed");
		}
		if (!read.data || !read.identity) throw new Error("Managed descendant identity is unavailable");
		return {
			bytes: Buffer.from(read.data),
			identity: {
				dev: BigInt(read.identity.dev),
				ino: BigInt(read.identity.ino),
				size: Number(read.identity.size),
				mtimeNs: BigInt(read.identity.mtimeNs),
				ctimeNs: BigInt(read.identity.ctimeNs),
				sha256: read.identity.sha256 ?? createHash("sha256").update(read.data).digest("hex"),
			},
		};
	}

	/** Remove an exact captured file without reopening its pathname as authority. */
	removeExpected(relativePath: string, expected: ManagedFileSnapshot): void {
		this.#assertBound();
		if (!this.#authority) {
			const removed = exactUnlink(this.#resolve(relativePath), {
				dev: expected.identity.dev,
				ino: expected.identity.ino,
				size: BigInt(expected.identity.size),
				mtimeNs: expected.identity.mtimeNs,
				sha256: expected.identity.sha256,
				quarantineName: `.gjc-remove-${process.pid}-${randomUUID()}`,
			});
			if (!removed.ok) throw new Error(removed.code ?? "managed_remove_failed");
			this.#assertBound();
			return;
		}
		const removed = (this.#authority as RecoveryFsRoot & RetainedManagedReplacer).removeManaged(
			this.#relative(this.#resolve(relativePath)),
			expected.identity.dev.toString(),
			expected.identity.ino.toString(),
			expected.identity.size.toString(),
			expected.identity.mtimeNs.toString(),
			expected.identity.ctimeNs.toString(),
			expected.identity.sha256,
		);
		if (!removed.ok) throw new Error(removed.code ?? "managed_remove_failed");
		this.#assertBound();
	}
	/** Read and remove one managed descendant through retained authority. */
	async consume(relativePath: string): Promise<Uint8Array | null> {
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (this.#authority) {
			const relative = this.#relative(resolved);
			const existing = this.#authority.readManaged(relative);
			if (!existing.ok) {
				if (existing.code === "not_found") return null;
				throw new Error(existing.code ?? "managed_read_failed");
			}
			if (!existing.identity || !existing.data) throw new Error("Managed descendant identity is unavailable");
			const removed = (this.#authority as RecoveryFsRoot & RetainedManagedReplacer).removeManaged(
				relative,
				existing.identity.dev,
				existing.identity.ino,
				existing.identity.size,
				existing.identity.mtimeNs,
				existing.identity.ctimeNs,
				existing.identity.sha256 ?? createHash("sha256").update(existing.data).digest("hex"),
			);
			if (!removed.ok) throw new Error(removed.code ?? "managed_consume_failed");
			this.#assertBound();
			return existing.data;
		}
		let snapshot: ManagedFileSnapshot;
		try {
			snapshot = captureManagedFileNoFollow(resolved);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		await unlinkManagedFileVerified(resolved, snapshot.identity);
		this.#assertBound();
		return snapshot.bytes;
	}

	/** Remove one managed descendant through retained authority when it exists. */
	async remove(relativePath: string): Promise<void> {
		await this.consume(relativePath);
	}

	/** Capture a complete descendant tree through this retained root. */
	captureTree(relativePath: string): NativeDirectoryTreeSnapshot {
		this.#assertBound();
		const relative = this.#relative(this.#resolve(relativePath));
		if (this.#authority) {
			const captured = this.#authority.snapshotManagedTree(relative);
			if (!captured.ok || !captured.snapshot) throw new Error(captured.code ?? "unsafe_artifacts");
			return captured.snapshot;
		}
		const captured = snapshotDirectoryTree(this.#resolve(relativePath));
		if (!captured.ok || !captured.snapshot) throw new Error(captured.code ?? "unsafe_artifacts");
		return captured.snapshot;
	}

	/** Copy an exact captured tree into an absent managed destination. */
	async importTree(
		sourceRelativePath: string,
		destinationRelativePath: string,
		snapshot: NativeDirectoryTreeSnapshot,
	): Promise<void> {
		const actual = this.captureTree(sourceRelativePath);
		if (JSON.stringify(actual) !== JSON.stringify(snapshot)) throw new Error("artifact_source_changed");
		this.ensureDirectory(destinationRelativePath);
		for (const entry of snapshot.entries) {
			if (entry.relativePath === "") continue;
			const target = path.posix.join(destinationRelativePath.replaceAll(path.sep, "/"), entry.relativePath);
			if (entry.kind === "directory") this.ensureDirectory(target);
			else {
				if (!this.#authority) throw new Error("managed_storage_unsupported");
				const read = this.#authority.readManaged(
					this.#relative(
						this.#resolve(path.posix.join(sourceRelativePath.replaceAll(path.sep, "/"), entry.relativePath)),
					),
				);
				if (
					!read.ok ||
					!read.data ||
					!read.identity ||
					read.identity.dev !== entry.dev ||
					read.identity.ino !== entry.ino ||
					read.identity.size !== entry.size ||
					read.identity.mtimeNs !== entry.mtimeNs ||
					createHash("sha256").update(read.data).digest("hex") !== entry.sha256
				)
					throw new Error("artifact_source_changed");
				await this.publishNoReplace(target, read.data);
			}
		}
		const imported = this.captureTree(destinationRelativePath);
		const comparable = (tree: NativeDirectoryTreeSnapshot) =>
			tree.entries.map(entry => ({
				relativePath: entry.relativePath,
				kind: entry.kind,
				size: entry.size,
				sha256: entry.sha256,
			}));
		if (JSON.stringify(comparable(imported)) !== JSON.stringify(comparable(snapshot)))
			throw new Error("artifact_destination_mismatch");
		this.fsyncTree();
	}

	moveTreeNoReplace(
		sourceRelativePath: string,
		destinationRelativePath: string,
		expected: NativeDirectoryTreeSnapshot,
	): void {
		this.#assertBound();
		if (!this.#authority) {
			const source = this.#resolve(sourceRelativePath);
			const destination = this.#resolve(destinationRelativePath);
			if (fs.existsSync(destination)) throw new Error("already_exists");
			let destinationSnapshot: NativeDirectoryTreeSnapshot | undefined;
			try {
				this.ensureDirectory(destinationRelativePath);
				destinationSnapshot = this.captureTree(destinationRelativePath);
				for (const entry of expected.entries) {
					if (entry.relativePath === "") continue;
					const target = path.posix.join(destinationRelativePath.replaceAll(path.sep, "/"), entry.relativePath);
					if (entry.kind === "directory") {
						this.ensureDirectory(target);
						destinationSnapshot = this.captureTree(destinationRelativePath);
						continue;
					}
					const sourceEntry = this.readExpected(
						path.posix.join(sourceRelativePath.replaceAll(path.sep, "/"), entry.relativePath),
					);
					if (
						!sourceEntry ||
						sourceEntry.identity.dev.toString() !== entry.dev ||
						sourceEntry.identity.ino.toString() !== entry.ino ||
						sourceEntry.identity.size.toString() !== entry.size ||
						sourceEntry.identity.mtimeNs.toString() !== entry.mtimeNs ||
						sourceEntry.identity.sha256 !== entry.sha256
					)
						throw new Error("artifact_source_changed");
					this.publishNoReplaceSync(target, sourceEntry.bytes);
					destinationSnapshot = this.captureTree(destinationRelativePath);
				}
				destinationSnapshot = this.captureTree(destinationRelativePath);
				const comparable = (tree: NativeDirectoryTreeSnapshot) =>
					tree.entries.map(entry => ({
						relativePath: entry.relativePath,
						kind: entry.kind,
						size: entry.size,
						sha256: entry.sha256,
					}));
				if (JSON.stringify(comparable(destinationSnapshot)) !== JSON.stringify(comparable(expected)))
					throw new Error("artifact_destination_mismatch");
				const terminalSource = snapshotDirectoryTree(source);
				if (
					!terminalSource.ok ||
					!terminalSource.snapshot ||
					JSON.stringify(terminalSource.snapshot) !== JSON.stringify(expected)
				)
					throw new Error("artifact_source_changed");
				const retired = exactRemoveDirectoryTree(source, expected);
				if (!retired.ok) throw new Error(retired.code ?? "managed_remove_failed");
			} catch (error) {
				if (destinationSnapshot) {
					const removed = exactRemoveDirectoryTree(destination, destinationSnapshot);
					if (!removed.ok) throw new Error(removed.code ?? "managed_publish_reconcile_failed");
				}
				throw error;
			}
			this.#assertBound();
			return;
		}
		const moved = this.#authority.renameManagedTreeNoReplace(
			this.#relative(this.#resolve(sourceRelativePath)),
			this.#relative(this.#resolve(destinationRelativePath)),
			expected,
		);
		if (!moved.ok) {
			try {
				const installed = this.captureTree(destinationRelativePath);
				const comparable = (tree: NativeDirectoryTreeSnapshot) =>
					tree.entries.map(entry => ({
						relativePath: entry.relativePath,
						kind: entry.kind,
						size: entry.size,
						sha256: entry.sha256,
					}));
				if (JSON.stringify(comparable(installed)) !== JSON.stringify(comparable(expected)))
					throw new Error("managed_publish_reconcile_failed");
				this.removeTreeExpected(destinationRelativePath, installed);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "not_found") throw error;
			}
			throw new Error(moved.code ?? "managed_move_failed");
		}
		this.#assertBound();
	}

	removeTreeExpected(relativePath: string, expected: NativeDirectoryTreeSnapshot): void {
		this.#assertBound();
		if (!this.#authority) {
			const removed = exactRemoveDirectoryTree(this.#resolve(relativePath), expected);
			if (!removed.ok) throw new Error(removed.code ?? "managed_remove_failed");
			this.#assertBound();
			return;
		}
		const removed = this.#authority.removeManagedTree(this.#relative(this.#resolve(relativePath)), expected);
		if (!removed.ok) throw new Error(removed.code ?? "managed_remove_failed");
		this.#assertBound();
	}
	fsyncTree(): NativeDirectoryTreeSnapshot {
		this.#assertBound();
		if (!this.#authority) return fsyncManagedArtifactTree(this.#baseDir);
		const baseRelative = this.#relative(this.#baseDir);
		const before = this.#authority.snapshotManagedTree(baseRelative);
		if (!before.ok || !before.snapshot) throw new Error(before.code ?? "unsafe_artifacts");
		const entries = [...before.snapshot.entries].sort((left, right) => {
			const leftDirectory = left.kind === "directory";
			const rightDirectory = right.kind === "directory";
			if (leftDirectory !== rightDirectory) return leftDirectory ? 1 : -1;
			return right.relativePath.split("/").length - left.relativePath.split("/").length;
		});
		for (const entry of entries) {
			const retainedPath = entry.relativePath ? path.posix.join(baseRelative, entry.relativePath) : baseRelative;
			const synced = this.#authority.fsyncExpected(
				retainedPath,
				entry.kind === "directory",
				entry.dev,
				entry.ino,
				entry.size,
				entry.mtimeNs,
				entry.sha256,
			);
			if (!synced.ok) throw new Error(synced.code ?? "fsync_failed");
		}
		const after = this.#authority.snapshotManagedTree(baseRelative);
		if (!after.ok || !after.snapshot || JSON.stringify(after.snapshot) !== JSON.stringify(before.snapshot)) {
			throw new Error("artifact_tree_changed_during_fsync");
		}
		this.#assertBound();
		return after.snapshot;
	}

	#resolve(relativePath: string): string {
		if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
			throw new Error("Managed descendant path escapes retained store");
		}
		const resolved = path.resolve(this.#baseDir, relativePath);
		if (resolved !== this.#baseDir && !resolved.startsWith(`${this.#baseDir}${path.sep}`)) {
			throw new Error("Managed descendant path escapes retained store");
		}
		assertManagedDirectoryRoot(this.#root);
		return resolved;
	}
}

function secureFileDescriptor(pathname: string, fd: number, operation: "apply" | "verify"): void {
	if (process.platform !== "linux") {
		if (operation === "apply") secure(pathname, "file");
		else {
			const verified = validateNativeSecurityResult(verifyOwnerOnlyPathSecurity(pathname, "file"), "verify", "file");
			if (!verified.ok) throw securityError(pathname, verified);
		}
		return;
	}
	const result = validateNativeSecurityResult(
		operation === "apply"
			? applyOwnerOnlyFdSecurity(pathname, "file", fd)
			: verifyOwnerOnlyFdSecurity(pathname, "file", fd),
		operation,
		"file",
	);
	if (!result.ok) throw securityError(pathname, result);
}

function assertSafeDirectory(pathname: string): void {
	const stat = fs.lstatSync(pathname);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${pathname}`);
}

export function shouldFsyncManagedDirectory(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

function fsyncDirectory(pathname: string): void {
	if (!shouldFsyncManagedDirectory()) return;
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function bootId(): string | undefined {
	try {
		return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return undefined;
	}
}

function identity(stat: fs.BigIntStats, sha256 = ""): ManagedFileSnapshot["identity"] {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: Number(stat.size),
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
		sha256,
	};
}

function sameIdentity(left: ManagedFileSnapshot["identity"], right: ManagedFileSnapshot["identity"]): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function parseLock(pathname: string): LockRecord | undefined {
	try {
		const stat = fs.lstatSync(pathname);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		const value: unknown = JSON.parse(fs.readFileSync(pathname, "utf8"));
		if (!value || typeof value !== "object") return undefined;
		const record = value as Partial<LockRecord>;
		return typeof record.attemptId === "string" &&
			typeof record.pid === "number" &&
			typeof record.processStartId === "string" &&
			typeof record.leaseExpiresAt === "number" &&
			typeof record.heartbeatAt === "number" &&
			typeof record.createdAt === "number"
			? (record as LockRecord)
			: undefined;
	} catch {
		return undefined;
	}
}

function ownerDefinitelyGone(record: LockRecord): boolean {
	if (record.bootId && bootId() && record.bootId !== bootId()) return true;
	try {
		process.kill(record.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function writeLockDescriptor(fd: number, record: LockRecord): void {
	const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
	const written = fs.writeSync(fd, encoded, 0, encoded.byteLength, 0);
	if (written !== encoded.byteLength) throw new Error("durability_failed");
	fs.fsyncSync(fd);
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Create a managed directory and fail closed unless its owner-only mode/ACL verifies. */
export function ensureManagedDirectory(
	pathname: string,
	root?: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): void {
	if (!root) {
		let existed = false;
		try {
			const named = fs.lstatSync(pathname);
			existed = true;
			if (!named.isDirectory() || named.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${pathname}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		fs.mkdirSync(pathname, { recursive: true, mode: 0o700 });
		assertSafeDirectory(pathname);
		if (existed && windowsExistingVerifyFirst(policy)) secureExistingManagedDirectory(pathname, "directory");
		else secure(pathname, "directory");
		return;
	}
	ensureManagedRoot(root);
	const components = managedRelativePath(root, pathname);
	if (components.length === 0) {
		if (windowsExistingVerifyFirst(policy)) secureExistingManagedDirectory(root.canonicalPath, "directory");
		return;
	}
	let current = root.canonicalPath;
	if (windowsExistingVerifyFirst(policy)) secureExistingManagedDirectory(current, "directory");
	else secure(current, "directory");
	for (const component of components) {
		// Re-inspect the captured root or already-secured descendant before every
		// descent; a replaced component cannot grant authority to the next one.
		if (current === root.canonicalPath) assertManagedDirectoryRoot(root);
		else assertSafeDirectory(current);
		current = path.join(current, component);
		const created = ensureDirectoryComponent(current);
		secureManagedDirectory(current, created, policy);
	}
}

/** Captures a bounded prefix from one no-follow descriptor and rechecks the pathname before use. */
export function captureManagedFilePrefixNoFollow(pathname: string, maxBytes: number): ManagedFileSnapshot {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_capture_limit");
	return captureManagedFileNoFollowLimit(pathname, maxBytes);
}

/** Captures header/hash/copy input from one no-follow descriptor and rechecks the pathname before use. */
export function captureManagedFileNoFollow(pathname: string): ManagedFileSnapshot {
	return captureManagedFileNoFollowLimit(pathname);
}

function captureManagedFileNoFollowLimit(pathname: string, maxBytes?: number): ManagedFileSnapshot {
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.nlink > 1) throw new Error("source_changed");
		const captureSize = maxBytes === undefined ? Number(before.size) : Math.min(Number(before.size), maxBytes);
		const bytes = Buffer.alloc(captureSize);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const count = fs.readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
			if (count === 0) throw new Error("source_changed");
			offset += count;
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameIdentity(identity(before), identity(after))) throw new Error("source_changed");
		const named = fs.lstatSync(pathname, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(identity(before), identity(named)))
			throw new Error("source_changed");
		return { bytes, identity: identity(before, createHash("sha256").update(bytes).digest("hex")) };
	} finally {
		fs.closeSync(fd);
	}
}

/** Atomically publishes bytes without replacing an existing destination. */
export async function publishManagedFileNoReplace(
	destination: string,
	bytes: Uint8Array,
	assertOwned?: () => void,
	root?: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): Promise<void> {
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent, root, policy);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
	let fd: number | undefined;
	let stagingIdentity: { dev: bigint; ino: bigint } | undefined;
	let stagingSnapshot: ManagedFileSnapshot | undefined;
	let committed = false;
	let failure: unknown;
	try {
		assertOwned?.();
		fd = fs.openSync(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		secureFileDescriptor(staging, fd, "apply");
		let offset = 0;
		while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
		fs.fsyncSync(fd);
		secureFileDescriptor(staging, fd, "verify");
		const staged = fs.fstatSync(fd, { bigint: true });
		stagingIdentity = { dev: staged.dev, ino: staged.ino };
		stagingSnapshot = {
			bytes: Buffer.from(bytes),
			identity: identity(staged, createHash("sha256").update(bytes).digest("hex")),
		};
		assertOwned?.();

		const published = renameNoReplacePath(staging, destination);
		if (!published.ok) {
			if (published.code === "quarantine_collision") throw new Error("destination_conflict");
			throw new Error("durability_failed");
		}
		const named = fs.lstatSync(destination, { bigint: true });
		if (
			!named.isFile() ||
			named.isSymbolicLink() ||
			named.dev !== stagingIdentity.dev ||
			named.ino !== stagingIdentity.ino
		) {
			throw new Error("destination_identity_changed");
		}
		secureFileDescriptor(destination, fd, "verify");
		fs.closeSync(fd);
		fd = undefined;

		fsyncDirectory(parent);
		committed = true;
	} catch (error) {
		failure = error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (!committed && stagingSnapshot) {
			try {
				const installed = captureManagedFileNoFollow(destination);
				if (
					installed.identity.dev === stagingSnapshot.identity.dev &&
					installed.identity.ino === stagingSnapshot.identity.ino &&
					installed.identity.sha256 === stagingSnapshot.identity.sha256
				)
					await unlinkManagedFileVerified(destination, installed.identity);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
			}
		}
		if (stagingIdentity) {
			await fsp
				.lstat(staging, { bigint: true })
				.then(stat => {
					if (stat.dev === stagingIdentity?.dev && stat.ino === stagingIdentity.ino) return fsp.unlink(staging);
					throw new Error("staging_identity_changed");
				})
				.catch(error => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
				});
		}
	}
	if (failure !== undefined) throw failure;
}

export function publishManagedFileNoReplaceSync(
	destination: string,
	bytes: Uint8Array,
	root?: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): void {
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent, root, policy);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
	let fd: number | undefined;
	let stagingIdentity: { dev: bigint; ino: bigint } | undefined;
	let stagingSnapshot: ManagedFileSnapshot | undefined;
	let committed = false;
	let failure: unknown;
	try {
		fd = fs.openSync(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		secureFileDescriptor(staging, fd, "apply");
		let offset = 0;
		while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
		fs.fsyncSync(fd);
		secureFileDescriptor(staging, fd, "verify");
		const staged = fs.fstatSync(fd, { bigint: true });
		stagingIdentity = { dev: staged.dev, ino: staged.ino };
		stagingSnapshot = {
			bytes: Buffer.from(bytes),
			identity: identity(staged, createHash("sha256").update(bytes).digest("hex")),
		};

		const published = renameNoReplacePath(staging, destination);
		if (!published.ok) {
			if (published.code === "quarantine_collision") throw new Error("destination_conflict");
			throw new Error("durability_failed");
		}
		const named = fs.lstatSync(destination, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || named.dev !== staged.dev || named.ino !== staged.ino) {
			throw new Error("destination_identity_changed");
		}
		secureFileDescriptor(destination, fd, "verify");
		fs.closeSync(fd);
		fd = undefined;
		fsyncDirectory(parent);
		committed = true;
	} catch (error) {
		failure = error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	if (stagingIdentity) {
		if (!committed && stagingSnapshot) {
			try {
				const installed = captureManagedFileNoFollow(destination);
				if (
					installed.identity.dev === stagingSnapshot.identity.dev &&
					installed.identity.ino === stagingSnapshot.identity.ino &&
					installed.identity.sha256 === stagingSnapshot.identity.sha256
				) {
					const removed = exactUnlink(destination, {
						dev: installed.identity.dev,
						ino: installed.identity.ino,
						size: BigInt(installed.identity.size),
						mtimeNs: installed.identity.mtimeNs,
						sha256: installed.identity.sha256,
						quarantineName: `.gjc-remove-${process.pid}-${randomUUID()}`,
					});
					if (!removed.ok) failure ??= new Error(removed.code ?? "managed_publish_reconcile_failed");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
			}
		}
		try {
			const named = fs.lstatSync(staging, { bigint: true });
			if (named.dev !== stagingIdentity.dev || named.ino !== stagingIdentity.ino) {
				throw new Error("staging_identity_changed");
			}
			fs.unlinkSync(staging);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
}

/** Replace one managed regular file while retaining the secured staging fd through publication. */
export function replaceManagedFileSync(
	destination: string,
	bytes: Uint8Array,
	root: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): void {
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent, root, policy);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.replacement`);
	let fd: number | undefined;
	let stagedIdentity: { dev: bigint; ino: bigint } | undefined;
	try {
		fd = fs.openSync(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		secureFileDescriptor(staging, fd, "apply");
		let offset = 0;
		while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
		fs.fsyncSync(fd);
		secureFileDescriptor(staging, fd, "verify");
		const staged = fs.fstatSync(fd, { bigint: true });
		stagedIdentity = { dev: staged.dev, ino: staged.ino };
		assertManagedDirectoryRoot(root);
		fs.renameSync(staging, destination);
		assertManagedDirectoryRoot(root);
		const named = fs.lstatSync(destination, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || named.dev !== staged.dev || named.ino !== staged.ino) {
			throw new Error("destination_identity_changed");
		}
		secureFileDescriptor(destination, fd, "verify");
		fs.closeSync(fd);
		fd = undefined;
		fsyncDirectory(parent);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (stagedIdentity) {
			try {
				const named = fs.lstatSync(staging, { bigint: true });
				if (named.dev === stagedIdentity.dev && named.ino === stagedIdentity.ino) fs.unlinkSync(staging);
			} catch {
				// Never delete an object whose staging identity is no longer proven.
			}
		}
	}
}

export async function replaceManagedFile(
	destination: string,
	bytes: Uint8Array,
	root: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): Promise<void> {
	replaceManagedFileSync(destination, bytes, root, policy);
}

/** Copy the exact bytes captured from one no-follow source descriptor. */
export async function copyManagedFileNoReplace(
	source: string,
	destination: string,
	snapshot = captureManagedFileNoFollow(source),
	root?: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): Promise<void> {
	const named = captureManagedFileNoFollow(source);
	if (!sameIdentity(snapshot.identity, named.identity) || !snapshot.bytes.equals(named.bytes))
		throw new Error("source_changed");
	await publishManagedFileNoReplace(destination, snapshot.bytes, undefined, root, policy);
	const destinationSnapshot = captureManagedFileNoFollow(destination);
	if (!destinationSnapshot.bytes.equals(snapshot.bytes)) throw new Error("durability_failed");
}

/** Acquire a lease lock with bounded wait, heartbeats, conservative stale reclaim, and fencing. */
export async function acquireManagedLock(
	locksDirectory: string,
	name: string,
	root?: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
): Promise<ManagedStorageLock> {
	ensureManagedDirectory(locksDirectory, root, policy);
	const lockPath = path.join(locksDirectory, `${name}.lock`);
	const deadline = Date.now() + LOCK_WAIT_MS;
	let staleObservedAt: number | undefined;
	while (true) {
		const attemptId = randomUUID();
		const now = Date.now();
		const record: LockRecord = {
			attemptId,
			pid: process.pid,
			bootId: bootId(),
			processStartId: PROCESS_START_ID,
			createdAt: now,
			heartbeatAt: now,
			leaseExpiresAt: now + LOCK_LEASE_MS,
		};
		try {
			const fd = fs.openSync(
				lockPath,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				secureFileDescriptor(lockPath, fd, "apply");
				fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
				fs.fsyncSync(fd);
				fsyncDirectory(locksDirectory);
			} catch (error) {
				fs.closeSync(fd);
				throw error;
			}
			const lockIdentity = fs.fstatSync(fd, { bigint: true });
			let released = false;
			let descriptorClosed = false;
			const closeDescriptor = (): void => {
				if (descriptorClosed) return;
				try {
					secureFileDescriptor(lockPath, fd, "verify");
				} finally {
					fs.closeSync(fd);
					descriptorClosed = true;
				}
			};
			const assertOwned = (): void => {
				const current = parseLock(lockPath);
				let named: fs.BigIntStats;
				try {
					named = fs.lstatSync(lockPath, { bigint: true });
				} catch {
					throw new Error("migration_busy");
				}
				if (
					released ||
					descriptorClosed ||
					!current ||
					!sameFileIdentity(lockIdentity, named) ||
					current.attemptId !== attemptId ||
					current.leaseExpiresAt < Date.now()
				)
					throw new Error("migration_busy");
			};
			const heartbeat = setInterval(() => {
				try {
					assertOwned();
					const now = Date.now();
					writeLockDescriptor(fd, { ...record, heartbeatAt: now, leaseExpiresAt: now + LOCK_LEASE_MS });
				} catch {
					/* fencing rejects later publication */
				}
			}, LOCK_HEARTBEAT_MS);
			return {
				path: lockPath,
				attemptId,
				assertOwned,
				async release(): Promise<void> {
					clearInterval(heartbeat);
					try {
						assertOwned();
						const now = Date.now();
						// Do not unlink by pathname: a stale owner could otherwise remove a successor.
						// The lease is retired through the verified inode-bound descriptor instead.
						writeLockDescriptor(fd, { ...record, heartbeatAt: now, leaseExpiresAt: now });
						fsyncDirectory(locksDirectory);
					} finally {
						released = true;
						closeDescriptor();
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = parseLock(lockPath);
			if (owner && owner.leaseExpiresAt < Date.now()) {
				const ownerGone = ownerDefinitelyGone(owner);
				if (staleObservedAt === undefined) staleObservedAt = Date.now();
				if (ownerGone || Date.now() - staleObservedAt >= LOCK_STALE_RECHECK_MS) {
					const quarantine = `${lockPath}.${randomUUID()}.stale`;
					try {
						fs.renameSync(lockPath, quarantine);
						const quarantined = parseLock(quarantine);
						if (!quarantined || quarantined.attemptId !== owner.attemptId) throw new Error("migration_busy");
						fs.unlinkSync(quarantine);
						fsyncDirectory(locksDirectory);
					} catch {
						/* retry owner observation */
					}
					staleObservedAt = undefined;
				}
			} else staleObservedAt = undefined;
			if (Date.now() >= deadline) throw new Error("migration_busy");
			await new Promise<void>(resolve => setTimeout(resolve, 50));
		}
	}
}

/** Bounds a no-follow artifact tree before it can be copied or deleted. */
export function validateManagedArtifactTree(root: string): void {
	let files = 0;
	let bytes = 0;
	const visit = (directory: string, depth: number): void => {
		if (depth > MANAGED_ARTIFACT_MAX_DEPTH) throw new Error("unsafe_artifacts");
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			const stat = fs.lstatSync(entryPath);
			if (stat.isSymbolicLink()) throw new Error("unsafe_artifacts");
			if (stat.isDirectory()) {
				visit(entryPath, depth + 1);
				continue;
			}
			if (stat.nlink > 1) throw new Error("unsafe_artifacts");
			if (!stat.isFile() || stat.size > MANAGED_ARTIFACT_MAX_FILE_BYTES) throw new Error("unsafe_artifacts");
			files++;
			bytes += stat.size;
			if (files > MANAGED_ARTIFACT_MAX_FILES || bytes > MANAGED_ARTIFACT_MAX_TOTAL_BYTES)
				throw new Error("unsafe_artifacts");
		}
	};
	const rootStat = fs.lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe_artifacts");
	visit(root, 0);
}

/** Flush a copied managed artifact tree, including empty directories, before publishing its receipt. */
export function fsyncManagedArtifactTree(root: string): NativeDirectoryTreeSnapshot {
	const before = snapshotDirectoryTree(root);
	if (!before.ok || !before.snapshot) throw new Error(before.code ?? "unsafe_artifacts");
	const visit = (pathname: string): void => {
		const stat = fs.lstatSync(pathname);
		if (stat.isSymbolicLink()) throw new Error("unsafe_artifacts");
		if (stat.isFile()) {
			const fd = fs.openSync(
				pathname,
				(process.platform === "win32" ? fs.constants.O_WRONLY : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW,
			);
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			return;
		}
		if (!stat.isDirectory()) throw new Error("unsafe_artifacts");
		for (const entry of fs.readdirSync(pathname, { withFileTypes: true })) visit(path.join(pathname, entry.name));
		fsyncDirectory(pathname);
	};
	validateManagedArtifactTree(root);
	visit(root);
	const after = snapshotDirectoryTree(root);
	if (!after.ok || !after.snapshot || JSON.stringify(after.snapshot) !== JSON.stringify(before.snapshot)) {
		throw new Error("artifact_tree_changed_during_fsync");
	}
	return after.snapshot;
}

export async function publishManagedTombstone(
	destination: string,
	record: Record<string, unknown>,
	assertOwned?: () => void,
): Promise<void> {
	await publishManagedFileNoReplace(
		destination,
		new TextEncoder().encode(
			`${JSON.stringify(record, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
		),
		assertOwned,
	);
}

export async function unlinkManagedFileVerified(
	pathname: string,
	expected: ManagedFileSnapshot["identity"],
): Promise<void> {
	const snapshot = captureManagedFileNoFollow(pathname);
	if (!sameIdentity(snapshot.identity, expected)) throw new Error("source_changed");
	await fsp.unlink(pathname);
	fsyncDirectory(path.dirname(pathname));
}
