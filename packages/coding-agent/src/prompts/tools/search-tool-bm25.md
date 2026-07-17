Search hidden tool metadata to discover and activate tools.

Activate hidden tools (MCP and built-in) when you need a capability not in your active tool set.
Input:
- `query` — required natural-language or keyword query
- `limit` — optional maximum number of tools to return and activate (default `8`; start with 5–10 if unsure)

Behavior:
- Searches hidden tool metadata using BM25-style relevance ranking
- Matches against tool name, label, server name, description/summary, and input schema keys
- Activates the top matching tools for the rest of the current session
- Repeated searches add to the active tool set; they do not remove earlier selections
- Newly activated tools become available before the next model call in the same overall turn

Not for repository/file/code search. Tool discovery only.

Returns JSON with:
- `query`
- `activated_tools` — tools activated by this search call
- `match_count` — number of ranked matches returned by the search
- `total_tools`

Match details include:
- `server_name` — MCP server name when the activated result is an MCP tool
- `mcp_tool_name` — original MCP tool name when applicable
- `schema_keys` — searchable input property names
