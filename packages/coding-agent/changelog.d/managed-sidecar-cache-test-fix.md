### Fixed

- Corrected managed sidecar cache release test to match the cache directory naming scheme introduced in #7683, which changed from deterministic `s-${sessionHash}` directories to random `i-*` directories to isolate live cold sidecar owners.
