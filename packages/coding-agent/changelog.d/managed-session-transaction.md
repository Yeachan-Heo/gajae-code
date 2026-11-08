### Changed

- Internal groundwork, not yet wired: a new managed session transaction primitive serializes one persistence step per logical session across processes, keyed to the session identity rather than the transcript path. No user-visible behavior changes until the slices that give it a caller land. `acquireManagedLock` also accepts an explicit wait budget instead of always inheriting the shared managed-lock timeout.
