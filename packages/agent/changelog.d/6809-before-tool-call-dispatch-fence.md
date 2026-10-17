### Added

- `AgentTool` accepts optional `matcherDigest` and `matcherEntries` hooks that project the source a call introduces (combined, or per file) for pre-execution stream matchers such as TTSR `astCondition` rules.

### Fixed

- A tool call whose run is cancelled while an asynchronous `beforeToolCall` hook is pending no longer dispatches after the hook settles; non-abortable tools previously still executed after the aborted result was emitted.
