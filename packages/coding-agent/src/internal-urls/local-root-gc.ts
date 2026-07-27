import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import type { GcCollectResult, GcContext, GcError, GcRecord, GcStoreAdapter } from "../gjc-runtime/gc-runtime";

/**
 * GC for `local://` session roots.
 *
 * `resolveLocalRoot` gives every session its own `<tmp>/gjc-local/<session-id>`
 * directory, and the first `local://` resolution seeds it with a migration
 * marker. Nothing ever removes those directories, so a machine accumulates one
 * per session indefinitely — and the overwhelming majority only ever hold the
 * marker, because most sessions never write a `local://` file.
 *
 * Only marker-only directories are eligible, and only after a grace period.
 * That keeps the rule provably safe without needing a session-liveness oracle:
 * a directory holding real content is never touched, and a session that just
 * started is still inside its grace window.
 */

const LOCAL_ROOT_PARENT = "gjc-local";
const LEGACY_MIGRATION_MARKER = ".gjc-local-legacy-migrated-v1";

/** Directories younger than this are left alone so a live session is never raced. */
const GRACE_MS = 24 * 60 * 60 * 1000;

/** Bound the scan so a pathological directory cannot stall `gjc gc`. */
const MAX_ENTRIES = 20_000;

function localRootParent(env: NodeJS.ProcessEnv): string {
	return path.join(env.TMPDIR?.trim() || os.tmpdir(), LOCAL_ROOT_PARENT);
}

/** A root is prunable only when the marker is the single thing inside it. */
async function classify(dir: string, now: number): Promise<{ status: string; stale: boolean; reason: string } | null> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}

	const extra = entries.filter(name => name !== LEGACY_MIGRATION_MARKER);
	if (extra.length > 0)
		return {
			status: "in_use",
			stale: false,
			reason: `Holds ${extra.length} entr${extra.length === 1 ? "y" : "ies"} beyond the marker`,
		};

	const stat = await fs.stat(dir);
	if (now - stat.mtimeMs < GRACE_MS) return { status: "recent", stale: false, reason: "Inside the grace window" };
	return { status: "marker_only", stale: true, reason: "Only the migration marker, past the grace window" };
}

export const localRootsGcAdapter: GcStoreAdapter = {
	store: "local_roots",
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcError[] = [];
		const parent = localRootParent(ctx.env);
		const now = Date.now();

		let dirents: string[];
		try {
			dirents = await fs.readdir(parent);
		} catch (error) {
			if (isEnoent(error)) return { records, errors };
			errors.push({ store: "local_roots", scope: parent, message: (error as Error).message });
			return { records, errors };
		}

		for (const name of dirents.slice(0, MAX_ENTRIES)) {
			const dir = path.join(parent, name);
			try {
				const classified = await classify(dir, now);
				if (!classified) continue;
				records.push({
					store: "local_roots",
					id: name,
					path: dir,
					status: classified.status,
					stale: classified.stale,
					removable: classified.stale,
					action: classified.stale ? "would_remove" : "none",
					reason: classified.reason,
				});
			} catch (error) {
				errors.push({ store: "local_roots", scope: dir, message: (error as Error).message });
			}
		}

		if (dirents.length > MAX_ENTRIES) {
			errors.push({
				store: "local_roots",
				scope: parent,
				message: `Scan truncated at ${MAX_ENTRIES} entries`,
			});
		}

		return { records, errors };
	},
	async prune(record: GcRecord) {
		const dir = record.path;
		if (!dir) return { removed: false, error: "Missing local root path" };

		// Re-validate immediately before removing: the session may have written a
		// file between collect and prune.
		let classified: Awaited<ReturnType<typeof classify>>;
		try {
			classified = await classify(dir, Date.now());
		} catch (error) {
			return { removed: false, error: (error as Error).message };
		}
		if (!classified) return { removed: false, skipped: "Local root disappeared" };
		if (!classified.stale) return { removed: false, skipped: `Local root no longer eligible (${classified.status})` };

		try {
			await fs.rm(dir, { recursive: true, force: true });
			return { removed: true };
		} catch (error) {
			return { removed: false, error: (error as Error).message };
		}
	},
};
