import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import {
	captureManagedFileNoFollow,
	captureManagedFileNoFollowBounded,
	ensureManagedDirectory,
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	ManagedCommittedMutationError,
	type ManagedFileIdentity,
	ManagedReplaceError,
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
	publishManagedFileNoReplace,
	publishManagedFileNoReplaceSync,
	renameFlagsUnsupported,
	replaceManagedFileSync,
	retainManagedDirectoryAuthority,
	validateNativeSecurityResult,
} from "../src/session/internal/managed-session-storage";
import {
	classifyNativePublishOutcome,
	formatNativePublishDiagnostic,
	mayCleanCurrentStaging,
} from "../src/session/internal/native-publish-outcome";

import { SessionManager } from "../src/session/session-manager";
import {
	createManagedSessionSecurityContext,
	FileSessionStorage,
	MemorySessionStorage,
	SessionDeleteVerificationError,
	type SessionStorage,
	type SessionStorageWriterOpenOptions,
	SessionStorageWriterRetryableCloseError,
	type VerifiedSessionDeleteResult,
	type VerifiedSessionDeleteTarget,
} from "../src/session/session-storage";

describe("native publish outcome classification", () => {
	const preMutation = {
		ok: false,
		code: "atomic_unavailable",
		mutationState: "not_committed",
		durabilityState: "not_attempted",
		reason: "atomic_unavailable",
		primitive: "renameat2_noreplace",
		phase: "rename",
		diagnostic: { schemaVersion: 1, collectionState: "complete", osCode: 38 },
	};

	it("allows staging-only cleanup only for a complete known pre-mutation envelope", () => {
		expect(mayCleanCurrentStaging(classifyNativePublishOutcome(preMutation))).toBe(true);
		expect(
			mayCleanCurrentStaging(
				classifyNativePublishOutcome({
					...preMutation,
					mutationState: "committed",
					durabilityState: "not_provable",
				}),
			),
		).toBe(false);
	});

	// A filesystem that implements no renameat2 rename flag rejects the publish
	// before mutating anything, and only then may the caller retry under linkat.
	// Retrying any other failure could publish the same staged object twice, so
	// this gate is the whole safety argument for the fallback.
	it("authorizes the linkat fallback only for pre-mutation missing-primitive envelopes", () => {
		for (const reason of ["atomic_unavailable", "invalid_request"] as const) {
			expect(
				renameFlagsUnsupported(
					classifyNativePublishOutcome({
						...preMutation,
						reason,
						code: reason,
						phase: reason === "invalid_request" ? "preflight" : "rename",
					}),
				),
			).toBe(true);
		}

		// Every other pre-mutation reason is a real answer from a working
		// primitive, not evidence that the primitive is missing. Retrying those
		// under linkat would re-ask a question already answered, and for reasons
		// whose namespace effect is not provable it could publish twice.
		for (const [reason, code] of [
			["destination_exists", "already_exists"],
			["cross_device", "cross_device"],
			["permission_denied", "permission_denied"],
			["io_failure", "io_error"],
			["interrupted", "interrupted"],
		] as const) {
			expect(renameFlagsUnsupported(classifyNativePublishOutcome({ ...preMutation, reason, code }))).toBe(false);
		}

		// An envelope this build cannot validate is never a fallback candidate.
		expect(
			renameFlagsUnsupported(
				classifyNativePublishOutcome({
					...preMutation,
					diagnostic: { schemaVersion: 1, collectionState: "complete", path: "/secret" },
				}),
			),
		).toBe(false);

		// A publish that already succeeded is not a candidate for any fallback.
		expect(
			renameFlagsUnsupported(
				classifyNativePublishOutcome({
					...preMutation,
					ok: true,
					code: undefined,
					reason: "none",
					mutationState: "committed",
					phase: "complete",
				}),
			),
		).toBe(false);
	});

	it("fails malformed and path-bearing envelopes closed without formatting unsafe values", () => {
		const outcome = classifyNativePublishOutcome({
			...preMutation,
			diagnostic: { schemaVersion: 1, collectionState: "complete", path: "/secret" },
		});
		expect(outcome.mutationState).toBe("unknown");
		expect(mayCleanCurrentStaging(outcome)).toBe(false);
		expect(formatNativePublishDiagnostic(outcome)).not.toContain("secret");
	});

	it("accepts direct no-replace envelopes while preserving unknown failures closed", () => {
		for (const [reason, code] of [
			["destination_exists", "already_exists"],
			["cross_device", "cross_device"],
			["permission_denied", "permission_denied"],
			["io_failure", "io_error"],
			// A signal landing on the no-replace rename syscall before it enters the
			// kernel never mutates the filesystem, so a pre-mutation "interrupted"
			// envelope for the rename phase must classify (and permit staging
			// cleanup) exactly like the other retryable pre-mutation reasons above.
			// Regression coverage for a large legacy-session migration crashing with
			// an uncaught "durability_failed" the first time a rename syscall was
			// interrupted partway through migrating thousands of artifact files.
			["interrupted", "interrupted"],
		] as const) {
			const outcome = classifyNativePublishOutcome({ ...preMutation, reason, code, phase: "rename" });
			expect(outcome.reason).toBe(reason);
			expect(mayCleanCurrentStaging(outcome)).toBe(true);
		}
		const committed = classifyNativePublishOutcome({
			...preMutation,
			ok: true,
			code: undefined,
			mutationState: "committed",
			durabilityState: "not_attempted",
			reason: "none",
			phase: "complete",
		});
		expect(committed.mutationState).toBe("committed");
		expect(mayCleanCurrentStaging(committed)).toBe(false);
		const unknown = classifyNativePublishOutcome({
			...preMutation,
			code: "interrupted",
			mutationState: "unknown",
			durabilityState: "not_provable",
			reason: "unknown",
			phase: "rename",
		});
		expect(unknown.mutationState).toBe("unknown");
		expect(mayCleanCurrentStaging(unknown)).toBe(false);
		expect(classifyNativePublishOutcome({ ...unknown, phase: "terminal_identity" }).mutationState).toBe("unknown");
		expect(
			classifyNativePublishOutcome({
				...preMutation,
				reason: "cross_device",
				code: "cross_device",
				phase: "preflight",
			}).reason,
		).toBe("unknown");
	});

	it("rejects a direct-rename success envelope when retained publication requires durability proof", () => {
		const directSuccess = {
			...preMutation,
			ok: true,
			code: undefined,
			mutationState: "committed",
			durabilityState: "not_attempted",
			reason: "none",
			phase: "complete",
		};
		expect(classifyNativePublishOutcome(directSuccess).ok).toBe(true);
		const retained = classifyNativePublishOutcome(directSuccess, "retained_file");
		expect(retained.mutationState).toBe("unknown");
		expect(mayCleanCurrentStaging(retained)).toBe(false);
	});

	it("accepts a retained success only with terminal identity and proven durability", () => {
		const retained = classifyNativePublishOutcome(
			{
				...preMutation,
				ok: true,
				code: undefined,
				identity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5", sha256: "a".repeat(64) },
				mutationState: "committed",
				durabilityState: "proven",
				reason: "none",
				phase: "complete",
			},
			"retained_tree",
		);
		expect(retained.ok).toBe(true);
	});

	it("accepts only the fallback primitive for each retained publish shape", () => {
		const success = {
			...preMutation,
			ok: true,
			code: undefined,
			identity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5", sha256: "a".repeat(64) },
			mutationState: "committed",
			durabilityState: "proven",
			reason: "none",
			phase: "complete",
		};
		expect(classifyNativePublishOutcome({ ...success, primitive: "linkat_noreplace" }, "retained_file").ok).toBe(
			true,
		);
		expect(
			classifyNativePublishOutcome({ ...success, primitive: "mkdirat_renameat_noreplace" }, "retained_tree").ok,
		).toBe(true);
		expect(
			classifyNativePublishOutcome({ ...success, primitive: "mkdirat_renameat_noreplace" }, "retained_file")
				.mutationState,
		).toBe("unknown");
		expect(
			classifyNativePublishOutcome({ ...success, primitive: "linkat_noreplace" }, "retained_tree").mutationState,
		).toBe("unknown");
	});

	it("preserves committed linkat unlink failures", () => {
		const outcome = classifyNativePublishOutcome(
			{
				...preMutation,
				code: "io_error",
				mutationState: "committed",
				durabilityState: "not_provable",
				reason: "io_failure",
				primitive: "linkat_noreplace",
				phase: "source_unlink",
				diagnostic: { schemaVersion: 1, collectionState: "partial", osCode: 13 },
			},
			"retained_file",
		);
		expect(outcome).toMatchObject({
			mutationState: "committed",
			durabilityState: "not_provable",
			reason: "io_failure",
			primitive: "linkat_noreplace",
			phase: "source_unlink",
		});
		expect(mayCleanCurrentStaging(outcome)).toBe(false);
	});

	it("keeps an EINVAL-classified retained request out of atomic-unavailable fallback while allowing exact staging cleanup", () => {
		const outcome = classifyNativePublishOutcome(
			{
				...preMutation,
				code: "invalid_request",
				reason: "invalid_request",
				phase: "preflight",
			},
			"retained_file",
		);
		expect(outcome.reason).toBe("invalid_request");
		expect(mayCleanCurrentStaging(outcome)).toBe(true);
	});

	it("preserves bounded per-parent fsync evidence without accepting fabricated roles", () => {
		const base = {
			ok: false,
			code: "fsync_failed",
			mutationState: "committed",
			durabilityState: "not_provable",
			reason: "durability_not_provable",
			primitive: "renameat2_noreplace",
		};
		const sourceOnly = classifyNativePublishOutcome({
			...base,
			phase: "source_parent_sync",
			diagnostic: {
				schemaVersion: 1,
				collectionState: "partial",
				syncFailures: [{ phase: "source_parent_sync", parentRole: "source", osCode: 5, kind: "io" }],
			},
		});
		expect(formatNativePublishDiagnostic(sourceOnly)).toContain("source:source_parent_sync:io:5");
		const destinationOnly = classifyNativePublishOutcome({
			...base,
			phase: "destination_parent_sync",
			diagnostic: {
				schemaVersion: 1,
				collectionState: "partial",
				syncFailures: [{ phase: "destination_parent_sync", parentRole: "destination", osCode: 5, kind: "io" }],
			},
		});
		expect(formatNativePublishDiagnostic(destinationOnly)).toContain("destination:destination_parent_sync:io:5");
		const both = classifyNativePublishOutcome({
			...base,
			phase: "source_parent_sync",
			diagnostic: {
				schemaVersion: 1,
				collectionState: "partial",
				syncFailures: [
					{ phase: "source_parent_sync", parentRole: "source", osCode: 5, kind: "io" },
					{ phase: "destination_parent_sync", parentRole: "destination", osCode: 95, kind: "unsupported" },
				],
			},
		});
		expect(formatNativePublishDiagnostic(both)).toContain("destination:destination_parent_sync:unsupported:95");
		const sharedOnce = classifyNativePublishOutcome({
			...base,
			phase: "source_parent_sync",
			diagnostic: {
				schemaVersion: 1,
				collectionState: "partial",
				syncFailures: [{ phase: "source_parent_sync", parentRole: "shared", kind: "permission" }],
			},
		});
		expect(formatNativePublishDiagnostic(sharedOnce)).toContain("shared:source_parent_sync:permission");
		expect(
			classifyNativePublishOutcome({
				...destinationOnly,
				diagnostic: {
					...destinationOnly.diagnostic,
					syncFailures: [{ phase: "destination_parent_sync", parentRole: "source", osCode: 5, kind: "io" }],
				},
			}).reason,
		).toBe("unknown");
	});
});

describe.skipIf(process.platform !== "linux")("managed recovery authority warnings", () => {
	it("warns about an unavailable recovery directory before child retention throws", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-reaper-warning-"));
		const root = managedDirectoryRoot(tempDir);
		const rootAuthority = native.openRecoveryFsRoot(root.canonicalPath);
		const events: string[] = [];
		const metrics = {
			ok: false,
			code: "recovery_directory_unavailable",
			scannedEntries: "0",
			reapedFiles: "0",
			reapedBytes: "0",
			preservedEntries: "0",
			failures: "0",
			scanLimited: false,
			totalReapedFiles: "0",
			totalReapedBytes: "0",
			totalFailures: "0",
		} satisfies native.RecoveryFsReaperMetrics;
		const openSpy = vi.spyOn(native, "openRecoveryFsRoot").mockReturnValue(rootAuthority);
		const metricsSpy = vi.spyOn(rootAuthority, "recoveryReaperMetrics").mockImplementation(() => {
			events.push("metrics");
			return metrics;
		});
		const retainSpy = vi.spyOn(rootAuthority, "retainManagedDirectory").mockImplementation(() => {
			events.push("retain");
			throw new Error("unsafe recovery directory");
		});
		const warningSpy = vi.spyOn(logger, "warn").mockImplementation(message => {
			if (message === "Managed recovery sidecar reaping") events.push("warn");
		});
		try {
			expect(() => retainManagedDirectoryAuthority(root, tempDir)).toThrow("unsafe recovery directory");
			expect(events).toEqual(["metrics", "warn", "retain"]);
			expect(warningSpy).toHaveBeenCalledWith(
				"Managed recovery sidecar reaping",
				expect.objectContaining({ ok: false, code: "recovery_directory_unavailable" }),
			);
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(metricsSpy).toHaveBeenCalledTimes(1);
			expect(retainSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.restoreAllMocks();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

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

describe("MemorySessionStorageWriter owned append publication", () => {
	let storage: MemorySessionStorage;

	beforeEach(() => {
		storage = new MemorySessionStorage();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("publishes unbuffered appends immediately and keeps read snapshots isolated", () => {
		const sessionPath = "/sessions/immediate.jsonl";
		const writer = storage.openWriter(sessionPath, { flags: "w" });
		writer.writeLineSync("first\n");

		const firstStat = storage.statSync(sessionPath);
		const snapshot = storage.readSnapshotSync(sessionPath);
		const range = storage.readRangeSync(sessionPath, 0, firstStat.size);
		expect(Buffer.from(snapshot.bytes).toString("utf8")).toBe("first\n");
		expect(Buffer.from(range.bytes).toString("utf8")).toBe("first\n");
		expect(firstStat.size).toBe(6);

		writer.writeLineSync("second\n");
		expect(storage.readTextSync(sessionPath)).toBe("first\nsecond\n");
		expect(storage.statSync(sessionPath).size).toBe(13);
		expect(storage.statSync(sessionPath).ino).toBe(firstStat.ino);
		expect(Buffer.from(snapshot.bytes).toString("utf8")).toBe("first\n");
		expect(Buffer.from(range.bytes).toString("utf8")).toBe("first\n");

		snapshot.bytes[0] = 0;
		range.bytes[0] = 0;
		expect(storage.readTextSync(sessionPath)).toBe("first\nsecond\n");
		writer.closeSync();
		expect(writer.getCloseState()).toBe("closed");
	});

	it("keeps appended input isolated and publishes buffered bytes only on flush", () => {
		const sessionPath = "/sessions/buffered.jsonl";
		const writer = storage.openBufferedWriter(sessionPath, { flags: "w" });
		const input = Buffer.from("first");
		writer.writeBytesSync(input);
		input.fill(0);

		expect(storage.statSync(sessionPath).size).toBe(0);
		expect(storage.readTextSync(sessionPath)).toBe("");
		writer.flushSync();
		expect(storage.readTextSync(sessionPath)).toBe("first");
		const inode = storage.statSync(sessionPath).ino;

		const nextInput = Buffer.from("+second");
		writer.writeBytesSync(nextInput);
		nextInput.fill(0);
		expect(storage.readTextSync(sessionPath)).toBe("first");
		writer.flushSync();
		expect(storage.readTextSync(sessionPath)).toBe("first+second");
		expect(storage.statSync(sessionPath).size).toBe(12);
		expect(storage.statSync(sessionPath).ino).toBe(inode);
		writer.closeSync();
		expect(writer.getCloseState()).toBe("closed");
	});

	it("grows at the visible-length boundary without changing the prior prefix", () => {
		const sessionPath = "/sessions/growth.jsonl";
		const writer = storage.openWriter(sessionPath, { flags: "w" });
		const prefix = `${"a".repeat(4095)}\n`;
		writer.writeLineSync(prefix);
		const snapshot = storage.readSnapshotSync(sessionPath);
		const range = storage.readRangeSync(sessionPath, 0, prefix.length);

		writer.writeLineSync("b\n");
		expect(storage.statSync(sessionPath).size).toBe(prefix.length + 2);
		expect(storage.readTextSync(sessionPath)).toBe(`${prefix}b\n`);
		expect(Buffer.from(snapshot.bytes).toString("utf8")).toBe(prefix);
		expect(Buffer.from(range.bytes).toString("utf8")).toBe(prefix);
		writer.closeSync();
	});

	it("retains a renamed published prefix while the writer continues at its old path", () => {
		const sessionPath = "/sessions/renamed.jsonl";
		const retainedPath = "/sessions/retained.jsonl";
		const writer = storage.openWriter(sessionPath, { flags: "w" });
		writer.writeLineSync("prefix\n");
		const retainedInode = storage.statSync(sessionPath).ino;

		storage.renameSync(sessionPath, retainedPath);
		writer.writeLineSync("continued\n");
		expect(storage.readTextSync(retainedPath)).toBe("prefix\n");
		expect(storage.readTextSync(sessionPath)).toBe("prefix\ncontinued\n");
		expect(storage.statSync(retainedPath).ino).toBe(retainedInode);
		expect(storage.statSync(sessionPath).ino).not.toBe(retainedInode);
		writer.closeSync();
	});

	it("retains an exactly replaced prefix while its source writer continues", () => {
		const sessionPath = "/sessions/replacement-source.jsonl";
		const retainedPath = "/sessions/replacement-destination.jsonl";
		const writer = storage.openWriter(sessionPath, { flags: "w" });
		try {
			writer.writeLineSync("prefix\n");
			const retainedInode = storage.statSync(sessionPath).ino;
			storage.writeTextSync(retainedPath, "original destination\n");
			const destination = storage.readSnapshotSync(retainedPath);
			expect(
				storage.replaceExactSync(sessionPath, retainedPath, {
					stat: destination.stat,
					sha256: createHash("sha256").update(destination.bytes).digest("hex"),
				}),
			).toBe(true);
			writer.writeLineSync("continued\n");
			expect(storage.readTextSync(retainedPath)).toBe("prefix\n");
			expect(storage.readTextSync(sessionPath)).toBe("prefix\ncontinued\n");
			expect(storage.statSync(retainedPath).ino).toBe(retainedInode);
			expect(storage.statSync(sessionPath).ino).not.toBe(retainedInode);
		} finally {
			writer.closeSync();
		}
	});

	it("reuses geometric backing allocations across many complete publications", () => {
		const sessionPath = "/sessions/allocations.jsonl";
		const seed = "s".repeat(32 * 1024);
		storage.writeTextSync(sessionPath, seed);
		const writer = storage.openWriter(sessionPath);
		const realWriteBytesOwnedSync = storage.writeBytesOwnedSync.bind(storage);
		const publishedBackings = new Set<ArrayBufferLike>();
		const publishSpy = vi.spyOn(storage, "writeBytesOwnedSync").mockImplementation((path, content) => {
			publishedBackings.add(content.buffer);
			realWriteBytesOwnedSync(path, content);
		});
		const chunk = `${"x".repeat(8192)}\n`;
		const appendCount = 20;

		for (let index = 0; index < appendCount; index++) writer.writeLineSync(chunk);

		const expected = seed + chunk.repeat(appendCount);
		expect(storage.readTextSync(sessionPath)).toBe(expected);
		expect(storage.statSync(sessionPath).size).toBe(Buffer.byteLength(expected));
		// The writer grows geometrically (four backing buffers here); copying each
		// whole visible prefix would instead allocate one distinct 8 KiB+ buffer per append.
		expect(publishedBackings.size).toBeLessThanOrEqual(5);
		publishSpy.mockRestore();
		writer.closeSync();
	});

	it("keeps close errors stable and rejects writes after an uncertain close", () => {
		const sessionPath = "/sessions/close-error.jsonl";
		let closeCalls = 0;
		const writer = storage.openWriter(sessionPath, {
			flags: "w",
			closeAdapter: {
				close() {
					closeCalls++;
					throw new Error("memory close outcome unknown");
				},
			},
		});
		writer.writeLineSync("published\n");

		expect(() => writer.closeSync()).toThrow("memory close outcome unknown");
		const closeError = writer.getCloseError();
		expect(closeError?.message).toBe("memory close outcome unknown");
		expect(writer.getCloseState()).toBe("close_unknown");
		expect(() => writer.closeSync()).toThrow("memory close outcome unknown");
		expect(writer.getCloseError()).toBe(closeError);
		expect(closeCalls).toBe(1);
		expect(() => writer.writeLineSync("rejected\n")).toThrow("memory close outcome unknown");
		expect(storage.readTextSync(sessionPath)).toBe("published\n");
	});
});

describe("managed descriptor reads", () => {
	const cjsFs = require("node:fs") as typeof fs;
	const realCjsReadSync = cjsFs.readSync;
	const realCjsCloseSync = cjsFs.closeSync;
	const realCjsFstatSync = cjsFs.fstatSync;
	const realCjsLstatSync = cjsFs.lstatSync;
	const realCjsOpenSync = cjsFs.openSync;

	function forwardFstatSync(fd: number): fs.Stats;
	function forwardFstatSync(fd: number, options?: fs.StatOptions & { bigint?: false | undefined }): fs.Stats;
	function forwardFstatSync(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
	function forwardFstatSync(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
	function forwardFstatSync(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
		return options === undefined ? realCjsFstatSync(fd) : realCjsFstatSync(fd, options);
	}

	function forwardLstatSync(file: fs.PathLike): fs.Stats;
	function forwardLstatSync(
		file: fs.PathLike,
		options?: fs.StatOptions & { bigint?: false | undefined; throwIfNoEntry?: true | undefined },
	): fs.Stats;
	function forwardLstatSync(
		file: fs.PathLike,
		options: fs.StatOptions & { bigint: true; throwIfNoEntry?: true | undefined },
	): fs.BigIntStats;
	function forwardLstatSync(
		file: fs.PathLike,
		options: fs.StatOptions & { bigint?: false | undefined; throwIfNoEntry: false },
	): fs.Stats | undefined;
	function forwardLstatSync(
		file: fs.PathLike,
		options: fs.StatOptions & { bigint: true; throwIfNoEntry: false },
	): fs.BigIntStats | undefined;
	function forwardLstatSync(
		file: fs.PathLike,
		options: fs.StatOptions & { throwIfNoEntry?: true | undefined },
	): fs.Stats | fs.BigIntStats;
	function forwardLstatSync(file: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats | undefined;
	function forwardLstatSync(file: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats | undefined {
		return options === undefined ? realCjsLstatSync(file) : realCjsLstatSync(file, options);
	}

	function capturePathLstatError(
		pathname: string,
		onPathnameError: (error: NodeJS.ErrnoException) => void,
	): typeof fs.lstatSync {
		function lstat(file: fs.PathLike): fs.Stats;
		function lstat(
			file: fs.PathLike,
			options?: fs.StatOptions & { bigint?: false | undefined; throwIfNoEntry?: true | undefined },
		): fs.Stats;
		function lstat(
			file: fs.PathLike,
			options: fs.StatOptions & { bigint: true; throwIfNoEntry?: true | undefined },
		): fs.BigIntStats;
		function lstat(
			file: fs.PathLike,
			options: fs.StatOptions & { bigint?: false | undefined; throwIfNoEntry: false },
		): fs.Stats | undefined;
		function lstat(
			file: fs.PathLike,
			options: fs.StatOptions & { bigint: true; throwIfNoEntry: false },
		): fs.BigIntStats | undefined;
		function lstat(
			file: fs.PathLike,
			options: fs.StatOptions & { throwIfNoEntry?: true | undefined },
		): fs.Stats | fs.BigIntStats;
		function lstat(file: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats | undefined;
		function lstat(file: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats | undefined {
			try {
				return forwardLstatSync(file, options);
			} catch (error) {
				if (path.resolve(String(file)) === pathname && (error as NodeJS.ErrnoException).code === "ENOENT")
					onPathnameError(error as NodeJS.ErrnoException);
				throw error;
			}
		}
		return lstat;
	}

	function forwardReadSync(
		fd: number,
		buffer: NodeJS.ArrayBufferView,
		offset: number,
		length: number,
		position: fs.ReadPosition | null,
	): number;
	function forwardReadSync(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadOptions): number;
	function forwardReadSync(
		fd: number,
		buffer: NodeJS.ArrayBufferView,
		offsetOrOptions?: number | fs.ReadOptions,
		length?: number,
		position?: fs.ReadPosition | null,
	): number {
		if (typeof offsetOrOptions === "number") {
			if (length === undefined || position === undefined) throw new Error("Invalid positional read arguments");
			return realCjsReadSync(fd, buffer, offsetOrOptions, length, position);
		}
		return realCjsReadSync(fd, buffer, offsetOrOptions);
	}

	function instrumentReadSync(afterRead: () => void): typeof fs.readSync {
		function read(
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: fs.ReadPosition | null,
		): number;
		function read(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadOptions): number;
		function read(
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offsetOrOptions?: number | fs.ReadOptions,
			length?: number,
			position?: fs.ReadPosition | null,
		): number {
			let count: number;
			if (typeof offsetOrOptions === "number") {
				if (length === undefined || position === undefined) throw new Error("Invalid positional read arguments");
				count = forwardReadSync(fd, buffer, offsetOrOptions, length, position);
			} else {
				count = forwardReadSync(fd, buffer, offsetOrOptions);
			}
			afterRead();
			return count;
		}
		return read;
	}

	function closeAfterForwarding(failure: Error | undefined, closedDescriptors: number[]): Mock<typeof fs.closeSync> {
		return vi.spyOn(fs, "closeSync").mockImplementation(fd => {
			realCjsCloseSync(fd);
			closedDescriptors.push(fd);
			if (failure) throw failure;
		});
	}

	function descriptorsAreClosed(descriptors: number[]): boolean {
		let closed = true;
		let failed = false;
		let failure: unknown;
		for (const fd of descriptors) {
			let error: unknown;
			try {
				realCjsFstatSync(fd);
			} catch (caught) {
				error = caught;
			}
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "EBADF") closed = false;
			try {
				expect(error).toMatchObject({ code: "EBADF" });
			} catch (caught) {
				if (!failed) {
					failed = true;
					failure = caught;
				}
			}
		}
		if (failed) throw failure;
		return closed;
	}

	function cleanupReaderTest(
		root: string,
		store: ManagedSessionDescendantStore | undefined,
		closedDescriptors: number[],
		spies: Array<{ mockRestore(): void } | undefined>,
		bodyFailed: boolean,
		ownedDescriptor?: number,
	): void {
		let cleanupFailed = false;
		let cleanupError: unknown;
		let resourcesDischarged = true;
		const attempt = (cleanup: () => void): void => {
			try {
				cleanup();
			} catch (error) {
				if (!cleanupFailed) {
					cleanupFailed = true;
					cleanupError = error;
				}
			}
		};
		for (const spy of spies) {
			if (spy) attempt(() => spy.mockRestore());
		}
		if (store) {
			try {
				store.close();
			} catch (error) {
				resourcesDischarged = false;
				if (!cleanupFailed) {
					cleanupFailed = true;
					cleanupError = error;
				}
			}
		}
		const ownedDescriptorIsClosed = (): boolean => {
			if (ownedDescriptor === undefined) return true;
			try {
				realCjsFstatSync(ownedDescriptor);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EBADF") return true;
				if (!cleanupFailed) {
					cleanupFailed = true;
					cleanupError = error;
				}
				return false;
			}
			let closeFailure: unknown;
			try {
				realCjsCloseSync(ownedDescriptor);
			} catch (error) {
				closeFailure = error;
				if (!cleanupFailed) {
					cleanupFailed = true;
					cleanupError = error;
				}
			}
			try {
				realCjsFstatSync(ownedDescriptor);
				if (!cleanupFailed) {
					cleanupFailed = true;
					cleanupError = closeFailure ?? new Error("Owned descriptor remained open during test cleanup");
				}
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EBADF") return true;
				if (!cleanupFailed) {
					cleanupFailed = true;
					cleanupError = closeFailure ?? error;
				}
				return false;
			}
		};
		if (!ownedDescriptorIsClosed()) resourcesDischarged = false;
		try {
			if (!descriptorsAreClosed(closedDescriptors)) resourcesDischarged = false;
		} catch (error) {
			resourcesDischarged = false;
			if (!cleanupFailed) {
				cleanupFailed = true;
				cleanupError = error;
			}
		}
		if (resourcesDischarged) attempt(() => fs.rmSync(root, { recursive: true, force: true }));
		if (!bodyFailed && cleanupFailed) throw cleanupError;
	}

	async function prepareReadOnlyStore(
		root: string,
		relativePath: string,
		contents: string,
	): Promise<ManagedSessionDescendantStore> {
		fs.chmodSync(root, 0o700);
		const pathname = path.join(root, relativePath);
		await Bun.write(pathname, contents);
		fs.chmodSync(pathname, 0o600);
		const identity = managedDirectoryRoot(root);
		return new ManagedSessionDescendantStore(identity, root, undefined, "default", root, identity, "read-only");
	}

	it("forwards both actual positional and options readSync overloads", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-read-overloads-")));
		const pathname = path.join(root, "session.jsonl");
		let readSpy: Mock<typeof fs.readSync> | undefined;
		let descriptor: number | undefined;
		let bodyFailed = false;
		try {
			await Bun.write(pathname, "0123456789\n");
			const actualDescriptor = realCjsOpenSync(pathname, fs.constants.O_RDONLY);
			descriptor = actualDescriptor;
			readSpy = vi.spyOn(fs, "readSync").mockImplementation(forwardReadSync);

			const positionalBytes = Buffer.alloc(4);
			expect(fs.readSync(actualDescriptor, positionalBytes, 0, positionalBytes.byteLength, 0n)).toBe(4);
			expect(positionalBytes.toString("utf8")).toBe("0123");

			const optionsBytes = Buffer.alloc(4);
			expect(
				fs.readSync(actualDescriptor, optionsBytes, {
					offset: 0,
					length: optionsBytes.byteLength,
					position: 6n,
				}),
			).toBe(4);
			expect(optionsBytes.toString("utf8")).toBe("6789");
			expect(readSpy).toHaveBeenCalledTimes(2);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, undefined, [], [readSpy], bodyFailed, descriptor);
		}
	});

	it("returns transcript identity from an actual path-backed read-only descriptor", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-descriptor-")));
		const closedDescriptors: number[] = [];
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		let readSpy: Mock<typeof fs.readSync> | undefined;
		let store: ManagedSessionDescendantStore | undefined;
		let bodyFailed = false;
		try {
			const actualStore = await prepareReadOnlyStore(root, "session.jsonl", "descriptor payload\n");
			store = actualStore;
			readSpy = vi.spyOn(fs, "readSync");
			closeSpy = closeAfterForwarding(undefined, closedDescriptors);
			const descriptor = actualStore.descriptorExpected("session.jsonl");
			expect(descriptor).toMatchObject({ size: Buffer.byteLength("descriptor payload\n"), isFile: true });
			expect(descriptor?.dev).toBeTypeOf("bigint");
			expect(descriptor?.ino).toBeTypeOf("bigint");
			expect(actualStore.descriptorExpected("missing.jsonl")).toBeNull();
			expect(readSpy).not.toHaveBeenCalled();
			expect(closedDescriptors).toHaveLength(1);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [readSpy, closeSpy], bodyFailed);
		}
	});

	it("returns descriptor identity through the separate genuine owned native authority control", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-descriptor-native-")));
		let store: ManagedSessionDescendantStore | undefined;
		let readSpy: Mock<typeof fs.readSync> | undefined;
		let bodyFailed = false;
		try {
			const actualStore = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
			store = actualStore;
			actualStore.publishNoReplaceSync("session.jsonl", Buffer.from("native descriptor payload\n"));
			readSpy = vi.spyOn(fs, "readSync");
			expect(actualStore.descriptorExpected("session.jsonl")).toMatchObject({
				size: Buffer.byteLength("native descriptor payload\n"),
				isFile: true,
			});
			expect(readSpy).not.toHaveBeenCalled();
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, [], [readSpy], bodyFailed);
		}
	});

	it("preserves descriptor metadata errors when actual descriptor close also fails", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-descriptor-close-")));
		const closedDescriptors: number[] = [];
		const primaryFailure = new Error("descriptor metadata inspection failed");
		const secondaryFailure = new Error("descriptor close failed after closing");
		let store: ManagedSessionDescendantStore | undefined;
		let fstatSpy: Mock<typeof fs.fstatSync> | undefined;
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		let bodyFailed = false;
		try {
			const actualStore = await prepareReadOnlyStore(root, "session.jsonl", "descriptor payload\n");
			store = actualStore;
			fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation((fd: number, options?: fs.StatOptions) => {
				forwardFstatSync(fd, options);
				throw primaryFailure;
			});
			closeSpy = closeAfterForwarding(secondaryFailure, closedDescriptors);

			let caught: unknown;
			try {
				actualStore.descriptorExpected("session.jsonl");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(primaryFailure);
			expect(closedDescriptors).toHaveLength(1);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [fstatSpy, closeSpy], bodyFailed);
		}
	});

	it("preserves the actual post-open pathname ENOENT over a secondary close error", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-descriptor-disappear-")));
		const pathname = path.join(root, "session.jsonl");
		const detached = path.join(root, "session.detached.jsonl");
		const closedDescriptors: number[] = [];
		const secondaryFailure = new Error("descriptor close failed after unlink");
		let store: ManagedSessionDescendantStore | undefined;
		let fstatSpy: Mock<typeof fs.fstatSync> | undefined;
		let lstatSpy: Mock<typeof fs.lstatSync> | undefined;
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		let originalPathnameError: NodeJS.ErrnoException | undefined;
		let fileDisplaced = false;
		let bodyFailed = false;
		try {
			const actualStore = await prepareReadOnlyStore(root, "session.jsonl", "descriptor before unlink\n");
			store = actualStore;
			function fstatAfterOpen(fd: number, options?: fs.StatOptions & { bigint?: false | undefined }): fs.Stats;
			function fstatAfterOpen(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
			function fstatAfterOpen(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
			function fstatAfterOpen(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
				const stats = forwardFstatSync(fd, options);
				if (!fileDisplaced) {
					fs.renameSync(pathname, detached);
					fileDisplaced = true;
				}
				return stats;
			}
			fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation(fstatAfterOpen);
			lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(
				capturePathLstatError(pathname, error => {
					originalPathnameError = error;
				}),
			);
			closeSpy = closeAfterForwarding(secondaryFailure, closedDescriptors);

			let caught: unknown;
			try {
				actualStore.descriptorExpected("session.jsonl");
			} catch (error) {
				caught = error;
			}
			expect(fileDisplaced).toBe(true);
			expect(originalPathnameError).toMatchObject({ code: "ENOENT" });
			expect(caught).toBe(originalPathnameError);
			expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
			expect(caught).not.toBe(secondaryFailure);
			expect(closedDescriptors).toHaveLength(1);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [fstatSpy, lstatSpy, closeSpy], bodyFailed);
		}
	});

	it("propagates a healthy descriptor close-only failure", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-descriptor-close-only-")));
		const closedDescriptors: number[] = [];
		const closeFailure = new Error("descriptor close-only failure");
		let store: ManagedSessionDescendantStore | undefined;
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		let bodyFailed = false;
		try {
			const actualStore = await prepareReadOnlyStore(root, "session.jsonl", "descriptor payload\n");
			store = actualStore;
			closeSpy = closeAfterForwarding(closeFailure, closedDescriptors);
			let caught: unknown;
			try {
				actualStore.descriptorExpected("session.jsonl");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(closeFailure);
			expect(closedDescriptors).toHaveLength(1);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [closeSpy], bodyFailed);
		}
	});

	it("reads bounded ranges and rejects a pathname swap before returning bytes", async () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-range-")));
		const closedDescriptors: number[] = [];
		const secondaryFailure = new Error("range descriptor close failed after closing");
		let store: ManagedSessionDescendantStore | undefined;
		let readSpy: Mock<typeof fs.readSync> | undefined;
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		const transcript = path.join(root, "session.jsonl");
		const replacement = path.join(root, "attacker.jsonl");
		let bodyFailed = false;
		try {
			const actualStore = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
			store = actualStore;
			actualStore.publishNoReplaceSync("session.jsonl", Buffer.from("0123456789\n"));
			await Bun.write(replacement, "attacker\n");
			closeSpy = closeAfterForwarding(undefined, closedDescriptors);
			expect(Buffer.from(actualStore.readRangeExpectedSync("session.jsonl", 2, 4).bytes).toString("utf8")).toBe(
				"2345",
			);
			closeSpy.mockRestore();
			closeSpy = undefined;
			expect(() => actualStore.readRangeExpectedSync("session.jsonl", Number.MAX_SAFE_INTEGER, 1)).toThrow(
				"Managed range read start overflows",
			);

			readSpy = vi.spyOn(fs, "readSync").mockImplementationOnce(
				instrumentReadSync(() => {
					fs.renameSync(transcript, `${transcript}.detached`);
					fs.renameSync(replacement, transcript);
				}),
			);
			closeSpy = closeAfterForwarding(secondaryFailure, closedDescriptors);
			expect(() => actualStore.readRangeExpectedSync("session.jsonl", 0, 4)).toThrow("source_changed");
			expect(closedDescriptors).toHaveLength(2);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [readSpy, closeSpy], bodyFailed);
		}
	});

	it("preserves range read error identity when actual descriptor close also fails", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-range-error-")));
		const closedDescriptors: number[] = [];
		const primaryFailure = new Error("range read failed after reading from the descriptor");
		const secondaryFailure = new Error("range close failed after closing");
		let store: ManagedSessionDescendantStore | undefined;
		let readSpy: Mock<typeof fs.readSync> | undefined;
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		let bodyFailed = false;
		try {
			const actualStore = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
			store = actualStore;
			actualStore.publishNoReplaceSync("session.jsonl", Buffer.from("range payload\n"));
			readSpy = vi.spyOn(fs, "readSync").mockImplementationOnce(
				instrumentReadSync(() => {
					throw primaryFailure;
				}),
			);
			closeSpy = closeAfterForwarding(secondaryFailure, closedDescriptors);

			let caught: unknown;
			try {
				actualStore.readRangeExpectedSync("session.jsonl", 0, 4);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(primaryFailure);
			expect(closedDescriptors).toHaveLength(1);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [readSpy, closeSpy], bodyFailed);
		}
	});

	it("propagates a healthy range-reader close-only failure", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-range-close-only-")));
		const closedDescriptors: number[] = [];
		const closeFailure = new Error("range close-only failure");
		let store: ManagedSessionDescendantStore | undefined;
		let closeSpy: Mock<typeof fs.closeSync> | undefined;
		let bodyFailed = false;
		try {
			const actualStore = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
			store = actualStore;
			actualStore.publishNoReplaceSync("session.jsonl", Buffer.from("range payload\n"));
			closeSpy = closeAfterForwarding(closeFailure, closedDescriptors);
			let caught: unknown;
			try {
				actualStore.readRangeExpectedSync("session.jsonl", 0, 4);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(closeFailure);
			expect(closedDescriptors).toHaveLength(1);
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			cleanupReaderTest(root, store, closedDescriptors, [closeSpy], bodyFailed);
		}
	});
	it("binds ranges to the caller's committed descriptor generation", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-generation-")));
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
		try {
			store.publishNoReplaceSync("session.jsonl", Buffer.from("generation-one\n"));
			const expected = store.descriptorExpected("session.jsonl");
			if (!expected) throw new Error("Expected managed transcript descriptor");
			store.replaceSync("session.jsonl", Buffer.from("generation-two\n"));
			expect(() => store.readRangeExpectedSync("session.jsonl", 0, 4, expected)).toThrow(
				"managed_range_generation_mismatch",
			);
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("rejects a FIFO pathname substitution without blocking", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-fifo-")));
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
		const transcript = path.join(root, "session.jsonl");
		const detached = `${transcript}.detached`;
		try {
			store.publishNoReplaceSync("session.jsonl", Buffer.from("fifo-safe\n"));
			const expected = store.descriptorExpected("session.jsonl");
			if (!expected) throw new Error("Expected managed transcript descriptor");
			const openSync = fs.openSync;
			let observedFlags = 0;
			const spy = vi.spyOn(fs, "openSync").mockImplementationOnce(((
				file: fs.PathLike,
				flags: fs.OpenMode,
				mode?: fs.Mode,
			) => {
				observedFlags = Number(flags);
				fs.renameSync(transcript, detached);
				const created = Bun.spawnSync(["mkfifo", transcript]);
				if (created.exitCode !== 0) throw new Error("Could not create FIFO fixture");
				return openSync(file, flags, mode);
			}) as typeof fs.openSync);
			expect(() => store.readRangeExpectedSync("session.jsonl", 0, 4, expected)).toThrow("source_changed");
			expect(observedFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
			spy.mockRestore();
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it.skipIf(process.platform === "win32")("rejects a FIFO cold-fallback capture without blocking", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-fallback-fifo-")));
		const fifo = path.join(root, "session.jsonl");
		try {
			const created = Bun.spawnSync(["mkfifo", fifo]);
			if (created.exitCode !== 0) throw new Error("Could not create FIFO fixture");
			const openSync = fs.openSync;
			let observedFlags = 0;
			const spy = vi.spyOn(fs, "openSync").mockImplementationOnce(((
				file: fs.PathLike,
				flags: fs.OpenMode,
				mode?: fs.Mode,
			) => {
				observedFlags = Number(flags);
				return openSync(file, flags, mode);
			}) as typeof fs.openSync);
			expect(() => captureManagedFileNoFollow(fifo)).toThrow("source_changed");
			expect(observedFlags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
			spy.mockRestore();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("admits the opened descriptor before allocation, closes it, and preserves the admission failure", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-admission-")));
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
		const transcript = path.join(root, "session.jsonl");
		const bytes = Buffer.from("admitted descriptor bytes\n");
		store.publishNoReplaceSync("session.jsonl", bytes);
		const expectedStat = fs.statSync(transcript, { bigint: true });
		const originalOpenReadLease = store.openReadLease.bind(store);
		let actualLease: ReturnType<typeof store.openReadLease> | undefined;
		let admissionObserved = false;
		let forwardedClose = false;
		let closeInjectionCount = 0;
		const injectedCloseFailure = new Error("injected terminal close failure");
		let observedAdmission: { size: number; descriptor: ManagedFileIdentity } | undefined;
		const primaryFailure = new Error("admission rejected before allocation");
		const openLease = vi.spyOn(store, "openReadLease").mockImplementation((relativePath, expectedDescriptor) => {
			const lease = originalOpenReadLease(relativePath, expectedDescriptor);
			actualLease = lease;
			return {
				readRange: (start, length) => lease.readRange(start, length),
				close: () => {
					lease.close();
					if (admissionObserved) {
						forwardedClose = true;
						closeInjectionCount++;
						throw injectedCloseFailure;
					}
				},
			};
		});
		const read = vi.spyOn(fs, "readSync");
		const allocate = vi.spyOn(Buffer, "alloc");
		let caught: unknown;
		try {
			try {
				store.readExpectedBounded("session.jsonl", bytes.byteLength, (size, descriptor) => {
					admissionObserved = true;
					observedAdmission = { size, descriptor };
					throw primaryFailure;
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(primaryFailure);
			expect(observedAdmission?.size).toBe(bytes.byteLength);
			expect(observedAdmission?.descriptor).toMatchObject({
				dev: expectedStat.dev,
				ino: expectedStat.ino,
				nlink: 1n,
				size: bytes.byteLength,
				mtimeNs: expectedStat.mtimeNs,
				ctimeNs: expectedStat.ctimeNs,
			});
			if (!actualLease) throw new Error("managed capture read lease was not opened");
			expect(forwardedClose).toBe(true);
			expect(admissionObserved).toBe(true);
			expect(closeInjectionCount).toBe(1);
			expect(() => actualLease!.readRange(0, 0)).toThrow("closed");
			expect(read).not.toHaveBeenCalled();
			expect(allocate.mock.calls.some(([size]) => size === bytes.byteLength)).toBe(false);
		} finally {
			allocate.mockRestore();
			read.mockRestore();
			openLease.mockRestore();
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects growth during bounded capture without reading beyond the admitted size", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-growth-")));
		const pathname = path.join(root, "session.jsonl");
		const initial = Buffer.from("initial-sized transcript\n");
		fs.writeFileSync(pathname, initial, { mode: 0o600 });
		const originalRead = fs.readSync.bind(fs);
		let bytesRead = 0;
		let bytesRequested = 0;
		let grew = false;
		const read = vi.spyOn(fs, "readSync").mockImplementation(((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: number | null,
		) => {
			bytesRequested += length;
			const count = originalRead(fd, buffer, offset, length, position);
			bytesRead += count;
			if (!grew) {
				grew = true;
				fs.truncateSync(pathname, initial.byteLength + 9);
			}
			return count;
		}) as typeof fs.readSync);
		const allocate = vi.spyOn(Buffer, "alloc");
		try {
			expect(() => captureManagedFileNoFollowBounded(pathname, initial.byteLength)).toThrow("source_changed");
			expect(bytesRead).toBe(initial.byteLength);
			expect(bytesRequested).toBe(initial.byteLength);
			expect(allocate.mock.calls.some(([size]) => size === initial.byteLength)).toBe(true);
			expect(fs.statSync(pathname).size).toBe(initial.byteLength + 9);
		} finally {
			allocate.mockRestore();
			read.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects pathname replacement during bounded capture after reading only the original generation", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-replacement-")));
		const pathname = path.join(root, "session.jsonl");
		const detached = `${pathname}.detached`;
		const initial = Buffer.from("original generation bytes\n");
		const replacement = Buffer.from("replacement generation must not be read\n");
		fs.writeFileSync(pathname, initial, { mode: 0o600 });
		const originalRead = fs.readSync.bind(fs);
		let bytesRead = 0;
		let bytesRequested = 0;
		let replaced = false;
		const read = vi.spyOn(fs, "readSync").mockImplementation(((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: number | null,
		) => {
			bytesRequested += length;
			const count = originalRead(fd, buffer, offset, length, position);
			bytesRead += count;
			if (!replaced) {
				replaced = true;
				fs.renameSync(pathname, detached);
				fs.writeFileSync(pathname, replacement, { mode: 0o600 });
			}
			return count;
		}) as typeof fs.readSync);
		const allocate = vi.spyOn(Buffer, "alloc");
		try {
			expect(() => captureManagedFileNoFollowBounded(pathname, initial.byteLength)).toThrow("source_changed");
			expect(bytesRead).toBe(initial.byteLength);
			expect(bytesRequested).toBe(initial.byteLength);
			expect(allocate.mock.calls.some(([size]) => size === initial.byteLength)).toBe(true);
			expect(fs.readFileSync(detached)).toEqual(initial);
			expect(fs.readFileSync(pathname)).toEqual(replacement);
		} finally {
			allocate.mockRestore();
			read.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fences lease ranges to their initial size and returns fresh exact bytes and digest", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lease-fence-")));
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
		try {
			const firstBytes = Buffer.from("first descriptor generation\n");
			store.publishNoReplaceSync("session.jsonl", firstBytes);
			const firstDescriptor = store.descriptorExpected("session.jsonl");
			if (!firstDescriptor) throw new Error("first managed descriptor missing");
			const firstLease = store.openReadLease("session.jsonl", firstDescriptor);
			expect(() => firstLease.readRange(firstBytes.byteLength - 1, 2)).toThrow("range_not_present");
			expect(Buffer.from(firstLease.readRange(0, firstBytes.byteLength))).toEqual(firstBytes);
			firstLease.close();

			const freshBytes = Buffer.from("fresh positive exact transcript bytes\n");
			store.replaceSync("session.jsonl", freshBytes);
			const freshDescriptor = store.descriptorExpected("session.jsonl");
			if (!freshDescriptor) throw new Error("fresh managed descriptor missing");
			const freshLease = store.openReadLease("session.jsonl", freshDescriptor);
			const exactBytes = Buffer.from(freshLease.readRange(0, freshBytes.byteLength));
			freshLease.close();
			const snapshot = store.readExpectedBounded("session.jsonl", freshBytes.byteLength);
			if (!snapshot) throw new Error("fresh bounded snapshot missing");
			expect(exactBytes).toEqual(freshBytes);
			expect(snapshot.bytes).toEqual(freshBytes);
			expect(snapshot.identity.sha256).toBe(createHash("sha256").update(freshBytes).digest("hex"));
			expect(snapshot.identity.size).toBe(freshBytes.byteLength);
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform !== "darwin")("authority-absent managed replacement", () => {
	it("rejects authority-absent subtree replacement before read or delete", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-subtree-swap-")));
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("authority\n"));
			const original = `${sessionDir}.original`;
			const attacker = `${sessionDir}.attacker`;
			fs.renameSync(sessionDir, original);
			fs.mkdirSync(attacker, { mode: 0o700 });
			fs.writeFileSync(path.join(attacker, "session.jsonl"), "attacker\n", { mode: 0o600 });
			fs.symlinkSync(attacker, sessionDir, "dir");
			expect(() => store.readExpected("session.jsonl")).toThrow("root binding changed");
			expect(() => store.removeIfExistsDescriptor("session.jsonl")).toThrow("root binding changed");
			expect(fs.readFileSync(path.join(attacker, "session.jsonl"), "utf8")).toBe("attacker\n");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects path-based managed writes above the reopenable ceiling before allocation", () => {
		const oversized = { byteLength: MANAGED_ARTIFACT_MAX_FILE_BYTES + 1 } as unknown as Uint8Array;
		expect(() => publishManagedFileNoReplaceSync("/unused", oversized)).toThrow("content_too_large");
		expect(() =>
			replaceManagedFileSync("/unused", oversized, {
				canonicalPath: "/unused",
				dev: 0n,
				ino: 0n,
			}),
		).toThrow("content_too_large");
	});
	it("rejects repeated over-ceiling appends without replacement staging leaks", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-append-limit-")));
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("x"));
			fs.truncateSync(path.join(sessionDir, "session.jsonl"), MANAGED_ARTIFACT_MAX_FILE_BYTES);
			for (let attempt = 0; attempt < 2; attempt++)
				expect(() => store.appendSync("session.jsonl", Buffer.from("x"))).toThrow("content_too_large");
			expect(fs.readdirSync(sessionDir).filter(name => name.endsWith(".replacement"))).toEqual([]);
			expect(fs.statSync(path.join(sessionDir, "session.jsonl")).size).toBe(MANAGED_ARTIFACT_MAX_FILE_BYTES);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("atomically replaces an existing file through the Darwin path", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-replace-")));
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("before\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			const before = fs.lstatSync(destination, { bigint: true });
			store.replaceSync("session.jsonl", Buffer.from("after\n"));
			const after = fs.lstatSync(destination, { bigint: true });

			expect(fs.readFileSync(destination, "utf8")).toBe("after\n");
			expect(after.ino).not.toBe(before.ino);
			const retained = fs.readdirSync(sessionDir).filter(entry => entry.endsWith(".replacement"));
			expect(retained).toHaveLength(0);
			for (const entry of fs.readdirSync(sessionDir).filter(entry => entry.startsWith(".gjc-"))) {
				expect(fs.readFileSync(path.join(sessionDir, entry))).toHaveLength(0);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("appends by exact full-file replacement so a short write cannot tear JSONL", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-append-")));
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from('{"id":"before"}\n'));
			const destination = path.join(sessionDir, "session.jsonl");
			const before = fs.lstatSync(destination, { bigint: true });

			store.appendSync("session.jsonl", Buffer.from('{"id":"after"}\n'));

			const after = fs.lstatSync(destination, { bigint: true });
			expect(after.ino).not.toBe(before.ino);
			expect(fs.readFileSync(destination, "utf8")).toBe('{"id":"before"}\n{"id":"after"}\n');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("keeps memory-authoritative append success when cleanup receipt retirement is pending", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-append-receipt-")));
		let exactUnlink: Mock<typeof native.exactUnlink> | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("before\n"));
			exactUnlink = vi.spyOn(native, "exactUnlink").mockImplementation(pathname => ({
				ok: false,
				code: "cleanup_pending",
				retainedPlaceholderPath: pathname,
			}));
			const receipt = store.appendSync("session.jsonl", Buffer.from("after\n"));
			expect(receipt.descriptor.size).toBe(Buffer.byteLength("before\nafter\n"));
			expect(fs.readFileSync(path.join(sessionDir, "session.jsonl"), "utf8")).toBe("before\nafter\n");
			expect(fs.readdirSync(sessionDir).some(entry => entry.startsWith(".gjc-replace-cleanup-"))).toBe(true);
		} finally {
			exactUnlink?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves the staged successor when receipt publication commits but reports failure", () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-receipt-publish-")),
		);
		const realRenameNoReplacePath = native.renameNoReplacePath;
		let renameNoReplace: Mock<typeof native.renameNoReplacePath> | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("before\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			renameNoReplace = vi.spyOn(native, "renameNoReplacePath").mockImplementation((sourcePath, destinationPath) => {
				const result = realRenameNoReplacePath(sourcePath, destinationPath);
				if (!destinationPath.includes(".gjc-replace-cleanup-") || !result.ok) return result;
				return {
					...result,
					ok: false,
					code: "durability_failed",
					mutationState: "committed",
					durabilityState: "not_provable",
					reason: "unknown",
					phase: "terminal_identity",
				};
			});

			expect(() => store.replaceSync("session.jsonl", Buffer.from("successor\n"))).toThrow();

			expect(fs.readFileSync(destination, "utf8")).toBe("before\n");
			const entries = fs.readdirSync(sessionDir);
			expect(entries.some(entry => entry.startsWith(".gjc-replace-cleanup-"))).toBe(true);
			const staged = entries.find(entry => entry.endsWith(".replacement"));
			expect(staged).toBeDefined();
			expect(fs.readFileSync(path.join(sessionDir, staged!), "utf8")).toBe("successor\n");
		} finally {
			renameNoReplace?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects a destination substitution at the native exchange boundary", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-replace-race-")));
		const realExactReplacePath = native.exactReplacePath;
		let exactReplace: Mock<typeof native.exactReplacePath> | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("authorized\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			const detached = path.join(sessionDir, "authorized.jsonl");
			exactReplace = vi
				.spyOn(native, "exactReplacePath")
				.mockImplementation((sourcePath, destinationPath, expectedSource, expectedDestination) => {
					fs.renameSync(destination, detached);
					fs.writeFileSync(destination, "attacker\n", { mode: 0o600 });
					return realExactReplacePath(sourcePath, destinationPath, expectedSource, expectedDestination);
				});

			expect(() => store.replaceSync("session.jsonl", Buffer.from("successor\n"))).toThrow(
				"managed_replace_failed:identity_mismatch",
			);
			expect(fs.readFileSync(destination, "utf8")).toBe("attacker\n");
			expect(fs.readFileSync(detached, "utf8")).toBe("authorized\n");
			expect(fs.readdirSync(sessionDir).some(entry => entry.endsWith(".replacement"))).toBe(true);
			expect(fs.readdirSync(sessionDir).some(entry => entry.startsWith(".gjc-replace-cleanup-"))).toBe(true);
		} finally {
			exactReplace?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("retains native post-exchange paths inside committed-outcome evidence", () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-replace-failure-")),
		);
		let exactReplace: Mock<typeof native.exactReplacePath> | undefined;
		let exactUnlink: Mock<typeof native.exactUnlink> | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("predecessor\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			const predecessor = path.join(sessionDir, "predecessor.jsonl");
			const unknown = path.join(sessionDir, "unknown.jsonl");
			fs.writeFileSync(unknown, "unknown\n", { mode: 0o600 });
			exactReplace = vi.spyOn(native, "exactReplacePath").mockImplementation((sourcePath, destinationPath) => {
				fs.renameSync(destinationPath, predecessor);
				fs.renameSync(sourcePath, destinationPath);
				return {
					ok: false,
					code: "durability_failed",
					detachedPath: predecessor,
					retainedSuccessorPath: destination,
					retainedPlaceholderPath: predecessor,
					retainedUnknownPath: unknown,
				};
			});
			exactUnlink = vi.spyOn(native, "exactUnlink");

			let error: unknown;
			try {
				store.replaceSync("session.jsonl", Buffer.from("successor\n"));
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(ManagedCommittedMutationError);
			const committedError = error as ManagedCommittedMutationError;
			expect(committedError.operation).toBe("replace");
			expect(committedError.cause).toBeInstanceOf(ManagedReplaceError);
			const replaceError = committedError.cause as ManagedReplaceError;
			expect(replaceError.message).toBe("managed_replace_failed:durability_failed");
			expect(replaceError.code).toBe("durability_failed");
			expect(replaceError.detachedPath).toBe(predecessor);
			expect(replaceError.retainedSuccessorPath).toBe(destination);
			expect(replaceError.retainedPlaceholderPath).toBe(predecessor);
			expect(replaceError.retainedUnknownPath).toBe(unknown);
			expect(replaceError.cleanupReceiptPath).toBeDefined();
			expect(fs.readFileSync(replaceError.detachedPath!, "utf8")).toBe("predecessor\n");
			expect(fs.readFileSync(replaceError.retainedSuccessorPath!, "utf8")).toBe("successor\n");
			expect(fs.readFileSync(replaceError.retainedPlaceholderPath!, "utf8")).toBe("predecessor\n");
			expect(fs.readFileSync(replaceError.retainedUnknownPath!, "utf8")).toBe("unknown\n");
			expect(fs.readFileSync(replaceError.cleanupReceiptPath!, "utf8")).toContain('"version":3');
			expect(exactUnlink).not.toHaveBeenCalled();
		} finally {
			exactUnlink?.mockRestore();
			exactReplace?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("retains receipt retirement paths after a committed replacement", () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-receipt-retirement-")),
		);
		let exactUnlink: Mock<typeof native.exactUnlink> | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("predecessor\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			let detached = "";
			let unknown = "";
			exactUnlink = vi.spyOn(native, "exactUnlink").mockImplementation(pathname => {
				detached = `${pathname}.detached`;
				unknown = `${pathname}.unknown`;
				fs.renameSync(pathname, detached);
				fs.writeFileSync(pathname, "");
				fs.writeFileSync(unknown, "unknown\n");
				return {
					ok: false,
					code: "cleanup_pending",
					detachedPath: detached,
					retainedPlaceholderPath: pathname,
					retainedUnknownPath: unknown,
				};
			});

			let error: unknown;
			try {
				store.replaceSync("session.jsonl", Buffer.from("successor\n"));
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(ManagedReplaceError);
			const replaceError = error as ManagedReplaceError;
			expect(replaceError.code).toBe("cleanup_pending");
			expect(replaceError.detachedPath).toBe(detached);
			expect(replaceError.retainedPlaceholderPath).toBe(replaceError.cleanupReceiptPath);
			expect(replaceError.retainedUnknownPath).toBe(unknown);
			expect(fs.readFileSync(destination, "utf8")).toBe("successor\n");
			expect(fs.existsSync(replaceError.detachedPath!)).toBe(true);
			expect(fs.existsSync(replaceError.retainedPlaceholderPath!)).toBe(true);
			expect(fs.readFileSync(replaceError.retainedUnknownPath!, "utf8")).toBe("unknown\n");
		} finally {
			exactUnlink?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("never deletes a committed successor moved back to staging after native return", () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-replace-postcommit-")),
		);
		let exactReplace: Mock<typeof native.exactReplacePath> | undefined;
		let committedSource: string | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("authorized\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			const predecessor = path.join(sessionDir, "authorized.jsonl");
			exactReplace = vi.spyOn(native, "exactReplacePath").mockImplementation((sourcePath, destinationPath) => {
				fs.renameSync(destinationPath, predecessor);
				fs.renameSync(sourcePath, destinationPath);
				fs.renameSync(destinationPath, sourcePath);
				fs.writeFileSync(destinationPath, "attacker\n", { mode: 0o600 });
				committedSource = sourcePath;
				return { ok: true };
			});

			expect(() => store.replaceSync("session.jsonl", Buffer.from("successor\n"))).toThrow(
				"managed_replace_committed_outcome_uncertain",
			);
			if (!committedSource) throw new Error("Expected native replacement source");
			expect(fs.readFileSync(committedSource, "utf8")).toBe("successor\n");
			expect(fs.readFileSync(destination, "utf8")).toBe("attacker\n");
			expect(fs.readFileSync(predecessor, "utf8")).toBe("authorized\n");
		} finally {
			exactReplace?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("identity-binds receipt retirement when the successor is moved onto the receipt name", () => {
		const root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-darwin-replace-postreceipt-")),
		);
		const realExactReplacePath = native.exactReplacePath;
		const realExactUnlink = native.exactUnlink;
		let exactReplace: Mock<typeof native.exactReplacePath> | undefined;
		let exactUnlink: Mock<typeof native.exactUnlink> | undefined;
		let committedSource: string | undefined;
		let moved = false;
		let retainedReceipt: string | undefined;
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("authorized\n"));
			const destination = path.join(sessionDir, "session.jsonl");
			exactReplace = vi
				.spyOn(native, "exactReplacePath")
				.mockImplementation((sourcePath, destinationPath, expectedSource, expectedDestination) => {
					committedSource = sourcePath;
					return realExactReplacePath(sourcePath, destinationPath, expectedSource, expectedDestination);
				});
			exactUnlink = vi.spyOn(native, "exactUnlink").mockImplementation((...args) => {
				if (!moved && args[0].includes(".gjc-replace-cleanup-")) {
					if (!committedSource) throw new Error("Expected native replacement source");
					retainedReceipt = `${args[0]}.retained`;
					fs.renameSync(args[0], retainedReceipt);
					fs.renameSync(destination, args[0]);
					fs.writeFileSync(destination, "attacker\n", { mode: 0o600 });
					moved = true;
				}
				return realExactUnlink(...args);
			});

			expect(() => store.replaceSync("session.jsonl", Buffer.from("successor\n"))).toThrow(
				"managed_replace_failed:identity_mismatch",
			);
			if (!committedSource) throw new Error("Expected native replacement source");
			expect(moved).toBe(true);
			if (!retainedReceipt) throw new Error("Expected retained receipt");
			expect(fs.readFileSync(retainedReceipt, "utf8")).toContain('"version":3');
			expect(fs.readFileSync(destination, "utf8")).toBe("attacker\n");
			const retainedSuccessor = fs
				.readdirSync(sessionDir)
				.map(name => path.join(sessionDir, name))
				.some(pathname => {
					try {
						return fs.readFileSync(pathname, "utf8") === "successor\n";
					} catch {
						return false;
					}
				});
			expect(retainedSuccessor).toBe(true);
		} finally {
			exactUnlink?.mockRestore();
			exactReplace?.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
describe.skipIf(process.platform !== "darwin")("managed replacement receipt detachment", () => {
	let root: string;
	let leaveReceiptPlaceholder = false;

	type ReceiptTestSnapshot = {
		dev: string;
		ino: string;
		nlink: string;
		size: string;
		mtimeNs: string;
		ctimeNs: string;
		sha256: string;
	};
	const snapshot = (pathname: string): ReceiptTestSnapshot => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			nlink: stat.nlink.toString(),
			size: stat.size.toString(),
			mtimeNs: stat.mtimeNs.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			sha256: createHash("sha256").update(fs.readFileSync(pathname)).digest("hex"),
		};
	};
	const receiptPath = (predecessor: ReceiptTestSnapshot, receipt: ReceiptTestSnapshot) =>
		path.join(
			root,
			`.gjc-replace-cleanup-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}-receipt-${BigInt(receipt.dev).toString(16)}-${BigInt(receipt.ino).toString(16)}.json`,
		);
	const publishReceipt = (predecessor: ReceiptTestSnapshot, contents: string) => {
		const pending = path.join(root, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
		fs.writeFileSync(pending, contents);
		const receiptIdentity = snapshot(pending);
		const receipt = receiptPath(predecessor, receiptIdentity);
		fs.renameSync(pending, receipt);
		return { receipt, receiptIdentity };
	};
	const receiptQuarantine = (receipt: ReceiptTestSnapshot, predecessor: ReceiptTestSnapshot) =>
		path.join(
			root,
			`.gjc-receipt-remove-${BigInt(receipt.dev).toString(16)}-${BigInt(receipt.ino).toString(16)}-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}`,
		);
	const replay = (name: string) => {
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
		store.publishNoReplaceSync(name, Buffer.from("trigger\n"));
	};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-replace-journal-"));
		leaveReceiptPlaceholder = false;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			const stat = fs.lstatSync(pathname, { bigint: true });
			const sha256 = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
			if (
				expected.directory ||
				!expected.quarantineName ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.dev !== expected.dev ||
				stat.ino !== expected.ino ||
				stat.nlink !== expected.nlink ||
				stat.size !== expected.size ||
				stat.mtimeNs !== expected.mtimeNs ||
				sha256 !== expected.sha256
			)
				return { ok: false, code: "identity_mismatch" };
			const detachedPath = path.join(root, expected.quarantineName);
			fs.renameSync(pathname, detachedPath);
			if (expected.detachOnly && leaveReceiptPlaceholder) {
				leaveReceiptPlaceholder = false;
				fs.writeFileSync(pathname, "");
				return { ok: false, code: "cleanup_pending", detachedPath, retainedPlaceholderPath: pathname };
			}
			return { ok: true, detachedPath };
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("detaches an advisory receipt without retiring its predecessor, successor, or staging object", () => {
		const destination = path.join(root, "session.jsonl");
		const staging = path.join(root, ".session.replacement");
		const predecessorPath = path.join(root, ".gjc-exact-replace-destination-retained");
		fs.writeFileSync(destination, "committed successor\n");
		fs.writeFileSync(staging, "prepared successor\n");
		fs.writeFileSync(predecessorPath, "retained predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt, receiptIdentity } = publishReceipt(
			predecessor,
			JSON.stringify({
				version: 3,
				staging,
				destination,
				predecessor,
				successor: snapshot(destination),
			}),
		);

		replay("receipt-detached");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.readFileSync(receiptQuarantine(receiptIdentity, predecessor), "utf8")).toContain('"version":3');
		expect(fs.readFileSync(destination, "utf8")).toBe("committed successor\n");
		expect(fs.readFileSync(staging, "utf8")).toBe("prepared successor\n");
		expect(fs.readFileSync(predecessorPath, "utf8")).toBe("retained predecessor\n");
		expect(fs.readFileSync(path.join(root, "receipt-detached"), "utf8")).toBe("trigger\n");
	});

	it("reconciles an exchange placeholder left by an interrupted receipt cleanup", () => {
		vi.restoreAllMocks();
		const predecessorPath = path.join(root, "predecessor-real-native");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt, receiptIdentity } = publishReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);
		const firstQuarantine = receiptQuarantine(receiptIdentity, predecessor);
		fs.renameSync(receipt, firstQuarantine);
		fs.writeFileSync(receipt, "");

		replay("placeholder-real-native");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.readFileSync(firstQuarantine, "utf8")).toContain("advisory");
		expect(fs.existsSync(path.join(root, "placeholder-real-native"))).toBe(true);
	});
	it("recovers a regular-file cleanup placeholder without deleting either quarantined receipt", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt, receiptIdentity } = publishReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);
		const firstQuarantine = receiptQuarantine(receiptIdentity, predecessor);
		leaveReceiptPlaceholder = true;

		replay("placeholder-first");

		expect(fs.lstatSync(receipt).isFile()).toBe(true);
		expect(fs.readFileSync(receipt, "utf8")).toBe("");
		expect(fs.existsSync(firstQuarantine)).toBe(true);

		replay("placeholder-second");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.readFileSync(firstQuarantine, "utf8")).toContain("advisory");
		expect(fs.readFileSync(predecessorPath, "utf8")).toBe("predecessor\n");
		expect(fs.existsSync(path.join(root, "placeholder-second"))).toBe(true);
	});

	it("does not let an alias receipt delete the live transcript", () => {
		const transcript = path.join(root, "session.jsonl");
		fs.writeFileSync(transcript, "committed transcript\n");
		const live = snapshot(transcript);
		const { receipt, receiptIdentity } = publishReceipt(
			live,
			JSON.stringify({
				version: 3,
				staging: transcript,
				destination: transcript,
				predecessor: live,
				successor: live,
			}),
		);

		replay("alias-receipt");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.readFileSync(receiptQuarantine(receiptIdentity, live), "utf8")).toContain('"staging"');
		expect(fs.readFileSync(transcript, "utf8")).toBe("committed transcript\n");
		expect(fs.readFileSync(path.join(root, "alias-receipt"), "utf8")).toBe("trigger\n");
	});

	it("fails closed when the canonical receipt pathname is substituted before replay", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const contents = JSON.stringify({ arbitrary: "receipt contents are advisory" });
		const { receipt } = publishReceipt(predecessor, contents);
		const retainedOriginal = `${receipt}.original`;
		fs.renameSync(receipt, retainedOriginal);
		fs.writeFileSync(receipt, contents);

		expect(() => replay("substituted-receipt")).toThrow("managed_replace_cleanup_receipt_invalid");

		expect(fs.readFileSync(receipt, "utf8")).toBe(contents);
		expect(fs.readFileSync(retainedOriginal, "utf8")).toBe(contents);
		expect(fs.readFileSync(predecessorPath, "utf8")).toBe("predecessor\n");
		expect(fs.existsSync(path.join(root, "substituted-receipt"))).toBe(false);
	});

	it("fails closed on a malformed canonical receipt filename", () => {
		const malformed = path.join(root, ".gjc-replace-cleanup-00-1.json");
		fs.writeFileSync(malformed, "receipt");

		expect(() => replay("malformed-receipt")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.readFileSync(malformed, "utf8")).toBe("receipt");
	});
	it("reconciles a legacy version-one cleanup receipt from an earlier release", () => {
		vi.restoreAllMocks();
		const predecessorSeed = path.join(root, ".predecessor");
		const predecessorContents = "predecessor\n";
		fs.writeFileSync(predecessorSeed, predecessorContents, { mode: 0o600 });
		const seedIdentity = snapshot(predecessorSeed);
		const predecessorPath = path.join(
			root,
			`.gjc-exact-replace-destination-${BigInt(seedIdentity.dev).toString(16)}-${BigInt(seedIdentity.ino).toString(16)}`,
		);
		fs.renameSync(predecessorSeed, predecessorPath);
		const predecessor = snapshot(predecessorPath);
		const receipt = path.join(
			root,
			`.gjc-replace-cleanup-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}.json`,
		);
		fs.writeFileSync(
			receipt,
			JSON.stringify({
				version: 1,
				predecessor: predecessorPath,
				successor: path.join(root, "session.jsonl"),
				identity: predecessor,
			}),
			{ mode: 0o600 },
		);

		replay("legacy-receipt");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.existsSync(path.join(root, "legacy-receipt"))).toBe(true);
		expect(fs.existsSync(predecessorPath)).toBe(false);
	});
});
describe("replacement cleanup receipt reconcile TOCTOU resilience", () => {
	let root: string;

	type ReceiptTestSnapshot = {
		dev: string;
		ino: string;
		nlink: string;
		size: string;
		mtimeNs: string;
		ctimeNs: string;
		sha256: string;
	};
	const snapshot = (pathname: string): ReceiptTestSnapshot => {
		const stat = fs.lstatSync(pathname, { bigint: true });
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			nlink: stat.nlink.toString(),
			size: stat.size.toString(),
			mtimeNs: stat.mtimeNs.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			sha256: createHash("sha256").update(fs.readFileSync(pathname)).digest("hex"),
		};
	};
	const canonicalReceiptPath = (predecessor: ReceiptTestSnapshot, receipt: ReceiptTestSnapshot) =>
		path.join(
			root,
			`.gjc-replace-cleanup-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}-receipt-${BigInt(receipt.dev).toString(16)}-${BigInt(receipt.ino).toString(16)}.json`,
		);
	const publishCanonicalReceipt = (predecessor: ReceiptTestSnapshot, contents: string) => {
		const pending = path.join(root, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
		fs.writeFileSync(pending, contents);
		const receiptIdentity = snapshot(pending);
		const receipt = canonicalReceiptPath(predecessor, receiptIdentity);
		fs.renameSync(pending, receipt);
		return { receipt, receiptIdentity };
	};
	const receiptQuarantine = (receipt: ReceiptTestSnapshot, predecessor: ReceiptTestSnapshot) =>
		path.join(
			root,
			`.gjc-receipt-remove-${BigInt(receipt.dev).toString(16)}-${BigInt(receipt.ino).toString(16)}-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}`,
		);
	const legacyReceiptPath = (predecessor: ReceiptTestSnapshot) =>
		path.join(
			root,
			`.gjc-replace-cleanup-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}.json`,
		);
	const replay = (name: string) => {
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
		store.publishNoReplaceSync(name, Buffer.from("trigger\n"));
	};
	const pendingReceipt = () => {
		const destination = path.join(root, "session.jsonl");
		const staging = path.join(root, ".session.replacement");
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(destination, "successor\n");
		fs.writeFileSync(staging, "prepared\n");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const pending = path.join(root, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
		fs.writeFileSync(
			pending,
			JSON.stringify({
				version: 3,
				staging,
				destination,
				predecessor,
				successor: snapshot(destination),
			}),
		);
		const receiptIdentity = snapshot(pending);
		return { pending, receipt: canonicalReceiptPath(predecessor, receiptIdentity) };
	};
	const invalidRequest = () =>
		({
			ok: false,
			code: "invalid_request",
			reason: "invalid_request",
			phase: "preflight",
			mutationState: "not_committed",
			durabilityState: "not_attempted",
			primitive: "windows_rename_noreplace",
			diagnostic: { schemaVersion: 1, collectionState: "complete", osCode: 87 },
		}) as const;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-replace-toctou-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("accepts invalid_request when another reconciler has already moved the pending receipt", () => {
		const { pending, receipt } = pendingReceipt();
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			if (source !== pending) return realRename(source, destination);
			fs.renameSync(source, destination);
			return invalidRequest();
		});

		replay("concurrent-reconcile");

		expect(fs.existsSync(pending)).toBe(false);
		expect(fs.existsSync(receipt)).toBe(true);
		expect(fs.existsSync(path.join(root, "concurrent-reconcile"))).toBe(true);
	});

	it("accepts a real native lost-source result only for the exact peer-promoted orphan receipt", () => {
		const { pending, receipt } = pendingReceipt();
		const originalBytes = fs.readFileSync(pending);
		const originalInode = fs.statSync(pending).ino;
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			if (source !== pending) return realRename(source, destination);
			expect(realRename(source, destination).ok).toBe(true);
			return realRename(source, destination);
		});

		replay("native-concurrent-reconcile");

		expect(fs.existsSync(pending)).toBe(false);
		expect(fs.statSync(receipt).ino).toBe(originalInode);
		expect(fs.readFileSync(receipt).equals(originalBytes)).toBe(true);
		expect(fs.existsSync(path.join(root, "native-concurrent-reconcile"))).toBe(true);
	});

	it("refuses a real native lost-source result when the promoted receipt was replaced", () => {
		const { pending, receipt } = pendingReceipt();
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			if (source !== pending) return realRename(source, destination);
			expect(realRename(source, destination).ok).toBe(true);
			const replacement = `${destination}.replacement`;
			fs.copyFileSync(destination, replacement);
			fs.renameSync(replacement, destination);
			return realRename(source, destination);
		});

		expect(() => replay("unproven-native-reconcile")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(receipt)).toBe(true);
		expect(fs.existsSync(path.join(root, "unproven-native-reconcile"))).toBe(false);
	});

	it("canonicalizes signed file ids from an interrupted pending Windows receipt", () => {
		const destination = path.join(root, "session.jsonl");
		const staging = path.join(root, ".session.replacement");
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(destination, "successor\n");
		fs.writeFileSync(staging, "prepared\n");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const successor = snapshot(destination);
		const signedIno = -7_984_882_139_327_873_970n;
		const pending = path.join(root, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
		fs.writeFileSync(
			pending,
			JSON.stringify({
				version: 3,
				staging,
				destination,
				predecessor: { ...predecessor, ino: signedIno.toString() },
				successor: { ...successor, ino: signedIno.toString() },
			}),
		);
		let publishedReceiptPath: string | undefined;
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) => {
			if (source === pending) publishedReceiptPath = target;
			return realRename(source, target);
		});

		replay("signed-pending-receipt");

		expect(publishedReceiptPath).toContain(BigInt.asUintN(64, signedIno).toString(16));
		expect(path.basename(publishedReceiptPath!)).not.toContain("--");
		expect(fs.existsSync(path.join(root, "signed-pending-receipt"))).toBe(true);
	});

	it("reconciles an already-written double-hyphen Windows receipt without weakening inode authority", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const pending = path.join(root, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
		fs.writeFileSync(pending, JSON.stringify({ version: 3, legacy: "signed Windows file id" }));
		const actualReceipt = snapshot(pending);
		const signedIno = -7_984_882_139_327_873_970n;
		const unsignedIno = BigInt.asUintN(64, signedIno);
		const receipt = path.join(
			root,
			`.gjc-replace-cleanup-${BigInt(predecessor.dev).toString(16)}-${BigInt(predecessor.ino).toString(16)}-receipt-${BigInt(actualReceipt.dev).toString(16)}-${signedIno.toString(16)}.json`,
		);
		fs.renameSync(pending, receipt);
		const actualIno = BigInt(actualReceipt.ino);
		const realFstat = fs.fstatSync.bind(fs);
		const realLstat = fs.lstatSync.bind(fs);
		const withSignedIno = (stat: fs.BigIntStats): fs.BigIntStats => {
			const synthetic = Object.create(stat) as fs.BigIntStats;
			Object.defineProperty(synthetic, "ino", { value: signedIno });
			return synthetic;
		};
		vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
			const stat = realFstat(fd, options as never) as unknown as fs.BigIntStats;
			return stat.ino === actualIno ? withSignedIno(stat) : stat;
		}) as typeof fs.fstatSync);
		vi.spyOn(fs, "lstatSync").mockImplementation(((pathname: fs.PathLike, options?: fs.StatOptions) => {
			const stat = realLstat(pathname, options as never) as unknown as fs.BigIntStats;
			return path.resolve(String(pathname)) === receipt ? withSignedIno(stat) : stat;
		}) as typeof fs.lstatSync);
		const realExactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			if (pathname !== receipt) return realExactUnlink(pathname, expected);
			expect(expected.ino).toBe(unsignedIno);
			expect(expected.quarantineName).not.toContain("--");
			const detachedPath = path.join(root, expected.quarantineName!);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});

		replay("signed-canonical-receipt");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.existsSync(path.join(root, "signed-canonical-receipt"))).toBe(true);
	});

	it("recovers a signed version-one receipt only through its fully validated predecessor proof", () => {
		const predecessorSeed = path.join(root, ".predecessor");
		fs.writeFileSync(predecessorSeed, "predecessor\n");
		const actualPredecessor = snapshot(predecessorSeed);
		const signedIno = -7_984_882_139_327_873_970n;
		const unsignedIno = BigInt.asUintN(64, signedIno);
		const predecessor = path.join(
			root,
			`.gjc-exact-replace-destination-${BigInt(actualPredecessor.dev).toString(16)}-${signedIno.toString(16)}`,
		);
		fs.renameSync(predecessorSeed, predecessor);
		const receipt = path.join(
			root,
			`.gjc-replace-cleanup-${BigInt(actualPredecessor.dev).toString(16)}-${signedIno.toString(16)}.json`,
		);
		fs.writeFileSync(
			receipt,
			JSON.stringify({
				version: 1,
				predecessor,
				successor: path.join(root, "session.jsonl"),
				identity: { ...actualPredecessor, ino: signedIno.toString() },
			}),
		);
		const actualIno = BigInt(actualPredecessor.ino);
		const realFstat = fs.fstatSync.bind(fs);
		const realLstat = fs.lstatSync.bind(fs);
		const withSignedIno = (stat: fs.BigIntStats): fs.BigIntStats => {
			const synthetic = Object.create(stat) as fs.BigIntStats;
			Object.defineProperty(synthetic, "ino", { value: signedIno });
			return synthetic;
		};
		vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
			const stat = realFstat(fd, options as never) as unknown as fs.BigIntStats;
			return stat.ino === actualIno ? withSignedIno(stat) : stat;
		}) as typeof fs.fstatSync);
		vi.spyOn(fs, "lstatSync").mockImplementation(((pathname: fs.PathLike, options?: fs.StatOptions) => {
			const stat = realLstat(pathname, options as never) as unknown as fs.BigIntStats;
			return path.resolve(String(pathname)) === predecessor ? withSignedIno(stat) : stat;
		}) as typeof fs.lstatSync);
		const realExactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			if (pathname !== predecessor && pathname !== receipt) return realExactUnlink(pathname, expected);
			if (pathname === predecessor) expect(expected.ino).toBe(unsignedIno);
			fs.unlinkSync(pathname);
			return { ok: true };
		});

		replay("signed-v1-receipt");

		expect(fs.existsSync(predecessor)).toBe(false);
		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.existsSync(path.join(root, "signed-v1-receipt"))).toBe(true);
	});

	it("rejects non-canonical and out-of-range signed receipt file ids", () => {
		for (const ino of ["-0", "-01", "-8000000000000001"]) {
			const receipt = path.join(root, `.gjc-replace-cleanup-1-2-receipt-3-${ino}.json`);
			fs.writeFileSync(receipt, "receipt");

			expect(() => replay(`invalid-signed-${ino}`)).toThrow("managed_replace_cleanup_receipt_invalid");
			expect(fs.readFileSync(receipt, "utf8")).toBe("receipt");
			fs.rmSync(receipt);
		}
	});

	it("rejects an out-of-range signed identity in an interrupted pending receipt", () => {
		const destination = path.join(root, "session.jsonl");
		const staging = path.join(root, ".session.replacement");
		fs.writeFileSync(destination, "successor\n");
		fs.writeFileSync(staging, "prepared\n");
		const identity = snapshot(destination);
		const pending = path.join(root, `.gjc-replace-receipt-pending-${randomUUID()}.json`);
		fs.writeFileSync(
			pending,
			JSON.stringify({
				version: 3,
				staging,
				destination,
				predecessor: { ...identity, ino: "-9223372036854775809" },
				successor: identity,
			}),
		);

		expect(() => replay("invalid-signed-pending")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(pending)).toBe(true);
		expect(fs.existsSync(path.join(root, "invalid-signed-pending"))).toBe(false);
	});

	it("rejects invalid_request when the pending receipt disappears into a conflicting destination", () => {
		const { pending, receipt } = pendingReceipt();
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			if (source !== pending) return realRename(source, destination);
			fs.rmSync(source);
			fs.writeFileSync(destination, "conflicting receipt\n");
			return invalidRequest();
		});

		expect(() => replay("conflicting-move")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(pending)).toBe(false);
		expect(fs.readFileSync(receipt, "utf8")).toBe("conflicting receipt\n");
		expect(fs.existsSync(path.join(root, "conflicting-move"))).toBe(false);
	});

	it("rejects a byte-identical destination copy because it lacks the receipt filesystem identity", () => {
		const { pending, receipt } = pendingReceipt();
		fs.copyFileSync(pending, receipt);
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			if (source === pending) return invalidRequest();
			return realRename(source, destination);
		});

		expect(() => replay("identical-receipt")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(pending)).toBe(true);
		expect(fs.existsSync(receipt)).toBe(true);
		expect(fs.existsSync(path.join(root, "identical-receipt"))).toBe(false);
	});

	it("rejects invalid_request when the existing destination receipt has different contents", () => {
		const { pending, receipt } = pendingReceipt();
		fs.writeFileSync(receipt, "different receipt\n");
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) =>
			source === pending ? invalidRequest() : realRename(source, destination),
		);

		expect(() => replay("conflicting-receipt")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(pending)).toBe(true);
		expect(fs.existsSync(receipt)).toBe(true);
	});

	it("rejects invalid_request when both receipt paths disappear", () => {
		const { pending, receipt } = pendingReceipt();
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) => {
			if (source !== pending) return realRename(source, destination);
			fs.rmSync(source);
			return invalidRequest();
		});

		expect(() => replay("missing-receipts")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(pending)).toBe(false);
		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.existsSync(path.join(root, "missing-receipts"))).toBe(false);
	});

	it("preserves invalid_request when only the pending receipt exists", () => {
		const { pending, receipt } = pendingReceipt();
		const realRename = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, destination) =>
			source === pending ? invalidRequest() : realRename(source, destination),
		);

		expect(() => replay("genuine-invalid-request")).toThrow("invalid_request");
		expect(fs.existsSync(pending)).toBe(true);
		expect(fs.existsSync(receipt)).toBe(false);
	});

	it("continues reconcile when a canonical receipt disappears between capture and unlink (native not_found)", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt, receiptIdentity } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);
		const secondPredecessorPath = path.join(root, "predecessor-2");
		fs.writeFileSync(secondPredecessorPath, "predecessor-2\n");
		const secondPredecessor = snapshot(secondPredecessorPath);
		const { receipt: secondReceipt, receiptIdentity: secondReceiptIdentity } = publishCanonicalReceipt(
			secondPredecessor,
			JSON.stringify({ arbitrary: "second receipt contents are advisory" }),
		);

		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			// First receipt: simulate concurrent disappearance — return not_found.
			if (pathname === receipt) return { ok: false, code: "not_found" };
			// Second receipt: normal detach.
			const stat = fs.lstatSync(pathname, { bigint: true });
			const sha256 = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
			if (
				expected.directory ||
				!expected.quarantineName ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.dev !== expected.dev ||
				stat.ino !== expected.ino ||
				stat.nlink !== expected.nlink ||
				stat.size !== expected.size ||
				stat.mtimeNs !== expected.mtimeNs ||
				sha256 !== expected.sha256
			)
				return { ok: false, code: "identity_mismatch" };
			const detachedPath = path.join(root, expected.quarantineName);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});

		replay("toctou-not-found");

		// First receipt soft-skipped (still on disk, not quarantined — it's just gone from the
		// native's perspective).
		expect(fs.existsSync(receiptQuarantine(receiptIdentity, predecessor))).toBe(false);
		// Second receipt detached cleanly.
		expect(fs.existsSync(secondReceipt)).toBe(false);
		expect(fs.readFileSync(receiptQuarantine(secondReceiptIdentity, secondPredecessor), "utf8")).toContain(
			"second receipt",
		);
		expect(fs.existsSync(path.join(root, "toctou-not-found"))).toBe(true);
	});

	it("defers a canonical receipt cleanup I/O failure without blocking a session mutation", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);

		vi.spyOn(native, "exactUnlink").mockImplementation(pathname => {
			if (pathname === receipt) return { ok: false, code: "io_error" };
			throw new Error(`Unexpected exact unlink: ${pathname}`);
		});
		replay("cleanup-io-error");

		expect(fs.existsSync(receipt)).toBe(true);
		expect(fs.existsSync(path.join(root, "cleanup-io-error"))).toBe(true);
	});

	it("retries a retained canonical receipt after a transient I/O failure", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);
		const realExactUnlink = native.exactUnlink;
		let firstAttempt = true;

		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			if (pathname === receipt && firstAttempt) {
				firstAttempt = false;
				return { ok: false, code: "io_error" };
			}
			return realExactUnlink(pathname, expected);
		});
		replay("cleanup-io-error-first-attempt");
		expect(fs.existsSync(receipt)).toBe(true);

		replay("cleanup-io-error-retry");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.existsSync(path.join(root, "cleanup-io-error-retry"))).toBe(true);
	});

	it("keeps canonical receipt identity failures fail-closed", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);

		vi.spyOn(native, "exactUnlink").mockImplementation(pathname => {
			if (pathname === receipt) return { ok: false, code: "identity_mismatch" };
			throw new Error(`Unexpected exact unlink: ${pathname}`);
		});

		expect(() => replay("cleanup-identity-mismatch")).toThrow(
			"managed_replace_receipt_cleanup_pending:identity_mismatch",
		);
		expect(fs.existsSync(receipt)).toBe(true);
		expect(fs.existsSync(path.join(root, "cleanup-identity-mismatch"))).toBe(false);
	});

	it("defers a canonical receipt whose retirement slot a peer has already claimed", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const contents = JSON.stringify({ arbitrary: "receipt contents are advisory" });
		const { receipt, receiptIdentity } = publishCanonicalReceipt(predecessor, contents);
		// A peer's native exact-unlink claims the slot with an empty exchange
		// placeholder before it swaps the receipt out of its canonical name.
		const slot = receiptQuarantine(receiptIdentity, predecessor);
		fs.writeFileSync(slot, "");
		const peerClaim = snapshot(slot);
		const retainedReceipt = snapshot(receipt);
		const exactUnlink = vi.spyOn(native, "exactUnlink");

		replay("peer-claimed-slot");

		expect(exactUnlink.mock.results.find(result => result.type === "return")?.value).toMatchObject({
			ok: false,
			code: "quarantine_collision",
		});
		expect(snapshot(receipt)).toEqual(retainedReceipt);
		expect(snapshot(slot)).toEqual(peerClaim);
		expect(fs.existsSync(path.join(root, "peer-claimed-slot"))).toBe(true);

		// Once the claim is released without retiring the receipt, the retained
		// receipt is reconciled by the next mutation.
		fs.unlinkSync(slot);
		replay("peer-released-slot");

		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.readFileSync(slot, "utf8")).toBe(contents);
		expect(fs.existsSync(path.join(root, "peer-released-slot"))).toBe(true);
	});

	it("defers a detached receipt placeholder whose retirement slot a peer has already claimed", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt, receiptIdentity } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);
		// A peer detached the receipt and left its empty exchange placeholder at the
		// canonical name; a second peer already claimed the placeholder's slot.
		const detachedReceipt = receiptQuarantine(receiptIdentity, predecessor);
		fs.renameSync(receipt, detachedReceipt);
		fs.writeFileSync(receipt, "");
		const placeholder = snapshot(receipt);
		const hex = (value: string) => BigInt(value).toString(16);
		const placeholderSlot = path.join(
			root,
			`.gjc-receipt-placeholder-remove-${hex(placeholder.dev)}-${hex(placeholder.ino)}-${hex(predecessor.dev)}-${hex(predecessor.ino)}-${hex(receiptIdentity.dev)}-${hex(receiptIdentity.ino)}`,
		);
		fs.writeFileSync(placeholderSlot, "");
		const peerClaim = snapshot(placeholderSlot);

		replay("peer-claimed-placeholder-slot");

		expect(snapshot(receipt)).toEqual(placeholder);
		expect(snapshot(placeholderSlot)).toEqual(peerClaim);
		expect(snapshot(detachedReceipt)).toMatchObject({ ino: receiptIdentity.ino, sha256: receiptIdentity.sha256 });
		expect(fs.existsSync(path.join(root, "peer-claimed-placeholder-slot"))).toBe(true);
	});

	it("keeps a receipt slot collision that retained receipt state fail-closed", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);

		vi.spyOn(native, "exactUnlink").mockImplementation(pathname => {
			if (pathname === receipt)
				return { ok: false, code: "quarantine_collision", retainedUnknownPath: path.join(root, ".unknown") };
			throw new Error(`Unexpected exact unlink: ${pathname}`);
		});

		expect(() => replay("collision-retained-state")).toThrow(
			"managed_replace_receipt_cleanup_pending:quarantine_collision",
		);
		expect(fs.existsSync(receipt)).toBe(true);
		expect(fs.existsSync(path.join(root, "collision-retained-state"))).toBe(false);
	});

	it.skipIf(process.platform !== "darwin")(
		"keeps an exact replacement I/O failure fail-closed because replacement state is unknown",
		() => {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("predecessor\n"));
			const destination = path.join(sessionDir, "session.jsonl");

			vi.spyOn(native, "exactReplacePath").mockReturnValue({ ok: false, code: "io_error" });

			expect(() => store.replaceSync("session.jsonl", Buffer.from("successor\n"))).toThrow(
				"managed_replace_failed:io_error",
			);
			expect(fs.readFileSync(destination, "utf8")).toBe("predecessor\n");
			expect(fs.readdirSync(sessionDir).some(name => name.startsWith(".gjc-replace-cleanup-"))).toBe(true);
		},
	);

	it("continues reconcile when a canonical receipt disappears before first capture (ENOENT)", () => {
		const predecessorPath = path.join(root, "predecessor");
		fs.writeFileSync(predecessorPath, "predecessor\n");
		const predecessor = snapshot(predecessorPath);
		const { receipt } = publishCanonicalReceipt(
			predecessor,
			JSON.stringify({ arbitrary: "receipt contents are advisory" }),
		);
		const realOpenSync = fs.openSync;
		let receiptRemoved = false;
		vi.spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
			if (!receiptRemoved && file === receipt) {
				receiptRemoved = true;
				fs.unlinkSync(receipt);
			}
			return realOpenSync(file, flags, mode);
		}) as typeof fs.openSync);

		replay("toctou-canonical-enoent");

		expect(receiptRemoved).toBe(true);
		expect(fs.existsSync(receipt)).toBe(false);
		expect(fs.existsSync(path.join(root, "toctou-canonical-enoent"))).toBe(true);
	});

	it("continues reconcile when a legacy receipt disappears before first capture (ENOENT)", () => {
		const predecessorSeed = path.join(root, ".predecessor");
		const predecessorContents = "predecessor\n";
		fs.writeFileSync(predecessorSeed, predecessorContents, { mode: 0o600 });
		const seedIdentity = snapshot(predecessorSeed);
		const predecessorPath = path.join(
			root,
			`.gjc-exact-replace-destination-${BigInt(seedIdentity.dev).toString(16)}-${BigInt(seedIdentity.ino).toString(16)}`,
		);
		fs.renameSync(predecessorSeed, predecessorPath);
		const predecessor = snapshot(predecessorPath);
		const receipt = legacyReceiptPath(predecessor);
		fs.writeFileSync(
			receipt,
			JSON.stringify({
				version: 1,
				predecessor: predecessorPath,
				successor: path.join(root, "session.jsonl"),
				identity: predecessor,
			}),
			{ mode: 0o600 },
		);

		// Second canonical receipt that should detach cleanly.
		const secondPredecessorPath = path.join(root, "predecessor-2");
		fs.writeFileSync(secondPredecessorPath, "predecessor-2\n");
		const secondPredecessor = snapshot(secondPredecessorPath);
		const { receipt: secondReceipt, receiptIdentity: secondReceiptIdentity } = publishCanonicalReceipt(
			secondPredecessor,
			JSON.stringify({ arbitrary: "second receipt contents are advisory" }),
		);

		// Remove the legacy receipt after readdir returns but before capture opens it.
		const realOpenSync = fs.openSync;
		let receiptRemoved = false;
		vi.spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
			if (!receiptRemoved && file === receipt) {
				receiptRemoved = true;
				fs.unlinkSync(receipt);
			}
			return realOpenSync(file, flags, mode);
		}) as typeof fs.openSync);

		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			const stat = fs.lstatSync(pathname, { bigint: true });
			const sha256 = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
			if (
				expected.directory ||
				!expected.quarantineName ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.dev !== expected.dev ||
				stat.ino !== expected.ino ||
				stat.nlink !== expected.nlink ||
				stat.size !== expected.size ||
				stat.mtimeNs !== expected.mtimeNs ||
				sha256 !== expected.sha256
			)
				return { ok: false, code: "identity_mismatch" };
			const detachedPath = path.join(root, expected.quarantineName);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});

		replay("toctou-legacy-enoent");
		expect(receiptRemoved).toBe(true);

		expect(fs.existsSync(path.join(root, "toctou-legacy-enoent"))).toBe(true);
		expect(fs.existsSync(secondReceipt)).toBe(false);
		expect(fs.readFileSync(receiptQuarantine(secondReceiptIdentity, secondPredecessor), "utf8")).toContain(
			"second receipt",
		);
	});

	it("continues reconcile when a legacy receipt disappears before re-capture after predecessor retirement", () => {
		const predecessorSeed = path.join(root, ".predecessor");
		const predecessorContents = "predecessor\n";
		fs.writeFileSync(predecessorSeed, predecessorContents, { mode: 0o600 });
		const seedIdentity = snapshot(predecessorSeed);
		const predecessorPath = path.join(
			root,
			`.gjc-exact-replace-destination-${BigInt(seedIdentity.dev).toString(16)}-${BigInt(seedIdentity.ino).toString(16)}`,
		);
		fs.renameSync(predecessorSeed, predecessorPath);
		const predecessor = snapshot(predecessorPath);
		const receipt = legacyReceiptPath(predecessor);
		fs.writeFileSync(
			receipt,
			JSON.stringify({
				version: 1,
				predecessor: predecessorPath,
				successor: path.join(root, "session.jsonl"),
				identity: predecessor,
			}),
			{ mode: 0o600 },
		);

		// Second canonical receipt that should detach cleanly.
		const secondPredecessorPath = path.join(root, "predecessor-2");
		fs.writeFileSync(secondPredecessorPath, "predecessor-2\n");
		const secondPredecessor = snapshot(secondPredecessorPath);
		const { receipt: secondReceipt, receiptIdentity: secondReceiptIdentity } = publishCanonicalReceipt(
			secondPredecessor,
			JSON.stringify({ arbitrary: "second receipt contents are advisory" }),
		);

		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, expected) => {
			// When retiring the legacy predecessor, simulate concurrent receipt disappearance
			// as a side-effect — the receipt is gone by the time re-capture runs.
			if (pathname === predecessorPath) {
				fs.unlinkSync(receipt);
				const detachedPath = path.join(root, expected.quarantineName!);
				fs.renameSync(pathname, detachedPath);
				return { ok: true, detachedPath };
			}
			const stat = fs.lstatSync(pathname, { bigint: true });
			const sha256 = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
			if (
				expected.directory ||
				!expected.quarantineName ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.dev !== expected.dev ||
				stat.ino !== expected.ino ||
				stat.nlink !== expected.nlink ||
				stat.size !== expected.size ||
				stat.mtimeNs !== expected.mtimeNs ||
				sha256 !== expected.sha256
			)
				return { ok: false, code: "identity_mismatch" };
			const detachedPath = path.join(root, expected.quarantineName);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		});

		expect(() => replay("toctou-legacy-recapture")).not.toThrow();

		// Legacy predecessor was retired.
		expect(fs.existsSync(predecessorPath)).toBe(false);
		// Legacy receipt was concurrently removed (by our mock side-effect).
		expect(fs.existsSync(receipt)).toBe(false);
		// Second receipt detached cleanly.
		expect(fs.existsSync(secondReceipt)).toBe(false);
		expect(fs.readFileSync(receiptQuarantine(secondReceiptIdentity, secondPredecessor), "utf8")).toContain(
			"second receipt",
		);
		expect(fs.existsSync(path.join(root, "toctou-legacy-recapture"))).toBe(true);
	});
});
describe.skipIf(process.platform !== "linux")("managed native security result validation", () => {
	const validApply = {
		ok: true,
		platform: "linux",
		kind: "file",
		protocol: "apply",
		aclEvidence: { access: { clear: "already_absent", query: "absent" } },
	} as const;

	it("accepts only protocol-complete Linux success evidence", () => {
		expect(validateNativeSecurityResult(validApply, "apply", "file")).toEqual(validApply);
		expect(() =>
			validateNativeSecurityResult(
				{ ...validApply, aclEvidence: { access: { clear: "not_run", query: "absent" } } },
				"apply",
				"file",
			),
		).toThrow("omitted ACL mutation evidence");
		expect(() => validateNativeSecurityResult({ ...validApply, unexpected: true }, "apply", "file")).toThrow(
			"Unexpected Linux security success fields",
		);
	});
});

describe("path-backed managed descendant binding", () => {
	it("rejects a base-directory symlink to the same inode for reads and tree capture", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-path-binding-"));
		const artifacts = path.join(root, "artifacts");
		const detached = path.join(root, "detached-artifacts");
		fs.mkdirSync(artifacts, { mode: 0o700 });
		fs.writeFileSync(path.join(artifacts, "payload.bin"), "unchanged payload", { mode: 0o600 });
		const expected = managedDirectoryRoot(artifacts);
		const store = new ManagedSessionDescendantStore(
			managedDirectoryRoot(root),
			artifacts,
			undefined,
			"default",
			root,
			expected,
			"read-only",
		);
		try {
			expect(store.readExpected("payload.bin")?.bytes).toEqual(Buffer.from("unchanged payload"));
			expect(store.captureTree("").rootIno).toBe(expected.ino.toString());

			fs.renameSync(artifacts, detached);
			fs.symlinkSync(detached, artifacts, "dir");
			const followed = fs.statSync(artifacts, { bigint: true });
			expect(followed.dev).toBe(expected.dev);
			expect(followed.ino).toBe(expected.ino);
			expect(fs.lstatSync(artifacts).isSymbolicLink()).toBe(true);

			expect(() => store.assertBound()).toThrow("root binding changed");
			expect(() => store.readExpected("payload.bin")).toThrow("root binding changed");
			expect(() => store.captureDirectoryIdentity("")).toThrow("root binding changed");
			expect(() => store.captureTree("")).toThrow("root binding changed");
			expect(fs.readFileSync(path.join(detached, "payload.bin"), "utf8")).toBe("unchanged payload");
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform !== "darwin")("path-backed managed descendant publication binding", () => {
	it("refuses publication through a base symlink and preserves its unchanged target", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-managed-path-publish-binding-"));
		const artifacts = path.join(root, "artifacts");
		const detached = path.join(root, "detached-artifacts");
		await fsp.mkdir(artifacts, { mode: 0o700 });
		await fsp.writeFile(path.join(artifacts, "payload.bin"), "unchanged payload", { mode: 0o600 });
		const expected = managedDirectoryRoot(artifacts);
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifacts);
		try {
			expect(store.readExpected("payload.bin")?.bytes).toEqual(Buffer.from("unchanged payload"));
			await store.publishNoReplace("control.bin", Buffer.from("authorized control"));
			expect(store.captureTree("").rootIno).toBe(expected.ino.toString());

			await fsp.rename(artifacts, detached);
			await fsp.symlink(detached, artifacts, "dir");
			const followed = await fsp.stat(artifacts, { bigint: true });
			expect(followed.dev).toBe(expected.dev);
			expect(followed.ino).toBe(expected.ino);
			expect(() => store.assertBound()).toThrow("root binding changed");
			expect(() => store.readExpected("payload.bin")).toThrow("root binding changed");
			expect(() => store.captureTree("")).toThrow("root binding changed");
			await expect(store.publishNoReplace("must-not-publish.bin", Buffer.from("unauthorized"))).rejects.toThrow(
				"root binding changed",
			);
			expect(await fsp.readdir(detached)).toEqual(expect.arrayContaining(["control.bin", "payload.bin"]));
			expect(await fsp.readdir(detached)).toHaveLength(2);
			expect(await fsp.readFile(path.join(detached, "control.bin"), "utf8")).toBe("authorized control");
			expect(await fsp.readFile(path.join(detached, "payload.bin"), "utf8")).toBe("unchanged payload");
		} finally {
			store.close();
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform !== "linux")("managed descendant retained binding", () => {
	it("owns only a newly derived authority and closes it once", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-derived-owner-"));
		const rootIdentity = managedDirectoryRoot(root);
		const parent = new ManagedSessionDescendantStore(rootIdentity, root);
		const borrowedAuthority = parent.retainAuthority();
		if (!borrowedAuthority) throw new Error("Expected a retained native authority");
		const borrowedStore = new ManagedSessionDescendantStore(rootIdentity, root, {
			authority: borrowedAuthority,
			authorityBaseDir: root,
		});
		const realRetain = native.RecoveryFsRoot.prototype.retainManagedDirectory;
		const realClose = native.RecoveryFsRoot.prototype.close;
		const retainedChildren: native.RecoveryFsRoot[] = [];
		const closedAuthorities: native.RecoveryFsRoot[] = [];
		const retainSpy = vi
			.spyOn(native.RecoveryFsRoot.prototype, "retainManagedDirectory")
			.mockImplementation(function (this: native.RecoveryFsRoot, relativePath, expectedDev, expectedIno) {
				const retained = realRetain.call(this, relativePath, expectedDev, expectedIno);
				retainedChildren.push(retained);
				return retained;
			});
		const closeSpy = vi.spyOn(native.RecoveryFsRoot.prototype, "close").mockImplementation(function (
			this: native.RecoveryFsRoot,
		) {
			closedAuthorities.push(this);
			return realClose.call(this);
		});
		let derived: ManagedSessionDescendantStore | undefined;
		try {
			borrowedStore.close();
			expect(borrowedAuthority.identity()).toMatchObject({ ok: true });

			derived = parent.deriveSubtree("derived");
			expect(retainedChildren).toHaveLength(1);
			const childAuthority = retainedChildren[0];
			if (!childAuthority) throw new Error("Expected the real retained child authority");
			derived.close();
			derived.close();
			expect(closedAuthorities.filter(authority => authority === childAuthority)).toHaveLength(1);
			expect(childAuthority.identity()).toMatchObject({ ok: false, code: "closed" });
			expect(borrowedAuthority.identity()).toMatchObject({ ok: true });

			parent.assertBound();
			parent.publishNoReplaceSync("parent-after-child-close.bin", Buffer.from("parent remains open"));
			expect(borrowedAuthority.readManaged("parent-after-child-close.bin")).toMatchObject({ ok: true });
		} finally {
			closeSpy.mockRestore();
			retainSpy.mockRestore();
			derived?.close();
			borrowedStore.close();
			borrowedAuthority.close();
			parent.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("closes a newly retained child when constructor binding fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-derived-constructor-failure-"));
		const rootIdentity = managedDirectoryRoot(root);
		const parent = new ManagedSessionDescendantStore(rootIdentity, root);
		const childPath = path.join(root, "derived");
		const displacedPath = path.join(root, "displaced-derived");
		const realRetain = native.RecoveryFsRoot.prototype.retainManagedDirectory;
		const realClose = native.RecoveryFsRoot.prototype.close;
		let retainedChild: native.RecoveryFsRoot | undefined;
		const closeCalls: native.RecoveryFsRoot[] = [];
		const retainSpy = vi
			.spyOn(native.RecoveryFsRoot.prototype, "retainManagedDirectory")
			.mockImplementation(function (this: native.RecoveryFsRoot, relativePath, expectedDev, expectedIno) {
				const retained = realRetain.call(this, relativePath, expectedDev, expectedIno);
				if (relativePath === "derived") {
					retainedChild = retained;
					fs.renameSync(childPath, displacedPath);
					fs.symlinkSync(displacedPath, childPath, "dir");
				}
				return retained;
			});
		const closeSpy = vi.spyOn(native.RecoveryFsRoot.prototype, "close").mockImplementation(function (
			this: native.RecoveryFsRoot,
		) {
			closeCalls.push(this);
			return realClose.call(this);
		});
		try {
			expect(() => parent.deriveSubtree("derived")).toThrow("Managed path contains symlink");
			if (!retainedChild) throw new Error("Expected the real retained child authority");
			expect(closeCalls.filter(authority => authority === retainedChild)).toHaveLength(1);
			expect(retainedChild.identity()).toMatchObject({ ok: false, code: "closed" });
			parent.assertBound();
			parent.publishNoReplaceSync("parent-after-constructor-failure.bin", Buffer.from("parent remains open"));
			expect(fs.readFileSync(path.join(root, "parent-after-constructor-failure.bin"), "utf8")).toBe(
				"parent remains open",
			);
		} finally {
			closeSpy.mockRestore();
			retainSpy.mockRestore();
			if (fs.lstatSync(childPath).isSymbolicLink()) {
				fs.unlinkSync(childPath);
				fs.renameSync(displacedPath, childPath);
			}
			parent.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects publication after the retained subtree pathname is replaced", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-managed-store-binding-"));
		try {
			const artifacts = path.join(root, "artifacts");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifacts);
			const detached = path.join(root, "detached");
			await fsp.rename(artifacts, detached);
			await fsp.mkdir(artifacts, { mode: 0o700 });
			await expect(store.publishNoReplace("result.md", Buffer.from("untrusted", "utf8"))).rejects.toThrow(
				"root binding changed",
			);
			expect(await fsp.readdir(artifacts)).toEqual([]);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a retained managed transcript leaf is replaced during a sync rewrite", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-transcript-leaf-"));
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			store.publishNoReplaceSync("session.jsonl", Buffer.from("authorized\n"));
			const transcript = path.join(sessionDir, "session.jsonl");
			const detached = path.join(sessionDir, "detached.jsonl");
			const realReplace = native.RecoveryFsRoot.prototype.replaceManaged;

			const replace = vi.spyOn(native.RecoveryFsRoot.prototype, "replaceManaged").mockImplementation(function (
				this: native.RecoveryFsRoot,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			) {
				fs.renameSync(transcript, detached);
				fs.writeFileSync(transcript, "attacker\n", { mode: 0o600 });
				return realReplace.call(
					this,
					relativePath,
					bytes,
					expectedDev,
					expectedIno,
					expectedSize,
					expectedMtimeNs,
					expectedCtimeNs,
					expectedSha256,
				);
			});
			try {
				expect(() => store.replaceSync("session.jsonl", Buffer.from("replacement\n"))).toThrow();
				expect(fs.readFileSync(transcript, "utf8")).toBe("attacker\n");
				expect(fs.readFileSync(detached, "utf8")).toBe("authorized\n");
			} finally {
				replace.mockRestore();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not publish an initial transcript into a substituted session directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-transcript-root-"));
		try {
			const sessionDir = path.join(root, "session");
			const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), sessionDir);
			const retained = path.join(root, "retained-session");
			const realCreate = native.RecoveryFsRoot.prototype.createManaged;

			const create = vi.spyOn(native.RecoveryFsRoot.prototype, "createManaged").mockImplementation(function (
				this: native.RecoveryFsRoot,
				relativePath,
				bytes,
			) {
				fs.renameSync(sessionDir, retained);
				fs.mkdirSync(sessionDir, { mode: 0o700 });
				return realCreate.call(this, relativePath, bytes);
			});
			try {
				expect(() => store.publishNoReplaceSync("session.jsonl", Buffer.from("authorized\n"))).toThrow(
					"root binding changed",
				);
				expect(fs.readdirSync(sessionDir)).toEqual([]);
				expect(fs.readFileSync(path.join(retained, "session.jsonl"), "utf8")).toBe("authorized\n");
			} finally {
				create.mockRestore();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("root retained-authority store does not snapshot mutable descendants (#3906)", () => {
		// On Linux, retained-authority store construction must use identity() for the
		// root case (authorityBaseDir === baseDir) rather than snapshotManagedTree(""),
		// which walks every mutable descendant and returns identity_mismatch under
		// concurrent writers. #assertBound() already uses identity() for this case;
		// the constructor must mirror it. Nested descendants still snapshot.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-root-snapshot-3906-"));
		try {
			const rootAuthority = managedDirectoryRoot(root);
			// Publish a file so the tree is non-empty (a mutable descendant exists).
			const warmup = new ManagedSessionDescendantStore(rootAuthority, root);
			warmup.publishNoReplaceSync("session.jsonl", Buffer.from('{"id":"warm"}\n'));
			warmup.close();

			const retainedAuthority = retainManagedDirectoryAuthority(rootAuthority, root);
			if (!retainedAuthority) {
				// Non-Linux: no retained native root authority. Verify construction still
				// succeeds without a retained authority and skip the snapshot assertion.
				const fallback = new ManagedSessionDescendantStore(rootAuthority, root);
				fallback.close();
				return;
			}

			// Spy on snapshotManagedTree: it must NOT be called for root construction.
			const snapshotSpy = vi.spyOn(native.RecoveryFsRoot.prototype, "snapshotManagedTree");

			const store = new ManagedSessionDescendantStore(rootAuthority, root, {
				authority: retainedAuthority,
				authorityBaseDir: root,
			});

			// Root construction must not have snapshotted the tree at all.
			expect(snapshotSpy).not.toHaveBeenCalled();
			store.close();

			snapshotSpy.mockRestore();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("root retained-authority store survives concurrent descendant writes (#3906)", () => {
		// Simulate a concurrent writer appending to a descendant file while the
		// root store is constructed. Before the fix, snapshotManagedTree("") would
		// observe the mutable descendant mid-write and return identity_mismatch.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-concurrent-3906-"));
		try {
			const rootAuthority = managedDirectoryRoot(root);
			// Warm up: create a descendant file that will be concurrently written.
			const warmup = new ManagedSessionDescendantStore(rootAuthority, root);
			warmup.publishNoReplaceSync("session.jsonl", Buffer.from('{"id":"base"}\n'));
			warmup.close();

			const retainedAuthority = retainManagedDirectoryAuthority(rootAuthority, root);
			if (!retainedAuthority) return; // Non-Linux: no retained authority path.

			// Concurrently append to the descendant while constructing the root store.
			// This would make snapshotManagedTree("") see a changing tree. The fix
			// uses identity() which only reads the stable root inode/dev.
			const append = Buffer.from('{"id":"concurrent"}\n');
			const writer = new ManagedSessionDescendantStore(rootAuthority, root);
			const interval = setInterval(() => {
				try {
					writer.replaceSync("session.jsonl", Buffer.concat([Buffer.from('{"id":"base"}\n'), append]));
				} catch {
					// ignore transient races; the point is to create concurrent mutation
				}
			}, 1);

			let constructions = 0;
			let failures = 0;
			try {
				for (let i = 0; i < 20; i++) {
					try {
						const store = new ManagedSessionDescendantStore(rootAuthority, root, {
							authority: retainManagedDirectoryAuthority(rootAuthority, root)!,
							authorityBaseDir: root,
						});
						store.assertBound();
						store.close();
						constructions++;
					} catch {
						failures++;
					}
				}
			} finally {
				clearInterval(interval);
				writer.close();
			}

			// Every root construction must succeed despite concurrent descendant writes.
			expect(failures).toBe(0);
			expect(constructions).toBe(20);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("FileSessionStorageWriter path security", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-writer-security-"));
		storage = new FileSessionStorage();
	});

	const managedOptions = (extra: Omit<SessionStorageWriterOpenOptions, "securityContext">) => {
		const rootAuthority = managedDirectoryRoot(path.dirname(tempDir));
		return {
			...extra,
			securityContext: createManagedSessionSecurityContext({
				agentDir: path.dirname(tempDir),
				sessionsRoot: tempDir,
				sessionDir: tempDir,
				rootAuthority,
				retainedAuthority: retainManagedDirectoryAuthority(rootAuthority, tempDir),
			}),
		};
	};

	afterEach(async () => {
		vi.restoreAllMocks();
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

	it("does not truncate through an fd after same-fd security rejects a replacement", () => {
		const sessionPath = path.join(tempDir, "replacement.jsonl");
		const protectedPath = `${sessionPath}.secure-b`;
		fs.writeFileSync(sessionPath, "protected\n");
		const apply = vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockImplementation(pathname => {
			fs.renameSync(pathname, protectedPath);
			fs.writeFileSync(pathname, "attacker replacement\n");
			return { ok: false, code: "identity_unavailable" };
		});

		expect(() => storage.openWriter(sessionPath, managedOptions({ flags: "w" }))).toThrow("identity_unavailable");

		expect(fs.readFileSync(protectedPath, "utf8")).toBe("protected\n");
		expect(fs.readFileSync(sessionPath, "utf8")).toBe("attacker replacement\n");
		apply.mockRestore();
	});

	it("fails fsync when the live transcript name is replaced after writing", async () => {
		const sessionPath = path.join(tempDir, "fsync-replacement.jsonl");
		const detachedPath = `${sessionPath}.detached`;
		const writer = storage.openWriter(sessionPath, managedOptions({ flags: "w" }));
		await writer.writeLine("authorized\n");
		await fsp.rename(sessionPath, detachedPath);
		await fsp.writeFile(sessionPath, "replacement\n", { mode: 0o600 });

		await expect(writer.fsync()).rejects.toThrow();
		expect(await fsp.readFile(sessionPath, "utf8")).toBe("replacement\n");
		await writer.close().catch(() => {});
	});

	it("rejects a replaced name before close and permits retry after restoring the original", async () => {
		const sessionPath = path.join(tempDir, "close-replacement.jsonl");
		const detachedPath = `${sessionPath}.detached`;
		const close = vi.fn((fd: number) => fs.closeSync(fd));
		const writer = storage.openWriter(sessionPath, managedOptions({ flags: "w", closeAdapter: { close } }));
		writer.writeLineSync("authorized\n");
		await fsp.rename(sessionPath, detachedPath);
		try {
			await Bun.write(sessionPath, "replacement\n");
			await fsp.chmod(sessionPath, 0o600);
			expect(() => writer.closeSync()).toThrow();
			expect(writer.getCloseState()).toBe("close_failed_retryable");
			expect(close).not.toHaveBeenCalled();
			expect(await Bun.file(detachedPath).text()).toBe("authorized\n");
			expect(await Bun.file(sessionPath).text()).toBe("replacement\n");
		} finally {
			await fsp.rename(detachedPath, sessionPath);
			writer.closeSync();
		}
		expect(writer.getCloseState()).toBe("closed");
		expect(close).toHaveBeenCalledTimes(1);
		expect(await Bun.file(sessionPath).text()).toBe("authorized\n");
	});

	it("uses caller-fd security rather than pathname security for open writers", async () => {
		const sessionPath = path.join(tempDir, "fd-security.jsonl");
		const apply = vi.spyOn(native, "applyOwnerOnlyFdSecurity");
		const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity");
		const pathApply = vi.spyOn(native, "applyOwnerOnlyPathSecurity");
		const pathVerify = vi.spyOn(native, "verifyOwnerOnlyPathSecurity");

		const writer = storage.openWriter(sessionPath, managedOptions({ flags: "w" }));
		writer.writeLineSync("payload\n");
		await writer.close();

		expect(apply).toHaveBeenCalledWith(sessionPath, "file", expect.any(Number));
		expect(verify).toHaveBeenCalledWith(sessionPath, "file", expect.any(Number));
		expect(pathApply).not.toHaveBeenCalled();
		expect(pathVerify).not.toHaveBeenCalled();
	});

	it("rejects terminal pathname or descriptor verification before dispatching close", () => {
		const close = vi.fn();
		const verify = vi
			.spyOn(native, "verifyOwnerOnlyFdSecurity")
			.mockReturnValue({ ok: false, code: "identity_unavailable" });

		const writer = storage.openWriter(
			path.join(tempDir, "verify-reject.jsonl"),
			managedOptions({ closeAdapter: { close } }),
		);
		writer.writeLineSync("payload\n");

		expect(() => writer.closeSync()).toThrow("identity_unavailable");
		expect(writer.getCloseState()).toBe("close_failed_retryable");
		expect(close).not.toHaveBeenCalled();

		verify.mockRestore();
		writer.closeSync();
		expect(writer.getCloseState()).toBe("closed");
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
			nlink: snapshot.stat.nlink,
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

		const plannedArtifactsPath = path.join(tempDir, ".gjc-delete-happy-artifacts");

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
			plannedArtifactsPath,

			plannedTranscriptPath: path.join(tempDir, ".gjc-delete-happy-transcript"),
		};
		const artifacts = await storage.deleteSessionVerified(target);
		if (artifacts.kind !== "cleanup_pending" || artifacts.phase !== "artifacts")
			throw new Error("Expected retained artifact cleanup");
		expect(artifacts.detachedArtifactsPath).toBe(`${plannedArtifactsPath}.removing`);

		expect(artifacts.retainedPlaceholderPath).toBeUndefined();
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(fs.existsSync(`${plannedArtifactsPath}.removing`)).toBe(true);
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it("revalidates a retained scrubbed root immediately before transcript unlink", async () => {
		const transcriptPath = await createTranscript("retained-boundary");
		const retainedRoot = path.join(tempDir, ".gjc-delete-retained-boundary-artifacts.removing");
		await fsp.mkdir(retainedRoot);
		await Bun.write(path.join(retainedRoot, "artifact.txt"), "");
		const retainedStat = fs.lstatSync(retainedRoot, { bigint: true });
		const retainedTree = native.snapshotDirectoryTree(retainedRoot);
		if (!retainedTree.ok || !retainedTree.snapshot) throw new Error("Missing retained tree snapshot");
		await Bun.write(path.join(retainedRoot, "successor.txt"), "successor payload");

		const error = await storage
			.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: verifiedIdentity(transcriptPath),
				artifactsRemoved: true,
				expectedArtifactsIdentity: {
					dev: retainedStat.dev,
					ino: retainedStat.ino,
					size: Number(retainedStat.size),
					mtimeNs: retainedStat.mtimeNs,
					sha256: "",
				},
				expectedArtifactsTree: retainedTree.snapshot,
				detachedArtifactsPath: retainedRoot,
				plannedArtifactsPath: path.join(tempDir, ".gjc-delete-retained-boundary-artifacts"),
				plannedTranscriptPath: path.join(tempDir, ".gjc-delete-retained-boundary-transcript"),
			})
			.catch(value => value);

		expect(error).toBeInstanceOf(SessionDeleteVerificationError);
		expect((error as SessionDeleteVerificationError).kind).toBe("artifacts");
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(await Bun.file(path.join(retainedRoot, "successor.txt")).text()).toBe("successor payload");
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

			expect(error).toMatchObject({ kind: "cleanup_pending", phase: "artifacts" });
			expect((error as { error?: SessionDeleteVerificationError }).error?.kind).toBe("artifacts");
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
		const remove = vi.spyOn(native, "exactRemoveDirectoryTree");

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
			expect(remove).toHaveBeenCalledTimes(1);
			expect(result.detachedArtifactsPath).toBe(`${plannedArtifactsPath}.removing`);
			expect(await fsp.stat(artifactsDir).catch(() => undefined)).toBeUndefined();
			expect(await fsp.stat(`${plannedArtifactsPath}.removing`)).toBeDefined();
		} finally {
			remove.mockRestore();
		}
	});
	it("retains partial tree cleanup at its planned authority", async () => {
		const transcriptPath = await createTranscript("tree-removing-retry");
		const artifactsDir = transcriptPath.slice(0, -6);
		const plannedArtifactsPath = path.join(tempDir, ".gjc-delete-tree-root-q1");
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");
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
			throw new Error("Expected retained tree cleanup");
		expect(pending.detachedArtifactsPath).toBe(`${plannedArtifactsPath}.removing`);
		expect(await fsp.stat(`${plannedArtifactsPath}.removing`)).toBeDefined();
		expect(fs.existsSync(transcriptPath)).toBe(true);
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
					nlink: snapshot.stat.nlink,
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

		const partial = await storage.deleteSessionVerified(target);
		// No false success: this is a typed partial cleanup, never "deleted".
		expect(partial.kind).toBe("cleanup_pending");
		if (partial.kind !== "cleanup_pending") throw new Error("unreachable");
		expect(partial.phase).toBe("artifacts");
		expect(partial.error).toBeInstanceOf(Error);
		expect(partial.error.message).toBe("Exact detached artifact removal rejected: cleanup_pending");

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
		expect(artifactCleanup.retainedPlaceholderPath).toBeUndefined();
	});

	it("exactly removes a retained artifact root before reconciling an absent transcript", async () => {
		const transcriptPath = await createTranscript("retained-root-transcript-absent");
		const transcriptIdentity = verifiedIdentity(transcriptPath);
		const retainedRoot = path.join(tempDir, ".gjc-delete-retained-root-q1");
		await fsp.mkdir(retainedRoot);
		const retainedStat = fs.lstatSync(retainedRoot, { bigint: true });
		const retainedTree = native.snapshotDirectoryTree(retainedRoot);
		if (!retainedTree.ok || !retainedTree.snapshot) throw new Error("Expected retained root snapshot");
		await fsp.unlink(transcriptPath);
		const removal = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementationOnce(pathname => {
			fs.rmdirSync(pathname);
			return { ok: true };
		});
		const completed = await storage.deleteSessionVerified({
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity,
			plannedArtifactsPath: path.join(tempDir, ".gjc-delete-retained-root-q2"),
			plannedTranscriptPath: path.join(tempDir, ".gjc-delete-retained-transcript-q2"),
			expectedArtifactsIdentity: {
				dev: retainedStat.dev,
				ino: retainedStat.ino,
				nlink: retainedStat.nlink,
				size: Number(retainedStat.size),
				mtimeNs: retainedStat.mtimeNs,
				sha256: "",
			},
			expectedArtifactsTree: retainedTree.snapshot,
			detachedArtifactsPath: retainedRoot,
		});
		removal.mockRestore();
		expect(completed).toMatchObject({ kind: "artifacts_removed", phase: "artifacts" });
		expect(fs.existsSync(retainedRoot)).toBe(false);
	});

	it("rejects late files instead of expanding retained artifact tree authority", async () => {
		const transcriptPath = await createTranscript("retained-root-late-file");
		const retainedRoot = path.join(tempDir, ".gjc-delete-retained-late-q1");
		await fsp.mkdir(retainedRoot);
		await Bun.write(path.join(retainedRoot, "authorized.txt"), "authorized");
		const retainedStat = fs.lstatSync(retainedRoot, { bigint: true });
		const expectedTree = native.snapshotDirectoryTree(retainedRoot);
		if (!expectedTree.ok || !expectedTree.snapshot) throw new Error("Expected retained root snapshot");
		await Bun.write(path.join(retainedRoot, "late.txt"), "late");
		const removal = vi.spyOn(native, "exactRemoveDirectoryTree").mockReturnValueOnce({
			ok: false,
			code: "io_error",
		});
		const error = await storage
			.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: verifiedIdentity(transcriptPath),
				plannedArtifactsPath: path.join(tempDir, ".gjc-delete-retained-late-q2"),
				plannedTranscriptPath: path.join(tempDir, ".gjc-delete-retained-late-transcript-q2"),
				expectedArtifactsIdentity: {
					dev: retainedStat.dev,
					ino: retainedStat.ino,
					nlink: retainedStat.nlink,
					size: Number(retainedStat.size),
					mtimeNs: retainedStat.mtimeNs,
					sha256: "",
				},
				expectedArtifactsTree: expectedTree.snapshot,
				detachedArtifactsPath: retainedRoot,
			})
			.catch(value => value);
		removal.mockRestore();
		expect(error).toBeInstanceOf(SessionDeleteVerificationError);
		expect((error as SessionDeleteVerificationError).message).toBe(
			"Partial artifact cleanup expanded retained tree authority",
		);
		expect(await fsp.readFile(path.join(retainedRoot, "late.txt"), "utf8")).toBe("late");
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"rejects an artifact hardlink created after the authorized tree snapshot",
		async () => {
			const transcriptPath = await createTranscript("retained-root-hardlink");
			const retainedRoot = path.join(tempDir, ".gjc-delete-retained-hardlink-q1");
			const authorizedFile = path.join(retainedRoot, "authorized.txt");
			const externalHardlink = path.join(tempDir, "retained-artifact-hardlink.txt");
			await fsp.mkdir(retainedRoot);
			await Bun.write(authorizedFile, "authorized");
			const retainedStat = fs.lstatSync(retainedRoot, { bigint: true });
			const expectedTree = native.snapshotDirectoryTree(retainedRoot);
			if (!expectedTree.ok || !expectedTree.snapshot) throw new Error("Expected retained root snapshot");
			await fsp.link(authorizedFile, externalHardlink);
			const error = await storage
				.deleteSessionVerified({
					sessionsRoot: tempDir,
					transcriptPath,
					sessionId: "session-id",
					cwd: tempDir,
					transcriptIdentity: verifiedIdentity(transcriptPath),
					plannedArtifactsPath: path.join(tempDir, ".gjc-delete-retained-hardlink-q2"),
					plannedTranscriptPath: path.join(tempDir, ".gjc-delete-retained-hardlink-transcript-q2"),
					expectedArtifactsIdentity: {
						dev: retainedStat.dev,
						ino: retainedStat.ino,
						nlink: retainedStat.nlink,
						size: Number(retainedStat.size),
						mtimeNs: retainedStat.mtimeNs,
						sha256: "",
					},
					expectedArtifactsTree: expectedTree.snapshot,
					detachedArtifactsPath: retainedRoot,
				})
				.catch(value => value);
			expect(error).toBeInstanceOf(SessionDeleteVerificationError);
			expect(await fsp.readFile(authorizedFile, "utf8")).toBe("authorized");
			expect(await fsp.readFile(externalHardlink, "utf8")).toBe("authorized");
			expect(fs.existsSync(transcriptPath)).toBe(true);
		},
	);

	it("rejects an artifact directory that appears after absence authorization", async () => {
		const transcriptPath = await createTranscript("late-artifact-directory");
		const artifactsPath = transcriptPath.slice(0, -6);
		const identity = verifiedIdentity(transcriptPath);
		await fsp.mkdir(artifactsPath);
		await Bun.write(path.join(artifactsPath, "late.txt"), "late");
		const error = await storage
			.deleteSessionVerified({
				sessionsRoot: tempDir,
				transcriptPath,
				sessionId: "session-id",
				cwd: tempDir,
				transcriptIdentity: identity,
				artifactsAbsentAtAuthorization: true,
			})
			.catch(value => value);
		expect(error).toBeInstanceOf(SessionDeleteVerificationError);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(await fsp.readFile(path.join(artifactsPath, "late.txt"), "utf8")).toBe("late");
	});

	it.skipIf(process.platform === "win32")(
		"rejects a transcript hardlink created after exact authorization",
		async () => {
			const transcriptPath = await createTranscript("retained-transcript-hardlink");
			const identity = verifiedIdentity(transcriptPath);
			const externalDir = await fsp.mkdtemp(path.join(path.dirname(tempDir), "gjc-external-transcript-link-"));
			const externalHardlink = path.join(externalDir, "retained.jsonl");
			try {
				await fsp.link(transcriptPath, externalHardlink);
				const error = await storage
					.deleteSessionVerified({
						sessionsRoot: tempDir,
						transcriptPath,
						sessionId: "session-id",
						cwd: tempDir,
						transcriptIdentity: identity,
					})
					.catch(value => value);
				expect(error).toBeInstanceOf(SessionDeleteVerificationError);
				expect(fs.existsSync(transcriptPath)).toBe(true);
				expect(await fsp.readFile(externalHardlink, "utf8")).toContain('"id":"session-id"');
			} finally {
				await fsp.rm(externalDir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")("rejects a transcript already hardlinked at authorization", async () => {
		const transcriptPath = await createTranscript("preauthorized-transcript-hardlink");
		const externalDir = await fsp.mkdtemp(path.join(path.dirname(tempDir), "gjc-preauthorized-transcript-link-"));
		const externalHardlink = path.join(externalDir, "retained.jsonl");
		try {
			await fsp.link(transcriptPath, externalHardlink);
			const error = await storage
				.deleteSessionVerified({
					sessionsRoot: tempDir,
					transcriptPath,
					sessionId: "session-id",
					cwd: tempDir,
					transcriptIdentity: verifiedIdentity(transcriptPath),
				})
				.catch(value => value);
			expect(error).toBeInstanceOf(SessionDeleteVerificationError);
			expect(fs.existsSync(transcriptPath)).toBe(true);
			expect(await fsp.readFile(externalHardlink, "utf8")).toContain('"id":"session-id"');
		} finally {
			await fsp.rm(externalDir, { recursive: true, force: true });
		}
	});

	it("transcript unlink failure after artifact removal returns typed cleanup_pending(transcript) and keeps the transcript", async () => {
		const transcriptPath = await createTranscript("unlink-failure");
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

		const artifactsPending = await storage.deleteSessionVerified(target);
		if (artifactsPending.kind !== "cleanup_pending" || artifactsPending.phase !== "artifacts")
			throw new Error("Expected retained artifact cleanup");
		expect(artifactsPending.detachedArtifactsPath).toEqual(expect.any(String));
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
						nlink: authorized.nlink,
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
				nlink: realSnapshot.stat.nlink,
				size: realSnapshot.stat.size,
				mtimeNs: realSnapshot.stat.mtimeNs,
				sha256: createHash("sha256").update(realSnapshot.bytes).digest("hex"),
			},
		};

		const artifactsPending = await storage.deleteSessionVerified(target);
		if (artifactsPending.kind !== "cleanup_pending" || artifactsPending.phase !== "artifacts")
			throw new Error("Expected retained artifact cleanup");
		expect(artifactsPending.detachedArtifactsPath).toEqual(expect.any(String));
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

		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: authorizedIdentity,
		};
		const artifactsPending = await storage.deleteSessionVerified(target);
		if (artifactsPending.kind !== "cleanup_pending" || artifactsPending.phase !== "artifacts")
			throw new Error("Expected retained artifact cleanup");
		expect(artifactsPending.detachedArtifactsPath).toEqual(expect.any(String));
		expect(await fsp.readFile(transcriptPath, "utf8")).not.toContain('"raced"');
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
	// Regression for #4273: a POSIX exchange-placeholder transcript scrub that reports
	// payloadDurable:true with a detachedPath and a retained exchange placeholder must
	// terminalize as deleted. The native protocol always retains a zero-length scrubbed
	// placeholder; payloadDurable proves the payload bytes were destroyed before the
	// placeholder was retained, so the placeholder alone never keeps transcript bytes.
	it("terminalizes a scrubbed transcript with a durable retained exchange placeholder", async () => {
		const transcriptPath = await createTranscript("scrubbed-placeholder-terminal");
		const plannedTranscriptPath = path.join(tempDir, ".gjc-delete-scrubbed-placeholder-transcript");
		const placeholderPath = path.join(tempDir, ".gjc-exact-unlink-placeholder-scrubbed");
		const expectedIdentity = verifiedIdentity(transcriptPath);
		const exactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (identity.directory) return exactUnlink(pathname, identity);
			fs.renameSync(pathname, plannedTranscriptPath);
			fs.writeFileSync(plannedTranscriptPath, "");
			fs.writeFileSync(placeholderPath, "", { mode: 0o600 });
			return {
				ok: false,
				code: "cleanup_pending",
				payloadDurable: true,
				detachedPath: plannedTranscriptPath,
				retainedPlaceholderPath: placeholderPath,
			};
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
		expect(result).toEqual({ kind: "deleted" });
		expect(fs.existsSync(transcriptPath)).toBe(false);
		expect(await fsp.readFile(plannedTranscriptPath, "utf8")).toBe("");
	});

	// Regression for #4273: a transcript-phase cleanup_pending with a retained successor
	// (a genuine canonical replacement that survived cleanup) must stay cleanup_pending.
	it("keeps cleanup_pending for a transcript with a retained successor path", async () => {
		const transcriptPath = await createTranscript("retained-successor-pending");
		const plannedTranscriptPath = path.join(tempDir, ".gjc-delete-retained-successor-transcript");
		const successorPath = path.join(tempDir, ".gjc-retained-successor");
		const expectedIdentity = verifiedIdentity(transcriptPath);
		const exactUnlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (identity.directory) return exactUnlink(pathname, identity);
			return {
				ok: false,
				code: "cleanup_pending",
				payloadDurable: true,
				detachedPath: plannedTranscriptPath,
				retainedSuccessorPath: successorPath,
			};
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
		expect(result.kind).toBe("cleanup_pending");
		if (result.kind !== "cleanup_pending" || result.phase !== "transcript") throw new Error("unreachable");
		expect(result.retainedSuccessorPath).toBe(successorPath);
		expect(fs.existsSync(transcriptPath)).toBe(true);
	});
});

describe("MemorySessionStorage.deleteSessionVerified parity", () => {
	let storage: MemorySessionStorage;
	const sessionsRoot = "/sessions";
	const ownerTargetFields = [
		"taskArtifactOwnerStorageContext",
		"taskArtifactOwnerDeletionEvidence",
		"taskArtifactOwnerRetirementOutcome",
		"taskArtifactOwnerTranscriptDeleted",
		"deferTaskArtifactOwnerRetirement",
		"taskArtifactOwnerRetired",
		"taskArtifactOwnerRetirementContinuation",
		"taskArtifactOwnerPayloadRetired",
		"taskArtifactOwnerNamespaceRetained",
	] as const satisfies readonly (keyof VerifiedSessionDeleteTarget)[];

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
			nlink: snapshot.stat.nlink,
			size: snapshot.stat.size,
			mtimeNs: snapshot.stat.mtimeNs,
			sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
		};
	}

	it("deletes a verified matching transcript", async () => {
		const transcriptPath = path.join(sessionsRoot, "s.jsonl");
		seedTranscript(transcriptPath);
		storage.writeTextSync(`${transcriptPath}.spill.idx`, "index\n");
		const result = await storage.deleteSessionVerified({
			sessionsRoot,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/cwd",
			transcriptIdentity: verifiedIdentity(transcriptPath),
		});
		expect(result).toEqual({ kind: "deleted" });
		expect(storage.existsSync(transcriptPath)).toBe(false);
		expect(storage.existsSync(`${transcriptPath}.spill.idx`)).toBe(false);
	});

	it("refuses a task-artifact owner in the header without mutating the transcript or spill keys", async () => {
		const transcriptPath = path.join(sessionsRoot, "owned-header.jsonl");
		const ownerLocator = {
			schemaVersion: 1,
			ownerId: "a".repeat(64),
			directoryDev: "1",
			directoryIno: "2",
		};
		seedTranscript(transcriptPath, {
			type: "session",
			id: "session-id",
			cwd: "/cwd",
			taskArtifactOwner: ownerLocator,
		});
		storage.writeTextSync(`${transcriptPath}.spill.idx`, "index\n");
		storage.writeTextSync(`${transcriptPath}.spill.commit`, "commit\n");
		const transcriptBefore = storage.readTextSync(transcriptPath);

		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
			})
			.catch(error => error);

		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		expect(storage.readTextSync(transcriptPath)).toBe(transcriptBefore);
		expect(storage.readTextSync(`${transcriptPath}.spill.idx`)).toBe("index\n");
		expect(storage.readTextSync(`${transcriptPath}.spill.commit`)).toBe("commit\n");
	});

	it("refuses a replayed task-artifact owner header patch without mutating transcript or spill keys", async () => {
		const transcriptPath = path.join(sessionsRoot, "owned-patch.jsonl");
		const ownerLocator = {
			schemaVersion: 1,
			ownerId: "b".repeat(64),
			directoryDev: "3",
			directoryIno: "4",
		};
		storage.writeTextSync(
			transcriptPath,
			`${JSON.stringify({ type: "session", id: "session-id", cwd: "/cwd", version: 4 })}\n${JSON.stringify({
				type: "header_patch",
				patch: { taskArtifactOwner: ownerLocator },
			})}\n`,
		);
		storage.writeTextSync(`${transcriptPath}.spill.idx`, "index\n");
		storage.writeTextSync(`${transcriptPath}.spill.commit`, "commit\n");
		const transcriptBefore = storage.readTextSync(transcriptPath);

		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity: verifiedIdentity(transcriptPath),
			})
			.catch(error => error);

		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		expect(storage.readTextSync(transcriptPath)).toBe(transcriptBefore);
		expect(storage.readTextSync(`${transcriptPath}.spill.idx`)).toBe("index\n");
		expect(storage.readTextSync(`${transcriptPath}.spill.commit`)).toBe("commit\n");
	});

	it("rejects an absent-transcript retry carrying durable owner retirement proof", async () => {
		const transcriptPath = path.join(sessionsRoot, "owner-retired.jsonl");
		seedTranscript(transcriptPath);
		const transcriptIdentity = verifiedIdentity(transcriptPath);
		storage.unlinkSync(transcriptPath);
		storage.writeTextSync(`${transcriptPath}.spill.idx`, "index\n");
		storage.writeTextSync(`${transcriptPath}.spill.commit`, "commit\n");

		const err = await storage
			.deleteSessionVerified({
				sessionsRoot,
				transcriptPath,
				sessionId: "session-id",
				cwd: "/cwd",
				transcriptIdentity,
				taskArtifactOwnerRetired: true,
				taskArtifactOwnerTranscriptDeleted: true,
			})
			.catch(error => error);

		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("artifacts");
		expect(storage.existsSync(transcriptPath)).toBe(false);
		expect(storage.readTextSync(`${transcriptPath}.spill.idx`)).toBe("index\n");
		expect(storage.readTextSync(`${transcriptPath}.spill.commit`)).toBe("commit\n");
	});

	it.each([
		true,
		false,
	])("refuses every defined owner field before mutation (transcript present=%s)", async present => {
		for (const field of ownerTargetFields) {
			for (const [valueIndex, value] of [false, null, {}].entries()) {
				const transcriptPath = path.join(sessionsRoot, `${field}-${valueIndex}.jsonl`);
				seedTranscript(transcriptPath);
				const transcriptBefore = storage.readTextSync(transcriptPath);
				const target: VerifiedSessionDeleteTarget = {
					sessionsRoot,
					transcriptPath,
					sessionId: "session-id",
					cwd: "/cwd",
					transcriptIdentity: verifiedIdentity(transcriptPath),
				};
				if (!present) storage.unlinkSync(transcriptPath);
				storage.writeTextSync(`${transcriptPath}.spill.idx`, "index\n");
				storage.writeTextSync(`${transcriptPath}.spill.commit`, "commit\n");
				Object.defineProperty(target, field, { value, enumerable: true });
				const failure: unknown = await storage.deleteSessionVerified(target).catch((error: unknown) => error);
				if (!(failure instanceof SessionDeleteVerificationError)) throw new Error(`Missing refusal for ${field}`);
				expect(failure.kind).toBe("artifacts");
				expect(failure.message).toBe("task_artifact_owner_memory_backend_unsupported");
				expect(storage.existsSync(transcriptPath)).toBe(present);
				if (present) expect(storage.readTextSync(transcriptPath)).toBe(transcriptBefore);
				expect(storage.readTextSync(`${transcriptPath}.spill.idx`)).toBe("index\n");
				expect(storage.readTextSync(`${transcriptPath}.spill.commit`)).toBe("commit\n");
			}
		}
	});

	it.each([
		true,
		false,
	])("treats explicitly undefined owner fields as omitted (transcript present=%s)", async present => {
		const transcriptPath = path.join(sessionsRoot, "undefined-owner-fields.jsonl");
		seedTranscript(transcriptPath);
		const target: VerifiedSessionDeleteTarget = {
			sessionsRoot,
			transcriptPath,
			sessionId: "session-id",
			cwd: "/cwd",
			transcriptIdentity: verifiedIdentity(transcriptPath),
		};
		if (!present) storage.unlinkSync(transcriptPath);
		storage.writeTextSync(`${transcriptPath}.spill.idx`, "index\n");
		storage.writeTextSync(`${transcriptPath}.spill.commit`, "commit\n");
		for (const field of ownerTargetFields)
			Object.defineProperty(target, field, { value: undefined, enumerable: true });
		expect(await storage.deleteSessionVerified(target)).toEqual({ kind: "deleted" });
		expect(storage.existsSync(transcriptPath)).toBe(false);
		expect(storage.existsSync(`${transcriptPath}.spill.idx`)).toBe(!present);
		expect(storage.existsSync(`${transcriptPath}.spill.commit`)).toBe(!present);
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

describe.skipIf(process.platform !== "win32")("managed session security: owner_mismatch repair", () => {
	let tempRoot: string;
	let tempDir: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-owner-mismatch-"));
		tempDir = path.join(tempRoot, "sessiondir");
		fs.mkdirSync(tempDir, { mode: 0o700 });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("owner_mismatch -> repair succeeds -> directory accepted", () => {
		const stat = fs.lstatSync(tempDir, { bigint: true });
		const root = managedDirectoryRoot(tempRoot);

		const verifyMock = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockReturnValue({
			ok: false,
			code: "owner_mismatch",
		} as const);

		const repairMock = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected").mockReturnValue({ ok: true });

		expect(() => ensureManagedDirectory(tempDir, root, "windows-existing-verify-first")).not.toThrow();

		expect(verifyMock).toHaveBeenCalledWith(tempDir, "directory", stat.dev, stat.ino);
		expect(repairMock).toHaveBeenCalledWith(tempDir, "directory", stat.dev, stat.ino);
	});

	it("owner_mismatch -> repair fails with io_error -> security error with actionable message", () => {
		const root = managedDirectoryRoot(tempRoot);

		const verifyMock = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockReturnValue({
			ok: false,
			code: "owner_mismatch",
		} as const);

		const repairMock = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected").mockReturnValue({
			ok: false,
			code: "io_error",
		} as const);

		expect(() => ensureManagedDirectory(tempDir, root, "windows-existing-verify-first")).toThrow(
			/directory owner mismatch: unable to take ownership.*administrator privileges/,
		);

		expect(verifyMock).toHaveBeenCalled();
		expect(repairMock).toHaveBeenCalled();
	});

	it("other verify codes throw immediately without calling repair", () => {
		const root = managedDirectoryRoot(tempRoot);

		const verifyMock = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockReturnValue({
			ok: false,
			code: "identity_mismatch",
		} as const);

		const repairMock = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected");

		expect(() => ensureManagedDirectory(tempDir, root, "windows-existing-verify-first")).toThrow();

		expect(repairMock).not.toHaveBeenCalled();
		expect(verifyMock).toHaveBeenCalled();
	});

	it("acl_verify_failed also triggers repair attempt", () => {
		const root = managedDirectoryRoot(tempRoot);

		const verifyMock = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockReturnValue({
			ok: false,
			code: "acl_verify_failed",
		} as const);

		const repairMock = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected").mockReturnValue({ ok: true });

		expect(() => ensureManagedDirectory(tempDir, root, "windows-existing-verify-first")).not.toThrow();

		expect(verifyMock).toHaveBeenCalled();
		expect(repairMock).toHaveBeenCalled();
	});

	it("verify ok immediately returns without calling repair", () => {
		const root = managedDirectoryRoot(tempRoot);

		const verifyMock = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockReturnValue({ ok: true });

		const repairMock = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected");

		expect(() => ensureManagedDirectory(tempDir, root, "windows-existing-verify-first")).not.toThrow();

		expect(repairMock).not.toHaveBeenCalled();
		expect(verifyMock).toHaveBeenCalled();
	});

	it("default policy applies security without repair attempt", () => {
		const root = managedDirectoryRoot(tempRoot);

		vi.spyOn(native, "applyOwnerOnlyPathSecurity").mockReturnValue({ ok: true });

		vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockReturnValue({ ok: true });

		const repairMock = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected");

		expect(() => ensureManagedDirectory(tempDir, root, "default")).not.toThrow();

		expect(repairMock).not.toHaveBeenCalled();
	});
});
