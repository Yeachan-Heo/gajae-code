import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_ANCESTOR_WALK = 64;

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Path the native writer will mutate: realpath of an existing file, or realpath
 * of the nearest existing ancestor plus the missing tail.
 */
export async function canonicalizeAstEditWritePath(absolutePath: string): Promise<string> {
	const suffix: string[] = [];
	let current = path.resolve(absolutePath);
	for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth++) {
		try {
			const real = await fs.realpath(current);
			return suffix.length === 0 ? real : path.join(real, ...suffix.toReversed());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) break;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
	return path.resolve(absolutePath);
}

/**
 * Preview paths as the workflow guard must see them.
 *
 * The guard compares lexically against the session cwd. A raw realpath misses
 * `.gjc/**` when that cwd is not already canonical (`/var` vs `/private/var`,
 * or a symlinked workspace), so an in-workspace real path is reattached to `cwd`.
 */
export async function resolveAstEditPreviewWritePaths(
	cwd: string,
	previewedPaths: readonly string[],
): Promise<string[]> {
	const resolvedCwd = path.resolve(cwd);
	let realCwd = resolvedCwd;
	try {
		realCwd = await fs.realpath(resolvedCwd);
	} catch {
		// Missing cwd has no canonical spelling; keep the lexical root.
	}
	const resolved: string[] = [];
	for (const previewed of previewedPaths) {
		const lexical = path.resolve(resolvedCwd, previewed);
		const real = await canonicalizeAstEditWritePath(lexical);
		const relative = path.relative(realCwd, real);
		const canonical =
			isInside(realCwd, real) && relative !== ""
				? path.resolve(resolvedCwd, relative)
				: isInside(realCwd, real)
					? resolvedCwd
					: real;
		// The guard matches `.gjc` lexically. Keep the preview spelling so a
		// symlinked `.gjc` directory is still recognized, and add the canonical
		// spelling so `src` → `.gjc` is recognized too.
		resolved.push(previewed);
		if (path.resolve(canonical) !== lexical) resolved.push(canonical);
	}
	return resolved;
}
