/**
 * Shared target-adjacent v1 activation record authority for `gjc update` and
 * `gjc doctor install.restore-binary`.
 *
 * Every identity capture is a bounded, no-follow, post-read-revalidated
 * snapshot, never a bare fs.readFile/fs.stat pair. Every record write is a
 * no-replace create or an exact CAS against the caller's own previously
 * observed record identity, never a blind fs.rename overwrite. Promoting a
 * staged candidate onto the live target uses the native exactReplaceRetained
 * primitive: it validates both identities before mutating anything and
 * retires the old target to a retained backup name instead of deleting it.
 * There is no unlink/rename-based rollback path in this module.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	exactReplacePath,
	exactReplaceRetained,
	exactRestore,
	type NativeExactFileIdentity,
} from "@gajae-code/natives";

export type ActivationPhase = "staged" | "published" | "verified" | "pending_activation" | "rolled_back" | "uncertain";

/** Serialized exact regular-file identity. BigInt fields are decimal strings so the record stays plain JSON. */
export interface FileIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly nlink: string;
	readonly parentDev?: string;
	readonly parentIno?: string;
	readonly size: string;
	readonly mtimeNs: string;
	readonly mode: number;
	readonly sha256: string;
}

/** Serialized directory identity. No content hash: a directory has no bytes to bind. */
export interface DirectoryIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly mode: number;
}

export interface ActivationRecordV1 {
	readonly schemaVersion: 1;
	readonly kind: "gjc-install-activation";
	readonly transactionId: string;
	readonly targetPath: string;
	readonly parentPath: string;
	readonly targetIdentity?: FileIdentity;
	readonly backupIdentity?: FileIdentity;
	readonly parentIdentity?: DirectoryIdentity;
	readonly baseline: { readonly exists: boolean; readonly digest?: string; readonly version?: string };
	readonly candidate: {
		readonly digest: string;
		readonly version: string;
		readonly channel?: string;
		readonly ref?: string;
		readonly os?: string;
		readonly arch?: string;
		readonly sidecars: readonly string[];
	};
	readonly stagingPath: string;
	/** Staged candidate identity captured when recorded; re-checked before promotion. */
	readonly stagingIdentity?: FileIdentity;
	/** Single-component name exactReplaceRetained retires the old target to, inside the target's own parent. */
	readonly backupName: string;
	readonly phase: ActivationPhase;
}

export type ActivationRead =
	| { readonly status: "missing" }
	| { readonly status: "valid"; readonly record: ActivationRecordV1; readonly identity: FileIdentity }
	| { readonly status: "malformed"; readonly reason: string }
	| { readonly status: "foreign"; readonly reason: string };

/** Public snapshot API shared by callers (update-cli/doctor) to capture original target/staging identities. */
export async function snapshotRegularFile(
	filePath: string,
): Promise<{ readonly header: Uint8Array; readonly identity: FileIdentity } | undefined> {
	const snapshot = await readExactRegularFile(filePath, 512 * 1024 * 1024, 8);
	return snapshot ? { header: snapshot.bytes, identity: snapshot.identity } : undefined;
}

export async function snapshotDirectory(directoryPath: string): Promise<DirectoryIdentity | undefined> {
	return readDirectoryIdentity(directoryPath);
}

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.mode === b.mode &&
		a.sha256 === b.sha256 &&
		a.parentDev === b.parentDev &&
		a.parentIno === b.parentIno
	);
}

export function sameDirectoryIdentity(a: DirectoryIdentity | undefined, b: DirectoryIdentity | undefined): boolean {
	return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

export function toNativeIdentity(identity: FileIdentity, quarantineName?: string): NativeExactFileIdentity {
	return {
		dev: BigInt(identity.dev),
		ino: BigInt(identity.ino),
		nlink: BigInt(identity.nlink),
		...(identity.parentDev !== undefined && identity.parentIno !== undefined
			? { parentDev: BigInt(identity.parentDev), parentIno: BigInt(identity.parentIno) }
			: {}),
		size: BigInt(identity.size),
		mtimeNs: BigInt(identity.mtimeNs),
		sha256: identity.sha256,
		...(quarantineName ? { quarantineName } : {}),
	};
}

export function activationRecordPath(targetPath: string): string {
	return `${path.resolve(targetPath)}.activation.v1.json`;
}

/** Deterministic-enough, collision-checked single-component retained backup name for one transaction. */
export function activationBackupName(targetPath: string, transactionId: string): string {
	return `${path.basename(path.resolve(targetPath))}.activation-backup.${transactionId}`;
}

export function createActivationTransactionId(): string {
	return randomUUID();
}

/** Pure builder for a fresh `staged` activation record; callers still write it via createActivationRecordFile. */
export function buildActivationRecord(input: {
	readonly targetPath: string;
	readonly targetIdentity?: FileIdentity;
	readonly originalTargetAbsent?: boolean;
	readonly parentIdentity: DirectoryIdentity;
	readonly baselineDigest?: string;
	readonly baselineVersion?: string;
	readonly stagingPath: string;
	readonly stagingIdentity: FileIdentity;
	readonly candidate: {
		readonly digest: string;
		readonly version: string;
		readonly channel?: string;
		readonly ref?: string;
		readonly os?: string;
		readonly arch?: string;
		readonly sidecars?: readonly string[];
	};
	readonly transactionId?: string;
}): ActivationRecordV1 {
	if (input.originalTargetAbsent ? input.targetIdentity !== undefined : input.targetIdentity === undefined)
		throw new Error("original_target_observation_missing");
	const transactionId = input.transactionId ?? createActivationTransactionId();
	return {
		schemaVersion: 1,
		kind: "gjc-install-activation",
		transactionId,
		targetPath: path.resolve(input.targetPath),
		parentPath: path.dirname(path.resolve(input.targetPath)),
		targetIdentity: input.targetIdentity,
		parentIdentity: input.parentIdentity,
		baseline: { exists: !input.originalTargetAbsent, digest: input.baselineDigest, version: input.baselineVersion },
		candidate: { ...input.candidate, sidecars: input.candidate.sidecars ?? [] },
		stagingPath: input.stagingPath,
		stagingIdentity: input.stagingIdentity,
		backupName: activationBackupName(input.targetPath, transactionId),
		phase: "staged",
	};
}

const READ_LIMIT = 256 * 1024;

/**
 * Bounded, no-follow, identity-revalidated read of one regular file. Rejects
 * symlinks, non-regular files, a symlinked/changed parent, and any content
 * or identity drift observed between the open and the final lexical check.
 * Returns `undefined` only for a confirmed-absent path (ENOENT); every other
 * failure — including a torn/changed read — throws, since presence is a
 * distinct fact from disallowed observation.
 */
async function readExactRegularFile(
	filePath: string,
	byteLimit = READ_LIMIT,
	prefixLimit = byteLimit,
): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity } | undefined> {
	const resolved = path.resolve(filePath);
	const parentPath = path.dirname(resolved);
	let handle: fs.FileHandle | undefined;
	try {
		const before = await fs.lstat(resolved, { bigint: true });
		if (before.isSymbolicLink() || !before.isFile()) throw new Error("target_not_regular");
		if (before.size > BigInt(byteLimit)) throw new Error("target_size_limit");
		const parentBefore = await fs.lstat(parentPath, { bigint: true });
		if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) throw new Error("parent_not_directory");
		handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("target_changed");
		const bytes = new Uint8Array(prefixLimit);
		const chunk = new Uint8Array(64 * 1024);
		const digest = createHash("sha256");
		let length = 0;
		while (length <= byteLimit) {
			const result = await handle.read(chunk, 0, Math.min(chunk.length, byteLimit + 1 - length), length);
			if (result.bytesRead === 0) break;
			const content = chunk.subarray(0, result.bytesRead);
			digest.update(content);
			if (length < prefixLimit)
				bytes.set(content.subarray(0, Math.min(content.length, prefixLimit - length)), length);
			length += result.bytesRead;
		}
		if (length > byteLimit) throw new Error("target_size_limit");
		const content = bytes.subarray(0, Math.min(length, prefixLimit));
		const after = await handle.stat({ bigint: true });
		const lexical = await fs.lstat(resolved, { bigint: true });
		const parentAfter = await fs.lstat(parentPath, { bigint: true });
		if (
			lexical.isSymbolicLink() ||
			parentAfter.isSymbolicLink() ||
			!parentAfter.isDirectory() ||
			parentAfter.dev !== parentBefore.dev ||
			parentAfter.ino !== parentBefore.ino ||
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.mtimeNs !== opened.mtimeNs ||
			after.ctimeNs !== opened.ctimeNs ||
			after.size !== opened.size ||
			after.nlink !== opened.nlink ||
			lexical.dev !== after.dev ||
			lexical.ino !== after.ino ||
			lexical.mtimeNs !== after.mtimeNs ||
			lexical.ctimeNs !== after.ctimeNs
		)
			throw new Error("target_changed");
		const identity: FileIdentity = {
			dev: after.dev.toString(),
			ino: after.ino.toString(),
			nlink: after.nlink.toString(),
			parentDev: parentAfter.dev.toString(),
			parentIno: parentAfter.ino.toString(),
			size: after.size.toString(),
			mtimeNs: after.mtimeNs.toString(),
			mode: Number(after.mode),
			sha256: digest.digest("hex"),
		};
		return { bytes: content, identity };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

/** Bounded, no-follow directory identity. Rejects a symlinked or non-directory path. */
async function readDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity | undefined> {
	try {
		const stat = await fs.lstat(path.resolve(directoryPath), { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("parent_not_directory");
		return { dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function validFileIdentity(value: unknown): value is FileIdentity {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<FileIdentity>;
	return (
		typeof v.dev === "string" &&
		typeof v.ino === "string" &&
		typeof v.nlink === "string" &&
		typeof v.size === "string" &&
		typeof v.mtimeNs === "string" &&
		typeof v.mode === "number" &&
		typeof v.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(v.sha256) &&
		typeof v.parentDev === "string" &&
		typeof v.parentIno === "string" &&
		[v.dev, v.ino, v.nlink, v.size, v.parentDev, v.parentIno].every(
			value => /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n,
		) &&
		/^-?(?:0|[1-9]\d{0,18})$/.test(v.mtimeNs) &&
		Number.isInteger(v.mode) &&
		v.mode >= 0 &&
		v.mode <= 0xffff &&
		v.nlink === "1"
	);
}

function validDirectoryIdentity(value: unknown): value is DirectoryIdentity {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<DirectoryIdentity>;
	return (
		typeof v.dev === "string" &&
		typeof v.ino === "string" &&
		[v.dev, v.ino].every(value => /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n) &&
		typeof v.mode === "number" &&
		Number.isInteger(v.mode) &&
		v.mode >= 0 &&
		v.mode <= 0xffff
	);
}

const PHASES = new Set<ActivationPhase>([
	"staged",
	"published",
	"verified",
	"pending_activation",
	"rolled_back",
	"uncertain",
]);
const BACKUP_NAME = /^[^\\/]{1,255}$/;

function validRecord(value: unknown, targetPath: string): value is ActivationRecordV1 {
	if (!value || typeof value !== "object") return false;
	const r = value as Partial<ActivationRecordV1>;
	if (
		r.schemaVersion !== 1 ||
		r.kind !== "gjc-install-activation" ||
		typeof r.transactionId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.transactionId) ||
		typeof r.targetPath !== "string" ||
		typeof r.parentPath !== "string" ||
		typeof r.stagingPath !== "string" ||
		typeof r.backupName !== "string" ||
		!BACKUP_NAME.test(r.backupName) ||
		r.backupName.includes("\0") ||
		r.backupName === "." ||
		r.backupName === ".." ||
		typeof r.phase !== "string" ||
		!PHASES.has(r.phase as ActivationPhase)
	)
		return false;
	if (!r.baseline || typeof r.baseline !== "object" || typeof r.baseline.exists !== "boolean") return false;
	if (r.baseline.exists && !r.targetIdentity) return false;
	if (
		!r.candidate ||
		typeof r.candidate !== "object" ||
		typeof r.candidate.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(r.candidate.digest) ||
		typeof r.candidate.version !== "string" ||
		!Array.isArray(r.candidate.sidecars)
	)
		return false;
	if (r.targetIdentity !== undefined && !validFileIdentity(r.targetIdentity)) return false;
	if (r.backupIdentity !== undefined && !validFileIdentity(r.backupIdentity)) return false;
	if (r.stagingIdentity !== undefined && !validFileIdentity(r.stagingIdentity)) return false;
	if (r.parentIdentity !== undefined && !validDirectoryIdentity(r.parentIdentity)) return false;
	// Target-adjacent authority: the record must literally describe this exact
	// target and its immediate parent, resolved lexically, never inferred from
	// staging/backup basename prefixes.
	const resolvedTarget = path.resolve(targetPath);
	if (path.resolve(r.targetPath) !== resolvedTarget) return false;
	if (path.resolve(r.parentPath) !== path.dirname(resolvedTarget)) return false;
	if (path.dirname(path.resolve(r.stagingPath)) !== path.dirname(resolvedTarget)) return false;
	return true;
}

/**
 * Read the activation record for `targetPath`, itself opened bounded/
 * no-follow/identity-revalidated. A record that is present but fails schema
 * or path validation is reported distinctly (`malformed`/`foreign`) and is
 * never treated as absent, so a caller cannot silently proceed past a
 * corrupted or substituted record.
 */
export async function readActivationRecord(targetPath: string): Promise<ActivationRead> {
	const recordPath = activationRecordPath(targetPath);
	const snapshot = await readExactRegularFile(recordPath);
	if (!snapshot) return { status: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(snapshot.bytes).toString("utf8"));
	} catch {
		return { status: "malformed", reason: "invalid_json" };
	}
	if (!validRecord(parsed, targetPath)) return { status: "foreign", reason: "schema_or_target_mismatch" };
	return { status: "valid", record: parsed, identity: snapshot.identity };
}

/**
 * Create the activation record with a no-replace write: an existing record
 * (foreign, malformed, or a live transaction) is never overwritten blindly.
 */
export async function createActivationRecordFile(record: ActivationRecordV1): Promise<FileIdentity> {
	if (!validRecord(record, record.targetPath) || !record.parentIdentity) throw new Error("invalid_activation_record");
	const recordPath = activationRecordPath(record.targetPath);
	const tempPath = `${recordPath}.${record.transactionId}.tmp`;
	const handle = await fs.open(
		tempPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	const source = await readExactRegularFile(tempPath);
	if (
		!source ||
		!record.parentIdentity ||
		source.identity.parentDev !== record.parentIdentity.dev ||
		source.identity.parentIno !== record.parentIdentity.ino
	)
		throw new Error("activation_record_parent_changed");
	const published = exactRestore(tempPath, recordPath, toNativeIdentity(source.identity));
	const retainedPlaceholder =
		published.code === "cleanup_pending" &&
		published.retainedPlaceholderPath &&
		!published.retainedUnknownPath &&
		!published.retainedSuccessorPath;
	if (!published.ok && !retainedPlaceholder)
		throw new Error(`activation_record_publication_unverified:${published.code ?? "unknown"}`);
	const observed = await readExactRegularFile(recordPath);
	if (!observed || !sameFileIdentity(source.identity, observed.identity))
		throw new Error("activation_record_identity_changed");
	await syncActivationParent(record.parentPath, record.parentIdentity);
	return source.identity;
}

async function syncActivationParent(parentPath: string, expected: DirectoryIdentity): Promise<void> {
	if (process.platform === "win32") return;
	const parent = await fs.open(
		parentPath,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await parent.stat({ bigint: true });
		if (stat.dev.toString() !== expected.dev || stat.ino.toString() !== expected.ino)
			throw new Error("activation_parent_changed");
		await parent.sync();
	} finally {
		await parent.close();
	}
}

/**
 * Compare-and-swap the activation record: the caller must supply the exact
 * identity of the record it last read. `exactReplacePath` performs the
 * atomic namespace-exchange CAS; a stale or substituted record is refused
 * rather than overwritten.
 */
export async function updateActivationRecordFile(
	record: ActivationRecordV1,
	expectedIdentity: FileIdentity,
): Promise<FileIdentity> {
	if (!validRecord(record, record.targetPath) || !record.parentIdentity) throw new Error("invalid_activation_record");
	const recordPath = activationRecordPath(record.targetPath);
	const tempPath = `${recordPath}.${record.transactionId}.${randomUUID()}.tmp`;
	const handle = await fs.open(
		tempPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	const source = await readExactRegularFile(tempPath);
	if (
		!source ||
		source.identity.parentDev !== expectedIdentity.parentDev ||
		source.identity.parentIno !== expectedIdentity.parentIno ||
		source.identity.parentDev !== record.parentIdentity.dev ||
		source.identity.parentIno !== record.parentIdentity.ino
	)
		throw new Error("activation_record_parent_changed");
	const replaced = exactReplacePath(
		tempPath,
		recordPath,
		toNativeIdentity(source.identity),
		toNativeIdentity(expectedIdentity),
	);
	if (!replaced.ok) throw new Error("activation_record_compare_and_swap_failed");
	return source.identity;
}

export type ReconcileStatus =
	| "missing"
	| "verified"
	| "reconciled"
	| "applied_unverified"
	| "rolled_back"
	| "pending_activation"
	| "conflict"
	| "malformed"
	| "foreign";

export interface ReconcileResult {
	readonly status: ReconcileStatus;
	readonly record?: ActivationRecordV1;
	readonly recordIdentity?: FileIdentity;
	readonly reason?: string;
	/** Present only for a pre-mutation Windows sharing violation on the destination open. */
	readonly windowsErrorCode?: string;
}

/**
 * Reconcile the activation record for `targetPath` against durable state.
 *
 * `staged`/`pending_activation` phases are promoted onto the live target via
 * `exactReplaceRetained` only when `allowPromotion` is set and every
 * identity (staging candidate, current target, parent) still matches what
 * the record captured; the previous target is retired intact to the
 * record's `backupName`, never unlinked or blind-renamed. `published`
 * records are re-verified and advanced to `verified` once the target
 * digest/identity matches the candidate. `verified` records are read-only
 * re-confirmations. Anything else (target/parent drift, missing staged
 * candidate, an already-occupied backup name, a pre-mutation Windows
 * sharing violation) is reported as `conflict` with the exact reason and
 * never silently promoted.
 */
export async function reconcileActivationRecord(
	targetPath: string,
	options: { readonly allowPromotion?: boolean; readonly expectedRecordIdentity?: FileIdentity } = {},
): Promise<ReconcileResult> {
	const read = await readActivationRecord(targetPath);
	if (read.status === "missing") return { status: "missing" };
	if (read.status === "malformed" || read.status === "foreign") return { status: read.status, reason: read.reason };
	const { record, identity: recordIdentity } = read;
	if (options.expectedRecordIdentity && !sameFileIdentity(options.expectedRecordIdentity, recordIdentity))
		return { status: "conflict", reason: "activation_record_changed" };

	const parentIdentity = await readDirectoryIdentity(record.parentPath);
	if (record.parentIdentity && !sameDirectoryIdentity(record.parentIdentity, parentIdentity))
		return { status: "conflict", record, reason: "parent_changed" };

	if (record.phase === "rolled_back") {
		const current = await snapshotRegularFile(targetPath);
		if (!record.baseline.exists)
			return current
				? { status: "conflict", record, reason: "rollback_identity_changed" }
				: { status: "rolled_back", record, recordIdentity };
		return current &&
			record.targetIdentity &&
			record.backupIdentity &&
			sameFileIdentity(current.identity, record.targetIdentity) &&
			current.identity.sha256 === record.baseline.digest
			? { status: "rolled_back", record, recordIdentity }
			: { status: "conflict", record, reason: "rollback_identity_changed" };
	}
	if (record.phase === "verified") {
		const current = await snapshotRegularFile(targetPath);
		if (!current) return { status: "conflict", record, reason: "target_missing" };
		if (
			!record.targetIdentity ||
			!sameFileIdentity(record.targetIdentity, current.identity) ||
			current.identity.sha256 !== record.candidate.digest
		)
			return { status: "conflict", record, reason: "target_digest_mismatch" };
		return { status: "verified", record, recordIdentity };
	}

	if (record.phase === "published") {
		const current = await snapshotRegularFile(targetPath);
		if (!current) return { status: "conflict", record, reason: "target_missing" };
		if (current.identity.sha256 !== record.candidate.digest)
			return { status: "conflict", record, reason: "target_digest_mismatch" };
		if (!record.targetIdentity || !sameFileIdentity(record.targetIdentity, current.identity))
			return { status: "conflict", record, reason: "target_changed" };
		return { status: "applied_unverified", record, recordIdentity, reason: "execution_postcheck_required" };
	}

	if (record.phase === "staged" || record.phase === "pending_activation") {
		if (!options.allowPromotion) return { status: "pending_activation", record, reason: "activation_pending" };
		if ((record.baseline.exists && !record.targetIdentity) || !record.stagingIdentity || !record.parentIdentity)
			return { status: "conflict", record, reason: "original_snapshot_incomplete" };
		const stagingCurrent = await snapshotRegularFile(record.stagingPath);
		if (!stagingCurrent) return { status: "pending_activation", record, reason: "candidate_missing" };
		if (!sameFileIdentity(record.stagingIdentity, stagingCurrent.identity))
			return { status: "conflict", record, reason: "candidate_changed" };
		if (stagingCurrent.identity.sha256 !== record.candidate.digest)
			return { status: "conflict", record, reason: "candidate_digest_mismatch" };
		const targetCurrent = await snapshotRegularFile(targetPath);
		if (
			record.baseline.exists &&
			(!targetCurrent || !record.targetIdentity || !sameFileIdentity(record.targetIdentity, targetCurrent.identity))
		)
			return { status: "conflict", record, reason: "target_changed" };
		if (!record.baseline.exists && targetCurrent) return { status: "conflict", record, reason: "target_appeared" };
		const result =
			record.baseline.exists && record.targetIdentity
				? exactReplaceRetained(
						record.stagingPath,
						targetPath,
						record.backupName,
						toNativeIdentity(record.stagingIdentity),
						toNativeIdentity(record.targetIdentity),
					)
				: exactRestore(record.stagingPath, targetPath, toNativeIdentity(record.stagingIdentity));
		const retainedCreationPlaceholder =
			!record.baseline.exists &&
			result.code === "cleanup_pending" &&
			result.retainedPlaceholderPath &&
			!result.retainedUnknownPath &&
			!result.retainedSuccessorPath;
		if (!result.ok && !retainedCreationPlaceholder) {
			if (
				process.platform === "win32" &&
				record.targetIdentity &&
				result.code === "sharing_violation" &&
				result.windowsErrorCode &&
				!result.detachedPath &&
				!result.retainedSuccessorPath &&
				!result.retainedUnknownPath &&
				!result.retainedPlaceholderPath
			) {
				const unchangedTarget = await snapshotRegularFile(targetPath);
				const unchangedStaging = await snapshotRegularFile(record.stagingPath);
				if (
					unchangedTarget &&
					unchangedStaging &&
					sameFileIdentity(record.targetIdentity, unchangedTarget.identity) &&
					sameFileIdentity(record.stagingIdentity, unchangedStaging.identity)
				) {
					const pending: ActivationRecordV1 = { ...record, phase: "pending_activation" };
					const pendingIdentity = await updateActivationRecordFile(pending, recordIdentity);
					return {
						status: "pending_activation",
						record: pending,
						recordIdentity: pendingIdentity,
						reason: "sharing_violation",
						windowsErrorCode: result.windowsErrorCode,
					};
				}
			}
			return {
				status: "conflict",
				record,
				reason: result.code ?? "activation_promotion_failed",
				...(result.windowsErrorCode ? { windowsErrorCode: result.windowsErrorCode } : {}),
			};
		}
		const promoted = await snapshotRegularFile(targetPath);
		if (
			!promoted ||
			promoted.identity.sha256 !== record.candidate.digest ||
			!sameFileIdentity(record.stagingIdentity, promoted.identity)
		)
			return { status: "conflict", record, reason: "post_promotion_digest_mismatch" };
		await syncActivationParent(record.parentPath, record.parentIdentity);
		const publishedRecord: ActivationRecordV1 = {
			...record,
			backupIdentity: record.targetIdentity,
			targetIdentity: promoted.identity,
			phase: "published",
		};
		const publishedIdentity = await updateActivationRecordFile(publishedRecord, recordIdentity);
		return { status: "reconciled", record: publishedRecord, recordIdentity: publishedIdentity };
	}

	return { status: "conflict", record, reason: "uncertain_phase_requires_manual_review" };
}
