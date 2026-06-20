import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";

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
	setText(text: string): void;
	getText(): string;
	insertText(text: string): void;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => boolean | undefined): void;
	clearCustomKeyHandlers(): void;
};

async function createContext(options?: { busyPromptMode?: "steer" | "queue" }) {
	let editorText = "";
	const keyMap: Record<string, string[]> = {
		"app.model.selectTemporary": ["ctrl+y"],
		"app.model.select": ["ctrl+l"],
		"app.message.queue": ["alt+enter"],
		"app.message.followUp": ["ctrl+enter"],
	};
	const setActionKeys = vi.fn();
	const showModelSelector = vi.fn();
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const handleBashCommand = vi.fn(async () => {});
	const showStatus = vi.fn();
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
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
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
			abortBash: vi.fn(),
			extensionRunner: undefined,
			prompt,
		} as unknown as InteractiveModeContext["session"],
		keybindings: {
			getKeys(action: string) {
				return keyMap[action] ? [...keyMap[action]] : [];
			},
		} as InteractiveModeContext["keybindings"],
		pendingImages: [],
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
			updatePendingMessagesDisplay,
			handleBashCommand,
			showStatus,
		},
	};
}

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
		expect(ctx.locallySubmittedUserSignatures.has("queue after current response\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("queue after current response", {
			streamingBehavior: "followUp",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("lets idle Ctrl+Enter fall through to editor newline handling", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
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
		const { InputController, ctx, editor, spies } = await createContext();
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
		});
	});

	it("queues streaming Tab only after editor tab completion declines", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("queue after declined tab completion");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onTabDeclined?.(editor.getText());
		await Bun.sleep(0);

		expect(spies.prompt).toHaveBeenCalledWith("queue after declined tab completion", {
			streamingBehavior: "followUp",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
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

	it("attaches terminal-pasted clipboard temp images and inserts a compact placeholder", async () => {
		const imagePath = `/tmp/clipboard-2026-06-04-120441-${process.pid.toString(36)}CAC144E7.png`;
		await Bun.write(imagePath, Buffer.from(RED_1X1_PNG_BASE64, "base64"));
		try {
			const { InputController, ctx, editor, spies } = await createContext();
			const controller = new InputController(ctx);

			controller.setupKeyHandlers();
			const handled = await editor.onPasteText?.(`${imagePath}\n`);

			expect(handled).toBe(true);
			expect(editor.getText()).toBe("[image 1] ");
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
