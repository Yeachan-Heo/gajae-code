### Fixed

- Keep stats synchronization working when historical assistant entries contain partial cost data or malformed required metadata. Preserve finite recorded costs, estimate missing costs with existing catalog pricing, and skip malformed entries without changing source transcripts.
- Preserve recorded nonzero cost components with a zero total when reopening the stats database, and allow request-detail lookup past malformed JSONL entries.
