Query the project's CodeGraph — a pre-built, local code knowledge graph of every
symbol, call edge, and dependency in the codebase (powered by the `codegraph`
CLI). Prefer this over `grep`/`read` crawling when a question is structural:
"who calls X", "what does X call", "what breaks if I change X", or "where is the
symbol named X".

This tool is read-only and only available when the project has been indexed
(`codegraph init` has created a `.codegraph/` directory). The graph auto-syncs as
files change, so results track the working tree.

## Operations (`op`)

- `explore` — **preferred for "how does X work" questions.** Give `target` a
  natural-language query (e.g. "how are requests routed"); returns the relevant
  symbols' verbatim source plus the call paths and blast radius in one shot, so
  you usually do not need to `read` those files afterward. Use `maxFiles` to cap
  how much source is included.
- `search` — full-text search for symbols by name. `target` is the search query.
  Use `limit` to cap results (default 10). Returns matching symbols with kind,
  file, and line.
- `callers` — list functions/methods that call `target` (a symbol name). Follows
  dynamic-dispatch edges that `grep` cannot.
- `callees` — list functions/methods that `target` calls.
- `impact` — blast radius of changing `target`: the transitively affected symbols
  and files. Run this before editing a widely-used symbol.
- `status` — index health: file/node/edge counts, languages, and pending syncs.
  No `target` needed.

## When to use

- Answering "how does this work" / "what is affected" questions on an unfamiliar
  or large codebase, with far fewer tool calls than file-by-file exploration.
- Locating the definition or callers of a symbol before editing it.

Fall back to `read`/`search` when the graph reports a symbol is missing, when a
file is flagged as pending sync, or for non-structural text searches.
