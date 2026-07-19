# Autonomous Memory

When enabled, the agent automatically extracts durable knowledge from past sessions and injects a compact summary into each new session. Over time it builds a project-scoped memory store — technical decisions, recurring workflows, pitfalls — that carries forward without manual effort.

Disabled by default. Enable via `/settings` or `config.yml`:

```yaml
memories:
  enabled: true
```

## Usage

### What gets injected

At session start, if a memory summary exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The agent is instructed to:

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Pair memory-influenced decisions with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Memory artifacts

Generated local-memory artifacts are private runtime state, not a public tool or URI surface. They may be summarized into the system prompt when local memory is enabled, but users and model-facing tool docs should not rely on direct `memory://` reads. The legacy internal `memory://` resolver remains only for compatibility with existing persisted guidance and is not part of the public coding harness contract; remove it after legacy local-memory prompts no longer reference it.
### `/memory` slash command

| Subcommand            | Effect                                         |
| --------------------- | ---------------------------------------------- |
| `view`                | Show the current memory injection payload      |
| `clear` / `reset`     | Delete all memory data and generated artifacts |
| `enqueue` / `rebuild` | Force consolidation to run at next startup     |

## How it works

Memories are built by a background pipeline that runs at startup or when manually triggered via slash command.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, or currently active are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

Phase 2 uses a lease to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

All output is scanned for secrets before being written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                  | Purpose                                     | Variables                                   |
| --------------------- | ------------------------------------------- | ------------------------------------------- |
| `stage_one_system.md` | System prompt for per-session extraction    | —                                           |
| `stage_one_input.md`  | User-turn template wrapping session content | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation.md`    | Prompt for cross-session consolidation      | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read_path.md`        | Memory guidance injected into live sessions | `{{memory_summary}}`                        |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                               |
| ------------------------------------- | ------- | --------------------------------------------------------- |
| `memories.enabled`                    | `false` | Master switch                                             |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped       |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Max tokens of the summary injected into the system prompt |

Additional tuning knobs (concurrency, lease durations, token budgets) are available in config for advanced use.

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, slash command handling
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — legacy non-public `memory://` compatibility handler

## Filesystem + MAP memory (opt-in CLI)

`gjc memory` is an independent filesystem/MAP capability. It is **off until you run `gjc memory init`**; it is not a `memory.backend` value and does not start, select, replace, or otherwise alter the legacy autonomous local-memory or Hindsight backends. It never automatically captures transcripts or tool output, injects prompts, synthesizes model memory, syncs to a service, builds embeddings, or exposes a generic model-facing memory tool. It only reads or writes when its explicit CLI commands are invoked.

### Commands

All ten commands accept `--format text` (default), `--format json`, or `--format jsonl`:

```sh
# Create only the requested roots; omitting --scope creates all four.
gjc memory init --scope global,project

# Inspect resolved roots and availability.
gjc memory scopes --format json

# Resolve a route in a MAP document.
gjc memory resolve project:///memory.yaml engineering.runbook

# Read one logical Markdown document.
gjc memory get project:///MEMORY.md --format json

# Bounded deterministic retrieval across available roots.
gjc memory search "release checklist" --limit 10
# `recall` currently has the same retrieval semantics as `search`.
gjc memory recall "release checklist" --format json

# Persist one checkpoint object, then recover the newest matching task checkpoint.
gjc memory checkpoint --input '{"taskId":"release","sessionId":"s20260719","content":"Tests passed."}'
gjc memory resume release --format json

# Read-only validation and the protocol capability receipt.
gjc memory doctor
gjc memory capabilities --format json
```

`init` accepts a comma-separated `--scope` list of `global`, `project`, `project-local`, and `session`. `get` requires a URI; `resolve` requires `MAP_URI ROUTE`; `search` and `recall` require a query; `resume` requires `TASK_ID`. `checkpoint` takes an object supplied with `--input` or stdin: `{ "taskId": string, "sessionId": string, "content": string }`. Its optional `--expected-digest` (or JSONL record field) is a compare-and-swap digest for replacement.

For single-command JSON, stdout is one `{code:"ok",value:...}` success object or `{code,message}` error object. JSONL checkpoint input processes each nonblank line independently and emits one JSON record per input record; invalid records do not prevent later valid records, but make the command fail overall. Text is a human-readable JSON rendering for structured values. Diagnostics do not belong on stdout. Exit status is 0 for success, 3 for not found, 4 for policy/permission denial, and 2 for other command errors.

### Scopes, identities, and logical URIs

Logical URIs are canonical, percent-encoded `scope:///path` references, never host paths. A path must contain safe non-empty components; `.`/`..`, separators, controls, and noncanonical escaping are rejected. Examples:

- `global:///MEMORY.md` — user-owned memory under the user agent data directory.
- `project:///MEMORY.md` — repository-shared memory at the **current worktree's** `.gjc/memory`, so linked worktrees do not silently use another branch's files.
- `project-local:///notes/private.md` — private data associated with an enrolled repository identity, stable across its worktrees.
- `session:///s20260719/release.checkpoint.json` — private checkpoint data for that same stable project identity.

Project-local and session scopes require a Git worktree and private enrollment. Enrollment stores a random project UUID in a private registry keyed by the canonical Git common directory; the UUID, not a repository remote, is the authority. A remote is only optional sanitized display metadata. Private roots are created owner-only where the platform supports POSIX modes; repository-shared content intentionally remains repository-owned.

### Version-1 files

Initialization creates, without overwriting existing files, an `initialization.v1.json` marker with `{version:1, initializedAt, scopes}`, a `MEMORY.md`, and a `memory.yaml` MAP in each selected root. Despite its filename, the generated MAP is JSON and is also accepted in a deliberately restricted YAML form:

```yaml
version: 1
routes:
  engineering.runbook:
    - project:///MEMORY.md
```

A MAP is exactly version `1` plus `routes`, whose normalized lowercase dotted route IDs map to one or more canonical logical URIs. `resolve` returns route targets in stable lexical order. `search` and `recall` accept `--map <MAP_URI> --route <ROUTE_ID>` to prioritize an explicit route before deterministic fallback ranking; route membership is a ranking boost, not a filter, so other lexical matches may follow routed results. Markdown frontmatter may set `status: active|archived|superseded|unverified`; retrieval excludes every non-active status by default. Frontmatter uses a deliberately flat YAML subset; inline arrays and objects must be valid JSON (for example, `tags: ["release", "runbook"]`). The version-1 private user-policy shape is `policy.v1.json` with `{version:1, allowedScopes:[...]}`. The companion repository narrowing-policy shape is `{version:1, allowedScopes?: [...]}`; its validation rule permits narrowing only, never granting a user-disabled scope. The private identity registry is `identity-registry.v1.json` with `{version:1, repositories:{...}}`. Unknown MAP versions are rejected rather than migrated automatically; `doctor` reports explicit policy or identity failures, secret-like repository-shared Markdown, and readable document/MAP safety problems, but treats intentionally uninitialized scopes as absent rather than unhealthy and never repairs or migrates files.

Checkpoints are private `session:///SESSION/TASK.checkpoint.json` documents with `{version:1, taskId, createdAt, content, expectedDigest}`. Task and session IDs are lowercase bounded identifiers. A replacement requires the current serialized-file digest, preventing blind concurrent overwrite. `resume` scans a bounded set of session directories, ignores malformed checkpoints, selects the latest `createdAt` (then session ID), and always marks recovered state `verificationRequired: true`.

### Retrieval and safety boundaries

`get`, `search`, and `recall` read Markdown only. Discovery is deterministic: scopes are visited in fixed order, entries and final URI candidates are sorted, traversal is bounded to depth 16, 256 directories, 4,096 entries, 1 MiB per document, and 32 selected results. Results rank canonical URI match, explicit MAP membership when a map route is supplied to retrieval, metadata match, heading match, lexical match, then URI. A retrieval response reports excluded files and `truncated` when a bound applies.

Each result includes a logical citation: URI, scope, matching heading and line range, SHA-256 digest, authority (`user`, `repository`, or `private`), freshness, volatility, and `verificationRequired`. Volatile frontmatter causes `verificationRequired: true`; citations intentionally do not disclose home-directory paths. Repository-scoped Markdown that appears to contain a credential-like secret is excluded.

Files are lexically contained under their selected roots. Reads reject symlinks, use no-follow descriptors where supported, require regular files, and revalidate descriptor and ancestor topology before and after reading. The implementation fails closed when it detects a topology or content change; this is detection, not a claim of absolute immunity from hostile concurrent filesystem mutation. Private writes use bounded lock attempts and same-directory temporary-file, sync, rename replacement. `doctor` is read-only.

### Migration and non-goals

Filesystem/MAP memory does not migrate legacy autonomous-memory state, create a fourth backend, modify `memory.backend`, or activate itself from configuration. It has no retrieval ledger and no `markdown` or `paths` output format. Existing legacy `memory://` compatibility behavior and the autonomous local-memory/Hindsight lifecycle remain separate from this explicit CLI protocol.
