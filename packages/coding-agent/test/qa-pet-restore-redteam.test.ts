import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { ExtensionUiController } from "@gajae-code/coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { Component, TUI } from "@gajae-code/tui";
import { setKeybindings } from "@gajae-code/tui";

type TestEditor = {
	id: string;
	getText: () => string;
	setText: ReturnType<typeof vi.fn>;
	getAutocompleteProvider: () => undefined;
};

type TestEditorContainer = {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
	detachChild: (child: unknown) => void;
	clearCount: number;
};

type TestUi = TUI & {
	setFocus: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
	showOverlay: ReturnType<typeof vi.fn>;
	overlayHide: ReturnType<typeof vi.fn>;
};

type TestContext = {
	editor: TestEditor;
	editorContainer: TestEditorContainer;
	ui: TestUi;
	hookSelector: InteractiveModeContext["hookSelector"];
	hookInput: InteractiveModeContext["hookInput"];
	hookEditor: InteractiveModeContext["hookEditor"];
	restoreComposer: () => void;
};

type PetRestore = {
	framedEditor: { id: string };
	restoreComposer: ReturnType<typeof vi.fn>;
};

beforeAll(async () => {
	const loadedTheme = await getThemeByName("red-claw");
	if (!loadedTheme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(loadedTheme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

function createControllerContext(initialText = "draft"): TestContext {
	let editorText = initialText;
	const editor = {
		id: "core-editor",
		getText: vi.fn(() => editorText),
		setText: vi.fn((text: string) => {
			editorText = text;
		}),
		getAutocompleteProvider: vi.fn(() => undefined),
	};
	const editorContainer: TestEditorContainer = {
		children: [editor],
		clearCount: 0,
		clear() {
			this.clearCount += 1;
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
		detachChild(child: unknown) {
			const index = this.children.indexOf(child);
			if (index !== -1) {
				this.children.splice(index, 1);
			}
		},
	};
	const overlayHide = vi.fn();
	const ui = {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		getShowHardwareCursor: vi.fn(() => false),
		showOverlay: vi.fn(() => ({ hide: overlayHide })),
		overlayHide,
		terminal: { columns: 120, rows: 30, write: vi.fn() },
	} as unknown as TestUi;

	return {
		editor,
		editorContainer,
		ui,
		hookSelector: undefined,
		hookInput: undefined,
		hookEditor: undefined,
		restoreComposer() {
			editorContainer.clear();
			editorContainer.addChild(editor);
		},
	};
}

function createController(ctx: TestContext): ExtensionUiController {
	return new ExtensionUiController(ctx as unknown as InteractiveModeContext);
}

function installPetRestore(ctx: TestContext): PetRestore {
	const framedEditor = { id: "pet-framed-editor" };
	const restoreComposer = vi.fn(() => {
		ctx.editorContainer.clear();
		ctx.editorContainer.addChild(framedEditor);
	});
	ctx.restoreComposer = restoreComposer;
	return { framedEditor, restoreComposer };
}

function expectPetComposerRestored(ctx: TestContext, pet: PetRestore, expectedCalls: number): void {
	expect(pet.restoreComposer).toHaveBeenCalledTimes(expectedCalls);
	expect(ctx.editorContainer.children).toEqual([pet.framedEditor]);
	expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
}

function typeInto(component: { handleInput: (keyData: string) => void }, text: string): void {
	for (const character of text) {
		component.handleInput(character);
	}
}

describe("qa-pet-restore-redteam", () => {
	it("1. restores the framed composer exactly once for selector picks and inline ask answers", async () => {
		const ctx = createControllerContext();
		const pet = installPetRestore(ctx);
		const controller = createController(ctx);

		const selected = controller.showHookSelector("Pick one", ["Alpha"]);
		ctx.hookSelector!.handleInput("\r");
		expect(await selected).toBe("Alpha");
		expectPetComposerRestored(ctx, pet, 1);

		const customSubmit = vi.fn();
		const custom = controller.showHookSelector("Other answer", ["Other"], {
			customInput: { optionLabel: "Other", onSubmit: customSubmit },
		});
		ctx.hookSelector!.handleInput("\r");
		expect(ctx.hookSelector!.hasActiveInlineInput()).toBe(true);
		typeInto(ctx.hookSelector!, "inline answer");
		ctx.hookSelector!.handleInput("\r");
		expect(await custom).toBe("Other");
		expect(customSubmit).toHaveBeenCalledWith("inline answer");
		expectPetComposerRestored(ctx, pet, 2);

		const clarificationSubmit = vi.fn();
		const clarification = controller.showHookSelector("Clarify", ["Clarify"], {
			clarificationInput: { optionLabel: "Clarify", allowEmpty: false, onSubmit: clarificationSubmit },
		});
		ctx.hookSelector!.handleInput("\r");
		typeInto(ctx.hookSelector!, "What does this mean?");
		ctx.hookSelector!.handleInput("\r");
		expect(await clarification).toBe("Clarify");
		expect(clarificationSubmit).toHaveBeenCalledWith("What does this mean?");
		expectPetComposerRestored(ctx, pet, 3);
	});

	it("2. restores the framed composer for hook input and clarification editor answers", async () => {
		const ctx = createControllerContext();
		const pet = installPetRestore(ctx);
		const controller = createController(ctx);

		const input = controller.showHookInput("Input", "answer");
		typeInto(ctx.hookInput!, "short answer");
		ctx.hookInput!.handleInput("\r");
		expect(await input).toBe("short answer");
		expectPetComposerRestored(ctx, pet, 1);

		const editor = controller.showHookEditor("Clarification", undefined, undefined, { promptStyle: true });
		typeInto(ctx.hookEditor!, "longer clarification");
		ctx.hookEditor!.handleInput("\r");
		expect(await editor).toBe("longer clarification");
		expectPetComposerRestored(ctx, pet, 2);
	});

	it("3. routes selector, input, and editor aborts through the pet-aware restore and resolves undefined", async () => {
		for (const open of [
			(controller: ExtensionUiController, signal: AbortSignal) =>
				controller.showHookSelector("Abort selector", ["Alpha"], { signal }),
			(controller: ExtensionUiController, signal: AbortSignal) =>
				controller.showHookInput("Abort input", undefined, { signal }),
			(controller: ExtensionUiController, signal: AbortSignal) =>
				controller.showHookEditor("Abort editor", undefined, { signal }),
		]) {
			const ctx = createControllerContext();
			const pet = installPetRestore(ctx);
			const controller = createController(ctx);
			const abortController = new AbortController();
			const result = open(controller, abortController.signal);

			abortController.abort();
			expect(await result).toBeUndefined();
			expectPetComposerRestored(ctx, pet, 1);
		}
	});

	it("4. restores non-overlay custom UI but never remounts for overlay custom UI", async () => {
		const nonOverlayContext = createControllerContext("saved draft");
		const nonOverlayPet = installPetRestore(nonOverlayContext);
		const nonOverlayController = createController(nonOverlayContext);
		const nonOverlayComponent = { dispose: vi.fn() } as unknown as Component & { dispose: () => void };
		let closeNonOverlay: ((result: string) => void) | undefined;
		const nonOverlay = nonOverlayController.showHookCustom<string>((_ui, _theme, _keybindings, done) => {
			closeNonOverlay = done;
			return nonOverlayComponent;
		});
		await Bun.sleep(0);
		expect(nonOverlayContext.editorContainer.children).toEqual([nonOverlayComponent]);
		closeNonOverlay!("done");
		expect(await nonOverlay).toBe("done");
		expectPetComposerRestored(nonOverlayContext, nonOverlayPet, 1);
		expect(nonOverlayContext.editor.setText).toHaveBeenCalledWith("saved draft");

		const overlayContext = createControllerContext();
		const overlayPet = installPetRestore(overlayContext);
		const overlayController = createController(overlayContext);
		const overlayComponent = { dispose: vi.fn() } as unknown as Component & { dispose: () => void };
		let closeOverlay: ((result: string) => void) | undefined;
		const overlay = overlayController.showHookCustom<string>(
			(_ui, _theme, _keybindings, done) => {
				closeOverlay = done;
				return overlayComponent;
			},
			{ overlay: true },
		);
		await Bun.sleep(0);
		expect(overlayContext.ui.showOverlay).toHaveBeenCalledTimes(1);
		expect(overlayContext.editorContainer.children).toEqual([overlayContext.editor]);
		closeOverlay!("overlay done");
		expect(await overlay).toBe("overlay done");
		expect(overlayPet.restoreComposer).not.toHaveBeenCalled();
		expect(overlayContext.editorContainer.children).toEqual([overlayContext.editor]);
		expect(overlayContext.ui.overlayHide).toHaveBeenCalledTimes(1);
	});

	it("5. tolerates double-close and an abort after an already-answered selector without stale children", async () => {
		const doubleCloseContext = createControllerContext();
		const doubleClosePet = installPetRestore(doubleCloseContext);
		const doubleCloseController = createController(doubleCloseContext);
		const pending = doubleCloseController.showHookSelector("Double close", ["Alpha"]);
		void pending;
		expect(() => {
			doubleCloseController.hideHookSelector();
			doubleCloseController.hideHookSelector();
		}).not.toThrow();
		expectPetComposerRestored(doubleCloseContext, doubleClosePet, 2);

		const answeredContext = createControllerContext();
		const answeredPet = installPetRestore(answeredContext);
		const answeredController = createController(answeredContext);
		const abortController = new AbortController();
		const answered = answeredController.showHookSelector("Answer then abort", ["Alpha"], {
			signal: abortController.signal,
		});
		answeredContext.hookSelector!.handleInput("\r");
		expect(await answered).toBe("Alpha");
		expect(() => abortController.abort()).not.toThrow();
		expectPetComposerRestored(answeredContext, answeredPet, 1);
	});

	it("6. restores the framed composer between rapid consecutive selector answers without accumulating children", async () => {
		const ctx = createControllerContext();
		const pet = installPetRestore(ctx);
		const controller = createController(ctx);

		const first = controller.showHookSelector("First question", ["One"]);
		ctx.hookSelector!.handleInput("\r");
		expect(await first).toBe("One");
		expectPetComposerRestored(ctx, pet, 1);

		const second = controller.showHookSelector("Second question", ["Two"]);
		ctx.hookSelector!.handleInput("\r");
		expect(await second).toBe("Two");
		expectPetComposerRestored(ctx, pet, 2);
		expect(ctx.editorContainer.children).toHaveLength(1);
	});
});
