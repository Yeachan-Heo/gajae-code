### Fixed

- Track the current Claude Code release in the spoofed version constant (`2.1.273` → `2.1.278`). A stale `claude-cli/<version>` is rejected by the model with an HTTP 400, so the constant is not cosmetic. The daily spoofed-version drift guard had been red since 2026-09-16.
