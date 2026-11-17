### Fixed

- Releasing an embedded session's resources after its own writer actually closed now retires that process's cooperative owner membership, so a later `deleteEmbeddedSession` is no longer refused with `owned_by_other` by the embedder's own disposed session. Exclusive native members still retire only through their reconciled lifecycle.
