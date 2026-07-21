import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "../src/cli/args";
import { parseArgs } from "../src/cli/args";
import type { Settings } from "../src/config/settings";
import {
	BARE_RESUME_CONFLICT_ERROR,
	BARE_RESUME_INTERACTIVE_ERROR,
	BARE_RESUME_OPEN_ERROR,
	createSessionManager,
	runInteractiveMode,
	runRootCommand,
	StartupUpdateOrchestrator,
} from "../src/main";
import type { InteractiveMode } from "../src/modes/interactive-mode";
import type { AgentSession } from "../src/session/agent-session";
import {
	type ResumeSessionIdentity,
	type SessionDestination,
	type SessionInfo,
	SessionManager,
} from "../src/session/session-manager";

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
	vi.restoreAllMocks();
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

	it("keeps cancellation from loading settings or touching managed settings/config/agent storage", async () => {
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

		let settingsLoads = 0;
		const stdoutWrite = spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await runRootCommand(bareArgs(), [], {
				suppressProcessExit: true,
				isResumePickerTerminal: () => true,
				listManagedForResumePickerReadOnly: async () => [sessionInfo],
				selectResumeSession: async () => ({ kind: "cancelled" }),
				loadSettingsForScope: async () => {
					settingsLoads++;
					throw new Error("settings must not load before picker consent");
				},
				openExistingSessionStrict: async () => {
					opens++;
					return { kind: "error", reason: "missing" };
				},
			});
		} finally {
			stdoutWrite.mockRestore();
			stderrWrite.mockRestore();
		}
		expect(settingsLoads).toBe(0);
		expect(stdoutWrite).not.toHaveBeenCalled();
		expect(stderrWrite).not.toHaveBeenCalled();
		expect(opens).toBe(0);

		await runRootCommand(bareArgs(), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			listManagedForResumePickerReadOnly: async () => [sessionInfo],
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

	it("uses the scoped managed root for default inventory and strict-open authority", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-managed-root-"));
		let listedAgentDir: string | undefined;
		let openedIdentity: ResumeSessionIdentity | undefined;
		let openedDestination: SessionDestination | undefined;
		await runRootCommand(bareArgs(), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			resolveManagedAgentDirForScope: () => agentDir,
			loadSettingsForScope: async () =>
				({
					getAgentDir: () => agentDir,
					get: () => "copy-retain",
				}) as unknown as Settings,
			listManagedForResumePickerReadOnly: async (_cwd, managedAgentDir) => {
				listedAgentDir = managedAgentDir;
				return [sessionInfo];
			},
			selectResumeSession: async () => ({ kind: "selected", path: sessionInfo.path, identity, action: "open-idle" }),
			openExistingSessionStrict: async (selected, destination) => {
				openedIdentity = selected;
				openedDestination = destination;
				return { kind: "error", reason: "identity-mismatch" };
			},
		});
		expect(listedAgentDir).toBe(agentDir);
		expect(openedIdentity).toBe(identity);
		expect(openedDestination).toMatchObject({ kind: "managed" });
		if (openedDestination?.kind !== "managed") throw new Error("Expected managed destination");
		expect(openedDestination.securityContext.agentDir).toBe(agentDir);
	});

	it("keeps explicit picker directories out of managed destination handling", async () => {
		let listedAgentDir: string | undefined;
		let openedDestination: SessionDestination | undefined;
		await runRootCommand(bareArgs({ sessionDir: "/explicit" }), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			resolveManagedAgentDirForScope: () => {
				throw new Error("explicit picker inventory must not resolve a managed root");
			},
			loadSettingsForScope: async () =>
				({ getAgentDir: () => "/custom-agent", get: () => "copy-retain" }) as unknown as Settings,
			listForResumePickerReadOnly: async () => {
				return [sessionInfo];
			},
			selectResumeSession: async () => ({ kind: "selected", path: sessionInfo.path, identity, action: "open-idle" }),
			openExistingSessionStrict: async (_selected, destination) => {
				openedDestination = destination;
				return { kind: "error", reason: "identity-mismatch" };
			},
		});
		expect(listedAgentDir).toBeUndefined();
		expect(openedDestination).toEqual({ kind: "explicit", directory: "/explicit" });
	});
});

describe("explicit resume destination authority", () => {
	it("binds both direct resume path forms to the supplied explicit session directory", async () => {
		const open = vi.spyOn(SessionManager, "open").mockResolvedValue({} as SessionManager);
		const activeSettings = {
			get: () => "copy-retain",
			getAgentDir: () => "/managed-agent",
		} as unknown as Settings;
		for (const resume of ["/source/session.jsonl", "session.jsonl"]) {
			await createSessionManager(
				parseArgs(["--resume", resume, "--session-dir", "/explicit-destination"]),
				"/workspace",
				activeSettings,
			);
		}
		expect(open).toHaveBeenNthCalledWith(
			1,
			"/source/session.jsonl",
			expect.objectContaining({ kind: "explicit", directory: "/explicit-destination" }),
			undefined,
			"copy-retain",
		);
		expect(open).toHaveBeenNthCalledWith(
			2,
			"session.jsonl",
			expect.objectContaining({ kind: "explicit", directory: "/explicit-destination" }),
			undefined,
			"copy-retain",
		);
	});

	it("binds a direct resume path without --session-dir to its parent directory", async () => {
		const open = vi.spyOn(SessionManager, "open").mockResolvedValue({} as SessionManager);
		const activeSettings = {
			get: () => "copy-retain",
			getAgentDir: () => "/managed-agent",
		} as unknown as Settings;

		await createSessionManager(parseArgs(["--resume", "/source/session.jsonl"]), "/workspace", activeSettings);

		expect(open).toHaveBeenCalledWith(
			"/source/session.jsonl",
			expect.objectContaining({ kind: "explicit", directory: "/source" }),
			undefined,
			"copy-retain",
		);
	});

	it("resolves direct resume ids through the active managed root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-managed-root-"));
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "custom-agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const original = SessionManager.create(cwd, destination);
		original.appendMessage({ role: "user", content: "custom root", timestamp: 1 });
		await original.ensureOnDisk();
		await original.flush();
		const id = original.getSessionId();
		await original.close();
		try {
			const resumed = await createSessionManager(parseArgs(["--resume", id]), cwd, {
				get: () => "copy-retain",
				getAgentDir: () => agentDir,
			} as unknown as Settings);
			expect(resumed?.getSessionId()).toBe(id);
			await resumed?.close();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("direct fork destination authority", () => {
	it("resolves direct fork ids through the active managed root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fork-managed-root-"));
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "custom-agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const original = SessionManager.create(cwd, destination);
		original.appendMessage({ role: "user", content: "custom root", timestamp: 1 });
		await original.ensureOnDisk();
		await original.flush();
		const id = original.getSessionId();
		await original.close();
		try {
			const fork = await createSessionManager(parseArgs(["--fork", id]), cwd, {
				get: () => "copy-retain",
				getAgentDir: () => agentDir,
			} as unknown as Settings);
			expect(fork?.getSessionId()).not.toBe(id);
			expect(fork?.getSessionDir()).toBe(destination.directory);
			await fork?.close();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

it("bounds a rejected strict-open promise to one error before session startup or fallback", async () => {
	let authDiscoveries = 0;
	let sessionCreations = 0;
	const stderr = await captureStderr(async () => {
		await runRootCommand(bareArgs(), [], {
			suppressProcessExit: true,
			isResumePickerTerminal: () => true,
			listManagedForResumePickerReadOnly: async () => [sessionInfo],
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
