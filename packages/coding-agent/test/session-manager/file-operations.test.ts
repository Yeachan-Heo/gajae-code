import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	findMostRecentSession,
	getRecentSessions,
	loadEntriesFromFile,
	resolveResumableSession,
	type SessionHeader,
	SessionManagedStorageError,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";

import { MemorySessionStorage } from "@gajae-code/coding-agent/session/session-storage";

import { getConfigRootDir, getSessionsDir, getTerminalSessionsDir, Snowflake, setAgentDir } from "@gajae-code/utils";
import { listManagedCandidates, resolveManagedScope } from "../../src/session/internal/managed-session-scope";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads valid session file", async () => {
		const file = path.join(tempDir, "valid.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", async () => {
		const file = path.join(tempDir, "mixed.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns single valid session file", async () => {
		const file = path.join(tempDir, "session.jsonl");
		fs.writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(await findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = path.join(tempDir, "older.jsonl");
		const file2 = path.join(tempDir, "newer.jsonl");

		fs.writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise(r => setTimeout(r, 10));
		fs.writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(await findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = path.join(tempDir, "invalid.jsonl");
		const valid = path.join(tempDir, "valid.jsonl");

		fs.writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise(r => setTimeout(r, 10));
		fs.writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(await findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("getRecentSessions", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns enough default entries for the viewport-expanded welcome trail", async () => {
		for (let index = 0; index < 5; index++) {
			const file = path.join(tempDir, `session-${index}.jsonl`);
			fs.writeFileSync(
				file,
				`${JSON.stringify({
					type: "session",
					id: `session-${index}`,
					timestamp: `2025-01-01T00:00:0${index}Z`,
					cwd: "/tmp",
					title: `Recent Session ${index}`,
				})}\n`,
			);
		}

		const sessions = await getRecentSessions(tempDir);

		expect(sessions).toHaveLength(5);
		expect(sessions.map(session => session.name)).toContain("Recent Session 4");
	});
});

describe("resolveResumableSession", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(fileName: string, headerCwd: string, id: string = Snowflake.next()): string {
		const filePath = path.join(sessionDir, fileName);
		fs.writeFileSync(
			filePath,
			`${[
				JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: headerCwd }),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		return id;
	}

	it("returns undefined when no local session matches", async () => {
		writeSession("2025-01-01_demo.jsonl", "/tmp/project", "demo1234");

		const match = await resolveResumableSession("missing", "/tmp/project", sessionDir);

		expect(match).toBeUndefined();
	});

	it("matches by session id prefix", async () => {
		const id = writeSession("2025-01-01_resume.jsonl", "/tmp/project", "resume1234");

		const match = await resolveResumableSession(id.slice(0, 6), "/tmp/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.id).toBe(id);
	});

	it("matches legacy timestamped filename prefixes and id suffixes", async () => {
		writeSession("2025-02-03T04-05-06-789Z_legacyabcd.jsonl", "/tmp/project", "legacyabcd");

		const byFilePrefix = await resolveResumableSession("2025-02-03T04-05", "/tmp/project", sessionDir);
		expect(byFilePrefix?.session.id).toBe("legacyabcd");

		const byFileSuffix = await resolveResumableSession("legacy", "/tmp/project", sessionDir);
		expect(byFileSuffix?.session.id).toBe("legacyabcd");
	});

	it("keeps local matches resumable when header cwd differs", async () => {
		writeSession("2025-01-01_moved.jsonl", "/Users/old-user/project", "moved1234");

		const match = await resolveResumableSession("moved", "/Users/new-user/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.path).toBe(path.join(sessionDir, "2025-01-01_moved.jsonl"));
	});
});

describe("SessionManager temp cwd session dirs", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

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

	function toLegacyAbsoluteSessionDirName(cwd: string): string {
		return `--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
	}

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-dir-test-"));
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	it("stores symlink-equivalent home cwd sessions in the v2 resolver directory", () => {
		if (process.platform === "win32") return;

		const projectsRoot = path.join(os.homedir(), "Projects");
		fs.mkdirSync(projectsRoot, { recursive: true });
		const realProjectDir = fs.mkdtempSync(path.join(projectsRoot, "gjc-session-home-"));
		const nestedDir = path.join(realProjectDir, "nested");
		const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-home-alias-"));
		const homeAlias = path.join(aliasRoot, "home-link");

		try {
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.symlinkSync(os.homedir(), homeAlias, "dir");

			const aliasedCwd = path.join(homeAlias, "Projects", path.basename(realProjectDir), "nested");
			const session = SessionManager.create(aliasedCwd);
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file path");

			const expectedDir = path.join(getSessionsDir(), managedDirectoryName(aliasedCwd));
			expect(path.dirname(sessionFile)).toBe(expectedDir);
		} finally {
			fs.rmSync(aliasRoot, { recursive: true, force: true });
			fs.rmSync(realProjectDir, { recursive: true, force: true });
		}
	});

	it("stores temp-root cwd sessions in the v2 resolver directory", () => {
		const tempCwd = path.join(testAgentDir, `temp-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		expect(path.dirname(sessionFile)).toBe(path.join(getSessionsDir(), managedDirectoryName(tempCwd)));
	});

	it("retains validated legacy temp-root sessions beside the v2 resolver directory", () => {
		const tempCwd = path.join(testAgentDir, `legacy-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });
		const sessionsRoot = getSessionsDir();
		const legacyDir = path.join(sessionsRoot, toLegacyAbsoluteSessionDirName(tempCwd));
		const legacyFile = path.join(legacyDir, "carried.jsonl");
		const legacyTranscript = `${JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempCwd })}\n`;
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(legacyFile, legacyTranscript);

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		expect(path.dirname(sessionFile)).toBe(path.join(sessionsRoot, managedDirectoryName(tempCwd)));
		expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacyTranscript);
		const resolved = resolveManagedScope({ cwd: tempCwd, agentDir: testAgentDir, sessionsRoot });
		if (resolved.kind !== "resolved") throw new Error(resolved.message);
		const candidates = listManagedCandidates(resolved.scope);
		if (candidates.kind !== "complete") throw new Error(candidates.message);
		expect(candidates.owned).toContainEqual(
			expect.objectContaining({ path: legacyFile, provenance: "legacy", sessionId: "legacy-session" }),
		);
	});

	it("keeps valid managed sessions visible when adjacent candidates are invalid", async () => {
		const cwd = path.join(testAgentDir, `picker-cwd-${Snowflake.next()}`);
		fs.mkdirSync(cwd, { recursive: true });
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		const validPath = path.join(sessionDir, "valid.jsonl");
		fs.writeFileSync(
			validPath,
			`${JSON.stringify({ type: "session", id: "valid-session", timestamp: "2025-01-01T00:00:00Z", cwd })}\n`,
		);
		fs.writeFileSync(path.join(sessionDir, "invalid.jsonl"), "not json\n");

		const sessions = await SessionManager.listForResumePickerReadOnly(cwd);

		expect(sessions.map(session => session.path)).toContain(validPath);
	});

	it("follows a stale legacy breadcrumb by session identity instead of the newest candidate", async () => {
		const cwd = path.join(testAgentDir, `breadcrumb-cwd-${Snowflake.next()}`);
		fs.mkdirSync(cwd, { recursive: true });
		const sessionsRoot = getSessionsDir();
		const legacyDir = path.join(sessionsRoot, toLegacyAbsoluteSessionDirName(cwd));
		const legacyFile = path.join(legacyDir, "intended.jsonl");
		const intendedId = "intended-session";
		const writeSession = (file: string, id: string): void => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: "2025-01-01T00:00:00Z", cwd })}\n${JSON.stringify({ type: "message", id: "message", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: id, timestamp: 1 } })}\n`,
			);
		};
		writeSession(legacyFile, intendedId);
		const migratedFile = path.join(SessionManager.getDefaultSessionDir(cwd), "intended.jsonl");
		writeSession(migratedFile, intendedId);
		fs.unlinkSync(legacyFile);
		const newestFile = path.join(SessionManager.getDefaultSessionDir(cwd), "newest.jsonl");
		writeSession(newestFile, "newest-session");
		const previousTmux = process.env.TMUX;
		const previousPane = process.env.TMUX_PANE;
		process.env.TMUX = "/tmp/fake,1,0";
		process.env.TMUX_PANE = `%breadcrumb-${Snowflake.next()}`;
		try {
			fs.mkdirSync(getTerminalSessionsDir(), { recursive: true });
			fs.writeFileSync(
				path.join(getTerminalSessionsDir(), `tmux-${process.env.TMUX_PANE}`),
				`${cwd}\n${legacyFile}\n`,
			);
			const resumed = await SessionManager.continueRecent(cwd);
			try {
				expect(resumed.getSessionId()).toBe(intendedId);
			} finally {
				await resumed.close();
			}
		} finally {
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
			if (previousPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = previousPane;
		}
	});
});

describe("SessionManager legacy session migration persistence", () => {
	let tempDir: string;

	function makeAssistantMessage() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "legacy reply" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function getHeader(entries: FileEntry[]): SessionHeader | undefined {
		return entries.find((entry): entry is SessionHeader => entry.type === "session");
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-manager-legacy-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps legacy migration in memory until later persisted activity rewrites the file", async () => {
		const sessionFile = path.join(tempDir, "legacy.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:02Z",
					message: makeAssistantMessage(),
				}),
			].join("\n")}\n`,
		);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		const migratedEntries = session.getEntries();

		expect(migratedEntries).toHaveLength(2);
		for (const entry of migratedEntries) {
			expect(entry.id).toBeDefined();
		}
		expect(migratedEntries[0]?.parentId).toBeNull();
		expect(migratedEntries[1]?.parentId).toBe(migratedEntries[0]?.id);

		await new Promise(resolve => setTimeout(resolve, 20));
		await session.flush();
		expect(fs.statSync(sessionFile).mtimeMs).toBe(initialMtimeMs);

		await new Promise(resolve => setTimeout(resolve, 20));
		session.appendMessage({ role: "user", content: "follow up", timestamp: Date.now() });
		await session.flush();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(4);
		for (const entry of persistedEntries.filter(entry => entry.type !== "session")) {
			expect(entry.id).toBeDefined();
		}
	});

	it("still rewrites immediately when explicitly requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-rewrite.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await new Promise(resolve => setTimeout(resolve, 20));
		await session.rewriteEntries();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});

	it("forces a deferred legacy rewrite when ensureOnDisk is requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-ensure-on-disk.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await new Promise(resolve => setTimeout(resolve, 20));
		await session.ensureOnDisk();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});
	it("keeps the last non-empty session resumable after starting a fresh session", async () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() - 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const previousSessionFile = session.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected persisted session file");

		const freshSessionFile = await session.newSession();
		expect(freshSessionFile).toBeDefined();
		expect(fs.existsSync(freshSessionFile!)).toBe(false);

		const resumed = await SessionManager.continueRecent(tempDir, tempDir);
		try {
			expect(resumed.getSessionFile()).toBe(previousSessionFile);
		} finally {
			await resumed.close();
			await session.close();
		}
	});
});

describe("non-file session storage directory boundaries", () => {
	it("rejects default managed directories while allowing an explicit backend-owned directory", async () => {
		const storage = new MemorySessionStorage();
		expect(() => SessionManager.create("/workspace", undefined, storage)).toThrow(SessionManagedStorageError);
		await expect(SessionManager.continueRecent("/workspace", undefined, storage)).rejects.toThrow(
			SessionManagedStorageError,
		);

		const created = SessionManager.create("/workspace", "/backend/sessions", storage);
		const sessionFile = created.getSessionFile();
		if (!sessionFile) throw new Error("Expected explicit backend session file");
		await created.close();
		storage.writeTextSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: created.getSessionId(), timestamp: new Date().toISOString(), cwd: "/workspace" })}\n`,
		);
		const opened = await SessionManager.open(sessionFile, "/backend/sessions", storage);
		expect(opened.getSessionFile()).toBe(sessionFile);
	});
});
