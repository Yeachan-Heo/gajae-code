### Fixed

- The stream-stall abort hint no longer suggests `PI_STREAM_IDLE_TIMEOUT_MS=300000`. Anthropic now defaults to 600000, so following the hint would have halved the idle window it claimed to widen. The suggested value is now twice the larger of the active override and the longest provider default (1200000 by default).
