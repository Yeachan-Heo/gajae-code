### Fixed
- Cancel persisted-history startup continuation during session preparation when an abort arrives before the agent run controller exists, returning an explicit preflight cancellation instead of starting a stalled provider run.
