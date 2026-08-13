# Master mode (`gjc master`)

Master mode runs **one resident master session** that supervises other already-running resident GJC sessions through the SDK/ACP control surface. It is session supervision only.

## Launch

```sh
gjc master                    # interactive resident master session
gjc master --model opus       # all normal launch flags pass through
gjc master --continue         # resume the recorded master session for this project
```

`gjc master` is the normal interactive launch path with `--master` added; `gjc --master` is equivalent. `--master` is rejected with `--mode acp` (the session-start hook is a local-launch surface). A master session is an ordinary agent session with two additions:

1. **System-prompt section.** A dedicated `<master-mode>` block is appended to the system prompt. It states the supervision-only scope, the exact-identity/reconciliation/fail-closed invariants, and the non-goals.
2. **Session-start hook.** An internal inline extension (registered only for master sessions) injects one hidden context message at `session_start` containing:
   - the SDK supervision quick reference (the `gjc sdk session` command family and its usage rules), and
   - a bounded snapshot of the current resident-session inventory read from the authoritative SDK broker session index: one `session.list` page capped at 50 rows, credential-free v1 rows (`sessionId`, `endpointGeneration`, `hostIncarnation`, `pid`, `live`, `deleted`, `ambiguous`, `terminalUncertain`), field-sanitized and per-field length-capped before entering LLM context.

The hook never throws into startup. If the broker is unavailable, the injection fails closed: the guidelines are delivered with an explicit "inventory unavailable — do not act until `gjc sdk session list` succeeds" notice.

## Classification semantics (fail-closed)

The broker row proves **liveness and authority only** — never turn state:

- `blocked` — `ambiguous` or `terminalUncertain`: the broker cannot prove unique authority. Hands-off.
- `terminal` — explicit `deleted` tombstone only. A non-live row is **not** terminal proof: broker restarts and stale heartbeats are indistinguishable from a dead host.
- `live` — the host was reachable. Turn state (active/idle/stuck) is still unknown and must be established through per-session SDK queries (`goal.list/get`, `workflow.gates.list`, turn status).
- `unknown` — not proven live, not tombstoned. Hands-off.

## Continuation identity

Every master session is recorded in a durable per-project registry (`<agentDir>/master/sessions.json`) at creation. `gjc master --continue` resumes the recorded current master by exact session id; `gjc master --resume <id>` accepts only recorded master ids. A bare continue with no recorded master, or an id that is not a recorded master, fails closed with an error — an ordinary newest session is never converted into a master.

## How the master session supervises

The master session acts through the existing broker-bound SDK surfaces (see `docs/sdk-session-cli.md`):

- discovery/reconciliation: `gjc sdk session list`, `inspect`, `status`, `tail`;
- per-session authoritative state: `gjc sdk session raw query <id> --query goal.list/get`, `--query workflow.gates.list`;
- idle/no-goal resume: `gjc sdk session send <id> --text ... --op-ref <ref>`;
- active-turn boundaries: `turn.steer` for mid-turn correction, `turn.abort_and_prompt` only when the turn must be replaced;
- questions/gates: `ask.answer` (where the session surface installs it) and `workflow.gate_answer` with explicit answers;
- terminal retirement: `session.close` through the SDK lifecycle surface.

## Safety invariants

- **Exact identity.** Re-list immediately before any mutation and re-verify `sessionId` + `endpointGeneration`/`hostIncarnation`. Changed or missing identity means no action.
- **Reconciliation, not replay.** `clientRef`/`--op-ref` identifies one logical operation for `status`/`turn.result` reconciliation. It is not an idempotent-retry token: never reuse a ref for a different operation, and never blind-resend a prompt — reconcile first, then send a new prompt with a new ref only when the prior attempt is proven not admitted.
- **Fail closed.** `ambiguous`/`terminalUncertain`/`unknown` rows, broker errors, and unavailable per-session surfaces all mean stop and report.
- **Bounded output.** The injected inventory is one bounded page (50 rows), field-sanitized and length-capped, and credential-free.

## Non-goals

- No team mode, no delegate-team or spawned worker orchestration.
- No pane scraping or terminal/screen reading; the SDK broker index and per-session query surfaces are the only authority.
- No automatic editing of other sessions' files; supervision is limited to prompt/steer/answer/retire controls.

## Recovery behavior

- Master session restart (`gjc master --continue`) resumes the exact recorded master session and re-injects a fresh inventory at session start; nothing is cached across restarts.
- A master crash leaves supervised sessions untouched — all state lives in the broker index and the sessions themselves.
- If the broker was restarted, non-live rows classify `unknown` (hands-off) until a fresh listing proves liveness; any action rejected with `endpoint_stale`/`terminal_uncertain`/`not_found` is reported, not retried blindly.
