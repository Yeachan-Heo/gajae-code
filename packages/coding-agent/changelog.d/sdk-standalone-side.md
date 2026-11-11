### Added
- Expose frozen-context side conversations with bounded redacted deltas, exact cancellation and cursor recovery, retaining backend ownership through actual iterator settlement.

### Fixed
- Refresh stored credential redaction before each side question admission while retaining original and prior-turn secret protection; fail closed on snapshot failure without changing frozen provider history or adding credential lookups to reads.
- Bind the actual native-resolved side provider key and structured token before provider admission, protecting OAuth-refreshed and non-stored derived credentials in public replies and split streams without extra credential resolution; retain cancellation and real preflight settlement ownership.
