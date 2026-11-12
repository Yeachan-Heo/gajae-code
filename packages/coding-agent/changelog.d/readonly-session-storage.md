### Changed

- Separate readonly session-file access from persistence, lock, repair, and deletion authority while retaining native snapshot and range-read semantics.
- Move session-record parsing into the readonly dependency lane while preserving persisted versions, lenient JSONL handling, and append-only patch normalization.
- Read saved-history metadata through the shared readonly implementation while native pickers retain recap enrichment and descriptor identity association.
