/**
 * Shared types for `gjc migrate`.
 *
 * Imports MCP servers and skills from other coding agents (Claude Code, Codex,
 * OpenCode) into native GJC config. See the consensus plan under
 * `.gjc/plans/ralplan/` for the full taxonomy and force/collision semantics.
 */
import type { MCPServerConfig } from "../runtime-mcp/types";

/** Supported migration sources. */
export type MigrateSource = "claude-code" | "codex" | "opencode" | "cursor";

export const MIGRATE_SOURCES: readonly MigrateSource[] = ["claude-code", "codex", "opencode", "cursor"];

/** Canonical, deterministic ordering used when expanding `--from all` / repeated `--from`. */
export const CANONICAL_SOURCE_ORDER: readonly MigrateSource[] = MIGRATE_SOURCES;

/** What kind of thing an action/coverage row is about. */
export type MigrateItemType = "mcp" | "skill" | "source";

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

/** Normalized candidates + diagnostics returned by an adapter. */
export interface AdapterResult {
	mcpCandidates: McpCandidate[];
	skillCandidates: SkillCandidate[];
	diagnostics: SourceDiagnostic[];
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
		byType: { mcp: StatusCounts; skill: StatusCounts; source: StatusCounts };
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
}

/** Create a zeroed status-count record. */
export function emptyStatusCounts(): StatusCounts {
	const counts = {} as StatusCounts;
	for (const status of MIGRATION_STATUSES) counts[status] = 0;
	return counts;
}
