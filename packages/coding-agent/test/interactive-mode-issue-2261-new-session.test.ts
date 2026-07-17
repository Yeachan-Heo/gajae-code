import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@gajae-code/coding-agent/internal-urls";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import type { ExtensionCommandContextActions } from "../src/extensibility/extensions";
import { planSnapshotHash } from "../src/modes/components/plan-preview-overlay";
import { BtwController } from "../src/modes/controllers/btw-controller";
import { CommandController } from "../src/modes/controllers/command-controller";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

describe("Issue #2261 InteractiveMode session-switch preparation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-2261-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function renderPlanReview(): Promise<void> {
		const planFilePath = "local://PLAN.md";
		const resolvedPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPath, "# Plan\n\nKeep this review open.");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(SelectorController.prototype, "showPlanPreview").mockResolvedValue({
			action: "Refine plan",
			comments: [],
			notes: "",
			snapshotHash: planSnapshotHash("# Plan\n\nKeep this review open."),
		});
		vi.spyOn(session, "abort").mockResolvedValue(undefined);
		await mode.handlePlanApproval({ planFilePath, planExists: true, title: "PLAN", finalPlanFilePath: planFilePath });
	}

	for (const [command, method] of [
		["/new", "handleClearCommand"],
		["/drop", "handleDropCommand"],
	] as const) {
		it(`keeps BTW, extension terminal listeners, and the rendered plan review alive when ${command} is cancelled`, async () => {
			const commandResult = vi.spyOn(CommandController.prototype, method).mockResolvedValue(false);
			const disposeBtw = vi.spyOn(BtwController.prototype, "dispose");
			const cleanupPreviousSessionUi = vi.fn();
			const captureSessionUiCleanup = vi
				.spyOn(ExtensionUiController.prototype, "captureSessionUiCleanup")
				.mockReturnValue(cleanupPreviousSessionUi);
			await renderPlanReview();
			const review = mode.chatContainer.children.at(-1);

			const handled = await executeBuiltinSlashCommand(command, {
				ctx: mode as never,
				handleBackgroundCommand: () => {},
			});
			expect(handled).toBe(true);

			expect(commandResult).toHaveBeenCalledTimes(1);
			expect(disposeBtw).not.toHaveBeenCalled();
			expect(captureSessionUiCleanup).toHaveBeenCalledTimes(1);
			expect(cleanupPreviousSessionUi).not.toHaveBeenCalled();
			expect(mode.chatContainer.children.at(-1)).toBe(review);
		});

		it(`prepares the session switch exactly once after ${command} succeeds`, async () => {
			const commandResult = vi.spyOn(CommandController.prototype, method).mockResolvedValue(true);
			const disposeBtw = vi.spyOn(BtwController.prototype, "dispose");
			const cleanupPreviousSessionUi = vi.fn();
			const captureSessionUiCleanup = vi
				.spyOn(ExtensionUiController.prototype, "captureSessionUiCleanup")
				.mockReturnValue(cleanupPreviousSessionUi);

			const handled = await executeBuiltinSlashCommand(command, {
				ctx: mode as never,
				handleBackgroundCommand: () => {},
			});
			expect(handled).toBe(true);

			expect(commandResult).toHaveBeenCalledTimes(1);
			expect(disposeBtw).toHaveBeenCalledTimes(1);
			expect(captureSessionUiCleanup).toHaveBeenCalledTimes(1);
			expect(cleanupPreviousSessionUi).toHaveBeenCalledTimes(1);
		});
	}

	it("keeps /context clear eagerly prepared on its separate session contract", async () => {
		const contextClear = vi
			.spyOn(CommandController.prototype, "handleContextClearCommand")
			.mockResolvedValue(undefined);
		const disposeBtw = vi.spyOn(BtwController.prototype, "dispose");
		const clearExtensionListeners = vi.spyOn(ExtensionUiController.prototype, "clearExtensionTerminalInputListeners");

		await mode.handleContextClearCommand();

		expect(contextClear).toHaveBeenCalledTimes(1);
		expect(disposeBtw).toHaveBeenCalledTimes(1);
		expect(clearExtensionListeners).toHaveBeenCalledTimes(1);
	});
});

let commandActions: ExtensionCommandContextActions | undefined;

function createExtensionContext(success: boolean): {
	context: InteractiveModeContext;
	unsubscribePreviousListener: ReturnType<typeof vi.fn>;
	unsubscribeSuccessorListener: ReturnType<typeof vi.fn>;
} {
	const unsubscribePreviousListener = vi.fn();
	const unsubscribeSuccessorListener = vi.fn();
	const context = {
		session: {
			newSession: vi.fn(async () => success),
			agent: { waitForIdle: vi.fn() },
			extensionRunner: {
				hasHandlers: () => false,
				initialize: (_actions: unknown, _context: unknown, commands: ExtensionCommandContextActions) => {
					commandActions = commands;
				},
			},
		},
		loadingAnimation: { stop: vi.fn() },
		statusContainer: { clear: vi.fn() },
		resetIrcSidebarSession: vi.fn(),
		statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: {
			requestRender: vi.fn(),
			resetViewportAnchorIntent: vi.fn(),
			addInputListener: vi
				.fn()
				.mockReturnValueOnce(unsubscribePreviousListener)
				.mockReturnValue(unsubscribeSuccessorListener),
		},
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		compactionQueuedMessages: [{ text: "queued", mode: "followUp" }],
		pendingTools: new Map([["old-tool", {}]]),
		reloadTodos: vi.fn(),
		sessionManager: { getSessionName: () => "old", getCwd: () => "/old" },
	} as unknown as InteractiveModeContext;
	return { context, unsubscribePreviousListener, unsubscribeSuccessorListener };
}

describe("Issue #2261 extension session.new", () => {
	afterEach(() => {
		commandActions = undefined;
	});

	for (const success of [false, true]) {
		it(`${success ? "tears down only predecessor" : "retains"} extension terminal listeners and the compaction queue when replacement ${success ? "succeeds" : "fails"}`, async () => {
			const { context, unsubscribePreviousListener, unsubscribeSuccessorListener } = createExtensionContext(success);
			const controller = new ExtensionUiController(context);
			const stopLoading = context.loadingAnimation?.stop;
			controller.initializeHookRunner({} as never, true);
			controller.addExtensionTerminalInputListener(() => undefined);
			(context.session.newSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				if (success) controller.addExtensionTerminalInputListener(() => undefined);
				return success;
			});
			if (!commandActions) throw new Error("Expected extension command actions");

			const result = await commandActions.newSession();
			expect(result).toEqual({ cancelled: !success });

			expect(context.session.newSession).toHaveBeenCalledTimes(1);
			expect(unsubscribePreviousListener).toHaveBeenCalledTimes(success ? 1 : 0);
			expect(unsubscribeSuccessorListener).not.toHaveBeenCalled();
			expect(stopLoading).toHaveBeenCalledTimes(success ? 1 : 0);
			expect(context.statusContainer.clear).toHaveBeenCalledTimes(success ? 1 : 0);
			expect(context.chatContainer.clear).toHaveBeenCalledTimes(success ? 1 : 0);
			expect(context.pendingMessagesContainer.clear).toHaveBeenCalledTimes(success ? 1 : 0);
			expect(context.compactionQueuedMessages).toEqual(success ? [] : [{ text: "queued", mode: "followUp" }]);
			expect(context.pendingTools.has("old-tool")).toBe(!success);
			expect(context.reloadTodos).toHaveBeenCalledTimes(success ? 1 : 0);
		});
	}
});
