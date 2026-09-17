### Fixed

- A prompt that reaches its SDK deadline now delivers the correlated terminal failure frame to ACP and other SDK clients instead of leaving `session/prompt` waiting behind the watchdog (issue #5583).
