import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { QueuedMessageSelectorComponent } from "../src/modes/components/queued-message-selector";
import { InputController } from "../src/modes/controllers/input-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { CompactionQueuedMessage, ComposerSubmissionOptions, InteractiveModeContext } from "../src/modes/types";
import type { QueuedMessageEditEntry } from "../src/session/agent-session";

type FakeEditor = {
	onEscape?: () => void;
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
	onPasteImage?: () => Promise<boolean>;
	onPasteText?: (text: string) => boolean | Promise<boolean>;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onDequeue?: () => void;
	onQueue?: () => void | Promise<void>;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => void | Promise<void>;
	onTabDeclined?: (text: string) => void;
	onTab?: (text: string) => boolean | undefined;
	setText(text: string): void;
	getText(): string;
	insertText(text: string): void;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => boolean | undefined): void;
	clearCustomKeyHandlers(): void;
};

async function createContext(options?: {
	busyPromptMode?: "steer" | "queue";
	followUpKeys?: string[];
	ircSidebarToggleKeys?: string[];
}) {
	let editorText = "";
	const keyMap: Record<string, string[]> = {
		"app.model.selectTemporary": ["ctrl+y"],
		"app.model.select": ["ctrl+l"],
		"app.message.queue": ["alt+enter"],
		"app.message.followUp": options?.followUpKeys ?? [],
		"app.message.dequeue": ["alt+up", "alt+down"],
		"app.irc.sidebar.toggle": options?.ircSidebarToggleKeys ?? ["alt+i"],
	};

	const setActionKeys = vi.fn();
	const showModelSelector = vi.fn();
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const handleBashCommand = vi.fn(async () => {});
	const showStatus = vi.fn();
	const onInputCallback = vi.fn();
	const toggleIrcSidebar = vi.fn();
	const startPendingSubmission = vi.fn(
		(
			input: {
				text: string;
				images?: InteractiveModeContext["pendingImages"];
				customType?: string;
				display?: boolean;
			},
			_options?: ComposerSubmissionOptions,
		) => ({
			...input,
			cancelled: false,
			started: true,
		}),
	);
	const compactionQueuedMessages: CompactionQueuedMessage[] = [];
	const sessionQueuedMessages: string[] = [];
	const queueCompactionMessage = vi.fn((text: string, mode: "steer" | "followUp") => {
		compactionQueuedMessages.push({ text, mode });
		editor.addToHistory(text);
		editor.setText("");
		updatePendingMessagesDisplay();
		showStatus("Queued message for after compaction");
	});
	const popLastQueuedMessage = vi.fn(() => sessionQueuedMessages.pop());
	const getQueuedMessageEntries = vi.fn(() =>
		sessionQueuedMessages.map(
			(text, index): QueuedMessageEditEntry => ({
				id: `followUp:${index}`,
				text,
				mode: "followUp",
				label: "Queued",
			}),
		),
	);
	const removeQueuedMessageForEditing = vi.fn((id: string) => {
		const [mode, indexText] = id.split(":");
		if (mode !== "followUp" || indexText === undefined) return undefined;
		const index = Number(indexText);
		if (!Number.isInteger(index)) return undefined;
		const [removed] = sessionQueuedMessages.splice(index, 1);
		return removed;
	});
	const moveQueuedMessageForEditing = vi.fn((id: string, direction: "up" | "down") => {
		const [mode, indexText] = id.split(":");
		if (mode !== "followUp" || indexText === undefined) return false;
		const index = Number(indexText);
		if (!Number.isInteger(index)) return false;
		const targetIndex = direction === "up" ? index - 1 : index + 1;
		if (index < 0 || index >= sessionQueuedMessages.length) return false;
		if (targetIndex < 0 || targetIndex >= sessionQueuedMessages.length) return false;
		const [entry] = sessionQueuedMessages.splice(index, 1);
		if (entry === undefined) return false;
		sessionQueuedMessages.splice(targetIndex, 0, entry);
		return true;
	});
	const clearQueue = vi.fn(() => {
		const followUp = [...sessionQueuedMessages];
		sessionQueuedMessages.length = 0;
		return { steering: [], followUp };
	});
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		insertText(text: string) {
			editorText += text;
		},
		addToHistory: vi.fn(),
		setActionKeys,
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};
	const editorContainerChildren: unknown[] = [];
	const editorContainer = {
		clear: vi.fn(() => {
			editorContainerChildren.length = 0;
		}),
		addChild: vi.fn((child: unknown) => {
			editorContainerChildren.push(child);
		}),
	};
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn(), setFocus: vi.fn() } as unknown as InteractiveModeContext["ui"],
		editorContainer: editorContainer as unknown as InteractiveModeContext["editorContainer"],
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
			messages: [],
			abortBash: vi.fn(),
			extensionRunner: undefined,
			prompt,
			popLastQueuedMessage,
			clearQueue,
			getQueuedMessages: () => ({ steering: [], followUp: [...sessionQueuedMessages] }),
			getQueuedMessageEntries,
			removeQueuedMessageForEditing,
			moveQueuedMessageForEditing,
		} as unknown as InteractiveModeContext["session"],
		keybindings: {
			getKeys(action: string) {
				return keyMap[action] ? [...keyMap[action]] : [];
			},
		} as InteractiveModeContext["keybindings"],
		pendingImages: [],
		compactionQueuedMessages,
		queueCompactionMessage,
		onInputCallback,
		startPendingSubmission,
		flushPendingBashComponents: vi.fn(),
		settings: {
			get(path: string) {
				if (path === "images.autoResize") return false;
				if (path === "busyPromptMode") return options?.busyPromptMode ?? "steer";
				return undefined;
			},
		} as unknown as InteractiveModeContext["settings"],
		sessionManager: {
			getCwd() {
				return "/";
			},
			getSessionName() {
				return "test-session";
			},
		} as unknown as InteractiveModeContext["sessionManager"],
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			if (this.isKnownSlashCommand(text)) return () => {};
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		updatePendingMessagesDisplay,
		isBashMode: false,
		isBashNoContext: false,
		isPythonMode: false,
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		toggleIrcSidebar,
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector,
		updateEditorBorderColor: vi.fn(),
		handleBashCommand,
		showWarning: vi.fn(),
		showStatus,
		hasActiveBtw: vi.fn(() => false),
	} as unknown as InteractiveModeContext;

	return {
		InputController,
		ctx,
		editor,
		spies: {
			setActionKeys,
			showModelSelector,
			prompt,
			onInputCallback,
			startPendingSubmission,
			updatePendingMessagesDisplay,
			handleBashCommand,
			showStatus,
			queueCompactionMessage,
			popLastQueuedMessage,
			clearQueue,
			getQueuedMessageEntries,
			removeQueuedMessageForEditing,
			moveQueuedMessageForEditing,
			toggleIrcSidebar,
		},
		queues: {
			compactionQueuedMessages,
			sessionQueuedMessages,
			editorContainerChildren,
		},
	};
}

beforeAll(() => {
	initTheme();
});

describe("InputController keybinding setup", () => {
	it("registers temporary and persisted model selector actions separately", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.selectTemporary", ["ctrl+y"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.select", ["ctrl+l"]);
		expect(editor.onSelectModelTemporary).toBeDefined();
		expect(editor.onSelectModel).toBeDefined();
		expect(editor.onSelectModelTemporary).not.toBe(editor.onSelectModel);

		editor.onSelectModelTemporary?.();
		editor.onSelectModel?.();

		expect(spies.showModelSelector).toHaveBeenNthCalledWith(1, { temporaryOnly: true });
		expect(spies.showModelSelector).toHaveBeenNthCalledWith(2);
	});

	it("registers the default IRC sidebar shortcut and consumes its dispatch", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		const registration = (editor.setCustomKeyHandler as ReturnType<typeof vi.fn>).mock.calls.find(
			([key]) => key === "alt+i",
		);
		expect(registration).toBeDefined();
		const handler = registration?.[1] as () => boolean;

		expect(handler()).toBe(true);
		expect(spies.toggleIrcSidebar).toHaveBeenCalledTimes(1);
	});

	it("registers remapped IRC sidebar shortcuts", async () => {
		const { InputController, ctx, editor } = await createContext({ ircSidebarToggleKeys: ["ctrl+alt+i"] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(editor.setCustomKeyHandler).toHaveBeenCalledWith("ctrl+alt+i", expect.any(Function));
		expect(editor.setCustomKeyHandler).not.toHaveBeenCalledWith("alt+i", expect.any(Function));
	});

	it("does not register a sidebar handler when its binding is explicitly empty", async () => {
		const { InputController, ctx, editor } = await createContext({ ircSidebarToggleKeys: [] });
		new InputController(ctx).setupKeyHandlers();

		expect(editor.setCustomKeyHandler).not.toHaveBeenCalledWith("alt+i", expect.any(Function));
	});

	it("registers an explicit queue action separately from immediate submit", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("queue after current response");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		await editor.onQueue?.();
		await Bun.sleep(0);

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.message.queue", ["alt+enter"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.message.dequeue", ["alt+up", "alt+down"]);
		expect(ctx.locallySubmittedUserSignatures.has("queue after current response\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("queue after current response", {
			streamingBehavior: "followUp",
			followUpQueuePolicy: "sequential",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not register a default Ctrl+Enter follow-up handler", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(editor.setCustomKeyHandler).not.toHaveBeenCalledWith("ctrl+enter", expect.any(Function));
	});

	it("lets an explicit Ctrl+Enter follow-up remap fall through while idle", async () => {
		const { InputController, ctx, editor, spies } = await createContext({ followUpKeys: ["ctrl+enter"] });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const followUpRegistration = (editor.setCustomKeyHandler as ReturnType<typeof vi.fn>).mock.calls.find(
			([key]) => key === "ctrl+enter",
		);
		expect(followUpRegistration).toBeDefined();
		const handler = followUpRegistration?.[1] as () => boolean | undefined;

		expect(handler()).toBe(false);
		expect(spies.prompt).not.toHaveBeenCalled();
	});

	it("consumes Ctrl+Enter as follow-up while streaming", async () => {
		const { InputController, ctx, editor, spies } = await createContext({ followUpKeys: ["ctrl+enter"] });
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("follow up from shortcut");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const followUpRegistration = (editor.setCustomKeyHandler as ReturnType<typeof vi.fn>).mock.calls.find(
			([key]) => key === "ctrl+enter",
		);
		const handler = followUpRegistration?.[1] as () => boolean | undefined;

		expect(handler()).toBe(true);
		await Bun.sleep(0);
		expect(spies.prompt).toHaveBeenCalledWith("follow up from shortcut", {
			streamingBehavior: "followUp",
			followUpQueuePolicy: "sequential",
		});
	});

	it("leaves streaming Tab available for editor autocomplete", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("/mo");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		await Bun.sleep(0);

		expect(editor.onTab).toBeUndefined();
		expect(editor.onTabDeclined).toBeUndefined();
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(spies.updatePendingMessagesDisplay).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/mo");
	});

	it("leaves compaction Tab available for editor autocomplete", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isCompacting: boolean };
		session.isCompacting = true;
		editor.setText("/skill:team");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		await Bun.sleep(0);

		expect(editor.onTab).toBeUndefined();
		expect(editor.onTabDeclined).toBeUndefined();
		expect(spies.queueCompactionMessage).not.toHaveBeenCalled();
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("/skill:team");
	});

	it("queues explicit message action during compaction", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isCompacting: boolean };
		session.isCompacting = true;
		editor.setText("queue while compacting via shortcut");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		await editor.onQueue?.();
		await Bun.sleep(0);

		expect(spies.queueCompactionMessage).toHaveBeenCalledWith("queue while compacting via shortcut", "followUp");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("restores a single compaction queued message for editing", async () => {
		const { InputController, ctx, editor, spies, queues } = await createContext();
		queues.compactionQueuedMessages.push({ text: "single compaction queue", mode: "followUp" });
		editor.setText("current draft");
		const controller = new InputController(ctx);

		controller.handleDequeue();

		expect(editor.getText()).toBe("single compaction queue");
		expect(queues.compactionQueuedMessages).toEqual([]);
		expect(spies.popLastQueuedMessage).not.toHaveBeenCalled();
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("restores a single session queued message for editing", async () => {
		const { InputController, ctx, editor, spies, queues } = await createContext();
		queues.sessionQueuedMessages.push("single session queue");
		editor.setText("current draft");
		const controller = new InputController(ctx);

		controller.handleDequeue();

		expect(editor.getText()).toBe("single session queue");
		expect(queues.sessionQueuedMessages).toEqual([]);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.removeQueuedMessageForEditing).toHaveBeenCalledWith("followUp:0");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("opens a selector so older queued messages can be restored", async () => {
		const { InputController, ctx, editor, spies, queues } = await createContext();
		queues.sessionQueuedMessages.push("older session queue", "newest session queue");
		editor.setText("current draft");
		const controller = new InputController(ctx);

		controller.handleDequeue();

		const selector = queues.editorContainerChildren[0];
		if (!(selector instanceof QueuedMessageSelectorComponent)) {
			throw new Error("Expected queued message selector to be shown");
		}
		expect(editor.getText()).toBe("current draft");
		selector.getSelectList().setSelectedIndex(0);
		selector.getSelectList().handleInput("\n");

		expect(editor.getText()).toBe("older session queue");
		expect(queues.sessionQueuedMessages).toEqual(["newest session queue"]);
		expect(spies.removeQueuedMessageForEditing).toHaveBeenCalledWith("followUp:0");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("deletes the selected queued message from the selector", async () => {
		const { InputController, ctx, editor, spies, queues } = await createContext();
		queues.sessionQueuedMessages.push("older session queue", "newest session queue");
		editor.setText("current draft");
		const controller = new InputController(ctx);

		controller.handleDequeue();

		const selector = queues.editorContainerChildren[0];
		if (!(selector instanceof QueuedMessageSelectorComponent)) {
			throw new Error("Expected queued message selector to be shown");
		}
		selector.handleInput("\x1b[3~");

		expect(editor.getText()).toBe("current draft");
		expect(queues.sessionQueuedMessages).toEqual(["older session queue"]);
		expect(spies.removeQueuedMessageForEditing).toHaveBeenCalledWith("followUp:1");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.showStatus).toHaveBeenCalledWith("Deleted queued message");
		expect(queues.editorContainerChildren[0]).toBeInstanceOf(QueuedMessageSelectorComponent);
	});

	it("opens the selector focused on the newest queued message across queue types", async () => {
		const { InputController, ctx, editor, spies, queues } = await createContext();
		spies.getQueuedMessageEntries.mockReturnValue([
			{
				id: "steer:2",
				text: "newer steer",
				mode: "steer",
				label: "Steer",
			},
			{
				id: "followUp:1",
				text: "older follow-up",
				mode: "followUp",
				label: "Queued",
			},
		]);
		spies.removeQueuedMessageForEditing.mockImplementation(id => {
			if (id === "steer:2") return "newer steer";
			if (id === "followUp:1") return "older follow-up";
			return undefined;
		});
		editor.setText("current draft");
		const controller = new InputController(ctx);

		controller.handleDequeue();

		const selector = queues.editorContainerChildren[0];
		if (!(selector instanceof QueuedMessageSelectorComponent)) {
			throw new Error("Expected queued message selector to be shown");
		}
		selector.getSelectList().handleInput("\n");

		expect(editor.getText()).toBe("newer steer");
		expect(spies.removeQueuedMessageForEditing).toHaveBeenCalledWith("steer:2");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("moves the selected queued message from the selector", async () => {
		const { InputController, ctx, editor, spies, queues } = await createContext();
		queues.sessionQueuedMessages.push("first session queue", "second session queue", "third session queue");
		editor.setText("current draft");
		const controller = new InputController(ctx);

		controller.handleDequeue();

		const selector = queues.editorContainerChildren[0];
		if (!(selector instanceof QueuedMessageSelectorComponent)) {
			throw new Error("Expected queued message selector to be shown");
		}
		selector.handleInput("\x1b[1;6A");

		expect(editor.getText()).toBe("current draft");
		expect(queues.sessionQueuedMessages).toEqual([
			"first session queue",
			"third session queue",
			"second session queue",
		]);
		expect(spies.moveQueuedMessageForEditing).toHaveBeenCalledWith("followUp:2", "up");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.showStatus).toHaveBeenCalledWith("Moved queued message");

		const nextSelector = queues.editorContainerChildren[0];
		if (!(nextSelector instanceof QueuedMessageSelectorComponent)) {
			throw new Error("Expected queued message selector to remain shown");
		}
		nextSelector.handleInput("\x1b[1;5B");

		expect(queues.sessionQueuedMessages).toEqual([
			"first session queue",
			"second session queue",
			"third session queue",
		]);
		expect(spies.moveQueuedMessageForEditing).toHaveBeenLastCalledWith("followUp:1", "down");
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(2);
		expect(spies.showStatus).toHaveBeenLastCalledWith("Moved queued message");
	});

	it("steers streaming Enter submissions by default", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("steer by default while busy");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("steer by default while busy");

		expect(ctx.locallySubmittedUserSignatures.has("steer by default while busy\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("steer by default while busy", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("preserves explicit steer busy setting for streaming Enter submissions", async () => {
		const { InputController, ctx, editor, spies } = await createContext({ busyPromptMode: "steer" });
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("steer while busy");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("steer while busy");

		expect(ctx.locallySubmittedUserSignatures.has("steer while busy\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("steer while busy", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});
	it("omits pasted image attachments when their placeholders were deleted", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const deletedImage: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "deleted-image",
			mimeType: "image/png",
		};
		ctx.pendingImages = [deletedImage];
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("send text after deleting the pasted image");

		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({
			text: "send text after deleting the pasted image",
			images: undefined,
		});
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: true, editor: ctx.editor });
		expect(spies.onInputCallback).toHaveBeenCalledWith({
			text: "send text after deleting the pasted image",
			images: undefined,
			cancelled: false,
			started: true,
		});
		expect(ctx.pendingImages).toEqual([]);
	});

	it("submits only pasted images whose placeholders remain", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const firstImage: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "first-image",
			mimeType: "image/png",
		};
		const secondImage: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "second-image",
			mimeType: "image/png",
		};
		ctx.pendingImages = [firstImage, secondImage];
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("describe only [image 2]");

		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({
			text: "describe only [image 2]",
			images: [secondImage],
		});
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: true, editor: ctx.editor });
		expect(spies.onInputCallback).toHaveBeenCalledWith({
			text: "describe only [image 2]",
			images: [secondImage],
			cancelled: false,
			started: true,
		});
		expect(ctx.pendingImages).toEqual([]);
	});
	it("keeps pasted clipboard images when submit reset fires before the submit callback", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const image: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "clipboard-image",
			mimeType: "image/png",
		};
		ctx.pendingImages = [image];
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();

		editor.setText("describe [image 1]");
		editor.setText("");
		editor.onChange?.("");
		await editor.onSubmit?.("describe [image 1]");

		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({
			text: "describe [image 1]",
			images: [image],
		});
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: true, editor: ctx.editor });
		expect(spies.onInputCallback).toHaveBeenCalledWith({
			text: "describe [image 1]",
			images: [image],
			cancelled: false,
			started: true,
		});
		expect(ctx.pendingImages).toEqual([]);
	});

	it("preserves successor composer images while an input extension is awaiting", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const firstImage: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "first-image",
			mimeType: "image/png",
		};
		const secondImage: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "second-image",
			mimeType: "image/png",
		};
		const extension = Promise.withResolvers<void>();
		const emitInput = vi.fn(async () => {
			await extension.promise;
			return undefined;
		});
		(ctx.session as unknown as { extensionRunner: unknown }).extensionRunner = {
			hasHandlers: () => true,
			getShortcuts: () => [],
			emitInput,
		};
		ctx.pendingImages = [firstImage];
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();

		editor.setText("");
		editor.onChange?.("");
		const firstSubmit = editor.onSubmit?.("describe [image 1]");
		expect(emitInput).toHaveBeenCalledTimes(1);

		ctx.pendingImages = [...ctx.pendingImages, secondImage];
		editor.setText("follow up [image 2]");
		await Promise.resolve();
		expect(ctx.pendingImages).toEqual([firstImage, secondImage]);

		extension.resolve();
		await firstSubmit;
		expect(spies.startPendingSubmission.mock.calls[0]?.[0]).toEqual({
			text: "describe [image 1]",
			images: [firstImage],
		});
		expect(spies.startPendingSubmission.mock.calls[0]?.[1]).toEqual({ ownsComposer: true, editor: ctx.editor });
		expect(ctx.pendingImages).toEqual([firstImage, secondImage]);

		await editor.onSubmit?.("follow up [image 2]");
		expect(spies.startPendingSubmission.mock.calls[1]?.[0]).toEqual({
			text: "follow up [image 2]",
			images: [secondImage],
		});
		expect(spies.startPendingSubmission.mock.calls[1]?.[1]).toEqual({ ownsComposer: true, editor: ctx.editor });
		expect(ctx.pendingImages).toEqual([]);
	});

	it("still clears pending images after the composer is manually emptied", async () => {
		const { InputController, ctx, editor } = await createContext();
		const image: InteractiveModeContext["pendingImages"][number] = {
			type: "image",
			data: "clipboard-image",
			mimeType: "image/png",
		};
		ctx.pendingImages = [image];
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.setText("");
		editor.onChange?.("");
		expect(ctx.pendingImages).toEqual([image]);

		await Promise.resolve();

		expect(ctx.pendingImages).toEqual([]);
	});

	it("marks streaming follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("follow up after current response");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("follow up after current response\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("follow up after current response", {
			streamingBehavior: "followUp",
			followUpQueuePolicy: "sequential",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("marks idle follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		// Default fake session is idle.
		editor.setText("plain idle submit");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("plain idle submit\u00000")).toBe(true);
		// Idle submit calls prompt() with no streamingBehavior.
		expect(spies.prompt).toHaveBeenCalledWith("plain idle submit");
	});

	it("removes the signature when an idle follow-up submission rejects", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		editor.setText("doomed submit");
		const controller = new InputController(ctx);

		await expect(controller.handleFollowUp()).rejects.toThrow("boom");

		// Contract: a thrown delivery error must not leave a stale signature
		// behind, otherwise the next attempt with the same text would silently
		// suppress the editor-clear protection that was meant for the failed call.
		expect(ctx.locallySubmittedUserSignatures.has("doomed submit\u00000")).toBe(false);
	});

	it("removes the signature when a streaming follow-up rejects", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue full");
		});
		editor.setText("queued during stream");
		const controller = new InputController(ctx);

		await expect(controller.handleFollowUp()).rejects.toThrow("queue full");

		expect(ctx.locallySubmittedUserSignatures.has("queued during stream\u00000")).toBe(false);
	});
});

describe("InputController pasted clipboard image paths", () => {
	const RED_1X1_PNG_BASE64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

	it("attaches terminal-pasted clipboard temp images and preserves the source path in the placeholder", async () => {
		const imagePath = path.join(os.tmpdir(), `clipboard-2026-06-04-120441-${process.pid.toString(36)}CAC144E7.png`);
		await Bun.write(imagePath, Buffer.from(RED_1X1_PNG_BASE64, "base64"));
		try {
			const { InputController, ctx, editor, spies } = await createContext();
			const controller = new InputController(ctx);

			controller.setupKeyHandlers();
			const handled = await editor.onPasteText?.(`${imagePath}\n`);

			expect(handled).toBe(true);
			expect(editor.getText()).toBe(`[image 1] source=${JSON.stringify(imagePath)} `);
			expect(ctx.pendingImages).toHaveLength(1);
			expect(ctx.pendingImages[0]?.mimeType).toBe("image/png");
			expect(spies.showStatus).toHaveBeenCalledWith(`Attached image: ${imagePath.split("/").at(-1)}`, { dim: true });
		} finally {
			await fs.rm(imagePath, { force: true });
		}
	});

	it("leaves ordinary pasted text for the editor", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const handled = await editor.onPasteText?.("/tmp/not-a-clipboard-image.png");

		expect(handled).toBe(false);
		expect(editor.getText()).toBe("");
		expect(ctx.pendingImages).toHaveLength(0);
	});
});

describe("InputController shell mode cues", () => {
	it("marks leading bang input as shell mode without rewriting editor text", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("!pwd");
		editor.onChange?.("!pwd");

		expect(ctx.isBashMode).toBe(true);
		expect(ctx.isBashNoContext).toBe(false);
		expect(ctx.isPythonMode).toBe(false);
		expect(editor.getText()).toBe("!pwd");
		expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
	});

	it("marks double bang input as no-context shell mode", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("!!pwd");
		editor.onChange?.("!!pwd");

		expect(ctx.isBashMode).toBe(true);
		expect(ctx.isBashNoContext).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
	});

	it("keeps existing shell submit and history semantics", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("!!pwd");

		expect(spies.handleBashCommand).toHaveBeenCalledWith("pwd", true);
		expect(editor.addToHistory).toHaveBeenCalledWith("!!pwd");
		expect(ctx.isBashMode).toBe(false);
		expect(ctx.isBashNoContext).toBe(false);
	});
});
