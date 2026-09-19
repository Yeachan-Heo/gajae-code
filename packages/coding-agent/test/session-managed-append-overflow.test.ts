import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import {
	SessionManager,
	SessionNearLimitAppendError,
	SessionNearLimitRewriteError,
} from "../src/session/session-manager";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-managed-append-overflow-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Simulate the live-session scenario where the managed transcript file has
 * grown to the 64 MiB per-file limit. The next managed append throws
 * `content_too_large`, which previously permanently poisoned #persistError.
 *
 * We spy on the descendant store's append path so it throws content_too_large
 * on the next append without needing 64 MiB of real data. The SessionManager's
 * #rewriteFileSync fallback should recover by rewriting only the live
 * in-memory entries.
 */
describe("SessionManager managed append overflow recovery", () => {
	it("recovers from content_too_large via full-rewrite instead of poisoning", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			// Create a small valid session on disk first.
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			// Mock the store's appendExpectedSync to throw content_too_large,
			// simulating a transcript that has grown to the 64 MiB limit.
			const appendSpy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedSync")
				.mockImplementation(() => {
					throw new Error("content_too_large");
				});

			// This append should hit content_too_large and recover via #rewriteFileSync.
			expect(() => manager.appendMessage({ role: "user", content: "after-overflow", timestamp: 2 })).not.toThrow();

			appendSpy.mockRestore();

			// The session must NOT be poisoned — further appends must work.
			manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
			await manager.flush();

			// The file should contain all live entries after the rewrite.
			const content = fs.readFileSync(sessionFile, "utf8");
			expect(content).toContain("after-overflow");
			expect(content).toContain("third");
		} finally {
			await manager.close();
		}
	});

	it("getTranscriptFileBytes returns the on-disk transcript size", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			expect(manager.getTranscriptFileBytes()).toBe(0);
			manager.appendMessage({ role: "user", content: "hello world", timestamp: 1 });
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			const statSize = fs.statSync(sessionFile).size;
			expect(manager.getTranscriptFileBytes()).toBe(statSize);
		} finally {
			await manager.close();
		}
	});

	it("does not attempt recovery for non-content_too_large errors", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();

			const appendSpy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedSync")
				.mockImplementation(() => {
					throw new Error("some_other_error");
				});

			// A non-content_too_large error should poison the session and throw.
			let threw = false;
			try {
				manager.appendMessage({ role: "user", content: "fail", timestamp: 2 });
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);

			appendSpy.mockRestore();
		} finally {
			// Suppress the poisoned close error.
			try {
				await manager.close();
			} catch {}
		}
	});
	it("surfaces SessionNearLimitRewriteError when the atomic rewrite exceeds the cap", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");

			// Mock the managed replace path to throw content_too_large, simulating a
			// resident transcript that no longer fits the per-file cap, and capture the
			// rejected bytes so the reported size is asserted exactly: a swapped or
			// unwired field must fail this test. A full rewrite has no appended entry,
			// so it must surface the rewrite-scoped near-limit error instead of leaking
			// a raw `content_too_large` rejection or claiming an append happened.
			let rejectedBytes = -1;
			vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync").mockImplementation(
				(_relativePath: string, bytes: Uint8Array) => {
					rejectedBytes = bytes.byteLength;
					throw new Error("content_too_large");
				},
			);

			let thrown: unknown;
			try {
				await manager.rewriteEntries();
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(SessionNearLimitRewriteError);
			const rewriteError = thrown as SessionNearLimitRewriteError;
			expect(rewriteError.code).toBe("near_limit_rewrite");
			expect(rejectedBytes).toBeGreaterThan(0);
			expect(rewriteError.transcriptBytes).toBe(rejectedBytes);
			expect(rewriteError.capBytes).toBe(MANAGED_ARTIFACT_MAX_FILE_BYTES);
		} finally {
			// The near-limit failure is recorded on the persist chain; suppress the
			// resulting close error so cleanup does not mask the assertion.
			try {
				await manager.close();
			} catch {}
		}
	});

	it("keeps the append near-limit contract when the recovery rewrite also overflows", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			if (!manager.getSessionFile()) throw new Error("Expected managed session file");

			// Both lanes overflow: the append cannot fit and the recovery rewrite
			// cannot shrink below the cap. The append path must still convert the
			// rewrite-scoped near-limit error into the append contract with fields
			// derived from the appended entry, not the whole rewritten transcript.
			let appendedBytes = -1;
			vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedSync").mockImplementation(
				(_relativePath: string, bytes: Uint8Array) => {
					appendedBytes = bytes.byteLength;
					throw new Error("content_too_large");
				},
			);
			vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync").mockImplementation(() => {
				throw new Error("content_too_large");
			});

			let thrown: unknown;
			try {
				manager.appendMessage({ role: "user", content: "after-overflow", timestamp: 2 });
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(SessionNearLimitAppendError);
			const appendError = thrown as SessionNearLimitAppendError;
			expect(appendError.code).toBe("near_limit_append");
			expect(appendError.entryRetained).toBe(true);
			// `entryBytes` is the appended entry's own serialized size, so it must match
			// the bytes the store rejected, not the whole rewritten transcript.
			expect(appendedBytes).toBeGreaterThan(0);
			expect(appendError.entryBytes).toBe(appendedBytes);
			expect(appendError.entryBytes).toBeLessThan(appendError.capBytes);
			expect(appendError.capBytes).toBe(MANAGED_ARTIFACT_MAX_FILE_BYTES);
		} finally {
			try {
				await manager.close();
			} catch {}
		}
	});

	it("reports the append near-limit outcome when the ENOENT recovery rewrite also overflows", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			if (!manager.getSessionFile()) throw new Error("Expected managed session file");

			// Second chain into the same near-limit condition: the append lane reports
			// the transcript missing (ENOENT), so #appendManagedRecordsSync falls back
			// to recreating the file from the resident entries — and that rewrite
			// overflows the cap as well.
			vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedSync").mockImplementation(() => {
				const missing = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
				missing.code = "ENOENT";
				throw missing;
			});
			let rejectedRewriteBytes = -1;
			vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceSync").mockImplementation(
				(_relativePath: string, bytes: Uint8Array) => {
					rejectedRewriteBytes = bytes.byteLength;
					throw new Error("content_too_large");
				},
			);

			let thrown: unknown;
			try {
				manager.appendMessage({ role: "user", content: "after-enoent", timestamp: 2 });
			} catch (err) {
				thrown = err;
			}
			// Unconverted, this chain surfaces as a generic SessionAppendPersistenceError
			// and the entry is rolled back out of the resident list, losing the receipt
			// for an effect that already committed.
			expect(thrown).toBeInstanceOf(SessionNearLimitAppendError);
			const appendError = thrown as SessionNearLimitAppendError;
			expect(appendError.code).toBe("near_limit_append");
			expect(appendError.entryRetained).toBe(true);
			expect(appendError.capBytes).toBe(MANAGED_ARTIFACT_MAX_FILE_BYTES);
			expect(appendError.entryBytes).toBeGreaterThan(0);
			// The rejected rewrite size is the live-transcript size, not the zero an
			// absent file would report.
			expect(rejectedRewriteBytes).toBeGreaterThan(0);
			expect(appendError.liveBytes).toBe(rejectedRewriteBytes);
			expect(
				manager
					.getEntries()
					.some(
						entry =>
							entry.type === "message" && "content" in entry.message && entry.message.content === "after-enoent",
					),
			).toBe(true);
		} finally {
			try {
				await manager.close();
			} catch {}
		}
	});
});
