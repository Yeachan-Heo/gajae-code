### Fixed

- Coordinator MCP: a `GJC_COORDINATOR_MCP_SESSION_SWEEP_INTERVAL_MS` above `2147483647` (about 24.9 days) no longer makes the idle-session reaper sweep continuously. The interval was passed straight to `setTimeout`, which treats longer delays as 1 ms; it is now capped at the timer maximum.
