### Fixed

- Slow MCP configuration cleanup no longer throws an error at session startup timeout; instead, it logs a warning and continues the cleanup in the background to preserve system state. Session startup succeeds while cleanup proceeds (#7698).
- The prompt idle retry window is now configurable via `GJC_PROMPT_IDLE_WAIT_MS` environment variable (milliseconds). Invalid or missing values default to 30 seconds. This allows longer recovery windows for slow agent runs (#7698).
