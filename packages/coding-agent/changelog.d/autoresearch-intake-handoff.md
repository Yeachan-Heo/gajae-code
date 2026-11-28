### Added

- Autoresearch asks only when a live answer channel is available, pauses its matching goal for the post-verdict handoff, records non-interactive assumptions, and advertises `--assumption` only on supported intake/write commands.
- Conclusive autoresearch artifacts retire after a successful canonical handoff, without masking an already-dispatched handoff if cleanup fails.
- Same-mission autoresearch rewrites retain critic and verdict identity; passive workflow-gate observers no longer qualify as answer channels.
- Autoresearch handoffs bind Ralplan to plan-only or explicit-approval admission, overriding automatic execution handoff for that run.
- Clearing a bounded Ralplan run expires its execution boundary so a later seed starts a fresh run.
