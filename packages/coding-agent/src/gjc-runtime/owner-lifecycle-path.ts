/**
 * Pathname checks shared by every writer of a tmux owner lifecycle root. This
 * module stays free of session storage so the machine-facing isolation protocol
 * can use it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Windows links (symlinks, junctions, other reparse points) follow their own
 * native policy; these pathname checks cover POSIX platforms.
 */
const CHECKS_PATHNAMES = process.platform !== "win32";

/**
 * The spelling the native no-follow walk inspects: on macOS it reads the system
 * aliases `/var`, `/tmp` and `/etc` as their `/private` targets, so those are the
 * only links it accepts.
 */
function nativeWalkPath(target: string): string {
	if (process.platform !== "darwin") return target;
	for (const alias of ["/var", "/tmp", "/etc"]) {
		if (target === alias || target.startsWith(`${alias}/`)) return `/private${target}`;
	}
	return target;
}

/**
 * Refuse a path whose existing components are not all real directories, checked
 * from the filesystem root with `lstat`. The walk stops at the first missing
 * component, which the caller may then create. This is a pathname check: a
 * component swapped after it was inspected is not detected.
 */
export function assertNoLinkedComponent(target: string): void {
	const walked = nativeWalkPath(target);
	let current = path.parse(walked).root;
	for (const component of walked.slice(current.length).split(path.sep)) {
		if (component === "") continue;
		current = path.join(current, component);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!stat.isDirectory()) throw new Error("owner_lifecycle_root_unsafe");
	}
}

/**
 * Create or accept a lifecycle root for a writer that is about to put files in
 * it. Returns false, before anything is created, when an existing component of
 * the path is a link or not a directory. A missing root and its missing
 * ancestors are created owner-only. An existing root's mode is left as it is:
 * owner-only verification belongs to the callers that already require it.
 */
export function ensureOwnerLifecycleDirectorySync(root: string): boolean {
	const target = path.resolve(root);
	try {
		if (CHECKS_PATHNAMES) assertNoLinkedComponent(target);
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether an existing lifecycle file may be opened by pathname: a regular file
 * with a single link, so neither a symlink nor a hardlink redirects the open.
 * Like the walk, this is a pathname check and does not open the file.
 */
export function isPlainOwnerLifecycleFile(file: string): boolean {
	if (!CHECKS_PATHNAMES) return true;
	try {
		const stat = fs.lstatSync(file);
		return stat.isFile() && stat.nlink === 1;
	} catch {
		return false;
	}
}
