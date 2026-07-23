Creates a new file at the specified path.

<conditions>
- Creating new files explicitly required by task
</conditions>

<instruction>
- Archives: write entries inside `.tar`, `.tar.gz`, `.tgz`, and `.zip` via `archive.ext:path/inside/archive`.
- SQLite rows:
  - `db.sqlite:table` with JSON content — insert a row
  - `db.sqlite:table:key` with JSON content — update the row with that primary key
  - `db.sqlite:table:key` with empty content — DELETE that row (destructive; double-check the key)
</instruction>

<critical>
- You MUST use Edit tool for modifying existing files
- Existing regular files are never overwritten by this tool
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>
