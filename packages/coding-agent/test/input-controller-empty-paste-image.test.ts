import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PasteTextContext } from "../src/modes/components/custom-editor";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";

const context: PasteTextContext = { signal: new AbortController().signal, commit: commit => commit() };

function createController(mode: { bash?: boolean } = {}) {
	const ctx = {
		isBashMode: mode.bash ?? false,
		isPythonMode: false,
		sessionManager: { getCwd: () => "/tmp" },
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	const imagePaste = vi.spyOn(controller, "handleImagePaste").mockResolvedValue(true);
	return { controller, imagePaste };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController empty bracketed paste", () => {
	// Some terminals deliver Cmd+V on an image-only clipboard as an
	// empty bracketed paste; the image never reaches the program as text.
	it("attaches the clipboard image when the terminal pastes no text", async () => {
		const { controller, imagePaste } = createController();

		const result = await controller.handleTextPaste("", context);

		expect(imagePaste).toHaveBeenCalledTimes(1);
		expect(result).toBe(true);
	});

	it("leaves non-empty text pastes to the normal text path", async () => {
		const { controller, imagePaste } = createController();

		const result = await controller.handleTextPaste("plain words", context);

		expect(imagePaste).not.toHaveBeenCalled();
		expect(result).toBe(false);
	});

	it("does not read the clipboard image in bash mode", async () => {
		const { controller, imagePaste } = createController({ bash: true });

		const result = await controller.handleTextPaste("", context);

		expect(imagePaste).not.toHaveBeenCalled();
		expect(result).toBe(false);
	});
});
