## SDK supervision quick reference

All supervision goes through the broker-bound `gjc sdk session` command family. It never renders endpoint credentials and it fails closed with typed errors and a non-zero exit code.

- `gjc sdk session list` — enumerate resident sessions with authoritative identity fields (`sessionId`, `endpointGeneration`, `hostIncarnation`, `pid`, `live`, `activity`, `ambiguous`, `terminalUncertain`).
- `gjc sdk session inspect <sessionId>` — one session's credential-free row.
- `gjc sdk session send <sessionId> --text "<prompt>" [--op-ref <ref>] [--wait --timeout-ms <ms>]` — submit a `turn.prompt`; always pass a deterministic `--op-ref` per logical operation so retries replay idempotently. Follow with `status` to reconcile.
- `gjc sdk session status <sessionId> <opRef>` — authoritative reconciliation of a previously submitted prompt.
- `gjc sdk session tail <sessionId>` — follow the authoritative event stream (not pane scraping).
- `gjc sdk session raw query <sessionId> --query goal.list/get` — goal state (idle/no-goal detection).
- `gjc sdk session raw query <sessionId> --query workflow.gates.list` — pending workflow gates.
- `gjc sdk session raw control <sessionId> --op turn.steer --json-input '{"text":"...","clientRef":"<ref>"}'` — steer a session mid-turn.
- `gjc sdk session raw control <sessionId> --op turn.abort_and_prompt --json-input '{"text":"...","clientRef":"<ref>"}'` — replace the active turn only when steering cannot express the correction.
- `gjc sdk session raw control <sessionId> --op ask.answer --json-input '{"id":"<askId>","answer":"..."}'` — answer a pending question.
- `gjc sdk session raw global --op session.close --idempotency-key <key> --json-input '{"sessionId":"<sessionId>"}' --confirm` — retire a terminal session.

Rules:

1. Re-run `list` before every mutating action and re-verify the exact `sessionId` + `endpointGeneration`/`hostIncarnation` pair. A stale or ambiguous endpoint means stop and report — never force the action.
2. Rows with `ambiguous: true` or `terminalUncertain: true` are hands-off: the broker cannot prove unique authority.
3. One logical operation = one `clientRef`/`--op-ref`, reused across retries; never reuse a ref for a different operation.
4. Supervision only: no team mode, no worker spawning, no pane scraping, no editing another session's files.
