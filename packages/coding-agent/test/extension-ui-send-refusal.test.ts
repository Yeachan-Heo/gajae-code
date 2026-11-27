import { describe, expect, it, type Mock, vi } from "bun:test";
import type { ExtensionActions, ExtensionUIContext } from "../src/extensibility/extensions/types";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";

/** Initialize the real interactive extension seam against a session that refuses every send. */
function captureActions(refusal: Error): { actions: ExtensionActions; showError: Mock<(text: string) => void> } {
	let captured: ExtensionActions | undefined;
	const runner = {
		initialize(actions: ExtensionActions): void {
			captured = actions;
		},
		onError: () => () => {},
		emit: async () => undefined,
	};
	const showError = vi.fn((_text: string) => {});
	const session = {
		extensionRunner: runner,
		isStreaming: false,
		sendCustomMessage: async () => {
			throw refusal;
		},
		sendUserMessage: async () => {
			throw refusal;
		},
	};
	const controller = new ExtensionUiController({
		session,
		showError,
		isBackgrounded: false,
		updateEditorChrome: () => {},
		updatePendingMessagesDisplay: () => {},
		editor: { addToHistory: () => {} },
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext);
	controller.initializeHookRunner({} as ExtensionUIContext, false);
	if (!captured) throw new Error("Expected the extension actions");
	return { actions: captured, showError };
}

describe("extension sends on a stuck session", () => {
	it("renders the operator message when an extension sendMessage is refused", async () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const { actions, showError } = captureActions(mismatch);

		actions.sendMessage({ customType: "probe", content: "go", display: false }, { triggerTurn: true });
		for (let attempt = 0; attempt < 50 && showError.mock.calls.length === 0; attempt++) await Bun.sleep(1);

		expect(showError).toHaveBeenCalledWith(`Extension sendMessage failed: ${mismatch.operatorMessage}`);
	});

	it("renders the operator message when an extension sendUserMessage is refused", async () => {
		const mismatch = new ManagedAppendIdentityMismatchError("session.jsonl");
		const { actions, showError } = captureActions(mismatch);

		// A queued delivery keeps the optimistic chat rendering out of this fake context.
		await Promise.resolve(actions.sendUserMessage("go", { deliverAs: "followUp" })).catch(() => {});
		for (let attempt = 0; attempt < 50 && showError.mock.calls.length === 0; attempt++) await Bun.sleep(1);

		expect(showError).toHaveBeenCalledWith(`Extension sendUserMessage failed: ${mismatch.operatorMessage}`);
	});
});
