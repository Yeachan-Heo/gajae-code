import { describe, expect, it } from "bun:test";
import {
	prepareWindowsConsoleForExternalEditor,
	shouldUseExternalEditorShell,
	trimEditorTrailingNewline,
} from "../../src/utils/external-editor";

describe("prepareWindowsConsoleForExternalEditor", () => {
	it("reasserts runtime raw mode for Windows pseudo-terminals", () => {
		const modes: boolean[] = [];
		prepareWindowsConsoleForExternalEditor("win32", { setRawMode: mode => modes.push(mode) });
		expect(modes).toEqual([true]);
	});

	it("does not touch raw mode on POSIX", () => {
		const modes: boolean[] = [];
		prepareWindowsConsoleForExternalEditor("linux", { setRawMode: mode => modes.push(mode) });
		expect(modes).toEqual([]);
	});
});

describe("shouldUseExternalEditorShell", () => {
	it("spawns native Windows executables directly", () => {
		expect(shouldUseExternalEditorShell("nvim", "win32")).toBe(false);
		expect(shouldUseExternalEditorShell("C:\\Tools\\nvim.exe", "win32")).toBe(false);
	});

	it("keeps the shell for Windows batch editors", () => {
		expect(shouldUseExternalEditorShell("editor.cmd", "win32")).toBe(true);
		expect(shouldUseExternalEditorShell("C:\\Tools\\editor.bat", "win32")).toBe(true);
	});

	it("never adds a shell on POSIX", () => {
		expect(shouldUseExternalEditorShell("editor.cmd", "linux")).toBe(false);
	});
});

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
