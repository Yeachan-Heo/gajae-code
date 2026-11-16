### Fixed

- Retire a cached strict-close retry error only when the exact certified retry origin has settled through a successful rewrite; retain independent persistence errors and terminal unknown-close fences.
- Keep enrollment metadata out of executable predecessor comparisons while retaining its physical sidecar accounting and original message identities during bounded session-memory reopen.
- Preserve terminal rewrite-close uncertainty and identity-bound certified cleanup retries. Best-effort close joins an already admitted strict close rather than inventing another outcome.
- Drain queued persistence before acquiring the cooperative owner publication lease, preserving owner-to-transcript lock order without self-joining a queued writer.
- Settle the exact enrollment included in a shared bootstrap receipt instead of appending its ID again on the next canonical message; preserve the published prefix and immediate parent.
- Admit an already-persisted switch successor before publishing its runtime identity, and await cooperative startup admission before synchronous model metadata writes.
