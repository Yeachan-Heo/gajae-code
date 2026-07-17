# Recovered context: 0-ToolPrompts

- Session file: `<local-gjc-session-jsonl-redacted>`
- JSONL records inspected: yes
- Tool calls: 184
- Recorded findings recovered from `report_finding`: 34
- Yield calls: 0
- Errors/stalls: 14

## Errors / terminal blockers

- line 189: Anthropic stream stalled while waiting for the next event
- line 190: Anthropic stream stalled while waiting for the next event
- line 197: Anthropic stream stalled while waiting for the next event
- line 198: Anthropic stream stalled while waiting for the next event
- line 210: Anthropic stream stalled while waiting for the next event
- line 229: Anthropic stream stalled while waiting for the next event
- line 235: Anthropic stream stalled while waiting for the next event
- line 246: Anthropic stream stalled while waiting for the next event
- line 291: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()
- line 315: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}

## Read paths sampled

- `packages/coding-agent/src/prompts/tools/`
- `packages/coding-agent/src/prompts/tools/read.md:raw`
- `packages/coding-agent/src/prompts/tools/bash.md:raw`
- `packages/coding-agent/src/prompts/tools/patch.md:raw`
- `packages/coding-agent/src/prompts/tools/apply-patch.md:raw`
- `packages/coding-agent/src/prompts/tools/hashline.md:raw`
- `packages/coding-agent/src/prompts/tools/replace.md:raw`
- `packages/coding-agent/src/prompts/tools/search.md:raw`
- `packages/coding-agent/src/prompts/tools/find.md:raw`
- `packages/coding-agent/src/prompts/tools/task.md:raw`
- `packages/coding-agent/src/prompts/tools/subagent.md:raw`
- `packages/coding-agent/src/prompts/tools/job.md:raw`
- `packages/coding-agent/src/prompts/tools/monitor.md:raw`
- `packages/coding-agent/src/prompts/tools/browser.md:raw`
- `packages/coding-agent/src/prompts/tools/computer.md:raw`
- `packages/coding-agent/src/prompts/tools/lsp.md:raw`
- `packages/coding-agent/src/prompts/tools/ast-edit.md:raw`
- `packages/coding-agent/src/prompts/tools/ast-grep.md:raw`
- `packages/coding-agent/src/prompts/tools/eval.md:raw`
- `packages/coding-agent/src/prompts/tools/goal.md:raw`
- `packages/coding-agent/src/prompts/tools/skill.md:raw`
- `packages/coding-agent/src/prompts/tools/resolve.md:raw`
- `packages/coding-agent/src/prompts/tools/recall.md:raw`
- `packages/coding-agent/src/prompts/tools/retain.md:raw`
- `packages/coding-agent/src/prompts/tools/reflect.md:raw`
- `packages/coding-agent/src/prompts/tools/rewind.md:raw`
- `packages/coding-agent/src/prompts/tools/checkpoint.md:raw`
- `packages/coding-agent/src/prompts/tools/cron.md:raw`
- `packages/coding-agent/src/prompts/tools/github.md:raw`
- `packages/coding-agent/src/prompts/tools/ssh.md:raw`
- `packages/coding-agent/src/prompts/tools/vim.md:raw`
- `packages/coding-agent/src/prompts/tools/web-search.md:raw`
- `packages/coding-agent/src/prompts/tools/todo-write.md:raw`
- `packages/coding-agent/src/prompts/tools/task-summary.md:raw`
- `packages/coding-agent/src/prompts/tools/irc.md:raw`
- `packages/coding-agent/src/prompts/tools/recipe.md:raw`
- `packages/coding-agent/src/prompts/tools/render-mermaid.md:raw`
- `packages/coding-agent/src/prompts/tools/image-gen.md:raw`
- `packages/coding-agent/src/prompts/tools/calculator.md:raw`
- `packages/coding-agent/src/prompts/tools/debug.md:raw`
- `packages/coding-agent/src/prompts/tools/async-result.md:raw`
- `packages/coding-agent/src/prompts/tools/search-tool-bm25.md:raw`
- `packages/coding-agent/src/prompts/tools/ask.md:raw`
- `packages/coding-agent/src/prompts/tools/write.md:raw`
- `packages/coding-agent/src/tools/job.ts`
- `packages/coding-agent/src/tools/monitor.ts`
- `packages/coding-agent/src/tools/cron.ts`
- `packages/coding-agent/src/tools/job.ts:1-120:raw`
- `packages/coding-agent/src/tools/monitor.ts:1-90:raw`
- `packages/coding-agent/src/tools/find.ts:1-120:raw`
- `packages/coding-agent/src/tools/todo-write.ts:1-100:raw`
- `packages/coding-agent/src/prompts/tools/task.md:raw`
- `packages/coding-agent/src/tools/cron.ts:120-200:raw`
- `packages/coding-agent/src/tools/todo-write.ts:225-260:raw`
- `packages/coding-agent/src/tools/ask.ts:1-110:raw`
- `packages/coding-agent/src/tools/calculator.ts:1-80:raw`
- `packages/coding-agent/src/tools/monitor.ts:94-200:raw`
- `packages/coding-agent/src/edit/index.ts:1-140:raw`
- `packages/coding-agent/src/edit/modes/replace.ts:1-100:raw`
- `packages/coding-agent/src/tools/write.ts:1-90:raw`
- `packages/coding-agent/src/tools/ssh.ts:1-80:raw`
- `packages/coding-agent/src/task/types.ts:40-120:raw`
- `packages/coding-agent/src/tools/monitor.ts:203-253:raw`
- `packages/coding-agent/src/tools/tool-timeouts.ts:raw`
- `packages/coding-agent/src/tools/browser.ts:34-70:raw`
- `packages/coding-agent/src/prompts/tools/bash.md:conflicts`
- `packages/coding-agent/src/prompts/tools/bash.md:55-80:raw`
- `packages/coding-agent/src/prompts/tools/job.md:raw`
- `packages/coding-agent/src/tools/ast-edit.ts:212-330:raw`
- `packages/coding-agent/src/prompts/tools/bash.md:60-75:raw`
- `packages/coding-agent/src/prompts/tools/patch.md:1-30`
- `packages/coding-agent/src/prompts/tools/apply-patch.md:1-40`
- `packages/coding-agent/src/prompts/tools/replace.md:1-45`
- `packages/coding-agent/src/prompts/tools/monitor.md:1-20`
- `packages/coding-agent/src/prompts/tools/monitor.md:24-31`
- `packages/coding-agent/src/prompts/tools/write.md:1-20`
- `packages/coding-agent/src/tools/ast-edit.ts:395-430:raw`
- `packages/coding-agent/src/edit/modes/replace.ts:1102-1162:raw`
- `packages/coding-agent/src/edit/index.ts:330-430:raw`

## Search patterns sampled

- `awaitReply|await_reply` in `['packages/coding-agent/src/tools/irc.ts']`
- `280|2000|12000|receipt|preview|full` in `['packages/coding-agent/src/tools/subagent.ts']`
- `cronSchema = z|op:|cron_expression|recurring|prompt:|id:` in `['packages/coding-agent/src/tools/cron.ts']`
- `case "rm"|op === "rm"|"rm"` in `['packages/coding-agent/src/tools/todo-write.ts']`
- `function removeTasks` in `['packages/coding-agent/src/tools/todo-write.ts']`
- `action|timeout_ms|pause|steer` in `['packages/coding-agent/src/tools/subagent.ts']`
- `task.md|spawnPlan|whyParallel` in `['packages/coding-agent/src']`
- `patch\.md|hashline\.md|replace\.md|apply-patch\.md|vim\.md` in `['packages/coding-agent/src']`
- `DEFAULT_LIMIT` in `['packages/coding-agent/src/tools/read.ts']`
- `replaceEditSchema|old_text|all:|new_text` in `['packages/coding-agent/src/edit/modes/replace.ts']`
- `limit|query|schema` in `['packages/coding-agent/src/tools/search-tool-bm25.ts']`
- `DEFAULT_LIMIT = ` in `['packages/coding-agent/src/tools/search-tool-bm25.ts']`
- `TASK_ID_DESCRIPTION|isValidTaskId` in `['packages/coding-agent/src/task']`
- `searchSchema = z|pattern:|paths:|skip:|gitignore:|\bi:\b` in `['packages/coding-agent/src/tools/search.ts']`
- `DEFAULT_SPAWN_THRESHOLD` in `['packages/coding-agent/src/task/spawn-gate.ts']`
- `bashSchema|async:|timeout:|pty:|env:` in `['packages/coding-agent/src/tools/bash.ts']`
- `z\.object|z\.enum|describe\(` in `['packages/coding-agent/src/goals/tools/goal-tool.ts', 'packages/coding-agent/src/tools/resolve.ts', 'packages/coding-agent/src/tools/skill.ts']`
- `z\.enum\(\[|action|verb` in `['packages/coding-agent/src/tools/browser.ts']`
- `op:|z\.enum` in `['packages/coding-agent/src/tools/gh.ts']`
- `50 \* 1024|50_000|51200|maxBytes|truncateHead` in `['packages/coding-agent/src/tools/find.ts']`
- `viewport|dialogs` in `['packages/coding-agent/src/tools/browser.ts']`
- `pause|vimSchema = |steps|kbd|insert` in `['packages/coding-agent/src/tools/vim.ts']`
- `DEFAULT_MAX_BYTES|maxBytes.*=|export function truncateHead` in `['packages/coding-agent/src/session/streaming-output.ts']`
- `"repo_view"|"run_watch"|"search_repos"|"pr_push"|"search_commits"` in `['packages/coding-agent/src/tools/gh.ts']`
- `rsed` in `['packages/coding-agent/src']`
- `z\.enum|snake|double_click|keypress|batch` in `['packages/coding-agent/src/tools/computer.ts']`
- `z\.object|timeout|reset|title|language` in `['packages/coding-agent/src/tools/eval.ts']`
- `</output>` in `['packages/coding-agent/src/prompts/tools/bash.md']`
- `hline|hrefr` in `['packages/coding-agent/src/edit/index.ts', 'packages/coding-agent/src/hashline']`
- `<output>|</output>|<critical>|</critical>|<instruction>|</instruction>` in `['packages/coding-agent/src/prompts/tools/bash.md']`
- `z\.enum\(\[|action:|payload|new_name|symbol|apply` in `['packages/coding-agent/src/lsp/lsp-tool.ts', 'packages/coding-agent/src/lsp/tool.ts', 'packages/coding-agent/src/lsp/index.ts']`
- `hline|hrefr` in `['packages/utils/src', 'packages/coding-agent/src/utils']`
- `registerHelper|"hline"|"hrefr"|hline\b` in `['packages/utils']`
- `registerHelper\("hline|registerHelper\("hrefr|hline|hrefr` in `['packages/coding-agent/src']`
- `registerHelper\("h` in `['packages/coding-agent/src/config/prompt-templates.ts']`
- `web-search\.md|webSearch|web_search` in `['packages/coding-agent/src/tools', 'packages/coding-agent/src/capability']`
- `z\.object|xai_search_mode|allowed_domains|recency|num_search_results` in `['packages/coding-agent/src/web/search']`
- `no_inline_citations|from_date|enable_image` in `['packages/coding-agent/src/web/search/index.ts']`
- `astEditSchema|ops:|pat:|out:` in `['packages/coding-agent/src/tools/ast-edit.ts']`
- `ABSOLUTE|isAbsolute|relative` in `['packages/coding-agent/src/edit/modes/apply-patch.ts']`
- `Add File|Move to|absolute|relative` in `['packages/coding-agent/src/edit/modes/apply-patch.ts', 'packages/coding-agent/src/edit/apply-patch.ts']`
- `Absolute|absolute` in `['packages/coding-agent/src/edit/modes/apply-patch.ts']`
- `preview|staged|resolve|pending` in `['packages/coding-agent/src/tools/ast-edit.ts']`
- `^</output>$` in `['packages/coding-agent/src/prompts/tools/bash.md']`
- `bash-alternatives|sed -i|cat >> file` in `['packages/coding-agent/src/prompts/tools/replace.md']`
- `Otherwise choose|Anchor Selection` in `['packages/coding-agent/src/prompts/tools/patch.md']`
- `each line starts with|shell command|NEVER ABSOLUTE` in `['packages/coding-agent/src/prompts/tools/apply-patch.md']`
- `CLAUDE_CODE_DISABLE_CRON|jitter|Every 5 minutes` in `['packages/coding-agent/src/prompts/tools/cron.md']`
- `op:|job\(\{op` in `['packages/coding-agent/src/prompts/tools/monitor.md', 'packages/coding-agent/src/prompts/tools/job.md']`
- `queueResolveHandler|pending|Preview` in `['packages/coding-agent/src/tools/resolve.ts']`
- `rsed|Replacement summary|non-paused|awaitReply|instructions>` in `['packages/coding-agent/src/prompts/tools/lsp.md', 'packages/coding-agent/src/prompts/tools/ast-edit.md', 'packages/coding-agent/src/prompts/tools/vim.md', 'packages/coding-agent/src/prompts/tools/irc.md', 'packages/coding-agent/src/prompts/tools/image-gen.md']`
- `z\.object|subject|input` in `['packages/coding-agent/src/tools/image-gen.ts']`
- `without reading|read.*before.*edit|readFirst|mustRead|requireRead` in `['packages/coding-agent/src/edit']`
- `read the file|been read|must read|read-before` in `['packages/coding-agent/src/edit', 'packages/coding-agent/src/tools']`
- `FileReadCache|readCache|hasRead|snapshot` in `['packages/coding-agent/src/edit/modes/replace.ts', 'packages/coding-agent/src/edit/file-read-cache.ts']`
- `without reading|reading file first|must be read|read it first` in `['packages/coding-agent/src']`
- `read.*first|unread|mustReadBeforeEdit|enforce.*read` in `['packages/coding-agent/src/edit/index.ts']`
- `read before|not been read|Read it first|has not read` in `['packages/coding-agent/src']`
- `issue://|pr://` in `['packages/coding-agent/src/internal-urls', 'packages/coding-agent/src/tools/github-cache.ts']`
- `recommended|0-indexed|zero` in `['packages/coding-agent/src/tools/ask.ts']`
- `CamelCase|assignment.*PROHIBITED|description.*UI label` in `['packages/coding-agent/src/prompts/tools/task.md']`
- `planner|architect|Task tool` in `['packages/coding-agent/src/prompts/tools/search.md', 'packages/coding-agent/src/prompts/tools/ast-grep.md', 'packages/coding-agent/src/prompts/tools/find.md']`
- `verbosity|receipt|list: true|op: "list"` in `['packages/coding-agent/src/prompts/tools/subagent.md']`
- `poll|timeout_ms|wait window` in `['packages/coding-agent/src/prompts/tools/job.md']`
- `without reading|must read the file|read-before-edit|hasBeenRead` in `['packages']`
- `applyPatchSchema = |z\.object` in `['packages/coding-agent/src/edit/modes/apply-patch.ts']`

## Recovered findings

### 1. P1: replace.md: <bash-alternatives> section directly contradicts bash.md/read.md/search.md coreutils bans
- Location: `packages/coding-agent/src/prompts/tools/replace.md:18-36`
- Confidence: 0.95

replace.md lines 18–36 actively recommend `cat >> file <<'EOF'`, `sed -i 'N,Md'`, `sed -i 'Na\text'`, and `sed -n 'N,Mp' src >> dest` as preferred alternatives for position-addressed edits. This directly contradicts:

- bash.md:45 `<critical>`: "NEVER use Linux coreutils (`cat`, `head`, `tail`, ... `sed`, ...) when a dedicated tool suffices"
- read.md `<critical>`: "`cat`, `head`, `tail` ... are FORBIDDEN — any such bash call is a bug" and "NEVER substitute `sed -n`, `awk NR`, or `head`/`tail` pipelines"
- search.md:17–19 `<critical>`: bans `sed`-for-search via Bash

When the `replace` edit mode is active, the model receives replace.md telling it to reach for `sed -n`/`cat` pipelines while bash.md simultaneously calls the same commands "a bug". The model gets whiplash-inducing MUST/NEVER conflicts on identical commands. Either drop `<bash-alternatives>` entirely (the modern edit modes + `write` cover all listed operations) or scope it explicitly to environments where the read/search/bash bans do not apply.

### 2. P1: job.md documents wrong invocation shape `job({op:"list"})` in monitor.md and never documents timeout — schema is `{list, poll, cancel, tail}` booleans/arrays
- Location: `packages/coding-agent/src/prompts/tools/monitor.md:26`
- Confidence: 0.95

Two related drift problems in the job/monitor pair:

1. monitor.md:26 says the monitor task entry is "visible via `job({op:\"list\"})`". The actual `jobSchema` (tools/job.ts:25–30) has **no `op` field** — it is `{ poll?: string[], cancel?: string[], list?: boolean, tail?: string[] }`. The correct call is `job({list: true})`, which job.md itself documents (`## \`list: true\``). A model following monitor.md verbatim will produce a schema-invalid call.

2. job.md:19 says `poll` blocks "until the specified jobs finish or the wait window elapses" but never says what the wait window is or how to change it. The implementation (job.ts:35–45, `WAIT_DURATION_MS`, `parseWaitDurationMs`) has a fixed internal table defaulting to 30s with no schema-exposed knob. The doc should state "~30 s, not configurable" so the model doesn't hunt for a `timeout` param that doesn't exist.

Fix: correct monitor.md's example to `job({list: true})` (or `job` with `list: true`), and state the poll window in job.md.

### 3. P2: task.md `.id` doc says "CamelCase, ≤32 chars" but schema enforces `^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$` (48 chars, not CamelCase)
- Location: `packages/coding-agent/src/prompts/tools/task.md:22`
- Confidence: 0.93

task.md:22 documents `.id` as "CamelCase, ≤32 chars". The actual validation (task/types.ts:79 → `z.string().max(48).refine(isValidTaskId)`, task/id.ts:1 `TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/`) permits up to 48 characters and allows digits, underscores, and hyphens — CamelCase is a style suggestion, not a constraint, and the length limit is wrong by 16 chars. The schema `.describe()` says "filesystem-safe task identifier". A model that legitimately needs a 40-char id will self-truncate unnecessarily; one that emits kebab-case will second-guess a valid id. Align the prompt with the real constraint (e.g. "filesystem-safe, ≤48 chars, `[A-Za-z0-9][A-Za-z0-9_-]*`; prefer CamelCase").

### 4. P2: bash.md ends with stray `</output>` closing tag with no matching opener
- Location: `packages/coding-agent/src/prompts/tools/bash.md:70-72`
- Confidence: 0.9

bash.md has a properly balanced `<output>…</output>` block at lines 51–55, but the file's final line (after the "# Output minimizer" section) is another bare `</output>` with no opening tag. Rendered output ships a dangling close tag to the model. Harmless to parsing-tolerant models but it's a template bug and inconsistent with every other prompt file. Delete the trailing `</output>` (the minimizer section reads fine as a plain `#` section, or wrap it properly).

### 5. P2: bash.md leaks internal implementation reference `clampTimeout("bash", …) in tool-timeouts.ts` into the model prompt
- Location: `packages/coding-agent/src/prompts/tools/bash.md:60`
- Confidence: 0.9

The async/timeout section says: 'Range: `1`–`3600`s; default `300`s (see `clampTimeout("bash", …)` in `tool-timeouts.ts`)'. The parenthetical is a source-code cross-reference useful to a harness developer, not the model — the model cannot (and should not) open `tool-timeouts.ts` to verify a constant, and the file path is meaningless inside arbitrary user repos (it may even induce the model to search for that file in the user's workspace). The range/default values themselves are correct per TOOL_TIMEOUTS (`bash: {default: 300, min: 1, max: 3600}`). Drop the "(see …)" clause.

### 6. P2: patch.md anchor-selection list starts with orphaned "1. Otherwise choose…" — a preceding rule was deleted
- Location: `packages/coding-agent/src/prompts/tools/patch.md:7-8`
- Confidence: 0.9

patch.md:7–8 reads:

```
**Anchor Selection:**
1. Otherwise choose highly specific anchor copied from file:
```

"Otherwise" implies a prior numbered option ("1. Prefer bare `@@` when context is unique" or similar) that was edited out, leaving the list starting at "1. Otherwise". The model has no antecedent for the conditional. Restore the missing first rule or reword to "Choose a highly specific anchor copied from the file:".

### 7. P1: apply-patch.md: truncated sentence "Within a hunk each line starts with:" followed by nothing
- Location: `packages/coding-agent/src/prompts/tools/apply-patch.md:18-20`
- Confidence: 0.95

apply-patch.md:18 ends mid-thought: "Within a hunk each line starts with:" — the expected enumeration (` ` context / `-` removal / `+` addition) is missing; the next line jumps to "For instructions on [context_before] and [context_after]:". The line-prefix rule is the single most important fact of the format and it's absent from its own sentence (it's only inferable from the grammar's `HunkLine := (" " | "-" | "+") text NEWLINE` much later). Complete the sentence with the three prefixes and their meanings.

### 8. P3: cron.md documents env var `CLAUDE_CODE_DISABLE_CRON` — brand-inconsistent for the GJC/gajae-code harness but matches implementation
- Location: `packages/coding-agent/src/prompts/tools/cron.md:27`
- Confidence: 0.85

cron.md:27 documents `CLAUDE_CODE_DISABLE_CRON=1` and the implementation agrees (cron.ts `isCronDisabled()` checks `process.env.CLAUDE_CODE_DISABLE_CRON === "1"`). So this is not doc/impl drift — but every other prompt in this tree brands the harness as "GJC"/"gajae-code" (job.md, bash.md, browser.md, recall.md, skill.md), and a `CLAUDE_CODE_*` env var in a `gjc` product is a leftover from the upstream port (the file even comments "Mirrors upstream Claude Code's 50-task cap"). Also, this operator-facing configuration knob arguably doesn't belong in the model-facing prompt at all — the model can't set env vars for the host process. Consider renaming the env var (with fallback) or at minimum dropping the line from the prompt.

### 9. P2: find.md `<avoid>` says "you MUST use Task tool" while search.md/ast-grep.md route the same situation to planner/architect role agents
- Location: `packages/coding-agent/src/prompts/tools/find.md:27-29`
- Confidence: 0.9

Three sibling tools give three different escalation targets for the identical "open-ended multi-round exploration" situation:

- find.md:28: "you MUST use Task tool instead"
- search.md:24: "delegate a bounded fact-finding task to an appropriate canonical role agent (`planner` ... or `architect` ...)"
- ast-grep.md:41: "delegate ... to an appropriate canonical role agent (`planner` or `architect`) first"

"Task tool" also names the tool inconsistently (the launcher prompt is task.md but subagent control is subagent.md; nothing else in the tree capitalizes it as "Task tool"). Pick one canonical formulation (the search.md/ast-grep.md wording is the more specific) and use it in all three files. Also note find.md's escalation lives in `<avoid>` while the siblings put it in `<critical>` — same rule, different tag semantics.

### 10. P3: image-gen.md uses `<instructions>` (plural) — every other file uses `<instruction>`
- Location: `packages/coding-agent/src/prompts/tools/image-gen.md:3-7`
- Confidence: 0.97

image-gen.md:3/7 wraps its rules in `<instructions>…</instructions>`. The established tag across the tree (read.md, bash.md, search.md, find.md, browser.md, ast-grep.md, ast-edit.md, eval.md, lsp.md via `<operations>`, replace.md, patch.md, web-search.md, ssh.md, recipe.md, github.md, ask.md, skill.md) is singular `<instruction>`. Trivial fix; matters because tag vocabulary consistency is what lets models generalize the section semantics across tools.

### 11. P2: image-gen.md omits most of the actual schema — `action`, `scene`, `composition`, `lighting`, `image_size`, `aspect_ratio` params undocumented while prompt implies single-field usage
- Location: `packages/coding-agent/src/prompts/tools/image-gen.md:1-7`
- Confidence: 0.85

image-gen.md tells the model "You MUST provide a single detailed `subject` prompt", but the actual schema (image-gen.ts:63–76) is a structured prompt builder: `subject` (required) plus `action`, `scene`, `composition`, `lighting`, `camera`(-ish), `style`, `aspect_ratio`, `image_size`, and `input[]` ({path|data, mime_type}). `assemblePrompt()` (image-gen.ts:87–97) explicitly composes "subject, action, scene. composition. lighting. …". The prompt actively steers the model away from the structured fields the implementation was designed around, and the `input` entries' `path`/`data`/`mime_type` shape is never described (only "multiple `input`" is mentioned in passing). Document the structured fields or, if single-string prompts are the intended usage, simplify the schema.

### 12. P3: lsp.md `<critical>` references `rsed` — a tool that does not exist anywhere in the codebase
- Location: `packages/coding-agent/src/prompts/tools/lsp.md:40`
- Confidence: 0.9

lsp.md:40: "You NEVER perform cross-file renames with `ast_edit`, `sed`, `rsed`, or manual edits…". There is no `rsed` tool registered in packages/coding-agent/src (searched — zero hits outside this prompt). It's likely a leftover from an earlier tool roster. Dead references in a NEVER-rule teach models to expect a tool that will never appear in their tool list. Remove `rsed` (or replace with the actual bulk-replace tool name, e.g. `sd`-via-bash or `ast_edit`, though `ast_edit` is already listed).

### 13. P1: ast-edit.md never mentions the preview→resolve flow — edits are staged, not applied, but the prompt implies direct application
- Location: `packages/coding-agent/src/prompts/tools/ast-edit.md:1-19`
- Confidence: 0.9

ast-edit.md describes the tool as "Performs structural AST-aware rewrites" and its `<output>` as "Replacement summary, per-file replacement counts, and change diffs" — implying files are modified. The implementation (ast-edit.ts:212–215 `dryRun: true`, then :323–330 `queueResolveHandler(...)`) always runs a dry-run preview and registers a **pending action that requires a separate `resolve` call with `action:"apply"`** before anything touches disk. resolve.md confirms: "Valid whenever a pending action exists — either a preview-style staging (e.g. `ast_edit`) …". A model reading only ast-edit.md will believe its rewrite landed and move on, leaving the change unapplied. Add an explicit line: "Output is a preview; call `resolve` with `action: \"apply\"` to persist, or `\"discard\"` to reject."

### 14. P2: irc.md example uses `awaitReply: false` but the parameter is never documented in <instruction>/<parameters>
- Location: `packages/coding-agent/src/prompts/tools/irc.md:47-48`
- Confidence: 0.92

irc.md:48's broadcast example passes `"awaitReply": false` with the comment "(no replies, just informs them)", but `awaitReply` is absent from the `<instruction>` block that documents `op`, `to`, and `message`. The schema does have it (irc.ts:32 `awaitReply: z.boolean().optional().describe("wait for prose reply")`, defaulting to `!isBroadcast` at irc.ts:160 — i.e. broadcasts already default to fire-and-forget, making the example's explicit `false` redundant but harmless). Document the param and its default ("defaults to true for DMs, false for `to: \"all\"` broadcasts") so the example isn't the only place it appears.

### 15. P3: irc.md etiquette tells agents "Do not `grep` artifacts" — invoking a banned command name as if it were available
- Location: `packages/coding-agent/src/prompts/tools/irc.md:30-36`
- Confidence: 0.88

irc.md etiquette bullet: "Use IRC, not terminal tools, to learn about peers. Do not `grep` artifacts, read other sessions' JSONL files, or shell-poke around…" and later "If a `read`, `grep`, or build command would resolve the question, do that first." Both references treat `grep` as a live capability, while search.md `<critical>` categorically bans `grep` ("NEVER shell out to `grep` … even for a single match"). The second quote is worse: it *recommends* `grep` as a first resort. Replace with the actual tool names (`read`, `search`).

### 16. P2: replace.md claims "Tool errors if you attempt edit without reading file first" — no such enforcement exists in executeReplaceSingle
- Location: `packages/coding-agent/src/prompts/tools/replace.md:14-16`
- Confidence: 0.8

replace.md:15: "You MUST read the file at least once in the conversation before editing. Tool errors if you attempt edit without reading file first." I could find no read-before-edit gate in the replace execution path (edit/modes/replace.ts `executeReplaceSingle` at lines 1080+ goes straight to plan-mode enforcement → read file → match/replace; no check against `FileReadCache` or any read-tracking). `FileReadCache` (edit/file-read-cache.ts) exists but is used only for hashline anchor-stale *recovery*, not as a precondition gate. The first sentence (behavioral guidance) is fine; the second sentence asserts an enforcement mechanism that doesn't exist, so the model will believe a failed-read state is impossible when it isn't. Either implement the gate or delete the "Tool errors…" sentence.

### 17. P3: patch.md `<critical>` formatter rule uses typographic em-dash in `prettier —write` — copy-pastes as a broken flag
- Location: `packages/coding-agent/src/prompts/tools/patch.md:44`
- Confidence: 0.95

patch.md's last `<critical>` bullet: "Formatting is a single command run once at the end (`bun fmt`, `cargo fmt`, `prettier —write`, etc.)". `—write` uses U+2014 EM DASH instead of `--write`. A model that copies this literally will run a failing command. Same bullet also duplicates the "never reformat via edit" rule that hashline.md states in its own `<critical>` — fine as cross-mode consistency, but the em-dash is a real bug.

### 18. P2: task.md/subagent.md/job.md/monitor.md boundary: job.md and subagent.md overlap on cancel/await semantics with drift risk; task.md duplicates subagent guidance inline
- Location: `packages/coding-agent/src/prompts/tools/task.md:5-11`
- Confidence: 0.85

The four background-work tools split responsibilities reasonably (task = launch, subagent = control subagents, job = generic async jobs, monitor = event streams), but the boundary docs have duplication and asymmetry:

1. task.md lines 5–11 duplicate subagent.md's await/cancel doctrine ("never cancel because an await timed out; cancel only when …unrecoverably wrong") nearly verbatim in both `ircEnabled` branches. Any future change must be made in 3+ places (task.md ×2 branches, subagent.md await + cancel sections). subagent.md:16–20 and :34–36 repeat it internally twice more. That's five statements of one rule across two files.

2. job.md never states its relationship to subagents beyond subagent.md's one-liner ("generic `job` remains available for non-subagent jobs and compatibility fallback access") — job.md itself doesn't mention that subagent-backed jobs should be controlled via `subagent`, so a model reading only job.md (e.g. when subagent tool isn't loaded) has no routing guidance, and a model with both may cancel a subagent's backing job via `job.cancel`, bypassing subagent bookkeeping.

3. monitor.md says "cancel its background task via `job`" — correct, but uses "task" for what job.md calls a "job" and task.md calls a "task" (subagent launch); three overlapping meanings of "task" across the family.

Recommend: state the cancel/await doctrine once (subagent.md), reference it from task.md; add one routing line to job.md; unify "job" vs "task" naming.

### 19. P2: write.md misuses <conditions> tag to document archive/SQLite capabilities, and `content` param for SQLite delete is undocumented behavior packed into a bullet
- Location: `packages/coding-agent/src/prompts/tools/write.md:3-9`
- Confidence: 0.85

write.md's `<conditions>` block mixes two unrelated things: genuine preconditions ("Creating new files explicitly required by task") and capability documentation ("Supports `.tar`… archive entries", "Supports SQLite row operations…"). In ask.md and skill.md, `<conditions>` means "when to use this tool" — capabilities belong in the body or `<instruction>`. Worse, the SQLite bullet compresses three distinct operations (insert via `db.sqlite:table`, update via `db.sqlite:table:key` + JSON content, delete via same path + empty content) into one line; "delete with empty content" is a surprising, destructive convention that deserves its own explicit statement. The whole file is 674 B for a tool with write/overwrite/archive/SQLite semantics — under-documented relative to its actual surface (write.ts is 954 lines and handles conflict:// URIs, hashline-prefix stripping, plan-mode enforcement — none mentioned).

### 20. P2: Tag-vocabulary fragmentation across the tree: 12+ ad-hoc section tags dilute the shared schema
- Location: `packages/coding-agent/src/prompts/tools/irc.md:1-10`
- Confidence: 0.9

The core vocabulary (`<instruction>`, `<critical>`, `<output>`, `<examples>`, `<caution>`, `<conditions>`, `<parameters>`) is reasonably consistent in ~half the files, but the tree also contains one-off tags used by exactly one file each:

- replace.md: `<bash-alternatives>`
- hashline.md: `<ops>`, `<rules>`, `<brace-shapes>`, `<common-failures>`, `<case>`, `<anti-pattern>`
- patch.md: `<avoid>` (also find.md — 2 users)
- task.md: `<rules>`, `<parallelization>`, `<context-fmt>`, `<assignment-fmt>`, `<agents>`
- web-search.md: `<xai>`
- lsp.md: `<operations>`
- bash.md: `<restricted-bash-mode>`
- irc.md: `<when_to_use>` (snake_case — the only snake_case tag in the tree), `<etiquette>`
- eval.md: `<prelude>`, `<example>` (singular; everyone else uses `<examples>`)
- image-gen.md: `<instructions>` (plural)

Some domain tags are justified (hashline's format-specific sections), but `<when_to_use>` vs `<conditions>`, `<example>` vs `<examples>`, `<avoid>` vs `<critical>`-negatives, and `<rules>` vs `<instruction>` are pure synonyms. Meanwhile several files use no tags at all (job.md, monitor.md, cron.md, subagent.md, goal.md, vim.md, computer.md, search-tool-bm25.md, render-mermaid.md use `#`/`##` markdown headers instead). Two structural dialects + synonym tags = the model can't rely on tag semantics transferring between tools. Recommend a documented canonical tag set and converting header-only files where practical.

### 21. P2: recall.md/retain.md/reflect.md ship a self-referential "compatibility-only, not part of the public tool surface" disclaimer to the model
- Location: `packages/coding-agent/src/prompts/tools/recall.md:1-2`
- Confidence: 0.85

All three Hindsight prompts open with: "Compatibility-only legacy Hindsight helper. This prompt is retained for backend/tool-call compatibility and is not part of the public gajae-code coding harness tool surface." This is maintainer metadata, not model instruction — if the tool is loaded, the model should just get usage guidance; telling it the tool is "legacy" and "not part of the public surface" invites it to avoid a tool that's actively wired up, and burns the first ~35 tokens of a 600-byte prompt on non-actionable text. If the tools truly are deprecated, gate their registration; if they're live, drop the disclaimer (keep it as an HTML comment or move it to the .ts file).

### 22. P2: skill.md leaks internal state-machine plumbing (`gjc state <skill> write --input …`, `.gjc/state/`, phase enums) into the tool description
- Location: `packages/coding-agent/src/prompts/tools/skill.md:9-12`
- Confidence: 0.8

skill.md's `<instruction>` block spends most of its budget on implementation internals: the exact `gjc state <caller> handoff --to <callee>` command run "in-process", the full `current_phase` enum `{complete, completed, handoff, failed, cancelled, canceled, inactive}` (note: contains both `cancelled`/`canceled` and `complete`/`completed` spelling duplicates — a smell in its own right), and the precise bash incantation to prepare a handoff. Some of this is genuinely actionable (the model must write `current_phase: "handoff"` before chaining), but "dispatches the callee's SKILL.md as a user-attribution custom message … (steering the stream when active, appending otherwise)" and "atomically demotes the caller and promotes the callee in `.gjc/state/`" are pure implementation narration. Trim to: what the tool does, the one precondition, the one preparation command, and the chain-step rule. The redundant sentence pair at lines 10–11 explains the handoff twice.

### 23. ?: (untitled)
- Location: `?`
- Confidence: ?



### 24. P3: subagent.md omits the `limit` parameter and uses raw `<=280-character` notation inside XML-adjacent prose
- Location: `packages/coding-agent/src/prompts/tools/subagent.md:5`
- Confidence: 0.9

Two small drift/consistency issues in subagent.md:

1. The schema (subagent.ts:32) defines `limit: z.number().min(1).max(MAX_LIST_LIMIT=50)` — "maximum subagents to return" for `list` — but the prompt never mentions it. All other schema params (`action`, `ids`, `id`, `message`, `pause`, `timeout_ms`, `verbosity`) are covered.

2. Line 5 writes `<=280-character`, `<=2000 characters`, `<=12000 characters` using a raw `<=` sequence inside prose that sits amid XML-style tags; task.md uses `≤` (`≤32 chars`, `≤3–5 explicit files`). Cosmetic, but `<=` adjacent to tag-like syntax is the kind of thing prompt renderers/escapers mangle. Prefer `≤` for consistency with the sibling files.

### 25. P2: browser.md `run` documentation is severely bloated — 20+ `tab.*` helper signatures inline; `act` verbs demoted below the JS API they're meant to replace
- Location: `packages/coding-agent/src/prompts/tools/browser.md:20-45`
- Confidence: 0.85

browser.md is the largest prompt in the tree (8.2 KB) and most of its bulk is a full API reference for the `tab` helper object (`tab.goto`, `tab.observe`, `tab.id`, `tab.click`, `tab.type`, `tab.fill`, `tab.press`, `tab.scroll`, `tab.waitFor`, `tab.drag`, `tab.scrollIntoView`, `tab.select`, `tab.uploadFile`, `tab.waitForUrl`, `tab.waitForResponse`, `tab.evaluate`, `tab.screenshot`, `tab.extract`) — each with options and return-type notes. Yet the prompt itself says `act` is "preferred for routine navigation/interaction" and "Use `run` only when a verb does not cover what you need". The information architecture is inverted: the discouraged escape hatch (`run` + full JS API) gets ~60% of the tokens while the preferred structured path (`act` verbs) is a single dense bullet. Every session with the browser tool pays this cost whether or not a browser is used. Consider: keep `act` verbs + `open`/`close` + 3–4 `tab` essentials (`observe`, `id`, `screenshot`, `extract`) inline, and move the long-tail helper reference to a lazily-readable doc (e.g. `rule://` or a docs URI the model can `read` on demand).

### 26. P2: github.md single-paragraph preamble buries the issue://‌ /pr:// redirect and repeats "replace what used to be op:…" historical notes the model doesn't need
- Location: `packages/coding-agent/src/prompts/tools/github.md:1-15`
- Confidence: 0.88

github.md's opening paragraph packs four concerns into one run-on block: tool identity, the `issue://`/`pr://` read redirect, the `pr://<N>/diff` family, and two historical notes ("they replace what used to be `op: issue_view`… `op: pr_diff`"). Models don't need migration history for ops that no longer exist in the enum (verified: gh.ts:235–246 enum has no issue_view/pr_view/pr_diff). The per-op bullets are also extremely repetitive — the sentence "Defaults `repo` to the current checkout's `owner/repo` when omitted; pass an explicit `repo:`/`org:`/`user:` qualifier in `query` to search outside it" appears verbatim four times (search_issues, search_prs, search_code, search_commits). State the default-repo rule once above the search ops and strip the "used to be" clauses. Estimated ~25% token reduction with zero information loss.

### 27. P2: vim.md `pause` parameter referenced repeatedly ("non-paused calls", "auto-save") but never introduced or documented
- Location: `packages/coding-agent/src/prompts/tools/vim.md:82-86`
- Confidence: 0.9

vim.md's opening usage block documents only `{"file": …}` and `{"file": …, "steps": […]}`. Yet the body references pause semantics three times: ":e! reloads … because non-paused calls auto-save" (line ~82), "Auto-save happens once after all steps in a non-paused call complete" (line ~86). The schema (vim.ts:47) has `pause: z.boolean().optional().describe("skip auto-save")` and the implementation branches on it extensively (`pauseLastStep`, keep-INSERT-mode-active behavior, skip auto-save at vim.ts:641). A model reading vim.md cannot discover how to make a "paused" call — the term is defined nowhere. Add `pause` to the parameter list with its two effects (skip auto-save; last step may remain in INSERT mode).

### 28. P2: todo-write.md `rm` semantics drift: doc says "Remove" uniformly, but implementation empties phases without deleting them, and bare `rm` clears all tasks — a shape the table's "Required fields" column forbids
- Location: `packages/coding-agent/src/prompts/tools/todo-write.md:14-20`
- Confidence: 0.85

Three mismatches between todo-write.md's operations table and `removeTasks` (todo-write.ts:225–242):

1. The table row for `rm` lists required fields "`task` or `phase`", but the implementation explicitly supports a bare `{"op":"rm"}` (no task/phase) that clears every task in every phase — and the examples section even shows it ("# Remove all tasks `{"ops":[{"op":"rm"}]}`"). The table and the example contradict each other.

2. `rm` with `phase` does `phase.tasks = []` — it empties the phase but keeps the (now-empty) phase entry, whereas "Remove" implies deleting the phase itself. Same for the bare form: phases survive, only tasks vanish.

3. `rm` with `task` filters that one task out — genuinely removes. So one op name has delete-entry semantics for tasks and clear-contents semantics for phases.

Fix the table (`task` or `phase` or *(none = clear all)*) and clarify that phase-scoped `rm` empties but retains the phase.

### 29. P2: web-search.md is ~60% xAI-provider-specific content shown unconditionally — 13 of 17 schema params are xAI-only with no templating gate
- Location: `packages/coding-agent/src/prompts/tools/web-search.md:8-14`
- Confidence: 0.85

web-search.md's `<xai>` block plus the xAI-only schema params (`xai_search_mode`, `allowed_domains`, `excluded_domains`, `allowed_x_handles`, `excluded_x_handles`, `from_date`, `to_date`, `enable_image_understanding`, `enable_image_search`, `enable_video_understanding`, `no_inline_citations` — verified against web/search/index.ts:25–46) dominate the prompt, yet the tool supports many providers (brave, duckduckgo, perplexity, searxng, tavily, xai per web/search/providers/). Unlike bash.md/task.md/eval.md, which use Handlebars conditionals to strip inapplicable sections, web-search.md shows the xAI block unconditionally — sessions on Brave/Tavily/Perplexity carry dead guidance and dead params. Meanwhile genuinely provider-neutral params (`recency`, `limit`, `num_search_results`, `max_tokens`, `temperature`) get zero prose. Gate the `<xai>` section on the active provider (the file already lives in a Handlebars pipeline) and add one line for the neutral params.

### 30. P3: search-tool-bm25.md structure is disordered: "Notes:" section interleaves input guidance after Behavior, first note is orphaned outside the bullet list
- Location: `packages/coding-agent/src/prompts/tools/search-tool-bm25.md:14-26`
- Confidence: 0.85

search-tool-bm25.md has an Input → Behavior → Notes → Returns flow where the "Notes:" section restates input guidance ("Start with `limit` 5–10 if unsure" — belongs under `limit`'s Input bullet) and re-documents the match-field list already given under Behavior ("Matches against tool name, label, server name, description/summary, and input schema keys" vs the Notes' expanded duplicate listing `name`/`label`/`server_name`/`mcp_tool_name`/`description`/`summary`/`schema_keys`). The same information appears twice at different granularity. Also "Start with `limit` 5–10 if unsure." sits on its own line directly under "Notes:" without a bullet, breaking list formatting. The default (`limit` 8, verified vs DEFAULT_LIMIT=8 in search-tool-bm25.ts:28 — doc is accurate) is stated in Input, so the Notes duplication can be deleted outright. Minor file, low stakes, but it's a clean example of the redundant-sections pattern.

### 31. P3: checkpoint.md/rewind.md are correctly cross-referential but tag-free and duplicate the flow description in both files
- Location: `packages/coding-agent/src/prompts/tools/rewind.md:1-14`
- Confidence: 0.8

checkpoint.md and rewind.md each restate the full lifecycle: checkpoint.md gives "Typical flow: 1. checkpoint(goal) 2. explore 3. rewind(report)" plus "You MUST call `rewind` before yielding"; rewind.md repeats "Call immediately after checkpoint-started investigative work" plus "You MUST call this before yielding if a checkpoint is active". The MUST-call-before-yield invariant is stated in both files with slightly different wording — one canonical statement (in checkpoint.md, where the obligation is created) with a one-line reference in rewind.md would remove the drift surface. Both files also use bare "Requirements:"/"Rules:"/"Behavior:" headers rather than the `<critical>`/`<instruction>`/`<output>` vocabulary used by the structured half of the tree.

### 32. P3: goal.md `pause` bullet is a 90-word run-on sentence carrying four separate rules; final three lines re-duplicate rules already in the bullets
- Location: `packages/coding-agent/src/prompts/tools/goal.md:9-22`
- Confidence: 0.85

goal.md's `pause` bullet packs: (1) what pause does, (2) the continuation-loop effect, (3) pause-vs-drop criteria with an example list ("sing, record, edit, approve"), and (4) resumability — into one unbroken sentence. Then the file's closing three lines repeat rules already stated in the op bullets: "Call `complete` only when the goal is actually done and verified" duplicates the `complete` bullet ("after you have verified every deliverable"); "Do not `pause` as a substitute for `complete`; pause only when the outstanding work is human-blocked" duplicates the pause bullet's criteria. The schema `op` describe() (goal-tool.ts:26) additionally restates the drop/pause semantics a third time in its own 50-word description. Same rule, three places, three wordings.

### 33. P3: ssh.md whitelists `cat`/`grep`/`find`/`head`/`tail` for remote hosts with no note reconciling the local coreutils bans
- Location: `packages/coding-agent/src/prompts/tools/ssh.md:7-12`
- Confidence: 0.8

ssh.md's `<commands>` reference instructs the model to build remote commands from `ls`, `cat`, `head`, `tail`, `grep`, `find` — the exact commands read.md/search.md/find.md declare FORBIDDEN "regardless of how short or convenient it looks". The bans are scoped to *local* Bash (remote hosts have no `read`/`search` equivalent), so ssh.md is functionally correct, but nothing in either file states the scoping. A model that has internalized "any `cat` call is a bug" may refuse or self-flag legitimate ssh usage; conversely a model anchored on ssh.md's table may relax the local ban. One sentence in ssh.md ("the local coreutils restrictions do not apply to remote hosts — these are the only tools available there") closes the gap.

### 34. P2: Edit-family cross-mode duplication: patch.md and apply-patch.md describe near-identical hunk formats with divergent guidance (anchor-first vs context-first) and different read-first rules
- Location: `packages/coding-agent/src/prompts/tools/apply-patch.md:60-66`
- Confidence: 0.85

patch.md and apply-patch.md are both surfaced as the `edit` tool (mode-selected via edit/index.ts) and both describe @@-anchored hunk formats, but they teach conflicting strategies for the same underlying matcher (`executePatchSingle` powers both — verified in edit/index.ts:353–412, apply_patch expands to patch entries):

- patch.md leads with anchor selection ("full function signature… unique string literal") and says context lines are the fallback ("usually 2–8").
- apply-patch.md leads with fixed 3-line context ("By default, show 3 lines… above and 3 lines below") and treats `@@ class/def` anchors as the fallback.
- patch.md `<critical>` mandates "You MUST read the target file before editing"; apply-patch.md has no read-first rule at all.
- patch.md forbids absolute constraints only implicitly; apply-patch.md adds "File references can only be relative, NEVER ABSOLUTE" — a constraint patch.md never states even though the same executor handles paths for both (and no absolute-path rejection was found in modes/apply-patch.ts).

Since only one mode is active per session this never collides at runtime, but the shared engine means guidance divergence is unforced: the anti-retry rule, read-first rule, and formatter rule from patch.md's `<critical>` all apply equally to apply_patch and are missing there. Port the `<critical>` invariants into apply-patch.md (or a shared partial) and verify/remove the NEVER-ABSOLUTE claim.
