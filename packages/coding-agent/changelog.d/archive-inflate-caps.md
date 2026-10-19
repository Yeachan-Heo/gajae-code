### Fixed

- Archive readers enforce per-entry, total member, count, and depth caps while accounting for TAR framing, bounding cumulative gzip output, streaming ZIP deflate input, and truncating long archive-controlled paths.
- Empty global PAX values clear inherited path and size overrides.
