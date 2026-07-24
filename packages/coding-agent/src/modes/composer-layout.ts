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
 * Allocate terminal rows without depending on component state. The bordered
 * editor is the primary invariant: optional widgets are admitted only after
 * the editor, autocomplete, and (when possible) one transcript row fit.
 */
export function allocateComposerLayout(input: ComposerLayoutInput): ComposerLayout {
	const terminalRows = rows(input.terminalRows);
	const statusRows = rows(input.statusRows);
	const requestedWidgetRowsAbove = rows(input.widgetRowsAbove);
	const requestedWidgetRowsBelow = rows(input.widgetRowsBelow);
	const measuredEditorRows = Math.max(EDITOR_MIN_ROWS, rows(input.editorRows));
	const transcriptReserve = terminalRows > statusRows + EDITOR_MIN_ROWS ? 1 : 0;
	const editorMaxRows = Math.max(
		EDITOR_MIN_ROWS,
		Math.min(
			EDITOR_MAX_ROWS,
			measuredEditorRows,
			Math.max(EDITOR_MIN_ROWS, terminalRows - statusRows - transcriptReserve),
		),
	);
	let remainingRows = Math.max(0, terminalRows - statusRows - editorMaxRows);
	const requestedAutocompleteRows = rows(input.autocompleteRows);
	const autocompleteRows = Math.min(requestedAutocompleteRows, Math.max(0, remainingRows - transcriptReserve));
	remainingRows -= autocompleteRows;

	const optionalWidgetBudget = Math.max(0, remainingRows - transcriptReserve);
	const widgetRowsAbove = Math.min(requestedWidgetRowsAbove, optionalWidgetBudget);
	const widgetRowsBelow = Math.min(requestedWidgetRowsBelow, optionalWidgetBudget - widgetRowsAbove);
	const transcriptRows = Math.max(0, remainingRows - widgetRowsAbove - widgetRowsBelow);

	return {
		transcriptRows,
		editorMaxRows,
		statusRows,
		widgetRowsAbove,
		widgetRowsBelow,
		autocompleteRows,
	};
}
