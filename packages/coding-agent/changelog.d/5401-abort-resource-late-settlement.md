### Fixed

- Keep a sealed run's exact resource leases live after a bounded abort wait returns `resources_pending`, so a later tracked tool settlement can clear the ledger instead of leaving a stale quarantine tombstone. Continue to report pending work until its tracked promise settles; terminal events and abort acknowledgements do not prove physical settlement (#5401).
