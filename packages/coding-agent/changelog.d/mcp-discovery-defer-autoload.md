### Added

- `mcp.discoveryDeferAutoload` keeps conventionally autoloaded MCP tools (`gjc mcp add`, `.gjc/mcp.json`, `~/.gjc/agent/mcp.json`) out of the default tool selection when MCP discovery is on. The tools stay registered and become active through `search_tool_bm25`; servers listed in `mcp.discoveryDefaultServers` are still selected, so large MCP catalogs no longer occupy the context window up front.

### Fixed

- Explicit tool selections persist MCP authority even when the selectable catalog is empty or unchanged, so deselections survive resume instead of re-enabling configured defaults.
- Additive discovery activation retains unavailable names from persisted MCP selection, allowing temporarily missing tools to return when their catalog republishes.
- Committed MCP activations are merged into live selection authority before catalog-generation retries can discard their result.
- MCP selection authority now rolls back after failed tool updates and survives non-persisting catalog pruning; failed session-switch rollback restores matching tool signatures, prompts, and permission guards.
- Reactive custom-tool replacements are fenced against session transitions, so a predecessor catalog update cannot reactivate non-default MCP tools after `/new`.
- Deferred default-server activation is recomputed after catalog replacement waits for a session transition, preserving successor defaults after `/new`.
- Plan mode retries its internal tool swap after an MCP catalog change, keeping `resolve` available alongside newly published tools.
- Plan-mode retries preserve registered local tools whose names begin with `mcp__`.
- Plan approval preserves late default-server tools and transferred MCP selections without overriding successor-owned selections.
- Pending goal activation drops its new goal when a concurrent explicit tool selection supersedes the goal-tool swap, releasing the mode gate.
- Catalog refreshes use committed MCP selection authority so an in-flight tool request cannot leak into a replacement catalog.
- Discovery activation commits only the prior selection plus activated tools, keeping a concurrent failed explicit request out of MCP authority.
- Owned and inherited deferred-default callbacks consult committed authority so a pending request cannot suppress a default after catalog publication.
- Plan-mode exit retries its tool swap after catalog changes, preventing `resolve` from staying active after approval is disabled.
