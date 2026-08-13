# Master mode (`gjc master`)

Master mode runs **one resident master session** that supervises other already-running resident GJC sessions through the SDK/ACP control surface. It is session supervision only.

## Launch

```sh
gjc master                    # interactive resident master session
gjc master --model opus       # all normal launch flags pass through
gjc master --continue         # resume the previous master session
```

`gjc master` is exactly the normal interactive launch path with `--master` added; `gjc --master` is equivalent. A master session is an ordinary agent session with two additions:

1. **System-prompt section.** A dedicated `<master-mode>` block is appended to the system prompt. It states the supervision-only scope, the exact-identity/idempotency/fail-closed invariants, and the non-goals.
2. **Session-start hook.** An internal inline extension (registered only for master sessions) injects one hidden context message at `session_start` containing:
   - the SDK supervision quick reference (the `gjc sdk session` command family and its usage rules), and
   - a bounded snapshot of the current resident-session inventory read from the authoritative SDK broker session index (credential-free v1 rows: `sessionId`, `endpointGeneration`, `hostIncarnation`, `pid`, `live`, `activity`, `ambiguous`, `terminalUncertain`), with per-row classification (`blocked` / `terminal` / `stuck` / `active` / `idle`).

The hook never throws into startup. If the broker is unavailable, the injection fails closed: the guidelines are delivered with an explicit "inventory unavailable — do not act until `gjc sdk session list` succeeds" notice.

## How the master session supervises

The master session acts through the existing broker-bound SDK surfaces (see `docs/sdk-session-cli.md`):

- discovery/reconciliation: `gjc sdk session list`, `inspect`, `status`, `tail`;
- per-session authoritative state: `gjc sdk session raw query <id> --query goal.list/get` (idle/no-goal), `--query workflow.gates.list` (pending gates);
- idle/no-goal resume: `gjc sdk session send <id> --text ... --op-ref <ref>` (fresh `turn.prompt` with an idempotent client reference);
- active-turn boundaries: `turn.steer` for mid-turn correction, `turn.abort_and_prompt` only when the turn must be replaced;
- questions/gates: `ask.answer` and `workflow.gate_answer` with explicit answers;
- terminal retirement: `session.close` through the SDK lifecycle surface.

## Safety invariants

- **Exact identity.** Mutations target `sessionId` + `endpointGeneration`/`hostIncarnation` re-verified against a fresh `session.list`. Stale or missing identity means no action.
- **Fail closed.** Rows with `ambiguous: true` or `terminalUncertain: true` are hands-off (`blocked` class); broker errors abort the action, not degrade it.
- **Idempotent controls.** One logical operation carries one `clientRef`/`--op-ref`, reused across retries so replays never duplicate a prompt or steer.
- **Bounded output.** The injected inventory is capped (`MASTER_INVENTORY_ROW_LIMIT`, 50 rows) and credential-free.

## Non-goals

- No team mode, no delegate-team or spawned worker orchestration.
- No pane scraping or terminal/screen reading; the SDK broker index and per-session query surfaces are the only authority.
- No automatic editing of other sessions' files; supervision is limited to prompt/steer/answer/retire controls.

## Recovery behavior

- Master session restart (`gjc master --continue`) re-injects a fresh inventory at session start; nothing is cached across restarts.
- A master crash leaves supervised sessions untouched — all state lives in the broker index and the sessions themselves.
- If the broker was restarted, the master re-lists before acting; any action rejected with `endpoint_stale`/`terminal_uncertain`/`not_found` is reported, not retried blindly.
