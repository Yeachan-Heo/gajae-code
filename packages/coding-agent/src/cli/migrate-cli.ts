/**
 * `gjc migrate` — import MCP servers and skills from other coding agents.
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
	/** Restrict migration to one item type (e.g. `gjc mcp import` passes "mcp"). */
	only?: "mcp" | "skill";
	/** Test seam: override home dir for source discovery. */
	homeDir?: string;
	/** Test seam: override cwd for project-scope destinations. */
	cwd?: string;
}

export class MigrateArgsError extends Error {}

/** Expand `all`/repeated `--from`, validate, and return sources in canonical order. */
export function resolveSources(from: string[]): MigrateSource[] {
	if (from.length === 0) {
		throw new MigrateArgsError(
			"No source selected. Use --from <claude-code|codex|opencode|cursor|all> (repeatable).",
		);
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
	const skillsDir = project ? path.join(getProjectAgentDir(cwd), "skills") : path.join(getAgentDir(), "skills");
	return { mcpConfigPath: getMCPConfigPath(scope, cwd), skillsDir };
}

/** Run the migration and return the report (does not set process.exitCode). */
export async function runMigrate(args: MigrateCommandArgs): Promise<MigrateReport> {
	const sources = resolveSources(args.from);
	const cwd = args.cwd ?? getProjectDir();
	const homeDir = args.homeDir ?? os.homedir();
	const destinations = resolveDestinations(args.project, cwd);

	const collected: AdapterResult[] = [];
	for (const source of sources) {
		collected.push(await getAdapter(source).collect({ homeDir }));
	}

	// `only` narrows the migration to one item type: candidates and their
	// per-type diagnostics for the other type are dropped before planning.
	const results: AdapterResult[] =
		args.only === undefined
			? collected
			: collected.map(result => ({
					...result,
					mcpCandidates: args.only === "mcp" ? result.mcpCandidates : [],
					skillCandidates: args.only === "skill" ? result.skillCandidates : [],
					diagnostics: result.diagnostics.filter(d => d.type === args.only || d.type === "source"),
				}));

	const { actions, warnings } = await planMigration({ results, destinations, force: args.force });
	const finalActions = args.dryRun ? actions : await executeActions(actions);

	return buildReport({
		actions: finalActions,
		warnings,
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
