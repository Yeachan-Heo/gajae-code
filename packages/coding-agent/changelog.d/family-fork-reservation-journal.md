### Added

- Internal family-fork reservations retain original keys and child IDs through journal compaction, reject conflicting durable owners, and re-establish reservation durability after an unacknowledged write.
- Family registration shares reservation serialization and refuses to register a reserved child as an unrelated root. Live journal observation no longer requires treating its owner as interrupted; ordinary lifecycle recovery remains unchanged.
