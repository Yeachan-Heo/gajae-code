### Fixed

- Memory-backed session appends publish only the writer-owned visible prefix, avoiding whole-transcript copies on each write while preserving immediate visibility and isolated reads.
