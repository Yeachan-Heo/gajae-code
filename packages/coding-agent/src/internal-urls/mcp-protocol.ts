// W6b: mcp:// resolution reads the scope-held facade from ResolveContext, never
// MCPManager.instance(); the manager type stays type-only so the singleton keeps
// no routing role.
import type { MCPManager } from "../runtime-mcp/manager";
import type { MCPResourceReadResult } from "../runtime-mcp/types";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

const MAX_MCP_RESOURCE_URI_CHARS = 16_384;
const MAX_MCP_URI_TEMPLATE_CHARS = 8_192;
const MAX_MCP_URI_TEMPLATE_EXPRESSIONS = 32;

interface CompiledUriTemplate {
	literalSegments: string[];
	literalChars: number;
	expressionCount: number;
}

function containsExpressionLineTerminator(text: string, start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return true;
	}
	return false;
}

function compileUriTemplate(uriTemplate: string): CompiledUriTemplate | undefined {
	if (uriTemplate.length > MAX_MCP_URI_TEMPLATE_CHARS) return undefined;

	const literalSegments: string[] = [];
	let expressionCount = 0;
	let literalChars = 0;
	let segmentStart = 0;
	let scanPosition = 0;
	while (scanPosition < uriTemplate.length) {
		const expressionStart = uriTemplate.indexOf("{", scanPosition);
		if (expressionStart < 0) break;
		const expressionEnd = uriTemplate.indexOf("}", expressionStart + 1);
		if (expressionEnd < 0) break;
		if (expressionEnd === expressionStart + 1) {
			scanPosition = expressionStart + 1;
			continue;
		}
		expressionCount++;
		if (expressionCount > MAX_MCP_URI_TEMPLATE_EXPRESSIONS) return undefined;
		const segment = uriTemplate.slice(segmentStart, expressionStart);
		literalSegments.push(segment);
		literalChars += segment.length;
		segmentStart = expressionEnd + 1;
		scanPosition = segmentStart;
	}
	const finalSegment = uriTemplate.slice(segmentStart);
	literalSegments.push(finalSegment);
	literalChars += finalSegment.length;
	return { literalSegments, literalChars, expressionCount };
}

function matchesUriTemplate(uri: string, template: CompiledUriTemplate): boolean {
	const { literalSegments, expressionCount } = template;
	if (expressionCount === 0) return uri === literalSegments[0];
	if (!uri.startsWith(literalSegments[0])) return false;

	let cursor = literalSegments[0].length;
	for (let index = 1; index < literalSegments.length - 1; index++) {
		const segment = literalSegments[index];
		const matchIndex = uri.indexOf(segment, cursor);
		if (matchIndex < 0 || containsExpressionLineTerminator(uri, cursor, matchIndex)) return false;
		cursor = matchIndex + segment.length;
	}

	const suffix = literalSegments.at(-1) ?? "";
	const suffixStart = uri.length - suffix.length;
	return suffixStart >= cursor && uri.endsWith(suffix) && !containsExpressionLineTerminator(uri, cursor, suffixStart);
}

function getUriTemplateMatchScore(
	uri: string,
	uriTemplate: string,
): { literalChars: number; expressionCount: number } | undefined {
	const template = compileUriTemplate(uriTemplate);
	if (!template || !matchesUriTemplate(uri, template)) return undefined;
	return { literalChars: template.literalChars, expressionCount: template.expressionCount };
}

function extractResourceUri(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/";
	const rawUri = `${host}${hasPath ? rawPathname : ""}${url.search}${url.hash}`;
	if (rawUri.length > MAX_MCP_RESOURCE_URI_CHARS) {
		throw new Error("MCP resource URI exceeds the 16384-character limit.");
	}
	const uri = rawUri.trim();
	if (!uri) {
		throw new Error("mcp:// URL requires a resource URI: mcp://<resource-uri>");
	}
	return uri;
}

function resolveTargetServer(mcpManager: MCPManager, uri: string): string | undefined {
	const servers = mcpManager.getConnectedServers();
	for (const name of servers) {
		const serverResources = mcpManager.getServerResources(name);
		if (serverResources?.resources.some(r => r.uri === uri)) {
			return name;
		}
	}

	let bestTemplateMatch:
		| {
				serverName: string;
				literalChars: number;
				expressionCount: number;
				serverIndex: number;
				templateIndex: number;
		  }
		| undefined;

	for (const [serverIndex, name] of servers.entries()) {
		const serverResources = mcpManager.getServerResources(name);
		if (!serverResources) continue;

		for (const [templateIndex, template] of serverResources.templates.entries()) {
			const match = getUriTemplateMatchScore(uri, template.uriTemplate);
			if (!match) continue;

			const isBetterMatch =
				!bestTemplateMatch ||
				match.literalChars > bestTemplateMatch.literalChars ||
				(match.literalChars === bestTemplateMatch.literalChars &&
					(match.expressionCount < bestTemplateMatch.expressionCount ||
						(match.expressionCount === bestTemplateMatch.expressionCount &&
							(serverIndex < bestTemplateMatch.serverIndex ||
								(serverIndex === bestTemplateMatch.serverIndex &&
									templateIndex < bestTemplateMatch.templateIndex)))));

			if (isBetterMatch) {
				bestTemplateMatch = {
					serverName: name,
					literalChars: match.literalChars,
					expressionCount: match.expressionCount,
					serverIndex,
					templateIndex,
				};
			}
		}
	}

	return bestTemplateMatch?.serverName;
}

function formatAvailableResources(mcpManager: MCPManager): string {
	const available = mcpManager
		.getConnectedServers()
		.flatMap(name => {
			const serverResources = mcpManager.getServerResources(name);
			return (serverResources?.resources ?? []).map(r => `  ${r.uri} (${name})`);
		})
		.join("\n");
	return available || "  (none)";
}

/**
 * Protocol handler for mcp:// URLs.
 *
 * URL form:
 * - mcp://<resource-uri> (e.g. mcp://test://notes, mcp://ibkr://portfolio/positions)
 */
export class McpProtocolHandler implements ProtocolHandler {
	readonly scheme = "mcp";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: import("./types").ResolveContext): Promise<InternalResource> {
		const mcpManager = context?.mcpManager;
		if (!mcpManager) {
			throw new Error("No MCP manager available in the current scope. MCP servers may not be configured.");
		}
		const uri = extractResourceUri(url);
		const targetServer = resolveTargetServer(mcpManager, uri);
		if (!targetServer) {
			throw new Error(
				`No MCP server has resource "${uri}".\n\nAvailable resources:\n${formatAvailableResources(mcpManager)}`,
			);
		}

		let result: MCPResourceReadResult | undefined;
		try {
			result = await mcpManager.readServerResource(targetServer, uri);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`MCP resource read error: ${message}`);
		}

		if (!result) {
			throw new Error(`Server "${targetServer}" returned no content for "${uri}".`);
		}

		const textParts: string[] = [];
		for (const item of result.contents) {
			if (item.text !== undefined && item.text !== null) {
				textParts.push(item.text);
			} else if (item.blob) {
				textParts.push(`[Binary content: ${item.mimeType ?? "unknown"}, base64 length ${item.blob.length}]`);
			}
		}

		const content = textParts.length > 0 ? textParts.join("\n---\n") : "(empty resource)";
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`MCP server: ${targetServer}`],
		};
	}
}
