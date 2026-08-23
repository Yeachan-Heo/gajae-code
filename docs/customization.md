# Customization authority, import, and trust

This is the cross-surface contract for local MCP servers, skills, and hooks. It
explains how GJC relates to Claude Code and OpenAI Codex layouts without making
the per-surface references repeat one another.

## The authority boundary

GJC has two canonical persistence scopes:

- **Project:** `<project>/.gjc/` (the repository's project root, or the opened
  project directory when there is no repository root).
- **User:** the agent directory printed by `gjc config path` (`~/.gjc/agent/` by
  default; `--agent-dir` / `GJC_CODING_AGENT_DIR` move it). The configured
  home-relative GJC config root and its legacy skill roots are described in
  [Skills](./skills.md).

These `.gjc` scopes are the long-term GJC authority. A normal standalone session
loads native project/user configuration from them, applies the native
precedence rules below, and reports provenance from those files. A file under a
Claude Code or Codex convention directory is not silently copied, overlaid, or
used to invent another GJC configuration scope.

Claude Code and Codex are **explicit import sources** for the `/extensions`
transaction. Selecting a product and source scope reads only that bounded
source, normalizes the selected surfaces, and writes the accepted result into
the chosen `.gjc` destination. Import does not edit the source files. MCP and
skill files from those hosts are never implicit standalone-session authorities.

Hooks follow the same authority boundary: ordinary sessions adapt canonical
native `.gjc/hooks/` modules to `ExtensionRunner`. Claude/Codex directory hook
providers remain available for explicit import and diagnostics, but their
foreign files are not imported or executed directly at startup. Codex still
owns managed `hooks.json` command scheduling. The accepted event and phase
rules are in [Hooks](./hooks.md); importing a hook creates the canonical
`.gjc/hooks/` copy and its provenance boundary.

## One cross-surface map

The table uses **project** and **user** to mean the selected source scope and
selected destination scope. A user source is never scanned merely because the
operator's home contains a foreign directory; choose it explicitly in the
wizard (or use an explicit non-interactive command).

| Surface | Native GJC project | Native GJC user | Claude Code project source | Claude Code user source | Codex project source | Codex user source | GJC treatment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **MCP** | `<project>/.gjc/mcp.json` | `<agentDir>/mcp.json` (`~/.gjc/agent/mcp.json` by default) | `<project>/.mcp.json` for the #4492 import transaction; the doctor also reports `.claude/mcp.json` and `.claude/.mcp.json` convention candidates | `~/.claude.json` for the import transaction | `<project>/.codex/config.toml`, `[mcp_servers.<name>]` | `~/.codex/config.toml`, `[mcp_servers.<name>]` | Only native `.gjc` MCPs autoload in ordinary standalone sessions. Import adapters normalize bounded JSON/TOML entries, validate them, and write native `mcp.json`. |
| **Skill** | `<project>/.gjc/skills/<name>/SKILL.md` | `<agentDir>/skills/<name>/SKILL.md` (see `gjc config path`) | `<project>/.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` | `<project>/.codex/skills/<name>/SKILL.md` | `~/.codex/skills/<name>/SKILL.md` | Native `.gjc` skills are loaded by GJC. Claude/Codex skills are import candidates; they are not loaded directly into a GJC session. |
| **Hook** | `<project>/.gjc/hooks/pre|post/<file>` | `<agentDir>/hooks/pre|post/<file>` (`~/.gjc/agent/hooks/pre|post/<file>` by default) | `<project>/.claude/hooks/pre|post/<file>` | `~/.claude/hooks/pre|post/<file>` when explicitly selected for import | `<project>/.codex/hooks/pre-<tool>.ts` / `post-<tool>.ts` | `~/.codex/hooks/pre-<tool>.ts` / `post-<tool>.ts` when explicitly selected for import | Ordinary sessions execute only canonical native `.gjc` directory hooks. Claude/Codex layouts are explicit import and diagnostic sources; accepted imports are normalized to canonical `pre`/`post` phases. Codex-managed `hooks.json` remains Codex-owned. |

The Claude MCP paths above are intentionally explicit: the `/extensions`
import implementation reads the project `.mcp.json` and user `~/.claude.json`
forms. Host-specific files surfaced by `gjc customize doctor` remain
provenance diagnostics unless an import adapter accepts them. See
[Standalone MCP configuration](./standalone-mcp.md) for the native startup
boundary and the host-specific compatibility notes.

## Scope and precedence

### Choosing a scope

`/extensions` keeps the destination scope separate from the source scope:

1. Open the project or global `.gjc` dashboard scope.
2. Choose Claude Code or Codex as the source product.
3. Choose **project-local** or **user-global** source scope.
4. Choose Skills, Hooks, MCPs, or all three.
5. Choose a collision policy, review the normalized preview, and confirm.

A project import writes beneath `<project>/.gjc/`; a user import writes beneath
the agent directory (`gjc config path`; `~/.gjc/agent/` by default). A project
source does not become user configuration, and a
user source does not write into the project unless the destination was selected
as project. The source is read only during preview/apply and is never mutated.

For non-interactive MCP/skill-only migration, `gjc migrate --from
claude-code|codex` supports the user destination by default, `--project` for a
project destination, `--dry-run` for a plan, and `--force` for its explicit
update behavior. It is not a replacement for the all-surface `/extensions`
preview. Direct native MCP registration uses `gjc mcp add`; see the linked MCP
reference.

### Effective runtime precedence

Import collision policy and runtime precedence are different decisions:

- **Skills:** project `.gjc/skills` wins over user scope. Within project scope,
  ancestor directories are considered from the closest directory to `cwd`
  outward. Within user scope, the canonical agent root precedes the configured
  legacy root and historical `~/.gjc/skills` root. Duplicate names are
  diagnosed. The four bundled workflow names (`deep-interview`, `ralplan`,
  `team`, and `ultragoal`) are protected; a disk copy cannot replace the
  bundled definition.
- **Hooks:** native project hooks win over the same native user hook. The
  capability registry gives the native GJC provider precedence over the Claude
  and Codex directory providers; `normalizeDirectoryHook` preserves the
  convention's phase and rejects unsupported convention/event combinations.
  A `pre` hook remains pre-tool authority and a `post` hook cannot acquire
  blocking authority. See [Hooks](./hooks.md) for event, timeout, and runtime
  ownership details.
- **MCP:** a native project server wins over a native user server with the same
  name. `disabledServers` from either native scope disables that name, and
  plugin-bundle MCPs have their separately documented collision authority; see
  [GJC plugin bundles](./gjc-plugins.md). Claude/Codex MCP files do not enter
  this precedence chain until an explicit import writes a native entry.

A **shadowed** entry remains useful evidence: it identifies the losing source
and the winner rather than silently deleting the loser. `gjc customize doctor`
and the `/extensions` inventory expose provenance, scope, effective status, and
shadowing separately.

## Trust and policy gates

Customization is executable or capability-bearing configuration. Treat every
source as untrusted until the applicable policy is satisfied.

### Skills

Filesystem skill discovery is enabled by default, but each scope has an
explicit policy gate:

- `skills.enabled` disables all filesystem skill discovery.
- `skills.trustProjectSkills` controls project `.gjc/skills`.
- `skills.trustUserSkills` controls user `.gjc` and legacy user roots.
- `skills.ignoredSkills`, `skills.includeSkills`, and `disabledExtensions`
  filter individual names.
- `skills.enablePiProject` and `skills.enablePiUser` are deprecated aliases
  retained for configured legacy settings.

The four bundled workflow skills are unaffected by these switches. A skill
must have a valid leading YAML frontmatter block with a non-empty
`description`; invalid or protected names are diagnosed rather than silently
replacing a bundled definition. See [Skills](./skills.md) for the complete
location and diagnostic contract.

### Hooks

Directory hooks are imported modules, not shell commands merely because a host
uses a hook directory. They execute as code in the GJC process and the normal
in-process hook API includes capabilities such as `exec`, message APIs,
renderers, and command registration. The current directory-hook loader does
not add a separate workspace-trust prompt, so `not-enforced` is the accurate
trust state: review and trust the source before loading it. Normalization
rejects unknown events, invalid phases, unsafe tool matchers, and semantic
mismatches. Distributable plugin hooks have a narrower API, but that API is not
an operating-system sandbox; see [GJC plugin bundles](./gjc-plugins.md).

Codex's managed `hooks.json` is a different authority. `gjc setup hooks` writes
managed `UserPromptSubmit` and `Stop` entries that invoke
`gjc codex-native-hook`; Codex owns their scheduling, timeout, cancellation,
environment, and command logging. GJC does not claim Claude named settings-hook
execution that its directory adapter does not support.

### MCP

A native MCP server is startup-eligible only when it is not `enabled: false`,
not listed in either scope's `disabledServers`, and not `autoload: false`.
Project MCP loading is on by default and is disabled for an environment only by
an explicit `mcp.enableProjectConfig: false`. `--no-mcp` opts one standalone
session out of conventional native autoload; an exact-file `--mcp-config` is a
separate top-level opt-in that replaces conventional autoload.

Foreign MCP JSON/TOML is normalized through bounded compatibility adapters and
then validated against the native MCP contract before it can be written. A
nested `auth`/`oauth` shape that cannot be represented by the canonical import
contract is rejected instead of being silently dropped. Malformed definitions
are skipped with warnings; no partial definition is connected. Remote MCP
network and credential boundaries remain those in [Standalone MCP
configuration](./standalone-mcp.md).

## Preview, confirmation, and destructive boundaries

The `/extensions` import wizard is deliberately a transaction:

1. **Preview is read-only.** It scans only the selected product/scope and
   surfaces, normalizes entries, computes destination names, and builds a
   serialization-safe preview. Building a preview does not create `.gjc`
   files.
2. **Confirmation is explicit.** Enter applies the currently reviewed plan;
   Escape cancels with no writes. The wizard pages the preview so every entry
   can be reviewed before confirmation.
3. **Collisions are explicit.** `skip` keeps the existing destination and marks
   the source as a conflict; `rename` writes a new `<name>-imported` (then
   `-imported-2`, and so on) destination; `overwrite` replaces an existing
   destination only because that policy was selected. Identical content is an
   idempotent no-op, not an overwrite.
4. **Apply is fail-closed.** Destination names are path-segment validated,
   containment-checked, and rechecked for symlinked ancestors and stale
   collisions. Skill and hook files use same-directory temporary files and
   atomic rename; MCP entries use the canonical atomic config writer.
5. **Verification and rollback are part of apply.** Persisted files are read
   back before success is reported. A write, verification, or policy failure
   restores exactly what this transaction wrote; pre-existing symlinks and
   unrelated files are never treated as rollback targets.

No import policy edits the foreign source. Dashboard removal targets the exact
native path and refuses symlinked files/directories. Hook enable/disable is not
invented by the customization manager because it is not part of the canonical
hook contract; unsupported mutation requests receive a diagnostic.

## Redaction and safe inspection

The preview and inspection surfaces are intentionally not raw configuration
dumps:

- The preview DTO contains source/destination names, surface, status, and
  redacted reasons/descriptions. The opaque apply plan carries file contents and
  MCP values separately and is not rendered or serialized as the preview.
- MCP commands, arguments, endpoints, environment values, and header values
  are not printed as credentials. Previews identify environment/header keys
  without their values; command and endpoint descriptions are redacted.
- Unsupported nested auth/oauth is reported by reason and skipped rather than
  copied into a lossy destination.
- `gjc customize doctor --json` is read-only and never emits credentials,
  endpoint tokens, auth headers, environment values, or unsafe raw config.
  `gjc mcp list` and the dashboard use the same redacted-display posture.

Do not paste secrets into shell history, prompts, screenshots, issue comments,
or PR descriptions merely because a configuration is being migrated.

## Diagnostics and remediation

The inventory and doctor intentionally distinguish absence from policy and
precedence outcomes:

| Status or diagnostic | Meaning | Typical next step |
| --- | --- | --- |
| `enabled` / `loaded` | Native entry is accepted by policy and is the effective winner. | Start a new session or use the documented runtime reload boundary. |
| `imported` | A native skill retains an import provenance marker. | Treat `.gjc` as the authority; inspect the source only for comparison. |
| `disabled` | A trust switch, master switch, `disabledExtensions`, `enabled: false`, or `disabledServers` prevents use. | Change the relevant policy intentionally, then reload. |
| `shadowed` | A higher-precedence project/ancestor/provider entry wins the same identity. | Inspect the winner and remove or rename the losing copy if it is no longer needed. |
| `invalid` / `rejected` / `unsupported` | Frontmatter, path, event, source format, or MCP semantics failed validation. | Fix the source or use the remediation reason; rejected content is not partially imported. |
| `conflict` | The selected destination exists under the chosen import policy. | Choose skip, rename, or explicit overwrite and review the new preview. |
| `quarantined` | A plugin surface failed its integrity or security policy. | Follow the plugin quarantine detail; do not bypass it by copying foreign files into `.gjc`. |
| `stored-only` / `restart-required` | The record is present but not active in this process, or a new session is required. | Restart/reload as the doctor or dashboard directs. |

Use the single read-only troubleshooting surface when behavior is unclear:

```sh
gjc customize doctor
gjc customize doctor --json
```

It reports convention, scope, precedence, shadowing, policy, bounded reason
codes, remediation, and restart requirements without executing hooks or
connecting MCP servers. An import candidate in the report is evidence that a
foreign file exists; it is not evidence that GJC loaded it.

## Detailed references

- [Skills](./skills.md) — native locations, trust settings, precedence, and
  discovery diagnostics.
- [Hooks](./hooks.md) — canonical event normalization, directory layouts,
  Codex-managed hooks, plugin hook boundaries, and runtime contracts.
- [Standalone MCP configuration](./standalone-mcp.md) — native autoload,
  disabled servers, exact-file mode, redaction, and network boundaries.
- [GJC plugin bundles](./gjc-plugins.md) — loose `.gjc` customization versus
  versioned bundles, collision ownership, quarantine, and constrained hooks.
- [README `/extensions` overview](../README.md#local-customization-extensions) —
  the user-facing entry point and non-interactive command pointers.

The interactive manager and import transaction described here landed in
[#4492](https://github.com/Yeachan-Heo/gajae-code/pull/4492), resolving the
umbrella customization behavior tracked by [#4291](https://github.com/Yeachan-Heo/gajae-code/issues/4291).
