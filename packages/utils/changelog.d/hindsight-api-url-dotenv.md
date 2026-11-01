### Fixed

- A project `.env` can no longer set `HINDSIGHT_API_URL`. A different launching-shell URL is kept when the project declaration is static, including a loopback server. A dynamic project declaration also drops that shell URL, and a spawned child does not inherit the rejected value, including Bun.spawn and Bun.spawnSync that omit env.
