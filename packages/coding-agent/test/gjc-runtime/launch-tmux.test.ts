import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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
	launchDefaultTmuxIfNeeded as launchDefaultTmuxIfNeededRaw,
	type TmuxLaunchContext,
	type TmuxSpawnOptions,
} from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import { __setBinaryResolverForTests } from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import { sessionRuntimeDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { persistCoordinatorRuntimeStateFromPostmortem } from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import {
	captureOwnerGenerationBaselineSync,
	isExactScopedBootstrapSuccessReceipt,
	lifecyclePaths,
	replaceOwnerGenerationSync,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import {
	__setCreateOwnerIsolationForTests,
	__setMutationServerProofForTests,
	createGjcTmuxSession,
	removeGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";
import { postmortem } from "@gajae-code/utils";

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
const launchTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-launch-tests-"));
const NATIVE_SESSION_ID = "$0";

function safeAbsentOwnerIsolationProbe(): NonNullable<TmuxLaunchContext["ownerIsolationProbe"]> {
	let serverCreated = false;
	return {
		readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gjc.scope\n",
		probeServer: () => {
			if (!serverCreated) {
				serverCreated = true;
				return { state: "absent" };
			}
			return { state: "safe", pid: 123, startTime: "42", cgroup: { classification: "safe" } };
		},
		recordAttempt: () => {},
	};
}

function launchContext(context: TmuxLaunchContext): TmuxLaunchContext {
	return {
		platform: "linux",
		ownerIsolationProbe: safeAbsentOwnerIsolationProbe(),
		...context,
		env: {
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(launchTestRoot, "runtime-state.json"),
			...(context.env ?? {}),
		},
	};
}

function launchDefaultTmuxIfNeeded(context: TmuxLaunchContext): boolean {
	let createdSessionName = context.env?.GJC_TMUX_SESSION;
	const suppliedSpawnSync = context.spawnSync;
	return launchDefaultTmuxIfNeededRaw(
		launchContext({
			...context,
			spawnSync: suppliedSpawnSync
				? (command, spawnArgs, options) => {
						if (command === "systemd-run" && options.stdinLine) {
							try {
								createdSessionName = (JSON.parse(options.stdinLine) as { attempt?: { session_name?: string } })
									.attempt?.session_name;
							} catch {}
						}
						if (spawnArgs[0] === "new-session") {
							const nameIndex = spawnArgs.indexOf("-s");
							createdSessionName = spawnArgs[nameIndex + 1] ?? createdSessionName;
						}
						const result = suppliedSpawnSync(command, spawnArgs, options);
						const nativeSessionId = spawnArgs[spawnArgs.indexOf("-t") + 1];
						if (
							spawnArgs[0] === "display-message" &&
							spawnArgs.at(-1) === "#{session_id}\t#{session_name}" &&
							result.exitCode === 0 &&
							(result.stdout?.trim() === nativeSessionId || !result.stdout?.trim())
						)
							return { ...result, stdout: `${nativeSessionId}\t${createdSessionName ?? "gajae_code"}` };
						if (
							spawnArgs[0] === "if-shell" &&
							result.exitCode === 0 &&
							result.stdout?.trim() !== "__gjc_tmux_guarded_cleanup_refused__"
						)
							return { ...result, stdout: "__gjc_tmux_guarded_cleanup_ok__" };
						return result;
					}
				: undefined,
		}),
	);
}

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
	fs.rmSync(launchTestRoot, { recursive: true, force: true });
});
const originalStderrWrite = process.stderr.write.bind(process.stderr);

afterEach(() => {
	process.exitCode = undefined;
});

function stderrError(code: string): Error {
	const error = new Error(`${code} from stderr`);
	Object.defineProperty(error, "code", { value: code });
	return error;
}

describe("default GJC tmux launch", () => {
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
		process.exitCode = undefined;
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.find(call => call.args[0] === "rename-window")?.args).toEqual([
			"rename-window",
			"-t",
			"$0",
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
			"$0:",
			"set-titles-string",
			"#{?#{==:#{@gjc-root-terminal-title-session},#{session_name}},#{@gjc-root-terminal-title},GJC: #{session_name}}",
		]);
		expect(
			calls.some(call => call.args[3] === "@gjc-root-terminal-title" && call.args[4] === "GJC: repo-feature/demo"),
		).toBe(true);
		expect(
			calls.some(
				call => call.args[3] === "@gjc-root-terminal-title-session" && /^gajae_code_/.test(call.args[4] ?? ""),
			),
		).toBe(true);
		expect(calls.some(call => call.args[3] === "set-titles" && call.args[4] === "on")).toBe(true);
		expect(writeSpy).not.toHaveBeenCalled();
	});
	it("uses the live tmux session name for already renamed managed sessions", () => {
		const calls: Array<{ command: string; args: string[] }> = [];

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
			existingBranchSessionName: "office-renamed",
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.find(call => call.args[3] === "set-titles-string")?.args.at(-1)).toBe("GJC: #{session_name}");
		expect(calls.find(call => call.args[0] === "attach-session")?.args).toEqual([
			"attach-session",
			"-t",
			"=office-renamed",
		]);
	});

	it("stores literal fallback titles outside the tmux title format", () => {
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(
			calls.some(
				call => call.args[3] === "@gjc-root-terminal-title" && call.args[4] === "GJC: repo-feature/#S/demo",
			),
		).toBe(true);
		expect(calls.find(call => call.args[3] === "set-titles-string")?.args.at(-1)).toBe(
			"#{?#{==:#{@gjc-root-terminal-title-session},#{session_name}},#{@gjc-root-terminal-title},GJC: #{session_name}}",
		);
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
		expect(plan.innerCommand).toContain("tmux-exit.json");
		expect(plan.innerCommand).toContain("trap __gjc_tmux_write_exit_marker EXIT");
		expect(plan.innerCommand).not.toStartWith("exec ");
	});

	it("POSIX tmux inner wrapper writes a public-safe exit marker and preserves exit status", () => {
		if (process.platform === "win32") return;
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-exit-marker-"));
		const entrypoint = path.join(cwd, "exit.js");
		fs.writeFileSync(entrypoint, "process.exit(7);\n");
		try {
			const plan = buildDefaultTmuxLaunchPlan({
				parsed: args({ messages: ["-c", "exit 7"], tmux: true }),
				rawArgs: ["--tmux", "-c", "exit 7"],
				cwd,
				env: {},
				argv: [process.execPath, entrypoint],
				execPath: process.execPath,
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				existingBranchSessionName: null,
			});
			expect(plan).toBeDefined();
			if (!plan) throw new Error("expected tmux plan");

			const result = Bun.spawnSync(["/bin/sh", "-c", plan.innerCommand], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.exitCode).toBe(7);

			expect(plan.sessionStateFile).toBeTruthy();
			if (!plan.sessionStateFile) throw new Error("expected session state file");
			const markerPath = path.join(path.dirname(plan.sessionStateFile), "tmux-exit.json");
			const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
			expect(marker).toEqual({
				schema_version: 1,
				source: "tmux_inner_shell",
				ended_at: expect.any(String),
				exit_code: 7,
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
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

	it("keeps a newly created managed tmux window in automatic sizing mode before attaching", () => {
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		const newSession = calls.find(call => call.args[0] === "new-session");
		const setWindowSizeIndex = calls.findIndex(
			call => call.args[0] === "set-window-option" && call.args.includes("window-size"),
		);
		const attachIndex = calls.findIndex(call => call.args[0] === "attach-session");
		expect(newSession?.args).toContain("-x");
		expect(newSession?.args).toContain("178");
		expect(newSession?.args).toContain("-y");
		expect(newSession?.args).toContain("35");
		// The initial size comes from new-session -x/-y. On native tmux the window
		// must then stay in automatic sizing mode so attach-session fits it to the
		// real client. A `resize-window` reassert would flip window-size to
		// `manual`, pinning the window to the capture-time size and leaving a
		// smaller-than-client window that tmux paints with `·` fill.
		expect(calls.some(call => call.args[0] === "resize-window")).toBe(false);
		expect(setWindowSizeIndex).toBeGreaterThan(0);
		expect(setWindowSizeIndex).toBeLessThan(attachIndex);
		expect(calls[setWindowSizeIndex]?.args).toEqual(["set-window-option", "-t", "$0:", "window-size", "latest"]);
	});

	it("creates exactly one foreground unmanaged psmux session", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: string[][] = [];
		try {
			expect(
				launchDefaultTmuxIfNeededRaw({
					parsed: args({ messages: ["hello world"], tmux: true }),
					rawArgs: ["--tmux", "hello world"],
					cwd: "/repo",
					env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
					argv: ["bun", "packages/coding-agent/src/cli.ts"],
					execPath: "/bin/bun",
					platform: "win32",
					tty: { stdin: true, stdout: true, columns: 178, rows: 35 },
					tmuxAvailable: true,
					currentBranch: "feature/demo",
					existingBranchSessionName: null,
					spawnSync: (_command, spawnArgs) => {
						calls.push(spawnArgs);
						if (spawnArgs[0] !== "list-sessions") return { exitCode: 0 };
						if (calls.filter(call => call[0] === "list-sessions").length === 1)
							return { exitCode: 1, stderr: "no server running" };
						const created = calls.find(call => call[0] === "new-session")!;
						return { exitCode: 0, stdout: `${created[created.indexOf("-s") + 1]}\n` };
					},
				}),
			).toBe(true);
			const newSession = calls[1] ?? [];
			const sessionName = newSession[newSession.indexOf("-s") + 1];
			expect(calls.map(call => call[0])).toEqual(["list-sessions", "new-session"]);
			expect(calls[0]).toEqual(["list-sessions", "-F", "#{session_name}"]);
			expect(sessionName).toBeDefined();
			expect(newSession).not.toContain("-d");
			expect(calls.some(call => ["set-option", "kill-session", "resize-window"].includes(call[0]!))).toBe(false);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it.each([
		"GJC_COORDINATOR_SESSION_BRANCH",
		"GJC_COORDINATOR_SESSION_LAUNCH_ID",
		"GJC_COORDINATOR_SESSION_READINESS_FILE",
	])("refuses psmux before mutation when %s is the only lifecycle marker", markerName => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: string[][] = [];
		try {
			expect(() =>
				launchDefaultTmuxIfNeededRaw({
					parsed: args({ tmux: true }),
					rawArgs: ["--tmux"],
					cwd: "/repo",
					env: {
						GJC_TMUX_COMMAND: "psmux",
						GJC_PSMUX_COMMAND: "psmux",
						[markerName]: " marker ",
					},
					argv: ["bun", "cli.ts"],
					execPath: "/bin/bun",
					platform: "win32",
					tty: interactiveTty,
					tmuxAvailable: true,
					currentBranch: "",
					spawnSync: (_command, spawnArgs) => {
						calls.push(spawnArgs);
						return { exitCode: 0 };
					},
				}),
			).toThrow("gjc_tmux_owner_isolation_native_session_identity_unavailable");
			expect(calls).toEqual([]);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("refuses name-only explicit psmux continuation without creating or attaching", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		try {
			launchDefaultTmuxIfNeededRaw({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: "/repo",
				env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux", GJC_TMUX_SESSION: "continued" },
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "win32",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: "continued",
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return spawnArgs[0] === "list-sessions"
						? { exitCode: 0, stdout: "continued\ncontinuation-decoy\n" }
						: { exitCode: 0 };
				},
				diagnosticWriter: message => diagnostics.push(message),
			});
			expect(calls).toEqual([["list-sessions", "-F", "#{session_name}"]]);
			expect(diagnostics.join("\n")).toContain("name-only and cannot be attached safely");
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("preserves an unmanaged psmux session when foreground creation fails", () => {
		const results = [
			{ exitCode: 1, stderr: "no server running" },
			{ exitCode: 1, stderr: "create failed" },
		];
		const expectedCreates = 1;
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		try {
			launchDefaultTmuxIfNeededRaw({
				parsed: args({ tmux: true }),
				rawArgs: ["--tmux"],
				cwd: "/repo",
				env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "win32",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					const result = results.shift()!;
					if (spawnArgs[0] !== "list-sessions" || result.exitCode !== 0 || ("stdout" in result && result.stdout))
						return result;
					const created = calls.find(call => call[0] === "new-session");
					const sessionName = created?.[created.indexOf("-s") + 1] ?? "continued";
					return { ...result, stdout: `${sessionName}\n` };
				},
				diagnosticWriter: message => diagnostics.push(message),
			});
			expect(calls.filter(call => call[0] === "new-session")).toHaveLength(expectedCreates);
			expect(calls.some(call => ["set-option", "kill-session", "resize-window"].includes(call[0]!))).toBe(false);
			expect(diagnostics).toHaveLength(1);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it.each([
		["no --tmux", args({ messages: ["hello"] }), ["hello"], {}, false],
		["print", args({ tmux: true, print: true }), ["--tmux", "--print", "hello"], {}, false],
		["export", args({ tmux: true, export: "json" }), ["--tmux", "--export", "json"], {}, false],
		["list models", args({ tmux: true, listModels: true }), ["--tmux", "--list-models"], {}, false],
		["direct policy", args({ tmux: true }), ["--tmux", "hello"], { GJC_LAUNCH_POLICY: "direct" }, false],
		["already launched", args({ tmux: true }), ["--tmux", "hello"], { [GJC_TMUX_LAUNCHED_ENV]: "1" }, false],
	])("leaves psmux root launch unhandled when %s", (_label, parsed, rawArgs, extraEnv, expectedHandled) => {
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			expect(
				launchDefaultTmuxIfNeeded({
					parsed,
					rawArgs,
					cwd: "/repo",
					env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux", ...extraEnv },
					argv: ["bun", "cli.ts"],
					execPath: "/bin/bun",
					platform: "win32",
					tty: interactiveTty,
					tmuxAvailable: true,
					existingBranchSessionName: "managed",
					diagnosticWriter: message => diagnostics.push(message),
					spawnSync: (_command, spawnArgs) => {
						calls.push(spawnArgs);
						return { exitCode: 0 };
					},
				}),
			).toBe(expectedHandled);
			expect(calls).toEqual([]);
			expect(diagnostics).toEqual([]);
		} finally {
			__setBinaryResolverForTests(null);
		}
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

	it("fails closed when a compiled Bun virtual entrypoint has no same-artifact host path", () => {
		expect(() =>
			buildDefaultTmuxLaunchPlan({
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
			}),
		).toThrow("Bun virtual paths and PATH fallback are not accepted");
	});

	it("fails closed for Windows Bun virtual executable paths", () => {
		expect(() =>
			buildDefaultTmuxLaunchPlan({
				parsed: args({ messages: ["hello world"], tmux: true }),
				rawArgs: ["--tmux", "hello world"],
				cwd: "C:\\repo",
				env: {},
				argv: ["B:\\~BUN\\bun.exe", "B:\\~BUN\\root\\gjc-windows-x64.exe"],
				execPath: "B:\\~BUN\\root\\gjc-windows-x64.exe",
				platform: "win32",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				existingBranchSessionName: null,
			}),
		).toThrow("Bun virtual paths and PATH fallback are not accepted");
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(false);
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "=gajae_code_feature"]);
	});

	it("refuses psmux before existing-session attach", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		try {
			expect(() =>
				launchDefaultTmuxIfNeeded({
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
					diagnosticWriter: message => diagnostics.push(message),
					spawnSync: (command, spawnArgs, options) => {
						calls.push({ command, args: spawnArgs, options });
						return { exitCode: 0, stdout: NATIVE_SESSION_ID };
					},
				}),
			).toThrow("gjc_tmux_owner_isolation_native_session_identity_unavailable");
			expect(calls).toEqual([]);
			expect(diagnostics).toEqual([expect.stringContaining("psmux cannot provide immutable owner identity")]);
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				`current-gjc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\tcurrent-session\t/state\t\t${VERSION}`,
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
				`current-gjc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\tcurrent-session\t/state\t\t${VERSION}`,
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
		Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });

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
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});

			expect(handled).toBe(true);
			expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
			expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
			expect(calls.some(call => call.args[0] === "if-shell")).toBe(true);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
		} finally {
			Object.defineProperty(stdout, "isTTY", { configurable: true, value: previousIsTTY });
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

	it.each([
		[undefined, false],
		["false", false],
		["0", false],
		["true", true],
		["1", true],
	])("applies the psmux UX profile force matrix for %p", (force, includesUxCommands) => {
		const commands = buildGjcTmuxProfileCommands(
			"gjc-session:0",
			typeof force === "string" ? { GJC_PSMUX_PROFILE_FORCE: force } : {},
			{},
			{ tmuxCommand: "psmux" },
		);
		const keys = commands.map(command => command.args.at(-2));
		expect(keys.includes("mouse")).toBe(includesUxCommands);
		expect(keys.includes("set-clipboard")).toBe(includesUxCommands);
		expect(keys.includes("mode-style")).toBe(includesUxCommands);
		expect(keys).toContain("@gjc-profile");
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		const newSessionIndex = calls.findIndex(call => call.args[0] === "new-session");
		const renameIndex = calls.findIndex(call => call.args[0] === "rename-window");

		expect(newSessionIndex).toBeGreaterThanOrEqual(0);
		expect(renameIndex).toBeGreaterThan(newSessionIndex);
		expect(calls[renameIndex]?.args).toEqual(["rename-window", "-t", "$0", "--", "GJC-repo-feature/demo"]);
	});
	it("falls through to direct launch when session creation fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const stdout = process.stdout as typeof process.stdout & { isTTY?: boolean };
		const previousIsTTY = stdout.isTTY;
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
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

			expect(handled).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0].args[0]).toBe("new-session");
			expect(writeSpy).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(stdout, "isTTY", { configurable: true, value: previousIsTTY });
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
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
				if (spawnArgs[0] === "attach-session") return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
		expect(diagnostics).toEqual(["optional tmux profile command failed"]);
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "if-shell")).toBe(true);
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach disconnected.");
	});

	it.each([
		"attach failed: EIO",
		"write /dev/tty: input/output error",
	])("recognizes exact tmux attach disconnect diagnostics: %s", stderr => {
		const diagnostics: string[] = [];
		const calls: string[][] = [];
		launchDefaultTmuxIfNeeded({
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
			spawnSync: (_command, spawnArgs) => {
				calls.push(spawnArgs);
				return spawnArgs[0] === "attach-session"
					? { exitCode: 1, stderr }
					: { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});
		expect(calls.some(call => call[0] === "kill-session")).toBe(false);
		expect(diagnostics[0]).toContain("attach disconnected");
	});

	it.each([
		"EIOFailure",
		"xEIO",
		"input/output errors",
		"preinput/output error",
	])("does not mistake a partial tmux attach disconnect diagnostic for EIO: %s", stderr => {
		const diagnostics: string[] = [];
		const calls: string[][] = [];
		launchDefaultTmuxIfNeeded({
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
			spawnSync: (_command, spawnArgs) => {
				calls.push(spawnArgs);
				return spawnArgs[0] === "attach-session"
					? { exitCode: 1, stderr }
					: { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});
		expect(calls.some(call => call[0] === "if-shell")).toBe(true);
		expect(diagnostics[0]).toContain("attach failed");
		expect(diagnostics[0]).not.toContain("attach disconnected");
	});

	it("strips terminal controls and bounds multibyte tmux diagnostics", () => {
		const diagnostics: string[] = [];
		const detail = `before\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\u009b31m\u009dhidden\x07\n${"😀".repeat(300)}`;
		launchDefaultTmuxIfNeeded({
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
			spawnSync: (_command, spawnArgs) =>
				spawnArgs[0] === "new-session"
					? { exitCode: 1, stderr: detail }
					: { exitCode: 0, stdout: NATIVE_SESSION_ID },
		});
		const diagnostic = diagnostics[0] ?? "";
		expect(diagnostic.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(diagnostic).toContain("beforered");
		expect(diagnostic).toContain("😀".repeat(231));
		expect(diagnostic).not.toContain("😀".repeat(232));
		expect(diagnostic.endsWith("\n")).toBe(true);
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, expect.stringContaining("attach failed"));
	});

	it("treats explicit --tmux unavailability as a terminal handled failure", () => {
		const diagnostics: string[] = [];
		const calls: string[][] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: false,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (_command, spawnArgs) => {
				calls.push(spawnArgs);
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls).toEqual([]);
		expect(diagnostics).toEqual([
			"gjc --tmux requested but no tmux executable was found; cannot continue without a tmux-backed session.\n",
		]);
	});

	it("reports a diagnostic when tmux is unavailable", () => {
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
			"gjc --tmux requested but no tmux executable was found; cannot continue without a tmux-backed session.\n",
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		const created = calls.find(call => call.args[0] === "new-session");
		expect(created).toBeDefined();
		const sessionName = created?.args[3] ?? "";
		expect(sessionName.startsWith(GJC_TMUX_SESSION_PREFIX)).toBe(true);
		// The GJC-launched tmux/profile path must not bypass mouse scrolling on WSL.
		expect(calls.some(call => call.command === "tmux")).toBe(true);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0", "mouse", "on"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0", "@gjc-version", VERSION]);
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});

		expect(handled).toBe(true);
		expect(calls.flatMap(call => call.args)).not.toContain("mouse");
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0", "@gjc-profile", "1"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0", "@gjc-version", VERSION]);
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
	expect(script).toContain("tmux-exit.json");
	expect(script).toContain("finally {");
	expect(script).toContain("Set-Content -LiteralPath");
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
	const handled = launchDefaultTmuxIfNeededRaw({
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
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			}
			return { exitCode: 0, stdout: NATIVE_SESSION_ID };
		},
	});
	// A managed creation failure is terminal so the caller cannot fall through
	// into an unisolated root GJC process; diagnostics retain the rejection.
	expect(handled).toBe(true);
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
		launchDefaultTmuxIfNeededRaw({
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
				if (spawnArgs[0] === "new-session") {
					return { exitCode: 1, stderr: "psmux: cannot create session: server is shutting down" };
				}
				if (spawnArgs[0] === "attach-session") {
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				}
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
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

it("pipes default control-command stderr while preserving interactive attach stderr", () => {
	const calls: Array<{ cmd: string[]; stderr: string }> = [];
	const diagnostics: string[] = [];
	let createdSessionName = "";
	spyOn(Bun, "spawnSync").mockImplementation(options => {
		const command = "cmd" in options ? [...options.cmd] : [...options];
		calls.push({ cmd: command, stderr: "stderr" in options ? String(options.stderr) : "inherit" });
		if (command[1] === "new-session") {
			createdSessionName = command[command.indexOf("-s") + 1] ?? "";
			return spawnResult(0, "$0");
		}
		if (command[1] === "attach-session")
			return spawnResult(1, "", "\u001b]52;c;synthetic-private-text\u0007attach failed");
		if (command.at(-1) === "#{session_id}\t#{session_name}") return spawnResult(0, `$0\t${createdSessionName}`);
		return spawnResult(0, "");
	});
	const handled = launchDefaultTmuxIfNeededRaw({
		parsed: args({ messages: ["hello"], tmux: true }),
		rawArgs: ["--tmux", "hello"],
		cwd: launchTestRoot,
		env: {
			GJC_TMUX_COMMAND: "tmux",
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(launchTestRoot, "default-spawn-state.json"),
		},
		argv: ["bun", "cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: interactiveTty,
		tmuxAvailable: true,
		existingBranchSessionName: null,
		ownerIsolationProbe: safeAbsentOwnerIsolationProbe(),
		diagnosticWriter: message => diagnostics.push(message),
	});
	expect(handled).toBe(true);
	expect(
		calls
			.filter(call => call.cmd[0] === "tmux" && call.cmd[1] !== "attach-session")
			.every(call => call.stderr === "pipe"),
	).toBe(true);
	expect(calls.find(call => call.cmd[1] === "attach-session")?.stderr).toBe("inherit");
	expect(diagnostics.join("\n")).toContain("attach disconnected");
	expect(diagnostics.join("\n")).not.toContain("synthetic-private-text");
	expect(diagnostics.join("\n")).not.toContain("\u001b]");
});

it("preserves a native Linux registration probe failure without retrying or cleaning up", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const diagnostics: string[] = [];
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "tmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: message => diagnostics.push(message),
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "new-session") return { exitCode: 0, stdout: "$0" };
			if (spawnArgs[0] === "has-session") return { exitCode: 1, stderr: "native probe transport failed" };
			return { exitCode: 0, stdout: NATIVE_SESSION_ID };
		},
	});

	expect(result).toBe(true);
	expect(calls.filter(call => call.command === "new-session")).toHaveLength(1);
	expect(calls.some(call => call.command === "kill-session")).toBe(false);
	expect(diagnostics).toEqual([
		expect.stringContaining("session registration probe failed. native probe transport failed"),
	]);
});

it("preserves a native Linux profile failure without retrying or cleaning up", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const diagnostics: string[] = [];
	const result = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "tmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: message => diagnostics.push(message),
		spawnSync: (_command, spawnArgs) => {
			calls.push({ command: spawnArgs[0], args: spawnArgs });
			if (spawnArgs[0] === "new-session") return { exitCode: 0, stdout: "$0" };
			if (spawnArgs.includes("@gjc-profile")) return { exitCode: 1, stderr: "native profile failed" };
			return { exitCode: 0, stdout: NATIVE_SESSION_ID };
		},
	});

	expect(result).toBe(true);
	expect(calls.filter(call => call.command === "new-session")).toHaveLength(1);
	expect(calls.some(call => call.command === "kill-session")).toBe(false);
	expect(diagnostics).toEqual([expect.stringContaining("profile tagging failed. native profile failed")]);
});

it("refuses psmux without name-only mutation, retry, attach, or cleanup", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const diagnostics: string[] = [];
	expect(() =>
		launchDefaultTmuxIfNeeded({
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
				return { exitCode: 0, stdout: "" };
			},
		}),
	).toThrow("gjc_tmux_owner_isolation_native_session_identity_unavailable");
	expect(calls.filter(call => call.command === "new-session")).toHaveLength(0);
	expect(
		calls.some(call =>
			[
				"has-session",
				"rename-window",
				"set-option",
				"set-window-option",
				"resize-window",
				"attach-session",
				"kill-session",
			].includes(call.command),
		),
	).toBe(false);
	expect(diagnostics).toEqual([expect.stringContaining("psmux cannot provide immutable owner identity")]);
});

it("does not retry a native tmux attach os error 10061", () => {
	const calls: string[][] = [];
	launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "tmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			if (spawnArgs[0] === "new-session") return { exitCode: 0, stdout: "$0" };
			if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "tmux: os error 10061" };
			return { exitCode: 0, stdout: NATIVE_SESSION_ID };
		},
	});
	expect(calls.filter(call => call[0] === "attach-session")).toHaveLength(1);
	expect(calls.filter(call => call[0] === "new-session")).toHaveLength(1);
});

it("uses the captured native session ID for every post-create target", () => {
	const calls: string[][] = [];
	launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "tmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: { stdin: true, stdout: true, columns: 80, rows: 24 },
		tmuxAvailable: true,
		currentBranch: "main",
		existingBranchSessionName: null,
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			if (spawnArgs[0] === "new-session") return { exitCode: 0, stdout: "$0" };
			if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failure" };
			return { exitCode: 0, stdout: NATIVE_SESSION_ID };
		},
	});
	const targetFor = (command: string, option?: string) =>
		calls.filter(call => call[0] === command && (option === undefined || call.includes(option))).map(call => call[2]);
	expect(targetFor("has-session")).toEqual(["$0"]);
	expect(targetFor("attach-session")).toEqual(["$0"]);
	expect(targetFor("if-shell")).toEqual(["$0"]);
	expect(targetFor("set-window-option", "window-size")).toEqual(["$0:"]);
	expect(targetFor("rename-window")).toEqual(["$0"]);
	expect(targetFor("set-option", "@gjc-profile")).toEqual(["$0"]);
	expect(targetFor("set-option", "set-titles-string")).toEqual(["$0:"]);
});

it.each([
	[
		"unsafe",
		{ state: "unsafe" as const, pid: 9, startTime: "9", cgroup: { classification: "unsafe_service" as const } },
	],
	["unverifiable", { state: "unverifiable" as const }],
	["incomplete", { state: "safe" as const, pid: 1, cgroup: { classification: "safe" as const } }],
	["changed", { state: "safe" as const, pid: 2, startTime: "1", cgroup: { classification: "safe" as const } }],
])("surfaces %s cleanup proof uncertainty without killing the created session", (_label, uncertainProof) => {
	const calls: string[][] = [];
	let probeCount = 0;
	launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello"], tmux: true }),
		rawArgs: ["--tmux", "hello"],
		cwd: launchTestRoot,
		env: { GJC_TMUX_COMMAND: "tmux" },
		argv: ["bun", "cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: interactiveTty,
		tmuxAvailable: true,
		existingBranchSessionName: null,
		ownerIsolationProbe: {
			readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gjc.scope\n",
			probeServer: () => {
				probeCount++;
				return probeCount === 1
					? { state: "absent" as const }
					: probeCount === 5
						? uncertainProof
						: { state: "safe" as const, pid: 1, startTime: "1", cgroup: { classification: "safe" as const } };
			},
			recordAttempt: () => {},
		},
		diagnosticWriter: () => {},
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			if (spawnArgs[0] === "new-session") return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
			return { exitCode: 0 };
		},
	});
	expect(calls.filter(call => call[0] === "if-shell")).toEqual([]);
});

it.each([
	"",
	"not-a-session-id",
	"$0 trailing",
	"$-1",
])("fails closed and preserves a native session when new-session stdout is %p", stdout => {
	const calls: string[][] = [];
	const diagnostics: string[] = [];
	const handled = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "tmux" },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: "/bin/bun",
		platform: "linux",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: message => diagnostics.push(message),
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			return spawnArgs[0] === "new-session" ? { exitCode: 0, stdout } : { exitCode: 0 };
		},
	});

	expect(handled).toBe(true);
	expect(calls.map(call => call[0])).toEqual(["new-session"]);
	expect(diagnostics).toEqual([
		"gjc --tmux failed after creating tmux session: native session identity was unavailable; preserving session for recovery.\n",
	]);
});

describe("tmux owner isolation launch gate", () => {
	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
		__setCreateOwnerIsolationForTests(null);
		__setMutationServerProofForTests(null);
	});

	it("classifies a missing managed tmux server from default piped probe stderr", () => {
		const calls: string[][] = [];
		spyOn(Bun, "spawnSync").mockImplementation(options => {
			const command = "cmd" in options ? [...options.cmd] : [...options];
			calls.push(command);
			if (command[0] === "tmux") return spawnResult(1, "", "no server running on /tmp/tmux");
			if (command[0] === "systemd-run") return spawnResult(1, "", "scoped bootstrap intentionally stopped");
			return spawnResult(1, "", "unexpected command");
		});
		const handled = launchDefaultTmuxIfNeededRaw({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: launchTestRoot,
			env: {
				GJC_COORDINATOR_SESSION_STATE_FILE: path.join(launchTestRoot, "absent-server-state.json"),
			},
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			callerCgroupReader: () =>
				"0::/user.slice/user-1000.slice/user@1000.service/app.slice/clawdbot-gateway.service\n",
		});

		expect(handled).toBe(true);
		expect(calls.some(command => command[0] === "systemd-run")).toBe(true);
	});

	it("persists scoped launch capabilities exclusively at mode 0600 and fsyncs the file and parent directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-attempt-"));
		const opened: Array<{ file: fs.PathOrFileDescriptor; flags: string | number; mode?: string | number }> = [];
		const originalOpenSync = fs.openSync;
		spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
			opened.push({ file, flags, mode: mode ?? undefined });
			return originalOpenSync(file, flags, mode);
		});
		const fsyncSpy = spyOn(fs, "fsyncSync");
		try {
			spyOn(Bun, "spawnSync").mockImplementation(options => {
				const command = "cmd" in options ? [...options.cmd] : [...options];
				return command[0] === "tmux"
					? spawnResult(1, "", "no server running")
					: spawnResult(1, "", "scoped bootstrap intentionally stopped");
			});
			launchDefaultTmuxIfNeededRaw({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: {
					GJC_COORDINATOR_SESSION_ID: "persisted-attempt",
					GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
				},
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				existingBranchSessionName: null,
				callerCgroupReader: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gateway.service\n",
			});
			const lifecycleRoot = path.join(root, "persisted-attempt", "owner-lifecycle");
			const attempt = fs.readdirSync(lifecycleRoot).find(file => file.startsWith("attempt-"));
			expect(attempt).toBeDefined();
			expect(fs.statSync(path.join(lifecycleRoot, attempt!)).mode & 0o777).toBe(0o600);
			expect(opened).toContainEqual({ file: path.join(lifecycleRoot, attempt!), flags: "wx", mode: 0o600 });
			expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed rather than overwriting an existing scoped launch capability", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-attempt-"));
		const diagnostics: string[] = [];
		const originalOpenSync = fs.openSync;
		try {
			spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
				if (typeof file === "string" && path.basename(file).startsWith("attempt-") && flags === "wx") {
					const error = new Error("attempt exists");
					Object.defineProperty(error, "code", { value: "EEXIST" });
					throw error;
				}
				return originalOpenSync(file, flags, mode);
			});
			const handled = launchDefaultTmuxIfNeededRaw({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: { GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json") },
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "",
				existingBranchSessionName: null,
				callerCgroupReader: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gateway.service\n",
				diagnosticWriter: message => diagnostics.push(message),
				spawnSync: () => ({ exitCode: 0 }),
			});
			expect(handled).toBe(true);
			expect(diagnostics.join("\n")).toContain("server_unverifiable");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"unsafe",
			{ state: "unsafe" as const, pid: 123, startTime: "42", cgroup: { classification: "unsafe_service" as const } },
			"server_unsafe",
		],
		["unverifiable", { state: "unverifiable" as const }, "server_unverifiable"],
		["malformed safe", { state: "safe" as const }, "server_unverifiable"],
	])("rejects a %s Linux target server before every tmux mutation", (_label, proof, diagnostic) => {
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			ownerIsolationProbe: {
				readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gjc.scope\n",
				probeServer: () => proof,
				recordAttempt: () => {},
			},
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (_command, spawnArgs) => {
				calls.push(spawnArgs);
				return { exitCode: 0, stdout: NATIVE_SESSION_ID };
			},
		});
		expect(handled).toBe(true);
		expect(diagnostics.join("\n")).toContain(diagnostic);
		const mutatingCommands = new Set([
			"new-session",
			"set-option",
			"rename-window",
			"kill-session",
			"send-keys",
			"set-buffer",
			"paste-buffer",
			"delete-buffer",
		]);
		expect(calls.filter(call => mutatingCommands.has(call[0] ?? ""))).toEqual([]);
	});

	it("uses the scoped bootstrap receipt native ID for every post-create target", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		let probeCount = 0;
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: launchTestRoot,
			env: { GJC_TMUX_COMMAND: "tmux" },
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			ownerIsolationProbe: {
				readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/unsafe.service\n",
				probeServer: () =>
					++probeCount === 1
						? { state: "absent" }
						: { state: "safe", pid: 7, startTime: "77", cgroup: { classification: "safe" } },
				recordAttempt: () => {},
			},
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs });
				if (command === "systemd-run") {
					const request = JSON.parse(options.stdinLine ?? "") as { attempt: { session_name: string } };
					return {
						exitCode: 0,
						stdout: JSON.stringify({
							schema_version: 1,
							ok: true,
							code: "bootstrapped",
							native_session_id: "$42",
							server_pid: 7,
							server_start_time: "77",
							session_name: request.attempt.session_name,
						}),
					};
				}
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0, stdout: "$42" };
			},
		});
		expect(handled).toBe(true);
		const targets = (subcommand: string) =>
			calls
				.filter(call => call.command === "tmux" && call.args[0] === subcommand)
				.map(call => call.args[call.args.indexOf("-t") + 1]);
		expect(targets("rename-window")).toEqual(["$42"]);
		expect(targets("set-option")).toEqual(expect.arrayContaining(["$42", "$42:"]));
		expect(targets("set-option").every(target => target === "$42" || target === "$42:")).toBe(true);
		expect(targets("set-window-option").length).toBeGreaterThan(0);
		expect(targets("set-window-option").every(target => target === "$42" || target === "$42:")).toBe(true);
		expect(targets("attach-session")).toEqual(["$42"]);
		expect(targets("if-shell")).toEqual(["$42"]);
	});

	it.each([
		'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$42"} trailing',
		'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"not-an-id"}',
	])("does not mutate after a malformed scoped bootstrap receipt: %s", stdout => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: launchTestRoot,
			env: { GJC_TMUX_COMMAND: "tmux" },
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			ownerIsolationProbe: {
				readCallerCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/unsafe.service\n",
				probeServer: () => ({ state: "absent" }),
				recordAttempt: () => {},
			},
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return command === "systemd-run" ? { exitCode: 0, stdout } : { exitCode: 0 };
			},
		});
		expect(handled).toBe(true);
		expect(calls).toEqual([expect.objectContaining({ command: "systemd-run" })]);
	});

	it("does not title-mutate or attach an existing session after its server proof changes", () => {
		const calls: string[][] = [];
		let proofCount = 0;
		let swapCallIndex = -1;
		__setMutationServerProofForTests(() => {
			proofCount++;
			if (proofCount === 3) swapCallIndex = calls.length;
			return proofCount <= 2 ? { pid: 101, startTime: "a" } : { pid: 202, startTime: "b" };
		});
		spyOn(Bun, "spawnSync").mockImplementation(options => {
			const command = "cmd" in options ? [...options.cmd] : [...options];
			calls.push(command);
			if (command.includes("list-sessions"))
				return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t\n");
			if (command.includes("show-options")) return spawnResult(0, "1\n");
			if (command.includes("display-message")) return spawnResult(0, "$42\n");
			return spawnResult(0, "");
		});
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true, continue: true }),
			rawArgs: ["--tmux", "--continue", "hello"],
			cwd: launchTestRoot,
			env: { GJC_TMUX_COMMAND: "tmux" },
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "managed",
			diagnosticWriter: () => {},
		});
		expect(handled).toBe(true);
		expect(swapCallIndex).toBeGreaterThanOrEqual(0);
		expect(
			calls.slice(swapCallIndex).filter(call => ["set-option", "attach-session"].includes(call[1] ?? "")),
		).toEqual([]);
	});

	it("preserves a replacement server when native create proof changes before profile mutation", () => {
		const calls: string[][] = [];
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-create-proof-change-"));
		__setCreateOwnerIsolationForTests({
			probe: {
				readCallerCgroup: () => "0::/\n",
				probeServer: () => ({ state: "safe", pid: 101, startTime: "a", cgroup: { classification: "safe" } }),
			},
		});
		__setMutationServerProofForTests(() => ({ pid: 202, startTime: "b" }));
		spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
			calls.push(command);
			return command.includes("new-session") ? spawnResult(0, "$42\n") : spawnResult(0, "");
		}) as unknown as typeof Bun.spawnSync);
		const env = {
			GJC_TMUX_COMMAND: "tmux",
			GJC_TMUX_SESSION: "managed",
			GJC_COORDINATOR_SESSION_ID: "managed",
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
		};
		expect(() => createGjcTmuxSession(env)).toThrow("gjc_tmux_owner_changed_after_create");
		expect(calls.filter(call => ["set-option", "kill-session"].includes(call[1] ?? ""))).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("preserves a replacement server when native create status proof changes", () => {
		const calls: string[][] = [];
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-create-status-change-"));
		let proofCount = 0;
		__setCreateOwnerIsolationForTests({
			probe: {
				readCallerCgroup: () => "0::/\n",
				probeServer: () => ({ state: "safe", pid: 101, startTime: "a", cgroup: { classification: "safe" } }),
			},
		});
		__setMutationServerProofForTests(() =>
			++proofCount < 3 ? { pid: 101, startTime: "a" } : { pid: 202, startTime: "b" },
		);
		spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
			calls.push(command);
			if (command.includes("new-session")) return spawnResult(0, "$42\n");
			if (command.includes("list-sessions"))
				return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t\n");
			if (command.includes("display-message"))
				return spawnResult(0, command.includes("#{session_name}") ? "managed\n" : "$42\n");
			return spawnResult(0, "1\n");
		}) as unknown as typeof Bun.spawnSync);
		const env = {
			GJC_TMUX_COMMAND: "tmux",
			GJC_TMUX_SESSION: "managed",
			GJC_COORDINATOR_SESSION_ID: "managed",
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
		};
		expect(() => createGjcTmuxSession(env)).toThrow("gjc_tmux_owner_changed_after_create");
		expect(calls.filter(call => call[1] === "kill-session")).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("does not kill a native ID reused by a same-name replacement during removal", () => {
		const calls: string[][] = [];
		let proofCount = 0;
		__setMutationServerProofForTests(() =>
			++proofCount === 1 ? { pid: 101, startTime: "a" } : { pid: 202, startTime: "b" },
		);
		spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
			calls.push(command);
			if (command.includes("list-sessions"))
				return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t\n");
			if (command.includes("display-message")) return spawnResult(0, "$42\n");
			return spawnResult(0, "1\n");
		}) as unknown as typeof Bun.spawnSync);
		expect(() => removeGjcTmuxSession("managed", { GJC_TMUX_COMMAND: "tmux" })).toThrow(
			"gjc_tmux_owner_changed:managed",
		);
		expect(calls.filter(call => call[1] === "kill-session")).toEqual([]);
	});

	it("refuses psmux before any existing-session mutation", () => {
		const calls: string[][] = [];
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			expect(() =>
				launchDefaultTmuxIfNeeded({
					parsed: args({ messages: ["hello"], tmux: true, continue: true }),
					rawArgs: ["--tmux", "--continue", "hello"],
					cwd: launchTestRoot,
					env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
					argv: ["bun", "cli.ts"],
					execPath: "/bin/bun",
					platform: "win32",
					tty: interactiveTty,
					tmuxAvailable: true,
					currentBranch: "feature/demo",
					worktreeBranch: "feature/demo",
					existingBranchSessionName: "managed",
					spawnSync: (_command, spawnArgs) => {
						calls.push(spawnArgs);
						return { exitCode: 0 };
					},
				}),
			).toThrow("gjc_tmux_owner_isolation_native_session_identity_unavailable");
			expect(calls).toEqual([]);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("preserves a psmux session after attach failure without killing by reusable name", () => {
		const calls: string[][] = [];
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			expect(() =>
				launchDefaultTmuxIfNeeded({
					parsed: args({ messages: ["hello"], tmux: true }),
					rawArgs: ["--tmux", "hello"],
					cwd: launchTestRoot,
					env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
					argv: ["bun", "cli.ts"],
					execPath: "/bin/bun",
					platform: "win32",
					tty: interactiveTty,
					tmuxAvailable: true,
					existingBranchSessionName: null,
					spawnSync: (_command, spawnArgs) => {
						calls.push(spawnArgs);
						if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
						return { exitCode: 0 };
					},
				}),
			).toThrow("gjc_tmux_owner_isolation_native_session_identity_unavailable");
			expect(calls.some(call => call[0] === "kill-session")).toBe(false);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("refuses a server swap after new-session before profile or cleanup mutation", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-server-swap-"));
		try {
			const calls: string[][] = [];
			const diagnostics: string[] = [];
			let probeCount = 0;
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: { GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json") },
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: null,
				ownerIsolationProbe: {
					readCallerCgroup: () => "0::/\n",
					probeServer: () => ({
						state: "safe",
						pid: ++probeCount === 1 ? 101 : 202,
						startTime: "1",
						cgroup: { classification: "safe" },
					}),
					recordAttempt: () => {},
				},
				diagnosticWriter: message => diagnostics.push(message),
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});

			expect(handled).toBe(true);
			expect(diagnostics.join("\n")).toContain("server_race");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[0]).toBe("new-session");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes one generation and propagates its lifecycle metadata to the managed child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-owner-generation-"));
		try {
			const sessionId = "managed-owner-session";
			const stateFile = path.join(root, "runtime-state.json");
			const calls: string[][] = [];
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: {
					GJC_COORDINATOR_SESSION_ID: sessionId,
					GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				},
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: null,
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});
			expect(handled).toBe(true);
			const innerCommand = calls.find(call => call[0] === "new-session")?.at(-1);
			expect(innerCommand).toBeString();
			const generation = JSON.parse(
				fs.readFileSync(path.join(root, sessionId, "owner-lifecycle", "generation.json"), "utf8"),
			) as { generation: string; session_id: string };
			expect(generation.session_id).toBe(sessionId);
			expect(generation.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
			expect(innerCommand).toContain(`GJC_TMUX_OWNER_GENERATION='${generation.generation}'`);
			expect(innerCommand).toContain(`GJC_TMUX_OWNER_STATE_DIR='${root}'`);
			expect(innerCommand).toContain("GJC_TMUX_OWNER_SERVER_KEY='tmux'");
			expect(innerCommand).toStartWith("exec env GJC_TMUX_LAUNCHED=1");
			expect(innerCommand).toMatch(/GJC_MANAGED_OWNER_RUN_ID='[0-9a-f-]{36}'/i);
			expect(innerCommand).toMatch(/GJC_MANAGED_OWNER_INCARNATION='[0-9a-f-]{36}'/i);
			expect(innerCommand).not.toContain("GJC_MANAGED_OWNER_PREDECESSOR_TOKEN");
			expect(innerCommand).not.toContain("tmux-exit.json");
			expect(
				calls.some(call => call.includes("@gjc-owner-generation") && call.at(-1) === generation.generation),
			).toBe(true);
			expect(calls.some(call => call.includes("@gjc-owner-server-key") && call.at(-1) === "tmux")).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("propagates only an exact durable SIGABRT predecessor token into a replacement launch", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-replacement-"));
		try {
			const sessionId = "replacement-session";
			const generation = "replacement-generation";
			const runId = "replacement-run";
			const incarnation = "replacement-incarnation";
			const predecessorToken = "exact-predecessor";
			const ownerRoot = lifecyclePaths(root, sessionId, generation).root;
			fs.mkdirSync(ownerRoot, { recursive: true });
			fs.writeFileSync(
				lifecyclePaths(root, sessionId, generation).generationFile,
				`${JSON.stringify({ schema_version: 1, generation, session_id: sessionId, published_at: "2026-07-19T00:00:00.000Z" })}\n`,
			);
			const command = ["gjc", "--resume"];
			const commandSha256 = createHash("sha256").update(JSON.stringify(command)).digest("hex");
			fs.writeFileSync(
				path.join(ownerRoot, `child-${predecessorToken}.binding.json`),
				`${JSON.stringify({ schema_version: 2, generation, session_id: sessionId, run_id: runId, endpoint_incarnation: incarnation, child_token: predecessorToken, command, command_sha256: commandSha256, supervisor_pid: 1, supervisor_start_time: "1", created_at: "2026-07-19T00:00:00.000Z" })}\n`,
			);
			fs.writeFileSync(
				path.join(ownerRoot, `sigabrt-${predecessorToken}.receipt.json`),
				`${JSON.stringify({ schema_version: 2, generation, session_id: sessionId, run_id: runId, endpoint_incarnation: incarnation, child_token: predecessorToken, command_sha256: commandSha256, supervisor_pid: 1, supervisor_start_time: "1", child_pid: 2, child_start_time: "2", signal: "SIGABRT", signal_number: 6, exit_code: null, received_at: "2026-07-19T00:00:00.000Z" })}\n`,
			);
			const calls: string[][] = [];
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: {
					GJC_COORDINATOR_SESSION_ID: sessionId,
					GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
					GJC_TMUX_OWNER_STATE_DIR: root,
					GJC_TMUX_OWNER_GENERATION: generation,
					GJC_MANAGED_OWNER_RUN_ID: runId,
					GJC_MANAGED_OWNER_INCARNATION: incarnation,
					GJC_MANAGED_OWNER_PREDECESSOR_TOKEN: predecessorToken,
				},
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: null,
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});
			expect(handled).toBe(true);
			const innerCommand = calls.find(call => call[0] === "new-session")?.at(-1);
			expect(innerCommand).toContain(`GJC_MANAGED_OWNER_PREDECESSOR_TOKEN='${predecessorToken}'`);
			expect(innerCommand).toMatch(/GJC_TMUX_OWNER_GENERATION='[0-9a-f-]{36}'/i);
			expect(innerCommand).toMatch(/GJC_MANAGED_OWNER_RUN_ID='[0-9a-f-]{36}'/i);
			expect(innerCommand).toMatch(/GJC_MANAGED_OWNER_INCARNATION='[0-9a-f-]{36}'/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("exact-rolls back a spawned owner when generation publication loses its baseline", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-owner-generation-race-"));
		try {
			const sessionId = "managed-owner-race";
			const stateFile = path.join(root, "runtime-state.json");
			const calls: string[][] = [];
			const diagnostics: string[] = [];
			let replaced = false;
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: {
					GJC_COORDINATOR_SESSION_ID: sessionId,
					GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				},
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: null,
				diagnosticWriter: message => diagnostics.push(message),
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					if (!replaced && spawnArgs[0] === "set-option") {
						replaced = true;
						const baseline = captureOwnerGenerationBaselineSync(root, sessionId);
						replaceOwnerGenerationSync(root, sessionId, "competing-generation", baseline);
					}
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});
			expect(handled).toBe(true);
			expect(diagnostics.join("\n")).toContain("tmux owner lifecycle publication failed");
			expect(calls.some(call => call[0] === "if-shell")).toBe(true);
			expect(calls.some(call => call[0] === "attach-session")).toBe(false);
			expect(captureOwnerGenerationBaselineSync(root, sessionId)).toMatchObject({
				state: "current",
				generation: "competing-generation",
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists a fail-closed portable owner terminal verdict on Darwin", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-darwin-owner-finalization-"));
		const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "portable-owner",
				cwd: root,
				ownerTerminal: {
					generation: "2b3847de-1cbb-480d-8cad-1f8aa51b891a",
					stateDir: root,
					socketKey: "tmux",
				},
			});
			const payload = JSON.parse(
				fs.readFileSync(path.join(sessionRuntimeDir(root, "portable-owner"), "runtime-state.json"), "utf8"),
			) as Record<string, unknown>;
			expect(payload.event).toBe("owner_terminal");
			expect(payload.reason).toBe("owner_verdict_unavailable");
		} finally {
			if (previousPlatform) Object.defineProperty(process, "platform", previousPlatform);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("tmux owner-isolation scoped bootstrap receipt", () => {
	it.each([
		"",
		'{"schema_version":1,"ok":true,"code":"bootstrapped"}',
		'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"name"}',
		'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$0","extra":true}',
		'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$0"}\ntrailing',
	])("rejects scoped success receipt without one exact immutable native ID: %p", receipt => {
		expect(isExactScopedBootstrapSuccessReceipt(receipt)).toBe(false);
	});

	it("accepts only a bounded single-line receipt carrying an immutable native ID", () => {
		expect(
			isExactScopedBootstrapSuccessReceipt(
				'{"schema_version":1,"ok":true,"code":"bootstrapped","native_session_id":"$42","server_pid":7,"server_start_time":"77","session_name":"gajae_code"}',
			),
		).toBe(true);
	});
});
