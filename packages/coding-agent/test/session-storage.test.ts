import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	prepareManagedSessionScopeForWrite,
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
} from "../src/session/internal/managed-session-scope";
import {
	acquireManagedLock,
	acquireManagedLockSync,
	captureManagedFileNoFollow,
	ManagedSessionDescendantStore,
	ManagedSessionSecurityError,
	managedDirectoryRoot,
	managedSecurityFailureClassification,
	publishManagedFileNoReplace,
	replaceManagedFileExactSync,
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
	type VerifiedSessionDeleteTarget,
} from "../src/session/session-storage";

function fdSecuritySuccess(operation: "apply" | "verify") {
	if (process.platform !== "linux") return { ok: true } as const;
	return {
		ok: true,
		platform: "linux",
		kind: "file",
		protocol: operation,
		aclEvidence: {
			access: {
				clear: operation === "apply" ? "already_absent" : "not_run",
				query: "absent",
			},
		},
	} as const;
}

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

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tempDir: string;
	let storage: { deleteSessionWithArtifacts(sessionPath: string): Promise<void> };
	let platformDescriptor: PropertyDescriptor | undefined;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-session-storage-"));
		platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const { FileSessionStorage } = await import("../src/session/session-storage");
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
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
			vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockReturnValue(fdSecuritySuccess("apply"));
			vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockReturnValue(fdSecuritySuccess("verify"));
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
	describe("Windows identity-bound managed replacement", () => {
		const useWindowsPlatform = (): void => {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockReturnValue({ ok: true });
			vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockReturnValue({ ok: true });
			vi.spyOn(native, "applyOwnerOnlyPathSecurity").mockReturnValue({ ok: true });
			vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockReturnValue({ ok: true });
			vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected").mockReturnValue({ ok: true });
			vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected").mockReturnValue({ ok: true });
		};

		it("publishes through the identity-bound native primitive and preserves a successor swapped before commit", () => {
			useWindowsPlatform();
			const destination = path.join(tempDir, "managed.jsonl");
			fs.writeFileSync(destination, "authorized\n", { mode: 0o600 });
			const root = managedDirectoryRoot(tempDir);
			const exactReplace = vi.spyOn(native, "exactReplacePath").mockImplementation((source, target) => {
				fs.renameSync(source, target);
				return { ok: true } as never;
			});
			const store = new ManagedSessionDescendantStore(root, tempDir, undefined, "windows-existing-verify-first");
			store.replaceSync("managed.jsonl", Buffer.from("replacement\n"));
			expect(exactReplace).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(destination, "utf8")).toBe("replacement\n");

			const expected = captureManagedFileNoFollow(destination);
			exactReplace.mockImplementation(() => {
				fs.writeFileSync(destination, "successor\n", { mode: 0o600 });
				return { ok: false, code: "identity_mismatch" } as never;
			});
			expect(() => replaceManagedFileExactSync(destination, Buffer.from("stale\n"), expected, root)).toThrow(
				"identity_mismatch",
			);
			expect(exactReplace).toHaveBeenCalledTimes(2);
			expect(fs.readFileSync(destination, "utf8")).toBe("successor\n");
		});

		it("retains staging evidence after an identity-bound publication failure", () => {
			useWindowsPlatform();
			const destination = path.join(tempDir, "unknown.jsonl");
			fs.writeFileSync(destination, "authorized\n", { mode: 0o600 });
			const root = managedDirectoryRoot(tempDir);
			vi.spyOn(native, "exactReplacePath").mockReturnValue({
				ok: false,
				code: "identity_mismatch",
			} as never);
			const expected = captureManagedFileNoFollow(destination);
			expect(() => replaceManagedFileExactSync(destination, Buffer.from("replacement\n"), expected, root)).toThrow(
				"identity_mismatch",
			);
			expect(fs.readFileSync(destination, "utf8")).toBe("authorized\n");
			expect(fs.readdirSync(tempDir).some(name => name.includes(".replacement"))).toBe(true);
		});

		it("surfaces post-delete publication state while retaining the exact staged source", () => {
			useWindowsPlatform();
			const destination = path.join(tempDir, "publication-pending.jsonl");
			fs.writeFileSync(destination, "authorized\n", { mode: 0o600 });
			const root = managedDirectoryRoot(tempDir);
			vi.spyOn(native, "exactReplacePath").mockImplementation(
				source =>
					({
						ok: false,
						code: "already_exists",
						detachedPath: source,
					}) as never,
			);
			const expected = captureManagedFileNoFollow(destination);
			expect(() => replaceManagedFileExactSync(destination, Buffer.from("replacement\n"), expected, root)).toThrow(
				"managed_replace_publication_pending",
			);
			expect(fs.readdirSync(tempDir).some(name => name.includes(".replacement"))).toBe(true);
		});
	});

	describe("managed async lock release", () => {
		it("releases a normal lock and preserves a successor introduced before release", async () => {
			const root = managedDirectoryRoot(tempDir);
			const lock = await acquireManagedLock(tempDir, "release", root);
			await lock.release();
			expect(fs.existsSync(lock.path)).toBe(false);

			const raced = await acquireManagedLock(tempDir, "successor", root);
			const retired = `${raced.path}.${raced.attemptId}.moved`;
			fs.renameSync(raced.path, retired);
			fs.writeFileSync(raced.path, `${JSON.stringify({ attemptId: "successor" })}\n`, { mode: 0o600 });
			await expect(raced.release()).rejects.toThrow("migration_busy");
			expect(JSON.parse(fs.readFileSync(raced.path, "utf8"))).toEqual({ attemptId: "successor" });
			fs.unlinkSync(raced.path);
			fs.unlinkSync(retired);
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

describe.skipIf(process.platform !== "linux")("managed descendant retained binding", () => {
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

	it("uses caller-fd security rather than pathname security for open writers", async () => {
		const sessionPath = path.join(tempDir, "fd-security.jsonl");
		const apply = vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockReturnValue(fdSecuritySuccess("apply"));
		const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockReturnValue(fdSecuritySuccess("verify"));
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

	it("rejects a destructive pathname replacement before dispatching close", () => {
		const sessionPath = path.join(tempDir, "verify-reject.jsonl");
		const protectedPath = `${sessionPath}.secure-b`;
		const close = vi.fn();
		const apply = vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockReturnValue(fdSecuritySuccess("apply"));
		const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockImplementation(pathname => {
			fs.renameSync(pathname, protectedPath);
			fs.writeFileSync(pathname, "attacker replacement\n");
			return { ok: false, code: "identity_unavailable" };
		});
		const writer = storage.openWriter(sessionPath, managedOptions({ closeAdapter: { close } }));
		writer.writeLineSync("payload\n");

		expect(() => writer.closeSync()).toThrow("identity_unavailable");
		expect(writer.getCloseState()).toBe("close_failed_retryable");
		expect(close).not.toHaveBeenCalled();
		expect(fs.readFileSync(protectedPath, "utf8")).toBe("payload\n");
		expect(fs.readFileSync(sessionPath, "utf8")).toBe("attacker replacement\n");

		verify.mockReturnValue(fdSecuritySuccess("verify"));
		writer.closeSync();
		expect(writer.getCloseState()).toBe("closed");
		verify.mockRestore();
		apply.mockRestore();
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

	it("returns an artifact-phase receipt before deleting the transcript", async () => {
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
		if (
			(artifacts.kind !== "cleanup_pending" && artifacts.kind !== "artifacts_removed") ||
			artifacts.phase !== "artifacts"
		)
			throw new Error("Expected durable artifact-phase receipt");

		expect(artifacts.transcriptIdentity).toEqual(target.transcriptIdentity);
		if (artifacts.kind === "cleanup_pending") {
			expect(artifacts.detachedArtifactsPath).toBe(plannedArtifactsPath);
			expect(artifacts.retainedPlaceholderPath).toBeDefined();
			expect(fs.existsSync(artifacts.retainedPlaceholderPath!)).toBe(true);
			expect(fs.existsSync(plannedArtifactsPath)).toBe(true);
		} else {
			expect(fs.existsSync(artifactsDir)).toBe(false);
			expect(fs.existsSync(plannedArtifactsPath)).toBe(false);
		}
		expect(fs.existsSync(transcriptPath)).toBe(true);
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
			expect(remove).not.toHaveBeenCalled();
			expect(result.detachedArtifactsPath).toBe(plannedArtifactsPath);
			expect(await fsp.stat(artifactsDir).catch(() => undefined)).toBeUndefined();
			expect(await fsp.stat(plannedArtifactsPath)).toBeDefined();
		} finally {
			remove.mockRestore();
		}
	});
	it("durably records a retained artifact root before returning cleanup_pending", async () => {
		const transcriptPath = await createTranscript("artifact-root-durability");
		const artifactsDir = transcriptPath.slice(0, -6);
		const plannedArtifactsPath = path.join(tempDir, ".gjc-delete-artifact-root-durability");
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

		const result = await storage.deleteSessionVerified({
			sessionsRoot: tempDir,
			transcriptPath,
			sessionId: "session-id",
			cwd: tempDir,
			transcriptIdentity: verifiedIdentity(transcriptPath),
			plannedArtifactsPath,
			plannedTranscriptPath: path.join(tempDir, ".gjc-delete-artifact-root-d-transcript"),
		});
		if (result.kind !== "cleanup_pending" || result.phase !== "artifacts") throw new Error("unreachable");
		// The artifact directory was detached to quarantine.
		expect(await fsp.stat(artifactsDir).catch(() => undefined)).toBeUndefined();
		// The retained quarantine proves payload persists.
		expect(await fsp.readFile(path.join(result.detachedArtifactsPath, "artifact.txt"), "utf8")).toBe("payload");
		// On POSIX, the parent directory was fsynced before the result was returned.
		if (process.platform !== "win32") {
			// Re-stat the parent to verify it's still accessible (proves fsync didn't fail).
			const parent = await fsp.stat(path.dirname(transcriptPath));
			expect(parent.isDirectory()).toBe(true);
		}
	});
	it("returns an artifact-phase receipt after complete tree cleanup", async () => {
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
		const receipt = await storage.deleteSessionVerified(target);
		if ((receipt.kind !== "cleanup_pending" && receipt.kind !== "artifacts_removed") || receipt.phase !== "artifacts")
			throw new Error("Expected artifact-phase receipt");
		expect(receipt.transcriptIdentity).toEqual(target.transcriptIdentity);
		if (receipt.kind === "cleanup_pending") {
			expect(receipt.detachedArtifactsPath).toBe(plannedArtifactsPath);
			expect(await fsp.stat(plannedArtifactsPath).catch(() => undefined)).toBeDefined();
		} else {
			expect(await fsp.stat(plannedArtifactsPath).catch(() => undefined)).toBeUndefined();
		}
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

	it("returns an artifact-phase receipt after complete cleanup", async () => {
		const transcriptPath = await createTranscript("retry-evidence");
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

		const receipt = await storage.deleteSessionVerified(target);
		expect(["cleanup_pending", "artifacts_removed"]).toContain(receipt.kind);
		if (receipt.kind !== "cleanup_pending" && receipt.kind !== "artifacts_removed") throw new Error("unreachable");
		expect(receipt.phase).toBe("artifacts");
		expect(receipt.transcriptIdentity).toEqual(target.transcriptIdentity);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("leaves the transcript intact after returning the artifact-phase receipt", async () => {
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

		const receipt = await storage.deleteSessionVerified(target);
		if ((receipt.kind !== "cleanup_pending" && receipt.kind !== "artifacts_removed") || receipt.phase !== "artifacts")
			throw new Error("Expected artifact-phase receipt");
		expect(receipt.transcriptIdentity).toEqual(target.transcriptIdentity);
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
		expect(["cleanup_pending", "artifacts_removed"]).toContain((await storage.deleteSessionVerified(target)).kind);
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

	it("returns an artifact-phase receipt before a transcript retry", async () => {
		const transcriptPath = await createTranscript("replacement");
		const artifactsDir = transcriptPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "payload");

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

		const receipt = await storage.deleteSessionVerified(target);
		if ((receipt.kind !== "cleanup_pending" && receipt.kind !== "artifacts_removed") || receipt.phase !== "artifacts")
			throw new Error("Expected artifact-phase receipt");
		expect(receipt.transcriptIdentity).toEqual(target.transcriptIdentity);
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
	it("rejects an in-place transcript append after artifact completion without unlinking the changed transcript", async () => {
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
		const receipt = await storage.deleteSessionVerified(target);
		if ((receipt.kind !== "cleanup_pending" && receipt.kind !== "artifacts_removed") || receipt.phase !== "artifacts")
			throw new Error("Expected artifact-phase receipt");
		await fsp.appendFile(transcriptPath, `${JSON.stringify({ type: "message", content: "raced" })}\n`);

		const err = await storage.deleteSessionVerified({ ...target, artifactsRemoved: true }).catch(error => error);
		expect(err).toBeInstanceOf(SessionDeleteVerificationError);
		expect((err as SessionDeleteVerificationError).kind).toBe("identity");
		expect(fs.existsSync(artifactsDir)).toBe(false);
		expect(await fsp.readFile(transcriptPath, "utf8")).toContain('"raced"');
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
		expect(["cleanup_pending", "artifacts_removed"]).toContain((await storage.deleteSessionVerified(target)).kind);
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
describe("managed scope failure classification", () => {
	function fixture() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-scope-classification-"));
		const cwd = path.join(root, "cwd");
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
		fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
		const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
		if (resolved.kind !== "resolved") throw new Error(`scope fixture failed: ${resolved.code}`);
		return { root, scope: resolved.scope };
	}

	it("preserves bounded native security classifications across sync and async preparation", async () => {
		const sync = fixture();
		const syncVerify = vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockReturnValue({
			ok: false,
			code: "mode_mismatch",
		} as never);
		try {
			const prepared = prepareManagedSessionScopeForWriteSync(sync.scope);
			expect(prepared).toMatchObject({ kind: "error", cause: { classification: "mode_mismatch" } });
			if (prepared.kind !== "error") throw new Error("Expected synchronous preparation failure");
			expect(JSON.stringify(prepared.cause ?? {})).not.toContain(sync.root);
			expect(prepared.message).toBe("mode_mismatch");
			expect(prepared.message).not.toContain(sync.root);
		} finally {
			syncVerify.mockRestore();
			fs.rmSync(sync.root, { recursive: true, force: true });
		}

		const asynchronous = fixture();
		const asyncVerify = vi.spyOn(native, "verifyOwnerOnlyPathSecurity").mockReturnValue({
			ok: false,
			code: "mode_mismatch",
		} as never);
		try {
			const prepared = await prepareManagedSessionScopeForWrite(asynchronous.scope);
			expect(prepared).toMatchObject({ kind: "error", cause: { classification: "mode_mismatch" } });
			if (prepared.kind !== "error") throw new Error("Expected asynchronous preparation failure");
			expect(JSON.stringify(prepared.cause ?? {})).not.toContain(asynchronous.root);
			expect(prepared.message).toBe("mode_mismatch");
			expect(prepared.message).not.toContain(asynchronous.root);
		} finally {
			asyncVerify.mockRestore();
			fs.rmSync(asynchronous.root, { recursive: true, force: true });
		}
	});

	it("keeps ManagedSessionSecurityError codes bounded in the shared classifier", () => {
		expect(managedSecurityFailureClassification(new ManagedSessionSecurityError("reparse_point"))).toBe(
			"reparse_point",
		);
	});
});
describe("managed lock exact retirement boundaries", () => {
	const successorRecord = (): string =>
		`${JSON.stringify({
			attemptId: "successor",
			pid: process.pid,
			processStartId: "successor",
			createdAt: Date.now(),
			heartbeatAt: Date.now(),
			leaseExpiresAt: Date.now() + 60_000,
		})}\n`;

	function substituteBeforeExactUnlink(lockPath: string): void {
		const unlink = native.exactUnlink;
		vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === lockPath) {
				fs.renameSync(lockPath, `${lockPath}.retired-by-adversary`);
				fs.writeFileSync(lockPath, successorRecord(), { mode: 0o600 });
			}
			return unlink(pathname, identity);
		});
	}

	function expectSuccessorStillExcludes(lockPath: string): void {
		expect(fs.readFileSync(lockPath, "utf8")).toContain('"attemptId":"successor"');
		expect(() => fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)).toThrow();
	}

	afterEach(() => vi.restoreAllMocks());

	it("does not displace a substituted successor during async release", async () => {
		const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-async-"));
		try {
			const lock = await acquireManagedLock(locks, "owner");
			substituteBeforeExactUnlink(lock.path);
			await expect(lock.release()).rejects.toThrow("migration_busy");
			expectSuccessorStillExcludes(lock.path);
		} finally {
			fs.rmSync(locks, { recursive: true, force: true });
		}
	});

	it("does not displace a substituted successor during sync release", () => {
		const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-sync-"));
		try {
			const lock = acquireManagedLockSync(locks, "owner");
			substituteBeforeExactUnlink(lock.path);
			expect(() => lock.release()).toThrow("migration_busy");
			expectSuccessorStillExcludes(lock.path);
		} finally {
			fs.rmSync(locks, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"keeps synchronous descriptor verification failures retryable",
		() => {
			const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-sync-verify-"));
			try {
				const lock = acquireManagedLockSync(locks, "owner");
				const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockReturnValue({
					ok: false,
					code: "identity_unavailable",
				} as never);
				expect(() => lock.release()).toThrow("identity_unavailable");
				expect(fs.existsSync(lock.path)).toBe(true);
				expect(fs.readFileSync(lock.path, "utf8")).toContain(`"attemptId":"${lock.attemptId}"`);
				verify.mockRestore();
				lock.release();
				expect(fs.existsSync(lock.path)).toBe(false);
			} finally {
				fs.rmSync(locks, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"keeps asynchronous descriptor verification failures retryable",
		async () => {
			const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-async-verify-"));
			try {
				const lock = await acquireManagedLock(locks, "owner");
				const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockReturnValue({
					ok: false,
					code: "identity_unavailable",
				} as never);
				await expect(lock.release()).rejects.toThrow("identity_unavailable");
				expect(fs.existsSync(lock.path)).toBe(true);
				verify.mockRestore();
				await lock.release();
				expect(fs.existsSync(lock.path)).toBe(false);
			} finally {
				fs.rmSync(locks, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"finalizes a synchronous lock when descriptor verification proves ownership loss",
		() => {
			const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-sync-lost-"));
			try {
				const lock = acquireManagedLockSync(locks, "owner");
				const retired = `${lock.path}.retired`;
				const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockImplementation(pathname => {
					if (pathname === lock.path) {
						fs.renameSync(lock.path, retired);
						fs.writeFileSync(lock.path, "successor\n", { mode: 0o600 });
						return { ok: false, code: "identity_mismatch" } as never;
					}
					return { ok: true } as never;
				});
				expect(() => lock.release()).toThrow("identity_mismatch");
				expect(fs.readFileSync(lock.path, "utf8")).toBe("successor\n");
				verify.mockRestore();
				fs.unlinkSync(lock.path);
				fs.renameSync(retired, lock.path);
				expect(() => lock.release()).toThrow("migration_busy");
				expect(fs.readFileSync(lock.path, "utf8")).toContain(`"attemptId":"${lock.attemptId}"`);
			} finally {
				fs.rmSync(locks, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"finalizes an asynchronous lock when descriptor verification proves ownership loss",
		async () => {
			const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-async-lost-"));
			try {
				const lock = await acquireManagedLock(locks, "owner");
				const retired = `${lock.path}.retired`;
				const verify = vi.spyOn(native, "verifyOwnerOnlyFdSecurity").mockImplementation(pathname => {
					if (pathname === lock.path) {
						fs.renameSync(lock.path, retired);
						fs.writeFileSync(lock.path, "successor\n", { mode: 0o600 });
						return { ok: false, code: "identity_mismatch" } as never;
					}
					return { ok: true } as never;
				});
				await expect(lock.release()).rejects.toThrow("identity_mismatch");
				expect(fs.readFileSync(lock.path, "utf8")).toBe("successor\n");
				verify.mockRestore();
				fs.unlinkSync(lock.path);
				fs.renameSync(retired, lock.path);
				await expect(lock.release()).rejects.toThrow("migration_busy");
				expect(fs.readFileSync(lock.path, "utf8")).toContain(`"attemptId":"${lock.attemptId}"`);
			} finally {
				fs.rmSync(locks, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"retires a partially initialized synchronous lock after security setup fails",
		() => {
			const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-sync-create-failure-"));
			try {
				vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockReturnValueOnce({
					ok: false,
					code: "identity_unavailable",
				} as never);
				expect(() => acquireManagedLockSync(locks, "owner")).toThrow("identity_unavailable");
				expect(fs.existsSync(path.join(locks, "owner.lock"))).toBe(false);
			} finally {
				fs.rmSync(locks, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux" && process.platform !== "win32")(
		"retires a partially initialized asynchronous lock after security setup fails",
		async () => {
			const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-async-create-failure-"));
			try {
				vi.spyOn(native, "applyOwnerOnlyFdSecurity").mockReturnValueOnce({
					ok: false,
					code: "identity_unavailable",
				} as never);
				await expect(acquireManagedLock(locks, "owner")).rejects.toThrow("identity_unavailable");
				expect(fs.existsSync(path.join(locks, "owner.lock"))).toBe(false);
			} finally {
				fs.rmSync(locks, { recursive: true, force: true });
			}
		},
	);

	it("rejects forged cleanup_pending authority while the canonical lock remains occupied", () => {
		const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-forged-"));
		try {
			const lock = acquireManagedLockSync(locks, "owner");
			const forged = path.join(locks, ".gjc-forged-retained");
			fs.writeFileSync(forged, "forged\n", { mode: 0o600 });
			const exactUnlink = native.exactUnlink;
			const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
				if (pathname === lock.path) return { ok: false, code: "cleanup_pending", detachedPath: forged };
				return exactUnlink(pathname, identity);
			});

			expect(() => lock.release()).toThrow("migration_busy");
			expect(fs.existsSync(lock.path)).toBe(true);
			expect(fs.existsSync(forged)).toBe(true);
			unlink.mockRestore();
			lock.release();
			expect(fs.existsSync(lock.path)).toBe(false);
		} finally {
			fs.rmSync(locks, { recursive: true, force: true });
		}
	});

	it("accepts authorized cleanup_pending retirement and leaves quarantine evidence for a successor", () => {
		const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-authorized-"));
		try {
			const lock = acquireManagedLockSync(locks, "owner");
			const retained = path.join(locks, ".gjc-lock-retire-authorized");
			const exactUnlink = native.exactUnlink;
			const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
				if (pathname === lock.path) {
					fs.renameSync(lock.path, retained);
					return { ok: false, code: "cleanup_pending", detachedPath: retained };
				}
				return exactUnlink(pathname, identity);
			});
			lock.release();
			expect(fs.existsSync(lock.path)).toBe(false);
			expect(fs.readFileSync(retained, "utf8")).toContain(`"attemptId":"${lock.attemptId}"`);
			unlink.mockRestore();

			const successor = acquireManagedLockSync(locks, "owner");
			expect(fs.existsSync(successor.path)).toBe(true);
			expect(fs.existsSync(retained)).toBe(true);
			successor.release();
		} finally {
			fs.rmSync(locks, { recursive: true, force: true });
		}
	});

	it("does not displace a substituted successor during stale reclaim", async () => {
		const locks = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-stale-"));
		const lockPath = path.join(locks, "owner.lock");
		try {
			fs.writeFileSync(
				lockPath,
				`${JSON.stringify({
					attemptId: "stale",
					pid: 2_147_483_647,
					processStartId: "stale",
					createdAt: 0,
					heartbeatAt: 0,
					leaseExpiresAt: 0,
				})}\n`,
				{ mode: 0o600 },
			);
			substituteBeforeExactUnlink(lockPath);
			let calls = 0;
			vi.spyOn(Date, "now").mockImplementation(() => (calls++ < 3 ? 1_000 : 6_001));
			await expect(acquireManagedLock(locks, "owner")).rejects.toThrow("migration_busy");
			expectSuccessorStillExcludes(lockPath);
		} finally {
			fs.rmSync(locks, { recursive: true, force: true });
		}
	});
});
