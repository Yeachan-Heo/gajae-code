import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryResult } from "../errors";
import type { WriteDestination } from "../index";
import type { ContainedPath, IdentityReference, PathIdentity, RootPin } from "../policy/path-safety";
import { assertPathBinding, assertRootBinding, containPath, pinMemoryRoot } from "../policy/path-safety";

const NOFOLLOW = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const ROOT_DESTINATION: WriteDestination = "global-canonical";

export interface VerifiedOpenOptions {
	/** Test-only hook. It runs before the final post-hook binding rechecks. */
	readonly beforeRename?: () => void;
	/** Test-only hook. It runs after final authorization and immediately before pathname rename. */
	readonly afterAuthorization?: () => void;
}

export interface PublishReceipt {
	readonly relPath: string;
	readonly target: string;
	readonly digest: string;
	readonly sha256: string;
	readonly changed: true;
	readonly bytesWritten: number;
}

export class VerifiedStorageError extends Error {
	readonly code = "policy-denied" as const;
	readonly exitCode = 6 as const;
	readonly destination: WriteDestination;
	readonly relPath: string;
	readonly reason: string;
	readonly policyError: unknown;

	constructor(
		relPath: string,
		reason: string,
		destination: WriteDestination = ROOT_DESTINATION,
		policyError?: unknown,
	) {
		super(reason, { cause: policyError });
		this.name = "VerifiedStorageError";
		this.destination = destination;
		this.relPath = relPath;
		this.reason = reason;
		this.policyError = policyError;
	}
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function policyReason(result: MemoryResult<unknown>): string {
	if (result.ok) return "";
	const error = result.error;
	if ("reason" in error) return error.reason;
	if ("detail" in error) return error.detail;
	if ("uri" in error) return error.uri;
	return error.code;
}

function unwrap<T>(result: MemoryResult<T>, relPath: string, destination = ROOT_DESTINATION): T {
	if (result.ok) return result.value;
	throw new VerifiedStorageError(relPath, policyReason(result), destination, result.error);
}

function fail(relPath: string, reason: string, cause?: unknown, destination = ROOT_DESTINATION): never {
	if (cause instanceof VerifiedStorageError) throw cause;
	throw new VerifiedStorageError(relPath, reason, destination, cause);
}

function sameIdentity(left: IdentityReference, right: IdentityReference): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
	return (
		sameIdentity(left, right) &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

function isRegularSingleLink(stat: fs.BigIntStats): boolean {
	return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
}

function identityFromStat(stat: fs.BigIntStats): PathIdentity {
	return Object.freeze({
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
	});
}

function identityReference(stat: fs.BigIntStats): IdentityReference {
	return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function rootFromInput(root: RootPin | string, relPath: string): RootPin {
	if (typeof root !== "string") return root;
	return unwrap(pinMemoryRoot(root), relPath);
}

function containedFor(
	root: RootPin | string,
	relPath: string,
): { readonly root: RootPin; readonly contained: ContainedPath } {
	const pinned = rootFromInput(root, relPath);
	return { root: pinned, contained: unwrap(containPath(pinned, relPath), relPath) };
}

function ensureRootStillBound(root: RootPin, relPath: string): void {
	unwrap(assertRootBinding(root), relPath);
}

function lstatBigint(filePath: string, relPath: string): fs.BigIntStats {
	try {
		return fs.lstatSync(filePath, { bigint: true });
	} catch (error) {
		fail(relPath, `path identity could not be inspected: ${errorCode(error) ?? "lstat-failed"}`, error);
	}
}

function fstatBigint(fd: number, relPath: string): fs.BigIntStats {
	try {
		return fs.fstatSync(fd, { bigint: true });
	} catch (error) {
		fail(relPath, `descriptor identity could not be inspected: ${errorCode(error) ?? "fstat-failed"}`, error);
	}
}

function assertDirectoryIdentity(
	root: RootPin,
	contained: ContainedPath,
	parentStat: fs.BigIntStats,
	relPath: string,
): void {
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== root.dev) {
		fail(relPath, "destination parent is not bound to the memory root");
	}
	const parentComponent = contained.components.at(-1);
	if (parentComponent !== undefined && !sameIdentity(parentComponent, parentStat)) {
		fail(relPath, "destination parent identity changed");
	}
}

function openParentDirectory(
	root: RootPin,
	contained: ContainedPath,
	relPath: string,
): { readonly fd: number; readonly identity: IdentityReference } {
	const parentStat = lstatBigint(contained.parentPath, relPath);
	assertDirectoryIdentity(root, contained, parentStat, relPath);
	let fd: number;
	try {
		fd = fs.openSync(contained.parentPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
	} catch (error) {
		fail(relPath, `destination parent could not be opened: ${errorCode(error) ?? "open-failed"}`, error);
	}
	const opened = fstatBigint(fd, relPath);
	if (!opened.isDirectory() || opened.isSymbolicLink() || !sameIdentity(opened, parentStat)) {
		try {
			fs.closeSync(fd);
		} catch {
			// The original binding failure is the actionable error.
		}
		fail(relPath, "destination parent identity changed after open");
	}
	return { fd, identity: identityReference(opened) };
}

function closeFd(fd: number, relPath: string): void {
	try {
		fs.closeSync(fd);
	} catch (error) {
		fail(relPath, `descriptor close failed: ${errorCode(error) ?? "close-failed"}`, error);
	}
}

function readDescriptor(fd: number, size: bigint, relPath: string): Buffer {
	if (size > BigInt(Number.MAX_SAFE_INTEGER)) fail(relPath, "file is too large to verify safely");
	const buffer = Buffer.alloc(Number(size));
	let offset = 0;
	while (offset < buffer.byteLength) {
		let read: number;
		try {
			read = fs.readSync(fd, buffer, offset, buffer.byteLength - offset, null);
		} catch (error) {
			fail(relPath, `verified read failed: ${errorCode(error) ?? "read-failed"}`, error);
		}
		if (read <= 0) fail(relPath, "verified read ended before the bound file size");
		offset += read;
	}
	return buffer;
}

function normalizeBytes(content: string | Uint8Array, encoding: BufferEncoding = "utf8"): Buffer {
	if (typeof content === "string") return Buffer.from(content, encoding);
	if (content instanceof Uint8Array) return Buffer.from(content);
	fail("", "write content must be a string or Uint8Array");
}

function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function recheckDestinationPreimage(contained: ContainedPath, relPath: string): PathIdentity | null {
	try {
		const stat = fs.lstatSync(contained.absolutePath, { bigint: true });
		if (stat.isSymbolicLink() || stat.dev !== contained.root.dev) {
			fail(relPath, "destination leaf is not bound to the memory root");
		}
		if (!stat.isFile() || stat.nlink !== 1n) fail(relPath, "destination leaf is not a regular single-link file");
		const current = identityFromStat(stat);
		if (contained.leafIdentity === null) fail(relPath, "destination appeared during authorization");
		if (!sameIdentity(current, contained.leafIdentity)) fail(relPath, "destination preimage identity changed");
		return current;
	} catch (error) {
		if (error instanceof VerifiedStorageError) throw error;
		if (errorCode(error) === "ENOENT" && contained.leafIdentity === null) return null;
		fail(relPath, `destination preimage could not be verified: ${errorCode(error) ?? "lstat-failed"}`, error);
	}
}

function finalContainedPath(root: RootPin, initial: ContainedPath, relPath: string): ContainedPath {
	const refreshed = unwrap(containPath(root, relPath), relPath);
	if (refreshed.absolutePath !== initial.absolutePath || refreshed.parentPath !== initial.parentPath) {
		fail(relPath, "destination path changed during authorization");
	}
	return refreshed;
}

function writeAll(fd: number, bytes: Buffer, relPath: string): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		let written: number;
		try {
			written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
		} catch (error) {
			fail(relPath, `temporary write failed: ${errorCode(error) ?? "write-failed"}`, error);
		}
		if (written <= 0) fail(relPath, "temporary write made no progress");
		offset += written;
	}
}

function syncFd(fd: number, relPath: string): void {
	try {
		fs.fsyncSync(fd);
	} catch (error) {
		fail(relPath, `temporary durability sync failed: ${errorCode(error) ?? "fsync-failed"}`, error);
	}
}

function syncParent(fd: number, relPath: string): void {
	if (process.platform === "win32") return;
	try {
		fs.fsyncSync(fd);
	} catch (error) {
		fail(relPath, `parent durability sync failed: ${errorCode(error) ?? "fsync-failed"}`, error);
	}
}

function tempName(parentPath: string, destinationPath: string): string {
	const base = path.basename(destinationPath);
	return path.join(parentPath, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

/**
 * Open and read one regular file only after path and identity admission. The
 * descriptor is the sole source of bytes; no path-based read occurs before the
 * pre-open lstat/open/fstat checks complete.
 */
export function openVerifiedFile(root: RootPin | string, relPath: string): Buffer;
export function openVerifiedFile(root: RootPin | string, relPath: string, encoding: BufferEncoding): string;
export function openVerifiedFile(
	rootInput: RootPin | string,
	relPath: string,
	encoding?: BufferEncoding,
): Buffer | string {
	const { root, contained } = containedFor(rootInput, relPath);
	if (contained.leafIdentity === null) fail(relPath, "verified file does not exist");
	const pathStat = lstatBigint(contained.absolutePath, relPath);
	if (!isRegularSingleLink(pathStat) || !sameIdentity(pathStat, contained.leafIdentity)) {
		fail(relPath, "verified file identity is not stable before open");
	}
	ensureRootStillBound(root, relPath);

	let fd: number;
	try {
		fd = fs.openSync(contained.absolutePath, fs.constants.O_RDONLY | NOFOLLOW);
	} catch (error) {
		fail(relPath, `verified file could not be opened: ${errorCode(error) ?? "open-failed"}`, error);
	}
	let closed = false;
	try {
		const opened = fstatBigint(fd, relPath);
		if (!isRegularSingleLink(opened) || !sameIdentity(opened, pathStat)) {
			fail(relPath, "verified file identity changed before disclosure");
		}
		const bytes = readDescriptor(fd, opened.size, relPath);
		const after = fstatBigint(fd, relPath);
		if (!samePathIdentity(opened, after)) fail(relPath, "verified file changed during read");
		closeFd(fd, relPath);
		closed = true;
		return encoding === undefined ? bytes : bytes.toString(encoding);
	} finally {
		if (!closed) {
			try {
				fs.closeSync(fd);
			} catch {
				// Preserve the first typed verification failure.
			}
		}
	}
}

/** Open a directory after the same lexical/component/identity admission. */
export function openVerifiedDir(rootInput: RootPin | string, relPath = ""): number {
	const { root, contained } = containedFor(rootInput, relPath);
	const directoryStat = lstatBigint(contained.absolutePath, relPath);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.dev !== root.dev) {
		fail(relPath, "verified directory is not a trusted directory");
	}
	ensureRootStillBound(root, relPath);
	let fd: number;
	try {
		fd = fs.openSync(contained.absolutePath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
	} catch (error) {
		fail(relPath, `verified directory could not be opened: ${errorCode(error) ?? "open-failed"}`, error);
	}
	let opened: fs.BigIntStats;
	try {
		opened = fstatBigint(fd, relPath);
	} catch (error) {
		try {
			fs.closeSync(fd);
		} catch {
			// Preserve the original descriptor failure.
		}
		throw error;
	}
	if (!opened.isDirectory() || opened.isSymbolicLink() || !sameIdentity(opened, directoryStat)) {
		try {
			fs.closeSync(fd);
		} catch {
			// Preserve the binding failure.
		}
		fail(relPath, "verified directory identity changed before open");
	}
	return fd;
}

/**
 * Publish bytes with exclusive mode-0600 staging, descriptor fsync, parent
 * identity checks, rename, parent durability, and full post-operation binding.
 * The pathname residual window is detected fail-closed after the operation;
 * this protocol does not claim prevention against a same-uid restored tree.
 */
export function publishVerified(
	rootInput: RootPin | string,
	relPath: string,
	content: string | Uint8Array,
	options?: VerifiedOpenOptions,
): PublishReceipt {
	const bytes = normalizeBytes(content);
	const { root, contained: initial } = containedFor(rootInput, relPath);
	if (initial.relativePath.length === 0) fail(relPath, "destination must name a file");
	const contained = finalContainedPath(root, initial, initial.relativePath);
	const preimage = recheckDestinationPreimage(contained, relPath);
	const parent = openParentDirectory(root, contained, relPath);
	const temporaryPath = tempName(contained.parentPath, contained.absolutePath);
	let tempFd: number | undefined;
	let renamed = false;
	try {
		try {
			const openedTemp = fs.openSync(
				temporaryPath,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
				0o600,
			);
			tempFd = openedTemp;
			fs.fchmodSync(openedTemp, 0o600);
		} catch (error) {
			fail(relPath, `exclusive temporary file could not be created: ${errorCode(error) ?? "open-failed"}`, error);
		}
		if (tempFd === undefined) fail(relPath, "exclusive temporary descriptor is unavailable");
		const stagedFd = tempFd;
		writeAll(stagedFd, bytes, relPath);
		syncFd(stagedFd, relPath);
		const temporaryStat = fstatBigint(stagedFd, relPath);
		if (
			!isRegularSingleLink(temporaryStat) ||
			temporaryStat.dev !== root.dev ||
			(temporaryStat.mode & 0o777n) !== 0o600n
		) {
			fail(relPath, "temporary file identity is not trusted");
		}

		ensureRootStillBound(root, relPath);
		const parentAgain = lstatBigint(contained.parentPath, relPath);
		if (!sameIdentity(parent.identity, parentAgain) || !parentAgain.isDirectory() || parentAgain.isSymbolicLink()) {
			fail(relPath, "destination parent identity changed before rename");
		}
		const parentFdAgain = fstatBigint(parent.fd, relPath);
		if (!sameIdentity(parent.identity, parentFdAgain))
			fail(relPath, "destination parent descriptor identity changed");
		const latest = finalContainedPath(root, contained, relPath);
		const latestPreimage = recheckDestinationPreimage(latest, relPath);
		if (
			preimage === null
				? latestPreimage !== null
				: latestPreimage === null || !sameIdentity(preimage, latestPreimage)
		) {
			fail(relPath, "destination preimage identity changed before rename");
		}
		try {
			options?.beforeRename?.();
		} catch (error) {
			fail(relPath, "pre-rename authorization hook failed", error);
		}
		try {
			const parentAfterHook = lstatBigint(contained.parentPath, relPath);
			if (
				!sameIdentity(parent.identity, parentAfterHook) ||
				!parentAfterHook.isDirectory() ||
				parentAfterHook.isSymbolicLink()
			) {
				fail(relPath, "destination parent identity changed after authorization");
			}
			const destinationAfterHook = recheckDestinationPreimage(latest, relPath);
			if (
				preimage === null
					? destinationAfterHook !== null
					: destinationAfterHook === null || !sameIdentity(preimage, destinationAfterHook)
			) {
				fail(relPath, "destination identity changed after authorization");
			}
		} catch (error) {
			if (error instanceof VerifiedStorageError) throw error;
			fail(relPath, "post-authorization binding could not be verified", error);
		}
		try {
			options?.afterAuthorization?.();
		} catch (error) {
			fail(relPath, "post-authorization hook failed", error);
		}
		try {
			fs.renameSync(temporaryPath, contained.absolutePath);
			renamed = true;
		} catch (error) {
			fail(relPath, `verified publish rename failed: ${errorCode(error) ?? "rename-failed"}`, error);
		}
		syncParent(parent.fd, relPath);
		unwrap(assertPathBinding(root, latest, identityReference(temporaryStat)), relPath);
		const digest = digestBytes(bytes);
		return Object.freeze({
			relPath: latest.relativePath,
			target: latest.absolutePath,
			digest,
			sha256: digest,
			changed: true,
			bytesWritten: bytes.byteLength,
		});
	} finally {
		if (tempFd !== undefined) {
			try {
				fs.closeSync(tempFd);
			} catch {
				// Preserve the original failure.
			}
		}
		if (!renamed) {
			try {
				fs.unlinkSync(temporaryPath);
			} catch {
				// Best-effort cleanup; preserve the original publish failure.
			}
		}
		try {
			fs.closeSync(parent.fd);
		} catch {
			// Preserve the original operation result/failure.
		}
	}
}
