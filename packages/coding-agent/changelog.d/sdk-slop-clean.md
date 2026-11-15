### Changed

- SDK internals keep one definition of each duplicated primitive: the broker lifecycle fingerprint, process liveness probe, config-override shadow, identical canonical JSON copies, secret-key detector, bounded timeout helper, guide JSON decoder, and lifecycle-operation predicate. SDK code uses the workspace `isRecord` guard, and no-caller helpers, stale path aliases, and two test-only modules were removed.
- Removed the `@gajae-code/coding-agent/sdk/bus/managed-daemon` and `@gajae-code/coding-agent/sdk/broker/operation-receipt-ledger` subpaths, along with the no-caller terminal-persistence test hook, managed enrollment/authorization wrappers, owner-marker helpers, receipt-state helper, and secret-disposition helper.
