import * as fs from "node:fs/promises";
import * as path from "node:path";

const PRIVATE_DIRECTORY_MASK = 0o077;
const GROUP_OTHER_WRITE_MASK = 0o022;
const STICKY_BIT = 0o1000;

interface DirectorySnapshot {
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
	readonly mode: number;
}

interface CheckedFilePath {
	readonly filePath: string;
	readonly lexicalParent: string;
	readonly canonicalParent: string;
	readonly canonicalTarget: string | undefined;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
	);
}

function directoryAncestors(directory: string): string[] {
	const absolute = path.resolve(directory);
	const root = path.parse(absolute).root;
	const ancestors = [root];
	let current = root;
	for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		ancestors.push(current);
	}
	return ancestors;
}

function hasExpectedOwner(uid: number, owner: number): boolean {
	return owner === 0 || owner === uid;
}

async function inspectFilePath(filePath: string): Promise<CheckedFilePath> {
	if (!path.isAbsolute(filePath)) throw new Error("Configuration paths must be absolute");
	const absolutePath = path.resolve(filePath);
	const lexicalParent = path.dirname(absolutePath);
	const canonicalParent = await fs.realpath(lexicalParent);
	let canonicalTarget: string | undefined;
	try {
		await fs.lstat(absolutePath);
		canonicalTarget = await fs.realpath(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { filePath: absolutePath, lexicalParent, canonicalParent, canonicalTarget };
}

/**
 * Linux directory modes include the POSIX ACL mask, so denying group/other
 * access also denies named ACL grants. Other platforms are rejected because
 * Node does not expose enough ACL state to establish equivalent privacy.
 */
export async function isConfigHotReloadTrusted(paths: {
	readonly configPath: string;
	readonly modelsPath: string;
}): Promise<boolean> {
	if (process.platform !== "linux" || typeof process.getuid !== "function") return false;
	const uid = process.getuid();
	try {
		const checkedPaths = await Promise.all([inspectFilePath(paths.configPath), inspectFilePath(paths.modelsPath)]);
		const effectiveDirectories = new Set<string>();
		const directoriesToCheck = new Set<string>();
		for (const checked of checkedPaths) {
			effectiveDirectories.add(checked.canonicalParent);
			directoriesToCheck.add(checked.lexicalParent);
			directoriesToCheck.add(checked.canonicalParent);
			if (checked.canonicalTarget) {
				const targetParent = path.dirname(checked.canonicalTarget);
				effectiveDirectories.add(targetParent);
				directoriesToCheck.add(targetParent);
			}
		}
		for (const directory of [...directoriesToCheck]) {
			for (const ancestor of directoryAncestors(directory)) directoriesToCheck.add(ancestor);
		}

		const snapshots = new Map<string, DirectorySnapshot>();
		for (const directory of directoriesToCheck) {
			const stat = await fs.stat(directory);
			if (!stat.isDirectory()) return false;
			snapshots.set(directory, { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
		}

		for (const directory of effectiveDirectories) {
			const snapshot = snapshots.get(directory);
			if (!snapshot || snapshot.uid !== uid || (snapshot.mode & PRIVATE_DIRECTORY_MASK) !== 0) return false;
		}

		for (const directory of directoriesToCheck) {
			const snapshot = snapshots.get(directory)!;
			if (!hasExpectedOwner(uid, snapshot.uid)) return false;
			if ((snapshot.mode & GROUP_OTHER_WRITE_MASK) === 0) continue;
			const safelyContainsPrivateLeaf =
				snapshot.uid === 0 &&
				(snapshot.mode & STICKY_BIT) !== 0 &&
				[...effectiveDirectories].some(leaf => isStrictDescendant(directory, leaf));
			if (!safelyContainsPrivateLeaf) return false;
		}

		// Confirm symlink resolution and directory identity stayed stable while checking metadata.
		for (const checked of checkedPaths) {
			if ((await fs.realpath(checked.lexicalParent)) !== checked.canonicalParent) return false;
			try {
				await fs.lstat(checked.filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || checked.canonicalTarget !== undefined) {
					return false;
				}
				continue;
			}
			if (checked.canonicalTarget === undefined) return false;
			if ((await fs.realpath(checked.filePath)) !== checked.canonicalTarget) return false;
		}
		for (const [directory, snapshot] of snapshots) {
			const stat = await fs.stat(directory);
			if (
				!stat.isDirectory() ||
				stat.dev !== snapshot.dev ||
				stat.ino !== snapshot.ino ||
				stat.uid !== snapshot.uid ||
				stat.mode !== snapshot.mode
			) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}
