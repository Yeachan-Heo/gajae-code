import * as fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/tool-errors";

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Drive-letter root such as `C:\`. A UNC share root is not a drive root. */
function windowsDriveLetter(root: string): string | null {
	const match = /^([A-Za-z]):[\\/]$/.exec(root);
	return match ? match[1].toLowerCase() : null;
}

/**
 * A Windows drive root already ends in a separator. Prefixing another one
 * (`C:\` + `\`) matches nothing on that volume, so compare the drive letter.
 * Same-volume paths stay inside, including `\\?\C:\`. Other drives and UNC
 * shares do not.
 */
function sameWindowsDrive(driveRoot: string, candidate: string): boolean {
	const letter = windowsDriveLetter(driveRoot);
	if (!letter) return false;
	const normalized = candidate.replace(/\//g, "\\");
	const extended = /^\\\\\?\\([A-Za-z]):\\/.exec(normalized);
	if (extended) return extended[1].toLowerCase() === letter;
	if (normalized.startsWith("\\\\")) return false;
	return path.win32.parse(normalized).root.toLowerCase() === `${letter}:\\`;
}

function escapes(root: string, candidate: string): boolean {
	if (windowsDriveLetter(root)) return !sameWindowsDrive(root, candidate);
	return candidate !== root && !candidate.startsWith(`${root}${path.sep}`);
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
				return path.join(await fs.realpath(cursor), ...missing);
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

export async function assertInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	const root = await fs.realpath(cwd);
	const candidate = await canonicalize(filePath);
	if (escapes(root, candidate)) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
}
