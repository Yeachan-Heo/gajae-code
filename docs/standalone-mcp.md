# Standalone MCP configuration

`gjc mcp add` writes the definition supplied on that invocation to GJC's own MCP config (`~/.gjc/agent/mcp.json` by default, or `./.gjc/mcp.json` with `--project`). `gjc mcp list` and `gjc mcp remove` print redacted definitions with source scope and runtime status. Enabled registrations are consumed by ordinary standalone sessions at startup (conventional autoload).

## Conventional autoload

Ordinary top-level standalone sessions (`gjc`, `gjc --tmux`, print/text/json modes) discover and connect MCP servers from GJC's own native config scopes only:

| Source | Scope | Notes |
| --- | --- | --- |
| `.gjc/mcp.json`, `.gjc/.mcp.json` | project | Native GJC config; written by `gjc mcp add --project`. |
| `~/.gjc/agent/mcp.json`, `~/.gjc/agent/.mcp.json` | user | Native GJC config; written by `gjc mcp add`. |

User scope is the agent directory, not a fixed home path: an agent-directory profile (`GJC_CODING_AGENT_DIR`, an SDK session's `agentDir`) moves discovery, `gjc mcp add`, and the `disabledServers` denylist together, so a profile always autoloads its own registrations and never the default profile's.

Precedence per server name is deterministic: the native project scope wins over the native user scope on a name collision. Plugin-bundle MCP servers (from installed GJC plugins) override conventional servers with the same name; they are a validated, always-on product surface.

Claude Code and Codex MCP files (project `.claude/mcp.json` / `.claude/.mcp.json`, `.codex/config.toml` `[mcp_servers.*]`, and their user-global counterparts) are **import sources, not runtime authorities**: sessions never load them at startup. A bounded compatibility layer normalizes them into the same internal MCP contract, and an explicit import transaction writes the normalized definitions into the chosen `.gjc` scope (the `/extensions` import surface). `~/.claude`, `~/.codex`, and other foreign user-home configs are never read.

### Which servers load

A server is loaded at startup when all of the following hold:

- the server is not marked `enabled: false`;
- the server name is not in the `disabledServers` list of either native config scope (`<agent dir>/mcp.json` or `./.gjc/mcp.json`);
- the server is not marked `autoload: false` (autoload defaults to true; `autoload: false` keeps a server configured for on-demand `/mcp` connection);
- project-scope servers load by default; setting `mcp.enableProjectConfig` explicitly to `false` in settings disables every project-scope source for that environment.

Malformed or unparseable definitions are skipped fail-closed: they are never partially loaded, a warning is emitted, and the session continues with the remaining valid servers. A server that fails to connect reports an error entry and the session continues.

### Opt out

Pass `--no-mcp` to skip conventional autoload for one session (plugin-bundle MCPs and exact-file `--mcp-config` remain governed by their own surfaces). `--no-mcp` and `--mcp-config` are mutually exclusive.

### Subagents and lifecycle

Top-level sessions own their MCP manager and clean up server processes on session end. Subagents inherit the parent session's manager facade: they never spawn duplicate server processes and never take ownership of cleanup.

## Use an explicit config

A caller can opt one top-level standalone session into one trusted config file instead of conventional autoload:

```bash
gjc --mcp-config /absolute/path/to/mcp.json
```

The path must be absolute and identify a regular file directly; symbolic links and other indirection are rejected. GJC reads the file through one open handle and rejects it if the path, file identity, size, or modification metadata changes during the read. Exact-file mode **replaces** conventional autoload: it exposes only that file's MCP tools and does not overlay `.gjc/mcp.json` registrations from either scope. GJC owns the server processes for that session. It does not load server prompts, resources, instructions, sampling, or other config files. Expected read, parse, validation, and connection failures emit one sanitized warning and continue. Unexpected errors and final-catalog tool-name collisions clean up and abort startup.

There is no MCP config reload while the session runs except `/mcp reload` in sessions without plugin-bundle MCP servers, and no subagent inheritance of exact-file tools beyond the parent session's exposed catalog.

## Supported integrations

| Need | Use | Notes |
| --- | --- | --- |
| Register servers for every standalone session | `gjc mcp add <name> ...` | Conventional autoload in user scope; `--project` scopes to the current project. |
| Trust one MCP config for one standalone session | `gjc --mcp-config /absolute/path/to/mcp.json` | Exact-file, top-level, tools-only opt-in; GJC owns cleanup; replaces autoload. |
| Disable conventional autoload for one session | `gjc --no-mcp` | Skips native `.gjc` user/project discovery; plugin-bundle and exact-file surfaces are unaffected. |
| External bot or multi-session controller | [Coordinator MCP](./hermes-mcp-bridge.md) | Coordinator MCP exposes GJC lifecycle and coordination tools. |
| External session control | [SDK session CLI](./sdk-session-cli.md) or a managed adapter | Broker-bound controls and opaque Router attachments; no direct endpoint transport. |
| Editor/ACP client owns MCP servers | ACP via `gjc --mode acp` or `gjc acp` | ACP remains a stdio editor protocol. |
| Codex / Claude Code delegation plugin | [Canonical gajae-code plugin](./hermes-mcp-bridge.md) | Installs Coordinator MCP plus GJC delegation commands. |

## Boundary

Standalone GJC does not inherit user-home MCP configurations from Claude Code, Codex, OpenCode, or other tools (`~/.claude`, `~/.codex`, and similar user-global configs are never read). MCP servers often carry credentials, filesystem reach, browser state, approval semantics, and lifecycle that belong to the configuring host. Claude/Codex MCP files are normalized only through the bounded compatibility layer on explicit import, and the only MCP config read from the user's home directory at session startup is GJC's own `~/.gjc/agent/mcp.json` (or the active agent directory when a profile overrides it).

`--mode rpc`, `--mode rpc-ui`, `--mode bridge`, and `gjc sdk serve` have been removed. Do not use the former RPC host-tool protocol to connect an MCP server; use Coordinator MCP, the [SDK session CLI](./sdk-session-cli.md), or a managed adapter for supported external control.

## Related docs

- [SDK machine interfaces](./sdk.md)
- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)
