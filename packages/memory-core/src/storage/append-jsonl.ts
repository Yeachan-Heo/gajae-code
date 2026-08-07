import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryResult } from "../errors";
import type { WriteDestination } from "../index";
import type { AccessGrant } from "../policy/access-policy";
import { verifyAccessGrant } from "../policy/access-policy";
import { assertPathBinding, assertRootBinding, type ContainedPath, containPath } from "../policy/path-safety";
import { withMemoryLock } from "./locks";
import { VerifiedStorageError } from "./verified-open";

const NOFOLLOW = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const MAX_ATOMIC_APPEND_BYTES = 64 * 1024;

export interface AppendJsonlInput {
	readonly grant: AccessGrant;
	readonly relPath?: string;
	readonly target?: string;
	readonly record: unknown;
	/** Test-only seam for deterministic same-UID race detection; never a policy override. */
	readonly beforeAuthorizedParentCreate?: () => void;
}

export interface AppendJsonlReceipt {
	readonly relPath: string;
	readonly target: string;
	readonly digest: string;
	readonly sha256: string;
	readonly changed: true;
	readonly appended: true;
	readonly bytesWritten: number;
}

function policyReason(result: MemoryResult<unknown>): string {
	if (result.ok) return "";
	const error = result.error;
	if ("reason" in error) return error.reason;
	if ("detail" in error) return error.detail;
	if ("uri" in error) return error.uri;
	return error.code;
}

function fail(relPath: string, reason: string, cause?: unknown, destination?: WriteDestination): never {
	if (cause instanceof VerifiedStorageError) throw cause;
	throw new VerifiedStorageError(relPath, reason, destination, cause);
}

function unwrap<T>(result: MemoryResult<T>, relPath: string, destination: WriteDestination): T {
	if (result.ok) return result.value;
	fail(relPath, policyReason(result), result.error, destination);
}

function isInput(value: AppendJsonlInput | AccessGrant): value is AppendJsonlInput {
	return typeof value === "object" && value !== null && "grant" in value;
}

function targetToRelPath(grant: AccessGrant, target: string | undefined, relPath: string | undefined): string {
	if (relPath !== undefined) return relPath;
	if (target === undefined || target === grant.target) return grant.relativePath;
	if (path.isAbsolute(target)) {
		return path.relative(grant.root.canonicalPath, target).split(path.sep).join("/");
	}
	return target;
}

function parseInput(
	first: AppendJsonlInput | AccessGrant,
	second: string | unknown | undefined,
	third: unknown | undefined,
): AppendJsonlInput {
	if (isInput(first)) return first;
	if (third === undefined) return { grant: first, record: second };
	if (typeof second !== "string") {
		throw new VerifiedStorageError(first.relativePath, "append target must be a string", first.destination);
	}
	return { grant: first, relPath: second, record: third };
}

function resolveContained(grant: AccessGrant, relPath: string): ContainedPath {
	return unwrap(containPath(grant.root, relPath), relPath, grant.destination);
}

function verifyGrant(grant: AccessGrant, contained: ContainedPath, contentDigest: string): AccessGrant {
	return unwrap(
		verifyAccessGrant(grant, contained.absolutePath, grant.destination, contentDigest),
		contained.relativePath,
		grant.destination,
	);
}

function sameIdentity(
	left: { readonly dev: bigint; readonly ino: bigint },
	right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
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
function assertRootState(grant: AccessGrant, relPath: string): void {
	const destination = grant.destination;
	const rootBinding = assertRootBinding(grant.root);
	if (!rootBinding.ok) fail(relPath, policyReason(rootBinding), rootBinding.error, destination);
	const rootStat = lstatBigint(grant.root.canonicalPath, relPath, destination);
	if (!isTrustedDirectory(rootStat, grant.root.dev) || !sameIdentity(rootStat, grant.root)) {
		fail(relPath, "append memory root binding changed", undefined, destination);
	}
}

function authorizedSessionsState(
	grant: AccessGrant,
	authorization: AccessGrant["parentCreation"],
	relPath: string,
): fs.BigIntStats {
	const destination = grant.destination;
	if (authorization === undefined) fail(relPath, "append sessions authorization is missing", undefined, destination);
	let sessions: fs.BigIntStats;
	try {
		sessions = fs.lstatSync(authorization.sessionsPath, { bigint: true });
	} catch (error) {
		fail(
			relPath,
			`append sessions directory could not be verified: ${errorCode(error) ?? "lstat-failed"}`,
			error,
			destination,
		);
	}
	if (
		!isTrustedDirectory(sessions, grant.root.dev) ||
		sessions.dev !== authorization.sessionsDev ||
		sessions.ino !== authorization.sessionsIno
	) {
		fail(relPath, "append sessions directory binding changed", undefined, destination);
	}
	return sessions;
}

function revalidateCreatedSession(
	grant: AccessGrant,
	authorization: NonNullable<AccessGrant["parentCreation"]>,
	relPath: string,
): fs.BigIntStats {
	const destination = grant.destination;
	let session: fs.BigIntStats;
	try {
		session = fs.lstatSync(authorization.parentPath, { bigint: true });
	} catch (error) {
		fail(
			relPath,
			`append session directory race could not be verified: ${errorCode(error) ?? "lstat-failed"}`,
			error,
			destination,
		);
	}
	if (!isTrustedDirectory(session, grant.root.dev)) {
		fail(relPath, "append session directory is not a trusted 0700 directory", undefined, destination);
	}
	const contained = resolveContained(grant, relPath);
	if (contained.parentPath !== authorization.parentPath || contained.absolutePath !== grant.target) {
		fail(relPath, "append session directory containment changed", undefined, destination);
	}
	const sessionComponent = contained.components.at(-1);
	if (
		sessionComponent === undefined ||
		sessionComponent.name !== path.basename(authorization.parentPath) ||
		!sameIdentity(sessionComponent, session)
	) {
		fail(relPath, "append session directory identity changed", undefined, destination);
	}
	return session;
}

function ensureAuthorizedParent(grant: AccessGrant, relPath: string, beforeAuthorizedParentCreate?: () => void): void {
	const authorization = grant.parentCreation;
	if (authorization === undefined) return;
	const destination = grant.destination;
	if (
		destination !== "ledger" ||
		authorization.relPath !== relPath ||
		authorization.target !== grant.target ||
		authorization.rootPath !== grant.root.canonicalPath ||
		authorization.rootDev !== grant.root.dev ||
		authorization.rootIno !== grant.root.ino ||
		authorization.destination !== destination
	) {
		fail(relPath, "append parent creation authorization changed", undefined, destination);
	}
	assertRootState(grant, relPath);
	authorizedSessionsState(grant, authorization, relPath);
	let session: fs.BigIntStats | undefined;
	try {
		session = fs.lstatSync(authorization.parentPath, { bigint: true });
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			fail(
				relPath,
				`append session directory could not be inspected: ${errorCode(error) ?? "lstat-failed"}`,
				error,
				destination,
			);
		}
	}
	if (authorization.kind === "pinned") {
		if (
			session === undefined ||
			!isTrustedDirectory(session, grant.root.dev) ||
			session.dev !== authorization.parentDev ||
			session.ino !== authorization.parentIno
		) {
			fail(relPath, "append pinned session directory identity changed", undefined, destination);
		}
	} else if (session === undefined) {
		try {
			// This mkdir is deliberately non-recursive and exact-path. The hook is
			// test-only: same-UID adversarial race prevention/rooted-I/O is explicitly
			// outside the MVP; this protocol detects and reports a fail-closed outcome instead.
			beforeAuthorizedParentCreate?.();
		} catch (error) {
			fail(relPath, "append parent creation test seam failed", error, destination);
		}
		try {
			fs.mkdirSync(authorization.parentPath, { mode: 0o700, recursive: false });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				fail(
					relPath,
					`append session directory could not be created: ${errorCode(error) ?? "mkdir-failed"}`,
					error,
					destination,
				);
			}
		}
		// EEXIST is a benign result only after the exact parent is revalidated.
		// Recheck every binding immediately after mkdir, before opening the append target.
		assertRootState(grant, relPath);
		authorizedSessionsState(grant, authorization, relPath);
		session = revalidateCreatedSession(grant, authorization, relPath);
	}
	if (session === undefined || !isTrustedDirectory(session, grant.root.dev)) {
		fail(relPath, "append session directory is not a trusted 0700 directory", undefined, destination);
	}
	const contained = resolveContained(grant, relPath);
	if (contained.parentPath !== authorization.parentPath || contained.absolutePath !== grant.target) {
		fail(relPath, "append session directory containment changed", undefined, destination);
	}
	const sessionComponent = contained.components.at(-1);
	if (sessionComponent === undefined || !sameIdentity(sessionComponent, session)) {
		fail(relPath, "append session directory identity changed", undefined, destination);
	}
}

function serializeRecord(record: unknown, relPath: string, destination: WriteDestination): Buffer {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(record);
	} catch (error) {
		fail(relPath, "JSONL record is not serializable", error, destination);
	}
	if (encoded === undefined) fail(relPath, "JSONL record has no JSON representation", undefined, destination);
	const line = `${encoded}\n`;
	const bytes = Buffer.from(line, "utf8");
	if (bytes.byteLength > MAX_ATOMIC_APPEND_BYTES) {
		fail(relPath, "JSONL record exceeds the single-write atomic append limit", undefined, destination);
	}
	return bytes;
}

function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function lstatBigint(filePath: string, relPath: string, destination: WriteDestination): fs.BigIntStats {
	try {
		return fs.lstatSync(filePath, { bigint: true });
	} catch (error) {
		fail(
			relPath,
			`append target identity could not be inspected: ${errorCode(error) ?? "lstat-failed"}`,
			error,
			destination,
		);
	}
}

function fstatBigint(fd: number, relPath: string, destination: WriteDestination): fs.BigIntStats {
	try {
		return fs.fstatSync(fd, { bigint: true });
	} catch (error) {
		fail(
			relPath,
			`append descriptor identity could not be inspected: ${errorCode(error) ?? "fstat-failed"}`,
			error,
			destination,
		);
	}
}

function openParentDirectory(
	grant: AccessGrant,
	contained: ContainedPath,
	relPath: string,
): { readonly fd: number; readonly identity: { readonly dev: bigint; readonly ino: bigint } } {
	const destination = grant.destination;
	const stat = lstatBigint(contained.parentPath, relPath, destination);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== grant.root.dev) {
		fail(relPath, "append parent is not bound to the memory root", undefined, destination);
	}
	if (grant.parentCreation !== undefined && !isTrustedDirectory(stat, grant.root.dev)) {
		fail(relPath, "append ledger parent is not a trusted 0700 directory", undefined, destination);
	}
	const parentComponent = contained.components.at(-1);
	if (parentComponent !== undefined && !sameIdentity(parentComponent, stat)) {
		fail(relPath, "append parent identity changed", undefined, destination);
	}
	let fd: number;
	try {
		fd = fs.openSync(contained.parentPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
	} catch (error) {
		fail(relPath, `append parent could not be opened: ${errorCode(error) ?? "open-failed"}`, error, destination);
	}
	const opened = fstatBigint(fd, relPath, destination);
	if (
		!opened.isDirectory() ||
		opened.isSymbolicLink() ||
		!sameIdentity(opened, stat) ||
		(grant.parentCreation !== undefined && !isTrustedDirectory(opened, grant.root.dev))
	) {
		try {
			fs.closeSync(fd);
		} catch {
			// Preserve the binding error.
		}
		fail(relPath, "append parent identity changed after open", undefined, destination);
	}
	return { fd, identity: { dev: opened.dev, ino: opened.ino } };
}

function closeFd(fd: number, relPath: string, destination: WriteDestination): void {
	try {
		fs.closeSync(fd);
	} catch (error) {
		fail(relPath, `append descriptor close failed: ${errorCode(error) ?? "close-failed"}`, error, destination);
	}
}

function syncFd(fd: number, relPath: string, destination: WriteDestination): void {
	try {
		fs.fsyncSync(fd);
	} catch (error) {
		fail(relPath, `append durability sync failed: ${errorCode(error) ?? "fsync-failed"}`, error, destination);
	}
}

function appendOne(grant: AccessGrant, relPath: string, bytes: Buffer, contentDigest: string): AppendJsonlReceipt {
	const destination = grant.destination;
	let contained = resolveContained(grant, relPath);
	verifyGrant(grant, contained, contentDigest);

	const preimage = contained.leafIdentity;
	const parent = openParentDirectory(grant, contained, relPath);
	let fd: number | undefined;
	let closed = false;
	try {
		try {
			const openedFd = fs.openSync(
				contained.absolutePath,
				fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW,
				0o600,
			);
			fd = openedFd;
			fs.fchmodSync(openedFd, 0o600);
		} catch (error) {
			fail(
				relPath,
				`append target could not be opened exclusively: ${errorCode(error) ?? "open-failed"}`,
				error,
				destination,
			);
		}
		if (fd === undefined) fail(relPath, "append descriptor is unavailable", undefined, destination);
		const appendFd = fd;
		const opened = fstatBigint(appendFd, relPath, destination);
		if (
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			opened.nlink !== 1n ||
			opened.dev !== grant.root.dev ||
			(opened.mode & 0o777n) !== 0o600n
		) {
			fail(relPath, "append target descriptor is not a trusted regular file", undefined, destination);
		}
		if (preimage !== null && !sameIdentity(opened, preimage)) {
			fail(relPath, "append target identity changed before write", undefined, destination);
		}
		const parentAgain = lstatBigint(contained.parentPath, relPath, destination);
		if (
			!sameIdentity(parent.identity, parentAgain) ||
			!parentAgain.isDirectory() ||
			parentAgain.isSymbolicLink() ||
			(grant.parentCreation !== undefined && !isTrustedDirectory(parentAgain, grant.root.dev))
		) {
			fail(relPath, "append parent identity changed before write", undefined, destination);
		}
		const parentDescriptorAgain = fstatBigint(parent.fd, relPath, destination);
		if (
			!sameIdentity(parent.identity, parentDescriptorAgain) ||
			(grant.parentCreation !== undefined && !isTrustedDirectory(parentDescriptorAgain, grant.root.dev))
		) {
			fail(relPath, "append parent descriptor identity changed before write", undefined, destination);
		}
		const rebound = resolveContained(grant, relPath);
		verifyGrant(grant, rebound, contentDigest);
		contained = rebound;

		// The record is intentionally one syscall. A short write is a typed
		// failure; retrying would violate the no-partial-fallback contract.
		let written: number;
		try {
			written = fs.writeSync(appendFd, bytes, 0, bytes.byteLength, null);
		} catch (error) {
			fail(relPath, `JSONL append failed: ${errorCode(error) ?? "write-failed"}`, error, destination);
		}
		if (written !== bytes.byteLength) fail(relPath, "JSONL append was partial", undefined, destination);
		syncFd(appendFd, relPath, destination);
		const afterWrite = fstatBigint(appendFd, relPath, destination);
		if (
			!afterWrite.isFile() ||
			afterWrite.isSymbolicLink() ||
			afterWrite.nlink !== 1n ||
			(afterWrite.mode & 0o777n) !== 0o600n ||
			!sameIdentity(opened, afterWrite)
		) {
			fail(relPath, "append target identity changed after write", undefined, destination);
		}
		unwrap(
			assertPathBinding(grant.root, contained, { dev: afterWrite.dev, ino: afterWrite.ino }),
			relPath,
			destination,
		);
		closeFd(appendFd, relPath, destination);
		closed = true;
		return Object.freeze({
			relPath: contained.relativePath,
			target: contained.absolutePath,
			digest: contentDigest,
			sha256: contentDigest,
			changed: true,
			appended: true,
			bytesWritten: written,
		});
	} finally {
		if (fd !== undefined && !closed) {
			try {
				fs.closeSync(fd);
			} catch {
				// Preserve the first typed append failure.
			}
		}
		try {
			fs.closeSync(parent.fd);
		} catch {
			// Preserve the original operation result/failure.
		}
	}
}

/** Append exactly one newline-terminated JSON record under a grant and lock. */
export async function appendJsonl(input: AppendJsonlInput): Promise<AppendJsonlReceipt>;
export async function appendJsonl(grant: AccessGrant, record: unknown): Promise<AppendJsonlReceipt>;
export async function appendJsonl(grant: AccessGrant, relPath: string, record: unknown): Promise<AppendJsonlReceipt>;
export async function appendJsonl(
	first: AppendJsonlInput | AccessGrant,
	second?: string | unknown,
	third?: unknown,
): Promise<AppendJsonlReceipt> {
	const input = parseInput(first, second, third);
	const grant = input.grant;
	const relPath = targetToRelPath(grant, input.target, input.relPath);
	if (typeof relPath !== "string") {
		fail(grant.relativePath, "append target must be a string", undefined, grant.destination);
	}
	const normalizedRelPath = relPath.normalize("NFC");
	if (normalizedRelPath !== grant.relativePath) {
		fail(relPath, "append target binding changed", undefined, grant.destination);
	}
	const bytes = serializeRecord(input.record, normalizedRelPath, grant.destination);
	const digest = digestBytes(bytes);
	unwrap(verifyAccessGrant(grant, grant.target, grant.destination, digest), normalizedRelPath, grant.destination);
	return withMemoryLock(grant.root.canonicalPath, normalizedRelPath, async () => {
		ensureAuthorizedParent(grant, normalizedRelPath, input.beforeAuthorizedParentCreate);
		const rebound = resolveContained(grant, normalizedRelPath);
		verifyGrant(grant, rebound, digest);
		return appendOne(grant, rebound.relativePath, bytes, digest);
	});
}
