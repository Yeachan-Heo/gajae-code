### Fixed
- Cancel persisted-history startup continuation during session preparation when an abort arrives before the agent run controller exists, returning an explicit preflight cancellation instead of starting a stalled provider run.
- Fence Hindsight recall writes to the generation that launched them; a pending recall from a cancelled continuation no longer pollutes the next session's state.
