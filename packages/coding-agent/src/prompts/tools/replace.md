Performs string replacements in files with fuzzy whitespace matching.

<instruction>
- Params MUST be `{ path, edits }`; `path` is required at the top level and applies to every replacement
- You MUST use the smallest `old_text` that uniquely identifies the change
- If `old_text` is not unique, you MUST expand it with more context or use `all: true` to replace all occurrences
- You SHOULD prefer editing existing files over creating new ones
</instruction>

<output>
Returns success/failure status. On success, file modified in place with replacement applied. On failure (e.g., `old_text` not found or matches multiple locations without `all: true`), returns error describing issue.
</output>

<critical>
- You MUST read the file at least once in the conversation before editing.
- Use Replace when the _content itself_ identifies the location. For position-addressed changes (append, insert at line N, delete a line range), use the `write` or line-anchored edit tools — NEVER `cat`/`sed` pipelines.
</critical>
