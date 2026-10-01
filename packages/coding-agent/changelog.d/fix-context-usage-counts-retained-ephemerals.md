### Fixed

- Context-usage and compaction token estimates count the request-scoped ephemeral messages (`volatile-project-context`, `untrusted-mcp-server-instructions`) that are retained in `agent.state.messages` for prompt-cache reuse. They are hidden from `AgentSession.messages`, so estimating over that public view undercounted the real provider request and could delay auto-compaction until the context window overflowed.
