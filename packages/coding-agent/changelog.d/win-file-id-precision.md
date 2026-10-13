### Fixed

- File identity comparisons for user-agent and containment-root isolation now use exact bigint precision end-to-end: stat calls capture full 64-bit device and inode IDs, and comparisons are direct bigint equality without rounding. This prevents a security regression on Windows where replaced directories in the same double-rounding bucket could pass isolation checks.
