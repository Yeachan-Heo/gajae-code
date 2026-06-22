# Standalone GJC MCP support

This page answers the common user question: “Does normal `gjc` inherit my Claude Code/Codex MCP servers, or can I configure MCP servers directly for the standalone TUI?”

## Short answer

Normal standalone GJC (`gjc`, `gjc --tmux`, and print-mode prompts) does **not** inherit MCP servers from Claude Code, Codex, Cursor, Gemini, Windsurf, or other tools as a public startup contract.

There is also no supported user-facing `~/.gjc/agent/config.yml` setting that makes the normal standalone TUI automatically load arbitrary MCP servers for the model. Historical/internal MCP discovery code and `.mcp.json` shapes exist in the repository, but they are not the supported public integration boundary for ordinary standalone sessions.

If you rely on a specific MCP server, run it through one of the supported integration surfaces below instead of assuming another tool's MCP config will be imported into standalone GJC.

## What is supported today

| Need | Use | Notes |
| --- | --- | --- |
| External bot or multi-session controller wants to drive GJC | [Coordinator MCP](./hermes-mcp-bridge.md) via `gjc mcp-serve coordinator` | GJC exposes an **outward** MCP server with GJC coordinator tools. This is not a way to import arbitrary MCP tools into the standalone TUI. |
| Editor/ACP client owns MCP servers and wants GJC as the agent backend | [ACP mode](./external-control-readiness.md#acp-mode) via `gjc --mode acp` or `gjc acp` | The ACP client supplies and owns MCP servers. GJC keeps those client-owned MCP tools isolated from standalone on-disk discovery. |
| Host application already manages MCP servers and policies | [RPC host tools](./rpc.md#host-tool-sub-protocol) via `gjc --mode rpc` | Convert the selected MCP capabilities into host-owned RPC tools. The host executes the MCP call and returns `host_tool_result`. |
| OpenClaw/Hermes-style host wants to map its own MCP/skills into GJC | [OpenClaw / Hermes RPC integration notes](./openclaw-hermes-rpc-integration.md) | Treat MCP as a host implementation detail and expose only policy-approved capabilities as RPC host tools. |
| Codex / Claude Code want a one-step install to delegate planning/execution to GJC | [Canonical gajae-code plugin](./hermes-mcp-bridge.md) under `plugins/` via `gjc setup claude` / `gjc setup codex` | Installs the Coordinator MCP server plus `gjc_delegate_plan/execute/team` commands. Fail-closed: workdir-scoped roots, mutations off until opt-in. Install with `codex plugin marketplace add ./plugins` (verified on Codex CLI 0.139.0) or `/plugin marketplace add ./plugins` for Claude Code. |

## What standalone GJC does not do

Standalone GJC does **not** currently promise any of these behaviors:

- reading Claude Code's global MCP server list and automatically enabling it;
- reading Codex MCP server config as an inherited runtime contract;
- merging multiple tools' MCP configs into the normal TUI at startup;
- making `.mcp.json`, `mcp.json`, `.codex/config.toml`, or other discovered files a stable public standalone-TUI config API;
- exposing Coordinator MCP tools as ordinary in-session model tools.

This boundary is intentional: MCP servers often carry credentials, local filesystem reach, browser/session state, approval semantics, and tool names that belong to the host that configured them. Blind inheritance would mix policies between products and make it unclear which process owns credentials, approvals, sandboxing, and lifecycle.

## Recommended workaround for a specific MCP server

If you need a context engine, internal search server, browser MCP, database MCP, or another custom MCP inside GJC:

1. Keep the MCP server configured in the host that owns its credentials and policy.
2. Start GJC through RPC (`gjc --mode rpc`) from that host.
3. Register a narrow host-owned tool with `set_host_tools` / `RpcClient#setCustomTools()`.
4. Have the host tool call the real MCP server and return the result to GJC as `host_tool_result`.

That shape keeps the MCP server's auth, approvals, filesystem access, and process lifetime with the host while still letting the GJC model request the capability when needed.

For multi-session orchestration, prefer Coordinator MCP instead. Coordinator MCP lets an external controller start/register sessions, send turns, answer questions, read artifacts, and write durable status reports; it does not import arbitrary MCP servers into a standalone TUI session.

## Related docs

- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)
- [RPC Protocol Reference](./rpc.md)
- [OpenClaw / Hermes RPC integration notes](./openclaw-hermes-rpc-integration.md)
- [Clawhip-routed GJC sessions](./gjc-session-clawhip-routing.md)
