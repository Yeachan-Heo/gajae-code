### Fixed

- A prompt that reaches its SDK deadline now delivers the correlated terminal failure frame to ACP and other SDK clients instead of leaving `session/prompt` waiting behind the watchdog (issue #5583).
- A prompt whose deadline expires while its real `agent_end` is in flight now publishes exactly one correlated terminal boundary instead of two, so SDK clients no longer see a duplicate `agent_end` for a turn that reconciled to a single durable outcome.
