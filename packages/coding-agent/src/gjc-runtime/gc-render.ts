/**
 * Text rendering for `gjc gc` reports. JSON output is produced directly in
 * `gc-runtime.ts`; this module owns the human-readable grouped report.
 */

import { formatBytes, GC_DISK_SURFACES, type GcDiskCandidate } from "./gc-disk";
import type { GcRecord, GcReport, GcStore } from "./gc-runtime";
import { GC_STORES } from "./gc-runtime";

const STORE_HEADINGS: Record<GcStore, string> = {
	harness_leases: "Harness owner leases",
	team_workers: "Team workers",
	file_locks: "Config file-locks",
	tmux_sessions: "Tmux sessions",
	registry_entries: "Harness-root registry entries",
	local_roots: "Session local roots",
};

const DISK_SURFACE_HEADINGS: Record<(typeof GC_DISK_SURFACES)[number], string> = {
	natives_versions: "Natives version caches",
};

function actionLabel(record: { action: GcRecord["action"]; error?: string; reason: string }): string {
	switch (record.action) {
		case "would_remove":
			return "would remove";
		case "removed":
			return "removed";
		case "remove_failed":
			return `remove failed${record.error ? `: ${record.error}` : ""}`;
		case "skipped":
			return `skipped: ${record.reason}`;
		default:
			return "keep";
	}
}

function renderRecord(record: GcRecord): string {
	const target = record.path ?? record.id;
	const pid = record.pid !== undefined ? ` pid=${record.pid}` : "";
	const pidStatus = record.pid_status ? ` (${record.pid_status})` : "";
	const note = record.detail ? ` — ${record.detail}` : "";
	return `  [${actionLabel(record)}] ${target}${pid}${pidStatus} :: ${record.status} — ${record.reason}${note}`;
}

function renderDiskCandidate(candidate: GcDiskCandidate): string {
	const size = formatBytes(candidate.bytes);
	const trunc = candidate.bytes_truncated ? "~" : "";
	const note = candidate.detail ? ` — ${candidate.detail}` : "";
	return `  [${actionLabel(candidate)}] ${candidate.path} (${trunc}${size}) :: ${candidate.status} — ${candidate.reason}${note}`;
}

export function buildGcReportText(report: GcReport): string {
	const lines: string[] = [];
	if (report.operation === "repair_session_index") {
		lines.push("gjc gc — session-index repair (other stores are report-only)");
	} else {
		lines.push(report.dry_run ? "gjc gc — dry run (no changes made; pass --prune to remove)" : "gjc gc — prune");
	}
	lines.push("");

	for (const store of GC_STORES) {
		const records = report.stores[store];
		lines.push(`${STORE_HEADINGS[store]} (${records.length})`);
		if (records.length === 0) {
			lines.push("  (none)");
		} else {
			for (const record of records) lines.push(renderRecord(record));
		}
		lines.push("");
	}

	if (report.session_index) {
		const index = report.session_index;
		lines.push(`Session index: ${index.status}; valid prefix sequence=${index.valid_prefix_seq}`);
		if (index.quarantine_path) lines.push(`  Quarantined suffix: ${index.quarantine_path}`);
		if (index.reason) lines.push(`  ${index.reason}`);
		if (index.status === "corrupt")
			lines.push("  Run `gjc gc --repair-session-index` to quarantine the corrupt suffix.");
		if (index.status === "unsupported")
			lines.push("  Upgrade GJC before attempting a repair; no index data was changed.");
		if (index.status === "repaired")
			lines.push("  Restart or re-register hosts whose only registration was in the quarantined suffix.");
		lines.push("");
	}

	if (report.disk) {
		const disk = report.disk;
		lines.push(
			`Disk retention (${disk.dry_run ? "dry run" : "prune"}): current natives=${disk.policy.natives_current_version} keep_predecessors=${disk.policy.natives_keep_versions}`,
		);
		lines.push(`  natives dir: ${disk.policy.natives_dir}`);
		for (const surface of GC_DISK_SURFACES) {
			const candidates = disk.surfaces[surface];
			lines.push(`  ${DISK_SURFACE_HEADINGS[surface]} (${candidates.length})`);
			if (candidates.length === 0) {
				lines.push("    (none)");
			} else {
				for (const candidate of candidates) lines.push(`  ${renderDiskCandidate(candidate)}`);
			}
		}
		if (disk.errors.length > 0) {
			lines.push(`  Disk errors (${disk.errors.length})`);
			for (const err of disk.errors) lines.push(`    [${err.surface}/${err.scope}] ${err.message}`);
		}
		const d = disk.counts;
		lines.push(
			`  Disk summary: discovered=${d.discovered} kept=${d.kept} ` +
				`${disk.dry_run ? `would_remove=${d.would_remove} reclaimable=${formatBytes(d.reclaimable_bytes)}` : `removed=${d.removed} reclaimed=${formatBytes(d.reclaimed_bytes)} failed=${d.failed}`}`,
		);
		lines.push("");
	}

	if (report.warnings.length > 0) {
		lines.push(`Warnings (${report.warnings.length})`);
		for (const warning of report.warnings) lines.push(`  [${warning.store}/${warning.scope}] ${warning.message}`);
		lines.push("");
	}

	if (report.errors.length > 0) {
		lines.push(`Errors (${report.errors.length})`);
		for (const err of report.errors) lines.push(`  [${err.store}/${err.scope}] ${err.message}`);
		lines.push("");
	}

	const c = report.counts;
	lines.push(
		`Summary: discovered=${c.discovered} stale=${c.stale} alive=${c.alive} eperm=${c.eperm} unknown=${c.unknown} ` +
			`terminal_lifecycle=${c.terminal_lifecycle} unclassified=${c.unclassified} ` +
			`${report.dry_run ? `would_remove=${c.would_remove}` : `removed=${c.removed} failed=${c.failed}`} ` +
			`errors=${c.errors} warnings=${report.warnings.length}`,
	);
	lines.push("");
	return `${lines.join("\n")}`;
}
