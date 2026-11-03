import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import { getSegmenter, padding, sliceWithWidth, visibleWidth } from "../utils";
import { SingleLineEditor } from "./single-line-editor";

const segmenter = getSegmenter();
const secretValueIssuer = Symbol("SecretValue issuer");

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
 * The editing behavior is shared with Input, but render output is derived only
 * from grapheme counts; the backing characters are never returned or rendered.
 */
export class SecretInput implements Component, Focusable {
	#editor = new SingleLineEditor({
		clearOnEscape: true,
		onEscape: () => this.onEscape?.(),
		onSubmit: value => {
			const secret = new SecretValue(value, secretValueIssuer);
			this.#editor.clear();
			this.onSubmit?.(secret);
		},
	});
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
		this.#editor.handleInput(data);
	}

	clear(): void {
		this.#editor.clear();
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

	#maskedValueAndCursor(): { value: string; cursor: number } {
		const value = this.#editor.value;
		const cursor = this.#editor.cursor;
		const before = value.slice(0, cursor);
		const after = value.slice(cursor);
		const beforeMask = "•".repeat([...segmenter.segment(before)].length);
		return {
			value: beforeMask + "•".repeat([...segmenter.segment(after)].length),
			cursor: beforeMask.length,
		};
	}
}
