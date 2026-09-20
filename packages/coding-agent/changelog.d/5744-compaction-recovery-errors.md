### Fixed

- Auto-compaction recovery now reports missing models and credentials as failures instead of silently skipping maintenance. Recovery model-switch notices are emitted only after the candidate's credentials are validated, so credentialless candidates are not reported as used.
