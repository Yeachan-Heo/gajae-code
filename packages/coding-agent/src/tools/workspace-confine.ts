import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { confinedMkdirAll, confinedOpenRead, confinedUnlink, confinedWriteFileAtomic } from "@gajae-code/natives";
import { pathIsWithin } from "@gajae-code/utils";

/**
 * Confinement for a session opened with `--confine`.
 *
 * Existing paths are checked after symlink resolution. A path that does not
 * exist yet is checked at its nearest existing ancestor, so creating
 * `root/link/new` is rejected when `link` points outside the root.
 *
 * Those checks only decide which path to ask for. The file operations below
 * never resolve that path again: the native helpers open the root once and
 * walk every component with `openat(..., O_NOFOLLOW)`, then read or write
 * through the resulting descriptors. A parent swapped for a symlink between
 * the check and the operation fails the operation instead of redirecting it.
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

interface ConfinedTarget {
	/** Canonical session root. */
	realRoot: string;
	/** Symlink-free path of the target relative to `realRoot`, or `undefined` when it escapes. */
	relative: string | undefined;
}

async function resolveConfinedTarget(root: string, candidate: string): Promise<ConfinedTarget> {
	const [realRoot, existing] = await Promise.all([
		fs.realpath(root).catch(() => path.resolve(root)),
		nearestExistingPath(candidate),
	]);
	const stat = await fs.lstat(existing);
	const realCandidate = stat.isSymbolicLink()
		? await fs.realpath(existing).catch(() => undefined)
		: await fs.realpath(existing);
	if (!realCandidate) return { realRoot, relative: undefined };
	const suffix = path.relative(existing, path.resolve(candidate));
	const resolved = suffix ? path.resolve(realCandidate, suffix) : realCandidate;
	if (resolved !== realRoot && !pathIsWithin(realRoot, resolved)) return { realRoot, relative: undefined };
	return { realRoot, relative: path.relative(realRoot, resolved) };
}

/** True when `candidate` resolves, through symlinks, outside `root`. */
export async function realpathEscapesWorkspace(root: string, candidate: string): Promise<boolean> {
	return (await resolveConfinedTarget(root, candidate)).relative === undefined;
}

/** realpath confinement for a directory the process is about to use as cwd. */
export async function directoryEscapesWorkspace(root: string, candidate: string): Promise<boolean> {
	return realpathEscapesWorkspace(root, candidate);
}

function escapeError(root: string, candidate: string, cause?: unknown): Error {
	return new Error(
		`Path resolves outside the confined session root (${root}): ${candidate}`,
		cause === undefined ? undefined : { cause },
	);
}

const NATIVE_REASON_CODES: Record<string, string> = {
	not_found: "ENOENT",
	is_directory: "EISDIR",
	not_directory: "ENOTDIR",
	permission_denied: "EACCES",
	read_only: "EROFS",
};

/** Map a `confine:<reason>: ...` native error onto the error shape fs callers expect. */
function mapNativeError(root: string, candidate: string, error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	const match = /^confine:([a-z_]+): (.*)$/s.exec(message);
	if (!match) return error instanceof Error ? error : new Error(message);
	const [, reason, detail] = match;
	if (reason === "escape") return escapeError(root, candidate, error);
	const code = NATIVE_REASON_CODES[reason];
	const mapped = new Error(`${detail}: ${candidate}`, { cause: error }) as NodeJS.ErrnoException;
	if (code) mapped.code = code;
	return mapped;
}

async function requireConfinedTarget(root: string, candidate: string): Promise<ConfinedTarget & { relative: string }> {
	const target = await resolveConfinedTarget(root, candidate);
	if (target.relative === undefined) throw escapeError(root, candidate);
	return { realRoot: target.realRoot, relative: target.relative };
}

/** Open an existing regular file through descriptors pinned beneath `root`. */
export async function openFileInsideWorkspace(root: string, candidate: string): Promise<fs.FileHandle> {
	const target = await requireConfinedTarget(root, candidate);
	let fd: number;
	try {
		fd = confinedOpenRead(target.realRoot, target.relative);
	} catch (error) {
		throw mapNativeError(root, candidate, error);
	}
	try {
		// Opening /dev/fd/N duplicates the already-open file; it does not walk
		// the original pathname again.
		return await fs.open(`/dev/fd/${fd}`, "r");
	} finally {
		fsSync.closeSync(fd);
	}
}

export async function readFileInsideWorkspace(root: string, candidate: string): Promise<Buffer> {
	const handle = await openFileInsideWorkspace(root, candidate);
	try {
		return Buffer.from(await handle.readFile());
	} finally {
		await handle.close();
	}
}

/**
 * Atomically replace or create `candidate` beneath `root`. Missing parent
 * directories are created through the same pinned walk.
 */
export async function writeFileInsideWorkspace(
	root: string,
	candidate: string,
	content: string | Uint8Array,
): Promise<void> {
	const target = await requireConfinedTarget(root, candidate);
	const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
	try {
		confinedWriteFileAtomic(target.realRoot, target.relative, bytes, true);
	} catch (error) {
		throw mapNativeError(root, candidate, error);
	}
}

export async function unlinkInsideWorkspace(root: string, candidate: string): Promise<void> {
	const target = await requireConfinedTarget(root, candidate);
	try {
		confinedUnlink(target.realRoot, target.relative);
	} catch (error) {
		throw mapNativeError(root, candidate, error);
	}
}

export async function mkdirInsideWorkspace(root: string, candidate: string): Promise<void> {
	const target = await requireConfinedTarget(root, candidate);
	try {
		confinedMkdirAll(target.realRoot, target.relative);
	} catch (error) {
		throw mapNativeError(root, candidate, error);
	}
}
