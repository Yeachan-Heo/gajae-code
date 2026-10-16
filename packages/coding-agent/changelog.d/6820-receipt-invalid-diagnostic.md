### Fixed

- Report a refused replacement-cleanup receipt as `managed_replace_cleanup_receipt_invalid` in the managed-scope startup error instead of a generic `binding_invalid`, so operators are pointed at the receipt rather than a healthy binding (#6820).
