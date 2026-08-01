/** Faithful Codex file-change evidence for permission requests. */

import { generateUnifiedDiffString, replaceText } from "../edit/diff";
import { type ApplyPatchEntry, type ApplyPatchParams, expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { previewPatch } from "../edit/modes/patch";
import { normalizeToLF, stripBom } from "../edit/normalize";
import { readEditFileText } from "../edit/read-file";
import { resolveToCwd } from "../tools/path-utils";

/** A pinned Codex `FileChange` member as carried on a permission request. */
export type PermissionFileChange =
	| { type: "add"; content: string }
	| { type: "delete"; content: string }
	| { type: "update"; unified_diff: string; move_path: string | null };

export type PermissionFileChangeMap = Record<string, PermissionFileChange>;

type FileReadResult = { exists: true; content: string } | { exists: false };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(record: Record<string, unknown>, name: string): string | undefined {
	const value = record[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolvePath(value: unknown, cwd: string): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		return resolveToCwd(value, cwd);
	} catch {
		return undefined;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("File not found:");
}

async function readFile(path: string, displayPath: string): Promise<FileReadResult> {
	try {
		return { exists: true, content: await readEditFileText(path, displayPath) };
	} catch (error) {
		if (isMissingFileError(error)) return { exists: false };
		throw error;
	}
}

function normalizedContent(content: string): string {
	return normalizeToLF(stripBom(content).text);
}

function updateChange(oldContent: string, newContent: string, movePath?: string): PermissionFileChange {
	return {
		type: "update",
		unified_diff: generateUnifiedDiffString(normalizedContent(oldContent), normalizedContent(newContent)).diff,
		move_path: movePath ?? null,
	};
}

// `move_path` is required by the vendored Codex FileChange union, including for ordinary updates.

async function planWrite(args: unknown, cwd: string): Promise<PermissionFileChangeMap | undefined> {
	if (!isRecord(args)) return undefined;
	const path = resolvePath(args.path, cwd);
	const content = args.content;
	if (!path || typeof content !== "string") return undefined;

	const preimage = await readFile(path, String(args.path));
	if (!preimage.exists) return { [path]: { type: "add", content } };
	return { [path]: updateChange(preimage.content, content) };
}

async function planDelete(args: unknown, cwd: string): Promise<PermissionFileChangeMap | undefined> {
	if (!isRecord(args)) return undefined;
	const displayPath = stringProperty(args, "path");
	const path = resolvePath(displayPath, cwd);
	if (!displayPath || !path) return undefined;

	const preimage = await readFile(path, displayPath);
	if (!preimage.exists) return undefined;
	return { [path]: { type: "delete", content: preimage.content } };
}

async function planMove(args: unknown, cwd: string): Promise<PermissionFileChangeMap | undefined> {
	if (!isRecord(args)) return undefined;
	const oldPath = resolvePath(args.oldPath, cwd);
	const newPath = resolvePath(args.newPath, cwd);
	if (!oldPath || !newPath) return undefined;
	return { [oldPath]: { type: "update", unified_diff: "", move_path: newPath } };
}

async function planEdit(args: unknown, cwd: string): Promise<PermissionFileChangeMap | undefined> {
	if (!isRecord(args)) return undefined;
	if (typeof args.input === "string") return planApplyPatch(args, cwd);
	const displayPath = stringProperty(args, "path");
	if (!displayPath || !Array.isArray(args.edits) || args.edits.length === 0) return undefined;

	const edits = args.edits;
	const hasPatchShape = edits.some(
		edit =>
			isRecord(edit) && (Object.hasOwn(edit, "op") || Object.hasOwn(edit, "diff") || Object.hasOwn(edit, "rename")),
	);
	if (hasPatchShape) {
		// Patch-mode edit calls are executed entry-by-entry, but a destructive permission
		// intent is only representable here when the complete call is one patch operation.
		// Refuse mixed or multi-entry requests rather than showing incomplete evidence.
		if (edits.length !== 1 || !isRecord(edits[0])) return undefined;
		const entry = edits[0];
		const rawOp = entry.op;
		let op: ApplyPatchEntry["op"];
		if (rawOp === undefined) op = "update";
		else if (rawOp === "create" || rawOp === "delete" || rawOp === "update") op = rawOp;
		else return undefined;
		const rename = entry.rename;
		if (rename !== undefined && typeof rename !== "string") return undefined;
		const diff = entry.diff;
		if (diff !== undefined && typeof diff !== "string") return undefined;
		if (op === "delete" && rename !== undefined) return undefined;
		return planApplyPatchEntry(
			{
				path: displayPath,
				op,
				diff,
				rename,
			},
			cwd,
		);
	}

	const path = resolvePath(displayPath, cwd);
	if (!path) return undefined;
	const preimage = await readFile(path, displayPath);
	if (!preimage.exists) return undefined;

	const original = normalizedContent(preimage.content);
	let current = original;
	for (const edit of edits) {
		if (!isRecord(edit)) return undefined;
		const oldText = edit.old_text;
		const newText = edit.new_text;
		if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
		if (Object.hasOwn(edit, "all") && typeof edit.all !== "boolean") return undefined;

		const result = replaceText(current, normalizeToLF(oldText), normalizeToLF(newText), {
			fuzzy: true,
			all: typeof edit.all === "boolean" ? edit.all : false,
		});
		if (result.count === 0 || result.content === current) return undefined;
		current = result.content;
	}

	if (current === original) return undefined;
	return { [path]: updateChange(original, current) };
}

async function planApplyPatchEntry(entry: ApplyPatchEntry, cwd: string): Promise<PermissionFileChangeMap | undefined> {
	const path = resolvePath(entry.path, cwd);
	if (!path) return undefined;

	if (entry.op === "delete") {
		return planDelete({ path: entry.path }, cwd);
	}

	if (entry.op === "create") {
		if (typeof entry.diff !== "string") return undefined;
		const preimage = await readFile(path, entry.path);
		const preview = await previewPatch({ path: entry.path, op: "create", diff: entry.diff }, { cwd });
		const newContent = preview.change.newContent;
		if (typeof newContent !== "string") return undefined;
		if (!preimage.exists) return { [path]: { type: "add", content: newContent } };
		return { [path]: updateChange(preimage.content, newContent) };
	}

	if (entry.op !== undefined && entry.op !== "update") return undefined;
	if (typeof entry.diff !== "string") return undefined;
	const preimage = await readFile(path, entry.path);
	if (!preimage.exists) return undefined;
	const preview = await previewPatch(
		{ path: entry.path, op: "update", rename: entry.rename, diff: entry.diff },
		{ cwd },
	);
	const newContent = preview.change.newContent;
	if (typeof newContent !== "string") return undefined;
	const movePath = entry.rename === undefined ? undefined : resolvePath(entry.rename, cwd);
	if (entry.rename !== undefined && !movePath) return undefined;
	return { [path]: updateChange(preimage.content, newContent, movePath) };
}

async function planApplyPatch(args: unknown, cwd: string): Promise<PermissionFileChangeMap | undefined> {
	if (!isRecord(args) || typeof args.input !== "string") return undefined;

	let entries: ApplyPatchEntry[];
	try {
		entries = expandApplyPatchToEntries({ input: args.input } as ApplyPatchParams);
	} catch {
		return undefined;
	}
	if (entries.length === 0) return undefined;

	const changes: PermissionFileChangeMap = {};
	for (const entry of entries) {
		const planned = await planApplyPatchEntry(entry, cwd);
		if (!planned) return undefined;
		for (const [path, change] of Object.entries(planned)) {
			if (Object.hasOwn(changes, path)) return undefined;
			changes[path] = change;
		}
	}
	return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * Build a faithful pinned FileChange map for a mutation tool call, or undefined when
 * no honest representation is available (the caller then omits the field and the
 * app-server adapter fails closed).
 *
 * `ast_edit` is intentionally not projected: its AST mutation payload has no pinned
 * Codex FileChange equivalent. The reverse-provider permission seam gates that tool
 * and the adapter rejects the missing projection instead of allowing the mutation.
 */
export async function planPermissionFileChanges(
	toolName: string,
	args: unknown,
	cwd: string,
): Promise<PermissionFileChangeMap | undefined> {
	try {
		switch (toolName) {
			case "write":
				return await planWrite(args, cwd);
			case "delete":
				return await planDelete(args, cwd);
			case "move":
				return await planMove(args, cwd);
			case "edit":
				return await planEdit(args, cwd);
			case "apply_patch":
				return await planApplyPatch(args, cwd);
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}
