---
name: gjc-sdk-operate
description: Operate trusted local GJC sessions through a reviewed broker-bound CLI allowlist with single-use human approval.
---

# GJC SDK approved operations

This skill is for trusted local scripts. Its approval challenge is a procedural safety policy, not a security boundary; SDK core retains lifecycle and attachment authority.

## Before every operation

1. Select an exact session ID through `gjc sdk session list` or a caller-provided stable ID, then fail closed when the Broker cannot prove it available.
2. Use only `gjc sdk session raw query|control|global`; never scan state roots, read endpoint credentials, or open raw per-session WebSockets.
3. Validate the operation against the allowlist below. Do not expose arbitrary operation passthrough.
4. Pass all command data as argv values, never through a shell command string.
5. For every lifecycle operation, show the exact operation and session target to the human through the external host.
6. Obtain one explicit approval immediately before the call. Approval is single-use and becomes invalid if the operation, input, or target changes.
   The templates emit a nonce-bearing, input-bound `APPROVE <session> <operation> <digest> <nonce>` challenge and read the exact response once from the active process's standard input. Present it verbatim through the external host only after the human accepts that exact action.
7. On denial, cancellation, unavailable target, or changed input, send no CLI request.
8. Render only bounded, redacted CLI JSON; discard raw CLI stderr.

## Allowed per-session controls

- `turn.prompt`
- `turn.steer`
- `turn.follow_up`
- `ask.answer`
- `workflow.gate_answer`
- `todo.replace`
- `session.switch`
- `session.rename`

For `workflow.gate_answer`, use the durable workflow gate ID and pass `expectedSessionId`. Never use transient `action_needed.id` as durable authority.

## Long-running prompts

The SDK prompt deadline is progress-aware: `sdk.promptDeadlineMs` (30 min, `60_000–86_400_000`) is an inactivity lease renewed only by attributable `tool_execution_start` / `tool_execution_end` for the exact accepted `commandId`/`turnId`, bounded by `sdk.promptMaxRuntimeMs` (6 h default, `60_000–86_400_000`, caps at 24 h). Persist `session_id` / `turn_id` from `turn.prompt` acceptance and reconcile with `turn.result` (Q26) rather than replaying blindly. Distinguish the bounded `await_turn` poll `timeout_ms` from the SDK terminal deadline; heartbeats, streaming text/thinking deltas, retries, and other-turn activity do not renew the lease.

## Allowed lifecycle operations

- `session.create`
- `session.fork`
- `session.resume`
- `session.close`

Use `gjc sdk session raw global --op <operation> --idempotency-key <key> --json-input <object>` for lifecycle operations. The Broker derives the canonical lifecycle identity; do not create a second lifecycle route or ledger.

## Explicitly excluded

- `session.delete`
- managed bash operations
- configuration mutation
- authentication mutation
- permission-mode mutation
- tool activation mutation
- extension mutation
- session cwd mutation
- endpoint credential display
- arbitrary SDK operation names

The templates demonstrate one inspection flow and one allowlisted per-session control flow. Keep broader lifecycle orchestration in reviewed scripts that use the documented lifecycle facade and stable idempotency keys.
