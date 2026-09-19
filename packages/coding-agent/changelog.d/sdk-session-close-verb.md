### Added

- `gjc sdk session close <sessionId>` ends one live SDK session as a first-class verb instead of requiring the raw hatch (`raw global --op session.close --json-input …`). It never attaches to the session, because a Router attachment would renew the host's abandonment window it is meant to end. `--idempotency-key` is optional: the default request key includes the session id and current endpoint generation/incarnation, so retries for one live host replay while a resumed host receives a fresh close identity.
