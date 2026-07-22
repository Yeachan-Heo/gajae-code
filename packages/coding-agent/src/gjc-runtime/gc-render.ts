/**
 * Text rendering for `gjc gc` reports. JSON output is produced directly in
 * `gc-runtime.ts`; this module owns the human-readable grouped report.
 */

import type { GcRecord, GcReport, GcStore } from "./gc-runtime";
import { GC_STORES } from "./gc-runtime";

const STORE_HEADINGS: Record<GcStore, string> = {
	harness_leases: "Harness owner leases",
	team_workers: "Team workers",
	file_locks: "Config file-locks",
	tmux_sessions: "Tmux sessions",
	registry_entries: "Harness-root registry entries",
};

function actionLabel(record: GcRecord): string {
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

	if (report.errors.length > 0) {
		lines.push(`Errors (${report.errors.length})`);
		for (const err of report.errors) lines.push(`  [${err.store}/${err.scope}] ${err.message}`);
		lines.push("");
	}

	const c = report.counts;
	lines.push(
		`Summary: discovered=${c.discovered} stale=${c.stale} alive=${c.alive} eperm=${c.eperm} unknown=${c.unknown} ` +
			`terminal_lifecycle=${c.terminal_lifecycle} unclassified=${c.unclassified} ` +
			`${report.dry_run ? `would_remove=${c.would_remove}` : `removed=${c.removed} failed=${c.failed}`} errors=${c.errors}`,
	);
	lines.push("");
	return `${lines.join("\n")}`;
}
