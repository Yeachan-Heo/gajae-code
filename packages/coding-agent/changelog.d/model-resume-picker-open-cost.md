### Fixed

- `/model` opens about twice as fast on large catalogs: profile-activation availability now resolves each provider's discovery-evidence freshness (which scans the catalog for the provider base URL) once per provider instead of once per model, which made each open quadratic in catalog size (4,822 models: 2.0–2.5s → about 1.0s per open).
- `/resume` no longer SHA-256-hashes every (legacy, v2) transcript pair while deciding which legacy sessions are already migrated; a receipt is rejected on its recorded source/destination paths and source digest before any transcript is read (589 sessions: 10.4–12.3s → 6.2–7.2s per open).
