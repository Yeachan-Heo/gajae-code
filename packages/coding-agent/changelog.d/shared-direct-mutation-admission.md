### Fixed

- Reject unsupported title, star, payload, eviction, replay-metadata and summary mutations before staging changes when shared-publication admission is already active. Recheck queued metadata publication before writes, while allowing no-op sanitation, local cursor navigation and clean close. Lifecycle and caller-side admission remain separate work.
