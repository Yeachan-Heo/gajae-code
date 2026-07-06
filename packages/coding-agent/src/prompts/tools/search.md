Searches files using powerful regex matching.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters instead of (?!…)/(?<!…)
- `paths` accepts an array of files, directories, globs, or internal URLs; when omitted, the whole working directory is searched
- `paths` is an array; do not embed commas or spaces inside a single entry. Pass `["src", "tests"]` not `["src,tests"]`.
- Cross-line patterns are detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output is anchor-prefixed: `*5th|content` (match) or ` 9x}|content` (context, leading space). The 2-char suffix is a content fingerprint. The `|` before content is a separator, not part of the file content.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- You MUST use the built-in `search` tool for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any other CLI search via Bash — even for a single match, even "just to check quickly", even piped through other commands.
- Bash `grep`/`rg` loses `.gitignore` semantics, bypasses result limits, and wastes tokens. The `search` tool is faster, structured, and already wired into the workspace — there is no scenario where Bash search is preferable.
- If you catch yourself typing `grep`, `rg`, or `| grep` in a Bash command, stop and re-issue the lookup through the `search` tool instead.
- If the search is open-ended and requires multiple rounds across subsystems, delegate a bounded fact-finding task to an appropriate canonical role agent (`planner` for sequencing/context maps or `architect` for read-only architecture assessment) instead of chaining broad `search` calls yourself.
</critical>
