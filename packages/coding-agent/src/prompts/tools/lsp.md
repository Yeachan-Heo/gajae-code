Interacts with Language Server Protocol servers for code intelligence.

<operations>
- `diagnostics`: Get errors/warnings for a file, a glob of files, or the entire workspace (`file: "*"`)
- `definition`: Go to symbol definition → file path + position + 3-line source context
- `type_definition`: Go to symbol type definition → file path + position + 3-line source context
- `implementation`: Find concrete implementations → file path + position + 3-line source context
- `references`: Find references → locations with 3-line source context (first 50), remaining location-only
- `hover`: Get type info and documentation → type signature + docs
- `symbols`: List symbols in a file, or search workspace with `file: "*"` and a `query`
- `rename`: Rename symbol across codebase → preview or apply edits
- `rename_file`: Rename or move a file/directory; sends `workspace/willRenameFiles` so LSP servers update import paths and other references → preview or apply edits + filesystem rename
- `code_actions`: List available quick-fixes/refactors/import actions; apply one when `apply: true` and `query` matches title or index
- `status`: Show active language servers
- `capabilities`: Dump per-server capabilities (standard + experimental + executeCommand list) for discovery — file scopes to one server, omitted/`"*"` lists every active server
- `request`: Send a raw LSP request to a server — `query` is the method name (e.g., `rust-analyzer/expandMacro`, `typescript/goToSourceDefinition`, `workspace/executeCommand`); use `payload` for arbitrary JSON params or let the tool auto-build them from `file`/`line`/`symbol`
- `reload`: Restart a specific server (via `file`) or all servers with `file: "*"`
</operations>

<parameters>
- `file`: File path, glob pattern (e.g. `src/**/*.ts`), or `"*"` for workspace scope. Globs are expanded locally before dispatch. `"*"` routes `diagnostics`/`symbols`/`reload` to their workspace-wide form.
- `line`: 1-indexed line number for position-based actions
- `symbol`: Substring on the target line used to resolve column automatically. Append `#N` to pick the Nth occurrence on that line (1-indexed; default 1) — e.g. `foo#2` selects the second `foo`.
- `query`: Symbol search query, code-action kind filter / selector (list/apply mode), or LSP method name when `action: request`
- `new_name`: Required for `rename` (new symbol identifier) and `rename_file` (destination path)
- `apply`: Apply edits for rename/rename_file/code_actions (default true for rename and rename_file; list mode for code_actions unless explicitly true)
- `payload`: JSON-encoded params for `action: request`. Overrides the auto-built `{ textDocument, position }` shape when present.
- `timeout`: Request timeout in seconds (clamped to 5-60, default 20)
</parameters>

<caution>
- Requires running LSP server for target language
- Some operations require file to be saved to disk
- Glob expansion samples up to 20 files per request; use `file: "*"` for broader coverage
- When `symbol` is provided for position-based actions, missing symbols or out-of-bounds `#N` occurrence selectors return an explicit error instead of silently falling back
</caution>

<critical>
- You MUST use `lsp` for symbol-aware operations (rename, find references, go to definition/implementation, code actions) whenever a language server is available — it is safer and more accurate than text-based alternatives.
- You NEVER perform cross-file renames with `ast_edit`, `sed`, or manual edits when `lsp` `rename` can do it. Text-based renames miss shadowing, re-exports, and usages in other files.
- Prefer `lsp` `code_actions` for imports, quick-fixes, and refactors the language server already knows how to apply.
</critical>
