### Fixed

- Preserve managed deletion's typed permission and native I/O refusal results while durably retaining exact pending cleanup evidence. An authenticated pre-existing tombstone reports idempotent deletion only after all current completion proofs succeed.
- Keep asynchronous managed namespace preparation observable to existing permission checks without running general recovery or weakening selected-root leases, canonical replacement fences, or strict owner retirement.
