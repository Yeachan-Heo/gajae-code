### Fixed
- Register spawned Python kernels before startup callbacks and retain failed or unconfirmed cleanup resources for an explicit retry instead of losing or replacing them.
- Separate cancelled requests from shared kernel initialization while preserving captured cleanup joins and removing failed provisional acquisitions.
- Preserve direct-start recovery handles and execution/cleanup error precedence, revalidate cancelled retry acquisitions, and keep active fallback owners through failed explicit preflight.
