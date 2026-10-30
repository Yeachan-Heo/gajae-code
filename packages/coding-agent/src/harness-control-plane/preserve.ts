/**
 * Real dirty-worktree preservation (architect blocker B2).
 *
 * Before any destructive recovery on a dirty/unknown worktree, capture REAL evidence and a
 * recoverable snapshot WITHOUT mutating the working tree:
 *   - the tracked diff (`git diff HEAD`) + its sha256,
 *   - an untracked-file manifest (path/size/sha256),
 *   - a `git stash create` commit object stored in the stash list (`git stash store`),
 *     which snapshots tracked+staged changes without touching the worktree.
 *
 * This is what backs a valid `vanish` receipt so the data-loss invariant is enforced in
 * practice, not just structurally.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { GitDelta } from "./types";

export interface UntrackedEntry {
	path: string;
	size: number;
	sha256: string;
}

export interface PreserveResult {
	gitDelta: GitDelta;
	trackedDiff: string;
	trackedDiffSha256: string;
	untrackedManifest: UntrackedEntry[];
	stashRef: string | null;
	snapshotComplete: boolean;
}

function git(workspace: string, args: string[]): string {
	return execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function sha256(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Capture + snapshot a (possibly dirty) worktree without mutating it. Safe to call on a clean
 * tree (returns empty evidence). Never deletes, resets, or cleans.
 */
export function preserveDirtyWorktree(workspace: string): PreserveResult {
	let trackedDiff = "";
	try {
		trackedDiff = git(workspace, ["diff", "HEAD"]);
	} catch {
		trackedDiff = "";
	}

	let untracked: string[] = [];
	try {
		untracked = git(workspace, ["ls-files", "--others", "--exclude-standard"])
			.split("\n")
			.map(s => s.trim())
			.filter(Boolean);
	} catch {
		untracked = [];
	}

	const untrackedManifest: UntrackedEntry[] = [];
	for (const rel of untracked) {
		try {
			const buf = readFileSync(path.join(workspace, rel));
			untrackedManifest.push({ path: rel, size: buf.length, sha256: sha256(buf) });
		} catch {
			// unreadable entry — record path with a marker rather than dropping it
			untrackedManifest.push({ path: rel, size: -1, sha256: "unreadable" });
		}
	}

	// `git stash create` builds a stash commit WITHOUT modifying the working tree; store it so
	// it survives in the stash list as a recoverable ref. No-op (empty oid) on a clean tree.
	let stashRef: string | null = null;
	try {
		const oid = git(workspace, ["stash", "create", "harness-vanish-snapshot"]).trim();
		if (oid) {
			git(workspace, ["stash", "store", "-m", "harness-vanish-snapshot", oid]);
			stashRef = oid;
		}
	} catch {
		stashRef = null;
	}

	const dirty = trackedDiff.trim().length > 0 || untrackedManifest.length > 0;
	// snapshotComplete iff every dirty component is actually captured: tracked changes need a
	// stash ref, untracked entries need readable hashes.
	const trackedCaptured = trackedDiff.trim().length === 0 || stashRef !== null;
	const untrackedCaptured = untrackedManifest.every(e => e.sha256 !== "unreadable");
	return {
		gitDelta: dirty ? "dirty" : "clean",
		trackedDiff,
		trackedDiffSha256: sha256(trackedDiff),
		untrackedManifest,
		stashRef,
		snapshotComplete: trackedCaptured && untrackedCaptured,
	};
}
