/**
 * GC adapter for shell snapshot roots (`<tmp>/gjc-shell-snapshots-<pid>-<random>`).
 *
 * A session removes its own root through a postmortem hook. That hook does not
 * run when the process is killed or crashes, so leftover roots accumulate in
 * the OS temp directory. The owner pid in the root name makes the usual
 * liveness rule apply: a root is removable only when its owner is dead (ESRCH).
 * Roots created before the pid was encoded have no provable owner and are kept.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import type { GcCollectResult, GcContext, GcPruneOutcome, GcRecord, GcStoreAdapter } from "../gjc-runtime/gc-runtime";
import { gcPidStatusLabel } from "../gjc-runtime/gc-runtime";
import { SHELL_SNAPSHOT_ROOT_PREFIX, shellSnapshotRootOwnerPid } from "./shell-snapshot";

/** Bound the scan so a pathological temp directory cannot stall `gjc gc`. */
const MAX_ENTRIES = 50_000;

function tempRoot(env: NodeJS.ProcessEnv): string {
	return env.TMPDIR?.trim() || os.tmpdir();
}

function ownedByCurrentUser(stat: Stats): boolean {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

type Classified = Pick<GcRecord, "status" | "stale" | "reason" | "pid" | "pid_status">;

/** `null` when the root no longer exists. */
async function classify(dir: string, ctx: GcContext): Promise<Classified | null> {
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
	const pid = shellSnapshotRootOwnerPid(path.basename(dir));
	if (pid === undefined) {
		return {
			status: "unowned",
			stale: false,
			pid_status: "none",
			reason: "Created before snapshot roots recorded their owner; no owner to prove dead",
		};
	}
	const probe = ctx.probe(pid);
	const pidStatus = gcPidStatusLabel(probe);
	if (probe.status === "dead") {
		return { status: "dead", stale: true, pid, pid_status: pidStatus, reason: "Owner process is gone" };
	}
	return { status: pidStatus, stale: false, pid, pid_status: pidStatus, reason: "Owner process may still use it" };
}

export const shellSnapshotsGcAdapter: GcStoreAdapter = {
	store: "shell_snapshots",
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const result: GcCollectResult = { records, errors: [] };
		const root = tempRoot(ctx.env);

		let names: string[];
		try {
			names = (await fs.readdir(root)).filter(name => name.startsWith(SHELL_SNAPSHOT_ROOT_PREFIX));
		} catch (error) {
			if (!isEnoent(error)) result.errors.push({ store: "shell_snapshots", scope: root, message: String(error) });
			return result;
		}
		if (names.length > MAX_ENTRIES) {
			result.warnings = [
				{ store: "shell_snapshots", scope: root, message: `Scan truncated at ${MAX_ENTRIES} entries` },
			];
		}

		for (const name of names.slice(0, MAX_ENTRIES)) {
			const dir = path.join(root, name);
			try {
				const classified = await classify(dir, ctx);
				if (!classified) continue;
				records.push({
					store: "shell_snapshots",
					id: name,
					path: dir,
					...classified,
					removable: classified.stale,
					action: classified.stale ? "would_remove" : "none",
				});
			} catch (error) {
				result.errors.push({ store: "shell_snapshots", scope: dir, message: String(error) });
			}
		}
		return result;
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		const dir = record.path;
		if (!dir) return { removed: false, error: "Missing shell snapshot root path" };

		// Re-validate immediately before removing: the pid may have been reused,
		// or the path replaced, between collect and prune.
		let classified: Classified | null;
		try {
			classified = await classify(dir, ctx);
		} catch (error) {
			return { removed: false, error: String(error) };
		}
		if (!classified) return { removed: false, skipped: "Shell snapshot root disappeared" };
		if (!classified.stale) {
			return { removed: false, skipped: `Shell snapshot root no longer eligible (${classified.status})` };
		}

		try {
			await fs.rm(dir, { recursive: true, force: true });
			return { removed: true };
		} catch (error) {
			return { removed: false, error: String(error) };
		}
	},
};
