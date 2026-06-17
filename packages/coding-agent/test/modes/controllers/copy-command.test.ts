import { afterEach, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import * as native from "@gajae-code/natives";

function createController(options: { assistantText?: string; hasAssistantMessage?: boolean; handoffText?: string }) {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session: {
			getLastAssistantText: () => options.assistantText,
			hasCopyCandidateAssistantMessage: () => options.hasAssistantMessage ?? options.assistantText !== undefined,
			getLastVisibleHandoffText: () => options.handoffText,
		},
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return { controller: new CommandController(ctx), showStatus, showError };
}

describe("/copy command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("copies the latest assistant text", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			assistantText: "latest **markdown** response",
		});

		controller.handleCopyCommand();

		expect(copySpy).toHaveBeenCalledWith("latest **markdown** response");
		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});

	it("falls back to the fresh handoff context when no assistant message exists", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			handoffText: "<handoff-context>\n## Goal\nContinue\n</handoff-context>",
		});

		controller.handleCopyCommand();

		expect(copySpy).toHaveBeenCalledWith("<handoff-context>\n## Goal\nContinue\n</handoff-context>");
		expect(showStatus).toHaveBeenCalledWith("Copied handoff context to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not fall back to stale handoff context after a textless assistant response", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			hasAssistantMessage: true,
			handoffText: "<handoff-context>\n## Goal\nContinue\n</handoff-context>",
		});

		controller.handleCopyCommand();

		expect(copySpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("No agent messages to copy yet.");
	});

	it("shows an error when no assistant message or handoff context exists", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			hasAssistantMessage: false,
		});

		controller.handleCopyCommand();

		expect(copySpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("No agent messages to copy yet.");
	});
});
