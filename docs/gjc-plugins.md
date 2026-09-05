# GJC Plugin Bundles

GJC supports two distinct plugin families. Do not confuse them:

1. **Legacy marketplace / npm plugins** (`packages/coding-agent/src/extensibility/plugins`) — installed through the existing `gjc plugin install <marketplace-ref|npm-spec>` marketplace/npm flows. Unchanged by this system.
2. **GJC plugin bundles** — directories whose root contains a **`gajae-plugin.json`** manifest (`kind: "gajae-code-plugin"`). These *extend* existing GJC capabilities and are the subject of this document.

A GJC plugin bundle may only **extend** existing skills/agents — it can never register a new top-level skill, slash-command, command, or agent. GJC exposes exactly four default workflow skills (`autoresearch`, `deep-interview`, `ralplan`, `ultragoal`) and four role agents (`executor`, `architect`, `planner`, `critic`); bundles add sub-skills/appendices/tools/hooks/MCPs to those existing parents only.

## Loose customization vs plugin bundles

A plugin manifest is **never required** to add one local MCP, hook, skill, or extension. Native loose customization has one canonical destination in each scope: `<project>/.gjc/` for project-local configuration and `~/.gjc/agent/` for user-global configuration. Claude Code and Codex layouts are explicit import sources for `/extensions` ([#4291](https://github.com/Yeachan-Heo/gajae-code/issues/4291)); they are not parallel runtime authorities. Reach for a bundle only when you want a versioned, distributable package of several surfaces with atomic install/update/uninstall, hashing, quarantine, and collision ownership.

| You want… | Loose surface (no manifest) | Plugin bundle (`gajae-plugin.json`) |
|-----------|-----------------------------|-------------------------------------|
| **One local MCP server** | `mcpServers` map in `<project>/.gjc/mcp.json` or `~/.gjc/agent/mcp.json`; supports `command`/`args`/`env`/`cwd`/`url`/`headers`/`auth`/`oauth`/`type` | `mcps` array (or the `mcpServers` alias — see below); no `env`/`auth`/`oauth`/`headers` |
| **One local hook** | `<project>/.gjc/hooks/pre/<tool>.ts` / `post/<tool>.ts`, or the same layout under `~/.gjc/agent/hooks/` | `hooks` array of constrained `{ name, event, target?, phase?, path }` entries |
| **One local skill** | `.gjc/skills/<name>/SKILL.md` (project) / `~/.gjc/agent/skills/<name>/SKILL.md` (user) | `subskills` entries bound to an existing protected parent (`binds_to`/`phase`/`activation_arg`) |
| **One local extension** | `<project>/.gjc/extensions/<name>/` or `~/.gjc/agent/extensions/<name>/`, with its extension manifest + entry | Bundles have no extension surface; extensions are loose-only |
| **Versioned multi-surface distribution** | — | ✅ Bundle (recommended path) |
| **Atomic install/update/uninstall, hashing, quarantine, collision ownership** | — | ✅ Bundle |
| **A brand-new top-level workflow skill** | ✅ Loose `.gjc/skills/<name>/SKILL.md` (never via a bundle) | ❌ Forbidden (`forbidden_surface`) — bundles may only extend the four protected workflow skills |

Rule of thumb: one local surface → loose file; several surfaces you want to version, hash, install atomically, and redistribute → bundle.

Import is a transaction, not discovery precedence: `/extensions` selects Claude Code or Codex plus project-local or user-global scope, previews the normalized result, then writes the accepted configuration into the selected canonical `.gjc` scope. Import UI and transaction behavior belong to #4291; this bundle contract neither activates foreign layouts at runtime nor implements that UI.

## Manifest (`gajae-plugin.json`)

```json
{
  "kind": "gajae-code-plugin",
  "name": "example-domain-bundle",
  "version": "1.0.0",
  "subskills": ["subskills/ralplan-design/SKILL.md"],
  "tools": [
    { "name": "domain_note", "path": "tools/domain-note.ts", "description": "..." }
  ],
  "hooks": [
    { "name": "audit-read", "event": "tool_call", "target": "read", "phase": "before", "path": "hooks/audit-read.ts" }
  ],
  "mcps": [
    { "name": "domain_docs", "transport": "stdio", "command": "bun", "args": ["mcp/domain-docs.ts"], "cwd": "." }
  ],
  "system_appendix": [{ "name": "domain-policy", "path": "prompts/system-appendix.md" }],
  "agent-appendix": [{ "agent": "executor", "name": "domain-executor", "path": "prompts/executor-appendix.md" }]
}
```

### Surfaces (the only allowed extension points)

| Surface | Purpose | Additive rule |
|---------|---------|---------------|
| `subskills` | Inline sub-skills bound to an existing skill/agent (`binds_to`/`phase`/`activation_arg`) | Two-tier (see below) |
| `tools` | Always-on custom tools (object entries) or legacy subskill-scoped string paths | Additive; manifest-declared name is authoritative, never overwrites an existing tool |
| `hooks` | Constrained event hooks bound to a declared `event`/`target`/`phase` | Additive; run alongside built-ins, never replace |
| `mcps` | MCP servers (`stdio`/`http`/`sse`); the Claude Code `mcpServers` map alias is accepted and normalized to this | Additive; server-name collisions are hard errors |
| `system_appendix` | Lower-authority text appended to the default agent system prompt | Append-only, never overrides base |
| `agent-appendix` | Lower-authority text appended to an existing role agent's prompt | Append-only per named agent |

### Compatibility aliases, forbidden, and unsupported keys

**Accepted aliases** — normalized into the canonical compiled representation at parse time, so a manifest using the alias compiles to byte-equivalent surfaces as the canonical spelling:

- `mcpServers` (Claude Code / loose mcp.json map, server name → config) → normalized into the canonical `mcps` array. Per-server `type` maps to `transport`; `command` implies `stdio` and a bare `url` implies `http` when `type` is absent. Only transport-relevant fields with an end-to-end bundle runtime equivalent are accepted (`type` plus `command`/`args`/`cwd` for `stdio`, or `url` for `http`/`sse`); anything else is a targeted migration diagnostic (see below).

**Targeted migration diagnostics** — the alias shape cannot be preserved, so the manifest fails with an actionable suggested canonical form instead of a generic unknown/forbidden-key error:

- `mcp` (singular) — ambiguous shape; use canonical `mcps` or the `mcpServers` alias.
- `skills` (top level) — bundles may only EXTEND the four protected workflow skills; use `subskills` or the loose `.gjc/skills/<name>/SKILL.md` surface. Never silently replaced by a bundle (`forbidden_surface`).
- `agents` (Claude Code plugin.json) — top-level agents are protected; use `subskills` bound to `executor`/`architect`/`planner`/`critic` (`forbidden_surface`).
- `commands` / `slash-commands` (Claude Code plugin.json) — bundles cannot register slash commands; use the loose `.gjc/commands/<name>` surface (`forbidden_surface`).
- `hooks` written as a Claude Code plugin.json event-keyed map or `{ matcher, hooks, source }` entries — cannot be preserved as constrained GJC bundle hooks; use canonical `{ name, event, target?, phase?, path }` or the loose `.gjc/hooks/pre|post/<tool>.ts` surface (`invalid_manifest`).
- `mcpServers` entries using `env`/`auth`/`oauth`/`headers`/`enabled`/`timeout`/`autoload`/`noInheritEnv`, or fields incompatible with the selected transport — the bundle runtime cannot preserve these semantics end to end. Move the server to canonical loose `.gjc/mcp.json` (directly or through the `/extensions` import flow in #4291) or drop the field (`unsupported_surface`).
- Any unknown top-level key — names the full canonical key set.

**Never accepted in any form:** `mcps` + `mcpServers` together, an `mcpServers` entry that cannot determine a transport, and any per-server key outside the accepted vocabulary.

## Installation

```sh
gjc plugin install <path|git-url|tarball> --user      # install into the user root
gjc plugin install <path|git-url|tarball> --project   # install into the project root
```

Exactly one of `--user` / `--project` is required for GJC plugin bundles (there is no default root). A source containing `gajae-plugin.json` is classified as a GJC bundle and routed to the bundle installer **before** the marketplace/npm path; non-bundle sources fall through to the legacy flow.

Install is **compile-validate-then-copy**:

1. The bundle is compiled and validated **without importing any plugin code** (manifest, frontmatter, and declared files are read as bytes only).
2. Collision and MCP security policy are enforced (the durable registry is the collision authority — never capability "first-wins").
3. Only the validated, hashed files are copied into a temp sibling, then atomically renamed into place; the registry entry is written last under a per-scope lock. Nothing is mutated on failure.

Idempotency: re-installing identical content is a no-op; different content requires `--force`.

## Security model

- **Install validation never executes plugin code.** Tool/hook names are manifest-declared; at runtime the loaded factory must return/register exactly the declared name/event or the surface is quarantined (`runtime_mismatch`).
- **MCP policy** (install + runtime connect): HTTPS-only for `http`/`sse`; private/loopback/link-local/unique-local/multicast and the `169.254.169.254` metadata endpoint are denied across IPv4, IPv6, IPv4-mapped/compatible, zone-id and trailing-dot forms; URL credentials and CRLF headers are rejected; DNS is re-resolved before connect (rebinding defence). `stdio` manifests remain confined to bare `node`/`bun` grammar with the bundled entrypoint first; launcher options, `--`, path-qualified commands, shebang aliases, and unsupported entrypoint formats fail closed. Runtime execution currently admits Node `.mjs` on Linux only; Bun, macOS, and Windows stdio launch fail closed until equivalent loader and owner/process-tree authority exists. The compiler hashes every effective-`cwd` file selected by the shared classifier. Immediately before each Node spawn, runtime rebinds the canonical registry identity and complete copied-file manifest, verifies canonical Node bytes captured from the OS-provided startup PATH, and writes the interpreter plus authenticated files into a unique owner-only capsule outside workspace/plugin roots. Later dotenv/environment mutation cannot grant interpreter authority. The child imports the entrypoint by file URL, so relative imports work while bare/absolute package resolution, CommonJS `createRequire`, and native modules cannot escape authenticated files. Each launch has independent authority, including concurrent connections, and the parent removes its capsule after confirmed exit or failed spawn. Snapshot admission is bounded to 8,192 files and 128 MiB; interpreter capture is bounded to 512 MiB. Post-entrypoint server arguments remain literal argv except for no-expansion/path confinement checks.
  **Trust boundary:** launch capsules provide authenticated, private snapshots against workspace/plugin-path substitution and other OS users. They are not OS-sealed executables or a sandbox against an independently hostile process with the same host UID, debugger access, or process-memory control. The host UID and its runtime dependencies remain trusted. Authenticated module loading does not grant general filesystem isolation to plugin code.
- **Hooks** run through a *constrained* API: only a handler for the declared event may be registered. `registerCommand`, `sendMessage`, `appendEntry`, renderer registration, and shell `exec` are denied (`security_policy`). The broad first-party hook API is never exposed to bundle hooks.
- **Appendices** render as lower-authority, delimited `<gjc-plugin-system-appendix>` / `<gjc-plugin-agent-appendix>` blocks appended after the base/project prompt; size-capped (8 KiB/appendix, 32 KiB total) fail-closed; content is escaped and control-char sanitized. They can never override base/developer instructions.
- **Hash drift**: installed files are re-verified against the registry at session start; any drift quarantines the plugin (`runtime_mismatch`).

## Sub-skills: Tier-1 vs Tier-2

- **Tier-1 advertisement** (metadata-only): when a parent skill/agent prompt is built, installed sub-skills bound to it are advertised as a bounded list (`plugin` / `name` / `description` / `activation_arg` / `phase`; max 12 items, 200-char descriptions, 4 KiB block, with an overflow note). No body content; rendered only in the target parent prompt, never the global public-workflow surface.
- **Tier-2 activation** (full body): on explicit activation (e.g. `deep-interview --autoresearch`) or an agent's contextual choice, the full sub-skill body is injected as a `<gjc-subskill>` block at the matching phase.

## Registry, enablement, and quarantine

Each scope keeps a durable `registry.json` recording per-plugin: name/version, source (`path`/`git`/`tarball` + ref/sha), manifest hash, copied files (relative path + sha256 — the uninstall ownership boundary), per-surface extension IDs, `enabled` flag, `disabledSurfaceIds`, and any `quarantine` entries.

Extension IDs are stable: `tool:<name>`, `hook:<event>:<phase>:<target>:<name>`, `mcp:<name>`, `system-appendix:<plugin>:<name>`, `agent-appendix:<agent>:<plugin>:<name>`, `subskill:<parent>:<phase>:<activation_arg>`. Disabled is user-controlled (not an error); quarantine is fail-closed and visible.

## Status / scope notes

- Always-on **tools**, **system appendices**, **agent appendices**, and **Tier-1 advertisement** activate at session start (additive; no-op when no bundle is installed).
- **MCP runtime connection** and the **live hook runner** integration are gated behind the same validated registry + policy; consult the ledger/run notes for their wiring status.
- Install, force update (`gjc plugin upgrade`), enable/disable, uninstall, quarantine, and hash-drift are covered by the lifecycle suite; the registry records everything required for them (per-surface IDs + copied-file ownership).
