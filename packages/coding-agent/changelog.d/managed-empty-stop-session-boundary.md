### Fixed
- Preserve clean managed-session fallback admission when the SDK observes the run start, while keeping user extension execution replay-unsafe. Successful empty stops with nonzero usage no longer trigger legacy proxy-overflow retries in session-owned turns.
