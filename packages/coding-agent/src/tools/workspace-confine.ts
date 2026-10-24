import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathIsWithin } from "@gajae-code/utils";

/**
 * Confinement for a session opened with `--confine`.
 *
 * Existing paths are checked after symlink resolution. A path that does not
 * exist yet is checked at its nearest existing ancestor, so creating
 * `root/link/new` is rejected when `link` points outside the root.
 */
export function pathEscapesWorkspace(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate !== resolvedRoot && !pathIsWithin(resolvedRoot, resolvedCandidate);
}

async function nearestExistingPath(candidate: string): Promise<string> {
	let current = path.resolve(candidate);
	for (;;) {
		try {
			await fs.lstat(current);
			return current;
		} catch (error) {
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			const parent = path.dirname(current);
			if (!missing || parent === current) throw error;
			current = parent;
		}
	}
}

/** True when `candidate` resolves, through symlinks, outside `root`. */
export async function realpathEscapesWorkspace(root: string, candidate: string): Promise<boolean> {
	const [realRoot, existing] = await Promise.all([
		fs.realpath(root).catch(() => path.resolve(root)),
		nearestExistingPath(candidate),
	]);
	const stat = await fs.lstat(existing);
	const realCandidate = stat.isSymbolicLink()
		? await fs.realpath(existing).catch(() => undefined)
		: await fs.realpath(existing);
	if (!realCandidate) return true;
	const suffix = path.relative(existing, path.resolve(candidate));
	const resolved = suffix ? path.resolve(realCandidate, suffix) : realCandidate;
	return resolved !== realRoot && !pathIsWithin(realRoot, resolved);
}

/** realpath confinement for a directory the process is about to use as cwd. */
export async function directoryEscapesWorkspace(root: string, candidate: string): Promise<boolean> {
	return realpathEscapesWorkspace(root, candidate);
}
const OPEN_NOFOLLOW = fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW;

/** Open an existing file without following a symlink at the final path. */
export async function openFileInsideWorkspace(root: string, candidate: string): Promise<fs.FileHandle> {
	if (await realpathEscapesWorkspace(root, candidate)) {
		throw new Error(`Path resolves outside the confined session root (${root}): ${candidate}`);
	}
	const resolved = path.resolve(candidate);
	try {
		const opened = await fs.lstat(resolved);
		if (opened.isSymbolicLink()) {
			throw new Error(`Path resolves outside the confined session root (${root}): ${candidate}`);
		}
		return await fs.open(resolved, OPEN_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ELOOP" && code !== "EMLINK") throw error;
		throw new Error(`Path resolves outside the confined session root (${root}): ${candidate}`, { cause: error });
	}
}

export async function readFileInsideWorkspace(root: string, candidate: string): Promise<Buffer> {
	const handle = await openFileInsideWorkspace(root, candidate);
	try {
		const opened = await handle.stat();
		const current = await fs.lstat(candidate);
		if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino || current.isSymbolicLink()) {
			throw new Error(`Path changed outside the confined session root (${root}): ${candidate}`);
		}
		return Buffer.from(await handle.readFile());
	} finally {
		await handle.close();
	}
}
