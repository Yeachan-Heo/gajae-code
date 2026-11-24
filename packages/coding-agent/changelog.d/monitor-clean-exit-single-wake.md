### Fixed

- A persistent `monitor` whose command exits cleanly after printing at least one line no longer wakes the agent a second time with a background-job completion notice for the same exit, which used to arrive after the final answer and produce an extra "already handled" reply (#7993). Failures, timeouts, monitors that printed nothing, and ACP clients that defer agent-initiated turns still get the completion notice.
