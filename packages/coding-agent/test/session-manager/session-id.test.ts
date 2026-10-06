import { describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ArtifactManager } from "@gajae-code/coding-agent/session/artifacts";
import { SessionManager, SessionManagerTestHooks } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import * as native from "@gajae-code/natives";
import { TempDir } from "@gajae-code/utils";
import {
	injectManagedFileRename,
	injectManagedTreeFsync,
	injectManagedTreeRemove,
	injectManagedTreeRename,
	injectManagedTreeSnapshot,
	publishFailure,
} from "./managed-failure-injection";

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
		expect(await session.setSessionStarred(true)).toBe(true);
		expect(session.isSessionStarred()).toBe(true);

		const forkResult = await session.fork();
		if (!forkResult) throw new Error("Expected fork result");

		const forkedId = expectUuidV7SessionId(session);
		expect(forkedId).not.toBe(firstId);
		expect(session.getHeader()?.parentSession).toBe(firstId);
		expect(session.isSessionStarred()).toBe(false);
		expect(session.getHeader()).not.toHaveProperty("starred");
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
		const injection = injectManagedTreeRename((source, _destination) =>
			source.includes(".fork-staging") ? publishFailure("io_error", "io_failure") : "passthrough",
		);
		try {
			await expect(session.fork()).rejects.toThrow("io_error");
			injection.assertHit();
			expect(session.getSessionFile()).toBe(oldSessionFile);
			expect(session.getSessionId()).toBe(oldSessionId);
			const entries = await fs.readdir(path.dirname(oldSessionFile));
			expect(entries.filter(entry => entry.endsWith(".jsonl"))).toEqual([path.basename(oldSessionFile)]);
			expect(entries.some(entry => entry.includes("fork-staging") && !entry.endsWith(".removing"))).toBe(false);
		} finally {
			injection.restore();
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
		const injection = injectManagedTreeRename(() => publishFailure("identity_mismatch", "identity_violation"));
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			injection.assertHit();
			expect(session.getSessionFile()).toBe(oldSessionFile);
			expect(session.getSessionId()).toBe(oldSessionId);
		} finally {
			injection.restore();
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
		const injection = injectManagedTreeRename(() => publishFailure("identity_mismatch", "identity_violation"));
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			injection.assertHit();
			expect(session.getSessionFile()).toBe(oldSessionFile);
		} finally {
			injection.restore();
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
		const injection = injectManagedTreeSnapshot({ ok: false, code: "identity_mismatch" });
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			injection.assertHit();
			expect(session.getSessionFile()).toBe(oldSessionFile);
		} finally {
			injection.restore();
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
		const injection = injectManagedTreeFsync({
			shouldFail: relativePath => relativePath.endsWith(".log"),
			code: "identity_mismatch",
		});
		try {
			await expect(session.fork()).rejects.toThrow("identity_mismatch");
			injection.assertHit();
			expect(session.getSessionFile()).toBe(oldSessionFile);
		} finally {
			injection.restore();
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
		const injection = injectManagedFileRename((_source, destination) =>
			destination.endsWith(".jsonl") ? publishFailure("io_error", "io_failure") : "passthrough",
		);
		try {
			await expect(session.fork()).rejects.toThrow("staged_publish_rejected:io_failure");
			injection.assertHit();
			expect(session.getSessionFile()).toBe(oldSessionFile);
			expect(session.getSessionId()).toBe(oldSessionId);
			const entries = await fs.readdir(path.dirname(oldSessionFile));
			expect(entries.filter(entry => entry.endsWith(".jsonl"))).toEqual([path.basename(oldSessionFile)]);
			const artifactDirectories = entries.filter(
				entry => !entry.startsWith(".") && entry !== path.basename(oldSessionFile) && !entry.endsWith(".removing"),
			);
			expect(artifactDirectories).toContain(path.basename(oldSessionFile, ".jsonl"));
			expect(artifactDirectories).toHaveLength(1);
		} finally {
			injection.restore();
			await session.close();
		}
	});

	it("preserves the primary fork failure when publication cleanup only reports an authorized POSIX quarantine", async () => {
		// `removeManagedTree` / `exact_remove_directory_tree` cannot bind the final unlink
		// to the verified root descriptor on POSIX, so they detach to `<name>.removing`
		// and report `cleanup_pending`. No live artifact survives, so that is a SUCCESSFUL
		// cleanup and must never mask the failure that triggered it.
		using tempDir = TempDir.createSync("@pi-session-fork-cleanup-pending-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const publish = injectManagedFileRename((_source, target) =>
			target.endsWith(".jsonl") ? publishFailure("io_error", "io_failure") : "passthrough",
		);
		const cleanup = injectManagedTreeRemove({ ok: false, code: "cleanup_pending" });
		try {
			const error = await session.fork().then(
				() => undefined,
				(caught: unknown) => caught as Error,
			);
			publish.assertHit();
			cleanup.assertHit();
			// The PRIMARY error survives verbatim.
			expect(String(error?.message)).toContain("staged_publish_rejected:io_failure");
			// The cleanup outcome must NOT have superseded it.
			expect(String(error?.message)).not.toContain("Failed to clean up fork publication");
			expect(error?.cause).toBeUndefined();
		} finally {
			cleanup.restore();
			publish.restore();
			await session.close();
		}
	});

	it("escalates a real fork publication cleanup failure with the primary failure as its cause", async () => {
		// An independently real cleanup failure (not the authorized quarantine) leaves a
		// live artifact behind, so it MUST supersede - while still preserving the primary
		// failure as `cause` so no evidence is lost.
		using tempDir = TempDir.createSync("@pi-session-fork-cleanup-real-failure-");
		const destination = SessionManager.managedDestination(tempDir.path(), tempDir.path());
		const session = SessionManager.create(tempDir.path(), destination);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const publish = injectManagedFileRename((_source, target) =>
			target.endsWith(".jsonl") ? publishFailure("io_error", "io_failure") : "passthrough",
		);
		const cleanup = injectManagedTreeRemove({ ok: false, code: "identity_mismatch" });
		try {
			const error = await session.fork().then(
				() => undefined,
				(caught: unknown) => caught as Error,
			);
			publish.assertHit();
			cleanup.assertHit();
			expect(String(error?.message)).toContain("Failed to clean up fork publication");
			expect(String(error?.message)).toContain("identity_mismatch");
			// The primary failure is preserved rather than discarded.
			expect(error?.cause).toBeInstanceOf(Error);
			expect(String((error?.cause as Error).message)).toContain("staged_publish_rejected:io_failure");
		} finally {
			cleanup.restore();
			publish.restore();
			await session.close();
		}
	});
	it("removes the owned staging directory and leaves no destination when the fork artifact copy fails mid-copy", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-partial-copy-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const newSessionFile = path.join(path.dirname(oldSessionFile), "partial-copy-target.jsonl");
		const destinationDir = newSessionFile.slice(0, -6);
		const injected = Object.assign(new Error("EIO: injected copy failure"), { code: "EIO" });
		const cp = vi.spyOn(fsSync.promises, "cp").mockImplementation((async (_source: unknown, destination: unknown) => {
			const target = String(destination);
			fsSync.mkdirSync(target, { recursive: true, mode: 0o700 });
			fsSync.writeFileSync(path.join(target, "partial.log"), "partial", { mode: 0o600 });
			throw injected;
		}) as unknown as typeof fsSync.promises.cp);
		try {
			await expect(session.copyArtifactsForFork(oldSessionFile, newSessionFile)).rejects.toThrow(
				"EIO: injected copy failure",
			);
			expect(cp).toHaveBeenCalledTimes(1);
			expect(fsSync.existsSync(destinationDir)).toBe(false);
			// No LIVE staging directory may remain. The native path-bound
			// exactRemoveDirectoryTree cannot unlink in place on POSIX; it detaches to a
			// no-replace `<name>.removing` quarantine, which the cleanup contract treats
			// as authorized-pending. Assert no live staging root survives and that any
			// residue is exactly that quarantine form, never an undetached tree.
			const residue = fsSync
				.readdirSync(path.dirname(oldSessionFile))
				.filter(entry => entry.includes("fork-staging"));
			expect(residue.filter(entry => !entry.endsWith(".removing"))).toEqual([]);
			expect(fsSync.existsSync(oldSessionFile.slice(0, -6))).toBe(true);

			cp.mockRestore();
			await expect(session.copyArtifactsForFork(oldSessionFile, newSessionFile)).resolves.toBeDefined();
			expect(
				fsSync.existsSync(path.join(destinationDir, "artifact.log")) ||
					fsSync.readdirSync(destinationDir).length > 0,
			).toBe(true);
		} finally {
			cp.mockRestore();
			await session.close();
		}
	});

	it("preserves a foreign directory that appears at the fork destination after the preflight", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-destination-race-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const newSessionFile = path.join(path.dirname(oldSessionFile), "destination-race-target.jsonl");
		const destinationDir = newSessionFile.slice(0, -6);
		const realCp = fsSync.promises.cp;
		const cp = vi.spyOn(fsSync.promises, "cp").mockImplementation((async (
			source: unknown,
			destination: unknown,
			options: unknown,
		) => {
			fsSync.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
			fsSync.writeFileSync(path.join(destinationDir, "foreign.txt"), "foreign", { mode: 0o600 });
			return realCp(source as never, destination as never, options as never);
		}) as unknown as typeof fsSync.promises.cp);
		try {
			await expect(session.copyArtifactsForFork(oldSessionFile, newSessionFile)).rejects.toThrow(
				"destination_conflict",
			);
			expect(fsSync.readFileSync(path.join(destinationDir, "foreign.txt"), "utf8")).toBe("foreign");
			// Our own staging root must not survive live; only the authorized
			// `<name>.removing` quarantine form is permitted (see the mid-copy test).
			const raceResidue = fsSync
				.readdirSync(path.dirname(oldSessionFile))
				.filter(entry => entry.includes("fork-staging"));
			expect(raceResidue.filter(entry => !entry.endsWith(".removing"))).toEqual([]);
		} finally {
			cp.mockRestore();
			await session.close();
		}
	});

	it("escalates a staging cleanup failure with the original copy error as its cause", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-cleanup-failure-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const newSessionFile = path.join(path.dirname(oldSessionFile), "cleanup-failure-target.jsonl");
		const injected = Object.assign(new Error("EIO: injected copy failure"), { code: "EIO" });
		const cp = vi.spyOn(fsSync.promises, "cp").mockImplementation((async (_source: unknown, destination: unknown) => {
			const target = String(destination);
			fsSync.mkdirSync(target, { recursive: true, mode: 0o700 });
			fsSync.writeFileSync(path.join(target, "partial.log"), "partial", { mode: 0o600 });
			throw injected;
		}) as unknown as typeof fsSync.promises.cp);
		const remove = vi
			.spyOn(native, "exactRemoveDirectoryTree")
			.mockReturnValue({ ok: false, code: "io_error" } as never);
		try {
			const error = await session.copyArtifactsForFork(oldSessionFile, newSessionFile).then(
				() => undefined,
				error => error,
			);
			expect(String(error?.message)).toContain("Failed to clean up explicit fork artifacts");
			expect(String(error?.message)).toContain("io_error");
			expect((error as Error).cause).toBeInstanceOf(Error);
			expect(String(((error as Error).cause as Error).message)).toContain("EIO: injected copy failure");
		} finally {
			remove.mockRestore();
			cp.mockRestore();
			await session.close();
		}
	});

	it("rethrows the original copy failure unchanged when the staging directory never materializes", async () => {
		using tempDir = TempDir.createSync("@pi-session-fork-staging-absence-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.ensureOnDisk();
		await session.flush();
		await session.saveArtifact("artifact", "test");
		const oldSessionFile = session.getSessionFile();
		if (!oldSessionFile) throw new Error("Expected session file");
		const newSessionFile = path.join(path.dirname(oldSessionFile), "staging-absence-target.jsonl");
		const injected = Object.assign(new Error("EIO: injected copy failure"), { code: "EIO" });
		let copyAttempted = false;
		const cp = vi.spyOn(fsSync.promises, "cp").mockImplementation((async (
			_source: unknown,
			_destination: unknown,
		) => {
			copyAttempted = true;
			throw injected;
		}) as unknown as typeof fsSync.promises.cp);
		const realSnapshot = native.snapshotDirectoryTree;
		const snapshot = vi.spyOn(native, "snapshotDirectoryTree").mockImplementation(directory => {
			if (copyAttempted && String(directory).includes(".fork-staging")) {
				return { ok: false, code: "not_found" } as never;
			}
			return realSnapshot(directory);
		});
		try {
			const error = await session.copyArtifactsForFork(oldSessionFile, newSessionFile).then(
				() => undefined,
				error => error,
			);
			expect(String(error?.message)).toBe("EIO: injected copy failure");
			expect((error as Error).cause).toBeUndefined();
		} finally {
			snapshot.mockRestore();
			cp.mockRestore();
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

describe("authenticated generic rollback", () => {
	it.each([
		"clone",
		"id",
		"file",
		"managed-identity",
		"adopted-manager",
		"header",
		"cold-file",
	] as const)("rejects %s snapshot substitution without changing the active session", async alteration => {
		using root = TempDir.createSync("gjc-rollback-auth-");
		const session = SessionManager.create(root.path(), SessionManager.managedDestination(root.path(), root.path()));
		const borrowed = new ArtifactManager(path.join(root.path(), "borrowed"));
		try {
			session.appendMessage({ role: "user", content: "predecessor", timestamp: 1 });
			await session.ensureOnDisk();
			session.adoptArtifactManager(borrowed);
			let snapshot = await session.captureRollbackState();
			await session.newSession();
			session.appendMessage({ role: "user", content: "successor", timestamp: 2 });
			await session.ensureOnDisk();
			const activeId = session.getSessionId();
			const activeFile = session.getSessionFile();
			if (!activeFile) throw new Error("Expected active transcript");
			const activeBytes = await Bun.file(activeFile).text();
			const activeManager = session.getArtifactManager();
			if (alteration === "clone") snapshot = { ...snapshot };
			else if (alteration === "id") snapshot.sessionId = activeId;
			else if (alteration === "file") snapshot.sessionFile = activeFile;
			else if (alteration === "managed-identity") {
				if (!snapshot.managedPersistExpectedIdentity) throw new Error("Expected managed identity");
				snapshot.managedPersistExpectedIdentity.ino += 1n;
			} else if (alteration === "adopted-manager") {
				snapshot.adoptedArtifactManager = new ArtifactManager(borrowed.dir);
			} else if (alteration === "cold-file") snapshot.coldRestoreFile = activeFile;
			else {
				const header = snapshot.materializedFileEntries.find(entry => entry.type === "session");
				if (!header) throw new Error("Expected rollback header");
				header.id = activeId;
			}
			expect(() => session.restoreState(snapshot)).toThrow("not authentic");
			await expect(session.restoreRollbackState(snapshot)).rejects.toThrow("not authentic");
			expect(session.getSessionId()).toBe(activeId);
			expect(session.getSessionFile()).toBe(activeFile);
			expect(session.getArtifactManager()).toBe(activeManager);
			expect(await Bun.file(activeFile).text()).toBe(activeBytes);
			expect(session.buildSessionContext().messages).toEqual([{ role: "user", content: "successor", timestamp: 2 }]);
		} finally {
			await session.close();
		}
	});

	it("rejects nested message and custom-entry edits without aliasing the live transcript", async () => {
		using root = TempDir.createSync("gjc-rollback-nested-edit-");
		const session = SessionManager.create(root.path(), SessionManager.managedDestination(root.path(), root.path()));
		try {
			const messageId = session.appendMessage({
				role: "user",
				content: [{ type: "text", text: "original message" }],
				timestamp: 1,
			});
			const customId = session.appendCustomEntry("nested", { payload: { value: "original custom" } });
			await session.ensureOnDisk();
			await session.flush();
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected persisted transcript");
			const originalBytes = await Bun.file(file).text();
			const snapshot = await session.captureRollbackState();
			const message = snapshot.fileEntries.find(entry => entry.type === "message");
			const custom = snapshot.materializedFileEntries.find(entry => entry.type === "custom");
			if (
				message?.type !== "message" ||
				message.message.role !== "user" ||
				!Array.isArray(message.message.content) ||
				message.message.content[0]?.type !== "text" ||
				custom?.type !== "custom"
			)
				throw new Error("Expected issued message and custom entries");
			message.message.content[0].text = "edited message";
			(custom.data as { payload: { value: string } }).payload.value = "edited custom";

			await expect(session.restoreRollbackState(snapshot)).rejects.toThrow("not authentic");
			const liveMessage = session.getEntry(messageId);
			expect(
				liveMessage?.type === "message" && liveMessage.message.role === "user"
					? liveMessage.message.content
					: undefined,
			).toEqual([{ type: "text", text: "original message" }]);
			expect(session.getEntry(customId)).toMatchObject({ data: { payload: { value: "original custom" } } });
			expect(await Bun.file(file).text()).toBe(originalBytes);
		} finally {
			await session.close();
		}
	});

	it("restores genuine managed identity and caller-owned artifact authority across directory adoption", async () => {
		using root = TempDir.createSync("gjc-rollback-genuine-");
		const cwdA = path.join(root.path(), "a");
		const cwdB = path.join(root.path(), "b");
		await fs.mkdir(cwdA);
		await fs.mkdir(cwdB);
		const session = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, root.path()));
		const target = SessionManager.create(cwdB, SessionManager.managedDestination(cwdB, root.path()));
		const borrowed = new ArtifactManager(path.join(root.path(), "borrowed"));
		try {
			session.appendMessage({ role: "user", content: "rollback data", timestamp: 1 });
			await session.ensureOnDisk();
			session.adoptArtifactManager(borrowed);
			const snapshot = await session.captureRollbackState();
			target.appendMessage({ role: "user", content: "target data", timestamp: 2 });
			await target.ensureOnDisk();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected target transcript");
			await target.close();
			session.stageAdoptedArtifactManagerForTransition();
			await session.setSessionFile(targetFile);
			await session.restoreRollbackState(snapshot);
			expect(session.getSessionId()).toBe(snapshot.sessionId);
			expect(session.getSessionFile()).toBe(snapshot.sessionFile);
			expect(session.getArtifactManager()).toBe(borrowed);
			expect(session.isArtifactManagerAuthorized(borrowed)).toBe(true);
			const restoredIdentity = session.captureState().managedPersistExpectedIdentity;
			expect(restoredIdentity).toEqual(snapshot.managedPersistExpectedIdentity);
			expect(restoredIdentity).not.toBe(snapshot.managedPersistExpectedIdentity);
			session.appendMessage({ role: "user", content: "after rollback", timestamp: 3 });
			await session.flush();
			expect(await Bun.file(snapshot.sessionFile!).text()).toContain("after rollback");
			await session.close();
			const id = await borrowed.save("still caller-owned", "test");
			expect(await borrowed.readRange(id)).toBe("still caller-owned");
		} finally {
			await session.close();
			await target.close();
		}
	});

	it("authenticates real cold rollback snapshots and restores them after bounded adoption", async () => {
		using root = TempDir.createSync("gjc-cold-generic-rollback-");
		const destination = SessionManager.managedDestination(root.path(), root.path());
		const source = SessionManager.create(root.path(), destination);
		const target = SessionManager.create(root.path(), destination);
		let reopened: SessionManager | undefined;
		try {
			await source.ensureOnDisk();
			const oldId = source.appendCustomEntry("node", { payload: "old rollback entry" });
			const keptId = source.appendCustomEntry("node", { payload: "kept rollback entry" });
			source.appendCompaction("rollback summary", undefined, keptId, 1);
			await source.flush();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Expected cold predecessor transcript");
			await source.close();
			target.appendMessage({ role: "user", content: "bounded successor", timestamp: 1 });
			await target.ensureOnDisk();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected successor transcript");
			await target.close();
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
			reopened = await SessionManager.open(
				sourceFile,
				destination,
				new FileSessionStorage(),
				"copy-retain",
				"enabled",
			);
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
			const snapshot = await reopened.captureRollbackState();
			expect(snapshot.coldRestoreFile).toBe(sourceFile);
			await reopened.setSessionFile(targetFile);
			const activeId = reopened.getSessionId();
			await expect(reopened.restoreRollbackState({ ...snapshot })).rejects.toThrow("not authentic");
			snapshot.coldRestoreFile = targetFile;
			await expect(reopened.restoreRollbackState(snapshot)).rejects.toThrow("not authentic");
			expect(reopened.getSessionId()).toBe(activeId);
			expect(reopened.getSessionFile()).toBe(targetFile);
			snapshot.coldRestoreFile = sourceFile;
			await reopened.restoreRollbackState(snapshot);
			expect(reopened.getSessionId()).toBe(snapshot.sessionId);
			expect(reopened.getSessionFile()).toBe(sourceFile);
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
			expect(reopened.getEntry(oldId)).toMatchObject({ id: oldId, data: { payload: "old rollback entry" } });
		} finally {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			await reopened?.close();
			await source.close();
			await target.close();
		}
	});

	it("rejects cold rollback after staging when its persisted transcript changes", async () => {
		using root = TempDir.createSync("gjc-cold-rollback-reject-");
		const cwdA = path.join(root.path(), "a");
		const cwdB = path.join(root.path(), "b");
		const cwdC = path.join(root.path(), "c");
		await fs.mkdir(cwdA);
		await fs.mkdir(cwdB);
		await fs.mkdir(cwdC);
		const destinationA = SessionManager.managedDestination(cwdA, root.path());
		const destinationB = SessionManager.managedDestination(cwdB, root.path());
		const destinationC = SessionManager.managedDestination(cwdC, root.path());
		const source = SessionManager.create(cwdA, destinationA);
		const target = SessionManager.create(cwdB, destinationB);
		const newerTarget = SessionManager.create(cwdC, destinationC);
		let reopened: SessionManager | undefined;
		try {
			source.appendMessage({ role: "user", content: "cold predecessor", timestamp: 1 });
			await source.ensureOnDisk();
			source.appendCustomEntry("node", { payload: "retired predecessor entry" });
			const keptId = source.appendCustomEntry("node", { payload: "kept predecessor entry" });
			source.appendCompaction("cold predecessor summary", undefined, keptId, 1);
			await source.flush();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Expected cold rollback transcript");
			await source.close();
			target.appendMessage({ role: "user", content: "active target", timestamp: 2 });
			await target.ensureOnDisk();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected active target transcript");
			await target.close();
			newerTarget.appendMessage({ role: "user", content: "unselected newer target", timestamp: 3 });
			await newerTarget.ensureOnDisk();
			await newerTarget.close();
			expect(path.dirname(sourceFile)).not.toBe(path.dirname(targetFile));
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
			reopened = await SessionManager.open(
				sourceFile,
				destinationA,
				new FileSessionStorage(),
				"copy-retain",
				"enabled",
			);
			expect(reopened.getSessionMemoryStats().coldRetirementActive).toBe(true);
			const snapshot = await reopened.captureRollbackState();
			await reopened.setSessionFile(targetFile);
			const activeId = reopened.getSessionId();
			const activeFile = reopened.getSessionFile();
			if (!activeFile) throw new Error("Expected current transcript after adoption");
			const activeBytes = await Bun.file(activeFile).text();
			const activeManager = reopened.getArtifactManager();
			if (!activeManager) throw new Error("Expected active artifact authority");
			const sourceBytes = await Bun.file(sourceFile).text();
			const driftedSourceBytes = `${sourceBytes} `;
			SessionManagerTestHooks.beforeColdRollbackCommit = async filePath => {
				expect(filePath).toBe(sourceFile);
				await Bun.write(sourceFile, driftedSourceBytes);
			};
			await expect(reopened.restoreRollbackState(snapshot)).rejects.toThrow("persistence identity changed");
			SessionManagerTestHooks.beforeColdRollbackCommit = undefined;
			expect(reopened.getSessionId()).toBe(activeId);
			expect(reopened.getSessionFile()).toBe(activeFile);
			expect(reopened.getArtifactManager()).toBe(activeManager);
			expect(reopened.isArtifactManagerAuthorized(activeManager)).toBe(true);
			expect(await Bun.file(activeFile).text()).toBe(activeBytes);
			expect(await Bun.file(sourceFile).text()).toBe(driftedSourceBytes);
			expect(reopened.buildSessionContext().messages).toEqual([
				{ role: "user", content: "active target", timestamp: 2 },
			]);
			reopened.appendMessage({ role: "user", content: "still active after rejected rollback", timestamp: 4 });
			await reopened.flush();
			const artifactId = await reopened.saveArtifact("target authority remains writable", "test");
			if (!artifactId) throw new Error("Expected artifact id");
			expect(await Bun.file(activeFile).text()).toContain("still active after rejected rollback");
			expect(path.dirname((await reopened.getArtifactPath(artifactId))!)).toBe(activeFile.slice(0, -6));
		} finally {
			SessionManagerTestHooks.beforeColdRollbackCommit = undefined;
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			await reopened?.close();
			await source.close();
			await target.close();
			await newerTarget.close();
		}
	});

	it("rejects stale bounded adoption without overwriting a newer managed switch", async () => {
		using root = TempDir.createSync("gjc-bounded-adoption-stale-");
		const cwdA = path.join(root.path(), "a");
		const cwdB = path.join(root.path(), "b");
		const cwdC = path.join(root.path(), "c");
		await fs.mkdir(cwdA);
		await fs.mkdir(cwdB);
		await fs.mkdir(cwdC);
		const destinationA = SessionManager.managedDestination(cwdA, root.path());
		const destinationB = SessionManager.managedDestination(cwdB, root.path());
		const destinationC = SessionManager.managedDestination(cwdC, root.path());
		const session = SessionManager.create(cwdA, destinationA);
		const newerTarget = SessionManager.create(cwdB, destinationB);
		const outerTarget = SessionManager.create(cwdC, destinationC);
		try {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
			session.appendMessage({ role: "user", content: "predecessor M", timestamp: 1 });
			await session.ensureOnDisk();
			await session.flush();
			session.setSessionMemoryMode("enabled");
			newerTarget.appendMessage({ role: "user", content: "accepted newer N", timestamp: 2 });
			await newerTarget.ensureOnDisk();
			outerTarget.appendMessage({ role: "user", content: "rejected outer target", timestamp: 3 });
			await outerTarget.ensureOnDisk();
			const newerFile = newerTarget.getSessionFile();
			const outerFile = outerTarget.getSessionFile();
			if (!newerFile || !outerFile) throw new Error("Expected managed adoption targets");
			expect(path.dirname(newerFile)).not.toBe(path.dirname(session.getSessionFile()!));
			const newerBytes = await Bun.file(newerFile).text();
			await newerTarget.close();
			await outerTarget.close();
			let newerSwitchAccepted = false;
			SessionManagerTestHooks.beforeManagedSwitchIdentity = async filePath => {
				if (filePath !== outerFile) throw new Error("Unexpected nested managed switch");
				SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
				await session.setSessionFile(newerFile);
				newerSwitchAccepted = true;
			};
			await expect(session.setSessionFile(outerFile)).rejects.toThrow("Session changed before adoption commit.");
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			expect(newerSwitchAccepted).toBe(true);
			expect(session.getSessionId()).toBe(newerTarget.getSessionId());
			expect(session.getSessionFile()).toBe(newerFile);
			expect(session.buildSessionContext().messages).toEqual([
				{ role: "user", content: "accepted newer N", timestamp: 2 },
			]);
			expect(await Bun.file(newerFile).text()).toBe(newerBytes);
			const manager = session.getArtifactManager();
			if (!manager) throw new Error("Expected newer artifact authority");
			expect(session.isArtifactManagerAuthorized(manager)).toBe(true);
			session.appendMessage({ role: "user", content: "N remains writable", timestamp: 4 });
			await session.flush();
			const artifactId = await session.saveArtifact("newer N artifact", "test");
			if (!artifactId) throw new Error("Expected artifact id");
			expect(session.getArtifactManager()).toBe(manager);
			expect(await Bun.file(newerFile).text()).toContain("N remains writable");
			expect(path.dirname((await session.getArtifactPath(artifactId))!)).toBe(newerFile.slice(0, -6));
		} finally {
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			await session.close();
			await newerTarget.close();
			await outerTarget.close();
		}
	});

	it("rejects explicit persisted transcript drift through both rollback APIs and accepts unchanged identity", async () => {
		using root = TempDir.createSync("gjc-explicit-rollback-identity-");
		const storage = new FileSessionStorage();
		const session = SessionManager.create(root.path(), root.path(), storage);
		try {
			session.appendMessage({ role: "user", content: "persisted predecessor", timestamp: 1 });
			await session.ensureOnDisk();
			await session.flush();
			const snapshot = await session.captureRollbackState();
			const predecessorFile = session.getSessionFile();
			if (!predecessorFile) throw new Error("Expected explicit persisted transcript");
			await session.newSession();
			session.appendMessage({ role: "user", content: "active successor", timestamp: 2 });
			await session.ensureOnDisk();
			const activeId = session.getSessionId();
			const activeFile = session.getSessionFile();
			if (!activeFile) throw new Error("Expected active explicit transcript");
			await session.flush();
			const activeBytes = await Bun.file(activeFile).text();
			const activeManager = session.getArtifactManager();
			if (!activeManager) throw new Error("Expected active explicit artifact authority");
			const predecessorBytes = await Bun.file(predecessorFile).text();
			const driftedPredecessorBytes = predecessorBytes.replace(
				"persisted predecessor",
				"persisted predecessor drift",
			);
			await Bun.write(predecessorFile, driftedPredecessorBytes);
			expect(() => session.restoreState(snapshot)).toThrow("persistence identity changed");
			await expect(session.restoreRollbackState(snapshot)).rejects.toThrow("persistence identity changed");
			expect(session.getSessionId()).toBe(activeId);
			expect(session.getSessionFile()).toBe(activeFile);
			expect(session.getArtifactManager()).toBe(activeManager);
			expect(session.isArtifactManagerAuthorized(activeManager)).toBe(true);
			expect(await Bun.file(activeFile).text()).toBe(activeBytes);
			expect(await Bun.file(predecessorFile).text()).toBe(driftedPredecessorBytes);
			expect(session.buildSessionContext().messages).toEqual([
				{ role: "user", content: "active successor", timestamp: 2 },
			]);
			session.appendMessage({ role: "user", content: "active explicit authority remains writable", timestamp: 3 });
			await session.flush();
			const id = await session.saveArtifact("active explicit artifact", "test");
			if (!id) throw new Error("Expected artifact id");
			expect(await Bun.file(activeFile).text()).toContain("active explicit authority remains writable");
			expect(path.dirname((await session.getArtifactPath(id))!)).toBe(activeFile.slice(0, -6));
		} finally {
			await session.close();
		}

		const stable = SessionManager.create(root.path(), root.path(), storage);
		try {
			stable.appendMessage({ role: "user", content: "unchanged predecessor", timestamp: 4 });
			await stable.ensureOnDisk();
			const unchangedSnapshot = await stable.captureRollbackState();
			const unchangedId = stable.getSessionId();
			await stable.newSession();
			await stable.ensureOnDisk();
			stable.restoreState(unchangedSnapshot);
			expect(stable.getSessionId()).toBe(unchangedId);
			await stable.flush();
			const asyncSnapshot = await stable.captureRollbackState();
			await stable.newSession();
			await stable.ensureOnDisk();
			await stable.restoreRollbackState(asyncSnapshot);
			expect(stable.getSessionId()).toBe(unchangedId);
			expect(stable.buildSessionContext().messages).toEqual([
				{ role: "user", content: "unchanged predecessor", timestamp: 4 },
			]);
		} finally {
			await stable.close();
		}
	});

	it("keeps a real storage EIO through rejected adoption and rollback, then accepts a stabilized retry", async () => {
		using root = TempDir.createSync("gjc-adoption-eio-");
		const storage = new FileSessionStorage();
		const session = SessionManager.create(root.path(), root.path(), storage);
		const target = SessionManager.create(root.path(), root.path());
		const eio = Object.assign(new Error("EIO: transcript replacement failed"), { code: "EIO" });
		const rename = vi.spyOn(storage, "renameSync").mockImplementationOnce(() => {
			throw eio;
		});
		try {
			session.appendMessage({ role: "user", content: "pending predecessor", timestamp: 1 });
			const snapshot = session.captureState();
			await expect(session.ensureOnDisk()).rejects.toBe(eio);
			rename.mockRestore();
			target.appendMessage({ role: "user", content: "accepted target", timestamp: 2 });
			await target.ensureOnDisk();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected target transcript");
			await target.close();
			const stable = await Bun.file(targetFile).text();
			SessionManagerTestHooks.beforeManagedSwitchIdentity = async file => {
				await Bun.write(file, stable.replace(target.getSessionId(), "replacement-session"));
			};
			await expect(session.setSessionFile(targetFile)).rejects.toThrow("changed before adoption commit");
			expect(session.getSessionId()).toBe(snapshot.sessionId);
			await expect(session.flush()).rejects.toBe(eio);
			session.restoreState(snapshot);
			await expect(session.flush()).rejects.toBe(eio);
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			await Bun.write(targetFile, stable);
			await session.setSessionFile(targetFile);
			await session.flush();
			expect(session.getSessionId()).toBe(target.getSessionId());
			session.appendMessage({ role: "user", content: "stabilized retry persisted", timestamp: 3 });
			await session.flush();
			expect(await Bun.file(targetFile).text()).toContain("stabilized retry persisted");
		} finally {
			SessionManagerTestHooks.beforeManagedSwitchIdentity = undefined;
			rename.mockRestore();
			await session.closeStrict();
			await target.closeStrict();
		}
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
