import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "../../../src/modes/controllers/command-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

function createContext(success: boolean): InteractiveModeContext {
	return {
		session: { newSession: vi.fn(async () => success) },
		loadingAnimation: { stop: vi.fn() },
		statusContainer: { clear: vi.fn() },
		resetIrcSidebarSession: vi.fn(),
		resetObserverRegistry: vi.fn(),
		sessionManager: {
			getSessionFile: () => "/old/session.jsonl",
			getSessionName: () => "old",
			getCwd: () => "/old",
		},
		statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn(), resetViewportAnchorIntent: vi.fn() },
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		compactionQueuedMessages: [{ text: "old", mode: "followUp" }],
		pendingTools: new Map([["old", {}]]),
		reloadTodos: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
}

beforeAll(() => initTheme());

describe("Issue #2261 CommandController fail-closed session replacement", () => {
	for (const [label, invoke] of [
		["/new", (controller: CommandController) => controller.handleClearCommand()],
		["/drop", (controller: CommandController) => controller.handleDropCommand()],
	] as const) {
		it(`does not tear down the current UI or compaction queue when ${label} replacement fails`, async () => {
			const context = createContext(false);
			const controller = new CommandController(context);

			await expect(invoke(controller)).resolves.toBe(false);

			expect(context.session.newSession).toHaveBeenCalledTimes(1);
			expect(context.loadingAnimation?.stop).not.toHaveBeenCalled();
			expect(context.statusContainer.clear).not.toHaveBeenCalled();
			expect(context.resetIrcSidebarSession).not.toHaveBeenCalled();
			expect(context.chatContainer.clear).not.toHaveBeenCalled();
			expect(context.pendingMessagesContainer.clear).not.toHaveBeenCalled();
			expect(context.compactionQueuedMessages).toEqual([{ text: "old", mode: "followUp" }]);
			expect(context.pendingTools.has("old")).toBe(true);
		});

		it(`tears down the old UI and compaction queue exactly once when ${label} replacement succeeds`, async () => {
			const context = createContext(true);
			const controller = new CommandController(context);
			const stopLoading = context.loadingAnimation?.stop;

			const result = await invoke(controller);
			expect(result).toBe(true);

			expect(context.session.newSession).toHaveBeenCalledTimes(1);
			expect(stopLoading).toHaveBeenCalledTimes(1);
			expect(context.statusContainer.clear).toHaveBeenCalledTimes(1);
			expect(context.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
			expect(context.chatContainer.clear).toHaveBeenCalledTimes(1);
			expect(context.pendingMessagesContainer.clear).toHaveBeenCalledTimes(1);
			expect(context.compactionQueuedMessages).toEqual([]);
			expect(context.pendingTools.size).toBe(0);
			expect(context.reloadTodos).toHaveBeenCalledTimes(1);
		});
	}

	it("keeps /context clear on its separate eagerly prepared session contract", async () => {
		const clearContext = vi.fn(async () => false);
		const context = {
			session: { clearContext, newSession: vi.fn(), isCompacting: false },
			loadingAnimation: undefined,
			statusContainer: { clear: vi.fn() },
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(context);

		await controller.handleContextClearCommand();

		expect(clearContext).toHaveBeenCalledTimes(1);
		expect(context.statusContainer.clear).toHaveBeenCalledTimes(1);
		expect(context.session.newSession).not.toHaveBeenCalled();
	});
});
