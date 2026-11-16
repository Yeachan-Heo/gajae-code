### Fixed

- DeepSeek DSML tool-call markup recovery now properly reconciles recovered calls with structured calls across the entire response stream to prevent duplicate dispatch of non-idempotent operations when DSML markup appears in multiple deltas.
- Tool invocations with unclosed parameters are now rejected instead of executed, preventing malformed calls from reaching the agent loop.
