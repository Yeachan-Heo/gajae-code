import * as fs from "node:fs";
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

	try {
		const content = await Bun.file(abs).text();
		if (useCache) contentCache.set(abs, content);
		return content;
	} catch {
		if (useCache) contentCache.set(abs, null);
		return null;
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
	try {
		return new Uint8Array(await Bun.file(abs).slice(start, end).arrayBuffer());
	} catch {
		return null;
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
	try {
		return (await fs.promises.stat(abs)).size;
	} catch {
		return null;
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

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		if (useCache) dirCache.set(abs, entries);
		return entries;
	} catch {
		if (useCache) dirCache.set(abs, []);
		return [];
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
