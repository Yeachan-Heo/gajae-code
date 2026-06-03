import type { FileDiagnosticsResult } from "../lsp";
import { snapshotEqual, type VimBuffer } from "./buffer";
import { parseExCommand } from "./commands";
import { replayTokens } from "./parser";
import type {
	Position,
	VimBufferSnapshot,
	VimInputMode,
	VimKeyToken,
	VimLineRange,
	VimLoadedFile,
	VimPendingInput,
	VimRegister,
	VimSearchState,
	VimSelection,
	VimUndoEntry,
} from "./types";
import { clonePosition, maxPosition, minPosition, toPublicMode, VimInputError as VimError } from "./types";

export interface VimSaveResult {
	loaded: VimLoadedFile;
	diagnostics?: FileDiagnosticsResult;
}

export interface VimEngineCallbacks {
	beforeMutate: (buffer: VimBuffer) => Promise<void>;
	loadBuffer: (path: string) => Promise<VimLoadedFile>;
	saveBuffer: (buffer: VimBuffer, options?: { force?: boolean }) => Promise<VimSaveResult>;
}

interface PendingChange {
	before: VimBufferSnapshot;
	tokens: string[];
	moveCursorLeftOnEscape: boolean;
	inserted: boolean;
}

interface MotionResult {
	nextIndex: number;
	target: Position;
	inclusive?: boolean;
	linewise?: boolean;
	range?: { start: number; end: number; linewise?: boolean };
}

const WORD_CHAR = /[A-Za-z0-9_]/;
const DEFAULT_VIEWPORT_HEIGHT = 10;
const BRACKET_PAIRS = new Map<string, string>([
	["(", ")"],
	["[", "]"],
	["{", "}"],
	["<", ">"],
]);
const CLOSING_BRACKETS = new Map<string, string>(
	Array.from(BRACKET_PAIRS.entries()).map(([open, close]) => [close, open]),
);
const NOOP_Z_COMMANDS = new Set(["a", "A", "c", "C", "m", "M", "o", "O", "r", "R", "v", "x", "X"]);

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWhitespace(char: string): boolean {
	return /\s/.test(char);
}

function isWordChar(char: string): boolean {
	return WORD_CHAR.test(char);
}

function wordCategory(char: string, bigWord: boolean): "space" | "word" | "punct" {
	if (char.length === 0 || isWhitespace(char)) {
		return "space";
	}
	if (bigWord) {
		return "word";
	}
	return isWordChar(char) ? "word" : "punct";
}

function decodeReplacement(replacement: string): string {
	return replacement.replace(/\\\//g, "/").replace(/\\\\/g, "\\");
}

function literalTextToReplayTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const char of text) {
		if (char === "\n") {
			tokens.push("CR");
			continue;
		}
		if (char === "\t") {
			tokens.push("Tab");
			continue;
		}
		tokens.push(char);
	}
	return tokens;
}

// Convert a vim-style search pattern to a JavaScript RegExp.
// In vim's default ("magic") mode, (, ), {, }, |, + are literal unless backslash-escaped.
// In JS regex these are metacharacters. Swap the escaping so bare chars are literal
// and \( etc. become regex groups.
function vimPatternToJsRegex(pattern: string): string {
	return pattern.replace(/\\([(){}|+])|([(){}|+])/g, (_match, escaped, bare) => {
		if (escaped) return escaped; // \( -> ( (regex group)
		return `\\${bare}`; // ( -> \( (literal paren)
	});
}

function createSearchRegex(pattern: string, flags = "g"): RegExp {
	try {
		return new RegExp(vimPatternToJsRegex(pattern), flags);
	} catch {
		return new RegExp(escapeRegex(pattern), flags);
	}
}

function detectIndentUnit(lines: string[]): string {
	for (const line of lines) {
		if (line.startsWith("\t")) {
			return "\t";
		}
		if (line.startsWith("  ")) {
			return "  ";
		}
	}
	return "\t";
}

function normalizeRange(start: number, end: number): { start: number; end: number } {
	return {
		start: Math.min(start, end),
		end: Math.max(start, end),
	};
}

function selectionFromAnchor(buffer: VimBuffer, anchor: Position, linewise: boolean): VimSelection {
	if (linewise) {
		const startLine = Math.min(anchor.line, buffer.cursor.line);
		const endLine = Math.max(anchor.line, buffer.cursor.line);
		return {
			kind: "line",
			start: { line: startLine + 1, col: 1 },
			end: { line: endLine + 1, col: buffer.getLine(endLine).length + 1 },
		};
	}
	const start = minPosition(anchor, buffer.cursor);
	const end = maxPosition(anchor, buffer.cursor);
	return {
		kind: "char",
		start: { line: start.line + 1, col: start.col + 1 },
		end: { line: end.line + 1, col: end.col + 1 },
	};
}

function expandVisualOffsets(
	buffer: VimBuffer,
	anchor: Position,
	linewise: boolean,
): { start: number; end: number; linewise: boolean } {
	if (linewise) {
		const startLine = Math.min(anchor.line, buffer.cursor.line);
		const endLine = Math.max(anchor.line, buffer.cursor.line);
		const startOffset = buffer.positionToOffset({ line: startLine, col: 0 });
		const endOffset =
			endLine >= buffer.lastLineIndex()
				? buffer.getText().length
				: buffer.positionToOffset({ line: endLine + 1, col: 0 });
		return { start: startOffset, end: endOffset, linewise: true };
	}
	const anchorOffset = buffer.positionToOffset(anchor);
	const cursorOffset = buffer.positionToOffset(buffer.cursor);
	const { start, end } = normalizeRange(anchorOffset, cursorOffset);
	return { start, end: end + 1, linewise: false };
}

function nextWordStart(text: string, offset: number, bigWord: boolean): number {
	let index = Math.min(Math.max(offset, 0), text.length);
	if (index >= text.length) {
		return text.length;
	}

	const currentCategory = wordCategory(text[index] ?? "", bigWord);
	if (currentCategory === "space") {
		while (index < text.length && wordCategory(text[index] ?? "", bigWord) === "space") {
			index += 1;
		}
		return index;
	}

	while (index < text.length && wordCategory(text[index] ?? "", bigWord) === currentCategory) {
		index += 1;
	}
	while (index < text.length && wordCategory(text[index] ?? "", bigWord) === "space") {
		index += 1;
	}
	return index;
}

function previousWordStart(text: string, offset: number, bigWord: boolean): number {
	let index = Math.min(Math.max(offset - 1, 0), text.length);
	while (index > 0 && wordCategory(text[index] ?? "", bigWord) === "space") {
		index -= 1;
	}
	const category = wordCategory(text[index] ?? "", bigWord);
	while (index > 0 && wordCategory(text[index - 1] ?? "", bigWord) === category) {
		index -= 1;
	}
	return index;
}

function endOfWord(text: string, offset: number, bigWord: boolean): number {
	let index = Math.min(Math.max(offset, 0), text.length);
	while (index < text.length && wordCategory(text[index] ?? "", bigWord) === "space") {
		index += 1;
	}
	const category = wordCategory(text[index] ?? "", bigWord);
	while (index < text.length && wordCategory(text[index] ?? "", bigWord) === category) {
		index += 1;
	}
	return Math.max(0, index - 1);
}

function endOfPreviousWord(text: string, offset: number, bigWord: boolean): number {
	if (text.length === 0) {
		return 0;
	}

	let index = Math.min(Math.max(offset - 1, 0), text.length - 1);
	while (index >= 0 && wordCategory(text[index] ?? "", bigWord) === "space") {
		index -= 1;
	}
	if (index < 0) {
		return 0;
	}

	const currentCategory = wordCategory(text[index] ?? "", bigWord);
	while (index >= 0 && wordCategory(text[index] ?? "", bigWord) === currentCategory) {
		index -= 1;
	}
	while (index >= 0 && wordCategory(text[index] ?? "", bigWord) === "space") {
		index -= 1;
	}

	return Math.max(0, index);
}

function toggleCase(text: string): string {
	let toggled = "";
	for (const char of text) {
		if (char >= "a" && char <= "z") {
			toggled += char.toUpperCase();
			continue;
		}
		if (char >= "A" && char <= "Z") {
			toggled += char.toLowerCase();
			continue;
		}
		toggled += char;
	}
	return toggled;
}

function lastNonBlankColumn(line: string): number {
	for (let index = line.length - 1; index >= 0; index -= 1) {
		if (!isWhitespace(line[index] ?? "")) {
			return index;
		}
	}
	return 0;
}

function findParagraphStart(lines: string[], line: number): number {
	let index = Math.max(0, line - 1);
	while (index > 0 && lines[index]!.trim().length > 0) {
		index -= 1;
	}
	while (index > 0 && lines[index - 1]!.trim().length === 0) {
		index -= 1;
	}
	return index;
}

function findParagraphEnd(lines: string[], line: number): number {
	let index = Math.min(lines.length - 1, line + 1);
	while (index < lines.length - 1 && lines[index]!.trim().length > 0) {
		index += 1;
	}
	while (index < lines.length - 1 && lines[index + 1]!.trim().length === 0) {
		index += 1;
	}
	return index;
}

function cloneUndoStack(stack: VimUndoEntry[]): VimUndoEntry[] {
	return stack.map(entry => ({
		before: {
			...entry.before,
			lines: [...entry.before.lines],
			cursor: clonePosition(entry.before.cursor),
			baseFingerprint: entry.before.baseFingerprint ? { ...entry.before.baseFingerprint } : null,
		},
		after: {
			...entry.after,
			lines: [...entry.after.lines],
			cursor: clonePosition(entry.after.cursor),
			baseFingerprint: entry.after.baseFingerprint ? { ...entry.after.baseFingerprint } : null,
		},
	}));
}

export class VimEngine {
	buffer: VimBuffer;
	inputMode: VimInputMode = "normal";
	selectionAnchor: Position | null = null;
	register: VimRegister = { kind: "char", text: "" };
	lastSearch: VimSearchState | null = null;
	lastCharFind: { char: string; mode: "f" | "F" | "t" | "T" } | null = null;
	lastVisual: { anchor: Position; cursor: Position; mode: VimInputMode } | null = null;
	lastCommand?: string;
	statusMessage?: string;
	diagnostics?: FileDiagnosticsResult;
	viewportStart = 1;
	closed = false;

	#callbacks: VimEngineCallbacks;
	#undoStack: VimUndoEntry[] = [];
	#redoStack: VimUndoEntry[] = [];
	#pendingInput = "";
	#lastChangeTokens: string[] | null = null;
	#pendingChange: PendingChange | null = null;
	#stepCallback?: () => Promise<void>;

	constructor(buffer: VimBuffer, callbacks: VimEngineCallbacks) {
		this.buffer = buffer;
		this.#callbacks = callbacks;
	}

	clone(callbacks?: Partial<VimEngineCallbacks>): VimEngine {
		const next = new VimEngine(this.buffer.clone(), {
			beforeMutate: callbacks?.beforeMutate ?? this.#callbacks.beforeMutate,
			loadBuffer: callbacks?.loadBuffer ?? this.#callbacks.loadBuffer,
			saveBuffer: callbacks?.saveBuffer ?? this.#callbacks.saveBuffer,
		});
		next.inputMode = this.inputMode;
		next.selectionAnchor = this.selectionAnchor ? clonePosition(this.selectionAnchor) : null;
		next.register = { ...this.register };
		next.lastSearch = this.lastSearch ? { ...this.lastSearch } : null;
		next.lastCharFind = this.lastCharFind ? { ...this.lastCharFind } : null;
		next.lastVisual = this.lastVisual
			? {
					anchor: clonePosition(this.lastVisual.anchor),
					cursor: clonePosition(this.lastVisual.cursor),
					mode: this.lastVisual.mode,
				}
			: null;
		next.lastCommand = this.lastCommand;
		next.statusMessage = this.statusMessage;
		next.diagnostics = this.diagnostics;
		next.viewportStart = this.viewportStart;
		next.closed = this.closed;
		next.#pendingInput = this.#pendingInput;
		next.#lastChangeTokens = this.#lastChangeTokens ? [...this.#lastChangeTokens] : null;
		next.#pendingChange = this.#pendingChange
			? {
					before: {
						...this.#pendingChange.before,
						lines: [...this.#pendingChange.before.lines],
						cursor: clonePosition(this.#pendingChange.before.cursor),
						baseFingerprint: this.#pendingChange.before.baseFingerprint
							? { ...this.#pendingChange.before.baseFingerprint }
							: null,
					},
					tokens: [...this.#pendingChange.tokens],
					moveCursorLeftOnEscape: this.#pendingChange.moveCursorLeftOnEscape,
					inserted: this.#pendingChange.inserted,
				}
			: null;
		next.#undoStack = cloneUndoStack(this.#undoStack);
		next.#redoStack = cloneUndoStack(this.#redoStack);
		return next;
	}

	getPublicMode() {
		return toPublicMode(this.inputMode);
	}

	getSelection(): VimSelection | undefined {
		if (this.selectionAnchor === null) {
			return undefined;
		}
		return selectionFromAnchor(this.buffer, this.selectionAnchor, this.inputMode === "visual-line");
	}

	getPendingInput(): VimPendingInput | undefined {
		switch (this.inputMode) {
			case "insert":
				return { kind: "insert", text: "" };
			case "command":
			case "search-forward":
			case "search-backward":
				return { kind: this.inputMode, text: this.#pendingInput };
			default:
				return undefined;
		}
	}

	rollbackPendingInsert(): void {
		if (this.#pendingChange) {
			this.buffer.restore(this.#pendingChange.before);
			this.#pendingChange = null;
		}
		this.inputMode = "normal";
		this.selectionAnchor = null;
		this.#pendingInput = "";
	}

	setCursor(line: number, col: number): void {
		this.buffer.setCursor({ line, col });
	}

	async executeTokens(
		tokens: readonly VimKeyToken[],
		lastCommand?: string,
		onStep?: () => Promise<void>,
	): Promise<void> {
		const previousStepCallback = this.#stepCallback;
		this.#stepCallback = onStep ?? previousStepCallback;
		this.lastCommand = lastCommand;
		this.statusMessage = undefined;
		this.diagnostics = undefined;

		try {
			for (let index = 0; index < tokens.length; ) {
				switch (this.inputMode) {
					case "insert":
						index = await this.#executeInsert(tokens, index);
						break;
					case "command":
					case "search-forward":
					case "search-backward":
						index = await this.#executePrompt(tokens, index);
						break;
					case "visual":
					case "visual-line":
						index = await this.#executeVisual(tokens, index);
						break;
					default:
						index = await this.#executeNormal(tokens, index);
						break;
				}
				if (this.closed) {
					break;
				}
				this.#ensureCursorVisible();
				await this.#stepCallback?.();
			}
		} finally {
			this.#stepCallback = previousStepCallback;
		}
	}

	async close(force: boolean): Promise<void> {
		if (this.buffer.modified && !force) {
			throw new VimError("Unsaved changes; use force to discard");
		}
		this.closed = true;
		this.statusMessage = `Closed ${this.buffer.displayPath}`;
	}

	#ensureCursorVisible(): void {
		const line = this.buffer.cursor.line + 1;
		if (line < this.viewportStart) {
			this.viewportStart = line;
			return;
		}
		const viewportEnd = this.viewportStart + DEFAULT_VIEWPORT_HEIGHT - 1;
		if (line > viewportEnd) {
			this.viewportStart = Math.max(1, line - DEFAULT_VIEWPORT_HEIGHT + 1);
		}
	}

	centerViewportOnCursor(size = DEFAULT_VIEWPORT_HEIGHT): void {
		const lineCount = Math.max(this.buffer.lineCount(), 1);
		const clampedSize = Math.max(1, Math.min(size, lineCount));
		const maxStart = Math.max(1, lineCount - clampedSize + 1);
		this.viewportStart = Math.max(1, Math.min(this.buffer.cursor.line + 1 - Math.floor(clampedSize / 2), maxStart));
	}

	#clearSelection(): void {
		if (this.selectionAnchor && (this.inputMode === "visual" || this.inputMode === "visual-line")) {
			this.lastVisual = {
				anchor: clonePosition(this.selectionAnchor),
				cursor: clonePosition(this.buffer.cursor),
				mode: this.inputMode,
			};
		}
		this.selectionAnchor = null;
		if (this.inputMode === "visual" || this.inputMode === "visual-line") {
			this.inputMode = "normal";
		}
	}

	async #ensureEditable(): Promise<void> {
		await this.#callbacks.beforeMutate(this.buffer);
		this.diagnostics = undefined;
		this.statusMessage = undefined;
	}

	#pushUndo(entry: VimUndoEntry, changeTokens?: readonly string[]): void {
		if (snapshotEqual(entry.before, entry.after)) {
			return;
		}
		this.#undoStack.push(entry);
		this.#redoStack = [];
		if (changeTokens && changeTokens.length > 0) {
			this.#lastChangeTokens = [...changeTokens];
		}
	}

	#beginPendingChange(prefixTokens: readonly string[], moveCursorLeftOnEscape: boolean): void {
		this.#pendingChange = {
			before: this.buffer.createSnapshot(),
			tokens: [...prefixTokens],
			moveCursorLeftOnEscape,
			inserted: false,
		};
	}

	#markPendingInserted(): void {
		if (this.#pendingChange) {
			this.#pendingChange.inserted = true;
		}
	}

	#commitPendingChange(): void {
		if (!this.#pendingChange) {
			return;
		}
		const entry: VimUndoEntry = {
			before: this.#pendingChange.before,
			after: this.buffer.createSnapshot(),
		};
		this.#pushUndo(entry, this.#pendingChange.tokens);
		this.#pendingChange = null;
	}

	async #applyAtomicChange(tokens: readonly string[], mutator: () => void): Promise<void> {
		await this.#ensureEditable();
		const before = this.buffer.createSnapshot();
		mutator();
		this.buffer.modified = true;
		this.#pushUndo({ before, after: this.buffer.createSnapshot() }, tokens);
	}

	async #startInsertChange(
		tokens: readonly string[],
		mutator?: () => void,
		moveCursorLeftOnEscape = true,
	): Promise<void> {
		await this.#ensureEditable();
		this.#beginPendingChange(tokens, moveCursorLeftOnEscape);
		mutator?.();
		this.buffer.modified = true;
		this.inputMode = "insert";
	}

	async #executePrompt(tokens: readonly VimKeyToken[], index: number): Promise<number> {
		const token = tokens[index]!;
		if (token.value === "Esc") {
			this.#pendingInput = "";
			this.inputMode = "normal";
			return index + 1;
		}
		if (token.value === "BS") {
			this.#pendingInput = this.#pendingInput.slice(0, -1);
			return index + 1;
		}
		if (token.value !== "CR") {
			this.#pendingInput += token.value === "Tab" ? "\t" : token.value;
			return index + 1;
		}

		const input = this.#pendingInput;
		this.#pendingInput = "";
		const mode = this.inputMode;
		this.inputMode = "normal";
		if (mode === "command") {
			await this.#executeEx(input);
		} else {
			await this.#runSearch(input, mode === "search-forward" ? 1 : -1, true);
		}
		return index + 1;
	}

	#exitInsertMode(): void {
		if (this.#pendingChange) {
			this.#pendingChange.tokens.push("Esc");
			if (this.#pendingChange.moveCursorLeftOnEscape && this.#pendingChange.inserted && this.buffer.cursor.col > 0) {
				this.buffer.setCursor({ line: this.buffer.cursor.line, col: this.buffer.cursor.col - 1 });
			}
		}
		this.inputMode = "normal";
		this.#commitPendingChange();
	}

	async applyLiteralInsert(text: string, exitInsertMode: boolean): Promise<void> {
		if (this.inputMode !== "insert" || !this.#pendingChange) {
			throw new VimError("Insert payload requires INSERT mode.");
		}

		if (text.length > 0) {
			const offset = this.buffer.currentOffset();
			this.buffer.replaceOffsets(offset, offset, text, offset + text.length);
			this.buffer.modified = true;
			if (text.includes("\n")) {
				this.buffer.trailingNewline = this.buffer.trailingNewline || text.endsWith("\n");
			}
			this.#pendingChange.tokens.push(...literalTextToReplayTokens(text));
			this.#markPendingInserted();
		}

		if (exitInsertMode) {
			this.#exitInsertMode();
		}
	}

	async #executeInsert(tokens: readonly VimKeyToken[], index: number): Promise<number> {
		const token = tokens[index]!;
		if (token.value === "Esc") {
			this.#exitInsertMode();
			return index + 1;
		}
		if (token.value === "CR") {
			const offset = this.buffer.currentOffset();
			this.buffer.replaceOffsets(offset, offset, "\n", offset + 1);
			this.buffer.modified = true;
			this.buffer.trailingNewline = true;
			this.#pendingChange?.tokens.push(token.value);
			this.#markPendingInserted();
			return index + 1;
		}
		if (token.value === "BS") {
			const offset = this.buffer.currentOffset();
			if (offset > 0) {
				this.buffer.deleteOffsets(offset - 1, offset);
				this.buffer.modified = true;
				this.#pendingChange?.tokens.push(token.value);
				this.#markPendingInserted();
			}
			return index + 1;
		}
		if (token.value === "Tab") {
			const offset = this.buffer.currentOffset();
			this.buffer.replaceOffsets(offset, offset, "\t", offset + 1);
			this.buffer.modified = true;
			this.#pendingChange?.tokens.push(token.value);
			this.#markPendingInserted();
			return index + 1;
		}
		if (token.value === "C-w") {
			const offset = this.buffer.currentOffset();
			const text = this.buffer.getText();
			let start = previousWordStart(text, offset, false);
			if (start === offset && start > 0) {
				start -= 1;
			}
			this.buffer.deleteOffsets(start, offset);
			this.buffer.modified = true;
			this.#pendingChange?.tokens.push(token.value);
			this.#markPendingInserted();
			return index + 1;
		}
		if (token.value === "C-u") {
			const offset = this.buffer.currentOffset();
			const lineStart = this.buffer.positionToOffset({ line: this.buffer.cursor.line, col: 0 });
			if (offset > lineStart) {
				this.buffer.deleteOffsets(lineStart, offset);
				this.buffer.modified = true;
				this.#pendingChange?.tokens.push(token.value);
				this.#markPendingInserted();
			}
			return index + 1;
		}
		if (token.value === "C-o") {
			// Execute one normal-mode command, then return to insert
			const nextToken = tokens[index + 1];
			if (!nextToken) {
				return index + 1;
			}
			const savedMode = this.inputMode;
			this.inputMode = "normal";
			const nextIdx = await this.#executeNormal(tokens, index + 1);
			this.inputMode = savedMode;
			return nextIdx;
		}

		const insertText = token.value;
		const offset = this.buffer.currentOffset();
		this.buffer.replaceOffsets(offset, offset, insertText, offset + insertText.length);
		this.buffer.modified = true;
		this.#pendingChange?.tokens.push(token.value);
		this.#markPendingInserted();
		return index + 1;
	}

	async #executeVisual(tokens: readonly VimKeyToken[], index: number): Promise<number> {
		const token = tokens[index]!;
		if (token.value === "Esc") {
			this.#clearSelection();
			return index + 1;
		}
		if (token.value === "v") {
			if (this.inputMode === "visual") {
				this.#clearSelection();
			}
			return index + 1;
		}
		if (token.value === "V") {
			this.inputMode = this.inputMode === "visual-line" ? "visual" : "visual-line";
			return index + 1;
		}
		if (token.value === "o") {
			if (this.selectionAnchor) {
				const tmp = clonePosition(this.buffer.cursor);
				this.buffer.setCursor(this.selectionAnchor);
				this.selectionAnchor = tmp;
			}
			return index + 1;
		}
		if (token.value === "J") {
			const visual = expandVisualOffsets(
				this.buffer,
				this.selectionAnchor ?? this.buffer.cursor,
				this.inputMode === "visual-line",
			);
			const startLine = this.buffer.offsetToPosition(visual.start).line;
			const endLine = this.buffer.offsetToPosition(Math.max(visual.start, visual.end - 1)).line;
			await this.#applyAtomicChange(["J"], () => {
				this.buffer.joinLines(startLine, endLine - startLine);
			});
			this.#clearSelection();
			return index + 1;
		}
		if (token.value === "u" || token.value === "U") {
			const visual = expandVisualOffsets(
				this.buffer,
				this.selectionAnchor ?? this.buffer.cursor,
				this.inputMode === "visual-line",
			);
			await this.#applyAtomicChange([token.value], () => {
				const original = this.buffer.getText().slice(visual.start, visual.end);
				const transformed = token.value === "U" ? original.toUpperCase() : original.toLowerCase();
				this.buffer.replaceOffsets(visual.start, visual.end, transformed, visual.start);
			});
			this.#clearSelection();
			return index + 1;
		}
		if (token.value === "p" || token.value === "P") {
			const visual = expandVisualOffsets(
				this.buffer,
				this.selectionAnchor ?? this.buffer.cursor,
				this.inputMode === "visual-line",
			);
			await this.#applyAtomicChange([token.value], () => {
				const removed = this.buffer.getText().slice(visual.start, visual.end);
				const pasteText = this.register.text;
				this.buffer.replaceOffsets(visual.start, visual.end, pasteText, visual.start + pasteText.length);
				this.register = { kind: visual.linewise ? "line" : "char", text: removed };
			});
			this.#clearSelection();
			return index + 1;
		}
		if (token.value === "g") {
			const next = tokens[index + 1];
			if (!next) {
				throw new VimError("g requires a second key", token);
			}
			if (next.value === "J") {
				const visual = expandVisualOffsets(
					this.buffer,
					this.selectionAnchor ?? this.buffer.cursor,
					this.inputMode === "visual-line",
				);
				const startLine = this.buffer.offsetToPosition(visual.start).line;
				const endLine = this.buffer.offsetToPosition(Math.max(visual.start, visual.end - 1)).line;
				await this.#applyAtomicChange(["g", "J"], () => {
					const start = this.buffer.clampLine(startLine);
					const end = this.buffer.clampLine(endLine);
					if (start < end) {
						const joined = this.buffer.lines.slice(start, end + 1).join("");
						this.buffer.lines.splice(start, end - start + 1, joined);
						this.buffer.setCursor({ line: start, col: Math.max(0, joined.length - 1) });
					}
				});
				this.#clearSelection();
				return index + 2;
			}
			if (next.value === "u" || next.value === "U" || next.value === "~") {
				const visual = expandVisualOffsets(
					this.buffer,
					this.selectionAnchor ?? this.buffer.cursor,
					this.inputMode === "visual-line",
				);
				await this.#applyAtomicChange(["g", next.value], () => {
					const original = this.buffer.getText().slice(visual.start, visual.end);
					const transformed =
						next.value === "u"
							? original.toLowerCase()
							: next.value === "U"
								? original.toUpperCase()
								: toggleCase(original);
					this.buffer.replaceOffsets(visual.start, visual.end, transformed, visual.start);
				});
				this.#clearSelection();
				return index + 2;
			}
			throw new VimError(`Unsupported g command: g${next.display}`, next);
		}

		const { count, hasCount, nextIndex } = this.#readCount(tokens, index);
		const opToken = tokens[nextIndex];
		if (!opToken) {
			return nextIndex;
		}

		switch (opToken.value) {
			case "d":
			case "x":
			case "X":
			case "D":
			case "y":
			case "c":
			case "s":
			case "S":
			case "C":
			case ">":
			case "<":
			case "~": {
				const visual = expandVisualOffsets(
					this.buffer,
					this.selectionAnchor ?? this.buffer.cursor,
					this.inputMode === "visual-line",
				);
				const consumeExtraIndent =
					(opToken.value === ">" || opToken.value === "<") && tokens[nextIndex + 1]?.value === opToken.value;
				const operatorValue =
					opToken.value === "x" || opToken.value === "X" || opToken.value === "D"
						? "d"
						: opToken.value === "s" || opToken.value === "S" || opToken.value === "C"
							? "c"
							: opToken.value;
				const visualTokens = consumeExtraIndent ? [opToken.value, opToken.value] : [opToken.value];
				await this.#applyVisualOperator(operatorValue, visual, count, visualTokens);
				return nextIndex + visualTokens.length;
			}
			case "r": {
				const replacement = tokens[nextIndex + 1];
				if (replacement?.value.length !== 1) {
					throw new VimError("Visual replace requires a literal character", opToken);
				}
				const visual = expandVisualOffsets(
					this.buffer,
					this.selectionAnchor ?? this.buffer.cursor,
					this.inputMode === "visual-line",
				);
				await this.#applyAtomicChange(["r", replacement.value], () => {
					const original = this.buffer.getText().slice(visual.start, visual.end);
					let replaced = "";
					for (const char of original) {
						replaced += char === "\n" ? "\n" : replacement.value;
					}
					this.buffer.replaceOffsets(visual.start, visual.end, replaced, visual.start);
				});
				this.#clearSelection();
				return nextIndex + 2;
			}
			default:
				break;
		}

		const motion = this.#resolveMotion(tokens, nextIndex, count, hasCount);
		this.buffer.setCursor(motion.target);
		return motion.nextIndex;
	}

	async #applyVisualOperator(
		operator: string,
		visual: { start: number; end: number; linewise: boolean },
		count: number,
		tokens: readonly string[],
	): Promise<void> {
		switch (operator) {
			case "y": {
				this.register = {
					kind: visual.linewise ? "line" : "char",
					text: this.buffer.getText().slice(visual.start, visual.end),
				};
				this.#clearSelection();
				this.statusMessage = `Yanked ${count} selection${count === 1 ? "" : "s"}`;
				return;
			}
			case "d": {
				await this.#applyAtomicChange(tokens, () => {
					this.#yankAndDeleteRange(visual);
				});
				this.#clearSelection();
				return;
			}
			case "c": {
				await this.#startInsertChange(tokens, () => {
					this.#yankAndDeleteRange(visual);
				});
				this.#clearSelection();
				return;
			}
			case ">":
			case "<": {
				const startLine = this.buffer.offsetToPosition(visual.start).line;
				const endLine = this.buffer.offsetToPosition(Math.max(visual.start, visual.end - 1)).line;
				await this.#applyAtomicChange(tokens, () => {
					this.buffer.indentLines(
						startLine,
						endLine,
						detectIndentUnit(this.buffer.lines),
						operator === ">" ? 1 : -1,
					);
				});
				this.#clearSelection();
				return;
			}
			case "~": {
				await this.#applyAtomicChange(tokens, () => {
					const original = this.buffer.getText().slice(visual.start, visual.end);
					this.buffer.replaceOffsets(visual.start, visual.end, toggleCase(original), visual.start);
				});
				this.#clearSelection();
				return;
			}
			default:
				throw new VimError(`Unsupported visual operator: ${operator}`);
		}
	}

	async #executeNormal(tokens: readonly VimKeyToken[], index: number): Promise<number> {
		const { count, hasCount, nextIndex } = this.#readCount(tokens, index);
		const token = tokens[nextIndex];
		if (!token) {
			return nextIndex;
		}

		switch (token.value) {
			case "h":
				this.buffer.setCursor({ line: this.buffer.cursor.line, col: this.buffer.cursor.col - count });
				return nextIndex + 1;
			case "j":
				this.buffer.setCursor({ line: this.buffer.cursor.line + count, col: this.buffer.cursor.col });
				return nextIndex + 1;
			case "k":
				this.buffer.setCursor({ line: this.buffer.cursor.line - count, col: this.buffer.cursor.col });
				return nextIndex + 1;
			case "l":
			case " ":
				this.buffer.setCursor({ line: this.buffer.cursor.line, col: this.buffer.cursor.col + count });
				return nextIndex + 1;
			case "w":
			case "W":
			case "b":
			case "B":
			case "e":
			case "E":
			case "0":
			case "$":
			case "^":
			case "|":
			case ";":
			case ",":
			case "G":
			case "f":
			case "F":
			case "t":
			case "T":
			case "{":
			case "}":
			case "%":
			case "H":
			case "M":
			case "+":
			case "-":
			case "_":
			case "L": {
				const motion = this.#resolveMotion(tokens, nextIndex, count, hasCount);
				this.buffer.setCursor(motion.target);
				return motion.nextIndex;
			}
			case "*":
			case "#": {
				const text = this.buffer.getText();
				const offset = this.buffer.currentOffset();
				const cat = wordCategory(text[offset] ?? "", false);
				if (cat === "space") {
					throw new VimError("No word under cursor", token);
				}
				let start = offset;
				while (start > 0 && wordCategory(text[start - 1] ?? "", false) === cat) start -= 1;
				let end = offset;
				while (end < text.length && wordCategory(text[end] ?? "", false) === cat) end += 1;
				const word = text.slice(start, end);
				const pattern = `\\b${escapeRegex(word)}\\b`;
				const direction = token.value === "*" ? 1 : -1;
				for (let step = 0; step < count; step += 1) {
					await this.#runSearch(pattern, direction, true);
				}
				return nextIndex + 1;
			}
			case "n":
				await this.#repeatSearch(this.lastSearch?.direction ?? 1, count);
				return nextIndex + 1;
			case "N":
				await this.#repeatSearch(((this.lastSearch?.direction ?? 1) * -1) as 1 | -1, count);
				return nextIndex + 1;
			case "/":
				this.inputMode = "search-forward";
				this.#pendingInput = "";
				return nextIndex + 1;
			case "?":
				this.inputMode = "search-backward";
				this.#pendingInput = "";
				return nextIndex + 1;
			case ":":
				this.inputMode = "command";
				this.#pendingInput = "";
				return nextIndex + 1;
			case "v":
				this.inputMode = "visual";
				this.selectionAnchor = clonePosition(this.buffer.cursor);
				return nextIndex + 1;
			case "V":
				this.inputMode = "visual-line";
				this.selectionAnchor = clonePosition(this.buffer.cursor);
				return nextIndex + 1;
			case "i":
				// When count > 1 (e.g. `2i`), interpret as `2Gi` — go to line N then insert.
				// Models confuse `Ni` with `NGi`; bare `i` with a high count is almost never intended.
				if (hasCount) {
					this.buffer.setCursor({ line: Math.min(count, this.buffer.lineCount()) - 1, col: 0 });
				}
				await this.#startInsertChange(["i"]);
				return nextIndex + 1;
			case "a":
				this.buffer.setCursor({ line: this.buffer.cursor.line, col: this.buffer.cursor.col + 1 });
				await this.#startInsertChange(["a"]);
				return nextIndex + 1;
			case "I":
				this.buffer.setCursor({
					line: this.buffer.cursor.line,
					col: this.buffer.firstNonBlank(this.buffer.cursor.line),
				});
				await this.#startInsertChange(["I"]);
				return nextIndex + 1;
			case "A":
				this.buffer.setCursor({
					line: this.buffer.cursor.line,
					col: this.buffer.getLine(this.buffer.cursor.line).length,
				});
				await this.#startInsertChange(["A"]);
				return nextIndex + 1;
			case "o":
				// When count > 1 (e.g. `13o`), interpret as `13Go` — go to line N then open below.
				// Models confuse `No` with `NGo`; bare `o` with a high count is almost never intended.
				if (hasCount) {
					this.buffer.setCursor({ line: Math.min(count, this.buffer.lineCount()) - 1, col: 0 });
				}
				await this.#startInsertChange(["o"], () => {
					const line = this.buffer.cursor.line + 1;
					this.buffer.insertLines(line, [""]);
				});
				return nextIndex + 1;
			case "O":
				if (hasCount) {
					this.buffer.setCursor({ line: Math.min(count, this.buffer.lineCount()) - 1, col: 0 });
				}
				await this.#startInsertChange(["O"], () => {
					const line = this.buffer.cursor.line;
					this.buffer.insertLines(line, [""]);
				});
				return nextIndex + 1;
			case "s":
				await this.#startInsertChange(["s"], () => {
					this.#deleteCharsForward(count);
				});
				return nextIndex + 1;
			case "S":
				await this.#changeWholeLines(count, ["S"]);
				return nextIndex + 1;
			case "x":
				await this.#applyAtomicChange(["x"], () => {
					this.#deleteCharsForward(count);
				});
				return nextIndex + 1;
			case "X":
				await this.#applyAtomicChange(["X"], () => {
					const end = this.buffer.currentOffset();
					const start = Math.max(0, end - count);
					this.register = { kind: "char", text: this.buffer.deleteOffsets(start, end) };
				});
				return nextIndex + 1;
			case "r": {
				const replacement = tokens[nextIndex + 1];
				if (replacement?.value.length !== 1) {
					throw new VimError("r requires a replacement character", token);
				}
				await this.#applyAtomicChange(["r", replacement.value], () => {
					const start = this.buffer.currentOffset();
					this.buffer.replaceOffsets(
						start,
						Math.min(this.buffer.getText().length, start + count),
						replacement.value.repeat(count),
						start,
					);
				});
				return nextIndex + 2;
			}
			case "~":
				await this.#applyAtomicChange(["~"], () => {
					const start = this.buffer.currentOffset();
					const end = Math.min(this.buffer.getText().length, start + count);
					const text = this.buffer.getText().slice(start, end);
					this.buffer.replaceOffsets(start, end, toggleCase(text), end);
				});
				return nextIndex + 1;
			case "J":
				await this.#applyAtomicChange(["J"], () => {
					this.buffer.joinLines(this.buffer.cursor.line, count);
				});
				return nextIndex + 1;
			case "p":
			case "P":
				await this.#applyAtomicChange([token.value], () => {
					this.#paste(token.value === "p", count);
				});
				return nextIndex + 1;
			case "u":
				await this.#undo(count);
				return nextIndex + 1;
			case "C-r":
				await this.#redo(count);
				return nextIndex + 1;
			case ".":
				await this.#repeatLastChange(count, token);
				return nextIndex + 1;
			case "d":
			case "c":
			case "y":
			case ">":
			case "<":
				return this.#executeOperator(tokens, nextIndex, count, hasCount, token.value);
			case "D":
				await this.#applyAtomicChange(["D"], () => {
					const start = this.buffer.currentOffset();
					const line = this.buffer.getLine(this.buffer.cursor.line);
					const end = start + (line.length - this.buffer.cursor.col);
					this.register = { kind: "char", text: this.buffer.deleteOffsets(start, end) };
				});
				return nextIndex + 1;
			case "C":
				await this.#startInsertChange(["C"], () => {
					const start = this.buffer.currentOffset();
					const line = this.buffer.getLine(this.buffer.cursor.line);
					const end = start + (line.length - this.buffer.cursor.col);
					this.register = { kind: "char", text: this.buffer.deleteOffsets(start, end) };
				});
				return nextIndex + 1;
			case "z": {
				const zTarget = tokens[nextIndex + 1];
				if (!zTarget) {
					throw new VimError("z requires a second key", token);
				}
				if (zTarget.value === "z") {
					this.centerViewportOnCursor();
				} else if (zTarget.value === "t" || zTarget.value === "CR") {
					this.viewportStart = this.buffer.cursor.line + 1;
					this.buffer.setCursor({
						line: this.buffer.cursor.line,
						col: this.buffer.firstNonBlank(this.buffer.cursor.line),
					});
				} else if (zTarget.value === "b" || zTarget.value === "-") {
					this.viewportStart = Math.max(1, this.buffer.cursor.line + 1 - (DEFAULT_VIEWPORT_HEIGHT - 1));
					this.buffer.setCursor({
						line: this.buffer.cursor.line,
						col: this.buffer.firstNonBlank(this.buffer.cursor.line),
					});
				} else if (zTarget.value === ".") {
					this.centerViewportOnCursor();
					this.buffer.setCursor({
						line: this.buffer.cursor.line,
						col: this.buffer.firstNonBlank(this.buffer.cursor.line),
					});
				} else if (NOOP_Z_COMMANDS.has(zTarget.value)) {
					this.statusMessage = `Ignored z${zTarget.display} (folds unsupported)`;
				} else {
					throw new VimError(`Unsupported z command: z${zTarget.display}`, zTarget);
				}
				return nextIndex + 2;
			}
			case "C-f":
				this.buffer.setCursor({
					line: this.buffer.cursor.line + Math.max(1, (DEFAULT_VIEWPORT_HEIGHT - 2) * count),
					col: this.buffer.cursor.col,
				});
				return nextIndex + 1;
			case "C-b":
				this.buffer.setCursor({
					line: this.buffer.cursor.line - Math.max(1, (DEFAULT_VIEWPORT_HEIGHT - 2) * count),
					col: this.buffer.cursor.col,
				});
				return nextIndex + 1;
			case "C-d":
				this.buffer.setCursor({
					line: this.buffer.cursor.line + Math.max(1, Math.floor(DEFAULT_VIEWPORT_HEIGHT / 2) * count),
					col: this.buffer.cursor.col,
				});
				return nextIndex + 1;
			case "C-u":
				this.buffer.setCursor({
					line: this.buffer.cursor.line - Math.max(1, Math.floor(DEFAULT_VIEWPORT_HEIGHT / 2) * count),
					col: this.buffer.cursor.col,
				});
				return nextIndex + 1;
			case "Esc":
				return nextIndex + 1;
			case "Y": {
				const start = this.buffer.cursor.line;
				const end = this.buffer.clampLine(start + count - 1);
				this.register = { kind: "line", text: this.buffer.lines.slice(start, end + 1).join("\n") };
				this.statusMessage = `Yanked ${end - start + 1} line${end === start ? "" : "s"}`;
				return nextIndex + 1;
			}
			case "R":
				await this.#startInsertChange(["R"], undefined, false);
				return nextIndex + 1;
			case "g": {
				const gNext = tokens[nextIndex + 1];
				if (!gNext) {
					throw new VimError("g requires a second key", token);
				}
				if (gNext.value === "g") {
					this.buffer.setCursor({ line: hasCount ? Math.max(0, count - 1) : 0, col: 0 });
					return nextIndex + 2;
				}
				if (gNext.value === "v") {
					if (this.lastVisual) {
						this.selectionAnchor = clonePosition(this.lastVisual.anchor);
						this.buffer.setCursor(this.lastVisual.cursor);
						this.inputMode = this.lastVisual.mode;
					}
					return nextIndex + 2;
				}
				if (gNext.value === "*" || gNext.value === "#") {
					const text = this.buffer.getText();
					const offset = this.buffer.currentOffset();
					const cat = wordCategory(text[offset] ?? "", false);
					if (cat === "space") {
						throw new VimError("No word under cursor", gNext);
					}
					let start = offset;
					while (start > 0 && wordCategory(text[start - 1] ?? "", false) === cat) start -= 1;
					let end = offset;
					while (end < text.length && wordCategory(text[end] ?? "", false) === cat) end += 1;
					const word = text.slice(start, end);
					const direction = gNext.value === "*" ? 1 : -1;
					for (let step = 0; step < count; step += 1) {
						await this.#runSearch(escapeRegex(word), direction, true);
					}
					return nextIndex + 2;
				}
				if (gNext.value === "U" || gNext.value === "u") {
					const caseOp = gNext.value;
					const {
						count: motionCount,
						hasCount: hasMotionCount,
						nextIndex: motionStart,
					} = this.#readCount(tokens, nextIndex + 2);
					const motionToken = tokens[motionStart];
					if (!motionToken) {
						throw new VimError(`g${caseOp} requires a motion`, gNext);
					}
					if ((motionToken.value === "U" && caseOp === "U") || (motionToken.value === "u" && caseOp === "u")) {
						const effectiveCount = hasMotionCount ? count * motionCount : count;
						await this.#applyAtomicChange(["g", caseOp, motionToken.value], () => {
							const start = this.buffer.cursor.line;
							const end = this.buffer.clampLine(start + effectiveCount - 1);
							for (let line = start; line <= end; line++) {
								const content = this.buffer.getLine(line);
								this.buffer.replaceLine(line, caseOp === "U" ? content.toUpperCase() : content.toLowerCase());
							}
						});
						return motionStart + 1;
					}
					const effectiveCount = hasMotionCount ? count * motionCount : count;
					const motion = this.#resolveMotion(tokens, motionStart, effectiveCount, hasCount || hasMotionCount);
					const range = this.#resolveMotionRange(motion);
					await this.#applyAtomicChange(
						tokens.slice(nextIndex, motion.nextIndex).map(tokenEntry => tokenEntry.value),
						() => {
							const text = this.buffer.getText();
							const slice = text.slice(range.start, range.end);
							const transformed = caseOp === "U" ? slice.toUpperCase() : slice.toLowerCase();
							this.buffer.replaceOffsets(range.start, range.end, transformed, range.start);
						},
					);
					return motion.nextIndex;
				}
				if (gNext.value === "~") {
					const {
						count: motionCount,
						hasCount: hasMotionCount,
						nextIndex: motionStart,
					} = this.#readCount(tokens, nextIndex + 2);
					const motionToken = tokens[motionStart];
					if (!motionToken) {
						throw new VimError("g~ requires a motion", gNext);
					}
					if (motionToken.value === "~") {
						const effectiveCount = hasMotionCount ? count * motionCount : count;
						await this.#applyAtomicChange(["g", "~", motionToken.value], () => {
							const start = this.buffer.cursor.line;
							const end = this.buffer.clampLine(start + effectiveCount - 1);
							for (let line = start; line <= end; line += 1) {
								this.buffer.replaceLine(line, toggleCase(this.buffer.getLine(line)));
							}
						});
						return motionStart + 1;
					}
					const effectiveCount = hasMotionCount ? count * motionCount : count;
					const motion = this.#resolveMotion(tokens, motionStart, effectiveCount, hasCount || hasMotionCount);
					const range = this.#resolveMotionRange(motion);
					await this.#applyAtomicChange(
						tokens.slice(nextIndex, motion.nextIndex).map(tokenEntry => tokenEntry.value),
						() => {
							const text = this.buffer.getText();
							const slice = text.slice(range.start, range.end);
							this.buffer.replaceOffsets(range.start, range.end, toggleCase(slice), range.start);
						},
					);
					return motion.nextIndex;
				}
				if (gNext.value === "J") {
					await this.#applyAtomicChange(["g", "J"], () => {
						const start = this.buffer.clampLine(this.buffer.cursor.line);
						const end = this.buffer.clampLine(start + Math.max(count, 1));
						if (start < end) {
							const joined = this.buffer.lines.slice(start, end + 1).join("");
							this.buffer.lines.splice(start, end - start + 1, joined);
							this.buffer.setCursor({ line: start, col: Math.max(0, joined.length - 1) });
						}
					});
					return nextIndex + 2;
				}
				throw new VimError(`Unsupported g command: g${gNext.display}`, gNext);
			}
			case "Z": {
				const zNext = tokens[nextIndex + 1];
				if (!zNext) {
					throw new VimError("Z requires a second key", token);
				}
				if (zNext.value === "Z") {
					await this.#executeEx("wq");
					return nextIndex + 2;
				}
				if (zNext.value === "Q") {
					await this.#executeEx("q!");
					return nextIndex + 2;
				}
				throw new VimError(`Unsupported Z command: Z${zNext.display}`, zNext);
			}
			default:
				throw new VimError(`Unsupported command: ${token.display}`, token);
		}
	}

	async #repeatLastChange(count: number, token: VimKeyToken): Promise<void> {
		if (!this.#lastChangeTokens || this.#lastChangeTokens.length === 0) {
			throw new VimError("No previous change to repeat", token);
		}
		for (let index = 0; index < count; index += 1) {
			await this.executeTokens(replayTokens(this.#lastChangeTokens), ".");
		}
	}

	async #undo(count: number): Promise<void> {
		await this.#ensureEditable();
		let applied = 0;
		for (let index = 0; index < count; index += 1) {
			const entry = this.#undoStack.pop();
			if (!entry) {
				break;
			}
			this.#redoStack.push(entry);
			this.buffer.restore(entry.before);
			applied += 1;
		}
		this.inputMode = "normal";
		this.selectionAnchor = null;
		this.#pendingChange = null;
		this.statusMessage = `Undid ${applied} change${applied === 1 ? "" : "s"}`;
	}

	async #redo(count: number): Promise<void> {
		await this.#ensureEditable();
		let applied = 0;
		for (let index = 0; index < count; index += 1) {
			const entry = this.#redoStack.pop();
			if (!entry) {
				break;
			}
			this.#undoStack.push(entry);
			this.buffer.restore(entry.after);
			applied += 1;
		}
		this.inputMode = "normal";
		this.selectionAnchor = null;
		this.#pendingChange = null;
		this.statusMessage = `Redid ${applied} change${applied === 1 ? "" : "s"}`;
	}

	async #executeOperator(
		tokens: readonly VimKeyToken[],
		operatorIndex: number,
		operatorCount: number,
		hasOperatorCount: boolean,
		operator: string,
	): Promise<number> {
		const { count: motionCount, hasCount: hasMotionCount, nextIndex } = this.#readCount(tokens, operatorIndex + 1);
		const token = tokens[nextIndex];
		if (!token) {
			throw new VimError(`Operator ${operator} requires a motion`, tokens[operatorIndex]);
		}
		const hasAnyCount = hasOperatorCount || hasMotionCount;
		const effectiveCount = hasMotionCount ? operatorCount * motionCount : operatorCount;

		if (token.value === operator) {
			if (operator === "d") {
				await this.#applyAtomicChange([operator, operator], () => {
					const start = this.buffer.cursor.line;
					const removed = this.buffer.deleteLines(start, start + Math.max(1, effectiveCount) - 1);
					this.register = { kind: "line", text: removed.join("\n") };
				});
				return nextIndex + 1;
			}
			if (operator === "y") {
				const start = this.buffer.cursor.line;
				const end = this.buffer.clampLine(start + Math.max(1, effectiveCount) - 1);
				this.register = { kind: "line", text: this.buffer.lines.slice(start, end + 1).join("\n") };
				this.statusMessage = `Yanked ${end - start + 1} line${end === start ? "" : "s"}`;
				return nextIndex + 1;
			}
			if (operator === "c") {
				await this.#changeWholeLines(Math.max(1, effectiveCount), [operator, operator]);
				return nextIndex + 1;
			}
			if (operator === ">" || operator === "<") {
				await this.#applyAtomicChange([operator, operator], () => {
					this.buffer.indentLines(
						this.buffer.cursor.line,
						this.buffer.cursor.line + Math.max(1, effectiveCount) - 1,
						detectIndentUnit(this.buffer.lines),
						operator === ">" ? 1 : -1,
					);
				});
				return nextIndex + 1;
			}
		}

		if (token.value === "i" || token.value === "a") {
			const object = tokens[nextIndex + 1];
			if (!object) {
				throw new VimError(`Missing text object after ${operator}${token.value}`, token);
			}
			const textObject = this.#resolveTextObject(token.value === "i", object.value, object);
			await this.#applyOperatorToMotion(
				operator,
				{ nextIndex: nextIndex + 2, target: this.buffer.cursor, range: textObject },
				[operator, token.value, object.value],
			);
			return nextIndex + 2;
		}

		// In vim, `cw` and `cW` act like `ce` and `cE` (don't include trailing whitespace)
		const motionToken = tokens[nextIndex];
		let motion: MotionResult;
		if (operator === "c" && motionToken && (motionToken.value === "w" || motionToken.value === "W")) {
			const eMotionValue = motionToken.value === "w" ? "e" : "E";
			const syntheticTokens: readonly VimKeyToken[] = [
				...tokens.slice(0, nextIndex),
				{ ...motionToken, value: eMotionValue },
				...tokens.slice(nextIndex + 1),
			];
			motion = this.#resolveMotion(syntheticTokens, nextIndex, effectiveCount, hasAnyCount);
		} else {
			motion = this.#resolveMotion(tokens, nextIndex, effectiveCount, hasAnyCount);
		}
		await this.#applyOperatorToMotion(
			operator,
			motion,
			tokens.slice(operatorIndex, motion.nextIndex).map(tokenEntry => tokenEntry.value),
		);
		return motion.nextIndex;
	}

	async #applyOperatorToMotion(operator: string, motion: MotionResult, tokens: readonly string[]): Promise<void> {
		if (operator === "y") {
			const range = this.#resolveMotionRange(motion);
			this.register = {
				kind: range.linewise ? "line" : "char",
				text: this.buffer.getText().slice(range.start, range.end),
			};
			this.statusMessage = `Yanked ${range.linewise ? "line" : "selection"}`;
			return;
		}

		if (operator === ">" || operator === "<") {
			const range = this.#resolveMotionRange(motion);
			const startLine = this.buffer.offsetToPosition(range.start).line;
			const endLine = this.buffer.offsetToPosition(Math.max(range.start, range.end - 1)).line;
			await this.#applyAtomicChange(tokens, () => {
				this.buffer.indentLines(startLine, endLine, detectIndentUnit(this.buffer.lines), operator === ">" ? 1 : -1);
			});
			return;
		}

		if (operator === "d") {
			const range = this.#resolveMotionRange(motion);
			await this.#applyAtomicChange(tokens, () => {
				this.#yankAndDeleteRange(range);
			});
			return;
		}

		if (operator === "c") {
			const range = this.#resolveMotionRange(motion);
			await this.#startInsertChange(tokens, () => {
				this.#yankAndDeleteRange(range);
			});
			return;
		}
	}

	#yankAndDeleteRange(range: { start: number; end: number; linewise: boolean }): void {
		this.register = {
			kind: range.linewise ? "line" : "char",
			text: this.buffer.getText().slice(range.start, range.end),
		};
		this.buffer.deleteOffsets(range.start, range.end);
	}

	#deleteCharsForward(count: number): void {
		const start = this.buffer.currentOffset();
		this.register = {
			kind: "char",
			text: this.buffer.deleteOffsets(start, Math.min(this.buffer.getText().length, start + count)),
		};
	}

	async #changeWholeLines(count: number, tokens: readonly string[]): Promise<void> {
		await this.#startInsertChange(tokens, () => {
			const start = this.buffer.cursor.line;
			const end = this.buffer.clampLine(start + count - 1);
			const removed = this.buffer.lines.slice(start, end + 1);
			this.register = { kind: "line", text: removed.join("\n") };
			this.buffer.lines.splice(start, end - start + 1, "");
			if (this.buffer.lines.length === 0) {
				this.buffer.lines = [""];
			}
			this.buffer.setCursor({ line: Math.min(start, this.buffer.lastLineIndex()), col: 0 });
		});
	}

	#resolveMotionRange(motion: MotionResult): { start: number; end: number; linewise: boolean } {
		if (motion.range) {
			return {
				start: motion.range.start,
				end: motion.range.end,
				linewise: motion.range.linewise ?? false,
			};
		}

		if (motion.linewise) {
			const startLine = Math.min(this.buffer.cursor.line, motion.target.line);
			const endLine = Math.max(this.buffer.cursor.line, motion.target.line);
			const start = this.buffer.positionToOffset({ line: startLine, col: 0 });
			const end =
				endLine >= this.buffer.lastLineIndex()
					? this.buffer.getText().length
					: this.buffer.positionToOffset({ line: endLine + 1, col: 0 });
			return { start, end, linewise: true };
		}

		const from = this.buffer.positionToOffset(this.buffer.cursor);
		const to = this.buffer.positionToOffset(motion.target);
		const normalized = normalizeRange(from, to);
		return {
			start: normalized.start,
			end: normalized.end + (motion.inclusive === false ? 0 : 1),
			linewise: false,
		};
	}

	#resolveMotion(tokens: readonly VimKeyToken[], index: number, count: number, hasCount = true): MotionResult {
		const token = tokens[index];
		if (!token) {
			throw new VimError("Missing motion");
		}

		const text = this.buffer.getText();
		switch (token.value) {
			case "h":
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line, col: this.buffer.cursor.col - count },
				};
			case "j":
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line + count, col: this.buffer.cursor.col },
					linewise: true,
				};
			case "k":
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line - count, col: this.buffer.cursor.col },
					linewise: true,
				};
			case "l":
			case " ":
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line, col: this.buffer.cursor.col + count },
				};
			case "w":
			case "W": {
				let offset = this.buffer.currentOffset();
				for (let step = 0; step < count; step += 1) {
					offset = nextWordStart(text, step === 0 ? offset + 1 : offset, token.value === "W");
				}
				return { nextIndex: index + 1, target: this.buffer.offsetToPosition(offset), inclusive: false };
			}
			case "b":
			case "B": {
				let offset = this.buffer.currentOffset();
				for (let step = 0; step < count; step += 1) {
					offset = previousWordStart(text, offset, token.value === "B");
				}
				return { nextIndex: index + 1, target: this.buffer.offsetToPosition(offset) };
			}
			case "e":
			case "E": {
				let offset = this.buffer.currentOffset();
				for (let step = 0; step < count; step += 1) {
					offset = endOfWord(text, step === 0 ? offset : offset + 1, token.value === "E");
				}
				return { nextIndex: index + 1, target: this.buffer.offsetToPosition(offset) };
			}
			case "0":
				return { nextIndex: index + 1, target: { line: this.buffer.cursor.line, col: 0 } };
			case "^":
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line, col: this.buffer.firstNonBlank(this.buffer.cursor.line) },
				};
			case "|":
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line, col: Math.max(0, count - 1) },
				};
			case "$":
				return {
					nextIndex: index + 1,
					target: {
						line: this.buffer.cursor.line,
						col: Math.max(0, this.buffer.getLine(this.buffer.cursor.line).length - 1),
					},
				};
			case "+": {
				const targetLine = this.buffer.clampLine(this.buffer.cursor.line + count);
				return {
					nextIndex: index + 1,
					target: { line: targetLine, col: this.buffer.firstNonBlank(targetLine) },
					linewise: true,
				};
			}
			case "-": {
				const targetLine = this.buffer.clampLine(this.buffer.cursor.line - count);
				return {
					nextIndex: index + 1,
					target: { line: targetLine, col: this.buffer.firstNonBlank(targetLine) },
					linewise: true,
				};
			}
			case "_": {
				const targetLine = this.buffer.clampLine(this.buffer.cursor.line + (count - 1));
				return {
					nextIndex: index + 1,
					target: { line: targetLine, col: this.buffer.firstNonBlank(targetLine) },
					linewise: true,
				};
			}
			case "g": {
				const next = tokens[index + 1];
				if (!next) {
					throw new VimError("Unsupported g motion", token);
				}
				if (next.value === "g") {
					return {
						nextIndex: index + 2,
						target: { line: hasCount ? Math.max(0, count - 1) : 0, col: 0 },
						linewise: true,
					};
				}
				if (next.value === "e" || next.value === "E") {
					let offset = this.buffer.currentOffset();
					for (let step = 0; step < count; step += 1) {
						offset = endOfPreviousWord(text, offset, next.value === "E");
					}
					return { nextIndex: index + 2, target: this.buffer.offsetToPosition(offset) };
				}
				if (next.value === "_") {
					const targetLine = this.buffer.clampLine(this.buffer.cursor.line + (count - 1));
					return {
						nextIndex: index + 2,
						target: { line: targetLine, col: lastNonBlankColumn(this.buffer.getLine(targetLine)) },
					};
				}
				throw new VimError("Unsupported g motion", token);
			}
			case "G":
				return {
					nextIndex: index + 1,
					target: { line: hasCount ? count - 1 : this.buffer.lastLineIndex(), col: 0 },
					linewise: true,
				};
			case "f":
			case "F":
			case "t":
			case "T": {
				const searchToken = tokens[index + 1];
				if (searchToken?.value.length !== 1) {
					throw new VimError(`${token.value} requires a literal character`, token);
				}
				this.lastCharFind = { char: searchToken.value, mode: token.value as "f" | "F" | "t" | "T" };
				const line = this.buffer.getLine(this.buffer.cursor.line);
				const cursorCol = this.buffer.cursor.col;
				let matchIndex = -1;
				if (token.value === "f" || token.value === "t") {
					let start = cursorCol + 1;
					for (let step = 0; step < count; step += 1) {
						matchIndex = line.indexOf(searchToken.value, start);
						if (matchIndex === -1) break;
						start = matchIndex + 1;
					}
					if (matchIndex === -1) {
						throw new VimError(`Character not found: ${searchToken.value}`, searchToken);
					}
					if (token.value === "t") {
						matchIndex -= 1;
					}
				} else {
					let start = Math.max(0, cursorCol - 1);
					for (let step = 0; step < count; step += 1) {
						matchIndex = line.lastIndexOf(searchToken.value, start);
						if (matchIndex === -1) break;
						start = matchIndex - 1;
					}
					if (matchIndex === -1) {
						throw new VimError(`Character not found: ${searchToken.value}`, searchToken);
					}
					if (token.value === "T") {
						matchIndex += 1;
					}
				}
				return {
					nextIndex: index + 2,
					target: { line: this.buffer.cursor.line, col: Math.max(0, matchIndex) },
				};
			}
			case "{":
				return {
					nextIndex: index + 1,
					target: { line: findParagraphStart(this.buffer.lines, this.buffer.cursor.line), col: 0 },
					linewise: true,
				};
			case "}":
				return {
					nextIndex: index + 1,
					target: { line: findParagraphEnd(this.buffer.lines, this.buffer.cursor.line), col: 0 },
					linewise: true,
				};
			case "%": {
				const match = this.#findMatchingBracket();
				return { nextIndex: index + 1, target: match };
			}
			case "H":
				return {
					nextIndex: index + 1,
					target: { line: Math.max(0, this.viewportStart - 1), col: 0 },
					linewise: true,
				};
			case "M":
				return {
					nextIndex: index + 1,
					target: { line: Math.max(0, this.viewportStart - 1 + 20), col: 0 },
					linewise: true,
				};
			case "L":
				return {
					nextIndex: index + 1,
					target: { line: Math.max(0, this.viewportStart - 1 + 39), col: 0 },
					linewise: true,
				};
			case ";":
			case ",": {
				if (!this.lastCharFind) {
					throw new VimError(
						"No previous character search. If you meant an ex-command range like `:4,5d`, add the `:` prefix and `<CR>` suffix.",
						token,
					);
				}
				let mode = this.lastCharFind.mode;
				if (token.value === ",") {
					const reverseMap: Record<string, "f" | "F" | "t" | "T"> = { f: "F", F: "f", t: "T", T: "t" };
					mode = reverseMap[mode]!;
				}
				const line = this.buffer.getLine(this.buffer.cursor.line);
				const cursorCol = this.buffer.cursor.col;
				let matchIndex = -1;
				if (mode === "f" || mode === "t") {
					let start = cursorCol + 1;
					for (let step = 0; step < count; step += 1) {
						matchIndex = line.indexOf(this.lastCharFind.char, start);
						if (matchIndex === -1) break;
						start = matchIndex + 1;
					}
					if (matchIndex !== -1 && mode === "t") matchIndex -= 1;
				} else {
					let start = Math.max(0, cursorCol - 1);
					for (let step = 0; step < count; step += 1) {
						matchIndex = line.lastIndexOf(this.lastCharFind.char, start);
						if (matchIndex === -1) break;
						start = matchIndex - 1;
					}
					if (matchIndex !== -1 && mode === "T") matchIndex += 1;
				}
				if (matchIndex === -1) {
					throw new VimError(`Character not found: ${this.lastCharFind.char}`, token);
				}
				return {
					nextIndex: index + 1,
					target: { line: this.buffer.cursor.line, col: Math.max(0, matchIndex) },
				};
			}
			default:
				throw new VimError(`Unsupported motion: ${token.display}`, token);
		}
	}

	#resolveTextObject(
		inner: boolean,
		objectToken: string,
		sourceToken: VimKeyToken,
	): { start: number; end: number; linewise?: boolean } {
		if (objectToken === "w" || objectToken === "W") {
			return this.#resolveWordTextObject(inner, objectToken === "W");
		}
		if (objectToken === '"' || objectToken === "'" || objectToken === "`") {
			return this.#resolveQuoteTextObject(inner, objectToken, sourceToken);
		}

		if (objectToken === "p") {
			return this.#resolveParagraphTextObject(inner);
		}

		const normalized =
			objectToken === ")"
				? "("
				: objectToken === "}"
					? "{"
					: objectToken === "]"
						? "["
						: objectToken === ">"
							? "<"
							: objectToken;
		if (!BRACKET_PAIRS.has(normalized)) {
			throw new VimError(`Unsupported text object: ${objectToken}`, sourceToken);
		}
		return this.#resolveBracketTextObject(inner, normalized, sourceToken);
	}

	#resolveWordTextObject(inner: boolean, bigWord: boolean): { start: number; end: number } {
		const text = this.buffer.getText();
		const cursor = this.buffer.currentOffset();
		let start = cursor;
		if (wordCategory(text[start] ?? "", bigWord) === "space") {
			start = nextWordStart(text, start, bigWord);
		}
		const category = wordCategory(text[start] ?? "", bigWord);
		while (start > 0 && wordCategory(text[start - 1] ?? "", bigWord) === category) {
			start -= 1;
		}
		let end = start;
		while (end < text.length && wordCategory(text[end] ?? "", bigWord) === category) {
			end += 1;
		}
		if (!inner) {
			while (end < text.length && wordCategory(text[end] ?? "", bigWord) === "space") {
				end += 1;
			}
			while (start > 0 && wordCategory(text[start - 1] ?? "", bigWord) === "space") {
				start -= 1;
			}
		}
		return { start, end };
	}

	#resolveParagraphTextObject(inner: boolean): { start: number; end: number; linewise: boolean } {
		const lines = this.buffer.lines;
		const cursorLine = this.buffer.cursor.line;
		let start = cursorLine;
		let end = cursorLine;
		// Find paragraph boundaries (delimited by blank lines)
		if (lines[cursorLine]?.trim().length === 0) {
			// On a blank line: select contiguous blank lines
			while (start > 0 && lines[start - 1]!.trim().length === 0) start -= 1;
			while (end < lines.length - 1 && lines[end + 1]!.trim().length === 0) end += 1;
			if (!inner) {
				// Include following non-blank paragraph
				while (end < lines.length - 1 && lines[end + 1]!.trim().length > 0) end += 1;
			}
		} else {
			// On a non-blank line: select contiguous non-blank lines
			while (start > 0 && lines[start - 1]!.trim().length > 0) start -= 1;
			while (end < lines.length - 1 && lines[end + 1]!.trim().length > 0) end += 1;
			if (!inner) {
				// Include trailing blank lines
				while (end < lines.length - 1 && lines[end + 1]!.trim().length === 0) end += 1;
			}
		}
		const startOffset = this.buffer.positionToOffset({ line: start, col: 0 });
		const endOffset =
			end >= this.buffer.lastLineIndex()
				? this.buffer.getText().length
				: this.buffer.positionToOffset({ line: end + 1, col: 0 });
		return { start: startOffset, end: endOffset, linewise: true };
	}

	#resolveQuoteTextObject(inner: boolean, quote: string, sourceToken: VimKeyToken): { start: number; end: number } {
		const line = this.buffer.getLine(this.buffer.cursor.line);
		const col = this.buffer.cursor.col;
		const before = line.lastIndexOf(quote, col);
		const after = line.indexOf(quote, col + (line[col] === quote ? 1 : 0));
		if (before === -1 || after === -1 || before === after) {
			throw new VimError(`Quote text object not found for ${quote}`, sourceToken);
		}
		const startCol = inner ? before + 1 : before;
		const endCol = inner ? after : after + 1;
		return {
			start: this.buffer.positionToOffset({ line: this.buffer.cursor.line, col: startCol }),
			end: this.buffer.positionToOffset({ line: this.buffer.cursor.line, col: endCol }),
		};
	}

	#resolveBracketTextObject(inner: boolean, open: string, sourceToken: VimKeyToken): { start: number; end: number } {
		const close = BRACKET_PAIRS.get(open)!;
		const text = this.buffer.getText();
		const cursor = this.buffer.currentOffset();
		let start = -1;
		let depth = 0;
		for (let index = cursor; index >= 0; index -= 1) {
			const char = text[index] ?? "";
			if (char === close) {
				depth += 1;
			} else if (char === open) {
				if (depth === 0) {
					start = index;
					break;
				}
				depth -= 1;
			}
		}
		if (start === -1) {
			throw new VimError(`Text object ${open}${close} not found`, sourceToken);
		}
		let end = -1;
		depth = 0;
		for (let index = start; index < text.length; index += 1) {
			const char = text[index] ?? "";
			if (char === open) {
				depth += 1;
			} else if (char === close) {
				depth -= 1;
				if (depth === 0) {
					end = index;
					break;
				}
			}
		}
		if (end === -1) {
			throw new VimError(`Text object ${open}${close} not found`, sourceToken);
		}
		return {
			start: inner ? start + 1 : start,
			end: inner ? end : end + 1,
		};
	}

	#findMatchingBracket(): Position {
		const text = this.buffer.getText();
		const cursor = this.buffer.currentOffset();
		let offset = cursor;
		let char = text[offset] ?? "";
		if (!BRACKET_PAIRS.has(char) && !CLOSING_BRACKETS.has(char)) {
			offset += 1;
			char = text[offset] ?? "";
		}
		if (BRACKET_PAIRS.has(char)) {
			const close = BRACKET_PAIRS.get(char)!;
			let depth = 0;
			for (let index = offset; index < text.length; index += 1) {
				const current = text[index] ?? "";
				if (current === char) depth += 1;
				if (current === close) {
					depth -= 1;
					if (depth === 0) {
						return this.buffer.offsetToPosition(index);
					}
				}
			}
		}
		if (CLOSING_BRACKETS.has(char)) {
			const open = CLOSING_BRACKETS.get(char)!;
			let depth = 0;
			for (let index = offset; index >= 0; index -= 1) {
				const current = text[index] ?? "";
				if (current === char) depth += 1;
				if (current === open) {
					depth -= 1;
					if (depth === 0) {
						return this.buffer.offsetToPosition(index);
					}
				}
			}
		}
		throw new VimError("Matching bracket not found");
	}

	async #runSearch(pattern: string, direction: 1 | -1, updateState: boolean): Promise<void> {
		const text = this.buffer.getText();
		const regex = createSearchRegex(pattern, "g");
		const cursor = this.buffer.currentOffset();
		let matchOffset = -1;

		if (direction > 0) {
			regex.lastIndex = Math.min(text.length, cursor + 1);
			const match = regex.exec(text);
			if (match && match.index >= 0) {
				matchOffset = match.index;
			} else {
				regex.lastIndex = 0;
				const wrapMatch = regex.exec(text);
				if (wrapMatch && wrapMatch.index >= 0) {
					matchOffset = wrapMatch.index;
				}
			}
		} else {
			const matches = Array.from(text.matchAll(regex));
			for (let index = matches.length - 1; index >= 0; index -= 1) {
				const match = matches[index];
				if ((match.index ?? -1) < cursor) {
					matchOffset = match.index ?? -1;
					break;
				}
			}
			if (matchOffset === -1 && matches.length > 0) {
				matchOffset = matches[matches.length - 1]?.index ?? -1;
			}
		}

		if (matchOffset === -1) {
			throw new VimError(`Pattern not found: ${pattern}`);
		}

		this.buffer.setCursor(this.buffer.offsetToPosition(matchOffset));
		this.statusMessage = `${direction > 0 ? "/" : "?"}${pattern}`;
		if (updateState) {
			this.lastSearch = { pattern, direction };
		}
	}

	async #repeatSearch(direction: 1 | -1, count: number): Promise<void> {
		if (!this.lastSearch) {
			throw new VimError("No previous search");
		}
		for (let index = 0; index < count; index += 1) {
			await this.#runSearch(this.lastSearch.pattern, direction, false);
		}
		this.lastSearch = { pattern: this.lastSearch.pattern, direction };
	}

	#resolveExRange(
		range: VimLineRange | "all" | undefined,
		defaultStart: number,
		defaultEnd = defaultStart,
	): VimLineRange {
		const totalLines = Math.max(1, this.buffer.lineCount());
		if (range === "all") {
			return { start: 1, end: totalLines };
		}
		const next = range ?? { start: defaultStart, end: defaultEnd };
		const start = Math.max(1, Math.min(next.start, totalLines));
		const end = Math.max(start, Math.min(next.end, totalLines));
		return { start, end };
	}

	async #executeEx(input: string): Promise<void> {
		const command = parseExCommand(input, {
			currentLine: this.buffer.cursor.line + 1,
			lastLine: this.buffer.lineCount(),
		});
		switch (command.kind) {
			case "goto-line":
				this.buffer.setCursor({ line: Math.max(0, command.line - 1), col: 0 });
				this.statusMessage = `Line ${command.line}`;
				return;
			case "write": {
				const result = await this.#callbacks.saveBuffer(this.buffer, { force: command.force });
				this.buffer.markSaved(result.loaded);
				this.diagnostics = result.diagnostics;
				this.statusMessage = result.diagnostics
					? `Wrote ${this.buffer.displayPath} (${result.diagnostics.summary})`
					: `Wrote ${this.buffer.displayPath}`;
				this.#undoStack = [];
				this.#redoStack = [];
				return;
			}
			case "update":
				if (!this.buffer.modified) {
					this.statusMessage = `${this.buffer.displayPath} unchanged`;
					return;
				}
				await this.#executeEx(command.force ? "w!" : "w");
				return;
			case "write-quit":
				await this.#executeEx(command.force ? "w!" : "w");
				this.closed = true;
				this.statusMessage = `Wrote and closed ${this.buffer.displayPath}`;
				return;
			case "quit":
				if (this.buffer.modified && !command.force) {
					throw new VimError("Unsaved changes; use :q! to discard");
				}
				this.closed = true;
				this.statusMessage = `Closed ${this.buffer.displayPath}`;
				return;
			case "edit": {
				if (this.buffer.modified && !command.force) {
					throw new VimError("Unsaved changes; use :e! to reload or force open");
				}
				const next = await this.#callbacks.loadBuffer(command.path ?? this.buffer.displayPath);
				this.buffer.replaceLoadedFile(next);
				this.inputMode = "normal";
				this.selectionAnchor = null;
				this.#pendingInput = "";
				this.#pendingChange = null;
				this.#undoStack = [];
				this.#redoStack = [];
				this.statusMessage = command.path
					? `Opened ${this.buffer.displayPath}`
					: `Reloaded ${this.buffer.displayPath}`;
				return;
			}
			case "substitute": {
				const range = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				const startLine = range.start;
				const endLine = range.end;
				const regexFlags = command.flags.includes("i") ? "gi" : "g";
				const regex = createSearchRegex(command.pattern, regexFlags);
				let replacements = 0;
				await this.#applyAtomicChange([":substitute"], () => {
					for (let lineIndex = startLine - 1; lineIndex <= endLine - 1; lineIndex += 1) {
						const line = this.buffer.getLine(lineIndex);
						let lineReplacements = 0;
						const nextLine = line.replace(regex, match => {
							if (!command.flags.includes("g") && lineReplacements > 0) {
								return match;
							}
							lineReplacements += 1;
							replacements += 1;
							return decodeReplacement(command.replacement).replace(/&/g, match);
						});
						this.buffer.replaceLine(lineIndex, nextLine);
						regex.lastIndex = 0;
					}
				});
				if (replacements === 0) {
					throw new VimError(`Pattern not found: ${command.pattern}`);
				}
				this.statusMessage = `${replacements} substitution${replacements === 1 ? "" : "s"}`;
				return;
			}
			case "delete": {
				const range = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				await this.#applyAtomicChange([":delete"], () => {
					const removed = this.buffer.deleteLines(range.start - 1, range.end - 1);
					this.register = { kind: "line", text: removed.join("\n") };
				});
				this.statusMessage = `Deleted ${range.end - range.start + 1} line${range.end === range.start ? "" : "s"}`;
				return;
			}
			case "yank": {
				const range = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				this.register = {
					kind: "line",
					text: this.buffer.lines.slice(range.start - 1, range.end).join("\n"),
				};
				this.statusMessage = `Yanked ${range.end - range.start + 1} line${range.end === range.start ? "" : "s"}`;
				return;
			}
			case "put": {
				if (!this.register.text) {
					this.statusMessage = "Register empty";
					return;
				}
				const anchorRange = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				const anchorLine = command.before ? anchorRange.start : anchorRange.end;
				const lines = this.register.text.split("\n");
				await this.#applyAtomicChange([":put"], () => {
					const insertAt = command.before
						? Math.max(0, anchorLine - 1)
						: Math.min(anchorLine, this.buffer.lineCount());
					this.buffer.insertLines(insertAt, lines);
				});
				this.statusMessage = `Put ${lines.length} line${lines.length === 1 ? "" : "s"}`;
				return;
			}
			case "copy": {
				const totalLines = this.buffer.lineCount();
				const range = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				const dest = Math.max(0, Math.min(command.destination, totalLines));
				await this.#applyAtomicChange([":copy"], () => {
					const lines = this.buffer.lines.slice(range.start - 1, range.end);
					this.buffer.insertLines(dest, lines);
				});
				this.statusMessage = `Copied ${range.end - range.start + 1} line${range.end === range.start ? "" : "s"}`;
				return;
			}
			case "move": {
				const totalLines = this.buffer.lineCount();
				const range = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				const dest = Math.max(0, Math.min(command.destination, totalLines));
				await this.#applyAtomicChange([":move"], () => {
					const lines = this.buffer.lines.splice(range.start - 1, range.end - range.start + 1);
					const adjustedDest = dest > range.end - 1 ? dest - lines.length : dest;
					this.buffer.lines.splice(adjustedDest, 0, ...lines);
					if (this.buffer.lines.length === 0) this.buffer.lines = [""];
					this.buffer.setCursor({ line: adjustedDest, col: 0 });
				});
				this.statusMessage = `Moved ${range.end - range.start + 1} line${range.end === range.start ? "" : "s"}`;
				return;
			}
			case "sort": {
				const range = this.#resolveExRange(command.range ?? "all", 1, this.buffer.lineCount());
				const startLine = range.start;
				const endLine = range.end;
				const reverse = command.flags.includes("!");
				const ignoreCase = command.flags.includes("i");
				await this.#applyAtomicChange([":sort"], () => {
					const slice = this.buffer.lines.slice(startLine - 1, endLine);
					slice.sort((a, b) => {
						const left = ignoreCase ? a.toLowerCase() : a;
						const right = ignoreCase ? b.toLowerCase() : b;
						return left < right ? -1 : left > right ? 1 : 0;
					});
					if (reverse) slice.reverse();
					for (let i = 0; i < slice.length; i++) {
						this.buffer.lines[startLine - 1 + i] = slice[i]!;
					}
				});
				this.statusMessage = `Sorted ${endLine - startLine + 1} line${endLine === startLine ? "" : "s"}`;
				return;
			}
			case "join": {
				const currentLine = this.buffer.cursor.line + 1;
				const baseRange = this.#resolveExRange(
					command.range,
					currentLine,
					command.range ? undefined : Math.min(this.buffer.lineCount(), currentLine + 1),
				);
				const startLine = baseRange.start;
				const endLine =
					baseRange.start === baseRange.end ? Math.min(this.buffer.lineCount(), baseRange.end + 1) : baseRange.end;
				const lineCount = endLine - startLine + 1;
				if (lineCount < 2) {
					this.statusMessage = "Nothing to join";
					return;
				}
				await this.#applyAtomicChange([":join"], () => {
					const startIndex = startLine - 1;
					if (command.trimWhitespace) {
						this.buffer.joinLines(startIndex, lineCount - 1);
						return;
					}
					const joined = this.buffer.lines.slice(startIndex, endLine).join("");
					this.buffer.lines.splice(startIndex, lineCount, joined);
					this.buffer.setCursor({ line: startIndex, col: Math.max(0, joined.length - 1) });
				});
				this.statusMessage = `Joined ${lineCount} lines`;
				return;
			}
			case "append": {
				const anchorRange = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				const anchorLine = anchorRange.end;
				const lines = command.text.length > 0 ? command.text.split("\n") : [""];
				await this.#applyAtomicChange([":append"], () => {
					const insertAt = Math.min(anchorLine, this.buffer.lineCount());
					this.buffer.insertLines(insertAt, lines);
				});
				this.statusMessage = `Appended ${lines.length} line${lines.length === 1 ? "" : "s"}`;
				return;
			}
			case "insert-before": {
				const anchorRange = this.#resolveExRange(command.range, this.buffer.cursor.line + 1);
				const anchorLine = anchorRange.start;
				const lines = command.text.length > 0 ? command.text.split("\n") : [""];
				await this.#applyAtomicChange([":insert"], () => {
					const insertAt = Math.max(0, anchorLine - 1);
					this.buffer.insertLines(insertAt, lines);
				});
				this.statusMessage = `Inserted ${lines.length} line${lines.length === 1 ? "" : "s"}`;
				return;
			}
			case "global": {
				const regex = createSearchRegex(command.pattern);
				const range = this.#resolveExRange(command.range ?? "all", 1, this.buffer.lineCount());
				await this.#applyAtomicChange([":global"], () => {
					const linesToProcess: number[] = [];
					for (let i = range.start - 1; i <= range.end - 1; i += 1) {
						const matches = regex.test(this.buffer.getLine(i));
						regex.lastIndex = 0;
						if (command.invert ? !matches : matches) {
							linesToProcess.push(i);
						}
					}
					if (command.command === "d" || command.command === "delete") {
						// Delete matching lines in reverse to preserve indices
						for (let i = linesToProcess.length - 1; i >= 0; i--) {
							this.buffer.lines.splice(linesToProcess[i]!, 1);
						}
						if (this.buffer.lines.length === 0) this.buffer.lines = [""];
						this.buffer.clampCursor();
						this.buffer.trailingNewline = true;
					} else {
						throw new VimError(`Unsupported :global sub-command: ${command.command}`);
					}
				});
				this.statusMessage = `Global: processed ${command.pattern}`;
				return;
			}
		}
	}

	#paste(after: boolean, count: number): void {
		if (!this.register.text) {
			return;
		}
		if (this.register.kind === "line") {
			const lines = this.register.text.split("\n");
			const insertAt = after ? this.buffer.cursor.line + 1 : this.buffer.cursor.line;
			for (let iteration = 0; iteration < count; iteration += 1) {
				this.buffer.insertLines(insertAt + iteration * lines.length, lines);
			}
			return;
		}
		const text = this.register.text.repeat(count);
		const offset = this.buffer.currentOffset() + (after ? 1 : 0);
		this.buffer.replaceOffsets(offset, offset, text, offset + text.length);
	}

	#readCount(tokens: readonly VimKeyToken[], index: number): { count: number; hasCount: boolean; nextIndex: number } {
		let cursor = index;
		let digits = "";
		while (cursor < tokens.length) {
			const value = tokens[cursor]?.value ?? "";
			if (!/^\d$/.test(value)) {
				break;
			}
			if (digits.length === 0 && value === "0") {
				break;
			}
			digits += value;
			cursor += 1;
		}
		return {
			count: digits.length > 0 ? Number.parseInt(digits, 10) : 1,
			hasCount: digits.length > 0,
			nextIndex: cursor,
		};
	}
}
