### Fixed

- Arrow keys on the `/model` preset list no longer stall. Each preset-row build re-merged and re-finalized the credential-scoped catalog once per role selector, and finalizing scanned every runtime and config overlay for each model to restore declared thinking. A row build now reads the scoped catalog at most once whatever the number of role overrides, and catalog finalization and session-scoped discovery merges index overlays and base models once per pass. Measured with a 232-entry `models.yml`: about 900 ms per arrow key before, about 165 ms after.
