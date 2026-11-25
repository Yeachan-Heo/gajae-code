### Fixed

- `gjc update` now skips stable releases that don't have the binary asset for the current platform (e.g., when a release is published without all platform binaries yet), and falls back to the newest release that has the asset. Users see a clear message like "release v0.22.1 has no asset for gjc-linux-x64 yet" instead of a 404 download failure.

### Changed

- The release validation step in the GitHub Actions release workflow now outputs diagnostic information when git fetch fails, so issues with tag provenance validation are visible instead of failing silently.
