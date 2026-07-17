import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

function createHarness(options: { retainedOpen?: boolean; accepted?: boolean; streaming?: boolean } = {}) {
	let editorText = "";
	const hasActiveBtwR = vi.fn(() => options.retainedOpen ?? false);
	const handleBtwRFollowUp = vi.fn<(question: string) => Promise<"accepted" | "busy" | "closed">>(
		async () => ((options.accepted ?? true) ? "accepted" : "busy"),
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
		hasActiveBtw: vi.fn(() => false),
		handleBtwEscape: vi.fn(() => false),
		hasActiveBtwR,
		handleBtwRFollowUp,
	} as unknown as InteractiveModeContext;
	new InputController(ctx).setupEditorSubmitHandler();
	return { ctx, editor, hasActiveBtwR, handleBtwRFollowUp, onInputCallback, abort, prompt };
}

async function submit(
	harness: { editor: { setText(text: string): void; onSubmit?: (text: string) => Promise<void> } },
	text: string,
) {
	harness.editor.setText(text);
	await harness.editor.onSubmit?.(text);
}

describe("InputController retained /btw-r routing", () => {
	it("captures empty, continuation literals, plain text, bash, and Python only while retained is open", async () => {
		const open = createHarness({ retainedOpen: true, streaming: true });
		await submit(open, "");
		expect(open.abort).not.toHaveBeenCalled();
		expect(open.handleBtwRFollowUp).not.toHaveBeenCalled();

		for (const text of [".", "c", "plain follow-up", "!pwd", "$1 + 1"]) await submit(open, text);
		expect(open.handleBtwRFollowUp.mock.calls.map(call => call[0])).toEqual([".", "c", "plain follow-up", "!pwd", "$1 + 1"]);
		expect(open.onInputCallback).not.toHaveBeenCalled();
		expect(open.editor.addToHistory).not.toHaveBeenCalled();
		expect(open.editor.getText()).toBe("");

		const closed = createHarness({ retainedOpen: false, streaming: true });
		await submit(closed, "");
		expect(closed.abort).toHaveBeenCalledTimes(1);
		await submit(closed, ".");
		await submit(closed, "c");
		await submit(closed, "!pwd");
		await submit(closed, "$1 + 1");
		expect(closed.ctx.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(closed.ctx.handlePythonCommand).toHaveBeenCalledWith("1 + 1", false);
		expect(closed.onInputCallback).toHaveBeenCalledWith({ text: "", cancelled: false, started: true });
		expect(closed.handleBtwRFollowUp).not.toHaveBeenCalled();
	});

	it("preserves the draft when a retained follow-up is busy", async () => {
		const harness = createHarness({ retainedOpen: true, accepted: false });
		await submit(harness, "wait for the current answer");
		expect(harness.handleBtwRFollowUp).toHaveBeenCalledWith("wait for the current answer");
		expect(harness.editor.getText()).toBe("wait for the current answer");
		expect(harness.onInputCallback).not.toHaveBeenCalled();
	});

	it("keeps slash-origin input on normal dispatch, including a prompt-returning command", async () => {
		const harness = createHarness({ retainedOpen: true });
		await submit(harness, "/btw a known slash");
		expect(harness.ctx.handleBtwCommand).toHaveBeenCalledWith("a known slash");
		expect(harness.handleBtwRFollowUp).not.toHaveBeenCalled();

		await submit(harness, "/provicer");
		expect(harness.ctx.showError).toHaveBeenCalled();
		expect(harness.handleBtwRFollowUp).not.toHaveBeenCalled();

		await submit(harness, "/notify on");
		expect(harness.onInputCallback).toHaveBeenLastCalledWith({ text: "/notify on", cancelled: false, started: true });
		expect(harness.handleBtwRFollowUp).not.toHaveBeenCalled();
	});

	it("returns to the main input path after Esc closes the retained thread", async () => {
		const harness = createHarness({ retainedOpen: false });
		await submit(harness, "main prompt after Esc");
		expect(harness.onInputCallback).toHaveBeenCalledWith({ text: "main prompt after Esc", cancelled: false, started: true });
		expect(harness.handleBtwRFollowUp).not.toHaveBeenCalled();
	});
	it("routes explicit follow-up keybinding into the retained thread instead of the main session", async () => {
		const harness = createHarness({ retainedOpen: true, streaming: true });
		harness.editor.setText("follow-up via keybinding");
		const controller = new InputController(harness.ctx);
		await controller.handleFollowUp();
		expect(harness.handleBtwRFollowUp).toHaveBeenCalledWith("follow-up via keybinding");
		expect(harness.editor.getText()).toBe("");
		expect(harness.prompt).not.toHaveBeenCalled();
		expect(harness.editor.addToHistory).not.toHaveBeenCalled();
	});
});
