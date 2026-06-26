import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { HookEditorComponent } from "@gajae-code/coding-agent/modes/components/hook-editor";
import { ExtensionUiController } from "@gajae-code/coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { setKeybindings, type TUI } from "@gajae-code/tui";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

function createTui(): TUI {
	return {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120 },
	} as unknown as TUI;
}

function renderText(component: HookEditorComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function renderLines(component: HookEditorComponent, width = 120): string[] {
	return Bun.stripANSI(component.render(width).join("\n")).split("\n");
}

type TestContext = InteractiveModeContext & {
	editorContainer: {
		children: unknown[];
		clear: () => void;
		addChild: (child: unknown) => void;
		detachChild: (child: unknown) => void;
	};
};

function createControllerContext() {
	const editor = { id: "core-editor" };
	const editorContainer = {
		children: [] as unknown[],
		clear() {
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
	const ui = {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120, rows: 30, write: vi.fn() },
	} as unknown as TestContext["ui"] & {
		setFocus: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
	};
	const ctx = {
		editor,
		editorContainer,
		ui,
		hookEditor: undefined,
	} as unknown as TestContext;

	return { ctx, editor, editorContainer, ui };
}

describe("HookEditorComponent default (hook) mode", () => {
	it("inserts a newline on Enter instead of submitting immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);

		component.handleInput("a");
		component.handleInput("b");
		component.handleInput("\n");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("c");
		component.handleInput("d");
		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits the current text on Ctrl+Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "line 1\nline 2", onSubmit, onCancel);

		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("line 1\nline 2");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits Ctrl+Enter variants with NumLock or keypad Enter metadata", () => {
		const variants = ["\x1b[13;133u", "\x1b[57414;5u", "\x1b[57414;133u"];

		for (const variant of variants) {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

			component.handleInput(variant);

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith("draft");
			expect(onCancel).not.toHaveBeenCalled();
		}
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("HookEditorComponent prompt-style mode", () => {
	it("submits on plain Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("b");
		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits on alternate Enter encodings recognized by the key matcher", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\x1bOM");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits when a non-Windows terminal reports plain Enter as LF", () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux" });
		try {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
				promptStyle: true,
			});

			component.handleInput("a");
			component.handleInput("\n");

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith("a");
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it("inserts newline for Windows PowerShell raw LF newline chords", () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
				promptStyle: true,
			});

			component.handleInput("a");
			component.handleInput("\n");
			component.handleInput("b");
			component.handleInput("\r");

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith("a\nb");
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it("inserts newline on Shift+Enter instead of submitting", () => {
		const variants = ["\x1b[13;2~", "\x1b[13;2u"];

		for (const variant of variants) {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
				promptStyle: true,
			});

			component.handleInput("a");
			component.handleInput(variant);

			expect(onSubmit).not.toHaveBeenCalled();
			expect(onCancel).not.toHaveBeenCalled();

			component.handleInput("b");
			component.handleInput("\r");

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith("a\nb");
		}
	});

	it("treats Ctrl+Enter as newline in prompt-style mode", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("x");
		component.handleInput("\x1b[13;5u");

		expect(onSubmit).not.toHaveBeenCalled();

		component.handleInput("y");
		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("x\ny");
	});

	it("renders prompt-style editor with legacy ask chrome", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		const rendered = renderText(component);
		const lines = renderLines(component);

		expect(lines[0]).toMatch(/^─+$/);
		expect(lines.at(-1)).toMatch(/^─+$/);
		expect(lines[4]?.startsWith("> ")).toBe(true);
		expect(rendered).toContain(" enter submit  shift+enter/ctrl+j newline");
		expect(rendered).toContain("ctrl+g external editor");
	});

	it("keeps the prompt gutter visible after typing in prompt-style mode", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		for (const char of "hello") {
			component.handleInput(char);
		}

		const lines = renderLines(component);
		expect(lines[4]?.startsWith("> hello")).toBe(true);
		expect(lines[4]?.startsWith("hello")).toBe(false);
	});

	it("aligns wrapped prompt-style continuation rows under the text column", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", "abcdefghijklm", vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		const lines = renderLines(component, 12);
		expect(lines[4]).toBe("> abcdefghij");
		expect(lines[5]?.startsWith("  klm")).toBe(true);
		expect(lines[5]?.startsWith(">")).toBe(false);
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("cancels on app.interrupt in prompt-style mode even when remapped", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"app.interrupt": "ctrl+c",
			}),
		);
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("\x03");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("ExtensionUiController hook editor abort", () => {
	it("hides the hook editor and resolves undefined when the caller aborts", async () => {
		const { ctx, editor, editorContainer, ui } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const abortController = new AbortController();
		const controllerWithAbort = controller as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};

		const promise = controllerWithAbort.showHookEditor("Prompt", "draft", { signal: abortController.signal });

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookEditor).toBeDefined();

		abortController.abort();
		await Bun.sleep(0);

		expect(editorContainer.children).toEqual([editor]);
		expect(ctx.hookEditor).toBeUndefined();
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);

		const pending = Symbol("pending");
		const result = await Promise.race([promise, Bun.sleep(20).then(() => pending)]);
		expect(result).toBeUndefined();
	});

	it("forwards editorOptions to HookEditorComponent", async () => {
		const { ctx, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const controllerWithOptions = controller as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};

		// Start the editor with promptStyle
		const promise = controllerWithOptions.showHookEditor("Ask prompt", undefined, undefined, {
			promptStyle: true,
		});

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookEditor).toBeDefined();

		// The component should be a HookEditorComponent in prompt-style mode.
		// Verify by sending Enter — it should submit, not insert newline.
		const hookEditor = ctx.hookEditor!;
		hookEditor.handleInput("test-text".split("").join(""));
		hookEditor.handleInput("\r");

		// The promise should resolve since Enter submits in prompt-style mode.
		const result = await promise;
		// Result depends on what the editor captured. The key thing is it resolved.
		expect(result).toBeDefined();
	});

	it("lets scrollable hook selectors use the available terminal height", async () => {
		const { ctx, editorContainer, ui } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const title = Array.from({ length: 40 }, (_, index) => `Prompt row ${index + 1}`).join("\n");
		const promise = controller.showHookSelector(title, ["Alpha", "Beta", "Gamma"], {
			outline: true,
			wrapFocused: true,
			scrollTitleRows: Number.MAX_SAFE_INTEGER,
		});

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookSelector).toBeDefined();

		const rendered = Bun.stripANSI(ctx.hookSelector!.render(80).join("\n"));
		const lines = rendered.split("\n");
		expect(lines).toHaveLength(30);
		expect(rendered).toContain("Prompt row 17");
		expect(rendered).not.toContain("Prompt row 18");
		expect(rendered).toContain("▼ more");
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Gamma");
		// Scrollable selectors must NOT enable SGR mouse reporting: doing so would hijack the
		// terminal's native wheel/scrollbar scrollback. The question scrolls via PgUp/PgDn only.
		expect(ui.terminal.write).not.toHaveBeenCalledWith("\x1b[?1006h\x1b[?1000h");

		ctx.hookSelector!.handleInput("\n");
		expect(await promise).toBe("Alpha");
		expect(ui.terminal.write).not.toHaveBeenCalledWith("\x1b[?1000l\x1b[?1006l");
	});
});
