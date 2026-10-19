### Fixed

- Revalidate configuration snapshots after overlapping session transitions that have started but have not committed yet, avoiding a spurious `MODEL_UNAVAILABLE` rejection.
