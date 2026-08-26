/**
 * Byte-safe JSON publication for files another application owns.
 *
 * Paseo owns `~/.paseo/config.json` and offers no lock API, so every write here
 * is conservative by construction:
 *
 * - A round-trip fidelity self-check re-serializes the UNMODIFIED parse and
 *   refuses to write unless it is byte-identical to the original. Paseo writes
 *   2-space JSON with a trailing newline; anything else means our formatting
 *   assumption no longer holds and guessing would silently rewrite the file.
 * - A compare-and-swap re-reads the file immediately before publishing, so a
 *   concurrent write between our read and our rename is detected, not clobbered.
 * - Publication is temp-write plus rename, never a direct write to the target.
 * - Backups land beside the original at mode 0600, because `config.json` holds
 *   `daemon.auth.password`.
 *
 * This module carries NO ownership, seeding, or removal policy. Those live in
 * the per-target adapters so this file stays small enough to audit.
 */
import * as nodeCrypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	exactReplacePath,
	exactUnlinkDirect,
	type NativeExactFileIdentity,
	renameNoReplacePath,
} from "@gajae-code/natives";

/** Serialization Paseo itself produces. Verified byte-identical against the live config. */
export function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashBytes(bytes: string): string {
	return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export interface PersistedFileIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly parentDev: string;
	readonly parentIno: string;
	readonly size: string;
	readonly mtimeNs: string;
	readonly sha256: string;
}

export function persistFileIdentity(identity: NativeExactFileIdentity): PersistedFileIdentity {
	if (identity.parentDev === undefined || identity.parentIno === undefined || identity.sha256 === undefined) {
		throw new Error("file identity is incomplete");
	}
	return {
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		parentDev: identity.parentDev.toString(),
		parentIno: identity.parentIno.toString(),
		size: identity.size.toString(),
		mtimeNs: identity.mtimeNs.toString(),
		sha256: identity.sha256,
	};
}

function samePersistedIdentity(left: PersistedFileIdentity, right: PersistedFileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.parentDev === right.parentDev &&
		left.parentIno === right.parentIno &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.sha256 === right.sha256
	);
}

/** Marker recorded when a target did not exist at preflight. */
export const ABSENT_IDENTITY = "absent";

export type PublishRefusal =
	| { readonly reason: "parse-refusal"; readonly detail: string }
	| { readonly reason: "format-drift"; readonly detail: string }
	| { readonly reason: "cas-conflict"; readonly expected: string; readonly actual: string }
	| { readonly reason: "sidecar-conflict"; readonly detail: string };

export class PaseoPublishError extends Error {
	readonly refusal: PublishRefusal;
	readonly targetPath: string;
	readonly retained: readonly string[];

	constructor(targetPath: string, refusal: PublishRefusal, retained: readonly string[] = []) {
		super(describeRefusal(targetPath, refusal));
		this.name = "PaseoPublishError";
		this.refusal = refusal;
		this.targetPath = targetPath;
		this.retained = retained;
	}
}

function describeRefusal(targetPath: string, refusal: PublishRefusal): string {
	switch (refusal.reason) {
		case "parse-refusal":
			return `Refusing to write ${targetPath}: it is not parseable JSON (${refusal.detail}). Fix or remove the file, then re-run.`;
		case "format-drift":
			return `Refusing to write ${targetPath}: ${refusal.detail}. GJC only edits files it can rewrite byte-for-byte, so it will not reformat a file it did not author.`;
		case "cas-conflict":
			return `Refusing to write ${targetPath}: the file changed while GJC was preparing its update. Re-run to pick up the current contents.`;
		case "sidecar-conflict":
			return `Refusing to preserve the replaced provider value at ${targetPath}: ${refusal.detail}. Inspect or remove the existing sidecar, then re-run.`;
	}
}

export interface ReadTargetResult {
	readonly exists: boolean;
	/** Raw bytes as read, or `""` when absent. */
	readonly raw: string;
	/** Hash of `raw`, or `ABSENT_IDENTITY` when absent. */
	readonly identity: string;
	/** Parsed object; `{}` when absent. */
	readonly parsed: Record<string, unknown>;
}

/**
 * Read and validate a target without writing anything.
 *
 * Throws `PaseoPublishError` on unparseable JSON or on a formatting mismatch,
 * so callers never have to decide whether a file is safe to touch.
 */
export async function readTarget(targetPath: string): Promise<ReadTargetResult> {
	let raw: string;
	try {
		raw = await Bun.file(targetPath).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { exists: false, raw: "", identity: ABSENT_IDENTITY, parsed: {} };
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new PaseoPublishError(targetPath, {
			reason: "parse-refusal",
			detail: error instanceof Error ? error.message : String(error),
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PaseoPublishError(targetPath, { reason: "parse-refusal", detail: "root is not a JSON object" });
	}

	// Round-trip fidelity self-check: re-serialize the UNMODIFIED parse. If that
	// is not byte-identical, our formatting assumption is wrong and any write
	// would silently reformat regions we do not own.
	const roundTrip = serializeJson(parsed);
	if (roundTrip !== raw) {
		throw new PaseoPublishError(targetPath, {
			reason: "format-drift",
			detail:
				"re-serializing the file's own contents did not reproduce it byte-for-byte (expected 2-space indentation with a trailing newline)",
		});
	}

	return { exists: true, raw, identity: hashBytes(raw), parsed: parsed as Record<string, unknown> };
}

export interface PublishPlan {
	/** Bytes that will be published. */
	readonly nextRaw: string;
	/** Hash of `nextRaw` -- the expected post-publish identity, computable before any rename. */
	readonly expectedIdentity: string;
	/** True when the mutation produced no change and publication can be skipped. */
	readonly unchanged: boolean;
}

/**
 * Apply `mutate` to a validated read and compute the exact bytes to publish.
 *
 * Split out from {@link publishPlan} so the install saga can record the expected
 * post-publish identity in its durable intent BEFORE anything is written.
 */
export function planPublish(current: ReadTargetResult, mutate: (draft: Record<string, unknown>) => void): PublishPlan {
	const draft = structuredClone(current.parsed);
	mutate(draft);
	const nextRaw = serializeJson(draft);
	return { nextRaw, expectedIdentity: hashBytes(nextRaw), unchanged: nextRaw === current.raw };
}

export interface PublishOptions {
	/** Identity the target must still carry at publication time. */
	readonly expectedIdentity: string;
	/** Take a mode-0600 backup beside the original before replacing it. */
	readonly backup: boolean;
	readonly now: Date;
	/** Persist cleanup authority before and after credential-bearing backup creation. */
	readonly onBackupPrepared?: (
		backupPath: string,
		valueSha256: string,
		identity?: PersistedFileIdentity,
	) => Promise<void>;
}

export interface PublishResult {
	readonly published: boolean;
	readonly backupPath?: string;
	readonly identity: string;
}

/**
 * Whether this runtime can authenticate a private sidecar without following a
 * reparse point. Node's regular `fs.open` surface does not expose the Windows
 * `FILE_FLAG_OPEN_REPARSE_POINT` equivalent, so treating a successful open as
 * proof there would let a junction redirect credential-bearing bytes. POSIX
 * callers need `O_NOFOLLOW` for the same final-component guarantee.
 */
export function hasNoReparseSidecarAuthority(): boolean {
	return process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number";
}

function backupSuffix(now: Date): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}-${nodeCrypto.randomUUID()}`;
}

/**
 * Publish `plan.nextRaw` to `targetPath` under a compare-and-swap on
 * `options.expectedIdentity`.
 *
 * The CAS is re-read immediately before the rename, which is the narrowest
 * window GJC can achieve. It does not defend against Paseo re-writing the file
 * later from its own stale in-memory copy -- Paseo exposes no lock or version
 * API, so that remains a documented residual risk detected by `--check`.
 */
export async function publishPlan(
	targetPath: string,
	plan: PublishPlan,
	options: PublishOptions,
): Promise<PublishResult> {
	if (plan.unchanged) return { published: false, identity: options.expectedIdentity };
	if (options.backup && !hasNoReparseSidecarAuthority()) {
		// Check the target before creating its parent directory. An existing
		// target means this publication would create a generic credential backup;
		// Windows cannot authenticate that final path component without native
		// no-reparse authority, so refuse before any filesystem mutation.
		const targetPresent = await fs.lstat(targetPath).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (targetPresent !== undefined) {
			throw new PaseoPublishError(targetPath, {
				reason: "sidecar-conflict",
				detail:
					"this runtime cannot authenticate a no-reparse generic publication backup; refusing to create a credential-bearing backup",
			});
		}
	}

	const directory = path.dirname(targetPath);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });

	// Capture the full destination identity before reading bytes. The digest and
	// inode must describe one snapshot; hashing first and statting later admits
	// an A→B→A inode successor through an unchanged byte hash.
	const expectedDestinationIdentity = await captureRegularIdentity(targetPath);
	const observed = expectedDestinationIdentity?.sha256 ?? ABSENT_IDENTITY;
	if (observed !== options.expectedIdentity) {
		throw new PaseoPublishError(targetPath, {
			reason: "cas-conflict",
			expected: options.expectedIdentity,
			actual: observed,
		});
	}

	let backupPath: string | undefined;
	let backupCreated = false;
	let backupIdentity: NativeExactFileIdentity | undefined;
	let backupBytes: Buffer | undefined;
	if (observed !== ABSENT_IDENTITY && expectedDestinationIdentity === undefined) {
		throw new PaseoPublishError(targetPath, {
			reason: "cas-conflict",
			expected: options.expectedIdentity,
			actual: observed,
		});
	}
	if (expectedDestinationIdentity !== undefined && expectedDestinationIdentity.sha256 !== observed) {
		throw new PaseoPublishError(targetPath, {
			reason: "cas-conflict",
			expected: options.expectedIdentity,
			actual: observed,
		});
	}
	if (options.backup && observed !== ABSENT_IDENTITY) {
		// Generic publication backups are credential-bearing copies of the
		// caller-owned target. Node has no Windows equivalent of
		// FILE_FLAG_OPEN_REPARSE_POINT, so a pathname-only copy could follow a
		// junction and leave recovery without authenticated cleanup authority.
		// Refuse before creating the backup (and before the target mutation) rather
		// than publishing an artifact recovery cannot safely authenticate.
		if (!hasNoReparseSidecarAuthority()) {
			throw new PaseoPublishError(targetPath, {
				reason: "sidecar-conflict",
				detail:
					"this runtime cannot authenticate a no-reparse generic publication backup; refusing to create a credential-bearing backup",
			});
		}
		backupPath = `${targetPath}.gjc-bak-${backupSuffix(options.now)}`;
		backupBytes = Buffer.from(await Bun.file(targetPath).bytes());
		await options.onBackupPrepared?.(backupPath, hashBytes(backupBytes.toString("utf8")));
		const backup = await copyPrivately(targetPath, backupPath, backupBytes.toString("utf8"));
		backupCreated = backup.created;
		backupIdentity = backup.identity;
		await options.onBackupPrepared?.(
			backupPath,
			hashBytes(backupBytes.toString("utf8")),
			backupIdentity === undefined ? undefined : persistFileIdentity(backupIdentity),
		);
		if ((await currentIdentity(targetPath)) !== observed) {
			if (
				backupCreated &&
				backupIdentity !== undefined &&
				!(await removePrivateBackupByIdentity(backupPath, backupIdentity))
			) {
				throw new PaseoPublishError(
					targetPath,
					{
						reason: "cas-conflict",
						expected: options.expectedIdentity,
						actual: await currentIdentity(targetPath),
					},
					[backupPath],
				);
			}
			throw new PaseoPublishError(targetPath, {
				reason: "cas-conflict",
				expected: options.expectedIdentity,
				actual: await currentIdentity(targetPath),
			});
		}
		if (backupPath !== undefined && backupIdentity !== undefined) {
			const observedBackup = await captureRegularIdentity(backupPath);
			if (
				observedBackup === undefined ||
				JSON.stringify(persistFileIdentity(observedBackup)) !== JSON.stringify(persistFileIdentity(backupIdentity))
			) {
				if (backupCreated) await removePrivateBackupByIdentity(backupPath, backupIdentity);
				throw new PaseoPublishError(targetPath, {
					reason: "cas-conflict",
					expected: options.expectedIdentity,
					actual: await currentIdentity(targetPath),
				});
			}
		}
	}

	// Never write the final path directly: a crash mid-write would leave the
	// user's config truncated. Stage beside the target, fsync, then rename.
	const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`);
	const mode = await sourceMode(targetPath);
	let tempRetained = false;
	let tempConsumed = false;
	let tempIdentity: NativeExactFileIdentity | undefined;
	try {
		const handle = await fs.open(tempPath, "wx+", mode);
		let sourceIdentity: NativeExactFileIdentity | undefined;
		try {
			await handle.writeFile(plan.nextRaw, "utf8");
			await handle.sync();
			sourceIdentity = await capturePrivateBackupIdentity(handle, tempPath, Buffer.from(plan.nextRaw, "utf8"));
			tempIdentity = sourceIdentity;
		} catch (error) {
			tempIdentity = await capturePrivateBackupIdentity(handle, tempPath, Buffer.from(plan.nextRaw, "utf8"));
			if (tempIdentity === undefined) {
				throw new PaseoPublishError(
					targetPath,
					{
						reason: "cas-conflict",
						expected: options.expectedIdentity,
						actual: await currentIdentity(targetPath),
					},
					[tempPath],
				);
			}
			throw error;
		} finally {
			await handle.close();
		}
		const destinationIdentity = await captureRegularIdentity(targetPath);
		if (sourceIdentity === undefined) {
			throw new PaseoPublishError(
				targetPath,
				{ reason: "cas-conflict", expected: options.expectedIdentity, actual: await currentIdentity(targetPath) },
				[tempPath],
			);
		}
		if (expectedDestinationIdentity === undefined) {
			if (destinationIdentity !== undefined) {
				throw new PaseoPublishError(targetPath, {
					reason: "cas-conflict",
					expected: options.expectedIdentity,
					actual: await currentIdentity(targetPath),
				});
			}
			const linked = renameNoReplacePath(tempPath, targetPath);
			if (!linked.ok) {
				tempRetained = linked.mutationState !== "not_committed";
				throw new PaseoPublishError(
					targetPath,
					{
						reason: "cas-conflict",
						expected: options.expectedIdentity,
						actual: await currentIdentity(targetPath),
					},
					tempRetained ? [tempPath] : [],
				);
			}
			tempConsumed = true;
		} else {
			const replaced = exactReplacePath(tempPath, targetPath, sourceIdentity, expectedDestinationIdentity);
			if (!replaced.ok) {
				tempRetained =
					replaced.detachedPath !== undefined ||
					replaced.retainedSuccessorPath !== undefined ||
					replaced.retainedPlaceholderPath !== undefined ||
					replaced.retainedUnknownPath !== undefined;
				throw new PaseoPublishError(
					targetPath,
					{
						reason: "cas-conflict",
						expected: options.expectedIdentity,
						actual: await currentIdentity(targetPath),
					},
					[
						tempPath,
						...(replaced.detachedPath ? [replaced.detachedPath] : []),
						...(replaced.retainedSuccessorPath ? [replaced.retainedSuccessorPath] : []),
						...(replaced.retainedPlaceholderPath ? [replaced.retainedPlaceholderPath] : []),
						...(replaced.retainedUnknownPath ? [replaced.retainedUnknownPath] : []),
					],
				);
			}
			tempConsumed = true;
		}
		await syncParentDirectory(directory);
	} catch (error) {
		if (backupCreated && backupPath !== undefined && backupIdentity !== undefined) {
			const removed = await removePrivateBackupByIdentity(backupPath, backupIdentity);
			if (!removed) {
				throw new PaseoPublishError(
					targetPath,
					{
						reason: "cas-conflict",
						expected: options.expectedIdentity,
						actual: await currentIdentity(targetPath),
					},
					[backupPath, ...(error instanceof PaseoPublishError ? error.retained : [])],
				);
			}
		}
		throw error;
	} finally {
		if (!tempRetained && !tempConsumed && tempIdentity !== undefined) {
			if (!(await removePrivateBackupByIdentity(tempPath, tempIdentity))) {
				tempRetained = true;
			}
		}
	}

	return { published: true, backupPath, identity: plan.expectedIdentity };
}

/** Current on-disk identity, or {@link ABSENT_IDENTITY} when the file does not exist. */
export async function currentIdentity(targetPath: string): Promise<string> {
	try {
		return hashBytes(await Bun.file(targetPath).text());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_IDENTITY;
		throw error;
	}
}

/**
 * Preserve the target's own permissions when republishing it.
 *
 * Narrowed to at most 0600 for group and other, never widened: a file that was
 * already private must stay private, and one that was world-readable must not
 * become more permissive because we rewrote it.
 */
async function sourceMode(targetPath: string): Promise<number> {
	try {
		const stat = await fs.stat(targetPath);
		return stat.mode & 0o777;
	} catch {
		return 0o600;
	}
}

async function syncParentDirectory(directory: string): Promise<void> {
	// Windows does not support fsync on directory handles; file contents are
	// already synced before rename, so the renamed entry remains valid there.
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Backups are ALWAYS 0600, regardless of the source mode.
 *
 * A backup of `~/.paseo/config.json` contains `daemon.auth.password`, and a
 * backup generally duplicates content into a new path the user did not choose,
 * so it must never inherit a permissive source mode.
 */
const BACKUP_MODE = 0o600;

/**
 * Canonicalize the existing parent of a sidecar for native path walking.
 *
 * Native exact-unlink rejects intermediate symlinks and junctions by design,
 * while supported config roots may themselves be reached through one. Keep
 * the final basename lexical so the native no-follow check still guards the
 * sidecar pathname at the mutation boundary.
 */
async function canonicalSidecarPathForNativeUnlink(sidecarPath: string): Promise<string> {
	const absolute = path.resolve(sidecarPath);
	const canonicalParent = await fs.realpath(path.dirname(absolute));
	return path.join(canonicalParent, path.basename(absolute));
}

async function openRegularSidecar(
	backupPath: string,
	flags: number,
): Promise<{ readonly handle: fs.FileHandle; readonly stat: BigIntStats } | undefined> {
	// Node does not expose FILE_FLAG_OPEN_REPARSE_POINT through fs.open. A
	// regular lstat followed by a Windows open can still traverse a reparse
	// point, so sidecar authentication fails closed on Windows until the native
	// no-reparse opener is available.
	if (!hasNoReparseSidecarAuthority()) return undefined;
	const initial = await fs.lstat(backupPath, { bigint: true });
	if (!initial.isFile()) return undefined;
	const nofollow = fs.constants.O_NOFOLLOW as number;
	const handle = await fs.open(backupPath, flags | nofollow);
	try {
		const opened = await handle.stat({ bigint: true });
		const current = await fs.lstat(backupPath, { bigint: true });
		if (
			!opened.isFile() ||
			opened.dev !== initial.dev ||
			opened.ino !== initial.ino ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			!current.isFile()
		) {
			await handle.close();
			return undefined;
		}
		return { handle, stat: opened };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

/**
 * True only for a publication backup beside the target that GJC itself could
 * have generated. The path is intentionally structural: the unique suffix is
 * carried by the intent record and is not re-derived during recovery.
 */
export function isCanonicalPublishBackupPath(targetPath: unknown, backupPath: unknown): backupPath is string {
	if (typeof targetPath !== "string" || typeof backupPath !== "string") return false;
	if (!path.isAbsolute(targetPath) || !path.isAbsolute(backupPath)) return false;
	const target = path.resolve(targetPath);
	const backup = path.resolve(backupPath);
	return (
		path.dirname(target) === path.dirname(backup) &&
		path.basename(backup).startsWith(`${path.basename(target)}.gjc-bak-`)
	);
}

/**
 * Remove an interrupted generic publication backup only while its authenticated
 * bytes and regular-file identity still own the recorded pathname. This is the
 * recovery inverse for a backup created before target publication: a failed
 * unlink leaves the intent and exact path in place so a later run can retry
 * rather than silently clearing cleanup authority.
 */
export async function removePublishBackup(
	targetPath: string,
	backupPath: string,
	expectedSha256: string,
	expectedIdentity?: PersistedFileIdentity,
): Promise<boolean> {
	try {
		if (!isCanonicalPublishBackupPath(targetPath, backupPath)) return false;
		if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) return false;
		const opened = await openRegularSidecar(backupPath, fs.constants.O_RDONLY);
		if (opened === undefined) return false;
		const { handle } = opened;
		let bytes: Buffer;
		let captured: NativeExactFileIdentity | undefined;
		try {
			bytes = await handle.readFile();
			captured = await capturePrivateBackupIdentity(handle, backupPath, bytes);
		} finally {
			await handle.close();
		}
		const digest = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
		if (digest !== expectedSha256) return false;
		if (
			captured === undefined ||
			(expectedIdentity !== undefined && !samePersistedIdentity(expectedIdentity, persistFileIdentity(captured)))
		)
			return false;
		const identity: NativeExactFileIdentity = {
			...captured,
			quarantineName: `.gjc-paseo-publish-backup-${process.pid}-${nodeCrypto.randomUUID()}`,
		};
		const canonicalBackupPath = await canonicalSidecarPathForNativeUnlink(backupPath);
		const result = exactUnlinkDirect(canonicalBackupPath, identity);
		return result.ok || result.code === "not_found";
	} catch {
		return false;
	}
}

interface PrivateCopyResult {
	readonly created: boolean;
	readonly identity?: NativeExactFileIdentity;
}

async function copyPrivately(from: string, to: string, sourceBytes?: string): Promise<PrivateCopyResult> {
	const bytes = sourceBytes ?? (await Bun.file(from).text());
	const mode = BACKUP_MODE;
	let handle: fs.FileHandle;
	let ownsBackup = false;
	let capturedIdentity: NativeExactFileIdentity | undefined;
	try {
		handle = await fs.open(to, "wx+", mode);
		ownsBackup = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = await openRegularSidecar(to, fs.constants.O_RDONLY);
		if (existing === undefined) throw new Error(`backup path exists but is not an authenticated regular file: ${to}`);
		let existingBytes: Buffer;
		try {
			existingBytes = await existing.handle.readFile();
			await existing.handle.chmod(BACKUP_MODE);
		} finally {
			await existing.handle.close();
		}
		if (existingBytes.toString("utf8") === bytes) return { created: false };
		throw new Error(`backup path already contains different content: ${to}`);
	}
	try {
		try {
			await handle.writeFile(bytes, "utf8");
			await handle.sync();
			await handle.chmod(mode);
			capturedIdentity = await capturePrivateBackupIdentity(handle, to, Buffer.from(bytes, "utf8"));
			if (capturedIdentity === undefined) throw new Error(`backup identity unavailable: ${to}`);
		} catch (error) {
			capturedIdentity ??= await capturePrivateBackupIdentity(handle, to, Buffer.from(bytes, "utf8"));
			throw error;
		} finally {
			await handle.close();
		}
		await syncParentDirectory(path.dirname(to));
	} catch (error) {
		if (ownsBackup) {
			const removed = capturedIdentity !== undefined && (await removePrivateBackupByIdentity(to, capturedIdentity));
			if (!removed) {
				throw new PaseoPublishError(
					from,
					{ reason: "cas-conflict", expected: hashBytes(bytes), actual: await currentIdentity(from) },
					[to],
				);
			}
		}
		throw error;
	}
	return { created: true, identity: capturedIdentity };
}

async function capturePrivateBackupIdentity(
	handle: fs.FileHandle,
	backupPath: string,
	knownBytes?: Buffer,
): Promise<NativeExactFileIdentity | undefined> {
	try {
		const stat = await handle.stat({ bigint: true });
		if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
		let bytes: Buffer;
		if (knownBytes !== undefined) {
			bytes = knownBytes;
		} else {
			bytes = Buffer.alloc(Number(stat.size));
			const read = await handle.read(bytes, 0, bytes.length, 0);
			if (read.bytesRead !== bytes.length) return undefined;
		}
		if (bytes.length !== Number(stat.size)) return undefined;
		const parent = await fs.stat(path.dirname(backupPath), { bigint: true });
		return {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			parentDev: parent.dev,
			parentIno: parent.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: nodeCrypto.createHash("sha256").update(bytes).digest("hex"),
			quarantineName: `.gjc-paseo-backup-captured-${process.pid}-${nodeCrypto.randomUUID()}`,
		};
	} catch {
		return undefined;
	}
}

export async function captureRegularIdentity(filePath: string): Promise<NativeExactFileIdentity | undefined> {
	try {
		const link = await fs.lstat(filePath, { bigint: true });
		if (!link.isFile()) return undefined;
		const handle = await fs.open(filePath, "r");
		try {
			const stat = await handle.stat({ bigint: true });
			const bytes = await handle.readFile();
			const parent = await fs.stat(path.dirname(filePath), { bigint: true });
			return {
				dev: stat.dev,
				ino: stat.ino,
				nlink: stat.nlink,
				parentDev: parent.dev,
				parentIno: parent.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: nodeCrypto.createHash("sha256").update(bytes).digest("hex"),
				quarantineName: `.gjc-paseo-publish-${process.pid}-${nodeCrypto.randomUUID()}`,
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function removePrivateBackupByIdentity(backupPath: string, identity: NativeExactFileIdentity): Promise<boolean> {
	try {
		const canonical = await canonicalSidecarPathForNativeUnlink(backupPath);
		return exactUnlinkDirect(canonical, identity).ok;
	} catch {
		return false;
	}
}

/**
 * Where a pre-`--force` provider value is preserved for a later restore.
 *
 * The replaced entry can carry credential-bearing `env` or argument values, so
 * it must never be serialized into GJC's own provenance ledger or intent record.
 * Instead it lives in a deterministic, mode-0600 sidecar beside Paseo's own
 * config file -- the same directory and the same privacy rule the publish-step
 * backups already use -- and the ledger records only the pointer.
 *
 * The name is INJECTIVE in the raw provider key (#4644 review r8): the visible
 * part is sanitized for readability, and a digest of the exact key is appended
 * so two distinct keys that sanitize identically (`a/b` and `a_b`) can never
 * share one sidecar. A shared path would let the second `--force` rename over
 * the first key's only preserved copy of the user's value.
 */
export function replacedProviderBackupPath(configJsonPath: string, providerKey: string): string {
	const safeKey = providerKey.replace(/[^a-zA-Z0-9_-]/gu, "_");
	const keyDigest = nodeCrypto.createHash("sha256").update(providerKey, "utf8").digest("hex").slice(0, 16);
	return `${configJsonPath}.gjc-replaced-${safeKey}-${keyDigest}.json`;
}

/**
 * True only for a deterministic replaced-provider sidecar beside the target
 * config. Discard intents do not carry the provider key, so the suffix is
 * checked structurally against the same safe-key and truncated-digest shape
 * produced by {@link replacedProviderBackupPath}; arbitrary sibling files are
 * not accepted as cleanup authority.
 */
export function isCanonicalReplacedProviderBackupPath(
	configJsonPath: unknown,
	backupPath: unknown,
): backupPath is string {
	if (typeof configJsonPath !== "string" || typeof backupPath !== "string") return false;
	if (!path.isAbsolute(configJsonPath) || !path.isAbsolute(backupPath)) return false;
	const target = path.resolve(configJsonPath);
	const candidate = path.resolve(backupPath);
	if (path.dirname(candidate) !== path.dirname(target)) return false;
	const prefix = `${path.basename(target)}.gjc-replaced-`;
	const name = path.basename(candidate);
	if (!name.startsWith(prefix)) return false;
	return /^[a-zA-Z0-9_-]*-[a-f0-9]{16}\.json$/u.test(name.slice(prefix.length));
}

/**
 * Write the pre-`--force` value of one provider key into its private sidecar.
 *
 * Publication is no-clobber: the staged bytes are linked into place, so an
 * existing sidecar is never replaced. A sidecar that already holds this key's
 * exact value makes the write idempotent; anything else (a different value for
 * the same key, a foreign or tampered file on the injective path) fails closed
 * instead of destroying the only preserved copy of the user's value.
 */
export async function writeReplacedProviderBackup(
	configJsonPath: string,
	providerKey: string,
	value: unknown,
): Promise<ReplacedProviderBackupRef> {
	const backupPath = replacedProviderBackupPath(configJsonPath, providerKey);
	if (!hasNoReparseSidecarAuthority()) {
		throw new PaseoPublishError(backupPath, {
			reason: "sidecar-conflict",
			detail:
				"this runtime cannot authenticate a no-reparse sidecar; refusing to create a credential-bearing replaced-provider backup",
		});
	}
	const valueSha256 = hashBytes(serializeJson(value));
	const payload = serializeJson({ key: providerKey, value });
	const temporary = `${backupPath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
	let createdByGjc = true;
	let identity: PersistedFileIdentity | undefined;
	let stagedIdentity: NativeExactFileIdentity | undefined;
	let temporaryCleaned = true;
	let temporaryPublished = false;
	try {
		// Keep the entire temporary-file lifecycle inside this cleanup boundary.
		// Opening can create the path before surfacing an error, and chmod can
		// fail after the bytes are durable; either failure must not strand a
		// credential-bearing temporary sidecar.
		const handle = await fs.open(temporary, "wx", BACKUP_MODE);
		try {
			await handle.writeFile(payload, "utf8");
			await handle.sync();
			stagedIdentity = await capturePrivateBackupIdentity(handle, temporary, Buffer.from(payload, "utf8"));
			if (stagedIdentity === undefined) {
				throw new PaseoPublishError(backupPath, {
					reason: "sidecar-conflict",
					detail: "the staged replaced-provider sidecar could not be identity-authenticated",
				});
			}
			// `fs.open` honors the mode only on creation, so set it explicitly.
			await fs.chmod(temporary, BACKUP_MODE);
			// Claim the final name with no-replace rename. Unlike a hard link, this
			// consumes the staging pathname atomically, so there is no second
			// pathname to clean up after the descriptor closes.
			const [nativeTemporary, nativeBackup] = await Promise.all([
				canonicalSidecarPathForNativeUnlink(temporary),
				canonicalSidecarPathForNativeUnlink(backupPath),
			]);
			const published = renameNoReplacePath(nativeTemporary, nativeBackup);
			if (!published.ok) {
				if (published.code !== "already_exists" && published.code !== "quarantine_collision") {
					throw new PaseoPublishError(backupPath, {
						reason: "sidecar-conflict",
						detail: `the replaced-provider sidecar could not be published: ${published.code ?? published.reason}`,
					});
				}
				createdByGjc = false;
				const existing = await readReplacedProviderBackup(backupPath, providerKey, valueSha256);
				if (!existing.found) {
					throw new PaseoPublishError(backupPath, {
						reason: "sidecar-conflict",
						detail: `a replaced-provider sidecar already exists at this path with different content for key ${providerKey}`,
					});
				}
			} else {
				temporaryPublished = true;
			}
			if (createdByGjc) {
				const linked = await fs.lstat(backupPath, { bigint: true });
				if (
					!linked.isFile() ||
					linked.isSymbolicLink() ||
					stagedIdentity === undefined ||
					linked.dev !== stagedIdentity.dev ||
					linked.ino !== stagedIdentity.ino
				) {
					throw new PaseoPublishError(backupPath, {
						reason: "sidecar-conflict",
						detail: "the newly linked sidecar changed before its identity was authenticated",
					});
				}
			}
		} finally {
			if (stagedIdentity === undefined) {
				stagedIdentity = await capturePrivateBackupIdentity(handle, temporary, Buffer.from(payload, "utf8"));
			}
			await handle.close();
		}
		await syncParentDirectory(path.dirname(backupPath));
	} finally {
		if (!temporaryPublished && stagedIdentity !== undefined)
			temporaryCleaned = await removePrivateBackupByIdentity(temporary, stagedIdentity);
	}
	if (!temporaryCleaned) {
		throw new PaseoPublishError(backupPath, {
			reason: "sidecar-conflict",
			detail: "the temporary replaced-provider sidecar could not be cleaned by identity",
		});
	}
	if (createdByGjc) {
		if (stagedIdentity === undefined) {
			throw new PaseoPublishError(backupPath, {
				reason: "sidecar-conflict",
				detail: "the final replaced-provider sidecar lost its staged identity",
			});
		}
		identity = persistFileIdentity(stagedIdentity);
	}
	return { backupPath, valueSha256, createdByGjc, ...(identity === undefined ? {} : { identity }) };
}

/** Pointer + integrity digest for one preserved pre-`--force` provider value. */
export interface ReplacedProviderBackupRef {
	readonly backupPath: string;
	/** Hash of the preserved value exactly as serialized into the sidecar. */
	readonly valueSha256: string;
	/** Whether this invocation created the sidecar rather than adopting an exact pre-existing copy. */
	readonly createdByGjc: boolean;
	/** Identity captured while the staged descriptor still named the sidecar. */
	readonly identity?: PersistedFileIdentity;
}

/** Outcome of reading a replaced-provider sidecar: a `null` prior is a value too. */
export type ReplacedProviderBackup = { readonly found: true; readonly value: unknown } | { readonly found: false };

/**
 * Read one provider key's preserved prior value. A missing, corrupt,
 * key-mismatched, or CONTENT-ALTERED sidecar reports `found: false`, which
 * callers must treat as a fail-closed condition rather than deleting content it
 * was meant to restore. The ledger-recorded digest binds the sidecar's bytes to
 * the record: substituting the sidecar (or swapping a symlink onto its path)
 * cannot steer the value restoration.
 */
export async function readReplacedProviderBackup(
	backupPath: string,
	providerKey: string,
	expectedSha256: string,
	expectedIdentity?: PersistedFileIdentity,
): Promise<ReplacedProviderBackup> {
	try {
		// The read is fd-bound and symlink-rejecting (#4644 review r9): the path
		// is opened with O_NOFOLLOW where the platform provides it, so a symlink
		// swapped onto the sidecar path fails the open outright instead of
		// redirecting restoration at attacker-controlled JSON; the regular-file
		// check and the bytes then share one handle identity. Platforms without
		// O_NOFOLLOW keep the fstat regular-file check on the same fd.
		const opened = await openRegularSidecar(backupPath, fs.constants.O_RDONLY);
		if (opened === undefined) return { found: false };
		const { handle } = opened;
		let bytes: string;
		try {
			bytes = await new Response(await handle.readFile()).text();
			if (expectedIdentity !== undefined) {
				const observedIdentity = await capturePrivateBackupIdentity(handle, backupPath, Buffer.from(bytes, "utf8"));
				if (
					observedIdentity === undefined ||
					!samePersistedIdentity(expectedIdentity, persistFileIdentity(observedIdentity))
				) {
					return { found: false };
				}
			}
		} finally {
			await handle.close();
		}
		const parsed = JSON.parse(bytes) as { key?: unknown; value?: unknown };
		if (parsed.key !== providerKey) return { found: false };
		if (hashBytes(serializeJson(parsed.value)) !== expectedSha256) return { found: false };
		return { found: true, value: parsed.value };
	} catch {
		return { found: false };
	}
}

/**
 * Delete a sidecar only while its authenticated regular-file identity still
 * owns the pathname. `fs.rm()` after a successful fd-bound read reopens a
 * destructive pathname race: a replacement could be deleted after the
 * original sidecar was authenticated. The native exact-unlink protocol
 * compares the captured inode, bytes, and parent identity atomically before
 * detaching its private quarantine, so a successor is preserved.
 */
export async function removeReplacedProviderBackup(
	backupPath: string,
	providerKey: string,
	expectedSha256: string,
	expectedIdentity?: PersistedFileIdentity,
): Promise<boolean> {
	try {
		const opened = await openRegularSidecar(backupPath, fs.constants.O_RDONLY);
		if (opened === undefined) return false;
		const { handle } = opened;
		let bytes: Buffer;
		let captured: NativeExactFileIdentity | undefined;
		try {
			bytes = await handle.readFile();
			captured = await capturePrivateBackupIdentity(handle, backupPath, bytes);
		} finally {
			await handle.close();
		}
		const parsed = JSON.parse(bytes.toString("utf8")) as { key?: unknown; value?: unknown };
		if (parsed.key !== providerKey || hashBytes(serializeJson(parsed.value)) !== expectedSha256) return false;
		if (
			captured === undefined ||
			(expectedIdentity !== undefined && !samePersistedIdentity(expectedIdentity, persistFileIdentity(captured)))
		)
			return false;
		const identity: NativeExactFileIdentity = {
			...captured,
			quarantineName: `.gjc-paseo-sidecar-${process.pid}-${nodeCrypto.randomUUID()}`,
		};
		const canonicalBackupPath = await canonicalSidecarPathForNativeUnlink(backupPath);
		return exactUnlinkDirect(canonicalBackupPath, identity).ok;
	} catch {
		return false;
	}
}

/**
 * Authenticate and remove a sidecar named by a discard intent.
 *
 * Discard intents carry the digest of the complete sidecar bytes rather than
 * the digest of the value wrapped inside the provider-backup envelope. That
 * keeps this recovery path independent of provider keys and prevents it from
 * inferring cleanup targets from a provenance ledger. The read is fd-bound and
 * symlink-rejecting, and the native exact-unlink protocol rechecks the captured
 * identity before detaching the pathname.
 */
export async function removeDiscardSidecar(
	configJsonPath: string,
	backupPath: string,
	expectedSha256: string,
	expectedIdentity?: PersistedFileIdentity,
): Promise<boolean> {
	try {
		// Validate the namespace before opening, hashing, or unlinking anything.
		// The intent's target config is the only authority for where a discarded
		// replaced-provider sidecar may live.
		if (!isCanonicalReplacedProviderBackupPath(configJsonPath, backupPath)) return false;
		if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) return false;
		const opened = await openRegularSidecar(backupPath, fs.constants.O_RDONLY);
		if (opened === undefined) return false;
		const { handle } = opened;
		let bytes: Buffer;
		let captured: NativeExactFileIdentity | undefined;
		try {
			bytes = await handle.readFile();
			captured = await capturePrivateBackupIdentity(handle, backupPath, bytes);
		} finally {
			await handle.close();
		}
		const digest = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
		if (digest !== expectedSha256) return false;
		if (
			captured === undefined ||
			(expectedIdentity !== undefined && !samePersistedIdentity(expectedIdentity, persistFileIdentity(captured)))
		)
			return false;
		const identity: NativeExactFileIdentity = {
			...captured,
			quarantineName: `.gjc-paseo-discard-${process.pid}-${nodeCrypto.randomUUID()}`,
		};
		// Keep the namespace and fd-bound identity checks above on the lexical
		// intent path, then canonicalize only its existing parent for the strict
		// native walk. Rejoining the basename preserves final-component
		// no-follow behavior, including a replacement symlink after this read.
		const canonicalBackupPath = await canonicalSidecarPathForNativeUnlink(backupPath);
		const result = exactUnlinkDirect(canonicalBackupPath, identity);
		// The sidecar was authenticated from the open handle above. If another
		// actor removed that exact file before native cleanup reached the path,
		// ENOENT is already-cleaned success; an initially missing path never gets
		// this far and remains a failed cleanup.
		return result.ok || result.code === "not_found";
	} catch {
		return false;
	}
}
