### Fixed

- `AgentSession.messages` no longer exposes request-scoped ephemeral messages (`volatile-project-context`, `untrusted-mcp-server-instructions`) that #6167 retains in `agent.state.messages` for prompt-cache prefix reuse. The cache prefix behavior is unchanged; the public view and everything built on it match the pre-#6167 transcript again, which fixes the red `dev` CI in the managed fallback attempt transaction test (#6191).
