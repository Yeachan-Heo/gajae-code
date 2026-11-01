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
- the server is not marked `autoload: false` (autoload defaults to true; `autoload: false` keeps a server stored but unloaded at startup — flip the flag and start a new session, or use `/mcp connect <name>` from an eligible interactive session);
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

### Keep autoloaded tools behind tool search

With MCP discovery on, autoloaded servers' tools are selected by default, so every tool schema is sent with each request. Servers with large catalogs can take a large share of the context window. Set `mcp.discoveryDeferAutoload: true` to register those tools without selecting them; the model activates them on demand with `search_tool_bm25`. Servers listed in `mcp.discoveryDefaultServers` remain selected.

```yaml
# ~/.gjc/agent/config.yml
mcp:
  discoveryDeferAutoload: true
  discoveryDefaultServers: [github]
```

## Public slash-command boundary

Ordinary interactive sessions without the MCP session-control capability, and all
ACP sessions, do not register a top-level `/mcp` command. On those surfaces
`/mcp test`, `/mcp reauth`, `/mcp reconnect`, and `/mcp reload` are not
supported user-input entry points. Use `gjc mcp add`, `gjc mcp list`, or
`gjc mcp remove` to manage stored registrations and start a new session.

A conventional interactive root session with the capability exposes
`/mcp status`, `/mcp list`, `/mcp connect <name>`, `/mcp disconnect <name>`,
and `/mcp reconnect <name>`. It controls only servers declared in the native
GJC user or project `.gjc` `mcp.json` files, subject to the same startup gates:
`enabled: false`, `disabledServers`, and unapproved project stdio servers are
refused. These controls are runtime-only and never write `mcp.json`; `/new` and
session switches restore the startup policy. They are unavailable in ACP, print
modes, SDK sessions, and subagents.

An interactive session started with exact-file `--mcp-config` is the exception:
it exposes the session-scoped `/mcp` status and control command for the servers
in that exact config, including `/mcp suspend <name>`, `/mcp resume <name>`, and
`/mcp reconnect <name>`; `--mcp-config` keeps that exact surface.
`--mcp-config` and the SDK's `mcpConfigPath` are explicit connection-consumer
entry points for a trusted config; they do not initiate MCP OAuth authorization.
Existing credentials bound through `auth` may be refreshed by the runtime, but
there is no public MCP OAuth authorization or reauthorization entry path, and no
`/mcp reload` contract.

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

## Example: local code navigation with Sem

[Sem](https://github.com/Ataraxy-Labs/sem) provides structural code search,
caller navigation, impact analysis, and diffs through a local stdio MCP server.
Install Sem separately and confirm `sem --version` (tested with 0.27.0).
From the Git repository you want GJC to inspect.

Sem is a project-scope **stdio** server, so GJC spawns it only when the user
config opts in. A project settings file cannot grant that flag; set it in the
user config (`~/.gjc/agent/config.yml`, or the active agent directory). This is
a global setting that covers every checkout, so restore it after the example.
First, record whether the setting was previously set:

```bash
# Note the prior value (output is empty if unset, 'true' or 'false' if set).
gjc config get mcp.enableProjectConfig
# Enable project stdio servers for this example.
gjc config set mcp.enableProjectConfig true
```

Then register the server from the Git repository you want GJC to inspect:

```bash
gjc mcp add sem --project --command sem --arg mcp \
  --cwd "$PWD" --env "SEM_REPO=$PWD" \
  --env SEM_NO_NETWORK=1 --env SEM_NO_TELEMETRY=1 --timeout 10000
gjc mcp list --project
```

This records an absolute repository path in `./.gjc/mcp.json`; register again
if you move the checkout. Review the configuration before sharing it. `list`
checks registration, not connectivity. Start a new `gjc` session **after** the
user-config opt-in above; without it the project stdio server is skipped and no
`mcp__sem_*` tools appear. No Sem account or API key is required; indexing can
create local cache files.

Try asking the agent to find a function with `sem_find`, then request its
source and surrounding context with the same tool's `mode: "context"`.
Use a symbol that exists in your repository. Keep normal file tools available
for unsupported syntax and non-code files.

The server is not a read-only sandbox: for example, `sem_check` can execute
repository validation commands. Only connect trusted repositories and approve
operations according to your normal workflow. The repository path and offline
environment settings do not restrict the process's filesystem permissions.

Remove the registration with `gjc mcp remove sem --project`.

`mcp.enableProjectConfig` is a **global** user setting: it applies to every
checkout you open, not just this repository or Sem. Setting it to `false` is not
the equivalent of leaving it alone — `false` disables *every* project-scope MCP
source, including project HTTP and SSE servers that load by default.

After the example, restore the setting to its prior state. If you recorded that
it was unset (empty output), you can simply leave it unset by not setting it
again in future sessions. If you recorded a prior value, restore it:

```bash
# Restore to the prior value you recorded (e.g., 'true' or 'false').
gjc config set mcp.enableProjectConfig <prior-value>
```

**Important:** The `gjc config reset` command is not the correct cleanup. The
setting has a schema default of `false`, so `reset` writes an explicit `false`
value, which disables every project-scope MCP source everywhere (including
project HTTP and SSE servers that load by default), not the desired unset
behavior. Always restore to the prior value you recorded, or leave it unset
if it was previously unset.

### Optional: preview overlapping branch changes with Weave

[Weave](https://github.com/Ataraxy-Labs/weave) complements navigation with
structural merging. It is a separate CLI, not a dependency of this MCP setup.
If installed (`weave --version`, tested with 0.5.4), ask GJC to use its terminal
tool in the chosen Git repository to inspect status and preview a specific
existing branch:

```bash
git status --short
weave preview feature-branch
```

Replace `feature-branch` with the branch you actually want compared to HEAD.
Preview does not apply the merge. Do not automatically run `weave setup`,
`weave land`, or `git merge` after it succeeds. A clean structural merge is
not proof of compilation or behavioral correctness; applying changes and
running the project's checks remain separate, explicitly requested steps.

## Boundary

Standalone GJC does not inherit user-home MCP configurations from Claude Code, Codex, OpenCode, or other tools (`~/.claude`, `~/.codex`, and similar user-global configs are never read). MCP servers often carry credentials, filesystem reach, browser state, approval semantics, and lifecycle that belong to the configuring host. Claude/Codex MCP files are normalized only through the bounded compatibility layer on explicit import, and the only MCP config read from the user's home directory at session startup is GJC's own `~/.gjc/agent/mcp.json` (or the active agent directory when a profile overrides it).

`--mode rpc`, `--mode rpc-ui`, `--mode bridge`, and `gjc sdk serve` have been removed. Do not use the former RPC host-tool protocol to connect an MCP server; use Coordinator MCP, the [SDK session CLI](./sdk-session-cli.md), or a managed adapter for supported external control.

## Related docs

- [SDK machine interfaces](./sdk.md)
- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)
