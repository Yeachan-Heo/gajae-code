### Fixed

- Keep Escape local to focused menus and nested selectors during compaction, handoff, retry backoff, and MCP/Smithery browser authorization, instead of interrupting the background operation. Preserve global clear-key cancellation even when clear and interrupt bindings overlap, and retain hook workflow interrupt behavior.
