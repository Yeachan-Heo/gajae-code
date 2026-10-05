import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadEntriesFromFile,
	type SessionHeader,
	SessionManager,
	syncSessionMoveDirectory,
} from "@gajae-code/coding-agent/session/session-manager";
import { stripOuterDoubleQuotes } from "@gajae-code/coding-agent/tools/path-utils";
import * as native from "@gajae-code/natives";
import { getConfigRootDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";
import { resolveManagedScope } from "../../src/session/internal/managed-session-scope";
import { makeAssistantMessage } from "./helpers";

function forceImmediateNativeCleanup(): () => void {
	const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
		if (identity.directory && identity.quarantineName) {
			const detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
			fs.renameSync(pathname, detachedPath);
			return { ok: true, detachedPath };
		}
		fs.rmSync(pathname, { force: true });
		return { ok: true };
	});
	const remove = vi.spyOn(native, "exactRemoveDirectoryTree").mockImplementation(pathname => {
		fs.rmSync(pathname, { recursive: true, force: true });
		return { ok: true };
	});
	return () => {
		unlink.mockRestore();
		remove.mockRestore();
	};
}

it("does not open or fsync a source parent directory on Windows after a committed move", async () => {
	let opens = 0;
	let syncs = 0;
	let closes = 0;
	await syncSessionMoveDirectory("C:\\sessions", "win32", async () => {
		opens++;
		return {
			sync: async () => {
				syncs++;
			},
			close: async () => {
				closes++;
			},
		};
	});
	expect({ opens, syncs, closes }).toEqual({ opens: 0, syncs: 0, closes: 0 });
});

// -- helpers ----------------------------------------------------------------

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader => typeof e === "object" && e !== null && "type" in e && (e as any).type === "session",
	) as SessionHeader | undefined;
}

function hasAssistantEntry(entries: unknown[]): boolean {
	return entries.some(
		e =>
			typeof e === "object" &&
			e !== null &&
			"type" in e &&
			(e as any).type === "message" &&
			"message" in e &&
			(e as any).message?.role === "assistant",
	);
}

function managedDirectoryName(cwd: string): string {
	const sessionsRoot = getSessionsDir();
	const resolved = resolveManagedScope({
		cwd,
		agentDir: path.resolve(sessionsRoot, ".."),
		sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	return resolved.scope.directoryName;
}

// -- stripOuterDoubleQuotes tests -------------------------------------------

describe("stripOuterDoubleQuotes", () => {
	it("strips matching double quotes", () => {
		expect(stripOuterDoubleQuotes('"C:\\Users\\test"')).toBe("C:\\Users\\test");
	});
	it("strips matching double quotes from POSIX paths", () => {
		expect(stripOuterDoubleQuotes('"/home/user/test"')).toBe("/home/user/test");
	});
	it("passes through unquoted paths", () => {
		expect(stripOuterDoubleQuotes("C:\\Users\\test")).toBe("C:\\Users\\test");
	});
	it("does not strip mismatched quotes", () => {
		expect(stripOuterDoubleQuotes('"mismatched')).toBe('"mismatched');
	});
	it("does not strip single quotes", () => {
		expect(stripOuterDoubleQuotes("'foo'")).toBe("'foo'");
	});
	it("does not strip a lone double quote", () => {
		expect(stripOuterDoubleQuotes('"')).toBe('"');
	});
	it("strips empty quoted string to empty", () => {
		expect(stripOuterDoubleQuotes('""')).toBe("");
	});
});

// -- moveTo() tests ---------------------------------------------------------

describe("SessionManager.moveTo", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-move-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("moves session file and updates header cwd (baseline)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(oldFile)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Reload and verify content
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(JSON.parse(fs.readFileSync(newFile, "utf8").split("\n", 1)[0]!).cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
		const reopened = await SessionManager.open(newFile);
		expect(reopened.getCwd()).toBe(path.resolve(cwdB));
		await reopened.close();
	});

	it("does not replace an existing destination transcript", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sourceFile = session.getSessionFile()!;
		const destinationDir = SessionManager.getDefaultSessionDir(cwdB);
		const destinationFile = path.join(destinationDir, path.basename(sourceFile));
		fs.writeFileSync(destinationFile, "unrelated destination\n");

		await expect(session.moveTo(cwdB)).rejects.toThrow();
		expect(fs.readFileSync(destinationFile, "utf8")).toBe("unrelated destination\n");
		expect(fs.existsSync(sourceFile)).toBe(true);
	});

	it("detaches the active session before deleting its transcript", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "delete me", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const activeFile = session.getSessionFile();
		if (!activeFile) throw new Error("Expected active session file");
		const restoreCleanup = forceImmediateNativeCleanup();
		try {
			await session.dropSession(activeFile);
		} finally {
			restoreCleanup();
		}

		expect(fs.existsSync(activeFile)).toBe(false);
		expect(session.getSessionFile()).not.toBe(activeFile);
	});

	it("deletes detached sessions and artifacts from an explicit session directory", async () => {
		const explicitDir = path.join(testAgentDir, "explicit-sessions");
		const session = SessionManager.create(cwdA, explicitDir);
		session.appendMessage({ role: "user", content: "delete explicit", timestamp: 1 });
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected explicit session file");
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected explicit artifact path");
		await fsp.writeFile(artifactPath, "artifact");

		await session.dropSession(sessionFile);

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(path.dirname(artifactPath))).toBe(false);
		expect(session.getSessionFile()).not.toBe(sessionFile);
	});

	it("uses retained copy publication while the durable artifact owner survives a managed move", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sourceFile = session.getSessionFile()!;
		const manager = await session.ensureArtifactManager();
		if (!manager) throw new Error("Expected managed artifact owner");
		const artifactId = await manager.save("authoritative artifact", "bash");
		const artifactPath = await manager.getPath(artifactId);
		if (!artifactPath) throw new Error("Expected artifact path");
		const sourceHeader = getHeader(await loadEntriesFromFile(sourceFile));
		if (!sourceHeader?.taskArtifactOwner) throw new Error("Expected persisted owner locator");
		const ownerIdentity = await fsp.stat(manager.dir, { bigint: true });
		expect(path.dirname(manager.dir)).toBe(path.join(path.resolve(getSessionsDir()), ".task-artifact-owners"));
		expect(path.basename(manager.dir)).toBe(sourceHeader.taskArtifactOwner.ownerId);
		expect(path.resolve(manager.dir)).not.toBe(path.resolve(sourceFile.slice(0, -6)));

		const destinationFile = path.join(SessionManager.getDefaultSessionDir(cwdB), path.basename(sourceFile));
		await session.moveTo(cwdB);

		expect(fs.existsSync(sourceFile)).toBe(false);
		expect(fs.existsSync(destinationFile)).toBe(true);
		expect(fs.existsSync(destinationFile.slice(0, -6))).toBe(false);
		expect(await fsp.readFile(artifactPath, "utf8")).toBe("authoritative artifact");
		expect((await fsp.stat(manager.dir, { bigint: true })).ino).toBe(ownerIdentity.ino);
		expect(getHeader(await loadEntriesFromFile(destinationFile))?.taskArtifactOwner).toEqual(
			sourceHeader.taskArtifactOwner,
		);

		const reopened = await SessionManager.open(destinationFile, SessionManager.managedDestination(cwdB));
		try {
			const restored = await reopened.ensureArtifactManager();
			expect(restored?.dir).toBe(manager.dir);
			expect(await reopened.getArtifactPath(artifactId)).toBe(artifactPath);
			expect(await restored?.readRange(artifactId)).toBe("authoritative artifact");
		} finally {
			await reopened.close();
			await session.close();
		}
	});

	it("uses atomic rename without requiring hard-link support on the same device", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "rename first", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const originalLink = fs.promises.link;
		let linkCalls = 0;
		fs.promises.link = async () => {
			linkCalls++;
			const error = new Error("hard links disabled") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		};
		try {
			await session.moveTo(cwdB);
		} finally {
			fs.promises.link = originalLink;
		}
		expect(linkCalls).toBe(0);
		expect(session.getCwd()).toBe(cwdB);
		expect(fs.existsSync(session.getSessionFile()!)).toBe(true);
	});

	it("preserves durable owner identity and nested artifact topology on a same-device move", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sourceFile = session.getSessionFile()!;
		const manager = await session.ensureArtifactManager();
		if (!manager) throw new Error("Expected managed artifact owner");
		const artifactId = await manager.save("top-level artifact", "bash");
		const artifactPath = await manager.getPath(artifactId);
		if (!artifactPath) throw new Error("Expected top-level artifact path");
		const sourceHeader = getHeader(await loadEntriesFromFile(sourceFile));
		if (!sourceHeader?.taskArtifactOwner) throw new Error("Expected persisted owner locator");
		const sourceArtifacts = manager.dir;
		const sourceOwnerIdentity = await fsp.stat(sourceArtifacts, { bigint: true });
		expect(path.dirname(sourceArtifacts)).toBe(path.join(path.resolve(getSessionsDir()), ".task-artifact-owners"));
		expect(path.basename(sourceArtifacts)).toBe(sourceHeader.taskArtifactOwner.ownerId);
		await fsp.mkdir(path.join(sourceArtifacts, "nested", "empty"), { recursive: true, mode: 0o700 });
		await fsp.writeFile(path.join(sourceArtifacts, "nested", "payload.txt"), "nested artifact", { mode: 0o600 });

		await session.moveTo(cwdB);

		const destinationFile = session.getSessionFile()!;
		expect(fs.existsSync(sourceFile)).toBe(false);
		expect(fs.existsSync(destinationFile.slice(0, -6))).toBe(false);
		expect(manager.dir).toBe(sourceArtifacts);
		expect((await fsp.stat(manager.dir, { bigint: true })).ino).toBe(sourceOwnerIdentity.ino);
		expect(await fsp.readFile(artifactPath, "utf8")).toBe("top-level artifact");
		expect(await fsp.readFile(path.join(manager.dir, "nested", "payload.txt"), "utf8")).toBe("nested artifact");
		expect((await fsp.stat(path.join(manager.dir, "nested", "empty"))).isDirectory()).toBe(true);
		expect(getHeader(await loadEntriesFromFile(destinationFile))?.taskArtifactOwner).toEqual(
			sourceHeader.taskArtifactOwner,
		);

		const reopened = await SessionManager.open(destinationFile, SessionManager.managedDestination(cwdB));
		try {
			const restored = await reopened.ensureArtifactManager();
			expect(restored?.dir).toBe(sourceArtifacts);
			expect(await restored?.readRange(artifactId)).toBe("top-level artifact");
			expect(await fsp.readFile(path.join(restored!.dir, "nested", "payload.txt"), "utf8")).toBe("nested artifact");
		} finally {
			await reopened.close();
			await session.close();
		}
	});

	it("moves an actual legacy artifact tree without pre-creating its destination", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "legacy tree", timestamp: 1 });
		await session.ensureOnDisk();
		const sourceFile = session.getSessionFile()!;
		const sourceArtifacts = sourceFile.slice(0, -6);
		const legacyArtifact = path.join(sourceArtifacts, "0.bash.log");
		await fsp.mkdir(sourceArtifacts, { recursive: true, mode: 0o700 });
		await fsp.writeFile(legacyArtifact, "legacy artifact", { mode: 0o600 });
		const destinationArtifacts = path.join(SessionManager.getDefaultSessionDir(cwdB), path.basename(sourceArtifacts));
		expect(fs.existsSync(destinationArtifacts)).toBe(false);

		await session.moveTo(cwdB);

		const destinationFile = session.getSessionFile();
		if (!destinationFile) throw new Error("Expected destination session file");
		expect(fs.existsSync(sourceArtifacts)).toBe(false);
		expect(await fsp.readFile(path.join(destinationArtifacts, path.basename(legacyArtifact)), "utf8")).toBe(
			"legacy artifact",
		);
		const manager = await session.ensureArtifactManager();
		if (!manager) throw new Error("Expected migrated durable artifact owner");
		expect(manager.dir).not.toBe(destinationArtifacts);
		expect(await manager.readRange("0")).toBe("legacy artifact");
		expect(getHeader(await loadEntriesFromFile(destinationFile))?.taskArtifactOwner).toBeDefined();
	});

	it("succeeds on fresh session without ENOENT, then deferred persistence works", async () => {
		const session = SessionManager.create(cwdA);
		// No messages — file never written to disk
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		// Lazy-persist preserved: no header-only .jsonl created
		expect(fs.existsSync(newFile)).toBe(false);

		// Verify deferred persistence at the new path
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		expect(fs.existsSync(newFile)).toBe(true);
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("recreates file from memory when old file is deleted", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		// Delete the file to simulate unexpected removal
		await fsp.unlink(oldFile);
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Verify content recreated from memory
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("moves header-only session and rewrites cwd", async () => {
		// Create a header-only session via open() with a non-existent explicit path
		const explicitPath = path.join(cwdA, "explicit-session.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);
		expect(path.dirname(newFile)).toBe(path.join(getSessionsDir(), managedDirectoryName(cwdB)));
		const reopened = await SessionManager.open(newFile);
		try {
			expect(reopened.getCwd()).toBe(path.resolve(cwdB));
			expect(reopened.getSessionFile()).toBe(newFile);
		} finally {
			await reopened.close();
		}

		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves header-only session with pending user message (#flushed regression)", async () => {
		// Create a header-only session
		const explicitPath = path.join(cwdA, "explicit-session-2.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		// Add a user message only — _persist() sets #flushed=false (line 1827)
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);
		expect(path.dirname(newFile)).toBe(path.join(getSessionsDir(), managedDirectoryName(cwdB)));
		const reopened = await SessionManager.open(newFile);
		try {
			expect(reopened.getCwd()).toBe(path.resolve(cwdB));
			expect(reopened.getSessionFile()).toBe(newFile);
		} finally {
			await reopened.close();
		}

		// Rewrite must have run (hadSessionFile=true) even though #flushed was reset
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves a legacy artifact tree without a transcript, then adopts it under a durable owner", async () => {
		const session = SessionManager.create(cwdA);
		const oldFile = session.getSessionFile()!;
		const oldArtifactDir = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifactDir, { recursive: true, mode: 0o700 });
		await fsp.writeFile(path.join(oldArtifactDir, "0.bash.log"), "legacy artifact", { mode: 0o600 });
		expect(fs.existsSync(oldArtifactDir)).toBe(true);

		// A legacy artifact directory can exist even when no session transcript was published.
		expect(fs.existsSync(oldFile)).toBe(false);
		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(oldArtifactDir)).toBe(false);
		const newFile = session.getSessionFile()!;
		const newArtifactDir = newFile.slice(0, -6);
		expect(fs.existsSync(newFile)).toBe(false);
		expect(await fsp.readFile(path.join(newArtifactDir, "0.bash.log"), "utf8")).toBe("legacy artifact");

		const manager = await session.ensureArtifactManager();
		if (!manager) throw new Error("Expected durable artifact owner after legacy adoption");
		expect(fs.existsSync(newFile)).toBe(true);
		expect(manager.dir).not.toBe(newArtifactDir);
		expect(await manager.readRange("0")).toBe("legacy artifact");
		const reopened = await SessionManager.open(newFile, SessionManager.managedDestination(cwdB));
		try {
			const restored = await reopened.ensureArtifactManager();
			expect(restored?.dir).toBe(manager.dir);
			expect(await restored?.readRange("0")).toBe("legacy artifact");
		} finally {
			await reopened.close();
			await session.close();
		}
	});
});
