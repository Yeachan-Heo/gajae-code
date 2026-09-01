import * as fs from "node:fs";
import type * as fsPromises from "node:fs/promises";
import * as path from "node:path";

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, fs.Dirent[]>();

/** Authority used when reading from an explicit-home discovery context. */
export type ReadScope = "project" | "user" | "native";

export interface ReadFileOptions {
	/** Canonicalize the file and enforce the supplied home/profile boundary. */
	readonly isolatedHome?: boolean;
	readonly home?: string;
	readonly userAgentDir?: string;
	/**
	 * Scope of the read. Foreign user/project providers are home-bound; only
	 * native/SSH user reads may use an explicitly external agent directory.
	 */
	readonly scope?: ReadScope;
	/** Skip the shared lexical cache for this operation. */
	readonly bypassCache?: boolean;
}

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

function isWithinOrEqual(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalizeThroughExistingAncestor(target: string): Promise<string> {
	const resolved = path.resolve(target);
	const suffix: string[] = [];
	let current = resolved;

	while (true) {
		try {
			const real = await fs.promises.realpath(current);
			return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = path.dirname(current);
			if (parent === current) return resolved;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
}

function rootsForRead(options: ReadFileOptions): string[] {
	if (options.scope === "native") {
		return [options.home, options.userAgentDir].filter((root): root is string => typeof root === "string");
	}
	return typeof options.home === "string" ? [options.home] : [];
}

async function resolveReadPath(filePath: string, options?: ReadFileOptions): Promise<string | null> {
	const lexical = resolvePath(filePath);
	if (!options?.isolatedHome) return lexical;
	const roots = rootsForRead(options);
	if (roots.length === 0) return null;
	const [canonicalTarget, canonicalRoots] = await Promise.all([
		canonicalizeThroughExistingAncestor(lexical),
		Promise.all(roots.map(canonicalizeThroughExistingAncestor)),
	]);
	return canonicalRoots.some(root => isWithinOrEqual(root, canonicalTarget)) ? canonicalTarget : null;
}

/**
 * Re-check an isolated path immediately before opening it. Canonicalizing the
 * lexical path once prevents cache poisoning, while this second check also
 * fails closed when an existing leaf is swapped for a symlink between the
 * initial resolution and the actual read.
 */
async function isCurrentIsolatedPath(abs: string, options?: ReadFileOptions): Promise<boolean> {
	if (!options?.isolatedHome) return true;
	try {
		const current = await resolveReadPath(abs, options);
		return current === abs;
	} catch {
		return false;
	}
}

function isSingleLinkRegularFile(stat: fs.Stats): boolean {
	return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Capture the identity of the currently-authorized path before opening it.
 * Stat first and canonicalize second so a parent replacement in either seam
 * is detected by the descriptor identity check below.
 */
async function statAuthorizedPath(abs: string, options?: ReadFileOptions): Promise<fs.Stats | null> {
	if (!options?.isolatedHome) return null;
	let authorized: fs.Stats;
	try {
		authorized = await fs.promises.stat(abs);
	} catch {
		return null;
	}
	return (await isCurrentIsolatedPath(abs, options)) ? authorized : null;
}

async function validateOpenedPath(
	handle: fsPromises.FileHandle,
	abs: string,
	options: ReadFileOptions | undefined,
	authorized: fs.Stats | null,
	kind: "file" | "directory",
): Promise<boolean> {
	if (!options?.isolatedHome) return true;
	try {
		const opened = await handle.stat();
		const validKind =
			kind === "file" ? isSingleLinkRegularFile(opened) : opened.isDirectory() && !opened.isSymbolicLink();
		if (!validKind || authorized === null || !sameFileIdentity(opened, authorized)) return false;
		const current = await fs.promises.stat(abs);
		if (!sameFileIdentity(opened, current)) return false;
		return await isCurrentIsolatedPath(abs, options);
	} catch {
		return false;
	}
}

interface OpenedPath {
	handle: fsPromises.FileHandle;
	authorized: fs.Stats | null;
}

async function openIsolatedFile(abs: string, options?: ReadFileOptions): Promise<OpenedPath | null> {
	let handle: fsPromises.FileHandle | undefined;
	const authorized = await statAuthorizedPath(abs, options);
	if (options?.isolatedHome && authorized === null) return null;
	try {
		const noFollow = options?.isolatedHome ? (fs.constants.O_NOFOLLOW ?? 0) : 0;
		handle = await fs.promises.open(abs, fs.constants.O_RDONLY | noFollow);
		if (!(await validateOpenedPath(handle, abs, options, authorized, "file"))) {
			await handle.close();
			return null;
		}
		return { handle, authorized };
	} catch {
		await handle?.close().catch(() => {});
		return null;
	}
}

export async function readFile(filePath: string, options?: ReadFileOptions): Promise<string | null> {
	let abs: string | null;
	try {
		abs = await resolveReadPath(filePath, options);
	} catch {
		return null;
	}
	if (abs === null) return null;
	if (!(await isCurrentIsolatedPath(abs, options))) return null;
	const useCache = !options?.bypassCache && !options?.isolatedHome;
	if (useCache && contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	const opened = await openIsolatedFile(abs, options);
	if (!opened) {
		if (useCache) contentCache.set(abs, null);
		return null;
	}
	try {
		if (!(await validateOpenedPath(opened.handle, abs, options, opened.authorized, "file"))) return null;
		const content = await opened.handle.readFile({ encoding: "utf8" });
		if (!(await validateOpenedPath(opened.handle, abs, options, opened.authorized, "file"))) return null;
		if (useCache) contentCache.set(abs, content);
		return content;
	} catch {
		if (useCache) contentCache.set(abs, null);
		return null;
	} finally {
		await opened.handle.close();
	}
}

/** Read one byte range through the same canonical authority as readFile. */
export async function readFileSlice(
	filePath: string,
	start: number,
	end: number,
	options?: ReadFileOptions,
): Promise<Uint8Array | null> {
	let abs: string | null;
	try {
		abs = await resolveReadPath(filePath, options);
	} catch {
		return null;
	}
	if (abs === null || !(await isCurrentIsolatedPath(abs, options))) return null;
	const opened = await openIsolatedFile(abs, options);
	if (!opened) return null;
	try {
		if (!(await validateOpenedPath(opened.handle, abs, options, opened.authorized, "file"))) return null;
		const length = Math.max(0, end - start);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await opened.handle.read(buffer, 0, length, start);
		if (!(await validateOpenedPath(opened.handle, abs, options, opened.authorized, "file"))) return null;
		return new Uint8Array(buffer.subarray(0, bytesRead));
	} catch {
		return null;
	} finally {
		await opened.handle.close();
	}
}

/** Read file size through the same canonical authority as readFile. */
export async function readFileSize(filePath: string, options?: ReadFileOptions): Promise<number | null> {
	let abs: string | null;
	try {
		abs = await resolveReadPath(filePath, options);
	} catch {
		return null;
	}
	if (abs === null || !(await isCurrentIsolatedPath(abs, options))) return null;
	const opened = await openIsolatedFile(abs, options);
	if (!opened) return null;
	try {
		if (!(await validateOpenedPath(opened.handle, abs, options, opened.authorized, "file"))) return null;
		const size = (await opened.handle.stat()).size;
		if (!(await validateOpenedPath(opened.handle, abs, options, opened.authorized, "file"))) return null;
		return size;
	} catch {
		return null;
	} finally {
		await opened.handle.close();
	}
}

export async function readDirEntries(dirPath: string, options?: ReadFileOptions): Promise<fs.Dirent[]> {
	let abs: string | null;
	try {
		abs = await resolveReadPath(dirPath, options);
	} catch {
		return [];
	}
	if (abs === null) return [];
	if (!(await isCurrentIsolatedPath(abs, options))) return [];
	const useCache = !options?.bypassCache && !options?.isolatedHome;
	if (useCache && dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	let handle: fsPromises.FileHandle | undefined;
	const authorized = await statAuthorizedPath(abs, options);
	if (options?.isolatedHome && authorized === null) return [];
	try {
		const noFollow = options?.isolatedHome ? (fs.constants.O_NOFOLLOW ?? 0) : 0;
		const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
		handle = await fs.promises.open(abs, fs.constants.O_RDONLY | noFollow | directoryOnly);
		if (!(await validateOpenedPath(handle, abs, options, authorized, "directory"))) return [];
		const directoryPath =
			process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : options?.isolatedHome ? null : abs;
		if (directoryPath === null) return [];
		if (!(await validateOpenedPath(handle, abs, options, authorized, "directory"))) return [];
		const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
		if (!(await validateOpenedPath(handle, abs, options, authorized, "directory"))) return [];
		if (useCache) dirCache.set(abs, entries);
		return entries;
	} catch {
		if (useCache) dirCache.set(abs, []);
		return [];
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function readDir(dirPath: string, options?: ReadFileOptions): Promise<string[]> {
	const entries = await readDirEntries(dirPath, options);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string, stopAt?: string): Promise<string | null> {
	let current = resolvePath(startDir);
	const stop = stopAt ? resolvePath(stopAt) : undefined;
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current || current === stop) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
