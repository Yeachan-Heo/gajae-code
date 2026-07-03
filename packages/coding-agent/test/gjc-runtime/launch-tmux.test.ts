import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "@gajae-code/coding-agent";
import type { Args } from "@gajae-code/coding-agent/cli/args";
import {
	applyGjcTmuxProfile,
	buildDefaultTmuxLaunchPlan,
	buildGjcTmuxProfileCommands,
	buildGjcTmuxWindowTitle,
	GJC_TMUX_LAUNCHED_ENV,
	GJC_TMUX_SESSION_PREFIX,
	launchDefaultTmuxIfNeeded,
	type TmuxSpawnOptions,
} from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import { __setBinaryResolverForTests } from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import { sessionRuntimeDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

function args(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...overrides,
	};
}

const TEST_SESSION_ID = "test-session";
const interactiveTty = { stdin: true, stdout: true };
type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

let previousGjcSessionId: string | undefined;

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function stderrError(code: string): Error {
	const error = new Error(`${code} from stderr`);
	Object.defineProperty(error, "code", { value: code });
	return error;
}

describe("default GJC tmux launch", () => {
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
		vi.restoreAllMocks();
	});

	it("builds sanitized project and branch tmux window titles", () => {
		expect(buildGjcTmuxWindowTitle("/repo", "feature/demo")).toBe("GJC-repo-feature/demo");
		expect(buildGjcTmuxWindowTitle("/repo", "main")).toBe("GJC-repo-main");
		expect(buildGjcTmuxWindowTitle("/repo", null)).toBe("GJC-repo");
		expect(buildGjcTmuxWindowTitle("/repo", "")).toBe("GJC-repo");
	});

	it("replaces colon-bearing tmux window title segments", () => {
		expect(buildGjcTmuxWindowTitle("/repo:backend", "main")).toBe("GJC-repo-backend-main");
		expect(buildGjcTmuxWindowTitle("/repo", "release:main")).toBe("GJC-repo-release-main");
		expect(buildGjcTmuxWindowTitle("/repo", "feature:::demo")).toBe("GJC-repo-feature-demo");
	});

	it("truncates long tmux window titles to 48 visible columns while preserving the project and branch tail", () => {
		const title = buildGjcTmuxWindowTitle("/repo", `feature/${"a".repeat(80)}tail`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("GJC-repo-…")).toBe(true);
		expect(title.endsWith("tail")).toBe(true);
	});

	it("truncates wide-character tmux window titles by visible width while preserving the branch tail", () => {
		const title = buildGjcTmuxWindowTitle("/저장소", `feature/${"界".repeat(80)}끝`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("GJC-저장소-…")).toBe(true);
		expect(title.endsWith("끝")).toBe(true);
	});

	it("sanitizes dot-prefixed cwd basenames for tmux window titles", () => {
		expect(buildGjcTmuxWindowTitle("/tmp/.claude", null)).toBe("GJC-dot-claude");
		expect(buildGjcTmuxWindowTitle("/tmp/.claude", "feature/demo")).toBe("GJC-dot-claude-feature/demo");
		expect(buildGjcTmuxWindowTitle("/tmp/.claude", "repo:main")).toBe("GJC-dot-claude-repo-main");
		expect(buildGjcTmuxWindowTitle("/tmp/...", null)).toBe("GJC-gjc");
		expect(buildGjcTmuxWindowTitle("/tmp/...", "feature/demo")).toBe("GJC-gjc-feature/demo");
	});

	it("passes sanitized dot-prefixed cwd basenames to tmux rename-window", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/tmp/.claude",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.find(call => call.args[0] === "rename-window")?.args).toEqual([
			"rename-window",
			"-t",
			expect.stringMatching(/^=gajae_code_/),
			"--",
			"GJC-dot-claude",
		]);
	});

	it("configures the tmux client terminal title before managed attach", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const newSessionIndex = calls.findIndex(call => call.args[0] === "new-session");
		const titleIndex = calls.findIndex(call => call.args[3] === "set-titles-string");
		const attachIndex = calls.findIndex(call => call.args[0] === "attach-session");

		expect(newSessionIndex).toBeGreaterThanOrEqual(0);
		expect(titleIndex).toBeGreaterThan(newSessionIndex);
		expect(titleIndex).toBeLessThan(attachIndex);
		expect(calls[titleIndex]?.args).toEqual([
			"set-option",
			"-t",
			expect.stringMatching(/^=gajae_code_.*:$/),
			"set-titles-string",
			"GJC: repo-feature/demo",
		]);
		expect(calls.some(call => call.args[3] === "set-titles" && call.args[4] === "on")).toBe(true);
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("escapes tmux format markers in client terminal titles", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/#S/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.find(call => call.args[3] === "set-titles-string")?.args.at(-1)).toBe("GJC: repo-feature/##S/demo");
	});

	it("honors title opt-out while launching managed tmux", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true, noTitle: true }),
			rawArgs: ["--tmux", "--no-title", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args.includes("set-titles") || call.args.includes("set-titles-string"))).toBe(
			false,
		);
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("honors PI_NO_TITLE while launching managed tmux", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { PI_NO_TITLE: "1" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args.includes("set-titles") || call.args.includes("set-titles-string"))).toBe(
			false,
		);
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("passes prefixed tmux window titles after the tmux option separator", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/tmp/-repo",
			env: { TMUX: "/tmp/tmux" },
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls[0]?.args).toEqual(["rename-window", "--", "GJC--repo-feature/demo"]);
	});

	it("does not plan tmux for interactive root launch without --tmux", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeUndefined();
	});

	it("does not invoke tmux session listing when existing session lookup is injected", () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync");
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		// Only assert the session-listing command family. The psmux detection
		// probe may issue a one-time tmux 3.3 to detect the multiplexer and
		// that is intentionally out of scope for this test.
		const listSessionsCalls = spawnSyncSpy.mock.calls.filter(call => call[0]?.[1] === "list-sessions");
		expect(listSessionsCalls).toHaveLength(0);
	});

	it("plans an interactive --tmux root launch inside a new GJC tmux session", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.sessionName.startsWith(GJC_TMUX_SESSION_PREFIX)).toBe(true);
		expect(plan.tmuxCommand).toBe("tmux");
		expect(plan.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", plan.sessionName, "-c", "/repo"]);
		expect(plan?.innerCommand).toContain("'/bin/bun' '/repo/packages/coding-agent/src/cli.ts' 'hello world'");
		expect(plan?.innerCommand).not.toContain("'--tmux'");
		expect(plan.innerCommand).toContain("GJC_COORDINATOR_SESSION_ID=");
		expect(plan.innerCommand).toContain("GJC_COORDINATOR_SESSION_STATE_FILE=");
	});

	it("sizes detached tmux new-session to the caller terminal when dimensions are known", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: true, columns: 178, rows: 35 },
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.initialSize).toEqual({ columns: 178, rows: 35 });
		expect(plan.newSessionArgs.slice(0, 10)).toEqual([
			"new-session",
			"-d",
			"-x",
			"178",
			"-y",
			"35",
			"-s",
			plan.sessionName,
			"-c",
			"/repo",
		]);
	});

	it("reserves caller terminal rows for tmux status lines", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: true, columns: 178, rows: 35 },
			tmuxAvailable: true,
			tmuxStatusLines: 1,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.initialSize).toEqual({ columns: 178, rows: 34 });
		expect(plan.newSessionArgs.slice(0, 10)).toEqual([
			"new-session",
			"-d",
			"-x",
			"178",
			"-y",
			"34",
			"-s",
			plan.sessionName,
			"-c",
			"/repo",
		]);
	});

	it("omits detached tmux sizing when caller dimensions are unknown", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.initialSize).toBeUndefined();
		expect(plan.newSessionArgs).not.toContain("-x");
		expect(plan.newSessionArgs).not.toContain("-y");
		expect(plan.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", plan.sessionName, "-c", "/repo"]);
	});

	it("does not plan managed tmux from a non-tty root launch", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: false, columns: 178, rows: 35 },
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeUndefined();
	});

	it("reasserts caller dimensions before attaching a newly created managed tmux session", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: true, columns: 178, rows: 35 },
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			existingBranchSessionName: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const newSession = calls.find(call => call.args[0] === "new-session");
		const resizeIndex = calls.findIndex(call => call.args[0] === "resize-window");
		const attachIndex = calls.findIndex(call => call.args[0] === "attach-session");
		expect(newSession?.args).toContain("-x");
		expect(newSession?.args).toContain("178");
		expect(newSession?.args).toContain("-y");
		expect(newSession?.args).toContain("35");
		expect(resizeIndex).toBeGreaterThan(0);
		expect(resizeIndex).toBeLessThan(attachIndex);
		expect(calls[resizeIndex]?.args).toEqual([
			"resize-window",
			"-t",
			expect.stringMatching(/^=gajae_code_.*:$/),
			"-x",
			"178",
			"-y",
			"35",
		]);
	});

	it("plans native Windows --tmux launches when tmux is available", () => {
		// The historical direct-launch fallback only fires when no tmux binary
		// resolves on PATH. When psmux / tmux is available,
		// buildDefaultTmuxLaunchPlan returns a plan that bootstraps gjc through
		// PowerShell. Set tmuxAvailable: true here to mirror a host with psmux.
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "C:\\repo",
			env: {},
			argv: ["C:\\Program Files\\GJC\\gjc.exe"],
			execPath: "C:\\Program Files\\GJC\\gjc.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
	});

	it("uses a host command for compiled Bun virtual entrypoints", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["gjc", "/$bunfs/root/gjc-linux-x64"],
			execPath: "/home/me/.local/bin/gjc",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.innerCommand).not.toContain("$bunfs");
		expect(plan.innerCommand).toContain(`${GJC_TMUX_LAUNCHED_ENV}=1`);
		expect(plan.innerCommand).toContain("'/home/me/.local/bin/gjc' 'hello world'");
	});

	it("falls back to gjc when compiled Bun virtual entrypoint has no host exec path", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux"],
			cwd: "/repo",
			env: {},
			argv: ["gjc", "/$bunfs/root/gjc-linux-x64"],
			execPath: "/$bunfs/root/gjc-linux-x64",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan?.innerCommand).not.toContain("$bunfs");
		expect(plan?.innerCommand).toContain("'gjc'");
	});

	it("does not implicitly attach existing tagged session for plain worktree branch launch", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "gajae_code_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session" && call.args[2] === "=gajae_code_feature")).toBe(
			false,
		);
	});

	it("explicit continue attaches existing tagged session for matching worktree branch", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true, continue: true }),
			rawArgs: ["--tmux", "--continue", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "gajae_code_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(false);
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "=gajae_code_feature"]);
	});

	it("uses bare session targets for psmux attach paths", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		try {
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello world"], tmux: true, continue: true }),
				rawArgs: ["--tmux", "--continue", "hello world"],
				cwd: "/repo",
				env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
				argv: ["bun", "packages/coding-agent/src/cli.ts"],
				execPath: "/bin/bun",
				platform: "win32",
				tty: interactiveTty,
				tmuxAvailable: true,
				worktreeBranch: "feature/demo",
				existingBranchSessionName: "gajae_code_feature",
				spawnSync: (command, spawnArgs, options) => {
					calls.push({ command, args: spawnArgs, options });
					return { exitCode: 0 };
				},
			});

			expect(handled).toBe(true);
			expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "gajae_code_feature"]);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("value-less resume launches inner picker instead of attaching an existing tagged session", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true, resume: true }),
			rawArgs: ["--tmux", "--resume"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "gajae_code_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session" && call.args[2] === "=gajae_code_feature")).toBe(
			false,
		);
		expect(calls.find(call => call.args[0] === "new-session")?.args.at(-1)).toContain("--resume");
	});

	it("targeted resume launches inner session resolver instead of branch tmux attach", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ tmux: true, resume: "abc123" }),
			rawArgs: ["--tmux", "--resume", "abc123"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "gajae_code_feature",
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.innerCommand).toContain("--resume");
		expect(plan?.innerCommand).toContain("abc123");
	});

	it("falls through to a fresh session when existing tagged session attach fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true, continue: true }),
			rawArgs: ["--tmux", "--continue", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "gajae_code_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session" && spawnArgs[2] === "=gajae_code_feature") return { exitCode: 1 };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.find(call => call.args[0] === "attach-session")?.args).toEqual([
			"attach-session",
			"-t",
			"=gajae_code_feature",
		]);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session" && call.args[2] !== "=gajae_code_feature")).toBe(
			true,
		);
	});

	it("does not reuse same-branch sessions from another project", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo-b/worktree",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			project: "/repo-b",
			existingBranchSessionName: null,
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.branch).toBe("feature/demo");
		expect(plan?.project).toBe("/repo-b");
	});

	it("honors an explicit GJC_TMUX_SESSION override", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(0, "custom-gjc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo"),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { GJC_TMUX_SESSION: "custom-gjc" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
		});

		expect(plan?.sessionName).toBe("custom-gjc");
		expect(plan?.attachSessionName).toBe("custom-gjc");
		expect(plan?.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", "custom-gjc", "-c", "/repo"]);
	});

	it("honors explicit GJC_TMUX_COMMAND on native Windows without direct-launch fallback", () => {
		// Once psmux is a supported Windows multiplexer, an explicit
		// GJC_TMUX_COMMAND override must always produce a tmux plan. The
		// legacy direct-launch fallback only fires when no tmux provider is
		// resolvable on PATH; the user has named a multiplexer here so the
		// buildDefaultTmuxLaunchPlan path is authoritative. Runtime failures
		// surface through the normal spawn-failure diagnostics instead of a
		// silent direct launch.
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "C:\\repo",
			env: { GJC_TMUX_COMMAND: "psmux" },
			argv: ["C:\\Program Files\\GJC\\gjc.exe"],
			execPath: "C:\\Program Files\\GJC\\gjc.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
	});
	it("does not auto-reuse scoped sessions from another GJC version", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				"old-gjc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\told-session\t/state\t0.0.0",
			),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo",
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.newSessionArgs.slice(0, 2)).toEqual(["new-session", "-d"]);
	});

	it("does not auto-reuse scoped sessions from the current GJC version without explicit resume", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				`current-gjc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\tcurrent-session\t/state\t${VERSION}`,
			),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo",
		});

		expect(plan?.attachSessionName).toBeUndefined();
	});

	it("auto-reuses scoped sessions from the current GJC version for explicit continue", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				`current-gjc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\tcurrent-session\t/state\t${VERSION}`,
			),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true, continue: true }),
			rawArgs: ["--tmux", "--continue", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo",
		});

		expect(plan?.attachSessionName).toBe("current-gjc");
	});

	it("does not reuse a same-branch session from another worktree path in the same project", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo/worktree-b",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo/worktree-b",
			existingBranchSessionName: null,
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.branch).toBe("feature/demo");
		expect(plan?.project).toBe("/repo/worktree-b");
	});

	it("cleans up a newly created managed session when attach fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const stdout = process.stdout as typeof process.stdout & { isTTY?: boolean };
		const previousIsTTY = stdout.isTTY;
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		stdout.isTTY = true;

		try {
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ tmux: true }),
				rawArgs: [],
				cwd: "/repo",
				env: {},
				argv: ["/usr/local/bin/gjc"],
				execPath: "/bin/bun",
				platform: "darwin",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				existingBranchSessionName: null,
				diagnosticWriter: message => diagnostics.push(message),
				spawnSync: (command, spawnArgs, options) => {
					calls.push({ command, args: spawnArgs, options });
					if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
					return { exitCode: 0 };
				},
			});

			expect(handled).toBe(true);
			expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
			expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
			expect(calls.some(call => call.args[0] === "kill-session")).toBe(true);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
		} finally {
			stdout.isTTY = previousIsTTY;
		}
	});

	it("builds a session-scoped tmux profile without global tmux mutation", () => {
		const commands = buildGjcTmuxProfileCommands("gjc-session:0", {});
		const args = commands.map(command => command.args);

		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "mouse", "on"]);
		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "@gjc-profile", "1"]);
		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "set-clipboard", "on"]);
		expect(args).toContainEqual([
			"set-window-option",
			"-t",
			"gjc-session:0",
			"mode-style",
			"fg=colour231,bg=colour60",
		]);
		expect(args.flat()).not.toContain("-g");
		expect(
			buildGjcTmuxProfileCommands("gjc-session:0", { GJC_TMUX_PROFILE: "false" }).map(command => command.args),
		).toEqual([["set-option", "-t", "gjc-session:0", "@gjc-profile", "1"]]);
		expect(
			buildGjcTmuxProfileCommands("gjc-session:0", { GJC_MOUSE: "off" }).flatMap(command => command.args),
		).not.toContain("mouse");
	});

	it("records session identity markers in the required tmux profile", () => {
		const commands = buildGjcTmuxProfileCommands(
			"gjc-session:0",
			{},
			{
				sessionId: "session-123",
				sessionStateFile: "/tmp/gjc-state/session.json",
				version: VERSION,
			},
		);
		const args = commands.map(command => command.args);

		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "@gjc-session-id", "session-123"]);
		expect(args).toContainEqual([
			"set-option",
			"-t",
			"gjc-session:0",
			"@gjc-session-state-file",
			"/tmp/gjc-state/session.json",
		]);
		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "@gjc-version", VERSION]);
	});

	it("plans matching tmux marker tags and inner process marker env", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { GJC_SESSION_ID: TEST_SESSION_ID },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.sessionId).toBe(plan.sessionName);
		if (!plan.sessionId || !plan.sessionStateFile) throw new Error("expected tmux session id and state file");
		// The runtime state path is rooted on the GJC session (GJC_SESSION_ID), not the
		// coordinator/tmux identity.
		expect(path.dirname(plan.sessionStateFile)).toBe(
			path.join(sessionRuntimeDir("/repo", TEST_SESSION_ID), "tmux-sessions"),
		);
		expect(plan.innerCommand).toContain(`GJC_COORDINATOR_SESSION_ID='${plan.sessionId}'`);
		expect(plan.innerCommand).toContain(`GJC_COORDINATOR_SESSION_STATE_FILE='${plan.sessionStateFile}'`);
	});

	it("roots runtime state on GJC_SESSION_ID even when GJC_COORDINATOR_SESSION_ID differs", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { GJC_SESSION_ID: "gjc-sess", GJC_COORDINATOR_SESSION_ID: "coord-sess" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
		});
		expect(plan).toBeDefined();
		if (!plan?.sessionStateFile) throw new Error("expected tmux plan with state file");
		// Coordinator identity is the coordinator id; the state-file root is the GJC session.
		expect(plan.sessionId).toBe("coord-sess");
		expect(path.dirname(plan.sessionStateFile)).toBe(
			path.join(sessionRuntimeDir("/repo", "gjc-sess"), "tmux-sessions"),
		);
	});

	it("applies the tmux profile only to the requested target", () => {
		const calls: { command: string; args: string[] }[] = [];
		const result = applyGjcTmuxProfile({
			tmuxCommand: "tmux",
			target: "%7",
			cwd: "/repo",
			env: {},
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(result.skipped).toBe(false);
		expect(result.failures).toEqual([]);
		expect(calls).toHaveLength(4);
		expect(calls.every(call => call.command === "tmux")).toBe(true);
		expect(calls.every(call => call.args.includes("-t") && call.args.includes("%7"))).toBe(true);
		expect(calls.flatMap(call => call.args)).not.toContain("-g");
	});

	it("does not wrap non-interactive or already wrapped launches", () => {
		const common = {
			rawArgs: [],
			cwd: "/repo",
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin" as const,
			tty: interactiveTty,
			tmuxAvailable: true,
		};

		expect(buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ print: true }), env: {} })).toBeUndefined();
		expect(buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ mode: "json" }), env: {} })).toBeUndefined();
		expect(
			buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ tmux: true }), env: { TMUX: "/tmp/tmux" } }),
		).toBeUndefined();
		expect(
			buildDefaultTmuxLaunchPlan({
				...common,
				parsed: args({ tmux: true }),
				env: { [GJC_TMUX_LAUNCHED_ENV]: "1" },
			}),
		).toBeUndefined();
	});

	it("renames the current window for direct interactive launches inside tmux", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {
				TMUX: "/tmp/tmux",
			},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			command: "tmux",
			args: ["rename-window", "--", "GJC-repo-feature/demo"],
		});
	});

	it("does not rename direct launches already inside a GJC-launched tmux wrapper", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {
				TMUX: "/tmp/tmux",
				[GJC_TMUX_LAUNCHED_ENV]: "1",
			},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toEqual([]);
	});

	it("skips direct tmux rename when guard conditions are not met", () => {
		const cases = [
			{
				name: "non-interactive",
				parsed: args({ print: true }),
				env: { TMUX: "/tmp/tmux" },
				tmuxAvailable: true,
			},
			{
				name: "tmux unavailable",
				parsed: args({ messages: ["hello world"] }),
				env: { TMUX: "/tmp/tmux" },
				tmuxAvailable: false,
			},
			{
				name: "direct launch policy",
				parsed: args({ messages: ["hello world"] }),
				env: { TMUX: "/tmp/tmux", GJC_LAUNCH_POLICY: "direct" },
				tmuxAvailable: true,
			},
		];

		for (const testCase of cases) {
			const calls: Array<{ command: string; args: string[] }> = [];
			const handled = launchDefaultTmuxIfNeeded({
				parsed: testCase.parsed,
				rawArgs: ["hello world"],
				cwd: "/repo",
				env: testCase.env,
				argv: ["/usr/local/bin/gjc"],
				execPath: "/bin/bun",
				platform: "darwin",
				tty: interactiveTty,
				tmuxAvailable: testCase.tmuxAvailable,
				currentBranch: "feature/demo",
				spawnSync: (command, spawnArgs) => {
					calls.push({ command, args: spawnArgs });
					return { exitCode: 0 };
				},
			});

			expect(handled, testCase.name).toBe(false);
			expect(calls, testCase.name).toEqual([]);
		}
	});

	it("renames managed tmux windows after creating the session", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const newSessionIndex = calls.findIndex(call => call.args[0] === "new-session");
		const renameIndex = calls.findIndex(call => call.args[0] === "rename-window");
		const sessionName = calls[newSessionIndex]?.args[3] ?? "";

		expect(newSessionIndex).toBeGreaterThanOrEqual(0);
		expect(renameIndex).toBeGreaterThan(newSessionIndex);
		expect(calls[renameIndex]?.args).toEqual([
			"rename-window",
			"-t",
			`=${sessionName}`,
			"--",
			"GJC-repo-feature/demo",
		]);
	});
	it("falls through to direct launch when session creation fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const stdout = process.stdout as typeof process.stdout & { isTTY?: boolean };
		const previousIsTTY = stdout.isTTY;
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		stdout.isTTY = true;
		try {
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ tmux: true }),
				rawArgs: [],
				cwd: "/repo",
				env: {},
				argv: ["/usr/local/bin/gjc"],
				execPath: "/bin/bun",
				platform: "darwin",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				existingBranchSessionName: null,
				spawnSync: (command, spawnArgs, options) => {
					calls.push({ command, args: spawnArgs, options });
					return { exitCode: 1 };
				},
			});

			expect(handled).toBe(false);
			expect(calls).toHaveLength(1);
			expect(calls[0].args[0]).toBe("new-session");
			expect(writeSpy).not.toHaveBeenCalled();
		} finally {
			stdout.isTTY = previousIsTTY;
		}
	});

	it("handles and reports partial launch when required profile tagging fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs.includes("@gjc-profile")) return { exitCode: 1, stderr: "no server running on /tmp/tmux" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: profile tagging failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
	});

	it("continues root launch when non-ownership metadata tagging fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "issue-882",
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs.includes("@gjc-branch")) return { exitCode: 1, stderr: "psmux: connection timed out" };
				if (spawnArgs[0] === "attach-session") return { exitCode: 0 };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.map(call => call.args)).toContainEqual([
			"set-option",
			"-t",
			expect.any(String),
			"@gjc-profile",
			"1",
		]);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(diagnostics).toEqual([]);
	});

	it("handles and reports partial launch when attach fails after profile succeeds", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
	});

	it("preserves a newly created managed session when attach reports SSH disconnect EIO", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session")
					return { exitCode: 1, stderr: "write /dev/tty: input/output error (EIO)" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach disconnected.");
	});

	it("does not throw when reporting attach disconnect EIO to closed stderr", () => {
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
			throw stderrError("EIO");
		});

		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed: EIO" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, expect.stringContaining("attach disconnected"));
	});

	it("preserves a newly created managed session when attach receives SIGHUP", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session") return { exitCode: null, signalCode: "SIGHUP" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach disconnected.");
	});

	it("preserves a live newly created managed session when attach exits after PTY close", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session") return { exitCode: 1 };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.filter(call => call.args[0] === "has-session").length).toBeGreaterThanOrEqual(2);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach disconnected.");
	});

	it("does not throw when the default tmux diagnostic write hits a closed stderr", () => {
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
			throw stderrError("EIO");
		});

		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, expect.stringContaining("attach failed"));
	});

	it("falls through to direct launch with a diagnostic when tmux is unavailable", () => {
		const diagnostics: string[] = [];
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: false,
			diagnosticWriter: message => diagnostics.push(message),
		});

		expect(plan).toBeUndefined();
		expect(diagnostics).toEqual([
			"gjc --tmux requested but no tmux executable was found; starting without a tmux-backed session.\n",
		]);
	});

	it("explains the psmux install path when no tmux binary is found on native Windows", () => {
		// The legacy diagnostic pointed users at WSL and warned that psmux was
		// "not fully supported". With psmux detected as a supported Windows
		// multiplexer, the diagnostic now recommends installing psmux directly.
		const diagnostics: string[] = [];
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "C:\\repo",
			env: {},
			argv: ["C:\\Program Files\\GJC\\gjc.exe"],
			execPath: "C:\\Program Files\\GJC\\gjc.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: false,
			diagnosticWriter: message => diagnostics.push(message),
		});

		expect(plan).toBeUndefined();
		expect(diagnostics[0]).toContain("native Windows");
		expect(diagnostics[0]).toContain("psmux");
		expect(diagnostics[0]).toContain("https://github.com/psmux/psmux");
		expect(diagnostics[0]).toContain("GJC_TMUX_COMMAND");
	});

	it("applies session-scoped mouse scrolling when launching tmux on WSL/Linux", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { WSL_DISTRO_NAME: "Ubuntu" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const created = calls.find(call => call.args[0] === "new-session");
		expect(created).toBeDefined();
		const sessionName = created?.args[3] ?? "";
		expect(sessionName.startsWith(GJC_TMUX_SESSION_PREFIX)).toBe(true);
		// The GJC-launched tmux/profile path must not bypass mouse scrolling on WSL.
		expect(calls.some(call => call.command === "tmux")).toBe(true);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "mouse", "on"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "@gjc-version", VERSION]);
		// All profile mutations stay scoped to the GJC session, never global tmux state.
		expect(calls.flatMap(call => call.args)).not.toContain("-g");
	});

	it("honors GJC_MOUSE=off on WSL/Linux without disabling the rest of the profile", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { WSL_DISTRO_NAME: "Ubuntu", GJC_MOUSE: "off" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const created = calls.find(call => call.args[0] === "new-session");
		const sessionName = created?.args[3] ?? "";
		expect(calls.flatMap(call => call.args)).not.toContain("mouse");
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "@gjc-profile", "1"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "@gjc-version", VERSION]);
	});
});

it("emits a BOM-less UTF-16LE encoded command and a direct `&` invocation for native Windows --tmux plans", () => {
	// Regression: gjc --tmux on native Windows + psmux previously failed with
	// the literal text "﻿$env:GJC_TMUX_LAUNCHED : The term '﻿$env:...' is not
	// recognized" appearing in the psmux pane, because the encoded command
	// was prefixed with a UTF-16LE BOM (0xFF 0xFE). pwsh does not strip the
	// BOM on -EncodedCommand input; it decodes the BOM to U+FEFF and emits
	// that character as part of the first token, which then fails to match
	// any cmdlet. Fix: emit the buffer WITHOUT a BOM, and use a direct
	// `& 'cmd' 'arg1' 'arg2'` invocation (no script-block wrapper, which
	// is itself a parser error for adjacent single-quoted tokens).
	const plan = buildDefaultTmuxLaunchPlan({
		parsed: args({ messages: [], tmux: true }),
		rawArgs: ["--tmux"],
		cwd: "C:\\repo",
		env: {},
		argv: ["C:\\Program Files\\GJC\\gjc.exe"],
		execPath: "C:\\Program Files\\GJC\\gjc.exe",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
	});
	expect(plan).toBeDefined();
	if (!plan) throw new Error("expected tmux plan for win32 --tmux launch");
	const encodedMatch = plan.innerCommand.match(/-EncodedCommand\s+(\S+)/);
	expect(encodedMatch).not.toBeNull();
	if (!encodedMatch) throw new Error("expected -EncodedCommand in inner command");
	const decoded = Buffer.from(encodedMatch[1], "base64");
	// The decoded buffer must NOT start with the UTF-16LE BOM. pwsh does not
	// strip the BOM on -EncodedCommand input, so prepending one would cause
	// the first script token to be prefixed with U+FEFF, breaking the parse.
	expect(decoded[0]).not.toBe(0xff);
	expect(decoded[1]).not.toBe(0xfe);
	const script = decoded.toString("utf16le");
	// The first character of the decoded script must be the first character
	// of the actual PowerShell command (`$` from `$env:GJC_TMUX_LAUNCHED`).
	expect(script[0]).toBe("$");
	// The inner invocation must use the PowerShell `&` call operator directly
	// (no `& { ... }` script-block wrapper) because adjacent single-quoted
	// tokens inside a script-block body are a parser error. The correct shape
	// is `& 'cmd' 'arg1' 'arg2'`, which is exactly what buildWindowsPowerShell
	// InnerCommand produces below.
	expect(script).toMatch(/&\s+'/);
});

it("captures psmux stderr in the attach-failed diagnostic", () => {
	// exit when attach-session fails. The previous defaultSpawnSync dropped
	// Bun.spawnSync's result.stderr, so the "attach failed" diagnostic
	// template rendered with an empty detail and the user could not
	// diagnose the real failure. With captureStderr: true the new-session
	// and profile spawns retain their stderr, and the diagnostic template
	// emits the captured text so future regressions in the same lane are
	// diagnosable from the test surface alone.
	const diagnostics: string[] = [];
	const handled = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: {},
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: message => {
			diagnostics.push(message);
		},
		spawnSync: (_command, spawnArgs) => {
			if (spawnArgs[0] === "new-session") {
				// Simulate psmux rejecting the new-session call by emitting a
				// distinctive stderr message and exiting non-zero.
				return {
					exitCode: 1,
					stderr: "psmux: cannot create session: server is shutting down",
				};
			}
			if (spawnArgs[0] === "attach-session") {
				return { exitCode: 0 };
			}
			return { exitCode: 0 };
		},
	});
	// The handler should return false because new-session failed and there
	// is no usable plan to fall through from. The captured stderr is what
	// the diagnostic writer saw, so it should include the failure reason.
	expect(handled).toBe(false);
	expect(diagnostics.length).toBeGreaterThan(0);
	expect(diagnostics[0]).toContain("new-session failed");
	expect(diagnostics[0]).toContain("cannot create session");
});

it("surfaces a wrapper-corruption warning in the new-session diagnostic on Windows", () => {
	// Regression: when gjc.cmd / gjc.bat on PATH has been overwritten with
	// PE-binary garbage (a 194MB PE image or similar), cmd.exe hangs reading
	// it as text and the user sees a silent exit. The wrapper-corruption
	// probe must surface a clear hint in the diagnostic so the user can
	// identify and fix the wrapper without re-running the wrapper diagnostic
	// script.
	if (process.platform !== "win32") return;
	const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "gjc-wrapper-probe-"));
	const wrapperPath = path.join(dir, "gjc.cmd");
	// Write 4KB of PE-binary garbage (MZ header + zero padding).
	const garbage = Buffer.alloc(4096);
	garbage[0] = 0x4d;
	garbage[1] = 0x5a;
	fs.writeFileSync(wrapperPath, garbage);
	const originalPath = process.env.PATH;
	process.env.PATH = dir + path.delimiter + (originalPath ?? "");
	try {
		const diagnostics: string[] = [];
		launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "new-session") {
					return { exitCode: 1, stderr: "psmux: cannot create session: server is shutting down" };
				}
				if (spawnArgs[0] === "attach-session") {
					return { exitCode: 0 };
				}
				return { exitCode: 0 };
			},
		});
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]).toContain("new-session failed");
		expect(diagnostics[0]).toContain("Wrapper warning");
		expect(diagnostics[0]).toContain(wrapperPath);
	} finally {
		process.env.PATH = originalPath;
		try {
			fs.unlinkSync(wrapperPath);
		} catch {}
		try {
			fs.rmdirSync(dir);
		} catch {}
	}
});

it("retries new-session when the psmux server has not yet registered the session (Windows race)", () => {
	// Regression: on Windows + psmux 3.3.0/3.3.6, the new-session spawn can
	// return exit 0 before the psmux server has finished registering the
	// session on its control socket. The follow-up attach-session then fails
	// with "psmux: can't find session '=NAME' (no server running)" because
	// the psmux server is alive but the session is briefly invisible. The
	// has-session probe + new-session retry in launchDefaultTmuxIfNeeded
	// closes the race. This test simulates the failure shape without
	// requiring a live psmux server.
	const calls: Array<{ command: string; args: string[] }> = [];
	let newSessionCount = 0;
	let capturedSessionName = "";
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: {},
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "new-session") {
				capturedSessionName = spawnArgs[3] ?? capturedSessionName;
				newSessionCount++;
				return { exitCode: 0, stderr: "" };
			}
			if (spawnArgs[0] === "has-session") {
				if (newSessionCount === 1) {
					return {
						exitCode: 1,
						stderr: `psmux: can't find session '=${capturedSessionName}' (no server running)`,
					};
				}
				return { exitCode: 0 };
			}
			return { exitCode: 0 };
		},
	});
	expect(result).toBe(true);
	const newSessionCalls = calls.filter(call => call.command === "new-session");
	expect(newSessionCalls.length).toBe(2);
	expect(calls.some(call => call.command === "has-session" && call.args[2] === `=${capturedSessionName}`)).toBe(true);
});

it("retries new-session when the psmux server has not yet registered the session before profile tagging (Windows race)", () => {
	// Regression: on Windows + psmux 3.3.0/3.3.6, the new-session spawn can
	// return exit 0 and then the psmux server can die before it finishes
	// registering the session on its control socket. The follow-up
	// set-option @gjc-profile call that runs inside applyGjcTmuxProfile()
	// then fails with "psmux: can't find session '=NAME' (no server
	// running)". The control flow must probe + retry new-session before
	// declaring profile tagging failed; otherwise a legitimate race
	// would be misclassified as a persistence-tag rejection and the
	// session would be killed without retry.
	const calls: Array<{ command: string; args: string[] }> = [];
	let newSessionCount = 0;
	let setOptionCount = 0;
	let capturedSessionName = "";
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: {},
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "new-session") {
				capturedSessionName = spawnArgs[3] ?? capturedSessionName;
				newSessionCount++;
				return { exitCode: 0, stderr: "" };
			}
			if (spawnArgs[0] === "has-session") {
				if (newSessionCount === 1) {
					return {
						exitCode: 1,
						stderr: `psmux: can't find session '=${capturedSessionName}' (no server running)`,
					};
				}
				return { exitCode: 0 };
			}
			// After the second successful new-session, psmux persists
			// the @gjc-profile tag, so applyGjcTmuxProfile must succeed.
			if (spawnArgs.some(arg => typeof arg === "string" && arg.includes("@gjc-profile"))) {
				setOptionCount++;
				return { exitCode: 0, stderr: "" };
			}
			if (spawnArgs[0] === "set-option" && setOptionCount === 0 && newSessionCount === 1) {
				setOptionCount++;
				return {
					exitCode: 1,
					stderr: `psmux: can't find session '=${capturedSessionName}' (no server running)`,
				};
			}
			return { exitCode: 0 };
		},
	});
	expect(result).toBe(true);
	const newSessionCalls = calls.filter(call => call.command === "new-session");
	expect(newSessionCalls.length).toBe(2);
	expect(calls.filter(call => call.command === "has-session").length).toBeGreaterThanOrEqual(2);
});

it("retries Windows psmux attach once after transient os error 10061", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	let attachAttempts = 0;
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "attach-session") {
				attachAttempts++;
				if (attachAttempts === 1) {
					return {
						exitCode: 1,
						stderr: "psmux: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (os error 10061)",
					};
				}
			}
			return { exitCode: 0 };
		},
	});

	expect(result).toBe(true);
	expect(calls.filter(call => call.command === "attach-session")).toHaveLength(2);
	expect(calls.some(call => call.command === "has-session")).toBe(true);
	expect(calls.some(call => call.command === "kill-session")).toBe(false);
});

it("recreates a Windows psmux session that disappears after transient attach os error 10061", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	let attachAttempts = 0;
	let newSessionCount = 0;
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "new-session") {
				newSessionCount++;
				return { exitCode: 0 };
			}
			if (spawnArgs[0] === "has-session" && attachAttempts > 0 && newSessionCount === 1) {
				return { exitCode: 1, stderr: "psmux: can't find session (no server running)" };
			}
			if (spawnArgs[0] === "attach-session") {
				attachAttempts++;
				if (attachAttempts === 1) {
					return {
						exitCode: 1,
						stderr: "psmux: 대상 컴퓨터에서 연결을 거부했으므로 연결하지 못했습니다. (os error 10061)",
					};
				}
			}
			return { exitCode: 0 };
		},
	});

	expect(result).toBe(true);
	expect(calls.filter(call => call.command === "new-session")).toHaveLength(2);
	expect(calls.filter(call => call.command === "attach-session")).toHaveLength(2);
	expect(calls.some(call => call.args.includes("@gjc-profile"))).toBe(true);
	expect(calls.some(call => call.command === "kill-session")).toBe(false);
});

it("does not retry Windows psmux attach failures without os error 10061", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const diagnostics: string[] = [];
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: message => diagnostics.push(message),
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "psmux: attach failed" };
			return { exitCode: 0 };
		},
	});

	expect(result).toBe(true);
	expect(calls.filter(call => call.command === "attach-session")).toHaveLength(1);
	expect(calls.some(call => call.command === "kill-session")).toBe(true);
	expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
});
