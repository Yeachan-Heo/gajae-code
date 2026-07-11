import { describe, expect, it } from "bun:test";
import { trimEditorTrailingNewline } from "../../src/utils/external-editor";

describe("trimEditorTrailingNewline", () => {
	it("removes a single CRLF terminator completely", () => {
		expect(trimEditorTrailingNewline("edited\r\n")).toBe("edited");
	});

	it("preserves existing LF and unterminated text behavior", () => {
		expect(trimEditorTrailingNewline("edited\n")).toBe("edited");
		expect(trimEditorTrailingNewline("edited")).toBe("edited");
	});

	it("removes only one trailing line terminator", () => {
		expect(trimEditorTrailingNewline("edited\r\n\r\n")).toBe("edited\r\n");
	});
});
