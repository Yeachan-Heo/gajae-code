import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
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
	/**
	 * Expected stable object identity `{dev, ino}`. When set, the writer opens the
	 * pathname no-follow WITHOUT truncating, fstats the descriptor, and compares
	 * dev/ino before any mutation. A mismatch (pathname replacement, deletion, or
	 * symlink) closes the descriptor and throws before a single byte is written or
	 * truncated. For a full-rewrite (`"w"`) open the validated descriptor is
	 * truncated in place, binding the rewrite to the authorized object rather than a
	 * pathname rename/replacement. Omitted for ordinary sessions, which retain the
	 * existing create/truncate/append semantics over the public pathname.
	 */
	expectedObjectIdentity?: SessionStorageFileIdentity;
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
	 * Verified logical delete bound to exact identity evidence. Removes the verified
	 * artifact directory first, revalidates, and tombstones the transcript through the
	 * retained descriptor last. Returns typed partial-cleanup evidence for exact-identity
	 * retry; never returns success for a partial deletion.
	 */
	deleteSessionVerified?(target: VerifiedSessionDeleteTarget): Promise<VerifiedSessionDeleteResult>;
	openWriter(path: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter;
}

// =============================================================================
// Verified hard-delete identity + typed partial-cleanup evidence
// =============================================================================

/** Exact (dev, ino) identity fields used for ACP authorization binding. */
export interface SessionStorageFileIdentity {
	dev: bigint;
	ino: bigint;
}

/**
 * Full five-field transcript file identity (dev, ino, size, mtimeMs, mtimeNs).
 * Preserved end-to-end from broker validation through {@link deleteSessionVerified};
 * every field is revalidated immediately before the descriptor-bound tombstone effect
 * so an in-place-modified transcript (same dev/ino, changed size/mtime) cannot be deleted.
 */
export interface SessionStorageTranscriptIdentity {
	dev: bigint;
	ino: bigint;
	size: number;
	mtimeMs: number;
	mtimeNs: bigint;
}

/** Kind of verification failure surfaced by {@link deleteSessionVerified}. */
export type VerifiedDeleteFailureKind =
	| "containment"
	| "symlink"
	| "stat"
	| "identity"
	| "header"
	| "cwd"
	| "artifacts"
	| "stale";

/**
 * Thrown by {@link deleteSessionVerified} when canonical containment, transcript
 * non-symlink/identity, header id/cwd, parent identity, or artifact identity
 * verification fails, or when the public name no longer resolves to the authorized
 * descriptor identity after the tombstone effect (`stale`). Failures detected
 * before artifact cleanup mutate neither transcript nor artifacts. Identity drift
 * detected after artifact cleanup leaves the transcript untouched but may leave
 * auxiliary artifacts removed. A `stale` failure means the authorized object was
 * tombstoned through the descriptor while a replacement at the public name
 * survived untouched.
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
 * Sentinel for a pathname that could not be resolved to any object: the file was
 * missing, unopenable, or a symlink, so there is no real {dev, ino} to compare.
 */
const MISSING_OBJECT_IDENTITY: SessionStorageFileIdentity = { dev: -1n, ino: -1n };
/**
 * Thrown when a descriptor-bound persist writer (append or full rewrite) opens a
 * pathname that no longer resolves to the authorized {dev, ino} object. The
 * descriptor is closed before any mutation, so a successor installed at the public
 * pathname is never written or truncated: future persistence fails closed rather
 * than silently adopting a replacement. `actual` is {@link MISSING_OBJECT_IDENTITY}
 * when the pathname could not be opened or stated at all.
 */
export class SessionStorageObjectIdentityError extends Error {
	override readonly name = "SessionStorageObjectIdentityError";
	readonly expected: SessionStorageFileIdentity;
	readonly actual: SessionStorageFileIdentity;
	constructor(
		pathname: string,
		expected: SessionStorageFileIdentity,
		actual: SessionStorageFileIdentity,
		options?: ErrorOptions,
	) {
		super(
			`Persist writer object identity mismatch at ${pathname}: expected {dev:${expected.dev},ino:${expected.ino}}, got {dev:${actual.dev},ino:${actual.ino}}`,
			options,
		);
		this.expected = expected;
		this.actual = actual;
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
	/** Full transcript file identity (dev, ino, size, mtimeMs, mtimeNs) captured at authorization. */
	transcriptIdentity: SessionStorageTranscriptIdentity;
	/**
	 * For retry after an `artifacts` `cleanup_pending`: the recorded artifact
	 * directory identity to re-accept. A replacement/different artifact directory
	 * fails closed. Omit on first attempt or to accept recorded absence.
	 */
	expectedArtifactsIdentity?: SessionStorageFileIdentity;
}

/**
 * Outcome of a verified logical delete. Artifact removal happens first; only after
 * revalidation is the transcript tombstoned through the retained descriptor last
 * (the public pathname is never unlinked). A partial deletion returns
 * `cleanup_pending` with exact evidence for same-connection retry — never
 * `deleted` and never `{}`.
 */
export type VerifiedSessionDeleteResult =
	| { kind: "deleted" }
	| {
			kind: "cleanup_pending";
			phase: "artifacts";
			error: Error;
			/** Artifact directory identity at failure time; undefined when absent. */
			artifactsIdentity: SessionStorageFileIdentity | undefined;
			/** Transcript identity (unchanged) for retry binding. */
			transcriptIdentity: SessionStorageFileIdentity;
	  }
	| {
			kind: "cleanup_pending";
			phase: "transcript";
			error: Error;
			/** Transcript identity at failure time for retry binding. */
			transcriptIdentity: SessionStorageFileIdentity;
	  };

/** Canonical logical-deletion marker written through the authorized descriptor. */
export const SESSION_DELETED_TOMBSTONE_TYPE = "session_deleted";

/**
 * Canonical logical-deletion tombstone. Written through the authorized transcript
 * descriptor (truncate + fsync) in place of the session header: the public
 * transcript pathname is never unlinked, so a path replacement cannot be deleted.
 * Strict inventory recognizes and omits only this exact schema; a malformed
 * lookalike fails closed instead of being treated as deleted.
 */
export interface SessionDeletedTombstone extends Record<string, unknown> {
	type: typeof SESSION_DELETED_TOMBSTONE_TYPE;
	id: string;
	cwd: string;
	deletedAt: string;
}

/** True only for the exact canonical `session_deleted` tombstone schema. */
export function isCanonicalSessionDeletedTombstone(
	header: Record<string, unknown> | undefined,
): header is SessionDeletedTombstone {
	if (!header) return false;
	const keys = Object.keys(header).sort();
	const deletedAt = header.deletedAt;
	return (
		keys.length === 4 &&
		keys[0] === "cwd" &&
		keys[1] === "deletedAt" &&
		keys[2] === "id" &&
		keys[3] === "type" &&
		header.type === SESSION_DELETED_TOMBSTONE_TYPE &&
		typeof header.id === "string" &&
		header.id.length > 0 &&
		typeof header.cwd === "string" &&
		typeof deletedAt === "string" &&
		Number.isFinite(Date.parse(deletedAt))
	);
}

/** Canonical tombstone JSONL line (with trailing newline) for descriptor-bound deletion. */
function sessionDeletedTombstoneLine(sessionId: string, cwd: string): string {
	const tombstone: SessionDeletedTombstone = {
		type: SESSION_DELETED_TOMBSTONE_TYPE,
		id: sessionId,
		cwd,
		deletedAt: new Date().toISOString(),
	};
	return `${JSON.stringify(tombstone)}\n`;
}

/** Default OS-close dispatcher: a direct `fs.closeSync`. */
const defaultCloseAdapter: SessionStorageWriterCloseAdapter = {
	close(fd: number): void {
		fs.closeSync(fd);
	},
};

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
		// Ensure parent directory exists
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Open file once, keep fd for lifetime. A descriptor-bound open (expected
		// object identity set) opens no-follow WITHOUT truncating, validates dev/ino
		// from the descriptor, and only then truncates through it for a full rewrite;
		// a pathname replacement fails closed before any mutation.
		this.#fd = options?.expectedObjectIdentity
			? this.#openBoundDescriptor(fpath, flags, options.expectedObjectIdentity)
			: fs.openSync(fpath, flags === "w" ? "w" : "a");
		// Register for cleanup if abandoned without close()
		writerRegistry.register(this, this.#fd, this);
	}
	/**
	 * Descriptor-bound open used when {@link SessionStorageWriterOpenOptions.expectedObjectIdentity}
	 * is set. Opens the pathname no-follow WITHOUT truncating, fstats the descriptor,
	 * and compares dev/ino to the authorized object before any mutation. A mismatch
	 * (replacement, deletion, symlink, or non-regular file) closes the descriptor and
	 * throws before a byte is written. For a full-rewrite (`"w"`) open the validated
	 * descriptor is truncated in place via `ftruncate`, binding the rewrite to the
	 * authorized inode rather than a pathname rename/replacement.
	 */
	#openBoundDescriptor(fpath: string, flags: "a" | "w", expected: SessionStorageFileIdentity): number {
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		// Open no-follow without truncating. O_APPEND gives append semantics for "a";
		// the "w" path truncates through the validated descriptor via ftruncate after
		// the dev/ino match, never via O_TRUNC.
		const openFlags = (flags === "w" ? fs.constants.O_RDWR : fs.constants.O_RDWR | fs.constants.O_APPEND) | noFollow;
		let fd: number;
		try {
			fd = fs.openSync(fpath, openFlags);
		} catch (err) {
			throw new SessionStorageObjectIdentityError(fpath, expected, MISSING_OBJECT_IDENTITY, {
				cause: toError(err),
			});
		}
		let stat: fs.BigIntStats;
		try {
			stat = fs.fstatSync(fd, { bigint: true });
		} catch (err) {
			try {
				fs.closeSync(fd);
			} catch {
				// Best-effort: we are about to throw the identity mismatch regardless.
			}
			throw new SessionStorageObjectIdentityError(fpath, expected, MISSING_OBJECT_IDENTITY, {
				cause: toError(err),
			});
		}
		const actual: SessionStorageFileIdentity = { dev: stat.dev, ino: stat.ino };
		if (!stat.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
			try {
				fs.closeSync(fd);
			} catch {
				// Best-effort: the mismatch is reported, not the close error.
			}
			throw new SessionStorageObjectIdentityError(fpath, expected, actual);
		}
		if (flags === "w") {
			// Descriptor-bound rewrite: truncate ONLY through the validated descriptor.
			// The inode is preserved; the public pathname is never replaced.
			fs.ftruncateSync(fd, 0);
		}
		return fd;
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
	 * Delete a session file and its artifacts directory.
	 * Artifacts are stored in a sibling directory with the same name minus .jsonl extension.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Delete the session file itself
		await this.unlink(sessionPath);

		// Compute artifacts directory: /path/to/session.jsonl -> /path/to/session
		const artifactsDir = sessionPath.slice(0, -6);

		// Delete artifacts directory if it exists. Missing directories are fine, but
		// surface real cleanup failures because the session file is already gone.
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
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
	 * Verified logical delete bound to exact identity evidence and the authorized
	 * transcript descriptor. Opens the transcript once with no-follow read/write flags,
	 * validates the full five-field identity and header from that descriptor, retains it
	 * through artifact cleanup, revalidates the descriptor, then truncates + fsyncs a
	 * canonical `session_deleted` tombstone through it. The public pathname is never
	 * unlinked; after the effect the public name must still resolve to the authorized
	 * (dev, ino) or a typed `stale` failure is thrown (a replacement survived untouched).
	 */
	async deleteSessionVerified(target: VerifiedSessionDeleteTarget): Promise<VerifiedSessionDeleteResult> {
		const { sessionsRoot, transcriptPath, sessionId, cwd, transcriptIdentity, expectedArtifactsIdentity } = target;
		if (!transcriptPath.endsWith(".jsonl")) {
			throw new SessionDeleteVerificationError("containment", "Transcript path is not a .jsonl file");
		}
		if (!pathIsWithin(sessionsRoot, transcriptPath)) {
			throw new SessionDeleteVerificationError("containment", "Transcript is outside the sessions root");
		}

		// Open the authorized transcript ONCE with no-follow read/write flags and retain
		// the descriptor through validation, artifact cleanup, and the destructive effect.
		// The effect is object-bound to this descriptor's (dev, ino); the public pathname
		// is never unlinked, so a path replacement cannot be deleted.
		const fd = this.#openTranscriptDescriptor(transcriptPath);
		try {
			const initialStat = this.#readHeaderFromDescriptor(fd, sessionId, cwd);
			if (!sameVerifiedTranscriptStat(initialStat, transcriptIdentity)) {
				throw new SessionDeleteVerificationError("identity", "Transcript identity does not match authorization");
			}
			const parentIdentity = this.#directoryIdentity(path.dirname(transcriptPath));

			const artifactsDir = transcriptPath.slice(0, -6);
			const artifactsIdentity = this.#optionalDirectoryIdentity(artifactsDir);
			if (artifactsIdentity) {
				if (
					expectedArtifactsIdentity &&
					(artifactsIdentity.dev !== expectedArtifactsIdentity.dev ||
						artifactsIdentity.ino !== expectedArtifactsIdentity.ino)
				) {
					throw new SessionDeleteVerificationError(
						"artifacts",
						"Artifact directory identity does not match recorded cleanup evidence",
					);
				}
				try {
					await fsp.rm(artifactsDir, { recursive: true, force: true });
				} catch (err) {
					return {
						kind: "cleanup_pending",
						phase: "artifacts",
						error: toError(err),
						artifactsIdentity,
						transcriptIdentity: { dev: initialStat.dev, ino: initialStat.ino },
					};
				}
			}

			// Revalidate the retained descriptor: the bound object must be unchanged.
			const revalidateStat = this.#fstatDescriptor(fd);
			if (!sameVerifiedTranscriptStat(revalidateStat, transcriptIdentity)) {
				throw new SessionDeleteVerificationError(
					"identity",
					"Transcript identity does not match authorization after artifact removal",
				);
			}
			const parentIdentityNow = this.#directoryIdentity(path.dirname(transcriptPath));
			if (parentIdentityNow.dev !== parentIdentity.dev || parentIdentityNow.ino !== parentIdentity.ino) {
				throw new SessionDeleteVerificationError("identity", "Parent directory identity changed during deletion");
			}

			// Destructive effect bound to the descriptor: truncate + write + fsync the
			// canonical tombstone through the retained descriptor. The pathname is untouched.
			try {
				this.#writeTombstoneViaDescriptor(fd, sessionId, cwd);
			} catch (err) {
				return {
					kind: "cleanup_pending",
					phase: "transcript",
					error: toError(err),
					transcriptIdentity: { dev: revalidateStat.dev, ino: revalidateStat.ino },
				};
			}

			// Post-effect verification: the public name must still resolve to the authorized
			// descriptor identity (dev, ino). A replacement installed at the pathname during
			// the window survived untouched (the pathname was never unlinked) and is reported
			// as a typed `stale` failure rather than being silently deleted.
			const publicIdentity = this.#publicNameIdentity(transcriptPath);
			if (publicIdentity.dev !== initialStat.dev || publicIdentity.ino !== initialStat.ino) {
				throw new SessionDeleteVerificationError(
					"stale",
					"Public transcript name no longer resolves to the authorized descriptor identity",
				);
			}
			return { kind: "deleted" };
		} finally {
			fs.closeSync(fd);
		}
	}

	/** Open the transcript once with no-follow read/write flags; symlink/stat failures map to typed errors. */
	#openTranscriptDescriptor(transcriptPath: string): number {
		try {
			return fs.openSync(transcriptPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "ELOOP" || code === "SYMLINK") {
				throw new SessionDeleteVerificationError("symlink", "Transcript path is a symlink");
			}
			throw new SessionDeleteVerificationError("stat", "Transcript could not be opened or read", {
				cause: toError(err),
			});
		}
	}

	/** fstat + read + header/id/cwd validation from one retained descriptor. */
	#readHeaderFromDescriptor(fd: number, expectedSessionId: string, expectedCwd: string): SessionStorageStat {
		const stat = statFromNode(fs.fstatSync(fd, { bigint: true }));
		if (!stat.isFile) {
			throw new SessionDeleteVerificationError("symlink", "Transcript is not a regular file");
		}
		const header = parseFirstJsonlLine(fs.readFileSync(fd));
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
		return stat;
	}

	/** fstat the retained descriptor for five-field revalidation. */
	#fstatDescriptor(fd: number): SessionStorageStat {
		return statFromNode(fs.fstatSync(fd, { bigint: true }));
	}

	/** Truncate + write + fsync the canonical tombstone through the retained descriptor. */
	#writeTombstoneViaDescriptor(fd: number, sessionId: string, cwd: string): void {
		const tombstoneBuf = Buffer.from(sessionDeletedTombstoneLine(sessionId, cwd), "utf-8");
		fs.ftruncateSync(fd, 0);
		let written = 0;
		while (written < tombstoneBuf.length) {
			const n = fs.writeSync(fd, tombstoneBuf, written, tombstoneBuf.length - written, written);
			if (n === 0) throw new Error("Short tombstone write");
			written += n;
		}
		fs.fsyncSync(fd);
	}

	/** Resolve the public pathname to its (dev, ino); a missing name is reported as `stale`. */
	#publicNameIdentity(transcriptPath: string): SessionStorageFileIdentity {
		try {
			const stat = fs.statSync(transcriptPath, { bigint: true });
			return { dev: stat.dev, ino: stat.ino };
		} catch (err) {
			if (isEnoent(err)) {
				throw new SessionDeleteVerificationError(
					"stale",
					"Public transcript name no longer resolves to the authorized descriptor identity",
				);
			}
			throw new SessionDeleteVerificationError("stat", "Public transcript name could not be inspected", {
				cause: toError(err),
			});
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
		return { dev: stat.dev, ino: stat.ino };
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
		return { dev: stat.dev, ino: stat.ino };
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

/** True when a live transcript stat matches every authorization field (all five). */
function sameVerifiedTranscriptStat(stat: SessionStorageStat, identity: SessionStorageTranscriptIdentity): boolean {
	return (
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.size === identity.size &&
		stat.mtimeMs === identity.mtimeMs &&
		stat.mtimeNs === identity.mtimeNs
	);
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
		const expected = options?.expectedObjectIdentity;
		if (expected) {
			// Descriptor-bound parity: a pathname that does not resolve to the authorized
			// {dev, ino} fails closed before any append/truncate. The memory backend
			// preserves the entry inode across writeTextSync, so a bound rewrite keeps the
			// same object identity after truncation.
			if (!this.#storage.existsSync(path)) {
				throw new SessionStorageObjectIdentityError(path, expected, MISSING_OBJECT_IDENTITY);
			}
			const stat = this.#storage.statSync(path);
			if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
				throw new SessionStorageObjectIdentityError(path, expected, { dev: stat.dev, ino: stat.ino });
			}
		}
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
		if (!sameVerifiedTranscriptStat(snapshot.stat, transcriptIdentity)) {
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
		// Logical-deletion parity with the file backend: write the canonical tombstone in
		// place (preserving the entry identity) instead of removing the key, so the public
		// name still resolves to the authorized object and is never unlinked.
		const authorizedIno = entry.ino;
		this.writeTextSync(transcriptPath, sessionDeletedTombstoneLine(sessionId, cwd));
		// Post-effect verification parity: the public key must still resolve to the
		// authorized identity (dev/ino). writeTextSync preserves the ino of an existing
		// entry, so this holds in the single-threaded memory backend.
		const publicStat = this.statSync(transcriptPath);
		if (publicStat.ino !== authorizedIno) {
			return Promise.reject(
				new SessionDeleteVerificationError(
					"stale",
					"Public transcript name no longer resolves to the authorized descriptor identity",
				),
			);
		}
		return Promise.resolve({ kind: "deleted" });
	}

	openWriter(path: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
