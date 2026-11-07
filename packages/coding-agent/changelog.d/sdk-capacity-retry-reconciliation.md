### Fixed

- Settle SDK prompts after capacity retries by preserving prompt ownership across retry runs within the same lifecycle, without settling independent successor prompts from stale terminal events.
