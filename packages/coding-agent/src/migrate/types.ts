/**
 * Shared types for `gjc migrate`.
 *
 * Imports MCP servers, skills, slash commands, and instruction files from other coding agents
 * (Claude Code, Codex, OpenCode) into native GJC config. See the consensus plan under
 * `.gjc/plans/ralplan/` for the full taxonomy and force/collision semantics.
 */
import type { MCPServerConfig } from "../runtime-mcp/types";

/** Supported migration sources. */
export type MigrateSource = "claude-code" | "codex" | "opencode";

export const MIGRATE_SOURCES: readonly MigrateSource[] = ["claude-code", "codex", "opencode"];

/** Canonical, deterministic ordering used when expanding `--from all` / repeated `--from`. */
export const CANONICAL_SOURCE_ORDER: readonly MigrateSource[] = MIGRATE_SOURCES;

/** What kind of thing an action/coverage row is about. */
export type MigrateItemType = "mcp" | "skill" | "command" | "agent" | "hook" | "instruction" | "source";

/**
 * Per-item outcome taxonomy.
 *
 * `skipped_*` outcomes are non-fatal (exit 0). Any `failed_*` outcome sets
 * `ok=false` and a non-zero process exit code.
 */
export type MigrationStatus =
	| "imported"
	| "updated"
	| "skipped_exists"
	| "skipped_absent_source"
	| "skipped_unmappable"
	| "failed_invalid_source"
	| "failed_invalid_destination"
	| "failed_io";

export const MIGRATION_STATUSES: readonly MigrationStatus[] = [
	"imported",
	"updated",
	"skipped_exists",
	"skipped_absent_source",
	"skipped_unmappable",
	"failed_invalid_source",
	"failed_invalid_destination",
	"failed_io",
];

/** Statuses that represent a hard failure (drive `ok=false` + non-zero exit). */
export const FAILURE_STATUSES: ReadonlySet<MigrationStatus> = new Set<MigrationStatus>([
	"failed_invalid_source",
	"failed_invalid_destination",
	"failed_io",
]);

export function isFailureStatus(status: MigrationStatus): boolean {
	return FAILURE_STATUSES.has(status);
}

/** Operation the planner decided for an item. */
export type MigrateOperation = "create" | "update" | "skip" | "fail";

/** A raw MCP server candidate parsed from a source, before mapping/destination planning. */
export interface McpCandidate {
	source: MigrateSource;
	name: string;
	/** The raw, unmapped server entry from the source config (mapped by the planner). */
	raw: unknown;
}

/** A raw skill candidate parsed from a source, before normalization/destination planning. */
export interface SkillCandidate {
	source: MigrateSource;
	/** Slug used as the destination directory and effective loaded name. */
	slug: string;
	/** Full SKILL.md content (frontmatter already normalized so loaded name == slug). */
	content: string;
	warnings: string[];
}

/** An instructions file imported as the active GJC AGENTS.md for its scope. */
export interface InstructionCandidate {
	source: MigrateSource;
	name: string;
	content: string;
}

/** A Markdown subagent collected from a foreign coding-agent setup. */
export interface AgentCandidate {
	source: MigrateSource;
	/** Agent name exactly as it will be loaded from `<agentsDir>/<name>.md`. */
	name: string;
	/** Full Markdown content with normalized GJC frontmatter. */
	content: string;
	warnings: string[];
}

/** A Markdown slash command collected from a foreign coding-agent setup. */
export interface SlashCommandCandidate {
	source: MigrateSource;
	/** Name without the leading slash; nested path components use `:`. */
	name: string;
	content: string;
}

/**
 * Source-level diagnostic for a single source/type pair (e.g. "codex mcp config
 * was malformed"). Distinct from per-item actions so absent/unreadable sources
 * are reported once instead of per item.
 */
export interface SourceDiagnostic {
	source: MigrateSource;
	type: Exclude<MigrateItemType, "source"> | "source";
	status: Extract<MigrationStatus, "skipped_absent_source" | "failed_invalid_source" | "failed_io">;
	message: string;
}

/**
 * A foreign hook command that maps onto a gjc hook event.
 *
 * Claude Code hooks are shell commands that receive a JSON payload on stdin and
 * signal a block with exit code 2; gjc hooks are TypeScript modules. The
 * importer generates a module that reproduces that contract for the events whose
 * semantics are unambiguous.
 */
export interface HookCandidate {
	source: MigrateSource;
	/** Foreign event name, e.g. `PreToolUse`. */
	event: string;
	/** Tool-name matcher; empty or absent means every tool. */
	matcher?: string;
	/** Shell command exactly as the source declared it. */
	command: string;
}

/**
 * A source setting the migration cannot express in gjc. Reported instead of
 * guessed at: silently translating an approval or hook policy would change what
 * the agent is allowed to do. Secret values are never read, so detail may name
 * keys but never their contents.
 */
export interface ManualAction {
	source: MigrateSource;
	/** Setting area, e.g. `hooks`, `settings.model`, `env`. */
	area: string;
	/** One-line instruction naming the concrete follow-up. */
	detail: string;
}

/** Normalized candidates + diagnostics returned by an adapter. */
export interface AdapterResult {
	mcpCandidates: McpCandidate[];
	skillCandidates: SkillCandidate[];
	slashCommandCandidates: SlashCommandCandidate[];
	agentCandidates: AgentCandidate[];
	hookCandidates: HookCandidate[];
	instructionCandidates: InstructionCandidate[];
	diagnostics: SourceDiagnostic[];
	manualActions: ManualAction[];
}

/** A single planned action consumed identically by dry-run and live execution. */
export interface MigrateAction {
	source: MigrateSource;
	type: MigrateItemType;
	name?: string;
	/** For skills: the effective GJC-loaded name (== slug). */
	effectiveName?: string;
	/** Absolute destination path (mcp.json for MCP, <skillsDir>/<slug>/SKILL.md for skills). */
	destination?: string;
	operation: MigrateOperation;
	status: MigrationStatus;
	reason?: string;
	warnings?: string[];
	/** Resolved payload the executor needs; never serialized to the report. */
	mcp?: { config: MCPServerConfig; force: boolean };
	skill?: { content: string };
	command?: { content: string };
	agent?: { content: string };
	hook?: { content: string };
	instruction?: { content: string };
}

export interface MigrateWarning {
	source: MigrateSource;
	type: string;
	name?: string;
	message: string;
}

export type StatusCounts = Record<MigrationStatus, number>;

export interface MigrateDestinations {
	mcpConfigPath: string;
	skillsDir: string;
	commandsDir: string;
	agentsDir: string;
	/** Directory that receives generated hook modules. */
	hooksDir: string;
	instructionsPath: string;
}

/** The full machine-readable report emitted with `--json`. */
export interface MigrateReport {
	ok: boolean;
	dryRun: boolean;
	project: boolean;
	force: boolean;
	sources: MigrateSource[];
	destinations: MigrateDestinations;
	summary: {
		total: StatusCounts;
		byType: {
			mcp: StatusCounts;
			skill: StatusCounts;
			command: StatusCounts;
			agent: StatusCounts;
			hook: StatusCounts;
			instruction: StatusCounts;
			source: StatusCounts;
		};
		bySource: Record<MigrateSource, StatusCounts>;
	};
	actions: Array<{
		source: MigrateSource;
		type: MigrateItemType;
		name?: string;
		effectiveName?: string;
		destination?: string;
		operation: MigrateOperation;
		status: MigrationStatus;
		reason?: string;
		warnings?: string[];
	}>;
	warnings: MigrateWarning[];
	manualActions: ManualAction[];
}

/** Create a zeroed status-count record. */
export function emptyStatusCounts(): StatusCounts {
	const counts = {} as StatusCounts;
	for (const status of MIGRATION_STATUSES) counts[status] = 0;
	return counts;
}
