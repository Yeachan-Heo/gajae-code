import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { Subprocess } from "bun";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		clear() {
			this.children = [];
		},
	};
}

function createFakeProcess(exitCode = 0): Subprocess {
	return {
		pid: 12345,
		exited: Promise.resolve(exitCode),
	} as Subprocess;
}

describe("/handoff command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a cancellable loader while handoff generation is running", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffDone = Promise.withResolvers<{ document: string }>();
		const originalOnEscape = vi.fn();
		const statusContainer = createContainer();
		const chatContainer = createContainer();
		const abortHandoff = vi.fn();
		const requestRender = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(() => {
					handoffStarted.resolve();
					return handoffDone.promise;
				}),
				abortHandoff,
			},
			loadingAnimation: undefined,
			statusContainer,
			chatContainer,
			ui: { requestRender },
			editor: { onEscape: originalOnEscape },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		const commandPromise = controller.handleHandoffCommand("focus on tests");
		await handoffStarted.promise;

		expect(statusContainer.children).toHaveLength(1);
		expect(ctx.editor.onEscape).not.toBe(originalOnEscape);
		ctx.editor.onEscape?.();
		expect(abortHandoff).toHaveBeenCalledTimes(1);

		handoffDone.resolve({ document: "## Goal\nContinue" });
		await commandPromise;

		expect(statusContainer.children).toHaveLength(0);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		expect(ctx.session.handoff).toHaveBeenCalledWith("focus on tests");
	});

	it("runs contribution-prep without rebuilding or switching the active chat", async () => {
		const statusContainer = createContainer();
		const chatContainer = createContainer();
		const requestRender = vi.fn();
		const ctx = {
			sessionManager: { getEntries: () => [{ type: "message" }, { type: "message" }] },
			session: {
				prepareContributionPrep: vi.fn(async () => ({
					manifestPath: "/tmp/prep/manifest.json",
					workerPromptPath: "/tmp/prep/worker-prompt.md",
					artifactDir: "/tmp/prep",
					changedFiles: [],
					spawned: true,
				})),
			},
			statusContainer,
			chatContainer,
			ui: { requestRender, start: vi.fn(), stop: vi.fn() },
			editor: { setText: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleContributionPrepCommand("focus on repro");

		expect(ctx.session.prepareContributionPrep).toHaveBeenCalledWith(
			expect.objectContaining({
				customInstructions: "focus on repro",
				spawnWorker: true,
				spawn: expect.any(Function),
			}),
		);
		expect(ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(ctx.statusLine.invalidate).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Manifest: /tmp/prep/manifest.json"));
		expect(chatContainer.children).toHaveLength(1);
		expect(requestRender).toHaveBeenCalled();
	});

	it("suspends the TUI while the spawned contribute-pr worker owns the terminal", async () => {
		const spawnCalls: Array<unknown> = [];
		vi.spyOn(Bun, "spawn").mockImplementation((first: unknown) => {
			spawnCalls.push(first);
			return createFakeProcess();
		});

		const chatContainer = createContainer();
		const requestRender = vi.fn();
		const start = vi.fn();
		const stop = vi.fn();
		const ctx = {
			sessionManager: { getEntries: () => [{ type: "message" }, { type: "message" }] },
			session: {
				prepareContributionPrep: vi.fn(
					async (options: {
						spawn?: (args: string[], cwd: string, shell: boolean) => Promise<void>;
						customInstructions?: string;
						spawnWorker?: boolean;
					}) => {
						await options.spawn?.(["gjc", "--no-skills", "--", "@/tmp/prep/worker-prompt.md"], "/repo", false);
						return {
							manifestPath: "/tmp/prep/manifest.json",
							workerPromptPath: "/tmp/prep/worker-prompt.md",
							artifactDir: "/tmp/prep",
							changedFiles: [],
							spawned: true,
						};
					},
				),
			},
			statusContainer: createContainer(),
			chatContainer,
			ui: { requestRender, start, stop },
			editor: { setText: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleContributionPrepCommand();

		expect(stop).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]).toEqual(["gjc", "--no-skills", "--", "@/tmp/prep/worker-prompt.md"]);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
