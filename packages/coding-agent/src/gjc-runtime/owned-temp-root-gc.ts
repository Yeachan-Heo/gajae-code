/**
 * GC adapters for per-process temp roots named `<prefix><owner pid>-<random>`
 * (see `owned-temp-root.ts`).
 *
 * A root is removable only when its owner pid probes dead (ESRCH). Roots made
 * before the pid was encoded have no provable owner and are kept, as are
 * symlinks, non-directories and other users' directories.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import type { GcCollectResult, GcContext, GcPruneOutcome, GcRecord, GcStoreAdapter } from "./gc-runtime";
import { gcPidStatusLabel } from "./gc-runtime";
import {
	OWNED_TEMP_ROOT_PREFIXES,
	type OwnedTempRootKind,
	ownedTempRootOwnerPid,
	resolveTempRoot,
} from "./owned-temp-root";

/** Bound the scan so a pathological temp directory cannot stall `gjc gc`. */
const MAX_ENTRIES = 50_000;

function tempRoot(env: NodeJS.ProcessEnv, platform: string = process.platform): string {
	return resolveTempRoot(env, platform);
}

function ownedByCurrentUser(stat: Stats): boolean {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

type Classified = Pick<GcRecord, "status" | "stale" | "reason" | "pid" | "pid_status">;

/** `null` when the root no longer exists. */
async function classify(kind: OwnedTempRootKind, dir: string, ctx: GcContext): Promise<Classified | null> {
	let stat: Stats;
	try {
		stat = await fs.lstat(dir);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	if (!stat.isDirectory()) {
		return { status: "not_directory", stale: false, reason: "Not a real directory (symlink or file)" };
	}
	if (!ownedByCurrentUser(stat)) {
		return { status: "foreign_owner", stale: false, reason: "Owned by another user" };
	}
	const pid = ownedTempRootOwnerPid(kind, path.basename(dir));
	if (pid === undefined) {
		return {
			status: "unowned",
			stale: false,
			pid_status: "none",
			reason: "Created before temp roots recorded their owner; no owner to prove dead",
		};
	}
	const probe = ctx.probe(pid);
	const pidStatus = gcPidStatusLabel(probe);
	if (probe.status === "dead") {
		return { status: "dead", stale: true, pid, pid_status: pidStatus, reason: "Owner process is gone" };
	}
	return { status: pidStatus, stale: false, pid, pid_status: pidStatus, reason: "Owner process may still use it" };
}

function createOwnedTempRootGcAdapterInternal(
	kind: OwnedTempRootKind,
	platform: string = process.platform,
): GcStoreAdapter {
	const prefix = OWNED_TEMP_ROOT_PREFIXES[kind];
	return {
		store: kind,
		async collect(ctx: GcContext): Promise<GcCollectResult> {
			const records: GcRecord[] = [];
			const result: GcCollectResult = { records, errors: [] };
			const root = tempRoot(ctx.env, platform);

			let names: string[];
			try {
				names = (await fs.readdir(root)).filter(name => name.startsWith(prefix));
			} catch (error) {
				if (!isEnoent(error)) result.errors.push({ store: kind, scope: root, message: String(error) });
				return result;
			}
			if (names.length > MAX_ENTRIES) {
				result.warnings = [{ store: kind, scope: root, message: `Scan truncated at ${MAX_ENTRIES} entries` }];
			}

			for (const name of names.slice(0, MAX_ENTRIES)) {
				const dir = path.join(root, name);
				try {
					const classified = await classify(kind, dir, ctx);
					if (!classified) continue;
					records.push({
						store: kind,
						id: name,
						path: dir,
						...classified,
						removable: classified.stale,
						action: classified.stale ? "would_remove" : "none",
					});
				} catch (error) {
					result.errors.push({ store: kind, scope: dir, message: String(error) });
				}
			}
			return result;
		},
		async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
			const dir = record.path;
			if (!dir) return { removed: false, error: "Missing temp root path" };

			// Re-validate immediately before removing: the pid may have been reused,
			// or the path replaced, between collect and prune.
			let classified: Classified | null;
			try {
				classified = await classify(kind, dir, ctx);
			} catch (error) {
				return { removed: false, error: String(error) };
			}
			if (!classified) return { removed: false, skipped: "Temp root disappeared" };
			if (!classified.stale) {
				return { removed: false, skipped: `Temp root no longer eligible (${classified.status})` };
			}

			try {
				await fs.rm(dir, { recursive: true, force: true });
				return { removed: true };
			} catch (error) {
				return { removed: false, error: String(error) };
			}
		},
	};
}

export function createOwnedTempRootGcAdapter(kind: OwnedTempRootKind): GcStoreAdapter {
	return createOwnedTempRootGcAdapterInternal(kind);
}

/** @internal Test-only: create adapter with injected platform for testing Windows precedence. */
export function createOwnedTempRootGcAdapterForTest(kind: OwnedTempRootKind, platform: string): GcStoreAdapter {
	return createOwnedTempRootGcAdapterInternal(kind, platform);
}
