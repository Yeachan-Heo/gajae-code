import { describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
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
