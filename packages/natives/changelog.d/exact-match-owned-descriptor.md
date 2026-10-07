### Changed
- Hash the file descriptor already exclusively owned by exact regular-file matching rather than duplicating it, preserving no-follow, byte, identity and post-hash pathname validation with deterministic descriptor cleanup.
