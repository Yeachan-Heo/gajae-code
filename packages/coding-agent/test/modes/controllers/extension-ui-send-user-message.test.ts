/**
 * Owning-boundary regression tests for ExtensionUiController.#sendExtensionUserMessage.
 *
 * Issue #4393 (fix-forward of PR #4395): the exact head 3016657 added content
 * validation only in AgentSession.sendUserMessage, but the owning interactive
 * boundary calls applyInjectedUserSubmission (→ normalizeInjectedUserContent)
 * synchronously BEFORE attaching send.catch. When content is absent/null,
 * the for-of iteration throws an untyped TypeError synchronously, leaving the
 * typed invalid_input rejection from AgentSession unobserved (unhandled
 * rejection) and crashing the resident process.
 *
 * These tests exercise the actual ExtensionUiController/extension injection path
 * (actions.sendUserMessage), not AgentSession alone.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Container } from "@gajae-code/tui";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../../../src/extensibility/extensions";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

type Fixture = {
	controller: ExtensionUiController;
	ctx: InteractiveModeContext;
	getActions: () => ExtensionActions;
	addToHistory: ReturnType<typeof vi.fn>;
	addMessageToChat: ReturnType<typeof vi.fn>;
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	setIsStreaming: (streaming: boolean) => void;
	optimisticInjectedSignatures: Map<string, number>;
};

function createFixture(initiallyStreaming = false): Fixture {
	let actions: ExtensionActions | undefined;
	let isStreaming = initiallyStreaming;
	const addToHistory = vi.fn();
	const addMessageToChat = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const sendUserMessage = vi.fn(async () => undefined);
	const optimisticInjectedSignatures = new Map<string, number>();

	const extensionRunner = {
		initialize(
			capturedActions: ExtensionActions,
			_contextActions: ExtensionContextActions,
			_capturedCommandActions?: ExtensionCommandContextActions,
			_capturedUiContext?: ExtensionUIContext,
		): void {
			actions = capturedActions;
		},
		onError: () => () => {},
		emit: vi.fn(async () => undefined),
	};

	const ctx = {
		isBackgrounded: false,
		isStopped: () => false,
		session: {
			extensionRunner,
			get isStreaming() {
				return isStreaming;
			},
			sendCustomMessage: vi.fn(async () => undefined),
			sendUserMessage,
			navigateTree: vi.fn(async () => ({ cancelled: false })),
			switchSession: vi.fn(async () => true),
			reload: vi.fn(async () => undefined),
		},
		sessionManager: {
			getSessionId: () => "session-test",
			getSessionName: () => "Test",
			getCwd: () => "/tmp/project",
		},
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: { requestRender },
		editor: {
			addToHistory,
			setText: vi.fn(),
			handleInput: vi.fn(),
			getText: () => "",
		},
		addMessageToChat,
		updatePendingMessagesDisplay,
		optimisticInjectedSignatures,
		setToolUIContext: vi.fn(),
		setWorkingMessage: vi.fn(),
		setEditorComponent: vi.fn(),
		toolOutputExpanded: false,
		setToolsExpanded: vi.fn(),
		rebuildInitialMessages: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		resetIrcSidebarSession: vi.fn(),
		reloadTodos: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showError,
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		controller,
		ctx,
		getActions: () => {
			if (!actions) throw new Error("Extension actions were not initialized");
			return actions;
		},
		addToHistory,
		addMessageToChat,
		updatePendingMessagesDisplay,
		requestRender,
		showError,
		sendUserMessage,
		setIsStreaming: (streaming: boolean) => {
			isStreaming = streaming;
		},
		optimisticInjectedSignatures,
	};
}

describe("ExtensionUiController.#sendExtensionUserMessage absent/malformed content (issue #4393)", () => {
	const unhandledRejectionHandlers: Array<(reason: unknown) => void> = [];

	afterEach(() => {
		for (const handler of unhandledRejectionHandlers) {
			process.removeListener("unhandledRejection", handler);
		}
		unhandledRejectionHandlers.length = 0;
	});

	/**
	 * Install a process-level unhandled-rejection sentinel that fails the test if
	 * any promise rejection escapes without an attached catch handler.
	 */
	function trackUnhandledRejections(): { sawUnhandled: () => boolean } {
		let sawUnhandled = false;
		const nodeHandler = (_reason: unknown) => {
			sawUnhandled = true;
		};
		process.on("unhandledRejection", nodeHandler);
		unhandledRejectionHandlers.push(nodeHandler);
		return { sawUnhandled: () => sawUnhandled };
	}

	for (const scenario of [
		{ label: "undefined content", content: undefined as never, streaming: false },
		{ label: "null content", content: null as never, streaming: false },
		{ label: "undefined content during active turn", content: undefined as never, streaming: true },
		{ label: "null content during active turn", content: null as never, streaming: true },
	] as const) {
		it(`rejects ${scenario.label} with typed invalid_input without TypeError, UI/history/queue mutation, or unhandled rejection`, async () => {
			const fixture = createFixture(scenario.streaming);
			fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);
			const actions = fixture.getActions();
			const rejectionTracker = trackUnhandledRejections();

			// The exact crash vector: absent content must not throw a synchronous
			// TypeError from normalizeInjectedUserContent's for-of iteration.
			// It must reject as a typed nonfatal control error.
			await expect(actions.sendUserMessage(scenario.content)).rejects.toMatchObject({
				code: "invalid_input",
				name: "Error",
			});

			// Allow microtask queue to flush so any unobserved rejection would surface.
			await Bun.sleep(10);

			// No UI mutation: no history add, no chat message, no pending display refresh,
			// no render request, no showError.
			expect(fixture.addToHistory).not.toHaveBeenCalled();
			expect(fixture.addMessageToChat).not.toHaveBeenCalled();
			expect(fixture.updatePendingMessagesDisplay).not.toHaveBeenCalled();
			expect(fixture.requestRender).not.toHaveBeenCalled();

			// No session delivery attempted: sendUserMessage was never called.
			expect(fixture.sendUserMessage).not.toHaveBeenCalled();

			// No optimistic signature recorded.
			expect(fixture.optimisticInjectedSignatures.size).toBe(0);

			// No unhandled rejection escaped.
			expect(rejectionTracker.sawUnhandled()).toBe(false);
		});
	}

	it("preserves valid extension message delivery after rejecting malformed content on the same resident session", async () => {
		const fixture = createFixture(false);
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);
		const actions = fixture.getActions();

		// First: reject malformed content without crashing.
		await expect(actions.sendUserMessage(undefined as never)).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(fixture.sendUserMessage).not.toHaveBeenCalled();

		// Then: a valid extension message on the same resident session succeeds.
		await expect(actions.sendUserMessage("valid telegram prompt")).resolves.toBeUndefined();

		// Session delivery happened exactly once (for the valid message only).
		expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fixture.sendUserMessage).toHaveBeenCalledWith("valid telegram prompt", undefined);

		// UI bookkeeping happened exactly once (for the valid message only).
		expect(fixture.addToHistory).toHaveBeenCalledTimes(1);
		expect(fixture.addToHistory).toHaveBeenCalledWith("valid telegram prompt");
		expect(fixture.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fixture.requestRender).toHaveBeenCalled();
	});

	it("preserves valid queued/active-turn extension delivery after rejecting malformed content", async () => {
		const fixture = createFixture(true);
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);
		const actions = fixture.getActions();

		// Reject malformed content during an active turn.
		await expect(actions.sendUserMessage(null as never, { deliverAs: "steer" })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(fixture.sendUserMessage).not.toHaveBeenCalled();

		// Then: a valid queued delivery on the same resident session succeeds.
		await expect(
			actions.sendUserMessage("valid steer during active turn", { deliverAs: "steer" }),
		).resolves.toBeUndefined();

		expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fixture.sendUserMessage).toHaveBeenCalledWith("valid steer during active turn", {
			deliverAs: "steer",
		});

		// Queued path: history + pending display refresh, no optimistic chat add.
		expect(fixture.addToHistory).toHaveBeenCalledTimes(1);
		expect(fixture.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(fixture.requestRender).toHaveBeenCalled();
		expect(fixture.addMessageToChat).not.toHaveBeenCalled();
	});

	for (const scenario of [
		{ label: "array with null element", content: [null] as never },
		{ label: "array with undefined element", content: [undefined] as never },
		{ label: "array with null element during active turn", content: [null] as never, streaming: true },
		{ label: "array with undefined element during active turn", content: [undefined] as never, streaming: true },
	] as const) {
		it(`rejects ${scenario.label} with typed invalid_input without TypeError or mutation`, async () => {
			const fixture = createFixture(scenario.streaming ?? false);
			fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);
			const actions = fixture.getActions();
			const rejectionTracker = trackUnhandledRejections();

			// The exact element-level crash vector: [null]/[undefined] passes the
			// container guard but normalizeInjectedUserContent dereferences part.type
			// and throws an untyped TypeError synchronously before send.catch attaches.
			await expect(actions.sendUserMessage(scenario.content)).rejects.toMatchObject({
				code: "invalid_input",
				name: "Error",
			});

			await Bun.sleep(10);

			expect(fixture.addToHistory).not.toHaveBeenCalled();
			expect(fixture.addMessageToChat).not.toHaveBeenCalled();
			expect(fixture.updatePendingMessagesDisplay).not.toHaveBeenCalled();
			expect(fixture.requestRender).not.toHaveBeenCalled();
			expect(fixture.sendUserMessage).not.toHaveBeenCalled();
			expect(fixture.optimisticInjectedSignatures.size).toBe(0);
			expect(rejectionTracker.sawUnhandled()).toBe(false);
		});
	}

	it("preserves valid delivery after rejecting malformed array elements on the same resident session", async () => {
		const fixture = createFixture(false);
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);
		const actions = fixture.getActions();

		await expect(actions.sendUserMessage([null] as never)).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(fixture.sendUserMessage).not.toHaveBeenCalled();

		await expect(
			actions.sendUserMessage([{ type: "text", text: "valid after element rejection" }]),
		).resolves.toBeUndefined();

		expect(fixture.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fixture.addToHistory).toHaveBeenCalledTimes(1);
		expect(fixture.addToHistory).toHaveBeenCalledWith("valid after element rejection");
	});
});
