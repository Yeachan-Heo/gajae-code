### Fixed

- Exa MCP tool-call responses are formatted in bounded time. `formatGenericResponse` re-indents the entire formatted subtree at every object level, so cost grew super-linearly with nesting depth: 500/1000/2000/4000/8000 levels cost 60ms/227ms/730ms/5.9s/94s, and 20000 levels exhausted the call stack. The payload is whatever the remote MCP server returned, and the 16 MiB content cap does not bound depth — 8000 levels of `{"a":` is under 47 KB. Depth is now limited to 64, matching the session-import walker, and output for payloads within that limit is unchanged.
