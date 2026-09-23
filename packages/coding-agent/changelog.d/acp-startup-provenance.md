### Fixed

- ACP startup capability-query failures now report only a bounded safe category from known failure codes, or a fixed generic label, instead of exposing host-supplied error details. A host that does not answer the query remains distinct from a live outdated host, which still receives guidance to stop and reopen the session.
