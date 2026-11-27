### Fixed

- Compiled `gjc` binaries no longer hard-code `NODE_ENV=development`; release builds now skip development/test-only session snapshot freezing, context cloning, and dev diagnostics, and honor the runtime `NODE_ENV` for `.env` layer selection.
