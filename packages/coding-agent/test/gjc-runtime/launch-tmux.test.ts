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
import {
	__setBinaryResolverForTests,
	__setExecutableIdentityResolverForTests,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import { sessionRuntimeDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";

import {
	GJC_COORDINATOR_SIDECAR_KEY_ID_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV,
	persistCoordinatorRuntimeStateFromPostmortem,
} from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
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
import { SessionStateLockTestHooks } from "../../src/gjc-runtime/session-state-lock";

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
let launchStateSequence = 0;
const NATIVE_SESSION_ID = "$0";
const nativeTmux = process.platform === "win32" ? null : Bun.which("tmux");

function safeAbsentOwnerIsolationProbe(
	platform: NodeJS.Platform = "linux",
): NonNullable<TmuxLaunchContext["ownerIsolationProbe"]> {
	let serverCreated = false;
	return {
		readCallerCgroup: () =>
			platform === "linux" ? "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gjc.scope\n" : null,
		probeServer: () => {
			if (!serverCreated) {
				serverCreated = true;
				return { state: "absent" };
			}
			return {
				state: "safe",
				pid: 123,
				startTime: "42",
				cgroup: { classification: platform === "linux" ? "safe" : "not_applicable" },
			};
		},
		recordAttempt: () => {},
	};
}

function launchContext(context: TmuxLaunchContext): TmuxLaunchContext {
	return {
		platform: "linux",
		ownerIsolationProbe: safeAbsentOwnerIsolationProbe(context.platform ?? "linux"),
		...context,
		env: {
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(
				launchTestRoot,
				context.platform === "darwin" ? "darwin" : "runtime",
				`${launchStateSequence++}.json`,
			),
			GJC_TMUX_COMMAND: "tmux",
			GJC_PSMUX_DETECTION: "off",
			...(context.env ?? {}),
		},
	};
}

function launchDefaultTmuxIfNeeded(context: TmuxLaunchContext): boolean {
	let createdSessionName = context.env?.GJC_TMUX_SESSION;
	const suppliedSpawnSync = context.spawnSync;
	const psmuxMetadata = new Map<string, string>();
	return launchDefaultTmuxIfNeededRaw(
		launchContext({
			...context,
			providerAuthorityResolver:
				context.providerAuthorityResolver ??
				(input => ({
					kind: "windows-psmux",
					command: input.command,
					commandPrefix: ["-L", "gjc-test-000000000000000000000000000000000000"],
					namespace: "gjc-test-000000000000000000000000000000000000",
					executableIdentity: "test-psmux",
					binary: { command: input.command, isPsmux: true, viaExplicitOverride: true },
					platform: "win32",
					stateDir: input.stateDir,
					sessionId: input.sessionId,
					generation: input.generation,
				})),
			providerAuthorityPersist: context.providerAuthorityPersist ?? (() => {}),
			providerAuthorityStagedAssert: context.providerAuthorityStagedAssert ?? (() => {}),
			providerAuthorityAssert: context.providerAuthorityAssert ?? (() => {}),
			spawnSync: suppliedSpawnSync
				? (command, spawnArgs, options) => {
						const commandArgs =
							spawnArgs[0] === "-L" && spawnArgs[1]?.startsWith("gjc-test-") ? spawnArgs.slice(2) : spawnArgs;
						if (command === "systemd-run" && options.stdinLine) {
							try {
								createdSessionName = (JSON.parse(options.stdinLine) as { attempt?: { session_name?: string } })
									.attempt?.session_name;
							} catch {}
						}
						if (commandArgs[0] === "new-session") {
							const nameIndex = commandArgs.indexOf("-s");
							createdSessionName = commandArgs[nameIndex + 1] ?? createdSessionName;
						}
						const result = suppliedSpawnSync(command, commandArgs, options);
						if (commandArgs[0] === "set-option") {
							const option = commandArgs.at(-2);
							const value = commandArgs.at(-1);
							if (option?.startsWith("@gjc-") && value) psmuxMetadata.set(option, value);
						}
						if (
							commandArgs[0] === "display-message" &&
							commandArgs.at(-1) === "#{session_name}" &&
							result.exitCode === 0 &&
							!result.stdout?.trim()
						)
							return { ...result, stdout: createdSessionName ?? "gajae_code" };
						if (
							commandArgs[0] === "display-message" &&
							commandArgs.at(-1)?.startsWith("#{@gjc-") &&
							result.exitCode === 0 &&
							!result.stdout?.trim()
						) {
							const option = commandArgs.at(-1)!.slice(2, -1);
							return { ...result, stdout: psmuxMetadata.get(option) ?? "" };
						}
						const targetIndex = commandArgs.indexOf("-t");
						const nativeSessionId = targetIndex >= 0 ? commandArgs[targetIndex + 1] : NATIVE_SESSION_ID;
						if (
							commandArgs[0] === "display-message" &&
							commandArgs.at(-1) === "#{session_id}\t#{session_name}" &&
							result.exitCode === 0 &&
							(result.stdout?.trim() === nativeSessionId || !result.stdout?.trim())
						)
							return { ...result, stdout: `${nativeSessionId}\t${createdSessionName ?? "gajae_code"}` };
						if (
							commandArgs[0] === "if-shell" &&
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
let previousCoordinatorSessionId: string | undefined;
let previousCoordinatorStateFile: string | undefined;

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	previousCoordinatorSessionId = process.env.GJC_COORDINATOR_SESSION_ID;
	previousCoordinatorStateFile = process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
	delete process.env.GJC_COORDINATOR_SESSION_ID;
	delete process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
	__setBinaryResolverForTests(candidate => `C:\\gjc-test\\${candidate}.exe`);
	__setExecutableIdentityResolverForTests(() => "gjc-test-psmux");
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
	fs.rmSync(launchTestRoot, { recursive: true, force: true });
	if (previousCoordinatorSessionId === undefined) delete process.env.GJC_COORDINATOR_SESSION_ID;
	else process.env.GJC_COORDINATOR_SESSION_ID = previousCoordinatorSessionId;
	if (previousCoordinatorStateFile === undefined) delete process.env.GJC_COORDINATOR_SESSION_STATE_FILE;
	else process.env.GJC_COORDINATOR_SESSION_STATE_FILE = previousCoordinatorStateFile;
	__setBinaryResolverForTests(null);
	__setExecutableIdentityResolverForTests(null);
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

	it("quotes identity-guarded tmux window titles as one command argument", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/tmp/-repo",
			env: { TMUX: "/tmp/tmux", TMUX_PANE: "%9" },
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo';kill-window",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "%9\t@4\t1" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls[1]?.args).toEqual([
			"if-shell",
			"-t",
			"%9",
			"-F",
			"#{&&:#{==:#{pane_id},%9},#{&&:#{==:#{window_id},@4},#{==:#{window_index},1}}}",
			"rename-window -t @4 -- 'GJC--repo-feature/demo'\\'';kill-window'",
		]);
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
			env: { GJC_PSMUX_DETECTION: "off" },
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

	it("keeps the sidecar PKCS#8 private key out of tmux argv projections", () => {
		const privateKey = "private-pkcs8-der-base64";
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {
				GJC_PSMUX_DETECTION: "off",
				[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
				[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: privateKey,
				[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: "a".repeat(64),
			},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
		});
		expect(plan?.innerCommand).toBeDefined();
		expect(plan?.innerCommand).not.toContain(privateKey);
		expect(plan?.newSessionArgs.join(" ")).not.toContain(privateKey);
	});
	function coordinatorSidecarLaunchEnv(root: string, sessionId: string): Record<string, string> {
		return {
			GJC_TMUX_COMMAND: "tmux",
			GJC_PSMUX_DETECTION: "off",
			GJC_COORDINATOR_SESSION_ID: sessionId,
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
			[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
			[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: "pkcs8-private-key-material",
			[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: "a".repeat(64),
		};
	}

	function leftoverCoordinatorSidecarKeys(root: string): string[] {
		const scan = (dir: string): string[] =>
			fs
				.readdirSync(dir, { withFileTypes: true })
				.flatMap(entry =>
					entry.isDirectory()
						? scan(path.join(dir, entry.name))
						: entry.name.includes(".coordinator-sidecar-")
							? [path.join(dir, entry.name)]
							: [],
				);
		try {
			return scan(root);
		} catch {
			return [];
		}
	}

	it("never writes the coordinator sidecar bootstrap key when tmux is unavailable", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sidecar-unavailable-"));
		try {
			const diagnostics: string[] = [];
			const writeSpy = spyOn(fs, "writeFileSync");
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: coordinatorSidecarLaunchEnv(root, "sidecar-unavailable"),
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: false,
				existingBranchSessionName: null,
				diagnosticWriter: message => diagnostics.push(message),
			});
			expect(handled).toBe(true);
			expect(diagnostics).toEqual([
				"gjc --tmux requested but no tmux executable was found; cannot continue without a tmux-backed session.\n",
			]);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(leftoverCoordinatorSidecarKeys(root)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("never writes the coordinator sidecar bootstrap key when attaching an existing session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sidecar-attach-"));
		try {
			const calls: string[][] = [];
			__setMutationServerProofForTests(() => ({ pid: 101, startTime: "a" }));
			spyOn(Bun, "spawnSync").mockImplementation(((options: string[] | { cmd: string[] }) => {
				const command = "cmd" in options ? [...options.cmd] : [...options];
				calls.push(command);
				if (command.includes("list-sessions"))
					return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t\n");
				if (command.includes("show-options")) return spawnResult(0, "1\n");
				if (command.includes("display-message")) return spawnResult(0, "$42\n");
				return spawnResult(0, "");
			}) as unknown as typeof Bun.spawnSync);
			const writeSpy = spyOn(fs, "writeFileSync");
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true, continue: true }),
				rawArgs: ["--tmux", "--continue", "hello"],
				cwd: root,
				env: coordinatorSidecarLaunchEnv(root, "sidecar-attach"),
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "feature/demo",
				worktreeBranch: "feature/demo",
				existingBranchSessionName: "managed",
				diagnosticWriter: () => {},
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return { exitCode: 0 };
				},
			});
			expect(handled).toBe(true);
			expect(calls.some(call => call[0] === "attach-session")).toBe(true);
			expect(calls.some(call => call[0] === "new-session")).toBe(false);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(leftoverCoordinatorSidecarKeys(root)).toEqual([]);
		} finally {
			__setMutationServerProofForTests(null);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("scrubs the coordinator sidecar bootstrap key when the second attach proof fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sidecar-second-proof-"));
		try {
			const calls: string[][] = [];
			let proofCount = 0;
			__setMutationServerProofForTests(() => {
				proofCount++;
				return proofCount <= 2 ? { pid: 101, startTime: "a" } : { pid: 202, startTime: "b" };
			});
			spyOn(Bun, "spawnSync").mockImplementation(((options: string[] | { cmd: string[] }) => {
				const command = "cmd" in options ? [...options.cmd] : [...options];
				calls.push(command);
				if (command.includes("list-sessions"))
					return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t\n");
				if (command.includes("show-options")) return spawnResult(0, "1\n");
				if (command.includes("display-message")) return spawnResult(0, "$42\n");
				return spawnResult(0, "");
			}) as unknown as typeof Bun.spawnSync);
			const writeSpy = spyOn(fs, "writeFileSync");
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true, continue: true }),
				rawArgs: ["--tmux", "--continue", "hello"],
				cwd: root,
				env: coordinatorSidecarLaunchEnv(root, "sidecar-second-proof"),
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				currentBranch: "feature/demo",
				worktreeBranch: "feature/demo",
				existingBranchSessionName: "managed",
				diagnosticWriter: () => {},
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return { exitCode: 0 };
				},
			});
			expect(handled).toBe(true);
			expect(proofCount).toBeGreaterThanOrEqual(3);
			expect(calls.some(call => call[0] === "attach-session")).toBe(false);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(leftoverCoordinatorSidecarKeys(root)).toEqual([]);
		} finally {
			__setMutationServerProofForTests(null);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses a one-shot coordinator sidecar bootstrap endpoint only for the launching managed owner", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sidecar-launch-"));
		try {
			let commandBootstrapPath: string | undefined;
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello"], tmux: true }),
				rawArgs: ["--tmux", "hello"],
				cwd: root,
				env: coordinatorSidecarLaunchEnv(root, "sidecar-launch"),
				argv: ["bun", "cli.ts"],
				execPath: "/bin/bun",
				platform: "linux",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: null,
				diagnosticWriter: () => {},
				spawnSync: (_command, spawnArgs) => {
					if (spawnArgs[0] === "new-session") {
						const inner = spawnArgs.at(-1) ?? "";
						commandBootstrapPath = /GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL='([^']+)'/.exec(inner)?.[1];
					}
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});
			expect(handled).toBe(true);
			expect(commandBootstrapPath).toBeString();
			expect(commandBootstrapPath).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bootstrap\/[0-9a-f-]{36}$/i);
			expect(leftoverCoordinatorSidecarKeys(root)).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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

	it("creates a managed psmux session through the injected provider authority", () => {
		const calls: string[][] = [];
		try {
			expect(
				launchDefaultTmuxIfNeeded({
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
			const newSession = calls.find(call => call[0] === "new-session") ?? [];
			const sessionName = newSession[newSession.indexOf("-s") + 1];
			expect(calls.filter(call => call[0] === "new-session")).toHaveLength(1);
			expect(sessionName).toBeDefined();
			expect(newSession).toContain("-d");
			expect(calls.some(call => call[0] === "has-session")).toBe(true);
			expect(calls.some(call => call[0] === "attach-session")).toBe(true);
			expect(
				calls.some(
					call =>
						call[0] === "display-message" &&
						call.at(-1) === "#{session_name}" &&
						call.includes(sessionName ?? ""),
				),
			).toBe(true);
			expect(calls.filter(call => call[0] === "display-message" && call.at(-1)?.startsWith("#{@gjc-"))).toHaveLength(
				12,
			);
		} finally {
		}
	});
	it.each([
		["dropped", () => ({ exitCode: 1, stderr: "option missing" })],
		["changed", () => ({ exitCode: 0, stdout: "unexpected" })],
	] as const)("rejects %s required psmux ownership metadata before attach", (_case, metadataReadback) => {
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: ["--tmux"],
			cwd: "/repo",
			env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (_command, spawnArgs) => {
				calls.push(spawnArgs);
				if (spawnArgs[0] === "display-message" && spawnArgs.at(-1)?.startsWith("#{@gjc-"))
					return metadataReadback();
				return { exitCode: 0 };
			},
		});
		expect(calls.some(call => call[0] === "attach-session")).toBe(false);
		expect(diagnostics).toContain(
			"tmux required ownership metadata readback failed; preserving session without publication.\n",
		);
	});

	it.each([
		"GJC_COORDINATOR_SESSION_BRANCH",
		"GJC_COORDINATOR_SESSION_LAUNCH_ID",
		"GJC_COORDINATOR_SESSION_READINESS_FILE",
	])("manages psmux when %s is the only lifecycle marker", markerName => {
		const calls: string[][] = [];
		try {
			expect(
				launchDefaultTmuxIfNeeded({
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
			).toBe(true);
			expect(calls.some(call => call[0] === "new-session")).toBe(true);
		} finally {
		}
	});

	it("refuses an explicit psmux continuation without durable managed authority", () => {
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		try {
			launchDefaultTmuxIfNeeded({
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
			expect(calls.some(call => call[0] === "attach-session")).toBe(false);
			expect(diagnostics.length).toBeGreaterThan(0);
		} finally {
		}
	});

	it("preserves an unmanaged psmux session when foreground creation fails", () => {
		const results = [
			{ exitCode: 1, stderr: "no server running" },
			{ exitCode: 1, stderr: "create failed" },
		];
		const expectedCreates = 1;
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		try {
			launchDefaultTmuxIfNeeded({
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
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		expect(
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
		).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(false);
		expect(diagnostics.length).toBeGreaterThan(0);
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
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\native\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => "native-tmux");
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
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\native\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => "native-tmux");
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
			expect(calls.some(call => call.args[0] === "if-shell")).toBe(false);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(diagnostics[0]).toStartWith("gjc --tmux failed after creating tmux session: attach failed.");
		} finally {
			Object.defineProperty(stdout, "isTTY", { configurable: true, value: previousIsTTY });
		}
	});

	it("omits the server PID guard clause when cleaning up on a platform that cannot prove it", () => {
		// The non-Linux server probe reports a placeholder PID. Exact cleanup
		// therefore cannot prove the original server and must preserve the
		// provisional session rather than dispatching an unguarded destruction.
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const stdout = process.stdout as typeof process.stdout & { isTTY?: boolean };
		const previousIsTTY = stdout.isTTY;
		const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });

		try {
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
				diagnosticWriter: () => undefined,
				spawnSync: (command, spawnArgs, options) => {
					calls.push({ command, args: spawnArgs, options });
					if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
					return { exitCode: 0, stdout: NATIVE_SESSION_ID };
				},
			});

			expect(calls.some(call => call.args[0] === "if-shell")).toBe(false);
			expect(writeSpy).not.toHaveBeenCalled();
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

	it("renames the originating tmux window through an identity and index guard", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {
				TMUX: "/tmp/tmux",
				TMUX_PANE: "%7",
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
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "%7\t@3\t2" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			command: "tmux",
			args: ["display-message", "-p", "-t", "%7", "#{pane_id}\t#{window_id}\t#{window_index}"],
		});
		expect(calls[1]).toMatchObject({
			command: "tmux",
			args: [
				"if-shell",
				"-t",
				"%7",
				"-F",
				"#{&&:#{==:#{pane_id},%7},#{&&:#{==:#{window_id},@3},#{==:#{window_index},2}}}",
				"rename-window -t @3 -- 'GJC-repo-feature/demo'",
			],
		});
	});

	it("preserves tmux window names when the originating pane identity cannot be proven", () => {
		const cases = [
			{ name: "missing pane", env: { TMUX: "/tmp/tmux" }, stdout: "%7\t@3\t2" },
			{ name: "pane mismatch", env: { TMUX: "/tmp/tmux", TMUX_PANE: "%7" }, stdout: "%8\t@3\t2" },
			{ name: "invalid window id", env: { TMUX: "/tmp/tmux", TMUX_PANE: "%7" }, stdout: "%7\t3\t2" },
			{ name: "invalid window index", env: { TMUX: "/tmp/tmux", TMUX_PANE: "%7" }, stdout: "%7\t@3\told" },
		];

		for (const testCase of cases) {
			const calls: string[][] = [];
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello world"] }),
				rawArgs: ["hello world"],
				cwd: "/repo",
				env: testCase.env,
				argv: ["/usr/local/bin/gjc"],
				execPath: "/bin/bun",
				platform: "darwin",
				tty: interactiveTty,
				tmuxAvailable: true,
				existingBranchSessionName: null,
				currentBranch: "feature/demo",
				spawnSync: (_command, spawnArgs) => {
					calls.push(spawnArgs);
					return { exitCode: 0, stdout: testCase.stdout };
				},
			});

			expect(handled, testCase.name).toBe(false);
			expect(
				calls.some(call => call[0] === "rename-window"),
				testCase.name,
			).toBe(false);
			expect(
				calls.some(call => call[0] === "if-shell"),
				testCase.name,
			).toBe(false);
		}
	});

	it.skipIf(!nativeTmux)("keeps real tmux renames on the originating window and refuses index drift", () => {
		const tmuxCommand = nativeTmux;
		if (!tmuxCommand) throw new Error("tmux unavailable");
		const socket = `gjc-rename-${process.pid}-${Date.now()}`;
		const runTmux = (spawnArgs: string[]) =>
			Bun.spawnSync([tmuxCommand, "-L", socket, ...spawnArgs], {
				stdout: "pipe",
				stderr: "pipe",
			});
		const requireSuccess = (spawnArgs: string[]): SpawnSyncResult => {
			const result = runTmux(spawnArgs);
			expect(result.exitCode, `${spawnArgs.join(" ")}: ${result.stderr.toString()}`).toBe(0);
			return result;
		};

		try {
			requireSuccess(["new-session", "-d", "-s", "probe", "-n", "origin"]);
			requireSuccess(["new-window", "-t", "probe:1", "-n", "active"]);
			const paneId = requireSuccess(["display-message", "-p", "-t", "probe:0", "#{pane_id}"])
				.stdout.toString()
				.trim();
			const windowId = requireSuccess(["display-message", "-p", "-t", paneId, "#{window_id}"])
				.stdout.toString()
				.trim();
			const tmuxEnv = requireSuccess(["display-message", "-p", "-t", paneId, "#{socket_path},#{pid},0"])
				.stdout.toString()
				.trim();
			let moveAfterProbe = false;

			const invokeDirectLaunch = (branch: string): void => {
				const handled = launchDefaultTmuxIfNeeded({
					parsed: args({ messages: ["hello world"] }),
					rawArgs: ["hello world"],
					cwd: "/repo",
					env: { TMUX: tmuxEnv, TMUX_PANE: paneId, GJC_TMUX_COMMAND: tmuxCommand },
					argv: ["/usr/local/bin/gjc"],
					execPath: "/bin/bun",
					platform: "darwin",
					tty: interactiveTty,
					tmuxAvailable: true,
					existingBranchSessionName: null,
					currentBranch: branch,
					spawnSync: (_command, spawnArgs) => {
						const result = runTmux(spawnArgs);
						if (moveAfterProbe && spawnArgs[0] === "display-message" && result.exitCode === 0) {
							moveAfterProbe = false;
							requireSuccess(["move-window", "-s", windowId, "-t", "probe:2"]);
						}
						return {
							exitCode: result.exitCode,
							signalCode: result.signalCode,
							stdout: result.stdout.toString(),
							stderr: result.stderr.toString(),
						};
					},
				});
				expect(handled).toBe(false);
			};

			invokeDirectLaunch("feature/demo';kill-window");
			expect(
				requireSuccess(["display-message", "-p", "-t", windowId, "#{window_name}"]).stdout.toString().trim(),
			).toBe("GJC-repo-feature/demo';kill-window");
			expect(
				requireSuccess(["display-message", "-p", "-t", "probe:1", "#{window_name}"]).stdout.toString().trim(),
			).toBe("active");

			requireSuccess(["rename-window", "-t", windowId, "--", "origin"]);
			moveAfterProbe = true;
			invokeDirectLaunch("feature/drift");

			expect(
				requireSuccess(["display-message", "-p", "-t", windowId, "#{window_index}\t#{window_name}"])
					.stdout.toString()
					.trim(),
			).toBe("2\torigin");
			expect(
				requireSuccess(["display-message", "-p", "-t", "probe:1", "#{window_name}"]).stdout.toString().trim(),
			).toBe("active");
		} finally {
			runTmux(["kill-server"]);
		}
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
		expect(calls.some(call => call.args[0] === "if-shell")).toBe(false);
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
		expect(calls.some(call => call[0] === "if-shell")).toBe(false);
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
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0:", "mouse", "on"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0:", "@gjc-version", VERSION]);
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
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0:", "@gjc-profile", "1"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", "$0:", "@gjc-version", VERSION]);
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
	const handled = launchDefaultTmuxIfNeeded({
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

it("launches psmux through its managed provider namespace", () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const diagnostics: string[] = [];
	const handled = launchDefaultTmuxIfNeeded({
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
	});
	expect(handled).toBe(true);
	expect(calls.filter(call => call.command === "new-session")).toHaveLength(1);
	expect(calls.some(call => call.command === "attach-session")).toBe(true);
	expect(diagnostics).toEqual([]);
});
it("provisions psmux authority before generation publication and verifies later namespaced commands", () => {
	const events: string[] = [];
	const calls: string[][] = [];
	const namespace = "gjc-test-000000000000000000000000000000000000";
	let createdSessionName: string | undefined;
	const metadata = new Map<string, string>();
	const handled = launchDefaultTmuxIfNeededRaw(
		launchContext({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			providerAuthorityResolver: input => ({
				kind: "windows-psmux",
				command: input.command,
				commandPrefix: ["-L", namespace],
				namespace,
				executableIdentity: "test-psmux",
				binary: { command: input.command, isPsmux: true, viaExplicitOverride: true },
				platform: "win32",
				stateDir: input.stateDir,
				sessionId: input.sessionId,
				generation: input.generation,
			}),
			providerAuthorityPersist: () => events.push("persist"),
			providerAuthorityStagedAssert: () => events.push("staged-assert"),
			providerAuthorityAssert: () => events.push("assert"),
			spawnSync: (_command, spawnArgs) => {
				expect(spawnArgs.slice(0, 2)).toEqual(["-L", namespace]);
				const commandArgs = spawnArgs.slice(2);
				if (commandArgs[0] === "new-session") createdSessionName = commandArgs[commandArgs.indexOf("-s") + 1];
				calls.push(spawnArgs);
				if (commandArgs[0] === "set-option") metadata.set(commandArgs.at(-2)!, commandArgs.at(-1)!);
				if (commandArgs[0] === "display-message") {
					if (commandArgs.at(-1) === "#{session_name}") return { exitCode: 0, stdout: createdSessionName };
					const option = commandArgs.at(-1)?.match(/^#\{(.+)\}$/)?.[1];
					return { exitCode: 0, stdout: option ? (metadata.get(option) ?? "") : "" };
				}
				return { exitCode: 0, stdout: "" };
			},
		}),
	);
	expect(handled).toBe(true);
	expect(calls.length).toBeGreaterThan(0);
	expect(events[0]).toBe("persist");
	expect(events).toContain("staged-assert");
	expect(events.at(-1)).toBe("assert");
	expect(metadata.get("@gjc-psmux-incarnation")).toMatch(/^[0-9a-f-]{36}$/);
});
it("does not recreate a published psmux session after attach recovery finds it missing", () => {
	const calls: string[][] = [];
	const diagnostics: string[] = [];
	let published = false;
	let attachAttempted = false;
	let sessionTarget = "";
	const handled = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
		argv: ["bun", "cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		providerAuthorityPersist: () => {
			published = true;
		},
		diagnosticWriter: message => diagnostics.push(message),
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			if (spawnArgs[0] === "attach-session") {
				attachAttempted = true;
				return { exitCode: 1, stderr: "psmux: os error 10061" };
			}
			if (spawnArgs[0] === "has-session") {
				sessionTarget = spawnArgs[2] ?? sessionTarget;
				if (attachAttempted)
					return {
						exitCode: 1,
						stderr: `psmux: can't find session '${sessionTarget}' (no server running)`,
					};
			}
			return { exitCode: 0, stdout: "" };
		},
	});

	expect(handled).toBe(true);
	expect(published).toBe(true);
	expect(sessionTarget).not.toStartWith("=");
	expect(calls.filter(call => call[0] === "new-session")).toHaveLength(1);
	expect(calls.filter(call => call[0] === "attach-session")).toHaveLength(1);
	expect(diagnostics).toEqual([
		"tmux attach recovery found the published session missing; preserving lifecycle state without recreation.\n",
	]);
});
it("does not retry attach recovery when published psmux metadata no longer proves ownership", () => {
	const calls: string[][] = [];
	const diagnostics: string[] = [];
	let attachAttempted = false;
	const handled = launchDefaultTmuxIfNeeded({
		parsed: args({ messages: ["hello world"], tmux: true }),
		rawArgs: ["--tmux", "hello world"],
		cwd: "/repo",
		env: { GJC_TMUX_COMMAND: "psmux", GJC_PSMUX_COMMAND: "psmux" },
		argv: ["bun", "cli.ts"],
		execPath: "/bin/bun",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
		diagnosticWriter: message => diagnostics.push(message),
		spawnSync: (_command, spawnArgs) => {
			calls.push(spawnArgs);
			if (spawnArgs[0] === "attach-session") {
				attachAttempted = true;
				return { exitCode: 1, stderr: "psmux: os error 10061" };
			}
			if (attachAttempted && spawnArgs.at(-1) === "#{@gjc-profile}") return { exitCode: 0, stdout: "wrong-profile" };
			return { exitCode: 0, stdout: "" };
		},
	});

	expect(handled).toBe(true);
	expect(calls.filter(call => call[0] === "attach-session")).toHaveLength(1);
	expect(diagnostics).toEqual([
		"tmux created session proof failed after attach recovery probe; preserving session without attach.\n",
	]);
});
it("keeps a failed provisional authority publication inactive and permits a retry without a predecessor", () => {
	const events: string[] = [];
	const stateFile = path.join(launchTestRoot, "failed-provisional-authority-retry.json");
	const lifecycleRoot = path.join(path.dirname(stateFile), TEST_SESSION_ID, "owner-lifecycle");
	let failAfterWrite = true;
	const context = (): TmuxLaunchContext =>
		launchContext({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {
				GJC_TMUX_COMMAND: "psmux",
				GJC_PSMUX_COMMAND: "psmux",
				GJC_COORDINATOR_SESSION_ID: TEST_SESSION_ID,
				GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
			},
			argv: ["bun", "cli.ts"],
			execPath: "/bin/bun",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			providerAuthorityPersist: () => {
				events.push("authority-write");
				if (failAfterWrite) {
					failAfterWrite = false;
					throw new Error("after-authority-write-before-generation-swap");
				}
			},
			providerAuthorityAssert: () => events.push("assert"),
			providerAuthorityStagedAssert: () => events.push("staged-assert"),
			diagnosticWriter: () => {},
			spawnSync: () => ({ exitCode: 0, stdout: "" }),
		});

	expect(launchDefaultTmuxIfNeeded(context())).toBe(true);
	expect(fs.existsSync(path.join(lifecycleRoot, "generation.json"))).toBe(false);
	expect(events).toEqual(["authority-write"]);

	expect(launchDefaultTmuxIfNeeded(context())).toBe(true);
	const generation = JSON.parse(fs.readFileSync(path.join(lifecycleRoot, "generation.json"), "utf8")) as {
		predecessor?: unknown;
	};
	expect(generation.predecessor).toBeUndefined();
	expect(events.filter(event => event === "authority-write")).toHaveLength(2);
	expect(events).toContain("assert");
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
	expect(targetFor("if-shell")).toEqual([]);
	expect(targetFor("set-window-option", "window-size")).toEqual(["$0:"]);
	expect(targetFor("rename-window")).toEqual(["$0"]);
	expect(targetFor("set-option", "@gjc-profile")).toEqual(["$0:"]);
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
	expect(calls.some(call => call[0] === "display-message")).toBe(true);
	expect(calls.some(call => call[0] === "kill-session")).toBe(false);
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

	it("fails closed when a simulated Linux server probe cannot establish host identity", () => {
		const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
		const calls: string[][] = [];
		spyOn(Bun, "spawnSync").mockImplementation(options => {
			const command = "cmd" in options ? [...options.cmd] : [...options];
			calls.push(command);
			if (command[0]?.endsWith("tmux.exe")) return spawnResult(1, "", "no server running on /tmp/tmux");
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
		if (previousPlatform) Object.defineProperty(process, "platform", previousPlatform);

		expect(handled).toBe(true);
		expect(calls.some(command => command[0] === "systemd-run")).toBe(false);
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
			expect(fs.statSync(path.join(lifecycleRoot, attempt!)).mode & 0o777).toBe(
				process.platform === "win32" ? 0o666 : 0o600,
			);
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
		expect(targets("set-option")).toEqual(expect.arrayContaining(["$42:"]));
		expect(targets("set-option").every(target => target === "$42:")).toBe(true);
		expect(targets("set-window-option").length).toBeGreaterThan(0);
		expect(targets("set-window-option").every(target => target === "$42" || target === "$42:")).toBe(true);
		expect(targets("attach-session")).toEqual(["$42"]);
		expect(targets("if-shell")).toEqual([]);
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
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\native\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => "native-tmux");
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
		spyOn(Bun, "spawnSync").mockImplementation(((options: string[] | { cmd: string[] }) => {
			const command = "cmd" in options ? [...options.cmd] : [...options];
			calls.push(command);
			if (command.includes("new-session")) return spawnResult(0, "$42\n");
			if (command.includes("list-sessions"))
				return spawnResult(0, "managed\t1\t0\t1770000000\t1\troot\t0\t\t\t\t\t\t\t\t\n");
			if (command.includes("display-message")) {
				if (command.includes("#{session_id}\t#{session_name}")) return spawnResult(0, "$42\tmanaged\n");
				return spawnResult(0, command.includes("#{session_name}") ? "managed\n" : "$42\n");
			}
			return spawnResult(0, "1\n");
		}) as unknown as typeof Bun.spawnSync);
		const env = {
			GJC_TMUX_COMMAND: "tmux",
			GJC_TMUX_SESSION: "managed",
			GJC_COORDINATOR_SESSION_ID: "managed",
			GJC_COORDINATOR_SESSION_STATE_FILE: path.join(root, "runtime-state.json"),
		};
		expect(() => createGjcTmuxSession(env)).toThrow("gjc_tmux_precommit_failed_cleanup_failed");
		expect(calls.filter(call => call[1] === "kill-session")).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("does not kill a native ID reused by a same-name replacement during removal", () => {
		const calls: string[][] = [];
		__setBinaryResolverForTests(candidate => (candidate === "tmux" ? "C:\\native\\tmux.exe" : null));
		__setExecutableIdentityResolverForTests(() => "native-tmux");
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
		expect(
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
		).toBe(true);
		expect(calls.some(call => call[0] === "attach-session")).toBe(false);
	});

	it("preserves a psmux session after attach failure without killing by reusable name", () => {
		const calls: string[][] = [];
		expect(
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
		).toBe(true);
		expect(calls.some(call => call[0] === "kill-session")).toBe(false);
		expect(calls.some(call => call[0] === "if-shell")).toBe(false);
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
					[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
					[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: "managed-private-pkcs8-der-base64",
					[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: "a".repeat(64),
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
			expect(innerCommand).not.toContain("managed-private-pkcs8-der-base64");
			expect(innerCommand).toStartWith("exec env GJC_TMUX_LAUNCHED=1");
			expect(innerCommand).toMatch(
				/GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL='http:\/\/127\.0\.0\.1:\d+\/bootstrap\/[0-9a-f-]{36}'/i,
			);
			expect(innerCommand).not.toContain("__gjc_sidecar_key");
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
		if (process.platform !== "linux") return;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-replacement-"));
		try {
			const sessionId = "replacement-session";
			const supervisorPid = process.pid;
			const supervisorStat = fs.readFileSync(`/proc/${supervisorPid}/stat`, "utf8");
			const supervisorStartTime = supervisorStat
				.slice(supervisorStat.lastIndexOf(")") + 1)
				.trim()
				.split(/\s+/)[19]!;
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
				`${JSON.stringify({ schema_version: 2, generation, session_id: sessionId, run_id: runId, endpoint_incarnation: incarnation, child_token: predecessorToken, command, command_sha256: commandSha256, supervisor_pid: supervisorPid, supervisor_start_time: supervisorStartTime, created_at: "2026-07-19T00:00:00.000Z" })}\n`,
			);
			fs.writeFileSync(
				path.join(ownerRoot, `sigabrt-${predecessorToken}.receipt.json`),
				`${JSON.stringify({ schema_version: 2, generation, session_id: sessionId, run_id: runId, endpoint_incarnation: incarnation, child_token: predecessorToken, command_sha256: commandSha256, supervisor_pid: supervisorPid, supervisor_start_time: supervisorStartTime, child_pid: 2, child_start_time: "2", signal: "SIGABRT", signal_number: 6, exit_code: null, received_at: "2026-07-19T00:00:00.000Z" })}\n`,
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
			const cleanup = calls.find(call => call[0] === "if-shell");
			expect(cleanup).toEqual(
				expect.arrayContaining([
					"if-shell",
					"-t",
					NATIVE_SESSION_ID,
					"-F",
					expect.stringContaining(`#{==:#{session_id},${NATIVE_SESSION_ID}}`),
					`kill-session -t ${NATIVE_SESSION_ID} \\; display-message -p __gjc_tmux_guarded_cleanup_ok__`,
					"display-message -p __gjc_tmux_guarded_cleanup_refused__",
				]),
			);
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
		if (process.platform !== "darwin") return;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-darwin-owner-finalization-"));
		const runtimeRoot = path.join(root, "runtime");
		const ownerRoot = path.join(root, "owner-lifecycle");
		try {
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "portable-owner",
				cwd: runtimeRoot,
				ownerTerminal: {
					generation: "2b3847de-1cbb-480d-8cad-1f8aa51b891a",
					stateDir: ownerRoot,
					socketKey: "tmux",
				},
			});
			const payload = JSON.parse(
				fs.readFileSync(path.join(sessionRuntimeDir(runtimeRoot, "portable-owner"), "runtime-state.json"), "utf8"),
			) as Record<string, unknown>;
			expect(payload.event).toBe("owner_terminal");
			expect(payload.reason).toBe("owner_verdict_unavailable");
		} finally {

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
