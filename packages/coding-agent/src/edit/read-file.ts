/**
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file via Bun and rethrows ENOENT as a user-facing "File not found"
 * error referencing the display path.
 */
import { isEnoent } from "@gajae-code/utils";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook";

/**
 * Max byte size of a file the edit modes will load whole. Editing loads + normalizes +
 * fuzzy-matches + diffs the entire file on the main thread, so a multi-MB/generated file
 * would block the event loop (F19). Above this, fail fast with an actionable error.
 */
export const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024;

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		const file = Bun.file(absolutePath);
		const size = file.size; // 0 for a missing file; the read below then throws ENOENT.
		if (size > MAX_EDIT_FILE_BYTES) {
			throw new Error(
				`File too large to edit safely: ${path} is ${size} bytes (limit ${MAX_EDIT_FILE_BYTES}). ` +
					`Editing loads and diffs the whole file on the main thread; make a more targeted change, ` +
					`split the file, or use a specialized tool.`,
			);
		}
		// Guard BEFORE the notebook fast-path: a >8 MiB .ipynb would otherwise load + JSON-parse
		// + convert the whole file via readEditableNotebookText, bypassing the F19 freeze guard.
		if (isNotebookPath(absolutePath)) return await readEditableNotebookText(absolutePath, path);
		return await file.text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

export async function serializeEditFileText(absolutePath: string, path: string, content: string): Promise<string> {
	if (isNotebookPath(absolutePath)) return serializeEditedNotebookText(absolutePath, path, content);
	return content;
}
