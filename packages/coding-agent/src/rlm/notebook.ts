/**
 * RLM live notebook writer: appends executed cells to notebook.ipynb with a
 * single per-session write queue and atomic temp-file-then-rename writes, then
 * validates the persisted file via readNotebookDocument.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createEmptyNotebook,
	createNotebookCell,
	type NotebookDocument,
	readNotebookDocument,
	serializeNotebookDocument,
	splitNotebookSource,
} from "../edit/notebook";
import type { RlmCellResult } from "./types";

function buildCodeOutputs(result: RlmCellResult): unknown[] {
	const outputs: unknown[] = [];
	if (result.output.length > 0) {
		outputs.push({
			output_type: "stream",
			name: result.exitCode !== undefined && result.exitCode !== 0 ? "stderr" : "stdout",
			text: splitNotebookSource(result.output),
		});
	}
	for (const display of result.displayOutputs) {
		if (display.type === "image") {
			outputs.push({ output_type: "display_data", data: { [display.mimeType]: display.data }, metadata: {} });
		} else if (display.type === "json") {
			outputs.push({ output_type: "display_data", data: { "application/json": display.data }, metadata: {} });
		}
	}
	if (result.cancelled) {
		outputs.push({ output_type: "stream", name: "stderr", text: ["[cell cancelled]\n"] });
	}
	if (result.truncated) {
		outputs.push({ output_type: "stream", name: "stderr", text: ["[output truncated]\n"] });
	}
	return outputs;
}

export class RlmNotebookWriter {
	readonly #notebookPath: string;
	readonly #document: NotebookDocument;
	#queue: Promise<void> = Promise.resolve();

	constructor(notebookPath: string, initial?: NotebookDocument) {
		this.#notebookPath = notebookPath;
		this.#document = initial ?? createEmptyNotebook();
	}

	get document(): NotebookDocument {
		return this.#document;
	}

	get cellCount(): number {
		return this.#document.cells.length;
	}

	appendMarkdown(source: string): Promise<void> {
		this.#document.cells.push(createNotebookCell("markdown", source));
		return this.#enqueueWrite();
	}

	appendCode(code: string, result: RlmCellResult): Promise<void> {
		const cell = createNotebookCell("code", code);
		cell.execution_count = this.#nextExecutionCount();
		cell.outputs = buildCodeOutputs(result);
		this.#document.cells.push(cell);
		return this.#enqueueWrite();
	}

	/** Resolve once all queued writes have flushed. */
	flush(): Promise<void> {
		return this.#queue;
	}

	#nextExecutionCount(): number {
		let max = 0;
		for (const cell of this.#document.cells) {
			const count = cell.execution_count;
			if (typeof count === "number" && count > max) max = count;
		}
		return max + 1;
	}

	#enqueueWrite(): Promise<void> {
		const snapshot = serializeNotebookDocument(this.#document);
		this.#queue = this.#queue.then(() => this.#atomicWrite(snapshot));
		return this.#queue;
	}

	async #atomicWrite(content: string): Promise<void> {
		const dir = path.dirname(this.#notebookPath);
		const base = path.basename(this.#notebookPath);
		const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
		await Bun.write(tmp, content);
		try {
			await fs.rename(tmp, this.#notebookPath);
		} catch (error) {
			await fs.rm(tmp, { force: true });
			throw error;
		}
		// Post-write validation: surfaces corruption immediately.
		await readNotebookDocument(this.#notebookPath, this.#notebookPath);
	}
}
