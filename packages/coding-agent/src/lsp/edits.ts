import * as fs from "node:fs/promises";
import { formatPathRelativeToCwd } from "../tools/path-utils";
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
import {
	assertBatchStaysInside,
	assertRenamePaths,
	assertWorkspaceTarget,
	canonicalWorkspacePath,
	type PlannedResource,
	renameCheckedPaths,
	workspaceOperand,
} from "./workspace-path";

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

/** Read and apply edits in memory. Callers write only after every target has been staged. */
export async function stageTextEdits(filePath: string, edits: TextEdit[]): Promise<string> {
	const content = await Bun.file(filePath).text();
	return applyTextEditsToString(content, edits);
}

export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	await Bun.write(filePath, await stageTextEdits(filePath, edits));
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
	// Containment is checked for every target before the first write. The client
	// advertises textOnlyTransactional, so a later rejected URI must not leave
	// earlier text edits applied.
	const textEditsByUri = flattenWorkspaceTextEdits(edit);
	const textTargets: Array<{ filePath: string; textEdits: TextEdit[] }> = [];
	const textIndex = new Map<string, number>();
	for (const [uri, textEdits] of textEditsByUri) {
		const rawPath = uriToFile(uri);
		await assertWorkspaceTarget(cwd, rawPath);
		const filePath = await workspaceOperand(cwd, rawPath);
		const key = await canonicalWorkspacePath(cwd, rawPath);
		const at = textIndex.get(key);
		if (at === undefined) {
			textIndex.set(key, textTargets.length);
			textTargets.push({ filePath, textEdits: [...textEdits] });
		} else {
			textTargets[at].textEdits.push(...textEdits);
		}
	}

	const resourceOps = await resourceOpsOf(edit, cwd);

	// An earlier rename can retarget a relative symlink, including the directory
	// entry a later delete or create would mutate. Re-check that post-rename
	// namespace before any text or resource write.
	await assertBatchStaysInside(cwd, resourceOps);

	const stagedText: Array<{ filePath: string; textEdits: TextEdit[]; next: string }> = [];
	for (const target of textTargets) {
		stagedText.push({
			...target,
			next: await stageTextEdits(target.filePath, target.textEdits),
		});
	}
	for (const target of stagedText) {
		await Bun.write(target.filePath, target.next);
		applied.push(`Applied ${target.textEdits.length} edit(s) to ${formatPathRelativeToCwd(target.filePath, cwd)}`);
	}

	applied.push(...(await applyResourceOps(cwd, resourceOps)));

	return applied;
}

/** Resource operations from a workspace edit, each checked against the workspace before return. */
export async function resourceOpsOf(edit: WorkspaceEdit, cwd: string): Promise<PlannedResource[]> {
	const resourceOps: PlannedResource[] = [];
	if (!edit.documentChanges) return resourceOps;
	for (const change of edit.documentChanges) {
		if (!("kind" in change) || !change.kind) continue;
		if (change.kind === "create") {
			const filePath = uriToFile((change as CreateFile).uri);
			await assertWorkspaceTarget(cwd, filePath);
			resourceOps.push({ kind: "create", filePath });
		} else if (change.kind === "rename") {
			const renameOp = change as RenameFile;
			const oldPath = uriToFile(renameOp.oldUri);
			const newPath = uriToFile(renameOp.newUri);
			await assertRenamePaths(cwd, oldPath, newPath);
			resourceOps.push({ kind: "rename", oldPath, newPath });
		} else if (change.kind === "delete") {
			const filePath = uriToFile((change as DeleteFile).uri);
			await assertWorkspaceTarget(cwd, filePath);
			resourceOps.push({ kind: "delete", filePath });
		}
	}
	return resourceOps;
}

/**
 * Write resource operations that already passed `assertBatchStaysInside`.
 * Paths are workspace-absolute, so a relative URI cannot follow `process.cwd()`.
 * This does not re-check after the first mutation: a later containment rejection
 * has to happen before this function is called.
 */
export async function applyResourceOps(cwd: string, ops: PlannedResource[]): Promise<string[]> {
	const applied: string[] = [];
	for (const op of ops) {
		if (op.kind === "create") {
			const filePath = await workspaceOperand(cwd, op.filePath);
			await Bun.write(filePath, "");
			applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
		} else if (op.kind === "rename") {
			await renameCheckedPaths(cwd, op.oldPath, op.newPath);
			applied.push(
				`Renamed ${formatPathRelativeToCwd(op.oldPath, cwd)} → ${formatPathRelativeToCwd(op.newPath, cwd)}`,
			);
		} else {
			const filePath = await workspaceOperand(cwd, op.filePath);
			await fs.rm(filePath, { recursive: true });
			applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
		}
	}
	return applied;
}
