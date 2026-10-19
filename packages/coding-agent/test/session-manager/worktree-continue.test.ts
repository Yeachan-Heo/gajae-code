import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, SessionMigrationPolicyError } from "@gajae-code/coding-agent/session/session-manager";
import { getSessionsDir, getTerminalSessionsDir, Snowflake, setAgentDir } from "@gajae-code/utils";

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "test");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

function writeSession(cwd: string, sessionId: string): string {
	const sessionDir = SessionManager.getDefaultSessionDir(cwd);
	fs.mkdirSync(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
	const header = { type: "session", id: sessionId, timestamp: "2025-01-01T00:00:00Z", cwd, version: 3 };
	const message = {
		type: "message",
		id: "1",
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: "hi", timestamp: 1 },
	};
	fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
	return sessionFile;
}

function writeBreadcrumb(crumbCwd: string, sessionFile: string): void {
	const dir = getTerminalSessionsDir();
	fs.mkdirSync(dir, { recursive: true });
	const terminalId = `tmux-${process.env.TMUX_PANE}`;
	fs.writeFileSync(path.join(dir, terminalId), `${crumbCwd}\n${sessionFile}\n`);
}

describe("continueRecent with --worktree sessions", () => {
	let root: string;
	let repo: string;
	let worktree: string;
	const prevTmux = process.env.TMUX;
	const prevPane = process.env.TMUX_PANE;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-continue-")));
		setAgentDir(path.join(root, "agent"));
		repo = path.join(root, "repo");
		initRepo(repo);
		worktree = path.join(root, "repo-worktrees", "feat");
		git(repo, "worktree", "add", "-q", "-b", "feat", worktree, "HEAD");
		process.env.TMUX = "/tmp/fake,1,0";
		process.env.TMUX_PANE = `%wt-${Snowflake.next()}`;
	});

	afterEach(() => {
		if (prevTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = prevTmux;
		if (prevPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = prevPane;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("resumes a worktree session from the main checkout and adopts its cwd", async () => {
		const sessionFile = writeSession(worktree, "worktree-session");
		// Breadcrumb cwd is the linked worktree; `--continue` runs from the main repo.
		writeBreadcrumb(worktree, sessionFile);

		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionFile()).toBe(sessionFile);
			// The HUD/branch and the agent's tools read getCwd(); it must be the
			// worktree, not the main checkout where `--continue` was invoked.
			expect(path.resolve(resumed.getCwd())).toBe(path.resolve(worktree));
		} finally {
			await resumed.close();
		}
	});

	it("ignores a breadcrumb that points to an unrelated repository", async () => {
		const other = path.join(root, "other");
		initRepo(other);
		const sessionFile = writeSession(other, "other-session");
		writeBreadcrumb(other, sessionFile);

		// Continuing from `repo` must not hijack an unrelated project's session.
		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionFile()).not.toBe(sessionFile);
		} finally {
			await resumed.close();
		}
	});

	it("resumes an owned breadcrumb and ignores a session file outside the sessions root", async () => {
		const ownedFile = writeSession(repo, "owned-session");
		writeBreadcrumb(repo, ownedFile);
		const owned = await SessionManager.continueRecent(repo);
		try {
			expect(owned.getSessionFile()).toBe(ownedFile);
			expect(owned.getSessionId()).toBe("owned-session");
		} finally {
			await owned.close();
		}

		const outsideDir = path.join(root, "outside-sessions");
		const outsideFile = path.join(outsideDir, "outside.jsonl");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(
			outsideFile,
			`${JSON.stringify({ type: "session", id: "outside-session", timestamp: "2025-01-01T00:00:00Z", cwd: repo, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "outside", timestamp: 1 } })}\n`,
		);
		const before = fs.readFileSync(outsideFile, "utf8");
		writeBreadcrumb(repo, outsideFile);

		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionId()).toBe("owned-session");
			expect(resumed.getSessionFile()).toBe(ownedFile);
			expect(resumed.getSessionFile()).not.toBe(outsideFile);
			expect(fs.readFileSync(outsideFile, "utf8")).toBe(before);
		} finally {
			await resumed.close();
		}
	});

	it("does not adopt a linked-worktree breadcrumb whose session file is outside the sessions root", async () => {
		const unmanagedDir = path.join(root, "unmanaged-sessions");
		const unmanagedFile = path.join(unmanagedDir, "unmanaged.jsonl");
		fs.mkdirSync(unmanagedDir, { recursive: true });
		fs.writeFileSync(
			unmanagedFile,
			`${JSON.stringify({ type: "session", id: "unmanaged", timestamp: "2025-01-01T00:00:00Z", cwd: worktree, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "unmanaged", timestamp: 1 } })}\n`,
		);
		writeBreadcrumb(worktree, unmanagedFile);
		const before = fs.readFileSync(unmanagedFile, "utf8");

		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionFile()).not.toBe(unmanagedFile);
			expect(resumed.getSessionId()).not.toBe("unmanaged");
			expect(fs.readFileSync(unmanagedFile, "utf8")).toBe(before);
			expect(fs.existsSync(path.join(SessionManager.getDefaultSessionDir(worktree), "unmanaged.jsonl"))).toBe(false);
		} finally {
			await resumed.close();
		}
	});

	it("keeps an older explicit-directory breadcrumb ahead of a newer sibling", async () => {
		const explicitDir = path.join(root, "explicit-sessions");
		const older = path.join(explicitDir, "older.jsonl");
		const newer = path.join(explicitDir, "newer.jsonl");
		fs.mkdirSync(explicitDir, { recursive: true });
		const writeExplicit = (file: string, id: string): void => {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: repo, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: id, timestamp: 1 } })}\n`,
			);
		};
		writeExplicit(older, "older-session");
		writeExplicit(newer, "newer-session");
		const olderTime = new Date("2020-01-01T00:00:00Z");
		const newerTime = new Date("2024-06-01T00:00:00Z");
		fs.utimesSync(older, olderTime, olderTime);
		fs.utimesSync(newer, newerTime, newerTime);
		expect(fs.statSync(newer).mtimeMs).toBeGreaterThan(fs.statSync(older).mtimeMs);
		writeBreadcrumb(repo, older);

		const resumed = await SessionManager.continueRecent(repo, SessionManager.explicitDestination(explicitDir));
		try {
			expect(resumed.getSessionId()).toBe("older-session");
			expect(path.resolve(resumed.getSessionFile() ?? "")).toBe(path.resolve(older));
		} finally {
			await resumed.close();
		}
	});

	it("uses a custom managed root for breadcrumbs ahead of newer siblings", async () => {
		const customAgentDir = path.join(root, "custom-agent");
		const destination = SessionManager.managedDestination(repo, customAgentDir);
		const createSession = async (content: string, timestamp: number) => {
			const manager = SessionManager.create(repo, destination);
			try {
				manager.appendMessage({ role: "user", content, timestamp });
				await manager.ensureOnDisk();
				await manager.flush();
				const file = manager.getSessionFile();
				if (!file) throw new Error("Expected managed session file");
				return { file, id: manager.getSessionId() };
			} finally {
				await manager.close();
			}
		};

		const older = await createSession("breadcrumb target", 1);
		const oldTime = new Date("2020-01-01T00:00:00Z");
		fs.utimesSync(older.file, oldTime, oldTime);
		const newer = await createSession("newer sibling", 2);
		expect(fs.statSync(newer.file).mtimeMs).toBeGreaterThan(fs.statSync(older.file).mtimeMs);
		writeBreadcrumb(repo, older.file);

		const resumed = await SessionManager.continueRecent(repo, destination);
		try {
			expect(resumed.getSessionFile()).toBe(older.file);
			expect(resumed.getSessionId()).toBe(older.id);
		} finally {
			await resumed.close();
		}
	});

	it("resumes an older project-local breadcrumb ahead of a newer sibling", async () => {
		const projectDir = path.join(repo, ".gjc", "sessions");
		fs.mkdirSync(projectDir, { recursive: true });
		const older = path.join(projectDir, "older-project.jsonl");
		const newer = path.join(projectDir, "newer-project.jsonl");
		const writeProject = (file: string, id: string): void => {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: repo, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: id, timestamp: 1 } })}\n`,
			);
		};
		writeProject(older, "older-project-session");
		writeProject(newer, "newer-project-session");
		const olderTime = new Date("2020-01-01T00:00:00Z");
		const newerTime = new Date("2024-06-01T00:00:00Z");
		fs.utimesSync(older, olderTime, olderTime);
		fs.utimesSync(newer, newerTime, newerTime);
		expect(fs.statSync(newer).mtimeMs).toBeGreaterThan(fs.statSync(older).mtimeMs);
		const listed = await SessionManager.listManagedForResumePickerReadOnly(repo);
		expect(listed.map(session => session.id)).toEqual(["newer-project-session", "older-project-session"]);
		const newerBefore = fs.readFileSync(newer, "utf8");
		writeBreadcrumb(repo, older);

		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionId()).toBe("older-project-session");
			expect(path.resolve(resumed.getSessionFile() ?? "")).toBe(path.resolve(older));
			expect(fs.readFileSync(newer, "utf8")).toBe(newerBefore);
		} finally {
			await resumed.close();
		}
	});

	it("does not resume a breadcrumb outside an explicit session directory", async () => {
		const explicitDir = path.join(root, "explicit-sessions-contained");
		const inside = path.join(explicitDir, "inside.jsonl");
		const outsideDir = path.join(root, "outside-explicit");
		const outside = path.join(outsideDir, "outside.jsonl");
		fs.mkdirSync(explicitDir, { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });
		const writeExplicit = (file: string, id: string): void => {
			fs.writeFileSync(
				file,
				`${JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: repo, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: id, timestamp: 1 } })}\n`,
			);
		};
		writeExplicit(inside, "inside-session");
		writeExplicit(outside, "outside-explicit-session");
		const before = fs.readFileSync(outside, "utf8");
		writeBreadcrumb(repo, outside);

		const resumed = await SessionManager.continueRecent(repo, SessionManager.explicitDestination(explicitDir));
		try {
			expect(resumed.getSessionId()).not.toBe("outside-explicit-session");
			expect(path.resolve(resumed.getSessionFile() ?? "")).not.toBe(path.resolve(outside));
			expect(fs.readFileSync(outside, "utf8")).toBe(before);
		} finally {
			await resumed.close();
		}
	});

	it("refuses a legacy breadcrumb when migration is disabled instead of creating a fresh session", async () => {
		const legacyDir = path.join(
			getSessionsDir(),
			`--${path
				.resolve(worktree)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`,
		);
		const sessionFile = path.join(legacyDir, "legacy-worktree.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "legacy-worktree", timestamp: "2025-01-01T00:00:00Z", cwd: worktree, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } })}\n`,
		);
		writeBreadcrumb(worktree, sessionFile);

		const before = fs.readFileSync(sessionFile, "utf8");
		await expect(SessionManager.continueRecent(repo, undefined, undefined, "disabled")).rejects.toBeInstanceOf(
			SessionMigrationPolicyError,
		);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
		expect(fs.existsSync(path.join(SessionManager.getDefaultSessionDir(worktree), path.basename(sessionFile)))).toBe(
			false,
		);

		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionFile()).toBe(
				path.join(SessionManager.getDefaultSessionDir(worktree), path.basename(sessionFile)),
			);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
		} finally {
			await resumed.close();
		}
	});
});
