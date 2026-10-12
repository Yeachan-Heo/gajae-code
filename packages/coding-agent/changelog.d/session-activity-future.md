### Fixed

- Latest-session auto-detect skips an activity timestamp more than two minutes ahead, so a planted future `updated_at` cannot replace a real session.
