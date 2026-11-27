### Added

- `AgentLoopConfig.getStepBoundaryMessages` and `Agent.setStepBoundaryMessageProvider()` deliver queued asynchronous messages into the current turn after a completed tool step. The loop polls only after steering, abort, and pause checks and only when it would call the model again anyway, so the hook never interrupts running tools, never bypasses a pause, and never adds a model call. The `Agent` skips the provider while steering admission is fenced or the run is aborted.
