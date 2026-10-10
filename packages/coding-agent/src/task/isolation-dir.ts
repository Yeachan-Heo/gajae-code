import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ALLOCATION_ATTEMPTS = 8;

type PathApi = Pick<typeof path, "dirname" | "isAbsolute" | "relative" | "resolve" | "sep">;

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function defaultToken(): string {
	return randomBytes(9).toString("hex");
}

/**
 * Parent directory of `mergedDir`, but only when it is a single entry inside
 * `worktreeRoot`. Root, empty, nested, and escaped paths are refused so
 * cleanup cannot delete the worktree root or another session's tree by
 * walking up.
 */
export function resolveIsolationRemovalTarget(
	mergedDir: string,
	worktreeRoot: string,
	pathApi: PathApi = path,
): string {
	if (mergedDir.length === 0) {
		throw new Error("Refusing to remove an isolation directory for an empty merged path.");
	}
	if (worktreeRoot.length === 0) {
		throw new Error("Refusing to remove an isolation directory without a worktree root.");
	}
	const baseDir = pathApi.resolve(pathApi.dirname(mergedDir));
	const root = pathApi.resolve(worktreeRoot);
	const relative = pathApi.relative(root, baseDir);
	if (
		relative.length === 0 ||
		relative === "." ||
		relative.startsWith("..") ||
		pathApi.isAbsolute(relative) ||
		relative.includes(pathApi.sep) ||
		relative.includes("/") ||
		relative.includes("\\")
	) {
		throw new Error("Refusing to remove an isolation directory that is not a single worktree entry.");
	}
	return baseDir;
}

/**
 * Create an exclusive directory next to `canonicalBaseDir`. Never removes
 * `canonicalBaseDir` or any path that already exists.
 */
export async function allocateDisjointIsolationDir(
	canonicalBaseDir: string,
	tokenFactory: () => string = defaultToken,
): Promise<string> {
	const parent = path.dirname(canonicalBaseDir);
	const stem = path.basename(canonicalBaseDir);
	if (stem.length === 0 || stem === "." || stem === ".." || stem.includes("/") || stem.includes("\\")) {
		throw new Error("Isolation directory name is not a single path segment.");
	}
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });

	for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt++) {
		const token = tokenFactory();
		if (!/^[0-9a-f]+$/i.test(token)) {
			throw new Error("Isolation directory token is not hexadecimal.");
		}
		const name = `${stem}-${token}`;
		const baseDir = path.join(parent, name);
		const relative = path.relative(parent, baseDir);
		if (relative !== name || path.isAbsolute(relative)) {
			throw new Error("Isolation directory escaped its parent.");
		}
		try {
			await fs.mkdir(baseDir, { mode: 0o700 });
			return baseDir;
		} catch (error) {
			if (isErrno(error, "EEXIST")) continue;
			if (isErrno(error, "EPERM")) {
				try {
					await fs.lstat(baseDir);
					continue;
				} catch (statError) {
					if (!isErrno(statError, "ENOENT")) throw statError;
				}
			}
			throw error;
		}
	}

	throw new Error("Failed to allocate a disjoint task isolation directory.");
}

/**
 * Confirm native teardown may see `mergedDir`.
 *
 * `isoStop` deletes that path. The parent entry and `merged` itself must
 * already be real directories, because native removal follows symlinks.
 * A missing parent means there is nothing to stop. This does not close a
 * replacement that happens after the lstat returns.
 */
export async function assertIsolationTeardownTarget(mergedDir: string, worktreeRoot: string): Promise<"stop" | "skip"> {
	const baseDir = resolveIsolationRemovalTarget(mergedDir, worktreeRoot);
	let baseInfo: { isSymbolicLink(): boolean };
	try {
		baseInfo = await fs.lstat(baseDir);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return "skip";
		throw error;
	}
	if (baseInfo.isSymbolicLink()) {
		throw new Error("Refusing to remove a symlinked isolation directory.");
	}
	try {
		const mergedInfo = await fs.lstat(mergedDir);
		if (mergedInfo.isSymbolicLink()) {
			throw new Error("Refusing to tear down a symlinked isolation merged directory.");
		}
	} catch (error) {
		if (isErrno(error, "ENOENT")) return "stop";
		throw error;
	}
	return "stop";
}

/** Remove the isolation directory that owns `mergedDir`. Missing directories are ignored. */
export async function removeIsolationDirectory(mergedDir: string, worktreeRoot: string): Promise<void> {
	const baseDir = resolveIsolationRemovalTarget(mergedDir, worktreeRoot);
	let info: { isSymbolicLink(): boolean };
	try {
		info = await fs.lstat(baseDir);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return;
		throw error;
	}
	if (info.isSymbolicLink()) {
		throw new Error("Refusing to remove a symlinked isolation directory.");
	}
	await fs.rm(baseDir, { recursive: true, force: true });
}
