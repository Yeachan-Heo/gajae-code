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
- the server is not marked `autoload: false` (autoload defaults to true; `autoload: false` keeps a server stored but unloaded at startup — flip the flag and start a new session to load it);
- project-scope HTTP and SSE servers load by default. A project stdio server is spawned only when the user config sets `mcp.enableProjectConfig` to true. A project settings file cannot set that flag. Setting it to false in the user config disables every project-scope source.

Conventional discovery logs a structured `Skipping MCP autoload registration`
diagnostic with the server name and reason when an eligible-looking entry is
disabled, denylisted, or opted out with `autoload: false`.

Malformed or unparseable definitions are skipped fail-closed: they are never partially loaded, a warning is emitted, and the session continues with the remaining valid servers. A server that fails to connect reports an error entry and the session continues.

Ordinary startup uses a bounded wait for the initial MCP batch. With no positive
per-server timeouts, the default wait is 250ms. When any registration declares a
positive `timeout`, the batch wait is the largest declared timeout plus 500ms of
grace, capped at 1,750ms. An untimed registration is disconnected when that
effective batch wait expires, so slow stdio or remote servers can be absent from
the first session even though the registration is valid. `gjc mcp list` reports
a `startupDiagnostic` for these entries (and the runtime log records the server
name and timeout reason). Add a per-server window when registering a slow server,
for example:

```bash
gjc mcp add <name> --command <cmd> --timeout 10000
```

With a positive `timeout`, the server continues connecting in the background
after the bounded batch wait until its declared window ends. The connection
result and log retain a per-server error if that window is also exhausted.

### Opt out

Pass `--no-mcp` to skip conventional autoload for one session (plugin-bundle MCPs and exact-file `--mcp-config` remain governed by their own surfaces). `--no-mcp` and `--mcp-config` are mutually exclusive.

## Public slash-command boundary

Only an interactive session using exact-file `--mcp-config` exposes the
session-scoped `/mcp` status and control command. Ordinary TUI sessions and ACP
do not advertise a top-level `/mcp`; `/mcp test`, `/mcp reauth`, and `/mcp reload`
are not supported user-input entry points. Use `gjc mcp add`, `gjc mcp list`, or
`gjc mcp remove` to manage stored registrations and start a new session.
`--mcp-config` and the SDK's `mcpConfigPath` are explicit connection-consumer
entry points for a trusted config; they do not initiate MCP OAuth authorization.
Existing credentials bound through `auth` may be refreshed by the runtime, but
there is no public MCP OAuth authorization or reauthorization entry path, nor a
public config reload contract.

## Subagents and lifecycle

Top-level sessions own their MCP manager and clean up server processes on session end. Subagents inherit the parent session's manager facade: they never spawn duplicate server processes and never take ownership of cleanup.

## Tool-result images

Successful MCP tool results forward PNG, JPEG, GIF, and WebP images (including
embedded resources with an image `mimeType` and base64 `blob`) to image-capable
models on providers whose tool-result transport carries images. Providers that
flatten tool results to text, including Kiro, receive the text markers instead.
Images follow the text block in their original order. Text keeps an image
or resource marker, with a coordinate-mapping note when an image is resized, and
retains the untrusted-content wrapper. Forwarded images also carry an explicit
notice that they are untrusted server content and must be treated as data, not
instructions.

Images use the built-in shared resizer: at most 1,568 pixels per dimension and
500 KiB per image, with the same recompression and `GJC_NO_WEBP` behavior. Each
result attempts at most 16 supported images (matching the pasted-image count
limit), processes at most 16 MiB of base64 source data (the MCP response budget),
and forwards at most 4 MiB of image-file bytes after resizing, before base64
encoding. Before native decoding, source images must have dimensions no larger
than 8,192 pixels per side and no more than 16 million pixels total. Supported
image bytes determine the forwarded MIME type when a server mislabels an image.
Images that are invalid, unsupported, or over these limits retain only their
text markers. Error results remain text-only. Models without
image input use the existing provider filtering and receive text instead of image
payloads.

## Use an explicit config

A caller can opt one top-level standalone session into one trusted config file instead of conventional autoload:

```bash
gjc --mcp-config /absolute/path/to/mcp.json
```

The path must be absolute and identify a regular file directly; symbolic links and other indirection are rejected. GJC reads the file through one open handle and rejects it if the path, file identity, size, or modification metadata changes during the read. Exact-file mode **replaces** conventional autoload: it exposes only that file's MCP tools and does not overlay `.gjc/mcp.json` registrations from either scope. GJC owns the server processes for that session. It does not load server prompts, resources, instructions, sampling, or other config files. Expected read, parse, validation, and connection failures emit one sanitized warning and continue. Unexpected errors and final-catalog tool-name collisions clean up and abort startup.

There is no public MCP config reload while the session runs; edit the config and start a new session. There is no subagent inheritance of exact-file tools beyond the parent session's exposed catalog.

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

## Example: free web search with Parallel

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides web search and page fetching over Streamable HTTP without an account or API key. Anonymous searches use Fast mode and have lower rate limits intended for exploration and light use.

Search objectives, queries, and fetch URLs are sent to Parallel when these tools are called; avoid including sensitive information.

From the project where you want the tools, register the server:

```bash
gjc mcp add parallel-search --project \
  --type http --url https://search.parallel.ai/mcp \
  --header 'User-Agent=gajae-code/parallel-search-mcp' \
  --timeout 30000
gjc mcp list --project
```

The registration is stored in `./.gjc/mcp.json`. `list` confirms the stored definition and autoload eligibility; it does not test the remote connection. Start a new `gjc` session in that project to load the server. The two tools are exposed as `mcp__parallel_search_web_search` and `mcp__parallel_search_web_fetch`. Use search for current information and fetch for a specific page that needs closer reading. Reuse one `session_id` across related calls in a conversation when supplying that optional argument.

This adds MCP tools alongside the built-in `web_search` tool; it does not select or configure the built-in Parallel API provider. Existing registrations are preserved, and an existing `parallel-search` entry is not overwritten unless you explicitly pass `--force`. Keep the positive timeout so remote discovery can complete in the background after the bounded startup wait described above. To remove the project registration:

```bash
gjc mcp remove parallel-search --project
```

## Boundary

Standalone GJC does not inherit user-home MCP configurations from Claude Code, Codex, OpenCode, or other tools (`~/.claude`, `~/.codex`, and similar user-global configs are never read). MCP servers often carry credentials, filesystem reach, browser state, approval semantics, and lifecycle that belong to the configuring host. Claude/Codex MCP files are normalized only through the bounded compatibility layer on explicit import, and the only MCP config read from the user's home directory at session startup is GJC's own `~/.gjc/agent/mcp.json` (or the active agent directory when a profile overrides it).

`--mode rpc`, `--mode rpc-ui`, `--mode bridge`, and `gjc sdk serve` have been removed. Do not use the former RPC host-tool protocol to connect an MCP server; use Coordinator MCP, the [SDK session CLI](./sdk-session-cli.md), or a managed adapter for supported external control.

## Related docs

- [SDK machine interfaces](./sdk.md)
- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)
