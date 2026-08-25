/**
 * Official GC of already-quarantined empty `.gjc-delete-*` receipts.
 * Roots are operator operands — never hardcoded host paths.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const EMPTY_DELETE_PREFIX = ".gjc-delete-";

export interface EmptyDeleteIdentity {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
}

export interface EmptyDeleteGcRecord {
	root: string;
	path: string;
	action: "would_remove" | "removed" | "kept" | "skipped";
	reason: string;
	identity?: EmptyDeleteIdentity;
}

export interface EmptyDeleteGcReport {
	dry_run: boolean;
	roots: string[];
	records: EmptyDeleteGcRecord[];
	would_remove: number;
	removed: number;
	kept: number;
	skipped: number;
	errors: string[];
}

export interface EmptyDeleteGcOptions {
	roots: string[];
	prune: boolean;
}

function isUnsafeName(name: string): boolean {
	return name.includes("/") || name.includes("\0") || name === "." || name === "..";
}

function identityOf(stat: { dev: bigint; ino: bigint; nlink: bigint; size: bigint; mtimeNs: bigint }): EmptyDeleteIdentity {
	return {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
	};
}

function sameIdentity(left: EmptyDeleteIdentity, right: EmptyDeleteIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

export async function collectEmptyDeleteReceipts(root: string): Promise<EmptyDeleteGcRecord[]> {
	const records: EmptyDeleteGcRecord[] = [];
	let rootStat;
	try {
		rootStat = await fs.lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [{ root, path: root, action: "skipped", reason: "missing_root" }];
		}
		throw error;
	}
	if (rootStat.isSymbolicLink()) {
		return [{ root, path: root, action: "skipped", reason: "symlink_root" }];
	}
	if (!rootStat.isDirectory()) {
		return [{ root, path: root, action: "skipped", reason: "not_directory" }];
	}
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [{ root, path: root, action: "skipped", reason: "missing_root" }];
		}
		throw error;
	}
	for (const name of names) {
		if (isUnsafeName(name) || !name.startsWith(EMPTY_DELETE_PREFIX)) continue;
		const file = path.join(root, name);
		let stat;
		try {
			stat = await fs.lstat(file, { bigint: true });
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) {
			records.push({ root, path: file, action: "kept", reason: "symlink" });
			continue;
		}
		if (!stat.isFile()) {
			records.push({ root, path: file, action: "kept", reason: "not_regular" });
			continue;
		}
		if (stat.size !== 0n) {
			records.push({ root, path: file, action: "kept", reason: "non_empty" });
			continue;
		}
		if (stat.nlink !== 1n) {
			records.push({ root, path: file, action: "kept", reason: "nlink" });
			continue;
		}
		records.push({
			root,
			path: file,
			action: "would_remove",
			reason: "empty_delete_receipt",
			identity: identityOf(stat),
		});
	}
	return records;
}

export async function runEmptyDeleteGc(options: EmptyDeleteGcOptions): Promise<EmptyDeleteGcReport> {
	const report: EmptyDeleteGcReport = {
		dry_run: !options.prune,
		roots: options.roots,
		records: [],
		would_remove: 0,
		removed: 0,
		kept: 0,
		skipped: 0,
		errors: [],
	};
	for (const root of options.roots) {
		let records: EmptyDeleteGcRecord[];
		try {
			records = await collectEmptyDeleteReceipts(root);
		} catch (error) {
			report.errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const record of records) {
			if (record.action === "would_remove" && options.prune) {
				try {
					const restat = await fs.lstat(record.path, { bigint: true });
					if (
						restat.isSymbolicLink() ||
						!restat.isFile() ||
						restat.size !== 0n ||
						restat.nlink !== 1n ||
						!record.identity ||
						!sameIdentity(record.identity, identityOf(restat))
					) {
						record.action = "kept";
						record.reason = "identity_drift";
					} else {
						await fs.unlink(record.path);
						record.action = "removed";
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						record.action = "skipped";
						record.reason = "gone";
					} else {
						record.action = "kept";
						record.reason = `unlink_failed:${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}
			report.records.push(record);
			if (record.action === "would_remove") report.would_remove += 1;
			else if (record.action === "removed") report.removed += 1;
			else if (record.action === "skipped") report.skipped += 1;
			else report.kept += 1;
		}
	}
	return report;
}
