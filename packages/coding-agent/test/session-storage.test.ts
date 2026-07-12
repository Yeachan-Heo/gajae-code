import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cloneArtifactsExclusive } from "../src/session/artifacts";
import {
	readSelectedSessionSnapshot,
	SessionManager,
	STRICT_INVENTORY_HEADER_PREFIX_BYTES,
	type StrictInventoryCandidate,
} from "../src/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	SessionDeleteVerificationError,
	type SessionStorage,
	SessionStorageWriterRetryableCloseError,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../src/session/session-storage";

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tempDir: string;
	let storage: { deleteSessionWithArtifacts(sessionPath: string): Promise<void> };

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
		expect(rmSpy).toHaveBeenCalledWith(artifactsDir, { recursive: true, force: true });
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

	it("removes the verified artifact directory first, then the transcript last", async () => {
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
		};

		const result = await storage.deleteSessionVerified(target);
		expect(result).toEqual({ kind: "deleted" });
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(false);
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
			transcriptIdentity: { dev: 1n, ino: 2n },
		};

		await expect(storage.deleteSessionVerified(target)).rejects.toBeInstanceOf(SessionDeleteVerificationError);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
		expect(partial.transcriptIdentity).toEqual({ dev: stat.dev, ino: stat.ino });
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
		// verified hard delete completes.
		const retried = await storage.deleteSessionVerified({
			...target,
			expectedArtifactsIdentity: recordedArtifactsIdentity,
		});
		expect(retried).toEqual({ kind: "deleted" });
		expect(fs.existsSync(transcriptPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("transcript unlink failure after artifact removal returns typed cleanup_pending(transcript) and keeps the transcript", async () => {
		const transcriptPath = await createTranscript("unlink-failure");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
		};

		// Inject a non-ENOENT unlink failure (EACCES, not the ENOENT that maps to deleted).
		const unlinkErr = Object.assign(new Error("transcript unlink denied"), { code: "EACCES" });
		vi.spyOn(storage, "unlink").mockRejectedValueOnce(unlinkErr);

		const result = await storage.deleteSessionVerified(target);
		expect(result.kind).toBe("cleanup_pending");
		if (result.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(result.phase).toBe("transcript");
		expect(result.error).toBeInstanceOf(Error);
		expect(result.transcriptIdentity).toEqual({ dev: stat.dev, ino: stat.ino });
		// Artifacts were removed first (intended); the transcript survives (no data loss).
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
		// readSnapshotSync opens with O_NOFOLLOW, which makes opening a symlink fail
		// with ELOOP on both Linux and macOS -> typed "symlink" verification failure.
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
			transcriptIdentity: { dev: 0n, ino: 0n },
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("symlink");
		// No mutation: the symlink and its target are intact.
		expect(fs.lstatSync(transcriptPath).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(realTranscript)).toBe(true);
	});

	it("transcript identity replaced after artifact removal fails closed before unlink", async () => {
		const transcriptPath = await createTranscript("replacement");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		// Capture the real snapshot (and its bound identity) before installing the spy.
		const realSnapshot = storage.readSnapshotSync(transcriptPath);
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: { dev: realSnapshot.stat.dev, ino: realSnapshot.stat.ino },
		};

		// On the post-artifact revalidation read (2nd call) return a replaced (dev, ino):
		// the file the authorization bound to has been swapped out after artifacts removal.
		let snapshotCalls = 0;
		vi.spyOn(storage, "readSnapshotSync").mockImplementation(() => {
			snapshotCalls++;
			if (snapshotCalls === 2) {
				return {
					bytes: realSnapshot.bytes,
					stat: { ...realSnapshot.stat, ino: realSnapshot.stat.ino + 1n },
				};
			}
			return realSnapshot;
		});

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect((err as Error).message).toContain("replacement detected");
		// Artifacts were removed (intended); the transcript was never unlinked (no data loss).
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
				transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
		header: Record<string, unknown> = { type: "session", id: "session-id", cwd: "/cwd" },
	): void {
		storage.writeTextSync(transcriptPath, `${JSON.stringify(header)}\n`);
	}

	it("deletes a verified matching transcript", async () => {
		const transcriptPath = path.join(sessionsRoot, "s.jsonl");
		seedTranscript(transcriptPath);
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const result = await storage.deleteSessionVerified({
			sessionsRoot,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/cwd",
			transcriptIdentity: { dev: stat.dev, ino: stat.ino },
		});
		expect(result).toEqual({ kind: "deleted" });
		expect(storage.existsSync(transcriptPath)).toBe(false);
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
				transcriptIdentity: { dev: stat.dev, ino: stat.ino },
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("containment");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("requires header type:'session' (header parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "artifact.jsonl");
		seedTranscript(transcriptPath, { type: "artifact", id: "session-id", cwd: "/cwd" });
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: { dev: stat.dev, ino: stat.ino },
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("header");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects an exact id/cwd mismatch without mutation", async () => {
		const transcriptPath = path.join(sessionsRoot, "id.jsonl");
		seedTranscript(transcriptPath, { type: "session", id: "real-id", cwd: "/cwd" });
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "wrong-id",
				cwd: "/cwd",
				transcriptIdentity: { dev: stat.dev, ino: stat.ino },
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects a header cwd mismatch without mutation (cwd parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "cwd.jsonl");
		seedTranscript(transcriptPath, { type: "session", id: "session-id", cwd: "/cwd" });
		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/totally/different/cwd",
				transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
				transcriptIdentity: { dev: stat.dev, ino: stat.ino },
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
		const result = SessionManager.inventorySessionsStrict(cwd, { sessionDir, storage });
		expect(result.kind).toBe("failure");
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures).toEqual([
			expect.objectContaining({ kind: "scan", message: "Strict scoped session scan is unavailable" }),
		]);
	});

	it("classifies a confirmed ENOENT as a complete empty inventory", () => {
		const storage = makeStorage({
			scan: () => {
				throw errnoError("ENOENT");
			},
		});
		const result = SessionManager.inventorySessionsStrict(cwd, { sessionDir, storage });
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
		const result = SessionManager.inventorySessionsStrict(cwd, { sessionDir, storage });
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
		const result = SessionManager.inventorySessionsStrict(cwd, { sessionDir, storage });
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
		const result = SessionManager.inventorySessionsStrict(cwd, { sessionDir, storage });
		expect(result.kind).toBe("failure");
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") return;
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].kind).toBe("scan");
		expect(result.failures[0].message).not.toContain("EIO");
	});
});
describe("FileSessionStorage.readSnapshotPrefixSync bounded header prefix", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-prefix-read-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("returns only the bounded byte prefix while preserving full descriptor stat identity", async () => {
		const payload = "X".repeat(4096);
		const file = path.join(tempDir, "big.jsonl");
		await Bun.write(file, payload);
		const snapshot = storage.readSnapshotPrefixSync(file, 64);
		// Bounded: only the prefix bytes are materialized, not the whole body.
		expect(snapshot.bytes.length).toBe(64);
		expect(new TextDecoder().decode(snapshot.bytes)).toBe(payload.slice(0, 64));
		// Full stat identity preserved: size is the real file size; dev/ino match a full read.
		expect(snapshot.stat.size).toBe(payload.length);
		const full = storage.readSnapshotSync(file);
		expect(snapshot.stat.dev).toBe(full.stat.dev);
		expect(snapshot.stat.ino).toBe(full.stat.ino);
		expect(snapshot.stat.isFile).toBe(true);
	});

	it("returns the whole file when maxBytes exceeds the real file size", async () => {
		const payload = "small bounded payload";
		const file = path.join(tempDir, "small.jsonl");
		await Bun.write(file, payload);
		const snapshot = storage.readSnapshotPrefixSync(file, 1 << 20);
		expect(snapshot.bytes.length).toBe(payload.length);
		expect(snapshot.stat.size).toBe(payload.length);
	});

	it("opens with O_NOFOLLOW so a symlinked path fails closed (ELOOP/SYMLINK)", async () => {
		const real = path.join(tempDir, "real.jsonl");
		const link = path.join(tempDir, "link.jsonl");
		await Bun.write(real, "payload");
		await fsp.symlink(real, link);
		let err: unknown;
		try {
			storage.readSnapshotPrefixSync(link, 64);
			throw new Error("expected readSnapshotPrefixSync to throw");
		} catch (e) {
			err = e;
		}
		// The sync O_NOFOLLOW open surfaces the symlink rejection (ELOOP on macOS/Linux).
		expect(err).toBeInstanceOf(Error);
		expect((err as NodeJS.ErrnoException)?.code).toMatch(/ELOOP|SYMLINK/);
	});
});

describe("MemorySessionStorage.readSnapshotPrefixSync bounded header prefix", () => {
	it("returns the bounded prefix while reporting the full virtual file size and identity", () => {
		const storage = new MemorySessionStorage();
		const payload = "Y".repeat(2048);
		storage.writeTextSync("/sessions/big.jsonl", payload);
		const snapshot = storage.readSnapshotPrefixSync("/sessions/big.jsonl", 32);
		expect(snapshot.bytes.length).toBe(32);
		// stat.size is the full virtual file; bytes is the bounded prefix.
		expect(snapshot.stat.size).toBe(payload.length);
		const full = storage.readSnapshotSync("/sessions/big.jsonl");
		expect(snapshot.stat.ino).toBe(full.stat.ino);
	});
});

describe("SessionManager.inventorySessionsStrict missing-newline header rejection", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-strict-nl-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("flags a header missing its terminating newline within the bounded prefix (zero authority)", async () => {
		// A valid session header object but with NO trailing newline: the strict
		// inventory cannot bound the header within its prefix and must fail closed.
		const file = path.join(tempDir, "no-newline.jsonl");
		await Bun.write(file, JSON.stringify({ type: "session", id: "no-nl", cwd: tempDir }));
		const result = SessionManager.inventorySessionsStrict(tempDir, { sessionDir: tempDir, storage });
		expect(result.kind).toBe("failure");
		// Zero authority: a failure grants no candidate set at all.
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") throw new Error("unreachable");
		expect(result.failures).toEqual([expect.objectContaining({ kind: "parse", path: file })]);
		expect(result.failures[0]!.message).toMatch(/terminating newline/);
		// The transcript is untouched — the inventory never mutates.
		expect(fs.existsSync(file)).toBe(true);
	});

	it("flags an overlong header whose first newline lies beyond the bounded prefix", async () => {
		// First line exceeds the 1 MiB inventory prefix: no terminating newline is
		// observable within the bounded read, so the header cannot be bounded.
		const file = path.join(tempDir, "overlong.jsonl");
		const overlong = `{ "type": "session", "id": "overlong", "cwd": ${JSON.stringify(tempDir)}, "pad": "${"z".repeat(STRICT_INVENTORY_HEADER_PREFIX_BYTES + 64)}"}`;
		await Bun.write(file, overlong);
		const result = SessionManager.inventorySessionsStrict(tempDir, { sessionDir: tempDir, storage });
		expect(result.kind).toBe("failure");
		expect(result).not.toHaveProperty("candidates");
		if (result.kind !== "failure") throw new Error("unreachable");
		expect(result.failures[0]!.kind).toBe("parse");
		expect(result.failures[0]!.message).toMatch(/terminating newline/);
	});
});

describe("FileSessionStorage.publishTranscriptExclusive exclusive publication", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-publish-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("fails without clobbering a pre-existing destination (destination + stage untouched)", async () => {
		const stage = path.join(tempDir, ".stage.jsonl");
		const dest = path.join(tempDir, "final.jsonl");
		await Bun.write(stage, "stage payload");
		await Bun.write(dest, "pre-existing destination bytes");
		// linkSync to an existing destination fails with EEXIST — never overwrites.
		await expect(storage.publishTranscriptExclusive(stage, dest)).rejects.toThrow();
		// Destination bytes are unchanged; the stage survives for caller cleanup.
		expect(await Bun.file(dest).text()).toBe("pre-existing destination bytes");
		expect(fs.existsSync(stage)).toBe(true);
		expect(await Bun.file(stage).text()).toBe("stage payload");
	});

	it("commits by linking the stage to the final name and then removing the stage", async () => {
		const stage = path.join(tempDir, ".stage2.jsonl");
		const dest = path.join(tempDir, "final2.jsonl");
		await Bun.write(stage, "committed payload");
		await storage.publishTranscriptExclusive(stage, dest);
		expect(fs.existsSync(stage)).toBe(false);
		expect(await Bun.file(dest).text()).toBe("committed payload");
	});
});

describe("MemorySessionStorage.publishTranscriptExclusive exclusive publication", () => {
	it("rejects without overwriting or merging a pre-existing destination", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync("/sessions/.stage.jsonl", "stage payload");
		storage.writeTextSync("/sessions/final.jsonl", "destination sentinel");
		await expect(
			storage.publishTranscriptExclusive("/sessions/.stage.jsonl", "/sessions/final.jsonl"),
		).rejects.toThrow(/Destination already exists/);
		// Destination content unchanged; stage retained.
		expect(storage.readTextSync("/sessions/final.jsonl")).toBe("destination sentinel");
		expect(storage.existsSync("/sessions/.stage.jsonl")).toBe(true);
	});

	it("moves the stage to the final name atomically when the destination is new", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync("/sessions/.stage.jsonl", "moved payload");
		await storage.publishTranscriptExclusive("/sessions/.stage.jsonl", "/sessions/final.jsonl");
		expect(storage.existsSync("/sessions/.stage.jsonl")).toBe(false);
		expect(storage.readTextSync("/sessions/final.jsonl")).toBe("moved payload");
	});
});

describe("cloneArtifactsExclusive transactional artifact clone", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-clone-"));
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("refuses a pre-existing destination without mutating source or destination", async () => {
		const source = path.join(tempDir, "src");
		const dest = path.join(tempDir, "dst");
		await fsp.mkdir(source, { recursive: true });
		await Bun.write(path.join(source, "a.txt"), "a");
		await fsp.mkdir(dest, { recursive: true });
		await Bun.write(path.join(dest, "existing"), "destination sentinel");
		await expect(cloneArtifactsExclusive(source, dest)).rejects.toThrow(/already exists/);
		// Neither source nor destination is touched.
		expect(await Bun.file(path.join(dest, "existing")).text()).toBe("destination sentinel");
		expect(await Bun.file(path.join(source, "a.txt")).text()).toBe("a");
	});

	it("succeeds as a no-op when the source is absent (no destination created)", async () => {
		const dest = path.join(tempDir, "absent-dst");
		expect(await cloneArtifactsExclusive(path.join(tempDir, "missing"), dest)).toBe(false);
		expect(fs.existsSync(dest)).toBe(false);
	});

	it("rejects a pre-existing destination even when the source is absent", async () => {
		const dest = path.join(tempDir, "existing-absent-dst");
		await fsp.mkdir(dest, { recursive: false });
		await Bun.write(path.join(dest, "sentinel.txt"), "sentinel");

		await expect(cloneArtifactsExclusive(path.join(tempDir, "missing"), dest)).rejects.toThrow(/already exists/);
		expect(await Bun.file(path.join(dest, "sentinel.txt")).text()).toBe("sentinel");
	});

	it("removes the transaction-owned destination on an injected special (symlink) entry", async () => {
		const source = path.join(tempDir, "src");
		const dest = path.join(tempDir, "dst");
		await fsp.mkdir(source, { recursive: true });
		await Bun.write(path.join(source, "regular.txt"), "regular");
		// A symlink inside the source: special entries are refused mid-clone.
		const target = path.join(tempDir, "link-target");
		await Bun.write(target, "target");
		await fsp.symlink(target, path.join(source, "evil-link"));
		await expect(cloneArtifactsExclusive(source, dest)).rejects.toThrow(/non-regular artifact entry/);
		// The transaction-owned destination is removed; the source (incl. symlink) is untouched.
		expect(fs.existsSync(dest)).toBe(false);
		expect(await Bun.file(path.join(source, "regular.txt")).text()).toBe("regular");
		expect(fs.lstatSync(path.join(source, "evil-link")).isSymbolicLink()).toBe(true);
	});

	it("rejects a symlinked artifact root without creating a destination", async () => {
		const actualSource = path.join(tempDir, "actual-src");
		const sourceLink = path.join(tempDir, "src-link");
		const dest = path.join(tempDir, "dst");
		await fsp.mkdir(actualSource, { recursive: true });
		await Bun.write(path.join(actualSource, "secret.txt"), "secret");
		await fsp.symlink(actualSource, sourceLink);

		await expect(cloneArtifactsExclusive(sourceLink, dest)).rejects.toThrow(/not a regular directory/);
		expect(fs.existsSync(dest)).toBe(false);
		expect(await Bun.file(path.join(actualSource, "secret.txt")).text()).toBe("secret");
	});

	it("clones regular files and nested directories exclusively into a new destination", async () => {
		const source = path.join(tempDir, "src");
		const dest = path.join(tempDir, "dst");
		await fsp.mkdir(path.join(source, "nested"), { recursive: true });
		await Bun.write(path.join(source, "a.txt"), "a");
		await Bun.write(path.join(source, "nested", "b.txt"), "b");
		expect(await cloneArtifactsExclusive(source, dest)).toBe(true);
		expect(await Bun.file(path.join(dest, "a.txt")).text()).toBe("a");
		expect(await Bun.file(path.join(dest, "nested", "b.txt")).text()).toBe("b");
	});
});

describe("readSelectedSessionSnapshot captured-bytes hydration", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-selected-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	function makeCandidate(file: string, id = "selected-id"): StrictInventoryCandidate {
		const stat = storage.statSync(file);
		return { path: file, id, cwd: tempDir, identity: stat };
	}

	it("captures exact bytes bound to the verified descriptor in one read", async () => {
		const header = JSON.stringify({ type: "session", id: "selected-id", cwd: tempDir });
		const body = JSON.stringify({ type: "message", role: "user", content: "hi" });
		const file = path.join(tempDir, "selected.jsonl");
		await Bun.write(file, `${header}\n${body}\n`);
		const result = readSelectedSessionSnapshot(storage, makeCandidate(file), tempDir);
		if ("failures" in result) throw new Error(`expected snapshot, got ${result.failures[0]!.kind}`);
		// Hydration bytes equal the exact file content and bind to the candidate identity.
		expect(new TextDecoder().decode(result.bytes)).toBe(`${header}\n${body}\n`);
		expect(result.identity.dev).toBe(result.candidate.identity.dev);
		expect(result.identity.ino).toBe(result.candidate.identity.ino);
	});

	it("uses captured bytes rather than reopening a replaced pathname, and fails closed on identity change", async () => {
		const header = JSON.stringify({ type: "session", id: "selected-id", cwd: tempDir });
		const originalBody = "ORIGINAL-BODY";
		const file = path.join(tempDir, "replaceable.jsonl");
		await Bun.write(file, `${header}\n${originalBody}\n`);
		// Capture the candidate ONCE — its identity binds the original descriptor.
		const candidate = makeCandidate(file);
		const result = readSelectedSessionSnapshot(storage, candidate, tempDir);
		if ("failures" in result) throw new Error("expected snapshot before replacement");
		// Create the replacement while the original inode is still allocated, then
		// swap the pathname. This makes the identity change deterministic even on
		// filesystems that immediately reuse an inode after unlink.
		const replacement = `${file}.replacement`;
		await Bun.write(replacement, `${header}\nREPLACEMENT-BODY\n`);
		await fsp.unlink(file);
		await fsp.rename(replacement, file);
		// The captured bytes still reflect the ORIGINAL content — hydration did not
		// reopen the now-replaced pathname.
		expect(new TextDecoder().decode(result.bytes)).toBe(`${header}\n${originalBody}\n`);
		expect(new TextDecoder().decode(result.bytes)).not.toContain("REPLACEMENT-BODY");
		// A fresh read bound to the SAME (old) candidate identity fails closed: the
		// replaced file has a different (dev, ino), so zero authority is issued.
		const rebound = readSelectedSessionSnapshot(storage, candidate, tempDir);
		expect("failures" in rebound).toBe(true);
		if ("failures" in rebound) {
			expect(rebound.failures[0]!.kind).toBe("identity");
		}
	});
});
