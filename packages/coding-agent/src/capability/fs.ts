import * as fs from "node:fs";
import * as path from "node:path";

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, fs.Dirent[]>();

export interface ReadFileOptions {
	/** Canonicalize the file and enforce the supplied home/profile boundary. */
	readonly isolatedHome?: boolean;
	readonly home?: string;
	readonly userAgentDir?: string;
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

async function resolveReadPath(filePath: string, options?: ReadFileOptions): Promise<string | null> {
	const lexical = resolvePath(filePath);
	if (!options?.isolatedHome) return lexical;
	const roots = [options.home, options.userAgentDir].filter((root): root is string => typeof root === "string");
	if (roots.length === 0) return null;
	const [canonicalTarget, canonicalRoots] = await Promise.all([
		canonicalizeThroughExistingAncestor(lexical),
		Promise.all(roots.map(canonicalizeThroughExistingAncestor)),
	]);
	return canonicalRoots.some(root => isWithinOrEqual(root, canonicalTarget)) ? canonicalTarget : null;
}

export async function readFile(filePath: string, options?: ReadFileOptions): Promise<string | null> {
	let abs: string | null;
	try {
		abs = await resolveReadPath(filePath, options);
	} catch {
		return null;
	}
	if (abs === null) return null;
	if (contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	try {
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		contentCache.set(abs, null);
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	if (dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
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
