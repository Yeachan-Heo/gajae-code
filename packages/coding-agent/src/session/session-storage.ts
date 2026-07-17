import { createHash } from "node:crypto";

import * as fs from "node:fs";
import * as path from "node:path";
import * as native from "@gajae-code/natives";

import { isEnoent, pathIsWithin, peekFile, toError } from "@gajae-code/utils";

const utf8Decoder = new TextDecoder("utf-8");
function canonicalPathSync(value: string): string {
	try {
		return fs.realpathSync.native(value);
	} catch {
		return path.resolve(value);
	}
}

export interface SessionStorageStat {
	dev: bigint;
	ino: bigint;

	size: number;
	mtimeMs: number;
	mtimeNs: bigint;
	mtime: Date;
	isFile: boolean;
}

/** Exact bytes and identity captured from one opened regular-file descriptor. */
export interface SessionStorageSnapshot {
	bytes: Uint8Array;
	stat: SessionStorageStat;
}

function statFromNode(stats: fs.BigIntStats): SessionStorageStat {
	return {
		dev: stats.dev,
		ino: stats.ino,

		size: Number(stats.size),
		mtimeMs: Number(stats.mtimeMs),
		mtimeNs: stats.mtimeNs,
		mtime: stats.mtime,
		isFile: stats.isFile(),
	};
}

// =============================================================================
// Certainty-aware writer close contract (ACP fail-closed deletion foundation)
// =============================================================================
/**
 * Four-state writer close lifecycle. Only a successful underlying close confirms
 * `closed`. A failure certified to have happened BEFORE the OS close was dispatched
 * is `close_failed_retryable` (ownership of the numeric fd is still proven, so a
 * later retry/finalizer close is safe). Any exception from an actually dispatched
 * close call is terminal `close_unknown`: the numeric fd cannot be safely retried
 * or finalizer-closed, and the writer blocks strict deletion.
 */
export type SessionStorageWriterCloseState = "open" | "close_failed_retryable" | "close_unknown" | "closed";

/**
 * Thrown by a {@link SessionStorageWriterCloseAdapter} to certify that a close
 * failure occurred BEFORE the real OS close (`fs.closeSync`-equivalent) was ever
 * dispatched. Because no OS close ran, the numeric fd is still owned and a retry
 * is safe. Any other thrown value is treated as a dispatched close failure
 * (`close_unknown`) and forbids retry/finalizer close of that fd.
 */
export class SessionStorageWriterRetryableCloseError extends Error {
	override readonly name = "SessionStorageWriterRetryableCloseError";
	constructor(message?: string, options?: ErrorOptions) {
		super(message ?? "Certified pre-dispatch writer close failure", options);
	}
}

/**
 * Injectable dispatcher for the numeric-fd OS close. The default implementation
 * calls `fs.closeSync(fd)`. Tests inject adapters that throw
 * {@link SessionStorageWriterRetryableCloseError} to certify a pre-dispatch
 * failure, or that call the real close and throw to simulate a dispatched
 * failure (`close_unknown`).
 */
export interface SessionStorageWriterCloseAdapter {
	close(fd: number): void;
}

/** Options for opening a {@link SessionStorageWriter}. */
export interface SessionStorageWriterOpenOptions {
	flags?: "a" | "w";
	onError?: (err: Error) => void;
	/** Injectable OS-close dispatcher; defaults to `fs.closeSync`. */
	closeAdapter?: SessionStorageWriterCloseAdapter;
}

export interface SessionStorageWriter {
	writeLine(line: string): Promise<void>;
	/**
	 * Synchronously append a single line. Returns once the bytes are handed to the kernel
	 * (page cache), so the data survives a non-graceful process death (OOM, SIGKILL, etc.)
	 * even though it has not yet been fsynced to the underlying disk.
	 *
	 * `line` MUST already include the trailing newline. Throws synchronously on I/O error.
	 */
	writeLineSync(line: string): void;
	flush(): Promise<void>;
	fsync(): Promise<void>;
	close(): Promise<void>;
	/**
	 * Synchronously close the underlying descriptor. The certainty-aware close
	 * state is updated synchronously and any close failure throws before this
	 * returns, so sync callers (atomic rewrite) can observe a close failure
	 * before proceeding to rename. Mirrors {@link close} semantics exactly.
	 */
	closeSync(): void;
	getError(): Error | undefined;
	/** Current certainty-aware close lifecycle state. */
	getCloseState(): SessionStorageWriterCloseState;
	/** Stored error for non-success close states (`close_failed_retryable`/`close_unknown`). */
	getCloseError(): Error | undefined;
}

export interface SessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	writeTextSync(path: string, content: string): void;
	readTextSync(path: string): string;
	/** Exact on-disk bytes for strict read-only session inspection. */
	readBytesSync?(path: string): Uint8Array;
	/** Exact bytes and descriptor-bound identity captured from one opened regular file. */
	readSnapshotSync?(path: string): SessionStorageSnapshot;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];
	/**
	 * Strict directory scan that never suppresses scan/root errors. Used by strict
	 * authorization inventory; the forgiving {@link listFilesSync} stays display-only.
	 */
	listFilesStrictSync?(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	readTextPrefix(path: string, maxBytes: number): Promise<string>;
	writeText(path: string, content: string): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	renameSync(path: string, nextPath: string): void;
	unlink(path: string): Promise<void>;
	unlinkSync(path: string): void;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	/**
	 * Verified hard delete bound to exact identity evidence. Removes the verified
	 * artifact directory first, revalidates, and unlinks the transcript last. Returns
	 * typed partial-cleanup evidence for exact-identity retry; never returns success
	 * for a partial deletion.
	 */
	deleteSessionVerified?(target: VerifiedSessionDeleteTarget): Promise<VerifiedSessionDeleteResult>;
	openWriter(path: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter;
}

// =============================================================================
// Verified hard-delete identity + typed partial-cleanup evidence
// =============================================================================

/** Exact authorization evidence for a transcript or artifact path. */
export interface SessionStorageFileIdentity {
	dev: bigint;
	ino: bigint;
	size: number;
	mtimeNs: bigint;
	sha256: string;
}

/** Kind of verification failure surfaced by {@link deleteSessionVerified}. */
export type VerifiedDeleteFailureKind =
	| "containment"
	| "symlink"
	| "stat"
	| "identity"
	| "header"
	| "cwd"
	| "artifacts";

/**
 * Thrown by {@link deleteSessionVerified} when canonical containment, transcript
 * non-symlink/identity, header id/cwd, parent identity, or artifact identity
 * verification fails. These are visible, sanitized failures: they never mutate
 * the transcript or artifacts and grant zero authority.
 */
export class SessionDeleteVerificationError extends Error {
	readonly kind: VerifiedDeleteFailureKind;
	constructor(kind: VerifiedDeleteFailureKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionDeleteVerificationError";
		this.kind = kind;
	}
}

/**
 * Exact identity evidence a verified hard delete binds to. All fields are captured
 * at authorization time; delete revalidates each one before any mutation. Retry
 * after a partial cleanup supplies the recorded artifact identity via
 * {@link expectedArtifactsIdentity}.
 */
export interface VerifiedSessionDeleteTarget {
	/** Canonical sessions root; the transcript must be contained within it. */
	sessionsRoot: string;
	/** Canonical transcript path (absolute `*.jsonl`). */
	transcriptPath: string;
	/** Expected session id parsed from the header. */
	sessionId: string;
	/** Expected canonical cwd parsed from the header. */
	cwd: string;
	/** Expected transcript file `(dev, ino)` captured at authorization. */
	transcriptIdentity: SessionStorageFileIdentity;
	/**
	 * For retry after an `artifacts` `cleanup_pending`: the recorded artifact
	 * directory identity to re-accept. A replacement/different artifact directory
	 * fails closed. Omit on first attempt or to accept recorded absence.
	 */
	expectedArtifactsIdentity?: SessionStorageFileIdentity;
	/** Stable native recursive-tree evidence captured before artifact detachment. */
	expectedArtifactsTree?: NativeDirectoryTreeSnapshot;
	/** Identity-bound quarantine path retained when recursive artifact cleanup failed. */
	detachedArtifactsPath?: string;
	/** Identity-bound quarantine path retained when transcript unlink deferred cleanup. */
	detachedTranscriptPath?: string;
	/** Caller-published, no-replace quarantine pathname for the next artifact detach. */
	plannedArtifactsPath?: string;
	/** Caller-published, no-replace quarantine pathname for the next transcript detach. */
	plannedTranscriptPath?: string;
	/** Set only after a durable caller receipt records successful artifact removal. */
	artifactsRemoved?: true;
}

/**
 * Outcome of a verified hard delete. Artifact removal happens first; only after
 * revalidation is the transcript unlinked last. A partial deletion returns
 * `cleanup_pending` with exact evidence for same-connection retry — never
 * `deleted` and never `{}`.
 */
export type VerifiedSessionDeleteResult =
	| { kind: "artifacts_removed"; phase: "artifacts"; transcriptIdentity: SessionStorageFileIdentity }
	| { kind: "deleted" }
	| {
			kind: "cleanup_pending";
			phase: "artifacts";
			error: Error;
			/** Artifact directory identity at failure time; undefined when absent. */
			artifactsIdentity: SessionStorageFileIdentity | undefined;
			/** Identity-bound quarantine path retained when recursive cleanup failed. */
			detachedArtifactsPath: string;
			/** Native snapshot required for an identity-bound recursive retry. */
			artifactsTree: NativeDirectoryTreeSnapshot;
			/** Transcript identity (unchanged) for retry binding. */
			transcriptIdentity: SessionStorageFileIdentity;
	  }
	| {
			kind: "cleanup_pending";
			phase: "transcript";
			error: Error;
			/** Transcript identity at failure time for retry binding. */
			transcriptIdentity: SessionStorageFileIdentity;
			/** Optional identity-bound transcript quarantine path for restart cleanup. */
			detachedTranscriptPath?: string;
	  };

/** Default OS-close dispatcher: a direct `fs.closeSync`. */
const defaultCloseAdapter: SessionStorageWriterCloseAdapter = {
	close(fd: number): void {
		fs.closeSync(fd);
	},
};

type NativeSecurity = { ok: true } | { ok: false; code: string };

type NativeExactUnlinkResult = { ok: true; detachedPath?: string } | { ok: false; code: string; detachedPath?: string };
type NativeExactUnlink = (
	path: string,
	identity: {
		dev: bigint;
		ino: bigint;
		size: bigint;
		mtimeNs: bigint;
		/** Required for regular-file deletion; directories are identity-bound only. */
		sha256?: string;
		directory?: boolean;
		/** Optional caller-planned no-replace quarantine destination component. */
		quarantineName?: string;
	},
) => NativeExactUnlinkResult;

function nativeExactUnlink(
	pathname: string,
	identity: {
		dev: bigint;
		ino: bigint;
		size: bigint;
		mtimeNs: bigint;
		/** Required for regular-file deletion; directories are identity-bound only. */
		sha256?: string;
		directory?: boolean;
		quarantineName?: string;
	},
): NativeExactUnlinkResult {
	return (native.exactUnlink as unknown as NativeExactUnlink)(pathname, identity);
}

type NativeDirectoryTreeEntry = {
	relativePath: string;
	kind: string;
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
	sha256?: string;
};
export type NativeDirectoryTreeSnapshot = {
	rootDev: string;
	rootIno: string;
	entries: NativeDirectoryTreeEntry[];
};
type NativeDirectoryTreeResult =
	| { ok: true; snapshot: NativeDirectoryTreeSnapshot }
	| { ok: false; code: string; snapshot?: undefined };
type NativeDirectoryTreeApi = {
	snapshotDirectoryTree(pathname: string): NativeDirectoryTreeResult;
	exactRemoveDirectoryTree(pathname: string, snapshot: NativeDirectoryTreeSnapshot): NativeExactUnlinkResult;
};
function nativeDirectoryTreeApi(): NativeDirectoryTreeApi {
	return native as unknown as NativeDirectoryTreeApi;
}
function snapshotDirectoryTree(pathname: string): NativeDirectoryTreeSnapshot {
	const result = nativeDirectoryTreeApi().snapshotDirectoryTree(pathname);
	if (!result.ok || !result.snapshot)
		throw new SessionDeleteVerificationError(
			"artifacts",
			`Native artifact snapshot rejected: ${result.ok ? "missing_snapshot" : result.code}`,
		);
	return result.snapshot;
}
function removeDirectoryTreeExact(pathname: string, snapshot: NativeDirectoryTreeSnapshot): NativeExactUnlinkResult {
	return nativeDirectoryTreeApi().exactRemoveDirectoryTree(pathname, snapshot);
}

function exactUnlinkFailure(result: NativeExactUnlinkResult): SessionDeleteVerificationError {
	if (result.ok) throw new Error("Expected exact unlink failure");
	const kind: VerifiedDeleteFailureKind =
		result.code === "reparse_point" || result.code === "not_regular_file"
			? "symlink"
			: result.code === "identity_mismatch"
				? "identity"
				: "stat";
	return new SessionDeleteVerificationError(kind, `Exact transcript deletion rejected: ${result.code}`);
}
function secureOwnerOnlyFile(pathname: string): void {
	const applied = native.applyOwnerOnlyPathSecurity(pathname, "file") as NativeSecurity;
	if (!applied.ok) throw new Error(`Owner-only security rejected ${pathname}: ${applied.code}`);
	const verified = native.verifyOwnerOnlyPathSecurity(pathname, "file") as NativeSecurity;
	if (!verified.ok) throw new Error(`Owner-only security rejected ${pathname}: ${verified.code}`);
}

/** Reject a symlink/junction/reparse component before a storage path is created or opened. */
function assertNoReparsePath(pathname: string): void {
	const resolved = path.resolve(pathname);
	const parsed = path.parse(resolved);
	let current = parsed.root;
	for (const part of resolved.slice(parsed.root.length).split(path.sep)) {
		if (!part) continue;
		current = path.join(current, part);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe reparse storage path: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

// FinalizationRegistry to clean up leaked file descriptors
const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Ignore - fd may already be closed or invalid
	}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	#closeState: SessionStorageWriterCloseState = "open";
	#closeError: Error | undefined;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;
	#closeAdapter: SessionStorageWriterCloseAdapter;

	constructor(fpath: string, options?: SessionStorageWriterOpenOptions) {
		this.#onError = options?.onError;
		this.#closeAdapter = options?.closeAdapter ?? defaultCloseAdapter;
		const flags = options?.flags ?? "a";
		const dir = path.dirname(fpath);
		assertNoReparsePath(dir);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		assertNoReparsePath(dir);
		assertNoReparsePath(fpath);
		// The creation mode prevents a POSIX exposure before the native verifier runs.
		const openFlags =
			(flags === "w"
				? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
				: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND) | (fs.constants.O_NOFOLLOW ?? 0);
		const fd = fs.openSync(fpath, openFlags, 0o600);
		try {
			// Do not rely on directory inheritance: secure and verify every file independently.
			secureOwnerOnlyFile(fpath);
		} catch (error) {
			fs.closeSync(fd);
			throw error;
		}
		this.#fd = fd;
		writerRegistry.register(this, this.#fd, this);
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	/** Deterministic error for any non-open state: writes/flush reject without append/reopen. */
	#nonOpenWriteError(): Error {
		switch (this.#closeState) {
			case "closed":
				return new Error("Writer closed");
			case "close_unknown":
				return this.#closeError ?? new Error("Writer close outcome is unknown; descriptor quarantined");
			case "close_failed_retryable":
				return this.#closeError ?? new Error("Writer close failed before dispatch (retryable); writes rejected");
			default:
				return new Error("Writer closed");
		}
	}

	writeLineSync(line: string): void {
		if (this.#closeState !== "open") throw this.#nonOpenWriteError();
		if (this.#error) throw this.#error;
		try {
			const buf = Buffer.from(line, "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async writeLine(line: string): Promise<void> {
		this.writeLineSync(line);
	}

	async flush(): Promise<void> {
		if (this.#closeState !== "open") throw this.#nonOpenWriteError();
		if (this.#error) throw this.#error;
		// OS buffers are flushed on fsync, nothing to do here
	}

	async fsync(): Promise<void> {
		if (this.#closeState !== "open") throw this.#nonOpenWriteError();
		if (this.#error) throw this.#error;
		try {
			fs.fsyncSync(this.#fd);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	closeSync(): void {
		// Repeated close after success is a harmless idempotent no-op.
		if (this.#closeState === "closed") return;
		// Dispatched close already threw: outcome is uncertain. Never dispatch OS close
		// for this numeric fd again; surface the stored non-quiescent error.
		if (this.#closeState === "close_unknown") throw this.#closeError!;
		// State is "open" or "close_failed_retryable": a close may be dispatched.
		try {
			this.#closeAdapter.close(this.#fd);
		} catch (err) {
			if (err instanceof SessionStorageWriterRetryableCloseError) {
				// Certified pre-dispatch failure: no OS close ran, ownership remains proven.
				// Keep the FinalizationRegistry registration so an abandoned retryable writer
				// can still be finalizer-closed.
				this.#closeState = "close_failed_retryable";
				this.#closeError = toError(err);
				throw this.#closeError;
			}
			// An actual close was dispatched then threw (or the adapter threw after
			// dispatching): ownership/outcome of the numeric fd is uncertain. Quarantine
			// the fd and suppress finalizer close so a reused fd is never closed twice.
			this.#closeState = "close_unknown";
			this.#closeError = toError(err);
			writerRegistry.unregister(this);
			throw this.#closeError;
		}
		// Successful underlying close confirms closed.
		this.#closeState = "closed";
		this.#closeError = undefined;
		writerRegistry.unregister(this);
	}

	async close(): Promise<void> {
		// The synchronous dispatch above has no internal await; delegating keeps the
		// async and sync close contracts observationally identical.
		this.closeSync();
	}

	getError(): Error | undefined {
		return this.#error;
	}

	getCloseState(): SessionStorageWriterCloseState {
		return this.#closeState;
	}

	getCloseError(): Error | undefined {
		return this.#closeError;
	}
}

export class FileSessionStorage implements SessionStorage {
	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	writeTextSync(fpath: string, content: string): void {
		this.ensureDirSync(path.dirname(fpath));
		fs.writeFileSync(fpath, content);
	}

	readTextSync(fpath: string): string {
		return fs.readFileSync(fpath, "utf-8");
	}

	readBytesSync(fpath: string): Uint8Array {
		return this.readSnapshotSync(fpath).bytes;
	}

	readSnapshotSync(fpath: string): SessionStorageSnapshot {
		const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
		const fd = fs.openSync(fpath, flags);
		try {
			const stat = statFromNode(fs.fstatSync(fd, { bigint: true }));

			if (!stat.isFile) throw new Error(`Not a regular file: ${fpath}`);
			return { bytes: fs.readFileSync(fd), stat };
		} finally {
			fs.closeSync(fd);
		}
	}

	statSync(path: string): SessionStorageStat {
		return statFromNode(fs.statSync(path, { bigint: true }));
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	}

	listFilesStrictSync(dir: string, pattern: string): string[] {
		// Strict: never suppress scan/root errors. Authorization inventory depends on
		// a complete enumeration; a swallowed error here would grant partial authority.
		return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	async readTextPrefix(path: string, maxBytes: number): Promise<string> {
		return peekFile(path, maxBytes, header => utf8Decoder.decode(header));
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	renameSync(path: string, nextPath: string): void {
		try {
			fs.renameSync(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	unlinkSync(path: string): void {
		fs.unlinkSync(path);
	}

	openWriter(path: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		return new FileSessionStorageWriter(path, options);
	}

	/**
	 * Delete a session and sibling artifacts in an operator-selected explicit directory.
	 * Default managed roots use deleteSessionVerified and never call this path.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		try {
			await this.unlink(sessionPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const artifactsDir = sessionPath.slice(0, -6);
		try {
			await fs.promises.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}
	/**
	 * Verified hard delete bound to exact identity evidence. Artifact directory first,
	 * revalidate, transcript last. Partial deletion returns typed cleanup_pending
	 * evidence; identity/symlink/containment/header/cwd mismatch throws.
	 */
	async deleteSessionVerified(target: VerifiedSessionDeleteTarget): Promise<VerifiedSessionDeleteResult> {
		const {
			sessionsRoot,
			transcriptPath,
			sessionId,
			cwd,
			transcriptIdentity,
			expectedArtifactsIdentity,
			expectedArtifactsTree,
			detachedArtifactsPath,
			detachedTranscriptPath,
			plannedArtifactsPath,
			plannedTranscriptPath,
			artifactsRemoved,
		} = target;
		try {
			assertNoReparsePath(sessionsRoot);
			assertNoReparsePath(transcriptPath);
		} catch (err) {
			throw new SessionDeleteVerificationError("symlink", "Sessions root or transcript path is a symlink", {
				cause: toError(err),
			});
		}
		if (!transcriptPath.endsWith(".jsonl")) {
			throw new SessionDeleteVerificationError("containment", "Transcript path is not a .jsonl file");
		}
		if (!pathIsWithin(sessionsRoot, transcriptPath)) {
			throw new SessionDeleteVerificationError("containment", "Transcript is outside the sessions root");
		}
		if (
			!plannedArtifactsPath ||
			!plannedTranscriptPath ||
			path.dirname(plannedArtifactsPath) !== path.dirname(transcriptPath) ||
			path.dirname(plannedTranscriptPath) !== path.dirname(transcriptPath) ||
			!path.basename(plannedArtifactsPath).startsWith(".gjc-delete-") ||
			!path.basename(plannedTranscriptPath).startsWith(".gjc-delete-") ||
			plannedArtifactsPath === plannedTranscriptPath
		) {
			throw new SessionDeleteVerificationError(
				"artifacts",
				"Verified deletion requires caller-persisted quarantine paths",
			);
		}
		const cleanupTranscriptPath = detachedTranscriptPath ?? transcriptPath;
		const hasDetachedTranscript = detachedTranscriptPath !== undefined;
		if (
			detachedTranscriptPath &&
			(path.dirname(detachedTranscriptPath) !== path.dirname(transcriptPath) ||
				!path.basename(detachedTranscriptPath).startsWith(".gjc-delete-") ||
				detachedTranscriptPath === plannedTranscriptPath)
		) {
			throw new SessionDeleteVerificationError(
				"identity",
				"Detached transcript retry requires a fresh quarantine destination",
			);
		}
		if (hasDetachedTranscript && fs.existsSync(transcriptPath)) {
			throw new SessionDeleteVerificationError(
				"identity",
				"Original transcript pathname became occupied during detached cleanup replay",
			);
		}
		const artifactRemovalRoot = `${plannedArtifactsPath}.removing`;
		if (detachedArtifactsPath === plannedArtifactsPath) {
			throw new SessionDeleteVerificationError(
				"artifacts",
				"Detached artifact retry requires a fresh quarantine destination",
			);
		}
		const retainedArtifactRoot = (input: string): string =>
			input.endsWith(".removing") ? input : `${input}.removing`;

		const initial = hasDetachedTranscript ? undefined : this.#verifiedReadAndHeader(transcriptPath, sessionId, cwd);
		const initialStat = initial?.snapshot.stat;
		const initialDigest = initial ? createHash("sha256").update(initial.snapshot.bytes).digest("hex") : undefined;
		if (
			initialStat &&
			(initialStat.dev !== transcriptIdentity.dev ||
				initialStat.ino !== transcriptIdentity.ino ||
				initialStat.size !== transcriptIdentity.size ||
				initialStat.mtimeNs !== transcriptIdentity.mtimeNs ||
				initialDigest !== transcriptIdentity.sha256)
		) {
			throw new SessionDeleteVerificationError("identity", "Transcript identity does not match authorization");
		}

		const parentIdentity = this.#directoryIdentity(path.dirname(transcriptPath));
		if (detachedArtifactsPath) {
			if (
				!expectedArtifactsIdentity ||
				path.dirname(detachedArtifactsPath) !== path.dirname(transcriptPath) ||
				!path.basename(detachedArtifactsPath).startsWith(".gjc-delete-")
			) {
				throw new SessionDeleteVerificationError("artifacts", "Detached artifact cleanup evidence is invalid");
			}
			const detachedIdentity = this.#optionalDirectoryIdentity(detachedArtifactsPath);
			if (
				!detachedIdentity ||
				detachedIdentity.dev !== expectedArtifactsIdentity.dev ||
				detachedIdentity.ino !== expectedArtifactsIdentity.ino
			) {
				throw new SessionDeleteVerificationError("artifacts", "Detached artifact identity changed before retry");
			}
			if (!expectedArtifactsTree)
				throw new SessionDeleteVerificationError(
					"artifacts",
					"Detached artifact cleanup requires a persisted tree snapshot",
				);
			const removal = removeDirectoryTreeExact(detachedArtifactsPath, expectedArtifactsTree);
			if (!removal.ok) {
				const retainedRoot = removal.detachedPath ?? detachedArtifactsPath;
				if (retainedRoot !== detachedArtifactsPath && retainedRoot !== retainedArtifactRoot(detachedArtifactsPath))
					throw new SessionDeleteVerificationError(
						"artifacts",
						"Native artifact removal returned an unauthorized root",
					);
				return {
					kind: "cleanup_pending",
					phase: "artifacts",
					error: new SessionDeleteVerificationError(
						"artifacts",
						`Exact detached artifact removal rejected: ${removal.code}`,
					),
					artifactsIdentity: expectedArtifactsIdentity,
					detachedArtifactsPath: retainedRoot,
					artifactsTree: expectedArtifactsTree,
					transcriptIdentity,
				};
			}
		}

		if (artifactsRemoved && (detachedArtifactsPath || expectedArtifactsIdentity)) {
			throw new SessionDeleteVerificationError(
				"artifacts",
				"Artifact phase receipt conflicts with pending artifact cleanup",
			);
		}
		const artifactsDir = transcriptPath.slice(0, -6);
		const artifactsIdentity = this.#optionalDirectoryIdentity(artifactsDir);
		if (artifactsRemoved && artifactsIdentity) {
			throw new SessionDeleteVerificationError(
				"artifacts",
				"Artifact path reappeared after durable artifact-phase completion",
			);
		}
		if (!artifactsIdentity && expectedArtifactsIdentity && !detachedArtifactsPath && !artifactsRemoved) {
			// Absence at the original path alone is not completion: native recursive removal
			// may retain the planned root or its deterministic `.removing` final-stage root.
			if (fs.existsSync(plannedArtifactsPath) || fs.existsSync(artifactRemovalRoot))
				throw new SessionDeleteVerificationError(
					"artifacts",
					"Authorized artifact removal root remains after restart",
				);
			return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity };
		}

		if (artifactsIdentity && !artifactsRemoved) {
			if (
				expectedArtifactsIdentity &&
				(artifactsIdentity.dev !== expectedArtifactsIdentity.dev ||
					artifactsIdentity.ino !== expectedArtifactsIdentity.ino ||
					artifactsIdentity.size !== expectedArtifactsIdentity.size ||
					artifactsIdentity.mtimeNs !== expectedArtifactsIdentity.mtimeNs ||
					artifactsIdentity.sha256 !== expectedArtifactsIdentity.sha256)
			) {
				throw new SessionDeleteVerificationError(
					"artifacts",
					"Artifact directory identity does not match recorded cleanup evidence",
				);
			}
			const artifactStat = fs.lstatSync(artifactsDir, { bigint: true });
			if (
				artifactStat.isSymbolicLink() ||
				!artifactStat.isDirectory() ||
				artifactStat.dev !== artifactsIdentity.dev ||
				artifactStat.ino !== artifactsIdentity.ino
			) {
				throw new SessionDeleteVerificationError("artifacts", "Artifact directory changed before deletion");
			}
			const observedArtifactsTree = snapshotDirectoryTree(artifactsDir);
			if (expectedArtifactsTree && JSON.stringify(observedArtifactsTree) !== JSON.stringify(expectedArtifactsTree))
				throw new SessionDeleteVerificationError("artifacts", "Artifact tree changed before root detach");
			const artifactsTree = expectedArtifactsTree ?? observedArtifactsTree;
			const detach = nativeExactUnlink(artifactsDir, {
				dev: artifactStat.dev,
				ino: artifactStat.ino,
				size: artifactStat.size,
				mtimeNs: artifactStat.mtimeNs,
				directory: true,
				quarantineName: path.basename(plannedArtifactsPath),
			});
			if (!detach.ok || !detach.detachedPath) {
				throw new SessionDeleteVerificationError(
					"artifacts",
					`Exact artifact detach rejected: ${detach.ok ? "missing_path" : detach.code}`,
				);
			}
			const removal = removeDirectoryTreeExact(detach.detachedPath, artifactsTree);
			if (!removal.ok) {
				const retainedRoot = removal.detachedPath ?? detach.detachedPath;
				if (retainedRoot !== detach.detachedPath && retainedRoot !== retainedArtifactRoot(detach.detachedPath))
					throw new SessionDeleteVerificationError(
						"artifacts",
						"Native artifact removal returned an unauthorized root",
					);
				return {
					kind: "cleanup_pending",
					phase: "artifacts",
					error: new SessionDeleteVerificationError(
						"artifacts",
						`Exact detached artifact removal rejected: ${removal.code}`,
					),
					artifactsIdentity,
					detachedArtifactsPath: retainedRoot,
					artifactsTree,
					transcriptIdentity,
				};
			}
		}
		if (!artifactsRemoved) {
			if (process.platform !== "win32") {
				let descriptor: number | undefined;
				try {
					descriptor = fs.openSync(
						path.dirname(transcriptPath),
						fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
					);
					const durableParent = fs.fstatSync(descriptor, { bigint: true });
					if (
						!durableParent.isDirectory() ||
						durableParent.dev !== parentIdentity.dev ||
						durableParent.ino !== parentIdentity.ino
					)
						throw new Error("parent_changed");
					fs.fsyncSync(descriptor);
				} catch (error) {
					throw new SessionDeleteVerificationError("artifacts", "durability_failed", { cause: toError(error) });
				} finally {
					if (descriptor !== undefined) fs.closeSync(descriptor);
				}
			}
			return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity };
		}
		if (hasDetachedTranscript) {
			const deletion = nativeExactUnlink(cleanupTranscriptPath, {
				dev: transcriptIdentity.dev,
				ino: transcriptIdentity.ino,
				size: BigInt(transcriptIdentity.size),
				mtimeNs: transcriptIdentity.mtimeNs,
				sha256: transcriptIdentity.sha256,
				quarantineName: path.basename(plannedTranscriptPath),
			});
			if (!deletion.ok) {
				const error = exactUnlinkFailure(deletion);
				if (error.kind === "identity" || error.kind === "symlink") throw error;
				return {
					kind: "cleanup_pending",
					phase: "transcript",
					error,
					transcriptIdentity,
					detachedTranscriptPath: deletion.detachedPath ?? detachedTranscriptPath,
				};
			}
			return { kind: "deleted" };
		}
		if (!initialStat || !initialDigest)
			throw new SessionDeleteVerificationError("stat", "Transcript cleanup state is invalid");
		const revalidate = this.#verifiedReadAndHeader(transcriptPath, sessionId, cwd);
		const revalidateStat = revalidate.snapshot.stat;
		const revalidateDigest = createHash("sha256").update(revalidate.snapshot.bytes).digest("hex");
		if (
			revalidateStat.dev !== initialStat.dev ||
			revalidateStat.ino !== initialStat.ino ||
			revalidateStat.size !== initialStat.size ||
			revalidateStat.mtimeNs !== initialStat.mtimeNs ||
			revalidateDigest !== initialDigest
		) {
			throw new SessionDeleteVerificationError(
				"identity",
				"Transcript identity changed after artifact removal (replacement detected)",
			);
		}

		const parentIdentityNow = this.#directoryIdentity(path.dirname(transcriptPath));
		if (parentIdentityNow.dev !== parentIdentity.dev || parentIdentityNow.ino !== parentIdentity.ino) {
			throw new SessionDeleteVerificationError("identity", "Parent directory identity changed during deletion");
		}

		this.#assertPathMatchesSnapshot(transcriptPath, revalidate.snapshot);
		if (!Number.isSafeInteger(revalidateStat.size) || revalidateStat.size < 0) {
			throw new SessionDeleteVerificationError("identity", "Transcript size cannot be bound exactly for deletion");
		}
		const deletion = nativeExactUnlink(transcriptPath, {
			dev: initialStat.dev,
			ino: initialStat.ino,
			size: BigInt(initialStat.size),
			mtimeNs: initialStat.mtimeNs,
			sha256: initialDigest,
			quarantineName: path.basename(plannedTranscriptPath),
		});
		if (!deletion.ok) {
			const error = exactUnlinkFailure(deletion);
			if (error.kind === "identity" || error.kind === "symlink") throw error;
			return {
				kind: "cleanup_pending",
				phase: "transcript",
				error,
				transcriptIdentity,
				detachedTranscriptPath: deletion.detachedPath,
			};
		}
		return { kind: "deleted" };
	}

	#verifiedReadAndHeader(
		transcriptPath: string,
		expectedSessionId: string,
		expectedCwd: string,
	): { snapshot: SessionStorageSnapshot } {
		let snapshot: SessionStorageSnapshot;
		try {
			snapshot = this.readSnapshotSync(transcriptPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "ELOOP" || code === "SYMLINK") {
				throw new SessionDeleteVerificationError("symlink", "Transcript path is a symlink");
			}
			throw new SessionDeleteVerificationError("stat", "Transcript could not be opened or read", {
				cause: toError(err),
			});
		}
		if (!snapshot.stat.isFile) {
			throw new SessionDeleteVerificationError("symlink", "Transcript is not a regular file");
		}
		const header = parseFirstJsonlLine(snapshot.bytes);
		if (!header) {
			throw new SessionDeleteVerificationError("header", "Transcript header is missing or unreadable");
		}
		if (header.type !== "session" || typeof header.id !== "string") {
			throw new SessionDeleteVerificationError("header", "Transcript header is not a valid session header");
		}
		if (header.id !== expectedSessionId) {
			throw new SessionDeleteVerificationError("identity", "Transcript header id does not match authorization");
		}
		if (typeof header.cwd !== "string") {
			throw new SessionDeleteVerificationError("cwd", "Transcript header is missing a cwd");
		}
		if (canonicalPathSync(header.cwd) !== canonicalPathSync(expectedCwd)) {
			throw new SessionDeleteVerificationError("cwd", "Transcript header cwd does not match authorization");
		}
		return { snapshot };
	}

	#assertPathMatchesSnapshot(transcriptPath: string, snapshot: SessionStorageSnapshot): void {
		let named: fs.BigIntStats;
		try {
			named = fs.lstatSync(transcriptPath, { bigint: true });
		} catch (err) {
			throw new SessionDeleteVerificationError("stat", "Transcript path could not be revalidated", {
				cause: toError(err),
			});
		}
		if (
			named.isSymbolicLink() ||
			!named.isFile() ||
			named.dev !== snapshot.stat.dev ||
			named.ino !== snapshot.stat.ino ||
			Number(named.size) !== snapshot.stat.size ||
			named.mtimeNs !== snapshot.stat.mtimeNs
		) {
			throw new SessionDeleteVerificationError("identity", "Transcript path changed before deletion");
		}
	}

	#directoryIdentity(dirPath: string): SessionStorageFileIdentity {
		let stat: fs.BigIntStats;
		try {
			stat = fs.lstatSync(dirPath, { bigint: true });
		} catch (err) {
			throw new SessionDeleteVerificationError("stat", "Directory could not be inspected", { cause: toError(err) });
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new SessionDeleteVerificationError("symlink", "Directory is a symlink or not a directory");
		}
		return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, sha256: "" };
	}

	#optionalDirectoryIdentity(dirPath: string): SessionStorageFileIdentity | undefined {
		let stat: fs.BigIntStats;
		try {
			stat = fs.lstatSync(dirPath, { bigint: true });
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw new SessionDeleteVerificationError("artifacts", "Artifact directory could not be inspected", {
				cause: toError(err),
			});
		}
		if (stat.isSymbolicLink()) {
			throw new SessionDeleteVerificationError("symlink", "Artifact directory is a symlink");
		}
		if (!stat.isDirectory()) {
			// A non-directory artifact sibling (regular file, socket, device, ...) must
			// not be silently treated as an absent artifacts directory: doing so would
			// let the verified delete report success while a foreign artifact remains.
			// Fail closed before any mutation.
			throw new SessionDeleteVerificationError("artifacts", "Artifact path exists but is not a directory");
		}
		return { dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, sha256: "" };
	}
}

/** Parse the first JSONL line as a generic record; returns undefined on parse failure. */
function parseFirstJsonlLine(bytes: Uint8Array): Record<string, unknown> | undefined {
	const NL = 0x0a;
	const end = bytes.indexOf(NL);
	const firstLine = end === -1 ? bytes : bytes.subarray(0, end);
	if (firstLine.length === 0) return undefined;
	try {
		const text = utf8Decoder.decode(firstLine).trim();
		if (!text) return undefined;
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closeState: SessionStorageWriterCloseState = "open";
	#closeError: Error | undefined;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	#closeAdapter: SessionStorageWriterCloseAdapter | undefined;

	constructor(storage: MemorySessionStorage, path: string, options?: SessionStorageWriterOpenOptions) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		this.#closeAdapter = options?.closeAdapter;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	writeLineSync(line: string): void {
		if (this.#closeState !== "open") throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			const existing = this.#storage.existsSync(this.#path) ? this.#storage.readTextSync(this.#path) : "";
			this.#storage.writeTextSync(this.#path, `${existing}${line}`);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async writeLine(line: string): Promise<void> {
		this.writeLineSync(line);
	}

	async flush(): Promise<void> {
		if (this.#closeState !== "open") throw new Error("Writer closed");
		if (this.#error) throw this.#error;
	}

	async fsync(): Promise<void> {
		// No-op for in-memory storage
		if (this.#closeState !== "open") throw new Error("Writer closed");
		if (this.#error) throw this.#error;
	}

	closeSync(): void {
		// In-memory close has no numeric fd. When a close adapter is injected it
		// controls the certainty-aware lifecycle (used to exercise retryable /
		// quarantined close paths end-to-end); without one the close always
		// succeeds. The sentinel fd (-1) signals "no real descriptor".
		if (this.#closeState === "closed") return;
		if (this.#closeState === "close_unknown") throw this.#closeError!;
		if (this.#closeAdapter) {
			try {
				this.#closeAdapter.close(-1);
			} catch (err) {
				if (err instanceof SessionStorageWriterRetryableCloseError) {
					this.#closeState = "close_failed_retryable";
					this.#closeError = toError(err);
					throw this.#closeError;
				}
				this.#closeState = "close_unknown";
				this.#closeError = toError(err);
				throw this.#closeError;
			}
		}
		this.#closeState = "closed";
		this.#closeError = undefined;
	}

	async close(): Promise<void> {
		this.closeSync();
	}

	getError(): Error | undefined {
		return this.#error;
	}

	getCloseState(): SessionStorageWriterCloseState {
		return this.#closeState;
	}

	getCloseError(): Error | undefined {
		return this.#closeError;
	}
}

export class MemorySessionStorage implements SessionStorage {
	#files = new Map<string, { content: Buffer; mtimeMs: number; ino: bigint }>();
	#nextInode = 1n;

	#statFor(entry: { content: Buffer; mtimeMs: number; ino: bigint }): SessionStorageStat {
		return {
			dev: 0n,
			ino: entry.ino,
			size: entry.content.byteLength,
			mtimeMs: entry.mtimeMs,
			mtimeNs: BigInt(entry.mtimeMs) * 1_000_000n,
			mtime: new Date(entry.mtimeMs),
			isFile: true,
		};
	}

	ensureDirSync(_dir: string): void {
		// No-op for in-memory storage.
	}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string): void {
		const existing = this.#files.get(path);
		this.#files.set(path, {
			content: Buffer.from(content, "utf-8"),
			mtimeMs: Date.now(),
			ino: existing?.ino ?? this.#nextInode++,
		});
	}

	readTextSync(path: string): string {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry.content.toString("utf-8");
	}

	readBytesSync(path: string): Uint8Array {
		return this.readSnapshotSync(path).bytes;
	}

	readSnapshotSync(path: string): SessionStorageSnapshot {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return { bytes: Buffer.from(entry.content), stat: this.#statFor(entry) };
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return this.#statFor(entry);
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.#files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesPattern(name, pattern)) continue;
			files.push(path);
		}
		return files;
	}
	listFilesStrictSync(dir: string, pattern: string): string[] {
		// In-memory scan never suppresses; identical to the display scan.
		return this.listFilesSync(dir, pattern);
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(entry.content.toString("utf-8"));
	}

	readTextPrefix(path: string, maxBytes: number): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(entry.content.subarray(0, maxBytes).toString("utf-8"));
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	renameSync(path: string, nextPath: string): void {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}

	unlinkSync(path: string): void {
		this.#files.delete(path);
	}

	deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		this.#files.delete(sessionPath);
		return Promise.resolve();
	}

	deleteSessionVerified(target: VerifiedSessionDeleteTarget): Promise<VerifiedSessionDeleteResult> {
		const { sessionsRoot, transcriptPath, sessionId, cwd, transcriptIdentity } = target;
		// Canonical containment: same gate as the file backend so the memory backend
		// cannot grant deletion authority outside the sessions root.
		if (!transcriptPath.endsWith(".jsonl")) {
			return Promise.reject(
				new SessionDeleteVerificationError("containment", "Transcript path is not a .jsonl file"),
			);
		}
		if (!pathIsWithin(sessionsRoot, transcriptPath)) {
			return Promise.reject(
				new SessionDeleteVerificationError("containment", "Transcript is outside the sessions root"),
			);
		}
		const entry = this.#files.get(transcriptPath);
		if (!entry) return Promise.resolve({ kind: "deleted" });
		const snapshot = this.readSnapshotSync(transcriptPath);
		if (snapshot.stat.dev !== transcriptIdentity.dev || snapshot.stat.ino !== transcriptIdentity.ino) {
			return Promise.reject(new SessionDeleteVerificationError("identity", "Transcript identity mismatch"));
		}
		const header = parseFirstJsonlLine(snapshot.bytes);
		if (!header) {
			return Promise.reject(
				new SessionDeleteVerificationError("header", "Transcript header is missing or unreadable"),
			);
		}
		// Require the typed session header exactly like the file backend: a memory
		// backend must not accept a non-session artifact as a deletable transcript.
		if (header.type !== "session" || typeof header.id !== "string") {
			return Promise.reject(
				new SessionDeleteVerificationError("header", "Transcript header is not a valid session header"),
			);
		}
		if (header.id !== sessionId) {
			return Promise.reject(new SessionDeleteVerificationError("identity", "Transcript header id mismatch"));
		}
		if (typeof header.cwd !== "string") {
			return Promise.reject(new SessionDeleteVerificationError("cwd", "Transcript header is missing a cwd"));
		}
		if (path.resolve(header.cwd) !== path.resolve(cwd)) {
			return Promise.reject(new SessionDeleteVerificationError("cwd", "Transcript header cwd mismatch"));
		}
		// Compatible artifact semantics: the memory backend models no directories, so
		// a key at the artifact path is a non-directory sibling that must fail closed
		// rather than be silently treated as an absent artifacts directory.
		const artifactsPath = transcriptPath.slice(0, -6);
		if (artifactsPath !== transcriptPath && this.#files.has(artifactsPath)) {
			return Promise.reject(
				new SessionDeleteVerificationError("artifacts", "Artifact path exists but is not a directory"),
			);
		}
		this.#files.delete(transcriptPath);
		return Promise.resolve({ kind: "deleted" });
	}

	openWriter(path: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
