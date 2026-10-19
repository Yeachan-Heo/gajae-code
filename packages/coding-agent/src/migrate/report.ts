/**
 * Build the human-readable and `--json` reports for `gjc migrate`.
 *
 * Secret values are never read upstream, so the report only ever contains field
 * names in warnings — but rendering still treats action/warning text as opaque.
 */
import {
	emptyStatusCounts,
	isFailureStatus,
	type MigrateAction,
	type MigrateDestinations,
	type MigrateReport,
	type MigrateSource,
	type MigrateWarning,
	type StatusCounts,
} from "./types";

export interface BuildReportInput {
	actions: MigrateAction[];
	warnings: MigrateWarning[];
	sources: MigrateSource[];
	destinations: MigrateDestinations;
	dryRun: boolean;
	project: boolean;
	force: boolean;
}

export function buildReport(input: BuildReportInput): MigrateReport {
	const total = emptyStatusCounts();
	const byType = {
		mcp: emptyStatusCounts(),
		skill: emptyStatusCounts(),
		instruction: emptyStatusCounts(),
		source: emptyStatusCounts(),
	};
	const bySource = {} as Record<MigrateSource, StatusCounts>;
	for (const source of input.sources) bySource[source] = emptyStatusCounts();

	let ok = true;
	for (const action of input.actions) {
		total[action.status] += 1;
		byType[action.type][action.status] += 1;
		if (bySource[action.source]) bySource[action.source][action.status] += 1;
		if (isFailureStatus(action.status)) ok = false;
	}

	return {
		ok,
		dryRun: input.dryRun,
		project: input.project,
		force: input.force,
		sources: input.sources,
		destinations: input.destinations,
		summary: { total, byType, bySource },
		actions: input.actions.map(action => ({
			source: action.source,
			type: action.type,
			name: action.name,
			effectiveName: action.effectiveName,
			destination: action.destination,
			operation: action.operation,
			status: action.status,
			reason: action.reason,
			warnings: action.warnings,
		})),
		warnings: input.warnings,
	};
}

function summarizeCounts(counts: StatusCounts): string {
	const parts: string[] = [];
	for (const [status, count] of Object.entries(counts)) {
		if (count > 0) parts.push(`${status}=${count}`);
	}
	return parts.length > 0 ? parts.join(", ") : "nothing";
}

export function renderHuman(report: MigrateReport): string {
	const lines: string[] = [];
	const mode = report.dryRun ? " (dry-run)" : "";
	lines.push(`gjc migrate${mode}: ${report.ok ? "ok" : "completed with failures"}`);
	lines.push(`Sources: ${report.sources.join(", ") || "none"}`);
	lines.push(
		`Destination: mcp=${report.destinations.mcpConfigPath} skills=${report.destinations.skillsDir} instructions=${report.destinations.instructionsPath}`,
	);
	lines.push("");
	lines.push(`MCP:    ${summarizeCounts(report.summary.byType.mcp)}`);
	lines.push(`Skills: ${summarizeCounts(report.summary.byType.skill)}`);
	lines.push(`Instructions: ${summarizeCounts(report.summary.byType.instruction)}`);
	const instructionActions = report.actions.filter(action => action.type === "instruction");
	if (instructionActions.length > 0) {
		lines.push("Instruction files:");
		for (const action of instructionActions) {
			lines.push(
				`  - [${action.source}] ${action.name ?? "AGENTS.md"}: ${action.status}${action.reason ? ` (${action.reason})` : ""}`,
			);
		}
	}
	if (Object.values(report.summary.byType.source).some(n => n > 0)) {
		lines.push(`Source: ${summarizeCounts(report.summary.byType.source)}`);
	}

	const failures = report.actions.filter(a => isFailureStatus(a.status));
	if (failures.length > 0) {
		lines.push("");
		lines.push("Failures:");
		for (const f of failures) {
			lines.push(`  - [${f.source}] ${f.type} ${f.name ?? ""}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`);
		}
	}

	if (report.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const w of report.warnings) {
			lines.push(`  - [${w.source}] ${w.type} ${w.name ?? ""}: ${w.message}`);
		}
	}

	return lines.join("\n");
}
