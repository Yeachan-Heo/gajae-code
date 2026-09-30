### Fixed

- Fixed flaky thread count assertion in walker pool unavailability test by moving the before-measurement snapshot to immediately before the glob operation, minimizing the time window for unrelated Bun/Tokio background workers to spawn and ensuring the measurement reflects only thread changes caused by the glob itself.
