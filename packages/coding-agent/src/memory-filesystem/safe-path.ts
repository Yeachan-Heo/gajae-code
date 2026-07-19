import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
	FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH,
	FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES,
	FILESYSTEM_MEMORY_MAX_PATH_COMPONENTS,
	FILESYSTEM_MEMORY_MAX_READ_BYTES,
	type FilesystemMemoryOutcome,
} from "./contracts";

interface PathSnapshot {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

export interface SafeFilesystemMemoryRead {
	readonly path: string;
	readonly bytes: Uint8Array;
}

export interface SafeFilesystemMemoryCreatePath {
	readonly path: string;
	readonly parent: string;
}

export interface SafeFilesystemMemoryDirectoryEntry {
	readonly name: string;
	readonly type: "file" | "directory" | "symlink" | "other";
}

export interface SafeFilesystemMemoryDirectoryListing {
	readonly entries: readonly SafeFilesystemMemoryDirectoryEntry[];
	readonly truncated: boolean;
}

function directoryEntryType(stat: fs.BigIntStats): SafeFilesystemMemoryDirectoryEntry["type"] {
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	if (stat.isSymbolicLink()) return "symlink";
	return "other";
}

function validDirectoryComponents(components: readonly string[]): boolean {
	return components.length === 0 || isSafeRelativePath(components);
}

async function revalidateDirectory(pathname: string, expected: PathSnapshot): Promise<boolean> {
	try {
		const stat = await fsPromises.lstat(pathname, { bigint: true });
		return !stat.isSymbolicLink() && stat.isDirectory() && sameSnapshot(expected, snapshot(stat));
	} catch {
		return false;
	}
}

/** Lists direct children without following links and fails closed on detected directory topology changes. */
export async function listSafeFilesystemMemoryDirectory(
	root: string,
	components: readonly string[],
	maxEntries: number,
): Promise<FilesystemMemoryOutcome<SafeFilesystemMemoryDirectoryListing>> {
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES)
		return failure("invalid_path", "Directory entry limit is invalid.");
	const checked = await checkedPath(root, components, false);
	if (checked.code !== "ok") return checked;
	const expectedDirectory = checked.value.leaf ?? checked.value.ancestors[0];
	let initial: fs.BigIntStats;
	try {
		initial = await fsPromises.lstat(checked.value.path, { bigint: true });
	} catch {
		return failure("topology_changed", "Memory directory disappeared before listing.");
	}
	if (!initial.isDirectory() || initial.isSymbolicLink()) {
		return sameSnapshot(expectedDirectory, snapshot(initial))
			? failure("invalid_path", "Memory path is not a directory.")
			: failure("topology_changed", "Memory directory topology changed before listing.");
	}
	if (!sameSnapshot(expectedDirectory, snapshot(initial)))
		return failure("topology_changed", "Memory directory topology changed before listing.");
	let names: string[];
	try {
		names = (await fsPromises.readdir(checked.value.path)).sort((left, right) => left.localeCompare(right));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? failure("topology_changed", "Memory directory disappeared while listing.")
			: failure("permission_denied", "Memory directory cannot be listed safely.");
	}
	const selected = names.slice(0, maxEntries);
	const entries: SafeFilesystemMemoryDirectoryEntry[] = [];
	for (const name of selected) {
		if (!isSafeRelativePath([name])) return failure("topology_changed", "Memory directory entry is invalid.");
		try {
			entries.push({
				name,
				type: directoryEntryType(await fsPromises.lstat(path.join(checked.value.path, name), { bigint: true })),
			});
		} catch {
			return failure("topology_changed", "Memory directory changed while listing.");
		}
	}
	if (
		!(await revalidateDirectory(checked.value.path, expectedDirectory)) ||
		!(await revalidateAncestors(checked.value.canonicalRoot, components, checked.value.ancestors))
	)
		return failure("topology_changed", "Memory directory topology changed while listing.");
	return { code: "ok", value: { entries, truncated: names.length > maxEntries } };
}

function failure(
	code:
		| "invalid_path"
		| "not_found"
		| "not_regular_file"
		| "symlink_denied"
		| "outside_root"
		| "topology_changed"
		| "too_large"
		| "permission_denied",
	message: string,
): FilesystemMemoryOutcome<never> {
	return { code, message };
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafeRelativePath(components: readonly string[]): boolean {
	return (
		components.length > 0 &&
		components.length <= FILESYSTEM_MEMORY_MAX_PATH_COMPONENTS &&
		components.every(
			component =>
				component.length > 0 &&
				component.length <= FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH &&
				component !== "." &&
				component !== ".." &&
				!/[\\/\u0000-\u001f\u007f]/.test(component),
		)
	);
}

function snapshot(stat: fs.BigIntStats): PathSnapshot {
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

function sameSnapshot(left: PathSnapshot, right: PathSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function checkedPath(
	root: string,
	components: readonly string[],
	allowMissingLeaf: boolean,
): Promise<
	FilesystemMemoryOutcome<{
		path: string;
		canonicalRoot: string;
		ancestors: readonly PathSnapshot[];
		leaf: PathSnapshot | null;
	}>
> {
	if (!path.isAbsolute(root) || !validDirectoryComponents(components))
		return failure("invalid_path", "Path components are invalid.");
	let canonicalRoot: string;
	let rootSnapshot: PathSnapshot;
	try {
		const suppliedRoot = await fsPromises.lstat(root, { bigint: true });
		if (suppliedRoot.isSymbolicLink()) return failure("symlink_denied", "Memory root must not be a symbolic link.");
		if (!suppliedRoot.isDirectory()) return failure("invalid_path", "Memory root is not a directory.");
		canonicalRoot = await fsPromises.realpath(root);
		if (canonicalRoot !== path.resolve(root))
			return failure("symlink_denied", "Memory root contains a symbolic-link ancestor.");
		const rootStat = await fsPromises.lstat(canonicalRoot, { bigint: true });
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
			return failure("invalid_path", "Memory root is not a directory.");
		rootSnapshot = snapshot(rootStat);
	} catch {
		return failure("not_found", "Memory root does not exist.");
	}
	const candidate = path.resolve(canonicalRoot, ...components);
	if (!isInside(canonicalRoot, candidate)) return failure("outside_root", "Memory path escapes its root.");
	const ancestors: PathSnapshot[] = [rootSnapshot];
	let leaf: PathSnapshot | null = null;
	let current = canonicalRoot;
	for (let index = 0; index < components.length; index += 1) {
		current = path.join(current, components[index]);
		try {
			const stat = await fsPromises.lstat(current, { bigint: true });
			if (stat.isSymbolicLink()) return failure("symlink_denied", "Memory path contains a symbolic link.");
			if (index < components.length - 1 && !stat.isDirectory())
				return failure("invalid_path", "Memory path has a non-directory ancestor.");
			if (index < components.length - 1) ancestors.push(snapshot(stat));
			else leaf = snapshot(stat);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf && index === components.length - 1)
				return { code: "ok", value: { path: candidate, canonicalRoot, ancestors, leaf: null } };
			return failure("not_found", "Memory path does not exist.");
		}
	}
	return { code: "ok", value: { path: candidate, canonicalRoot, ancestors, leaf } };
}

async function revalidateAncestors(
	root: string,
	components: readonly string[],
	expected: readonly PathSnapshot[],
): Promise<boolean> {
	let current = root;
	for (let index = 0; index < expected.length; index += 1) {
		try {
			const stat = await fsPromises.lstat(current, { bigint: true });
			if (stat.isSymbolicLink() || !stat.isDirectory() || !sameSnapshot(expected[index], snapshot(stat)))
				return false;
		} catch {
			return false;
		}
		if (index < components.length - 1) current = path.join(current, components[index]);
	}
	return true;
}

/** Reads one regular file through a no-follow descriptor and rejects observed pathname topology changes. */
export async function readSafeFilesystemMemoryFile(
	root: string,
	components: readonly string[],
	maxBytes: number = FILESYSTEM_MEMORY_MAX_READ_BYTES,
): Promise<FilesystemMemoryOutcome<SafeFilesystemMemoryRead>> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FILESYSTEM_MEMORY_MAX_READ_BYTES)
		return failure("invalid_path", "Read byte limit is invalid.");
	const checked = await checkedPath(root, components, false);
	if (checked.code !== "ok") return checked;
	let handle: fsPromises.FileHandle | undefined;
	try {
		const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0));
		handle = await fsPromises.open(checked.value.path, flags);
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) return failure("not_regular_file", "Memory path is not a regular file.");
		if (!checked.value.leaf || !sameSnapshot(checked.value.leaf, snapshot(opened)))
			return failure("topology_changed", "Memory file changed while opening.");
		if (opened.size > BigInt(maxBytes)) return failure("too_large", "Memory file exceeds the read limit.");
		if (!(await revalidateAncestors(checked.value.canonicalRoot, components, checked.value.ancestors)))
			return failure("topology_changed", "Memory path topology changed while opening.");
		const before = snapshot(opened);
		const bytes = await handle.readFile();
		const after = snapshot(await handle.stat({ bigint: true }));
		if (bytes.length > maxBytes) return failure("too_large", "Memory file exceeds the read limit.");
		if (
			!sameSnapshot(before, after) ||
			!(await revalidateAncestors(checked.value.canonicalRoot, components, checked.value.ancestors))
		)
			return failure("topology_changed", "Memory file changed while reading.");
		return { code: "ok", value: { path: checked.value.path, bytes } };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP")
			return failure("symlink_denied", "Memory path resolved through a symbolic link.");
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return failure("topology_changed", "Memory path disappeared while opening.");
		return failure("permission_denied", "Memory file cannot be opened safely.");
	} finally {
		if (handle) await handle.close();
	}
}

export async function authorizeSafeFilesystemMemoryCreatePath(
	root: string,
	components: readonly string[],
): Promise<FilesystemMemoryOutcome<SafeFilesystemMemoryCreatePath>> {
	const checked = await checkedPath(root, components, true);
	if (checked.code !== "ok") return checked;
	try {
		await fsPromises.lstat(checked.value.path);
		return failure("invalid_path", "Memory file already exists.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return failure("permission_denied", "Memory file cannot be authorized.");
	}
	if (!(await revalidateAncestors(checked.value.canonicalRoot, components, checked.value.ancestors)))
		return failure("topology_changed", "Memory path topology changed before creation.");
	return { code: "ok", value: { path: checked.value.path, parent: path.dirname(checked.value.path) } };
}
