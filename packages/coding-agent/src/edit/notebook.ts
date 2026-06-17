import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookCell {
	cell_type: NotebookCellType;
	source?: string | string[];
	metadata?: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: unknown[];
	[key: string]: unknown;
}

export interface NotebookDocument {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
	[key: string]: unknown;
}

const CELL_MARKER_RE = /^# %% \[(code|markdown|raw)\](?: cell:(\d+))?$/;

export function isNotebookPath(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".ipynb";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCellType(value: unknown): value is NotebookCellType {
	return value === "code" || value === "markdown" || value === "raw";
}

function sourceToText(source: string | string[] | undefined): string {
	if (source === undefined) return "";
	if (typeof source === "string") return source;
	return source.join("");
}

export function splitNotebookSource(content: string): string[] {
	if (content.length === 0) return [];
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function cloneCell(cell: NotebookCell): NotebookCell {
	return structuredClone(cell);
}

export function createNotebookCell(cellType: NotebookCellType, source: string): NotebookCell {
	const cell: NotebookCell = {
		cell_type: cellType,
		metadata: {},
		source: splitNotebookSource(source),
	};
	if (cellType === "code") {
		cell.execution_count = null;
		cell.outputs = [];
	}
	return cell;
}

export function createEmptyNotebook(): NotebookDocument {
	return {
		cells: [],
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5,
	};
}

export function serializeNotebookDocument(notebook: NotebookDocument): string {
	return JSON.stringify(notebook, null, 1);
}

function validateNotebook(value: unknown, displayPath: string): NotebookDocument {
	if (!isRecord(value)) {
		throw new Error(`Invalid notebook structure (expected object): ${displayPath}`);
	}
	if (!Array.isArray(value.cells)) {
		throw new Error(`Invalid notebook structure (missing cells array): ${displayPath}`);
	}
	for (let index = 0; index < value.cells.length; index++) {
		const cell = value.cells[index];
		if (!isRecord(cell) || !isCellType(cell.cell_type)) {
			throw new Error(`Invalid notebook cell ${index} in ${displayPath}`);
		}
	}
	return value as unknown as NotebookDocument;
}

export async function readNotebookDocument(absolutePath: string, displayPath: string): Promise<NotebookDocument> {
	try {
		return validateNotebook(await Bun.file(absolutePath).json(), displayPath);
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${displayPath}`);
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in notebook: ${displayPath}`);
		throw error;
	}
}

export function notebookToEditableText(notebook: NotebookDocument): string {
	return notebook.cells
		.map((cell, index) => {
			const source = sourceToText(cell.source);
			return source.length > 0
				? `# %% [${cell.cell_type}] cell:${index}\n${source}`
				: `# %% [${cell.cell_type}] cell:${index}`;
		})
		.join("\n");
}

interface ParsedVirtualCell {
	cellType: NotebookCellType;
	cellIndex?: number;
	source: string;
}

function parseVirtualCellMarker(line: string): { cellType: NotebookCellType; cellIndex?: number } | undefined {
	const match = CELL_MARKER_RE.exec(line);
	if (!match) return undefined;
	const cellType = match[1] as NotebookCellType;
	const cellIndexText = match[2];
	return {
		cellType,
		cellIndex: cellIndexText === undefined ? undefined : Number.parseInt(cellIndexText, 10),
	};
}

function linesToSourceText(lines: string[]): string {
	if (lines.length === 0) return "";
	return lines.join("\n");
}

function parseNotebookEditableText(text: string, displayPath: string): ParsedVirtualCell[] {
	const lines = text.length === 0 ? [] : text.split("\n");
	const cells: ParsedVirtualCell[] = [];
	let current: { cellType: NotebookCellType; cellIndex?: number; lines: string[] } | undefined;

	const flush = () => {
		if (!current) return;
		cells.push({
			cellType: current.cellType,
			cellIndex: current.cellIndex,
			source: linesToSourceText(current.lines),
		});
	};

	for (const line of lines) {
		const marker = parseVirtualCellMarker(line);
		if (marker) {
			flush();
			current = { ...marker, lines: [] };
			continue;
		}
		if (!current) {
			throw new Error(
				`Invalid notebook editable representation for ${displayPath}: expected first line to be "# %% [code] cell:0", "# %% [markdown] cell:0", or "# %% [raw] cell:0".`,
			);
		}
		current.lines.push(line);
	}
	flush();
	return cells;
}

export function applyNotebookEditableText(
	notebook: NotebookDocument,
	text: string,
	displayPath: string,
): NotebookDocument {
	const parsedCells = parseNotebookEditableText(text, displayPath);
	const usedOriginalCells = new Set<number>();
	const nextNotebook = structuredClone(notebook);
	nextNotebook.cells = parsedCells.map(parsedCell => {
		const originalIndex = parsedCell.cellIndex;
		const originalCell =
			originalIndex !== undefined &&
			originalIndex >= 0 &&
			originalIndex < notebook.cells.length &&
			!usedOriginalCells.has(originalIndex)
				? notebook.cells[originalIndex]
				: undefined;
		if (originalCell) {
			usedOriginalCells.add(originalIndex!);
			const cell = cloneCell(originalCell);
			cell.cell_type = parsedCell.cellType;
			cell.source = splitNotebookSource(parsedCell.source);
			if (parsedCell.cellType === "code") {
				cell.execution_count ??= null;
				cell.outputs ??= [];
			} else {
				delete cell.execution_count;
				delete cell.outputs;
			}
			return cell;
		}
		return createNotebookCell(parsedCell.cellType, parsedCell.source);
	});
	return nextNotebook;
}

export async function readEditableNotebookText(absolutePath: string, displayPath: string): Promise<string> {
	return notebookToEditableText(await readNotebookDocument(absolutePath, displayPath));
}

export async function serializeEditedNotebookText(
	absolutePath: string,
	displayPath: string,
	text: string,
): Promise<string> {
	let notebook: NotebookDocument;
	try {
		notebook = await readNotebookDocument(absolutePath, displayPath);
	} catch (error) {
		if (error instanceof Error && error.message === `File not found: ${displayPath}`) {
			notebook = createEmptyNotebook();
		} else {
			throw error;
		}
	}
	const nextNotebook = applyNotebookEditableText(notebook, text, displayPath);
	return JSON.stringify(nextNotebook, null, 1);
}
