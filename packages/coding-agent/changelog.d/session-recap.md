### Added

- Opt-in `recap.enabled` (default off) writes a one-line AI recap after a normally completed turn, linked to its request and final-answer entries. Failures and over-limit output are dropped, never retried, clipped, or regenerated.
- The `/resume` picker shows and searches the latest recap, and exact SDK `session.list` lookups expose a read-only `savedSession.recap`. Reads never call a model or write the transcript.
