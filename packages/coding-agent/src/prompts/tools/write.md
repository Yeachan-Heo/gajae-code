Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
</conditions>

<instruction>
- Archives: write entries inside `.tar`, `.tar.gz`, `.tgz`, and `.zip` via `archive.ext:path/inside/archive`.
- SQLite rows:
  - `db.sqlite:table` with JSON content — insert a row
  - `db.sqlite:table:key` with JSON content — update the row with that primary key
  - `db.sqlite:table:key` with empty content — DELETE that row (destructive; double-check the key)
</instruction>

<critical>
- You SHOULD use Edit tool for modifying existing files (more precise, preserves formatting)
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>
