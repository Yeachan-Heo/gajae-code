import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MANAGED_ARTIFACT_MAX_TOTAL_BYTES } from "../session/internal/managed-session-storage";

/**
 * Managed-scope capacity reporting for `gjc gc`.
 *
 * A managed session scope is snapshotted in full every time a session starts,
 * and the snapshot fails closed once the tree exceeds the managed byte budget.
 * The scope is filled by GJC's own session records, so a heavily used working
 * directory can cross the budget without the operator doing anything unusual —
 * and the first symptom is a launch that aborts, with no prior warning.
 *
 * `gjc gc` already reports on state the operator cannot see, so surfacing scope
 * usage here gives that warning a home. This module only measures; nothing in
 * the gc prune path acts on what it reports.
 */

/** Directory walk ceiling. Bounds a pathological scope; reported when hit. */
const MAX_WALK_ENTRIES = 200_000;

/** Report a scope once it passes this share of the budget. */
const NOTICE_RATIO = 0.75;

export type GcSessionScopeStatus = "ok" | "approaching_limit" | "over_limit" | "unavailable";

export interface GcSessionScopeUsage {
	status: GcSessionScopeStatus;
	/** Absolute path of the managed scope for the current working directory. */
	path: string;
	total_bytes: number;
	limit_bytes: number;
	entries: number;
	/** True when the walk stopped at `MAX_WALK_ENTRIES`, so totals are a floor. */
	truncated: boolean;
	reason?: string;
}

interface WalkTotals {
	bytes: number;
	entries: number;
	truncated: boolean;
}

async function walk(root: string): Promise<WalkTotals> {
	const totals: WalkTotals = { bytes: 0, entries: 0, truncated: false };
	const pending: string[] = [root];

	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;

		let dirents: Dirent[];
		try {
			dirents = await fs.readdir(current, { withFileTypes: true });
		} catch {
			// An unreadable subtree is reported as a floor, not a failure: a
			// partial total still answers "am I near the budget?".
			continue;
		}

		for (const dirent of dirents) {
			if (totals.entries >= MAX_WALK_ENTRIES) {
				totals.truncated = true;
				return totals;
			}
			totals.entries += 1;
			const full = path.join(current, dirent.name);
			if (dirent.isDirectory()) {
				pending.push(full);
				continue;
			}
			if (!dirent.isFile()) continue;
			try {
				const stat = await fs.lstat(full);
				totals.bytes += stat.size;
			} catch {
				// Vanished mid-walk (a live session rotating records). Skip it.
			}
		}
	}

	return totals;
}

function classify(totalBytes: number, limitBytes: number): GcSessionScopeStatus {
	if (totalBytes > limitBytes) return "over_limit";
	if (totalBytes >= limitBytes * NOTICE_RATIO) return "approaching_limit";
	return "ok";
}

/**
 * Measure the managed scope directory backing `scopePath`.
 *
 * Never throws: an unreadable or absent scope is reported as `unavailable` so
 * a capacity probe can never fail a gc run.
 */
export async function collectSessionScopeUsage(
	scopePath: string,
	limitBytes: number = MANAGED_ARTIFACT_MAX_TOTAL_BYTES,
): Promise<GcSessionScopeUsage> {
	const base: Pick<GcSessionScopeUsage, "path" | "limit_bytes"> = {
		path: scopePath,
		limit_bytes: limitBytes,
	};
	try {
		const stat = await fs.lstat(scopePath);
		if (!stat.isDirectory()) {
			return {
				...base,
				status: "unavailable",
				total_bytes: 0,
				entries: 0,
				truncated: false,
				reason: "not_a_directory",
			};
		}
	} catch {
		// No scope yet (first run in this directory) is not a problem to report.
		return {
			...base,
			status: "unavailable",
			total_bytes: 0,
			entries: 0,
			truncated: false,
			reason: "scope_not_found",
		};
	}

	const totals = await walk(scopePath);
	return {
		...base,
		status: classify(totals.bytes, limitBytes),
		total_bytes: totals.bytes,
		entries: totals.entries,
		truncated: totals.truncated,
	};
}

/** Whether the usage is worth putting in front of an operator. */
export function shouldReportSessionScope(usage: GcSessionScopeUsage): boolean {
	return usage.status === "approaching_limit" || usage.status === "over_limit";
}
