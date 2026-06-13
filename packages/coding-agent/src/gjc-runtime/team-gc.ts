/**
 * GC adapter for team workers (`.gjc/state/team/<name>/workers/<id>/` heartbeat
 * + lifecycle). Liveness-only: numeric PID status dominates lifecycle/heartbeat
 * signals.
 */

import * as path from "node:path";
import { listHarnessRootRegistriesForGc } from "../harness-control-plane/storage";
import type { GcCollectResult, GcContext, GcPruneOutcome, GcRecord, GcStoreAdapter } from "./gc-runtime";
import { listTeamWorkerGcRecords, pruneTeamWorkerGcRecord } from "./team-runtime";

function uniqueTeamRootsFromHarnessRoots(roots: string[]): string[] {
	return [...new Set(roots.map(root => path.join(path.dirname(root), "team")))].sort();
}

export const teamWorkersGcAdapter: GcStoreAdapter = {
	store: "team_workers",
	async collect(ctx: GcContext): Promise<GcCollectResult> {
		const records: GcRecord[] = [];
		const errors: GcCollectResult["errors"] = [];
		const registries = await listHarnessRootRegistriesForGc(ctx.env);
		for (const registry of registries) {
			if (registry.error) errors.push({ store: "team_workers", scope: registry.file, message: registry.error });
		}

		const teamRoots = uniqueTeamRootsFromHarnessRoots(
			registries.flatMap(registry => registry.roots.map(entry => entry.root)),
		);
		for (const teamRoot of teamRoots) {
			try {
				records.push(...(await listTeamWorkerGcRecords(teamRoot, ctx.probe)));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") continue;
				errors.push({ store: "team_workers", scope: teamRoot, message: (error as Error).message });
			}
		}

		return { records, errors };
	},
	async prune(record: GcRecord, ctx: GcContext): Promise<GcPruneOutcome> {
		try {
			const removed = await pruneTeamWorkerGcRecord(record, ctx.probe);
			return removed ? { removed: true } : { removed: false, skipped: "worker_no_longer_dead" };
		} catch (error) {
			return { removed: false, error: (error as Error).message };
		}
	},
};
