/**
 * Contextual "import hint" for empty MCP-list output.
 *
 * GJC deliberately never scans foreign coding-agent configs at startup — import
 * is always explicit opt-in (`gjc mcp import <source>`). This helper is the one
 * sanctioned exception to that rule, and a narrow one: it runs ONLY when the
 * user asks to list MCP servers and has none configured. In that specific
 * empty-list moment we peek at other hosts' configs and, if any contain MCP
 * servers, surface a one-line suggestion to import them. It is the deliberate
 * alternative to a first-run onboarding prompt.
 *
 * Because it piggybacks on a common command, it must never throw, never slow
 * the command down noticeably, and never surface an error: every source is
 * probed independently and any failure just drops that source from the result.
 */
import * as os from "node:os";
import { getAdapter } from "./adapters/index";
import { MIGRATE_SOURCES, type MigrateSource } from "./types";

/** A source host whose config contains importable MCP servers. */
export interface ImportableMcpSource {
	source: MigrateSource;
	/** Alias to show in the suggested command (claude-code → "claude"). */
	importArg: string;
	/** Human-readable host name, e.g. "Claude Code". */
	displayName: string;
	count: number;
}

const SOURCE_META: Record<MigrateSource, { importArg: string; displayName: string }> = {
	"claude-code": { importArg: "claude", displayName: "Claude Code" },
	codex: { importArg: "codex", displayName: "Codex" },
	opencode: { importArg: "opencode", displayName: "OpenCode" },
	cursor: { importArg: "cursor", displayName: "Cursor" },
};

/**
 * Probe every known source host for importable MCP servers.
 *
 * Returns only sources with at least one MCP server, in canonical source order.
 * `homeDir` is a test seam; production callers omit it to use `os.homedir()`.
 * Never throws — a source that errors is silently skipped.
 */
export async function detectImportableMcpSources(homeDir?: string): Promise<ImportableMcpSource[]> {
	const resolvedHome = homeDir ?? os.homedir();
	const found: ImportableMcpSource[] = [];
	for (const source of MIGRATE_SOURCES) {
		try {
			const result = await getAdapter(source).collect({ homeDir: resolvedHome });
			const count = result.mcpCandidates.length;
			if (count > 0) {
				const meta = SOURCE_META[source];
				found.push({ source, importArg: meta.importArg, displayName: meta.displayName, count });
			}
		} catch {
			// The hint must never throw or slow-fail; skip any source that errors.
		}
	}
	return found;
}

/** One-line, host-agnostic suggestion for a single importable source. */
export function formatImportHintLine(source: ImportableMcpSource): string {
	const servers = source.count === 1 ? "1 MCP server" : `${source.count} MCP servers`;
	return `Tip: found ${servers} in ${source.displayName} config — run \`gjc mcp import ${source.importArg}\` to copy them.`;
}
