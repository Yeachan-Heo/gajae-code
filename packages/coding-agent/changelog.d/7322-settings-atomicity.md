### Fixed

- Report path revisions for in-memory atomic receipts and determine routing durability from the actual Settings storage capability, not a receipt-shape heuristic.
- Preserve a retained successful receipt's ownership when two or more speculative successor batches fail, without weakening same-value/ABA checks or runtime-intent invalidation.
- Cover lock-only builders that complete an external action while a newer local setter rejects nonempty writes.
