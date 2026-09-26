### Added

- `gjc sdk diagnostics broker`: a read-only broker observation route that can never start, ensure, retire, restart or recover a broker. This entry ships the inert public entry, grammar and bounded observation document; the observation reader is wired in the accompanying fragment.

### Changed

- The `gjc` entry module is now inert on import: entry metadata moved to the pure `@gajae-code/utils/cli-metadata` leaf (re-exported from `dirs`), and the effectful bootstrap (startup timing, stderr drainer, malloc re-exec, managed-owner admission, public dispatch, registry) moved to `cli-ordinary` which loads lazily for every non-diagnostics command with unchanged ordering.

### Fixed

- The read-only diagnostic addon's trusted digest now travels with the addon through the release path: each build emits a provenance sidecar, consuming jobs rebuild the record from those sidecars against the version actually being shipped, and embedding plus platform-package staging refuse bytes that do not match it.
