import { describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import { TempDir } from "@gajae-code/utils";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectUuidV7SessionId(session: SessionManager): string {
	const sessionId = session.getSessionId();
	expect(sessionId).toMatch(UUID_V7_RE);
	const header = session.getHeader();
	if (!header) throw new Error("Expected session header");
	expect(header.id).toBe(sessionId);
	return sessionId;
}

describe("SessionManager session ids", () => {
	it("generates UUIDv7 ids for new in-memory sessions", () => {
		const session = SessionManager.inMemory();

		expectUuidV7SessionId(session);
	});

	it("generates a fresh UUIDv7 when starting a new session", async () => {
		const session = SessionManager.inMemory();
		const firstId = expectUuidV7SessionId(session);

		await session.newSession();

		const secondId = expectUuidV7SessionId(session);
		expect(secondId).not.toBe(firstId);
	});

	it("generates a UUIDv7 when branching a session", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const branchPointId = session.appendMessage({ role: "user", content: "follow up", timestamp: 2 });
		const firstId = expectUuidV7SessionId(session);

		session.createBranchedSession(branchPointId);

		const branchedId = expectUuidV7SessionId(session);
		expect(branchedId).not.toBe(firstId);
	});

	it("persists managed hot-path appends before returning", async () => {
		using tempDir = TempDir.createSync("@pi-session-managed-sync-append-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		try {
			session.appendMessage({ role: "user", content: "first", timestamp: 1 });
			await session.ensureOnDisk();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			session.appendMessage({ role: "user", content: "durable immediately", timestamp: 2 });
			for (let index = 0; index < 5; index++)
				session.appendMessage({ role: "user", content: `additional ${index}`, timestamp: 3 + index });
			const persisted = fsSync.readFileSync(sessionFile, "utf8");
			expect(persisted).toContain("durable immediately");
			const recoveryCopies = fsSync
				.readdirSync(tempDir.path(), { recursive: true, encoding: "utf8" })
				.filter(entry => path.basename(entry).startsWith(".gjc-managed-replace-"));
			expect(recoveryCopies).toEqual([]);
		} finally {
			await session.close();
		}
	});

	it("generates a UUIDv7 when forking a persisted session", async () => {
		using tempDir = TempDir.createSync("@pi-session-id-fork-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();
		const firstId = expectUuidV7SessionId(session);

		const forkResult = await session.fork();
		if (!forkResult) throw new Error("Expected fork result");

		const forkedId = expectUuidV7SessionId(session);
		expect(forkedId).not.toBe(firstId);
		expect(session.getHeader()?.parentSession).toBe(firstId);
	});

	it("rolls back fork identity before publishing a transcript when artifact import fails", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-rollback-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		const oldSessionId = session.getSessionId();
		if (!oldSessionFile) throw new Error("Expected session file");
		const realRename = native.RecoveryFsRoot.prototype.renameManagedTreeNoReplace;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "renameManagedTreeNoReplace").mockImplementation(function (
			this: native.RecoveryFsRoot,
			source,
			destination,
			expected,
		) {
			return source.includes(".fork-staging")
				? { ok: false, code: "io_error" }
				: realRename.call(this, source, destination, expected);
		});
		try {
			await expect(session.fork()).rejects.toThrow("io_error");
			expect(session.getSessionFile()).toBe(oldSessionFile);
			expect(session.getSessionId()).toBe(oldSessionId);
			const entries = await fs.readdir(path.dirname(oldSessionFile));
			expect(entries.filter(entry => entry.endsWith(".jsonl"))).toEqual([path.basename(oldSessionFile)]);
			expect(entries.some(entry => entry.includes("fork-staging"))).toBe(false);
		} finally {
			spy.mockRestore();
			await session.close();
		}
	});

	it("forks managed artifacts above the recovery-state size cap", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-large-artifact-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		const payload = "x".repeat(2 * 1024 * 1024);
		await session.saveArtifact(payload, "test");
		const forked = await session.fork();
		if (!forked) throw new Error("Expected fork result");
		expect((await fs.stat(path.join(forked.newSessionFile.slice(0, -6), "0.test.log"))).size).toBe(
			Buffer.byteLength(payload),
		);
		await session.close();
	});

	it("rejects a fork when the published artifact tree changes at the rename boundary", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-terminal-manifest-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		const oldSessionId = session.getSessionId();
		if (!oldSessionFile) throw new Error("Expected session file");
		const spy = vi
			.spyOn(native.RecoveryFsRoot.prototype, "renameManagedTreeNoReplace")
			.mockReturnValue({ ok: false, code: "identity_mismatch" });
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			expect(session.getSessionFile()).toBe(oldSessionFile);
			expect(session.getSessionId()).toBe(oldSessionId);
		} finally {
			spy.mockRestore();
			await session.close();
		}
	});

	it("rejects a byte-identical whole-root fork artifact replacement", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-root-replacement-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const spy = vi
			.spyOn(native.RecoveryFsRoot.prototype, "renameManagedTreeNoReplace")
			.mockReturnValue({ ok: false, code: "identity_mismatch" });
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			expect(session.getSessionFile()).toBe(oldSessionFile);
		} finally {
			spy.mockRestore();
			await session.close();
		}
	});

	it("fails closed when retained artifact capture rejects a substituted tree", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-post-snapshot-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const spy = vi
			.spyOn(native.RecoveryFsRoot.prototype, "snapshotManagedTree")
			.mockReturnValue({ ok: false, code: "identity_mismatch" });
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			expect(session.getSessionFile()).toBe(oldSessionFile);
		} finally {
			spy.mockRestore();
			await session.close();
		}
	});

	it("rejects an artifact identity mismatch during retained tree fsync", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-fsync-replacement-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const realFsyncExpected = native.RecoveryFsRoot.prototype.fsyncExpected;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "fsyncExpected").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			directory,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedSha256,
		) {
			if (relativePath.endsWith(".log")) return { ok: false, code: "identity_mismatch" };
			return realFsyncExpected.call(
				this,
				relativePath,
				directory,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedSha256,
			);
		});
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			expect(session.getSessionFile()).toBe(oldSessionFile);
		} finally {
			spy.mockRestore();
			await session.close();
		}
	});

	it("removes published fork artifacts when transcript publication fails", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-transcript-failure-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		const oldSessionId = session.getSessionId();
		if (!oldSessionFile) throw new Error("Expected session file");
		const realRename = native.RecoveryFsRoot.prototype.renameManagedFileNoReplace;
		const spy = vi.spyOn(native.RecoveryFsRoot.prototype, "renameManagedFileNoReplace").mockImplementation(function (
			this: native.RecoveryFsRoot,
			sourceRelativePath,
			destinationRelativePath,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			if (destinationRelativePath.endsWith(".jsonl")) return { ok: false, code: "io_error" };
			return realRename.call(
				this,
				sourceRelativePath,
				destinationRelativePath,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
		});
		try {
			await expect(session.fork()).rejects.toThrow("io_error");
			expect(session.getSessionFile()).toBe(oldSessionFile);
			expect(session.getSessionId()).toBe(oldSessionId);
			const entries = await fs.readdir(path.dirname(oldSessionFile));
			expect(entries.filter(entry => entry.endsWith(".jsonl"))).toEqual([path.basename(oldSessionFile)]);
			expect(entries.filter(entry => !entry.startsWith(".") && entry !== path.basename(oldSessionFile))).toEqual([
				path.basename(oldSessionFile, ".jsonl"),
			]);
		} finally {
			spy.mockRestore();
			await session.close();
		}
	});

	it("preserves existing session ids when reopening a saved session", async () => {
		using tempDir = TempDir.createSync("@pi-session-id-open-");
		const sessionFile = path.join(tempDir.path(), "existing.jsonl");
		const existingId = "existing-session-id";
		await Bun.write(
			sessionFile,
			`${JSON.stringify({ type: "session", id: existingId, timestamp: new Date().toISOString(), cwd: tempDir.path() })}\n`,
		);

		const session = await SessionManager.open(sessionFile, tempDir.path());

		expect(session.getSessionId()).toBe(existingId);
		expect(session.getHeader()?.id).toBe(existingId);
	});
});

describe("context clear", () => {
	it("preserves session id while clearing the active branch context", () => {
		const session = SessionManager.inMemory();
		const sessionId = expectUuidV7SessionId(session);
		session.appendMessage({ role: "user", content: "before clear", timestamp: 1 });

		session.appendContextClearEntry({ sessionId });
		session.appendMessage({ role: "user", content: "after clear", timestamp: 2 });

		expect(session.getSessionId()).toBe(sessionId);
		expect(session.getHeader()?.id).toBe(sessionId);
		expect(session.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);
		expect(session.buildSessionContext().messages).toEqual([{ role: "user", content: "after clear", timestamp: 2 }]);
	});
});
