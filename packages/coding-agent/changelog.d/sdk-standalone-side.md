### Added
- Expose frozen-context side conversations with bounded redacted deltas, exact cancellation and cursor recovery, retaining backend ownership through actual iterator settlement.

### Fixed
- Refresh stored credential redaction before each side question admission while retaining original and prior-turn secret protection; fail closed on snapshot failure without changing frozen provider history or adding credential lookups to reads.
