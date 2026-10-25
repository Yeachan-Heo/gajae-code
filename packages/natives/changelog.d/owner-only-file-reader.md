### Added

- `readOwnerOnlyFile(path, maxBytes)` reads a private regular file (`0600`, single link, owned by the effective user, no extended ACL) under a private `0700` directory on macOS and Linux with a bounded, descriptor-retaining double read. Failures return only a bounded code, never paths or partial bytes.
