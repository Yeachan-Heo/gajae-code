/**
 * GC adapter for config file-locks (`<file>.lock` dirs holding `{pid, timestamp}`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, isEnoent } from "@gajae-code/utils";
import type {
	GcCollectResult,
	GcContext,
	GcError,
	GcPruneOutcome,
	GcRecord,
	GcStoreAdapter,
} from "../gjc-runtime/gc-runtime";
import { gcPidStatusLabel } from "../gjc-runtime/gc-runtime";
import { resolveReceiptSpoolDir } from "../harness-control-plane/receipt-spool";
import { readFileLockInfoForGc, removeFileLockDirForGc } from "./file-lock";

const MAX_WALK_DEPTH = 6;
const MAX_WALK_ENTRIES = 20_000;

// High-cardinality, lock-free subtrees we never descend into. `.lock` dirs are
// created next to config files, never inside these.
const PRUNED_DIR_NAMES = new Set(["sessions", "node_modules", ".git", "blobs", "artifacts", "receipts", "events"]);

interface WalkState {
	entries: number;
	truncated: boolean;
}

// Global, env-aware GJC lock roots. Per the approved scope this covers the
// user config root, the agent dir (honors GJC_CODING_AGENT_DIR), and the
// configured receipt-spool dir — NOT the invocation cwd's project `.gjc`.
function knownFileLockRoots(ctx: GcContext): string[] {
	const roots = [getConfigRootDir(), getAgentDir()];
	const spoolDir = resolveReceiptSpoolDir(ctx.env);
	if (spoolDir) roots.push(spoolDir);
	return Array.from(new Set(roots.map(root => path.resolve(root))));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function keptMalformedRecord(lockDir: string): GcRecord {
	return {
		store: "file_locks",
		id: lockDir,
		path: lockDir,
		pid_status: "none",
		status: "malformed",
		stale: false,
		removable: false,
		action: "none",
		reason: "missing_or_malformed_file_lock_info",
	};
}

async function collectLockRecord(lockDir: string, ctx: GcContext): Promise<GcRecord> {
	const info = await readFileLockInfoForGc(lockDir);
	if (!info) return keptMalformedRecord(lockDir);

	const probeResult = ctx.probe(info.pid);
	const pidStatus = gcPidStatusLabel(probeResult);
	const removable = probeResult.status === "dead";

	return {
		store: "file_locks",
		id: lockDir,
		path: lockDir,
		pid: info.pid,
		pid_status: pidStatus,
		status: pidStatus,
		stale: removable,
		removable,
		action: "none",
		reason: removable ? "file_lock_owner_pid_dead" : `file_lock_owner_pid_${pidStatus}`,
		detail: `timestamp=${info.timestamp}`,
	};
}

async function walkForLockDirs(
	dir: string,
	depth: number,
	state: WalkState,
	lockDirs: Set<string>,
	errors: GcError[],
): Promise<void> {
	if (state.entries >= MAX_WALK_ENTRIES) {
		state.truncated = true;
		return;
	}

	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(dir);
	} catch (error) {
		if (isEnoent(error)) return;
		errors.push({ store: "file_locks", scope: dir, message: errorMessage(error) });
		return;
	}

	state.entries++;
	if (!stat.isDirectory() || stat.isSymbolicLink()) return;

	if (path.basename(dir).endsWith(".lock")) {
		lockDirs.add(dir);
		return;
	}

	if (depth >= MAX_WALK_DEPTH) return;

	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return;
		errors.push({ store: "file_locks", scope: dir, message: errorMessage(error) });
		return;
	}

	for (const entry of entries) {
		if (state.entries >= MAX_WALK_ENTRIES) {
			state.truncated = true;
			return;
		}
		if (PRUNED_DIR_NAMES.has(entry)) continue;
		await walkForLockDirs(path.join(dir, entry), depth + 1, state, lockDirs, errors);
	}
}

export const fileLocksGcAdapter: GcStoreAdapter = {
	store: "file_locks",
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcError[] = [];
		const lockDirs = new Set<string>();
		const state: WalkState = { entries: 0, truncated: false };

		for (const root of knownFileLockRoots(ctx)) {
			await walkForLockDirs(root, 0, state, lockDirs, errors);
			if (state.truncated) break;
		}

		if (state.truncated) {
			errors.push({
				store: "file_locks",
				scope: "discovery",
				message: `file lock discovery capped at ${MAX_WALK_ENTRIES} entries`,
			});
		}

		for (const lockDir of lockDirs) {
			try {
				records.push(await collectLockRecord(lockDir, ctx));
			} catch (error) {
				errors.push({ store: "file_locks", scope: lockDir, message: errorMessage(error) });
			}
		}

		return { records, errors };
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		const lockDir = record.path ?? record.id;
		const info = await readFileLockInfoForGc(lockDir);
		if (!info) return { removed: false, skipped: "lock_no_longer_dead_or_missing" };

		const probeResult = ctx.probe(info.pid);
		if (probeResult.status !== "dead") {
			return { removed: false, skipped: "lock_no_longer_dead_or_missing" };
		}

		try {
			await removeFileLockDirForGc(lockDir);
			return { removed: true };
		} catch (error) {
			return { removed: false, error: errorMessage(error) };
		}
	},
};
