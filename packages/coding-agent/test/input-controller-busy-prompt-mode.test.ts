import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

/**
 * Issue #434 — the `busyPromptMode` setting selects how a plain prompt
 * submitted while the agent is streaming is delivered:
 *   - "steer"  → interrupt the active turn (default, legacy behavior);
 *   - "queue"  → defer to the follow-up queue so it runs after the turn.
 * Ctrl+Enter (handleFollowUp) is unaffected and always queues.
 */
function createStreamingCtx(busyPromptMode: "steer" | "queue") {
	let editorText = "";
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
	const ctx = {
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
			addToHistory: vi.fn(),
			onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		},
		ui: { requestRender: vi.fn() },
		skillCommands: new Map(),
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			queuedMessageCount: 0,
			prompt,
		},
		sessionManager: { getCwd: () => process.cwd() },
		settings: {
			get: (key: string) => (key === "busyPromptMode" ? busyPromptMode : undefined),
		},
		isBashMode: false,
		isPythonMode: false,
		pendingImages: [],
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, prompt };
}

describe("InputController busyPromptMode routing (issue #434)", () => {
	it("steers the active turn when busyPromptMode is 'steer'", async () => {
		const { ctx, prompt } = createStreamingCtx("steer");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("do the thing");

		expect(prompt).toHaveBeenCalledTimes(1);
		const [, options] = prompt.mock.calls[0] as [string, { streamingBehavior?: string }];
		expect(options.streamingBehavior).toBe("steer");
	});

	it("queues for the next turn when busyPromptMode is 'queue'", async () => {
		const { ctx, prompt } = createStreamingCtx("queue");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("do the thing");

		expect(prompt).toHaveBeenCalledTimes(1);
		const [, options] = prompt.mock.calls[0] as [string, { streamingBehavior?: string }];
		expect(options.streamingBehavior).toBe("followUp");
	});

	it("Ctrl+Enter always queues as follow-up regardless of busyPromptMode", async () => {
		const { ctx, prompt } = createStreamingCtx("steer");
		const controller = new InputController(ctx);
		ctx.editor.setText("do the thing");

		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const [, options] = prompt.mock.calls[0] as [string, { streamingBehavior?: string }];
		expect(options.streamingBehavior).toBe("followUp");
	});
});
