// Keep this native-backed helper out of the utils root barrel: only callers
// that need stable path identity should load the native package.
import * as fs from "node:fs";
import * as path from "node:path";
import * as nativeBindings from "@gajae-code/natives";

function windowsDirectoryCaseSensitivity(directoryPath: string): boolean | undefined {
	try {
		return nativeBindings.directoryCaseSensitive(directoryPath) ?? undefined;
	} catch {
		return undefined;
	}
}

function isWellFormedUtf16(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const nextCodeUnit = value.charCodeAt(index + 1);
			if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false;
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function windowsOrdinalCaseFold(value: string): string | undefined {
	if (!isWellFormedUtf16(value)) return undefined;
	try {
		return nativeBindings.windowsOrdinalCaseFold(value);
	} catch {
		return undefined;
	}
}

function isExtendedWindowsPath(pathname: string): boolean {
	return pathname.startsWith("\\\\?\\") || pathname.startsWith("\\\\.\\");
}

function normalizeWindowsEntryName(entryName: string, pathname: string): string {
	return isExtendedWindowsPath(pathname) ? entryName : entryName.replace(/[ .]+$/, "");
}

function normalizeWindowsFinalEntryPath(pathname: string): string {
	if (isExtendedWindowsPath(pathname)) return pathname;
	const directory = path.win32.dirname(pathname);
	const entryName = normalizeWindowsEntryName(path.win32.basename(pathname), pathname);
	return path.win32.join(directory, entryName);
}

/**
 * Return a key for a path whose final file can be created or replaced after
 * registration. On Windows, use the parent directory's stable identity and the
 * final entry name rather than the file's inode. Case-insensitive directories
 * fold the name even before the entry exists; case-sensitive and unknown
 * directories preserve case. Ordinary Win32 paths also discard trailing dots
 * and spaces from the final name, while extended-length paths preserve them.
 */
export function stablePathKey(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);

	if (process.platform !== "win32") {
		let entryPath = resolvedPath;
		try {
			fs.lstatSync(entryPath);
			// Resolve existing entries before using their name so symlinks share
			// the canonical entry name without depending on the file's inode.
			entryPath = fs.realpathSync(entryPath);
		} catch {}
		const parentPath = path.dirname(entryPath);
		try {
			return path.join(fs.realpathSync(parentPath), path.basename(entryPath));
		} catch {
			return resolvedPath;
		}
	}

	let entryPath = resolvedPath;
	const fallbackPath = normalizeWindowsFinalEntryPath(resolvedPath);
	let parentPath = path.dirname(entryPath);
	let parentIdentity: { dev: bigint; ino: bigint } | undefined;
	try {
		const stats = fs.statSync(parentPath, { bigint: true });
		parentIdentity = { dev: stats.dev, ino: stats.ino };
	} catch {}
	let caseSensitiveDirectory = parentIdentity ? windowsDirectoryCaseSensitivity(parentPath) : undefined;

	// Unknown case semantics must stay conservative. In particular, a remote
	// share may be case-sensitive, and resolving an existing final entry could
	// change the key that was registered while that transcript was still missing.
	if (caseSensitiveDirectory !== undefined && parentIdentity?.ino !== 0n) {
		try {
			fs.lstatSync(entryPath);
			// Resolve existing entries so 8.3 aliases and symlinks share a canonical
			// entry name without depending on the replaceable file's inode.
			entryPath = fs.realpathSync(entryPath);
		} catch {}
		const canonicalParentPath = path.dirname(entryPath);
		if (canonicalParentPath !== parentPath) {
			parentPath = canonicalParentPath;
			parentIdentity = undefined;
			try {
				const stats = fs.statSync(parentPath, { bigint: true });
				parentIdentity = { dev: stats.dev, ino: stats.ino };
			} catch {}
			caseSensitiveDirectory = parentIdentity ? windowsDirectoryCaseSensitivity(parentPath) : undefined;
		}
	}

	let entryName = normalizeWindowsEntryName(path.basename(entryPath), resolvedPath);
	if (caseSensitiveDirectory === false) entryName = windowsOrdinalCaseFold(entryName) ?? entryName;
	if (parentIdentity && parentIdentity.ino !== 0n)
		return JSON.stringify([
			"win32-path-entry",
			parentIdentity.dev.toString(),
			parentIdentity.ino.toString(),
			entryName,
		]);
	if (caseSensitiveDirectory === false) {
		// The case rule applies to this directory's entries, not to its ancestors.
		// Preserve the canonical parent spelling and fold only the final name.
		try {
			parentPath = fs.realpathSync(parentPath);
		} catch {}
		return JSON.stringify(["win32-path-entry-fallback", parentPath, entryName]);
	}
	return fallbackPath;
}
