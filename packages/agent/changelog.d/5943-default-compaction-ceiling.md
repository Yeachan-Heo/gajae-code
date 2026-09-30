### Changed

- Cap the default non-adaptive auto-compaction threshold at 300,000 tokens; explicit thresholds and adaptive compaction remain unchanged. Opt-in context promotion retains the promoted model's reserve-based headroom.
- Keep recent context strictly below the default ceiling even when the configured keep floor or token correction would otherwise reach it.
