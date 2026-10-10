import * as fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/tool-errors";

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** `path.relative` keeps workspace `/` contained. A `//` string prefix does not. */
function escapes(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Split a workspace path without collapsing `..`.
 * `.` is not a distinct entry. On Windows, `file://` URIs use `/` while `path.sep` is `\`.
 * On POSIX, `\` is a filename character and must not be a separator.
 */
export function splitAbsolute(
	filePath: string,
	pathApi: Pick<typeof path, "parse" | "sep"> = path,
): { root: string; parts: string[] } {
	const root = pathApi.parse(filePath).root;
	const splitter = pathApi.sep === "\\" ? /[\\/]/ : /\//;
	const parts = filePath
		.slice(root.length)
		.split(splitter)
		.filter(part => part.length > 0 && part !== ".");
	return { root, parts };
}

function toPlatformSep(filePath: string): string {
	return path.sep === "\\" ? filePath.replace(/\//g, "\\") : filePath;
}

/** `/` is always a separator. `\` is a separator only on Windows, so a POSIX name may end with `\`. */
function hasSepSuffix(value: string): boolean {
	if (value.endsWith("/")) return true;
	return path.sep === "\\" && value.endsWith("\\");
}

/** Absolute path against `cwd`. `..` stays in the string so a symlink can be followed first. */
function lexicalAbsolute(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return toPlatformSep(filePath);
	const base = hasSepSuffix(cwd) ? cwd : `${cwd}${path.sep}`;
	return toPlatformSep(`${base}${filePath}`);
}

function joinRaw(parent: string, child: string): string {
	if (hasSepSuffix(parent)) return parent + child;
	return parent + path.sep + child;
}

function joinRoot(root: string, parts: string[]): string {
	if (parts.length === 0) return root || path.sep;
	if (hasSepSuffix(root)) return root + parts.join(path.sep);
	if (root.length === 0) return parts.join(path.sep);
	return `${root}${path.sep}${parts.join(path.sep)}`;
}

function parentDir(filePath: string): string {
	const { root, parts } = splitAbsolute(filePath);
	return joinRoot(root, parts.slice(0, -1));
}

/** Absolute workspace path with `.` removed. `..` stays so a symlink can be followed first. */
function identityPath(filePath: string, cwd: string): string {
	const { root, parts } = splitAbsolute(lexicalAbsolute(filePath, cwd));
	return joinRoot(root, parts);
}

function isSameOrInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const prefix = hasSepSuffix(parent) ? parent : parent + path.sep;
	return child.startsWith(prefix);
}

type Move = { from: string; to: string; linkText: string | null };

/** Where a virtual path still sits on disk. Null when an earlier move took that entry away. */
function diskLocation(postPath: string, moves: Move[]): string | null {
	let current = postPath;
	for (let i = moves.length - 1; i >= 0; i--) {
		const move = moves[i];
		if (isSameOrInside(current, move.to)) {
			current = move.from + current.slice(move.to.length);
			continue;
		}
		if (current === move.from || isSameOrInside(current, move.from)) return null;
	}
	return current;
}

function isDeleted(postPath: string, deleted: string[]): boolean {
	return deleted.some(entry => postPath === entry || isSameOrInside(postPath, entry));
}

function isMovedAway(postPath: string, moves: Move[]): boolean {
	let away = false;
	for (const move of moves) {
		if (isSameOrInside(postPath, move.from)) away = true;
		if (isSameOrInside(postPath, move.to)) away = false;
	}
	return away;
}

function absoluteLink(linkText: string, parent: string): string {
	const text = toPlatformSep(linkText);
	return path.isAbsolute(text) ? text : joinRaw(parent, text);
}

async function symlinkText(postPath: string, moves: Move[], deleted: string[]): Promise<string | null> {
	for (let i = moves.length - 1; i >= 0; i--) {
		const move = moves[i];
		if (move.to === postPath) return move.linkText;
		// A newer directory rename replaced this path. Read that directory, not an older move onto the same string.
		if (isSameOrInside(postPath, move.to)) break;
		if (move.from === postPath || isSameOrInside(postPath, move.from)) return null;
	}
	if (isMovedAway(postPath, moves) || isDeleted(postPath, deleted)) return null;
	const disk = diskLocation(postPath, moves);
	if (disk === null) return null;
	try {
		const stat = await fs.lstat(disk);
		if (!stat.isSymbolicLink()) return null;
		return await fs.readlink(disk);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Where `filePath` will sit after `moves`, following relative symlinks from their new parents. */
async function locate(filePath: string, moves: Move[], deleted: string[], depth: number): Promise<string> {
	if (depth > 40) throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	const { root, parts } = splitAbsolute(filePath);
	let cursor = root || path.sep;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === ".") continue;
		if (part === "..") {
			const link = await symlinkText(cursor, moves, deleted);
			if (link !== null) {
				cursor = parentDir(await locate(absoluteLink(link, parentDir(cursor)), moves, deleted, depth + 1));
			} else if (moves.some(move => isSameOrInside(cursor, move.to))) {
				// A renamed directory's `..` is its new parent, not the old one still on disk.
				cursor = parentDir(cursor);
			} else {
				const disk = diskLocation(cursor, moves);
				if (disk === null || isDeleted(cursor, deleted)) {
					cursor = parentDir(cursor);
				} else {
					try {
						cursor = parentDir(await fs.realpath(disk));
					} catch (error) {
						if (!isEnoent(error)) throw error;
						cursor = parentDir(cursor);
					}
				}
			}
			continue;
		}
		const next = joinRaw(cursor, part);
		const link = await symlinkText(next, moves, deleted);
		if (link !== null) {
			const rest = parts
				.slice(i + 1)
				.reduce((acc, piece) => joinRaw(acc, piece), absoluteLink(link, parentDir(next)));
			return locate(rest, moves, deleted, depth + 1);
		}
		cursor = next;
	}
	return cursor;
}

/** Resolve a missing path through the nearest existing ancestor. */
async function canonicalize(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const missing: string[] = [];
	let cursor = filePath;
	for (;;) {
		let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat) {
			try {
				const joined = path.join(await fs.realpath(cursor), ...missing);
				// `path.join` collapses `..` onto a symlink the walk never opened. Follow that result.
				try {
					return await fs.realpath(joined);
				} catch (error) {
					if (!isEnoent(error)) throw error;
					return joined;
				}
			} catch (error) {
				if (isEnoent(error)) throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
				throw error;
			}
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

export async function canonicalWorkspacePath(cwd: string, filePath: string): Promise<string> {
	// `realpath` cancels `hop/..` lexically, then can follow a different symlink than `open`.
	const walked = await locate(identityPath(filePath, cwd), [], [], 0);
	return canonicalize(walked);
}

export async function assertInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	if (cwd.length === 0 || filePath.length === 0) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
	const root = await fs.realpath(cwd);
	const walked = await locate(identityPath(filePath, cwd), [], [], 0);
	const candidate = await canonicalize(walked);
	if (escapes(root, candidate)) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
}

/**
 * Real directory that contains the final directory entry. `..` is applied after
 * following a symlink, so `hop/../link.ts` is not collapsed to a lexical parent.
 */
async function directoryContainingEntry(filePath: string, cwd: string): Promise<string> {
	const absolute = lexicalAbsolute(filePath, cwd);
	const { root, parts } = splitAbsolute(absolute);
	return locate(joinRoot(root, parts.slice(0, -1)), [], [], 0);
}

/** The directory entry itself must sit inside the workspace, not only its real target. */
export async function assertDirectoryEntryInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	await assertInsideWorkspace(cwd, await directoryContainingEntry(filePath, cwd));
}

/** Real content and the directory entry that names it must both stay inside the workspace. */
export async function assertWorkspaceTarget(cwd: string, filePath: string): Promise<void> {
	await assertInsideWorkspace(cwd, filePath);
	await assertDirectoryEntryInsideWorkspace(cwd, filePath);
}

/** Both rename endpoints, including the directory entries `rename` will move or create. */
export async function assertRenamePaths(cwd: string, source: string, dest: string): Promise<void> {
	await assertWorkspaceTarget(cwd, source);
	await assertWorkspaceTarget(cwd, dest);
}

export type PlannedResource =
	| { kind: "create"; filePath: string }
	| { kind: "rename"; oldPath: string; newPath: string }
	| { kind: "delete"; filePath: string };

/** Parent symlinks and `.` applied, final component not followed, so `alias/link` and `link` match. */
async function entryIdentity(filePath: string, cwd: string, moves: Move[], deleted: string[]): Promise<string> {
	const absolute = identityPath(filePath, cwd);
	const { root, parts } = splitAbsolute(absolute);
	if (parts.length === 0) return root || path.sep;
	const parent =
		parts.length === 1 ? root || path.sep : await locate(joinRoot(root, parts.slice(0, -1)), moves, deleted, 0);
	return joinRaw(parent, parts[parts.length - 1]);
}

/**
 * Reject a batch whose own earlier rename would make a later path leave the workspace.
 * The check runs before any write, so a rejected later target does not leave earlier edits applied.
 */
export async function assertBatchStaysInside(cwd: string, ops: PlannedResource[]): Promise<void> {
	if (ops.length === 0) return;
	const workspaceRoot = await fs.realpath(cwd);
	const moves: Move[] = [];
	const deleted: string[] = [];
	const check = async (filePath: string) => {
		const absolute = identityPath(filePath, cwd);
		const { root, parts } = splitAbsolute(absolute);
		const parent =
			parts.length <= 1 ? root || path.sep : await locate(joinRoot(root, parts.slice(0, -1)), moves, deleted, 0);
		if (escapes(workspaceRoot, await canonicalize(parent))) {
			throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
		}
		const located = await locate(absolute, moves, deleted, 0);
		if (escapes(workspaceRoot, await canonicalize(located))) {
			throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
		}
	};
	for (const op of ops) {
		if (op.kind === "delete") {
			await check(op.filePath);
			deleted.push(await entryIdentity(op.filePath, cwd, moves, deleted));
			continue;
		}
		if (op.kind === "rename") {
			await check(op.oldPath);
			await check(op.newPath);
			const from = await entryIdentity(op.oldPath, cwd, moves, deleted);
			const to = await entryIdentity(op.newPath, cwd, moves, deleted);
			let linkText: string | null = null;
			const live = diskLocation(from, moves);
			if (live !== null) {
				try {
					const stat = await fs.lstat(live);
					if (stat.isSymbolicLink()) linkText = await fs.readlink(live);
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
			moves.push({ from, to, linkText });
			continue;
		}
		await check(op.filePath);
	}
}

/**
 * Absolute path the kernel will use. Relative URIs are anchored at the workspace, not
 * `process.cwd()`. A missing spelled path uses the directory entry the containment walk
 * already checked. Lexical collapse (`path.resolve`) can name a different entry:
 * `hop/../file` follows `hop` to `deep/file`, while `path.resolve` yields `file`.
 */
export async function workspaceOperand(cwd: string, filePath: string): Promise<string> {
	const absolute = identityPath(filePath, cwd);
	try {
		await fs.lstat(absolute);
		return absolute;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return entryIdentity(filePath, cwd, [], []);
}

/** Syscall only. The caller has already rejected any path that leaves the workspace. */
export async function renameCheckedPaths(cwd: string, source: string, dest: string): Promise<void> {
	const sourceOp = await workspaceOperand(cwd, source);
	const destOp = await workspaceOperand(cwd, dest);
	await fs.mkdir(parentDir(destOp), { recursive: true });
	await fs.rename(sourceOp, destOp);
}

/** Rename only after both real paths and both directory entries stay inside the workspace. */
export async function renameInsideWorkspace(cwd: string, source: string, dest: string): Promise<void> {
	await assertRenamePaths(cwd, identityPath(source, cwd), identityPath(dest, cwd));
	await renameCheckedPaths(cwd, source, dest);
}
