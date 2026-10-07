### Fixed

- Canonicalize temporary fixture paths in the signed file-lock identity regression suite so Windows path aliases do not bypass the stat mocks and falsely fail dead-owner reclamation checks.
