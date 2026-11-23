### Fixed

- SDK broker startup no longer stalls when `sdk/lifecycle-ledger.spawn-anchor-attestation.json` is a FIFO. The optional attestation is now read through a no-follow, nonblocking descriptor that must be a regular file within the lifecycle ledger byte bound; a FIFO, device, symlink, or oversized file is ignored with a warning and pre-marker spawn mirrors stay fenced (follow-up to #7253).
