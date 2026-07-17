import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { publishManagedFileNoReplace } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
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

	it("deletes sessions and artifacts in an explicit operator-selected directory", async () => {
		const sessionPath = await createSessionFile("direct-delete");
		const artifactsDir = sessionPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "artifact payload");

		await storage.deleteSessionWithArtifacts(sessionPath);

		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	describe("fenced managed publication", () => {
		it("rejects an expired lease immediately before no-replace publication", async () => {
			const destination = path.join(tempDir, "fenced-receipt.json");
			let assertions = 0;
			await expect(
				publishManagedFileNoReplace(destination, new TextEncoder().encode("receipt"), () => {
					assertions++;
					if (assertions === 2) throw new Error("migration_busy");
				}),
			).rejects.toThrow("migration_busy");
			expect(fs.existsSync(destination)).toBe(false);
		});
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

describe("FileSessionStorageWriter path security", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-writer-security-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("applies owner-only security to every independently-created writer file", async () => {
		const first = path.join(tempDir, "first.jsonl");
		const second = path.join(tempDir, "second.jsonl");
		const firstWriter = storage.openWriter(first, { flags: "w" });
		const secondWriter = storage.openWriter(second, { flags: "w" });
		firstWriter.writeLineSync("first\n");
		secondWriter.writeLineSync("second\n");
		await firstWriter.close();
		await secondWriter.close();

		if (process.platform !== "win32") {
			expect(fs.statSync(first).mode & 0o777).toBe(0o600);
			expect(fs.statSync(second).mode & 0o777).toBe(0o600);
		}
	});

	it("rejects a symlinked or junctioned storage parent before opening the writer", async () => {
		const target = path.join(tempDir, "target");
		const alias = path.join(tempDir, "alias");
		await fsp.mkdir(target);
		await fsp.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
		expect(() => storage.openWriter(path.join(alias, "session.jsonl"))).toThrow("Unsafe reparse storage path");
		expect(fs.existsSync(path.join(target, "session.jsonl"))).toBe(false);
	});
});

describe("FileSessionStorage.deleteSessionVerified artifact-first", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-verified-delete-"));
		storage = new FileSessionStorage();
		const deleteSessionVerified = storage.deleteSessionVerified.bind(storage);
		let plannedAttempt = 0;
		storage.deleteSessionVerified = target => {
			const attempt = ++plannedAttempt;
			return deleteSessionVerified({
				...target,
				plannedArtifactsPath:
					target.plannedArtifactsPath ??
					path.join(path.dirname(target.transcriptPath), `.gjc-delete-test-artifacts-${attempt}`),
				plannedTranscriptPath:
					target.plannedTranscriptPath ??
					path.join(path.dirname(target.transcriptPath), `.gjc-delete-test-transcript-${attempt}`),
			});
		};
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

	function verifiedIdentity(transcriptPath: string) {
		const snapshot = storage.readSnapshotSync(transcriptPath);
		return {
			dev: snapshot.stat.dev,
			ino: snapshot.stat.ino,
			size: snapshot.stat.size,
			mtimeNs: snapshot.stat.mtimeNs,
			sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
		};
	}

	it("removes the verified artifact directory first, then the transcript last", async () => {
		const transcriptPath = await createTranscript("happy");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
			plannedArtifactsPath: path.join(tempDir, ".gjc-delete-happy-artifacts"),
			plannedTranscriptPath: path.join(tempDir, ".gjc-delete-happy-transcript"),
		};
		const artifacts = await storage.deleteSessionVerified(target);
		expect(artifacts).toMatchObject({ kind: "artifacts_removed", phase: "artifacts" });
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		const result = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true });
		expect(result).toEqual({ kind: "deleted" });
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(false);
	});

	it.skipIf(process.platform !== "linux")(
		"does not report artifacts removed before the session parent is durable",
		async () => {
			const transcriptPath = await createTranscript("artifact-parent-fsync");
			const artifactsDir = transcriptPath.slice(0, -6);
			await fsp.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");
			const target: VerifiedSessionDeleteTarget = {
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: verifiedIdentity(transcriptPath),
			};
			const expectedParent = fs.realpathSync(tempDir);
			const fsync = fs.fsyncSync;
			vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
				if (fs.readlinkSync(`/proc/self/fd/${descriptor}`) === expectedParent) throw new Error("fsync failed");
				return fsync(descriptor);
			});

			const error = await storage.deleteSessionVerified(target).catch(value => value);

			expect(error).toBeInstanceOf(SessionDeleteVerificationError);
			expect((error as SessionDeleteVerificationError).kind).toBe("artifacts");
			expect(fs.existsSync(transcriptPath)).toBe(true);
			expect(fs.existsSync(artifactsDir)).toBe(false);
		},
	);

	it("artifact rm failure returns cleanup_pending and leaves the transcript intact for retry", async () => {
		const transcriptPath = await createTranscript("partial");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValueOnce({ ok: false, code: "io_error" });

		const stat = storage.readSnapshotSync(transcriptPath).stat;
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
		};

		const result = await storage.deleteSessionVerified(target);
		expect(result.kind).toBe("cleanup_pending");
		if (result.kind !== "cleanup_pending" || result.phase !== "artifacts") throw new Error("unreachable");
		expect(result.phase).toBe("artifacts");
		// Atomic detach keeps the transcript authoritative while quarantining artifacts for retry.
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(result.detachedArtifactsPath)).toBe(true);
		expect(result.transcriptIdentity).toMatchObject({ dev: stat.dev, ino: stat.ino });
	});

	it("retains the persisted POSIX tree authority path when recursive removal fails", async () => {
		if (process.platform === "win32") return;
		const transcriptPath = await createTranscript("tree-root-retained");
		const artifactsDir = transcriptPath.slice(0, -6);
		const plannedArtifactsPath = path.join(tempDir, ".gjc-delete-tree-root-q1");
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");
		let removalRoot: string | undefined;
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(pathname => {
			removalRoot = pathname;
			return { ok: false, code: "io_error", detachedPath: pathname };
		});
		try {
			const result = await storage.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: verifiedIdentity(transcriptPath),
				plannedArtifactsPath,
				plannedTranscriptPath: path.join(tempDir, ".gjc-delete-tree-root-transcript"),
			});
			if (result.kind !== "cleanup_pending" || result.phase !== "artifacts")
				throw new Error("Expected pending tree cleanup");
			expect(removalRoot).toBe(plannedArtifactsPath);
			expect(result.detachedArtifactsPath).toBe(plannedArtifactsPath);
			expect(await fsp.stat(artifactsDir).catch(() => undefined)).toBeUndefined();
			expect(await fsp.stat(plannedArtifactsPath)).toBeDefined();
		} finally {
			remove.mockRestore();
		}
	});
	it("retries a partial tree removal from its deterministic .removing authority", async () => {
		const transcriptPath = await createTranscript("tree-removing-retry");
		const artifactsDir = transcriptPath.slice(0, -6);
		const plannedArtifactsPath = path.join(tempDir, ".gjc-delete-tree-root-q1");
		const removalRoot = `${plannedArtifactsPath}.removing`;
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");
		let restored = false;
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(pathname => {
			fs.renameSync(pathname, removalRoot);
			return { ok: false, code: "io_error", detachedPath: removalRoot };
		});

		try {
			const target: VerifiedSessionDeleteTarget = {
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: verifiedIdentity(transcriptPath),
				plannedArtifactsPath,
				plannedTranscriptPath: path.join(tempDir, ".gjc-delete-tree-root-transcript"),
			};
			const pending = await storage.deleteSessionVerified(target);
			if (pending.kind !== "cleanup_pending" || pending.phase !== "artifacts")
				throw new Error("Expected pending tree cleanup");
			expect(pending.detachedArtifactsPath).toBe(removalRoot);
			expect(await fsp.stat(removalRoot)).toBeDefined();
			remove.mockRestore();
			restored = true;

			const retried = await storage.deleteSessionVerified({
				...target,
				expectedArtifactsIdentity: pending.artifactsIdentity,
				expectedArtifactsTree: pending.artifactsTree,
				detachedArtifactsPath: removalRoot,
			});
			expect(retried.kind).toBe("artifacts_removed");
		} finally {
			if (!restored) remove.mockRestore();
		}
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
			transcriptIdentity: { dev: 1n, ino: 2n, size: 0, mtimeNs: 0n, sha256: "0".repeat(64) },
		};

		await expect(storage.deleteSessionVerified(target)).rejects.toBeInstanceOf(SessionDeleteVerificationError);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});

	it("rejects a transcript whose authorization hash differs before artifact mutation", async () => {
		const transcriptPath = await createTranscript("authorization-hash");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		const snapshot = storage.readSnapshotSync(transcriptPath);

		const err = await storage
			.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: {
					dev: snapshot.stat.dev,
					ino: snapshot.stat.ino,
					size: snapshot.stat.size,
					mtimeNs: snapshot.stat.mtimeNs,
					sha256: "0".repeat(64),
				},
			})
			.catch(error => error);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
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
			transcriptIdentity: verifiedIdentity(transcriptPath),
		};

		// First attempt: artifact removal fails (the once-mock affects only this call).
		const rmSpy = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValueOnce({ ok: false, code: "io_error" });

		const partial = await storage.deleteSessionVerified(target);
		// No false success: this is a typed partial cleanup, never "deleted".
		expect(partial.kind).toBe("cleanup_pending");
		if (partial.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(partial.phase).toBe("artifacts");
		expect(partial.error).toBeInstanceOf(Error);
		expect(partial.error.message).toBe("Exact detached artifact removal rejected: io_error");
		// Exact retry evidence includes the full transcript snapshot and detached artifact path.
		expect(partial.transcriptIdentity).toMatchObject({ dev: stat.dev, ino: stat.ino });
		const artifactCleanup = partial as Extract<
			VerifiedSessionDeleteResult,
			{ kind: "cleanup_pending"; phase: "artifacts" }
		>;
		const recordedArtifactsIdentity = artifactCleanup.artifactsIdentity;
		expect(recordedArtifactsIdentity).toBeDefined();
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(artifactCleanup.detachedArtifactsPath)).toBe(true);

		// Restore the rm spy so the real cleanup runs on retry.
		rmSpy.mockRestore();

		// Retry bound to the recorded artifact identity: same directory matches and the
		// verified hard delete completes.
		const retriedArtifacts = await storage.deleteSessionVerified({
			...target,
			expectedArtifactsIdentity: recordedArtifactsIdentity,
			expectedArtifactsTree: artifactCleanup.artifactsTree,
			detachedArtifactsPath: artifactCleanup.detachedArtifactsPath,
		});
		expect(retriedArtifacts.kind).toBe("artifacts_removed");
		const retried = await storage.deleteSessionVerified({
			...target,
			expectedArtifactsIdentity: undefined,
			detachedArtifactsPath: undefined,
			artifactsRemoved: true,
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
			transcriptIdentity: verifiedIdentity(transcriptPath),
		};

		const exactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) =>
			identity.directory ? exactUnlink(pathname, identity) : { ok: false, code: "io_error" },
		);

		const artifactsRemoved = await storage.deleteSessionVerified(target);
		expect(artifactsRemoved.kind).toBe("artifacts_removed");
		const result = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true });
		expect(result.kind).toBe("cleanup_pending");
		if (result.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(result.phase).toBe("transcript");
		expect(result.error).toBeInstanceOf(Error);
		expect(result.transcriptIdentity).toMatchObject({ dev: stat.dev, ino: stat.ino });
		// Artifacts were removed first (intended); the transcript survives (no data loss).
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("returns the native detached transcript path after a post-detach failure", async () => {
		const transcriptPath = await createTranscript("detached-transcript-evidence");
		const plannedTranscriptPath = path.join(tempDir, ".gjc-delete-transcript-planned");
		const expectedIdentity = verifiedIdentity(transcriptPath);
		const exactUnlink = native.exactUnlink;
		let nativeTranscriptSha256: string | undefined;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (identity.directory) return exactUnlink(pathname, identity);
			nativeTranscriptSha256 = (identity as { sha256?: string }).sha256;
			return { ok: false, code: "io_error", detachedPath: plannedTranscriptPath };
		});
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: expectedIdentity,
			plannedTranscriptPath,
		};
		expect((await storage.deleteSessionVerified(target)).kind).toBe("artifacts_removed");
		const result = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true });
		if (result.kind !== "cleanup_pending" || result.phase !== "transcript") throw new Error("unreachable");
		expect(result.detachedTranscriptPath).toBe(plannedTranscriptPath);
		expect(nativeTranscriptSha256).toBe(expectedIdentity.sha256);
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

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
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
			transcriptIdentity: { dev: 0n, ino: 0n, size: 0, mtimeNs: 0n, sha256: "0".repeat(64) },
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("symlink");
		// No mutation: the symlink and its target are intact.
		expect(fs.lstatSync(transcriptPath).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(realTranscript)).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"rejects a hardlink replacement whose identity was not authorized",
		async () => {
			const transcriptPath = await createTranscript("hardlink-authorized");
			const foreignTranscript = path.join(tempDir, "hardlink-foreign.jsonl");
			await Bun.write(
				foreignTranscript,
				`${JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
			);
			const authorized = storage.readSnapshotSync(transcriptPath).stat;
			await fsp.unlink(transcriptPath);
			await fsp.link(foreignTranscript, transcriptPath);

			const err = await storage
				.deleteSessionVerified({
					sessionsRoot: tempDir,
					transcriptPath,
					sessionId: "session-id",
					cwd: tempDir,
					transcriptIdentity: {
						dev: authorized.dev,
						ino: authorized.ino,
						size: authorized.size,
						mtimeNs: authorized.mtimeNs,
						sha256: createHash("sha256").update(storage.readSnapshotSync(transcriptPath).bytes).digest("hex"),
					},
				})
				.catch(error => error);
			expect(err).toBeInstanceOf(SessionDeleteVerificationError);
			expect((err as SessionDeleteVerificationError).kind).toBe("identity");
			expect(fs.existsSync(transcriptPath)).toBe(true);
			expect(fs.existsSync(foreignTranscript)).toBe(true);
		},
	);

	it("rejects a symlinked sessions-root component before verified deletion", async () => {
		if (process.platform === "win32") return;
		const realRoot = path.join(tempDir, "real-sessions");
		const aliasRoot = path.join(tempDir, "sessions-alias");
		await fsp.mkdir(realRoot);
		const realTranscript = path.join(realRoot, "aliased.jsonl");
		await Bun.write(
			realTranscript,
			`${JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
		);
		await fsp.symlink(realRoot, aliasRoot);
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot: aliasRoot,
				transcriptPath: path.join(aliasRoot, "aliased.jsonl"),
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: verifiedIdentity(realTranscript),
			})
			.catch(error => error);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("symlink");
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
			transcriptIdentity: {
				dev: realSnapshot.stat.dev,
				ino: realSnapshot.stat.ino,
				size: realSnapshot.stat.size,
				mtimeNs: realSnapshot.stat.mtimeNs,
				sha256: createHash("sha256").update(realSnapshot.bytes).digest("hex"),
			},
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

		expect((await storage.deleteSessionVerified(target)).kind).toBe("artifacts_removed");
		const err = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true }).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect((err as Error).message).toContain("identity does not match authorization");
		// Artifacts were removed (intended); the transcript was never unlinked (no data loss).
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("retry with a replaced artifact directory identity fails closed before mutation", async () => {
		const transcriptPath = await createTranscript("replaced-retry");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		// First attempt: artifact rm fails and records the real artifact identity.
		const rmSpy = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValueOnce({ ok: false, code: "io_error" });
		const partial = await storage.deleteSessionVerified({
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
		});
		if (partial.kind !== "cleanup_pending" || partial.phase !== "artifacts") throw new Error("unreachable");
		const recordedArtifactsIdentity = partial.artifactsIdentity;
		expect(recordedArtifactsIdentity).toBeDefined();
		expect(fs.existsSync(partial.detachedArtifactsPath)).toBe(true);
		rmSpy.mockRestore();

		// Install a replacement at the original artifact pathname while the authorized
		// directory remains quarantined under the detached cleanup path.
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
				transcriptIdentity: verifiedIdentity(transcriptPath),
				expectedArtifactsIdentity: recordedArtifactsIdentity,
				detachedArtifactsPath: partial.detachedArtifactsPath,
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

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
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

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
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

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: outsideRoot, // root that does NOT contain the transcript
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("containment");
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("a header cwd mismatch is rejected as a cwd failure before mutation", async () => {
		const transcriptPath = await createTranscript("cwd-mismatch");

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/totally/different/cwd",
			transcriptIdentity: verifiedIdentity(transcriptPath),
		};

		const err = await storage.deleteSessionVerified(target).catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("cwd");
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});
	it("rejects an in-place transcript append after authorization without unlinking the changed transcript", async () => {
		const transcriptPath = await createTranscript("append-after-authorization");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		const authorizedIdentity = verifiedIdentity(transcriptPath);
		const readSnapshot = storage.readSnapshotSync.bind(storage);
		let reads = 0;
		vi.spyOn(storage, "readSnapshotSync").mockImplementation(pathname => {
			reads++;
			if (reads === 2) fs.appendFileSync(pathname, `${JSON.stringify({ type: "message", detail: "raced" })}\n`);
			return readSnapshot(pathname);
		});

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: authorizedIdentity,
		};
		expect((await storage.deleteSessionVerified(target)).kind).toBe("artifacts_removed");
		const err = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true }).catch(error => error);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect(await fsp.readFile(transcriptPath, "utf8")).toContain('"raced"');
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("does not unlink a final-name replacement introduced at the exact-unlink boundary", async () => {
		const transcriptPath = await createTranscript("exact-final-name-replacement");
		const authorizedIdentity = verifiedIdentity(transcriptPath);
		const replacement = path.join(tempDir, "exact-final-name-replacement-foreign.jsonl");
		await Bun.write(
			replacement,
			`${JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir, foreign: true })}\n`,
		);
		const exactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			fs.renameSync(pathname, `${pathname}.authorized`);
			fs.renameSync(replacement, pathname);
			return exactUnlink(pathname, identity);
		});

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: authorizedIdentity,
		};
		expect((await storage.deleteSessionVerified(target)).kind).toBe("artifacts_removed");
		const err = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true }).catch(error => error);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect(await fsp.readFile(transcriptPath, "utf8")).toContain('"foreign":true');
		expect(fs.existsSync(`${transcriptPath}.authorized`)).toBe(true);
	});

	it("fails closed when the artifact directory is replaced between authorization and removal", async () => {
		const transcriptPath = await createTranscript("artifact-final-name-replacement");
		const artifactsDir = transcriptPath.slice(0, -6);
		const retained = `${artifactsDir}.authorized`;
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "authorized.txt"), "authorized");
		const authorizedIdentity = verifiedIdentity(transcriptPath);
		const exactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === artifactsDir && identity.directory) {
				fs.renameSync(artifactsDir, retained);
				fs.mkdirSync(artifactsDir);
				fs.writeFileSync(path.join(artifactsDir, "replacement.txt"), "foreign");
			}
			return exactUnlink(pathname, identity);
		});

		const err = await storage
			.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: authorizedIdentity,
			})
			.catch(error => error);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(await fsp.readFile(path.join(artifactsDir, "replacement.txt"), "utf8")).toBe("foreign");
		expect(await fsp.readFile(path.join(retained, "authorized.txt"), "utf8")).toBe("authorized");
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

	function verifiedIdentity(transcriptPath: string) {
		const snapshot = storage.readSnapshotSync(transcriptPath);
		return {
			dev: snapshot.stat.dev,
			ino: snapshot.stat.ino,
			size: snapshot.stat.size,
			mtimeNs: snapshot.stat.mtimeNs,
			sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
		};
	}

	it("deletes a verified matching transcript", async () => {
		const transcriptPath = path.join(sessionsRoot, "s.jsonl");
		seedTranscript(transcriptPath);
		const result = await storage.deleteSessionVerified({
			sessionsRoot,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/cwd",
			transcriptIdentity: verifiedIdentity(transcriptPath),
		});
		expect(result).toEqual({ kind: "deleted" });
		expect(storage.existsSync(transcriptPath)).toBe(false);
	});

	it("rejects a transcript outside the sessions root (containment parity)", async () => {
		const transcriptPath = "/elsewhere/s.jsonl";
		seedTranscript(transcriptPath);
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("containment");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("requires header type:'session' (header parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "artifact.jsonl");
		seedTranscript(transcriptPath, { type: "artifact", id: "session-id", cwd: "/cwd" });
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("header");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects an exact id/cwd mismatch without mutation", async () => {
		const transcriptPath = path.join(sessionsRoot, "id.jsonl");
		seedTranscript(transcriptPath, { type: "session", id: "real-id", cwd: "/cwd" });
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "wrong-id",
				cwd: "/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
			})
			.catch(e => e);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect(storage.existsSync(transcriptPath)).toBe(true);
	});

	it("rejects a header cwd mismatch without mutation (cwd parity)", async () => {
		const transcriptPath = path.join(sessionsRoot, "cwd.jsonl");
		seedTranscript(transcriptPath, { type: "session", id: "session-id", cwd: "/cwd" });
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/totally/different/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
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
		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
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
