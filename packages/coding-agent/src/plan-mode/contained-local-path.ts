import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isFsError } from "@gajae-code/utils";

const ESCAPE_MESSAGE = "local:// plan path escapes the session local root";

/** Refusal for a local:// plan path that is not inside the real session local root. */
export class LocalPlanPathError extends Error {
	constructor(message = ESCAPE_MESSAGE) {
		super(message);
		this.name = "LocalPlanPathError";
	}
}

function realpathUnresolved(error: unknown): boolean {
	return isEnoent(error) || (isFsError(error) && error.code === "ELOOP");
}

function escapesRoot(realRoot: string, candidate: string): boolean {
	const root = path.resolve(realRoot);
	const target = path.resolve(candidate);
	return target !== root && !target.startsWith(`${root}${path.sep}`);
}

/**
 * Canonicalize `lexicalPath` against the real session local root.
 * Missing ordinary files stay allowed when every existing ancestor is inside that root.
 * An existing symlink is refused when its real path leaves the root, and a dangling
 * symlink is refused because realpath fails and a later write would create the target.
 */
export async function resolveContainedLocalPlanPath(localRoot: string, lexicalPath: string): Promise<string> {
	let realRoot: string;
	try {
		realRoot = await fs.realpath(localRoot);
	} catch (error) {
		if (realpathUnresolved(error)) throw new LocalPlanPathError();
		throw error;
	}

	const resolvedLexical = path.resolve(lexicalPath);
	try {
		const realTarget = await fs.realpath(resolvedLexical);
		if (escapesRoot(realRoot, realTarget)) throw new LocalPlanPathError();
		return realTarget;
	} catch (error) {
		if (error instanceof LocalPlanPathError) throw error;
		if (isFsError(error) && error.code === "ELOOP") throw new LocalPlanPathError();
		if (!isEnoent(error)) throw error;
	}

	const missing: string[] = [];
	let cursor = resolvedLexical;
	for (;;) {
		let stat: Stats | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat) {
			let realAncestor: string;
			try {
				realAncestor = await fs.realpath(cursor);
			} catch (error) {
				if (realpathUnresolved(error)) throw new LocalPlanPathError();
				throw error;
			}
			const canonical = path.resolve(path.join(realAncestor, ...missing));
			if (escapesRoot(realRoot, canonical)) throw new LocalPlanPathError();
			return canonical;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new LocalPlanPathError();
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

/**
 * Directory entry to unlink. Containment matches `resolveContainedLocalPlanPath`,
 * including an in-root symlink target, but the returned path is the source name.
 * Unlink then removes that name and leaves the target file in place.
 */
export async function containedLocalPlanUnlinkPath(localRoot: string, lexicalPath: string): Promise<string> {
	await resolveContainedLocalPlanPath(localRoot, lexicalPath);
	let realRoot: string;
	try {
		realRoot = await fs.realpath(localRoot);
	} catch (error) {
		if (realpathUnresolved(error)) throw new LocalPlanPathError();
		throw error;
	}
	const resolvedLexical = path.resolve(lexicalPath);
	const parent = path.dirname(resolvedLexical);
	let realParent: string;
	try {
		realParent = await fs.realpath(parent);
	} catch (error) {
		if (realpathUnresolved(error)) throw new LocalPlanPathError();
		throw error;
	}
	if (escapesRoot(realRoot, realParent)) throw new LocalPlanPathError();
	const entry = path.join(realParent, path.basename(resolvedLexical));
	let stat: Stats;
	try {
		stat = await fs.lstat(entry);
	} catch (error) {
		if (realpathUnresolved(error)) throw new LocalPlanPathError();
		throw error;
	}
	if (stat.isSymbolicLink()) {
		let target: string;
		try {
			target = await fs.realpath(entry);
		} catch (error) {
			if (realpathUnresolved(error)) throw new LocalPlanPathError();
			throw error;
		}
		if (escapesRoot(realRoot, target)) throw new LocalPlanPathError();
	}
	return entry;
}
