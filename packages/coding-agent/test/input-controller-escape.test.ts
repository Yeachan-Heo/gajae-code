import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type {
	ComposerSubmissionOptions,
	InteractiveModeContext,
	SubmittedUserInput,
} from "@gajae-code/coding-agent/modes/types";
import { SubagentTool, type ToolSession } from "@gajae-code/coding-agent/tools";
import type { SlashCommand } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterAll(() => {
	resetSettingsForTest();
});
afterEach(() => {
	settings.set("doubleEscapeAction", "tree");
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
	getCursor(): { line: number; col: number };
	setCursor(line: number, col: number): void;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

type FakeInputListenerResult = { consume?: boolean; data?: string } | undefined;
type FakeInputListener = (data: string) => FakeInputListenerResult;

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
	inputListeners: FakeInputListener[];
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
		abortCompaction: ReturnType<typeof vi.fn>;
		abortHandoff: ReturnType<typeof vi.fn>;
		abortRetry: ReturnType<typeof vi.fn>;
		retryNow: ReturnType<typeof vi.fn>;
		showStatus: ReturnType<typeof vi.fn>;
	};
} {
	let editorText = "";
	let editorCursor = { line: 0, col: 0 };
	const abort = vi.fn(() => Promise.resolve());
	const abortBash = vi.fn();
	const abortEval = vi.fn();
	const abortCompaction = vi.fn();
	const abortHandoff = vi.fn();
	const abortRetry = vi.fn();
	const retryNow = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const prompt = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const inputListeners: FakeInputListener[] = [];
	const addInputListener = vi.fn((listener: FakeInputListener) => {
		inputListeners.push(listener);
		return () => {
			const index = inputListeners.indexOf(listener);
			if (index >= 0) inputListeners.splice(index, 1);
		};
	});
	const startPendingSubmission = vi.fn(
		(
			input: { text: string; images?: InteractiveModeContext["pendingImages"] },
			_options?: ComposerSubmissionOptions,
		) => {
			ensureLoadingAnimation();
			return createSubmission(input);
		},
	);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
			editorCursor = { line: 0, col: text.length };
			editor.onChange?.(text);
		},
		getText() {
			return editorText;
		},
		getCursor() {
			return editorCursor;
		},
		setCursor(line: number, col: number) {
			editorCursor = { line, col };
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
		ui: { requestRender, addInputListener } as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		retryEscapePrimed: false,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			hasQueuedSteering: false,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortEval,
			abortCompaction,
			abortHandoff,
			abortRetry,
			retryNow,
			clearQueue,
			prompt,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "existing session",
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: (action: string) => (action === "app.interrupt" ? ["escape"] : []),
			getDisplayString: () => "",
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
		showStatus,
		showSessionSelector: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		inputListeners,
		spies: {
			abort,
			abortBash,
			abortEval,
			abortCompaction,
			abortHandoff,
			abortRetry,
			retryNow,
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
			showStatus,
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

		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({ text: "hello", images: undefined });
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: true, editor: ctx.editor });
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("interrupts a live subagent await through Esc without cancelling the child", async () => {
		const { ctx, editor } = createContext();
		const manager = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: 10_000 });
		AsyncJobManager.setInstance(manager);
		const child = Promise.withResolvers<string>();
		const childJobId = manager.register("task", "live child", async () => child.promise, {
			id: "job-input-controller-live-await",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-InputEsc", agent: "executor", agentSource: "bundled" } },
		});
		const parentAbort = new AbortController();
		(ctx.session as { isStreaming: boolean; abort: () => Promise<void> }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; abort: () => Promise<void> }).abort = vi.fn(async () => {
			parentAbort.abort();
		});
		const tool = new SubagentTool({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "0-Main",
		} as ToolSession);
		const awaiting = tool.execute(
			"input-controller-live-await",
			{ action: "await", ids: ["0-InputEsc"], timeout_ms: 10_000 },
			parentAbort.signal,
		);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.onEscape?.();
		const receipt = await awaiting;

		expect(receipt.details?.interrupted).toBe(true);
		expect(receipt.details?.awaitOutcome).toBe("interrupted");
		expect(receipt.details?.subagents[0]?.status).toBe("running");
		expect(manager.getJob(childJobId)?.status).toBe("running");
		child.resolve("completed after Esc");
		await manager.getJob(childJobId)?.promise;
		await manager.dispose({ timeoutMs: 100 });
		AsyncJobManager.resetForTests();
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

	it("cancels compaction even when the composer contains a draft", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isCompacting: boolean }).isCompacting = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft while compacting");
		editor.onEscape?.();

		expect(spies.abortCompaction).toHaveBeenCalledTimes(1);
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft while compacting");
	});

	it("cancels manual handoff even when the composer contains a draft", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft while handing off");
		editor.onEscape?.();

		expect(spies.abortHandoff).toHaveBeenCalledTimes(1);
		expect(spies.abortCompaction).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft while handing off");
	});

	it("cancels auto-handoff through the compaction controller", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isCompacting: boolean; isGeneratingHandoff: boolean }).isCompacting = true;
		(ctx.session as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortCompaction).toHaveBeenCalledTimes(1);
		expect(spies.abortHandoff).not.toHaveBeenCalled();
	});

	it("keeps retry backoff escape handling wired from the central handler", () => {
		const { ctx, editor, spies } = createContext();
		ctx.retryLoader = {} as InteractiveModeContext["retryLoader"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft during retry");
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.retryNow).toHaveBeenCalledTimes(1);
		expect(spies.abortRetry).toHaveBeenCalledTimes(1);
		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft during retry");
	});

	it("globally aborts a workflow stream while a hook dialog has focus", () => {
		const { ctx, inputListeners, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		ctx.hookSelector = {} as InteractiveModeContext["hookSelector"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = inputListeners[0]?.("\x1b");

		expect(result).toEqual({ consume: true });
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ cause: "user_interrupt" }));
	});
	it("lets hook selector inline input handle Esc locally during a workflow stream", () => {
		const { ctx, inputListeners, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		ctx.hookSelector = {
			hasActiveInlineInput: () => true,
		} as InteractiveModeContext["hookSelector"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = inputListeners[0]?.("\x1b");

		expect(result).toBeUndefined();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("does not globally steal draft-clearing Esc from a normal stream", () => {
		const { ctx, editor, inputListeners, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		const result = inputListeners[0]?.("\x1b");

		expect(result).toBeUndefined();
		expect(spies.abort).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft message");
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
	it("interrupts an active stream even when the composer contains a draft", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft message");
	});
	it("hints on a single Esc with a composed draft", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("press Esc again to clear");
		expect(editor.getText()).toBe("draft message");
	});
	it("clears an idle draft and saves it to prompt history on double Esc", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(editor.addToHistory).toHaveBeenCalledWith("draft message");
		expect(editor.getText()).toBe("");
	});
	it("opens the default tree selector on double Esc with an empty editor", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});
	it("opens the branch selector on double Esc when configured", () => {
		settings.set("doubleEscapeAction", "branch");
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
	});

	it("does nothing on double Esc with an empty editor when disabled", () => {
		settings.set("doubleEscapeAction", "none");
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});
	it("interrupts a running bash command even when the composer contains a draft", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft");
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.clearEditor).not.toHaveBeenCalled();
	});
	it("interrupts a running eval even when the composer contains a draft", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isEvalRunning: boolean }).isEvalRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft");
		editor.onEscape?.();

		expect(spies.abortEval).toHaveBeenCalledTimes(1);
		expect(spies.clearEditor).not.toHaveBeenCalled();
	});

	it("keeps Ctrl+C destructive without saving the discarded draft", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		editor.setText("discarded draft");
		editor.onClear?.();

		expect(editor.getText()).toBe("");
		expect(editor.addToHistory).not.toHaveBeenCalled();
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

	it("resets the draft-clear double-Esc state after 800ms", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		try {
			const { ctx, editor, spies } = createContext();
			const controller = new InputController(ctx);

			controller.setupKeyHandlers();
			editor.setText("draft");
			editor.onEscape?.();
			now.mockReturnValue(10_801);
			editor.onEscape?.();

			expect(spies.clearEditor).not.toHaveBeenCalled();
			expect(spies.showStatus).toHaveBeenCalledTimes(2);
			expect(editor.getText()).toBe("draft");
		} finally {
			now.mockRestore();
		}
	});
	it("re-arms draft clearing when the draft changes between Esc presses", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		editor.setText("first draft");
		editor.onEscape?.();
		editor.setText("changed draft");
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("changed draft");
		expect(spies.showStatus).toHaveBeenCalledTimes(2);
	});
	it("disarms draft clearing when autocomplete consumes Esc", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.setText("draft");
		editor.onEscape?.();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(false);
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");
	});
	it("disarms draft clearing when editor input changes modes", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.setText("draft");
		editor.onEscape?.();
		editor.setText("!draft");
		editor.onChange?.("!draft");
		editor.setText("draft");
		editor.onChange?.("draft");
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");
	});

	it("disarms empty-editor rewind when work starts between Esc presses", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.onEscape?.();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		editor.onEscape?.();
		(ctx.session as { isStreaming: boolean }).isStreaming = false;
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});

	it("disarms both gestures when a higher-priority Esc consumer handles the key", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.setText("draft");
		editor.onEscape?.();
		spies.hasActiveBtw.mockReturnValue(true);
		editor.onEscape?.();
		spies.hasActiveBtw.mockReturnValue(false);
		editor.onEscape?.();

		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");

		editor.setText("");
		editor.onEscape?.();
		spies.hasActiveBtw.mockReturnValue(true);
		editor.onEscape?.();
		spies.hasActiveBtw.mockReturnValue(false);
		editor.onEscape?.();

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
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
describe("InputController command palette", () => {
	it("runs registered actions directly and excludes unsupported actions and self-reentry", () => {
		const { ctx } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		(ctx.keybindings as unknown as { getKeys(action: string): string[] }).getKeys = action =>
			action === "app.session.tree" ? ["ctrl+d"] : [];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.openCommandPalette();

		const actions = showCommandPalette.mock.calls[0]?.[1] as Array<{
			id: string;
			handler: () => void;
		}>;
		const tree = actions.find(action => action.id === "app.session.tree");
		const fork = actions.find(action => action.id === "app.session.fork");

		expect(tree).toBeDefined();
		tree?.handler();
		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		fork?.handler();
		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(actions.some(action => action.id === "app.session.delete")).toBe(false);
		expect(actions.some(action => action.id === "app.commandPalette.open")).toBe(false);
	});

	it("refuses slash commands when the composer has text without touching the draft", async () => {
		const { ctx, editor, spies } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		ctx.handleChangelogCommand = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "changelog" }] as SlashCommand[], "");
		editor.setText("existing draft");

		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;
		await executeSlashCommand("changelog");

		expect(ctx.handleChangelogCommand).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Send or clear the draft before running a palette command.");
		expect(editor.getText()).toBe("existing draft");
		expect(ctx.pendingImages).toEqual([]);
	});
	it("refuses slash commands when only pending images are present without touching the composer", async () => {
		const { ctx, editor, spies } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		ctx.handleChangelogCommand = vi.fn();
		const attachment = { type: "image", data: "attachment" } as InteractiveModeContext["pendingImages"][number];
		ctx.pendingImages = [attachment];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "changelog" }] as SlashCommand[], "");

		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;
		await executeSlashCommand("changelog");

		expect(ctx.handleChangelogCommand).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Send or clear the draft before running a palette command.");
		expect(editor.getText()).toBe("");
		expect(ctx.pendingImages).toEqual([attachment]);
	});
	it("dispatches slash commands from an empty composer", async () => {
		const { ctx } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		ctx.handleChangelogCommand = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "changelog" }] as SlashCommand[], "");

		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;
		await executeSlashCommand("changelog");

		expect(ctx.handleChangelogCommand).toHaveBeenCalledTimes(1);
	});
	it("dispatches slash commands when the UI focus capability is unavailable", async () => {
		const { ctx } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		ctx.handleChangelogCommand = vi.fn();
		(ctx.ui as { setFocus?: (target: unknown) => void }).setFocus = undefined;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "changelog" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;
		await executeSlashCommand("changelog");

		expect(ctx.handleChangelogCommand).toHaveBeenCalledTimes(1);
	});
	it("runs action entries with a draft without touching the composer", () => {
		const { ctx, editor } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("existing draft");
		controller.openCommandPalette();
		const actions = showCommandPalette.mock.calls[0]?.[1] as Array<{ id: string; handler: () => void }>;
		const tree = actions.find(action => action.id === "app.session.tree");

		tree?.handler();

		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("existing draft");
		expect(ctx.pendingImages).toEqual([]);
	});
	it("keeps a draft typed after an empty-composer slash dispatch while command cleanup settles", async () => {
		const { ctx, editor, spies } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		ctx.withLocalSubmission = async (_text, submit) => submit();
		const commandEntered = Promise.withResolvers<void>();
		const commandRelease = Promise.withResolvers<void>();
		spies.prompt.mockImplementation(async () => {
			commandEntered.resolve();
			await commandRelease.promise;
		});
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "delayed" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;
		const execution = executeSlashCommand("delayed");
		await commandEntered.promise;
		expect(spies.prompt).toHaveBeenCalledTimes(1);

		editor.setText("new draft");
		commandRelease.resolve();
		await execution;

		// Command-authored composer mutations are the command's contract, not the palette's.
		expect(editor.getText()).toBe("new draft");
	});
	it("preserves newer composer state when an async palette input hook handles the command", async () => {
		const { ctx, editor } = createContext();
		const showCommandPalette = vi.fn();
		const hookEntered = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const successorImage = { type: "image", data: "successor" } as InteractiveModeContext["pendingImages"][number];
		ctx.showCommandPalette = showCommandPalette;
		(ctx.session as unknown as { extensionRunner: unknown }).extensionRunner = {
			hasHandlers: () => true,
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				hookEntered.resolve();
				await hookRelease.promise;
				return { handled: true };
			}),
		};
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "delayed" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;

		const execution = executeSlashCommand("delayed");
		await hookEntered.promise;
		editor.setText("/delayed");
		editor.setCursor(0, 3);
		ctx.pendingImages = [successorImage];
		hookRelease.resolve();
		await execution;

		expect(editor.getText()).toBe("/delayed");
		expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
		expect(ctx.pendingImages).toEqual([successorImage]);
		expect(editor.addToHistory).not.toHaveBeenCalled();
	});
	it("dispatches transformed palette input without claiming newer composer state", async () => {
		const { ctx, editor, spies } = createContext();
		const showCommandPalette = vi.fn();
		const hookEntered = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const successorImage = { type: "image", data: "new-image" } as InteractiveModeContext["pendingImages"][number];
		ctx.showCommandPalette = showCommandPalette;
		(ctx.session as unknown as { extensionRunner: unknown }).extensionRunner = {
			hasHandlers: () => true,
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				hookEntered.resolve();
				await hookRelease.promise;
				return { text: "transformed prompt", images: [] };
			}),
		};
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "delayed" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;

		const execution = executeSlashCommand("delayed");
		await hookEntered.promise;
		editor.setText("new draft");
		editor.setCursor(0, 4);
		ctx.pendingImages = [successorImage];
		hookRelease.resolve();
		await execution;

		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({
			text: "transformed prompt",
			images: undefined,
		});
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: false, editor });
		expect(editor.getText()).toBe("new draft");
		expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
		expect(ctx.pendingImages).toEqual([successorImage]);
		expect(editor.addToHistory).not.toHaveBeenCalled();
	});
	it("preserves successor composer state for transformed streaming and compaction paths", async () => {
		for (const mode of ["streaming", "compacting"] as const) {
			const { ctx, editor, spies } = createContext();
			const showCommandPalette = vi.fn();
			const hookEntered = Promise.withResolvers<void>();
			const hookRelease = Promise.withResolvers<void>();
			const queueCompactionMessage = vi.fn();
			ctx.showCommandPalette = showCommandPalette;
			ctx.withLocalSubmission = async (_text, submit) => submit();
			ctx.queueCompactionMessage = queueCompactionMessage;
			(ctx.session as { isStreaming: boolean; isCompacting: boolean }).isStreaming = mode === "streaming";
			(ctx.session as { isStreaming: boolean; isCompacting: boolean }).isCompacting = mode === "compacting";
			(ctx.session as unknown as { extensionRunner: unknown }).extensionRunner = {
				hasHandlers: () => true,
				getShortcuts: () => [],
				emitInput: vi.fn(async () => {
					hookEntered.resolve();
					await hookRelease.promise;
					return { text: "transformed prompt" };
				}),
			};
			const controller = new InputController(ctx);
			controller.setupKeyHandlers();
			controller.createAutocompleteProvider([{ name: "delayed" }] as SlashCommand[], "");
			controller.openCommandPalette();
			const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;

			const execution = executeSlashCommand("delayed");
			await hookEntered.promise;
			editor.setText(`${mode} successor`);
			editor.setCursor(0, 5);
			hookRelease.resolve();
			await execution;

			expect(editor.getText()).toBe(`${mode} successor`);
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
			expect(editor.addToHistory).not.toHaveBeenCalled();
			if (mode === "streaming") {
				expect(spies.prompt).toHaveBeenCalledTimes(1);
			} else {
				expect(queueCompactionMessage).toHaveBeenCalledWith("transformed prompt", "steer", {
					ownsComposer: false,
					editor,
				});
			}
		}
	});
	it("does not write through replacement editor or session state after the palette hook settles", async () => {
		const { ctx, editor, spies } = createContext();
		const showCommandPalette = vi.fn();
		const hookEntered = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		ctx.showCommandPalette = showCommandPalette;
		(ctx.session as unknown as { extensionRunner: unknown }).extensionRunner = {
			hasHandlers: () => true,
			getShortcuts: () => [],
			emitInput: vi.fn(async () => {
				hookEntered.resolve();
				await hookRelease.promise;
				return { text: "replacement prompt" };
			}),
		};
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "delayed" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;

		const execution = executeSlashCommand("delayed");
		await hookEntered.promise;
		const replacement = { ...editor, setText: vi.fn(), addToHistory: vi.fn() };
		ctx.editor = replacement as unknown as InteractiveModeContext["editor"];
		ctx.session = { ...ctx.session } as InteractiveModeContext["session"];
		hookRelease.resolve();
		await execution;
		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({
			text: "replacement prompt",
			images: undefined,
		});
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: false, editor });

		expect(replacement.setText).not.toHaveBeenCalled();
		expect(replacement.addToHistory).not.toHaveBeenCalled();
	});
	it("releases the palette latch after a cancelled input hook without mutating the composer", async () => {
		const { ctx, editor } = createContext();
		const showCommandPalette = vi.fn();
		const hookEntered = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const successorImage = {
			type: "image",
			data: "cancelled-successor",
		} as InteractiveModeContext["pendingImages"][number];
		const emitInput = vi.fn(async (): Promise<{ handled?: boolean }> => {
			hookEntered.resolve();
			await hookRelease.promise;
			throw Object.assign(new Error("input hook cancelled"), { name: "AbortError" });
		});
		ctx.showCommandPalette = showCommandPalette;
		(ctx.session as unknown as { extensionRunner: unknown }).extensionRunner = {
			hasHandlers: () => true,
			getShortcuts: () => [],
			emitInput,
		};
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "delayed" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;

		const first = executeSlashCommand("delayed");
		await hookEntered.promise;
		editor.setText("new draft");
		editor.setCursor(0, 2);
		ctx.pendingImages = [successorImage];
		hookRelease.resolve();
		await expect(first).rejects.toThrow("input hook cancelled");
		expect(editor.getText()).toBe("new draft");
		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
		expect(ctx.pendingImages).toEqual([successorImage]);
		editor.setText("");
		ctx.pendingImages = [];

		emitInput.mockResolvedValueOnce({ handled: true });
		await executeSlashCommand("delayed");
		expect(emitInput).toHaveBeenCalledTimes(2);
	});
	it("refuses a second palette command while the first is pending", async () => {
		const { ctx, spies } = createContext();
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		let resolveChangelog!: () => void;
		ctx.handleChangelogCommand = vi.fn(
			() =>
				new Promise<void>(resolve => {
					resolveChangelog = resolve;
				}),
		);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.createAutocompleteProvider([{ name: "changelog" }] as SlashCommand[], "");
		controller.openCommandPalette();
		const executeSlashCommand = showCommandPalette.mock.calls[0]?.[2] as (name: string) => Promise<void>;
		const first = executeSlashCommand("changelog");
		await Promise.resolve();
		await executeSlashCommand("changelog");

		expect(ctx.handleChangelogCommand).toHaveBeenCalledTimes(1);
		expect(spies.showStatus).toHaveBeenCalledWith("A palette command is still running.");

		resolveChangelog();
		await first;
	});
});
