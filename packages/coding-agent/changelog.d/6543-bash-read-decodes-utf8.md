### Fixed

- The Bash tool's `read` builtin now decodes valid UTF-8 as text and preserves Windows ANSI-code-page text from native pipelines instead of replacing it, so `while IFS= read -r line` loops pass non-ASCII text through intact, `read -n`/`-N` count UTF-8 characters rather than bytes, and timed-out reads retain consumed partial input (#6543).
- `mapfile` into a readonly array now fails before reading, leaving piped input for the next reader as bash does.
- Terminal-backed custom shell streams are now recognized by `read` and `mapfile`, preserving terminal mode and control-key handling.
