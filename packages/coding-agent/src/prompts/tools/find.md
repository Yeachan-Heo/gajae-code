Finds files using fast pattern matching that works with any codebase size.

<instruction>
- `paths` is required and accepts an array of globs, files, or directories
- Pass multiple targets as **separate array elements** (`paths: ["a", "b"]`), NEVER as a single comma-joined string (`paths: ["a,b"]` is rejected)
- `gitignore` defaults to `true` and hides files matched by `.gitignore`. Set `gitignore: false` to find `.env*`, `*.log`, freshly-created build outputs, or anything else your repo ignores
- `hidden` defaults to `true`; combine with `gitignore: false` to surface dotfiles that are also gitignored
- `timeout` is in seconds (default 5, clamped to 0.5–60). On timeout, find returns whatever partial matches it has collected with `truncated: true` and a notice — increase `timeout` or narrow the pattern instead of retrying blindly
- You SHOULD perform multiple searches in parallel when potentially useful
</instruction>

<output>
Matching file paths sorted by modification time (most recent first). Truncated at 1000 entries or 50KB (configurable via `limit`).
</output>

<examples>
# Find files
`{"paths": ["src/**/*.ts"], "limit": 1000}`
# Multiple targets — separate array elements
`{"paths": ["src/**/*.ts", "test/**/*.ts"]}`
# Find gitignored files like .env
`{"paths": [".env*"], "gitignore": false}`
# Long-running search on a slow volume
`{"paths": ["/Volumes/Storage/**/*.py"], "timeout": 30}`
</examples>

<avoid>
For open-ended searches requiring multiple rounds of globbing and searching, delegate a bounded fact-finding task to an appropriate canonical role agent (`planner` for sequencing/context maps or `architect` for read-only architecture assessment) instead.
</avoid>

<critical>
- Use separate array entries for multiple path globs.
- Set `gitignore: false` only when ignored files are intentionally in scope.
</critical>
