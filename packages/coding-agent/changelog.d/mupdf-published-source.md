### Fixed

- npm-installed source commands no longer resolve MuPDF's embedded WASM through a monorepo-only path. Source installs let MuPDF load its adjacent sidecar, while compiled binaries keep the embedded asset used for PDF conversion.
