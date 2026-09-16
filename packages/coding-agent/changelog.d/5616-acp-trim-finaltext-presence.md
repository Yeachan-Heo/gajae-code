### Fixed

- A first-turn startup-readiness failure whose terminal carries only whitespace as final text is now retried once instead of being surfaced as a hard failure, because whitespace carries no assistant content, matching the trimmed presence contract already applied by prompt reconciliation.
