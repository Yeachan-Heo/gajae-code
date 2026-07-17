import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER, SecretInput, type SecretValue } from "@gajae-code/tui";

const TELEGRAM_TOKEN = "123456789:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const TELEGRAM_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{10,}/;

function renderSnapshot(input: SecretInput, width = 80): string {
	return input.render(width).join("\n");
}

function expectMaskedSnapshot(snapshot: string): void {
	const visible = Bun.stripANSI(snapshot.replaceAll(CURSOR_MARKER, ""));
	expect(snapshot).not.toContain(TELEGRAM_TOKEN);
	expect(visible).not.toMatch(TELEGRAM_TOKEN_PATTERN);
	expect(visible).toMatch(/^> [• ]*$/);
	expect(visible).toContain("•");
}

describe("SecretInput", () => {
	it("renders only bullets through typing, paste, cursor motion, undo, and backspace", () => {
		const input = new SecretInput();
		input.focused = true;

		for (const character of TELEGRAM_TOKEN) {
			input.handleInput(character);
		}
		const typed = renderSnapshot(input);
		const typedNarrow = renderSnapshot(input, 8);

		input.handleInput(`\x1b[200~${TELEGRAM_TOKEN}\x1b[201~`);
		const pasted = renderSnapshot(input);

		input.handleInput("\x01"); // Ctrl+A
		input.handleInput("\x1b[C");
		const movedCursor = renderSnapshot(input);

		input.handleInput("\x1f"); // Ctrl+/ undo
		const undone = renderSnapshot(input);

		input.handleInput("\x7f"); // Backspace
		const backspaced = renderSnapshot(input);

		for (const snapshot of [typed, typedNarrow, pasted, movedCursor, undone, backspaced]) {
			expectMaskedSnapshot(snapshot);
		}
	});

	it("normalizes paste to NFC and transfers the secret once", () => {
		const input = new SecretInput();
		let submitted: SecretValue | undefined;
		input.onSubmit = value => {
			submitted = value;
		};

		const nfdKorean = "화면".normalize("NFD");
		input.handleInput(`\x1b[200~${TELEGRAM_TOKEN}${nfdKorean}\x1b[201~`);
		expectMaskedSnapshot(renderSnapshot(input));

		input.handleInput("\n");
		expect(submitted).toBeDefined();
		expect(submitted?.consume()).toBe(`${TELEGRAM_TOKEN}화면`);
		expect(submitted?.consume()).toBe("");
		expect(Bun.stripANSI(renderSnapshot(input))).not.toContain(TELEGRAM_TOKEN);
	});

	it("clears and disposes all publicly accessible secret state", () => {
		const input = new SecretInput();
		input.handleInput(`\x1b[200~${TELEGRAM_TOKEN}\x1b[201~`);
		input.handleInput("\x01"); // Ctrl+A
		input.handleInput("\x0b"); // Ctrl+K puts the secret in the kill ring
		input.handleInput(`\x1b[200~${TELEGRAM_TOKEN}`); // Begin an incomplete paste
		input.clear();
		input.handleInput("\x1b[201~");
		input.handleInput("\x19"); // Ctrl+Y cannot recover a cleared kill ring
		expect(Bun.stripANSI(renderSnapshot(input))).not.toContain(TELEGRAM_TOKEN);

		let cleared: SecretValue | undefined;
		input.onSubmit = value => {
			cleared = value;
		};
		input.handleInput("\n");
		expect(cleared?.consume()).toBe("");
		expect("getValue" in input).toBe(false);
		expect(Object.values(input).join("\n")).not.toContain(TELEGRAM_TOKEN);

		input.handleInput(`\x1b[200~${TELEGRAM_TOKEN}\x1b[201~`);
		input.dispose();
		expect(input.render(80)).toEqual([]);
		expect(Object.values(input).join("\n")).not.toContain(TELEGRAM_TOKEN);
	});
});
