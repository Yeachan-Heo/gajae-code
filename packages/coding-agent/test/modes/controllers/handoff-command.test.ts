import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

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
			resetIrcSidebarSession: vi.fn(),
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
		expect(ctx.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
	});

	it("prepares contribution-pr artifacts without spawning a competing TUI worker", async () => {
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
					spawned: false,
				})),
			},
			statusContainer,
			chatContainer,
			ui: { requestRender },
			editor: { setText: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleContributionPrepCommand("focus on repro");

		expect(ctx.session.prepareContributionPrep).toHaveBeenCalledWith({
			customInstructions: "focus on repro",
			spawnWorker: false,
		});
		expect(ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(ctx.statusLine.invalidate).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Manifest: /tmp/prep/manifest.json"));
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("separate terminal"));
		expect(chatContainer.children).toHaveLength(1);
		expect(requestRender).toHaveBeenCalled();
	});
});
