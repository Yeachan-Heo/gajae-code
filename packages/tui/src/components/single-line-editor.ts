import { BracketedPasteHandler } from "../bracketed-paste";
import { getKeybindings } from "../keybindings";
import { extractPrintableText } from "../keys";
import { KillRing } from "../kill-ring";
import { getSegmenter, getWordNavKind, moveWordLeft, moveWordRight, replaceTabs } from "../utils";

const segmenter = getSegmenter();

interface EditorState {
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

export interface SingleLineEditorHooks {
	/** Called whenever the value actually changes. */
	onEdit?: () => void;
	/** Called with the raw value on submit; the editor does not clear it. */
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	/** Secret inputs clear the value and edit history before notifying escape. */
	clearOnEscape?: boolean;
}

/**
 * Shared single-line editing engine for `Input` and `SecretInput`.
 *
 * Owns value/cursor, bracketed paste, the kill ring, and undo. Rendering stays
 * in the component so secret inputs can mask without ever exposing the buffer.
 */
export class SingleLineEditor {
	#value = "";
	#cursor = 0;
	#pasteHandler = new BracketedPasteHandler();
	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;
	#undoStack: EditorState[] = [];
	// The stack only appends during a yank chain; undo and resets end the chain.
	// Keep an index to the existing snapshot without retaining another value copy.
	#yankUndoIndex = -1;
	#hooks: SingleLineEditorHooks;

	constructor(hooks: SingleLineEditorHooks = {}) {
		this.#hooks = hooks;
	}

	get value(): string {
		return this.#value;
	}

	get cursor(): number {
		return this.#cursor;
	}

	setValue(value: string): void {
		const normalized = value.normalize("NFC");
		this.#value = normalized;
		this.#cursor = normalized.length;
		this.#lastAction = null;
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
		this.#killRing.clear();
		// BracketedPasteHandler intentionally keeps its buffer private. Replacing it
		// drops any in-progress paste without retaining it in this component.
		this.#pasteHandler = new BracketedPasteHandler();
	}

	handleInput(data: string): void {
		const paste =
			data === "\x1b" && !this.#pasteHandler.hasPendingFrame
				? ({ handled: false } as const)
				: this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.leading.length > 0) this.handleInput(paste.leading);
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) this.handleInput(paste.remaining);
			}
			return;
		}

		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			if (this.#hooks.clearOnEscape) this.clear();
			this.#hooks.onEscape?.();
			return;
		}

		if (kb.matches(data, "tui.editor.undo")) {
			this.#undo();
			return;
		}

		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			this.#hooks.onSubmit?.(this.#value);
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

		// Regular character input, including Kitty CSI-u text-producing sequences.
		const printableText = extractPrintableText(data);
		if (printableText) {
			this.#insertCharacter(printableText);
		}
	}

	#put(value: string, cursor: number): void {
		if (value !== this.#value) this.#hooks.onEdit?.();
		this.#value = value;
		this.#cursor = cursor;
	}

	#insertCharacter(text: string): void {
		const isWordChunk = [...segmenter.segment(text)].every(seg => getWordNavKind(seg.segment) !== "whitespace");
		// Undo coalescing: consecutive word typing coalesces into one undo unit.
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#pushUndo();
		}
		this.#lastAction = "type-word";

		const inserted = insertTextNfcAt(this.#value, this.#cursor, text);
		this.#put(inserted.value, inserted.cursor);
	}

	#handleBackspace(): void {
		this.#lastAction = null;
		if (this.#cursor <= 0) {
			return;
		}

		this.#pushUndo();

		const lastGrapheme = [...segmenter.segment(this.#value.slice(0, this.#cursor))].at(-1);
		const graphemeLength = lastGrapheme?.segment.length ?? 1;

		this.#put(
			this.#value.slice(0, this.#cursor - graphemeLength) + this.#value.slice(this.#cursor),
			this.#cursor - graphemeLength,
		);
	}

	#handleForwardDelete(): void {
		this.#lastAction = null;
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();

		const [firstGrapheme] = segmenter.segment(this.#value.slice(this.#cursor));
		const graphemeLength = firstGrapheme?.segment.length ?? 1;

		this.#put(this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + graphemeLength), this.#cursor);
	}

	#deleteToLineStart(): void {
		if (this.#cursor === 0) {
			return;
		}

		this.#pushUndo();
		this.#killRing.push(this.#value.slice(0, this.#cursor), {
			prepend: true,
			accumulate: this.#lastAction === "kill",
		});
		this.#lastAction = "kill";

		this.#put(this.#value.slice(this.#cursor), 0);
	}

	#deleteToLineEnd(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		this.#killRing.push(this.#value.slice(this.#cursor), {
			prepend: false,
			accumulate: this.#lastAction === "kill",
		});
		this.#lastAction = "kill";

		this.#put(this.#value.slice(0, this.#cursor), this.#cursor);
	}

	#deleteWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}

		// Save state before cursor movement (moveWordBackwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordBackwards();
		const deleteFrom = this.#cursor;
		this.#cursor = oldCursor;

		this.#killRing.push(this.#value.slice(deleteFrom, this.#cursor), { prepend: true, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#put(this.#value.slice(0, deleteFrom) + this.#value.slice(this.#cursor), deleteFrom);
	}

	#deleteWordForward(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		// Save state before cursor movement (moveWordForwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordForwards();
		const deleteTo = this.#cursor;
		this.#cursor = oldCursor;

		this.#killRing.push(this.#value.slice(this.#cursor, deleteTo), { prepend: false, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#put(this.#value.slice(0, this.#cursor) + this.#value.slice(deleteTo), this.#cursor);
	}

	#yank(): void {
		const text = this.#killRing.peek();
		if (!text) {
			return;
		}

		this.#pushUndo();
		this.#yankUndoIndex = this.#undoStack.length - 1;
		const inserted = insertTextNfcAt(this.#value, this.#cursor, text);
		this.#put(inserted.value, inserted.cursor);
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) {
			return;
		}

		const beforeYank = this.#undoStack[this.#yankUndoIndex];
		if (!beforeYank) return;
		this.#pushUndo();

		this.#put(beforeYank.value, beforeYank.cursor);

		this.#killRing.rotate();
		const text = this.#killRing.peek() ?? "";
		const inserted = insertTextNfcAt(this.#value, this.#cursor, text);
		this.#put(inserted.value, inserted.cursor);
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
		this.#put(snapshot.value, snapshot.cursor);
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

		// Clean the pasted text — remove newlines and carriage returns, normalize
		// tabs, AND normalize Unicode to NFC.
		//
		// NFC normalization rationale: macOS Finder drag-drops file paths in NFD
		// (Conjoining Jamo, U+1100..U+11FF). `Bun.stringWidth` counts each
		// conjoining jamo as a separate cell — a Korean syllable like `화` is
		// 1 char and 2 cells in NFC, but 2 chars and 3 cells in NFD (ᄒ=2 cells
		// + ᅪ=1 cell). The terminal renders the NFD sequence as a single
		// combined syllable (2 cells visible), so the width mismatch shows up
		// as cursor drift past the visible filename — N×~1.5 cells for a path
		// with N Korean syllables. NFC normalization at paste time stores the
		// value in the same form everything else in the codebase assumes.
		const cleanText = replaceTabs(pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "")).normalize(
			"NFC",
		);

		const inserted = insertTextNfcAt(this.#value, this.#cursor, cleanText);
		this.#put(inserted.value, inserted.cursor);
	}
}
