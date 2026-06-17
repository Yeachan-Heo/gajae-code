import { describe, expect, it } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { CustomEditor } from "../src/modes/components/custom-editor";

describe("CustomEditor custom key handlers", () => {
	it("falls through to editor handling when a custom handler returns false", () => {
		const editor = new CustomEditor(defaultEditorTheme);
		let handled = 0;

		editor.setText("abc");
		editor.moveToLineEnd();
		editor.setCustomKeyHandler("ctrl+b", () => {
			handled += 1;
			return false;
		});
		editor.handleInput("\x02");

		expect(handled).toBe(1);
		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
	});

	it("consumes editor handling when a custom handler returns true", () => {
		const editor = new CustomEditor(defaultEditorTheme);
		let handled = 0;

		editor.setText("abc");
		editor.moveToLineEnd();
		editor.setCustomKeyHandler("ctrl+b", () => {
			handled += 1;
			return true;
		});
		editor.handleInput("\x02");

		expect(handled).toBe(1);
		expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
	});
});
