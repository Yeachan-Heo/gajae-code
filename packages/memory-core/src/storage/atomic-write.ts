import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryResult } from "../errors";
import type { WriteDestination } from "../index";
import type { AccessGrant } from "../policy/access-policy";
import { verifyAccessGrant } from "../policy/access-policy";
import {
	assertPathBinding,
	assertRootBinding,
	type ContainedPath,
	containPath,
	type RootPin,
} from "../policy/path-safety";
import { openVerifiedFile, type PublishReceipt, publishVerified, VerifiedStorageError } from "./verified-open";

export interface AtomicWriteInput {
	readonly grant: AccessGrant;
	readonly relPath?: string;
	readonly target?: string;
	readonly content: string | Uint8Array;
	readonly encoding?: BufferEncoding;
	/** Test-only seam for deterministic same-UID race detection; never a policy override. */
	readonly beforeAuthorizedParentCreate?: () => void;
}

export interface AtomicWriteReceipt {
	readonly relPath: string;
	readonly target: string;
	readonly digest: string;
	readonly sha256: string;
	readonly changed: boolean;
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

function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function bytesFor(content: string | Uint8Array, encoding: BufferEncoding): Buffer {
	try {
		if (typeof content === "string") return Buffer.from(content, encoding);
		if (content instanceof Uint8Array) return Buffer.from(content);
	} catch (error) {
		fail("", "write content could not be encoded", error);
	}
	fail("", "write content must be a string or Uint8Array");
}

function isAbsoluteTarget(root: RootPin, value: string): boolean {
	return path.isAbsolute(value) && path.resolve(value) === value && value.startsWith(root.canonicalPath);
}

function targetToRelPath(
	root: RootPin,
	grant: AccessGrant,
	target: string | undefined,
	relPath: string | undefined,
): string {
	if (relPath !== undefined) return relPath;
	if (target === undefined) return grant.relativePath;
	if (target === grant.target) return grant.relativePath;
	if (isAbsoluteTarget(root, target)) {
		return path.relative(root.canonicalPath, target).split(path.sep).join("/");
	}
	return target;
}

function parseInput(
	first: AtomicWriteInput | AccessGrant,
	second: string | Uint8Array | undefined,
	third: string | Uint8Array | undefined,
): AtomicWriteInput {
	if (isInput(first)) return first;
	if (third === undefined) {
		if (second === undefined)
			throw new VerifiedStorageError(first.relativePath, "atomic write content is missing", first.destination);
		return { grant: first, content: second };
	}
	if (typeof second !== "string")
		throw new VerifiedStorageError(first.relativePath, "atomic write target must be a string", first.destination);
	return { grant: first, relPath: second, content: third };
}

function isInput(value: AtomicWriteInput | AccessGrant): value is AtomicWriteInput {
	return typeof value === "object" && value !== null && "grant" in value;
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

function lstatBigint(filePath: string, relPath: string, destination: WriteDestination): fs.BigIntStats {
	try {
		return fs.lstatSync(filePath, { bigint: true });
	} catch (error) {
		fail(
			relPath,
			`atomic path identity could not be inspected: ${errorCode(error) ?? "lstat-failed"}`,
			error,
			destination,
		);
	}
}

function assertRootState(grant: AccessGrant, relPath: string): void {
	const destination = grant.destination;
	const rootBinding = assertRootBinding(grant.root);
	if (!rootBinding.ok) fail(relPath, policyReason(rootBinding), rootBinding.error, destination);
	const rootStat = lstatBigint(grant.root.canonicalPath, relPath, destination);
	if (!isTrustedDirectory(rootStat, grant.root.dev) || !sameIdentity(rootStat, grant.root)) {
		fail(relPath, "atomic memory root binding changed", undefined, destination);
	}
}

function authorizedSessionsState(
	grant: AccessGrant,
	authorization: AccessGrant["parentCreation"],
	relPath: string,
): fs.BigIntStats {
	const destination = grant.destination;
	if (authorization === undefined) fail(relPath, "atomic sessions authorization is missing", undefined, destination);
	const sessions = lstatBigint(authorization.sessionsPath, relPath, destination);
	if (
		!isTrustedDirectory(sessions, grant.root.dev) ||
		sessions.dev !== authorization.sessionsDev ||
		sessions.ino !== authorization.sessionsIno
	) {
		fail(relPath, "atomic sessions directory binding changed", undefined, destination);
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
			`atomic session directory race could not be verified: ${errorCode(error) ?? "lstat-failed"}`,
			error,
			destination,
		);
	}
	if (!isTrustedDirectory(session, grant.root.dev)) {
		fail(relPath, "atomic session directory is not a trusted 0700 directory", undefined, destination);
	}
	const contained = resolveContained(grant, relPath);
	if (contained.parentPath !== authorization.parentPath || contained.absolutePath !== grant.target) {
		fail(relPath, "atomic session directory containment changed", undefined, destination);
	}
	const sessionComponent = contained.components.at(-1);
	if (
		sessionComponent === undefined ||
		sessionComponent.name !== path.basename(authorization.parentPath) ||
		!sameIdentity(sessionComponent, session)
	) {
		fail(relPath, "atomic session directory identity changed", undefined, destination);
	}
	return session;
}

function ensureAuthorizedParent(grant: AccessGrant, relPath: string, beforeAuthorizedParentCreate?: () => void): void {
	const authorization = grant.parentCreation;
	if (authorization === undefined) return;
	const destination = grant.destination;
	if (
		(destination !== "ledger" && destination !== "checkpoint") ||
		authorization.relPath !== relPath ||
		authorization.target !== grant.target ||
		authorization.rootPath !== grant.root.canonicalPath ||
		authorization.rootDev !== grant.root.dev ||
		authorization.rootIno !== grant.root.ino ||
		authorization.destination !== destination
	) {
		fail(relPath, "atomic parent creation authorization changed", undefined, destination);
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
				`atomic session directory could not be inspected: ${errorCode(error) ?? "lstat-failed"}`,
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
			fail(relPath, "atomic pinned session directory identity changed", undefined, destination);
		}
	} else if (session === undefined) {
		try {
			// This mkdir is deliberately non-recursive and exact-path. The hook is
			// test-only: same-UID adversarial race prevention/rooted-I/O is explicitly
			// outside the MVP; this protocol detects and reports a fail-closed outcome instead.
			beforeAuthorizedParentCreate?.();
		} catch (error) {
			fail(relPath, "atomic parent creation test seam failed", error, destination);
		}
		try {
			fs.mkdirSync(authorization.parentPath, { mode: 0o700, recursive: false });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				fail(
					relPath,
					`atomic session directory could not be created: ${errorCode(error) ?? "mkdir-failed"}`,
					error,
					destination,
				);
			}
		}
		// EEXIST is a benign result only after the exact parent is revalidated.
		// Recheck every binding immediately after mkdir, before opening the write target.
		assertRootState(grant, relPath);
		authorizedSessionsState(grant, authorization, relPath);
		session = revalidateCreatedSession(grant, authorization, relPath);
	}
	if (session === undefined || !isTrustedDirectory(session, grant.root.dev)) {
		fail(relPath, "atomic session directory is not a trusted 0700 directory", undefined, destination);
	}
	const contained = resolveContained(grant, relPath);
	if (contained.parentPath !== authorization.parentPath || contained.absolutePath !== grant.target) {
		fail(relPath, "atomic session directory containment changed", undefined, destination);
	}
	const sessionComponent = contained.components.at(-1);
	if (sessionComponent === undefined || !sameIdentity(sessionComponent, session)) {
		fail(relPath, "atomic session directory identity changed", undefined, destination);
	}
}

function sameIdentity(
	left: { readonly dev: bigint; readonly ino: bigint },
	right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function unchangedReceipt(contained: ContainedPath, digest: string, bytesWritten: number): AtomicWriteReceipt {
	return Object.freeze({
		relPath: contained.relativePath,
		target: contained.absolutePath,
		digest,
		sha256: digest,
		changed: false,
		bytesWritten,
	});
}

function publishedReceipt(receipt: PublishReceipt): AtomicWriteReceipt {
	return Object.freeze({
		relPath: receipt.relPath,
		target: receipt.target,
		digest: receipt.digest,
		sha256: receipt.sha256,
		changed: receipt.changed,
		bytesWritten: receipt.bytesWritten,
	});
}

/**
 * Atomically publish one grant-authorized byte sequence. The grant is checked
 * against the concrete destination immediately before any content operation;
 * the verified publisher performs all identity and durability checks.
 */
export async function atomicWrite(input: AtomicWriteInput): Promise<AtomicWriteReceipt>;
export async function atomicWrite(grant: AccessGrant, content: string | Uint8Array): Promise<AtomicWriteReceipt>;
export async function atomicWrite(
	grant: AccessGrant,
	relPath: string,
	content: string | Uint8Array,
): Promise<AtomicWriteReceipt>;
export async function atomicWrite(
	first: AtomicWriteInput | AccessGrant,
	second?: string | Uint8Array,
	third?: string | Uint8Array,
): Promise<AtomicWriteReceipt> {
	const input = parseInput(first, second, third);
	const grant = input.grant;
	const root = grant.root;
	const relPath = targetToRelPath(root, grant, input.target, input.relPath);
	const destination = grant.destination;
	const bytes = bytesFor(input.content, input.encoding ?? "utf8");
	const digest = digestBytes(bytes);
	unwrap(verifyAccessGrant(grant, grant.target, destination, digest), relPath, destination);
	ensureAuthorizedParent(grant, relPath, input.beforeAuthorizedParentCreate);
	let contained = resolveContained(grant, relPath);
	verifyGrant(grant, contained, digest);

	if (contained.leafIdentity !== null) {
		const existing = openVerifiedFile(root, contained.relativePath);
		const existingDigest = digestBytes(existing);
		if (existingDigest === digest && Buffer.compare(existing, bytes) === 0) {
			const rebound = resolveContained(grant, contained.relativePath);
			verifyGrant(grant, rebound, digest);

			if (rebound.leafIdentity === null || !sameIdentity(rebound.leafIdentity, contained.leafIdentity)) {
				fail(relPath, "destination identity changed before unchanged receipt", undefined, destination);
			}
			unwrap(assertPathBinding(root, rebound, rebound.leafIdentity), relPath, destination);
			return unchangedReceipt(rebound, digest, bytes.byteLength);
		}
	}

	// Re-resolve and revalidate immediately before the verified publish. This
	// closes the grant/path window without allowing a caller-supplied path alias.
	contained = resolveContained(grant, contained.relativePath);
	verifyGrant(grant, contained, digest);
	try {
		return publishedReceipt(publishVerified(root, contained.relativePath, bytes));
	} catch (error) {
		if (error instanceof VerifiedStorageError) throw error;
		fail(relPath, "atomic publish failed closed", error, destination);
	}
}
