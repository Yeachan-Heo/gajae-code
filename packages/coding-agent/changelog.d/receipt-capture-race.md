### Fixed

- Concurrent cleanup of identity-bound replacement receipts no longer permanently blocks unrelated session appends. Transcript and unsafe-path identity checks remain enforced. Fatal receipt-capture diagnostics now distinguish descriptor admission from later pathname observations without logging file contents.
