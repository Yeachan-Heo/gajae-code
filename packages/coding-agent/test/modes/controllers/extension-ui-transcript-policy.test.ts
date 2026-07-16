import { describe, expect, it, type Mock, vi } from "bun:test";
import { Container } from "@gajae-code/tui";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../../../src/extensibility/extensions";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext, TranscriptRebuildPolicy } from "../../../src/modes/types";

type Fixture = {
	controller: ExtensionUiController;
	ctx: InteractiveModeContext;
	getActions: () => ExtensionActions;
	getCommandActions: () => ExtensionCommandContextActions;
	setNextSessionId: (id: string) => void;
	rebuildInitialMessages: Mock<(policy: TranscriptRebuildPolicy) => void>;
	rebuildChatFromMessages: Mock<(policy: TranscriptRebuildPolicy) => void>;
	resetIrcSidebarSession: Mock<() => void>;
};

function createFixture(initialSessionId = "session-a"): Fixture {
	let actions: ExtensionActions | undefined;
	let commandActions: ExtensionCommandContextActions | undefined;
	let sessionId = initialSessionId;
	let nextSessionId = initialSessionId;
	const rebuildInitialMessages = vi.fn<(policy: TranscriptRebuildPolicy) => void>();
	const rebuildChatFromMessages = vi.fn<(policy: TranscriptRebuildPolicy) => void>();
	const resetIrcSidebarSession = vi.fn<() => void>();
	const extensionRunner = {
		initialize(
			capturedActions: ExtensionActions,
			_contextActions: ExtensionContextActions,
			capturedCommandActions?: ExtensionCommandContextActions,
			_uiContext?: ExtensionUIContext,
		): void {
			actions = capturedActions;
			commandActions = capturedCommandActions;
		},
		onError: vi.fn(),
		emit: vi.fn(async () => undefined),
	};
	const ctx = {
		isBackgrounded: false,
		session: {
			extensionRunner,
			isStreaming: false,
			sendCustomMessage: vi.fn(async () => undefined),
			switchSession: vi.fn(async () => {
				sessionId = nextSessionId;
				return true;
			}),
			reload: vi.fn(async () => {
				sessionId = nextSessionId;
			}),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Session",
			getCwd: () => "/tmp/project",
		},
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: { requestRender: vi.fn() },
		editor: { setText: vi.fn(), handleInput: vi.fn(), getText: () => "" },
		setToolUIContext: vi.fn(),
		setWorkingMessage: vi.fn(),
		setEditorComponent: vi.fn(),
		toolOutputExpanded: false,
		setToolsExpanded: vi.fn(),
		rebuildInitialMessages,
		rebuildChatFromMessages,
		resetIrcSidebarSession,
		reloadTodos: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(ctx);
	return {
		controller,
		ctx,
		getActions: () => {
			if (!actions) throw new Error("Extension actions were not initialized");
			return actions;
		},
		getCommandActions: () => {
			if (!commandActions) throw new Error("Extension command actions were not initialized");
			return commandActions;
		},
		setNextSessionId: id => {
			nextSessionId = id;
		},
		rebuildInitialMessages,
		rebuildChatFromMessages,
		resetIrcSidebarSession,
	};
}

describe("ExtensionUiController transcript rebuild policy", () => {
	it("resets identity when a hook-runner switch loads a different session id from the same path", async () => {
		const fixture = createFixture();
		fixture.setNextSessionId("session-b");
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);

		await fixture.getCommandActions().switchSession("/tmp/project/session.jsonl");

		expect(fixture.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
		expect(fixture.rebuildInitialMessages).toHaveBeenCalledWith("replace-identity");
	});

	it("reconciles a true same-session switch in the foreground extension path", async () => {
		const fixture = createFixture();
		await fixture.controller.initHooksAndCustomTools();

		await fixture.getCommandActions().switchSession("/tmp/project/session.jsonl");

		expect(fixture.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(fixture.rebuildInitialMessages).toHaveBeenCalledWith("reconcile-same-transcript");
	});
	it("resets identity when hook-runner reload replaces the logical session", async () => {
		const fixture = createFixture();
		fixture.setNextSessionId("session-b");
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);

		await fixture.getCommandActions().reload();

		expect(fixture.resetIrcSidebarSession).toHaveBeenCalledTimes(1);
		expect(fixture.rebuildInitialMessages).toHaveBeenCalledWith("replace-identity");
	});

	it("reconciles reload when the foreground extension keeps the same logical session", async () => {
		const fixture = createFixture();
		await fixture.controller.initHooksAndCustomTools();

		await fixture.getCommandActions().reload();

		expect(fixture.resetIrcSidebarSession).not.toHaveBeenCalled();
		expect(fixture.rebuildInitialMessages).toHaveBeenCalledWith("reconcile-same-transcript");
	});

	it("classifies idle custom-message display rebuilds as same-transcript reconciliation", async () => {
		const fixture = createFixture();
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);

		fixture.getActions().sendMessage({ customType: "test", content: "visible", display: true });
		await Bun.sleep(0);

		expect(fixture.rebuildChatFromMessages).toHaveBeenCalledWith("reconcile-same-transcript");
	});
	it("routes extension fold choices through the interactive context", async () => {
		const fixture = createFixture();
		await fixture.controller.initHooksAndCustomTools();

		const setToolUIContext = fixture.ctx.setToolUIContext as Mock<
			(context: ExtensionUIContext, interactive: boolean) => void
		>;
		const uiContext = setToolUIContext.mock.calls[0]?.[0] as ExtensionUIContext;
		uiContext.setToolsExpanded(true);

		expect(fixture.ctx.setToolsExpanded).toHaveBeenCalledWith(true);
	});
});
