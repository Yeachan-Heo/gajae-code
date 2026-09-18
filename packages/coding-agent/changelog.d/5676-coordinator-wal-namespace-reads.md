### Fixed

- Coordinator namespace reads no longer fail with `Coordinator service is unavailable.` when a single session's WAL record is unreadable. Retention no longer compacts away the prompt request that proves an active turn's runtime receipt, legacy `report-<uuid>` ids are migrated onto the canonical digest form instead of being rejected forever, and one `state_corrupt` session is now skipped with a `Coordinator projection recovery skipped session` warning rather than aborting the whole sweep.
