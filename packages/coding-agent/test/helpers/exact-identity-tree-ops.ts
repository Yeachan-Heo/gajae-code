import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	NativeDirectoryTreeEntry,
	NativeDirectoryTreeResult,
	NativeDirectoryTreeSnapshot,
	NativeExactUnlinkResult,
} from "@gajae-code/natives";

/**
 * Shared tree-walk implementations for the identity-tree test doubles.
 *
 * One source of truth serves both shapes: the synchronous doubles and the
 * worker-thread doubles below, so the two can never drift apart.
 */

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sha256Of(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function treeEntries(root: string, relativePath: string, into: NativeDirectoryTreeEntry[]): string | undefined {
	const absolute = relativePath === "" ? root : path.join(root, relativePath);
	const stat = fs.lstatSync(absolute, { bigint: true });
	if (stat.isSymbolicLink()) return "reparse_point";
	if (!stat.isDirectory() && !stat.isFile()) return "unsupported_entry";
	const bytes = stat.isFile() ? fs.readFileSync(absolute) : undefined;
	into.push({
		relativePath,
		kind: stat.isDirectory() ? "directory" : "file",
		dev: String(stat.dev),
		ino: String(stat.ino),
		nlink: String(stat.nlink),
		size: String(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
		...(bytes ? { sha256: sha256Of(bytes) } : {}),
	});
	if (!stat.isDirectory()) return undefined;
	for (const name of fs.readdirSync(absolute).sort()) {
		const failure = treeEntries(root, relativePath === "" ? name : `${relativePath}/${name}`, into);
		if (failure) return failure;
	}
	return undefined;
}

export function snapshotDirectoryTreeOp(root: string): NativeDirectoryTreeResult {
	const entries: NativeDirectoryTreeEntry[] = [];
	try {
		const failure = treeEntries(root, "", entries);
		if (failure) return { ok: false, code: failure };
	} catch (error) {
		return isEnoent(error) ? { ok: false, code: "not_found" } : { ok: false, code: "io_error" };
	}
	const rootEntry = entries[0];
	if (rootEntry?.kind !== "directory") return { ok: false, code: "not_a_directory" };
	return { ok: true, snapshot: { rootDev: rootEntry.dev, rootIno: rootEntry.ino, entries } };
}

export function exactRemoveDirectoryTreeOp(
	root: string,
	snapshot: NativeDirectoryTreeSnapshot,
): NativeExactUnlinkResult {
	const observed = snapshotDirectoryTreeOp(root);
	if (!observed.ok || !observed.snapshot) return { ok: false, code: observed.code ?? "io_error" };
	// Byte-for-byte tree equality: a changed owner token, an added payload, a replaced
	// inode, and a wholesale re-creation are all the same verdict — not ours to delete.
	if (JSON.stringify(observed.snapshot) !== JSON.stringify(snapshot)) return { ok: false, code: "identity_mismatch" };
	fs.rmSync(root, { recursive: true });
	return { ok: true, detachedPath: `${root}.removing` };
}
