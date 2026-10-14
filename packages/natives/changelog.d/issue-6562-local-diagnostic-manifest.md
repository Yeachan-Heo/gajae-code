### Fixed

- Keep local native builds from rewriting the checked-in diagnostic artifact manifest; CI and distribution builds continue updating the trusted record. Local-only embedding verifies the ignored digest without requiring a fresh release manifest, omits stale unused local variants, and keeps mixed/release builds strict. Compiled binaries carry the verified digest and refresh same-sized stale addon caches on rebuild.
