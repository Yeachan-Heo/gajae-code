import { describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runInteractiveMode, StartupUpdateOrchestrator, submitInteractiveInput } from "@gajae-code/coding-agent/main";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import type { SubmittedUserInput } from "@gajae-code/coding-agent/modes/types";
import type { AgentSession, AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV,
	GJC_COORDINATOR_SESSION_READINESS_FILE_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "../src/gjc-runtime/session-state-sidecar";

function createInput(overrides: Partial<SubmittedUserInput> = {}): SubmittedUserInput {
	return {
		text: "hello",
		images: undefined,
		cancelled: false,
		started: false,
		...overrides,
	};
}

function createAgentEndWaiter() {
	const agentEnd = Promise.withResolvers<void>();
	const dispose = vi.fn();
	return {
		agentEnd,
		dispose,
		waitForAgentEnd: vi.fn(() => ({ promise: agentEnd.promise, dispose })),
	};
}

describe("submitInteractiveInput", () => {
	it("prompts already-started continue submissions without re-checking optimistic state", async () => {
		const waiter = createAgentEndWaiter();
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: waiter.waitForAgentEnd,
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "", started: true });

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledWith("", { images: undefined });
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
		expect(waiter.dispose).toHaveBeenCalledTimes(1);
	});

	it("skips prompting when optimistic submission was cancelled before start", async () => {
		const waiter = createAgentEndWaiter();
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: waiter.waitForAgentEnd,
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput();

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).toHaveBeenCalledWith(input);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
		expect(waiter.waitForAgentEnd).not.toHaveBeenCalled();
	});

	it("routes hidden custom submissions through promptCustomMessage", async () => {
		const waiter = createAgentEndWaiter();
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: waiter.waitForAgentEnd,
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "continue goal", customType: "goal-continuation" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.promptCustomMessage).toHaveBeenCalledWith({
			customType: "goal-continuation",
			content: "continue goal",
			display: false,
			attribution: "agent",
		});
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("releases input ownership at agent_end while the prompt remains pending", async () => {
		const prompt = Promise.withResolvers<void>();
		const events: string[] = [];
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const unsubscribe = vi.fn((listener: (event: AgentSessionEvent) => void) => listeners.delete(listener));
		const session = {
			prompt: vi.fn(() => {
				events.push("prompt");
				return prompt.promise;
			}),
			promptCustomMessage: vi.fn(async () => {}),
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				events.push("subscribe");
				listeners.add(listener);
				return () => unsubscribe(listener);
			}),
		};
		const interactiveMode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		interactiveMode.session = session as unknown as AgentSession;
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: interactiveMode.waitForAgentEnd.bind(interactiveMode),
		};
		const input = createInput();

		const submission = submitInteractiveInput(mode, session, input);
		expect(events).toEqual(["subscribe", "prompt"]);
		for (const listener of listeners) {
			listener({ type: "agent_start" } as AgentSessionEvent);
		}
		for (const listener of listeners) {
			listener({ type: "agent_end" } as AgentSessionEvent);
		}
		await submission;

		expect(mode.finishPendingSubmission).toHaveBeenCalledTimes(1);
		expect(mode.checkShutdownRequested).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("does not release ownership for an unrelated terminal event", async () => {
		const prompt = Promise.withResolvers<void>();
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const session = {
			prompt: vi.fn(() => prompt.promise),
			promptCustomMessage: vi.fn(async () => {}),
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}),
		};
		const interactiveMode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		interactiveMode.session = session as unknown as AgentSession;
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: interactiveMode.waitForAgentEnd.bind(interactiveMode),
		};

		const submission = submitInteractiveInput(mode, session, createInput());
		for (const listener of listeners) listener({ type: "agent_end" } as AgentSessionEvent);
		await Bun.sleep(10);
		expect(mode.finishPendingSubmission).not.toHaveBeenCalled();

		for (const listener of listeners) listener({ type: "agent_start" } as AgentSessionEvent);
		for (const listener of listeners) listener({ type: "agent_end" } as AgentSessionEvent);
		await submission;
		expect(mode.finishPendingSubmission).toHaveBeenCalledTimes(1);
		prompt.resolve();
	});

	it("reports a late prompt rejection after agent_end once", async () => {
		const waiter = createAgentEndWaiter();
		const prompt = Promise.withResolvers<void>();
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: waiter.waitForAgentEnd,
		};
		const session = {
			prompt: vi.fn(() => prompt.promise),
			promptCustomMessage: vi.fn(async () => {}),
		};

		const submission = submitInteractiveInput(mode, session, createInput());
		waiter.agentEnd.resolve();
		await submission;
		prompt.reject(new Error("late failure"));
		await Promise.resolve();

		expect(mode.showError).toHaveBeenCalledTimes(1);
		expect(mode.showError).toHaveBeenCalledWith("late failure");
	});

	it("disposes the agent-end waiter when the prompt settles first", async () => {
		const waiter = createAgentEndWaiter();
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: waiter.waitForAgentEnd,
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};

		await submitInteractiveInput(mode, session, createInput());

		expect(waiter.dispose).toHaveBeenCalledTimes(1);
	});

	it("contains an identity-precondition prompt rejection and leaves the input loop usable", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
			waitForAgentEnd: vi.fn(() => ({ promise: Promise.resolve(), dispose: vi.fn() })),
		};
		const session = {
			prompt: vi.fn(async () => {
				throw new Error("managed_append_identity_mismatch");
			}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput();

		await expect(submitInteractiveInput(mode, session, input)).resolves.toBeUndefined();

		expect(mode.showError).toHaveBeenCalledWith("managed_append_identity_mismatch");
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.checkShutdownRequested).toHaveBeenCalledTimes(1);
	});
});

describe("interactive startup input ordering", () => {
	it("runs queued startup messages once after UI initialization instead of continuing the persisted tail", async () => {
		const events: string[] = [];
		const stop = new Error("stop interactive input");
		const session = {
			continuePersistedHistory: async () => events.push("continue"),
			prompt: async (text: string) => events.push(`prompt:${text}`),
		} as unknown as AgentSession;
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
				new StartupUpdateOrchestrator(
					"interactive",
					() => false,
					async () => undefined,
				),
				["first queued", "second queued"],
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

		expect(events).toEqual(["init", "render", "prompt:first queued", "prompt:second queued"]);
	});
	it("starts deferred model profiles after the first render and before persisted continuation", async () => {
		const events: string[] = [];
		const stop = new Error("stop interactive input");
		const session = {
			continuePersistedHistory: async () => events.push("continue"),
		} as unknown as AgentSession;
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => events.push("render"),
				showStatus: (message: string) => events.push(`status:${message}`),
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
				new StartupUpdateOrchestrator(
					"interactive",
					() => false,
					async () => undefined,
				),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				"continue-tail",
				undefined,
				async () => {
					events.push("profile:start");
					return { recoverableErrors: [] };
				},
			),
		).rejects.toBe(stop);

		expect(events.slice(0, 5)).toEqual([
			"init",
			"render",
			"status:Loading model profile…",
			"profile:start",
			"continue",
		]);
	});
	it("propagates deferred model profile failures after the first render", async () => {
		const events: string[] = [];
		const failure = new Error("profile activation failed");
		const pendingInput = Promise.withResolvers<SubmittedUserInput>();
		const session = {} as unknown as AgentSession;
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => events.push("render"),
				showStatus: (message: string) => events.push(`status:${message}`),
				showError: (message: string) => events.push(`error:${message}`),
				getUserInput: () => {
					events.push("input:wait");
					return pendingInput.promise;
				},
				shutdown: async () => events.push("shutdown"),
				stop: () => {
					events.push("stop");
					pendingInput.reject(new Error("input stopped"));
				},
			}) as unknown as InteractiveMode;

		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				new StartupUpdateOrchestrator(
					"interactive",
					() => false,
					async () => undefined,
				),
				[],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				undefined,
				undefined,
				async () => {
					events.push("profile:start");
					throw failure;
				},
			),
		).rejects.toBe(failure);

		expect(events).toEqual([
			"init",
			"render",
			"status:Loading model profile…",
			"profile:start",
			"input:wait",
			"error:profile activation failed",
			"shutdown",
			"stop",
		]);
	});

	it("awaits coordinator readiness after initialization and before rendering or startup prompt submission", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-interactive-readiness-"));
		const readinessFile = path.join(root, "runtime-input-ready.json");
		const env = {
			stateFile: process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV],
			sessionId: process.env[GJC_COORDINATOR_SESSION_ID_ENV],
			launchId: process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV],
			readinessFile: process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV],
		};
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "interactive-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "interactive-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		const events: string[] = [];
		const stop = new Error("stop interactive input");
		const session = {
			prompt: async (text: string) => {
				expect(fsSync.existsSync(readinessFile)).toBe(true);
				events.push(`prompt:${text}`);
			},
		} as unknown as AgentSession;
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => {
					expect(fsSync.existsSync(readinessFile)).toBe(true);
					events.push("render");
				},
				showError: () => {},
				getUserInput: async () => {
					throw stop;
				},
			}) as unknown as InteractiveMode;

		try {
			await expect(
				runInteractiveMode(
					session,
					"test",
					undefined,
					[],
					new StartupUpdateOrchestrator(
						"interactive",
						() => false,
						async () => undefined,
					),
					["startup prompt"],
					() => {},
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					createMode,
				),
			).rejects.toBe(stop);
			expect(events).toEqual(["init", "render", "prompt:startup prompt"]);
		} finally {
			if (env.stateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = env.stateFile;
			if (env.sessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = env.sessionId;
			if (env.launchId === undefined) delete process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = env.launchId;
			if (env.readinessFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = env.readinessFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed before rendering or prompt submission when readiness marker conflicts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-interactive-readiness-conflict-"));
		const readinessFile = path.join(root, "runtime-input-ready.json");
		const previous = {
			stateFile: process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV],
			sessionId: process.env[GJC_COORDINATOR_SESSION_ID_ENV],
			launchId: process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV],
			readinessFile: process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV],
		};
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "interactive-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "interactive-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		await Bun.write(readinessFile, "not-json");
		const events: string[] = [];
		const session = {
			prompt: async () => events.push("prompt"),
		} as unknown as AgentSession;
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => events.push("render"),
				showError: () => {},
				getUserInput: async () => "unused",
			}) as unknown as InteractiveMode;

		try {
			await expect(
				runInteractiveMode(
					session,
					"test",
					undefined,
					[],
					new StartupUpdateOrchestrator(
						"interactive",
						() => false,
						async () => undefined,
					),
					["startup prompt"],
					() => {},
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					createMode,
				),
			).rejects.toMatchObject({ code: "runtime_readiness_marker_conflict" });
			expect(events).toEqual(["init"]);
		} finally {
			if (previous.stateFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = previous.stateFile;
			if (previous.sessionId === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = previous.sessionId;
			if (previous.launchId === undefined) delete process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV];
			else process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = previous.launchId;
			if (previous.readinessFile === undefined) delete process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV];
			else process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = previous.readinessFile;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
