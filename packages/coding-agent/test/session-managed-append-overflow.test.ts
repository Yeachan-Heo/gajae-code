import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

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
 * `#rewriteFileContents` recovery should rewrite only the live in-memory entries.
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
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentity")
				.mockRejectedValue(new Error("content_too_large"));
			const appendSyncSpy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedSync")
				.mockImplementation(() => {
					throw new Error("content_too_large");
				});

			// This append should hit content_too_large and recover via rewrite.
			expect(() => manager.appendMessage({ role: "user", content: "after-overflow", timestamp: 2 })).not.toThrow();
			await manager.flush();

			appendSpy.mockRestore();
			appendSyncSpy.mockRestore();

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
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentity")
				.mockRejectedValue(new Error("some_other_error"));
			const appendSyncSpy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedSync")
				.mockImplementation(() => {
					throw new Error("some_other_error");
				});

			manager.appendMessage({ role: "user", content: "fail", timestamp: 2 });
			await expect(manager.flush()).rejects.toThrow();

			appendSpy.mockRestore();
			appendSyncSpy.mockRestore();
		} finally {
			// Suppress the poisoned close error.
			try {
				await manager.close();
			} catch {}
		}
	});
});
