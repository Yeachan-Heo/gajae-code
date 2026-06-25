import { afterEach, describe, expect, it, vi } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { KEYBINDINGS } from "../src/config/keybindings";
import { CustomEditor } from "../src/modes/components/custom-editor";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

function createEditor() {
	return new CustomEditor(defaultEditorTheme);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("CustomEditor temporary model selector keybinding", () => {
	it("triggers the temporary selector from a remapped action key instead of Alt+P", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;
		editor.setActionKeys("app.model.selectTemporary", ["ctrl+y"]);

		editor.handleInput(ctrl("y"));
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});

	it("removes the default Alt+P shortcut when the action is disabled", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.setActionKeys("app.model.selectTemporary", []);
		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor queue keybinding", () => {
	it("triggers explicit queue from the configured action key", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		editor.onQueue = onQueue;

		editor.handleInput("\x1b\r");

		expect(onQueue).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("leaves Ctrl+Enter for newline by default", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		editor.onQueue = onQueue;

		editor.handleInput("a");
		editor.handleInput("\x1b[13;5u");
		editor.handleInput("b");

		expect(onQueue).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("a\nb");
	});

	it("supports remapping the explicit queue key when Alt+Enter is unavailable", () => {
		const editor = createEditor();
		const onQueue = vi.fn();
		editor.onQueue = onQueue;
		editor.setActionKeys("app.message.queue", ["alt+q"]);

		editor.handleInput("\x1b\r");
		expect(onQueue).not.toHaveBeenCalled();

		editor.handleInput("\x1bq");
		expect(onQueue).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor pasteImage default sourced from KEYBINDINGS", () => {
	it("intercepts the registry's platform-aware pasteImage default (single source of truth)", () => {
		const editor = createEditor();
		const onPasteImage = vi.fn();
		editor.onPasteImage = onPasteImage;

		const def = KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys;
		const key = Array.isArray(def) ? def[0]! : def;
		// ctrl+v on most platforms, alt+v on win32 — both come from the registry now.
		const data = key === "alt+v" ? "\x1bv" : ctrl("v");

		editor.handleInput(data);
		expect(onPasteImage).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor bracketed paste interception", () => {
	it("lets coding-agent consume pasted content before the base editor stores it", async () => {
		const editor = createEditor();
		const onPasteText = vi.fn(() => true);
		editor.onPasteText = onPasteText;

		editor.handleInput("\x1b[200~/tmp/clipboard-2026-06-04-120441-CAC144E7.png\x1b[201~");
		await Bun.sleep(0);

		expect(onPasteText).toHaveBeenCalledWith("/tmp/clipboard-2026-06-04-120441-CAC144E7.png");
		expect(editor.getText()).toBe("");
	});

	it("falls back to normal paste handling when coding-agent does not consume it", async () => {
		const editor = createEditor();
		const onPasteText = vi.fn(() => false);
		editor.onPasteText = onPasteText;

		editor.handleInput("\x1b[200~hello\x1b[201~");
		await Bun.sleep(0);

		expect(onPasteText).toHaveBeenCalledWith("hello");
		expect(editor.getText()).toBe("hello");
	});

	it("keeps later input behind a pending async consumed paste", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~/tmp/clipboard-2026-06-04-120441-CAC144E7.png\x1b[201~");
		editor.handleInput("after");

		expect(editor.getText()).toBe("before ");

		pasteDecision.resolve(true);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before after");
	});

	it("replays async unconsumed paste before later input", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		editor.handleInput("after");

		expect(editor.getText()).toBe("before ");

		pasteDecision.resolve(false);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before middle after");
	});

	it("drops queued input and ignores late async paste decisions after timeout", async () => {
		vi.useFakeTimers();
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		const onPastePendingInputCleared = vi.fn();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);
		editor.onPastePendingInputCleared = onPastePendingInputCleared;

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		editor.handleInput("after");

		expect(editor.getText()).toBe("before ");

		vi.advanceTimersByTime(5_000);
		expect(onPastePendingInputCleared).toHaveBeenCalledWith("timeout", 1);

		pasteDecision.resolve(false);
		await Promise.resolve();

		expect(editor.getText()).toBe("before ");
	});

	it("bounds the async paste input queue and clears pending state", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		const onPastePendingInputCleared = vi.fn();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);
		editor.onPastePendingInputCleared = onPastePendingInputCleared;

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		for (let index = 0; index < 65; index += 1) {
			editor.handleInput(`queued-${index} `);
		}

		expect(onPastePendingInputCleared).toHaveBeenCalledWith("queue-limit", 65);
		expect(editor.getText()).toBe("before ");

		pasteDecision.resolve(false);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before ");
	});

	it("clears pending async paste state when disposed", async () => {
		const editor = createEditor();
		const pasteDecision = Promise.withResolvers<boolean>();
		editor.onPasteText = vi.fn(() => pasteDecision.promise);

		editor.handleInput("before ");
		editor.handleInput("\x1b[200~middle \x1b[201~");
		editor.handleInput("after");
		editor.dispose();

		pasteDecision.resolve(false);
		await Bun.sleep(0);

		expect(editor.getText()).toBe("before ");
	});
});
