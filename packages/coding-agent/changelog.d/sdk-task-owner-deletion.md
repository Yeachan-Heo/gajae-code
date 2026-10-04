### Fixed

- SDK saved-session deletion now durably prepares managed task-artifact owner evidence before native effects, validates owner cleanup on replay against the current managed scope, and keeps scrubbed-but-retained owner namespaces pending without treating DTO completion as physical proof.
