import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import { getSegmenter, padding, sliceWithWidth, visibleWidth } from "../utils";
import { SingleLineEditor } from "./single-line-editor";

const segmenter = getSegmenter();

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	#editor = new SingleLineEditor({
		onEdit: () => this.onEdit?.(),
		onSubmit: value => this.onSubmit?.(value),
		onEscape: () => this.onEscape?.(),
	});

	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	onEdit?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	getValue(): string {
		return this.#editor.value;
	}

	setValue(value: string): void {
		this.#editor.setValue(value);
	}

	handleInput(data: string): void {
		this.#editor.handleInput(data);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const value = this.#editor.value;
		const cursor = this.#editor.cursor;
		// Calculate visible window
		const prompt = "> ";
		const availableWidth = width - prompt.length;

		if (availableWidth <= 0) {
			return [prompt];
		}

		const cursorIndex = cursor;
		// Ensure we always have a grapheme to invert at the cursor (space at end).
		const displayValue = cursorIndex >= value.length ? `${value} ` : value;

		const totalCols = visibleWidth(displayValue);
		const cursorCols = visibleWidth(displayValue.slice(0, cursorIndex));

		// Width of the grapheme at the cursor, for ensuring it fits in the viewport.
		const cursorIter = segmenter.segment(displayValue.slice(cursorIndex))[Symbol.iterator]();
		const cursorG = cursorIter.next().value?.segment ?? " ";
		const cursorGWidth = visibleWidth(cursorG);

		const maxStart = Math.max(0, totalCols - availableWidth);
		let startCol = 0;
		if (totalCols > availableWidth) {
			const half = Math.floor(availableWidth / 2);
			startCol = Math.max(0, Math.min(maxStart, cursorCols - half));

			// Ensure the cursor grapheme is inside the viewport (and fits fully if wide).
			const maxCursorRel = Math.max(0, availableWidth - cursorGWidth);
			const cursorRel = cursorCols - startCol;
			if (cursorRel > maxCursorRel) {
				startCol = Math.max(0, Math.min(maxStart, cursorCols - maxCursorRel));
			}
		}

		const visibleText = sliceWithWidth(displayValue, startCol, availableWidth, true).text;
		const prefixText = sliceWithWidth(displayValue, startCol, Math.max(0, cursorCols - startCol), true).text;
		let cursorDisplay = prefixText.length;
		cursorDisplay = Math.max(0, Math.min(cursorDisplay, visibleText.length));

		// Build line with fake cursor
		// Insert cursor character at cursor position
		const cursorGrapheme = segmenter.segment(visibleText.slice(cursorDisplay))[Symbol.iterator]().next().value;

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " ";
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";
		// Use inverse video to show cursor
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = reverse video, ESC[27m = normal

		// Clamp only the trailing text (measured in terminal cells), keeping the cursor marker intact.
		const beforeWidth = visibleWidth(beforeCursor);
		const cursorWidth = visibleWidth(atCursor);
		const remainingAfterWidth = Math.max(0, availableWidth - beforeWidth - cursorWidth);
		const clampedAfterCursor = sliceWithWidth(afterCursor, 0, remainingAfterWidth, true).text;
		const renderedNoMarker = beforeCursor + cursorChar + clampedAfterCursor;
		const textWithCursor = beforeCursor + marker + cursorChar + clampedAfterCursor;

		const visualLength = visibleWidth(renderedNoMarker);
		const pad = padding(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + pad;
		return [line];
	}
}
