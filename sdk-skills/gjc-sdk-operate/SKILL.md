---
name: gjc-sdk-operate
description: Operate trusted local GJC sessions through a reviewed broker-bound CLI allowlist with single-use human approval.
---

# GJC SDK approved operations

This skill is for trusted local scripts. Its approval challenge is a procedural safety policy, not a security boundary; SDK core retains lifecycle and attachment authority.

## Before every operation

1. Select an exact session ID through `gjc sdk session list --json` or a caller-provided stable ID, then fail closed when the Broker cannot prove it available.
2. Use only `gjc sdk session raw query|control|global` for SDK operations; static help and verified root error-evidence retrieval are discovery-only exceptions. Never scan state roots, read endpoint credentials, or open raw per-session WebSockets.
3. Validate the operation against the allowlist below. Do not expose arbitrary operation passthrough.
4. Pass all command data as argv values, never through a shell command string.
5. For every lifecycle operation, show the exact operation and session target to the human through the external host.
6. Obtain one explicit approval immediately before the call. Approval is single-use and becomes invalid if the operation, input, or target changes.
   The templates emit a nonce-bearing, input-bound `APPROVE <session> <operation> <digest> <nonce>` challenge and read the exact response once from the active process's standard input. Present it verbatim through the external host only after the human accepts that exact action.
7. On denial, cancellation, unavailable target, or changed input, send no CLI request.
8. Add `--json` explicitly to every machine CLI call. Successful session JSON is unchanged; default ordinary failures are text on stderr. On failure consume the single `gjc.command-error` version 1 stdout envelope, preserve outcome certainty/references, and never publish raw stderr or interpret absent JSON as success. Usage exits 2; operation failures exit 1.

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
- `session.lookup`

Use `gjc sdk session raw global --op <operation> --idempotency-key <key> --json-input <object> --json` for lifecycle operations. The Broker derives the canonical lifecycle identity; do not create a second lifecycle route or ledger.

## Local help and uncertain outcomes

Before constructing an invocation, consult inert command-local help such as
`gjc sdk session raw control --help --json`. Select
`--help-section overview|usage|children|arguments|options|examples|recovery` and
`--help-page <N>` as needed (defaults overview/1). Follow `next.argv` with its
`--help-revision <sha256>` and `--json` unchanged; do not combine revisions.
`-h` is accepted, `--help=json` is not. Selectors require actual help, no duplicates
and positive decimal safe-integer pages. Help is static, not a target probe.

Help/errors/evidence pages are bounded to 8192 UTF-8 bytes; successful results
retain their existing contract. A post-acceptance `wait_timeout` does not undo
work. An uncertain-after-send outcome is unknown, not safe to replay. Retain all
complete operation/session/idempotency/claim/command/turn references supplied.
No hint authorizes extra probes, automatic retry/restart/kill, or repetition of
successful targets after mixed failure. Use an explicit task-appropriate status
query to reconcile before considering any new approval or replay.

For verified retained evidence only, follow the actual root-family continuation:
`gjc sdk --error-ref <id> --error-sha256 <digest> [--error-page <N>] [--error-agent-dir <dir>] --json`
(or `gjc daemon` for that original family). Placeholders are not executable.
Retrieval is exclusive with help/operations, never reruns them and never scans
other roots. Records last exactly 24 hours without sliding reads; limits are 64
committed records, 1 MiB each, 16 MiB total, plus one 1 MiB pending file and a
4096-byte lock. Help/success never initializes the store. Concatenate contiguous
base64 fragments, verify total bytes and SHA256, then decode UTF-8/JSON; never
execute partial fields or paste escaped text display literals as shell argv.

If publication fails (disk, permissions, quota or verification), the error can
be incomplete with `evidence.status: "unavailable"` and `continuation: null`.
Preserve the original certainty and warn against blind retry; do not invent a
locator, alternative store or lossless-retrieval guarantee. Even a published
record becomes unavailable after expiry or deletion.

Daemon targets are telegram/discord/slack, never SDK: do not suggest
`gjc daemon restart sdk`. Stop/restart can interrupt work and `--force` permits
SIGKILL. `session retire` is a proof-bound mutation, not a status query, and is
outside this skill's allowlist; uncertainty alone does not authorize retirement.

For a lost `session.create` response, use the read-only lookup with the same request key and create target retained before dispatch:

```sh
gjc sdk session raw global --op session.lookup \
  --idempotency-key <create-request-key> \
  --json-input '{"cwd":"/absolute/path/to/repo"}'
```

Lookup never replays creation. Treat `not_found` as an unknown outcome, not as proof that the create did not execute; `found`, `pending`, `conflict`, `uncertain`, and `terminal` remain distinct structured statuses.

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
