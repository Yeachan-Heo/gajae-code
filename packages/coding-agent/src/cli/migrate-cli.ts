/**
 * `gjc migrate` — import MCP servers, skills, slash commands, and instruction files from other coding agents.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getMCPConfigPath, getProjectAgentDir, getProjectDir } from "@gajae-code/utils";
import { planMigration } from "../migrate/action-planner";
import { getAdapter } from "../migrate/adapters/index";
import { executeActions } from "../migrate/executor";
import { buildReport, renderHuman } from "../migrate/report";
import {
	type AdapterResult,
	CANONICAL_SOURCE_ORDER,
	MIGRATE_SOURCES,
	type MigrateDestinations,
	type MigrateReport,
	type MigrateSource,
} from "../migrate/types";

export interface MigrateCommandArgs {
	from: string[];
	project: boolean;
	force: boolean;
	dryRun: boolean;
	json: boolean;
	/** Test seam: override home dir for source discovery. */
	homeDir?: string;
	/** Test seam: override cwd for project-scope destinations. */
	cwd?: string;
}

export class MigrateArgsError extends Error {}

/** Expand `all`/repeated `--from`, validate, and return sources in canonical order. */
export function resolveSources(from: string[]): MigrateSource[] {
	if (from.length === 0) {
		throw new MigrateArgsError("No source selected. Use --from <claude-code|codex|opencode|all> (repeatable).");
	}
	const selected = new Set<MigrateSource>();
	for (const raw of from) {
		const value = raw.trim().toLowerCase();
		if (value === "all") {
			for (const s of MIGRATE_SOURCES) selected.add(s);
			continue;
		}
		if (!(MIGRATE_SOURCES as readonly string[]).includes(value)) {
			throw new MigrateArgsError(`Unknown source "${raw}". Valid: ${MIGRATE_SOURCES.join(", ")}, all.`);
		}
		selected.add(value as MigrateSource);
	}
	return CANONICAL_SOURCE_ORDER.filter(s => selected.has(s));
}

function resolveDestinations(project: boolean, cwd: string): MigrateDestinations {
	const scope = project ? "project" : "user";
	const agentDir = project ? getProjectAgentDir(cwd) : getAgentDir();
	const skillsDir = path.join(agentDir, "skills");
	const commandsDir = path.join(agentDir, "commands");
	const agentsDir = path.join(agentDir, "agents");
	const hooksDir = path.join(agentDir, "hooks");
	const instructionsPath = path.join(agentDir, "AGENTS.md");
	return {
		mcpConfigPath: getMCPConfigPath(scope, cwd),
		skillsDir,
		commandsDir,
		agentsDir,
		hooksDir,
		instructionsPath,
	};
}

/** Run the migration and return the report (does not set process.exitCode). */
export async function runMigrate(args: MigrateCommandArgs): Promise<MigrateReport> {
	const sources = resolveSources(args.from);
	const cwd = args.cwd ?? getProjectDir();
	const homeDir = args.homeDir ?? os.homedir();
	const destinations = resolveDestinations(args.project, cwd);

	const results: AdapterResult[] = [];
	for (const source of sources) {
		results.push(await getAdapter(source).collect({ homeDir, cwd, scope: args.project ? "project" : "user" }));
	}

	const { actions, warnings, manualActions } = await planMigration({ results, destinations, force: args.force });
	const finalActions = args.dryRun ? actions : await executeActions(actions, { project: args.project });

	return buildReport({
		actions: finalActions,
		warnings,
		manualActions,
		sources,
		destinations,
		dryRun: args.dryRun,
		project: args.project,
		force: args.force,
	});
}

/** CLI entry: run, render, and set the process exit code. */
export async function runMigrateCommand(args: MigrateCommandArgs): Promise<void> {
	let report: MigrateReport;
	try {
		report = await runMigrate(args);
	} catch (error) {
		if (error instanceof MigrateArgsError) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 2;
			return;
		}
		throw error;
	}

	if (args.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		process.stdout.write(`${renderHuman(report)}\n`);
	}
	process.exitCode = report.ok ? 0 : 1;
}
