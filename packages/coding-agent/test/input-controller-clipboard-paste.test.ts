import { describe, expect, it, vi } from "bun:test";
import type { ClipboardImage } from "@gajae-code/natives";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import type { LoadedPastedImageBatch } from "../src/utils/pasted-image-loading";
import { formatPastedImageReference } from "../src/utils/pasted-image-path";

function createController(options: { fileUrls?: string[]; text?: string }) {
	const inserted: string[] = [];
	const showStatus = vi.fn();
	const showHookSelector = vi.fn(async (): Promise<string | undefined> => "Attach images");
	const ctx = {
		isBashMode: false,
		isPythonMode: false,
		pendingImages: [] as InteractiveModeContext["pendingImages"],
		sessionManager: { getCwd: () => "/workspace" },
		settings: { get: () => false },
		editor: {
			getText: () => inserted.join(""),
			insertText: (text: string) => inserted.push(text),
		},
		ui: { requestRender: vi.fn() },
		showStatus,
		showHookSelector,
	} as unknown as InteractiveModeContext;
	const readMacFileUrls = vi.fn(async () => options.fileUrls ?? []);
	const readImage = vi.fn(async (): Promise<ClipboardImage | null> => null);
	const readText = vi.fn(async () => options.text ?? "");
	const loadPastedImageBatch = vi.fn(
		async (loadOptions: { paths: readonly string[]; sourcePolicy?: string }): Promise<LoadedPastedImageBatch> => ({
			images: loadOptions.paths.map(() => ({ type: "image", data: "x", mimeType: "image/png" })),
			loadedInputs: [],
			sourcePaths: [...loadOptions.paths],
		}),
	);
	const controller = new InputController(ctx, {
		loadPastedImageBatch,
		clipboard: { readMacFileUrls, readImage, readText },
	});
	return {
		controller,
		ctx,
		inserted,
		showStatus,
		showHookSelector,
		readMacFileUrls,
		readImage,
		readText,
		loadPastedImageBatch,
	};
}

describe("InputController Ctrl+V smart paste", () => {
	it("inserts clipboard text when the clipboard holds no image", async () => {
		const { controller, inserted, showStatus } = createController({ text: "just some text" });

		expect(await controller.handleImagePaste()).toBe(true);

		expect(inserted).toEqual(["just some text"]);
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("reports an empty clipboard", async () => {
		const { controller, inserted, showStatus } = createController({});

		expect(await controller.handleImagePaste()).toBe(false);

		expect(inserted).toEqual([]);
		expect(showStatus).toHaveBeenCalledWith("Clipboard is empty");
	});

	it("attaches Finder-copied image files before reading the bitmap", async () => {
		const { controller, ctx, inserted, readImage, readText, loadPastedImageBatch, showHookSelector } =
			createController({
				fileUrls: ["/Users/me/Pictures/a b.png", "/Users/me/Documents/notes.txt"],
			});

		expect(await controller.handleImagePaste()).toBe(true);

		expect(loadPastedImageBatch).toHaveBeenCalledTimes(1);
		expect(loadPastedImageBatch.mock.calls[0]?.[0].paths).toEqual(["/Users/me/Pictures/a b.png"]);
		// Copying the file and pressing the image-paste key is already an explicit choice.
		expect(showHookSelector).not.toHaveBeenCalled();
		expect(loadPastedImageBatch.mock.calls[0]?.[0].sourcePolicy).toBe("confirmed");
		expect(readImage).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
		expect(ctx.pendingImages).toHaveLength(1);
		expect(inserted).toEqual([`${formatPastedImageReference("[image 1]", "/Users/me/Pictures/a b.png")} `]);
	});

	it("falls through to clipboard text when the pasteboard files are not images", async () => {
		const { controller, inserted, loadPastedImageBatch } = createController({
			fileUrls: ["/Users/me/Documents/notes.txt"],
			text: "plain",
		});

		expect(await controller.handleImagePaste()).toBe(true);

		expect(loadPastedImageBatch).not.toHaveBeenCalled();
		expect(inserted).toEqual(["plain"]);
	});
});
