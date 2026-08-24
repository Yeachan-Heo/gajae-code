import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
	NativeOwnerOnlySecurityResult,
	RecoveryFsIdentity,
	RecoveryFsRoot,
} from "@gajae-code/natives";
import { isEnoent, logger } from "@gajae-code/utils";
import type { SessionStorageRangeSnapshot, SessionStorageStat } from "../session-storage";
import {
	classifyNativePublishOutcome,
	formatNativePublishDiagnostic,
	mayCleanCurrentStaging,
	type NativePublishOutcome,
} from "./native-publish-outcome";

type NativeManagedSessionStorage = Pick<
	typeof import("@gajae-code/natives"),
	| "applyOwnerOnlyFdSecurity"
	| "applyOwnerOnlyPathSecurity"
	| "exactRemoveDirectoryTree"
	| "exactReplacePath"
	| "exactUnlink"
	| "linkNoReplacePath"
	| "linkNoReplacePathAsync"
	| "openRecoveryFsRoot"
	| "renameNoReplacePath"
	| "renameNoReplacePathAsync"
	| "repairOwnerOnlyPathSecurityExpected"
	| "snapshotDirectoryTree"
	| "verifyOwnerOnlyFdSecurity"
	| "verifyOwnerOnlyPathSecurity"
	| "verifyOwnerOnlyPathSecurityExpected"
>;

function nativeSessionStorage(): NativeManagedSessionStorage {
	return require("@gajae-code/natives") as NativeManagedSessionStorage;
}

export const MANAGED_ARTIFACT_MAX_DEPTH = 32;
export const MANAGED_ARTIFACT_MAX_FILES = 50_000;
export const MANAGED_ARTIFACT_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MANAGED_ARTIFACT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES = 64 * 1024;
const REPLACEMENT_CLEANUP_RECEIPT_SCAN_LIMIT = MANAGED_ARTIFACT_MAX_FILES;
export const MANAGED_ARTIFACT_COPY_BATCH_SIZE = 256;
const LOCK_LEASE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export class ManagedPublishError extends Error {
	readonly classification:
		| "destination_conflict"
		| "atomic_unavailable"
		| "invalid_request"
		| "durability_not_provable"
		| "identity_mismatch"
		| "io_error"
		| "durability_failed";
	readonly diagnostic: string;
	readonly stagingCleanupSafe: boolean;

	constructor(classification: ManagedPublishError["classification"], outcome: NativePublishOutcome) {
		super(classification);
		this.name = "ManagedPublishError";
		this.classification = classification;
		this.diagnostic = formatNativePublishDiagnostic(outcome);
		this.stagingCleanupSafe = mayCleanCurrentStaging(outcome);
	}
}
export class ManagedReplaceError extends Error {
	readonly code: string;
	readonly cleanupReceiptPath: string;
	readonly detachedPath: string | undefined;
	readonly retainedSuccessorPath: string | undefined;
	readonly retainedPlaceholderPath: string | undefined;
	readonly retainedUnknownPath: string | undefined;
	/** Path-free Windows NTSTATUS of the underlying pre-mutation failure, when
	 * the native layer preserved one (e.g. `0xC0000043` for a sharing violation). */
	readonly windowsErrorCode: string | undefined;
	readonly replacementCause: unknown;

	constructor(result: NativeExactUnlinkResult, cleanupReceiptPath: string, replacementCause?: unknown) {
		const code = result.code ?? "unknown";
		super(`managed_replace_failed:${code}`, replacementCause === undefined ? undefined : { cause: replacementCause });
		this.name = "ManagedReplaceError";
		this.code = code;
		this.cleanupReceiptPath = cleanupReceiptPath;
		this.detachedPath = result.detachedPath;
		this.retainedSuccessorPath = result.retainedSuccessorPath;
		this.retainedPlaceholderPath = result.retainedPlaceholderPath;
		this.retainedUnknownPath = result.retainedUnknownPath;
		this.windowsErrorCode = result.windowsErrorCode;
		this.replacementCause = replacementCause;
	}
}

export class ManagedCommittedMutationError extends Error {
	constructor(
		readonly operation: "replace" | "append",
		cause: unknown,
	) {
		super(`managed_${operation}_committed_outcome_uncertain`, { cause });
		this.name = "ManagedCommittedMutationError";
	}
}

function managedAppendFailure(code: string | undefined): Error {
	const error = new Error(code ?? "managed_append_failed");
	return code === "content_too_large" || code === "too_large" || code === "header_patch_write_failed"
		? error
		: new ManagedCommittedMutationError("append", error);
}

function publishFailure(outcome: NativePublishOutcome): ManagedPublishError {
	const classification =
		outcome.reason === "destination_exists"
			? "destination_conflict"
			: outcome.reason === "atomic_unavailable"
				? "atomic_unavailable"
				: outcome.reason === "invalid_request"
					? "invalid_request"
					: outcome.reason === "durability_not_provable"
						? "durability_not_provable"
						: outcome.reason === "identity_violation"
							? "identity_mismatch"
							: outcome.reason === "io_failure"
								? "io_error"
								: "durability_failed";
	return new ManagedPublishError(classification, outcome);
}

function exactUnlinkCompleted(result: NativeExactUnlinkResult): boolean {
	return (
		result.ok ||
		(result.code === "cleanup_pending" &&
			result.payloadDurable === true &&
			result.detachedPath !== undefined &&
			result.retainedSuccessorPath === undefined &&
			result.retainedUnknownPath === undefined)
	);
}

function isRetryableReplacementReceiptCleanupError(error: unknown): boolean {
	return error instanceof Error && error.message === "managed_replace_receipt_cleanup_pending:io_error";
}

/** A same-filesystem rename updates the moved root's ctime but no other tree identity. */
function sameDirectoryTreeSnapshotAfterRename(
	left: NativeDirectoryTreeSnapshot,
	right: NativeDirectoryTreeSnapshot,
): boolean {
	return (
		left.rootDev === right.rootDev &&
		left.rootIno === right.rootIno &&
		left.entries.length === right.entries.length &&
		left.entries.every((entry, index) => {
			const other = right.entries[index];
			return (
				other !== undefined &&
				entry.relativePath === other.relativePath &&
				entry.kind === other.kind &&
				entry.dev === other.dev &&
				entry.ino === other.ino &&
				entry.nlink === other.nlink &&
				entry.size === other.size &&
				entry.mtimeNs === other.mtimeNs &&
				(entry.relativePath === "" || entry.ctimeNs === other.ctimeNs) &&
				entry.sha256 === other.sha256
			);
		})
	);
}

/** A managed move outcome that reports whether the mutation is known not to have committed. */
export class ManagedTreeMoveOutcomeError extends Error {
	constructor(
		message: string,
		readonly stagingCleanupSafe: boolean,
	) {
		super(message);
	}
}

/** Cleanup is safe only when the native move reports that it did not commit. */
export function mayCleanManagedTreeStaging(error: unknown): boolean {
	return !(error instanceof ManagedTreeMoveOutcomeError) || error.stagingCleanupSafe;
}

/**
 * A filesystem that implements no `renameat2` rename flag at all rejects the no-replace publish
 * before mutating anything: NFS answers `EINVAL` (`invalid_request`) and kernels older than 3.15
 * answer `ENOSYS` (`atomic_unavailable`). Only those two pre-mutation outcomes authorize the
 * `linkat` stand-in; every other failure describes a publish that was actually attempted, and
 * retrying it under a different primitive could publish twice.
 */
export function renameFlagsUnsupported(outcome: NativePublishOutcome): boolean {
	return (
		!outcome.ok &&
		mayCleanCurrentStaging(outcome) &&
		(outcome.reason === "atomic_unavailable" || outcome.reason === "invalid_request")
	);
}

export type ManagedSessionSecurityPolicy = "default" | "windows-existing-verify-first";

export type ManagedStorageFailure =
	| "migration_busy"
	| "binding_conflict"
	| "binding_invalid"
	| "destination_conflict"
	| "source_changed"
	| "unsafe_artifacts"
	| "artifact_capacity_exceeded"
	| "durability_failed"
	| "atomic_unavailable"
	| "durability_not_provable"
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

/**
 * Post-operation evidence for one managed append. `descriptor` is the
 * `SessionStorageStat`-shaped snapshot of the retained/successor object captured
 * AFTER the append has been synchronized (never a pathname `statSync`); `identity`
 * carries the same fields as the object identity. The SessionManager feeds
 * `descriptor` directly into the commit-marker snapshot.
 */
export interface ManagedAppendReceipt {
	descriptor: SessionStorageStat;
	identity: ManagedFileIdentity;
}

function sameManagedIdentity(left: ManagedFileIdentity, right: ManagedFileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export interface ManagedBoundedAppendExpectation {
	readonly dev: string;
	readonly ino: string;
	readonly nlink: string;
	readonly size: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly sha256: string;
}

function managedFileIdentityFromNative(identity: RecoveryFsIdentity): ManagedFileIdentity {
	return {
		dev: BigInt(identity.dev),
		ino: BigInt(identity.ino),
		nlink: BigInt(identity.nlink),
		size: Number(identity.size),
		mtimeNs: BigInt(identity.mtimeNs),
		ctimeNs: BigInt(identity.ctimeNs),
		...(identity.sha256 ? { sha256: identity.sha256 } : {}),
	};
}

function managedAppendReceiptFromIdentity(identity: ManagedFileIdentity): ManagedAppendReceipt {
	return {
		identity,
		descriptor: {
			dev: identity.dev,
			ino: identity.ino,
			nlink: identity.nlink,
			size: identity.size,
			mtimeMs: Number(identity.mtimeNs) / 1_000_000,
			mtimeNs: identity.mtimeNs,
			ctimeNs: identity.ctimeNs,
			mtime: new Date(Number(identity.mtimeNs) / 1_000_000),
			isFile: true,
		},
	};
}

type SerializedReplacementIdentity = {
	dev: string;
	ino: string;
	nlink: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
	sha256: string;
};

type ReplacementCleanupReceipt = {
	version: 3;
	staging: string;
	destination: string;
	successor: SerializedReplacementIdentity;
	predecessor: SerializedReplacementIdentity;
};

type LegacyReplacementCleanupIdentity = {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	sha256: string;
};

const U64_MAX = 18_446_744_073_709_551_615n;

function parseCanonicalU64(value: unknown): bigint | undefined {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) return undefined;
	const parsed = BigInt(value);
	return parsed <= U64_MAX ? parsed : undefined;
}

function parseLegacyHexU64(value: string): bigint | undefined {
	if (!/^[0-9a-f]+$/.test(value) || value.length > 16) return undefined;
	const parsed = BigInt(`0x${value}`);
	return parsed <= U64_MAX ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function legacyReplacementCleanupReceiptBinding(name: string): { dev: bigint; ino: bigint } | undefined {
	const match = /^\.gjc-replace-cleanup-([0-9a-f]+)-([0-9a-f]+)\.json$/.exec(name);
	if (!match?.[1] || !match[2]) return undefined;
	const dev = parseLegacyHexU64(match[1]);
	const ino = parseLegacyHexU64(match[2]);
	return dev !== undefined && ino !== undefined ? { dev, ino } : undefined;
}

function parseLegacyReplacementCleanupIdentity(value: unknown): LegacyReplacementCleanupIdentity | undefined {
	const identity = asRecord(value);
	if (!identity) return undefined;
	const dev = parseCanonicalU64(identity.dev);
	const ino = parseCanonicalU64(identity.ino);
	const nlink = parseCanonicalU64(identity.nlink);
	const size = parseCanonicalU64(identity.size);
	const mtimeNs = parseCanonicalU64(identity.mtimeNs);
	const ctimeNs = parseCanonicalU64(identity.ctimeNs);
	const sha256 = identity.sha256;
	if (
		dev === undefined ||
		ino === undefined ||
		nlink === undefined ||
		size === undefined ||
		mtimeNs === undefined ||
		ctimeNs === undefined ||
		typeof sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(sha256)
	)
		return undefined;
	return { dev, ino, nlink, size, mtimeNs, ctimeNs, sha256 };
}

function parseLegacyReplacementCleanupReceipt(
	bytes: Uint8Array,
): { predecessor: string; successor: string; identity: LegacyReplacementCleanupIdentity } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
	} catch {
		return undefined;
	}
	const receipt = asRecord(value);
	if (receipt?.version !== 1 || typeof receipt.predecessor !== "string" || typeof receipt.successor !== "string")
		return undefined;
	const identity = parseLegacyReplacementCleanupIdentity(receipt.identity);
	return identity ? { predecessor: receipt.predecessor, successor: receipt.successor, identity } : undefined;
}

function replacementCleanupReceiptBinding(
	name: string,
): { predecessor: { dev: bigint; ino: bigint }; receipt: { dev: bigint; ino: bigint } } | undefined {
	const match =
		/^\.gjc-replace-cleanup-(0|[1-9a-f][0-9a-f]*)-(0|[1-9a-f][0-9a-f]*)-receipt-(0|[1-9a-f][0-9a-f]*)-(0|[1-9a-f][0-9a-f]*)\.json$/.exec(
			name,
		);
	if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
	const predecessor = { dev: BigInt(`0x${match[1]}`), ino: BigInt(`0x${match[2]}`) };
	const receipt = { dev: BigInt(`0x${match[3]}`), ino: BigInt(`0x${match[4]}`) };
	return predecessor.dev <= U64_MAX && predecessor.ino <= U64_MAX && receipt.dev <= U64_MAX && receipt.ino <= U64_MAX
		? { predecessor, receipt }
		: undefined;
}

function parseReplacementIdentity(value: unknown): ManagedFileSnapshot["identity"] | undefined {
	const parsed = parseLegacyReplacementCleanupIdentity(value);
	if (!parsed || parsed.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
	return {
		dev: parsed.dev,
		ino: parsed.ino,
		nlink: parsed.nlink,
		size: Number(parsed.size),
		mtimeNs: parsed.mtimeNs,
		ctimeNs: parsed.ctimeNs,
		sha256: parsed.sha256,
	};
}

function parseReplacementCleanupReceipt(bytes: Uint8Array): ReplacementCleanupReceipt | undefined {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
	} catch {
		return undefined;
	}
	const receipt = asRecord(value);
	if (
		receipt?.version !== 3 ||
		typeof receipt.staging !== "string" ||
		typeof receipt.destination !== "string" ||
		!parseReplacementIdentity(receipt.successor) ||
		!parseReplacementIdentity(receipt.predecessor)
	)
		return undefined;
	return receipt as ReplacementCleanupReceipt;
}

function serializeReplacementIdentity(identity: ManagedFileSnapshot["identity"]): SerializedReplacementIdentity {
	return {
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		nlink: identity.nlink.toString(),
		size: String(identity.size),
		mtimeNs: identity.mtimeNs.toString(),
		ctimeNs: identity.ctimeNs.toString(),
		sha256: identity.sha256,
	};
}

function replacementReceiptPath(
	baseDir: string,
	predecessor: ManagedFileSnapshot["identity"],
	receipt: ManagedFileSnapshot["identity"],
): string {
	return path.join(
		baseDir,
		`.gjc-replace-cleanup-${predecessor.dev.toString(16)}-${predecessor.ino.toString(16)}-receipt-${receipt.dev.toString(16)}-${receipt.ino.toString(16)}.json`,
	);
}

function replacementReceiptRetirementName(
	receipt: { dev: bigint; ino: bigint },
	predecessor: { dev: bigint; ino: bigint },
): string {
	return `.gjc-receipt-remove-${receipt.dev.toString(16)}-${receipt.ino.toString(16)}-${predecessor.dev.toString(16)}-${predecessor.ino.toString(16)}`;
}

function replacementReceiptPlaceholderRetirementName(
	placeholder: { dev: bigint; ino: bigint },
	predecessor: { dev: bigint; ino: bigint },
	receipt: { dev: bigint; ino: bigint },
): string {
	return `.gjc-receipt-placeholder-remove-${placeholder.dev.toString(16)}-${placeholder.ino.toString(16)}-${predecessor.dev.toString(16)}-${predecessor.ino.toString(16)}-${receipt.dev.toString(16)}-${receipt.ino.toString(16)}`;
}

/**
 * Terminal write-protocol remnant names. The POSIX exact-unlink fallback cannot
 * descriptor-unlink, so it detaches, scrubs, and retains zero-length quarantine
 * entries and exchange placeholders instead of removing them (`cleanup_pending`
 * with a durable payload). Linux completes deletion through the retained
 * directory authority, but macOS has no retained authority, so every managed
 * replacement leaks its scrubbed remnants and scope directories grow without
 * bound (tens of thousands of dirents per workspace), degrading every
 * per-mutation receipt scan and widening quarantine-collision windows.
 */
const SCRUBBED_REMNANT_PREFIXES = [
	".gjc-exact-unlink-placeholder-",
	".gjc-exact-replace-destination-",
	".gjc-receipt-remove-",
	".gjc-receipt-placeholder-remove-",
	".gjc-replace-retry-",
] as const;

/** In-flight protocol steps complete in milliseconds; anything older is abandoned. */
const SCRUBBED_REMNANT_MIN_AGE_MS = 15 * 60 * 1000;

/** Minimum interval between best-effort remnant reaps of one bound store directory. */
const SCRUBBED_REMNANT_REAP_INTERVAL_MS = 60_000;

export interface ScrubbedProtocolRemnantReapResult {
	readonly reaped: number;
	readonly failures: number;
}

function reportScrubbedProtocolRemnantReap(reaped: number, failures: number): ScrubbedProtocolRemnantReapResult {
	if (failures > 0)
		logger.warn("Managed session remnant reaping completed with failures", {
			failureCount: failures,
			reapedCount: reaped,
		});
	return { reaped, failures };
}

/**
 * Best-effort removal of scrubbed write-protocol remnants from one managed
 * directory. Only zero-length, single-link, non-symlink regular files whose
 * names carry a terminal remnant prefix and whose timestamps are older than
 * the age gate are removed: a zero-length single-link entry is exactly what
 * the scrub proof leaves behind, and non-zero entries (displaced predecessors
 * or detached receipts retained as evidence) are never touched. A proven
 * concurrent disappearance (ENOENT) is benign; all other I/O failures are
 * returned and logged once without aborting scope preparation.
 */
export function reapScrubbedProtocolRemnantsSync(
	directory: string,
	minAgeMs: number = SCRUBBED_REMNANT_MIN_AGE_MS,
): ScrubbedProtocolRemnantReapResult {
	let names: string[];
	try {
		names = fs.readdirSync(directory);
	} catch (error) {
		return reportScrubbedProtocolRemnantReap(0, isEnoent(error) ? 0 : 1);
	}
	const cutoff = Date.now() - minAgeMs;
	let reaped = 0;
	let failures = 0;
	for (const name of names) {
		if (!SCRUBBED_REMNANT_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
		const pathname = path.join(directory, name);
		try {
			const named = fs.lstatSync(pathname);
			if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== 0) continue;
			if (named.mtimeMs > cutoff) continue;
			fs.unlinkSync(pathname);
			reaped += 1;
		} catch (error) {
			if (!isEnoent(error)) failures += 1;
		}
	}
	return reportScrubbedProtocolRemnantReap(reaped, failures);
}

/** Number of candidate remnants inspected between event-loop yields. */
const SCRUBBED_REMNANT_REAP_BATCH_SIZE = 256;

/**
 * Async twin of {@link reapScrubbedProtocolRemnantsSync} with the same safety
 * filters (terminal remnant prefix, zero-length, single-link, non-symlink,
 * older than the age gate), yielding between bounded batches. Long-lived
 * processes reap per-session descendant directories through this path so a
 * legacy oversized directory cannot starve timers or sibling subagents while
 * it is being drained (issue #4394).
 */
export async function reapScrubbedProtocolRemnants(
	directory: string,
	minAgeMs: number = SCRUBBED_REMNANT_MIN_AGE_MS,
): Promise<ScrubbedProtocolRemnantReapResult> {
	let names: string[];
	try {
		names = await fsp.readdir(directory);
	} catch (error) {
		return reportScrubbedProtocolRemnantReap(0, isEnoent(error) ? 0 : 1);
	}
	const cutoff = Date.now() - minAgeMs;
	let reaped = 0;
	let failures = 0;
	let scanned = 0;
	for (const name of names) {
		if (!SCRUBBED_REMNANT_PREFIXES.some(prefix => name.startsWith(prefix))) continue;
		if (++scanned % SCRUBBED_REMNANT_REAP_BATCH_SIZE === 0) await Bun.sleep(0);
		const pathname = path.join(directory, name);
		try {
			const named = await fsp.lstat(pathname);
			if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== 0) continue;
			if (named.mtimeMs > cutoff) continue;
			await fsp.unlink(pathname);
			reaped += 1;
		} catch (error) {
			if (!isEnoent(error)) failures += 1;
		}
	}
	return reportScrubbedProtocolRemnantReap(reaped, failures);
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
			if (operation === "verify" && result.operation !== "query") {
				throw new Error("Verify failure unexpectedly reports ACL mutation");
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
	released?: boolean;
};

export interface ManagedLockRetirementTestEvent {
	readonly path: string;
	readonly attemptId: string;
}

export interface ManagedLockReleaseTestEvent {
	readonly path: string;
	readonly fd: number;
}

/** Test-only seams around managed lock retirement and release verification. */
export const ManagedLockTestHooks: {
	beforeObservedRetirement?: (event: ManagedLockRetirementTestEvent) => void;
	beforeReleaseDescriptorVerification?: (event: ManagedLockReleaseTestEvent) => void;
} = {};

/** Captured configured-root authority for managed paths only. */
export interface ManagedDirectoryRoot {
	readonly canonicalPath: string;
	readonly dev: bigint;
	readonly ino: bigint;
}

/**
 * Establish the first managed directory beneath a potentially shared ancestor.
 * The ancestor is used only to create the managed chain; every component from
 * `configuredRoot` downward is independently type, symlink, owner, mode, and
 * ACL checked. This deliberately does not impose owner-only policy on `/tmp`.
 */
export function prepareManagedDirectoryRoot(
	configuredRoot: string,
	policy: ManagedSessionSecurityPolicy = "default",
): ManagedDirectoryRoot {
	const target = path.resolve(configuredRoot);
	const missing: string[] = [];
	let existing = target;
	for (;;) {
		try {
			assertSafeDirectory(existing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw new Error(`Managed root is unavailable: ${configuredRoot}`);
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
	let current = fs.realpathSync.native(existing);
	for (const component of missing) {
		current = path.join(current, component);
		const created = ensureDirectoryComponent(current);
		secureManagedDirectory(current, created, policy);
	}
	if (missing.length === 0) secureManagedDirectory(current, false, policy);
	return managedDirectoryRoot(current);
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
	const rootAuthority = nativeSessionStorage().openRecoveryFsRoot(root.canonicalPath);
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

class ManagedSecurityError extends Error {
	readonly #classification: string;

	constructor(pathname: string, result: NativeSecurity) {
		const classification = result.ok ? "unexpected_security_state" : result.code;
		super(
			result.ok
				? `Unexpected security state for ${pathname}`
				: `Owner-only security rejected ${pathname}: ${classification}`,
		);
		this.name = "ManagedSecurityError";
		this.#classification = classification;
	}

	getClassification(): string {
		return this.#classification;
	}
}

export function managedSecurityFailureClassification(error: unknown): string | undefined {
	return error instanceof ManagedSecurityError ? error.getClassification() : undefined;
}

function securityError(pathname: string, result: NativeSecurity): Error {
	return new ManagedSecurityError(pathname, result);
}

function secure(pathname: string, kind: "directory" | "file"): void {
	const applied = validateNativeSecurityResult(
		nativeSessionStorage().applyOwnerOnlyPathSecurity(pathname, kind),
		"apply",
		kind,
	);
	if (!applied.ok) throw securityError(pathname, applied);
	const verified = validateNativeSecurityResult(
		nativeSessionStorage().verifyOwnerOnlyPathSecurity(pathname, kind),
		"verify",
		kind,
	);
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
		nativeSessionStorage().verifyOwnerOnlyPathSecurityExpected(pathname, kind, expected.dev, expected.ino),
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
		nativeSessionStorage().verifyOwnerOnlyPathSecurityExpected(pathname, kind, named.dev, named.ino),
		"verify",
		kind,
	);
	assertManagedPathIdentity(pathname, kind, named);
	if (verified.ok) return;
	if (verified.code !== "acl_verify_failed") throw securityError(pathname, verified);
	const repaired = validateNativeSecurityResult(
		nativeSessionStorage().repairOwnerOnlyPathSecurityExpected(pathname, kind, named.dev, named.ino),
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
	#ownsAuthority = false;
	#closed = false;
	#reconcilingReplacementCleanup = false;
	#remnantReapInFlight = false;
	#lastRemnantReapAttempt = 0;
	readonly #authorityBaseDir: string;
	/** Logical profile root inherited by nested managed session destinations. */
	readonly #profileAgentDir: string;
	readonly #subtreeRoot: ManagedDirectoryRoot;

	constructor(
		root: ManagedDirectoryRoot,
		baseDir: string,
		retained?: { authority: RecoveryFsRoot; authorityBaseDir: string },
		policy?: ManagedSessionSecurityPolicy,
		profileAgentDir?: string,
	) {
		managedRelativePath(root, baseDir);

		this.#root = root;
		this.#baseDir = path.resolve(baseDir);
		this.#policy = policy ?? "default";
		this.#profileAgentDir = profileAgentDir ?? root.canonicalPath;
		this.#authorityBaseDir = retained?.authorityBaseDir ?? this.#baseDir;
		if (retained) {
			const relative = path.relative(retained.authorityBaseDir, this.#baseDir).split(path.sep).join("/");
			// For the root case (authorityBaseDir === baseDir, relative === ""), the
			// stable identity() result carries the exact root dev/inode without
			// snapshotting the entire live session tree. snapshotManagedTree("")
			// walks every mutable descendant, so concurrent writers (other GJC
			// processes appending jsonl/resident-cache/recovery data) make the
			// snapshot return identity_mismatch (#3906). Mirrors #assertBound(),
			// which already uses identity() for this same case. Nested descendants
			// (relative !== "") still snapshot their subtree as before.
			if (relative === "") {
				const rootIdentity = retained.authority.identity();
				if (!rootIdentity.ok || !rootIdentity.identity)
					throw new Error(rootIdentity.code ?? "Managed subtree identity unavailable");
				this.#subtreeRoot = Object.freeze({
					canonicalPath: this.#baseDir,
					dev: BigInt(rootIdentity.identity.dev),
					ino: BigInt(rootIdentity.identity.ino),
				});
			} else {
				const captured = retained.authority.snapshotManagedTree(relative);
				if (!captured.ok || !captured.snapshot)
					throw new Error(captured.code ?? "Managed subtree identity unavailable");
				this.#subtreeRoot = Object.freeze({
					canonicalPath: this.#baseDir,
					dev: BigInt(captured.snapshot.rootDev),
					ino: BigInt(captured.snapshot.rootIno),
				});
			}
			this.#authority = retained.authority;
			this.#assertBound();

			return;
		}
		assertManagedDirectoryRoot(root);
		ensureManagedDirectory(this.#baseDir, root, this.#policy);
		const subtreeStat = fs.lstatSync(this.#baseDir, { bigint: true });
		this.#subtreeRoot = Object.freeze({ canonicalPath: this.#baseDir, dev: subtreeStat.dev, ino: subtreeStat.ino });
		if (process.platform === "linux") {
			const before = fs.lstatSync(this.#baseDir, { bigint: true });
			const authority = nativeSessionStorage().openRecoveryFsRoot(this.#baseDir);
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
			this.#ownsAuthority = true;
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

	get profileAgentDir(): string {
		return this.#profileAgentDir;
	}

	deriveSubtree(relativePath: string): ManagedSessionDescendantStore {
		const child = this.ensureDirectory(relativePath);
		const resolved = this.#resolve(relativePath);
		if (!this.#authority)
			return new ManagedSessionDescendantStore(this.#root, resolved, undefined, this.#policy, this.#profileAgentDir);
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
			this.#profileAgentDir,
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

	/**
	 * Release an authority this store opened itself. Retained authorities are owned by
	 * the security context that supplied them and are never closed here. Idempotent.
	 */
	close(): void {
		if (this.#closed || !this.#ownsAuthority || !this.#authority) return;
		this.#closed = true;
		this.#authority.close();
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
					nativeSessionStorage().verifyOwnerOnlyPathSecurity(this.#baseDir, "directory"),
					"verify",
					"directory",
				);
				if (!verified.ok) throw securityError(this.#baseDir, verified);
			}
		}
		this.#assertBound();
	}
	#assertBound(): void {
		if (!this.#authority) {
			const named = fs.statSync(this.#baseDir, { bigint: true });
			if (!named.isDirectory() || named.dev !== this.#subtreeRoot.dev || named.ino !== this.#subtreeRoot.ino)
				throw new Error("Managed descendant root binding changed");
			return;
		}
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

	#recoverReplacementCleanupPlaceholder(
		receiptPath: string,
		binding: { predecessor: { dev: bigint; ino: bigint }; receipt: { dev: bigint; ino: bigint } },
		placeholder: ManagedFileSnapshot,
	): boolean {
		if (placeholder.bytes.byteLength !== 0) return false;
		const detachedReceiptPath = path.join(
			this.#baseDir,
			replacementReceiptRetirementName(binding.receipt, binding.predecessor),
		);
		let detachedReceipt: ManagedFileSnapshot;
		try {
			detachedReceipt = captureManagedFileNoFollow(detachedReceiptPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (detachedReceipt.identity.dev !== binding.receipt.dev || detachedReceipt.identity.ino !== binding.receipt.ino)
			return false;

		const quarantineName = replacementReceiptPlaceholderRetirementName(
			placeholder.identity,
			binding.predecessor,
			binding.receipt,
		);
		const removed = nativeSessionStorage().exactUnlink(receiptPath, {
			dev: placeholder.identity.dev,
			ino: placeholder.identity.ino,
			nlink: placeholder.identity.nlink,
			parentDev: this.#subtreeRoot.dev,
			parentIno: this.#subtreeRoot.ino,
			size: BigInt(placeholder.identity.size),
			mtimeNs: placeholder.identity.mtimeNs,
			sha256: placeholder.identity.sha256,
			quarantineName,
		});
		if (
			(!exactUnlinkCompleted(removed) && removed.code !== "not_found") ||
			removed.retainedSuccessorPath !== undefined ||
			removed.retainedUnknownPath !== undefined
		)
			throw new Error(`managed_replace_receipt_cleanup_pending:${removed.code ?? "unknown"}`);
		fsyncDirectory(this.#baseDir);
		return true;
	}

	#detachReplacementCleanupReceipt(receiptPath: string): void {
		const binding = replacementCleanupReceiptBinding(path.basename(receiptPath));
		if (!binding) throw new Error("managed_replace_cleanup_receipt_invalid");
		let receipt: ManagedFileSnapshot;
		try {
			receipt = captureManagedFilePrefixNoFollow(receiptPath, REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (receipt.identity.dev !== binding.receipt.dev || receipt.identity.ino !== binding.receipt.ino) {
			if (this.#recoverReplacementCleanupPlaceholder(receiptPath, binding, receipt)) return;
			throw new Error("managed_replace_cleanup_receipt_invalid");
		}
		const predecessor = binding.predecessor;
		const quarantineName = replacementReceiptRetirementName(receipt.identity, predecessor);
		const detached = nativeSessionStorage().exactUnlink(receiptPath, {
			dev: receipt.identity.dev,
			ino: receipt.identity.ino,
			nlink: receipt.identity.nlink,
			parentDev: this.#subtreeRoot.dev,
			parentIno: this.#subtreeRoot.ino,
			size: BigInt(receipt.identity.size),
			mtimeNs: receipt.identity.mtimeNs,
			sha256: receipt.identity.sha256,
			detachOnly: true,
			quarantineName,
		});
		if (
			!detached.ok &&
			detached.code === "not_found" &&
			detached.retainedSuccessorPath === undefined &&
			detached.retainedUnknownPath === undefined
		)
			return;
		if (
			(!detached.ok && detached.code !== "cleanup_pending") ||
			detached.detachedPath !== path.join(this.#baseDir, quarantineName) ||
			detached.retainedSuccessorPath ||
			detached.retainedUnknownPath
		)
			throw new Error(`managed_replace_receipt_cleanup_pending:${detached.code ?? "unknown"}`);
		fsyncDirectory(this.#baseDir);
	}

	#reconcileLegacyReplacementCleanupReceipt(receiptPath: string, name: string): void {
		const binding = legacyReplacementCleanupReceiptBinding(name);
		if (!binding) throw new Error("managed_replace_cleanup_receipt_invalid");
		let receipt: ManagedFileSnapshot;
		try {
			receipt = captureManagedFilePrefixNoFollow(receiptPath, REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const parsed = parseLegacyReplacementCleanupReceipt(receipt.bytes);
		const expectedPredecessor = path.join(
			this.#baseDir,
			`.gjc-exact-replace-destination-${binding.dev.toString(16)}-${binding.ino.toString(16)}`,
		);
		if (
			!parsed ||
			parsed.identity.dev !== binding.dev ||
			parsed.identity.ino !== binding.ino ||
			path.resolve(parsed.predecessor) !== expectedPredecessor ||
			path.dirname(path.resolve(parsed.successor)) !== this.#baseDir
		)
			throw new Error("managed_replace_cleanup_receipt_invalid");

		const retired = nativeSessionStorage().exactUnlink(expectedPredecessor, {
			dev: parsed.identity.dev,
			ino: parsed.identity.ino,
			nlink: parsed.identity.nlink,
			parentDev: this.#subtreeRoot.dev,
			parentIno: this.#subtreeRoot.ino,
			size: parsed.identity.size,
			mtimeNs: parsed.identity.mtimeNs,
			sha256: parsed.identity.sha256,
			quarantineName: `.gjc-replace-retry-${parsed.identity.dev.toString(16)}-${parsed.identity.ino.toString(16)}`,
		});
		if (!exactUnlinkCompleted(retired) && retired.code !== "not_found")
			throw new Error(`managed_replace_cleanup_pending:${retired.code ?? "unknown"}`);

		let currentReceipt: ManagedFileSnapshot;
		try {
			currentReceipt = captureManagedFilePrefixNoFollow(receiptPath, REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				fsyncDirectory(this.#baseDir);
				return;
			}
			throw error;
		}
		if (
			!sameIdentity(currentReceipt.identity, receipt.identity) ||
			currentReceipt.identity.sha256 !== receipt.identity.sha256
		)
			throw new Error("managed_replace_cleanup_receipt_invalid");
		const removed = nativeSessionStorage().exactUnlink(receiptPath, {
			dev: currentReceipt.identity.dev,
			ino: currentReceipt.identity.ino,
			nlink: currentReceipt.identity.nlink,
			parentDev: this.#subtreeRoot.dev,
			parentIno: this.#subtreeRoot.ino,
			size: BigInt(currentReceipt.identity.size),
			mtimeNs: currentReceipt.identity.mtimeNs,
			sha256: currentReceipt.identity.sha256,
			quarantineName: `.gjc-receipt-remove-${currentReceipt.identity.dev.toString(16)}-${currentReceipt.identity.ino.toString(16)}`,
		});
		if (!exactUnlinkCompleted(removed) && removed.code !== "not_found")
			throw new Error(`managed_replace_receipt_cleanup_pending:${removed.code ?? "unknown"}`);
		fsyncDirectory(this.#baseDir);
	}

	#reconcilePendingReplacementReceipt(receiptPath: string): void {
		const pending = captureManagedFilePrefixNoFollow(receiptPath, REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES);
		const parsed = parseReplacementCleanupReceipt(pending.bytes);
		const predecessor = parsed ? parseReplacementIdentity(parsed.predecessor) : undefined;
		if (
			!parsed ||
			!predecessor ||
			path.dirname(path.resolve(parsed.staging)) !== this.#baseDir ||
			path.dirname(path.resolve(parsed.destination)) !== this.#baseDir
		)
			throw new Error("managed_replace_cleanup_receipt_invalid");
		const destination = replacementReceiptPath(this.#baseDir, predecessor, pending.identity);
		const outcome = classifyNativePublishOutcome(
			nativeSessionStorage().renameNoReplacePath(receiptPath, destination),
		);
		if (outcome.ok) {
			fsyncDirectory(this.#baseDir);
			return;
		}
		if (outcome.reason === "destination_exists" || outcome.reason === "invalid_request") {
			const captureIfPresent = (pathname: string): ManagedFileSnapshot | undefined => {
				try {
					return captureManagedFilePrefixNoFollow(pathname, REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
					throw error;
				}
			};
			const currentPending = captureIfPresent(receiptPath);
			const existing = captureIfPresent(destination);
			if (!currentPending && existing) {
				if (
					!sameReplacementIdentity(existing.identity, pending.identity) ||
					existing.identity.sha256 !== pending.identity.sha256
				)
					throw new Error("managed_replace_cleanup_receipt_invalid");
				fsyncDirectory(this.#baseDir);
				return;
			}
			if (currentPending && !existing) throw publishFailure(outcome);
			// Two names cannot both authoritatively represent the one receipt identity
			// encoded in the canonical filename. A byte-identical copy has a different
			// filesystem identity and would make the canonical receipt fail its next
			// reconciliation, while a hard link violates the single-link capture fence.
			throw new Error("managed_replace_cleanup_receipt_invalid");
		}
		throw publishFailure(outcome);
	}

	#reconcileReplacementCleanupReceipts(): void {
		if (this.#reconcilingReplacementCleanup) return;
		this.#reconcilingReplacementCleanup = true;
		try {
			const directory = fs.opendirSync(this.#baseDir);
			try {
				// The limit bounds receipt reconciliation work, so it counts receipts —
				// not every dirent in the directory. Counting all entries conflated
				// "this scope has too many receipts to reconcile" with "this directory
				// has many files", so a scope whose bulk was inert zero-byte remnants
				// aborted before examining a single receipt (observed: 50,003 dirents,
				// 0 receipts) and every mutation failed permanently. Unbounded receipt
				// growth is still rejected, which is the case the limit exists for.
				let examined = 0;
				for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
					const name = entry.name;
					if (!name.startsWith(".gjc-replace-receipt-pending-") && !name.startsWith(".gjc-replace-cleanup-"))
						continue;
					examined++;
					if (examined > REPLACEMENT_CLEANUP_RECEIPT_SCAN_LIMIT)
						throw new Error("managed_replace_cleanup_receipt_limit_exceeded");
					if (name.startsWith(".gjc-replace-receipt-pending-")) {
						this.#reconcilePendingReplacementReceipt(path.join(this.#baseDir, name));
						continue;
					}
					if (replacementCleanupReceiptBinding(name)) {
						try {
							this.#detachReplacementCleanupReceipt(path.join(this.#baseDir, name));
						} catch (error) {
							if (!isRetryableReplacementReceiptCleanupError(error)) throw error;
						}
						continue;
					}
					if (legacyReplacementCleanupReceiptBinding(name)) {
						this.#reconcileLegacyReplacementCleanupReceipt(path.join(this.#baseDir, name), name);
						continue;
					}
					throw new Error("managed_replace_cleanup_receipt_invalid");
				}
			} finally {
				directory.closeSync();
			}
		} finally {
			this.#reconcilingReplacementCleanup = false;
		}
	}

	#beforeMutation(): void {
		this.#assertBound();
		// Reaping is scheduled BEFORE reconciliation, not after. The receipt scan
		// throws `managed_replace_cleanup_receipt_limit_exceeded` once the bound
		// directory exceeds the dirent scan limit, and the only thing that brings a
		// directory back under that limit is this reaper. Scheduling it after the
		// scan made the recovery unreachable exactly when it was needed: a scope
		// that crossed the limit failed every mutation forever, so tool-output
		// eviction could never persist and its originals stayed resident in heap
		// until the non-disableable emergency compaction floor cut the session
		// (observed: 50,003 dirents, 47,043 of them zero-byte remnants, 55 failed
		// evictions and 9 heap compactions in one day). Reaping is throttled,
		// asynchronous, and never fails the triggering mutation, so hoisting it
		// cannot make a healthy scope worse.
		this.#scheduleRemnantReap();
		this.#reconcileReplacementCleanupReceipts();
		this.#assertBound();
	}

	/**
	 * Best-effort asynchronous reaping of scrubbed write-protocol remnants in
	 * this store's bound directory. Replacements leak zero-byte remnants on
	 * platforms without retained authority (macOS), and scope-resolution reaping
	 * never visits per-session descendant directories, so unbounded remnant
	 * growth there degraded every namespace mutation and let one publication
	 * stall the whole process (issue #4394). Reaping is throttled, serialized
	 * per store, and never fails the triggering mutation.
	 */
	#scheduleRemnantReap(): void {
		const now = Date.now();
		if (this.#remnantReapInFlight || now - this.#lastRemnantReapAttempt < SCRUBBED_REMNANT_REAP_INTERVAL_MS) return;
		this.#lastRemnantReapAttempt = now;
		this.#remnantReapInFlight = true;
		void reapScrubbedProtocolRemnants(this.#baseDir)
			.catch((error: unknown) => {
				logger.warn("Managed session remnant reaping failed", { error: String(error) });
			})
			.finally(() => {
				this.#remnantReapInFlight = false;
			});
	}

	ensureDirectory(relativePath = ""): ManagedDirectoryRoot {
		this.#beforeMutation();
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
		this.#beforeMutation();
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
		this.#beforeMutation();
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
	/**
	 * Atomically publishes an already-written managed staging file without
	 * materializing its contents. The staging file and destination must be
	 * descendants of this retained store.
	 */
	publishStagedFileNoReplace(
		sourceRelativePath: string,
		destinationRelativePath: string,
		expected: { bytes: number; sha256: string },
	): void {
		this.#beforeMutation();
		this.#assertBound();
		const source = this.#resolve(sourceRelativePath);
		const destination = this.#resolve(destinationRelativePath);
		const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		let sourceIdentity: ManagedFileSnapshot["identity"] | undefined;
		try {
			const descriptorStat = fs.fstatSync(fd, { bigint: true });
			const before = identity(descriptorStat);
			const named = identity(fs.lstatSync(source, { bigint: true }));
			if (
				!descriptorStat.isFile() ||
				before.nlink !== 1n ||
				!sameIdentity(before, named) ||
				before.size !== expected.bytes
			)
				throw new Error("managed_publish_identity_mismatch");
			const digest = createHash("sha256");
			const chunk = Buffer.allocUnsafe(1024 * 1024);
			let offset = 0;
			for (;;) {
				const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
				if (bytesRead === 0) break;
				digest.update(chunk.subarray(0, bytesRead));
				offset += bytesRead;
			}
			if (digest.digest("hex") !== expected.sha256) throw new Error("managed_publish_identity_mismatch");
			fs.fsyncSync(fd);
			const after = identity(fs.fstatSync(fd, { bigint: true }));
			const namedAfter = identity(fs.lstatSync(source, { bigint: true }));
			if (!sameIdentity(before, after) || !sameIdentity(after, namedAfter))
				throw new Error("managed_publish_identity_mismatch");
			sourceIdentity = after;
		} finally {
			fs.closeSync(fd);
		}
		if (!sourceIdentity) throw new Error("managed_publish_identity_unavailable");
		const relativeSource = this.#relative(source);
		const relativeDestination = this.#relative(destination);
		const published = this.#authority
			? this.#authority.renameManagedFileNoReplace(
					relativeSource,
					relativeDestination,
					sourceIdentity.dev.toString(),
					sourceIdentity.ino.toString(),
					sourceIdentity.size.toString(),
					sourceIdentity.mtimeNs.toString(),
					sourceIdentity.ctimeNs.toString(),
					expected.sha256,
				)
			: nativeSessionStorage().renameNoReplacePath(source, destination);
		const outcome = classifyNativePublishOutcome(published, this.#authority ? "retained_file" : "direct_rename");
		if (!outcome.ok) throw publishFailure(outcome);
		if (!this.#authority) fsyncDirectory(this.#baseDir);
		this.#assertBound();
	}

	async replace(relativePath: string, bytes: Uint8Array): Promise<void> {
		this.#beforeMutation();
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			try {
				const expected = captureManagedFileNoFollow(resolved);
				replaceManagedFileSync(resolved, bytes, this.#subtreeRoot, this.#policy, undefined, expected.identity);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await publishManagedFileNoReplace(resolved, bytes, undefined, this.#subtreeRoot, this.#policy);
			}
			this.#assertBound();
			return;
		}
		const relative = this.#relative(resolved);
		this.#replaceRetained(relative, bytes);
		this.#assertBound();
	}

	replaceExpectedIdentitySync(relativePath: string, bytes: Uint8Array, expected: ManagedFileIdentity): void {
		this.#beforeMutation();
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			const current = captureManagedFileIdentityStreamingNoFollow(resolved);
			if (!sameManagedIdentity(current, expected)) throw new Error("managed_replace_identity_mismatch");
			replaceManagedFileSync(resolved, bytes, this.#subtreeRoot, this.#policy, undefined, current);
			this.#assertBound();
			return;
		}
		const relative = this.#relative(resolved);
		const observed = this.#authority.stat(relative);
		if (!observed.ok || !observed.identity) {
			const rawCode =
				typeof (observed as { code?: unknown })?.code === "string" ? (observed as { code: string }).code : "";
			// Authority reports "not_found" for missing, non-authority uses ENOENT.
			// Normalize to ENOENT so callers' isEnoent() recovers via create.
			const err = new Error(rawCode || "managed_replace_missing") as NodeJS.ErrnoException;
			err.code = rawCode === "not_found" ? "ENOENT" : rawCode || "managed_replace_missing";
			throw err;
		}
		const current = managedFileIdentityFromNative(observed.identity);
		if (!sameManagedIdentity(current, expected)) throw new Error("managed_replace_identity_mismatch");
		const expectedSha256 =
			typeof observed.identity.sha256 === "string" && /^[0-9a-f]{64}$/i.test(observed.identity.sha256)
				? observed.identity.sha256.toLowerCase()
				: this.readExpected(relativePath)?.identity.sha256;
		if (!expectedSha256) throw new Error("managed_replace_identity_unavailable");
		const replaced = (this.#authority as RecoveryFsRoot & RetainedManagedReplacer).replaceManaged(
			relative,
			bytes,
			observed.identity.dev,
			observed.identity.ino,
			observed.identity.size,
			observed.identity.mtimeNs,
			observed.identity.ctimeNs,
			expectedSha256,
		);
		if (!replaced.ok) throw new Error(replaced.code ?? "managed_replace_failed");
		this.#assertBound();
	}

	replaceExpected(relativePath: string, bytes: Uint8Array, expected: ManagedFileSnapshot): void {
		this.#beforeMutation();
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			const current = captureManagedFileNoFollow(resolved);
			if (!sameIdentity(current.identity, expected.identity) || current.identity.sha256 !== expected.identity.sha256)
				throw new Error("managed_replace_identity_mismatch");
			replaceManagedFileSync(resolved, bytes, this.#subtreeRoot, this.#policy, undefined, expected.identity);
			return;
		}
		const replaced = (this.#authority as RecoveryFsRoot & RetainedManagedReplacer).replaceManaged(
			this.#relative(resolved),
			bytes,
			expected.identity.dev.toString(),
			expected.identity.ino.toString(),
			String(expected.identity.size),
			expected.identity.mtimeNs.toString(),
			expected.identity.ctimeNs.toString(),
			expected.identity.sha256,
		);
		if (!replaced.ok) throw new Error(replaced.code ?? "managed_replace_failed");
		this.#assertBound();
	}
	replaceSync(relativePath: string, bytes: Uint8Array): void {
		this.#beforeMutation();
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			try {
				const expected = captureManagedFileNoFollow(resolved);
				replaceManagedFileSync(resolved, bytes, this.#subtreeRoot, this.#policy, undefined, expected.identity);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				publishManagedFileNoReplaceSync(resolved, bytes, this.#subtreeRoot, this.#policy);
			}
			this.#assertBound();
			return;
		}
		this.#replaceRetained(this.#relative(resolved), bytes);
		this.#assertBound();
	}

	captureBoundedAppendExpectation(relativePath: string): ManagedBoundedAppendExpectation | undefined {
		this.#assertBound();
		let identity: ManagedFileSnapshot["identity"];
		try {
			identity = captureManagedFileIdentityStreamingNoFollow(this.#resolve(relativePath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return {
			dev: identity.dev.toString(),
			ino: identity.ino.toString(),
			nlink: identity.nlink.toString(),
			size: identity.size.toString(),
			mtimeNs: identity.mtimeNs.toString(),
			ctimeNs: identity.ctimeNs.toString(),
			sha256: identity.sha256,
		};
	}

	appendExpectedSync(
		relativePath: string,
		bytes: Uint8Array,
		expected: ManagedBoundedAppendExpectation,
	): ManagedAppendReceipt {
		this.#beforeMutation();
		this.#assertBound();
		if (!this.#authority) {
			const current = captureManagedFileIdentityStreamingNoFollow(this.#resolve(relativePath));
			if (
				current.dev.toString() !== expected.dev ||
				current.ino.toString() !== expected.ino ||
				current.nlink.toString() !== expected.nlink ||
				current.size.toString() !== expected.size ||
				current.mtimeNs.toString() !== expected.mtimeNs ||
				current.ctimeNs.toString() !== expected.ctimeNs ||
				current.sha256 !== expected.sha256
			)
				throw new Error("managed_append_identity_mismatch");
			const appended = appendManagedFileStreamingSync(
				this.#resolve(relativePath),
				bytes,
				this.#subtreeRoot,
				this.#policy,
			);
			this.#assertBound();
			return managedAppendReceiptFromIdentity(appended);
		}
		const relative = this.#relative(this.#resolve(relativePath));
		const appended = this.#authority.appendManaged(
			relative,
			bytes,
			expected.dev,
			expected.ino,
			expected.size,
			expected.mtimeNs,
			expected.ctimeNs,
			expected.sha256,
		);
		if (!appended.ok) throw managedAppendFailure(appended.code);
		if (!appended.identity)
			throw new ManagedCommittedMutationError("append", new Error("managed_append_identity_unavailable"));
		this.#assertBound();
		return managedAppendReceiptFromIdentity(managedFileIdentityFromNative(appended.identity));
	}

	appendExpectedIdentitySync(
		relativePath: string,
		bytes: Uint8Array,
		expected: ManagedFileIdentity,
	): ManagedAppendReceipt {
		const bounded = this.captureBoundedAppendExpectation(relativePath);
		if (!bounded) throw new Error("managed_append_identity_mismatch");
		const descriptorMatches =
			bounded.dev === expected.dev.toString() &&
			bounded.ino === expected.ino.toString() &&
			bounded.nlink === expected.nlink.toString() &&
			bounded.size === String(expected.size) &&
			bounded.mtimeNs === expected.mtimeNs.toString() &&
			bounded.ctimeNs === expected.ctimeNs.toString();
		if (!descriptorMatches) {
			// Metadata-only drift is safe only when the same unlinked file object and
			// byte-exact predecessor are independently proven. Never accept a changed
			// object, length, link count, or digest as a benign touch.
			if (
				!expected.sha256 ||
				bounded.dev !== expected.dev.toString() ||
				bounded.ino !== expected.ino.toString() ||
				bounded.nlink !== expected.nlink.toString() ||
				bounded.size !== String(expected.size) ||
				bounded.sha256 !== expected.sha256
			)
				throw new Error("managed_append_identity_mismatch");
		}
		return this.appendExpectedSync(relativePath, bytes, bounded);
	}

	appendSync(relativePath: string, bytes: Uint8Array): ManagedAppendReceipt {
		this.#beforeMutation();
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (this.#authority) {
			const relative = this.#relative(resolved);
			const observed = this.#authority.stat(relative);
			if (!observed.ok || !observed.identity) {
				const rawCode =
					typeof (observed as { code?: unknown })?.code === "string" ? (observed as { code: string }).code : "";
				const err = new Error(rawCode || "managed_append_missing") as NodeJS.ErrnoException;
				err.code = rawCode === "not_found" ? "ENOENT" : rawCode || "managed_append_missing";
				throw err;
			}
			const nativeSha256 = observed.identity.sha256;
			const expectedSha256 =
				typeof nativeSha256 === "string" && /^[0-9a-f]{64}$/i.test(nativeSha256)
					? nativeSha256.toLowerCase()
					: this.readExpected(relativePath)?.identity.sha256;
			if (!expectedSha256) throw new Error("managed_append_missing");
			const appended = this.#authority.appendManaged(
				relative,
				bytes,
				observed.identity.dev,
				observed.identity.ino,
				observed.identity.size,
				observed.identity.mtimeNs,
				observed.identity.ctimeNs,
				expectedSha256,
			);
			if (!appended.ok) throw managedAppendFailure(appended.code);
			if (!appended.identity)
				throw new ManagedCommittedMutationError("append", new Error("managed_append_identity_unavailable"));
			const receipt = managedAppendReceiptFromIdentity(managedFileIdentityFromNative(appended.identity));
			this.#assertBound();
			return receipt;
		}
		// Darwin has no retained native root authority. Copy the predecessor through a
		// fixed 64 KiB buffer into an exact-replacement staging file, append the new
		// record bytes, and publish through the existing cleanup-receipt protocol.
		// The transcript-linear disk pass is unavoidable; resident memory is bounded.
		const successor = appendManagedFileStreamingSync(resolved, bytes, this.#subtreeRoot, this.#policy);
		const receipt = managedAppendReceiptFromIdentity(successor);
		this.#assertBound();
		return receipt;
	}

	#assertPathBackedReadRelative(relativePath: string): void {
		if (!this.#authority && relativePath.split(/[\\/]/).length > 1)
			throw new Error("managed_nested_path_unsupported");
	}

	/**
	 * Without retained root authority a nested read resolves through intermediate
	 * directories that `O_NOFOLLOW` does not cover, so each component between the
	 * bound base directory and the target is verified as a real same-device
	 * directory before the capture opens the leaf.
	 */
	#assertPathBackedDirectoryChain(resolved: string): void {
		if (this.#authority) return;
		const relative = path.relative(this.#baseDir, resolved);
		const components = relative.split(path.sep);
		let current = this.#baseDir;
		for (const component of components.slice(0, -1)) {
			current = path.join(current, component);
			const stat = fs.lstatSync(current, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.#subtreeRoot.dev)
				throw new Error("Managed descendant path escapes retained store");
		}
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
		let published: unknown;
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
			published = this.#authority.renameManagedFileNoReplace(
				temporary,
				relative,
				captured.identity.dev,
				captured.identity.ino,
				captured.identity.size,
				captured.identity.mtimeNs,
				captured.identity.ctimeNs,
				digest,
			);
			const outcome = classifyNativePublishOutcome(published, "retained_file");
			if (!outcome.ok) throw publishFailure(outcome);
		} catch (error) {
			// A committed or unknown native outcome is evidence, not authorization to
			// probe or remove the destination. Only a validated pre-mutation result
			// may clean this operation's still-named staging object.
			const outcome = captured ? classifyNativePublishOutcome(published, "retained_file") : undefined;
			if (captured?.ok && captured.identity && captured.data && outcome && mayCleanCurrentStaging(outcome)) {
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
					if (!removed.ok && removed.code !== "cleanup_pending")
						throw new Error(removed.code ?? "managed_publish_reconcile_failed");
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

	/** Capture descriptor identity without copying file bytes when retained authority is available. */
	descriptorExpected(relativePath: string): SessionStorageStat | null {
		this.#assertPathBackedReadRelative(relativePath);
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		if (!this.#authority) {
			const rootBefore = fs.lstatSync(this.#baseDir, { bigint: true });
			if (
				!rootBefore.isDirectory() ||
				rootBefore.isSymbolicLink() ||
				rootBefore.dev !== this.#subtreeRoot.dev ||
				rootBefore.ino !== this.#subtreeRoot.ino
			)
				throw new Error("Managed descendant root binding changed");
			let fd: number | undefined;
			try {
				fd = fs.openSync(
					resolved,
					fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
				);
				const opened = fs.fstatSync(fd, { bigint: true });
				const named = fs.lstatSync(resolved, { bigint: true });
				if (
					!opened.isFile() ||
					opened.nlink > 1n ||
					!named.isFile() ||
					named.isSymbolicLink() ||
					named.dev !== opened.dev ||
					named.ino !== opened.ino ||
					named.nlink !== opened.nlink
				)
					throw new Error("source_changed");
				const rootAfter = fs.lstatSync(this.#baseDir, { bigint: true });
				if (
					!rootAfter.isDirectory() ||
					rootAfter.isSymbolicLink() ||
					rootAfter.dev !== rootBefore.dev ||
					rootAfter.ino !== rootBefore.ino
				)
					throw new Error("Managed descendant root binding changed");
				this.#assertBound();
				return managedAppendReceiptFromIdentity({
					dev: opened.dev,
					ino: opened.ino,
					nlink: opened.nlink,
					size: Number(opened.size),
					mtimeNs: opened.mtimeNs,
					ctimeNs: opened.ctimeNs,
				}).descriptor;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
		}
		const stat = this.#authority.stat(this.#relative(resolved));
		if (!stat.ok) {
			if (stat.code === "not_found") return null;
			throw new Error(stat.code ?? "managed_stat_failed");
		}
		if (!stat.identity) throw new Error("managed_stat_identity_unavailable");
		return managedAppendReceiptFromIdentity(managedFileIdentityFromNative(stat.identity)).descriptor;
	}

	/**
	 * Read one bounded range through a no-follow descriptor while binding the
	 * opened file to retained authority (when available) and the managed root
	 * before and after the read. This avoids whole-transcript capture for cold
	 * managed-session indexing without weakening pathname authority.
	 */
	readRangeExpectedSync(
		relativePath: string,
		start: number,
		length: number,
		expectedDescriptor?: Pick<SessionStorageStat, "dev" | "ino" | "nlink" | "size" | "mtimeNs" | "ctimeNs">,
	): SessionStorageRangeSnapshot {
		if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0)
			throw new RangeError("Invalid managed range read");
		if (start > Number.MAX_SAFE_INTEGER - length) throw new RangeError("Managed range read start overflows");
		if (length > 64 * 1024 * 1024) throw new RangeError("Managed range read exceeds the bounded maximum");
		this.#assertPathBackedReadRelative(relativePath);
		this.#assertBound();
		const rootBefore = fs.lstatSync(this.#baseDir, { bigint: true });
		if (
			!rootBefore.isDirectory() ||
			rootBefore.isSymbolicLink() ||
			rootBefore.dev !== this.#subtreeRoot.dev ||
			rootBefore.ino !== this.#subtreeRoot.ino
		)
			throw new Error("Managed descendant root binding changed");
		const resolved = this.#resolve(relativePath);
		const relative = this.#relative(resolved);
		const retained = this.#authority?.stat(relative);
		if (retained && !retained.ok) {
			if (retained.code === "not_found")
				throw Object.assign(new Error("Managed file not found"), { code: "ENOENT" });
			throw new Error(retained.code ?? "managed_stat_failed");
		}
		if (retained && !retained.identity) throw new Error("managed_stat_identity_unavailable");
		const fd = fs.openSync(
			resolved,
			fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
		);
		try {
			const before = fs.fstatSync(fd, { bigint: true });
			if (!before.isFile() || before.nlink > 1n) throw new Error("source_changed");
			if (retained?.identity) {
				const expected = retained.identity;
				if (
					before.dev.toString() !== expected.dev ||
					before.ino.toString() !== expected.ino ||
					before.nlink.toString() !== expected.nlink ||
					before.size.toString() !== expected.size ||
					before.mtimeNs.toString() !== expected.mtimeNs ||
					before.ctimeNs.toString() !== expected.ctimeNs
				)
					throw new Error("source_changed");
			}
			if (
				expectedDescriptor &&
				(before.dev !== expectedDescriptor.dev ||
					before.ino !== expectedDescriptor.ino ||
					before.nlink !== (expectedDescriptor.nlink ?? before.nlink) ||
					Number(before.size) !== expectedDescriptor.size ||
					before.mtimeNs !== expectedDescriptor.mtimeNs ||
					before.ctimeNs !== expectedDescriptor.ctimeNs)
			)
				throw new Error("managed_range_generation_mismatch");
			if (Number(before.size) < start + length) throw new Error("range_not_present");
			const bytes = Buffer.alloc(length);
			let offset = 0;
			while (offset < length) {
				const count = fs.readSync(fd, bytes, offset, length - offset, start + offset);
				if (count === 0) throw new Error("range_not_present");
				offset += count;
			}
			const after = fs.fstatSync(fd, { bigint: true });
			const named = fs.lstatSync(resolved, { bigint: true });
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.nlink !== before.nlink ||
				after.size !== before.size ||
				after.mtimeNs !== before.mtimeNs ||
				after.ctimeNs !== before.ctimeNs ||
				!named.isFile() ||
				named.isSymbolicLink() ||
				named.dev !== before.dev ||
				named.ino !== before.ino ||
				named.nlink !== before.nlink
			)
				throw new Error("source_changed");
			const rootAfter = fs.lstatSync(this.#baseDir, { bigint: true });
			if (
				!rootAfter.isDirectory() ||
				rootAfter.isSymbolicLink() ||
				rootAfter.dev !== rootBefore.dev ||
				rootAfter.ino !== rootBefore.ino
			)
				throw new Error("Managed descendant root binding changed");
			this.#assertBound();
			return {
				bytes,
				stat: {
					dev: after.dev,
					ino: after.ino,
					nlink: after.nlink,
					size: Number(after.size),
					mtimeNs: after.mtimeNs,
					ctimeNs: after.ctimeNs,
					mtimeMs: Number(after.mtimeNs) / 1_000_000,
					mtime: new Date(Number(after.mtimeNs) / 1_000_000),
					isFile: true,
				},
			};
		} finally {
			fs.closeSync(fd);
		}
	}
	/** Read an exact managed file without exposing its pathname as authority. */
	readExpected(relativePath: string): ManagedFileSnapshot | null {
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		const relative = this.#relative(resolved);
		if (!this.#authority) {
			try {
				this.#assertPathBackedDirectoryChain(resolved);
				const captured = captureManagedFileNoFollow(resolved);
				this.#assertBound();
				return captured;
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
				nlink: BigInt(read.identity.nlink),
				size: Number(read.identity.size),
				mtimeNs: BigInt(read.identity.mtimeNs),
				ctimeNs: BigInt(read.identity.ctimeNs),
				sha256: read.identity.sha256 ?? createHash("sha256").update(read.data).digest("hex"),
			},
		};
	}

	/** Remove an exact captured file without reopening its pathname as authority. */
	removeExpected(relativePath: string, expected: ManagedFileSnapshot): void {
		this.#beforeMutation();
		this.#assertBound();
		if (!this.#authority) {
			const parent = fs.statSync(path.dirname(this.#resolve(relativePath)), { bigint: true });
			const removed = nativeSessionStorage().exactUnlink(this.#resolve(relativePath), {
				dev: expected.identity.dev,
				ino: expected.identity.ino,
				size: BigInt(expected.identity.size),
				mtimeNs: expected.identity.mtimeNs,
				sha256: expected.identity.sha256,
				parentDev: parent.dev,
				parentIno: parent.ino,
				quarantineName: `.gjc-remove-${process.pid}-${randomUUID()}`,
			});
			if (
				!removed.ok &&
				!(
					removed.code === "cleanup_pending" &&
					(removed.detachedPath ??
						removed.retainedSuccessorPath ??
						removed.retainedPlaceholderPath ??
						removed.retainedUnknownPath) !== undefined
				)
			)
				throw new Error(removed.code ?? "managed_remove_failed");
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
		if (!removed.ok && !(removed.code === "cleanup_pending" && removed.recoveryPath !== undefined))
			throw new Error(removed.code ?? "managed_remove_failed");
		this.#assertBound();
	}

	/** Remove one exact file without allocating its contents. */
	removeIfExistsDescriptor(relativePath: string): boolean {
		this.#beforeMutation();
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		let named: fs.BigIntStats;
		try {
			named = fs.lstatSync(resolved, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (!named.isFile() || named.isSymbolicLink()) throw new Error("managed_remove_failed");
		let identity: ManagedFileSnapshot["identity"];
		try {
			identity = captureManagedFileIdentityStreamingNoFollow(resolved);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		this.#assertBound();
		this.removeExpected(relativePath, { bytes: Buffer.alloc(0), identity });
		return true;
	}
	/** Read and remove one managed descendant through retained authority. */
	async consume(relativePath: string): Promise<Uint8Array | null> {
		this.#beforeMutation();
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
			if (!removed.ok && !(removed.code === "cleanup_pending" && removed.recoveryPath !== undefined))
				throw new Error(removed.code ?? "managed_consume_failed");
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
		this.#beforeMutation();
		await this.consume(relativePath);
	}

	/** Capture a complete descendant tree through this retained root. */
	captureTree(relativePath: string): NativeDirectoryTreeSnapshot {
		this.#assertBound();
		const resolved = this.#resolve(relativePath);
		try {
			fs.lstatSync(resolved);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("not_found");
			throw error;
		}
		validateManagedArtifactTree(resolved);
		const relative = this.#relative(this.#resolve(relativePath));
		if (this.#authority) {
			const captured = this.#authority.snapshotManagedTree(relative);
			if (!captured.ok || !captured.snapshot)
				throw new Error(
					captured.code === "not_found" ? "artifact_source_changed" : (captured.code ?? "unsafe_artifacts"),
				);
			return captured.snapshot;
		}
		const captured = nativeSessionStorage().snapshotDirectoryTree(this.#resolve(relativePath));
		if (!captured.ok || !captured.snapshot)
			throw new Error(
				captured.code === "not_found" ? "artifact_source_changed" : (captured.code ?? "unsafe_artifacts"),
			);
		return captured.snapshot;
	}

	/** Copy an exact captured tree into an absent managed destination. */
	async importTree(
		sourceRelativePath: string,
		destinationRelativePath: string,
		snapshot: NativeDirectoryTreeSnapshot,
	): Promise<void> {
		this.#beforeMutation();
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
	): NativeDirectoryTreeSnapshot {
		this.#beforeMutation();
		this.#assertBound();
		const moved = this.#authority
			? this.#authority.renameManagedTreeNoReplace(
					this.#relative(this.#resolve(sourceRelativePath)),
					this.#relative(this.#resolve(destinationRelativePath)),
					expected,
				)
			: nativeSessionStorage().renameNoReplacePath(
					this.#resolve(sourceRelativePath),
					this.#resolve(destinationRelativePath),
				);
		const outcome = classifyNativePublishOutcome(moved, this.#authority ? "retained_tree" : "direct_rename");
		if (!outcome.ok)
			throw new ManagedTreeMoveOutcomeError(publishFailure(outcome).message, mayCleanCurrentStaging(outcome));
		const movedSnapshot = this.#authority
			? this.#authority.snapshotManagedTree(this.#relative(this.#resolve(destinationRelativePath)))
			: nativeSessionStorage().snapshotDirectoryTree(this.#resolve(destinationRelativePath));
		if (
			!movedSnapshot.ok ||
			!movedSnapshot.snapshot ||
			!sameDirectoryTreeSnapshotAfterRename(movedSnapshot.snapshot, expected)
		)
			throw new ManagedTreeMoveOutcomeError("artifact_destination_mismatch", false);
		if (!this.#authority) fsyncDirectory(this.#baseDir);

		this.#assertBound();
		return movedSnapshot.snapshot;
	}

	/** Move one exact managed regular file to an absent destination through retained authority. */
	moveFileNoReplace(
		sourceRelativePath: string,
		destinationRelativePath: string,
		expected: ManagedFileSnapshot,
		options?: {
			/** Subtree store bound to the source's directory; keeps the verification read basename-scoped when this store lacks retained authority. */
			sourceStore: ManagedSessionDescendantStore;
			sourceStoreRelativePath: string;
		},
	): ManagedFileSnapshot {
		this.#assertBound();
		const sourceResolved = this.#resolve(sourceRelativePath);
		const destinationResolved = this.#resolve(destinationRelativePath);
		if (
			options &&
			path.resolve(options.sourceStore.#resolve(options.sourceStoreRelativePath)) !== path.resolve(sourceResolved)
		)
			throw new ManagedTreeMoveOutcomeError("artifact_source_changed", false);
		const source = options
			? options.sourceStore.readExpected(options.sourceStoreRelativePath)
			: this.readExpected(sourceRelativePath);
		if (
			!source ||
			!sameReplacementIdentity(source.identity, expected.identity) ||
			source.identity.sha256 !== expected.identity.sha256 ||
			!source.bytes.equals(expected.bytes)
		)
			throw new ManagedTreeMoveOutcomeError("artifact_source_changed", false);

		const moved = this.#authority
			? this.#authority.renameManagedFileNoReplace(
					this.#relative(sourceResolved),
					this.#relative(destinationResolved),
					expected.identity.dev.toString(),
					expected.identity.ino.toString(),
					expected.identity.size.toString(),
					expected.identity.mtimeNs.toString(),
					expected.identity.ctimeNs.toString(),
					expected.identity.sha256,
				)
			: nativeSessionStorage().renameNoReplacePath(sourceResolved, destinationResolved);
		const outcome = classifyNativePublishOutcome(moved, this.#authority ? "retained_file" : "direct_rename");
		if (!outcome.ok)
			throw new ManagedTreeMoveOutcomeError(publishFailure(outcome).message, mayCleanCurrentStaging(outcome));

		const movedSnapshot = this.readExpected(destinationRelativePath);
		if (
			!movedSnapshot ||
			!sameReplacementIdentity(movedSnapshot.identity, expected.identity) ||
			movedSnapshot.identity.sha256 !== expected.identity.sha256 ||
			!movedSnapshot.bytes.equals(expected.bytes)
		)
			throw new ManagedTreeMoveOutcomeError("artifact_destination_mismatch", false);
		if (!this.#authority) {
			try {
				fsyncDirectory(path.dirname(sourceResolved));
				if (path.dirname(sourceResolved) !== path.dirname(destinationResolved))
					fsyncDirectory(path.dirname(destinationResolved));
			} catch {
				throw new ManagedTreeMoveOutcomeError("managed_publish_fsync_failed", false);
			}
		}
		this.#assertBound();
		return movedSnapshot;
	}

	removeTreeExpected(relativePath: string, expected: NativeDirectoryTreeSnapshot): void {
		this.#beforeMutation();
		this.#assertBound();
		if (!this.#authority) {
			const removed = nativeSessionStorage().exactRemoveDirectoryTree(this.#resolve(relativePath), expected);
			if (!removed.ok) throw new Error(removed.code ?? "managed_remove_failed");
			this.#assertBound();
			return;
		}
		const removed = this.#authority.removeManagedTree(this.#relative(this.#resolve(relativePath)), expected);
		if (!removed.ok) throw new Error(removed.code ?? "managed_remove_failed");
		this.#assertBound();
	}
	fsyncTree(): NativeDirectoryTreeSnapshot {
		this.#beforeMutation();
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

function secureFileDescriptor(
	pathname: string,
	fd: number,
	operation: "apply" | "verify",
	allowLinuxIdentityFallback = false,
): void {
	if (process.platform !== "linux") {
		if (operation === "apply") secure(pathname, "file");
		else {
			const verified = validateNativeSecurityResult(
				nativeSessionStorage().verifyOwnerOnlyPathSecurity(pathname, "file"),
				"verify",
				"file",
			);
			if (!verified.ok) throw securityError(pathname, verified);
		}
		return;
	}
	const result = validateNativeSecurityResult(
		operation === "apply"
			? nativeSessionStorage().applyOwnerOnlyFdSecurity(pathname, "file", fd)
			: nativeSessionStorage().verifyOwnerOnlyFdSecurity(pathname, "file", fd),
		operation,
		"file",
	);
	if (result.ok || operation !== "verify" || !allowLinuxIdentityFallback || result.code !== "identity_mismatch") {
		if (!result.ok) throw securityError(pathname, result);
		return;
	}

	// Some Linux filesystems can report a transient descriptor/path identity mismatch
	// after a long-lived descriptor has survived repeated metadata updates. Only the
	// lock-release path opts into this recovery, and only after both the descriptor
	// and pathname identities agree before and after a native pathname verification.
	const identityFailure: NativeSecurity = { ok: false, code: "identity_mismatch" };
	const before = fs.fstatSync(fd, { bigint: true });
	const named = fs.lstatSync(pathname, { bigint: true });
	if (!named.isFile() || named.isSymbolicLink() || !sameFileIdentity(before, named))
		throw securityError(pathname, identityFailure);
	const verified = validateNativeSecurityResult(
		nativeSessionStorage().verifyOwnerOnlyPathSecurity(pathname, "file"),
		"verify",
		"file",
	);
	if (!verified.ok) throw securityError(pathname, verified);
	const after = fs.fstatSync(fd, { bigint: true });
	const current = fs.lstatSync(pathname, { bigint: true });
	if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(after, current))
		throw securityError(pathname, identityFailure);
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

/** Async twin of {@link fsyncDirectory} for the off-loop publication path. */
async function fsyncDirectoryAsync(pathname: string): Promise<void> {
	if (!shouldFsyncManagedDirectory()) return;
	const handle = await fsp.open(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
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
		nlink: stat.nlink,
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
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}
function sameReplacementIdentity(
	left: ManagedFileSnapshot["identity"],
	right: ManagedFileSnapshot["identity"],
): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

function parseLockBytes(bytes: Uint8Array): LockRecord | undefined {
	try {
		const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
		if (!value || typeof value !== "object") return undefined;
		const record = value as Partial<LockRecord>;
		return typeof record.attemptId === "string" &&
			typeof record.pid === "number" &&
			typeof record.processStartId === "string" &&
			typeof record.leaseExpiresAt === "number" &&
			typeof record.heartbeatAt === "number" &&
			typeof record.createdAt === "number" &&
			(record.released === undefined || typeof record.released === "boolean")
			? (record as LockRecord)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseLock(pathname: string): LockRecord | undefined {
	try {
		const stat = fs.lstatSync(pathname);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		return parseLockBytes(fs.readFileSync(pathname));
	} catch {
		return undefined;
	}
}

function captureLock(pathname: string): { record: LockRecord; snapshot: ManagedFileSnapshot } | undefined {
	try {
		const snapshot = captureManagedFileNoFollow(pathname);
		const record = parseLockBytes(snapshot.bytes);
		return record ? { record, snapshot } : undefined;
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
	let offset = 0;
	while (offset < encoded.byteLength) {
		const written = fs.writeSync(fd, encoded, offset, encoded.byteLength - offset, offset);
		if (written <= 0) throw new Error("durability_failed");
		offset += written;
	}
	fs.ftruncateSync(fd, encoded.byteLength);
	fs.fsyncSync(fd);
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function openVerifiedLockReleaseDescriptor(pathname: string, expected: fs.BigIntStats): number {
	const identityFailure: NativeSecurity = { ok: false, code: "identity_mismatch" };
	const namedBefore = fs.lstatSync(pathname, { bigint: true });
	if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || !sameFileIdentity(expected, namedBefore))
		throw securityError(pathname, identityFailure);

	const replacementFd = fs.openSync(pathname, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
	try {
		const openedBefore = fs.fstatSync(replacementFd, { bigint: true });
		if (!sameFileIdentity(expected, openedBefore) || !sameFileIdentity(namedBefore, openedBefore))
			throw securityError(pathname, identityFailure);
		secureFileDescriptor(pathname, replacementFd, "verify");
		const openedAfter = fs.fstatSync(replacementFd, { bigint: true });
		const namedAfter = fs.lstatSync(pathname, { bigint: true });
		if (
			!namedAfter.isFile() ||
			namedAfter.isSymbolicLink() ||
			!sameFileIdentity(expected, openedAfter) ||
			!sameFileIdentity(openedAfter, namedAfter)
		)
			throw securityError(pathname, identityFailure);
		return replacementFd;
	} catch (error) {
		fs.closeSync(replacementFd);
		throw error;
	}
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
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
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

function captureManagedFileIdentityStreamingNoFollow(pathname: string): ManagedFileSnapshot["identity"] {
	const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.nlink > 1) throw new Error("source_changed");
		const hash = createHash("sha256");
		const chunk = Buffer.alloc(64 * 1024);
		for (;;) {
			const count = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
			if (count === 0) break;
			hash.update(chunk.subarray(0, count));
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameIdentity(identity(before), identity(after))) throw new Error("source_changed");
		const named = fs.lstatSync(pathname, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(identity(before), identity(named)))
			throw new Error("source_changed");
		return identity(before, hash.digest("hex"));
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
	if (bytes.byteLength > MANAGED_ARTIFACT_MAX_FILE_BYTES) throw new Error("content_too_large");
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent, root, policy);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
	let handle: fsp.FileHandle | undefined;
	let stagingIdentity: { dev: bigint; ino: bigint } | undefined;
	let failure: unknown;
	let outcome: NativePublishOutcome | undefined;
	let renameAttempted = false;
	let linkPublished = false;

	try {
		assertOwned?.();
		// The whole staging + publication chain is awaited off the resident event
		// loop: FileHandle operations run on the libuv pool and the no-replace
		// namespace publication crosses the async native boundary. A rename that
		// stalls in the kernel — e.g. into an oversized APFS directory namespace,
		// issue #4394 — blocks one pool thread instead of freezing the process:
		// await timeouts, sibling subagents, and watchdogs keep running, and a
		// hung publication degrades to one unresolved receipt.
		handle = await fsp.open(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		secureFileDescriptor(staging, handle.fd, "apply");
		let offset = 0;
		while (offset < bytes.byteLength) {
			const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
			if (bytesWritten <= 0) throw new Error("managed_publish_failed");
			offset += bytesWritten;
		}
		await handle.sync();
		secureFileDescriptor(staging, handle.fd, "verify");
		const staged = await handle.stat({ bigint: true });
		stagingIdentity = { dev: staged.dev, ino: staged.ino };
		assertOwned?.();

		renameAttempted = true;
		outcome = classifyNativePublishOutcome(
			await nativeSessionStorage().renameNoReplacePathAsync(staging, destination),
		);
		if (renameFlagsUnsupported(outcome)) {
			// See publishManagedFileNoReplaceSync: the staging link outlives this
			// publication and is removed only after the secured descriptor is closed.
			outcome = classifyNativePublishOutcome(
				await nativeSessionStorage().linkNoReplacePathAsync(staging, destination),
			);
			linkPublished = outcome.ok;
		}

		if (!outcome.ok) throw publishFailure(outcome);

		const named = await fsp.lstat(destination, { bigint: true });
		if (
			!named.isFile() ||
			named.isSymbolicLink() ||
			named.dev !== stagingIdentity.dev ||
			named.ino !== stagingIdentity.ino
		) {
			throw new Error("destination_identity_changed");
		}
		secureFileDescriptor(destination, handle.fd, "verify");
		await handle.close();
		handle = undefined;

		await fsyncDirectoryAsync(parent);
	} catch (error) {
		failure = error;
	} finally {
		if (handle !== undefined) {
			try {
				await handle.close();
			} catch (error) {
				failure ??= error;
			}
		}

		if (stagingIdentity && (linkPublished || !renameAttempted || (outcome && mayCleanCurrentStaging(outcome)))) {
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
): ManagedFileSnapshot["identity"] {
	if (bytes.byteLength > MANAGED_ARTIFACT_MAX_FILE_BYTES) throw new Error("content_too_large");
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent, root, policy);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
	let fd: number | undefined;
	let stagingIdentity: { dev: bigint; ino: bigint } | undefined;
	let publishedIdentity: ManagedFileSnapshot["identity"] | undefined;
	let failure: unknown;
	let outcome: NativePublishOutcome | undefined;
	let linkPublished = false;

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
		publishedIdentity = identity(staged, createHash("sha256").update(bytes).digest("hex"));

		outcome = classifyNativePublishOutcome(nativeSessionStorage().renameNoReplacePath(staging, destination));
		if (renameFlagsUnsupported(outcome)) {
			// See publishManagedFileNoReplace: the staging link outlives this publication
			// and is removed only after the secured descriptor is closed.
			outcome = classifyNativePublishOutcome(nativeSessionStorage().linkNoReplacePath(staging, destination));
			linkPublished = outcome.ok;
		}
		if (!outcome.ok) throw publishFailure(outcome);

		const named = fs.lstatSync(destination, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || named.dev !== staged.dev || named.ino !== staged.ino) {
			throw new Error("destination_identity_changed");
		}
		secureFileDescriptor(destination, fd, "verify");
		fs.closeSync(fd);
		fd = undefined;
		fsyncDirectory(parent);
	} catch (error) {
		failure = error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	if (stagingIdentity && (linkPublished || (outcome && mayCleanCurrentStaging(outcome)))) {
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
	if (!publishedIdentity) throw new Error("managed_publish_identity_unavailable");
	return publishedIdentity;
}

/** Replace one managed regular file while retaining the secured staging fd through publication. */
function replaceManagedFileGeneratedSync(
	destination: string,
	writeContent: (fd: number) => { size: number; sha256: string },
	root: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
	assertFence?: () => void,
	expectedDestination?: ManagedFileSnapshot["identity"],
	acceptCommittedCleanupFailure = false,
	operation: "replace" | "append" = "replace",
): ManagedFileSnapshot["identity"] {
	const parent = path.dirname(destination);
	ensureManagedDirectory(parent, root, policy);
	const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.replacement`);
	let fd: number | undefined;
	let stagedIdentity: { dev: bigint; ino: bigint } | undefined;
	let preserveStaging = false;
	let receiptCleanup:
		| {
				path: string;
				parentDev: bigint;
				parentIno: bigint;
				identity: ManagedFileSnapshot["identity"];
				predecessor: ManagedFileSnapshot["identity"];
		  }
		| undefined;
	let failure: unknown;
	let publishedIdentity: ManagedFileSnapshot["identity"] | undefined;
	let publicationDurable = false;
	let publicationCommitted = false;
	let expectedSuccessor: ManagedFileSnapshot["identity"] | undefined;
	try {
		fd = fs.openSync(
			staging,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
			0o600,
		);
		secureFileDescriptor(staging, fd, "apply");
		const initiallyStaged = fs.fstatSync(fd, { bigint: true });
		stagedIdentity = { dev: initiallyStaged.dev, ino: initiallyStaged.ino };
		const generated = writeContent(fd);
		fs.fsyncSync(fd);
		secureFileDescriptor(staging, fd, "verify");
		const staged = fs.fstatSync(fd, { bigint: true });
		stagedIdentity = { dev: staged.dev, ino: staged.ino };
		expectedSuccessor = identity(staged, generated.sha256);
		if (process.platform === "win32" && expectedDestination) {
			fs.closeSync(fd);
			fd = undefined;
		}
		assertManagedDirectoryRoot(root);
		assertFence?.();
		if (expectedDestination) {
			const parentIdentity = fs.lstatSync(parent, { bigint: true });
			if (Number(staged.size) !== generated.size) throw new Error("managed_replace_generated_size_changed");
			const successor = expectedSuccessor;
			const receiptStagingPath = path.join(parent, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
			preserveStaging = true;
			const publishedReceiptIdentity = publishManagedFileNoReplaceSync(
				receiptStagingPath,
				Buffer.from(
					JSON.stringify({
						version: 3,
						staging,
						destination,
						successor: serializeReplacementIdentity(successor),
						predecessor: serializeReplacementIdentity(expectedDestination),
					} satisfies ReplacementCleanupReceipt),
				),
				root,
				policy,
			);
			const receiptPath = replacementReceiptPath(parent, expectedDestination, publishedReceiptIdentity);
			const receiptPublish = classifyNativePublishOutcome(
				nativeSessionStorage().renameNoReplacePath(receiptStagingPath, receiptPath),
			);
			if (!receiptPublish.ok) throw publishFailure(receiptPublish);
			const namedReceipt = captureManagedFilePrefixNoFollow(receiptPath, REPLACEMENT_CLEANUP_RECEIPT_MAX_BYTES);
			if (
				namedReceipt.identity.dev !== publishedReceiptIdentity.dev ||
				namedReceipt.identity.ino !== publishedReceiptIdentity.ino
			)
				throw new Error("managed_replace_cleanup_receipt_identity_changed");
			fsyncDirectory(parent);
			receiptCleanup = {
				path: receiptPath,
				parentDev: parentIdentity.dev,
				parentIno: parentIdentity.ino,
				identity: publishedReceiptIdentity,
				predecessor: expectedDestination,
			};
			// Transient Windows sharing violations (a concurrent holder denying delete
			// sharing on the destination, issue #4330) are retried at the narrow
			// pre-mutation syscall boundary inside the native `exactReplacePath`: the
			// destination open is retried a bounded number of times while nothing has
			// been renamed or unlinked, and only `sharing_violation`/`io_error` with no
			// detached/retained paths can ever reach this throw from that open. This
			// TypeScript layer deliberately never retries: once `exactReplacePath`
			// returns, any failure that carries a detached/retained path is
			// post-mutation evidence and must surface unchanged for receipt recovery.
			const replaced = nativeSessionStorage().exactReplacePath(
				staging,
				destination,
				{
					dev: successor.dev,
					ino: successor.ino,
					nlink: successor.nlink,
					parentDev: parentIdentity.dev,
					parentIno: parentIdentity.ino,
					size: BigInt(successor.size),
					mtimeNs: successor.mtimeNs,
					sha256: successor.sha256,
				},
				{
					dev: expectedDestination.dev,
					ino: expectedDestination.ino,
					nlink: expectedDestination.nlink,
					parentDev: parentIdentity.dev,
					parentIno: parentIdentity.ino,
					size: BigInt(expectedDestination.size),
					mtimeNs: expectedDestination.mtimeNs,
					sha256: expectedDestination.sha256,
				},
			);
			if (!replaced.ok) {
				publicationCommitted =
					replaced.code === "cleanup_pending" ||
					replaced.code === "durability_failed" ||
					Boolean(
						replaced.detachedPath ??
							replaced.retainedSuccessorPath ??
							replaced.retainedPlaceholderPath ??
							replaced.retainedUnknownPath,
					);
				throw new ManagedReplaceError(replaced, receiptCleanup.path);
			}
			publicationCommitted = true;
			fsyncDirectory(parent);
		} else {
			fs.renameSync(staging, destination);
			publicationCommitted = true;
		}
		assertManagedDirectoryRoot(root);
		const named = fs.lstatSync(destination, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || named.dev !== staged.dev || named.ino !== staged.ino) {
			throw new Error("destination_identity_changed");
		}
		if (!expectedSuccessor) throw new Error("managed_replace_identity_unavailable");
		if (fd !== undefined) {
			secureFileDescriptor(destination, fd, "verify");
			fs.closeSync(fd);
			fd = undefined;
		}
		fsyncDirectory(parent);
		const verifiedIdentity = captureManagedFileIdentityStreamingNoFollow(destination);
		if (!sameReplacementIdentity(verifiedIdentity, expectedSuccessor))
			throw new Error("destination_identity_changed");
		publishedIdentity = verifiedIdentity;
		publicationDurable = true;
		if (receiptCleanup) {
			try {
				const removed = nativeSessionStorage().exactUnlink(receiptCleanup.path, {
					dev: receiptCleanup.identity.dev,
					ino: receiptCleanup.identity.ino,
					nlink: receiptCleanup.identity.nlink,
					parentDev: receiptCleanup.parentDev,
					parentIno: receiptCleanup.parentIno,
					size: BigInt(receiptCleanup.identity.size),
					mtimeNs: receiptCleanup.identity.mtimeNs,
					sha256: receiptCleanup.identity.sha256,
					quarantineName: replacementReceiptRetirementName(receiptCleanup.identity, receiptCleanup.predecessor),
				});
				if (!exactUnlinkCompleted(removed) && removed.code !== "not_found")
					throw new ManagedReplaceError(removed, receiptCleanup.path);
				try {
					fsyncDirectory(parent);
				} catch (error) {
					throw new ManagedReplaceError(
						{ ...removed, ok: false, code: "durability_failed" },
						receiptCleanup.path,
						error,
					);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	} catch (error) {
		failure =
			publicationCommitted && !publishedIdentity ? new ManagedCommittedMutationError(operation, error) : error;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch (error) {
				if (publicationCommitted && !publishedIdentity) {
					const cause =
						failure === undefined
							? error
							: new AggregateError([failure, error], "Managed replacement and descriptor close both failed.");
					failure = new ManagedCommittedMutationError(operation, cause);
				} else {
					failure =
						failure === undefined
							? error
							: new AggregateError([failure, error], "Managed replacement and descriptor close both failed.");
				}
			}
		}
		if (stagedIdentity && !preserveStaging) {
			try {
				const named = fs.lstatSync(staging, { bigint: true });
				if (named.dev === stagedIdentity.dev && named.ino === stagedIdentity.ino) fs.unlinkSync(staging);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					failure =
						failure === undefined
							? error
							: new AggregateError([failure, error], "Managed replacement and staging cleanup both failed.");
				}
			}
		}
	}
	if (failure !== undefined && !(acceptCommittedCleanupFailure && publicationDurable && publishedIdentity))
		throw failure;
	if (!publishedIdentity) throw new Error("managed_replace_identity_unavailable");
	return publishedIdentity;
}

export function replaceManagedFileSync(
	destination: string,
	bytes: Uint8Array,
	root: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy = "default",
	assertFence?: () => void,
	expectedDestination?: ManagedFileSnapshot["identity"],
): void {
	if (bytes.byteLength > MANAGED_ARTIFACT_MAX_FILE_BYTES) throw new Error("content_too_large");
	replaceManagedFileGeneratedSync(
		destination,
		fd => {
			const hash = createHash("sha256");
			let offset = 0;
			while (offset < bytes.byteLength) {
				const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
				if (written === 0) throw new Error("managed_replace_short_write");
				hash.update(bytes.subarray(offset, offset + written));
				offset += written;
			}
			return { size: offset, sha256: hash.digest("hex") };
		},
		root,
		policy,
		assertFence,
		expectedDestination,
	);
}

function appendManagedFileStreamingSync(
	destination: string,
	appendedBytes: Uint8Array,
	root: ManagedDirectoryRoot,
	policy: ManagedSessionSecurityPolicy,
): ManagedFileSnapshot["identity"] {
	const predecessor = captureManagedFileIdentityStreamingNoFollow(destination);
	if (predecessor.size > MANAGED_ARTIFACT_MAX_FILE_BYTES - appendedBytes.byteLength)
		throw new Error("content_too_large");
	return replaceManagedFileGeneratedSync(
		destination,
		stagingFd => {
			const sourceFd = fs.openSync(
				destination,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
			);
			try {
				const before = fs.fstatSync(sourceFd, { bigint: true });
				if (!sameReplacementIdentity(identity(before, predecessor.sha256), predecessor))
					throw new Error("managed_replace_identity_mismatch");
				const hash = createHash("sha256");
				const chunk = Buffer.alloc(64 * 1024);
				let total = 0;
				for (;;) {
					const count = fs.readSync(sourceFd, chunk, 0, chunk.byteLength, null);
					if (count === 0) break;
					let written = 0;
					while (written < count) {
						const amount = fs.writeSync(stagingFd, chunk, written, count - written);
						if (amount === 0) throw new Error("managed_replace_short_write");
						written += amount;
					}
					hash.update(chunk.subarray(0, count));
					total += count;
				}
				const after = fs.fstatSync(sourceFd, { bigint: true });
				const named = fs.lstatSync(destination, { bigint: true });
				if (
					!sameReplacementIdentity(identity(after, predecessor.sha256), predecessor) ||
					!sameReplacementIdentity(identity(named, predecessor.sha256), predecessor)
				)
					throw new Error("managed_replace_identity_mismatch");
				if (hash.copy().digest("hex") !== predecessor.sha256) throw new Error("managed_replace_identity_mismatch");
				if (total > MANAGED_ARTIFACT_MAX_FILE_BYTES - appendedBytes.byteLength)
					throw new Error("content_too_large");
				let appended = 0;
				while (appended < appendedBytes.byteLength) {
					const amount = fs.writeSync(stagingFd, appendedBytes, appended, appendedBytes.byteLength - appended);
					if (amount === 0) throw new Error("managed_replace_short_write");
					hash.update(appendedBytes.subarray(appended, appended + amount));
					appended += amount;
				}
				return { size: total + appended, sha256: hash.digest("hex") };
			} finally {
				fs.closeSync(sourceFd);
			}
		},
		root,
		policy,
		undefined,
		predecessor,
		true,
		"append",
	);
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
				writeLockDescriptor(fd, record);
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
					const current = fs.fstatSync(fd, { bigint: true });
					if (sameFileIdentity(lockIdentity, current)) fs.closeSync(fd);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
				} finally {
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
					current.released === true ||
					!sameFileIdentity(lockIdentity, named) ||
					current.attemptId !== attemptId
				)
					throw new Error("migration_busy");
				const now = Date.now();
				if (current.leaseExpiresAt < now + LOCK_HEARTBEAT_MS) {
					writeLockDescriptor(fd, {
						...record,
						heartbeatAt: now,
						leaseExpiresAt: now + LOCK_LEASE_MS,
					});
				}
			};
			const heartbeat = setInterval(() => {
				try {
					assertOwned();
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
					let releaseFd = fd;
					let replacementFd: number | undefined;
					try {
						assertOwned();
						ManagedLockTestHooks.beforeReleaseDescriptorVerification?.({ path: lockPath, fd });
						try {
							secureFileDescriptor(lockPath, fd, "verify", true);
						} catch (error) {
							const descriptorUnavailable = (error as NodeJS.ErrnoException).code === "EBADF";
							if (
								process.platform !== "linux" ||
								(!descriptorUnavailable && managedSecurityFailureClassification(error) !== "identity_mismatch")
							)
								throw error;
							replacementFd = openVerifiedLockReleaseDescriptor(lockPath, lockIdentity);
							releaseFd = replacementFd;
						}
						const now = Date.now();
						// A released record is the only live-process reclaim authority. Expiry alone
						// never authorizes stealing from a holder whose process is still present.
						writeLockDescriptor(releaseFd, {
							...record,
							released: true,
							heartbeatAt: now,
							leaseExpiresAt: now,
						});
						if (replacementFd !== undefined) {
							const opened = fs.fstatSync(replacementFd, { bigint: true });
							const named = fs.lstatSync(lockPath, { bigint: true });
							if (!sameFileIdentity(lockIdentity, opened) || !sameFileIdentity(opened, named))
								throw securityError(lockPath, { ok: false, code: "identity_mismatch" });
						}
						fsyncDirectory(locksDirectory);
					} finally {
						if (replacementFd !== undefined) fs.closeSync(replacementFd);
						released = true;
						closeDescriptor();
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const observed = captureLock(lockPath);
			const owner = observed?.record;
			const reclaimable =
				owner?.released === true ||
				(owner !== undefined && owner.leaseExpiresAt < Date.now() && ownerDefinitelyGone(owner));
			if (observed && owner && reclaimable) {
				try {
					ManagedLockTestHooks.beforeObservedRetirement?.({ path: lockPath, attemptId: owner.attemptId });
					const removed = nativeSessionStorage().exactUnlink(lockPath, {
						dev: observed.snapshot.identity.dev,
						ino: observed.snapshot.identity.ino,
						size: BigInt(observed.snapshot.identity.size),
						mtimeNs: observed.snapshot.identity.mtimeNs,
						sha256: observed.snapshot.identity.sha256,
						quarantineName: `.gjc-lock-${randomUUID()}.stale`,
					});
					if (removed.ok || removed.code === "cleanup_pending") fsyncDirectory(locksDirectory);
				} catch {
					/* retry owner observation */
				}
			}
			if (Date.now() >= deadline) throw new Error("migration_busy");
			await new Promise<void>(resolve => setTimeout(resolve, 50));
		}
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

/** Flush a copied managed artifact tree, including empty directories, before publishing its receipt. */
export function fsyncManagedArtifactTree(root: string): NativeDirectoryTreeSnapshot {
	const before = nativeSessionStorage().snapshotDirectoryTree(root);
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
	const after = nativeSessionStorage().snapshotDirectoryTree(root);
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
