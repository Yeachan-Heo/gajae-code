import {
	DESKTOP_TOOL_LIMITS,
	type DesktopToolInfo,
	type DesktopToolList,
	type DesktopToolOrigin,
} from "./tool-protocol";

/**
 * The registry fields the catalog reads from one tool. An SDK `AgentTool` satisfies it; an MCP
 * bridge tool also carries `mcpServerName`, which `AgentTool` does not declare, so that field is
 * read structurally.
 */
interface CatalogTool {
	name: string;
	label?: string;
	description?: string;
	/** A tool's own one-line summary. */
	summary?: string;
	loadMode?: "essential" | "discoverable";
}

/**
 * The live-session accessors `tools.list` reads. The Host passes its full SDK session, which
 * satisfies this shape.
 */
export interface ToolCatalogSession {
	/** Every registered name, in registry order: the names `tools.set` accepts. */
	getAllToolNames(): string[];
	getActiveToolNames(): string[];
	getToolByName(name: string): CatalogTool | undefined;
	/** Inactive tools a tool search can still activate. Active tools are never listed here. */
	getDiscoverableTools(): ReadonlyArray<{ name: string; serverName?: string }>;
	/** Tools a tool search activated in this session, including selected MCP tools. */
	getSelectedDiscoveredToolNames(): string[];
	isToolDiscoveryEnabled(): boolean;
}

/** Cuts already-redacted text to `limit` characters with an ellipsis, never splitting a surrogate pair. */
function bound(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let end = limit - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

/**
 * The tool's own summary, otherwise the first sentence of its first paragraph. Tool descriptions
 * are long model prompts, so only that opening line describes the tool to a person.
 */
function describeTool(tool: CatalogTool, redact: (text: string) => string): string | undefined {
	const summary = typeof tool.summary === "string" ? tool.summary.trim() : "";
	// Redaction sees the whole source string before any paragraph, sentence or length cut.
	const source = summary ? redact(summary) : typeof tool.description === "string" ? redact(tool.description) : "";
	const paragraph = (source.split(/\n\s*\n/u).find(part => part.trim()) ?? "")
		.replaceAll("`", "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!paragraph) return undefined;
	const sentence = summary ? paragraph : (/^.*?(?:[.!?](?=\s|$)|[。！？])/u.exec(paragraph)?.[0] ?? paragraph);
	return bound(sentence, DESKTOP_TOOL_LIMITS.description);
}

function origin(tool: CatalogTool | undefined, discoverable: boolean, discovered: boolean): DesktopToolOrigin {
	if (tool?.loadMode === "essential") return "essential";
	if (tool?.loadMode === "discoverable" || discoverable || discovered) return "discoverable";
	return "other";
}

/**
 * Answers `tools.list` for a live session. `tools.list` is a projected control method, so the
 * Host does not redact this result when it emits it: every string passes through `redact` here,
 * before any cut.
 *
 * `available` and `active` stay complete and in SDK order. `tools` describes the first
 * `DESKTOP_TOOL_LIMITS.catalog` registered tools: their label, a one-line description, how they
 * entered the registry (`origin`), whether a tool search activated them (`discovered`), whether
 * they wait for a tool search (`hidden`: discovery is on, the tool is inactive and a search can
 * still find it) and their MCP server.
 */
export function projectToolCatalog(session: ToolCatalogSession, redact: (text: string) => string): DesktopToolList {
	const names = session.getAllToolNames();
	const activeNames = session.getActiveToolNames();
	const active = new Set(activeNames);
	const discoveryEnabled = session.isToolDiscoveryEnabled();
	const discoverable = new Map(session.getDiscoverableTools().map(tool => [tool.name, tool]));
	const discovered = new Set(session.getSelectedDiscoveredToolNames());
	const tools = names.slice(0, DESKTOP_TOOL_LIMITS.catalog).map((name): DesktopToolInfo => {
		const tool = session.getToolByName(name);
		const searchable = discoverable.get(name);
		const isActive = active.has(name);
		const label = typeof tool?.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		const description = tool ? describeTool(tool, redact) : undefined;
		const server =
			tool && "mcpServerName" in tool && typeof tool.mcpServerName === "string" && tool.mcpServerName
				? tool.mcpServerName
				: searchable?.serverName;
		return {
			name: redact(name),
			label: bound(redact(label), DESKTOP_TOOL_LIMITS.description),
			...(description ? { description } : {}),
			active: isActive,
			origin: origin(tool, searchable !== undefined, discovered.has(name)),
			discovered: discovered.has(name),
			...(discoveryEnabled && !isActive && searchable ? { hidden: true } : {}),
			...(server ? { mcpServer: bound(redact(server), DESKTOP_TOOL_LIMITS.description) } : {}),
		};
	});
	return {
		available: names.map(name => redact(name)),
		active: activeNames.map(name => redact(name)),
		tools,
		discovery: { enabled: discoveryEnabled },
	};
}
