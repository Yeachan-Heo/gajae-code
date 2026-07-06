import { describe, expect, it } from "bun:test";
import type { EditorTheme, SelectListTheme, SymbolTheme } from "@gajae-code/tui";
import { setDefaultTabWidth } from "@gajae-code/utils";
import { CustomEditor } from "../../../src/modes/components/custom-editor";

const identity = (text: string) => text;

const symbols: SymbolTheme = {
	cursor: ">",
	inputCursor: "|",
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
	},
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: "│",
	hrChar: "-",
	spinnerFrames: ["-", "\\", "|", "/"],
};

const selectList: SelectListTheme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
	symbols,
};

const theme: EditorTheme = {
	borderColor: identity,
	selectList,
	symbols,
};

class CountingCustomEditor extends CustomEditor {
	invalidations = 0;

	override invalidate(): void {
		this.invalidations += 1;
		super.invalidate();
	}
}

describe("CustomEditor dispose", () => {
	it("unsubscribes the inherited tab-width listener and remains idempotent", () => {
		try {
			setDefaultTabWidth(4);
			const editor = new CountingCustomEditor(theme);

			setDefaultTabWidth(2);
			expect(editor.invalidations).toBe(1);

			editor.dispose();
			editor.dispose();
			setDefaultTabWidth(8);

			expect(editor.invalidations).toBe(1);
		} finally {
			setDefaultTabWidth(4);
		}
	});
});
