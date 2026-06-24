# codegraph

> Query the project's local code knowledge graph (symbols, callers, callees, impact) via the `codegraph` CLI.

## Source
- Entry: `packages/coding-agent/src/tools/codegraph.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph.md`
- Key collaborators:
  - `@gajae-code/utils` `ptree.exec` — spawns the `codegraph` binary with abort/timeout handling.
  - `@gajae-code/utils` `$which` — gates registration on the CLI being installed.

## Prerequisites
The tool wraps [CodeGraph](https://github.com/colbymchenry/codegraph), a local-first
code knowledge graph for AI agents. To use it:

1. Install the CLI: `npm i -g @colbymchenry/codegraph` (or the install script from the
   CodeGraph README). The tool reads whatever `codegraph` is on `PATH`.
2. Index a project: run `codegraph init` in the project root once. CodeGraph keeps the
   index in sync automatically as files change.

The tool registers only when both conditions hold — the `codegraph` binary is on `PATH`
and the working directory contains a `.codegraph/` index. It is read-only; indexing,
syncing, and uninstalling stay in the CLI.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"explore" \| "search" \| "callers" \| "callees" \| "impact" \| "status"` | Yes | The graph query to run. |
| `target` | `string` | For all ops except `status` | Natural-language query (`explore`), symbol name (`callers`/`callees`/`impact`), or full-text query (`search`). |
| `limit` | `number` (1–100) | No | Max `search` results (default 10). |
| `maxFiles` | `number` (1–100) | No | For `explore`: cap the number of files whose source is included. |

### Operations
- `explore` — surgical context for a natural-language query: relevant symbols' verbatim source plus call paths and blast radius in one call (the same output as CodeGraph's flagship `codegraph_explore` MCP tool). Preferred for "how does X work" questions.
- `search` — full-text symbol search. Returns matching symbols with kind, signature, and `file:line`.
- `callers` — functions/methods that call `target`, including dynamic-dispatch edges `grep` cannot follow.
- `callees` — functions/methods that `target` calls.
- `impact` — blast radius of changing `target`: transitively affected symbols and files plus node/edge counts.
- `status` — index health: file/node/edge counts, languages, and any pending sync.

## Outputs
- One text content block. `search`/`callers`/`callees`/`impact`/`status` render a compact summary of the CLI's `--json` output; `explore` passes through the CLI's ready-to-use markdown report.
- No `details` payload; the tool is a thin read-only projection of the graph.

## Flow
1. `CodegraphTool.createIf()` returns `null` unless `codegraph.enabled` is set (default `true`),
   the `codegraph` binary resolves on `PATH`, and `<cwd>/.codegraph/` exists.
2. `execute()` builds the CLI argv with `buildCodegraphArgs()` — `query` for `search`, `explore` for
   `explore` (variadic query, no `--json`), the op name for `callers`/`callees`/`impact`, and the
   project path (`--path`, or positional for `status`).
3. It spawns `codegraph <args>` via `ptree.exec` with a 60s timeout and the session cwd.
4. On non-zero exit it raises a `ToolError`; an "index not initialized" stderr maps to guidance to run `codegraph init`.
5. On success it renders per-op text (JSON-parsed for query ops; passthrough for `explore`).

## Settings
- `codegraph.enabled` (boolean, default `true`) — disable to hide the tool even when the CLI and index are present.

## Notes
- CodeGraph data never leaves the machine; it is a local SQLite index.
- Fall back to `read`/`search` for non-structural text searches, when a symbol is reported missing,
  or when `status` reports files pending sync.
