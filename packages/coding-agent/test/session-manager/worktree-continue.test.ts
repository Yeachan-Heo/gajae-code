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

	it("keeps a verified explicit-directory breadcrumb terminal-specific", async () => {
		const unmanagedDir = path.join(root, "unmanaged-sessions");
		const unmanagedFile = path.join(unmanagedDir, "unmanaged.jsonl");
		fs.mkdirSync(unmanagedDir, { recursive: true });
		fs.writeFileSync(
			unmanagedFile,
			`${JSON.stringify({ type: "session", id: "unmanaged", timestamp: "2025-01-01T00:00:00Z", cwd: worktree, version: 3 })}\n${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "unmanaged", timestamp: 1 } })}\n`,
		);
		writeBreadcrumb(worktree, unmanagedFile);

		writeSession(worktree, "managed-worktree-session");
		const resumed = await SessionManager.continueRecent(repo);
		try {
			expect(resumed.getSessionFile()).toBe(unmanagedFile);
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
