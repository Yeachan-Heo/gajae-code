import { describe, expect, it, vi } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { CustomEditor } from "../src/modes/components/custom-editor";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

function createEditor() {
	return new CustomEditor(defaultEditorTheme);
}

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
});
