### Added

- `gjc sdk session close <sessionId>` ends one live SDK session as a first-class verb instead of requiring the raw hatch (`raw global --op session.close --json-input …`). It never attaches to the session, because a Router attachment would renew the host's abandonment window it is meant to end, and `--idempotency-key` is optional: the request key defaults to one derived from the session id, so a retried close replays the same lifecycle request instead of issuing a second close against a host that may already be gone.
