### Fixed

- Keep a sealed run's exact resource leases live after a bounded abort wait returns `resources_pending`, so a later tracked tool settlement can clear the ledger instead of leaving a stale quarantine tombstone. `AgentSession.abortPromptAndWait` can re-read the retained proof after the cancellation domain is released, while unknown handles remain `unknown_run`. Continue to report pending work until its tracked promise settles; terminal events and abort acknowledgements do not prove physical settlement (#5401).
