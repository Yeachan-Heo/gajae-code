### Fixed

- A persistent `monitor` whose command exits cleanly after printing at least one line reports the exit in one monitor notification ("exited (code 0)") instead of also waking the agent with a background-job completion notice, which used to arrive after the final answer and produce an extra "already handled" reply (#7993). Failures, timeouts, monitors that printed nothing, and ACP clients that defer agent-initiated turns still get the completion notice.
