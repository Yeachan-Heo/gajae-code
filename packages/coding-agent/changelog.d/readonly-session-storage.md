### Changed

- Separate readonly session-file access from persistence, lock, repair, and deletion authority while retaining native snapshot and range-read semantics.
- Move session-record parsing into the readonly dependency lane while preserving persisted versions, lenient JSONL handling, and append-only patch normalization.
