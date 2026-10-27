### Fixed

- SDK broker spawn-claim mirror rows in the lifecycle ledger now carry `spawnAnchor: true`, so a mirror no longer turns into a fenced legacy row once its claim leaves the spawn-authority journal and stops blocking `session.create` and `session.close` with `legacy_lifecycle_ambiguous`. Mirrors written by older brokers stay fenced because nothing durable proves their origin; an operator can release them through `sdk/lifecycle-ledger.spawn-anchor-attestation.json` (see `docs/sdk-session-cli.md`). Genuine pre-index legacy rows stay fenced (#7143).
