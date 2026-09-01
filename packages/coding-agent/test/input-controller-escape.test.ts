import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { KEYBINDINGS } from "@gajae-code/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	AVAILABILITY_GATED_NAV_PALETTE_ACTIONS,
	InputController,
} from "@gajae-code/coding-agent/modes/controllers/input-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type {
	ComposerSubmissionOptions,
	InteractiveModeContext,
	SubmittedUserInput,
} from "@gajae-code/coding-agent/modes/types";
import { associateSessionMessageViewportAnchorId } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SubagentTool } from "@gajae-code/coding-agent/tools/implementations";
import type { SlashCommand } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	// Palette entries that open themed overlays (queue pane) construct real
	// components, which read the theme.
	await initTheme(false);
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

/**
 * Set the fake session's queue accounting the way AgentSession derives it:
 * `queuedMessageCount` aggregates all three queues while
 * `drainableQueuedMessageCount` counts only the steering/follow-up entries the
 * restore/clear handlers can actually return. Tests must never set them
 * independently, or a guard reading the wrong one would still look correct.
 */
function setQueueCounts(
	ctx: InteractiveModeContext,
	counts: { steering?: number; followUp?: number; nextTurn?: number },
): void {
	const steering = counts.steering ?? 0;
	const followUp = counts.followUp ?? 0;
	const nextTurn = counts.nextTurn ?? 0;
	Object.assign(ctx.session as unknown as Record<string, unknown>, {
		queuedMessageCount: steering + followUp + nextTurn,
		drainableQueuedMessageCount: steering + followUp,
		pendingMessageCounts: { steering, followUp, nextTurn },
	});
}

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

function createContext(options: { interruptKeys?: string[]; clearKeys?: string[] } = {}): {
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
		stopLoadingAnimation: Mock<() => void>;
		hasPendingSubmission: Mock<() => boolean>;
		handleBtwCommand: ReturnType<typeof vi.fn>;
		handleBtwEscape: ReturnType<typeof vi.fn>;
		hasActiveBtw: ReturnType<typeof vi.fn>;
		onInputCallback: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		startPendingSubmission: ReturnType<typeof vi.fn>;
		clearEditor: ReturnType<typeof vi.fn>;
		shutdown: ReturnType<typeof vi.fn>;
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
	const hasPendingSubmission = vi.fn(() => false);
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
	const shutdown = vi.fn(() => Promise.resolve());
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	const stopLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = undefined;
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
			drainableQueuedMessageCount: 0,
			pendingMessageCounts: { steering: 0, followUp: 0, nextTurn: 0 },
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
			getKeys: (action: string) =>
				action === "app.interrupt"
					? (options.interruptKeys ?? ["escape"])
					: action === "app.clear"
						? (options.clearKeys ?? ["ctrl+c"])
						: [],
			getDisplayString: () => "",
		} as unknown as InteractiveModeContext["keybindings"],
		pendingImages: [],
		lastEscapeTime: 0,
		lastComposerClearEscapeTime: 0,
		clearEditor,
		shutdown,
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		hasPendingSubmission,
		ensureLoadingAnimation,
		stopLoadingAnimation,
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
			hasPendingSubmission,
			clearQueue,
			ensureLoadingAnimation,
			stopLoadingAnimation,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			onInputCallback,
			prompt,
			requestRender,
			startPendingSubmission,
			clearEditor,
			shutdown,
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
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
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
	it("keeps aborting a started submission that is still inside prompt preflight (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		// markPendingSubmissionAlready flipped `started`, so cancelPendingSubmission
		// returns false, and session.prompt() has not flipped isStreaming yet (it is
		// still awaiting its startup barrier/selection fence). The submission is
		// still pending, so Esc must abort it — not stop the loader as stale and let
		// the prompt begin later despite the user's cancellation.
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasPendingSubmission.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ cause: "user_interrupt" }));
	});
	it("clears a stale working loader instead of swallowing Esc after work completed (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		// Completed work: the turn settled (not streaming/compacting, nothing
		// queued) but the busy indicator never unmounted. Esc must stop the
		// stale loader, fall through to idle semantics, and never abort.
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		editor.setText("draft message");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		// Fall-through is the idle draft-clear gesture, not a silent no-op.
		expect(spies.showStatus).toHaveBeenCalledWith("press Esc again to clear");
		expect(editor.getText()).toBe("draft message");

		// The second press now lands on an idle composer and clears the draft.
		editor.onEscape?.();
		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("still restores queued work behind a loader after the turn ended (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		setQueueCounts(ctx, { steering: 2 });
		spies.clearQueue.mockReturnValue({ steering: ["queued steer"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).not.toHaveBeenCalled();
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("queued steer");
	});

	it("restores a follow-up-only queue behind a loader after the turn ended (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		// Follow-up entries are drainable too: `clearQueue()` returns them, so the
		// loader is real work and Esc must restore + abort rather than stop it.
		setQueueCounts(ctx, { followUp: 1 });
		spies.clearQueue.mockReturnValue({ steering: [], followUp: ["queued follow-up"] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).not.toHaveBeenCalled();
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("queued follow-up");
	});

	it("restores a compaction-only queue behind a loader after the turn ended (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		// Compaction queues live on the controller context, not the session, and are
		// drained by the same handler, so they also keep the loader classified live.
		ctx.compactionQueuedMessages = [{ text: "queued during compaction", mode: "followUp" }];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("queued during compaction");
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	it("recovers Esc behind a stale loader when only hidden next-turn context is queued (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		// A `todo_write` failure during the turn queued a hidden reminder with
		// `deliverAs: "nextTurn"` and no `triggerTurn`, so it deliberately survives
		// turn completion and the aggregate `queuedMessageCount` stays nonzero
		// forever. The restore/clear handlers never drain it, so gating on the
		// aggregate made every press a no-op abort and locked the user out.
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		setQueueCounts(ctx, { nextTurn: 1 });
		editor.setText("draft message");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(spies.abort).not.toHaveBeenCalled();
		// The hidden entry is neither delivered nor cleared by recovery.
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(ctx.session.pendingMessageCounts.nextTurn).toBe(1);
		expect(spies.showStatus).toHaveBeenCalledWith("press Esc again to clear");
		expect(editor.getText()).toBe("draft message");

		editor.onEscape?.();
		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
		expect(ctx.session.pendingMessageCounts.nextTurn).toBe(1);
	});

	it("releases Ctrl+C to the editor behind a stale loader with hidden next-turn context (#4741)", () => {
		const { ctx, editor, inputListeners, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		setQueueCounts(ctx, { nextTurn: 1 });
		editor.setText("draft message");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const first = inputListeners[0]?.("\x03");

		expect(first).toBeUndefined();
		expect(spies.stopLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		if (!first?.consume) editor.onClear?.();
		expect(editor.getText()).toBe("");
		expect(ctx.session.pendingMessageCounts.nextTurn).toBe(1);
	});

	it("still aborts a drainable queue that coexists with hidden next-turn context (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		// Concurrent queues: a visible steer plus hidden context. The visible entry
		// is drainable, so this is live work — recovery must not reclassify it.
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		setQueueCounts(ctx, { steering: 1, nextTurn: 2 });
		spies.clearQueue.mockReturnValue({ steering: ["queued steer"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).not.toHaveBeenCalled();
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("queued steer");
		// Aborting drainable work leaves the hidden queue untouched.
		expect(ctx.session.pendingMessageCounts.nextTurn).toBe(2);
	});

	it("keeps aborting a retrying session behind a loader with hidden next-turn context (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		// Retry keeps the loader mounted with no drainable queue; the streaming
		// flag is what marks it live, and hidden context must not change that.
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		setQueueCounts(ctx, { nextTurn: 1 });
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopLoadingAnimation).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(ctx.session.pendingMessageCounts.nextTurn).toBe(1);
	});

	it("clears the stale loader through the global Ctrl+C listener after work completed (#4741)", () => {
		const { ctx, editor, inputListeners, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		editor.setText("draft message");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const first = inputListeners[0]?.("\x03");
		// The listener stopped the stale loader and released the clear key to the
		// editor, whose idle clear path empties the composer instead of a no-op abort.
		expect(first).toBeUndefined();
		expect(spies.stopLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(spies.abort).not.toHaveBeenCalled();
		if (!first?.consume) editor.onClear?.();
		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});
	it("restores the empty-editor double-Esc gesture behind a stale loader after work completed (#4741)", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		// One controlled clock across both presses: the first Esc must arm the real
		// timing window itself. Overwriting `lastEscapeTime` by hand would pass even
		// if the recovered press never reached the empty-editor branch at all.
		const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
		try {
			editor.onEscape?.();

			expect(spies.stopLoadingAnimation).toHaveBeenCalledTimes(1);
			expect(spies.abort).not.toHaveBeenCalled();
			// Armed by the recovered press, not by the test.
			expect(ctx.lastEscapeTime).toBe(10_000);
			expect(ctx.showTreeSelector).not.toHaveBeenCalled();

			// Second press inside the window reaches the idle double-Esc action.
			now.mockReturnValue(10_100);
			editor.onEscape?.();
		} finally {
			now.mockRestore();
		}
		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
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
	it("globally aborts an active workflow stream on Ctrl+C without clearing the composer", () => {
		const { ctx, editor, inputListeners, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		editor.setText("draft message");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = inputListeners[0]?.("\x03");

		expect(result).toEqual({ consume: true });
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ cause: "user_interrupt" }));
		expect(spies.clearEditor).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft message");
	});
	it("falls through to the editor for idle Ctrl+C clear and double-press shutdown", async () => {
		const { ctx, editor, inputListeners, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		const first = inputListeners[0]?.("\x03");
		if (!first?.consume) editor.onClear?.();
		await Bun.sleep(0);
		expect(first).toBeUndefined();
		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.shutdown).not.toHaveBeenCalled();

		const second = inputListeners[0]?.("\x03");
		if (!second?.consume) editor.onClear?.();
		await Bun.sleep(0);
		expect(second).toBeUndefined();
		expect(spies.shutdown).toHaveBeenCalledTimes(1);
	});
	it("honors remapped and multiple clear bindings at the listener boundary", () => {
		const { ctx, inputListeners, spies } = createContext({ clearKeys: ["ctrl+x", "ctrl+c"] });
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(inputListeners[0]?.("\x18")).toEqual({ consume: true });
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});
	it("uses clear cancellation for loading, process, mode, maintenance, and retry states", () => {
		const cases = [
			{
				name: "loading",
				setup: (ctx: InteractiveModeContext) => {
					ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
					(ctx.session as { isStreaming: boolean }).isStreaming = true;
				},
				assert: (spies: ReturnType<typeof createContext>["spies"]) => expect(spies.clearQueue).toHaveBeenCalled(),
			},
			{
				name: "bash process",
				setup: (ctx: InteractiveModeContext) => {
					(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
				},
				assert: (spies: ReturnType<typeof createContext>["spies"]) =>
					expect(spies.abortBash).toHaveBeenCalledTimes(1),
			},
			{
				name: "bash mode",
				setup: (ctx: InteractiveModeContext) => {
					ctx.isBashMode = true;
				},
				assert: (spies: ReturnType<typeof createContext>["spies"]) =>
					expect(spies.clearEditor).not.toHaveBeenCalled(),
			},
			{
				name: "maintenance",
				setup: (ctx: InteractiveModeContext) => {
					(ctx.session as { isCompacting: boolean }).isCompacting = true;
				},
				assert: (spies: ReturnType<typeof createContext>["spies"]) =>
					expect(spies.abortCompaction).toHaveBeenCalledTimes(1),
			},
			{
				name: "retry",
				setup: (ctx: InteractiveModeContext) => {
					ctx.retryLoader = {} as InteractiveModeContext["retryLoader"];
				},
				assert: (spies: ReturnType<typeof createContext>["spies"]) => {
					expect(spies.abortRetry).toHaveBeenCalledTimes(1);
					expect(spies.retryNow).not.toHaveBeenCalled();
				},
			},
		] as const;

		for (const testCase of cases) {
			const { ctx, inputListeners, spies } = createContext();
			testCase.setup(ctx);
			new InputController(ctx).setupKeyHandlers();
			expect(inputListeners[0]?.("\x03"), testCase.name).toEqual({ consume: true });
			testCase.assert(spies);
		}
	});
	it("preserves BTW precedence and queued-steer first/second Ctrl+C semantics", () => {
		const overlay = createContext();
		overlay.spies.hasActiveBtw.mockReturnValue(true);
		new InputController(overlay.ctx).setupKeyHandlers();
		expect(overlay.inputListeners[0]?.("\x03")).toEqual({ consume: true });
		expect(overlay.spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(overlay.spies.abort).not.toHaveBeenCalled();

		const queued = createContext();
		(queued.ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(queued.ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		new InputController(queued.ctx).setupKeyHandlers();
		expect(queued.inputListeners[0]?.("\x03")).toEqual({ consume: true });
		expect(queued.spies.abort).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
		expect(queued.inputListeners[0]?.("\x03")).toEqual({ consume: true });
		expect(queued.spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(queued.spies.abort).toHaveBeenCalledTimes(2);
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

	it("consumes a queued steer on the first Esc while the streaming busy indicator is mounted", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		// Every streaming turn mounts the activity indicator, so the busy branch is
		// live for the exact case steer-on-interrupt is meant to handle.
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		(ctx.session as { drainableQueuedMessageCount: number }).drainableQueuedMessageCount = 1;
		spies.clearQueue.mockReturnValue({ steering: ["do this instead"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ cause: "user_interrupt", silent: true }));
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("consumes a queued steer while the started submission for that turn is still pending", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		(ctx.session as { drainableQueuedMessageCount: number }).drainableQueuedMessageCount = 1;
		// The submission that started this turn is only finished in the turn-level
		// `finally`, so it stays pending for the whole stream. It has already started,
		// so `cancelPendingSubmission()` declines it.
		spies.hasPendingSubmission.mockReturnValue(true);
		spies.cancelPendingSubmission.mockReturnValue(false);
		spies.clearQueue.mockReturnValue({ steering: ["do this instead"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ cause: "user_interrupt", silent: true }));
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("still cancels an unstarted submission before a queued steer claims the key", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasPendingSubmission.mockReturnValue(true);
		spies.cancelPendingSubmission.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("still aborts loudly on the second Esc when the busy indicator is mounted", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		(ctx.session as { drainableQueuedMessageCount: number }).drainableQueuedMessageCount = 1;
		spies.clearQueue.mockReturnValue({ steering: ["do this instead"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(2);
		expect(spies.abort.mock.calls[0]?.[0]).toMatchObject({ silent: true });
		expect(spies.abort.mock.calls[1]?.[0]?.silent).toBeUndefined();
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("do this instead");
	});

	it("consumes a queued steer on the first Ctrl+C while the streaming busy indicator is mounted", () => {
		const { ctx, inputListeners, spies } = createContext();
		(ctx.session as { isStreaming: boolean; hasQueuedSteering: boolean }).isStreaming = true;
		(ctx.session as { hasQueuedSteering: boolean }).hasQueuedSteering = true;
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		(ctx.session as { drainableQueuedMessageCount: number }).drainableQueuedMessageCount = 1;
		spies.clearQueue.mockReturnValue({ steering: ["do this instead"], followUp: [] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(inputListeners[0]?.("\x03")).toEqual({ consume: true });
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

describe("InputController deferred submissions", () => {
	it("stores accepted normal input while no callback is installed and clears its owned composer", async () => {
		const { ctx, editor } = createContext();
		ctx.onInputCallback = undefined;
		const controller = new InputController(ctx);

		editor.setText("  deferred message  ");
		await controller.submitText("  deferred message  ", { ownsComposer: true, editor: ctx.editor });

		expect(editor.getText()).toBe("");
		expect(editor.addToHistory).toHaveBeenCalledTimes(1);
		expect(editor.addToHistory).toHaveBeenCalledWith("deferred message");
	});

	it("promotes a deferred submission once with its copied images", async () => {
		const { ctx, spies } = createContext();
		ctx.onInputCallback = undefined;
		const image = { type: "image", data: "deferred-image" } as InteractiveModeContext["pendingImages"][number];
		const images = [image];
		ctx.pendingImages = images;
		const controller = new InputController(ctx);

		await controller.submitText("[image 1] deferred message", { ownsComposer: true, editor: ctx.editor });
		const submission = controller.takeDeferredSubmission();

		expect(submission).toEqual(createSubmission({ text: "[image 1] deferred message", images }));
		expect(spies.startPendingSubmission).toHaveBeenCalledWith(
			{ text: "[image 1] deferred message", images },
			{ ownsComposer: false, editor: ctx.editor },
		);
		expect(spies.startPendingSubmission.mock.calls[0]?.[0].images).not.toBe(images);
		expect(controller.takeDeferredSubmission()).toBeUndefined();
	});

	it("does not clear a newer editor draft when promoting a deferred submission", async () => {
		const { ctx, editor, spies } = createContext();
		ctx.onInputCallback = undefined;
		const controller = new InputController(ctx);

		await controller.submitText("deferred message", { ownsComposer: true, editor: ctx.editor });
		editor.setText("newer draft");
		controller.takeDeferredSubmission();

		expect(editor.getText()).toBe("newer draft");
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: false, editor: ctx.editor });
	});

	it("retains a newer draft when the deferred slot is already occupied", async () => {
		const { ctx, editor, spies } = createContext();
		ctx.onInputCallback = undefined;
		const image = { type: "image", data: "newer-image" } as InteractiveModeContext["pendingImages"][number];
		const controller = new InputController(ctx);

		await controller.submitText("first message", { ownsComposer: true, editor: ctx.editor });
		editor.setText("second message");
		ctx.pendingImages = [image];
		await controller.submitText("second message", { ownsComposer: true, editor: ctx.editor });

		expect(editor.getText()).toBe("second message");
		expect(ctx.pendingImages).toEqual([image]);
		expect(spies.showStatus).toHaveBeenCalledWith(
			"Your previous message is waiting to be sent. Keep this draft and send it again shortly.",
		);
		expect(controller.takeDeferredSubmission()).toEqual(createSubmission({ text: "first message" }));
	});

	it("handles Bash commands without a callback without populating the deferred slot", async () => {
		const { ctx } = createContext();
		ctx.onInputCallback = undefined;
		const handleBashCommand = vi.fn(async () => {});
		ctx.handleBashCommand = handleBashCommand;
		const controller = new InputController(ctx);

		await controller.submitText("! echo deferred", { ownsComposer: true, editor: ctx.editor });

		expect(handleBashCommand).toHaveBeenCalledTimes(1);
		expect(handleBashCommand).toHaveBeenCalledWith("echo deferred", false);
		expect(controller.takeDeferredSubmission()).toBeUndefined();
	});

	it("removes a deferred submission through the shutdown path without promoting it", async () => {
		const { ctx, editor } = createContext();
		ctx.onInputCallback = undefined;
		const controller = new InputController(ctx);

		editor.setText("deferred before shutdown");
		await controller.submitText("deferred before shutdown", { ownsComposer: true, editor: ctx.editor });

		expect(controller.takeDeferredSubmissionForShutdown()).toEqual({
			text: "deferred before shutdown",
			images: undefined,
		});
		expect(controller.takeDeferredSubmission()).toBeUndefined();
	});

	it("discards the deferred slot when the interactive mode stops", async () => {
		const { ctx, editor } = createContext();
		ctx.onInputCallback = undefined;
		const controller = new InputController(ctx);

		editor.setText("deferred before stop");
		await controller.submitText("deferred before stop", { ownsComposer: true, editor: ctx.editor });

		controller.discardDeferredSubmission();

		expect(controller.takeDeferredSubmission()).toBeUndefined();
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

describe("InputController availability-gated navigation palette entries", () => {
	type PaletteAction = { id: string; label: string; handler: () => void | Promise<void> };

	function listPalette(ctx: InteractiveModeContext): PaletteAction[] {
		const showCommandPalette = vi.fn();
		ctx.showCommandPalette = showCommandPalette;
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.openCommandPalette();
		return (showCommandPalette.mock.calls[0]?.[1] ?? []) as PaletteAction[];
	}

	function anchoredUserMessage(anchorId: string): AgentMessage {
		const message = { role: "user", content: "hello" } as unknown as AgentMessage;
		associateSessionMessageViewportAnchorId(message, anchorId);
		return message;
	}

	function stubQueueKeyFormatting(ctx: InteractiveModeContext): void {
		// `#showQueuePane` formats key hints through the keybinding manager; the
		// shared fake only implements getKeys/getDisplayString.
		(ctx.keybindings as unknown as { formatKeyHint(key: string): string }).formatKeyHint = key => key;
	}

	// Literal product contract, deliberately NOT derived from the production list:
	// importing that list would make this test pass even if an id were dropped.
	const EXPECTED_GATED_NAV_IDS = [
		"app.session.dashboard",
		"app.transcript.browse",
		"app.transcript.prevTurn",
		"app.transcript.nextTurn",
		"app.queue.togglePane",
		"app.message.sendNow",
	] as const;

	it("gates exactly the six documented navigation ids", () => {
		expect([...AVAILABILITY_GATED_NAV_PALETTE_ACTIONS].sort()).toEqual([...EXPECTED_GATED_NAV_IDS].sort());
	});

	it("lists every gated navigation id once its predicate holds", () => {
		const { ctx, editor } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		(ctx.session as { messages: AgentMessage[] }).messages = [anchoredUserMessage("anchor-1")];
		editor.setText("draft");

		const ids = listPalette(ctx).map(action => action.id);

		for (const id of EXPECTED_GATED_NAV_IDS) {
			expect(ids).toContain(id);
		}
	});

	it("omits gated ids whose predicate is false and keeps the always-available ones", () => {
		const { ctx } = createContext();

		const ids = listPalette(ctx).map(action => action.id);

		// messages: [] and not streaming -> these four predicates are false.
		expect(ids).not.toContain("app.transcript.browse");
		expect(ids).not.toContain("app.transcript.prevTurn");
		expect(ids).not.toContain("app.transcript.nextTurn");
		expect(ids).not.toContain("app.message.sendNow");
		// `queue.togglePane` returns true and `session.dashboard` falls to default.
		expect(ids).toContain("app.queue.togglePane");
		expect(ids).toContain("app.session.dashboard");
	});

	it("leaves pre-existing ungated entries listed even when their predicate is false", () => {
		const { ctx } = createContext();

		const ids = listPalette(ctx).map(action => action.id);

		// `app.session.tree`/`fork` require messages.length > 0 but are NOT gated,
		// so the opt-in filter must not touch them. A blanket filter over the whole
		// curated map would drop both here.
		expect(ctx.session.messages).toHaveLength(0);
		expect(ids).toContain("app.session.tree");
		expect(ids).toContain("app.session.fork");
	});

	it("omits the todo toggle entry with an empty todo model and lists it once a phase has tasks", () => {
		const { ctx } = createContext();
		ctx.todoPhases = [];

		expect(listPalette(ctx).map(action => action.id)).not.toContain("app.todo.toggle");

		ctx.todoPhases = [
			{ title: "Phase 1", tasks: [{ text: "do the thing", status: "pending" }] },
		] as unknown as InteractiveModeContext["todoPhases"];

		expect(listPalette(ctx).map(action => action.id)).toContain("app.todo.toggle");
	});

	it("labels gated entries from their keybinding description", () => {
		const { ctx } = createContext();

		const dashboard = listPalette(ctx).find(action => action.id === "app.session.dashboard");

		expect(dashboard?.label).toBe(KEYBINDINGS["app.session.dashboard"].description);
	});

	it("dispatches a user remap of a gated id while its default stays empty", () => {
		const { ctx, editor } = createContext();
		(ctx.keybindings as unknown as { getKeys(action: string): string[] }).getKeys = action =>
			action === "app.queue.togglePane" ? ["ctrl+alt+q"] : [];
		const showSessionsDashboard = vi.fn();
		ctx.showSessionsDashboard = showSessionsDashboard;
		const getQueuedMessageEntries = vi.fn(() => [{ id: "q1", text: "queued", mode: "steer", label: "Steering" }]);
		(ctx.session as unknown as { getQueuedMessageEntries: unknown }).getQueuedMessageEntries =
			getQueuedMessageEntries;
		(ctx.ui as unknown as { showOverlay: unknown; setFocus: unknown }).showOverlay = vi.fn(() => ({
			hide: vi.fn(),
		}));
		(ctx.ui as unknown as { setFocus: unknown }).setFocus = vi.fn();
		stubQueueKeyFormatting(ctx);

		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const registered = (editor.setCustomKeyHandler as Mock<(key: string, handler: () => boolean) => void>).mock.calls
			.filter(([key]) => key === "ctrl+alt+q")
			.map(([, handler]) => handler);
		expect(registered).toHaveLength(1);
		expect(KEYBINDINGS["app.queue.togglePane"].defaultKeys).toEqual([]);
		expect(registered[0]?.()).toBe(true);
		expect(getQueuedMessageEntries).toHaveBeenCalled();
	});

	it("refuses a remapped chord for a gated id whose predicate is false", () => {
		const { ctx, editor } = createContext();
		(ctx.keybindings as unknown as { getKeys(action: string): string[] }).getKeys = action =>
			action === "app.transcript.browse" ? ["ctrl+alt+t"] : [];
		const showTranscriptViewer = vi.fn();
		ctx.showTranscriptViewer = showTranscriptViewer;

		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const handler = (
			editor.setCustomKeyHandler as Mock<(key: string, handler: () => boolean) => void>
		).mock.calls.find(([key]) => key === "ctrl+alt+t")?.[1];
		// messages: [] -> unavailable, so the chord falls through instead of firing.
		expect(handler?.()).toBe(false);
		expect(showTranscriptViewer).not.toHaveBeenCalled();
	});

	it("jumps transcript turns through the expected viewport anchor", () => {
		const { ctx } = createContext();
		(ctx.session as { messages: AgentMessage[] }).messages = [
			anchoredUserMessage("anchor-1"),
			anchoredUserMessage("anchor-2"),
		];
		const revealViewportAnchor = vi.fn(() => true);
		(ctx.ui as unknown as { revealViewportAnchor: unknown }).revealViewportAnchor = revealViewportAnchor;

		const actions = listPalette(ctx);
		actions.find(action => action.id === "app.transcript.prevTurn")?.handler();

		expect(revealViewportAnchor).toHaveBeenCalledWith("anchor-2", "top");
	});

	it("opens the queue overlay from the palette with a queued entry present", () => {
		const { ctx } = createContext();
		const overlay = { hide: vi.fn() };
		const showOverlay = vi.fn(() => overlay);
		const setFocus = vi.fn();
		(ctx.session as unknown as { getQueuedMessageEntries: unknown }).getQueuedMessageEntries = vi.fn(() => [
			{ id: "q1", text: "queued", mode: "steer", label: "Steering" },
		]);
		(ctx.ui as unknown as { showOverlay: unknown }).showOverlay = showOverlay;
		(ctx.ui as unknown as { setFocus: unknown }).setFocus = setFocus;
		stubQueueKeyFormatting(ctx);

		const actions = listPalette(ctx);
		actions.find(action => action.id === "app.queue.togglePane")?.handler();

		expect(showOverlay).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalled();
	});

	it("does not open an overlay for the queue pane when nothing is queued", () => {
		const { ctx, spies } = createContext();
		const showOverlay = vi.fn();
		(ctx.session as unknown as { getQueuedMessageEntries: unknown }).getQueuedMessageEntries = vi.fn(() => []);
		(ctx.ui as unknown as { showOverlay: unknown }).showOverlay = showOverlay;
		(ctx.ui as unknown as { setFocus: unknown }).setFocus = vi.fn();
		stubQueueKeyFormatting(ctx);

		const actions = listPalette(ctx);
		actions.find(action => action.id === "app.queue.togglePane")?.handler();

		expect(showOverlay).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("No queued messages");
	});

	describe("sendNow draft semantics", () => {
		function streamingContextWithDraft() {
			const created = createContext();
			(created.ctx.session as { isStreaming: boolean }).isStreaming = true;
			created.editor.setText("  the draft  ");
			created.ctx.updatePendingMessagesDisplay = vi.fn();
			return created;
		}

		it("passes the trimmed draft to cancelAndSubmit exactly once and clears on submitted", async () => {
			const { ctx, editor, spies } = streamingContextWithDraft();
			const cancelAndSubmit = vi.fn(async () => ({ kind: "submitted" }) as const);
			(ctx.session as unknown as { cancelAndSubmit: unknown }).cancelAndSubmit = cancelAndSubmit;

			const actions = listPalette(ctx);
			await actions.find(action => action.id === "app.message.sendNow")?.handler();

			expect(cancelAndSubmit).toHaveBeenCalledTimes(1);
			expect(cancelAndSubmit).toHaveBeenCalledWith("the draft", { queuedEntryId: undefined });
			expect(spies.clearEditor).toHaveBeenCalledTimes(1);
			expect(editor.getText()).toBe("");
		});

		it("preserves the draft and warns when the send rolls back", async () => {
			const { ctx, editor, spies } = streamingContextWithDraft();
			const showWarning = vi.fn();
			ctx.showWarning = showWarning;
			(ctx.session as unknown as { cancelAndSubmit: unknown }).cancelAndSubmit = vi.fn(
				async () => ({ kind: "rolled_back", outcome: { kind: "timeout" } }) as const,
			);

			const actions = listPalette(ctx);
			await actions.find(action => action.id === "app.message.sendNow")?.handler();

			expect(spies.clearEditor).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("  the draft  ");
			expect(showWarning).toHaveBeenCalledWith(
				"Send was cancelled after forced recovery; queued messages were restored",
			);
		});

		it("preserves the draft and reports a busy send", async () => {
			const { ctx, editor, spies } = streamingContextWithDraft();
			(ctx.session as unknown as { cancelAndSubmit: unknown }).cancelAndSubmit = vi.fn(
				async () => ({ kind: "rejected", reason: "in_progress" }) as const,
			);

			const actions = listPalette(ctx);
			await actions.find(action => action.id === "app.message.sendNow")?.handler();

			expect(spies.clearEditor).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("  the draft  ");
			expect(spies.showStatus).toHaveBeenCalledWith("Send already in progress");
		});

		it("leaves the draft untouched when a navigation entry is selected", () => {
			const { ctx, editor, spies } = streamingContextWithDraft();
			ctx.showSessionsDashboard = vi.fn();

			const actions = listPalette(ctx);
			actions.find(action => action.id === "app.session.dashboard")?.handler();

			expect(spies.clearEditor).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("  the draft  ");
			expect(ctx.showSessionsDashboard).toHaveBeenCalledTimes(1);
		});
	});
});
