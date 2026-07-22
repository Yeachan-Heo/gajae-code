import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";

const roots: string[] = [];
const agentDirs: string[] = [];
const tmuxFixtures: TmuxFixture[] = [];

interface TmuxFixture {
	dir: string;
	socket: string;
	command: string;
}

function commandWorks(command: string, args: string[]): boolean {
	const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0;
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

const unsupportedPrerequisite =
	process.platform === "win32"
		? "requires a POSIX tmux server"
		: Bun.which("git") === null || !commandWorks("git", ["--version"])
			? "requires a working git executable"
			: Bun.which("tmux") === null || !commandWorks("tmux", ["-V"])
				? "requires a working tmux executable"
				: null;

function createTmuxFixture(): TmuxFixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-worktree-tmux-"));
	const socket = path.join(dir, "server.sock");
	const command = path.join(dir, "tmux-fixture");
	fs.writeFileSync(command, `#!/bin/sh\nexec tmux -S '${socket}' "$@"\n`, { mode: 0o700 });
	const fixture = { dir, socket, command };
	tmuxFixtures.push(fixture);
	return fixture;
}

function tmux(fixture: TmuxFixture, args: string[]): string {
	const result = Bun.spawnSync(["tmux", "-S", fixture.socket, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function tmuxSessionNames(fixture: TmuxFixture): string[] {
	const result = Bun.spawnSync(["tmux", "-S", fixture.socket, "list-sessions", "-F", "#{session_name}"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return [];
	return result.stdout
		.toString()
		.split("\n")
		.map(name => name.trim())
		.filter(Boolean);
}

function tmuxOption(fixture: TmuxFixture, session: string, option: string): string {
	return tmux(fixture, ["show-options", "-v", "-t", session, option]);
}

function optionalTmuxOption(fixture: TmuxFixture, session: string, option: string): string | undefined {
	const result = Bun.spawnSync(["tmux", "-S", fixture.socket, "show-options", "-v", "-t", session, option], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

function fixtureSettings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:test-token",
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function createRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-worktree-e2e-"));
	roots.push(repo);
	git(["init"], repo);
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "Test User"], repo);
	fs.writeFileSync(path.join(repo, "tracked-sentinel.txt"), "primary\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), ".gjc/\n");
	git(["add", "tracked-sentinel.txt", ".gitignore"], repo);
	git(["commit", "-m", "initial"], repo);
	return repo;
}

afterEach(() => {
	for (const fixture of tmuxFixtures.splice(0)) {
		Bun.spawnSync(["tmux", "-S", fixture.socket, "kill-server"]);
		fs.rmSync(fixture.dir, { recursive: true, force: true });
	}
	for (const repo of roots.splice(0)) {
		const worktreeRoot = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		for (const line of git(["worktree", "list", "--porcelain"], repo).split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const candidate = line.slice("worktree ".length);
			if (candidate !== repo) Bun.spawnSync(["git", "worktree", "remove", "--force", candidate], { cwd: repo });
		}
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(worktreeRoot, { recursive: true, force: true });
	}
	for (const agentDir of agentDirs.splice(0)) fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("Telegram /session_create worktree isolation", () => {
	(unsupportedPrerequisite ? test.skip : test)(
		"dispatches the exact command into a disposable named worktree without changing the primary checkout",
		async () => {
			const repo = createRepo();
			const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-worktree-agent-"));
			const tmuxFixture = createTmuxFixture();
			agentDirs.push(agentDir);
			const pathShadow = path.join(agentDir, "gjc");
			const pathShadowSentinel = path.join(agentDir, "path-shadow-invoked");
			fs.writeFileSync(pathShadow, '#!/bin/sh\n: > "$GJC_PATH_SHADOW_SENTINEL"\nexit 97\n', { mode: 0o700 });
			const primary = {
				topLevel: git(["rev-parse", "--show-toplevel"], repo),
				head: git(["rev-parse", "HEAD"], repo),
				branch: git(["branch", "--show-current"], repo),
				index: fs.readFileSync(path.join(repo, ".git", "index")),
				status: git(["status", "--porcelain=v1"], repo),
				sentinel: fs.readFileSync(path.join(repo, "tracked-sentinel.txt"), "utf8"),
			};
			const calls: { method: string; body: Record<string, unknown> | null }[] = [];
			const daemon = new TelegramNotificationDaemon({
				settings: fixtureSettings(agentDir),
				ownerId: "telegram-worktree-e2e",
				botToken: "123456:test-token",
				chatId: "42",
				botApi: {
					call: async (method: string, body: Record<string, unknown> | null) => {
						calls.push({ method, body });
						if (method === "getChat") return { ok: true, result: { id: body?.chat_id, type: "private" } };
						return { ok: true, result: [] };
					},
				} as never,
			});
			const lifecycleControl = daemon as unknown as {
				startLifecycleControl: () => Promise<boolean>;
				stopLifecycleControl: () => void;
			};
			const previousTmuxCommand = process.env.GJC_TMUX_COMMAND;
			const previousPath = process.env.PATH;
			const previousPathShadowSentinel = process.env.GJC_PATH_SHADOW_SENTINEL;
			process.env.PATH = `${agentDir}${path.delimiter}${previousPath ?? ""}`;
			process.env.GJC_PATH_SHADOW_SENTINEL = pathShadowSentinel;
			process.env.GJC_TMUX_COMMAND = tmuxFixture.command;
			try {
				expect(await lifecycleControl.startLifecycleControl()).toBe(true);
				await daemon.handleTelegramUpdate({
					update_id: 71,
					message: {
						chat: { id: "42", type: "private" },
						message_id: 71,
						text: `/session_create worktree ${repo} fix-telegram-close`,
					},
				});

				const createdTmuxSessions = tmuxSessionNames(tmuxFixture);
				expect(createdTmuxSessions).toHaveLength(1);
				const tmuxSession = createdTmuxSessions[0]!;
				const sessionId = tmuxOption(tmuxFixture, tmuxSession, "@gjc-session-id");
				const sessionStateFile = tmuxOption(tmuxFixture, tmuxSession, "@gjc-session-state-file");
				expect(sessionId).toMatch(/^s[0-9a-f]{12}$/);
				const lifecycleDir = path.join(path.dirname(sessionStateFile), sessionId, "owner-lifecycle");

				const worktreeRoot = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
				let worktree: string | undefined;
				for (let attempt = 0; attempt < 100 && worktree === undefined; attempt++) {
					worktree = git(["worktree", "list", "--porcelain"], repo)
						.split("\n")
						.find(line => line.startsWith("worktree ") && line.includes(worktreeRoot))
						?.slice("worktree ".length);
					if (worktree === undefined) await Bun.sleep(50);
				}
				if (worktree === undefined) {
					const pane = tmux(tmuxFixture, ["capture-pane", "-p", "-t", tmuxSession]);
					const paneCommand = tmux(tmuxFixture, [
						"list-panes",
						"-t",
						tmuxSession,
						"-F",
						"#{pane_pid} #{pane_start_command}",
					]);
					const bindings = fs
						.readdirSync(lifecycleDir, { recursive: true })
						.filter(entry => String(entry).endsWith(".binding.json"))
						.map(entry => fs.readFileSync(path.join(lifecycleDir, String(entry)), "utf8"));
					throw new Error(
						`linked worktree was not created\ncommand=${paneCommand}\nbindings=${bindings.join("\n")}\n${pane}`,
					);
				}
				expect(git(["rev-parse", "--show-toplevel"], worktree)).toBe(worktree);
				expect(git(["branch", "--show-current"], worktree)).toBe("fix-telegram-close");
				expect(worktree).not.toBe(repo);
				expect(fs.statSync(worktree).isDirectory()).toBe(true);
				expect(fs.existsSync(path.join(repo, "fix-telegram-close"))).toBe(false);
				let projectMetadata: string | undefined;
				let branchMetadata: string | undefined;
				for (let attempt = 0; attempt < 100; attempt++) {
					projectMetadata = optionalTmuxOption(tmuxFixture, tmuxSession, "@gjc-project");
					branchMetadata = optionalTmuxOption(tmuxFixture, tmuxSession, "@gjc-branch");
					if (projectMetadata === worktree && branchMetadata === "fix-telegram-close") break;
					await Bun.sleep(50);
				}
				expect(projectMetadata).toBe(worktree);
				expect(branchMetadata).toBe("fix-telegram-close");
				const bindingFiles = fs
					.readdirSync(lifecycleDir, { recursive: true })
					.filter(entry => String(entry).endsWith(".binding.json"));
				expect(bindingFiles).toHaveLength(1);
				const binding = JSON.parse(fs.readFileSync(path.join(lifecycleDir, String(bindingFiles[0])), "utf8")) as {
					command?: string[];
				};
				expect(binding.command).toEqual([
					process.execPath,
					path.resolve(import.meta.dir, "../bin/gjc.js"),
					"--worktree=fix-telegram-close",
				]);
				expect(fs.existsSync(pathShadowSentinel)).toBe(false);

				const gjcRoot = path.join(repo, ".gjc");
				expect(sessionStateFile.startsWith(`${gjcRoot}${path.sep}`)).toBe(true);
				expect(git(["rev-parse", "--show-toplevel"], repo)).toBe(primary.topLevel);
				expect(git(["rev-parse", "HEAD"], repo)).toBe(primary.head);
				expect(git(["branch", "--show-current"], repo)).toBe(primary.branch);
				expect(fs.readFileSync(path.join(repo, ".git", "index"))).toEqual(primary.index);
				expect(git(["status", "--porcelain=v1"], repo)).toBe(primary.status);
				expect(fs.readFileSync(path.join(repo, "tracked-sentinel.txt"), "utf8")).toBe(primary.sentinel);
				expect(calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
				expect(String(calls.find(call => call.method === "sendMessage")?.body?.text)).toContain(sessionId);
			} finally {
				lifecycleControl.stopLifecycleControl();
				if (previousTmuxCommand === undefined) delete process.env.GJC_TMUX_COMMAND;
				else process.env.GJC_TMUX_COMMAND = previousTmuxCommand;
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
				if (previousPathShadowSentinel === undefined) delete process.env.GJC_PATH_SHADOW_SENTINEL;
				else process.env.GJC_PATH_SHADOW_SENTINEL = previousPathShadowSentinel;
			}
		},
		60_000,
	);
});
