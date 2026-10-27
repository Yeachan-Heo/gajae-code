/**
 * Tools Cursor already runs on a dedicated exec channel.
 * Keep this aligned with CURSOR_NATIVE_TOOL_NAMES in packages/ai/src/providers/cursor.ts.
 */
const CURSOR_DEDICATED_CHANNEL_TOOLS = new Set(["bash", "read", "write", "delete", "ls", "grep", "lsp", "todo_write"]);

/**
 * Name to dispatch from a Cursor MCP call.
 * Dedicated-channel tools are refused here. Advertised session tools such as eval stay allowed.
 */
export function cursorMcpDispatchName(call: { toolName?: string; name?: string }): string | null {
	const toolName = call.toolName || call.name || "";
	if (toolName.length === 0 || CURSOR_DEDICATED_CHANNEL_TOOLS.has(toolName)) return null;
	return toolName;
}
