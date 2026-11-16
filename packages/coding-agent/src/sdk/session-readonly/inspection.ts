import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeOwnerOnlySecurityResult } from "@gajae-code/natives";

export const MANAGED_ARTIFACT_MAX_DEPTH = 32;
export const MANAGED_ARTIFACT_MAX_FILES = 50_000;
export const MANAGED_ARTIFACT_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MANAGED_ARTIFACT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const MANAGED_SESSION_READ_RANGE_MAX_BYTES = 64 * 1024 * 1024;

export interface ManagedFileSnapshot {
	bytes: Buffer;
	identity: {
		dev: bigint;
		ino: bigint;
		nlink: bigint;
		size: number;
		mtimeNs: bigint;
		ctimeNs: bigint;
		sha256: string;
	};
}

/**
 * Descriptor identity of one managed file object. Append receipts include a
 * content digest when the append implementation has already computed it.
 */
export interface ManagedFileIdentity {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: number;
	mtimeNs: bigint;
	ctimeNs: bigint;
	sha256?: string;
}

export const U64_MAX = 18_446_744_073_709_551_615n;
export const I64_ABS_MIN = 9_223_372_036_854_775_808n;

export function canonicalFileId(value: bigint): bigint {
	if (value < -I64_ABS_MIN || value > U64_MAX) throw new Error("file_identity_out_of_range");
	return BigInt.asUintN(64, value);
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
	"access_denied",
	"mode_mismatch",
	"io_error",
]);
const ACL_QUERY_EVIDENCE = new Set(["absent", "unsupported"]);

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

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
			if (operation === "verify" && result.operation !== "query")
				throw new Error("Verify failure unexpectedly reports ACL mutation");
		} else if (result.operation !== undefined || result.attribute !== undefined) {
			throw new Error("Unexpected ACL fields on owner-only security failure");
		}
		if (!hasOnlyKeys(result, ["ok", "code", "operation", "attribute"]))
			throw new Error("Unexpected owner-only security failure fields");
		return value as NativeOwnerOnlySecurityResult;
	}
	if (process.platform !== "linux") {
		if (!hasOnlyKeys(result, ["ok"])) throw new Error("Malformed non-Linux security success");
		return value as NativeOwnerOnlySecurityResult;
	}
	if (result.platform !== "linux" || result.kind !== kind || result.protocol !== operation)
		throw new Error("Malformed Linux security success envelope");
	if (result.code !== undefined || result.operation !== undefined || result.attribute !== undefined)
		throw new Error("Unexpected failure fields on Linux security success");
	if (!hasOnlyKeys(result, ["ok", "platform", "kind", "protocol", "aclEvidence"]))
		throw new Error("Unexpected Linux security success fields");
	const evidence = result.aclEvidence;
	if (!evidence || typeof evidence !== "object") throw new Error("Missing Linux ACL evidence");
	const record = evidence as Record<string, unknown>;
	const validateAttribute = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") throw new Error("Malformed Linux ACL attribute evidence");
		const attribute = candidate as Record<string, unknown>;
		if (!hasOnlyKeys(attribute, ["clear", "query"])) throw new Error("Unexpected Linux ACL evidence fields");
		if (!ACL_CLEAR_EVIDENCE.has(String(attribute.clear)) || !ACL_QUERY_EVIDENCE.has(String(attribute.query)))
			throw new Error("Unknown Linux ACL attribute evidence");
		if (operation === "verify" && attribute.clear !== "not_run")
			throw new Error("Verify result unexpectedly reports ACL mutation");
		if (operation === "apply" && attribute.clear === "not_run")
			throw new Error("Apply result omitted ACL mutation evidence");
	};
	validateAttribute(record.access);
	if (kind === "directory") validateAttribute(record.default);
	else if (record.default !== undefined) throw new Error("File result unexpectedly carries default ACL evidence");
	if (!hasOnlyKeys(record, kind === "directory" ? ["access", "default"] : ["access"]))
		throw new Error("Unexpected Linux ACL evidence attributes");
	return value as NativeOwnerOnlySecurityResult;
}

export function identity(stat: fs.BigIntStats, sha256 = ""): ManagedFileSnapshot["identity"] {
	return {
		dev: canonicalFileId(stat.dev),
		ino: canonicalFileId(stat.ino),
		nlink: stat.nlink,
		size: Number(stat.size),
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
		sha256,
	};
}

export function sameIdentity(left: ManagedFileSnapshot["identity"], right: ManagedFileSnapshot["identity"]): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export function captureManagedFilePrefixNoFollow(pathname: string, maxBytes: number): ManagedFileSnapshot {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_capture_limit");
	return captureManagedFileNoFollowLimit(pathname, maxBytes);
}

/** Captures a complete no-follow file only after descriptor-size admission and before allocating its bytes. */
export function captureManagedFileNoFollowBounded(
	pathname: string,
	maxBytes: number,
	admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
): ManagedFileSnapshot {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_capture_limit");
	return captureManagedFileNoFollowLimit(pathname, maxBytes, true, admitSize);
}

/** Captures header/hash/copy input from one no-follow descriptor and rechecks the pathname before use. */
export function captureManagedFileNoFollow(pathname: string): ManagedFileSnapshot {
	return captureManagedFileNoFollowLimit(pathname);
}

export function captureManagedFileNoFollowLimit(
	pathname: string,
	maxBytes?: number,
	rejectOversized = false,
	admitSize?: (size: number, descriptor: ManagedFileIdentity) => void,
): ManagedFileSnapshot {
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
	let failed = false;
	let failure: unknown;
	let snapshot: ManagedFileSnapshot | undefined;
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || (rejectOversized ? before.nlink !== 1n : before.nlink > 1n))
			throw new Error("source_changed");
		const fileSize = Number(before.size);
		if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error("source_changed");
		if (rejectOversized && maxBytes !== undefined && fileSize > maxBytes)
			throw new Error("artifact_capacity_exceeded");
		admitSize?.(fileSize, identity(before));
		const captureSize = maxBytes === undefined ? fileSize : Math.min(fileSize, maxBytes);
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
		snapshot = { bytes, identity: identity(before, createHash("sha256").update(bytes).digest("hex")) };
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		fs.closeSync(fd);
	} catch (error) {
		if (!failed) {
			failed = true;
			failure = error;
		}
	}
	if (failed) throw failure;
	if (!snapshot) throw new Error("Managed file capture is unavailable");
	return snapshot;
}

/** Streams a managed file once while retaining only a bounded header prefix and the full descriptor-bound digest. */
export function inspectManagedFileNoFollow(pathname: string, prefixLimit: number): ManagedFileSnapshot {
	if (!Number.isSafeInteger(prefixLimit) || prefixLimit < 0) throw new Error("invalid_capture_limit");
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.nlink > 1) throw new Error("source_changed");
		const prefix = Buffer.alloc(Math.min(Number(before.size), prefixLimit));
		const hash = createHash("sha256");
		const chunk = Buffer.alloc(64 * 1024);
		let offset = 0;
		for (;;) {
			const count = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
			if (count === 0) break;
			hash.update(chunk.subarray(0, count));
			if (offset < prefix.byteLength) {
				const copied = Math.min(count, prefix.byteLength - offset);
				chunk.copy(prefix, offset, 0, copied);
			}
			offset += count;
		}
		if (offset !== Number(before.size)) throw new Error("source_changed");
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameIdentity(identity(before), identity(after))) throw new Error("source_changed");
		const named = fs.lstatSync(pathname, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(identity(before), identity(named)))
			throw new Error("source_changed");
		return { bytes: prefix, identity: identity(before, hash.digest("hex")) };
	} finally {
		fs.closeSync(fd);
	}
}

export interface ManagedArtifactTreeLimits {
	maxFiles?: number;
	maxTotalBytes?: number;
}

/** Bounds a no-follow artifact tree before it can be copied or deleted. */
export function validateManagedArtifactTree(root: string, limits: ManagedArtifactTreeLimits = {}): void {
	const clampLimit = (limit: number | undefined, maximum: number): number => {
		if (limit === undefined) return maximum;
		if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) throw new Error("unsafe_artifacts");
		return Math.min(limit, maximum);
	};
	const maxFiles = clampLimit(limits.maxFiles, MANAGED_ARTIFACT_MAX_FILES);
	const maxTotalBytes = clampLimit(limits.maxTotalBytes, MANAGED_ARTIFACT_MAX_TOTAL_BYTES);
	let entries = 0;
	let files = 0;
	let bytes = 0;
	const visit = (directory: string, depth: number): void => {
		if (depth > MANAGED_ARTIFACT_MAX_DEPTH) throw new Error("unsafe_artifacts");
		const handle = fs.opendirSync(directory);
		try {
			for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
				entries++;
				if (entries > maxFiles) throw new Error("artifact_capacity_exceeded");
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
				if (files > maxFiles || bytes > maxTotalBytes) throw new Error("artifact_capacity_exceeded");
			}
		} finally {
			handle.closeSync();
		}
	};
	const rootStat = fs.lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe_artifacts");
	visit(root, 0);
}
