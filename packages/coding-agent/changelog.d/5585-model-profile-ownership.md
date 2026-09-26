### Fixed

- Define model-profile ownership as a versioned compare-and-set durable baseline plus session-local `profile`, `cleared`, and `inherit` markers. Reconcile ownership across startup, resume, new, fork, clear, and switch without implicitly rewriting the durable baseline; preserve unresolved deleted-profile intent and fail closed until explicit replacement. Durable apply failures retain their committed version and surface a typed error (#5585).
