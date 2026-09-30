### Fixed

- A session sharing its managed scope with another `gjc` process (for example a master session and the SDK session it spawned) no longer stops persisting with `managed_replace_receipt_cleanup_pending:quarantine_collision` when both processes try to retire the same replacement cleanup receipt at the same time. The process that loses the race to claim the retirement slot now leaves the receipt for a later reconciliation, and its own session write continues.
