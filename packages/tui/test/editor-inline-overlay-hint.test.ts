import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "@gajae-code/tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

describe("Editor inlineOverlayHint", () => {
	it("renders the overlay as ghost text after the cursor", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("fix the ");
		editor.inlineOverlayHint = "flaky test";
		const rendered = stripVTControlCharacters(editor.render(40).join("\n"));
		expect(rendered).toContain("fix the");
		expect(rendered).toContain("flaky test");
	});

	it("shows on an empty editor, suppressing the placeholder", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setPlaceholder("type here");
		editor.inlineOverlayHint = "streaming transcript";
		const rendered = stripVTControlCharacters(editor.render(40).join("\n"));
		expect(rendered).toContain("streaming transcript");
		expect(rendered).not.toContain("type here");
	});

	it("clears immediately when reset to undefined", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.inlineOverlayHint = "ghost";
		expect(stripVTControlCharacters(editor.render(40).join("\n"))).toContain("ghost");
		editor.inlineOverlayHint = undefined;
		expect(stripVTControlCharacters(editor.render(40).join("\n"))).not.toContain("ghost");
	});

	it("never becomes part of the buffer", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("real text");
		editor.inlineOverlayHint = "ghost text";
		editor.render(40);
		expect(editor.getText()).toBe("real text");
	});
});
