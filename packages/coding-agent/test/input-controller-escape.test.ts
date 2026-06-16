import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@gajae-code/coding-agent/modes/types";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterAll(() => {
	resetSettingsForTest();
});

type FakeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void>;
	shouldBypassAutocompleteOnEscape?: () => boolean;
	onClear?: () => void;
	onExit?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onHistorySearch?: () => void;
	onShowHotkeys?: () => void;
	onPasteImage?: () => void;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createSubmission(input: {
	text: string;
	images?: InteractiveModeContext["pendingImages"];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		cancelled: false,
		started: false,
	};
}

function createContext(): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		abort: ReturnType<typeof vi.fn>;
		abortBash: ReturnType<typeof vi.fn>;
		abortEval: ReturnType<typeof vi.fn>;
		addMessageToChat: ReturnType<typeof vi.fn>;
		cancelPendingSubmission: ReturnType<typeof vi.fn>;
		clearQueue: ReturnType<typeof vi.fn>;
		ensureLoadingAnimation: ReturnType<typeof vi.fn>;
		handleBtwCommand: ReturnType<typeof vi.fn>;
		handleBtwEscape: ReturnType<typeof vi.fn>;
		hasActiveBtw: ReturnType<typeof vi.fn>;
		onInputCallback: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		startPendingSubmission: ReturnType<typeof vi.fn>;
		clearEditor: ReturnType<typeof vi.fn>;
	};
} {
	let editorText = "";
	const abort = vi.fn(() => Promise.resolve());
	const abortBash = vi.fn();
	const abortEval = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const prompt = vi.fn();
	const requestRender = vi.fn();
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const startPendingSubmission = vi.fn((input: { text: string; images?: InteractiveModeContext["pendingImages"] }) => {
		ensureLoadingAnimation();
		return createSubmission(input);
	});
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	let ctx!: InteractiveModeContext;
	const clearEditor = vi.fn(() => {
		editor.setText("");
		ctx.pendingImages = [];
	});
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	ctx = {
		settings: { get: () => undefined } as unknown as InteractiveModeContext["settings"],
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			hasQueuedSteering: false,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortEval,
			clearQueue,
			prompt,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "existing session",
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: () => [],
		} as unknown as InteractiveModeContext["keybindings"],
		pendingImages: [],
		lastEscapeTime: 0,
		lastComposerClearEscapeTime: 0,
		clearEditor,
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		ensureLoadingAnimation,
		finishPendingSubmission: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		markPendingSubmissionStarted: vi.fn(() => true),
		startPendingSubmission,
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleSTTToggle: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: {
			abort,
			abortBash,
			abortEval,
			addMessageToChat,
			cancelPendingSubmission,
			clearQueue,
			ensureLoadingAnimation,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			onInputCallback,
			prompt,
			requestRender,
			startPendingSubmission,
			clearEditor,
		},
	};
}

describe("InputController escape behavior", () => {
	it("prefers canceling a pending optimistic submission before aborting the session", async () => {
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "hello" });
		spies.startPendingSubmission.mockReturnValue(submission);
		spies.cancelPendingSubmission.mockReturnValue(true);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("hello");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({ text: "hello", images: undefined });
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("runs /btw as a builtin side request instead of steering the active stream", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/btw why is it doing that?");
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("falls back to aborting the active session when no pending optimistic submission exists", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});

	it("prefers aborting bash before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting python before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isEvalRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isEvalRunning: boolean }).isEvalRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortEval).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting the main stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before canceling a pending optimistic submission", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting bash", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("aborts streaming even when the working loader is no longer present", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});

	it("silently consumes a queued steer on the first Esc instead of a loud abort", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ cause: "user_interrupt", silent: true }));
		expect(spies.clearQueue).not.toHaveBeenCalled();
	});

	it("does a real abort on the second Esc while a steer consume is still pending", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // first: silent steer consume
		editor.onEscape?.(); // second: real abort, dropping the steer to the editor

		expect(spies.abort).toHaveBeenCalledTimes(2);
		expect(spies.abort.mock.calls[0]?.[0]).toMatchObject({ silent: true });
		expect(spies.abort.mock.calls[1]?.[0]?.silent).toBeUndefined();
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
	});

	it("cancels a queued steer on second Esc after silent abort cleanup goes idle", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		spies.clearQueue.mockReturnValue({ steering: ["stop after this"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		(ctx.session as { isStreaming: boolean }).isStreaming = false;
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(2);
		expect(spies.abort.mock.calls[0]?.[0]).toMatchObject({ silent: true });
		expect(spies.abort.mock.calls[1]?.[0]?.silent).toBeUndefined();
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("stop after this");
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(false);
	});
	it("double Esc clears a composed draft without aborting an active stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("single Esc with a composed draft neither clears nor aborts", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft message");
	});

	it("double Esc clears a composed draft without aborting a running bash command", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft");
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
	});

	it("double Esc clears a composed draft without aborting a running eval", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isEvalRunning: boolean }).isEvalRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft");
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.abortEval).not.toHaveBeenCalled();
	});

	it("clears pending images along with the composed text on double Esc", () => {
		const { ctx, editor, spies } = createContext();
		ctx.pendingImages = [{} as InteractiveModeContext["pendingImages"][number]];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft");
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(ctx.pendingImages).toHaveLength(0);
	});

	it("keeps aborting an active stream on a single Esc when the composer is empty", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.clearEditor).not.toHaveBeenCalled();
	});

	it("bash input mode still exits and clears on Esc without using the double-Esc clear path", () => {
		const { ctx, editor, spies } = createContext();
		ctx.isBashMode = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("!ls");
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
		expect(ctx.isBashMode).toBe(false);
	});

	it("re-arms instead of clearing when the second Esc falls outside the 500ms window", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft");
		editor.onEscape?.();
		ctx.lastComposerClearEscapeTime = Date.now() - 1000;
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");
	});
	it("treats a whitespace-only composer as empty and still aborts an active stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("   ");
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.clearEditor).not.toHaveBeenCalled();
	});

	it("does not let an empty-composer Esc satisfy the composer-clear second press for a later draft", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		// First Esc on an empty composer arms the empty-composer tree/branch timer.
		editor.onEscape?.();
		// User then types a draft and presses Esc once within 500ms.
		editor.setText("draft message");
		editor.onEscape?.();

		// The first Esc on the draft must stay silent (no cross-contamination).
		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft message");
	});

	it("does not let a composer-text Esc satisfy the empty-composer double-Esc after the draft is removed", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		// First Esc with a draft arms the composer-clear timer.
		editor.setText("draft message");
		editor.onEscape?.();
		// User clears the draft manually, then presses Esc once within 500ms.
		editor.setText("");
		editor.onEscape?.();

		// The empty-composer double-Esc action must not fire on this single empty Esc.
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});
});
