## SDK supervision quick reference

All supervision goes through the broker-bound `gjc sdk session` command family. It never renders endpoint credentials and it fails closed with typed errors and a non-zero exit code.

- `gjc sdk session list` — enumerate resident sessions with authoritative identity fields (`sessionId`, `endpointGeneration`, `hostIncarnation`, `pid`, `live`, `deleted`, `ambiguous`, `terminalUncertain`).
- `gjc sdk session inspect <sessionId>` — one session's credential-free row.
- `gjc sdk session send <sessionId> --text "<prompt>" --op-ref <ref> [--wait --timeout-ms <ms>]` — submit a `turn.prompt`. Use one fresh ULID-style ref per logical operation; the ref is your reconciliation handle, NOT an idempotent-retry token.
- `gjc sdk session status <sessionId> <opRef>` — authoritative reconciliation of a previously submitted prompt. Always reconcile before deciding whether to re-prompt; if reconciliation is inconclusive, treat the operation as possibly admitted and DO NOT resend.
- `gjc sdk session tail <sessionId>` — follow the authoritative event stream (not pane scraping).
- `gjc sdk session raw query <sessionId> --query goal.list/get` — goal state (idle/no-goal detection).
- `gjc sdk session raw query <sessionId> --query workflow.gates.list` — pending workflow gates.
- `gjc sdk session raw control <sessionId> --op turn.steer --json-input '{"text":"..."}'` — steer a session mid-turn.
- `gjc sdk session raw control <sessionId> --op turn.abort_and_prompt --json-input '{"text":"..."}'` — replace the active turn only when steering cannot express the correction.
- `gjc sdk session raw control <sessionId> --op ask.answer --json-input '{"id":"<askId>","answer":"..."}'` — answer a pending question. Not installed on every session surface; an `unavailable` error means report, not retry.
- `gjc sdk session raw global --op session.close --idempotency-key <key> --json-input '{"sessionId":"<sessionId>"}' --confirm` — retire a session carrying an explicit terminal tombstone.

Rules:

1. Re-run `list` immediately before every mutating action and re-verify the exact `sessionId` + `endpointGeneration`/`hostIncarnation` pair. Changed or missing identity means stop and report — never force the action.
2. Rows with `ambiguous: true` or `terminalUncertain: true` are hands-off: the broker cannot prove unique authority. Rows that are not live but not tombstoned are `unknown` — also hands-off.
3. One logical operation = one fresh `clientRef`/`--op-ref`, then reconcile via `status`. Never reuse a ref across different operations and never blind-resend.
4. Supervision only: no team mode, no worker spawning, no pane scraping, no editing another session's files.
