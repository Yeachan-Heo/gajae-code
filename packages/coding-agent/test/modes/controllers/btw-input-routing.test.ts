import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { CustomEditor } from "@gajae-code/coding-agent/modes/components/custom-editor";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme();
});

function createHarness(options: { btwOpen?: boolean; accepted?: boolean; streaming?: boolean } = {}) {
	let editorText = "";
	const hasActiveBtw = vi.fn(() => options.btwOpen ?? false);
	const handleBtwFollowUp = vi.fn<(question: string) => Promise<"accepted" | "busy" | "closed">>(async () =>
		(options.accepted ?? true) ? "accepted" : "busy",
	);
	const onInputCallback = vi.fn();
	const abort = vi.fn(async () => {});
	const prompt = vi.fn(async () => {});
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};
	const ctx = {
		settings: { get: () => undefined },
		editor,
		ui: { requestRender: vi.fn(), addInputListener: vi.fn(() => () => {}) },
		session: {
			isStreaming: options.streaming ?? false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 1,
			hasQueuedSteering: false,
			messages: [{ role: "user", content: "existing" }],
			extensionRunner: undefined,
			prompt,
			abort,
		},
		sessionManager: { getSessionName: () => "existing", getCwd: () => process.cwd() },
		keybindings: { getKeys: () => [] },
		pendingImages: [],
		lastEscapeTime: 0,
		lastComposerClearEscapeTime: 0,
		isBashMode: false,
		isBashNoContext: false,
		isPythonMode: false,
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: true })),
		flushPendingBashComponents: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBashCommand: vi.fn(),
		handlePythonCommand: vi.fn(),
		handleBackgroundCommand: vi.fn(),
		handleBtwCommand: vi.fn(async () => {}),
		hasActiveBtw,
		handleBtwEscape: vi.fn(() => false),
		handleBtwFollowUp,
	} as unknown as InteractiveModeContext;
	new InputController(ctx).setupEditorSubmitHandler();
	return { ctx, editor, hasActiveBtw, handleBtwFollowUp, onInputCallback, abort, prompt };
}

async function submit(
	harness: { editor: { setText(text: string): void; onSubmit?: (text: string) => Promise<void> } },
	text: string,
) {
	harness.editor.setText(text);
	await harness.editor.onSubmit?.(text);
}

describe("InputController /btw multi-turn routing", () => {
	it("captures empty, continuation literals, plain text, bash, and Python only while /btw is open", async () => {
		const open = createHarness({ btwOpen: true, streaming: true });
		await submit(open, "");
		expect(open.abort).not.toHaveBeenCalled();
		expect(open.handleBtwFollowUp).not.toHaveBeenCalled();

		for (const text of [".", "c", "plain follow-up", "!pwd", "$1 + 1"]) await submit(open, text);
		expect(open.handleBtwFollowUp.mock.calls.map(call => call[0])).toEqual([
			".",
			"c",
			"plain follow-up",
			"!pwd",
			"$1 + 1",
		]);
		expect(open.onInputCallback).not.toHaveBeenCalled();
		expect(open.editor.addToHistory).not.toHaveBeenCalled();
		expect(open.editor.getText()).toBe("");

		const closed = createHarness({ btwOpen: false, streaming: true });
		await submit(closed, "");
		expect(closed.abort).toHaveBeenCalledTimes(1);
		await submit(closed, ".");
		await submit(closed, "c");
		await submit(closed, "!pwd");
		await submit(closed, "$1 + 1");
		expect(closed.ctx.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(closed.ctx.handlePythonCommand).toHaveBeenCalledWith("1 + 1", false);
		expect(closed.onInputCallback).toHaveBeenCalledWith({ text: "", cancelled: false, started: true });
		expect(closed.handleBtwFollowUp).not.toHaveBeenCalled();
	});

	it("captures private side text and images before extension input observers", async () => {
		const harness = createHarness({ btwOpen: true });
		const emitInput = vi.fn(async () => undefined);
		const mutable = harness.ctx as unknown as {
			pendingImages: unknown[];
			session: { extensionRunner: { hasHandlers: () => boolean; emitInput: typeof emitInput } };
		};
		mutable.pendingImages = [{ type: "image", data: "PRIVATE_IMAGE_SENTINEL", mimeType: "image/png" }];
		mutable.session.extensionRunner = { hasHandlers: () => true, emitInput };

		await submit(harness, "PRIVATE_SIDE_TEXT_SENTINEL");

		expect(harness.handleBtwFollowUp).toHaveBeenCalledWith("PRIVATE_SIDE_TEXT_SENTINEL");
		expect(emitInput).not.toHaveBeenCalled();
		expect(mutable.pendingImages).toEqual([]);
	});

	it("preserves the draft when a /btw follow-up is busy", async () => {
		const harness = createHarness({ btwOpen: true, accepted: false });
		await submit(harness, "wait for the current answer");
		expect(harness.handleBtwFollowUp).toHaveBeenCalledWith("wait for the current answer");
		expect(harness.editor.getText()).toBe("wait for the current answer");
		expect(harness.onInputCallback).not.toHaveBeenCalled();
	});

	it("preserves a busy follow-up in the real editor composer", async () => {
		const harness = createHarness({ btwOpen: true, accepted: false });
		const editor = new CustomEditor(getEditorTheme());
		(harness.ctx as unknown as { editor: CustomEditor }).editor = editor;
		new InputController(harness.ctx).setupEditorSubmitHandler();
		editor.setText("REAL_EDITOR_BUSY_SENTINEL");

		await editor.onSubmit?.("REAL_EDITOR_BUSY_SENTINEL");

		expect(harness.handleBtwFollowUp).toHaveBeenCalledWith("REAL_EDITOR_BUSY_SENTINEL");
		expect(editor.getText()).toBe("REAL_EDITOR_BUSY_SENTINEL");
	});

	it("routes the initial /btw command before extension input observers", async () => {
		const harness = createHarness({ btwOpen: false });
		const emitInput = vi.fn(async () => undefined);
		const mutable = harness.ctx as unknown as {
			pendingImages: unknown[];
			session: { extensionRunner: { hasHandlers: () => boolean; emitInput: typeof emitInput } };
		};
		mutable.pendingImages = [{ type: "image", data: "INITIAL_PRIVATE_IMAGE", mimeType: "image/png" }];
		mutable.session.extensionRunner = { hasHandlers: () => true, emitInput };

		await submit(harness, "/btw INITIAL_PRIVATE_COMMAND_SENTINEL");

		expect(harness.ctx.handleBtwCommand).toHaveBeenCalledWith("INITIAL_PRIVATE_COMMAND_SENTINEL");
		expect(emitInput).not.toHaveBeenCalled();
		expect(mutable.pendingImages).toEqual([]);
	});

	it("keeps slash-origin input on normal dispatch, including a prompt-returning command", async () => {
		const harness = createHarness({ btwOpen: true });
		await submit(harness, "/btw a known slash");
		expect(harness.ctx.handleBtwCommand).toHaveBeenCalledWith("a known slash");
		expect(harness.handleBtwFollowUp).not.toHaveBeenCalled();

		await submit(harness, "/provicer");
		expect(harness.ctx.showError).toHaveBeenCalled();
		expect(harness.handleBtwFollowUp).not.toHaveBeenCalled();

		await submit(harness, "/notify on");
		expect(harness.onInputCallback).toHaveBeenLastCalledWith({ text: "/notify on", cancelled: false, started: true });
		expect(harness.handleBtwFollowUp).not.toHaveBeenCalled();
	});

	it("returns to the main input path after Esc closes /btw", async () => {
		const harness = createHarness({ btwOpen: false });
		await submit(harness, "main prompt after Esc");
		expect(harness.onInputCallback).toHaveBeenCalledWith({
			text: "main prompt after Esc",
			cancelled: false,
			started: true,
		});
		expect(harness.handleBtwFollowUp).not.toHaveBeenCalled();
	});
	it("routes the explicit follow-up keybinding into /btw instead of the main session", async () => {
		const harness = createHarness({ btwOpen: true, streaming: true });
		harness.editor.setText("follow-up via keybinding");
		const controller = new InputController(harness.ctx);
		await controller.handleFollowUp();
		expect(harness.handleBtwFollowUp).toHaveBeenCalledWith("follow-up via keybinding");
		expect(harness.editor.getText()).toBe("");
		expect(harness.prompt).not.toHaveBeenCalled();
		expect(harness.editor.addToHistory).not.toHaveBeenCalled();
	});

	it("captures non-slash text with an embedded skill command in /btw", async () => {
		const harness = createHarness({ btwOpen: true });
		const skill = {
			name: "demo",
			description: "demo skill",
			filePath: "demo.md",
			baseDir: process.cwd(),
			source: "user" as const,
			disableModelInvocation: false,
			content: "Demo skill body",
		};
		const ctxMut = harness.ctx as unknown as {
			skillCommands: Map<string, typeof skill>;
			session: {
				promptCustomMessage: (
					message: unknown,
					options?: { streamingBehavior?: string; followUpQueuePolicy?: string },
				) => Promise<void>;
			};
		};
		ctxMut.skillCommands = new Map([["skill:demo", skill]]);
		const promptCustomMessage = vi.fn(
			async (_message: unknown, _options?: { streamingBehavior?: string; followUpQueuePolicy?: string }) => {},
		);
		ctxMut.session.promptCustomMessage = promptCustomMessage;

		await submit(harness, "what does /skill:demo do?");

		expect(harness.handleBtwFollowUp).toHaveBeenCalledWith("what does /skill:demo do?");
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(harness.onInputCallback).not.toHaveBeenCalled();
	});
	it("keeps slash-origin follow-up keybinding off /btw so /skill:* can dispatch normally", async () => {
		const harness = createHarness({ btwOpen: true, streaming: true });
		const skill = {
			name: "demo",
			description: "demo skill",
			filePath: "demo.md",
			baseDir: process.cwd(),
			source: "user" as const,
			disableModelInvocation: false,
			content: "Demo skill body",
		};
		const ctxMut = harness.ctx as unknown as {
			skillCommands: Map<string, typeof skill>;
			session: {
				promptCustomMessage: (
					message: unknown,
					options?: { streamingBehavior?: string; followUpQueuePolicy?: string },
				) => Promise<void>;
				sessionId?: string;
				enqueueCustomMessageDisplay?: (text: string, behavior: string) => string;
			};
		};
		ctxMut.skillCommands = new Map([["skill:demo", skill]]);
		const promptCustomMessage = vi.fn(
			async (_message: unknown, _options?: { streamingBehavior?: string; followUpQueuePolicy?: string }) => {},
		);
		ctxMut.session.promptCustomMessage = promptCustomMessage;
		ctxMut.session.sessionId = "test-session";
		ctxMut.session.enqueueCustomMessageDisplay = vi.fn(() => "tag");

		harness.editor.setText("/skill:demo args");
		const controller = new InputController(harness.ctx);
		await controller.handleFollowUp();

		// Slash-origin must never enter /btw capture.
		expect(harness.handleBtwFollowUp).not.toHaveBeenCalled();
		expect(promptCustomMessage).toHaveBeenCalled();
		expect(promptCustomMessage.mock.calls[0]?.[1]).toMatchObject({
			streamingBehavior: "followUp",
			followUpQueuePolicy: "sequential",
		});
	});
});
