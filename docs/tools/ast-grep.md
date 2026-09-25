# ast_grep

> Structural code search over supported source files via native ast-grep.

## Source
- Entry: `packages/coding-agent/src/tools/ast-grep.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast-grep.md`
- Key collaborators:
  - `crates/pi-natives/src/ast.rs` — native scan, parse, match engine
  - `crates/pi-ast/src/language/mod.rs` — language aliases and extension inference
  - `packages/coding-agent/src/tools/path-utils.ts` — path/glob parsing and multi-path resolution
  - `packages/coding-agent/src/tools/render-utils.ts` — parse-error dedupe and display caps
  - `packages/coding-agent/src/tools/match-line-format.ts` — anchor-prefixed match rendering
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline vs line-number output mode
  - `packages/natives/native/index.d.ts` — JS-visible native binding contract

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pat` | `string` | Yes | Single AST pattern. The wrapper trims it and rejects empty strings. |
| `paths` | `string[]` | Yes | One or more files, directories, globs, or internal URLs with backing files. Empty entries are rejected. Globs are forbidden for internal URLs. |
| `skip` | `number` | No | Match offset. Defaults to `0`, then `Math.floor(...)`; negatives and non-finite values fail. |

Pattern grammar and language support exposed to the model:
- `$NAME` — capture one AST node.
- `$_` — match one AST node without binding.
- `$$$NAME` — capture zero or more AST nodes; ast-grep stops lazily at the next satisfiable node.
- `$$$` — match zero or more AST nodes without binding.
- Metavariable names must be uppercase and must stand for whole AST nodes, not partial tokens or string fragments.
- Reusing the same metavariable requires identical code at each occurrence.
- Patterns must parse as one valid AST node for the inferred target language.
- Supported canonical languages come from `SupportLang::all_langs()` in `crates/pi-ast/src/language/mod.rs`: `astro`, `bash`, `c`, `cmake`, `cpp`, `csharp`, `dart`, `clojure`, `css`, `diff`, `dockerfile`, `elixir`, `erlang`, `go`, `graphql`, `haskell`, `hcl`, `html`, `ini`, `java`, `javascript`, `json`, `just`, `julia`, `kotlin`, `lua`, `make`, `markdown`, `nix`, `objc`, `ocaml`, `odin`, `perl`, `php`, `powershell`, `protobuf`, `python`, `r`, `regex`, `ruby`, `rust`, `scala`, `solidity`, `sql`, `starlark`, `svelte`, `swift`, `toml`, `tlaplus`, `tsx`, `typescript`, `verilog`, `vue`, `xml`, `yaml`, `zig`.

## Outputs
- Single-shot tool result.
- Model-facing `content` is one text block:
  - grouped by file for directory/multi-file searches,
  - match lines rendered as `*LINE+HASH|text` in hashline mode or `*LINE|text` otherwise,
  - continuation lines for multi-line matches rendered with a leading space,
  - optional `meta: NAME=value` lines when ast-grep captured metavariables.
- If no matches are found, text is `No matches found` or `No matches found. Parse issues mean the query may be mis-scoped; narrow paths before concluding absence.` plus formatted parse issues.
- If the wrapper truncates visible results, the text ends with `Result limit reached; narrow paths or increase limit.`
- `details` includes counts and metadata, not full match payloads:
  - `matchCount`, `fileCount`, `filesSearched`, `limitReached`
  - optional `parseErrors`, `scopePath`, `files`, `fileMatches`, `displayContent`, `meta`
- Native ranges (`byteStart`, `byteEnd`, `startLine`, `startColumn`, `endLine`, `endColumn`) exist only inside the native result; the wrapper does not emit them directly to the model.

## Flow
1. `AstGrepTool.execute()` validates `pat`, normalizes `skip`, and normalizes each `paths` entry in `packages/coding-agent/src/tools/ast-grep.ts`.
2. Internal URLs are resolved through `session.internalRouter`; entries without `sourcePath` fail, and internal-URL globs fail early.
3. For multiple path inputs, `partitionExistingPaths()` drops missing bases only when at least one surviving base remains; if all bases are missing the call fails.
4. `parseSearchPath()` splits a single path into `basePath` plus optional `glob`. `resolveExplicitSearchPaths()` collapses multiple inputs into a common base plus a brace-union glob, or separate `targets` when the only common base is a filesystem root.
5. The wrapper stats the resolved base path to decide whether output should be grouped as a directory result.
6. Execution dispatches to either:
   - one native `astGrep(...)` call for a single resolved base, or
   - `runMultiTargetAstGrep(...)`, which calls the native binding once per target, rebases paths back to the common root, sorts globally, then applies `skip` and the wrapper limit.
7. Native `ast_grep` in `crates/pi-natives/src/ast.rs`:
   - normalizes and deduplicates patterns,
   - resolves a `MatchStrictness` (`smart` by default),
   - collects candidate files from a file or gitignore-aware directory scan,
   - infers language per candidate from extension unless `lang` was provided,
   - compiles the pattern separately for each language present,
   - reads each file, reports syntax-error trees as parse issues, runs `find_all`, and optionally captures metavariable bindings.
8. Native results are sorted by path and source position, then paged by `offset`/`limit`.
9. The TS wrapper normalizes parse-error strings, deduplicates them, groups matches by formatted path, renders anchor lines, appends limit/parse notices, and returns `toolResult(...).text(...).done()`.

## Modes / Variants
- Single file: native path is the file; output is a flat list of rendered match lines.
- Directory + optional glob: native scan walks the directory, then filters by compiled glob.
- Multiple explicit paths/globs: wrapper unions them into one synthetic scope or runs per-target native calls when paths only meet at root.
- Internal URL inputs: only supported when the router can resolve them to a backing file path.
- Hashline output mode vs plain line-number mode: controlled by `resolveFileDisplayMode()`; hashline mode requires the edit tool and non-raw, mutable sources.

## Side Effects
- Filesystem
  - Stats input paths in the TS wrapper.
  - Native code reads matched files and scans directories through `fs_cache`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - None beyond normal tool transcript/result metadata.
- Background work / cancellation
  - Native work runs on a blocking worker via `task::blocking(...)`.
  - Cancellation and optional native timeout are cooperative through `CancelToken::heartbeat()`.

## Limits & Caps
- Wrapper-visible result cap: `DEFAULT_AST_LIMIT = 50` in `packages/coding-agent/src/tools/ast-grep.ts`.
  - Single-target calls rely on the native default limit of 50 in `crates/pi-natives/src/ast.rs`.
  - Multi-target calls fetch `skip + 50 + 1` matches per target, then re-page after global sort.
- Native `limit` is clamped to at least `1`; omitted `offset` defaults to `0` in `crates/pi-natives/src/ast.rs`.
- Parse issues are rendered with at most `PARSE_ERRORS_LIMIT = 20` lines in `packages/coding-agent/src/tools/render-utils.ts`; `details.parseErrors` itself is only deduplicated, not capped.
- Directory scans use `include_hidden: true`, `use_gitignore: true`, and skip `node_modules` unless the glob text explicitly mentions `node_modules` in `crates/pi-natives/src/ast.rs`.
- No hard file-count cap is applied by the wrapper or native `ast_grep`; candidate count is whatever the resolved path/glob expands to after gitignore filtering.
- Multi-path union deduplicates identical path inputs before resolution in `resolveExplicitSearchPaths()`.

## Errors
- TS wrapper throws `ToolError` for empty patterns, invalid `skip`, empty path entries, unsupported internal-URL globs, internal URLs without `sourcePath`, and missing paths.
- Native code returns hard errors for:
  - unsupported explicit `lang`,
  - inability to infer language for a candidate when `lang` is not supplied,
  - invalid AST pattern compilation for every relevant language,
  - unreadable search roots or bad glob compilation,
  - cancellation (`Aborted: Signal`) or timeout (`Aborted: Timeout`).
- File-level parse failures and many per-language pattern compile failures are non-fatal: they are accumulated in `parseErrors` and surfaced alongside successful matches.
- `no matches` is not an error, even when parse issues were recorded.

## Notes
- `pat` is always wrapped into a one-element `patterns` array by the TS tool; the model cannot send multiple patterns through `ast_grep` even though the native binding supports it.
- `ast_grep` can search mixed-language trees because native compilation happens per discovered language, but the prompt still tells the model to keep calls single-language when possible to reduce parse noise.
- Pattern compilation is per language present in the candidate set. One pattern can succeed for some languages and generate per-file parse errors for others in the same run.
- A file with tree-sitter error nodes still gets searched; the syntax warning is additive, not a skip condition.
- For glob semantics, `*.ts` matches only direct children while `**/*.ts` recurses; this is covered by native tests in `crates/pi-natives/src/ast.rs`.
- Output anchors are intended for follow-up tools, but the exact anchor format depends on session edit mode (`hashline` vs line-number mode).