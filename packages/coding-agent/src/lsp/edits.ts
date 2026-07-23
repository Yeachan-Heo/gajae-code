import * as fs from "node:fs/promises";
import path from "node:path";
import { withEditPathMutation } from "../edit/path-mutation-lock";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { enforceTeamWriteScope } from "../tools/team-write-scope";
import { ToolError } from "../tools/tool-errors";
import type {
	CreateFile,
	DeleteFile,
	Position,
	Range,
	RenameFile,
	TextDocumentEdit,
	TextEdit,
	WorkspaceEdit,
} from "./types";
import { uriToFile } from "./utils";

// =============================================================================
// Text Edit Application
// =============================================================================

/**
 * Apply text edits to a string in-memory.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const lines = content.split("\n");

	// Sort edits in reverse order (bottom-to-top, right-to-left)
	const sortedEdits = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) {
			return b.range.start.line - a.range.start.line;
		}
		return b.range.start.character - a.range.start.character;
	});

	// Detect overlapping ranges: in reverse-sorted order, each edit's start
	// must be >= the next edit's end. If not, the edits would clobber each other
	// once applied bottom-up (typically a multi-server rename with stale positions).
	for (let i = 0; i < sortedEdits.length - 1; i++) {
		const later = sortedEdits[i].range;
		const earlier = sortedEdits[i + 1].range;
		if (comparePosition(earlier.end, later.start) > 0) {
			throw new ToolError(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; multi-server rename produced inconsistent edits`,
			);
		}
	}

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;

		// Single-line edit: replace substring within same line
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			// Multi-line edit: splice across multiple lines
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	return lines.join("\n");
}

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function formatRange(range: Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

/** True when two ranges overlap (share any position other than a touching boundary). */
export function rangesOverlap(a: Range, b: Range): boolean {
	return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

/**
 * Flatten a WorkspaceEdit's text edits into a Map<uri, TextEdit[]>.
 * Resource operations (create/rename/delete) are ignored — callers handle them separately.
 */
export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
	const out = new Map<string, TextEdit[]>();
	const push = (uri: string, edits: TextEdit[]) => {
		if (edits.length === 0) return;
		const prev = out.get(uri);
		if (prev) prev.push(...edits);
		else out.set(uri, [...edits]);
	};
	if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) push(uri, changes[uri]);
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const tdc = change as TextDocumentEdit;
				const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				push(tdc.textDocument.uri, textEdits);
			}
		}
	}
	return out;
}

/**
 * Apply text edits to a file.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export async function applyTextEdits(filePath: string, edits: TextEdit[], cwd: string): Promise<void> {
	await enforceTeamWriteScope({ cwd }, filePath);
	await withEditPathMutation([filePath], async () => {
		const content = await Bun.file(filePath).text();
		const result = applyTextEditsToString(content, edits);
		await Bun.write(filePath, result);
	});
}

// =============================================================================
// Workspace Edit Application
// =============================================================================

/**
 * Apply a workspace edit (collection of file changes).
 * Returns array of applied change descriptions.
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = [];

	// Coalesce all text edits per URI before applying so a single file's edits
	// are applied in one pass against a single snapshot — multiple TextDocumentEdits
	// for the same URI would otherwise read stale positions on subsequent writes.
	const textEditsByUri = flattenWorkspaceTextEdits(edit);
	for (const [uri, textEdits] of textEditsByUri) {
		const filePath = uriToFile(uri);
		await applyTextEdits(filePath, textEdits, cwd);
		applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
	}

	// Resource operations (create/rename/delete) preserve their original order.
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if (!("kind" in change) || !change.kind) continue;
			if (change.kind === "create") {
				const createOp = change as CreateFile;
				const filePath = uriToFile(createOp.uri);
				await enforceTeamWriteScope({ cwd }, filePath);
				await withEditPathMutation([filePath], async () => {
					await fs.mkdir(path.dirname(filePath), { recursive: true });
					const file = await fs.open(filePath, "wx");
					await file.close();
				});
				applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
			} else if (change.kind === "rename") {
				const renameOp = change as RenameFile;
				const oldPath = uriToFile(renameOp.oldUri);
				const newPath = uriToFile(renameOp.newUri);
				await enforceTeamWriteScope({ cwd }, oldPath);
				await enforceTeamWriteScope({ cwd }, newPath);
				await withEditPathMutation([oldPath, newPath], async () => {
					await fs.mkdir(path.dirname(newPath), { recursive: true });
					await fs.rename(oldPath, newPath);
				});
				applied.push(`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} → ${formatPathRelativeToCwd(newPath, cwd)}`);
			} else if (change.kind === "delete") {
				const deleteOp = change as DeleteFile;
				const filePath = uriToFile(deleteOp.uri);
				await enforceTeamWriteScope({ cwd }, filePath);
				await withEditPathMutation([filePath], () => fs.rm(filePath, { recursive: true }));
				applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
			}
		}
	}

	return applied;
}
