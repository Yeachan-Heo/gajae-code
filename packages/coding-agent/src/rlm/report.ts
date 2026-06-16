/**
 * Deterministic RLM report synthesis: turns the accumulated notebook (plus an
 * optional model-provided summary) into a Markdown research report.
 */
import type { NotebookCell, NotebookDocument } from "../edit/notebook";

export interface RlmReportInput {
	title: string;
	summary?: string;
	notebook: NotebookDocument;
	dataPath?: string | null;
	generatedAt?: string;
	maxOutputChars?: number;
}

function cellText(value: string | string[] | undefined): string {
	if (value === undefined) return "";
	return Array.isArray(value) ? value.join("") : value;
}

function streamOutputText(cell: NotebookCell): string {
	const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
	const parts: string[] = [];
	for (const out of outputs) {
		if (out && typeof out === "object" && (out as Record<string, unknown>).output_type === "stream") {
			parts.push(cellText((out as Record<string, unknown>).text as string | string[] | undefined));
		}
	}
	return parts.join("");
}

export function synthesizeRlmReport(input: RlmReportInput): string {
	const generatedAt = input.generatedAt ?? new Date().toISOString();
	const maxOutput = input.maxOutputChars ?? 4000;
	const codeCells = input.notebook.cells.filter(cell => cell.cell_type === "code");

	const lines: string[] = [];
	lines.push(`# ${input.title}`, "");
	lines.push(`- Generated: ${generatedAt}`);
	lines.push(`- Cells executed: ${codeCells.length}`);
	if (input.dataPath) {
		lines.push(`- Data context: ${input.dataPath}`);
	}
	lines.push("");

	if (input.summary && input.summary.trim().length > 0) {
		lines.push("## Summary", "", input.summary.trim(), "");
	}

	lines.push("## Notebook", "");
	let codeIndex = 0;
	for (const cell of input.notebook.cells) {
		if (cell.cell_type === "markdown") {
			const text = cellText(cell.source).trim();
			if (text.length > 0) {
				lines.push(text, "");
			}
		} else if (cell.cell_type === "code") {
			codeIndex += 1;
			lines.push(`### Cell ${codeIndex}`, "", "```python", cellText(cell.source).trimEnd(), "```", "");
			const output = streamOutputText(cell).trimEnd();
			if (output.length > 0) {
				const shown = output.length > maxOutput ? `${output.slice(0, maxOutput)}\n... [truncated]` : output;
				lines.push("```", shown, "```", "");
			}
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}
