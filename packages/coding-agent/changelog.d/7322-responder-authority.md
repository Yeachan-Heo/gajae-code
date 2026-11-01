### Fixed

- Snapshot portable renderer reply addresses before the final lifecycle and ownership check, so accessor-triggered disconnects or reconnects cannot consume another renderer's pending interaction.
