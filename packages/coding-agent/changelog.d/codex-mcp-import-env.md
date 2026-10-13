### Fixed

- Codex MCP import no longer writes a resolved secret into `.gjc/mcp.json`. An import into the project config omits `bearer_token_env_var`, `env_vars`, and `env_http_headers` references, including a user config imported into the project, so a later load cannot expand a host value. An import into the global config keeps a local name as `${NAME}`. An entry whose source is not local is skipped.
