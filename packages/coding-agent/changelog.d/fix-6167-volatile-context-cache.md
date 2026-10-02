### Fixed

- Restore cache prefix extension across LLM requests by keeping volatile project context and untrusted MCP server instructions in `agent.state.messages` after they are sent, rather than removing them after each turn. This allows subsequent requests to properly reuse the cache prefix from previous requests, improving cache hit rates and reducing unnecessary re-computation. Volatile ephemeral messages are still excluded from persistent storage as intended. Fixes #6167.
