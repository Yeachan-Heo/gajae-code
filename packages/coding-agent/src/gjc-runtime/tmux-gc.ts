/**
 * GC adapter for gjc-tagged tmux sessions. Stale iff `@gjc-project` path is gone
 * OR `@gjc-branch` has no live git worktree. Removal is a spec-authorized
 * destructive `kill-session`, gated by exact-target re-read + revalidation.
 */

import * as fs from "node:fs";

import { worktree } from "../utils/git";
import type { GcCollectResult, GcContext, GcPruneOutcome, GcRecord, GcStoreAdapter } from "./gc-runtime";
import { GJC_TMUX_PROFILE_VALUE } from "./tmux-common";
import {
	type GjcTmuxSessionStatus,
	type GjcTmuxSessionsForGc,
	listTmuxSessionsForGc,
	readTmuxSessionTagsForGc,
	removeGjcTmuxSession,
} from "./tmux-sessions";

const STORE = "tmux_sessions" as const;
const TOCTOU_SKIP = "tmux_revalidation_failed_or_became_live";

function pathExists(path: string): boolean {
	try {
		return fs.existsSync(path);
	} catch {
		return false;
	}
}

function detail(project?: string, branch?: string): string | undefined {
	const parts = [];
	if (project) parts.push(`project=${project}`);
	if (branch) parts.push(`branch=${branch}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function unclassifiedRecord(id: string, reason: string, project?: string, branch?: string): GcRecord {
	return {
		store: STORE,
		id,
		path: project,
		root: project,
		pid_status: "none",
		status: "unclassified",
		stale: false,
		removable: false,
		action: "none",
		reason,
		detail: detail(project, branch),
	};
}

function branchMatches(candidate: string | undefined, branch: string): boolean {
	if (!candidate) return false;
	const branchNames = new Set([
		branch,
		branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : `refs/heads/${branch}`,
	]);
	return branchNames.has(candidate);
}

async function hasLiveWorktreeForBranch(project: string, branch: string): Promise<boolean> {
	const entries = await worktree.list(project);
	return entries.some(entry => branchMatches(entry.branch, branch));
}

async function classifyTaggedSession(session: GjcTmuxSessionStatus): Promise<GcRecord> {
	const { name, project, branch } = session;
	if (!project || !branch) return unclassifiedRecord(name, "missing_project_or_branch_tag", project, branch);
	if (!pathExists(project)) {
		return {
			store: STORE,
			id: name,
			path: project,
			root: project,
			pid_status: "none",
			status: "stale",
			stale: true,
			removable: true,
			action: "none",
			reason: "project_missing",
			detail: detail(project, branch),
		};
	}
	if (!(await hasLiveWorktreeForBranch(project, branch))) {
		return {
			store: STORE,
			id: name,
			path: project,
			root: project,
			pid_status: "none",
			status: "stale",
			stale: true,
			removable: true,
			action: "none",
			reason: "branch_no_worktree",
			detail: detail(project, branch),
		};
	}
	return {
		store: STORE,
		id: name,
		path: project,
		root: project,
		pid_status: "none",
		status: "live",
		stale: false,
		removable: false,
		action: "none",
		reason: "project_and_branch_worktree_present",
		detail: detail(project, branch),
	};
}

async function revalidateRemovable(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
	const tags = readTmuxSessionTagsForGc(name, env);
	if (tags.profile !== GJC_TMUX_PROFILE_VALUE || !tags.project || !tags.branch) return false;
	if (!pathExists(tags.project)) return true;
	return !(await hasLiveWorktreeForBranch(tags.project, tags.branch));
}

export const tmuxSessionsGcAdapter: GcStoreAdapter = {
	store: STORE,
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcCollectResult["errors"] = [];
		let sessions: GjcTmuxSessionsForGc;
		try {
			sessions = listTmuxSessionsForGc(ctx.env);
		} catch (error) {
			return {
				records,
				errors: [
					{
						store: STORE,
						scope: "list_sessions",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}

		for (const session of sessions.tagged) {
			try {
				records.push(await classifyTaggedSession(session));
			} catch (error) {
				errors.push({
					store: STORE,
					scope: session.name,
					message: error instanceof Error ? error.message : String(error),
				});
				records.push(unclassifiedRecord(session.name, "worktree_list_failed", session.project, session.branch));
			}
		}

		for (const name of sessions.untagged) {
			records.push(unclassifiedRecord(name, "untagged_tmux_session"));
		}

		return { records, errors };
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		if (record.store !== STORE || record.status !== "stale" || !record.removable) {
			return { removed: false, skipped: "not_removable_tmux_session" };
		}
		try {
			if (!(await revalidateRemovable(record.id, ctx.env))) {
				return { removed: false, skipped: TOCTOU_SKIP };
			}
			removeGjcTmuxSession(record.id, ctx.env);
			return { removed: true };
		} catch (error) {
			return { removed: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
};
