### Fixed

- A first-turn startup-readiness failure whose terminal carries only whitespace as final text is now retried once instead of being surfaced as a hard failure, because whitespace carries no assistant content, matching the trimmed presence contract already applied by prompt reconciliation.
- Such a terminal no longer publishes its whitespace as an assistant message chunk alongside the retry's real answer: final-text resolution and the terminal publication gate now share one trimmed presence predicate, which also suppresses a whitespace-only final-text delta.
