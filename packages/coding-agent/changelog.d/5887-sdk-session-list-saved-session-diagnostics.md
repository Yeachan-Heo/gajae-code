### Fixed

- SDK `session.list` retries one complete identity-bound scan after a concurrent transcript change and returns a path-free, target-correlated reason if selection still fails; exact saved-session lookups cannot be mixed with page cursors, and resolution remains fail-closed (#5887).
