/**
 * Where session claims live and how their files are named (design §2.2). A leaf module with no
 * native or storage imports, so `gjc doctor`'s worker can count sidecars without loading the
 * ownership core, and both read one definition.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The owners directory, relative to the trusted home. */
export const SESSION_OWNERS_RELATIVE_DIR = path.join(".gjc", "runtime", "session-owners");
export const SESSION_OWNER_SIDECAR_SUFFIX = ".session-owner";
export const SESSION_OWNER_RECORD_SUFFIX = ".owner.json";
/** A sidecar or record file name's key, as `sessionOwnerKey` produces it. */
export const SESSION_OWNER_KEY_NAME = /^(?:h-[0-9a-f]{32}|(?!h-)[a-z0-9_-]{1,128})$/;

export type SessionOwnerEntryKind =
	| { readonly kind: "sidecar"; readonly key: string }
	| { readonly kind: "record"; readonly key: string }
	| { readonly kind: "unrecognized" };

/** Classify one directory entry. Only a regular file with a well-formed key is a sidecar or record. */
export function classifySessionOwnerEntry(name: string, isFile: boolean): SessionOwnerEntryKind {
	if (isFile) {
		for (const [suffix, kind] of [
			[SESSION_OWNER_SIDECAR_SUFFIX, "sidecar"],
			[SESSION_OWNER_RECORD_SUFFIX, "record"],
		] as const) {
			if (!name.endsWith(suffix)) continue;
			const key = name.slice(0, -suffix.length);
			if (SESSION_OWNER_KEY_NAME.test(key)) return { kind, key };
		}
	}
	return { kind: "unrecognized" };
}

export interface SessionOwnerEntryCounts {
	readonly sidecars: number;
	readonly records: number;
	readonly unrecognized: number;
}

/** Count a directory's entries from `readdir` file types alone: no lock, no stat per entry. */
export function countSessionOwnerEntries(directory: string): SessionOwnerEntryCounts {
	const counts = { sidecars: 0, records: 0, unrecognized: 0 };
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const { kind } = classifySessionOwnerEntry(entry.name, entry.isFile());
		if (kind === "sidecar") counts.sidecars += 1;
		else if (kind === "record") counts.records += 1;
		else counts.unrecognized += 1;
	}
	return counts;
}
