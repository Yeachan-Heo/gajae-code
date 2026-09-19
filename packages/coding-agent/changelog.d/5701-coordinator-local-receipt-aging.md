### Fixed

- Coordinator compaction now ages answered question receipts from a coordinator-local persistence timestamp instead of the remote-supplied `resolved_at`, so a stale or hostile remote value can no longer retire a freshly completed answer receipt. The remote value is still preserved in the safe receipt and API response metadata (#5701).
