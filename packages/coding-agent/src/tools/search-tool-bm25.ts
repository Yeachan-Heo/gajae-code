import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import searchToolBm25Description from "../prompts/tools/search-tool-bm25.md" with { type: "text" };
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	searchDiscoverableTools,
} from "../tool-discovery/tool-index";
import { renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const DEFAULT_LIMIT = 8;
const TOOL_DISCOVERY_TITLE = "Tool Discovery";
const COLLAPSED_MATCH_LIMIT = 5;
const MATCH_LABEL_LEN = 72;
const MATCH_DESCRIPTION_LEN = 96;

const searchToolBm25Schema = z.object({
	query: z.string().describe("tool search query"),
	limit: z.number().int().min(1).optional().describe("max matches"),
});

type SearchToolBm25Params = z.infer<typeof searchToolBm25Schema>;

interface SearchToolBm25Match {
	name: string;
	label: string;
	description: string;
	server_name?: string;
	mcp_tool_name?: string;
	schema_keys: string[];
	score: number;
}

export interface SearchToolBm25Details {
	query: string;
	limit: number;
	total_tools: number;
	activated_tools: string[];
	active_selected_tools: string[];
	tools: SearchToolBm25Match[];
}

function formatMatch(tool: DiscoverableTool, score: number): SearchToolBm25Match {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.summary,
		server_name: tool.serverName,
		mcp_tool_name: tool.mcpToolName,
		schema_keys: tool.schemaKeys,
		score: Number(score.toFixed(6)),
	};
}

function buildSearchToolBm25Content(details: SearchToolBm25Details): string {
	return JSON.stringify({
		query: details.query,
		activated_tools: details.activated_tools,
		match_count: details.tools.length,
		total_tools: details.total_tools,
	});
}

function getDiscoverableToolsForDescription(session: ToolSession): DiscoverableTool[] {
	try {
		return session.getDiscoverableTools?.() ?? [];
	} catch {
		return [];
	}
}

function getDiscoverableToolSearchIndexForExecution(session: ToolSession): DiscoverableToolSearchIndex {
	try {
		const cached = session.getDiscoverableToolSearchIndex?.();
		if (cached) return cached;
	} catch {}
	return buildDiscoverableToolSearchIndex(getDiscoverableToolsForDescription(session));
}

function getSelectedToolNames(session: ToolSession): string[] {
	return session.getSelectedDiscoveredToolNames?.() ?? [];
}

async function activateTools(session: ToolSession, toolNames: string[]): Promise<string[]> {
	return (await session.activateDiscoveredTools?.(toolNames)) ?? [];
}

type DiscoveryExecutionSession = ToolSession & {
	_supportsDiscoveryExecution: true;
};

function supportsToolDiscoveryExecution(session: ToolSession): session is DiscoveryExecutionSession {
	return (
		typeof session.isToolDiscoveryEnabled === "function" &&
		typeof session.getSelectedDiscoveredToolNames === "function" &&
		typeof session.activateDiscoveredTools === "function"
	);
}

function isDiscoveryEnabled(session: ToolSession): boolean {
	return session.isToolDiscoveryEnabled?.() ?? false;
}

export function renderSearchToolBm25Description(): string {
	return prompt.render(searchToolBm25Description, {});
}

function renderMatchLines(match: SearchToolBm25Match, theme: Theme): string[] {
	const safeServerName = match.server_name ? replaceTabs(match.server_name) : undefined;
	const safeLabel = replaceTabs(match.label);
	const safeDescription = replaceTabs(match.description.trim());
	const metaParts: string[] = [];
	if (safeServerName) metaParts.push(theme.fg("muted", safeServerName));
	metaParts.push(theme.fg("dim", `score ${match.score.toFixed(3)}`));
	const metaSep = theme.fg("dim", theme.sep.dot);
	const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
	const lines = [`${theme.fg("accent", truncateToWidth(safeLabel, MATCH_LABEL_LEN))}${metaSuffix}`];
	if (safeDescription) {
		lines.push(theme.fg("muted", truncateToWidth(safeDescription, MATCH_DESCRIPTION_LEN)));
	}
	return lines;
}

function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: TOOL_DISCOVERY_TITLE }, theme);
	const bodyLines = (text || "Tool discovery completed")
		.split("\n")
		.map(line => theme.fg("dim", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}

/**
 * SearchToolsTool — wire name `search_tool_bm25` (preserved for persisted session back-compat).
 *
 * When tools.discoveryMode === "all", this covers both MCP tools and built-in discoverable tools.
 * When tools.discoveryMode === "mcp-only" or mcp.discoveryMode === true, only MCP tools are searched.
 */
export class SearchToolBm25Tool implements AgentTool<typeof searchToolBm25Schema, SearchToolBm25Details> {
	readonly name = "search_tool_bm25";
	readonly label = "SearchTools";
	readonly loadMode = "essential";
	readonly description = renderSearchToolBm25Description();
	readonly parameters = searchToolBm25Schema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SearchToolBm25Tool | null {
		// Active when new tools.discoveryMode is non-"off" or legacy mcp.discoveryMode is true
		const toolsDiscoveryMode = session.settings.get("tools.discoveryMode");
		const active =
			(toolsDiscoveryMode !== undefined && toolsDiscoveryMode !== "off") ||
			session.settings.get("mcp.discoveryMode") === true;
		if (!active) return null;
		return supportsToolDiscoveryExecution(session) ? new SearchToolBm25Tool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolBm25Params,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolBm25Details>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolBm25Details>> {
		if (!supportsToolDiscoveryExecution(this.session)) {
			throw new ToolError("Tool discovery is unavailable in this session.");
		}
		if (!isDiscoveryEnabled(this.session)) {
			throw new ToolError(
				"Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.",
			);
		}

		const query = params.query.trim();
		if (query.length === 0) {
			throw new ToolError("Query is required and must not be empty.");
		}
		const limit = params.limit ?? DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new ToolError("Limit must be a positive integer.");
		}

		const searchIndex = getDiscoverableToolSearchIndexForExecution(this.session);
		const selectedToolNames = new Set(getSelectedToolNames(this.session));
		let ranked: Array<{ tool: DiscoverableTool; score: number }> = [];
		try {
			ranked = searchDiscoverableTools(searchIndex, query, searchIndex.documents.length)
				.filter(result => !selectedToolNames.has(result.tool.name))
				.slice(0, limit);
		} catch (error) {
			if (error instanceof Error) {
				throw new ToolError(error.message);
			}
			throw error;
		}
		const activated =
			ranked.length > 0
				? await activateTools(
						this.session,
						ranked.map(result => result.tool.name),
					)
				: [];

		const details: SearchToolBm25Details = {
			query,
			limit,
			total_tools: searchIndex.documents.length,
			activated_tools: activated,
			active_selected_tools: getSelectedToolNames(this.session),
			tools: ranked.map(result => formatMatch(result.tool, result.score)),
		};

		return {
			content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
			details,
		};
	}
}

export const searchToolBm25Renderer = {
	renderCall(args: SearchToolBm25Params, _options: RenderResultOptions, uiTheme: Theme): Component {
		const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
		const meta = args.limit ? [`limit:${args.limit}`] : [];
		return new Text(
			renderStatusLine(
				{ icon: "pending", title: TOOL_DISCOVERY_TITLE, description: query || "(empty query)", meta },
				uiTheme,
			),
			0,
			0,
		);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolBm25Details; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (!result.details) {
			const fallbackText = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.filter((text): text is string => typeof text === "string" && text.length > 0)
				.join("\n");
			return renderFallbackResult(fallbackText, uiTheme);
		}

		const { details } = result;
		const meta = [
			formatCount("match", details.tools.length),
			`${details.active_selected_tools.length} active`,
			`${details.total_tools} total`,
			`limit:${details.limit}`,
		];
		const safeQuery = replaceTabs(details.query);
		const header = renderStatusLine(
			{
				icon: details.tools.length > 0 ? "success" : "warning",
				title: TOOL_DISCOVERY_TITLE,
				description: truncateToWidth(safeQuery, MATCH_LABEL_LEN),
				meta,
			},
			uiTheme,
		);
		if (details.tools.length === 0) {
			const emptyMessage =
				details.total_tools === 0 ? "No discoverable tools are currently loaded." : "No matching tools found.";
			return new Text(`${header}\n${uiTheme.fg("muted", emptyMessage)}`, 0, 0);
		}

		const lines = [header];
		const treeLines = renderTreeList(
			{
				items: details.tools,
				expanded: options.expanded,
				maxCollapsed: COLLAPSED_MATCH_LIMIT,
				itemType: "tool",
				renderItem: match => renderMatchLines(match, uiTheme),
			},
			uiTheme,
		);
		lines.push(...treeLines);
		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
	inline: true,
};
