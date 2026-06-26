# GJC Plugin Bundles

GJC supports two distinct plugin families. Do not confuse them:

1. **Legacy marketplace / npm plugins** (`packages/coding-agent/src/extensibility/plugins`) — installed through the existing `gjc plugin install <marketplace-ref|npm-spec>` marketplace/npm flows. Unchanged by this system.
2. **GJC plugin bundles** — directories whose root contains a **`gajae-plugin.json`** manifest (`kind: "gajae-code-plugin"`). These *extend* existing GJC capabilities and are the subject of this document.

A GJC plugin bundle may only **extend** existing skills/agents — it can never register a new top-level skill, slash-command, command, or agent. GJC exposes exactly four default workflow skills (`deep-interview`, `ralplan`, `team`, `ultragoal`) and four role agents (`executor`, `architect`, `planner`, `critic`); bundles add sub-skills/appendices/tools/hooks/MCPs to those existing parents only.

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
| `mcps` | MCP servers (`stdio`/`http`/`sse`) | Additive; server-name collisions are hard errors |
| `system_appendix` | Lower-authority text appended to the default agent system prompt | Append-only, never overrides base |
| `agent-appendix` | Lower-authority text appended to an existing role agent's prompt | Append-only per named agent |

### Forbidden / unsupported keys

- **Forbidden** (`forbidden_surface`): `skills`, `slash-commands`, `commands`, `agents` — bundles may not register new top-level definitions.
- **Unsupported** (`unsupported_surface`): `mcp`, `mcpServers` (use the canonical `mcps`), and any unknown top-level key.

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
- **MCP policy** (install + runtime connect): HTTPS-only for `http`/`sse`; private/loopback/link-local/unique-local/multicast and the `169.254.169.254` metadata endpoint are denied across IPv4, IPv6, IPv4-mapped/compatible, zone-id and trailing-dot forms; URL credentials and CRLF headers are rejected; DNS is re-resolved before connect (rebinding defence). `stdio` servers are confined to the plugin root (allowed launchers `node`/`bun` or a root-confined executable; required bundled script argument; no eval/loader flags; no env expansion).
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
- Full enable/disable/uninstall/upgrade UX is a planned follow-up; the registry already records everything required for it (per-surface IDs + copied-file ownership).
