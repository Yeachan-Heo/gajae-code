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
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Serialization Paseo itself produces. Verified byte-identical against the live config. */
export function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashBytes(bytes: string): string {
	return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/** Marker recorded when a target did not exist at preflight. */
export const ABSENT_IDENTITY = "absent";

export type PublishRefusal =
	| { readonly reason: "parse-refusal"; readonly detail: string }
	| { readonly reason: "format-drift"; readonly detail: string }
	| { readonly reason: "cas-conflict"; readonly expected: string; readonly actual: string };

export class PaseoPublishError extends Error {
	readonly refusal: PublishRefusal;
	readonly targetPath: string;

	constructor(targetPath: string, refusal: PublishRefusal) {
		super(describeRefusal(targetPath, refusal));
		this.name = "PaseoPublishError";
		this.refusal = refusal;
		this.targetPath = targetPath;
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
}

export interface PublishResult {
	readonly published: boolean;
	readonly backupPath?: string;
	readonly identity: string;
}

function backupSuffix(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-");
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

	const directory = path.dirname(targetPath);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });

	// Compare-and-swap: re-read right before publishing so an external write
	// between our original read and this rename is refused, not overwritten.
	const observed = await currentIdentity(targetPath);
	if (observed !== options.expectedIdentity) {
		throw new PaseoPublishError(targetPath, {
			reason: "cas-conflict",
			expected: options.expectedIdentity,
			actual: observed,
		});
	}

	let backupPath: string | undefined;
	if (options.backup && observed !== ABSENT_IDENTITY) {
		backupPath = `${targetPath}.gjc-bak-${backupSuffix(options.now)}`;
		await copyPrivately(targetPath, backupPath);
	}

	// Never write the final path directly: a crash mid-write would leave the
	// user's config truncated. Stage beside the target, fsync, then rename.
	const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`);
	const mode = await sourceMode(targetPath);
	try {
		const handle = await fs.open(tempPath, "wx", mode);
		try {
			await handle.writeFile(plan.nextRaw, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(tempPath, targetPath);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
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

/**
 * Backups are ALWAYS 0600, regardless of the source mode.
 *
 * A backup of `~/.paseo/config.json` contains `daemon.auth.password`, and a
 * backup generally duplicates content into a new path the user did not choose,
 * so it must never inherit a permissive source mode.
 */
const BACKUP_MODE = 0o600;

async function copyPrivately(from: string, to: string): Promise<void> {
	const bytes = await Bun.file(from).text();
	const mode = BACKUP_MODE;
	const handle = await fs.open(to, "w", mode);
	try {
		await handle.writeFile(bytes, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	// `fs.open` honors the mode only on creation, so an existing backup path
	// keeps its old permissions unless we set them explicitly.
	await fs.chmod(to, mode);
}
