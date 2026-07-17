import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Args } from "../src/cli/args";
import { parseArgs } from "../src/cli/args";
import {
	BARE_RESUME_CONFLICT_ERROR,
	BARE_RESUME_INTERACTIVE_ERROR,
	BARE_RESUME_OPEN_ERROR,
	runInteractiveMode,
	runRootCommand,
	StartupUpdateOrchestrator,
} from "../src/main";
import type { InteractiveMode } from "../src/modes/interactive-mode";
import type { AgentSession } from "../src/session/agent-session";
import type { ResumeSessionIdentity, SessionInfo } from "../src/session/session-manager";

const identity: ResumeSessionIdentity = {
	canonicalPath: "/sessions/selected.jsonl",
	sessionId: "selected",
	dev: 1n,
	ino: 1n,
	size: 1,
	mtimeMs: 1,
	mtimeNs: 1_000_000n,
	sha256: "hash",
};

const sessionInfo: SessionInfo = {
	path: identity.canonicalPath,
	id: identity.sessionId,
	cwd: "/worktree",
	created: new Date(0),
	modified: new Date(0),
	messageCount: 1,
	size: 1,
	firstMessage: "resume",
	allMessagesText: "resume",
};

afterEach(() => {
	process.exitCode = undefined;
});

function bareArgs(overrides: Partial<Args> = {}): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), resume: true, ...overrides };
}

function resumeStartup(): StartupUpdateOrchestrator {
	return new StartupUpdateOrchestrator(
		"interactive",
		() => false,
		async () => undefined,
	);
}

async function captureStderr(operation: () => Promise<void>): Promise<string> {
	const originalWrite = process.stderr.write;
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		await operation();
	} finally {
		process.stderr.write = originalWrite;
	}
	return stderr;
}

async function expectEarlyBareResumeRejection(args: Args, isResumePickerTerminal: boolean): Promise<string> {
	const originalExitCode = process.exitCode;
	let authDiscoveries = 0;
	let settingsInitializations = 0;
	let stdinReads = 0;
	let pickerLists = 0;
	const never = Promise.withResolvers<string | undefined>();
	const stderr = await captureStderr(async () => {
		await runRootCommand(args, [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => isResumePickerTerminal,
			discoverAuthStorage: async () => {
				authDiscoveries++;
				throw new Error("auth discovery must not run");
			},
			initializeSettings: async () => {
				settingsInitializations++;
				throw new Error("settings initialization must not run");
			},
			readPipedInput: async () => {
				stdinReads++;
				return await never.promise;
			},
			listForResumePickerReadOnly: async () => {
				pickerLists++;
				return [sessionInfo];
			},
		});
	});
	expect(authDiscoveries).toBe(0);
	expect(settingsInitializations).toBe(0);
	expect(stdinReads).toBe(0);
	expect(pickerLists).toBe(0);
	expect(process.exitCode).toBe(originalExitCode);
	return stderr;
}

describe("bare resume startup gating", () => {
	it("gives conflicts precedence in both argv orders and combined forms before every startup dependency", async () => {
		for (const args of [
			parseArgs(["--resume", "--continue"]),
			parseArgs(["--continue", "--resume"]),
			parseArgs(["--resume", "-c"]),
			parseArgs(["-c", "--resume"]),
			parseArgs(["--resume", "--fork", "source"]),
			parseArgs(["--fork", "source", "--resume"]),
			parseArgs(["--resume", "--no-session"]),
			parseArgs(["--no-session", "--resume"]),
			parseArgs(["--resume", "--continue", "--fork", "source", "--no-session"]),
			parseArgs(["--no-session", "--fork", "source", "--continue", "--resume"]),
		]) {
			expect(await expectEarlyBareResumeRejection(args, false)).toBe(`${BARE_RESUME_CONFLICT_ERROR}\n`);
		}
	});

	it("rejects the normal local route when stdin or stdout is not a TTY before startup work", async () => {
		expect(await expectEarlyBareResumeRejection(bareArgs(), false)).toBe(`${BARE_RESUME_INTERACTIVE_ERROR}\n`);
	});

	it("rejects the TTY-backed print route before startup work", async () => {
		expect(await expectEarlyBareResumeRejection(bareArgs({ print: true }), true)).toBe(
			`${BARE_RESUME_INTERACTIVE_ERROR}\n`,
		);
	});

	it("preserves undefined, zero, and nonzero exit codes in isolated route probes", async () => {
		for (const exitCode of ["undefined", "0", "7"]) {
			const probe = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures/resume-exit-code-probe.ts"), exitCode],
				{
					cwd: path.join(import.meta.dir, ".."),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [status, stderr] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);
			expect(status).toBe(0);
			expect(stderr).toBe(`${BARE_RESUME_INTERACTIVE_ERROR}\n`);
		}
	});

	it("handles empty inventory, cancellation, and strict-open failure without fallback", async () => {
		let pickerCalls = 0;
		let opens = 0;
		let listedCwd: string | undefined;
		let listedSessionDir: string | undefined;
		const pickerEvents: string[] = [];
		await runRootCommand(bareArgs({ sessionDir: "/sessions/custom" }), [], {
			suppressProcessExit: true,
			initTheme: async () => {
				pickerEvents.push("theme");
			},
			isResumePickerTerminal: () => true,
			listForResumePickerReadOnly: async (cwd, sessionDir) => {
				pickerEvents.push("list");
				listedCwd = cwd;
				listedSessionDir = sessionDir;
				return [];
			},
			selectResumeSession: async () => {
				pickerCalls++;
				return { kind: "cancelled" };
			},
			openExistingSessionStrict: async () => {
				opens++;
				return { kind: "error", reason: "missing" };
			},
		});
		expect(pickerEvents).toEqual(["theme", "list"]);
		expect(listedCwd).toBe(process.cwd());
		expect(listedSessionDir).toBe("/sessions/custom");
		expect(pickerCalls).toBe(0);
		expect(opens).toBe(0);

		await runRootCommand(bareArgs(), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			listForResumePickerReadOnly: async () => [sessionInfo],
			selectResumeSession: async () => ({ kind: "cancelled" }),
			openExistingSessionStrict: async () => {
				opens++;
				return { kind: "error", reason: "missing" };
			},
		});
		expect(opens).toBe(0);

		await runRootCommand(bareArgs(), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			listForResumePickerReadOnly: async () => [sessionInfo],
			selectResumeSession: async () => ({ kind: "selected", path: sessionInfo.path, identity, action: "open-idle" }),
			openExistingSessionStrict: async selected => {
				opens++;
				expect(selected).toBe(identity);
				return { kind: "error", reason: "identity-mismatch" };
			},
		});
		expect(opens).toBe(1);
		expect(BARE_RESUME_OPEN_ERROR).toBe("Could not open the selected session. Use --resume <id>.");
	});
});

it("bounds a rejected strict-open promise to one error before session startup or fallback", async () => {
	let authDiscoveries = 0;
	let sessionCreations = 0;
	const stderr = await captureStderr(async () => {
		await runRootCommand(bareArgs(), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			listForResumePickerReadOnly: async () => [sessionInfo],
			selectResumeSession: async () => ({
				kind: "selected",
				path: sessionInfo.path,
				identity,
				action: "open-idle",
			}),
			openExistingSessionStrict: async () => {
				throw new Error("injected strict-open rejection");
			},
			discoverAuthStorage: async () => {
				authDiscoveries++;
				throw new Error("auth discovery must not run");
			},
			createAgentSession: async () => {
				sessionCreations++;
				throw new Error("session creation must not run");
			},
		});
	});
	expect(stderr).toBe(`${BARE_RESUME_OPEN_ERROR}\n`);
	expect(authDiscoveries).toBe(0);
	expect(sessionCreations).toBe(0);
});

describe("resume continuation after interactive initialization", () => {
	it("continues tail exactly once after render and leaves terminal sessions idle", async () => {
		const events: string[] = [];
		const session = {
			continuePersistedHistory: async () => {
				events.push("continue");
			},
			prompt: async (text: string) => {
				events.push(`prompt:${text}`);
			},
		} as unknown as AgentSession;
		const stop = new Error("stop");
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => events.push("render"),
				showError: () => {},
				getUserInput: async () => {
					throw stop;
				},
			}) as unknown as InteractiveMode;

		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				resumeStartup(),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				"continue-tail",
			),
		).rejects.toBe(stop);
		expect(events).toEqual(["init", "render", "continue"]);

		events.splice(0);
		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				resumeStartup(),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				"open-idle",
			),
		).rejects.toBe(stop);
		expect(events).toEqual(["init", "render"]);
	});

	it("submits explicit startup input instead of continuing persisted history", async () => {
		const events: string[] = [];
		const session = {
			continuePersistedHistory: async () => events.push("continue"),
			prompt: async (text: string) => events.push(`prompt:${text}`),
		} as unknown as AgentSession;
		const stop = new Error("stop");
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => events.push("render"),
				showError: () => {},
				getUserInput: async () => {
					throw stop;
				},
			}) as unknown as InteractiveMode;
		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				resumeStartup(),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				"startup",
				undefined,
				createMode,
				"continue-tail",
			),
		).rejects.toBe(stop);
		expect(events).toEqual(["init", "render", "prompt:startup"]);
	});
});
