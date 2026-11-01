/**
 * Build the human-readable and `--json` reports for `gjc migrate`.
 *
 * Secret values are never read upstream, so the report only ever contains field
 * names in warnings — but rendering still treats action/warning text as opaque.
 */
import {
	emptyStatusCounts,
	isFailureStatus,
	type ManualAction,
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
	manualActions: ManualAction[];
	dryRun: boolean;
	project: boolean;
	force: boolean;
}

export function buildReport(input: BuildReportInput): MigrateReport {
	const total = emptyStatusCounts();
	const byType = {
		mcp: emptyStatusCounts(),
		skill: emptyStatusCounts(),
		command: emptyStatusCounts(),
		agent: emptyStatusCounts(),
		hook: emptyStatusCounts(),
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
		manualActions: input.manualActions,
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
		`Destination: mcp=${report.destinations.mcpConfigPath} skills=${report.destinations.skillsDir} commands=${report.destinations.commandsDir} agents=${report.destinations.agentsDir} hooks=${report.destinations.hooksDir} instructions=${report.destinations.instructionsPath}`,
	);
	lines.push("");
	lines.push(`MCP:    ${summarizeCounts(report.summary.byType.mcp)}`);
	lines.push(`Skills: ${summarizeCounts(report.summary.byType.skill)}`);
	lines.push(`Commands: ${summarizeCounts(report.summary.byType.command)}`);
	lines.push(`Agents: ${summarizeCounts(report.summary.byType.agent)}`);
	lines.push(`Hooks:  ${summarizeCounts(report.summary.byType.hook)}`);
	lines.push(`Instructions: ${summarizeCounts(report.summary.byType.instruction)}`);
	const commandActions = report.actions.filter(action => action.type === "command");
	if (commandActions.length > 0) {
		lines.push("Slash commands:");
		for (const action of commandActions) {
			lines.push(
				`  - [${action.source}] /${action.name ?? ""}: ${action.status}${action.reason ? ` (${action.reason})` : ""}`,
			);
		}
	}
	const agentActions = report.actions.filter(action => action.type === "agent");
	if (agentActions.length > 0) {
		lines.push("Subagents:");
		for (const action of agentActions) {
			lines.push(
				`  - [${action.source}] ${action.name ?? ""}: ${action.status}${action.reason ? ` (${action.reason})` : ""}`,
			);
		}
	}
	const hookActions = report.actions.filter(action => action.type === "hook");
	if (hookActions.length > 0) {
		lines.push("Hooks:");
		for (const action of hookActions) {
			lines.push(
				`  - [${action.source}] ${action.name ?? ""}: ${action.status}${action.reason ? ` (${action.reason})` : ""}`,
			);
		}
	}
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

	if (report.manualActions.length > 0) {
		lines.push("");
		lines.push("Manual actions:");
		for (const m of report.manualActions) {
			lines.push(`  - [${m.source}] ${m.area}: ${m.detail}`);
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
