import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";
import {
	FileSessionStorage,
	isCanonicalSessionDeletedTombstone,
	MemorySessionStorage,
	SESSION_DELETED_TOMBSTONE_TYPE,
	SessionDeleteVerificationError,
	type SessionStorage,
	type SessionStorageFileIdentity,
	SessionStorageObjectIdentityError,
	SessionStorageWriterRetryableCloseError,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../src/session/session-storage";

/** Build the full five-field transcript identity from a snapshot stat. */
const fullIdentity = (identity: { dev: bigint; ino: bigint; size: number; mtimeMs: number; mtimeNs: bigint }) => ({
	dev: identity.dev,
	ino: identity.ino,
	size: identity.size,
	mtimeMs: identity.mtimeMs,
	mtimeNs: identity.mtimeNs,
});

/** Parse the first JSONL line of a real on-disk file as a record (tombstone assertions). */
const parseFirstLine = (p: string): Record<string, unknown> | undefined => {
	const text = fs.readFileSync(p, "utf-8");
	const firstLine = text.split("\n")[0]?.trim();
	if (!firstLine) return undefined;
	try {
		const value: unknown = JSON.parse(firstLine);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
};

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tempDir: string;
	let storage: {
		deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	};

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-session-storage-"));
		const { FileSessionStorage } = await import("../src/session/session-storage");
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	async function createSessionFile(name: string): Promise<string> {
		const sessionPath = path.join(tempDir, `${name}.jsonl`);
		await Bun.write(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
		);
		return sessionPath;
	}

	it("succeeds when the artifact directory is already absent", async () => {
		const sessionPath = await createSessionFile("missing-artifacts");
		const artifactsDir = sessionPath.slice(0, -6);

		expect(fs.existsSync(sessionPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).resolves.toBeUndefined();
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("throws when artifact cleanup fails after the session file is deleted", async () => {
		const sessionPath = await createSessionFile("cleanup-failure");
		const artifactsDir = sessionPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "artifact payload");

		const rmError = new Error("permission denied");
		const rmSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(rmError);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).rejects.toThrow(
			`Session file deleted but failed to remove artifacts directory ${artifactsDir}: permission denied`,
		);
		expect(rmSpy).toHaveBeenCalledWith(artifactsDir, {
			recursive: true,
			force: true,
		});
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});
});

describe("FileSessionStorageWriter certainty-aware close", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-writer-close-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("dispatched close failure is terminal close_unknown: no second close, writes/flush reject", async () => {
		// Default adapter calls fs.closeSync; make the dispatched OS close throw.
		const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(() => {
			throw new Error("EBADF simulated");
		});
		const writer = storage.openWriter(path.join(tempDir, "unknown.jsonl"));
		writer.writeLineSync("payload\n");

		await expect(writer.close()).rejects.toThrow("EBADF simulated");
		expect(writer.getCloseState()).toBe("close_unknown");
		// The OS close was dispatched exactly once.
		expect(closeSpy).toHaveBeenCalledTimes(1);

		// Repeated close must NOT dispatch OS close again; it surfaces the stored error.
		await expect(writer.close()).rejects.toThrow("EBADF simulated");
		expect(closeSpy).toHaveBeenCalledTimes(1);

		// Writes and flush deterministically reject in the terminal state.
		await expect(writer.writeLine("more\n")).rejects.toThrow();
		await expect(writer.flush()).rejects.toThrow();

		// Unrelated-fd safety: an intentionally allocated fd remains unmodified by the
		// quarantined writer (no second close reaches it).
		const fd = fs.openSync(path.join(tempDir, "unrelated.jsonl"), "w");
		closeSpy.mockClear();
		await expect(writer.close()).rejects.toThrow();
		expect(closeSpy).not.toHaveBeenCalled();
		closeSpy.mockRestore();
		fs.closeSync(fd);
	});

	it("certified pre-dispatch failure enters retryable, performs no OS close, then retries to closed", async () => {
		const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
		let failNext = true;
		const writer = storage.openWriter(path.join(tempDir, "retryable.jsonl"), {
			closeAdapter: {
				close: (fd: number) => {
					if (failNext) {
						failNext = false;
						throw new SessionStorageWriterRetryableCloseError("pre-dispatch prep failed");
					}
					fs.closeSync(fd);
				},
			},
		});
		writer.writeLineSync("payload\n");

		await expect(writer.close()).rejects.toThrow("pre-dispatch prep failed");
		expect(writer.getCloseState()).toBe("close_failed_retryable");
		// No OS close dispatched during the certified pre-dispatch failure.
		expect(closeSpy).not.toHaveBeenCalled();

		// Retry dispatches the real close and confirms closed.
		await writer.close();
		expect(writer.getCloseState()).toBe("closed");
		expect(closeSpy).toHaveBeenCalledTimes(1);

		// Idempotent repeated close is a harmless no-op.
		await writer.close();
		expect(closeSpy).toHaveBeenCalledTimes(1);
	});
	it("dispatched close that performs the real close then throws quarantines the fd with no leak", async () => {
		// Adapter performs the REAL fs.closeSync(fd) and THEN throws, simulating a
		// post-dispatch failure. The fd is genuinely closed at the OS level; the
		// writer must quarantine it (close_unknown), never retry, never finalizer
		// close, and never touch an unrelated fd.
		let closedFd: number | undefined;
		let dispatchCount = 0;
		const writer = storage.openWriter(path.join(tempDir, "dispatched.jsonl"), {
			closeAdapter: {
				close(fd: number) {
					dispatchCount++;
					closedFd = fd;
					fs.closeSync(fd); // real OS close — fd is now invalid
					throw new Error("post-dispatch failure");
				},
			},
		});
		writer.writeLineSync("payload\n");

		await expect(writer.close()).rejects.toThrow("post-dispatch failure");
		expect(writer.getCloseState()).toBe("close_unknown");
		// The real close dispatched exactly once.
		expect(dispatchCount).toBe(1);
		// The fd was genuinely closed by the adapter: a second OS close fails.
		expect(() => fs.closeSync(closedFd!)).toThrow();

		// Retry must NOT re-dispatch; it surfaces the stored quarantined error.
		await expect(writer.close()).rejects.toThrow("post-dispatch failure");
		expect(dispatchCount).toBe(1);

		// Unrelated-fd safety: an fd opened after the quarantine is untouched by any
		// retry/finalizer path of the quarantined writer.
		const unrelatedFd = fs.openSync(path.join(tempDir, "unrelated.jsonl"), "w");
		await expect(writer.close()).rejects.toThrow();
		expect(() => fs.writeSync(unrelatedFd, "safe")).not.toThrow();
		fs.closeSync(unrelatedFd);
	});
});

describe("FileSessionStorage.deleteSessionVerified artifact-first", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-verified-delete-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	async function createTranscript(name: string, id = "session-id"): Promise<string> {
		const transcriptPath = path.join(tempDir, `${name}.jsonl`);
		await Bun.write(
			transcriptPath,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
		);
		return transcriptPath;
	}
	it("tombstones the verified transcript after removing artifacts first", async () => {
		const transcriptPath = await createTranscript("happy");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		const result = await storage.deleteSessionVerified(target);
		expect(result).toEqual({ kind: "deleted" });
		// Artifacts are physically removed first.
		expect(fs.existsSync(artifactsDir)).toBe(false);
		// Logical deletion: the public pathname survives and now carries the canonical
		// tombstone (object-bound), not the session header. It is never unlinked.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		const header = parseFirstLine(transcriptPath);
		expect(isCanonicalSessionDeletedTombstone(header)).toBe(true);
		expect(header?.type).toBe(SESSION_DELETED_TOMBSTONE_TYPE);
		expect(header?.id).toBe("session-id");
	});

	it("artifact rm failure returns cleanup_pending and leaves the transcript intact for retry", async () => {
		const transcriptPath = await createTranscript("partial");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		vi.spyOn(fsp, "rm").mockRejectedValueOnce(new Error("artifact rm denied"));

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		const result = await storage.deleteSessionVerified(target);
		expect(result.kind).toBe("cleanup_pending");
		if (result.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(result.phase).toBe("artifacts");
		// Artifact-first: the transcript is untouched so fresh discovery/retry can proceed.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);
		expect(result.transcriptIdentity).toEqual({ dev: stat.dev, ino: stat.ino });
	});

	it("identity mismatch throws without mutating transcript or artifacts", async () => {
		const transcriptPath = await createTranscript("mismatch");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: {
				dev: 1n,
				ino: 2n,
				size: 0,
				mtimeMs: 0,
				mtimeNs: 0n,
			},
		};

		await expect(storage.deleteSessionVerified(target)).rejects.toBeInstanceOf(SessionDeleteVerificationError);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});

	it("in-place transcript modification after initial authority is rejected by full five-field identity", async () => {
		const transcriptPath = await createTranscript("in-place-modified");
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		// Initial authority captured all five fields.
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};
		// In-place modification after initial authority: same dev/ino, changed size/mtime.
		await fsp.appendFile(transcriptPath, `${JSON.stringify({ type: "assistant", content: "tamper" })}\n`);
		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		// No deletion effect: the modified transcript survives.
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("revalidates all five fields after artifact removal, rejecting a concurrently modified transcript", async () => {
		const transcriptPath = await createTranscript("revalidate-window");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};
		// Concurrent in-place modification during artifact removal: initial authority
		// matches, but the file changes before the pre-tombstone descriptor revalidation.
		const originalRm = fsp.rm.bind(fsp);
		vi.spyOn(fsp, "rm").mockImplementation(async (rmPath, options) => {
			await fsp.appendFile(transcriptPath, `${JSON.stringify({ type: "assistant", content: "tamper" })}\n`);
			return originalRm(rmPath, options);
		});
		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect((err as Error).message).toContain("after artifact removal");
		// No deletion effect: the modified transcript survives.
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});
	// ---------------------------------------------------------------------------
	// Failure injection: partial-cleanup evidence + identity/symlink fail-closed
	// ---------------------------------------------------------------------------

	it("artifact rm failure returns exact retry evidence (never success); recorded identity drives a clean retry", async () => {
		const transcriptPath = await createTranscript("retry-evidence");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		// First attempt: artifact removal fails (the once-mock affects only this call).
		const rmSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(new Error("artifact rm denied"));

		const partial = await storage.deleteSessionVerified(target);
		// No false success: this is a typed partial cleanup, never "deleted".
		expect(partial.kind).toBe("cleanup_pending");
		if (partial.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(partial.phase).toBe("artifacts");
		expect(partial.error).toBeInstanceOf(Error);
		expect(partial.error.message).toBe("artifact rm denied");
		// Exact retry evidence: transcript identity unchanged, artifact identity recorded.
		expect(partial.transcriptIdentity).toEqual({
			dev: stat.dev,
			ino: stat.ino,
		});
		const recordedArtifactsIdentity = (
			partial as Extract<VerifiedSessionDeleteResult, { kind: "cleanup_pending"; phase: "artifacts" }>
		).artifactsIdentity;
		expect(recordedArtifactsIdentity).toBeDefined();
		// No data loss: transcript and artifacts still on disk.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);

		// Restore the rm spy so the real cleanup runs on retry.
		rmSpy.mockRestore();

		// Retry bound to the recorded artifact identity: same directory matches and the
		// verified logical delete completes.
		const retried = await storage.deleteSessionVerified({
			...target,
			expectedArtifactsIdentity: recordedArtifactsIdentity,
		});
		expect(retried).toEqual({ kind: "deleted" });
		// Retry completes the logical deletion: artifacts gone, transcript tombstoned.
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(isCanonicalSessionDeletedTombstone(parseFirstLine(transcriptPath))).toBe(true);
	});

	it("tombstone descriptor-write failure after artifact removal returns typed cleanup_pending(transcript) and keeps the transcript", async () => {
		const transcriptPath = await createTranscript("tombstone-failure");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		// Inject a failure in the descriptor-bound destructive effect (the truncation
		// step of the tombstone write). Truncation is the first mutating step, so the
		// authorized object is left intact; the public pathname is never unlinked.
		vi.spyOn(fs, "ftruncateSync").mockImplementationOnce(() => {
			throw new Error("tombstone truncate denied");
		});

		const result = await storage.deleteSessionVerified(target);
		expect(result.kind).toBe("cleanup_pending");
		if (result.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(result.phase).toBe("transcript");
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error.message).toBe("tombstone truncate denied");
		expect(result.transcriptIdentity).toEqual({ dev: stat.dev, ino: stat.ino });
		// Artifacts were removed first (intended); the authorized transcript survives
		// untouched (the tombstone truncation failed before any byte was written).
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(parseFirstLine(transcriptPath)?.type).toBe("session");
	});

	it("a symlinked artifact directory is rejected as a symlink before any mutation", async () => {
		const transcriptPath = await createTranscript("artifact-symlink");
		const artifactsDir = transcriptPath.slice(0, -6);
		// Real directory elsewhere; the artifacts path is a symlink to it.
		const realArtifactsDir = path.join(tempDir, "real-artifacts");
		await fsp.mkdir(realArtifactsDir, { recursive: true });
		await Bun.write(path.join(realArtifactsDir, "artifact.txt"), "payload");
		await fsp.symlink(realArtifactsDir, artifactsDir);

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("symlink");
		// No mutation: transcript, the symlink, and its target all intact.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.lstatSync(artifactsDir).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(realArtifactsDir)).toBe(true);
	});

	it("a symlinked transcript is rejected before any mutation", async () => {
		// The descriptor open uses O_NOFOLLOW, which makes opening a symlink fail with
		// ELOOP on both Linux and macOS -> typed "symlink" verification failure.
		const realTranscript = await createTranscript("symlink-target");
		const transcriptPath = path.join(tempDir, "symlink-tx.jsonl");
		await fsp.symlink(realTranscript, transcriptPath);

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			// Identity is irrelevant: the symlink is rejected at the initial read, before
			// the identity comparison runs. Dummy values keep the contract shape explicit.
			transcriptIdentity: {
				dev: 0n,
				ino: 0n,
				size: 0,
				mtimeMs: 0,
				mtimeNs: 0n,
			},
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("symlink");
		// No mutation: the symlink and its target are intact.
		expect(fs.lstatSync(transcriptPath).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(realTranscript)).toBe(true);
	});

	it("a path replacement at the final effect survives untouched and produces a typed stale failure", async () => {
		const transcriptPath = await createTranscript("replacement");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		// Capture the exact authorized bytes/identity before the deletion window.
		const realSnapshot = storage.readSnapshotSync(transcriptPath);
		const originalContent = Buffer.from(realSnapshot.bytes).toString("utf-8");
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(realSnapshot.stat),
		};

		// During artifact cleanup (while the authorized descriptor is retained), install a
		// path replacement: move the authorized transcript aside and place a fresh object at
		// the public pathname. The retained descriptor still binds the original object, so
		// the destructive tombstone effect hits the authorized object — never the pathname.
		const retained = path.join(tempDir, "replacement-authorized.jsonl");
		const originalRm = fsp.rm.bind(fsp);
		vi.spyOn(fsp, "rm").mockImplementation(async (rmPath, options) => {
			await fsp.rename(transcriptPath, retained);
			await Bun.write(transcriptPath, originalContent);
			return originalRm(rmPath, options);
		});

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("stale");
		// Artifacts were removed (intended).
		expect(fs.existsSync(artifactsDir)).toBe(false);
		// The replacement at the public pathname survived untouched (never unlinked) and
		// still carries the live session header.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(parseFirstLine(transcriptPath)?.type).toBe("session");
		// The authorized object was tombstoned through the retained descriptor (it now
		// lives at the moved path); the destructive effect was object-bound, not path-bound.
		expect(fs.existsSync(retained)).toBe(true);
		expect(isCanonicalSessionDeletedTombstone(parseFirstLine(retained))).toBe(true);
	});

	it("retry with a replaced artifact directory identity fails closed before mutation", async () => {
		const transcriptPath = await createTranscript("replaced-retry");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const stat = storage.readSnapshotSync(transcriptPath).stat;

		// First attempt: artifact rm fails and records the real artifact identity.
		const rmSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(new Error("artifact rm denied"));
		const partial = await storage.deleteSessionVerified({
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		});
		if (partial.kind !== "cleanup_pending" || partial.phase !== "artifacts") throw new Error("unreachable");
		const recordedArtifactsIdentity = (
			partial as Extract<VerifiedSessionDeleteResult, { kind: "cleanup_pending"; phase: "artifacts" }>
		).artifactsIdentity;
		expect(recordedArtifactsIdentity).toBeDefined();
		rmSpy.mockRestore();

		// Replace the artifact directory with a fresh one whose inode is guaranteed to
		// differ from the recorded one. Rename the original directory to a retained
		// sibling so its inode stays allocated — Linux may otherwise reuse the same
		// inode when the path is removed and immediately recreated, collapsing the
		// expected identity mismatch — then create a new directory at the original
		// path and write the replacement payload. The retained sibling lives under
		// tempDir, so the existing afterEach cleanup removes it.
		const retainedOriginal = path.join(tempDir, "replaced-retry-original");
		await fsp.rename(artifactsDir, retainedOriginal);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "replacement payload");

		// Retry bound to the recorded identity: the new directory does NOT match, so it
		// fails closed in the artifact identity check (before any rm/unlink).
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: fullIdentity(stat),
				expectedArtifactsIdentity: recordedArtifactsIdentity,
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		// No data loss: replacement artifact directory and the transcript both intact.
		expect(fs.existsSync(artifactsDir)).toBe(true);
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});
	it("a non-directory artifact sibling is rejected before any mutation (no false deleted)", async () => {
		const transcriptPath = await createTranscript("nondir-artifact");
		const artifactsDir = transcriptPath.slice(0, -6);
		// Create a REGULAR FILE at the artifact path (not a directory, not a symlink).
		await Bun.write(artifactsDir, "foreign artifact sibling");

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		// No false deleted: the transcript and the foreign sibling are both intact.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});

	it("a transcript whose header lacks type:'session' is rejected as a header mismatch", async () => {
		const transcriptPath = path.join(tempDir, "wrong-type.jsonl");
		// Header with a non-session type — must not be accepted as a deletable transcript.
		await Bun.write(transcriptPath, `${JSON.stringify({ type: "artifact", id: "session-id", cwd: tempDir })}\n`);

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("header");
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("a transcript outside the sessions root is rejected as a containment failure before mutation", async () => {
		const transcriptPath = await createTranscript("contained");
		const outsideRoot = path.join(tempDir, "outside");
		await fsp.mkdir(outsideRoot, { recursive: true });

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: outsideRoot, // root that does NOT contain the transcript
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: fullIdentity(stat),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("containment");
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("a header cwd mismatch is rejected as a cwd failure before mutation", async () => {
		const transcriptPath = await createTranscript("cwd-mismatch");

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/totally/different/cwd",
			transcriptIdentity: fullIdentity(stat),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("cwd");
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});
});

describe("MemorySessionStorage.deleteSessionVerified parity", () => {
	let storage: MemorySessionStorage;
	const sessionsRoot = "/sessions";

	beforeEach(() => {
		storage = new MemorySessionStorage();
	});

	function seedTranscript(
		transcriptPath: string,
		header: Record<string, unknown> = {
			type: "session",
			id: "session-id",
			cwd: "/cwd",
		},
	): void {
		storage.writeTextSync(transcriptPath, `${JSON.stringify(header)}\n`);
	}

	it("tombstones a verified matching transcript", async () => {
		const transcriptPath = path.join(sessionsRoot, "s.jsonl");
		seedTranscript(transcriptPath);
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const result = await storage.deleteSessionVerified({
			sessionsRoot,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/cwd",
			transcriptIdentity: fullIdentity(stat),
		});
		expect(result).toEqual({ kind: "deleted" });
		// Logical-deletion parity: the key survives and carries the canonical tombstone.
		expect(storage.existsSync(transcriptPath)).toBe(true);
		const tombstone = JSON.parse(storage.readTextSync(transcriptPath).split("\n")[0]);
		expect(isCanonicalSessionDeletedTombstone(tombstone)).toBe(true);
		expect(tombstone.id).toBe("session-id");
	});

	it("rejects a transcript outside the sessions root (containment parity)", async () => {
		const transcriptPath = "/elsewhere/s.jsonl";
		seedTranscript(transcriptPath);
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: fullIdentity(stat),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("containment");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("requires header type:'session' (header parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "artifact.jsonl");
		seedTranscript(transcriptPath, {
			type: "artifact",
			id: "session-id",
			cwd: "/cwd",
		});
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: fullIdentity(stat),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("header");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects an exact id/cwd mismatch without mutation", async () => {
		const transcriptPath = path.join(sessionsRoot, "id.jsonl");
		seedTranscript(transcriptPath, {
			type: "session",
			id: "real-id",
			cwd: "/cwd",
		});
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "wrong-id",
				cwd: "/cwd",
				transcriptIdentity: fullIdentity(stat),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects a header cwd mismatch without mutation (cwd parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "cwd.jsonl");
		seedTranscript(transcriptPath, {
			type: "session",
			id: "session-id",
			cwd: "/cwd",
		});
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/totally/different/cwd",
				transcriptIdentity: fullIdentity(stat),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("cwd");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects a non-directory artifact sibling (artifact parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "art.jsonl");
		const artifactsPath = transcriptPath.slice(0, -6);
		seedTranscript(transcriptPath);
		// A file key at the artifact path is a non-directory sibling in memory.
		storage.writeTextSync(artifactsPath, "foreign");
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: fullIdentity(stat),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		expect(storage.existsSync(transcriptPath)).toBe(true);
		expect(storage.existsSync(artifactsPath)).toBe(true);
	});
});
describe("SessionManager.inventorySessionsStrict root inspection failures", () => {
	const cwd = "/scoped/project";
	const sessionDir = "/scoped/project/sessions";

	/** Minimal storage double: only the strict scan surface is exercised here. */
	function makeStorage(opts: {
		scan: (dir: string, pattern: string) => string[];
		existsSync?: (p: string) => boolean;
	}): SessionStorage {
		return {
			// existsSync defaults to "root missing" to prove the forgiving
			// preflight no longer collapses a real scan error onto absence.
			existsSync: opts.existsSync ?? (() => false),
			listFilesStrictSync: opts.scan,
		} as unknown as SessionStorage;
	}

	function errnoError(code: string): NodeJS.ErrnoException {
		const err = new Error(`${code}: scoped storage failure`) as NodeJS.ErrnoException;
		err.code = code;
		return err;
	}

	it("fails closed when the storage backend lacks a strict scan capability", () => {
		const storage = {
			existsSync: () => false,
			listFilesSync: () => [],
		} as unknown as SessionStorage;
		const result = SessionManager.inventorySessionsStrict(cwd, {
			sessionDir,
			storage,
		});
		expect(result.kind).toBe("failure");
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures).toEqual([
			expect.objectContaining({
				kind: "scan",
				message: "Strict scoped session scan is unavailable",
			}),
		]);
	});

	it("classifies a confirmed ENOENT as a complete empty inventory", () => {
		const storage = makeStorage({
			scan: () => {
				throw errnoError("ENOENT");
			},
		});
		const result = SessionManager.inventorySessionsStrict(cwd, {
			sessionDir,
			storage,
		});
		expect(result).toEqual({ kind: "complete", candidates: [] });
	});

	it("never reduces a non-ENOENT root error (EACCES) to authoritative absence", () => {
		const storage = makeStorage({
			// Even with a forgiving existsSync reporting the root missing, the
			// strict scan error must win — the preflight is removed.
			existsSync: () => false,
			scan: () => {
				throw errnoError("EACCES");
			},
		});
		const result = SessionManager.inventorySessionsStrict(cwd, {
			sessionDir,
			storage,
		});
		expect(result.kind).toBe("failure");
		// Zero-authority: a failure grants no candidate set at all.
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures).toHaveLength(1);
		const failure = result.failures[0];
		expect(failure.kind).toBe("root");
		// Sanitized contract: raw errno and raw path must not leak into the message.
		expect(failure.message).not.toContain("EACCES");
		expect(failure.message).not.toContain(sessionDir);
	});

	it("classifies ENOTDIR (scoped path is not a directory) as a root failure", () => {
		const storage = makeStorage({
			scan: () => {
				throw errnoError("ENOTDIR");
			},
		});
		const result = SessionManager.inventorySessionsStrict(cwd, {
			sessionDir,
			storage,
		});
		expect(result.kind).toBe("failure");
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures[0].kind).toBe("root");
	});

	it("surfaces an unknown/IO scan error (EIO) as a zero-authority scan failure", () => {
		const storage = makeStorage({
			scan: () => {
				throw errnoError("EIO");
			},
		});
		const result = SessionManager.inventorySessionsStrict(cwd, {
			sessionDir,
			storage,
		});
		expect(result.kind).toBe("failure");
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].kind).toBe("scan");
		expect(result.failures[0].message).not.toContain("EIO");
	});
});
describe("SessionManager.inventorySessionsStrict session_deleted tombstones", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-strict-tombstone-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("omits a canonical session_deleted tombstone from a complete inventory", () => {
		// Canonical tombstone: recognized and omitted (not a candidate, not a failure).
		storage.writeTextSync(
			path.join(tempDir, "deleted.jsonl"),
			`${JSON.stringify({ type: SESSION_DELETED_TOMBSTONE_TYPE, id: "deleted-id", cwd: tempDir, deletedAt: "2025-01-01T00:00:00Z" })}\n`,
		);
		// A live session in the same directory is still enumerated.
		storage.writeTextSync(
			path.join(tempDir, "live.jsonl"),
			`${JSON.stringify({ type: "session", id: "live-id", cwd: tempDir })}\n`,
		);

		const result = SessionManager.inventorySessionsStrict(tempDir, { sessionDir: tempDir, storage });
		expect(result).toEqual({ kind: "complete", candidates: [expect.objectContaining({ id: "live-id" })] });
	});

	it("fails closed on a malformed session_deleted lookalike (never treated as deleted)", () => {
		// Missing id/cwd: not the canonical schema -> must NOT be omitted -> fail closed.
		storage.writeTextSync(
			path.join(tempDir, "malformed.jsonl"),
			`${JSON.stringify({ type: SESSION_DELETED_TOMBSTONE_TYPE })}\n`,
		);

		const result = SessionManager.inventorySessionsStrict(tempDir, { sessionDir: tempDir, storage });
		expect(result.kind).toBe("failure");
		// Zero-authority: a failure grants no candidate set at all.
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].kind).toBe("header");
	});
});
/**
 * Replace a pathname with successor content via a fresh temp file + rename. The
 * rename moves a brand-new inode over the target, guaranteeing the public pathname
 * now resolves to a different {dev, ino} than the authorized object.
 */
function installSuccessor(target: string, content: string): void {
	const tmp = path.join(
		path.dirname(target),
		`.${path.basename(target)}.successor-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
	);
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, target);
}

describe("FileSessionStorageWriter descriptor-bound object identity", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-bound-writer-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("descriptor-bound append validates dev/ino and appends through the descriptor", () => {
		const fpath = path.join(tempDir, "bound-append.jsonl");
		fs.writeFileSync(fpath, "line-a\n");
		const stat = fs.statSync(fpath, { bigint: true });
		const identity: SessionStorageFileIdentity = { dev: stat.dev, ino: stat.ino };

		const writer = storage.openWriter(fpath, { flags: "a", expectedObjectIdentity: identity });
		writer.writeLineSync("line-b\n");
		writer.closeSync();

		expect(fs.readFileSync(fpath, "utf-8")).toBe("line-a\nline-b\n");
		// Append through the descriptor preserves the authorized inode.
		expect(fs.statSync(fpath, { bigint: true }).ino).toBe(identity.ino);
	});

	it("descriptor-bound full rewrite truncates through the validated descriptor, preserving inode", () => {
		const fpath = path.join(tempDir, "bound-rewrite.jsonl");
		fs.writeFileSync(fpath, "old-content-that-must-be-replaced\n");
		const stat = fs.statSync(fpath, { bigint: true });
		const identity: SessionStorageFileIdentity = { dev: stat.dev, ino: stat.ino };

		const writer = storage.openWriter(fpath, { flags: "w", expectedObjectIdentity: identity });
		writer.writeLineSync("new-content\n");
		writer.closeSync();

		expect(fs.readFileSync(fpath, "utf-8")).toBe("new-content\n");
		expect(fs.statSync(fpath, { bigint: true }).ino).toBe(identity.ino);
	});

	it("replacement before a bound append fails closed and leaves successor bytes untouched", () => {
		const fpath = path.join(tempDir, "append-replaced.jsonl");
		fs.writeFileSync(fpath, "authorized\n");
		const stat = fs.statSync(fpath, { bigint: true });
		const identity: SessionStorageFileIdentity = { dev: stat.dev, ino: stat.ino };

		installSuccessor(fpath, "successor-bytes\n");
		expect(fs.statSync(fpath, { bigint: true }).ino).not.toBe(identity.ino);

		expect(() => storage.openWriter(fpath, { flags: "a", expectedObjectIdentity: identity })).toThrow(
			SessionStorageObjectIdentityError,
		);
		// No byte appended to the successor; its content survives verbatim.
		expect(fs.readFileSync(fpath, "utf-8")).toBe("successor-bytes\n");
	});

	it("replacement before a bound full rewrite fails closed without truncating the successor", () => {
		const fpath = path.join(tempDir, "rewrite-replaced.jsonl");
		fs.writeFileSync(fpath, "authorized\n");
		const stat = fs.statSync(fpath, { bigint: true });
		const identity: SessionStorageFileIdentity = { dev: stat.dev, ino: stat.ino };

		installSuccessor(fpath, "successor-bytes\n");
		const successorSize = fs.statSync(fpath).size;
		expect(fs.statSync(fpath, { bigint: true }).ino).not.toBe(identity.ino);

		expect(() => storage.openWriter(fpath, { flags: "w", expectedObjectIdentity: identity })).toThrow(
			SessionStorageObjectIdentityError,
		);
		// ftruncate runs only AFTER dev/ino validation; the successor was never truncated.
		expect(fs.readFileSync(fpath, "utf-8")).toBe("successor-bytes\n");
		expect(fs.statSync(fpath).size).toBe(successorSize);
	});

	it("a bound append to a missing pathname fails closed with a missing-object identity", () => {
		const fpath = path.join(tempDir, "missing.jsonl");
		const identity: SessionStorageFileIdentity = { dev: 0n, ino: 999n };

		let caught: unknown;
		try {
			storage.openWriter(fpath, { flags: "a", expectedObjectIdentity: identity });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SessionStorageObjectIdentityError);
		const err = caught as SessionStorageObjectIdentityError;
		expect(err.actual.dev).toBe(-1n);
		expect(err.actual.ino).toBe(-1n);
		expect(err.expected).toEqual(identity);
	});
});

describe("MemorySessionStorageWriter descriptor-bound object identity", () => {
	it("bound append fails closed after an in-memory replacement, leaving successor bytes untouched", () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync("/mem.jsonl", "authorized\n");
		const identity: SessionStorageFileIdentity = { dev: 0n, ino: storage.statSync("/mem.jsonl").ino };

		// Unlink + rewrite allocates a fresh memory inode, replacing the object.
		storage.unlinkSync("/mem.jsonl");
		storage.writeTextSync("/mem.jsonl", "successor\n");
		expect(storage.statSync("/mem.jsonl").ino).not.toBe(identity.ino);

		expect(() => storage.openWriter("/mem.jsonl", { flags: "a", expectedObjectIdentity: identity })).toThrow(
			SessionStorageObjectIdentityError,
		);
		expect(storage.readTextSync("/mem.jsonl")).toBe("successor\n");
	});

	it("a non-bound memory writer retains ordinary create/append semantics", () => {
		const storage = new MemorySessionStorage();
		// No expectedObjectIdentity: the writer creates the entry and appends normally.
		const writer = storage.openWriter("/plain.jsonl");
		writer.writeLineSync("plain-line\n");
		writer.closeSync();
		expect(storage.readTextSync("/plain.jsonl")).toBe("plain-line\n");
	});
});

describe("SessionManager strict object-identity persistence binding", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-strict-bind-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("bindCreatedDestinationStrict pins all subsequent persists to the authorized inode", async () => {
		const manager = SessionManager.create(tempDir, tempDir, storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;

		expect(manager.bindCreatedDestinationStrict()).toEqual({ kind: "bound" });
		const identity = manager.getStrictObjectIdentity()!;
		expect(identity).toBeDefined();

		// Append + full rewrite both route through the bound descriptor; the inode
		// never changes (no atomic rename replacement).
		manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		await manager.rewriteEntries();
		expect(fs.statSync(sessionFile, { bigint: true }).ino).toBe(identity.ino);

		manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		await manager.rewriteEntries();
		expect(fs.statSync(sessionFile, { bigint: true }).ino).toBe(identity.ino);

		// Idempotent rebind to the same file is a no-op success.
		expect(manager.bindCreatedDestinationStrict()).toEqual({ kind: "bound" });
		await manager.close();
	});

	it("bindCreatedDestinationStrict errors when the destination is not yet on disk", () => {
		const manager = SessionManager.create(tempDir, tempDir, storage);
		// No ensureOnDisk(): the destination file does not exist yet.
		expect(manager.bindCreatedDestinationStrict()).toEqual({ kind: "error", reason: "missing" });
		expect(manager.getStrictObjectIdentity()).toBeUndefined();
	});

	it("a bound full rewrite after pathname replacement fails closed, leaving the successor untouched", async () => {
		const manager = SessionManager.create(tempDir, tempDir, storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;
		manager.bindCreatedDestinationStrict();
		const identity = manager.getStrictObjectIdentity()!;

		installSuccessor(sessionFile, "successor-transcript\n");
		expect(fs.statSync(sessionFile, { bigint: true }).ino).not.toBe(identity.ino);

		await expect(manager.rewriteEntries()).rejects.toThrow();
		// The successor transcript was never truncated or renamed over.
		expect(fs.readFileSync(sessionFile, "utf-8")).toBe("successor-transcript\n");

		await manager.close().catch(() => {});
	});

	it("a bound append reopen after pathname replacement fails closed, leaving the successor untouched", async () => {
		const manager = SessionManager.create(tempDir, tempDir, storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;
		manager.bindCreatedDestinationStrict();
		const identity = manager.getStrictObjectIdentity()!;

		installSuccessor(sessionFile, "successor-transcript\n");
		expect(fs.statSync(sessionFile, { bigint: true }).ino).not.toBe(identity.ino);

		// The hot append path reopens a bound writer synchronously; a replacement
		// throws before any byte reaches the successor.
		expect(() =>
			manager.appendMessage({ role: "user", content: "post-replacement", timestamp: Date.now() }),
		).toThrow();
		expect(fs.readFileSync(sessionFile, "utf-8")).toBe("successor-transcript\n");

		await manager.close().catch(() => {});
	});

	it("an ordinary unbound session still replaces the file via atomic rename (inode changes)", async () => {
		const manager = SessionManager.create(tempDir, tempDir, storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;

		expect(manager.getStrictObjectIdentity()).toBeUndefined();
		const beforeIno = fs.statSync(sessionFile, { bigint: true }).ino;

		manager.appendMessage({ role: "user", content: "rewrite", timestamp: Date.now() });
		await manager.rewriteEntries();

		// Ordinary path renames a temp over the file: a fresh inode replaces the old one.
		expect(fs.statSync(sessionFile, { bigint: true }).ino).not.toBe(beforeIno);
		await manager.close();
	});
});
