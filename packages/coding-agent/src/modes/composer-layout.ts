export interface ComposerLayoutInput {
	terminalRows: number;
	editorRows: number;
	statusRows: number;
	widgetRowsAbove: number;
	widgetRowsBelow: number;
	autocompleteRows: number;
}

export interface ComposerLayout {
	transcriptRows: number;
	editorMaxRows: number;
	statusRows: number;
	widgetRowsAbove: number;
	widgetRowsBelow: number;
	autocompleteRows: number;
}

const EDITOR_MIN_ROWS = 3;
export const EDITOR_MAX_ROWS = 18;

function rows(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Allocate terminal rows without depending on component state. The editor gets
 * enough border-inclusive space for one cursor-bearing content row even when
 * the terminal is smaller than its chrome. Measured status and widget rows are
 * treated as fixed, conservative reservations; autocomplete consumes only
 * otherwise available space and leaves a transcript row whenever possible.
 */
export function allocateComposerLayout(input: ComposerLayoutInput): ComposerLayout {
	const terminalRows = rows(input.terminalRows);
	const statusRows = rows(input.statusRows);
	const widgetRowsAbove = rows(input.widgetRowsAbove);
	const widgetRowsBelow = rows(input.widgetRowsBelow);
	const fixedChromeRows = statusRows + widgetRowsAbove + widgetRowsBelow;
	const measuredEditorRows = Math.max(EDITOR_MIN_ROWS, rows(input.editorRows));
	const editorMaxRows = Math.max(
		EDITOR_MIN_ROWS,
		Math.min(EDITOR_MAX_ROWS, measuredEditorRows, Math.max(EDITOR_MIN_ROWS, terminalRows - fixedChromeRows)),
	);
	const remainingRows = Math.max(0, terminalRows - fixedChromeRows - editorMaxRows);
	const requestedAutocompleteRows = rows(input.autocompleteRows);
	const autocompleteRows = Math.min(requestedAutocompleteRows, Math.max(0, remainingRows - 1));
	const transcriptRows = Math.max(0, remainingRows - autocompleteRows);

	return {
		transcriptRows,
		editorMaxRows,
		statusRows,
		widgetRowsAbove,
		widgetRowsBelow,
		autocompleteRows,
	};
}
