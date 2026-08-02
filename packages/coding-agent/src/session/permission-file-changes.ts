import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { link, lstat, realpath } from "node:fs/promises";
import * as nodePath from "node:path";

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

/** Reverse-provider mutations refuse symlinked final entries; parent symlinks remain valid via canonical realpath. */
async function hasNoSymlinkPath(path: string): Promise<boolean> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
		return false;
	}
	if (info.isSymbolicLink()) return false;
	try {
		const parentRealPath = await realpath(nodePath.dirname(path));
		const targetRealPath = await realpath(path);
		return targetRealPath === nodePath.join(parentRealPath, nodePath.basename(path));
	} catch {
		return false;
	}
}

async function canonicalMissingPath(path: string): Promise<string | undefined> {
	try {
		return nodePath.join(await realpath(nodePath.dirname(path)), nodePath.basename(path));
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
	const path = resolvePath(displayPath, cwd);
	if (!displayPath || !path || !Array.isArray(args.edits) || args.edits.length === 0) return undefined;

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

export type PermissionFileChangeGuard = {
	validate(): Promise<void>;
	bind(args: unknown): Promise<{ args: unknown; release(): Promise<void> }>;
};

type PathIdentity = { path: string; exists: boolean; realPath: string; deviceAndInode?: string };

function identityKey(value: { dev: number | bigint; ino: number | bigint }): string {
	return `${String(value.dev)}:${String(value.ino)}`;
}

async function capturePathIdentity(path: string): Promise<PathIdentity | undefined> {
	if (!(await hasNoSymlinkPath(path))) return undefined;
	try {
		const info = await lstat(path);
		// Re-assert the symlink predicate on this exact stat: a link inserted between the
		// `hasNoSymlinkPath` check and here must not be captured as a legitimate identity.
		if (info.isSymbolicLink()) return undefined;
		return { path, exists: true, realPath: await realpath(path), deviceAndInode: identityKey(info) };
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
		const missingPath = await canonicalMissingPath(path);
		return missingPath === undefined ? undefined : { path, exists: false, realPath: missingPath };
	}
}

function mutationPaths(toolName: string, args: unknown, cwd: string): string[] | undefined {
	if (!isRecord(args)) return undefined;
	const paths: string[] = [];
	const push = (value: unknown): boolean => {
		const path = resolvePath(value, cwd);
		if (!path) return false;
		if (!paths.includes(path)) paths.push(path);
		return true;
	};
	if (toolName === "write" || toolName === "delete") return push(args.path) ? paths : undefined;
	if (toolName === "move") return push(args.oldPath) && push(args.newPath) ? paths : undefined;
	if (toolName !== "edit" && toolName !== "apply_patch") return undefined;
	if (typeof args.input === "string") {
		let entries: ApplyPatchEntry[];
		try {
			entries = expandApplyPatchToEntries({ input: args.input } as ApplyPatchParams);
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			if (!push(entry.path)) return undefined;
			if (entry.rename !== undefined && !push(entry.rename)) return undefined;
		}
		return paths.length > 0 ? paths : undefined;
	}
	if (!push(args.path)) return undefined;
	if (Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			if (isRecord(edit) && edit.rename !== undefined && !push(edit.rename)) return undefined;
		}
	}
	return paths;
}

export async function planPermissionFileChangesWithGuard(
	toolName: string,
	args: unknown,
	cwd: string,
): Promise<{ fileChanges: PermissionFileChangeMap; guard: PermissionFileChangeGuard } | undefined> {
	const fileChanges = await planPermissionFileChanges(toolName, args, cwd);
	if (!fileChanges) return undefined;
	const paths = mutationPaths(toolName, args, cwd);
	if (!paths || paths.length === 0) return undefined;
	const identities: PathIdentity[] = [];
	for (const path of paths) {
		const identity = await capturePathIdentity(path);
		if (!identity) return undefined;
		identities.push(identity);
	}
	const identityByPath = new Map(identities.map(identity => [identity.path, identity]));
	const resolvedFileChanges: PermissionFileChangeMap = {};
	for (const [path, change] of Object.entries(fileChanges)) {
		const identity = identityByPath.get(path);
		const resolvedPath = identity?.realPath ?? path;
		if (change.type === "update" && change.move_path !== null) {
			const moveIdentity = identityByPath.get(change.move_path);
			resolvedFileChanges[resolvedPath] = { ...change, move_path: moveIdentity?.realPath ?? change.move_path };
		} else {
			resolvedFileChanges[resolvedPath] = change;
		}
	}
	const guard = {
		async validate() {
			for (const expected of identities) {
				const current = await capturePathIdentity(expected.path);
				if (
					!current ||
					current.exists !== expected.exists ||
					current.realPath !== expected.realPath ||
					current.deviceAndInode !== expected.deviceAndInode
				)
					throw new Error(`Approved mutation target changed before execution: ${expected.path}`);
			}
		},
		async bind(executionArgs: unknown) {
			await this.validate();
			const bindable =
				(toolName === "write" || toolName === "edit") &&
				identities.length === 1 &&
				identities[0].exists &&
				Object.values(fileChanges).every(change => change.type === "update");
			// Existing write/edit updates are hardlink-bound. Delete/rename/create cannot use this
			// binding because their tool contracts require lexical unlink/rename/create operations;
			// identity validation is retained as the narrowest safe fallback and documented in the manifest.
			if (!bindable) {
				if (Object.values(fileChanges).some(change => change.type === "add"))
					throw new Error(
						`Approved mutation target cannot be bound for creation: ${identities[0]?.path ?? toolName}`,
					);
				return { args: executionArgs, release: async () => {} };
			}
			const expected = identities[0];
			if (!isRecord(executionArgs) || typeof executionArgs.path !== "string")
				throw new Error(`Approved mutation target cannot be bound: ${expected.path}`);
			const boundPath = nodePath.join(nodePath.dirname(expected.realPath), `.gjc-approval-${randomUUID()}`);
			let cleaned = false;
			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				try {
					unlinkSync(boundPath);
				} catch {
					// The target may already have cleaned up the hardlink.
				}
			};
			try {
				// Random same-directory link creation is atomic and exclusive; verify the resulting inode
				// after creation to reject a source swap during link(). The exit hook handles process exits.
				await link(expected.path, boundPath);
				process.once("exit", cleanup);
				const boundStat = await lstat(boundPath);
				if (identityKey(boundStat) !== expected.deviceAndInode) {
					throw new Error(`Approved mutation target changed before execution: ${expected.path}`);
				}
				return {
					args: { ...executionArgs, path: boundPath },
					release: async () => {
						cleanup();
						process.removeListener("exit", cleanup);
					},
				};
			} catch (error) {
				cleanup();
				process.removeListener("exit", cleanup);
				throw error;
			}
		},
	};
	return { fileChanges: resolvedFileChanges, guard };
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
