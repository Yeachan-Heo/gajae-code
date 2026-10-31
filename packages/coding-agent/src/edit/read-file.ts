/**
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file via Bun and rethrows ENOENT as a user-facing "File not found"
 * error referencing the display path.
 */

import * as fsSync from "node:fs";
import { isEnoent } from "@gajae-code/utils";
import { readFileTextInsideActiveWorkspace } from "../tools/path-utils";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook";

/**
 * Max byte size of a file the edit modes will load whole. Editing loads + normalizes +
 * fuzzy-matches + diffs the entire file on the main thread, so a multi-MB/generated file
 * would block the event loop (F19). Above this, fail fast with an actionable error.
 */
export const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

async function fileHasUtf8Bom(absolutePath: string): Promise<boolean> {
	const handle = await fsSync.promises.open(absolutePath, "r");
	try {
		const bytes = Buffer.alloc(UTF8_BOM.length);
		await handle.read(bytes, 0, UTF8_BOM.length, 0);
		return UTF8_BOM.every((byte, index) => bytes[index] === byte);
	} finally {
		await handle.close();
	}
}

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		const size = fsSync.statSync(absolutePath).size;
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
		const text = await readFileTextInsideActiveWorkspace(absolutePath);
		return (await fileHasUtf8Bom(absolutePath)) && !text.startsWith("\uFEFF") ? `\uFEFF${text}` : text;
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
