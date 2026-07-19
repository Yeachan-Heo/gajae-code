import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError } from "@gajae-code/agent-core/compaction";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { StatusArea } from "@gajae-code/coding-agent/modes/status-area";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		removeChild(child: unknown) {
			this.children = this.children.filter(existing => existing !== child);
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
			statusArea: new StatusArea({ ui: { requestRender } as never, statusContainer: statusContainer as never }),
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
			statusArea: new StatusArea({ ui: { requestRender } as never, statusContainer: statusContainer as never }),
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
	it("compaction teardown removes only its own loader and keeps independent status", async () => {
		const compactStarted = Promise.withResolvers<void>();
		const compactDone = Promise.withResolvers<void>();
		const statusContainer = createContainer();
		const chatContainer = createContainer();
		const requestRender = vi.fn();
		const independentStatus = { render: () => [], invalidate: () => {} };
		statusContainer.addChild(independentStatus);
		const staleWorkingLoader = { stop: vi.fn() };
		statusContainer.addChild(staleWorkingLoader);
		const ctx = {
			session: {
				compact: vi.fn(() => {
					compactStarted.resolve();
					return compactDone.promise;
				}),
				abortCompaction: vi.fn(),
			},
			loadingAnimation: staleWorkingLoader,
			statusContainer,
			statusArea: new StatusArea({ ui: { requestRender } as never, statusContainer: statusContainer as never }),
			chatContainer,
			ui: { requestRender },
			editor: { onEscape: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			showError: vi.fn(),
			flushCompactionQueue: vi.fn(async () => undefined),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		const outcomePromise = controller.executeCompaction();
		await compactStarted.promise;

		// The stale working loader was torn down and its own loader installed;
		// the independently owned status component survives throughout.
		expect(staleWorkingLoader.stop).toHaveBeenCalledTimes(1);
		expect(statusContainer.children).not.toContain(staleWorkingLoader);
		expect(statusContainer.children).toContain(independentStatus);
		expect(statusContainer.children).toHaveLength(2);

		compactDone.resolve();
		expect(await outcomePromise).toBe("ok");
		expect(statusContainer.children).toEqual([independentStatus]);
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
	it("cancelled compaction still tears down only its own loader", async () => {
		const statusContainer = createContainer();
		const chatContainer = createContainer();
		const requestRender = vi.fn();
		const independentStatus = { render: () => [], invalidate: () => {} };
		statusContainer.addChild(independentStatus);
		const ctx = {
			session: {
				compact: vi.fn(async () => {
					throw new CompactionCancelledError();
				}),
				abortCompaction: vi.fn(),
			},
			loadingAnimation: undefined,
			statusContainer,
			statusArea: new StatusArea({ ui: { requestRender } as never, statusContainer: statusContainer as never }),
			chatContainer,
			ui: { requestRender },
			editor: { onEscape: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			showError: vi.fn(),
			flushCompactionQueue: vi.fn(async () => undefined),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		expect(await controller.executeCompaction()).toBe("cancelled");
		expect(ctx.showError).toHaveBeenCalledWith("Compaction cancelled");
		expect(statusContainer.children).toEqual([independentStatus]);
	});
});
