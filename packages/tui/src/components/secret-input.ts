import { BracketedPasteHandler } from "../bracketed-paste";
import { getKeybindings } from "../keybindings";
import { extractPrintableText } from "../keys";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceWithWidth,
	visibleWidth,
} from "../utils";

const segmenter = getSegmenter();
const secretValueIssuer = Symbol("SecretValue issuer");

interface SecretInputState {
	value: string;
	cursor: number;
}

function insertTextNfcAt(value: string, cursor: number, text: string): { value: string; cursor: number } {
	const before = value.slice(0, cursor);
	const after = value.slice(cursor);
	const beforeWithInsert = (before + text).normalize("NFC");
	return {
		value: (beforeWithInsert + after).normalize("NFC"),
		cursor: beforeWithInsert.length,
	};
}

/**
 * A one-shot secret transfer handle. The contained value is cleared immediately
 * after it is consumed and cannot be read through any other public API.
 */
export class SecretValue {
	#value: string;
	#consumed = false;

	/** @internal SecretInput is the sole issuer of usable SecretValue handles. */
	constructor(value: string, issuer: typeof secretValueIssuer) {
		if (issuer !== secretValueIssuer) {
			throw new TypeError("SecretValue handles can only be created by SecretInput");
		}
		this.#value = value;
	}

	consume(): string {
		if (this.#consumed) {
			return "";
		}

		this.#consumed = true;
		const value = this.#value;
		this.#value = "";
		return value;
	}
}

/**
 * A single-line masked input for credentials and other write-only secrets.
 *
 * The editing behavior follows Input, but render output is derived only from
 * grapheme counts; the backing characters are never returned or rendered.
 */
export class SecretInput implements Component, Focusable {
	#value = "";
	#cursor = 0;
	#pasteHandler = new BracketedPasteHandler();
	#killRing: string[] = [];
	#lastAction: "kill" | "yank" | "type-word" | null = null;
	#undoStack: SecretInputState[] = [];
	#disposed = false;

	readonly placeholder: string;
	onSubmit?: (value: SecretValue) => void;
	onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes. */
	focused = false;

	constructor(options: { placeholder?: string } = {}) {
		this.placeholder = options.placeholder ?? "";
	}

	handleInput(data: string): void {
		if (this.#disposed) {
			return;
		}

		const paste =
			data === "\x1b" && !this.#pasteHandler.hasPendingFrame
				? ({ handled: false } as const)
				: this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.leading.length > 0) this.handleInput(paste.leading);
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining);
				}
			}
			return;
		}

		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.clear();
			this.onEscape?.();
			return;
		}

		if (kb.matches(data, "tui.editor.undo")) {
			this.#undo();
			return;
		}

		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			this.#submit();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.#handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.#handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.#deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.#deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.#deleteToLineEnd();
			return;
		}

		if (kb.matches(data, "tui.editor.yank")) {
			this.#yank();
			return;
		}

		if (kb.matches(data, "tui.editor.yankPop")) {
			this.#yankPop();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#lastAction = null;
			if (this.#cursor > 0) {
				const lastGrapheme = [...segmenter.segment(this.#value.slice(0, this.#cursor))].at(-1);
				this.#cursor -= lastGrapheme?.segment.length ?? 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#lastAction = null;
			if (this.#cursor < this.#value.length) {
				const [firstGrapheme] = segmenter.segment(this.#value.slice(this.#cursor));
				this.#cursor += firstGrapheme?.segment.length ?? 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#lastAction = null;
			this.#cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#lastAction = null;
			this.#cursor = this.#value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#moveWordForwards();
			return;
		}

		const printableText = extractPrintableText(data);
		if (printableText) {
			this.#insertCharacter(printableText);
		}
	}

	clear(): void {
		this.#value = "";
		this.#cursor = 0;
		this.#lastAction = null;
		for (const snapshot of this.#undoStack) {
			snapshot.value = "";
			snapshot.cursor = 0;
		}
		this.#undoStack.length = 0;
		this.#killRing.fill("");
		this.#killRing.length = 0;
		// BracketedPasteHandler intentionally keeps its buffer private. Replacing it
		// drops any in-progress secret paste without retaining it in this component.
		this.#pasteHandler = new BracketedPasteHandler();
	}

	dispose(): void {
		if (this.#disposed) {
			return;
		}

		this.clear();
		this.focused = false;
		this.onSubmit = undefined;
		this.onEscape = undefined;
		this.#disposed = true;
	}

	invalidate(): void {
		// No cached state to invalidate currently.
	}

	render(width: number): string[] {
		if (this.#disposed) {
			return [];
		}

		const prompt = "> ";
		const availableWidth = width - prompt.length;
		if (availableWidth <= 0) {
			return [prompt];
		}

		const masked = this.#maskedValueAndCursor();
		const displayValue = masked.value.length === 0 && this.placeholder.length > 0 ? this.placeholder : masked.value;
		const cursorIndex = masked.value.length === 0 && this.placeholder.length > 0 ? 0 : masked.cursor;
		const cursorDisplayValue = cursorIndex >= displayValue.length ? `${displayValue} ` : displayValue;
		const totalCols = visibleWidth(cursorDisplayValue);
		const cursorCols = visibleWidth(cursorDisplayValue.slice(0, cursorIndex));
		const cursorIterator = segmenter.segment(cursorDisplayValue.slice(cursorIndex))[Symbol.iterator]();
		const cursorGrapheme = cursorIterator.next().value?.segment ?? " ";
		const cursorGraphemeWidth = visibleWidth(cursorGrapheme);

		const maxStart = Math.max(0, totalCols - availableWidth);
		let startCol = 0;
		if (totalCols > availableWidth) {
			const half = Math.floor(availableWidth / 2);
			startCol = Math.max(0, Math.min(maxStart, cursorCols - half));
			const maxCursorRel = Math.max(0, availableWidth - cursorGraphemeWidth);
			if (cursorCols - startCol > maxCursorRel) {
				startCol = Math.max(0, Math.min(maxStart, cursorCols - maxCursorRel));
			}
		}

		const visibleText = sliceWithWidth(cursorDisplayValue, startCol, availableWidth, true).text;
		const prefixText = sliceWithWidth(cursorDisplayValue, startCol, Math.max(0, cursorCols - startCol), true).text;
		const cursorDisplay = Math.max(0, Math.min(prefixText.length, visibleText.length));
		const [cursorSegment] = segmenter.segment(visibleText.slice(cursorDisplay));
		const atCursor = cursorSegment?.segment ?? " ";
		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);
		const marker = this.focused ? CURSOR_MARKER : "";
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
		const remainingAfterWidth = Math.max(0, availableWidth - visibleWidth(beforeCursor) - visibleWidth(atCursor));
		const clampedAfterCursor = sliceWithWidth(afterCursor, 0, remainingAfterWidth, true).text;
		const renderedNoMarker = beforeCursor + cursorChar + clampedAfterCursor;
		const line = prompt + beforeCursor + marker + cursorChar + clampedAfterCursor;
		return [line + padding(Math.max(0, availableWidth - visibleWidth(renderedNoMarker)))];
	}

	#submit(): void {
		const secret = new SecretValue(this.#value, secretValueIssuer);
		this.clear();
		this.onSubmit?.(secret);
	}

	#insertCharacter(text: string): void {
		const isWordChunk = [...segmenter.segment(text)].every(seg => getWordNavKind(seg.segment) !== "whitespace");
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#pushUndo();
		}
		this.#lastAction = "type-word";
		const inserted = insertTextNfcAt(this.#value, this.#cursor, text);
		this.#value = inserted.value;
		this.#cursor = inserted.cursor;
	}

	#handleBackspace(): void {
		this.#lastAction = null;
		if (this.#cursor <= 0) {
			return;
		}

		this.#pushUndo();
		const lastGrapheme = [...segmenter.segment(this.#value.slice(0, this.#cursor))].at(-1);
		const graphemeLength = lastGrapheme?.segment.length ?? 1;
		this.#value = this.#value.slice(0, this.#cursor - graphemeLength) + this.#value.slice(this.#cursor);
		this.#cursor -= graphemeLength;
	}

	#handleForwardDelete(): void {
		this.#lastAction = null;
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		const [firstGrapheme] = segmenter.segment(this.#value.slice(this.#cursor));
		const graphemeLength = firstGrapheme?.segment.length ?? 1;
		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + graphemeLength);
	}

	#deleteToLineStart(): void {
		if (this.#cursor === 0) {
			return;
		}

		this.#pushUndo();
		this.#pushKill(this.#value.slice(0, this.#cursor), true, this.#lastAction === "kill");
		this.#lastAction = "kill";
		this.#value = this.#value.slice(this.#cursor);
		this.#cursor = 0;
	}

	#deleteToLineEnd(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		this.#pushKill(this.#value.slice(this.#cursor), false, this.#lastAction === "kill");
		this.#lastAction = "kill";
		this.#value = this.#value.slice(0, this.#cursor);
	}

	#deleteWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}

		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();
		const oldCursor = this.#cursor;
		this.#moveWordBackwards();
		const deleteFrom = this.#cursor;
		this.#cursor = oldCursor;
		this.#pushKill(this.#value.slice(deleteFrom, this.#cursor), true, wasKill);
		this.#lastAction = "kill";
		this.#value = this.#value.slice(0, deleteFrom) + this.#value.slice(this.#cursor);
		this.#cursor = deleteFrom;
	}

	#deleteWordForward(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();
		const oldCursor = this.#cursor;
		this.#moveWordForwards();
		const deleteTo = this.#cursor;
		this.#cursor = oldCursor;
		this.#pushKill(this.#value.slice(this.#cursor, deleteTo), false, wasKill);
		this.#lastAction = "kill";
		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(deleteTo);
	}

	#yank(): void {
		const text = this.#killRing.at(-1);
		if (!text) {
			return;
		}

		this.#pushUndo();
		const inserted = insertTextNfcAt(this.#value, this.#cursor, text);
		this.#value = inserted.value;
		this.#cursor = inserted.cursor;
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) {
			return;
		}

		this.#pushUndo();
		const previous = this.#killRing.at(-1) ?? "";
		this.#value = this.#value.slice(0, this.#cursor - previous.length) + this.#value.slice(this.#cursor);
		this.#cursor -= previous.length;
		const last = this.#killRing.pop();
		if (last !== undefined) {
			this.#killRing.unshift(last);
		}
		const text = this.#killRing.at(-1) ?? "";
		const inserted = insertTextNfcAt(this.#value, this.#cursor, text);
		this.#value = inserted.value;
		this.#cursor = inserted.cursor;
		this.#lastAction = "yank";
	}

	#pushUndo(): void {
		this.#undoStack.push({ value: this.#value, cursor: this.#cursor });
	}

	#undo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) {
			return;
		}

		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#lastAction = null;
	}

	#moveWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordLeft(this.#value, this.#cursor);
	}

	#moveWordForwards(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordRight(this.#value, this.#cursor);
	}

	#handlePaste(pastedText: string): void {
		this.#lastAction = null;
		this.#pushUndo();
		const cleanText = replaceTabs(pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "")).normalize(
			"NFC",
		);
		const inserted = insertTextNfcAt(this.#value, this.#cursor, cleanText);
		this.#value = inserted.value;
		this.#cursor = inserted.cursor;
	}

	#pushKill(text: string, prepend: boolean, accumulate: boolean): void {
		if (!text) {
			return;
		}

		if (accumulate && this.#killRing.length > 0) {
			const lastIndex = this.#killRing.length - 1;
			const last = this.#killRing[lastIndex];
			this.#killRing[lastIndex] = prepend ? text + last : last + text;
			return;
		}

		this.#killRing.push(text);
	}

	#maskedValueAndCursor(): { value: string; cursor: number } {
		const before = this.#value.slice(0, this.#cursor);
		const after = this.#value.slice(this.#cursor);
		const beforeMask = "•".repeat([...segmenter.segment(before)].length);
		return {
			value: beforeMask + "•".repeat([...segmenter.segment(after)].length),
			cursor: beforeMask.length,
		};
	}
}
