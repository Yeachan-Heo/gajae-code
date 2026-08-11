---
name: gjc-sdk-operate
description: Operate trusted local GJC sessions through a reviewed direct-SDK allowlist with single-use human approval.
---

# GJC SDK approved operations

This skill is for trusted local scripts. It is a procedural safety policy, not a security boundary: a modified process that can read the endpoint token can call more of the SDK than this skill permits.

## Before every operation

1. Rediscover the exact target session and fail closed if it is missing, stale, dead, unknown, symlinked, or ambiguous.
2. Never print, persist, return, or embed endpoint credentials.
3. Validate the operation against the allowlist below. Do not expose arbitrary operation passthrough.
4. For every lifecycle operation, show the exact operation and session target to the human through the external host.
5. Obtain one explicit approval immediately before the call. Approval is single-use and becomes invalid if the operation, input, or target changes.
   The templates emit a nonce-bearing, input-bound `APPROVE <session> <operation> <digest> <nonce>` challenge and read the exact response once from the active process's standard input. Present it verbatim through the external host only after the human accepts that exact action.
6. On denial, cancellation, failed rediscovery, or changed target, send no SDK request.
7. Close the SDK client on success and failure.
8. Render only bounded, redacted error codes or generic failures; never forward raw SDK error text that may contain credentials.

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

## Allowed lifecycle operations

- `session.create`
- `session.fork`
- `session.resume`
- `session.close`

Use the existing daemon-owned SDK lifecycle surface or the pure-SDK `gjc daemon session global` command family as documented. Do not pretend lifecycle operations share the per-session endpoint or one idempotency model.

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

The templates demonstrate one inspection flow and one allowlisted per-session control flow. Keep broader lifecycle orchestration in reviewed scripts that follow the same approval and credential rules.
