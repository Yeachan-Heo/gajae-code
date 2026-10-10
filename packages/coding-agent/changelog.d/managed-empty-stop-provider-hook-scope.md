### Fixed

- Keep bundled Grok Build request hooks scoped to their provider so unrelated SDK sessions retain replay-safe empty-response fallback. Cover the production SDK observer, accepted-only lifecycle, managed transcript persistence, and billed empty stops without changing deadline reconciliation or admitting rejected attempts.
