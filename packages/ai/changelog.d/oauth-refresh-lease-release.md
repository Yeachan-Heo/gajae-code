### Fixed

- Release the cross-process OAuth refresh lease when a token refresh fails, and permanently disable credentials for unknown OAuth providers instead of retrying them on every startup.
