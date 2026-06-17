/**
 * GC adapter for gjc-tagged tmux sessions. Destructive cleanup is authorized
 * only for detached pane-less sessions whose exact runtime marker revalidates a
 * terminal state. Project/branch/orphan heuristics are discovery signals only.
 */

import * as fs from "node:fs";

import { worktree } from "../utils/git";
import type { GcCollectResult, GcContext, GcPruneOutcome, GcRecord, GcStoreAdapter } from "./gc-runtime";
import { readTerminalRuntimeStateMarker } from "./session-state-sidecar";
import { GJC_TMUX_PROFILE_VALUE, GJC_TMUX_SESSION_PREFIX } from "./tmux-common";
import {
	type GjcTmuxSessionStatus,
	type GjcTmuxSessionsForGc,
	listTmuxSessionsForGc,
	readTmuxSessionTagsForGc,
	removeGjcTmuxSession,
} from "./tmux-sessions";

const STORE = "tmux_sessions" as const;
const TOCTOU_SKIP = "tmux_revalidation_failed_or_became_live";
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

function isSessionLive(session: Pick<GjcTmuxSessionStatus, "attached" | "panePids">): boolean {
	return session.attached || session.panePids.length > 0;
}

function liveRecord(session: GjcTmuxSessionStatus, reason: string): GcRecord {
	return {
		store: STORE,
		id: session.name,
		path: session.project,
		root: session.project,
		pid_status: "alive",
		status: "live",
		stale: false,
		removable: false,
		action: "none",
		reason,
		detail: detail(session.project, session.branch),
	};
}

function staleRecord(session: GjcTmuxSessionStatus, reason: string): GcRecord {
	return {
		store: STORE,
		id: session.name,
		path: session.project,
		root: session.project,
		pid_status: "none",
		status: "stale",
		stale: true,
		removable: true,
		action: "none",
		reason,
		detail: `${detail(session.project, session.branch) ?? ""} createdAt=${session.createdAt}`.trim(),
	};
}

async function hasTerminalRuntimeMarker(input: {
	sessionId?: string | null;
	sessionStateFile?: string | null;
	project?: string | null;
}): Promise<boolean> {
	const marker = await readTerminalRuntimeStateMarker({
		stateFile: input.sessionStateFile,
		sessionId: input.sessionId,
		cwd: input.project,
	});
	return marker.terminal;
}

function isOldEnoughForOrphanGc(session: GjcTmuxSessionStatus): boolean {
	const createdAt = Date.parse(session.createdAt);
	return Number.isFinite(createdAt) && Date.now() - createdAt >= ORPHAN_MAX_AGE_MS;
}

function isGjcOwnedOrphan(session: GjcTmuxSessionStatus): boolean {
	return session.name.startsWith(GJC_TMUX_SESSION_PREFIX) || session.name === "gajae_code";
}

async function classifyTaggedSession(session: GjcTmuxSessionStatus): Promise<GcRecord> {
	const { name, project, branch } = session;
	if (isSessionLive(session)) return liveRecord(session, "tmux_session_attached_or_has_live_panes");
	if (await hasTerminalRuntimeMarker(session))
		return staleRecord(session, "terminal_runtime_marker_detached_idle_session");
	if (!project || !branch) {
		const reason =
			isGjcOwnedOrphan(session) && isOldEnoughForOrphanGc(session)
				? "metadata_less_gjc_owned_idle_orphan_missing_terminal_marker"
				: "missing_project_or_branch_tag";
		return unclassifiedRecord(name, reason, project, branch);
	}
	if (!pathExists(project))
		return unclassifiedRecord(name, "project_missing_without_terminal_marker", project, branch);
	if (!(await hasLiveWorktreeForBranch(project, branch)))
		return unclassifiedRecord(name, "branch_no_worktree_without_terminal_marker", project, branch);
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

function classifyUntaggedSession(session: GjcTmuxSessionStatus): GcRecord {
	return unclassifiedRecord(session.name, "untagged_tmux_session");
}

async function revalidateRemovable(record: GcRecord, env: NodeJS.ProcessEnv): Promise<boolean> {
	const tags = readTmuxSessionTagsForGc(record.id, env);
	if (
		tags.createdAt &&
		record.detail?.includes("createdAt=") &&
		!record.detail.includes(`createdAt=${tags.createdAt}`)
	) {
		return false;
	}
	if (tags.attached || (tags.panePids?.length ?? 0) > 0) return false;
	if (tags.profile !== GJC_TMUX_PROFILE_VALUE) return false;
	return await hasTerminalRuntimeMarker(tags);
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

		for (const session of sessions.untagged) {
			records.push(classifyUntaggedSession(session));
		}

		return { records, errors };
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		if (record.store !== STORE || record.status !== "stale" || !record.removable) {
			return { removed: false, skipped: "not_removable_tmux_session" };
		}
		try {
			if (!(await revalidateRemovable(record, ctx.env))) {
				return { removed: false, skipped: TOCTOU_SKIP };
			}
			removeGjcTmuxSession(record.id, ctx.env);
			return { removed: true };
		} catch (error) {
			return { removed: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
};
