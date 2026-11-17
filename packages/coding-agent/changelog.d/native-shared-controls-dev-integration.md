### Fixed

- Preserve latest shared root TUI control admission fixes alongside native owner publication: reserve shared mutation fences before asynchronous preparation, serialize same-manager owner publications, and acquire owner authority before migration transcript transactions.
- Confirm title-first bootstrap enrollment and clear its held publication debt only after exact durable proof, preventing a later prompt from appending the same enrollment record twice.

### Changed

- Validate first-write enrollment records explicitly in shared title, model and real-process migration tests while preserving original execution IDs, bytes, ancestry and per-process membership checks.
