import { describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runInteractiveMode, StartupUpdateOrchestrator, submitInteractiveInput } from "@gajae-code/coding-agent/main";
import type { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import type { SubmittedUserInput } from "@gajae-code/coding-agent/modes/types";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
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

describe("submitInteractiveInput", () => {
	it("prompts already-started continue submissions without re-checking optimistic state", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
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
	});

	it("skips prompting when optimistic submission was cancelled before start", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
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
	});

	it("routes hidden custom submissions through promptCustomMessage", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
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
