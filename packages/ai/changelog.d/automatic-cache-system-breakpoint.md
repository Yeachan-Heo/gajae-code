### Fixed

- Automatic Anthropic prompt caching now also marks the last system block, so a new session reads the shared tools + system prefix instead of re-writing it.
