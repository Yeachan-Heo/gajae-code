import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@gajae-code/tui";
import { Input } from "@gajae-code/tui/components/input";
import { setKittyProtocolActive } from "@gajae-code/tui/keys";
import { visibleWidth } from "@gajae-code/tui/utils";
import { getIndentation } from "@gajae-code/utils";

function renderedWidth(input: Input, width: number): number {
	const [line] = input.render(width);
	// TUI strips this marker before its width verification; tests should mimic that.
	return visibleWidth(line.replaceAll(CURSOR_MARKER, ""));
}

describe("Input component", () => {
	const wordLeft = "\x1bb"; // ESC-b (alt+b)
	const wordRight = "\x1bf"; // ESC-f (alt+f)

	function setupAtEnd(text: string): Input {
		const input = new Input();
		input.focused = true;
		input.setValue(text);
		input.handleInput("\x05"); // Ctrl+E (end)
		return input;
	}

	it("places cursor at the end after setValue prefill", () => {
		const input = new Input();
		input.setValue("cla");
		input.handleInput("u");
		expect(input.getValue()).toBe("clau");
	});

	it("resets pending type coalescing after setValue", () => {
		const input = new Input();
		input.handleInput("a");
		input.setValue("bc");
		input.handleInput("d");
		input.handleInput("\x1f"); // Ctrl+/ undo
		expect(input.getValue()).toBe("bc");
	});

	it("moves by CJK and punctuation blocks (backward)", () => {
		const text = "天气不错，去散步吧！";

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错，去散步吧|！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错，|去散步吧！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("天气不错|，去散步吧！");
		}

		{
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("|天气不错，去散步吧！");
		}
	});

	it("moves by CJK and punctuation blocks (forward)", () => {
		const text = "天气不错，去散步吧！";
		const input = new Input();
		input.focused = true;
		input.setValue(text);
		input.handleInput("\x01"); // Ctrl+A (start)

		input.handleInput(wordRight);
		input.handleInput("|");
		expect(input.getValue()).toBe("天气不错|，去散步吧！");
	});

	it("treats NBSP as whitespace for word navigation", () => {
		const nbsp = "\u00A0";
		const text = `Hola${nbsp}mundo`;
		const input = setupAtEnd(text);
		input.handleInput(wordLeft);
		input.handleInput("|");
		expect(input.getValue()).toBe(`Hola${nbsp}|mundo`);
	});

	it("keeps common joiners inside words", () => {
		{
			const text = "co-operate l’été";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("co-operate |l’été");
		}

		{
			const text = "co-operate l’été";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("|co-operate l’été");
		}
	});

	it("recognizes Unicode punctuation as delimiter blocks", () => {
		{
			const text = "¿Cómo estás? ¡Muy bien!";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("¿Cómo estás? ¡Muy bien|!");
		}

		{
			const text = "¿Cómo estás? ¡Muy bien!";
			const input = setupAtEnd(text);
			input.handleInput(wordLeft);
			input.handleInput(wordLeft);
			input.handleInput("|");
			expect(input.getValue()).toBe("¿Cómo estás? ¡Muy |bien!");
		}
	});

	it("does not delete twice when Kitty sends backspace press and release", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("ab");

		input.handleInput("\x1b[127u");
		expect(input.getValue()).toBe("a");

		input.handleInput("\x1b[127;1:3u");
		expect(input.getValue()).toBe("a");

		setKittyProtocolActive(false);
	});

	it("inserts NumLock keypad digits from Kitty CSI-u input", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");

		input.handleInput("\x1b[57407;129u");
		expect(input.getValue()).toBe("a8");

		setKittyProtocolActive(false);
	});

	it("inserts keypad operators from Kitty CSI-u input", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");

		input.handleInput("\x1b[57410u");
		expect(input.getValue()).toBe("a/");

		setKittyProtocolActive(false);
	});

	it("normalizes tabs in buffered bracketed paste using configured indentation", () => {
		const input = setupAtEnd("");

		input.handleInput("\x1b[200~a\t");
		expect(input.getValue()).toBe("");

		input.handleInput("b\r\n");
		expect(input.getValue()).toBe("");

		input.handleInput("c\x1b[201~");
		expect(input.getValue()).toBe(`a${" ".repeat(getIndentation())}bc`);
	});

	it("never renders a line wider than the terminal width (wide chars)", () => {
		const input = new Input();
		input.focused = true;
		// Long wide-script text: string length != terminal cell width.
		input.setValue("天气不错，去散步吧！".repeat(50));
		input.handleInput("\x05"); // Ctrl+E (end)
		const width = 40;
		expect(renderedWidth(input, width)).toBeLessThanOrEqual(width);
	});

	it("normalizes NFD Korean pastes (macOS Finder drag-drop) to NFC", () => {
		// macOS Finder drag-drops file paths in NFD (decomposed Unicode).
		// Korean syllable `화` is U+D654 (1 char, 2 cells) in NFC, but
		// ᄒ(U+1112) + ᅪ(U+116A) (2 chars, 3 cells per Bun.stringWidth) in NFD.
		// Without normalization, the cursor lands `(NFD cells - NFC cells)`
		// past the visible filename — the documented "cursor displacement"
		// bug after drag-dropping a Korean filename.
		const input = new Input();
		input.focused = true;
		const nfcPath = "/Users/leo/Downloads/화면.mov";
		const nfdPath = nfcPath.normalize("NFD");
		// Sanity: ensure our test fixture really differs between NFC and NFD.
		expect(nfdPath).not.toBe(nfcPath);
		expect(nfdPath.length).toBeGreaterThan(nfcPath.length);

		// Simulate macOS bracketed-paste drop of an NFD path.
		input.handleInput(`\x1b[200~${nfdPath}\x1b[201~`);

		// Stored value must be NFC — no more NFD characters in the buffer.
		expect(input.getValue()).toBe(nfcPath);
	});
	it("normalizes typed NFD Korean so backspace removes one visible syllable", () => {
		const input = new Input();

		for (const char of "한") {
			input.handleInput(char);
		}

		expect(input.getValue()).toBe("한");

		input.handleInput("\x7f");

		expect(input.getValue()).toBe("");
	});

	it("NFC paste: cursor column matches visible cells (no displacement)", () => {
		// Regression guard for the "cursor floats past the filename" bug.
		// After paste, the cursor must be at a column == visibleWidth(value)
		// (plus 2 for the "> " prompt prefix).
		const input = new Input();
		input.focused = true;
		const nfdPath = "/Users/leo/화면\\ 기록.mov".normalize("NFD");
		input.handleInput(`\x1b[200~${nfdPath}\x1b[201~`);

		const [line] = input.render(120);
		const markerIdx = line.indexOf(CURSOR_MARKER);
		expect(markerIdx).toBeGreaterThanOrEqual(0);
		const col = visibleWidth(line.slice(0, markerIdx));
		// Prompt "> " (2 cells) + value width in NFC (matches terminal rendering).
		const expectedCol = 2 + visibleWidth(input.getValue());
		expect(col).toBe(expectedCol);
	});
});
