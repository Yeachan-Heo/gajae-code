import { afterEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
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

function args(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...overrides,
	};
}

const interactiveTty = { stdin: true, stdout: true };
function decodePowerShellEncodedCommand(command: string): string {
	const match = command.match(/ -EncodedCommand (?<encoded>[A-Za-z0-9+/=]+)$/);
	if (!match?.groups?.encoded) throw new Error(`missing encoded command: ${command}`);
	return Buffer.from(match.groups.encoded, "base64").toString("utf16le");
}

const originalStderrWrite = process.stderr.write.bind(process.stderr);

function stderrError(code: string): Error {
	const error = new Error(`${code} from stderr`);
	Object.defineProperty(error, "code", { value: code });
	return error;
}

describe("default GJC tmux launch", () => {
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
	});

	it("builds project and branch tmux window titles", () => {
		expect(buildGjcTmuxWindowTitle("/repo", "feature/demo")).toBe("repo:feature/demo");
		expect(buildGjcTmuxWindowTitle("/repo", null)).toBe("repo");
		expect(buildGjcTmuxWindowTitle("/repo", "")).toBe("repo");
	});

	it("truncates long tmux window titles to 48 visible columns while preserving the project and branch tail", () => {
		const title = buildGjcTmuxWindowTitle("/repo", `feature/${"a".repeat(80)}tail`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("repo:…")).toBe(true);
		expect(title.endsWith("tail")).toBe(true);
	});

	it("truncates wide-character tmux window titles by visible width while preserving the branch tail", () => {
		const title = buildGjcTmuxWindowTitle("/저장소", `feature/${"界".repeat(80)}끝`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("저장소:…")).toBe(true);
		expect(title.endsWith("끝")).toBe(true);
	});

	it("separates dash-leading tmux window titles from tmux options", () => {
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
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls[0]?.args).toEqual(["rename-window", "--", "-repo:feature/demo"]);
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
		});

		expect(plan).toBeUndefined();
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

	it("plans native Windows --tmux launches when tmux is available", () => {
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
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", plan.sessionName, "-c", "C:\\repo"]);
		expect(plan.innerCommand).toStartWith(
			"pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ",
		);
		expect(plan.innerCommand).not.toContain("exec env");
		expect(decodePowerShellEncodedCommand(plan.innerCommand)).toContain("$env:GJC_TMUX_LAUNCHED = '1'");
	});

	it("builds a PowerShell-safe Windows tmux bootstrap command", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["say it's ok"], tmux: true }),
			rawArgs: ["--tmux", "say it's ok"],
			cwd: "C:\\repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "C:\\Program Files\\Bun\\bun.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		const script = decodePowerShellEncodedCommand(plan.innerCommand);
		expect(script).toContain("$env:GJC_TMUX_LAUNCHED = '1'");
		expect(script).toContain(`$env:GJC_COORDINATOR_SESSION_ID = '${plan.sessionId}'`);
		expect(script).toContain(
			"& 'C:\\Program Files\\Bun\\bun.exe' 'C:\\repo\\packages\\coding-agent\\src\\cli.ts' 'say it''s ok'",
		);
		expect(script).not.toContain("'--tmux'");
		expect(script).toEndWith("if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }");
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
		});

		expect(plan?.innerCommand).not.toContain("$bunfs");
		expect(plan?.innerCommand).toContain("'gjc'");
	});

	it("attaches existing tagged session for matching worktree branch", () => {
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
		expect(calls.some(call => call.args[0] === "new-session")).toBe(false);
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "=gajae_code_feature"]);
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
		});

		expect(plan?.sessionName).toBe("custom-gjc");
		expect(plan?.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", "custom-gjc", "-c", "/repo"]);
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
	});

	it("plans matching tmux marker tags and inner process marker env", () => {
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
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.sessionId).toBe(plan.sessionName);
		expect(plan.sessionStateFile).toContain("/repo/.gjc/runtime/tmux-sessions/");
		expect(plan.innerCommand).toContain(`GJC_COORDINATOR_SESSION_ID='${plan.sessionId}'`);
		expect(plan.innerCommand).toContain(`GJC_COORDINATOR_SESSION_STATE_FILE='${plan.sessionStateFile}'`);
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
			args: ["rename-window", "--", "repo:feature/demo"],
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
		expect(calls[renameIndex]?.args).toEqual(["rename-window", "-t", `=${sessionName}`, "--", "repo:feature/demo"]);
	});
	it("falls through to direct launch when session creation fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
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
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 1 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0].args[0]).toBe("new-session");
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
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
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
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
	});

	it("does not throw when the default tmux diagnostic write hits a closed stderr", () => {
		const writes: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			throw stderrError("EIO");
		}) satisfies typeof process.stderr.write;

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
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
	});

	it("falls through to direct launch when tmux is unavailable", () => {
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
		});

		expect(plan).toBeUndefined();
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
	});
});
